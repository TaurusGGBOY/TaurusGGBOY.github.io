---
title: "Claude Code源码解读13：如何建立命令执行安全边界"
published: 2026-07-24T16:47:00+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-13/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇的问题是，permission mode 为 `auto` 时，究竟是谁在替用户按下“允许”？

答案不在 `tool.call()` 里。`auto` 只接管权限链中原本会返回 `ask` 的那一小段。已经得到 `deny` 或 `allow` 的调用不会重新绕回这里；只有 `hasPermissionsToUseToolInner()` 返回 `ask`，外层 `hasPermissionsToUseTool()` 才会继续检查 auto 路径。

这条路径有一个明确入口。`TRANSCRIPT_CLASSIFIER` 已开启，并且当前 mode 是 `auto`。源码还允许一种特殊情况，当前处于 `plan` mode，但会话已经激活 auto 状态。进入分支以后，系统先走两个不需要分类器的快速判断。它会用 `acceptEdits` mode 再检查一次工具权限；如果这个工具在该模式下本来就能放行，直接返回 `allow`。接着检查 `SAFE_YOLO_ALLOWLISTED_TOOLS`，命中白名单的安全工具也直接放行。

下面把 `hasPermissionsToUseTool()` 中的关键控制分支合并展示，省略 `appState` 获取、日志和异常处理。它不是一段可直接复制的完整源码。

```ts
const mode = appState.toolPermissionContext.mode
if (
  feature('TRANSCRIPT_CLASSIFIER') &&
  (mode === 'auto' || (mode === 'plan' && isAutoModeActive()))
) {
  const acceptEditsResult = await tool.checkPermissions(/* mode: acceptEdits */)
  if (acceptEditsResult.behavior === 'allow') {
    return { behavior: 'allow', updatedInput: acceptEditsResult.updatedInput ?? input }
  }

  if (isAutoModeAllowlistedTool(tool.name)) {
    return { behavior: 'allow', updatedInput: input }
  }
}
```

上面只留下控制分支，日志、遥测、PowerShell 和安全检查都省略了，不能当成完整源码复制。两个快速路径的共同点是，它们返回的仍是标准 `PermissionDecision`，只是 `decisionReason` 会标记为 `mode: 'auto'`。之后调用继续沿普通执行链前进，`updatedInput` 最终交给 `tool.call()`。

快速路径都没命中时，才轮到 classifier。它不是打包在本机离线运行的规则表。`classifyYoloAction()` 会通过 `sideQuery()` 调用 Anthropic Messages API，把精简后的 transcript、action、工具编码和权限上下文发给云端模型。`getClassifierModel()` 只负责挑模型名。内部用户可以用 `CLAUDE_CODE_AUTO_MODE_MODEL` 覆盖，功能配置也可以提供 `tengu_auto_mode_config.model`，否则回退到主循环模型。无论模型名怎么选，这一步都仍然是远程推理。

返回值里的 `shouldBlock` 决定权限结果。它为 `false` 时生成 `behavior: 'allow'`，为 `true` 时记录 denial 状态并生成 `behavior: 'deny'`。连续拒绝达到限制后，源码还可能把决定权交回人工确认。

所以，`auto` 替换的只是 `ask → allow/deny` 这一段，不是从权限到 `tool.call()` 的整条链。不能由 classifier 放行的 safety check、`requiresUserInteraction()` 返回真的工具，以及功能未开启时的 PowerShell，都不会被这条路径静默批准。分类器 transcript 超过上下文时，交互模式会退回普通确认；headless 路径则直接终止。分类器不可用时，`tengu_iron_gate_closed` 还会决定是 fail-closed 拒绝，还是回到普通权限处理。

这就是上一篇答案和本篇的接缝。`auto` 只改变谁来处理未决的 `ask`，并没有替 Bash 跳过命令解析、沙箱、平台执行和输出处理。

## 介绍本章的一些概念

本篇不从一张很大的配置表开始，而是盯住一条 Bash 输入，看它怎样从字符串变成进程，再变成模型能读到的结果。先把会反复出现的几个概念放在这里。

| 概念 | 它解决的问题 | 关键符号 |
|---|---|---|
| 命令图 | 复合 shell 输入拆成子命令、重定向和管道，权限判断才能覆盖真实操作 | `ParseForSecurityResult`（`simple` / `too-complex` / `parse-unavailable`）、`astCommand.redirects` |
| 操作系统级隔离 | Seatbelt / bubblewrap 把文件与网络边界施加给 Bash 及其子进程 | `shouldUseSandbox()`、`SandboxManager`、`dangerouslyDisableSandbox` |
| 降级策略 | 沙箱不可用、命令需越界和解析失败分别进入提示、常规权限或硬失败路径 | `getSandboxUnavailableReason()`、`failIfUnavailable`、`wrapWithSandbox()` |
| 进程与输出 | shell、cwd、环境、超时和输出大小决定一次执行怎样收尾 | `exec()`、`ShellCommandImpl`、`EndTruncatingAccumulator` |

