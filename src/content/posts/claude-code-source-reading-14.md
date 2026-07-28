---
title: "Claude Code源码解读14：PowerShell 脚本为什么到执行阶段才暴露错误"
published: 2026-07-24T16:47:01+08:00
updated: 2026-07-28T17:05:00+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-14/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：从当前版本看来，为什么很多 PowerShell 脚本要到执行时才报错？

先给结论：PowerShell 的“能被解析”和“能在当前主机上成功执行”是两件事。2.1.88 里的安全链会先用 PowerShell 自己的 AST 做语法与危险结构分析，再做权限判断；这一步的目标是判断“是否应该允许尝试”，不是提前运行脚本验证所有命令、模块、路径、数据和外部程序。真正执行时，PowerShell 才会解析命令名、绑定参数、加载模块、读取环境和文件，并产生 stdout、stderr 与退出码，所以很多错误只能在这个阶段出现。

这不是安全校验失效，而是静态检查与运行时解释之间的边界。静态检查必须避免执行未知副作用；运行时又必须面对当前机器的 PowerShell 版本、PATH、模块、执行策略、工作目录、权限和数据状态。只要其中一项依赖当前环境，解析通过也不能推出执行成功。

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的代码为边界。还原路径只用于定位证据，不代表 Anthropic 内部仓库的原始目录。下面的源码片段会省略与论证无关的参数和分支，并明确标出合并后的示意代码。

## 本章先建立三个概念

- **解析时**：PowerShell 把文本变成 AST，发现语法不成立、命令结构或危险模式不可接受时，可以在执行前结束。

- **权限时**：Claude Code 决定这次工具调用是否 `allow`、`ask` 或 `deny`。它保护的是执行入口，不负责证明脚本在每台机器上都能跑通。

- **执行时**：新的 PowerShell 进程在真实环境中解析命令、查找模块和外部程序、访问文件与网络，并把错误映射成工具结果。

![PowerShell 执行阶段错误的边界](/images/posts/claude-code-source-reading-14/14-powershell-execution-errors-handdrawn.png)

图里的关键分叉是：静态校验通过以后，运行时环境仍然决定成功或失败。后文的每个原因都可以放回这条链定位。

## PowerShellTool 先校验什么，故意不校验什么

`restored-src/src/tools/PowerShellTool/PowerShellTool.tsx` 中的 `PowerShellTool` 把校验、权限与执行拆成不同回调。下面是合并后的控制骨架，不是可直接复制的完整源码：

```ts
async validateInput(input) {
  if (isWindowsSandboxPolicyViolation()) {
    return { result: false, errorCode: 11 }
  }
  // 还有后台阻塞检测等输入级检查
  return { result: true }
}

async checkPermissions(input, context) {
  return await powershellToolHasPermission(input, context)
}

async call(input, toolUseContext) {
  const result = await runPowerShellCommand({ input, ...toolUseContext })
  const interpretation = interpretCommandResult(
    input.command,
    result.code,
    result.stdout,
    result.stderr,
  )
  if (result.preSpawnError) throw new Error(result.preSpawnError)
  if (interpretation.isError) {
    throw new ShellError(result.stdout, result.stderr, result.code)
  }
}
```

`validateInput` 的源码可确认取值只有成功的 `{ result: true }`，或带错误消息和 `errorCode` 的失败对象；它主要拦截原生 Windows 沙箱策略冲突，以及启用 `MONITOR_TOOL` 时不合适的前台 sleep。它不会在这里执行脚本，也不会验证脚本依赖的每个模块和文件。

真正的安全分析由 `checkPermissions()` 转到 `powershellToolHasPermission()`。这也是为什么“权限允许”只表示可以进入执行阶段：`call()` 仍然要启动 PowerShell，解释命令并处理进程结果。

## 解析器能提前发现什么

`restored-src/src/utils/powershell/parser.ts` 的 `parsePowerShellCommand()` 会查找 `pwsh` 或 `powershell`，再启动一个独立的 PowerShell 进程，以 `-NoProfile -NonInteractive -EncodedCommand` 运行内嵌解析脚本。解析脚本调用 PowerShell 原生 AST，返回 `valid`、语句、命令名、参数、重定向以及安全相关标记。

源码还给这条解析路径设置了可见的失败值：

