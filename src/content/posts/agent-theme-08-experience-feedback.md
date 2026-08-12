---
title: "Agent主题对比08｜体验层、反馈通道与系列收束"
published: 2026-08-12T10:01:00+08:00
updated: 2026-08-12
description: "比较三个 Agent 的 Buddy、语音、提示建议、通知、mailbox、输出风格与最终能力地图。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-08-experience-feedback/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-08-experience-feedback"
series: "agent-theme-comparison"
order: 8
difficulty: "advanced"
time: "45 min"
prerequisites:
  - "Agent主题对比 05｜宿主、状态与结构化 IO"
  - "Agent主题对比 07｜记忆与后台智能"
topics:
  - "companion experience"
  - "voice"
  - "prompt suggestions"
  - "notifications"
  - "mailbox"
  - "output styles"
source_modules:
  - "restored-src/src/buddy"
  - "restored-src/src/voice"
  - "restored-src/src/services/MagicDocs"
  - "restored-src/src/context/notifications.tsx"
  - "restored-src/src/constants/outputStyles.ts"
  - "codex-rs/app-server"
  - "packages/coding-agent/src"
status: "verified"
verified_at: "2026-08-12"
---


> 体验层的价值不是把 Agent 变得更会聊天，而是让执行中的状态、结果、下一步和等待都能在正确的时间抵达正确的人或 Agent。

本篇覆盖 Claude Code 源码解读 44–48：Buddy、Voice、MagicDocs/Prompt Suggestions、Notifications/Mailbox/Output Styles，以及系列总结。它们属于主循环之外的旁路和反馈面，却决定了一个长时间运行的 Agent 是否可感知、可接管、可继续。

![Agent 体验层、反馈通道与系列收束](/images/posts/agent-theme-08-experience-feedback/agent-theme-08-experience-feedback-handdrawn.png)

## Section 44｜陪伴式体验如何叠加在 Agent 之上

### Claude Code：Buddy 是观察器与 UI，不是第二个主 Agent

44 把 Buddy 拆成 observer 与 UI，进一步拆为“灵魂”和“骨架”。功能开关和 `/buddy` 决定启动生命周期；主 Agent 只收到一次“它坐在旁边”的说明；回合结束后 observer 才写入临时反馈；AppState 只保存两项短期状态；500 毫秒一个 tick 把状态翻译成动画；同一状态再投影成宽屏、窄屏和全屏布局。

这个边界很关键：Buddy 观察主 Agent 的状态并提供短期陪伴，不应在用户不知情的情况下创建另一条具有同等副作用的 loop。开关、静音和失败分别处理；`companionIntroText` 还限制发言风格，避免体验组件改变主任务语义。

### Codex CLI：TUI 状态/事件可以提供陪伴，但不是独立决策者

Codex 的客户端可以根据 turn/item/exec 状态展示进度、建议和等待提示；App Server 事件让 UI 能知道工具是否运行、模型是否等待或需要 approval。若要做 Buddy 类组件，它应是事件消费者，任何会改变代码/环境的动作仍需新 turn、tool call 和 approval。

### Pi：扩展可以观察事件并做轻量 UI

Pi 的 TUI/extension 可以订阅 agent events，展示状态、动画、提示或通知。由于扩展同进程运行，必须区分只读观察、向用户发送文本和真正调用工具；后两者不能借“体验扩展”名义绕过 session/permission。

### 对比结论

Claude Code 把陪伴组件的观察、短期状态和主 Agent 决策分开；Codex 通过协议事件自然提供状态面；Pi 把陪伴能力交给扩展。陪伴式 UX 的安全标准是：用户知道它在观察什么、何时发言、能否触发动作。

### 验证动作

开启/关闭、静音、主 Agent 工具运行、取消和失败各测一次；检查 Buddy 是否只观察允许的状态，是否在回合结束前抢占主输出，是否留下不必要的持久化内容。

## Section 45｜语音如何接入终端 Agent

### Claude Code：Voice 把音频收敛成普通文本输入

45 的语音链路暴露五个字段给 UI；`/voice` 在录音前检查四层启用条件；“按住说话”由自动重复推断；录音先同步进入 recording，再做异步检查；本地录音按平台选择后端；录音与 WebSocket 并行，先到的音频先缓冲；Interim 只做预览，Final 才成为稳定文本；最终文本按光标位置拼回 prompt。

失败按边界分层：设备不可用、权限/配置、连接、转写和取消不能都翻译成“没听清”。语音输入的最终落点仍是普通 user message，因此权限、session、tool loop 不应因为输入来自音频而改变。

### Codex CLI：语音属于宿主输入适配层

Codex 的 thread/turn 接收结构化 user input；CLI/IDE 可以把语音转成文本或附件，再发送到 app-server。interim transcript 应停留在 UI，只有 final 才提交 turn；音频设备、网络和转写错误不应伪装成模型错误。

