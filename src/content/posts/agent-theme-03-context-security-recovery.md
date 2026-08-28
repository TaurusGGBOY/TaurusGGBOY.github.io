---
title: "Agent主题对比03｜谁真正替你隔离危险命令"
published: 2026-08-12T10:03:00+08:00
updated: 2026-08-28
description: "Claude Code 与 Codex 把沙箱和审批做进产品，Pi 明确要求外部隔离，DeepSeek Harness 提供实验性可插拔边界；四者责任完全不同。"
tags: ["agent-theme-comparison", "ai-agent", "agent-security", "claude-code", "codex", "pi", "deepseek-harness"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-03-context-security-recovery/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-03-context-security-recovery"
series: "agent-theme-comparison"
order: 3
difficulty: "intermediate"
time: "15 min"
prerequisites:
  - "能识别凭据、外网和不可逆写入风险"
  - "正在决定 Agent 应运行在宿主机还是隔离环境"
topics:
  - "Sandbox 与 Approval"
  - "Claude Code"
  - "Codex"
  - "Pi"
  - "DeepSeek Harness"
  - "事故半径"
status: "verified"
verified_at: "2026-08-28"
---

不额外配置时，Claude Code 与 Codex 最接近“产品替你提供第一层边界”；Pi 明确不承担这项责任；DeepSeek Harness 展示了可插拔审批与 Shell 隔离语义，却明确不能被当作生产安全边界。真正安全的差别，不是弹窗多少，而是错误批准以后还有什么能挡住命令。

下面只看同一条命令：它要读取当前用户的云凭据，再连接外部域名检查部署资源。四者都可能判断这与任务有关，但谁限制文件、谁限制网络、谁记录批准、谁承担最坏损失，答案完全不同。

## Claude Code 与 Pi：一个内建边界，一个明确把边界交给你

Claude Code 把权限规则与 Bash 沙箱组合在产品内。[权限文档](https://code.claude.com/docs/en/permissions) 负责哪些工具、路径或域名需要允许，[沙箱文档](https://code.claude.com/docs/en/sandboxing) 则说明操作系统级机制会约束 Bash 及其子进程。相比 Pi，Claude Code 的优势很实际：在正确配置下，团队不必先造一套拦截层，越界动作可以回到统一的权限流程。

Claude Code 的短板是“有沙箱”很容易被误读成“这个任务已安全”。如果云凭据本来就在允许读取的路径里，外部域名也已被放行，命令仍然能造成泄露。内建边界减少了配置工作的起点，却没有替团队决定哪些目录、域名和命令属于业务必需；批准过宽时，产品无法替批准人恢复秘密。

Pi 的 [Security 文档](https://pi.dev/docs/latest/security) 直接写明不内建沙箱，并以启动它的用户权限运行。与 Claude Code 相比，这是一项明显短板：把 Pi 直接放在挂载整个主目录、继承 SSH 和云凭据的宿主机上，项目信任设置也不会限制模型之后启动的工具。对不可信仓库，隔离责任从第一分钟就属于使用者。

但 Pi 的边界反而更不容易被误解。官方建议使用容器、虚拟机、微虚拟机或外部策略沙箱，团队必须明确决定挂载什么、暴露什么凭据、允许什么网络。Claude Code 适合需要产品内第一层控制的人；Pi 适合已经有成熟执行隔离、并希望 Harness 不重复实现策略的平台。前者怕把内建控制当终点，后者怕根本没人补起点。

## Codex 与 Claude Code：谁更适合把批准变成平台事件

Codex 同样区分沙箱与 approval。[OpenAI 的安全部署文章](https://openai.com/index/running-codex-safely/) 描述写入、网络和受保护路径边界，并把批准与工具、MCP、网络代理事件纳入可观察记录。与 Claude Code 的集成式权限体验相比，Codex 的优势更偏向平台治理：审批不只呈现在当前终端，还可以进入统一执行层和遥测系统。

这种可观察性也增加了集成责任。Codex 的宿主若把“只允许一次”错误缓存成持续规则，或者只展示命令摘要而隐藏真实参数，安全语义会在客户端层被削弱。Claude Code 的官方交互减少了这类自建 UI 错误；Codex 让平台团队拥有审批呈现和审计接入，也让它们负责事件完整性、身份关联与日志保存。

两者都不能解决审批疲劳。Claude Code 频繁弹窗会诱使用户扩大规则，Codex 平台把每次事件集中起来也不代表审批人理解后果。对读取凭据并访问外网的命令，真正有效的配置应同时让凭据不可见、网络默认不可达；若只依赖人在最后一刻点“拒绝”，两个产品都把技术事故变成了注意力测试。

## DeepSeek Harness 对三者：边界可以插拔，但安全结论不能插拔

DeepSeek Harness 的 [Approval 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/approval.md) 把结果限制为单次允许、拒绝、取消或不可用；[Shell 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/shell.md) 描述沙箱拒绝后带理由请求更宽权限、再进行一次重试。相比 Pi 完全依赖外部隔离，它提供了更明确的运行时批准语义；相比 Claude Code 与 Codex，它又允许团队替换更多审批、Shell 与日志部件。

可插拔的优势是可以接入内部策略引擎、审计系统或远程批准通道。短板是插件边界本身需要验证：自定义 approval provider 是否会在超时时默认放行，Shell 插件是否覆盖子进程，日志插件是否遗漏拒绝事件，都不能由架构图回答。Claude Code 与 Codex 的产品默认值减少了组合数量；DeepSeek Harness 把组合能力交给平台，也扩大了错误装配的可能性。

成熟度限制在安全篇不能被一句“注意风险”带过。DeepSeek Harness 的 [SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) 明确说明项目未经安全审计，不能视为安全或生产就绪，也不能作为不可信工作负载的唯一安全控制；README 还标明 developer preview 与破坏兼容风险。因此它当前更适合在外部容器或虚拟机已经承担硬边界的前提下研究策略组合，而不是替代那层隔离。

## 同一次批准，四者最可能留下什么缺口

无人值守任务会放大四者差异。Claude Code 与 Codex 可以在预设策略内减少交互，但预设规则一旦过宽，任务会在没人观察时持续使用权限；Pi 若运行在一次性容器中，反而可以用容器销毁明确结束风险；DeepSeek Harness 可以把无人应答建模为 approval unavailable，却仍要证明自定义 provider 没有把超时改成默认允许。无人值守不是少点几次确认，而是把硬边界提前固化。

多人环境下，Claude Code 的项目规则便于共享，但个人级允许项可能让同一命令在不同机器上得到不同结果；Codex 平台更容易把批准关联到统一身份，却必须自己定义角色和保留期。Pi 的权限事实主要存在于宿主账号与容器配置，代码仓库里的设置看不出完整边界；DeepSeek Harness 的权限事实则可能散落在 profile、approval 插件与 sandbox 插件之间。四者都需要审计，但审计对象并不相同。

第三方扩展还会改变默认结论。Claude Code 的 Hook 或 MCP、Codex 的 MCP 与宿主集成、Pi 的 extension、DeepSeek Harness 的插件，都可能在主要工具边界之外读取文件或访问网络。Claude Code 与 Codex 的内建沙箱优势不能自动覆盖每个外部进程；Pi 与 DeepSeek Harness 更不能因为扩展接口清晰就推定扩展可信。每增加一条执行路径，都要重新回答它继承谁的权限、进入谁的日志。

因此配置验收方式也应不同。Claude Code 要验证权限规则与 Bash 子进程确实受限；Codex 还要验证客户端批准和遥测事件一一对应；Pi 要从容器挂载、账号权限和出站网络证明事故半径；DeepSeek Harness 则必须在外部隔离内故意触发拒绝、超时和插件失败。用同一张“是否支持沙箱”勾选表，会掩盖最关键的责任差异。

Claude Code 最常见的缺口是允许规则过宽：体验顺畅以后，用户可能忘记某个域名或路径已长期开放。Codex 最常见的缺口在宿主实现：执行层有事件，但自建客户端未必完整呈现理由、范围和身份。Pi 的缺口最直接：如果外部容器、虚拟机或策略代理没有落地，就没有第二道产品内防线。

DeepSeek Harness 的缺口则在“看起来每层都有插件”。approval、sandbox、Shell、log 都存在，不代表组合已经过攻击测试；某个插件的默认关闭、版本变化或事件遗漏都可能打破预期。相比之下，Claude Code 与 Codex 更适合把已支持的边界纳入日常使用，Pi 更适合复用已有基础设施，DeepSeek Harness 更适合测试一套边界如何被组装，而不是宣称它已经安全。

事故恢复成本也不同。Claude Code 用户主要审查产品权限记录和工作区差异；Codex 平台还要关联服务端执行与客户端批准；Pi 团队要回到容器、账号与网络层查证；DeepSeek Harness 团队则可能需要同时验证插件版本、事件日志和外部隔离。越深的控制权，事故调查越依赖自己的工程纪律。

若团队说不出各自的调查入口，就不应开启无人值守：Claude Code 要有人维护权限规则，Codex 要有人维护审批与身份链，Pi 要有人维护隔离环境，DeepSeek Harness 要有人同时维护外部边界和插件契约。

## 裁决：谁替你挡第一下，谁承担最后一下

| 产品 | 优势 | 短板 | 代价 | 适合谁 |
| --- | --- | --- | --- | --- |
| Claude Code | 权限与 OS 级 Bash 沙箱形成产品内组合 | 允许范围过宽时容易产生安全错觉 | 持续维护路径、域名和团队权限规则 | 需要开箱控制、愿意配置威胁边界的团队 |
| Codex | 沙箱、approval 与遥测适合接入统一执行平台 | 自建宿主可能错误呈现或保存审批语义 | 维护身份、审计、客户端与策略一致性 | 已有平台治理能力的产品或内部平台团队 |
| Pi | 安全责任公开明确，容易复用既有外部隔离 | 不内建沙箱，直接运行的事故半径取决于用户账号 | 自备容器、虚拟机、最小凭据与网络策略 | 已有成熟隔离基础设施的团队 |
| DeepSeek Harness | approval、Shell、日志边界可按平台重组 | 未经安全审计，预览期插件组合不能当生产防线 | 外部硬隔离加插件级安全测试与升级回归 | 研究安全编排、但不把它当唯一边界的团队 |

如果没有现成隔离平台，Claude Code 或 Codex 比 Pi 更适合作为起点，但仍要收窄凭据与网络。若已有一次性执行环境，Pi 的“我不替你隔离”反而比重复的半套策略更清楚。DeepSeek Harness 只有在外部硬边界已经成立、团队又确实要研究审批与 Shell 组合时才值得承担当前成熟度风险。

## 本篇引用来源

- [Configure permissions — Claude Code](https://code.claude.com/docs/en/permissions)
- [Sandboxing — Claude Code](https://code.claude.com/docs/en/sandboxing)
- [Running Codex safely at OpenAI](https://openai.com/index/running-codex-safely/)
- [Pi Security](https://pi.dev/docs/latest/security)
- [DeepSeek Harness User Approval](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/approval.md)
- [DeepSeek Harness Shell subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/shell.md)
- [DeepSeek Harness Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)
