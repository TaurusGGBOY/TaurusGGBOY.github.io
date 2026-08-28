---
title: "Agent主题对比05｜从 CLI 切到 IDE 或云端，状态会不会断"
published: 2026-08-12T10:05:00+08:00
updated: 2026-08-28
description: "Claude Code 通过工作台与 teleport 迁移会话，Codex 用 App Server 持有 thread，Pi 提供 TUI/RPC/SDK，DeepSeek Harness 用 profile 重组宿主。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi", "deepseek-harness", "app-server", "runtime-state"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-05-host-runtime/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-05-host-runtime"
series: "agent-theme-comparison"
order: 5
difficulty: "advanced"
time: "15 min"
prerequisites:
  - "需要在终端、IDE、浏览器或内部系统间切换 Agent"
  - "能区分客户端状态与任务执行状态"
topics:
  - "宿主状态"
  - "Claude Code"
  - "Codex App Server"
  - "Pi RPC 与 SDK"
  - "DeepSeek Harness Profiles"
  - "断线与并发"
status: "verified"
verified_at: "2026-08-28"
---

四者都有不止一种入口，但状态所有权完全不同。Claude Code 把不同工作台当成有边界的产品会话，并提供特定迁移通道；Codex 让长生命周期 App Server 持有 thread；Pi 让集成者在 TUI、RPC 和 SDK 三种合同中选择；DeepSeek Harness 用 profile 决定整套运行时怎样装配。界面能打开同一任务，不代表界面消失后任务仍属于同一个系统。

## Claude Code 对 Codex：迁移会话，还是让客户端只是窗口

