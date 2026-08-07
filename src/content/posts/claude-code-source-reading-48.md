---
title: "Claude Code源码解读48：系列总结与能力清单"
published: 2026-08-03T20:08:42+08:00
updated: 2026-08-04
description: "回答 mailbox 与 A2A 的异同，逐篇回顾 00–47，并整理 Claude Code 的产品演进时间线。"
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-48/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

mailbox 和 A2A 协议的异同点是什么？

答案先放在前面，**mailbox 是一个 Agent 运行时内部的投递机制，A2A 是跨 Agent、跨进程甚至跨厂商的通信协议。** 它们都把“发送者正在做什么”和“接收者何时消费”解耦了，但 mailbox 解决的是本地协作的可靠交付，A2A 还要解决能力发现、协议协商、身份认证、跨网络传输和长任务状态同步。把 mailbox 直接叫作 A2A，会把一个实现细节误说成公共协议。

在 2.1.88 的还原源码里，mailbox 至少有两层。`utils/mailbox.ts` 是进程内队列，可以按谓词取出消息；Agent Teams 使用 `utils/teammateMailbox.ts` 把消息写入目标 teammate 的文件 inbox，再由轮询器、忙闲状态和 `read` 标记决定什么时候交给目标会话。它知道本地的 Agent 地址、文件路径、锁、待处理状态和去重规则，却没有公开的能力描述、跨语言 schema 或远端发现流程。

A2A 的抽象边界更大。它把远端 Agent 当作可能完全不了解内部实现的对等体，用 Agent Card 描述能力和接口，用 Message/Part 传输文本、文件或结构化数据，用 Task 表示有状态的长任务，还定义了流式更新和 webhook push。规范可以映射到 JSON-RPC、HTTP+JSON/REST 或 gRPC，因此调用方不需要知道对方是哪个框架、什么语言，甚至不需要知道对方内部是否仍有 mailbox。

### 相同点｜都把“发送”和“执行”拆开

- **都有寻址。** mailbox 根据本地 teammate/session 地址选 inbox；A2A 根据 Agent Card 和接口 URL 选远端 Agent。
- **都允许异步。** mailbox 在目标忙时先进入 pending，空闲后再提交；A2A 用 Task、streaming 和 push notification 表达远端长任务的进度。
- **都保留状态边界。** mailbox 有 unread、pending、processed 等本地状态；A2A 的 Task 也会经历 submitted、working、completed、failed、canceled 等生命周期。
- **都不等于模型上下文。** 消息先经过投递协议，再在合适的时刻变成 Query Loop 的输入；协议层不应该让模型猜“这条消息是否已经处理”。

### 不同点｜mailbox 是实现，A2A 是互操作契约

| 维度 | Claude Code 2.1.88 的 mailbox | A2A 协议 |
| --- | --- | --- |
| 作用范围 | 同一产品内的进程内队列或 Agent Teams 文件 inbox | 不同 Agent、进程、机器、语言和厂商之间的通信 |
| 发现方式 | 依赖已有的 teammate/session 地址；源码没有公共能力发现 | Agent Card 声明能力、认证方式和支持的接口 |
| 数据模型 | 面向内部 handler 的消息、附件、read/processed 状态 | Message、Part、Artifact、Task 等公开语义对象 |
| 传输方式 | 内存、文件、锁和轮询；具体路径由宿主决定 | HTTP/JSON-RPC、HTTP+JSON/REST、gRPC 等绑定 |
| 长任务 | 目标忙时排队，空闲时重新提交或作为 attachment 注入 | Task 负责跨请求追踪，支持流式状态和异步 push |
| 安全边界 | 本地文件权限、地址校验、锁和产品内权限上下文 | 需要在协议/网关层处理认证、授权、租户和网络安全 |
| 兼容目标 | 让当前 Claude Code 的多个会话可靠协作 | 让互不认识的 Agent 能够协商并完成任务 |

这里有一个很实用的组合方式，把 A2A 当作入口协议，把 mailbox 当作某个 Agent 内部的适配层。

```text
A2A SendMessage
      │ 认证、能力与地址检查
      ▼
本地 A2A gateway ──► teammate mailbox ──► Query Loop
                                           │
                                           ├─ tool_use / tool_result
                                           └─ Task 状态与结果
      ▲
      └──────── A2A response / stream / push
```

这条图是架构推断，不是 2.1.88 已经内置的 A2A 实现，源码能确认 mailbox 的本地交付路径，A2A 规范能确认远端任务语义，二者之间的 gateway 需要由产品或用户自己实现。反过来，A2A 也不要求接收端使用文件 mailbox；它可以直接把请求交给自己的任务调度器、数据库队列或另一个服务。

## 介绍本章的一些概念

