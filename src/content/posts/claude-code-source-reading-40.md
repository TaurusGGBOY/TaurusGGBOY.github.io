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

答案是：它没有把整段 transcript 再复制一份，也没有在每轮请求前查询一个远端“记忆数据库”。在 2.1.88 的还原源码里，Session Memory 是一份**按项目、按 session 隔离的本地 Markdown 投影**。主 REPL 每次采样结束后都会经过一个 hook；当 token 增长和工具调用达到阈值时，hook 启动隔离的 forked agent。这个 agent 只能用 `Edit` 修改当前 session 的 `session-memory/summary.md`，把会话里稳定、可复用的信息压进固定章节。

这份文件有两个明确消费者。上下文需要压缩时，实验性的 SM Compact 会用它替代一次新的摘要模型调用，再拼回近期消息、SessionStart hooks 和 compact boundary；用户离开后回来时，`awaySummary` 也会把它作为较宽的背景，配合最近 30 条消息生成一段很短的回顾。恢复同一个 session 时，文件路径仍然可定位，但模块内的“摘要到哪条消息”为进程内状态，可能已经丢失，因此恢复分支会采取更保守的消息保留策略。

所以更准确的模型是：

> transcript 是原始事实流，`summary.md` 是可编辑的长期工作状态，compaction 是把这份状态重新注入会话的时机。

它们相互配合，但谁也不是谁的替代品。

## Session Memory 不是“全局记忆”

先看完整链路。

![Claude Code Session Memory 的提炼、保存与压缩复用链路](/images/posts/claude-code-source-reading-40/40-session-memory-handdrawn.png)

图里最需要注意的是两条边界。

第一，`summary.md` 属于当前 session。路径由当前项目目录和 `sessionId` 共同决定，不是所有项目共享一份文件。第二，记忆文件会落盘，`lastSummarizedMessageId`、上次提取时的 token 数等游标却只存在模块状态里。进程重启后，前者还在，后者不一定还在。

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

参数说明：两个函数都没有显式参数，输入来自运行时的 `getCwd()` 与 `getSessionId()`。；返回目录带尾部分隔符，文件路径不带。它们没有把记忆写入网络，也没有跨 session 搜索。

。目录级与团队级记忆是下一篇的 `memdir` / Team Memory 问题。

## 启动时只注册 hook，不立刻生成记忆

Session Memory 在 `setup()` 后段初始化。它不是一次阻塞式启动任务，而是先注册一个采样后的回调，等主循环真的产生消息后再判断是否需要工作。

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

参数说明：函数没有参数和返回值。`getIsRemoteMode() === true` 时直接退出；`isAutoCompactEnabled() === false` 时也不注册。只有本地、且 auto compact 开启时才进入后续 hook。`autoCompactEnabled` 是布尔值，没有第三种状态。

注册 hook 仍不等于功能必定运行。真正执行时还要过三道门：只接受 `querySource === 'repl_main_thread'`，读取缓存中的 `tengu_session_memory` feature gate，并懒加载远端动态阈值配置。

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

函数说明：`extractSessionMemory` 是 post-sampling hook，也是自动提炼的主入口。外层 `sequential()` 会把多次触发串行化，避免两个提炼任务同时编辑同一份文件。上面省略了已经在后文展开的执行分支，不是另写的伪代码。

参数说明：`context` 是 `REPLHookContext`，本文用到 `messages`、`toolUseContext` 与 `querySource`。`querySource` 必须精确等于 `'repl_main_thread'`；subagent、teammate 等其他来源都会跳过。

这也解释了为什么“安装了 2.1.88”不等于“一定能在磁盘上看到 session memory”。远端模式、bare mode、关闭 auto compact、缓存 gate 为 false，任何一个条件都足以让自动提炼不发生。

## 什么时候值得提炼：token 是硬条件

默认阈值定义在 `sessionMemoryUtils.ts`：首次要到 10,000 个上下文 token；两次更新之间至少再增长 5,000；工具调用阈值为 3。

```ts
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000,
  minimumTokensBetweenUpdate: 5000,
  toolCallsBetweenUpdates: 3,
}
```

函数说明：这不是函数，而是自动提炼的默认配置对象。远端动态配置 `tengu_sm_config` 可以覆盖三个字段，但 `initSessionMemoryConfigIfNeeded()` 只接受显式提供的正数；`0`、负数、`undefined` 都回退到这里的默认值。

参数说明：三个字段都是 number。`minimumMessageTokensToInit` 是首次初始化门槛；`minimumTokensBetweenUpdate` 衡量自上次提炼后的上下文增长，而不是累计 API 用量；`toolCallsBetweenUpdates` 是两次更新之间的 `tool_use` 数量。源码没有设置整数校验，只检查 `> 0`，真实远端取值由运行时配置源返回，本文不逐一枚举。

