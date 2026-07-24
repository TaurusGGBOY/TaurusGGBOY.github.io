---
title: "Claude Code源码解读17：长会话如何继续运行"
published: 2026-07-24T16:47:04+08:00
updated: 2026-07-24T16:47:04+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-17/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：当对话历史、工具结果和项目上下文不断增长并逼近模型窗口时，Claude Code 如何判断何时压缩、保留什么、又怎样继续会话？

先给结论。Claude Code 并不是等 API 返回“上下文过长”以后，再把最旧的消息简单删掉。它会先根据当前模型计算有效上下文窗口，为生成摘要预留输出空间，再从有效窗口中减去自动压缩缓冲区，得到触发线。消息的 token 估算达到这条线后，自动压缩流程优先尝试已经提炼好的 session memory；这条实验路径不可用时，才调用模型生成完整摘要。

压缩完成后，运行时会重建一条新的消息链：压缩边界、摘要、明确保留的近期消息、文件/计划/Skill/后台 Agent 等附件，最后再接上 SessionStart Hook 的结果。`queryLoop()` 拿到这组消息后继续下一轮推理。因此，从模型视角看，会话没有“重新开始”，只是早期逐字历史被换成了摘要和恢复线索。

这里还有两个边界。第一，旧工具结果可能先由 microcompact 做更小粒度的清理，但 2.1.88 的普通回退路径已经删除；它是否生效取决于时间条件、内部构建能力、模型支持和功能开关。

## 压缩的核心不是“删消息”，而是重建可继续执行的上下文

本文只讨论本仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的实现。为了让代码片段聚焦主路径，下面会省略无关 import、日志字段和实验分支；所有片段仍来自 `restored-src/`，不是改写后的伪代码。

![Claude Code 上下文压缩流程：阈值判断、摘要生成与消息链重建](/images/posts/claude-code-source-reading-17/17-context-compaction-handdrawn.png)

### 先补三个基础概念

第一个概念是 **context window**，也就是一次模型请求能够容纳的输入和输出总量。Claude Code 发给模型的内容不只有聊天文字，还包括 system prompt、工具定义、CLAUDE.md、附件、`tool_use` 与 `tool_result`。所以终端里看起来只有几十轮对话，并不代表上下文还很空。

第二个概念是 **compaction**。它用较短的表示替换较长的历史，目标不是长期归档，而是让当前任务还能继续执行。摘要必须保留用户意图、已经完成的工作、重要文件、错误与下一步；但摘要终究不是原文，因此实现还会保留近期消息，并告诉模型完整 transcript 在哪里。

第三个概念是 **prompt cache**。连续请求通常拥有很长的相同前缀，复用这个前缀可以减少重复处理。压缩会改写消息链，天然容易打破缓存。源码因此会尽量让摘要 Agent 复用主会话前缀，并在局部压缩时区分保留前缀还是保留后缀。

这三个概念放在一起，就能理解为什么实现不是一个 `messages.slice(-N)`：只保留最后 N 条，可能切断一组 `tool_use` / `tool_result`，丢掉计划模式和已读取文件，也没有给摘要留下生成空间。

### 第一步：先算“真正可用”的窗口

`restored-src/src/services/compact/autoCompact.ts` 先为摘要输出预留 token，再返回有效窗口：

```ts
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}
```

。摘要预留量取“模型最大输出 token”与 `20_000` 的较小值。`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 未设置、不是十进制正整数或等于 0 时都被忽略；合法时只能缩小模型窗口，不能把它放大。

为什么要先减输出空间？因为压缩本身也要调用模型。如果输入已经把窗口塞满，系统即使决定压缩，也没有空间让模型写出摘要。这是一种典型的“给恢复动作预留资源”。

接着，自动压缩线从有效窗口中再减去固定缓冲：

```ts
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  const autocompactThreshold =
    effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}
```

`getAutoCompactThreshold(model)` 默认返回“有效窗口减 13,000”。`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 只接受大于 0 且不超过 100 的数字；合法时取百分比阈值和默认阈值的较小值，所以它同样只能让压缩更早发生。未设置、空字符串、`NaN`、负数、0 或超过 100 都回退到默认值。

注意，这里的 `13_000` 不是“窗口使用到 90%”之类的固定百分比。不同模型的窗口和最大输出不同，实际比例也不同。

### 第二步：估算 token，并排除不该递归压缩的调用

真正做判断的是 `shouldAutoCompact()`：

```ts
export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  snipTokensFreed = 0,
): Promise<boolean> {
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  if (!isAutoCompactEnabled()) {
    return false
  }

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )
  return isAboveAutoCompactThreshold
}
```

