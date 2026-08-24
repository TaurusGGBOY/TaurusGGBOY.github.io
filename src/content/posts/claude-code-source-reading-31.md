---
title: "Claude Code源码解读31：共享状态如何贯穿整个系统"
published: 2026-07-24T16:47:18+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-31/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇最后留下的问题是，**没有开启 Chrome 调试模式时，Claude Code 还能使用 Chrome MCP 吗？**

答案先放在前面，**能，但要先区分 `claude-in-chrome` 和单独的 `chrome-devtools-mcp`。**2.1.88 随 Claude Code 提供的 `claude-in-chrome` 走“浏览器扩展 + Native Messaging/Bridge”这条链路，不把 `--remote-debugging-port` 或 DevTools Protocol 端口作为前置条件。只有当你配置的是另一个直接连接 CDP 的 Chrome DevTools MCP，才需要按那个 server 的连接方式开启远程调试。

## 介绍本章的一些概念

- `AppState` 是**运行时共享数据平面**，任务、权限、MCP、文件历史与跨组件 UI 状态汇入同一张快照，但流式消息、bootstrap globals、缓存与 transcript 保留各自边界，AppState 只收纳"必须被多个消费者以同一引用观察"的状态。
- `createStore()` 是不到 40 行的最小更新协议，**函数式 updater + 顶层 `Object.is` 引用判定 + 同步 listener**，不分发 action，没有中间件；返回旧引用就是明确 no-op。
- `AppStateProvider` 只向 Context 放**创建一次的稳定 store**，持续变化的快照留在 external store，组件用 `useSyncExternalStore` + selector 订阅切片；Provider 显式禁止嵌套。
- 任务更新通过结构共享把刷新限制在字段边界，`updateTaskState()` 只重建 AppState、tasks 表和单任务三层引用，`s => s.mcp` 等其他订阅者不会重渲染。
- `onChangeAppState` 集中比较新旧快照，但**只持久化或外部化源码明确列出的字段**（权限模式、verbose、mainLoopModel、expandedView 等）；`tasks`、`mcp` 中的函数与运行时对象只能在本进程存活，跨进程恢复只映射可序列化 metadata。

> ⚠️ **证据边界**，本文所有代码来自 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` source map 还原源码。`restored-src/` 只用于定位证据，不等同于 Anthropic 内部仓库原始目录；代码块只保留证明控制流所需的字段，`// ...` 表示省略埋点、UI 消息与无关分支。

## 本篇新增机制

07 解释了消息模型如何承载对话内容，06 解释了 queryLoop 如何推进 Agent 循环。本篇回答这些执行结果**如何被 UI、权限对话框、状态栏与远程控制页共同观察**，共享状态存哪里、怎样更新、谁决定重新渲染、哪些字段会同步出进程。它是 32（Ink TUI 与 REPL）的必备前提，REPL 的所有高频局部状态都挂在 AppState 这层屋顶之下，先看清 store 与 selector 的边界，才能理解组件为什么那样订阅。

## 问题现场

流式消息、权限弹窗、后台任务和外部 MCP 事件会同时改状态。若 React、工具和非 UI 代码各自保存一份副本，终端显示与执行内核迟早出现分叉；若所有数据都塞进 Context，又会让每个小变化触发整棵树刷新。

![AppState 更新、Selector 与结构共享](/images/posts/claude-code-source-reading-31/31-state-selectors-detail-handdrawn.png)

本文追踪 `createStore()`、`AppStateProvider` 和 selector 的分工，store 负责单一更新入口，Provider 暴露稳定引用，消费者只订阅自己需要的切片。

## 正文

### 这张金额单位工单同时改变了哪些共享状态

工程师在终端里继续处理工单时，输入了一句看起来简单、却会同时启动多条状态变化的要求，

> 集成测试放到后台；出现权限询问时停下来等我，teammate 有结果就通知我；我还要能从远程控制页面看到当前进度。

随后，后台测试从 `pending` 进入 `running`，权限请求出现在待处理队列，issue-tracker MCP 保持连接，三个 teammate 的结论经 mailbox 到达，输入框还保留着工程师尚未提交的补充。终端 spinner、远程控制页面和执行内核必须看到同一组事实；如果某个 React 组件单独保存"测试已完成"，就可能出现界面显示绿色而模型仍在等待结果的分叉。

