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

上一篇的问题是：**从用户角度看，AutoDream 有什么实际作用？**

先给结论：**AutoDream 不会替你完成当前的编码任务，它维护的是“下一次会话能否快速恢复上下文”的基础设施。** 它把多个会话里零散、重复、过期或互相矛盾的记忆，在后台整理成更短的 `MEMORY.md` 索引和更清晰的 topic 文件。下一次打开同一个项目时，你少解释几遍背景，Claude 也更容易找到真正相关的长期信息。

### 用户真正能感受到的四个变化

| 你遇到的问题 | AutoDream 做的事 | 对用户的实际收益 |
| --- | --- | --- |
| 同一条经验在多个会话里重复出现 | 把新信号合并到已有 topic，而不是不断创建近似文件 | 长期记忆不容易变成重复清单 |
| 旧结论和新事实冲突 | 删除被推翻的事实，解决文件之间的矛盾，并把“昨天”“上周”改成绝对日期 | 新会话更少引用已经过期的判断 |
| `MEMORY.md` 越写越长 | 只保留指向 topic 文件的短索引，删除失效指针，并控制行数和大小 | 启动时进入上下文的内容更紧凑，相关细节再按需读取 |
| 过去很多会话都留下了线索 | 按 transcript 的修改时间挑选上次整合后的会话，排除当前会话后再交给后台 Agent 判断 | 不需要每次把所有历史记录重新塞进模型窗口 |

这里的“收益”不是一次运行就能量化的准确率提升，而是让记忆目录保持可读、可检索、可继续维护。源码能确认整理动作和写入边界，不能从静态代码保证模型每次都挑对事实。

### 一个具体场景

假设你连续几天处理同一个项目：第一次会话确认测试必须使用 `pnpm`，第二次会话记录本地 Redis 依赖，第三次会话又纠正了某个 API 的兼容性限制。每轮结束后的记忆提取可能先把这些线索写入不同文件；满足时间和会话门槛后，AutoDream 才会把它们合并成稳定的主题记忆，并让 `MEMORY.md` 只留下短指针。

下次新建会话时，Claude 先看到索引，需要时再读取对应主题文件。用户看到的不是“AutoDream 替我做了一个功能”，而是 Claude 少问了一些已经解释过的问题，并更快进入项目真正的工作状态。

### 它具体整理什么，又不会碰什么

`buildConsolidationPrompt()` 把后台任务分成四个阶段：Orient 读取当前索引和已有主题，Gather 从 daily log 或窄范围 transcript 搜索新线索，Consolidate 合并和纠错，Prune/Index 最后压缩 `MEMORY.md`。后台 forked Agent 的 Bash 只允许只读命令，Edit 和 Write 也被限制在 auto-memory 目录，因此 AutoDream 不应该直接改动你的源代码、配置或 Git 历史。

这也解释了它为什么不是聊天记录备份：提示词要求对 JSONL transcript 做窄范围搜索，而不是把每个会话完整读回上下文；它要保存的是能帮助未来判断的经验，不是所有原始对话。

### 什么时候你几乎感觉不到它？

AutoDream 默认并不每轮运行。源码里的静态默认值是距上次整合至少 `24` 小时、至少有 `5` 个其他会话被修改；同一进程的扫描还有 `10` 分钟节流，且需要拿到 `.consolidate-lock`。这些正数阈值可能由 GrowthBook 的 `tengu_onyx_plover` 提供覆盖，所以默认值不能当成所有线上用户永远不变的承诺。

此外，`isGateOpen()` 会在 KAIROS 模式、Remote 模式或 auto memory 关闭时跳过这条 AutoDream 路径；`autoDreamEnabled` 被显式设置为 `false` 时也不会启动。任务成功且确实改动了文件时，主 transcript 才会收到一条类似 `Improved …` 的摘要；失败或用户终止则回滚锁的时间戳，让后续机会可以重试。

后台运行也意味着可能产生额外的模型调用和 token 消耗。源码只能确认它调用了 `runForkedAgent()` 并记录 usage，实际费用和耗时仍取决于触发次数、记忆规模以及运行时 provider。

### AutoDream 与 `CLAUDE.md` 不是一回事

