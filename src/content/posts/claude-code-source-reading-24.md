---
title: "Claude Code源码解读24：如何隔离上下文并委派任务"
published: 2026-07-24T16:47:11+08:00
updated: 2026-07-24T16:47:11+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-24/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 本章先建立三个概念

- **上下文隔离**：子 Agent 使用独立窗口读取大文件和执行工具，主会话只接收压缩后的成果。

- **能力委派**：父会话选择子 Agent 的模型、工具、权限和任务说明，形成受限执行范围。

- **结果压缩**：子循环的完整轨迹留在自身上下文，回传内容聚焦结论、证据和后续动作。

![主 Agent 与 Subagent 的上下文和能力边界](/images/posts/claude-code-source-reading-24/24-subagent-boundary-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇留下的问题是：当一个任务需要独立上下文和专门能力时，Claude Code 如何创建 subagent、选择 Agent 定义，并在主线程与子线程之间传递结果？

先说结论：**Claude Code 把 subagent 做成一次受约束的 Agent 工具调用，为子任务重新装配上下文、工具、权限和 transcript。**

主线程先发出 `Agent` 的 `tool_use`，其中至少包含任务说明和 prompt。`AgentTool.call()` 再从当前生效的 Agent 定义中选出一种角色，解析模型、工具、权限模式和运行方式，最后把这些参数交给 `runAgent()`。`runAgent()` 会创建新的 agent ID、消息数组、文件读取缓存、工具上下文和 sidechain transcript，然后复用同一个 `query()` 内核独立执行。

这里有两个容易混淆的地方。

第一，普通 subagent 默认不会继承父会话的对话历史。父线程必须在 `prompt` 里交代目标、已知事实、文件路径和约束。2.1.88 还有一条 feature-gated 的 Fork 路径：省略 `subagent_type` 时，它可以把父消息过滤后带入子线程。但这是实验分支，不能把它当成所有 subagent 的通用语义。

第二，“隔离上下文”覆盖消息、工具集合和 transcript，子线程仍会读取当前项目环境，并通过包装后的 `getAppState()` 看见权限状态。同步 subagent 可以共享一部分父级回调；后台 subagent 的普通状态写入被隔离，任务注册则写回根 `AppState`，供父线程观察和停止。

结果回传取决于运行方式：前台执行会把最后一条 assistant 文本整理成当前 `Agent` 调用的 `tool_result`；后台执行先返回 agent ID 和 output file，完成后再向消息队列写入 `<task-notification>`。失败和取消也沿这两条路径分别收束。

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面只截取证明控制流所需的真实短代码，省略 UI、遥测、内部构建分支和无关参数；还原目录只用于定位本文引用的源码。

## Subagent 运行一条独立的子 Query Loop

先看四个概念怎样共同确定委派边界。

**Subagent** 是由当前 Agent 委派出去的一段独立推理。它有自己的 prompt、消息历史、工具调用和结束条件，适合边界清楚、需要多轮搜索或专门角色的工作，例如大范围代码探索、独立审查和实现计划。任务粒度应足以覆盖额外的上下文与模型调用成本。

**Agent 定义** 是这段推理的运行配置。它至少给出 `agentType`、适用说明和 system prompt，还可以限制工具、选择模型、设置 `permissionMode`、预载 Skill、连接 MCP、限制最大轮数或强制后台运行。内置的 `general-purpose`、`Explore`、`Plan` 和用户项目里的 `.claude/agents/*.md`，最后都会归一成 `AgentDefinition`。

**上下文隔离** 是把子任务的中间噪声留在 sidechain。比如探索代码时产生的几十次 Glob、Grep、Read 和 tool result，不必全部进入主会话；父线程通常只需要最终结论。这既减少主上下文膨胀，也让不同调查可以独立进行。

**前台/后台** 描述父工具调用是否等待。两者最终都调用 `runAgent()`：前台持续消费异步消息流并直接返回结果；后台把同一条消息流交给 `LocalAgentTask` 管理，父线程先恢复交互，结果随后通过通知回来。

整条链可以先看成这张图：

![Claude Code subagent 选择、隔离与结果回传手绘图](/images/posts/claude-code-source-reading-24/24-subagent-delegation-handdrawn.png)

图中最重要的是两条返回线：同步结果属于原来的 `tool_use → tool_result`；后台结果属于后续的 task notification。后台 Agent 启动时只返回任务坐标，答案要等终态通知。

## Agent 定义先被发现，再按名称覆盖

Claude Code 启动时并不只加载一组固定角色。`getAgentDefinitionsWithOverrides()` 会读取 `agents` 子目录中的 Markdown，加载插件 Agent，再与 built-in 合并：

```ts
const markdownFiles = await loadMarkdownFilesForSubdir('agents', cwd)

// 省略 Markdown 解析与失败文件收集

const pluginAgents = await loadPluginAgents()
const builtInAgents = getBuiltInAgents()
const allAgentsList = [
  ...builtInAgents,
  ...pluginAgents,
  ...customAgents,
]
const activeAgents = getActiveAgentsFromList(allAgentsList)
```

**函数说明：** `getAgentDefinitionsWithOverrides()` 位于 `restored-src/src/tools/AgentTool/loadAgentsDir.ts`。它把 built-in、plugin 和各配置来源的 Markdown Agent 汇入 `allAgents`，再计算真正可选的 `activeAgents`。省略 `name` 的 Markdown 会被当作同目录参考文档静默跳过；像 Agent 定义却解析失败的文件才进入 `failedFiles`。最外层加载失败时回退 built-in，CLI 仍可启动。

**参数说明：** `cwd` 是必填的项目路径，决定从哪里发现项目级定义。`loadMarkdownFilesForSubdir('agents', cwd)` 返回的 `source` 可包含 `userSettings`、`projectSettings`、`policySettings` 等设置来源。返回值中的 `failedFiles` 是数组或 `undefined`：零项失败时省略，类型排除 `null`。

同名定义按来源顺序依次写入同一个 `Map`，后写来源可以覆盖先写来源：

```ts
const agentGroups = [
  builtInAgents,
  pluginAgents,
  userAgents,
  projectAgents,
  flagAgents,
  managedAgents,
]

const agentMap = new Map<string, AgentDefinition>()
for (const agents of agentGroups) {
  for (const agent of agents) {
    agentMap.set(agent.agentType, agent)
  }
}
return Array.from(agentMap.values())
```

**函数说明：** 这段来自 `getActiveAgentsFromList()`。相同 `agentType` 后写覆盖前写，因此静态顺序是 built-in → plugin → user → project → flag → managed，越靠后的来源优先级越高。`allAgents` 仍保留全部定义，`activeAgents` 才是消除同名冲突后的集合。

**参数说明：** `allAgents` 必须是 `AgentDefinition[]`；调用方要在进入函数前把缺省来源归一为空数组。源码明确识别的 source 包括 `'built-in'`、`'plugin'`、`'userSettings'`、`'projectSettings'`、`'flagSettings'`、`'policySettings'`。这里的优先级来自数组顺序和 `Map.set()` 的覆盖行为，与文件修改时间无关。

Markdown 正文会成为 system prompt，frontmatter 则决定运行边界。2.1.88 可确认的主要字段包括：

- `name` 与 `description` 必填，分别成为 `agentType` 与 `whenToUse`；
- `tools`、`disallowedTools` 是工具规格数组；`tools` 缺省或精确为 `['*']` 都表示经过通用过滤后的全部可用工具；
；
- `permissionMode` 的外部候选值是 `default`、`plan`、`acceptEdits`、`bypassPermissions`、`dontAsk`，内部构建还可能通过 feature 暴露 `auto`；
- `maxTurns` 必须是正整数；`background` 只有布尔 `true` 或字符串 `'true'` 会保存为强制后台，`false` 与缺省都归一为 `undefined`；
- `memory` 只能是 `user`、`project`、`local`；`isolation` 在外部构建只能是 `worktree`，内部构建还可能有 `remote`；
- `skills`、`mcpServers`、`hooks`、`effort` 与 `initialPrompt` 会继续影响子线程，但是否可用还取决于构建开关、策略和运行时资源。

这说明 Agent 定义同时决定角色提示、能力面和生命周期，所以项目里的同名项属于配置覆盖。

## `Agent` 工具把委派意图变成明确输入

模型并不直接调用 `runAgent()`，它先调用一个有 Schema 的 `Agent` 工具：

```ts
const baseInputSchema = lazySchema(() => z.object({
  description: z.string()
    .describe('A short (3-5 word) description of the task'),
  prompt: z.string()
    .describe('The task for the agent to perform'),
  subagent_type: z.string().optional()
    .describe('The type of specialized agent to use for this task'),
  model: z.enum(['sonnet', 'opus', 'haiku']).optional()
    .describe("Optional model override for this agent. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model, or inherits from the parent."),
  run_in_background: z.boolean().optional()
    .describe('Set to true to run this agent in the background. You will be notified when it completes.'),
}))
```

**类型说明：** `baseInputSchema` 位于 `restored-src/src/tools/AgentTool/AgentTool.tsx`。它规定普通 subagent 委派的最小输入面。完整 Schema 还可能加入 `name`、`team_name`、`mode`、`isolation` 与 `cwd`；其中团队参数属于下一篇，`cwd` 和部分隔离方式受构建条件控制。

**字段说明：** `description` 与 `prompt` 是必填字符串，Schema 本身只校验类型；工具描述要求 `description` 写成 3–5 个词，这属于给模型的语义说明。`subagent_type` 是开放字符串或 `undefined`，必须在运行时命中 active Agent。调用参数 `model` 只接受 `'sonnet' | 'opus' | 'haiku' | undefined`，它优先于 Agent frontmatter；该工具字段的类型排除 `null` 与 `'inherit'`。`run_in_background` 是 `boolean | undefined`；省略时仍可能被定义中的 `background:true`、Coordinator 或 feature gate 强制切到后台。

选 Agent 时，显式类型优先；如果未指定，行为还受 Fork 实验开关影响：

```ts
const effectiveType =
  subagent_type ??
  (isForkSubagentEnabled()
    ? undefined
    : GENERAL_PURPOSE_AGENT.agentType)
const isForkPath = effectiveType === undefined
let selectedAgent: AgentDefinition
if (isForkPath) {
  selectedAgent = FORK_AGENT
} else {
  const allAgents =
    toolUseContext.options.agentDefinitions.activeAgents
  const { allowedAgentTypes } =
    toolUseContext.options.agentDefinitions
  const agents = filterDeniedAgents(
    allowedAgentTypes
      ? allAgents.filter(a => allowedAgentTypes.includes(a.agentType))
      : allAgents,
    appState.toolPermissionContext,
    AGENT_TOOL_NAME,
  )
  const found = agents.find(
    agent => agent.agentType === effectiveType,
  )
  if (!found) {
    const agentExistsButDenied = allAgents.find(
      agent => agent.agentType === effectiveType,
    )
    if (agentExistsButDenied) {
      const denyRule = getDenyRuleForAgent(
        appState.toolPermissionContext,
        AGENT_TOOL_NAME,
        effectiveType,
      )
      throw new Error(
        `Agent type '${effectiveType}' has been denied by permission rule '${AGENT_TOOL_NAME}(${effectiveType})' from ${denyRule?.source ?? 'settings'}.`,
      )
    }
    throw new Error(
      `Agent type '${effectiveType}' not found. ` +
      `Available agents: ${agents.map(a => a.agentType).join(', ')}`,
    )
  }
  selectedAgent = found
}
```

**代码说明：** 这段来自 `AgentTool.call()` 的选择主干。真实源码在找不到定义时会区分“存在但被 `Agent(Type)` 权限规则拒绝”和“根本不存在”，并抛出不同错误；Fork 子线程也有递归 guard，避免继续 Fork 自己。这里省略了团队分流、MCP 前置检查和更前面的 Fork 递归 guard。

**参数说明：** `subagent_type` 显式字符串始终优先。它为 `undefined` 且 Fork gate 关闭时回退 `'general-purpose'`；gate 打开时 `undefined` 成为 Fork 的路由标志。`allowedAgentTypes` 是 `string[] | undefined`，有值时先裁剪候选集合，空数组意味着零个可选类型。`filterDeniedAgents()` 还会应用 `Agent(AgentName)` 形式的 deny 规则。因此，定义加载成功后仍需通过当前会话的候选裁剪与权限过滤。

**字段说明：** `effectiveType` 保存显式类型或回退类型，`isForkPath` 标记 Fork 分支，`selectedAgent` 保存最终定义。普通分支从 `allAgents` 取完整候选，以 `allowedAgentTypes` 生成 `agents` 子集，再由 `found` 保存名称命中项；`agentExistsButDenied` 与 `denyRule` 用于把权限拒绝和名称缺失映射成不同错误。

工具 prompt 会把每个 active Agent 的 `whenToUse` 和工具摘要暴露给模型，让模型先按用途选择。但这只是引导。最终的名称匹配、MCP 前置条件和 deny 规则仍在 `call()` 内再次检查，不能把 prompt 列表当成安全边界。

## 模型、system prompt 与消息分层配置

选中定义后，Claude Code 分别处理模型、system prompt 和初始消息。

模型优先级由 `getAgentModel()` 固定下来：

```ts
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: ModelAlias,
  permissionMode?: PermissionMode,
): string {
  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    return parseUserSpecifiedModel(process.env.CLAUDE_CODE_SUBAGENT_MODEL)
  }

  if (toolSpecifiedModel) {
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) {
      return parentModel
    }
    const model = parseUserSpecifiedModel(toolSpecifiedModel)
    return applyParentRegionPrefix(model, toolSpecifiedModel)
  }

  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()
  if (agentModelWithExp === 'inherit') {
    return getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }
  if (aliasMatchesParentTier(agentModelWithExp, parentModel)) {
    return parentModel
  }
  const model = parseUserSpecifiedModel(agentModelWithExp)
  return applyParentRegionPrefix(model, agentModelWithExp)
}
```

**函数说明：** `getAgentModel()` 位于 `restored-src/src/utils/model/agent.ts`。完整源码还处理 Bedrock region prefix，以及“裸 family alias 与父模型同 tier 时保留父模型精确 ID”的兼容逻辑。控制流优先级是环境变量 → 工具调用显式模型 → Agent 定义 → 默认 `inherit`。

**参数说明：** `agentModel` 为定义中的开放字符串或 `undefined`；`parentModel` 是必填的当前主模型字符串；`toolSpecifiedModel` 在 AgentTool 路径只可能是 `'sonnet' | 'opus' | 'haiku' | undefined`；`permissionMode` 可省略，`inherit` 解析时回退 `'default'`。

**字段说明：** `agentModelWithExp` 保存定义值或默认 subagent 模型；当它取 `'inherit'` 时，传给 `getRuntimeMainLoopModel()` 的 `permissionMode` 缺省为 `'default'`，`mainLoopModel` 取 `parentModel`，`exceeds200kTokens` 固定为 `false`。

普通路径调用定义自己的 `getSystemPrompt()`，再补环境信息；初始消息只有新任务：

```ts
const agentPrompt = selectedAgent.getSystemPrompt({ toolUseContext })
enhancedSystemPrompt = await enhanceSystemPromptWithEnvDetails(
  [agentPrompt],
  resolvedAgentModel,
  additionalWorkingDirectories,
)
promptMessages = [createUserMessage({ content: prompt })]
```

**代码说明：** 这段位于 `AgentTool.call()` 的 normal path。普通 subagent 的“角色”和“任务”分属两个通道：定义正文进入 system prompt，本次委派内容进入第一条 user message。完整代码会捕获 system prompt 增强失败并继续，让 `runAgent()` 有机会重新构造。

**参数说明：** `selectedAgent.getSystemPrompt()` 对 built-in 可以接收精简的 `toolUseContext`，custom/plugin 定义则通过闭包返回 Markdown 正文。`additionalWorkingDirectories` 来自当前权限上下文，是路径字符串数组；空数组合法。`prompt` 是调用者提供的原始开放字符串，不会自动拼接父会话摘要。

**字段说明：** `agentPrompt` 保存定义生成的角色提示，`enhancedSystemPrompt` 保存补入环境详情后的 system prompt，`resolvedAgentModel` 决定增强时使用的模型信息；`promptMessages` 是消息数组，其中 `content` 原样取本次 `prompt`。

这就是为什么普通 subagent 的 prompt 必须像交接给一个刚加入项目的同事：它不知道主线程前面试过什么，也不知道“这个问题”指的是哪一个问题。上下文隔离节省了噪声，代价是调用者必须明确交接。

## 普通 subagent 与 Fork 的上下文边界不同

真正进入 `runAgent()` 时，普通路径把 `forkContextMessages` 设为 `undefined`；Fork 路径才传父消息：

```ts
const runAgentParams: Parameters<typeof runAgent>[0] = {
  agentDefinition: selectedAgent,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync: shouldRunAsync,
  model: isForkPath ? undefined : model,
  availableTools: isForkPath
    ? toolUseContext.options.tools
    : workerTools,
  forkContextMessages: isForkPath
    ? toolUseContext.messages
    : undefined,
  ...(isForkPath && { useExactTools: true }),
}
```

**代码说明：** 这段来自 `AgentTool.call()` 组装 `runAgentParams` 的位置。Fork 为复用父请求的 prompt cache，会继承父 system prompt、父消息、精确工具数组和 thinking config；普通 subagent 则使用独立组装的 worker tool pool。源码注释明确把两条路径分开。

**参数说明：** `isAsync` 是最终运行方式，来源还包括 Agent 定义、Coordinator 与 feature gate；`model` 在 Fork 时固定传 `undefined`，避免换模型破坏 cache 前缀。`forkContextMessages` 类型为 `Message[] | undefined`：`undefined` 跳过父消息继承，显式数组会先过滤未完成的 tool call。`useExactTools` 只有 Fork 路径设为 `true`，普通路径省略并按定义继续过滤。

**字段说明：** `agentDefinition` 保存 `selectedAgent`；`promptMessages`、`toolUseContext`、`canUseTool` 分别提供初始任务、父工具上下文与权限函数；`availableTools` 在 Fork 时取父工具数组，普通路径取 `workerTools`。这些字段与 `isAsync`、`model`、`forkContextMessages`、`useExactTools` 一起组成 `runAgentParams`。

`runAgent()` 随后把两部分消息拼起来，并为文件读取状态选择不同起点：

```ts
const contextMessages: Message[] = forkContextMessages
  ? filterIncompleteToolCalls(forkContextMessages)
  : []
const initialMessages: Message[] = [
  ...contextMessages,
  ...promptMessages,
]

const agentReadFileState =
  forkContextMessages !== undefined
    ? cloneFileStateCache(toolUseContext.readFileState)
    : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
```

**代码说明：** 这段位于 `restored-src/src/tools/AgentTool/runAgent.ts`。Fork 会复制父文件状态缓存，普通 subagent 从新的受限缓存开始。无论哪条路径，`initialMessages` 都是一个新的数组；子线程后续追加消息不会直接改写父消息数组。

**参数说明：** 条件一处用 truthy 判断、一处用 `!== undefined`。因此空数组 `[]` 会得到空 `contextMessages`，但仍会触发父文件缓存克隆；`undefined` 才是普通 fresh context。`filterIncompleteToolCalls()` 用于避免把缺少匹配 result 的父 `tool_use` 发送给 API，不代表它会压缩或总结完整历史。

所以，项目环境共享、消息历史隔离、文件缓存独立是三个不同维度。共享 cwd 只提供项目坐标；父消息继承与否由 `forkContextMessages` 单独决定。

## 工具集合与权限决策是两道门

Agent 定义先裁工具集合。`resolveAgentTools()` 的规则很直接：

```ts
const hasWildcard =
  agentTools === undefined ||
  (agentTools.length === 1 && agentTools[0] === '*')

if (hasWildcard) {
  return {
    hasWildcard: true,
    validTools: [],
    invalidTools: [],
    resolvedTools: allowedAvailableTools,
  }
}

for (const toolSpec of agentTools) {
  const { toolName, ruleContent } =
    permissionRuleValueFromString(toolSpec)

  if (toolName === AGENT_TOOL_NAME) {
    if (ruleContent) {
      allowedAgentTypes = ruleContent.split(',').map(s => s.trim())
    }
    if (!isMainThread) {
      validTools.push(toolSpec)
      continue
    }
  }

  const tool = availableToolMap.get(toolName)
  if (tool) {
    validTools.push(toolSpec)
    if (!resolvedToolsSet.has(tool)) {
      resolved.push(tool)
      resolvedToolsSet.add(tool)
    }
  } else {
    invalidTools.push(toolSpec)
  }
}
```

**函数说明：** `resolveAgentTools()` 位于 `restored-src/src/tools/AgentTool/agentToolUtils.ts`。它先应用通用 subagent 过滤和 `disallowedTools`，再展开 `tools` allowlist。子 Agent 默认不能通过 `Agent` 工具无限递归委派；定义里写 `Agent(type...)` 主要用于记录允许的子类型，普通 subagent 路径会跳过实际工具解析。

**参数说明：** `agentTools` 为 `string[] | undefined`。省略字段或传入长度精确为 1 的 `['*']` 会选择 wildcard 工具池；空数组 `[]` 会解析为零个工具。`disallowedTools` 缺省回退空集合，并在 allowlist 之前生效。`isAsync` 默认 `false`，它影响可交互工具过滤；`isMainThread` 默认 `false`，为真时才跳过 subagent 通用过滤。

**字段说明：** `hasWildcard` 标记省略工具列表或单个 `'*'`；该分支返回空的 `validTools`、`invalidTools`，并让 `resolvedTools` 直接取 `allowedAvailableTools`。显式列表分支把每个 `toolSpec` 拆成 `toolName` 与 `ruleContent`，用 `availableToolMap` 查找 `tool`，再分别写入 `validTools`、`invalidTools`、`resolved` 和去重集合 `resolvedToolsSet`；`allowedAgentTypes` 保存 `Agent(...)` 中声明的子类型。

“工具出现在 Tool Pool”只说明模型可以请求它，不说明调用一定获准。`runAgent()` 还会给子线程包装一份权限视图：

```ts
const shouldAvoidPrompts =
  canShowPermissionPrompts !== undefined
    ? !canShowPermissionPrompts
    : agentPermissionMode === 'bubble'
      ? false
      : isAsync

if (shouldAvoidPrompts) {
  toolPermissionContext = {
    ...toolPermissionContext,
    shouldAvoidPermissionPrompts: true,
  }
}
```

**代码说明：** 这段来自 `runAgent()` 内部的 `agentGetAppState()`。；同步 Agent 默认仍可沿父终端处理确认。内部的 `'bubble'` 模式是特殊例外，它允许后台权限问题冒泡到共享终端，但不在外部用户可配置的 `PERMISSION_MODES` 列表中。

**参数说明：** `canShowPermissionPrompts` 是 `boolean | undefined`，显式值优先；`true` 得到 `shouldAvoidPrompts=false`，`false` 得到 `true`。它省略时，`agentPermissionMode === 'bubble'` 允许提示，否则直接使用 `isAsync`。设置“避免提示”后，需要询问而无法询问的工具会走权限引擎的非交互拒绝路径。

**字段说明：** `shouldAvoidPrompts` 是最终布尔值；为真时，代码保留原 `toolPermissionContext`，只把 `shouldAvoidPermissionPrompts` 覆盖为 `true`。

Agent 定义中的 `permissionMode` 只在允许覆盖的父模式下生效。父模式为 `bypassPermissions` 或 `acceptEdits` 时保持父模式；feature-gated 的 `auto` 也可能保持。普通 AgentTool 自身把 `isReadOnly()` 返回为 `true`，真正的风险检查由子线程内部的 Bash、Edit、Write 等工具执行。

因此，subagent 安全边界必须分两层理解：

1. `tools`/`disallowedTools` 决定模型能看见哪些工具；
2. permission rules、mode、hook 与交互能力决定一次具体调用是 allow、ask 还是 deny。

两层会按顺序共同约束工具调用。

## `createSubagentContext()` 隔离可变状态，但保留必要回路

工具和消息准备好后，`runAgent()` 调用公共的上下文工厂：

```ts
const agentToolUseContext = createSubagentContext(toolUseContext, {
  options: agentOptions,
  agentId,
  agentType: agentDefinition.agentType,
  messages: initialMessages,
  readFileState: agentReadFileState,
  abortController: agentAbortController,
  getAppState: agentGetAppState,
  shareSetAppState: !isAsync,
  shareSetResponseLength: true,
})
```

**函数说明：** `createSubagentContext()` 定义在 `restored-src/src/utils/forkedAgent.ts`。它默认克隆文件状态、建立新的 Set 和 denial tracking，把普通 `setAppState`、UI 回调、文件历史更新等可变入口设为 no-op。`runAgent()` 再按前台/后台选择性共享必要字段。

**参数说明：** `options` 是子 Agent 专属工具与模型配置；`agentId` 是新生成的字符串 ID；`agentType` 取 `agentDefinition.agentType`；`messages` 是前述新数组；`readFileState` 取 `agentReadFileState`；`abortController` 前台通常共享父 controller，后台通常使用独立 controller；`getAppState` 取包装后的 `agentGetAppState`。`shareSetAppState` 在这里等于 `!isAsync`：同步为 `true`，后台为 `false`。`shareSetResponseLength` 固定为 `true`，所以子 Agent 输出仍计入父级响应指标。所有省略字段按 `createSubagentContext()` 的隔离默认值处理，不用 `null` 表示继承。

隔离按状态通道分别配置。返回对象里的 `setAppStateForTasks` 始终指向根 store：

```ts
setAppState: overrides?.shareSetAppState
  ? parentContext.setAppState
  : () => {},

setAppStateForTasks:
  parentContext.setAppStateForTasks ?? parentContext.setAppState,
```

**代码说明：** 这段来自 `createSubagentContext()`。后台 subagent 的普通状态写入可以被隔离，但它自己启动的 Bash task 仍必须注册到根 `AppState`，这样主线程才能展示、停止和在 Agent 结束时清理这些子任务。源码注释明确说明这是为了避免未注册进程变成孤儿。

**参数说明：** `shareSetAppState` 是 `boolean | undefined`，只有显式 truthy 才共享；否则 `setAppState` 是 no-op。`setAppStateForTasks` 先沿用父上下文已有的根通道，缺失时回退父 `setAppState`；该字段始终返回函数。

随后，这个子上下文重新进入与主线程相同的 `query()`：

```ts
for await (const message of query({
  messages: initialMessages,
  systemPrompt: agentSystemPrompt,
  userContext: resolvedUserContext,
  systemContext: resolvedSystemContext,
  canUseTool,
  toolUseContext: agentToolUseContext,
  querySource,
  maxTurns: maxTurns ?? agentDefinition.maxTurns,
})) {
  // record sidechain and yield progress/result messages
}
```

**函数说明：** 这段位于 `runAgent()` 的执行尾部。Subagent 复用第 06 篇分析过的 Query Loop，因此同样能产生 assistant message、`tool_use`、`tool_result`、继续推理与结束；输入上下文、工具面和 transcript 归属则由子线程参数决定。

**参数说明：** `maxTurns` 是调用方 override 的 `number | undefined`，优先于 `agentDefinition.maxTurns`；两者都省略时交给 `query()` 的默认停止逻辑。`querySource` 标记调用来源。每条可记录消息会追加到 agent ID 对应的 sidechain JSONL；写入失败只记录 debug 日志，不会阻断模型执行。

其余字段构成子循环的完整请求边界：`messages` 是子线程初始链，`systemPrompt` 是 Agent 角色与环境说明，`userContext`、`systemContext` 分别承载用户侧和系统侧上下文，`canUseTool` 执行权限决策，`toolUseContext` 提供本 Agent 的工具、缓存、取消与状态通道。它们彼此独立传入，因此替换 Agent system prompt 不会顺带替换工具权限或消息历史。

## 前台路径：边运行边汇报，最后返回一个 `tool_result`

同步路径直接消费 `runAgent()` 的 async iterator。它把 assistant 与 user 消息收进 `agentMessages`，将工具进度转发给父 UI；如果任务运行中被切到后台，则停止当前 iterator，并以相同 agent ID 重新走 async continuation。

正常完成后，`finalizeAgentTool()` 提取最后一条 assistant 文本：

```ts
const lastAssistantMessage = getLastAssistantMessage(agentMessages)
if (lastAssistantMessage === undefined) {
  throw new Error('No assistant messages found')
}

let content = lastAssistantMessage.message.content.filter(
  _ => _.type === 'text',
)
if (content.length === 0) {
  for (let i = agentMessages.length - 1; i >= 0; i--) {
    const m = agentMessages[i]!
    if (m.type !== 'assistant') continue
    const textBlocks = m.message.content.filter(_ => _.type === 'text')
    if (textBlocks.length > 0) {
      content = textBlocks
      break
    }
  }
}
```

**函数说明：** `finalizeAgentTool()` 位于 `agentToolUtils.ts`。它优先取最后一条 assistant message 的 text block；如果最后一条只含 `tool_use`，真实源码会反向寻找最近的文本，避免父线程只收到空结果。它同时统计工具次数、token、耗时并写遥测。

**参数说明：** `agentMessages` 是本次子线程累计的 `Message[]`；assistant 消息数量为 0 时抛错。`agentId` 是 sidechain/task 的标识。`metadata.isAsync` 只用于结果统计，不改变提取算法。输出 `content` 是 `{type:'text', text:string}[]` 的提取结果；usage 中部分 cache 字段允许 `null`，而缺失结果使用 `undefined`。

`AgentTool.call()` 最后返回 `status:'completed'`、原 prompt、最终文本、agent ID、usage 与可选 worktree 信息。工具框架再把它映射成父消息中的 `tool_result`。这正是上下文隔离的收益：父线程拿到结论和计量信息，不拿到子 Agent 每一步搜索噪声。

同步执行出错时还有一个边界：已收集 assistant 消息时，源码会尝试返回部分结果；数量为 0 时才把错误重新抛给工具框架。用户取消产生 `AbortError`，按取消状态返回。

## 后台路径：先注册 `LocalAgentTask`，结果稍后回流

最终是否后台运行由多项条件共同决定：

```ts
const shouldRunAsync = (
  run_in_background === true ||
  selectedAgent.background === true ||
  isCoordinator ||
  forceAsync ||
  assistantForceAsync ||
  (proactiveModule?.isProactiveActive() ?? false)
) && !isBackgroundTasksDisabled
```

**代码说明：** 这段来自 `AgentTool.call()`。用户显式请求、Agent 定义、Coordinator、Fork feature、Assistant 模式和 Proactive 状态都可能让 subagent 从一开始异步运行；全局禁用后台任务时，最后的 `&&` 会把结果压回前台。

**参数说明：** `run_in_background` 与 `selectedAgent.background` 都只有严格等于 `true` 才触发。`forceAsync` 来自 Fork feature gate，不只影响 Fork 自己，注释说明 gate 开启时会统一强制所有 spawn 异步。`proactiveModule?.isProactiveActive()` 在模块不存在时通过 `?? false` 回退。

后台启动先注册 Task：

```ts
const taskState: LocalAgentTaskState = {
  ...createTaskStateBase(
    agentId,
    'local_agent',
    description,
    toolUseId,
  ),
  status: 'running',
  agentId,
  prompt,
  selectedAgent,
  agentType: selectedAgent.agentType ?? 'general-purpose',
  abortController,
  retrieved: false,
  lastReportedToolCount: 0,
  lastReportedTokenCount: 0,
  isBackgrounded: true,
  pendingMessages: [],
  retain: false,
  diskLoaded: false,
}
registerTask(taskState, setAppState)
```

**函数说明：** 这段来自 `registerAsyncAgent()`，位于 `restored-src/src/tasks/LocalAgentTask/LocalAgentTask.tsx`。它先把 task output 指向 agent transcript，再创建可取消的 `local_agent` 状态并写入根 `AppState.tasks`。上一篇分析的统一 Task 状态机就是在这里接住 subagent。

**参数说明：** `agentId`、`description`、`prompt`、`selectedAgent`、`setAppState` 必填；`parentAbortController` 和 `toolUseId` 可为 `undefined`。传入 parent controller 时创建 child controller，父取消会传播；AgentTool 的普通 async-from-start 路径刻意不传它，让后台 Agent 不因用户按 ESC 取消主线程而一起停止，而是通过显式任务停止接口收束。`retrieved`、`retain`、`diskLoaded` 初始均为 `false`。

状态对象中的 `agentType` 优先使用定义名称，缺失时回退 `general-purpose`；`lastReportedToolCount` 与 `lastReportedTokenCount` 从 0 开始，供增量进度事件计算差值；`isBackgrounded:true` 让任务进入后台观察路径，`pendingMessages:[]` 建立后续消息队列。`abortController` 交给 TaskStop，`selectedAgent` 则保留恢复和展示所需的定义。

**字段说明：** `taskState` 先展开 `createTaskStateBase()` 的通用字段，再把 `status` 覆盖为 `'running'`；`agentId`、`prompt`、`selectedAgent`、`agentType` 保存 Agent 身份与任务定义，`abortController` 提供取消通道。`retrieved`、`retain`、`diskLoaded` 控制结果消费与恢复，`lastReportedToolCount`、`lastReportedTokenCount` 保存进度游标，`isBackgrounded` 与 `pendingMessages` 控制后台观察和消息队列。

父调用此时立刻得到：

- `status: 'async_launched'`；
- `agentId`、`description`、原 `prompt`；
- `outputFile`；
- 可选布尔 `canReadOutputFile`，表示父工具池里是否有 Read 或 Bash。

这些字段表示“任务已启动”，不表示“答案已生成”。父线程读取 output file 只能观察进度；真正完成后，生命周期函数先把状态改成 `completed`、`failed` 或 `killed`，再构造通知：

```ts
const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>${resultSection}${usageSection}${worktreeSection}
</${TASK_NOTIFICATION_TAG}>`

enqueuePendingNotification({
  value: message,
  mode: 'task-notification',
})
```

**函数说明：** 这段来自 `enqueueAgentNotification()`。通知被放入共享消息队列，后续作为新的输入重新进入主线程；已经结束的 `Agent` tool result 保持不变。函数会先原子检查并设置 `notified`，避免 TaskStop 与自然完成重复通知。

**参数说明：** `status` 只能是 `'completed' | 'failed' | 'killed'`。`error`、`finalMessage`、`usage`、`toolUseId`、`worktreePath`、`worktreeBranch` 都可为 `undefined`，对应 XML 段会被省略。`mode` 固定为 `'task-notification'`，队列消费者据此采用任务通知语义。

**字段说明：** `message` 依次组装 `taskId`、可选 `toolUseIdLine`、`outputPath`、`status`、`summary`，以及可选 `resultSection`、`usageSection`、`worktreeSection`；`enqueuePendingNotification()` 把该文本写入 `value`，并用 `mode` 标记消费协议。

取消通过 task 的 `AbortController` 中止 query，状态进入 `killed`；普通异常进入 `failed`；成功结果由 `finalizeAgentTool()` 提取后进入 `completed`。无论哪种终态，清理路径都会关闭 Agent 专属 MCP、移除 hooks、释放文件缓存、清掉 todo，并终止它遗留的后台 shell task。

## 为什么要这样实现

现在可以回答“为什么不用主 Agent 自己一直做”。

第一，**控制上下文污染**。探索任务的价值通常在结论，不在几十条检索日志。Sidechain 把证据采集过程留给子线程，父线程只承接结果。

第二，**把能力边界声明化**。`Explore` 明确移除 Edit、Write、NotebookEdit 和 Agent；`Plan` 也保持只读；custom Agent 可以把工具、模型、Skills、MCP 和最大轮数写进定义。调用者选择一个角色，就同时选择一组运行约束。

第三，**复用同一执行内核**。`runAgent()` 最终仍调用 `query()`，所以不用另写一套流式消息、工具循环、错误恢复和 transcript 协议。差异集中在输入上下文和 ToolUseContext 的装配处。

第四，**让长任务脱离当前回合**。`LocalAgentTask` 把后台 Agent 纳入统一状态、输出、通知和取消机制。主线程可以继续对话，但任务仍可观察，也有明确的 completed/failed/killed 终态。

当然，这个设计也有成本。普通 subagent 的 prompt 交代不足会重复探索；多 Agent 并发会增加模型调用和合并工作；后台任务无法直接询问权限时可能被拒绝；共享 cwd 下的多个可写 Agent 仍可能修改同一文件。`isolation:'worktree'` 可以隔离文件树，但 worktree 如何创建、保留与收束要留到第 26 篇展开。

## 小结

Claude Code 的 subagent 委派可以压成一条链：**`Agent tool_use → 选择 AgentDefinition → 组装模型/工具/权限/消息 → createSubagentContext → runAgent/query → 前台 tool_result 或后台 task-notification`。**

普通 subagent 从新的消息上下文开始，父线程必须把任务交代完整；feature-gated Fork 才会携带父 transcript，并为 prompt cache 复用精确 system prompt 与工具前缀。两者都有独立 agent ID、sidechain transcript 和文件读取状态。

Agent 定义决定“这个子线程是什么角色”，Tool Pool 决定“它能请求什么”，权限引擎决定“具体调用能否执行”，Task runtime 决定“父线程是否等待以及结果怎样回来”。把这四层分开，才能理解为什么 subagent 既能隔离上下文，又不会脱离主会话的控制与收束。

## 留给下一篇的问题

单个 subagent 能够委派以后，Claude Code 如何把多个 Agent 组织成团队，并由 Coordinator 分派、同步和收敛工作？

## 参考资料

- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)

- [Claude Code 上下文窗口](https://code.claude.com/docs/en/context-window)
