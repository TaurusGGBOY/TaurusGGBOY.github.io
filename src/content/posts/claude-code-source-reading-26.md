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

## 回答上一篇的问题

上一篇留下的问题是：

> 团队协作确定以后，Plan mode 与 Git worktree 如何把“先规划、再并行实现、最后安全合并”落到代码与工作区？

直接说结论：这不是一个开关完成的事情，而是两道边界配合完成的。

Plan mode 管的是**行为边界**。它把当前权限模式切到 `plan`，要求 Agent 先读代码、问问题、写计划，并通过 `ExitPlanMode` 把执行权交回用户或 team lead 审批。Git worktree 管的是**文件边界**。它给每个任务准备独立的目录、分支和 cwd，让几个 Agent 可以同时改代码，而不在同一个 working tree 里互相覆盖。

最后的“安全合并”也要先说清楚：这份 2.1.88 还原源码会创建、保留或删除 worktree，却没有在 worktree 生命周期里替你完成 `merge`、`rebase` 或冲突处理。也就是说，它负责把并行修改隔开，并保留可审查的分支；审查、合并和冲突解决仍然属于后续 Git 流程。

如果把整条链路压缩成一句话，就是：

> Plan mode 决定什么时候可以动手，worktree 决定去哪里动手，Git 审查与合并决定这些改动什么时候进入主线。

## 两种隔离，解决的是两个不同问题

假设一个 team lead 把三个子任务分给三个 teammate：一个改 API，一个补测试，一个更新文档。如果三个 Agent 都直接在同一个目录里工作，即使任务拆分得很合理，也会遇到几个现实问题：

1. 一个 Agent 的未提交修改会进入另一个 Agent 的 `git status`；
2. 两个 Agent 同时改同一文件时，后写入者可能覆盖前面的工作；
3. 测试和格式化看到的是一个不断变化的混合工作区；
4. 任务失败以后，很难判断哪些文件属于哪个 Agent。

Worktree 解决的是这些目录和分支层面的问题。但它不回答“方案是否正确”“用户是否同意”“现在能不能执行”。这些问题由 Plan mode 的状态和审批链处理。

反过来也一样。Plan mode 能让 Agent 先探索再提交计划，却不会自动创建独立目录。如果多个已获批准的任务仍在同一 working tree 里执行，文件冲突并不会因为计划写得好而消失。

![Plan mode 与 Git worktree 的双重隔离流程](/images/posts/claude-code-source-reading-26/26-plan-mode-worktrees-handdrawn.png)

这张图要注意两条线之间没有直接箭头。Plan mode 和 worktree 可以组合使用，但源码并没有把“进入计划模式”定义成“自动创建 worktree”。它们是两套机制，在更高层工作流里协作。

本文仍然只讨论仓库中从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的代码。下面的源码块会省略与当前机制无关的参数、UI 分支和实验逻辑。

## Plan mode 不是一份 Markdown，而是一段权限状态

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

`prePlanMode` 是可选字段，`undefined` 表示没有待恢复的进入前模式。进入 Plan mode 时它记录原来的 `PermissionMode`，退出时用来恢复；恢复完成后又被清成 `undefined`。因此 Plan mode 不是简单的布尔值，它还要记住“从哪里进来”。

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

`_input` 没有业务字段，前导下划线表示这里不使用输入。`context` 提供 `agentId`、读取 AppState 的 `getAppState()` 和更新状态的 `setAppState()`。当 `agentId` 有值时，调用直接报错，因此普通 agent context 不能靠这个工具自行进入 Plan mode。

`applyPermissionUpdate` 收到的更新固定为 `type: 'setMode'`、`mode: 'plan'`、`destination: 'session'`。这里的 `session` 表示只更新本次会话状态，不是把它写成用户或项目的长期默认配置。

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

省略的 `auto` 分支会根据 `TRANSCRIPT_CLASSIFIER` 和 `shouldPlanUseAutoMode()` 决定是否启停 auto mode、剥离或恢复危险规则。还有一个明确边界：如果进入前是 `bypassPermissions`，中途不会激活 auto。换句话说，`prePlanMode` 不只是为了 UI 显示，它参与退出恢复和 auto/bypass 的安全转换。

