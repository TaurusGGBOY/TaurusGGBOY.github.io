---
title: "Claude Code源码解读25：多个智能体如何协作与协调"
published: 2026-07-24T16:47:12+08:00
updated: 2026-07-24T16:47:12+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-25/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：Claude Code 中手动创建 sub-agent 的适用时机和最佳实践是什么？

先把“手动创建”分成两种动作：**一次性委派**和**定义可复用的角色**。前者是在当前任务里明确指定一个 sub-agent 去完成副任务；后者是在 `.claude/agents/` 或 `~/.claude/agents/` 写下稳定的 `AgentDefinition`，让以后遇到同类任务时可以重复使用。一次性工作不必为了“看起来专业”先写一个配置文件；只有角色、工具边界和提示词会反复出现时，才值得把它固化下来。

### 什么时候适合手动创建

我会用下面这个判断：**任务能否被交代成一个相对独立的交付物？** 如果答案是肯定的，而且主线程只需要结论、补丁或一份验证报告，就适合委派。例如：

- 大量搜索、读日志、跑测试或查文档。噪声留在子 Agent 的上下文里，主线程只接收失败用例、证据路径和结论；
- 一个清楚的专项审查，如只读检查认证、性能、依赖升级或测试覆盖率；
- 几条互不依赖的研究路线，可以分别交给不同 Agent，最后由主线程综合；
- 需要独立的工具或权限边界，例如研究 Agent 只允许 `Read`、`Grep`、`Glob`、`Bash`，实现 Agent 才允许写文件；
- 任务会持续较久，但主线程可以继续工作。此时可用 `run_in_background: true`，把完成结果作为通知重新交给父线程。

反过来，以下情况留在主线程通常更快：任务很小、需要频繁来回确认、计划—实现—测试共享大量即时上下文，或者多个执行者会同时改同一文件。Anthropic 的多 Agent 实践也提醒，依赖密集的编码任务并不天然适合拆分；并发会带来额外 token、协调和合并成本，不是 Agent 数量越多越好。

### 一次性委派的提示词要像交接单

不要只写“去看看这个模块”。交接至少应包含五项：目标、范围、已知事实、禁止事项、交付格式。例如：

```text
请只读审查 src/auth/ 的 token 校验。
不要修改文件；关注过期、重放和错误处理。
返回：问题分级、文件与行号、复现或验证命令、仍未确认的风险。
```

这份交接单同时解决了三个问题：子 Agent 不会因为缺少父会话历史而猜错背景；多个 Agent 不会重复同一条路线；父 Agent 能按统一格式比较结果。Anthropic 的经验是，明确目标、工具、来源、边界和输出格式，比笼统地要求“研究一下”可靠得多。对于报告、代码或数据这类大结果，最好让子 Agent 把完整产物写到文件，只把路径和摘要交回父线程，避免多轮转述造成信息损失。

### 2.1.88 中哪些参数真正影响行为

`AgentTool` 的 `baseInputSchema` 要求 `description` 和 `prompt` 都是字符串；其中 `description` 的源码说明是简短的 3—5 个词。`subagent_type` 可以指定内置或自定义类型；省略时，在非 fork 路径会回退到 `general-purpose`。`model` 的静态可选值是 `sonnet | opus | haiku`，省略时沿用 Agent 定义或父会话的模型；`run_in_background` 是可选布尔值，严格为 `true` 才请求后台运行。

`call()` 随后按类型找到 `AgentDefinition`，组装它的 system prompt、模型、工具和权限上下文，再进入同一套 `runAgent() → query()` 循环。因此，手动委派时最重要的不是给 Agent 起一个花哨的名字，而是选对类型并把约束写清楚。自定义 Agent 的定义还可以声明 `tools`/`disallowedTools`、`permissionMode`、`maxTurns`、`skills`、`background` 和 `isolation: 'worktree'`。源码中的 `isReadOnly()` 只表示外层 Agent tool 把权限检查交给底层工具，并不意味着子 Agent 自动不能写文件；是否可写仍由它实际拿到的工具和权限决定。

### 前台、后台和 worktree 怎么选

