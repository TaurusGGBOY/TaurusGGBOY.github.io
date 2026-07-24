---
title: "Claude Code源码解读43：辅助模式如何区别于主 Agent"
published: 2026-07-24T16:47:30+08:00
updated: 2026-07-24T16:47:30+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-43/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

Dream 把经验沉淀下来以后，Assistant 与 KAIROS 如何利用这些记忆主动规划、提醒并推进用户任务？

先说结论：**Assistant/KAIROS 没有在主 Agent 旁边再造一套“更聪明的模型循环”，而是把普通 Claude Code 变成一段更长寿、能被时间和远程消息重新唤醒的工作关系。**

记忆负责给它连续性。KAIROS 模式仍加载 `MEMORY.md`，但新信息不再每次直接整理进索引，而是追加到按日期分片的 daily log；夜间 `/dream` 再把日志蒸馏回 topic 文件和 `MEMORY.md`。因此，它醒来时看到的不是一份待执行任务数据库，而是用户偏好、项目背景和历史决策这些“做判断所需的旧经验”。

主动性来自另外三条链路：`<tick>` 让长驻会话在用户没有输入时重新进入主循环；Cron 把“稍后提醒我”或“定期检查”变成排队的 prompt；后台 Agent/Skill 执行完以后，再把结果作为隐藏的 meta prompt 放回主队列。主 Agent 最后决定要不要继续行动，以及是否通过 `SendUserMessage` 把结论发给用户。

这里有一个必须先拆开的概念：**记忆不是触发器，触发器也不是权限。** `MEMORY.md` 不会自己在上午九点运行，Cron 也不会因为按时触发就绕过工具授权。KAIROS 复用原来的 Query Loop、Tool、Task、权限上下文和消息队列，只是改变了“下一轮从哪里来”“工作能否在后台继续”“结果通过什么通道抵达用户”。

所以更准确的回答是：Assistant/KAIROS 用 Dream 产出的记忆做上下文，用 tick、Cron 和远程输入重新唤醒 Agent，用异步任务保持前台可响应，再用有优先级的队列和 `SendUserMessage` 收口。。

## Assistant/KAIROS 是长期体验层，不是第二套 Agent 内核

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的源码片段只保留证明控制流所需的分支，省略日志、遥测和无关参数；还原路径不代表 Anthropic 内部仓库的原始目录结构。

![Claude Code Assistant/KAIROS 的触发、记忆、后台任务与消息闭环](/images/posts/claude-code-source-reading-43/43-assistant-kairos-handdrawn.png)

图里最重要的是中间那条边界：Assistant/KAIROS 位于体验层，下面仍是现有 Agent runtime。用户消息、tick、Cron 和远程事件只是不同入口，最后仍要进入消息队列和 Query Loop；工具动作仍要经过权限；后台结果也必须回到主 Agent，才能形成用户真正看见的回复。

### 先补四个基础概念

第一个概念是 **Assistant mode**。源码中的 `assistant` 设置被描述为“custom system prompt、brief view、scheduled check-in skills”的组合入口。它不是 Anthropic Messages API 里的 `assistant` role，也不是泛指所有 Claude 回复。本文提到 Assistant 时，只指这组受 KAIROS 构建和运行时开关保护的产品模式。

第二个概念是 **KAIROS**。在 2.1.88 还原源码里，它既是构建期开关，也是若干 assistant 能力的总边界。代码会用 `feature('KAIROS')` 决定是否把 assistant、history、Brief 等模块编进产物，再用信任状态、GrowthBook gate 和本地设置决定本次会话是否激活。它是源码里的产品概念，不应当被写成稳定的公开 API 契约。

第三个概念是 **proactive loop**。普通 REPL 等待人输入；主动模式则接受 `<tick>`，把它理解成“你醒了，现在有没有值得做的事”。如果有，就继续查、改、测试或汇报；没有，就调用 Sleep 控制下一次醒来的时间。tick 只提供再次判断的机会，不等于每次都必须制造新工作。

第四个概念是 **Brief view**。Assistant 的主要可见输出不是散落在详细执行记录里的普通文本，而是 `SendUserMessage`。这样后台任务可以保留完整工具过程，用户侧只收到确认、关键进度、结果或阻塞。它改变的是呈现通道，不是模型能做什么。

## 激活链路：开关、显式设置与目录信任缺一不可

