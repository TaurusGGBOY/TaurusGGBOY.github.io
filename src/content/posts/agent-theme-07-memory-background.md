---
title: "Agent主题对比07｜Anthropic 如何构建多 Agent 研究系统"
published: 2026-08-12T10:07:00+08:00
updated: 2026-09-08
description: "导读 Anthropic 的多 Agent 研究系统实践：主 Agent 分工、子 Agent 并行检索、引用整理，以及评估、成本和生产恢复。"
tags: ["agent-theme-comparison", "ai-agent", "multi-agent", "anthropic", "research"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-07-memory-background/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-07-memory-background"
series: "agent-theme-comparison"
order: 7
difficulty: "intermediate"
time: "5 min"
prerequisites:
  - "了解 Agent 会循环调用工具完成任务"
topics:
  - "Anthropic Research"
  - "主 Agent 与子 Agent 分工"
  - "并行检索"
  - "任务委派"
  - "评估与生产恢复"
status: "verified"
verified_at: "2026-09-08"
---

Anthropic 在 2025 年 6 月 13 日发布的 [《How we built our multi-agent research system》](https://www.anthropic.com/engineering/multi-agent-research-system)，介绍了 Claude Research 的多 Agent 架构及落地经验。读这篇文章，可以沿着一个问题往下看：一个研究请求怎样被拆开，又怎样汇成可信的回答？

## 架构：分头研究，再集中判断

原文采用 **orchestrator-worker** 模式：主 Agent 制定计划，子 Agent 用独立上下文并行检索、压缩发现；主 Agent 汇总后决定是否继续调查，最后由 CitationAgent 整理引用。独立上下文让不同方向的探索各自展开，减少主线程容纳全部检索过程的压力。[架构说明](https://www.anthropic.com/engineering/multi-agent-research-system)

用一个自拟例子理解：用户想比较三款知识库产品，要求覆盖部署、权限和迁移。可以按产品分工，让每个研究者交付同一格式的资料：

| 任务 | 交付内容 |
| --- | --- |
| 调查产品 A | 部署方式、权限粒度、导出能力及对应来源 |
| 调查产品 B | 同样的字段，并标明资料对应的版本 |
| 调查产品 C | 同样的字段，缺失的信息明确留空 |
| 汇总比较 | 统一口径，检查矛盾，指出仍需补查的问题 |

这张表是对架构的示意，不是 Anthropic 的实际案例。按产品分工便于各自阅读完整文档；统一字段则让结果能够比较。如果 A 的资料讨论企业版，B 的资料讨论免费版，主 Agent 就需要补查套餐差异，否则一张整齐的表也可能误导读者。

## 委派：把任务写到能够独立执行

Anthropic 强调，委派要交代目标、输出格式、工具与来源、任务边界，并按问题复杂度分配投入。模糊指令容易造成重复搜索和遗漏。[提示词经验](https://www.anthropic.com/engineering/multi-agent-research-system)

延续上面的例子，我会这样写其中一项任务：

```text
调查产品 A 的自托管能力，仅使用官方文档和版本说明。
范围：部署依赖、登录方式、权限粒度、数据导出。
返回表格：结论、适用版本或套餐、来源链接、未确认项。
不要调查 B、C，也不要给出三款产品的总体推荐。
找到覆盖这些字段的证据后结束；找不到时说明缺口。
```

这里的边界有实际用途：总体推荐需要看到三个产品的材料，提前让每个子 Agent 推荐会产生口径不同的结论。要求保留未确认项，则能让汇总者区分“产品不支持”和“目前没找到说明”。

## 评估与生产：结果之外还要看执行过程

原文的评估覆盖事实、引用、完整性、来源质量和工具效率，并保留人工检查。生产部分讨论检查点、错误恢复、执行追踪及新旧版本并存；当时系统仍按批等待子 Agent，异步协调是后续方向。[评估与工程经验](https://www.anthropic.com/engineering/multi-agent-research-system)

对这个产品调研例子，我会用下面几项验收结果：

- 表格里的每个确定结论，能否在链接中找到依据？
- 版本、套餐和部署环境是否一致？
- 两份文档互相矛盾时，报告有没有指出？
- 某个研究任务中断后，已经完成的材料能否继续使用？

最后一项尤其影响使用体验。假设 A、B 已调查完，C 的文档站暂时打不开，合理的交付可以保留前两份材料并说明 C 的缺口。整份报告重新开始，会让已完成的工作也进入下一轮不确定性。

## 成本决定了哪些任务值得拆

Anthropic 报告其多 Agent 系统的 Token 消耗约为普通聊天的 15 倍。原文看好可并行、信息量大的研究任务，也指出依赖密集的编码任务往往较难拆分。这是该文的经验范围。[收益与成本](https://www.anthropic.com/engineering/multi-agent-research-system)

我的阅读重点是子任务交付之后的那一步：主 Agent 是否有足够的信息检查、比较和继续推进？可以先拿一个真实问题试拆。如果每个子任务都能独立找到证据，返回后只需少量补查，分工就有意义；如果研究者必须不断询问彼此刚做了什么，任务边界还需要调整。

阅读全文：[Anthropic — How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)。文中的架构与工程描述对应 2025 年发布时的系统。
