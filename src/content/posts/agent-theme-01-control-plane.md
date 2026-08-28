---
title: "Agent主题对比01｜为什么不能只比模型"
published: 2026-08-12T10:01:00+08:00
updated: 2026-08-28
description: "模型只负责提出下一步，Harness 决定它看见什么、能调用什么、怎样验证以及何时停下。本文建立 Claude Code、Codex、Pi 与 DeepSeek Harness 的统一比较单位。"
tags: ["agent-theme-comparison", "ai-agent", "agent-harness", "claude-code", "codex", "pi", "deepseek-harness"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-01-control-plane/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-01-control-plane"
series: "agent-theme-comparison"
order: 1
difficulty: "intermediate"
time: "18 min"
prerequisites:
  - "知道语言模型可以输出文本和工具调用"
  - "正在使用或评估至少一种 coding agent"
topics:
  - "Agent Harness"
  - "Claude Code"
  - "Codex"
  - "Pi"
  - "DeepSeek Harness"
  - "Coding Agent 评估"
status: "verified"
verified_at: "2026-08-28"
---

同一个模型装进不同 Agent，可能走不同工具路径、消耗不同 token，也可能在不同位置停下。答案很直接：模型名不能代表完整 Agent。有效能力来自“模型 × Harness × 运行环境 × 任务”，选型和评测都要同时控制这四项。

你可以把模型想成每一回合提出下一步的人。谁把文件送进上下文，谁真正执行命令，失败后回填哪些信息，怎样限制权限，又凭什么宣布完成，这些工作由模型外面的系统承担。这个系统就是 Harness。

## 一个模型名遗漏了三件事

假设团队要让 Agent 修复一个横跨 API、数据库迁移和前端页面的缺陷。两位同事都选择同一型号的模型。一位在可写工作区、受限网络和完整测试环境中运行；另一位只能读文件，缺少数据库工具，测试输出还被截断。两次结果不同，不能简单归因于“模型发挥不稳定”。

差异至少来自三处：Harness 为模型准备了什么信息，提供了哪些行动通道，运行环境又允许这些行动触达什么资源。论文 [What makes a harness a harness](https://arxiv.org/abs/2606.10106) 把 Harness 概括为包裹语言模型、让它能在代码仓库中行动的那一层；[AI Harness Engineering](https://arxiv.org/abs/2605.13357) 则把软件工程能力放在模型、Harness 与环境组成的系统中讨论。这两个定义都把“能回答代码问题”和“能完成代码任务”分开了。

这里的环境也不是电脑配置表。工作目录是否干净、依赖能否安装、凭据是否暴露、网络是否可达、测试要跑多久，都会改变 Agent 可观察的世界。任务同样需要固定：修一个有明确失败用例的函数，与迁移一个缺少验收标准的系统，不应放进同一分数里比较。

## Harness 会把差距放大到任务结果

Harness 不是提示词外壳。它决定模型每一回合收到哪些高信号信息、能否组合工具、失败是否可见、上下文何时压缩，以及完成声明前有没有验证。模型给出相同意图时，一个 Harness 可能把它翻译成受限命令并回传完整 stderr；另一个可能只返回“执行失败”。下一回合的判断自然会分叉。

[The Scaffold Effect in Coding Agents](https://arxiv.org/abs/2607.22585) 专门把 Harness 当作编码 Agent 评测中的隐藏变量。论文在其受控任务和配置内报告，同一模型因 Harness 不同，解决任务所需 token 可相差到 40 倍。这个数字不能外推成某个产品永远更省 token；它能支持的结论是：不记录 Harness，就连“每个已解决任务的成本”也无法只归因于模型。

更早的 [SWE-agent 研究](https://papers.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf) 也显示，面向语言模型设计交互界面会影响下游任务表现。工具的参数、观察结果的格式、一次允许编辑多少内容，看似是界面细节，实际都进入了模型的决策回路。

因此，看到“模型 A 在 Agent X 中优于模型 B”时，先问四个问题：两个模型是否使用同一 Harness，权限和资源是否一致，任务集合是否相同，停止和计分规则是否相同。少一个，结论就只能描述那次组合。

## 四个项目把责任放在不同位置

这组文章比较 Claude Code、Codex、Pi 与 DeepSeek Harness，不按功能数量打分。我们关心它们把上下文、工具、权限、会话和验证责任放在哪里。

| 项目 | 公开资料呈现的设计取向 | 选型时真正要问的问题 |
| --- | --- | --- |
| Claude Code | 集成式 Agent 开发工作台 | 团队是否需要一套已经组合好的代码理解、工具、权限和工作流体验 |
| Codex | 跨 CLI、IDE、应用与自动化表面的执行层 | 多个客户端能否驱动同一套 Agent 语义，并保留一致的任务状态 |
| Pi | 可塑的最小 Harness | 团队是否愿意自己选择扩展、隔离和工作流约束 |
| DeepSeek Harness | 可重组的运行时与异构编排底座 | 团队是否真的需要替换运行时部件，并能承担预览期变化与安全责任 |

[Claude Code 的工作原理](https://code.claude.com/docs/en/how-claude-code-works) 把它描述为读取代码库、采取行动并根据反馈继续工作的 Agent；工具结果会回到循环，影响下一步。它的公开产品文档覆盖上下文、工具、权限与多种工作流，因此本文把它视为集成式工作台。这是产品形态判断，不代表它在所有任务上质量最高。

[OpenAI 对 Codex agent loop 的说明](https://openai.com/index/unrolling-the-codex-agent-loop/) 把核心循环定义为对用户、模型与工具交互的编排。[App Server 的工程文章](https://openai.com/index/unlocking-the-codex-harness/) 说明 IDE 等客户端可以驱动同一 Harness，而不用各自重写循环。这里比较的是 Codex 的执行语义，不把某一个客户端拥有的界面功能算成模型能力。

[Pi 官方首页](https://pi.dev/) 直接将它定位为 minimal agent harness；其 [coding agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md) 强调以扩展塑造工作方式。较少的内建选择给了使用者更大的改造空间，也把更多组合、隔离和维护责任交给使用者。少并不自动等于更安全，也不自动等于更高效。

[DeepSeek Harness 架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 将模型适配器、工具注册表、会话日志和 Agent loop 都设计成插件。它适合用来观察“连循环本身都可替换”的运行时思路。项目 [README](https://github.com/deepseek-ai/deepseek-harness) 同时写明它处于 developer preview，可能出现破坏兼容性的变化；[SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) 说明它未经安全审计，不能视为生产就绪。可重组是架构主张，不是已经得到独立验证的性能优势。

## 比较单位要落到一张任务卡

“模型 × Harness × 运行环境 × 任务”不是学术装饰。真正做选型时，可以把一次试验写成下面这张任务卡：

| 变量 | 需要固定或记录的内容 |
| --- | --- |
| 模型 | 精确版本、推理档位、上下文限制 |
| Harness | 产品与版本、启用的工具、扩展、停止规则 |
| 运行环境 | 操作系统、仓库状态、权限、网络、依赖与资源限制 |
| 任务 | 输入、允许修改范围、验收测试、超时和人工介入规则 |

比如比较四个项目修复同一缺陷，应给它们相同的起始提交、失败测试、依赖缓存和网络策略。若 Pi 被放进容器，Claude Code 在宿主机运行，Codex 获得外网，而 DeepSeek Harness 只能读取本地文件，这次试验仍有使用价值，但它回答的是“四套完整部署怎样表现”，不能回答“哪个 Harness 更好”。

记录人工介入也很关键。一个 Agent 用较少 token 完成任务，却要求人反复批准、解释环境和修复中间状态，成本只是从模型账单移到了工程师时间。相反，更多工具调用也可能是在运行测试、检查差异和收集证据。脱离 Trace 看调用次数，很容易奖励乐观的提前停止。

重复试验时，还要保存每轮的最终补丁、工具轨迹和人工决定。只保留一个通过率，无法判断失败来自模型推理、工具缺失、环境抖动，还是验收脚本本身。若要替换其中一个变量，最好保持另外三项不动，再比较结果分布。这样得到的是某个改变在当前任务集里的影响，不会把一次偶然成功包装成产品结论，也方便团队复查。

版本也要进入记录。云端产品可能在试验期间更新模型路由或默认工具，本地 Harness 也可能升级扩展和策略。无法锁定服务端版本时，至少记录日期、可见配置、任务输入和完整产物，并把复测结果当作新的时间截面。否则，两周后用同一名称重跑，差异究竟来自模型、Harness 更新还是环境变化，仍然无法解释。

这份时间记录也是复盘异常结果时最便宜的线索。

## 把设计证据和效果证据分开

公开文档足以支持设计层结论：某个项目是否内建沙箱，工具反馈会不会进入下一回合，运行循环能否被多个客户端驱动，插件能插入哪一层。文档还可以说明项目自己声明的成熟度和限制。

效果证据需要另一套材料。官方写着“支持沙箱”，只说明有这项控制，不等于所有配置都能抵挡不可信输入；官方写着“可扩展”，也不代表扩展后的组合已经稳定运行。任务质量和平均成本需要共同任务、明确版本、相同资源和可检查的方法。安全效果还需要威胁模型、隔离边界与绕过测试。

这也是本系列不设总冠军的原因。Claude Code 的整合度、Codex 的跨表面执行、Pi 的最小核心、DeepSeek Harness 的运行时可替换性，各自解决不同的组织问题。把它们压成一排勾选框，会丢掉最影响结果的责任分配。

## 接下来应该观察什么

读完一份产品介绍，先别问“用了什么模型”。问它如何完成一轮真实工作：需求怎样变成上下文，工具怎样执行，错误怎样回填，越权动作怎样停下，最后用什么证据结束。后面八篇会沿这条路径依次讨论任务循环、人工接管、长任务恢复、宿主状态、扩展、多 Agent、完成证明和条件式选型。

如果你只想带走一个判断方法，就保存那张任务卡。任何看似绝对的产品结论，都应该能还原到模型、Harness、环境和任务。还原不了，它更像一次演示印象，不是可复用的选型证据。

## 本篇引用来源

- [What makes a harness a harness](https://arxiv.org/abs/2606.10106)
- [AI Harness Engineering](https://arxiv.org/abs/2605.13357)
- [The Scaffold Effect in Coding Agents](https://arxiv.org/abs/2607.22585)
- [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://papers.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi Coding Agent](https://pi.dev/)
- [Pi coding agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)
- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
