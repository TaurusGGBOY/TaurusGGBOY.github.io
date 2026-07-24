---
title: "Claude Code源码解读46：文档生成与提示词建议如何工作"
published: 2026-07-24T16:47:33+08:00
updated: 2026-07-24T16:47:33+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-46/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

语音输入补充交互以后，MagicDocs 与 Prompt Suggestions 如何从上下文生成文档和下一步建议，并把结果展示给用户？

先说答案：**它们都在主回合结束以后读取上下文，再启动一条旁路生成；但两条旁路的输入、输出和确认方式完全不同。**

MagicDocs 先等主 Agent 通过 `Read` 看见带有 `# MAGIC DOC:` 标记的 Markdown，再把文件路径记进进程内 `Map`。模型完成一次采样、最后一条 assistant 消息也没有工具调用时，它重新读取文档，把完整会话、system prompt、用户上下文、当前文档和自定义说明交给一个 Sonnet 子 Agent。这个 Agent 不把文档“展示成建议”，而是只能对刚才那一个文件调用 `Edit`；没有值得补充的内容时，它也可以什么都不改。

Prompt Suggestions 则在主线程停止阶段预测“用户下一句最可能输入什么”。它复用父请求的缓存安全参数，启动一个禁用所有工具的 fork，只取 2 到 12 个词的文本。通过长度、格式和语气过滤后，候选值写进 AppState，输入框为空且主 Agent 已停止响应时，才作为 ghost text 展示。用户按 Tab 或在空输入框按 Enter，就把它变成普通 prompt；用户输入别的内容再提交，就记为 ignored 并清掉。

所以，这里没有一个统一的“主动生成服务”。MagicDocs 的终点是受限文件编辑，Prompt Suggestions 的终点是等待用户确认的输入候选。前者在 2.1.88 的源码里还被 `USER_TYPE === 'ant'` 限制，后者则受环境变量、GrowthBook、交互模式、设置、权限等待状态等多道门控制。把两者混成“Claude 自动帮你做下一步”，会错过最重要的边界。

本篇仍只讨论仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码。下面的片段省略了与当前机制无关的类型、日志和分支；函数名、关键取值与调用顺序保持不变。

## 两条旁路，不是一条流水线

先补两个基础概念。

**forked agent** 是从当前会话上下文分叉出来的一次模型执行。它能看见父会话提供的历史和配置，但可以拥有更窄的提示词、工具与持久化策略。这样做的价值是：文档维护和下一句预测都不必污染主 Agent 的回答，也不需要把结果塞回主对话，让主模型再判断一次。

**post-sampling hook** 是模型采样完成后的内部回调。它不是用户在 `settings.json` 里配置的普通 Hook；2.1.88 的 `postSamplingHooks.ts` 明确把它称为内部 API。MagicDocs 注册在这里。Prompt Suggestions 虽然也发生在回合尾部，却从 `handleStopHooks()` 直接触发。它们时机相近，注册入口并不相同。

两条链可以压成下面这张图：

![MagicDocs 与 Prompt Suggestions 两条回合后旁路的手绘流程图](/images/posts/claude-code-source-reading-46/46-magicdocs-prompt-suggestions-handdrawn.png)

图中实线对应还原源码可确认的调用或状态流。注意上、下两条线没有互相调用：MagicDocs 不会拿提示词建议去写文档，Prompt Suggestions 也不会读取 Magic Doc 作为专用知识源。

## MagicDocs：先用文件头声明“这份文档要被维护”

MagicDocs 没有扫描整个仓库找文档。它只监听已经被 `FileReadTool` 读过的内容，再用一个特殊标题识别 opt-in 文件。核心识别函数在 `restored-src/src/services/MagicDocs/magicDocs.ts`：

```ts
const MAGIC_DOC_HEADER_PATTERN = /^#\s*MAGIC\s+DOC:\s*(.+)$/im
const ITALICS_PATTERN = /^[_*](.+?)[_*]\s*$/m

export function detectMagicDocHeader(
  content: string,
): { title: string; instructions?: string } | null {
  const match = content.match(MAGIC_DOC_HEADER_PATTERN)
  if (!match || !match[1]) return null

  const title = match[1].trim()
  // 省略“标题后下一行或隔一个空行”的定位代码
  const italicsMatch = nextLine.match(ITALICS_PATTERN)
  if (italicsMatch && italicsMatch[1]) {
    return { title, instructions: italicsMatch[1].trim() }
  }
  return { title }
}
```

