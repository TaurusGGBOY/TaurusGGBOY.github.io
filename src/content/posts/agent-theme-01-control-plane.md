---
title: "Agent主题对比01｜四种 Harness 到底把控制权交给谁"
published: 2026-08-12T10:01:00+08:00
updated: 2026-08-28
description: "Claude Code、Codex、Pi 与 DeepSeek Harness 的核心差别，不是功能多少，而是产品替你决定多少、团队必须接管多少。"
tags: ["agent-theme-comparison", "ai-agent", "agent-harness", "claude-code", "codex", "pi", "deepseek-harness"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-01-control-plane/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-01-control-plane"
series: "agent-theme-comparison"
order: 1
difficulty: "intermediate"
time: "14 min"
prerequisites:
  - "正在使用或评估至少一种 coding agent"
  - "能区分产品体验与团队自建运行时"
topics:
  - "Harness 控制权"
  - "Claude Code"
  - "Codex"
  - "Pi"
  - "DeepSeek Harness"
  - "平台责任"
status: "verified"
verified_at: "2026-08-28"
---

四者最值得比较的不是“谁会改代码”，而是谁替你决定工作方式。Claude Code 把最多决定收进成品工作台；Codex 把稳定执行语义与客户端分开；Pi 只保留一个可塑的小核心；DeepSeek Harness 连循环和日志都允许替换。控制权越靠近使用者，自由度越高，团队要接手的工程责任也越多。

## Claude Code 与 Pi：接受产品意见，还是自己定义工作方式

Claude Code 的优势是整合。它把代码探索、工具反馈、权限、会话和扩展入口放在同一产品体验里，[官方工作原理](https://code.claude.com/docs/en/how-claude-code-works) 也直接围绕“读取代码库—采取行动—根据结果继续”来描述使用方式。相比 Pi，团队不用先设计终端交互、基础工具组合和会话体验，个人开发者可以更快进入真实任务。

这份整合也是 Claude Code 的边界。你可以通过 CLAUDE.md、Skills、Hooks、MCP 和插件改变很多行为，却仍在它定义的产品生命周期、权限语义和交互入口里工作。若团队要替换主循环、重新规定每一类事件怎样入日志，Claude Code 不是最短路径；它的优势来自产品替你做了选择，短板也正是这些选择不会全部交还给你。

Pi 走向另一端。[Pi 首页](https://pi.dev/) 把自己称为 minimal agent harness，[README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md) 强调让使用者按自己的工作流塑造它。相较 Claude Code，Pi 更适合不认同成品默认值的团队：工具少了可以加，界面不合适可以换，行为可以用 TypeScript extension 深入改造，而不必先绕过一整套产品意见。

Pi 的短板不是“功能少”这么简单，而是缺失的决定会变成你的待办。扩展由谁维护，危险命令在哪里隔离，团队成员如何获得一致配置，升级后自定义模块怎样回归，都不再由一个集成产品兜底。Claude Code 用户付出的代价主要是接受边界；Pi 用户付出的代价主要是拥有边界。

## Codex 与 Claude Code：同一产品入口，还是可被多端驱动的执行层

Codex 与 Claude Code 都提供较完整的使用表面，但控制权切分不同。[OpenAI 对 Codex agent loop 的说明](https://openai.com/index/unrolling-the-codex-agent-loop/) 把核心描述为用户、模型和工具之间的编排；[App Server 工程文章](https://openai.com/index/unlocking-the-codex-harness/) 更关键：IDE 等客户端可以驱动同一 Harness，而不必各自重写循环。对产品集成团队而言，Codex 的优势不是多一个 UI，而是可以把执行层当成协议化能力复用。

Claude Code 更像一套向用户交付完整体验的工作台，Codex 更像既有官方客户端、又把 thread、turn、item 等运行语义暴露给客户端的执行层。前者减少了产品拼装，后者减少了多端重复实现。若需求只是让工程师在终端高效工作，Codex 的协议面可能成为额外概念；若要把同一 Agent 接进 IDE、桌面端或内部系统，Claude Code 的产品完整性反而不等于集成者拥有底层状态协议。

Codex 的短板也随这条边界出现：App Server 给了集成入口，却不替内部产品团队完成 UI、任务队列、租户隔离、身份映射和异常恢复。它比 Pi 少造一层核心执行语义，比 Claude Code 多承担一层宿主产品责任。选择 Codex，不是在“成品”和“框架”之间免费得到两者，而是购买一个较稳定的中间层，再自己完成最后一公里。

## Pi 与 DeepSeek Harness：改造 Agent，还是重组运行时

Pi 的小核心主要服务于“把 coding agent 改成我的工具”；DeepSeek Harness 的公开架构则把目标推到“把运行时部件重新组合”。其[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 把模型适配器、工具注册表、会话日志和 Agent loop 都列为插件。和 Pi 的 TypeScript extensions 相比，DeepSeek Harness 暴露的不是几个行为钩子，而是更接近运行时骨架的替换面。

这使 DeepSeek Harness 在异构模型、不同传输层或实验性会话结构上更有吸引力。Pi 适合围绕一个小而可用的 Agent 逐步加能力；DeepSeek Harness 更适合一开始就需要替换 provider、事件流或编排部件的平台研究。反过来，若目标只是增加一个数据库工具或调整交互，DeepSeek Harness 的运行时自由会带来比 Pi 更大的理解、配置和兼容成本。

这里不能忽略成熟度差异。DeepSeek Harness 的 [README](https://github.com/deepseek-ai/deepseek-harness) 明确标为 developer preview，并警告会出现破坏兼容性的变化；这意味着它现在提供的是值得研究的控制面，不是已经稳定的企业扩展契约。Pi 同样把稳定工作流的责任交给使用者，但它的最小定位减少了需要理解的运行时层次；DeepSeek Harness 则要求团队同时拥有架构判断和升级预算。

## 真正的锁定点各不相同

控制权还会改变团队怎样协作。Claude Code 可以把常用规则放进项目说明和产品扩展点，新成员进入的是相对一致的现成体验；Pi 允许每个人快速塑造自己的终端，但如果 extensions、提示规则和启动参数没有被版本化，同一个仓库会出现多套事实标准。Claude Code 的一致性更多由产品形态提供，Pi 的一致性必须由仓库治理提供。

Codex 与 DeepSeek Harness 面对的则是平台一致性。Codex 可以让多个客户端复用同一执行层，但客户端仍可能选择不同的事件展示、批准流程和恢复策略；一致的是 Harness 语义，不一定是用户体验。DeepSeek Harness 允许不同 profile 装配不同 provider、transport 和插件，灵活度更高，却更容易出现“同名 Agent 实际运行图不同”。两者都需要配置身份与版本记录，DeepSeek Harness 还要记录完整插件图。

升级时，Claude Code 用户主要验证官方更新是否改变现有工作流与扩展；Codex 集成者还要验证 App Server 协议和自己的客户端。Pi 团队必须重新跑所有内部 extensions，DeepSeek Harness 团队则要同时检查插件接口、装配顺序和事件消费者。控制权从产品向团队移动以后，升级不再只是“新版本能否启动”，而是“我们自己拥有的每个契约是否仍然成立”。

人员结构因此会让结论反转。一个没有专职平台工程师的五人产品组，即使欣赏 DeepSeek Harness 的可替换循环，也更可能从 Claude Code 获益；一个已有 IDE、任务队列和审计系统的平台组，即使 Claude Code 对终端用户更完整，也可能更需要 Codex 的执行接口。Pi 位于两者之间：它不要求先造完整平台，但至少需要有人持续维护扩展与隔离。

Claude Code 最难替换的是已经形成习惯的整合工作流：权限规则、团队说明、插件与日常交互一起迁移，成本高于换一个命令。Codex 最难替换的是围绕 App Server 语义建立的宿主集成：客户端一旦依赖 thread、turn、item 和审批事件，替换执行层就要重做协议适配。

Pi 最难替换的不是核心，而是团队自己长出来的 extension 集合。自由定制越成功，内部模块越可能变成只有少数人理解的私有平台。DeepSeek Harness 的锁定点则在插件图与事件契约：理论上部件可替换，实际 profile、provider、transport 和日志消费者一旦互相依赖，迁移仍然是一项运行时工程。

因此，“开放”不等于“没有锁定”。Claude Code 与 Codex 的锁定更容易指向产品和协议；Pi 与 DeepSeek Harness 的锁定更多来自自己写下的代码与运维知识。前两者把一部分维护风险交给供应方，后两者把一部分路线决定权拿回团队，也把人员流失和兼容回归风险拿了回来。

采购方式也暴露了责任位置。Claude Code 的采购判断应重点验证官方工作流是否覆盖团队高频任务；Codex 还要验证自建宿主的工程预算；Pi 必须把 extension、隔离和内部支持算进总成本；DeepSeek Harness 则要把运行时维护与预览期迁移列成长期岗位，而不是一次性接入项目。只比较订阅费或仓库许可证，会系统性低估后三者由团队承担的成本。

退出方案同样不同：Claude Code 应提前导出团队规则与外部工具契约，Codex 应隔离客户端与 App Server 适配层，Pi 应给 extensions 建立独立测试，DeepSeek Harness 应让 profile 和事件消费者可以逐个替换。能否退出，不取决于宣传中的开放程度，而取决于团队有没有把自己新增的耦合写清。

## 裁决：你愿意接手哪一层责任

| 产品 | 优势 | 短板 | 代价 | 适合谁 |
| --- | --- | --- | --- | --- |
| Claude Code | 整合度高，工作流和控制入口成套交付 | 主循环与产品生命周期不由团队掌握 | 接受产品边界，并围绕其扩展点建设 | 希望直接使用成熟工作台的个人与团队 |
| Codex | 执行语义可被 CLI、IDE 和自建客户端复用 | App Server 不替你完成宿主产品和平台治理 | 维护客户端、身份、队列与协议适配 | 要把统一 Agent 执行层嵌入多个入口的产品团队 |
| Pi | 核心小，行为与工具改造直接 | 隔离、一致配置和扩展质量缺少成品兜底 | 长期维护内部 extensions 与运行环境 | 想拥有工作流、能维护 TypeScript 扩展的小团队 |
| DeepSeek Harness | 模型、工具、日志、循环都可重组 | 预览期兼容性与生产成熟度不足 | 承担运行时设计、安全隔离和升级回归 | 研究异构编排或自建 Agent 平台的团队 |

如果团队没有人明确负责 Harness，Claude Code 通常比 Pi 或 DeepSeek Harness 更诚实：它少给控制权，也少制造无人维护的自由。若团队真正要把 Agent 变成产品能力，Codex 的执行层边界比单一工作台更有价值。只有当“替换循环或事件系统”本身就是目标时，DeepSeek Harness 的深层可组合性才抵得过预览期成本。

## 本篇引用来源

- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi Coding Agent](https://pi.dev/)
- [Pi coding agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)
- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)
