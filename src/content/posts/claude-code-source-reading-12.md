---
title: "Claude Code源码解读12：如何在允许、询问与拒绝之间决策"
published: 2026-07-24T16:46:59+08:00
updated: 2026-07-24T16:46:59+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-12/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：工具在真正产生副作用前，权限引擎怎样把规则、模式、Hook 和用户/宿主响应合并成 `allow`、`ask` 或 `deny`？

先说答案：**它们不是投票，也不是谁最后返回谁赢，而是按一条有明确阻断顺序的流水线合并。**

模型给出的工具输入先经过 Schema 和工具自己的输入校验，随后运行 `PreToolUse` Hook。Hook 可以拒绝、要求询问，也可以改写输入，但它给出的 `allow` 不是一张万能通行证。权限层仍会检查 deny 规则、ask 规则、工具自身的路径或命令约束，以及少数不能被 bypass 的安全检查。

这些检查没有阻断以后，permission mode 和 allow 规则才可能把调用变成 `allow`。如果结果仍是 `ask`，`canUseTool` 会把决定交给交互式 REPL、SDK 宿主或自定义 permission prompt tool。宿主可以允许、拒绝、修改输入，也可以把“以后都允许”转换成权限更新。最终只有 `allow` 会抵达 `tool.call()`；`ask` 在没有交互者的上下文里也不会偷偷执行。

所以这条链路可以先记成一句话：**先让强约束阻断，再让模式与规则放行，最后才把无法自动决定的部分交给人或宿主。**

## 权限引擎判断的是一次调用，不是一个抽象的“信任度”

本文仍然只讨论 `@anthropic-ai/claude-code@2.1.88` source map 还原出的可见源码。还原目录便于追踪符号和调用关系，但不能视为 Anthropic 内部仓库的原始目录，也不能把功能开关后的分支当成所有用户都会运行的默认行为。

权限判断的输入至少包含四样东西：工具、这一次的输入、当前 `ToolPermissionContext`，以及能够承接询问的 `canUseTool`。因此，同一个 Bash 工具执行 `git status` 和执行发布命令，或者同一个 Edit 工具写项目文件和写 `.claude/settings.json`，都可能得到不同结果。

下面这张图把主线压缩到一次副作用之前：

![Claude Code 权限决策流水线手绘图](/images/posts/claude-code-source-reading-12/12-permission-engine-handdrawn.png)

图里最值得注意的是两点。第一，Hook 位于权限确认之前，改过的输入会重新进入权限链。第二，`ask` 不是执行许可，它只是把决定转交给某个宿主；没有宿主响应，就没有 `tool.call()`。

后文的源码片段都来自 `restored-src/`。为了突出决策顺序，我会省略日志、遥测、分类器细节和与当前结论无关的分支；函数名、关键条件和返回值保持与 2.1.88 可见源码一致。

## 启动时先把分散规则装进同一个上下文

权限引擎并不是每次调用工具时再去扫描所有配置文件。启动阶段的 `initializeToolPermissionContext()` 会先解析 CLI 规则、读取磁盘规则、建立额外工作目录，再合并成 `ToolPermissionContext`。

```ts
let toolPermissionContext = applyPermissionRulesToPermissionContext(
  {
    mode: permissionMode,
    additionalWorkingDirectories,
    alwaysAllowRules: { cliArg: parsedAllowedToolsCli },
    alwaysDenyRules: { cliArg: parsedDisallowedToolsCli },
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable,
  },
  rulesFromDisk,
)
```

**功能：** `initializeToolPermissionContext()` 位于 `restored-src/src/utils/permissions/permissionSetup.ts`。这段代码把 CLI 的 allow/deny、磁盘规则、permission mode 和额外目录收进一个会随 AppState 传递的权限上下文。`applyPermissionRulesToPermissionContext()` 再把磁盘规则按来源与行为分组，以追加方式写入对应集合。

**关键参数与值：** `permissionMode` 是必填的 `PermissionMode`；`parsedAllowedToolsCli` 与 `parsedDisallowedToolsCli` 都是字符串数组，空数组表示 CLI 没有提供相应规则。`rulesFromDisk` 是 `PermissionRule[]`，每条规则带 `source`、`ruleBehavior` 与 `ruleValue`。`baseToolsCli` 在完整函数中是 `string[] | undefined`：只有数组存在且非空时，未进入基础工具集合的默认工具才会被追加到 deny。`allowDangerouslySkipPermissions` 是必填布尔值，没有函数级默认值；它参与判断 bypass 是否可用，却不等于无条件打开 bypass。

