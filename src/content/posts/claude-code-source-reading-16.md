---
title: "Claude Code源码解读16：项目上下文如何组装并注入"
published: 2026-07-24T16:47:03+08:00
updated: 2026-07-24T16:47:03+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-16/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 本章先建立三个概念

- **上下文平面**：system prompt、项目指令与消息历史通过不同通道进入同一次模型请求。

- **提示词分层**：稳定规则、动态环境和任务消息按更新频率分层，便于复用与定位来源。

- **缓存边界**：前缀顺序和内容变化决定 prompt cache 的命中范围，分块结构直接影响成本。

![系统提示词、项目上下文与消息历史三条通道](/images/posts/claude-code-source-reading-16/16-context-planes-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

我先阅读了 Anthropic 的 [Haiku 4.5 说明](https://www.anthropic.com/claude/haiku) 和官方 [Claude Code model configuration](https://code.claude.com/docs/en/model-config)。前者解释了为什么低延迟模型常被用于高频、并行、子 Agent 工作；后者则说明“Default”、主会话模型、别名和环境变量是不同层次，不能把用户看到的默认选项等同于每个内部工具调用的模型。

上一篇留下的问题是：你知道 Claude Code 会用你默认的模型进行 WebSearch 吗？

答案不是简单的“是”或“不是”。默认情况下，WebSearch 会沿用当前主循环的 `context.options.mainLoopModel`；但运行时功能开关 `tengu_plum_vx3` 为真时，搜索流会切换到 `getSmallFastModel()`，优先使用 `ANTHROPIC_SMALL_FAST_MODEL`，未设置时回退到默认 Haiku。

因此，`isEnabled()` 返回 true 只说明当前 provider/model 组合具备 WebSearch 能力，不代表最终搜索模型已经确定。真正的模型选择发生在 `WebSearchTool.call()`：默认分支使用主循环模型，功能开关分支使用 small fast model；两条路径都通过独立的模型流调用服务端 WebSearch 工具。

所以更准确的回答是：**默认情况下会使用当前主循环模型，但并不是任何情况下都固定使用默认模型。**

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的源码块都是短摘录，省略了与当前结论无关的日志、埋点和实验分支；还原路径只用于定位本文引用的源码。

## 一次模型请求，其实有三条上下文通道

我们先把主线画出来。

![Claude Code system prompt 与项目上下文组装流程](/images/posts/claude-code-source-reading-16/16-system-prompt-context-handdrawn.png)

这里先明确三条通道各自承担的协议职责。

**System prompt** 承载稳定的身份、行为边界和环境说明。源码用 `SystemPrompt` 这个品牌类型表示 `readonly string[]`，使稳定前缀、动态区块与缓存边界保持可追踪。

**Message context** 承载对话历史。CLAUDE.md 在这条实现中被包装成 meta user message，通过 `<system-reminder>` 标明其按需使用的上下文属性。

**Tool schema** 是模型能够调用什么工具的机器可读契约，包括名称、描述和输入 JSON Schema。自然语言 prompt 负责使用策略，Schema 负责输入结构，两者分别进入请求。

为什么要分开？最直接的原因是职责不同：稳定 prompt 可以命中缓存，CLAUDE.md 可以作为会话上下文独立注入，工具 Schema 则必须满足 API 的结构化协议。若全部揉成一个字符串，任何 git 状态或工具变化都可能让稳定前缀失去缓存价值，模型也无法得到可靠的输入约束。

## 第一步：先并行准备三份原料

`restored-src/src/utils/queryContext.ts` 的 `fetchSystemPromptParts` 是最清楚的入口：

```ts
export async function fetchSystemPromptParts({
  tools,
  mainLoopModel,
  additionalWorkingDirectories,
  mcpClients,
  customSystemPrompt,
}: {
  tools: Tools
  mainLoopModel: string
  additionalWorkingDirectories: string[]
  mcpClients: MCPServerConnection[]
  customSystemPrompt: string | undefined
}): Promise<{
  defaultSystemPrompt: string[]
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
}> {
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    customSystemPrompt !== undefined
      ? Promise.resolve([])
      : getSystemPrompt(
          tools,
          mainLoopModel,
          additionalWorkingDirectories,
          mcpClients,
        ),
    getUserContext(),
    customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext(),
  ])
  return { defaultSystemPrompt, userContext, systemContext }
}
```

`fetchSystemPromptParts` 同时准备默认 prompt、user context 和 system context。`tools` 是本轮可用工具数组；`mainLoopModel` 是主循环模型 ID；`additionalWorkingDirectories` 是额外工作目录，允许空数组；`mcpClients` 是当前 MCP 连接数组，也允许为空。`customSystemPrompt` 只有 `string` 和 `undefined` 两种静态类型：`undefined` 构造 `defaultSystemPrompt` 与 `systemContext`；任意字符串（包括空字符串）都让这两个字段分别返回空数组与空对象。`userContext` 始终读取。

三项使用 `Promise.all` 并行获取，因为它们在这一步彼此独立。返回对象仍按 `defaultSystemPrompt`、`userContext`、`systemContext` 三个命名字段组装，并行只让文件读取、环境探测和 git 查询重叠执行。

这里已经出现第一个重要边界：`customSystemPrompt` 采用替换语义，并让这条 QueryEngine 路径同时跳过默认 system context。调用方若只想补充指令，应该走后面介绍的 `appendSystemPrompt`。

## 第二步：默认 system prompt 先稳定、后动态

默认 prompt 的入口是 `restored-src/src/constants/prompts.ts` 中的 `getSystemPrompt`：

```ts
export async function getSystemPrompt(
  tools: Tools,
  model: string,
  additionalWorkingDirectories?: string[],
  mcpClients?: MCPServerConnection[],
): Promise<string[]> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return [
      `You are Claude Code, Anthropic's official CLI for Claude.\n\nCWD: ${getCwd()}\nDate: ${getSessionStartDate()}`,
    ]
  }

  const cwd = getCwd()
  const [skillToolCommands, outputStyleConfig, envInfo] = await Promise.all([
    getSkillToolCommands(cwd),
    getOutputStyleConfig(),
    computeSimpleEnvInfo(model, additionalWorkingDirectories),
  ])
  const settings = getInitialSettings()
  const enabledTools = new Set(tools.map(_ => _.name))
