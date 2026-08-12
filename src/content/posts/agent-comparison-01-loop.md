---
title: "Agent源码对比01｜一次请求怎样穿过 Claude Code、Pi 与 Codex"
published: 2026-08-12T10:05:00+08:00
updated: 2026-08-12
description: "沿一次用户请求追踪 Claude Code、Pi 与 Codex 的主循环、工具回路、继续条件和终态。"
tags: ["agent-source-comparison", "ai-agent", "agent-loop", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-comparison-01-loop/agent-comparison-cover-handdrawn.png"
imagePosition: "left"
---

# Agent源码对比01｜一次请求怎样穿过 Claude Code、Pi 与 Codex

上一篇留下的问题是：**同一个用户请求进入三套 Agent 后，究竟在哪一层变成下一次模型请求？**

先说结论。Claude Code 在 `queryLoop()` 的迭代体里把消息视图、工具执行和下一次采样串起来；Pi 的 `agentLoop()` 只是事件流外壳，`runAgentLoop()` 负责推进状态，`executeToolCalls()` 把工具结果交回循环；Codex 则先由 `submission_loop()` 接收会话操作，再由 `run_turn()` 拥有一次 turn 的上下文、采样和后续。

外部资料通常把 Agent loop 简化成“模型决定 → 调工具 → 观察结果 → 再决定”。这个抽象是有用的，但它隐藏了一个工程事实：**一次模型调用和一次 Agent turn 不是同一个单位**。Claude Code 的 SDK 文档把每轮工具调用循环视为一个 turn；OpenAI 对 Codex App Server 的说明则把一个 turn 放在 Thread 中，并把中间过程拆成多个 Item；Pi 的事件流还要处理 steering、follow-up 和工具批次。本文用源码把这三个“单位”重新对齐，而不把它们硬说成同一种状态机。

## 介绍本章的一些概念

- **Turn**：用户输入触发的一段 Agent 工作，不等于一次 API 请求。中间可以有多次模型采样和工具调用。
- **Event stream**：宿主消费的事件序列。它可以承载增量文本、工具开始/结束、错误和最终状态。
- **Continuation**：工具结果、用户插入的 steering 或 stop hook 让 Agent 再次采样，而不是结束当前 turn。
- **Pending input**：模型工作期间到达、暂时没有被当前请求消费的新输入。它是交互式 Agent 和简单脚本循环的关键差别。
- **Terminal condition**：循环为什么停下来。正常完成、取消、错误、预算耗尽和宿主关闭不应被混成一句“返回结果”。

函数签名本身也在说明责任边界：

| 实现 | 源码签名里的关键参数 | 能确认的行为 |
|:--|:--|:--|
| Claude `queryLoop()` | `params`、`consumedCommandUuids` | `params.deps` 可以注入依赖，缺省时回到 `productionDeps()`；`canUseTool`、`maxTurns`、`fallbackModel` 等从 params 进入主循环。 |
| Pi `agentLoop()` | `prompts`、`context`、`config`、`signal: AbortSignal \| undefined`、`streamFn` | `signal` 可以不存在；`streamFn` 由调用方提供，事件先进入 `EventStream`，最终以消息数组结束。 |
| Codex `run_turn()` | `input`、`prewarmed_client_session: Option<_>`、`cancellation_token` | 预热 client session 可以是 `None`，这时从 model client 新建；取消令牌贯穿 pre-compact、采样和工具后续。 |

开放输入如 `prompt`、文件路径和工具参数仍然受各自 schema、解析器或运行时约束；源码没有给出一个可以穷举所有字符串的枚举。

## 问题｜“先查再改”会在哪一次请求发生

用户输入：

> “找出登录流程，跑一次测试；如果需要修改文件，先停下来问我。”

为了让对照可复现，我们只观察一个最小场景：模型先请求读取/搜索工具，然后可能请求 shell 或写文件。真正要追的不是“模型说了什么”，而是四个边界：

1. 用户输入何时写进历史？
2. 工具结果何时成为下一次模型输入？
3. 何时有机会暂停并等待宿主/用户？
4. 没有工具调用时，谁把循环变成终态？

![Claude Code、Pi 与 Codex 的一次请求循环](/images/posts/agent-comparison-01-loop/agent-comparison-01-loop-handdrawn.png)

## Claude Code：生成器让主循环同时成为事件协议

`restored-src/src/query.ts` 中的 `queryLoop()` 是 `async function*`。进入每次迭代时，它先从 state 取出 `messages` 和 `toolUseContext`，构造当前模型可见的消息，再运行 microcompact、auto-compact 和其他上下文处理，之后才调用 `deps.callModel()`。

模型流式输出时，循环不断收集 assistant message 和 `tool_use` block。`canUseTool` 从 `toolUseContext` 取得权限上下文；工具结果回到 `toolResults`，当 `needsFollowUp` 为真时，循环把结果和新的状态送入下一轮采样。没有工具调用、stop hook 没有阻断、也没有需要恢复的错误时，循环返回 terminal 结果。

这里最重要的不是 `while (true)`，而是生成器边界：

> **source**：消费者调用 `.next()` 才会拉动下一段输出；REPL、SDK 或外层 `query()` 可以用同一个事件产出协议消费进度。
>
> **inference**：这让“模型产生增量”和“宿主何时继续处理”天然形成背压边界，但具体宿主是否及时消费，仍要运行时验证。

Claude 的 loop 还把若干看似不同的事情放在同一轮里：tool result budget、snip、microcompact、context collapse、autocompact、fallback、stop hook 和 token budget。这就是生产级内核的特点：循环本身不是算法难点，难点是**每一个异常都必须在继续还是终止之间做出可记录的选择**。

## Pi：事件流外壳、显式配置和工具批次

Pi 的 `agentLoop()` 签名很短。它创建一个 `EventStream<AgentEvent, AgentMessage[]>`，异步调用 `runAgentLoop()`，每收到一个 event 就 `push`，完成时用消息数组 `end`。

因此真正的控制流要继续追 `runAgentLoop()`。它从 `prompts` 和 `AgentContext` 生成模型请求；模型返回 assistant message 后，`executeToolCalls()` 负责处理工具调用。`prepareToolCall()` 先做单个调用的准备、校验和 hook 交互，然后工具结果进入下一次 loop。

Pi 的一个有意思的边界是工具批次。默认允许可并行的工具一起执行，但如果某个工具要求串行，整个批次会退回串行路径；“事件完成顺序”和“写入历史的顺序”也不一定相同。这个细节决定了宿主不能只用“最后一个事件”判断一次工具批次是否完成。

`AgentLoopConfig` 还把 `transformContext`、`convertToLlm`、`streamFn`、`beforeToolCall`、`afterToolCall`、`steeringMode` 和 `followUpMode` 交给调用方。字符串模式的实际可选值要以源码联合类型为准；如果配置没有提供，默认值在配置构造处回退，不能从函数签名单独推断。

## Codex：submission 是会话控制面，turn 是一次工作内核

Codex 把入口拆成两层。

第一层是 `codex-rs/core/src/session/handlers.rs` 的 `submission_loop()`。它从 channel 收取 `Submission`，匹配 `UserInput`、`Interrupt`、审批响应、`Compact`、MCP 刷新、动态工具响应、协作消息和 `Shutdown` 等操作。也就是说，Codex 的“用户输入”并不孤立，它和打断、审批、压缩、关闭共享一个会话级操作队列。

第二层是 `codex-rs/core/src/session/turn.rs` 的 `run_turn()`。它先运行 pre-sampling compact，再根据用户输入解析所需的 MCP server 和插件，捕获 step context，记录上下文更新，注入 skills/plugins，然后进入采样循环。每次采样后，代码会检查：模型是否需要 follow-up、是否有 pending input、是否达到 token limit，以及是否需要 mid-turn auto-compact。

这个结构让 Codex 的两个边界很清楚：

- `submission_loop()` 关心“会话现在收到什么操作”；
- `run_turn()` 关心“这一轮如何把操作变成模型请求并推进到终态”。

`prewarmed_client_session: Option<ModelClientSession>` 是一个很小但有代表性的参数：有预热连接时复用，没有时才创建新的 model client session。它是性能优化，不是控制流语义；真正控制终止的是 `CancellationToken`、错误分支、stop hook 和 `needs_follow_up`。

## 三个循环放在一起看

| 事件 | Claude Code | Pi | Codex |
|:--|:--|:--|:--|
| 用户输入进入哪里 | `query()` / `queryLoop()` 的 params 和消息状态 | `prompts` 与 `AgentContext` | `submission_loop()` 的 `Submission` channel |
| 第一次模型请求前 | 消息投影、预算、压缩、权限上下文 | context transform 与 provider stream | pre-sampling compact、step context、skills/plugins 注入 |
| 工具执行 | 流式 executor 或工具结果收集 | `executeToolCalls()`，批次可并行/串行 | sampling request 内的 tool router、审批与事件 |
| 继续条件 | tool block、pending state、hook、预算/恢复 | 工具结果、steering/follow-up、`shouldStopAfterTurn` | model follow-up、pending input、context rollover |
| 停止边界 | 生成器 return 的终态 | `EventStream.end(messages)` 或异常 | `run_turn()` 返回后由 session runtime 发出终态事件 |

这张表最容易误读的地方是把三种“继续”当成同一种：Claude 的继续由 generator state 推进，Pi 的继续是 Agent loop 和事件配置共同决定，Codex 的继续还要经过会话 submission 与 turn 生命周期。表面都是 ReAct，工程责任不在同一层。

## 一个可以自己做的阅读实验

打开三个源码窗口，假设工具执行到一半时用户按下取消，再立刻输入“只读检查，不要修改”。依次回答：

1. 原工具的结果会不会写入历史？
2. 新输入进入当前 turn，还是排队到下一 turn？
3. 宿主看到的是错误、取消事件，还是一个可以继续的状态？
4. 下一次模型请求使用完整消息、压缩后的消息，还是一份新的上下文快照？

如果回答不了，不要先看 UI。沿着 `queryLoop()`、`runAgentLoop()`、`submission_loop()` 的调用者和返回值继续追，直到找到“谁拥有下一步”的代码。

## 本篇新增机制

从 00 篇的五平面地图进入主循环后，可以得到一个更具体的判断：**同样叫 Agent loop，可能分别由生成器、事件流或会话操作队列承载。** 这会直接影响取消、背压、工具批次和宿主控制。

## 留给下一篇的问题

一次 turn 结束之后，三套系统怎样保证下一次请求还记得必要的内容？下一篇从 transcript、Thread/Turn/Item 和 Pi 的 JSONL 树开始，比较保存格式、模型视图、压缩与分叉。

## 参考资料

- [Claude Code Docs：How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [OpenAI：Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)
- [Claude Code from Source：The Agent Loop](https://claude-code-from-source.com/ch05-agent-loop/)
- [Pi coding-agent README](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
