---
title: "Claude Code源码解读19：如何重试、降级并恢复执行"
published: 2026-07-24T16:47:06+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-19/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇留下的问题是，你能想到 Hook 有什么妙用？

答案先放在前面，Hook 最有价值的地方，是把“每次都必须发生”的动作放到生命周期边界上，让它变成可重复、可审计的工程约束。社区里已经有人把 Hook 用成安全护栏、提交前审查器、上下文注入器、后台任务调度器和完成通知器。

### 1. 把危险操作和敏感文件挡在 `PreToolUse`

一个很实用的起点，是在 `Bash`、`Write` 或 `Edit` 真正执行前检查输入，拒绝 `rm -rf`、向主分支强制 push、fork bomb，或者阻止修改 `.env`、SSH key、云凭证、锁文件和 CI 配置。社区实战中的做法是让 Hook 读取 JSON stdin，匹配命令或路径，命中后返回非零退出码或结构化 deny；模型会收到原因并改走其他方案。

这里的关键在于把规则放在模型决策之后、工具副作用之前。规则写在 Hook 里，即使 prompt 漏掉了约束，也不会直接越过这道门。

### 2. 把 `git commit` 变成自动 code review 门禁

另一个社区工作流是在 `PreToolUse` 里只匹配 `git commit`，Hook 启动一个 reviewer subagent 检查 staged diff，严重问题直接阻止提交，轻微问题可以自动修复但保持 unstaged，让主 Agent或开发者复核后再提交。这样做比让主 Agent 自己“提交前顺手 review 一遍”稳定，因为 review 是提交动作的固定前置条件。

这个模式也说明 Hook 和 subagent 的分工，Hook 负责决定什么时候必须审查、审查失败能不能继续；subagent 负责在隔离上下文里阅读 diff。前者是事件驱动的门，后者是一次有边界的分析任务。

### 3. 用 `SessionStart` 和 `Stop` 管理长期会话

有人把团队规则、当前分支状态和项目运行手册放进 `SessionStart`，每次新会话或 resume 都自动注入；也有人在 `PostToolUse` 追踪 Edit、Write、Bash 造成的变化，在 `Stop` 时让隔离 Agent 把关键进展同步到 `CLAUDE.md` 或项目 memory。这样可以减少把长篇背景重复塞进主会话的成本，但要注意只写入经过筛选的事实，别把临时日志和整个 transcript 复制进去。

`Stop` 还可以用来做“完成定义”检查，例如测试失败就阻止停止，把失败摘要交回模型继续修复。社区示例特别强调 `stop_hook_active` 保护；没有这个循环护栏，Stop Hook 可能在每次重试时再次阻止停止，形成自激循环。

### 4. 把阻塞命令改造成后台任务

`PreToolUse` 不只用来拒绝。对于 `npm run dev`、`tail -f` 这类会一直占住前台的命令，社区有人用 Hook 识别它们，改写输入或注入指令，让命令转入后台并过滤日志；主 Agent 继续做下一步，另一个监控路径再通过 `PostToolUse` 或 Monitor 工具消费输出。

这类用法的边界是版本和事件能力，Hook 能否改写 `updatedInput`，取决于当前事件的输出协议与 2.1.88 还原源码；不能确认的字段不要照抄后续版本示例。即使不能改写，也可以在 `PreToolUse` 返回提醒或拒绝前台阻塞命令，让模型重新组织调用。

### 5. 把“人在等待”变成可达的通知

长时间运行的任务不应该要求人盯着终端。`Notification` 可以接 macOS/Linux 桌面通知，或转发到 Slack、手机推送；`Stop` 则适合通知“整个任务已经结束”。社区实践通常把权限等待、空闲等待和最终完成分开通知，避免把每一次工具进度都变成噪音。

所以，Hook 的妙用可以浓缩成一句话，**把不可忘记的规则放到不可绕过的事件点，把需要隔离的分析交给 subagent，把需要等待人的状态接到通知系统。** 它不是万能的工作流编排器；Hook 自身仍可能超时、失败或重复触发，生产配置要做 matcher、超时、幂等和递归保护。

## 介绍本章的一些概念

- 错误恢复是**分层的控制流**，API 层负责退避和换模型，流层负责决定能否降级，工具层把失败回填为 `tool_result`，query loop 最后决定继续还是结束。
- `shouldRetry()` 不是"一律重试"，**401 会刷新凭证后重试，429 对普通订阅用户默认不重试（Enterprise 可重试），400 等 4xx 不重试**，是否值得重放取决于凭证是否会刷新、连接是否会重建。
- 连续 529 计数达到 **`MAX_529_RETRIES = 3`** 且配置了 `fallbackModel` 时触发换模；换模前必须**清空失败轮的 assistant 消息与 tool 暂存**，否则会产生孤儿 `tool_result` 甚至重复执行工具。
- 工具失败**不盲目重做副作用**，构造 `is_error: true` 且与 `tool_use_id` 配对的 `tool_result` 交回模型，让模型检查现场、换参数或向用户说明。
- 流式请求可降级为非流式，但源码保留**关闭开关**（`CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` / `tengu_disable_streaming_to_non_streaming_fallback`），因为部分流可能已经启动了工具，重做采样可能造成重复副作用。

