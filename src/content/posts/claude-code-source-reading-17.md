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

先给答案：一类典型原因是恢复会话时重新构造了一个“不完全相同”的 prompt 前缀。GitHub issue [#42338](https://github.com/anthropics/claude-code/issues/42338) 记录的复现是，`--continue` 只间隔几秒重新进入会话，`cache_read` 仍然变成 0，随后大约 512k token 被重新写入缓存。issue 将问题指向恢复流程中的 `deferred_tools_delta`：它改变了工具结果的排列，导致原本可以命中的前缀发生字节级变化。

这和缓存“自然过期”不是一回事。Anthropic 的 [prompt caching 文档](https://code.claude.com/docs/en/prompt-caching)说明，缓存按前缀做精确匹配；系统提示、工具定义、项目上下文和会话消息构成了前缀链，前面某一层发生变化，后面的缓存就不能继续复用。官方的[会话管理说明](https://claude.com/blog/using-claude-code-session-management-and-1m-context)也把 `/compact` 描述成“总结历史后继续”，而不是恢复一段原封不动的请求。

因此要把三件事分开：

- `resume/continue` 重建顺序发生回归，属于恢复 bug；
- `/compact`、模型切换、MCP 工具变化等主动改变请求前缀，属于设计上的重新建缓存；
- 等待超过缓存生命周期后自然重建，属于 TTL 到期。

本仓库的 `restored-src/` 可以确认压缩之后如何重建消息、怎样重新附加工具和项目状态，但不能单凭静态源码证明上述 issue 的线上复现，也不能把后续版本的修复结论倒灌到当前源码。至于本文的“四把手术刀”这个比喻，背景来自[源码泄露文章对四种压缩粒度的概括](https://juejin.cn/post/7623258895395110966)；下面的控制流和字段，以仓库中能直接读到的源码为准。

## 本章先建立四把手术刀的概念

长会话遇到压力时，Claude Code 不是立刻把旧消息全部交给模型总结。当前源码把动作拆成不同粒度：

| 机制 | 它直接改变什么 | 需要模型总结吗 | 结果怎样回到主循环 |
| --- | --- | --- | --- |
| `HISTORY_SNIP` | 删除选中的消息，并修复剩余消息的父子链 | 不需要 | 产生 snip 视图，必要时写入 boundary 元数据 |
| `Microcompact` | 清空旧 `tool_result` 内容，或向 API 提交缓存编辑 | 不需要 | 返回原消息或内容被替换的消息 |
| `CONTEXT_COLLAPSE` | 把旧消息区间归档，并投影出较短的读取视图 | 实现文件不在当前 source map，无法静态确认 | 通过 commit log / snapshot 重放视图 |
| `Autocompact` | 用 session memory 或模型摘要重建消息集合 | 传统路径需要；session memory 路径复用已提取内容 | 写入 compact boundary，再拼接摘要、保留消息和附件 |

四者并不是四个互斥的 `if/else` 分支。`HISTORY_SNIP` 和 Microcompact 可以在同一次 query 中先后执行；Context Collapse 先投影上下文，只有仍然需要时才进入最后的压缩判断；Autocompact 内部又会先尝试 session memory，失败后才走传统的模型摘要。

![四种上下文压缩机制：从局部删除到完整重建](/images/posts/claude-code-source-reading-17/17-four-scalpels-handdrawn.png)

这里先标出一个很重要的源码边界：当前 `restored-src/` 能看到 `snipCompact.js`、`snipProjection.js`、`cachedMicrocompact.js` 和 `contextCollapse` 的调用点、类型、持久化逻辑，但对应的 gated implementation 并不完整。因此本文可以确定“它怎样接入、返回什么、怎样持久化”，不能臆造 snip 的选择启发式、缓存编辑器的具体删除策略，或 Context Collapse 的风险评分和提交阈值。

## 从一个长会话看总调度顺序

还是用这张金额单位工单来观察。调查过程中，Claude Code 读过支付服务的目录、金额转换函数、回调样例和历史 issue，还启动了测试并让 teammate 在后台检查数据库。真正必须保留的是：

- 已经确认的根因和被证伪的假设；
- 工具调用产生的副作用及其结果；
- 当前 worktree、后台任务和计划状态；
- 尚未完成但下一轮必须接着做的动作。

不需要保留的是每次目录搜索的全部重复输出。`queryLoop()` 在每次请求前先拿到 compact boundary 之后的消息，再按顺序执行四把刀。下面是 `restored-src/src/query.ts` 的核心片段；工具结果预算、checkpoint 和 UI 分支略去：

~~~
let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

// 这里还会先做 tool-result budget 处理

let snipTokensFreed = 0
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
  if (snipResult.boundaryMessage) {
    yield snipResult.boundaryMessage
  }
}

const microcompactResult = await deps.microcompact(
  messagesForQuery,
  toolUseContext,
  querySource,
)
messagesForQuery = microcompactResult.messages

if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    messagesForQuery,
    toolUseContext,
    querySource,
  )
  messagesForQuery = collapseResult.messages
}

