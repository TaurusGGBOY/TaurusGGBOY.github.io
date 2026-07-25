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

## 本章先建立三个概念

- **能力契约**：工具名称、输入 Schema、权限检查、执行函数和结果映射共同定义可调用能力。

- **双层校验**：结构校验确认输入形状，语义校验结合当前项目和调用上下文判断可执行性。

- **注册表快照**：每轮请求使用当前会话装配出的工具集合，扩展来源在进入模型前被规范化。

![工具契约从 Schema 到执行结果的闭环](/images/posts/claude-code-source-reading-09/09-tool-contract-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇留下的问题是：**你知道 Beta 开关打开的时候有什么新功能吗？**

源码把 Beta 表达为一组随请求发送的能力声明，最终组合成 `betas` 数组；具体 header 由 provider、模型、功能开关和运行模式共同决定。

控制第一方实验 Beta 的环境变量是禁用开关 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`。它未设置或取 falsy 值时，第一方实验 Beta 才允许进入请求：

```ts
export function shouldIncludeFirstPartyOnlyBetas(): boolean {
  return (
    (getAPIProvider() === 'firstParty' || getAPIProvider() === 'foundry') &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}
```

这段函数只回答一个前置问题：当前 provider 是否允许发送第一方实验 header，以及用户是否通过环境变量将其关闭。返回 `true` 仍需各能力自己的模型与运行条件；Bedrock、Vertex 走各自兼容路径。

### Beta 是怎么进入请求的

`getAllModelBetas(model)` 根据当前模型和运行环境逐步构造 header；`getModelBetas(model)` 再针对 Bedrock 做位置适配；到了 `queryModel`，`getMergedBetas()` 会把模型 Beta、Agent 调用所需的 Claude Code Beta，以及 SDK 允许的 Beta 合并并去重：

```ts
export function getMergedBetas(
  model: string,
  options?: { isAgenticQuery?: boolean },
): string[] {
  const baseBetas = [...getModelBetas(model)]
  // Agentic query 必要的 header 和 SDK betas 的合并逻辑省略
  const sdkBetas = getSdkBetas()
  if (!sdkBetas || sdkBetas.length === 0) {
    return baseBetas
  }
  return [...baseBetas, ...sdkBetas.filter(b => !baseBetas.includes(b))]
}
```

`model` 是开放的模型标识，用于计算 `baseBetas`；`options.isAgenticQuery` 是可选布尔值，真值时加入 Agent 查询必需的 Beta，省略或为假时跳过。`sdkBetas` 为空时直接返回模型 Beta；有值时只追加尚未存在的项，保留原顺序并去重。

真正发请求时，只有 `betas` 数组非空才把它写入参数：

```ts
const useBetas = betas.length > 0

return {
  // 其余 messages、system、tools 和模型参数省略
  ...(useBetas && { betas: betasParams }),
}
```

`useBetas` 表示数组是否非空；真值时把 `betasParams` 写入请求，假值时整个字段被省略。`anthropic.beta.messages.create()` 或 `.stream()` 只是 SDK 的 Beta 类型入口，服务端行为由最终 header 及其配套请求字段决定。

### 打开后可能出现哪些能力

下面这些是源码能够确认的请求能力。总开关放行后，每一项仍要满足自己的模型、provider 或实验条件。

| 能力 | 源码中的触发条件 | 请求变化 |
| --- | --- | --- |
| 1M 上下文 | `has1mContext(model)` | 加入 `context-1m-2025-08-07`，让支持的模型走长上下文 Beta |
| 交错思考 | 未设置 `DISABLE_INTERLEAVED_THINKING`，且 `modelSupportsISP(model)` | 加入 `interleaved-thinking-2025-05-14` |
| 上下文管理 | 第一方/Foundry 且模型支持，或 Anthropic 内部显式打开工具清理 | 加入 `context-management-2025-06-27`，并可发送 `context_management` 字段 |
| 结构化输出 | 第一方/Foundry、模型支持、`tengu_tool_pear` 实验开启 | 加入 `structured-outputs-2025-12-15`，严格工具 Schema 才能生效 |
| Web Search | Vertex 的 Claude 4+，或 Foundry | 加入 `web-search-2025-03-05` |
| Tool Search | 当前模型和工具规模满足 Tool Search 条件 | 1P/Foundry 使用 `advanced-tool-use-2025-11-20`；Vertex/Bedrock 使用 `tool-search-tool-2025-10-19` |
| 全局 Prompt Cache scope | 第一方且实验 Beta 未禁用 | 加入 `prompt-caching-scope-2026-01-05`，配合全局缓存范围逻辑 |
| 思考内容裁剪 | 第一方、支持交错思考、交互模式且未开启 `showThinkingSummaries` | 加入 `redact-thinking-2026-02-12`，响应可能返回 redacted thinking，UI 只渲染占位 |
| Effort / Task Budget | 模型支持 effort；Task Budget 还要求第一方或 Foundry | 加入对应 Beta，并把 `effort` 或 `task_budget` 写进 `output_config` |

其中 Tool Search 最能说明为什么不能只说“Beta 打开了”：同一个功能在不同 provider 上使用不同 header。源码明确写了：

```ts
export function getToolSearchBetaHeader(): string {
  const provider = getAPIProvider()
  if (provider === 'vertex' || provider === 'bedrock') {
    return TOOL_SEARCH_BETA_HEADER_3P
  }
  return TOOL_SEARCH_BETA_HEADER_1P
}
```

而且，Tool Search 只有在真正启用、并且存在需要延迟发现的工具时才会把 header 放进请求。Beta header 是服务端协议能力，工具是否实际出现在当前请求里，还要经过本地工具池和动态发现逻辑。

### 为什么还要逐项判断条件

因为 Beta 能力会改变 API 接受的请求字段、响应块和 provider 兼容性。比如上下文管理需要额外的 `context_management`，结构化输出依赖严格 Schema，Tool Search 会让工具以 deferred/tool reference 方式出现；错误地把这些 header 发给不支持的 provider，可能直接得到 400。

源码还保留了 `ANTHROPIC_BETAS` 作为显式用户输入：它会按逗号切分、去掉空白后追加到自动计算的数组。SDK 传入的 Beta 则会先经过 allowlist；当前源码只允许 API key 用户传 `context-1m-2025-08-07`，订阅用户或其他未允许值会被忽略并打印 warning。自动 Beta 来自能力判断，用户 Beta 来自环境变量或 SDK，两条入口在合并前采用不同校验。

因此，“Beta 开关打开有什么新功能”更准确的答案是：**它解除一部分第一方实验能力的发送限制，随后 Claude Code 再按模型、provider 和运行模式逐项组合请求能力。**

本文仍以仓库中从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。为了突出主线，下面的源码片段会省略无关字段、日志和错误上报分支；省略处不改变本文讨论的控制流。

## 先建立一个简单模型

我们可以先把整个过程压缩成两步：

1. 在请求发出前，把内置工具、MCP 工具以及插件带来的 MCP 工具整理成一个可用工具池，并把契约发给模型。
2. 模型返回 `tool_use` 后，用同一批工具做名称匹配和输入校验，得到可以进入执行阶段的具体对象。

这两个阶段必须使用对应的契约，才能保证模型看到的名称与 Schema 和执行时的查找、校验一致。Claude Code 的 `Tool` 抽象把“告诉模型什么”和“宿主真正执行什么”放在同一个对象上。

![Claude Code 从工具池装配到调用前校验的流程](/images/posts/claude-code-source-reading-09/09-tool-contract-handdrawn.png)

图里的 `READY` 表示工具已经找到并通过输入校验。权限、Hooks、实际调用和结果回传属于下一阶段，后续章节会继续展开。

## Tool 把模型契约与宿主执行放在同一对象

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

**类型说明：** `Tool` 同时保存可被模型理解的名称和输入结构，以及宿主执行时需要的校验、并发属性和 `call`。因此，注册表保存一组具有完整契约的 `Tool` 对象，名称只是查找入口。

**参数说明：** `Input` 是 Zod 对象 Schema，默认任意对象形状；`Output` 默认 `unknown`；`P` 是进度数据类型，默认通用 `ToolProgressData`。`aliases` 提供可选别名，`searchHint` 提供工具搜索提示；`inputSchema` 是本地结构校验源，`inputJSONSchema` 可直接保留 MCP 服务端 Schema，省略时由 API 层从 Zod 转换。`description(input, options)` 根据当前输入生成描述；`options.isNonInteractiveSession` 区分宿主是否能交互，`toolPermissionContext` 提供权限规则，`tools` 提供当前工具池。`call()` 的 `args` 是解析后输入，`context` 是会话上下文，`canUseTool` 负责权限询问，`parentMessage` 关联 assistant 消息；`onProgress` 省略时只关闭该回调通道。`isConcurrencySafe`、`isReadOnly` 都基于本次输入判断，`isEnabled` 决定是否进入工具池，`name` 是主查找键；`validateInput` 省略时跳过第二层业务校验，但结构校验仍由 `inputSchema` 执行。

这份接口可以分成三组职责：

- `name`、`aliases`、`inputSchema` 和描述告诉模型“怎样调用”。
- `isEnabled`、`isConcurrencySafe`、`isReadOnly` 等元数据告诉宿主“是否暴露、怎样调度”。
- `validateInput`、权限检查和 `call` 决定“这一次具体输入能否执行，以及怎样执行”。

也就是说，Schema 和执行函数属于同一个对象。名称查找一旦命中，后续阶段就能继续使用同一份契约。

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

**函数说明：** `buildTool` 先铺开 `TOOL_DEFAULTS`，再写入基于 `def.name` 的展示名，最后铺开 `def`。因此，工具自己声明的同名字段优先级最高；其余字段沿用默认值。

**参数说明：** `def` 是 `ToolDef`，必须提供其余契约字段，并可覆盖所有默认实现。`isEnabled` 默认 `true`；`isConcurrencySafe`、`isReadOnly`、`isDestructive` 默认 `false`，各自的可选 `input` 只影响工具覆盖实现，默认函数直接返回保守值。`checkPermissions(input, _ctx)` 默认返回 `allow` 与原 `updatedInput`，随后仍进入通用权限系统；可选 `_ctx` 只为覆盖实现预留上下文。`toAutoClassifierInput` 默认返回空字符串，表示不给自动分类器额外摘要；`userFacingName` 的基础默认值为空，但 `buildTool` 会先改为 `def.name`，最终仍允许 `def.userFacingName` 覆盖。

这里的设计有一个很实用的结果：新增工具时，开发者可以复用默认实现；与调度、安全相关的未知信息则采用保守值。例如，`isConcurrencySafe` 缺省为 `false`，新工具会先按串行路径执行。

## 注册表其实是当前会话的一份 Tools 数组

源码把 `Tools` 定义为 `readonly Tool[]`。每次装配都会根据运行模式、权限上下文、MCP 连接状态和功能开关生成当前工具池，数组顺序还决定重名查找的首个命中项。

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

**参数说明：** `permissionContext` 包含权限模式和 allow、deny、ask 规则。源码中的外部模式包括 `acceptEdits`、`bypassPermissions`、`default`、`dontAsk`、`plan`；内部类型还包含受功能开关控制的 `auto` 和只用于内部传播的 `bubble`。这里传入完整上下文，工具可据此读取模式与规则。`isEnabled()` 是零参数方法，只依据工具闭包、环境和功能开关判断。

为什么先把 `isEnabled()` 的结果全部算出来，再做 `filter`？从这段源码可以确认，这样能保证每个候选工具在本次筛选中只调用一次。

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

**参数说明：** `permissionContext` 决定两类工具的 deny 过滤；`mcpTools` 是当前 AppState 中已经发现的 MCP `Tool` 数组，空数组表示当前未发现 MCP 工具。返回值仍是只读语义的 `Tools`。MCP 连接与工具发现发生在更早阶段，这个函数只合并已发现对象。

所以，“注册一个工具”至少有两层含义：代码中存在工具定义，只说明它有机会进入候选集；进入本轮 `options.tools`，才说明执行器真的可以按名称找到它。

## MCP 与插件怎样汇入同一份契约

MCP server 返回协议层 tool 描述，`restored-src/src/services/mcp/client.ts` 中的 `fetchToolsForClient` 会把它适配成 Claude Code 内部 `Tool`：

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

**参数说明：** `client` 必须是 `connected` 状态且声明 `tools` capability，否则函数返回空数组。`fullyQualifiedName` 由 server 与 tool 名组成；返回对象先展开基础 `MCPTool`，`name` 在 `skipPrefix` 为真时使用远端原名，否则使用限定名。`mcpInfo.serverName/toolName` 保留双向映射，`isMcp: true` 标记来源。`skipPrefix` 只在 SDK 类型连接且 `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` 为真时启用。`readOnlyHint: true` 同时让 `isReadOnly()` 与 `isConcurrencySafe()` 返回真，假值回退到 `false`；`inputJSONSchema` 原样保存远端 `inputSchema`。

这里还要区分两份 Schema 的用途。MCP 适配器保留远端 `inputJSONSchema`，API 层会优先把它发给模型；但基础 `MCPTool.inputSchema` 是允许额外字段的 Zod 对象。也就是说，本地通用 `safeParse` 对 MCP 参数只做宽松对象检查，远端 JSON Schema 的最终约束还要由模型生成阶段和 MCP server 承担。

插件工具通过 MCP 汇入注册表。启用的插件可以声明 MCP server，`restored-src/src/services/mcp/config.ts` 会把它们收集进 MCP 配置；连接和发现完成后，对应工具再进入 `mcpTools`：

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

**参数说明：** `loadAllPluginsCacheOnly()` 是零参数函数，返回结果中的 `enabled` 与 `errors` 取决于运行时插件状态；`getPluginMcpServers(plugin, mcpErrors)` 接收一个已启用插件和可累积错误的数组，返回服务器对象或 `undefined`，合并逻辑只处理已返回对象。插件贡献的命令、Agent、Skill 和 Hooks进入各自注册路径，本文的 `Tool` 注册表只接收工具对象。

于是三种来源在执行前完成了汇合：

- 内置工具直接实现或通过 `buildTool` 得到 `Tool`。
- 普通 MCP 工具由 `fetchToolsForClient` 适配成 `Tool`。
- 插件声明的 MCP server 先进入 MCP 连接流程，发现的工具再适配成 `Tool`。

来源不同，进入 `options.tools` 以后使用的是同一套名称查找、输入校验和执行入口。

## tool_use 怎样找到真正的工具

模型响应到达工具执行层后，`runToolUse` 首先按名称查找工具，再进入输入校验和调用。名称匹配逻辑非常直接：

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

**函数说明：** `toolMatchesName` 先比较主名称，再检查别名；`findToolByName` 返回数组中第一个匹配对象。匹配失败时返回 `undefined`，调用方随后生成“工具不存在”的错误结果；查找过程采用精确名称和别名比较。

**参数说明：** `tool.aliases` 可以是字符串数组或 `undefined`；可选链之后的结果再用 `?? false` 回退，所以 `undefined` 会产生“不匹配”结果。`name` 是模型 `tool_use.name` 提供的任意字符串，源码只约束其为字符串。`tools` 的顺序会影响同名对象谁先命中，不过正常装配路径已经按名称去重。

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

**参数说明：** 原函数的 `toolUse` 含 `name`、`input`、`id`；`assistantMessage` 提供父消息和关联 UUID；`canUseTool` 是后续权限回调；`toolUseContext.options.tools` 是本轮工具池。查找失败时，yield 对象的 `message` 是一条 user message；其 `content` 数组包含 `type: 'tool_result'`、错误文本、`is_error: true` 和原始 `tool_use_id`。`toolUseResult` 给宿主保留错误摘要，`sourceToolAssistantUUID` 指回发起调用的 assistant 节点。名称匹配与 alias fallback 均来自 `runToolUse` 的真实分支。

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

**函数说明：** `checkPermissionsAndCallTool` 先用 Zod `safeParse` 验证并解析输入。只有 `success=true` 才把 `parsedInput.data` 传给 `validateInput`。任意一层失败都会由真实的 `createUserMessage` 内联构造错误 `tool_result` 返回给模型，`call` 只接收两层校验均成功的数据；代码块已经用注释明确标出省略的消息字段。

**参数说明：** 原函数的 `input` 是布尔值、字符串或数字组成的对象，但各工具的 Zod Schema 可以进一步约束字段。`safeParse` 返回成功或失败的判别联合。`validateInput` 可为 `undefined`；可选调用在这种情况下得到 `undefined`，不会进入失败分支。它的返回值只能是 `{ result: true }`，或 `{ result: false, message: string, errorCode: number }`。因此，业务校验失败必须同时提供给模型看的消息和用于记录的数字错误码。

两层校验解决的是不同问题。例如，一个文件工具可以先用 Schema 确认 `file_path` 是字符串，再在 `validateInput` 中检查文件是否存在、大小是否超过限制、路径是否符合当前权限上下文。把这两件事合成一个 Schema 并不现实，因为第二类条件依赖运行时状态。

校验失败会被包装成 `is_error: true` 的 `tool_result`，关联原来的 `tool_use_id`，再交还给对话循环。模型因此有机会修正参数并重新调用，进程继续处理后续消息。

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

**参数说明：** `options.tools` 与 `options.mcpClients` 是当前工具和连接快照，`isNonInteractiveSession` 区分无头/SDK 与交互式路径；`maxBudgetUsd` 传入时启用金额检查，`refreshTools` 存在时可取得 MCP 中途连接后的新工具集。`abortController` 传播取消，`readFileState` 保存 Read-before-Write 凭据，`getAppState`/`setAppState` 读取和更新应用状态。`requestPrompt(sourceName, toolInputSummary)` 只在宿主支持交互时出现：`sourceName` 标记请求来源，摘要字符串用于展示，`null` 或省略都使 UI 缺少摘要内容；返回函数处理具体 `PromptRequest`。`toolUseId` 传入时关联当前调用，省略时由外层上下文维持关系。

`ToolUseContext` 在这条链路上解决三个明确问题：查找当前真正可用的工具、让业务校验读取运行状态、把取消与交互能力传入具体调用。

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
3. MCP 工具会被适配成内部 `Tool`；插件声明的 MCP server 也沿这条路径汇合并进入统一注册表。
4. `runToolUse` 只做精确主名称或别名匹配。未知工具、结构错误和业务校验失败都会变成与原 `tool_use_id` 关联的错误结果。
5. 通过两层输入校验只代表调用已经具备进入权限与执行阶段的条件，不代表权限已批准，更不代表执行成功。

把这条链路记成一句话就是：先裁剪能力，再按名取对象，最后用对象自己的契约验证输入。

## 留给下一篇的问题

你知道 Claude Code 自带哪些 tool 吗？

## 参考资料

- [Anthropic 工具调用实现指南](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use)

- [Claude Code 工具参考](https://code.claude.com/docs/en/tools-reference)
