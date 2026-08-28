---
title: "Agent主题对比05｜CLI、IDE 与云端由谁持有状态"
published: 2026-08-12T10:05:00+08:00
updated: 2026-08-28
description: "比较 Claude Code、Codex、Pi 与 DeepSeek Harness 在 CLI、IDE、桌面端和云端中如何持有会话、事件、审批与运行生命周期。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi", "deepseek-harness", "app-server", "runtime-state"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-05-host-runtime/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-05-host-runtime"
series: "agent-theme-comparison"
order: 5
difficulty: "advanced"
time: "17 min"
prerequisites:
  - "Agent主题对比 02｜一次 Agent 任务怎样跑完"
  - "Agent主题对比 04｜长任务怎样保持上下文并恢复"
topics:
  - "host runtime"
  - "CLI and IDE"
  - "App Server"
  - "RPC and SDK"
  - "session ownership"
  - "remote recovery"
  - "DeepSeek Harness"
status: "verified"
verified_at: "2026-08-28"
---

答案是：状态由真正运行 Agent loop、保存会话并发出事件的一侧持有，不一定是你眼前的窗口。宿主会决定任务能否在关掉 UI 后继续、审批从哪里返回、多个客户端能否看到同一时间线，以及断线后由谁恢复。CLI、IDE 和云端绝不是三套皮肤。

你在终端发起重构，随后打开 IDE 看 diff，午饭时又想让云端继续跑测试。如果三个入口各自保存一份聊天，它们只是看起来像同一个 Agent；如果都连接同一条持久 thread，才可能共享进度。判断关键不在界面数量，而在状态的所有者和事件协议。

所谓“状态”，不只是聊天记录。

一次运行至少包含四类状态：会话历史、正在执行的 turn、审批与用户输入的等待点、承载文件和进程的环境。客户端可以显示这些信息，也可以拥有其中一部分；只有运行时知道工具是否仍在执行、某个审批是否已过期、网络断开后任务是否继续。

因此，判断宿主边界时要问：关闭界面会不会终止任务？新客户端能否从稳定标识恢复？历史事件由谁保存？审批请求由谁发起并暂停执行？客户端与服务端版本不一致时如何协商？这些问题比“有没有桌面端”更接近真实控制权。

## Claude Code：多个工作台，各有会话边界

