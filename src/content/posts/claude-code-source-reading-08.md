---
title: "Claude Code源码解读08：Claude 请求与响应如何传输"
published: 2026-07-23
updated: 2026-07-24
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

再看 UI 层：REPL 的 `onCancel()` 用 `abortController?.abort('user-cancel')` 通知本轮取消。随后在结束回收路径中，如果 reason 是 `user-cancel`、新一轮 query 尚未开始且输入框仍保持原值，就会触发 `removeLastFromHistory()` + `restoreMessageSync(lastUserMsg)`，并把输入框恢复为原始内容，这样当前会话会“退回到打断前”的状态。

```ts
abortController?.abort('user-cancel')

if (abortController.signal.reason === 'user-cancel' && !queryGuard.isActive && inputValueRef.current === '' && getCommandQueueLength() === 0) {
  const lastUserMsg = msgs.findLast(selectableUserMessagesFilter)
  removeLastFromHistory()
  restoreMessageSyncRef.current(lastUserMsg)
}
```

因此，你常见到的现象是：**日志里有痕迹，页面里可能被撤回**。后面继续发送新问题时，这条旧消息通常退出可见上下文；transcript 则保留一个“已提交但未完成”的尝试记录。后续若触发工具阶段，`query.ts` 还会补一条 `createUserInterruptionMessage`（普通打断是 `[Request interrupted by user]`，工具打断是 `[Request interrupted by user for tool use]`）作为链路标记；它与原始用户消息承担不同的协议角色。

```ts
if (toolUseContext.abortController.signal.reason !== 'interrupt') {
  yield createUserInterruptionMessage({ toolUse: false })
}
```

这和本章原问题呼应：网络事件只有在 `content_block_stop` / `message_delta` 等边界出现后，才会被投影成可交付的内部消息；取消可以中止组装，却不会改变“用户输入先入 transcript”的时机。

下面沿 `queryLoop` → `queryModel` → provider client → `withRetry` 追踪请求和响应。源码只支持 2.1.88 的静态调用关系；代码块中的 `// 省略……` 表示删去的无关分支，不是伪代码替代。

## 本章先建立三个概念

- **三层分块**：网络 data chunk、SSE 协议事件和模型 content block 属于不同粒度，边界由各层协议定义。

- **增量组装**：状态机依据 start、delta 与 stop 事件更新当前块，并在完整边界产出内部消息。

- **Provider adapter**：统一请求语义映射到 Anthropic、Bedrock、Vertex 与 Foundry 各自的认证、模型名和 SDK。

![网络分块、协议事件与模型内容块的三层边界](/images/posts/claude-code-source-reading-08/08-streaming-layers-detail-handdrawn.png)

这张图把传输边界分成三层。网络 chunk 何时到达、SSE 事件如何解析、content block 何时完整，分别由不同状态机负责。

## 同一个事故改用流式通道

你想让值班面板实时显示工单进展，于是没有等待最终文本，而是用 `stream-json` 提交金额单位检查。终端旁边的脚本先收到“正在读取支付回调”的增量文本，随后看到一个尚未完整的 `tool_use`，再收到调用结束和测试结果；这些片段到达的时间不同，不能按屏幕显示顺序直接当成最终消息。

provider 会连续发来文本增量、`tool_use` 片段和完成事件；Claude Code 把它们组装成内部消息，工具执行后再交还带调用 ID 的 `tool_result`。脚本看到的是一串结构化事件，Agent loop 使用的是已经归一化的消息。

上一章区分了消息类型，本章继续追踪这张工单如何从网络流进入组装状态机，再回到下一轮查询。

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

`productionDeps()` 返回 Query Loop 的外部依赖。`callModel` 指向流式模型 I/O，`microcompact` 在当前消息历史上执行细粒度压缩，`autocompact` 在阈值满足时触发完整自动压缩，`uuid` 为循环生成消息标识。测试可以用 `params.deps` 替换这四个实现，因此 `queryLoop` 只依赖契约。

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

`deps.callModel(...)` 返回异步生成器，所以 `queryLoop` 可以边收到、边处理。`messages` 已经加上用户上下文，`systemPrompt` 是本轮完整系统提示词，`thinkingConfig` 取自工具上下文，可表达 `adaptive`、带预算的 `enabled` 或 `disabled`；`tools` 是候选工具集合，`signal` 把取消传到 SDK 请求。`options.model` 是当前模型；`fallbackModel` 传入字符串时允许降级，省略时跳过指定备用模型；`toolChoice` 在主循环明确省略，让下层不强制某个工具；`isNonInteractiveSession` 区分宿主交互能力，`querySource` 标记运行来源，实际值由入口和运行时决定。

