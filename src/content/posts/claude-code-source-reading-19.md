---
title: "Claude Code源码解读19：如何重试、降级并恢复执行"
published: 2026-07-24T16:47:06+08:00
updated: 2026-07-24T16:47:06+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-19/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 本章先建立三个概念

- **错误分类**：网络瞬态、限流、请求无效、上下文溢出和工具失败需要不同恢复动作。

- **幂等性窗口**：重试前要判断请求或工具是否已产生副作用，避免重复执行扩大损害。

- **熔断**：连续恢复失败达到阈值后停止自动尝试，把控制权交还宿主或用户。

![错误分类、重试与熔断恢复阶梯](/images/posts/claude-code-source-reading-19/19-recovery-ladder-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇留下的问题是：当 Hook、工具、网络或模型调用失败时，Claude Code 如何分类错误、重试、恢复，并决定继续还是终止？

先说结论。Claude Code 先按失败发生的位置做隔离，再决定这个失败能否安全地回到 Agent 循环：Hook 会被归并为成功、阻断、非阻断错误或取消；工具异常会变成与原 `tool_use_id` 配对的 `is_error: true` 的 `tool_result`；API 和网络错误先进入 `withRetry()`，满足重试条件才退避重发；流式传输失败还可能切到非流式请求；连续 529 在满足模型与运行环境条件时，可以触发备用模型。

最后仍然无法恢复的 API 错误会被映射成带 `error` 分类的 synthetic assistant message，避免异常形态穿透所有 UI 和 SDK。`queryLoop()` 看见这类消息后跳过普通 Stop Hook，执行 `StopFailure` Hook，然后结束本轮。用户取消走独立路径：`AbortSignal` 终止等待或工具，运行时补一条 interruption message，取消不会被归入网络失败重试。

所以，Claude Code 的恢复机制依次做三道判断：错误属于哪一层；重做是否会放大副作用；恢复后消息协议能否保持完整。三道判断都过关，执行才会继续。

## 错误恢复是一条分层的控制流

本文仍然只讨论本仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码。下面的代码片段会省略与当前结论无关的遥测、内部实验和 provider 分支；省略处会明确标出，其余内容直接取自还原源码。

![Claude Code 对 Hook、工具、API 与流式错误的分层恢复流程](/images/posts/claude-code-source-reading-19/19-errors-retries-recovery-handdrawn.png)

### 三个概念如何决定恢复动作

第一个概念是 **fault containment**，也就是故障隔离。一个 Hook 脚本退出码非零，不应该天然等价于整个会话崩溃；一个工具参数错误，也不应该让模型失去修正参数的机会。实现会把局部失败转换成所在协议层能够消费的数据，再交给上层决定是否继续。

第二个概念是 **retryability**，也就是可重试性。判断依据来自错误类别与执行边界：连接断开、408、409、部分 5xx 往往可以重发；无效参数、模型缺失、权限拒绝通常不能靠等待解决。模型请求重试主要重复推理请求，工具副作用重试则可能再次写文件、运行命令或调用外部系统。

第三个概念是 **backoff with jitter**。服务过载时，如果所有客户端立刻同时重试，会形成重试风暴。指数退避让等待时间随尝试次数增长，jitter 再加入少量随机量，避免大量客户端在同一毫秒重新打到服务端。

把这三个概念放在一起，本章主线就是：先把错误关在正确的层里，再判断是否可重试；可重试时控制节奏，不可重试时把失败变成模型、用户或宿主能够识别的终态消息。

### 第一层分类：遥测标签与控制决策分层处理

`restored-src/src/services/api/errors.ts` 中的 `classifyAPIError()` 会把原始异常归入稳定标签。主干可以缩成下面这样：

```ts
export function classifyAPIError(error: unknown): string {
  if (error instanceof Error && error.message === 'Request was aborted.') {
    return 'aborted'
  }
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes('timeout'))
  ) {
    return 'api_timeout'
  }
  if (error instanceof APIError && error.status === 429) {
    return 'rate_limit'
  }
  if (
    error instanceof APIError &&
    (error.status === 529 ||
      error.message?.includes('"type":"overloaded_error"'))
  ) {
    return 'server_overload'
  }
  // ...
  if (error instanceof APIError) {
    const status = error.status
    if (status >= 500) return 'server_error'
    if (status >= 400) return 'client_error'
  }
  if (error instanceof APIConnectionError) return 'connection_error'
  return 'unknown'
}
```

函数说明：`classifyAPIError(error)` 为日志和分析生成稳定字符串。它识别的源码分支还包括 `repeated_529`、`capacity_off_switch`、`prompt_too_long`、PDF/图片错误、三类 `tool_use` / `tool_result` 配对错误、`invalid_model`、计费与认证错误、Bedrock 模型访问错误、SSL 证书错误等。

参数说明：`error` 是 `unknown`，所以函数先用 `instanceof`、HTTP status 和消息特征逐层缩窄。省略 `APIError.status` 时会跳过 4xx/5xx 回退；最终标签 `unknown` 表示静态分类器未命中已知形状。

这里要特别注意：这一步只生成**诊断分类**。比如 401 会被标成认证类错误，但某些路径会刷新凭证后重试；429 会被标成 rate limit，但订阅用户、企业用户和无人值守模式的处理会分流。标签负责把错误说清楚，重试控制流由 `shouldRetry()` 和外层上下文决定。

### API 重试：每次重发前都重新判断环境

模型请求的重试核心在 `restored-src/src/services/api/withRetry.ts`。入口采用异步生成器，因此等待期间可以向上层产出 `SystemAPIErrorMessage`，最终再返回操作结果。

```ts
export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (
    client: Anthropic,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let client: Anthropic | null = null
  let lastError: unknown

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) throw new APIUserAbortError()
    try {
      // ...
      return await operation(client, attempt, retryContext)
    } catch (error) {
      lastError = error
      // ...
    }
  }
  throw new CannotRetryError(lastError, retryContext)
}
```

函数说明：`withRetry<T>()` 包住一次 API 操作，成功时返回 `T`，等待重试时 yield 系统错误消息，耗尽或遇到不可重试错误时抛出 `CannotRetryError`。默认最大重试数是 10，因此普通情况下最多执行 `maxRetries + 1` 次操作。

参数说明：`getClient` 在首次调用以及 401、OAuth token revoked、Bedrock/Vertex 认证错误或陈旧连接后重新创建客户端；`operation` 接收从 1 开始的 `attempt`，第三个参数 `context` 是本轮可变的 `RetryContext`。`options.maxRetries` 可为 `undefined`，此时回退到 `CLAUDE_CODE_MAX_RETRIES` 的解析结果或常量 10；源码对该环境变量只做 `parseInt`。`fallbackModel`、`fastMode`、`signal`、`querySource`、`initialConsecutive529Errors` 都可为 `undefined`；连续 529 初值用 `?? 0` 回退。

字段说明：`maxRetries` 是解析后的重试次数，循环上界因此为 `maxRetries + 1`；`retryContext.model` 与 `retryContext.thinkingConfig` 取自 `options`，`retryContext.fastMode` 只在 fast mode 启用时加入。`client` 以 `null` 开始并按需创建，`lastError` 保存最近一次异常；重试耗尽时两者共同支持抛出携带上下文的 `CannotRetryError`。

为什么 client 也要重建？因为有些失败不在请求内容，而在连接或凭证状态。源码会在 401 或 token revoked 后走 OAuth 刷新；Bedrock/Vertex 认证异常会清凭证缓存；`ECONNRESET`、`EPIPE` 被视为陈旧连接，在功能开关允许时还会禁用 keep-alive 后重连。原样复用旧 client，只会把同一个坏状态重复十次。

### 哪些错误允许重试

真正的闸门是同文件里的 `shouldRetry()`：

```ts
function shouldRetry(error: APIError): boolean {
  if (isMockRateLimitError(error)) return false

  // ...
  const shouldRetryHeader = error.headers?.get('x-should-retry')
  if (
    shouldRetryHeader === 'true' &&
    (!isClaudeAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }
  if (shouldRetryHeader === 'false') {
    const is5xxError = error.status !== undefined && error.status >= 500
    if (!(process.env.USER_TYPE === 'ant' && is5xxError)) return false
  }

  if (error instanceof APIConnectionError) return true
  if (!error.status) return false
  if (error.status === 408 || error.status === 409) return true
  if (error.status === 429) {
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }
  if (isOAuthTokenRevokedError(error)) return true
  if (error.status >= 500) return true
  return false
}
```

函数说明：`shouldRetry(error)` 只回答当前 `APIError` 是否值得再交给 `withRetry()`。片段省略了源码中优先级更高的分支：无人值守 persistent 模式会把 429/529 视作可重试；remote/CCR 模式会把 401/403 当作基础设施的短暂故障；消息里含 `overloaded_error`、或者是可调整 `max_tokens` 的上下文溢出，也会直接返回 `true`。

参数说明：省略 `error.status` 时，在连接错误特判之后直接进入不可重试分支。服务端非标准头 `x-should-retry` 的可见值是字符串 `'true'`、`'false'` 或缺失；缺失时继续按连接类型和状态码判断，它还会受到订阅类型和内部运行环境约束。429 对普通订阅用户默认不走这里的常规重试，Enterprise 可重试。408 是请求超时，409 在源码注释中是 lock timeout，5xx 是服务端错误。其余 4xx 默认返回 `false`。

这段代码也说明“HTTP 失败一律重试”为什么危险。400 往往说明参数或上下文有问题，重放不会改变结果；403 通常要用户修复授权。只有源码明确知道凭证会被刷新、连接会被重建，或者服务端声明可以重试时，才值得继续。

### 退避按服务端提示或指数公式计算

重试延迟由 `getRetryDelay()` 统一计算：

```ts
export const BASE_DELAY_MS = 500

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) return seconds * 1000
  }

  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}
```

函数说明：`getRetryDelay()` 优先服从可解析的 `Retry-After` 秒数；header 缺失或无效时，从 500ms 开始指数增长，基础延迟默认封顶 32,000ms，再增加最多 25% 的随机 jitter。

参数说明：`attempt` 是从 1 开始的尝试次数。`retryAfterHeader` 可以是字符串、`null` 或 `undefined`；空值和无法 `parseInt` 的值回退到指数退避。`maxDelayMs` 默认 32,000，但 persistent 模式会传入 5 分钟；需要注意，合法 `Retry-After` 会直接返回，不受函数内部的 `maxDelayMs` 限制，persistent 调用方因此又在外层用 6 小时上限裁剪。

普通模式在 sleep 之前会 yield 一条包含 `retryInMs`、`retryAttempt` 和 `maxRetries` 的 system message。`QueryEngine` 对 SDK 输出时再把它转换为 `type: 'system', subtype: 'api_retry'`，结构化宿主因此可以展示等待时间与错误类别。

### 529 降级：连续容量错误触发换模

当 API 返回 529 或消息里含 `overloaded_error` 时，`withRetry()` 会累计连续失败。源码中的关键边界是：计数达到 `MAX_529_RETRIES = 3`，并且当前模型满足环境限定后，只有配置了 `fallbackModel` 才抛出专门的 `FallbackTriggeredError`。

真正换模型发生在 `restored-src/src/query.ts`：

```ts
} catch (innerError) {
  if (innerError instanceof FallbackTriggeredError && fallbackModel) {
    currentModel = fallbackModel
    attemptWithFallback = true

    yield* yieldMissingToolResultBlocks(
      assistantMessages,
      'Model fallback triggered',
    )
    assistantMessages.length = 0
    toolResults.length = 0
    toolUseBlocks.length = 0
    needsFollowUp = false

    if (streamingToolExecutor) {
      streamingToolExecutor.discard()
      streamingToolExecutor = new StreamingToolExecutor(
        toolUseContext.options.tools,
        canUseTool,
        toolUseContext,
      )
    }
    toolUseContext.options.mainLoopModel = fallbackModel
    // ...
    yield createSystemMessage(
      `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
      'warning',
    )
    continue
  }
  throw innerError
}
```

函数说明：这段位于 `queryLoop()` 的模型请求循环。它只捕获 `withRetry()` 发出的换模信号；随后清掉失败尝试产生的 assistant、tool result 和 tool-use 暂存，丢弃流式工具执行器，再用备用模型重做整次模型请求。

参数说明：`fallbackModel` 是可选字符串，缺失时不会进入该分支。`attemptWithFallback` 设为 `true` 让内层 while 再跑一次。新建 `StreamingToolExecutor` 时继续使用当前工具数组、`canUseTool` 与上下文。系统消息 level 固定为 `'warning'`，使用户能看到发生了降级。

清空旧 `toolUseBlocks` 很关键。失败流中如果已经产出一个 `tool_use`，备用模型重试后会生成新的 ID。把旧结果混进新请求会制造孤儿 `tool_result`，严重时还可能重复执行工具。因此这里先修复协议边界，再用备用模型重做本次采样。

### 流失败：能降为非流式，但要防止重复副作用

`restored-src/src/services/api/claude.ts` 的流式路径还包了一层恢复。流缺少 `message_start`、只收到不完整块、触发 idle watchdog，或者迭代中抛错时，可以改走 `executeNonStreamingRequest()`。

```ts
const disableFallback =
  isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) ||
  getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_disable_streaming_to_non_streaming_fallback',
    false,
  )