可以先记住四句话。

- 解析层负责弄清楚命令里到底包含哪些操作。
- 权限层决定这些操作能不能继续，重定向目标也在检查范围内。
- Sandbox 限制进程能看到和改动哪些资源，但它不等于权限判断。
- 命令真的启动以后，shell、cwd、超时、取消和输出大小各自还有一套状态。

接下来把这四层放回一条具体命令里。命令先被拆开，接着做权限和路径检查，再决定是否包上沙箱，最后才真正启动 shell。

## 正文

本文只引用 `@anthropic-ai/claude-code@2.1.88` 的还原代码。路径用于定位实现，不代表 Anthropic 内部目录；代码片段删去无关分支，但不改写控制逻辑；代码块以 `[source]` 标注证据层级，块内注释注明 `restored-src/` 路径（2.1.88 还原源码）。

### 先建立一张地图

一条 Bash 命令至少要经过三道不同的判断。先弄清楚字符串里藏了哪些操作，再判断这些操作是否有权限，最后才决定进程要不要放进操作系统的沙箱里。沙箱启动失败、命令需要越界或解析结果不完整时，系统还要选择提示、降级还是直接拒绝。

![从命令解析到操作系统沙箱的安全链](/images/posts/claude-code-source-reading-13/13-command-sandbox-detail-handdrawn.png)

这张图先把前三道关画出来。后面的 shell、cwd、超时、后台任务和输出大小，还会在真正创建进程以后继续影响结果。

把一条复合命令放进来就很直观。假设模型要跑一组测试，并把结果写进文件。

> 跑金额计算、支付回调和前端复现测试；所有 Bash、文件写入、网络访问和外部工具调用都遵守当前权限规则与 Hook。

模型提交的只有一个 `command` 字符串。运行时却要先拆出管道、重定向和目录变化，再逐段做权限检查，之后才决定是否给最终 shell 包上 sandbox。我们就用下面这条命令观察这条链。

`cd /tmp && cat input.txt | sed 's/a/b/' > result.txt`

![Bash 命令从解析、权限、沙箱到进程与输出的安全边界](/images/posts/claude-code-source-reading-13/13-sandbox-bash-security-handdrawn.png)

Permission 和 Sandbox 不是同一层。前者回答“这个动作能不能做”，后者回答“进程做这件事时能碰到哪些资源”。权限已经放行，也不代表沙箱一定可用；沙箱没有启动，也不代表权限规则就消失了。

### 输入 Schema 先固定可控变量

`BashTool` 的输入看起来不复杂。一个命令，加上超时、后台运行和沙箱覆盖。`restored-src/src/tools/BashTool/BashTool.tsx` 中的 `fullInputSchema` 具体如下。

```ts [source]
// restored-src/src/tools/BashTool/BashTool.tsx（2.1.88 还原源码）
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

`fullInputSchema` 是 Bash 工具的完整输入约束。`z.strictObject` 会拒绝未声明字段，模型可见的 `inputSchema` 还会移除内部的 `_simulatedSedEdit`。这个内部对象由运行时生成，`filePath` 指向模拟编辑目标，`newContent` 保存预计算后的内容，让真实执行路径复用已经审查过的 sed 编辑结果。

这里的 `optional()` 也有一个容易忽略的含义。它们的静态取值是“对应类型或 `undefined`”，不是 `null`；调用方省略字段可以走默认路径，显式传 `null` 则不符合这个 schema。

- `command` 必填，是开放的字符串。源码不枚举可执行命令，具体能调用什么取决于当前 shell、平台和已安装程序。
- `timeout` 是可选数字，单位是毫秒。提示中的默认值是 `120000`，最大值是 `600000`；`BASH_DEFAULT_TIMEOUT_MS` 和 `BASH_MAX_TIMEOUT_MS` 可以分别覆盖它们。环境值缺失、非数字或不大于 `0` 时，回退到源码默认值。
- `description` 是可选字符串，只用于展示和任务描述，不参与命令安全判断。
- `run_in_background` 是可选布尔值。只有显式 `true` 才请求立即后台运行，`false` 或 `undefined` 都走前台路径；`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 为真时，这个字段还会从模型可见 schema 中移除。
- `dangerouslyDisableSandbox` 是可选布尔值。只有显式 `true` 且策略允许 unsandboxed command 时，才有机会绕过沙箱；`false` 或 `undefined` 都沿正常沙箱决策走。

