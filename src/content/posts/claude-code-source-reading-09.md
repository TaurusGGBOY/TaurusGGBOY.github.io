---
title: "Claude Code源码解读09：工具契约与注册表如何工作"
published: 2026-07-24T09:00:00+08:00
description: "拆解 Claude Code 的 Tool 契约、当前会话工具池、MCP 与插件工具注册，以及 tool_use 的名称匹配与双层输入校验。"
tags: ["claude-code", "source-code", "ai-agent", "tool-contract"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-09/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：模型发出 `tool_use` 以后，Claude Code 如何根据工具契约与注册表找到并验证真正要执行的工具？

先说结论：模型返回的 `tool_use` 只是一个包含 `name`、`input` 和 `id` 的请求，它没有携带可执行函数。Claude Code 会拿 `name` 到当前会话的 `Tools` 数组里匹配主名称或别名，找到一个真正的 `Tool` 对象；然后先用这个对象的 `inputSchema` 检查数据结构，再调用可选的 `validateInput` 检查业务条件。两关都通过以后，调用才会进入权限判断和实际执行。

这里有一个容易忽略的前提：用于查找的不是“程序里定义过的全部工具”，而是当前运行模式、权限规则和功能开关共同裁剪后的可用工具池。一个工具即使存在于源码中，只要没有进入这个数组，对本轮调用来说就和不存在一样。

本文仍以仓库中从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。为了突出主线，下面的源码片段会省略无关字段、日志和错误上报分支；省略处不改变本文讨论的控制流。

## 先建立一个简单模型

我们可以先把整个过程压缩成两步：

1. 在请求发出前，把内置工具、MCP 工具以及插件带来的 MCP 工具整理成一个可用工具池，并把契约发给模型。
2. 模型返回 `tool_use` 后，用同一批工具做名称匹配和输入校验，得到可以进入执行阶段的具体对象。

这两个阶段必须使用能够对应上的契约。否则，模型看到的是一个工具，执行时却找不到它；或者模型依据一份 Schema 生成参数，本地却拿另一份 Schema 校验。Claude Code 的 `Tool` 抽象，就是为了把“告诉模型什么”和“宿主真正执行什么”放在同一个对象上。

![Claude Code 从工具池装配到调用前校验的流程](/images/posts/claude-code-source-reading-09/09-tool-contract-handdrawn.png)

图里的 `READY` 不是“已经执行成功”，而是“已经找到工具并通过输入校验”。权限、Hooks、工具调用和结果回传属于下一阶段，后续章节会继续展开。

## Tool 不是一个函数，而是一份双向契约

我们先看 `restored-src/src/Tool.ts` 中 `Tool` 的核心字段：

```ts
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  aliases?: string[]
  searchHint?: string
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>
  description(
    input: z.infer<Input>,
    options: {
      isNonInteractiveSession: boolean
      toolPermissionContext: ToolPermissionContext
      tools: Tools
    },
  ): Promise<string>
  readonly inputSchema: Input
  readonly inputJSONSchema?: ToolInputJSONSchema
  // 其余可选能力字段省略
  isConcurrencySafe(input: z.infer<Input>): boolean
  isEnabled(): boolean
  isReadOnly(input: z.infer<Input>): boolean
  // 其余 MCP、展示与结果字段省略
  readonly name: string
  // 结果大小与 strict 字段省略
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>
}
```

**类型说明：** `Tool` 同时保存可被模型理解的名称和输入结构，以及宿主执行时需要的校验、并发属性和 `call`。因此，注册表里保存的不是名称到任意回调的松散映射，而是一组完整 `Tool` 对象。

**参数说明：** `Input` 是 Zod 对象 Schema，默认是任意对象形状；`Output` 默认是 `unknown`；`P` 表示进度数据类型，默认是通用 `ToolProgressData`。`aliases` 是可选字符串数组，`undefined` 表示没有别名。`inputJSONSchema` 也是可选字段，主要让 MCP 工具直接保留服务端给出的 JSON Schema；没有它时，API 层会把 `inputSchema` 转成 JSON Schema。`description` 的 `options` 提供运行模式、权限上下文和当前工具池。调用时，`args` 是解析后的输入，`context` 是当前会话上下文，`canUseTool` 负责权限询问，`parentMessage` 用于关联本次 assistant 消息；`onProgress` 为 `undefined` 时，工具仍可执行，只是不通过这个回调上报进度。`validateInput` 可省略，省略表示没有第二层业务校验，并不表示跳过 `inputSchema`。

这份接口可以分成三组职责：

- `name`、`aliases`、`inputSchema` 和描述告诉模型“怎样调用”。
- `isEnabled`、`isConcurrencySafe`、`isReadOnly` 等元数据告诉宿主“是否暴露、怎样调度”。
- `validateInput`、权限检查和 `call` 决定“这一次具体输入能否执行，以及怎样执行”。

也就是说，Schema 不是旁边的一份文档。它和执行函数属于同一个对象，名称查找一旦命中，后续阶段就能继续使用同一份契约。

## buildTool 把缺省行为集中起来

内置工具大多通过 `buildTool` 构造。它的价值不在于复杂，而在于把缺省值集中到一个地方：

```ts
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolUseContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
```

**函数说明：** `buildTool` 先铺开 `TOOL_DEFAULTS`，再写入基于 `def.name` 的展示名，最后铺开 `def`。因此，工具自己声明的同名字段优先级最高；没有声明的字段才使用默认值。

**参数说明：** `def` 是一个 `ToolDef`，必须提供没有默认实现的契约字段，其他字段可以覆盖默认值。默认 `isEnabled=true`；并发安全、只读和破坏性均为 `false`。这意味着没有显式声明并发安全的工具不会被乐观地当作可并行工具。默认 `checkPermissions` 返回 `allow` 和原输入，但源码注释明确说它仍要交给通用权限系统；不能把这个缺省返回值理解成“无条件绕过权限”。可选输入参数为 `undefined` 时，这些默认函数仍可调用。

这里的设计有一个很实用的结果：新增工具时，开发者不需要重复写一批空实现；但与调度、安全相关的未知信息会采用保守值。例如，`isConcurrencySafe` 缺省为 `false`，而不是猜测这个工具大概可以并发。

## 注册表其实是当前会话的一份 Tools 数组

源码把 `Tools` 定义为 `readonly Tool[]`。它不是一个全局单例 Map，也不是安装完成后永远不变的清单。工具池会随运行模式、权限上下文、MCP 连接状态和功能开关变化。

先看内置工具的最后一道筛选，位置在 `restored-src/src/tools.ts`：

```ts
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // 前面省略 simple、REPL 和特殊工具分支
  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)

  // 前面省略 REPL primitive tools 的隐藏逻辑
  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}
```

**函数说明：** `getTools` 从基础工具集合出发，先处理特殊工具和 deny 规则，再调用每个工具的 `isEnabled()`。只有返回 `true` 的对象才进入内置工具池。

**参数说明：** `permissionContext` 包含权限模式和 allow、deny、ask 规则。源码中的外部模式包括 `acceptEdits`、`bypassPermissions`、`default`、`dontAsk`、`plan`；内部类型还包含受功能开关控制的 `auto` 和只用于内部传播的 `bubble`。这里传入的是完整上下文，不是一个简单布尔值。`isEnabled()` 没有参数，只能依据工具闭包、环境和功能开关判断。

为什么先把 `isEnabled()` 的结果全部算出来，再做 `filter`？从这段源码可以确认这样保证每个候选工具在本次筛选中只调用一次。。

接下来，`assembleToolPool` 把内置工具与 MCP 工具汇合：

```ts
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)

  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

**函数说明：** `assembleToolPool` 分别取得允许使用的内置工具和 MCP 工具，按名称排序后连接，再按 `name` 去重。内置工具排在前面，所以同名时由内置工具胜出。源码注释还说明，分区排序是为了让内置工具保持连续，从而稳定 prompt cache。

**参数说明：** `permissionContext` 决定两类工具的 deny 过滤；`mcpTools` 是当前 AppState 中已经发现的 MCP `Tool` 数组，可以为空数组，但不是 `null`。返回值仍是只读语义的 `Tools`。这个函数不会负责连接 MCP server，也不会凭配置猜出尚未发现的工具。

所以，“注册一个工具”至少有两层含义：代码中存在工具定义，只说明它有机会进入候选集；进入本轮 `options.tools`，才说明执行器真的可以按名称找到它。

## MCP 与插件怎样汇入同一份契约

MCP server 返回的是协议层的 tool 描述，还不是 Claude Code 内部的 `Tool`。`restored-src/src/services/mcp/client.ts` 中的 `fetchToolsForClient` 会做一次适配：

```ts
return toolsToProcess.map((tool): Tool => {
  const fullyQualifiedName = buildMcpToolName(client.name, tool.name)
  return {
    ...MCPTool,
    name: skipPrefix ? tool.name : fullyQualifiedName,
    mcpInfo: { serverName: client.name, toolName: tool.name },
    isMcp: true,
    isConcurrencySafe() {
      return tool.annotations?.readOnlyHint ?? false
    },
    isReadOnly() {
      return tool.annotations?.readOnlyHint ?? false
    },
    inputJSONSchema: tool.inputSchema as Tool['inputJSONSchema'],
    // call、权限与渲染字段省略
  }
})
```

**函数说明：** `fetchToolsForClient` 请求 MCP 的 `tools/list`，随后以基础 `MCPTool` 为模板，把每个远端工具转换成内部 `Tool`。远端名称、Schema、只读提示和真正的 MCP 调用函数因此进入与内置工具相同的数组。

**参数说明：** `client` 必须是 `connected` 状态且声明 `tools` capability，否则函数返回空数组。`skipPrefix` 只在 `client.config.type === 'sdk'` 且环境开关 `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` 为真时启用；否则名称使用 `mcp__server__tool` 一类完整名称。`readOnlyHint` 为 `true` 时同时视为只读和并发安全，为 `false` 或 `undefined` 时都回退到 `false`。

这里还要区分两份 Schema 的用途。MCP 适配器保留远端 `inputJSONSchema`，API 层会优先把它发给模型；但基础 `MCPTool.inputSchema` 是允许额外字段的 Zod 对象。也就是说，本地通用 `safeParse` 对 MCP 参数只做宽松对象检查，远端 JSON Schema 的最终约束还要由模型生成阶段和 MCP server 承担。。

插件工具又在哪里？就“工具注册”这条路径而言，这一版源码没有把任意插件 JavaScript 回调直接塞进 `Tools`。启用的插件可以声明 MCP server，`restored-src/src/services/mcp/config.ts` 会把它们收集进 MCP 配置：

```ts
const pluginResult = await loadAllPluginsCacheOnly()
const pluginServerResults = await Promise.all(
  pluginResult.enabled.map(plugin => getPluginMcpServers(plugin, mcpErrors)),
)
for (const servers of pluginServerResults) {
  if (servers) Object.assign(pluginMcpServers, servers)
}
```

**函数说明：** 这段代码位于 `getClaudeCodeMcpConfigs` 的插件 MCP 收集阶段。它只遍历启用的插件，读取各插件声明的 MCP server，并合并到插件服务器配置中。服务器连接成功后，工具再经过 `fetchToolsForClient` 变成内部 `Tool`。

**参数说明：** `loadAllPluginsCacheOnly()` 没有显式参数，返回结果中的 `enabled` 与 `errors` 取决于运行时插件状态；`getPluginMcpServers(plugin, mcpErrors)` 接收一个已启用插件和可累积错误的数组，可能返回服务器对象，也可能返回 `undefined`，因此合并前有显式判断。插件还可以贡献命令、Agent、Skill 和 Hooks，但这些不是本文所说的 `Tool` 注册表，不能混为一谈。

于是三种来源在执行前完成了汇合：

- 内置工具直接实现或通过 `buildTool` 得到 `Tool`。
- 普通 MCP 工具由 `fetchToolsForClient` 适配成 `Tool`。
- 插件声明的 MCP server 先进入 MCP 连接流程，发现的工具再适配成 `Tool`。

来源不同，进入 `options.tools` 以后使用的是同一套名称查找、输入校验和执行入口。

## tool_use 怎样找到真正的工具

模型响应到达工具执行层后，`runToolUse` 首先做的不是调用，而是查找。名称匹配逻辑非常直接：

```ts
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(tool => toolMatchesName(tool, name))
}
```

**函数说明：** `toolMatchesName` 先比较主名称，再检查别名；`findToolByName` 返回数组中第一个匹配对象。没有匹配项时返回 `undefined`，不会构造一个临时工具，也不会做模糊搜索。

**参数说明：** `tool.aliases` 可以是字符串数组或 `undefined`；可选链之后的结果再用 `?? false` 回退，所以没有别名时明确返回 `false`。`name` 是模型 `tool_use.name` 提供的任意字符串，源码没有固定枚举。`tools` 的顺序会影响同名对象谁先命中，不过正常装配路径已经按名称去重。

`runToolUse` 使用的正是当前上下文里的可用工具池：

```ts
const toolName = toolUse.name
let tool = findToolByName(toolUseContext.options.tools, toolName)

