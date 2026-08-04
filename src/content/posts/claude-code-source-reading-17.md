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

上一篇留下的问题是：你知道 Claude Code 出现过什么 bug，导致 prompt cache 大规模失效吗？

先说最典型、也最容易被误读的一类：**resume/continue 重建会话时改变了原本应该稳定的 prompt 前缀。** 受控测试记录了 `--continue` / `/resume` 在几秒内重新进入同一会话，`cache_read` 仍然降到 0，随后 400–500k token 被重新写入；进一步的版本分析认为，v2.1.69 引入的 `deferred_tools_delta` 在恢复 transcript 时重新排列了工具结果，导致字节级前缀不再相同。这不是“缓存 TTL 到期”，而是客户端重建出的请求已经不是同一个前缀。

这类改动会造成大面积失效，是因为缓存不是按“语义相同”命中，而是从请求开头做 prefix match。系统提示、工具定义、项目上下文和会话内容只要在前面发生一个字节级变化，变化点之后全部都要重新 cache write。工具顺序非确定、工具参数变化、把动态时间戳塞进静态 system prompt、切换模型或增删 MCP 工具，都可能造成同样的结果。

所以可以把问题分成三层：

- **恢复 bug**：`--resume` / `--continue` 重新序列化 transcript 后，把 `system-reminder`、deferred tool 结果或工具顺序放到了不同位置；长会话的稳定前缀被破坏，表现是一次性 `cache_read=0` 和大规模 `cache_creation`。
- **正常的主动失效**：切换模型、MCP 连接变化、`/compact`、升级 Claude Code 本来就会改变缓存边界。它们是设计上的重新建缓存，不应和恢复 bug 混为一谈。
- **TTL 过期**：等待超过缓存 TTL 会自然重建缓存；这解释“隔一段时间后变贵”，但不能解释几秒内 resume 就全量重建。

回到 `2.1.88` 的源码，最值得盯的是 `getSystemPrompt`、tool schema 装配和 transcript resume 重建：稳定 section 的顺序、`cacheBreak` 边界、MCP/tool list、`system-reminder` 的插入点，任何一个变化都会改变下一次请求的前缀。源码里看到的“恢复后 Skills/system 信息位置变化、约 3800 token cache recreate”正是这个机制的缩小版；长会话再叠加大量工具定义，就会放大成数十万 token 的重建。

因此，问题的根因不是“Anthropic 的缓存偶尔抽风”，而是 **客户端把同一会话重新编码成了不同的前缀**。排查时不要只看总 token：同时比较相邻请求的 `cache_read_input_tokens`、`cache_creation_input_tokens`、模型 ID、工具列表顺序、system prompt hash 和 resume 前后的 message JSON。若只发生一次且伴随模型/MCP/compact/升级，属于预期失效；若几秒内 resume 就全量重写，优先按恢复序列化或 tool-order regression 定位。

## 问题现场

长会话的故障通常不是模型突然“失忆”，而是下一次请求已经没有空间同时容纳系统提示、工具定义、项目指令、旧消息和本轮输出。Claude Code 要做的不是简单截断，而是把一段仍在运行的消息链迁移到更短的表示，并保证 `queryLoop()` 能从新边界继续。

![上下文压缩后的信息保留与再水化](/images/posts/claude-code-source-reading-17/17-compaction-rehydration-detail-handdrawn.png)

本文的核心判断是：压缩是一次可回退的上下文重建。token 估算决定何时动手，microcompact 和 session memory 决定先丢什么，`buildPostCompactMessages()` 决定哪些状态能够重新接回主循环。

## 压缩是一场可继续执行的上下文重建

证据边界固定在本仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原的 `restored-src/`。阅读时可以把压缩看成一条事务：先算阈值，再生成结果，最后一次性替换消息；中间任何一步失败，旧上下文都应保持可用。

![Claude Code 上下文压缩流程：阈值判断、摘要生成与消息链重建](/images/posts/claude-code-source-reading-17/17-context-compaction-handdrawn.png)

### 三个概念如何约束压缩策略

