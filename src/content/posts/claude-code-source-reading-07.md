---
title: "Claude Code源码解读07：对话、工具与内部事件如何关联"
published: 2026-07-22T16:00:00+08:00
description: "拆解 Claude Code 的消息外壳、内容块、工具调用 ID、UUID 链与 compact，解释对话、工具结果和内部事件如何关联。"
tags: ["claude-code", "source-code", "ai-agent", "message-model"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-07/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇的问题是：Claude Code 里的 `turn` 到底算什么？我发一句用户消息后，后续每次“工具调用 + 结果反馈”的往返都算一个新的 turn 吗？`maxTurns` 这个上限能不能手动设置？

先给结论：在 Claude Code 的语境里，`turn` 是“一个完整回合”——一次用户输入触发的模型输出结束。输出可以直接以文本收束，也可以包含若干 `tool_use`，等待工具结果后再进入下一次模型决策。每一组 `tool_use` + `tool_result` 回流都会开启下一条 `turn`；最终文本收束则产生最后一个 `turn`。`maxTurns` 主要约束这类工具驱动回合的续航。

`turn` 这里对应“完整模型决策周期”（query loop 的一个闭环）。`query loop` 可以理解为“收集输入→调用模型→触发工具→回写结果→下一次决策”的执行骨架。

能不能手动设置？可以。`print` 是 CLI 的交互模式（直接在终端输入并打印输出）；`agentic turns` 是模型连续走工具调用闭环的回合数（agentic 即具备“自动执行工具+决策”的能力）。官方 CLI 文档明确给出了 `--max-turns`：它控制 `print` 模式下的 agentic turns 数（默认无上限）并在到达上限后退出（`No limit by default`，`Exit with error when limit is reached`）。源码链路也能对齐验证：`main.tsx` 定义了 `--max-turns <turns>`，并把 `options.maxTurns` 传给 `runHeadless`；`runHeadless` 再把它交给查询引擎（`QueryEngine`）；`query.ts` 在准备进入下一次工具回环前检查 `nextTurnCount > maxTurns`，命中后发出 `max_turns_reached` 附件并返回 `reason: 'max_turns'`。`QueryEngine` 在本文里可理解为“围绕一轮 query 的调度中心”。

`Bedrock` 在这里是 AWS 提供的一条模型网关路径（provider 通道，即模型接入方）；它会影响一些 provider 侧的约束条件，但不改变本文提到的消息关系图主体。

再说一条边界：在 `query.ts` 里 `turnCount` 从 `1` 开始，`if (maxTurns && ...)` 的实现也意味着 `0` 在该判断中不会触发上限分支（这是源码可观察结果，不代表 CLI 层一定接收 0）。所以“能不能设值”要分成两层：官方参数允许你设置，但是否能接受负值/0，需要以具体入口做参数校验为准。

回答上面的 `turn` 问题后，先把本章会反复出现的字段定下来：

- `turn`：本章语境里对应一次“模型决策回合”，即用户触发一次推理/工具闭环到下一次停顿的完整周期。
- `query`：一次真正要发起“给模型提问或更新上下文”的动作。`QueryEngine` 里这个词常和 `loop`（执行循环）绑定。
- `query loop`：Claude Code 运行时的循环骨架，通常是：取上下文 → 发送给模型 → 处理回执（文本/工具）→ 再发起下一轮。
- `message`：Claude Code 内部事件对象。它至少有 `type`、`uuid`、`timestamp` 等字段，用来做本地可追踪历史。
- `role`：Claude API 里表示发言者身份（`user/assistant/system`）的字段，只是在标准 API 层约束角色关系。
- `type`：Claude Code 内部消息分类（`user/assistant/system/progress/attachment...`），决定走哪条展示和持久化路径。
- `content block`：Claude API 返回里的最小内容块（文本、工具调用、工具结果等）。
- `content_block_start/stop`：标记单个内容块的起始与结束；整条响应由 `message_start`、若干内容块和 `message_delta/message_stop` 共同界定。
- `stream`：内容“边生成边下发”的传输模式，和一次性返回（非流式）不同。
- `assistant`：一词有两层含义：API 角色（`role: 'assistant'`）和 Claude Code 的内部 `type: 'assistant'` 事件，不能混淆。
- `tool_use` / `tool_result`：一对“调用票据/结果回执”，分别表示“要执行什么动作”和“动作返回了什么”。
- `subtype`：`system` 消息的子分类，常见如 `compact_boundary`、`api_error`，决定是否上屏、是否发给模型或只给内部逻辑用。
- `transcript`：按 JSONL（每行一个 JSON）写入的会话归档，保存恢复上下文所需的结构化骨架；瞬时 UI 帧和 progress 通常留在运行时。
- `compact`：会话压缩操作，遇到上下文过长时写入 `compact_boundary`，让历史在恢复/展示时按新根重连。
- `resume`：基于 transcript 重建上下文并继续交互。
- `parentUuid` / `logicalParentUuid`：用于恢复链路时的父子关系；`logicalParentUuid` 在 compact 情况下保留“逻辑旧父”。
- `promptId`：追踪本轮用户输入来源上下文；省略时 transcript 仍按 `uuid/parentUuid` 建链，只缺少这层 prompt 关联。
- `sessionId`：会话生命周期中的唯一识别 ID，用于和恢复、归档关联。

核心问题是：内部 `user`、`assistant`、`system`、`progress`、`attachment` 与 `tool_use`/`tool_result` 怎样组成可追踪的对话？答案是四种标识各自维护一条关系：数组保顺序，`uuid` 串本地历史，模型响应 `id` 连接同一 API 响应，`tool_use_id` 配对动作与结果。

这几个 ID 分工不同（先给一个对照）：

- 每个内部消息外壳都有 `uuid`，它负责标识这条消息；落盘时再通过 `parentUuid` 串成可恢复的对话链。`parentUuid` 可以理解为“链上指向父节点的引用”。
- assistant 内部的 `message.id` 来自一次 Claude API 响应。同一响应拆出的 `text`、`thinking`、`tool_use` 块仍共享这个 ID，发送下一次 API 请求前会重新合并。
- `tool_use` 内容块自己的 `id`，会原样写进 `tool_result.tool_use_id`，它只回答“这份结果属于哪次工具调用”。
- `parentToolUseID`（对外是 `parent_tool_use_id`）表示一条 progress 或子 Agent 消息嵌套在哪次工具调用之下；顶层消息写为 `null`，让宿主将其渲染在根层级。
- `system` 的 `subtype` 区分 compact、api_error、local_command 等内部边界；`attachment` 携带要注入上下文的附加材料；`progress` 描述运行时执行过程，由 UI/SDK 消费。

因此，一段对话是一张带多种边的事件图：类型和 subtype 决定消息是否进入模型、UI、SDK 或磁盘，ID 则让不同投影仍能互相定位。本文只引用 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` 静态结构，不把还原路径当成 Anthropic 内部目录。

## 本章先建立三个概念

- **消息信封与内容块**：外层消息决定角色和去向，内容块表达文本、思考、工具调用等语义单元。

- **关联标识**：`uuid`、模型响应 ID 与 `tool_use_id` 分别连接历史、响应和工具调用。

- **事件投影**：运行时事件会按模型上下文、UI、SDK 与 transcript 的需求保留不同字段。

![消息信封、内容块与关联 ID](/images/posts/claude-code-source-reading-07/07-message-edges-detail-handdrawn.png)

这张图把三种关系分开：数组表示发生顺序，`uuid`/`parentUuid` 表示历史链，`tool_use_id` 表示一次工具调用与结果的配对。

## 同一个事故在消息里留下什么

用户输入固定任务：

> 请检查项目中的 YNM-9527：订单使用优惠券后，结算页显示 99.90 元，支付回调却记录为 9991 分；请查清原因、修复并运行测试。

用户消息只是一开始的入口；后面会出现 assistant 的 tool_use、工具返回的 tool_result、进度事件和上下文附件。它们都可能在界面上留下痕迹，但进入下一轮模型历史的内容并不完全相同。

上一章讲“继续还是结束”，本章拆开循环里流动的三层数据，看看谁负责模型历史，谁只负责 UI 和状态机。

## 先把“消息”拆成三层

最容易混淆的一点，是把内部 message、Claude API content block 和 Agent SDK event 当成同一种东西。

一句话对齐：

- `message` 是事件对象（含 type、uuid、timestamp、content 等字段）；
- `content block` 是 Claude API 一次响应里的最小内容单元（`text`、`tool_use`、`tool_result` 等）；
- `stream` 是“边生成边传输”模式的事件序列；
- `Agent SDK` 是 Claude Code 暴露给外部宿主的稳定事件契约；CLI 命令层是使用这份契约的一种宿主。

实际上，它们处在三层（SDK 事件 schema 是对外暴露给 CLI 插件/工具的“事件字段约定”）：

| 层级 | 典型判别字段 | 解决的问题 |
|---|---|---|
| Claude Code 内部消息 | `type: 'user' | 'assistant' | 'system' | 'progress' | 'attachment' ...` | Query loop、工具执行、UI 与会话状态怎样交换事件 |
| Claude API 内容块 | `text`、`thinking`、`tool_use`、`tool_result` 等 | 一次模型请求和响应里具体装了什么内容 |
| Agent SDK 消息 | `assistant`、`user`、`system`、`tool_progress`、`stream_event` 等 | 外部宿主能观察和控制哪些稳定事件 |

这里有一个关键细节：`tool_use` 和 `tool_result` 位于内容块层，而非 Claude Code 内部的顶层 message type。`tool_use` 装在 assistant 的 `message.content` 中，`tool_result` 装在 user 的 `message.content` 中。这是 Anthropic Messages API 的角色约定，也是工具结果再次送回模型的基础。

`assistant` 在本篇语境里其实是两个层面的概念：

1) Claude API 层的 `assistant`：这是模型返回的一次响应角色（`role: 'assistant'`），在 `message.content` 中可携带多个 block。
2) Claude Code 内部消息层的 `assistant`：这是源码里可落盘/可索引/可展示的事件节点；在流式处理中，通常会按 content block 把一次 API 响应切成多个内部节点。

这意味着：
- 「看到多条 `type: 'assistant'`」并不自动等于「模型多次发言」；
- `message.id` 说明这些节点是否来自同一次 API 响应；
- 内部 `uuid` 才说明它在本地消息图里的哪个节点。

若把范围限定在 `restored-src/src/QueryEngine.ts` 消费 query 输出的 switch，源码能够确认的顶层 `message.type` 还有 `stream_event`、`stream_request_start` 与 `tool_use_summary`。这份取值集合只覆盖该消费路径；其他功能开关可能引入额外类型。

`source map`（源码映射）把构建产物映射回源码位置；本文中的路径和符号来自还原结果，原始仓库目录仍属于证据范围之外。

![Claude Code 消息身份与关联关系手绘图](/images/posts/claude-code-source-reading-07/07-message-model-handdrawn.png)

图里可以看到两条不同的“父子关系”：`parentUuid` 串起磁盘上的会话链，`parentToolUseID` 则标记工具内部事件。它们名字相似，却不能互换。

## user 与 assistant：先有消息外壳，再有内容块

这里的 `user`/`assistant` 先说明两个层级：一层是“Claude Code 内部消息类型”，一层是“Claude API 的角色名”。后续若是“内部 ... 消息”会指前者；“role”语义时会指后者。

我们先看用户消息怎样创建。`restored-src/src/utils/messages.ts` 的 `createUserMessage()` 保留了最关键的默认值：

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

这是 `createUserMessage()` 返回对象的完整源码片段，函数签名中与主线无关的可选参数未展开。外层 `type: 'user'` 选择内部消息分支，内层 `role: 'user'` 满足 Messages API 角色约定；`content` 可以是字符串或 `ContentBlockParam[]`，空字符串回退到 `NO_CONTENT_MESSAGE`，防止发送空消息。`uuid` 未传或为空时生成随机 UUID，`timestamp` 省略时写入当前 ISO 时间。`sourceToolAssistantUUID` 在工具结果场景指向产生 `tool_use` 的 assistant 消息；`origin` 省略时走 human/keyboard 路径，其他候选取决于运行时 `MessageOrigin`。`mcpMeta` 携带 MCP 工具元信息；`isMeta`、`isVisibleInTranscriptOnly`、`isVirtual`、`isCompactSummary` 分别影响消息分类、可见性和压缩处理，`toolUseResult`、`imagePasteIds`、`permissionMode` 与 `summarizeMetadata` 供宿主、图片、权限和摘要路径消费，省略时对应分支不附加这些信息。

assistant 消息的外壳相似，但内部还套着一份完整的 Anthropic assistant message。流式路径会在每个 `content_block_stop` 时创建它，稍后再补写 `usage` 和 `stop_reason`。后面讨论部分流时会再回到这里。

`content_block_start` 建立一个内容块，`content_block_stop` 完成该块；整条响应的 token 统计和停止语义随后由 `usage` 与 `stop_reason` 补齐。

这也说明 `uuid` 与 `message.id` 为什么不能合并：前者标识 Claude Code 收到的一个内部消息片段，后者标识 Claude API 的一次 assistant 响应。

## content block 的切分规则：先按“流块”，再按“历史归一化”两层切

先说结论：`content block` 按 Claude API 的流式事件类型切分，字数和标点不参与边界判断。

第一层发生在 API 流解析阶段。`restored-src/src/services/api/claude.ts` 对每条流都按 `content_block_start -> content_block_delta -> content_block_stop` 走一遍：

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

这段说明了两个关键点：

- `index` 是块号，每个 index 对应一个累加 buffer；
- `tool_use.input`、`text.text`、`thinking.thinking` 在 start 时先初始化为空，再靠后续 `delta` 逐步拼；`thinking.signature` 也从空字符串开始，等待签名增量或最终块补齐；
- 任何块必须先 start，再 stop。`content_block_delta`/`content_block_stop` 找不到 `contentBlocks[part.index]` 时会直接报错，说明“切块”是严格按 start/stop 配对进行的，不能出现悬空块。

真正“出块”在 `content_block_stop` 阶段发生：

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

`normalizeContentFromAPI([contentBlock])` 总是接收单元素数组，因此流式层每次只产出一个完成块。`message` 继承 `partialMessage` 的响应 ID、角色、模型、usage 和 stop 字段，并把当前块写入 `content`；`requestId` 使用 `streamRequestId`，省略时不附加请求关联；`type: 'assistant'` 选择内部消息分支，`uuid` 为当前块生成节点标识，`timestamp` 记录完成时间。一个完整回复因此会出现多次 `yield`：文本、`thinking`、`tool_use` 各自在自己的 stop 时产出。

如果是非流式 fallback（404 或重试策略走普通请求），`claude.ts` 只收到一条 `result.content`，那一条 `AssistantMessage` 先把完整数组带进来，随后会经过第二层归一化再切。

第二层切分在 `restored-src/src/utils/messages.ts` 的 `normalizeMessages()`：

- 当 assistant 消息 `message.content.length > 1`，就把它拍平成多个 message，每个 message 只保留一个 `content` 块；
- `deriveUUID(message.uuid, index)` 用“父 uuid + 块序号”生成确定性 uuid，避免同一输入反复 normalize 时 `uuid` 抖动；
- 一旦某条消息触发了这种多块拆分，后续消息也会沿 `isNewChain` 进入衍生 uuid 模式，避免并行/交错场景下仍出现 key 冲突（这是源码注释里写的直接意图）。

对应源码注释也是直接的：

```ts
// Split messages, so each content block gets its own message
```

把两层拼起来就能复原直觉：

- 流式：块边界由 `content_block_stop` 决定；
- 归一化：单条 assistant 响应可能再次切成块消息；
- 发往模型前：`normalizeMessagesForAPI()` 会按 `message.id` 再把同一轮 assistant 片段合回去，避免模型看到重复上下文。

## 消息块一块一块来了，怎么“处理函数”接收？

可以把它理解成一个**事件流处理器**：先拿到 `query()` 产生的消息流，再按 `message.type` 分发。`QueryEngine.ts` 里的核心骨架就是这样的 `for await...` 循环（源码里每个 `assistant` 块会先落盘再交给下游）：

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

核心动作是 `normalizeMessage()`：`src/utils/queryHelpers.ts` 用它把每个内部消息映射到 SDK 可消费形态，并且对 `assistant`/`progress` 再调用一次 `normalizeMessages([...])`，所以“每个块”在这里被逐一转成可发送实体：

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

每次 `content_block_stop` 在上游产出一条 `AssistantMessage`，下游再经 `normalizeMessages` 按块投递。SDK 对象的 `type: 'assistant'` 决定事件类型，`message` 保存规范化后的 API 消息，`parent_tool_use_id: null` 把它放在顶层，`session_id` 关联当前会话，`uuid` 沿用内部块标识，`error` 透传可选错误信息。配套地，`user` 消息也走 `normalizeMessage(message)`，把 `isMeta`、`toolUseResult` 等上下文挂到 SDK user event；`progress` 则根据 `parentToolUseID` 映射到 `parent_tool_use_id`。

如果你要在自己的系统里接这个流，最小处理器可以是：

1. 遍历 `query()` 的异步迭代器；
2. `assistant / user` 消息直接 `normalizeMessage` 后 send；
3. `stream_event` 只关注 `message_start`（重置用量）、`message_delta`（补 stop_reason 与 usage），`message_stop`（累计总 token）；
4. 其他控制事件（如 `tombstone`）可按需 drop，不产出 UI 输出。

这样写的关键是：**块边界在上游已切好，但仍要保持 `message.id` 贯通**，否则“按块渲染”和“按轮次拼接”会分叉。

## 一次 assistant 响应为什么会变成多条内部消息

Claude 的一个响应可以同时包含 thinking、text 和多个 `tool_use`。UI 希望按块渲染，SDK 也希望逐块收到结果，因此 Claude Code 会把多内容块消息规范化成“一条消息一个 block”。

`restored-src/src/utils/messages.ts` 的 `normalizeMessages()` 展示了拆分规则：

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

`deriveUUID(parentUUID, index)` 根据父消息 UUID 和内容块下标生成稳定 UUID，`index` 从当前 `content` 数组的 0 开始。下面的 `case 'assistant'` 属于 `normalizeMessages(messages)`；assistant 有多个内容块时逐块拆分，同时保留展开后的 `message` 与共享 `message.id`。`timestamp` 沿用原消息时间，`content` 只保留当前块，`context_management` 省略时规范化为 `null`。`isMeta`、`isVirtual` 控制元消息和虚拟消息语义，`requestId` 保留网络请求关联，`error` 与 `isApiErrorMessage` 供错误路径识别，`advisorModel` 记录顾问模型来源；这些可选字段均原样透传。`uuid` 在拆分链上使用派生值，否则沿用原值。

稳定派生让同一份消息在重复 normalize 时仍能得到相同的 UI key。与此同时，共享的 `message.id` 让这些块仍然能被识别为同一次模型响应。

`UI key` 是前端列表渲染用的“稳定身份标识”；`normalizeMessagesForAPI()` 会把拆块后的同组 `message.id` 合回成一条请求中的 `assistant` 消息。

发送下一轮 API 请求前，方向正好相反。`normalizeMessagesForAPI()` 会向后寻找 `message.id` 相同的 assistant 片段，把内容块合回一条 assistant 消息。连续 user 消息也会合并，因为 Bedrock 不接受连续多个 user turn。

所以，“history 里有多条 assistant”不一定代表模型调用了多次。判断同一次响应，应看内部 `message.id`；判断 Claude Code 的消息节点，应看外层 `uuid`。

## tool_use 与 tool_result：靠同一个调用 ID 配对

上一章讲到 query loop 收到 `tool_use` 后会执行工具。消息模型在这里提供了一个非常简单的配对规则：

具体对应关系是 `assistant.content[].tool_use.id -> user.content[].tool_result.tool_use_id`。

`restored-src/src/services/tools/toolExecution.ts` 的未知工具错误分支把这条规则写得很直接：

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

这段代码位于工具执行入口的“找不到工具”分支。`toolUse.id` 是模型生成的开放字符串 ID，源码不限制其枚举值；它写入 `tool_result.tool_use_id` 后完成协议配对。`is_error: true` 表示错误结果；成功结果通常不设置该值或为 false，具体由工具的映射函数生成。`toolUseResult` 保存供宿主/UI 使用的结构化或原始结果，发给模型的内容则位于 `content`。`sourceToolAssistantUUID` 指向承载该 `tool_use` 的内部 assistant 消息，为落盘链提供另一层关联。

这里可把 `tool_use` 理解为“模型请求执行动作的票据”；`tool_result` 是“该票据的回执”。`tool_use` 即使内容块很小（例如参数 JSON），仍可对应一个后续执行动作。

正常成功、输入校验失败、权限拒绝、用户取消和工具抛错，最终都遵守同一个 `tool_use_id` 配对规则。错误不会通过“另起一条 system 消息”代替工具结果，因为模型下一轮仍需要看到每次工具请求都有对应结果。

源码甚至专门为缺失结果补洞。`restored-src/src/query.ts` 的 `yieldMissingToolResultBlocks()` 遍历尚未闭合的工具调用：

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

`yieldMissingToolResultBlocks(assistantMessages, errorMessage)` 为每个尚需收口的 `tool_use` 生成错误结果。内层 `content` 数组包含一个 `type: 'tool_result'` 块，`content` 写入开放错误文本，`is_error: true` 标记失败，`tool_use_id` 沿用请求 ID；外层 `toolUseResult` 给宿主保留同一错误摘要，`sourceToolAssistantUUID` 指向请求所在的 assistant 节点。函数只修复消息配对，已发生的外部副作用仍由具体工具负责。

这条边界很重要：消息层能够修复“对话里缺一块 tool result”，不能回滚工具已经写过的文件、发出的请求或启动的进程。

## progress 为什么有两个工具 ID

工具执行期间还会产生 progress。它是调用尚在推进时的运行时事件，最终完成状态仍由配对的 `tool_result` 表达。

`restored-src/src/utils/messages.ts` 的构造函数同时记录当前进度事件 ID 和父工具调用 ID：

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

`createProgressMessage()` 的 `toolUseID` 标识当前进度来源，`parentToolUseID` 指向正在执行的外层工具调用，二者都是必填开放字符串。`data` 是泛型 `Progress` 联合中的具体载荷；源码消费侧能确认 `agent_progress`、`skill_progress`、`bash_progress`、`powershell_progress` 和 `hook_progress` 等分支，功能开关及其他模块仍可能扩展该联合。返回对象的 `type: 'progress'` 选择运行时进度分支，`uuid` 为每条进度生成标识，`timestamp` 记录创建时间。

为什么不只保留一个 ID？因为一个 AgentTool 可以在内部继续产生 assistant、user 和工具进度。如果只看内部进度自己的 ID，宿主不知道该把它缩进到哪个外层工具卡片下。

其中 `agent` / `skill` 在此是运行时能力单位；`plugin`、`hook`（后文的 hook 指脚本钩子）也是外部动作入口类型。这里的 `parentToolUseID` 的核心目的是保持“哪一次工具调用触发了这条进度”的归属链。

`restored-src/src/utils/queryHelpers.ts` 的 `normalizeMessage()` 会把 `agent_progress` 或 `skill_progress` 中的内部消息映射成 SDK assistant/user，并把 `message.parentToolUseID` 写成 `parent_tool_use_id`。顶层 assistant/user 则固定写 `null`。

因此，`parent_tool_use_id: null` 明确表示顶层事件；字符串值把事件归入对应的父工具调用。

## attachment 与 system：运行时怎样注入上下文

Claude Code 还需要表达 IDE 选择、文件内容、hook 附加上下文、compact 边界、API 重试等事件。把它们伪装成普通 user 文本会丢失来源，也会让 UI 和持久化无法区别。

attachment 的外壳很薄。`restored-src/src/utils/attachments.ts` 中只有三个固定字段：

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

`createAttachmentMessage(attachment)` 接收 `Attachment` 联合类型的具体载荷。返回对象的 `attachment` 保存原载荷，`type: 'attachment'` 选择内部附件分支，`uuid` 生成消息标识，`timestamp` 记录创建时间。具体 attachment 的 `type` 由 `restored-src/src/utils/attachments.ts` 中的大型联合及功能开关决定，静态源码只能逐条确认实际路径。

attachment 进入 Claude API 前，会由 `normalizeAttachmentForAPI()` 转成一条或多条 user 消息，并在相邻 user 后合并。也就是说，它在内部 history 中仍保留“附件”身份，但在线路协议上最终要服从 Messages API 的 user/assistant 角色结构。

`history` 是参与下一次 `query` 的上下文缓存；`JSONL` 是行分隔 JSON 格式的持久化日志（每行一条对象），用于恢复与归档。

system 则依靠第二个判别字段 `subtype`。仅 `restored-src/src/utils/messages.ts` 的构造函数就能确认 `informational`、`permission_retry`、`bridge_status`、`scheduled_task_fire`、`stop_hook_summary`、`turn_duration`、`away_summary`、`memory_saved`、`agents_killed`、`api_metrics`、`local_command`、`compact_boundary`、`microcompact_boundary` 与 `api_error` 等值。

这些值会按消费者筛选。`normalizeMessagesForAPI()` 会过滤 progress 和绝大多数 system，仅把 `local_command` 变成 user 上下文；`QueryEngine` 对外只显式映射部分 system，例如 `compact_boundary` 和由 `api_error` 转换出的 `api_retry`。

## history 是面向不同消费者的消息投影

运行时里，`QueryEngine.mutableMessages` 会接收 user、assistant、progress、attachment 与部分 system。下一轮 query 可以基于它整理上下文，UI 也可以用它计算工具是否完成。

`mutableMessages` 可直接理解为“当前可改动的内存消息缓冲区”；`query` 这里指“给下一次模型请求准备上下文并执行一次推理/工具闭环”的动作。

但进入模型、进入 SDK 和写入磁盘是三次不同的投影：

| 去向 | 保留与转换 |
|---|---|
| Claude API | user/assistant 为主；attachment 转成 user；progress 与大多数 system 被过滤；同 ID assistant 和相邻 user 被合并 |
| Agent SDK | assistant/user 被规范化；嵌套 progress 可映射为带 `parent_tool_use_id` 的事件；部分 system 被重命名或过滤 |
| JSONL transcript | user、assistant、attachment、system 参与；progress 是临时 UI 状态，不再落盘 |

最后一条有直接源码依据。`restored-src/src/utils/sessionStorage.ts` 把 transcript 边界写成了显式类型守卫：

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

`isTranscriptMessage(entry)` 只接受 user、assistant、attachment 和 system。`isChainParticipant(m)` 明确排除 progress；参数只要求具有 `type` 字段。源码注释说明旧版本曾让 progress 参与 `parentUuid` 链，导致 resume 时真实消息被分叉成孤儿，因此当前版本把它作为临时 UI 状态处理。

这解释了一个看似反直觉的现象：运行时和 SDK 可以实时看到进度，但恢复会话只重放能够重建对话的持久化骨架，逐帧进度留在实时事件层。

## transcript 到底是什么

你可以把 `transcript` 理解成 Claude Code 的“会话数据库”。它的核心目的是：让中断后也能把“当前会话的历史链路”找回来。

源码里它体现为：

- `insertMessageChain()` 在落盘时，把 `Message` 折叠成 `TranscriptMessage`（带 `parentUuid / logicalParentUuid` 等关系字段）写入 JSONL；
- `isTranscriptMessage(entry)` 限定了可落盘的类型（`user/assistant/attachment/system`），所以 `progress` 常常不在 transcript；
- `loadConversationForResume()`（经由 `loadTranscriptFromFile`）读取 transcript，先按 `leafUuids` 取当前会话尾巴，再用 `buildConversationChain()` 逆向追溯到可用历史链。

所以它是“可恢复上下文”的单一事实源：完整到足以恢复对话关系，同时省略逐毫秒运行事件。

## 为什么要恢复链路（为何需要 `resume`）

最核心原因是：`mutableMessages` 在运行时是内存态，而会话可被中断（重启、`/resume`、崩溃恢复、手工切换会话）。如果不做链路恢复，下一次启动只能从“某个日志文件”读到一堆独立事件，无法知道应该从哪一条往前算历史上下文，也无法把并行 tool 调用和补洞记录重新拼成可喂给模型的顺序链。

这层恢复链路在源码里有明确职责：

- `loadConversationForResume` 是入口（`/resume`、`--resume`、`--continue` 最终都回到这里）；它先加载日志，再由 `deserializeMessagesWithInterruptDetection` 做消息形态修复（处理中断状态）。
- `loadTranscriptFromFile` 读取 JSONL 后，用 `findLatestMessage(... leafUuids ...)` 找到“当前会话尾巴（leaf）”，再调用 `buildConversationChain(…leafMessage)` 从尾巴沿 `parentUuid` 回溯到根。
  也就是说，恢复会从当前有效尾端重建一条可用链。
- `buildConversationChain` 之后有 `recoverOrphanedParallelToolResults` 修补：并行 `tool_use` 可能在单链 walk 时出现分支丢失；该后处理会按 `message.id` 把缺失的 sibling assistant 块和 `tool_result` 补回，保证完整的一次 API 轮次能在上下文里再现。
- `checkResumeConsistency` / `tengu_resume_consistency_delta` 用于检测“恢复前后上下文大小是否偏差”，防止恢复时丢消息或多加载消息导致历史窗口变形。

一句话总结：恢复链路把硬盘上的持久化事件还原成模型可理解、可继续对话、可继续路由到 SDK 的链式上下文。`progress` 通常留在实时层，`compact`/`snip` 则通过 `logicalParentUuid` 或 relink 逻辑维护可运行的恢复链；逐帧重放属于另一种数据目标。

## 落盘时，uuid 才变成 parentUuid 链

每条消息自己的 `uuid` 只能提供身份，不能表达顺序。`SessionStorage.insertMessageChain()` 写 JSONL 时，才为它补上 `parentUuid`。

`restored-src/src/utils/sessionStorage.ts` 的核心逻辑如下：

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

`parentUuid` 保存物理父节点，`logicalParentUuid` 在 compact boundary 上保留逻辑父节点；`isSidechain` 标记侧链/子会话来源。`teamName` 与 `agentName` 来自可选 `teamInfo`，用于团队消息归属；`promptId` 只给 user 消息关联当前 prompt。`agentId` 记录 Agent 身份，随后展开的原消息保留 `uuid`、内容和类型；`userType` 与 `entrypoint` 记录用户/宿主来源，`cwd` 是写入时目录，`sessionId` 关联会话，`version` 记录客户端版本，`gitBranch` 与 `slug` 保存项目和会话展示信息。

`startingParentUuid` 省略时从根节点开始。普通消息的 `parentUuid` 指向前一个参与链的消息；工具结果带 `sourceToolAssistantUUID` 时优先指向产生请求的 assistant UUID。compact boundary 把物理 `parentUuid` 置为 `null`，并把原父节点写入 `logicalParentUuid`；普通消息跳过这层逻辑父引用。

`compact` = 会话压缩边界；`logicalParentUuid` 是“逻辑上仍可追溯到旧父链”的备份。这里还有两个常见术语：`root`（链根）和 `leaf`（当前链尾，通常是最近写入消息）。

这里同时维护顺序链和工具来源，是为了处理一个 assistant 响应包含多个并行 `tool_use` 的情况。恢复时，`buildConversationChain()` 先沿单父链从 leaf 回到 root，再由 `recoverOrphanedParallelToolResults()` 根据共享 `message.id` 和工具结果的 parent 关系补回同组 assistant 片段及并行结果。

因此，JSONL 中的 `parentUuid` 表达逻辑父节点。并行工具、分叉、compact 和恢复都会让物理写入顺序与逻辑对话顺序出现差异。

`恢复（resume）` 是基于 transcript 重建链路；`分叉` 指并行 `tool_use` 返回后需要再归并到同一对话树；`orphan` 指临时出现未找到父节点的结果消息，源码会通过补洞/归并流程尽量修正。



从 2.1.88 还原源码可以直接确认：

- 内部消息的 `type` 在当前文件路径内用于职责分离，`system` 再用 `subtype` 细分边界语义；
- `uuid`、`message.id`、`tool_use.id`、`tool_result.tool_use_id`、`parentToolUseID`、`parentUuid` 的作用是不同的；
- 工具成功、失败、拒绝和取消都会形成对应 `tool_result`；
- progress 仍属于运行时状态，在当前实现里不作为 transcript 直接落盘节点。

## UI 怎样知道工具完成了

UI 不应该每渲染一个消息都从头扫描 history。`restored-src/src/utils/messages.ts` 的 `buildMessageLookups()` 会预先建立几张索引：

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

这是 `buildMessageLookups(normalizedMessages, messages)` 中建立结果索引的完整 user 分支，函数外壳及其他分支未展示。函数同时接收拆块后的消息和原始消息。源码在前文还创建 `toolUseByToolUseID` 保存请求块，当前片段用 `toolResultByToolUseID` 保存结果消息；`resolvedToolUseIDs` 标记已有结果的调用，`erroredToolUseIDs` 再区分 truthy 的 `content.is_error`。progress 在同一函数的另一分支使用 `parentToolUseID` 聚合到外层工具；函数还处理 sibling tool use（同一 assistant 回复中并列存在的多个工具调用的结果归并）、hook 计数（用于统计 hook 事件是否全部结束）和 server-side tool result（由模型外部服务返回的结果）。

这就是终端能够显示“工具正在执行”“已完成”或“失败”的原因。渲染层不需要猜测文本内容，只需查询以工具 ID 为键的索引。

源码还处理一种 UI 边界：较早的 `server_tool_use` 或 `mcp_tool_use` 到此仍未匹配结果时，会被标记为 resolved + errored，避免界面永远旋转；最后一条 assistant 消息可能仍在流式生成，因此暂时不作孤儿判断。

## 部分流与异常：消息什么时候才算完整

流式响应不能在第一个 token 到达时就假装 assistant 已经完成。`restored-src/src/services/api/claude.ts` 的顺序是：

1. `message_start` 保存响应外壳和初始 usage。
2. `content_block_start` 创建空的 text/thinking/tool input 容器。
3. `content_block_delta` 逐步追加文本、thinking 或 JSON 字符串。
4. `content_block_stop` 才创建并 yield 一条内部 assistant 消息。
5. `message_delta` 最后补写真实 usage 与 `stop_reason`。

源码在 `content_block_stop` 与 `message_delta` 的交界处这样处理：

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

`content_block_stop` 要求 `message_start` 已设置 `partialMessage`，并要求当前 `contentBlock` 存在，否则抛错。返回的 `message` 继承同一次 API 响应的 `partialMessage.id`，`content` 只放当前完成块；`requestId` 使用可选 `streamRequestId`，`type: 'assistant'` 选择消息分支，`uuid` 生成内部块标识，`timestamp` 记录完成时间。内部构建且 `research` 可用时才附加 `research`，`advisorModel` 为真值时才写入同名字段。随后 `message_delta` 更新 `usage` 与可为 `null` 的 `stop_reason`，非空停止原因到达后上层才能判断结束语义。

直接修改 `lastMsg.message` 是为了配合 transcript 写队列的引用语义。源码注释说明队列会延迟序列化并持有原对象；若用新对象替换，队列可能仍保存初始 `stop_reason: null` 和旧 usage。

如果流结束时从未收到 `message_start`，或有 `message_start` 却未形成任何完整 content block 且 stop reason 仍为空，源码会抛错并触发非流式 fallback，半条消息因此无法进入正常回答路径。网络真实重试次数、延迟和 provider 行为取决于运行配置，静态源码只能确认这些保护分支存在。

## compact 会主动改写“历史”的含义

长会话不能无限保留所有原文。compact 发生时，`system: compact_boundary` 既是一条可观察事件，也是新的历史根。

前面已经看到，落盘时它的 `parentUuid` 被置为 `null`，旧父节点保存在 `logicalParentUuid`。`QueryEngine` 收到带 metadata 的 compact boundary 后，还会释放 boundary 之前的 `mutableMessages`，只保留边界及之后消息，并向 SDK 产出 `system / compact_boundary`。

`compact_metadata.trigger` 在当前 SDK 事件 schema 中只有 `'manual'` 和 `'auto'`；`pre_tokens` 是压缩前 token 数。`preserved_segment` 可以为 `undefined`，存在时包含 `head_uuid`、`anchor_uuid` 和 `tail_uuid`，供恢复逻辑把保留片段接回摘要边界。`head_uuid`/`anchor_uuid`/`tail_uuid` 只是用于连接压缩段的历史锚点，不会出现在所有实现中。

这意味着 history 与当前模型上下文具有不同生命周期。同一条消息可能已经写入 transcript，却因 compact、`history snip`（为节省上下文而剪裁旧段）、虚拟消息过滤或 API 规范化而退出下一次模型请求。

## 小结

Claude Code 的对话通过多组关系键保持可追踪：不同 ID 分别表达响应归属、工具配对与 transcript 父子链。

内部 `uuid` 标识消息节点，落盘后的 `parentUuid` 把节点串成可恢复链；assistant 的 `message.id` 把流式拆开的内容块重新归到同一次模型响应；`tool_use.id` 与 `tool_result.tool_use_id` 闭合一次工具调用；`parentToolUseID` 把子 Agent 与执行进度挂到外层工具之下。

类型决定去向也同样重要。user、assistant、attachment 和 system 可以进入 transcript；progress 留在运行时；attachment 进入 API 前变成 user；绝大多数内部 system 会在 SDK 边界被映射或过滤。消息模型保存的是同一段执行在模型、宿主、UI 和恢复机制中的不同投影。

理解这些身份和过滤边界以后，下一篇将继续向下追踪这些消息从 Claude API 流式网络事件中组装出来的过程。

## 留给下一篇的问题

如果用户刚发完一条消息，却马上发现有问题并打断（例如按 `Esc`/`Ctrl+C`），这条消息还会出现在后面的对话里吗？

## 参考资料

- [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Advanced Claude Code 实践手册](https://media.licdn.com/dms/document/media/v2/D4E1FAQE9GrR1bPPyNQ/feedshare-document-pdf-analyzed/B4EZp.4We2KMAY-/0/1763065294861?e=1770854400&t=D8gaypHX1jhHDgxTXFEdEHVG9M64ImehhCdzEL1lZ4&v=beta)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)

- [流式 Messages API](https://docs.anthropic.com/en/api/messages-streaming)
