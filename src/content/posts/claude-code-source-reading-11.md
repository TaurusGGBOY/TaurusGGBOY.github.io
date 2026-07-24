---
title: "Claude Code源码解读11：一次调用如何从校验走到持久化"
published: 2026-07-24T16:46:58+08:00
updated: 2026-07-24T16:46:58+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-11/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：一个工具被选中以后，它如何依次经过输入校验、权限检查、实际调用、结果转换与持久化？

先说结论：这不是一次简单的 `tool.call(input)`，而是一条可以在多个位置提前结束的流水线。

模型返回的 `tool_use` 先由 `runToolUse` 查找工具。找到以后，`checkPermissionsAndCallTool` 先做 Zod 结构校验，再调用工具自己的 `validateInput` 做语义校验；随后运行 `PreToolUse` Hook，并把 Hook 的意见、权限规则和宿主响应收敛成权限决策。只有最终结果为 `allow`，程序才会越过副作用边界，真正调用 `tool.call`。

调用过程中产生的 progress 主要用于实时反馈；调用结束后，原始返回值会经过工具自己的映射函数变成 `tool_result`。结果过大时，正文会另存到 session 的 `tool-results/` 目录，消息中只保留路径和预览。最后，用户消息形式的 `tool_result` 随消息链写入 transcript JSONL。对于 Edit、Write 这类文件工具，文件历史备份、实际写盘和 `readFileState` 更新则发生在 `tool.call` 内部。

也就是说，这条链上至少有三种不同的“完成”：工具代码执行完成、模型可见结果构造完成、会话记录持久化完成。它们不是同一件事。

## 先画出一条工具执行流水线

本文仍然只讨论仓库中由 `@anthropic-ai/claude-code@2.1.88` source map 还原出的代码。。

为了把问题缩小，我们只跟踪一个已经出现在 assistant message 里的 `tool_use`。多个工具如何串并行调度，上一篇已经讨论过；这一篇关心的是单个调用进入执行器以后，每一扇门何时打开，何时会把调用拦下来。

![一次工具调用从 tool_use 走到副作用与持久化](/images/posts/claude-code-source-reading-11/11-tool-execution-lifecycle-handdrawn.png)

这张图最重要的不是箭头数量，而是中间那条 `SIDE EFFECT BOUNDARY`：

1. 工具查找、输入校验、PreToolUse 和权限决策都在边界左边；
2. `tool.call` 在边界右边，它可能读文件、写文件、执行命令或者请求网络；
3. progress、`tool_result`、transcript 和 file history 分属不同的数据通道，不能用“工具返回了”一概而论。

下面沿这条路径逐段看源码。为保持片段短小，代码块省略了遥测、日志和与当前结论无关的分支；省略处会明确写成 `// ...`，其余内容均来自 `restored-src/` 下的还原源码。

## 第一扇门：tool_use 只是请求，不是执行

模型返回的 `tool_use` 至少带有 `id`、`name` 和 `input`。其中 `id` 很关键：后面无论成功、拒绝还是异常，生成的 `tool_result.tool_use_id` 都要用它与这次请求配对。

执行入口是 `runToolUse`：

```ts
export async function* runToolUse(
  toolUse: ToolUseBlock,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  const toolName = toolUse.name
  let tool = findToolByName(toolUseContext.options.tools, toolName)

  if (!tool) {
    const fallbackTool = findToolByName(getAllBaseTools(), toolName)
    if (fallbackTool && fallbackTool.aliases?.includes(toolName)) {
      tool = fallbackTool
    }
  }

  // ... 未找到、取消和异常分支
  const toolInput = toolUse.input as { [key: string]: string }
  for await (const update of streamedCheckPermissionsAndCallTool(
    tool,
    toolUse.id,
    toolInput,
    toolUseContext,
    canUseTool,
    assistantMessage,
    assistantMessage.message.id,
    assistantMessage.requestId,
    mcpServerType,
    mcpServerBaseUrl,
  )) {
    yield update
  }
}
```

函数说明：`runToolUse` 位于 `restored-src/src/services/tools/toolExecution.ts`，它把一个 `ToolUseBlock` 接入单工具执行链，并以异步生成器形式持续产出消息更新。

参数说明：`toolUse` 是模型给出的调用块；`assistantMessage` 提供父消息 UUID、API message id 和可选的 `requestId`；`canUseTool` 是把权限请求交给当前宿主的回调；`toolUseContext` 汇集工具集合、取消信号、会话状态和权限上下文。`assistantMessage.requestId` 可以是 `undefined`，这只会让相关请求标识不进入日志，不会改变工具查找。`aliases` 也可以是 `undefined`；此时旧名称回退不成立。

