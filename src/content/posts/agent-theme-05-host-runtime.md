---
title: "Agent主题对比05｜宿主、状态与结构化 IO"
published: 2026-08-12T10:04:00+08:00
updated: 2026-08-12
description: "比较三个 Agent 的共享状态、TUI、键盘交互、SDK、App Server 与结构化输入输出。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-05-host-runtime/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-05-host-runtime"
series: "agent-theme-comparison"
order: 5
difficulty: "advanced"
time: "35 min"
prerequisites:
  - "Agent主题对比 01｜控制平面与主循环"
  - "Agent主题对比 04｜扩展、委派与多 Agent"
topics:
  - "AppState"
  - "TUI"
  - "keybindings"
  - "headless SDK"
  - "structured IO"
source_modules:
  - "restored-src/src/state"
  - "restored-src/src/components"
  - "restored-src/src/keybindings"
  - "restored-src/src/entrypoints/sdk"
  - "restored-src/src/cli/structuredIO.ts"
  - "codex-rs/app-server"
  - "packages/coding-agent/src/modes"
status: "verified"
verified_at: "2026-08-12"
---


> Agent 的“产品体验”不是模型回答外面套一层颜色，而是把执行状态、输入焦点、取消、进度和结构化结果可靠地翻译给人或另一个程序。

本篇覆盖 Claude Code 源码解读 31–34：共享 AppState、Ink TUI/REPL、键绑定/Vim mode、headless SDK 与 structured IO。四章看似属于 UI，实际上都在回答一个运行时问题：谁能观察和改变 agent 的状态，状态如何跨宿主边界流动。

![Agent 宿主、共享状态与结构化 IO](/images/posts/agent-theme-05-host-runtime/agent-theme-05-host-runtime-handdrawn.png)

## Section 31｜共享状态如何贯穿整个系统

### Claude Code：AppState 是一张外部状态平面

31 把 AppState 拆成五类共享状态：会话/模型、工具与任务、UI/交互、权限/运行模式以及扩展/连接。默认状态既提供缺省值，又保留运行时分支；store 不分发 action，而是接受函数式 updater；Provider 提供稳定 store，selector 决定谁重新渲染；任务更新利用结构共享，`onChangeAppState` 按字段输出 diff；恢复只映射可外部化字段。

这个设计对终端 Agent 很关键：查询循环、任务系统、工具进度和 UI 不必互相持有组件实例。状态更新有来源，渲染只订阅所需切片，headless 也可以复用同一份 AppState 而不创建 TUI。

### Codex CLI：Thread/Turn 状态由 App Server 持有

Codex 的 app-server 把 thread、turn、item、approval、exec 状态通过 JSON-RPC 事件暴露给多个客户端。CLI UI 只是一个消费者；IDE、自动化脚本或测试客户端可以订阅同一状态。这样的外部状态平面比把状态藏在终端组件里更适合远程和多宿主。

Codex 的状态更新还要面对慢客户端和重连，因此 bounded queues、事件顺序和可恢复 thread 是状态架构的一部分。

### Pi：session 与 UI 状态分层

Pi 的 AgentSession 持有消息树、模型、settings、compaction 和 branch；TUI 维护输入、显示和事件消费状态；扩展可以读取/更新有限的 session 状态。core agent loop 不要求 React/Ink 这样的 UI，因此可以嵌入别的宿主。

### 对比结论

Claude Code 用外部 store 把复杂终端应用的共享状态集中管理；Codex 用 App Server 把状态变成跨客户端协议；Pi 用 session/core/TUI 分层保持轻量。状态平面越外部化，越容易做无头、恢复和多客户端，但越需要 schema 与事件版本治理。

### 验证动作

触发一次工具进度、一次任务状态变化、一次模型切换和一次权限更新，观察 UI、日志、SDK/协议客户端是否得到同一事实。若某个事实只存在于组件局部 state，headless 很可能看不到。

## Section 32｜Ink TUI 与交互式 REPL 如何渲染与刷新

### Claude Code：React 负责语义，Ink 负责终端输出

32 先区分 REPL、React 和 Ink。根组件只在交互模式创建；REPL 用组件树组织输入、消息、工具进度和状态；PromptInput 决定提交目标；查询事件回到 React state；`messagesRef` 解决执行时序，React state 负责显示；token 流和完整消息走两条显示路径，Messages 先整理语义再渲染行。

这不是把 stdout 当画布。组件树让加载、错误、取消、弹窗和异步工具状态可以重新渲染；终端最终只看到差量，但运行时保留的是结构化状态。

### Codex CLI：TUI 是 App Server 事件的渲染器

Codex 的 CLI/TUI 消费 thread/turn/item、approval、exec 和 token 事件，再把它们渲染成终端视图。因为事件来自 app-server，UI 不应该自己推断工具是否完成；它只依据结构化状态更新。多客户端也意味着同一事件必须能被不同显示层解释。

### Pi：TUI 消费 agent events 和 session

Pi 的 TUI 订阅流式 agent events，把 assistant delta、tool call、progress、compaction 和错误显示出来；session 负责长期历史，UI 负责当前视图。它的实现更接近“事件驱动终端”，可以替换主题、组件或宿主。

### 对比结论

