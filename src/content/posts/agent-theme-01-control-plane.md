---
title: "Agent主题对比01｜控制平面与主循环"
published: 2026-08-12T10:08:00+08:00
updated: 2026-08-12
description: "比较 Claude Code、Codex CLI 与 Pi 的控制平面、harness 和主循环，覆盖 00-a 到 06 的源码证据。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-01-control-plane/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-01-control-plane"
series: "agent-theme-comparison"
order: 1
difficulty: "advanced"
time: "45 min"
prerequisites:
  - "读过 Claude Code 源码解读 00 导读"
  - "知道模型、工具调用和上下文窗口分别是什么"
topics:
  - "agent harness"
  - "agent loop"
  - "Claude Code"
  - "Codex CLI"
  - "Pi"
source_modules:
  - "restored-src/src/entrypoints/cli.tsx"
  - "restored-src/src/query.ts"
  - "restored-src/src/main.tsx"
  - "codex-rs/core/src"
  - "packages/agent/src/agent-loop.ts"
status: "verified"
verified_at: "2026-08-12"
---


> 这不是“哪个 Agent 更强”的排行榜，而是把三个系统放到同一张解剖台上：谁负责把模型的选择变成动作，谁负责把结果放回下一轮上下文，谁在最后决定这一轮可以怎样结束。

## 先给结论：Agent 的差异，首先不在模型名

很多对比文章从“支持哪些模型”“能不能改代码”开始，最后得到一个功能勾选表。这种写法适合快速选工具，却很难解释一个系统为什么在真实项目里稳定，另一个系统为什么会在取消、恢复、压缩或权限边界上出问题。

我先收集了 10 篇外部材料，再回到固定源码快照核对结论。材料里有产品总览、工程博客、源码级论文、平台论文和逐项功能矩阵；它们的共同点不是结论一致，而是写法各有分工：总览文章先定义 harness，源码论文追控制流，安全文章追边界，实验论文追可测指标，功能矩阵负责让读者快速定位差异。这个系列沿用它们最有用的部分，但把“观点”和“源码事实”分开。

本文只处理第一组问题：控制平面是什么、一次 turn 怎样运行、启动怎样把环境装配出来，以及 QueryEngine 和 agent loop 的边界在哪里。对应 Claude Code 源码系列的 00-a、00、01、02、03、04、05、06，共 8 个独立 section。

![Agent 控制平面与主循环](/images/posts/agent-theme-01-control-plane/agent-theme-01-control-plane-handdrawn.png)

## 证据边界：三个固定快照，十篇材料只做参照

Claude Code 以本仓库 `restored-src/` 的源码快照为准；Codex CLI 以 `/Users/gaoguobin/project/codex-cli` 中 `.source-commit=4ef836f883c38ba6d39e6920f335ce6452b7de33` 标记的快照为准；Pi 以 `/Users/gaoguobin/project/pi-mono` 中 `.source-commit=534bcbffb7e1e7551d9ee3572dfeb278e203e493` 标记的快照为准。外部文章帮助我们提出比较维度，不用来替代本地源码证据。

外部材料大致分成四种写法。第一种是“概念先行”：先说明 coding agent 和 harness 的区别，再拆工具、上下文、执行环境。第二种是“请求展开”：从一个简化 while-loop 开始，逐层加上 API payload、SSE、tool result 和 compaction。第三种是“边界问题”：从审批疲劳、prompt injection 或执行风险切入，再落到沙箱和代理。第四种是“实验/矩阵”：先给评估维度和数据，再用表格或消融实验支撑判断。我们后面的 section 会明确标记：哪一句是源码可以直接确认的，哪一句只是设计上的比较结论。

## 十篇外部材料：内容、写法与使用边界

下面不是“参考链接堆砌”，而是这次研究真正借用的写作样本。每篇材料承担的任务不同：有的负责定义比较对象，有的负责展示源码路径，有的负责提供评估维度。它们的评分、体验和案例数据不会被直接移植成 Claude Code、Codex 或 Pi 的总排名。

