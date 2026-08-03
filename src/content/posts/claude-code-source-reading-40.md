---
title: "Claude Code源码解读40：如何从会话中提炼知识"
published: 2026-07-24T16:47:27+08:00
updated: 2026-07-24T16:47:27+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-40/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

首次启动完成以后，Claude Code 的 Session Memory 如何从长会话中提炼、保存并在后续压缩和恢复中复用长期信息？

先看它解决的故障：长会话接近上下文上限时，原始 transcript 不能同时承担“完整记录”和“长期提示”。2.1.88 把两者拆开：Session Memory 是按项目、按 session 隔离的本地 Markdown 投影，主 REPL 在采样后按阈值启动 forked agent，只允许它 `Edit` 当前 session 的 `session-memory/summary.md`；transcript 继续保留完整事实。

这份文件有两个明确消费者。上下文需要压缩时，实验性的 SM Compact 会用它替代一次新的摘要模型调用，再拼回近期消息、SessionStart hooks 和 compact boundary；用户离开后回来时，`awaySummary` 也会把它作为较宽的背景，配合最近 30 条消息生成一段很短的回顾。恢复同一个 session 时，文件路径仍然可定位，但模块内的“摘要到哪条消息”为进程内状态，可能已经丢失，因此恢复分支会采取更保守的消息保留策略。

因此更准确的模型是：

> transcript 是原始事实流，`summary.md` 是可编辑的长期工作状态，compaction 是把这份状态重新注入会话的时机。

它们相互配合，并各自保留独立的生命周期。

## 本章先建立三个概念

- **情景到语义的蒸馏**：会话事件被压缩成可跨会话复用的项目事实、偏好和操作经验。

- **Watermark**：游标记录已处理到 transcript 的哪个边界，增量提炼可以跳过旧内容。

- **再注入**：记忆文件在启动或压缩后重新进入上下文，继续影响后续模型决策。

![会话内容如何蒸馏成可再注入记忆](/images/posts/claude-code-source-reading-40/40-memory-distillation-detail-handdrawn.png)

先把 transcript、summary 文件和 compaction 的职责分开，后文的阈值、游标和权限限制才容易读懂。

## Session Memory 以项目和会话划定作用域

先看完整链路。

![Claude Code Session Memory 的提炼、保存与压缩复用链路](/images/posts/claude-code-source-reading-40/40-session-memory-handdrawn.png)

图里最需要注意的是两条边界。

第一，`summary.md` 属于当前 session，路径由当前项目目录和 `sessionId` 共同决定。第二，记忆文件会落盘，`lastSummarizedMessageId`、上次提取时的 token 数等游标只存在模块状态里；进程重启后文件仍在，游标会按恢复逻辑重建或保持空值。

源码直接给出了路径结构：

```ts
export function getSessionMemoryDir(): string {
  return join(getProjectDir(getCwd()), getSessionId(), 'session-memory') + sep
}

export function getSessionMemoryPath(): string {
  return join(getSessionMemoryDir(), 'summary.md')
}
```

函数说明：这两个函数位于 `restored-src/src/utils/permissions/filesystem.ts`。`getSessionMemoryDir()` 先把当前 cwd 映射到 Claude Code 的项目目录，再拼上当前 `sessionId` 和 `session-memory/`；`getSessionMemoryPath()` 最终固定指向该目录下的 `summary.md`。

参数说明：两个函数都接受零个显式参数，输入来自运行时的 `getCwd()` 与 `getSessionId()`；返回目录带尾部分隔符，文件路径不带。路径中包含当前 session ID，因此读写会落在当前会话目录，目录级与团队级检索由下一篇的 `memdir` / Team Memory 处理。

## 启动时只注册 hook，不立刻生成记忆

Session Memory 不在启动时同步扫描整份 transcript。`setup()` 只注册 post-sampling 回调，主循环产生一轮消息后，回调才依据来源、feature gate 和 token/工具阈值决定是否提炼。

```ts
export function initSessionMemory(): void {
  if (getIsRemoteMode()) return
  const autoCompactEnabled = isAutoCompactEnabled()

  if (!autoCompactEnabled) {
    return
  }

  registerPostSamplingHook(extractSessionMemory)
}
```