- 命令 UTF-8 字节数超过 `MAX_COMMAND_LENGTH`，返回 `CommandTooLong`；
- 找不到 PowerShell，返回 `NoPowerShell`；
- 解析进程启动失败、超时、退出码非零、stdout 为空或 JSON 无法解析，分别返回对应的 `PwshSpawnError`、`PwshTimeout`、`PwshError`、`EmptyOutput`、`InvalidJson`；
- 解析失败通常不建议把这条命令永久写进权限规则，而是生成 `behavior: 'ask'`，保留显式 deny 规则的优先级。

这一步可以回答“文本是否能被当前解析器理解”，也可以让 `powershellCommandIsSafe()` 检查 `Invoke-Expression`、嵌套 PowerShell、下载执行链、危险 script block、provider 路径和重定向等结构。但 AST 看不到运行时才会出现的事实，例如某个模块是否安装、某个 exe 是否在 PATH、当前文件是否存在、API 是否返回预期对象。

微软文档也把 PowerShell 的命令解析和参数模式分开描述：遇到命令调用后，后续参数会按 argument mode 解释，带空格的路径和传给原生程序的引号还会经历额外规则。解析通过不等于这些参数在目标程序中具有预期含义。[about_Parsing](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing) 与 [about_Quoting_Rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules) 都强调了这一层差异。

## 为什么错误会延迟到执行时

### 1. 主机版本不同，语法和命令能力不同

`powershellDetection.ts` 优先查找 `pwsh`，找不到时回退到 `powershell`。它还把 `pwsh` 识别为 `core`，把 `powershell.exe` 识别为 `desktop`，供提示词给出版本相关的语法建议。源码明确指出：PowerShell 7+ 支持 `&&`、`||`、`??` 等能力，而 Windows PowerShell 5.1 不支持其中一部分。

因此，同一段脚本可能在 PowerShell 7 里解析并执行，在 5.1 里直接出现语法错误；或者两者都能解析，但某个 cmdlet、参数集或默认行为不同。解决时先确认：

```powershell
$PSVersionTable.PSVersion
$PSVersionTable.PSEdition
```

不要把 `pwsh` 和 `powershell.exe` 当作同一个运行时。需要跨版本时，使用兼容语法，或在脚本入口明确检查版本并给出可读错误。

### 2. `-NoProfile` 让“交互终端里能跑”的脚本失去隐含依赖

PowerShell provider 的非沙箱路径通过 `buildPowerShellArgs()` 传入：

```ts
['-NoProfile', '-NonInteractive', '-Command', cmd]
```

`-NoProfile` 不加载用户和主机 profile，`-NonInteractive` 禁止依赖输入的交互行为。脚本如果依赖 profile 中导入的模块、函数、别名或 PATH 修改，在普通终端里可能成功，在 Claude Code 的工具进程中却会报“命令找不到”。调用 `Read-Host`、确认提示或需要交互凭据的模块，也可能在非交互模式下直接失败。

解决方法是把依赖写进脚本：显式 `Import-Module`，显式设置所需变量，避免依赖 profile；需要人输入的流程改成参数化或在工具外完成认证。

### 3. PATH、模块和外部程序都是运行时状态

AST 能看到 `Get-Thing` 或 `git` 这样的名字，却不能保证当前进程能解析它。命令优先级还会受到函数、别名、模块和 PATH 的影响；PowerShell 官方的 [about_Command_Precedence](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_command_precedence) 明确说明了同名命令可能被隐藏或替换。

先在同一个工具环境里检查：

```powershell
Get-Command git, pwsh, powershell -All -ErrorAction SilentlyContinue
Get-Module -ListAvailable
$env:PATH -split [IO.Path]::PathSeparator
```

如果依赖模块，使用 `Import-Module Name -ErrorAction Stop`，并在失败时输出模块名称和版本。需要外部 exe 时，优先使用已确认的绝对路径，或者先用 `Get-Command` 检查来源，而不是假定用户的交互 PATH 会被工具进程继承。

### 4. 脚本文件的执行策略到运行时才真正生效

`powershellToolHasPermission()` 的 AST 解析可以验证 `& .\build.ps1` 的结构，但不会替你执行该脚本。Windows 上，脚本文件能否加载还受到有效 Execution Policy、Group Policy 和文件的 Internet Zone 标记影响。