```

`getSystemPrompt` 返回 `Promise<string[]>`，每个元素是一块 prompt。`tools` 和 `model` 必填；`additionalWorkingDirectories`、`mcpClients` 都可为 `undefined`，调用方也常传空数组。环境变量 `CLAUDE_CODE_SIMPLE` 经 `isEnvTruthy` 判断为真时，函数直接返回只含身份、cwd 和会话日期的一块简化 prompt，不再执行后续完整组装。

普通路径会并行读取 Skill 命令、output style 和环境信息。`getInitialSettings()` 提供语言等初始设置；`enabledTools` 只保存当前工具名称，用来决定 prompt 里是否出现某些工具使用指引。运行时只读取组装函数需要的配置字段，并据此选择 prompt 分块。

`computeSimpleEnvInfo` 会生成 `# Environment` 区块。它明确写入 primary working directory、是否是 git 仓库、额外工作目录、平台、Shell、OS 版本、模型与知识截止时间等信息。`additionalWorkingDirectories` 为 `undefined` 或空数组时，对应段落不会出现；无法识别知识截止时间时，返回值是 `null`，也会被过滤。

最终数组把静态区块放在前面，动态区块放在后面：

```ts
return [
  getSimpleIntroSection(outputStyleConfig),
  getSimpleSystemSection(),
  outputStyleConfig === null ||
  outputStyleConfig.keepCodingInstructions === true
    ? getSimpleDoingTasksSection()
    : null,
  getActionsSection(),
  getUsingYourToolsSection(enabledTools),
  getSimpleToneAndStyleSection(),
  getOutputEfficiencySection(),
  ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
  ...resolvedDynamicSections,
].filter(s => s !== null)
```

这段 `getSystemPrompt` 返回逻辑中，`outputStyleConfig` 可以是对象或 `null`。`null` 走默认 coding instructions，`keepCodingInstructions === true` 同样保留该区块，明确为 `false` 时跳过。`shouldUseGlobalCacheScope()` 为真才插入动态边界标记。数组最后只过滤严格等于 `null` 的元素，因此空字符串仍会保留并参与后续数组顺序。

工具在这一层只影响 `getUsingYourToolsSection(enabledTools)` 等自然语言区块。例如 Read、Edit、Task 是否可用，会改变给模型的操作建议。实际工具 Schema 仍会在 `callModel` 时通过 `tools` 参数单独传入。这个分工很重要：prompt 解释策略，Schema 约束结构。

## 为什么 prompt 要保留为“分块数组”

动态区块按 section 的缓存属性选择复用或重算。`restored-src/src/constants/systemPromptSections.ts` 定义了两种 section：

```ts
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}

export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}
```