函数说明：`initSessionMemory()` 位于 `restored-src/src/services/SessionMemory/sessionMemory.ts`，由 `restored-src/src/setup.ts` 的 `setup()` 调用。这里省略了仅用于内部事件记录的分支。函数只注册 `extractSessionMemory`，不会在启动阶段读取 transcript 或创建 `summary.md`。

参数说明：函数接受零个参数并返回 `void`。`getIsRemoteMode() === true` 或 `isAutoCompactEnabled() === false` 时直接退出；本地且 auto compact 开启时才注册后续 hook。`autoCompactEnabled` 是二值布尔开关。

hook 触发后还要过三道门：只接受 `querySource === 'repl_main_thread'`，读取缓存中的 `tengu_session_memory` feature gate，并懒加载远端动态阈值配置。

```ts
const extractSessionMemory = sequential(async function (
  context: REPLHookContext,
): Promise<void> {
  const { messages, toolUseContext, querySource } = context

  if (querySource !== 'repl_main_thread') return
  if (!isSessionMemoryGateEnabled()) return

  initSessionMemoryConfigIfNeeded()
  if (!shouldExtractMemory(messages)) return
  // 后续：读取文件、运行 forked agent、更新游标
})
```

函数说明：`extractSessionMemory` 是 post-sampling hook，也是自动提炼的主入口。外层 `sequential()` 会把多次触发串行化，避免两个提炼任务同时编辑同一份文件。上面只截取门控分支，完整执行路径在后文继续展开。

参数说明：`context` 是 `REPLHookContext`，本文用到 `messages`、`toolUseContext` 与 `querySource`。`querySource` 必须精确等于 `'repl_main_thread'`；subagent、teammate 等其他来源都会跳过。

因此，磁盘上出现 session memory 还要求本地普通模式、auto compact 开启且缓存 gate 为 true；任一门槛失败都会跳过自动提炼。

## 什么时候值得提炼：token 是硬条件

默认阈值定义在 `sessionMemoryUtils.ts`：首次要到 10,000 个上下文 token；两次更新之间至少再增长 5,000；工具调用阈值为 3。

```ts
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000,
  minimumTokensBetweenUpdate: 5000,
  toolCallsBetweenUpdates: 3,
}
```

函数说明：这段是自动提炼的默认配置对象。远端动态配置 `tengu_sm_config` 可以覆盖三个字段，但 `initSessionMemoryConfigIfNeeded()` 只接受显式提供的正数；`0`、负数、`undefined` 都回退到这里的默认值。

参数说明：三个字段都是 number。`minimumMessageTokensToInit` 是首次初始化门槛；`minimumTokensBetweenUpdate` 衡量自上次提炼后的上下文增长；`toolCallsBetweenUpdates` 是两次更新之间的 `tool_use` 数量。源码只检查 `> 0`，正小数也可通过；真实远端取值由运行时配置源返回，本文不逐一枚举。

阈值组合采用两阶段判断：token 增长是硬条件，工具数与自然停顿再决定当前时点是否适合执行。

```ts
const hasMetTokenThreshold = hasMetUpdateThreshold(currentTokenCount)
const hasMetToolCallThreshold =
  countToolCallsSince(messages, lastMemoryMessageUuid) >=
  getToolCallsBetweenUpdates()
const hasToolCallsInLastTurn = hasToolCallsInLastAssistantTurn(messages)

const shouldExtract =
  (hasMetTokenThreshold && hasMetToolCallThreshold) ||
  (hasMetTokenThreshold && !hasToolCallsInLastTurn)
```

函数说明：这段来自 `shouldExtractMemory()`。首次调用先检查 `minimumMessageTokensToInit`，达到后把 `sessionMemoryInitialized` 置为 true。之后必须满足 `hasMetTokenThreshold`，再满足“工具数够多”或“最后一轮 assistant 已自然收尾”之一。

参数说明：`messages` 是当前 `Message[]`；`currentTokenCount` 来自 `tokenCountWithEstimation(messages)`。`lastMemoryMessageUuid` 为 `string | undefined`，游标省略时从消息数组开头统计。`hasToolCallsInLastTurn` 是布尔值：false 在这里只代表最后一轮形成自然对话断点，历史轮次仍可能调用过工具。

