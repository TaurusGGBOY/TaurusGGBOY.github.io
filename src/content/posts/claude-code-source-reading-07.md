---
title: "Agent Harness 07｜消息怎样在模型、UI 与磁盘之间变形"
published: 2026-07-22T16:00:00+08:00
description: "比较四种 Agent Harness 的消息模型、工具调用关联、流式事件投影与持久化记录。"
tags: ["agent-harness", "claude-code", "codex-cli", "pi", "deepseek"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-07/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-28
---
## Claude Code

![Claude Code 将内部消息分别投影到模型请求、SDK 事件和 JSONL 历史](/images/posts/claude-code-source-reading-07/agent-theme-07-claude-code-handdrawn.png)

*`message.id`、`uuid/parentUuid`、`tool_use_id` 各自连接不同对象；它们不能合并成一个“消息 ID”。*

Claude Code 2.1.88 里至少要同时区分消息信封和内容块。内部信封用 `type` 决定处理路径；在本章固定窗口可见的主线值包括 `user`、`assistant`、`system`、`attachment` 与 `progress`。`user` 或 `assistant` 信封内部还包着 API 风格的 `message.role` 和 `message.content`。`tool_use` 不是与 `assistant` 平级的内部消息类型，而是 assistant content block；`tool_result` 同样不是新的顶层 role，而是 user content 中的结果块。

这个双层结构允许同一份语义内容产生不同粒度的节点。`normalizeMessages()` 遇到 assistant 的多个 content block，会把它们拆成“一条内部消息一个 block”。第一个多块消息出现后，当前归一化链上的 UUID 使用 `deriveUUID(parentUUID, index)` 稳定派生，避免重复处理时列表 key 改变。拆开的节点仍保留同一个上游 `message.id`，所以它们表示同一次模型响应的不同内容块，不表示模型调用了多次。

准备下一次 API 请求时，方向反过来。`normalizeMessagesForAPI()` 先调整 attachment，删除 `isVirtual` 的展示消息，过滤 `progress` 和大多数 `system` 消息；`local_command` 是例外，它被转换为 user message，让模型能引用本地命令输出。连续 user message 会合并。遇到 assistant 时，函数向后寻找相同 `message.id` 的片段并调用 `mergeAssistantMessages()`，即使中间夹着 tool result 或其他响应的 assistant block，也能把同一次响应重新组装。这里的 `message.id` 是 API 响应身份，职责是重组 wire history。

工具调用使用另一条关联边。assistant 的 `tool_use.id` 原样进入 `tool_result.tool_use_id`，回答“这份结果属于哪个调用”。`StreamingToolExecutor` 创建结果 user message 时还写入 `sourceToolAssistantUUID: assistantMessage.uuid`。落盘的 `insertMessageChain()` 遇到这个字段，会让结果节点的 `parentUuid` 指向产生该调用的 assistant 节点，而不是简单指向前一条写入记录。前者维护 API 工具配对，后者维护本地历史图；并行工具结果即使完成顺序交错，也不应靠相邻位置猜归属。

JSONL 历史又有自己的筛选边界。`isTranscriptMessage()` 只接受 `user`、`assistant`、`attachment`、`system`。`progress` 是临时 UI 状态，不落盘，也不参与 `parentUuid` 链；源码还保留旧 transcript 的 progress bridge，避免历史链在兼容读取时被截断。compact boundary 则把物理 `parentUuid` 置为 `null`，同时把压缩前的父节点写进可选 `logicalParentUuid`。这样磁盘上可以从新根恢复，仍保留“压缩前逻辑上接在哪”的说明。

SDK 投影不是 transcript 的简单转储。`normalizeMessage()` 会为 assistant 和 user 事件携带 `session_id`、内部 `uuid`；顶层消息的 `parent_tool_use_id` 为 `null`。子 Agent progress 内嵌的 user/assistant message 则使用 `parentToolUseID`。Bash/PowerShell progress 被映射为独立的 `tool_progress`，带 `tool_use_id`、工具名、运行时间和父工具 ID；它只在 `CLAUDE_CODE_REMOTE` 为真或存在 `CLAUDE_CODE_CONTAINER_ID` 时发出，以 `parentToolUseID` 为键至少间隔 30 秒，跟踪表最多保留 100 项。因此“模型看到了什么”“SDK 实时发出了什么”“磁盘恢复保存了什么”是三个有交集但不相等的集合。

固定窗口中各身份字段的职责可以压缩成四句话：数组位置只给当前投影排序；`message.id` 合并同一次 API 响应；`tool_use_id` 配对工具调用和结果；`uuid/parentUuid` 构造本地可恢复历史。`promptId`、`sessionId` 与 `parentToolUseID` 又分别连接用户提示、会话和嵌套工具。用一个通用 `id` 覆盖这些关系，会在并行调用、content block 拆分和 compact 后恢复时丢失因果信息。

## Codex CLI

![Codex CLI 把 ResponseItem、TurnItem、EventMsg 和 RolloutItem 分成四种投影](/images/posts/claude-code-source-reading-07/agent-theme-07-codex-cli-handdrawn.png)

*模型历史、客户端展示、运行时事件与磁盘记录共享部分身份字段，但没有共用一个封闭消息枚举。*

Codex CLI 固定提交 `c6dee5f` 的模型历史中心是 `ResponseItem`。`Message` 保存可选 `id`、`role`、`content`、可选 `phase` 和内部 metadata；`Reasoning` 独立保存 summary、可选 content 与 encrypted content。工具相关变体不是统一的一个 ToolMessage，而是 `FunctionCall`、`FunctionCallOutput`、`CustomToolCall`、`CustomToolCallOutput`、`ToolSearchCall`、`ToolSearchOutput` 等不同 item。

`ResponseItem::FunctionCall` 的 `arguments` 明确保留 Responses API 给出的原始 JSON 字符串，解析发生在后续工具处理。它的 `call_id: String` 必填；对应 `FunctionCallOutput` 也有必填 `call_id`，`output` 使用 `FunctionCallOutputPayload`，在 wire 上可以是纯字符串，也可以是结构化 content items。custom tool call/output 使用同一配对原则。可选 `id: Option<ResponseItemId>` 标识 item 自身，`call_id` 标识调用—结果关系；两者不能互换。

客户端不需要直接理解所有原始 `ResponseItem`，所以 Codex 还有 `TurnItem`。固定提交可见 `UserMessage`、`AgentMessage`、`Reasoning`、`CommandExecution`、`DynamicToolCall`、`CollabAgentToolCall`、`FileChange`、`McpToolCall`、`ContextCompaction` 等展示/交互条目。`ItemStartedEvent` 与 `ItemCompletedEvent` 都携带 `thread_id`、`turn_id` 和一个 `TurnItem`；started 必填 `started_at_ms`，completed 的 `started_at_ms` 是可缺省的 `Option<i64>`，`completed_at_ms` 必填，但旧 rollout 缺失时反序列化默认成 `0`。它们描述一个客户端条目的生命周期，不是模型上下文里的新增对话 role。

更外层的 `EventMsg` 承担线程协议。它既有 `TurnStarted`、`TurnComplete`、`TurnAborted`，也有 `AgentMessage`、`UserMessage`、`TokenCount`、`ItemStarted`、`ItemCompleted`、审批请求、命令输出 delta、MCP 生命周期和 Hook 生命周期。`Event { id, msg }` 的 `id` 关联一次 submission，事件内部的 `thread_id/turn_id/item.id/call_id` 仍维持各自作用域。消费端需要先按 `EventMsg.type` 分流，再使用对应身份字段关联，不能把 Event envelope 的 `id` 当作工具调用 ID。

模型历史写入和协议事件发送也是两条路径。`record_conversation_items()` 会准备 `ResponseItem`，写入 session history，再把它们包装为 `RolloutItem::ResponseItem` 交给持久化，最后发送 raw response item。UI 的 item lifecycle 则由 response item finalization 和事件映射产出 `TurnItem`/`EventMsg`。这解释了为何一个 function call 既可能在 rollout 里作为原始 response item 出现，也可能在客户端表现为 command execution 或 MCP tool call；它们是同一动作的不同投影，不是重复执行。

`RolloutItem` 是持久化封套，可装 `SessionMeta`、`ResponseItem`、`Compacted`、`TurnContext`、`WorldState`、`SecurityRiskScore` 与 `EventMsg`。但“能装”不等于“必写”。`rollout/src/policy.rs` 对 `ResponseItem` 和 `EventMsg` 分别筛选；例如 function call/output 属于可持久化 response item，而 `ItemStarted` 永远是瞬时事件。`ThreadHistoryMode` 只有 wire 值 `legacy` 与 `paginated`，默认是 `legacy`：paginated 会保存所有 `ItemCompleted`，legacy 只保存 `Plan` 或 `Extension(Sleep)` 的 `ItemCompleted`，其他旧式客户端事实由对应 legacy 事件记录。

因此解析 Codex rollout 时，可靠规则是先读顶层 `RolloutItem` 类别，再读 payload 的 discriminator，最后按 `call_id`、item `id`、`turn_id` 或 submission `id` 连接对应关系。相邻两行不构成因果保证：token、reasoning、状态事件和其他工具调用可以插在 call 与 output 之间。`call_id` 能证明一份 output 回答哪个 call，却不能单独证明后续哪个模型决定只由这份 output 导致。

## Pi

![Pi 用 Message、AssistantMessageEvent 与 AgentEvent 分开表示历史、流式块和生命周期](/images/posts/claude-code-source-reading-07/agent-theme-07-pi-handdrawn.png)

*Provider 适配器先统一流式形状，Agent 再把完成消息和实时事件交给不同消费者。*

Pi 固定提交 `9d2ec7f` 的 provider-neutral `Message` 是三个接口的联合：`UserMessage`、`AssistantMessage`、`ToolResultMessage`。它们分别用 `role: 'user'`、`'assistant'`、`'toolResult'` 判别。user content 可以是字符串或 text/image block；assistant content 可以包含 text、thinking 与 `ToolCall`；tool result 则独立保存 `toolCallId`、`toolName`、text/image content、`isError` 和时间戳。

`ToolResultMessage` 还有三个可选字段：`details` 是给日志或 UI 的结构化结果；`usage` 是工具本身的用量，不计入主 LLM context accounting；`addedToolNames` 记录从这个 transcript 点开始可用的新工具，供原生 deferred tool loading 的 provider 使用。它们可以缺省，所以发送下一次模型请求时真正不可丢的配对字段是 `toolCallId`。assistant 的 `ToolCall.id` 与结果的 `toolCallId` 形成调用关系，`toolName` 便于展示和 provider 转换，但不替代 ID。

流式阶段使用另一套 `AssistantMessageEvent`。一个正常流先发 `start`，然后按 `contentIndex` 发送 text、thinking 或 toolcall 的 start/delta/end，最后以 `done` 收束；`done.reason` 只允许 `stop`、`length`、`toolUse`、`deferred`。失败流使用 `error`，reason 只允许 `aborted` 或 `error`。`contentIndex` 关联同一 assistant message 中的流块，`ToolCall.id` 才关联之后的工具结果；索引和调用 ID 的生命周期不同。

Agent 层把这些 provider 事件包进更粗的 `AgentEvent`。核心联合分四组：`agent_start/agent_end`、`turn_start/turn_end`、`message_start/message_update/message_end`、`tool_execution_start/update/end`。`message_update` 只用于流式 assistant，并携带原始 `assistantMessageEvent`；user、assistant 完成消息与 toolResult 都会产生 message start/end。`turn_end` 同时携带本轮 assistant `message` 和按 transcript 顺序收集的 `toolResults`。

实时事件顺序和历史消息顺序可以不同。并行工具执行时，每个工具完成后即可发 `tool_execution_end`，消费者能实时更新对应 `toolCallId`；批次最终写回 `currentContext.messages` 的 `ToolResultMessage[]` 则按 assistant 源调用顺序构造。UI 若按完成时间渲染进度没有问题，下一次 provider 请求却必须获得稳定的 transcript 顺序。两种顺序服务不同消费者。

Pi 还允许应用扩展 `AgentMessage`。它的定义是标准 `Message` 加上通过 declaration merging 注入的 `CustomAgentMessages`。在每次 LLM 请求前，`streamAssistantResponse()` 先调用可选 `transformContext(messages, signal)`，用于在 AgentMessage 层裁剪或注入上下文；随后必调 `convertToLlm(messages)`，把自定义消息转换成 provider 能理解的 `Message[]`，或过滤 UI-only 消息。源码契约要求两个转换回调不要抛错，而要返回原消息或安全回退值。

这套边界意味着 Session/TUI 可以保存模型不认识的应用消息，只要宿主为它定义稳定转换。反过来，`AgentEvent` 也不应直接塞回模型历史：tool execution update 是进度事实，不是 tool result；message update 是未完成快照，不是新的 assistant turn。Pi 的最小内核没有把“持久化记录”“实时事件”“模型消息”压成同一个联合，而是让宿主明确选择怎样投影。

## DeepSeek Harness

![DeepSeek Harness 从不可变事件日志折叠 surface，再派生模型消息](/images/posts/claude-code-source-reading-07/agent-theme-07-deepseek-harness-handdrawn.png)

*日志保存发生过的事实，surface 决定当前模型看见哪些消息，`sourceEventSeqs` 记录投影来源。*

DeepSeek Harness 固定提交 `47f9438` 先定义一套 provider-neutral Message。每条消息都有稳定 `id`、`role`、`content` 与必填 `source`。核心 role 是 `system | user | assistant`；assistant source 必须是 `{ kind: 'model', provider, model, replayState? }`，工具结果虽然是 user role，source 必须是 `{ kind: 'tool', callId }`。普通用户、插件注入、模型和工具因此能用同一个消息接口，同时保留生产者身份。

content block 由可合并的 `ContentBlockMap` 产生。固定核心值是 `text`、`reasoning`、`image`、`tool-call`、`tool-result`。`ToolCallBlock` 保存 provider `CallId`、工具名和模型产出的原始 arguments 字符串；`ToolResultBlock` 保存 `toolCallId`、递归 content 和可选 `isError`。插件可以通过 interface merging 扩展消息来源、content block、finish reason 和 session event，所以消费者的 `switch` 需要为未知值保留回退，不能把固定核心列表写成永久封闭协议。

工具结果有意重复保存调用身份。`createToolResultMessage()` 同时写 `message.source.callId` 和唯一 `tool-result` block 的 `toolCallId`。Session seed/load 边界会验证结果消息必须是 user role、source kind 必须为 tool、content 必须恰有一个 tool-result block，并且两个 ID 相等。重复字段不是为了两个调用关系，而是让消息级来源与块级 provider 语义能够各自校验。

真正的事实源是 `SessionEventMap`。固定核心事件包括 `turn/start/end`、`step/start/end`、`user/message`、原始 `assistant/chunk`、组装后的 `assistant/message`、`tool/call`、`tool/result`、`todo/write`、`request/header`、`request/context` 与 `session/end-seed`。`Session.append()` 为事件分配连续 `seq` 和时间，验证 data 为无损 JSON，深冻结后追加，再同步通知观察者；持久化插件在热路径外异步缓冲。

事件日志比模型上下文更宽。只有 `user/message`、`assistant/message`、`tool/result` 三类是 `SurfaceEventType`，每次写入都必须声明 `surfaceOp`。`'append'` 把消息放到 surface 尾部；`{ op: 'replace', start, end }` 用一个新节点替换现有 surface 中从 start 到 end 的闭区间，压缩可以用它隐藏旧模型上下文。replacement 的 `sourceEventSeqs` 必须覆盖被遮蔽节点，且只能引用更早的 seq。该字段缺省表示事件没有记录已知来源；仅 `assistant/message` 可以显式写空数组，表示已知 provider stream 为空，其他 surface event 一旦提供该字段就必须是非空集合。

`deriveMessages()` 只遍历当前 surface 的 seq，并通过 `deriveEventMessage()` 投影消息。turn/step 边界、raw chunk、request header 和 todo 都返回 null；空 content 的 assistant/message 也返回 null，因为它可能只承载 max-tokens step 的 usage。surface 发生 replace 时缓存整体重建，普通 append 只投影新节点。返回数组是新快照，其中 Message 对象复用已深冻结的事件数据。

这里存在三条不能混用的关联边。`callId` 连接 `tool/call`、tool result source 和 `tool-result.toolCallId`；`sourceEventSeqs` 说明一个 assembled/replacement surface node 来自哪些早期事件；连续 `seq` 只给 session facts 排序。一个 assistant/message 可以引用生成它的多个 `assistant/chunk` seq，但这些 seq 不是工具调用 ID。一次压缩可以引用被替换的多个消息 seq，却不改变其中已有 callId 的语义。

append-only log 支持确定地重建“当时保存了哪些事件”和“当前 surface 会派生哪些模型消息”，但不承诺重新运行会得到相同模型输出或重复外部副作用。模型随机性、provider 状态、文件系统和网络都在日志之外。准确的工程收益是可验证的状态投影、恢复与审计边界，而不是把事件回放宣传成整个世界的精确复刻。