Schema 只能确认字段长什么样，不能理解 `command` 的真实含义。它仍然是一门完整的 shell 语言，下一层必须把它拆开来看。

### 解析层恢复命令中的真实操作

考虑下面这条命令。

```bash
cd /tmp && cat input.txt | sed 's/a/b/' > result.txt
```

如果只拿第一个空格前的单词，看到的会是 `cd`。但这条输入里其实有两个子命令、一个管道、一次目录变化和一个输出重定向。再遇到 `$()`、进程替换、`eval` 或控制流，静态看到的内容还可能和运行时真正执行的内容不一样。

`restored-src/src/tools/BashTool/bashPermissions.ts` 里的 `bashToolHasPermission` 会先尝试生成 AST，再把解析结果归类。AST 不是权限决定本身，它只是把命令中真实存在的操作交给后面的规则。

```ts [source]
// restored-src/src/tools/BashTool/bashPermissions.ts（2.1.88 还原源码）
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

`bashToolHasPermission(input, context, getCommandSubcommandPrefixFn)` 是 Bash 权限分析的总入口。`input` 是工具输入，`context` 带着权限状态、取消信号和宿主交互能力，第三个参数可选，缺失时使用 `getCommandSubcommandPrefix`。

`astRoot` 在注入检查关闭、shadow 路径生效或解析器不可用时会是 `null`，于是 `astResult` 变成 `parse-unavailable`；有 AST 时则交给 `parseForSecurityFromAst`。如果结果是 `too-complex`，代码先调用 `checkEarlyExitDeny`，保留显式 deny 的优先级，然后返回 `behavior: 'ask'`。`decisionReason.type: 'other'` 和 `reason` 记录复杂原因，`message` 生成确认文案，空数组 `suggestions: []` 表示这里没有可供宿主展示的规则建议。

`astResult.kind` 的源码可见取值如下。

- `simple` 表示解析得到了可以继续做语义、路径和子命令检查的结构。
- `too-complex` 表示解析成功，但发现命令替换、展开、控制流或解析差异等无法可靠静态判断的结构。它不会直接放行，会先保留显式 deny 的优先级，再回到 `ask`。
- `parse-unavailable` 表示 tree-sitter 未加载、功能开关未启用，或者命令注入检查被环境变量关闭。系统随后进入旧解析路径，继续由后续规则判断。

这三种结果里，只有 `simple` 能把完整结构交给后续检查。信息不够时，控制流倾向于请求确认；显式拒绝规则仍然优先。解析层的职责到这里就够了，它负责把权限系统的输入变得更接近真实执行结构，不负责替权限系统做最终裁决。

### 复合命令要逐段检查，重定向还要单独补查

AST 拆出子命令以后，`bashToolCheckPermission` 才能逐段检查精确规则、deny/ask、路径约束、allow、`sed` 约束、模式和只读判断。先看最关键的一小段。

```ts [source]
// restored-src/src/tools/BashTool/bashPermissions.ts（2.1.88 还原源码）
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

`bashToolCheckPermission(input, toolPermissionContext, compoundCommandHasCd?, astCommand?)` 可以检查一条命令，也可以检查复合命令中的一个原子子命令。`compoundCommandHasCd` 标记复合命令是否改变目录；`astCommand` 有值时提供参数和 redirects，省略时回退到字符串解析。

返回值的行为也很具体。命中 deny 或 ask 时，`behavior` 固定为对应结果，`message` 交给宿主展示，`decisionReason.type: 'rule'` 和 `rule` 记录命中的规则。`pathResult` 只要不是 `passthrough` 就直接返回；命中 allow 时，`updatedInput` 沿用当前输入，并把 allow rule 写进 `decisionReason`。

源码里的 `passthrough` 表示“这一层还没决定”，和 `allow` 是两回事。四种结果可以这样读。

- `deny` 是明确拒绝；
- `ask` 是明确要求确认；
- `allow` 是明确允许，并可携带 `updatedInput`；
- `passthrough` 表示当前规则未命中，决定继续交给上层提示流程。

重定向还要再查一次。旧的字符串分割可能只留下子命令名，把 `> /etc/passwd` 从检查对象里剥走。于是源码在合并子命令判断以后，仍用原始输入调用 `checkPathConstraints`；有 AST 时，再把识别到的 redirects 一并传进去。`cat` 能执行，不等于它可以把输出写进任意路径。

### 危险模式库，拆掉每一道护栏会怎样

把解析、权限和沙箱放在一起看，很多风险就不再是抽象的“命令危险”。它们都有具体的防线，也都有被配置项或平台条件拆开的时刻。下面这张表不是风险排名，只是把“正常路径”和“少了一道护栏以后会发生什么”放在一起。

