---
title: "Claude Code源码解读07：对话、工具与内部事件如何关联"
published: 2026-07-22T16:00:00+08:00
description: "拆解 Claude Code 的消息外壳、内容块、工具调用 ID、UUID 链与 compact，解释对话、工具结果和内部事件如何关联。"
tags: ["claude-code", "source-code", "ai-agent", "message-model"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-07/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-25
---
## 回答上一篇的问题

上一篇的问题是，Claude Code 里的 `turn` 到底算什么？我发一句用户消息后，后续每次“工具调用 + 结果反馈”的往返都算一个新的 turn 吗？`maxTurns` 这个上限能不能手动设置？

答案先放在前面，在 Claude Code 的语境里，`turn` 是“一个完整回合”，一次用户输入触发的模型输出结束。输出可以直接以文本收束，也可以包含若干 `tool_use`，等待工具结果后再进入下一次模型决策。每一组 `tool_use` + `tool_result` 回流都会开启下一条 `turn`；最终文本收束则产生最后一个 `turn`。`maxTurns` 主要约束这类工具驱动回合的续航。

`turn` 这里对应“完整模型决策周期”（query loop 的一个闭环）。`query loop` 可以理解为“收集输入→调用模型→触发工具→回写结果→下一次决策”的执行骨架。

能不能手动设置？可以。`print` 是 CLI 的交互模式（直接在终端输入并打印输出）；`agentic turns` 是模型连续走工具调用闭环的回合数（agentic 即具备“自动执行工具+决策”的能力）。官方 CLI 文档明确给出了 `--max-turns`，它控制 `print` 模式下的 agentic turns 数（默认无上限）并在到达上限后退出（`No limit by default`，`Exit with error when limit is reached`）。源码链路也能对齐验证，`main.tsx` 定义了 `--max-turns <turns>`，并把 `options.maxTurns` 传给 `runHeadless`；`runHeadless` 再把它交给查询引擎（`QueryEngine`）；`query.ts` 在准备进入下一次工具回环前检查 `nextTurnCount > maxTurns`，命中后发出 `max_turns_reached` 附件并返回 `reason: 'max_turns'`。`QueryEngine` 在本文里可理解为“围绕一轮 query 的调度中心”。

`Bedrock` 在这里是 AWS 提供的一条模型网关路径（provider 通道，即模型接入方）；它会影响一些 provider 侧的约束条件，但不改变本文提到的消息关系图主体。

再说一条边界，在 `query.ts` 里 `turnCount` 从 `1` 开始，`if (maxTurns && ...)` 的实现也意味着 `0` 在该判断中不会触发上限分支（这是源码可观察结果，不代表 CLI 层一定接收 0）。所以“能不能设值”要分成两层，官方参数允许你设置，但是否能接受负值/0，需要以具体入口做参数校验为准。

回答上面的 `turn` 问题后，先把本章会反复出现的字段定下来，

- `turn`，本章语境里对应一次“模型决策回合”，即用户触发一次推理/工具闭环到下一次停顿的完整周期。
- `query`，一次真正要发起“给模型提问或更新上下文”的动作。`QueryEngine` 里这个词常和 `loop`（执行循环）绑定。
- `query loop`，Claude Code 运行时的循环骨架，通常是，取上下文 → 发送给模型 → 处理回执（文本/工具）→ 再发起下一轮。
- `message`，Claude Code 内部事件对象。它至少有 `type`、`uuid`、`timestamp` 等字段，用来做本地可追踪历史。
- `role`，Claude API 里表示发言者身份（`user/assistant/system`）的字段，只是在标准 API 层约束角色关系。
- `type`，Claude Code 内部消息分类（`user/assistant/system/progress/attachment...`），决定走哪条展示和持久化路径。
- `content block`，Claude API 返回里的最小内容块（文本、工具调用、工具结果等）。
- `content_block_start/stop`，标记单个内容块的起始与结束；整条响应由 `message_start`、若干内容块和 `message_delta/message_stop` 共同界定。
- `stream`，内容“边生成边下发”的传输模式，和一次性返回（非流式）不同。
- `assistant`，一词有两层含义，API 角色（`role: 'assistant'`）和 Claude Code 的内部 `type: 'assistant'` 事件，不能混淆。
- `tool_use` / `tool_result`，一对“调用票据/结果回执”，分别表示“要执行什么动作”和“动作返回了什么”。
- `subtype`，`system` 消息的子分类，常见如 `compact_boundary`、`api_error`，决定是否上屏、是否发给模型或只给内部逻辑用。
- `transcript`，按 JSONL（每行一个 JSON）写入的会话归档，保存恢复上下文所需的结构化骨架；瞬时 UI 帧和 progress 通常留在运行时。
- `compact`，会话压缩操作，遇到上下文过长时写入 `compact_boundary`，让历史在恢复/展示时按新根重连。
- `resume`，基于 transcript 重建上下文并继续交互。
- `parentUuid` / `logicalParentUuid`，用于恢复链路时的父子关系；`logicalParentUuid` 在 compact 情况下保留“逻辑旧父”。
- `promptId`，追踪本轮用户输入来源上下文；省略时 transcript 仍按 `uuid/parentUuid` 建链，只缺少这层 prompt 关联。
- `sessionId`，会话生命周期中的唯一识别 ID，用于和恢复、归档关联。

核心问题是，内部 `user`、`assistant`、`system`、`progress`、`attachment` 与 `tool_use`/`tool_result` 怎样组成可追踪的对话？答案是四种标识各自维护一条关系，数组保顺序，`uuid` 串本地历史，模型响应 `id` 连接同一 API 响应，`tool_use_id` 配对动作与结果。

这几个 ID 分工不同（先给一个对照），

- 每个内部消息外壳都有 `uuid`，它负责标识这条消息；落盘时再通过 `parentUuid` 串成可恢复的对话链。`parentUuid` 可以理解为“链上指向父节点的引用”。
- assistant 内部的 `message.id` 来自一次 Claude API 响应。同一响应拆出的 `text`、`thinking`、`tool_use` 块仍共享这个 ID，发送下一次 API 请求前会重新合并。
- `tool_use` 内容块自己的 `id`，会原样写进 `tool_result.tool_use_id`，它只回答“这份结果属于哪次工具调用”。
- `parentToolUseID`（对外是 `parent_tool_use_id`）表示一条 progress 或子 Agent 消息嵌套在哪次工具调用之下；顶层消息写为 `null`，让宿主将其渲染在根层级。
- `system` 的 `subtype` 区分 compact、api_error、local_command 等内部边界；`attachment` 携带要注入上下文的附加材料；`progress` 描述运行时执行过程，由 UI/SDK 消费。

因此，一段对话是一张带多种边的事件图，类型和 subtype 决定消息是否进入模型、UI、SDK 或磁盘，ID 则让不同投影仍能互相定位。本文只引用 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` 静态结构，不把还原路径当成 Anthropic 内部目录。

## 介绍本章的一些概念

- 内部 `user`、`assistant`、`system`、`progress`、`attachment` 与 `tool_use`/`tool_result` 组成可追踪对话的**四种关系**，数组保顺序，`uuid` 串本地历史，模型响应 `id` 连接同一次 API 响应，`tool_use_id` 配对动作与结果。
- **消息信封与内容块是两层**，外层 `type` 决定去向（模型 / UI / SDK / 磁盘），内层 content block 表达文本、思考与工具调用等语义单元；`tool_use` 装在 assistant 的 `content` 里，`tool_result` 装在 user 的 `content` 里，二者都不是顶层 message type。
- content block 按 **Claude API 流式事件类型**切分，字数和标点不参与边界判断；流式块边界由 `content_block_stop` 决定，`normalizeMessages()` 再把多块响应按块拆分，发往模型前 `normalizeMessagesForAPI()` 又按 `message.id` 合回。
- **progress 是运行时临时状态，不落盘**，`isTranscriptMessage()` 只接受 `user/assistant/attachment/system` 四类进 transcript，progress 留在实时事件层。
- 落盘时 `uuid` 才变成 `parentUuid` 链；compact boundary 把物理 `parentUuid` 置为 `null`，旧父节点写入 `logicalParentUuid`，让恢复能按新根重连。

## 本篇新增机制

相对上一篇“agent-query-loop”（循环如何推进），本篇在心智模型中新增三块，

| 新增机制 | 解决的问题 | 关键符号 |
|---|---|---|
| 消息信封与内容块 | 外层决定角色和去向，内容块表达文本 / 思考 / 工具调用等语义单元 | `type`、`subtype`、`content` |
| 关联标识 | `uuid`、模型响应 `id`、`tool_use_id` 分别连接历史、响应与工具调用 | `uuid` / `message.id` / `tool_use_id` |
| 事件投影 | 运行时事件按模型上下文、UI、SDK 与 transcript 的需求保留不同字段 | `normalizeMessages` / `isTranscriptMessage` |

## 问题｜一次工具往返，消息之间靠什么互相定位

本篇的主线是建立消息的关联规则：角色说明谁产生内容，内容块说明发生了什么，`tool_use_id` 与 `sourceToolAssistantUUID` 把工具请求、结果和来源 assistant 消息重新连起来。只看消息文本会漏掉真正支撑恢复、并发和持久化的身份字段。

循环推进时，**消息之间靠什么互相定位？** 你只交给 Claude Code 一句简短要求，“读一下这段金额换算代码，核对回调字段，先别动生产”。它随后还会陆续产生 assistant 的 `tool_use`、工具返回的 `tool_result`、进度事件和上下文附件。Read 的结果可能进入下一轮模型历史，Spinner 的进度只留在 UI，权限拒绝需要作为合法的工具结果回填。它们都可能上屏，但进入下一轮模型历史的内容并不完全相同。

**本篇的答案，四种标识各维护一条关系，数组保顺序，`uuid` 串本地历史，模型响应 `id` 连接同一 API 响应，`tool_use_id` 配对动作与结果。** 类型决定去向，ID 决定归属。

## 正文

### 先把“消息”拆成三层

最容易混淆的一点，是把内部 message、Claude API content block 和 Agent SDK event 当成同一种东西。一句话对齐，

- `message` 是事件对象（含 `type`、`uuid`、`timestamp`、`content` 等字段）；
- `content block` 是 Claude API 一次响应里的最小内容单元（`text`、`tool_use`、`tool_result` 等）；
- `stream` 是“边生成边传输”模式的事件序列；
- `Agent SDK` 是 Claude Code 暴露给外部宿主的稳定事件契约；CLI 命令层是使用这份契约的一种宿主。

它们处在三层，

| 层级 | 典型判别字段 | 解决的问题 |
|---|---|---|
| Claude Code 内部消息 | `type: 'user' \| 'assistant' \| 'system' \| 'progress' \| 'attachment' ...` | Query loop、工具执行、UI 与会话状态怎样交换事件 |
| Claude API 内容块 | `text`、`thinking`、`tool_use`、`tool_result` 等 | 一次模型请求和响应里具体装了什么内容 |
| Agent SDK 消息 | `assistant`、`user`、`system`、`tool_progress`、`stream_event` 等 | 外部宿主能观察和控制哪些稳定事件 |

**Message type 联合对照表**（`src/types/` 与 `restored-src/src/QueryEngine.ts` 消费路径可确认的取值），

| `type` | 承担什么 | 判别字段 | 携带的内容 |
|---|---|---|---|
| `user` | 用户输入、工具结果回填 | 内层 `role: 'user'` | 字符串或 `ContentBlockParam[]`（text、tool_result） |
| `assistant` | 模型响应外壳，按块拆成多条 | 内层 `role: 'assistant'`、`message.id` | `text`、`thinking`、`tool_use` 块 |
| `system` | 内部边界事件 | `subtype`（`compact_boundary`、`api_error`、`local_command`...） | 边界元数据或错误信息 |
| `attachment` | 注入上下文的附加材料 | `attachment.type` 大型联合 | 文件、图片、memory 等载荷 |
| `progress` | 运行时执行进度，UI/SDK 消费 | `parentToolUseID` | `agent_progress`、`bash_progress` 等泛型载荷 |

此外，`QueryEngine.ts` 消费 query 输出的 switch 还能确认顶层 `type` 有 `stream_event`、`stream_request_start` 与 `tool_use_summary`；这份取值集合只覆盖该消费路径，其他功能开关可能引入额外类型。

这里有一个关键细节，**`tool_use` 和 `tool_result` 位于内容块层，而非 Claude Code 内部的顶层 message type。** `tool_use` 装在 assistant 的 `message.content` 中，`tool_result` 装在 user 的 `message.content` 中。这是 Anthropic Messages API 的角色约定，也是工具结果再次送回模型的基础。

`assistant` 在本篇语境里其实是两个层面的概念，Claude API 层的 `assistant`（模型返回的一次响应角色，`content` 中可携带多个 block）和 Claude Code 内部消息层的 `assistant`（可落盘 / 可索引 / 可展示的事件节点，流式处理中按 content block 把一次 API 响应切成多个内部节点）。这意味着“看到多条 `type: 'assistant'`”并不自动等于“模型多次发言”；`message.id` 说明这些节点是否来自同一次 API 响应，内部 `uuid` 才说明它在本地消息图里的哪个节点。

### user 与 assistant｜先有消息外壳，再有内容块

先看用户消息怎样创建。`restored-src/src/utils/messages.ts` 的 `createUserMessage()` 保留了最关键的默认值，

```ts
const m: UserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: content || NO_CONTENT_MESSAGE, // Make sure we don't send empty messages
    },
    isMeta,
    isVisibleInTranscriptOnly,
    isVirtual,
    isCompactSummary,
    summarizeMetadata,
    uuid: (uuid as UUID | undefined) || randomUUID(),
    timestamp: timestamp ?? new Date().toISOString(),
    toolUseResult,
    mcpMeta,
    imagePasteIds,
    sourceToolAssistantUUID,
    permissionMode,
    origin,
  }