先检查策略来源：

```powershell
Get-ExecutionPolicy -List
Get-Item .\build.ps1 -Stream Zone.Identifier -ErrorAction SilentlyContinue
```

微软文档说明，Execution Policy 是控制脚本加载条件的安全功能，而不是完整的安全边界；策略按 `MachinePolicy`、`UserPolicy`、`Process`、`LocalMachine`、`CurrentUser` 等范围产生优先级。可信的下载脚本可以经过审查后使用 `Unblock-File`，企业环境则应遵守签名和组策略；不要为了让一次调用通过而盲目修改全局策略。[about_Execution_Policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)

这也解释了一个常见错觉：把脚本内容直接粘到交互终端，和用 `& .\script.ps1` 加载文件，不经过完全相同的策略路径。前者能跑，不代表后者一定能跑。

### 5. 相对路径和引号要到真实 cwd 才能验证

脚本里的 `.\config.json`、`.\tools\x.exe`、带空格的 `C:\Program Files\...`，都依赖执行时的当前目录和参数解析。Claude Code 还会在 provider 中追加 cwd 跟踪代码，并在沙箱路径通过 POSIX shell 包装 PowerShell；如果命令包含复杂引号，包装层、PowerShell tokenizer 和外部程序的 argv 规则会叠加。

2.1.88 在沙箱路径使用 UTF-16LE Base64 的 `-EncodedCommand`，正是为了避免额外 shell quoting 把 `$`、`!` 或引号改写。这个修复解决的是“命令如何安全抵达 PowerShell”，不是“命令引用的文件一定存在”。

更稳妥的写法是：

```powershell
$config = Join-Path $PSScriptRoot 'config.json'
$tool = Join-Path $PSScriptRoot 'tools\x.exe'
& $tool '--input' $config
```

脚本内部用 `$PSScriptRoot` 计算自身路径；外部输入的路径则用引号和参数数组传入，避免把空格误当成参数分隔符。

### 6. 外部程序的 stderr、`$?` 和退出码不是同一件事

PowerShell cmdlet 的错误流、原生 exe 的 stderr 和进程退出码有不同语义。PowerShell provider 追加 cwd 跟踪时，专门保存了 `$LASTEXITCODE`：

```powershell
$_ec = if ($null -ne $LASTEXITCODE) {
  $LASTEXITCODE
} elseif ($?) {
  0
} else {
  1
}
exit $_ec
```

源码注释解释了原因：Windows PowerShell 5.1 中，原生程序把 stderr 通过 `2>&1` 合并到 PowerShell 流时，`$?` 可能变成 `$false`，即使原生 exe 的退出码是 0；只看 `$?` 会制造假失败。反过来，后续 cmdlet 也可能覆盖前一个原生程序的状态。官方文档分别解释了 `$?`、`$LASTEXITCODE` 与脚本调用方式的关系。[about_Automatic_Variables](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_automatic_variables)

所以“stderr 有内容”不等于“进程失败”，“退出码非零”也要结合命令语义判断。Claude Code 的 `interpretCommandResult()` 会把结果解释后再决定是否抛出 `ShellError`，而不是只看一项字段。

### 7. 非终止错误可能让脚本继续，最终才暴露错误状态

PowerShell 有非终止错误、语句终止错误和脚本终止错误。默认情况下，某些 cmdlet 产生错误后仍会继续执行后续语句；如果脚本没有检查 `$?`、`$Error` 或 `$LASTEXITCODE`，工具可能只在最后拿到一个模糊的结果。

微软文档建议在需要失败即停的边界使用 `-ErrorAction Stop` 或设置 `$ErrorActionPreference = 'Stop'`，再用 `try/catch/finally` 处理。可操作的入口是：

```powershell
$ErrorActionPreference = 'Stop'
try {
  Import-Module My.Module -ErrorAction Stop
  & $tool @args
  if ($LASTEXITCODE -ne 0) {
    throw "external tool failed with exit code $LASTEXITCODE"
  }
}
catch {
  Write-Error ("{0}: {1}" -f $_.InvocationInfo.PositionMessage, $_.Exception.Message)
  exit 1
}
```