| 危险模式 | 常态护栏 | 拆掉护栏后的反例 | 2.1.88 源码落点 |
|---|---|---|---|
| `curl ... \| sh`（下载即执行） | 权限规则先检查 `curl` 子命令；沙箱再把网络与文件写入边界施加给进程 | 显式 `dangerouslyDisableSandbox: true` 且 `allowUnsandboxedCommands` 未关（默认 `true`）。命令以宿主机全量文件系统与网络权限直接落地 | `shouldUseSandbox()`、`sandbox-adapter.ts` 默认值 |
| `> /etc/passwd` 重定向越界 | 对整串原始命令单独补查 redirects 的目标路径 | 只按空格拆分出的子命令名判断权限。`cd` 或 `cat` 被放行，重定向目标从未被检查 | `checkPathConstraints(input, ...)` 与 `astCommand?.redirects` |
| `rm -rf` / 破坏性命令 | 显式 deny 规则优先于一切；`too-complex` 分支也先跑 `checkEarlyExitDeny` | deny 规则缺失时降级为 `ask`。在 `auto` 模式下，这个 `ask` 会被分类器接管 | `checkEarlyExitDeny()`、`matchingDenyRules[0]` |
| `$(...)` / `eval` / 进程替换（动态代码） | AST 解析出 `too-complex` 后回到 `ask`，不静默放行 | 注入检查被环境变量关闭或 `TREE_SITTER_BASH_SHADOW` 生效。系统进入 `parse-unavailable` 旧路径，静态看到的命令可能不等于运行时执行的命令 | `injectionCheckDisabled`、`astResult.kind` |
| 子进程环境注入 | `subprocessEnv()` 筛选构造环境，并固定 `GIT_EDITOR: 'true'`、`CLAUDECODE: '1'` | 全量透传宿主环境。编辑器类工具可能触发交互注入，非交互会话也可能拿到本不该存在的交互通道 | `Shell.ts` 的 `subprocessEnv()` |
| 命令永不结束 | `timeout` 默认 120000 ms，超时后 `SIGTERM` 杀进程树或转后台 | `BASH_DEFAULT_TIMEOUT_MS` 被设成超大值且禁止后台化。命令无限挂起，占用会话 | `#handleTimeout()` 的 `#doKill(SIGTERM)` |
| 输出塞爆上下文 | `EndTruncatingAccumulator` 只回填 preview，大输出持久化到 tool-results 目录 | 全量输出原样回填。一次 `find /` 就能把上下文预算耗尽 | `MAX_PERSISTED_SIZE = 64 * 1024 * 1024` |
| `cd` 跑到项目外 | 命令结束后 `resetCwdIfOutsideProject` 恢复会话 cwd | 缺少这层恢复时，后续命令全部在项目外执行，路径权限规则的实际判定基准也会漂移 | `BashTool.call` 的 cwd 恢复 |
| Windows 下载执行链（`IEX`、encoded command） | PowerShell AST 解析器检查动态命令名、`Invoke-Expression`、编码命令与提权参数 | 只做字符串黑名单时，大小写、编码或拼接即可绕过；解析失败直接放行则完全失去这层防线 | `powershellSecurity.ts`、`PowerShellTool.tsx` |

其中两行值得单独停一下。

**反例 A。** `dangerouslyDisableSandbox` 不是一个单独的开关。只有 `input.dangerouslyDisableSandbox && SandboxManager.areUnsandboxedCommandsAllowed()` 同时为真，`shouldUseSandbox()` 才会返回 `false`。`allowUnsandboxedCommands` 缺失时默认是 `true`，所以没有企业策略收紧时，显式传入 `dangerouslyDisableSandbox: true` 确实可能让命令离开文件和网络边界。`excludedCommands` 也一样。源码把它叫作 user-facing convenience，它负责选择执行路径，不负责提供黑名单式保护；最终把关仍在权限层和 `allowUnsandboxedCommands`。

**反例 B。** `parse-unavailable` 不等于放行。注入检查被环境变量关闭或 tree-sitter 没有加载时，系统会进入旧解析路径，继续让后面的规则判断。问题在于旧路径对 `$()`、管道和控制流的拆分能力弱于 AST。AST 原本会判为“无法可靠静态判断”的结构，在旧路径下可能更晚才触发 `ask`。这就是解析信息不完整时必须保持保守的原因。

### Permission 放行后，Sandbox 还要做一次资源边界判断

Permission 解决“能不能调用”，Sandbox 解决“调用以后进程能看到什么”。`restored-src/src/tools/BashTool/shouldUseSandbox.ts` 里的判断很短。