## 本篇新增机制

本文回答"如何重试、降级并恢复执行"，确立四个机制，

1. **分层恢复链**，Hook 层归并 outcome → 工具层回填 `tool_result` → API 层退避/换模 → 流层降级 → query loop 收尾。
2. **标签与控制分离**，`classifyAPIError()` 只生成诊断标签，`shouldRetry()` 与外层上下文决定控制流。
3. **三档降级**，连续 529 换备用模型、流式转非流式、模型错误"修复输入再试"。
4. **终态收敛**，不可恢复错误变成结构化 assistant message，`queryLoop()` 运行失败 Hook 后终止。

## 问题

一次请求可能在 HTTP 层返回 529，在流已经输出一半时断开，或在工具实际执行后才抛出异常。把这些情况都写成"再试一次"，要么重复副作用，要么把本来可恢复的错误直接暴露给用户。

![错误分类、重试与熔断恢复阶梯](/images/posts/claude-code-source-reading-19/19-recovery-ladder-detail-handdrawn.png)

## 正文

本文全部引用 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` 还原源码。代码块只保留证明控制流所需的字段，`// ...` 表示省略埋点、UI 消息和无关分支；每个代码块后标注证据位置与证据级别（[source] 直接摘录还原源码 / [pseudocode] 简化复述 / [inference] 依据结构推断 / [runtime] 运行时行为）。

### 错误恢复是一条分层的控制流

![Claude Code 对 Hook、工具、API 与流式错误的分层恢复流程](/images/posts/claude-code-source-reading-19/19-errors-retries-recovery-handdrawn.png)

恢复链按错误产生的位置分层。Hook 的非零退出先成为 `non_blocking_error` 或 blocking feedback；工具异常被配对成带原 `tool_use_id` 的 `tool_result`；API 层再由 `classifyAPIError()` 和 `shouldRetry()` 判断连接、限流、认证或服务故障。只有尚未产生不可逆副作用、且当前 source 被允许重试的请求，才会进入 `Retry-After` 或指数退避加 jitter 的等待。

把这三个概念放在一起，本章主线就是，先把错误关在正确的层里，再判断是否可重试；可重试时控制节奏，不可重试时把失败变成模型、用户或宿主能够识别的终态消息。

### 这张金额单位工单失败时，Claude Code 先判断是哪一种失败

10，03，工程师已经拿到金额字段的调用链，准备让模型读取 issue-tracker 的历史评论，API 却返回了 529；响应只输出了一半，终端停在"正在获取历史舍入规则"。10，11，重新检查本地代码时，Grep 因为一个已经被重命名的目录退出非零。10，46，修复分支上的测试又报错，但错误来自一个未安装的浏览器依赖，而不是金额断言。三件事都叫"失败"，可恢复方式完全不同。

工程师因此把任务约束写得很明确，

> 完成后使用 LSP、Chrome 和相关测试验证；失败时保留错误证据，必要时回滚或切换方案。不要因为一次网络错误就重复已经成功的文件写入或外部调用。

网络请求可能进入退避，流可能重新建立，MCP、Bash 或测试的失败则要以对应的 `tool_result` 回填给模型。Claude Code 先分类并记录遥测，再由控制层决定重试、降级、回滚、把错误交回模型或结束会话；用户看到的最终结论必须来自成功结果或明确错误路径。

下面沿这张金额单位工单的几个失败点进入源码，区分错误标签、恢复动作和最终呈现。

### 第一层分类｜遥测标签与控制决策分层处理

`restored-src/src/services/api/errors.ts` 中的 `classifyAPIError()` 会把原始异常归入稳定标签。主干可以缩成下面这样，

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

> 证据，[source] `restored-src/src/services/api/errors.ts` 的 `classifyAPIError()`（2.1.88 source map 还原源码）。

函数说明，`classifyAPIError(error)` 为日志和分析生成稳定字符串。它识别的源码分支还包括 `repeated_529`、`capacity_off_switch`、`prompt_too_long`、PDF/图片错误、三类 `tool_use` / `tool_result` 配对错误、`invalid_model`、计费与认证错误、Bedrock 模型访问错误、SSL 证书错误等。

参数说明，`error` 是 `unknown`，所以函数先用 `instanceof`、HTTP status 和消息特征逐层缩窄。省略 `APIError.status` 时会跳过 4xx/5xx 回退；最终标签 `unknown` 表示静态分类器未命中已知形状。

这里要特别注意，这一步只生成**诊断分类**。比如 401 会被标成认证类错误，但某些路径会刷新凭证后重试；429 会被标成 rate limit，但订阅用户、企业用户和无人值守模式的处理会分流。标签负责把错误说清楚，重试控制流由 `shouldRetry()` 和外层上下文决定。

