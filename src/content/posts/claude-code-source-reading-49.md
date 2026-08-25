---
title: "Claude Code源码解读49：从搜索 Release Note 到最后一个字"
published: 2026-08-25T20:30:00+08:00
updated: 2026-08-25
description: "沿着 Claude Code、Open WebUI、SGLang 和 DeepSeek V4 Flash 的源码，追踪一次搜索请求如何变成用户看到的最后一个字。"
tags: ["claude-code", "source-code", "ai-agent", "sglang", "deepseek"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-48/series-roadmap.png"
imagePosition: "left"
---

## 问题现场

如果你在 Claude Code 里输入：

```text
请帮我搜索一下 Claude Code 的最新版本的 release note
```

你看到的通常是一段文字，最后停在某个汉字、标点或英文字符上。这个过程看起来像一次聊天，源码里却至少经过了四条边界：用户输入进入 Agent Loop，模型决定是否调用搜索，搜索结果重新进入下一轮上下文，推理框架再把 token 解码成增量文本，最后由终端把增量拼到屏幕上。

那么，最后一个字到底在哪里产生？

答案先放在前面：**在本文的本地模型假设里，最后一个可见字符不是 Claude Code 生成的，也不是 Open WebUI “显示出来”的；它是 DeepSeek V4 Flash 生成的 token 经 SGLang 的 detokenizer 还原成文本后，沿着 SSE 和宿主渲染链路逐段抵达用户的结果。** 但在默认的 Claude Code 2.1.88 源码里，模型协议仍是 Anthropic Messages API。要把本地 Open WebUI 和 SGLang 接进来，还需要一个把 OpenAI 兼容流转换成 Claude Code 能消费的事件流的适配层。

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

搜索结果回到主循环后，主模型才有机会把“最新版本”与 release note 内容合在一起。搜索动作和最后答案之间，至少隔着一次工具结果回填。

## `/release-notes` 和“搜索最新版本”不是同一条路径

在 2.1.88 源码中，`src/commands/release-notes/release-notes.ts` 实现的是本地命令 `/release-notes`。它会尝试在 500 毫秒内抓取 `CHANGELOG.md`，超时就使用缓存；没有可用内容时只返回 GitHub changelog 链接。

数据源在 `src/utils/releaseNotes.ts`：

```ts
const RAW_CHANGELOG_URL =
  'https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md'
```

它先把 changelog 按 `## version` 切段，再取每段的 `- ` 行。`getRecentReleaseNotes()` 会按 semver 排序，并最多返回 5 条；`getAllReleaseNotes()` 则把所有版本按从旧到新的顺序整理成 `Version x.y.z:` 文本。

这解释了一个实际差异：

- `/release-notes` 是客户端的本地命令，数据来自缓存或 GitHub `main` 分支的 `CHANGELOG.md`。
- “请帮我搜索最新版本”是 Agent 任务，模型可能调用 Web Search，再读取 release 页面、changelog 或其他页面。

截至 2026-08-25，我核对到的 [Claude Code GitHub `releases/latest`](https://github.com/anthropics/claude-code/releases/latest) 是 `v2.1.241`，发布日期是 2026-08-23，正文只有 “Bug fixes and reliability improvements”。同一时间 [main 分支的 `CHANGELOG.md`](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) 顶部已经出现 `2.1.245` 和 `2.1.243` 条目。前者是已发布 release，后者是主分支 changelog 内容，不能混写成“最新已发布版本”。

从代码可以推断，老版本客户端的 `/release-notes` 可能看到比 GitHub Releases 页面更新的 changelog 条目，因为它读的是 `main` 分支；这不是版本比较算法出错，而是“release 页面”和“main changelog”本来就是两条数据源。

## 把本地模型接进来：Open WebUI 是协议边界

下面进入用户给出的假设：Open WebUI 连接本地模型，模型由 SGLang 提供服务。

这里把“one-webui”按 [Open WebUI](https://github.com/open-webui/open-webui) 理解。项目官方文档把 `/v1/chat/completions` 作为核心兼容入口，支持 `stream`、标准参数和工具调用；它并不要求后端一定是某一家模型厂商，只要求后端遵守 OpenAI 兼容协议。

这层的职责不是重新生成 token，而是做三件事：

1. 接收前端或上游客户端的消息数组、模型名、工具和 `stream` 参数。
2. 根据配置把请求转发到本地 OpenAI 兼容后端。
3. 将上游的流式 chunk 作为 SSE 返回，并在需要时维护聊天记录、工具状态和 UI 的 assistant 草稿。

所以假设链路可以画成：

```text
Claude Code / 协议适配器
        │ OpenAI-compatible POST /v1/chat/completions
        ▼
Open WebUI
        │ provider routing + SSE proxy
        ▼
SGLang HTTP server
```

但这里不能把 Open WebUI 当成 Claude Code 的透明替身。Claude Code 2.1.88 的 `queryModelWithStreaming()` 最终进入 `src/services/api/claude.ts`，按 Anthropic 的 `message_start`、`content_block_start`、`content_block_delta`、`message_delta` 和 `message_stop` 组装消息。Open WebUI 与 SGLang 默认返回的是 OpenAI 风格的 `choices[].delta.content`。

如果没有适配器，协议在这里就断了。一个真正可运行的适配器至少要把：

```text
OpenAI chunk: choices[0].delta.content = "Claude"
        ↓
Anthropic event: content_block_delta / text_delta / text = "Claude"
```

并且还要转换 `finish_reason`、tool call、usage、错误和取消语义。只把 URL 改成 `http://localhost:xxxx/v1`，不能让 Claude Code 自动理解另一套事件格式。

## DeepSeek Harness：谁负责 Agent Loop，谁负责模型流

如果在 Claude Code 这一侧再换成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 这样的 Agent runtime，控制面会更容易对照。`packages/core/agent-loop/src/agent.ts` 的 `ReactLoopAgent` 把一次任务拆成 `turn` 和 `step`；每个 step 通过 `llm.prepareCall()` 固定模型配置，再消费 `llm/stream`。收到流式分片后，它把原始 chunk 写入 `assistant/chunk`，随后再形成 `assistant/message`。

这说明 Harness 和 SGLang 不是同一层：Harness 负责“什么时候请求模型、怎样保存分片、怎样继续工具调用”，SGLang 负责“怎样调度请求、执行前向计算、采样 token、解码并返回文本”。Harness 的 [`DeepSeekAdapter`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/src/adapter.ts) 还会处理流空闲 watchdog、取消和 `TRANSPORT`/`TIMEOUT` 错误，但它不会替代 SGLang 的 GPU decode。

放回本文的假设链路就是：

```text
Claude Code queryLoop 或 DeepSeek Harness ReactLoopAgent
        -> 协议适配器 / LLM adapter
        -> Open WebUI
        -> SGLang
        -> DeepSeek V4 Flash decode
```

这里的 `assistant/chunk` 与 Claude Code 的 `text_delta` 也不是同名字段的直接互换。前者是 Harness 的事件日志，后者是 Anthropic stream event；两者都表达增量，但持久化语义和传输协议不同。

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
5. 协议适配器把 Anthropic Messages 请求改成 OpenAI chat completion 请求。
6. Open WebUI 路由到本地 SGLang，并保持 SSE 连接。
7. SGLang tokenizer manager 分词并把请求送入 scheduler。
8. DeepSeek V4 Flash 做 prefill 和多次 decode，每次产生 token id。
9. DetokenizerManager 增量解码，检查 UTF-8 完整性，输出新增文本。
10. SGLang `serving_chat.py` 发送 `choices[].delta.content`。
11. Open WebUI 转发 chunk；协议适配器把它变成 Anthropic `text_delta`。
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

沿着源码追踪一次“搜索最新 release note”，真正需要核对的是五个坐标：

1. **请求在哪一层被改写。** Claude Code 的 `queryLoop` 组装上下文，Open WebUI 组装兼容请求，SGLang 再把文本变成 token id。
2. **工具结果在哪里回填。** `WebSearchTool` 的结果要回到下一次模型请求，不能把搜索进度当成最终答案。
3. **协议在哪里转换。** Anthropic stream event 与 OpenAI SSE delta 不是同一种结构，适配器是必需的边界。
4. **token 在哪里变成文本。** DeepSeek V4 Flash 只产生 token id；SGLang 的 detokenizer 负责 UTF-8 安全的增量文本。
5. **最后的字在哪里落到屏幕。** Claude Code 的 `handleMessageFromStream()` 和 REPL state 把 `text_delta` 追加到终端视图。

如果你要复现这条链路，最有价值的日志不是只打印最终答案，而是同时记录：请求 `rid`、模型返回的 tool call、一次搜索的 tool result、协议适配前后的 chunk、SGLang 的 token id 与 detokenized delta，以及 Claude Code 最后一次 `text_delta`。这样才能判断“字没有出现”究竟发生在模型没生成、detokenizer 没提交、SSE 没转发，还是终端 state 没更新。

本文的源码事实分别来自 Claude Code 2.1.88 还原源码、Open WebUI 官方兼容接口说明和 SGLang 当前 `main` 源码；Open WebUI → SGLang → DeepSeek V4 Flash 接入 Claude Code 的部分是部署假设，需要一个实际的协议适配器才能运行。DeepSeek V4 Flash 的模型文件、SGLang 分支和硬件后端会继续变化，复现时应以部署 commit、启动参数和 tokenizer 版本为准。

## 留给下一篇的问题

如果协议适配器已经把 token 流正确转成了 `text_delta`，那么工具调用的 `input_json_delta` 应该怎样转换，才能让 Claude Code 继续执行本地工具，而不是把 JSON 当作普通文字显示？

## 资料与代码索引

- [Claude Code `query.ts`](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/main/restored-src/src/query.ts)：`queryLoop`、模型请求、tool use 与 tool result 回填。
- [Claude Code `releaseNotes.ts`](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/main/restored-src/src/utils/releaseNotes.ts)：changelog 抓取、缓存、版本解析与最多 5 条摘要。
- [Claude Code `release-notes.ts`](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/main/restored-src/src/commands/release-notes/release-notes.ts)：500 毫秒抓取窗口与缓存回退。
- [Claude Code `claude.ts`](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/main/restored-src/src/services/api/claude.ts)：Anthropic stream event 的累积与 assistant message 组装。
- [Open WebUI OpenAI-compatible 文档](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/)：`/v1/chat/completions`、stream 和工具调用边界。
- [Open WebUI `openai.py`](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/routers/openai.py)：OpenAI 兼容路由源码。
- [SGLang `serving_chat.py`](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/entrypoints/openai/serving_chat.py)：OpenAI 请求与 SSE 输出。
- [SGLang `tokenizer_manager.py`](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/managers/tokenizer_manager.py)：请求规范化、分词与 scheduler 派发。
- [SGLang `detokenizer_manager.py`](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/managers/detokenizer_manager.py)：`BatchTokenIDOutput` 到增量文本。
- [SGLang `deepseek_v4.py`](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/models/deepseek_v4.py)：DeepSeek V4 模型执行入口。