`messages` 是待发送的内部消息数组；`model` 决定窗口；`querySource` 可以是 `undefined`，也可以标记调用来源。源码在这里明确拦截 `'session_memory'` 和 `'compact'`，避免负责压缩的 forked Agent 再触发压缩而死锁；其他取值由项目的 `QuerySource` 类型和调用方决定，还存在受构建特性保护的额外分支，静态片段不应擅自穷举。`snipTokensFreed` 默认是 0，用来扣掉此前 snip 已估算释放、但旧 assistant usage 尚未反映出来的 token。

`tokenCountWithEstimation()` 这个名字也很重要：它不是保证精确的 tokenizer 计数，而是结合最近 API usage 与本地估算得到触发依据。因此这条线是容量保护机制，不是向用户展示的计费账单。

自动压缩还可以被关闭。`DISABLE_COMPACT` 会关闭整个压缩入口，`DISABLE_AUTO_COMPACT` 只关闭自动压缩、保留手工 `/compact`；否则读取用户配置中的 `autoCompactEnabled`。也就是说，“源码有自动压缩”不等于“每次运行都启用”。

### microcompact：先清理最肥的旧工具结果

完整摘要的成本比较高。更便宜的办法，是只处理历史里体积大的工具结果。这就是 microcompact 的直观模型：对话结构还在，只把较旧的 Read、Bash、Grep、Glob、WebSearch、WebFetch、Edit、Write 等结果做更细粒度的内容清理。

2.1.88 的入口在 `restored-src/src/services/compact/microCompact.ts`：

```ts
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  clearCompactWarningSuppression()

  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    return timeBasedResult
  }

  if (feature('CACHED_MICROCOMPACT')) {
    const mod = await getCachedMCModule()
    const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
    if (
      mod.isCachedMicrocompactEnabled() &&
      mod.isModelSupportedForCacheEditing(model) &&
      isMainThreadSource(querySource)
    ) {
      return await cachedMicrocompactPath(messages, querySource)
    }
  }

  return { messages }
}
```

`messages` 是候选历史；`toolUseContext` 和 `querySource` 都可为 `undefined`。没有上下文时，模型回退到 `getMainLoopModel()`；没有来源，`isMainThreadSource()` 把它视作主线程。函数先尝试基于时间的清理，再尝试受 `CACHED_MICROCOMPACT` 构建特性保护的 cache-editing 路径。条件不满足时原样返回 `{ messages }`，因为源码注释已经说明 legacy microcompact 路径被移除。

因此，不应把 microcompact 写成每轮必经步骤。外部构建、非支持模型、子 Agent 或关闭的远端开关都可能直接跳过它。它与完整 compact 的关系更像“能小修就先小修，小修不可用或仍不够时由自动压缩兜底”。

### 第三步：达到阈值后，优先复用 session memory

`autoCompactIfNeeded()` 把判断与执行接起来。主干可以缩成下面几行：

```ts
const shouldCompact = await shouldAutoCompact(
  messages,
  model,
  querySource,
  snipTokensFreed,
)
if (!shouldCompact) return { wasCompacted: false }

const sessionMemoryResult = await trySessionMemoryCompaction(
  messages,
  toolUseContext.agentId,
  recompactionInfo.autoCompactThreshold,
)
if (sessionMemoryResult) {
  runPostCompactCleanup(querySource)
  return { wasCompacted: true, compactionResult: sessionMemoryResult }
}

const compactionResult = await compactConversation(
  messages,
  toolUseContext,
  cacheSafeParams,
  true,
  undefined,
  true,
  recompactionInfo,
)
```

`messages`、`querySource` 与 `snipTokensFreed` 含义同前。`toolUseContext.agentId` 可以是 `undefined`，表示主会话；有值时用于隔离 Agent 相关状态。`autoCompactThreshold` 让 session memory 路径验证重建后的上下文仍低于触发线。`compactConversation()` 后三个关键参数依次是：`suppressFollowUpQuestions=true`，要求摘要后直接续做任务；`customInstructions=undefined`，表示自动压缩没有用户自定义摘要要求；`isAutoCompact=true`，让 Hook trigger 和错误提示走自动路径。

session memory 路径不是无条件存在。`shouldUseSessionMemoryCompaction()` 允许 `ENABLE_CLAUDE_CODE_SM_COMPACT` 强制开启、`DISABLE_CLAUDE_CODE_SM_COMPACT` 强制关闭；两者都没有命中时，还要求 `tengu_session_memory` 与 `tengu_sm_compact` 两个远端开关都为真，源码中的默认回退是 `false`。即便启用，memory 文件不存在、仍是空模板、找不到上次摘要边界，或者压缩结果仍超过阈值，都会返回 `null`，继续传统摘要路径。

session memory 能用时，它会保留一段近期原始消息。默认配置是至少 10,000 token、至少 5 条含文本块的消息，最多 40,000 token；远端配置只有显式给出正数时才覆盖这些默认值。扩展保留区时，代码还会调整边界，避免拆开 `tool_use` 与 `tool_result`。