如果一条规则必须每次都告诉 Claude，例如“提交前必须运行某个检查”，应该写进项目 `CLAUDE.md` 或 hook；AutoDream 面向的是 Claude 在工作过程中发现的偏好、项目背景和经验线索。前者是你明确维护的指导，后者是可检查、可编辑但仍需复核的长期记忆。

外部资料也从用户体验角度得到类似结论：官方文档把 auto memory 定义为跨会话积累的 notes，并强调主题文件按需读取；实践文章则把它描述成可读、可编辑、会随会话积累的 Markdown 工作文档。关于 AutoDream 本身的报道进一步指出，它试图在后台处理“上下文熵”，但 source-map 中的 2.1.88 实现才是本文判断触发条件和安全边界的依据，不能把报道里的“空闲时运行”直接当成源码事实。

## 本章先建立三个概念

- **主动调度**：系统依据空闲、提醒与后台结果安排下一次模型运行，形成跨轮次推进。

- **长生命周期 Agent**：执行端保留本地项目能力，Viewer 和远程控制端负责观察与发消息。

- **带外控制**：Cron、push 与用户消息通过独立通道唤醒主循环，仍受原有权限约束。

![KAIROS 的主动调度与带外控制闭环](/images/posts/claude-code-source-reading-43/43-kairos-control-loop-detail-handdrawn.png)

先区分“记忆保存了什么”“触发器何时入队”和“主 Agent 是否愿意执行”，再看 Assistant 的长期体验层。

## 这张金额单位工单之后，助手还会记得下一步

工程师关闭工单时，完整回归测试还在后台跑，监控团队也要求第二天早班再看一次支付错误率。他在离开办公室前输入：

> 明天上午十点提醒我复查支付监控；如果后台测试或 teammate 出现新结果，主动告诉我。提醒里带上这张金额单位工单的根因和待确认项，但不要重复执行修复。

这条请求不一定由主 Coding Agent 当场完成。Assistant/KAIROS 可以把提醒保存成未来 prompt，把后台任务完成变成再次运行 Query Loop 的机会，再通过 `SendUserMessage` 把结果送回用户。它复用了原来的 session、memory 和 task 内核，却增加了长期调度和主动消息层：第二天的提醒是一次新的入队，不能被误解成昨晚那次工具调用仍在同步阻塞。

下面从这句“明天再提醒我”开始，区分主 Agent 的当前回合与长期助手的再次入队。

## Assistant/KAIROS 在现有内核上增加长期体验层

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的源码片段只保留证明控制流所需的分支，省略日志、遥测和无关参数；还原路径不代表 Anthropic 内部仓库的原始目录结构。

![Claude Code Assistant/KAIROS 的触发、记忆、后台任务与消息闭环](/images/posts/claude-code-source-reading-43/43-assistant-kairos-handdrawn.png)

图里最重要的是中间那条边界：Assistant/KAIROS 位于体验层，下面仍是现有 Agent runtime。用户消息、tick、Cron 和远程事件只是不同入口，最后仍要进入消息队列和 Query Loop；工具动作仍要经过权限；后台结果也必须回到主 Agent，才能形成用户真正看见的回复。

### 先补四个基础概念

第一个概念是 **Assistant mode**。源码中的 `assistant` 设置被描述为“custom system prompt、brief view、scheduled check-in skills”的组合入口。本文提到 Assistant 时，专指这组受 KAIROS 构建和运行时开关保护的产品模式；Messages API 的 `assistant` role 仍只表示消息角色。

第二个概念是 **KAIROS**。在 2.1.88 还原源码里，它既是构建期开关，也是若干 assistant 能力的总边界。代码会用 `feature('KAIROS')` 决定是否把 assistant、history、Brief 等模块编进产物，再用信任状态、GrowthBook gate 和本地设置决定本次会话是否激活。它是源码里的产品概念，不应当被写成稳定的公开 API 契约。

第三个概念是 **proactive loop**。普通 REPL 等待人输入；主动模式则接受 `<tick>`，重新判断当前是否有值得做的事。有工作时继续查、改、测试或汇报，空闲时调用 Sleep 控制下一次醒来的时间。tick 只提供一次新的决策机会。