if (!tool) {
  const fallbackTool = findToolByName(getAllBaseTools(), toolName)
  if (fallbackTool && fallbackTool.aliases?.includes(toolName)) {
    tool = fallbackTool
  }
}

if (!tool) {
  yield {
    message: createUserMessage({
      content: [{
        type: 'tool_result',
        content: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
        is_error: true,
        tool_use_id: toolUse.id,
      }],
      toolUseResult: `Error: No such tool available: ${toolName}`,
      sourceToolAssistantUUID: assistantMessage.uuid,
    }),
  }
  return
}
```

**函数说明：** `runToolUse` 先查本轮 `options.tools`。第一次失败后，只允许从全部基础工具中恢复“旧别名”对应的工具，用于兼容旧 transcript；主名称命中不属于这个回退。仍然找不到时，它生成带 `is_error: true` 的 `tool_result` 并结束本次调用，实际错误文本是 `No such tool available`。

**参数说明：** 原函数的 `toolUse` 含 `name`、`input`、`id`；`assistantMessage` 提供父消息和关联 UUID；`canUseTool` 是后续权限回调；`toolUseContext` 提供工具池和会话状态。这里展示的查找分支没有使用 `null`：找到的是 `Tool`，找不到是 `undefined`。代码块省略了两次查找之间与错误上报有关的 telemetry 字段；名称匹配与 alias fallback 均与 `restored-src/src/services/tools/toolExecution.ts::runToolUse` 一致。

这也回答了“禁用工具会怎样”。大多数情况下，`isEnabled=false` 的工具已经在 `getTools` 阶段被移除，执行时查找不到，最终走未知工具分支。

## 输入校验有两层，顺序不能颠倒

找到工具以后，执行层先做结构校验，再做工具自己的业务校验。核心代码位于同一文件的 `checkPermissionsAndCallTool`：

```ts
const parsedInput = tool.inputSchema.safeParse(input)
if (!parsedInput.success) {
  // InputValidationError 的日志与 tool_result 内联构造省略
  // ...
}