### 错误类型 → 恢复动作矩阵

[inference] 本文把分散在源码各层的错误分类、恢复动作、重试上限与最终呈现汇成一张矩阵。错误类型与恢复动作来自 [source]；"重试上限"中未直接列出的数值（如 `maxRetries` 默认 10）已在文中对应小节确认；运行时开关行为属于 [runtime]。

| 错误类型 | 分类标签 | 恢复动作 | 重试上限 | 最终呈现 |
| --- | --- | --- | --- | --- |
| 用户取消（`AbortError` / `APIUserAbortError`） | `aborted` | 清理资源，跳过一切重试 | 0 | `reason: aborted_streaming` / `aborted_tools` |
| 连接错误（`APIConnectionError`、`ECONNRESET`、`EPIPE`） | `connection_error` | 重建 client；必要时禁用 keep-alive 重连 | `maxRetries + 1`（默认共 11 次尝试） | 最终 assistant error |
| API 超时 | `api_timeout` | 退避后重试；流式可降非流式 | 同 `maxRetries + 1` | `api_retry` system message |
| 429 限流 | `rate_limit` | 订阅用户默认不重试；Enterprise / persistent / `x-should-retry: true` 可重试 | 取决于 `shouldRetry()` 与订阅类型 | synthetic assistant message |
| 529 过载 | `server_overload` | 指数退避；连续 3 次后 `fallbackModel` 换模 | `MAX_529_RETRIES = 3` | warning，`Switched to ... due to high demand` |
| 5xx | `server_error` | 退避重试 | `maxRetries + 1` | assistant error `server_error` |
| 401 / OAuth token revoked | 认证类 | 刷新凭证 / 清缓存后重试 | 每次重发前重新判断 | ， |
| 400 等其他 4xx | `client_error` | 不重试 | 0 | 交给用户修复输入 |
| prompt too long | `prompt_too_long` | withheld → drain collapse → reactive compact → 重建消息重试 | `hasAttemptedReactiveCompact` 防死循环 | `transition.reason = 'reactive_compact_retry'` |
| max_output_tokens | `max_output_tokens` | 输出上限升到 64K；仍截断则追加 meta message 从中断处继续 | `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` | 达到上限才显示被 withheld 的错误 |
| 工具异常 | ， | 回填 `is_error: true` 且配对 `tool_use_id` 的 `tool_result` | 不自动重试 | 下一轮模型决定修正或解释 |
| Hook 非零退出 | `non_blocking_error` / `blocking` | 退出码 2 → blocking feedback；其他非零 → attachment | ， | 模型可见反馈或用户可见附件 |
| 流中断 / 不完整块 | ， | 降级 `executeNonStreamingRequest()` | 1 次（可被 `disableFallback` 关闭） | 非流式结果或原错误 |

矩阵中每一行都可以在正文对应小节找到源码证据。记住三件事，**401/429/529 这三类最容易混淆**（一个刷新凭证、一个看订阅、一个看连续计数）；**工具与 Hook 失败不走 API 重试**（前者回填给模型，后者归并 outcome）；**模型输入类错误先改状态再重试**（压缩、升上限），指数退避不会让同一份过长输入变短。

### API 重试｜每次重发前都重新判断环境

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

> 证据，[source] `restored-src/src/services/api/withRetry.ts` 的 `withRetry<T>()`（2.1.88 source map 还原源码）。

函数说明，`withRetry<T>()` 包住一次 API 操作，成功时返回 `T`，等待重试时 yield 系统错误消息，耗尽或遇到不可重试错误时抛出 `CannotRetryError`。默认最大重试数是 10，因此普通情况下最多执行 `maxRetries + 1` 次操作。

参数说明，`getClient` 在首次调用以及 401、OAuth token revoked、Bedrock/Vertex 认证错误或陈旧连接后重新创建客户端；`operation` 接收从 1 开始的 `attempt`，第三个参数 `context` 是本轮可变的 `RetryContext`。`options.maxRetries` 可为 `undefined`，此时回退到 `CLAUDE_CODE_MAX_RETRIES` 的解析结果或常量 10；源码对该环境变量只做 `parseInt`。`fallbackModel`、`fastMode`、`signal`、`querySource`、`initialConsecutive529Errors` 都可为 `undefined`；连续 529 初值用 `?? 0` 回退。

字段说明，`maxRetries` 是解析后的重试次数，循环上界因此为 `maxRetries + 1`；`retryContext.model` 与 `retryContext.thinkingConfig` 取自 `options`，`retryContext.fastMode` 只在 fast mode 启用时加入。`client` 以 `null` 开始并按需创建，`lastError` 保存最近一次异常；重试耗尽时两者共同支持抛出携带上下文的 `CannotRetryError`。