**函数与参数说明：** `detectMagicDocHeader(content)` 的 `content` 是完整文件字符串。匹配成功时返回 `{ title }`，紧随标题的斜体行存在时再增加可选字符串 `instructions`；不匹配返回 `null`，这里没有 `undefined` 返回值。正则带 `i` 和 `m`：大小写不敏感，并允许 `^` 匹配任意行首；因此实现实际上不只认文件第一行，尽管源码注释写着 first line。文章以可执行正则为准，不把注释扩大成不存在的约束。

斜体说明不是展示文案，而是给文档维护 Agent 的额外指令。例如：

```md
# MAGIC DOC: Authentication architecture

_Only preserve stable entry points and security boundaries._
```

**格式说明：** 标题的 `MAGIC` 与 `DOC` 之间至少一个空白，冒号后必须有非空标题；斜体说明由 `_` 或 `*` 包住。源码注释的设计意图是“紧邻下一行，允许一个空行”，但定位正则开头用了也能匹配换行的 `\s*`，实际可能吞掉更多空白；因此不能把“至多一个空行”当成严格校验规则。与标题区段无关的普通斜体不会进入 `instructions`。

只有文件真的被读过，路径才进入 `trackedMagicDocs`。同一路径只登记一次，Map 不保存当时的标题和内容，更新前会重新读取：

```ts
const trackedMagicDocs = new Map<string, MagicDocInfo>()

export function registerMagicDoc(filePath: string): void {
  if (!trackedMagicDocs.has(filePath)) {
    trackedMagicDocs.set(filePath, { path: filePath })
  }
}

export async function initMagicDocs(): Promise<void> {
  if (process.env.USER_TYPE === 'ant') {
    registerFileReadListener((filePath, content) => {
      if (detectMagicDocHeader(content)) registerMagicDoc(filePath)
    })
    registerPostSamplingHook(updateMagicDocs)
  }
}
```

**函数与参数说明：** `registerMagicDoc(filePath)` 接受由文件读取监听器提供的路径字符串。重复路径保持原记录，不会追加版本。`initMagicDocs()` 没有参数，返回 `Promise<void>`；`USER_TYPE` 严格等于字符串 `'ant'` 时才注册两个回调，`undefined`、`'external'` 或其他值都不启用。。

这意味着“生成文档”的第一步其实不是生成，而是声明与发现。用户（或已有文件）用标题声明这份 Markdown 可以被后台维护，主 Agent 的普通 `Read` 再让运行时发现它。源码没有周期性目录扫描，也没有为未读文件建立索引。

## 更新只在主对话空闲时串行发生

注册后的 `updateMagicDocs` 会经过三道门：来源必须是 `repl_main_thread`，最后一个 assistant turn 不能含工具调用，Map 里必须已有文档。多个文档逐个等待完成；外层 `sequential()` 还保证同一 hook 的多次调用排队，而不是重叠执行。

```ts
const updateMagicDocs = sequential(async function (
  context: REPLHookContext,
): Promise<void> {
  const { messages, querySource } = context

  if (querySource !== 'repl_main_thread') return
  if (hasToolCallsInLastAssistantTurn(messages)) return
  if (trackedMagicDocs.size === 0) return

  for (const docInfo of Array.from(trackedMagicDocs.values())) {
    await updateMagicDoc(docInfo, context)
  }
})
```

**函数与参数说明：** `context` 包含完整 `messages`、system/user/system context 和 `toolUseContext`。`querySource` 是运行时来源；这里只接受精确值 `'repl_main_thread'`，`undefined`、`'sdk'`、`'magic_docs'` 以及其他子 Agent 来源都直接返回。`hasToolCallsInLastAssistantTurn()` 返回布尔值，`true` 表示主 Agent 还在工具循环附近，本次不更新；`false` 才继续。Map 为空时没有模型调用。

“空闲”在这里是很窄的代码判断：最后一次 assistant turn 没有工具调用。它不等于操作系统空闲，也不代表用户离开终端。MagicDocs 更不会每隔固定分钟自动跑一次；源码说明里的 periodically，落实到调用链上，是每次 post-sampling hook 获得机会时重新判断。

