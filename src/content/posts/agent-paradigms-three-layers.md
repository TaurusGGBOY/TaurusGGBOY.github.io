---
title: "从 ReAct 到 Supervisor：三层看懂 Agent 范式"
published: 2026-08-28
description: "区分 Agent 的运行范式、工作流编排和多 Agent 协作拓扑，梳理 ReAct、Plan-and-Execute、Reflexion、Supervisor、Handoff 等常见模式。"
tags: ["ai-agent", "multi-agent", "react", "plan-and-execute", "reflexion", "agent-architecture"]
category: "AI / Architecture"
draft: false
image: ""
---

如果你在中文互联网上搜索“Agent 范式”，大概率会看到 ReAct、Plan-and-Execute、Reflexion 和 Multi-Agent 被放在同一张表里。这样的分类方便入门，却留下了一个麻烦：前三个描述 Agent 怎样完成任务，最后一个描述系统里有多少个 Agent。它们回答的不是同一个问题。

继续搜索，还会遇到 Prompt Chaining、Routing、Parallelization、Supervisor、Group Chat、Swarm 等名字。有人称它们为工作流，有人称它们为架构，也有人统称多 Agent 模式。名词越来越多，边界反而越来越模糊。

一个更实用的办法，是把这些概念拆成三层：**运行范式、编排范式和协作范式**。这不是某篇论文规定的标准，而是对当前论文、中文技术文章和厂商文档的一次工程化整理。

## 第一层：一个 Agent 怎样运行

这一层关心的是 Agent 如何决定下一步。系统里可以只有一个 Agent，也可以把同一种运行方式装进多个 Agent。

### ReAct：走一步，看一步

ReAct 把推理与行动交替组织起来。Agent 根据当前信息形成下一步判断，调用搜索、代码执行或数据库等工具，再把工具结果作为新的观察，进入下一轮。

它常被概括为：

```text
思考 → 行动 → 观察 → 再思考
```

ReAct 适合路径无法提前确定的任务。比如调查一个软件故障时，Agent 可能先查日志，根据报错再查配置，随后运行测试。每一步都依赖上一步的新信息。