- **前台**：结果马上用于下一步，或可能需要你回答权限/澄清问题；
- **后台**：任务独立、耗时、主线程可以继续，而且提示词已经足够完整。后台 Agent 如果遇到本应弹窗的权限请求会自动拒绝，所以不能把需要人工确认的步骤藏在后台；
- **worktree**：子 Agent 会修改代码，且你准备并行运行多个工作单元，或者它们可能碰到同一批文件。只读调查不必付出 worktree 的创建和合并成本。

如果任务需要成员之间共享任务列表、互相发消息并持续协调，那已经超出普通 sub-agent 的边界，应考虑 Agent Teams；如果只是多个独立副任务向同一个父线程回报，普通 sub-agent 更轻。多个会话各自改代码时，则优先使用 worktree 隔离，而不是依赖大家自觉避开同一文件。

### 最后一定由父 Agent 验收

`status: 'completed'` 只说明子 Agent 的执行循环结束，不等于结论正确。父 Agent 至少要检查返回的文件、行号和命令，必要时重新运行测试；写文件的任务还要查看 diff，确认没有越过范围。一个实用的返回格式是：**结论 → 证据 → 已执行的验证 → 未解决风险 → 可直接消费的产物路径**。这样手动创建 sub-agent 才是一次可审计的委派，而不是把上下文和责任一起丢出去。

本文后续仍回到仓库中由 `@anthropic-ai/claude-code@2.1.88` source map 还原的 `restored-src/`，继续解释当多个 Agent 同时存在时，Team config、Task list、Mailbox 和 Coordinator 如何把这些独立委派组织成一个团队。

## 问题现场

几个 sub-agent 同时返回结果，并不等于它们组成了一个团队。真正的协作还需要稳定身份、任务所有权、成员之间的消息路由，以及一个能判断“现在是否可以收敛”的协调者。

![Agent Team 的任务所有权、Mailbox 与收敛](/images/posts/claude-code-source-reading-25/25-team-convergence-detail-handdrawn.png)

本文把 Agent Teams 看成加在 subagent 之上的控制面：Team config 管身份，task list 管所有权，mailbox 管消息，Coordinator 负责把这些状态变成下一步调度。

## 团队在 subagent 之上增加持久协作控制面

上一篇的 subagent 是“交付一个副任务再回传”。Team 解决的是持续协作：成员要保持身份，领取不同工作，互相发送消息，并在一个任务结束后继续处理下一个任务。它因此需要一个独立于单次 `runAgent()` 的控制面：

- **Team**：一组成员的名册和共享命名空间，成员继续使用各自的上下文窗口；
- **Teammate**：有独立执行循环的成员，后端可以是同进程，也可以是 tmux 或 iTerm2 pane；
- **Task list**：协作待办表，状态只有 `pending | in_progress | completed`；第 23 篇的运行时 Task 则跟踪执行实例；
- **Mailbox**：按成员路由的异步信箱，既承载自然语言消息，也承载 shutdown、plan approval、permission 等结构化协议。

Coordinator 执行拆分、分配、观察、综合和收敛，但不替 worker 阅读代码或提交修改。它消费的是 task 状态和 mailbox 消息，而不是把成员的全部上下文拼进自己的 prompt。

![Claude Code Agent Teams、共享控制面与 Coordinator 收敛流程手绘图](/images/posts/claude-code-source-reading-25/25-agent-teams-coordinator-handdrawn.png)

图里的三条箭头不能混在一起看。橙色是任务所有权，青色是消息路由，黑色是状态与完成信号。一个成员收到消息，不代表任务 owner 已经改变；一个 task 标记 completed，也不代表它的结论已经被 Coordinator 理解并写进最终答复。

底部的 `in-process | tmux | iTerm2` 是执行后端。它决定成员在哪里运行、如何展示和终止，不改变 Team config、Task list、Mailbox 这三层协作契约。

## YNM-9527 需要一个小型 Agent Team

用户输入：

> 把金额计算、回调解析和前端复现分别交给三个 teammate；让他们互发进度，最后由 lead 汇总并验收。

Claude Code 先建立 Team config 和共享命名空间，再创建成员身份与任务项。成员通过 mailbox 传递业务结果和控制消息，lead 根据测试、依赖和冲突决定哪些结果可以合并；这不是三次短暂的 Agent 调用，而是一组有持久协作状态的执行者。

