---
title: "Pi 0.84.4 的 Harness：把 Agent Loop 变成可运行系统"
published: 2026-09-02T09:00:00+08:00
updated: 2026-09-02
description: "以 Pi 0.84.4 官方源码为边界，拆解 Agent、AgentSession、AgentHarness、扩展、会话树与工具执行，并把它们映射到 Claude Code 系列的数十个观察点。"
tags: ["pi", "agent-harness", "agent-loop", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: ""
lang: "zh_CN"
---

## 先给结论

Pi 0.84.4 最有价值的地方，不是又增加了一个“会写代码的聊天窗口”，而是把 Agent 的运行时边界拆成了可以单独观察的几层：底层 Agent 负责循环、消息、工具和流；coding-agent 包里的 AgentSession 负责会话、资源、模型和终端运行时；扩展、Skills、Prompt Templates、Packages 和 RPC/SDK 负责把这套运行时接到人的工作流上。

但“Pi 已经有 AgentHarness”这句话需要加一个版本限定。v0.84.4 确实导出了 AgentHarness 和 AgentLane 的公共类型与入口，可是 tagged source 里的操作方法仍会以 HarnessNotImplemented 拒绝执行，恢复已有会话的 create.restore 路径也没有实现。当前能稳定拿来做二次开发的是 Agent、AgentSession 和既有 coding-agent 运行时，不是一个已经完成的通用 Harness 调度器。

这个版本边界直接决定了接入层：当前能稳定拿来做二次开发的是 Agent、AgentSession 和既有 coding-agent 运行时；它还不能被当作多租户后台、长期运行服务或另一个 Claude Code 式平台所需的通用 Harness 调度器。本文按 Claude Code 系列一直使用的“控制平面—循环—上下文—工具—持久化—扩展—运维”视角，逐项把这条边界摊开。

## 版本、源码与证据边界

本文以 2026-09-02 能取得的 Pi v0.84.4 为准。版本号由 npm registry、pi.dev 的 latest-version 接口和 [v0.84.4 官方源码标签](https://github.com/earendil-works/pi/tree/v0.84.4)相互核对；源码文件也直接按这个 tag 阅读。Pi 的仓库迁移背景见官方说明：[Pi has a new home](https://pi.dev/news/2026/5/7/pi-has-a-new-home)。

文章中的结构性判断以官方源码和文档为准。另有十篇非官方资料已经下载到本项目的 [Pi 研究归档](https://github.com/TaurusGGBOY/TaurusGGBOY.github.io/blob/master/research/agent-articles-2026-09-02/pi/sources.md)，它们帮助我选择了“操作员视角、扩展边界、上下文工程和会话树”这些切入点，但不替代版本化源码。Pi 0.84.4 的包说明写得很直白：它是一个 minimal terminal coding harness；这篇文章要做的是解释 minimal 之后仍然有哪些工程。

## Pi 最近真正增加了什么

### 从终端程序扩展成一组运行面

Pi 的默认 coding-agent 仍然很克制：读文件、写文件、编辑文件和执行命令。它不把 plan mode、subagents 或一整套隐式工作流强行塞进核心。交互模式之外，还提供 print/JSON、RPC 和 SDK 运行面。这个取舍让模型能做什么、宿主负责什么，边界比“所有功能都由一个大应用开关控制”更容易追踪。

官方 [latest 文档](https://pi.dev/docs/latest)把 Pi 的可扩展面分成几类：

- TypeScript Extensions 可以增加工具、命令、事件监听、用户界面和自定义渲染；
- Skills 把较大的操作说明放在需要时再加载的 SKILL.md 中；
- Prompt Templates、Themes 和 Pi Packages 分别处理可复用提示、显示层和可分发代码；
- settings、models.json、登录/订阅和自定义 provider 负责模型与运行配置。

Packages 不是一个受限脚本格式。官方明确提醒，Pi Packages 会以完整系统权限运行；Extension 也能执行任意代码。第三方包必须像安装一个本地程序一样审阅源代码。这是 Pi 的能力上限，也是它的安全起点。

### 会话不只是历史记录，而是一棵可导航的树

Pi 的会话文件采用 JSONL，每条记录带有 id 和 parentId。继续对话是在树上追加；/tree 可以回看分叉；/fork 和 /clone 可以从已有位置产生新的工作线；/compact 会把旧上下文压缩成摘要。这里的设计重点是可回到某个决策点，而不是把所有历史压成一个不可逆的聊天数组。

这让 Pi 很适合需要“试一个分支、失败后回到父节点”的编码任务。但会话树仍然不是长期记忆。它保存的是某次运行的消息和分支关系，不会自动成为跨项目知识库；要做后者，需要 Extension、Package 或宿主应用自己定义写入和检索策略。

### 转向和追问被做成队列语义

交互中按 Enter 可以在当前轮次或工具阶段结束后 steer 当前任务；Alt+Enter 则把 follow-up 留给 Agent 完成当前工作后再处理。代码里对应的是两条队列和两种模式：one-at-a-time 会逐条消费，all 会把一批消息合并为一次继续处理。

这项能力看起来像 UI 小功能，实际上是控制平面的核心。它规定了用户在工具运行中插话时，消息进入哪一个生命周期、是否打断当前动作、以及模型下一次看到的上下文是什么。Claude Code 系列里经常把这件事拆在 query loop、prompt queue 和 interrupt 处理中；Pi 把它收敛成 Agent 的 steer/followUp 契约。

## 从 Agent 到终端：三层调用链

先把最容易混淆的对象分开：

    Agent
      -> runAgentLoop / runAgentLoopContinue
      -> streamFn
      -> assistant response
      -> tool calls
      -> tool results
      -> next turn

    AgentSession
      -> Agent + model/thinking/tools
      -> ResourceLoader
      -> settings / skills / prompts / extensions
      -> SessionManager
      -> TUI / RPC / SDK

    AgentHarness
      -> AgentLane / queue / compaction / navigation 的公共面
      -> v0.84.4 中操作实现仍返回 HarnessNotImplemented

### 1. Agent 是可以运行的循环

官方 [Agent 源码](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/agent.ts)把 Agent 写成有状态的运行时包装器。它保存 system prompt、model、thinking level、tools、messages、streaming message、待执行 tool calls 和错误状态，再把事件流交给 processEvents 逐一归约。

低层 [agent-loop.ts](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/agent-loop.ts)有一个很值得注意的边界：内部消息先保持 AgentMessage[]，只有走到 LLM 边界时，才由 convertToLlm 转成 provider 需要的 Message[]。在这之前还可以通过 transformContext 修改上下文。这意味着“系统里的消息模型”和“某家模型 API 的消息格式”不是同一层，工具结果、扩展消息和供应商字段不必过早被压扁。

一次运行大致经历以下阶段：

1. 检查当前轮次开始前是否有 steering 消息；
2. 通过 transformContext 组装上下文，再通过 convertToLlm 适配 provider；
3. streamFn 产生 assistant 流；
4. 如果出现工具调用，先经过 beforeToolCall，再执行工具；
5. 把工具结果按 assistant 声明的顺序重新放回消息；
6. 根据 shouldStopAfterTurn、follow-up 队列和错误状态决定是否继续。

工具执行有两个细节值得记住。默认可以并行执行一批互不依赖的工具，但只要全局配置或某个工具声明 sequential，就会切成串行；并行执行时，完成事件可以乱序到达，最终结果消息仍按模型给出的工具顺序排列。另一个细节是 token limit 下的工具调用不会被盲目执行，而是产生错误工具结果，要求模型重新发出可处理的调用。这些都是把“模型输出”变成“宿主动作”时必须有的护栏。

Agent 的 prompt 不允许和一个正在运行的 prompt 并发抢占。要插话就 steer，要追加就 followUp，要取消就 abort。这些不是 API 命名风格，而是对并发状态的明确建模；否则一个终端 UI 很容易出现两个 turn 同时写同一份 session 的问题。

### 2. AgentSession 把资源和运行时接起来

coding-agent 包的 [AgentSession](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/agent-session.ts) 才是 Pi 终端产品真正使用的组合层。main.ts 先建立 ResourceLoader，再加载 extensions、skills、prompts、themes、上下文文件和信任配置，解析模型，最后用 AgentSessionServices 创建 session。

这条路径的优点是“资源解析”和“Agent 循环”没有混成一个超级函数。模型切换、thinking level、工具清单、session manager、compaction 和 UI/RPC 可以围绕 session 组合。AgentSessionRuntime 还负责当前 cwd 绑定的服务、切换新会话、fork、abort 和 teardown。

官方 [session manager](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/session-manager.ts)则负责 append-only 的 JSONL 树、分支和摘要。它解决的是可恢复性与导航，不等于权限系统，也不等于数据库事务。这个区别在把 Pi 放入服务端时尤其重要：文件追加成功，不自动代表远端请求、工具副作用和 UI 状态已经形成一次可重放事务。

### 3. AgentHarness 是公共契约，不是 v0.84.4 的完成证明

请直接看 [AgentHarness v0.84.4 源码](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/harness/agent-harness.ts)。文件定义了 LaneBusy、MissingIdentities、NoActiveRun 等错误，设计了 RunOutcome、CompactionOutcome、NavigationOutcome，也暴露了 prompt、compact、navigate、resume、abort、steer、followUp、nextRun、cancelQueued、runToCompletion 和 watch 等操作。

但在这个 tag 里，AgentHarness.create 遇到已有记录会进入 HarnessNotImplemented("create.restore")；hooks/events 是 UnavailableRegistry；prompt、compact、steer、waitForIdle、createLane 等操作也会走 unavailable()。所以它更像一份正在落地的统一调度面：类型和边界已经告诉我们未来要解决什么，功能实现还不能当成现成的生产入口。

这个负面证据决定了结论的范围：只看 README 的“harness”会误以为所有 harness API 都能调用；只看 skeleton 的异常又会误以为 Pi 没有可用 Agent。可用的产品路径已经在 Agent + AgentSession 上，通用 Harness 仍处于接口先行阶段。

## 按 Claude Code 系列的 40 个观察点逐项映射

下面不是“谁更强”的总分表，而是把 Pi 放入 Claude Code 系列反复讨论的坐标系。状态词含义是：有，表示当前源码有明确落点；接入，表示可以由扩展或宿主补上；缺省，表示 Pi 有意不把它作为核心能力；待实现，表示公共面存在但当前 tag 仍未完成。

| 观察点 | Pi 0.84.4 的落点 | 阅读 Claude Code 系列时应追问 |
|---|---|---|
| 控制平面 | Agent 是控制循环，AgentSession 是组合宿主 | 谁持有取消、队列和运行状态 |
| Agent Loop | runAgentLoop / Continue 处理多轮工具循环 | 一轮模型请求结束是否等于任务结束 |
| 消息模型 | AgentMessage 到 LLM Message 延迟转换 | 内部消息是否被 provider 格式绑死 |
| 上下文组装 | transformContext、system prompt、资源加载 | system、工具、文件和结果怎样合并 |
| Provider 适配 | convertToLlm、streamFn、API key resolver | 协议转换是否污染主循环 |
| 工具契约 | 工具 schema、before/afterToolCall、执行模式 | 模型能调用什么由谁决定 |
| 工具并发 | 可并行；顺序模式可全局或按工具声明 | 事件乱序是否影响最终消息顺序 |
| 工具失败 | 工具结果回填；token-limit 调用转错误结果 | 错误是重试、回给模型还是直接终止 |
| 工具权限 | 扩展与宿主控制，核心不是多租户权限层 | 权限是模型提示、宿主策略还是 OS 边界 |
| 转向 steering | 当前轮次队列 | 用户插话会打断动作还是只改下一轮 |
| 追问 follow-up | 当前 Agent 完成后消费 | 后续任务和当前任务是否共享上下文 |
| 流式输出 | stream events、streamingMessage、TUI/RPC | 增量文本、工具事件和最终消息如何收口 |
| 取消 | Agent.abort 与 session teardown | 取消是否真的传到 provider 和子进程 |
| 重试 | Agent 可承载 retry 配置，宿主决定策略 | 网络重试和模型继续是否被区分 |
| 上下文上限 | token-limit 工具护栏、compaction | 压缩发生前后哪些消息还能追溯 |
| 压缩 | session/compaction 模块和 /compact | 摘要是可编辑记录还是不可见黑箱 |
| 会话持久化 | JSONL append-only 树 | 写入是否具备 writer claim 与恢复语义 |
| 分支 | /tree、/fork、/clone、parentId | 分支是导航能力还是复制整个环境 |
| 导航 | resume、tree、new、switch | 回到旧状态时工具副作用怎样处理 |
| 长期记忆 | 核心不预设知识库；由扩展接入 | session history 和 memory 是否混用 |
| 资源加载 | ResourceLoader 加载 skills、prompts、extensions | 启动时资源快照是否稳定 |
| Skills | 渐进式提示加载，按需读取 SKILL.md | 技能说明何时进入模型上下文 |
| Extensions | TypeScript 事件、工具、UI、命令 | 扩展是否能修改生命周期与结果 |
| Packages | 可分发的扩展组合 | 第三方代码的信任边界是什么 |
| MCP | 核心 Agent 契约不强制 MCP，扩展可桥接 | MCP 是否是协议边界还是工具实现 |
| Subagents | README 明确不内置 subagents | 委派是核心调度还是外接服务 |
| Plan mode | README 明确不内置 plan mode | 计划是否是状态机、提示模板还是 UI |
| 权限确认 | 由 coding-agent/扩展/宿主配置承载 | 确认发生在调用前还是结果后 |
| Sandbox | Pi 本身不是隔离沙箱 | OS、容器和 agent policy 谁提供最后边界 |
| Trust | ResourceLoader / trust 影响资源启用 | 信任是项目级还是每次工具级 |
| 模型切换 | model runtime、/model、自定义 models.json | 切换会不会丢失上下文与工具状态 |
| API Key | getApiKey/provider 配置 | 凭证解析是否进入持久化消息 |
| Transport | provider stream、RPC、SDK、print/JSON | UI 与 Agent 是否通过同一事件协议 |
| RPC | 有独立 RPC 运行面 | RPC 客户端如何观察和取消任务 |
| SDK | Agent 与 coding-agent SDK 可组合 | SDK 是稳定接口还是源码级扩展点 |
| TUI | 终端 UI 显示流、队列、session 信息 | UI 是否掩盖了后台状态机 |
| 观测 | footer 展示 token、cache、cost、context | usage 是 provider 原始值还是估算值 |
| 缓存 | provider/runtime 可报告 cache | 缓存命中能否解释成本与延迟 |
| 并发锁 | 单个 Agent prompt 不并发；Harness lane 待实现 | session writer 与工具进程是否互斥 |
| 输出截断 | provider/工具结果由宿主控制 | 大文件、大输出如何避免污染上下文 |
| 崩溃恢复 | session JSONL 可恢复历史；Harness restore 待实现 | 重启后能否恢复“运行中”而不仅是消息 |
| 后台任务 | 核心没有 cron/长期后台调度 | 任务完成后的唤醒和投递由谁负责 |
| IDE/Web | 核心定位终端，也有 RPC/SDK | 展示层是否与执行层分离 |
| 评测 | 核心不提供完整业务评测闭环 | 工具成功是否等于任务成功 |
| 供应链 | 包和扩展有完整系统权限 | 安装前后如何做源码审阅和锁定 |

这张表最重要的不是“Pi 缺少哪些按钮”，而是它把很多按钮留给宿主。Claude Code 系列习惯从一个完整产品往下拆：控制平面、权限、MCP、subagents、后台任务和 UI 都可能已经在一个可交付产品里。Pi 则从一个可组合循环往外长：你必须自己决定哪些能力属于产品，哪些属于扩展，哪些必须由 OS 或服务端托管。

## 四个设计判断

### 1. Minimal 不是少写代码，而是少替你做产品决定

Pi 不内置 plan mode 和 subagents，会让第一次使用的人觉得功能少；对要做二次开发的人，这反而减少了隐式状态。没有一个“计划模式”偷偷改变工具权限，也没有一个“子代理”在后台创建你看不见的会话。宿主可以加，但加之前必须定义状态、权限、失败、可见性和成本。

这也是 TyoLab 那篇 harness 文章对本文最有用的提醒：判断 Agent harness，不能只数工具数量，要看上下文、工具契约、策略边界、持久化和宿主协议是否闭合。Pi 的底层接口已经把这些接缝暴露出来，产品责任没有被名称掩盖。

### 2. 扩展能力和安全能力是同一枚硬币

Extension 可以监听事件、改写工具、渲染 UI；Package 可以把一套工作流装进来。代价是它们运行在高信任边界上。官方 [Extensions 文档](https://pi.dev/docs/latest/extensions)和 [Packages 文档](https://pi.dev/docs/latest/packages)都要求审阅第三方代码。

所以 Pi 不适合作为“把陌生用户代码直接装进来的公共 Agent 平台”而不做额外隔离。你需要在宿主层加入容器、文件系统策略、凭证代理、出网限制和审计；这不是再加一个 Pi 配置项就能解决的问题。

### 3. 会话树是优秀的本地撤回机制，不自动等于记忆系统

JSONL、parentId、tree、fork 和 compact 让本地编码过程可解释、可回退。它们适合保存“当时模型看到了什么、用户在哪个节点转向”。长期记忆还需要来源、作用域、更新时间、删除和污染防护。把 session 文件直接喂给下一个项目，会把一次性的工具结果误当成事实。

Kissgyorgy 对 compaction 和分支的整理、Mudrii 对消息到 LLM 转换的拆解，都指向同一个工程结论：可恢复历史、上下文压缩和长期记忆要分开建模。

### 4. 不要把 AgentHarness 的类型面误读成运行面

如果你正在写插件或实验性宿主，v0.84.4 可以从 Agent 或 AgentSession 开始；如果你准备把 AgentHarness 当成已经稳定的 lane scheduler，则必须先在目标版本运行真实的 create、prompt、watch、compact 和 restore 测试。源码中的 HarnessNotImplemented 不是文档措辞，而是会在调用时抛出的运行时结果。

这条负面结论也保护了文章的 claim ceiling：Pi 目前可以被称为“拥有正在成形的通用 Harness 契约”，不能被本文称为“已经完成通用 Harness 实现”。

## Pi 适合什么，不适合什么

它适合个人或小团队的终端编码、可审阅的 TypeScript 扩展、希望掌控模型/provider 和会话文件的操作员，以及把 Agent loop 嵌入自己产品的开发者。你能看到循环、消息转换、工具事件和会话树，不必先接受一整套 SaaS 控制平面。

它不适合作为现成的多租户 Gateway、陌生插件的安全执行场，或无需自己补齐队列、计费、身份、审计、后台任务和崩溃恢复的长期服务。若要做这些事，Pi 更像执行内核，外围还需要一层真正的产品控制平面。

最终可以这样记：

    Pi 0.84.4 = 可用的 Agent + 可用的 coding-agent session runtime
                 + 高权限扩展生态
                 + 正在成形但尚未完成的 AgentHarness 公共面

这比把 Pi 简化成“轻量版 Claude Code”更准确。它的价值不在于复刻 Claude Code 的所有功能，而在于让你看清一个 Agent 产品最小需要哪些接缝；它的风险也不在于“功能不够多”，而在于你可能把扩展权限、会话持久化和未完成的 Harness 误当成了生产级隔离与调度。

## 资料与代码索引

### 官方资料

- [Pi latest 文档](https://pi.dev/docs/latest)：产品运行面与最新文档入口。
- [Extensions](https://pi.dev/docs/latest/extensions)：扩展事件、工具、UI 与权限提醒。
- [Skills](https://pi.dev/docs/latest/skills)：渐进式加载的 SKILL.md 约定。
- [Packages](https://pi.dev/docs/latest/packages)：包分发与完整系统权限提醒。
- [SDK](https://pi.dev/docs/latest/sdk)：把 Pi 嵌入宿主的 SDK 面。
- [Agent harness 文档](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/docs/agent-harness.md)：Harness 的目标边界与迁移说明。
- [Agent](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/agent.ts)、[Agent loop](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/agent-loop.ts)：循环、队列、工具与消息转换。
- [AgentHarness](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/harness/agent-harness.ts)：当前 tag 中的公共面和未实现路径。
- [AgentSession](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/agent-session.ts)、[SessionManager](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/session-manager.ts)：终端宿主与会话树。

### 十篇非官方阅读池

以下文章用于补充操作员和生态视角，事实以官方 tag 为准：[Scott Spence](https://scottspence.com/posts/coding-agent-harnesses-my-pi)、[Hochej 的 Extensions 笔记](https://hochej.github.io/pi-mono/coding-agent/extensions/)、[Odysa 的 Pi Mono 导览](https://odysa.github.io/project-tutorials/pi_mono_tutorial.html)、[MPIV 的源码深潜](https://mpiv.ai/blog/pi-mono-deep-dive-the-minimalist-coding-agent-for-operators-2026)、[TyoLab 的 harness 分析](https://www.tyolab.com/blog/2026/06/13-what-an-ai-agent-harness-actually-does/)、[AgentConn 介绍](https://agentconn.com/agents/pi-mono/)、[Mudrii 的 Agent Core 笔记](https://raw.githubusercontent.com/mudrii/pi-mono-docs/main/03-pi-agent-core.md)、[Kissgyorgy 的 compaction 笔记](https://kissgyorgy.github.io/pi-mono/docs/compaction/)、[Yeluo45 的 agent loop 设计](https://yeluo45.github.io/pi-mono-design/en/docs/07-agent-loop)、[ZeroNoise 的包分析](https://zeronoise.ai/posts/pi-coding-agent-ships-as-a-package-with-pinning-still-unresolved-yxjnhphdlz/download/pdf)。
