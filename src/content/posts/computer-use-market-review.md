---
title: "Computer Use 的市场版图与体验鸿沟：闭源、开源、Agent Harness 及协作模式综述"
published: 2026-08-25
updated: 2026-08-25
description: "系统比较闭源、开源与混合 computer-use 项目，解释 Codex/Claude Code 的体验优势、开源落差，以及 computer-use 与 Agent 的协作架构。"
tags: ["computer-use", "ai-agent", "codex", "claude-code", "open-source"]
category: "AI / Architecture"
draft: false
image: ""
slug: "computer-use-market-review"
difficulty: "advanced"
time: "60 min"
---

# Computer Use 的市场版图与体验鸿沟：闭源、开源、Agent Harness 及协作模式综述

> 研究日期：2026-08-25。本文把“computer-use”理解为让模型通过屏幕、鼠标、键盘或浏览器动作完成数字任务的执行能力，同时把浏览器专用代理、桌面 GUI 代理和 Codex/Claude Code 这类 Agent harness 分开比较。

## Executive Summary

Computer-use 不是一个单一品类，而是三层系统的组合：负责看屏幕并产生动作的模型/执行器，负责浏览器、桌面、虚拟机和权限的运行时，以及负责任务分解、工具路由、恢复、审批和结果验证的 Agent harness。市场上的闭源产品通常把三层一起交付；开源项目往往只开放其中一层，因此“能跑 demo”与“可长期使用”之间存在明显落差。

第一，闭源产品的优势不是单纯来自模型分数，而是来自完整闭环。OpenAI CUA 把视觉理解、推理和强化学习结合起来，并在 2025 年公开报告了 OSWorld 38.1%、WebArena 58.1%、WebVoyager 87.0% 的结果 [1]；Anthropic、Google 和 Microsoft 的 API 都要求应用实现“截图—动作—执行—新截图”的循环 [3][9][10]。这说明 computer-use 本身只是一个动作建议器，稳定性取决于外部 harness。

第二，最成熟的产品都把屏幕控制放在精确工具之后。Claude Code 明确先尝试 MCP、Bash 和 Chrome，只有其他手段够不到时才使用最宽泛、最慢的 computer use [4]。这也是 Codex、Claude Code 体验优于许多开源“全屏点击代理”的核心原因：它们首先在文本、代码、API 和结构化工具空间解决问题，再把视觉操作当作最后一公里。

第三，开源并不等于能力弱。UI-TARS、Agent S2、UFO²/UFO³、OpenHands、Browser Use、Skyvern 和 OpenAdapt 分别在原生 GUI 模型、专用 grounding、应用级多 Agent、代码型 Agent、浏览器自动化、视觉工作流和演示编译方面形成了强项 [13][15][16][18][20][23]。开源的主要问题是体验责任被拆散：模型、浏览器、VM、凭据、网络、日志、回放、评测和安全策略需要使用者自行拼装。

第四，computer-use 应被视为 Agent 的执行器，而不是 Agent 本身。推荐的架构是“规划 Agent → 工具路由器 → 精确 API/DOM/CLI → computer-use 兜底 → 状态验证器 → 结果提交”，并在每个有副作用的动作前后保留审批和证据。长任务要有 checkpoint、可重入状态和人类接管；对于重复流程，应考虑 OpenAdapt 这类“先录制/编译，健康路径零模型调用，漂移时验证和停机”的方法 [23]。

**主结论：** 评价 computer-use 不能只看“会不会点击”，而要看它能否在正确的工具层完成任务、在不确定时停下、在失败后恢复、在副作用前征得授权、在结束时给出可审计的结果。

**置信度：** 高。产品能力和 benchmark 数字以官方文档、论文和仓库为依据；关于体验差异、商业闭源优势和开源落差的部分，是基于多来源架构证据形成的综合判断，已明确标注推断边界。

## Introduction

### Research Question

本文回答五个相互关联的问题：市面上有哪些有代表性的闭源、开源和混合 computer-use 项目；它们分别做得好和不好的地方是什么；用户实际体验为何不同；Codex 与 Claude Code 为什么常常比“直接截图点击”的开源项目更好用；以及 computer-use 应该怎样与 Agent 的规划、工具、权限和验证系统协作。

### Scope & Methodology

研究范围覆盖浏览器代理、桌面 GUI 代理、移动端代理、模型 API、Agent harness、浏览器基础设施和评测基准。项目按“闭源商业服务、开源执行器/框架、混合产品、研究/评测基础设施”分类，而不是简单按公司或模型分类。这样可以避免把 BrowserGym 这种研究环境、UI-TARS 这种原生 GUI 模型、OpenHands 这种代码 Agent 和 Operator 这种完整产品放进同一维度直接排名。

资料来自 32 个来源，包括 OpenAI、Anthropic、Google、Microsoft、AWS 的官方文档和系统卡，Browserbase、Browser Use、Skyvern、ByteDance、OpenHands、OpenAdapt、Open Interpreter 等开源仓库，以及 OSWorld、WebArena、AndroidWorld、Windows Agent Arena、OSWorld-Human、OS-Harm 和 VPI-Bench 等评测或安全研究。所有来源和证据分别保存在本报告目录的 `sources.jsonl` 与 `evidence.jsonl` 中。报告中的 [N] 对应同目录的来源编号。

### Key Assumptions