下面从 Team config 开始，追踪身份、任务列表、Mailbox 和 coordinator 如何把同一事故收敛起来。

## 第一层：Team config 先建立身份和共享命名空间

Agent Teams 的运行资格由 `restored-src/src/utils/agentSwarmsEnabled.ts` 中的集中守卫决定：

```ts
export function isAgentSwarmsEnabled(): boolean {
  // Ant: always on
  if (process.env.USER_TYPE === 'ant') {
    return true
  }

  // External: require opt-in via env var or --agent-teams flag
  if (
    !isEnvTruthy(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) &&
    !isAgentTeamsFlagSet()
  ) {
    return false
  }

  // Killswitch — always respected for external users
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_flint', true)) {
    return false
  }

  return true
}
```

**函数说明：** `isAgentSwarmsEnabled()` 是 TeamCreate、SendMessage、TaskUpdate 的团队增强逻辑和相关 UI 共用的运行时开关。内部用户直接启用；外部用户必须显式 opt-in，并且仍受远端 killswitch 控制。

**参数说明：** 函数签名为空参。`USER_TYPE === 'ant'` 是源码中的内部用户分支；外部 opt-in 可以来自环境变量 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 的 truthy 值，或命令行布尔标志 `--agent-teams`。GrowthBook 值的静态回退是 `true`，但运行时远端配置可以返回 `false`。

**字段说明：** `USER_TYPE` 区分内部 `ant` 与外部路径；外部路径先组合 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 和 `isAgentTeamsFlagSet()`，再读取 `tengu_amber_flint` killswitch。代码注释里的 `Ant`、`External` 只是分支标签。

启用之后，`TeamCreateTool.call()` 才创建真正的团队边界。核心代码位于 `restored-src/src/tools/TeamCreateTool/TeamCreateTool.ts`：

```ts
const existingTeam = appState.teamContext?.teamName

if (existingTeam) {
  throw new Error(
    `Already leading team "${existingTeam}". A leader can only manage one team at a time. Use TeamDelete to end the current team before creating a new one.`,
  )
}

const finalTeamName = generateUniqueTeamName(team_name)
const leadAgentId = formatAgentId(TEAM_LEAD_NAME, finalTeamName)
const leadAgentType = agent_type || TEAM_LEAD_NAME
```

**函数说明：** 这段来自 `TeamCreateTool.call()` 的入口。它先阻止一个 leader 同时领导两个团队，再解析最终团队名与 lead 身份。函数后续建立三样东西：磁盘上的 team file、以团队名隔离的 task list，以及主进程中的 `AppState.teamContext`。team file 供不同进程发现成员；`teamContext` 供当前 UI、工具和 inbox poller 快速读取；task list 则从编号 1 开始承载本轮协作工作。

**参数说明：** 输入里的 `team_name` 是必填字符串，空白会在 `validateInput()` 中以 `errorCode:9` 拒绝；`description` 是 `string | undefined`，省略时 team file 中对应字段保持 `undefined`；`agent_type` 也是可选字符串，省略时 lead 的类型回退为 `team-lead`。同名 team file 已存在时，源码会生成新的 word slug。一个 leader 同时已有 `teamContext.teamName` 时直接报错，必须先删除旧团队。

这一步说明 Team 是一组可以被跨进程重新发现的身份数据。lead ID 由 `team-lead@teamName` 形式确定；成员还记录模型、cwd、加入时间、pane ID、backend type 等信息。

## 第二层：成员后端可以不同，协作协议保持不变

创建团队后，`spawnTeammate()` 进入共享的 spawn 模块，在内部完成后端选择：

```ts
async function handleSpawn(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  if (isInProcessEnabled()) {
    return handleSpawnInProcess(input, context)
  }

  try {
    await detectAndGetBackend()
  } catch (error) {
    if (getTeammateModeFromSnapshot() !== 'auto') {
      throw error
    }
    markInProcessFallback()
    return handleSpawnInProcess(input, context)
  }

  const useSplitPane = input.use_splitpane !== false
  if (useSplitPane) {
    return handleSpawnSplitPane(input, context)
  }
  return handleSpawnSeparateWindow(input, context)
}
```