## 上下文不是只拿聊天记录，而是四层合并

更新单个文档时，MagicDocs 会重新读取最新内容。它特意克隆 `readFileState`，再删掉当前路径的缓存项，避免 `FileReadTool` 因“文件未变化”只返回 `file_unchanged` 占位符。

```ts
const clonedReadFileState = cloneFileStateCache(
  toolUseContext.readFileState,
)
clonedReadFileState.delete(docInfo.path)

const result = await FileReadTool.call(
  { file_path: docInfo.path },
  { ...toolUseContext, readFileState: clonedReadFileState },
)
```

**调用与参数说明：** `cloneFileStateCache()` 接收父会话的文件状态缓存，产生隔离副本；`delete(docInfo.path)` 只清当前 Magic Doc。`FileReadTool.call()` 的输入对象只有开放字符串 `file_path`，值固定来自跟踪记录，不由模型临时选择。第二个参数沿用父 `toolUseContext` 的其他字段，但替换缓存副本，因此读取不会破坏主会话自己的去重状态。

随后，`buildMagicDocsUpdatePrompt()` 把四个变量塞进模板：当前文档全文、文件路径、标题、可选说明。模板默认要求维护“当前状态”，不是追加 changelog；没有实质新信息时不要调用工具。用户还可以在 `~/.claude/magic-docs/prompt.md` 放自定义模板：

```ts
export async function buildMagicDocsUpdatePrompt(
  docContents: string,
  docPath: string,
  docTitle: string,
  instructions?: string,
): Promise<string> {
  const promptTemplate = await loadMagicDocsPrompt()
  const customInstructions = instructions
    ? `DOCUMENT-SPECIFIC UPDATE INSTRUCTIONS: ... "${instructions}"`
    : ''

  return substituteVariables(promptTemplate, {
    docContents,
    docPath,
    docTitle,
    customInstructions,
  })
}
```

**函数与参数说明：** 前三个参数都是开放字符串，分别来自最新文件、跟踪路径和重新识别的标题；`instructions` 是 `string | undefined`，缺省时 `customInstructions` 回退为空字符串。自定义模板读取失败（包括不存在或不可读）会静默回退默认模板。替换只处理 `{{wordName}}` 形式的已知键；未知变量保留原样，而且单次 `replace()` 不会再次替换文档正文里碰巧出现的占位符。

最终的 Agent 同时拿到两类上下文：`forkContextMessages: messages` 提供父会话历史；`override` 继续使用本轮 `systemPrompt`、`userContext` 和 `systemContext`；新的 user message 则装入维护规则和当前文档。这比“把聊天总结成 Markdown”更精确：它是在父会话语义、项目环境与文档现状之间做受限更新。

## 文档更新没有确认弹窗，但权限被压到一个文件

MagicDocs 使用内建 Agent 定义，模型固定为 `'sonnet'`，工具声明只含 `Edit`。更关键的是，它另写了一层 `canUseTool`：工具名必须是 `Edit`，输入必须是非 `null` 对象，`file_path` 必须是字符串，并且必须等于当前文档路径。

```ts
function getMagicDocsAgent(): BuiltInAgentDefinition {
  return {
    agentType: 'magic-docs',
    tools: [FILE_EDIT_TOOL_NAME],
    model: 'sonnet',
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => '',
  }
}

const canUseTool = async (tool: Tool, input: unknown) => {
  if (
    tool.name === FILE_EDIT_TOOL_NAME &&
    typeof input === 'object' && input !== null &&
    'file_path' in input && input.file_path === docInfo.path
  ) {
    return { behavior: 'allow' as const, updatedInput: input }
  }
  return { behavior: 'deny' as const, message: `only Edit is allowed ...` }
}
```

**函数与取值说明：** `getMagicDocsAgent()` 没有参数。`agentType`、`source`、`baseDir` 是固定字符串，模型固定 `'sonnet'`；本文不能把它外推为可配置模型。`canUseTool(tool, input)` 的 `input` 类型是 `unknown`，必须逐层收窄；成功只返回 `behavior: 'allow'`，并原样返回 `updatedInput`。其余工具、`null`、非对象、缺少路径、非字符串路径或其他文件路径都返回 `behavior: 'deny'`，没有 `'ask'` 分支。

