---
title: "Claude Code源码解读32：Ink TUI 与交互式 REPL 如何渲染与刷新"
published: 2026-07-24T16:47:19+08:00
updated: 2026-07-24T16:47:19+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-32/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：**共享状态准备好以后，Claude Code 如何用 Ink 和 React 构建终端 REPL，并把流式消息、工具进度与用户输入渲染到同一界面？**

答案先说：Claude Code 没有让查询循环直接打印字符串，也没有为每一种消息手写一套光标移动脚本。交互模式先把 `AppStateProvider → REPL` 挂成 React 组件树；用户输入经 `PromptInput` 提交给 `query()`，模型事件由 `onQueryEvent()` 转换成 `messages`、`streamingText`、`streamingToolUses` 等状态；React 再根据新状态重新计算 `Messages`、进度条、弹窗和输入区，最后由项目内的 Ink renderer 完成 Yoga 布局、屏幕缓冲区绘制与前后帧 diff，只把变化写到 `stdout`。

也就是说，这不是“Agent 一边跑，一边到处 `console.log`”，而是一条闭环：

`键盘 → React 状态 → query 事件 → React 状态 → Ink 帧 → 终端`。

这条链中，Agent 内核只产生事件，React 负责声明“现在界面应该是什么”，Ink 负责把声明翻译成终端控制序列。用户输入、模型流和工具进度之所以能稳定出现在同一个界面，靠的正是这三层没有混在一起。

本篇继续以 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码为边界。下文代码块都来自 `restored-src/`；为了突出主链，省略了与当前结论无关的参数和分支，不把整理后的伪代码冒充完整源码。

## 先补三个概念：REPL、React 和 Ink

在读 `REPL.tsx` 之前，需要先把三个词说清楚。否则很容易把 React 理解成“网页框架”，又把 REPL 理解成“只能逐行执行代码的命令行”。

### REPL 是一轮轮持续运行的交互循环

REPL 是 Read-Eval-Print Loop 的缩写：读取输入，执行或求值，输出结果，然后回到下一次读取。

Claude Code 的“Eval”不是 JavaScript 解释器执行一段表达式，而是把输入送入 Agent 查询循环。一次输入可能触发模型流、工具调用、权限确认、`tool_result` 回传和再次推理；“Print”也不只是打印最终答案，还要持续展示 thinking、工具进度、错误、通知与弹窗。完成这一轮后，输入框仍然存在，用户可以继续下一轮。

因此，这里的 REPL 更准确的模型是“长生命周期交互宿主”。它持有会话 UI 状态，但不取代 `query()` 和工具系统。

### React 是状态到界面的映射，不只用于浏览器

React 的核心能力不是 HTML，而是组件、状态和 reconciliation（协调更新）。组件声明“给定当前状态，界面应该长什么样”；状态改变时，React 比较新旧组件树，只把必要更新交给 renderer。

浏览器里的 renderer 是 React DOM，最终操作 DOM。Claude Code 使用的是自己的 Ink renderer，最终操作终端屏幕缓冲区。相同的 `useState`、`useEffect`、Context 和组件组合仍然成立，只是 `<Box>`、`<Text>` 不会变成网页节点，而会参与终端布局与字符绘制。

### Ink 是 React 与终端之间的 renderer

Ink 提供类似 Flexbox 的终端组件模型。Claude Code 2.1.88 还包含一套项目内 renderer：React reconciler 先生成 Ink 节点树，Yoga 计算宽高和位置，绘制器生成一帧 `Screen`，再与上一帧比较，把 ANSI 控制序列和文本差量写到终端。

为什么要这样实现？因为这个界面同时有消息列表、流式文本、旋转进度、固定输入区、权限弹窗、窗口缩放和滚动。如果每个模块都直接写 stdout，它们会争夺光标，旧内容也很难准确擦除。React 把复杂性收敛成状态与组件树，Ink 再统一处理布局和屏幕更新。

但代价也很明确：高频 token 流会触发大量状态变化，长对话会放大列表变换和重绘成本。所以源码里会看到 16ms 帧节流、`useMemo`、稳定 key、虚拟列表和进度消息替换。这些不是装饰性的“性能优化”，而是让终端 REPL 能持续工作的组成部分。