请求窗口同时承载输入、输出、system prompt、工具 Schema、`CLAUDE.md`、附件和工具结果，所以 `shouldAutoCompact()` 看的是整次请求的 token 预算，而不是屏幕上有多少轮对话。压缩后的摘要只是可继续执行的表示；需要逐字细节时，系统仍保留 transcript 和文件附件作为回查入口。由于 prompt cache 依赖稳定前缀，任何消息重排都会改变压缩后的缓存边界。

这三个概念放在一起，就能理解实现为何采用结构化重建：简单保留最后 N 条会切断一组 `tool_use` / `tool_result`，丢掉计划模式和已读取文件，也会挤占摘要的生成空间。

## 一张金额单位工单变成长会话以后

上午 09:12，值班工程师把“结算页显示 99.90 元、支付回调却记录为 9991 分”的金额单位工单交给 Claude Code。到 11:26，会话里已经有了支付服务的目录树、金额转换函数、回调样例、issue-tracker 返回的历史记录、Chrome 截图、三个 teammate 的调查结论，以及一条正在后台跑的集成测试。每一段单独看都不大，合在同一个上下文里，却同时占着旧消息、工具 Schema、项目规则和本轮输出的空间。

终端出现上下文接近上限的提示后，工程师先确认当前没有待批准的写入，然后输入：

> /compact

他去参加午间发布会，12:07 又从 Remote Control 接回来，输入：

> 继续处理这张金额单位工单。先恢复已经确认的根因、当前 worktree、后台测试、teammate 状态和待决权限，再完成验证；不要重新执行已经成功的副作用。

这两次输入之间，真正需要保留的不是每一句寒暄，而是“已经读过哪些文件、哪个假设被证伪、哪些工具调用已经产生副作用、哪一个测试仍在运行”。Claude Code 会根据窗口预算选择 microcompact 或完整 compact，重建摘要和可用上下文；远端继续时读取的是已经持久化的 transcript、摘要和 session memory，而不是试图恢复一段已经消失的内存循环。下面从 token 预算开始，解释这场可继续的上下文重建。

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