这回答了“接受/拒绝”的一半：**MagicDocs 没有为每次编辑展示接受按钮。** opt-in 发生在文件标记与被读取时，执行阶段则由内部权限回调自动允许精确文件上的 `Edit`，自动拒绝其他行为。它不会因为是“文档功能”就获得 `Write`、Bash 或整个仓库的编辑权。

`runAgent()` 的消息被 `for await` 完整消费，但没有合并进主 transcript，也没有单独渲染 Agent 的解释文本。可观察产物是文件是否被 `Edit` 改变。若模型判断没有重大新信息，默认提示允许它只返回简短解释并停止，此时用户不会得到一份待接受的 diff 卡片。

## Prompt Suggestions：预测用户会说什么，不是建议 Claude 应该做什么

Prompt Suggestions 的提示词把目标限定得非常死：看最近消息与原始请求，预测用户自然会输入的下一句；不要评价、不要提问、不要引入新想法、不要用 Claude 的口吻，输出 2 到 12 个词或者保持空白。

这一区分很重要。任务规划回答“系统下一步应该做什么”，Prompt Suggestions 回答“用户大概率正准备输入什么”。即使两者碰巧都生成 `run tests`，评价标准也不同：前者看任务正确性，后者看对用户意图的延续。

初始化开关先经过一条明确的优先级链：

```ts
export function shouldEnablePromptSuggestion(): boolean {
  const envOverride = process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION
  if (isEnvDefinedFalsy(envOverride)) return false
  if (isEnvTruthy(envOverride)) return true

  if (!getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_chomp_inflection', false,
  )) return false
  if (getIsNonInteractiveSession()) return false
  if (isAgentSwarmsEnabled() && isTeammate()) return false

  return getInitialSettings()?.promptSuggestionEnabled !== false
}
```

**函数与取值说明：** 函数没有参数。环境变量若被帮助函数识别为显式假值则强制关闭，识别为真值则强制开启，并且优先于后续所有门；静态片段没有在这里硬编码可枚举字符串，因此本文不臆造完整真/假值列表。环境变量未形成覆盖时，GrowthBook 键以 `false` 为回退值；非交互会话关闭；启用 swarm 且当前是 teammate 时关闭。设置字段为 `boolean | undefined`：只有 `false` 关闭，`true` 与 `undefined` 都通过最后一关。

环境变量真值会“覆盖所有门”是源码注释表达的测试通道语义。因此它甚至早于非交互与 teammate 判断。正常产品路径下则先要求实验开关存在，再谈用户设置。Settings UI 只有 GrowthBook 开启时才显示 `Prompt suggestions`；用户打开时把持久字段写回 `undefined`，关闭时写 `false`，用缺省值表达默认开启。

## 生成之前先判断是否值得花这次模型调用

`handleStopHooks()` 在非 bare 模式下 fire-and-forget 调用 `executePromptSuggestion()`。真正生成前，`tryGenerateSuggestion()` 还会检查会话成熟度、上一条响应、缓存成本与 AppState：

```ts
export function getSuggestionSuppressReason(
  appState: AppState,
): string | null {
  if (!appState.promptSuggestionEnabled) return 'disabled'
  if (appState.pendingWorkerRequest || appState.pendingSandboxRequest)
    return 'pending_permission'
  if (appState.elicitation.queue.length > 0) return 'elicitation_active'
  if (appState.toolPermissionContext.mode === 'plan') return 'plan_mode'
  if (process.env.USER_TYPE === 'external' &&
      currentLimits.status !== 'allowed') return 'rate_limit'
  return null
}
```

**函数与返回值说明：** `appState` 是当前状态快照。返回开放字符串原因或 `null`；`null` 代表这一组守卫没有阻止生成，不等于生成一定成功。`pendingWorkerRequest` 与 `pendingSandboxRequest` 都是对象或 `null`，任一个非空都归为 `'pending_permission'`。elicitation 队列非空、权限模式精确为 `'plan'`、外部用户当前限额状态不是 `'allowed'` 也会分别阻止。

