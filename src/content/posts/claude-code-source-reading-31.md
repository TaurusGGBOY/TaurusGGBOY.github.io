---
title: "Claude Code源码解读31：共享状态如何贯穿整个系统"
published: 2026-07-24T16:47:18+08:00
updated: 2026-07-24T16:47:18+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-31/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇最后留下的问题是：这些外部事件进入主进程以后，Claude Code 的 AppState 如何组织会话、工具、任务、权限和 UI 共享状态，并保证更新可追踪？

先说结论：Claude Code 没有把所有运行数据塞进一个 React 大对象，也没有使用 Redux 那种 `action → reducer → state` 的中心状态机。它做的是一件更克制的事：用一个稳定的轻量 store 保存确实需要跨组件、工具与任务共享的状态，再用函数式 updater 改变它，用 selector 订阅局部切片，最后用统一的 `onChangeAppState` 观察新旧状态差异，把少数变化同步到配置、CCR 或 SDK。

这套结构可以压缩成四层：

1. `AppState` 定义共享数据平面，放权限上下文、MCP 能力、任务表、文件历史和 UI 协调字段。
2. `createStore()` 只提供 `getState()`、`setState(updater)` 和 `subscribe(listener)`。
3. `AppStateProvider` 把同一个 store 交给 React 组件树；非 React 代码也可以直接拿到它的读写函数。
4. `onChangeAppState()` 比较 `oldState` 与 `newState`，只对明确字段执行持久化或外部通知。

因此，“可追踪”并不等于保存每一次 action 日志。2.1.88 的实现依靠的是另一组边界：每次有效更新都同时拥有前后快照，所有 React 订阅者在更新后统一收到通知，需要外部同步的字段又集中经过同一个 diff hook。

还有一个容易误解的地方：REPL 的 `messages` 并不在 `AppState` 中，它仍是 `REPL.tsx` 的局部 React state；bootstrap 全局量、缓存、transcript 和任务磁盘输出也有自己的存储机制。AppState 是共享状态平面，不是整个进程的数据库。

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的代码块只保留证明主路径所需的字段和分支，省略了无关 import、实验字段与日志；还原路径不等于 Anthropic 内部仓库的原始目录。

## AppState 的核心不是“全局”，而是“哪些状态必须共享”

在看代码以前，先补三个基础概念。

**React Context** 可以把一个值交给整棵组件树，避免从顶层一层层传 props。但如果 Context value 本身频繁变化，所有消费它的组件都可能跟着重新渲染。

**external store** 是 React 组件树外部的一份状态。React 不负责保存它，只通过订阅得知“外部状态变了”，再读取一个 snapshot。`useSyncExternalStore` 是 React 为这种模型提供的标准接入口。

**selector** 是一个从大状态中取小切片的函数，例如 `s => s.tasks`。它让组件表达“我只关心任务表”，而不是订阅整个 AppState。只要选中的引用不变，其他字段更新就不需要让这个组件重渲染。

把这三件事放在一起，Claude Code 的状态流如下：

![Claude Code AppState 的更新、订阅与持久化边界](/images/posts/claude-code-source-reading-31/31-app-state-architecture-handdrawn.png)

图里最重要的不是中间那个大框，而是上下两条边界：向右通知 UI 不等于向磁盘持久化；属于同一个进程也不等于必须进入 AppState。

## 第一层：AppState 把五类共享状态放在同一张数据平面上

`restored-src/src/state/AppStateStore.ts` 的类型很大，但它并不是随机字段集合。抽出主干以后，可以看到五类信息：会话设置、权限、动态工具、任务状态和 UI 协调状态。

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

`AppState` 是类型，不是运行时函数。这里的 `DeepImmutable` 表达“调用方应当通过创建新引用来更新普通字段”，但后面的交叉类型特意把 `tasks`、`mcp` 等排除在深只读包装之外，因为 `TaskState` 中存在函数类型，MCP tool 也包含运行时行为。也就是说，这不是一份天然可 JSON 序列化的数据。

几个字段的可选值也直接决定控制流：`expandedView` 只有 `'none'`、`'tasks'`、`'teammates'`，分别表示不展开、任务视图和 teammate 视图；`footerSelection` 可以是 `FooterItem` 的某个候选或 `null`，`null` 表示当前没有 footer pill 获得焦点；`statusLineText` 为 `undefined` 时没有自定义状态行文本。