**函数说明：** `handleSpawn()` 负责选择 teammate 的执行容器。明确启用 in-process 时直接同进程运行；否则检测 pane backend；只有 `auto` 模式下后端不可用才静默回退到 in-process。后端可用后，默认 split pane，显式关闭才使用独立窗口。

**参数说明：** `input.name` 与 `input.prompt` 必填；`team_name` 可以省略并从 leader 的 `teamContext` 继承；`cwd` 省略时回退当前目录；`use_splitpane` 是 `boolean | undefined`，只有严格等于 `false` 才关闭 split pane；`plan_mode_required` 省略时按 `false`；`model` 可为开放模型名、`'inherit'` 或 `undefined`，`'inherit'` 跟随 leader，`undefined` 走 teammate 默认模型逻辑；`agent_type` 和 `description` 都允许省略。`context` 提供 AppState、权限上下文、Agent 定义和当前 `toolUseId`，类型排除 `null`。

**字段说明：** `handleSpawn()` 返回对象的 `data` 是统一 `SpawnOutput`。`useSplitPane` 由 `input.use_splitpane !== false` 计算；为真调用 `handleSpawnSplitPane()`，为假调用 `handleSpawnSeparateWindow()`。`markInProcessFallback()` 记录 auto 模式的降级，再由 `handleSpawnInProcess()` 返回同形结果。

in-process teammate 通过 AsyncLocalStorage 隔离身份和上下文；pane teammate 则启动新的 Claude Code 进程。两条路径最终都会：

1. 生成并清洗成员名与 `agentId`；
2. 把成员写进 `teamContext.teammates`；
3. 把成员追加到 team file；
4. 注册一个 `in_process_teammate` 运行时 Task，供 UI、取消和状态观察；
5. 交付第一条 prompt——in-process 直接传给 runner，pane 模式写进 mailbox。

最后一点很重要。源码明确禁止给 in-process teammate 再写一次初始 mailbox，否则同一条任务会执行两遍。统一协作协议允许各后端采用不同的启动细节。

## 第三层：Task list 把“讨论”变成明确所有权

协作还需要明确 owner 和依赖关系，否则多个 Agent 很容易重复读取同一批文件或同时修改同一资源。

TeamCreate 把团队名注册为 `taskListId` 后，leader 和 teammate 会解析到同一个目录。`restored-src/src/utils/tasks.ts` 的优先级很明确：

```ts
export function getTaskListId(): string {
  if (process.env.CLAUDE_CODE_TASK_LIST_ID) {
    return process.env.CLAUDE_CODE_TASK_LIST_ID
  }
  // In-process teammates use the leader's team name so they share the same
  // task list that tmux/iTerm2 teammates also resolve to.
  const teammateCtx = getTeammateContext()
  if (teammateCtx) {
    return teammateCtx.teamName
  }
  return getTeamName() || leaderTeamName || getSessionId()
}
```

**函数说明：** `getTaskListId()` 把同进程成员、外部 pane 成员和 leader 统一映射到同一个协作任务目录。脱离团队时，它才回退到 session ID，因此普通单会话也能使用 Task 工具而不与其他会话混写。

**参数说明：** 函数签名为空参。显式环境变量优先级最高；`getTeammateContext()` 可能返回 `undefined`，表示当前位于普通线程；`getTeamName()`、模块级 `leaderTeamName` 也可能为 `undefined`，最终 `getSessionId()` 是回退值。task list ID 会经过路径清洗，任意字符串中的非字母、数字、连字符和下划线都会被替换，因此它是存储标识。

Task 的数据结构也刻意很小：标题、描述、owner、状态，以及 `blocks/blockedBy`。`TaskCreateTool.call()` 默认创建无人领取的 pending task：

```ts
const taskId = await createTask(getTaskListId(), {
  subject,
  description,
  activeForm,
  status: 'pending',
  owner: undefined,
  blocks: [],
  blockedBy: [],
  metadata,
})
```

**函数说明：** `TaskCreateTool.call()` 先持久化任务，再运行 TaskCreated hooks；如果 hook 返回 blocking error，它会删除刚创建的 task 并把错误抛回工具调用。`createTask()` 在 task-list 级文件锁内读取高水位、分配递增 ID 并写 JSON，避免多个 Agent 同时创建出相同编号。