| 材料 | 它主要讲什么 | 它怎么写 | 本系列怎样借用、边界在哪里 |
|---|---|---|---|
| [Pawel Jozefiak：AI coding harnesses](https://thoughts.jock.pl/p/ai-coding-harness-agents-2026) | 比较 Claude Code、Codex CLI、Aider、OpenCode、Pi、Cursor，先区分 pair programmer 与 autonomous orchestrator。 | 先定义最小循环，再按使用场景和人在不在场拆产品，最后给选择建议。 | 借用“监督式开发 / 后台编排”的坐标；价格、体验和 benchmark 是作者当时的观察，不能当作固定事实。 |
| [Mason James：The harness matters](https://www.masonjames.com/blog/the-harness-matters-codex-claude-code-pi-amp-hermes-compared/) | 用 verification、context/memory、safety、workflow、delegation 等九维度比较多个 harness。 | 先声明没有控制变量的代码质量实验，再公开权重、评分规则和并列结论。 | 借用“先写评分边界”的纪律；九维分数不是本系列的测量结果。 |
| [disler：Pi vs Claude Code](https://github.com/disler/pi-vs-claude-code/blob/main/COMPARISON.md) | 用逐行矩阵盘点源码开放性、默认工具、权限、记忆、子 Agent、团队协作和 provider。 | 高密度表格配少量 winner/差异结论，读者可以快速横向扫描。 | 借用“built-in / extension / 外部宿主”三分法；矩阵中的版本、数量和 winner 仍需回到源码核对。 |
| [What makes a harness a harness?](https://arxiv.org/abs/2606.10106) | 定义 harness 的必要条件、充分条件和 inclusion/exclusion test，并用多个系统验证分类。 | 先定义对象，再给分类测试，最后讨论设计张力；明确不做排行榜。 | 借用“先固定比较单位”；本文比较控制平面，不把模型、IDE 或单个工具误当成完整 harness。 |
| [Harness-Native Software Engineering](https://research.chaitanya.science/papers/harness-native-software-engineering.pdf) | 把 control plane 拆成 context ingress、action mediation、execution、state、verification、recovery、delegation、governance。 | 定义八个槽位，再放入系统矩阵和威胁映射，最后提出可验证命题。 | 借用八类控制点组织 50 个 section；威胁映射是分析框架，不是三个固定快照的运行测试。 |
| [Dive into Claude Code](https://arxiv.org/abs/2604.14228) | 从公开 TypeScript 源码归纳设计原则，追踪 while-loop、权限、compaction、扩展、subagent 和 session。 | 先提出反复出现的设计问题，再把模块和行为映射回问题，保留推断边界。 | 借用“问题 → 控制流 → 设计取舍”的主线；本文的 Claude Code 事实仍以本仓库快照为准。 |
| [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/) | 解释 Codex core、长生命周期 App Server、双向 JSON-RPC，以及 thread/turn/item 如何服务多个宿主。 | 从 CLI 到 IDE/Web 的演化动机切入，再定义稳定原语和客户端形态。 | 借用“事件与宿主协议”视角；协议文章不能单独证明 sandbox 或 approval 的安全效果。 |
| [Harness engineering](https://openai.com/index/harness-engineering/) | 说明日志、UI、指标、worktree、lint 和结构测试怎样让 agent 能读取环境并验证结果。 | 采用“约束现场 → 环境改造 → 可观察反馈 → 不变量”的工程案例叙事。 | 借用“把反馈面暴露给 Agent”；PR 数量、效率和团队案例不可外推为普遍生产结论。 |
| [SWE-agent 的 Agent-Computer Interface](https://swe-agent.com/0.7/background/aci/) | 设计面向模型的 viewer、编辑器、搜索和 lint 反馈，而不是把原始 shell 原样交给模型。 | 先给总判断，再列少数会改变模型行为的接口设计点，细节回指论文。 | 借用“输出格式也是控制面”；SWE-agent 的 ACI 结果不能直接等同于 Claude Code、Codex 或 Pi 的工具实现。 |
| [OpenHands CodeActAgent](https://docs.openhands.dev/openhands/usage/agents) | 把动作空间压成对话/确认或代码执行两类动作，展示统一动作空间的可解释性。 | 用一个抽象、两类动作和一个 demo 迅速建立心智模型。 | 借用“动作空间复杂度”的比较角度；该页面不覆盖完整权限、恢复和持久化，所以不据此评价整体安全。 |

这十篇材料合在一起，给出的不是一个冠军，而是一套写作顺序：先定义“比什么”，再展开共同 loop，然后逐个追踪 action、state、verification 和 recovery，最后才谈适用场景。后面的每个 section 都沿用这个顺序，并把“源码事实 / 官方协议事实 / 设计推断 / 外部体验”分开标注。

## Section 00-a｜一篇逆向论文怎样拆开生产级 Agent

### Claude Code：先把研究方法变成系统地图

00-a 不是普通的产品介绍，它先讨论公开 source map、证据分层和五个价值，再把价值落实为权限、上下文、扩展、subagent 和 resume 等问题。这个顺序很重要：它告诉读者不要从函数名直接跳到“设计意图”，而是先问证据来自哪里、能确认到哪一层。

本地源码把这个方法落到了可追踪的控制流：`restored-src/src/query.ts` 的 `queryLoop` 是主要循环；工具调用会进入权限判断和执行路径；上下文接近上限时会进入压缩；会话恢复后还要重新走本次运行的环境和权限装配。也就是说，论文里谈的 harness，不是某个单独的类，而是一组跨模块的控制关系。

### Codex CLI：更像“请求协议的剖面图”

Codex 的源码和官方文章把 harness 讲得更协议化。`core` 侧把 thread、turn、item 和 tool call 组织成可观察的事件；请求的一次推进会经历模型输出、工具执行、结果回填和下一次请求。外部写作中常见的优点是把 JSON payload 或 SSE 事件展示出来，读者能看见抽象概念如何落成协议。

这个角度的代价也很明显：如果只看请求对象，容易漏掉宿主进程、权限决策和 sandbox transform。Codex 的控制平面不等于 Responses API；API 只是模型交互面，真正把动作限制在工作区和网络策略内的部分在本地运行时。

### Pi：用最小内核把变量压到最低

Pi 的写法和实现都更克制。`packages/agent/src/agent-loop.ts` 里，`agentLoop` 负责准备上下文、请求模型、收集 tool calls、执行工具并继续；`executeToolCalls` 则把多个工具调用按顺序推进。它把“一个最小可工作的 harness”展示得很清楚，因此很适合用来和大型系统做差分。

但最小并不自动等于完整。Pi 把会话树、压缩、分支摘要、扩展和工具注册放在上层 `AgentSession` / coding-agent runtime；README 也明确说明它不内置 sandbox。比较时必须把“核心 agent loop”与“产品运行时”分开，否则会把未提供的安全边界误读成 loop 的缺陷。

### 对比结论

三者都可以画成“模型—工具—结果—模型”的环，但论文式分析真正有价值的地方在环外：

- Claude Code 把权限、hook、压缩、恢复和扩展都拉回 query 控制流，强调生产边界。
- Codex 把 thread/turn/item 作为稳定的宿主协议，强调多客户端和事件可观察性。
- Pi 把最小 loop 保持得很薄，把 session、扩展和 coding-agent 能力放在可组合的上层，强调可改造性。

这不是功能数量的差异，而是控制平面“中心化、协议化、可组合化”的不同取舍。

### 验证动作

在 Claude Code 源码目录执行一次 `rg -n "queryLoop|tool_use|compact|permission" restored-src/src/query.ts restored-src/src`，再分别在 Codex 的 `core` 和 Pi 的 `agent-loop.ts` 查找 turn/tool loop。若一个结论无法落到这些控制点，就把它标成假设，而不是源码事实。

## Section 00｜从源码泄露开始，读懂 Claude Code

### Claude Code：导读本身也是 harness 教程

00 导读把 Claude Code 放到“模型负责选择，harness 负责把选择变成动作”的框架中，并把事故时间线、证据分层和阅读路线放在正文前面。它还提醒读者：源码泄露可以帮助理解实现，但不能凭一个快照推断所有线上行为。这个证据纪律是后面对比 Codex 和 Pi 时必须保留的前提。

从实现看，Claude Code 的入口不是直接调用模型。CLI 会先分流交互式、print、SDK 或 bridge 等宿主模式，再完成配置、信任、工具池、会话和扩展的装配，最后才把消息交给 QueryEngine。启动阶段做的这些工作，决定了“模型能看到什么、能调用什么、调用后谁来拦截”。

### Codex CLI：系统边界落在 app-server 与 host protocol

Codex 的官方 harness 设计把核心拆成 CLI/UI、App Server 和更底层的执行组件。App Server 用双向 JSON-RPC 承载 thread、turn、item；客户端可以是 CLI，也可以是 IDE 或其他宿主。这样，控制平面不再只属于一个终端界面，而是通过协议对多个前端保持一致。

这个设计特别适合解释“同一个 agent 如何被不同产品调用”。但读者不能因此把 JSON-RPC 当作安全边界：真正的文件系统和网络限制仍由 sandbox、approval 和宿主运行时决定。

### Pi：核心库和 coding-agent 应用分层

Pi 的仓库把 agent core、coding-agent、tui 和扩展运行时拆得很清楚。核心 loop 不知道“项目设置”“会话树”或“通知 UI”的全部细节，coding-agent 再把这些能力组合起来。它的边界更接近一个可嵌入库：你可以替换 provider、注册工具、加载扩展，也可以换掉交互层。

这让 Pi 很适合验证一个问题：如果只保留模型请求和工具执行，系统能否运行？答案是能；但要成为完整 coding agent，还需要把信任、会话、压缩、工作区和体验层逐一补回来。

### 对比结论

Claude Code 的导读最强调“事故和证据如何反推架构”；Codex 最强调“宿主协议如何复用控制平面”；Pi 最强调“最小内核如何被上层组合”。对实际排错而言，第一种写法帮助找边界，第二种帮助找进程/协议，第三种帮助判断一个能力应该放在 core 还是 application。

### 验证动作

给三个系统各画一条边界：模型请求前、工具执行前、会话落盘后分别由谁负责。画不出负责者的区域，就是最容易出现“表面支持、实际没有闭环”的区域。

## Section 01｜从系统地图开始，认识整体架构

### Claude Code：四区地图对应真实调用链

01 把系统拆成 Query Core、Host/UI、Context & Model、Execution & State，再把 Extensions 作为横向扩展面。这个地图不是目录树复述：`query.ts` 把宿主输入转成内部消息，context/model 决定系统提示和模型请求，execution/state 处理工具、权限、会话和运行状态，extensions 则通过 MCP、plugin、skill、hook 等入口增加能力。

地图的价值在于定位失败。例如恢复会话后的 prompt cache 问题属于 Context 与 Query Core 的交界；权限绕过属于 Execution 边界；压缩重试失控则属于 Query Core 的状态机。生产系统的故障往往不是某个函数“错了”，而是两个区域对状态归属理解不一致。

### Codex CLI：四区可以换成 thread、host、sandbox、model

Codex 的对应地图更接近：App Server/thread state、client/host protocol、model request、sandboxed execution。thread 和 turn 是外部可观察的业务状态；client 负责展示和发起请求；模型产生 item/tool call；执行器在 sandbox 和 approval 策略下运行命令。

它的一个强项是 item 级事件：reasoning、message、tool call、tool result 可以成为统一的观测单位。一个需要警惕的点是，事件模型能说明“发生了什么”，但不能单独说明“为什么允许发生”；后者要追 approval 与 sandbox profile。

### Pi：模块地图更薄，组合关系更直接

Pi 可以对应为 agent core、coding-agent session、tools/extensions、TUI/host。`registerTool` 把工具描述和执行函数加入 runtime，`AgentSession` 把消息树、模型设置和 compaction 连接起来，TUI 只消费事件和状态。没有强制的 sandbox 层，也没有像 Codex App Server 那样的统一跨客户端协议。

这种结构让扩展成本低，但治理责任更多落在宿主：工具是不是安全、扩展是不是可信、子进程能访问哪些文件，不是 Pi core 自动替你完成的。

### 对比结论

Claude Code 的地图适合做“故障归因”；Codex 的地图适合做“事件和宿主解耦”；Pi 的地图适合做“内核复用和能力拼装”。如果要设计自己的 agent，最先应确定的不是类名，而是四个问题：谁持有 turn 状态，谁生成模型输入，谁授权副作用，谁保存可恢复历史。

### 验证动作

拿一个简单任务“读取文件并修改一行”，分别标出三个系统中四个动作的归属：输入装配、模型调用、工具授权、结果持久化。任何动作被两个模块同时“顺便负责”，都值得继续查。

## Section 02｜一次请求如何走完 Claude Code

### Claude Code：入口可以变，QueryEngine 不变

02 的主线是从 `cli.tsx` / `main.tsx` 的 fast-path 和完整入口，经过 REPL、SDK 或 print 模式，最后汇入同一个 QueryEngine。`submitMessage` 负责把用户输入、附件、系统初始化和运行参数装配起来；`queryLoop` 再把模型输出中的 tool use 编排成执行、回填和下一轮请求。

这条链把“入口差异”和“执行内核”分开了。交互式入口需要状态展示和中断，headless 入口需要结构化输出，但模型看到的消息配对、工具结果和停止条件不能因为 UI 不同而各自实现一套。

### Codex CLI：turn 是一次可观察的请求单元

Codex 的 turn 也不是一次 HTTP 请求。一次 turn 可能含有多次模型推理和工具调用；每次工具结果都会作为新的 item 进入后续请求，直到模型输出最终消息或控制逻辑结束。SSE 事件让客户端可以实时看到这个过程，App Server 则把它包装成更稳定的 thread/turn 语义。

与 Claude Code 的共同点是“结果回填后继续”，不同点是 Codex 更明确地把中间状态公开给宿主协议。对 IDE 来说，这意味着可以在不解析终端文本的情况下渲染工具调用、审批和最终结果。

### Pi：agentLoop 是清楚但不臃肿的请求管线

Pi 的 `agentLoop` 先把系统提示、历史消息和工具定义交给 provider，再处理流式 assistant message。若有 tool calls，就执行并追加 tool result；若没有，就结束本轮。coding-agent 层再把这个 loop 接到 session JSONL、分支和 UI。

Pi 的优势是阅读成本低：你能很快看见一次 turn 的必要步骤。它没有替你补齐每个生产边界，所以取消、失败恢复、权限确认和持久化策略需要看上层代码，不能只读 core loop。

### 对比结论

三者都不是“请求—响应”脚本，而是“请求—工具—结果—请求”的可暂停流程。Claude Code 把大量生产策略内嵌到 QueryEngine；Codex 通过 turn/item 协议把过程暴露给客户端；Pi 把最小流程保留为库能力，再让 coding-agent 决定产品策略。

### 验证动作

不要只打印最终答案。让任务调用一次工具，在日志中确认至少出现：assistant tool call、工具执行、tool result、下一次模型输入、终止事件。这五个节点缺一个，系统就可能只是“看起来像 agent”。

## Section 03｜如何完成引导与初始化

### Claude Code：启动是能力和边界的装配期

03 展示了 Claude Code 在第一次提问前做的工作：CLI 分流、并发预取、配置迁移、初始化、当前项目 setup、工具池、信任、会话恢复和 REPL/print 出口。`main()` 不只是把参数交给函数，而是给本次运行建立一份带标签、可观测、可恢复的环境。

这里有一个很容易被忽略的设计：启动阶段确定的 cwd、配置、模型、权限模式、MCP/插件和 memory，会共同影响后续系统提示和可用工具。因此启动耗时不只是 UX 指标，也是在测量控制平面复杂度。

### Codex CLI：bootstrap 主要围绕 workspace 和 instructions

Codex 启动时要解析工作目录、sandbox/approval 选项、模型和 provider 配置，并收集目录层级的 `AGENTS.md` 等 instructions。官方 harness 文章将这些说明视为初始输入的一部分；它们不是工具调用之后才临时读取的注释，而是模型作出第一步决定前就要进入上下文的约束。

Codex 的 bootstrap 还需要让不同客户端共享同一套 thread/turn 能力。这样做的关键不是把所有初始化塞进 CLI，而是由 app-server/runtime 提供稳定的环境描述和事件协议。

### Pi：启动让 provider、settings、session 和 extensions 汇合

Pi 的 coding-agent 启动会读取项目/全局设置，确定 provider/model，加载资源文件和扩展，创建 session，再启动 TUI 或 headless 模式。项目 trust 会影响资源加载；扩展如果未被信任，不应因为它出现在目录里就自动执行。

它的初始化更像“可组合工作台”：你可以换模型和主题，也可以通过扩展增加工具。但由于没有统一 sandbox，启动阶段的信任配置和运行用户权限尤其重要。

### 对比结论

Claude Code 把启动做成性能可观测的多阶段流水线；Codex 把启动重点放在 workspace/instructions 与多宿主协议；Pi 把启动重点放在 provider、session 和扩展组合。三者共同说明：agent 的第一轮质量，在模型收到第一条用户消息之前就已经被决定了一半。

### 验证动作

冷启动时记录 cwd、配置来源、加载的 instruction、工具数量、扩展数量和 session 路径。不要只记录总耗时；只有拆开这些输入，才能解释“同一句 prompt 为什么在两个项目里行为不同”。

## Section 04｜一套内核如何支持多种入口

### Claude Code：REPL、print、SDK、bridge 共享契约

04 说明 main 先识别宿主，再决定业务出口。REPL 持有交互状态，print 和 Agent SDK 走 headless 管道，MCP server 复用工具执行契约，bridge/direct-connect 则把进程边界显式化。不同入口的差异集中在输入输出和权限控制，不应复制一套新的 agent loop。

这个设计让“同一任务三种出口”的行为可以比较：交互式模式显示过程，print 模式输出结构化结果，SDK 模式把事件交给调用者。只要共用 QueryEngine，工具结果和停止条件就不会因为展示层不同而漂移。

### Codex CLI：客户端是控制平面的第一等公民

Codex 的 App Server/JSON-RPC 设计天然支持 CLI、IDE 和其他客户端。客户端订阅 thread/turn/item 事件，向宿主请求审批或发送输入；执行和状态不必绑定到终端。这个协议化入口比单一 CLI 更适合嵌入开发工具，但也要求协议向后兼容、事件顺序和背压明确。

### Pi：TUI 与 headless 都围绕同一个事件流

Pi 的 coding-agent 把 TUI、RPC/脚本入口和 agent core 分层。TUI 消费 agent events 并展示流式文本、工具调用和状态；headless 调用可以直接使用同一套 session/agent 能力。扩展事件也能穿过这层，因此 UI 不需要理解每个扩展的内部实现。

不过 Pi 的入口统一主要是库层约定，而不是强制的远程协议或系统级安全边界。部署到不可信环境时，需要宿主另外提供隔离和授权。

### 对比结论

入口复用有三种成熟形态：Claude Code 是内核契约复用，Codex 是 app-server 协议复用，Pi 是事件和库组合复用。选择哪一种，取决于你是否需要多个独立客户端、远程进程和长期兼容，而不只是是否支持 `--print`。

### 验证动作

用同一任务分别走交互式和 headless 入口，比较工具调用序列、权限事件、最终结果和会话落盘。若只有输出格式不同，说明边界健康；若决策顺序也不同，说明入口层偷偷复制了控制逻辑。

## Section 05｜如何编排会话与无头调用

### Claude Code：QueryEngine 是会话状态的门面

05 把 QueryEngine 的职责拆开：构造时保存完整会话状态；`submitMessage` 先处理输入并判断是否请求模型；system init 向宿主和模型声明能力；内部消息映射为 SDK 事件；`result` 给出结构化终止报告；interrupt、setModel 和读取接口负责生命周期控制。

这说明 QueryEngine 不是“调用一次 API 的 helper”。它要知道当前 session、模型、工具、权限、消息和终止原因，还要让 REPL 与 SDK 看到一致的事件。无头调用只是没有 TUI，不是没有状态机。

### Codex CLI：Thread/Turn/Item 将状态外显

Codex 把 QueryEngine 类似的职责拆成 thread、turn、item 和 app-server 管理。thread 表示可继续的会话，turn 表示一次用户驱动的推进，item 表示消息、推理、工具调用和结果等事件。这个划分让客户端可以精确订阅和恢复，也让并发队列、取消和 backpressure 有了明确的承载点。

它和 Claude Code 的差异不是“有无会话”，而是状态是否以协议对象公开给多个消费者。公开状态会带来更强的可组合性，也带来 schema 演进和客户端兼容成本。

### Pi：AgentSession 把 loop 变成可恢复会话

Pi 的核心 loop 可以无状态地运行，但 `AgentSession` 会把模型、消息树、settings、compaction 和 branch 操作组合成可继续的 coding session。session 采用 JSONL/tree 记录事件和父子关系，切换分支不必复制整份历史。

对于一次性脚本，直接调用 agent loop 就够了；对于交互式开发，必须使用 session 层，否则 `/resume`、`/tree`、压缩和 fork 都没有可靠的状态来源。

### 对比结论

Claude Code 把会话编排集中在 QueryEngine；Codex 把它拆成协议可见的 thread/turn/item；Pi 把它拆成 core loop + AgentSession。三种方案都在回答同一个问题：如何让“这一次模型调用”成为可以暂停、继续、观察和解释的业务过程。

### 验证动作

检查无头调用是否仍然能拿到结构化的 result、tool events、usage 和中断原因；再检查进程重启后能否从持久化记录恢复。如果只能恢复文字而不能恢复控制状态，所谓 session 只是聊天记录。

## Section 06｜代理循环如何持续推进

### Claude Code：`queryLoop` 是真正的生产级状态机

06 的核心不是“有一个 while(true)”，而是这个循环在每一轮如何准备 state、调用模型、收集 `tool_use`、执行并回填 `tool_result`，再根据 hook、预算、取消、错误和停止条件决定下一步。源码中 `query()` 更像外壳，状态真正留在 `queryLoop()`。

尤其要注意四层预算检查：请求前后的 token/context 约束、工具和 turn 预算、模型或服务错误的重试，以及最终 stop hook/结果收口。取消时还要补齐消息配对，错误恢复也需要把内部异常转成调用者可理解的结果。生产 harness 的复杂度，正是这些“模型没说出来但系统必须处理”的情况。

### Codex CLI：循环被拆成 turn 事件和执行器

Codex 的 agent loop 同样是模型—工具—结果的闭环，但它更倾向于让每一步成为 item/event，再由 runtime 负责调度和 sandbox transform。统一执行器先根据安全策略选择 sandbox，再变换命令、启动 PTY，收集输出后把结果交回 turn。这样的结构便于多个客户端观察中间状态，也便于把本地执行和协议层分开。

Codex 的 sandbox preference 有 `Auto`、`Require`、`Forbid` 等取值；可用 sandbox 类型包括 macOS Seatbelt、Linux Seccomp 和 Windows Restricted Token 等，具体可用项取决于平台和编译能力。这个参数不是模型 prompt，而是循环进入副作用阶段前的控制分支。

### Pi：最小 loop 让“必要步骤”一眼可见

Pi 的 `agentLoop` 和 `executeToolCalls` 让主路径很短：请求模型，发现工具调用，执行工具，追加结果，继续或结束。它也支持流式事件和多工具调用，但不会在 core 中强行塞入 Claude Code 那样的全部生产政策。

因此 Pi 很适合做实验：先替换工具执行器、provider 或 session，再观察 loop 的基本不变量。但要达到生产级，需要宿主明确补上审批、资源隔离、重试、预算、日志和恢复；不补，就不能把“代码短”误写成“系统简单”。

### 对比结论：三条循环，三种工程哲学

Claude Code 把异常路径和治理策略压进主循环，换取边界完整但阅读成本更高；Codex 把循环拆成 turn/item、host protocol 与 sandbox executor，换取多宿主和可观察性；Pi 保持 loop 最小，把复杂度交给上层，换取可嵌入性。

一个有用的评价办法是数不变量，而不是数功能：tool call 必须有匹配 result；取消后不能留下半条消息；恢复不能绕过权限；压缩后必须还能继续；执行输出必须回到下一次模型输入。谁把这些不变量写进控制平面，谁才真正拥有可控的 agent。

### 验证动作

做四个故障注入：工具失败、用户取消、上下文接近上限、模型输出没有 tool call。记录每个系统是否有明确终止 reason、是否能继续、是否留下可恢复 session，以及是否在再次执行前重新确认权限。

## 把十篇外部文章的写法变成一套阅读方法

这 10 篇材料没有告诉我们“唯一正确的 Agent 架构”，却提供了可以复用的写作方法：

1. 先定义对象。把 coding model、tool、harness、host、sandbox 分开，否则后面的比较会把不同层级混成一张表。
2. 再展开一条路径。用一次 turn 解释消息、工具、结果、状态和停止条件，比堆概念更容易发现遗漏。
3. 对边界单独取证。权限、网络、文件系统、凭证和恢复不能从“支持工具”推断出来。
4. 最后才做评分或结论。实验论文可以报告 benchmark，产品文章可以报告体验，但不能把一项结果外推成所有任务上的总排名。

这也是本系列的固定格式：每个 Claude Code 章节都有对应的 Codex、Pi、对比结论和验证动作；后文不会再把 50 个章节压成一张“大而全”的表。

## 本主题覆盖清单

本篇覆盖 Claude Code 源码解读系列的 8 个章节：00-a、00、01、02、03、04、05、06。整个新系列共 8 篇主题文章、50 个独立 comparison sections；每篇旧 Claude Code 文章只出现一次。剩余主题依次处理消息与副作用、上下文与恢复、扩展与委派、宿主与结构化 IO、配置与运维、记忆与后台智能、体验与反馈。

## 参考材料：先读它们怎样写，再读它们写了什么

- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)：官方总览，先定义 agentic harness，再按 tools、context、execution、session 展开。
- [Beyond permission prompts: making Claude Code more secure and autonomous](https://www.anthropic.com/engineering/claude-code-sandboxing)：从审批疲劳和 prompt injection 切入，再解释文件系统、网络和凭证代理边界。
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)：从 while-loop 展开到 Responses API、SSE、turn 和 compaction。
- [The harness matters: Codex, Claude Code, Pi & Hermes compared](https://www.masonjames.com/blog/the-harness-matters-codex-claude-code-pi-amp-hermes-compared/)：按九个维度加权比较，但明确不是代码质量排行榜。
- [What makes a harness a harness?](https://arxiv.org/abs/2606.10106)：用必要条件和充分条件区分不同系统，避免把“能调用工具”直接等同于 harness。
- [Harness-native software engineering](https://research.chaitanya.science/papers/harness-native-software-engineering.pdf)：把控制平面拆成 context、action、execution、state、verification、recovery、governance 等能力。
- [Dive into Claude Code](https://arxiv.org/abs/2604.14228)：源码级追踪 while-loop、权限、压缩、扩展、subagent 和 session。
- [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)：从 core、App Server、JSON-RPC、thread/turn/item 解释多宿主架构。
- [Harness engineering](https://openai.com/index/harness-engineering/)：强调环境可读性、日志、UI、指标、worktree 和结构化验证。
- [SWE-agent 的 Agent-Computer Interface](https://arxiv.org/html/2405.15793)：用实验说明面向模型设计的搜索、查看、编辑和 lint 接口为何重要。

## 下一篇

控制平面回答了“谁在推进循环”。下一篇会继续追问：模型究竟通过什么消息和工具契约改变世界，工具副作用怎样经过权限、沙箱和回滚，三套系统又怎样把执行结果重新变成上下文。