`restored-src/src/types/permissions.ts` 的 `PermissionRuleSource` 把规则来源限定为八种：

| 来源 | 含义 |
|---|---|
| `userSettings` | 用户级设置 |
| `projectSettings` | 项目共享设置 |
| `localSettings` | 项目本地、通常不提交的设置 |
| `flagSettings` | `--settings` 等参数提供的设置 |
| `policySettings` | 托管或组织策略 |
| `cliArg` | `--allowedTools`、`--disallowedTools` 等 CLI 输入 |
| `command` | 命令在当前流程中注入的规则 |
| `session` | 当前会话中的临时规则 |

`restored-src/src/utils/settings/constants.ts` 的 `SETTING_SOURCES` 对一般设置声明了“后面的来源覆盖前面的来源”，顺序是 user、project、local、flag、policy。但权限规则的合并方式需要单独看：`applyPermissionRulesToPermissionContext()` 会按来源和行为分组后追加，并不会拿后一条 allow 删除前一条 deny。真正决定冲突的是后面的行为检查顺序。

还有一个管理边界：`allowManagedPermissionRulesOnly === true` 时，`loadAllPermissionRulesFromDisk()` 只返回 `policySettings` 规则。源码能确认这条过滤分支；静态分析不能替我们判断某个真实组织是否打开了它。

## 一条规则由工具名和可选内容组成

规则字符串不是任意表达式语言。解析器把它压缩成 `toolName` 与可选的 `ruleContent`：

```ts
export function permissionRuleValueFromString(
  ruleString: string,
): PermissionRuleValue {
  const openParenIndex = findFirstUnescapedChar(ruleString, '(')
  if (openParenIndex === -1) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  // 省略括号完整性检查
  if (rawContent === '' || rawContent === '*') {
    return { toolName: normalizeLegacyToolName(toolName) }
  }

  return {
    toolName: normalizeLegacyToolName(toolName),
    ruleContent: unescapeRuleContent(rawContent),
  }
}
```

**功能：** `permissionRuleValueFromString()` 位于 `restored-src/src/utils/permissions/permissionRuleParser.ts`，负责把规则字符串解析成结构化值。`Bash` 是工具级规则；`Bash(npm publish:*)` 带内容约束。`Bash()` 与 `Bash(*)` 都会归一化为工具级 `Bash`。括号不完整、右括号后还有字符或缺少工具名时，完整字符串会被当成工具名处理，而不是猜测用户意图。

。`ruleContent` 的类型是 `string | undefined`；`undefined` 表示匹配整个工具，字符串表示交给具体工具解释的内容规则。解析器会规范旧工具名并处理转义括号，但不会把任意内容统一解释成正则表达式。

这正是权限规则容易读错的地方。工具级规则可以由通用层匹配，内容规则却必须交给工具实现。例如文件工具把内容理解为路径模式，Bash 把它理解为命令前缀或命令规则，WebFetch 则围绕 host/path 检查。**权限框架统一结果形状，具体风险语义仍属于工具。**

MCP 也沿用这套工具名匹配。`restored-src/src/utils/permissions/permissions.ts` 的 `toolMatchesRule()` 使用完整的 `mcp__server__tool` 名称；`mcp__server` 或 `mcp__server__*` 可以匹配该 server 下的工具。。

## 真正的优先级写在 hasPermissionsToUseToolInner 里

核心顺序位于 `restored-src/src/utils/permissions/permissions.ts`。把分类器和日志拿掉以后，控制流很清楚：

```ts
async function hasPermissionsToUseToolInner(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
): Promise<PermissionDecision> {
  let appState = context.getAppState()

  const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
  if (denyRule) {
    return {
      behavior: 'deny',
      decisionReason: { type: 'rule', rule: denyRule },
      message: `Permission to use ${tool.name} has been denied.`,
    }
  }

  // 省略工具级 ask 与不能绕过的工具检查
  const parsedInput = tool.inputSchema.parse(input)
  const toolPermissionResult = await tool.checkPermissions(parsedInput, context)
  if (toolPermissionResult?.behavior === 'deny') {
    return toolPermissionResult
  }

  appState = context.getAppState()
  const shouldBypassPermissions =
    appState.toolPermissionContext.mode === 'bypassPermissions' ||
    (appState.toolPermissionContext.mode === 'plan' &&
      appState.toolPermissionContext.isBypassPermissionsModeAvailable)
  if (shouldBypassPermissions) {
    return {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
      decisionReason: {
        type: 'mode',
        mode: appState.toolPermissionContext.mode,
      },
    }
  }

  // 省略工具级 allow 分支
  return toolPermissionResult.behavior === 'passthrough'
    ? {
        ...toolPermissionResult,
        behavior: 'ask' as const,
        message: createPermissionRequestMessage(
          tool.name,
          toolPermissionResult.decisionReason,
        ),
      }
    : toolPermissionResult
}
```