**参数说明：** `subject`、`description` 是必填开放字符串；`activeForm` 仅在有值且任务进入 `in_progress` 时提供 UI 文案；`metadata` 有值时保存调用方附加的开放键值。初始 `owner: undefined` 使任务保持待领取状态，后续 `TaskUpdate` 或 `claimTask()` 才写入成员身份；初始状态固定为 `'pending'`。协作状态可取 `'pending' | 'in_progress' | 'completed'`，不要与运行时 Task 的 `running/failed/killed` 混用。

**字段说明：** `taskId` 接收 `createTask()` 分配的递增 ID；传入对象的 `subject`、`description`、`activeForm`、`metadata` 保存任务内容，`status` 初始为 `'pending'`，`owner` 初始为 `undefined`，`blocks` 与 `blockedBy` 都从空数组开始。

分派通过 `TaskUpdate` 写 owner。成员自己把状态改为 `in_progress` 且省略显式 owner 时，工具还会自动填入当前 agent name；owner 改变后，系统额外向新 owner 的 mailbox 写入 `task_assignment`。共享状态与及时提醒由两个连续写操作完成。

如果成员要主动领取下一项工作，底层 `claimTask()` 会做更严格的检查：

```ts
export type ClaimTaskResult = {
  success: boolean
  reason?:
    | 'task_not_found'
    | 'already_claimed'
    | 'already_resolved'
    | 'blocked'
    | 'agent_busy'
  task?: Task
  busyWithTasks?: string[]
  blockedByTasks?: string[]
}

export type ClaimTaskOptions = {
  checkAgentBusy?: boolean
}
```

**函数说明：** 这两个类型是 `claimTask()` 的可选控制项与结果契约。函数在锁内重新读取任务，依次拒绝不存在、已被他人领取、已经完成和仍被未完成任务阻塞的情况。`checkAgentBusy=true` 时改用整个 task list 的锁，把“该 Agent 是否已有开放任务”和“领取新任务”放在同一个临界区，避免两个并发领取都认为成员空闲。

**参数说明：** `taskListId`、`taskId`、`claimantAgentId` 都是必填字符串；`options` 默认 `{}`，其中 `checkAgentBusy` 是 `boolean | undefined`，只有 truthy 才启用忙碌检查。失败原因是源码可确认的联合值：`'task_not_found' | 'already_claimed' | 'already_resolved' | 'blocked' | 'agent_busy'`；成功时 `task` 有值，失败时 `task`、`busyWithTasks`、`blockedByTasks` 是否存在取决于具体原因，不应用 `null` 猜测补齐。

**字段说明：** `ClaimTaskResult.success` 表示领取是否成功，失败时 `reason` 给出联合类型中的具体原因；`task` 保存成功领取的任务，`busyWithTasks` 与 `blockedByTasks` 分别列出占用成员的任务和未完成依赖。`ClaimTaskOptions.checkAgentBusy` 控制是否启用成员忙碌检查。

锁只解决单个临界区竞争。比如 `blockTask()` 要分别更新 A 的 `blocks` 和 B 的 `blockedBy`；`TaskUpdate` 先改 owner，再写 assignment mailbox。进程若在两个步骤之间退出，磁盘上可能出现短暂不一致。这就是图中“files + locks, not a transaction”的含义。

## 第四层：Mailbox 同时传业务消息和控制协议

Task list 适合保存稳定状态，不适合表达“请多看一下这个边界”“停止当前方向”“你的 plan 已批准”。这些增量信息进入 Mailbox。

`SendMessageTool` 同时接受普通字符串与结构化控制消息：

```ts
const StructuredMessage = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('shutdown_request'),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('shutdown_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('plan_approval_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      feedback: z.string().optional(),
    }),
  ]),
)
```

**函数说明：** `StructuredMessage()` 是 `SendMessageTool` 输入 schema 中的控制消息分支。普通字符串走 direct message 或 broadcast；这里的结构化对象走 shutdown/plan approval 控制分支。工具会把发送者、时间戳、颜色和可选摘要写入目标成员 mailbox，并把路由信息映射回 tool result。

