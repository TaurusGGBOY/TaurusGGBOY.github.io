---
title: "Agent主题对比09｜A2A：从多 Agent 通信到跨边界协作"
published: 2026-08-17T10:08:00+08:00
updated: 2026-08-17
description: "梳理 A2A 的概念前身、协议演进与当前生态，并对照 Claude Code、Codex、Pi、DeepSeek harness 的相似机制，判断 Agent 项目是否需要完整实现 A2A。"
tags: ["agent-theme-comparison", "ai-agent", "a2a", "claude-code", "codex-cli", "pi", "deepseek-harness"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-09-a2a-interoperability/a2a-cover.webp"
imagePosition: "center"
slug: "agent-theme-09-a2a-interoperability"
series: "agent-theme-comparison"
order: 9
difficulty: "advanced"
time: "55 min"
prerequisites:
  - "Agent主题对比 04｜扩展、委派与多 Agent"
  - "Agent主题对比 08｜体验层、反馈通道与系列收束"
topics:
  - "A2A"
  - "agent interoperability"
  - "agent protocol"
  - "multi-agent"
  - "Claude Code"
  - "Codex"
  - "Pi"
  - "DeepSeek harness"
source_modules:
  - "a2aproject/A2A"
  - "anthropics/claude-code"
  - "openai/codex"
  - "badlogic/pi-mono"
  - "deepseek-ai/deepseek-harness"
status: "verified"
verified_at: "2026-08-17"
---

> A2A 真正解决的不是“如何再启动一个 Agent”，而是“一个内部实现不可见的 Agent，如何被另一个团队、另一种框架或另一家厂商可靠地发现、委托、等待和接收结果”。

这篇文章回答五个问题：A2A 从哪里来、现在的协议到底标准化了什么、哪些项目已经在使用它、Claude Code / Codex / Pi / DeepSeek harness 有没有 A2A 或相似实现，以及一个 Agent 项目到底有没有必要完整实现 A2A。

先把判断放在前面：A2A 是跨边界的 Agent 互操作协议，不是所有多 Agent 架构的底座。一个 CLI 内部的子 Agent、同一进程里的函数调用、文件 mailbox、thread tree、stdin/stdout RPC，都可能解决协作问题，却不因此变成 A2A。多数项目应该先把自己的内部运行时做好，再在真正需要跨产品协作的边界上增加 A2A adapter 或 gateway。

## 一、A2A 的前身：不是一条单线继承史

![A2A 从早期 Agent 通信思想走向开放协议的演进示意图](/images/posts/agent-theme-09-a2a-interoperability/a2a-history.webp)

### 1. 早期 Agent 通信标准：KQML 与 FIPA

A2A 的思想并不是 2025 年才出现。1990 年代的多 Agent 研究已经在解决类似问题：一个 Agent 如何表达意图，另一个 Agent 如何发现能力，多个 Agent 如何围绕一个协商过程交换消息。

较早的代表是 KQML（Knowledge Query and Manipulation Language）。它试图把 Agent 之间交换知识的语言和通信行为标准化，消息不只是“传一段字符串”，还带有询问、告知、请求等通信意图。KQML 的论文资料可以在 [UMBC 的 KQML 论文归档](https://research.cs.umbc.edu/kqml/papers/) 和 [该论文的开放记录](https://mdsoar.org/items/520db125-1309-4619-a505-3574c47d2205) 中看到。

之后的 FIPA 标准把这条路线推进得更系统。FIPA ACL 使用 speech-act theory 描述 communicative act，规定消息语义、交互协议和 Agent 平台中的目录服务；FIPA 的 [ACL 规范](https://www.fipa.org/specs/fipa00003/OC00003A) 与 [Agent Management 规范](https://www.fipa.org/specs/fipa00018/OC00018A.html) 都把能力发现、目录/黄页、消息路由和平台管理视为 Agent 系统的一部分。

但要注意：KQML/FIPA 是 A2A 的概念前身，不是 A2A 的代码前身，也没有证据表明 A2A 是它们的直接版本演进。它们留下的是一组长期有效的问题意识：

| 问题 | 早期标准的回答 | A2A 的现代回答 |
| --- | --- | --- |
| “你是谁、能做什么？” | Agent directory、黄页、能力描述 | Agent Card 与能力发现 |
| “我想让你做什么？” | performative、请求/告知/协商 | Message、Part 与 Task |
| “这件事完成了吗？” | 交互协议与消息序列 | Task 状态、历史与 Artifact |
| “如何找到对方？” | 平台目录和路由 | well-known Agent Card、接口与认证 |

早期标准更关心逻辑语义和通信行为；A2A 则把这些问题放进今天的 HTTP、JSON-RPC、gRPC、流式事件、异步任务、身份认证和多租户环境里。

### 2. MCP 是邻居，不是 A2A 的前一代

2024 年 Anthropic 发布 [Model Context Protocol（MCP）](https://www.anthropic.com/news/model-context-protocol)，把模型/Agent 与文件、数据库、搜索、SaaS 等工具和数据源之间的连接标准化。MCP 解决的是“Agent 如何使用外部工具和上下文”；A2A 解决的是“Agent 如何把另一个 Agent 当成一个具有自主决策能力的协作者”。

两者可以串在一起：A2A Agent 负责接收任务并做长时间协作，内部再通过 MCP 调用数据库、浏览器或企业系统。把 MCP 叫作 A2A 的前身，会混淆工具边界与 Agent 边界；更准确的说法是，两者是互补协议。

### 3. 2025 年：A2A 作为公开协议出现

2025 年 4 月 9 日，Google 发布 [Agent2Agent Protocol（A2A）](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)，将它描述为新的开放协议，并宣布已有 50 多家技术伙伴参与。Google 同时强调，协议的设计受到其大规模 Agent 系统经验的影响。因此，公开资料能支持的谱系是：

```text
Google 的大规模 Agent 经验
        ↓
2025-04 公开 A2A
        ↓
2025-06 进入 Linux Foundation 的开放项目
        ↓
2026-03 A2A 1.0.0
```

2025 年 6 月，Linux Foundation 宣布成立 [Agent2Agent Protocol Project](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)，把由 Google 创建的协议置于更中立的开放治理框架下。之后 A2A 从早期 draft 继续经历 0.2、0.3 等版本演进。

截至 2026 年 8 月 17 日，官方规范页标记的 released specification 是 1.0.0，而 GitHub release 页最新的 patch release 是 [v1.0.1](https://github.com/a2aproject/A2A/releases/tag/v1.0.1)。这里应称为 A2A 1.0 协议线，不应把 1.0.1 误解成另一代协议：patch 版本主要修复兼容性和实现问题。

## 二、A2A 到底标准化了什么

![A2A 的 Agent Card、Task、Message、Artifact 与事件交付关系](/images/posts/agent-theme-09-a2a-interoperability/a2a-protocol-model.webp)

### 1. 面向“内部实现不可见”的 Agent

A2A 的关键假设是：调用方不需要知道对方使用什么模型、什么 prompt、什么工具、什么 memory，甚至不需要知道对方内部是否还有其他子 Agent。它们通过公开能力和任务边界协作，而不是共享内部状态。

这也是 A2A 和本地 subagent API 的第一处分界：本地 subagent 往往会继承父进程的环境、权限、上下文或 thread；A2A 则要求双方通过外部契约协作，内部实现保持 opaque。可以把它理解成 Agent 世界里的服务边界，而不是一个更漂亮的 `spawn()`。

### 2. 六个核心对象与能力

官方 [A2A 规范](https://a2a-protocol.org/latest/specification/) 将数据模型、抽象操作和具体传输绑定分层。实际阅读时，可以先抓住下面几个对象：

| A2A 对象/能力 | 它解决的问题 | 不应误解成 |
| --- | --- | --- |
| Agent Card | 公开身份、技能、输入输出能力、服务接口、认证要求 | 一份内部 system prompt |
| Message / Part | 表达用户或 Agent 的意图，以及文本、文件、结构化数据等内容 | 一次完整任务的最终结果 |
| Task | 表示有生命周期、可能异步完成的工作 | 一次 HTTP 请求的临时返回值 |
| Artifact | 表示 Agent 在任务中产出的文件、结构化结果或其他交付物 | 只存在于模型上下文中的一句文本 |
| `send` / `get` / `list` / `cancel` 等操作 | 创建、查询、订阅、取消或继续任务 | 一个只能调用一次的函数 |
| streaming / push | 在长任务运行时持续交付状态、消息或 Artifact | UI 自己轮询日志 |

早期 A2A 版本已经包含 Agent Card、Task、Message、Part、Artifact 这些核心概念；1.0 进一步把 canonical data model、抽象操作和 JSON-RPC、gRPC、HTTP+JSON/REST 等 binding 分开。最新发现文件使用 `/.well-known/agent-card.json`，Agent 可以通过 `supportedInterfaces` 声明多个可用接口。

因此，一段“把 prompt POST 到另一个服务、拿回一段文本”的代码，最多是一个远程 Agent 调用；它只有在补齐能力发现、任务语义、结果交付、错误/取消和身份边界后，才接近 A2A server。

### 3. A2A 与 MCP 的边界

| 维度 | MCP | A2A |
| --- | --- | --- |
| 连接对象 | 工具、资源、数据源、提示模板 | 另一个独立 Agent |
| 主问题 | “我如何使用这个外部能力？” | “我如何把任务交给这个协作者？” |
| 状态 | 通常围绕一次工具调用或上下文获取 | 可跨多个回合、长时间运行的 Task |
| 内部透明度 | Tool schema 往往较明确 | Agent 内部决策和工具链可以保持 opaque |
| 典型结果 | 工具返回值、资源内容 | Message、Artifact、Task 状态和事件 |
| 关系 | Agent 的工具/上下文层 | Agent 之间的协作层 |

如果一个项目需要同时接入企业数据和其他 Agent，MCP 与 A2A 通常是上下叠加，而不是二选一。

## 三、现在已经有哪些项目用上了 A2A

“用了 A2A”至少有四种含义：实现了 A2A server、实现了 A2A client、通过适配器接入、在样例或产品路线中提到 A2A。把它们混成一个列表，会高估生态成熟度。

![A2A 生态中的协议 SDK、框架、产品客户端和网关](/images/posts/agent-theme-09-a2a-interoperability/a2a-ecosystem.webp)

### 1. 官方协议实现与工具链

[A2A 官方组织](https://github.com/a2aproject/) 已经提供规范、Python/JavaScript/Java/Go/.NET/Rust 等 SDK，以及 Inspector、TCK 和样例仓库。[A2A Python SDK](https://github.com/a2aproject/a2a-python) 的兼容性表将 1.0 的 JSON-RPC、HTTP+JSON/REST、gRPC 都列为 client 与 server 支持。

[官方 samples](https://github.com/a2aproject/a2a-samples) 里有不同框架的 Agent 组合，包括 LangGraph、CrewAI 等。这里的证据强度是“官方适配样例”，不能自动推出被适配的框架核心已经原生实现 A2A。例如 [CrewAI 样例](https://github.com/a2aproject/a2a-samples/tree/main/samples/python/agents/crewai) 证明可以用 CrewAI 构建并暴露一个 A2A Agent，但不等于 CrewAI 的全部运行时都内置 A2A。

官方样例还特别提醒：Agent Card、Message、Artifact、Task 状态等来自外部 Agent 的输入都应视为不可信数据，必须清洗，避免 prompt injection。这一点很重要：互操作性扩展了协作范围，也扩展了不可信输入的边界。

### 2. Google ADK：原生的暴露器与远端代理

Google ADK 是目前最清晰的 A2A 框架集成之一。[ADK 的 A2A quickstart](https://adk.dev/a2a/quickstart-exposing/) 提供 `to_a2a(root_agent)`，可以把已有 ADK Agent 暴露成 A2A server，并生成 Agent Card；同时通过 `RemoteA2aAgent` 作为 client 消费远端 Agent。

这套 API 的价值不在于“把网络请求包装成一个类”，而在于它把本地 Agent 与远端 Agent 的差异放在适配层：本地编排仍可以使用普通 subagent，只有跨网络、第三方服务或多服务边界才进入 A2A。ADK 文档目前仍把该 Python 能力标为 Experimental，生产系统需要自行验证版本、认证和任务存储策略。

### 3. Microsoft 生态：Agent Framework、Copilot Studio 与 API 网关

[Microsoft Agent Framework 的 A2A 集成](https://learn.microsoft.com/en-us/agent-framework/integrations/a2a) 提供 `A2AAgent`，把 A2A-compatible endpoint 包装成标准 `AIAgent`，并支持通过 Agent Card 发现远端 Agent。它的 server 侧也有 [A2AExecutor](https://learn.microsoft.com/en-us/agent-framework/hosting/self-hosting/a2a)，用来把 Agent Framework Agent 适配成 A2A server-side protocol。

在产品层，[Copilot Studio 可以通过 A2A 编排外部 Agent](https://learn.microsoft.com/en-us/microsoft-copilot-studio/add-agent-agent-to-agent)。在治理层，[Azure API Management 的 A2A 支持](https://learn.microsoft.com/en-us/azure/api-management/agent-to-agent-api) 更像一个网关：导入已有 A2A API、转发 JSON-RPC、改写 Agent Card 并施加认证、策略和流量治理。它并不替代后端 Agent 的 A2A server。

这组项目说明了一个现实：A2A 生态不只由 Agent 框架组成，还会出现 client、server adapter、产品级 orchestrator 和 API gateway 等不同层次。

### 4. LangGraph / LangSmith：通过 Agent Server 暴露端点

[LangSmith Agent Server 的 A2A 文档](https://docs.langchain.com/langsmith/server-a2a) 提供 `/a2a/{assistant_id}` endpoint，自动暴露 Agent Card，并支持 message/send、message/stream 和 tasks/get 等操作。它把 LangGraph 的 thread continuity 映射到 A2A 的 `contextId` 与 `taskId`，这是“内部有自己的状态模型，外部用 A2A 交付”的典型做法。

### 5. Salesforce 与其他产品：要区分 pilot、适配器和 GA

Salesforce 的公开资料呈现出更谨慎的成熟度信号：2025 年的 [AgentExchange 公告](https://www.salesforce.com/blog/connected-agents-agentexchange/?bc=OTH) 把 A2A 放在连接其他 Agent 的能力描述中；其 2026 年 5 月的 [官方 Help 文档](https://help.salesforce.com/s/articleView?id=005317683&language=en_US&type=1) 明确写的是 A2A Inbound Pilot 于 2026 年 3 月启动。Pilot 可以证明产品正在接入 A2A，但不能写成已经 GA 的完整原生实现。

因此，当前生态更适合用下面的分级来描述：

| 层级 | 例子 | 结论强度 |
| --- | --- | --- |
| 协议原生工具链 | A2A SDK、Inspector、TCK、官方 samples | 可以直接讨论协议能力 |
| 框架 server/client | Google ADK、Microsoft Agent Framework、LangSmith | 已有可运行的适配与端点 |
| 产品级 client/gateway | Copilot Studio、Azure API Management | 说明产品能接入或治理 A2A，不代表它本身是 Agent server |
| pilot/样例/概念宣传 | Salesforce Pilot、各框架的样例 | 只能按公开状态描述，不能推断 GA |

## 四、Claude Code、Codex、Pi、DeepSeek harness：有 A2A 吗

下面的判断采用一个严格口径：如果没有看到 Agent Card、标准 Task/Message/Artifact、A2A binding 和跨边界发现/认证，就不把“相似机制”写成 A2A。四个项目的代码快照与版本会变化，以下结论以 2026 年 8 月 17 日可见的公开资料和源码对照为准；“未发现”不等于证明项目内部不存在未公开实验。

![四个 Agent 项目的内部协作机制与外部 A2A 边界对照](/images/posts/agent-theme-09-a2a-interoperability/a2a-four-projects.webp)

### 1. Claude Code：Agent Teams 是内部协作，不是公开 A2A

Claude Code 当前公开的多 Agent 能力主要分成两层：

- [Subagents](https://code.claude.com/docs/en/sub-agents) 在单个会话中创建独立上下文，把结果汇总回父 Agent；
- [Agent Teams](https://code.claude.com/docs/en/agent-teams) 创建多个独立 Claude Code session，共享任务列表，并允许 teammate 之间直接消息通信。

这已经是很完整的内部协作模型。源码对照快照中可以看到 `AgentTool`、`LocalAgentTask`、`pendingMessages`、teammate mailbox 等机制：Agent 有自己的任务状态和上下文，消息可以排队，后台任务可以完成、失败、取消，团队还需要共享任务表来避免重复认领。

但它与 A2A 仍有明显差别。Agent Teams 的身份主要是 team、teammate、session 和本地任务 ID；消息投递面向同一 Claude Code 产品内部的协作；官方文档也把它描述成多实例协调能力，而不是通用跨厂商协议。当前公开资料和我们对第三方源码重建快照的检索中，没有找到 A2A Agent Card、标准 Artifact、`.well-known/agent-card.json` 或公开 A2A endpoint。

所以更准确的说法是：Claude Code 具备 Agent Teams、mailbox、任务状态和权限上浮等 A2A-like 能力，但没有证据表明它提供完整的公开 A2A 实现。关于 mailbox 与 A2A 的差异，可结合本系列的 [Claude Code 源码解读 48](/posts/claude-code-source-reading-48/) 阅读。

### 2. Codex：内部 thread tree 与 InterAgentCommunication

Codex CLI 的公开源码展示了另一种内部协作路线。[多 Agent 工具规格](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) 包含 `spawn_agent`、`send_input`、`resume_agent`、`wait`、`close_agent`，以及新协作模型中的消息、follow-up、interrupt 和 list 操作。

它的核心不是 A2A Task，而是 Codex 自己的 thread/turn/agent path：

- `spawn_agent` 创建带 parent thread、depth、agent path、role 和 task name 的子线程；
- `InterAgentCommunication` 携带发送方、接收方、内容、元数据和触发回合；
- `send_message` 可以把信息排队给其他 Agent，`followup_task` 决定何时推动下一回合；
- app-server 还提供面向 IDE、TUI 和其他客户端的双向 JSON-RPC-like 接口。

这些设计比简单的“父 Agent 等子 Agent 返回字符串”成熟得多：它有并发容量、父子边、恢复、取消、消息时序和内部权限继承。但它的身份仍是 Codex 的本地 thread/turn/path，任务结果也按 Codex 自己的协议和事件模型投影；没有公开的 A2A Agent Card、标准 Part/Artifact 或跨厂商 Agent 发现。

因此，Codex 的 `app-server` 是一个很好的产品级内部协议，却不是 A2A。它甚至说明了为什么项目不应急着把所有内部协议改写成 A2A：thread、turn、approval、workspace 和 agent path 这些运行时语义，往往比跨厂商互操作更贴近产品本身。

### 3. Pi：可嵌入 Runtime、RPC 与子进程扩展

Pi 的核心更像可组合的 Agent runtime。[Pi 的 extensions 文档](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) 允许扩展订阅 Agent/tool 生命周期、注册自定义工具、持久化状态和连接外部系统；其 RPC 则提供 stdin/stdout 上的 JSONL 控制面。

官方的 [subagent extension 示例](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts) 会为每个子 Agent 启动独立的 `pi` 子进程，支持 single、parallel、chain 等模式，并把结构化结果返回父进程。这个机制在工程上已经跨过了同一函数调用：有独立上下文、进程边界、并发和取消。

但它仍不是 A2A。Pi 的 RPC 主要服务于本地或受控宿主，session ID、子进程和 extension 名称是运行时身份；schema 中没有 A2A Agent Card、标准 Task/Artifact、跨网络发现或 A2A 认证语义。社区或用户当然可以写一个 A2A extension，把 Pi 包成 A2A server，但那属于外部 adapter，不应倒推为 Pi core 原生支持 A2A。

### 4. DeepSeek harness：最接近“适配层”，但使用的是自有协议

DeepSeek harness 的边界意识在四个项目中最明显。[Subagent subsystem 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md) 和 `packages/subagent` 展示了一个 provider-oriented 的 Agent 运行时：

- provider 可以注册不同的 Agent 后端；
- 一次性 subagent 有 `start`、结果和 stop reason；
- continuable child 有 `startContinuable`、`followup`、`interrupt`、`reportFrom` 和 parent/child lineage；
- Agent inbox 把消息分为 next-turn 与 next-step，并把接受顺序持久化；
- process-local activation 可以在需要时从 durable session cold resume。

在外部边界上，它还接入 ACP、Codex adapter、Claude Agent SDK 和自定义 stdio JSON-RPC。这里最容易发生概念混淆：[ACP 的官方架构](https://agentclientprotocol.com/get-started/architecture) 是 coding Agent 与编辑器/交互式客户端之间的协议，解决的是“客户端如何驱动 Agent”；它不是 Agent-to-Agent 的 A2A。

DeepSeek harness 因为已有 provider、session、inbox、continuation 和 adapter，很适合在上面加 A2A gateway。但当前公开源码和文档中没有看到 A2A Agent Card、标准 Part/Artifact 或 A2A Task API。因此结论是：它是最适合演化为 A2A 外部入口的内部 Agent runtime，而不是已经完整实现 A2A。

### 5. 四个项目放在一张表里

| 项目 | 最近似的身份 | 最近似的消息/任务机制 | 跨进程/跨网络能力 | 当前公开结论 |
| --- | --- | --- | --- | --- |
| Claude Code | team、teammate、session | mailbox、共享任务表、LocalAgentTask | 多实例/本地文件与进程协作 | Agent Teams，不是 A2A |
| Codex | thread、agent path、role | InterAgentCommunication、turn、wait/resume | app-server 与本地子线程 | 内部多 Agent 协议，不是 A2A |
| Pi | session、extension、子进程 | JSONL RPC、steer/follow-up、subagent result | 子进程与宿主扩展 | 可适配 A2A，core 未见原生 A2A |
| DeepSeek harness | provider、child/session、lineage | inbox、continuation、report | ACP、Codex/SDK/custom RPC | 适合加 gateway，当前不是 A2A |

共同点是：四个项目都已经实现了 A2A 的一部分“形状”——消息、任务、状态、取消、长任务或进程边界。差异在于它们把这些语义绑定在自己的运行时里，而 A2A 要求把它们提升成跨实现可互操作的外部契约。

## 五、Agent 项目是否需要完整实现 A2A

![从外部 Agent 到 A2A gateway，再到内部 runtime、模型、工具和数据的分层决策架构](/images/posts/agent-theme-09-a2a-interoperability/a2a-decision.webp)

### 1. 先问边界，不要先问协议

判断是否需要 A2A，最有效的不是检查“项目是不是 Agent”，而是问五个问题：

1. 调用方和被调用方是否属于不同进程、服务、团队、组织或厂商？
2. 调用方是否需要动态发现能力，而不是在配置里写死一个函数地址？
3. 任务是否可能在调用方断线后继续运行，并在稍后恢复或推送结果？
4. 输出是否不止一段文本，还包括文件、结构化数据、事件或多模态 Artifact？
5. 是否要把这个 Agent 作为第三方可集成的稳定产品边界？

如果五个问题大多回答“否”，完整 A2A 通常是额外成本；如果前四个里有多个回答“是”，A2A 的收益才开始超过自有 RPC 或 mailbox 的收益。

### 2. 四个落地层级

“完整实现 A2A”也不是只有“实现”和“不实现”两档，可以分成四级：

| 层级 | 做法 | 适用场景 | 是否宣称 A2A |
| --- | --- | --- | --- |
| 0. 内部 child task | 使用函数、队列、thread、mailbox 或 provider API | 同一进程、同一产品、固定拓扑 | 否 |
| 1. A2A-shaped adapter | 先采用稳定的内部 Message/Task/Artifact 形状，但不承诺协议兼容 | 同一团队的跨进程边界、未来可能开放 | 否，称内部契约 |
| 2. 单绑定 gateway | 实现 Agent Card、核心 Task 操作、鉴权、持久化、错误/取消，并选定 JSON-RPC 或 HTTP binding | 同一组织的多服务协作、少量外部消费者 | 可以称受限 A2A server |
| 3. 生产级 A2A | 遵循 A2A 1.0，处理版本协商、多个接口/传输、签名 Agent Card、租户、流式/推送、TCK/Inspector、可观测性和兼容性 | 公开平台、跨厂商生态、长期运营的 Agent marketplace | 是 |

层级 1 很有价值：它让内部运行时先拥有清晰的任务和结果模型，但不必为了“看起来标准”而提前实现远程发现、签名卡片和所有 binding。等真正出现外部消费者，再把 adapter 接到 A2A gateway，而不是重写 Agent core。

### 3. 完整实现的真正成本

最容易低估的不是 HTTP，而是生命周期和安全：

- **身份与授权**：谁允许调用这个 Agent？一个 Agent Card 是否可信？任务属于哪个租户和主体？
- **任务持久化**：调用方断线后，Task、状态、历史和 Artifact 是否仍然可查询？
- **幂等与重试**：网络重试会不会重复执行有副作用的任务？`send`、`cancel`、push 是否可重放？
- **取消与超时**：取消是停止模型回合、停止工具、停止整个任务，还是只停止通知？
- **不可信输入**：Agent Card、Message、Artifact 和 Task status 都可能携带 prompt injection 或恶意内容，不能直接拼回高权限 prompt。
- **能力差异**：不同 Agent 的输入模态、输出格式、认证方式和流式能力不一样，不能只靠一个 `text` 字段假装兼容。
- **运维**：需要 trace、审计、速率限制、配额、错误分类和版本兼容，而不仅是把请求转发出去。

这些机制都应对应具体事故：冒充 Agent、串租户、重复扣款、断线丢任务、恶意 Artifact 进入执行链、取消无效或无限重试。没有明确事故和现有机制的缺口，就不应该额外增加签名、哈希、门禁或复杂状态字段；协议实现不是安全感装饰品。

### 4. 推荐的架构位置

对大多数 Agent 项目，我更推荐下面的分层：

```text
                    外部生态 / 其他厂商 Agent
                                  │
                        A2A gateway / adapter
              Agent Card · auth · Task · Artifact · streaming
                                  │
                         内部 Agent runtime
       subagent · thread · mailbox · provider · session · MCP
                                  │
                     模型、工具、数据与本地副作用
```

A2A gateway 负责把外部协议映射成内部运行时已经理解的命令；内部 runtime 继续负责模型回合、权限、工具执行、队列和恢复。这样既能获得互操作性，又不必把本地每一个 steering message、approval event 或 UI 状态都暴露成公共协议。

## 六、最终判断

A2A 的今世，是一个从 Google 公开发布、进入 Linux Foundation 治理、已经拥有 1.0 协议线和多框架生态的 Agent 互操作标准；它的前身，则是 KQML/FIPA 那类“如何让独立 Agent 交换意图、发现能力、完成协商”的长期问题，而不是某一个直接继承的代码库。

当前已经实际使用 A2A 的项目，主要集中在官方 SDK、Google ADK、Microsoft Agent Framework、LangGraph/LangSmith，以及各种产品 client、gateway 和适配样例。生态正在从“宣传一个共同名词”走向“可以互相调用的端点”，但原生 server、产品级 client、pilot 和 sample 仍需分开判断。

Claude Code、Codex、Pi、DeepSeek harness 都已经有成熟的 A2A-like 内部机制：它们分别选择了 mailbox/team、thread tree、RPC/subprocess、provider/continuation。它们没有因此缺少 Agent 能力，恰恰说明内部协作协议可以根据运行时目标进行优化；也没有证据表明四者当前公开实现了完整 A2A。

所以，“Agent 项目是否需要完整实现 A2A”的答案是：

> 只有当 Agent 要成为跨边界、可发现、可异步委托、可被第三方稳定调用的协作者时，完整 A2A 才值得投入。对于同一产品内部的协作，先用更简单的内部契约；对于未来可能开放的边界，先做 A2A-shaped adapter；真正对外时，再把 A2A 放在 runtime 之上。

这不是降低目标，而是把协议放在它最有价值的地方：系统边界。

## 参考资料

- [A2A 官方规范](https://a2a-protocol.org/latest/specification/)
- [A2A 官方仓库与 SDK](https://github.com/a2aproject/A2A)
- [A2A v1.0.1 Release](https://github.com/a2aproject/A2A/releases/tag/v1.0.1)
- [Google：Announcing the Agent2Agent Protocol](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [Linux Foundation：Agent2Agent Protocol Project](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
- [Anthropic：Model Context Protocol](https://www.anthropic.com/news/model-context-protocol)
- [Google ADK：A2A Quickstart](https://adk.dev/a2a/quickstart-exposing/)
- [Microsoft Agent Framework：A2A](https://learn.microsoft.com/en-us/agent-framework/integrations/a2a)
- [LangSmith：A2A endpoint in Agent Server](https://docs.langchain.com/langsmith/server-a2a)
- [Claude Code：Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [OpenAI Codex：Multi-agent tools](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)
- [Pi：Extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [DeepSeek harness：Subagent subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)
- [Agent Client Protocol：Architecture](https://agentclientprotocol.com/get-started/architecture)