为什么 client 也要重建？因为有些失败不在请求内容，而在连接或凭证状态。源码会在 401 或 token revoked 后走 OAuth 刷新；Bedrock/Vertex 认证异常会清凭证缓存；`ECONNRESET`、`EPIPE` 被视为陈旧连接，在功能开关允许时还会禁用 keep-alive 后重连。原样复用旧 client，只会把同一个坏状态重复十次。

### 哪些错误允许重试

真正的闸门是同文件里的 `shouldRetry()`，

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

> 证据，[source] `restored-src/src/services/api/withRetry.ts` 的 `shouldRetry()`（2.1.88 source map 还原源码）。

函数说明，`shouldRetry(error)` 只回答当前 `APIError` 是否值得再交给 `withRetry()`。片段省略了源码中优先级更高的分支，无人值守 persistent 模式会把 429/529 视作可重试；remote/CCR 模式会把 401/403 当作基础设施的短暂故障；消息里含 `overloaded_error`、或者是可调整 `max_tokens` 的上下文溢出，也会直接返回 `true`。

参数说明，省略 `error.status` 时，在连接错误特判之后直接进入不可重试分支。服务端非标准头 `x-should-retry` 的可见值是字符串 `'true'`、`'false'` 或缺失；缺失时继续按连接类型和状态码判断，它还会受到订阅类型和内部运行环境约束。429 对普通订阅用户默认不走这里的常规重试，Enterprise 可重试。408 是请求超时，409 在源码注释中是 lock timeout，5xx 是服务端错误。其余 4xx 默认返回 `false`。

这段代码也说明"HTTP 失败一律重试"为什么危险。400 往往说明参数或上下文有问题，重放不会改变结果；403 通常要用户修复授权。只有源码明确知道凭证会被刷新、连接会被重建，或者服务端声明可以重试时，才值得继续。

### 退避按服务端提示或指数公式计算

重试延迟由 `getRetryDelay()` 统一计算，

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

> 证据，[source] `restored-src/src/services/api/withRetry.ts` 的 `getRetryDelay()`（2.1.88 source map 还原源码）。

函数说明，`getRetryDelay()` 优先服从可解析的 `Retry-After` 秒数；header 缺失或无效时，从 500ms 开始指数增长，基础延迟默认封顶 32,000ms，再增加最多 25% 的随机 jitter。

参数说明，`attempt` 是从 1 开始的尝试次数。`retryAfterHeader` 可以是字符串、`null` 或 `undefined`；空值和无法 `parseInt` 的值回退到指数退避。`maxDelayMs` 默认 32,000，但 persistent 模式会传入 5 分钟；需要注意，合法 `Retry-After` 会直接返回，不受函数内部的 `maxDelayMs` 限制，persistent 调用方因此又在外层用 6 小时上限裁剪。

普通模式在 sleep 之前会 yield 一条包含 `retryInMs`、`retryAttempt` 和 `maxRetries` 的 system message。`QueryEngine` 对 SDK 输出时再把它转换为 `type: 'system', subtype: 'api_retry'`，结构化宿主因此可以展示等待时间与错误类别。

### 529 降级｜连续容量错误触发换模

当 API 返回 529 或消息里含 `overloaded_error` 时，`withRetry()` 会累计连续失败。源码中的关键边界是，计数达到 `MAX_529_RETRIES = 3`，并且当前模型满足环境限定后，只有配置了 `fallbackModel` 才抛出专门的 `FallbackTriggeredError`。

真正换模型发生在 `restored-src/src/query.ts`，

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

> 证据，[source] `restored-src/src/query.ts` 的 `queryLoop()` 模型请求循环（2.1.88 source map 还原源码）。

函数说明，这段位于 `queryLoop()` 的模型请求循环。它只捕获 `withRetry()` 发出的换模信号；随后清掉失败尝试产生的 assistant、tool result 和 tool-use 暂存，丢弃流式工具执行器，再用备用模型重做整次模型请求。

参数说明，`fallbackModel` 是可选字符串，缺失时不会进入该分支。`attemptWithFallback` 设为 `true` 让内层 while 再跑一次。新建 `StreamingToolExecutor` 时继续使用当前工具数组、`canUseTool` 与上下文。系统消息 level 固定为 `'warning'`，使用户能看到发生了降级。

清空旧 `toolUseBlocks` 很关键。失败流中如果已经产出一个 `tool_use`，备用模型重试后会生成新的 ID。把旧结果混进新请求会制造孤儿 `tool_result`，严重时还可能重复执行工具。因此这里先修复协议边界，再用备用模型重做本次采样。

### 流失败｜能降为非流式，但要防止重复副作用

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

> 证据，[source] `restored-src/src/services/api/claude.ts` 的 `queryModelWithStreaming()` 错误分支（2.1.88 source map 还原源码）。

函数说明，这段来自 `queryModelWithStreaming()` 的错误分支。默认可从失败的 streaming 请求降到 non-streaming 请求；环境变量或远端开关启用时，则把原错误交回 `withRetry()`，不做中途降级。流式错误本身若是 529，会以初值 1 进入后续连续 529 计数。