## 根组件只在交互模式创建

`restored-src/src/main.tsx` 没有在所有运行模式中都创建 Ink。它先判断当前是不是交互会话，只有交互模式才加载 `createRoot()`：

```tsx
if (!isNonInteractiveSession) {
  const ctx = getRenderContext(false)
  const { createRoot } = await import('./ink.js')
  root = await createRoot(ctx.renderOptions)
  await showSetupScreens(root, permissionMode, /* ... */)
}
```

这段位于 CLI 主入口。`isNonInteractiveSession` 为 `true` 时不会进入分支，因此 print/headless 不会挂载终端 UI；`false` 才创建 Ink root。`ctx.renderOptions` 是渲染宿主参数，源码中的 `RenderOptions` 可提供 `stdout`、`stdin`、`stderr`、`exitOnCtrlC`、`patchConsole` 和 `onFrame`；前三项未提供时分别回退到进程标准流，两个布尔项默认都是 `true`，`onFrame` 可以是回调或 `undefined`。

root 创建之后，`restored-src/src/replLauncher.tsx` 再把共享状态外壳和 REPL 挂进去：

```tsx
export async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>,
): Promise<void> {
  const { App } = await import('./components/App.js')
  const { REPL } = await import('./screens/REPL.js')

  await renderAndRun(root, <App {...appProps}>
    <REPL {...replProps} />
  </App>)
}
```

`launchRepl()` 是交互 UI 的装配函数。`root` 是前面创建的可复用 Ink 根；`appProps` 至少包含 `initialState`，还可带 `stats`（`undefined` 表示没有该 store）和 `getFpsMetrics`；`replProps` 是 REPL 的命令、工具、初始消息、MCP 连接和运行配置；`renderAndRun` 同时负责挂载组件树与等待退出。函数返回 `Promise<void>`，说明退出结果由外层生命周期处理，而不是把 Agent 答案当返回值。

`App` 内部提供 `AppStateProvider`、统计与 FPS Context，`REPL` 则继续维护输入、消息流、弹窗和当前屏幕等高频局部状态。上一篇讲的 AppState 是共享数据平面，并不意味着所有 UI 瞬时状态都必须塞进全局 store。

## REPL 不是一个输入框，而是一棵交互组件树

`restored-src/src/screens/REPL.tsx` 的 `REPL()` 在 2.1.88 中是一个很大的组件。把细节折叠后，它的主要层次可以画成下面这样：

![Claude Code Ink TUI 与 REPL 渲染闭环手绘图](/images/posts/claude-code-source-reading-32/32-ink-tui-repl-handdrawn.png)

图中 `AppStateProvider` 是共享状态屋顶。`REPL` 一侧接键盘和查询流，另一侧把状态投影成 `Messages`、`SpinnerWithVerb`、`PromptInput` 等组件。它们不是各自写终端，而是共同进入同一套 Ink 帧。

源码中的主 JSX 能直接证明这棵树的关键分区：

```tsx
const mainReturn = <KeybindingSetup>
  <GlobalKeybindingHandlers {...globalKeybindingProps} />
  <CommandKeybindingHandlers onSubmit={onSubmit} />
  <CancelRequestHandler {...cancelRequestProps} />
  <MCPConnectionManager>
    <FullscreenLayout
      scrollable={<>
        <Messages
          messages={displayedMessages}
          streamingToolUses={streamingToolUses}
          streamingText={isLoading ? visibleStreamingText : null}
          isLoading={isLoading}
          /* ... */
        />
        {showSpinner && <SpinnerWithVerb mode={streamMode} /* ... */ />}
      </>}
      bottom={<PromptInput
        input={inputValue}
        onInputChange={setInputValue}
        onSubmit={onSubmit}
        isLoading={isLoading}
        /* ... */
      />}
    />
  </MCPConnectionManager>
</KeybindingSetup>
```

这里的 `mainReturn` 是正常 prompt 屏幕的组件树。`FullscreenLayout.scrollable` 放历史消息和进度，`bottom` 放输入与对话框，因此流式内容增长时输入区仍可保持在底部。`Messages.messages` 接收已经选择好的消息投影；`streamingText` 在非加载状态传 `null`；`showSpinner` 是布尔门控；`PromptInput.input` 是当前字符串，`onInputChange` 和 `onSubmit` 分别处理编辑与提交。