- “体验更好”指完成同一任务时的成功率、等待时间、操作次数、打扰程度、可恢复性、透明度和安全边界的综合表现，不等同于 benchmark 单项最高分。
- “闭源”指模型或托管运行时不开放；混合项目可能开放 SDK/Agent，但把浏览器集群、身份、反爬、可观测性或更强模型作为商业服务。
- Codex 和 Claude Code 的主要定位是软件工程 Agent，而不是纯 GUI agent；因此比较重点是它们如何把 computer-use 放入更大的 harness，而不是断言它们在所有视觉 benchmark 上都领先。
- 评测数字只能在相同模型、动作空间、步数预算、环境版本和验证器一致时横向比较。厂商自报结果与第三方 benchmark 不应混为同一证据等级。

## Main Analysis

### Finding 1：Computer-use 的真正产品形态是“模型 + 执行环境 + Harness”，不是一个会点击的模型

最小的 computer-use loop 看起来很简单：把当前截图和任务描述发给模型，模型返回点击、输入、滚动或等待动作，执行器在浏览器或桌面上执行，再把新截图传回模型。Anthropic、Google 和 Microsoft 的官方文档都把这一循环作为 API 的基本责任边界 [3][9][10]。模型并不直接拥有鼠标，也不自动知道动作是否真正生效；动作执行、屏幕采集、坐标缩放、错误处理、停止条件和安全确认都在调用方。

因此，实际系统至少有四个状态：用户意图、模型计划、环境状态和可提交结果。只把最后一个动作返回给模型，会让系统在页面未加载、弹窗遮挡、焦点丢失、权限变化或动作部分成功时继续“猜”。可靠的 harness 会在动作前记录意图，在动作后读取结构化状态或截图，在关键步骤使用独立验证器，并在不确定时暂停，而不是让模型用更多截图覆盖不确定性。

OpenAI 的 CUA 说明了模型层的进步：它把 GPT-4o 的视觉能力与推理和强化学习结合，用图形界面上的按钮、菜单和文本框作为通用交互面 [1]。但同一产品的系统卡也明确承认，非浏览器环境仍容易出现模型错误，API 版本的 OSWorld 表现只有 38.1%，并建议人类监督 [2]。这两个事实并不矛盾：模型已经能覆盖大量界面，但“通用视觉动作”仍不是“可靠的业务流程执行”。

从工程角度看，动作空间越接近屏幕像素，通用性越高，状态可观测性越差。DOM、Accessibility Tree、UIA、Win32、原生 API、CLI 和结构化函数调用可以直接表达“哪个元素、哪个字段、什么值”；像素点击只能表达“坐标附近看起来像目标”。反过来，像素路径不依赖页面是否提供 API，能触达遗留软件、原生桌面、远程桌面和设计工具。因此最佳系统不是在 DOM 与视觉之间二选一，而是根据任务和可用接口做路由。

**综合判断：** computer-use 的核心竞争力不是动作函数数量，而是 harness 能否维护环境状态、选择合适的动作媒介，并把模型的局部判断嵌入可暂停、可验证、可恢复的控制循环。

### Finding 2：市场不是“闭源 vs 开源”二元对立，而是四种定位的组合

下表按实际交付边界整理主要项目。项目之间有重叠，但不应当把研究框架、模型、SDK 和面向终端用户的产品直接排成一条总榜。