return m
```

> 证据，`restored-src/src/utils/messages.ts`（2.1.88 source map 还原源码），`createUserMessage()` 返回对象完整片段，函数签名中与主线无关的可选参数未展开。

外层 `type: 'user'` 选择内部消息分支，内层 `role: 'user'` 满足 Messages API 角色约定；`content` 可以是字符串或 `ContentBlockParam[]`，空字符串回退到 `NO_CONTENT_MESSAGE`，防止发送空消息。`uuid` 未传或为空时生成随机 UUID，`timestamp` 省略时写入当前 ISO 时间。`sourceToolAssistantUUID` 在工具结果场景指向产生 `tool_use` 的 assistant 消息；`origin` 省略时走 human/keyboard 路径，其他候选取决于运行时 `MessageOrigin`。`mcpMeta` 携带 MCP 工具元信息；`isMeta`、`isVisibleInTranscriptOnly`、`isVirtual`、`isCompactSummary` 分别影响消息分类、可见性和压缩处理。

assistant 消息的外壳相似，但内部还套着一份完整的 Anthropic assistant message。流式路径会在每个 `content_block_stop` 时创建它，稍后再补写 `usage` 和 `stop_reason`。这也说明 `uuid` 与 `message.id` 为什么不能合并，前者标识 Claude Code 收到的一个内部消息片段，后者标识 Claude API 的一次 assistant 响应。

### content block 的切分规则｜先按“流块”，再按“历史归一化”两层切

**结论，`content block` 按 Claude API 的流式事件类型切分，字数和标点不参与边界判断。**

第一层发生在 API 流解析阶段。`restored-src/src/services/api/claude.ts` 对每条流都按 `content_block_start -> content_block_delta -> content_block_stop` 走一遍，

```ts
case 'content_block_start':
  switch (part.content_block.type) {
    case 'tool_use':
      contentBlocks[part.index] = { ...part.content_block, input: '' }
      break
    case 'text':
      contentBlocks[part.index] = { ...part.content_block, text: '' }
      break
    case 'thinking':
      contentBlocks[part.index] = {
        ...part.content_block,
        thinking: '',
        signature: '',
      }
      break
    default:
      contentBlocks[part.index] = { ...part.content_block }
  }
  break