这里有一个关键设计：Query Loop 只消费 `queryModelWithStreaming` 产出的 `StreamEvent`、`AssistantMessage` 和 `SystemAPIErrorMessage`，SSE 解码与 JSON 增量组装留在 API 层。Agent 循环据此判断 assistant 块和 `tool_use` 是否已经形成。

## 第二站：先把内部上下文整理成 API 参数

`queryModel` 收到 `messages` 后先在 `restored-src/src/services/api/claude.ts` 中整理请求：筛选工具并调用 `toolToAPISchema`，用 `normalizeMessagesForAPI` 转换内部消息，修复 `tool_use/tool_result` 配对，按模型能力裁剪内容，再构造 system blocks 和缓存断点。

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

`paramsFromContext()` 生成 `BetaMessageStreamParams`。`model` 会被标准化；`messages` 按缓存策略插入断点；`system` 和 `tools` 分别是系统提示词块与 API 工具 Schema；`tool_choice` 可表示指定工具、自动选择或省略该选项，主 Query Loop 走省略路径；`betas` 仅在非空时出现。`metadata` 来自 `getAPIMetadata()`，为服务端关联请求补充客户端元数据；`max_tokens` 优先使用重试修正值，其次使用本轮覆盖值，最后回退到模型默认上限。`thinking` 承载最终思考配置，`temperature` 只在计算出数值时写入；被省略的 `context_management`、`output_config`、`speed` 也都按条件分支加入。

`thinking` 的静态分支也值得讲清楚：配置为 `disabled`，或环境变量关闭 thinking 时，请求不带有效 thinking 配置；模型支持 adaptive thinking 时使用 `{ type: 'adaptive' }`；否则使用 `{ type: 'enabled', budget_tokens }`，且预算不会超过 `max_tokens - 1`。`temperature` 只在 thinking 关闭时发送，调用方未覆盖时回退为 `1`。`enablePromptCaching` 省略时由 `getPromptCachingEnabled(model)` 决定。

这一步解释了为什么内部消息不能原封不动发给 API。恢复会话、动态工具、MCP 连接状态、提示词缓存和模型能力都会改变最终请求体。Claude Code 先把这些差异消化掉，后面的 provider 层才有一个相对稳定的 Messages API 形状。

## 第三站：provider 决定请求走哪条云路径

上一节说明了请求形状；接下来要看接收请求的 provider。Claude Code 支持 Anthropic 第一方 API、AWS Bedrock、Google Vertex AI 和 Microsoft Foundry。它们提供相似的 Messages API 外观，但认证、SDK、区域、模型名和部分请求字段各不相同。

### 为什么必须先判断 provider

provider 是 API 客户端工厂的路由结果，至少决定四件事：

1. 用哪个 SDK 客户端发送请求；
2. 用哪套凭证完成认证；
3. 把模型别名转换成什么模型 ID，以及选择哪个区域；
4. 某些 beta、工具能力、遥测和请求关联字段是否可以发送。

提前判断 provider，才能选择匹配的凭证、客户端和 beta 参数位置。四种路径都暴露 `messages.create()` 外观，底层认证与 HTTP 路由各自独立。

### `getAPIProvider()` 只根据环境开关选路

选择函数位于 `restored-src/src/utils/model/providers.ts::getAPIProvider`：

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

`APIProvider` 是封闭联合类型：`'firstParty' | 'bedrock' | 'vertex' | 'foundry'`。三个环境变量通过 `isEnvTruthy()` 解释布尔语义；源码支持布尔真值，以及忽略大小写和首尾空白后为 `1`、`true`、`yes`、`on` 的字符串。三个开关均未生效时回退到 `firstParty`。

这里采用静态优先级 **Bedrock → Vertex → Foundry → firstParty**，客户端不会逐个探测网络可用性。多个开关同时打开时，函数直接返回第一个命中的 provider；正常配置应让这些开关互斥。

### 四种 provider 到底差在哪里