if (disableFallback) throw streamingError

didFallBackToNonStreaming = true
options.onStreamingFallback?.()

const result = yield* executeNonStreamingRequest(
  { model: options.model, source: options.querySource },
  {
    model: options.model,
    fallbackModel: options.fallbackModel,
    thinkingConfig,
    // ...
    signal,
    initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
    querySource: options.querySource,
  },
  // ...
)
```

函数说明：这段来自 `queryModelWithStreaming()` 的错误分支。默认可从失败的 streaming 请求降到 non-streaming 请求；环境变量或远端开关启用时，则把原错误交回 `withRetry()`，不做中途降级。流式错误本身若是 529，会以初值 1 进入后续连续 529 计数。

参数说明：`CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` 使用 truthy 环境变量解析；远端开关的静态默认值是 `false`。`onStreamingFallback` 可以是 `undefined`，省略回调仍可降级。`signal` 是同一个 `AbortSignal`，取消仍能中断非流式请求。`querySource` 和 `fallbackModel` 都可为 `undefined`，分别影响 529 重试策略与是否允许最终换模。

字段说明：`disableFallback` 合并环境变量与 `tengu_disable_streaming_to_non_streaming_fallback`；真值直接抛出 `streamingError`。降级分支把 `didFallBackToNonStreaming` 设为 `true` 并调用 `options.onStreamingFallback`。传入非流式执行器的第一层对象用 `model` 与 `source` 标识请求；第二层对象继续传递 `model`、`fallbackModel`、`thinkingConfig`、`signal`、`querySource`，并用 `initialConsecutive529Errors` 把当前 529 计为 1，否则从 0 开始。

为什么源码还提供关闭开关？注释给出的原因很具体：启用 streaming tool execution 时，部分流可能已经启动了工具；再用非流式请求重做相同采样，可能生成同一工具动作并执行第二次。外层 `queryLoop()` 在收到 `onStreamingFallback` 后会 tombstone 部分 assistant message、清空旧 tool result，并 discard executor，但已经越过副作用边界的外部操作并不能靠清数组撤销。

静态源码也不能告诉我们线上具体开关值。

### 工具失败：把异常回填给模型

工具执行器采用另一种恢复策略。`tool.call()` 抛错后，它不会自己再次调用工具，而是把错误转换成协议完整的结果：

```ts
} catch (error) {
  const content = formatError(error)
  const isInterrupt = error instanceof AbortError

  const hookMessages: MessageUpdateLazy<
    AttachmentMessage | ProgressMessage<HookProgress>
  >[] = []
  for await (const hookResult of runPostToolUseFailureHooks(
    toolUseContext,
    tool,
    toolUseID,
    messageId,
    processedInput,
    content,
    isInterrupt,
    requestId,
    mcpServerType,
    mcpServerBaseUrl,
  )) {
    hookMessages.push(hookResult)
  }

  return [
    {
      message: createUserMessage({
        content: [
          {
            type: 'tool_result',
            content,
            is_error: true,
            tool_use_id: toolUseID,
          },
        ],
        toolUseResult: `Error: ${content}`,
        // ...
        sourceToolAssistantUUID: assistantMessage.uuid,
      }),
    },
    ...hookMessages,
  ]
}
```

函数说明：这段来自 `restored-src/src/services/tools/toolExecution.ts` 的 `checkPermissionsAndCallTool()`。它先用 `formatError()` 规范化错误，再运行 `PostToolUseFailure` Hook，最终返回一条 user role 的 `tool_result`，让 `queryLoop()` 把失败结果连同历史交给模型进入下一轮。

参数说明：`toolUseID` 必须原样写入 `tool_use_id`，否则 API 无法配对；`processedInput` 是经过 Schema、工具校验和 PreToolUse 处理后的输入。`isInterrupt` 是布尔值，只在错误为项目自定义 `AbortError` 时为 `true`。`requestId` 可能为 `undefined`；`mcpServerType` 和安全化后的 base URL 只对 MCP 诊断有意义。`toolUseResult` 保存宿主侧原始错误表示，面向模型的 `content` 最长会由 `formatError()` 截到首尾合计 10,000 字符。

字段说明：`hookMessages` 收集 `runPostToolUseFailureHooks()` 产出的更新；最终返回项的 `message` 是 user message，内部块以 `type: 'tool_result'`、`is_error: true` 标记失败，并把 `content` 与 `tool_use_id` 写回协议。完整返回对象还用 `sourceToolAssistantUUID` 关联产生该工具请求的 assistant 消息。

工具失败后直接回填结果，这是一个重要的安全选择。Bash 可能已经执行前半段，Edit 可能已经写盘，MCP 服务也可能在返回错误前提交了远端事务。执行器无法仅凭一个 exception 判断副作用是否发生。把错误作为 `tool_result` 回给模型，可以让模型检查现场、换参数或向用户说明，并避免在副作用状态未知时自动重做。

如果错误是 `McpAuthError`，执行器还会把对应 client 从 `connected` 改为 `needs-auth`；其他状态、client 缺失或已离开 connected 时都保持原状态。这次状态修复不会自动重放原 MCP 调用。

### Hook 失败：失败本身也分 blocking 与 non-blocking

Hook 执行的结果类型定义在 `restored-src/src/utils/hooks.ts`：

```ts
export interface HookResult {
  message?: HookResultMessage
  systemMessage?: string
  blockingError?: HookBlockingError
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  preventContinuation?: boolean
  stopReason?: string
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  hookPermissionDecisionReason?: string
  additionalContext?: string
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  elicitationResponse?: ElicitationResponse
  watchPaths?: string[]
  elicitationResultResponse?: ElicitationResponse
  retry?: boolean
  hook: HookCommand | HookCallback | FunctionHook
}
```

类型说明：`HookResult` 把“Hook 自己运行失败”和“Hook 有意阻断业务动作”分开。`outcome` 只有源码列出的四个值：`success` 是成功；`blocking` 是明确阻断；`non_blocking_error` 表示 Hook 异常但不天然接管主控制流；`cancelled` 表示取消。

字段说明：`blockingError`、`preventContinuation`、`stopReason`、`additionalContext`、`updatedInput`、`retry` 都可以是 `undefined`。`permissionBehavior` 的可选值是 `'ask'`、`'deny'`、`'allow'`、`'passthrough'`；省略时该 Hook 不提供权限意见。`retry` 只由 PermissionDenied 等特定 Hook 输出消费。

其余字段承载不同消费通道：`message` 与 `systemMessage` 负责展示；`initialUserMessage` 和 `additionalContext` 进入模型上下文；`updatedMCPToolOutput` 只供 MCP 结果替换；`permissionRequestResult` 交给权限请求调用方；`elicitationResponse` 与 `elicitationResultResponse` 分别承载两类 MCP elicitation 结果；`watchPaths` 交给文件监听调用方。`hookPermissionDecisionReason` 解释 Hook 权限决策，`hook` 是必填来源对象，用于诊断和后续聚合。

命令 Hook 的退出码也有约定：0 被视为成功，2 或 JSON `decision: 'block'` 被视为阻断，其他非零通常进入非阻断错误。JSON 结构错误、进程启动失败或超时会被包装成 `hook_error_during_execution` / `hook_non_blocking_error` 一类 attachment，从而把扩展脚本故障限制在 Hook 协议内。

“非阻断”结果仍会作为 attachment 展示。PreToolUse Hook 的明确 deny/stop 会让当前工具停在副作用边界之前；Stop Hook 的 blocking error 会作为反馈加入消息并让 `queryLoop()` 再跑一轮。普通执行错误若未形成 blocking decision，主流程可以继续。失败语义取决于生命周期节点与返回结果。

### 用户取消：Abort 走独立终止路径

项目需要同时识别自己的 `AbortError`、浏览器/Node 的 abort-shaped error，以及 SDK 的 `APIUserAbortError`：

```ts
export function isAbortError(e: unknown): boolean {
  return (
    e instanceof AbortError ||
    e instanceof APIUserAbortError ||
    (e instanceof Error && e.name === 'AbortError')
  )
}
```

函数说明：`isAbortError()` 位于 `restored-src/src/utils/errors.ts`，统一识别三种取消形状。源码特意使用 `instanceof APIUserAbortError`，因为 minified build 可能改写构造器名，单纯比较 `constructor.name` 不可靠。

参数说明：`e` 是 `unknown`。项目 `AbortError`、SDK `APIUserAbortError`、以及 `name === 'AbortError'` 的普通 `Error` 返回 `true`，其他值返回 `false`。这只是分类函数；不同调用点仍会决定如何清理资源和生成消息。

在流式请求中，SDK 抛出 `APIUserAbortError` 后还要检查调用方的 `signal.aborted`：为真才是用户 ESC 取消；为假则被转换为 `APIConnectionTimeoutError`，进入超时处理。这个区分避免把 SDK 内部 timeout 错报成“用户中断”。

`queryLoop()` 收到真实取消后跳过 assistant API error。模型流阶段取消会生成普通 interruption user message；工具阶段取消会生成 tool-use interruption result。如果 abort reason 是 `'interrupt'`，表示新的用户输入已经排队，源码会跳过额外 interruption message，避免重复上下文。取消最终返回的 reason 为 `aborted_streaming` 或 `aborted_tools`，流程随即停止退避。

### 模型错误也有“修复输入再试”的分支

有些模型/API 错误表示当前上下文形状无法被接受。`queryLoop()` 会先修复状态，再用新状态重试。

最典型的是 prompt too long。API error message 会先被 withheld，不立即显示；随后运行时优先尝试 drain 已暂存的 context collapse，再尝试一次 reactive compact。压缩成功后，`buildPostCompactMessages()` 重建消息链，并以 `transition.reason = 'reactive_compact_retry'` 继续。已经尝试过的布尔标志 `hasAttemptedReactiveCompact` 会保留，防止“压缩后仍过长 → 再压缩”的死循环。

另一个例子是 `max_output_tokens`。在相应开关开启且省略显式环境变量覆盖时，它可以先把同一请求的输出上限提升到 64K；仍然截断时，再追加一条 meta user message，要求模型从中断处继续并拆小剩余工作。恢复次数由 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` 限制。达到上限后，之前 withheld 的错误才会显示。

