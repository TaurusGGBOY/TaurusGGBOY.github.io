---
title: "Agent Harness 08｜模型流结束前，工具能不能先跑"
published: 2026-07-23
updated: 2026-08-28
description: "比较四种 Agent Harness 如何消费模型流、启动工具、设置结算屏障，并决定下一次模型请求何时发生。"
tags: ["agent-harness", "claude-code", "codex-cli", "pi", "deepseek"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-08/claude-code-source-reading-00.png"
imagePosition: "left"
---
## Claude Code

![Claude Code 在 content block 完成后启动工具，并等待模型流与工具结果共同收敛](/images/posts/claude-code-source-reading-08/agent-theme-08-claude-code-handdrawn.png)

*`content_block_stop` 可以成为工具执行的提交点；它不等于整个模型 response 已经结束。*

Claude Code 2.1.88 把“流式返回”拆成两种同时向上游交付的对象。`queryModelWithStreaming()` 返回异步生成器，联合值是 `StreamEvent | AssistantMessage | SystemAPIErrorMessage`：raw provider event 让 UI 看见实时进度，完成 content block 形成的 `AssistantMessage` 让 query loop 获得可处理语义，重试等待等状态则通过 system API error message 暴露。`queryModelWithoutStreaming()` 也复用这条生成器，只保存最后一条 assistant message；它仍把生成器消费到底，因为统计、费用和资源释放发生在最后一次 yield 之后。

发请求时，Claude Code 把 Anthropic SDK 的自动重试设为 `0`，显式发送 `{ stream: true }`，并把当前 turn 的 `AbortSignal` 传给请求。它没有使用 SDK 的 `BetaMessageStream` 辅助组装器，而是直接读取 raw stream。源码给出的理由很具体：SDK 会在每个 `input_json_delta` 上做部分 JSON 解析，工具参数越长，反复解析的总代价越接近平方级；Claude Code 只需要累积字符串，等块完成后再处理输入。

状态机以 `message_start` 建立 `partialMessage` 和首 token 时间，以 content block 的 `index` 管理并行块。`content_block_start` 遇到 `tool_use` 或 `server_tool_use` 时先把 `input` 置为空字符串；`input_json_delta.partial_json` 到达后持续追加。text、thinking、signature 和 connector text 走各自的 delta 分支，类型与 open block 不匹配会直接报错，而不是悄悄拼到错误对象上。

真正改变工具时序的是 `content_block_stop`。这个事件到达后，Claude Code 会把该 index 的完整 block 包成一条内部 `AssistantMessage`，立即 yield 给 `query.ts`。如果里面有 `tool_use`，query loop 就把它加入 `toolUseBlocks`；当 `streamingToolExecution` gate 开启时，还会马上调用 `StreamingToolExecutor.addTool()`。输入 schema 解析成功后，工具定义的 `isConcurrencySafe()` 决定它能否和其他安全工具并发；非并发安全工具需要独占执行。

因此，Claude Code 的答案是：工具确实可以在整个 LLM stream 返回完之前开始，甚至完成。此时 provider 还可能继续发送其他 content block、`message_delta` 和 `message_stop`。`message_delta` 会带来最终 usage 与 `stop_reason`，源码会原地回写最后一条已经 yield 的 assistant message；直接 mutation 是为了让 100ms 延迟刷新的 transcript 队列仍能看到最终字段。

但下一次 LLM 请求不能跟着某一个早完成的工具立即发出。query loop 先把 `deps.callModel()` 的异步生成器消费到结束，再调用 `getRemainingResults()` 等待 queued/executing 工具全部收敛，并把每个结果归一化成 user-side `tool_result`。只有这些结果写回上下文，本轮才有资格进入下一次 query iteration。这里要区分两件事：工具执行和剩余模型流可以重叠；下一次模型请求仍受“当前模型流结束 + 所有工具结果收齐”双门禁约束。

query loop 也不把 `stop_reason === 'tool_use'` 当作唯一继续信号。源码注释明确说这个值并不总可靠，真正的 `needsFollowUp` 由是否实际收到 `tool_use` block 决定。固定窗口还专门处理 `max_tokens` 与 `model_context_window_exceeded`：两者都会生成 `max_output_tokens` 恢复消息；常规完成则由后续 query 控制流判断是否继续。也就是说，provider stop reason 是输入事实，不是 Agent loop 唯一的状态枚举。

流失败后的边界比正常路径更敏感。idle watchdog 触发、完全没收到 `message_start`、或者只收到 message start 却没有完成 block 且没有 stop reason，都会被当作不完整流并进入错误路径。用户触发的 AbortSignal 会保留为 `APIUserAbortError`；如果 SDK 抛出同类 abort 但外部 signal 没有取消，Claude Code 将其重新分类为连接 timeout。

默认允许 streaming → non-streaming fallback 时，已产生的 partial assistant message 会被 tombstone，旧 `StreamingToolExecutor` 会 `discard()`，旧 `tool_result` 也不会混进 fallback response。这个补救仍有副作用风险：如果旧流已经启动工具，非流式重试可能再次返回同一个逻辑调用。源码因此提供 `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` 与对应 feature gate，任一开启就让错误回到 `withRetry`，避免 mid-stream fallback 造成重复工具执行。生成器无论正常结束、抛错还是被消费者 `.return()`，最终都会 abort/释放未关闭的底层 stream。

## Codex CLI

![Codex CLI 在 OutputItemDone 时启动工具 future，并在 response.completed 后统一 drain](/images/posts/claude-code-source-reading-08/agent-theme-08-codex-cli-handdrawn.png)

*Codex 的提前执行边界是完整 output item，不是仍在增长的工具参数 delta。*

Codex CLI 固定提交 `c6dee5f` 的 provider stream 先被压成 `ResponseEvent`。主线变体包括 `Created`、`OutputItemAdded`、`OutputItemDone`、`OutputTextDelta`、`ToolCallInputDelta`、多种 reasoning delta，以及终态 `Completed { response_id, token_usage, end_turn }`。这里没有一个通用字符串 `stop_reason`：`response.completed` 提供可选布尔值 `end_turn`，工具是否存在则由完成的 `ResponseItem` 决定。

SSE mapper 不会把服务端每个事件原样透传。`response.output_text.delta` 变成 `OutputTextDelta`；`response.custom_tool_call_input.delta` 在能取得 item identity 时变成 `ToolCallInputDelta`；完整的 `response.output_item.done` 才反序列化为 `OutputItemDone(ResponseItem)`。固定提交把 `response.function_call_arguments.delta` 列在未处理事件中，因此普通 function call 的执行依据仍是完成 item 携带的完整 arguments，而不是这个 wire delta。

终态被严格验证。`response.failed` 会根据 error code 映射成 context window、quota、policy、overload 或 retryable error，`response.incomplete` 读取 incomplete reason 后直接成为 stream error。socket 在 `response.completed` 前 EOF 会产生 `stream closed before response.completed`，等待下一个 SSE 超过 provider 的 idle timeout 则产生 `idle timeout waiting for SSE`。可见输出已经出现，不代表 response 成功完成。

Codex 和 Claude Code 一样允许工具执行与剩余模型流重叠，但提交点不同。接收循环读到 `OutputItemDone` 后，`handle_output_item_done()` 会保存最终 item、映射 UI 生命周期，并为工具调用返回一个 `tool_future`。future 立刻压入 `FuturesOrdered`，接收循环随后继续读取 `OutputItemAdded`、文本 delta、其他 item 和最终 `Completed`。`ToolCallInputDelta` 只交给 argument diff consumer 做界面或审批预览，不会直接分派工具。

`FuturesOrdered` 的意义不是把工具强制串行执行，而是让并发 future 的结果按插入顺序被消费。一个短工具可能在 `response.completed` 之前已经完成，一个长工具也可能在模型流结束后继续运行。在正常模型—工具路径，采样循环读到 `ResponseEvent::Completed` 才退出接收阶段；退出后调用 `drain_in_flight()`，等待所有 future，并把成功结果转为 `ResponseItem` 写进 conversation history。工具 failure 会记录错误，但 drain 仍把整个队列收敛。取消会直接产生 `TurnAborted`；固定提交还有 mailbox mail 的抢占分支，可在 commentary/reasoning item 完成后提前结束当前接收循环，这两类控制分支不应误解为“工具结果已经足够，所以 response 自动完成”。

所以在正常工具路径中，“工具执行完了，LLM stream 还没返回完”时，Codex 不会马上请求下一次 LLM。它继续等 `response.completed`；反过来，模型已经 completed 而工具还没完成时，它继续等 `drain_in_flight()`。只有两个条件都满足，当前 `run_sampling_request()` 才返回给 turn loop。在两段实际重叠的时间窗里，收敛点由较慢的一侧决定，同时保留明确的 response 终态。

是否再采样由 `needs_follow_up` 汇总。完成 tool item 的处理结果可以把它设为 true；`Completed.end_turn === Some(false)` 也会把它设为 true。`Some(true)` 只表示服务端肯定结束自己的 turn，不会清除已经由工具设置的 follow-up；`None` 表示 provider 没提供肯定答案，Codex 保留本地工具和 pending input 逻辑。采样返回后，turn loop 还会等待异步 hooks，再把 mailbox/pending input 合并进最终 follow-up 决策。

取消贯穿 stream creation、`stream.next()` 和工具 future。等待 event 时 cancellation token 触发会返回 `TurnAborted`；response stream 消费者被 drop 时，client mapping task 用单独的 cancellation token 停止转发，并把已见的 `items_added` 记录为 cancelled partial output。可重试 stream error 则进入 provider 配置的次数预算和 backoff；下一次 attempt 会重建 prompt，并把已执行工具的 metadata 有界地附回输入。重试因此不是“忘记刚才一切，从零复制一次请求”。

## Pi

![Pi 先把 provider stream 收敛成最终 AssistantMessage，再按策略执行工具批次](/images/posts/claude-code-source-reading-08/agent-theme-08-pi-handdrawn.png)

*Pi 的 toolcall start/delta/end 是消息组装事件；它们不是 Agent 的工具调度事件。*

Pi 固定提交 `9d2ec7f` 把 provider 差异收敛在 `AssistantMessageEventStream`。统一事件必须以 `start` 开始；text、thinking、tool call 分别具有 start/delta/end；整个 response 最终发 `done` 或 `error`。`EventStream.push()` 一旦看到这两个终态之一，就解析并 resolve `result()`，terminal event 本身仍会交给异步迭代消费者，之后的 push 被忽略。

Pi 的完整 `StopReason` 联合是 `pending | stop | length | toolUse | error | aborted | deferred`。其中 `pending` 是 adapter 组装期间的内部状态，不能作为成功终态；正常 `done.reason` 只允许 `stop | length | toolUse | deferred`，失败 `error.reason` 只允许 `aborted | error`。Anthropic adapter 把 wire 值 `end_turn` 映射为 `stop`，`max_tokens` 映射为 `length`，`tool_use` 映射为 `toolUse`，`pause_turn` 和 `stop_sequence` 收敛为 `stop`；`refusal` 与额外兼容的 `sensitive` 变成带错误信息的 `error`，未知值直接报错。

Anthropic adapter 自己处理 SSE framing。HTTP body 的字节块先经过 `TextDecoder`，按 CR/LF 切行，再累积 `event:` 与可跨行的 `data:`；只有空行才提交一个完整 SSE event。它只接受 message/content block 六类消息事件，provider 的 `error` event 直接抛错。若已经看到 `message_start` 却在 `message_stop` 前 EOF，adapter 明确报 `Anthropic stream ended before message_stop`；即使完全没有 start，最终 `stopReason` 仍停在 pending，也会失败。

工具参数经历两个完成层级。`content_block_delta.input_json_delta` 先追加到 `partialJson`，并用容错 parser 更新 `block.arguments`，让 UI 可以预览正在形成的对象；`content_block_stop` 再做最终解析、删除 scratch buffer，并发 `toolcall_end`。这解决了展示问题，却没有改变 Agent 调度边界。

`streamAssistantResponse()` 会完整迭代 `AssistantMessageEventStream`。start 把 partial assistant 放进当前 context，delta/end 只更新最后一条消息并发送 `message_update`。只有收到 `done` 或 `error`，它才 `await response.result()`、用 final message 替换 partial、发 `message_end` 并返回。外层 Agent loop 拿到这条 final `AssistantMessage` 后，才过滤其中的 `toolCall` block。

因此 Pi 不会在同一个 response 尚未终止时提前执行工具。工具批次默认可以 parallel，也可通过 `config.toolExecution === 'sequential'` 强制串行；只要其中任一工具定义声明 `executionMode === 'sequential'`，整批也走串行路径。parallel 路径先准备所有调用，再用 `Promise.all` 等待执行和 finalize，最后按源调用顺序生成 `ToolResultMessage[]`。下一次 LLM 请求发生在整批结果写回 `currentContext.messages` 之后。

`length` 是一个有意收紧的安全边界。流式容错 parser 可能把被 token limit 截断的 JSON 修成一个表面合法对象，如果照常执行，缺失字段可能改变文件或命令含义。Pi 因此不执行该 assistant message 中任何 tool call，而是逐个发 tool execution start/end，并生成“参数可能被截断”的失败结果，让模型下一轮重新发完整调用。

provider request retry 也有清晰作用域。Pi 把 SDK `maxRetries` 固定为 `0`，再由 `retryProviderRequest()` 包住取得 HTTP response 的调用；默认 `maxRetries` 仍是 `0`，调用方可以配置正整数。`x-should-retry` 可显式允许或禁止；否则无 status、408、409、429 与 5xx 可重试。`retry-after-ms`、`retry-after` 或指数退避决定可取消等待，服务端延迟默认不能超过 60 秒，`maxRetryDelayMs: 0` 才关闭上限。因为 helper 在开始读取 body 前已经返回，已经产生 partial event 的中途断流不会由它自动重放。

## DeepSeek Harness

![DeepSeek Harness 用 finish 终态约束统一 chunk，再创建消息和执行工具](/images/posts/claude-code-source-reading-08/agent-theme-08-deepseek-harness-handdrawn.png)

*DeepSeek wire 的 `[DONE]` 先收敛为 Harness `finish`；Agent loop 只依赖统一协议。*

DeepSeek Harness 固定提交 `47f9438` 把 adapter 输出定义成一个很小的 `StreamChunk` 联合：`block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish`。block index 关联交错 delta，tool arguments 始终保留为原始 JSON 字符串。adapter 可以 throw，但 `LlmRuntime.stream()` 会把最终 adapter 的选择、dispatch 或 iteration failure 归一化成 terminal finish：外部 signal 已取消或 failure code 为 `ABORTED` 时使用 `aborted`，其他使用 `error`。middleware、consumer 和 cleanup 自身的异常仍然向外抛，不会被伪装成 provider failure。

固定核心 `FinishReason` 是五种：`stop`、`tool-calls`、`max-tokens`、`aborted`、`error`。前两种正常完成分别表示普通停止与模型请求工具；`max-tokens` 表示输出上限；后两种都携带结构化 failure。这个联合由 interface map 生成，插件可以扩展，所以消费者需要为未知扩展保留兼容策略，不能把五个核心值写成永久封闭的服务端枚举。

DeepSeek adapter 的 wire vocabulary 又是另一层。`finish_reason: stop` 映射为 `stop`，`tool_calls` 映射为 `tool-calls`，`length` 映射为 `max-tokens`；`content_filter`、`insufficient_system_resource` 或未来未知字符串统一变成 `error`，failure code 使用其大写形式。wire reason、Harness finish reason 与 Agent step end reason职责不同，不能混写成同一组 stop reason。

直接 DeepSeek translator 刻意延后终态。reasoning、content 和各个 `tool_calls[index]` 到达时，它会建立 block 并立即 yield delta；但 `finish_reason` 和 usage 只保存为 pending。只有 SSE parser 交出 `[DONE]`，translator 才按打开顺序 yield 全部 `block-end`，随后 yield 最新 usage，最后 yield finish，并立刻返回。没有 `[DONE]` 的 EOF 是 `STREAM_CLOSED`；一个没有任何 block 的默认 stop 不是成功空消息，而是 `EMPTY_RESPONSE` error finish。

统一协议外面还有 invariant gate。每个 index 必须是非负安全整数；delta 必须指向类型匹配的 open block；同一 index 不能重复 start；block end 必须关闭存在且同类型的 block；usage 最多一次；正常 finish 时不能留下 open block；finish 之后禁止任何 chunk；整个 iterable 最终必须见到 finish。只有 `error` 或 `aborted` 可以带着未闭 block 结束，因为这时保存 partial state 比伪造完整 block 更准确。

Agent loop 的时序因此非常直接。每个 chunk 先以 `assistant/chunk` 追加到 session，再喂给 `BlockAssembler`；`for await` 完整结束后读取 assembler.finish。error/aborted 会进入 `agent/request-error` waterfall，只有扩展返回 `{ kind: 'retry' }` 才重新构造并发送请求。正常终态先创建 `assistant/message`，再从其 content 中过滤完整 `tool-call` block；没有调用就结束 step，有调用才执行 `executeToolCalls()`。Harness 固定窗口没有根据 `tool-call-delta` 在同一 response 内提前执行工具。

`max-tokens` 也不会把部分工具参数带入执行。`BlockAssembler.blocks()` 在该终态下删除所有 `tool-call` block，Agent step 直接返回 max-tokens 结果。普通 tool-calls 则等待整个工具调度器完成，下一 step 才从 session surface 派生包含 tool result 的新请求。

直接 adapter 在一次 stream 开始时冻结 connection 配置、endpoint 和 credential，下一次调用才重新解析。caller signal 与内部 consumer controller 通过 `AbortSignal.any()` 合并，idle watchdog 包住 iterator：watchdog 超时映射为 `TIMEOUT`，调用方取消映射为 `ABORTED`，其他网络失败映射为 `TRANSPORT`；消费者提前停止时 finally 会 abort 底层请求并调用 iterator.return()。

retry 不藏在 adapter 内部。`llm-retry` 插件监听 `agent/request-error`，按本次实际 provider 捕获的 policy 判断：`normal` 模式只重试配置的 failure code 且受 `maxRetries` 限制；`always` 模式没有有限次数上限。延迟优先采用不超过 `maxDelayMs` 的 provider retry-after，否则使用带 jitter 的指数退避；等待期间 signal 或插件 lifetime 取消就不会返回 retry 决策。每次调度和真正开始重试还分别写 `llm/retry`、`llm/retry-started`，让“已经记录 partial chunk”与“准备重新请求”成为两个可审计事实。