| provider | 客户端 | 认证与部署信息 | 请求侧的特殊点 |
| --- | --- | --- | --- |
| `firstParty` | `Anthropic` | 非订阅路径使用 API key；Claude.ai 订阅路径使用 OAuth token | 官方 API 的模型 ID、第一方能力与第一方遥测路径 |
| `bedrock` | `AnthropicBedrock` | AWS Bearer token，或 AWS access key、secret key、session token；还要确定 AWS region | 模型可能需要 inference profile；部分 beta 参数放进 `extraBodyParams` |
| `vertex` | `AnthropicVertex` | GCP `GoogleAuth` / ADC、项目和 region | region 会根据模型和环境配置选择，认证刷新走 GCP 路径 |
| `foundry` | `AnthropicFoundry` | Foundry API key，或 Azure AD `DefaultAzureCredential` | 传入的可能是 deployment ID，不能假定一定是第一方 `claude-*` 模型名 |

这张表对应的是 `restored-src/src/services/api/client.ts::getAnthropicClient` 的分支。它先准备公共 headers、代理 fetch 和 timeout，再按 provider 动态加载 `AnthropicBedrock`、`AnthropicFoundry` 或 `AnthropicVertex`；三个第三方分支均未命中时构造标准 `Anthropic`。四个对象最后都按统一 client 类型交给 `queryModel`；类型转换只统一调用接口，第三方 client 的能力仍由各 SDK 和平台约束。

这里还藏着一个配置边界：`getAPIProvider()` 的优先级是 Bedrock、Vertex、Foundry，而 `getAnthropicClient()` 的环境分支顺序是 Bedrock、Foundry、Vertex。若多个开关同时为真，provider 标签可能和真正构造的 client 不一致；源码的首项命中逻辑也不会把它解释成“同时启用多个后端”。

### provider 会继续影响请求内容

选好 client 以后，主循环仍然复用同一个 `queryModel`，但请求参数会根据 provider 做局部调整。例如工具搜索的 beta header 在第一方/Foundry 与 Vertex/Bedrock 上使用不同值；Bedrock 还要求把 header 放进 `extraBodyParams`，第一方等路径则使用普通 `betas` 数组。Bedrock 的 inference profile、Vertex 的 region、Foundry 的 deployment ID 都由各自平台配置提供。

请求关联 ID 只在 `getAPIProvider() === 'firstParty'` 且 `isFirstPartyAnthropicBaseUrl()` 返回真时生成，并作为 header 发送；第三方 provider 使用各自的日志关联机制。Analytics、账户信息、远程 settings 和模型能力缓存等模块也会读取 provider，决定是否启用对应的第一方逻辑。

最后要分清两个概念：`getAPIProvider()` 判断配置选择了哪种接入模式；`isFirstPartyAnthropicBaseUrl()` 判断 `ANTHROPIC_BASE_URL` 是否指向 Anthropic 官方 host。前者默认返回 `firstParty`，后者在 base URL 省略时返回真；Claude Code 需要同时满足两项，才进入完整的第一方路径。下一篇的问题会专门追踪后一个判断。

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

`messages.create()` 的第一个参数展开 `params` 并强制加入 `stream: true`；第二个参数的 `signal` 传播取消，`headers` 只在生成 `clientRequestId` 时出现，其中动态键 `CLIENT_REQUEST_ID_HEADER` 关联客户端请求。`.withResponse()` 同时保留 `result.data` 流、`result.response` HTTP 响应与 `result.request_id` 服务端标识。`clientRequestId` 只在 first-party 且 base URL 满足条件时生成；第三方 provider 跳过该 header。

源码注释说明这里刻意使用 raw stream。SDK 的 `BetaMessageStream` 会在每个 `input_json_delta` 到来时反复做 partial JSON 解析；Claude Code 自己累积工具参数，因此直接消费原始事件可以避免重复工作。

需要区分两个名字。导出的 `queryModelWithStreaming()` 是主循环使用的流式接口；`queryModelWithoutStreaming()` 虽然名字像另一条 HTTP 路径，实际上仍会完整消费 `queryModel()` 的生成器，只是最终只返回最后一个 `AssistantMessage`。真正的非流式 HTTP 请求位于 `executeNonStreamingRequest()`，它主要用于流式失败后的恢复，并调用 `messages.create()` 时不设置 `stream: true`。

## 传输边界：三层数据采用三种分块规则

到这里还缺一层容易混淆的边界：`queryModel` 看到的 `part` 已经是 Anthropic SDK 解码后的事件。如果从 `claude --input-format stream-json --output-format stream-json` 或 Agent SDK 的 stdio 入口观察，外面还有一层 NDJSON 协议。这里至少存在三种不同粒度：Node 异步流收到的 data block、以换行结束的协议消息，以及模型 API 的 `RawMessageStreamEvent`。它们的边界不能互相替代。

