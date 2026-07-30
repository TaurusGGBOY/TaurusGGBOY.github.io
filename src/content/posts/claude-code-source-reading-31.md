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

## 本章先建立三个概念

- **共享可变状态**：会话、任务和 UI 共同读写的运行数据需要统一所有权和更新入口。

- **Selector**：消费者只订阅所需切片，状态变化时据此决定是否刷新。

- **结构共享**：函数式 updater 复用未变化对象，使引用比较可以快速定位受影响区域。

![AppState 更新、Selector 与结构共享](/images/posts/claude-code-source-reading-31/31-state-selectors-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇最后留下的问题是：**没有开启 Chrome 调试模式时，Claude Code 还能使用 Chrome MCP 吗？**

先给结论：**能，但要先区分 `claude-in-chrome` 和单独的 `chrome-devtools-mcp`。**2.1.88 随 Claude Code 提供的 `claude-in-chrome` 走“浏览器扩展 + Native Messaging/Bridge”这条链路，不把 `--remote-debugging-port` 或 DevTools Protocol 端口作为前置条件。只有当你配置的是另一个直接连接 CDP 的 Chrome DevTools MCP，才需要按那个 server 的连接方式开启远程调试。

## 2.1.88 的 Claude in Chrome 不依赖 Chrome 调试端口

`setupClaudeInChrome()` 不接收参数，返回 `mcpConfig`、`allowedTools` 和系统提示词。它在 native build 与普通 CLI build 两个分支中都注册同一个动态 stdio MCP server；差别只是启动命令是否需要附带还原出的 `cli.js` 路径：

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

同一个函数还会异步创建 `--chrome-native-host` wrapper，并调用 `installChromeNativeHostManifest()`。这个 manifest 的 `type` 固定为 `'stdio'`，`allowed_origins` 固定放行 Claude in Chrome 扩展 ID；源码没有读取或拼接 `--remote-debugging-port`。因此这里的“调试”只是浏览器工具能读取 console、DOM 等调试信息，并不表示 Chrome 必须以 DevTools 远程调试模式启动。

Native host 的运行路径也很直接：`runChromeNativeHost()` 启动 `ChromeNativeHost`，持续读取 Chrome Native Messaging 的 stdin，直到 Chrome 关闭连接；`ChromeNativeHost.start()` 随后创建安全的本地 socket listener。`getAllSocketPaths()` 在 Windows 返回 named pipe，在 macOS/Linux 扫描 `*.sock` 并保留旧路径作为 fallback。整条链路没有连接 `9222` 或 CDP websocket 的分支。

`createChromeContext(env?)` 的可选 `env` 只用来覆盖权限模式，不是调试开关。省略时回退到 `process.env`；`CLAUDE_CHROME_PERMISSION_MODE` 只有源码列出的 `'ask'`、`'skip_all_permission_checks'`、`'follow_a_plan'` 会被接受。这个 context 默认记录 `Bridge URL: none (using native socket)`，只有 `tengu_copper_bridge` feature flag 或 ant 构建等条件满足时才添加 `ws://` / `wss://` bridge 配置。无论选择 native socket 还是 bridge，浏览器侧仍是扩展连接，而不是 Chrome 远程调试端口。

## 普通 Chrome 仍有几个必要条件

“不需要调试模式”不等于“什么都不用配置”。要让这条链路真正可用，至少要满足：

1. Chrome 中安装并启用 Claude in Chrome 扩展，并登录与 Claude Code 相同的 Claude 账户；
2. Claude Code 能把 `com.anthropic.claude_code_browser_extension.json` 写入对应的 Native Messaging 目录（Windows 是注册表）；
3. 首次安装或 manifest 改写后重启 Chrome，让 Chrome 重新读取 host 配置；
4. 扩展的站点权限允许当前页面，且扩展 service worker 没有处于断开状态。

这几个条件中的任意一个缺失，失败点都在“扩展发现、Native Messaging host 启动、socket/bridge 配对或鉴权”阶段，模型还没有拿到浏览器 tools；不是因为 Chrome 没有开启调试端口。Chrome 官方的 Native Messaging 文档也把 host manifest、`allowed_origins`、`nativeMessaging` 权限和 stdio 协议列为连接前提，并把“host not found / forbidden / pipe broken”列为典型错误。

## 不同 MCP 的边界

| 连接方式 | 普通 Chrome 是否可用 | 是否要求远程调试 | 最先失败的位置 |
| --- | --- | --- | --- |
| Claude Code 内置 `claude-in-chrome` + Native Messaging | 可以 | 不要求 | 扩展检测、host manifest/注册表、Native Messaging handshake 或本地 socket |
| Claude Code 内置 `claude-in-chrome` + Bridge | 可以 | 不要求 | bridge WebSocket、OAuth 或扩展配对 |
| 单独的 `chrome-devtools-mcp` 连接已运行 Chrome | 取决于连接参数 | 通常需要 `--remote-debugging-port` 或 `chrome://inspect/#remote-debugging` | CDP HTTP/WebSocket discovery 或 handshake |

所以排查时先运行 `/chrome`：如果显示扩展未连接，检查扩展、manifest、账户和重启；如果你实际配置的是 `chrome-devtools-mcp`，再去检查它自己的 remote debugging 设置。不能因为后者需要调试端口，就反推 Claude Code 内置 Chrome MCP 也需要。

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的代码块只保留证明主路径所需的字段和分支，省略了无关 import、实验字段与日志；还原路径只表示本仓库的恢复组织方式。

## AppState 围绕“必须共享的状态”建立边界

在看代码以前，先补三个基础概念。

**React Context** 可以把一个值交给整棵组件树，避免从顶层一层层传 props。但如果 Context value 本身频繁变化，所有消费它的组件都可能跟着重新渲染。

**external store** 是 React 组件树外部的一份状态。React 不负责保存它，只通过订阅得知“外部状态变了”，再读取一个 snapshot。`useSyncExternalStore` 是 React 为这种模型提供的标准接入口。

**selector** 是一个从大状态中取小切片的函数，例如 `s => s.tasks`。组件借此只订阅任务表；只要选中的引用不变，其他字段更新就不会触发这个组件重渲染。

把这三件事放在一起，Claude Code 的状态流如下：

![Claude Code AppState 的更新、订阅与持久化边界](/images/posts/claude-code-source-reading-31/31-app-state-architecture-handdrawn.png)

图中的上下两条边界分别表示 UI 通知与磁盘持久化；进程内数据也按共享范围决定是否进入 AppState。

## 第一层：AppState 把五类共享状态放在同一张数据平面上

`restored-src/src/state/AppStateStore.ts` 的类型虽然很大，字段仍可归入五条主线：会话设置、权限、动态工具、任务状态和 UI 协调状态。

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

`AppState` 在编译期描述状态形状。这里的 `DeepImmutable` 要求调用方通过创建新引用来更新普通字段；后面的交叉类型特意把 `tasks`、`mcp` 等排除在深只读包装之外，因为 `TaskState` 中存在函数类型，MCP tool 也包含运行时行为。这些进程内对象决定了跨进程序列化必须经过显式映射。

几个字段的可选值直接决定控制流：`expandedView` 只有 `'none'`、`'tasks'`、`'teammates'`，分别选择收起、任务视图和 teammate 视图；`footerSelection` 为 `FooterItem` 时把键盘焦点路由到对应 footer pill，为 `null` 时跳过 footer 选中态；`statusLineText` 提供字符串时渲染自定义状态行，值为 `undefined` 时消费者走默认状态行路径。`mcp.clients/tools/commands/resources` 分别承载连接、工具、命令和资源快照，`pluginReconnectKey` 递增时触发插件连接侧重新装配；`notifications.current` 是当前显示项，`queue` 保存后续候选。

其余字段可以按消费者紧凑分组：`settings` 与 `mainLoopModel` 供查询和配置层读取，`verbose` 控制详细展示，`toolPermissionContext` 把权限模式与规则送入工具执行链；`tasks` 以开放字符串 `taskId` 为键保存可被任务面板观察的运行对象，`fileHistory` 服务文件快照与回滚，`activeOverlays` 用字符串集合协调当前覆盖层。`tasks`、`mcp` 和 `activeOverlays` 都含进程内结构，跨进程时必须投影为协议字段。

为什么把这些字段放在一起？因为它们存在跨边界消费者：任务执行器写 `tasks`，Spinner 和 TaskPanel 读它；MCP 管理器写连接与工具，REPL、设置页和 Agent 定义装配读它；权限对话框和 query 上下文共同读取 `toolPermissionContext`；footer 焦点则要被不在 PromptInput 子树里的组件读取。

对话消息主要由 REPL 自己生产、排序和渲染，作用域停留在消息组件链；AppState 则承载需要被执行器、状态栏和对话框共同观察的状态。

## 第二层：默认状态把缺省值写死，也保留运行时分支

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

`getDefaultAppState()` 接受零个参数并返回一份新的 `AppState`。`initialMode` 在两个布尔条件都为真时取 `'plan'`，否则回退 `'default'`；这段初始化代码只证明这两个计算结果，PermissionMode 的完整枚举由权限模块定义。`mainLoopModel: null` 让后续模型选择逻辑采用默认模型；该字段的 `undefined` 则代表字段尚未进入这份状态。`remoteConnectionStatus` 还允许 `'connected'`、`'reconnecting'`、`'disconnected'`，默认从 `'connecting'` 开始。

默认容器也对应明确的初始行为：`settings` 来自 `getInitialSettings()`；`tasks`、`mcp.clients`、`mcp.tools`、`mcp.commands` 从空数组或对象开始，`mcp.resources` 初始化为空映射；`notifications.current: null` 表示当前展示项为空，`notifications.queue: []` 表示待显示队列为空。`agentNameRegistry` 与 `activeOverlays` 分别创建新的 `Map`、`Set`；`verbose`、`fastMode` 均为 `false`，`expandedView: 'none'`、`footerSelection: null`、`statusLineText: undefined` 让 UI 从收起且无额外选择的状态启动。`toolPermissionContext` 继承空上下文后只覆盖 `mode: initialMode`，`pluginReconnectKey: 0` 则作为后续递增触发器的基线。

数组、对象、`Map` 和 `Set` 都在函数调用时重新创建，避免不同 Provider 意外共享可变容器。普通交互入口随后用启动参数、全局配置、已解析权限、Agent 定义和初始通知覆盖这份模板，每个会话最终得到自己的启动快照。

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

`createStore<T>(initialState, onChange?)` 有两个参数。`initialState` 是任意泛型 `T` 的初始引用；传入 `onChange` 时，每次有效写入都会携带前后快照调用它，省略时状态仍会写入并通知订阅者，只跳过这项外部副作用。返回的 `Store<T>` 只有三个方法。

`setState(updater)` 的参数必须是 `(prev: T) => T`：调用方拿到最新 `prev`，返回 `next`。状态变化直接由函数 updater 表达，变更来源需要沿各个 `setState` 调用点追踪。

`Object.is(next, prev)` 是这里唯一的顶层变更判定。如果 updater 返回原引用，更新被视为 no-op：不替换 state，不执行 `onChange`，也不通知 listener。返回新对象后，顺序固定为“写入 state → 调用 onChange → 遍历 listeners”。这保证订阅者醒来时 `getState()` 已经能读到新值。

`subscribe(listener)` 接受无参数回调，把它放进 `Set`，再返回 unsubscribe 函数。相同 listener 引用不会在 `Set` 中重复；取消订阅时 `delete` 返回布尔值，但外层函数不使用该值。

这也解释了为什么更新必须保留结构共享。直接修改 `prev.tasks[id]` 再返回 `prev`，store 会把它判断为无变化；正确做法是为发生变化的层级创建新引用。

## 第四层：Provider 只提供稳定 store，不把整棵树绑在 state 上

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

`AppStateProvider(props)` 接收三个字段。`children` 必填；`initialState` 传入完整对象时直接采用该引用，省略时调用 `getDefaultAppState()`；传入 `onChangeAppState` 会启用集中 diff hook，省略后 store 仍照常写入和通知。回调参数里的 `newState` 是本次提交后的完整快照，`oldState` 是提交前快照，两者构成字段级 diff 的输入。表达式使用 `??`，所以越过类型系统传入的 `null` 也会落到默认状态。

`useState` 的惰性初始化器只在挂载时创建 store。后续 props 引用改变不会把现有 store 换掉，这是 Context value 保持稳定的关键。Provider 还显式禁止嵌套；否则内外两份同名共享状态会让“组件到底读哪一份”变得依赖树位置。

`MailboxProvider` 和按构建特性存在的 `VoiceProvider` 使用独立 context。它们位于 store provider 内部，可以消费 AppState，同时维护各自的订阅与生命周期。

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

传给 `useSyncExternalStore` 的第二、第三个参数都是 `get`：客户端 snapshot 与 server snapshot 使用同一读取方式。`useAppStore()` 在 Provider 外调用会抛 `ReferenceError`；`useAppStateMaybeOutsideOfProvider(selector)` 遇到缺失的 store 时使用空订阅并返回 `undefined`。两个 API 分别服务“必须存在”和“允许缺席”的组件。

`useSetAppState()` 接受零个参数，只返回稳定的 `setState` 引用；只负责写入的组件因此避开 AppState 变化触发的重渲染。`useAppStateStore()` 同样接受零个参数，返回完整 store，主要用于把 `getState/setState` 交给非 React 代码；组件读取状态仍应通过 selector 控制订阅范围。

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

这些 `useAppState` 调用都要求传入 selector。`toolPermissionContext`、`mcp`、`fileHistory` 和 `tasks` 分别使权限 UI、连接视图、文件回滚界面和任务面板只跟随对应子树；`viewingAgentTaskId` 为字符串时切到该任务视图，省略时保留 leader 主视图。`messages` 使用 `initialMessages ?? []` 初始化：传入数组时复用该历史，`null` 或 `undefined` 时从空消息列表开始；消息更新走 REPL 自己的状态链，绕过 `onChangeAppState`。

这个边界由更新频率与共享范围决定。流式消息频繁增长，主要由 REPL 与消息组件消费；进入大 store 会让所有误订阅 `state` 的调用点承担高频 snapshot 变化。任务、权限与 MCP 同时被执行器、状态栏、对话框和工具装配读取，更适合共享。

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

渲染范围由两层机制共同控制：每个领域函数负责自己的不可变更新和 no-op 判定，store 负责最后一道顶层引用判定。

边界也要说清楚。`tasks` 中的 `TaskState` 可能包含函数和进程内对象，所以 AppState 类型把这一部分留在 `DeepImmutable` 之外。AppState 对 UI 暴露任务生命周期；跨进程传输则必须另行提取可序列化字段。

## 第七层：onChangeAppState 按字段输出 diff

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

`onChangeAppState({ newState, oldState })` 接收一个对象参数，两个字段都必需且都是完整 AppState。它自己不返回新状态，职责是观察变化并触发明确副作用。

权限模式变化时，内部 mode 先经过 `toExternalPermissionMode()` 映射。只有外部值也发生变化，才把 `permission_mode` 写成 `newExternal` 并更新 CCR session metadata；SDK 的权限模式通知则仍拿到内部 `newMode`，由 SDK 监听端再过滤。`is_ultraplan_mode` 只有首次进入符合条件的 plan 状态时为 `true`，其余情况传 `null`；源码注释明确 `null` 按 RFC 7396 删除 metadata key，`false` 则会保留 key 并写入布尔值。

完整函数还对 `mainLoopModel`、`expandedView`、`verbose` 和内部构建的 `tungstenPanelVisible` 做定向持久化。`mainLoopModel === null` 时从 user settings 移除 model 并清空 override，非 `null` 时写入具体模型；`expandedView` 被兼容映射成 `showExpandedTodos` 与 `showSpinnerTree` 两个布尔配置。`settings` 引用变化则清理认证缓存，并在 `settings.env` 引用变化时重新应用环境变量。

`tasks`、`mcp`、`notifications`、`activeOverlays` 更新时会刷新 listener；任务输出、session transcript、配置文件和远端 metadata 则分别由专门机制持久化。

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

`externalMetadataToAppState(metadata)` 接收 `SessionExternalMetadata`，返回一个可直接交给 `setState` 的 updater。`permission_mode` 只有在运行时类型确实是字符串时才覆盖 `toolPermissionContext`，并通过展开旧对象只改其中的 `mode`；缺失、`null` 或其他类型都保留旧值。`is_ultraplan_mode` 只有布尔值 `true` 或 `false` 会生效，`undefined` 与 `null` 都不会覆盖。

这个片段把序列化边界写得很清楚：外部 metadata 只恢复协议允许的字段；`TaskState` 中的函数、MCP client 连接、AbortController、`Map` 和 `Set` 留在本进程。跨进程同步通过显式字段映射完成。

## 为什么这套实现适合终端 Agent

终端 Agent 的状态更新有两个特点：频率差异大，来源也很多。

流式消息可能每个增量都变化；任务状态在后台推进；IDE、Chrome 与 MCP 从外部送入能力和事件；权限既可能由快捷键改变，也可能来自对话框、远端控制或 plan mode；设置文件还会被另一个进程修改。如果这些来源各自维护一套 UI 状态，执行内核与终端显示很快就会分叉。

Claude Code 的做法是把需要跨消费者一致的引用汇到 AppState，但不强迫所有数据进入它。函数式 updater 让异步调用点总能基于最新 `prev` 计算；结构共享和 selector 把刷新限制在字段边界；`onChangeAppState` 又把“内存状态变了”与“这个变化应该同步出去”分开。

代价同样存在。字段变更来源需要沿 `setAppState` 调用点追踪；不可变更新依赖调用方自律；selector 返回新对象会造成无效刷新；同步 listener 的异常也要由调用链处理。源码选择了一个低抽象、容易穿过 React 与非 React 边界的 store。

## 小结

Claude Code 2.1.88 的 AppState 可以理解为运行时共享数据平面：

- `AppState` 收纳权限、任务、MCP、文件历史与跨组件 UI 状态，但不收纳所有进程数据。
- `createStore()` 用函数式 updater、顶层 `Object.is` 和同步 listener 建立最小更新协议。
- `AppStateProvider` 只向 Context 放稳定 store，具体组件通过 `useSyncExternalStore` 与 selector 订阅切片。
- 领域函数通过结构共享更新自己的子树；返回旧引用就是明确的 no-op。
- `onChangeAppState` 集中比较新旧快照，但只持久化或外部化源码明确列出的字段。
- REPL messages、bootstrap globals、缓存、transcript 与任务磁盘输出保留各自边界；跨进程恢复也只映射可序列化 metadata。

所以它通过一个共享快照、一个更新协议和彼此独立的订阅与持久化边界来保证一致性。

## 留给下一篇的问题

共享状态准备好以后，Claude Code 如何用 Ink 和 React 构建终端 REPL，并把流式消息、工具进度与用户输入渲染到同一界面？

## 参考资料

- [Claude Code 的工作方式](https://code.claude.com/docs/en/how-claude-code-works)

- [Dive into Claude Code：生产级 Agent 的设计空间](https://arxiv.org/abs/2604.14228)

- [Use Claude Code with Chrome](https://code.claude.com/docs/en/chrome)

- [Native messaging | Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

- [Chrome DevTools MCP troubleshooting](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md)