| 项目/产品 | 开放性与定位 | 执行媒介 | 做得好的地方 | 主要短板/边界 |
|---|---|---|---|---|
| OpenAI CUA / Operator lineage | 闭源模型与产品/API | 截图、鼠标、键盘；浏览器/桌面 | 通用 GUI 动作、产品化安全和统一模型路线；官方报告了 WebArena/WebVoyager/OSWorld 结果 [1][2] | OS 与非浏览器仍不稳定；API 需要开发者自建执行循环，且提示注入和规模化误操作风险高 [2] |
| Anthropic Computer Use API | 闭源模型工具 | 虚拟显示、截图、鼠标键盘；可配 Bash/Text Editor | API 边界清晰，工具结果回填协议明确，适合组合工具 [3] | 需要调用方提供 VM/容器和动作执行器；截图、坐标、分辨率和等待会带来额外工程负担 [3] |
| Claude Code / Cowork computer use | 闭源产品内的受控屏幕能力 | MCP、Bash、Chrome 优先，computer use 兜底 | 同一会话中写代码、构建、启动、点击和截图；按应用审批并能随时停止 [4] | 研究预览、平台/套餐限制；屏幕控制仍慢于精确工具，真实桌面权限不等于沙箱 [4][5] |
| Gemini Computer Use / Project Mariner lineage | 闭源模型/API | 截图—UI action—截图；浏览器优先，逐步扩展到移动/桌面 | 低延迟、动作空间和安全决策由 API 统一提供；支持提示注入检测配置 [8][9] | 仍是 preview；不同模型和环境版本变化快，桌面通用性和调用方执行责任仍在建设中 [8][9] |
| Microsoft Foundry computer-use-preview | 闭源云服务 | 应用执行截图中的点击、输入、滚动 | 与 Agent Framework、SDK 和区域部署结合；明确区分 DOM 自动化与 raw pixels [10] | preview、需要申请和部署；模型只提议动作，安全和执行环境由应用承担 [10] |
| Amazon Nova Act | 闭源 AWS 服务 | 浏览器 UI + Python 编排 | 面向可管理的 UI workflow fleet，提供 playground、SDK、IDE/CLI 等开发体验 [11] | 主要是 Web workflow，不是本地通用桌面控制；服务、模型与账号体系绑定 AWS |
| Browserbase + Stagehand | 混合：Stagehand 开源，Browserbase 托管 | Playwright/CDP、自然语言浏览器动作 | 把浏览器会话、身份、录制、可观察性、扩容与 Agent SDK 组合起来 [12] | 最佳体验依赖托管基础设施；自托管时需自行处理浏览器集群、登录态和反爬 |
| Browser Use | 混合：开源 Agent + Cloud | 浏览器状态、元素索引、截图、CDP | 自托管自由度高，Cloud 提供持久文件系统、记忆、集成、隐身和规模化 [13] | 开源版与 Cloud 版不是同一体验；复杂任务和高并发的基础设施成本会回到用户 |
| Skyvern | 开源 AGPL + 商业 Cloud | Playwright + 视觉 LLM + AI actions | 不依赖固定 XPath，能对未见网站做视觉映射，并提供可视化 workflow [14] | 更偏浏览器业务流程，不是通用桌面 Agent；AGPL 与商业云边界需要组织评估 |
| UI-TARS Desktop | Apache-2.0 的原生 GUI Agent 栈 | 屏幕截图、鼠标、键盘；浏览器/桌面/移动 | 原生视觉模型、统一动作空间、真实本地控制、跨平台体验和本地处理 [15][16] | 本地模型/硬件、模型版本和桌面环境差异会影响体验；生产级权限、身份和长任务治理仍需集成 |
| Agent S2 | 开源研究框架 | 通用/专用模型、grounding、规划、GUI action | 用通用模型与专用模型组合，针对 grounding 和长程规划优化 [17] | 更像可复现实验架构，不是开箱即用的终端产品；结果依赖模型、prompt 和 benchmark 环境 |
| UFO²/UFO³ | MIT 开源 Windows AgentOS | UIA、Win32、WinCOM、GUI 与 API 混合 | HostAgent、应用专用 AppAgent、知识 substrate、虚拟桌面和 speculative execution [18][19] | Windows 生态专长明显，跨平台能力和安装/调试成本不等于闭源云产品 |
| OpenHands | MIT 开源代码 Agent 平台 | CodeAct、Bash、Python、浏览器、sandbox | 把代码、命令行、网页和沙箱组合成通用开发 Agent，并支持 SDK/CLI/GUI/Cloud [20][21] | 核心优势在 software engineering，不是原生像素 GUI；浏览器和桌面能力需要额外适配 |
| OpenAdapt | 开源演示驱动自动化 | 录制示范、视觉 grounding、编译/回放、验证 | 把重复流程从每次自由推理转成可验证的确定性程序，支持漂移时停机 [23] | 适合重复业务流程，不适合完全开放式探索；录制、认证和流程维护有前期成本 |
| BrowserGym / OSWorld / Windows Agent Arena | 开源研究与评测基础设施 | 浏览器/VM/桌面环境和执行验证 | 让任务、环境、动作、截图、录像和结果可复现 [22][26][28] | BrowserGym 明确不是消费产品 [22]；部署和基准迁移成本高，分数不等于真实生产成功率 |

这张表显示了一个常被忽视的事实：闭源产品的“产品能力”通常是模型、执行环境、账号登录、权限、安全分类器、回放和 UI 一起交付；开源项目则更容易只交付模型或 Agent loop。开源的技术上限可以很高，但默认体验不一定高，因为用户被迫成为平台工程师。

### Finding 3：闭源产品体验更好，主要是因为它们优化了“工具路由、等待和恢复”，不只是模型更强

Claude Code 的官方定位非常值得作为整个行业的设计样本：它把 computer use 视为最宽泛、最慢的工具，优先使用 MCP、Bash 和 Chrome [4]。这条路由策略解决了三个问题。第一，结构化工具比像素点击更快；第二，API 调用的结果更容易验证；第三，动作更容易绑定到精细权限。例如，获取日历数据应走连接器，读取仓库应走文件工具，执行测试应走 Bash，只有 GUI-only 的模拟器、原生应用和专有软件才进入屏幕控制。

Codex 的优势具有相似结构。Codex CLI 把探索、计划、编辑、运行本地工具、审批、恢复和 review 放进一个终端回合；Codex app-server 又把 thread、turn、item、delta、approval 和 completion 通过协议暴露给 IDE 等宿主 [6][7]。这让 UI 不必猜 Agent 当前在做什么，也不必把“模型输出的一段文本”解析成所有状态。用户能看到命令、diff、审批请求和最终结果，宿主能在同一个 turn 里接收中断、继续和状态更新。

Claude Code 的权限系统也不是单一的“允许/拒绝”。它把工具规则、项目目录、网络域名、sandbox 和多种 permission mode 组合起来；文档明确区分了决策层权限与 Bash 的 OS 级隔离 [5]。这会把风险提示变成工作流的一部分，而不是任务失败后才弹出一个模糊错误。Codex app-server 也把命令和文件变更审批建模成带 threadId、turnId 和 itemId 的协议事件 [7]。这类设计会降低 prompt fatigue：低风险动作可以在明确边界内自动执行，高风险动作仍能精确回到用户面前。

