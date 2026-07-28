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

上一篇留下的问题是：当 permission mode 为 `auto` 时，“自动”具体体现在哪里？

先给结论：`auto` 不是把所有工具直接放行，而是把权限链里原本需要交给人的 `ask`，交给一组源码明确的自动决策路径。已经命中 deny 或 allow 的结果不会重新进入这条路径；只有 `hasPermissionsToUseToolInner()` 返回 `ask` 时，外层 `hasPermissionsToUseTool()` 才会继续检查 `auto`。

入口条件是 `TRANSCRIPT_CLASSIFIER` 功能开启，并且当前 mode 是 `auto`；源码还允许处于 `plan` mode、但会话已经激活 auto 状态时进入同一分支。自动首先体现为两个无需调用分类器的快速路径：系统会用 `acceptEdits` mode 重新检查一次工具权限，如果该工具在这个模式下本来就能放行，就直接返回 `allow`；随后再检查 `SAFE_YOLO_ALLOWLISTED_TOOLS`，白名单中的安全工具也直接返回 `allow`。

下面把 `hasPermissionsToUseTool()` 中的关键控制分支合并展示，省略 `appState` 获取、日志和异常处理；它不是一段可直接复制的完整源码：

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

上面只保留控制分支，省略了日志、遥测、PowerShell 和安全检查。两个快速路径的共同点是：它们生成的仍然是标准 `PermissionDecision`，只是 `decisionReason` 标记为 `mode: 'auto'`，随后沿着普通执行链把 `updatedInput` 交给 `tool.call()`。

如果快速路径没有命中，自动就体现为一次独立的 classifier 判断。`formatActionForClassifier()` 把工具名和输入整理成待判断的 action，`classifyYoloAction()` 再从 `context.messages` 构造精简 transcript，并把 action、工具编码和权限上下文交给分类模型。返回值里的 `shouldBlock` 决定结果：`false` 生成 `behavior: 'allow'`，`true` 记录 denial 状态并生成 `behavior: 'deny'`；连续拒绝达到限制时，源码还可能回到人工确认，让用户复核。

因此，“自动”真正替换的是 `ask → allow/deny` 这一段决策，不是 `permission → tool.call` 的全部链路。不可由 classifier 放行的 safety check、`requiresUserInteraction()` 返回真的工具，以及功能未开启时的 PowerShell，都不会被这条自动路径静默批准。分类器 transcript 超过上下文时，交互模式会退回普通确认；无交互的 headless 路径则直接终止。分类器不可用时，还要根据 `tengu_iron_gate_closed` 的运行时开关决定 fail-closed 拒绝还是回退到普通权限处理。

也就是说，`auto` 只改变“谁来处理未决的 ask”，不改变 Bash 后面还要经过的命令解析、沙箱和平台执行边界。下面先固定这三个概念，再沿一条 Bash 输入追踪它们如何协作。

## 本章先建立三个概念

- **命令图**：复合 shell 输入需要拆成子命令、重定向和管道，权限判断才能覆盖真实操作。

- **操作系统级隔离**：Seatbelt 或 bubblewrap 把文件与网络边界施加给 Bash 及其子进程。

- **降级策略**：沙箱不可用、命令需越界和解析失败分别进入提示、常规权限或硬失败路径。

