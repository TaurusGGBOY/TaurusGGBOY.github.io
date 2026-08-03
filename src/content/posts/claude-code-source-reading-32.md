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

答案先说：交互模式把 `AppStateProvider → REPL` 挂成 React 组件树；用户输入经 `PromptInput` 提交给 `query()`，模型事件由 `onQueryEvent()` 转换成 `messages`、`streamingText`、`streamingToolUses` 等状态；React 根据新状态计算消息、进度、弹窗和输入区，最后由项目内的 Ink renderer 完成 Yoga 布局、屏幕缓冲区绘制与前后帧 diff，只把变化写到 `stdout`。

这条渲染闭环是：

`键盘 → React 状态 → query 事件 → React 状态 → Ink 帧 → 终端`。

这条链中，Agent 内核产生事件，React 声明当前界面，Ink 再把声明翻译成终端控制序列。三层分工使用户输入、模型流和工具进度共享同一界面，同时保持执行与渲染解耦。

本篇继续以 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码为边界。下文代码块都来自 `restored-src/`；为了突出主链，省略了与当前结论无关的参数和分支，不把整理后的伪代码冒充完整源码。

## 问题现场

终端 UI 同时要接收键盘、模型 token、工具进度、权限弹窗和窗口 resize。若每个回调直接写 `stdout`，光标和旧屏幕内容很快失去所有权；真正需要的是一棵能持续更新、又能控制差量刷新的组件树。

![Ink TUI 从流式事件到终端帧差](/images/posts/claude-code-source-reading-32/32-terminal-render-loop-detail-handdrawn.png)

本文沿着一轮交互追踪 `PromptInput → query() → onQueryEvent() → React state → Ink renderer`，重点看流式预览为什么和稳定消息列表分开，以及帧差如何最终写入终端。

## 先补三个概念：REPL、React 和 Ink

`REPL.tsx` 的重点不是终端打印函数，而是把输入、查询事件和屏幕输出放进同一棵组件树。React 保存可渲染快照，Ink renderer 才负责把树变成终端行；执行副作用仍在 `query()`、回调和 effect 中。

### REPL 是一轮轮持续运行的交互循环

REPL 仍是 Read–Eval–Print Loop：`PromptInput` 读取输入，`query()` 可能多次模型推理与工具调用，事件回调更新显示，完成后输入区继续承接下一轮。它持有 UI 生命周期，却不取代 query loop、工具权限或 transcript 持久化。

### React 是状态到界面的映射，不只用于浏览器

React 在这里把状态映射为组件树并做 reconciliation；它不关心输出是 DOM 还是终端。组件声明当前消息、进度和输入应呈现什么，renderer 再决定如何落到屏幕。

浏览器里的 renderer 是 React DOM，最终操作 DOM。Claude Code 使用的是自己的 Ink renderer，最终操作终端屏幕缓冲区。相同的 `useState`、`useEffect`、Context 和组件组合仍然成立，只是 `<Box>`、`<Text>` 不会变成网页节点，而会参与终端布局与字符绘制。

### Ink 是 React 与终端之间的 renderer

Ink 提供类似 Flexbox 的终端组件模型。Claude Code 2.1.88 还包含一套项目内 renderer：React reconciler 先生成 Ink 节点树，Yoga 计算宽高和位置，绘制器生成一帧 `Screen`，再与上一帧比较，把 ANSI 控制序列和文本差量写到终端。

为什么要这样实现？因为这个界面同时有消息列表、流式文本、旋转进度、固定输入区、权限弹窗、窗口缩放和滚动。如果每个模块都直接写 stdout，它们会争夺光标，旧内容也很难准确擦除。React 把复杂性收敛成状态与组件树，Ink 再统一处理布局和屏幕更新。

高频 token 流会触发大量状态变化，长对话还会放大列表变换和重绘成本。因此源码使用 16ms 帧节流、`useMemo`、稳定 key、虚拟列表和进度消息替换，让终端 REPL 在持续输出时控制刷新成本。

## 根组件只在交互模式创建

`restored-src/src/main.tsx` 先判断运行模式；交互会话才加载 Ink 的 `createRoot()`：

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

`launchRepl()` 是交互 UI 的装配函数。`root` 是前面创建的可复用 Ink 根；`appProps.initialState` 提供共享状态起点，`stats` 存在时挂载统计 store，省略时跳过这层统计，`getFpsMetrics` 提供可选帧指标；`replProps` 承载命令、工具、初始消息、MCP 连接和运行配置；`renderAndRun` 同时负责挂载组件树与等待退出。函数返回 `Promise<void>`，退出结果交由外层生命周期处理。

