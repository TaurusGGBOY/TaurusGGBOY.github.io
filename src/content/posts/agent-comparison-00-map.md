---
title: "Agent源码对比00｜Claude Code、Pi 与 Codex CLI 的工程地图"
published: 2026-08-12T10:00:00+08:00
updated: 2026-08-12
description: "从控制平面、数据平面、工具、状态和宿主五个观察面，建立 Claude Code、Pi 与 Codex CLI 的源码对比地图。"
tags: ["agent-source-comparison", "ai-agent", "claude-code", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-comparison-00-map/agent-comparison-cover-handdrawn.png"
imagePosition: "left"
---

# Agent源码对比00｜Claude Code、Pi 与 Codex CLI 的工程地图

如果把 Claude Code、Pi 和 Codex CLI 都叫作“能写代码的 Agent”，它们的界面确实很像：输入一句话，模型决定下一步，工具读写项目，最后返回结果。

但源码一打开，差异马上出现了。Claude Code 把大量能力压在一个围绕 `queryLoop()` 组织的 TypeScript 运行时里；Pi 把核心收敛成可以被 TypeScript 扩展重新组装的最小 harness；Codex CLI 则用 Rust core、线程持久化、应用服务器和原生沙箱，把 Agent 做成一个可以被宿主程序长期驱动的系统。

这不是“谁的功能更多”的比较。更有用的问题是：**三个系统把哪一部分责任放在 Agent 内核里，又把哪一部分交给宿主、操作系统或扩展作者？**

## 介绍本章的一些概念

- **Harness**：包裹模型的工程运行时。它负责上下文、工具、权限、状态和宿主交互，模型只是其中一个决策部件。
- **控制平面**：决定什么时候采样、是否执行工具、是否继续、是否暂停等待用户，以及这次工作何时结束。
- **数据平面**：承载消息、工具结果、文件变化、会话记录和事件。数据平面不一定决定下一步，但它决定下一步能看到什么。
- **宿主**：终端、IDE、RPC 客户端、SDK 调用方或服务进程。宿主把外部输入交给内核，再把内核的事件变成用户能理解的结果。
- **证据窗口**：本文不把“当前网上的产品行为”直接当作源码事实，而只比较三个固定窗口：Claude Code `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/`，Codex CLI commit `4ef836f883c38ba6d39e6920f335ce6452b7de33`，以及 Pi commit `534bcbffb7e1e7551d9ee3572dfeb278e203e493`。

Codex 和 Pi 是从官方仓库归档得到的源码快照，并保留了 `.source-remote` 和 `.source-commit` 标记。它们不是带完整提交历史的工作树，所以本文会引用“某个固定提交中的文件和符号”，不会把目录结构解释成项目全部历史。

## 问题｜为什么同一句话会得到三种不同的 Agent 行为

假设用户输入：

> “先找出登录流程，再跑测试；如果要改文件，先告诉我。”

三套 Agent 都可能先读取文件、运行搜索、请求工具调用。但后续差异并不由这句话本身决定，而由五个问题决定：

1. 谁持有当前 turn 的状态？
2. 工具结果以什么形式回到下一次模型请求？
3. “先告诉我”是权限回调、策略判断，还是扩展事件？
4. 历史记录和当前 prompt 是同一份数据，还是两种投影？
5. 终端或 IDE 能不能在模型工作时插入新输入、暂停或恢复？

如果只比较默认工具名称，会漏掉真正决定行为的层。**Agent 的产品体验，往往是模型输出之外的五个边界共同产生的。**

## 一张共同地图

![Claude Code、Pi 与 Codex 的五平面工程地图](/images/posts/agent-comparison-00-map/agent-comparison-00-map-handdrawn.png)

为了横向阅读，先把每套源码放进同一张坐标纸：

| 观察面 | Claude Code 2.1.88 | Pi 固定快照 | Codex CLI 固定快照 |
|:--|:--|:--|:--|
| 控制中心 | `restored-src/src/query.ts` 的 `queryLoop()` | `packages/agent/src/agent-loop.ts` 的 `agentLoop()` / `runAgentLoop()` | `codex-rs/core/src/session/handlers.rs` 的 `submission_loop()` 与 `codex-rs/core/src/session/turn.rs` 的 `run_turn()` |
| 模型可见状态 | 消息数组、`toolUseContext`、压缩视图、系统上下文 | `AgentContext`、`AgentMessage[]`、`transformContext()` 与 `convertToLlm()` | Thread 历史、Turn context、world state、skills/plugins 注入 |
| 工具回路 | 流式 `tool_use`、权限回调、结果回填，再次进入 loop | `executeToolCalls()` 产出工具结果事件，继续 `runAgentLoop()` | `run_sampling_request()` 驱动工具、事件、审批和后续采样 |
| 会话/状态 | transcript、compact 结果、session memory、memdir | JSONL 树、`id/parentId`、SessionManager、compaction entry | Thread/Turn/Item、thread-store、rollout、turn 内 auto-compact |
| 宿主边界 | REPL、print/headless、SDK、MCP/Bridge 等入口 | interactive、print/JSON、RPC、SDK | `codex app-server` 的双向 JSON-RPC、CLI/TUI 与其他客户端 |
| 扩展/安全 | tools、hooks、MCP、plugins、permission context、sandbox | TypeScript Extensions、Skills、Packages；权限与隔离可外接 | ToolRouter、approval/execpolicy、skills/plugins、平台 sandbox |

这张表不是说三套系统有相同模块，而是给阅读者一个“同一个问题应该去哪里找”的索引。例如，“模型为什么继续调用工具”属于控制平面；“工具结果为什么在下一次请求出现”属于数据平面；“用户为什么看到了确认弹窗”则要继续追宿主和授权边界。

## 三个控制中心，三种取舍

### Claude Code：一个生产级循环承接大量外围机制

`restored-src/src/query.ts` 中的 `queryLoop()` 是一个异步生成器。它在每次迭代中处理消息视图、工具结果、上下文压缩、模型流、停止 hook 和继续条件，然后通过 `yield` 把事件交给上层。这个选择让同一条循环可以被 REPL、SDK、子 Agent 和 headless 入口共享。

它的优点是外围能力可以沿着同一条主链路汇合：记忆、技能、MCP、权限和工具都能影响下一次采样。代价是主循环会承受很多产品边界，读者必须不断区分“改变模型输入的逻辑”和“决定是否继续的逻辑”。

### Pi：把循环做薄，把可塑性放到 TypeScript 边上

`packages/agent/src/agent-loop.ts` 的 `agentLoop()` 只做一件核心事情：启动 `runAgentLoop()`，把 `AgentEvent` 推入事件流，并在完成时结束流。真正的上下文转换、模型调用和工具执行通过 `AgentContext`、`AgentLoopConfig` 与 `executeToolCalls()` 组合。

Pi 的 coding-agent README 把自己定位成 minimal terminal coding harness，并明确提供 interactive、print/JSON、RPC、SDK 四种模式。它还明确说默认不内置 sub-agents 和 plan mode，而是让扩展或包来补齐。这是一种工程选择：核心保持容易改，复杂工作流放在可替换的 TypeScript 层。

### Codex：把 Thread、Turn 和宿主控制面做成一等对象

Codex 的 `submission_loop()` 不是简单的“收到 prompt 就调用模型”。它从 submission channel 接收用户输入、审批、打断、压缩、动态工具、MCP 刷新、协作消息和关闭等操作，再把普通输入交给 `run_turn()`。

`run_turn()` 内部先处理 pre-sampling compact、上下文和插件/技能注入，再进入采样循环；模型需要继续时，循环可能因为 pending input、工具后续或上下文窗口而继续。与此同时，`codex app-server` 用 Thread、Turn、Item 把长期会话和中间副作用公开给宿主。

它的中心不是“一个很长的函数”，而是**会话运行时加宿主协议**。这使 IDE 可以把审批、工具执行、增量输出和恢复做成稳定的 UI；同时也意味着读者要同时读 core、app-server 和 protocol 三个边界。

## 源码阅读的四条路线

如果你沿用前面 Claude Code 系列的读法，可以按下面顺序比较，而不要一开始就遍历三个仓库：

1. **先画一次 turn**：从 01 篇进入三个主循环，记录输入、采样、工具、继续和终态。
2. **再画一次上下文**：追踪同一条消息如何被持久化、压缩、分支和重新投影。
3. **接着画授权链**：把工具契约、用户审批、策略判断和 OS sandbox 分开。
4. **最后看宿主协议**：观察外部程序能看到哪些事件、能否发送新输入，以及谁拥有暂停/恢复权。

每篇文章都会沿这条路线增加一个心智模型。判断一个结论是否可靠时，可以给它贴三种标签：

> **source**：文件和符号可以直接确认，例如 `agentLoop()` 返回事件流，`run_turn()` 接收 `CancellationToken`。
>
> **inference**：根据调用关系解释设计含义，例如把 Codex 的 Thread/Turn/Item 看成宿主控制面；这是合理解释，但不是源码注释中的产品宣言。
>
> **runtime**：需要实际运行、配置或服务端才能确认，例如某个 feature flag 是否打开、网络审批在当前平台怎样呈现。

## 本篇新增机制

相对 Claude Code 系列的总览，本专题新增了一个横向坐标：**同一个 Agent 问题，在不同实现里可能由内核、扩展、宿主或操作系统承担。** 后面几篇不会做功能清单，而是沿着这张坐标图追同一条责任链。

## 留给下一篇的问题

同一个用户请求进入三套 Agent 后，究竟在哪一层变成下一次模型请求？下一篇从 `queryLoop()`、`agentLoop()` 和 `run_turn()` 的第一轮采样开始，走完一次完整的“输入 → 工具 → 继续”。

## 参考资料

- [Claude Code Agent SDK：How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [OpenAI：Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi coding-agent README](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