const isValidCall = await tool.validateInput?.(
  parsedInput.data,
  toolUseContext,
)
if (isValidCall?.result === false) {
  // tool_use_error 的日志与 tool_result 内联构造省略
  // ...
}
```

**函数说明：** `checkPermissionsAndCallTool` 先用 Zod `safeParse` 验证并解析输入。只有 `success=true` 才把 `parsedInput.data` 传给 `validateInput`。任意一层失败都会由真实的 `createUserMessage` 内联构造错误 `tool_result` 返回给模型，而不是让异常输入进入 `call`；代码块已经用注释明确标出省略的消息字段。

**参数说明：** 原函数的 `input` 是布尔值、字符串或数字组成的对象，但各工具的 Zod Schema 可以进一步约束字段。`safeParse` 返回成功或失败的判别联合。`validateInput` 可为 `undefined`；可选调用在这种情况下得到 `undefined`，不会进入失败分支。它的返回值只能是 `{ result: true }`，或 `{ result: false, message: string, errorCode: number }`。因此，业务校验失败必须同时提供给模型看的消息和用于记录的数字错误码。

两层校验解决的是不同问题。例如，一个文件工具可以先用 Schema 确认 `file_path` 是字符串，再在 `validateInput` 中检查文件是否存在、大小是否超过限制、路径是否符合当前权限上下文。把这两件事合成一个 Schema 并不现实，因为第二类条件依赖运行时状态。

校验失败也不是进程级异常。源码把它包装成 `is_error: true` 的 `tool_result`，关联原来的 `tool_use_id`，再交还给对话循环。模型因此有机会修正参数并重新调用。

## ToolUseContext 为什么不能省

如果输入参数已经包含路径、命令和选项，为什么 `validateInput` 与 `call` 还要接收 `ToolUseContext`？因为同一组参数能否执行，取决于它所在的会话。

```ts
export type ToolUseContext = {
  options: {
    tools: Tools
    mcpClients: MCPServerConnection[]
    isNonInteractiveSession: boolean
    maxBudgetUsd?: number
    refreshTools?: () => Tools
  }
  abortController: AbortController
  readFileState: FileStateCache
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  toolUseId?: string
}
```

**类型说明：** `ToolUseContext` 把当前工具池、MCP 连接、运行模式、取消信号、文件状态和 AppState 访问能力一起传入校验与调用。它让工具可以读取会话状态，但不需要依赖某个具体 UI 组件。

**参数说明：** `isNonInteractiveSession` 是必需布尔值，用来区分无头/SDK 与交互式路径。`maxBudgetUsd` 和 `toolUseId` 可为 `undefined`；源码未在类型层提供默认金额或默认 ID。`refreshTools` 可选，存在时用于取得 MCP 中途连接后的最新工具集。`requestPrompt` 只在交互上下文可用；第二个参数 `toolInputSummary` 可为字符串、`null` 或 `undefined`，分别表示有摘要、明确无摘要或未提供。`abortController.signal.aborted` 则决定调用是否已被取消。

这说明 `ToolUseContext` 不是一个为了方便而堆放字段的“万能参数”。至少在这条链路上，它解决了三个明确问题：查找当前真正可用的工具、让业务校验读取运行状态、把取消与交互能力传入具体调用。

## 三类失败边界

现在可以把调用前的失败分成三类。

第一类是名称失败。`name` 和 `aliases` 都匹配不到，返回 `No such tool available`。这可能是模型生成了不存在的名称，也可能是工具已经被权限规则、运行模式或 `isEnabled()` 从工具池移除。

第二类是结构失败。名称正确，但 `inputSchema.safeParse` 不接受模型给出的字段类型或形状。执行层返回 `InputValidationError`，不会调用工具自己的业务逻辑。

第三类是业务失败。结构已经正确，但 `validateInput` 根据路径、文件状态或其他上下文返回 `result: false`。它同样会变成错误 `tool_result`，但错误信息来自具体工具。

还有两个现实运行边界：

一是当前用户最终能看到哪些工具。环境变量、构建特性、权限规则、MCP 连接和插件启用状态都会改变工具池，单看 `getAllBaseTools()` 不能还原某次真实会话。

二是外部工具声明是否可信。Claude Code 会清理 MCP 返回的数据，并把它适配到内部契约，但工具描述、JSON Schema 和只读注解仍来自外部 server。

## 小结

Claude Code 找到工具的过程并不神秘，但边界很清楚：

1. `Tool` 把名称、Schema、能力元数据、校验和执行函数放进同一份契约。
2. `getTools` 与 `assembleToolPool` 根据权限、功能开关和 MCP 状态生成当前会话的工具池；`isEnabled=false` 通常意味着工具不会进入这个池。
3. MCP 工具会被适配成内部 `Tool`；插件声明的 MCP server 也沿这条路径汇合，而不是绕过注册表直接执行。
4. `runToolUse` 只做精确主名称或别名匹配。未知工具、结构错误和业务校验失败都会变成与原 `tool_use_id` 关联的错误结果。
5. 通过两层输入校验只代表调用已经具备进入权限与执行阶段的条件，不代表权限已批准，更不代表执行成功。

把这条链路记成一句话就是：先裁剪能力，再按名取对象，最后用对象自己的契约验证输入。

## 留给下一篇的问题

当同一次模型响应包含多个 `tool_use` 时，Claude Code 如何判断哪些工具可以并行执行，哪些必须串行？