`App` 内部提供 `AppStateProvider`、统计与 FPS Context，`REPL` 则继续维护输入、消息流、弹窗和当前屏幕等高频局部状态。上一篇讲的 AppState 是共享数据平面，并不意味着所有 UI 瞬时状态都必须塞进全局 store。

## REPL 用一棵组件树组织交互

`restored-src/src/screens/REPL.tsx` 的 `REPL()` 在 2.1.88 中是一个很大的组件。把细节折叠后，它的主要层次可以画成下面这样：

![Claude Code Ink TUI 与 REPL 渲染闭环手绘图](/images/posts/claude-code-source-reading-32/32-ink-tui-repl-handdrawn.png)

图中 `AppStateProvider` 是共享状态屋顶。`REPL` 一侧接键盘和查询流，另一侧把状态投影成 `Messages`、`SpinnerWithVerb`、`PromptInput` 等组件，最后共同进入同一套 Ink 帧。

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

React 同时承担组件拆分和状态投影：屏幕模式、权限弹窗和输入焦点都成为状态分支，同一个状态快照只产生一棵明确的 UI 树。

## 输入先进入 PromptInput，再选择提交目标

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

这个局部 `onSubmit()` 是输入路由器。`inputParam` 是开放字符串，来自编辑缓冲区，源码只在这里去掉尾部空白；`isSubmittingSlashCommand` 是布尔值，默认 `false`，它会影响建议列表是否拦截提交；纯空文本且图片数组为空时直接返回。有活动 subagent/teammate 且 `onAgentSubmit` 已提供时，输入发给该 Agent；否则调用 REPL 传入的 `onSubmitProp`。`onAgentSubmit` 可以是函数或 `undefined`，后者会让分支回落到 leader 提交。

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

`query()` 的这些参数已经在前面章节展开过。对 UI 而言，关键是 `messagesIncludingNewMessages` 包含本轮输入后的会话，`canUseTool` 是权限回调，`querySource` 标记 REPL 来源，生成器每产出一个事件就交给 `onQueryEvent()`。终端绘制留在宿主层，因此 query loop 可以同时服务全屏、普通 scrollback 和其他宿主。

`onQueryEvent()` 再调用 `handleMessageFromStream()`，把不同事件分流到消息、流式工具、thinking、文本增量和指标状态。progress 的处理点是：

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

`onQueryEvent()` 的 `event` 类型来自 `handleMessageFromStream` 的第一个参数，候选集合由流处理器定义。消息回调收到 `newMessage` 后，普通消息追加；只有 `isEphemeralToolProgress()` 认可的临时进度，且最后一条消息的 `parentToolUseID` 与 `data.type` 都相同，才替换末条。Sleep/Bash 这类按秒产生的进度因此会稳定占用一个末尾槽位。`agent_progress`、`hook_progress`、`skill_progress` 等携带历史语义的进度绕过替换分支，仍然追加。

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

ref 解决命令式执行时序，state 负责让组件树更新。为防止两条写入路径产生双重真相，源码把消息写入统一收口到 `setMessages()`。

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

`streamingText` 为字符串时进入独立预览，为 `null` 时 `visibleStreamingText` 直接变成 `null`，`Messages` 只渲染正式消息。`prefersReducedMotion` 省略时通过 `?? false` 启用正常动画；显式为 `true` 或检测到特定终端光标问题时关闭预览。`visibleStreamingText` 只显示最后一个换行之前的完整行：尚未结束的当前行留在缓冲区，从而避免字符级抖动。

当完整 assistant message 到达时，消息处理逻辑会清掉流式预览，`Messages` 转而显示正式消息。源码还使用 `useDeferredValue` 让重消息列表在流式阶段可以稍后更新，但在显示 streaming text 或加载结束时切回同步消息，避免 spinner 消失后答案还空一帧。

屏幕上的流式回答和 transcript 中的已落盘消息处于两个阶段：前者暂存在流式状态，完成边界上再原子切换到正式消息模型。

## Messages 先整理语义，再渲染行

`restored-src/src/components/Messages.tsx` 在遍历前先规范化 content blocks、过滤不可见 attachment、重排工具消息、合并同类工具组、折叠通知，并为长 transcript 选择虚拟列表：

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

`normalizedMessages` 是规范化并过滤空项后的基础序列；`compactAwareMessages` 已处理压缩边界；`messagesToShowNotTruncated` 移除临时 progress 和空渲染 attachment，并加入 `syntheticStreamingToolUseMessages` 这类尚未落入正式数组的流式 `tool_use`。`applyGrouping()` 根据 `tools` 和 `verbose` 生成 `groupedMessages`，多层 collapse 得到最终 `collapsed`；`buildMessageLookups()` 同时使用规范化序列与展示序列，建立 tool use/result/progress 的关联查询。上面只摘录了实际流水线的一部分，完整源码还包含 brief 模式和 transcript 截断。