这个判断有两个工程目的。一是避免每个工具结果都触发一次后台摘要；二是尽量不要在一组 `tool_use` / `tool_result` 尚未稳定时记录“当前状态”。达到阈值后，函数还会先把最后一条消息 uuid 写入 `lastMemoryMessageUuid`，作为下一轮工具计数的起点。

## 文件第一次出现时，先建立结构，再让 agent 编辑

提炼真正开始后，Claude Code 创建 session memory 目录和文件。目录权限是 `0700`，文件权限是 `0600`；第一次创建使用 `wx`，避免覆盖已经存在的记忆。

```ts
await fs.mkdir(sessionMemoryDir, { mode: 0o700 })

try {
  await writeFile(memoryPath, '', {
    encoding: 'utf-8',
    mode: 0o600,
    flag: 'wx',
  })
  const template = await loadSessionMemoryTemplate()
  await writeFile(memoryPath, template, {
    encoding: 'utf-8',
    mode: 0o600,
  })
} catch (e: unknown) {
  if (getErrnoCode(e) !== 'EEXIST') throw e
}
```

函数说明：这段来自 `setupSessionMemoryFile()`。它只在 `wx` 创建成功后写入模板；若文件已存在，保留原内容。随后函数会删掉 `readFileState` 中该路径的缓存，再用 `FileReadTool.call()` 取得真实文件内容，避免读到 `file_unchanged` 占位结果。

参数说明：`mode: 0o700` 表示目录仅当前用户可读、写、进入；`mode: 0o600` 表示文件仅当前用户可读写。`flag: 'wx'` 是“独占创建”，存在时抛 `EEXIST`；这里只吞掉 `EEXIST`，其他错误继续抛出。`encoding` 固定为 `'utf-8'`。

默认模板用十个一级标题组织摘要：`Session Title`、`Current State`、`Task specification`、`Files and Functions`、`Workflow`、`Errors & Corrections`、`Codebase and System Documentation`、`Learnings`、`Key results`、`Worklog`。每个标题后还有一行斜体说明，告诉提炼 agent 什么内容应该放进这一节。

固定结构把结果、下一步、失败方案和用户纠正拆成独立章节，后续更新可以定向替换某一节，避免每次重写一篇越来越长的散文。

用户也可以提供本地模板和 prompt：

```ts
const templatePath = join(
  getClaudeConfigHomeDir(),
  'session-memory',
  'config',
  'template.md',
)

const promptPath = join(
  getClaudeConfigHomeDir(),
  'session-memory',
  'config',
  'prompt.md',
)
```

函数说明：`loadSessionMemoryTemplate()` 和 `loadSessionMemoryPrompt()` 位于 `restored-src/src/services/SessionMemory/prompts.ts`。对应文件不存在（`ENOENT`）时分别回退到内置模板和内置更新提示词；其他读取错误也会记录并回退，主会话继续运行。

参数说明：两个 loader 都接受零个调用参数。自定义 prompt 支持 `{{currentNotes}}` 与 `{{notesPath}}` 变量；替换逻辑是单遍匹配 `{{word}}`。已知变量替换为字符串，未知变量保持原样。模板按原始 Markdown 读取，结构一致性由用户维护。

## 更新由受限 fork 独立执行

拿到旧文件后，`buildSessionMemoryUpdatePrompt()` 会把 `currentNotes` 和 `notesPath` 填进更新提示词。默认提示词要求保留全部标题与斜体说明，只编辑说明行下方的实际内容；缺少新信息的章节保持原文。

提示词还会计算每节和全文的粗略 token 数。单节超过约 2,000 token 会追加压缩提醒；全文超过约 12,000 token，会要求优先保住 `Current State` 与 `Errors & Corrections`，同时淘汰较旧、较次要的信息。这是一套有容量约束的滚动维护。

随后执行一个隔离的 forked agent：

```ts
await runForkedAgent({
  promptMessages: [createUserMessage({ content: userPrompt })],
  cacheSafeParams: createCacheSafeParams(context),
  canUseTool: createMemoryFileCanUseTool(memoryPath),
  querySource: 'session_memory',
  forkLabel: 'session_memory',
  overrides: { readFileState: setupContext.readFileState },
})
```

函数说明：这段来自自动提炼 hook。`runForkedAgent()` 复用与父查询兼容的 prompt-cache 参数，但使用 `createSubagentContext()` 隔离可变工具状态。它收到的显式任务只有更新记忆文件，不会把提炼指令伪装成用户真实对话。

