---
title: "Agent主题对比09｜四种 Agent 怎么选：看你愿意承担什么责任"
description: "个人、产品团队、内部平台和运行时研究者不该看同一张功能表；Claude Code、Codex、Pi、DeepSeek Harness 的选择取决于谁承担维护与风险。"
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
  - Claude Code
  - Codex
  - Pi
  - DeepSeek Harness
  - 责任与反转条件
prerequisites:
  - 能描述团队的维护、安全、集成和验证责任
  - 已阅读本系列中与自己风险最高的维度
time: 17 分钟
slug: agent-theme-09-a2a-interoperability
series: agent-theme-comparison
order: 9
---

选型不该问“四者谁最强”，而应问“哪种责任我愿意长期承担”。想把工作流交给成品，先看 Claude Code；想让多个客户端复用执行层，先看 Codex；想拥有一个可塑的小核心，先看 Pi；想重组 provider、loop、session 与 transport，才看 DeepSeek Harness。建议一旦遇到不同责任条件，就应反转。

## 个人开发者：Claude Code 优先，除非你享受维护 Harness

个人开发者通常没有时间同时维护工具、沙箱、会话、扩展和升级矩阵。Claude Code 相比 Pi 与 DeepSeek Harness 的优势，是把最多决定放进成品工作台；相比 Codex，自建客户端协议也不是使用前提。[官方工作原理](https://code.claude.com/docs/en/how-claude-code-works) 所呈现的整合路径更符合“直接完成仓库任务”而不是“先建设运行时”。

Claude Code 的短板是接受产品边界。若你的乐趣或核心需求正是改造 Agent 行为，Pi 的 minimal harness 与 [extensions](https://pi.dev/docs/latest/extensions) 会更直接；若只是想加一个特殊工具，Pi 可能值得，DeepSeek Harness 通常过深。个人选择 DeepSeek Harness，等于自愿把插件图、兼容迁移和外部隔离也变成项目内容。

Codex 会在另一个条件下反转：个人正在开发自己的 IDE、桌面工具或 Web Agent，而不是只使用 Agent。此时 [App Server](https://openai.com/index/unlocking-the-codex-harness/) 的 thread、turn、item 与双向事件比 Claude Code 的成品体验更重要。个人用户选 Claude Code，个人产品作者可能选 Codex；身份相同，任务责任不同，结论就不同。

安全条件还会再次反转。Pi [明确不内建沙箱](https://pi.dev/docs/latest/security)，如果个人没有容器或虚拟机习惯，就不应因“小”而把它当成低风险默认值。Claude Code 与 Codex 提供产品内控制起点，但凭据和外网仍需收窄；DeepSeek Harness 未经安全审计，更不适合把实验性边界当个人主机的最后防线。

## 产品集成团队：Codex 优先，除非产品其实不需要自建入口

要把 Agent 放进 IDE、浏览器、桌面端或内部任务台，Codex 相比 Claude Code 的关键优势是执行层可被客户端驱动，而不是官方界面数量更多。团队可以围绕 thread 和 item 构建自己的审批、进度与 diff 体验；相比 Pi RPC/SDK，又少定义一套最基础的 Agent 执行语义。

Codex 的短板是 App Server 只到“执行层”。身份、租户、任务队列、断线重连、事件去重、业务验收和数据保留仍由产品团队承担。若团队只是想让工程师在终端或官方 IDE 入口使用 Agent，Claude Code 的整合度更省事；为了拥有一个不会真正定制的客户端而选择 Codex，会凭空增加状态机和运维。

Pi 会在宿主非常轻、行为非常特殊时反转。单个 Node 应用想直接访问状态并加载少量内部 extensions，Pi SDK 可能比常驻 App Server 更短；跨语言子进程也可以用 RPC。代价是后台任务、并发、多租户与可靠恢复没有自动出现。一旦产品从单用户本地工具长成服务，Pi 团队很可能开始补 Codex 已经协议化的部分。

DeepSeek Harness 会在“产品需要多个异构 provider 或 transport”时进入候选。它的 [subagent provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md) 与 plugin tree 允许更深重组，但这不是普通 UI 定制的必要条件。若产品差异只在界面和业务流程，Codex 更集中；若产品核心就是运行时组合，DeepSeek Harness 才可能抵消预览期成本。

## 内部平台团队：Pi 与 Codex 的分界在你想拥有哪一层

内部平台若已有容器、凭据代理、任务队列和审计系统，Pi 的许多“缺失”不再是缺陷，而是避免重复建设。它不内建沙箱，正好复用平台硬边界；TypeScript extension 可以把内部工具和规则接进最小核心。相比 Claude Code，平台拥有更多行为控制；相比 DeepSeek Harness，不必立刻拥有完整 loop 与 session 架构。

Pi 的短板是内部扩展会迅速变成私有产品。版本发布、兼容测试、文档、支持轮值和离职交接都要正式化。若平台主要目标是让多个客户端共享可靠任务状态，而不是发明特殊 Agent 行为，Codex 更合适：它把执行协议交付给平台，减少自建核心；Pi 则容易让平台把已有基础设施与新 Harness 代码缠在一起。

Claude Code 也可能胜出：内部平台团队不一定要造平台。如果差异只是一组仓库规则、MCP 工具和 Hooks，Claude Code 的分层扩展已经足够，维护自有 Pi runtime 只是组织惯性。控制权只有在团队会使用、测试并长期负责时才是资产；没人负责的控制权是升级阻塞点。

DeepSeek Harness 的反转条件最严格：平台确实要替换 provider、tool registry、session log、loop 或 transport，并愿意为这些子系统设置 owner。它的 [README](https://github.com/deepseek-ai/deepseek-harness) 明示 developer preview 和破坏兼容变化，[SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) 又说明未经安全审计。没有迁移预算与外部隔离，架构自由不应进入生产关键路径。

## 运行时研究者：DeepSeek Harness 优先，但不能把研究便利写成生产结论

研究者若要比较不同 loop、session、provider 或事件策略，DeepSeek Harness 相比 Claude Code、Codex 与 Pi 暴露更深的可替换面。[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 把模型适配器、工具注册表、会话日志和 Agent loop 都放进插件体系，这让“改变运行时本身”成为直接实验变量。

它的短板正是实验变量太多。profile、插件版本、装配顺序、transport 与安全环境任一变化，都可能污染结果。Claude Code 与 Codex 的固定产品语义在研究深度上受限，却更容易代表真实成品使用；Pi 的小核心可改造，又比完整 plugin tree 少一些混杂因素。研究问题若只是工具界面或一个 extension，Pi 可能是更干净的实验载体。

生产外推必须收紧。DeepSeek Harness 的可追踪和可组合属于公开设计主张，不证明任务成功率、安全性或成本优于 Claude Code、Codex、Pi。[The Scaffold Effect](https://arxiv.org/abs/2607.22585) 只能提醒 Harness 会显著影响受控评测，不能替四个产品排永久名次。研究者应报告精确版本、profile、任务、环境与人工介入。

安全研究也不能让 DeepSeek Harness 自己成为唯一隔离层。Claude Code 与 Codex 的产品沙箱适合比较默认控制，Pi 适合研究外部隔离与最小核心组合，DeepSeek Harness 适合研究可插拔 approval/sandbox 语义；四者的实验对象不同。把未审计预览项目放在宿主凭据旁运行，会让实验先变成事故。

## 五个问题足以让推荐反转

预算分配会暴露真实偏好。Claude Code 把更多预算放在产品使用与团队规则；Codex 把预算移向宿主开发、常驻服务和遥测；Pi 把预算移向 extensions、隔离与内部支持；DeepSeek Harness 把预算进一步移向运行时 owner、兼容矩阵和安全测试。若预算表里只有模型 token，后三种方案的工程成本必然被低估。

试点退出条件也应不同。Claude Code 若高频任务始终撞到不可改变的产品边界，应转向 Codex 或 Pi；Codex 若自建客户端没有带来独特体验，应退回成品入口；Pi 若 extensions 数量和支持请求持续增长，应评估正式平台化；DeepSeek Harness 若没有真正替换核心部件，应该降到更浅的 Harness。控制权没有被使用，就不值得维护。

供应风险与内部风险需要一起看。Claude Code 与 Codex 更依赖供应方产品和协议路线，Pi 与 DeepSeek Harness 更依赖内部维护者与私有代码。前两者要准备数据、规则和工具的迁移接口，后两者要准备文档、测试和人员交接。不存在“完全掌控所以没有锁定”，只有锁定发生在供应方还是自己团队。

谁维护扩展？若答案是“没人”，Claude Code 优先于 Pi 与 DeepSeek Harness；若有小型 TypeScript owner，Pi 进入候选；若有运行时子系统团队，DeepSeek Harness 才成立。Codex 的 owner 不一定写 loop，但必须维护客户端和服务状态。

谁拥有安全边界？依赖产品内控制，Claude Code 或 Codex 更合适；已有容器、身份和网络隔离，Pi 的最小边界更可接受；要研究可插拔控制，DeepSeek Harness 必须放在那层外部隔离之内。任何候选若无法对应具体事故和负责人，都应退出。

谁拥有状态？只需要官方工作台连续性，Claude Code；需要客户端短命、服务端任务持续，Codex；需要单机文件与自定义分支，Pi；需要按 profile 重组 session 与 transport，DeepSeek Harness。多入口不是答案，状态真相源才是。

谁证明完成？使用成熟仓库测试和人工审查，Claude Code 成本最低；建设浏览器、日志、指标与 reviewer 平台，Codex 更有组织空间；验收规则特殊到必须写代码，Pi 更直接；证据事件系统本身是研究对象，DeepSeek Harness 才需要更深控制。

谁承担升级？希望供应方吸收大部分变化，Claude Code；愿意维护客户端适配，Codex；愿意维护 extensions，Pi；愿意维护整个插件图并接受预览期破坏，DeepSeek Harness。选型的本质不是获得多少能力，而是给哪种长期工作签字。

## 裁决：按责任而不是功能结案

| 产品 | 优势 | 短板 | 代价 | 适合谁 |
| --- | --- | --- | --- | --- |
| Claude Code | 整合度最高，最快进入日常仓库任务 | 深层运行时与宿主协议控制有限 | 接受产品边界并维护项目级规则与验收 | 个人开发者、应用团队、无需自建入口的组织 |
| Codex | 执行语义可供多个客户端与工作流复用 | 平台最后一公里、状态治理和业务验收仍需自建 | 维护 App Server 服务、客户端与遥测 | Agent 产品集成团队、内部任务平台 |
| Pi | 小核心可塑，容易复用既有隔离与写专用扩展 | 成品治理少，私有 extension 容易形成维护债 | 建立扩展发布、安全、恢复和支持制度 | 有明确特殊流程与长期 owner 的小型平台团队 |
| DeepSeek Harness | provider、loop、session、transport 可深度重组 | developer preview、破坏兼容且未经安全审计 | 外部隔离、插件矩阵、迁移与研究纪律 | 运行时研究者、确实建设异构 Harness 的平台团队 |

默认顺序可以很简单：使用者先试 Claude Code，产品集成先试 Codex，工作流所有者再看 Pi，运行时所有者最后看 DeepSeek Harness。只要你的责任条件不同，就按上面的反转条件改选；不要用一张功能勾选表替团队签下多年维护承诺。

## 本篇引用来源

- [Claude Code：How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [OpenAI：Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi：Extensions](https://pi.dev/docs/latest/extensions)
- [Pi：Security](https://pi.dev/docs/latest/security)
- [DeepSeek Harness：Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness：Subagent subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)
- [DeepSeek Harness：README](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness：Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
- [The Scaffold Effect](https://arxiv.org/abs/2607.22585)