这样错误会在真正的失败点携带位置、异常和退出码，而不是等到工具层只看到一段 stderr。[about_Error_Handling](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_error_handling) 与 [about_Try_Catch_Finally](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_try_catch_finally) 对这两类错误的区别有明确说明。

## 当前版本里，错误具体在哪个边界出现

把现象按调用链归类，会比笼统地说“PowerShell 不稳定”更准确：

| 边界 | 典型症状 | 2.1.88 的处理 |
| --- | --- | --- |
| AST 解析 | 语法错误、解析器超时、找不到 pwsh | `parsePowerShellCommand()` 返回无效结果；权限层通常转成 `ask`，显式危险规则仍可 `deny` |
| 输入校验 | 原生 Windows 沙箱策略冲突、被拦截的前台 sleep | `validateInput()` 返回失败，不进入 `call()` |
| 权限分析 | `Invoke-Expression`、下载执行、危险 script block、非文件 provider | `powershellToolHasPermission()` 收集 `ask/deny/allow`，按 deny > ask > allow 收敛 |
| 进程启动 | PowerShell 不存在、cwd 已删除、spawn 失败 | `runPowerShellCommand()` 产生 `preSpawnError`，`call()` 抛出错误 |
| 脚本运行 | 模块、路径、执行策略、参数绑定、网络和数据错误 | PowerShell 写入 stderr 或返回退出码，由结果解释器决定是否 `ShellError` |
| 结果映射 | 超时、取消、后台化、大输出 | 工具分别映射 interrupted、后台任务、持久化输出或截断结果 |

因此，问题的准确答案是：很多脚本不是“执行时才开始解析”，而是“静态安全解析结束后，运行时语义才第一次接触真实环境”。解析阶段无法安全替代执行阶段。

## 一套可复用的排查顺序

遇到“同样脚本在终端成功、在 Claude Code 失败”，建议按以下顺序缩小范围：

1. **确认主机**：记录 `$PSVersionTable`、`$PWD`、`$env:PATH`，确认到底是 `pwsh` 还是 `powershell.exe`。
2. **确认命令来源**：用 `Get-Command <name> -All`、`Get-Module -ListAvailable`，不要假定 profile 会自动加载。
3. **确认策略**：用 `Get-ExecutionPolicy -List` 和 `Get-Item <script> -Stream Zone.Identifier`，按组织策略选择签名、解除阻止或进程级方案。
4. **确认路径与参数**：使用 `$PSScriptRoot`、`Join-Path`、绝对路径和参数数组；避免依赖启动 cwd 和复杂嵌套引号。
5. **确认错误语义**：对 cmdlet 使用 `-ErrorAction Stop`，对外部程序检查 `$LASTEXITCODE`，在 `catch` 中输出位置与异常。
6. **最后再看沙箱**：如果错误只在启用 sandbox 时出现，再比较临时目录、网络、文件系统和可执行文件访问边界；不要把所有运行时错误都归因于权限。

## 小结

PowerShell 脚本在执行阶段报错，通常是因为脚本的成功条件包含静态文本之外的状态：版本、模块、PATH、执行策略、cwd、参数边界、外部程序返回值和数据。Claude Code 2.1.88 的设计把这些问题拆在不同层处理：解析器负责 AST 与安全标记，权限函数负责 allow/ask/deny，provider 负责启动参数和沙箱包装，`PowerShellTool.call()` 负责真实进程、退出码、stderr、超时和结果映射。

理解这条边界后，修复策略也会变得具体：先记录同一运行环境，再显式声明依赖，最后把非终止错误和外部退出码转换成可定位的失败。不要用一次全局放宽执行策略，去掩盖版本、路径或脚本本身的问题。

## 留给下一篇的问题

当 Agent 不知道目标在哪里时，Glob、Grep、Read、WebSearch 与 WebFetch 等检索工具如何分层搜索并裁剪结果？

## 参考资料

- [PowerShell about_Parsing](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing)

- [PowerShell about_Quoting_Rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules)

- [PowerShell about_Execution_Policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)

- [PowerShell about_Command_Precedence](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_command_precedence)

- [PowerShell about_Automatic_Variables](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_automatic_variables)

- [PowerShell about_Error_Handling](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_error_handling)

- [PowerShell about_Try_Catch_Finally](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_try_catch_finally)
