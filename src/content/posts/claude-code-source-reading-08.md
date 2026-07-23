---
title: "Claude Code源码解读08：Claude 请求与响应如何传输"
published: 2026-07-23
description: "Claude Code 中的 API 流式请求与事件组装：从 message_start 到 message_stop，以及重试/缓存/provider 适配。"
tags: ["claude-code", "source-code", "ai-agent", "api-streaming"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-08/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：**如果用户刚发完一条消息，却马上发现有问题并打断（例如按 `Esc` / `Ctrl+C`），这条消息还会出现在后面的对话里吗？**

先给结论：在 **transcript（持久会话日志）**里，这条用户消息通常会先被落盘；在 **当前会话视图**里，REPL 可能会把它回滚成“未发送”，所以你看到的可能是看起来没记住这条消息。

关键点在于两层行为不同。

先是持久化层：`QueryEngine.submitMessage()` 在调用模型前就持久化用户输入。源码里是先 `this.mutableMessages.push(...messagesFromUserInput)`，再在 `persistSession && messagesFromUserInput.length > 0` 分支里执行 `recordTranscript(messages)`。注释明确写了原因：如果进程在 API 返回前被中断，transcript 也能保存用户消息，`--resume` 才不会拿不到会话。

```ts
this.mutableMessages.push(...messagesFromUserInput)

if (persistSession && messagesFromUserInput.length > 0) {
  const transcriptPromise = recordTranscript(messages)
  ...
}
```

再看 UI 层：REPL 的 `onCancel()` 用 `abortController?.abort('user-cancel')` 通知本轮取消。随后在结束回收路径中，如果是 `user-cancel` 且当前没有进入新一轮 query、输入框也没有被改写，就会触发 `removeLastFromHistory()` + `restoreMessageSync(lastUserMsg)`，并把输入框恢复为原始内容，这样当前会话会“退回到打断前”的状态。

```ts
abortController?.abort('user-cancel')

if (abortController.signal.reason === 'user-cancel' && !queryGuard.isActive && inputValueRef.current === '' && getCommandQueueLength() === 0) {
  const lastUserMsg = msgs.findLast(selectableUserMessagesFilter)
  removeLastFromHistory()
  restoreMessageSyncRef.current(lastUserMsg)
}
```

因此，你常见到的现象是：**日志里有痕迹，页面里可能被撤回**。后面如果继续发送新问题，这条旧消息通常不会作为可见上下文继续叠加；但它在 transcript 中留下了一个“已提交但未完成”的尝试记录。后续若触发工具阶段，`query.ts` 还会补一条 `createUserInterruptionMessage`（普通打断是 `[Request interrupted by user]`，工具打断是 `[Request interrupted by user for tool use]`）作为中断标记，但这是为了链路完整性，不等于把用户消息重复注入模型。

```ts
if (toolUseContext.abortController.signal.reason !== 'interrupt') {
  yield createUserInterruptionMessage({ toolUse: false })
}
```

这和本章原问题呼应：流式网络事件先被组装成内部消息，`content_block_stop` 和 `message_delta` 决定何时可交付；打断只是把这条组装链中止在某个阶段，并不改写“用户输入何时入库”的时机逻辑。

本章沿 `restored-src/src/query.ts::queryLoop`、`restored-src/src/services/api/claude.ts::queryModel`、`restored-src/src/services/api/client.ts::getAnthropicClient` 和 `restored-src/src/services/api/withRetry.ts::withRetry` 这条调用链往下看。源码来自 source map 还原出的 2.1.88。

为控制篇幅，下面的源码块只摘取能证明当前结论的原始行；凡是用 `// 省略……` 标出的地方，都是本文明确删去的无关参数或分支，不是源码里原有的伪代码。

## 先建立一个简单模型：发送、组装、交还

这条链路可以先压缩成三个动作：

1. `queryLoop` 把本轮上下文交给模型调用层；
2. `queryModel` 构造请求并把网络增量组装成内容块；
3. 完整内容块作为 `AssistantMessage` 回到 `queryLoop`，若其中有 `tool_use`，Agent 循环就转入工具执行。

![Claude Code API 流式请求、事件组装与恢复路径](/images/posts/claude-code-source-reading-08/08-api-streaming-handdrawn.png)

图里最重要的边界在 `content_block_stop`：网络层可以不断发 delta，但 Claude Code 不会把半截工具参数当成一次完整工具调用。另一个容易忽略的边界在 `message_delta`：内容块虽然已经产出，计费信息和停止原因仍可能尚未到齐。

## 第一站：queryLoop 只依赖“模型调用器”

生产环境的依赖装配在 `restored-src/src/query/deps.ts::productionDeps`。它把 `callModel` 指向 `queryModelWithStreaming`：

```ts
export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
```

`productionDeps()` 返回 Query Loop 的外部依赖。这里的 `callModel` 是模型 I/O 入口；其余三个字段分别负责微压缩、自动压缩和 UUID 生成。测试可以用 `params.deps` 替换这些实现，因此 `queryLoop` 不必直接绑定网络客户端。

进入本轮 API 调用时，`restored-src/src/query.ts::queryLoop` 把消息、提示词、工具、取消信号和运行选项一起传下去。下面只保留与本章有关的参数：

```ts
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    model: currentModel,
    toolChoice: undefined,
    isNonInteractiveSession:
      toolUseContext.options.isNonInteractiveSession,
    fallbackModel,
    querySource,
    // 省略 Agent、MCP、缓存和追踪参数
  },
})) {
  // 省略：消费模型层产出的内部消息与流事件
}
```

`deps.callModel(...)` 返回异步生成器，所以 `queryLoop` 可以边收到、边处理。`messages` 已经加上用户上下文；`systemPrompt` 是本轮完整系统提示词；`tools` 是候选工具集合；`signal` 是 `AbortSignal`，取消时一路传到 SDK 请求。`options.model` 是当前模型；`fallbackModel` 可以是字符串或 `undefined`，后者表示没有可切换的备用模型；`toolChoice` 在这条主循环路径明确传 `undefined`，让下层不强制指定某个工具；`isNonInteractiveSession` 是布尔值；`querySource` 是运行来源标识，其具体字符串还会受入口和运行时影响，静态源码不应把它臆造成固定单值。

这里有一个关键设计：Query Loop 不理解 SSE，也不自己拼 JSON。它只消费 `queryModelWithStreaming` 产出的三类对象：`StreamEvent`、`AssistantMessage` 和 `SystemAPIErrorMessage`。网络协议的复杂度被收在 API 层，Agent 循环只关心“有没有形成 assistant 块”和“有没有形成 tool_use”。

## 第二站：先把内部上下文整理成 API 参数

`queryModel` 不是拿到 `messages` 就直接发送。它先在 `restored-src/src/services/api/claude.ts` 中完成几步整理：筛选本轮可发送的工具并调用 `toolToAPISchema`，用 `normalizeMessagesForAPI` 转换内部消息，修复 `tool_use/tool_result` 配对，按条件裁掉不被当前模型支持的块，再构造 system blocks 和缓存断点。

真正生成请求体的是 `queryModel` 内部的 `paramsFromContext(retryContext)`。它之所以接收 `retryContext`，是因为重试时模型、thinking 配置或 `max_tokens` 可能被校正：

```ts
return {
  model: normalizeModelStringForAPI(options.model),
  messages: addCacheBreakpoints(
    messagesForAPI,
    enablePromptCaching,
    options.querySource,
    useCachedMC,
    consumedCacheEdits,
    consumedPinnedEdits,
    options.skipCacheWrite,
  ),
  system,
  tools: allTools,
  tool_choice: options.toolChoice,
  ...(useBetas && { betas: betasParams }),
  metadata: getAPIMetadata(),
  max_tokens: maxOutputTokens,
  thinking,
  ...(temperature !== undefined && { temperature }),
  // 省略 context_management、output_config、speed 等条件字段
}
```

`paramsFromContext()` 生成 `BetaMessageStreamParams`。`model` 会被标准化；`messages` 会按缓存策略插入断点；`system` 和 `tools` 分别是系统提示词块与 API 工具 Schema；`tool_choice` 的本地类型是 SDK 的 `BetaToolChoiceTool | BetaToolChoiceAuto | undefined`，分别表示指定工具、自动选择或不发送该选项，而主 Query Loop 这里传的是 `undefined`；`betas` 仅在非空时出现；`max_tokens` 优先使用重试修正值，其次使用本轮覆盖值，最后回退到模型默认上限。

`thinking` 的静态分支也值得讲清楚：配置为 `disabled`，或环境变量关闭 thinking 时，请求不带有效 thinking 配置；模型支持 adaptive thinking 时使用 `{ type: 'adaptive' }`；否则使用 `{ type: 'enabled', budget_tokens }`，且预算不会超过 `max_tokens - 1`。`temperature` 只在 thinking 关闭时发送，调用方未覆盖时回退为 `1`。`enablePromptCaching` 如果是 `undefined`，则由 `getPromptCachingEnabled(model)` 决定；。

这一步解释了为什么内部消息不能原封不动发给 API。恢复会话、动态工具、MCP 连接状态、提示词缓存和模型能力都会改变最终请求体。Claude Code 先把这些差异消化掉，后面的 provider 层才有一个相对稳定的 Messages API 形状。

## 第三站：provider 不同，主协议尽量保持一致

provider 的选择可以直接从 `restored-src/src/utils/model/providers.ts::getAPIProvider` 看出来：

```ts
export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : 'firstParty'
}
```

`getAPIProvider()` 没有参数，返回值是 `'bedrock' | 'vertex' | 'foundry' | 'firstParty'`。三个环境变量都按 `isEnvTruthy` 解释；都未开启时回退到 `firstParty`。由于这是有优先级的条件链，多个 provider 标志同时为真不是一个值得依赖的配置方式。

客户端构造集中在 `restored-src/src/services/api/client.ts::getAnthropicClient`。它接收 `apiKey?`、必填的 `maxRetries`、可选 `model`、可选 `fetchOverride` 和可选 `source`。`queryModel` 调它时把 `maxRetries` 设为 `0`，因为 Claude Code 在外层 `withRetry` 自己管理重试，避免 SDK 和业务层叠加重试。

`getAnthropicClient` 会根据环境选择 `AnthropicBedrock`、`AnthropicFoundry`、`AnthropicVertex` 或标准 `Anthropic`，同时注入 session header、代理 fetch 配置和认证。`apiKey` 为 `undefined` 时走环境或现有认证状态；`fetchOverride` 为 `undefined` 时使用默认 fetch 路径；`model` 为 `undefined` 对部分辅助调用是允许的，但主 Query Loop 会传当前模型。

这里需要指出一个源码边界：`getAPIProvider()` 的判断顺序是 Bedrock、Vertex、Foundry，而 `getAnthropicClient()` 的客户端分支顺序是 Bedrock、Foundry、Vertex。这进一步说明多个 provider 开关同时打开属于含义不清的配置；文章只能报告静态分支，不能替用户推导一个“正确混用结果”。

## 第四站：真正发出去的是 raw stream

请求发出的位置仍在 `restored-src/src/services/api/claude.ts::queryModel`：

```ts
const result = await anthropic.beta.messages
  .create(
    { ...params, stream: true },
    {
      signal,
      ...(clientRequestId && {
        headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
      }),
    },
  )
  .withResponse()

streamRequestId = result.request_id
streamResponse = result.response
return result.data
```

`messages.create()` 的第一个参数是前面组装好的请求体，并强制加入 `stream: true`；第二个参数携带 `signal`，以及仅在生成了 `clientRequestId` 时才附加的请求头。`.withResponse()` 同时保留流数据、HTTP response 和服务端 request id。`clientRequestId` 只在 first-party 且 base URL 满足条件时生成；第三方 provider 下为 `undefined`，相应 header 也不会出现。

源码注释说明这里刻意使用 raw stream，而不是 SDK 的 `BetaMessageStream`。原因很具体：SDK 的高级封装会在每个 `input_json_delta` 到来时反复做 partial JSON 解析；Claude Code 已经准备自己累积工具参数，所以直接消费原始事件，避免重复工作。

需要区分两个名字。导出的 `queryModelWithStreaming()` 是主循环使用的流式接口；`queryModelWithoutStreaming()` 虽然名字像另一条 HTTP 路径，实际上仍会完整消费 `queryModel()` 的生成器，只是最终只返回最后一个 `AssistantMessage`。真正的非流式 HTTP 请求位于 `executeNonStreamingRequest()`，它主要用于流式失败后的恢复，并调用 `messages.create()` 时不设置 `stream: true`。

## 第五站：事件不是文本，它们是一台组装状态机

请求成功建立后，`queryModel` 维护四份核心状态：`partialMessage` 保存 `message_start` 带来的消息壳；`contentBlocks[index]` 保存各个正在增长的内容块；`usage` 保存 token 使用量；`stopReason` 初始为 `null`。

事件循环的开头来自 `restored-src/src/services/api/claude.ts::queryModel`：

```ts
for await (const part of stream) {
  resetStreamIdleTimer()

  switch (part.type) {
    case 'message_start': {
      partialMessage = part.message
      ttftMs = Date.now() - start
      usage = updateUsage(usage, part.message?.usage)
      break
    }
    case 'content_block_start':
      // 省略：按内容块类型初始化 contentBlocks[part.index]
      break
    case 'content_block_delta':
      // 省略：把增量追加到同一 index 的内容块
      break
    // 省略 stop 与 message_delta 分支
  }
}
```

`part` 是 `BetaRawMessageStreamEvent`。`message_start` 初始化消息元数据，并读取可能已经出现的 usage；`content_block_start` 用 `part.index` 创建槽位；后续 delta 也必须通过同一个 `index` 找到它。若 delta 或 stop 找不到对应块，源码会记录 `tengu_streaming_error` 并抛错，而不是凭空创建一个块。

`content_block_start` 会按块类型选择初值：`tool_use` 和 `server_tool_use` 的 `input` 先设为空字符串，`text` 的 `text` 先设为空字符串，`thinking` 的 `thinking` 与 `signature` 也从空字符串开始。文本 start 事件里即使带了内容，这里也不直接采用，因为源码注释记录了 SDK 可能在随后 delta 中再次给出相同文本；选择只累积 delta，是为了避免重复。

### delta 怎样落到正确字段

`content_block_delta` 不是一种单一数据。核心分支可以缩成下面这样：

```ts
switch (delta.type) {
  // 省略：各 delta 与 contentBlock.type 的匹配校验
  case 'input_json_delta':
    contentBlock.input += delta.partial_json
    break
  case 'text_delta':
    contentBlock.text += delta.text
    break
  case 'signature_delta':
    contentBlock.signature = delta.signature
    break
  case 'thinking_delta':
    contentBlock.thinking += delta.thinking
    break
}
```

这段分支位于 `queryModel()` 的 `content_block_delta` case。`input_json_delta` 只允许落到 `tool_use` 或 `server_tool_use`，并要求当前 `input` 仍是字符串；`text_delta` 只允许落到 `text`；`signature_delta` 通常落到 `thinking`，特性开启时也可用于 `connector_text`；`thinking_delta` 只允许落到 `thinking`。源码还看得到 `citations_delta`（当前分支没有继续组装）以及受功能开关控制的 `connector_text_delta`。这些类型检查使“事件顺序错误”变成显式异常，而不是污染下游消息。

工具参数为什么先拼字符串，而不是每个 delta 都 `JSON.parse`？因为任意一个 `partial_json` 都可能只是一段 `{"file_`。只有内容块结束后，完整字符串才适合解析。`restored-src/src/utils/messages.ts::normalizeContentFromAPI` 会用 `safeParseJSON` 解析完整工具输入：空字符串或解析失败会回退到 `{}`，随后再调用对应工具的 `normalizeToolInput`；若非流式 fallback 已经给出对象，则直接保留对象路径。

### content_block_stop 才产出内部 AssistantMessage

当某个块结束，`queryModel` 才把它包装成内部消息：

```ts
const m: AssistantMessage = {
  message: {
    ...partialMessage,
    content: normalizeContentFromAPI(
      [contentBlock] as BetaContentBlock[],
      tools,
      options.agentId,
    ),
  },
  requestId: streamRequestId ?? undefined,
  type: 'assistant',
  uuid: randomUUID(),
  timestamp: new Date().toISOString(),
}
newMessages.push(m)
yield m
```

这段代码位于 `content_block_stop` 分支。`partialMessage` 必须已经由 `message_start` 建立，否则抛出 `Message not found`；`contentBlock` 必须能按 `part.index` 找到。`normalizeContentFromAPI(content, tools, agentId?)` 负责把工具输入字符串转成对象并做工具级修正；`agentId` 可以是具体 Agent ID 或 `undefined`。`requestId` 在服务端未提供时省略，`uuid` 和时间戳则由本地生成。

一个 API response 可能包含多个内容块，因此这里会 yield 多个 `AssistantMessage`，每个消息承载一个完成的 block。对上层来说，文本、thinking 和 `tool_use` 都遵守同一内部消息外壳；差别在 `message.content` 的块类型，而不在网络传输方式。

### usage 与 stop_reason 为什么要“回填”

`content_block_stop` 发生时，`partialMessage` 仍可能带着 `output_tokens: 0` 和 `stop_reason: null`。最终值由后续 `message_delta` 提供：

```ts
case 'message_delta': {
  usage = updateUsage(usage, part.usage)
  stopReason = part.delta.stop_reason

  const lastMsg = newMessages.at(-1)
  if (lastMsg) {
    lastMsg.message.usage = usage
    lastMsg.message.stop_reason = stopReason
  }
  break
}
```

`updateUsage(current, partUsage)` 的第二个参数允许为 `undefined`；此时返回当前 usage 的副本。对 input/cache token 字段，新的正数才覆盖旧值；`output_tokens` 等字段使用 `??` 回退。这不是简单求和，而是把分散在事件里的最新可用字段合成一份 `NonNullableUsage`。

`stopReason` 的静态类型是 `BetaStopReason | null`。本文不能脱离 SDK 类型穷举所有字符串，但本函数明确处理了 `max_tokens` 和 `model_context_window_exceeded`，也把停止原因交给 refusal 映射逻辑；普通完成或工具调用的具体值由 API 事件给出。更重要的是，Query Loop 不把 `stop_reason === 'tool_use'` 当唯一依据，因为源码注释明确说这个值并不始终可靠。

这里使用直接属性修改，而不是替换 `lastMsg.message`。源码给出的原因是 transcript 写队列持有原对象引用并延迟序列化；直接回填才能让已经排队的对象最终带上 usage 和 stop reason。这是一个很典型的工程细节：消息已经向上游 yield，不代表它的元数据在那一刻已经封口。

每个底层事件随后还会被包装为 `{ type: 'stream_event', event: part }` 继续向上 yield。于是内部完整消息与原始增量可以同时存在：交互 UI 可以消费完成块，SDK 在开启 partial message 输出时也能看到原始流事件。

## 第六站：tool_use 怎样把控制权交回 Query Loop

`queryLoop` 收到 `AssistantMessage` 后，从内容中提取 `tool_use`：

```ts
if (message.type === 'assistant') {
  assistantMessages.push(message)

  const msgToolUseBlocks = message.message.content.filter(
    content => content.type === 'tool_use',
  ) as ToolUseBlock[]

  if (msgToolUseBlocks.length > 0) {
    toolUseBlocks.push(...msgToolUseBlocks)
    needsFollowUp = true
  }
}
```

这段代码位于 `restored-src/src/query.ts::queryLoop` 的模型流消费循环。`message.type` 必须是 `'assistant'` 才进入；内容块按 `type === 'tool_use'` 过滤；只要至少一个工具块出现，`needsFollowUp` 就设为 `true`。因此真正驱动 Agent 继续的证据是完整 `tool_use` 块，而不是仅依赖 stop reason。

如果启用了 streaming tool execution，完整工具块一到达还会交给 `StreamingToolExecutor.addTool()`；否则流结束后由常规 `runTools()` 统一执行。两条路径都发生在 `content_block_stop` 之后，所以此时工具输入已经经过累积与规范化。至于如何按名称找到工具、如何用 Schema 验证输入，是下一篇的主题。

没有 `tool_use` 时，`needsFollowUp` 保持 `false`，Query Loop 会进入停止 hook、预算或正常完成路径。有 `tool_use` 时，它等待工具结果，把 `tool_result` 追加到消息历史，再开始下一次模型请求。网络流在这里重新接回了前两篇讨论的 Agent 循环。

## 第七站：错误、重试和取消不是同一个出口

流式请求的失败大致发生在两个阶段：流建立前，或者已经收到部分事件之后。Claude Code 没有把它们都处理成同一个“请求失败”。

### 建连与 API 错误由 withRetry 分类

`queryModel` 用 `restored-src/src/services/api/withRetry.ts::withRetry` 包住客户端创建和流建立。可重试判断集中在 `shouldRetry(error)`：

```ts
// 省略：mock、persistent、header 与认证前置分支
if (error instanceof APIConnectionError) return true
if (!error.status) return false
if (error.status === 408) return true
if (error.status === 409) return true
if (error.status === 429) {
  return !isClaudeAISubscriber() || isEnterpriseSubscriber()
}
if (error.status === 401) return true
if (error.status && error.status >= 500) return true
return false
```

`shouldRetry(error: APIError)` 返回布尔值。上面省略了 mock error、persistent retry、远程认证、`x-should-retry`、OAuth token revoked 和上下文溢出等前置分支，因此不能把这段短代码理解为完整规则。源码能确认的常规候选包括连接错误、408、409、受订阅类型约束的 429、401 和 5xx；服务端 `x-should-retry` 还可以显式影响决策。

重试间隔由 `getRetryDelay(attempt, retryAfterHeader?, maxDelayMs = 32000)` 计算。`retryAfterHeader` 是字符串、`null` 或 `undefined`；能解析为整数时按秒转换为毫秒，否则使用指数退避并加最多 25% jitter。`maxDelayMs` 默认 32000，但 persistent 模式还有自己的上限与长等待心跳。取消信号在每轮和 sleep 中都会检查，因此等待重试时仍能被用户中止。

### 流中断可以降级为非流式请求

已经建立的 stream 若抛错，`queryModel` 会先区分真正的用户取消和 SDK 内部 timeout。用户取消会直接重新抛出；SDK timeout 会改写成 `APIConnectionTimeoutError`。其他流错误在 fallback 未被禁用时进入 `executeNonStreamingRequest()`。

控制这个分支的值包括环境变量 `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` 和功能开关；任一为真都禁止降级。流建立阶段返回 404 还有单独的非流式 fallback。另一方面，如果流正常结束却从未收到 `message_start`，或收到 start 但没有完整内容块、也没有 stop reason，源码同样把它视为不完整流并触发恢复，而不是默认为空回答。

非流式 fallback 会重新调用 `anthropic.beta.messages.create()`，复用 `paramsFromContext` 和 `withRetry`，并对输出 token 上限做额外裁剪。成功后把整条 `BetaMessage` 通过 `normalizeContentFromAPI` 转为一个 `AssistantMessage`。如果前一次流已经向上产出了部分消息，`queryLoop` 会发出 tombstone、清空旧 `assistantMessages/toolResults/toolUseBlocks`，并重建 streaming tool executor，避免半条流里的 tool id 与 fallback 结果混在一起。

### 取消还必须关闭底层资源

流资源的最后一道防线是 `restored-src/src/services/api/claude.ts::cleanupStream`：

```ts
export function cleanupStream(
  stream: Stream<BetaRawMessageStreamEvent> | undefined,
): void {
  if (!stream) return
  try {
    if (!stream.controller.signal.aborted) {
      stream.controller.abort()
    }
  } catch {
    // Ignore - stream may already be closed
  }
}
```

`cleanupStream(stream)` 接受 SDK `Stream` 或 `undefined`；没有 stream 时直接返回，尚未 abort 时调用 controller，已关闭或关闭过程中抛错则吞掉异常。`queryModel` 的 `releaseStreamResources()` 还会取消 `Response.body` 并清空引用，而且它放在 `finally` 中：即使上层对异步生成器提前 `.return()`，底层 TLS/socket 相关资源也会被释放。

用户取消与网络错误的上层语义也不同。`APIUserAbortError` 不会被转换成 assistant API error；`queryLoop` 检测到同一个 `AbortSignal` 后，补齐必要的中断消息或缺失的 `tool_result`，再以 `aborted_streaming` 等终态返回。其他不可恢复错误则会映射为内部错误消息，让 UI、headless 或 SDK 有统一对象可以消费。

## 流关闭之后，哪些结论才算成立

到 `message_stop` 并离开事件循环，只能说明这一条响应流结束。Claude Code 还要确认它确实见过 `message_start`，并且至少形成了内容块，或者拿到了合法 stop reason；随后记录 usage、cost、request id、缓存命中相关字段和诊断信息。是否继续 Query Loop，则由已经形成的 `tool_use`、停止 hook、预算、取消状态和恢复分支共同决定。

因此，“流结束”和“Agent 完成”不是一回事：

- `message_stop` 是单次 API response 的边界；
- `content_block_stop` 是一个内部 assistant 内容块可交付的边界；
- 没有工具调用且通过停止检查，才可能结束当前 Agent turn；
- 有 `tool_use` 时，工具结果会进入历史，下一次 API 请求重新开始。

。即使源码里有 30 秒 stall 记录阈值、默认 90 秒 idle timeout 等常量，它们也只是 2.1.88 这份代码的默认与可配置逻辑，不是生产性能数据。

## 小结

Claude Code 的 API 层做的事情，可以概括为一句话：**把不完整、可能失败、可以取消的网络事件，变成 Query Loop 能安全消费的完整内容块。**

它先归一化消息、系统提示词与工具 Schema，再按 provider 构造 Anthropic 客户端；请求以 raw stream 发出，`message_start` 建消息壳，`content_block_start/delta/stop` 组装文本、thinking 和工具参数，`message_delta` 回填 usage 与 stop reason。完整 `tool_use` 回到 Query Loop 后，才真正触发下一阶段的工具执行。

异常路径同样属于协议的一部分：可重试错误进入 `withRetry`，不完整流可以降级为非流式请求，用户取消沿 `AbortSignal` 传播，`finally` 负责关闭 stream 与 response。这样，REPL、print 模式和 SDK 可以共享同一执行内核，却各自决定是否展示原始增量。

## 留给下一篇的问题

模型发出 tool_use 以后，Claude Code 如何根据工具契约与注册表找到并验证真正要执行的工具？