### 输入按换行恢复消息

`main.tsx::getInputPrompt` 在 `inputFormat === 'stream-json'` 时直接返回 `process.stdin`。因此，Node `data` 事件给出的字符串只是暂存材料，大小取决于管道和运行时调度；它可能半条消息，也可能一次包含多条消息。真正的拆分发生在 `StructuredIO.read()`：

```ts
let content = ''

for await (const block of this.input) {
  content += block
  while (content.indexOf('\n') !== -1) {
    const newline = content.indexOf('\n')
    const line = content.slice(0, newline)
    content = content.slice(newline + 1)
    const message = await this.processLine(line)
    if (message) yield message
  }
}

if (content) {
  const message = await this.processLine(content)
  if (message) yield message
}
```

上面是 `restored-src/src/cli/structuredIO.ts::read` 的主干，循环里的前置 user message、诊断和关闭 pending request 分支已省略。由此可以确定：**输入的逻辑分块边界是换行符 `\n`；字节数、字符数和 token 数不参与记录切分。** 一个 Node block 可以产出多条消息；一条 JSON 消息也可以跨越多个 block。输入结束时，末尾残余内容即使缺少换行也会作为一条记录处理；空行则在 `processLine` 中跳过。

每行解析后还要经过 `processLine` 的类型分支。`StdinMessageSchema` 接受 user message、control request、control response、keep-alive 和环境变量更新；所以 `stream-json` 的 stdin 是宿主事件协议，不能把它等同于“把用户 prompt 切成若干段”。

### 输出按完整 JSON 行发送

输出侧使用相反的配对操作。`StructuredIO.write()` 把一个完整的 `StdoutMessage` 序列化后追加换行：

```ts
async write(message: StdoutMessage): Promise<void> {
  writeToStdout(ndjsonSafeStringify(message) + '\n')
}
```

`runHeadless()` 在 `stream-json` 且 `verbose` 时，对 `runHeadlessStreaming()` 产出的每个消息调用一次 `structuredIO.write()`。因此 stdout 的协议单位是一行完整 JSON；这一行可能是 `assistant`、`result`、`system`、`stream_event` 或控制消息，并不意味着每行都是一段文本。最终的 `result` 不会在循环结束时再次重复输出。

`streamJsonStdoutGuard` 还会把底层任意的 `process.stdout.write()` 调用重新缓存到换行，再用 `JSON.parse` 判断这一行是否完整。合法 JSON 继续留在 stdout；其他输出被转到 stderr。它保护的是 NDJSON 的协议边界，不能把它理解成对模型内容重新分块。

### 模型事件与外层协议消息

模型层的分块标准由 API 事件类型和内容块 `index` 决定。`queryModel` 调用 `messages.create({ stream: true })` 后，`for await (const part of stream)` 每次拿到一个语义事件；`content_block_delta` 里的 `text_delta`、`thinking_delta` 和 `input_json_delta` 分别追加到对应内容块。这里的 `input_json_delta.partial_json` 属于模型正在生成的 `tool_use` 输入，stdin 用户输入则由上一层 NDJSON 解析。

Query Engine 只有在 `includePartialMessages` 为真时，才把这些原始 API 事件包装成外部 `stream_event`；默认值为假时，外部仍会收到完整的 assistant、system 和 result 等消息，但不会收到每个原始 delta。也就是说，外层一行 JSON 只是承载协议消息，消息内部是否携带 API 增量还受这个选项控制。

### 远程 transport 还会再次聚合

如果输出经过 CCR 的远程事件上传器，`stream_event` 会先进入最多 100ms 的延迟缓冲。`accumulateStreamEvents()` 会按会话作用域、API message ID 和 content block `index` 维护文本；同一个块在一个 flush 窗口内只生成一个 full-so-far 快照，非文本 delta 则原样传递。普通事件到来时会先 flush 这批流事件，以保持顺序。

这一步只定义远程投递策略。CCR 后面的 HTTP uploader 还会按最多 100 条、累计 10MB 的规则切 POST batch；这些数量和 100ms 窗口约束远程 transport，与 `stream-json` 格式和 API delta 大小分属不同层级。

因此，本章说“chunk”时要先说明层次：Node data block 的边界由底层读取时机决定；stdio `stream-json` 按 `\n` 分消息；Anthropic stream 按 API 事件和 content block index 分块；CCR 再按时间窗口、消息聚合和 HTTP batch 做一次传输层切分。