- 本系列是一次**可复现的源码快照阅读**，全部结论落在 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` 还原源码上；它回答「这一版代码怎样工作」，不等于「今天的 CLI 每个细节仍然相同」。
- 系列的终点是一份**能力清单而不是知识清单**，能画出循环、能定位符号、能解释权限、能跑压缩实验、能读 trace、能实现最小 harness、能解释静态证据边界，七项可验证的能力比 48 个函数名更有用。
- 产品时间线与源码快照是**两条证据链**，时间线依据公开产品公告，源码快照依据 source map；不能把后续版本（web、plugins、Skills、Routines、Artifacts、Claude Tag）的公告当成 2.1.88 的源码事实，也不能把 2.1.88 的实验分支当成最终公开产品。
- 40到47 篇是产品实验子系统（🔬 可选阅读），Session Memory 是产品化记忆，41到47 的 memdir/Team Memory、AutoDream、Assistant/KAIROS、Buddy、Voice、MagicDocs、通知通道均受构建期或灰度开关控制，不影响理解内核。
- 故障定位的坐标系比记忆函数名重要，**输入在哪一层被改写，权限在哪一层被拒绝，状态在哪一层丢失，结果在哪一层没有抵达受众**，版本升级、文件移动，责任边界不变。

## 本篇新增

本章是系列收尾，引入三个概念并把它们交给读者自检，

- **源码快照。** 本系列分析的是 `@anthropic-ai/claude-code@2.1.88` 的还原源码。它回答「这一版代码怎样工作」，不等于「今天的 CLI 每个细节仍然相同」。
- **产品时间线。** 时间线回答「Claude Code 何时从命令行研究预览长成多宿主 Agent 产品」，依据公开产品公告；它和源码快照是两条证据链。
- **闭环视角。** 00到47 看的是一次输入如何进入 Agent、穿过模型/工具/权限/状态/宿主，再把结果交给人或另一个 Agent；本章把这些局部结论重新拼成一张地图，并压成七项可验证的能力清单。

## 问题

上一篇（47）的问题是，**mailbox 和 A2A 协议的异同点是什么？**

答案先放在前面，**mailbox 是一个 Agent 运行时内部的投递机制，A2A 是跨 Agent、跨进程甚至跨厂商的通信协议。** 它们都把「发送者正在做什么」和「接收者何时消费」解耦了，但 mailbox 解决的是本地协作的可靠交付，A2A 还要解决能力发现、协议协商、身份认证、跨网络传输和长任务状态同步。把 mailbox 直接叫作 A2A，会把一个实现细节误说成公共协议。

在 2.1.88 的还原源码里，mailbox 至少有两层。`utils/mailbox.ts` 是进程内队列，可以按谓词取出消息；Agent Teams 使用 `utils/teammateMailbox.ts` 把消息写入目标 teammate 的文件 inbox，再由轮询器、忙闲状态和 `read` 标记决定什么时候交给目标会话。它知道本地的 Agent 地址、文件路径、锁、待处理状态和去重规则，却没有公开的能力描述、跨语言 schema 或远端发现流程。

A2A 的抽象边界更大。它把远端 Agent 当作可能完全不了解内部实现的对等体，用 Agent Card 描述能力和接口，用 Message/Part 传输文本、文件或结构化数据，用 Task 表示有状态的长任务，还定义了流式更新和 webhook push。规范可以映射到 JSON-RPC、HTTP+JSON/REST 或 gRPC，因此调用方不需要知道对方是哪个框架、什么语言，甚至不需要知道对方内部是否仍有 mailbox。

### 相同点｜都把「发送」和「执行」拆开

- **都有寻址。** mailbox 根据本地 teammate/session 地址选 inbox；A2A 根据 Agent Card 和接口 URL 选远端 Agent。
- **都允许异步。** mailbox 在目标忙时先进入 pending，空闲后再提交；A2A 用 Task、streaming 和 push notification 表达远端长任务的进度。
- **都保留状态边界。** mailbox 有 unread、pending、processed 等本地状态；A2A 的 Task 也会经历 submitted、working、completed、failed、canceled 等生命周期。
- **都不等于模型上下文。** 消息先经过投递协议，再在合适的时刻变成 Query Loop 的输入；协议层不应该让模型猜「这条消息是否已经处理」。

### 不同点｜mailbox 是实现，A2A 是互操作契约

| 维度 | Claude Code 2.1.88 的 mailbox | A2A 协议 |
| --- | --- | --- |
| 作用范围 | 同一产品内的进程内队列或 Agent Teams 文件 inbox | 不同 Agent、进程、机器、语言和厂商之间的通信 |
| 发现方式 | 依赖已有的 teammate/session 地址；源码没有公共能力发现 | Agent Card 声明能力、认证方式和支持的接口 |
| 数据模型 | 面向内部 handler 的消息、附件、read/processed 状态 | Message、Part、Artifact、Task 等公开语义对象 |
| 传输方式 | 内存、文件、锁和轮询；具体路径由宿主决定 | HTTP/JSON-RPC、HTTP+JSON/REST、gRPC 等绑定 |
| 长任务 | 目标忙时排队，空闲时重新提交或作为 attachment 注入 | Task 负责跨请求追踪，支持流式状态和异步 push |
| 安全边界 | 本地文件权限、地址校验、锁和产品内权限上下文 | 需要在协议/网关层处理认证、授权、租户和网络安全 |
| 兼容目标 | 让当前 Claude Code 的多个会话可靠协作 | 让互不认识的 Agent 能够协商并完成任务 |

这里有一个很实用的组合方式，把 A2A 当作入口协议，把 mailbox 当作某个 Agent 内部的适配层。

```text
A2A SendMessage
      │ 认证、能力与地址检查
      ▼
