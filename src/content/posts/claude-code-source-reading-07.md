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

先给结论：在 Claude Code 的语境里，`turn` 是“一个完整回合”——一次用户输入触发的模型输出结束。这个输出里可以没有工具调用，也可以含若干 `tool_use`，然后等待工具结果再接下一次模型决策。也就是说，`tool_use` + `tool_result` 的每一条回流都会让你进入下一条 `turn`；而最终文本收束也会产生最后一个 `turn`。`maxTurns` 主要约束的是这类工具驱动回合的续航，而不是无限制地反复执行工具。

能不能手动设置？可以。官方 CLI 文档明确给出了 `--max-turns`：它控制 `print` 模式下的 agentic turns 数（默认无上限）并在到达上限后退出（`No limit by default`，`Exit with error when limit is reached`）。源码链路也能对齐验证：`main.tsx` 定义了 `--max-turns <turns>`，并把 `options.maxTurns` 传给 `runHeadless`；`runHeadless` 再把它交给查询引擎；`query.ts` 在准备进入下一次工具回环前检查 `nextTurnCount > maxTurns`，命中后发出 `max_turns_reached` 附件并返回 `reason: 'max_turns'`。

再说一条边界：在 `query.ts` 里 `turnCount` 从 `1` 开始，`if (maxTurns && ...)` 的实现也意味着 `0` 在该判断中不会触发上限分支（这是源码可观察结果，不代表 CLI 层一定接收 0）。所以“能不能设值”要分成两层：官方参数允许你设置，但是否能接受负值/0，需要以具体入口做参数校验为准。

有了这层时序边界，本文接着回答原问题：内部 `user`、`assistant`、`system`、`progress`、`attachment` 与 `tool_use`/`tool_result` 消息，怎样关联成一段可追踪的对话？**Claude Code 不是靠一个万能的“会话 ID”维持所有关系，而是同时使用消息顺序、消息 UUID、模型响应 ID 和工具调用 ID。**

这几个 ID 分工不同：

- 每个内部消息外壳都有 `uuid`，它负责标识这条消息；落盘时再通过 `parentUuid` 串成可恢复的对话链。
- assistant 内部的 `message.id` 来自一次 Claude API 响应。同一响应拆出的 text、thinking、`tool_use` 块仍共享这个 ID，发送下一次 API 请求前会重新合并。
- `tool_use` 内容块自己的 `id`，会原样写进 `tool_result.tool_use_id`，它只回答“这份结果属于哪次工具调用”。
- `parentToolUseID`（对外是 `parent_tool_use_id`）表示一条 progress 或子 Agent 消息嵌套在哪次工具调用之下；顶层消息通常是 `null`。
- `system` 的 `subtype` 区分 compact、API 重试、命令输出等内部边界；`attachment` 携带要注入上下文的附加材料；`progress` 只描述执行过程，不等于模型对话本身。

因此，一段对话更像一张带多种边的事件图，而不是简单的 `user -> assistant -> user` 数组。数组保存发生顺序，几组 ID 保存语义关系，类型和 subtype 决定一条消息应该进入模型、UI、SDK 还是磁盘。

本文继续以 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码为边界。文中路径均指向 `restored-src/`，它能证明这个版本的静态结构与调用关系，不代表 Anthropic 原始仓库的目录组织。

## 先把“消息”拆成三层

最容易混淆的一点，是把内部 message、Claude API content block 和 Agent SDK event 当成同一种东西。

实际上，它们处在三层：

| 层级 | 典型判别字段 | 解决的问题 |
|---|---|---|
| Claude Code 内部消息 | `type: 'user' | 'assistant' | 'system' | 'progress' | 'attachment' ...` | Query loop、工具执行、UI 与会话状态怎样交换事件 |
| Claude API 内容块 | `text`、`thinking`、`tool_use`、`tool_result` 等 | 一次模型请求和响应里具体装了什么内容 |
| Agent SDK 消息 | `assistant`、`user`、`system`、`tool_progress`、`stream_event` 等 | 外部宿主能观察和控制哪些稳定事件 |

这里有一个关键细节：`tool_use` 和 `tool_result` 不是 Claude Code 内部最外层的 message type。`tool_use` 装在 assistant 的 `message.content` 中；`tool_result` 装在 user 的 `message.content` 中。这是 Anthropic Messages API 的角色约定，也是后面工具结果再次送回模型的基础。

