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

上一篇留下的问题是：错误恢复让当前运行能够继续以后，Claude Code 如何把会话写入历史，并实现 resume、fork 与分支恢复？

先说结论。Claude Code 不会把整个 Node/Bun 进程做成快照，也不会在恢复时重新执行过去的工具。它把 user、assistant、attachment、system 等消息连同一部分可恢复元数据，持续追加到当前项目目录下的 `<sessionId>.jsonl`。每条消息有自己的 `uuid`，再用 `parentUuid` 指向上一条消息。恢复时，程序从 JSONL 中找出最新叶子节点，沿父指针倒着走回根节点，再把这条链反转、反序列化，并恢复文件历史、内容替换记录、Agent 设置、模式和 worktree 等状态。

resume 与 fork 的区别发生在恢复完历史以后：

- 普通 `--continue`、`--resume` 或 `/resume` 会切回原来的 session ID，并继续向原 transcript 追加消息。
- `--fork-session` 会保留启动时新生成的 session ID，把加载到的旧消息写进一个新的 transcript，随后从新会话继续。
- `/branch` 更直接：它复制当前 transcript 的主对话消息，换成新 session ID，并在每条复制消息上写入 `forkedFrom.sessionId` 与 `forkedFrom.messageUuid`。

三条路径都只能恢复“被持久化的数据”。尚未落盘的写队列、运行中的子进程、已经断开的网络流、旧进程里的 AbortController，都不会因为读取 JSONL 而回来。过去的 Bash、Edit、MCP 调用也不会自动重放；它们造成的外部副作用是否还存在，要看文件系统和外部服务本身。

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的源码块只保留证明当前结论所需的部分，省略了日志、遥测和无关分支；还原路径不等于 Anthropic 内部仓库的原始目录。

## 会话历史不是聊天数组，而是一份可重建的日志

先把整条路径放在一张图里。

![Claude Code 会话写入、恢复与分叉流程](/images/posts/claude-code-source-reading-20/20-session-history-resume-handdrawn.png)

### 先补四个基础概念

第一个概念是 **session ID**。它是一段 UUID，用来确定“当前消息应该写进哪份会话文件”。同一个项目可以有很多 session；普通 resume 会重新采用旧 ID，fork 则需要新 ID，否则两条后续历史仍会混进同一份日志。

第二个概念是 **transcript**。这里不是终端屏幕的纯文本截图，而是由消息和元数据组成的 JSONL 文件。JSONL 的意思是“一行一个 JSON 对象”。它适合追加写入：新消息不需要反序列化并重写整份大数组，元数据也能以新记录覆盖旧记录的语义。

第三个概念是 **消息链**。数组顺序只能表示“写入先后”，不能可靠表示“当前活跃分支”。每条消息因此保存 `uuid` 和 `parentUuid`。一份 JSONL 可以存在多个叶子；恢复某条对话时，从选定叶子沿 `parentUuid` 回溯，才能得到那条分支真正的上下文。

第四个概念是 **fork**。fork 复制的是可恢复的对话状态，不是时间机器。新会话可以继承旧消息，但不会撤销旧对话已经改过的文件，也不会把 Git 工作区复制一份。`--fork-session`、`/branch` 与后文第 26 篇会讲到的 Git worktree，是三个不同层次的隔离机制。

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

参数说明：`getTranscriptPath()` 没有参数。`getTranscriptPathForSession(sessionId)` 的 `sessionId` 是开放字符串，调用方通常传 UUID；函数本身不在这里校验格式。`getSessionProjectDir()` 返回 `string | null`：非 `null` 时使用恢复会话所在目录，`null` 时回退到由 `originalCwd` 派生的项目目录。对“其他 session ID”，源码没有维护全局的 ID 到目录映射，因此只能按当前项目目录猜测；已知跨项目文件的调用方应直接携带完整路径。

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

参数说明：`sessionId` 是经过项目类型约束的 `SessionId`。`projectDir` 是 `string | null`，默认 `null`；传字符串表示 `<sessionId>.jsonl` 所在目录，常用于跨项目或 worktree 恢复，传 `null` 或省略则让后续路径从当前 `originalCwd` 推导。这里没有 `undefined` 这一条独立语义，因为可选参数省略后会直接使用默认值 `null`。

这段设计解决了一个很实际的问题：如果只换 session ID、不换 projectDir，程序可能成功加载了 A 目录的历史，却把下一条消息写到 B 目录下同名的 JSONL。resume 不只是“把消息塞回 React state”，还必须让后续持久化指向正确文件。