为什么把这些字段放在一起？因为它们存在跨边界消费者：任务执行器写 `tasks`，Spinner 和 TaskPanel 读它；MCP 管理器写连接与工具，REPL、设置页和 Agent 定义装配读它；权限对话框和 query 上下文共同读取 `toolPermissionContext`；footer 焦点则要被不在 PromptInput 子树里的组件读取。

相反，对话消息主要由 REPL 本身生产、排序和渲染，不需要让所有外部组件都共享，因此没有为了“统一”被强行搬进 AppState。

## 第二层：默认状态把缺省值写死，也保留运行时分支

`getDefaultAppState()` 给独立对话框、headless store 和普通 Provider 提供可用起点。它不是一个常量，因为初始权限模式取决于当前进程是否为要求 plan mode 的 teammate。

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

`getDefaultAppState()` 没有参数，返回一份新的 `AppState`。`initialMode` 在两个布尔条件都为真时是 `'plan'`，否则回退为 `'default'`；这里不能外推 PermissionMode 的完整候选集，完整枚举由权限模块定义。`mainLoopModel: null` 表示没有显式模型覆盖，后续使用默认模型选择逻辑；它不同于 `undefined`。`remoteConnectionStatus` 的类型还允许 `'connected'`、`'reconnecting'`、`'disconnected'`，默认从 `'connecting'` 开始。

数组、对象、`Map` 和 `Set` 都在函数调用时重新创建，避免不同 Provider 意外共享可变容器。普通交互入口则会在这套语义上覆盖启动参数、全局配置、已解析权限、Agent 定义和初始通知，因此“默认状态”不等于“每个会话实际都从同一组值启动”。

## 第三层：store 不分发 action，只接受函数式 updater

真正的状态容器位于 `restored-src/src/state/store.ts`。它不到四十行：

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

`createStore<T>(initialState, onChange?)` 有两个参数。`initialState` 是任意泛型 `T` 的初始引用；`onChange` 可以是函数或 `undefined`，省略时可选链让更新跳过外部观察副作用。返回的 `Store<T>` 只有三个方法。

`setState(updater)` 的参数必须是 `(prev: T) => T`。它很像一个没有 action 类型的局部 reducer：调用方拿到最新 `prev`，返回 `next`。但源码中没有统一的 action 联合、dispatch 队列或中心 reducer，因此不应该把它描述成 Redux。

`Object.is(next, prev)` 是这里唯一的顶层变更判定。如果 updater 返回原引用，更新被视为 no-op：不替换 state，不执行 `onChange`，也不通知 listener。返回新对象后，顺序固定为“写入 state → 调用 onChange → 遍历 listeners”。这保证订阅者醒来时 `getState()` 已经能读到新值。

`subscribe(listener)` 接受无参数回调，把它放进 `Set`，再返回 unsubscribe 函数。相同 listener 引用不会在 `Set` 中重复；取消订阅时 `delete` 返回布尔值，但外层函数不使用该值。。

这也解释了为什么更新必须保留结构共享。直接修改 `prev.tasks[id]` 再返回 `prev`，store 会把它判断为无变化；正确做法是为发生变化的层级创建新引用。

## 第四层：Provider 只提供稳定 store，不把整棵树绑在 state 上

`AppStateProvider` 使用 React Context，但放进 Context 的不是不断变化的 AppState，而是只创建一次的 store。

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

`AppStateProvider(props)` 接收三个字段。`children` 必填；`initialState` 为 `undefined` 时调用 `getDefaultAppState()`，传入完整对象时直接采用该引用；`onChangeAppState` 为 `undefined` 时 store 仍能更新，只是不执行集中 diff hook。这里使用 `??`，所以类型上不允许的 `null` 即使从非类型安全调用进入，也会和 `undefined` 一样回退默认值。

`useState` 的惰性初始化器只在挂载时创建 store。后续 props 引用改变不会把现有 store 换掉，这是 Context value 保持稳定的关键。Provider 还显式禁止嵌套；否则内外两份同名共享状态会让“组件到底读哪一份”变得依赖树位置。

`MailboxProvider` 和按构建特性存在的 `VoiceProvider` 是独立 context，不是 AppState 的字段。它们被放在 store provider 内部，因此可以消费 AppState，但有自己的订阅与生命周期。