启动阶段先检查 KAIROS 是否被编入，再判断 assistant 是否被配置或被 daemon 强制，最后要求当前目录已经通过信任对话框：

```ts
let kairosEnabled = false

if (feature('KAIROS') && options.assistant && assistantModule) {
  assistantModule.markAssistantForced()
}

if (
  feature('KAIROS') &&
  assistantModule?.isAssistantMode() &&
  !options.agentId &&
  kairosGate
) {
  if (!checkHasTrustDialogAccepted()) {
    console.warn('Assistant mode disabled: directory is not trusted.')
  } else {
    kairosEnabled =
      assistantModule.isAssistantForced() ||
      (await kairosGate.isKairosEnabled())
    if (kairosEnabled) {
      options.brief = true
      setKairosActive(true)
      assistantTeamContext = await assistantModule.initializeAssistantTeam()
    }
  }
}
```

**函数说明：** 这段来自 `restored-src/src/main.tsx` 的 CLI action 初始化段。它把 Assistant 激活收敛为一个进程期 `kairosEnabled`，随后用于 system prompt、AppState、后台 Agent 和远程桥。`initializeAssistantTeam()` 在 setup 读取 teammate mode 以前预建团队上下文，因此 Assistant 可以直接委派 Agent，而不要求模型先调用 `TeamCreate`。

**参数说明：** `options.assistant` 是可选布尔值；没有传入时不会触发 daemon 强制路径。`options.agentId` 可为 `undefined` 或某个已生成的 Agent ID；存在时表示当前进程是 teammate，必须跳过 leader 的重复初始化。`assistantModule.isAssistantForced()` 返回布尔值，源码注释说明 `--assistant` daemon 已在父层检查 entitlement，因此该路径跳过本地 GrowthBook 检查。普通配置路径则等待 `kairosGate.isKairosEnabled()`。`kairosEnabled` 初始为 `false`，任一门槛失败都保持关闭。

为什么目录信任要放在这里？因为项目里的 `.claude/settings.json` 和 `.claude/agents/assistant.md` 都可能来自刚 clone 的不可信仓库。如果先把项目自带 Assistant 指令塞进 system prompt，再让用户确认信任，攻击面已经发生了。源码选择的是“先信任，后激活”，而不是把 assistant 体验当成可信白名单。

这个开关也没有替用户选择权限模式。`main.tsx` 的注释明确写着 permission mode 仍采用用户的 `settings.defaultMode` 或 `--permission-mode`。也就是说，Assistant 默认更主动，不等于默认 `bypassPermissions`。

## 主动规划的本质：让同一个 Query Loop 多几个再次运行的机会

系统提示词里的 `getProactiveSection()` 给主动循环定义了行为纪律：首次唤醒先问用户要做什么，后续 tick 才寻找有用工作；没有工作必须 Sleep；终端未聚焦时更偏自主行动，用户正在交互时优先响应。

```ts
function getProactiveSection(): string | null {
  if (!(feature('PROACTIVE') || feature('KAIROS'))) return null
  if (!proactiveModule?.isProactiveActive()) return null

  return `# Autonomous work
You will receive <tick> prompts that keep you alive between turns.
...
If you have nothing useful to do on a tick, you MUST call Sleep.
...
First wake-up: greet the user briefly and ask what they'd like to work on.
...
Focused: be more collaborative.
Unfocused: lean heavily into autonomous action.`
}
```

**函数说明：** `getProactiveSection()` 位于 `restored-src/src/constants/prompts.ts`，由 `getSystemPrompt()` 调用。它只在构建包含 `PROACTIVE` 或 `KAIROS`，并且当前 proactive module 已激活时返回字符串；否则返回 `null`，不会把自主工作规则注入普通会话。

**参数说明：** 函数没有参数，返回值只有 `string` 或 `null`。`feature(...)` 是构建期条件，`isProactiveActive()` 是运行期状态。源码还能确认 `--proactive` 或真值环境变量 `CLAUDE_CODE_PROACTIVE` 会调用 `activateProactive('command')`；。

这就是“主动规划”最朴素的实现：并没有额外的 Planner 服务定期生成一张权威计划表，而是让模型在一次次唤醒中结合当前消息、任务状态、工具结果和记忆，重新判断最有价值的下一步。

REPL 把 tick 接回现有输入链时，会避开几个容易产生竞态的状态：

