---
title: "Claude Code源码解读20：如何恢复、续接与分叉对话"
published: 2026-07-24T16:47:07+08:00
updated: 2026-07-24T16:47:07+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-20/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：Anthropic 提到 Fable 5 遇到一些问题时可以降级到 Opus 4.8 执行；根据 2.1.88 的源码，这种 fallback 是如何实现的？

先把两个容易混在一起的 fallback 分开。Anthropic 对 Fable 5 描述的是安全分类器触发后的模型切换：分类器可以把请求标记为 `refusal`，再在同一会话用 Opus 4.8 重新执行。公开的 Cookbook 给出的服务端接口是 `fallbacks`，客户端方案则是 SDK 的 refusal-fallback middleware。这条路径发生在 API 或 SDK 层，响应仍可能是 HTTP 200，依据的是 `stop_reason`，不是 Claude Code 的 HTTP 重试错误。

而本仓库从 `@anthropic-ai/claude-code@2.1.88` 还原的代码，提供的是一个更通用的 `fallbackModel?: string` 通道。源码中没有 `claude-fable-5`、`claude-opus-4-8`、`stop_details` 或 `fallback_credit_token` 这些 Fable 专用字面量；`getErrorMessageIfRefusal()` 只把 `stop_reason === 'refusal'` 转成错误消息，并建议用户手动切换模型。因此，静态源码能确认的是：如果上层把 `claude-opus-4-8` 作为 `fallbackModel` 注入，客户端怎样在过载时切换；Fable 的安全分类器何时触发，以及 fallback credit 如何计费，则不是这份客户端源码实现的。

### fallbackModel 是怎样进入请求的

入口是 CLI 的 `--fallback-model <model>`。帮助文本明确写着它只对 `--print` 生效。这个参数是开放字符串，不是固定枚举；启动阶段只额外检查它不能和主模型相同，`default` 则被解析成当前默认主模型：

```ts
const userSpecifiedFallbackModel =
  fallbackModel === 'default' ? getDefaultMainLoopModel() : fallbackModel

// QueryEngineConfig
fallbackModel: userSpecifiedFallbackModel
```

随后值沿 `QueryEngineConfig.fallbackModel` → `QueryParams.fallbackModel` → `queryModel()` 的 `Options.fallbackModel` 传递。`Options` 中这个字段是 `string | undefined`：省略时根本不会触发模型切换，传入任意字符串则由 provider 负责解释为模型 ID。也就是说，客户端并不会根据“Fable 5”这个名称自行推导 Opus 4.8；备用模型是谁，取决于调用入口注入的字符串和运行时 provider 配置。

### 触发点在 withRetry，而不是分类器

真正决定是否发出 fallback 信号的是 `restored-src/src/services/api/withRetry.ts` 的 `withRetry()`。源码先把连续 529（`overloaded`）计数，阈值是 `MAX_529_RETRIES = 3`：

```ts
if (
  is529Error(error) &&
  (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
    (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
) {
  consecutive529Errors++
  if (consecutive529Errors >= MAX_529_RETRIES && options.fallbackModel) {
    throw new FallbackTriggeredError(
      options.model,
      options.fallbackModel,
    )
  }
}
```

这里有三个很重要的限制。

第一，触发条件是 HTTP 529 过载，不是 Fable 分类器返回的 `refusal`。第二，后台 query source 会在计数前通过 `shouldRetry529()` 直接放弃，只有前台会话、SDK、Agent、compact、Hook 等列出的 source 才会重试。第三，如果没有设置 `FALLBACK_FOR_ALL_PRIMARY_MODELS`，源码里的 `isNonCustomOpusModel()` 只把内置 Opus 4.0、4.1、4.5、4.6 视为可走这条分支；这份 2.1.88 还原代码并没有把 Fable 5 或 Opus 4.8 注册进这个列表。要让新模型也进入同一条过载 fallback 路径，必须由运行时 feature/env 或更新后的模型配置放宽条件。

`FallbackTriggeredError` 不是最终给用户看的错误，而是一个控制流信号。`queryModelWithStreaming()` 捕获它时会原样重新抛出，避免把“应该换模型再试”误变成普通 assistant error。流式请求如果先转为非流式请求，`executeNonStreamingRequest()` 仍然携带同一个 `fallbackModel`；如果最初的流请求就是 529，还会以 `initialConsecutive529Errors: 1` 预置计数，保证流式和非流式合计三次后触发，而不是各自重新数三次。

### queryLoop 才真正执行“换模型再跑一遍”

`restored-src/src/query.ts` 的 `queryLoop()` 是切换发生的地方。它先把当前模型放在局部变量 `currentModel`，每轮把它和 `fallbackModel` 一起交给 `deps.callModel()`；收到 `FallbackTriggeredError` 后，执行下面这组动作：

