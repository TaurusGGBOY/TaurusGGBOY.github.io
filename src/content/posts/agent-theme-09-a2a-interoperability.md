---
title: "Agent主题对比09｜Claude Code、Codex、Pi、DeepSeek Harness 怎么选"
description: "按团队约束、验证责任、扩展深度和风险边界，条件式选择 Claude Code、Codex、Pi 或 DeepSeek Harness；不设脱离场景的总冠军。"
published: 2026-08-17T10:08:00+08:00
updated: 2026-08-28
verified_at: 2026-08-28
draft: false
image: /images/posts/agent-theme-09-a2a-interoperability/a2a-cover.webp
imagePosition: center
tags:
  - agent-theme-comparison
  - ai-agent
  - agent-selection
  - claude-code
  - codex
  - pi
  - deepseek-harness
category: "AI / Architecture"
topics:
  - Coding Agent 选型
  - Harness 运行时
  - 扩展与验证责任
  - 安全边界
  - Claude Code
  - Codex
  - Pi
  - DeepSeek Harness
prerequisites:
  - 了解 coding agent 的工具调用与权限模型
  - 能描述团队的交付流程和验收条件
time: 15 分钟
slug: agent-theme-09-a2a-interoperability
series: agent-theme-comparison
order: 9
---

没有脱离场景的总冠军。要快速获得集成式开发体验，优先看 Claude Code；要把同一执行层接到多种产品表面并强化运行态验证，优先看 Codex；要自己塑造一套轻量 harness，优先看 Pi；要研究可替换 provider、插件与子系统，才把 DeepSeek Harness 纳入候选，而且必须接受它仍处 developer preview 的边界。

## 先写约束，再看功能

选型会失真，常见原因是先列功能，再给每项打勾。四个项目都能读文件、调用工具、修改代码，也都能扩展；真正影响落地的是团队愿意承担什么责任。先写清五个约束：谁定义工具和权限，谁维护验证环境，是否需要多个使用表面，扩展要深入到哪一层，出了事故能否从 Trace 复盘。