const { compactionResult } = await deps.autocompact(
  messagesForQuery,
  toolUseContext,
  {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages: messagesForQuery,
  },
  querySource,
  tracking,
  snipTokensFreed,
)
~~~

这个顺序本身就是设计：先做局部、便宜、不会生成摘要的处理，再尝试投影旧上下文，最后才允许一次完整重建。`snipTokensFreed` 还会传给 Autocompact，因为 snip 已经删除了内容，但最后一个 assistant message 里的历史 usage 可能仍然反映删除前的大小。

## 第一刀：HISTORY_SNIP 只剪掉已经不值得携带的消息

### 接入点：功能开关和读取投影

`query.ts` 只在 `feature('HISTORY_SNIP')` 为真时动态加载 snip 模块。读取历史时，`getMessagesAfterCompactBoundary()` 还会决定是否把已经剪掉的消息从当前视图中投影掉：

~~~
export function getMessagesAfterCompactBoundary<
  T extends Message | NormalizedMessage,
>(
  messages: T[],
  options?: { includeSnipped?: boolean },
): T[] {
  const boundaryIndex = findLastCompactBoundaryIndex(messages)
  const sliced = boundaryIndex === -1 ? messages : messages.slice(boundaryIndex)

  if (!options?.includeSnipped && feature('HISTORY_SNIP')) {
    const { projectSnippedView } =
      require('../services/compact/snipProjection.js')
    return projectSnippedView(sliced as Message[]) as T[]
  }
  return sliced
}
~~~

这里有两个容易漏掉的参数语义：

- `options` 可以是 `undefined`；没有 options 时仍然默认投影 snipped view。
- `includeSnipped` 是可选布尔值，默认等价于 `false`。传 `true` 时跳过投影，返回最后一个 compact boundary 之后的原始切片；功能开关关闭时也直接返回切片。

所以 `HISTORY_SNIP` 不是“把数组截成最后 N 条”。它保留了完整 transcript 的可能性，同时在 query 读取和恢复时使用一个不包含已剪片段的视图。

### 删除消息之后，还要修复 transcript 链

snip 的 boundary 元数据里会带 `removedUuids`。恢复 transcript 时，`applySnipRemovals()` 做的事情可以概括成：

~~~
const toDelete = new Set<UUID>()
for (const entry of messages.values()) {
  for (const uuid of entry.snipMetadata?.removedUuids ?? []) {
    toDelete.add(uuid)
  }
}

const deletedParent = new Map<UUID, UUID | null>()
for (const uuid of toDelete) {
  const entry = messages.get(uuid)
  if (!entry) continue
  deletedParent.set(uuid, entry.parentUuid)
  messages.delete(uuid)
}

for (const [uuid, msg] of messages) {
  if (!msg.parentUuid || !toDelete.has(msg.parentUuid)) continue
  messages.set(uuid, {
    ...msg,
    parentUuid: resolveThroughDeletedChain(msg.parentUuid, deletedParent),
  })
}
~~~

实际实现还会对删除链做路径压缩。也就是说，snip 允许删除中间的一段消息，而不是只能从头部或尾部截断；剩余消息的 `parentUuid` 会越过被删节点，重新连到仍存在的祖先。这样 `--resume` 读取 transcript 时不会留下悬空父节点。