![从命令解析到操作系统沙箱的安全链](/images/posts/claude-code-source-reading-13/13-command-sandbox-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 从一条 Bash 输入开始

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的代码为边界。还原路径便于我们定位实现，但不代表 Anthropic 内部仓库原本也按这些目录组织。下面的源码片段均删去了与当前论证无关的分支和参数，保留的代码不改写控制逻辑。

先看全链路。模型给出 `command` 后，调用路径先经过解析、权限与沙箱决策，再抵达 shell：

![Bash 命令从解析、权限、沙箱到进程与输出的安全边界](/images/posts/claude-code-source-reading-13/13-sandbox-bash-security-handdrawn.png)

Permission 和 Sandbox 是相邻但职责独立的两层。命令可能获得权限后走 unsandboxed 路径，也可能因沙箱策略满足权限快速路径；两种情况都要继续结合配置与平台分支判断。

## 输入 Schema 先固定可控变量

`BashTool` 接收命令字符串以及超时、后台执行和沙箱覆盖。`restored-src/src/tools/BashTool/BashTool.tsx` 中的 `fullInputSchema` 如下：

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

`fullInputSchema` 是 Bash 工具的完整输入约束。`z.strictObject` 拒绝未声明字段；模型可见的 `inputSchema` 会移除内部 `_simulatedSedEdit`。该内部对象由运行时生成，`filePath` 指向模拟编辑目标，`newContent` 保存预计算后的文件内容，使真实执行路径可以复用已审查结果。

这些参数的含义需要分清：

- `command` 是必填的开放字符串，具体命令集合由当前 shell、平台和已安装程序决定。
- `timeout` 是可选毫秒数。提示中展示的默认值为 120000 ms、最大值为 600000 ms；两者都可分别由 `BASH_DEFAULT_TIMEOUT_MS`、`BASH_MAX_TIMEOUT_MS` 覆盖。环境值缺失、非数字或不大于 0 时回退到源码默认值。
- `description` 是可选说明，只影响展示和任务描述，不参与命令安全判断。
- `run_in_background` 是可选布尔值；只有显式 `true` 才请求立即后台运行，其他值走前台路径。若 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 为真，该字段会从模型可见 Schema 中移除。
- `dangerouslyDisableSandbox` 是可选布尔值。显式 `true` 还必须满足策略允许 unsandboxed command，其他值沿用正常沙箱决策。

输入约束只能保证字段形状。`command` 仍是一门完整 shell 语言，这就是下一层必须解析它的原因。

## 解析层恢复命令中的真实操作

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

`bashToolHasPermission(input, context, getCommandSubcommandPrefixFn)` 是 Bash 权限分析总入口。`input` 是工具输入，`context` 提供权限状态、取消信号与宿主交互能力，第三个参数默认 `getCommandSubcommandPrefix`。`astRoot` 在注入检查关闭、shadow 路径生效或解析器不可用时为 `null`，使 `astResult` 进入 `parse-unavailable`；有 AST 时交给 `parseForSecurityFromAst`。`too-complex` 分支先运行 `checkEarlyExitDeny`，再返回 `behavior: 'ask'`；`decisionReason.type: 'other'` 和 `reason` 保存复杂原因，`message` 生成确认文案，`suggestions: []` 表示这条路径不附带权限规则建议。

`astResult.kind` 的源码可见取值是：

- `simple`：解析得到可继续做语义、路径和子命令检查的结构。
- `too-complex`：解析成功，但发现命令替换、展开、控制流或解析差异等无法可靠静态判断的结构。它不会直接放行，而是先保留显式 deny 的优先级，再回到 `ask`。
- `parse-unavailable`：tree-sitter 未加载、功能开关未启用，或者命令注入检查被环境变量关闭，随后进入旧解析路径，继续由后续规则判断。

这里可以看到一个重要原则：解析结果不完整时，控制流倾向于请求确认；显式拒绝规则仍保持更高优先级。解析层给权限系统提供更接近真实执行结构的输入。

## 复合命令要逐段检查，重定向还要单独补查

解析得到子命令后，`bashToolCheckPermission` 依次处理精确规则、deny/ask、路径约束、allow、`sed` 约束、模式和只读判断：

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

`bashToolCheckPermission(input, toolPermissionContext, compoundCommandHasCd?, astCommand?)` 检查一个命令或原子子命令。`compoundCommandHasCd` 标记复合命令是否改变目录；`astCommand` 存在时提供参数与 redirects，省略时回退字符串解析。命中 deny/ask 时，`behavior` 固定相应结果，`message` 给宿主显示，`decisionReason.type: 'rule'` 与 `rule` 保存命中规则。`pathResult` 只要不为 `passthrough` 就直接返回；命中 allow 时，`updatedInput` 沿用当前输入，`decisionReason` 同样记录 allow rule。

源码还使用 `passthrough` 表示这一层把决定继续交给上层提示流程。因此：

- `deny` 是明确拒绝；
- `ask` 是明确要求确认；
- `allow` 是明确允许，并可携带 `updatedInput`；
- `passthrough` 表示当前规则未命中，通常最终触发权限提示。

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

不过，`excludedCommands` 在源码注释中被明确称为 user-facing convenience。它的作用是让某些不兼容沙箱的命令改走 unsandboxed 路径；权限和 `allowUnsandboxedCommands` 等策略仍会决定最终能否执行。因此 excluded list 只负责路径选择，黑名单或白名单式安全保证由其他层提供。

沙箱相关设置还有几个容易混淆的默认值，它们位于 `restored-src/src/utils/sandbox/sandbox-adapter.ts`：

- `sandbox.enabled` 缺失时回退为 `false`。
- `autoAllowBashIfSandboxed` 缺失时回退为 `true`，表示进入沙箱的 Bash 可以参与自动允许逻辑；业务安全性需结合项目策略单独判断。
- `allowUnsandboxedCommands` 缺失时回退为 `true`。
- `failIfUnavailable` 缺失时回退为 `false`；只有启用沙箱且该值为真，才表达“沙箱不可用就不能继续”的强要求。
- `enabledPlatforms` 为 `undefined` 时允许所有受支持平台，空数组表示一个平台也不启用；具体数组元素来自运行时 `Platform[]` 配置。

还需要核对平台、依赖、excluded command、显式覆盖以及企业策略。

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

`getSandboxUnavailableReason()` 是零参数函数，返回 `string | undefined`。用户按默认方式关闭沙箱时返回 `undefined`，因为此时依赖缺失属于预期状态；显式启用但平台、enabled list 或依赖不满足时返回原因字符串；全部满足时也返回 `undefined`。调用方要结合“是否请求启用”才能区分后两种空值来源。

注意，可用性警告只提供诊断信息。`initialize()` 的异常分支会清空初始化 Promise、记录调试信息并吞掉异常；`failIfUnavailable` 与上层强制策略检查才决定是否停止执行。源码把诊断与强制拒绝放在两个控制点。

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

`wrapWithSandbox` 把命令改写为沙箱运行时可执行的字符串。`command` 是必填命令；`binShell` 可选，`undefined` 时交给底层管理器选择；`customConfig` 可选，用来覆盖部分 `SandboxRuntimeConfig`；`abortSignal` 可选，存在时可中止包装或初始化流程。沙箱已启用但初始化 Promise 缺失时会直接抛错，原命令保持未执行状态。

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

第一，每次执行都会创建新的 shell 进程，但它使用 Claude Code 保存的 cwd 状态。当前目录已经被外部删除时，代码会尝试回到启动时的 `originalCwd`；fallback 同样失效时返回 pre-spawn failure，进程创建随即终止。

第二，子进程环境由 `subprocessEnv()` 筛选和构造，再补上 `SHELL`、`GIT_EDITOR: 'true'`、`CLAUDECODE: '1'` 和 provider 的环境覆盖。

第三，主线程命令可以通过临时 cwd 文件把 `cd` 的结果写回会话状态；子 Agent 设置 `preventCwdChanges`，其目录变化只作用于子任务。命令结束后如果 cwd 跑到项目权限范围外，`BashTool.call` 还会调用 `resetCwdIfOutsideProject` 做恢复。这个机制维护会话 cwd，文件访问限制仍由沙箱负责。

## 超时、Abort 和后台运行具有不同终态

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

这两个函数都属于 `restored-src/src/utils/ShellCommand.ts` 的 `ShellCommandImpl`。`#handleTimeout(self)` 只接收当前实例：当 `shouldAutoBackground` 为真且注册了回调时，超时会请求后台化；否则杀死进程。`#abortHandler()` 读取 `AbortSignal.reason`：特殊值 `'interrupt'` 表示用户提交了新消息，此处保留进程，调用链有机会把它转成后台任务；其他 abort reason 则调用 `kill()` 杀进程树。

因此，至少要区分四种结果：

1. 前台正常结束，返回 exit code 和输出。
2. 超时后被杀，结果携带超时信息。
3. 超时、用户 `Ctrl+B` 或 assistant 运行预算触发后台化，命令继续运行并返回 task id。
4. 执行前已经 abort，根本不 spawn 子进程。

显式 `run_in_background: true` 会注册 `LocalShellTask`，把输出、取消和完成通知纳入任务状态；若后台任务被环境变量禁用，则继续以前台方式执行。后台化以后前台 timeout 会被清除，但输出文件仍有 size watchdog，避免持续追加占满磁盘。

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

映射成 `tool_result` 时，模型会拿到一段 preview 和持久化路径提示，之后可以用 Read 工具读取。复制、链接或 stat 失败时，代码保留已有 stdout preview，并省略完整输出可用性声明。输出裁剪只保护上下文和磁盘预算，命令权限仍在执行前单独判断。

## macOS、Linux、Windows 不能套用同一条结论

源码明确把平台差异写进了执行器。

在 macOS 上，沙箱运行时与日志监控走对应实现；在 Linux 和 WSL2 上，依赖检查会涉及 `bubblewrap`、`socat` 等工具，而且 Linux/WSL 的路径 glob 支持还有额外警告。WSL1 被明确列为不支持。也就是说，即使配置文本相同，底层可表达的文件和网络限制也不必完全相同。

Windows 原生平台使用独立的 `PowerShellTool` 和 PowerShell AST 解析器。它会检查动态命令名、`Invoke-Expression`、encoded command、下载执行链和提权参数；`powershellSecurity.ts` 在解析失败时回到 `ask`，Bash 的字符串拆分规则只服务 POSIX shell 路径。

更关键的是，原生 Windows 缺少 POSIX 沙箱运行时。`PowerShellTool.tsx` 同时在 `validateInput` 和 `call` 设置兜底：当企业策略开启 sandbox 且禁止 unsandboxed command 时，直接拒绝执行。Linux、macOS、WSL2 上的 PowerShell 则可以作为 native binary 进入现有沙箱；为了保留 `-NoProfile -NonInteractive`，沙箱内层会使用 `/bin/sh` 执行编码后的 `pwsh` 调用。

平台分支本身就是安全模型的一部分。

## 小结

回到开头的问题：为什么权限允许以后，Bash 还要继续解析、沙箱化并经过平台执行边界？因为 allow 只批准一次操作意图，后面的每一层仍在回答不同问题。

解析层尽量还原命令真实结构，权限层把结构映射到 allow、ask、deny，沙箱层限制进程能接触的资源，平台执行层处理 shell、cwd、环境、进程树、超时和取消，输出层再限制回填模型的内容规模。任何一层都不能单独提供完整安全。

可靠的阅读方法是沿输入到副作用的路径，确认每一层拦截对象、失败出口与降级条件。

## 留给下一篇的问题

从当前版本看来，为什么很多 PowerShell 脚本要到执行时才报错？

## 参考资料

- [Claude Code 沙箱机制](https://code.claude.com/docs/en/sandboxing)

- [Claude Code 权限配置](https://code.claude.com/docs/en/permissions)