这里有一个容易忽略的限制：它先在 `toolUseContext.options.tools` 中找，也就是当前运行上下文真正提供给模型的工具集合。只有找不到时，才会去基础工具池检查兼容别名，而且必须是 `aliases` 命中，不能借此绕过当前工具集合直接调用任意基础工具。

如果仍然找不到，程序会直接构造 `is_error: true` 的 `tool_result` 并返回。此时没有进入输入校验，更没有调用工具。

取消也有同样的边界。`abortController.signal.aborted` 在进入执行器前已经为 `true` 时，`runToolUse` 会返回 stop result。至于工具运行期间收到新输入是取消还是等待，则由工具可选的 `interruptBehavior()` 决定；源码可确认的返回值是 `'cancel'` 或 `'block'`，未实现、返回异常时都回退到 `'block'`。

## 第二扇门：结构正确，不等于语义可执行

工具找到以后，校验分两层。

第一层由工具的 `inputSchema` 完成。它回答的是“JSON 结构是否符合契约”，例如必填字段是否存在、字段类型是否正确、严格对象是否混入未知字段。

第二层是可选的 `validateInput`。它回答的是“这组值在当前上下文里是否合理”，例如路径、页码范围或工具自身约束是否成立。

```ts
const parsedInput = tool.inputSchema.safeParse(input)
if (!parsedInput.success) {
  // ... 生成 InputValidationError tool_result 并返回
}

const isValidCall = await tool.validateInput?.(
  parsedInput.data,
  toolUseContext,
)
if (isValidCall?.result === false) {
  // ... 构造 is_error: true 的 tool_result 后返回
}
```

函数说明：这段来自 `checkPermissionsAndCallTool`，位于 `restored-src/src/services/tools/toolExecution.ts`。它先使用 Zod `safeParse`，再调用工具可选的 `validateInput`，两层任意一层失败都会在权限检查之前结束。

参数说明：`input` 是模型生成的原始对象；`parsedInput.data` 是 Zod 解析后的值；`validateInput` 的第二个参数是完整 `ToolUseContext`。`validateInput` 可以不存在，此时可选链返回 `undefined`，程序继续执行；存在时结果只能是 `{ result: true }`，或者 `{ result: false, message, errorCode }`。只有显式的 `result === false` 才进入语义校验失败分支。

为什么不把这两层合成一层？因为它们解决的问题不同。

`inputSchema` 适合表达稳定、可序列化的契约，还能发送给模型。`validateInput` 则可以读取运行时上下文，执行异步检查。把文件是否存在、当前 cwd 或会话状态都塞进静态 Schema，不仅困难，也会混淆“参数长什么样”和“参数现在能不能用”。

更重要的是，两种失败都被转换成 `tool_result`，而不是让整个 query loop 因一个坏参数崩溃。模型看到错误以后，可以修正参数再次发起调用。

## PreToolUse：权限之前还有一层可编排入口

通过校验以后，执行器还不会立即检查权限。它先运行 `runPreToolUseHooks`。

```ts
for await (const result of runPreToolUseHooks(
  toolUseContext,
  tool,
  processedInput,
  toolUseID,
  assistantMessage.message.id,
  requestId,
  mcpServerType,
  mcpServerBaseUrl,
)) {
  switch (result.type) {
    case 'hookPermissionResult':
      hookPermissionResult = result.hookPermissionResult
      break
    case 'hookUpdatedInput':
      processedInput = result.updatedInput
      break
    case 'preventContinuation':
      shouldPreventContinuation = result.shouldPreventContinuation
      break
    case 'stop':
      // ... 生成 stop tool_result 并立即返回
  }
}
```

函数说明：`runPreToolUseHooks` 定义在 `restored-src/src/services/tools/toolHooks.ts`，调用点在 `checkPermissionsAndCallTool`。它是异步生成器，可以产出进度/附件消息、权限意见、更新后的输入、附加上下文以及停止信号。

参数说明：`processedInput` 是通过两层校验后的输入，但 Hook 仍可用 `hookUpdatedInput` 替换它；`toolUseID` 和 assistant message id 用来关联 Hook 与本次调用；`requestId`、`mcpServerType`、`mcpServerBaseUrl` 都可能是 `undefined`，因为普通本地工具不一定来自 MCP，某些调用也没有请求标识。`result.type` 的源码可见分支包括 `message`、`hookPermissionResult`、`hookUpdatedInput`、`preventContinuation`、`stopReason`、`additionalContext` 和 `stop`。