系统同时变化的有 Task 状态、权限请求、MCP 连接、Mailbox、输入队列和 spinner。AppState 保存跨模块必须共享的事实，UI 只订阅自己需要的切片；后台任务、工具和远程控制不会直接依赖某个 React 组件。

AppState 的调用链是 `setAppState(updater) → createStore.setState() → synchronous listeners → selector snapshot → React render`。Context 只提供稳定 store 引用；真正变化的快照留在 external store，`useSyncExternalStore` 再让组件订阅。selector 取出的切片若保持同一引用，任务更新不会把整个消息列表一起刷新。

![Claude Code AppState 的更新、订阅与持久化边界](/images/posts/claude-code-source-reading-31/31-app-state-architecture-handdrawn.png)

图中的上下两条边界分别表示 UI 通知与磁盘持久化；进程内数据也按共享范围决定是否进入 AppState。

### 第一层｜AppState 把五类共享状态放在同一张数据平面上

`restored-src/src/state/AppStateStore.ts` 的类型虽然很大，字段仍可归入五条主线，会话设置、权限、动态工具、任务状态和 UI 协调状态。

```ts
export type AppState = DeepImmutable<{
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  statusLineText: string | undefined
  expandedView: 'none' | 'tasks' | 'teammates'
  footerSelection: FooterItem | null
  toolPermissionContext: ToolPermissionContext
  // ...省略其他普通共享字段
}> & {
  tasks: { [taskId: string]: TaskState }
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    pluginReconnectKey: number
  }
  fileHistory: FileHistoryState
  notifications: {
    current: Notification | null
    queue: Notification[]
  }
  activeOverlays: ReadonlySet<string>
  // ...省略其他含运行时对象的字段
}
```

> 证据，`restored-src/src/state/AppStateStore.ts`（2.1.88 source map 还原源码），AppState 类型定义。

`AppState` 在编译期描述状态形状。`DeepImmutable` 要求调用方通过创建新引用来更新普通字段；后面的交叉类型特意把 `tasks`、`mcp` 等排除在深只读包装之外，因为 `TaskState` 中存在函数类型，MCP tool 也包含运行时行为。这些进程内对象决定了跨进程序列化必须经过显式映射。

几个字段的可选值直接决定控制流，`expandedView` 只有 `'none'`、`'tasks'`、`'teammates'`，分别选择收起、任务视图和 teammate 视图；`footerSelection` 为 `FooterItem` 时把键盘焦点路由到对应 footer pill，为 `null` 时跳过 footer 选中态；`statusLineText` 提供字符串时渲染自定义状态行，值为 `undefined` 时消费者走默认状态行路径。`mcp.clients/tools/commands/resources` 分别承载连接、工具、命令和资源快照，`pluginReconnectKey` 递增时触发插件连接侧重新装配；`notifications.current` 是当前显示项，`queue` 保存后续候选。

其余字段按消费者紧凑分组，`settings` 与 `mainLoopModel` 供查询和配置层读取，`verbose` 控制详细展示，`toolPermissionContext` 把权限模式与规则送入工具执行链；`tasks` 以开放字符串 `taskId` 为键保存可被任务面板观察的运行对象，`fileHistory` 服务文件快照与回滚，`activeOverlays` 用字符串集合协调当前覆盖层。`tasks`、`mcp` 和 `activeOverlays` 都含进程内结构，跨进程时必须投影为协议字段。

为什么把这些字段放在一起？因为它们存在跨边界消费者，任务执行器写 `tasks`，Spinner 和 TaskPanel 读它；MCP 管理器写连接与工具，REPL、设置页和 Agent 定义装配读它；权限对话框和 query 上下文共同读取 `toolPermissionContext`；footer 焦点则要被不在 PromptInput 子树里的组件读取。对话消息主要由 REPL 自己生产、排序和渲染，作用域停留在消息组件链；AppState 则承载需要被执行器、状态栏和对话框共同观察的状态。

### 第二层｜默认状态把缺省值写死，也保留运行时分支

`getDefaultAppState()` 给独立对话框、headless store 和普通 Provider 创建可用起点。每次调用都会根据当前进程是否为要求 plan mode 的 teammate 计算初始权限模式。

