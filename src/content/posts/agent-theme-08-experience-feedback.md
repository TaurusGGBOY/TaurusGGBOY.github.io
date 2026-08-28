---
title: "Agent主题对比08｜Agent 如何证明任务真的完成"
description: "用测试、运行态验证、Trace、停止条件和总成本建立 Agent 完成证据链，并比较 Claude Code、Codex、Pi 与 DeepSeek Harness 的验证责任。"
published: 2026-08-12T10:08:00+08:00
updated: 2026-08-28
verified_at: 2026-08-28
draft: false
image: /images/posts/agent-theme-08-experience-feedback/claude-code-source-reading-00.png
imagePosition: left
tags:
  - agent-theme-comparison
  - ai-agent
  - agent-evaluation
  - claude-code
  - codex
  - pi
  - deepseek-harness
category: "AI / Architecture"
topics:
  - Agent 完成证据
  - 测试与运行态验证
  - Trace 与停止条件
  - Agent 总成本
  - Claude Code
  - Codex
  - Pi
  - DeepSeek Harness
prerequisites:
  - 能阅读测试输出、日志和代码差异
  - 了解工具调用与 Agent 循环
time: 14 分钟
slug: agent-theme-08-experience-feedback
series: agent-theme-comparison
order: 8
---

判断 Agent 是否完成任务，不能看它有没有说“完成”，要看一条可复查的证据链：改动通过目标测试，真实运行路径得到验证，Trace 能解释关键动作，停止条件没有掩盖失败，所花时间与 token 也在可接受范围内。四种 harness 的差别，正在于它们替你承担了证据链的哪一段。

## 完成是证据链，不是一句回复