这段代码说明，Hook 不只是“运行一条脚本”。它可以影响三件不同的事：

- 观察调用，并产生 progress 或 attachment；
- 改写后续权限检查和实际调用使用的输入；
- 提供 `allow`、`ask`、`deny` 意见，或者直接停止执行。

但要注意，Hook 给出 `allow` 并不等于已经拿到最终执行权。`resolveHookPermissionDecision` 还会应用规则；deny 规则可以覆盖 Hook allow，ask 规则也可以强制进入宿主确认。这正是下一篇要继续拆解的部分。

## 权限结果只有 allow 才能越过副作用边界

PreToolUse 的意见最终交给 `resolveHookPermissionDecision`：

```ts
const resolved = await resolveHookPermissionDecision(
  hookPermissionResult,
  tool,
  processedInput,
  toolUseContext,
  canUseTool,
  assistantMessage,
  toolUseID,
)
const permissionDecision = resolved.decision
processedInput = resolved.input

if (permissionDecision.behavior !== 'allow') {
  // ... 生成 is_error: true 的 tool_result
  return resultingMessages
}
```

函数说明：`resolveHookPermissionDecision` 位于 `restored-src/src/services/tools/toolHooks.ts`；调用方随后用 `behavior !== 'allow'` 守住 `tool.call`。因此可以由源码直接确认：最终不是 allow，就不会进入这里的实际工具调用。

参数说明：`hookPermissionResult` 可以是 `undefined`，表示 Hook 没有给权限意见；它的 `behavior` 可选值是 `'allow'`、`'ask'`、`'deny'`。`canUseTool` 负责把需要交互的部分交给当前宿主。权限返回的 `updatedInput` 也可以是 `undefined`；只有它存在时，执行器才用它覆盖现有输入。`permissionDecision.message` 在不同拒绝来源下可能缺失，执行器会结合 PreToolUse 的 stop reason 生成回退错误信息。

这里必须区分 ask 的两个时刻。

Hook 或规则产生的 ask，表示需要把问题交给宿主；宿主处理以后，`canUseTool` 可能返回 allow 或 deny。如果最终决策仍不是 allow，当前执行函数就把它当作未获执行许可，生成错误结果并返回。。

到这一步为止，程序可以记录日志、运行 Hook、等待用户，但还没有调用具体工具。真正的副作用边界就在下一行。

## tool.call：从这里开始，世界可能已经改变

只有权限为 allow，才会执行 `tool.call`：

```ts
const result = await tool.call(
  callInput,
  {
    ...toolUseContext,
    toolUseId: toolUseID,
    userModified: permissionDecision.userModified ?? false,
  },
  canUseTool,
  assistantMessage,
  progress => {
    onToolProgress({
      toolUseID: progress.toolUseID,
      data: progress.data,
    })
  },
)
```

函数说明：`Tool.call` 的契约定义在 `restored-src/src/Tool.ts`，实际调用位于 `checkPermissionsAndCallTool`。它返回 `Promise<ToolResult<Output>>`；`ToolResult` 至少有 `data`，还可以带 `newMessages`、`contextModifier` 和 `mcpMeta`。

参数说明：第一个参数 `callInput` 是最终执行输入，可能来自模型，也可能被 Hook 或权限响应更新；第二个参数在原 `ToolUseContext` 上补入 `toolUseId` 和 `userModified`，其中 `userModified` 缺失时默认 `false`；第三个参数仍是 `canUseTool`，供需要嵌套授权的工具使用；第四个参数是父 assistant message；第五个 `onProgress` 在 Tool 接口中是可选参数。`newMessages`、`contextModifier` 和 `mcpMeta` 也都是可选值，缺失时相应后处理不会发生。

为什么把这一行叫副作用边界？因为接口本身并不承诺 `call` 是纯函数。Read 可以访问磁盘，Bash 可以创建进程，MCP 可以访问外部服务，Edit 和 Write 会修改文件。即使 `tool.call` 最后抛出异常，也不能反推出“什么都没发生”：外部命令可能已经输出了一半，文件工具也可能在后续步骤失败前完成过某些操作。

因此，执行器能统一错误消息，却不能替所有工具提供事务回滚。判断副作用是否完成，仍要看具体工具实现。

## progress 是过程消息，不是最终结果