Claude Code 覆盖 CLI、VS Code、桌面端和 Web，但官方会话文档明确说明，桌面端、Web 和 VS Code 扩展分别维护自己的 session history；CLI 会话则持续写入本地 transcript。[Manage sessions](https://code.claude.com/docs/en/sessions) 这意味着“产品表面很多”不等于任意表面都在实时驱动同一份本地状态。

云端会话有自己的远程环境。官方文档区分 `--resume` 与 `--teleport`：前者恢复这台机器上的本地历史，后者把云端会话的分支和完整对话带回终端。[Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) 这种切换需要连同仓库分支与会话一起处理，因为对话连续而代码环境错位，仍会恢复到错误现实。

Claude Code 更像一组相互衔接的产品工作台。它提供明确的本地和云端迁移入口，但不能从统一品牌推断所有入口天然共享一个在线 session。适合它的验收方式，是分别测试本地恢复、云端恢复和跨环境 teleport，而不是只看界面能否打开同一仓库。

## Codex：App Server 把 Harness 变成可驱动服务

OpenAI 设计 App Server 的目的，是让 IDE 等客户端驱动同一个 Codex Harness，而不在每个 UI 里重写 agent loop。[Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/) 中，App Server 既是双向 JSON-RPC 协议，也是托管 Codex core threads 的长生命周期进程。

它把会话拆成 thread、turn 和 item。thread 是可持久化的会话容器；turn 是一次用户输入触发的工作；item 表示消息、工具执行、审批、diff 等有生命周期的单元。客户端请求可以产生多个服务端通知，服务端也能主动发起审批请求并暂停当前 turn，直到客户端允许或拒绝。[App Server conversation primitives](https://openai.com/index/unlocking-the-codex-harness/)

在 Web 场景中，OpenAI 明确把服务端作为状态真相源：浏览器标签页和网络都可能消失，任务进度留在服务端，新会话重连后再追上事件。[App Server web runtime](https://openai.com/index/unlocking-the-codex-harness/) 这比“把 TUI 包进 WebView”多了一层承诺：客户端可以短命，thread 必须持久。

这种结构也有代价。协议要维护版本与能力协商，客户端要正确处理事件顺序、重复通知、审批等待和断线重连。App Server 证明了统一 Harness 可以被多个客户端驱动，不能据此推出每个 Codex 产品表面都共享同一执行环境或同一权限配置。

## Pi：TUI、RPC 与 SDK 暴露不同集成合同

Pi 把自己定位为 minimal agent harness，并提供交互式 TUI、基于 stdin/stdout JSONL 的 RPC 模式，以及可嵌入 Node.js 进程的 SDK。[Pi 文档首页](https://pi.dev/docs/latest) 这三种入口分别适合人直接操作、跨语言子进程集成和同进程编程控制。

RPC 模式会把 Agent 运行事件流式写到 stdout，客户端通过命令读取状态、提交 prompt，并处理扩展触发的交互请求。需要确认、选择或输入时，RPC 使用带 ID 的请求/响应子协议；部分强依赖 TUI 的自定义界面能力会降级或不可用。[Pi RPC mode](https://pi.dev/docs/latest/rpc) 这正说明宿主不是透明层：同一个扩展放进不同宿主，交互合同可能变化。

SDK 则允许调用方直接访问 agent state、选择工具并装载 extensions；官方建议，同进程、需要类型安全和直接状态访问时用 SDK，跨语言或需要进程隔离时用 RPC。[Pi SDK](https://pi.dev/docs/latest/sdk) 选择 SDK 也意味着宿主进程要承担更多生命周期责任，例如何时创建 session、怎样传播取消、怎样清理扩展资源。

Pi 的会话仍以 JSONL 文件保存，可恢复、分叉和树形导航。[Pi Sessions](https://pi.dev/docs/latest/sessions) 但“多个入口都能读会话格式”不等于允许多个客户端安全地同时写同一文件。并发所有权需要调用方自己设计和验证。

## DeepSeek Harness：profile 在启动时组装运行时

DeepSeek Harness 公开架构把一次运行描述为由有序层在启动时组成的 Cordis plugin tree。官方提供 `web`、`headless`、`sdk`、`sdk-minimal` 和 `acp` 等 profile；其中多数 profile 共享 `dsh-base`，再加上浏览器应用、一轮运行器或 JSON-RPC 服务等不同宿主组件。[DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

这个设计把 UI 与运行时组合变成配置问题：profile 决定装入哪些 session、agent loop、工具、持久化、审批和 sandbox 服务。Web profile 可以实时重载 patch，而 headless、SDK 和 ACP profile 在启动时应用配置一次，因为持有任务后替换依赖会破坏生命周期。这里的“可替换”是官方架构主张，不是兼容性或可靠性实测结论。[Architecture：profiles and bundles](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

它与 Codex App Server 的侧重点不同。Codex 先固定 thread/turn/item 和客户端协议，再让多个产品表面复用 Harness；DeepSeek Harness 先把运行时本身拆成可组合服务，再由 profile 决定宿主。前者更关注稳定驱动面，后者更关注运行时可重组性。两者都需要实测断线、并发和审批语义，不能凭架构图推导质量排名。

DeepSeek Harness 目前仍是 developer preview，README 提醒会有兼容性破坏；`SAFETY.md` 明确表示尚未经过安全审计，不能视为安全或生产就绪。[README](https://github.com/deepseek-ai/deepseek-harness)；[SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) profile 中出现 sandbox 与 approval 插件，也不能替代外部隔离和生产安全评估。

## 谁负责等待、断线和并发

宿主状态最容易在三种时刻暴露问题。第一种是审批：如果运行时在等待，UI 必须准确展示请求、来源和作用范围；客户端消失后，服务端要决定继续等、超时还是取消。Codex 的双向协议让服务端能主动请求审批并暂停 turn；Pi RPC 把扩展 UI 交互建模为请求/响应。[Codex App Server](https://openai.com/index/unlocking-the-codex-harness/)；[Pi RPC](https://pi.dev/docs/latest/rpc)

第二种是断线。真正的远程运行不能把浏览器内存当真相源。保存 thread 只解决事件恢复，还要检查工作环境是否存活、工具是否可重试、审批是否仍有效。第三种是并发：两个客户端同时向同一会话发送输入时，系统必须定义排队、拒绝或分叉，而不是让事件静默交错。

状态所有权还决定取消语义。用户在 IDE 点击停止时，究竟只停止界面流式显示，还是取消服务端 turn 和正在运行的子进程？取消消息若在断线后迟到，运行时又怎样避免把已经完成的结果误标为中断？这些行为需要从事件记录和实际进程中核对，不能只凭按钮动画判断。

Claude Code 的会话文档甚至提醒，同一 session 在两个终端同时恢复而不分叉时，消息会交错写入同一 transcript。[Claude Code Sessions](https://code.claude.com/docs/en/sessions) 这是一个很具体的边界：能同时打开，不代表具备安全的多客户端并发控制。

## 选择宿主时看责任归属

如果你主要在一个终端里工作，优先看本地会话是否透明、进程中断后能否恢复、文件状态是否容易核对。频繁在 CLI 与 IDE 之间切换时，要确认两者是否驱动同一 thread，还是各自复制上下文。要把任务放到云端运行，则应验证关闭客户端后谁继续执行、怎样重连、凭据与代码环境由谁保存。

可以用一次故意断线做最小验收。在入口 A 发起会修改两个文件并运行测试的任务，等它进入工具执行后关闭窗口；从入口 B 重连，检查 thread 标识、已完成 item、未决审批和工作树是否一致。随后同时打开两个客户端，各提交一条互斥指令，观察系统是排队、拒绝、分叉还是交错执行。最后重启承载进程，再确认它能否区分“历史可读”和“任务仍在运行”。

这组测试会暴露界面演示看不到的问题。若新客户端只能看到最终文字，却看不到工具与审批事件，它无法可靠接管；若 thread 恢复了，临时进程和凭据却已经消失，运行状态也没有真正恢复；若两个客户端都能写入但没有并发规则，所谓共享状态反而增加误操作概率。把这些结果记录下来，再谈跨端体验是否成立。

Claude Code 提供集成式工作台与明确的本地、云端迁移入口；Codex 用 App Server 把持久 thread 和事件协议放到客户端之下；Pi 给集成者 TUI、RPC、SDK 三种合同；DeepSeek Harness 允许 profile 重组宿主与运行时。[Claude Code Sessions](https://code.claude.com/docs/en/sessions)；[Codex App Server](https://openai.com/index/unlocking-the-codex-harness/)；[Pi Documentation](https://pi.dev/docs/latest)；[DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 选择结果取决于你愿意承担哪一层状态管理，而不是哪家界面最多。

下一篇会沿着这个边界继续：当你要加入数据库工具、项目规则或自定义审批时，应该扩展既有 Harness，还是替换运行时的一部分。

## 资料来源

- [Claude Code：Manage sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code：Use Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [OpenAI：Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi：Documentation](https://pi.dev/docs/latest)
- [Pi：RPC Mode](https://pi.dev/docs/latest/rpc)
- [Pi：SDK](https://pi.dev/docs/latest/sdk)
- [Pi：Sessions](https://pi.dev/docs/latest/sessions)
- [DeepSeek Harness：Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness：README](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness：SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
