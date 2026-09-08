---
title: "多 Agent 怎样协作：图解 Anthropic 的 Research 系统"
published: 2026-08-28
updated: 2026-09-08
description: "以 Anthropic 的 How we built our multi-agent research system 为主线，图解主 Agent、子 Agent、检索循环与引用整理，并对照常见多 Agent 协作方式。"
tags: ["ai-agent", "multi-agent", "anthropic", "research", "agent-architecture"]
category: "AI / Architecture"
draft: false
image: ""
---

假设你要调查几款知识库产品：哪些支持自托管，权限能细到什么程度，迁移时能导出哪些数据。把任务交给一个 Agent，它需要在不同产品的文档间来回切换；交给几个 Agent，又会多出一个问题：每个人查到的东西，最后怎样拼成一份口径一致的答案？

Anthropic 在 2025 年 6 月 13 日发布的 [《How we built our multi-agent research system》](https://www.anthropic.com/engineering/multi-agent-research-system)，讲的就是 Claude Research 怎样组织这种研究工作。它采用主 Agent 协调、子 Agent 并行探索的结构。理解这套设计，可以顺着任务和结果的流向看。

下面先拆解 Research，再用图对照常见协作方式。产品调研是本文构造的例子；分类对照是通用架构说明。

## 主 Agent：把问题拆开，也把结果收回来

原文中的 LeadResearcher 制定计划并保存到 Memory，向多个 Subagent 委派研究任务。子 Agent 返回发现后，LeadResearcher 综合材料，决定是否继续调查。[原文架构说明](https://www.anthropic.com/engineering/multi-agent-research-system)

![Research 主 Agent 保存计划，向三个独立子 Agent 委派任务，汇合发现后按需补查](/images/posts/agent-paradigms-three-layers/research-overview.svg)

*图 1：按原文机制重绘。上、下两个 LeadResearcher 方框表示同一个主 Agent 的不同阶段。*

在知识库调研这个例子里，可以按产品分工：A 查产品甲，B 查产品乙，C 查产品丙。交付格式统一为“能力、适用版本、证据链接、未确认项”。这样主 Agent 收到的就是可以逐项比较的材料。

主 Agent 还要检查比较条件。A 找到的是企业版，B 找到的是免费版，即使两份材料都没有事实错误，直接横向比较也会误导读者。此时需要派发的下一项任务很具体：补查套餐差异，或把比较范围统一到同一类部署方式。

从这个例子看，拆分与汇总是连在一起的。派发时没有约定比较口径，汇总时就需要重新调查；派发时没有要求保留来源，汇总者也很难判断某项结论是否可靠。

## 子 Agent：独立上下文里仍然有一个检索循环

Subagent 使用自己的上下文搜索资料、判断工具结果，再返回重要发现。原文把这种分工看作对信息的压缩：详细探索分散进行，主 Agent 接收提炼后的材料。[原文对子 Agent 的说明](https://www.anthropic.com/engineering/multi-agent-research-system)

![子 Agent 接收任务、搜索阅读、检查证据；有缺口时修改查询，材料充分后返回摘要和来源](/images/posts/agent-paradigms-three-layers/research-subagent.svg)

*图 2：子 Agent 内部的执行过程。图 1 的每个研究分支都可以包含这个循环。*

假设产品甲的介绍页写着“支持细粒度权限”。如果任务是比较目录、文档和字段级权限，这句话还不足以填表。研究者需要继续看权限文档，确认到底控制什么对象，以及哪些套餐支持。

这个例子的停止条件应当是比较字段已经获得证据，或者缺口已经明确。找到很多页面，只能说明搜索发生过。返回十段宣传文案，也可能没有回答“是否支持文档级授权”这个具体问题。

这里还存在摘要丢失条件的风险。原文如果写的是“仅云端企业版支持”，返回时压缩成“支持”，主 Agent 会在不知情的情况下得到一个范围更大的结论。因此，本文示例把版本与套餐放进交付格式，让压缩之后仍能保留影响判断的条件。

## CitationAgent：报告和文档在这里重新对齐

研究材料充分后，原文系统由 CitationAgent 根据报告与文档定位引用。[原文引用整理流程](https://www.anthropic.com/engineering/multi-agent-research-system)

![研究报告和来源文档一起输入 CitationAgent，输出带引用的回答](/images/posts/agent-paradigms-three-layers/research-citation.svg)

*图 3：引用整理接收报告和来源文档。它处于研究之后，不是与研究员竞争答案的评委。*

这个职责很容易和事实判断混在一起。假设报告写“产品甲支持完整迁移”，链接却只介绍了 Markdown 导出。链接是真实的，页面也确实谈导出，但它没有说明权限、附件、历史版本是否一并迁移。

对这样的交付，我会先收窄结论到来源能支持的范围，再列出其余迁移能力的缺口。仅仅给每段文字加一个链接，还不能让“完整迁移”这句话成立。

引用检查也可以反过来暴露研究遗漏：如果一个重要论断找不到对应文档，就应重新检查它来自原始材料、研究者推测，还是汇总时产生的延伸。

## 并行之后，系统还要能等待、恢复和验收

原文发布时，主 Agent 按批等待子 Agent 完成，异步协调仍是后续方向。生产部分讨论错误恢复、检查点和执行追踪；评估关注事实、引用、覆盖范围、来源质量与工具效率。[原文工程经验](https://www.anthropic.com/engineering/multi-agent-research-system)

回到产品调研，A、B 已完成，C 的文档站却暂时打不开。画在图上的三条并行线，这时变成一个具体的交付选择：等待 C、换一个可核对的来源，还是先报告两项结果并标明第三项缺失？这个问题需要任务要求和失败状态共同决定。

我会在这样的示例系统中保留每个分支的研究范围、已有结果和未完成事项。恢复时才能知道哪部分已经完成，哪部分需要继续；汇总时也能区分“没有这个能力”和“没有查到这个能力”。

验收可以直接对照最初的问题：每款产品都查了吗，比较口径一致吗，关键结论有证据吗？这些检查比统计创建了多少 Agent 更接近用户真正需要的结果。并行还会增加各分支的调用和汇总工作，是否值得，要放回具体任务评估。

## 用示意图对照其他多 Agent 协作方式

Research 已经给出了一个 **Supervisor-Workers** 式的主从协作例子，见图 1。下面补上原分类文章中的其他结构。它们是便于比较的组织方式，可以组合使用；命名参考 [Microsoft 的 Agent 协调模式](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) 与 [LangChain 的多 Agent 文档](https://docs.langchain.com/oss/python/langchain/multi-agent)。

### Router：入口先选择专家

Router 根据输入选择处理分支。图中只选中了技术专家，其他分支是可能的去向。它适合入口就能判断归属的请求；如果用户一句话同时涉及多个领域，设计时就要明确如何拆分或升级处理。

![Router 接收请求后选择技术专家，产品和账务专家作为其他可能分支](/images/posts/agent-paradigms-three-layers/router.svg)

*图 4：单选路由示意。与 Research 同时派出多个研究分支的流程对照。*

### Sequential 与 Handoff：交付材料，或交出后续处理权

Sequential 按预定顺序串起 Agent；Handoff 则允许当前 Agent 根据处理情况转交控制权。它们都画成从左到右的箭头，但箭头含义不同。[Microsoft 对顺序和交接的说明](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)

![上图为研究到写作到审核的固定顺序；下图为接待 Agent 将处理权交给技术 Agent，由后者继续对话](/images/posts/agent-paradigms-three-layers/sequential-handoff.svg)

*图 5：两种交接分别画出。上半部分传递产物，下半部分转移后续处理权。*

拿一个客服例子来说，“请技术专家帮忙查日志，查完告诉我”和“接下来由技术专家接待用户”，需要保留的状态不同。前者还要回到原负责人，后者必须让新负责人知道已经承诺了什么、还有什么没解决。

### Fan-out / Fan-in：分支独立执行，最后合并

这种图强调执行阶段的展开与汇合。Research 的并行研究可以用这个角度观察；Supervisor-Workers 则更强调谁分配任务、谁拥有整体目标。

![同一份任务材料分发给三个独立研究 Agent，三个分支分别返回后集中汇总](/images/posts/agent-paradigms-three-layers/parallel.svg)

*图 6：并行展开与汇合。每个分支可以拥有不同的研究任务。*

如果三个分支分别检查部署、权限和迁移，它们的结论可以按字段合并。如果三个分支回答同一个问题，出现分歧时就需要核对证据。两种任务都能画成这张图，汇总规则却需要分别设计。

### Group Chat 与 Debate：让参与者看到彼此的意见

群聊把多个 Agent 的讨论放入共享会话，由管理器组织发言。Debate 可以进一步安排提出方案、质疑证据、裁决等职责。[Microsoft 的群聊模式](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)

![上图为三个专家围绕共享会话发言；下图为提出方案、质疑证据、裁决结果并按需返回修订的辩论循环](/images/posts/agent-paradigms-three-layers/group-debate.svg)

*图 7：群聊与一种辩论流程。Research 的独立检索分支不应直接理解为这种共享讨论。*

比如两位研究者对迁移能力有不同理解，可以让他们围绕同一份导出文档解释依据。讨论的价值在于找出分歧来自哪个条件；如果大家只是反复表达意见，就没有增加新的证据。

### Peer-to-Peer：参与者直接交接

这里用点对点网络表示一种没有固定中央负责人、由参与者直接交接的设计。Swarm 一类名称在不同实现中可能有不同含义，不能仅凭名称推断通信与状态机制。

![三个 Agent 通过双向连线直接交接，图中没有固定中央调度者](/images/posts/agent-paradigms-three-layers/peer.svg)

*图 8：弱中心化协作示意；连线表示可交接，不表示所有 Agent 始终同时运行。*

假设 A 把一个权限问题交给 B，B 又判断需要 A 补充业务背景，系统就要能识别这是补充信息还是整项任务退回。否则任务可能在双方之间来回流转，始终没有人对最终答案负责。

读这些图时，可以逐条检查箭头携带的是任务、材料、反馈还是控制权，再看最终由谁交付。对照 [Anthropic 的 Research 原文](https://www.anthropic.com/engineering/multi-agent-research-system)，尤其值得检查的是：主 Agent 收回的材料，是否足以支持它继续研究或结束任务的判断。