`QueryEngine` 还注册了一个 replay hook：如果重放过程中遇到 snip boundary，就用 `{ force: true }` 重新计算一次 snip 结果。这说明 snip 不是一次只存在于内存的数组操作，它要在“实时 query”和“从 transcript 恢复”两条路径上保持一致。

### 这把刀的源码边界

当前 source map 没有 `snipCompact.js` 和 `snipProjection.js` 的主体实现，所以可以确认：

- 输出至少包含新的 `messages`、已释放 token 数 `tokensFreed`，以及可选的 boundary message；
- 被删除的 UUID 会进入 transcript 元数据，并在恢复时删除、重连；
- queryLoop 会用 `tokensFreed` 修正 Autocompact 的阈值判断。

但不能从当前文件确认“哪些 tool result 一定会被选中”、选择窗口和触发阈值是什么。把“它会清理巨大的旧工具输出”作为设计意图是合理推断，把它写成当前源码已经列出的固定规则则越过了证据边界。

## 第二刀：Microcompact 优先削减工具结果的成本

### 入口函数的三组参数

Microcompact 的入口是：

~~~
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult>
~~~

`messages` 是必需的当前消息视图；`toolUseContext` 可以是 `undefined`，这种情况下缓存编辑路径会退回 `getMainLoopModel()` 获取模型；`querySource` 也是可选的，缓存编辑路径会用它判断这是不是主线程。`QuerySource` 不是任意字符串都能在静态源码中穷举，当前实现明确区分了主线程和 session memory、prompt suggestion 等 forked agent。

入口先运行 time-based microcompact。如果它成功，就直接返回；否则在 `CACHED_MICROCOMPACT` 功能开关打开、模型受支持且当前是主线程时，才尝试缓存编辑路径：

~~~
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
~~~

这里的 `return { messages }` 很重要：外部构建、不支持的模型、子 agent 或功能未打开时，Microcompact 可以完全不动作，后续压力交给 Autocompact。

### 路径一：时间间隔触发时直接改内容

时间路径的配置来自动态配置 `tengu_slate_heron`，静态默认值是：

~~~
const TIME_BASED_MC_CONFIG_DEFAULTS: TimeBasedMCConfig = {
  enabled: false,
  gapThresholdMinutes: 60,
  keepRecent: 5,
}
~~~

这些不是所有运行时环境都必然采用的值：`getTimeBasedMCConfig()` 会读取远程配置，动态配置可以覆盖它们。源码能确认的控制流是，只有配置启用、query 来源符合条件、最近一个 assistant 的时间戳可用，且时间间隔超过 `gapThresholdMinutes` 时，才会产生 trigger。

触发后，代码先收集源码定义的 `COMPACTABLE_TOOLS` 对应的 tool use ID，按出现顺序保留最后 `keepRecent` 个；实际保留数会经过 `Math.max(1, config.keepRecent)`，避免 `keepRecent` 为 0 时把所有结果都清空。然后遍历 user message 的 content block：

~~~
if (
  block.type === 'tool_result' &&
  clearSet.has(block.tool_use_id) &&
  block.content !== TIME_BASED_MC_CLEARED_MESSAGE
) {
  tokensSaved += calculateToolResultTokens(block)
  touched = true
  return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
}
~~~

它保留 `tool_result` block 和 `tool_use_id`，只把旧结果内容替换成固定的 cleared marker。因此这不是删除工具调用，也不是让模型重新总结，而是把已经不值得重复发送的大段结果变成一个短占位符。

如果没有可清除的结果，或估算出来的 `tokensSaved` 为 0，函数返回 `null`，入口继续尝试缓存编辑路径。成功清理后还会重置 Microcompact 的模块状态，并通知 prompt-cache break detector：下一次 cache read 变小是本次主动清理造成的，不应被当成异常断缓存。

### 路径二：缓存编辑时消息本身可以不变

缓存编辑路径会先把当前 user message 中可压缩的 tool result 注册到缓存编辑器，再询问哪些结果需要删除：