第四个概念是 **Brief view**。Assistant 通过 `SendUserMessage` 提供主要可见输出；后台任务保留完整工具过程，用户侧只收到确认、关键进度、结果或阻塞。Brief view 改变呈现通道，工具能力仍由原有权限上下文决定。

## 激活链路：开关、显式设置与目录信任缺一不可

启动阶段先判断构建产物有没有 KAIROS，再检查 assistant 设置或 daemon 强制开关，最后才要求目录 trust。顺序不能倒置：项目指令尚未被信任前，不能提前激活主动模式。

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

**参数说明：** `options.assistant` 是可选布尔值；省略时走普通配置路径。`options.agentId` 可为 `undefined` 或某个已生成的 Agent ID；存在时表示当前进程是 teammate，必须跳过 leader 的重复初始化。`assistantModule.isAssistantForced()` 返回布尔值，源码注释说明 `--assistant` daemon 已在父层检查 entitlement，因此该路径跳过本地 GrowthBook 检查。普通配置路径则等待 `kairosGate.isKairosEnabled()`。`kairosEnabled` 初始为 `false`，任一门槛失败都保持关闭。

目录信任必须先于 Assistant 激活。项目里的 `.claude/settings.json` 和 `.claude/agents/assistant.md` 可能来自刚 clone 的仓库；先完成 trust 检查，再把项目指令装入 system prompt，才能阻止未信任内容提前影响模型。

Assistant 开关沿用用户通过 `settings.defaultMode` 或 `--permission-mode` 选择的权限模式。主动调度只增加唤醒机会，`bypassPermissions` 仍需显式配置。

## 主动规划的本质：让同一个 Query Loop 多几个再次运行的机会

系统提示词里的 `getProactiveSection()` 给主动循环定义了行为纪律：首次唤醒先问用户要做什么，后续 tick 寻找有用工作；空闲时必须 Sleep；终端未聚焦时更偏自主行动，用户正在交互时优先响应。

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

**函数说明：** `getProactiveSection()` 位于 `restored-src/src/constants/prompts.ts`，由 `getSystemPrompt()` 调用。构建包含 `PROACTIVE` 或 `KAIROS` 且 proactive module 已激活时，它返回自主工作段；其他情况返回 `null`，`getSystemPrompt()` 过滤该项并继续构造普通会话提示词。

**参数说明：** 函数接受零个参数，返回值只有 `string` 或 `null`。`feature(...)` 是构建期条件，`isProactiveActive()` 是运行期状态。源码还能确认 `--proactive` 或真值环境变量 `CLAUDE_CODE_PROACTIVE` 会调用 `activateProactive('command')`。

“主动规划”由一次次重新进入 Query Loop 实现：模型结合当前消息、任务状态、工具结果和记忆，在每次唤醒时重新判断最有价值的下一步。

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

上一篇已经分析 AutoDream。进入 KAIROS 后，读取仍沿用旧记忆链，新事实则先写入 daily log。`loadMemoryPrompt()` 在 auto memory 开启且 KAIROS active 时，优先返回 Assistant daily-log prompt：

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

**参数说明：** `autoEnabled` 是 `isAutoMemoryEnabled()` 的布尔结果；为 `false` 时 KAIROS 分支跳过记忆创建。`getKairosActive()` 返回进程期布尔状态。`skipIndex` 默认 `false`，来自 `tengu_moth_copse`；为 `true` 时提示词省略 `MEMORY.md` 入口，为 `false` 时提醒模型读取但不要直接维护它。日志路径里的年月日是运行期模式字符串；会话跨过午夜后，模型根据 `currentDate` 和 date-change attachment 切换新文件。

为什么长期 Assistant 更适合 append-only 日志？因为它可能跨越很多轮和日期。每次获得一点新信息就重写 `MEMORY.md`，容易在并发、崩溃或语义尚未稳定时污染索引；先记录事实，再定期整合，写入动作更简单，也给 Dream 留出合并、纠错和淘汰的空间。

daily log 可以记录截止时间和决策，`MEMORY.md` 可以帮助模型重新理解项目；正在运行、完成或失败的工作由 Task/AppState 和消息队列表达。任务面板以运行时状态为准，避免把记忆文件里可能过期的“正在部署”当成当前事实。

## 提醒如何落地：Cron 保存未来 prompt

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

