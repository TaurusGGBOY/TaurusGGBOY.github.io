---
title: "OpenClaw 2.0 之后：从 Gateway 到长期运行 Agent"
published: 2026-09-02T10:00:00+08:00
updated: 2026-09-02
description: "以 OpenClaw 2026.8.2 和 2.0 发布线为边界，拆解 Gateway、会话车道、记忆、插件、子 Agent、节点、Cron 与安全边界，并映射到 Claude Code 系列的数十个观察点。"
tags: ["openclaw", "agent-runtime", "gateway", "multi-agent", "source-code"]
category: "AI / Architecture"
draft: false
image: ""
lang: "zh_CN"
---

## 先看大版本带来的重量级变化

OpenClaw 2026.8.1 被官方发布说明称为 OpenClaw 2.0；本文以它建立的新运行模型为主，再把 2026.8.2 的修复和补强纳入判断。这个版本线的变化不是多接几个聊天渠道，而是把 Agent 从一次请求里的模型循环，搬进了一个由 Gateway 长期持有的应用运行时：消息渠道、浏览器、手机节点、云端 worker、会话、插件、技能、记忆和定时任务，都要经过同一套控制平面。

所以，OpenClaw 不能只按“一个能调用工具的聊天机器人”理解。它更接近一台 Agent 主机：

    WhatsApp / Telegram / Slack / Discord / WebChat / 节点
                              │
                              ▼
                   长驻 Gateway + typed WebSocket
                              │
             session lane + global admission + writer claim
                              │
                              ▼
                 embedded agent loop + tools + plugins
                              │
          memory / skills / cron / browser / canvas / delivery

这个架构带来两面性。一面是它确实覆盖了 Claude Code 系列经常拆开的几十个主题：控制平面、会话路由、后台任务、上下文工程、持久化、权限、工具、插件、记忆、可观测性和部署。另一面是，Gateway 一旦暴露在网络上，聊天账号、浏览器、文件系统、API 凭证和第三方技能就进入了同一个风险模型。OpenClaw 的“能长期运行”必须和“能安全长期运行”分开评价。

## 版本、源码与资料边界