另一个体验差异是“等待”。截图型 Agent 必须等待页面渲染、动画、网络请求、权限对话框和新截图；如果没有显式的等待策略，模型会在旧画面上重复点击。成熟产品会把等待、重试、取消、锁、应用隐藏、截图缩放和 session 互斥做成产品逻辑。Claude Code 的 computer-use 文档甚至明确说明一次只能有一个会话控制屏幕、屏幕会缩放、应用可能被隐藏 [4]。这些不性感的细节，恰恰是用户感知到“稳不稳”的来源。

因此，“Codex/Claude Code 为什么体验更好”的准确答案不是“它们拥有神奇的 computer-use 模型”，而是：它们服务于更窄、更可验证的任务；它们把代码/终端/连接器作为第一执行面；它们有成熟的权限、session、事件、diff、checkpoint 和恢复机制；它们把视觉控制限制在真正需要它的地方。这个结论是对官方架构的综合推断，而不是对所有任务或所有版本的绝对排名。

### Finding 4：开源项目的弱点是系统工程与责任边界，不是缺少优秀算法

开源研究已经提供了几条清晰的提升路径。UI-TARS 选择 native GUI agent，把截图感知、统一动作、System-2 推理和反思轨迹训练放进模型本身 [16]。Agent S2 进一步把通用规划、专用 grounding 和层级计划拆开，在论文报告的配置下，较 Claude Computer Use 和 UI-TARS 等基线获得相对提升 [17]。UFO² 则在 Windows 上走应用专用 Agent、原生 API、UIA/Win32/WinCOM、知识检索和 speculative executor 的组合路线 [18][19]。这些项目说明开源并不必然停留在“把截图发给通用模型”。

浏览器方向同样如此。Skyvern 用视觉 LLM 与 Playwright 结合，减少对固定 XPath 的依赖 [14]；Browser Use 同时提供自托管 Agent 与 Cloud，Cloud 端补充持久化、集成、隐身浏览器和扩容 [13]；Stagehand 把自然语言动作放在可读的浏览器 SDK 之上，而 Browserbase 提供会话、身份、回放和基础设施 [12]。开源项目常常在“可定制、可本地化、可替换模型、能进入代码库”方面优于闭源产品。

问题在于，用户体验不是单一仓库的 README 能交付的。开源使用者经常需要自己完成：选择多模态模型；解决坐标与屏幕 DPI；启动 Xvfb、Docker、VM 或 Windows 虚拟桌面；保存登录态；处理浏览器反爬；配置网络代理；设计安全确认；录制轨迹；清理截图和凭据；实现任务成功判定；维护 benchmark 环境。OpenHands 论文与文档显示，sandbox、Agent、代码执行和评测是一个完整平台问题 [20][21]；BrowserGym 甚至直接声明它不是消费产品 [22]。这不是开源项目“做得差”，而是它们把产品化责任留给了集成者。

开源还面临三个结构性约束。其一，原生 GUI 模型训练需要大量高质量的截图—动作—结果轨迹，且不同系统、应用和分辨率分布极不均匀；UI-TARS 论文把数据与反思训练视为主要工作之一 [16]。其二，本地模型受显存、量化和推理延迟限制，长任务中的每一步等待会比云服务更明显。其三，安全与体验互相牵制：放宽权限可以减少打扰，但一次误点击就可能读写错误文件或提交不可逆操作；Open Interpreter 的安全说明正是把“本地执行生成代码”视为高风险边界 [24]。

**综合判断：** 开源项目真正的竞争力在于透明、可组合、可私有化和可研究；它们不够好用，往往不是因为没有模型创新，而是因为默认安装路径没有把“运行时、权限、结果验证和长期运维”打磨成一个产品。

### Finding 5：各类 computer-use 做得好的地方和不好的地方，取决于它们服务的任务

闭源通用 CUA 适合“我不想编写集成代码，只想让系统完成一个跨网站或跨应用任务”。它把模型、浏览器或桌面环境、认证和安全流程打包，短任务的上手成本低。缺点是用户很难知道模型为什么选某个动作，无法完全控制模型、prompt、轨迹和数据保留，且每一步视觉调用成本较高。对于涉及支付、账号、敏感文件或外部发送的任务，产品的确认机制必须可信，用户仍应把它当作受监督的自动化，而不是无人驾驶。

浏览器专用 Agent 适合 Web 业务流程：表单、后台系统、发票、招聘、数据录入和跨网站检索。DOM/Accessibility Tree 或 CDP 能提供比全桌面截图更精确的元素状态，持久化浏览器和身份系统又能显著减少重复登录。缺点是登录态、验证码、反爬、动态网页、跨域弹窗和下载上传会把“网页任务”变成基础设施任务。Browser Use、Stagehand、Skyvern 通过托管浏览器或视觉 AI actions 缓解了这些问题，但这也意味着其最佳体验通常不等于完全自托管体验 [12][13][14]。

原生桌面 Agent 适合没有 API 或网页 DOM 的应用：设计工具、Office、模拟器、硬件控制面板、远程桌面和遗留系统。UI-TARS 通过原生截图模型和统一动作空间降低了接入门槛，UFO² 通过 Windows 原生控制树与 API 混合提升了效率 [15][16][18]。缺点是屏幕状态更加脆弱：分辨率、DPI、窗口焦点、通知、动画、遮挡和多显示器都会改变动作含义。它对 sandbox 的要求也更高，因为“能看屏幕”通常意味着能接触真实桌面；Anthropic 的文档明确提醒 computer use 与 Bash sandbox 的信任边界不同 [5]。

