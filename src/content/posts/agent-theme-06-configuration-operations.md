---
title: "Agent主题对比06｜扩展越深，升级越痛"
published: 2026-08-12T10:06:00+08:00
updated: 2026-08-28
description: "Claude Code 与 Codex 提供分层扩展，Pi 让 TypeScript extension 进入进程，DeepSeek Harness 连 loop 与 session 都可替换；深度决定故障半径。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi", "deepseek-harness", "plugins", "mcp"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-06-configuration-operations/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-06-configuration-operations"
series: "agent-theme-comparison"
order: 6
difficulty: "advanced"
time: "16 min"
prerequisites:
  - "需要为 coding agent 加入团队规则、外部工具或自定义行为"
  - "愿意为扩展升级和故障承担明确责任"
topics:
  - "扩展深度"
  - "Claude Code 插件"
  - "Codex Skills 与 App Server"
  - "Pi Extensions"
  - "DeepSeek Harness Plugins"
  - "升级成本"
status: "verified"
verified_at: "2026-08-28"
---

扩展能力不是越深越好。Claude Code 把说明、Skill、Hook、MCP 与插件分层，适合在产品边界内组合；Codex 再加上 AGENTS.md 与 App Server，把仓库规则和宿主集成分开；Pi 的 TypeScript extension 可以直接改变进程内行为；DeepSeek Harness 连 loop、session 和 sandbox 都放进插件树。能改得越深，升级时要证明的东西越多。

## Claude Code 对 Codex：两套分层扩展，服务不同控制面