**功能：** `hasPermissionsToUseToolInner()` 为一次工具调用生成初步权限结果。顺序是：检查整个工具的 deny、检查整个工具的 ask、执行工具自己的内容级检查、保留需要交互和不能绕过的 ask、安全检查，再考虑 bypass 与整个工具的 allow；最后把内部 `passthrough` 规范化成对外的 `ask`。

**关键参数与值：** `tool` 是当前 `Tool`，提供 `name`、`inputSchema`、`checkPermissions()`，并可能提供 `requiresUserInteraction()`；该可选函数不存在时，`?.()` 得到 `undefined`，按“不强制交互”处理。`input` 是开放对象，先由各工具 Schema 解析。`context` 是 `ToolUseContext`，其中的 abort signal、AppState、消息、工具集合和会话选项都可能影响判断。返回值最终是 `PermissionDecision`，其 `behavior` 只能是 `allow`、`ask`、`deny`；工具内部还可暂时返回 `passthrough`，但它不会作为最终自动执行许可。

因此，跨行为的优先级可以精确写成：

1. 工具级 deny；
2. 工具级 ask（沙箱 Bash 的特定自动允许分支除外）；
3. 工具自己的 deny、内容级 ask、强制交互与安全检查；
4. `bypassPermissions`，以及带有可用 bypass 状态的 plan 分支；
5. 工具级 allow；
6. 未决定的 `passthrough` 转成 ask。

这意味着 `allow` 规则不能推翻 deny，bypass 也不会越过源码明确列出的内容级 ask、`requiresUserInteraction()` 与 `safetyCheck`。反过来，不能从这个顺序推出“所有危险操作都一定被识别”；能识别什么，仍取决于每个工具在 2.1.88 中实现了哪些检查。

外层 `hasPermissionsToUseTool()` 还会做模式收尾：`dontAsk` 把残留的 ask 转成 deny；`auto` 只有 `TRANSCRIPT_CLASSIFIER` 功能开启时才进入运行时模式集合，并可能把 ask 交给分类器。分类器的实际可用性、模型响应和功能开关属于运行时事实，本文不把它描述成通用默认防线。

## permission mode 不是五档“安全等级”

`restored-src/src/types/permissions.ts` 的 `EXTERNAL_PERMISSION_MODES` 与 `INTERNAL_PERMISSION_MODES` 给出了模式边界；`restored-src/src/utils/permissions/PermissionMode.ts` 负责校验、解析和展示。对外可配置模式是 `default`、`acceptEdits`、`bypassPermissions`、`dontAsk`、`plan`。内部联合类型还包含 `auto` 和 `bubble`：`auto` 是否进入可配置集合取决于编译功能开关，`bubble` 不在 `PERMISSION_MODES` 的运行时校验数组中。

| mode | 2.1.88 可确认的控制流含义 |
|---|---|
| `default` | 没有命中规则或工具自动判断时保留 ask，由宿主确认。 |
| `acceptEdits` | 具体文件工具可自动允许工作目录内的编辑；它不是对 Bash、MCP 和全部副作用的统一 allow。 |
| `bypassPermissions` | 在 deny、内容级 ask、强制交互和 safety check 之后走 allow；是否可启用还受启动检查与配置约束。 |
| `dontAsk` | 把本来需要 ask 的结果转换为 deny，适合不能或不希望弹窗的流程，但不等于“自动允许”。 |
| `plan` | 由具体工具限制可执行能力；如果会话保留了可用的 bypass 状态，源码中的特定分支仍可能在前置阻断后放行。 |
| `auto` | 功能开关控制的内部/实验路径，可能用分类器处理 ask。 |
| `bubble` | 子任务权限向上层交互宿主冒泡使用的内部模式，不属于用户可配置校验集合。 |