```ts
export function getDefaultAppState(): AppState {
  const initialMode: PermissionMode =
    teammateUtils.isTeammate() && teammateUtils.isPlanModeRequired()
      ? 'plan'
      : 'default'

  return {
    settings: getInitialSettings(),
    tasks: {},
    agentNameRegistry: new Map(),
    verbose: false,
    mainLoopModel: null,
    statusLineText: undefined,
    expandedView: 'none',
    footerSelection: null,
    remoteConnectionStatus: 'connecting',
    // ...省略 bridge、插件等默认字段
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: initialMode,
    },
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    notifications: { current: null, queue: [] },
    // ...省略其他空队列与功能默认值
    activeOverlays: new Set<string>(),
    fastMode: false,
  }
}
```

> 证据，`restored-src/src/state/AppStateStore.ts`（2.1.88 source map 还原源码），`getDefaultAppState()`。

`getDefaultAppState()` 接受零个参数并返回一份新的 `AppState`。`initialMode` 在两个布尔条件都为真时取 `'plan'`，否则回退 `'default'`；PermissionMode 的完整枚举由权限模块定义。`mainLoopModel: null` 让后续模型选择逻辑采用默认模型；`remoteConnectionStatus` 还允许 `'connected'`、`'reconnecting'`、`'disconnected'`，默认从 `'connecting'` 开始。

默认容器对应明确的初始行为，`settings` 来自 `getInitialSettings()`；`tasks`、`mcp.clients`、`mcp.tools`、`mcp.commands` 从空数组或对象开始，`mcp.resources` 初始化为空映射；`notifications.current: null` 表示当前展示项为空，`queue: []` 表示待显示队列为空。`agentNameRegistry` 与 `activeOverlays` 分别创建新的 `Map`、`Set`；`verbose`、`fastMode` 均为 `false`，`expandedView: 'none'`、`footerSelection: null`、`statusLineText: undefined` 让 UI 从收起且无额外选择的状态启动。

数组、对象、`Map` 和 `Set` 都在函数调用时重新创建，避免不同 Provider 意外共享可变容器。普通交互入口随后用启动参数、全局配置、已解析权限、Agent 定义和初始通知覆盖这份模板，每个会话最终得到自己的启动快照。

### 第三层｜store 不分发 action，只接受函数式 updater

真正的状态容器位于 `restored-src/src/state/store.ts`。它不到四十行，

```ts
export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,
    setState: updater => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

> 证据，`restored-src/src/state/store.ts`（2.1.88 source map 还原源码），`createStore()` 完整实现。

`createStore<T>(initialState, onChange?)` 有两个参数。`initialState` 是任意泛型 `T` 的初始引用；传入 `onChange` 时，每次有效写入都会携带前后快照调用它，省略时状态仍会写入并通知订阅者，只跳过这项外部副作用。返回的 `Store<T>` 只有三个方法。

`setState(updater)` 的参数必须是 `(prev: T) => T`，调用方拿到最新 `prev`，返回 `next`。状态变化直接由函数 updater 表达，变更来源需要沿各个 `setState` 调用点追踪。

`Object.is(next, prev)` 是这里唯一的顶层变更判定。如果 updater 返回原引用，更新被视为 no-op，不替换 state，不执行 `onChange`，也不通知 listener。返回新对象后，顺序固定为"写入 state → 调用 onChange → 遍历 listeners"。这保证订阅者醒来时 `getState()` 已经能读到新值。

`subscribe(listener)` 接受无参数回调，把它放进 `Set`，再返回 unsubscribe 函数。相同 listener 引用不会在 `Set` 中重复；取消订阅时 `delete` 返回布尔值，但外层函数不使用该值。

这也解释了为什么更新必须保留结构共享。直接修改 `prev.tasks[id]` 再返回 `prev`，store 会把它判断为无变化；正确做法是为发生变化的层级创建新引用。

### 第四层｜Provider 只提供稳定 store，不把整棵树绑在 state 上

`AppStateProvider` 使用 React Context，并把只创建一次的 store 放进 Context；持续变化的 AppState 留在 store 内部。

```tsx
type Props = {
  children: React.ReactNode
  initialState?: AppState
  onChangeAppState?: (args: {
    newState: AppState
    oldState: AppState
  }) => void
}