```ts
if (innerError instanceof FallbackTriggeredError && fallbackModel) {
  currentModel = fallbackModel
  attemptWithFallback = true

  yield* yieldMissingToolResultBlocks(
    assistantMessages,
    'Model fallback triggered',
  )
  assistantMessages.length = 0
  toolResults.length = 0
  toolUseBlocks.length = 0
  if (streamingToolExecutor) {
    streamingToolExecutor.discard()
    streamingToolExecutor = new StreamingToolExecutor(
      toolUseContext.options.tools,
      canUseTool,
      toolUseContext,
    )
  }
  toolUseContext.options.mainLoopModel = fallbackModel
  continue
}
```

这不是把已经生成的 assistant 消息的 `model` 字段改名，而是让 `while (attemptWithFallback)` 重新进入 API 调用。新的请求仍使用同一份 `messagesForQuery`、system prompt 和工具定义，只把 `model` 改成 fallback model。已经产生的半截流式消息会被清理；缺失的 tool result 会先补成协议上可配对的结果，避免下一次请求看到悬空的 `tool_use`。如果是 Anthropic 内部用户，代码还会调用 `stripSignatureBlocks()`，因为 thinking signature 绑定原模型，直接把 Fable 的受保护 thinking block 重放给 Opus 可能得到 400。

切换成功后，代码向 UI 发送一条 warning，内容类似“由于主模型需求过高，已切换到备用模型”。如果备用模型再次失败，就走普通的 `CannotRetryError`/assistant error 路径；源码没有把外部工具已经造成的副作用回滚，也不会重放已完成的工具调用。因而这是一种“清理当前请求状态、用新模型重新请求”的降级，不是事务回滚。

把两套机制放在一起看，结论就清楚了：Anthropic 的 Fable 5 → Opus 4.8 安全 fallback 更像“服务端分类器决定重试目标”；Claude Code 这份源码里的 fallback 更像“客户端为请求准备备用模型，在连续 529 后通过异常信号跳出重试层，再由 queryLoop 重建一次干净请求”。如果未来版本把 Fable 的分类器响应也接入客户端，最自然的接入点会是 `getErrorMessageIfRefusal()` 或 `queryModelWithStreaming()` 的响应处理处；当前还原代码尚未这样做。

本文后续仍以 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的源码块只保留证明当前结论所需的部分，省略日志、遥测和无关 provider 分支；还原路径只用于定位本文引用的源码。

## 问题现场

恢复旧会话时，用户期待的是“从中断处继续”，程序手里却只有一份不断追加的 JSONL 文件。文件需要容纳并行工具结果、压缩边界、标题和工作区元数据；加载时还必须判断哪条父链才是当前分支。

![JSONL transcript 如何沿父链重放会话](/images/posts/claude-code-source-reading-20/20-transcript-replay-detail-handdrawn.png)

本文把 transcript 当作事件账本，而不是进程快照：写入端维护 UUID 父链，读取端重建叶子分支，resume 与 fork 再分别决定是否沿用 session ID。

## 会话历史是一份可重建的事件日志

恢复路径有两个独立阶段：写入端把事件追加进 transcript，读取端先找叶子，再沿 `parentUuid` 重建分支，最后把权限、工作目录和未完成工具重新挂回当前进程。

![Claude Code 会话写入、恢复与分叉流程](/images/posts/claude-code-source-reading-20/20-session-history-resume-handdrawn.png)

## YNM-9527 怎样分出另一条会话

用户在当前事故会话里输入：

> /branch integer-cents

随后继续说明：

> 在这个会话分支里比较“全链路使用整数分”和“保留 Decimal”两种方案，不要覆盖原会话。

Claude Code 会复制可恢复的消息主链，生成新的 session ID 和 transcript 关系；原会话保留，新的分支从同一段调查历史继续。真正的文件副作用仍在工作区里，所以剧本同时要求独立 worktree。后续 /resume 恢复的是会话状态，不是把已经发出的网络请求重新执行一遍。

下面从这次可见的分支动作进入 JSONL、parentUuid、resume 和 fork。

### 四个概念怎样组成恢复坐标

`session ID` 决定追加到哪个文件；普通 resume 复用旧 ID，fork 则必须换成 fresh ID。transcript 是一行一个 JSON 对象的追加账本，消息和元数据可以以新 entry 表达。数组顺序只能表示写入先后，`uuid/parentUuid` 才能在同一文件里区分多个叶子；恢复时从目标叶子回溯到根，得到当前分支。

第四个概念是 **fork**。fork 复制可恢复的对话状态，新会话继承旧消息；旧对话已经产生的文件副作用继续保留，Git 工作区也沿用原现场。`--fork-session`、`/branch` 与后文第 26 篇会讲到的 Git worktree，分别隔离会话 ID、消息来源和文件目录。

把 `branch` 和 `fork` 放在同一张表里看，先记住一句话：**它们都创建新的会话历史，区别主要是用户入口和创建时机；它们都不是 Git 工作区隔离。**