### 只读意味着什么：提示词边界加工具权限，而不是“进程被冻结”

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

这段源码也揭示了一个容易说错的地方：Plan mode 的“只读”首先是一条高优先级模型指令，并不是把整个 Node/Bun 进程挂成只读文件系统。工具仍然有各自的 `isReadOnly()`、`validateInput()` 和 `checkPermissions()`，权限引擎也仍然计算 allow、ask、deny。计划文件还是一个刻意保留的写入例外。

因此，准确的说法应该是：Claude Code 通过**计划模式提示词、工具自身契约和权限上下文**共同限制执行，而不是依赖一个全局的文件系统锁。

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

`currentMode` 来自当前 AppState；只有它不等于 `plan` 时才执行切换。命令的 `args` 还支持 `open`：已经在 Plan mode 且计划存在时，用外部编辑器打开计划文件。其他非空描述会让 `onDone` 设置 `shouldQuery: true`，继续发起一轮查询。

这说明 `/plan` 和 `EnterPlanMode` 不是两种互不相干的实现。入口不同，最后都落到 `prepareContextForPlanMode()`、`applyPermissionUpdate()` 和 session 级 `plan` 状态。

## 退出计划：普通会话问用户，teammate 问 leader

计划写完并不等于可以执行。`ExitPlanModeV2Tool` 把“计划完成”和“获准执行”分成两个步骤。

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

`input` 是规范化后的 ExitPlanMode 输入，原样放入 `updatedInput`；`context` 在这段实现里没有被使用。普通会话返回 `ask`，必须经过用户确认。Teammate 返回 `allow`，不是说它可以绕过团队审批，而是避免在 teammate 本地弹出权限 UI；需要强制计划审批的 teammate 会在 `call()` 中写入 `plan_approval_request` 到 team lead mailbox，并进入等待状态。

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

`restoreMode` 优先使用 `prePlanMode`；若它是 `undefined`，回退到 `default`。源码还会处理 auto gate 被关闭的情况：即使 `prePlanMode` 是 `auto`，也可能因为 circuit breaker 或设置禁用而退回 `default`。最后把 `prePlanMode` 清空，避免下一次退出错误地复用旧状态。

到这里，Plan mode 只完成了一件事：让“可以开始执行”成为一个可观察、可审批的状态转换。它还没有为并行任务准备目录。

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

`slug` 是调用方给出的开放字符串，但约束很明确：总长度最多 64，每个 `/` 分段不能为空，只能含字母、数字、点、下划线和短横线，而且 `.`、`..` 被单独拒绝。`undefined` 和 `null` 不是合法参数类型；无名 worktree 的随机 slug 在更上层生成后，传到这里仍然是字符串。

这不是名字美化，而是路径安全。因为 slug 最终会进入 `.claude/worktrees/<slug>`，若允许绝对路径或 `..`，`path.join` 规范化后可能逃出 worktree 目录。

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

`slug` 的约束与上一节相同。返回值中只有 `worktreePath` 必定存在；`worktreeBranch`、`headCommit`、`gitRoot` 和 `hookBased` 都是可选字段。Hook 路径只返回目录和 `hookBased: true`，因为外部 VCS 不一定有 Git 分支或 commit 概念。没有 Hook 时才要求能找到 canonical Git root。

这里用 `findCanonicalGitRoot()` 而不是就近的 `findGitRoot()`。这样，即使父 Agent 已经运行在某个 session worktree 中，新子 Agent 的目录仍然创建在主仓库的 `.claude/worktrees/`，不会形成 worktree 套 worktree，周期清理也能找到它。

`getOrCreateWorktree()` 的关键 Git 参数是：

```ts
const addArgs = ['worktree', 'add']
if (sparsePaths?.length) addArgs.push('--no-checkout')

addArgs.push('-B', worktreeBranch, worktreePath, baseBranch)
await execFileNoThrowWithCwd(gitExe(), addArgs, { cwd: repoRoot })
```

`repoRoot` 是主仓库根目录，`worktreeBranch` 为 `worktree-<flattened slug>`，`worktreePath` 位于 `.claude/worktrees/`，`baseBranch` 通常是本地已有的 `origin/<defaultBranch>`；若远端引用不可用，源码会尝试 fetch，失败时才回退到 `HEAD`。可选的 `options.prNumber` 路径则以 `FETCH_HEAD` 为基线。