```ts
useProactive?.({
  isLoading: isLoading || initialMessage !== null,
  queuedCommandsLength: queuedCommands.length,
  hasActiveLocalJsxUI: isShowingLocalJSXCommand,
  isInPlanMode: toolPermissionContext.mode === 'plan',
  onSubmitTick: prompt =>
    handleIncomingPrompt(prompt, { isMeta: true }),
  onQueueTick: prompt =>
    enqueue({ mode: 'prompt', value: prompt, isMeta: true }),
})
```

**函数说明：** 这段来自 `restored-src/src/screens/REPL.tsx`。`useProactive()` 负责决定 tick 是立即提交还是先排队；两条路径最终都复用普通 prompt 输入和查询链。`isMeta: true` 把 tick 标记为系统驱动输入，避免把内部唤醒提示当成人类消息展示。

**参数说明：** `isLoading` 为 `true` 时不能并发开启第二次主查询；这里还把“初始消息尚未处理”视为 loading。`queuedCommandsLength` 是非负整数；`hasActiveLocalJsxUI` 和 `isInPlanMode` 都是布尔边界，分别避免 tick 打断本地交互界面和计划审批状态。`onSubmitTick`、`onQueueTick` 都接收开放的 prompt 字符串。恢复或取消方面，用户提交输入会调用 `resumeProactive()`，按 Escape 则调用 `pauseProactive()`；API error 和 compact 还会设置/清除 context-blocked 状态，避免形成 tick → error → tick 的烧 token 循环。

## 记忆怎样参与：读取蒸馏结果，新事实先写 daily log

上一篇已经分析 AutoDream。进入 KAIROS 后，变化最大的不是旧记忆如何读取，而是**新记忆先写到哪里**。`loadMemoryPrompt()` 在 auto memory 开启且 KAIROS active 时，优先返回 Assistant daily-log prompt：

```ts
if (feature('KAIROS') && autoEnabled && getKairosActive()) {
  return buildAssistantDailyLogPrompt(skipIndex)
}

function buildAssistantDailyLogPrompt(skipIndex = false): string {
  const memoryDir = getAutoMemPath()
  const logPathPattern = join(
    memoryDir,
    'logs',
    'YYYY',
    'MM',
    'YYYY-MM-DD.md',
  )
  // prompt lines omitted
  return lines.join('\n')
}
```

**函数说明：** `loadMemoryPrompt()` 与 `buildAssistantDailyLogPrompt()` 位于 `restored-src/src/memdir/memdir.ts`。普通 auto memory 让模型维护 topic 和索引；Assistant 把新观察追加到当天日志，由另一个 nightly `/dream` 过程蒸馏。`MEMORY.md` 仍由 Claude.md 读取链加载，作为已经整理过的方向索引。

**参数说明：** `autoEnabled` 是 `isAutoMemoryEnabled()` 的布尔结果；为 `false` 时 KAIROS 分支也不会创建记忆。`getKairosActive()` 返回进程期布尔状态。`skipIndex` 默认 `false`，来自 `tengu_moth_copse`；为 `true` 时提示词不描述 `MEMORY.md` 入口，为 `false` 时提醒模型读取但不要直接维护它。日志路径里的年月日是模式字符串，不是启动时写死的日期；会话跨过午夜后，模型根据 `currentDate` 和 date-change attachment 切换新文件。

为什么长期 Assistant 更适合 append-only 日志？因为它可能跨越很多轮和日期。每次获得一点新信息就重写 `MEMORY.md`，容易在并发、崩溃或语义尚未稳定时污染索引；先记录事实，再定期整合，写入动作更简单，也给 Dream 留出合并、纠错和淘汰的空间。

但这仍不是可靠的任务状态数据库。daily log 可以记录截止时间和决策，`MEMORY.md` 可以帮助模型重新理解项目，真正正在运行、完成或失败的工作仍由 Task/AppState 和消息队列表达。把记忆当任务状态，会遇到最直接的问题：文件里的“正在部署”可能已经过期。

## 提醒如何落地：Cron 保存的是未来 prompt，不是未来答案

`CronCreate` 接收五段 cron、将来要入队的 prompt，以及两个布尔控制项：

```ts
async call({
  cron,
  prompt,
  recurring = true,
  durable = false,
}) {
  const effectiveDurable = durable && isDurableCronEnabled()
  const id = await addCronTask(
    cron,
    prompt,
    recurring,
    effectiveDurable,
    getTeammateContext()?.agentId,
  )
  setScheduledTasksEnabled(true)
  return {
    data: { id, humanSchedule: cronToHuman(cron), recurring,
      durable: effectiveDurable },
  }
}
```

