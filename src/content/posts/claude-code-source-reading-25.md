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

上一篇留下的问题是：单个 subagent 能够委派以后，Claude Code 如何把多个 Agent 组织成团队，并由 Coordinator 分派、同步和收敛工作？

答案先说：**Claude Code 没有把多个 Agent 塞进一个更大的对话历史，也没有用 Coordinator 逐 token 遥控每个成员。它建立了一个文件化的协作控制面：Team config 记录成员身份，Task list 记录工作所有权与依赖，Mailbox 传递普通消息和控制协议；Coordinator 负责拆分、分派、理解结果与决定终态。**

成员仍然各跑各的 query loop，各自拥有上下文、工具调用和权限状态。团队层只共享足够协作的信息。因此，`researcher` 可以在自己的上下文里读代码，`implementer` 可以处理另一组文件，`verifier` 可以独立验证；他们不需要互相复制整段 transcript，只需要在任务状态和邮箱中交换“谁做什么”“做到哪了”“接下来该怎么办”。

这里还要提前拆开两个容易混淆的词：**team-lead 是团队身份，Coordinator mode 是一种更严格的运行角色。** 普通 team-lead 处在 `teamContext` 中，可以拥有完整工具池；Coordinator mode 则会改写系统提示词并过滤工具，强迫主会话把研究、实现和验证交给 worker，自己主要做编排与综合。二者可以承担相似职责，但源码没有把它们写成同一个类型。

这就是本篇的主线：建队，生成成员，分配任务，通过邮箱同步，依据状态收敛，最后安全清理。本文仍以仓库中由 `@anthropic-ai/claude-code@2.1.88` source map 还原的 `restored-src/` 为边界。下面展示的都是短的真实源码片段，只省略与当前结论无关的字段、埋点和 UI 分支。

## 从 subagent 到团队，多出来的到底是什么

上一篇的 subagent 更像一次有边界的委派：父 Agent 给出目标，子 Agent 独立执行，再把结果交回父线程。团队解决的是另一个问题：**多个执行者如何在较长时间内保持身份，领取不同工作，相互发消息，并在一项工作结束后继续领取下一项。**

可以先用四个基础概念理解它：

- **Team**：一组成员的名册和共享命名空间，不是共享上下文窗口；
- **Teammate**：有独立执行循环的成员，后端可以是同进程，也可以是 tmux 或 iTerm2 pane；
- **Task list**：协作待办表，状态只有 `pending | in_progress | completed`，它不等于第 23 篇讲的运行时 Task；
- **Mailbox**：按成员路由的异步信箱，既承载自然语言消息，也承载 shutdown、plan approval、permission 等结构化协议。

Coordinator 做的工作则可以概括成五个动词：**decompose、assign、observe、synthesize、close**。它拆目标、分所有权、观察状态、综合成员结果，最后判断是否完成或需要重派。真正的代码阅读、修改和测试仍由 worker 执行。

![Claude Code Agent Teams、共享控制面与 Coordinator 收敛流程手绘图](/images/posts/claude-code-source-reading-25/25-agent-teams-coordinator-handdrawn.png)

图里的三条箭头不能混在一起看。橙色是任务所有权，青色是消息路由，黑色是状态与完成信号。一个成员收到消息，不代表任务 owner 已经改变；一个 task 标记 completed，也不代表它的结论已经被 Coordinator 理解并写进最终答复。

底部的 `in-process | tmux | iTerm2` 是执行后端。它决定成员在哪里运行、如何展示和终止，不改变 Team config、Task list、Mailbox 这三层协作契约。

## 第一层：Team config 先建立身份和共享命名空间

Agent Teams 并非在所有运行环境中无条件打开。`restored-src/src/utils/agentSwarmsEnabled.ts` 把入口集中到一个守卫：

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

**参数说明：** 函数没有参数。`USER_TYPE === 'ant'` 是源码中的内部用户分支；外部 opt-in 可以来自环境变量 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 的 truthy 值，或命令行布尔标志 `--agent-teams`。GrowthBook 值的静态回退是 `true`，但运行时远端配置可以返回 `false`；。

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

**参数说明：** 输入里的 `team_name` 是必填字符串，空白会在 `validateInput()` 中以 `errorCode:9` 拒绝；`description` 是 `string | undefined`，省略时 team file 中对应字段保持 `undefined`；`agent_type` 也是可选字符串，省略时 lead 的类型回退为 `team-lead`。同名 team file 已存在时，源码会生成新的 word slug，而不是覆盖旧团队。一个 leader 同时已有 `teamContext.teamName` 时直接报错，必须先删除旧团队。