| 维度 | `branch` | `fork` |
| --- | --- | --- |
| 在本章指什么 | 交互式 REPL 中执行 `/branch [name]` | “复制会话并获得新 session ID”的通用机制；命令行用 `--fork-session`，SDK 用 `forkSession` |
| 典型场景 | 已经在会话里，想从当前对话点试另一种实现 | 启动另一个进程、终端或程序化任务，从旧会话派生独立上下文 |
| 2.1.88 的落盘路径 | `createFork()` 立刻复制主链 JSONL，并为记录写入 `forkedFrom` | 恢复流程读取旧历史，但保留 fresh session ID；后续消息写入新 transcript |
| 原会话 | 保持不变，可用 `/resume` 回去 | 同样保持不变，可独立恢复 |
| 文件和外部副作用 | 不复制、不回滚当前工作区或已经执行的工具 | 一样不复制、不回滚；需要 Git worktree、checkpoint 或其他隔离机制 |

为什么要这样实现？因为会话可能很长，写入又很频繁。追加日志把每次写入限制在尾部；UUID 链允许从同一份日志里选择一条有效分支；元数据记录让恢复逻辑按需重建状态，而不必序列化整个运行时对象图。

## session ID 与 transcript 路径必须一起切换

当前 transcript 的路径由项目目录和 session ID 共同确定：

```ts
export function getTranscriptPath(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${getSessionId()}.jsonl`)
}

export function getTranscriptPathForSession(sessionId: string): string {
  if (sessionId === getSessionId()) {
    return getTranscriptPath()
  }
  const projectDir = getProjectDir(getOriginalCwd())
  return join(projectDir, `${sessionId}.jsonl`)
}
```

函数说明：`getTranscriptPath()` 与 `getTranscriptPathForSession()` 位于 `restored-src/src/utils/sessionStorage.ts`。前者计算当前会话文件；后者为指定 session ID 计算路径，但只有指定 ID 等于当前 ID 时，才能使用已经恢复的 `sessionProjectDir`。

参数说明：`getTranscriptPath()` 是空参函数。`getTranscriptPathForSession(sessionId)` 的 `sessionId` 是开放字符串，调用方通常传 UUID；函数本身不在这里校验格式。`getSessionProjectDir()` 返回 `string | null`：字符串使当前会话沿用恢复文件所在目录，`null` 触发由 `originalCwd` 派生项目目录的回退。查询其他 session ID 时，源码按当前项目目录计算；已知跨项目文件的调用方应直接携带完整路径。

真正恢复时，ID 和目录通过 `switchSession()` 原子切换：

```ts
export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  sessionSwitched.emit(sessionId)
}
```

函数说明：`switchSession()` 位于 `restored-src/src/bootstrap/state.ts`。它先清理旧 session 的 plan slug 缓存，再同时更新 ID 与 transcript 所在目录，最后通知监听者 session 已切换。

参数说明：`sessionId` 是经过项目类型约束的 `SessionId`。`projectDir` 是 `string | null`，默认 `null`；传字符串表示 `<sessionId>.jsonl` 所在目录，常用于跨项目或 worktree 恢复，传 `null` 或省略则让后续路径从当前 `originalCwd` 推导。可选参数省略后直接采用默认值 `null`，不会形成另一条路径。

这段设计解决了一个很实际的问题：如果只换 session ID、仍沿用旧 projectDir，程序可能成功加载 A 目录的历史，却把下一条消息写到 B 目录下同名的 JSONL。resume 必须同时恢复内存消息与后续持久化目标。

## 写入：先去重，再为消息补齐父链

transcript 只收录持久化协议定义的消息与元数据。`isTranscriptMessage()` 给出了消息边界：

```ts
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}

export function isChainParticipant(m: Pick<Message, 'type'>): boolean {
  return m.type !== 'progress'
}
```

函数说明：这两个函数位于 `restored-src/src/utils/sessionStorage.ts`。`isTranscriptMessage()` 是读取端判断“哪类记录属于对话消息”的类型守卫；`isChainParticipant()` 决定写入端哪些消息能够成为后继消息的父节点。

参数说明：`entry.type` 可被这里接受的值只有 `'user' | 'assistant' | 'attachment' | 'system'`。`progress` 明确不属于 transcript message，也不参与 `parentUuid` 链，因为它是可替换的临时 UI 状态。`isChainParticipant()` 对当前 `Message` 联合类型采用“除了 progress 都参与”的规则；这不意味着任何任意字符串都会通过，因为参数已经由 `Message` 类型约束。

上层的 `recordTranscript()` 还会先去掉已经写过的 UUID：

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
      newMessages, false, undefined, startingParentUuid, teamInfo,
    )
  }
  const lastRecorded = newMessages.findLast(isChainParticipant)
  return (lastRecorded?.uuid as UUID | undefined) ?? startingParentUuid ?? null
}
```

函数说明：`recordTranscript()` 位于 `restored-src/src/utils/sessionStorage.ts`。它清理消息、读取当前 session 已存在的 UUID 集合，只把新消息交给 `insertMessageChain()`，并返回最后一个实际参与父链的 UUID。

参数说明：`messages` 是本次候选消息数组；提供 `teamInfo` 时，新记录会携带可选的 `teamName`、`agentName`，省略时跳过团队元数据。`startingParentUuidHint` 为增量写入提供起始父节点；省略后，循环从候选消息中寻找最后一个已落盘的链参与者。`allMessages` 只在清理逻辑需要完整上下文时提供，省略时清理范围限于当前候选批次。调用 `insertMessageChain()` 时第二个参数固定为 `false`，表示主对话；第三个参数省略 Agent ID，使记录归入主链。函数找不到任何链参与者时返回 `null`，调用方据此从链根开始。