本地 A2A gateway ──► teammate mailbox ──► Query Loop
                                           │
                                           ├─ tool_use / tool_result
                                           └─ Task 状态与结果
      ▲
      └──────── A2A response / stream / push
```

这条图是架构推断，不是 2.1.88 已经内置的 A2A 实现，源码能确认 mailbox 的本地交付路径，A2A 规范能确认远端任务语义，二者之间的 gateway 需要由产品或用户自己实现。反过来，A2A 也不要求接收端使用文件 mailbox；它可以直接把请求交给自己的任务调度器、数据库队列或另一个服务。

## 正文

### 先看系列总地图

如果把 Claude Code 看成一条生产线，前 48 篇共同构成从底到顶的逐层展开，

```text
阅读边界与全景
        ↓
Agent 执行内核：请求 → 循环 → 消息 → API → 工具
        ↓
执行与安全：并发 → 校验 → 权限 → 沙箱 → 文件 → 搜索 → 上下文
        ↓
能力与扩展：命令 → Skill → Task → sub-agent → team → MCP → plugin → LSP
        ↓
宿主与分布式：状态 → TUI → 快捷键 → Structured IO → 配置 → provider → bridge
        ↓
产品化与实验：记忆 → dream → assistant → buddy → voice → MagicDocs → 通知
        ↓