这些变换被放进 `useMemo()`，依赖不变就复用结果。最终存在 `scrollRef` 且虚拟滚动未被关闭时使用 `VirtualMessageList`，否则有一个非虚拟化安全上限；这避免长会话把全部 React 行同时挂载。

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

这个 `render()` 位于 `restored-src/src/ink/ink.tsx`。`node` 是 REPL React tree；`stdin`、`stdout`、`stderr` 是 Node 流；`exitOnCtrlC` 是布尔值，决定未被应用接管的 Ctrl+C 是否退出。`updateContainerSync()` 更新 reconciler 容器，`flushSyncWork()` 提交这次 React 工作；字符写出随后由终端 renderer 完成。

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

`deferredRender` 先进入 microtask，让 React 的 layout effects 完成后再读取光标等布局状态。`throttle()` 的 `leading: true` 让一轮密集更新的首帧立即排入，`trailing: true` 保证期间最后一次状态也会落成帧。`FRAME_INTERVAL_MS` 在该版本静态定义为 `16`，该值只约束调度间隔；真实显示器 FPS 和单帧耗时取决于运行环境。

随后 renderer 生成新 `Screen`，对选择区和搜索高亮做覆盖，与前帧比较，再优化 patch。全屏模式还会固定物理光标并在 resize 后原子清屏重绘；普通稳定帧只比较 damage 区域。最后通过 `writeDiffToTerminal()` 写出差量，保留终端中未变化的区域。

业务组件只声明“spinner 现在是什么、消息多了一条、输入内容是什么”，renderer 统一决定哪些终端 cell 真正改变。终端的光标、tmux、选择区和 ANSI 原子性则由 damage backstop、全屏锚点和 resize 分支专门处理。

## 一轮交互的完整顺序

把前面的机制按执行顺序收拢，一轮普通输入会经历这些阶段：

1. Ink 的输入层在 raw mode 中收到字符或按键事件，`PromptInput` 更新 `inputValue`。
2. 提交时，`PromptInput.onSubmit()` 先处理空输入、图片、建议、命令与 Agent 路由，再调用 REPL 的 `onSubmit`。
3. REPL 把用户消息加入同步 `messagesRef` 和 React `messages`，准备查询上下文并进入 `query()`。
4. `query()` 持续 yield 事件；`onQueryEvent()` 将它们分成正式消息、流式文本、流式工具、thinking、进度与指标。
5. 临时工具进度在同一 tool call 上替换末条，带历史意义的进度追加；完整 assistant message 到达时接管流式预览。
6. React 根据这些状态重新计算组件树。`Messages` 整理语义关系，`SpinnerWithVerb` 展示当前阶段，`PromptInput` 保持可编辑或切换到弹窗。
7. Ink reconciler 提交节点变化，Yoga 重新布局；16ms 节流后的渲染帧与前帧做 diff，只把必要 patch 写入 stdout。
8. Agent 结束或等待权限时，`isLoading`、队列和 focused dialog 改变，组件树切换；REPL 保持挂载，下一轮仍从同一个输入区开始。

这里最重要的边界是：React render 只重新计算 UI 树。网络请求、工具调用和消息持久化由 effect、事件回调与查询内核控制；REPL 把动作集中在 `onSubmit`、`onQueryEvent`、permission callbacks 和 lifecycle effects，避免普通 render 重复触发副作用。

## 小结

Claude Code 的交互式 REPL 可以用一句话概括：**Agent 产生事件，React 保存并投影状态，Ink 把投影变成终端差量。**

REPL 提供长生命周期交互循环；React 让消息、进度、输入、弹窗和屏幕模式由同一份状态决定；Ink 用自定义 reconciler、Yoga、Screen buffer 和 diff 解决终端布局与刷新。流式文本使用独立预览，工具进度区分替换与追加，长消息列表通过 memo、稳定 key、截断和虚拟化控制成本。

源码能够确认这些组件、状态分支、16ms 节流与屏幕 diff；实际帧率和交互延迟还取决于消息规模、终端模拟器、tmux、窗口尺寸与运行时开关。

## 留给下一篇的问题

Claude Code 当前以 16ms 为渲染节流间隔，用户能否把它调成 120Hz（约 8.33ms）？

## 参考资料

- [Claude Code Interactive Mode](https://code.claude.com/docs/en/interactive-mode)

- [Claude Code Terminal Configuration](https://code.claude.com/docs/en/terminal-config)