~~~
const toolsToDelete = mod.getToolResultsToDelete(state)

if (toolsToDelete.length > 0) {
  const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
  if (cacheEdits) {
    pendingCacheEdits = cacheEdits
  }

  return {
    messages,
    compactionInfo: {
      pendingCacheEdits: {
        trigger: 'auto',
        deletedToolIds: toolsToDelete,
        baselineCacheDeletedTokens: baseline,
      },
    },
  }
}
~~~

这里 `messages` 原样返回。`cache_reference` 和 `cache_edits` 会在 API 层附加，boundary 也要等 API 返回真实的 `cache_deleted_input_tokens` 后再写入。这样客户端不必用估算值冒充服务端实际删除量。

两条路径的前提不同：

- 时间间隔超过阈值时，源码认为服务端缓存已经不再温热，所以直接改 prompt 内容；
- 缓存编辑路径假定缓存仍然可编辑，只告诉 API 删除哪些缓存引用。

因此 Microcompact 解决的是“工具结果太贵”，而不是“整段对话需要一份新的语义摘要”。它可以让下一次请求变小，却不会负责重建计划、项目上下文或历史结论。

## 第三刀：CONTEXT_COLLAPSE 把旧对话变成可重放的投影视图

### 它不是直接替换 REPL 消息数组

`queryLoop()` 在 Autocompact 之前调用：

~~~
if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    messagesForQuery,
    toolUseContext,
    querySource,
  )
  messagesForQuery = collapseResult.messages
}
~~~

调用点旁边的注释给出了关键区别：collapsed view 是读取时的 projection，完整历史仍在 REPL 中；summary message 存在 collapse store，而不是直接塞进 REPL 数组；`projectView()` 会重放 commit log，当前 turn 内的 `state.messages` 会复用已经得到的视图。

这使它和传统 compact 的语义不同：

- 传统 compact 生成新 boundary，随后用新数组替换旧消息；
- Context Collapse 保留完整历史和提交记录，query 时读取一个较小的视图；
- 视图需要恢复时，可以根据 commit log 和 snapshot 再次投影，而不是只剩一段不可逆的摘要。

### 持久化结构能确认什么

虽然 Context Collapse 的主体目录没有随当前 source map 提供，但 `types/logs.ts` 暴露了两类日志。

提交记录包含：

~~~
type ContextCollapseCommitEntry = {
  type: 'marble-origami-commit'
  sessionId: UUID
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}
~~~

快照记录包含：

~~~
type ContextCollapseSnapshotEntry = {
  type: 'marble-origami-snapshot'
  sessionId: UUID
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: string
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}
~~~

`sessionStorage` 会把 commit 记录按顺序收集，把 snapshot 处理成最后一份状态；遇到 compact boundary 时还会丢弃旧 collapse 日志。恢复会话时，`ResumeConversation` 在功能开关打开的情况下调用 `restoreFromEntries(commits, snapshot)`。因此可以直接确认它采用“区间 + 提交日志 + 快照”的持久化模型。

### 它怎样和 Autocompact错开

Context Collapse 的核心目的，就是在自动摘要之前先拥有自己的上下文 headroom。`shouldAutoCompact()` 因此有三层保护：

- `querySource === 'session_memory'` 或 `'compact'` 时返回 `false`，避免 forked compaction agent 递归压缩；
- Context Collapse 的 agent 使用 `querySource === 'marble_origami'` 时返回 `false`，避免它的 cleanup 重置主线程状态；
- Context Collapse 已启用时，主线程的 Autocompact 被抑制，让 collapse 的提交/阻塞流程负责头部空间。

发生真实 API `prompt-too-long` 时，queryLoop 还会先尝试 `recoverFromOverflow()`。如果 Context Collapse 已经提交了新的区间，就把恢复后的消息视图放回 state 并继续下一轮；只有恢复没有产生进展时，才继续走 reactive compact 或把错误交给用户。

源码注释提到 collapse 有提交和阻塞的百分比区间，但当前仓库没有提供对应的 `contextCollapse` 实现文件。可以确认“它会先投影、能持久化、能从 overflow 恢复，以及会抑制 Autocompact”，不能把注释中的百分比当成已经读到的完整算法，更不能补写风险评分或摘要生成规则。

