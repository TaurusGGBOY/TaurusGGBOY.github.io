---
title: "Claude Code源码解读13：如何建立命令执行安全边界"
published: 2026-07-24T16:47:00+08:00
updated: 2026-07-24T16:47:00+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-13/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：权限已经允许以后，Bash 命令为什么仍需要解析、沙箱和平台安全边界，它们分别拦什么？

答案是，`allow` 只代表“当前权限规则同意执行这次工具调用”，它不等于命令已经被理解，也不等于操作系统会把进程限制在安全范围内。

解析层要解决的是：这串文本究竟包含几个子命令，有没有重定向、命令替换、动态执行和无法静态判断的结构。权限层要解决的是：这些已经识别出来的操作，在当前规则、路径和模式下应当 `allow`、`ask` 还是 `deny`。沙箱层才负责限制已经启动的进程能访问哪些文件和网络资源。最后，平台执行层还要处理 shell、工作目录、环境变量、超时、信号和进程树。

也就是说，这几层拦截的是不同问题：


| 层次 | 拦截对象 | 常见误读 |
| 命令解析 | 隐藏子命令、重定向、替换、无法静态分析的结构 | 用户是否允许执行 |
| Permission | 与规则、路径和运行模式冲突的操作 | 进程运行时一定无法越界 |
| Sandbox | 文件系统、网络等运行时访问 | 项目目录内的操作一定无害 |
| 平台执行 | 无效 cwd、缺失 shell、超时、取消、进程错误 | 命令语义已经被完整理解 |

因此，Bash 安全不是一道门，而是一串边界。少了任何一层，另外几层都不能自动补齐它的职责。

## 从一条 Bash 输入开始

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的代码为边界。还原路径便于我们定位实现，但不代表 Anthropic 内部仓库原本也按这些目录组织。下面的源码片段均删去了与当前论证无关的分支和参数，保留的代码不改写控制逻辑。

先看全链路。模型给出 `command` 以后，并不是马上调用 `/bin/bash`：

![Bash 命令从解析、权限、沙箱到进程与输出的安全边界](/images/posts/claude-code-source-reading-13/13-sandbox-bash-security-handdrawn.png)

这张图有一个容易被忽略的细节：Permission 和 Sandbox 是相邻的两层，却不是同一层。命令可以获得权限但不进入沙箱，也可以因为沙箱策略而被自动允许权限检查；这两种情况都必须继续看配置和平台分支，不能只看 UI 上有没有弹窗。

## 输入 Schema 先固定可控变量

`BashTool` 接收的不只是命令字符串。`restored-src/src/tools/BashTool/BashTool.tsx` 中的 `fullInputSchema` 把超时、后台执行和沙箱覆盖都放进了输入：

```ts
const fullInputSchema = lazySchema(() => z.strictObject({
  command: z.string().describe('The command to execute'),
  timeout: semanticNumber(z.number().optional()).describe(`Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`),
  description: z.string().optional().describe(`Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls → "List files in current directory"
- git status → "Show working tree status"
- npm install → "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"
- git reset --hard origin/main → "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"`),
  run_in_background: semanticBoolean(z.boolean().optional()).describe(`Set to true to run this command in the background. Use Read to read the output later.`),
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe('Set this to true to dangerously override sandbox mode and run commands without sandboxing.'),
  _simulatedSedEdit: z.object({
    filePath: z.string(),
    newContent: z.string()
  }).optional().describe('Internal: pre-computed sed edit result from preview')
}))
```

`fullInputSchema` 是 Bash 工具的完整输入约束。`z.strictObject` 表示未声明字段不会被当作普通扩展参数接收；模型实际看到的 `inputSchema` 还会永远移除内部字段 `_simulatedSedEdit`，避免模型伪造已经预览过的文件编辑。

这些参数的含义需要分清：

- `command` 是必填的任意字符串，源码没有列举一个封闭命令集合。
- `timeout` 是可选毫秒数。提示中展示的默认值为 120000 ms、最大值为 600000 ms；两者都可分别由 `BASH_DEFAULT_TIMEOUT_MS`、`BASH_MAX_TIMEOUT_MS` 覆盖。环境值缺失、非数字或不大于 0 时回退到源码默认值。
- `description` 是可选说明，只影响展示和任务描述，不参与命令安全判断。
- `run_in_background` 是可选布尔值；只有显式为 `true` 才要求立即后台运行，`false` 或 `undefined` 都走前台路径。若 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 为真，该字段会从模型可见 Schema 中移除。
- `dangerouslyDisableSandbox` 是可选布尔值。即使为 `true`，也必须同时满足策略允许 unsandboxed command，才能真正跳过沙箱；`false` 或 `undefined` 都不构成覆盖。