同一个“支持子 Agent”也可能指不同问题。Claude Code 的子 Agent 有独立上下文、工具和权限，完成后向主会话返回结果。[Claude Code 子 Agent](https://code.claude.com/docs/en/subagents) DeepSeek Harness 的 subagent 子系统可以配置不同 provider，并通过 spawn、fork 或 ACP 形成不同委派方式。[DeepSeek Harness subagent](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md) 两者都叫委派，但配置表面、稳定性和运维责任并不相同。

“可扩展”也要拆开问。扩展一个自定义命令，与替换模型 provider、会话存储或事件循环，不是同一级别的自由。前者影响某条工作流，后者会改变整个运行时的兼容和安全边界。若团队只需要接入一个部署脚本，不必因为某产品能替换更多底层组件就给它更高分；用不到的自由仍会进入升级、测试和审计范围。

评估时应使用自己仓库中的代表性任务：一次局部修复、一次跨模块重构、一次需要真实 UI 或服务验证的任务。记录正确性、耗时、token、人工介入和失败类型。VS Code 团队公开评估 harness 时也把 correctness、agent effort、token efficiency 与 latency 分开观察，而不是合成一个脱离语境的分数。[VS Code harness 评估](https://code.visualstudio.com/blogs/2026/05/15/agent-harnesses-github-copilot-vscode)

试点还要固定模型、任务输入、权限和可用工具。否则一次比较可能实际测到不同模型、不同网络条件或某个候选获得了额外上下文。失败样本比平均分更能帮助决策：是读错仓库规则、卡在审批、缺少运行反馈，还是改对代码却无法证明。只有把失败归因到 harness 能改变的环节，选型结论才可执行。

## Claude Code：集成式工作台

Claude Code 适合希望开箱获得完整 coding-agent 循环的个人和团队。官方把工作方式描述为收集上下文、采取行动、验证结果，内置文件、搜索、命令等工具，并以权限规则约束动作。[Claude Code 如何工作](https://code.claude.com/docs/en/how-claude-code-works) 如果团队已有测试命令、仓库规范和清晰验收，它可以很快进入真实任务。

它的另一项优势是可渐进增加委派。子 Agent 能隔离上下文和工具权限；后台 Agent 可并发处理独立工作；需要持续协作时，还可使用具备独立上下文的 Agent team。[Claude Code 子 Agent](https://code.claude.com/docs/en/subagents)、[Claude Code Agent teams](https://code.claude.com/docs/en/agent-teams) 团队不必一开始就建立复杂组织，可以先从一次性研究或审查任务开始。

代价是你选择了一套已经形成明确交互与权限习惯的产品。若目标是重写事件循环、替换核心状态模型，或把 runtime 嵌入自有产品深处，集成式体验会变成约束。安全上也不能只依赖默认提示：官方安全文档仍要求理解权限、提示注入和不可信内容的风险。[Claude Code 安全](https://code.claude.com/docs/en/security)

条件式结论是：团队要把主要精力放在编码任务和项目规则上，而不是维护 harness 核心时，Claude Code 更合适；需要彻底控制 runtime 结构时，再看 Pi 或 DeepSeek Harness。

## Codex：跨表面的可靠执行层

Codex 适合把同一 harness 能力接到 IDE、桌面应用、Web runtime 或自有界面的团队。OpenAI 的 App Server 将会话组织为 thread、turn 和 item，并提供稳定的双向 JSON-RPC 接口；官方文章说明 VS Code、桌面应用和 Web runtime 已用这种方式接入，TUI 则正在重构为同类客户端。[Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/) 这比“有 API”更具体：接入方可以围绕统一的执行事件构建自己的界面和审批流程。

Codex 的工程实践也强调运行态反馈。公开复盘展示了把浏览器自动化、应用日志、指标和截图接回 Agent 循环，以及用其他 Agent 做审查再修复。[Harness engineering](https://openai.com/index/harness-engineering/) 如果任务必须启动服务、操作 UI 或检查真实日志，这种验证取向比单纯扩大工具数量更有价值。

成本是接入方仍要设计产品语义。App Server 提供 thread、turn、审批和事件，不能替你定义哪个测试代表完成，也不能保证跨 provider 迁移时语义完全保真。官方文章明确提醒，通用的跨提供方抽象可能丢失特定 harness 的事件和能力。[Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)

条件式结论是：需要成熟执行层、多个用户表面和运行态验证时，Codex 更合适；只想要极小核心并自行定义一切时，它可能比 Pi 更重。

## Pi：可塑的最小核心

Pi 适合愿意自己拥有 harness 设计的团队。官方把它称为最小 coding-agent harness，核心保持精简；扩展可以注册工具、命令、事件处理器，甚至替换界面与交互行为。[Pi 官网](https://pi.dev/)、[Pi 扩展](https://pi.dev/docs/latest/extensions) 这种结构很适合内部平台、研究原型和高度专用的开发流程。

“最小”意味着更多责任留在项目侧。团队要决定上下文怎样装载、何时压缩、哪些工具可用、验证失败怎样停止、Trace 保留到什么程度。扩展自由也会形成自己的兼容面：扩展越多，升级和相互作用测试越重要。若组织没有维护 runtime 的人，初期的轻量很可能转化为长期维护成本。

安全责任也随扩展扩大。Pi 的安全文档说明它本身不是完整 sandbox，使用者应根据环境配置隔离与权限。[Pi 安全](https://pi.dev/docs/latest/security) 因而它适合能明确设计进程、文件和网络边界的团队，不适合把“核心很小”误解为“默认风险很小”。

条件式结论是：需要可读、可改、可嵌入的最小核心，并愿意维护专用扩展时，Pi 更合适；希望把维护时间留给业务代码时，先比较 Claude Code 或 Codex。

## DeepSeek Harness：可重组 runtime

DeepSeek Harness 适合验证一类更底层的假设：模型 provider、插件、上下文、工具、权限和子 Agent 能否按项目需要重新组合。官方架构把能力拆成插件与子系统，并强调运行可追踪；子 Agent 文档允许多个命名 provider 共存，在调用时检查所需能力。[DeepSeek Harness 架构](https://www.deepseek.com/harness/en/)、[subagent 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md) 这对 harness 研究、私有 runtime 实验和多 provider 工作流有吸引力。

它当前不应被当成与成熟产品同风险等级的默认生产选择。项目 README 明示处于 developer preview，可能发生破坏兼容性的变更；安全说明写明项目未经安全审计，也不是面向生产的安全系统，sandbox、审批等机制不能作为处理不可信代码或输入的唯一安全控制。[DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)、[DeepSeek Harness 安全边界](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)

条件式结论是：你确实需要重组 runtime、比较 provider 或研究 Agent 子系统，并能承担版本与安全工程时，DeepSeek Harness 值得试验；若目标只是稳定完成日常编码任务，它的自由度未必能抵消预览阶段的风险。

## 用场景做最后决策

可以把选择压缩成四个场景，而不是一张总分榜：

| 场景 | 优先候选 | 成立条件 | 复核点 |
| --- | --- | --- | --- |
| 团队希望快速采用完整编码工作流 | Claude Code | 仓库已有规则、测试和权限策略 | 集成习惯是否匹配，验证是否覆盖真实路径 |
| 同一执行能力要服务 CLI、IDE 或自有界面 | Codex | 愿意围绕 App Server 设计产品交互 | 事件语义、审批和运行态反馈是否完整 |
| 要打造轻量、专用、可嵌入的 harness | Pi | 有人长期维护扩展和安全边界 | 自建验证、Trace 与升级成本 |
| 要研究可替换 provider 与模块化 runtime | DeepSeek Harness | 能接受 developer preview 和安全工程投入 | 破坏性变更、未经审计及非唯一安全控制边界 |

如果两个候选都满足条件，做一次短期试点：使用同一批任务、同一验收标准、同一权限范围，保留失败 Trace。不要用某个公开 benchmark 直接替代内部任务分布。一篇初步预印本仅在 3 个 harness、2 个模型和 50 个任务上观察到明显的 scaffold effect；它提醒我们 harness 会改变结果，不能给所有团队排出永久名次。[The Scaffold Effect](https://arxiv.org/abs/2607.22585)

试点结束后，不要只问工程师“喜欢哪个”。把结果写成责任清单：项目方要维护哪些扩展，安全团队要批准哪些权限，任务失败时谁能复现，版本升级要回归哪些路径。Claude Code 和 Codex 的集成能力可能减少自建项，Pi 与 DeepSeek Harness 的可塑性可能增加控制力；两种收益都要与本团队实际承担的维护成本一起计算。

还要设退出条件。若候选在关键任务上持续缺少可验证反馈，或升级成本超过团队能承担的范围，应结束试点；若差异只体现在不重要的功能数量，就保持现状。迁移 coding-agent harness 会改变权限、指令、工具与审计链，维持一个满足约束的旧选择，往往比追逐更长的功能表更稳妥。

决策记录应注明适用仓库、任务类型、评估日期和复审触发条件。这样半年后模型、产品或团队能力变化时，可以重跑关键样本，而不必维护一句永久正确的品牌判断。

最终选择应是一句带条件的话：“在这些任务、权限和维护能力下，我们选择 X，因为它减少了最贵的那段责任。”当条件变化，结论也应允许变化。Claude Code、Codex、Pi 与 DeepSeek Harness 解决的是不同层次的组织问题，选型质量取决于约束写得多具体。

## 本文引用

- [Claude Code：How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Claude Code：Create custom subagents](https://code.claude.com/docs/en/subagents)
- [Claude Code：Agent teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code：Security](https://code.claude.com/docs/en/security)
- [OpenAI：Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [OpenAI：Harness engineering](https://openai.com/index/harness-engineering/)
- [Pi：Minimal coding agent harness](https://pi.dev/)
- [Pi：Extensions](https://pi.dev/docs/latest/extensions)
- [Pi：Security](https://pi.dev/docs/latest/security)
- [DeepSeek Harness：Architecture](https://www.deepseek.com/harness/en/)
- [DeepSeek Harness：subagent subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)
- [DeepSeek Harness：README](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness：Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
- [VS Code：Evaluating Agent Harnesses for GitHub Copilot](https://code.visualstudio.com/blogs/2026/05/15/agent-harnesses-github-copilot-vscode)
- [The Scaffold Effect](https://arxiv.org/abs/2607.22585)