去重用于保护父链结构。resume 或 compaction 后，内存消息数组常常同时包含已落盘前缀与新消息。旧 UUID 再写一次会覆盖加载端的 Map；父指针从错误的旧消息起算，则可能生成孤链。

`insertMessageChain()` 才真正给消息补齐持久化字段：

```ts
async insertMessageChain(
  messages: Transcript,
  isSidechain: boolean = false,
  agentId?: string,
  startingParentUuid?: UUID | null,
  teamInfo?: { teamName?: string; agentName?: string },
) {
  return this.trackWrite(async () => {
    let parentUuid: UUID | null = startingParentUuid ?? null
    // ... materialize session file, read git branch and plan slug
    const sessionId = getSessionId()

    for (const message of messages) {
      const isCompactBoundary = isCompactBoundaryMessage(message)
      let effectiveParentUuid = parentUuid
      if (
        message.type === 'user' &&
        'sourceToolAssistantUUID' in message &&
        message.sourceToolAssistantUUID
      ) {
        effectiveParentUuid = message.sourceToolAssistantUUID
      }

      const transcriptMessage: TranscriptMessage = {
        parentUuid: isCompactBoundary ? null : effectiveParentUuid,
        logicalParentUuid: isCompactBoundary ? parentUuid : undefined,
        isSidechain,
        teamName: teamInfo?.teamName,
        agentName: teamInfo?.agentName,
        promptId:
          message.type === 'user' ? (getPromptId() ?? undefined) : undefined,
        agentId,
        ...message,
        userType: getUserType(),
        entrypoint: getEntrypoint(),
        cwd: getCwd(),
        sessionId,
        version: VERSION,
        gitBranch,
        slug,
      }
      await this.appendEntry(transcriptMessage)
      if (isChainParticipant(message)) {
        parentUuid = message.uuid
      }
    }
    // ... cache the latest meaningful user prompt
  })
}
```

函数说明：`Project.insertMessageChain()` 位于 `restored-src/src/utils/sessionStorage.ts`。它按顺序生成 `parentUuid`，附加 session、cwd、版本等字段，再逐条交给 `appendEntry()`。示例省略了 git branch、plan slug、用户类型、入口来源和 team 字段。

参数说明：`isSidechain` 默认 `false`；`agentId` 可为 `undefined`，只有 Agent sidechain 才通常提供；`startingParentUuid` 可为 UUID、`null` 或 `undefined`，后两者都回退为链根 `null`；`teamInfo` 可省略。普通消息以前一条链参与者为父；user 类型的 `tool_result` 若带 `sourceToolAssistantUUID`，会改为指向产生对应 `tool_use` 的 assistant 消息。compact boundary 会把物理 `parentUuid` 设为 `null`，同时在完整源码中用 `logicalParentUuid` 保留逻辑来源。

字段说明：输入 `messages` 是待写 transcript；循环中的 `message` 是当前记录，`isCompactBoundary` 决定是否切断物理链，`effectiveParentUuid` 默认取 `parentUuid`，遇到 `sourceToolAssistantUUID` 时改指对应 assistant。输出对象的 `teamName`、`agentName` 来自 `teamInfo`，`promptId` 只写入 user 消息；`userType`、`entrypoint`、`cwd`、`sessionId`、`version`、`gitBranch`、`slug` 保存当前运行环境，`agentId` 与 `isSidechain` 标识分支归属。`appendEntry()` 写入后，链参与者的 `uuid` 成为下一条记录的 `parentUuid`。

注意字段覆盖顺序：源码把 `sessionId`、`cwd` 等当前会话字段放在 `...message` 之后。这样 fork 或 resume 带来的旧 `SerializedMessage` 即使仍保存来源 session ID，也会在写入新文件前被重新盖成当前 ID。

## 落盘：JSONL 采用追加账本

真正的文件写入先经过按路径隔离的队列：

```ts
private FLUSH_INTERVAL_MS = 100

private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
  return new Promise<void>(resolve => {
    let queue = this.writeQueues.get(filePath)
    if (!queue) {
      queue = []
      this.writeQueues.set(filePath, queue)
    }
    queue.push({ entry, resolve })
    this.scheduleDrain()
  })
}

private async appendToFile(filePath: string, data: string): Promise<void> {
  try {
    await fsAppendFile(filePath, data, { mode: 0o600 })
  } catch {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    await fsAppendFile(filePath, data, { mode: 0o600 })
  }
}
```

函数说明：`enqueueWrite()`、`scheduleDrain()` 与 `appendToFile()` 都属于 `sessionStorage.ts` 中的 `Project`。默认情况下，同一路径的记录先排队，100 毫秒后批量序列化为“一条 JSON 加一个换行”，再追加到文件；远程持久化路径可以把间隔调得更短。