Provider 还会监听 settings 文件变化，并调用 `applySettingsChange(source, store.setState)`。`source` 是 `SettingSource`，候选来自 settings 常量模块；静态片段不能把运行时可能触发的来源简化成单一 user 配置。该更新会重新读取 settings、权限规则和 hooks，再通过同一个 `setState` 写回，因此交互式 UI 与 headless 路径可以复用更新规则。

## 第五层：selector 决定谁需要重新渲染

`useAppState()` 把这个外部 store 接进 React：

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

`useAppState(selector)` 的 `selector` 必须是从完整 `AppState` 到任意 `T` 的函数。React 用 `Object.is` 比较前后 snapshot；选中原有字段或子对象引用时，只有那部分引用变化才重渲染。若 selector 每次都创建 `{ a: state.a }` 这样的新对象，即使 `a` 没变，引用也总是不同，优化就失效。源码注释因此建议多个独立字段调用多次 hook。

传给 `useSyncExternalStore` 的第二、第三个参数都是 `get`：客户端 snapshot 与 server snapshot 使用同一读取方式。`useAppStore()` 在 Provider 外调用会抛 `ReferenceError`，而另一个 `useAppStateMaybeOutsideOfProvider(selector)` 会在没有 store 时使用空订阅并返回 `undefined`；这两个 API 分别服务“必须存在”和“允许缺席”的组件。

`useSetAppState()` 没有参数，只返回稳定的 `setState` 引用，本身不订阅状态，所以只负责写入的组件不会因 AppState 变化重渲染。`useAppStateStore()` 同样没有参数，返回完整 store，主要用于把 `getState/setState` 交给非 React 代码；它不是让组件订阅整个状态的捷径。

在 REPL 中，订阅就是按切片展开的：

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

这些 `useAppState` 调用都接收一个 selector，没有默认参数。`viewingAgentTaskId` 的结果可以是字符串或 `undefined`，后者表示仍在 leader 主视图。`messages` 则使用 `initialMessages ?? []` 初始化：`initialMessages` 为 `null` 或 `undefined` 时回退为空数组，否则采用传入数组。它没有经过 AppState 的订阅和 `onChangeAppState`。

这不是遗漏，而是更新频率与共享范围的选择。流式消息频繁增长，主要由 REPL 与消息组件消费；把它塞进大 store 会让所有误订阅 `state` 的调用点承担高频 snapshot 变化。任务、权限与 MCP 则必须同时被执行器、状态栏、对话框和工具装配读取，更适合共享。

## 第六层：任务更新展示了结构共享怎样降低无关刷新

任务运行时不需要知道 React。它只接收 `setAppState`，用一个小函数更新指定任务：

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

`updateTaskState(taskId, setAppState, updater)` 有三个参数。`taskId` 是开放字符串，来自已经注册的任务；找不到对应任务时 `task` 为 `undefined`，函数返回原 `prev`，整次更新成为 no-op。`setAppState` 是 store 的函数式更新入口；`updater` 接收类型为 `T` 的现有任务，返回同类型任务。

若任务 updater 返回原引用，外层同样返回 `prev`，`s => s.tasks` 的订阅者不会刷新。只有任务真的改变时，代码才同时创建新 AppState、新 tasks 表和新的单任务引用。其他字段继续复用旧引用，因此 `s => s.mcp`、`s => s.toolPermissionContext` 的 snapshot 不变。

这就是它没有中心 reducer 仍能控制渲染范围的原因：每个领域函数负责自己的不可变更新和 no-op 判定，store 负责最后一道顶层引用判定。

边界也要说清楚。`tasks` 中的 `TaskState` 可能包含函数和进程内对象，所以 AppState 类型特意没有把这一部分强制变成 `DeepImmutable`。AppState 能让 UI 看到任务生命周期，不代表整个任务对象可以直接跨进程传输或原样写入 JSON。

## 第七层：onChangeAppState 是 diff 出口，不是全量持久化器

每次有效 `setState` 都会把 `newState` 和 `oldState` 交给 `onChangeAppState()`。这个入口检查具体字段，而不是序列化整个对象。

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

`onChangeAppState({ newState, oldState })` 接收一个对象参数，两个字段都必需且都是完整 AppState。它自己不返回新状态，职责是观察变化并触发明确副作用。

