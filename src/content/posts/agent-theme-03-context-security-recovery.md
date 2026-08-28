---
title: "Agent主题对比03｜Agent 什么时候必须停下来问人"
published: 2026-08-12T10:03:00+08:00
updated: 2026-08-28
description: "沙箱限制技术上能做什么，审批决定哪次动作要交还给人，外部隔离控制最坏损失。本文用凭据与网络事故拆解四个项目的安全边界。"
tags: ["agent-theme-comparison", "ai-agent", "agent-security", "claude-code", "codex", "pi", "deepseek-harness"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-03-context-security-recovery/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-03-context-security-recovery"
series: "agent-theme-comparison"
order: 3
difficulty: "intermediate"
time: "19 min"
prerequisites:
  - "理解一次 Agent 任务的工具反馈循环"
  - "知道文件权限、网络访问和进程隔离的基本概念"
topics:
  - "Sandbox 与 Approval"
  - "Claude Code"
  - "Codex"
  - "Pi"
  - "DeepSeek Harness"
  - "人工接管与事故边界"
status: "verified"
verified_at: "2026-08-28"
---

Agent 准备读取凭据、连接外网、改共享基础设施或执行不可逆操作时，必须停下来问人。沙箱负责限制技术上能做什么，审批负责把具体决策交还给人，容器、虚拟机或独立账号负责压低失控后的损失。三层少一层，都不能靠另外两层补齐。

设想一个常见场景：Agent 为修复部署脚本，准备运行一条命令。命令会读取当前用户的云凭据，再访问外部域名验证资源。它看起来与任务相关，也可能被仓库里的恶意文本诱导。此时真正的问题不是“要不要点允许”，而是允许以后哪些文件、网络和进程会进入风险范围。

## 先把三种控制分开

沙箱是技术执行边界。它限制进程可以读写哪些路径、能否访问网络、能创建哪些子进程。边界由操作系统、容器或虚拟化机制执行时，即使模型判断错误，命令也不应越过已经设定的范围。

审批是一次决策边界。Agent 提出“我需要访问这个域名”或“我需要写工作区外的目录”，人决定拒绝、只允许一次，或在明确范围内复用授权。审批无法让危险动作变安全；它只确定谁为这次例外作决定。

外部隔离是事故半径边界。一个进程即使在自己的工作区内完全可写，若工作区位于一次性容器，且只挂载任务文件、没有长期凭据，最坏损失会小得多。相反，在个人账号下运行、挂载整个主目录、继承 SSH 与云凭据，再精细的弹窗也会把判断压力集中给一个容易疲劳的人。

| 控制 | 它回答的问题 | 它防不了的事故 |
| --- | --- | --- |
| 沙箱 | 这次进程技术上能触达哪里 | 被允许资源本身遭误删或泄露 |
| 审批 | 这次越界动作由谁确认 | 人误判、疲劳点击或看不懂真实后果 |
| 外部隔离 | 出错后最多损失哪些资源 | 隔离环境内已经暴露的文件与凭据被滥用 |

把“询问很多”当成安全，会产生审批疲劳。把“有沙箱”当成安全，也会忽略允许路径和网络本身可能过宽。可靠配置要从具体事故倒推：要防止凭据外传，就同时限制凭据可见性和出站网络；只拦截写文件不够。

## 同一条危险命令在四个项目里怎样停

Claude Code 将权限规则和 Bash 沙箱分成互补层。[权限文档](https://code.claude.com/docs/en/permissions) 说明，权限控制工具、文件或域名能否被使用，沙箱则对 Bash 及其子进程施加文件系统和网络限制。[沙箱文档](https://code.claude.com/docs/en/sandboxing) 说明其使用操作系统级机制，并支持在边界内减少提示、越界时回到常规权限流程。对读取云凭据并访问外网的命令，团队仍需显式限制敏感目录和允许域名；默认配置不能替代自己的威胁模型。

Codex 也把沙箱和审批分开。[OpenAI 的内部部署说明](https://openai.com/index/running-codex-safely/) 将沙箱定义为写入、网络和受保护路径的技术边界，审批策略决定何时必须询问；用户可只批准一次，或在会话中批准同类动作。该文章还记录了网络策略与 Agent 日志的组合使用。它证明 Codex 提供这些控制面，不证明任意本地配置都达到同样的隔离效果。

Pi 采取了更明确的责任分配。[Pi Security](https://pi.dev/docs/latest/security) 写明 Pi 是本地 Agent，以启动它的用户权限运行，也不内建沙箱；项目信任只控制是否加载项目级设置和扩展，不限制模型启动后的工具行为。对不可信仓库或无人值守任务，官方建议把整个进程放入容器、虚拟机、微虚拟机或外部策略沙箱。Pi 的最小核心便于使用者选择环境，也要求使用者真正提供那个环境。

DeepSeek Harness 的 [Approval 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/approval.md) 把授权结果收窄为单次允许、拒绝、取消或不可用，并在无人应答时关闭请求；[Shell 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/shell.md) 描述了被沙箱拒绝后，以理由申请一次更宽权限再重试的路径。公开设计让提权决策和日志事件可以追踪。

安全边界仍然明确：DeepSeek Harness 是 developer preview，兼容性可能破坏性变化；官方 [SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) 说明它未经安全审计，不能视为安全或生产就绪，也不能作为不可信工作负载的唯一安全控制。对来源不明的仓库，应在一次性容器或虚拟机里运行，只挂载必要文件，并移除不需要的凭据和网络。

## 哪些动作应该自动执行

低风险自动化需要同时满足三个条件：影响范围清楚，结果容易恢复，失败能被验证。比如在隔离工作区读取源文件、搜索符号、运行不访问外网的静态检查，通常适合在预设边界内直接执行。是否属于低风险仍取决于环境；测试脚本也可能读取密钥或启动外部服务。

需要停下来问人的动作，通常具有下面任一特征：

- 读取任务并不需要的凭据、个人目录、浏览器数据或密钥链；
- 向未预先允许的域名发送内容，或把本地文件作为请求负载；
- 写入工作区外路径，修改系统配置、共享数据库、云资源或 CI 密钥；
- 删除难以恢复的数据，覆盖历史，强制推送，发布制品或通知外部人员；
- 需要把当前沙箱放宽到一个无法用具体路径、域名或单次命令表达的范围；
- 需求本身有多种业务解释，选择会改变用户数据、权限或账单。

最后一项经常被误归为模型能力。技术上允许执行，并不意味着 Agent 有权替产品负责人选择数据迁移语义。审批界面应呈现动作、理由、目标范围和可能后果；只显示一个抽象的“需要更多权限”，人无法作出有效判断。

## 一次性提权要尽量窄

Agent 因网络被拒绝后，最省事的做法是给它整段会话开放网络。更稳妥的做法是只允许本次命令访问所需域名，并保留原来的文件边界。写权限同理：需要生成临时构建产物，不等于需要写整个主目录。

一次性授权的价值在于防止权限悄悄累积。任务从“读取公开依赖文档”转向“上传构建产物”时，旧授权不应该自动覆盖新动作。可复用规则只适合语义稳定、范围可描述、后果可恢复的操作，例如固定测试命令；会执行任意脚本的解释器前缀通常过宽。

拒绝后也要有明确结果。Harness 应告诉模型是策略拒绝、用户拒绝、审批通道不可用，还是沙箱运行器失败。它们不能都包装成普通命令错误，否则模型可能换一种工具绕路，或反复请求同样权限。DeepSeek Harness 的公开 Approval 设计选择在无应答时关闭请求；Codex 与 Claude Code 的文档也把越界动作送入明确的审批流程。这里能比较的是控制语义，不能据此给出安全强弱排名。

## 审批之后还要审计和恢复

一次批准至少要留下四项记录：谁请求了什么动作，给出的理由是什么，谁在何时作出决定，执行结果是什么。只有命令日志，没有用户意图和批准记录，事故发生后很难判断它是被授权的正常动作、误操作，还是越权尝试。

[Running Codex safely at OpenAI](https://openai.com/index/running-codex-safely/) 描述的 OpenTelemetry 事件可覆盖用户提示、工具审批、工具执行、MCP 使用和网络代理决定。DeepSeek Harness 的 Approval 文档也把询问与决定写入成对审计事件。这些是可审计性的公开设计例子。日志有没有被集中保存、能保留多久、是否覆盖外部插件，仍要在实际部署中检查。

恢复措施需要在运行前准备。代码修改可以靠干净分支和差异审查回退；数据迁移需要备份、事务或逆向脚本；云资源操作需要独立账号、最小权限和可撤销凭据。若团队无法说清某个动作失败后怎样恢复，就不应把它放进无人值守的自动执行区。

人的接管也要有上下文。理想的暂停点会给出已完成步骤、当前阻塞、待批准动作、最小所需权限，以及拒绝后的替代路径。把整段聊天丢给审批人，让他重新推断风险，只是把 Agent 的上下文成本转移给了人。

## 用事故模型配置，而不是数弹窗

对四个项目做安全选型时，先写出要防的事故：泄露哪类凭据、误改哪个环境、哪条网络路径可能外传数据、哪个进程可以逃出工作区。再检查沙箱是否在技术上封住路径，审批是否把例外交给合适的人，外部隔离是否把剩余损失限制在可接受范围。

Claude Code 与 Codex 提供了组合式权限和沙箱控制；Pi 明确要求外部隔离承担真实边界；DeepSeek Harness 展示了可插拔审批、Shell 与沙箱语义，但仍处于未审计的 developer preview。它们的责任分配不同，最终安全性取决于具体版本、配置、宿主权限和任务威胁模型。

判断“要不要问人”的标准也因此很清楚：边界内、可恢复、可验证的动作可以自动走；需要新权限、产生外部副作用、不可逆或涉及业务裁决的动作应停下。下一篇讨论暂停时间从几分钟变成几小时，甚至跨会话以后，Agent 怎样保住约束和进度。

## 本篇引用来源

- [Configure permissions — Claude Code](https://code.claude.com/docs/en/permissions)
- [Sandboxing — Claude Code](https://code.claude.com/docs/en/sandboxing)
- [Running Codex safely at OpenAI](https://openai.com/index/running-codex-safely/)
- [Pi Security](https://pi.dev/docs/latest/security)
- [DeepSeek Harness User Approval](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/approval.md)
- [DeepSeek Harness Shell subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/shell.md)
- [DeepSeek Harness Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
