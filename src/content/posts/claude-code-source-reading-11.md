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

上一篇留下的问题是：**你认为 `WebSearch` 在任何情况下都可以并发执行吗？**

这个问题要分成“工具怎样声明”和“调用是否真的同时运行”两层看：前者是调度器的静态输入，后者还受相邻批次、槽位、校验和权限影响。

先看工具声明。`restored-src/src/tools/WebSearchTool/WebSearchTool.ts` 中的 `WebSearchTool` 没有根据输入继续分支，而是把两个能力都固定为 `true`：

```ts
isConcurrencySafe() {
  return true
},
isReadOnly() {
  return true
},
```

这意味着，只要调度器能在当前工具池里找到 `WebSearch`，并且输入通过 Zod 结构校验，这次调用就会被标记为并发安全。它的 `query` 必须是至少 2 个字符的字符串；`allowed_domains` 和 `blocked_domains` 都是可选字符串数组，分别表示只保留和排除哪些域名，省略时不施加对应限制。

但“并发安全”不等于“无条件并发执行”。`partitionToolCalls` 只会合并同一次模型响应里相邻的安全调用；不安全调用会形成串行屏障，安全批次还受 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 的槽位上限约束。单个安全调用没有并行对象，上限设为 `1` 时批内调用也不会重叠。找不到工具、结构校验失败，或者并发判断抛错时，这次调用也会先按不安全处理。

还有一层更容易忽略：分组发生在完整执行生命周期之前。`allowed_domains` 和 `blocked_domains` 同时为非空数组时，输入仍能通过结构校验，也会被归入安全批次，但后面的 `validateInput` 会拒绝它。进入批次的 `WebSearch` 还要继续经过 `validateInput`、PreToolUse 和权限决策；只有这些前置关卡放行并真正进入 `tool.call`，才会发起那轮模型请求。

所以准确答案是：**2.1.88 中 `WebSearch` 对结构合法的输入声明并发安全，但只有相邻安全调用且有空闲槽位时才会与其他调用重叠；输入语义、Hook、权限或网络错误都可能让它在真正请求前后停止。**

下面就沿单个工具调用继续看：它完成调度后，还要经过哪些关卡。

## 本章先建立三个概念

- **副作用边界**：`tool.call` 之前的步骤负责解释与授权，越过边界后外部世界可能已经改变。

- **生命周期切面**：Hook 在固定阶段观察或干预调用，核心流程仍负责聚合最终决定。

- **执行证据**：进度、原始返回值、映射后的 `tool_result` 和持久化记录分别服务不同消费者。

![工具生命周期中的副作用边界与执行证据](/images/posts/claude-code-source-reading-11/11-side-effect-boundary-detail-handdrawn.png)

这张图按副作用出现的先后排列各道门：名称解析、结构与语义校验、Hook、权限、`tool.call()`，最后才把结果写进 transcript。

## 从金额工单的一次搜索开始

你先要求 Claude Code 读取事故记录，再核对 Stripe 官方文档中的 `amount` 单位和舍入规则：

> 通过 issue-tracker MCP 读取金额单位工单，必要时搜索 Stripe 官方文档，核对 `amount` 的单位和舍入规则。

用户看到的可能只是“正在搜索”，源码里却要先解析 `tool_use` 名称，检查 Schema 和 `validateInput`，运行 `PreToolUse` Hook，等待权限决定，才进入真正的 `tool.call`。执行进度、原始返回值、`tool_result` 和 transcript 又分别走不同通道；任一关卡失败，错误都在对应位置返回，而不是伪装成一篇完整的调查结果。

下面沿一次搜索或 MCP 调用，从名称解析一直追到副作用、结果映射和持久化。你要查的是一个数字，运行时要守住的却是整条调用流水线。

## 先画出一条工具执行流水线

本文只讨论 `@anthropic-ai/claude-code@2.1.88` source map 还原出的代码。假设模型已经返回一个带 `id`、`name`、`input` 的 `tool_use`，调用从哪里被拦下，决定了你应该检查 Schema、Hook、权限还是实际副作用。