代码型 Agent 和 GUI Agent 并非互斥。OpenHands 的 CodeAct 把动作收敛到代码、命令行和浏览器，使 Agent 能用脚本做批量处理、数据转换和测试 [20][21]。Codex/Claude Code 则把 GUI 作为验证和补缺工具：代码先写出来，应用先构建，只有视觉行为需要确认时才点击。这种路径的优点是每次动作都能留下 diff、命令、日志和测试结果；缺点是它对任务类型有偏好，纯桌面操作或没有代码入口的工作仍需要原生 computer-use。

演示驱动和确定性自动化适合高频、重复、后果明确的流程。OpenAdapt 的思路是把一次人的演示编译成受治理的程序，在健康路径不反复调用模型，界面漂移或验证失败时停下来请求修复 [23]。它牺牲了开放式探索换取成本、延迟和可审计性，是企业流程里常被忽视但非常现实的路线。

### Finding 6：评测已经显示“能完成”不等于“高效、稳健、可信”

OSWorld 以 369 个真实 Web/桌面/文件系统任务衡量多模态 Agent [25]，并提供 VM、截图、动作、录像和执行验证 [26]。WebArena 早期结果显示，最好的 GPT-4 Agent 端到端成功率只有 14.41%，人类是 78.24% [30]；AndroidWorld 的基线 M3A 在 116 个任务中完成 30.6%，而且论文指出桌面 Web Agent 迁移到移动端后效果下降 [29]。这些数字共同说明：界面控制具有强烈的环境和平台依赖，不能用一个浏览器 demo 推断桌面通用能力。

效率更是另一条轴。OSWorld-Human 对 16 个 Agent 的分析发现，即使是高分系统，也要用必要步骤的 1.4–2.7 倍 [27]。这意味着用户感受到的“慢”和“笨”可能来自多余观察、重复点击、错误恢复和不必要的工具调用，而不是最终是否完成。一个 70% 成功率但需要 40 步和 3 分钟的系统，未必比 65% 成功率、8 步、30 秒且能可靠重试的系统更适合生产。

安全评测进一步拉开了“能力”和“可用”的差距。OS-Harm 将误用、提示注入和模型行为风险放进 150 个桌面任务；VPI-Bench 用 306 个测试案例评估视觉上嵌入恶意指令的攻击面 [31][32]。OpenAI、Anthropic 和 Google 都在官方材料中强调提示注入、确认和隔离，但它们提供的是风险降低，不是风险消除 [2][3][9]。用户必须假设网页文字、图片、邮件和文档都可能包含诱导 Agent 改变目标的内容。

因此推荐至少使用五个指标评测一个 computer-use 系统：任务成功率、单位任务的动作数/延迟、错误后的恢复率、在副作用前正确请求确认的比例，以及提示注入/越权/数据外泄的安全表现。还应固定模型、环境版本、窗口大小、登录态、步数预算和成功判定，否则不同项目的数字没有可比性。

### Finding 7：Computer-use 与 Agent 的最佳协作方式是分层路由，而不是让一个模型包办所有动作

一个生产级协作模型可以写成下面的控制流：

```text
用户目标
  ↓
规划 Agent：拆分目标、识别副作用、确定完成条件
  ↓
工具路由器：MCP/API → CLI/代码 → DOM/UIA/CDP → computer-use
  ↓
执行器：在 sandbox/VM/浏览器会话中执行一个最小动作
  ↓
状态采集：结构化结果 + 截图 + 日志 + 当前 URL/窗口/文件状态
  ↓
验证器：检查目标状态、权限、业务约束和证据
  ├─ 通过 → 继续或提交结果
  ├─ 可恢复 → 重试、回滚、切换工具
  └─ 不确定/高风险 → 暂停并交给用户
```

第一层是意图和计划。规划 Agent 不应该直接拥有所有副作用工具，而应输出任务分解、数据边界、成功条件、需要确认的动作和允许的工作区。第二层是路由器，它根据目标对象选择精确媒介：查询 CRM 走 API，修改仓库走文件/命令，浏览器表单优先 DOM/CDP，原生应用或视觉验证才用 computer-use。Claude Code 的 MCP/Bash/Chrome/computer-use 顺序已经把这一原则产品化 [4]。

第三层是专用执行器。可以让视觉模型只负责 grounding 和低层动作，让主 Agent 负责计划、解释和恢复；也可以让应用专用 AppAgent 处理某个软件，把全局 HostAgent 留给跨应用编排。UFO² 的 HostAgent/AppAgent 结构和 Agent S2 的 generalist/specialist 组合都支持这一方向 [17][18]。这样做的好处是降低每个模型的上下文复杂度，缺点是增加状态同步和身份传播的工程难度。

第四层是验证器。不要把模型的“我已经完成了”作为成功信号。对表单要检查提交后的记录，对文件要检查内容和路径，对 UI 流程要截图关键状态，对外部消息要记录目标、正文、发送结果和回执。OpenAdapt 以证据契约和不确定时停机为核心的做法，说明验证可以成为运行时的一等公民 [23]。

第五层是人类接管。高风险动作包括支付、删除、发邮件、修改权限、接受法律条款、提交生产部署和访问敏感数据。接管不应只是一颗“停止”按钮，还应该携带当前截图、动作意图、影响范围、可逆性和下一步选项。Codex app-server 的带上下文审批事件是一个值得借鉴的协议形态 [7]。