阈值组合不是简单的“满足任意一项就提炼”。token 增长始终是硬条件，工具数与自然停顿只决定在满足 token 后是否适合现在动手。

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

函数说明：这段来自 `shouldExtractMemory()`。首次调用还会先检查 `minimumMessageTokensToInit`，达到后把 `sessionMemoryInitialized` 置为 true。之后必须满足 `hasMetTokenThreshold`，再满足“工具数够多”或“最后一轮 assistant 没有工具调用”之一。

参数说明：`messages` 是当前 `Message[]`；`currentTokenCount` 来自 `tokenCountWithEstimation(messages)`。`lastMemoryMessageUuid` 为 `string | undefined`，没有游标时从消息数组开头统计。`hasToolCallsInLastTurn` 是布尔值：false 在这里代表自然对话断点，不代表整段会话从未调用工具。

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

默认模板不是一段自由摘要，而是十个一级标题：`Session Title`、`Current State`、`Task specification`、`Files and Functions`、`Workflow`、`Errors & Corrections`、`Codebase and System Documentation`、`Learnings`、`Key results`、`Worklog`。每个标题后还有一行斜体说明，告诉提炼 agent 什么内容应该放进这一节。

为什么要固定结构？因为“总结一下刚才做了什么”很容易只留下结果，丢掉下一步、失败方案和用户纠正。结构化 Markdown 把这些信息拆开，后续更新可以替换某一节，而不是每次重写一篇越来越长的散文。

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

函数说明：`loadSessionMemoryTemplate()` 和 `loadSessionMemoryPrompt()` 位于 `restored-src/src/services/SessionMemory/prompts.ts`。对应文件不存在（`ENOENT`）时分别回退到内置模板和内置更新提示词；其他读取错误会记录后同样回退，而不是阻断主会话。

参数说明：两个 loader 都没有调用参数。自定义 prompt 支持 `{{currentNotes}}` 与 `{{notesPath}}` 变量；替换逻辑是单遍匹配 `{{word}}`。已知变量替换为字符串，未知变量保持原样。源码没有为模板提供 schema 校验，因此自定义模板能否与自定义 prompt 正确配合，是用户侧约束。

## 更新不是主 agent 顺手写，而是一个受限 fork

拿到旧文件后，`buildSessionMemoryUpdatePrompt()` 会把 `currentNotes` 和 `notesPath` 填进更新提示词。默认提示词要求保留全部标题与斜体说明，只编辑说明行下方的实际内容；没有新信息的章节可以不动。

提示词还会计算每节和全文的粗略 token 数。单节超过约 2,000 token 会追加压缩提醒；全文超过约 12,000 token，会要求优先保住 `Current State` 与 `Errors & Corrections`，同时淘汰较旧、较次要的信息。这是滚动维护，不是无限追加。

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

参数说明：`promptMessages` 这里只有一条 user message；`cacheSafeParams` 来自主 hook context；`querySource` 固定为 `'session_memory'`，`forkLabel` 同样用于标识这类 fork；`overrides.readFileState` 复用刚刚真实读取文件后形成的状态。`runForkedAgent` 还支持其他可选参数，但这里没有传 `maxTurns`、`maxOutputTokens`、`onMessage` 或 `skipTranscript`，不能臆测它们的运行值。

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

参数说明：外层 `memoryPath` 是当前 session 的绝对记忆文件路径。内层 `tool` 是工具对象；`input` 为 `unknown`，必须是非 null 对象、含 `file_path`，并且路径是字符串且与目标完全相等，源码原实现才允许。允许分支返回 `behavior: 'allow'` 和原 `updatedInput`；其余输入返回 `behavior: 'deny'`。这里没有 `'ask'` 分支，也不会弹出用户确认来扩大权限。

这条边界非常具体：提炼 agent 可以理解父会话上下文，却不能借此获得父 agent 的完整工具能力。它被设计成“维护一份已经读过的 Markdown”，而不是后台继续执行用户任务。

## 提炼完成后，两个游标记录“写到哪里”

fork 正常返回后，自动路径会记录本次上下文 token 数，供下一次 `+5k` 判断使用；如果最后一轮没有工具调用，还会把最后一条消息 uuid 记为 `lastSummarizedMessageId`。

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

函数说明：`recordExtractionTokenCount()` 保存提炼时的上下文大小；`updateLastSummarizedMessageIdIfSafe()` 只在最后一轮没有 `tool_use` 时推进压缩边界，避免未来压缩把 `tool_use` 与对应 `tool_result` 拆开；`markExtractionCompleted()` 清除“正在提炼”的时间戳。

参数说明：`messages` 是当前消息数组；空数组或最后一条没有 `uuid` 时不会设置边界。`setLastSummarizedMessageId()` 接受 `string | undefined`，这里传 string；该状态没有写入 `summary.md`。`recordExtractionTokenCount()` 接受 number，默认初值为 0。