export function AppStateProvider({
  children,
  initialState,
  onChangeAppState,
}: Props) {
  const hasAppStateContext = useContext(HasAppStateContext)
  if (hasAppStateContext) {
    throw new Error(
      'AppStateProvider can not be nested within another AppStateProvider',
    )
  }

  const [store] = useState(() =>
    createStore(initialState ?? getDefaultAppState(), onChangeAppState),
  )

  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        <MailboxProvider>
          <VoiceProvider>{children}</VoiceProvider>
        </MailboxProvider>
      </AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  )
}
```

> 证据，`restored-src/src/state/AppStateProvider.tsx`（2.1.88 source map 还原源码）。

`AppStateProvider(props)` 接收三个字段。`children` 必填；`initialState` 传入完整对象时直接采用该引用，省略时调用 `getDefaultAppState()`；传入 `onChangeAppState` 会启用集中 diff hook，省略后 store 仍照常写入和通知。回调参数里的 `newState` 是本次提交后的完整快照，`oldState` 是提交前快照，两者构成字段级 diff 的输入。表达式使用 `??`，所以越过类型系统传入的 `null` 也会落到默认状态。

`useState` 的惰性初始化器只在挂载时创建 store。后续 props 引用改变不会把现有 store 换掉，这是 Context value 保持稳定的关键。Provider 还显式禁止嵌套；否则内外两份同名共享状态会让"组件到底读哪一份"变得依赖树位置。

`MailboxProvider` 和按构建特性存在的 `VoiceProvider` 使用独立 context。它们位于 store provider 内部，可以消费 AppState，同时维护各自的订阅与生命周期。Provider 还会监听 settings 文件变化，并调用 `applySettingsChange(source, store.setState)`。`source` 是 `SettingSource`，候选来自 settings 常量模块；静态片段不能把运行时可能触发的来源简化成单一 user 配置。该更新会重新读取 settings、权限规则和 hooks，再通过同一个 `setState` 写回，因此交互式 UI 与 headless 路径可以复用更新规则。

### 第五层｜selector 决定谁需要重新渲染

`useAppState()` 把这个外部 store 接进 React，

```ts
export function useAppState<T>(
  selector: (state: AppState) => T,
): T {
  const store = useAppStore()
  const get = () => {
    const state = store.getState()
    return selector(state)
  }
  return useSyncExternalStore(store.subscribe, get, get)
}

export function useSetAppState() {
  return useAppStore().setState
}

export function useAppStateStore() {
  return useAppStore()
}
```

> 证据，`restored-src/src/state/useAppState.ts`（2.1.88 source map 还原源码）。

`useAppState(selector)` 的 `selector` 必须是从完整 `AppState` 到任意 `T` 的函数。React 用 `Object.is` 比较前后 snapshot；选中原有字段或子对象引用时，只有那部分引用变化才重渲染。若 selector 每次都创建 `{ a: state.a }` 这样的新对象，即使 `a` 没变，引用也总是不同，优化就失效。源码注释因此建议多个独立字段调用多次 hook。

传给 `useSyncExternalStore` 的第二、第三个参数都是 `get`，客户端 snapshot 与 server snapshot 使用同一读取方式。`useAppStore()` 在 Provider 外调用会抛 `ReferenceError`；`useAppStateMaybeOutsideOfProvider(selector)` 遇到缺失的 store 时使用空订阅并返回 `undefined`。两个 API 分别服务"必须存在"和"允许缺席"的组件。

`useSetAppState()` 接受零个参数，只返回稳定的 `setState` 引用；只负责写入的组件因此避开 AppState 变化触发的重渲染。`useAppStateStore()` 同样接受零个参数，返回完整 store，主要用于把 `getState/setState` 交给非 React 代码；组件读取状态仍应通过 selector 控制订阅范围。

在 REPL 中，订阅就是按切片展开的，

```tsx
const toolPermissionContext = useAppState(s => s.toolPermissionContext)
const mcp = useAppState(s => s.mcp)
const fileHistory = useAppState(s => s.fileHistory)
const tasks = useAppState(s => s.tasks)
const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)

// ...省略中间的 REPL hooks
const [messages, rawSetMessages] =
  useState<MessageType[]>(initialMessages ?? [])