Claude Code 把 React/Ink 组件树用于复杂交互；Codex 把 App Server 事件作为 UI 协议；Pi 用轻量事件与 session 维持可替换 TUI。三者都避免让模型输出的文本直接成为终端状态机。

### 验证动作

在 token 流进行中触发一个工具进度，再取消；确认中间文本、工具状态、取消提示和最终结果不会互相覆盖，也不会因终端刷新丢掉 session 记录。

## Section 33｜终端编辑状态如何解析

### Claude Code：按键是状态机输入，不是字符替换

33 处理字符与控制信息、绑定与组件动作、候选前缀线性扫描、全局 ChordInterceptor、上下文/终端保留键冲突校验，以及 Vim 的两个顶层模式。Esc 由 Vim 模式直接处理；operator-pending 推进动作，motion 计算与文本修改分开，两套 pending 状态避免互相踩踏。

这样做的价值是：compact、interrupt、history、completion 等命令都能在明确的交互状态下触发，不会把一个控制序列误当成普通文本。按键系统也是宿主控制平面的一部分，因为它决定何时把输入送给模型、何时改变本地运行状态。

### Codex CLI：快捷键改变宿主状态，不改变模型权限

Codex CLI 的键绑定/命令层负责输入编辑、取消、审批、切换视图和终止 turn。无论用户通过键盘还是协议请求触发取消，最终都要进入同一 host/runtime 控制路径；快捷键本身不能绕过 approval 或 sandbox。

### Pi：TUI/扩展提供可配置输入层

Pi 的交互层支持命令、编辑、历史和扩展快捷键，输入事件再决定是本地操作还是提交 agent。它的可配置性适合不同工作流，但如果扩展注册冲突键或直接调用高权限工具，宿主需要提供冲突检查与确认策略。

### 对比结论

Claude Code 对 chord/Vim 状态建模最细；Codex 把按键视为 host protocol 的一个入口；Pi 把编辑器能力留给 TUI/扩展。好的快捷键实现必须有明确的“本地处理”和“送入 agent”分界。

### 验证动作

在普通输入、Vim normal/operator-pending、工具运行中和权限弹窗中分别按 Esc、Ctrl-C、compact 与自定义 chord，检查每种状态下动作是否一致且可取消。

## Section 34｜无头 SDK 与结构化输入输出如何工作

### Claude Code：headless 仍保留 AppState 和同一个 ask()

34 把 `claude -p`、SDK 和 structured IO 拆开：入口先决定是否挂载 REPL，用户输入统一成 SDK user message，中间仍通过同一个 `ask()`，三种输出格式共享执行逻辑。`stream-json` 必须保护 stdout，把日志/诊断和协议输出分开；非交互权限按宿主类型分流。

无头运行没有 UI 替用户做确认，因此安全责任交给调用方。结构化输出还要求使用者处理 tool events、result reason、usage、错误和取消，而不是只取最后一段文字。AppState 被保留，是为了让无头与交互模式使用同一套状态语义。

### Codex CLI：App Server/JSON-RPC 原生适合无头调用

Codex 的 thread/turn/item 协议本身就是结构化 IO：客户端发送请求，订阅事件，处理 approval、exec、message 和终态。CLI 只是一个客户端，其他程序可以用同一协议构造自动化流程。背压、取消和错误要作为协议事件处理，而不是混入 stdout。

### Pi：agent loop 可嵌入，coding-agent 提供脚本/服务入口

Pi 的 core 可以由 Node/TypeScript 宿主直接调用，事件流和 session 记录提供结构化结果；coding-agent 再提供 TUI、RPC 或脚本入口。调用方可以只订阅最终 message，也可以完整处理 tool/usage/error 事件，取决于可靠性要求。

### 对比结论

Claude Code 把交互与 headless 收敛到 QueryEngine/AppState；Codex 把无头能力直接做成 App Server/JSON-RPC；Pi 把可嵌入 loop 与应用入口分开。三者都提醒我们：headless 不是“去掉 UI”，而是把 UI 隐含承担的取消、权限、输出分流和错误处理显式交给调用者。

### 验证动作

用脚本调用一次会产生工具调用的任务，严格解析 stdout；注入一条诊断日志、一次权限询问和一次取消，确认结构化协议没有被普通文本污染，调用方能区分终态 reason。

## 这一主题的共同答案：宿主是控制平面的观察面

TUI、IDE、SDK 和远程客户端并不是 Agent 的装饰层，它们决定了用户能否看到并改变以下状态：当前 turn、工具进度、权限询问、后台任务、取消、压缩、错误和最终结果。Claude Code 用 AppState + Ink/SDK 共享内核，Codex 用 App Server + JSON-RPC 共享事件，Pi 用 core/session/events 共享能力。

如果结构化 IO 只输出最终答案，外部程序就不能可靠地编排、重试和审计；如果 TUI 自己猜测状态，显示就会和执行脱节。宿主的第一原则是：展示层可以投影状态，但不应创造另一套状态。

## 本主题覆盖清单

本篇覆盖 31、32、33、34，共 4 个独立 comparison sections。主题 01–05 累计覆盖 36 个 Claude Code 章节。

## 下一篇

宿主边界清楚后，继续看系统如何被配置和运维：provider、认证、模型路由、远程连接、成本与日志，以及升级时哪些状态必须迁移。
