---
title: "Agent主题对比02｜默认工具越多越好吗"
published: 2026-08-12T10:02:00+08:00
updated: 2026-08-28
description: "Claude Code 与 Codex 用产品化工具面换取开箱效率，Pi 与 DeepSeek Harness 用更少默认值换取控制权；真正差别在故障责任。"
tags: ["agent-theme-comparison", "ai-agent", "agent-tools", "claude-code", "codex", "pi", "deepseek-harness"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-02-message-tool-execution/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-02-message-tool-execution"
series: "agent-theme-comparison"
order: 2
difficulty: "intermediate"
time: "14 min"
prerequisites:
  - "正在使用或评估至少一种 coding agent"
  - "能区分内建能力与团队自建工具"
topics:
  - "Agent 工具面"
  - "Claude Code"
  - "Codex"
  - "Pi"
  - "DeepSeek Harness"
  - "工具维护成本"
status: "verified"
verified_at: "2026-08-28"
---

默认工具多，通常意味着第一天更快；默认工具少，通常意味着第六个月更可控。Claude Code 与 Codex 更愿意替用户组合搜索、编辑、命令和反馈；Pi 把工具面压到最小，让扩展决定能力；DeepSeek Harness 把工具注册本身纳入插件图。差异不在“能不能调用工具”，而在工具失灵时谁必须修。

## Claude Code 对 Pi：即时生产力换掉了多少选择权

Claude Code 的强项是默认工具已经围绕代码任务成套工作。[官方工作原理](https://code.claude.com/docs/en/how-claude-code-works) 强调工具结果会回到后续判断，[工具设计文章](https://www.anthropic.com/engineering/writing-tools-for-agents) 则指出有效工具需要定义清楚、节制占用上下文并可组合。相比 Pi，Claude Code 用户不用先决定搜索、编辑、Shell 与权限提示怎样协作，适合今天就要处理真实仓库的人。

但 Claude Code 的默认工具也定义了问题的形状。输出怎样截断、命令怎样请求权限、工具结果如何显示和进入上下文，主要由产品控制。你可以用 Hooks、MCP 或插件补能力，却不能把每个内建行为都当成本地库函数重写。团队若有特殊数据库、硬件或审计链，整合式工具面会从优势变成需要绕行的固定边界。

Pi 的优势恰好来自不替你做太多决定。[官方 README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md) 把小核心与可塑工作流放在中心，[Extensions 文档](https://pi.dev/docs/latest/extensions) 说明扩展是改变 Pi 行为的 TypeScript 模块。与 Claude Code 相比，Pi 更容易让一个领域工具使用自己的参数、结果格式和交互规则，而不是被迫伪装成通用命令。

代价是每个“更适合我们”的工具都需要负责人。参数验证、超时、输出裁剪、异常分类、权限边界和版本兼容，Claude Code 内建工具的问题通常由产品团队修，Pi 私有 extension 的问题通常落回你自己的仓库。Pi 可以非常贴合工作流，但“贴合”不是免费属性，而是持续的软件维护。

## Codex 对 Claude Code：差别不只在工具数量，而在反馈属于谁

Codex 与 Claude Code 都把常用编码工具做成产品能力，二者更值得比较的是反馈能否被不同宿主消费。Codex 的 [agent loop 工程说明](https://openai.com/index/unrolling-the-codex-agent-loop/) 把用户、模型和工具的交互放在统一编排中；[App Server](https://openai.com/index/unlocking-the-codex-harness/) 让 IDE 或其他客户端复用该执行语义。相比 Claude Code 更完整的工作台取向，Codex 对自建客户端更友好：工具事件不仅服务当前终端，也能成为宿主 UI 的状态来源。

这并不意味着 Codex 自动给出更好的工具结果。客户端需要正确呈现进行中、成功、失败、审批和差异等事件，还要处理断线或重复消息；这些产品责任不会因为使用 App Server 而消失。Claude Code 用户较少面对协议适配，却更依赖官方界面对结果的组织。Codex 集成者拥有反馈呈现权，也必须为错误呈现承担责任。

两者的共同短板方向也不同。Claude Code 的扩展工具要与既有产品权限和上下文策略相处，深改内建行为困难；Codex 虽暴露执行层，外部宿主仍不能假设每个工具事件都是稳定业务对象。若团队只是使用 Agent，Claude Code 的整合更省事；若团队在造 Agent 产品，Codex 的事件面更有价值，但测试矩阵会增加。

## Pi 对 DeepSeek Harness：扩展工具，还是替换工具系统

Pi extension 适合“增加或改造一个能力”；DeepSeek Harness 的[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 则把工具注册表与模型适配器、日志、循环并列为插件。[Core 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md) 描述工具调用经过 registry 分发，并把模型可见事实追加到日志。相比 Pi，DeepSeek Harness 更容易研究多个工具注册表、传输方式或事件策略怎样组合。

深层替换对平台团队有意义，对普通项目却可能过度。Pi 写一个 extension 就能加入浏览器验证；DeepSeek Harness 若同时更换 registry、approval 和 log consumer，故障可能来自插件装配、事件契约或 provider，而不只是工具代码。Pi 的局部定制较容易圈定故障半径，DeepSeek Harness 的系统级可组合性则要求更强的端到端测试。

两者都把责任交给使用者，但责任颗粒不同：Pi 让你维护“这个扩展”；DeepSeek Harness 可能让你维护“这套运行时组合”。后者仍处 developer preview，[README](https://github.com/deepseek-ai/deepseek-harness) 明确警告兼容性会破坏性变化。除非工具系统本身就是研究或平台边界，否则 Pi 的较浅改造通常比替换完整 registry 更经济。

## 工具失败时，四者的真实成本才出现

默认工具还会影响团队成员得到的是否是同一个 Agent。Claude Code 的内建能力与官方更新使大多数人共享相近起点，短板是更新后的行为变化由产品节奏推动；Pi 的每个 extension 都可以固定版本，却可能因个人配置不同而出现“我的工具能用、你的不能”。前者把一致性部分交给供应方，后者必须用仓库配置、锁版本和回归测试自己建立一致性。

Codex 的一致性集中在执行语义，而不是客户端成品。终端、IDE 和内部界面可以消费同一类工具事件，这是它相对 Pi 私有 extensions 的优势；但两个客户端若对长输出、批准或取消的处理不同，用户仍会看到不同任务结果。Codex 平台必须测试“同一调用在每个入口怎样呈现”，不能只验证服务端工具真的执行过。

DeepSeek Harness 更适合把工具组合当成可部署 profile，但 profile 越多，比较就越困难。一个 profile 使用本地 Shell，另一个经过远程 transport；一个 registry 暴露数据库写入，另一个只读。相比 Claude Code 的统一默认值，这些差异能精确适配团队角色，也会让故障复现必须携带插件版本、装配关系和策略配置，否则“DeepSeek Harness 出错”几乎没有诊断意义。

工具升级也有四种不同账单。Claude Code 用户要接受内建行为变化并调整 Hooks；Codex 集成者要同步协议和客户端；Pi 团队要修自己的 extension API 与第三方依赖；DeepSeek Harness 团队还可能面对预览期核心插件契约变化。越靠近运行时的工具控制，越需要自动化兼容测试，不能把“源码可改”当作故障已经可控。

假设数据库检查工具返回“失败”，Claude Code 用户首先要判断是内建工具、权限策略还是外部服务问题；若问题发生在产品内部，能修的范围有限，但自行维护的代码也少。Codex 集成者除了检查执行层，还要检查客户端是否丢失、误排或错误渲染事件，故障面比单一官方入口更宽。

Pi 团队可以直接修改 extension，却要自己证明修改没有污染上下文、放宽权限或破坏其他工具。DeepSeek Harness 团队甚至可能需要沿 registry、approval、session log 和 agent loop 追踪同一次调用；可观察性更容易按需求定制，诊断知识却更依赖平台维护者。

这四种成本不能用工具数量表示。Claude Code 的隐藏成本是等待产品边界；Codex 是维护宿主协议；Pi 是维护扩展质量；DeepSeek Harness 是维护插件组合。默认工具越多，越早获得一套可工作的意见；替换面越深，越晚才知道团队是否真有能力拥有它。

选型试验也应故意测试坏路径。让 Claude Code 与 Codex 接收一次超长测试输出，观察截断后是否还能定位失败；让 Pi 的 extension 遭遇超时和非法参数，检查维护者是否给模型留下可行动反馈；让 DeepSeek Harness 的 registry 或 transport 中断，确认日志能否指出故障层。成功演示只证明工具能跑，失败演示才能看出产品默认值和自建责任的分界。

还要比较新增工具所需改动。Claude Code 常从 MCP、Hook 或插件接入，优点是沿既有产品边界落地，短板是受这些入口的生命周期约束；Codex 还要考虑事件如何被各客户端消费。Pi 可以直接写 extension，但要自建发布与兼容规范；DeepSeek Harness 可以替换 registry，却必须验证它与 approval、log、loop 的组合。若一个简单只读工具也要求改动多个运行时层，深度不是优势，而是当前任务不需要的维护面。

所以工具清单只能说明入口，失败路径才说明 Claude Code、Codex、Pi 与 DeepSeek Harness 分别把多少工程工作留给团队。

## 裁决：不要数工具，先找故障责任人

| 产品 | 优势 | 短板 | 代价 | 适合谁 |
| --- | --- | --- | --- | --- |
| Claude Code | 内建工具与交互闭环完整，开箱快 | 内建行为的深层替换空间有限 | 接受产品输出、权限与生命周期边界 | 想直接做任务、不想维护工具框架的团队 |
| Codex | 工具事件可服务 CLI、IDE 与自建宿主 | 集成者还要正确实现事件呈现与恢复 | 维护客户端协议和多入口测试 | 正在建设 Agent 产品入口的团队 |
| Pi | extension 改造直接，领域工具容易贴合 | 工具质量、隔离与升级无人替你兜底 | 长期维护 TypeScript 扩展及其回归 | 有明确特殊工具、愿意维护小核心的团队 |
| DeepSeek Harness | registry、日志与循环可一起重组 | 系统级故障面大，且仍在预览期 | 维护插件图、事件契约和兼容迁移 | 把工具系统本身当作平台能力研究的团队 |

如果现有工具已经覆盖八成任务，Claude Code 或 Codex 的默认值通常比自建更划算；区别在你是否需要自己的宿主。若特殊工具决定业务成败，Pi 给出的改造深度往往已经够用。只有当 registry、日志和循环都必须按团队架构替换时，DeepSeek Harness 的更深控制才不是过度设计。

## 本篇引用来源

- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi coding agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)
- [Pi Extensions](https://pi.dev/docs/latest/extensions)
- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness Core subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)
- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)