Claude Code 的[扩展总览](https://code.claude.com/docs/en/features-overview) 给 CLAUDE.md、Skills、MCP、subagents 与 Hooks 安排不同位置，[插件文档](https://code.claude.com/docs/en/plugins) 再把这些组件打包分发。优势是产品边界清晰：只想提供知识就用说明或 Skill，需要事件自动化才用 Hook，要连外部服务才引入 MCP，不必为了一个团队规则修改运行时。

Codex 也采用分层方式，但控制面更偏仓库与宿主。[AGENTS.md 文档](https://developers.openai.com/codex/guides/agents-md) 让目录层级决定指令作用域，[Skills](https://developers.openai.com/codex/skills) 打包说明、脚本与资源，[MCP](https://developers.openai.com/codex/mcp) 接入外部工具；需要自建客户端时，再通过 App Server 消费执行事件。相比 Claude Code，Codex 的优势是扩展可以从任务上下文一路延伸到独立客户端，而不是全部围绕一个工作台。

Claude Code 的短板是深层行为仍服从产品定义的生命周期；Codex 的短板是层次一多，团队容易把指令、工具和宿主混成一个扩展项目。AGENTS.md 或 Skill 里的“必须先审批”只是模型上下文，不能替代 MCP 服务端或 Harness 的技术控制；Claude Code 里的 CLAUDE.md 同样不能替 Hook 或权限策略执行门禁。两者都分层，但都无法阻止团队把软约束误当硬边界。

升级成本也不同。Claude Code 插件作者主要跟随官方组件格式与事件点；Codex 团队除了 Skills/MCP，还可能维护 App Server 客户端协议。只在现成产品里发布团队工作流，Claude Code 的打包更集中；要让自建 IDE 与任务系统一起演进，Codex 的扩展跨度更有价值，也要求更宽的兼容测试。

## Pi 对 Claude Code：进入宿主进程，换来更直接也更危险的控制

Pi 的 [Extensions 文档](https://pi.dev/docs/latest/extensions) 允许 TypeScript 模块注册工具和命令、订阅 Agent 与 session 事件、修改上下文、拦截工具调用并提供 UI。相比 Claude Code 的分层扩展，Pi 更容易在一个模块中同时改变行为与呈现；当团队要实现特殊编辑流程或领域交互时，不必等待产品提供新的固定事件点。

这项优势同时扩大故障半径。Pi extension 是宿主进程里的代码，可以泄漏资源、阻塞事件、修改模型上下文或拦错工具；Claude Code 的纯 Skill 主要承担上下文风险，Hook 和 MCP 才逐步进入更高权限层。Pi 把不同深度集中到同一种可编程模块，灵活但不替维护者标出“这次扩展已经从提示文本变成执行代码”。

Pi 的另一个短板是团队分发与兼容规范需要自建。Claude Code plugin 有明确打包入口，Pi 可以从用户、项目或显式路径加载 extensions，却必须由团队决定版本锁定、依赖安装、冲突处理和回滚。小团队只维护两三个 extension 时很轻；扩展数量增长后，Pi 很容易变成一个没有正式发布流程的内部插件平台。

反过来，Claude Code 的官方层次也可能让一个跨层能力拆成 Skill、Hook、MCP 与插件配置，调试要穿过多个产品入口。Pi 可以把它收在一个 TypeScript 模块里，更容易单步理解。选择不是“结构化一定胜过代码化”，而是团队更能维护多个受限组件，还是一个权限更大的进程内组件。

## DeepSeek Harness 对 Pi：行为扩展，还是运行时替换

DeepSeek Harness 的[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 把 model adapter、tool registry、session log 和 agent loop 全部定义为插件，并用 profile、bundle 与有序 patch 组成 plugin tree。相比 Pi extension 改变既有最小 Harness，DeepSeek Harness 更接近让团队重新选择 Harness 的骨架。

它的优势出现在真正需要异构运行时的场景：不同 provider 使用不同 transport，某类任务替换 session log，研究环境更换 loop，或把 sandbox、approval、telemetry 按 profile 重组。[Cordis 生命周期文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md) 还提供服务、事件和 effect 随插件卸载撤销的架构约定。Pi 能深入改行为，DeepSeek Harness 则试图让深改仍遵循共同生命周期模型。

短板是共同模型并不会自动消除组合错误。一个插件注册的资源是否都挂到 effect，一个子 context 是否意外读取父 scope 服务，一个替换 loop 是否仍写全 session 事件，都需要端到端验证。Pi 的单个 extension 出错通常围绕该模块；DeepSeek Harness 的 patch 顺序或服务解析出错，可能让整个运行图以错误组合启动。

成熟度进一步放大升级代价。DeepSeek Harness 的 [README](https://github.com/deepseek-ai/deepseek-harness) 明确标为 developer preview 并预告破坏兼容变化，[SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) 也说明未经安全审计、不能作为生产安全边界。相比 Pi，团队不仅要维护自己的插件，还要跟随底层插件契约演化；相比 Claude Code 与 Codex，更不能期待稳定产品扩展面替你吸收变化。

## 四种扩展分别会把什么升级变成事故

需求变化时，Claude Code 与 Codex 的浅层扩展更容易拆除：删除一份说明或停用一个 Skill，主要影响上下文；移除 Hook、MCP 或 App Server 集成时，才涉及执行和宿主。Pi extension 往往同时承担工具、事件与 UI，移除一个模块可能一次失去多层能力。DeepSeek Harness 替换 plugin tree 的某个服务，更可能影响所有依赖该服务的下游插件。

测试策略因此不能共用一套。Claude Code 插件应分别验证 Skill 加载、Hook 触发和 MCP 权限；Codex 还要验证 AGENTS.md 作用域及客户端 item 兼容。Pi extension 需要进程内单元测试与真实 session 生命周期测试；DeepSeek Harness 插件则必须在完整 profile 中检查服务解析、patch 顺序、卸载 effect 和事件重放。深层扩展只做函数测试远远不够。

负责人结构也会反转选型。Claude Code 与 Codex 的文本规则可以由一线开发者维护，执行扩展再交给平台或安全人员；Pi 把大量能力集中在 TypeScript，适合一个能同时理解产品和运行时的小组；DeepSeek Harness 的 provider、session、loop 与 sandbox 最好有明确子系统负责人。没有长期 owner 时，越深的扩展越容易成为无人敢升级的关键路径。

第三方生态会带来不同信任债务。Claude Code plugin 与 Codex Skill/MCP 需要逐组件检查文本、脚本、进程与凭据；Pi extension 直接按宿主代码依赖审查；DeepSeek Harness 插件还要审查它声明和消费的服务。包名、市场来源或“官方示例”都不能替代权限分析，尤其不能把 MCP、extension 与运行时 plugin 当成同一风险等级。

性能问题也会落在不同层。Claude Code 与 Codex 的浅层说明可能增加上下文，Hook/MCP 可能增加调用延迟；Pi extension 可能阻塞宿主事件循环或重复改写上下文；DeepSeek Harness 的多层 plugin 与 telemetry 可能增加启动、分发和记录开销。公开架构只能指出可能的成本位置，不能在没有同任务数据时宣布哪一种一定更快。

最小可行扩展的含义因此不同：Claude Code 与 Codex 先选最浅入口，Pi 先限制 extension 职责，DeepSeek Harness 先限制替换的服务数量。能用上层解决的问题，不应直接下沉到 loop 或 session。

扩展评审必须同时写明 owner、回滚入口和升级验收任务。

Claude Code 升级最可能让某个 Hook 事件、插件结构或产品行为改变，影响范围通常仍在工作台内；Codex 若同时使用 Skills、MCP 与 App Server，协议变化可能从执行层传到多个客户端。前者重点做插件与高频任务回归，后者还要做跨入口的事件兼容测试。

Pi 升级最可能暴露进程内 extension 对内部时序、UI 或资源生命周期的假设。它能直接修，却可能只有作者知道为什么。DeepSeek Harness 升级则可能改变 plugin tree、服务契约或 profile 组合，一处变化影响 loop、session 与 telemetry 的联动。Pi 的风险更多是私有模块债务，DeepSeek Harness 的风险更多是运行时组合债务。

安全审查同样随深度递增。Claude Code 的 Skill 与说明先审查文本，Hook/MCP 再审查执行与凭据；Codex 的 AGENTS/Skills 与 MCP/App Server 也要分层。Pi extension 默认按宿主进程能力审查，DeepSeek Harness 插件还要检查它在不同 context 和 profile 中获得哪些服务。统一叫“插件”，不会让四者拥有同一信任边界。

退出成本也要在采用前计算。Claude Code 与 Codex 的文本规则和 MCP 工具相对容易迁移，但产品事件与客户端协议不容易；Pi 的 extensions 可读可改，却可能绑定其事件 API；DeepSeek Harness 理论上部件都能换，实际内部 profile 一旦依赖 Cordis 服务图，迁移要重建整套生命周期。开放接口减少供应商黑箱，不减少团队自己制造的耦合。

## 裁决：只买任务需要的扩展深度

| 产品 | 优势 | 短板 | 代价 | 适合谁 |
| --- | --- | --- | --- | --- |
| Claude Code | 扩展分层清楚，插件可统一分发 | 主循环和固定产品事件不能任意重写 | 跟随官方扩展点并审查各组件权限 | 在成品工作台内标准化团队流程的人 |
| Codex | 从 AGENTS/Skills/MCP 延伸到 App Server 宿主 | 扩展跨度大，容易把软指令与硬控制混淆 | 维护多层契约和客户端兼容 | 同时经营仓库规则、工具与自建入口的团队 |
| Pi | TypeScript extension 直接改变行为、工具和 UI | 进程内权限大，分发与兼容治理需自建 | 建立内部扩展测试、发布和负责人制度 | 需要深度定制但不想重造完整运行时的小团队 |
| DeepSeek Harness | loop、session、sandbox 等运行时部件均可组合 | 组合故障面最大，预览期兼容与安全风险高 | 维护插件图、生命周期、安全测试与迁移 | 确实需要实验或建设可替换 Agent 运行时的平台 |

只是共享规则或接一个 SaaS，Claude Code 与 Codex 的分层扩展足够，区别在是否需要自建宿主。需要把行为与 UI 一起深改，Pi 通常比重组运行时更直接。只有当 loop、session 或 sandbox 本身就是替换目标时，DeepSeek Harness 的深度才值得支付预览期升级成本。

## 本篇引用来源

- [Claude Code：Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- [Claude Code：Create plugins](https://code.claude.com/docs/en/plugins)
- [OpenAI：Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [OpenAI：Build skills](https://developers.openai.com/codex/skills)
- [OpenAI：Model Context Protocol](https://developers.openai.com/codex/mcp)
- [OpenAI：Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi：Extensions](https://pi.dev/docs/latest/extensions)
- [DeepSeek Harness：Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness：Cordis lifecycle and effects](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md)
- [DeepSeek Harness：README](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness：SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