### Finding 8：真正的产品护城河是“可治理的长期运行”，而不是一次性 demo

短任务可以依靠一个强模型和几条提示词完成；长任务需要 session、checkpoint、重试预算、幂等性、回放和观测。浏览器集群要保存登录态但不能泄露凭据；桌面 Agent 要隔离窗口和输入设备；工具要区分只读、可逆写入和不可逆副作用；每个动作要能定位到用户、thread、turn、item 和环境。没有这些，系统即使完成率不错，也难以进入团队协作和生产运维。

闭源产品把这些能力作为服务的一部分，因而用户看到的是一条顺滑的“输入—执行—结果”路径；开源项目把它们拆成插件、Docker、VM、MCP、浏览器云和自定义脚本，因而拥有更大的控制权，但也承受更高的集成成本。Browserbase、Browser Use Cloud、OpenHands Cloud 和 Nova Act 的共同方向，都是把运行时和 Agent 控制平面托管起来 [11][12][13][20]。这说明商业化并不只是在卖模型调用，而是在卖可信的执行环境与运维体验。

未来的分水岭可能不是“谁能直接控制电脑”，而是谁能在工具精度、操作速度、权限细度、状态验证、用户接管和成本之间形成可配置的策略。视觉模型仍会变强，但如果每一步都必须发送完整截图、等待模型、执行像素动作再验证，成本与延迟会限制使用场景。更成熟的系统会让模型写出少量可验证代码、调用结构化 API、只在必要时使用视觉 grounding，并在重复任务中把推理编译成确定性流程。

## Synthesis & Insights

### Patterns Identified

**模式一：入口开放，运行时收费。** Browser Use、Stagehand、Skyvern 和 OpenHands 都展示了“开源 Agent/SDK + 托管浏览器或云环境”的组合 [12][13][14][20]。这是合理的商业结构，因为模型和代码可以开放，真正昂贵且难以复制的是浏览器集群、代理网络、身份、日志、隔离、并发和支持。

**模式二：精确工具与视觉工具会长期共存。** DOM、API、CLI 和 UIA 提供精度和验证；截图提供跨应用、跨平台和遗留系统兼容性。Claude Code 的工具路由、Microsoft 对 DOM 与 raw pixels 的区分、UFO² 的 GUI/API 混合都指向同一个答案 [4][10][18]。

**模式三：Agent 的“聪明”越来越依赖 harness。** UI-TARS 和 Agent S2 通过 native model、grounding、specialist 和层级计划提高低层能力 [16][17]；Codex、Claude Code 和 OpenHands 通过协议、权限、sandbox、上下文和代码工具提高整体可用性 [5][6][7][20][21]。同一个基础模型放进不同 harness，用户感受到的成功率、速度和安全边界可能完全不同。

### Novel Insights

第一个推断是：computer-use 的最佳抽象不是“一个大工具”，而是一个**可降级执行平面**。理想路径是 API/DOM/CLI，次优路径是原生可访问性树或 CDP，最后才是截图点击；每一次降级都应带来更高的审批等级和更严格的验证。这样既获得通用性，也避免把所有任务都付出像素级的时间和 token 成本。

第二个推断是：开源项目要提升体验，优先级不应只是换更大的 VLM，而应先补齐“默认运行时”。一个开源产品只要做到一键创建隔离环境、持久 session、可视化回放、结构化事件、精确审批、结果验证和失败恢复，即使模型分数不是最高，日常体验也可能超过只提供更强模型的项目。

第三个推断是：Agent 协作的关键不是增加更多 Agent，而是限制每个 Agent 的副作用边界。规划 Agent 可以读和分解，工具路由器可以选择媒介，computer-use worker 可以控制屏幕，但不能自行改变目标；验证器可以否决结果，审批器可以要求人类确认。多 Agent 只有在角色、消息、身份、队列和失败语义清晰时才会改善体验，否则只是把一条难以调试的 loop 变成多条难以调试的 loop。

### Implications

对个人开发者，最实用的组合通常是：代码/文件任务交给 Codex 或 Claude Code；浏览器重复任务使用 Browser Use、Stagehand 或 Skyvern；原生 GUI 或模拟器验证使用 Claude Code computer use、UI-TARS 或 UFO；高频固定流程则录制/编译成确定性工作流。不要把纯视觉 Agent 当作所有任务的默认入口。

对企业，真正的选型问题是信任边界：数据是否能出本机、登录态放在哪里、浏览器是否隔离、是否需要 Windows 原生能力、谁维护 VM、谁对错误操作负责、是否有逐步审计和回放。闭源云产品降低了集成成本，但需要接受供应商的模型、数据和服务边界；开源方案提高控制力，却必须投入平台工程和安全评测。

对开源社区，最值得补齐的不是又一个聊天 UI，而是统一的 action schema、事件协议、权限模型、环境 manifest、回放格式、成功验证器和跨 benchmark 的可比报告。只有这些基础设施成熟，模型创新才能转化为稳定的用户体验。

## Limitations & Caveats

### Counterevidence Register

第一，不能把“闭源体验好”理解成闭源模型在所有 benchmark 上都领先。UI-TARS、Agent S2 和 UFO² 的论文报告了开源系统在特定 benchmark、平台和配置下超过商业基线的结果 [16][17][19]。这说明开放研究可以在专用数据、grounding、规划或平台集成上取得优势；本文关于闭源体验的判断主要针对默认产品完成度，不是模型能力总榜。