未知模式字符串经过 `permissionModeFromString()` 会回退到 `default`。`getModeConfig()` 对缺少显示配置的内部模式也回退到 default 的标题、颜色和 external 映射。这些是解析和展示回退，不代表未知模式可以绕过权限。

## 工具自己的 checkPermissions 是第二个裁判

通用层只认识“工具名是否整体被 deny/ask/allow”。一旦规则带内容，它就必须调用工具自己的 `checkPermissions()`。文件写入是最直观的例子：

```ts
export function checkWritePermissionForTool<Input extends AnyObject>(
  tool: Tool<Input>,
  input: z.infer<Input>,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionDecision {
  // 省略 deny、内部路径、safety check 与 ask 规则
  const isInWorkingDir = pathInAllowedWorkingPath(
    path,
    toolPermissionContext,
    pathsToCheck,
  )
  if (toolPermissionContext.mode === 'acceptEdits' && isInWorkingDir) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'mode',
        mode: toolPermissionContext.mode,
      },
    }
  }

  const allowRule = matchingRuleForInput(
    path,
    toolPermissionContext,
    'edit',
    'allow',
  )
  if (allowRule) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: allowRule },
    }
  }

  return {
    behavior: 'ask',
    message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
    suggestions: generateSuggestions(
      path,
      'write',
      toolPermissionContext,
      pathsToCheck,
    ),
    decisionReason: !isInWorkingDir
      ? {
          type: 'workingDir',
          reason: 'Path is outside allowed working directories',
        }
      : undefined,
  }
}
```

**功能：** `checkWritePermissionForTool()` 位于 `restored-src/src/utils/permissions/filesystem.ts`，被 Edit、Write、NotebookEdit 等文件工具调用。它将路径级 deny、安全路径、路径级 ask、`acceptEdits`、路径级 allow 和默认询问排成固定顺序，并同时检查用户输入路径与符号链接解析后的路径。

**关键参数与值：** `tool` 必须能提供 `getPath()`；不是函数时直接返回 ask。`input` 已通过工具 Schema，具体字段随工具而异。`toolPermissionContext` 提供 mode、规则和额外工作目录。`precomputedPathsToCheck` 是可选只读字符串数组；为 `undefined` 时函数自行计算原始与解析路径。`isInWorkingDir` 是布尔值，只有它为 `true` 且 mode 为 `acceptEdits` 才走该自动允许分支。

这里给出了三个重要边界。

第一，“允许 Edit”与“允许这个路径”不是一回事。第二，`acceptEdits` 只对允许工作目录内的写入生效，工作目录外仍可能 ask，并附带增加目录的 suggestion。第三，`.git/`、`.claude/`、`.vscode/`、shell 配置等路径有独立 safety check；源码甚至为 `.claude/skills/<name>/` 设计了收窄到 session 的规则建议，而不是把整个配置目录永久放开。

Bash 的入口同样很薄：`BashTool.checkPermissions()` 直接调用 `bashToolHasPermission(input, context)`。真正的命令拆分、子命令规则、重定向、沙箱与平台边界留到下一篇。这里我们只需要确认：通用权限层不会只凭工具名理解一整条 shell 命令。

## PreToolUse Hook 能改判决，但不能抹掉硬边界

单次工具生命周期先执行 `runPreToolUseHooks()`。Hook 可以单独给出 `updatedInput`，也可以返回带行为的 `PermissionResult`：

```ts
for await (const result of runPreToolUseHooks(/* ... */)) {
  switch (result.type) {
    case 'hookPermissionResult':
      hookPermissionResult = result.hookPermissionResult
      break
    case 'hookUpdatedInput':
      processedInput = result.updatedInput
      break
    case 'stop':
      return resultingMessages
  }
}

const resolved = await resolveHookPermissionDecision(
  hookPermissionResult,
  tool,
  processedInput,
  toolUseContext,
  canUseTool,
  assistantMessage,
  toolUseID,
)
```

**功能：** 这段调用位于 `restored-src/src/services/tools/toolExecution.ts` 的 `checkPermissionsAndCallTool()`。它先收集 `PreToolUse` 结果，再把 Hook 结论、可能被修改的输入与宿主权限回调一起交给 `resolveHookPermissionDecision()`。`stop` 会在权限对话和 `tool.call()` 之前直接结束本次调用。

