---
title: "Agent主题对比08｜谁最容易证明任务真的完成"
description: "Claude Code 提供成品验证入口，Codex 强调运行态反馈，Pi 把门禁交给扩展，DeepSeek Harness 强调事件可观察性；证据责任各不相同。"
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
  - Claude Code
  - Codex
  - Pi
  - DeepSeek Harness
  - 运行态验证与 Trace
prerequisites:
  - 能阅读测试输出、日志和代码差异
  - 需要验收 Agent 的完成声明
time: 16 分钟
slug: agent-theme-08-experience-feedback
series: agent-theme-comparison
order: 8
---

Claude Code 最容易在成品工作流里补测试与 Hooks；Codex 最适合把浏览器、日志、指标和 reviewer 接回执行层；Pi 最容易按项目写一套专用门禁；DeepSeek Harness 最容易重组事件与 telemetry。四者都不能凭最终回复证明完成，真正差别是默认留下什么证据，以及缺失证据由产品、宿主、扩展还是运行时团队补。

## Claude Code 对 Pi：默认验证入口，还是专用门禁所有权

Claude Code 的[工作原理](https://code.claude.com/docs/en/how-claude-code-works) 把工具结果继续送回后续判断，用户可以让它运行项目测试、读取诊断并检查差异；Hooks 又能在固定事件点触发命令。相比 Pi，Claude Code 的优势是验证可以沿现成工作台展开，不必先写扩展框架，适合已有测试命令和明确验收标准的仓库。

短板是“工具跑过”容易被误写成“目标达成”。Claude Code 运行了单元测试，不代表浏览器路径可用；Hook 退出码为零，也不代表测试没有被跳过。产品提供验证入口，却不会替项目决定哪些测试、断言数量、截图或业务指标构成完成。默认整合降低执行成本，没有降低验收定义成本。

Pi 的 [Extensions 文档](https://pi.dev/docs/latest/extensions) 允许团队注册工具、命令和事件处理器，因此可以把特定项目门禁写成代码：必须运行哪组测试、解析哪些结果、失败后禁止结束、何时要求人工检查。相比 Claude Code，Pi 的优势是门禁不必挤进产品既有事件语义，可以精准匹配内部构建和设备环境。

Pi 的短板是门禁质量完全属于扩展作者。只检查进程退出码、不确认断言数量，或在超时后把“未完成”包装成“跳过”，都会稳定地产生虚假绿色。Claude Code 的默认工具更容易被普通团队使用，Pi 的专用验证更容易做到精确；但后者必须把 extension 本身当生产测试工具审查。

## Codex 对 Claude Code：把真实运行反馈接回去，还是留在工作台内验证

OpenAI 的 [Harness engineering](https://openai.com/index/harness-engineering/) 案例展示了给 Agent 接入浏览器自动化、应用日志、指标和截图，并让其他 Agent 审查再修复。相比 Claude Code 主要围绕成品工作台调用工具，Codex 的优势是执行层与宿主集成更适合把真实应用状态做成一等反馈，而不只把测试 stdout 贴回会话。

这对 UI、异步任务与服务故障尤其重要。Codex 宿主可以把一个 turn 中的工具 item、截图、日志和 reviewer 结果关联起来；Claude Code 也能通过工具、Hooks 或 MCP 获取这些证据，但组织方式更依赖产品提供的会话与扩展点。Codex 给予平台团队更大的证据建模权，Claude Code 给予使用者更短的接入路径。

Codex 的短板是公开工程案例不能证明默认安装已拥有同样环境。浏览器、日志、指标与截图需要仓库和平台先暴露，reviewer 也需要任务边界与退出规则。若内部宿主只转发最终文本，Codex App Server 的事件优势就被自己丢掉。Claude Code 的短板则是团队可能满足于“在终端看到测试通过”，没有建设跨系统证据链。

二者还会在失败归因上分叉。Claude Code 用户主要从会话中的工具结果、权限和 Hooks 找原因；Codex 平台可以从 thread/turn/item 关联客户端与执行事件，却要保证事件没有丢失或错误排序。前者诊断入口较集中，后者可观察性上限更高；后者的监控与存储成本也更高。

## DeepSeek Harness 对 Codex：事件可重组，不等于结果已验证

DeepSeek Harness 的公开架构强调插件化运行与可追踪事件，[Core 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md) 描述工具调用经过 registry，并把模型可见事实追加到 session log。相比 Codex 已有 thread/item 和工程化反馈案例，DeepSeek Harness 更适合替换日志、telemetry、工具结果提取或策略判断部件。

这种可组合性适合研究不同证据管线：一个插件收集测试结果，一个解析应用日志，一个把审批与副作用写入审计流。Codex 更像在既定执行语义上扩展运行反馈，DeepSeek Harness 则允许调整证据怎样进入事件系统。前者更接近产品平台，后者更接近实验运行时。

短板是 Trace 完整不等于任务正确。DeepSeek Harness 只能记录插件看到并写入的事件；错误测试集、遗漏的浏览器路径或未采集的外部副作用，都会让一条结构漂亮的 Trace 支持错误结论。Codex 的运行态反馈同样可能选错指标，但已有宿主语义更容易规定 item 生命周期；DeepSeek Harness 还要先验证插件覆盖和事件契约。

DeepSeek Harness 的公开资料支持“观察面可重组”这一架构判断，不支持它比 Codex、Claude Code 或 Pi 更容易得到正确答案。项目处于 developer preview，日志与 telemetry 组合的兼容性需要固定版本验证；若团队没有专人维护证据 schema，可组合日志会比一组朴素、稳定的测试更难复查。

## 四者最容易制造哪种“口头完成”

证据保存期会改变谁最省事。Claude Code 的会话与工具输出方便即时复查，但团队若要长期审计，需要决定哪些产物另存；Codex 宿主可以把 item、日志和截图写入平台存储，也必须处理敏感数据与保留策略。Pi 可让 extension 直接输出项目规定的报告，DeepSeek Harness 可让 telemetry 插件形成统一事件库；后两者的可定制性同时带来 schema 迁移责任。

证据身份也不同。Claude Code 用户通常知道当前操作者和本地工作区，却要补齐自动任务的身份关联；Codex 平台可以把 thread、客户端用户与 approval 关联，但实现错误会污染整条审计链。Pi 若以共享宿主账号运行，extension 记录的 Agent 名称不能替代真实用户；DeepSeek Harness 多 provider 还要记录远端执行者与 transport。没有身份，Trace 只能说明发生过动作，不能说明谁获准执行。

可复现性会进一步拉开距离。Claude Code 与 Codex 的服务端或产品默认值可能随版本变化，复查时至少要保存日期、可见设置和任务 artifact；Pi 可以锁定 extension 与依赖，但模型和外部服务仍可能变化；DeepSeek Harness 能记录 profile 与插件图，却在预览期更需要固定精确提交。四者都不能把同一产品名当作可复现实验配置。

独立审查的切入点也不同。Claude Code 最容易让人从最终 diff、测试与会话抽查；Codex 可以把 reviewer 直接接进工作流；Pi 可以写第二个只读验证 extension；DeepSeek Harness 可以更换 verifier 或 telemetry consumer。审查越自动，越要确保验证者没有复用实现者的错误假设，否则多个 Agent 只是重复同一种偏差。

Claude Code 最容易出现“测试命令成功，所以任务完成”：内建工具让执行很顺，未覆盖的 UI 或业务路径可能被忽略。Codex 最容易出现“事件很多，所以证据充分”：浏览器、日志与 reviewer 都接入后，团队仍可能没有一个明确的最终判定。丰富反馈与有效验收不是同义词。

Pi 最容易出现“我们有自定义门禁，所以更严格”：extension 若无人独立测试，规则漏洞会被复制到每次任务。DeepSeek Harness 最容易出现“每次运行可追踪，所以可审计”：事件缺失、插件版本漂移和 profile 差异会让两条 Trace 不可直接比较。两者都拥有更深的验证控制，也承担验证验证器的递归责任。

停止条件会继续放大差异。Claude Code 可以由用户要求测试、审查与摘要，但产品不会替业务定义不可接受风险；Codex 工作流可循环 reviewer 与修复，缺少最大轮次会空转；Pi 能在 extension 中强制门禁，错误策略可能让任务永不结束；DeepSeek Harness 能把策略放进插件，组合变化可能使同一任务在不同 profile 下停止条件不同。

成本必须和证据一起报告。[VS Code 的 Harness 评估](https://code.visualstudio.com/blogs/2026/05/15/agent-harnesses-github-copilot-vscode) 分开观察正确性、Agent effort、token efficiency 与 latency，而不是合成一个神秘总分。Claude Code 的人工检查、Codex 的宿主与遥测、Pi 的扩展维护、DeepSeek Harness 的插件与存储，都是 token 之外的真实成本。

内部试点应给四者同一任务，却允许它们暴露各自责任：记录通过了哪些测试、看了哪些真实运行路径、保存了哪些 Trace、发生几次人工介入、失败能否归因。若只比较最终回复，Claude Code 的整合、Codex 的事件、Pi 的定制与 DeepSeek Harness 的可观察性都会被抹平。

## 裁决：选择你能长期维护的证据链

| 产品 | 优势 | 短板 | 代价 | 适合谁 |
| --- | --- | --- | --- | --- |
| Claude Code | 工具、会话与 Hooks 让常规验证快速落地 | 容易把命令成功误当业务完成 | 为仓库补验收标准、运行态检查与未验证项 | 已有良好测试、希望低成本执行验证的团队 |
| Codex | 宿主可把浏览器、日志、指标、reviewer 与 item 关联 | 反馈管线需自建，事件丰富仍可能没有最终判定 | 维护应用运行环境、遥测、存储和退出规则 | 需要真实运行证据与平台级审查闭环的团队 |
| Pi | 专用 extension 可实现最贴合项目的门禁 | 门禁本身可能有漏洞，产品不替你审查 | 测试扩展、解析器、超时与失败语义 | 验收流程特殊且能维护验证代码的团队 |
| DeepSeek Harness | session、日志、telemetry 与策略可重组 | 预览期事件覆盖与跨 profile 可比性待验证 | 维护证据 schema、插件版本和审计存储 | 研究可观察运行时或自建证据平台的团队 |

只有常规测试与差异审查，Claude Code 最快；要把真实应用反馈做成平台能力，Codex 更自然；验收规则高度专用，Pi 的可编程门禁更直接；要研究事件和证据管线本身，DeepSeek Harness 控制最深。无论选谁，最终回复只能引用证据，不能替代证据。

## 本篇引用来源

- [Claude Code：How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [OpenAI：Harness engineering](https://openai.com/index/harness-engineering/)
- [OpenAI：Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi：Extensions](https://pi.dev/docs/latest/extensions)
- [DeepSeek Harness：Core subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)
- [DeepSeek Harness：Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [VS Code：Evaluating Agent Harnesses for GitHub Copilot](https://code.visualstudio.com/blogs/2026/05/15/agent-harnesses-github-copilot-vscode)
