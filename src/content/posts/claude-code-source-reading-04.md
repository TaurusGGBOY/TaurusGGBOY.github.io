---
title: "Agent Harness 04｜运行模式与入口"
published: 2026-07-21T11:01:53+08:00
description: "比较四种 Agent Harness 如何让交互终端、脚本、RPC、App Server 与远程宿主复用同一套运行时。"
tags: ["agent-harness", "claude-code", "codex-cli", "pi", "deepseek"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-04/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-28
---
## Claude Code

![Claude Code 先在 CLI 快速入口处分流，再由交互 Host 或结构化 Headless Host 接入查询循环](/images/posts/claude-code-source-reading-04/agent-theme-04-claude-code-handdrawn.png)

*入口决定谁接收输入、谁回答权限、谁消费事件；`query()` / `queryLoop()` 才是 REPL 与 headless 重新汇合的执行边界。*

Claude Code 的第一层分流发生在完整 Commander 主路径之前。`restored-src/src/entrypoints/cli.tsx` 会先识别 Chrome/Computer Use MCP native host、daemon worker、Remote Control、daemon、后台 session 管理等窄入口，命中后动态加载对应模块并返回。Remote Control 还要经过登录、版本、feature 与组织 policy 检查；daemon、后台 session 等入口也受 build feature 控制。每条分支最终是否可用，由对应构建开关和运行时门禁共同决定。

没有命中 fast path 才进入 `main.tsx`。这里有两组不同的标签：`isNonInteractive` 决定控制流，`-p`、`--init-only`、`--sdk-url` 或 stdout 不是 TTY 都会令它为真；`clientType` 则记录宿主身份，源码可见值包括 `github-action`、三个 SDK 标记、VS Code、Desktop、local-agent、remote 与默认 `cli`。前者回答“是否挂交互 UI”，后者回答“谁启动了这次会话”，不能用一个反推另一个。

普通交互路径把 React/Ink REPL 作为 Host：它拥有键盘、消息列表、权限对话框、取消与后续输入。非交互路径创建 headless store 后进入 `runHeadless()`。CLI 的 `--input-format` 只有 `text` 与 `stream-json`，默认 `text`；`--output-format` 有 `text`、`json`、`stream-json`，默认 `text`。`text` 最终只打印成功结果文本，`json` 在执行结束后输出一个 result 对象，`stream-json` 则把结构化消息逐行写出，而且在 2.1.88 中要求 `--verbose`。`--sdk-url` 又进一步要求输入和输出都为 `stream-json`，因为外部宿主要双向发送 prompt、权限控制和状态消息。

`stream-json` 的记录单位是 SDK message，而不是固定的一枚 LLM token。`runHeadless()` 迭代的 assistant、system、control request/response、stream event、最终 result 等类型有各自语义；`--include-partial-messages` 决定是否把更细的 partial message 带入这条流。普通 `json` 与 `text` 则持续消费完整迭代器，只在结束后投影 `lastMessage`。消费者以 result 或状态类型判断任务完成，chunk 间隔与数量不构成完成信号。

两条 Host 最终复用 `query()` / `queryLoop()` 的模型—工具—`tool_result` 语义，各自保留独立的会话外壳。REPL 维护交互状态并直接消费 query event；headless/SDK 前面还有 `StructuredIO` 与 `QueryEngine`，把 stdin、WebSocket 或 SDK control message 转成统一输入，再把执行事件投影给宿主。2.1.88 的 `QueryEngine` 注释仍把 REPL 接入列为未来阶段，当前边界可以概括为“查询内核共享、Host 状态机分开”。MCP server 又是另一条更窄的旁路：它让外部 MCP client 调用 Claude Code 暴露的内置工具，`CallTool` 直接进入 `tool.call()`，不运行完整 Agent 查询循环。

## Codex CLI

![Codex CLI 把 TUI、Exec、App Server 与 MCP Server 作为不同适配器接到共享 runtime](/images/posts/claude-code-source-reading-04/agent-theme-04-codex-cli-handdrawn.png)

*Codex 的关键边界是 app-server 协议：TUI 默认在进程内连接它，也可通过本地 daemon 或远端 transport 连接同一种线程接口。*

Codex 的顶层入口直接写在 `codex-rs/cli/src/main.rs`。没有子命令时，`cli_main()` 调用 `run_interactive_tui()`；`exec`（别名 `e`）进入非交互 runner；`review` 先把 review 参数装进一个 `ExecCli` 再复用 exec；`app-server` 与 `mcp-server` 分别启动两种服务端表面。登录、插件、sandbox、session 管理等也是同一个 multitool binary 的命令，但不属于本章所说的 Agent Host。

这个固定提交中的 TUI 通过 app-server client 访问运行时。`codex-rs/tui/src/lib.rs` 用 `AppServerTarget` 表示 `Embedded`、`LocalDaemon` 与 `Remote`：默认情况启动 `InProcessAppServerClient`，显式 `--remote` 可连接 WebSocket 或 Unix endpoint；满足条件时也可探测默认 daemon socket。三者最后都交给 `AppServerSession`，TUI 通过 thread/start、turn/start、审批请求与 notification 驱动界面。内嵌模式省去跨进程传输，同时保留 typed request/event 边界。

`codex exec` 面向一次性、可脚本化运行。默认由 human event processor 把配置摘要、进度和最终答案渲染到终端；`--json` 改成 stdout JSONL。`ThreadEvent` 的顶层类型在源码中是 `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.started`、`item.updated`、`item.completed` 与 `error`。它按 thread/turn/item 生命周期输出，而不是照搬模型提供商的 token chunk。`--output-schema <FILE>` 约束的是模型最终响应形状，`--output-last-message <FILE>` 另存最后一条消息；这两项都不是 JSONL 传输格式的别名。

`codex app-server` 提供更完整、长生命周期的宿主协议。`AppServerCommand` 的 `--listen` 源码可见取值是默认 `stdio://`、`unix://` 或 `unix://PATH`、`ws://IP:PORT` 与 `off`，`--stdio` 是默认 transport 的显式快捷方式。IDE、桌面端、TUI 或远程控制可以围绕 Thread、Turn、Item、审批与配置建立自己的 UI；运行在同进程还是 socket 后面，是 deployment 选择，不改变这套协议对象。

`codex mcp-server` 则是给另一个 MCP client 使用的窄入口，并通过 stdio 启动。它与 app-server 都是“服务端工具”，但职责不同：app-server 是 Codex 产品宿主的完整控制面，MCP server 是让外部 Agent 把 Codex 当能力调用的适配面。第三方 teardown 常用“app-server 是产品边界，MCP 是工具边界”来概括；本地固定提交支持这个结构判断，但第三方文章给出的最新方法数量、SDK 世代和远程产品能力不能直接搬进本章。

## Pi

![Pi 先创建一个 AgentSessionRuntime，再把它交给交互、文本、JSON 或 RPC Host](/images/posts/claude-code-source-reading-04/agent-theme-04-pi-handdrawn.png)

*Pi 的 CLI 四种出口共享 AgentSessionRuntime；SDK 则绕过 CLI 模式判定，由 Node 宿主直接拥有 AgentSession。*

Pi 把自动模式选择集中在 `packages/coding-agent/src/main.ts` 的 `resolveAppMode()`。优先级是：显式 `--mode rpc` 得到 `rpc`，显式 `--mode json` 得到 `json`；否则只要指定 `-p`，或 stdin、stdout 任意一个不是 TTY，就进入 `print`；其余才是 `interactive`。因此把输出接进管道本身就会改变 Host，`--mode text` 也不会强制恢复 TUI。

模式确定后，Pi 仍先解析最终 session cwd、信任、资源、模型和工具，再创建一个 `AgentSessionRuntime`。到最后一公里才分派：RPC 交给 `runRpcMode(runtime)`，交互交给 `new InteractiveMode(runtime).run()`，文本和 JSON 交给 `runPrintMode(runtime, { mode })`。这使 session 切换、扩展绑定、模型选择与工具执行留在共享 runtime，Host 只拥有输入、输出和生命周期策略。

文本 print 是最窄的出口。它按顺序 `await session.prompt()` 处理初始消息和额外消息，最后读取 session state 的末条 assistant message；stop reason 为 `error` 或 `aborted` 时写 stderr 并返回 1，否则只把 text blocks 写到 stdout。JSON 模式仍走同一个 `runPrintMode()`，但会订阅 session event，并把 `toJsonEvent(event)` 逐行输出；它不是一个最终 JSON 对象。两种模式都在 finally 中 unsubscribe、dispose runtime、flush stdout，所以“一次性”是 Host 明确拥有的退出协议。

RPC 是另一种寿命模型。`runRpcMode()` 持续读取 stdin JSONL，按 command 的可选 `id` 返回 `type: "response"`，同时在 stdout 推送 session event 与 extension UI request。也就是说，一条 stdout 流里至少有相关响应、异步事件和 UI 请求三类消息；调用方要按 `type` 与 `id` 路由，不能把收到一条 response 当成整个 Agent 已退出。RPC 的 stdin 还长期保留给命令，所以 CLI 不会在这个模式读取普通 piped prompt 或接受 `@file` 参数。

SDK 把边界再向内移动。`createAgentSession()` 是导出的进程内 API，调用方可提供 `cwd`、`agentDir`、`resourceLoader`、`sessionManager`、`modelRuntime`、模型、thinking level、tools 与 custom tools；缺省时 SDK 自己创建对应服务。Node 宿主直接订阅 `session` event，调用 `prompt()`、`steer()`、`followUp()`、`abort()` 或 `dispose()`，不经过 `resolveAppMode()`。因此 Pi 的四个 CLI 出口与 SDK 不应画成五个平级命令：前四个是同一个 binary 对 runtime 的 Host 选择，SDK 是在库边界直接取得 runtime/session 控制权。

## DeepSeek Harness

![DeepSeek Harness 的 CLI 先选择 Profile，Profile 内的插件再决定 Web、Headless 或自定义 Host](/images/posts/claude-code-source-reading-04/agent-theme-04-deepseek-harness-handdrawn.png)

*DSH 的 launcher 只选择可运行组合；Web、Headless 与自定义 Host 的真正行为来自该 profile 挂载的应用插件。*

DeepSeek Harness 把 UI 选择交给 profile 组合。`apps/cli/src/args.ts` 的 launcher 只拥有 `--profile`、可重复 `--patch`、两种 config dump 与 `plugin` 管理命令；`web` 是 `--profile web` 的硬编码别名。解析器在遇到第一个不属于 launcher 的 token 后，把剩余参数原样交给 booted app。因此 `dsh --profile web --port 8080` 中的 `--port` 属于 Web 插件，launcher flag 必须写在它前面；自定义 profile 可以注入另一套 app parser，静态 CLI 只负责传递其参数。

`apps/cli/src/bin.ts` 体现了这条边界：合法 invocation 只有 `profile`、`plugin` 与 `dump-config` 三类，分别动态 import profile boot、pnpm forwarder 或 config dumper。`--dump-default-config` 只合成 bundle layers，`--dump-config` 还包含 profile、home 与 CLI overlay；二者都拒绝 app 参数，也不会调用 `runProfile()`。所以 config dump 是“看组合后退出”，不是一种无模型的 Agent Host。

`runProfile()` 负责把选中的 bundle 与 patch 合成 Cordis tree，并把 `args` 作为不可变 `cmdlineArgs` service 提供给树内插件。此后进程寿命归组合所有：Web profile 挂 HTTP/browser Host，持续等待浏览器 session；Headless profile 不挂 Web server，而是挂 one-shot runner；自定义 profile 可以通过自己的 bundles 形成其他表面。launcher 只在 signal、boot failure 或 app 请求退出时做统一回收。

Headless 的结束语义在 `packages/bundle/headless` 中写得很具体。startup 插件把所有位置参数连接成一条非空 task；runner 等整棵 Loader tree settled 后创建 fresh persisted Agent，记录本轮起始 seq，提交 user message，等待 `agent.whenIdle()`，flush Session，再从本轮事件中取最后一条非空 assistant text。stdout 始终是答案通道；`turn/end.reason.kind === 'completed'` 才请求退出 0，其他原因退出 1，error 还会把 code/message 写到 stderr。这里的 `whenIdle()` 与 session flush 才是 one-shot 完成边界，而不是 LLM stream 暂时没有新 chunk。

另外两组“模式”位于 Host 之内。当前 Web/Headless bundle 可通过 `DSH_TOOLS_MODE` 选择 `native`、`code` 或 `both`，它改变模型看到的是原生 tools、代码 runtime 入口还是两者；Web 的 `minimal` agent preset 又只改变会话级 system prompt 与模型侧工具组合。Host 由 profile 选择，tool presentation 与 agent preset 分别作用于模型工具表面和会话级 Agent 组合。排障时分别记录这三层，才能把观察到的行为归到具体变量。