## 写入：先去重，再为消息补齐父链

transcript 不是所有 UI 事件的集合。`isTranscriptMessage()` 给出了消息边界：

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

参数说明：`messages` 是本次候选消息数组；`teamInfo` 可为 `undefined`，有值时携带可选的 `teamName`、`agentName`；`startingParentUuidHint` 可为 `undefined`，用于增量写入时避免重新扫描父节点；`allMessages` 也可为 `undefined`，只在清理逻辑需要完整上下文时提供。调用 `insertMessageChain()` 时第二个参数固定为 `false`，表示主对话而非 sidechain；第三个参数显式为 `undefined`，表示没有 Agent ID。返回 `null` 表示没有可用父节点。

去重不是简单性能优化。resume 或 compaction 后，内存消息数组常常同时包含已落盘前缀与新消息。如果把旧 UUID 再写一次，加载端的 Map 会出现覆盖；如果父指针又从错误的旧消息起算，新分支可能变成孤链。

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

注意字段覆盖顺序：源码把 `sessionId`、`cwd` 等当前会话字段放在 `...message` 之后。这样 fork 或 resume 带来的旧 `SerializedMessage` 即使仍保存来源 session ID，也会在写入新文件前被重新盖成当前 ID。

## 落盘：JSONL 是追加账本，不是每轮重写

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

参数说明：`filePath` 是已经解析出的具体路径；`entry` 是消息或元数据联合类型；`data` 是批量生成的 JSONL 字符串。`FLUSH_INTERVAL_MS` 默认 `100`，但不是不可变常量。文件模式为 `0o600`，缺少目录时以 `recursive: true` 和 `0o700` 创建。`appendToFile()` 的 catch 不区分错误码，会尝试建目录后再写；第二次失败仍会向上传播。