`sparsePaths` 来自 `settings.worktree?.sparsePaths`。它是可选字符串数组：`undefined` 或空数组表示完整 checkout；非空时先加 `--no-checkout`，再配置 cone 模式 sparse-checkout。若 sparse 设置或 checkout 失败，源码会强制移除刚注册的不完整 worktree，再抛错，避免下一次把空目录误判为可恢复会话。

`-B` 也值得注意。它不是“如果分支存在就报错”的 `-b`，而是允许重置遗留的孤儿临时分支，再把它指向本次基线。这适合可恢复的临时 worktree，但也解释了为什么 slug 必须被严格管理。

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

并行 Agent 结束以后，最危险的操作不是“保留太多临时目录”，而是“把还含有工作成果的目录删掉”。因此源码的清理判断倾向于保守。

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

这段摘自 `restored-src/src/utils/worktree.ts`，只省略了换行，没有改动判断条件。`worktreePath` 是待检查目录，`headCommit` 是创建时记录的基线 commit，二者都为必填字符串。

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

源码中的 `performPostCreationSetup()` 甚至会主动传播 `settings.local.json`、配置共享 Git hooks，并按设置处理符号链接或 `.worktreeinclude` 文件。这些行为提升了新工作区的可用性，也说明 worktree 从来不是容器或虚拟机级别的沙箱。

更关键的是合并边界。`createWorktreeForSession()`、`keepWorktree()`、`cleanupWorktree()`、`EnterWorktreeTool` 和 `ExitWorktreeTool` 负责的是：

- 建立独立目录与临时分支；
- 切换并恢复 cwd；
- 保存或清除 session metadata；
- 在删除前检查未提交修改和新 commit；
- 让用户选择保留还是移除。

这些路径没有自动调用 `git merge`、`git rebase` 或 `git cherry-pick`。因此，“最后安全合并”的正确流程应当是：先让每个 worktree 产生边界清楚的 diff/commit，再由协调者按顺序审查并合并；一旦两个分支修改相同上下文，仍要使用 Git 的正常冲突解决流程，并重新运行测试。

## 把两套机制组合成一条工程流程

现在回到开头的团队协作场景。一条比较完整的执行顺序是：

1. Team lead 或主 Agent 进入 Plan mode，读取代码并确认任务边界；
2. 计划写入唯一允许编辑的 plan file；
3. 普通会话通过用户审批退出，plan-required teammate 通过 mailbox 等待 leader 审批；
4. 获批后，为可并行的任务创建独立 worktree，让每个 Agent 在自己的 cwd 和分支执行；
5. Agent 结束时，无变化的临时 worktree 可以清理，有变化的分支保留；
6. 协调者逐个检查 diff、测试和 commit，再按依赖顺序合并；
7. 发生冲突时回到 Git 层处理，而不是让 worktree 生命周期猜测哪个改动正确。

这里有一个很实用的判断标准：任务如果只是“并行阅读”，通常不需要 worktree；任务如果要写文件，worktree 才提供真正的目录隔离。类似地，一个一行 typo 未必值得进入复杂 Plan mode；但跨模块改造、权限变更或多个 Agent 协作时，先计划再执行可以让审批点和失败边界更清楚。

## 小结

Plan mode 和 worktree 的共同点，是把原本隐含的工程约束变成显式状态。

Plan mode 用 `mode: 'plan'`、`prePlanMode`、只读 reminder、plan file 和 `ExitPlanMode` 审批链，回答“现在能不能行动”。Worktree 用经过验证的 slug、独立目录、临时分支、cwd 切换和保守清理，回答“行动发生在哪里”。

两者组合以后，Claude Code 能把“先规划、再并行实现”落到代码与工作区；但源码没有把合并正确性包办掉。独立 worktree 减少的是执行时互相覆盖，不能消除合并时的代码冲突、共享服务冲突和错误设计。最后仍然需要审查、测试和按依赖顺序合并。

## 留给下一篇的问题

当本地工具还不够用时，Claude Code 如何通过 MCP 发现外部服务器、加载工具与资源，并把调用接回权限和消息链？

