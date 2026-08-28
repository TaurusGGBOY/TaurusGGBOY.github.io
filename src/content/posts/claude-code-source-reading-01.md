---
title: "Agent Harness 01｜整体架构与控制平面"
published: 2026-07-17
description: "对照 Claude Code、Codex CLI、Pi 与 DeepSeek Harness，理解四种 Agent Harness 的整体架构、控制平面与状态边界。"
tags: ["agent-harness", "claude-code", "codex-cli", "pi", "deepseek"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-01/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-28
---
## Claude Code

![Claude Code 的产品入口、查询引擎与工具控制面](/images/posts/claude-code-source-reading-01/agent-theme-01-claude-code-handdrawn.png)

*Claude Code 把 CLI、交互 UI 和 MCP 入口接到同一组查询与工具契约上，产品状态围绕查询循环展开。*

Claude Code 2.1.88 的架构中心是一套由产品入口、`QueryEngine`、异步生成器和工具契约共同组成的运行时。`restored-src/src/entrypoints/cli.tsx` 先识别命令行模式和快速路径，再进入 `restored-src/src/main.tsx` 的 `main()` 完成配置、会话与界面装配。入口层决定“这次以什么产品形态运行”，但不直接推进模型与工具之间的循环。

真正承接一条用户消息的是 `restored-src/src/QueryEngine.ts` 中的 `QueryEngine.submitMessage()`。这个对象持有消息、取消控制器、用量、文件状态以及获取工具、MCP、配置和应用状态的依赖。一次消息提交需要的可变会话状态在这里被收拢，然后交给 `query()`。

`restored-src/src/query.ts` 中的 `query()` 继续委托给 `queryLoop()`。后者是异步生成器，内部维护 `messages`、`toolUseContext`、`turnCount`、`transition` 等状态，并在模型输出、工具调用、工具结果和下一轮请求之间反复推进。外层宿主看到的是连续事件；循环内部看到的是一份不断变化的会话状态。这个边界让终端渲染不必知道每个工具如何执行，也让查询循环不必知道一段增量文本最终绘制在什么位置。

交互状态与查询状态没有混成一份全局对象。`restored-src/src/components/App.tsx` 用 `AppStateProvider` 组织 TUI 所需状态，`restored-src/src/state/store.ts` 提供 `get`、`set`、`subscribe` 这一类产品状态接口；`QueryEngine` 再通过读写回调接入其中。于是两边既能协作，又保留了所有权边界：UI 保存展示和交互状态，查询引擎保存一条消息如何完成的运行时状态。

工具侧也遵循相同思路。`restored-src/src/Tool.ts` 定义工具结构、查找和构建入口，查询循环只依赖工具契约。`restored-src/src/entrypoints/mcp.ts` 的 `startMCPServer()` 直接把本地工具池适配成 MCP server 能理解的协议，没有再实现一套平行的工具内核。因此 Claude Code 的控制平面可以概括为：入口层选择产品模式，`QueryEngine` 组织一次提交，`queryLoop()` 推进控制流，工具契约把副作用接回循环。

配置、权限、UI、MCP、会话恢复和工具状态都可能通过依赖进入 `QueryEngine`，因此 Claude Code 的产品层较厚，理解系统时很难只读一个小包。这种集中装配让面向终端用户的行为可以在共享查询循环周围协作，同时也增加了 `QueryEngine` 的依赖面。

## Codex CLI

![Codex CLI 通过 Op 与 EventMsg 连接多个宿主和线程运行时](/images/posts/claude-code-source-reading-01/agent-theme-01-codex-cli-handdrawn.png)

*Codex CLI 把双向协议流设为控制边界：宿主提交 `Op`，线程运行时持续返回 `EventMsg`。*

Codex CLI 在固定提交 `c6dee5f49f9d4763cb498904d9bf0d0fd0c4586b` 中，把宿主和会话运行时之间的关系写成了非常明确的协议。`codex-rs/core/src/codex_thread.rs` 的 `CodexThread` 持有 `Arc<Session>` 与 `SessionIo`，对外暴露的两个关键动作是 `submit(op: Op)` 和 `next_event()`：前者把操作送进线程，后者从线程取出下一条事件。

这两个方法只负责投递和取出消息。调用方不需要拿到 `Session` 内部字段，也不需要跨层修改会话状态，只需遵守双向消息流。输入侧的 `Op` 与输出侧的 `EventMsg` 定义在 `codex-rs/protocol/src/protocol.rs`。它们既是序列化数据类型，也是运行时控制边界：宿主通过操作表达意图，核心通过事件暴露进度、请求与结果。

因此 TUI、非交互 `exec` 和 app-server 可以围绕同一契约形成不同宿主。它们的输入来源、输出格式和生命周期并不相同，却不必各自复制 agent loop。架构上的稳定点不是某个界面组件，而是“提交操作—消费事件”这一对协议动作。新增宿主时，首先要适配的是 `Op` / `EventMsg`，而不是侵入线程内部。

线程本身的生命周期由 `codex-rs/core/src/thread_manager.rs` 中的 `ThreadManager` 管理。创建、恢复、分叉以及历史装配都从这里进入；创建线程时，它还需要组合配置、历史、环境和会话来源。于是单次通信和长期生命周期被拆成两层：`CodexThread` 是已经存在的双向会话通道，`ThreadManager` 决定这样的通道从哪里来、如何恢复以及何时登记。

这个拆分让控制平面呈现出队列化特征。宿主没有同步调用一个“完成整个任务”的大函数，而是提交操作，再持续等待事件。模型流、审批、工具执行和终态都可以沿事件通道逐步显现。对交互终端来说，这意味着它能边收到边渲染；对 app-server 来说，同一事件可以被转换为服务端协议；对测试来说，也可以围绕确定的操作和事件序列验证行为。

Codex CLI 用状态所有权划分控制面：`ThreadManager` 拥有线程集合及其生命周期，`CodexThread` 封装一条线程的通信入口，`Session` 负责实际运行，宿主保存自己的呈现或传输状态。按这个边界排查时，无法创建或恢复线程先查 manager，操作没有进入运行时查 submit 通道，界面没有更新则查事件消费和宿主适配。

## Pi

![Pi 用小型 Agent 核心、AgentSession 外壳和 EventStream 连接运行模式](/images/posts/claude-code-source-reading-01/agent-theme-01-pi-handdrawn.png)

*Pi 把可复用 agent loop 放进较厚的 `AgentSession`，再用 `EventStream` 服务 Interactive、Print 与 RPC。*

Pi 在固定提交 `9d2ec7ffabe927bfad2214c1cee25b6632a78dcf` 中选择了更显式的分层。`packages/agent` 提供可复用运行时，`packages/coding-agent` 把它装配成完整编码产品。控制平面的中心可以直接在 `packages/agent/src/agent.ts` 中找到：`Agent` 持有消息记录、模型与工具配置、事件订阅、steering 队列、follow-up 队列以及传输和停止钩子。

`Agent` 把循环推进委托给独立模块。`packages/agent/src/agent-loop.ts` 暴露 `agentLoop()` 和 `agentLoopContinue()`，两者进入共享的 `runLoop()`。内部有两层推进关系：内层处理模型响应、工具调用以及可在当前步骤插入的 steering 消息；外层在当前执行结束后检查 follow-up 队列，决定是否再启动一轮。循环返回 `EventStream<AgentEvent, AgentMessage[]>`，调用方既能实时订阅事件，也能在结束时拿到最终消息集合。

这条 `EventStream` 是 Pi 核心与产品壳之间最重要的边界。核心发出 agent 开始、消息更新、工具执行和结束等事件，外层决定如何显示、记录或转发。它和 Codex 的协议队列都在解耦宿主，但表达方式不同：Codex 把双向通信固化为 `Op` / `EventMsg`，Pi 则把轻量 TypeScript 事件流与可传入的函数、钩子、队列组合起来。

产品层位于 `packages/coding-agent/src/core/agent-session.ts`。`AgentSession` 同时组合 `Agent`、`SessionManager` 和 `SettingsManager`，还管理压缩、会话事件、steering/follow-up 输入以及产品级生命周期。Interactive、Print、RPC 等运行模式复用这层会话能力，只对输入输出和持续时间作不同处理。也就是说，`Agent` 回答“模型和工具怎样循环”，`AgentSession` 回答“一个编码产品会话怎样保存、配置和暴露这套循环”。

Pi 把复杂度分配到不同层：核心包保持小而可嵌入，供应商适配、会话持久化、终端体验和扩展能力位于外围。需要特殊行为时，可以替换 stream function、注册工具和钩子，或在 coding-agent 层扩展会话。中央控制对象的职责因而较少，扩展作者则需要理解事件顺序、会话所有权和不同队列的时机。

执行策略需要单独标明版本。在这个固定源码窗口里，`Agent` 构造时 `toolExecution` 的默认值是 `parallel`；其他提交可能改变默认值。稳定边界是 agent loop、事件流和 session shell，当前默认值只描述这次固定提交。

## DeepSeek Harness

![DeepSeek Harness 由插件组合树、Cordis Context 服务与持久事件日志构成](/images/posts/claude-code-source-reading-01/agent-theme-01-deepseek-harness-handdrawn.png)

*DeepSeek Harness 把控制面放在插件组合和服务注册中，`ReactLoopAgent` 再把执行过程写成 turn/step 事件。*

DeepSeek Harness 在固定提交 `47f943859bef60e4160492346772ded9b24f765a` 中，把“运行时由哪些能力组成”变成一等问题。`packages/boot/app-boot/src/index.ts` 负责启动 Cordis loader、加载 profile 并应用组合配置；profile 通过 bundle 和 patch 选择插件。启动过程先构造组合树，再由插件生命周期把能力注册进 `Context`。

`packages/core/agent/src/index.ts` 声明 agent 相关接口、句柄、工厂以及 `AgentRegistry` 服务；`packages/core/tools/src/index.ts` 把工具运行时声明为 Context 上的服务；`packages/core/agent-loop/src/index.ts` 注册具体的 agent-loop 实现。`agents`、`tools`、`agentLoop` 这些名字因此不是普通全局变量，而是能力接缝：插件启动时向上下文提供服务，停止时撤销注册，其他插件只通过服务契约协作。

这使 DeepSeek Harness 的控制平面首先表现为“组合”，然后才是“循环”。app-boot 决定读哪份 profile，profile 决定启用哪些 bundle 与 patch，插件集合决定 Context 中最终有哪些服务。替换执行 provider、增加工具或改变运行模式，不一定要修改中央 agent 类；只要新的插件满足服务契约，就能在不同组合中出现。相应地，排查能力缺失时首先要看 profile 和插件生命周期，而不是直接断定 agent loop 没实现该能力。

循环的具体实现位于 `packages/core/agent-loop/src/agent.ts`。`ReactLoopAgent` 实现 `Agent` 接口，并在 `turn()` 中把一次运行写成持久事件：先追加 `turn/start`，每一步追加 `step/start` 与 `step/end`，最后追加 `turn/end`。模型响应、工具结果和收件箱消息围绕 step 边界推进；取消和下一步、下一轮消息也有显式入口。

这些事件会被追加到 session，成为可继续读取的运行记录。它与 Pi 的内存 `EventStream`、Codex 的宿主协议事件形成对照：三者都用事件解耦控制流和外部消费者，DeepSeek Harness 在这个固定提交中还把 turn/step 边界写进会话记录。

插件组合提高了能力替换范围，也把正确性压力放到组合关系上。插件是否按正确顺序启动、服务是否存在、资源是否随生命周期撤销、profile 是否包含预期 patch，都会改变系统实际能力。这里的核心规则集中在 Context 服务契约、插件所有权、事件日志格式和 turn/step 状态机。

从控制面看，DeepSeek Harness 的中心分布在四个位置：组合树决定可用能力，Context 承载运行时服务，`ReactLoopAgent` 推进执行，session log 保存事实。这种分布式中心是它与另外三个项目最明显的架构差异。