源码还定义了 `Screen = 'prompt' | 'transcript'`。`prompt` 是正常交互屏幕，`transcript` 是查看完整记录的模式。除此之外的字符串不属于这个联合类型。REPL 会为 transcript 提前返回另一棵组件树，但两种屏幕仍复用 `Messages`，差别主要在虚拟滚动、搜索、是否展示全部内容，以及输入区是否存在。

这说明 React 的价值不只是“拆组件”。它让屏幕模式、权限弹窗和输入焦点变成状态分支，同一个状态快照只能得到一棵明确的 UI 树。

## 输入先进入 PromptInput，再决定是不是发给 Agent

键盘输入并不会一律进入 `query()`。`PromptInput` 先处理空输入、图片、提示建议、斜杠命令、队友输入和普通 leader prompt。`restored-src/src/components/PromptInput/PromptInput.tsx` 的提交主干如下：

```tsx
const onSubmit = useCallback(async (
  inputParam: string,
  isSubmittingSlashCommand = false,
) => {
  inputParam = inputParam.trimEnd()
  const hasImages = Object.values(pastedContents)
    .some(content => content.type === 'image')

  if (inputParam.trim() === '' && !hasImages) return

  const activeAgent = getActiveAgentForInput(store.getState())
  if (activeAgent.type !== 'leader' && onAgentSubmit) {
    await onAgentSubmit(inputParam, activeAgent.task, {
      setCursorOffset,
      clearBuffer,
      resetHistory,
    })
    return
  }

  await onSubmitProp(inputParam, {
    setCursorOffset,
    clearBuffer,
    resetHistory,
  })
}, [/* ... */])
```

这个局部 `onSubmit()` 是输入路由器。`inputParam` 是开放字符串，来自编辑缓冲区，源码只在这里去掉尾部空白；`isSubmittingSlashCommand` 是布尔值，默认 `false`，它会影响建议列表是否拦截提交；纯空文本且没有图片时直接返回。有活动 subagent/teammate 且 `onAgentSubmit` 已提供时，输入发给该 Agent；否则调用 REPL 传入的 `onSubmitProp`。`onAgentSubmit` 可以是函数或 `undefined`，后者会让分支回落到 leader 提交。

底层按键由项目内 Ink 的 `useInput()` 接收。`restored-src/src/ink/hooks/use-input.ts` 展示了它怎样把终端 raw input 接到 React effect：

```ts
const useInput = (inputHandler: Handler, options: Options = {}) => {
  const { setRawMode, internal_eventEmitter } = useStdin()

  useLayoutEffect(() => {
    if (options.isActive === false) return
    setRawMode(true)
    return () => setRawMode(false)
  }, [options.isActive, setRawMode])

  useEffect(() => {
    internal_eventEmitter?.on('input', handleData)
    return () => internal_eventEmitter?.removeListener('input', handleData)
  }, [internal_eventEmitter, handleData])
}
```

`useInput()` 的 `inputHandler` 接收 `input`、解析后的 `key` 和原始 `InputEvent`；一次粘贴可能把多字符字符串作为一个 `input` 传入。`options.isActive` 可为 `true`、`false` 或 `undefined`：只有显式 `false` 才停用，`undefined` 走默认启用。`internal_eventEmitter` 可以不存在，所以注册和注销都使用可选链。`useLayoutEffect` 在 commit 阶段同步开启 raw mode，卸载或失活时恢复；这样按键不会先被终端自行回显一拍。

快捷键如何在多个监听器之间排序、怎样切换 Vim 状态，不属于这个输入组件的基础职责，下一篇会沿这条线继续。

## 提交以后，查询事件回到 React 状态

普通 prompt 最终进入 REPL 的查询路径。`onQueryImpl()` 准备 system prompt、user context 和 `ToolUseContext`，再消费同一个 `query()` 异步生成器：