`tool.call` 接收的 progress 回调最终进入 `onToolProgress`。外层 `streamedCheckPermissionsAndCallTool` 使用一个流，把这些更新在 Promise 完成前送出去。

这类消息主要服务于 UI 和流式宿主：长时间 Bash、Hook 或远程工具可以持续报告状态。

一次调用完全可能经历下面的顺序：

1. 已经发送若干 progress；
2. 工具随后抛出异常；
3. 执行器最终返回 `is_error: true` 的 `tool_result`。

所以恢复会话时，真正维持模型协议配对的是 `tool_use` 与 `tool_result`，不是最后一条 progress。源码中的 transcript 链接逻辑也不会把 progress 当作后续消息的 parent。

## 原始返回值如何变成 tool_result

工具成功返回的 `result.data` 不是直接塞回模型。每个工具必须用 `mapToolResultToToolResultBlockParam` 把自己的输出转换成 Anthropic API 能识别的 `ToolResultBlockParam`。

```ts
const mappedToolResultBlock =
  tool.mapToolResultToToolResultBlockParam(result.data, toolUseID)

const toolResultBlock = preMappedBlock
  ? await processPreMappedToolResultBlock(
      preMappedBlock,
      tool.name,
      tool.maxResultSizeChars,
    )
  : await processToolResultBlock(tool, toolUseResult, toolUseID)

const contentBlocks: ContentBlockParam[] = [toolResultBlock]
// ... 追加授权反馈与图片块
resultingMessages.push({
  message: createUserMessage({
    content: contentBlocks,
    toolUseResult:
      toolUseContext.agentId && !toolUseContext.preserveToolUseResults
        ? undefined
        : toolUseResult,
    mcpMeta: toolUseContext.agentId ? undefined : mcpMeta,
    sourceToolAssistantUUID: assistantMessage.uuid,
  }),
})
```

函数说明：结果映射和 `addToolResult` 都位于 `restored-src/src/services/tools/toolExecution.ts`；`processToolResultBlock` 与 `processPreMappedToolResultBlock` 位于 `restored-src/src/utils/toolResultStorage.ts`。最终结果被包装成一条 user message，因为 API 协议中的 `tool_result` 由 user role 回传给模型。

参数说明：映射函数的第一个参数是工具特有的输出，第二个参数是必须原样配对的 `toolUseID`。`preMappedBlock` 是可选值：普通工具在 Hook 不改输出时复用已映射结果；需要重新映射时传 `undefined`。`maxResultSizeChars` 是工具声明的结果持久化阈值；`Infinity` 表示硬性不把结果另存为可再次 Read 的文件。`toolUseResult` 是宿主侧保留的原始结果；对子 Agent，若 `preserveToolUseResults` 不是 `true`，它可以被设为 `undefined`，但面向模型的 `tool_result` 仍然存在。

映射层有两个意义。

第一，它把 Bash、Read、Edit、MCP 等不同返回类型统一到 `tool_result`。第二，它允许工具决定哪些内容给模型看。例如文件写入工具不需要把整个新文件再次回传，通常只返回成功说明；Read 则可以返回文本块、图片块或 PDF 元数据。

空结果也有明确回退。`undefined`、`null`、空字符串、纯空白字符串、空数组，以及只包含空白 text block 的数组，都会被替换为 `(<tool> completed with no output)`。非文本块不被当作空结果。

## 大结果会持久化，但不是写进 transcript 全文

当映射后的内容超过阈值，`maybePersistLargeToolResult` 会把完整内容写到独立文件：

```ts
export function getToolResultsDir(): string {
  return join(getSessionDir(), TOOL_RESULTS_SUBDIR)
}

export async function persistToolResult(
  content: NonNullable<ToolResultBlockParam['content']>,
  toolUseId: string,
): Promise<PersistedToolResult | PersistToolResultError> {
  const isJson = Array.isArray(content)
  // ... 含非 text block 的数组不能持久化
  const filepath = getToolResultPath(toolUseId, isJson)
  const contentStr = isJson ? jsonStringify(content, null, 2) : content

  try {
    await writeFile(filepath, contentStr, { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') {
      return { error: getFileSystemErrorMessage(toError(error)) }
    }
  }

  // ... 生成 preview
  return { filepath, originalSize: contentStr.length, isJson, preview, hasMore }
}
```

函数说明：`getToolResultsDir` 和 `persistToolResult` 位于 `restored-src/src/utils/toolResultStorage.ts`。目录实际由 project dir、session id 和固定子目录 `tool-results` 组成；文件名使用 `toolUseId`，字符串保存为 `.txt`，text block 数组保存为 `.json`。