```ts [source]
// restored-src/src/tools/BashTool/shouldUseSandbox.ts（2.1.88 还原源码）
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

`shouldUseSandbox(input)` 接收的是 `Partial<SandboxInput>`，所以 `command` 和 `dangerouslyDisableSandbox` 都可能是 `undefined`。只有返回 `true`，这次命令才会被沙箱包装。沙箱全局不可用、策略允许显式绕过、命令缺失，或命中 `excludedCommands`，都会得到 `false`。

这里尤其要分清 `excludedCommands`。源码把它标成 user-facing convenience，它让不兼容沙箱的命令改走 unsandboxed 路径，却不负责判断这条命令最终能不能执行。权限规则和 `allowUnsandboxedCommands` 仍然在后面把关。

`restored-src/src/utils/sandbox/sandbox-adapter.ts` 里还有几组容易混在一起的默认值。

- `sandbox.enabled` 缺失时回退为 `false`。
- `autoAllowBashIfSandboxed` 缺失时回退为 `true`，表示进入沙箱的 Bash 可以参与自动允许逻辑；它不等于跳过所有业务安全检查。
- `allowUnsandboxedCommands` 缺失时回退为 `true`。
- `failIfUnavailable` 缺失时回退为 `false`；只有启用沙箱且该值为真，才表达“沙箱不可用就不能继续”的强要求。
- `enabledPlatforms` 为 `undefined` 时允许所有受支持平台，空数组则表示没有平台启用；数组元素来自运行时的 `Platform[]` 配置。

所以，看到 `shouldUseSandbox()` 返回 `false`，还不能马上说“命令不安全”或“命令被允许了”。下一步要看它为什么返回 `false`，以及上层有没有把这个结果当成降级、提示或拒绝。

### 沙箱起不来时，系统不一定立刻拒绝

沙箱有没有真正可用，不能只看 `sandbox.enabled`。`isSandboxingEnabled` 还会检查平台、启用的平台列表、依赖和用户设置。任何一项不满足都会让它返回 `false`。为了不让“开启了但没跑起来”悄悄变成普通执行，`getSandboxUnavailableReason` 会另外给出原因。

```ts [source]
// restored-src/src/utils/sandbox/（2.1.88 还原源码）
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

`getSandboxUnavailableReason()` 不接参数，返回 `string | undefined`。用户根本没有开启沙箱时，它返回 `undefined`，这是正常状态；显式开启但平台、enabled list 或依赖不满足时，它返回原因字符串；所有条件都满足时也返回 `undefined`。调用方必须结合“用户有没有请求启用”来理解这个 `undefined`，不能只靠返回值区分“关闭”和“可用”。

这段函数只负责诊断。`initialize()` 的异常分支会清空初始化 Promise、记录调试信息并吞掉异常；`failIfUnavailable` 和上层的强制策略负责停止执行。诊断和拒绝被放在了两个控制点。

真正要把命令包进沙箱时，`wrapWithSandbox` 对初始化失败就没这么宽松。

```ts [source]
// restored-src/src/utils/sandbox/（2.1.88 还原源码）
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

`wrapWithSandbox` 返回的是交给沙箱运行时执行的命令字符串。`command` 必填；`binShell` 可选，`undefined` 时由底层管理器选择；`customConfig` 可选，用来覆盖部分 `SandboxRuntimeConfig`；`abortSignal` 可选，存在时可以中止包装或初始化。沙箱已启用但 `initializationPromise` 不存在时，函数直接抛错，原命令还没有执行。

### 真正启动进程前，还要确定 shell、cwd 和环境

前面的判断都通过以后，`BashTool.call` 会调用 `runShellCommand`，再进入 `restored-src/src/utils/Shell.ts` 的 `exec`。到这一步，程序才开始准备子进程。

```ts [source]
// restored-src/src/utils/Shell.ts（2.1.88 还原源码）
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

`exec(command, abortSignal, shellType, options?)` 是 shell 执行的公共入口。`command` 是交给 provider 包装前的命令，`abortSignal` 必填，`shellType` 的源码可见取值包括 `bash` 和 `powershell`，分别选择 Bash/Zsh provider 或 PowerShell provider。`options` 可以省略，也就是 `undefined`；其中 `timeout`、`preventCwdChanges`、`shouldUseSandbox` 和 `shouldAutoBackground` 都是可选项，缺失时沿各自默认路径处理。

这里有三个容易被忽略的细节。

每次执行都会创建新的 shell 进程，cwd 取 Claude Code 保存的状态。程序不会只从宿主 shell 临时读一遍就继续。当前目录已经被外部删除时，代码会尝试回到启动时的 `originalCwd`；连 fallback 也失效，就返回 pre-spawn failure，进程根本不会创建。