**关键参数与值：** `hookPermissionResult` 是 `PermissionResult | undefined`；没有 Hook 做权限决定时为 `undefined`。`processedInput` 是当前输入对象，`hookUpdatedInput` 会替换它。`canUseTool` 是必填回调，负责把 ask 交给当前宿主。`assistantMessage` 与 `toolUseID` 用于关联原始模型消息和具体工具调用；`toolUseID` 是开放字符串标识，不是权限级别。

`resolveHookPermissionDecision()` 的合并规则比“Hook 优先”更谨慎：

```ts
if (hookPermissionResult?.behavior === 'allow') {
  const hookInput = hookPermissionResult.updatedInput ?? input

  if ((requiresInteraction && !interactionSatisfied) || requireCanUseTool) {
    return {
      decision: await canUseTool(
        tool,
        hookInput,
        toolUseContext,
        assistantMessage,
        toolUseID,
      ),
      input: hookInput,
    }
  }

  const ruleCheck = await checkRuleBasedPermissions(tool, hookInput, toolUseContext)
  if (ruleCheck === null) {
    return { decision: hookPermissionResult, input: hookInput }
  }
  if (ruleCheck.behavior === 'deny') {
    return { decision: ruleCheck, input: hookInput }
  }
  return {
    decision: await canUseTool(
      tool,
      hookInput,
      toolUseContext,
      assistantMessage,
      toolUseID,
    ),
    input: hookInput,
  }
}

if (hookPermissionResult?.behavior === 'deny') {
  return { decision: hookPermissionResult, input }
}
```

**功能：** `resolveHookPermissionDecision()` 位于 `restored-src/src/services/tools/toolHooks.ts`。Hook allow 会采用 `updatedInput ?? input`，但交互型工具、`requireCanUseTool`、deny 规则、ask 规则、工具内容级 deny/ask 与 safety check 仍可要求重新裁决。Hook deny 直接返回；Hook ask 则作为 `forceDecision` 交给 `canUseTool`，让界面显示 Hook 提供的原因。

**关键参数与值：** `hookPermissionResult` 可为 `allow`、`ask`、`deny`、`passthrough` 或 `undefined`。`updatedInput` 为 `undefined` 时沿用原输入；存在时即使是空对象也会作为 Hook 输入。`requiresInteraction` 来自可选的 `tool.requiresUserInteraction?.()`，可能是 `true`、`false` 或 `undefined`。`toolUseContext.requireCanUseTool` 也是可选布尔值；只有真值强制再次走宿主回调。函数返回 `{ decision, input }`，后续允许结果中的 `decision.updatedInput` 还可以再次替换最终执行输入。

。这个设计让 Hook 成为策略扩展点，而不是绕过权限引擎的旁路。

## canUseTool 是“把 ask 交给谁”的宿主接口

`hasPermissionsToUseTool()` 负责算出规则与模式结论，`canUseTool` 负责把 ask 变成最终决定。两者名字接近，职责并不相同。

交互式 REPL 的 `useCanUseTool()` 会把 ask 放进确认队列，等待用户操作。允许时可以带回 `updatedInput`、反馈和 `PermissionUpdate[]`；拒绝时返回 deny；取消和异常会终止这次权限等待。

Headless/SDK 路径没有 React 确认框。`getCanUseToolFn()` 根据参数选择承接者：

```ts
export function getCanUseToolFn(
  permissionPromptToolName: string | undefined,
  structuredIO: StructuredIO,
  getMcpTools: () => Tool[],
  onPermissionPrompt?: (details: RequiresActionDetails) => void,
): CanUseToolFn {
  if (permissionPromptToolName === 'stdio') {
    return structuredIO.createCanUseTool(onPermissionPrompt)
  }
  if (!permissionPromptToolName) {
    return async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseId,
      forceDecision,
    ) =>
      forceDecision ??
      (await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseId,
      ))
  }
  // 其余取值延迟查找同名 MCP permission prompt tool
}
```

**功能：** `getCanUseToolFn()` 位于 `restored-src/src/cli/print.ts`。`stdio` 把请求交给 StructuredIO/SDK 控制协议；未设置 prompt tool 时只运行本地自动规则，不会创建交互；其他字符串会在 MCP 工具连接后按名称延迟查找，并包装成 permission prompt tool。

**关键参数与值：** `permissionPromptToolName` 是 `string | undefined`：`'stdio'` 有专门含义，`undefined` 表示没有外部 prompt tool，其他字符串是开放的 MCP 工具名。`structuredIO` 是必填传输对象。`getMcpTools` 是无参函数，返回当时已连接的工具数组。`onPermissionPrompt` 是可选回调；为 `undefined` 时使用 `?.()` 跳过通知，不影响控制请求本身。`forceDecision` 也是可选值，存在时跳过重新计算初步权限。