```ts
for await (const event of query({
  messages: messagesIncludingNewMessages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool,
  toolUseContext,
  querySource: getQuerySourceForREPL(),
})) {
  onQueryEvent(event)
}
```

`query()` 的这些参数已经在前面章节展开过。对 UI 而言，关键是 `messagesIncludingNewMessages` 包含本轮输入后的会话，`canUseTool` 是权限回调，`querySource` 标记 REPL 来源，生成器每产出一个事件就交给 `onQueryEvent()`。这里没有任何终端绘制调用，因此 query loop 不需要知道当前用的是全屏、普通 scrollback，还是将来另一种宿主。

`onQueryEvent()` 再调用 `handleMessageFromStream()`，把不同事件分流到消息、流式工具、thinking、文本增量和指标状态。最值得注意的是 progress 的处理：

```ts
const onQueryEvent = useCallback((
  event: Parameters<typeof handleMessageFromStream>[0],
) => {
  handleMessageFromStream(event, newMessage => {
    if (
      newMessage.type === 'progress' &&
      isEphemeralToolProgress(newMessage.data.type)
    ) {
      setMessages(oldMessages => {
        const last = oldMessages.at(-1)
        if (
          last?.type === 'progress' &&
          last.parentToolUseID === newMessage.parentToolUseID &&
          last.data.type === newMessage.data.type
        ) {
          const copy = oldMessages.slice()
          copy[copy.length - 1] = newMessage
          return copy
        }
        return [...oldMessages, newMessage]
      })
    } else {
      setMessages(oldMessages => [...oldMessages, newMessage])
    }
  }, /* 省略 content、tool use、thinking 等回调 */)
}, [/* ... */])
```

`onQueryEvent()` 的 `event` 类型来自 `handleMessageFromStream` 的第一个参数，不是任意 UI 字符串。消息回调收到 `newMessage` 后，普通消息追加；只有 `isEphemeralToolProgress()` 认可的临时进度，且最后一条消息的 `parentToolUseID` 与 `data.type` 都相同，才替换末条。Sleep/Bash 这类按秒产生的进度因此不会无限撑大数组。`agent_progress`、`hook_progress`、`skill_progress` 等携带历史语义的进度不走这个替换分支，仍然追加。

这也回答了“工具进度怎么和消息同时显示”：进度首先也是消息流的一部分，但 REPL 会根据它是否临时，决定保存一条最新快照还是完整轨迹；之后 `Messages` 和工具消息组件再通过 `toolUseID` / `parentToolUseID` 把它们关联起来。

## messagesRef 解决执行时序，React state 负责显示

React state 更新会批处理，而查询回调有时需要在同一 tick 里立刻读到最新消息。如果只依赖下一次 render，多个流事件可能都基于旧数组计算。REPL 因此同时维护 `messagesRef` 与 React state：

```ts
const [messages, rawSetMessages] = useState<MessageType[]>(initialMessages ?? [])
const messagesRef = useRef(messages)

const setMessages = useCallback((action: React.SetStateAction<MessageType[]>) => {
  const next = typeof action === 'function'
    ? action(messagesRef.current)
    : action

  messagesRef.current = next
  rawSetMessages(next)
}, [])
```

`messages` 是渲染投影，`messagesRef.current` 是同步可读的最新数组。`initialMessages` 可以是消息数组，也可以是 `undefined`；后者回退为空数组。`action` 支持直接传新数组，也支持函数式 updater。包装函数先用 ref 计算并写回，再调用 `rawSetMessages()` 触发 React render，因此同一事件循环中的下一次写入不会看见旧状态。

这不是把 React 绕开。ref 解决的是命令式执行时序，state 仍然负责让组件树更新。两者如果各自被不同代码随意修改就会产生双重真相，所以源码把写入统一收口到 `setMessages()`。

## token 流和完整消息使用两条显示路径

如果每收到一个字符都把完整消息数组重新规范化、分组并重绘，长会话中的输入延迟会很明显。REPL 对流式文本做了一层单独预览：

```ts
const [streamingText, setStreamingText] = useState<string | null>(null)
const reducedMotion = useAppState(s => s.settings.prefersReducedMotion) ?? false
const showStreamingText = !reducedMotion && !hasCursorUpViewportYankBug()

const visibleStreamingText = streamingText && showStreamingText
  ? streamingText.substring(0, streamingText.lastIndexOf('\n') + 1) || null
  : null
```