**函数说明：** 这段来自 `restored-src/src/tools/ScheduleCronTool/CronCreateTool.ts`。工具只注册一个未来触发条件；到点后 scheduler 才把 `prompt` 送回 lead 或 teammate。它没有预先生成未来回答，也不会冻结当前上下文快照。

**参数说明：** `cron` 是开放字符串，但必须被解析为标准五段表达式，并且未来一年内至少存在一次匹配；`prompt` 是届时提交给 Agent 的开放文本。`recurring` 可为 `true`、`false` 或 `undefined`，省略时默认 `true`，`false` 表示命中一次后自动删除。`durable` 同样是可选布尔值，默认 `false`；只有传 `true` 且 `isDurableCronEnabled()` 仍为真，才写入 `.claude/scheduled_tasks.json`。Teammate 不能创建 durable cron，因为其 Agent ID 不跨会话存活；全局任务数上限为 50。

总开关也有两层：构建必须包含 `AGENT_TRIGGERS`，本地 `CLAUDE_CODE_DISABLE_CRON` 不能为真，运行时 `tengu_kairos_cron` 也不能关闭。源码回退值是 `true`，但这是 2.1.88 的静态回退，不代表服务端永远不会使用 kill switch。

真正触发时，`useScheduledTasks()` 不直接调用模型，而是放进统一队列：

```ts
const enqueueForLead = (prompt: string) =>
  enqueuePendingNotification({
    value: prompt,
    mode: 'prompt',
    priority: 'later',
    isMeta: true,
    workload: WORKLOAD_CRON,
  })

const scheduler = createCronScheduler({
  onFire: enqueueForLead,
  onFireTask: task => {
    if (task.agentId) {
      // route to a live teammate, otherwise delete orphaned cron
      return
    }
    setMessages(prev => [...prev, createScheduledTaskFireMessage(...)])
    enqueueForLead(task.prompt)
  },
  isLoading: () => isLoadingRef.current,
  assistantMode,
  isKilled: () => !isKairosCronEnabled(),
})
```

**函数说明：** `useScheduledTasks()` 位于 `restored-src/src/hooks/useScheduledTasks.ts`。lead 的 Cron 触发被包装成隐藏 prompt；teammate cron 则路由给仍存活的对应 Agent，找不到时删除孤儿任务。`isKilled` 在 scheduler 检查时重新读取 gate，因此运行中也能被 kill switch 停止。

**参数说明：** `priority: 'later'` 是关键。统一队列顺序是 `now > next > later`，同优先级 FIFO；普通用户输入默认 `next`，所以不会被一批定时任务饿死。`isMeta: true` 表示系统通知，不在队列预览里冒充用户输入。`assistantMode` 默认 `false`；为真时 scheduler 可以绕开普通 `isLoading` 饥饿问题，但任务仍需通过队列进入后续回合。`workload: WORKLOAD_CRON` 只用于来源/服务质量归因，不能推导模型、延迟或一定成功。

## 推进工作：后台 Agent 完成后，还要让主 Agent 再判断一次

Assistant 最容易卡死的情况，不是模型不会做，而是一次慢 subagent 把主线程占住，用户消息只能一直排队。KAIROS 因而把 Agent 调用强制转为 async（除非全局禁用后台任务）：

```ts
const assistantForceAsync = feature('KAIROS')
  ? appState.kairosEnabled
  : false

const shouldRunAsync = (
  run_in_background === true ||
  selectedAgent.background === true ||
  isCoordinator ||
  forceAsync ||
  assistantForceAsync ||
  (proactiveModule?.isProactiveActive() ?? false)
) && !isBackgroundTasksDisabled
```

**函数说明：** 这段来自 `restored-src/src/tools/AgentTool/AgentTool.tsx`。它复用通用 `AgentTool` 的异步任务注册、进度、完成通知、失败和 kill 逻辑；Assistant 只增加 `assistantForceAsync` 这一项，防止 overdue cron 或多个委派串行阻塞输入队列。

