---
title: "Claude Code源码解读26：Plan Mode 与 Worktree 如何隔离规划与执行"
published: 2026-07-24T16:47:13+08:00
updated: 2026-07-24T16:47:13+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-26/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 本章先建立三个概念

- **认知隔离**：Plan Mode 限制可产生的副作用，让模型先形成可审查方案。

- **文件系统隔离**：Git worktree 为并发实现提供独立工作目录和分支坐标。

- **阶段门**：从规划进入执行需要显式批准，清理工作区也由明确所有者负责。

![Plan Mode 与 Worktree 的两种隔离](/images/posts/claude-code-source-reading-26/26-two-isolations-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇留下的问题是：

> Agent Teams 中的 teammate 与用户通过 Agent tool 手动创建的 sub-agent 有什么区别？

先把名称说清楚：这里 Agent Teams 中的“agent”指 **teammate**，不是团队 lead；“手动创建的 sub-agent”指当前会话通过 `Agent` tool 普通路径委派出的子 Agent。二者都会拿到独立上下文去执行任务，但它们不是同一种生命周期。

直接说结论：**sub-agent 是一次有边界的委派，teammate 是团队控制面中的持久成员。** 前者完成副任务后把结果或摘要交回父 Agent；后者加入 team roster，围绕共享 task list 和 mailbox 工作，可以领取后续任务、接收其他成员的消息，并由 lead 统一观察和回收。自定义 `AgentDefinition` 只是角色配置，可能被两种路径复用，并不会改变运行实体的生命周期。

### 2.1.88 源码里的分流点

`AgentTool.call()` 同时接收 `prompt`、`subagent_type`、`description`、`model`、`run_in_background` 等普通委派参数，以及团队路径才会使用的 `name`、`team_name`、`mode`、`isolation` 和 `cwd`。当 `team_name` 显式提供，或调用上下文能够解析出团队名，并且提供了可寻址的 `name` 时，代码进入 `spawnTeammate()`；否则先解析 `AgentDefinition`，再走 `runAgent() → query()` 的普通 sub-agent 循环。

这两个分支的返回语义也不同：普通路径返回执行完成或后台启动的结果，父 Agent 负责消费结果；团队路径返回 `teammate_spawned`，带有 teammate 的 ID、名称和 team 名称，后续状态通过 team task 与 mailbox 继续流转。`name` 不是装饰字段，它让成员能够被 task owner、消息路由和 shutdown 协议准确寻址。

| 维度 | Agent tool 手动创建的 sub-agent | Agent Teams 中的 teammate |
| --- | --- | --- |
| 创建路径 | 解析 `subagent_type` 对应的 `AgentDefinition`，调用 `runAgent()` | 在团队上下文中用 `team_name + name` 进入 `spawnTeammate()` |
| 生命周期 | 完成一个清晰副任务后返回结果；需要更多工作时由父 Agent 再次委派 | 作为 team 成员保留身份，可继续收消息、领取任务并报告状态，最后由团队协议关闭 |
| 协调方式 | 父 Agent 收集结果、判断是否重试或综合；没有共享 team roster、task list 和 mailbox | 共享 team config、task list、mailbox；成员可直接联系 lead 或其他 teammate，任务也有 owner、依赖和终态 |
| 上下文 | 从任务提示开始的独立上下文，适合把搜索、审查等噪声隔离出去 | 同样拥有独立上下文，但成员身份和通信通道让它能跨多轮协作保留工作连续性 |
| 文件边界 | 默认仍可能在当前 cwd 写文件；需要时显式使用 `isolation: 'worktree'` | 团队控制面本身不等于文件隔离；要并行改代码仍应为成员准备 worktree 或明确文件所有权 |
| 成本与适用场景 | 协调开销较低，适合短小、低耦合、输出格式明确的任务 | token 和协调开销更高，适合多个相对独立、需要持续多步推进的任务 |

这个差别也解释了为什么“把几个 sub-agent 同时放到后台”不自动等于 Agent Teams：后台只是执行时机，不能凭空产生共享任务所有权、成员寻址和直接消息。反过来，Team 也不会替你解决文件冲突；多个 teammate 仍然写同一工作区时，必须靠 worktree、文件分工或串行合并控制风险。

Anthropic 对两类模式的实践区分与源码边界相互印证：orchestrator-subagent 适合清晰、短小、低耦合的结果，由父 Agent 负责综合；agent team 适合独立任务的持续推进，让 worker 在多轮工作中保持上下文并相互协调，但要承担更高的 token 和通信成本。因此选择标准不是“哪个更强”，而是任务是否需要持久身份和团队控制面。

最后再强调一个容易混淆的点：同一个自定义 Agent 定义可以作为 `subagent_type` 被普通路径使用，也可以作为 teammate 的角色模板；定义里的模型、工具和提示词描述“它是谁”，而 `spawnTeammate` 还是 `runAgent` 决定“它以什么协作关系存在”。本文后续仍以 `@anthropic-ai/claude-code@2.1.88` 的还原源码为边界，继续看 Plan mode 和 worktree 如何分别隔离行为与文件。

## 两种隔离，解决的是两个不同问题

假设一个 team lead 把三个子任务分给三个 teammate：一个改 API，一个补测试，一个更新文档。如果三个 Agent 都直接在同一个目录里工作，即使任务拆分得很合理，也会遇到几个现实问题：

1. 一个 Agent 的未提交修改会进入另一个 Agent 的 `git status`；
2. 两个 Agent 同时改同一文件时，后写入者可能覆盖前面的工作；
3. 测试和格式化看到的是一个不断变化的混合工作区；
4. 任务失败以后，很难判断哪些文件属于哪个 Agent。

Worktree 解决的是这些目录和分支层面的问题。但它不回答“方案是否正确”“用户是否同意”“现在能不能执行”。这些问题由 Plan mode 的状态和审批链处理。

反过来也一样。Plan mode 能让 Agent 先探索再提交计划，却不会自动创建独立目录。如果多个已获批准的任务仍在同一 working tree 里执行，文件冲突并不会因为计划写得好而消失。

![Plan mode 与 Git worktree 的双重隔离流程](/images/posts/claude-code-source-reading-26/26-plan-mode-worktrees-handdrawn.png)

这张图用两条独立线表示 Plan mode 和 worktree。两套机制可在更高层工作流里组合使用；进入计划模式本身不会自动创建 worktree。

本文仍然只讨论仓库中从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的代码。下面的源码块会省略与当前机制无关的参数、UI 分支和实验逻辑。

## Plan mode 用权限状态控制规划阶段

很多人第一次看到 Plan mode，会把它理解成“让模型先输出一个步骤列表”。这个理解少了一层：计划文本只是产物，真正控制流程的是 `ToolPermissionContext.mode`。

它的类型定义在 `restored-src/src/types/permissions.ts`，状态保存在 `ToolPermissionContext` 中：

```ts
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

export type InternalPermissionMode =
  | ExternalPermissionMode
  | 'auto'
  | 'bubble'

export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode
  prePlanMode?: PermissionMode
  // 其余字段省略
}>
```

`mode` 是当前权限模式。外部可见的取值包括 `default`、`acceptEdits`、`bypassPermissions`、`dontAsk` 和 `plan`；`auto` 只会在对应 feature 开启后进入运行时可选集合，`bubble` 是内部类型的一部分，却不在用户可配置的 `INTERNAL_PERMISSION_MODES` 中。

`prePlanMode` 是可选字段。进入 Plan mode 时它记录原来的 `PermissionMode`，退出时优先恢复该值；字段缺失时退出逻辑回退到 `default`，恢复完成后再次删除该字段，避免后续退出沿用旧模式。因此 Plan mode 还要保存“从哪里进来”。

### 进入时：先保存旧模式，再切到 `plan`

模型通过 `EnterPlanModeTool.call()` 进入计划模式。核心代码在 `restored-src/src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`：

```ts
async call(_input, context) {
  if (context.agentId) {
    throw new Error('EnterPlanMode tool cannot be used in agent contexts')
  }

  const appState = context.getAppState()
  handlePlanModeTransition(appState.toolPermissionContext.mode, 'plan')

  context.setAppState(prev => ({
    ...prev,
    toolPermissionContext: applyPermissionUpdate(
      prepareContextForPlanMode(prev.toolPermissionContext),
      { type: 'setMode', mode: 'plan', destination: 'session' },
    ),
  }))
}
```

`_input` 是未使用的空输入。`context` 提供 `agentId`、读取 AppState 的 `getAppState()` 和更新状态的 `setAppState()`。当 `agentId` 有值时，调用直接报错，因此普通 agent context 无法靠这个工具自行进入 Plan mode。

**字段说明：** `appState` 是 `context.getAppState()` 的快照，`appState.toolPermissionContext.mode` 提供转场起点；状态更新保留 `prev` 的其他字段，只把 `toolPermissionContext` 替换为准备并应用模式更新后的结果。

`applyPermissionUpdate` 收到的更新固定为 `type: 'setMode'`、`mode: 'plan'`、`destination: 'session'`。这里的 `session` 表示只更新本次会话状态，用户或项目的长期默认配置保持不变。

真正保存旧模式的是 `prepareContextForPlanMode()`，位置在 `restored-src/src/utils/permissions/permissionSetup.ts`：

```ts
export function prepareContextForPlanMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const currentMode = context.mode
  if (currentMode === 'plan') return context

  // auto 相关分支省略
  return { ...context, prePlanMode: currentMode }
}
```

`context` 是完整的工具权限上下文；返回值仍然是 `ToolPermissionContext`，所以调用者可以继续用统一的 permission update 处理。若 `currentMode` 已经是 `plan`，函数原样返回，避免重复进入时覆盖 `prePlanMode`。

省略的 `auto` 分支会根据 `TRANSCRIPT_CLASSIFIER` 和 `shouldPlanUseAutoMode()` 决定是否启停 auto mode、剥离或恢复危险规则。进入前为 `bypassPermissions` 时，中途不会激活 auto。`prePlanMode` 同时服务于 UI 显示、退出恢复和 auto/bypass 的安全转换。

### 只读意味着什么：提示词边界叠加工具权限

Plan mode 生效后，`getPlanModeV2Instructions()` 会向对话注入一段 system reminder。源码位于 `restored-src/src/utils/messages.ts`：

```ts
const content = `Plan mode is active. The user indicated that they do not
want you to execute yet -- you MUST NOT make any edits (with the exception
of the plan file mentioned below), run any non-readonly tools ...

## Plan File Info:
${planFileInfo}
You should build your plan incrementally by writing to or editing this file.
NOTE that this is the only file you are allowed to edit ...`
```

这里的 `planFileInfo` 会根据 `attachment.planExists` 生成两种内容：已存在时允许用 Edit 增量修改；不存在时要求用 Write 创建。`attachment.planFilePath` 是唯一允许编辑的计划文件路径。`planExists` 是布尔值，不存在 `null` 的第三种语义。

这段源码揭示了 Plan mode 的“只读”实现：高优先级模型指令约束行为，工具各自的 `isReadOnly()`、`validateInput()` 和 `checkPermissions()` 继续计算 allow、ask、deny；计划文件则是刻意保留的写入例外。

因此，Claude Code 通过**计划模式提示词、工具自身契约和权限上下文**共同限制执行。

### `/plan` 命令和模型工具走向同一状态

用户也可以通过 `/plan` 进入。`restored-src/src/commands/plan/plan.tsx` 中的命令分支复用了同一组状态函数：

```ts
if (currentMode !== 'plan') {
  handlePlanModeTransition(currentMode, 'plan')
  setAppState(prev => ({
    ...prev,
    toolPermissionContext: applyPermissionUpdate(
      prepareContextForPlanMode(prev.toolPermissionContext),
      { type: 'setMode', mode: 'plan', destination: 'session' },
    ),
  }))
}
```

`currentMode` 来自当前 AppState；值偏离 `plan` 时才执行切换。命令的 `args` 还支持 `open`：已经在 Plan mode 且计划存在时，用外部编辑器打开计划文件。其他非空描述会让 `onDone` 设置 `shouldQuery: true`，继续发起一轮查询。

**字段说明：** 更新对象保留 `prev`，并把 `toolPermissionContext` 写成 `prepareContextForPlanMode(prev.toolPermissionContext)` 经 `applyPermissionUpdate()` 处理后的值；更新描述中的 `type`、`mode`、`destination` 分别固定为 `'setMode'`、`'plan'`、`'session'`。

这说明 `/plan` 和 `EnterPlanMode` 共用 `prepareContextForPlanMode()`、`applyPermissionUpdate()` 和 session 级 `plan` 状态，只在入口层不同。

## 退出计划：普通会话问用户，teammate 问 leader

计划写完后还需取得执行许可。`ExitPlanModeV2Tool` 把“计划完成”和“获准执行”分成两个步骤。

它先校验当前是否真的处于 Plan mode：

```ts
async validateInput(_input, { getAppState, options }) {
  if (isTeammate()) return { result: true }

  const mode = getAppState().toolPermissionContext.mode
  if (mode !== 'plan') {
    return {
      result: false,
      message: 'You are not in plan mode ...',
      errorCode: 1,
    }
  }
  return { result: true }
}
```

`_input` 在这个校验阶段不使用。`getAppState` 用来读取最新权限模式，`options.mainLoopModel` 只进入省略的遥测字段。普通会话在 `mode !== 'plan'` 时返回 `result: false` 和 `errorCode: 1`，从而在展示审批对话框之前拒绝误调用。

**字段说明：** 校验失败对象还包含 `message`，成功与 teammate 快速路径都返回 `result: true`。

Teammate 是例外。注释说明 teammate 的 AppState 可能显示 leader 的模式，所以这里让它通过，后面再以 `isPlanModeRequired()` 判断是否需要 leader 批准。

接下来是权限分流：

```ts
async checkPermissions(input, context) {
  if (isTeammate()) {
    return { behavior: 'allow' as const, updatedInput: input }
  }
  return {
    behavior: 'ask' as const,
    message: 'Exit plan mode?',
    updatedInput: input,
  }
}
```

`input` 是规范化后的 ExitPlanMode 输入，原样放入 `updatedInput`；`context` 在这段实现里未使用。普通会话返回 `ask`，必须经过用户确认。Teammate 返回 `allow` 以跳过本地权限 UI；需要强制计划审批的 teammate 会在 `call()` 中写入 `plan_approval_request` 到 team lead mailbox，并进入等待状态。

**字段说明：** Teammate 分支返回 `behavior: 'allow'` 与 `updatedInput`；普通分支返回 `behavior: 'ask'`、提示 `message` 和同一份 `updatedInput`。该 allow 只跳过 teammate 本地权限弹窗，leader 审批由后续 mailbox 控制流承担。

批准后，普通会话才真正恢复进入前模式：

```ts
let restoreMode = prev.toolPermissionContext.prePlanMode ?? 'default'

return {
  ...prev,
  toolPermissionContext: {
    ...baseContext,
    mode: restoreMode,
    prePlanMode: undefined,
  },
}
```

**字段说明：** 状态更新保留 `prev`，并用 `toolPermissionContext` 写入恢复后的 `baseContext`；其中 `mode` 取 `restoreMode`，`prePlanMode` 设为 `undefined`，防止下次退出复用旧入口。

`restoreMode` 优先使用 `prePlanMode`；若它是 `undefined`，回退到 `default`。源码还会处理 auto gate 被关闭的情况：即使 `prePlanMode` 是 `auto`，也可能因为 circuit breaker 或设置禁用而退回 `default`。最后把 `prePlanMode` 清空，避免下一次退出错误地复用旧状态。

到这里，Plan mode 让“可以开始执行”成为一个可观察、可审批的状态转换；并行任务目录由独立的 worktree 机制准备。

## Worktree 为什么比复制目录可靠

Git worktree 允许同一个仓库同时检出多个 working tree。每个 worktree 有自己的 cwd、索引状态和当前分支，但共享底层 Git 对象库。相比直接复制一份项目目录，它有两个明显好处：

1. 不需要复制整个 `.git` 对象库；
2. 每个任务的改动天然落在可追踪的 Git 分支上。

Claude Code 2.1.88 把默认 worktree 放在主仓库的 `.claude/worktrees/` 下。分支名使用 `worktree-<slug>`。如果 slug 是 `user/feature`，源码会把 `/` 展平为 `+`，避免 Git ref 和嵌套目录出现 file/directory conflict。

### 创建前先验证 slug

`restored-src/src/utils/worktree.ts` 的第一道边界是 `validateWorktreeSlug()`：

```ts
const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/
const MAX_WORKTREE_SLUG_LENGTH = 64

export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) throw new Error(...)

  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') throw new Error(...)
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) throw new Error(...)
  }
}
```

`slug` 是调用方给出的开放字符串，但约束很明确：总长度最多 64，每个 `/` 分段不能为空，只能含字母、数字、点、下划线和短横线，而且 `.`、`..` 被单独拒绝。参数类型排除 `undefined` 和 `null`；无名 worktree 的随机 slug 在更上层生成后，传到这里仍然是字符串。

这些约束直接保护路径安全。slug 最终会进入 `.claude/worktrees/<slug>`，若允许绝对路径或 `..`，`path.join` 规范化后可能逃出 worktree 目录。

### 优先使用 Hook，否则回退到 Git

给 Agent 创建轻量 worktree 的入口是 `createAgentWorktree()`：

```ts
export async function createAgentWorktree(slug: string): Promise<{
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}> {
  validateWorktreeSlug(slug)

  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    return { worktreePath: hookResult.worktreePath, hookBased: true }
  }

  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) throw new Error(...)

  const result = await getOrCreateWorktree(gitRoot, slug)
  // 新建后的配置传播与恢复分支省略
  return { ...result, gitRoot }
}
```

`slug` 的约束与上一节相同。返回值中只有 `worktreePath` 必定存在；`worktreeBranch`、`headCommit`、`gitRoot` 和 `hookBased` 都是可选字段。Hook 路径只返回目录和 `hookBased: true`，因为外部 VCS 未必有 Git 分支或 commit 概念。Git 路径则要求找到 canonical Git root。

这里用 `findCanonicalGitRoot()` 定位主仓库根。即使父 Agent 已经运行在某个 session worktree 中，新子 Agent 的目录仍会创建在主仓库的 `.claude/worktrees/`，避免 worktree 嵌套并让周期清理能够定位它。

**字段说明：** 创建函数以 `cwd` 为搜索起点；Hook 成功时返回其 `worktreePath` 与 `hookBased: true`，Git 路径则在结果上补入 `gitRoot`。

`getOrCreateWorktree()` 的关键 Git 参数是：

```ts
const addArgs = ['worktree', 'add']
if (sparsePaths?.length) addArgs.push('--no-checkout')

addArgs.push('-B', worktreeBranch, worktreePath, baseBranch)
await execFileNoThrowWithCwd(gitExe(), addArgs, { cwd: repoRoot })
```

`repoRoot` 是主仓库根目录，`worktreeBranch` 为 `worktree-<flattened slug>`，`worktreePath` 位于 `.claude/worktrees/`，`baseBranch` 通常是本地已有的 `origin/<defaultBranch>`；若远端引用不可用，源码会尝试 fetch，失败时才回退到 `HEAD`。可选的 `options.prNumber` 路径则以 `FETCH_HEAD` 为基线。

**字段说明：** `addArgs` 从 `['worktree', 'add']` 开始，稀疏模式追加 `--no-checkout`，随后加入 `-B`、`worktreeBranch`、`worktreePath`、`baseBranch`；执行选项的 `cwd` 固定为 `repoRoot`。

`sparsePaths` 来自 `settings.worktree?.sparsePaths`。它是可选字符串数组：`undefined` 或空数组表示完整 checkout；非空时先加 `--no-checkout`，再配置 cone 模式 sparse-checkout。若 sparse 设置或 checkout 失败，源码会强制移除刚注册的不完整 worktree，再抛错，避免下一次把空目录误判为可恢复会话。

`-B` 允许重置遗留的孤儿临时分支，再把它指向本次基线。这适合可恢复的临时 worktree，也解释了为什么 slug 必须被严格管理。

### 进入新 cwd 后，依赖目录的缓存必须失效

用户在会话中调用 `EnterWorktreeTool` 时，创建目录后还会切换 cwd：

```ts
const slug = input.name ?? getPlanSlug()
const session = await createWorktreeForSession(getSessionId(), slug)

process.chdir(session.worktreePath)
setCwd(session.worktreePath)
setOriginalCwd(getCwd())
saveWorktreeState(session)
clearSystemPromptSections()
clearMemoryFileCaches()
getPlansDirectory.cache.clear?.()
```

`input.name` 是可选字符串；为 `undefined` 时回退到 `getPlanSlug()`。`createWorktreeForSession()` 的必填参数是 `sessionId` 和 `slug`，可选参数 `tmuxSessionName` 以及 `options.prNumber` 缺省时都是 `undefined`。

切换 cwd 之后，源码清理 system prompt、CLAUDE.md/memory 和 plans directory 的缓存。这一步很重要：文件目录隔离了，如果提示词仍拿着主工作区的缓存，Agent 看到的上下文和实际执行目录仍然会错位。

## 清理为什么要 fail-closed

并行 Agent 结束以后，误删仍含工作成果的目录风险最高，因此源码的清理判断倾向于保守。

`hasWorktreeChanges()` 同时检查未提交文件和新 commit：

```ts
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): Promise<boolean> {
  const { code: statusCode, stdout: statusOutput } =
    await execFileNoThrowWithCwd(gitExe(), ['status', '--porcelain'], {
      cwd: worktreePath,
    })
  if (statusCode !== 0) return true
  if (statusOutput.trim().length > 0) return true

  const { code: revListCode, stdout: revListOutput } =
    await execFileNoThrowWithCwd(
      gitExe(),
      ['rev-list', '--count', `${headCommit}..HEAD`],
      { cwd: worktreePath },
    )
  if (revListCode !== 0) return true
  if (parseInt(revListOutput.trim(), 10) > 0) return true

  return false
}
```

这段摘自 `restored-src/src/utils/worktree.ts`，只省略换行并保留全部判断条件。`worktreePath` 是待检查目录，`headCommit` 是创建时记录的基线 commit，二者都为必填字符串。

**字段说明：** 第一次 Git 调用返回 `statusCode` 与 `statusOutput`，并在 `cwd: worktreePath` 下执行；第二次返回 `revListCode` 与 `revListOutput`，计算 `${headCommit}..HEAD` 的 commit 数。任一 `code` 非零、`stdout` 显示改动或 commit 数大于 0，都返回 `true`。

返回 `true` 有三类情况：working tree 非空、有基线之后的新 commit，或者任意 Git 命令失败。

AgentTool 的清理策略因此很直接：Hook 创建的 worktree 因无法用 Git 可靠检测变化而总是保留；Git worktree 没变化才调用 `removeAgentWorktree()`，有变化则把 `worktreePath` 和 `worktreeBranch` 返回给上层，供后续审查和继续工作。

### 用户主动退出时，`keep` 和 `remove` 语义不同

`ExitWorktreeTool` 的输入 schema 把选择写得很明确：

```ts
z.strictObject({
  action: z.enum(['keep', 'remove']),
  discard_changes: z.boolean().optional(),
})
```

`action` 只有 `keep` 和 `remove` 两个取值。`keep` 会离开当前 worktree，但保留目录和分支；`remove` 会删除二者。`discard_changes` 是可选布尔值，默认相当于未提供；当 `action: 'remove'` 且检测到未提交文件、新 commit，或者检测结果未知时，只有显式传入 `true` 才允许继续删除。

还要注意它的作用域：`getCurrentWorktreeSession()` 必须有值。手工通过 `git worktree add` 创建的目录，或者上一次会话遗留但本次未恢复为 active session 的目录，不会被这个工具顺手删除。

这道边界和前面的自动清理形成了对照：自动清理在不确定时保留；用户明确要求删除时，也要再次给出 `discard_changes: true`，把可能丢失工作的选择变成显式输入。

## Worktree 隔离不了什么

到这里，我们已经能解释为什么 worktree 适合并行 Agent。但不要把“独立目录”扩大成“完全隔离的运行环境”。至少有四类资源仍可能共享：

1. 同一个数据库、开发服务器端口或云端测试环境；
2. 主仓库共享的 Git 对象和部分 Git 配置；
3. 通过符号链接复用的依赖目录；
4. 两个分支最终修改同一段代码时的合并语义。

源码中的 `performPostCreationSetup()` 还会主动传播 `settings.local.json`、配置共享 Git hooks，并按设置处理符号链接或 `.worktreeinclude` 文件。这些行为提升了新工作区的可用性；安全隔离仍由权限、沙箱或容器机制承担。

更关键的是合并边界。`createWorktreeForSession()`、`keepWorktree()`、`cleanupWorktree()`、`EnterWorktreeTool` 和 `ExitWorktreeTool` 负责的是：

- 建立独立目录与临时分支；
- 切换并恢复 cwd；
- 保存或清除 session metadata；
- 在删除前检查未提交修改和新 commit；
- 让用户选择保留还是移除。

这些路径负责创建、切换和清理 worktree；合并阶段需要显式调用 `git merge`、`git rebase` 或 `git cherry-pick`。可靠流程是先让每个 worktree 产生边界清楚的 diff/commit，再由协调者按顺序审查并合并；一旦两个分支修改相同上下文，仍要使用 Git 的正常冲突解决流程，并重新运行测试。

## 把两套机制组合成一条工程流程

现在回到开头的团队协作场景。一条比较完整的执行顺序是：

1. Team lead 或主 Agent 进入 Plan mode，读取代码并确认任务边界；
2. 计划写入唯一允许编辑的 plan file；
3. 普通会话通过用户审批退出，plan-required teammate 通过 mailbox 等待 leader 审批；
4. 获批后，为可并行的任务创建独立 worktree，让每个 Agent 在自己的 cwd 和分支执行；
5. Agent 结束时，无变化的临时 worktree 可以清理，有变化的分支保留；
6. 协调者逐个检查 diff、测试和 commit，再按依赖顺序合并；
7. 发生冲突时回到 Git 层，由审查与测试判断哪个改动正确。

这里有一个很实用的判断标准：任务如果只是“并行阅读”，通常不需要 worktree；任务如果要写文件，worktree 才提供真正的目录隔离。类似地，一个一行 typo 未必值得进入复杂 Plan mode；但跨模块改造、权限变更或多个 Agent 协作时，先计划再执行可以让审批点和失败边界更清楚。

## 小结

Plan mode 和 worktree 的共同点，是把原本隐含的工程约束变成显式状态。

Plan mode 用 `mode: 'plan'`、`prePlanMode`、只读 reminder、plan file 和 `ExitPlanMode` 审批链，回答“现在能不能行动”。Worktree 用经过验证的 slug、独立目录、临时分支、cwd 切换和保守清理，回答“行动发生在哪里”。

两者组合以后，Claude Code 能把“先规划、再并行实现”落到代码与工作区。独立 worktree 减少执行时互相覆盖；合并时的代码冲突、共享服务冲突和错误设计仍需通过审查、测试与依赖顺序处理。

## 留给下一篇的问题

当本地工具还不够用时，Claude Code 如何通过 MCP 发现外部服务器、加载工具与资源，并把调用接回权限和消息链？

## 参考资料

- [Claude Code Permission Modes](https://code.claude.com/docs/en/permission-modes)

- [Claude Code Worktrees](https://code.claude.com/docs/en/worktrees)

- [Subagents - Claude Code Docs](https://code.claude.com/docs/en/sub-agents)

- [Agent Teams - Claude Code Docs](https://code.claude.com/docs/en/agent-teams)

- [Multi-agent coordination patterns](https://claude.com/blog/multi-agent-coordination-patterns)

- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