```

> 证据，`restored-src/src/screens/REPL.tsx`（2.1.88 source map 还原源码），REPL 的 selector 订阅。

这些 `useAppState` 调用都要求传入 selector。`toolPermissionContext`、`mcp`、`fileHistory` 和 `tasks` 分别使权限 UI、连接视图、文件回滚界面和任务面板只跟随对应子树；`viewingAgentTaskId` 为字符串时切到该任务视图，省略时保留 leader 主视图。`messages` 使用 `initialMessages ?? []` 初始化，传入数组时复用该历史，`null` 或 `undefined` 时从空消息列表开始；消息更新走 REPL 自己的状态链，绕过 `onChangeAppState`。

这个边界由更新频率与共享范围决定。流式消息频繁增长，主要由 REPL 与消息组件消费；进入大 store 会让所有误订阅 `state` 的调用点承担高频 snapshot 变化。任务、权限与 MCP 同时被执行器、状态栏、对话框和工具装配读取，更适合共享。

### 第六层｜任务更新展示了结构共享怎样降低无关刷新

任务运行时不需要知道 React。它只接收 `setAppState`，用一个小函数更新指定任务，

```ts
export function updateTaskState<T extends TaskState>(
  taskId: string,
  setAppState: SetAppState,
  updater: (task: T) => T,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId] as T | undefined
    if (!task) return prev

    const updated = updater(task)
    if (updated === task) return prev

    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: updated,
      },
    }
  })
}
```

> 证据，`restored-src/src/state/updateTaskState.ts`（2.1.88 source map 还原源码）。

`updateTaskState(taskId, setAppState, updater)` 有三个参数。`taskId` 是开放字符串，来自已经注册的任务；找不到对应任务时 `task` 为 `undefined`，函数返回原 `prev`，整次更新成为 no-op。`setAppState` 是 store 的函数式更新入口；`updater` 接收类型为 `T` 的现有任务，返回同类型任务。

若任务 updater 返回原引用，外层同样返回 `prev`，`s => s.tasks` 的订阅者不会刷新。只有任务真的改变时，代码才同时创建新 AppState、新 tasks 表和新的单任务引用。其他字段继续复用旧引用，因此 `s => s.mcp`、`s => s.toolPermissionContext` 的 snapshot 不变。

渲染范围由两层机制共同控制，每个领域函数负责自己的不可变更新和 no-op 判定，store 负责最后一道顶层引用判定。

边界也要说清楚。`tasks` 中的 `TaskState` 可能包含函数和进程内对象，所以 AppState 类型把这一部分留在 `DeepImmutable` 之外。AppState 对 UI 暴露任务生命周期；跨进程传输则必须另行提取可序列化字段。

### 第七层｜onChangeAppState 按字段输出 diff

每次有效 `setState` 都会把 `newState` 和 `oldState` 交给 `onChangeAppState()`。这个入口逐项检查需要同步的字段，并把各类持久化交给专门出口。

```ts
export function onChangeAppState({ newState, oldState }: {
  newState: AppState
  oldState: AppState
}) {
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode:
          newExternal === 'plan' &&
          newState.isUltraplanMode &&
          !oldState.isUltraplanMode
            ? true
            : null,
      })
    }
    notifyPermissionModeChanged(newMode)
  }

  if (
    newState.verbose !== oldState.verbose &&
    getGlobalConfig().verbose !== newState.verbose
  ) {
    const verbose = newState.verbose
    saveGlobalConfig(current => ({
      ...current,
      verbose,
    }))
  }
}
```

> 证据，`restored-src/src/state/onChangeAppState.ts`（2.1.88 source map 还原源码），节选权限与 verbose 分支。

`onChangeAppState({ newState, oldState })` 接收一个对象参数，两个字段都必需且都是完整 AppState。它自己不返回新状态，职责是观察变化并触发明确副作用。

权限模式变化时，内部 mode 先经过 `toExternalPermissionMode()` 映射。只有外部值也发生变化，才把 `permission_mode` 写成 `newExternal` 并更新 CCR session metadata；SDK 的权限模式通知则仍拿到内部 `newMode`，由 SDK 监听端再过滤。`is_ultraplan_mode` 只有首次进入符合条件的 plan 状态时为 `true`，其余情况传 `null`；源码注释明确 `null` 按 RFC 7396 删除 metadata key，`false` 则会保留 key 并写入布尔值。

完整函数还对 `mainLoopModel`、`expandedView`、`verbose` 和内部构建的 `tungstenPanelVisible` 做定向持久化。`mainLoopModel === null` 时从 user settings 移除 model 并清空 override，非 `null` 时写入具体模型；`expandedView` 被兼容映射成 `showExpandedTodos` 与 `showSpinnerTree` 两个布尔配置。`settings` 引用变化则清理认证缓存，并在 `settings.env` 引用变化时重新应用环境变量。`tasks`、`mcp`、`notifications`、`activeOverlays` 更新时会刷新 listener；任务输出、session transcript、配置文件和远端 metadata 则分别由专门机制持久化。

### 第八层｜恢复也只把可外部化字段映射回来

远程 worker 恢复时，源码提供了从 session external metadata 到 updater 的反向转换，

```ts
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return prev => ({
    ...prev,
    ...(typeof metadata.permission_mode === 'string'
      ? {
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: permissionModeFromString(metadata.permission_mode),
          },
        }
      : {}),
    ...(typeof metadata.is_ultraplan_mode === 'boolean'
      ? { isUltraplanMode: metadata.is_ultraplan_mode }
      : {}),
  })
}
```

> 证据，`restored-src/src/state/externalMetadataToAppState.ts`（2.1.88 source map 还原源码）。

`externalMetadataToAppState(metadata)` 接收 `SessionExternalMetadata`，返回一个可直接交给 `setState` 的 updater。`permission_mode` 只有在运行时类型确实是字符串时才覆盖 `toolPermissionContext`，并通过展开旧对象只改其中的 `mode`；缺失、`null` 或其他类型都保留旧值。`is_ultraplan_mode` 只有布尔值 `true` 或 `false` 会生效，`undefined` 与 `null` 都不会覆盖。

这个片段把序列化边界写得很清楚，外部 metadata 只恢复协议允许的字段；`TaskState` 中的函数、MCP client 连接、AbortController、`Map` 和 `Set` 留在本进程。跨进程同步通过显式字段映射完成。

### 为什么这套实现适合终端 Agent

终端 Agent 的状态更新有两个特点，频率差异大，来源也很多。流式消息可能每个增量都变化；任务状态在后台推进；IDE、Chrome 与 MCP 从外部送入能力和事件；权限既可能由快捷键改变，也可能来自对话框、远端控制或 plan mode；设置文件还会被另一个进程修改。如果这些来源各自维护一套 UI 状态，执行内核与终端显示很快就会分叉。

Claude Code 的做法是把需要跨消费者一致的引用汇到 AppState，但不强迫所有数据进入它。函数式 updater 让异步调用点总能基于最新 `prev` 计算；结构共享和 selector 把刷新限制在字段边界；`onChangeAppState` 又把"内存状态变了"与"这个变化应该同步出去"分开。

代价同样存在。字段变更来源需要沿 `setAppState` 调用点追踪；不可变更新依赖调用方自律；selector 返回新对象会造成无效刷新；同步 listener 的异常也要由调用链处理。源码选择了一个低抽象、容易穿过 React 与非 React 边界的 store。

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码，行号以当前仓库为准。

| 机制 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| 状态形状 | `AppState` 类型（DeepImmutable + 运行时对象交叉） | `src/state/AppStateStore.ts` | 已确认 |
| 默认状态 | `getDefaultAppState()` | `src/state/AppStateStore.ts` | 已确认 |
| 最小 store | `createStore<T>()` 三方法协议 | `src/state/store.ts` | 已确认 |
| Provider | `AppStateProvider`（禁嵌套 + 惰性 store + Mailbox/Voice） | `src/state/AppStateProvider.tsx` | 已确认 |
| 订阅 | `useAppState` / `useSetAppState` / `useAppStateStore` | `src/state/useAppState.ts` | 已确认 |
| 领域更新 | `updateTaskState()` 结构共享 | `src/state/updateTaskState.ts` | 已确认 |
| 外部化 | `onChangeAppState()` 字段级 diff 与持久化 | `src/state/onChangeAppState.ts` | 已确认 |
| 恢复 | `externalMetadataToAppState()` 反向映射 | `src/state/externalMetadataToAppState.ts` | 已确认 |
| 消费示例 | REPL 的 selector 订阅与 `initialMessages ?? []` | `src/screens/REPL.tsx` | 已确认 |

> 证据说明，`TaskState` 中的函数字段、MCP client 运行时对象不在 `DeepImmutable` 内（`AppStateStore.ts`），跨进程只投影可序列化 metadata（`externalMetadataToAppState.ts`），这两处边界决定"AppState 能同步什么"的答案。

## 设计决策｜为什么是外部 store 而不是全部 Context

下面的判断按代码结构组织，是对源码的解释，不是官方选型记录。

**第一，为什么用 external store + `useSyncExternalStore` 而不是把所有状态放 Context？** 因为 Context 的 value 变化会触发**所有**消费者重渲染。AppState 里有每秒都在变的 spinner、任务和权限状态，如果整棵树都订阅同一份 Context value，一次任务更新就会让消息列表、输入框和 footer 一起重建。把快照留在 store 内部、由 selector 决定订阅范围后，更新粒度从"整棵树"降级为"引用变化的切片"。

**第二，为什么不用 Zustand？** 社区生态里 Zustand 是这类模式的标准实现，Claude Code 的 store API（`getState` / `setState(updater)` / `subscribe`）几乎就是 Zustand 的极简投影。但 2.1.88 源码选择自己维护一个不到 40 行的 `createStore()`，代价是放弃 Zustand 的中间件、devtools 和持久化插件，换来零依赖、完全可控的更新语义（`Object.is` 判定、同步 listener 顺序）。对终端 UI 来说，可预测性比生态重要。

**第三，为什么 `DeepImmutable` 与运行时对象交叉？** 普通字段用深只读包装强制不可变更新；但 `TaskState` 里有函数、MCP tool 有运行时行为、`activeOverlays` 是 `Set`，把它们排除在深只读之外是诚实的类型建模，并在编译期提醒开发者，这些字段不能指望 `JSON.stringify` 跨进程。序列化边界因此是类型层面显式声明的，而不是运行时才暴露。

## 练习｜在真实会话里观察状态分叉

1. **开启 debug 日志观察状态事件。** 用 `claude --debug` 启动，做一次包含后台任务（`/background`）和 MCP 调用的任务。在 debug 日志里搜索 `permission_mode`、`expandedView`、`mainLoopModel` 相关写入，对照本文的 `onChangeAppState` 分支，判断哪些字段被持久化、哪些只刷新 listener。

2. **用 selector 优化一个自研 UI。** 如果你有自己的终端/Web 前端，尝试用"store + selector"替代"Context 全量订阅"，让高频状态（spinner、进度）和低频状态（设置、权限）分别订阅，用 `Object.is` 引用判定验证只有切片变化触发重渲染。对比前后的重渲染次数。

## 自测

1. 为什么 `updateTaskState()` 更新后，`s => s.mcp` 的订阅者不会重渲染？
2. `setState(prev => prev)` 会发生什么？为什么直接改 `prev.tasks[id]` 再返回 `prev` 是无效更新？
3. `onChangeAppState` 为什么不把所有字段变化都写盘？

<details>
<summary>参考答案</summary>

1. **结构共享。** `updateTaskState()` 只重建三层引用，新 AppState、新 tasks 表、新的单任务对象；`prev.mcp` 等兄弟字段保持原引用。`useSyncExternalStore` 用 `Object.is` 比较 snapshot，`s => s.mcp` 取到的引用没变，React 跳过重渲染。

2. **`Object.is(next, prev)` 判定为 true，整次更新成为 no-op**，不替换 state、不执行 `onChange`、不通知 listener。直接修改嵌套对象再返回原引用同样命中该判定，不可变更新属于 store 协议的一部分。

3. **职责分离。** `onChangeAppState` 只持久化或外部化源码明确列出的字段（权限模式、verbose、mainLoopModel、expandedView 等）；`tasks`、`mcp`、`notifications` 更新只刷新 listener，任务输出、transcript、配置文件和远端 metadata 分别由专门机制持久化。一次 `setState` 可能同时触发 UI 刷新、session metadata 更新和配置文件写入，但不是"全量写盘"。

</details>

## 回顾（折叠）｜没有开启 Chrome 调试模式时，还能用 Chrome MCP 吗

<details>
<summary>回答 30 留下的问题，没有开启 Chrome 调试模式时，Claude Code 还能使用 Chrome MCP 吗？</summary>

**能，但要先区分 `claude-in-chrome` 和单独的 `chrome-devtools-mcp`。** 2.1.88 随 Claude Code 提供的 `claude-in-chrome` 走"浏览器扩展 + Native Messaging/Bridge"这条链路，不把 `--remote-debugging-port` 或 DevTools Protocol 端口作为前置条件。只有当你配置的是另一个直接连接 CDP 的 Chrome DevTools MCP，才需要按那个 server 的连接方式开启远程调试。

**2.1.88 的 `setupClaudeInChrome()` 不接收参数**，返回 `mcpConfig`、`allowedTools` 和系统提示词。它在 native build 与普通 CLI build 两个分支中都注册同一个动态 stdio MCP server，差别只是启动命令是否需要附带还原出的 `cli.js` 路径，

```ts
const mcpConfig = {
  [CLAUDE_IN_CHROME_MCP_SERVER_NAME]: {
    type: 'stdio',
    command: process.execPath,
    args: ['--claude-in-chrome-mcp'],
    scope: 'dynamic',
  },
}
```

> 证据，`restored-src/src/claudeInChrome/`（2.1.88 source map 还原源码），动态 stdio MCP server 注册。

同一个函数还会异步创建 `--chrome-native-host` wrapper，并调用 `installChromeNativeHostManifest()`。这个 manifest 的 `type` 固定为 `'stdio'`，`allowed_origins` 固定放行 Claude in Chrome 扩展 ID；源码没有读取或拼接 `--remote-debugging-port`。`runChromeNativeHost()` 启动 `ChromeNativeHost`，持续读取 Chrome Native Messaging 的 stdin，直到 Chrome 关闭连接；`getAllSocketPaths()` 在 Windows 返回 named pipe，在 macOS/Linux 扫描 `*.sock` 并保留旧路径作为 fallback。整条链路没有连接 `9222` 或 CDP websocket 的分支。

`createChromeContext(env?)` 的可选 `env` 只用来覆盖权限模式，不是调试开关。`CLAUDE_CHROME_PERMISSION_MODE` 只有源码列出的 `'ask'`、`'skip_all_permission_checks'`、`'follow_a_plan'` 会被接受。这个 context 默认记录 `Bridge URL: none (using native socket)`，只有 `tengu_copper_bridge` feature flag 或 ant 构建等条件满足时才添加 `ws://` / `wss://` bridge 配置。