输入约束只能保证字段形状。`command` 仍是一门完整 shell 语言，这就是下一层必须解析它的原因。

## 解析不是为了美化命令，而是为了找到真实操作

考虑下面这条命令：

```bash
cd /tmp && cat input.txt | sed 's/a/b/' > result.txt
```

如果只取第一个空格前的单词，系统只会看到 `cd`。实际上，这里还有两个子命令、一个管道、一个目录变化和一个输出重定向。更复杂的 `$()`、进程替换、`eval` 和控制流，还可能让静态看到的命令与运行时执行的命令不同。

`restored-src/src/tools/BashTool/bashPermissions.ts` 中的 `bashToolHasPermission` 先尝试得到 AST，再把结果归入三类：

```ts
let astRoot = injectionCheckDisabled
  ? null
  : feature('TREE_SITTER_BASH_SHADOW') && !shadowEnabled
    ? null
    : await parseCommandRaw(input.command)

let astResult: ParseForSecurityResult = astRoot
  ? parseForSecurityFromAst(input.command, astRoot)
  : { kind: 'parse-unavailable' }

if (astResult.kind === 'too-complex') {
  const earlyExit = checkEarlyExitDeny(input, appState.toolPermissionContext)
  if (earlyExit !== null) return earlyExit
  const decisionReason: PermissionDecisionReason = {
    type: 'other' as const,
    reason: astResult.reason,
  }
  return {
    behavior: 'ask',
    decisionReason,
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    suggestions: [],
  }
}
```

`bashToolHasPermission(input, context, getCommandSubcommandPrefixFn)` 是 Bash 权限分析的总入口。`input` 是前面的工具输入；`context` 提供最新权限状态、取消信号以及是否为非交互会话；第三个参数默认是 `getCommandSubcommandPrefix`，测试或宿主可以注入其他实现。

`astResult.kind` 的源码可见取值是：

- `simple`：解析得到可继续做语义、路径和子命令检查的结构。
- `too-complex`：解析成功，但发现命令替换、展开、控制流或解析差异等无法可靠静态判断的结构。它不会直接放行，而是先保留显式 deny 的优先级，再回到 `ask`。
- `parse-unavailable`：tree-sitter 未加载、功能开关未启用，或者命令注入检查被环境变量关闭，随后进入旧解析路径。它不是“已经证明安全”。

这里可以看到一个重要原则：解析结果不完整时，控制流倾向于请求确认；但显式拒绝规则不会因为“太复杂”而降级成询问。解析的目的不是判断用户意图，而是给权限系统一份更接近真实执行结构的输入。

## 复合命令要逐段检查，重定向还要单独补查

解析得到子命令以后，权限判断不是只看整串文本是否匹配一条 allow 规则。`bashToolCheckPermission` 的顺序是先精确规则，再处理 deny/ask、路径约束、allow、`sed` 约束、模式和只读判断：

```ts
if (matchingDenyRules[0] !== undefined) {
  return {
    behavior: 'deny',
    message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
    decisionReason: {
      type: 'rule',
      rule: matchingDenyRules[0],
    },
  }
}

if (matchingAskRules[0] !== undefined) {
  return {
    behavior: 'ask',
    message: createPermissionRequestMessage(BashTool.name),
    decisionReason: {
      type: 'rule',
      rule: matchingAskRules[0],
    },
  }
}

const pathResult = checkPathConstraints(
  input,
  getCwd(),
  toolPermissionContext,
  compoundCommandHasCd,
  astCommand?.redirects,
  astCommand ? [astCommand] : undefined,
)
if (pathResult.behavior !== 'passthrough') return pathResult

if (matchingAllowRules[0] !== undefined) {
  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: {
      type: 'rule',
      rule: matchingAllowRules[0],
    },
  }
}
```

`bashToolCheckPermission(input, toolPermissionContext, compoundCommandHasCd?, astCommand?)` 检查一个命令或已拆出的原子子命令。`compoundCommandHasCd` 是可选布尔值，标记复合命令是否改变目录；`astCommand` 是可选的 AST 子命令，存在时可以直接使用解析出的参数和重定向，`undefined` 时则回退到旧的字符串解析。

权限结果不是只有三种。源码还使用 `passthrough` 表示“这一层没有作出最终决定，继续交给上层提示流程”。因此：

- `deny` 是明确拒绝；
- `ask` 是明确要求确认；
- `allow` 是明确允许，并可携带 `updatedInput`；
- `passthrough` 是当前规则未命中，通常最终也会触发权限提示，但它不等于 allow。

