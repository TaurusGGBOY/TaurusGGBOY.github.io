---
title: "Agent Harness 05｜单轮查询引擎与 Agent Loop"
published: 2026-07-22T10:26:41+08:00
description: "比较四种 Agent Harness 如何把一次用户输入组织成模型采样、工具回环、状态推进与最终结束。"
tags: ["agent-harness", "claude-code", "codex-cli", "pi", "deepseek"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-05/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-28
---
## Claude Code

![Claude Code 把每一种续跑原因连同消息和工具上下文一起写入 queryLoop 状态](/images/posts/claude-code-source-reading-05/agent-theme-05-claude-code-handdrawn.png)

*工具可以在当前模型流尚未结束时启动；下一次模型请求仍要等本批工具结果收齐、规范化并写入下一份 State。*

Claude Code 2.1.88 把入口分成两层。`query()` 是生命周期外壳：它用 `yield* queryLoop(...)` 原样转发异步生成器事件，只有 `queryLoop()` 正常返回后，才把本轮真正消费过的命令标记为 `completed`。如果内层抛错，或者消费者用生成器的 `.return()` 提前关闭，正常收尾不会执行。`queryLoop()` 才是推进一次用户请求的状态机。

`queryLoop()` 在 `while (true)` 外维护一份 `State` 来保存现场。固定源码中的字段包括 `messages`、`toolUseContext`、`autoCompactTracking`、`maxOutputTokensRecoveryCount`、`hasAttemptedReactiveCompact`、`maxOutputTokensOverride`、`pendingToolUseSummary`、`stopHookActive`、`turnCount` 和 `transition`。每个 `continue` 分支都构造下一份 State；消息历史说明“下次给模型看什么”，`transition` 说明“为什么还要再请求一次”。压缩重试、输出上限恢复、Stop Hook 阻塞和正常工具续跑因此能共用一条循环，同时保留各自的恢复现场。

模型调用由 `deps.callModel(...)` 返回异步流。每出现一条 assistant message，循环都会扫描其中的 `tool_use` block：只要找到一个，就把它加入 `toolUseBlocks`，并把 `needsFollowUp` 设为 `true`。固定源码以流中实际观察到的 `tool_use` block 作为工具续跑信号；注释同时记录了供应商响应的 `stop_reason === 'tool_use'` 可能不稳定这一实现理由。

启用 `streamingToolExecution` gate 时，`StreamingToolExecutor.addTool()` 会在当前模型流仍被消费时启动已经完整出现的工具。循环还会在流内反复调用 `getCompletedResults()`，把先完成的工具结果及时产出。因此完全可能出现这种时间线：LLM 还在返回后续 chunk，第一个工具已经开始，甚至已经执行完。未启用该 gate 时，循环等模型流结束，再通过 `runTools()` 执行整批工具。

下一次 LLM 请求的屏障位于完整工具批次之后。模型流结束后，流式路径还要消费 `getRemainingResults()`；普通路径也要完整迭代 `runTools()` 的更新。每条结果经 `normalizeMessagesForAPI()` 转成 API 可接受的 user/tool-result 消息，工具批次结束后还会处理附件、命令通知和可用工具刷新。最后才构造：

```ts
state = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: updatedToolUseContext,
  turnCount: turnCount + 1,
  transition: { reason: 'next_turn' },
  // 其余恢复字段省略
}
```

下一圈 `callModel()` 看到的是完整 assistant tool-use 与相匹配的 tool-result。若用户在执行中取消，循环也不会留下悬空调用：流式 executor 会为排队中或执行中的工具生成合成结果，再以 `aborted_streaming` 或 `aborted_tools` 结束；这样历史仍满足每个 `tool_use` 都有对应 `tool_result` 的协议约束。

没有观察到工具请求时，循环也不一定立刻结束。prompt-too-long 可以进入 collapse 或 reactive compact 后重试；`max_output_tokens` 可以先提高上限或注入恢复消息；Stop Hook 可以返回 continuation fragments 并以 `stop_hook_blocking` 续跑；Token Budget 也可以注入 nudge，以 `token_budget_continuation` 续跑。只有这些分支都不要求继续，才返回 `{ reason: 'completed' }`。固定窗口还可见 `blocking_limit`、`prompt_too_long`、`image_error`、`stop_hook_prevented`、`aborted_streaming`、`aborted_tools`、`hook_stopped` 与 `max_turns` 等 Terminal reason；它们是 Harness 的结束分类，不等同于模型供应商原始 `stop_reason`。

## Codex CLI

![Codex CLI 在一个 run_turn 内用 sampling 边界决定续跑、压缩或执行 Stop Hook](/images/posts/claude-code-source-reading-05/agent-theme-05-codex-cli-handdrawn.png)

*`run_turn()` 管模型—工具往返；`run_sampling_request()` 还包含一层响应流重试循环，两层 loop 的职责不同。*

Codex CLI 固定提交把一个用户 turn 的主循环写在 `codex-rs/core/src/session/turn.rs::run_turn()`。函数开头先处理上轮异步 Hook 结果和 pre-sampling compact，解析输入需要的 MCP server 与插件，记录用户输入和上下文注入项，然后创建 turn 范围的 `ModelClientSession`。这份 client session 会在本 turn 的后续采样与可重试请求之间复用 WebSocket 和 sticky routing 状态。

主循环每圈先决定是否 drain 用户在模型运行期间追加的 pending input。第一次采样必须先处理启动本 turn 的原始输入；auto-compact 之后，如果模型或工具链仍在续跑，也可能延后 steering，防止新输入插到恢复链中间。随后 `capture_step_context()` 固定本次请求看到的环境、工具路由与配置，再用 `ContextManager.for_prompt()` 从历史生成 `Vec<ResponseItem>`，交给 `run_sampling_request()`。

`run_sampling_request()` 覆盖一次 sampling 的完整运行边界。它构造 `ToolCallRuntime`，再由 `try_run_sampling_request()` 消费 Responses API 流、记录输出 item、调度工具并等待工具 future。函数返回的 `SamplingRequestResult` 含 `needs_follow_up` 和 `last_agent_message`。工具可以并发执行，但这次 sampling request 必须先得到稳定的工具执行结果，`run_turn()` 才会拿到结果并判断下一圈；当前响应流和工具结果归档完成之前不会启动下一次 sampling。

回到 `run_turn()` 后，`model_needs_follow_up` 与输入队列里的 `has_pending_input` 做逻辑或，形成真正的 `needs_follow_up`。前者表示模型刚产生的工具链还需要继续，后者表示用户或其他 mailbox delivery 为当前 turn 增加了输入。只要任一为真，就继续主循环；下一圈重新从 Session 历史构造 prompt，所以工具输出、追加输入和新世界状态都成为下一次模型请求的边界输入。

续跑前还会检查 context window。只有“本来就需要 follow-up”且用户请求新窗口或 token limit 已到，才执行 mid-turn auto compact。压缩完成后回到循环，先恢复模型/工具 continuation，再按规则处理 pending input。没有 follow-up 时则保存候选最终 assistant message并运行 Stop Hook：Hook 可以注入 continuation fragment、把 `stop_hook_active` 设为真后继续；也可以允许结束。最终 `break` 才表示这个 turn 的采样链已经闭合。

`run_sampling_request()` 还有一层 response-stream 重试循环：可重试错误会重新发送请求、记录 retry timing，并遵守 provider 的 `stream_max_retries()`；`ContextWindowExceeded` 与 `UsageLimitReached` 直接向上返回。这个内层循环处理同一 sampling 的传输/服务重试；`run_turn()` 外层循环处理工具结果、pending input、压缩和 Stop Hook 引起的语义续跑。前者重试同一 sampling，后者开始下一次带新历史的 sampling。

## Pi

![Pi 用内层工具与 steering 循环、外层 follow-up 循环分开两种追加输入](/images/posts/claude-code-source-reading-05/agent-theme-05-pi-handdrawn.png)

*Pi 先完整收束 assistant stream，再执行工具批次；steering 决定内层是否续跑，follow-up 只在原本要结束时补入。*

Pi 的 `packages/agent/src/agent-loop.ts::runLoop()` 把续跑意图直接写成双层循环。外层 `while (true)` 管 follow-up；内层 `while (hasMoreToolCalls || pendingMessages.length > 0)` 管 assistant 回合、工具结果与 steering。开始前先调用一次可选的 `getSteeringMessages()`，所以用户在等待期间送来的消息可以在首次 assistant 响应前进入 context。

内层每圈先发 `turn_start`，把 `pendingMessages` 依次作为完整消息写入 `currentContext.messages`，再 `await streamAssistantResponse(...)`。这个函数会把 provider 的流事件归约成一条最终 `AssistantMessage`，发完 `message_end` 后才返回。与 Claude Code 2.1.88 的 streaming executor 不同，本固定提交中的 Pi 不会在 `streamAssistantResponse()` 尚未完成时启动工具；它拿到完整 assistant message 后，才从 `content` 里筛选 `toolCall`。

Pi 在 AI 层声明的 `StopReason` 可见值是 `pending`、`stop`、`length`、`toolUse`、`error`、`aborted` 与 `deferred`。Agent loop 对不同值有不同分支：`error` 或 `aborted` 会发出 `turn_end`、`agent_end` 后立即返回；`length` 如果同时带有 tool call，循环认为参数可能被截断，不执行任何一个，而是为整批生成错误 tool-result，让模型下一圈重新发出完整调用。普通工具续跑由实际 `content` 中是否存在 `toolCall` 决定，`toolUse` 字符串不是单独的续跑依据。

工具批次有两个源码可见模式：`sequential` 与 `parallel`。`config.toolExecution === 'sequential'`，或者批次中任一目标工具声明 `executionMode === 'sequential'`，整批走串行；其余走并行。并行路径先按模型顺序做参数准备与前置检查，再以 `Promise.all` 等待已允许的执行任务；工具结束事件可按实际完成时间出现，但写回 context 的 tool-result message 会恢复为模型原始调用顺序。只有整批形成稳定结果后，`hasMoreToolCalls` 才更新，下一次 assistant 请求才可能开始。

每圈 `turn_end` 之后，`prepareNextTurn` 可以为下一次请求替换 `context`、`model`，以及 `thinkingLevel`；字段都可省略，省略时沿用当前值，`thinkingLevel: 'off'` 会把 reasoning 设为 `undefined`。随后 `shouldStopAfterTurn` 可以在不 abort 当前流、不丢弃当前工具结果的情况下阻止下一次 LLM 请求。若仍继续，`getSteeringMessages()` 的结果进入内层；当内层因为无工具、无 steering 即将退出，才调用 `getFollowUpMessages()`。有 follow-up 就转成新的 pending message 回到内层，没有才发 `agent_end`。

这两类队列表达不同时间语义：steering 是“在当前工作链下一次模型调用前插入”，follow-up 是“当前工作链本来要结束，再追加一项工作”。Pi 为这两个语义各留一个轮询点，宿主可以据此确定中途输入应进入哪一个队列。

## DeepSeek Harness

![DeepSeek Harness 用持久事件把一个 Session 划分为可重复的 Turn 和 Step](/images/posts/claude-code-source-reading-05/agent-theme-05-deepseek-harness-handdrawn.png)

*`ReactLoopAgent` 在需要续跑时先把工具结果写入 Session，再开启下一个 Step；只有可选的 additional context 才进入 next-step Inbox。*

DeepSeek Harness 固定提交把循环层次显式命名为 Session、Turn 和 Step。`ReactLoopAgent.kick()` 用 `while (await this.turn()) {}` 驱动多个 turn；`turn()` 内部再用 `while (true)` 驱动多个 step。Session 事件日志直接承载运行状态：`turn/start`、`step/start`、assistant chunk、assistant message、tool call、tool result、`step/end` 与 `turn/end` 都按顺序 append，下一次请求通过 `session.deriveMessages()` 从这份事件日志得到模型消息。

每个 step 开始前，`preStep(target, { turn, step })` 从 Inbox 的 `next-turn` 或 `next-step` target 认领消息，再调用 system prompt service 装配上下文。`agent/pre-step` waterfall 的默认决定是 `enter`，插件可以改写消息或返回 `reject`；reject 会把 turn reason 设为 `blocked` 并停止。由此，Inbox 负责输入归属，Prompt Assembly 负责系统上下文，两者在发请求前才合并。

`step()` 调用 LLM 后，以 `for await (const chunk of stream)` 完整消费响应流；每个 chunk 先写成 `assistant/chunk`，`BlockAssembler` 在流结束后才生成稳定的 assistant message。只有这时，源码才从 message content 中筛选 `tool-call` 并调用 `executeToolCalls()`。所以本固定窗口的 DSH 与 Pi 一样，不会让工具执行和当前 LLM stream 重叠。

没有工具调用时，step 返回 `{ kind: 'completed' }`。有工具时，调度器按每个工具当前的 `executionMode` 分组：exclusive 调用形成屏障，parallel 调用进入受 `maxParallelToolCalls` 限制的滚动池；执行体可以重叠，但 prepare、结果提交和 additional context 接收保持模型顺序。工具结果写入 Session；存在 `additionalContexts` 时，才把它们 splice 到 `next-step` Inbox。工具结果若带 `concludesTurn: true`，step 直接返回 completed；否则返回 `null`。这个 `null` 让 `turn()` 保持当前 turn 开放并开始下一个 step，并不要求 next-step Inbox 一定有消息。

DSH 的模型—工具—模型往返横跨两个 step：Step N 完整结束模型流，执行并持久化工具；Step N+1 claim 可选的 next-step 输入、重新装配 system prompt，并通过 `session.deriveMessages()` 取得已经记录的工具结果，再发下一次 LLM 请求。工具内部并行不改变这个屏障，下一 step 不会在 started calls 尚未 drain、结果尚未按模型顺序 commit 时提前开始。

当一个 step 得到完成原因且 `next-step` 队列为空，`turn()` 先发 `agent/turn-stopping`，再写 `turn/end`。固定源码的 `TurnEndReason` 可见 `completed`、`aborted`、`blocked`、`error`、`max-tokens` 与 `interrupted`；其中活动 loop 不产生 `interrupted`，它由持久化后端在重载时关闭崩溃遗留 turn。`max-tokens` 具有 sticky 语义，后续 step 普通完成也不会把它降级成 completed。turn 结束后若 Inbox 仍有 pending 输入，driver 换一枚新的 `AbortController`、把 step 归零并开启新 turn；没有 pending 输入才回到 `idle`。