除此之外，assistant 消息少于 2 条会记为 `early_conversation`；上一条 assistant 是 API 错误会停止；父请求最新 usage 的 `input_tokens + cache_creation_input_tokens + output_tokens` 超过 10,000，会以 `cache_cold` 停止。这里的阈值不是会话总 token，也不是模型窗口上限，而是源码为这条 fork 定义的未缓存成本保护。

## 缓存的关键不是“存住答案”，而是别改父请求的 cache key

建议生成调用 `runForkedAgent()`，却刻意不传 `tools: []`，也不改 effort 或输出 token 参数。源码注释说明，这些改变会破坏与父请求共享的缓存键。它改用客户端 `canUseTool` 拒绝工具，并且不写 transcript、不增加新的 cache write 标记：

```ts
const canUseTool = async () => ({
  behavior: 'deny' as const,
  message: 'No tools needed for suggestion',
  decisionReason: { type: 'other' as const, reason: 'suggestion only' },
})

const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: prompt })],
  cacheSafeParams,
  canUseTool,
  querySource: 'prompt_suggestion',
  forkLabel: 'prompt_suggestion',
  overrides: { abortController },
  skipTranscript: true,
  skipCacheWrite: true,
})
```

**调用与参数说明：** `cacheSafeParams` 由父回合上下文生成，目的在保持服务端 cache-key 相关参数一致；它不是“建议文本缓存”。`canUseTool` 无论收到什么工具与输入都返回 `'deny'`，没有 allow/ask 候选。`abortController` 只控制客户端取消；`skipTranscript: true` 表示这条 fork 不写入会话记录，`skipCacheWrite: true` 控制 cache-control 标记。两个布尔值固定为真，源码没有在此提供回退分支。

模型仍可能先尝试工具、被拒绝后再输出文本，所以代码遍历 fork 返回的所有 assistant 消息，取第一个非空 text block，而不是只看最后一条。第一条 assistant 的 `requestId` 还会保存为 `generationRequestId`，用于后续统计关联；没有 request ID 时为 `null`。

文本回来后并不会原样展示。过滤器拒绝 `done`、解释“没有建议”的元文本、括号包裹的推理、API 错误、`label: value` 前缀、超过 12 词、长度达到 100、多个句子、Markdown、评价性表达与 Claude 口吻。单词建议通常被拒绝，但 slash command 和 `yes`、`push`、`commit`、`deploy`、`stop`、`continue` 等白名单值可以通过。这里是确定性过滤，不是第二次模型审核。

## 展示是临时 AppState，不是跨会话历史

通过过滤的结果写入 AppState：文本与 prompt variant 一起保存，`shownAt`、`acceptedAt` 初始化为 0。它不是磁盘缓存，也不会因 `skipTranscript` 被恢复到下一次会话。

```ts
promptSuggestion: {
  text: result.suggestion,
  promptId: result.promptId,
  shownAt: 0,
  acceptedAt: 0,
  generationRequestId: result.generationRequestId,
}

const suggestion =
  isAssistantResponding || inputValue.length > 0
    ? null
    : suggestionText
```

**字段与取值说明：** `text`、`promptId`、`generationRequestId` 都允许 `null`；当前 `PromptVariant` 类型包含 `'user_intent' | 'stated_intent'`，而 `getPromptVariant()` 在 2.1.88 固定返回 `'user_intent'`。`shownAt` 和 `acceptedAt` 是毫秒时间戳，0 表示尚未发生。`inputValue` 是任意输入字符串；主 Agent 正在响应或字符串长度大于 0 时，hook 返回的可展示 suggestion 为 `null`。

PromptInput 还要求当前处于 prompt mode、没有普通 typeahead 候选、没有查看 teammate 任务。满足后才把 `shownAt` 改为 `Date.now()`，并把 suggestion 当作输入框 placeholder。若候选已生成，却因为用户已经开始输入等时序原因无法展示，代码记录 `timing` suppression 并清空状态。

换句话说，AppState 里“有候选”不等于用户“看见候选”。`shownAt > 0` 才是展示完成的证据。这个区分随后用于判断接受、忽略和停留时间。

## Tab、Enter 与继续打字，对应三条结果

建议显示后有三种主要去向。