## 第五站：事件怎样驱动组装状态机

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

`part` 是 `BetaRawMessageStreamEvent`。`message_start` 初始化消息元数据，并读取可能已经出现的 usage；`content_block_start` 用 `part.index` 创建槽位；后续 delta 必须通过同一个 `index` 找到它。若 delta 或 stop 找不到对应块，源码会记录 `tengu_streaming_error` 并抛错，当前流随即进入错误恢复。

`content_block_start` 会按块类型选择初值：`tool_use` 和 `server_tool_use` 的 `input` 先设为空字符串，`text` 的 `text` 先设为空字符串，`thinking` 的 `thinking` 与 `signature` 也从空字符串开始。文本 start 事件里即使带了内容，这里也不直接采用，因为源码注释记录了 SDK 可能在随后 delta 中再次给出相同文本；选择只累积 delta，是为了避免重复。

### delta 怎样落到正确字段

`content_block_delta` 按具体 delta 类型更新不同字段，核心分支可以缩成下面这样：

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

这段分支位于 `queryModel()` 的 `content_block_delta` case。`input_json_delta` 只允许落到 `tool_use` 或 `server_tool_use`，并要求当前 `input` 仍是字符串；`text_delta` 只允许落到 `text`；`signature_delta` 通常落到 `thinking`，特性开启时也可用于 `connector_text`；`thinking_delta` 只允许落到 `thinking`。源码还看得到 `citations_delta`（当前分支保持待处理状态）以及受功能开关控制的 `connector_text_delta`。这些类型检查会把事件顺序错误转成显式异常，保护下游消息结构。

工具参数先拼字符串，因为任意一个 `partial_json` 都可能只是一段 `{"file_`；内容块结束后才能解析完整字符串。`restored-src/src/utils/messages.ts::normalizeContentFromAPI` 会用 `safeParseJSON` 解析完整工具输入：空字符串或解析失败会回退到 `{}`，随后再调用对应工具的 `normalizeToolInput`；若非流式 fallback 已经给出对象，则直接保留对象路径。

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

这段代码位于 `content_block_stop` 分支。`partialMessage` 必须已由 `message_start` 建立，`contentBlock` 也必须能按 `part.index` 找到，否则抛错。返回对象的 `message` 继承响应外壳，并由 `normalizeContentFromAPI(content, tools, agentId?)` 把工具输入字符串转成对象、执行工具级修正；`agentId` 省略时跳过 Agent 专属处理。`requestId` 使用可选服务端请求标识，`type: 'assistant'` 选择内部消息分支，`uuid` 生成本地块标识，`timestamp` 记录块完成时间。

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

`updateUsage(current, partUsage)` 的第二个参数允许为 `undefined`；此时返回当前 usage 的副本。对 input/cache token 字段，新的正数才覆盖旧值；`output_tokens` 等字段使用 `??` 回退。函数会把分散在事件里的最新可用字段合成一份 `NonNullableUsage`，并对不同 token 字段采用覆盖或回退规则。

`stopReason` 的静态类型是 `BetaStopReason | null`。本文不能脱离 SDK 类型穷举所有字符串，但本函数明确处理了 `max_tokens` 和 `model_context_window_exceeded`，也把停止原因交给 refusal 映射逻辑；普通完成或工具调用的具体值由 API 事件给出。更重要的是，Query Loop 不把 `stop_reason === 'tool_use'` 当唯一依据，因为源码注释明确说这个值并不始终可靠。

这里直接修改属性，以配合 transcript 写队列持有原对象引用并延迟序列化的行为；原地回填能让已经排队的对象最终带上 usage 和 stop reason。这是一个很典型的工程细节：消息已经向上游 yield 时，元数据仍可能继续更新。

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

这段代码位于 `restored-src/src/query.ts::queryLoop` 的模型流消费循环。`message.type` 必须是 `'assistant'` 才进入；内容块按 `type === 'tool_use'` 过滤；只要至少一个工具块出现，`needsFollowUp` 就设为 `true`。因此完整 `tool_use` 块直接驱动 Agent 继续，stop reason 只提供响应级停止语义。

如果启用了 streaming tool execution，完整工具块一到达还会交给 `StreamingToolExecutor.addTool()`；否则流结束后由常规 `runTools()` 统一执行。两条路径都发生在 `content_block_stop` 之后，所以此时工具输入已经经过累积与规范化。至于如何按名称找到工具、如何用 Schema 验证输入，是下一篇的主题。