注意，这些游标表示“代码认为本轮提炼已走完”，不构成摘要正确性的证明。源码没有在这里重新读取文件并检查每一节是否真的更新，也无法从静态调用关系证明模型抽取的事实没有遗漏。

## 压缩时，记忆文件怎样回到上下文

Session Memory 最重要的复用点在 compact。自动压缩和没有自定义 instructions 的 `/compact` 都会先调用 `trySessionMemoryCompaction()`；返回 `null` 才走传统 compact。

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

参数说明：函数没有参数。`ENABLE_CLAUDE_CODE_SM_COMPACT` 为 truthy 时优先返回 true；只有它不为 truthy 才检查 `DISABLE...`，因此两者同时 truthy 时 enable 胜出。环境变量交给 `isEnvTruthy()` 解释，不是源码中的固定字符串枚举。feature flag 缺失时都以 false 回退。

进入 compact 后，代码最多等待正在进行的提炼 15 秒；若提炼时间戳已经超过 60 秒，则认为状态陈旧并直接继续。随后读取 `summary.md`。文件不存在、不可访问、内容仍等于空模板、边界 uuid 在当前消息中找不到、生成后的上下文仍超过自动压缩阈值，都会返回 `null`，让调用方回退到传统 compact。

成功路径不是只保留一份 summary。它还会从摘要边界向后选择近期消息，默认至少保留 10,000 token、至少 5 条包含文本块的消息，最多扩张到 40,000 token；同时回退索引，确保不拆开 `tool_use` / `tool_result`，也不丢失共享同一 API message id 的 thinking 块。

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

也就是说，SM Compact 省掉的是“临近窗口上限时再让一个模型从头总结整段历史”这一步，不是简单把所有旧消息替换成一个文件。它仍保留近期原始消息与协议边界，让下一轮推理既看到长期状态，也看到刚发生的细节。

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

函数说明：正常运行时，uuid 给出“记忆已经覆盖到这里”的精确边界；恢复后没有 uuid，代码先把索引放到最后一条消息，再由 `calculateMessagesToKeepIndex()` 向前扩张，达到近期 token / 文本消息下限或最大上限。若有 uuid 但当前消息数组找不到它，函数直接返回 `null`，不会猜测边界。

参数说明：`lastSummarizedMessageId` 是 `string | undefined`；`findIndex()` 找不到返回 `-1`，这是显式失败值。`messages.length - 1` 在非空数组中指最后一条；空文件或空模板已在更早分支返回。`calculateMessagesToKeepIndex()` 的 `lastSummarizedIndex` 是 number，不接受 null。

因此恢复不是“重新把 summary 当 system prompt 永久挂上”。更准确地说，恢复保留了可再次读取的长期文件；等 compact 或 away summary 需要它时才消费。尤其在主模型的普通每一轮请求中，本章所追踪的源码没有显示 `getSessionMemoryContent()` 被无条件加入 system prompt。

另一个消费者 `generateAwaySummary()` 更直观：它读取 session memory 作为 broader context，只取最近 30 条消息，再调用小型快速模型生成 1 到 3 句回顾。文件读取失败、API 错误或用户取消都会返回 `null`，不会阻塞主会话恢复。

## 失败边界：记忆是优化，不是事实来源

最后把几个容易误判的点收紧。

第一，远端配置只控制阈值，不是把记忆正文保存到远端。自动提炼读取的是缓存动态配置 `tengu_sm_config`，compact 读取的是 `tengu_sm_compact_config`；正文仍由本地文件函数读写。

第二，automatic extraction 与 manual extraction 的异常清理并不完全相同。`manuallyExtractSessionMemory()` 有 `try/catch/finally`，能返回 `{ success: false, error }` 并在 finally 清除提炼状态。自动 hook 在当前还原源码中没有同样的 `finally`；如果文件准备或 fork 抛错，`extractionStartedAt` 可能保留，compact 的等待函数靠“15 秒超时”与“超过 60 秒视为 stale”避免永久卡住。这是源码可见的恢复边界，不代表生产中一定会发生该故障。

第三，`summary.md` 是模型维护的派生信息。需要精确审计、完整回放或追责时，原始 transcript 仍是更接近事实的来源。

第四，custom prompt 与 custom template 给了用户很大自由，但源码没有检查二者的结构一致性。如果自定义 prompt 忘记保留标题、变量拼错或模板膨胀，系统只能按普通文本继续处理；超长章节在 compact 注入时还可能被截断。

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

所以它不是“Claude 永远记住了”，而是 Claude Code 在丢弃旧上下文前，先维护了一份可被后续机制重新消费的工作备忘录。

## 留给下一篇的问题

Session Memory 保存单会话长期信息以后，memdir 与 Team Memory 如何把记忆扩展到目录和团队范围，并控制共享与注入？