它的代价也来自这个循环。模型需要频繁参与决策；某一步判断跑偏，后面的工具调用就可能一起偏离。中文资料通常把 ReAct 视为 Agent 最基础、应用最广的运行方式。[人人都是产品经理对 ReAct 的介绍](https://www.woshipm.com/it/6105809.html)

### Plan-and-Execute：先画路线，再出发

Plan-and-Execute 把规划和执行分开。Planner 先把目标拆成若干步骤，Executor 再逐项完成；环境发生变化时，系统可以重新规划。

```text
制定计划 → 执行步骤 → 检查进度 → 必要时重规划
```

这种方式适合目标明确、步骤之间存在依赖的长任务，例如生成研究报告、迁移一套服务或完成跨文件代码修改。全局计划让进度更容易查看，也便于加入人工确认点。

Plan-and-Execute 不天然等于多 Agent。Planner 和 Executor 可以是同一个 Agent 的两个阶段，也可以拆成不同角色。腾讯云的产品文档采用了后一种实现：Planner Agent 生成计划，多个 Execute Agent 分别承担搜索、代码执行和网页处理。[腾讯云 Plan-and-Execute 协同文档](https://cloud.tencent.com/document/product/1759/122553)

### Reflexion：把失败变成下一次尝试的经验

Reflexion 在一次尝试结束后，引入评价和语言反馈。Agent 不只知道“失败了”，还会总结失败原因、形成可复用的经验，再用这些经验指导下一轮尝试。

```text
尝试 → 获得结果 → 评价 → 总结经验 → 再尝试
```

关键不在于让模型多想一遍，而在于反馈是否可靠。单元测试、执行错误、环境返回值和人工评价，都比模型凭空评判自己的答案更有用。

Reflexion 也不是天然的多 Agent。生成、评价和改进可以由同一个 Agent 分阶段完成；当评价者被拆成拥有独立提示词、上下文或权限的 Critic Agent 时，它才形成多 Agent 协作。

### ReWOO、LATS 与 LLMCompiler：三种扩展方向

中文技术文章还经常把以下几种方法列入 Agent 架构：

- **ReWOO** 先规划工具调用及其依赖关系，再执行工具，最后汇总结果。它试图减少 ReAct 每一步都让模型重新决策的开销。

- **LATS** 同时探索多条候选路径，通过评价与树搜索选择下一步。它适合答案空间较大、一次局部决策容易走进死胡同的任务。

- **LLMCompiler** 把复杂目标转换成任务图，让没有依赖关系的步骤并行运行，更接近编译器和调度器的思路。

一些中文文章因此把 ReAct、Plan-and-Execute、Reflexion、LATS 并列为四种主流架构；另一些文章则以 ReAct 为起点，将后续方法分成规划优化与复盘纠错两条路线。[Agent 架构全景](https://x7peeps.com/AI/03-Agent%E6%9E%B6%E6%9E%84%E4%B8%8E%E6%A1%86%E6%9E%B6%E7%94%9F%E6%80%81/AI-Agent%E6%9E%B6%E6%9E%84%E5%85%A8%E6%99%AFReActPlan-and-ExecuteReflexion%E5%92%8CLATS/index.html)

## 第二层：任务和模型调用怎样编排

运行范式把部分控制权交给模型，编排范式关注的是多个步骤如何连接。这里的节点可以是普通模型调用、工具，也可以是 Agent。

中文开发课程中常见五种编排模式：[李文周的 Agent 设计模式课程](https://liwenzhou.com/courses/ai-agent/05-agent-design-patterns/)

- **Prompt Chaining**：固定步骤串行执行，上一步输出成为下一步输入。适合翻译、改写、审核这类路径稳定的任务。

- **Routing**：先识别任务类型，再把请求交给相应的模型、工具或 Agent。客服分诊是最直观的例子。

- **Parallelization**：把相互独立的子任务并行运行，然后合并结果。它能降低总等待时间，也适合从多个角度分析同一材料。

- **Evaluator-Optimizer**：一个节点生成结果，另一个节点检查；未达到标准就带着反馈重新生成。它需要明确的终止条件，否则容易陷入昂贵的循环。

- **Orchestrator-Workers**：编排者在运行时决定怎样拆解任务，把子任务派发给 Worker，最后综合结果。与固定并行不同，子任务的数量和内容事先并不确定。

这些模式经常被误叫作多 Agent 模式，其实它们只规定控制流。三个不同提示词的模型调用可以组成 Evaluator-Optimizer，但未必需要三个拥有独立状态的 Agent。反过来，一个 Worker 内部也可以继续运行 ReAct。

## 第三层：多个 Agent 怎样协作

真正的多 Agent 架构，需要多个相对独立的角色。它们通常拥有不同职责、上下文、工具权限或安全边界，通过某种协议交换任务和结果。

当前中文产品文档和技术社区中，常见的协作方式有以下几类。

### Router：选对专家

控制器判断用户意图，把任务交给一个最合适的专业 Agent。各个 Agent 通常没有强依赖，适合售前、售后、物流等领域分流。

华为云 AgentArts 把“路由分发”列为基础多智能体范式：控制器根据意图选择子智能体。它还提供固定生命周期管控和分层嵌套控制，使一次路由可以扩展为多级组织。[华为云 AgentArts 多智能体执行范式](https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0105.html)

### Sequential 与 Handoff：顺序传递或动态交接

Sequential 像流水线：研究 Agent 收集材料，写作 Agent 生成初稿，审核 Agent 检查事实。顺序通常由代码预先确定。

Handoff 更像转接。当前 Agent 根据对话状态决定何时把控制权交给另一位专家。交接后通常只有一个 Agent 处于主导位置，适合客服升级、医疗分诊和专业咨询。

### Supervisor-Workers：一个负责人，多位执行者

Supervisor 维护目标、拆分任务、分配 Worker 并汇总结果。Worker 可以拥有不同模型和工具，例如搜索 Agent、代码 Agent、数据分析 Agent。

如果 Supervisor 下方还有次级 Supervisor，就形成 Hierarchical 结构。这种模式能承载更复杂的职责边界，但每增加一层，都需要解决上下文传递、失败恢复和成本观测问题。

### Fan-out / Fan-in：并行出发，集中汇总

编排器把同一个问题或多个独立子问题同时发送给多个 Agent，等它们完成后再聚合。聚合方式可以是投票、打分、规则选择或由模型综合。

这种模式适合多源检索、多视角评审和大文档分块处理。前提是子任务之间依赖较弱；如果 Worker 需要频繁等待彼此，并行带来的收益很快会被协调开销吃掉。

### Group Chat 与 Debate：让 Agent 互相看见

Group Chat 让多个 Agent 在共享会话中轮流发言，由管理器选择下一位发言者。它适合头脑风暴和反复修改，但容易产生对话循环，公共上下文也会持续膨胀。

Debate 为角色加入明确立场，例如提出方案、质疑证据、裁决结论。它可以暴露单一路径忽略的问题，却不能保证“争论越久，答案越真”。如果缺少外部证据和停止规则，多个 Agent 只是在放大彼此的文本判断。

### Peer-to-Peer 与 Swarm：弱中心化协作

在 Peer-to-Peer 或 Swarm 结构中，Agent 可以直接把任务转交给其他 Agent，不依赖一个始终存在的中央 Supervisor。这种结构灵活，但执行路径更难预测，权限传播、循环交接和状态追踪也更棘手。

微软 Azure 的中文架构文档采用了另一套产品化命名，将多 Agent 协调归纳为顺序、并发、群聊、接续和 Magentic。Magentic 由 Manager Agent 维护任务账本，持续调整计划和分工，用于没有预设解决路径的开放任务。[Microsoft Azure AI Agent 协调模式](https://learn.microsoft.com/zh-tw/azure/architecture/ai-ml/guide/ai-agent-design-patterns)

## 三层范式可以组合

现实系统很少只使用一种模式。一个软件开发系统可能采用下面的组合：

```text
Supervisor 使用 Plan-and-Execute 制定全局计划
    ├── 搜索 Worker 使用 ReAct 调用搜索和网页工具
    ├── 编码 Worker 使用 ReAct 修改代码并运行测试
    └── 评审 Worker 提供反馈，失败步骤通过 Reflexion 再次尝试
```

这里同时存在三种描述：

- Plan-and-Execute 和 ReAct 描述各个角色怎样运行；
- 任务拆解、并行执行和评价循环描述工作流怎样编排；
- Supervisor-Workers 描述多个 Agent 怎样组织。

把层级分开之后，“某产品用了哪种范式”也就不再需要一个单选答案。同一个产品完全可以在不同层采用多种模式。

## 什么时候值得使用多 Agent

多 Agent 的价值主要来自职责隔离、独立上下文、并行处理和不同权限边界。它并不会自动提升准确率。每增加一个 Agent，系统都会增加模型调用、上下文传递、失败路径和调试成本。

可以按下面的顺序判断：

1. 路径固定、规则清楚，优先使用普通工作流。
2. 路径需要根据环境动态变化，但工具和权限相同，先尝试单 Agent 加 ReAct 或 Plan-and-Execute。
3. 任务可以独立并行，再考虑 Fan-out / Fan-in。
4. 子任务需要不同专业提示词、上下文、工具或权限边界，再拆成多个 Agent。
5. 需要多方质疑时使用 Debate 或独立评审，但评价标准最好来自测试、数据和人工规则。

华为云文档直接提示，多智能体每轮会多次调用模型，Token 消耗高于单工作流；微软也建议，如果单 Agent 能可靠完成任务，就从单 Agent 开始。两家厂商的分类名称不同，对复杂度的判断却相当一致。[华为云 AgentArts 文档](https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0105.html) [Microsoft Azure 架构建议](https://learn.microsoft.com/zh-tw/azure/architecture/ai-ml/guide/ai-agent-design-patterns)

## 结语

中文互联网所说的“Agent 范式”，实际上混合了运行循环、工作流控制和多 Agent 组织三套语言。ReAct、Plan-and-Execute、Reflexion 属于运行层；Prompt Chaining、Routing、Parallelization 属于编排层；Supervisor、Handoff、Group Chat、Swarm 才是严格意义上的多 Agent 协作结构。

这三层没有互斥关系。它们更像一套组合式设计语言：先选择每个 Agent 怎样行动，再安排任务怎样流动，最后决定是否真的需要多个 Agent。这样理解，比背下一张不断变长的“范式清单”更接近实际系统。