### Pi：扩展可接 provider，再调用普通 agent input

Pi 的 extension/TUI 可以连接本地录音或远程 speech-to-text，把 final 文本交给 agent loop。core 不需要知道音频格式；宿主需要处理设备权限、取消、临时文件和隐私，避免把原始录音永久写入 session。

### 对比结论

Claude Code 把语音适配做成完整生命周期；Codex 让宿主把语音变成 protocol input；Pi 通过扩展接入。三者共同原则是 interim 不得污染会话，final 才成为可恢复的用户意图。

### 验证动作

在录音、转写中间态、最终提交和取消四个时点观察 session/turn；模拟设备失效、WebSocket 断开和空文本，确认不会凭空发起一次模型请求。

## Section 46｜文档生成与提示词建议如何工作

### Claude Code：两条回合后旁路，不改写主循环语义

46 把 MagicDocs 与 Prompt Suggestions 分开。MagicDocs 先用文件头声明“这份文档要被维护”，更新只在主对话空闲时串行发生；上下文合并四个来源；文档更新通过精确路径权限自动决策。Prompt Suggestions 则在生成前判断是否值得调用模型，复用父请求 cache key，候选只保存到临时 AppState，Tab/Enter/继续打字对应三条不同结果，取消和失败保持不可见/可恢复边界。

这两条旁路都不是主 Agent 的 tool loop：一个维护有明确标记的文档，一个预测用户下一句输入。它们不能抢占主会话写入权限，也不能把预测候选当成用户已经确认的 prompt。

### Codex CLI：文档/建议应由 host 或验证工具触发

Codex 的环境可读性和 harness engineering 允许 host 在 turn 后更新索引、生成文档或显示下一步建议；但这些动作应是独立的 job/event，不能混入主 turn 的成功结果。建议文本只有在用户选择后才成为新 turn 输入。

### Pi：扩展可监听 session idle 并生成辅助内容

Pi 的 extension 可以监听 agent/session end，更新 project docs 或给 TUI 候选。由于扩展拥有宿主权限，必须明确路径白名单、空闲条件、是否需要确认以及失败时是否回滚。候选不能自动改变消息树。

### 对比结论

Claude Code 把“维护文档”和“预测输入”设计成两条受限旁路；Codex 由 host/job 组合；Pi 由扩展实现。辅助生成的核心边界是：它可以准备材料，但不能伪装成用户决策或无条件扩大写权限。

### 验证动作

在主 Agent 运行、空闲、失败和用户继续输入四种时点触发旁路，检查文档写入是否串行、建议是否丢弃、主 turn 的 cache/usage 是否被错误合并。

## Section 47｜非核心反馈通道如何协作

### Claude Code：Output Style、Notification、Mailbox 解决三类不同问题

47 先区分输出风格、UI notification/OS notification、Hook 和 Mailbox。Output Style 在生成前决定“怎么说”，通过 system prompt 选择器影响表达；UI Notification 只展示短暂状态，不污染对话；OS Notification 与 Hook 负责把用户唤回；Mailbox 分成进程内队列和团队 inbox；地址先决定受众，再决定传输；目标 Agent 忙时消息排队，空闲时才成为下一轮；TUI 与 SDK 内容相同但宿主协议不同。

这是一条完整反馈闭环：内容产生、投影成不同风格、按受众发送、按忙闲排队、在可接收时进入下一轮。`SendMessage` prompt 先规定可见性，再决定传输。通知不是模型上下文，mailbox 也不是立即执行命令。

### Codex CLI：事件协议天然支持多种反馈消费者

Codex 的 item/turn events 可以被 TUI、IDE、日志和通知服务消费；approval/interrupt/response 仍通过 app-server 控制。要实现 mailbox，必须把“投递消息”和“启动新 turn”分开，目标 thread 忙时先排队，并保留来源和权限。

### Pi：事件、RPC、扩展和 TUI 构成反馈面

Pi 的 event stream 可以给 TUI/SDK；扩展可以发桌面通知、写 inbox 或把消息放入下一轮。没有统一的 mailbox/notification 安全协议，应用必须明确消息可见性、队列、目标 session 和是否触发工具。

### 对比结论

Claude Code 的反馈通道层次最明确；Codex 的事件协议适合多消费者；Pi 的事件面最灵活。最容易犯的错误是把通知、消息和命令混成同一个字符串：它们的受众、持久化和副作用都不同。

### 验证动作

让一个长任务产生 UI 状态、OS 通知、团队消息和下一轮 prompt，分别检查是否污染 transcript、是否在忙时排队、是否重复发送、是否需要用户确认。

## Section 48｜系列总结与能力清单

### Claude Code：从一条 loop 走到一套产品系统