为什么还要在整串原始命令上补做重定向检查？因为旧的字符串分割可能把 `> /etc/passwd` 从子命令中剥离。源码在合并子命令判断之后，仍用原始输入调用 `checkPathConstraints`；有 AST 时则直接传入 AST 识别到的 redirects。也就是说，命令名称允许，不代表输出目标路径也被允许。

## Permission 通过以后，Sandbox 才决定是否包裹进程

权限回答的是“能不能调用”，沙箱回答的是“调用以后进程能看到什么”。`restored-src/src/tools/BashTool/shouldUseSandbox.ts` 把这一步写得很直接：

```ts
export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  if (!SandboxManager.isSandboxingEnabled()) return false

  if (
    input.dangerouslyDisableSandbox &&
    SandboxManager.areUnsandboxedCommandsAllowed()
  ) {
    return false
  }

  if (!input.command) return false
  if (containsExcludedCommand(input.command)) return false
  return true
}
```

`shouldUseSandbox(input)` 接收一个部分输入对象，因此 `command` 和 `dangerouslyDisableSandbox` 都可能是 `undefined`。返回 `true` 才表示这次命令需要沙箱包装；沙箱全局不可用、策略允许的显式覆盖、命令缺失，以及命中 `excludedCommands`，都会返回 `false`。

不过，`excludedCommands` 在源码注释中被明确称为 user-facing convenience，而不是安全边界。它的作用是让某些不兼容沙箱的命令改走 unsandboxed 路径；最终是否允许执行，仍要由权限和 `allowUnsandboxedCommands` 等策略共同决定。把 excluded list 当作可靠黑名单或白名单，都会读错这一层的设计。

沙箱相关设置还有几个容易混淆的默认值，它们位于 `restored-src/src/utils/sandbox/sandbox-adapter.ts`：

- `sandbox.enabled` 缺失时回退为 `false`。
- `autoAllowBashIfSandboxed` 缺失时回退为 `true`，表示进入沙箱的 Bash 可以参与自动允许逻辑；业务安全性需结合项目策略单独判断。
- `allowUnsandboxedCommands` 缺失时回退为 `true`。
- `failIfUnavailable` 缺失时回退为 `false`；只有启用沙箱且该值为真，才表达“沙箱不可用就不能继续”的强要求。
- `enabledPlatforms` 为 `undefined` 时允许所有受支持平台，空数组表示一个平台也不启用；具体数组元素来自运行时 `Platform[]` 配置。

。还需要核对平台、依赖、excluded command、显式覆盖以及企业策略。

## 沙箱不可用时，有“提示”“降级”和“拒绝”三条边界

`isSandboxingEnabled` 会同时检查平台支持、依赖、平台列表和用户设置。任何一项不满足都会返回 `false`。为了避免用户明明开启沙箱却无声降级，`getSandboxUnavailableReason` 另外生成可读原因：

```ts
function getSandboxUnavailableReason(): string | undefined {
  if (!getSandboxEnabledSetting()) return undefined

  if (!isSupportedPlatform()) {
    const platform = getPlatform()
    if (platform === 'wsl') {
      return 'sandbox.enabled is set but WSL1 is not supported (requires WSL2)'
    }
    return `sandbox.enabled is set but ${platform} is not supported (requires macOS, Linux, or WSL2)`
  }

  if (!isPlatformInEnabledList()) {
    return `sandbox.enabled is set but ${getPlatform()} is not in sandbox.enabledPlatforms`
  }

  const deps = checkDependencies()
  if (deps.errors.length > 0) {
    const platform = getPlatform()
    const hint =
      platform === 'macos'
        ? 'run /sandbox or /doctor for details'
        : 'install missing tools (e.g. apt install bubblewrap socat) or run /sandbox for details'
    return `sandbox.enabled is set but dependencies are missing: ${deps.errors.join(', ')} · ${hint}`
  }
  return undefined
}
```

`getSandboxUnavailableReason()` 没有参数，返回 `string | undefined`。用户没有显式启用沙箱时返回 `undefined`，因为此时依赖缺失不是异常；显式启用但平台、enabled list 或依赖不满足时返回原因字符串；全部满足时也返回 `undefined`。

注意，返回警告不等于停止执行。`initialize()` 的异常分支会清空初始化 Promise、记录调试信息，但不会向外抛出；是否必须失败取决于 `failIfUnavailable` 以及上层是否执行强制策略检查。源码特意把“可用性诊断”和“必须拒绝执行”拆开了。

真正包装命令时，`wrapWithSandbox` 则不会把初始化竞争悄悄吞掉：