```

> 证据，`restored-src/src/services/api/claude.ts`，`queryModel()` 流事件循环的 `content_block_start` 分支。

`index` 是块号，每个 index 对应一个累加 buffer；`tool_use.input`、`text.text`、`thinking.thinking` 在 start 时先初始化为空，再靠后续 `delta` 逐步拼；`thinking.signature` 也从空字符串开始。任何块必须先 start 再 stop，`content_block_delta`/`content_block_stop` 找不到 `contentBlocks[part.index]` 时会直接报错，说明“切块”是严格按 start/stop 配对进行的，不能出现悬空块。

真正“出块”在 `content_block_stop` 阶段发生，

```ts
case 'content_block_stop': {
  const m: AssistantMessage = {
    message: {
      ...partialMessage,
      content: normalizeContentFromAPI([contentBlock] as BetaContentBlock[], tools, options.agentId),
    },
    requestId: streamRequestId ?? undefined,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
  newMessages.push(m)
  yield m
}
```

> 证据，`restored-src/src/services/api/claude.ts`，`queryModel()` 的 `content_block_stop` 分支。

`normalizeContentFromAPI([contentBlock])` 总是接收单元素数组，因此流式层每次只产出一个完成块。`message` 继承 `partialMessage` 的响应 ID、角色、模型、usage 和 stop 字段，并把当前块写入 `content`；`requestId` 使用 `streamRequestId`，省略时不附加请求关联；`uuid` 为当前块生成节点标识。一个完整回复因此会出现多次 `yield`，文本、`thinking`、`tool_use` 各自在自己的 stop 时产出。

第二层切分在 `restored-src/src/utils/messages.ts` 的 `normalizeMessages()`，当 assistant 消息 `message.content.length > 1`，就把它拍平成多个 message，每个 message 只保留一个 `content` 块；`deriveUUID(message.uuid, index)` 用“父 uuid + 块序号”生成确定性 uuid，避免同一输入反复 normalize 时 `uuid` 抖动；一旦某条消息触发了多块拆分，后续消息也会沿 `isNewChain` 进入衍生 uuid 模式，避免并行/交错场景下出现 key 冲突。对应源码注释是直接的，

```ts
// Split messages, so each content block gets its own message
```

> 证据，`restored-src/src/utils/messages.ts`，`normalizeMessages()` 内联注释。

把两层拼起来，流式块边界由 `content_block_stop` 决定；归一化时单条 assistant 响应可能再次切成块消息；发往模型前，`normalizeMessagesForAPI()` 会按 `message.id` 再把同一轮 assistant 片段合回去，避免模型看到重复上下文。

### 消息块一块一块来了，怎么被“处理函数”接收

可以把它理解成一个**事件流处理器**，先拿到 `query()` 产生的消息流，再按 `message.type` 分发。`QueryEngine.ts` 里的核心骨架就是这样的 `for await...` 循环，

```ts
for await (const message of query(...)) {
  switch (message.type) {
    case 'assistant':
      yield* normalizeMessage(message)
      break
    case 'user':
      this.mutableMessages.push(message)
      yield* normalizeMessage(message)
      break
    case 'progress':
      yield* normalizeMessage(message)
      break
    case 'stream_event':
      // 处理 message_start / message_delta / message_stop
      break
  }
}
```

> 证据，`restored-src/src/QueryEngine.ts`，消费 `query()` 异步迭代器的消息分发骨架。

核心动作是 `normalizeMessage()`，`src/utils/queryHelpers.ts` 用它把每个内部消息映射到 SDK 可消费形态，并且对 `assistant`/`progress` 再调用一次 `normalizeMessages([...])`，所以“每个块”在这里被逐一转成可发送实体，

```ts
case 'assistant':
  for (const _ of normalizeMessages([message])) {
    if (!isNotEmptyMessage(_)) continue
    yield {
      type: 'assistant',
      message: _.message,
      parent_tool_use_id: null,
      session_id: getSessionId(),
      uuid: _.uuid,
      error: _.error,
    }
  }
```

> 证据，`restored-src/src/utils/queryHelpers.ts`，`normalizeMessage()` 的 assistant 分支。

SDK 对象的 `type: 'assistant'` 决定事件类型，`message` 保存规范化后的 API 消息，`parent_tool_use_id: null` 把它放在顶层，`session_id` 关联当前会话，`uuid` 沿用内部块标识，`error` 透传可选错误信息。配套地，`user` 消息把 `isMeta`、`toolUseResult` 等上下文挂到 SDK user event；`progress` 则根据 `parentToolUseID` 映射到 `parent_tool_use_id`。

如果你要在自己的系统里接这个流，最小处理器可以是，遍历 `query()` 的异步迭代器；`assistant / user` 消息直接 `normalizeMessage` 后 send；`stream_event` 只关注 `message_start`（重置用量）、`message_delta`（补 stop_reason 与 usage）、`message_stop`（累计总 token）；其他控制事件（如 `tombstone`）可按需 drop。关键是，**块边界在上游已切好，但仍要保持 `message.id` 贯通**，否则“按块渲染”和“按轮次拼接”会分叉。

### 一次 assistant 响应为什么会变成多条内部消息

Claude 的一个响应可以同时包含 thinking、text 和多个 `tool_use`。UI 希望按块渲染，SDK 也希望逐块收到结果，因此 Claude Code 会把多内容块消息规范化成“一条消息一个 block”。`restored-src/src/utils/messages.ts` 的 `normalizeMessages()` 展示了拆分规则，

```ts
export function deriveUUID(parentUUID: UUID, index: number): UUID {
  const hex = index.toString(16).padStart(12, '0')
  return `${parentUUID.slice(0, 24)}${hex}` as UUID
}

// ……省略 normalizeMessages() 的函数外壳与其他消息分支……
case 'assistant': {
  isNewChain = isNewChain || message.message.content.length > 1
  return message.message.content.map((_, index) => {
    const uuid = isNewChain
      ? deriveUUID(message.uuid, index)
      : message.uuid
    return {
      type: 'assistant' as const,
      timestamp: message.timestamp,
      message: {
        ...message.message,
        content: [_],
        context_management: message.message.context_management ?? null,
      },
      isMeta: message.isMeta,
      isVirtual: message.isVirtual,
      requestId: message.requestId,
      uuid,
      error: message.error,
      isApiErrorMessage: message.isApiErrorMessage,
      advisorModel: message.advisorModel,
    } as NormalizedAssistantMessage
  })
}
```

> 证据，`restored-src/src/utils/messages.ts`，`deriveUUID()` 与 `normalizeMessages()` 的 assistant 分支。

`deriveUUID(parentUUID, index)` 根据父消息 UUID 和内容块下标生成稳定 UUID，`index` 从当前 `content` 数组的 0 开始。assistant 有多个内容块时逐块拆分，同时保留展开后的 `message` 与共享 `message.id`；`context_management` 省略时规范化为 `null`，`error` 与 `isApiErrorMessage` 供错误路径识别，`advisorModel` 记录顾问模型来源，这些可选字段均原样透传。稳定派生让同一份消息在重复 normalize 时仍能得到相同的 UI key；共享的 `message.id` 让这些块仍然能被识别为同一次模型响应。

发送下一轮 API 请求前，方向正好相反，`normalizeMessagesForAPI()` 会向后寻找 `message.id` 相同的 assistant 片段，把内容块合回一条 assistant 消息；连续 user 消息也会合并，因为 Bedrock 不接受连续多个 user turn。所以，“history 里有多条 assistant”不一定代表模型调用了多次，判断同一次响应看内部 `message.id`，判断消息节点看外层 `uuid`。

### tool_use 与 tool_result｜靠同一个调用 ID 配对

具体对应关系是 `assistant.content[].tool_use.id -> user.content[].tool_result.tool_use_id`。`restored-src/src/services/tools/toolExecution.ts` 的未知工具错误分支把这条规则写得很直接，

```ts
yield {
  message: createUserMessage({
    content: [
      {
        type: 'tool_result',
        content: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ],
    toolUseResult: `Error: No such tool available: ${toolName}`,
    sourceToolAssistantUUID: assistantMessage.uuid,
  }),
}
```

> 证据，`restored-src/src/services/tools/toolExecution.ts`，`runToolUse()` 的“找不到工具”分支。

`toolUse.id` 是模型生成的开放字符串 ID，源码不限制其枚举值；它写入 `tool_result.tool_use_id` 后完成协议配对。`is_error: true` 表示错误结果；成功结果通常不设置该值或为 false，具体由工具的映射函数生成。`toolUseResult` 保存供宿主/UI 使用的结构化或原始结果，发给模型的内容位于 `content`；`sourceToolAssistantUUID` 指向承载该 `tool_use` 的内部 assistant 消息，为落盘链提供另一层关联。`tool_use` 可理解为“模型请求执行动作的票据”，`tool_result` 是“该票据的回执”。

正常成功、输入校验失败、权限拒绝、用户取消和工具抛错，最终都遵守同一个 `tool_use_id` 配对规则。错误不会通过“另起一条 system 消息”代替工具结果，因为模型下一轮仍需要看到每次工具请求都有对应结果。

源码甚至专门为缺失结果补洞。`restored-src/src/query.ts` 的 `yieldMissingToolResultBlocks()` 遍历尚未闭合的工具调用，

```ts
function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const assistantMessage of assistantMessages) {
    const toolUseBlocks = assistantMessage.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]

    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: errorMessage,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: errorMessage,
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
  }
}
```

> 证据，`restored-src/src/query.ts`，`yieldMissingToolResultBlocks()` 完整实现。

它为每个尚需收口的 `tool_use` 生成错误结果，`tool_use_id` 沿用请求 ID，`sourceToolAssistantUUID` 指向请求所在的 assistant 节点。函数只修复消息配对，**已发生的外部副作用仍由具体工具负责**，消息层能修复“对话里缺一块 tool result”，不能回滚工具已经写过的文件、发出的请求或启动的进程。

### progress 为什么有两个工具 ID

工具执行期间还会产生 progress。它是调用尚在推进时的运行时事件，最终完成状态仍由配对的 `tool_result` 表达。`restored-src/src/utils/messages.ts` 的构造函数同时记录当前进度事件 ID 和父工具调用 ID，

```ts
export function createProgressMessage<P extends Progress>({
  toolUseID,
  parentToolUseID,
  data,
}: {
  toolUseID: string
  parentToolUseID: string
  data: P
}): ProgressMessage<P> {
  return {
    type: 'progress',
    data,
    toolUseID,
    parentToolUseID,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}
```

> 证据，`restored-src/src/utils/messages.ts`，`createProgressMessage()` 完整实现。

`toolUseID` 标识当前进度来源，`parentToolUseID` 指向正在执行的外层工具调用，二者都是必填开放字符串。`data` 是泛型 `Progress` 联合中的具体载荷；源码消费侧能确认 `agent_progress`、`skill_progress`、`bash_progress`、`powershell_progress` 和 `hook_progress` 等分支，功能开关及其他模块仍可能扩展该联合。

为什么不只保留一个 ID？因为一个 AgentTool 可以在内部继续产生 assistant、user 和工具进度。如果只看内部进度自己的 ID，宿主不知道该把它缩进到哪个外层工具卡片下。`restored-src/src/utils/queryHelpers.ts` 的 `normalizeMessage()` 会把 `agent_progress` 或 `skill_progress` 中的内部消息映射成 SDK assistant/user，并把 `message.parentToolUseID` 写成 `parent_tool_use_id`；顶层 assistant/user 则固定写 `null`。因此，`parent_tool_use_id: null` 明确表示顶层事件，字符串值把事件归入对应的父工具调用。

### attachment 与 system｜运行时怎样注入上下文

attachment 的外壳很薄。`restored-src/src/utils/attachments.ts` 中只有三个固定字段，

```ts
export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage {
  return {
    attachment,
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}
```

> 证据，`restored-src/src/utils/attachments.ts`，`createAttachmentMessage()` 完整实现。

具体 attachment 的 `type` 由该文件中的大型联合及功能开关决定，静态源码只能逐条确认实际路径。attachment 进入 Claude API 前，会由 `normalizeAttachmentForAPI()` 转成一条或多条 user 消息，并在相邻 user 后合并，它在内部 history 中仍保留“附件”身份，但在线路协议上最终要服从 Messages API 的 user/assistant 角色结构。

system 则依靠第二个判别字段 `subtype`。仅 `restored-src/src/utils/messages.ts` 的构造函数就能确认 `informational`、`permission_retry`、`bridge_status`、`scheduled_task_fire`、`stop_hook_summary`、`turn_duration`、`away_summary`、`memory_saved`、`agents_killed`、`api_metrics`、`local_command`、`compact_boundary`、`microcompact_boundary` 与 `api_error` 等值。这些值会按消费者筛选，`normalizeMessagesForAPI()` 过滤 progress 和绝大多数 system，仅把 `local_command` 变成 user 上下文；`QueryEngine` 对外只显式映射部分 system，例如 `compact_boundary` 和由 `api_error` 转换出的 `api_retry`。

### 发给模型前，规范化到底做了什么

这里的“规范化”容易被误解成压缩上下文。它实际做的是，把运行时消息整理成 Claude Messages API 能接受的消息序列；真正负责减少历史 token 的，是后面的 snip、microcompact 和 compact。`normalizeMessagesForAPI()` 的第一步就把消息分成“模型需要知道的”和“宿主自己消费的”。

**第一类，`progress` 是执行中的状态，不是模型上下文。** 工具执行器收到 MCP 或其他工具的进度回调时，会调用 `createProgressMessage()`；Hook 运行前也会直接 yield 一条 `type: 'progress'` 消息。例如 Hook 进度的载荷可以是，

```ts
{
  type: 'progress',
  data: {
    type: 'hook_progress',
    hookEvent: 'PreToolUse',
    hookName: 'check.sh',
    command: './check.sh',
  },
  parentToolUseID,
  toolUseID,
  timestamp,
  uuid,
}
```

它服务于 Spinner、工具卡片和 SDK 的实时事件；进入 API 准备阶段时，过滤器直接排除 `type === 'progress'` 的消息。工具最终做了什么，仍由 `tool_use` 与配对的 `tool_result` 表达。

**第二类，`system` 不是一个统一的“发给模型”通道。** 例如 Stop Hook 出错时，`stopHooks.ts` 会创建一条 `informational` 系统消息，内容类似 `Stop hook failed: ...`，它用于向用户报告运行时状态；`normalizeMessagesForAPI()` 会把这类普通 system 消息过滤掉。另一方面，`subtype: 'local_command'` 的本地命令输入和输出需要让模型在后续回合中看见，于是规范化阶段把它转换成 `user` 消息，再与相邻的 user 消息合并。

**第三类，`isVirtual: true` 是 REPL 内部调用的显示投影。** REPL 模式下，模型看到的是外层 `REPL` 工具调用；REPL 内部实际执行的 `Read`、`Grep` 或 `Bash` 可以作为虚拟的 assistant/tool-use 与 user/tool-result 消息流过 UI，让界面展示真实的内部动作。`collapseReadSearch.ts` 的注释直接把这些称为“virtual messages”，而 `normalizeMessagesForAPI()` 会过滤带 `isVirtual` 的 user/assistant 消息，避免把同一层执行重复发送给模型。

随后才是结构整理：连续的 user 消息合并成一条；同一个 API 响应拆出的 assistant 片段按 `message.id` 合并；tool_use 的输入按当前工具 Schema 规范化，并在不支持 tool search 时去掉 `caller` 等扩展字段。最后还会清理孤立 thinking、尾部 thinking、只有空白的 assistant 消息，并校验图片大小。

因此，一次消息从运行时到模型大致经过三次投影：progress 留在实时事件层，普通 system 留在宿主层，virtual 消息留在 REPL/UI 层；只有通过格式整理和角色合并后的 user/assistant 内容才进入 API。这个边界也解释了为什么“界面上看到过”不等于“下一次请求会原样带上”。

### history 是面向不同消费者的消息投影

运行时里，`QueryEngine.mutableMessages` 会接收 user、assistant、progress、attachment 与部分 system；下一轮 query 可以基于它整理上下文，UI 也可以用它计算工具是否完成。但进入模型、进入 SDK 和写入磁盘是三次不同的投影，

| 去向 | 保留与转换 |
|---|---|
| Claude API | user/assistant 为主；attachment 转成 user；progress 与大多数 system 被过滤；同 ID assistant 和相邻 user 被合并 |
| Agent SDK | assistant/user 被规范化；嵌套 progress 可映射为带 `parent_tool_use_id` 的事件；部分 system 被重命名或过滤 |
| JSONL transcript | user、assistant、attachment、system 参与；progress 是临时 UI 状态，不再落盘 |

最后一条有直接源码依据。`restored-src/src/utils/sessionStorage.ts` 把 transcript 边界写成了显式类型守卫，

```ts
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}

export function isChainParticipant(m: Pick<Message, 'type'>): boolean {
  return m.type !== 'progress'
}
```

> 证据，`restored-src/src/utils/sessionStorage.ts`，`isTranscriptMessage()` 与 `isChainParticipant()` 完整实现。

源码注释说明旧版本曾让 progress 参与 `parentUuid` 链，导致 resume 时真实消息被分叉成孤儿，因此当前版本把它作为临时 UI 状态处理。这解释了一个看似反直觉的现象，运行时和 SDK 可以实时看到进度，但恢复会话只重放能够重建对话的持久化骨架。

### transcript｜把链路找回来的“会话数据库”

- `insertMessageChain()` 在落盘时，把 `Message` 折叠成 `TranscriptMessage`（带 `parentUuid / logicalParentUuid` 等关系字段）写入 JSONL；
- `isTranscriptMessage(entry)` 限定了可落盘的类型，所以 `progress` 常常不在 transcript；
- `loadConversationForResume()`（经由 `loadTranscriptFromFile`）读取 transcript，先按 `leafUuids` 取当前会话尾巴，再用 `buildConversationChain()` 逆向追溯到可用历史链。

恢复链路的职责在源码里很明确，`loadConversationForResume` 是入口（`/resume`、`--resume`、`--continue` 最终都回到这里），先加载日志，再由 `deserializeMessagesWithInterruptDetection` 做消息形态修复；`loadTranscriptFromFile` 用 `findLatestMessage(... leafUuids ...)` 找到“当前会话尾巴”，再调用 `buildConversationChain(…leafMessage)` 从尾巴沿 `parentUuid` 回溯到根。`buildConversationChain` 之后有 `recoverOrphanedParallelToolResults` 修补，并行 `tool_use` 可能在单链 walk 时出现分支丢失，该后处理会按 `message.id` 把缺失的 sibling assistant 块和 `tool_result` 补回。`checkResumeConsistency` / `tengu_resume_consistency_delta` 用于检测“恢复前后上下文大小是否偏差”。

一句话总结，恢复链路把硬盘上的持久化事件还原成模型可理解、可继续对话、可继续路由到 SDK 的链式上下文。

### 落盘时，uuid 才变成 parentUuid 链

每条消息自己的 `uuid` 只能提供身份，不能表达顺序。`SessionStorage.insertMessageChain()` 写 JSONL 时，才为它补上 `parentUuid`，

```ts
let parentUuid: UUID | null = startingParentUuid ?? null

// ……省略 session materialize、gitBranch、sessionId 与 slug 初始化……
for (const message of messages) {
  const isCompactBoundary = isCompactBoundaryMessage(message)
  let effectiveParentUuid = parentUuid

  if (
    message.type === 'user' &&
    'sourceToolAssistantUUID' in message &&
    message.sourceToolAssistantUUID
  ) {
    effectiveParentUuid = message.sourceToolAssistantUUID
  }

  const transcriptMessage: TranscriptMessage = {
    parentUuid: isCompactBoundary ? null : effectiveParentUuid,
    logicalParentUuid: isCompactBoundary ? parentUuid : undefined,
    isSidechain,
    teamName: teamInfo?.teamName,
    agentName: teamInfo?.agentName,
    promptId:
      message.type === 'user' ? (getPromptId() ?? undefined) : undefined,
    agentId,
    ...message,
    userType: getUserType(),
    entrypoint: getEntrypoint(),
    cwd: getCwd(),
    sessionId,
    version: VERSION,
    gitBranch,
    slug,
  }

  await this.appendEntry(transcriptMessage)
  if (isChainParticipant(message)) {
    parentUuid = message.uuid
  }
}
```

> 证据，`restored-src/src/utils/sessionStorage.ts`，`insertMessageChain()` 的核心循环。

`startingParentUuid` 省略时从根节点开始。普通消息的 `parentUuid` 指向前一个参与链的消息；工具结果带 `sourceToolAssistantUUID` 时优先指向产生请求的 assistant UUID。compact boundary 把物理 `parentUuid` 置为 `null`，并把原父节点写入 `logicalParentUuid`；普通消息跳过这层逻辑父引用。`isSidechain` 标记侧链/子会话来源，`promptId` 只给 user 消息关联当前 prompt，`sessionId`、`version`、`gitBranch`、`slug` 记录会话与项目展示信息。

这里同时维护顺序链和工具来源，是为了处理一个 assistant 响应包含多个并行 `tool_use` 的情况，恢复时 `buildConversationChain()` 先沿单父链从 leaf 回到 root，再由 `recoverOrphanedParallelToolResults()` 根据共享 `message.id` 和工具结果的 parent 关系补回同组 assistant 片段及并行结果。因此 JSONL 中的 `parentUuid` 表达逻辑父节点，并行工具、分叉、compact 和恢复都会让物理写入顺序与逻辑对话顺序出现差异。

### UI 怎样知道工具完成了

UI 不应该每渲染一个消息都从头扫描 history。`restored-src/src/utils/messages.ts` 的 `buildMessageLookups()` 会预先建立几张索引，

```ts
if (msg.type === 'user') {
  for (const content of msg.message.content) {
    if (content.type === 'tool_result') {
      toolResultByToolUseID.set(content.tool_use_id, msg)
      resolvedToolUseIDs.add(content.tool_use_id)
      if (content.is_error) {
        erroredToolUseIDs.add(content.tool_use_id)
      }
    }
  }
}
```

> 证据，`restored-src/src/utils/messages.ts`，`buildMessageLookups()` 建立结果索引的 user 分支。

源码在前文还创建 `toolUseByToolUseID` 保存请求块，当前片段用 `toolResultByToolUseID` 保存结果消息；`resolvedToolUseIDs` 标记已有结果的调用，`erroredToolUseIDs` 再区分 truthy 的 `content.is_error`。progress 在同一函数的另一分支使用 `parentToolUseID` 聚合到外层工具；函数还处理 sibling tool use（同一 assistant 回复中并列存在的多个工具调用的结果归并）、hook 计数和 server-side tool result。这就是终端能够显示“工具正在执行”“已完成”或“失败”的原因，渲染层只需查询以工具 ID 为键的索引。源码还处理一种 UI 边界，较早的 `server_tool_use` 或 `mcp_tool_use` 到此仍未匹配结果时，会被标记为 resolved + errored，避免界面永远旋转；最后一条 assistant 消息可能仍在流式生成，因此暂时不作孤儿判断。

### 部分流与异常｜消息什么时候才算完整

流式响应不能在第一个 token 到达时就假装 assistant 已经完成。`restored-src/src/services/api/claude.ts` 的顺序是，`message_start` 保存响应外壳和初始 usage → `content_block_start` 创建空的 text/thinking/tool input 容器 → `content_block_delta` 逐步追加 → `content_block_stop` 才创建并 yield 一条内部 assistant 消息 → `message_delta` 最后补写真实 usage 与 `stop_reason`。源码在 `content_block_stop` 与 `message_delta` 的交界处这样处理，

```ts
case 'content_block_stop': {
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
    ...(process.env.USER_TYPE === 'ant' &&
      research !== undefined && { research }),
    ...(advisorModel && { advisorModel }),
  }
  newMessages.push(m)
  yield m
  break
}
case 'message_delta': {
  // ……省略 usage 与 research 更新……
  stopReason = part.delta.stop_reason
  const lastMsg = newMessages.at(-1)
  if (lastMsg) {
    lastMsg.message.usage = usage
    lastMsg.message.stop_reason = stopReason
  }
  // ……省略 cost、refusal 与 max token 处理……
  break
}
```

> 证据，`restored-src/src/services/api/claude.ts`，`queryModel()` 的 `content_block_stop` 与 `message_delta` 分支。

`content_block_stop` 要求 `message_start` 已设置 `partialMessage`，并要求当前 `contentBlock` 存在，否则抛错。直接修改 `lastMsg.message` 是为了配合 transcript 写队列的引用语义，源码注释说明队列会延迟序列化并持有原对象；若用新对象替换，队列可能仍保存初始 `stop_reason: null` 和旧 usage。如果流结束时从未收到 `message_start`，或有 `message_start` 却未形成任何完整 content block 且 stop reason 仍为空，源码会抛错并触发非流式 fallback，半条消息因此无法进入正常回答路径。

### compact 会主动改写“历史”的含义

长会话不能无限保留所有原文。compact 发生时，`system: compact_boundary` 既是一条可观察事件，也是新的历史根。前面已经看到，落盘时它的 `parentUuid` 被置为 `null`，旧父节点保存在 `logicalParentUuid`。`QueryEngine` 收到带 metadata 的 compact boundary 后，还会释放 boundary 之前的 `mutableMessages`，只保留边界及之后消息，并向 SDK 产出 `system / compact_boundary`。

`compact_metadata.trigger` 在当前 SDK 事件 schema 中只有 `'manual'` 和 `'auto'`；`pre_tokens` 是压缩前 token 数。`preserved_segment` 可以为 `undefined`，存在时包含 `head_uuid`、`anchor_uuid` 和 `tail_uuid`，供恢复逻辑把保留片段接回摘要边界。这意味着 history 与当前模型上下文具有不同生命周期，同一条消息可能已经写入 transcript，却因 compact、`history snip`、虚拟消息过滤或 API 规范化而退出下一次模型请求。

### 小结

Claude Code 的对话通过多组关系键保持可追踪，内部 `uuid` 标识消息节点，落盘后的 `parentUuid` 把节点串成可恢复链；assistant 的 `message.id` 把流式拆开的内容块重新归到同一次模型响应；`tool_use.id` 与 `tool_result.tool_use_id` 闭合一次工具调用；`parentToolUseID` 把子 Agent 与执行进度挂到外层工具之下。

类型决定去向同样重要，user、assistant、attachment 和 system 可以进入 transcript；progress 留在运行时；attachment 进入 API 前变成 user；绝大多数内部 system 会在 SDK 边界被映射或过滤。消息模型保存的是同一段执行在模型、宿主、UI 和恢复机制中的不同投影。下一篇将沿这些消息向下追踪，它们如何从 Claude API 流式网络事件中组装出来。

## 源码映射

| 主题 | 关键文件（`restored-src/src/`） | 关键函数 / 符号 | 证据 |
|---|---|---|---|
| 消息信封 | `utils/messages.ts` | `createUserMessage()`、`createProgressMessage()`、`buildMessageLookups()`、`normalizeMessages()`、`deriveUUID()` | 源码已确认 |
| 流式出块 | `services/api/claude.ts` | `queryModel()` 的 `content_block_start / content_block_stop / message_delta` 分支 | 源码已确认 |
| 事件分发 | `QueryEngine.ts` | `for await (const message of query(...))` switch、`normalizeMessage()` | 源码已确认 |
| SDK 投影 | `utils/queryHelpers.ts` | `normalizeMessage()` 的 assistant/progress 分支 | 源码已确认 |
| 工具配对 | `services/tools/toolExecution.ts`、`query.ts` | 未知工具分支、`yieldMissingToolResultBlocks()` | 源码已确认 |
| 附件与投影 | `utils/attachments.ts`、`utils/sessionStorage.ts` | `createAttachmentMessage()`、`isTranscriptMessage()`、`isChainParticipant()`、`insertMessageChain()` | 源码已确认 |
| 恢复链路 | `utils/sessionStorage.ts`、`query.ts` | `loadConversationForResume()`、`buildConversationChain()`、`recoverOrphanedParallelToolResults()` | 调用关系确认 |

## 设计决策

**第一，类型决定去向，ID 决定归属。** 消息的 `type`/`subtype` 决定它是否进入模型、UI、SDK 或磁盘；`uuid`、`message.id`、`tool_use_id`、`parentUuid` 则让不同投影仍能互相定位。如果只用数组顺序表达关系，恢复、并行工具和 compact 都会把链打断。

**第二，工具结果必须闭合，错误也是一种结果。** 权限拒绝、取消、未知工具都以 `tool_result`（`is_error: true`）回填，而不是另起 system 消息，模型下一轮必须看到每次工具请求都有对应结果。消息层还能补洞（`yieldMissingToolResultBlocks`），但**不能回滚副作用**，这条边界防止消息层被误当成事务层。

**第三，progress 不入 transcript。** 旧版本曾让 progress 参与 `parentUuid` 链，导致 resume 时真实消息分叉成孤儿；把进度限定为实时 UI 状态，transcript 才能保持“可重建对话”的最小骨架。

**第四，compact 是历史语义的改写者。** `parentUuid` 置 null + `logicalParentUuid` 保留旧父，让压缩后的历史既能按新根重连，又能在需要时追溯逻辑旧父，同一份消息在实时、SDK 和磁盘上的生命周期可以不同。

## 练习｜把一次工具往返的消息关系画出来

不打开源码，用 10到15 分钟做下面这件事，

1. 用 `claude -p "读 README.md 并总结"` 走一遍，列出这条命令产生的**内部消息序列**（user → assistant(tool_use) → user(tool_result) → assistant(text)）。
2. 给每条消息标上它的四种身份，`uuid`、`message.id`（仅 assistant）、`tool_use.id` / `tool_use_id`、`parentUuid`（落盘后才有）。
3. 回答三个边界问题，progress 会出现在 transcript 里吗？assistant 的 `content` 里为什么可能同时有 `text` 和 `tool_use`？compact 之后 `logicalParentUuid` 存的是什么？
4. 对照 `isTranscriptMessage()` 的四个类型，检查你列的序列里哪些会落盘、哪些不会。

**预期产出**，一张标好四种 ID 的消息序列图；第 3 问的答案分别是，progress 不落盘（`isChainParticipant` 排除）、`content` 同时含 `text` 与 `tool_use` 是因为一次 API 响应可以拆出多个块（共享同一个 `message.id`）、`logicalParentUuid` 存的是 compact 之前的逻辑旧父节点。你可以用 `claude -p "读 README.md 并总结" --output-format stream-json 2>/dev/null` 的 `assistant` 事件核对 `message.id` 是否跨块相同。

## 自测

1. `tool_use` 和 `tool_result` 在消息模型里位于哪一层？靠什么字段配对？
2. 为什么“history 里有多条 `type: 'assistant'`”不一定代表模型多次发言？
3. progress 为什么不进入 transcript？旧实现因此出过什么问题？

<details>
<summary>参考答案</summary>

1. **位于内容块层**，不是顶层 message type，`tool_use` 装在 assistant 的 `message.content` 中，`tool_result` 装在 user 的 `message.content` 中。配对靠 `assistant.content[].tool_use.id` 写入 `tool_result.tool_use_id`。

2. **看 `message.id`**，流式路径会在每个 `content_block_stop` 产出一条内部 assistant 消息，同一 API 响应拆出的 text/thinking/tool_use 块共享同一个 `message.id`。判断“是否同一次模型响应”看 `message.id`，判断“本地消息图节点”看外层 `uuid`。

3. **progress 是临时 UI 状态**，`isTranscriptMessage()` 只接受 user/assistant/attachment/system；旧版本让 progress 参与 `parentUuid` 链，导致 resume 时真实消息被分叉成孤儿，因此当前版本把它留在实时事件层。

</details>

## 回顾｜上一篇的问题

<details>
<summary>回顾，Claude Code 里的 turn 到底算什么？maxTurns 能不能手动设置？（回答 06 留下的问题）</summary>

`turn` 是“一个完整回合”，一次用户输入触发的模型输出结束，可以文本收束，也可以含若干 `tool_use`，每组 `tool_use` + `tool_result` 回流都会开启下一条 `turn`。它对应 query loop 的一个闭环，收集输入→调用模型→触发工具→回写结果→下一次决策。

`maxTurns` 约束这类工具驱动回合的续航，且可手动设置，官方 CLI 文档给出 `--max-turns`，控制 print 模式 agentic turns 数（默认无上限），到达上限后退出。源码链路可对齐，`main.tsx` 定义 `--max-turns <turns>` 并传给 `runHeadless`，再交给 `QueryEngine`；`query.ts` 在进入下一次工具回环前检查 `nextTurnCount > maxTurns`，命中后发出 `max_turns_reached` 附件并返回 `reason: 'max_turns'`。

一条边界，`query.ts` 里 `turnCount` 从 `1` 开始，`if (maxTurns && ...)` 意味着 `0` 不会触发上限分支（源码可观察结果，不代表 CLI 层一定接收 0）；“能否设值”分两层，官方参数允许设置，能否接受负值或 0，以具体入口的参数校验为准。

</details>

## 留给下一篇的问题

如果用户刚发完一条消息，却马上发现有问题并打断（例如按 `Esc`/`Ctrl+C`），这条消息还会出现在后面的对话里吗？

## 相关链接

- **上一篇**，[06 代理循环如何持续推进](./06-agent-query-loop.md)
- **下一篇**，[08 Claude 请求与响应如何传输](./08-api-streaming.md)，这些消息如何从网络流中组装出来
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [流式 Messages API](https://docs.anthropic.com/en/api/messages-streaming)