权限模式变化时，内部 mode 先经过 `toExternalPermissionMode()` 映射。只有外部值也发生变化，才更新 CCR session metadata；SDK 的权限模式通知则仍拿到内部 `newMode`，由 SDK 监听端再过滤。`is_ultraplan_mode` 只有首次进入符合条件的 plan 状态时为 `true`，其余情况传 `null`；源码注释明确 `null` 按 RFC 7396 表示删除 metadata key，而不是 `false`。

完整函数还对 `mainLoopModel`、`expandedView`、`verbose` 和内部构建的 `tungstenPanelVisible` 做定向持久化。`mainLoopModel === null` 时从 user settings 移除 model 并清空 override，非 `null` 时写入具体模型；`expandedView` 被兼容映射成 `showExpandedTodos` 与 `showSpinnerTree` 两个布尔配置。`settings` 引用变化则清理认证缓存，并在 `settings.env` 引用变化时重新应用环境变量。

注意这里没有 `tasks`、`mcp`、`notifications`、`activeOverlays` 的全量保存。它们更新时 listener 会刷新，`onChangeAppState` 也会被调用，但没有对应 diff 分支就不会自动落盘。任务输出、session transcript、配置文件和远端 metadata 各自有专门机制，不能因为它们都与“状态”有关就归为 AppState 持久化。

## 第八层：恢复也只把可外部化字段映射回来

远程 worker 恢复时，源码提供了从 session external metadata 到 updater 的反向转换：

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

`externalMetadataToAppState(metadata)` 接收 `SessionExternalMetadata`，返回一个可直接交给 `setState` 的 updater。`permission_mode` 只有在运行时类型确实是字符串时才覆盖权限上下文；缺失、`null` 或其他类型都保留旧值。`is_ultraplan_mode` 只有布尔值 `true` 或 `false` 会生效，`undefined` 与 `null` 都不会覆盖。

这个片段把序列化边界写得很清楚：外部 metadata 只恢复协议允许的字段，不尝试复原 `TaskState` 中的函数、MCP client 连接、AbortController、`Map` 或 `Set`。跨进程同步需要显式映射，不是把 AppState 做一次 `JSON.stringify()`。

## 为什么这套实现适合终端 Agent

终端 Agent 的状态更新有两个特点：频率差异大，来源也很多。

流式消息可能每个增量都变化；任务状态在后台推进；IDE、Chrome 与 MCP 从外部送入能力和事件；权限既可能由快捷键改变，也可能来自对话框、远端控制或 plan mode；设置文件还会被另一个进程修改。如果这些来源各自维护一套 UI 状态，执行内核与终端显示很快就会分叉。

Claude Code 的做法是把需要跨消费者一致的引用汇到 AppState，但不强迫所有数据进入它。函数式 updater 让异步调用点总能基于最新 `prev` 计算；结构共享和 selector 把刷新限制在字段边界；`onChangeAppState` 又把“内存状态变了”与“这个变化应该同步出去”分开。

代价同样存在。它没有 action 日志，定位某个字段是谁改的，需要沿 `setAppState` 调用点追踪；不可变更新依赖调用方自律；selector 返回新对象会造成无效刷新；同步 listener 没有天然错误隔离。源码选择的是一个低抽象、容易穿过 React 与非 React 边界的 store，而不是提供完整状态管理框架。

## 小结

Claude Code 2.1.88 的 AppState 可以理解为运行时共享数据平面：

- `AppState` 收纳权限、任务、MCP、文件历史与跨组件 UI 状态，但不收纳所有进程数据。
- `createStore()` 用函数式 updater、顶层 `Object.is` 和同步 listener 建立最小更新协议。
- `AppStateProvider` 只向 Context 放稳定 store，具体组件通过 `useSyncExternalStore` 与 selector 订阅切片。
- 领域函数通过结构共享更新自己的子树；返回旧引用就是明确的 no-op。
- `onChangeAppState` 集中比较新旧快照，但只持久化或外部化源码明确列出的字段。
- REPL messages、bootstrap globals、缓存、transcript 与任务磁盘输出保留各自边界；跨进程恢复也只映射可序列化 metadata。

所以它保证一致性的方式不是“所有东西都全局化”，而是让共享状态只有一个当前快照，让更新只有一个协议，让订阅与持久化各自拥有清楚边界。

## 留给下一篇的问题

共享状态准备好以后，Claude Code 如何用 Ink 和 React 构建终端 REPL，并把流式消息、工具进度与用户输入渲染到同一界面？