参数说明：`promptMessages` 这里只有一条 user message；`cacheSafeParams` 来自主 hook context；`canUseTool` 绑定 `createMemoryFileCanUseTool(memoryPath)`，把 fork 的工具权限收窄到下文所述的单文件编辑；`querySource` 固定为 `'session_memory'`，`forkLabel` 同样用于标识这类 fork；`overrides.readFileState` 复用刚刚真实读取文件后形成的状态。这个调用点省略 `maxTurns`、`maxOutputTokens`、`onMessage` 和 `skipTranscript`，它们沿 `runForkedAgent` 自身默认路径处理。

更关键的是权限函数：

```ts
export function createMemoryFileCanUseTool(
  memoryPath: string,
): CanUseToolFn {
  return async (tool: Tool, input: unknown) => {
    if (
      tool.name === FILE_EDIT_TOOL_NAME &&
      typeof input === 'object' &&
      input !== null &&
      'file_path' in input
    ) {
      const filePath = input.file_path
      if (typeof filePath === 'string' && filePath === memoryPath) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
    }
    return {
      behavior: 'deny' as const,
      message: `only ${FILE_EDIT_TOOL_NAME} on ${memoryPath} is allowed`,
      decisionReason: {
        type: 'other' as const,
        reason: `only ${FILE_EDIT_TOOL_NAME} on ${memoryPath} is allowed`,
      },
    }
  }
}
```

函数说明：这段是 `createMemoryFileCanUseTool()` 的完整函数。返回的权限函数只允许 `Edit` 操作精确相等的 `memoryPath`；读其他文件、运行 Bash、写另一个路径都会拒绝。

参数说明：外层 `memoryPath` 是当前 session 的绝对记忆文件路径。内层 `tool` 是工具对象；`input` 为 `unknown`，只有非 `null` 对象、包含字符串 `file_path` 且路径与目标完全相等时才进入 allow 分支。允许分支返回 `behavior: 'allow'` 和原 `updatedInput`；其余输入统一返回 `behavior: 'deny'`。拒绝结果中的 `message` 提供工具可见的错误文本，`decisionReason` 保存结构化诊断，其中 `reason` 复用同一条路径限制说明；返回值不会转入 `'ask'` 或弹窗扩大权限。

这条边界非常具体：提炼 agent 可以理解父会话上下文，工具能力则收窄为维护已经读过的 Markdown，无法借此继续执行父任务。

## 提炼完成后，两个游标记录“写到哪里”

fork 正常返回后，自动路径会记录本次上下文 token 数，供下一次 `+5k` 判断使用；如果最后一轮已经自然收尾，还会把最后一条消息 uuid 记为 `lastSummarizedMessageId`。

```ts
recordExtractionTokenCount(tokenCountWithEstimation(messages))
updateLastSummarizedMessageIdIfSafe(messages)
markExtractionCompleted()

function updateLastSummarizedMessageIdIfSafe(messages: Message[]): void {
  if (!hasToolCallsInLastAssistantTurn(messages)) {
    const lastMessage = messages[messages.length - 1]
    if (lastMessage?.uuid) {
      setLastSummarizedMessageId(lastMessage.uuid)
    }
  }
}
```

函数说明：`recordExtractionTokenCount()` 保存提炼时的上下文大小；`updateLastSummarizedMessageIdIfSafe()` 只在最后一轮已经自然收尾时推进压缩边界，避免未来压缩把 `tool_use` 与对应 `tool_result` 拆开；`markExtractionCompleted()` 清除“正在提炼”的时间戳。

参数说明：`messages` 是当前消息数组；空数组或最后一条缺少 `uuid` 时跳过边界更新。`setLastSummarizedMessageId()` 接受 `string | undefined`，这里传 string；该状态只保存在模块内存。`recordExtractionTokenCount()` 接受 number，默认初值为 0。

这些游标只记录“本轮提炼控制流已走完”。摘要正确性仍需回到 `summary.md` 与原始 transcript 核对；当前路径不会重新读取文件逐节验收模型产物。

## 压缩时，记忆文件怎样回到上下文

Session Memory 最重要的复用点在 compact。自动压缩和省略自定义 instructions 的 `/compact` 都会先调用 `trySessionMemoryCompaction()`；返回 `null` 才走传统 compact。