参数说明：`filePath` 是已经解析出的具体路径；`entry` 是消息或元数据联合类型；`data` 是批量生成的 JSONL 字符串。`FLUSH_INTERVAL_MS` 默认 `100`，运行时仍可覆盖。文件模式为 `0o600`，目录缺失时以 `recursive: true` 和 `0o700` 创建。`appendToFile()` 的 catch 会统一尝试建目录后再写；第二次失败仍会向上传播。

`shouldSkipPersistence()` 会在测试环境、`cleanupPeriodDays === 0`、`--no-session-persistence` 对应状态，或 `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 为真时跳过写入。新 session 会先缓冲 attachment 或 Hook 记录，直到出现第一条 user/assistant 消息才 materialize 文件。

正常退出会调用 flush/cleanup；强制终止的耐久性仍需文件系统与故障注入测试。

## 一份 JSONL 里不只有消息

`TranscriptMessage` 在普通消息之上补了一层持久化坐标：

```ts
export type TranscriptMessage = SerializedMessage & {
  parentUuid: UUID | null
  logicalParentUuid?: UUID | null
  isSidechain: boolean
  gitBranch?: string
  agentId?: string
  teamName?: string
  agentName?: string
  agentColor?: string
  promptId?: string
}
```

类型说明：`TranscriptMessage` 定义在 `restored-src/src/types/logs.ts`。它继承的 `SerializedMessage` 已包含 `cwd`、`sessionId`、`timestamp`、`version`，以及可选的 `entrypoint`、`gitBranch`、`slug`。

字段说明：`parentUuid` 必须是 UUID 或 `null`；`logicalParentUuid` 可为 UUID、`null` 或 `undefined`，只在物理链因压缩边界断开时表达逻辑父节点；`isSidechain` 是必填布尔值。其余字段都可为 `undefined`：`gitBranch` 记录写入时分支，`agentId` 区分 Agent sidechain，`teamName`、`agentName`、`agentColor` 保存团队与展示状态，`promptId` 关联 user prompt 与遥测。

同一文件还可以出现 summary、custom-title、tag、mode、worktree-state、file-history-snapshot、attribution-snapshot、content-replacement、context-collapse 等非消息 entry。它们不都进入模型上下文，却可能影响恢复后的 UI、权限模式、文件回滚或工具结果裁剪。

这也是 JSONL 优于单一消息数组的地方：运行时可以追加一条“标题改了”或“worktree 已退出”，读取时采用 last-wins 或按 message ID 聚合，而不需要原地修改旧行。但代价也很明确：加载器必须区分 entry 类型、兼容旧格式、处理多叶分支与断链。

## 读取：先找叶子，再沿 parentUuid 回到根

`loadTranscriptFile()` 先把 JSONL 拆成消息 Map 与多类元数据 Map：

```ts
export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean },
): Promise<{
  messages: Map<UUID, TranscriptMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  leafUuids: Set<UUID>
  // ... 其他元数据 Map
}> {
  // ... 读取、解析、兼容旧 progress 链与 compact 边界
}
```

函数说明：`loadTranscriptFile()` 位于 `restored-src/src/utils/sessionStorage.ts`。它加载消息、摘要、标题、tag、Agent 设置、mode、worktree、PR 关联、文件历史、内容替换和 context-collapse 状态，并预先计算可作为恢复锚点的叶子 UUID。

参数说明：`filePath` 是 `.jsonl` 的完整路径；`opts` 可为 `undefined`。`keepAllLeaves` 可为 `true | false | undefined`：只有 `true` 才要求保留所有叶分支，`false` 或省略允许大文件读取路径在安全条件下提前裁掉死分支。`contextCollapseSnapshot` 可以是 `undefined`，因为会话未必启用或产生过该功能；`contentReplacements` 以 session ID 分组，不存在时由调用方回退为空数组。

字段说明：返回值的 `messages` 是按 UUID 索引的 transcript message，`contentReplacements` 是每条消息的大内容替换记录，`contextCollapseCommits` 保存历次 context-collapse 提交，`contextCollapseSnapshot` 保存可选快照，`leafUuids` 则给出可用于恢复分支的叶子集合。

加载器先计算所有被别人引用过的 `parentUuid`，再找无子节点的 terminal message，最后回溯到最近的 user/assistant 节点作为叶子候选。遇到旧版本里错误写入父链的 progress entry，还会先把后继消息桥接回 progress 的最近非 progress 祖先。

选定叶子后，`buildConversationChain()` 才生成真正的上下文：

```ts
export function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  const seen = new Set<UUID>()
  let currentMsg: TranscriptMessage | undefined = leafMessage

  while (currentMsg) {
    if (seen.has(currentMsg.uuid)) {
      // ... record cycle diagnostics
      break
    }
    seen.add(currentMsg.uuid)
    transcript.push(currentMsg)
    currentMsg = currentMsg.parentUuid
      ? messages.get(currentMsg.parentUuid)
      : undefined
  }
  transcript.reverse()
  return recoverOrphanedParallelToolResults(messages, transcript, seen)
}
```

函数说明：`buildConversationChain()` 位于 `restored-src/src/utils/sessionStorage.ts`。它从叶子反向沿父指针收集消息，检测 UUID 环后停止，再反转为根到叶的顺序。最后还会恢复并行 `tool_use` 形成的兄弟 assistant 块与 tool_result，避免单父链遍历漏掉并行工具分支。

参数说明：`messages` 以 UUID 为 key；`leafMessage` 必须来自这个集合对应的会话。`parentUuid` 为 `null` 时到达链根；父 UUID 在 Map 中找不到时，`messages.get()` 返回 `undefined`，遍历同样终止。遇到环不会抛弃已经收集的部分链，而是记录错误与事件后返回部分 transcript。

这一层的目标是重建当前分支。JSONL 的追加顺序提供时间线，`parentUuid` 提供拓扑；两者用途不同。

## resume：加载消息只是第一半，恢复状态才是第二半

统一加载入口 `loadConversationForResume()` 接受四种来源语义：

```ts
export async function loadConversationForResume(
  source: string | LogOption | undefined,
  sourceJsonlFile: string | undefined,
): Promise<{
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
  sessionId: UUID | undefined
  // ... restorable metadata
} | null> {
  let log: LogOption | null = null
  let messages: Message[] | null = null
  let sessionId: UUID | undefined

  if (source === undefined) {
    // ... load the most recent non-live session for --continue
  } else if (sourceJsonlFile) {
    const loaded = await loadMessagesFromJsonlPath(sourceJsonlFile)
    messages = loaded.messages
    sessionId = loaded.sessionId
  } else if (typeof source === 'string') {
    log = await getLastSessionLog(source as UUID)
    sessionId = source as UUID
  } else {
    log = source
  }

  // ... expand a lite log and restore plan/file/skill state
  const deserialized = deserializeMessagesWithInterruptDetection(messages!)
  messages = deserialized.messages
  const hookMessages = await processSessionStartHooks('resume', { sessionId })
  messages.push(...hookMessages)

  return {
    messages,
    turnInterruptionState: deserialized.turnInterruptionState,
    sessionId,
    // ... restorable metadata
  }
}
```

函数说明：`loadConversationForResume()` 位于 `restored-src/src/utils/conversationRecovery.ts`。它把“最近会话、指定 ID、指定 JSONL、已经加载的 LogOption”收敛成同一份恢复结果，然后处理未闭合工具调用、恢复 Skill 状态，并运行 `SessionStart('resume')` Hook。

参数说明：`source` 为 `undefined` 时表示 continue 最近会话；为任意字符串时按 session ID 读取；为 `LogOption` 时复用已加载记录。`sourceJsonlFile` 为字符串时，其优先级高于 `source` 的字符串分支；为 `undefined` 时跳过文件路径。`processSessionStartHooks()` 的 trigger 在这里固定为 `'resume'`。可用 log 或 messages 为空时，函数返回 `null`；读取或恢复异常会记录后重新抛出。

字段说明：局部 `log` 保存已加载的 `LogOption`，`messages` 保存恢复中的消息数组，`sessionId` 保存待接管或待分叉的会话 ID；`loaded.messages` 与 `loaded.sessionId` 分别填充文件来源。`deserialized.messages` 修复消息协议后写回 `messages`，`hookMessages` 追加 resume Hook 输出；最终 `turnInterruptionState` 取自 `deserialized.turnInterruptionState`，与 `messages`、`sessionId` 一起返回。

反序列化尤其重要。如果进程在 assistant 发出 `tool_use` 后中断且缺少对应 `tool_result`，源码会检测中断状态、清理未解决调用并生成必要的合成消息，让下一轮模型看到一致的消息协议；工具本身不会被恢复流程重放。

随后，`processResumedConversation()` 决定“继续旧 session”还是“从历史分叉”：

```ts
export async function processResumedConversation(
  result: ResumeLoadResult,
  opts: {
    forkSession: boolean
    sessionIdOverride?: string
    transcriptPath?: string
    includeAttribution?: boolean
  },
  context: {
    modeApi: CoordinatorModeApi | null
    mainThreadAgentDefinition: AgentDefinition | undefined
    agentDefinitions: AgentDefinitionsResult
    currentCwd: string
    cliAgents: AgentDefinition[]
    initialState: AppState
  },
): Promise<ProcessedResume> {
  // ... match coordinator/normal mode
  if (!opts.forkSession) {
    const sid = opts.sessionIdOverride ?? result.sessionId
    if (sid) {
      switchSession(
        asSessionId(sid),
        opts.transcriptPath ? dirname(opts.transcriptPath) : null,
      )
      await resetSessionFilePointer()
      restoreCostStateForSession(sid)
    }
  } else if (result.contentReplacements?.length) {
    await recordContentReplacement(result.contentReplacements)
  }

  restoreSessionMetadata(
    opts.forkSession ? { ...result, worktreeSession: undefined } : result,
  )
  if (!opts.forkSession) {
    restoreWorktreeForResume(result.worktreeSession)
    adoptResumedSessionFile()
  }
  // ... restore context collapse, Agent, mode, attribution and AppState
}
```

函数说明：`processResumedConversation()` 位于 `restored-src/src/utils/sessionRestore.ts`。它接管加载结果，切换活动 session，恢复持久化元数据与部分 AppState，并返回可直接交给 REPL 的初始消息和状态。

参数说明：`opts.forkSession` 是必填布尔值。`false` 表示复用旧 ID 和文件；`true` 表示保留进程启动时的 fresh ID，不调用 `switchSession()`。`sessionIdOverride`、`transcriptPath`、`includeAttribution` 都可为 `undefined`；ID 缺失时回退到 `result.sessionId`，路径缺失时 projectDir 回退为 `null`，`includeAttribution` 只有显式为 `true` 才计算恢复后的 attribution 状态。`worktreeSession` 的类型是对象、`null` 或 `undefined`：fork 强制改成 `undefined`，避免新会话取得旧会话 worktree 的所有权。

`context` 中的字段用于恢复当前宿主：`modeApi` 负责 Coordinator/normal 模式匹配，`mainThreadAgentDefinition` 与 `agentDefinitions` 恢复主线程角色及候选定义，`currentCwd` 决定路径校验基准，`cliAgents` 保留命令行注入的 Agent，`initialState` 则是合并恢复字段前的 AppState 起点。它们都由启动装配必传，恢复函数不会从 transcript 猜测缺失的运行时依赖。

普通 resume 在 `switchSession()` 后重置旧文件指针，再由 `adoptResumedSessionFile()` 明确接管已经存在的 JSONL。fork 不接管旧文件：REPL 挂载后，记录消息的正常路径会把加载历史写入当前 fresh session 的新文件。

## `/branch`：显式复制 transcript，并保存来源关系

交互式 `/branch` 走的是另一条更直观的路径。`createFork()` 直接读取当前 JSONL：

```ts
const entries = parseJSONL<Entry>(transcriptContent)
const mainConversationEntries = entries.filter(
  (entry): entry is TranscriptMessage =>
    isTranscriptMessage(entry) && !entry.isSidechain,
)