参数说明，`CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` 使用 truthy 环境变量解析；远端开关的静态默认值是 `false`。`onStreamingFallback` 可以是 `undefined`，省略回调仍可降级。`signal` 是同一个 `AbortSignal`，取消仍能中断非流式请求。`querySource` 和 `fallbackModel` 都可为 `undefined`，分别影响 529 重试策略与是否允许最终换模。

字段说明，`disableFallback` 合并环境变量与 `tengu_disable_streaming_to_non_streaming_fallback`；真值直接抛出 `streamingError`。降级分支把 `didFallBackToNonStreaming` 设为 `true` 并调用 `options.onStreamingFallback`。传入非流式执行器的第一层对象用 `model` 与 `source` 标识请求；第二层对象继续传递 `model`、`fallbackModel`、`thinkingConfig`、`signal`、`querySource`，并用 `initialConsecutive529Errors` 把当前 529 计为 1，否则从 0 开始。

为什么源码还提供关闭开关？注释给出的原因很具体，启用 streaming tool execution 时，部分流可能已经启动了工具；再用非流式请求重做相同采样，可能生成同一工具动作并执行第二次。外层 `queryLoop()` 在收到 `onStreamingFallback` 后会 tombstone 部分 assistant message、清空旧 tool result，并 discard executor，但已经越过副作用边界的外部操作并不能靠清数组撤销。

静态源码也不能告诉我们线上具体开关值。

### 工具失败｜把异常回填给模型

工具执行器采用另一种恢复策略。`tool.call()` 抛错后，它不会自己再次调用工具，而是把错误转换成协议完整的结果，

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

> 证据，[source] `restored-src/src/services/tools/toolExecution.ts` 的 `checkPermissionsAndCallTool()`（2.1.88 source map 还原源码）。

函数说明，这段来自 `restored-src/src/services/tools/toolExecution.ts` 的 `checkPermissionsAndCallTool()`。它先用 `formatError()` 规范化错误，再运行 `PostToolUseFailure` Hook，最终返回一条 user role 的 `tool_result`，让 `queryLoop()` 把失败结果连同历史交给模型进入下一轮。

参数说明，`toolUseID` 必须原样写入 `tool_use_id`，否则 API 无法配对；`processedInput` 是经过 Schema、工具校验和 PreToolUse 处理后的输入。`isInterrupt` 是布尔值，只在错误为项目自定义 `AbortError` 时为 `true`。`requestId` 可能为 `undefined`；`mcpServerType` 和安全化后的 base URL 只对 MCP 诊断有意义。`toolUseResult` 保存宿主侧原始错误表示，面向模型的 `content` 最长会由 `formatError()` 截到首尾合计 10,000 字符。

字段说明，`hookMessages` 收集 `runPostToolUseFailureHooks()` 产出的更新；最终返回项的 `message` 是 user message，内部块以 `type: 'tool_result'`、`is_error: true` 标记失败，并把 `content` 与 `tool_use_id` 写回协议。完整返回对象还用 `sourceToolAssistantUUID` 关联产生该工具请求的 assistant 消息。

工具失败后直接回填结果，这是一个重要的安全选择。Bash 可能已经执行前半段，Edit 可能已经写盘，MCP 服务也可能在返回错误前提交了远端事务。执行器无法仅凭一个 exception 判断副作用是否发生。把错误作为 `tool_result` 回给模型，可以让模型检查现场、换参数或向用户说明，并避免在副作用状态未知时自动重做。

如果错误是 `McpAuthError`，执行器还会把对应 client 从 `connected` 改为 `needs-auth`；其他状态、client 缺失或已离开 connected 时都保持原状态。这次状态修复不会自动重放原 MCP 调用。

### Hook 失败｜失败本身也分 blocking 与 non-blocking

Hook 执行的结果类型定义在 `restored-src/src/utils/hooks.ts`，

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

> 证据，[source] `restored-src/src/utils/hooks.ts` 的 `HookResult`（2.1.88 source map 还原源码）。

类型说明，`HookResult` 把"Hook 自己运行失败"和"Hook 有意阻断业务动作"分开。`outcome` 只有源码列出的四个值，`success` 是成功；`blocking` 是明确阻断；`non_blocking_error` 表示 Hook 异常但不天然接管主控制流；`cancelled` 表示取消。

字段说明，`blockingError`、`preventContinuation`、`stopReason`、`additionalContext`、`updatedInput`、`retry` 都可以是 `undefined`。`permissionBehavior` 的可选值是 `'ask'`、`'deny'`、`'allow'`、`'passthrough'`；省略时该 Hook 不提供权限意见。`retry` 只由 PermissionDenied 等特定 Hook 输出消费。

