---
title: "Claude Code源码解读49：从 Web Search 到最后一个字"
published: 2026-08-25T20:30:00+08:00
updated: 2026-08-25
description: "沿着 Claude Code、NewAPI、SGLang 和 DeepSeek V4 Flash 的源码，追踪一次 Web Search 请求如何变成用户看到的最后一个字。"
tags: ["claude-code", "source-code", "ai-agent", "sglang", "deepseek"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-48/series-roadmap.png"
imagePosition: "left"
---

## 问题现场

如果你在 Claude Code 里输入：

```text
请帮我通过 Web Search 搜索 Claude Code 的当前最新版本、发布时间和官方更新内容，优先使用 Anthropic 和 Claude Code 的官方页面。
```

你看到的通常是一段文字，最后停在某个汉字、标点或英文字符上。这个过程看起来像一次聊天，源码里却至少经过了四条边界：用户输入进入 Agent Loop，模型决定是否调用搜索，搜索结果重新进入下一轮上下文，推理框架再把 token 解码成增量文本，最后由终端把增量拼到屏幕上。

那么，最后一个字到底在哪里产生？

答案先放在前面：**在本文的本地模型假设里，最后一个可见字符是 DeepSeek V4 Flash 生成的 token 经 SGLang 的 detokenizer 还原成文本后，沿着 SSE 和宿主渲染链路逐段抵达用户的结果。** 但在默认的 Claude Code 2.1.88 源码里，模型协议仍是 Anthropic Messages API。NewAPI 可以承担统一网关和协议转发的边界；具体能否直接接收 Claude Code 的请求，取决于所选接口和上游适配配置。

这条边界不先说清楚，后面所有“Claude Code 直接连本地 DeepSeek”的调用链都会少一层。

## 先看 Claude Code 这一侧：一次输入怎样变成搜索动作

本地源码快照来自 [claude-code-sourcemap](https://github.com/TaurusGGBOY/claude-code-sourcemap) 的 `@anthropic-ai/claude-code@2.1.88` 还原目录。这里先看真实存在的调用关系，再把本地模型假设接到它的模型边界上。

### 1. `queryLoop` 负责把一轮任务拆成多次模型请求

`src/query.ts` 中的 `query()` 只是把 `queryLoop()` 的结果向外转发。真正的循环在 `queryLoop()`：它保存 `messages`、`toolUseContext`、压缩状态和继续原因，然后调用 `deps.callModel()`。

调用参数里不只有对话历史，还有 `systemPrompt`、`tools`、当前模型、权限上下文、MCP 工具和取消信号：

```ts
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    model: currentModel,
    mcpTools: appState.mcp.tools,
    querySource,
    addNotification: toolUseContext.addNotification,
  },
})) {
  // 消费模型流、保存 assistant 消息、发现 tool_use
}
```

模型返回一个 `tool_use`，循环不会立刻结束。`queryLoop()` 把它加入 `toolUseBlocks`，启动工具执行器，得到 `tool_result` 后再把结果拼进下一次 API 请求。于是用户的一次任务可能是：

```text
user prompt
  -> model request
  -> web_search tool_use
  -> search result / tool_result
  -> model request with search result
  -> final text
```

这也是为什么“搜索一下”不能被理解成一个函数调用。它至少包含一次决定、一次副作用和一次带结果的后续推理。

### 2. Web Search 在源码里是一次嵌套的流

`WebSearchTool.ts` 自己又调用 `queryModelWithStreaming()`，给这次模型请求附加一个 `web_search_20250305` 工具，并把 `max_uses` 限制为 8。它消费流中的 `server_tool_use` 和 `web_search_tool_result`，从 `input_json_delta` 里逐步拼出查询词，再把结果整理成工具输出。

这里有一个容易误判的地方：搜索词不是等整个 JSON 完整到达后才出现。源码会尝试从局部 JSON 中匹配 `"query"`，一旦得到新的查询词，就发出进度事件。真正的搜索结果则在 `web_search_tool_result` 的 `content` 到达时被收集。

因此，这一段的状态更接近：

```text
server_tool_use(start)
  -> input_json_delta("{\"query\":\"Claude Code latest...")
  -> input_json_delta("\"}\n")
  -> web_search_tool_result
  -> tool_result
```

搜索结果回到主循环后，主模型才有机会把网页内容合成最终回答。搜索动作和最后答案之间，至少隔着一次工具结果回填。

## 把本地模型接进来：NewAPI 是网关与协议边界

下面进入本地模型假设：NewAPI 负责统一入口和上游路由，SGLang 提供本地模型服务。

[NewAPI 官方文档](https://github.com/QuantumNous/new-api-docs/blob/main/docs/en/api/index.md)把它定义为支持多种主流模型接口格式的中继网关，其中包括 OpenAI Chat 和 Anthropic Chat。它处理的是请求格式、渠道选择、鉴权、重试和流式响应转发；模型本身仍在上游服务中执行。

因此，NewAPI 放在 Claude Code 与 SGLang 之间时，职责可以拆成三层：

1. 对外提供 Claude Code 或兼容客户端能够调用的 API 接口。
2. 根据模型、渠道和配置选择上游，把请求转换成目标服务能够理解的格式。
3. 将上游的流式结果转发给客户端，必要时处理工具调用、usage 和结束信号。

假设链路可以画成：

```text
Claude Code queryLoop
        │ Anthropic Messages 或兼容接口
        ▼
NewAPI
        │ channel routing + protocol relay
        ▼
SGLang OpenAI-compatible server
        │
        ▼
DeepSeek V4 Flash
```

这里有两个边界要分开。NewAPI 的网关能力不等于 Web Search 能力；纯 Web Search 仍然要由 Claude Code 的搜索工具、模型服务的工具能力或外部搜索适配器提供。NewAPI 只负责把请求和结果在协议边界之间传递。

另一个边界是格式转换。Claude Code 2.1.88 的 `queryModelWithStreaming()` 按 Anthropic 的 `message_start`、`content_block_start`、`content_block_delta`、`message_delta` 和 `message_stop` 组装消息。SGLang 的 OpenAI 接口则返回 `choices[].delta.content` 一类的流式片段。NewAPI 可以提供 Anthropic 或 OpenAI 形式的接口，但实际部署仍要确认入口、渠道配置和工具调用字段是否覆盖当前请求。

如果中间采用 OpenAI 兼容链路，适配器至少要把：

```text
OpenAI chunk: choices[0].delta.content = "Claude"
        ↓
Anthropic event: content_block_delta / text_delta / text = "Claude"
```

并且还要转换 `finish_reason`、tool call、usage、错误和取消语义。只把 URL 改成 `http://localhost:xxxx/v1`，不能让 Claude Code 自动理解另一套事件格式。

## SGLang：请求怎样走到 DeepSeek V4 Flash 的 decode

以 [SGLang 的 OpenAI serving 实现](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/entrypoints/openai/serving_chat.py) 为入口，`ChatCompletionRequest` 会被转换成内部的 `GenerateReqInput`。`TokenizerManager.generate_request()` 负责规范化请求、建立 request state、分词并把请求发给 scheduler；这条路径还会记录 `rid`，以便后续把模型输出送回正确的 HTTP 请求。

在模型执行侧，DeepSeek V4 的模型实现位于 [`deepseek_v4.py`](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/models/deepseek_v4.py)。这里的 `forward` 不负责把最终字符串发给用户，它只参与一次或一批请求的神经网络前向计算。模型执行与采样链路在每个 decode step 产出 token id，scheduler 把它们作为 `BatchTokenIDOutput` 交给 detokenizer。

这一步要拆开看：

```text
prompt text
  -> tokenizer.encode -> input_ids
  -> prefill -> KV cache
  -> decode step
  -> next token id
  -> BatchTokenIDOutput
  -> DetokenizerManager
  -> incremental text
```

SGLang 的 [`DetokenizerManager`](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/managers/detokenizer_manager.py) 是“最后一个字”真正出现的地方之一。它的事件循环接收 scheduler 的批量 token id 输出，`handle_batch_token_id_out()` 调用 `_decode_batch_token_id_output()`，保存每个 request 的 `decode_ids`、`read_offset` 和 `sent_offset`。

它不会简单地对每个 token 独立调用 `decode()` 然后立刻发送。UTF-8 字节可能跨 token，源码会用 `find_printable_text()` 找到当前可打印前缀；遇到不完整字符时只发送已经完整的前缀，把未提交的 token 留给下一次 decode。完整文本被追加到 request 状态后，`output_strs` 只返回尚未发送的增量。

因此，模型吐出的最后一个 token 和用户看到的最后一个字不是严格的一一对应：

- 一个 token 可能解码成多个字符；
- 一个字符可能需要多个 token 才能形成完整 UTF-8 字节序列；
- 最后一个 token 产生后，还要经过 stop 字符串裁剪、增量偏移计算和 SSE 序列化。

SGLang 的 `serving_chat.py` 再把 `content["text"]` 与上一次的 `stream_offset` 比较，只生成新增部分，包装成 OpenAI 风格的流式响应。`incremental_streaming_output` 开启时，新增文本直接作为本次 delta；关闭时则从累计文本中切出尚未发送的尾部。

## 从 token 回到终端：最后一段调用链

把上述几层接起来，一次请求的完整时序是：

```text
1. 用户在 Claude Code 输入“请帮我搜索……”。
2. QueryEngine / queryLoop 将用户消息与 system prompt、tools 交给模型适配器。
3. 模型输出搜索 tool call；Claude Code 执行搜索，得到 tool_result。
4. queryLoop 把 tool_result 放回 messages，再发起最终回答请求。
5. NewAPI 按部署配置处理 Anthropic 或 OpenAI 兼容请求，并选择本地 SGLang 渠道。
6. NewAPI 将请求转发到 SGLang，并保持 SSE 连接。
7. SGLang tokenizer manager 分词并把请求送入 scheduler。
8. DeepSeek V4 Flash 做 prefill 和多次 decode，每次产生 token id。
9. DetokenizerManager 增量解码，检查 UTF-8 完整性，输出新增文本。
10. SGLang `serving_chat.py` 发送 `choices[].delta.content`。
11. NewAPI 转发 chunk；必要的协议适配器把它变成 Anthropic `text_delta`。
12. Claude Code 的 `handleMessageFromStream()` 执行 `onStreamingText(text => text + deltaText)`。
13. REPL 的 `onStreamingText` 更新 React state，终端重新渲染。
```

第 12 步在本地源码里很具体。`src/utils/messages.ts` 的 `handleMessageFromStream()` 收到 `content_block_delta` 且 delta 类型为 `text_delta` 时，把文本交给 `onStreamingText`；`src/screens/REPL.tsx` 传入的回调再把它追加到当前的 streaming text。收到完整 assistant message 后，源码先清空 streaming text，再把最终消息放进 `messages`，避免屏幕上出现一份流式文本和一份最终文本。

这也是“最后一个字”稳定显示的原因：屏幕并不等待整段答案完成才更新，而是把每次可打印增量追加到 state；最后一个增量到达后，`message_delta`/`message_stop` 完成收尾，最终 assistant message 接管展示。

## 两个容易被混淆的完成信号

**DeepSeek V4 Flash 的停止**和**Claude Code 这一轮任务的停止**不是同一件事。

SGLang 可以因为 EOS、stop 字符串或长度限制结束一次生成，并在 OpenAI chunk 里给出 `finish_reason`。这只说明模型这一段文本不再继续生成。

Claude Code 收到最后文本后，还要检查是否存在 `tool_use`。如果有工具调用，`queryLoop()` 会继续下一轮；只有没有待执行工具，且 stop hook、压缩和其他继续条件都结束后，这个 Agent turn 才真正收尾。模型停止生成不代表 Agent 任务已经停止。

反过来，如果协议适配器把 `finish_reason` 映射错，或者漏掉了最终的 `message_stop`，用户可能看到文字已经停住，但 Claude Code 仍然认为流没有完成；如果把工具调用错误映射成普通文本，Agent 则会把“应该执行的动作”当成回答显示出来。

## 最后的工程结论

沿着源码追踪一次 Web Search，真正需要核对的是五个坐标：

1. **请求在哪一层被改写。** Claude Code 的 `queryLoop` 组装上下文，NewAPI 负责网关路由与协议转发，SGLang 再把文本变成 token id。
2. **工具结果在哪里回填。** `WebSearchTool` 的结果要回到下一次模型请求，不能把搜索进度当成最终答案。
3. **协议在哪里转换。** Anthropic stream event 与 OpenAI SSE delta 不是同一种结构，适配器是必需的边界。
4. **token 在哪里变成文本。** DeepSeek V4 Flash 只产生 token id；SGLang 的 detokenizer 负责 UTF-8 安全的增量文本。
5. **最后的字在哪里落到屏幕。** Claude Code 的 `handleMessageFromStream()` 和 REPL state 把 `text_delta` 追加到终端视图。

如果你要复现这条链路，最有价值的日志不是只打印最终答案，而是同时记录：请求 `rid`、模型返回的 tool call、一次搜索的 tool result、协议适配前后的 chunk、SGLang 的 token id 与 detokenized delta，以及 Claude Code 最后一次 `text_delta`。这样才能判断“字没有出现”究竟发生在模型没生成、detokenizer 没提交、SSE 没转发，还是终端 state 没更新。

本文的源码事实分别来自 Claude Code 2.1.88 还原源码、NewAPI 官方接口文档和 SGLang 当前 `main` 源码；NewAPI → SGLang → DeepSeek V4 Flash 接入 Claude Code 的部分是部署假设，能否直接复用 Anthropic 接口取决于 NewAPI 的入口与渠道配置。DeepSeek V4 Flash 的模型文件、SGLang 分支和硬件后端会继续变化，复现时应以部署 commit、启动参数和 tokenizer 版本为准。

## 留给下一篇的问题

如果协议适配器已经把 token 流正确转成了 `text_delta`，那么工具调用的 `input_json_delta` 应该怎样转换，才能让 Claude Code 继续执行本地工具，而不是把 JSON 当作普通文字显示？

## 资料与代码索引

- [Claude Code `query.ts`](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/main/restored-src/src/query.ts)：`queryLoop`、模型请求、tool use 与 tool result 回填。
- [Claude Code `claude.ts`](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/main/restored-src/src/services/api/claude.ts)：Anthropic stream event 的累积与 assistant message 组装。
- [NewAPI API Overview](https://github.com/QuantumNous/new-api-docs/blob/main/docs/en/api/index.md)：OpenAI Chat、Anthropic Chat 等中继接口格式。
- [NewAPI Project Introduction](https://github.com/QuantumNous/new-api-docs-v1/blob/main/content/docs/en/guide/wiki/basic-concepts/project-introduction.mdx)：统一入口、渠道路由和网关职责。
- [SGLang `serving_chat.py`](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/entrypoints/openai/serving_chat.py)：OpenAI 请求与 SSE 输出。
- [SGLang `tokenizer_manager.py`](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/managers/tokenizer_manager.py)：请求规范化、分词与 scheduler 派发。
- [SGLang `detokenizer_manager.py`](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/managers/detokenizer_manager.py)：`BatchTokenIDOutput` 到增量文本。
- [SGLang `deepseek_v4.py`](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/models/deepseek_v4.py)：DeepSeek V4 模型执行入口。