**参数说明：** `run_in_background` 可为 `true`、`false` 或 `undefined`；Agent 定义里的 `background` 也可能显式为 `true`。`assistantForceAsync` 只有 KAIROS 构建且 `appState.kairosEnabled === true` 时成立。最终还要与 `!isBackgroundTasksDisabled` 合取，所以环境或系统禁用后台任务时会回到同步路径。异步任务使用独立 AbortController，不随主线程 Escape 自动取消；要通过任务 kill 路径显式终止。

定时 Skill 的闭环更能说明为什么“后台完成”不等于“用户已经收到结果”。Assistant 模式下，forked slash command 会立即返回；后台结束后，代码再把结果包成隐藏输入：

```ts
const enqueueResult = (value: string): void =>
  enqueuePendingNotification({
    value,
    mode: 'prompt',
    priority: 'later',
    isMeta: true,
    skipSlashCommands: true,
    workload: spawnTimeWorkload,
  })

enqueueResult(
  `<scheduled-task-result command="/${commandName}">
${resultText}
</scheduled-task-result>`,
)
```

**函数说明：** 这段来自 `restored-src/src/utils/processUserInput/processSlashCommand.tsx` 的 `executeForkedSlashCommand()`。后台 Agent 负责做具体工作，结果重新入队以后，主 Agent 才能结合当前对话判断是继续处理、记录记忆，还是向用户发送结果。异常也会以 `status="failed"` 的同类 meta prompt 回来，不会静默伪装成功。

**参数说明：** `priority` 固定为 `'later'`，`isMeta` 固定为 `true`。`skipSlashCommands: true` 防止结果文本碰巧以 `/` 开头时再次被解释为命令。`spawnTimeWorkload` 可能为字符串或 `undefined`，这里只保持原任务的归因。`resultText` 来自后台 Agent 消息，提取不到时回退为 `Command completed`；。

## 主动消息：SendUserMessage 是出口，不是权限捷径

Brief 模式把用户真正会看到的回复收敛到 `SendUserMessage`：

```ts
const inputSchema = z.strictObject({
  message: z.string(),
  attachments: z.array(z.string()).optional(),
  status: z.enum(['normal', 'proactive']),
})

async call({ message, attachments, status }, context) {
  const sentAt = new Date().toISOString()
  if (!attachments || attachments.length === 0) {
    return { data: { message, sentAt } }
  }
  const resolved = await resolveAttachments(attachments, {
    replBridgeEnabled: context.getAppState().replBridgeEnabled,
    signal: context.abortController.signal,
  })
  return { data: { message, attachments: resolved, sentAt } }
}
```

**函数说明：** `BriefTool` 位于 `restored-src/src/tools/BriefTool/BriefTool.ts`。工具被声明为 concurrency-safe、read-only，负责生成用户消息及可选附件元数据。Assistant 模式下 `getKairosActive()` 可绕过单独 Brief opt-in，但仍要求对应构建/entitlement 条件成立。

**参数说明：** `message` 是必填开放字符串，支持 Markdown。`attachments` 可为字符串路径数组或 `undefined`；空数组与缺失都走无附件路径，非空时逐个验证并可能经 bridge 上传。`status` 只有 `'normal'` 和 `'proactive'`：前者回应用户刚说的话，后者用于用户没有主动询问的完成、阻塞或状态更新。它是下游路由使用的意图标签，不会替代工具权限判定。`sentAt` 是调用进程生成的 ISO 时间；旧会话回放可能没有该字段。

这也解释了为什么系统提示词要求“ack → work → result”，但不鼓励逐步播报。Assistant 要解决的是用户离开终端后看不见普通 stdout 的问题，不是把每次 Read、Grep、Bash 都变成通知。

## 长期会话：执行端与 Viewer 必须分开理解

Assistant 的另一个关键变化是会话不随一个 CLI 进程退出就必然结束。`useReplBridge` 在 Assistant mode 下把 bridge 标为 perpetual，复用 `bridge-pointer.json` 中的 environment/session ID；服务端则用 `worker_type: 'claude_code_assistant'` 区分这类 worker。

当用户运行 `claude assistant [sessionId]` 时，本地 REPL 是远程会话 Viewer：它设置 `viewerOnly: true`、`initialTools: []`，通过 bridge POST 新消息并流式显示事件。Agentic loop 在远程 worker 中运行，不是在 Viewer 进程里又执行一遍。

历史读取也采用分页而不是启动时全量下载：