子进程环境也不是宿主环境的原样复制。`subprocessEnv()` 先筛选和构造，再补上 `SHELL`、`GIT_EDITOR: 'true'`、`CLAUDECODE: '1'` 以及 provider 的环境覆盖。

主线程命令还可以通过临时 cwd 文件把 `cd` 的结果写回会话状态。子 Agent 如果设置 `preventCwdChanges`，目录变化只在子任务里生效。命令结束后，若 cwd 跑到了项目权限范围外，`BashTool.call` 会调用 `resetCwdIfOutsideProject` 把会话状态拉回来。它只维护“下一条命令从哪里开始”，文件访问权限仍由沙箱负责。

### 超时、Abort 和后台运行不是一回事

命令跑得久时，最容易误会的是“超时就等于杀掉进程”。`ShellCommandImpl` 会先看当前命令能不能自动后台化。

```ts [source]
// restored-src/src/utils/ShellCommand.ts（2.1.88 还原源码）
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

这两个函数都属于 `restored-src/src/utils/ShellCommand.ts` 的 `ShellCommandImpl`。`#handleTimeout(self)` 接收当前实例；`shouldAutoBackground` 为真且存在回调时，超时会请求后台化，否则调用 `#doKill(SIGTERM)`。`#abortHandler()` 则看 `AbortSignal.reason`。值为 `'interrupt'` 时，表示用户提交了新消息，进程先保留下来，调用链有机会把它转成后台任务；其他 abort reason 才会调用 `kill()` 杀掉进程树。

所以同一条命令至少可能得到四种结果。

1. 前台正常结束，返回 exit code 和输出。
2. 超时后被杀，结果携带超时信息。
3. 超时、用户 `Ctrl+B` 或 assistant 运行预算触发后台化，命令继续运行并返回 task id。
4. 执行前已经 abort，根本不 spawn 子进程。

显式 `run_in_background: true` 会注册 `LocalShellTask`，让输出、取消和完成通知进入任务状态。若环境变量禁用了后台任务，调用仍会以前台方式执行。后台化以后，前台 timeout 会被清除，但输出文件还有 size watchdog，防止它一直追加直到占满磁盘。

### 输出也有边界，模型看到的只是预览

命令结束也不等于所有 stdout 都会原样塞回上下文。`BashTool.call` 用 `EndTruncatingAccumulator` 保留前部 preview；结果过大时，输出文件会被放进 tool-results 目录，相关代码如下。

```ts [source]
// restored-src/src/tools/BashTool/BashTool.tsx（2.1.88 还原源码）
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
    // File may already be gone; stdout preview is sufficient
  }
}
```

这段逻辑位于 `BashTool.call(input, toolUseContext, _canUseTool?, parentMessage?, onProgress?)` 的结果处理阶段。`input` 和 `toolUseContext` 必填；`_canUseTool` 虽然出现在签名里，但当前函数体没有使用它；`parentMessage` 可选，主要用于模拟 `sed` 编辑时记录历史；`onProgress` 可选，有值时接收 `bash_progress`。`persistedOutputPath` 初始为 `undefined`，只有大输出成功保存后才会得到路径，持久化副本最多保留 64 MiB。

映射成 `tool_result` 时，模型拿到的是 preview 和持久化路径提示，之后可以用 Read 读取文件。`stat`、链接或复制失败时，代码保留已经得到的 stdout preview，不再声称完整输出可用。输出裁剪只管上下文和磁盘预算，命令权限早在进程启动前就已经单独判断过了。

### macOS、Linux、Windows 不能套用同一条结论

平台差异不是执行器里的边角分支，它直接改变安全链能落到哪里。

macOS 使用对应的沙箱运行时和日志监控实现。Linux、WSL2 的依赖检查会涉及 `bubblewrap`、`socat` 等工具，路径 glob 也有额外限制；WSL1 则明确不支持。配置文件写成同一份，不代表底层能表达出完全相同的文件和网络边界。

原生 Windows 走独立的 `PowerShellTool` 和 PowerShell AST 解析器。它会检查动态命令名、`Invoke-Expression`、encoded command、下载执行链和提权参数；`powershellSecurity.ts` 解析失败时回到 `ask`。Bash 的字符串拆分规则只服务 POSIX shell 路径。

原生 Windows 没有 POSIX 沙箱运行时。`PowerShellTool.tsx` 在 `validateInput` 和 `call` 两处都留了兜底。企业策略开启 sandbox 且禁止 unsandboxed command 时，直接拒绝执行。Linux、macOS、WSL2 上的 PowerShell 则可以作为 native binary 进入现有沙箱；为保留 `-NoProfile -NonInteractive`，沙箱内层会通过 `/bin/sh` 执行编码后的 `pwsh` 调用。