1. Tab 接受：typeahead 路径把 ghost text 放入输入，并记录 `acceptedAt`。
2. 空输入框按 Enter，或提交内容与候选完全相等：PromptInput 把候选作为真正输入提交；如果 speculative execution 已开始，还会接管已经流出的推测结果。
3. 用户输入其他内容并提交：结果记为 `'ignored'`，然后清空 suggestion。

核心判断在 `usePromptSuggestion()`：

```ts
const tabWasPressed = acceptedAt > shownAt
const wasAccepted =
  tabWasPressed || finalInput === suggestionText

logEvent('tengu_prompt_suggestion', {
  outcome: wasAccepted ? 'accepted' : 'ignored',
  ...(wasAccepted && {
    acceptMethod: tabWasPressed ? 'tab' : 'enter',
  }),
})

if (!opts?.skipReset) resetSuggestion()
```

**函数与参数说明：** `logOutcomeAtSubmission(finalInput, opts?)` 的 `finalInput` 是用户最终提交的开放字符串。`opts` 是可选对象，唯一字段 `skipReset` 为 boolean；`undefined` 或 `false` 都会清理，`true` 只用于 speculative execution 接管时避免过早 abort。接受结果只有 `'accepted'`，否则为 `'ignored'`；接受方式只有 `'tab'` 或 `'enter'`。源码没有单独的“拒绝按钮”，继续输入并提交就是拒绝语义。

这里也有隐私边界。通用事件会上报 outcome、prompt id、用时、焦点状态和长度相似度；只有 `USER_TYPE === 'ant'` 的分支才额外附带 suggestion 与 userInput 原文。

## 取消、失败与不可见结果

两套能力都被设计成旁路失败，不阻断主回答，但失败方式不同。

MagicDocs 重新读取时，如果文件不存在、EACCES/EPERM，或内容已不再匹配 Magic Doc 标题，就从 Map 删除路径并返回。其他异常会向 post-sampling hook 冒泡，由统一执行器记录错误后继续，不会让 queryLoop 因文档维护失败而失败。自定义提示词读取失败静默回退默认模板。。

Prompt Suggestions 使用模块级 `currentAbortController`。新生成开始后可以由 `abortPromptSuggestion()` 取消；`AbortError` 和 `APIUserAbortError` 记为 aborted 并静默返回，其他错误只写日志。空输出、过滤命中、过早会话、API 错误、缓存过冷、权限等待、elicitation、plan mode、rate limit 和展示时序都可能让用户什么也看不到。这不是 UI 丢消息，而是源码有意把“不打扰”当作合法终态。

还要注意 fire-and-forget 的时序：`handleStopHooks()` 用 `void executePromptSuggestion(...)` 启动建议生成，主回合不等待它；MagicDocs 由 post-sampling hook 执行器 `await`，但 hook 自己处在主采样之后。。

## 小结

MagicDocs 与 Prompt Suggestions 都复用了 Claude Code 已有的会话上下文和 Agent 执行能力，但它们刻意选择了不同的落点。

MagicDocs 通过特殊文件头和 `Read` 监听建立进程内跟踪，在主 REPL 没有继续工具调用时，重新读取当前文档，把父会话、系统上下文和文档指令交给 Sonnet fork。它没有逐次确认 UI，却把权限收窄到“只允许 Edit 当前精确路径”；文件消失、不可读或移除标题后就停止跟踪。2.1.88 里它只在 `USER_TYPE === 'ant'` 初始化，这是一条不能忽略的产品边界。

Prompt Suggestions 在停止阶段预测用户下一句，先经过功能门与运行时 suppress guards，再用父请求的 cache-safe 参数启动禁用工具、跳过 transcript 的 fork。通过确定性过滤的短文本只存在 AppState，在输入框真正可展示后才记录 `shownAt`。Tab 或 Enter 把候选变成普通输入，其他提交记为 ignored；取消、过滤和失败都可以安静结束。

真正值得借鉴的不是“再调一次模型”，而是每次旁路生成都要回答四个问题：它读哪些上下文，能产生什么副作用，谁负责确认，失败是否影响主路径。MagicDocs 和 Prompt Suggestions 给出了两套不同但都很克制的答案。

## 留给下一篇的问题

文档与建议生成以后，Claude Code 如何通过通知、mailbox 与 output style 把结果送到正确的人、Agent 和界面，并完成整个运行闭环？