多个工具怎样组成批次，上一篇已经处理；本篇只沿一个调用追踪每道门的顺序，以及错误怎样变成下游可以识别的消息。

![一次工具调用从 tool_use 走到副作用与持久化](/images/posts/claude-code-source-reading-11/11-tool-execution-lifecycle-handdrawn.png)

这张图的重点是中间那条 `SIDE EFFECT BOUNDARY`：

1. 工具查找、输入校验、PreToolUse 和权限决策都在边界左边；
2. `tool.call` 在边界右边，它可能读文件、写文件、执行命令或者请求网络；
3. progress、`tool_result`、transcript 和 file history 分属不同的数据通道，不能用“工具返回了”一概而论。

下面沿这条路径逐段看源码。代码块删去遥测、日志和无关分支，`// ...` 标出删节；保留下来的函数名、返回值和控制顺序来自 `restored-src/`。

## 第一扇门：tool_use 先完成名称解析

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

如果仍然找不到，程序会直接构造 `is_error: true` 的 `tool_result` 并返回。该分支终止于名称解析阶段，输入校验与工具调用保持未触发状态。

取消也有同样的边界。`abortController.signal.aborted` 在进入执行器前已经为 `true` 时，`runToolUse` 会返回 stop result。至于工具运行期间收到新输入是取消还是等待，则由工具可选的 `interruptBehavior()` 决定；源码可确认的返回值是 `'cancel'` 或 `'block'`，未实现、返回异常时都回退到 `'block'`。

## 第二扇门：结构校验之后再做语义校验

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

两种校验失败都会转换成 `tool_result`，让 query loop 保持协议完整；模型看到错误后可以修正参数再次调用。

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

参数说明：`processedInput` 是通过两层校验后的输入，但 Hook 仍可用 `hookUpdatedInput` 替换它；`toolUseID` 和 assistant message id 用来关联 Hook 与本次调用。普通本地工具会让 `mcpServerType`、`mcpServerBaseUrl` 保持 `undefined`，请求标识缺失时 `requestId` 也为 `undefined`；后续序列化据此省略 MCP 与请求来源字段。`result.type` 的源码可见分支包括 `message`、`hookPermissionResult`、`hookUpdatedInput`、`preventContinuation`、`stopReason`、`additionalContext` 和 `stop`。

这段代码说明，Hook 可以同时影响三个执行维度：

- 观察调用，并产生 progress 或 attachment；
- 改写后续权限检查和实际调用使用的输入；
- 提供 `allow`、`ask`、`deny` 意见，或者直接停止执行。

但要注意，Hook 给出的 `allow` 只是权限决策输入。`resolveHookPermissionDecision` 还会应用规则；deny 规则可以覆盖 Hook allow，ask 规则也可以强制进入宿主确认。这正是下一篇要继续拆解的部分。

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

函数说明：`resolveHookPermissionDecision` 位于 `restored-src/src/services/tools/toolHooks.ts`；调用方随后用 `behavior !== 'allow'` 守住 `tool.call`。因此可以由源码直接确认：只有最终行为为 `allow` 才会进入实际工具调用，`ask` 与 `deny` 都在边界前返回。

参数说明：`hookPermissionResult` 可以是 `undefined`，此时权限引擎继续使用规则和宿主决定；它的 `behavior` 可选值是 `'allow'`、`'ask'`、`'deny'`。`canUseTool` 负责把需要交互的部分交给当前宿主。`updatedInput` 为对象时覆盖现有输入，为 `undefined` 时保留 `processedInput`。`permissionDecision.message` 在不同拒绝来源下可能缺失，执行器会结合 PreToolUse 的 stop reason 生成回退错误信息。

这里必须区分 ask 的两个时刻。

Hook 或规则产生的 ask，表示需要把问题交给宿主；宿主处理以后，`canUseTool` 可能返回 allow 或 deny。最终 allow 进入调用，deny 则生成错误结果并返回。