```ts
async function wrapWithSandbox(
  command: string,
  binShell?: string,
  customConfig?: Partial<SandboxRuntimeConfig>,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (isSandboxingEnabled()) {
    if (initializationPromise) await initializationPromise
    else throw new Error('Sandbox failed to initialize. ')
  }

  return BaseSandboxManager.wrapWithSandbox(
    command,
    binShell,
    customConfig,
    abortSignal,
  )
}
```

`wrapWithSandbox` 把命令改写为沙箱运行时可执行的字符串。`command` 是必填命令；`binShell` 可选，`undefined` 时交给底层管理器选择；`customConfig` 可选，用来覆盖部分 `SandboxRuntimeConfig`；`abortSignal` 可选，存在时可中止包装或初始化流程。沙箱已启用却没有初始化 Promise 时会直接抛错，而不是裸跑原命令。

## 真实执行还要确定 shell、cwd 和环境

经过前面几层以后，`BashTool.call` 调用 `runShellCommand`，后者再进入 `restored-src/src/utils/Shell.ts` 的 `exec`。到这里才真正准备子进程：

```ts
export async function exec(
  command: string,
  abortSignal: AbortSignal,
  shellType: ShellType,
  options?: ExecOptions,
): Promise<ShellCommand> {
  const provider = await resolveProvider[shellType]()
  let cwd = pwd()

  try {
    await realpath(cwd)
  } catch {
    const fallback = getOriginalCwd()
    logForDebugging(
      `Shell CWD "${cwd}" no longer exists, recovering to "${fallback}"`,
    )
    try {
      await realpath(fallback)
      setCwdState(fallback)
      cwd = fallback
    } catch {
      return createFailedCommand(
        `Working directory "${cwd}" no longer exists. Please restart Claude from an existing directory.`,
      )
    }
  }

  if (abortSignal.aborted) {
    return createAbortedCommand()
  }
}
```

`exec(command, abortSignal, shellType, options?)` 是 shell 执行的公共入口。`command` 是经过 provider 包装前的命令；`abortSignal` 是必填取消信号；`shellType` 的静态类型取值包括 `bash` 和 `powershell`，分别选择 Bash/Zsh provider 或 PowerShell provider；`options` 可以是 `undefined`，其中 `timeout`、`preventCwdChanges`、`shouldUseSandbox`、`shouldAutoBackground` 都是可选值，缺失时走各自默认路径。

这里有三个实现细节值得注意。

第一，每次执行都会创建新的 shell 进程，但它使用 Claude Code 保存的 cwd 状态。当前目录已经被外部删除时，代码会尝试回到启动时的 `originalCwd`；连 fallback 也不存在时，返回 pre-spawn failure，而不是在一个未知目录继续执行。

第二，子进程环境不是直接原样转发 `process.env`。执行器使用 `subprocessEnv()`，再补上 `SHELL`、`GIT_EDITOR: 'true'`、`CLAUDECODE: '1'` 和 provider 的环境覆盖。

第三，主线程命令可以通过临时 cwd 文件把 `cd` 的结果写回会话状态；子 Agent 设置 `preventCwdChanges`，不会修改主会话 cwd。命令结束后如果 cwd 跑到项目权限范围外，`BashTool.call` 还会调用 `resetCwdIfOutsideProject` 做恢复。这是状态边界，不是文件系统沙箱的替代品。

## 超时、Abort 和后台运行不是同一个终态

命令执行时间长时，最容易误解的是“超时就一定杀进程”。`ShellCommandImpl` 实际上根据是否允许自动后台化选择两条路径：

```ts
static #handleTimeout(self: ShellCommandImpl): void {
  if (self.#shouldAutoBackground && self.#onTimeoutCallback) {
    self.#onTimeoutCallback(self.background.bind(self))
  } else {
    self.#doKill(SIGTERM)
  }
}

#abortHandler(): void {
  if (this.#abortSignal.reason === 'interrupt') return
  this.kill()
}
```

这两个函数都属于 `restored-src/src/utils/ShellCommand.ts` 的 `ShellCommandImpl`。`#handleTimeout(self)` 没有开放参数枚举：当 `shouldAutoBackground` 为真且注册了回调时，超时会请求后台化；否则杀死进程。`#abortHandler()` 读取 `AbortSignal.reason`：特殊值 `'interrupt'` 表示用户提交了新消息，此处不立即杀进程，调用链有机会把它转成后台任务；其他 abort reason 则调用 `kill()` 杀进程树。

因此，至少要区分四种结果：

1. 前台正常结束，返回 exit code 和输出。
2. 超时后被杀，结果携带超时信息。
3. 超时、用户 `Ctrl+B` 或 assistant 运行预算触发后台化，命令继续运行并返回 task id。
4. 执行前已经 abort，根本不 spawn 子进程。