这类恢复的共同点是：先改变导致失败的状态，再重试；同一份过长输入不会因指数退避而变短。

### 最后一道闸：继续、结束，还是把现场交给用户

当所有 API 重试都失败，`queryModelWithStreaming()` 会拆开 `CannotRetryError`，取回 `originalError` 和失败时的 `retryContext.model`，再调用 `getAssistantMessageFromError()`。它生成的 assistant message 会设置 `isApiErrorMessage: true`，`error` 的源码可选值是：

- `authentication_failed`
- `billing_error`
- `rate_limit`
- `invalid_request`
- `server_error`
- `unknown`
- `max_output_tokens`

其中 `errorDetails` 可以是 `undefined`，只在需要保留底层细节供恢复或诊断时写入；`apiError` 也可以缺失。不同 provider、交互式 CLI 与无头模式会生成不同的人类提示，但不会改变这组 SDK 分类。

`queryLoop()` 的最终决定可以按四类理解：

1. 工具失败已经形成配对的 `tool_result`：把它加入消息链，继续下一轮，让模型决定修正或解释。
2. Stop Hook 明确返回 blocking feedback：把反馈加入消息，再运行一轮；`stopHookActive` 防止递归语义失控。
3. API error 已经是 synthetic assistant message：执行 `StopFailure` Hook，跳过普通 Stop Hook，然后结束本轮，避免“错误 → Stop Hook 阻断 → 再请求 → 同一错误”的死循环。
4. 用户取消或无法预期的运行时异常：补齐缺失的 tool result / interruption 信息，释放 stream 资源，以 `aborted_*` 或 `model_error` 终止当前循环。