```ts
export async function fetchLatestEvents(
  ctx: HistoryAuthCtx,
  limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPage | null> {
  return fetchPage(ctx, { limit, anchor_to_latest: true },
    'fetchLatestEvents')
}

export async function fetchOlderEvents(
  ctx: HistoryAuthCtx,
  beforeId: string,
  limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPage | null> {
  return fetchPage(ctx, { limit, before_id: beforeId },
    'fetchOlderEvents')
}
```

**函数说明：** 这两个函数位于 `restored-src/src/assistant/sessionHistory.ts`。Viewer 首次取最新一页，滚动到顶部附近时再用最老 event ID 取上一页；`useAssistantHistory()` 把 SDK event 经 `convertSDKMessage()` 适配成 REPL `Message[]`，并通过滚动高度差保持阅读位置。

**参数说明：** `ctx` 包含 session events URL 和 OAuth/组织 headers。`limit` 是可选数字，默认 `HISTORY_PAGE_SIZE = 100`；源码没有在这两个包装函数里限制调用者传入的其他正数。`beforeId` 是必填开放字符串，来自上一页 `firstId`。返回值为 `HistoryPage | null`：网络异常、15 秒超时或 HTTP 非 200 都返回 `null`；空的 `data` 会回退为空数组。失败时 Viewer 保留 cursor，用户再次滚动可以重试，而不是把一次网络错误当成“已经到会话开头”。

## 权限、优先级和失败边界

把 Assistant 描述成“自动替你做一切”会遗漏这套设计最重要的约束。

第一，**主动程度与权限模式正交**。Assistant 启动不强制 `bypassPermissions`；主 Agent 继续使用普通 `toolPermissionContext`。后台 Agent 也通过 `AgentTool` 装配自己的工具池和 `canUseTool` 链。

第二，**用户输入优先于后台通知**。普通输入默认 `next`，Cron、任务结果和其他系统通知使用 `later`；`now` 消息还会中断当前 AbortController。Assistant 可以在后台推进，但不能用一批低优先级例行任务把用户刚发来的问题长期压住。

第三，**取消不是事务回滚**。Escape 会暂停 proactive 并结束主查询，但已经完成的文件写入不会撤销；异步 Agent 使用独立取消控制器，也不会因为主线程 Escape 自动停止。用户必须显式 kill 后台任务，工具自身的副作用仍按对应章节讨论的边界处理。

第四，**Cron 是至少一次尝试语义附近的调度，不是准点承诺**。scheduler 只在进程/会话和 gate 允许时运行，还有 jitter、idle、过期、孤儿 teammate 与持久化失败等条件。源码能说明如何排队和补偿，不能承诺墙上时钟到点一定完成业务动作。

第五，**记忆可能过期，主动消息也可能错**。Dream 产物只是模型生成并存入文件的上下文；KAIROS 的下一轮仍需核对代码、外部系统和任务状态。`status: 'proactive'` 只说明这是一条主动消息，不是事实正确性的签名。

第六，**功能存在不等于线上默认可见**。`KAIROS`、`PROACTIVE`、`AGENT_TRIGGERS` 是构建边界，`tengu_kairos`、`tengu_kairos_cron`、`tengu_kairos_brief` 等是运行时边界，目录信任、OAuth、remote bridge、auto memory 和本地环境变量还会继续裁剪能力。本文只能说明 2.1.88 可见源码的组合逻辑。

## 小结

Assistant/KAIROS 的核心不是换了一个 Agent，而是给原来的 Agent 增加了时间维度和宿主维度。

Dream 与 `MEMORY.md` 提供长期判断依据，daily log 承接尚未蒸馏的新事实；tick 让会话有机会主动复盘下一步，Cron 把未来时刻变成 prompt；异步 Agent 和 forked Skill 避免慢任务阻塞前台；统一队列让用户输入压过后台通知；`SendUserMessage` 把确认、进度、结果和阻塞送到用户真正会看的地方；perpetual bridge 与 Viewer 则让这段工作关系跨 CLI 进程延续。

但每一层都有边界：开关与目录信任决定能否启动，权限引擎决定能否行动，Task/AppState 决定运行状态，AbortController 只能取消未来控制流，记忆和主动消息都不天然保证正确。理解这些边界，才能把“主动助手”看成一套可恢复的事件闭环，而不是一个获得无限授权的后台机器人。

## 留给下一篇的问题

主动助手能够推进任务以后，Buddy 如何把这些能力包装成更连续的陪伴式体验，并管理状态、建议与反馈？