`systemPromptSection` 的 `name` 是缓存键，`compute` 返回 `string | null | Promise<string | null>`，`cacheBreak` 固定为 `false`。`DANGEROUS_uncachedSystemPromptSection` 把 `cacheBreak` 固定为 `true`，第三个 `_reason` 是必须提供的说明字符串，但函数运行时不使用它；它用于迫使调用者解释为什么值得破坏缓存。两个函数的返回联合只包含 `string | null`。

解析时，普通区块优先复用缓存，易变区块重新计算：

```ts
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()

  return Promise.all(
    sections.map(async s => {
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null
      }
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )
}
```

`resolveSystemPromptSections` 的唯一参数 `sections` 是有序的 `SystemPromptSection[]`，返回同顺序的 `string | null` 数组。`cacheBreak: false` 且缓存已有名字时，直接复用；缓存值为 `undefined` 时通过 `?? null` 回退。`cacheBreak: true` 会每次执行 `compute()`，随后仍把结果写入缓存，但下一次不会读取这份缓存。

分块既能表达稳定前缀与动态尾部的边界，也能让 `/clear`、`/compact` 等动作集中清理 section 状态。

## 第三步：CLAUDE.md 按层级发现，但走 user context

CLAUDE.md 的发现逻辑在 `restored-src/src/utils/claudemd.ts`。初始加载采用累积语义：先收集 Managed、User，再从文件系统根方向走到 cwd，加载 Project 和 Local。

`getMemoryFiles(forceIncludeExternal = false)` 的参数是布尔值，省略时默认 `false`。`true` 会允许外部 include；默认路径还会查看项目配置中的 `hasClaudeMdExternalIncludesApproved`，未批准时回退为 `false`。User 文件允许外部 include，Project/Local 则受上述批准状态与 `claudeMdExcludes` 等规则约束。

对 Project 层，每一级目录会尝试三类位置：`CLAUDE.md`、`.claude/CLAUDE.md` 和 `.claude/rules/*.md`；Local 层读取 `CLAUDE.local.md`。User、Project、Local 是否启用，还分别受 `userSettings`、`projectSettings`、`localSettings` setting source 控制。额外工作目录只有在 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` 被判定为真时才自动加载对应 CLAUDE.md；源码注释明确说明该开关默认关闭。

真正把它们变成 user context 的是 `restored-src/src/context.ts`：

```ts
const shouldDisableClaudeMd =
  isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
  (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)
// Await the async I/O (readFile/readdir directory walk) so the event
// loop yields naturally at the first fs.readFile.
const claudeMd = shouldDisableClaudeMd
  ? null
  : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