这解释了“保留什么”的第一层答案：不是单靠摘要。已经提炼的 session memory 加近期逐字消息，能够减少摘要漂移对正在执行任务的影响。

### 第四步：传统 compact 让一个受限 Agent 写摘要

完整压缩入口的签名如下：

```ts
export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
): Promise<CompactionResult>
```

`messages` 是要总结的消息；`context` 提供模型、工具、文件读取状态、取消信号和 Hook 回调；`cacheSafeParams` 带入可安全复用的缓存前缀参数。`suppressFollowUpQuestions` 为 `true` 时，压缩后的提示要求模型直接继续，不再向用户追问；`customInstructions` 可为任意摘要补充要求，`undefined` 表示没有，空字符串在合并 Hook 指令时也会归一化为 `undefined`。`isAutoCompact` 默认 `false`，区分手工与自动触发。`recompactionInfo` 可为 `undefined`，有值时只携带重复压缩、间隔轮数、前次 turn id、阈值和来源等跟踪信息。

函数首先执行 `PreCompact` Hook，把用户指令与 Hook 返回的新指令合并；然后构造摘要请求。摘要 Agent 的工具权限被固定拒绝：

```ts
export function createCompactCanUseTool(): CanUseToolFn {
  return async () => ({
    behavior: 'deny' as const,
    message: 'Tool use is not allowed during compaction',
    decisionReason: {
      type: 'other' as const,
      reason: 'compaction agent should only produce text summary',
    },
  })
}
```

`createCompactCanUseTool()` 没有参数，返回的权限函数无论收到什么工具请求都给出 `behavior: 'deny'`。这里没有 `allow` 或 `ask` 分支，原因也写得很直接：压缩 Agent 只应生成文本摘要。这样设计避免它在“总结历史”时再次修改文件或启动任务。

摘要默认尝试 forked Agent 复用主会话的缓存前缀，失败后回退到普通流式调用。普通路径关闭 thinking，只提供 FileRead 与按条件加入的 ToolSearch/MCP 工具定义，但前面的权限函数仍会拒绝实际工具调用。若流式请求没有产出 assistant 响应，`tengu_compact_streaming_retry` 默认是 `false`，因此默认只尝试 1 次；开关为真时，`MAX_COMPACT_STREAMING_RETRIES` 使最多尝试 2 次。

还有一种反直觉的失败：压缩请求本身也可能 prompt too long。实现会按 API round 从头部截掉最旧分组后重试，而不是把半截摘要写回会话；摘要为空、返回 API error 文本或最终仍过长都会抛错。

### 完整压缩与局部压缩，差别在“哪一段保留原文”

手工选择消息时可以走 `partialCompactConversation()`：

```ts
export async function partialCompactConversation(
  allMessages: Message[],
  pivotIndex: number,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  userFeedback?: string,
  direction: PartialCompactDirection = 'from',
): Promise<CompactionResult>
```

`allMessages` 是完整历史；`pivotIndex` 是选中消息的数组下标；`context` 与 `cacheSafeParams` 含义同完整压缩。`userFeedback` 可为 `undefined`，有内容时会变成摘要的 `User context`。`direction` 只有源码确认的 `'from'` 与 `'up_to'`，默认 `'from'`：`'from'` 总结 pivot 之后的消息、保留更早前缀，因而有机会保住 prompt cache；`'up_to'` 总结 pivot 之前的消息、保留近期后缀，但摘要会插在保留消息之前，缓存前缀会改变。

局部压缩还会过滤 `progress` 消息，并给保留段写入 `headUuid`、`anchorUuid`、`tailUuid`。这不是为了给模型看，而是让 transcript loader 在磁盘上的旧父子关系与新消息链之间重新接线。也就是说，消息在内存里顺序正确还不够，恢复会话时也必须能沿 UUID 链走到同一段历史。

### 第五步：把摘要和运行状态按固定顺序装回去

压缩的输出不是一个字符串，而是 `CompactionResult`。统一重建函数只有几行，却是整章最关键的证据：

```ts
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
}
```

`result` 是任一压缩路径产生的结构化结果。`messagesToKeep` 是可选字段，`undefined` 时通过 `?? []` 回退为空数组。顺序固定为：`boundaryMarker`、摘要消息、保留消息、附件、Hook 结果。调用图显示 `queryLoop()`、手工 `/compact`、session memory compact 与 teammate 路径都会消费这个函数。

为什么要有 boundary？它标记旧上下文已经被折叠，还记录触发类型（源码可见 `'auto'` 或 `'manual'`）、压缩前 token 数、旧链尾 UUID，以及局部压缩的保留段元数据。加载 transcript 时，运行时可以据此丢弃边界前的冗长消息，同时保留恢复关系。