Claude Code 覆盖 CLI、VS Code、桌面端与 Web，但 [Sessions 文档](https://code.claude.com/docs/en/sessions) 明确指出，不同表面分别维护自己的 session history。CLI 的本地 transcript、桌面端历史和 Web 会话不是天然共享的一份实时状态。相比 Codex，这种设计更像多个完整工作台，而不是所有 UI 都连接同一后台 thread。

Claude Code 的优势是迁移路径面向用户。[Web 文档](https://code.claude.com/docs/en/claude-code-on-the-web) 区分本地 `--resume` 与把云端会话带回终端的 `--teleport`；后者连同分支和对话处理。用户不必设计客户端协议，但必须理解“在哪个表面继续”会改变会话与代码环境，随意从另一入口打开并不等于无缝接管。

Codex 的 [App Server](https://openai.com/index/unlocking-the-codex-harness/) 把状态切得更像服务：长生命周期进程托管 threads，客户端通过双向 JSON-RPC 驱动 turn 与 item。浏览器标签页或 IDE 可以短命，服务端 thread 才是状态真相源。与 Claude Code 的 teleport 相比，Codex 的优势是客户端不必拥有任务；重连后可以追赶服务端事件。

短板也落在服务化边界。Codex 不替集成者完成连接恢复、认证、租户隔离、事件去重和 UI 状态机；Claude Code 用户接受官方迁移语义，少维护这些协议。只需要在官方工作台间移动时，Claude Code 更省工程；要让多个自建入口观察同一后台任务时，Codex 更适合作为底座。

## Pi 对 Codex：三种集成合同，还是一套共享执行语义

Pi 同时提供交互式 TUI、stdin/stdout JSONL 的 RPC 和可嵌入 Node.js 的 SDK。[文档首页](https://pi.dev/docs/latest) 把三者作为不同使用方式，[RPC 文档](https://pi.dev/docs/latest/rpc) 让外部进程收发事件与交互请求，[SDK 文档](https://pi.dev/docs/latest/sdk) 则允许同进程直接访问 Agent 状态。相比 Codex，Pi 给集成者更轻、更直接的选择，不必先接受一套服务端产品模型。

Pi RPC 的优势是跨语言与进程隔离，SDK 的优势是类型安全和直接控制；两者之间并非无成本切换。某些依赖 TUI 的自定义界面在 RPC 下会降级，SDK 宿主还要自己传播取消、创建 session、释放 extension 资源。Codex App Server 把这些概念集中到 thread/turn/item，协议更重，却更适合多个客户端围绕共同语义协作。

Pi 的短板在并发与持久服务责任。它的 JSONL session 可以恢复和分叉，但“多个入口能读同一格式”不意味着它们可以同时安全写同一文件。Codex 明确把服务端设为状态持有者，Pi 则要求集成者决定谁启动进程、谁拥有 session、客户端断开后是否继续、第二个客户端怎样接管。

因此，做单机工具嵌入时，Pi SDK 往往比 Codex App Server 少一层网络和状态机；做浏览器任务中心时，Codex 已有的持久 thread 比 Pi RPC 子进程更接近目标。Pi 给的是组件级合同，Codex 给的是服务级合同；前者灵活而局部，后者统一但需要平台化部署。

## DeepSeek Harness 对 Pi：入口模式，还是整套 profile 装配

DeepSeek Harness 的[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 描述 `web`、`headless`、`sdk`、`sdk-minimal`、`acp` 等 profiles，每个 profile 在启动时组合 session、loop、工具、持久化、approval、sandbox 与宿主组件。相比 Pi 的 TUI/RPC/SDK 入口，DeepSeek Harness 不只更换调用方式，还允许入口决定整棵插件树。

这对异构平台是优势。一个 headless profile 可以减少交互部件，一个 web profile 可以接入浏览器与实时 patch，一个 ACP profile 可以使用相应协议。Pi 更适合在同一个最小 Harness 周围选择宿主合同；DeepSeek Harness 更适合让不同宿主拥有不同运行时组合。后者控制更深，也让“同一个 Agent”更难定义。

DeepSeek Harness 的短板是状态迁移需要同时考虑 profile 兼容。一个 web profile 产生的会话，能否由 headless profile 恢复，取决于两边安装的 session、tool、provider 和事件消费者，而不是只看会话 ID。Pi 在不同入口间也需要兼容 extensions，但最小核心减少了变化层次；DeepSeek Harness 的运行图越不同，迁移测试越像平台发布测试。

项目仍处 developer preview，[README](https://github.com/deepseek-ai/deepseek-harness) 警告兼容性可能破坏。因此 profiles 当前更适合探索宿主与运行时组合，不应被写成已经稳定的跨端迁移协议。若团队只需要“从 Node 进程调用 Agent”，Pi SDK 的较窄合同通常更容易维护；若要同时研究 Web、ACP 与异构 provider，DeepSeek Harness 才体现差异价值。

## 审批、断线与并发会暴露谁真正持有状态

团队权限模型也会随宿主变化。Claude Code 官方入口沿产品账号与本地环境组织访问；Codex 自建宿主需要把自己的用户身份映射到 thread、审批和工具凭据。Pi RPC/SDK 常继承承载进程的身份，若多个用户共享一个服务，租户隔离完全由集成者补齐；DeepSeek Harness profiles 可以装配 credential 与 transport 服务，但预览架构不替部署者证明租户边界。

从终端切到 IDE 时，Claude Code 用户主要确认是否进入同一产品会话及同一仓库；Codex 客户端主要确认是否订阅正确 thread；Pi 集成者要确认 TUI 与 RPC/SDK 是否指向同一 session 文件且没有双写；DeepSeek Harness 要确认两个 profiles 对 session 与工具事件有兼容解释。四者表面都能“继续”，所需一致性检查从产品级一路加深到运行图级。

从本地切到云端，Claude Code 的 teleport 把迁移做成显式产品动作，优势是边界清楚，短板是只能按产品支持的路径走。Codex 若服务端原本就在远端，客户端切换较轻，但执行环境和凭据由平台负责。Pi 可以把 RPC 进程部署到远端，却要自己补认证、队列和持久化；DeepSeek Harness 可以选择 web 或 headless profile，也要自己承担部署与兼容。

成本模型因此不同。Claude Code 主要支付产品席位与使用成本；Codex 产品团队还要支付常驻服务、客户端开发和状态存储；Pi 团队可能从一个本地子进程起步，但一旦远程多人使用，就会逐步重造服务治理；DeepSeek Harness 在此基础上还要维护 profile 和插件版本。能嵌入不等于已经适合多租户运行。

可观测性也跟着状态所有者走。Claude Code 用户主要使用官方界面与会话记录；Codex 平台能从 item 流构建自己的监控；Pi 宿主必须自行汇总 RPC/SDK 事件；DeepSeek Harness 可以装配 telemetry 插件，但必须确保不同 profile 发出可比较的数据。控制面越开放，监控越能贴合组织，也越不能依赖产品默认值兜底。

退出路径也应演练：Claude Code 要确认会话与分支能导出，Codex 要隔离客户端协议适配，Pi 要保存可迁移 session，DeepSeek Harness 要固定 profile 清单。切换入口容易，切换状态所有者才昂贵。

这笔迁移成本必须在选型试验中实际计时，而不是上线后才发现。

审批等待时，Claude Code 的官方工作台负责呈现请求，跨表面迁移需遵循其会话边界；Codex 服务端可以暂停 turn 并向客户端发出请求，客户端消失后仍要有超时与接管策略。Pi RPC 把扩展交互建模为带 ID 的请求/响应，宿主必须决定断线时怎样结束；DeepSeek Harness 的处理则取决于 profile 中装配的 approval 与 transport。

后台任务也不同。Claude Code 云端工作有远程环境，不能把本地 CLI 进程的生命周期直接类比过去；Codex 服务端 thread 天然适合客户端短暂离线；Pi SDK 若嵌在应用进程里，应用退出通常意味着运行时一起退出，RPC 是否常驻由宿主决定；DeepSeek Harness headless 能否持续，则由部署方式与插件生命周期共同决定。

并发是最容易被“多入口”掩盖的短板。Claude Code 文档提醒，同一 session 在两个终端同时恢复而不分叉，会把消息交错写入同一 transcript。Codex 可以让多个客户端连接，却仍需定义写入所有权。Pi 不提供现成的多写者 session 协调，DeepSeek Harness 的不同 transports 也不会自动解决业务级冲突。能重连不是能并发写。

验收必须把客户端直接杀掉。Claude Code 要验证本地与云端迁移后的分支一致；Codex 要验证服务端继续运行且新客户端不会重复 item；Pi 要分别验证 RPC 子进程与 SDK 宿主退出后的清理；DeepSeek Harness 要验证 profile 重启后插件图与会话兼容。只有这些结果能回答“状态会不会断”，入口数量回答不了。

## 裁决：选择状态所有者，不是选择界面

| 产品 | 优势 | 短板 | 代价 | 适合谁 |
| --- | --- | --- | --- | --- |
| Claude Code | 多个成熟工作台，并有明确 resume/teleport 路径 | 各表面历史有边界，不是任意实时共享 | 理解本地、云端、分支和会话迁移规则 | 主要使用官方入口、偶尔跨端继续的团队 |
| Codex | App Server 持有持久 thread，客户端可短命 | 自建宿主要实现连接、身份、事件与并发治理 | 运行长生命周期服务并维护协议状态机 | 建设 IDE、Web 或内部任务中心的产品团队 |
| Pi | TUI、RPC、SDK 合同直接，嵌入方式灵活 | 并发所有权与后台生命周期由集成者设计 | 管理进程、session、取消和扩展资源 | 单机嵌入、跨语言子进程或定制终端工具 |
| DeepSeek Harness | profile 可同时重组宿主与运行时 | 跨 profile 状态兼容复杂，且仍在预览期 | 固定插件图并测试启动、迁移和恢复 | 研究多种宿主与异构运行组合的平台团队 |

只在官方工作台间工作，Claude Code 的迁移入口最直接；要让服务端任务独立于界面，Codex 的状态模型最清楚；要把 Agent 嵌进现有进程，Pi 的 SDK/RPC 更轻；要让不同宿主连运行时部件都不同，DeepSeek Harness 控制最深。先决定状态属于谁，再决定 UI 长什么样。

## 本篇引用来源

- [Claude Code：Manage sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code：Use Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [OpenAI：Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi：Documentation](https://pi.dev/docs/latest)
- [Pi：RPC Mode](https://pi.dev/docs/latest/rpc)
- [Pi：SDK](https://pi.dev/docs/latest/sdk)
- [Pi：Sessions](https://pi.dev/docs/latest/sessions)
- [DeepSeek Harness：Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness：README](https://github.com/deepseek-ai/deepseek-harness)