let parentUuid: UUID | null = null
for (const entry of mainConversationEntries) {
  const forkedEntry: TranscriptEntry = {
    ...entry,
    sessionId: forkSessionId,
    parentUuid,
    isSidechain: false,
    forkedFrom: {
      sessionId: originalSessionId,
      messageUuid: entry.uuid,
    },
  }
  const serialized: SerializedMessage = {
    ...entry,
    sessionId: forkSessionId,
  }
  serializedMessages.push(serialized)
  lines.push(jsonStringify(forkedEntry))
  if (entry.type !== 'progress') {
    parentUuid = entry.uuid
  }
}
```

函数说明：这段来自 `restored-src/src/commands/branch/branch.ts` 的 `createFork()`。它生成新 UUID，只复制主对话的 transcript message，重建线性 `parentUuid`，并在每条复制记录上保留来源 session 与来源 message UUID。

参数说明：`createFork(customTitle?)` 的 `customTitle` 可为字符串或 `undefined`；省略时调用方从首条 user message 派生标题，空内容回退为 `Branched conversation`。`isSidechain` 在过滤条件中必须为假，Agent sidechain 因此被排除。第一条复制消息的 `parentUuid` 为 `null`；后续使用上一条复制消息原有的 UUID。`forkedFrom` 固定包含 `sessionId` 与 `messageUuid` 两个来源坐标。

完整函数还会复制当前 session 的 `content-replacement` 记录，并把其中的 session ID 改成 fork ID，否则恢复 fork 时会丢失“哪些大工具结果已经换成预览”的判断。新文件以 `0o600` 写入；原 transcript 不会被修改。

随后 `/branch` 构造 `LogOption`，调用与 `/resume` 共用的 `context.resume(sessionId, forkLog, 'fork')`。这里的 `ResumeEntrypoint` 可选值在源码中明确为：`'cli_flag' | 'slash_command_picker' | 'slash_command_session_id' | 'slash_command_title' | 'fork'`。它用于区分入口；只有 `'fork'` 会走复制 plan、跳过旧 worktree 接管等分支。

需要特别区分 `/branch` 和 `--fork-session`：前者立即创建并写好 fork JSONL，还保存逐消息 `forkedFrom`；后者通过恢复流程加载旧历史，但保留 fresh session ID，之后由正常 transcript 记录链把消息落进新文件。它们都让未来消息与原 session 分开，但来源记录与创建时机并不相同。

## prompt history 与 transcript 分开存储

源码里还有一个容易混淆的 `history.jsonl`。它服务于上箭头和 Ctrl-R 的输入历史，不负责恢复 Agent 对话。

```ts
const MAX_HISTORY_ITEMS = 100
const MAX_PASTED_CONTENT_LENGTH = 1024