参数说明：`content` 必须非空，可以是字符串或内容块数组；数组里只要出现非 `text` block，就返回错误而不落盘，因为图片等内容需要原样发送给模型。`toolUseId` 是开放字符串，但来源是模型调用块的唯一 ID。写入使用 `flag: 'wx'`：文件不存在时创建，已存在时得到 `EEXIST`，源码把它视为此前已经持久化并继续生成预览；其他写入错误则回退到原始 `tool_result`。阈值覆盖只接受有限且大于 0 的数字；`null`、字符串、非有限数字和非正数都回退到工具声明值与全局默认值的较小者。

写完以后，模型收到的不是完整正文，而是 `<persisted-output>` 包裹的说明、文件路径和前 2000 字节预览。这里实际上形成了两份不同的数据：

- `tool-results/<toolUseId>.txt|json` 保存完整大结果；
- transcript 中的 `tool_result` 保存路径和预览。

如果持久化失败，源码选择返回原始 block，而不是把工具成功误报成失败。这能保住语义，但也意味着超大结果可能重新进入消息上下文。

## 文件工具的持久化发生在 tool.call 内部

“结果持久化”还容易与“工具副作用持久化”混为一谈。看 Edit 的关键顺序就清楚了：

```ts
if (fileHistoryEnabled()) {
  await fileHistoryTrackEdit(
    updateFileHistoryState,
    absoluteFilePath,
    parentMessage.uuid,
  )
}

// ... 读取当前内容并检查自上次 Read 后是否被外部修改
writeTextContent(absoluteFilePath, updatedFile, encoding, endings)

readFileState.set(absoluteFilePath, {
  content: updatedFile,
  timestamp: getFileModificationTime(absoluteFilePath),
  offset: undefined,
  limit: undefined,
})
```

函数说明：这段来自 `FileEditTool.call`，位于 `restored-src/src/tools/FileEditTool/FileEditTool.ts`。`FileWriteTool.call` 也采用相同的大顺序：可选地备份旧状态，检查陈旧写入，实际写盘，然后更新 `readFileState`。

参数说明：`fileHistoryEnabled()` 返回布尔值，只有 `true` 才记录可回退历史；`updateFileHistoryState` 是更新内存快照状态的函数；`absoluteFilePath` 是展开后的实际路径；`parentMessage.uuid` 把备份关联到触发工具的 assistant message。`readFileState` 中的 `offset` 和 `limit` 在 Edit/Write 后显式设为 `undefined`，表示缓存对应完整文件状态，而不是某次分页 Read 的局部视图。

这段顺序给出了一个非常具体的副作用边界：`writeTextContent` 才是真正修改目标文件的操作。`fileHistoryTrackEdit` 在它之前备份旧内容，目的是支持后续 rewind；`readFileState.set` 在它之后更新并发修改检测所依赖的缓存。

但备份并不是事务锁。源码注释明确指出，备份可以在后面的陈旧性检查失败时留下“未使用备份”。同样，若写盘成功后某个通知或结果映射失败，文件也不会因为最后出现错误消息就自动恢复。

所以，“收到错误 tool_result”与“目标环境毫无变化”之间不能画等号。这是排查 Agent 副作用时最需要保留的判断。

## 最后一层：tool_result 怎样进入 transcript JSONL

工具执行器产出的消息会进入会话消息链。持久化入口 `recordTranscript` 先去重，再调用 `insertMessageChain`：

```ts
export async function recordTranscript(
  messages: Message[],
  teamInfo?: TeamInfo,
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
): Promise<UUID | null> {
  const cleanedMessages = cleanMessagesForLogging(messages, allMessages)
  const sessionId = getSessionId() as UUID
  const messageSet = await getSessionMessages(sessionId)
  const newMessages: typeof cleanedMessages = []
  let startingParentUuid: UUID | undefined = startingParentUuidHint
  let seenNewMessage = false
  for (const m of cleanedMessages) {
    if (messageSet.has(m.uuid as UUID)) {
      if (!seenNewMessage && isChainParticipant(m)) {
        startingParentUuid = m.uuid as UUID
      }
    } else {
      newMessages.push(m)
      seenNewMessage = true
    }
  }

  if (newMessages.length > 0) {
    await getProject().insertMessageChain(
      newMessages,
      false,
      undefined,
      startingParentUuid,
      teamInfo,
    )
  }

  const lastRecorded = newMessages.findLast(isChainParticipant)
  return (lastRecorded?.uuid as UUID | undefined) ?? startingParentUuid ?? null
}

// insertMessageChain 内部
if (
  message.type === 'user' &&
  message.sourceToolAssistantUUID
) {
  effectiveParentUuid = message.sourceToolAssistantUUID
}
await this.appendEntry(transcriptMessage)
```