显式 `run_in_background: true` 也不等于在命令末尾拼一个 `&`。它注册 `LocalShellTask`，把输出、取消和完成通知纳入任务状态；若后台任务被环境变量禁用，则继续以前台方式执行。后台化以后前台 timeout 会被清除，但输出文件仍有 size watchdog，避免无限追加占满磁盘。

## 输出也有边界：模型看到的只是预览

命令结束并不意味着所有输出都会原样塞回上下文。`BashTool.call` 使用 `EndTruncatingAccumulator` 保存前部预览；当 `TaskOutput` 判断结果过大时，完整输出会被复制到 tool-results 目录：

```ts
const MAX_PERSISTED_SIZE = 64 * 1024 * 1024
let persistedOutputPath: string | undefined

if (result.outputFilePath && result.outputTaskId) {
  try {
    const fileStat = await fsStat(result.outputFilePath)
    persistedOutputSize = fileStat.size
    await ensureToolResultsDir()
    const dest = getToolResultPath(result.outputTaskId, false)
    if (fileStat.size > MAX_PERSISTED_SIZE) {
      await fsTruncate(result.outputFilePath, MAX_PERSISTED_SIZE)
    }
    try {
      await link(result.outputFilePath, dest)
    } catch {
      await copyFile(result.outputFilePath, dest)
    }
    persistedOutputPath = dest
  } catch {
    // File may already be gone — stdout preview is sufficient
  }
}
```

这段逻辑位于 `BashTool.call(input, toolUseContext, _canUseTool?, parentMessage?, onProgress?)` 的结果处理阶段。`input` 和 `toolUseContext` 必填；`_canUseTool` 当前签名保留但函数体未使用；`parentMessage` 可选，主要供模拟 `sed` 编辑记录历史；`onProgress` 可选，存在时接收 `bash_progress`。`persistedOutputPath` 初始是 `undefined`，只有大输出文件成功保存后才得到路径；持久化副本最多保留 64 MiB。

映射成 `tool_result` 时，模型会拿到一段 preview 和持久化路径提示，之后可以用 Read 工具读取。复制、链接或 stat 失败时，代码保留已有 stdout preview，不会凭空宣称完整输出可用。输出裁剪保护的是上下文和磁盘预算，它同样不是命令权限边界。

## macOS、Linux、Windows 不能套用同一条结论

源码明确把平台差异写进了执行器。

在 macOS 上，沙箱运行时与日志监控走对应实现；在 Linux 和 WSL2 上，依赖检查会涉及 `bubblewrap`、`socat` 等工具，而且 Linux/WSL 的路径 glob 支持还有额外警告。WSL1 被明确列为不支持。也就是说，即使配置文本相同，底层可表达的文件和网络限制也不必完全相同。

Windows 原生平台还多了一套 `PowerShellTool`，而不是把 PowerShell 文本交给 Bash 解析器。它有自己的 AST 安全检查，例如动态命令名、`Invoke-Expression`、encoded command、下载执行链和提权参数。`powershellSecurity.ts` 在解析失败时回到 `ask`，而不是复用 Bash 的字符串拆分规则。

更关键的是，原生 Windows 没有 POSIX 沙箱。`PowerShellTool.tsx` 同时在 `validateInput` 和 `call` 设置了兜底：当企业策略开启 sandbox 且禁止 unsandboxed command 时，直接拒绝执行。Linux、macOS、WSL2 上的 PowerShell 则可以作为 native binary 进入现有沙箱；为了保留 `-NoProfile -NonInteractive`，沙箱内层会使用 `/bin/sh` 执行编码后的 `pwsh` 调用。

。平台分支本身就是安全模型的一部分。

## 小结

回到开头的问题：为什么权限允许以后，Bash 还要继续解析、沙箱化并经过平台执行边界？因为 allow 只批准一次操作意图，后面的每一层仍在回答不同问题。

解析层尽量还原命令真实结构，权限层把结构映射到 allow、ask、deny，沙箱层限制进程能接触的资源，平台执行层处理 shell、cwd、环境、进程树、超时和取消，输出层再限制回填模型的内容规模。任何一层都不能单独提供完整安全。

真正可靠的阅读方法，不是寻找一个叫 `isSafe` 的函数，而是沿着输入到副作用的路径，确认每一层拦什么、失败时往哪里走，以及它是否可能降级。

## 留给下一篇的问题

Bash 之外，Read、Edit、Write、Notebook 等文件工具如何利用读取状态、快照与历史避免覆盖，并在失败后回滚？