if (content.content.length <= MAX_PASTED_CONTENT_LENGTH) {
  storedPastedContents[Number(id)] = {
    id: content.id,
    type: content.type,
    content: content.content,
    mediaType: content.mediaType,
    filename: content.filename,
  }
} else {
  const hash = hashPastedText(content.content)
  storedPastedContents[Number(id)] = {
    id: content.id,
    type: content.type,
    contentHash: hash,
    mediaType: content.mediaType,
    filename: content.filename,
  }
  void storePastedText(hash, content.content)
}
```

函数说明：这段来自 `restored-src/src/history.ts` 的 `addToPromptHistory()`。它把输入框的 display 文本写入全局 `history.jsonl`，同时把粘贴文本保存为内联内容或 paste store 的 hash 引用。

参数说明：`addToPromptHistory(command)` 接受字符串或 `HistoryEntry`。粘贴内容长度小于等于 `1024` 时内联，大于 `1024` 时保存 `contentHash`，实际 paste store 写入是 fire-and-forget。`PastedContent.type` 在这里可见 `'text' | 'image'`，但 image 会提前跳过，因为图片由 image-cache 单独保存。`MAX_HISTORY_ITEMS = 100` 只约束输入历史的读取窗口；transcript 消息量由另一套持久化机制管理。

字段说明：`storedPastedContents[Number(id)]` 以数值化的外层 `id` 索引粘贴对象；对象内的 `id`、`type`、`mediaType`、`filename` 保留原始元数据。短文本写入 `content`，长文本用 `hashPastedText()` 生成 `hash` 并写入 `contentHash`，原文再由 `storePastedText()` 异步保存。

读取时，`resolveStoredPastedContent()` 优先使用内联 `content`；省略时再用 `contentHash` 查 paste store；两者均无法解析就返回 `null`。这会影响输入历史能否还原粘贴文本；`--resume` 则从已经写入 `<sessionId>.jsonl` 的真实消息恢复对话。

把两种历史分开很有必要：prompt history 是输入体验，允许去重、限制最近 100 条、按项目筛选；session transcript 是执行证据，需要保留 assistant、tool_result、附件、系统消息和恢复元数据。用一份文件同时承担两件事，会让隐私范围、清理策略和恢复语义互相牵制。

## 恢复的边界：重建状态无法回滚副作用

从源码可以确认，resume 会尝试恢复这些内容：

- 选定消息链，以及中断工具调用的协议一致性；
- session ID、transcript 路径与成本状态；
- 文件历史、内容替换、context-collapse 记录；
- Agent 设置、coordinator/normal mode、名称和颜色；
- attribution、旧版 Todo 状态，以及仍然存在的 worktree 目录；
- resume 类型的 SessionStart Hook 输出。

但这些内容不能由 transcript 自动恢复：

- 已退出的 Bash 子进程、旧的流式 HTTP 连接和 AbortSignal；
- 工具背后的远程事务、邮件、部署或第三方 API 状态；
- 已被用户删除的 worktree 目录；
- 未进入写队列、写队列尚未 flush，或进程异常终止时丢失的数据；
- 运行时功能开关、托管策略和远端服务在下一次启动时的实际取值。

源码还提供了一个很明确的 SDK 边界：`restored-src/src/entrypoints/agentSdkTypes.ts` 中导出的 `forkSession()` 与 `unstable_v2_resumeSession()` 在这份还原源码里都直接抛出 “not implemented in the SDK”。

最重要的一条边界是副作用。resume 只重建消息，fork 只复制历史；两者都不会重跑工具或复制工作目录。假设旧会话执行过 `rm`、发过请求或推送过分支，新会话只继承“这些操作曾经发生”的记录。文件隔离需要结合 Git commit、快照或 worktree；外部事务安全需要依靠幂等键和服务端状态。

## 小结

Claude Code 把会话恢复建立在一份追加式 JSONL transcript 上。写入端先清理与去重消息，再用 UUID 和 `parentUuid` 组成链，为记录补上当前 session、cwd、版本和入口信息，最后通过按文件分组的短周期队列追加落盘。消息之外，标题、模式、worktree、文件历史、内容替换与压缩状态也以独立 entry 进入同一账本。

恢复端先分类消息和元数据，计算叶子，沿父链重建当前分支，修复旧 progress 链与并行工具结果，再反序列化未完成工具调用，运行 resume Hook，并恢复可持久化状态。普通 resume 切回旧 ID 并接管原文件；`--fork-session` 保留 fresh ID 后重新持久化历史；`/branch` 则显式复制主链，并用 `forkedFrom` 保存逐消息来源。

这套设计的价值是可追加、可追踪、可分支，边界也同样清楚：transcript 保存事件账本，fork 创建对话分叉；进程快照与副作用回滚需要其他机制承担。

## 留给下一篇的问题

你知道 Claude Code 中 `/branch`、`/fork` 和 `/new` 的区别吗？

## 参考资料

- [Claude Code 会话管理](https://code.claude.com/docs/en/sessions)

- [Claude Code Checkpointing](https://code.claude.com/docs/en/checkpointing)

- [Why Claude switched models in your conversation with Fable 5](https://support.claude.com/en/articles/15363606-why-claude-switched-models-in-your-conversation-with-fable-5)

- [Classifier fallback and billing for Claude Fable 5](https://platform.claude.com/cookbook/fable-5-fallback-billing-guide)

- [Fallback credit](https://platform.claude.com/docs/en/build-with-claude/fallback-credit)
