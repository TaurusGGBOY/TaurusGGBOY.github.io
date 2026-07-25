---
title: "Claude Code源码解读06：代理循环如何持续推进"
published: 2026-07-22T11:05:00+08:00
description: "深入 queryLoop 的状态推进、工具回环、权限拒绝、取消补偿、错误恢复与多层预算，解释 Claude Code 的 Agent 循环如何继续和停止。"
tags: ["claude-code", "source-code", "ai-agent", "agent-loop"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-06/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 本章先建立三个概念

- **继续谓词**：循环依据真实 `tool_use`、恢复信号与预算状态决定是否再次请求模型。

- **协议收口**：取消或错误发生后仍需补齐工具结果配对，让下游消费者拿到合法消息链。

- **终止原因**：完成、取消、预算耗尽和 API 错误对应不同 terminal，宿主据此选择后续动作。

![Agent Query Loop 的继续条件与终止出口](/images/posts/claude-code-source-reading-06/06-loop-exits-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇最后的问题是：在 Claude Code CLI 中执行 `/new` 时，它究竟重置了哪些会话状态，又保留了哪些运行现场？

答案先说：**`/new` 在当前 CLI 进程内切换活动会话，保留项目环境和进程级基础设施。**

在 2.1.88 中，`/new` 复用 `/clear` 的实现。`restored-src/src/commands/clear/index.ts` 把它注册成别名：

```ts
const clear = {
  type: 'local',
  name: 'clear',
  description: 'Clear conversation history and free up context',
  aliases: ['reset', 'new'],
  supportsNonInteractive: false,
  load: () => import('./clear.js'),
} satisfies Command
```

这段注册对象的 `type: 'local'` 表示命令在本地宿主执行，`name: 'clear'` 是主名称，`description` 用于命令列表说明，`aliases` 让 `reset` 和 `new` 命中同一实现；`supportsNonInteractive: false` 限制它只能在交互式宿主使用，`load` 通过动态导入延迟加载 `clear.js`。因此，输入 `/new` 后真正执行的是 `clearConversation()`。先看会被重置的部分，主要有四类：

1. 当前消息数组清空，下一次模型请求不再携带旧对话。
2. `conversationId` 与 `sessionId` 重新生成，session file 指针和待写入项清空，后续 transcript 写进新会话。
3. read-file state、文件历史快照、会话 metadata、plan slug、已发现 Skill、nested memory 路径以及多种 session cache 被清理。
4. MCP 的 clients、tools、commands 和 resources 回到空状态等待重新初始化；旧会话先执行 `SessionEnd('clear')`，新会话再执行 `SessionStart('clear')`，Hook 返回的消息可能成为新消息列表的起点。

再看被保留下来的运行现场。

CLI 进程和项目文件都会保留。`clearConversation()` 只更新 AppState 中明确列出的字段，其余进程配置、认证与权限基础设施仍由同一个宿主持有。当前工作目录会回到本次启动时的 `originalCwd`；Coordinator/normal mode 与 worktree 状态会在清理后重新写入，继续沿用清理前的模式语义。

任务按运行形态分别处理。源码只清理显式标记为 `isBackgrounded === false` 的前台任务；后台任务和 in-process teammate 可以保留，对应 Agent 的部分 session state 也会绕过缓存清理。MCP 的 `pluginReconnectKey` 同样保留，确保 `/new` 后插件仍能重连。

旧会话还会成为新会话的 `parentSessionId`。`resetSessionFile()` 把当前文件指针设为 `null` 并清空 `pendingEntries`，旧 transcript 继续保留在磁盘。旧对话由此退出当前上下文，同时作为可追溯的父会话存在。

所以，更准确的心智模型是：`/new` 把“正在和模型说的这段话”换成一张白纸，同时保留“Claude Code 正在哪个项目、以什么配置运行、后台还有哪些工作”这层宿主现场。

新会话收到下一条用户输入以后，仍会进入同一套 Agent loop。接下来我们就沿这条循环看：它怎样判断应该继续调用模型、执行工具，还是结束本轮运行。

本文继续只讨论 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码。还原路径用于定位证据，不代表 Anthropic 内部仓库的原始目录结构。下面的代码块都是 `restored-src/` 中的真实源码摘录；为突出主线，省略了无关参数、遥测和实验分支，省略处会明确标注，不把改写后的伪代码当作源码。

## 先把 Agent loop 看成一台两出口机器

我们先不用“规划”“反思”这些宽泛概念，只看一次迭代的输入和输出。

一次迭代拿到已有消息与工具上下文，调用模型并消费流。流结束后只有两条主路：

1. `tool_use` 集合为空：依次检查恢复、Stop hook 和 token budget；所有继续条件都未触发时结束。
2. 有 `tool_use`：执行工具，把结果和附件追加到消息，再回到下一次模型调用。

![queryLoop 单次迭代与停止条件手绘图](/images/posts/claude-code-source-reading-06/06-agent-query-loop-handdrawn.png)

图里把权限拒绝画进 `error tool_result`，因为拒绝首先要作为调用结果回填协议。模型提出动作，运行时负责写回真实结果；下一步怎么做，再由模型结合新证据判断。

## query() 只是外壳，状态真正留在 queryLoop() 里

`restored-src/src/query.ts` 的 `query()` 很短。它把工作委托给 `queryLoop()`，等循环正常返回以后，再补齐队列命令的生命周期通知：

```ts
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)

  // Only reached if queryLoop returned normally. Skipped on throw (error
  // propagates through yield*) and on .return() (Return completion closes
  // both generators). This gives the same asymmetric started-without-completed
  // signal as print.ts's drainCommandQueue when the turn fails.
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

函数说明：`query()` 是公开的异步生成器入口。它原样转发 `queryLoop()` 产生的流事件、消息和附件；只有 `queryLoop()` 正常 `return` 时，才会把本轮消费过的队列命令标记为 `completed`。如果下层抛错，错误会穿过 `yield*` 继续向上传播。

这里的 `terminal` 指循环的“收工信号”：`query()` 通过 `yield*` 接住 `queryLoop()` 的返回值后再 `return` 出去。它是一个结果对象，至少包含统一字段 `reason`（表示本轮为什么结束），某些分支还会附带 `turnCount`（`max_turns`）或 `error`（`model_error`）等字段。这样上层能根据终止原因区分正常完成、达到 `max_turns`、恢复失败、模型异常和用户中断。

参数说明：`params` 是 `QueryParams`，必填字段包括 `messages`、`systemPrompt`、`userContext`、`systemContext`、`canUseTool`、`toolUseContext` 与 `querySource`。`fallbackModel`、`maxOutputTokensOverride`、`maxTurns`、`skipCacheWrite`、`taskBudget` 和测试用 `deps` 都可以是 `undefined`；未提供时，相应的回退、上限、缓存跳过或 API task budget 分支不会由这个参数启用。

`queryLoop()` 用跨迭代 `state` 和 `while (true)` 推进每一轮：

```ts
let state: State = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  maxOutputTokensOverride: params.maxOutputTokensOverride,
  autoCompactTracking: undefined,
  stopHookActive: undefined,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  turnCount: 1,
  pendingToolUseSummary: undefined,
  transition: undefined,
}

while (true) {
  let { toolUseContext } = state
  const {
    messages,
    autoCompactTracking,
    maxOutputTokensRecoveryCount,
    hasAttemptedReactiveCompact,
    maxOutputTokensOverride,
    pendingToolUseSummary,
    stopHookActive,
    turnCount,
  } = state
```

函数说明：`queryLoop()` 用 `State` 保存下一次迭代需要的消息、工具上下文、turn 计数以及恢复状态。每个继续分支都会构造新的 `State`，再执行 `continue`；每个终止分支则返回带 `reason` 的 terminal。

参数说明：`messages` 和 `toolUseContext` 必须由调用方提供；`turnCount` 固定从 `1` 开始。`maxOutputTokensOverride` 省略时沿用正常模型输出上限；`autoCompactTracking`、`stopHookActive`、`pendingToolUseSummary` 与 `transition` 首轮尚未建立，相关分支按初始路径运行。`maxOutputTokensRecoveryCount: 0` 允许从第一次输出截断恢复开始计数，`hasAttemptedReactiveCompact: false` 允许本轮首次尝试响应式压缩；两者共同限制恢复重试。

这说明每次回到循环顶部时，输入消息、工具状态和恢复原因都可能已经改变。模型看到的是上一次行动造成的新状态，循环据此发起下一次请求。

## 一次迭代先把上下文交给模型流

进入模型前，`queryLoop()` 会从 compact boundary 后取出有效消息，处理工具结果预算、microcompact、system context 等内容，再更新 `toolUseContext.messages`。这些属于上下文管理，本系列第 17 篇会单独展开。本篇只保留真正决定循环方向的部分。

`deps.callModel()` 接收整理后的消息、系统提示词、工具定义和取消信号：

```ts
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    async getToolPermissionContext() {
      const appState = toolUseContext.getAppState()
      return appState.toolPermissionContext
    },
    model: currentModel,
    ...(config.gates.fastModeEnabled && {
      fastMode: appState.fastMode,
    }),
    toolChoice: undefined,
    isNonInteractiveSession:
      toolUseContext.options.isNonInteractiveSession,
    fallbackModel,
```

函数说明：`deps.callModel()` 是模型调用依赖。生产环境由 `productionDeps()` 提供实现，测试可以通过 `QueryParams.deps` 替换。`for await` 逐条消费模型流，所以 assistant 消息、部分事件和工具调用不必等完整响应结束后才对上层可见。

参数说明：`messages` 是追加 `userContext` 后的有效历史；`systemPrompt` 是已经附加 `systemContext` 的完整系统提示词；`thinkingConfig` 的源码类型可以表达 `adaptive`、带 `budgetTokens` 的 `enabled` 或 `disabled`，这里沿用宿主已经解析的值。`tools` 是当前可用工具集合；`signal` 是必传的 `AbortSignal`。`getToolPermissionContext()` 每次读取最新权限上下文；`model` 是本轮解析出的模型字符串。`fastMode` 只在对应 gate 开启时传入；`toolChoice` 在这里明确为 `undefined`；`isNonInteractiveSession` 是布尔值；`fallbackModel` 可以为 `undefined`，此时不会进入指定模型的 fallback 重试。摘录在该字段后结束，`options` 中的 `querySource`、Agent、MCP、tracking 与 task budget 等后续字段未展示。

流里可能连续出现多个 assistant message。源码一边向上游 `yield`，一边收集 assistant 消息和其中的 `tool_use`：

```ts
if (message.type === 'assistant') {
  assistantMessages.push(message)

  const msgToolUseBlocks = message.message.content.filter(
    content => content.type === 'tool_use',
  ) as ToolUseBlock[]

  if (msgToolUseBlocks.length > 0) {
    toolUseBlocks.push(...msgToolUseBlocks)
    needsFollowUp = true
  }
}
```

函数说明：这段位于 `queryLoop()` 的模型流消费阶段。它从 assistant 内容块中提取真实 `tool_use`，放进本轮 `toolUseBlocks`，并把 `needsFollowUp` 设为 `true`。源码注释明确指出，`stop_reason === 'tool_use'` 并不总是可靠，因此内容块才是唯一的主循环继续信号。

参数说明：`message.type` 只有等于 `'assistant'` 时才进入这段分支；其他 stream、system 或 user 事件不会改变 `needsFollowUp`。`message.message.content` 是内容块数组，筛选条件只接受 `type === 'tool_use'`。`toolUseBlocks` 初始为空数组，`needsFollowUp` 初始为 `false`；一旦某个 assistant message 含有至少一个工具块，本轮就进入工具路径。

也就是说，文本本身不决定继续。模型可以先输出一段解释，再输出工具调用；只要流里出现工具块，文本与工具调用都会作为这次 assistant 轨迹的一部分保留下来。

## tool_use 为空时继续检查其他出口

模型流结束后，`queryLoop()` 先处理取消，再检查 `needsFollowUp`。当它为 `false` 时，控制流才进入“可能结束”的分支：

```ts
if (!needsFollowUp) {
  const lastMessage = assistantMessages.at(-1)
```

函数说明：这是 `queryLoop()` 无工具分支的真实开头，摘录到 `lastMessage` 为止；后续依次处理上下文溢出、输出截断、API error、Stop hook 和 token budget，所有继续条件清空后才执行 `return { reason: 'completed' }`。

参数说明：`needsFollowUp` 是本轮布尔标志，默认 `false`，只在发现 `tool_use` 时变为 `true`。`assistantMessages.at(-1)` 可能返回 `undefined`；源码使用可选链处理这种情况。terminal 的 `reason` 在正常出口固定为 `'completed'`，但同一函数还有 `blocking_limit`、`prompt_too_long`、`image_error`、`model_error`、`aborted_streaming`、`stop_hook_prevented`、`hook_stopped`、`aborted_tools` 与 `max_turns` 等可见返回原因。

工具列表为空时，循环还要区分至少四种结束或续写状态。

第一种，模型给出了最终回答，Stop hook 放行且 token budget 允许结束，循环正常完成。

第二种，模型返回 API error。源码跳过 Stop hook，避免“错误 → Hook 阻断 → 再请求 → 再错误”的死循环，转而执行失败 Hook 后结束。

第三种，模型输出撞上 `max_output_tokens`。2.1.88 会先尝试提高输出上限或注入一条 meta user message，让模型从中断处继续；恢复次数达到常量 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` 后，才把之前暂存的错误暴露出去。

第四种，模型想结束，但 Stop hook 返回 blocking error，或者实验性的 token budget 判断认为工作量还没到目标。两者都会生成新的 user/meta message，更新 `state` 后继续下一次迭代。

因此，模型决定“这次不再调用工具”，运行时决定“这次是否真的可以收口”。两层判断叠在一起，才是实际停止条件。

## 出现 tool_use，先把动作变成可执行批次

当 `needsFollowUp === true`，`queryLoop()` 会选择流式工具执行器，或调用 `restored-src/src/services/tools/toolOrchestration.ts` 的 `runTools()`。后者先按并发安全性分组：只读、安全的批次可以并行，可能修改状态的批次按顺序执行。

主循环消费工具更新的代码很直接：

```ts
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

for await (const update of toolUpdates) {
  if (update.message) {
    yield update.message
    toolResults.push(
      ...normalizeMessagesForAPI(
        [update.message],
        toolUseContext.options.tools,
      ).filter(_ => _.type === 'user'),
    )
  }
  if (update.newContext) {
    updatedToolUseContext = {
      ...update.newContext,
      queryTracking,
    }
  }
}
```

函数说明：这段代码把工具执行产生的 `MessageUpdate` 同时送往两个方向：`yield` 让 UI 或 SDK 看到进度与结果；`normalizeMessagesForAPI()` 把可以回传模型的部分归一化为 user message，存入 `toolResults`。工具若返回新的上下文，也会替换下一轮使用的 `ToolUseContext`。

### normalizeMessagesForAPI 到底做了什么

这里再展开 `normalizeMessagesForAPI([update.message], tools)` 的处理链。它的目标是把内部消息改成“下一次模型请求可接受”的序列（实现位于 `restored-src/src/utils/messages.ts`）：

1. `reorderAttachmentsForAPI()` 先把 `attachment` 上推到最近的 `assistant` 或包含 `tool_result` 的 `user` 前，确保顺序不被打乱。
2. 过滤掉不应上 API 的类型：`progress`、非本地命令的 `system`、`isSyntheticApiErrorMessage`（合成错误消息）。
3. 分类型标准化：
   - `system` 转成 `user`，并与前置 `user` 合并；
   - `user` 与相邻 `user` 合并，并处理 `tool_reference`：未启用 tool search 时整段去掉，启用时只去掉不可用工具引用；
   - `assistant` 保留 `tool_use`，但对 `tool_use.input` 先做 `normalizeToolInputForAPI`，并在未启用 tool search 时去掉 `caller` 等非标准字段；
   - `attachment` 转为 API 可接受片段再合并回 user 轨迹。
4. 做后处理：修正 tool_reference 兄弟节点顺序、移除孤儿 thinking-only、清理白字符/空 assistant、确保内容非空、最终 `validateImagesForAPI`。
5. 可选分支：`HISTORY_SNIP` 开启且非测试时会给 user 消息追加 `[id:xxx]` 标记，便于 snip tool 引用。

因此这段代码后面会 `filter(_ => _.type === 'user')`：`normalizeMessagesForAPI` 返回 `UserMessage | AssistantMessage`，但这里要存的是下一次 `callModel` 可直接读取的 user-tool_result 轨迹。

补充一句：在真正发起 API 请求前，`restored-src/src/services/api/claude.ts` 会再做一层模型相关的二次清洗（例如在不支持工具搜索的模型下再次剥离 `tool_reference`/`caller`），所以 `normalizeMessagesForAPI` 本身并不承载“模型是否支持”这个决策。

参数说明：`streamingToolExecutor` 可以是实例或 `null`；非空时取得流式阶段尚未消费的结果，为 `null` 时走 `runTools()`。`runTools()` 的四个参数分别是本轮 `toolUseBlocks`、产生调用的 `assistantMessages`、权限回调 `canUseTool` 和当前 `toolUseContext`，均为必填。`update.message` 与 `update.newContext` 都可以是 `undefined`，所以源码分别判断；归一化后只保留 `type === 'user'` 的消息，因为 Anthropic 工具协议要求 `tool_result` 以 user role 回到下一次模型请求。

这里能看出一个很实际的设计：工具执行会同时产生最终内容、progress、attachment 和 context modifier。主循环把“给宿主看的事件”和“给模型看的消息”分开处理，再在下一轮重新汇合。

## 权限拒绝也是一个工具结果

权限检查发生在工具真正执行之前。`restored-src/src/services/tools/toolExecution.ts` 的 `checkPermissionsAndCallTool()` 先通过 Hook 与 `canUseTool` 得到最终决定；只有 `allow` 会进入工具调用，`ask` 与 `deny` 都会构造错误结果：

```ts
if (permissionDecision.behavior !== 'allow') {
  const messageContent: ContentBlockParam[] = [
    {
      type: 'tool_result',
      content: errorMessage,
      is_error: true,
      tool_use_id: toolUseID,
    },
  ]

  // 省略可选图片 content blocks 与 imagePasteIds 的处理
  resultingMessages.push({
    message: createUserMessage({
      content: messageContent,
      imagePasteIds: rejectImageIds,
      toolUseResult: `Error: ${errorMessage}`,
      sourceToolAssistantUUID: assistantMessage.uuid,
    }),
  })
  return resultingMessages
}
```

函数说明：`checkPermissionsAndCallTool()` 把权限拒绝转换成协议完整的 user message。目标工具保持未调用状态，但对应的 `tool_use` 仍得到一个 `tool_result`，并通过 `tool_use_id` 保持配对。这样下一次模型调用能同时读到原始请求和拒绝原因。

参数说明：`permissionDecision.behavior` 的源码联合类型是 `'allow'`、`'ask'` 或 `'deny'`；只有严格等于 `'allow'` 才进入实际工具调用，另外两个值都走本分支。`messageContent` 是回填给模型的内容块数组；其中 `type: 'tool_result'` 固定协议类型，`content` 保存开放的 `errorMessage`，`is_error: true` 标记失败，`tool_use_id` 使用原始 `toolUseID` 配对。外层 `message` 是 `createUserMessage()` 的结果；`imagePasteIds` 关联拒绝决定附带的图片，`toolUseResult` 保存供宿主展示的错误摘要，`sourceToolAssistantUUID` 指向发起工具调用的 assistant 消息。权限决定还可能附带其他 `contentBlocks`，摘录为突出主线而省略。

所以，权限拒绝会作为新事实进入模型下一轮。模型可以解释无法执行，也可以换用权限要求不同的工具。只有 PreToolUse hook 同时产生 `hook_stopped_continuation` attachment 时，主循环才会在工具批次之后返回 `hook_stopped`。

工具自身抛错也遵循相似原则：执行层尽量把失败映射为错误 `tool_result`。本篇省略各工具的业务错误格式，循环层只检查是否形成可配对、可回填的消息。

## tool_result 回填以后，下一轮状态才完整

工具执行结束后，循环还会收集排队命令、任务通知、文件变化、memory 和 skill attachment。源码特别强调，这些普通 user message 不能插在一组 `tool_use` 与 `tool_result` 中间，否则 API 会拒绝消息顺序。

等工具结果与附件都准备好以后，`queryLoop()` 才检查 `maxTurns`，再构造下一轮状态：

```ts
const nextTurnCount = turnCount + 1

if (maxTurns && nextTurnCount > maxTurns) {
  yield createAttachmentMessage({
    type: 'max_turns_reached',
    maxTurns,
    turnCount: nextTurnCount,
  })
  return { reason: 'max_turns', turnCount: nextTurnCount }
}

state = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  pendingToolUseSummary: nextPendingToolUseSummary,
  maxOutputTokensOverride: undefined,
  stopHookActive,
  transition: { reason: 'next_turn' },
}
```

函数说明：这段是工具路径的迭代边界。`nextTurnCount <= maxTurns` 时，旧消息、本轮 assistant 消息和全部工具结果会按顺序拼成下一次模型请求的历史；随后 `while (true)` 回到顶部。超过上限时先发出 `max_turns_reached` attachment，再返回 `max_turns` terminal。

参数说明：`turnCount` 首轮为 `1`，每次完成一批工具结果并准备再次请求模型时加一。`maxTurns` 是可选 `number`；省略或为 `0` 时，`if (maxTurns && ...)` 不启用限制；比较条件是 `nextTurnCount > maxTurns`。`messages` 按查询前历史、assistant 消息、工具结果的协议顺序拼接；`toolUseContext` 使用带 query tracking 的新上下文，`autoCompactTracking` 保存本轮 compact 跟踪，`pendingToolUseSummary` 延续待处理摘要，`stopHookActive` 延续 Hook 状态。`maxOutputTokensRecoveryCount` 重置为 `0`，`hasAttemptedReactiveCompact` 重置为 `false`，`maxOutputTokensOverride` 清除临时覆盖；`transition.reason` 固定为 `'next_turn'`。

继续推理由 `queryLoop()` 驱动：它把 `assistantMessages` 与 `toolResults` 写入 `state.messages`，回到同一个 `while` 顶部，再次调用 `deps.callModel()`。工具和 `runTools()` 只负责产出结果。

## 取消时，先补齐消息配对再退出

取消可能发生在模型流阶段，也可能发生在工具执行阶段。两种路径都会检查同一个 `AbortController.signal`，但清理动作不完全相同。

模型流被取消时，源码优先补齐尚未完成的工具结果：

```ts
if (toolUseContext.abortController.signal.aborted) {
  if (streamingToolExecutor) {
    for await (const update of streamingToolExecutor.getRemainingResults()) {
      if (update.message) yield update.message
    }
  } else {
    yield* yieldMissingToolResultBlocks(
      assistantMessages,
      'Interrupted by user',
    )
  }
  // 省略 computer-use 清理和 interruption message 分支
  return { reason: 'aborted_streaming' }
}
```

函数说明：这是 `queryLoop()` 在模型流完成后最先检查的退出分支。使用流式工具执行器时，它会消费剩余结果，让执行器为排队中或进行中的工具生成合成结果；非流式路径调用 `yieldMissingToolResultBlocks()`，为已经出现的每个 `tool_use` 生成错误结果，然后返回 `aborted_streaming`。

参数说明：`signal.aborted` 是布尔值，默认由 `AbortController` 维护；只有变为 `true` 才进入本分支。`streamingToolExecutor` 为实例或 `null`。`yieldMissingToolResultBlocks()` 接收本轮 assistant 消息数组和开放错误字符串；它生成的 `tool_result` 固定 `is_error: true`，并沿用对应 `tool_use.id`。取消原因若是特殊字符串 `'interrupt'`，后续源码会跳过额外的用户中断消息，因为排队的新输入已经提供上下文；其他 reason 则会追加 interruption message。

工具执行期间被取消时，循环已经消费完执行器能给出的更新，随后返回 `aborted_tools`。如果下一 turn 已超过 `maxTurns`，它还会在返回前发出上限 attachment。取消信号不提供事务回滚。

## 模型错误、上下文错误与恢复边界

正常情况下，模型 API 层倾向于把错误包装成 synthetic assistant message，让主循环统一处理。但 `deps.callModel()` 仍可能直接抛异常。此时 `queryLoop()` 会补齐孤立的工具结果，暴露真实错误，再返回 `model_error`：

```ts
} catch (error) {
  // 省略日志与 ImageSizeError / ImageResizeError 分支
  const errorMessage =
    error instanceof Error ? error.message : String(error)

  // 省略异常路径说明注释
  yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)
  yield createAssistantAPIErrorMessage({ content: errorMessage })
  // 省略内部错误日志
  return { reason: 'model_error', error }
}
```

函数说明：这是模型流外层异常处理。它保留运行时异常的真实错误文本，并与用户中断使用不同的 `reason`；如果抛错前已经收到 `tool_use`，先补错误 `tool_result`，避免 transcript 和下一层消费者拿到不完整协议。

参数说明：捕获值 `error` 可以是任意 JavaScript 抛出值；`Error` 实例读取 `.message`，其他值用 `String()` 转换。`createAssistantAPIErrorMessage()` 接收错误内容，具体 API error 分类可能由更下层设置；terminal 的 `reason` 固定为 `'model_error'`，并保留原始 `error`。

上下文过长的处理更复杂。自动 compact 关闭且到达 hard blocking limit 时，循环会发出 prompt-too-long assistant error 并返回 `blocking_limit`。启用相应 feature 时，它可以先 drain context collapse，再尝试 reactive compact，然后用压缩后的消息 `continue`。恢复仍失败，才返回 `prompt_too_long` 或 `image_error`。

这些路径说明 `continue` 不只来自工具。恢复上下文、恢复输出截断、Stop hook blocking 和 token budget nudge 都可以构造新状态，再请求模型。区别在于它们会在 `state.transition.reason` 中留下不同原因，例如 `reactive_compact_retry`、`max_output_tokens_recovery`、`stop_hook_blocking` 或 `token_budget_continuation`。

## 三种预算在不同层检查

2.1.88 源码里至少有三种容易被统称为“预算”的机制，它们不在同一层。

`maxTurns` 是 `queryLoop()` 的本地迭代上限。它只在已经产生工具结果、准备进入下一次模型调用时检查；纯文本最终回答会从正常完成分支离开。

feature gate `TOKEN_BUDGET` 控制的是另一套本地续写判断。模型准备以纯文本结束时，`checkTokenBudget()` 会比较当前 turn 输出 token 与预算：低于 90% 且尚未连续出现收益递减时，它注入 meta nudge 继续；连续至少三次后，若最近两次增量都小于 500 token，则按 diminishing returns 提前停止。`agentId` 存在、预算为 `null` 或小于等于 `0` 时，这套判断直接返回 stop。这里的 90%、3 次和 500 都是 2.1.88 静态常量，其他版本或线上 feature 的启用状态属于运行时证据。

`taskBudget?: { total: number }` 则随模型请求进入 API 的 `output_config.task_budget`。本地循环在 compact 后维护 `remaining`，避免服务端只看到摘要而低估已消耗上下文。

上一篇提到的 `maxBudgetUsd` 位于更外层：`QueryEngine.submitMessage()` 消费循环消息时检查累计 `getTotalCost() >= maxBudgetUsd`，达到后返回 `error_max_budget_usd`；`queryLoop()` 的 `QueryParams` 不接收这个值。因此，美元预算可能在一条消息已经产生后才被宿主截停，它与 `maxTurns` 分属两个检查边界。

### dynamic workflow 与预算：2.1.154 以后会挂在更上层，而本文的 `2.1.88` 只看到“接口壳”

官方在 2026-05-28 的 changelog（[Claude Code changelog](https://code.claude.com/docs/en/changelog)）与官方公告（[Introducing dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)）里定义了 dynamic workflows：大任务可并行拆成大量子代理，支持长时运行，并建议在试点时先从小任务测 token 消耗。2.1.202 又补充了 workflow 大小（small/medium/large）这类偏好设置，偏向建议而非硬上限。

在本文聚焦的 `2.1.88` 里，dynamic workflow 只留下了“骨架可见”痕迹：

1. `TaskType` 包含 `local_workflow`（`TASK_ID_PREFIXES` 里也有 `w` 前缀）。
2. `tasks.ts` 通过 `feature('WORKFLOW_SCRIPTS')` 动态 `require('./tasks/LocalWorkflowTask/LocalWorkflowTask.js')`。
3. `getPillLabel()` 能将 `local_workflow` 显示为 `background workflow`，说明它作为后台任务类型存在。

但 source map 只留下 `tasks/LocalWorkflowTask/*` 和 `commands/workflows/*` 的引用，缺少对应实现文件，静态证据不足以复原完整编排算法（例如子任务拆分策略、是否有 run 级统一预算）。

这意味着本文的预算结论主要用于 dynamic workflow 的“子会话层”：

- `runAgent()` 在调用 `query()` 时会透传 `maxTurns`：`maxTurns ?? agentDefinition.maxTurns`。`agentDefinition.maxTurns` 来自 `loadAgentsDir` 的 frontmatter 解析（可选、正整数）；fork 子代理则有独立默认 `200`（`forkSubagent.ts`）。
- `query()` 支持 `taskBudget?: { total: number }`，并会带到 `output_config.task_budget`。
- `maxBudgetUsd` 仍是 `QueryEngine` 层面的单次 `submitMessage` 截断。dynamic workflow 的 run 级总预算若存在，应由更外层调度/编排实现提供，当前 `queryLoop()` 只暴露 turn 级预算逻辑。

所以看 dynamic workflow 的“总预算表现”时建议按三层检查：先看子代理的 `maxTurns / taskBudget`，再看 QueryEngine 的单会话 `maxBudgetUsd`，最后查动态工作流运行器的 run 级预算和并发控流。本文源码只能直接验证前两层。

把这几层分开，才能避免一个常见误解：配置了“预算”不代表所有副作用都能在同一瞬间硬停止。模型请求、流式事件、工具执行和宿主消费各有自己的检查位置。

## 小结

`queryLoop()` 的核心判断很朴素：检查模型流里是否出现真实的 `tool_use`。

工具调用集合为空时，它先处理可恢复错误、Stop hook 和 token budget，随后返回 terminal；存在工具调用时，它经过权限与执行层取得 `tool_result`，按协议顺序追加 assistant 消息、结果和附件，检查 `maxTurns`，再把新状态带回下一次模型请求。

权限拒绝和工具失败之所以通常不会直接结束，是因为它们也是模型下一步推理需要的事实。取消与模型异常之所以还要生成合成 `tool_result`，是因为 Agent 即使失败，也要尽量维持 `tool_use` / `tool_result` 的配对关系。

因此，Claude Code 的 Agent loop 是一段可观察的消息状态机：每次继续都有新增消息，每次停止都有明确出口，每次副作用都要留下能被下一轮理解的结果。

## 留给下一篇的问题

Claude Code 里的 `turn` 到底算什么？我发一句用户消息后，后续每次“工具调用 + 结果反馈”的往返都算一个新的 turn 吗？`maxTurns` 这个上限能不能手动设置？

## 参考资料

- [Claude Code 的工作方式](https://code.claude.com/docs/en/how-claude-code-works)

- [错误参考](https://code.claude.com/docs/en/errors)