**函数说明：** 这段来自 `restored-src/src/tools/ScheduleCronTool/CronCreateTool.ts`。工具只注册一个未来触发条件；到点后 scheduler 才把 `prompt` 送回 lead 或 teammate，由届时的上下文生成回答。

**参数说明：** `cron` 是开放字符串，但必须被解析为标准五段表达式，并且未来一年内至少存在一次匹配；`prompt` 是届时提交给 Agent 的开放文本。`recurring` 省略时默认 `true`，`false` 表示命中一次后自动删除；`durable` 默认 `false`，只有传 `true` 且 gate 开启才写入 `.claude/scheduled_tasks.json`。返回 `data.id` 用于后续管理任务，`humanSchedule` 是 `cronToHuman(cron)` 的展示文本，`recurring` 回显实际重复语义，`durable` 回显经过 gate 后的 `effectiveDurable`。Teammate 不能创建 durable cron；全局任务数上限为 50。

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

**参数说明：** 入队对象的 `value` 保存触发时要交给 Agent 的 prompt，`mode: 'prompt'` 让队列按新一轮模型输入处理它。`priority: 'later'` 是关键。统一队列顺序是 `now > next > later`，同优先级 FIFO；普通用户输入默认 `next`，所以不会被一批定时任务饿死。`isMeta: true` 表示系统通知，不在队列预览里冒充用户输入。scheduler 的 `onFire` 接收普通 lead prompt 并调用 `enqueueForLead`；`onFireTask` 接收完整 task，借助 `agentId` 决定 teammate 路由或 lead 的 fire message。`assistantMode` 默认 `false`；为真时 scheduler 可以绕开普通 `isLoading` 饥饿问题，但任务仍需通过队列进入后续回合。`workload: WORKLOAD_CRON` 只用于来源/服务质量归因，不能推导模型、延迟或一定成功。

## 推进工作：后台 Agent 完成后，还要让主 Agent 再判断一次

一次慢 subagent 若占住主线程，用户消息只能持续排队。KAIROS 因而把 Agent 调用强制转为 async（除非全局禁用后台任务）：

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

定时 Skill 分两步完成闭环：Assistant 模式下，forked slash command 立即返回；后台结束后，代码再把结果包成隐藏输入：

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

**参数说明：** `mode` 固定为 `'prompt'`，让后台结果重新成为主 Agent 的输入；`priority` 固定为 `'later'`，`isMeta` 固定为 `true`。`skipSlashCommands: true` 防止结果文本碰巧以 `/` 开头时再次被解释为命令。`workload` 接收可能为字符串或 `undefined` 的 `spawnTimeWorkload`，保持原任务的归因。`resultText` 来自后台 Agent 消息，提取不到时回退为 `Command completed`。

## 主动消息：SendUserMessage 提供用户出口

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

**参数说明：** `message` 是必填开放字符串，支持 Markdown。`attachments` 可为字符串路径数组或 `undefined`；空数组与缺失都走无附件路径，非空时逐个验证并可能经 bridge 上传。附件解析参数中的 `replBridgeEnabled` 读取当前 AppState，决定是否启用 bridge 相关解析与上传能力；`signal` 取工具调用的 `abortController.signal`，用于在本轮取消时终止附件处理。`status` 只有 `'normal'` 和 `'proactive'`：前者回应当前用户输入，后者用于 Agent 主动发起的完成、阻塞或状态更新。它是下游路由使用的意图标签，工具权限仍由权限引擎判定。`sentAt` 是调用进程生成的 ISO 时间；旧会话回放时该字段可缺失。

这也解释了为什么系统提示词要求“ack → work → result”，但不鼓励逐步播报。Assistant 用少量主动消息覆盖用户离开终端后的关键状态，Read、Grep、Bash 等细节仍留在执行记录。

## 长期会话：执行端与 Viewer 必须分开理解

Assistant 的另一个关键变化是会话不随一个 CLI 进程退出就必然结束。`useReplBridge` 在 Assistant mode 下把 bridge 标为 perpetual，复用 `bridge-pointer.json` 中的 environment/session ID；服务端则用 `worker_type: 'claude_code_assistant'` 区分这类 worker。