若把范围限定在 `restored-src/src/QueryEngine.ts` 消费 query 输出的 switch，源码能够确认的顶层 `message.type` 还有 `stream_event`、`stream_request_start` 与 `tool_use_summary`。这是一条具体消费路径上的取值集合，不等于仓库所有功能开关下的永久穷举。

![Claude Code 消息身份与关联关系手绘图](/images/posts/claude-code-source-reading-07/07-message-model-handdrawn.png)

图里可以看到两条不同的“父子关系”：`parentUuid` 串起磁盘上的会话链，`parentToolUseID` 则标记工具内部事件。它们名字相似，却不能互换。

## user 与 assistant：先有消息外壳，再有内容块

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

这是 `createUserMessage()` 返回对象的完整源码片段，函数签名中与主线无关的可选参数未展开。`content` 可以是字符串，也可以是 Anthropic `ContentBlockParam[]`；空字符串会回退到 `NO_CONTENT_MESSAGE`。`uuid` 未传或为空时生成随机 UUID，`timestamp` 为 `undefined` 时取当前 ISO 时间。`sourceToolAssistantUUID` 只在工具结果等场景使用，指向产生对应 `tool_use` 的 assistant 消息 UUID；普通键盘输入通常没有它。`origin` 也是可选值，源码注释明确 `undefined` 表示 human/keyboard，其他候选由 `MessageOrigin` 的运行时类型决定，而当前还原文件没有提供可安全穷举的定义。`isMeta`、`isVisibleInTranscriptOnly`、`isVirtual`、`isCompactSummary`、`toolUseResult`、`mcpMeta`、`imagePasteIds`、`permissionMode` 与 `summarizeMetadata` 均可为 `undefined`，对象会原样保留该值。

assistant 消息的外壳相似，但内部还套着一份完整的 Anthropic assistant message。流式路径会在每个 `content_block_stop` 时创建它，稍后再补写 usage 和 stop reason。后面讨论部分流时会再回到这里。

这也说明 `uuid` 与 `message.id` 为什么不能合并：前者标识 Claude Code 收到的一个内部消息片段，后者标识 Claude API 的一次 assistant 响应。

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

`deriveUUID(parentUUID, index)` 根据父消息 UUID 和内容块下标生成稳定的 UUID 形状字符串；`index` 从当前 `content` 数组的 0 开始。下面的 `case 'assistant'` 是 `normalizeMessages(messages)` 内的真实分支，函数外壳及 user、system、progress、attachment 分支未展示。`messages` 是内部消息数组；assistant 有多个内容块时逐块拆分，同时保留展开的 `message` 及其 `message.id`，并为拆出的块派生 UUID。`context_management` 为 `undefined` 时回退到 `null`，其他可选字段原样传递。

稳定派生而不是每次随机生成，有一个直接好处：同一份消息在重复 normalize 时仍能得到相同的 UI key。与此同时，共享的 `message.id` 让这些块仍然能被识别为同一次模型响应。

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

这段代码位于工具执行入口的“找不到工具”分支。`toolUse.id` 是模型生成的开放字符串 ID，源码不限制其枚举值；它写入 `tool_result.tool_use_id` 后完成协议配对。`is_error: true` 表示错误结果；成功结果通常不设置该值或为 false，具体由工具的映射函数生成。`toolUseResult` 保存供宿主/UI 使用的结构化或原始结果，不等于发给模型的 `content`。`sourceToolAssistantUUID` 指向承载该 `tool_use` 的内部 assistant 消息，为落盘链提供另一层关联。

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

`yieldMissingToolResultBlocks(assistantMessages, errorMessage)` 为每个尚需收口的 `tool_use` 生成错误 `tool_result`。`assistantMessages` 是当前 API 尝试已经产出的 assistant 片段；`errorMessage` 是调用方给出的原因，例如模型 fallback。函数不猜测工具是否产生了外部副作用，只保证消息协议不留下没有结果的调用。

这条边界很重要：消息层能够修复“对话里缺一块 tool result”，不能回滚工具已经写过的文件、发出的请求或启动的进程。

## progress 为什么有两个工具 ID

工具执行期间还会产生 progress。它不是 `tool_result`，也不表示这次调用已经结束。

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

`createProgressMessage()` 的 `toolUseID` 标识当前进度来源，`parentToolUseID` 指向正在执行的外层工具调用，二者都是必填开放字符串，没有 `undefined` 或默认值。`data` 是泛型 `Progress` 联合中的具体载荷；源码消费侧能确认的分支包括 `agent_progress`、`skill_progress`、`bash_progress`、`powershell_progress` 和 `hook_progress` 等，但功能开关及其他模块可能扩展该联合，本文不声称穷举全部运行时值。函数总会为 progress 自己生成新的 `uuid` 和时间戳。

