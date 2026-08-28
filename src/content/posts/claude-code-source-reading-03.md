---
title: "Agent Harness 03｜启动与初始化"
published: 2026-07-20T17:10:40+08:00
description: "比较 Claude Code、Codex CLI、Pi 与 DeepSeek Harness 如何完成配置加载、信任检查、资源装配和运行时启动。"
tags: ["agent-harness", "claude-code", "codex-cli", "pi", "deepseek"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-03/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-28
---
## Claude Code

![Claude Code 在模块求值期预取设置与凭证，再跨过信任边界装配宿主](/images/posts/claude-code-source-reading-03/agent-theme-03-claude-code-handdrawn.png)

*Claude Code 把启动关键路径压成两组并行工作：先让 I/O 与模块加载重叠，再让 setup 与命令、Agent 定义加载重叠。*

Claude Code 的启动不是从 `setup()` 才开始。`restored-src/src/main.tsx` 的最前面先执行 `profileCheckpoint('main_tsx_entry')`，紧接着调用 `startMdmRawRead()` 与 `startKeychainPrefetch()`，之后才继续加载 Commander、React、服务和工具模块。两次调用都只负责“发车”，结果留到 Commander 的 `preAction` 中由 `Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()])` 回收。第三方启动分析常把它概括成“把 I/O 藏进模块求值窗口”；本地源码能确认这个控制流，但不能把别人的 200ms、240ms 当成固定性能承诺。

配置也有一个刻意提前的入口。`eagerLoadSettings()` 只抢先解析 `--settings` 和 `--setting-sources`：前者指定额外 settings 文件，后者控制允许加载的 settings 来源。它们必须在 `init()` 第一次读取配置前生效。这里不能外推成“所有配置都已经完成”，因为账户、远程策略、项目环境和运行模式仍在后续阶段继续确定。

`preAction` 是完整命令共享的初始化屏障。它等待两项预取，调用幂等的 `init()`，挂接日志与 analytics sinks，处理 `--plugin-dir`，执行 `runMigrations()`；远程 managed settings、policy limits 和 settings sync 则以非阻塞任务启动。也就是说，看到 `preAction` 返回，只能说明命令可以进入自己的 action，并不代表所有后台数据已经刷新完。

默认会话 action 随后才装配宿主。源码先在内存中注册 bundled plugins 与 Skills，再同时启动 `setup()`、`getCommands(cwd)` 和 `getAgentDefinitionsWithOverrides(cwd)`。`setup()` 负责最终 cwd/worktree、权限与会话级基础设施；如果启用了 worktree，cwd 会变化，命令和 Agent 定义便不能提前并行，必须等 setup 后按新目录读取。模型解析也被明确放在 setup 之后，避免在信任建立前触发 AWS 等认证路径。

因此 Claude Code 的“就绪”是分层的：`--version` 等窄命令可以在完整宿主之前退出；普通交互和 `-p` 共享前半段配置与能力装配，但最终由不同 Host 接管；`--bare` 又会跳过 hooks、插件同步、自动记忆、后台预取、钥匙串与 CLAUDE.md 自动发现等能力。它先用入口信息缩小工作范围，再把保留下来的 I/O 放进已有的计算窗口；项目能力仍要等信任与 cwd 确定后才装配。

## Codex CLI

![Codex CLI 的 Session spawn 通过两次并行汇合建立线程服务](/images/posts/claude-code-source-reading-03/agent-theme-03-codex-cli-handdrawn.png)

*Codex CLI 先拿到完整 Config，再由 ThreadManager 和 Session::spawn 把持久化、认证、MCP、指令与 Skills 汇合成一条可提交的线程。*

Codex CLI 的 core 启动边界不是 TUI，而是 `ThreadManager` 能否交付一个已配置的 `CodexThread`。`ThreadManager::new()` 先持有跨线程复用的 models、environment、skills、plugins、MCP、extensions、auth 与 thread store 等服务；`StartThreadOptions::new(config)` 的默认历史是 `InitialHistory::New`，provider model fallback 默认为 `false`，history/source 等可选项保持 `None`，调用方可以在 TUI、exec、app-server 或子 Agent 路径覆盖它们。

`spawn_thread()` 先处理 New、Cleared、Forked、Resumed 等历史来源。恢复已有 thread 时，如果同一 conversation 已在内存运行，会核对 rollout path 后直接复用；否则它收集 user instructions、父线程 trace、originator、environment selections 等输入，再调用 `Session::spawn(SessionSpawnArgs { ... })`。这一步说明 Config 不是启动结果，而是 Session 初始化的输入。

`Session::spawn` 的第一道汇合屏障是一个 `tokio::join!`。三个分支同时进行：创建或恢复 thread persistence、获取本地 state DB、取得 auth 并计算 MCP runtime projection。它们完成后，Session 才能确定 rollout、telemetry、shell、environment 与核心 services。并行只是缩短等待链，不表示失败互不影响；例如持久化初始化错误仍会中断 thread 创建。

环境解析完成后还有第二道并行屏障：`AgentsMdManager.refresh()` 按最终环境刷新指令，`warm_plugins_and_skills_for_session_init()` 预热插件与 Skills，thread store 同时查询线程名。Skills 错误会记录日志而不必全部阻断；随后 `install_initial_mcp_runtime()` 发布 MCP runtime，并调用 `validate_required_servers()`。如果 required server 校验失败，这个函数返回错误，thread 创建不会进入最终注册阶段。

最后，`finalize_thread_spawn()` 读取 session event queue，并强制第一条事件必须是 `EventMsg::SessionConfigured`。只有拿到它，manager 才把 `CodexThread` 放进内存 map 并返回 `NewThread`。core 用这个类型事件定义线程初始化完成；TUI 是否已经画完首屏，仍属于另一层宿主状态。

## Pi

![Pi 先确定 session cwd 和信任，再装载资源并把扩展绑定到已挂载的 TUI](/images/posts/claude-code-source-reading-03/agent-theme-03-pi-handdrawn.png)

*Pi 把资源发现绑定到最终 session cwd：项目资源按会话目录解析，全局资源仍从 agentDir 注入，交互 UI 则先挂载再触发扩展生命周期。*

Pi 的 `packages/coding-agent/src/main.ts` 先解析运行模式和窄命令。`--version`、export、auth、package、config 等路径可以提前结束；普通路径在 interactive、print、json、rpc 之间选择 Host。接着执行 migrations，并通过 `SessionManager` 决定本次真正使用的 session cwd。resume 或显式 session 可能来自另一个项目，所以源码刻意不在进程初始 cwd 上提前创建完整 runtime services。

最终 cwd 确定后，Pi 才创建该目录绑定的 `SettingsManager`、`DefaultResourceLoader` 与 `ModelRuntime`。如果项目存在需要信任的本地资源，`ResourceLoader.reload()` 先把 `projectTrusted` 设为 `false`，只装载全局、用户和临时 CLI 扩展；信任回调得到答案后，再按该状态重载 settings。这样项目扩展不能先执行、再让用户补做信任选择。

正式 reload 解析 package sources 和 CLI 额外路径，装载 Extensions，随后构建 Skills、prompt templates、themes、AGENTS.md/CLAUDE.md 与 SYSTEM/APPEND_SYSTEM prompt。项目资源按最终 session cwd 发现，`~/.pi/agent` 等全局资源仍由 agentDir 提供。禁用项也分别存在，`noExtensions`、`noSkills`、`noPromptTemplates`、`noThemes`、`noContextFiles` 不会被一个笼统的“无扩展模式”替代。

`createAgentSession()` 再把资源变成一个可运行 Agent。已有 session 优先恢复当时的 provider/model；恢复失败才回退到 settings 默认和 provider 可用模型。thinking level 也先尝试恢复，再回退默认，并按模型能力 clamp。工具列表默认是 `read`、`bash`、`edit`、`write`，但 `options.tools`、settings 的 default tools、`noTools` 与 `excludeTools` 都能改变最终集合，所以静态源码不能声称每次启动必然有同一组工具。

交互模式还有一个看似反常但很实用的顺序：`InteractiveMode.init()` 先挂载 TUI，让输入框能够反馈启动状态；fd/rg 等托管工具准备完后才启用完整按键与提交处理；随后 `rebindCurrentSession()` 把已经加载的扩展绑定到当前 session，并发出 `session_start`。这样 session_start handler 可以使用交互对话框，同时项目资源的信任结果已经确定。Pi 的就绪点不是“窗口出现”，而是 resource loader、AgentSession、rebind 与输入处理四者都完成。

## DeepSeek Harness

![DeepSeek Harness 从环境快照和 Profile 层合成插件树，等待激活审计后才宣布就绪](/images/posts/claude-code-source-reading-03/agent-theme-03-deepseek-harness-handdrawn.png)

*DeepSeek Harness 的启动产物不是一个写死的 Agent 对象，而是一棵经过分层合成、依赖激活和失败审计的 Cordis 插件树。*

DeepSeek Harness 先冻结启动环境。`loadLayeredEnv()` 保存继承环境、invocation cwd 的 `.env` 与 Harness home `.env` 的来源快照，优先级是继承环境高于项目文件，项目文件高于 home 文件；文件层只填充尚未存在的变量。决定代码、指令来源或网络启动方式的 bootstrap-only 变量禁止放进 `.env`，必须由启动进程显式 export。它也不会沿 cwd 父目录搜索，环境发现范围只有调用目录和 Harness home。

随后 CLI 选择 profile。`loadProfile()` 从 `dsh.profile.bundles` 读取有序 bundle 名称，每个 bundle 必须在自己的 package.json 声明 `dsh.bundle.patch`；缺少声明不是“空插件”，而是启动配置错误。`web` 与 `headless` 有 shipped template，可在第一次使用时自动初始化；其他 profile 不存在时会明确要求先通过 plugin 命令创建。

`composeProfile()` 从空 entry list 开始叠层：先按 manifest 顺序应用每个 bundle patch，再应用 profile 自己的 `cordis.patch.yml`，然后是 `$DSH_HOME/cordis.patch.yml`，最后是命令行 `--patch` overlays；launcher 还可能追加 shipped preset roots 与 telemetry hard-disable patch。后层命中同一 row id 时替换整份 config，不是深合并，所以一个看似只改一项的 patch 也必须重述要保留的字段。

真正的 `boot()` 创建根 `Context`，提供 `dshHomePath`，安装 Cordis `Loader`，执行 host prepare，将冻结的 environment 与 cmdline services 放进 Context，然后挂载合成后的 include tree。Loader 按服务依赖让插件进入生命周期，`await ctx.get('loader')?.await()` 等待整棵树结算，`assertEntriesActivated()` 再拒绝无 fiber、FAILED 或仍因依赖缺失而 PENDING 的 enabled entries。只有这两道检查通过，调用方才拿到可运行 Context。

失败路径与成功路径同样属于启动协议。host prepare 失败标记为 `host preparation failed`，插件树导入或 activation 失败标记为 `plugin tree failed to load`；catch 会先 `await ctx.fiber.dispose()`，让已经挂载的终端、watcher、子插件和 effects 释放，再保留最深 cause 的 stack 抛出。与另外三套 Harness 相比，它把“初始化完成”定义得最声明式：不是某个构造函数返回，而是配置选中的插件树已经全部进入可接受生命周期状态。
