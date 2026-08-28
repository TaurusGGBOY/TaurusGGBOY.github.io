---
title: "Agent Harness 02｜一次请求如何走完全程"
published: 2026-07-20
description: "对照四种 Agent Harness，追踪一次用户请求从模型流、工具调用到下一轮请求或最终停止的完整路径。"
tags: ["agent-harness", "claude-code", "codex-cli", "pi", "deepseek"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-02/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-28
---
## Claude Code

![Claude Code 让工具执行与当前模型流重叠，但在下一次模型请求前设置结算屏障](/images/posts/claude-code-source-reading-02/agent-theme-02-claude-code-handdrawn.png)

*`StreamingToolExecutor` 可以提前启动工具；`queryLoop()` 仍会等当前流结束并收齐工具结果，才进入下一次 LLM 请求。*

Claude Code 2.1.88 收到一条消息后，`restored-src/src/query.ts` 的 `queryLoop()` 先准备 `messagesForQuery`、system prompt、工具集合和 `toolUseContext`，随后通过 `deps.callModel()` 发起模型请求。返回值是异步消息流，`for await` 每拿到一条 assistant message，就把它追加到 `assistantMessages`，再从 content 中提取完整的 `tool_use` block。

这里出现了最容易误解的时序。只要 `config.gates.streamingToolExecution` 打开，`queryLoop()` 就创建 `StreamingToolExecutor`。模型流中出现完整 `tool_use` 后，循环立即调用 `addTool()`；`addTool()` 把调用放入队列，`processQueue()` 在并发安全条件允许时启动 `executeTool()`。此时 `deps.callModel()` 的 `for await` 可能还没有退出，所以工具主体可以和当前模型流的后半段重叠执行。

这项重叠只缩短工具启动延迟，没有跨过下一轮推理的输入屏障。模型流继续产生事件，循环一边 yield 文本或进度，一边用 `getCompletedResults()` 非阻塞地取出已经完成的工具结果。直到流正式结束，代码才离开 `query_api_streaming` 阶段；之后还会调用 `getRemainingResults()`，等待队列和执行中的工具全部结算，并把每条结果规范化为带对应 `tool_use_id` 的 user message。

因此，工具开始执行时不必等待 LLM stream 完全返回；下一次 LLM 请求则必须等待两件事：当前模型流已经结束，这一批 `tool_use` 都有可写入历史的 `tool_result`。工具进度可以提前显示，已完成结果也可以提前 yield，但 `state = next` 使用的是 `messagesForQuery + assistantMessages + toolResults`。只有这份历史组装完成，`while (true)` 才会进入下一轮 `deps.callModel()`。

这也是中断路径必须补结果的原因。当前流或工具被取消时，`getRemainingResults()` 会为已排队、执行中或被丢弃的调用生成合成错误结果；未启用 streaming executor 时，`yieldMissingToolResultBlocks()` 执行同样的账本闭合。缺少配对结果就直接发下一次请求，会形成只有 `tool_use`、没有 `tool_result` 的非法历史。

`stop_reason` 在这里不是唯一控制变量。源码注释明确写着 `stop_reason === 'tool_use'` 不可靠，所以续轮依据是实际出现的 `tool_use` block，并据此设置 `needsFollowUp`。固定源码中直接能看到对 `tool_use`、`end_turn`、`max_tokens`、`stop_sequence`、`refusal`、`model_context_window_exceeded` 等值的处理或记录，但类型本身来自外部 SDK 的 `BetaStopReason`，静态还原源码没有给出可声称永久完整的枚举。

还要把 API stop reason 与 query loop 的返回原因分开。`end_turn` 可能表示这次模型采样正常结束；整个 query 还可能因为 `blocking_limit`、`aborted_streaming`、`max_turns` 等本地条件结束。模型为什么停止生成，与 Agent 为什么不再继续循环，是相邻但不同的两层状态。

## Codex CLI

![Codex CLI 在 SSE 内启动工具 future，Completed 后 drain，再决定下一次采样](/images/posts/claude-code-source-reading-02/agent-theme-02-codex-cli-handdrawn.png)

*Codex CLI 让 tool future 与 Responses SSE 重叠；`ResponseEvent::Completed` 和 `drain_in_flight()` 共同守住下一次 sampling request 的边界。*

Codex CLI 固定提交中的一次用户 turn 从 `codex-rs/core/src/session/turn.rs` 的 `run_turn()` 开始。它记录输入、准备 `StepContext`、构造模型可见历史，然后调用 `run_sampling_request()`。一次 sampling request 对应一次 Responses API 流；一个 user turn 则由 `run_turn()` 的外层 `loop` 承载，可能包含多次 sampling request。

真正消费 SSE 的是 `try_run_sampling_request()`。它先创建 `ToolCallRuntime` 和 `FuturesOrdered`，再不断读取 `ResponseEvent`。文本 delta 被转成客户端事件；工具调用的参数增量可以交给 diff consumer；直到 `OutputItemDone` 给出完整的 function/custom tool item，`handle_output_item_done()` 才返回一个 tool future，并被放入 `in_flight`。

tool future 放入队列后会异步执行，而 SSE 读取循环继续等待后续事件。也就是说，Codex CLI 和 Claude Code 一样，可以在模型流还没收到正式结束事件时启动工具。区别在触发单位：Codex 等完整 output item done，Claude Code 等事件中完整的 `tool_use` block；两者都不会拿半截 JSON 参数直接执行普通工具。

随后 SSE 必须出现 `ResponseEvent::Completed`。这个分支记录 token usage、response id 和可选 `end_turn`，再返回 `SamplingRequestResult { needs_follow_up, last_agent_message }`。如果流在 Completed 之前关闭，源码把它当成 `stream closed before response.completed`，而不是把 EOF 猜成一次正常结束。

离开 SSE 循环后，`try_run_sampling_request()` 调用 `drain_in_flight()`。这个函数逐个等待 `FuturesOrdered` 中尚未完成的工具 future，把输出转成 `ResponseInputItem` 并写进 conversation history。只有 drain 完成，`run_sampling_request()` 才返回给 `run_turn()`；外层随后合并 pending input，并根据 `model_needs_follow_up || has_pending_input` 决定是否进入下一轮。

所以问题的答案仍然是：工具执行可以与当前 LLM stream 重叠，但下一次 LLM sampling 必须等当前流 Completed，并等所有已启动工具输出进入历史。工具 A 先结束并不会单独触发第二次 sampling；`FuturesOrdered` 仍要把本批 future drain 完，下一次 prompt 才具备完整、顺序稳定的 tool call/output 对。

Codex 的内层控制没有依赖一个类似 Pi 的统一字符串 `StopReason`。主要信号是实际 output item 是否要求工具、`ResponseEvent::Completed` 是否带 `end_turn: Some(false)`、是否存在 pending input，以及最终算出的 `needs_follow_up`。app-server 还会对外暴露 turn 的进行中、完成、失败或中断状态，但那是宿主生命周期，不应与 Responses 流里的完成事件混成同一个“stop reason”列表。

## Pi

![Pi 先完整收束 assistant stream，再并行结算工具并按源顺序提交结果](/images/posts/claude-code-source-reading-02/agent-theme-02-pi-handdrawn.png)

*Pi 不让工具与当前 provider stream 重叠；它先得到最终 assistant message，再执行整批工具，最后决定下一轮。*

Pi 固定提交的顺序更直接。`packages/agent/src/agent-loop.ts` 中，`runLoop()` 先 `await streamAssistantResponse()`。这个函数持续消费 provider 事件，发出 `message_start`、`message_update`，最终用完整 assistant message 替换 partial message 并发出 `message_end`。只有这个 Promise 返回以后，`runLoop()` 才从 content 中筛选 `toolCall`。

因此 Pi 不会在当前 LLM stream 尚未结束时启动普通工具。完整 assistant message 到手后，才进入 `executeToolCalls()`。配置 `toolExecution === "sequential"`，或者这批存在声明为 sequential 的工具时，调用按顺序执行；否则进入并行分支。固定源码窗口中 `Agent` 的默认 `toolExecution` 是 `parallel`。

并行并不意味着结果历史按完成时间乱序。preparation 先按模型调用顺序进行，需要真正执行的调用被保存为异步 thunk；`Promise.all` 并行等待它们。每个工具结束时可以立即发 `tool_execution_end`，所以 UI 能看到真实完成先后；`Promise.all` 返回后，代码再遍历 `orderedFinalizedCalls`，按 assistant message 中的原始顺序创建并提交 toolResult message。

下一次 LLM 请求位于内层 while 的下一次迭代。它要等 `executeToolCalls()` 整体返回，并把本批 tool result 全部推入 `currentContext.messages`。单个工具提前结束只会产生进度事件，不能让模型在其他工具尚未完成时先看一份不完整结果。这个屏障换取 transcript 的确定性：同一 assistant message 产生的结果顺序不受机器调度抖动影响。

Pi 的 `StopReason` 在 `packages/ai/src/types.ts` 中显式定义为 `pending | stop | length | toolUse | error | aborted | deferred`。`pending` 是流尚未结束的临时值；`stop` 是正常停止；`length` 表示长度上限；`toolUse` 表示 provider 因工具调用结束当前生成；`error` 与 `aborted` 是失败和取消；`deferred` 用于延后完成的 provider/runtime 路径。

这些 reason 也不是 Agent 是否续轮的全部答案。`error` 或 `aborted` 会直接结束 run；`length` 时，即使 partial JSON 恰好可解析，loop 也把其中工具调用整批转换成失败结果，避免执行被截断参数；有 tool call 时通常继续，但如果整批工具结果都带 `terminate: true`，可以结束；`shouldStopAfterTurn` 钩子也能在 turn 结算后停止。最后还要检查 steering 和 follow-up 两个队列，两个都空才发 `agent_end`。

## DeepSeek Harness

![DeepSeek Harness 用 Step 结算一次模型流和工具批，再在同一 Turn 内进入下一 Step](/images/posts/claude-code-source-reading-02/agent-theme-02-deepseek-harness-handdrawn.png)

*DeepSeek Harness 把“一次 LLM 请求加它产生的工具”定义为 Step；Step 返回 `null`，才表示 Turn 仍欠下一次请求。*

DeepSeek Harness 固定提交用 turn 和 step 把边界直接写进状态机。`packages/core/agent-loop/src/agent.ts` 的 `turn()` 先追加 `turn/start`，每次循环追加 `step/start`，调用 `step()`，最后无论成功或失败都在 `finally` 中追加 `step/end`。同一个 turn 可以包含多个 step。

`step()` 先构造一次冻结的模型请求，再完整消费 `llm.stream()`。每个 chunk 都被追加为 `assistant/chunk` 并送进 `BlockAssembler`；`for await` 退出以后读取 `assembler.finish`，生成完整 `assistant/message`。所以它和 Pi 一样，不在当前 LLM stream 尚未收束时启动普通工具。

如果 finish 为 error 或 aborted，请求错误 waterfall 可以决定 retry；不重试则抛出结构化 `LlmError`。如果 finish 为 `max-tokens`，step 直接返回同名原因，不执行这条截断消息中的工具。正常完成时才提取 `tool-call`：没有工具返回 `{ kind: "completed" }`，有工具则 `await executeToolCalls()`。

工具调度器位于 `packages/core/agent-loop/src/tool-calls.ts`。parallel 工具进入受 `maxParallelToolCalls` 限制的滚动池，exclusive 工具形成屏障。工具主体可以乱序完成，但 `commitReady()` 只沿连续的模型顺序槽位前进；它完成 post policy、追加 `tool/result`，并把 additional context 放进 next-step inbox。取消时，已启动调用先 drain，未启动调用补合成错误结果。

工具批全部结算后，`step()` 根据 `concluded` 返回 `completed` 或 `null`。`null` 不是异常，也不是“流还没结束”；它表示当前模型流与工具批都已经结束，但工具结果要求同一个 turn 再开一个 step。`turn()` 收到 `null` 后进入下一轮，`preStep()` 领取 next-step context，再发下一次 LLM 请求。

内建 `TurnEndReason` 在 `packages/core/session/src/types.ts` 中包括 `completed`、`aborted`、`blocked`、`error`、`max-tokens`、`interrupted`。`aborted` 还携带 user、parent、hook、disposed 等取消来源；`interrupted` 专门用于持久化后端重载时闭合崩溃留下的孤立 turn，正常 loop 不会发出它。这个 reason map 支持 TypeScript declaration merging，插件可以扩展新变体，因此静态源码能穷举的是内建集合，不是所有未来运行时组合。
