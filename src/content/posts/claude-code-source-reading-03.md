---
title: "Claude Code源码解读03：第一次提问前，它到底做了什么"
published: 2026-07-20T17:10:40+08:00
description: "拆解 Claude Code 在第一次请求前完成的入口分流、配置加载、项目信任、会话恢复、能力装配与宿主挂载。"
tags: ["claude-code", "source-code", "ai-agent", "startup"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-03/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：Claude Code 的 `queryLoop` 算不算 ReAct，它与经典 ReAct 又有什么区别？

先说答案：**从执行范式看，它当然算 ReAct；从工程实现看，它又远不止 ReAct。**

两者共享同一个基本回环：模型根据当前消息生成响应，遇到 `tool_use` 就执行动作，把 `tool_result` 作为新的观察结果放回消息历史，然后让模型继续推理。直到模型不再请求工具，或者流程被错误、取消、预算、上下文上限、hook 等边界截断。只看这条“推理 → 行动 → 观察 → 再推理”的主线，`queryLoop` 就是 ReAct 在编程 Agent 中的一种实现。

区别在于，经典 ReAct 描述的是一种方法，而 Claude Code 的 `queryLoop` 是一套产品级运行时。它不只负责让模型和工具轮流工作，还要处理流式消息、工具并发、权限检查、结果裁剪、上下文压缩、会话状态、错误恢复与停止条件。换句话说，ReAct 解释了这个循环为什么成立，却没有替 Claude Code 解决循环怎样安全、稳定、可恢复地运行。

还有一个容易混淆的边界：源码能够确认 Claude Code 的控制流符合 ReAct 范式，但源码没有把 `queryLoop` 命名为 ReAct，也不能据此断言 Anthropic 就是按照某篇 ReAct 论文实现了它。更准确的说法是：**ReAct 是理解这条链路的简洁模型，`queryLoop` 则是围绕这条模型长出来的专用执行引擎。**

回答完这个问题，我们再把时间线往前挪一步。上一篇从 `QueryEngine.ask` 开始追踪请求，但当它能够被调用时，运行模式、配置、权限、项目、会话和宿主其实已经准备好了。本篇要看的，就是第一次请求之前的这段启动链路。

这也是启动阶段最容易读错的地方。我们在终端里执行的是同一条 `claude` 命令，但 `claude --version`、`claude -p`、普通交互式 REPL 和 `claude remote-control` 并不会走完同一条初始化链路。

## 启动不是一条从头跑到底的直线

我们先看最外层入口 `restored-src/src/entrypoints/cli.tsx`。它没有一上来就导入整个程序，而是先检查参数，为一些特殊命令保留 fast path。

下面的代码片段都从还原源码中节选。为了让主线清楚，我省略了与当前机制无关的参数、类型和分支；函数名、关键判断与调用顺序保持不变。

```ts
async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (
    args.length === 1 &&
    (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')
  ) {
    console.log(`${MACRO.VERSION} (Claude Code)`)
    return
  }

  // 省略 MCP server、remote-control、daemon 等 fast path

  const { startCapturingEarlyInput } = await import('../utils/earlyInput.js')
  startCapturingEarlyInput()

  const { main: cliMain } = await import('../main.js')
  await cliMain()
}
```

这里有两个值得注意的细节。

第一，`--version` 输出版本以后就返回，不需要加载完整 CLI。第二，普通路径使用动态 `import()`，直到确定没有命中特殊分支，才加载 `main.tsx`。也就是说，“进程已经启动”和“完整 Claude Code 已经初始化”是两件事。

`remote-control` 更能说明这个区别。它会先检查 OAuth、功能开关、最低版本和组织策略，然后直接进入 `bridgeMain()`。这个分支不需要先挂载本地 REPL。因此，我们不能拿交互式启动顺序去解释所有运行模式。

## main 先给这次运行贴上标签

普通路径进入 `restored-src/src/main.tsx` 以后，仍然没有立刻向模型发请求。`main()` 首先判断当前是不是非交互模式，并写入进程级运行状态。

```ts
const cliArgs = process.argv.slice(2)
const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print')
const hasInitOnlyFlag = cliArgs.includes('--init-only')
const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'))

const isNonInteractive =
  hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY

setIsInteractive(!isNonInteractive)
initializeEntrypoint(isNonInteractive)
setClientType(clientType)

eagerLoadSettings()
await run()
```

`initializeEntrypoint()` 会把普通终端记为 `cli`，把非交互调用记为 `sdk-cli`；其他宿主也可以提前通过 `CLAUDE_CODE_ENTRYPOINT` 指定自己的身份。后续的遥测、配置、UI 和认证逻辑，就可以根据这组状态选择分支。

这里还出现了 `eagerLoadSettings()`。它会提前解析 `--settings` 和 `--setting-sources`，原因并不复杂：如果等到各个模块都开始初始化以后才决定配置来源，前面创建出来的对象可能已经读到了错误的配置。启动顺序在这里不是代码排版问题，而是状态一致性问题。

到这里，我们可以先建立一张简化地图：

`CLI 入口 → 运行模式 → 配置 → 权限与认证 → 会话 → 插件/MCP → REPL 或 Bridge → 等待 prompt`

![Claude Code 启动与引导流程手绘图](/images/posts/claude-code-source-reading-03/03-startup-and-bootstrap-handdrawn.png)

图中虚线框表示启动和请求的边界。抵达 REPL 或 Bridge，只表示宿主已经能够接收输入；真正跨过 `QueryEngine.ask`，才进入上一篇讨论的请求链路。

## setup 先把“当前项目”变成可信的运行环境

`run()` 会注册 Commander 命令并解析参数。进入默认执行分支后，源码明确要求先调用 `setup()`，再运行依赖 cwd 或 worktree 的逻辑：

```ts
// setup() must be called before any other code that depends on
// the cwd or worktree setup
const { setup } = await import('./setup.js')

const preSetupCwd = getCwd()
initBuiltinPlugins()
initBundledSkills()

const setupPromise = setup(
  preSetupCwd,
  permissionMode,
  allowDangerouslySkipPermissions,
  worktreeEnabled,
  worktreeName,
  tmuxEnabled,
  sessionId ? validateUuid(sessionId) : undefined,
)

const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd)
await setupPromise
```

这段代码不是完全串行的。没有启用 worktree 时，命令和 Agent 定义可以与 `setup()` 并行加载；启用了 worktree 时则不能这样做，因为 `setup()` 可能切换工作目录，命令和 Agent 必须从切换后的项目中读取。

我们再看 `restored-src/src/setup.ts` 的入口。它接收 cwd、权限模式、worktree 和会话 ID，说明这里准备的不是一个抽象的全局环境，而是“本次运行所在项目”的环境。

```ts
export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
): Promise<void> {
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1]
  if (!nodeVersion || parseInt(nodeVersion) < 18) {
    console.error(
      chalk.bold.red(
        'Error: Claude Code requires Node.js version 18 or higher.',
      ),
    )
    process.exit(1)
  }

  if (customSessionId) {
    switchSession(asSessionId(customSessionId))
  }

  // 后续还会准备工作目录、日志/遥测、后台钩子，
  // 并检查危险权限模式是否处在允许的环境中。
}
```

`setup()` 做的事情很多，但可以归纳为两个目的。

一个是建立运行基础，例如 Node.js 版本、工作目录、worktree、会话 ID、日志与后台服务。另一个是尽早拒绝不安全组合。例如 `bypassPermissions` 或 `--dangerously-skip-permissions` 不是只改一个布尔值；源码还会检查 root/sudo、容器、沙箱和网络条件。也就是说，权限模式既是请求阶段的工具执行规则，也是启动阶段能否继续运行的前置条件。

## 认证、信任和项目配置有先后关系

很多初始化工作都需要读配置，但并不是所有配置从进程启动的第一毫秒起就可以被信任。

交互模式会先创建 Ink root，再调用 `showSetupScreens()`。首次运行、登录、目录信任等阻塞式界面都在这一阶段处理。只有用户确认信任当前目录，REPL 才会真正挂载。源码对插件启动检查的注释尤其明确：仓库配置可能来自一个刚刚 clone 下来的项目，在用户确认之前，不能让它自动触发插件安装。

REPL 中的启动检查因此写成了一个挂载后的 effect：

```ts
useEffect(() => {
  if (isRemoteSession) return
  void performStartupChecks(setAppState)
}, [setAppState, isRemoteSession])
```

而 `performStartupChecks()` 自己还会再检查一次信任状态：

```ts
export async function performStartupChecks(
  setAppState: SetAppState,
): Promise<void> {
  if (!checkHasTrustDialogAccepted()) return

  try {
    const seedChanged = await registerSeedMarketplaces()
    if (seedChanged) {
      clearMarketplacesCache()
      clearPluginCache('performStartupChecks: seed marketplaces changed')
    }
    await performBackgroundPluginInstallations(setAppState)
  } catch (error) {
    logForDebugging(
      `Error initiating background plugin installations: ${error}`,
    )
  }
}
```

这里需要区分三个概念。

首先，内置 Plugin 和 Skill 的注册可以很早完成，因为它们来自构建物本身。其次，项目配置驱动的插件安装要等目录信任通过。最后，这些后台安装即使失败，也只记录错误，不阻塞整个 REPL 启动。

MCP 也不能简单等同于“插件启动检查”。MCP 配置、客户端和工具会在初始化及 REPL 状态中被加载、合并，`performStartupChecks()` 处理的则是受信任来源的 Marketplace 与 Plugin 后台安装。两者最后都可能增加命令或工具，但进入系统的路径并不相同。

## 恢复会话不是恢复旧进程的全部内存

接下来是会话。新会话需要一个 session ID；`--continue` 或 `--resume` 则需要从 JSONL 记录中加载已有对话，再重建能够继续运行的状态。

```ts
const result = await loadConversationForResume(
  matchedLog ?? sessionId,
  undefined,
)

const processedResume = await processResumedConversation(
  result,
  {
    forkSession: !!options.forkSession,
    sessionIdOverride: sessionId,
    transcriptPath: result.fullPath,
  },
  resumeContext,
)
```

恢复结果不只有消息。`restoreSessionStateFromLog()` 还会恢复文件历史快照、部分 attribution 状态，以及从 transcript 中提取出的 Todo 状态。`switchSession()` 则把 session ID 和 transcript 所在项目目录一起切换，避免跨 worktree 恢复时两者发生漂移。

不过，这仍然不等于把旧 Node.js 进程做了一次内存快照。旧的网络连接、计时器、React 组件实例和临时闭包不会原样回来。恢复的本质是读取持久化证据，然后重新构造本轮需要的状态。

因此，同一个“继续会话”动作里其实包含两步：先恢复可持久化的对话与项目状态，再用当前版本的代码重新建立宿主和连接。

## REPL 挂载后，还要完成首屏初始化

交互模式最终通过 `launchRepl()` 把 `App` 和 `REPL` 交给 Ink：

```tsx
export async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: RenderAndRun,
): Promise<void> {
  const { App } = await import('./components/App.js')
  const { REPL } = await import('./screens/REPL.js')

  await renderAndRun(
    root,
    <App {...appProps}>
      <REPL {...replProps} />
    </App>,
  )
}
```

挂载完成也不代表所有工作都同步结束。REPL 的 `onInit()` 会重新校验 API key，并加载 `CLAUDE.md` 和 rules 文件，把这些文件放入 `readFileState`。插件安装、IDE 状态、MCP 连通性和 Bridge 连接中还有一部分工作通过 effect 或后台任务继续执行。

这是一种有意的分层：首屏必须依赖的状态要在前面准备好，不影响用户看到界面的工作可以延后。否则一个 Marketplace 请求、插件安装或远程连接超时，就可能把整个 CLI 卡在空白屏幕上。

Bridge 也遵守类似的边界。`initReplBridge()` 会检查功能开关、OAuth、组织策略和版本条件；任何条件不满足，都可以返回 `null`，而不是阻止本地 REPL 使用。也就是说，远程控制是挂在会话上的可选能力，不是本地请求成立的必要条件。

## 到什么时刻才算启动完成

现在我们可以把启动过程重新划成四段：

1. **入口分流**：处理 `--version`、MCP server、Bridge、daemon 等 fast path，决定是否加载完整 CLI。
2. **运行环境准备**：识别交互/非交互宿主，加载配置，建立 cwd、worktree、权限、认证和会话状态。
3. **能力装配**：加载命令、Agent、Skill、Plugin 与 MCP，并对来自项目的能力施加目录信任边界。
4. **宿主就绪**：挂载 REPL，或建立 Bridge/无头输入输出通道，等待第一条输入。

第四段结束时，Claude Code 只是“可以接收请求了”。用户提交 prompt，输入经过宿主进入 `QueryEngine.ask`，才开始模型流、工具执行和下一轮推理。

这个边界很重要。冷启动慢，应该检查配置读取、项目扫描、认证、插件/MCP 连接和 UI 挂载；首个回答慢，则还要继续看模型请求、上下文构建和工具循环。把两段时间混在一起，很容易优化错地方。

## 小结

Claude Code 的启动过程不是把一串初始化函数机械地执行一遍，而是先分流运行模式，再逐步建立可信的项目环境。`setup()` 固定 cwd、worktree、权限和基础服务；会话逻辑创建或恢复可持久化状态；信任确认约束项目插件何时能够生效；REPL、Bridge 和无头模式最后接入各自的输入输出通道。

源码同时表明，有些工作必须阻塞启动，有些工作可以并行，有些工作会在首屏之后继续。判断一个初始化步骤属于哪一类，关键不在它叫不叫 `setup`，而在后续代码是否必须依赖它的结果。

本文讨论的版本边界仍是 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码。静态代码可以证明分支、调用关系和状态更新，但不能证明某次真实启动中远程请求一定成功，也不能代表每个 feature flag 都会开启。

## 留给下一篇的问题

同一套启动准备完成以后，交互式 REPL、无头模式和远程 Bridge 为什么会走向不同的运行路径？