本轮结束后，assistant error、tool error 和 interruption 仍以消息或 attachment 留给上层记录和展示；真正的会话持久化、resume 与 fork 正是下一篇要继续追踪的主题。



静态源码可以确认默认重试数、HTTP status 与 header 的判断、指数退避公式、连续 529 的计数门槛、流转非流的入口、工具错误回填形状、Hook outcome、Abort 分支和 `queryLoop()` 的终止 reason。

但功能开关、用户订阅类型、provider 返回的 header、实际 `fallbackModel`、网络故障分布和远端实验值都属于运行时条件。

副作用边界也必须保守描述。流式 fallback 会清理局部消息与 executor，但不能撤销已经落盘或提交到外部系统的动作。要判断一次失败能否安全重试，仍然需要检查具体工具实现和真实现场。

## 小结

Claude Code 的错误恢复可以归纳为四层。

Hook 层把结果归并成成功、阻断、非阻断错误或取消，让扩展失败不必自动升级为进程失败。工具层不盲目重做副作用，而是构造 `is_error: true` 且与 `tool_use_id` 配对的 `tool_result`，把修正机会交回 Agent 循环。

API 层用 `shouldRetry()` 判断连接、超时、锁冲突、限流、认证刷新与服务错误，再按 `Retry-After` 或指数退避加 jitter 等待；满足严格条件的连续 529 可以触发备用模型。流层还可以转为非流式请求，但实现同时保留关闭开关，因为部分流已经启动工具时，重做请求可能造成重复副作用。

最后，真实 Abort 不参与重试；无法恢复的 API 错误会变成结构化 assistant message，`queryLoop()` 运行失败 Hook 后终止。这个设计让每个错误留在正确的协议层里，并给下一步留下可诊断、可恢复的状态。

## 留给下一篇的问题

错误恢复让当前运行能够继续以后，Claude Code 如何把会话写入历史，并实现 resume、fork 与分支恢复？

## 参考资料

- [Claude Code 错误参考](https://code.claude.com/docs/en/errors)

- [Claude Code 监控与 API 错误事件](https://code.claude.com/docs/en/monitoring-usage)