当用户运行 `claude assistant [sessionId]` 时，本地 REPL 成为远程会话 Viewer：它设置 `viewerOnly: true`、`initialTools: []`，通过 bridge POST 新消息并流式显示事件；Agentic loop 只在远程 worker 中运行。

历史读取采用分页：

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

**参数说明：** `ctx` 包含 session events URL 和 OAuth/组织 headers。`limit` 是可选数字，默认 `HISTORY_PAGE_SIZE = 100`；这两个包装函数会原样接受调用者传入的其他正数。`beforeId` 是必填开放字符串，来自上一页 `firstId`。返回值为 `HistoryPage | null`：网络异常、15 秒超时或 HTTP 非 200 都返回 `null`；空的 `data` 会回退为空数组。失败时 Viewer 保留 cursor，用户再次滚动可以重试；只有成功返回的空页才表示到达历史边界。

## 权限、优先级和失败边界

把 Assistant 描述成“自动替你做一切”会遗漏这套设计最重要的约束。

第一，**主动程度与权限模式正交**。Assistant 启动不强制 `bypassPermissions`；主 Agent 继续使用普通 `toolPermissionContext`。后台 Agent 也通过 `AgentTool` 装配自己的工具池和 `canUseTool` 链。

第二，**用户输入优先于后台通知**。普通输入默认 `next`，Cron、任务结果和其他系统通知使用 `later`；`now` 消息还会中断当前 AbortController。Assistant 可以在后台推进，但不能用一批低优先级例行任务把用户刚发来的问题长期压住。

第三，**取消只影响后续控制流**。Escape 会暂停 proactive 并结束主查询，已经完成的文件写入保持不变；异步 Agent 使用独立取消控制器，需要用户显式 kill。工具副作用仍按对应章节讨论的边界处理。

第四，**Cron 提供条件化调度**。scheduler 只在进程/会话和 gate 允许时运行，还受 jitter、idle、过期、孤儿 teammate 与持久化失败等条件影响。源码能说明排队和补偿机制，墙上时钟的准点业务完成仍取决于运行环境。

第五，**记忆与主动消息都需要复核**。Dream 产物是模型生成并存入文件的上下文；KAIROS 的下一轮仍需核对代码、外部系统和任务状态。`status: 'proactive'` 只标记消息来源，事实正确性要由实际状态证明。

第六，**功能可见性由多层 gate 共同决定**。`KAIROS`、`PROACTIVE`、`AGENT_TRIGGERS` 是构建边界，`tengu_kairos`、`tengu_kairos_cron`、`tengu_kairos_brief` 等是运行时边界，目录信任、OAuth、remote bridge、auto memory 和本地环境变量还会继续裁剪能力。本文只说明 2.1.88 可见源码的组合逻辑。

## 小结

Assistant/KAIROS 给原来的 Agent 增加了时间维度和宿主维度。

Dream 与 `MEMORY.md` 提供长期判断依据，daily log 承接尚未蒸馏的新事实；tick 让会话有机会主动复盘下一步，Cron 把未来时刻变成 prompt；异步 Agent 和 forked Skill 避免慢任务阻塞前台；统一队列让用户输入压过后台通知；`SendUserMessage` 把确认、进度、结果和阻塞送到用户真正会看的地方；perpetual bridge 与 Viewer 则让这段工作关系跨 CLI 进程延续。

每一层都有边界：开关与目录信任决定能否启动，权限引擎决定能否行动，Task/AppState 决定运行状态，AbortController 只取消未来控制流，记忆和主动消息需要外部事实复核。这些部件共同组成一套可恢复、权限受控的事件闭环。

## 留给下一篇的问题

主动助手能够推进任务以后，Buddy 如何把这些能力包装成更连续的陪伴式体验，并管理状态、建议与反馈？

## 参考资料

- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)

- [Dive into Claude Code：生产级 Agent 的设计空间](https://arxiv.org/abs/2604.14228)

- [How Claude remembers your project](https://code.claude.com/docs/en/memory)

- [Claude Code's Auto-Memory: Building Persistent Context Across Sessions](https://www.claudedirectory.org/blog/claude-code-auto-memory-guide)

- [Claude Code's source code appears to have leaked: here's what we know](https://venturebeat.com/ai/claude-codes-source-code-appears-to-have-leaked-heres-what-we-know)