第二，不能把 GitHub star、厂商自报 benchmark 或单次 demo 视为生产可靠性。Browser Use 的 Cloud 与开源 Agent 具有不同基础设施，OSWorld 版本也在持续修订 [13][26]。比较时必须记录模型版本、步数、环境、提示、成功判定和是否有人类介入。

第三，安全防护仍然不是已解决问题。官方文档提供确认、分类器、提示注入检测和隔离建议，但 OS-Harm 与 VPI-Bench 表明攻击面需要独立评测 [2][9][31][32]。任何允许访问真实账号、邮件、支付、生产环境或私有文件的 Agent，都不应仅依赖系统 prompt 作为安全边界。

### Known Gaps

本研究没有在同一台机器、同一个账户、同一个任务集上实测所有产品，因此没有给出统一的“谁最好”分数；商业产品的内部延迟、失败率、模型路由和数据保留策略也无法完全从公开资料获得。2026 年的产品更新速度很快，部分页面仍标为 preview，产品名称、模型版本和套餐可用性可能变化。

此外，真实工作中的成功条件常包含隐含状态，例如“发给正确的人”“不要重复创建”“保留原格式”“只改当前项目”。公开 benchmark 的二元成功率无法充分表达这些约束。下一步最有价值的实验是固定一个任务集，分别测 API/DOM/CLI/视觉路由、动作数、等待时间、恢复率、人工接管次数、越权尝试和最终证据完整度。

## Recommendations

### For users choosing a product

1. 先按任务选执行媒介：代码/数据/API 优先，浏览器专用任务次之，原生 GUI/遗留应用才使用全屏 computer-use。
2. 如果要快速落地，优先选择闭源或混合产品提供的托管运行时；如果数据主权、可替换模型或本地部署更重要，再选择 UI-TARS、UFO、OpenHands、Browser Use、Skyvern 或 OpenAdapt 等开源路线。
3. 不要只问“成功率多少”，还要问平均动作数、端到端延迟、失败是否自动恢复、登录态和截图如何保存、能否逐步审批、是否支持回放和结果验证。

### For teams building an Agent

1. 先实现工具路由器和验证器，再接入 computer-use；把 API/DOM/CLI 当作主路径，把视觉动作当作降级路径。
2. 为每个动作声明只读/可逆/不可逆、目标资源、凭据范围、网络范围和是否需要用户确认。
3. 使用隔离 VM 或容器；真实桌面控制要单独评估屏幕、输入设备、剪贴板、窗口、凭据和本机文件的信任边界。
4. 把 screenshot、action、result、approval、error、retry、checkpoint 和 final evidence 记录成结构化事件，而不是只保存聊天文本。
5. 对重复流程使用演示编译或确定性 workflow；让模型处理漂移和异常，让验证器决定是否允许继续。

### For open-source projects

开源项目若要缩小与闭源产品的体验差距，建议按以下顺序投入：一键隔离环境；持久化 session；统一事件和动作 schema；分层审批；默认结果验证；可视化回放；跨平台环境 manifest；再是更大模型和更多 demo。这样能把“用户需要自己搭平台”的成本，转化为项目的默认能力。

## Bibliography