## 第四刀：Autocompact 负责最后的完整重建

### 先算有效窗口，再算自动压缩阈值

`getEffectiveContextWindowSize(model)` 的参数 `model` 是当前主循环模型名，源码把它交给 `getContextWindowForModel()` 和 `getMaxOutputTokensForModel()`；它不是一个可以在本文静态列举所有模型名的开放字符串。

~~~
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
~~~

所以有效窗口等于模型窗口减去最多 `20_000` 的摘要输出预留。`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 没设置、不是合法正整数或小于等于 0 时被忽略；合法值只能把窗口再缩小。

自动压缩阈值再减去固定的 `13_000`：

~~~
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
~~~

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 只有在大于 0 且不超过 100 时才生效；空字符串、`NaN`、负数、0 或超过 100 都回退到默认阈值。即使百分比合法，最终也取它和“有效窗口减 13,000”之间的较小值。

### 自动压缩不是永远打开

`isAutoCompactEnabled()` 的控制很直接：

~~~
export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}
~~~

`DISABLE_COMPACT` 会同时关闭手动和自动 compact；`DISABLE_AUTO_COMPACT` 只关闭自动路径，源码注释明确保留手动 `/compact`；两个环境变量都没有生效时，最终取全局配置的 `autoCompactEnabled`。

`shouldAutoCompact()` 的参数里有一个特别容易被忽略的 `snipTokensFreed = 0` 默认值。它先排除 `querySource` 为 `'session_memory'`、`'compact'` 和 Context Collapse agent 的调用，再检查 reactive-only flag、自动压缩配置和 Context Collapse 状态，最后计算：

~~~
const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
const threshold = getAutoCompactThreshold(model)
const effectiveWindow = getEffectiveContextWindowSize(model)

const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
  tokenCount,
  model,
)

return isAboveAutoCompactThreshold
~~~

`threshold` 和 `effectiveWindow` 还用于日志与 warning state；真正的 token 数会减去 snip 已经释放的粗略增量。否则 assistant usage 仍是删除前的数字，刚做完局部清理却马上触发完整压缩。

### autoCompactIfNeeded() 先走 session memory

入口签名揭示了它不是简单的 `compact(messages)`：

~~~
export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}>
~~~

参数的源码语义是：

- `messages`：已经经过前面几把刀的当前消息视图；
- `toolUseContext`：主循环上下文，模型名从 `toolUseContext.options.mainLoopModel` 取得；
- `cacheSafeParams`：压缩 fork 或 API 请求可复用的稳定参数；
- `querySource`：可选的调用来源，当前逻辑明确比较 `'compact'`、`'session_memory'`、`'marble_origami'`、`'sdk'` 和 `repl_main_thread` 前缀；其他运行时来源不能从此处静态穷举；
- `tracking`：可选的连续失败、上次压缩 turn 等链路状态；
- `snipTokensFreed`：可选的 snip token 粗略释放量，缺省时由 `shouldAutoCompact()` 按 0 处理。

控制流可以简化成：

~~~
if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
  return { wasCompacted: false }
}

if (
  tracking?.consecutiveFailures !== undefined &&
  tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
) {
  return { wasCompacted: false }
}

const shouldCompact = await shouldAutoCompact(
  messages,
  toolUseContext.options.mainLoopModel,
  querySource,
  snipTokensFreed,
)
if (!shouldCompact) {
  return { wasCompacted: false }
}

const sessionMemoryResult = await trySessionMemoryCompaction(
  messages,
  toolUseContext.agentId,
  getAutoCompactThreshold(toolUseContext.options.mainLoopModel),
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
runPostCompactCleanup(querySource)
return { wasCompacted: true, compactionResult, consecutiveFailures: 0 }
~~~

真实代码还处理 cache break baseline、`lastSummarizedMessageId`、日志和异常。连续失败达到 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 后，当前会话会触发 circuit breaker，避免每一轮都向 API 发起必然失败的压缩请求。

### Autocompact 内部的第一选择：session memory

session memory 不是第五把刀，而是 Autocompact 的一种结果生成方式。启用判断是：

~~~
if (isEnvTruthy(process.env.ENABLE_CLAUDE_CODE_SM_COMPACT)) {
  return true
}
if (isEnvTruthy(process.env.DISABLE_CLAUDE_CODE_SM_COMPACT)) {
  return false
}

const sessionMemoryFlag = getFeatureValue_CACHED_MAY_BE_STALE(
  'tengu_session_memory',
  false,
)
const smCompactFlag = getFeatureValue_CACHED_MAY_BE_STALE(
  'tengu_sm_compact',
  false,
)
return sessionMemoryFlag && smCompactFlag
~~~

这里的优先级也要记住：`ENABLE_CLAUDE_CODE_SM_COMPACT` 为 truthy 时先返回 `true`；否则 `DISABLE_CLAUDE_CODE_SM_COMPACT` 为 truthy 时返回 `false`；没有环境变量时，两个动态 flag 必须同时为真，且它们的静态默认值都是 `false`。

配置默认值是：

~~~
export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
}
~~~

`initSessionMemoryCompactConfig()` 每个进程只初始化一次，从 `tengu_sm_compact_config` 读取远程配置；`minTokens`、`minTextBlockMessages` 和 `maxTokens` 只有在远程值为正数时才覆盖默认值，0、负数或未提供都会回退。

`trySessionMemoryCompaction()` 的流程是：

1. 等待 session memory extraction 完成，读取最近一次已总结的 message UUID 和 session memory 内容；
2. 没有 memory 文件、文件仍是空模板，或者已总结 UUID 在当前消息集合中找不到时返回 `null`，交给传统 compact；
3. 如果是 resumed session、没有已总结 UUID，就从当前消息末尾开始向前扩展保留区；
4. `calculateMessagesToKeepIndex()` 以最近一次总结之后的消息为起点，向前扩展到 `minTokens` 和 `minTextBlockMessages`，但不超过 `maxTokens`，也不越过最近的 compact boundary；
5. 调整起点以避免切断 `tool_use` / `tool_result` 对；
6. 读取 session memory，必要时截断过大的 section，生成 compact boundary、结构化摘要和保留消息；
7. 如果重建后的 token 数已经达到自动阈值，返回 `null` 让传统路径接管。

它保留的不是“最后五条消息”，而是一个由“上次 session memory 总结点 + token 下限 + 文本消息下限 + 工具调用完整性”共同决定的尾部。构造结果时，摘要内容还会带上 transcript path；如果 session memory 被截断，会告诉模型完整内容仍可从 memory 文件读取。

因此 session memory 的收益是：已有结构化状态时，不必再发起一次模型摘要请求；但它没有足够内容、边界不可信或结果仍然太大时，会干净地回退到传统 Autocompact。

### 第二选择：传统 compactConversation()

传统路径的签名是：

~~~
export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
): Promise<CompactionResult>
~~~

这里的可选值和默认值决定了控制流：

- `suppressFollowUpQuestions` 是必需布尔值；自动压缩传 `true`，摘要完成后直接继续，不让模型向用户再问一遍；
- `customInstructions` 可以是字符串或 `undefined`；它会和 `PreCompact hook` 返回的新指令合并，未提供时不追加自定义要求；
- `isAutoCompact` 默认是 `false`；`true` 时 hook 的 trigger 是 `'auto'`，失败时不显示手动 `/compact` 的错误通知；
- `recompactionInfo` 可以是 `undefined`；存在时记录这是压缩链中的再次压缩、上一次 turn 和自动阈值。

函数先计算 `preCompactTokenCount`，执行 `PreCompact` hook，然后生成 compact prompt。功能 flag `tengu_compact_cache_prefix` 的静态默认值是 `true`，打开时会优先尝试 forked agent 复用原请求前缀；如果没有得到有效摘要或路径报错，再回到普通摘要流。

压缩 agent 的工具权限是显式拒绝：

~~~
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
~~~

所以传统 Autocompact 的模型任务是“阅读已有消息并产生摘要”，不是在压缩过程中继续执行 Bash、Read 或 MCP 工具。压缩请求本身如果遇到 `prompt-too-long`，代码会按 API round 从头部截掉一批消息并重试；摘要为空或返回 API error 时，压缩失败，不会把一个空摘要当成成功。

摘要生成成功后，代码会清理旧的文件读取状态，再重新附加当前仍有意义的状态：

- 已读文件和嵌套 memory 的附件；
- async agent、plan、plan mode 和已调用 skills 的信息；
- deferred tools、agent listing 和 MCP instruction 的 delta；
- `SessionStart` hooks 的结果。

源码特意不重置 `sentSkillNames`，因为重新注入完整 skill listing 会带来一大段新的 cache creation；已调用 skill 的内容通过 attachment 保留。

### 重建顺序决定“压缩之后还能做什么”

所有压缩结果最后都要交给 `buildPostCompactMessages()`：

~~~
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
}
~~~

固定顺序是：

1. compact boundary；
2. 摘要消息；
3. 仍然保留的原始消息；
4. 文件、plan、tool 和其他状态附件；
5. hook 结果。

`messagesToKeep` 可以是 `undefined`，此时按空数组处理。这个顺序解释了为什么 compact 不是“把摘要字符串插回原数组”：boundary 提供压缩元数据，摘要提供可执行的历史概览，尾部原始消息保留最近细节，附件把状态重新水化，hooks 最后补上本轮环境。

![压缩后的 boundary、摘要、保留消息与附件重新接回主循环](/images/posts/claude-code-source-reading-17/17-compaction-rehydration-detail-handdrawn.png)

### 完整压缩之外，还有手动的局部变体

`partialCompactConversation()` 是手动局部压缩，不应和前面的四把刀混为一谈：

~~~
export async function partialCompactConversation(
  allMessages: Message[],
  pivotIndex: number,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  userFeedback?: string,
  direction: PartialCompactDirection = 'from',
): Promise<CompactionResult>
~~~

源码确认的 `direction` 只有 `'from'` 和 `'up_to'`：

- `'from'`：从 pivot 开始总结后半段，保留前缀；
- `'up_to'`：总结 pivot 之前的部分，保留较新的后缀。

`userFeedback` 可以是 `undefined`，用于给局部摘要补充用户要求；`pivotIndex` 来自调用方选定的消息位置，不是一个可以从函数内部穷举的固定值。局部摘要同样会过滤旧 boundary / summary，写入新的 head、anchor、tail UUID，保证保存后的消息链仍然可以恢复。

### 压缩完成后的 cleanup 也属于重建的一部分

`runPostCompactCleanup(querySource?)` 会根据来源决定哪些共享状态可以清理：

~~~
const isMainThreadCompact =
  querySource === undefined ||
  querySource.startsWith('repl_main_thread') ||
  querySource === 'sdk'
~~~

因此 `undefined`、精确值 `'sdk'`、以及以 `'repl_main_thread'` 开头的来源被视为主线程压缩；其他来源，包括子 agent 的来源，不会重置主线程的 Context Collapse 和 memory-file 模块状态。

无论来源是什么，cleanup 都会重置 Microcompact 状态，清空 system prompt sections、classifier approvals、speculative checks、beta tracing 和 session messages cache。主线程来源还会清理 user context 和 memory files cache，并在开关打开时重置 Context Collapse。它故意不调用 `resetSentSkillNames()`，原因就是避免 compact 之后再次发送完整 skill listing。

如果传统压缩失败，`compactConversation()` 对手动压缩添加错误通知，对自动压缩只抛出错误；`autoCompactIfNeeded()` 捕获后递增 `consecutiveFailures`，连续三次失败后停止继续尝试。旧消息不会因为一个失败的摘要请求被当成已成功重建。

## 四把刀如何协同，而不是互相替代

把完整链路压缩成一张表：

| 阶段 | 主要动作 | 是否改写消息内容 | 失败或不适用时 |
| --- | --- | --- | --- |
| 读取 boundary | 取最近 compact boundary 后的历史，并按需要投影 snip | 可能只改读取视图 | 继续使用 boundary 后的原始切片 |
| `HISTORY_SNIP` | 删除指定 UUID，重连 `parentUuid` | 是 | 返回当前消息，或交给后续机制 |
| 时间型 Microcompact | 用 cleared marker 替换旧 `tool_result` | 是 | 尝试缓存编辑 |
| 缓存型 Microcompact | 生成 `cache_edits`，消息数组原样返回 | 否 | Autocompact 继续判断 |
| Context Collapse | 提交/重放归档区间，投影较短视图 | 视图层面是 | 真实 overflow 时先尝试 recovery |
| Autocompact | session memory 优先，传统模型摘要兜底 | 是，生成新 boundary | 返回失败并保留失败计数 |

最容易误读的地方有三个：

1. **snip 和 Microcompact 可以同时运行。** queryLoop 的注释明确说二者不是互斥关系；snip 释放的 token 还会进入 Autocompact 的判断。
2. **Context Collapse 不是 Autocompact 的一个摘要模板。** 它有自己的 commit log、snapshot 和读取投影；开启后，主线程自动摘要会被抑制，overflow recovery 才是后备通道。
3. **session memory 不是完整压缩之外的第五条管线。** 它是在 `autoCompactIfNeeded()` 触发之后，替代传统 `compactConversation()` 生成 `CompactionResult` 的优先分支；不能用时返回 `null`，随后仍走传统摘要。

如果回到这张金额单位工单，最理想的执行路径是：先把无价值的旧工具输出剪掉，再把仍温热的缓存引用做编辑；如果 Context Collapse 已有可提交区间，就用更短投影视图继续调查；只有这些动作仍不足以容纳请求时，才用 session memory 或模型摘要生成新的 boundary。下一轮 query 接收到的不是一段“被截断的聊天记录”，而是一个带有历史结论、尾部细节和运行状态的可执行消息集合。

## 源码能证明到哪里

本章的结论可以分成三层：

- **直接源码事实**：queryLoop 的调度顺序；环境变量和动态 flag 的默认/覆盖逻辑；token 阈值；Microcompact 的两条已接入路径；Autocompact 的 session memory → 传统摘要回退；boundary、附件和 hook 的重建顺序；snip 的 UUID 删除与父链修复。
- **调用图事实**：`autoCompactIfNeeded()` 会调用 `shouldAutoCompact()`、`trySessionMemoryCompaction()`、`compactConversation()` 和 `runPostCompactCleanup()`；overflow 时 Context Collapse 有先恢复再 reactive compact 的分支。
- **当前 source map 看不到的实现**：snip 到底选择哪些区间，缓存编辑器怎样计算删除集合，Context Collapse 怎样生成摘要、如何计算 risk、具体何时 staged 或 commit。

外部文章提供了理解这四种粒度的词汇，GitHub issue 提供了 prompt cache 恢复回归的真实案例，官方文档解释了 prefix matching 和 compact 的缓存边界；但它们不能替代当前版本的源码证据。读长会话代码时，最可靠的方法仍然是沿着 `queryLoop()` 的消息变量追踪：它在哪里被投影、在哪里被替换、在哪里写入 boundary，以及失败后是否还有旧状态可用。

## 小结

长会话能够继续运行，不是因为 Claude Code 找到了一个万能的“压缩按钮”，而是因为它把上下文压力拆成四种粒度：`HISTORY_SNIP` 做选择性删除，Microcompact 缩减工具结果或编辑缓存，Context Collapse 维护可重放的归档视图，Autocompact 最后用 session memory 或模型摘要完成一次结构化重建。

真正让压缩结果可继续执行的是后半段：boundary 标记历史断点，摘要说明已经完成的工作，`messagesToKeep` 保留近期细节，attachments 和 hooks 把文件、计划、工具与环境重新接回主循环；cleanup 则清除会污染下一轮的缓存状态。压缩不是“让模型忘记”，而是把旧上下文迁移到更适合下一次请求的表示。

## 留给下一篇的问题

当 `/compact` 进行到一半时，你手动中断，然后再次执行 `/compact`，你觉得压缩还能继续进行吗？