一个修复可能通过单元测试，却在浏览器里点不开；也可能界面看似正常，却破坏了未覆盖的接口。Agent 的最终回复只是结论，测试结果、运行记录和可追溯过程才是证据。Claude Code 的官方工作流把循环概括为收集上下文、采取行动、验证结果；其中验证可以继续使用测试、检查输出或读取诊断信息，而不是把一次工具成功当成终点。[Claude Code 如何工作](https://code.claude.com/docs/en/how-claude-code-works)

这条证据链可以拆成五问：目标行为有没有测试；真实入口能不能跑通；关键决策能不能回放；失败时会不会诚实停止；完成一次要付出多少时间、token 和人工复核。问题的顺序很重要。没有正确性，低成本没有意义；只有正确性而没有可复查过程，团队也难以信任结果。

验收证据还要能对应最初请求。用户要修复导出乱码，Agent 却只证明“项目可以编译”，证据是真的，却没有回答主问题。较好的最终报告会把每条需求映射到一个可观察结果：哪个测试覆盖了乱码样例，哪次实际导出生成了正确文件，未覆盖的平台是什么。这样审查者不用从几十条工具调用中猜测任务是否闭环。

对跨模块任务，可以在开始前写一张小型验收表，完成后逐项附上命令、输出位置和观察时间。证据缺失的项目保持“未验证”，不要用相邻测试的成功代替。

四个项目给出的默认答案并不相同。Claude Code 提供较完整的工具循环与验证习惯，Codex 更强调把运行态反馈接入 harness，Pi 把验证策略留给扩展和使用者，DeepSeek Harness 则把运行过程组织为可观察、可替换的 runtime。选择之前，要先确认缺失的是验证能力，还是验证纪律。

## 测试证明已知行为

测试最适合回答“代码是否满足已写明的规则”。修复解析器时，先把复现样例写成失败测试，再改代码并运行相关测试；若改动会影响公共接口，还要跑覆盖面更大的回归集。Claude Code 可以调用项目已有命令并根据结果继续迭代，但官方文档也说明它的行动由工具和权限约束，是否拥有正确测试、运行什么测试，仍取决于仓库与指令。[Claude Code 工具与验证循环](https://code.claude.com/docs/en/how-claude-code-works)

Codex 的工程团队把测试和代码审查放进同一闭环：Agent 实现后由其他 Agent 审查，再根据评论修复；真正困难的部分是让反馈快速、可靠地回到执行循环。[Harness engineering](https://openai.com/index/harness-engineering/) 这说明“能运行测试”只是起点。harness 还要限制无关测试的成本、保留失败输出，并在测试不稳定时避免把偶然通过写成确定结论。

Pi 走的是更小的核心。官方将它定位为最小 coding-agent harness，并通过 TypeScript 扩展注册工具、命令和事件处理器。[Pi 官网](https://pi.dev/)、[Pi 扩展文档](https://pi.dev/docs/latest/extensions) 好处是团队可以精确实现自己的测试门禁；代价是 Pi 不会替项目发明正确的回归策略。若扩展只检查退出码、不检查断言数量或跳过项，它仍可能产生“绿色但无效”的证明。

DeepSeek Harness 允许能力以插件和子系统组合，适合把测试执行、结果提取与策略判断拆开。[DeepSeek Harness 架构](https://www.deepseek.com/harness/en/) 可组合性没有自动提高测试质量：选择了错误测试集，模块化只会更稳定地执行错误策略。

## 运行态验证证明真实路径

用户抱怨“提交按钮点了没有反应”时，单元测试很难单独结案。Agent 应启动应用，走一遍用户路径，查看浏览器控制台、服务日志、网络请求或生成的截图。Codex 团队在公开工程复盘中把应用运行起来，并给 Agent 接入浏览器自动化、日志、指标和截图，让它能直接观察行为是否符合预期。[Harness engineering](https://openai.com/index/harness-engineering/) 这里证明的是具体运行路径，不等同于整个产品没有缺陷。

运行态验证还要匹配故障层级。CLI 工具要核对标准输出、错误码和文件副作用；Web 应用要看交互、请求与服务端状态；异步任务要等待可观测的终态，而不是把“请求已接收”当作“处理已完成”。OpenHands 把 Agent 行为和环境反馈放在统一事件流中，论文将这种事件流描述为 Agent 与环境交互的基础。[OpenHands 论文](https://arxiv.org/abs/2407.16741) 事件存在不代表验证完成，但它能让 harness 基于真实反馈继续判断。

Claude Code、Pi 和 DeepSeek Harness 都能通过工具或扩展接入这类检查，默认完整度却不同。Claude Code 有现成的命令与文件工具，Pi 鼓励使用扩展塑造专用工作流，DeepSeek Harness 强调插件化 runtime。团队应记录每个任务类型必须看到的运行证据，避免把“理论上能接入”误写成“默认已经验证”。

## Trace 证明过程可复查

Trace 不负责证明结果正确，它回答“Agent 为什么得到这个结果”。有用的 Trace 至少保留模型输入边界、工具调用、环境返回、失败重试和最终产物。SWE-agent 的论文指出，Agent–Computer Interface 会显著影响模型能否有效浏览、编辑和执行代码；它用专门接口和防护规则约束交互。[SWE-agent 论文](https://papers.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf) 因而回看 Trace 时，不应只责怪模型，还要检查接口是否隐藏了关键信息。

DeepSeek Harness 把可追踪运行列为设计能力，并允许不同 provider、插件和子系统参与同一次执行。[DeepSeek Harness 官网](https://www.deepseek.com/harness/en/) 这种设计适合定位“是模型判断错、工具失败，还是权限拒绝”。不过项目当前是 developer preview，README 明示可能出现破坏兼容性的变更；安全说明也写明它未经安全审计，不能把 sandbox 或审批当作处理不可信输入的唯一安全控制。[DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)、[安全边界](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)

Trace 也有成本。完整保存每段上下文会增加存储、隐私与审阅负担，删得太狠又无法复现。实际做法是保留影响结论的事件和工件，为敏感字段脱敏，并让最终报告指向具体测试、日志片段或运行产物。摘要可以帮助阅读，原始证据仍要能定位。

## 停止条件决定失败是否诚实

Agent 循环必须知道什么时候成功、失败或请求人工介入。可靠的成功条件应是外部可观察状态，例如“目标测试通过且页面主路径走通”，而不是“模型认为问题已解决”。可靠的失败条件包括重试预算耗尽、权限不足、依赖服务不可用、验证互相矛盾，以及任务边界需要产品决策。

停止条件太松，Agent 会在未验证时宣布完成；太严，它会反复修改已正确的代码。Claude Code 的子 Agent 拥有独立上下文、工具和权限，并向主会话返回结果摘要。[Claude Code 子 Agent](https://code.claude.com/docs/en/subagents) 主 Agent 因此要把摘要重新接回任务级验收，不能把“子任务已返回”当作整体完成。Codex 的多轮审查同样需要退出规则，否则审查与修复可能循环消耗预算。[Harness engineering](https://openai.com/index/harness-engineering/)

遇到不稳定测试时，停止报告应区分三种状态：改动引入的确定失败、与改动无关的已知失败、尚未解释的波动。这个分类比笼统写“测试大体通过”更有用。它保留事实边界，也告诉下一位工程师应该复跑、隔离还是回滚。

人工接管也应是正常终态。若修复需要产品选择、生产凭证或不可逆的数据操作，Agent 应停在决策点，列出已确认事实、候选方案和各自影响。继续猜测不会提高自治，只会把缺少授权伪装成技术进展。一个能准确说明“缺什么才能继续”的 harness，通常比不断重试到超时更可靠。

## 把成功换算成总成本

比较 harness 时，不能只数一次调用的 token。总成本还包括首次成功前的重试、工具等待、人工接管、失败排查和重复验证。VS Code 团队公开的 harness 评估把正确性、Agent effort、token efficiency 和 latency 分开观察，说明速度或 token 只是评价维度之一。[VS Code harness 评估](https://code.visualstudio.com/blogs/2026/05/15/agent-harnesses-github-copilot-vscode)

一篇仍处于初步预印本阶段的研究在 3 个 harness、2 个模型和 50 个任务上观察到 harness 会改变结果与成本表现。[The Scaffold Effect](https://arxiv.org/abs/2607.22585) 这个样本能支持“脚手架影响评估”的提醒，不能推出某个 harness 在所有仓库里更强。若要内部选型，应使用自己的任务分布、权限环境和验收规则，报告成功率之外的中位耗时、人工介入次数和失败类型。

可以把一次任务的完成记录压缩为四项：交付物是什么，哪些测试和真实路径通过，哪些风险尚未验证，花了多少机器与人工成本。Claude Code、Codex、Pi、DeepSeek Harness 都可以参与这条链，但没有任何一个项目能替团队定义“正确”。harness 的价值，是让定义变成可执行、可观察、可停止的流程。

## 本文引用

- [Claude Code：How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Claude Code：Create custom subagents](https://code.claude.com/docs/en/subagents)
- [OpenAI：Harness engineering](https://openai.com/index/harness-engineering/)
- [Pi：Minimal coding agent harness](https://pi.dev/)
- [Pi：Extensions](https://pi.dev/docs/latest/extensions)
- [DeepSeek Harness：Architecture](https://www.deepseek.com/harness/en/)
- [DeepSeek Harness：README](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness：Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
- [SWE-agent: Agent–Computer Interfaces Enable Automated Software Engineering](https://papers.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf)
- [OpenHands: An Open Platform for AI Software Developers as Generalist Agents](https://arxiv.org/abs/2407.16741)
- [VS Code：Evaluating Agent Harnesses for GitHub Copilot](https://code.visualstudio.com/blogs/2026/05/15/agent-harnesses-github-copilot-vscode)
- [The Scaffold Effect](https://arxiv.org/abs/2607.22585)