本文以 2026-09-02 的 OpenClaw v2026.8.2 为准，源码来自 [v2026.8.2 官方标签](https://github.com/openclaw/openclaw/tree/v2026.8.2)，发布事实来自 [2026.8.2 release notes](https://docs.openclaw.ai/releases/2026.8.2) 与 [OpenClaw releases](https://docs.openclaw.ai/releases)。官方 2.0 变化集中在 [2026.8.1 说明](https://docs.openclaw.ai/releases/2026.8.1)：过去对话搜索、离开 Gateway 的 paired device/cloud worker、durable progress cards、结构化问题与卡片、交互式 widgets/dashboards、私密凭证请求、recurring work approval，以及更丰富的音频视频处理。

十篇非官方资料已经保存到本项目的 [OpenClaw 研究归档](https://github.com/TaurusGGBOY/TaurusGGBOY.github.io/blob/master/research/agent-articles-2026-09-02/openclaw/sources.md)。它们主要帮助本文比较不同人对“Gateway 是控制面还是消息中转站”“自托管的真实风险”“插件到底扩展了哪些边界”的观察。版本、接口、源码和安全结论仍以官方文档与 tag 为准。

## 1. Gateway：OpenClaw 的第一性边界

### 单 Gateway 统一消息面、控制面和节点面

官方 [architecture 文档](https://docs.openclaw.ai/concepts/architecture)把 Gateway 定义为一个长驻进程。它维护 WhatsApp、Telegram、Slack、Discord、Signal、iMessage 和 WebChat 等消息连接，也接受 macOS app、CLI、Web UI 和自动化客户端的控制请求。默认 WebSocket 监听 127.0.0.1:18789；节点则以 node 角色通过同一协议接入。

这里的“一个 Gateway”不是部署建议，而是状态一致性的约束：同一台主机上的一个 Baileys/WhatsApp session 应该只有一个 Gateway 持有；其他客户端通过 WebSocket 使用它。Gateway 负责 provider connections、typed RPC、事件广播、健康检查、presence、heartbeat 和 cron 触发，避免多个进程各自拥有一份聊天状态。

连接协议也不只是“发一段 JSON”。客户端第一帧要完成 connect handshake，随后区分 request、response 和 event；side-effecting 的 send/agent 请求需要 idempotency key；设备通过 pairing identity 和 device token 建立信任。事件不会被 Gateway 重放，客户端遇到 gap 时应重新拉取状态，而不是假设漏掉的 event 会自动回来。

因此，OpenClaw 的控制平面至少有四种身份：

1. 消息渠道把外部对话变成入站事件；
2. 控制客户端通过 RPC 查询状态、发送消息或启动 Agent；
3. 节点暴露摄像头、录屏、定位、Canvas 等能力；
4. Gateway 把这些请求放入会话与全局运行队列，再把结果投递回合适的面。

这个层次是它与只提供 CLI/SDK 的 coding harness 的第一处分水岭。

### Gateway 不是天然安全的反向代理

官方文档建议优先使用 loopback、Tailscale/VPN 或 SSH tunnel；如果监听非 loopback 地址，则必须配合 token、password 或其他认证，并通过 pairing 管理设备。默认监听在本机，不代表整个系统安全：浏览器、插件、节点和渠道凭证依然可能拥有很高的动作权限。

给 OpenClaw 一台 VPS，等于把文件系统、浏览器、聊天 token、API key 和可发送消息的渠道放到了一个长期进程附近。本文采用这个保守的威胁模型。不要把 WebSocket 握手成功、Gateway health 通过或 skill allowlist 开启，误认为已经完成了 shell、文件系统和凭证隔离。

## 2. Agent Loop：从接收消息到可交付结果

官方 [agent loop 文档](https://docs.openclaw.ai/concepts/agent-loop)给出的主链路可以压成这样：

    agent RPC / CLI
        -> session validation and metadata persistence
        -> runId + acceptedAt
        -> session lane / global lane admission
        -> workspace + skills + bootstrap + system prompt
        -> model resolve / auth / fallback
        -> embedded agent loop
        -> streamed assistant and tool events
        -> transcript writer claim
        -> reply settled
        -> agent.wait / channel delivery

### 接受请求和完成请求是两个时间点

agent 请求不会同步等待整个模型循环，而是先校验 session、持久化必要的 metadata，再立即返回 runId 和 acceptedAt。客户端随后通过 lifecycle event 或 agent.wait 等待结束/错误。这样做对消息渠道很重要：Gateway 可以继续服务其他会话，用户也能看到后台运行中的任务。

runEmbeddedAgent 会先恢复或创建 session，再解析 workspace、模型、认证、skills 快照、bootstrap 文件和插件元数据。它同时受 session lane 与 global lane 约束：同一会话不能让两个 turn 随意写同一份 transcript，整个 Gateway 也需要限制全局并发和资源占用。

源码里还有一个不应被忽略的 writer fence。activeWriterRunId 用来声明当前是谁拥有 transcript 写权限；append/rewrite 会检查 expectedWriterRunId。配合 SQLite writer queue 和 state-directory lock，它防止“一个 Gateway 和一个本地 agent 同时拥有同一个状态目录”时出现交叉写入。

这类 claim 和 lock 不只是性能实现。它们把“模型已经说完”和“结果已经安全写入、可以投递”分开了。2026.8.2 修复列表里关于 session recovery、reply completion、draft/queue recovery、subagent ownership 和 human priority/cancellation 的项目，说明这条边界正是长期运行产品最容易出事故的地方。

### 上下文由多层材料组成

OpenClaw 的一轮 prompt 不是简单的历史消息加 system prompt。workspace root、bootstrap 文件、skills 快照、模型限制、compaction reserve tokens 和本次 run override 都会参与上下文构造。内部 hooks 还能在 before_model_resolve、before_prompt_build、before_agent_reply 等时点修改或阻止流程。

工具调用也有完整的生命周期：before_tool_call 可以阻止；工具结果会做大小和图像清理；tool_result_persist 决定何时进入 transcript；没有 reply token 的工具输出不能直接冒充用户可见回复。重复工具、fallback tool error、超时、取消和自动压缩都需要在事件流中留出明确状态。

这里的关键判断是：OpenClaw 的上下文工程与消息投递是同一条运行链，而不是一个独立的 RAG 插件。它知道某个请求来自哪个 session、哪个 agent、哪个 workspace 和哪个 channel，才有可能把工具结果交给正确的人。

## 3. 记忆、Skills、插件和 Cron：长期运行的四个外置器官

### 记忆不是把 MEMORY.md 读进 prompt

官方的 [memory architecture](https://docs.openclaw.ai/concepts/memory-architecture)与源码共同显示，OpenClaw 的 memory search 使用 SQLite，支持 FTS tokenizer unicode61，可选向量扩展；embedding 可以是本地或远程 provider。默认检索把向量和文本分数混合，再结合 MMR 与时间衰减；session start、search/watch 和 compaction 后可以触发同步。

持久文件也有 provenance 处理。canonical MEMORY.md、legacy memory.md、USER.md 和 memory/*.md 被识别为不同的记忆资产；源码以 workspace/path 和内容 hash 记录来源类别，区分 agent 产生与不可信输入，限制 artifact 大小并支持回滚语义。这个设计比“每次聊天把旧消息拼回去”强，但它仍然需要应用层定义哪些事实值得保存、哪些消息不应入库、用户如何删除和跨 agent 是否共享。

### Skills 是渐进式上下文，不是 shell 授权

官方 [Skills 文档](https://docs.openclaw.ai/tools/skills)定义了 bundled、local、managed、workspace、project 和 plugin skill 的加载优先级。启动时模型只看到技能描述和可用条件，需要时才读取完整 SKILL.md；显式的 $skill 引用还有数量限制。每个 agent 可以有 allowlist，sandbox 也可以有自己的快照。

但文档特别强调：skill allowlist 作用于 prompt、slash command、sandbox 和 snapshot 的可见性，不是宿主 shell 的授权边界。第三方 skill 仍然不可信，执行范围必须由 exec policy、sandbox、文件权限、出网策略和凭证代理共同决定。

### Plugins 把生态扩展到协议和运行时

OpenClaw 的插件不只增加一个工具。根据 manifest 和 capability consent，它可以提供 channel、provider、hook、media、skill、MCP 和插件 HTTP surface。启动时 activation planner 选择要加载的插件，runtime registry 再把方法、工具和事件挂进 Gateway。

因此插件边界需要像服务端模块一样审查：它能否读取会话、取得凭证、发送消息、注册 HTTP 路由、改变模型选择，是否会在 before_tool_call 或 message_sending 中阻止请求。当这些能力在同一个 Gateway 共享状态和凭证时，功能列表越长，默认信任面就越大。

### Cron 把一次性 Agent 变成工作流

官方 [Cron 文档](https://docs.openclaw.ai/automation/cron-jobs)及源码中的 cron types 支持 at、every、带时区和 stagger 的 cron、on-exit watcher，以及由 stream event 触发的任务；delivery 可以是 none、announce 或 webhook。payload 还能是 systemEvent、agentTurn、command、script、heartbeat 或 skill review，并可以收窄 toolsAllow。

这意味着“提醒我”“每天汇报”“某个子 Agent 结束后继续”不必由外部 crontab 拼接一段 prompt。但它也引入了重试、重复投递、时区、失败告警、权限快照、任务所有者和取消优先级。Cron 的结果是否已经落盘、是否已经发送、发送失败后是否会再发一次，都应当写进运维检查表。

## 4. 节点、浏览器和 Canvas：Agent 的动作半径

Nodes 通过 WebSocket 以 node role 接入，能力由 caps/commands 声明。摄像头、screen.record、location.get 和 macOS canvas 等命令让 Agent 可以离开服务器文件系统，调用真实设备。浏览器控制支持 paired local relay；Canvas 和 A2UI 则提供托管的 widgets、dashboards 和可视化交互面。

这些能力解决了“模型只会返回文本”的产品瓶颈，也让权限分析从数据库和 shell 扩展到硬件、屏幕和消息渠道。每个 node 应当有独立身份、可撤销 token、能力清单和人类确认；不要把一个有 camera/location 权限的 node 当作普通 HTTP worker。

OpenClaw 2.0 的 durable progress cards、structured questions/cards、interactive widgets 和丰富音视频，说明它正在把“Agent 输出”从 markdown 文字扩展为带状态的 UI 产物。与 Claude Code 的终端增量文本相比，这里需要额外考虑卡片更新、重连后状态刷新、用户回答的幂等性和跨渠道降级。

## 按 Claude Code 系列的 40 个观察点映射

表中的“有”表示官方源码或文档有明确路径；“可配置”表示能力存在但安全效果依赖部署；“接入”表示核心留了插件/宿主扩展点；“风险”表示功能存在但不能把它等同于安全保证。

| 观察点 | OpenClaw 2026.8.2 的落点 | 对照 Claude Code 系列时应追问 |
|---|---|---|
| 控制平面 | 单 Gateway 持有渠道、RPC、节点与自动化 | 谁拥有全局状态和生命周期 |
| 连接协议 | typed WebSocket，connect/request/response/event | 流式协议是否同时承载控制与数据 |
| 消息归一化 | Gateway 把多渠道事件路由到 session | 不同渠道的身份和回复语义如何统一 |
| Agent Loop | runEmbeddedAgent，串联 intake/context/model/tools/stream/persist | tool turn 和用户可见 reply 的边界在哪里 |
| 接受/完成 | agent 先返回 runId，agent.wait 等待结束 | API 返回 accepted 还是 completed |
| 会话路由 | agent/session key、session lane、agentId | 并发请求怎样绑定到同一上下文 |
| 全局准入 | global lane 与状态目录锁 | 多任务是否会争抢模型、文件和 writer |
| Writer claim | activeWriterRunId、expectedWriterRunId、SQLite writer queue | transcript 能否防止并发覆盖 |
| 上下文 | workspace、bootstrap、skills、run override、模型限制 | system prompt 是静态文本还是运行时产物 |
| 压缩 | reserve tokens、自动 compaction、前后 hooks | 压缩触发和失败是否可观察 |
| 长期记忆 | SQLite FTS + 向量、混合评分、MMR、时间衰减 | history、memory、artifact 是否分开 |
| 记忆来源 | MEMORY/USER/memory 文件 provenance 与 hash | 记忆能否追溯、删除和回滚 |
| Skills | 分层目录、条件过滤、快照、allowlist | skill 说明何时进入上下文 |
| 插件 | channels/providers/hooks/media/skills/MCP/HTTP | 扩展能改哪些生命周期 |
| 工具注册 | 核心工具、插件工具和 per-agent policies | 工具清单由谁在每轮确定 |
| 工具前置钩子 | before_tool_call 可阻止 | 阻止理由是否可向用户解释 |
| 工具结果 | sanitize size/images、持久化钩子、fallback error | 大结果如何避免污染 prompt |
| 消息钩子 | received/sending/sent 等内部与插件 hooks | 发送前取消与模型完成如何区分 |
| 子 Agent | 独立 session、background task、announce result | 子代理的输出是否能伪装成用户指令 |
| ACP/runtime | 原生与 ACP runtime，可限制嵌套 | 委派是进程、会话还是消息协议 |
| 后台运行 | push completion、parent wake/steer、blocked retention | 后台任务怎样回到主会话 |
| Cron | at/every/cron/on-exit/stream event | 长期任务如何重试、去重和投递 |
| Heartbeat | heartbeat payload 与周期唤醒 | 轮询是否会制造无意义成本 |
| 浏览器 | paired local relay、browser tool | 浏览器 profile 与凭证谁拥有 |
| Nodes | node role、caps/commands、设备能力 | 相机、定位、录屏怎样独立授权 |
| Canvas/UI | canvas、A2UI、cards、widgets、dashboards | 结构化 UI 如何重连和降级 |
| 多模态 | 音频、视频与媒体插件 | 媒体输入能否进入同一审计链 |
| 流式 | assistant/tool delta、事件和 channel delivery | 增量状态何时变成最终消息 |
| 回复收口 | settled tool work、reply completion 修复 | 模型停了是否代表用户已收到答案 |
| 重试/回退 | model/auth fallback、自动压缩重试 | 网络重试、模型回退、业务重试是否分层 |
| 模型/Provider | provider 解析、插件 provider、auth profile | 凭证和模型选择是否进入日志 |
| 权限模式 | tool policy、exec approvals、toolsAllow | prompt 中的“允许”是不是实际授权 |
| Sandbox | 可选 sandbox 与 workspace root | 隔离是否覆盖插件、node 和浏览器 |
| 认证 | token/password、pairing、device identity | 非 loopback 暴露时如何拒绝未知设备 |
| 幂等 | side-effecting RPC 要求 idempotency key | 重连/重试会不会重复发消息 |
| 事件恢复 | event 不重放，gap 后刷新状态 | 客户端丢事件时能否收敛 |
| 观测/诊断 | usage、health、presence、cron telemetry | 能否定位“模型完成但没投递” |
| 成本/缓存 | provider usage 与运行状态 | 后台任务的成本归属到谁 |
| 供应链 | 插件、ClawHub/技能与 npm 更新 | 第三方代码更新是否可审阅、回滚 |
| 升级恢复 | 2026.8.2 强化 migration、session、queue recovery | 升级是否保持 session 与 policy |
| CLI/API/客户端 | CLI、macOS app、Web UI、automation、nodes | 一个协议是否能服务不同操作面 |
| 多 Agent/多用户 | agentId、group、workspace、subagent session | 隔离是命名空间还是安全边界 |
| 评测 | 运行状态和诊断面较强，业务正确性需自建 | 工具成功是否等于任务成功 |

这 40 个观察点显示了 OpenClaw 2.0 的真实变化：它把 Claude Code 系列中常被分散到不同文章的能力，放进了一个长驻系统。但是“放在一起”也意味着故障和权限会互相传导。一个渠道消息可以触发模型，一个模型可以调用工具，一个插件可以修改工具策略，一个 cron 可以再次触发 Agent，一个 node 又可能把动作带到真实设备。

## 五个不能跳过的安全与可靠性问题

### 1. Gateway 暴露面

默认 loopback、认证、pairing、Tailscale/VPN 和 SSH tunnel 是基础条件，不是加分项。若必须公网暴露，应把 Gateway 放在明确的网络边界后，限制管理端口、轮换 token、隔离状态目录并记录设备连接。只在 UI 前面加一层登录，不能自动保护内部 WebSocket、插件 HTTP surface 或 node command。

### 2. Skills 与插件的供应链

Skill allowlist 解决“模型能否看到某个技能”的问题，不解决“技能代码能否读文件、执行命令、访问网络”的问题。插件还可能注册 provider、hook、channel 和 HTTP 路由。安装前应审阅源码、锁定版本和依赖，更新后重新检查权限；对第三方技能使用 sandbox、出网限制和最小凭证。

### 3. 记忆污染

memory search 会把过去写入的内容带回未来上下文。网页、聊天消息、工具结果和外部文件都可能试图伪装成高优先级指令。provenance 和 hash 有助于追踪资产，但不会替模型判断事实。应分离 agent 产生的事实、未验证输入、用户偏好和一次性结果，并给删除、过期和人工确认留入口。

### 4. 长期任务的重复副作用

Cron、子 Agent、自动重试和发送渠道组合后，最危险的 bug 往往不是“没执行”，而是“执行了两次”。为每个 side effect 保存 runId、任务 id、delivery 状态和幂等键；把“模型生成完成”“transcript 写入”“渠道确认发送”作为三个可独立检查的状态。

### 5. 事件不是日志回放系统

官方架构说明明确说事件不重放。客户端断线后，不能只等待下一条 event；要重新查询 session、health、run 和 delivery 状态。否则 UI 看到的卡片、后台任务或 presence 可能永远停在旧状态。OpenClaw 2.0 的 rich UI 越多，这条约束越重要。

## OpenClaw 与 Claude Code 系列的关系

如果 Claude Code 系列是在解释“一个 coding agent 如何在本地安全地完成一次工作”，OpenClaw 2.0 研究的是“一个 Agent 如何住在设备、渠道和时间里”。两者共享 Agent Loop、工具调用、上下文压缩、权限和持久化这些底层问题，但控制平面不同：

- Pi 或 Claude Code 式 harness 通常先拥有一个本地运行上下文，再向外接 UI、MCP、subagent 和后台任务；
- OpenClaw 先拥有长驻 Gateway，再把不同渠道、节点、工作区和 Agent loop 接入其中；
- 前者的首要边界是当前 cwd、进程和工具确认，后者还要管理设备 pairing、消息投递、重连、跨渠道身份和长期调度。

因此不能用“OpenClaw 有更多渠道”得出它一定更强。正确的问题是：这些渠道是否共享同一个可审计 session 模型；后台任务是否有 writer 和幂等语义；插件是否受实际执行边界限制；设备能力是否能独立撤销；记忆是否有来源和删除；升级是否能在不重复副作用的情况下恢复。

## 它适合什么，不适合什么

OpenClaw 适合想把 Agent 放在个人设备或自托管环境中，跨消息渠道持续工作，连接浏览器、手机节点、Canvas 和定时工作流的人。它也适合研究多 Agent、长期记忆、背景任务与“用户不必一直守着终端”的产品形态。

它不适合在没有网络隔离、凭证分层、备份、升级回滚和审计的情况下直接暴露到公网；也不适合把第三方 skill、插件和 node 当成普通 UI 扩展。对于只需要一次性代码修改的任务，Gateway、渠道和长期调度会增加很多不必要的状态面。

一句话总结：

    OpenClaw 2026.8.2 的核心进步，是把 Agent 从一次 turn 做成可接入渠道、设备、时间和工作区的长期运行系统；
    它的核心风险，是这些能力共享 Gateway 后，任何一条权限或恢复链路出错，都会把模型输出变成真实世界的重复副作用。

## 资料与代码索引

### 官方资料

- [Architecture](https://docs.openclaw.ai/concepts/architecture)：Gateway、客户端、节点、WebSocket、pairing 和事件语义。
- [Agent loop](https://docs.openclaw.ai/concepts/agent-loop)：runId、准入、上下文、工具、持久化、hooks 和完成状态。
- [Subagents](https://docs.openclaw.ai/tools/subagents)：独立 session、后台任务、announce、parent wake 和 ACP。
- [Skills](https://docs.openclaw.ai/tools/skills)：加载优先级、快照、allowlist 与不可信技能提醒。
- [Memory architecture](https://docs.openclaw.ai/concepts/memory-architecture)：记忆文件、检索和长期存储边界。
- [Cron jobs](https://docs.openclaw.ai/automation/cron-jobs)：定时、事件、投递与失败处理。
- [Security](https://docs.openclaw.ai/gateway/security)、[Sandboxing](https://docs.openclaw.ai/gateway/sandboxing)、[Exec approvals](https://docs.openclaw.ai/tools/exec-approvals)：部署与动作授权。
- [Gateway server kernel](https://github.com/openclaw/openclaw/blob/v2026.8.2/src/gateway/server-kernel.ts)、[HTTP server](https://github.com/openclaw/openclaw/blob/v2026.8.2/src/gateway/server-http.ts)：Gateway 运行时与 HTTP/WS surface。
- [Embedded run orchestrator](https://github.com/openclaw/openclaw/blob/v2026.8.2/src/agents/embedded-agent-runner/run-orchestrator.ts)、[memory search](https://github.com/openclaw/openclaw/blob/v2026.8.2/src/agents/memory-search.ts)：Agent 准入和记忆检索实现。
- [v2026.8.2 release notes](https://docs.openclaw.ai/releases/2026.8.2)、[OpenClaw 2.0 / v2026.8.1](https://docs.openclaw.ai/releases/2026.8.1)：重量级能力和修复边界。

### 十篇非官方阅读池

这些资料用于补充架构图和自托管视角，版本事实仍以官方 tag 为准：[Majid Mazouchi](https://majid-mazouchi.github.io/autonomy/assets/posts/openclaw-architecture.html)、[Chen Kai](https://www.chenk.top/en/openclaw-quickstart/03-architecture/)、[GetClaw](https://getclaw.sh/blog/openclaw-architecture-three-concepts-every-founder-should-know)、[Sam Selvanathan](https://samselvanathan.com/posts/securely-self-host-openclaw-vps/)、[Valletta Software](https://vallettasoftware.com/blog/post/openclaw-architecture-diagram-2026)、[Nebius](https://nebius.com/blog/posts/openclaw-security)、[AIFOSS](https://aifoss.dev/blog/openclaw-review-2026/)、[TechSpot](https://www.techspot.com/news/113686-openclaw-20-lands-easier-setup-rebuilt-browser-app.html)、[AI Claw Guide](https://aiclawguide.com/openclaw-architecture)、[AgentWay](https://agentway.dev/en/openclaw/architecture)。
