---
title: "Agent主题对比07｜多 Agent 是委派工具还是组织系统"
published: 2026-08-12T10:07:00+08:00
updated: 2026-08-28
description: "区分上下文隔离、并行委派、持续团队与 A2A 跨产品协作，并比较 Claude Code、Codex、Pi、DeepSeek Harness 的适用边界。"
tags: ["agent-theme-comparison", "ai-agent", "multi-agent", "claude-code", "codex", "pi", "deepseek-harness"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-07-memory-background/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-07-memory-background"
series: "agent-theme-comparison"
order: 7
difficulty: "advanced"
time: "22 min"
prerequisites:
  - "Agent主题对比 04｜长任务怎样保持上下文并恢复"
  - "Agent主题对比 06｜扩展能力应该装插件还是改运行时"
topics:
  - "multi-agent delegation"
  - "context isolation"
  - "agent teams"
  - "A2A interoperability"
  - "Claude Code"
  - "Codex"
  - "Pi"
  - "DeepSeek Harness"
status: "verified"
verified_at: "2026-08-28"
---

多 Agent 没有一个通用开关。把搜索结果移出主上下文、同时派出三个任务、维持一支长期团队、调用另一家公司托管的 Agent，是四种不同问题。先判断你需要哪一层，再选择 subagent、workflow 或 A2A；层次选错，增加的往往是冲突、等待和审计成本。

想象一次跨仓库升级：主 Agent 让一个助手查兼容性，让另一个助手改代码，再让第三个助手审查。看起来像“三人团队”，但三个助手可能只运行几分钟，结束后也不保留共同目标、成员关系或持续任务状态。这里真正发生的只是委派。

## 四种协作解决四种事故

把“多 Agent”拆开，选型会清楚很多。

| 层次 | 要防的事故 | 最小机制 |
| --- | --- | --- |
| 上下文隔离 | 搜索日志、测试输出挤掉主任务约束 | 独立上下文，只回传摘要或结果 |
| 并行委派 | 可独立子任务串行执行，白白等待 | 并发运行、结果汇合、取消和超时 |
| 持续团队 | 多个执行者重复劳动、互相覆盖或无人收尾 | 共享目标、任务所有权、消息、冲突处理 |
| 跨产品互操作 | 不同组织和技术栈无法发现、调用、跟踪彼此 | 可发现身份、任务生命周期、认证和产物协议 |

这四层可以叠加，却不能互相替代。独立上下文不会自动解决文件冲突；同时启动多个进程也不会产生团队责任；给内部 subagent 套上网络协议，更不会补出可靠的任务分配。

## 上下文隔离适合一次性委派

最常见的 subagent 价值很朴素：让副任务产生的噪声留在另一个上下文里。Claude Code 的[官方 subagent 文档](https://code.claude.com/docs/en/subagents)明确写到，每个 subagent 使用自己的上下文窗口、系统提示、工具和权限，完成后把结果交回主会话。它适合代码搜索、日志分析、测试排查这类“过程很长，结论很短”的工作。

隔离也会丢信息。主 Agent 若只收到“已检查，没有问题”，无法知道助手查了哪些文件、跳过了哪些假设。可靠的委派需要写清输入、期望产物和失败条件。结果最好是可核对的文件、命令输出或引用，而不是一句信心很足的总结。

一个实用判断是看副任务的“过程与结论之比”。阅读几十份日志后只需返回三条异常，适合隔离；修改核心接口并持续响应调用方反馈，则不适合切断上下文。委派说明还应包含禁止触碰的范围、可用工具、验证命令和回传格式。这样做不是为了写更长提示，而是让主 Agent 能判断结论来自完整检查、局部抽样，还是工具受限后的推断。上下文隔离节省的是注意力，不能同时省掉证据。

Pi 选择把核心保持在较小范围。[Pi 官方定位](https://pi.dev/)是“minimal agent harness”，而[扩展示例](https://pi.dev/docs/latest/extensions)把 subagent 放在可选 extension 中。这个取舍适合愿意自己定义委派语义的人：你能决定子进程、工具和返回格式，也要自己承担超时、取消、权限继承和结果合并。

## 并行不等于团队

并行委派只有在任务真正独立时才省时间。让三个 Agent 同时研究三个库，通常合理；让三个 Agent 同时修改同一配置文件，合并成本可能高过串行执行。开始并发前，应给每个任务一个互不重叠的写入边界，或者让研究者只读、实现者独占写入、审查者等待变更完成。

Claude Code 的公开文档把单会话 subagent、独立后台会话和 agent team 分成不同入口，[subagent 页面](https://code.claude.com/docs/en/subagents)也明确提示：多个独立会话并行、跨会话传递消息、由 Claude 组织团队，属于不同能力。这个区分很重要。一次 Agent 工具调用可以隔离上下文，却不必然拥有持续成员、团队邮箱或共同待办。

并行之前还要识别隐藏依赖。两个 Agent 即使修改不同文件，也可能同时改动同一数据库迁移顺序、生成同一份锁文件，或基于不同版本的接口假设工作。任务图比 Agent 数量更值得先画：没有依赖的节点可以同时开始，消费上游产物的节点必须等待，可能争用共享状态的节点需要独占或明确合并者。取消同样是并行机制的一部分；上游方案被否决后，继续运行的下游 Agent 只会制造过期产物和额外费用。

OpenAI 分享的 Codex 工程实践更接近围绕交付物编排工作流：Agent 本地自审，再请求特定 Agent 审查，处理反馈，循环到审查通过。[这是一项特定仓库与工具环境中的工程案例](https://openai.com/index/harness-engineering/)，OpenAI 也提醒其效果依赖仓库结构，不能直接外推成 Codex 在任意项目上都能自治。它说明“多 Agent”可以由测试、评审和反馈循环组成，不要求把参与者包装成一支常驻团队。

## 持续团队需要状态和责任

当工作跨越数小时、多个分支或多次人工介入，问题从“能否启动助手”变成“谁拥有下一步”。持续团队至少要回答四件事：任务由谁领取，成员如何报告进度，冲突由谁裁决，成员退出后状态留在哪里。

这也是组织系统比并行工具昂贵的地方。每个成员都需要上下文和模型调用；共享消息会进入新的上下文；主 Agent 要等待、重试和整合。团队规模扩大后，最稀缺的资源可能不再是生成 token，而是人能否看懂每个成员做过什么。

持续团队还需要一个可恢复的事实面。聊天记录可以解释过程，却不适合单独承担任务状态；分支和文件保存产物，却不说明谁在等待谁。较稳妥的组合是把目标、负责人、依赖、验收和阻塞原因写进结构化任务状态，把讨论留在消息里，把可交付结果落到版本化工件中。成员重启后应先读取这些事实，再决定是否继续，而不是凭一段压缩摘要猜测团队现状。

责任边界也要覆盖失败。负责实现的人不能同时以“我已经完成”为唯一验收者；审查者发现问题后要把任务退回明确负责人；两名成员产生冲突时，要有一个能够选择方案或请求人工决策的角色。没有这些规则，所谓团队只是多条会话并排运行，失败会在汇总阶段集中暴露。

DeepSeek Harness 把 subagent 后端抽象成 provider。[官方 subagent 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)说明多个 provider 可以并存，provider 可代表进程内 spawn、继承历史的 fork 或远程 ACP 传输，并在启动前声明能力，不支持的请求应直接失败。这给异构编排留下了接口，也把兼容性、生命周期和错误语义带进了运行时。

这项能力受项目状态约束。DeepSeek Harness 的 [README](https://github.com/deepseek-ai/deepseek-harness)仍将项目标为 developer preview，并明确提示会发生破坏性兼容变更；[安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)称项目尚未经过安全审计，不能视为安全或生产就绪，也不能作为不可信任务的唯一安全控制。可重组 provider 是公开设计，不是已经证明优于其他团队机制的结果。

## A2A 只处理跨产品边界

当采购 Agent、代码 Agent 和工单 Agent 分属不同厂商，调用方无法共享内部进程、工具注册表或完整会话。这时才进入 A2A 的问题域。[A2A 官方说明](https://a2a-protocol.org/latest/)把它定义为独立 Agent 之间的通信层，并明确说它不是内部 subagent 或工具调用协议。

A2A 关心的是远程 Agent 如何公布身份与能力、接受有状态任务、返回消息和产物，以及调用方怎样认证和跟踪进度。它不决定远程 Agent 内部用 Claude Code、Codex、Pi 还是 DeepSeek Harness，也不替远程系统设计沙箱、任务拆解或完成验证。

因此，单仓库内的研究助手没有必要为了“标准化”先上 A2A。只有当边界两侧需要独立部署、独立升级、独立授权，协议成本才有回报。把内部函数调用过早升级成跨产品协议，会增加版本协商、认证、重试和观测面，却没有防止新的具体事故。

## 选择从最小层次开始

如果副任务只会污染主上下文，使用一次性 subagent；如果几项工作互不写同一状态，再增加并发；如果成员要跨会话协作，补上任务所有权、消息和恢复；如果边界跨越团队或厂商，再评估 A2A。

落地时可以从一次两小时内能验收的任务试起。记录主 Agent 等待了多久、子任务返回了什么证据、是否发生重复搜索或写入冲突、失败后能否取消和恢复。若一次性委派已经稳定完成工作，就没有必要为了“更像组织”引入成员目录和共享消息；若人工一直在转发状态、协调所有权，才说明机制需要上升一层。每次升级都应对应一个已经出现或高度可预见的事故。

四个项目的取向也由此变得具体：Claude Code 提供从 subagent 到团队的集成入口；Codex 的公开案例强调围绕测试和评审构成执行循环；Pi 把编排留给 extension 与操作者；DeepSeek Harness 把异构 child transport 纳入可替换 provider。没有哪一种抽象天然更高级。能用最小机制防住当前事故，才是合适的层次。

## 本文引用

- [Claude Code：Create custom subagents](https://code.claude.com/docs/en/subagents)
- [OpenAI：Harness engineering](https://openai.com/index/harness-engineering/)
- [Pi Coding Agent](https://pi.dev/)
- [Pi Extensions](https://pi.dev/docs/latest/extensions)
- [DeepSeek Harness：Subagent subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)
- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
- [A2A Protocol](https://a2a-protocol.org/latest/)