为什么不只保留一个 ID？因为一个 AgentTool 可以在内部继续产生 assistant、user 和工具进度。如果只看内部进度自己的 ID，宿主不知道该把它缩进到哪个外层工具卡片下。

`restored-src/src/utils/queryHelpers.ts` 的 `normalizeMessage()` 会把 `agent_progress` 或 `skill_progress` 中的内部消息映射成 SDK assistant/user，并把 `message.parentToolUseID` 写成 `parent_tool_use_id`。顶层 assistant/user 则固定写 `null`。

因此，`parent_tool_use_id: null` 不是“关联信息丢失”，而是明确表示顶层事件。非 null 字符串才表示它属于某次父工具调用。

## attachment 与 system：有些上下文不是人说的，也不是模型说的

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

`createAttachmentMessage(attachment)` 接收 `Attachment` 联合类型的一个具体载荷，没有可选参数和默认值。外壳固定为 `type: 'attachment'`，并生成 UUID 与时间戳。具体 attachment 的 `type` 由 `restored-src/src/utils/attachments.ts` 中的大型联合及功能开关决定；静态源码可以逐个追踪某条路径，却不应把当前搜索到的字符串包装成永久公开协议。

attachment 进入 Claude API 前，会由 `normalizeAttachmentForAPI()` 转成一条或多条 user 消息，并在相邻 user 后合并。也就是说，它在内部 history 中仍保留“附件”身份，但在线路协议上最终要服从 Messages API 的 user/assistant 角色结构。

system 则依靠第二个判别字段 `subtype`。仅 `restored-src/src/utils/messages.ts` 的构造函数就能确认 `informational`、`permission_retry`、`bridge_status`、`scheduled_task_fire`、`stop_hook_summary`、`turn_duration`、`away_summary`、`memory_saved`、`agents_killed`、`api_metrics`、`local_command`、`compact_boundary`、`microcompact_boundary` 与 `api_error` 等值。

这些值不是都要发给模型或 SDK。`normalizeMessagesForAPI()` 会过滤 progress 和绝大多数 system，仅把 `local_command` 变成 user 上下文；`QueryEngine` 对外只显式映射部分 system，例如 `compact_boundary` 和由 `api_error` 转换出的 `api_retry`。所以看到内部存在某个 subtype，不能直接推断 SDK 用户一定能收到它。

## history 不是把所有事件原样塞进数组

运行时里，`QueryEngine.mutableMessages` 会接收 user、assistant、progress、attachment 与部分 system。下一轮 query 可以基于它整理上下文，UI 也可以用它计算工具是否完成。

但进入模型、进入 SDK 和写入磁盘是三次不同的投影：

| 去向 | 保留与转换 |
|---|---|
| Claude API | user/assistant 为主；attachment 转成 user；progress 与大多数 system 被过滤；同 ID assistant 和相邻 user 被合并 |
| Agent SDK | assistant/user 被规范化；嵌套 progress 可映射为带 `parent_tool_use_id` 的事件；部分 system 被重命名或过滤 |
| JSONL transcript | user、assistant、attachment、system 参与；progress 是临时 UI 状态，不再落盘 |

最后一条不是推断。`restored-src/src/utils/sessionStorage.ts` 把 transcript 边界写成了显式类型守卫：

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

这解释了一个看似反直觉的现象：运行时和 SDK 可以实时看到进度，但恢复会话时不保证重放每一帧进度。持久化保存的是能重建对话的骨架，不是完整事件录像。

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

`startingParentUuid` 为 `undefined` 时回退到 `null`，表示从根开始。普通消息的 `parentUuid` 指向前一个参与链的消息；工具结果若带 `sourceToolAssistantUUID`，则优先指向产生工具请求的 assistant UUID。compact boundary 是特殊断点：物理 `parentUuid` 设为 `null`，原先的父节点放进可选 `logicalParentUuid`。`logicalParentUuid` 在非 compact 消息上为 `undefined`。

这里同时维护顺序链和工具来源，是为了处理一个 assistant 响应包含多个并行 `tool_use` 的情况。恢复时，`buildConversationChain()` 先沿单父链从 leaf 回到 root，再由 `recoverOrphanedParallelToolResults()` 根据共享 `message.id` 和工具结果的 parent 关系补回同组 assistant 片段及并行结果。