没有 prompt tool 时，如果本地规则算出 ask，`checkPermissionsAndCallTool()` 会因为结果不是 allow 而生成错误 `tool_result`，不会执行工具。`dontAsk` 则更早把 ask 明确改成 deny。两条路径结果都不执行，但 `decisionReason` 不同，宿主可以据此区分“模式拒绝”和“缺少批准”。

SDK 的 `StructuredIO.createCanUseTool()` 会同时启动 `PermissionRequest` Hook 与 SDK `can_use_tool` 控制请求，谁先给出有效决定谁生效；Hook 没有决定时继续等待 SDK。异常被转换成 deny。这里是并发竞速，不是 Hook 永远覆盖宿主，也不是宿主返回以后还等待另一路改判。

SDK 宿主返回的 Schema 只有 allow 与 deny，没有第三种 ask。allow 必须带 `updatedInput`；`updatedPermissions`、`toolUseID` 和 `decisionClassification` 可省略。`updatedPermissions` 为 `undefined` 时不更新权限，`null` 或其他畸形值会被字段级 `catch` 转成 `undefined`。deny 必须带 `message`；`interrupt` 是 `boolean | undefined`，只有显式 `true` 才会 abort 当前 controller，`null` 不属于这个字段的合法值。allow 的 `updatedInput` 如果是空对象，2.1.88 会回退到原始输入，这是为拿不到原输入的移动端响应保留的兼容逻辑。

## “Always allow”实际上是一组权限更新

用户在对话框中选择长期允许时，系统并不是给当前 decision 加一个神秘标记。它接收工具生成的 suggestions，再将选择落实成 `PermissionUpdate[]`：

```ts
async persistPermissions(updates: PermissionUpdate[]) {
  if (updates.length === 0) return false

  persistPermissionUpdates(updates)
  const appState = toolUseContext.getAppState()
  setToolPermissionContext(
    applyPermissionUpdates(appState.toolPermissionContext, updates),
  )

  return updates.some(update => supportsPersistence(update.destination))
}
```

**功能：** `persistPermissions()` 位于 `restored-src/src/hooks/toolPermission/PermissionContext.ts`。它先按 destination 尝试持久化，再把同一批更新应用到当前内存权限上下文，使本次会话后续调用立即看到新规则。返回布尔值只表示这批更新中是否含支持持久化的 destination，不是磁盘写入成功证明。

**关键参数与值：** `updates` 是 `PermissionUpdate[]`，可以为空。`type` 的源码可见取值为 `addRules`、`replaceRules`、`removeRules`、`setMode`、`addDirectories`、`removeDirectories`。前三种规则操作还带 `behavior: 'allow' | 'ask' | 'deny'`；`setMode.mode` 只能是五种 `ExternalPermissionMode`。`destination` 可以是 `userSettings`、`projectSettings`、`localSettings`、`session`、`cliArg`，但只有前三种支持写入设置；`session` 与 `cliArg` 只更新内存。

因此，“Always allow”可能意味着增加一条精确规则、切换到 `acceptEdits`，或者把某个目录加入当前会话，具体取决于工具给出的 suggestion 与用户选择。它不是永久、全局、不可撤销的同义词。

更重要的是，新 allow 规则仍要回到同一条优先级链。以后出现更具体的 deny、ask 或 safety check，它仍可能被阻断。SDK 的 `updatedPermissions` 也走相同的 `applyPermissionUpdates()` 与 `persistPermissionUpdates()`；如果宿主传入的数组不符合 Schema，2.1.88 会记录警告并把它当成 `undefined`，不会因为一条畸形更新拒绝整个 allow 响应。

## 子任务不会无条件继承父会话的所有授权

子 Agent 既要继承必要上下文，又不能让父会话的临时授权无边界扩散。`runAgent.ts` 中的 `agentGetAppState()` 明确重建了部分权限状态：

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