开关判断有明确优先级：

```ts
export function shouldUseSessionMemoryCompaction(): boolean {
  if (isEnvTruthy(process.env.ENABLE_CLAUDE_CODE_SM_COMPACT)) return true
  if (isEnvTruthy(process.env.DISABLE_CLAUDE_CODE_SM_COMPACT)) return false

  const sessionMemoryFlag = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_session_memory',
    false,
  )
  const smCompactFlag = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_sm_compact',
    false,
  )
  return sessionMemoryFlag && smCompactFlag
}
```

函数说明：`shouldUseSessionMemoryCompaction()` 先看环境变量强制开关，再要求两个缓存 feature flag 同时为 true。这里的 SM Compact 与“是否注册自动提炼 hook”相关但不相同：它有独立的 `tengu_sm_compact` gate。

参数说明：函数接受零个参数。`ENABLE_CLAUDE_CODE_SM_COMPACT` 为 truthy 时优先返回 true；它为假时才检查 `DISABLE...`，因此两者同时 truthy 时 enable 胜出。环境变量交给 `isEnvTruthy()` 解释，具体真值集合由该 helper 定义。feature flag 缺失时都以 false 回退。

进入 compact 后，代码最多等待正在进行的提炼 15 秒；若提炼时间戳已经超过 60 秒，则认为状态陈旧并直接继续。随后读取 `summary.md`。文件不存在、不可访问、内容仍等于空模板、边界 uuid 在当前消息中找不到、生成后的上下文仍超过自动压缩阈值，都会返回 `null`，让调用方回退到传统 compact。

成功路径同时保留 summary 和近期消息。它从摘要边界向后选择默认至少 10,000 token、至少 5 条包含文本块的消息，最多扩张到 40,000 token；同时回退索引，保持 `tool_use` / `tool_result` 成对，并保留共享同一 API message id 的 thinking 块。

```ts
const compactionResult = createCompactionResultFromSessionMemory(
  messages,
  sessionMemory,
  messagesToKeep,
  hookResults,
  transcriptPath,
  agentId,
)

const postCompactMessages = buildPostCompactMessages(compactionResult)
const postCompactTokenCount = estimateMessageTokens(postCompactMessages)

if (
  autoCompactThreshold !== undefined &&
  postCompactTokenCount >= autoCompactThreshold
) {
  return null
}
```

函数说明：这段来自 `trySessionMemoryCompaction()`。`createCompactionResultFromSessionMemory()` 生成 compact boundary、summary message、近期消息、附件和 SessionStart hook 结果；`buildPostCompactMessages()` 按真实顺序拼装，最后再估算压缩后的 token 数。

参数说明：`messages` 是待压缩消息；`sessionMemory` 是文件全文；`messagesToKeep` 是为近期连续性保留的消息；`hookResults` 来自 `processSessionStartHooks('compact', { model })`；`transcriptPath` 用于摘要提示中的恢复说明；`agentId` 为可选 `AgentId | undefined`。`autoCompactThreshold` 也是可选 number：`undefined` 表示手动 `/compact` 不做这项阈值拒绝；提供时，压缩后 token 数大于等于阈值就回退。

记忆文件本身也不能无限吞掉压缩后的窗口。`truncateSessionMemoryForCompact()` 以一级标题分节，每节按 `2,000 * 4` 个字符做粗略上限，在行边界截断并附加 `[..., section truncated ...]` 标记；摘要消息还会告诉模型完整文件路径。这里截断的是注入 compact 的副本，不会反向改写磁盘上的 `summary.md`。

SM Compact 复用持续维护的 summary，省去临近窗口上限时从头总结整段历史的步骤；同时保留近期原始消息与协议边界，让下一轮推理既看到长期状态，也看到刚发生的细节。

## 恢复会话时，文件还在，边界可能不在

同一个 session 恢复后，`getSessionMemoryPath()` 仍能定位原文件；但 `lastSummarizedMessageId` 是模块变量，默认值是 `undefined`。源码为这种不对称写了专门分支：

```ts
if (lastSummarizedMessageId) {
  lastSummarizedIndex = messages.findIndex(
    msg => msg.uuid === lastSummarizedMessageId,
  )
  if (lastSummarizedIndex === -1) return null
} else {
  lastSummarizedIndex = messages.length - 1
}

const startIndex = calculateMessagesToKeepIndex(
  messages,
  lastSummarizedIndex,
)
```