因此，JSONL 中的 `parentUuid` 不是简单的“上一行 UUID”。并行工具、分叉、compact 和恢复都会让物理写入顺序与逻辑对话顺序出现差异。

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

这是 `buildMessageLookups(normalizedMessages, messages)` 中建立结果索引的完整 user 分支，函数外壳及其他分支未展示。函数同时接收拆块后的消息和原始消息。源码在前文还创建 `toolUseByToolUseID` 保存请求块，当前片段用 `toolResultByToolUseID` 保存结果消息；`resolvedToolUseIDs` 标记已有结果的调用，`erroredToolUseIDs` 再区分 truthy 的 `content.is_error`。progress 在同一函数的另一分支使用 `parentToolUseID` 聚合到外层工具；函数还处理 sibling tool use、hook 计数和 server-side tool result。

这就是终端能够显示“工具正在执行”“已完成”或“失败”的原因。渲染层不需要猜测文本内容，只需查询以工具 ID 为键的索引。

源码还处理一种 UI 边界：如果较早的 `server_tool_use` 或 `mcp_tool_use` 没有匹配结果，会把它标记为 resolved + errored，避免界面永远旋转；但最后一条 assistant 消息可能仍在流式生成，因此暂时不作孤儿判断。

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

`content_block_stop` 中的 `partialMessage` 必须已经由 `message_start` 设置，否则函数抛错；`contentBlock` 也必须存在。每个完成块获得新的内部 UUID，但继承同一次 API 响应的 `partialMessage.id`。`streamRequestId` 不存在时 `requestId` 为 `undefined`。`message_delta` 的 `stop_reason` 可能为 `null`，只有非空终止原因到达后，上层才能据此判断结束语义。

直接修改 `lastMsg.message` 不是随意写法。源码注释说明 transcript 写队列延迟序列化并持有对象引用；若用新对象替换，队列可能仍保存初始 `stop_reason: null` 和旧 usage。

如果流结束时从未收到 `message_start`，或有 `message_start` 却没有任何完整 content block 且没有 stop reason，源码会抛错并触发非流式 fallback，而不是把半条消息当成正常回答。网络真实重试次数、延迟和 provider 行为取决于运行配置，静态源码只能确认这些保护分支存在。

## compact 会主动改写“历史”的含义

长会话不能无限保留所有原文。compact 发生时，`system: compact_boundary` 既是一条可观察事件，也是新的历史根。

前面已经看到，落盘时它的 `parentUuid` 被置为 `null`，旧父节点保存在 `logicalParentUuid`。`QueryEngine` 收到带 metadata 的 compact boundary 后，还会释放 boundary 之前的 `mutableMessages`，只保留边界及之后消息，并向 SDK 产出 `system / compact_boundary`。

`compact_metadata.trigger` 在当前 SDK schema 中只有 `'manual'` 和 `'auto'`；`pre_tokens` 是压缩前 token 数。`preserved_segment` 可以为 `undefined`，存在时包含 `head_uuid`、`anchor_uuid` 和 `tail_uuid`，供恢复逻辑把保留片段接回摘要边界。

这意味着“进入 history”不等于“永远留在当前模型上下文”。同一条消息可能已经写入 transcript，却因 compact、history snip、虚拟消息过滤或 API 规范化而不再进入下一次模型请求。

## 小结

Claude Code 的对话可追踪，不是因为所有事件共享一个 ID，而是因为不同关系使用不同的键。

内部 `uuid` 标识消息节点，落盘后的 `parentUuid` 把节点串成可恢复链；assistant 的 `message.id` 把流式拆开的内容块重新归到同一次模型响应；`tool_use.id` 与 `tool_result.tool_use_id` 闭合一次工具调用；`parentToolUseID` 把子 Agent 与执行进度挂到外层工具之下。

类型决定去向也同样重要。user、assistant、attachment 和 system 可以进入 transcript；progress 留在运行时；attachment 进入 API 前变成 user；绝大多数内部 system 不会原样暴露给 SDK。消息模型保存的不是一份重复数据，而是同一段执行在模型、宿主、UI 和恢复机制中的不同投影。

理解这些身份和过滤边界以后，下一篇将继续向下追踪这些消息从 Claude API 流式网络事件中组装出来的过程。

## 留给下一篇的问题

这些内部消息在请求 Claude API 并接收流式响应时，怎样从网络事件转换而来？