**普通 Chrome 仍有几个必要条件**，Chrome 中安装并启用 Claude in Chrome 扩展并登录同一 Claude 账户；Claude Code 能把 manifest 写入对应的 Native Messaging 目录（Windows 是注册表）；首次安装或 manifest 改写后重启 Chrome；扩展的站点权限允许当前页面且 service worker 未断开。任意一个缺失，失败点都在"扩展发现、host 启动、socket/bridge 配对或鉴权"阶段，不是因为 Chrome 没有开启调试端口。

| 连接方式 | 普通 Chrome 是否可用 | 是否要求远程调试 | 最先失败的位置 |
| --- | --- | --- | --- |
| 内置 `claude-in-chrome` + Native Messaging | 可以 | 不要求 | 扩展检测、host manifest/注册表、Native Messaging handshake 或本地 socket |
| 内置 `claude-in-chrome` + Bridge | 可以 | 不要求 | bridge WebSocket、OAuth 或扩展配对 |
| 单独 `chrome-devtools-mcp` 连接已运行 Chrome | 取决于连接参数 | 通常需要 `--remote-debugging-port` | CDP HTTP/WebSocket discovery 或 handshake |

排查时先运行 `/chrome`，显示扩展未连接就检查扩展、manifest、账户和重启；如果你实际配置的是 `chrome-devtools-mcp`，再去检查它自己的 remote debugging 设置。不能因为后者需要调试端口，就反推 Claude Code 内置 Chrome MCP 也需要。

</details>

## 留给下一篇的问题

共享状态准备好以后，Claude Code 如何用 Ink 和 React 构建终端 REPL，并把流式消息、工具进度与用户输入渲染到同一界面？

## 相关链接

- **上一篇**，[30 浏览器、IDE 与外部工具如何接入](./30-browser-ide-and-external-tools.md)，回答 Chrome MCP 的调试端口问题
- **下一篇**，[32 Ink TUI 与交互式 REPL 如何渲染与刷新](./32-ink-tui-and-repl.md)，AppState 这层屋顶之上的组件树
- **平行阅读**，[06 Agent 查询循环如何持续推进](./06-agent-query-loop.md)，`setAppState` 的执行侧来源
- **平行阅读**，[35 配置如何分层、同步与裁剪](./35-settings-config-and-feature-flags.md)，`applySettingsChange` 怎样通过同一个 `setState` 写回
