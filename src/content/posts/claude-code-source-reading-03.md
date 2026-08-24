---
title: "Claude Code源码解读03：如何完成引导与初始化"
published: 2026-07-20T17:10:40+08:00
description: "拆解 Claude Code 在第一次请求前完成的入口分流、配置加载、项目信任、会话恢复、能力装配与宿主挂载。"
tags: ["claude-code", "source-code", "ai-agent", "startup"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-03/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-04
---
## 回答上一篇的问题

上一篇留下的问题是，Claude Code 的 `queryLoop` 算不算 ReAct，它与经典 ReAct 又有什么区别？

从执行范式看，它可以按 ReAct 理解；从工程实现看，它又远不止 ReAct。

两者共享同一个基本回环，模型根据当前消息生成响应，遇到 `tool_use` 就执行动作，把 `tool_result` 作为新的观察结果放回消息历史，然后让模型继续推理。直到模型不再请求工具，或者流程被错误、取消、预算、上下文上限、hook 等边界截断。只看这条“推理 → 行动 → 观察 → 再推理”的主线，`queryLoop` 就是 ReAct 在编程 Agent 中的一种实现。

区别在于，经典 ReAct 描述一种方法，Claude Code 的 `queryLoop` 则是一套产品级运行时。它在模型，工具回环之上继续处理流式消息、工具并发、权限检查、结果裁剪、上下文压缩、会话状态、错误恢复与停止条件。ReAct 解释循环范式，`queryLoop` 实现安全、稳定、可恢复的运行机制。

更准确的说法是，**ReAct 是理解这条链路的简洁模型，`queryLoop` 则是围绕这条模型长出来的专用执行引擎。**

本篇把时间线从上一篇的 `QueryEngine.ask` 往前推进：在它能够被调用时，运行模式、配置、权限、项目、会话和宿主已经准备好了；这里追踪的正是第一次请求之前的启动链路。

启动阶段的关键边界是：同一条 `claude` 命令在 `claude --version`、`claude -p`、普通交互式 REPL 和 `claude remote-control` 下，并不会走完同一条初始化链路。

## 介绍本章的一些概念

- CLI 入口使用 **fast-path 分流**，`--version` 在零模块加载的情况下直接返回，实测约 0.09s（[runtime]），连启动 profiler 都不会被加载。
- 启动期**三个并发预取**并行开火，MDM 设置、macOS 钥匙串密钥、系统上下文（system prompt 组成部分），与 `main.tsx` 的模块求值窗口重叠，在 Commander preAction 中用 `Promise.all` 统一回收。
- `main.tsx` 约 **4683 行**（`wc -l` 实测），但核心引导是一条线性流水线，贴标签（`isNonInteractive`）→ `eagerLoadSettings()` → Commander 解析 → preAction（回收预取 → `init()` → 配置迁移）→ action（工具池 → `setup()` → REPL 或 `runHeadless()`）。
- 动态 `import()` 把启动成本压到最小，React、Ink、API client 等重依赖按需加载，`main.tsx` 的依赖图只对完整路径支付；入口文件因此保持"零业务逻辑"的纪律。
- 启动与请求有明确边界，第四段"宿主就绪"只是可以接收输入；冷启动慢与首个回答慢是两段不同的时间，优化方向完全不同。

## 本篇新增机制

上一篇（02）从 `QueryEngine.ask` 出发追踪一次请求的完整链路。本篇把时间线往前推，**在 `ask()` 能够被调用之前，运行模式、配置、权限、项目、会话和宿主已经准备好了**。新增机制包括，

- **fast path 分流**，`cli.tsx` 的 `main()` 先识别 `--version`、`new`、MCP server、remote-control、daemon 等参数，只有普通路径才动态加载完整 CLI。
- **并发预取**，MDM 设置与钥匙串密钥在模块求值期开火（子进程与 import 并行），`setup()` 与 `getCommands()` 在普通目录下并行。
- **信任门控**，系统上下文预取与项目驱动的插件安装都受目录信任约束；git 上下文未确认信任前宁可放弃预取。
- **性能打点**，`profileCheckpoint()` 把启动切成可观测切片，`CLAUDE_CODE_PROFILE_STARTUP=1` 输出报告。
- **持久化引导标志**，`hasCompletedOnboarding` 与 `lastOnboardingVersion` 写入 `~/.claude.json`，跨进程跳过首次 Onboarding。

## 最小心智模型｜一条时间线看懂启动

在进入任何 TypeScript 之前，先记住这条时间线。启动过程是一台决策机器，每到一个岔路口都决定**要不要加载下一个更重的世界**，能提前退出的路径不会继续加载。

```
$ claude                        $ claude -p "hello"            $ claude --version
   │  Bun 运行时启动（约 0.28s）    │                              │
   ▼                              ▼                              ▼
cli.tsx main() ──► fast-path 判定 （同左）                     直接输出版本
   │  ├─ --version ──► 零模块加载退出（约 0.09s）               （约 0.09s 退出）
   │  ├─ new / mcp / remote-control / daemon / ps ──► 各自专用入口
   │  └─ 其余 ──► 动态 import() 完整 CLI
   ▼
main.tsx 模块求值（热缓存约 0.11s）
   ├─ startMdmRawRead()        ── 预取① MDM 设置
   ├─ startKeychainPrefetch()  ── 预取② 钥匙串
   └─ React / Ink / API client / Commander 加载
   ▼
main()：贴标签（交互/非交互）──► eagerLoadSettings()
   ▼
run()：Commander 解析 ──► preAction：等待预取 ──► init() ──► runMigrations()
   ▼
action：getTools() ──► setup() ∥ getCommands()（条件并行）
   ▼
├── 非交互（-p）：runHeadless ──► QueryEngine ──► queryLoop() ──► 输出退出
└── 交互：showSetupScreens（信任/OAuth/Onboarding）──► launchRepl ──► 首条 prompt ──► queryLoop()
```

三个关键读数，**fast path 让 `--version` 不与完整 CLI 产生任何交集**；**预取与模块求值重叠，回收点几乎免费**；**信任边界决定 git 系统上下文何时才安全预取**。下面逐站展开。

## 正文｜第一次提问前，它到底做了什么

上一篇从 `QueryEngine.ask` 开始追踪请求，但当它能够被调用时，运行模式、配置、权限、项目、会话和宿主已经准备好了。你刚 clone 了一个新仓库，运行 `claude` 准备了解项目结构，还没有输入第一句 prompt。终端先短暂停在启动画面，当前目录是谁、这份仓库是否可信、账号有没有有效 token、项目 settings 是否覆盖了用户配置、哪些 MCP 和 Plugin 能进入工具池，这些问题都要先有答案。几秒后你输入"看一下这个项目的 README 和构建脚本"；模型还没有看到这句话，Claude Code 已经解析命令行、确定 cwd 和 session、读取 settings、检查认证与目录信任，并装配工具和 MCP。启动阶段最容易读错的地方就在这里，我们执行的是同一条 `claude` 命令，但 `claude --version`、`claude -p`、交互式 REPL 和 `claude new` 并不会走完同一条初始化链路。

本文讨论的版本边界仍是 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码（本机性能实测使用 2.1.220）。下面的代码片段都从还原源码中节选，省略了与当前机制无关的参数、类型和分支，函数名、关键判断与调用顺序保持不变，每条代码块都标注证据来源（`[source]` 静态源码 / `[runtime]` 本机实测）。

### 读启动源码前，先补齐这些基础概念

启动日志里常见的"等待认证""加载项目设置""连接 MCP"并不是同一个阶段，它们分别依赖入口参数、cwd、信任和配置，顺序错了，后续看到的工具池就可能属于另一个项目。先记住一条主线，**Node.js 进程先选择运行模式，再把 cwd 和配置变成可信状态，最后由 Host 接管输入并进入 Agent 循环。**

| 概念 | 它是什么 | Claude Code 为什么需要它 |
|---|---|---|
| CLI 与进程 | CLI 是通过命令行参数使用的程序；每次执行 `claude`，操作系统都会创建一个 Node.js 进程，并提供参数、环境变量、标准输入输出和当前目录。 | 不同参数可以让同一个可执行程序只输出版本、启动交互界面、处理一次请求，或者进入远程与服务模式。 |
| bootstrap、初始化与 `setup()` | bootstrap 是"把程序带到可运行状态"的整个阶段；初始化是其中各种准备动作的统称；`setup()` 只是源码中的一个具体函数。 | 启动需要先满足版本、目录、配置、权限和会话等依赖，不能把所有准备都误认为发生在一个名为 `setup` 的函数里。 |
| Host 与运行模式 | Host 是接收输入、展示输出、处理权限交互和管理生命周期的外层宿主。终端 REPL、print/SDK 和远程 Bridge 都是不同 Host。 | 它们可以复用下面的 Agent 内核，同时采用不同的输入输出方式，不必复制多套模型，工具循环。 |
| TTY、TUI 与 REPL | TTY 表示进程连接着可交互终端；TUI 是在终端中绘制的界面；REPL 原意是 Read-Eval-Print Loop。 | Claude Code 持续接收 prompt、流式展示回答、弹出权限确认，并在多轮对话之间保留状态。 |
| React 与 Ink | React 用组件、状态和 effect 描述会变化的界面；Ink 作为终端 renderer，把组件树画成终端文本。 | 消息列表、输入框、Spinner、工具进度和权限弹窗会同时变化；声明式组件比手工计算光标位置、擦除旧文本更易维护。 |
| state、render 与 effect | state 是当前界面与会话状态；render 根据 state 计算此刻应显示什么；effect 在渲染之外执行连接、读写或后台检查等副作用。 | 模型流和工具进度更新 state 后界面自动刷新；插件检查等外部动作放进 effect，避免把副作用塞进纯渲染过程。 |
| `async`、动态 `import()` 与后台任务 | `async/await` 等待异步工作；动态 `import()` 在真正需要时才加载模块；后台任务启动后继续推进。 | 网络、磁盘、MCP 和插件都可能变慢，必须依赖的结果要等待，不影响首屏的工作可以延后，fast path 不需要的模块干脆不加载。 |
| cwd、配置、信任与会话 | cwd 是当前项目目录；配置来自用户、项目或组织等不同来源；信任决定项目内容能否触发能力；会话把消息和部分状态持久化。 | 刚 clone 的仓库可能包含不可信配置，恢复的 transcript 又可能来自另一个目录。必须先确定"在哪里运行、信任什么、恢复哪段状态"。 |
| Plugin、Skill、MCP 与 Bridge | Plugin 是能力的安装与分发单元；Skill 主要提供可复用指令；MCP 用协议接入外部工具和资源；Bridge 负责把本地或远程宿主连接到会话。 | 它们都扩展体验，却进入系统的路径和安全边界不同，因此不会在启动时被同一个函数、同一个时机统一加载。 |

这里最容易误解的是 REPL 和 React。传统 REPL 读入一行表达式，求值后打印结果；Claude Code 沿用了"循环等待下一次输入"的外形，把 `Eval` 扩展为一整段 Agent 执行，组装上下文、请求模型、等待 `tool_use`、确认权限、执行工具，再把结果交还模型。React 负责根据状态计算界面，Ink 作为终端 renderer 把结果绘制到终端，effect 再处理渲染之外的异步工作。

为什么不把启动写成一个大函数？因为这里同时有依赖、信任和响应速度三种约束，配置/cwd 决定能力装配，信任决定项目内容能否生效，`--version` 等 fast path 又不应加载完整 UI。分阶段初始化、动态 `import()` 和 effect 分别把这三种约束落到代码里。因此，阅读启动代码时可以一直问四个问题，**当前是什么 Host？这一步必须阻塞吗？它依赖的配置已经可信了吗？它准备的是启动环境，还是已经进入了一次请求？**

![Claude Code 启动依赖与信任建立](/images/posts/claude-code-source-reading-03/03-bootstrap-dependencies-detail-handdrawn.png)

### 第一站｜cli.tsx 的 fast-path 分流

最外层入口是 `restored-src/src/entrypoints/cli.tsx`。它先检查参数，为特殊命令保留 fast path，再按需导入完整程序。文件头注释直接说明设计意图，**所有 import 都是动态的，`--version` 的 fast path 零导入**。

```ts
// [source] restored-src/src/entrypoints/cli.tsx —— main() 的 fast-path 与动态加载
async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Fast-path for --version/-v: zero module loading needed
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION is inlined at build time
    console.log(`${MACRO.VERSION} (Claude Code)`)
    return
  }

  // For all other paths, load the startup profiler
  const { profileCheckpoint } = await import('../utils/startupProfiler.js')
  profileCheckpoint('cli_entry')

  // …… 省略 MCP server、remote-control、daemon、bg、new、environment-runner 等 fast path

  // No special flags detected, load and run the full CLI
  const { startCapturingEarlyInput } = await import('../utils/earlyInput.js')
  startCapturingEarlyInput()
  profileCheckpoint('cli_before_main_import')
  const { main: cliMain } = await import('../main.js')
  profileCheckpoint('cli_after_main_import')
  await cliMain()
  profileCheckpoint('cli_after_main_complete')
}
```

**功能，** 这个 `main()` 是 CLI 的最外层分流器。它先处理不需要完整运行时的参数，再开始缓存用户过早输入的按键，最后动态加载普通 CLI 主程序。

**关键值，** `args` 来自 `process.argv.slice(2)`，源码不会在这里穷举所有命令，只先识别能走 fast path 的参数；`--version`、`-v`、`-V` 三个等价取值只有在参数数组恰好包含其中一个时才输出版本并提前 `return`；`profileCheckpoint('cli_entry')` 是启动性能打点的第一个锚点，`--version` 分支在它之前返回，因此连 profiler 都不加载；`startCapturingEarlyInput()` 在完整 CLI 动态加载前开始缓存终端输入，避免模块加载期间的按键丢失；`cliMain()` 仅当前面的 fast path 都未结束进程时才会被加载和等待。

两个细节值得注意。第一，`--version` 输出版本后立即返回，完整 CLI 保持未加载状态。第二，普通路径使用动态 `import()`，特殊分支全部排除后才加载 `main.tsx`，进程启动早于完整 Claude Code 初始化。`remote-control` 更能说明这个区别，它先检查 OAuth、功能开关、最低版本和组织策略，然后直接进入 `bridgeMain()`，不需要先挂载本地 REPL；`daemon`、`ps|logs|attach|kill` 同样各走各的专用入口。`claude new` 是另一个极端，`new`、`list`、`reply` 命中 TEMPLATES 功能开关下的模板任务分支，动态加载 `templatesMain(args)` 后以 `process.exit(0)` 收尾，源码注释说明了原因，模板选择器挂载的 FleetView Ink TUI 会留下阻止进程自然退出的事件循环句柄，只有显式 `process.exit` 才能保证命令结束后进程干净退出。因此，我们不能拿交互式启动顺序去解释所有运行模式。

### 第二站｜main.tsx 模块求值期的三个并发预取

`main.tsx` 约 4683 行（`wc -l` 实测），核心引导却是一条线性流水线。它的第一屏 import 是全文件最精心的部分，文件头注释把预取策略写在最前面，这些副作用必须在其他 import 之前运行。

```ts
// [source] restored-src/src/main.tsx:1-20 —— 模块求值期的并发预取
// These side-effects must run before all other imports:
// 1. profileCheckpoint marks entry before heavy module evaluation begins
// 2. startMdmRawRead fires MDM subprocesses (plutil/reg query) so they run in
//    parallel with the remaining ~135ms of imports below
// 3. startKeychainPrefetch fires both macOS keychain reads (OAuth + legacy API
//    key) in parallel — isRemoteManagedSettingsEligible() otherwise reads them
//    sequentially via sync spawn inside applySafeConfigEnvironmentVariables()
//    (~65ms on every macOS startup)
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';
profileCheckpoint('main_tsx_entry');
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';
startMdmRawRead();
import { ensureKeychainPrefetchCompleted, startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js';
startKeychainPrefetch();
// …… 之后才是 React、Ink、Commander、API client 等约 150 个 import
```

三个并发预取各管一件事，

**预取① MDM 设置**（`startMdmRawRead`），`restored-src/src/utils/settings/mdm/rawRead.ts` 用一个最小依赖模块（只引 `child_process`、`fs`、`mdmConstants`）把 macOS 的 `plutil` 与 Windows 的 `reg query` 子进程提前打出去，结果之后用 `getMdmRawReadPromise()` 回收。

**预取② 钥匙串密钥**（`startKeychainPrefetch`），`restored-src/src/utils/secureStorage/keychainPrefetch.ts` 的注释给出了精确的成本账，`isRemoteManagedSettingsEligible()` 会**顺序**同步读取两个钥匙串条目，OAuth token（"Claude Code-credentials"，约 32ms）和 legacy API key（"Claude Code"，约 33ms），每次 macOS 启动合计约 65ms，

```ts
// [source] restored-src/src/utils/secureStorage/keychainPrefetch.ts —— 两个子进程并行
export function startKeychainPrefetch(): void {
  if (process.platform !== 'darwin' || prefetchPromise || isBareMode()) return

  // Fire both subprocesses immediately (non-blocking). They run in parallel
  // with each other AND with main.tsx imports. The await in Promise.all
  // happens later via ensureKeychainPrefetchCompleted().
  const oauthSpawn = spawnSecurity(getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX))
  const legacySpawn = spawnSecurity(getMacOsKeychainStorageServiceName())

  prefetchPromise = Promise.all([oauthSpawn, legacySpawn]).then(([oauth, legacy]) => {
    // Timed-out prefetch: don't prime. Sync read/spawn will retry with its
    // own (longer) timeout. Priming null here would shadow a key that the
    // sync path might successfully fetch.
    if (!oauth.timedOut) primeKeychainCacheFromPrefetch(oauth.stdout)
    if (!legacy.timedOut) legacyApiKeyPrefetch = { stdout: legacy.stdout }
  })
}
```

注意两个细节，非 darwin 平台和 `--bare` 模式直接跳过（`--bare` 的定位就是不读钥匙串）；**超时的子进程不写入缓存**，exit 44（条目不存在）是合法的"没有 key"，可以预取为 `null`，但超时只说明"可能拿不到"，此时不能把 `null` 写入缓存去遮蔽真实密钥，同步路径会用自己的（更长）超时重试。

**预取③ 系统上下文（system prompt 组成部分）**，`prefetchSystemContextIfSafe()` 预取 git 状态等会进入 system prompt 的内容。它没有在前两个的位置开火，而是被**信任边界**约束，git 命令可以通过 `core.fsmonitor`、`diff.external` 等配置执行任意代码，所以只有非交互模式（信任隐式成立）或交互模式已确认信任时才执行，

```ts
// [source] restored-src/src/main.tsx:354-380 —— 系统上下文预取的信任门控
function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession();
  if (isNonInteractiveSession) {
    void getSystemContext();   // -p 模式：信任隐式成立，直接预取
    return;
  }
  const hasTrust = checkHasTrustDialogAccepted();
  if (hasTrust) {
    void getSystemContext();   // 交互模式：仅信任已确认后预取
  }
  // 否则不预取——等待信任对话框
}
```

此外，`getSystemPrompt()` 自身也在用 `Promise.all` 并行装配 system prompt 的三个部分（skill 命令、输出风格、环境信息），这是"系统提示词组成部分"预取在请求侧的体现（`restored-src/src/constants/prompts.ts:457`）。

### 第三站｜profileCheckpoint｜把启动切成可观测的切片

预取之外，`main.tsx` 模块求值期做的第一件事是性能打点。`startupProfiler.ts` 提供两种模式，采样的 Statsig 日志（`STATSIG_LOGGING_SAMPLED`）和详细报告（`CLAUDE_CODE_PROFILE_STARTUP=1`），

```ts
// [source] restored-src/src/utils/startupProfiler.ts:65 —— 打点与阶段定义
export function profileCheckpoint(name: string): void {
  if (!SHOULD_PROFILE) return
  const perf = getPerformance()
  perf.mark(name)
  if (DETAILED_PROFILING) {
    memorySnapshots.push(process.memoryUsage())
  }
}

// Phase definitions for Statsig logging: [startCheckpoint, endCheckpoint]
const PHASE_DEFINITIONS = {
  import_time: ['cli_entry', 'main_tsx_imports_loaded'],
  init_time: ['init_function_start', 'init_function_end'],
  settings_time: ['eagerLoadSettings_start', 'eagerLoadSettings_end'],
  total_time: ['cli_entry', 'main_after_run'],
} as const
```

**关键值，** `SHOULD_PROFILE` 模块加载时一次性决定（`DETAILED_PROFILING || STATSIG_LOGGING_SAMPLED`），未被采样的用户不付任何打点成本。`memorySnapshots` 用数组而不是按名字的 Map，注释说明原因，`loadSettingsFromDisk_start` 这类打点会触发多次（init 一次、插件重置 settings 缓存后又一次），Map 会被第二次覆盖。详细报告写到 `~/.claude/startup-perf/<sessionId>.txt`，包含每个 checkpoint 的相对时间、增量与内存快照；`profileReport()` 幂等，只报告一次。这些 checkpoint 贯穿整条启动链（`cli_entry` → `main_tsx_entry` → `run_function_start` → `preAction_*` → `init_function_*` → `action_*`），也是 `tengu_startup_perf` 遥测事件（`startupProfiler.ts:191`）的字段。

### 第四站｜main() 先给这次运行贴上标签

普通路径进入 `main.tsx` 的 `main()` 后，第一步是判断当前是否为非交互模式，并写入进程级运行状态，

```ts
// [source] restored-src/src/main.tsx:797-834 —— 交互/非交互标签
const cliArgs = process.argv.slice(2);
const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print');
const hasInitOnlyFlag = cliArgs.includes('--init-only');
const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'));
const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY;

if (isNonInteractive) {
  stopCapturingEarlyInput();
}
const isInteractive = !isNonInteractive;
setIsInteractive(isInteractive);
initializeEntrypoint(isNonInteractive);
```

**功能，** 把原始命令行和终端能力压缩成"交互式还是非交互式"这一进程级标签，标签确定后再预加载配置并进入 Commander 命令分发。

**关键值，** `process.stdout.isTTY` 为 `false` 或 `undefined` 时，`!process.stdout.isTTY` 都会把当前进程归入非交互路径，所以管道里的 `claude` 天然是 print 模式。`setIsInteractive()` 写入会话状态；`initializeEntrypoint()` 设置 `CLAUDE_CODE_ENTRYPOINT`，普通终端记为 `cli`，非交互调用记为 `sdk-cli`；其他宿主（VSCode、SDK、GitHub Action）也可以提前通过环境变量指定自己的身份。后续的遥测、配置、UI 和认证逻辑都根据这组状态选择分支。

标签贴完后是 `eagerLoadSettings()`（`main.tsx:502`），提前解析 `--settings` 和 `--setting-sources` 参数，确保后续模块从同一配置来源创建对象，启动顺序在这里直接维护状态一致性。这一步前后都有 checkpoint（`eagerLoadSettings_start/end`）。

到这里，我们可以先建立一张简化地图，

`CLI 入口 → 运行模式 → 配置 → 权限与认证 → 会话 → 插件/MCP → REPL 或 Bridge → 等待 prompt`

![Claude Code 启动与引导流程手绘图](/images/posts/claude-code-source-reading-03/03-startup-and-bootstrap-handdrawn.png)

图中虚线框表示启动和请求的边界。抵达 REPL 或 Bridge，只表示宿主已经能够接收输入；真正进入 `query()` / `queryLoop()`，才跨进上一篇讨论的请求链路。

### 第五站｜Commander 解析与 preAction｜回收预取、init() 与配置迁移

`run()` 注册 Commander 命令并解析参数（`run_commander_initialized` 打点）。关键在 **preAction hook**，Commander 只在真正执行命令时触发它（显示 help 时不触发），启动初始化被挂在钩子里，

```ts
// [source] restored-src/src/main.tsx:907-917 —— preAction：回收预取、init、迁移
program.hook('preAction', async thisCommand => {
  profileCheckpoint('preAction_start');
  // Await async subprocess loads started at module evaluation (lines 12-20).
  // Nearly free — subprocesses complete during the ~135ms of imports above.
  // Must resolve before init() which triggers the first settings read
  // (applySafeConfigEnvironmentVariables → getSettingsForSource('policySettings')
  // → isRemoteManagedSettingsEligible → sync keychain reads otherwise ~65ms).
  await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
  profileCheckpoint('preAction_after_mdm');
  await init();
  profileCheckpoint('preAction_after_init');
  // …… initSinks()、--plugin-dir 接线、runMigrations()、loadRemoteManagedSettings() …
});
```

这段代码是并发预取的设计收口，预取在模块求值期开火，**回收点**在 preAction，`init()` 的首次 settings 读取（会触发同步钥匙串读）必须发生在预取完成之后。源码注释明确写出不这样做的代价，否则每次 macOS 启动多花约 65ms 同步读。本机实测这次等待约 65ms（见"启动性能基准"），与注释预测几乎完全一致，子进程与 import 窗口高度重叠时，回收确实接近免费。

preAction 中还执行 `runMigrations()`（`main.tsx:326`），以 `CURRENT_MIGRATION_VERSION = 11` 为闸，版本不匹配时顺序跑 11 个同步迁移（模型别名、replBridge→remoteControl 等），然后 `saveGlobalConfig` 写入新版本号；异步的 changelog 迁移 fire-and-forget。版本闸的价值，**避免每次启动都做 11 次 saveGlobalConfig 锁+重读**。

### 第六站｜init()｜首次运行、配置初始化与网络准备

`init()` 在 `restored-src/src/entrypoints/init.ts`，被 `memoize` 包裹，保证无论从哪个入口（preAction、SDK、插件重置）调用都只执行一次。它先把配置系统、安全环境变量和退出清理立起来，再准备网络，

```ts
// [source] restored-src/src/entrypoints/init.ts:57-79 —— init() 的配置与环境准备
export const init = memoize(async (): Promise<void> => {
  const initStartTime = Date.now()
  profileCheckpoint('init_function_start')
  try {
    enableConfigs()                       // 校验并启用配置系统
    profileCheckpoint('init_configs_enabled')
    // Apply only safe environment variables before trust dialog
    // Full environment variables are applied after trust is established
    applySafeConfigEnvironmentVariables() // 信任对话框前只应用"安全"环境变量
    // Apply NODE_EXTRA_CA_CERTS from settings.json to process.env early,
    // before any TLS connections. Bun caches the TLS cert store at boot
    // via BoringSSL, so this must happen before the first TLS handshake.
    applyExtraCACertsFromConfig()         // 第一次 TLS 握手前注入 CA 证书
    setupGracefulShutdown()               // 注册退出清理
    // …… populateOAuthAccountInfoIfNeeded、detectCurrentRepository、
    //     initializeRemoteManagedSettingsLoadingPromise、recordFirstStartTime、
    //     configureGlobalMTLS、configureGlobalAgents …
    preconnectAnthropicApi()              // 预连接：TCP+TLS 握手与后续工作重叠
    // …… 最后 profileCheckpoint('init_function_end')
```

**关键点，** ① **信任对话框之前只应用"安全"环境变量**，`applySafeConfigEnvironmentVariables()` 与信任建立后的 `applyConfigEnvironmentVariables()` 是两次调用，项目 settings 里的 `PATH`、`LD_PRELOAD` 等危险变量要等目录信任通过才能生效（`-p` 模式信任隐式成立，在 action 中直接应用完整变量集）。② `applyExtraCACertsFromConfig()` 必须在**任何 TLS 连接之前**执行，Bun 在启动时通过 BoringSSL 缓存证书存储，迟了就来不及。③ `preconnectAnthropicApi()` 在 init 末尾开火，让约 100-200ms 的 TCP+TLS 握手与后续 action handler 的工作重叠。④ 远程托管设置与策略限额的 loading promise 在这里提前初始化（带超时防死锁），供插件 hooks 等系统 await。

首次运行的 Onboarding 不在这里。`showSetupScreens()`（`restored-src/src/interactiveHelpers.tsx:104`）读取全局配置，只有 `theme` 已有有效值**并且** `hasCompletedOnboarding` 为真才会跳过 Onboarding 组件，判断用的是逻辑或，只设置其中一个字段还不够，

```tsx
// [source] restored-src/src/interactiveHelpers.tsx:104-124 —— Onboarding 的跳过条件
export async function showSetupScreens(root, permissionMode, allowDangerouslySkipPermissions, commands?, claudeInChrome?, devChannels?): Promise<boolean> {
  const config = getGlobalConfig()
  let onboardingShown = false
  if (!config.theme || !config.hasCompletedOnboarding) {
    onboardingShown = true
    const { Onboarding } = await import('./components/Onboarding.js')
    await showSetupDialog(root, done => (
      <Onboarding onDone={() => { completeOnboarding(); void done() }} />
    ), { onChangeAppState })
  }
  // 后面继续处理目录信任、MCP 审批和 API Key 确认
  return onboardingShown
}
```

`theme` 的合法值是 `auto`、`dark`、`light`、`light-daltonized`、`dark-daltonized`、`light-ansi`、`dark-ansi`，新配置默认 `dark`。`config.hasCompletedOnboarding` 为 `false` 或 `undefined` 都会显示引导；损坏或手工编辑的配置如果让 `null` 进入这段 JavaScript 判断，也会因为是假值而显示引导。`completeOnboarding()` 通过 `saveGlobalConfig` 只追加两个字段（`hasCompletedOnboarding: true`、`lastOnboardingVersion: MACRO.VERSION`），不整文件覆盖，

```json
// [runtime] ~/.claude.json（本机实际配置的最小形态；已有文件必须保留其他字段）
{
  "theme": "dark",
  "hasCompletedOnboarding": true
}
```

**配置作用，** 这两个字段共同让 `!config.theme || !config.hasCompletedOnboarding` 为假，从而不加载首次 Onboarding。默认全局文件是 `~/.claude.json`，源码还兼容 Claude 配置目录下旧的 `.config.json`；设置了 `CLAUDE_CONFIG_DIR` 或使用带 OAuth 后缀的配置时实际文件名会变化，修改前应以 `getGlobalClaudeFile()` 的路径规则为准。部分中国网络环境无法直接访问 Anthropic 服务时，用户通常会先配置兼容的 API 网关或云服务再启动 Claude Code，这时首次 Onboarding 里的官方登录路径可能无法完成，需要的就是这个持久化标志。

三个看似相近的分支不要混用，`IS_DEMO` 会让整个 `showSetupScreens()` 提前返回，但它是 Demo 模式；`CLAUBBIT` 只跳过后面的信任与审批子段，并不跳过 Onboarding；非交互的 `-p` 根本不会进入 `showSetupScreens()`。对需要保留交互体验的用户，真正对应首次引导状态的仍是 `hasCompletedOnboarding`。

### 第七站｜setup()｜把"当前项目"变成可信的运行环境

preAction 之后，default action 明确要求先调用 `setup()`，再运行依赖 cwd 或 worktree 的逻辑。调用点使用**条件并行**，普通目录中，命令和 Agent 定义可以与 `setup()` 并行加载；worktree 模式则先由 `setup()` 切换工作目录，再从切换后的项目读取，

```ts
// [source] restored-src/src/main.tsx:1918-1934 —— setup() 与 commands/agents 并行
const preSetupCwd = getCwd();
// Register bundled skills/plugins before kicking getCommands() —— 纯内存操作，<1ms
initBuiltinPlugins();
initBundledSkills();
const setupPromise = setup(preSetupCwd, permissionMode, allowDangerouslySkipPermissions, worktreeEnabled, worktreeName, tmuxEnabled, sessionId ? validateUuid(sessionId) : undefined, worktreePRNumber, messagingSocketPath);
const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd);
const agentDefsPromise = worktreeEnabled ? null : getAgentDefinitionsWithOverrides(preSetupCwd);
commandsPromise?.catch(() => {});
agentDefsPromise?.catch(() => {});
await setupPromise;
```

**关键参数，** `preSetupCwd` 是调用 `setup()` 前的工作目录，启用 worktree 后最终 cwd 可能与它不同；`permissionMode` 用户可配置集合包含 `default`、`plan`、`acceptEdits`、`dontAsk`、`bypassPermissions`，功能开关启用时还可能包含 `auto`，内部类型另有 `bubble` 但不在用户可配置集合中；`allowDangerouslySkipPermissions` 为 `true` 时仍要通过 `setup()` 的环境与安全条件检查，检查失败会终止启动；`worktreeEnabled` 为 `true` 时 `setup()` 可能创建或切换 worktree，因此不提前调用 `getCommands()`（commands 需要 post-chdir 的 cwd），`false` 时命令加载可以并行开始。

`setup()` 本体在 `restored-src/src/setup.ts:56`，做的事情很多，可以归纳为两个目的，建立运行基础，以及尽早拒绝不安全组合。

**建立运行基础，**

```ts
// [source] restored-src/src/setup.ts:56-84 —— Node 版本门槛与会话切换
export async function setup(cwd, permissionMode, allowDangerouslySkipPermissions, worktreeEnabled, worktreeName, tmuxEnabled, customSessionId?, worktreePRNumber?, messagingSocketPath?): Promise<void> {
  // Check for Node.js version < 18
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1]
  if (!nodeVersion || parseInt(nodeVersion) < 18) {
    console.error(chalk.bold.red('Error: Claude Code requires Node.js version 18 or higher.'))
    process.exit(1)
  }
  // Set custom session ID if provided
  if (customSessionId) {
    switchSession(asSessionId(customSessionId))
  }
  // …… UDS 消息服务（--bare 跳过）、终端备份恢复（仅交互）、setCwd()、
  //     captureHooksConfigSnapshot()（hooks 快照，防静默修改）、
  //     initializeFileChangedWatcher(cwd)、worktree 创建（含 tmux）、
  //     initSessionMemory()、lockCurrentVersion() …
}
```

- **hooks 注册**，`captureHooksConfigSnapshot()` 在 `setCwd()` 之后执行，必须先 `setCwd` 才能从正确目录加载 hooks；随后 `initializeFileChangedWatcher(cwd)` 同步读快照启动文件变更监听。插件 hooks 的预加载交给 `setup()` 里的 `loadPluginHooks()`（动态 import 后 fire-and-forget），并被 `setupPluginHookHotReload()` 挂上热重载。
- **worktree**，git 检查 → 解析主仓库根 → 创建 worktree（`createWorktreeForSession`）→ `process.chdir` 到 worktree 路径 → `setProjectRoot` → 重新捕获 hooks 快照（因为 settings 缓存是原目录的）。非 git 仓库必须有 `WorktreeCreate` hook 才能用 `--worktree`。

**尽早拒绝不安全组合，** `bypassPermissions` 或 `--dangerously-skip-permissions` 会触发 root/sudo 检查（非沙箱环境下 root 直接拒绝）、Docker/沙箱/网络条件检查（Docker 且无外网才允许）。权限模式既是请求阶段的工具执行规则，也是启动阶段能否继续运行的前置条件。`setup()` 尾部还执行 `prefetchApiKeyFromApiKeyHelperIfSafe()`（同样信任门控）、`initSinks()`（挂遥测 sink 并排空排队事件）和 `tengu_started` 信标事件（最早可靠的"进程已启动"信号）。

### 第八站｜工具池、信任与首屏

`setup()` 完成后，工具池在 `getTools(toolPermissionContext)` 处装配（`main.tsx:1868`），命令与 Agent 定义在 `Promise.all` 处回收（`main.tsx:2029`）。然后交互模式创建 Ink root，调用 `showSetupScreens()`，首次运行、登录、目录信任等阻塞式界面都在这一阶段处理。**只有用户确认信任当前目录，REPL 才会真正挂载**（`main.tsx:2241`）。

REPL 中的启动检查写成了一个挂载后的 effect，

```ts
// [source] restored-src/src/screens/REPL.tsx —— 挂载后触发启动检查
useEffect(() => {
  if (isRemoteSession) return
  void performStartupChecks(setAppState)
}, [setAppState, isRemoteSession])
```

而 `performStartupChecks()` 自己还会再检查一次信任状态，

```ts
// [source] restored-src/src/interactiveHelpers.tsx（约 150 行起）—— 信任门槛内的后台安装
export async function performStartupChecks(setAppState): Promise<void> {
  if (!checkHasTrustDialogAccepted()) return
  try {
    const seedChanged = await registerSeedMarketplaces()
    if (seedChanged) {
      clearMarketplacesCache()
      clearPluginCache('performStartupChecks: seed marketplaces changed')
    }
    await performBackgroundPluginInstallations(setAppState)
  } catch (error) {
    logForDebugging(`Error initiating background plugin installations: ${error}`)
  }
}
```

这里需要区分三个概念，内置 Plugin 和 Skill 的注册可以很早完成（`initBuiltinPlugins()` / `initBundledSkills()` 在 `setup()` 前就是纯内存操作），因为它们来自构建物本身；项目配置驱动的插件安装要等目录信任通过；后台安装即使失败，也只记录错误，不阻塞 REPL 启动。MCP 也不能简单等同于"插件启动检查"，MCP 配置、客户端和工具在初始化及 REPL 状态中被加载合并，`performStartupChecks()` 处理的则是受信任来源的 Marketplace 与 Plugin 后台安装，两者最后都可能增加命令或工具，但进入系统的路径并不相同。

### 第九站｜恢复会话、挂载 REPL 或进入 Print 模式

会话恢复与 REPL 挂载在 action 后段汇合。新会话需要一个 session ID；`--continue` 或 `--resume` 则需要从 JSONL 记录中加载已有对话，再重建能够继续运行的状态，

```ts
// [source] restored-src/src/main.tsx —— 会话恢复的两步
const result = await loadConversationForResume(matchedLog ?? sessionId, undefined)
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

**功能，** 把会话恢复拆成"读取持久化记录"和"重建当前运行状态"两步。`loadConversationForResume()` 负责找到并解析 transcript（`matchedLog` 为 `null`/`undefined` 时才回退到 `sessionId`），`processResumedConversation()` 再处理 `forkSession`（`!!options.forkSession` 把假值统一变成 `false`）、`sessionIdOverride`、`transcriptPath` 和 `resumeContext`（当前 cwd、初始 AppState、Agent 定义）。`restoreSessionStateFromLog()` 还会恢复文件历史快照、部分 attribution 状态和从 transcript 中提取的 Todo 状态；`switchSession()` 则把 session ID 和 transcript 所在项目目录一起切换，避免跨 worktree 恢复时两者发生漂移。恢复的本质是读取持久化证据，再构造本轮需要的状态；旧网络连接、计时器、React 组件实例和临时闭包都由新进程重新创建。因此，同一个"继续会话"动作里其实包含两步，先恢复可持久化的对话与项目状态，再用当前版本的代码重新建立宿主和连接。

交互模式最终通过 `launchRepl()` 把 `App` 和 `REPL` 交给 Ink，

```tsx
// [source] restored-src/src/replLauncher.tsx:12 —— 动态挂载 App 与 REPL
export async function launchRepl(root, appProps, replProps, renderAndRun): Promise<void> {
  const { App } = await import('./components/App.js')
  const { REPL } = await import('./screens/REPL.js')
  await renderAndRun(root, <App {...appProps}>
    <REPL {...replProps} />
  </App>)
}
```

**功能，** 延迟加载顶层 `App` 和终端 `REPL` 组件，把 REPL 包在共享应用状态容器中，再交给注入的渲染函数运行。挂载完成也不代表所有工作都同步结束，REPL 的 `onInit()` 会重新校验 API key，并加载 `CLAUDE.md` 和 rules 文件放入 `readFileState`；插件安装、IDE 状态、MCP 连通性和 Bridge 连接中还有一部分工作通过 effect 或后台任务（`startDeferredPrefetches()`）继续执行。这是一种有意的分层，首屏必须依赖的状态要在前面准备好，不影响用户看到界面的工作可以延后，否则一个 Marketplace 请求或远程连接超时就可能把整个 CLI 卡在空白屏幕上。Bridge 也遵守类似的边界，`initReplBridge()` 检查功能开关、OAuth、组织策略和版本条件，任一条件失败都会返回 `null`，本地 REPL 随后继续运行。非交互 `-p` 路径则完全不同，它不挂 REPL，直接 `runHeadless()`（`main.tsx:2826`）进入无头执行，跳过 workspace trust 对话框（`-p` 的 help 文本明确说明这一点）。

### 到什么时刻才算启动完成

现在可以把启动过程重新划成四段，

1. **入口分流**，处理 `--version`、MCP server、Bridge、daemon、模板任务等 fast path，决定是否加载完整 CLI。
2. **运行环境准备**，识别交互/非交互宿主，加载配置，建立 cwd、worktree、权限、认证和会话状态。
3. **能力装配**，加载命令、Agent、Skill、Plugin 与 MCP，并对来自项目的能力施加目录信任边界。
4. **宿主就绪**，挂载 REPL，或建立 Bridge/无头输入输出通道，等待第一条输入。

第四段结束时，Claude Code 只是"可以接收请求了"。用户提交 prompt 后，交互式 REPL 直接进入 `query()`，无头宿主则先经过 `QueryEngine` 的会话包装；两条路径最终都进入 `queryLoop()`，才开始模型流、工具执行和下一轮推理。这个边界很重要，冷启动慢，应该检查配置读取、项目扫描、认证、插件/MCP 连接和 UI 挂载；首个回答慢，则还要继续看模型请求、上下文构建和工具循环。把两段时间混在一起，很容易优化错地方。

## 启动性能基准

2026-08-04 在 macOS（arm64，本机）实测。`claude` 为 2.1.220（Bun 原生二进制），对照 `codex-cli` 0.146.0 与 `aider` 0.86.2；用 `/usr/bin/time -p` 取 real 时间，各跑 3 次取中位数（[runtime]），

| 命令 | 实测（real，中位数） | 说明 |
|---|---|---|
| `claude --version` | 约 0.09s（0.10 / 0.09 / 0.09） | **fast path**，Bun 运行时 + cli.tsx 自身，零业务模块 |
| `codex --version` | 约 0.06s（0.06 / 0.07 / 0.06） | 对照，同为单二进制版本输出 |
| `aider --version` | 约 1.4s（1.26 / 1.43 / 1.63） | 对照，Python 解释器 + 依赖导入的启动成本 |
| `claude doctor` | 约 0.7s（0.61 / 0.66 / 0.72） | 完整启动但不调模型，近似"全启动不含 API"（热缓存） |
| `claude -p "reply with exactly: hello"` | 约 14s（14.1 / 14.9） | 完整启动 + API 往返；其中启动部分不足 1s |

**读数，** `aider --version` 比 `claude --version` 慢约 16 倍，一个只打印版本号的 Python 程序也要为解释器和依赖导入付费，这正是 fast path 存在的理由。`claude --version` 与 `claude -p` 的差距在 150 倍量级，而其中"启动"只占 1s 左右，实测 `-p` 全程约 14s 里，模型响应占 13s 以上。要看清"完整初始化"内部花在哪，用官方打点，

```bash
# [runtime] 官方打点命令：本地实际运行并阅读性能报告
CLAUDE_CODE_PROFILE_STARTUP=1 claude -p "reply with exactly: hello"
cat "$(ls -t ~/.claude/startup-perf/*.txt | head -1)"
```

2026-08-04 本机实测报告的前几行（时间相对进程启动，热缓存），

```text
// [runtime] ~/.claude/startup-perf/<sessionId>.txt 实测片段（2.1.220，macOS）
[+ 279.184ms] (+279.184ms) profiler_initialized | RSS: 219.9MB
[+ 279.212ms] (+  0.029ms) cli_entry
[+ 288.665ms] (+  9.452ms) cli_before_main_import
[+ 399.356ms] (+110.691ms) main_tsx_entry            ← 模块图求值（React/Ink/API client）
[+ 399.390ms] (+  0.034ms) main_tsx_imports_loaded
[+ 404.026ms] (+  0.824ms) preAction_start
[+ 469.023ms] (+ 64.997ms) preAction_after_mdm        ← 等待 MDM+keychain 预取回收（约 65ms）
[+ 469.402ms] (+  0.380ms) init_function_start
[+ 589.627ms] (+120.225ms) init_function_end          ← 配置/安全环境变量/网络准备
[+ 591.753ms] (+  2.131ms) preAction_after_migrations
[+ 593.946ms] (+  0.822ms) action_handler_start
[+ 645.925ms] (+ 51.979ms) action_after_input_prompt
[+ 732.669ms] (+ 76.506ms) action_after_setup
[+ 891.065ms] (+155.434ms) action_commands_loaded
[+ 900.269ms] (+  0.279ms) before_connectMcp         ← 启动完成，进入请求阶段
```

**读数，** Bun 运行时约 0.28s；`main.tsx` 的 150 余个 import 约 0.11s（热缓存），三个预取在此期间并行开火；preAction 回收预取约 65ms，与源码注释预测的"~65ms"几乎完全一致，说明预取与 import 窗口高度重叠时回收确实接近免费；`init()` 约 0.12s；到 action 装配工具池、命令和 MCP 时约 0.9s，启动即告完成。同一台机器冷缓存时模块求值会明显更慢（报告中的相对占比比绝对值更值得看；同机此前一次冷缓存实测 `main_tsx_entry` 曾到约 +1.2s）。RSS 从 220MB 涨到 325MB，这也是"启动"与"请求"边界的一个侧面证据。

## 源码映射表

| 阶段 | 文件 | 关键函数/位置 | 本篇要点 | 后续章节 |
|---|---|---|---|---|
| 入口分流 | `src/entrypoints/cli.tsx` | `main()`、`feature('TEMPLATES')`、`templatesMain` | `--version` 零模块加载；`new`/`list`/`reply` 模板任务分支 `process.exit(0)` 收尾 | 04 运行模式、37 Bridge |
| 完整 CLI | `src/main.tsx` | 模块求值期 (1-20)、`main()` (797)、`run()` (884)、preAction (907)、`runMigrations()` (326)、`eagerLoadSettings()` (502) | 三并发预取；Commander；init；迁移；setup；REPL/Print | 05/06、32 Ink TUI |
| 性能打点 | `src/utils/startupProfiler.ts` | `profileCheckpoint()` (65)、`PHASE_DEFINITIONS` (49) | `CLAUDE_CODE_PROFILE_STARTUP=1` 出报告；Statsig 采样；`tengu_startup_perf` (191) | 38 可观测性 |
| 首次初始化 | `src/entrypoints/init.ts` | `init()` (57) | 安全环境变量/CA/预连接；memoize 幂等 | 35 配置与开关 |
| 预取① | `src/utils/settings/mdm/rawRead.ts` | `startMdmRawRead()` | plutil/reg query 子进程并行 | 35 远程托管设置 |
| 预取② | `src/utils/secureStorage/keychainPrefetch.ts` | `startKeychainPrefetch()`、`ensureKeychainPrefetchCompleted()` | 两个 security 子进程；超时不落缓存 | 36 认证 |
| 预取③ | `src/main.tsx` | `prefetchSystemContextIfSafe()` (360) | git 上下文信任门控 | 16 系统提示词 |
| 项目环境 | `src/setup.ts` | `setup()` (56) | Node 版本、session、worktree、hooks 快照、危险权限检查 | 18 hooks、26 worktree |
| 首屏与信任 | `src/interactiveHelpers.tsx` | `showSetupScreens()` (104)、`performStartupChecks()` | Onboarding 跳过条件；信任门槛内后台安装 | 39 Onboarding |
| REPL 挂载 | `src/replLauncher.tsx` | `launchRepl()` (12) | 动态加载 App/REPL 交给 Ink | 32 Ink TUI |

> 证据说明，表中函数名与关键取值均来自 2.1.88 source map 还原源码，静态可确认；`main.tsx` 行数为 `wc -l` 实测（4683 行）。沿用 00 章建立的约定，路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。

## 设计决策

**为什么用 fast-path？** `--version` 是 CI、脚本和工具链中最频繁调用的 `claude` 命令，它只需要一个构建期内联的版本字符串。cli.tsx 的注释原话是 "Fast-path for --version has zero imports beyond this file"。把这个决策推到极致，所有不需要完整 CLI 的命令（mcp、remote-control、daemon、ps、new 等）都挤在 cli.tsx 里用 `feature()` 内联判断 + 动态 import，**"是否加载完整 CLI"的决策被提前到第一个模块**，未启用的功能分支还会在构建期被 DCE 掉。代价是入口文件必须保持"零业务逻辑"的纪律，否则任何一条路径都会污染其他路径的加载时间。

**为什么用动态 `import()`？** 模块求值有真实成本，热缓存下 `main.tsx` 的 import 图实测约 0.11s，冷缓存时明显更高。动态 import 让这笔成本只在真正需要时支付，是构建期 `feature()` 死代码消除的运行期另一半。另一个动机是防御，`startupProfiler.ts` 的注释提到 keychainPrefetch 故意不引 `macOsKeychainStorage.ts`（它会拖进 execa → human-signals → cross-spawn 的同步模块初始化），**最小依赖是刻意的，不是巧合**。代价是错误处理路径变长，每个 fast path 都要自己 await + 兜底，因此 `init()` 被设计成 `memoize` 幂等，任何入口调用都安全。

**为什么并发预取，风险是什么？** 顺序读取的成本账写在源码注释里，两个钥匙串条目串行约 65ms/每次 macOS 启动；MDM plutil/reg query 类似；git 上下文是进程派生。把它们提前到模块求值期，与 import 窗口重叠，preAction 用 `Promise.all` 统一回收。**竞态风险**是这套设计真正的难点，`init()` 的首次 settings 读取（`applySafeConfigEnvironmentVariables → isRemoteManagedSettingsEligible`）会同步读钥匙串，如果预取尚未完成，同步路径会再 spawn 一次（重复工作 + 可能读到"一半"的 MDM 状态）。三个修复缺一不可，① 预取结果保存在幂等 Promise 中，`ensureKeychainPrefetchCompleted()` 可多次 await；② preAction 强制在 `init()` 前 `await Promise.all([...])`，建立确定性的 happens-before；③ 超时的预取不写缓存，让同步路径用更长超时重试，避免"把可能存在的 key 用 null 遮蔽"。第三路预取（git 上下文）还叠加了安全竞态，git 命令可执行任意代码（`core.fsmonitor`、`diff.external`），所以它被信任边界门控，未信任前宁可放弃预取。

**为什么引导状态持久化到全局配置？** 内存标志无法跨进程记忆，每次启动都是新进程。拒绝内存态，选择 `~/.claude.json` 持久化，并记录 `lastOnboardingVersion` 供版本升级后重新引导；Onboarding 判断用逻辑或，`theme` 与 `hasCompletedOnboarding` 必须同时有效才跳过，只满足一个仍会展示引导。

## 练习

**练习 1，对比 fast path 与完整启动**

```bash
# [runtime] 练习命令：本地实际运行对比启动耗时
cd /tmp
time claude --version        # fast path：期望约 0.1s，零模块加载
time claude -p "hello"       # 完整启动 + API 往返：数十秒量级
time claude doctor           # 完整启动但不调模型：约 1s，看初始化本身的成本
```

**练习 2，用官方打点拆解完整启动**

```bash
# [runtime] 练习命令：官方打点拆解完整启动
CLAUDE_CODE_PROFILE_STARTUP=1 claude -p "hello"
cat "$(ls -t ~/.claude/startup-perf/*.txt | head -1)"
```

对照 `PHASE_DEFINITIONS` 四个阶段找瓶颈，`import_time`（cli_entry → main_tsx_imports_loaded）、`settings_time`、`init_time`、`total_time`。再试一次 `claude -p "hello"`（热缓存），对比 `total_time` 的差异，它基本就是磁盘/进程派生的缓存收益。然后回答正文里的四个问题，当前是什么 Host？这一步必须阻塞吗？它依赖的配置已经可信了吗？它准备的是启动环境，还是已经进入了一次请求？

**练习 3，Onboarding 标志实验** 备份 `~/.claude.json`，临时把 `hasCompletedOnboarding` 改成 `false`，运行 `claude` 观察首次引导是否重现；改回 `true` 后确认跳过。注意不要整文件覆盖。

## 自测

<details>
<summary>1. `--version` 跳过了哪些加载？</summary>

除 `cli.tsx` 自身以外的所有模块，`startupProfiler`、`earlyInput`、`main.tsx` 及其整个依赖图（React、Ink、API client、Commander……）。`--version` 分支在任何动态 `import()` 之前 `return`，`MACRO.VERSION` 在构建期内联，所以连一个业务模块都不会求值。这也是它实测约 0.09s 的原因。

</details>

<details>
<summary>2. 启动期三个并发预取分别是什么？为什么第三个要等信任确认？</summary>

① **MDM 设置**（`startMdmRawRead()`），plutil/reg query 子进程；② **macOS 钥匙串密钥**（`startKeychainPrefetch()`），OAuth token 与 legacy API key 两个 `security` 子进程并行，共约 65ms；③ **系统上下文 / system prompt 组成部分**（`prefetchSystemContextIfSafe()` → `getSystemContext()`，git 状态等）。前两个在 main.tsx 模块求值期开火，与 import 窗口重叠；第三个受信任边界门控，git 命令可通过 `core.fsmonitor`、`diff.external` 执行任意代码，未确认目录信任前预取 git 上下文等于把不可信代码提前放进启动路径，所以只有 `-p` 模式（信任隐式成立）或信任已确认时才执行。

</details>

<details>
<summary>3. MDM 与钥匙串并行预取的竞态风险是什么？</summary>

`init()` 的 `applySafeConfigEnvironmentVariables()` 首次读 settings 时，`isRemoteManagedSettingsEligible()` 会同步读钥匙串。若预取未完成，同步路径会再 spawn 一次（每启动约 65ms 的重复工作），且 MDM 原始输出可能读到中途状态，导致策略值陈旧。修复三件套，幂等 Promise + preAction 在 `init()` 前 `await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()])` 建立 happens-before；超时不写缓存，让同步路径用自己的（更长）超时重试。

</details>

## 回顾（折叠）

<details>
<summary>启动是一条"决策机器"流水线，能提前退出的绝不加载更多</summary>

Claude Code 的启动先分流运行模式，再逐步建立可信的项目环境。`cli.tsx` 用 fast path 拦截不需要完整 CLI 的命令（`--version` 实测 0.09s）；`main.tsx`（4683 行）在模块求值期并行开火三个预取，MDM、钥匙串、git 系统上下文，用 `profileCheckpoint` 切成可观测切片，Commander 的 preAction 在 `init()` 前统一回收；`setup()` 固定 cwd、worktree、权限和基础服务；信任确认约束项目插件与 git 上下文何时生效；REPL、Bridge 和无头模式最后接入各自的输入输出通道。

源码同时表明，有些工作必须阻塞启动，有些可以并行，有些会在首屏之后继续。判断一个初始化步骤属于哪一类，关键不在它叫不叫 `setup`，而在后续代码是否必须依赖它的结果。

留给下一篇的问题，`claude -p` 是 `--print` 的短写，让 Claude Code 从参数或 stdin 接收 prompt，完成 Agent 执行，把结果写到 stdout 后退出。但它跳过普通终端 REPL、把权限确认交给配置或外部宿主，并绕过 workspace trust 对话框。当它无法像普通 REPL 一样停下来交互时，工具权限由谁决定；带 `-p` 与不带 `-p`，只是输出形式不同，还是运行模式已经变了？

</details>

## 留给下一篇的问题

`claude -p "解释这个项目"` 中的 `-p` 是 `--print` 的短写。最常见的用法是让 Claude Code 从参数或 stdin 接收一个 prompt，完成 Agent 执行，把结果写到 stdout，然后退出。默认输出是文本，也可以通过 `--output-format` 选择 `json` 或 `stream-json`；其中 `stream-json` 还要求同时启用 `--verbose`。这种模式很适合 Shell 管道、脚本和 CI，也能作为 SDK 持续交换结构化消息的底层通道。

不过，`-p` 的控制流远多于“回答完自动退出”，它跳过普通终端 REPL、将权限确认交给配置或外部宿主，并绕过 workspace trust 对话框。

你有用过 `claude -p` 命令，并注意过下面这个问题吗，当它无法像普通 REPL 一样停下来与你交互时，工具权限由谁决定；而对 Claude Code 来说，带 `-p` 与不带 `-p`，究竟只是输出形式不同，还是运行模式已经变了？

## 参考资料

- [Claude Code 快速入门](https://code.claude.com/docs/en/quickstart)
- [Claude Code 安装与更新](https://code.claude.com/docs/en/installation)
- [Claude Code CLI 参考（非交互模式与 print 模式）](https://code.claude.com/docs/en/cli-reference)
- [How to Build a ReAct Agent](https://blog.n8n.io/react-agent/)
- [What Is a ReAct Agent?](https://zapier.com/blog/react-agent/)