摘要消息会明确告诉模型：当前会话从一次耗尽上下文的旧对话继续，下面是早期历史摘要；如果有 transcript 路径，还会提示需要精确代码、错误或旧输出时去读取原记录。自动压缩把 `suppressFollowUpQuestions` 设为 `true`，所以还会追加“直接从中断处继续，不要再次向用户提问”的指令。

附件负责补回摘要不适合承载的运行状态。传统完整压缩会重新生成最近读取文件、计划文件、plan mode、已调用 Skill、异步 Agent 状态，以及 deferred tools、Agent 列表和 MCP 指令的 delta。文件恢复的源码边界很具体：最多 5 个文件、每个最多 5,000 token、总预算 50,000 token；Skill 每个最多 5,000 token、总预算 25,000 token。文件按读取时间倒序，已在保留消息中出现的 Read 结果会跳过，CLAUDE.md 与 plan 文件也走各自专门路径，不在普通文件恢复里重复注入。

这就是“保留什么”的第二层答案：摘要保存语义，近期消息保存原话，附件保存可执行状态。三者职责不同，不能互相替代。

### 第六步：成功后清缓存，失败时保留原会话

压缩成功后，`runPostCompactCleanup()` 会重置 microcompact 状态、system prompt 分段缓存、权限分类器审批、推测性检查、beta tracing 和 session messages cache。主线程压缩还会清理 CLAUDE.md 相关 memoized cache，让下一轮重新加载项目指令。它特意不重置已发送 Skill 名称，源码注释给出的原因是避免每次压缩后重新注入约 4K token 的完整 skill listing；已经调用过的 Skill 内容由附件保留。

`runPostCompactCleanup(querySource?)` 的 `querySource` 可为 `undefined`。源码把 `undefined`、以 `'repl_main_thread'` 开头的来源和 `'sdk'` 视为主线程压缩；子 Agent 与其他 fork 共享进程级状态，因此不会清掉主线程的 context-collapse 与 memory cache。

失败路径同样值得看。`compactConversation()` 只有在拿到有效摘要并完成附件、Hook 与边界构造后才返回新的 `CompactionResult`。异常向上抛出，调用者不会用半成品替换原消息。自动压缩失败时，`autoCompactIfNeeded()` 返回 `wasCompacted: false`，并累计 `consecutiveFailures`；连续失败达到 3 次后熔断，后续不再每轮重复打一个注定失败的压缩请求。手工压缩会显示错误通知，自动压缩则不立即打扰用户，因为下一轮还可能重试成功。

这里可以把整个机制压缩成六步：

1. 从模型窗口中先扣掉摘要输出预留，再得到自动压缩阈值。
2. 用 API usage 加本地估算判断 token 压力，同时避开压缩 Agent 的递归调用。
3. 能做 microcompact 时先清理旧工具结果；条件不满足就原样通过。
4. 达到阈值后，优先尝试 session memory 加近期原文，失败再生成传统摘要。
5. 按 boundary、summary、保留消息、attachments、hook results 重建消息链。
6. 成功后清理会污染下一轮的缓存；失败时不提交半成品，并用三次失败熔断保护 API。



源码可以直接确认默认常量、环境变量校验、消息重建顺序、Hook 触发点、工具拒绝策略、附件预算和失败熔断。调用图还能确认 `queryLoop()` 会消费 `buildPostCompactMessages()`，因此压缩结果会回到同一条 Agent 循环，而不是启动一个无关会话。

但远端 GrowthBook/Statsig 值、内部构建保留哪些 `feature()` 分支、某个提供商是否支持缓存编辑，都属于运行时条件。

因此，工程上应把 compaction 理解为一种有损、可恢复的状态迁移：平时依靠摘要和附件继续工作，需要精确细节时再回到 transcript 或文件系统取证。

## 小结

Claude Code 让长会话继续运行，靠的不是无限扩展窗口，而是分层减负与结构化重建。

它先给摘要留出空间，再用 token 阈值判断压力；microcompact 负责可选的小粒度清理，session memory 路径尽量保留近期原文，传统 compact 则用受限 Agent 生成摘要。最终，`buildPostCompactMessages()` 把边界、摘要、保留消息、附件与 Hook 结果装成新的上下文，交回 `queryLoop()` 继续执行。

这个设计接受了摘要有损的现实，同时保留 transcript、文件附件、计划、Skill 和 UUID 重连信息作为恢复线索。也正因为压缩前后横跨了模型调用、消息持久化、缓存和项目状态，它需要一套生命周期扩展点，让外部逻辑在关键节点参与。

## 留给下一篇的问题

上下文压缩解决了窗口限制以后，Claude Code 的 Hooks 如何在生命周期节点观察、改写、阻止或扩展一次运行？