函数说明：`recordTranscript`、`Project.insertMessageChain` 和 `Project.appendEntry` 都位于 `restored-src/src/utils/sessionStorage.ts`。调用关系是 `recordTranscript → insertMessageChain → appendEntry → enqueueWrite`，最终把一条条 entry 追加到 session JSONL；子 Agent 则可走 `recordSidechainTranscript` 写入单独的 agent transcript。

参数说明：`messages` 是待记录消息数组，清理函数会去掉不应持久化的字段或消息；`insertMessageChain` 的 `isSidechain` 默认 `false`，`agentId`、`startingParentUuid` 和 team info 都可以是 `undefined`。对于工具结果，`sourceToolAssistantUUID` 在创建消息时已设置；存在时它优先成为 `parentUuid`，确保 `tool_result` 指回产生对应 `tool_use` 的 assistant message。`appendEntry` 的 `sessionId` 默认取当前 session；重复 UUID 会被跳过。

这里可以回答一个常见疑问：为什么工具结果已经在内存消息数组里，还要保留 `sourceToolAssistantUUID`？

因为并发工具、进度消息和 Hook attachment 会让“数组中前一条消息”不一定是正确父节点。显式保存来源 assistant UUID，恢复时才能重建正确的工具调用链。

transcript 里记录的是消息协议结果，而 file history 记录的是文件旧版本，`tool-results/` 记录的是被移出上下文的大输出。三者的用途分别是恢复对话、回退文件、控制上下文体积。

## 失败发生在哪一层，决定了你应该检查什么

现在可以把常见失败按副作用边界重新分类：

| 失败位置 | 是否进入 `tool.call` | 返回给模型 | 应优先检查 |
|---|---:|---|---|
| 工具不存在 | 否 | `is_error: true` | 当前工具集合、名称、兼容别名 |
| Zod 结构校验失败 | 否 | `InputValidationError` | 必填字段、类型、未知字段 |
| `validateInput` 失败 | 否 | 工具语义错误 | 路径、范围、上下文状态 |
| PreToolUse stop/deny | 否 | stop 或拒绝结果 | Hook 输出、stop reason |
| 权限最终非 allow | 否 | 拒绝结果 | 规则、模式、宿主响应 |
| `tool.call` 抛错 | 是 | 规范化错误结果 | 外部系统及是否已有部分副作用 |
| 结果持久化失败 | 已完成 | 通常回退原始结果 | session 目录与文件系统权限 |
| transcript 写入失败 | 已完成 | 内存中可能已有结果 | session JSONL 写入链 |

这张表也解释了为什么不能只看最终一句错误文本。前五类错误可以由执行器保证没有调用目标工具；后三类已经越过副作用边界，需要检查真实环境。

异常分支会用 `formatError` 统一生成 `is_error: true` 的 `tool_result`，并运行 `PostToolUseFailure` Hook。`AbortError` 会被识别为用户中断，普通错误还会进入日志和遥测。这里的“统一”是消息形状统一，不是副作用语义统一。

## 小结

一次工具调用可以用五段话概括。

第一，`runToolUse` 从当前可用工具集合按名称或别名查找工具，找不到就直接返回错误结果。

第二，`checkPermissionsAndCallTool` 依次执行 Schema 结构校验和工具语义校验。任意失败都发生在副作用之前。

第三，PreToolUse 可以观察、改写、提出权限意见或停止调用；权限层再把 Hook、规则和宿主响应收敛。只有最终 allow 才会调用 `tool.call`。

第四，`tool.call` 是实际副作用边界。progress 只是过程反馈，返回值还要映射为 `tool_result`；异常会被规范化，但已经发生的外部副作用不会因此自动回滚。

第五，持久化不是单一文件：大结果进入 `tool-results/`，消息协议结果进入 transcript JSONL，文件工具的旧版本进入 file history，最新内容还会更新 `readFileState`。理解这几个位置，才能判断一次调用究竟是“没执行”“执行失败”“执行成功但结果没记住”，还是“结果记住了但文件已经发生变化”。

## 留给下一篇的问题

工具在真正产生副作用前，权限引擎怎样把规则、模式、Hook 和用户/宿主响应合并成 allow、ask 或 deny？