同一个配置，在不同平台上可能落到不同的执行边界。平台分支本身就是安全模型的一部分。

### Bash 与 PowerShell 的 prompt 也会把宿主状态翻译给模型

`restored-src/src/tools/BashTool/prompt.ts` 不是一段固定的命令使用说明。它会把默认/最大 timeout、后台任务开关、git 场景、sandbox 配置和当前用户的临时目录拼进 prompt；若 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 存在，后台说明就不会出现。它还要求独立调用尽量并行、存在依赖时才顺序执行，文件读写和搜索优先走专用工具；即使提示允许 unsandboxed，也要求有明确意图或证据，并按命令分别判断。真正的放行仍由 Permission 与 SandboxManager 完成，prompt 只是把可用边界提前暴露给模型。

`PowerShellTool/prompt.ts` 又根据 desktop、PowerShell Core 或未知版本调整语法警告。desktop/未知环境会提醒不要依赖 `&&`、`||`、三元表达式、`??`、`?.` 和原生 stderr 重定向，并提示默认编码与 JSON 行为；Core 才允许相应现代语法。它同时明确要求终端操作才用 PowerShell，文件读取、编辑、写入、Glob、Grep 应交给专用工具。这里的有趣之处是，prompt 先做一次“平台编译”，但安全判定仍在模型之外保留最终否决权。

## 源码映射

| 主题 | 关键文件（`restored-src/src/`） | 关键函数 / 符号 | 证据 |
|---|---|---|---|
| 输入契约 | `tools/BashTool/BashTool.tsx` | `fullInputSchema`、`_simulatedSedEdit` | 源码已确认 |
| 解析与分类 | `tools/BashTool/bashPermissions.ts` | `bashToolHasPermission()`、`parseForSecurityFromAst()`、`checkEarlyExitDeny()` | 源码已确认 |
| 子命令与路径 | `tools/BashTool/bashPermissions.ts` | `bashToolCheckPermission()`、`checkPathConstraints()`、`astCommand.redirects` | 源码已确认 |
| 沙箱决策 | `tools/BashTool/shouldUseSandbox.ts` | `shouldUseSandbox()`、`containsExcludedCommand()` | 源码已确认 |
| 沙箱默认值 | `utils/sandbox/sandbox-adapter.ts` | `sandbox.enabled`、`allowUnsandboxedCommands`、`failIfUnavailable`、`enabledPlatforms` | 源码已确认 |
| 沙箱可用性 | `utils/sandbox/` | `getSandboxUnavailableReason()`、`wrapWithSandbox()`、`initialize()` | 源码已确认 |
| 进程执行 | `utils/Shell.ts` | `exec()`、`subprocessEnv()`、`resolveProvider` | 源码已确认 |
| 超时与取消 | `utils/ShellCommand.ts` | `ShellCommandImpl.#handleTimeout()`、`#abortHandler()`、`#doKill(SIGTERM)` | 源码已确认 |
| 输出持久化 | `tools/BashTool/BashTool.tsx` | `EndTruncatingAccumulator`、`MAX_PERSISTED_SIZE`、`getToolResultPath()` | 源码已确认 |
| 平台分支 | `tools/PowerShellTool/`、`tools/BashTool/` | `powershellSecurity.ts`、sandbox 兜底拒绝 | 源码已确认 |

## 设计决策

读完这条链，先别急着背配置名。五层边界各自负责一件事。解析层还原命令图，权限层裁决，沙箱限制资源，平台层决定 shell、cwd、环境和进程树，输出层限制回填规模。`auto` 只碰权限层，其他层不会因为它返回 `allow` 就消失。

信息不完整时，系统倾向于多问一次。`too-complex` / `parse-unavailable` 会回到 `ask` 或旧解析路径继续判断，不会因为解析失败就直接放行；显式 deny 在各分支里都保持更高优先级。代价是少数命令会多一次确认，换来的是不把看不见的操作静默执行。

诊断和强制也分开。`getSandboxUnavailableReason` 只解释“为什么没启用”；`failIfUnavailable` 和初始化 Promise 缺失才会真正阻止执行。个人环境可以接受提示后降级，企业环境则可以把它们组合成硬边界。

最后，`excludedCommands` 只是路径选择。它让不兼容沙箱的命令走 unsandboxed 路径，最终能否执行仍由权限层和 `allowUnsandboxedCommands` 把关。把它当黑名单，会高估这项配置的保护力。

## 练习，给一条危险命令画出四层护栏

如果想把这条链跑一遍，可以在测试目录里做下面四个小实验。