if (allowedTools !== undefined) {
  toolPermissionContext = {
    ...toolPermissionContext,
    alwaysAllowRules: {
      cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
      session: [...allowedTools],
    },
  }
}
```

**功能：** `agentGetAppState()` 位于 `restored-src/src/tools/AgentTool/runAgent.ts`。它根据子任务能否展示权限 UI、是否异步和 agent mode 设置无交互标记；当 agent 显式提供 `allowedTools` 时，只保留父上下文的 `cliArg` allow，并用子任务列表重建 session allow，避免父会话 session 规则直接泄漏。

**关键参数与值：** `canShowPermissionPrompts` 是 `boolean | undefined`：显式 `true` 允许提示，显式 `false` 禁止，`undefined` 时 `bubble` 允许向上冒泡，其他模式按 `isAsync` 决定。`isAsync` 是布尔值。`agentPermissionMode` 可为内部 permission mode 或 `undefined`；父上下文处于 `bypassPermissions`、`acceptEdits`，以及功能开启时的 `auto`，不会被普通 agent mode 覆盖。`allowedTools` 是 `string[] | undefined`：`undefined` 保留原上下文，空数组则会明确重建为空的 session allow。

当 `shouldAvoidPermissionPrompts` 为真，残留 ask 会先给 `PermissionRequest` Hook 一次处理机会；Hook 仍没有决定时返回 deny，reason 是当前上下文不能展示 permission prompt。这个失败边界对后台 Agent 很关键：不弹窗不等于默认通过。

MCP 工具本身也没有另一套权限系统。`MCPTool.checkPermissions()` 默认返回 `passthrough`，然后由通用规则、完整 MCP 名称和宿主决定。MCP server 能执行什么副作用取决于外部实现。

## allow 之后才轮到 tool.call

权限结果回到 `checkPermissionsAndCallTool()` 后，还有一道非常直白的门：

```ts
if (permissionDecision.behavior !== 'allow') {
  // 省略错误 tool_result 与拒绝遥测的构造
  return resultingMessages
}

if (permissionDecision.updatedInput !== undefined) {
  processedInput = permissionDecision.updatedInput
}

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

**功能：** 这段逻辑位于 `restored-src/src/services/tools/toolExecution.ts`。非 allow 统一转换为错误工具结果并在副作用前返回；allow 可以把权限阶段修改过的输入传给工具。随后才调用 `tool.call()`，并把用户是否修改输入、调用 ID、取消与进度上下文一并传入。

**关键参数与值：** `permissionDecision.behavior` 最终只可能是 `allow`、`ask`、`deny`。`updatedInput` 是对象或 `undefined`；只有不为 `undefined` 才覆盖当前输入。`userModified` 是 `boolean | undefined`，调用工具时通过 `?? false` 回退为 `false`。`callInput` 还会区分仅供权限观察的 backfill 字段与真正应交给工具的字段；只有 Hook 或权限流程有意替换的输入才应改变执行内容。

这也说明权限失败并不等于进程失败。被拒绝的调用会形成 `is_error: true` 的 `tool_result` 返回消息链，Agent 仍可能解释拒绝、改用别的工具或停止。若 SDK deny 同时设置 `interrupt: true`，或者 abort signal 已触发，则会进一步中断当前执行链。

输入 Schema 失败和工具 `validateInput()` 失败发生得更早，它们直接产生输入错误，不进入权限询问。工具自己的 `checkPermissions()` 若抛出普通异常，源码记录错误后保留 `passthrough`，最终通常走 ask；AbortError 则继续向上抛。。

最后还要划清一个边界：**权限 allow 只表示“Claude Code 的应用层允许尝试这次调用”。** 应用层放行并不等于命令解析正确、沙箱真正生效、系统接受成功，外部 MCP 也不必按同样规则运行；这些都属于下一层执行与平台边界。

## 小结

Claude Code 的权限系统不是一个 `if (trusted)`，而是一条在副作用前反复收窄的决策链。

启动阶段把 user、project、local、flag、policy、CLI、command 与 session 规则收进权限上下文。运行阶段先看 deny 和 ask，再让工具按具体输入检查路径、命令或外部目标；Hook 可以修改或建议，却不能覆盖显式阻断；permission mode 与 allow 规则只在前置边界通过后放行。仍然是 ask 的调用交给 REPL、SDK 或 MCP prompt tool，宿主返回的输入和权限更新再进入当前上下文。

最终代码只认一件事：`permissionDecision.behavior === 'allow'`。其余结果都在 `tool.call()` 之前停止，并作为可观察的拒绝或错误回到消息链。

## 留给下一篇的问题

权限已经允许以后，Bash 命令为什么仍需要解析、沙箱和平台安全边界，它们分别拦什么？