// Cache for the auto-mode classifier (yoloClassifier.ts reads this
// instead of importing claudemd.ts directly, which would create a
// cycle through permissions/filesystem → permissions → yoloClassifier).
setCachedClaudeMdContent(claudeMd || null)
```

这段代码位于无参数的 `getUserContext` 内，外层由 `memoize` 在会话期间复用结果。`CLAUDE_CODE_DISABLE_CLAUDE_MDS` 为真时硬关闭自动加载；bare mode 在省略显式额外目录时跳过发现，显式 `--add-dir` 仍会保留。`claudeMd` 可以是字符串或 `null`，随后函数只在它非空时加入返回对象；`currentDate` 则始终存在。

`getClaudeMds` 会保留文件来源。它把每份内容写成 `Contents of <path>...`，并标明 Project 是提交进代码库的项目指令、Local 是未提交的私有项目指令、User 是全局私有指令。多份指令共同进入上下文；发生冲突时，静态源码只确认来源说明与排列顺序，最终行为还取决于模型判断。

接下来，`prependUserContext` 把这个对象变成真正的消息：

```ts
export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  if (process.env.NODE_ENV === 'test') {
    return messages
  }

  if (Object.entries(context).length === 0) {
    return messages
  }

  return [
    createUserMessage({
      content: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${Object.entries(
        context,
      )
        .map(([key, value]) => `# ${key}\n${value}`)
        .join('\n')}\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n`,
      isMeta: true,
    }),
    ...messages,
  ]
}
```

`prependUserContext` 的 `messages` 是压缩处理后的本轮消息数组，`context` 是任意字符串键值对象。测试环境直接返回原数组；空对象也跳过消息注入。普通路径创建一条 `isMeta: true` 的 user message，`content` 保存 `<system-reminder>` 与按 `# key` 展开的字段，随后把这条消息放到历史最前面。函数返回新数组并保持原数组不变；参数类型排除 `null`。

所以“CLAUDE.md 在 system prompt 里”只是宽泛说法。按这个版本的实际请求结构，它属于模型上下文，具体位于 `messages`；API 的 `system` 字段只接收 `systemPrompt`。

## 第四步：git 状态是一次会话快照

同一个 `restored-src/src/context.ts` 还定义了 system context：

```ts
const startTime = Date.now()
logForDiagnosticsNoPII('info', 'system_context_started')

// Skip git status in CCR (unnecessary overhead on resume) or when git instructions are disabled
const gitStatus =
  isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
  !shouldIncludeGitInstructions()
    ? null
    : await getGitStatus()

// Include system prompt injection if set (for cache breaking, ant-only)
const injection = feature('BREAK_CACHE_COMMAND')
  ? getSystemPromptInjection()
  : null
```

这段代码位于无参数的 `getSystemContext` 内，外层也使用 `memoize`。`startTime` 只用于诊断耗时。远程模式 `CLAUDE_CODE_REMOTE` 为真，或 `shouldIncludeGitInstructions()` 为假时，`gitStatus` 为 `null`；非 git 目录、命令失败也会让 `getGitStatus()` 返回 `null`。`injection` 只在编译期 feature `BREAK_CACHE_COMMAND` 存在时读取，后续还要是非空字符串才加入返回对象。

`getGitStatus` 并行读取当前分支、主分支、`git status --short`、最近 5 条提交和 `git config user.name`。status 最多保留 2,000 个字符，超过时加截断说明。生成文本第一句就明确指出：这是会话开始时的 snapshot，不会随对话更新。

这项设计有一个很实际的后果。模型知道用户开始会话时有哪些未提交改动，因此能避免把陌生修改误当成自己的；但工具执行几轮以后，这份 git status 可能已经过时。需要精确判断当前状态时，仍应重新运行 git 命令，不能把 system context 当实时订阅。

system context 的追加函数很简单：

```ts
export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}
```

`appendSystemContext` 的 `systemPrompt` 是品牌化的只读字符串数组，`context` 是字符串键值对象。对象为空时 `join()` 得到空字符串，最后由 `filter(Boolean)` 删除；非空时，gitStatus 等字段合并成一个尾部区块。与 `getSystemPrompt` 的 `.filter(s => s !== null)` 不同，这里会过滤所有假值字符串。

## 第五步：default、custom、append 先决定最终 prompt

不同宿主共享原料，但最终选择规则并不完全相同。QueryEngine 的无头路径在 `restored-src/src/QueryEngine.ts` 中这样组装：

```ts
const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

这里 `customSystemPrompt` 经过类型收窄后只剩字符串或 `undefined`；字符串会替换 `defaultSystemPrompt`。`memoryMechanicsPrompt` 是字符串或 `null`，仅在 SDK 同时提供 custom prompt 并显式配置 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 时加载；非空才追加。`appendSystemPrompt` 是字符串或 `undefined`，只有非空字符串会进入数组。`asSystemPrompt` 只做 TypeScript 品牌转换，不拼接、不过滤，也不复制数组。

交互式 REPL 还会调用 `buildEffectiveSystemPrompt`，处理 `overrideSystemPrompt?: string | null`、主线程 Agent、Coordinator 和 proactive/KAIROS 等分支。常规优先级是 agent prompt 高于 custom prompt，custom prompt 高于 default prompt，最后再追加 append prompt；truthy 的 `overrideSystemPrompt` 则直接返回单块覆盖结果。空字符串、`null`、`undefined` 都不会触发 override 分支。

因此，讨论“自定义 system prompt”时必须先说明入口。无头 QueryEngine 以 `customPrompt !== undefined` 判断，交互式覆盖逻辑中还有 truthy 判断和 Agent 特殊路径。源码可以确认这些静态优先级，无法仅凭一个 CLI 参数名推断所有运行模式的最终数组。

## 第六步：queryLoop 在调用前才把三条通道放到一起

最终汇合发生在 `restored-src/src/query.ts`：

```ts
messages: prependUserContext(messagesForQuery, userContext),
systemPrompt: fullSystemPrompt,
thinkingConfig: toolUseContext.options.thinkingConfig,
tools: toolUseContext.options.tools,
signal: toolUseContext.abortController.signal,
```

这五行是 `queryLoop` 传给 `deps.callModel` 的连续字段。`messages` 由压缩后的 `messagesForQuery` 加 user context 得到；`systemPrompt` 是前一步通过 `appendSystemContext` 得到的 `fullSystemPrompt`；`tools` 直接取当前 `toolUseContext.options.tools`。`thinkingConfig` 的源码联合类型只有三种：`{ type: 'adaptive' }`、`{ type: 'enabled'; budgetTokens: number }` 和 `{ type: 'disabled' }`；`enabled` 才要求数字预算。`signal` 是取消信号。紧随其后的 `options` 中，`toolChoice: undefined` 让模型自由选择工具；`isNonInteractiveSession` 是布尔值，用于区分无头和交互宿主的行为。

这段调用也回答了“本轮上下文”究竟是什么：它由 `systemPrompt`、经过处理的消息历史、工具集合和模型选项共同组成。前面第 15 篇得到的搜索结果，如果已经作为 `tool_result` 进入历史，就位于 `messagesForQuery`；其他通道保持原有归属。

## 项目指令还会在深入子目录时动态补充

初始 user context 只覆盖启动时按 cwd 发现的指令。若 Read 后来访问 cwd 下更深的目录，该目录里的 CLAUDE.md 和条件 rules 还需要按路径补充。

FileRead 完成后会把绝对路径加入 `nestedMemoryAttachmentTriggers`。随后 `restored-src/src/utils/attachments.ts` 消费这些触发器：

```ts
async function getNestedMemoryAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (
    !toolUseContext.nestedMemoryAttachmentTriggers ||
    toolUseContext.nestedMemoryAttachmentTriggers.size === 0
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const attachments: Attachment[] = []
  for (const filePath of toolUseContext.nestedMemoryAttachmentTriggers) {
    const nestedAttachments = await getNestedMemoryAttachmentsForFile(
      filePath,
      toolUseContext,
      appState,
    )
    attachments.push(...nestedAttachments)
  }
  toolUseContext.nestedMemoryAttachmentTriggers.clear()
  return attachments
}
```

`getNestedMemoryAttachments` 的 `toolUseContext` 持有触发路径集合、已加载路径、读取缓存和 AppState 访问器。集合缺失或为空时返回空数组，避免等待状态读取；有值时逐路径加载附件，最后清空触发器。返回值始终是 `Attachment[]`，失败路径由更下层捕获后也可能得到空数组。

下层会先确认目标在允许的 working path 内，再依次处理 Managed/User 条件规则、从 cwd 到目标目录的 CLAUDE.md 与 rules，以及 cwd 层级的条件规则。`loadedNestedMemoryPaths` 是不淘汰的 Set，用于阻止同一文件因 Read 缓存 LRU 淘汰而反复注入。

这就是“动态注入”的准确含义：实际访问路径触发新的 attachment，同时保持初始 system prompt 稳定。深层目录规则只在相关文件进入工作集后出现，从而避免无关项目指令提前占用窗口。

## 三个容易误判的边界

第一，**配置字段只有被组装函数读取时才会注入。** 例如 language、output style、setting sources 会改变 prompt。

第二，**cwd 信息和 git 状态的时效不同**。环境区块在默认 prompt 中说明当前工作目录，git status 则明确是会话开始快照。两者都被 memoize 或 section cache 约束，运行中切目录、切 worktree、修改设置后是否立刻反映，必须继续追调用方何时清缓存或重建会话。

第三，**最终请求受运行时装配影响**。feature flag、构建裁剪、provider 缓存作用域、MCP 连接、Agent 定义、custom/append prompt 和压缩结果都会改变最终请求。本文能够证明的是默认控制流、优先级和回退值；具体机器上的请求仍需结合运行时配置验证。

## 小结

Claude Code 的项目上下文组装可以归纳成四步。

第一，`fetchSystemPromptParts` 并行准备默认 system prompt、user context 和 system context。custom prompt 会替换默认 prompt，并在 QueryEngine 路径跳过默认 git context。

第二，`getSystemPrompt` 把稳定行为规范放在前面，把 auto-memory 使用说明、环境、语言、output style、MCP 指令等动态 section 放在后面；普通 section 缓存，明确标记为 `cacheBreak` 的 section 才每轮重算。

第三，CLAUDE.md 按 Managed、User、Project、Local 等来源发现，初始内容通过 meta user message 进入 `messages`；git 分支、status 和最近提交通过 system context 追加到 `system`；深层目录规则则由文件访问触发 attachment。

第四，query loop 在模型调用前才把这些通道汇合，并把工具集合作为独立 `tools` 参数发送。这样既保留了 prompt 缓存的稳定前缀，也保留了消息、环境快照和结构化工具契约各自的边界。

## 留给下一篇的问题

当对话历史、工具结果和项目上下文不断增长并逼近模型窗口时，Claude Code 如何判断何时压缩、保留什么、又怎样继续会话？

## 参考资料

- [Claude Code 项目记忆](https://code.claude.com/docs/en/memory)

- [Claude Code Prompt Caching](https://code.claude.com/docs/en/prompt-caching)