[1] OpenAI (2025). "Computer-Using Agent". OpenAI. https://openai.com/index/computer-using-agent/
[2] OpenAI (2025). "Operator System Card". OpenAI. https://openai.com/index/operator-system-card/
[3] Anthropic (2026). "Computer use tool - Claude Platform Docs". Anthropic. https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
[4] Anthropic (2026). "Let Claude use your computer from the CLI". Claude Code Docs. https://code.claude.com/docs/en/computer-use
[5] Anthropic (2026). "Configure permissions". Claude Code Docs. https://code.claude.com/docs/en/permissions
[6] OpenAI (2026). "Codex CLI". ChatGPT Learn. https://learn.chatgpt.com/docs/codex/cli
[7] OpenAI (2026). "codex-app-server". GitHub. https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
[8] Google DeepMind (2025). "Introducing the Gemini 2.5 Computer Use model". Google Blog. https://blog.google/innovation-and-ai/models-and-research/google-deepmind/gemini-computer-use-model/
[9] Google (2026). "Computer use | Gemini API". Google AI for Developers. https://ai.google.dev/gemini-api/docs/generate-content/computer-use
[10] Microsoft (2026). "Use the computer use tool for agents". Microsoft Learn. https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/computer-use
[11] Amazon Web Services (2026). "Amazon Nova Act Documentation". AWS. https://docs.aws.amazon.com/nova-act/
[12] Browserbase (2026). "Stagehand". GitHub. https://github.com/browserbase/stagehand
[13] Browser Use (2026). "Browser Use". GitHub. https://github.com/browser-use/browser-use
[14] Skyvern (2026). "Skyvern: Automate Browser-based Workflows with AI". GitHub. https://github.com/skyvern-ai/skyvern
[15] ByteDance Seed (2026). "UI-TARS Desktop". GitHub. https://github.com/bytedance/ui-tars-desktop
[16] Qin, Yujia, Yining Ye, and Junjie Fang (2025). "UI-TARS: Pioneering Automated GUI Interaction with Native Agents". arXiv. https://arxiv.org/abs/2501.12326
[17] Agashe, Saaket, Kyle Wong, and Vincent Tu (2025). "Agent S2: A Compositional Generalist-Specialist Framework for Computer Use Agents". arXiv. https://arxiv.org/abs/2504.00906
[18] Microsoft (2026). "UFO: A UI-Focused Agent for Windows OS Interaction". GitHub. https://github.com/microsoft/UFO
[19] Microsoft (2026). "UFO2: Weaving the Digital Agent Galaxy". OpenReview. https://openreview.net/pdf/480181d05d662b8858afdba83246a9ff756836fe.pdf
[20] OpenHands (2026). "OpenHands: AI-Driven Development". GitHub. https://github.com/OpenHands/OpenHands
[21] Wang, Xingyao, Boxuan Li, and Yufan Song (2024). "OpenHands: An Open Platform for AI Software Developers as Generalist Agents". arXiv. https://arxiv.org/abs/2407.16741
[22] ServiceNow (2026). "BrowserGym: A Gym Environment for Web Task Automation". GitHub. https://github.com/ServiceNow/BrowserGym
[23] OpenAdapt (2026). "OpenAdapt: AI-First Process Automation with Large Multimodal Models". GitHub. https://github.com/OpenAdaptAI/OpenAdapt
[24] Open Interpreter (2026). "Open Interpreter: A Natural Language Interface for Computers". GitHub. https://github.com/openinterpreter/open-interpreter
[25] XLang (2024). "OSWorld: Benchmarking Multimodal Agents for Open-Ended Tasks in Real Computer Environments". arXiv. https://arxiv.org/abs/2404.07972
[26] XLang (2026). "OSWorld". GitHub. https://github.com/xlang-ai/osworld
[27] Yu, Jing, Yuan Yang, and Yueqian Zhang (2025). "OSWorld-Human: Benchmarking the Efficiency of Computer-Use Agents". arXiv. https://arxiv.org/abs/2506.16042
[28] Microsoft (2026). "Windows Agent Arena". GitHub. https://github.com/microsoft/WindowsAgentArena
[29] Google DeepMind (2024). "AndroidWorld: A Dynamic Benchmarking Environment for Autonomous Agents". Google Research. https://google-research.github.io/android_world/
[30] Zhou, Shuyan, Frank F. Xu, and Hao Zhu (2023). "WebArena: A Realistic Web Environment for Building Autonomous Agents". arXiv. https://arxiv.org/abs/2307.13854
[31] OS-Harm authors (2025). "OS-Harm: A Benchmark for Measuring Safety of Computer Use Agents". NeurIPS. https://proceedings.neurips.cc/paper_files/paper/2025/hash/4009bff0cd87ba2203c8e3a2f082aaec-Abstract-Datasets_and_Benchmarks_Track.html
[32] VPI-Bench authors (2025). "VPI-Bench: Visual Prompt Injection Attacks for Computer-Use Agents". arXiv. https://arxiv.org/abs/2506.02456

## Claims-Evidence Table

| 结论 | 主要证据 |
|---|---|
| Computer-use API 是“动作建议—客户端执行—状态回填”的循环 | Anthropic、Google、Microsoft 的官方工具文档 [3][9][10] |
| 成熟 Agent 把 computer-use 放在精确工具之后 | Claude Code 的 MCP/Bash/Chrome/computer-use 路由 [4]；Microsoft 对 DOM 与 raw pixels 的区分 [10] |
| Codex/Claude Code 的体验优势来自 harness | Codex 的 terminal loop、app-server 事件和审批 [6][7]；Claude Code 权限与 sandbox [5] |
| 开源项目的优势是可组合和专用化，弱点是运行时与治理需要自行拼装 | UI-TARS、Agent S2、UFO²、OpenHands、Browser Use、Skyvern、OpenAdapt [13][14][16][17][18][20][23] |
| “成功率”不足以代表可用性 | OSWorld、WebArena、AndroidWorld、OSWorld-Human、OS-Harm、VPI-Bench [25][27][29][30][31][32] |

## Methodology Appendix

### Evidence and verification

检索先覆盖闭源模型/API、产品内 computer-use、开源执行器、浏览器基础设施、Agent harness、评测与安全六条路径，再打开官方文档和论文的具体章节进行核对。每条事实优先引用一手资料；厂商自报 benchmark 只用于说明产品方的公开口径，不与独立复现实验混写。对“Codex/Claude Code 体验更好”“开源体验不够好”等判断，本文把产品事实与跨来源综合推断分开。

### Outline adaptation

初始提纲把重点放在“闭源模型 vs 开源模型”的能力比较；检索后发现，官方文档反复强调执行循环、sandbox、权限、工具路由和人类确认，评测论文又显示效率与安全并不等于成功率。因此提纲增加了“模型 + 执行环境 + Harness”“工具路由”“效率/安全评测”和“Agent 协作控制流”四个部分，并把简单的产品榜单降级为定位矩阵。这一调整由 [3][4][5][7][10][27][31][32] 的证据共同推动。

### Reproducibility checklist

复现实验时应固定：模型和版本、temperature/推理设置、截图尺寸和 DPI、浏览器/OS 镜像、登录态、任务初始状态、动作上限、网络条件、成功判定脚本、人工确认规则和是否允许 API/DOM/CLI 工具。报告至少同时记录成功率、动作数、延迟、恢复率、接管次数和安全事件；否则“体验更好”无法被稳定复核。