48：把结果送回正确的人、Agent 和产品阶段
```

下面的路线图沿用系列早期的分层图；00到47 是主体阅读路径，48 在这条路径末端完成总结。

![Claude Code 源码解读系列路线图](/images/posts/claude-code-source-reading-48/series-roadmap.png)

### 00 到 47 每篇文章讲了什么

#### S0｜先规定「我们正在读什么」

| 篇 | 文章主题 | 一句话总结 |
| --- | --- | --- |
| 00 | 从源码泄露开始，读懂 Claude Code | 交代源码泄露时间线、2.1.88 版本边界、还原方法和全系列阅读路线。 |
| 00-a | 一篇逆向论文怎样拆开生产级 Agent 🔬 | 通过论文的证据分层和设计空间，说明怎样从 source map 推导架构，同时守住事实与推断的边界。 |
| 01 | 从系统地图认识整体架构 | 把入口、Query Loop、工具、任务、状态、UI、扩展和远程运行放到同一张系统图里。 |

#### S1｜一次请求怎样变成一次 Agent 工作

| 篇 | 文章主题 | 一句话总结 |
| --- | --- | --- |
| 02 | 一次请求如何走完 Claude Code | 沿输入、上下文、模型流、`tool_use`、`tool_result`、继续推理和最终输出走完一个 turn。 |
| 03 | 引导与初始化 | 解释 CLI 入口、setup、迁移、配置预取和 REPL 挂载怎样把进程变成可工作的会话。 |
| 04 | 多种运行入口 | 比较交互式 CLI、print/headless、SDK、MCP server、Bridge 与 direct-connect 如何共享内核。 |
| 05 | QueryEngine 如何编排调用 | 分析会话、消息、权限上下文、文件状态和无头调用怎样被统一封装。 |
| 06 | 代理循环如何持续推进 | 深入 query 子模块，说明模型，工具，结果的循环、停止条件、继续推理和预算控制。 |
| 07 | 对话、工具与内部事件 | 梳理 user、assistant、tool、system、流式增量和内部事件之间的转换关系。 |
| 08 | Claude 请求与响应如何传输 | 解释 API 请求构造、流式/非流式路径、prompt cache、重试、错误映射和后端适配。 |
| 09 | 工具契约与注册表 | 从 Tool 接口、输入 schema、能力元数据和 `buildTool` 看到基础工具池如何动态装配。 |

#### S2｜执行不是「调用一个函数」这么简单

| 篇 | 文章主题 | 一句话总结 |
| --- | --- | --- |
| 10 | 多个 `tool_use` 的串并行执行 | 解释工具分组、可并发边界、取消、进度合并，以及为什么不是所有调用都能并发。 |
| 11 | 一次调用的完整生命周期 | 追踪工具查找、`validateInput`、授权、执行、结果映射和持久化，区分一般输入校验与具体工具语义。 |
| 12 | 权限引擎 | 拆解 allow、ask、deny、permission mode、优先级、用户确认和权限上下文传播。 |
| 13 | 命令执行安全边界 | 分析 Bash/PowerShell 解析、路径和命令验证、沙箱、危险操作识别，以及云端分类模型与本地校验的边界。 |
| 14 | 快照与历史如何实现回滚 | 解释 Read 凭据与写入保护、checkpoint/file history 的保存、按文件恢复和不可回滚的副作用。 |
| 15 | 本地与网络检索如何协作 | 比较 Glob、Grep、ripgrep、WebSearch、WebFetch 的搜索、分页、截断和错误恢复策略。 |
| 16 | 项目上下文如何注入 | 解释系统提示词分块、CLAUDE.md、环境信息和动态 section 怎样组成有效上下文。 |
| 17 | 长会话如何继续运行 | 梳理 token 估算、microcompact、partial/full compact、摘要回填和压缩后的清理。 |
| 18 | 生命周期机制如何横切运行时 | 说明 PreToolUse、PostToolUse、Stop、PreCompact 等 hook 如何匹配、阻断、改写和回传。 |
| 19 | 重试、降级与恢复 | 汇总 API、流、工具和会话层的错误分类、退避、降级、恢复与诊断信息。 |
| 20 | 恢复、续接与分叉对话 | 解析 JSONL transcript、历史写入、`/resume`、`/fork`、粘贴引用和会话恢复。 |

#### S3｜把能力做成可以复用和组合的部件

| 篇 | 文章主题 | 一句话总结 |
| --- | --- | --- |
| 21 | 用户如何进入不同执行流程 | 比较 prompt、local、local-jsx 命令，解释注册、解析、启用条件和 UI 命令流程。 |
| 22 | 提示词如何变成 Skill | 分析 Skill 的发现、加载、slash 命令化、内联执行、fork 执行和插件关系。 |
| 23 | 前台、后台与状态机 | 解释统一 Task 抽象、前后台切换、状态机、输出流、取消和终态管理。 |
| 24 | 如何隔离上下文并委派任务 | 深入 AgentTool 与 LocalAgentTask，研究模型选择、上下文隔离、结果回流和后台化。 |
| 25 | 多 Agent 如何协作 | 解析 teammate、消息传递、共享任务、协调模式和 Agent Team 生命周期。 |
| 26 | 规划与执行如何隔离 | 分析 plan mode、退出审批、worktree 隔离和从计划转入执行的状态变化。 |
| 27 | 如何连接外部工具与资源 | 拆解 MCP 配置、连接、传输、认证、工具/资源装配、权限和故障处理。 |
| 28 | 插件如何扩展能力 | 说明插件发现、安装、manifest、命令、Agent、Skill 注入与信任边界。 |
| 29 | LSP 如何提供代码智能 | 研究 LSP server 生命周期、诊断注册表和语言反馈怎样进入 Agent 工作流。 |
| 30 | 浏览器与 IDE 如何接入 | 汇总 Claude in Chrome、IDE 集成、外部工具搜索和宿主通信适配层。 |

#### S4｜同一个内核怎样住进不同宿主

| 篇 | 文章主题 | 一句话总结 |
| --- | --- | --- |
| 31 | 共享状态如何贯穿系统 | 分析 AppState、轻量 store、selector、订阅和 UI/工具/任务共享状态的方式。 |
| 32 | 交互式 REPL 如何渲染 | 拆解 Ink/React 终端渲染、消息列表、输入、弹窗和流式刷新。 |
| 33 | 终端编辑状态如何解析 | 解释快捷键解析、冲突校验、上下文绑定、保留键和 Vim 编辑状态机。 |
| 34 | Structured IO 如何工作 | 研究 print 模式、SDK 消息、JSON、SSE、WebSocket 和非交互权限处理。 |
| 35 | 配置如何分层同步 | 梳理用户、项目、托管配置的优先级、同步、缓存、实验开关和构建裁剪。 |
| 36 | 认证与 provider 如何接入 | 分析模型选择与降级、认证、Anthropic、Bedrock、Vertex、Foundry、代理和 TLS。 |
| 37 | 远程会话与 Server | 解释 ReplBridge、远程会话、WebSocket、worker 轮询、权限桥和 direct-connect server。 |
| 38 | 日志、成本与诊断 | 汇总日志、遥测、GrowthBook、usage、性能指标、诊断追踪和隐私开关。 |
| 39 | 更新、迁移与 onboarding | 研究自动更新、配置迁移、首次启动、项目可信和向后兼容策略。 |

#### S5｜产品层如何叠加在 Agent 内核上（🔬 实验子系统为主）

| 篇 | 文章主题 | 一句话总结 |
| --- | --- | --- |
| 40 | Session Memory | 解释会话怎样提炼标题、任务状态、关键文件、错误、结果和工作日志；它是「跨 compact/后续会话可复用的会话摘要」，不是完整 transcript。 |
| 41 | memdir 与 team memory 🔬 | 说明记忆索引、相关检索、年龄策略、团队路径、同步和密钥扫描。 |
| 42 | AutoDream 🔬 | 研究后台记忆整合的触发门槛、锁、提示词、进度监视和任务化执行。 |
| 43 | assistant/Kairos 🔬 | 拆解辅助模式、会话历史、消息适配，以及它和主 Coding Agent 的差异。 |
| 44 | Buddy 🔬 | 分析陪伴式体验的状态、组件和交互，理解产品层怎样叠加在 Agent 之上。 |
| 45 | Voice 🔬 | 说明音频捕获、流式 STT、关键词、权限、状态和终端输入怎样融合。 |
| 46 | MagicDocs 与提示词建议 🔬 | 研究文档生成、PromptSuggestion、tips 和主动建议的触发与边界。 |
| 47 | 通知、mailbox 与 Output Style 🔬 | 区分生成约束、Agent 投递、UI/OS 注意力和 TUI/SDK 宿主输出，说明它们如何形成反馈闭环。 |

> 🔬 = 产品实验子系统，受构建期或灰度开关控制，可选阅读，不影响理解内核。41到47 的「问题」与「回顾」链上还有 Buddy reroll、WSL Voice、MagicDocs 最佳实践、mailbox 与 A2A 等扩展问答。

这张表也解释了为什么「Claude Code 是不是一个大 prompt」不是一个好问题，prompt 只是执行循环中的一层。输入要经过会话与上下文，行动要经过工具契约与权限，结果要经过任务状态和宿主协议，最后还要由通知、mailbox 或远程界面把它送到正确的受众。

### 系列验收清单｜七项可验证的能力

读完源码后，检验标准是下面七项能力，不是记住多少个函数名。每一项都给出**可以当场执行的验收动作**；做不到的项，回到对应章节补读。

#### 1. 我能画出循环吗？（对应 02 到 07）

- [ ] 能画出一次用户输入从 `query()` 进入 Query Loop，经过模型流、`tool_use` / `tool_result` 回填、继续推理，到最终输出的完整闭环；
- [ ] 能区分 user / assistant / tool / system 四类消息与流式增量事件的关系；
- [ ] 能说出停止条件（stop reason）、`max_turns` 与预算控制分别在哪一层生效；
- [ ] 能指出「工具结果回填」与「下一次模型调用」之间发生了什么。

#### 2. 我能定位关键符号吗？（对应 01、05、09、31、37）

- [ ] 能说出 `queryLoop()`、`queryEngine`、`buildTool` / Tool 注册表、`AppState`、`handleStopHooks()`、`runForkedAgent()` 各自所在文件；
- [ ] 能给出一条「函数 → 调用点 → 状态写回」的三跳路径，并用 `restored-src/` 前缀 + 文件 + 行号标注证据；
- [ ] 能区分「入口符号」「执行符号」「状态符号」三者的职责。

#### 3. 我能解释权限吗？（对应 11 到 13、24、40）

- [ ] 能区分 `allow` / `ask` / `deny`、permission mode（`default` / `plan` / `acceptEdits` / `bypassPermissions`）与权限上下文传播；
- [ ] 能解释「模型决定调用」与「进程允许执行」是两件事（工具契约 vs 权限引擎）；
- [ ] 能说出至少两个「收窄权限」的例子，memory fork 只允许精确路径的 `Edit`（40 篇）、Dream fork 的 Bash 只放行只读（42 篇）、压缩 agent 直接 deny 所有工具（17 篇）；
- [ ] 能解释 hook 改写工具输入与 `canUseTool` 决策的关系。

#### 4. 我能运行压缩实验吗？（对应 17、40）

- [ ] 能用 `/context` 记录压缩前的消息数与 token 估算，执行 `/compact`，再对比压缩后是否保留了最近原始消息；
- [ ] 能解释 Microcompact（改内容/改缓存）与 Autocompact（重建上下文）的差异，以及 SM Compact 的零成本回退链（40 篇）；
- [ ] 能在 debug 日志中识别 snip / microcompact / compact 事件，并区分 `cache_read` 与 `cache_creation` 的变化是主动清理还是恢复回归（17 篇 #42338 的教训）。

#### 5. 我能读 trace 吗？（对应 20、34、38）

- [ ] 能打开 session JSONL，按 `parentUuid` 重建父子链、找到叶子消息，解释 `/resume` 和 `/fork` 为什么依赖这条链；
- [ ] 能区分 `--output-format json` 与 `stream-json` 的输出结构（`lastMessage` vs NDJSON 流），并知道 `verbose` 的差异；
- [ ] 能说明 debug log、diagnostic JSONL、analytics event 三者字段约束的差异，以及哪些信息只在 `USER_TYPE === 'ant'` 时上报。

#### 6. 我能实现最小 harness 吗？（对应 04、34、37）

- [ ] 能用 `claude -p`（print 模式）或 SDK 模式跑一条无头查询，并解释它为什么共享交互式内核；
- [ ] 能做一个最小旁路，用 `runForkedAgent()` + `canUseTool` 拒绝全部工具 + `skipTranscript`，模拟一次不污染主对话的后台生成（46 篇 Prompt Suggestions 的结构）；
- [ ] 能解释 print 模式与 SDK 模式的宿主差异，谁负责序列化、谁负责权限提示、谁负责流式事件。

#### 7. 我能解释静态证据边界吗？（对应 00-a、17、44、45）

- [ ] 能把证据分成四类，已确认（源码直接可见）、调用点已确认但实现 ⚠️ MISSING（如 Context Collapse、Buddy observer）、运行时数据（GrowthBook、远端配置）、外部版本证据（源码注释里的历史事故、社区文章）；
- [ ] 能对每个章节说出至少一个「源码能确认什么、不能确认什么」的边界（例如，能确认 Buddy 的确定性 seed，不能确认 observer 的提示词与失败策略）；
- [ ] 能解释「能解析版本号 ≠ 能下载该版本」「能启动 Claude Code ≠ 能访问麦克风」「记忆被生成 ≠ 记忆必然正确」这类边界句式的含义。

### 一张工单怎样走完这张地图

把整套章节放回一个真实工作日里，会更容易看出它们之间的关系。09，12，支付值班工程师在终端输入结算页显示 99.90 元、回调却记录 9991 分的金额单位工单；01 章先问这句话从哪里进入，02到09 章沿着 Query Loop、消息、API 和工具把第一轮证据跑出来。09，40，调查开始并发读取代码、MCP 工单和官方文档，权限层挡住了第一次写入；10到11 章解释这些调用怎样编排、校验和回流。

午前，工程师在 Plan mode 里确认根因，给金额计算、回调解析和浏览器复现分别分配 sub-agent 与 teammate；23到30 章处理后台 Task、协作、worktree、MCP、Plugin、LSP、IDE 和 Chrome。11，26，上下文接近上限，他 compact 后从远端继续；17到20 章解释长会话怎样压缩、失败怎样恢复、历史怎样分叉。下午发布完成后，40到47 章再追踪根因如何进入 session/team memory，AutoDream 如何在后台整理，助手、Buddy、Voice、MagicDocs 和通知如何把结果送到下一位值班人。

这里用一个工单为每个边界提供可观察的落点，输入有来源，工具有权限，任务有状态，结果有受众。它不是把同一工单硬套进每篇文章。

### Claude Code 的产品时间线

下面的时间线用公开公告标出产品形态的变化，不能把今天的产品倒推回 2.1.88。日期以公告页面为准；研究预览、beta 和文档能力都可能继续变化。

| 时间 | 产品节点 | 它改变了什么 |
| --- | --- | --- |
| 2025-02-24 | Claude Code 以 limited research preview 发布 | Claude Code 第一次作为命令行 Agent 对外出现，能搜索/读取代码、编辑文件、运行测试、调用命令行，并在过程中让用户保持控制。 |
| 2025-05-22 | Claude Code 随 Claude 4 GA | 从研究预览进入一般可用；支持 GitHub Actions 后台任务，以及 VS Code、JetBrains 原生集成，终端 Agent 开始有更完整的开发入口。 |
| 2025-06-18 | Remote MCP 支持 | 外部工具和数据源从「本地手动维护服务器」扩展到远程 MCP URL，并提供 OAuth；MCP 从插件式能力变成持续接入的工作界面。 |
| 2025-08-20 | Team/Enterprise 管理能力 | 产品开始面对组织规模，premium seats、花费上限、usage analytics、托管策略和 Compliance API 把单机工具接到治理体系。 |
| 2025-09-29 | 2.0 终端体验与 Claude Agent SDK | 原 Claude Code SDK 更名为 Agent SDK，开放 subagents 和 hooks；同时发布 native VS Code extension、终端 2.0、checkpoints、后台任务等更长时间运行的能力。 |
| 2025-10-09 | Plugins public beta | slash commands、subagents、MCP servers、hooks 可以打包成一个可安装、可开关的分发单元，扩展生态有了统一容器。 |
| 2025-10-16 | Agent Skills 发布 | Skill 变成跨 Claude 应用、Claude Code 和 API 的可组合目录，按需加载指令、脚本和资源，而不是把所有知识常驻在 `CLAUDE.md`。 |
| 2025-10-20 | Claude Code on the web research preview | 任务可以在 Anthropic 管理的云沙箱中并行运行，从 GitHub 仓库开始、自动创建 PR，并提供移动端入口；这与本地 CLI 是另一种执行边界。 |
| 2025-12-03 | Bun 收购与 $1B run-rate 里程碑 | Claude Code 从内部工程实验成长为重要商业产品；原生安装器和运行时基础设施成为产品规模化的一部分。 |
| 2026-02-20 | Desktop 的 preview/review/merge 闭环 | 桌面端可以预览运行中的应用、自动 review 和修复代码、合并 PR，并在 desktop、mobile、CLI 之间切换。 |
| 2026-04-14 | Routines research preview | 把 prompt、仓库和 connectors 配成可复用的云端 routine，可由 schedule、API 或事件触发；`/schedule` 也开始指向这一自动化形态。 |
| 2026-06-18 | Artifacts 进入 Claude Code | 把会话中的过程变成可分享、可交互的页面，例如 PR walkthrough、dashboard 和 release checklist，结果的受众从当前终端扩展到团队。 |
| 2026-06-23 | Claude Tag 在 Slack beta | `@Claude` 让 Claude Code 式的分阶段执行进入多人协作频道；Agent 不再只面对单个终端用户，而是成为团队线程里的可见协作者。 |

从这条时间线能看到三次明显的转向，

1. **从命令行工具到 Agent 内核。** 2025 年 2 月的产品重点是「在终端里替你完成一段工程工作」；5 月之后，SDK、hooks、subagents 和 checkpoints 把这套内核开放给更多工作流。
2. **从单机工作到可组合生态。** Remote MCP、plugins 和 Skills 分别解决外部工具接入、能力分发和按需知识加载；它们对应本系列 27、28、22/46 看到的扩展边界。
3. **从个人会话到多宿主协作。** VS Code、web、desktop、mobile、Artifacts、Slack 和 Routines 把「结果怎样离开当前终端」变成产品主线；这正好回到第 47 篇的 Output Style、mailbox、notification 和宿主分层。

需要特别注意，公开时间线和源码版本不是一一对应的。系列的 2.1.88 只是一个可复现的源码观察窗口；产品在它之后继续加入 web、plugins、Skills、Routines 等能力，不能把这些后续公告当成 2.1.88 已经存在的源码事实。反过来，2.1.88 中某些实验分支也不代表它们最终会成为公开产品。

### 读完源码后，应该怎样使用这张地图

遇到问题时，可以先问它属于哪一个边界，而不是立即把所有文件交给模型，

- **模型答得不对。** 先看 system prompt、项目上下文、Output Style 和 compact 是否改变了输入；不要一上来怀疑 renderer。
- **工具执行不符合预期。** 沿工具契约、`validateInput`、权限决策、sandbox 和错误映射查；「模型决定调用」与「进程允许执行」是两件事。
- **长任务中断或重复。** 看 Task 状态、mailbox 的 pending/read/processed、session JSONL 和 checkpoint；不要只盯着最后一条 assistant 文本。
- **想扩展 Claude Code。** 稳定约束放 `CLAUDE.md`，可复用步骤用 Skill，机械动作交给 hook，外部数据接 MCP，需要组合分发时用 plugin；不要把所有东西塞进 system prompt。
- **想远程使用。** 先区分「云端新建任务」「本地会话的远程控制」和「SDK/Bridge 接入」。它们的代码执行位置、文件权限、网络边界和断线语义都不同。

源码阅读的价值在于建立故障定位的坐标系，输入在哪一层被改写，权限在哪一层被拒绝，状态在哪一层丢失，结果在哪一层没有抵达受众。坐标系有了，版本升级时即使文件移动，也能沿着相同的责任边界重新定位。

## 源码映射｜系列关键符号速查表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。这张表是系列的「符号 → 位置」速查索引，行号以当前仓库为准。

| 层 | 关键符号 | 位置 |
| --- | --- | --- |
| 入口 | `setup()` / `startCLI()` | `src/setup.ts`、`src/main.tsx` |
| 循环 | `queryLoop()` / `query()` / `handleStopHooks()` | `src/query.ts`、`src/query/stopHooks.ts` |
| 消息 | 消息类型 / `buildPostCompactMessages()` | `src/types/messages.ts`、`src/services/compact/compact.ts` |
| API | `getChatCompletionStream()` / prompt cache 处理 | `src/query/chat` 相关模块 |
| 工具 | `buildTool()` / Tool 注册表 | `src/tools/index.ts` |
| 权限 | `canUseTool` / permission mode / `validateInput` | `src/query/toolPermissionContext.ts` 等 |
| 压缩 | `microcompactMessages()` / `autoCompactIfNeeded()` / `trySessionMemoryCompaction()` | `src/services/compact/` |
| 历史 | transcript JSONL / `/resume` / `/fork` | `src/utils/sessionStorage.ts` |
| 状态 | AppState / store / selector | `src/state/AppStateStore.ts` |
| 记忆 | `loadMemoryPrompt()` / `getAutoMemPath()` / `extractSessionMemory` | `src/memdir/`、`src/services/SessionMemory/` |
| 后台 | `runForkedAgent()` / `executeAutoDream()` | `src/utils/forkedAgent.ts`、`src/services/autoDream/` |
| 反馈 | `getOutputStyleConfig()` / `sendNotification()` / `writeToMailbox()` | `src/constants/outputStyles.ts`、`src/services/notifier.ts`、`src/utils/teammateMailbox.ts` |

## 设计决策

**第一，为什么系列以「能力清单」而非「知识点清单」收尾？** 48 个知识点会在版本升级后过时，但七项能力（画循环、定位符号、解释权限、跑实验、读 trace、写 harness、划证据边界）对应的是可迁移的阅读方法。清单里的每项都给了验收动作，读者可以当场自检，做不到的项回到对应章节，而不是重读整份文档。

**第二，为什么源码快照与产品时间线必须分开？** 它们是两条证据链，源码快照回答「2.1.88 这一版怎样工作」，产品时间线回答「产品形态何时变化」。把后续版本的公告（Skills、Routines、Artifacts、Claude Tag）当作 2.1.88 的源码事实，会破坏整套证据边界；反过来，把 2.1.88 的实验分支当成最终产品，也会误判方向。2.1.88 只是一个可复现的观察窗口。

**第三，为什么实验子系统要整体标记 🔬？** 41到47 受构建期（`TEAMMEM`、`KAIROS`、`BUDDY`、`VOICE_MODE`）与灰度开关控制，MagicDocs 只在 `USER_TYPE === 'ant'` 初始化、Buddy 在后续版本被移除。这个标记提醒读者，这些章节的「问题 → 正文 → 源码映射」链依然遵守证据规则，但产品形态可能随版本消失或改名，内核章节的结论比体验层更稳定。

## 练习

1. **跑一遍七项清单。** 按「系列验收清单」逐项自检，画一次闭环（第 1 项）、给一个三跳符号路径（第 2 项）、讲一次权限拒绝（第 3 项）、做一次压缩实验（第 4 项）、打开一个 session JSONL 找 leaf（第 5 项）、用 `claude -p` 跑一条无头查询（第 6 项）、写出本章的三个证据边界（第 7 项）。每一项都对应具体章节，做不到就回去补读。

2. **对照时间线重读一张地图。** 选时间线里的一个节点（例如 2025-10-16 Agent Skills），回到 22 篇对照 Skill 的源码实现；再选 2026-04-14 Routines，对照 43 篇的 Cron/scheduler。体会「公告描述产品意图，源码确认实现边界」的互补关系。

3. **给自己的项目建立坐标系。** 把「输入在哪一层被改写、权限在哪一层被拒绝、状态在哪一层丢失、结果在哪一层没有抵达受众」四个问题写进你的排障笔记，下一次 Claude Code 行为异常时按坐标定位，而不是把所有文件丢给模型。

## 自测

1. 为什么「Claude Code 是不是一个大 prompt」不是一个好问题？
2. 源码快照与产品时间线为什么是两条不能互相证明的证据链？
3. 41到47 篇为什么要标记 🔬？标记改变了它们的证据规则吗？

<details>
<summary>参考答案</summary>

1. **prompt 只是执行循环中的一层。** 输入要经过会话与上下文（16 篇），行动要经过工具契约与权限（09、12 篇），结果要经过任务状态和宿主协议（23、34 篇），最后还要由通知、mailbox 或远程界面送到正确受众（47 篇）。「一个大 prompt」的提法把六层边界压缩成一层，既解释不了权限拒绝，也解释不了状态丢失。

2. **它们回答不同的问题。** 源码快照回答「2.1.88 这一版代码怎样工作」，证据是 source map；产品时间线回答「产品形态何时变化」，证据是公开公告。后续版本的公告不能证明 2.1.88 已有该能力，2.1.88 的实验分支也不代表最终成为公开产品。混用两条证据链是系列最典型的误读来源（00-a 篇的证据分层正是为此）。

3. **标记表明产品形态的不稳定性，不改变证据规则。** 41到47 受构建期与灰度开关控制（`TEAMMEM`、`KAIROS`、`BUDDY`、`VOICE_MODE`），MagicDocs 只在 `USER_TYPE === 'ant'` 初始化、Buddy 在后续版本被移除。标记只说明「这些能力可能随版本消失或改名」；每篇的「问题 → 正文 → 源码映射 → 设计决策」依然遵守同一套证据边界，能确认的确认，不能确认的标注 ⚠️ MISSING。

</details>

## 回顾｜系列闭环

<details>
<summary>展开查看回顾</summary>

这 48 篇文章从「源码从哪里来」开始，最后回到「结果要送给谁」，

```text
用户输入
  → 上下文与 Query Loop
  → 模型流与 tool_use
  → 权限、工具和任务状态
  → compact、memory、team 与远程宿主
  → TUI / SDK / web / notification / mailbox
  → 人或另一个 Agent