写入不是无条件发生。`shouldSkipPersistence()` 会在测试环境、`cleanupPeriodDays === 0`、`--no-session-persistence` 对应状态，或 `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 为真时跳过。新 session 也不会一启动就创建空文件：attachment 或 Hook 记录可以先缓冲，直到出现第一条 user/assistant 消息才 materialize 文件。

。正常退出会调用 flush/cleanup；强制终止的耐久性仍需文件系统与故障注入测试。

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

字段说明：`parentUuid` 必须是 UUID 或 `null`；`logicalParentUuid` 可为 UUID、`null` 或 `undefined`，只在物理链因压缩边界断开时表达逻辑父节点；`isSidechain` 是必填布尔值。其余字段都可为 `undefined`：`agentId` 区分 Agent sidechain，team/name/color 用于团队与展示状态，`promptId` 用于关联 user prompt 与遥测。

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

加载器不会把文件行顺序直接当作当前对话。它先计算所有被别人引用过的 `parentUuid`，再找没有子节点的 terminal message，最后回溯到最近的 user/assistant 节点作为叶子候选。遇到旧版本里错误写入父链的 progress entry，还会先把后继消息桥接回 progress 的最近非 progress 祖先。

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

这一层的关键不是“读回所有行”，而是“重建当前分支”。JSONL 的追加顺序提供时间线，`parentUuid` 提供拓扑；两者用途不同。

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

参数说明：`source` 为 `undefined` 时表示 continue 最近会话；为任意字符串时按 session ID 读取；为 `LogOption` 时复用已加载记录。`sourceJsonlFile` 为字符串时，其优先级高于 `source` 的字符串分支；为 `undefined` 时不走文件路径。`processSessionStartHooks()` 的 trigger 在这里固定为 `'resume'`。若没有可用 log 或 messages，函数返回 `null`；读取或恢复异常会记录后重新抛出。

反序列化尤其重要。如果进程在 assistant 发出 `tool_use` 后中断，却没有对应 `tool_result`，恢复逻辑不能把它伪装成一次已完成工具调用。源码会检测中断状态、清理未解决调用并生成必要的合成消息，让下一轮模型看到一致的消息协议，而不是重放那个工具。

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

参数说明：`createFork(customTitle?)` 的 `customTitle` 可为字符串或 `undefined`；省略时调用方从首条 user message 派生标题，空内容回退为 `Branched conversation`。`isSidechain` 在过滤条件中必须为假，Agent sidechain 不会被复制进主分支。第一条复制消息的 `parentUuid` 为 `null`；后续使用上一条复制消息原有的 UUID。`forkedFrom` 不是可选的时间戳，而是固定包含 `sessionId` 与 `messageUuid` 两个来源坐标。

完整函数还会复制当前 session 的 `content-replacement` 记录，并把其中的 session ID 改成 fork ID，否则恢复 fork 时会丢失“哪些大工具结果已经换成预览”的判断。新文件以 `0o600` 写入；原 transcript 不会被修改。

随后 `/branch` 构造 `LogOption`，调用与 `/resume` 共用的 `context.resume(sessionId, forkLog, 'fork')`。这里的 `ResumeEntrypoint` 可选值在源码中明确为：`'cli_flag' | 'slash_command_picker' | 'slash_command_session_id' | 'slash_command_title' | 'fork'`。它用于区分入口；只有 `'fork'` 会走复制 plan、跳过旧 worktree 接管等分支。

需要特别区分 `/branch` 和 `--fork-session`：前者立即创建并写好 fork JSONL，还保存逐消息 `forkedFrom`；后者通过恢复流程加载旧历史，但保留 fresh session ID，之后由正常 transcript 记录链把消息落进新文件。它们都让未来消息与原 session 分开，但来源记录与创建时机并不相同。

## prompt history 不是 transcript，粘贴引用也有单独存储

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

参数说明：`addToPromptHistory(command)` 接受字符串或 `HistoryEntry`。粘贴内容长度小于等于 `1024` 时内联，大于 `1024` 时保存 `contentHash`，实际 paste store 写入是 fire-and-forget。`PastedContent.type` 在这里可见 `'text' | 'image'`，但 image 会提前跳过，因为图片由 image-cache 单独保存。`MAX_HISTORY_ITEMS = 100` 是读取输入历史的窗口，不是 transcript 最大消息数。

读取时，`resolveStoredPastedContent()` 优先使用内联 `content`；没有时再用 `contentHash` 查 paste store；两者都拿不到就返回 `null`。这会影响输入历史能否还原粘贴文本，却不决定 `--resume` 能否恢复对话，因为真正发送过的消息已经进入 `<sessionId>.jsonl`。

把两种历史分开很有必要：prompt history 是输入体验，允许去重、限制最近 100 条、按项目筛选；session transcript 是执行证据，需要保留 assistant、tool_result、附件、系统消息和恢复元数据。用一份文件同时承担两件事，会让隐私范围、清理策略和恢复语义互相牵制。

## 恢复的边界：能重建状态，不等于回到过去

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

源码还提供了一个很明确的 SDK 边界：`restored-src/src/entrypoints/agentSdkTypes.ts` 中导出的 `forkSession()` 与 `unstable_v2_resumeSession()` 在这份还原源码里都直接抛出 “not implemented in the SDK”。。

最重要的一条边界是副作用。resume 只重建消息，不会重跑工具；fork 只复制历史，不会复制工作目录。假设旧会话执行过 `rm`、发过请求或推送过分支，新会话继承的是“这些操作曾经发生”的记录，不是操作之前的世界。需要文件隔离时，要结合 Git commit、快照或 worktree；需要外部事务安全时，要依靠幂等键和服务端状态，而不是 session fork。

## 小结

Claude Code 把会话恢复建立在一份追加式 JSONL transcript 上。写入端先清理与去重消息，再用 UUID 和 `parentUuid` 组成链，为记录补上当前 session、cwd、版本和入口信息，最后通过按文件分组的短周期队列追加落盘。消息之外，标题、模式、worktree、文件历史、内容替换与压缩状态也以独立 entry 进入同一账本。

恢复端不是简单 `JSON.parse()` 后把数组塞回 UI。它先分类消息和元数据，计算叶子，沿父链重建当前分支，修复旧 progress 链与并行工具结果，再反序列化未完成工具调用，运行 resume Hook，并恢复可持久化状态。普通 resume 切回旧 ID 并接管原文件；`--fork-session` 保留 fresh ID 后重新持久化历史；`/branch` 则显式复制主链，并用 `forkedFrom` 保存逐消息来源。

这套设计的价值是可追加、可追踪、可分支，边界也同样清楚：transcript 是事件账本，不是进程快照；fork 是对话分叉，不是副作用回滚。

## 留给下一篇的问题

会话能够恢复以后，Claude Code 的斜杠命令如何被解析、路由，并与普通用户消息走上不同路径？

