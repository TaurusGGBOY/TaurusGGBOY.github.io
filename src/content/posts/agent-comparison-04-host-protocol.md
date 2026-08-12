---
title: "Agent源码对比04｜Agent 怎样从终端内核变成可嵌入运行时"
published: 2026-08-12T10:20:00+08:00
updated: 2026-08-12
description: "比较 Claude Code、Codex App Server 与 Pi 的宿主入口、协议生命周期、事件、背压和恢复边界。"
tags: ["agent-source-comparison", "agent-runtime", "ai-agent", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-comparison-04-host-protocol/agent-comparison-cover-handdrawn.png"
imagePosition: "left"
---

# Agent源码对比04｜Agent 怎样从终端内核变成可嵌入运行时

上一篇最后留下的问题是：**如果 IDE 或脚本想在工具执行前显示审批、执行中渲染增量、执行后恢复同一个 Thread，它需要从 Agent 内核拿到什么协议？**

答案是：它需要的不只是一个 `run(prompt)` 函数，而是一条能够表达生命周期的控制面。宿主至少要知道会话是谁、一次 turn 何时开始、工具/审批/文件变更何时出现、如何发送新输入、如何取消，以及连接断开后能不能恢复。

外部资料对 Codex App Server 的描述把这个问题讲得很直白：App Server 同时是 JSON-RPC 协议和承载长期 Codex threads 的进程；一个客户端请求可能产生多个事件，服务端也可能反向请求 approval。本文把这个观察与 Claude Code 和 Pi 的源码入口对照，重点不是协议名，而是**谁拥有控制平面**。

## 回答上一篇的问题

安全边界只有能被宿主观察和响应，才会变成可用的产品体验。Codex 的 App Server 文档把 approval、item 生命周期和 turn 完成事件都放到双向协议里；Pi 的 RPC 模式则明确使用 stdin/stdout 上的 LF 分隔 JSONL；Claude Code 的前面系列已经展示了 print/headless、SDK、MCP 和 Bridge 如何共享 Query Core。

因此，上一章的“允许/拒绝”不是最后一步。它必须有一个宿主可消费的事件表示，并且需要一个确定的恢复边界，否则 IDE 只能看到“命令突然没了”。

## 介绍本章的一些概念

- **Host**：拥有输入、渲染、审批或生命周期管理权的外部程序。
- **Control plane**：宿主与 Agent 之间传输请求、事件、审批、取消和恢复操作的协议层。
- **Handshake**：连接建立后协商客户端信息、能力、版本、feature flag 或通知订阅。
- **Bidirectional stream**：客户端发请求、服务端既能返回事件，也能反向请求用户输入/审批。
- **Backpressure**：生产事件的一方不能无限快地压过消费方；队列满时要暂停、拒绝或重试。
- **Thread / Turn / Item**：Codex 对长期会话、一次工作和中间产物的协议级划分。
- **RPC / SDK**：RPC 以进程间消息为主，SDK 直接把运行时对象嵌入调用方；二者的错误、取消和状态边界不应混为一谈。

参数和传输的可选值必须从源码/README 里读：Codex app-server 的 stdio 是默认 JSONL，WebSocket 标注为 experimental/unsupported，Unix socket 是本地控制面传输，`off` 表示不暴露本地 transport；Pi RPC 使用严格 LF 分隔，不能把 Unicode 行分隔符误当成 framing；Claude 的入口组合由 CLI/SDK/MCP/Bridge 的具体构造路径决定。

## 一张宿主控制面图

![Claude Code、Codex 与 Pi 的宿主控制面](/images/posts/agent-comparison-04-host-protocol/agent-comparison-04-host-protocol-handdrawn.png)

三套系统都可以被外部驱动，但它们公开的“最小稳定对象”不一样。

## Claude Code：多个入口共享 Query Core

Claude Code 的入口不是一个统一的 JSON-RPC app-server。前面系列的 `runtime-modes`、headless/SDK、MCP 和 Bridge 文章已经说明：交互式 REPL、print 模式、SDK 调用、MCP server 与远程桥接，会把不同形态的输入转换成 Query Core 能处理的参数和事件。

这是一种“内核共享优先”的设计。宿主通常提供 prompt、权限回调、会话状态和输出消费，`queryLoop()` 负责模型和工具控制流。好处是终端和 SDK 不必各自复制一套 Agent；代价是外部宿主要理解 Claude 自己的消息/事件类型、权限回调和会话恢复边界，不能只依赖一个通用的 Thread/Turn/Item schema。

如果要比较它和 Codex 的区别，关键不是说 Claude “没有协议”，而是说**协议边界更分散在入口适配层和 SDK/MCP 传输中**。这让产品入口可以快速叠加，但做一个独立 IDE 客户端时，需要先确定采用哪条入口路径。

## Codex：App Server 把生命周期做成协议原语

Codex 的 `codex-rs/app-server/README.md` 先定义传输，再定义会话原语。默认 stdio 是 newline-delimited JSON；WebSocket 每帧一个 JSON-RPC 消息但标为实验性；Unix socket 使用 WebSocket upgrade；`--listen off` 则不暴露本地 transport。

协议生命周期很有层次：

1. 连接后只能先发送一次 `initialize`，再发 `initialized`；重复或提前请求会收到错误。
2. `thread/start` 创建新会话，`thread/resume` 恢复已存会话，`thread/fork` 复制历史到新 thread；`ephemeral: true` 表示内存临时 thread。
3. `turn/start` 把用户输入加入目标 thread，并返回 turn；真正开始运行时发 `turn/started`。
4. `item/started`、`item/*/delta`、`item/completed` 让宿主可以先渲染，再增量更新，最后收敛到终态。
5. `turn/completed` 表示这一轮结束；`turn/interrupt` 允许宿主主动打断。

`InitializeParams.capabilities` 里有可选能力和通知 opt-out。`optOutNotificationMethods` 是精确方法名列表，未知名称会被忽略，不支持通配符；这个小细节很适合写进宿主实现的测试，而不是只在 README 中一带而过。

背压也被协议明确化。app-server 在 ingress、request processing 和 outbound write 之间使用 bounded queues，入口饱和时返回 JSON-RPC `-32001`，并建议客户端使用带 jitter 的指数退避。这里的错误不是 Agent 失败，而是宿主与服务之间的流量控制信号。

## Pi：四种模式，同一套 session/SDK 内核

Pi 的 coding-agent README 把入口分成四种：interactive、print/JSON、RPC、SDK。交互模式把终端编辑器、消息、工具结果和扩展 UI 放在一起；print/JSON 面向脚本；RPC 使用 stdin/stdout 的严格 JSONL framing；SDK 通过 `createAgentSession(options = {})` 组装可嵌入的 `AgentSession`。

`createAgentSession()` 的 `options` 是一个对象而不是单个 prompt，因此调用方可以注入 cwd、model、session manager、extensions、settings、provider 和其他运行时依赖；缺省对象表示使用默认组装路径。具体哪些字段可用，要以 `CreateAgentSessionOptions` 的类型和构造逻辑为准，不能把所有产品配置都塞进文章里的伪枚举。

Pi 的 RPC 和 SDK 有一个共同特点：能力主要通过事件和 session 对象暴露，而不是由一个固定的跨语言 schema 约束。它因此更容易在 TypeScript 项目里改造，但宿主作者需要自己决定哪些事件持久化、哪些错误可重试、怎样把扩展 UI 映射到自己的界面。

## 同一宿主任务的协议对照

| 宿主动作 | Claude Code | Codex | Pi |
|:--|:--|:--|:--|
| 建立运行时 | 选择 CLI/print/SDK/MCP/Bridge 入口 | `initialize` / `initialized` | 选择 interactive、print/JSON、RPC 或 SDK |
| 创建会话 | 由入口与 session 层组合 | `thread/start` / `resume` / `fork` | SessionManager/SDK session |
| 发送一次工作 | Query Core 输入 | `turn/start` | prompt/SDK/RPC 输入 |
| 渲染中间状态 | Query/SDK/MCP 事件 | `item/started`、delta、completed、turn events | AgentEvent、RPC JSONL、TUI 事件 |
| 审批/输入 | 入口回调、权限上下文 | 双向 server request，turn 可暂停 | 由扩展或宿主自建流程 |
| 取消/恢复 | 入口和会话实现决定 | `turn/interrupt`、resume、fork | abort signal、session branch、RPC 控制 |
| 背压 | 生成器消费速度与宿主实现相关 | bounded queues + retryable error | JSONL/RPC framing 与调用方消费速度 |

这张表的关键不是“Codex 最完整”，而是三套系统把协议责任放在不同位置：Claude 通过多个入口复用内核；Codex 通过 app-server 明确化生命周期；Pi 用少量模式和扩展留出组合空间。

## 一个最小宿主练习

实现一个只做六件事的宿主：建立连接、创建会话、发送一条 prompt、渲染工具事件、发出中断、恢复会话。

- Claude：先选 SDK 或 headless 入口，记录它如何表达工具事件和权限回调。
- Codex：严格执行 `initialize` 握手，订阅 Thread/Turn/Item 事件，处理 `-32001` 重试和 approval request。
- Pi：实现 LF 分隔 JSONL RPC 客户端，保存 session id 或路径，并决定扩展事件如何映射到 UI。

做到这里，你会发现宿主真正需要的不是“最终字符串”，而是**一条可以暂停、观察、重试和恢复的生命周期**。

## 本篇新增机制

相对工具安全篇，本篇加入了宿主控制面：权限只有通过事件、反向请求和恢复协议暴露出来，才真正能被 IDE 或服务使用。下一篇不再问三套系统“有什么功能”，而是问它们各自把哪些能力做成了不可替代的架构中心。

## 留给下一篇的问题

如果所有 Agent 都有主循环、工具、上下文和宿主，什么才是 Claude Code、Codex、Pi 各自最有辨识度的源码设计？下一篇逐套回答，并严格限定“在本次源码窗口中未看到同等接口”。

## 参考资料

- [OpenAI：Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)
- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Pi coding-agent README](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- [Claude Code Docs：How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