```

Claude Code 的核心是一组围绕模型组织起来的边界。模型提出行动，权限层决定行动是否被允许，工具层执行副作用，状态层记录进度，宿主选择呈现方式，再用 mailbox、通知或远程界面把结果送回正确的对象。产品时间线则说明，这套内核正在从本地命令行向可组合、可治理、可远程、可协作的 Agent 平台扩展。

本系列的源码边界停在 2.1.88，但问题不会停在这里。以后再看新的版本，最值得追踪的仍然是同一组问题，新的能力进入了哪一层？谁拥有它的权限？它的状态在哪里持久化？失败后怎样恢复？结果最终怎样抵达用户或另一个 Agent？只要沿着这条主线，源码的变化就不会变成一堆孤立的 diff。

感谢你一路读到这里。希望这张地图能让你下一次打开 Claude Code 源码时，不只是找到「它调用了哪个函数」，而是看懂「这个产品为什么要这样分层」。

</details>

## 相关链接

- **上一篇**，[47 非核心反馈通道如何协作](./47-notifications-mailbox-and-output-styles.md)，mailbox 与 A2A 的异同
- **平行阅读**，[00 系列指南](./00-series-guide.md)，回到系列起点重新对照
- **平行阅读**，[00-a 一篇逆向论文怎样拆开生产级 Agent](./00-a-dive-into-claude-code-paper.md)，证据分层方法
- [Agent2Agent (A2A) Protocol Specification](https://a2a-protocol.org/latest/specification)
- [A2A/specification.md，Agent2Agent Protocol](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
- [Agent-to-Agent (A2A)，Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/journey/agent-to-agent)
- [A survey of agent interoperability protocols](https://arxiv.org/abs/2505.02279)
- [Claude 3.7 Sonnet and Claude Code](https://www.anthropic.com/news/claude-3-7-sonnet)
- [Introducing Claude 4](https://www.anthropic.com/news/claude-4)
- [Remote MCP support in Claude Code](https://www.anthropic.com/news/claude-code-remote-mcp)
- [Claude Code and new admin controls for business plans](https://www.anthropic.com/news/claude-code-on-team-and-enterprise)
- [Enabling Claude Code to work more autonomously](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)
- [Customize Claude Code with plugins](https://claude.com/blog/claude-code-plugins)
- [Introducing Agent Skills](https://claude.com/blog/skills)
- [Claude Code on the web](https://claude.com/blog/claude-code-on-the-web)
- [Anthropic acquires Bun as Claude Code reaches $1B milestone](https://www.anthropic.com/news/anthropic-acquires-bun-as-claude-code-reaches-usd1b-milestone)
- [Preview, review, and merge with Claude Code](https://claude.com/blog/preview-review-and-merge-with-claude-code)
- [Introducing routines in Claude Code](https://claude.com/blog/introducing-routines-in-claude-code)
- [Claude Code now supports artifacts](https://claude.com/blog/artifacts-in-claude-code)
- [Introducing Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)