摘要预留量取“模型最大输出 token”与 `20_000` 的较小值。`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 未设置、解析失败或小于等于 0 时都被忽略；合法时只能缩小模型窗口，不能把它放大。

为什么要先减输出空间？因为压缩本身也要调用模型。输入塞满窗口会挤占摘要输出空间，因此系统预先为恢复动作保留资源。

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

注意，这里的 `13_000` 是固定绝对缓冲；不同模型的窗口和最大输出不同，实际比例也会变化。

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

`tokenCountWithEstimation()` 结合最近 API usage 与本地估算生成压缩触发依据，服务于容量保护；面向用户的计费数字仍由 API usage 提供。

自动压缩还可以被关闭。`DISABLE_COMPACT` 会关闭整个压缩入口，`DISABLE_AUTO_COMPACT` 只关闭自动压缩、保留手工 `/compact`；否则读取用户配置中的 `autoCompactEnabled`。环境开关与用户配置共同决定本次运行是否启用。

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

`messages` 是候选历史；`toolUseContext` 和 `querySource` 都可省略。省略上下文时，模型回退到 `getMainLoopModel()`；省略来源时，`isMainThreadSource()` 选择主线程分支。函数先尝试基于时间的清理，再尝试受 `CACHED_MICROCOMPACT` 构建特性保护的 cache-editing 路径。条件不满足时原样返回 `{ messages }`，因为源码注释已经说明 legacy microcompact 路径被移除。

因此，不应把 microcompact 写成每轮必经步骤。外部构建、非支持模型、子 Agent 或关闭的远端开关都可能直接跳过它。它与完整 compact 的关系更像“能小修就先小修，小修不可用或仍不够时由自动压缩兜底”。

### 第三步：达到阈值后，优先复用 session memory

这里先定义 `session memory`：它是当前会话目录下的一份结构化 Markdown 笔记，由后台的隔离 Agent 从用户对话中提炼，用来在压缩或恢复时保留任务状态。它不是完整 transcript，也不是 `CLAUDE.md` 或 system prompt 的副本；它保存的是可继续执行所需的目标、约束、关键文件、错误和恢复线索。

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

`messages`、`querySource` 与 `snipTokensFreed` 含义同前。省略 `toolUseContext.agentId` 时，状态归入主会话；提供 ID 时则按 Agent 隔离。`autoCompactThreshold` 让 session memory 路径验证重建后的上下文仍低于触发线。`compactConversation()` 后三个关键参数依次是：`suppressFollowUpQuestions=true`，要求摘要后直接续做任务；省略 `customInstructions`，使摘要 prompt 只采用默认要求与 Hook 成功返回的补充指令；`isAutoCompact=true`，让 Hook trigger 和错误提示走自动路径。

**字段说明：** `shouldCompact` 为假时返回 `wasCompacted: false`；session memory 或传统摘要成功时返回 `wasCompacted: true`，并把结果写入 `compactionResult`。局部变量 `sessionMemoryResult` 与 `compactionResult` 分别承接两条摘要路径。

session memory 路径受环境变量与远端开关共同控制。`shouldUseSessionMemoryCompaction()` 允许 `ENABLE_CLAUDE_CODE_SM_COMPACT` 强制开启、`DISABLE_CLAUDE_CODE_SM_COMPACT` 强制关闭；两者均未设置时，还要求 `tengu_session_memory` 与 `tengu_sm_compact` 同时为真，源码中的默认回退是 `false`。即便启用，memory 文件缺失、仍是空模板、上次摘要边界缺失，或者压缩结果仍超过阈值，都会返回 `null` 并继续传统摘要路径。

session memory 能用时，它会保留一段近期原始消息。默认配置是至少 10,000 token、至少 5 条含文本块的消息，最多 40,000 token；远端配置只有显式给出正数时才覆盖这些默认值。扩展保留区时，代码还会调整边界，避免拆开 `tool_use` 与 `tool_result`。

这解释了“保留什么”的第一层答案：已经提炼的 session memory 与近期逐字消息共同提供上下文，减少摘要漂移对正在执行任务的影响。

### session memory 中到底有什么

具体实现是当前会话目录下的 Markdown 文件：`{projectDir}/{sessionId}/session-memory/summary.md`。文件由一个隔离的 forked Agent 读取和编辑；更新提示明确要求它只根据用户对话写入笔记，不把 system prompt、CLAUDE.md、过去的 session summary 或“正在做笔记”的指令混进内容。压缩时，`getSessionMemoryContent()` 读取这份文件，`createCompactionResultFromSessionMemory()` 把它包进摘要消息，而不是再次调用 compact API。

默认模板固定了 10 个 section，真正可变的是每个斜体说明下面的内容：

1. **Session Title**：5–10 个词的高信息密度会话标题。
2. **Current State**：当前正在做什么、哪些任务未完成、下一步是什么。
3. **Task specification**：用户要求、设计决定和必要的背景解释。
4. **Files and Functions**：关键文件、函数，以及它们为什么重要。
5. **Workflow**：常用命令、执行顺序和不明显的输出解释。
6. **Errors & Corrections**：遇到的错误、修复方式、用户纠正过的方向，以及不要重试的失败方案。
7. **Codebase and System Documentation**：重要系统组件及其关系和工作方式。
8. **Learnings**：有效做法、无效做法和需要避免的经验，不能重复其他 section。
9. **Key results**：用户要求的答案、表格或文档等结果的完整内容。
10. **Worklog**：按步骤记录已经尝试和完成的事情，要求非常简短。

模板本身还保留每个 section 的斜体说明；Agent 只能改说明下面的正文，不能改 section 标题或说明。

这份 memory 有两层预算。更新 prompt 会把总量控制在约 12,000 token，每个 section 超过约 2,000 token 会要求 Agent 压缩；真正插入 compact 消息时又按每 section 约 2,000 token（源码用字符数近似）截断，截断后会在对应位置放入 `[... section truncated for length ...]`，并告诉模型完整文件路径。也就是说，session memory 保存的是“可继续执行任务所需的结构化状态”：当前状态、约束、关键证据和恢复线索，而不是逐字保留所有历史。

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

`messages` 是要总结的消息；`context` 提供模型、工具、文件读取状态、取消信号和 Hook 回调；`cacheSafeParams` 带入可安全复用的缓存前缀参数。`suppressFollowUpQuestions` 为 `true` 时，压缩后的提示要求模型直接继续；`customInstructions` 有内容时追加摘要要求，省略或传空字符串时不增加用户定制段。`isAutoCompact` 默认 `false`，区分手工与自动触发。`recompactionInfo` 有值时携带重复压缩、间隔轮数、前次 turn id、阈值和来源等跟踪信息；省略时跳过这组重压缩元数据。

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

`createCompactCanUseTool()` 的函数签名为空参，返回的权限函数对所有工具请求都给出 `behavior: 'deny'`；`allow` 与 `ask` 均不在该权限函数的联合分支中。压缩 Agent 因此只生成文本摘要，无法在“总结历史”时再次修改文件或启动任务。

**字段说明：** 返回对象的 `message` 是面向调用方的拒绝文本，`decisionReason.type` 固定为 `'other'`，`decisionReason.reason` 说明压缩 Agent 只能生成文本摘要。

摘要默认尝试 forked Agent 复用主会话的缓存前缀，失败后回退到普通流式调用。普通路径关闭 thinking，只提供 FileRead 与按条件加入的 ToolSearch/MCP 工具定义，但前面的权限函数仍会拒绝实际工具调用。若流式输出缺少 assistant 响应，`tengu_compact_streaming_retry` 默认是 `false`，因此默认只尝试 1 次；开关为真时，`MAX_COMPACT_STREAMING_RETRIES` 使最多尝试 2 次。

还有一种反直觉的失败：压缩请求本身也可能 prompt too long。实现会按 API round 从头部截掉最旧分组后重试，半截摘要始终不会写回会话；摘要为空、返回 API error 文本或最终仍过长都会抛错。

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

局部压缩还会过滤 `progress` 消息，并给保留段写入 `headUuid`、`anchorUuid`、`tailUuid`。这些 UUID 供 transcript loader 在磁盘上的旧父子关系与新消息链之间重新接线；恢复会话时也必须能沿 UUID 链走到同一段历史。

### 第五步：把摘要和运行状态按固定顺序装回去

压缩输出采用 `CompactionResult` 结构。统一重建函数只有几行，却是整章最关键的证据：

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



源码可以直接确认默认常量、环境变量校验、消息重建顺序、Hook 触发点、工具拒绝策略、附件预算和失败熔断。调用图还能确认 `queryLoop()` 会消费 `buildPostCompactMessages()`，因此压缩结果会回到同一条 Agent 循环。

但远端 GrowthBook/Statsig 值、内部构建保留哪些 `feature()` 分支、某个提供商是否支持缓存编辑，都属于运行时条件。

因此，工程上应把 compaction 理解为一种有损、可恢复的状态迁移：平时依靠摘要和附件继续工作，需要精确细节时再回到 transcript 或文件系统取证。

## 小结

Claude Code 通过分层减负与结构化重建，让长会话在有限窗口中继续运行。

它先给摘要留出空间，再用 token 阈值判断压力；microcompact 负责可选的小粒度清理，session memory 路径尽量保留近期原文，传统 compact 则用受限 Agent 生成摘要。最终，`buildPostCompactMessages()` 把边界、摘要、保留消息、附件与 Hook 结果装成新的上下文，交回 `queryLoop()` 继续执行。

这个设计接受了摘要有损的现实，同时保留 transcript、文件附件、计划、Skill 和 UUID 重连信息作为恢复线索。也正因为压缩前后横跨了模型调用、消息持久化、缓存和项目状态，它需要一套生命周期扩展点，让外部逻辑在关键节点参与。

## 留给下一篇的问题

当 /compact 进行到一半时，你手动中断，然后再次执行 /compact，你觉得压缩还能继续进行吗？

## 参考资料

- [Session resume invalidates entire prompt cache · Issue #42338](https://github.com/anthropics/claude-code/issues/42338)
- [Lessons from building Claude Code: Prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)
- [Claude Code 上下文窗口](https://code.claude.com/docs/en/context-window)

- [Claude Code 的工作方式](https://code.claude.com/docs/en/how-claude-code-works)