其余字段承载不同消费通道，`message` 与 `systemMessage` 负责展示；`initialUserMessage` 和 `additionalContext` 进入模型上下文；`updatedMCPToolOutput` 只供 MCP 结果替换；`permissionRequestResult` 交给权限请求调用方；`elicitationResponse` 与 `elicitationResultResponse` 分别承载两类 MCP elicitation 结果；`watchPaths` 交给文件监听调用方。`hookPermissionDecisionReason` 解释 Hook 权限决策，`hook` 是必填来源对象，用于诊断和后续聚合。

命令 Hook 的退出码也有约定，0 被视为成功，2 或 JSON `decision: 'block'` 被视为阻断，其他非零通常进入非阻断错误。JSON 结构错误、进程启动失败或超时会被包装成 `hook_error_during_execution` / `hook_non_blocking_error` 一类 attachment，从而把扩展脚本故障限制在 Hook 协议内。

"非阻断"结果仍会作为 attachment 展示。PreToolUse Hook 的明确 deny/stop 会让当前工具停在副作用边界之前；Stop Hook 的 blocking error 会作为反馈加入消息并让 `queryLoop()` 再跑一轮。普通执行错误若未形成 blocking decision，主流程可以继续。失败语义取决于生命周期节点与返回结果。

### 用户取消｜Abort 走独立终止路径

项目需要同时识别自己的 `AbortError`、浏览器/Node 的 abort-shaped error，以及 SDK 的 `APIUserAbortError`，

```ts
export function isAbortError(e: unknown): boolean {
  return (
    e instanceof AbortError ||
    e instanceof APIUserAbortError ||
    (e instanceof Error && e.name === 'AbortError')
  )
}
```

> 证据，[source] `restored-src/src/utils/errors.ts` 的 `isAbortError()`（2.1.88 source map 还原源码）。

函数说明，`isAbortError()` 位于 `restored-src/src/utils/errors.ts`，统一识别三种取消形状。源码特意使用 `instanceof APIUserAbortError`，因为 minified build 可能改写构造器名，单纯比较 `constructor.name` 不可靠。

参数说明，`e` 是 `unknown`。项目 `AbortError`、SDK `APIUserAbortError`、以及 `name === 'AbortError'` 的普通 `Error` 返回 `true`，其他值返回 `false`。这只是分类函数；不同调用点仍会决定如何清理资源和生成消息。

在流式请求中，SDK 抛出 `APIUserAbortError` 后还要检查调用方的 `signal.aborted`，为真才是用户 ESC 取消；为假则被转换为 `APIConnectionTimeoutError`，进入超时处理。这个区分避免把 SDK 内部 timeout 错报成"用户中断"。

`queryLoop()` 收到真实取消后跳过 assistant API error。模型流阶段取消会生成普通 interruption user message；工具阶段取消会生成 tool-use interruption result。如果 abort reason 是 `'interrupt'`，表示新的用户输入已经排队，源码会跳过额外 interruption message，避免重复上下文。取消最终返回的 reason 为 `aborted_streaming` 或 `aborted_tools`，流程随即停止退避。

### 模型错误也有"修复输入再试"的分支

有些模型/API 错误表示当前上下文形状无法被接受。`queryLoop()` 会先修复状态，再用新状态重试。

最典型的是 prompt too long。API error message 会先被 withheld，不立即显示；随后运行时优先尝试 drain 已暂存的 context collapse，再尝试一次 reactive compact。压缩成功后，`buildPostCompactMessages()` 重建消息链，并以 `transition.reason = 'reactive_compact_retry'` 继续。已经尝试过的布尔标志 `hasAttemptedReactiveCompact` 会保留，防止"压缩后仍过长 → 再压缩"的死循环。