`streamingText` 只有字符串或 `null` 两种状态，`null` 表示没有独立预览。`prefersReducedMotion` 如果是 `undefined`，通过 `?? false` 回退为不减少动画；检测到特定终端光标问题时也会关闭预览。`visibleStreamingText` 只显示最后一个换行之前的完整行：还没结束的当前行先留在缓冲区，从而避免字符级抖动。

当完整 assistant message 到达时，消息处理逻辑会清掉流式预览，`Messages` 转而显示正式消息。源码还使用 `useDeferredValue` 让重消息列表在流式阶段可以稍后更新，但在显示 streaming text 或加载结束时切回同步消息，避免 spinner 消失后答案还空一帧。

也就是说，屏幕上的“正在长出来的回答”和 transcript 中的“已落盘消息”不是完全同一份 UI 状态。它们在完成边界上原子切换，最终会合到正式消息模型。

## Messages 先整理语义，再渲染行

`restored-src/src/components/Messages.tsx` 不是简单执行 `messages.map()`。它要规范化 content blocks、过滤不可见 attachment、重排工具消息、合并同类工具组、折叠通知，并为长 transcript 选择虚拟列表：

```tsx
const normalizedMessages = useMemo(
  () => normalizeMessages(messages).filter(isNotEmptyMessage),
  [messages],
)

const { collapsed: collapsed_0, lookups: lookups_0 } = useMemo(() => {
  const messagesToShowNotTruncated = reorderMessagesInUI(
    compactAwareMessages
      .filter(message => message.type !== 'progress')
      .filter(message => !isNullRenderingAttachment(message)),
    syntheticStreamingToolUseMessages,
  )
  const { messages: groupedMessages } = applyGrouping(
    messagesToShowNotTruncated,
    tools,
    verbose,
  )
  const collapsed = collapseBackgroundBashNotifications(
    collapseHookSummaries(
      collapseTeammateShutdowns(
        collapseReadSearchGroups(groupedMessages, tools),
      ),
    ),
    verbose,
  )
  const lookups = buildMessageLookups(
    normalizedMessages,
    messagesToShowNotTruncated,
  )
  return {
    collapsed,
    lookups,
  }
}, [normalizedMessages, syntheticStreamingToolUseMessages, tools, verbose])
```

`normalizeMessages()` 把一条含多个 content block 的消息转换成可渲染单元；`syntheticStreamingToolUseMessages` 把尚未进入正式消息数组的流式 `tool_use` 临时投影出来；`applyGrouping()` 根据 `tools` 和 `verbose` 决定工具组展示；`buildMessageLookups()` 建立 tool use/result/progress 的关联查询。上面只摘录了实际流水线的一部分，完整源码还包含 compact 边界、brief 模式、transcript 截断和多类 collapse。

这些变换被放进 `useMemo()`，依赖不变就复用结果。最终存在 `scrollRef` 且虚拟滚动未被关闭时使用 `VirtualMessageList`，否则有一个非虚拟化安全上限；这避免长会话把全部 React 行同时挂载。。

## React 更新如何变成终端上的几行差量

组件树更新后，Ink 的 `render()` 把业务节点包进终端 App，再交给 `react-reconciler`：

```tsx
render(node: ReactNode): void {
  this.currentNode = node
  const tree = <App
    stdin={this.options.stdin}
    stdout={this.options.stdout}
    stderr={this.options.stderr}
    exitOnCtrlC={this.options.exitOnCtrlC}
    /* ... */
  >
    {node}
  </App>

  reconciler.updateContainerSync(tree, this.container, null, noop)
  reconciler.flushSyncWork()
}
```

这个 `render()` 位于 `restored-src/src/ink/ink.tsx`。`node` 是 REPL React tree；`stdin`、`stdout`、`stderr` 是 Node 流；`exitOnCtrlC` 是布尔值，决定未被应用接管的 Ctrl+C 是否退出。`updateContainerSync()` 更新 reconciler 容器，`flushSyncWork()` 提交这次 React 工作。它处理的是组件树，不等于已经把所有字符写到终端。