`tool_use` 集合为空时，`needsFollowUp` 保持 `false`，Query Loop 进入停止 hook、预算或正常完成路径；存在 `tool_use` 时，它等待工具结果，把 `tool_result` 追加到消息历史，再开始下一次模型请求。网络流在这里重新接回 Agent 循环。

## 第七站：错误、重试和取消走不同出口

流式请求的失败分为流建立前和已经收到部分事件之后两个阶段，Claude Code 为它们选择不同的恢复路径。

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

控制这个分支的值包括环境变量 `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` 和功能开关；任一为真都禁止降级。流建立阶段返回 404 还有单独的非流式 fallback。另一方面，如果流正常结束却从未收到 `message_start`，或收到 start 但完整内容块与 stop reason 均为空，源码同样把它视为不完整流并触发恢复；空回答必须经过完整事件条件才能成立。

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

`cleanupStream(stream)` 接受 SDK `Stream` 或 `undefined`；`undefined` 直接走 no-op 返回，已有 stream 且 controller 尚未 abort 时执行取消，已关闭或关闭过程中抛错则吞掉异常。`queryModel` 的 `releaseStreamResources()` 还会取消 `Response.body` 并清空引用，而且它放在 `finally` 中：即使上层对异步生成器提前 `.return()`，底层 TLS/socket 相关资源也会被释放。

用户取消与网络错误的上层语义也不同。`APIUserAbortError` 不会被转换成 assistant API error；`queryLoop` 检测到同一个 `AbortSignal` 后，补齐必要的中断消息或缺失的 `tool_result`，再以 `aborted_streaming` 等终态返回。其他不可恢复错误则会映射为内部错误消息，让 UI、headless 或 SDK 有统一对象可以消费。

## 流关闭之后，哪些结论才算成立

到 `message_stop` 并离开事件循环，只能说明这一条响应流结束。Claude Code 还要确认它确实见过 `message_start`，并且至少形成了内容块，或者拿到了合法 stop reason；随后记录 usage、cost、request id、缓存命中相关字段和诊断信息。是否继续 Query Loop，则由已经形成的 `tool_use`、停止 hook、预算、取消状态和恢复分支共同决定。

因此，流结束后还要继续判断 Agent 状态：

- `message_stop` 是单次 API response 的边界；
- `content_block_stop` 是一个内部 assistant 内容块可交付的边界；
- 工具列表为空且通过停止检查，才可能结束当前 Agent turn；
- 有 `tool_use` 时，工具结果会进入历史，下一次 API 请求重新开始。

源码里的 30 秒 stall 记录阈值、默认 90 秒 idle timeout 等常量只描述 2.1.88 的默认与可配置逻辑；生产性能需要真实运行数据验证。

## 小结

Claude Code 的 API 层做的事情，可以概括为一句话：**把不完整、可能失败、可以取消的网络事件，变成 Query Loop 能安全消费的完整内容块。**

它先归一化消息、系统提示词与工具 Schema，再按 provider 构造 Anthropic 客户端；请求以 raw stream 发出，`message_start` 建消息壳，`content_block_start/delta/stop` 组装文本、thinking 和工具参数，`message_delta` 回填 usage 与 stop reason。完整 `tool_use` 回到 Query Loop 后，才真正触发下一阶段的工具执行。

异常路径同样属于协议的一部分：可重试错误进入 `withRetry`，不完整流可以降级为非流式请求，用户取消沿 `AbortSignal` 传播，`finally` 负责关闭 stream 与 response。这样，REPL、print 模式和 SDK 可以共享同一执行内核，却各自决定是否展示原始增量。

## 留给下一篇的问题

你知道 Beta 开关打开的时候有什么新功能吗？

## 参考资料

- [Using Claude Code: session management and 1M context](https://claude.com/blog/using-claude-code-session-management-and-1m-context)
- [Advanced Claude Code 实践手册](https://media.licdn.com/dms/document/media/v2/D4E1FAQE9GrR1bPPyNQ/feedshare-document-pdf-analyzed/B4EZp.4We2KMAY-/0/1763065294861?e=1770854400&t=D8gaypHX1jhHDgxTXFEdEHVG9M64ImehhCdzEL1lZ4&v=beta)
- [Messages API 流式传输](https://docs.anthropic.com/en/api/messages-streaming)

- [Claude Code 模型配置](https://code.claude.com/docs/en/model-config)
