---
title: "Agent主题对比02｜一次 Agent 任务怎样跑完"
published: 2026-08-12T10:02:00+08:00
updated: 2026-08-28
description: "用同一个跨文件修复任务拆解 Agent 的最小循环：获取上下文、调用模型、执行工具、回填反馈、验证结果并停止。"
tags: ["agent-theme-comparison", "ai-agent", "agent-loop", "claude-code", "codex", "pi", "deepseek-harness"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-02-message-tool-execution/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-02-message-tool-execution"
series: "agent-theme-comparison"
order: 2
difficulty: "intermediate"
time: "18 min"
prerequisites:
  - "理解模型、Harness、运行环境与任务的区别"
  - "知道 tool call 与普通文本输出的区别"
topics:
  - "Agent Loop"
  - "Claude Code"
  - "Codex"
  - "Pi"
  - "DeepSeek Harness"
  - "工具反馈与完成条件"
status: "verified"
verified_at: "2026-08-28"
---

一次 Agent 任务不是模型生成一段代码就结束。它至少要完成“取上下文 → 调模型 → 执行工具 → 回填结果 → 验证 → 停止”这条循环。四个项目都会走这条路，真正的差异是每一步由谁持有、失败怎样暴露，以及“完成”需要什么证据。

下面只用一个场景：订单接口新增字段后，后端已经返回数据，前端仍显示空白，一条集成测试同时失败。需求只有一句：“修好订单页并确保测试通过。”这句话离可交付变更还很远。

## 从一句需求到第一轮行动

Agent 接到需求后，需要先建立当前世界的快照：工作目录里有哪些约束，相关代码在哪里，失败测试输出是什么，哪些文件允许修改。缺少这一步，模型很容易凭文件名猜路径，或者修掉表象却漏掉数据转换层。

高质量上下文不等于把整个仓库塞进提示词。[Anthropic 的上下文工程文章](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) 建议寻找尽可能小的一组高信号 token。对这个任务来说，路由入口、接口类型、数据映射、页面组件和失败断言比几十份无关配置更有用。Harness 的工作是让模型能逐步发现这些信息，并把新的观察保留到下一回合。

第一轮通常不会直接修改代码。Agent 可能先搜索订单字段，打开相关类型和测试，再根据结果决定下一条工具调用。模型负责提出行动；Harness 负责把行动解析成可执行请求、检查权限、调用实际工具，并把 stdout、stderr、退出码或文件差异变成下一轮输入。

## 共同最小循环有六个位置

四个项目的界面不同，最小循环可以还原成同一条路径：

1. 获取上下文：用户要求、项目规则、相关文件和历史消息进入本轮输入。
2. 请求模型：模型生成说明、工具调用，或表示需要更多信息。
3. 执行工具：Harness 调用搜索、读取、编辑、Shell 或外部工具。
4. 回填反馈：工具结果进入会话，模型据此修正假设。
5. 验证结果：运行测试、静态检查或应用级验证，检查改动是否满足需求。
6. 满足停止条件：交付可核验结果，或因缺少权限、信息和安全授权而停下。

[Claude Code 的工作原理](https://code.claude.com/docs/en/how-claude-code-works) 明确说明，每次工具使用返回的信息都会进入循环，影响 Claude 的下一步决定。[OpenAI 对 Codex agent loop 的拆解](https://openai.com/index/unrolling-the-codex-agent-loop/) 也把循环描述为用户、模型和工具之间的编排。这两份资料支持的是共同结构，不代表两个产品在同一任务中会选择相同的工具或获得相同结果。

这条循环往往要走很多次。搜索命中太多，Agent 会缩小范围；测试报类型错误，它会重新读取类型定义；依赖命令因网络策略失败，它应该区分代码失败和环境失败。Harness 如果把不同失败都压成一句“工具失败”，模型就失去了纠错依据。

## 四个项目怎样持有这条循环

Claude Code 把循环放在一个集成式工作台里。官方文档展示的工作方式是：读取代码库、编辑文件、运行命令，然后根据工具反馈继续。对订单页任务，使用者主要观察它选择了哪些文件、请求了什么权限、测试结果是否回到后续判断。工具丰富并不是重点，反馈能否形成闭环才是。

Codex 更强调同一执行语义能被不同表面驱动。[App Server 工程文章](https://openai.com/index/unlocking-the-codex-harness/) 说明，IDE UI 可以使用同一 Harness 驱动同一 Agent loop，无需自己重写一套循环。对任务结果的意义是：客户端可以改变呈现和交互方式，但命令、工具事件与回合状态仍由共同执行层组织。这个设计目标不能推导出 Codex 在修复订单页时一定更快。

Pi 把核心保持得很小。[Pi 作者对 minimal coding agent 的说明](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) 和 [官方 README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md) 都把重点放在小核心与扩展。使用者可以按自己的工作流改造工具和行为。对应的代价很实际：若团队需要专门的浏览器验证、数据库检查或审批逻辑，需要自己选择扩展，并验证它们怎样把结果送回循环。

DeepSeek Harness 把循环本身也纳入可替换部件。[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 列出的插件范围包含模型适配器、工具注册表、会话日志和 Agent loop；[Core 子系统文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md) 描述了工具调用经注册表分发、模型可见事实追加回日志的过程。它适合需要重组运行时的团队研究，但项目仍处于 developer preview，兼容性会变化；官方 [SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) 还说明它未经安全审计、不能视为生产就绪。公开资料确认了架构形态，完成率仍需独立、受控的任务数据。

| 项目 | 这次修复中由 Harness 重点持有的部分 | 使用者需要补看的证据 |
| --- | --- | --- |
| Claude Code | 集成工作流中的上下文、工具反馈和权限交互 | 实际修改、测试输出与权限记录 |
| Codex | 可由多个客户端驱动的一致 Agent loop | thread/turn 内的工具事件和最终差异 |
| Pi | 最小核心与使用者选择的扩展组合 | 扩展行为、外部隔离和自定义验证 |
| DeepSeek Harness | 可替换 loop、工具注册和追加式日志 | 具体 profile、插件版本、Trace 与安全环境 |

## 失败反馈决定能不能自我纠正

回到订单页。Agent 修改了接口类型，测试仍然失败：页面收到的是 `order_status`，组件读取的却是 `status`。如果 Harness 回填了失败断言、文件位置和命令退出码，模型能推翻“只是类型缺失”的旧假设，继续追踪映射层。如果只告诉它“测试未通过”，下一轮可能重复同一修改。

有效反馈至少需要区分四类结果：工具成功且产生观察；工具成功但没有行动效果；任务代码失败；执行环境或权限阻止了动作。它们对应不同下一步。搜索无结果应该换关键词，测试断言失败应该检查业务逻辑，包下载被网络策略拦截则需要权限或替代环境。

还要防止“反馈很多，信息却没有前进”。如果 Agent 连续三轮读取同一文件、重复同一失败命令或只改写解释文字，Harness 应让这些无行动回合在 Trace 中可见，并触发换策略、缩小问题或请求人工帮助。否则循环形式仍在运转，任务状态却没有增加新证据，直到预算耗尽才停下。

[Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) 强调工具需要清晰定义、谨慎使用上下文，并能组合进不同工作流。放到 coding agent 中，清晰不只是参数名好看，还包括结果能否让模型判断“命令没运行”“运行后失败”还是“运行成功但目标仍未满足”。

失败也不总该自动重试。同一个命令连续被权限边界拒绝、测试依赖不可用、需求存在两种不兼容解释时，更多回合只会增加成本。循环需要把问题交还给人，或输出一个可恢复的阻塞状态。下一篇会专门讨论这个停点。

## “我改好了”不是停止条件

模型输出自然语言总结，只说明它认为工作可以结束。订单页任务的完成证据至少包括：目标字段在真实数据路径中被正确映射，原失败测试通过，相关回归检查没有新增失败，最终差异没有越过允许范围。若 UI 行为无法由现有测试覆盖，还应进行运行态验证，或明确把它列为未验证项。

停止条件应该在任务开始前就能被说清。清晰的失败测试适合自动循环；模糊的“优化一下体验”需要人确认验收标准。Harness 可以提醒或强制执行检查，但不能替用户发明产品决策。

[OpenAI 的 Harness engineering 案例](https://openai.com/index/harness-engineering/) 提到，Agent 缺少合适工具、抽象和内部结构时，很难朝高层目标持续推进。这支持一个朴素判断：让模型多思考不能补上缺失的测试环境，也不能把模糊需求自动变成可靠验收。

评估一次循环时，不要只数“成功”或“失败”。同时记录工具调用、token、延迟、重试、人工介入和无行动回合。一次看似便宜的修复，如果让工程师多次恢复环境、确认含糊动作，真实成本并不低。

## 把任务交给 Agent 前写清三样东西

这次修复能否顺利跑完，最依赖三份输入：可复现的失败、允许触达的环境、可检查的完成条件。它们分别约束循环从哪里开始、能走到哪里、何时结束。

三份输入缺一份，Agent 仍可能产出代码，却很难证明任务已经闭环。

选择 Claude Code、Codex、Pi 或 DeepSeek Harness 时，也可以用同一任务观察三件事：它怎样找到第一批相关上下文；遇到失败后是否拿到足够信息改变策略；最终回复能否指向测试、运行态或差异证据。这样比较的是完整任务路径，不是功能菜单。

若中途动作准备越过工作区、访问网络或读取凭据，循环应该停下来处理风险，而不是把权限弹窗当成效率损失。沙箱、审批和外部隔离分别解决不同问题，下一篇继续拆开。

## 本篇引用来源

- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [What I learned building an opinionated and minimal coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- [Pi coding agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)
- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness Core subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)
- [DeepSeek Harness Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