真正的帧绘制由 `onRender()` 完成。构造器把它限制在大约一帧 16ms：

```ts
const deferredRender = (): void => queueMicrotask(this.onRender)
this.scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS, {
  leading: true,
  trailing: true,
})

// constants.ts
export const FRAME_INTERVAL_MS = 16
```

`deferredRender` 先进入 microtask，让 React 的 layout effects 完成后再读取光标等布局状态。`throttle()` 的 `leading: true` 让一轮密集更新的首帧立即排入，`trailing: true` 保证期间最后一次状态也会落成帧。`FRAME_INTERVAL_MS` 在该版本静态定义为 `16`，这是节流间隔，不是对真实显示器 FPS 或每帧耗时的承诺。

随后 renderer 生成新 `Screen`，对选择区和搜索高亮做覆盖，与前帧比较，再优化 patch。全屏模式还会固定物理光标并在 resize 后原子清屏重绘；普通稳定帧只比较 damage 区域。最后通过 `writeDiffToTerminal()` 写出差量，而不是每次清空整个终端。

这就是为什么 React 适合这里：业务组件只声明“spinner 现在是什么、消息多了一条、输入内容是什么”，renderer 统一决定哪些终端 cell 真正改变。与此同时，源码中的 damage backstop、全屏锚点和 resize 分支也提醒我们，终端不是 DOM；光标、tmux、选择区和 ANSI 原子性仍需要 renderer 自己处理。

## 一轮交互的完整顺序

把前面的机制按执行顺序收拢，一轮普通输入会经历这些阶段：

1. Ink 的输入层在 raw mode 中收到字符或按键事件，`PromptInput` 更新 `inputValue`。
2. 提交时，`PromptInput.onSubmit()` 先处理空输入、图片、建议、命令与 Agent 路由，再调用 REPL 的 `onSubmit`。
3. REPL 把用户消息加入同步 `messagesRef` 和 React `messages`，准备查询上下文并进入 `query()`。
4. `query()` 持续 yield 事件；`onQueryEvent()` 将它们分成正式消息、流式文本、流式工具、thinking、进度与指标。
5. 临时工具进度在同一 tool call 上替换末条，带历史意义的进度追加；完整 assistant message 到达时接管流式预览。
6. React 根据这些状态重新计算组件树。`Messages` 整理语义关系，`SpinnerWithVerb` 展示当前阶段，`PromptInput` 保持可编辑或切换到弹窗。
7. Ink reconciler 提交节点变化，Yoga 重新布局；16ms 节流后的渲染帧与前帧做 diff，只把必要 patch 写入 stdout。
8. Agent 结束或等待权限时，`isLoading`、队列和 focused dialog 改变，组件树切换；REPL 没有退出，下一轮仍从同一个输入区开始。

这里最重要的边界是：React render 不是重新执行 Agent。React 组件函数会因状态变化再次运行，但真正的网络请求、工具调用和消息持久化由 effect、事件回调与查询内核控制。把副作用放进普通 render 会造成重复执行，所以 REPL 的组件树主要做状态投影，动作集中在 `onSubmit`、`onQueryEvent`、permission callbacks 和 lifecycle effects。

## 小结

Claude Code 的交互式 REPL 可以用一句话概括：**Agent 产生事件，React 保存并投影状态，Ink 把投影变成终端差量。**

REPL 提供长生命周期交互循环；React 让消息、进度、输入、弹窗和屏幕模式由同一份状态决定；Ink 用自定义 reconciler、Yoga、Screen buffer 和 diff 解决终端布局与刷新。流式文本使用独立预览，工具进度区分替换与追加，长消息列表通过 memo、稳定 key、截断和虚拟化控制成本。

源码能够确认这些组件、状态分支和渲染路径，也能确认 16ms 节流与屏幕 diff 的实现。；那些还取决于消息规模、终端模拟器、tmux、窗口尺寸与运行时开关。

## 留给下一篇的问题

REPL 能显示与接收输入以后，Claude Code 如何解析按键、管理快捷键上下文，并实现 Vim 的 normal、insert 与 operator-pending 状态？