到这一步为止，程序只记录日志、运行 Hook 和等待用户；下一行 `tool.call()` 才越过副作用边界。

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

参数说明：第一个参数 `callInput` 是最终执行输入，可能来自模型，也可能被 Hook 或权限响应更新；第二个参数在原 `ToolUseContext` 上补入 `toolUseId: toolUseID` 关联当前调用，并用 `userModified: permissionDecision.userModified ?? false` 记录用户是否改过输入；第三个参数 `canUseTool` 供嵌套授权使用，第四个参数是父 assistant message，第五个 `onProgress` 可选。进度对象的 `toolUseID` 标记来源调用，`data` 是工具特有进度载荷；二者被 `onToolProgress` 转交上层。返回的 `newMessages`、`contextModifier` 和 `mcpMeta` 均为可选值，省略时跳过相应后处理。

为什么把这一行叫副作用边界？因为接口本身并不承诺 `call` 是纯函数。Read 可以访问磁盘，Bash 可以创建进程，MCP 可以访问外部服务，Edit 和 Write 会修改文件。即使 `tool.call` 最后抛出异常，也不能反推出“什么都没发生”：外部命令可能已经输出了一半，文件工具也可能在后续步骤失败前完成过某些操作。

因此，执行器能统一错误消息，却不能替所有工具提供事务回滚。判断副作用是否完成，仍要看具体工具实现。

## progress 与最终 tool_result 分开传递

`tool.call` 接收的 progress 回调最终进入 `onToolProgress`。外层 `streamedCheckPermissionsAndCallTool` 使用一个流，把这些更新在 Promise 完成前送出去。

这类消息主要服务于 UI 和流式宿主：长时间 Bash、Hook 或远程工具可以持续报告状态。

一次调用完全可能经历下面的顺序：

1. 已经发送若干 progress；
2. 工具随后抛出异常；
3. 执行器最终返回 `is_error: true` 的 `tool_result`。

所以恢复会话时，`tool_use` 与 `tool_result` 维持模型协议配对；progress 只服务实时观察，transcript 链接逻辑也会把它排除在后续消息的 parent 之外。

## 原始返回值如何变成 tool_result

工具成功返回的 `result.data` 先经 `mapToolResultToToolResultBlockParam` 转成 Anthropic API 可识别的 `ToolResultBlockParam`。

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

参数说明：映射函数的第一个参数是工具特有输出，第二个参数 `toolUseID` 必须原样配对。`mappedToolResultBlock` 是首次映射结果；`preMappedBlock` 存在时交给 `processPreMappedToolResultBlock` 按 `tool.name` 和 `maxResultSizeChars` 处理，否则 `processToolResultBlock` 根据工具、原始 `toolUseResult` 与调用 ID 重新映射。`contentBlocks` 以最终结果块开头，随后可追加授权反馈和图片。外层 `message` 是 user message；`content` 发给模型，`toolUseResult` 给宿主保留原始结果，但 Agent 且未开启 `preserveToolUseResults` 时省略；`mcpMeta` 只在非 Agent 路径保留，`sourceToolAssistantUUID` 指回发起调用的 assistant 节点。

映射层有两个意义。

第一，它把 Bash、Read、Edit、MCP 等不同返回类型统一到 `tool_result`。第二，它允许工具决定哪些内容给模型看。例如文件写入工具不需要把整个新文件再次回传，通常只返回成功说明；Read 则可以返回文本块、图片块或 PDF 元数据。

空结果也有明确回退。`undefined`、`null`、空字符串、纯空白字符串、空数组，以及只包含空白 text block 的数组，都会被替换为 `(<tool> completed with no output)`。非文本块不被当作空结果。

## 大结果持久化到独立文件并返回预览

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

写完以后，模型收到 `<persisted-output>` 包裹的说明、文件路径和前 2000 字节预览；完整正文留在持久化文件中。这里实际上形成了两份不同的数据：

- `tool-results/<toolUseId>.txt|json` 保存完整大结果；
- transcript 中的 `tool_result` 保存路径和预览。