1. 在 `/tmp` 建一个测试目录，运行 `claude -p "cd /tmp/guard-test && printf 'x' > escaped.txt && cat escaped.txt"`，观察权限提示出现的时机和文案；再运行 `claude -p "cat /tmp/guard-test/escaped.txt > /tmp/outside.txt"`，对比重定向目标的权限提示是否独立出现。
2. 查看当前沙箱状态。交互模式运行 `/sandbox`，记录 `sandbox.enabled`、`allowUnsandboxedCommands` 的显示值；对照 `getSandboxUnavailableReason()` 的四种返回（默认关闭 / 平台不支持 / enabledPlatforms 未命中 / 依赖缺失），说出你当前机器命中哪一种。
3. 运行 `claude -p "sleep 5"` 并立即按 `Esc`，观察命令是否被取消；再运行一条 `sleep 3` 并等待，观察是否出现后台化提示。对照 `#handleTimeout()` 的两条分支（`onTimeoutCallback` 转后台 / `#doKill(SIGTERM)`）。
4. 用 `claude -p "find / -name '*.log' 2>/dev/null | head -100"` 观察。如果输出被截断，`tool_result` 里是否出现持久化路径；用 Read 读取该路径，确认内容与 preview 的边界。

你应该看到这些现象。

- 第 1 步。第一条命令的权限提示会围绕 `cd` 与子命令展开；第二条命令还会出现和 `/tmp/outside.txt` 有关的路径提示。这说明重定向目标被单独检查，走的是 `checkPathConstraints` 的整串补查。
- 第 2 步。默认状态下 `/sandbox` 显示 disabled 或依赖缺失提示；若显式开启，未装 bubblewrap 的 Linux 会看到 `dependencies are missing`，macOS 提示运行 `/sandbox` 或 `/doctor`。
- 第 3 步。`Esc` 取消对应 `#abortHandler` 中 `reason !== 'interrupt'` 的 `kill()` 分支；长时间运行的命令在超时后可能转为后台任务，界面出现 task id 而不是超时错误。
- 第 4 步。大输出被截断时，`tool_result` 末尾出现持久化路径，Read 该路径可拿到完整或截断到 64 MiB 的输出。

## 自测

1. `auto` 模式会跳过 Bash 的解析与沙箱判断吗？为什么？
2. 为什么 `> /etc/passwd` 这类重定向要单独补查，而不是只检查子命令本身？
3. `AbortSignal.reason === 'interrupt'` 时进程为什么没有被杀？这属于四种终态中的哪一种？

<details>
<summary>参考答案</summary>

1. **不会**。`auto` 只替换权限层对未决 `ask` 的处理方式。它要么走快速路径（`acceptEdits` 重查、`SAFE_YOLO_ALLOWLISTED_TOOLS` 白名单），要么走 classifier 判断；生成的仍是标准 `PermissionDecision`，之后的解析、沙箱、平台执行与输出边界全部照常。

2. **旧的字符串分割可能把重定向从子命令中剥离**。命令名称允许不代表输出目标路径也被允许；源码在合并子命令判断后仍用原始输入调用 `checkPathConstraints`，有 AST 时直接传入 `astCommand.redirects`，让输出目标也进入路径规则。

3. **`'interrupt'` 表示用户提交了新消息**，进程被保留，调用链有机会把它转成后台任务；这属于“超时、用户 `Ctrl+B` 或 assistant 运行预算触发后台化”的第三种终态，而不是“超时被杀”。

</details>

## 回顾，沿一条命令追踪五层安全边界

<details>
<summary>展开查看回顾</summary>

回到上一篇的问题，`auto` 只替代权限层处理未决 `ask` 的方式，并没有把命令变成无条件放行。即使自动路径返回 `allow`，Bash 仍要经过解析、权限、沙箱、平台执行和输出五层。解析层还原命令图，权限层补查整串命令里的重定向，沙箱限制进程能看到的文件和网络，平台层决定 shell、cwd、环境、超时与取消，输出层用 preview 和 64 MiB 的持久化上限控制回填规模。

真正读懂这条安全链，还要同时看两件事。默认防线是什么，以及 `dangerouslyDisableSandbox`、WSL1 或原生 Windows 这类配置和平台条件把哪一层拆开了。

</details>

## 留给下一篇的问题

从当前版本看来，为什么很多 PowerShell 脚本要到执行时才报错？

## 相关链接

- **上一篇** [12 如何在允许、询问与拒绝之间决策](./12-permission-engine.md)，`auto` 决策的来源
- **下一篇** [14 如何通过快照与历史实现回滚](./14-file-tools-and-rollback.md)，回答本文的 PowerShell 问题
- [How we built Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)
- [Claude Code 沙箱机制](https://code.claude.com/docs/en/sandboxing)
- [Claude Code 权限配置](https://code.claude.com/docs/en/permissions)