**参数说明：** `to` 必填：普通团队内可以是裸 teammate name，`'*'` 表示广播；包含 `@` 会被拒绝，因为一个 session 只对应一个 team。`summary` 为 `string | undefined`，普通团队字符串消息要求非空摘要；UDS/Bridge 构建分支有不同规则。`message` 要么是字符串，要么是三种结构化类型之一。`approve` 使用语义布尔解析；拒绝 shutdown 时 `reason` 必填；拒绝 plan 时 `feedback` 省略会回退为 `'Plan needs revision'`。结构化消息不能广播。

**字段说明：** `StructuredMessage` 用 `type` 区分 `shutdown_request`、`shutdown_response`、`plan_approval_response`。前者携带可选 `reason`；后两者都要求 `request_id` 与 `approve`，其中 shutdown 响应使用可选 `reason`，plan 响应使用可选 `feedback`。

读取端还要解释消息协议。在内部用户分支中，`getTeammateMailboxAttachments()` 会合并 file mailbox 与 `AppState.inbox`，按 `from + timestamp + text prefix` 去重，并把同一成员的多条 idle notification 折叠为最新一条。普通消息先构造成 attachment，再标记已读，避免中途失败导致丢消息；permission、shutdown 等结构化协议则留给 `useInboxPoller` 的专门 handler。该 attachment bridge 在 `USER_TYPE !== 'ant'` 时直接返回空数组；静态源码只能把这条路径确认为内部构建的读取入口。

in-process teammate 空闲后仍不会退出。`waitForNextPromptOrShutdown()` 每 500ms 检查内存 pending message、文件 mailbox 和可领取 task；优先级是 shutdown request、team-lead 消息、其他成员 FIFO 消息，最后才尝试从 task list 自动领取：

```ts
// No shutdown request found. Prioritize team-lead messages over peer
// messages — the leader represents user intent and coordination, so their
// messages should not be starved behind peer-to-peer chatter.
// Fall back to FIFO for peer messages.
let selectedIndex = -1

for (let i = 0; i < allMessages.length; i++) {
  const m = allMessages[i]
  if (m && !m.read && m.from === TEAM_LEAD_NAME) {
    selectedIndex = i
    break
  }
}

if (selectedIndex === -1) {
  selectedIndex = allMessages.findIndex(m => !m.read)
}
```

**函数说明：** `waitForNextPromptOrShutdown()` 是 in-process teammate 的待机循环。成员完成一轮后保持可继续使用，下一项 task 可复用同一 Agent。shutdown 被优先扫描，避免被大量 peer 消息饿死；team-lead 消息优先于 peer 消息，体现用户意图的控制优先级。

**参数说明：** `identity` 包含 `agentName/teamName/color/planModeRequired` 等成员身份；`abortController` 被触发后返回 `{type:'aborted'}`；`taskId` 指向运行时 `in_process_teammate` Task，用于读取内存待办消息；`getAppState/setAppState` 访问共享状态；`taskListId` 决定自动领取哪个任务目录。500ms 是静态源码常量。返回联合值还包括 `new_message` 与 `shutdown_request`；一次 mailbox 读取失败只记录日志并继续轮询。

## Coordinator 是受工具白名单约束的综合器

普通 team-lead 可以使用 TeamCreate、TaskUpdate、SendMessage 组织团队。Coordinator mode 更进一步：它把“主会话只做协调”写进系统提示词，并从工具池中删掉不属于协调职责的工具。

`restored-src/src/utils/toolPool.ts` 的过滤逻辑很短：

```ts
export function applyCoordinatorToolFilter(tools: Tools): Tools {
  return tools.filter(
    t =>
      COORDINATOR_MODE_ALLOWED_TOOLS.has(t.name) ||
      isPrActivitySubscriptionTool(t.name),
  )
}
```

**函数说明：** `applyCoordinatorToolFilter()` 保留 Coordinator 白名单工具，以及 PR 活动订阅/取消订阅工具。交互 REPL 与 headless 路径都通过同一过滤函数，避免一种入口能直接改代码、另一种入口却只能委派。