这一步说明了 Team 的本质：它不是 `Agent[]` 数组，而是一组可以被跨进程重新发现的身份数据。lead ID 由 `team-lead@teamName` 形式确定；成员还记录模型、cwd、加入时间、pane ID、backend type 等信息。

## 第二层：成员后端可以不同，协作协议保持不变

创建团队后，`spawnTeammate()` 进入共享的 spawn 模块。它没有把后端选择泄漏给上层调用者：

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

**参数说明：** `input.name` 与 `input.prompt` 必填；`team_name` 可以省略并从 leader 的 `teamContext` 继承；`cwd` 省略时回退当前目录；`use_splitpane` 是 `boolean | undefined`，只有严格等于 `false` 才关闭 split pane；`plan_mode_required` 省略时按 `false`；`model` 可为开放模型名、`'inherit'` 或 `undefined`，`'inherit'` 跟随 leader，`undefined` 走 teammate 默认模型逻辑；`agent_type` 和 `description` 都允许省略。`context` 提供 AppState、权限上下文、Agent 定义和当前 `toolUseId`，没有 `null` 回退。

in-process teammate 通过 AsyncLocalStorage 隔离身份和上下文；pane teammate 则启动新的 Claude Code 进程。两条路径最终都会：

1. 生成并清洗成员名与 `agentId`；
2. 把成员写进 `teamContext.teammates`；
3. 把成员追加到 team file；
4. 注册一个 `in_process_teammate` 运行时 Task，供 UI、取消和状态观察；
5. 交付第一条 prompt——in-process 直接传给 runner，pane 模式写进 mailbox。

最后一点很重要。源码明确禁止给 in-process teammate 再写一次初始 mailbox，否则同一条任务会执行两遍。所谓“统一协作协议”不等于所有后端的每个启动细节完全一样。

## 第三层：Task list 把“讨论”变成明确所有权

仅仅让三个 Agent 都知道用户目标，不能叫协作。没有 owner 和依赖关系，他们很容易重复读同一批文件，或者同时修改同一资源。

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

**参数说明：** 函数没有参数。显式环境变量优先级最高；`getTeammateContext()` 可能返回 `undefined`，表示当前不在 in-process teammate 的异步上下文；`getTeamName()`、模块级 `leaderTeamName` 也可能为 `undefined`，最终 `getSessionId()` 是回退值。task list ID 会经过路径清洗，任意字符串中的非字母、数字、连字符和下划线都会被替换，不能把它当成原始显示名。

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

**参数说明：** `subject`、`description` 是必填开放字符串；`activeForm` 是 `string | undefined`，仅用于 `in_progress` 时的 UI 文案；`metadata` 是 `Record<string, unknown> | undefined`。初始 `owner` 明确为 `undefined`，不是空字符串或 `null`；初始状态固定为 `'pending'`。协作状态可取 `'pending' | 'in_progress' | 'completed'`，不要与运行时 Task 的 `running/failed/killed` 混用。

分派通过 `TaskUpdate` 写 owner。成员自己把状态改为 `in_progress` 且没有显式 owner 时，工具还会自动把当前 agent name 填进去；owner 改变后，系统额外向新 owner 的 mailbox 写入 `task_assignment`。这让“共享状态”和“及时提醒”同时发生，但它们仍是两个写操作。

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

锁解决的是临界区竞争，不是完整事务。比如 `blockTask()` 要分别更新 A 的 `blocks` 和 B 的 `blockedBy`；`TaskUpdate` 先改 owner，再写 assignment mailbox。进程若在两个步骤之间退出，磁盘上可能出现短暂不一致。这就是图中“files + locks, not a transaction”的含义。

## 第四层：Mailbox 同时传业务消息和控制协议

Task list 适合保存稳定状态，不适合表达“请多看一下这个边界”“停止当前方向”“你的 plan 已批准”。这些增量信息进入 Mailbox。

`SendMessageTool` 的输入并不是只有一个字符串：

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

读取端也不是简单 `readFile()`。在内部用户分支中，`getTeammateMailboxAttachments()` 会合并 file mailbox 与 `AppState.inbox`，按 `from + timestamp + text prefix` 去重，并把同一成员的多条 idle notification 折叠为最新一条。普通消息先构造成 attachment，再标记已读，避免中途失败导致丢消息；permission、shutdown 等结构化协议则留给 `useInboxPoller` 的专门 handler，不能抢先塞成普通 LLM 文本。该 attachment bridge 在 `USER_TYPE !== 'ant'` 时直接返回空数组；这不等于外部团队完全没有 mailbox，而是说明不能把这条内部 attachment 路径写成所有构建的统一读取入口。

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