48 用总地图回收 00–47：循环、消息、执行、可组合能力、宿主和产品层逐步叠加；系列验收清单要求读者能画出 loop、定位关键符号、解释权限、运行压缩实验、读取 trace、实现最小 harness、说明静态证据边界。它还把 mailbox 与 A2A 区分开：前者是实现，后者是互操作契约。

这个收束让前面“功能章节”重新变成能力链：模型请求只是起点，工具/权限/上下文/恢复/扩展/宿主/反馈共同决定 Agent 是否可用。源码能确认的事实、产品设计推断和实验观察必须分开。

### Codex CLI：控制平面、协议和执行 substrate 的闭环

Codex 的对应闭环是 core/app-server、thread/turn/item、host protocol、approval/sandbox、exec runtime、context compaction、结构化 events 和多客户端。它的优势是把宿主复用和事件可观察做成一等接口；它的边界是很多产品体验由客户端/host 组合而来，不能只看 core。

### Pi：最小 harness 作为可组合基线

Pi 的闭环是 agentLoop、tools/extensions、AgentSession/tree/compaction、TUI/RPC 和 provider adapters。它说明一个最小可嵌入内核足以启动工作流；同时也提醒我们，sandbox、权限、远程、团队协作和后台治理不是自动出现的，需要宿主补齐。

### 对比结论

三者都可以从“模型—工具—结果”开始，但最终产品的形状不同：Claude Code 将治理策略写进运行时，Codex 将多宿主协议和执行边界拆层，Pi 将内核保持可替换并把产品责任外置。没有“功能更多所以更先进”的简单结论；应按任务需要选择控制强度、可嵌入性和宿主复杂度。

### 验证动作

用本文最后的覆盖表任选一个 section，回到对应固定源码快照，完成“符号—调用方—状态—失败边界—用户可观察结果”五步追踪。能完成一次闭环，才算读完一个主题。

## 最终统计：8 个主题，50 个独立 sections

为了避免把几十篇文章重新压成一篇大杂烩，最终只保留以下 8 篇主题文章；每个旧 Claude Code 章节恰好出现一次：

| 主题文章 | 主题 | 覆盖章节 | sections |
| --- | --- | --- | ---: |
| 01 | 控制平面与主循环 | 00-a、00–06 | 8 |
| 02 | 消息、工具与副作用 | 07–15 | 9 |
| 03 | 上下文、安全、恢复与会话 | 16–20 | 5 |
| 04 | 扩展、委派与多 Agent | 21–30 | 10 |
| 05 | 宿主、状态与结构化 IO | 31–34 | 4 |
| 06 | 配置、Provider、远程与运维 | 35–39 | 5 |
| 07 | 记忆与后台智能 | 40–43 | 4 |
| 08 | 体验层、反馈通道与系列收束 | 44–48 | 5 |
| **合计** |  | **00-a、00–48** | **50** |

这里的“50 篇”指原 Claude Code 源码解读文章的章节覆盖数；最终发布物是 8 篇主题文章，每篇包含若干独立 comparison section。旧的 6 篇 `agent-comparison-*` 文章不再保留，也不参与新的统计。

## 读者最后应该带走的五个判断

1. Agent 的核心不是一次模型调用，而是可暂停、可恢复、可授权、可验证的控制循环。
2. 工具、权限、sandbox、回滚和消息回填必须形成闭环，单项功能不能代表全链路安全。
3. 上下文压缩和 session 恢复是在重建控制状态，不是简单保留聊天文字。
4. 扩展、subagent、team 和远程客户端要有发现、能力、信任、生命周期四类契约。
5. 体验、通知、记忆和后台智能只有回到主控制平面、保持可见和可取消，才不会变成隐形副作用。

## 参考材料与写作方法

本系列的外部研究先收集 10 篇 Agent/harness 对比与架构材料，再用源码快照核对，不采用“单篇文章一句话决定结论”的写法。重点参照了 [What makes a harness a harness?](https://arxiv.org/abs/2606.10106) 的定义法、[Harness-native software engineering](https://research.chaitanya.science/papers/harness-native-software-engineering.pdf) 的控制面拆分法、[Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) 的请求展开法、[The harness matters](https://www.masonjames.com/blog/the-harness-matters-codex-claude-code-pi-amp-hermes-compared/) 的维度对比法，以及 [SWE-agent ACI](https://arxiv.org/html/2405.15793) 的实验/消融写法。

在发布前，所有章节都按同一检查表复核：固定源码窗口、明确证据边界、写出参数/状态分支、区分观察与执行、给出失败验证动作、确认章节只出现一次。这样写对比文章慢一些，但读者可以沿着代码和协议回到结论，而不是只能接受作者的印象分。

## 系列结束

如果下一步要继续深挖，最值得做的不是再加一张功能表，而是选一条跨系统实验：相同仓库、相同只读任务、相同工具失败和相同上下文压力，比较三个 harness 的状态事件、权限决策、恢复结果和最终可审计性。