**参数说明：** `tools` 是已经合并、按名称去重并排序后的 Tool 数组；返回新的过滤数组。白名单来自静态常量，具体集合属于当前 2.1.88 构建边界；MCP 工具不会因为“是 MCP”就自动保留，只有名称满足 PR subscription 特例才通过。函数不接收 `mode` 或 `undefined`，是否调用它由外层 `feature('COORDINATOR_MODE') && isCoordinatorMode()` 决定。

`getCoordinatorSystemPrompt()` 进一步规定执行节奏：独立研究尽量并行，写同一组文件的工作串行，Coordinator 必须先理解研究结果，再给 worker 写出具体实现说明；验证最好交给新的 worker，以减少实现者的确认偏差。worker 结果以 `<task-notification>` 回到主会话，Coordinator 按内部信号处理。

这套模式解决的是职责漂移：如果 Coordinator 自己开始大量 Read/Edit/Bash，它就既做分派又做实现，团队成员的边界会逐渐失效。工具过滤让“只协调”从提示词建议变成能力边界。

Coordinator mode 与 Agent Teams 使用独立开关。`isCoordinatorMode()` 同时要求构建 feature `COORDINATOR_MODE` 和环境变量 `CLAUDE_CODE_COORDINATOR_MODE` 为 truthy；会话恢复时，`matchSessionMode('coordinator' | 'normal' | undefined)` 才会把当前环境调整到 transcript 记录的模式。旧会话省略 mode 字段时返回 `undefined`，保持当前模式。

## 收敛由任务依赖、验证结果和成员终态共同决定

多 Agent 最容易被低估的一步是收敛。成员发来 completed，只能证明某个执行路径结束。

Claude Code 提供了几类可组合信号：

- Task status 表示协作工作是 pending、in_progress 还是 completed；
- `idle_notification` 可以带 `available | interrupted | failed`，以及本轮 summary、completed task 和 failure reason；
- runtime Task 记录 teammate 是否 running、idle、awaiting plan approval 或 shutdown requested；
- Mailbox 允许 Coordinator 继续追问原成员，复用它已有的上下文；
- 成员退出时，`unassignTeammateTasks()` 会把它尚未完成的任务 owner 清空、状态重置为 pending，供其他成员重领。

因此一个可靠的收敛顺序是：先检查 task 依赖是否全部闭合，再读成员结果并解决冲突，然后安排独立验证；验证失败就把具体错误发回有上下文的成员；确认活动成员数量归零后，再走 shutdown 协议和 TeamDelete。

`TeamDeleteTool.call()` 会拒绝删除仍有 active non-lead member 的团队。成员优雅退出或被标记 inactive 后，才清理 team/task 目录、颜色分配、leader task-list 映射、`teamContext` 和 inbox。输入 schema 是严格空对象 `{}`，协议未提供 `force` 分支。

这条边界很有价值：**共享工作闭合、成员生命周期处理完成、控制面可以安全回收，三者共同构成团队完成条件。**

## 小结

Claude Code 的多 Agent 协作可以压成一句话：**成员独立执行，控制面共享事实，Coordinator 负责把事实变成决策。**

Team config 回答“谁在团队里”，Task list 回答“谁负责什么、被什么阻塞”，Mailbox 回答“新增信息和控制请求发给谁”。in-process、tmux 与 iTerm2 只是成员的执行容器，不改变这三层契约。文件锁保护关键领取与编号竞争；跨文件、跨 mailbox 的更新采用多步写入，因此失败、重复、退出与重派都必须成为正常控制流。

Coordinator 的价值也不在于比 worker 更会写代码。它要守住全局目标：让独立工作并行，让写冲突串行，理解研究结果后再分派实现，用新视角验证，处理部分失败，最后确认任务和成员都已闭合。

这才是 Agent Team 与“同时开几个聊天窗口”的区别：前者有身份、所有权、依赖、消息协议和终态；后者只有并发。

## 留给下一篇的问题

Agent Teams 中的 teammate 与用户通过 Agent tool 手动创建的 sub-agent 有什么区别？

## 参考资料

- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)

- [Dive into Claude Code：生产级 Agent 的设计空间](https://arxiv.org/abs/2604.14228)

- [Create custom subagents - Claude Code Docs](https://code.claude.com/docs/en/sub-agents)

- [Run agents in parallel - Claude Code Docs](https://code.claude.com/docs/en/agents)

- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