**函数说明：** `waitForNextPromptOrShutdown()` 是 in-process teammate 的待机循环。它让成员完成一轮后保持可继续使用，而不是每个 task 都重新启动 Agent。shutdown 被优先扫描，避免被大量 peer 消息饿死；team-lead 消息优先于 peer 消息，体现用户意图的控制优先级。

**参数说明：** `identity` 包含 `agentName/teamName/color/planModeRequired` 等成员身份；`abortController` 被触发后返回 `{type:'aborted'}`；`taskId` 指向运行时 `in_process_teammate` Task，用于读取内存待办消息；`getAppState/setAppState` 访问共享状态；`taskListId` 决定自动领取哪个任务目录。500ms 是静态源码常量，不是可传参数。返回联合值还包括 `new_message` 与 `shutdown_request`；一次 mailbox 读取失败只记录日志并继续轮询。

## Coordinator 不是群聊管理员，而是受限的综合器

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

`getCoordinatorSystemPrompt()` 进一步规定执行节奏：独立研究尽量并行，写同一组文件的工作串行，Coordinator 必须先理解研究结果，再给 worker 写出具体实现说明；验证最好交给新的 worker，以减少实现者的确认偏差。worker 结果以 `<task-notification>` 回到主会话，Coordinator 要把它理解成内部信号，而不是用户新提出的问题。

这套模式解决的是职责漂移：如果 Coordinator 自己开始大量 Read/Edit/Bash，它就既做分派又做实现，团队成员的边界会逐渐失效。工具过滤让“只协调”从提示词建议变成能力边界。

但 Coordinator mode 也不是 Agent Teams 的同义开关。`isCoordinatorMode()` 同时要求构建 feature `COORDINATOR_MODE` 和环境变量 `CLAUDE_CODE_COORDINATOR_MODE` 为 truthy；会话恢复时，`matchSessionMode('coordinator' | 'normal' | undefined)` 才会把当前环境调整到 transcript 记录的模式。旧会话没有 mode 字段时返回 `undefined`，不会擅自切换。

## 收敛不是等所有人说“完成”

多 Agent 最容易被低估的一步是收敛。成员发来 completed，只能证明某个执行路径结束。

Claude Code 提供了几类可组合信号：

- Task status 表示协作工作是 pending、in_progress 还是 completed；
- `idle_notification` 可以带 `available | interrupted | failed`，以及本轮 summary、completed task 和 failure reason；
- runtime Task 记录 teammate 是否 running、idle、awaiting plan approval 或 shutdown requested；
- Mailbox 允许 Coordinator 继续追问原成员，而不是重新启动一个丢失上下文的新成员；
- 成员退出时，`unassignTeammateTasks()` 会把它尚未完成的任务 owner 清空、状态重置为 pending，供其他成员重领。

因此一个可靠的收敛顺序是：先检查 task 依赖是否全部闭合，再读成员结果并解决冲突，然后安排独立验证；验证失败就把具体错误发回有上下文的成员；确认没有活动成员后，再走 shutdown 协议和 TeamDelete。

`TeamDeleteTool.call()` 会拒绝删除仍有 active non-lead member 的团队。只有成员已经优雅退出或被标记 inactive，才清理 team/task 目录、颜色分配、leader task-list 映射、`teamContext` 和 inbox。它的输入 schema 是严格空对象 `{}`，没有 `force` 布尔值，也没有“忽略活成员”的默认分支。

这条边界很有价值：**团队的完成条件不是 Coordinator 写出一句总结，而是共享工作已经闭合、成员生命周期已经处理、控制面可以安全回收。**

## 小结

Claude Code 的多 Agent 协作可以压成一句话：**成员独立执行，控制面共享事实，Coordinator 负责把事实变成决策。**

Team config 回答“谁在团队里”，Task list 回答“谁负责什么、被什么阻塞”，Mailbox 回答“新增信息和控制请求发给谁”。in-process、tmux 与 iTerm2 只是成员的执行容器，不改变这三层契约。文件锁保护关键领取与编号竞争，但跨文件、跨 mailbox 的更新不是一个事务，因此失败、重复、退出与重派都必须成为正常控制流。

Coordinator 的价值也不在于比 worker 更会写代码。它要守住全局目标：让独立工作并行，让写冲突串行，理解研究结果后再分派实现，用新视角验证，处理部分失败，最后确认任务和成员都已闭合。

这才是 Agent Team 与“同时开几个聊天窗口”的区别：前者有身份、所有权、依赖、消息协议和终态；后者只有并发。

## 留给下一篇的问题

团队协作确定以后，Plan mode 与 Git worktree 如何把“先规划、再并行实现、最后安全合并”落到代码与工作区？