函数说明：正常运行时，uuid 给出“记忆已经覆盖到这里”的精确边界；恢复后 uuid 缺失，代码先把索引放到最后一条消息，再由 `calculateMessagesToKeepIndex()` 向前扩张，达到近期 token / 文本消息下限或最大上限。若 uuid 有值但当前消息数组零匹配，函数返回 `null`，把边界选择交回传统 compact。

参数说明：`lastSummarizedMessageId` 是 `string | undefined`；`findIndex()` 找不到返回 `-1`，这是显式失败值。`messages.length - 1` 在非空数组中指最后一条；空文件或空模板已在更早分支返回。`calculateMessagesToKeepIndex()` 的 `lastSummarizedIndex` 是 number，不接受 null。

恢复会保留可再次读取的长期文件，等 compact 或 away summary 需要时再消费。本章追踪到的普通主模型请求路径中，`getSessionMemoryContent()` 只出现在这些消费点，未见每轮无条件加入 system prompt 的调用证据。

另一个消费者 `generateAwaySummary()` 更直观：它读取 session memory 作为 broader context，只取最近 30 条消息，再调用小型快速模型生成 1 到 3 句回顾。文件读取失败、API 错误或用户取消都会返回 `null`，不会阻塞主会话恢复。

## 失败边界：记忆提供可恢复的辅助上下文

最后把几个容易误判的点收紧。

第一，远端配置只控制阈值：自动提炼读取缓存动态配置 `tengu_sm_config`，compact 读取 `tengu_sm_compact_config`；记忆正文仍由本地文件函数读写。

第二，automatic extraction 与 manual extraction 的异常清理路径不同。`manuallyExtractSessionMemory()` 有 `try/catch/finally`，能返回 `{ success: false, error }` 并在 finally 清除提炼状态。自动 hook 在当前还原源码中缺少同级 `finally`；如果文件准备或 fork 抛错，`extractionStartedAt` 可能保留，compact 的等待函数靠“15 秒超时”与“超过 60 秒视为 stale”避免永久卡住。这是静态源码揭示的潜在恢复路径，实际触发仍需运行证据。

第三，`summary.md` 是模型维护的派生信息。需要精确审计、完整回放或追责时，原始 transcript 仍是更接近事实的来源。

第四，custom prompt 与 custom template 给了用户很大自由，结构一致性也由用户负责。如果自定义 prompt 忘记保留标题、变量拼错或模板膨胀，系统会按普通文本继续处理；超长章节在 compact 注入时还可能被截断。

Session Memory 的价值恰好来自这些限制：它不试图成为全局知识库，而是把一段长会话里“接下来还需要什么”维护成一个范围明确、可查看、可编辑、失败后可回退的中间层。

## 小结

Claude Code 2.1.88 的 Session Memory 可以压成一条执行链：

1. `setup()` 在本地、非 bare、auto compact 开启时注册 post-sampling hook；
2. hook 只处理主 REPL，并受缓存 feature gate 控制；
3. token 增长是提炼硬条件，工具调用数或自然停顿决定触发时机；
4. 系统按 project 与 session 创建权限收紧的 `session-memory/summary.md`；
5. forked agent 继承会话上下文，但只允许 `Edit` 这一条精确路径；
6. 结构化模板滚动保存当前状态、任务、文件、错误、结果和工作日志；
7. SM Compact 把记忆、近期消息、SessionStart hooks 与 compact boundary 重新拼成下一段上下文；
8. 文件可随同一 session 恢复，进程内摘要边界却可能丢失，所以恢复路径更保守；
9. gate、空文件、错误边界或 token 预算不满足时，系统回退到传统 compact 或直接不生成回顾。

所以 Session Memory 是 Claude Code 在压缩旧上下文前维护的一份工作备忘录，后续 compact 与恢复机制可以再次消费它。

## 留给下一篇的问题

Session Memory 保存单会话长期信息以后，memdir 与 Team Memory 如何把记忆扩展到目录和团队范围，并控制共享与注入？

## 参考资料

- [Claude Code Memory](https://code.claude.com/docs/en/memory)

- [Claude Code Context Window](https://code.claude.com/docs/en/context-window)