如果持久化失败，源码返回原始 block，保留工具成功的业务语义；代价是超大结果可能重新进入消息上下文。

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

参数说明：`fileHistoryEnabled()` 返回布尔值，只有 `true` 才记录可回退历史；`updateFileHistoryState` 更新内存快照，`absoluteFilePath` 是展开后的目标，`parentMessage.uuid` 把备份关联到触发工具的 assistant 消息。写入后，`readFileState.set()` 以该路径为键，`content` 保存完整 `updatedFile`，`timestamp` 重新读取修改时间；`offset` 与 `limit` 被清除，使后续校验把缓存视为完整文件状态。

这段顺序给出了一个非常具体的副作用边界：`writeTextContent` 才是真正修改目标文件的操作。`fileHistoryTrackEdit` 在它之前备份旧内容，目的是支持后续 rewind；`readFileState.set` 在它之后更新并发修改检测所依赖的缓存。

备份提供回滚材料，却不提供事务锁。源码注释明确指出，后续陈旧性检查失败时可能留下“未使用备份”。同样，写盘成功后若通知或结果映射失败，文件仍保持已写入状态，最终错误消息不会触发自动恢复。

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

参数说明：`messages` 是待记录数组，`allMessages` 可提供完整上下文给清理函数；`teamInfo` 关联团队，`startingParentUuidHint` 提供起始父节点，二者省略时使用普通主链上下文。`cleanedMessages` 是可落盘投影，`sessionId` 取当前会话，`messageSet` 用于按 UUID 去重，`newMessages` 只收首次出现的消息；`startingParentUuid` 会在前导重复链节点上前移，`seenNewMessage` 标记是否已进入新段。存在新消息时，`insertMessageChain(newMessages, false, undefined, startingParentUuid, teamInfo)` 明确写主链；`lastRecorded` 选择最后一个链参与者，返回其 UUID，否则回退起始父节点或 `null`。工具结果的 `sourceToolAssistantUUID` 会在 `insertMessageChain` 中优先成为 `parentUuid`。

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

这张表说明错误文本必须结合发生阶段阅读。前五类错误发生在 `tool.call` 之前，目标工具保持未调用状态；后三类已经越过副作用边界，需要检查真实环境。

异常分支会用 `formatError` 统一生成 `is_error: true` 的 `tool_result`，并运行 `PostToolUseFailure` Hook。`AbortError` 会被识别为用户中断，普通错误还会进入日志和遥测。统一只发生在消息形状层；副作用语义仍由异常发生在边界前还是边界后决定。

## 小结

一次工具调用可以用五段话概括。

第一，`runToolUse` 从当前可用工具集合按名称或别名查找工具，找不到就直接返回错误结果。

第二，`checkPermissionsAndCallTool` 依次执行 Schema 结构校验和工具语义校验。任意失败都发生在副作用之前。

第三，PreToolUse 可以观察、改写、提出权限意见或停止调用；权限层再把 Hook、规则和宿主响应收敛。只有最终 allow 才会调用 `tool.call`。

第四，`tool.call` 是实际副作用边界。progress 只是过程反馈，返回值还要映射为 `tool_result`；异常会被规范化，但已经发生的外部副作用不会因此自动回滚。

第五，持久化分布在多个位置：大结果进入 `tool-results/`，消息协议结果进入 transcript JSONL，文件工具的旧版本进入 file history，最新内容还会更新 `readFileState`。理解这些位置，才能区分“边界前拒绝”“调用失败”“调用成功但持久化失败”和“结果已记录但文件随后变化”。

## 留给下一篇的问题

**如果任务要求识别一张其内容超过当前上下文容量的图片，这次 `tool_use` 会不会失败、又会在哪一层失败？**

## 参考资料

- [Claude Code 工具编排](https://harness-books.agentway.dev/en/book1-claude-code/exported/book1-claude-code-en.pdf)
- [Anthropic 工具调用实现指南](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use)

- [Claude Code Hooks 参考](https://code.claude.com/docs/en/hooks)