另一个例子是 `max_output_tokens`。在相应开关开启且省略显式环境变量覆盖时，它可以先把同一请求的输出上限提升到 64K；仍然截断时，再追加一条 meta user message，要求模型从中断处继续并拆小剩余工作。恢复次数由 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` 限制。达到上限后，之前 withheld 的错误才会显示。

这类恢复的共同点是，先改变导致失败的状态，再重试；同一份过长输入不会因指数退避而变短。

### 最后一道闸｜继续、结束，还是把现场交给用户

当所有 API 重试都失败，`queryModelWithStreaming()` 会拆开 `CannotRetryError`，取回 `originalError` 和失败时的 `retryContext.model`，再调用 `getAssistantMessageFromError()`。它生成的 assistant message 会设置 `isApiErrorMessage: true`，`error` 的源码可选值是，

- `authentication_failed`
- `billing_error`
- `rate_limit`
- `invalid_request`
- `server_error`
- `unknown`
- `max_output_tokens`

其中 `errorDetails` 可以是 `undefined`，只在需要保留底层细节供恢复或诊断时写入；`apiError` 也可以缺失。不同 provider、交互式 CLI 与无头模式会生成不同的人类提示，但不会改变这组 SDK 分类。

`queryLoop()` 的最终决定可以按四类理解，

1. 工具失败已经形成配对的 `tool_result`，把它加入消息链，继续下一轮，让模型决定修正或解释。
2. Stop Hook 明确返回 blocking feedback，把反馈加入消息，再运行一轮；`stopHookActive` 防止递归语义失控。
3. API error 已经是 synthetic assistant message，执行 `StopFailure` Hook，跳过普通 Stop Hook，然后结束本轮，避免"错误 → Stop Hook 阻断 → 再请求 → 同一错误"的死循环。
4. 用户取消或无法预期的运行时异常，补齐缺失的 tool result / interruption 信息，释放 stream 资源，以 `aborted_*` 或 `model_error` 终止当前循环。

本轮结束后，assistant error、tool error 和 interruption 仍以消息或 attachment 留给上层记录和展示；真正的会话持久化、resume 与 fork 正是下一篇要继续追踪的主题。

### 静态源码能确认什么，不能确认什么

静态源码可以确认默认重试数、HTTP status 与 header 的判断、指数退避公式、连续 529 的计数门槛、流转非流的入口、工具错误回填形状、Hook outcome、Abort 分支和 `queryLoop()` 的终止 reason。

但功能开关、用户订阅类型、provider 返回的 header、实际 `fallbackModel`、网络故障分布和远端实验值都属于运行时条件。

副作用边界也必须保守描述。流式 fallback 会清理局部消息与 executor，但不能撤销已经落盘或提交到外部系统的动作。要判断一次失败能否安全重试，仍然需要检查具体工具实现和真实现场。

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。行号以当前仓库为准。

| 机制 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| 分类标签 | `classifyAPIError()` | `src/services/api/errors.ts` | [source] 已确认 |
| 重试入口 | `withRetry<T>()` / `getMaxRetries()` | `src/services/api/withRetry.ts` | [source] 已确认 |
| 重试闸门 | `shouldRetry()` / `x-should-retry` / 429/401 分支 | `src/services/api/withRetry.ts` | [source] 已确认 |
| 退避 | `getRetryDelay()` / `BASE_DELAY_MS` | `src/services/api/withRetry.ts` | [source] 已确认 |
| 529 换模 | `MAX_529_RETRIES` / `FallbackTriggeredError` | `src/services/api/withRetry.ts` | [source] 已确认 |
| 换模执行 | `queryLoop()` 的 fallback 分支 | `src/query.ts` | [source] 已确认 |
| 流降级 | `queryModelWithStreaming()` / `executeNonStreamingRequest()` | `src/services/api/claude.ts` | [source] 已确认 |
| 工具回填 | `checkPermissionsAndCallTool()` 的 catch 分支 | `src/services/tools/toolExecution.ts` | [source] 已确认 |
| Hook outcome | `HookResult` / `outcome` 四值 | `src/utils/hooks.ts` | [source] 已确认 |
| Abort 分类 | `isAbortError()` | `src/utils/errors.ts` | [source] 已确认 |
| 模型错误修复 | `hasAttemptedReactiveCompact` / `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` | `src/query.ts` | [source] 已确认 |
| 终态消息 | `getAssistantMessageFromError()` / `isApiErrorMessage` | `src/services/api/claude.ts` | [source] 已确认 |

> 证据说明，上表全部条目都来自 2.1.88 还原源码的静态确认。两类边界需要区分，订阅类型、`USER_TYPE`、persistent/remote 模式、feature 开关、`fallbackModel` 具体值与网络故障分布属于 [runtime]；"流式降级不会重复副作用"受关闭开关约束的表述，以及错误矩阵的分类归并属于 [inference]/[runtime] 混合，正文已逐项注明。

## 设计决策｜为什么分层恢复，而不是一个全局 catch

源码里找不到官方选型记录，下面的判断来自代码结构与调用关系，属于解释而非官方声明。

**第一，为什么错误要关在产生它的那一层？** 因为不同层的错误拥有不同的信息与副作用状态。API 层知道 header 和状态码，可以判断凭证是否刷新、连接是否重建；工具层知道副作用可能已经发生，不能自动重放；流层知道部分工具可能已经启动。让上层盲目 catch 再"再试一次"，要么重复副作用，要么把本来可恢复的错误直接暴露给用户。

**第二，为什么"诊断标签"与"重试决策"分离？** 因为同一个标签在不同环境下语义不同，401 在普通路径是认证错误、在 remote/CCR 是基础设施故障；429 对订阅用户和企业用户的处理分流。`classifyAPIError()` 负责把错误说清楚，`shouldRetry()` 与外层上下文负责决定怎么做，单一分类函数可以稳定，决策逻辑随运行环境变化。

**第三，为什么工具失败不自动重试？** 因为执行器无法仅凭一个 exception 判断副作用是否发生，Bash 可能已执行前半段，Edit 可能已写盘，MCP 服务可能在返回错误前提交了远端事务。把 `is_error: true` 的 `tool_result` 回填给模型，是把修正机会交回 Agent 循环，同时避免在副作用状态未知时自动重做。

**第四，为什么换模和流降级都要先清暂存？** 因为失败流中可能已经产出 `tool_use`，备用模型或非流式请求重试后会生成新的 ID；混入旧结果会制造孤儿 `tool_result`，严重时重复执行工具。先修复协议边界（清空 assistant 消息、tool result、tool-use 暂存、discard executor），再重做本次采样，这也是"不能撤销已落盘副作用"下的最小安全动作。

## 练习｜在真实会话里观察错误恢复

1. **模拟一次 API 错误观察标签与呈现。** 在带网络的会话里运行一个长任务，在 debug 日志中定位 `classifyAPIError` 的标签输出与 `withRetry` 的 yield 消息（`retryInMs`、`retryAttempt`、`maxRetries`）。再用 `--model` 配一个不可用模型触发认证/模型错误，观察最终 assistant message 的 `error` 分类。约 15 分钟。

2. **制造一次工具失败，观察回填形状。** 让 Bash 执行一个必然失败的命令（如 `ls /nonexistent`），在 debug 日志或 transcript 中确认失败被构造成 `type: 'tool_result'`、`is_error: true`、`tool_use_id` 配对的消息，且模型下一轮收到该结果后尝试修正而不是重复原命令。约 10 分钟。

## 自测

1. `classifyAPIError()` 与 `shouldRetry()` 的分工是什么？
2. 为什么 529 换模前必须清空旧的 `toolUseBlocks`？
3. 工具失败为什么不自动重试，而是回填 `tool_result`？

<details>
<summary>参考答案</summary>

1. **标签 vs 决策。** `classifyAPIError()` 只生成稳定诊断标签（`errors.ts`），例如 401 是认证类、429 是 rate limit；是否重试由 `shouldRetry()` 与外层上下文决定（`withRetry.ts`），同一个标签在不同订阅类型、persistent/remote 模式下处理分流。标签负责把错误说清楚，控制流负责决定怎么做。

2. **为了避免孤儿 `tool_result` 与重复执行。** 失败流可能已经产出一个 `tool_use`，备用模型重试后会生成新的 ID；把旧结果混进新请求会制造无法配对的孤儿 `tool_result`，严重时重复执行工具。因此换模分支先清空 `assistantMessages`、`toolResults`、`toolUseBlocks` 并 discard 流式执行器，再重做本次采样（`query.ts`）。

3. **因为副作用状态未知。** Bash 可能已执行前半段，Edit 可能已写盘，MCP 服务可能在返回错误前提交了远端事务；执行器无法仅凭 exception 判断副作用是否发生（`toolExecution.ts`）。把 `is_error: true` 且配对 `tool_use_id` 的 `tool_result` 回填给模型，让模型检查现场、换参数或向用户说明，避免在副作用状态未知时自动重做。

</details>

## 回顾｜Hook 有什么妙用

<details>
<summary>展开查看回顾</summary>

上一篇问，你能想到 Hook 有什么妙用？Hook 的价值在于把"每次都必须发生"的动作放到生命周期边界上，变成可重复、可审计的工程约束。① `PreToolUse` 挡危险操作与敏感文件，在 Bash/Write/Edit 执行前拒绝 `rm -rf`、强制 push、fork bomb，阻止修改 `.env`、SSH key 和云凭证；规则在模型决策之后、工具副作用之前，即使 prompt 漏掉约束也过不了这道门。② `git commit` 变成自动 review 门禁，matcher 只匹配 `git commit`，启动 reviewer subagent 检查 staged diff，严重问题直接阻止，轻微问题自动修复但保持 unstaged。③ `SessionStart` 注入团队规则与分支状态，`Stop` 时由隔离 Agent 把筛选过的进展同步到 CLAUDE.md，但必须用 `stop_hook_active` 做循环护栏，否则 Stop Hook 会在每次重试时再次阻止停止。④ 把 `npm run dev`、`tail -f` 这类占住前台的命令识别后转入后台，主 Agent 继续推进。⑤ `Notification` 接桌面通知或 Slack，`Stop` 通知整个任务结束，把"人在等待"变成可达通知。一句话，把不可忘记的规则放到不可绕过的事件点，把需要隔离的分析交给 subagent，把需要等待人的状态接到通知系统。

</details>

## 留给下一篇的问题

Anthropic 提到 Fable 5 遇到一些问题时可以降级到 Opus 4.8 执行；根据 2.1.88 的源码，这种 fallback 是如何实现的？

## 相关链接

- **上一篇**，[18 生命周期机制如何横切整个运行时](./18-hooks-lifecycle.md)，`PostToolUseFailure` 与 `HookResult.outcome`
- **下一篇**，[20 会话历史如何持久化与恢复](./20-session-history-and-resume.md)，回答本文的 fallback 实现问题
- **平行阅读**，[8 API 流式与消息协议](./08-api-streaming.md)，`tool_use` / `tool_result` 配对协议
- **官方参考**，[Claude Code 错误参考](https://code.claude.com/docs/en/errors)
