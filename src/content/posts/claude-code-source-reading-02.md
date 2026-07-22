---
title: "Claude Code源码解读02：一次请求如何走完全程"
published: 2026-07-20
description: "沿着 QueryEngine、queryLoop、API 流、权限与工具执行路径，追踪 Claude Code 一次请求从输入到完成的全过程。"
tags: ["claude-code", "source-code", "ai-agent", "runtime"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-02/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇的问题是：如果我们用 LangGraph 开发一个编程 Agent，它和 Claude Code 到底有什么区别。

答案先说：区别很大。

用 LangGraph 开发编程 Agent，是拿一套通用编排框架来搭自己的系统。Claude Code 则连编排层本身都是自研的，并且已经把模型、工具、权限、上下文和终端交互做成一个完整产品。

我们可以先做一个直接对比：

| 对比项 | 用 LangGraph 开发编程 Agent | Claude Code |
|---|---|---|
| 控制流 | 开发者定义 node、edge 和条件分支 | `queryLoop` 直接控制模型流、工具执行和下一轮推理 |
| 状态 | 开发者设计 shared state，并选择 checkpointer、store | 以消息历史为主，同时维护 `ToolUseContext`、AppState、文件缓存和压缩状态 |
| 工具 | 框架负责把节点连起来，文件、Shell、搜索工具仍要自己实现 | 已经提供工具注册、输入校验、并发编排、进度事件和结果裁剪 |
| 人工介入 | 通常用 `interrupt()` 暂停图，再从 checkpoint 恢复 | 权限判断嵌在工具执行路径中，未允许就不会产生副作用 |
| 运行方式 | 适合自定义工作流、云端异步任务和长时间运行 | 优先服务终端、IDE 和 SDK 中的实时流式交互 |
| 扩展方式 | 修改 graph、state、node 或 middleware | 通过 MCP、hooks、skills、plugins 和内部功能开关扩展 |

两者确实都有“模型调用工具，工具返回结果，模型继续推理”这条循环。但这只能说明它们都属于 Agent，不能说明它们没有区别。就像两个数据库都有查询循环，也不能据此认为存储引擎、事务和恢复机制都一样。

### 为什么 Claude Code 不直接使用 LangGraph

这里先说明证据边界。还原源码中没有 LangGraph 的依赖或引用，我们也没有 Anthropic 内部的技术选型记录。因此，源码不能证明团队当时说过什么。不过，从 `queryLoop` 的结构可以看出，自研这一层有几个直接的工程原因。

第一，Claude Code 最难的部分不是把两个节点连成环。

如果用 LangGraph 表示，Claude Code 的主干可能只有下面三个节点：

`Model → Tools → Model`

但是，`restored-src/src/query.ts` 中的 `queryLoop()` 跨约 1489 行。代码图显示它直接连接了模型流、工具并发、消息队列、token 预算、上下文压缩、hooks、取消和多种错误恢复逻辑。换成 LangGraph 以后，这些代码不会消失，只会被搬进 node、middleware 或 graph state。

也就是说，LangGraph 能替换循环的表达方式，却不能替 Claude Code 实现循环里的产品语义。对于只有两三个稳定节点、但节点内部高度定制的系统，引入通用图引擎不一定能减少复杂度，反而会多一层状态映射。

第二，Claude Code 的一次请求是一条实时事件流。

`QueryEngine.submitMessage()` 和 `queryLoop()` 都使用 `AsyncGenerator`。模型 token、工具进度、权限结果、附件、取消和最终消息会沿同一条链路不断产出，REPL、IDE 和 SDK 可以立即消费。LangGraph 也支持 streaming，但 Claude Code 仍要把自己的消息类型、权限状态和取消语义接到图运行时上。自研循环可以直接使用这些内部对象，不需要先转换成通用 graph event。

第三，权限在 Claude Code 中是执行约束，不只是流程分支。

LangGraph 可以用 `interrupt()` 实现人工审批，但 Claude Code 还要处理 allow、ask、deny、hooks、工具输入修改、沙箱和不同 permission mode。权限检查必须发生在 `tool.call()` 之前，并把拒绝结果重新交给模型。即使采用 LangGraph，这套权限引擎仍然需要 Claude Code 自己维护。

第四，自研循环让产品团队掌握完整的热路径。

Claude Code 以 TypeScript/Node.js CLI 交付，又要同时服务 REPL、IDE、SDK 和远程入口。模型 API、thinking、tool use、上下文策略和功能开关都在快速变化。自己控制 query runtime，意味着这些变化不必先适配第三方框架的 state、checkpoint 和事件语义。这一点属于基于代码结构的工程判断，不是 Anthropic 官方公开的选型结论。

### Open SWE 为什么适合 LangGraph

LangChain 官方开源的 [Open SWE](https://github.com/langchain-ai/open-swe) 是一个很好的对照。截至 2026 年 7 月，它在 GitHub 上约有 10.3k stars，基于 LangGraph 和 Deep Agents 构建。

Open SWE 从 Slack、Linear 或 GitHub 接收任务，在云端沙箱中修改代码、运行测试并创建 Pull Request，还要管理子 Agent、任务状态和异步恢复。它有明显的多阶段工作流和持久化需求，所以 LangGraph 的 graph、state、interrupt 和运行平台能够直接产生价值。

Claude Code 的核心场景则是用户坐在终端或 IDE 前，与一个持续运行的模型—工具循环实时协作。它当然也可以用 LangGraph 重写，但仍然要保留自己的消息、权限、工具、压缩和交互系统。此时通用图框架能够替代的部分很小，自研专用循环反而更直接。

最后把答案归纳一下：

- **LangGraph 编程 Agent 是“基于通用框架开发”**；Claude Code 是“为自身产品定制整套 query runtime”。
- **LangGraph 擅长显式工作流、共享状态、暂停恢复和云端长任务**；Claude Code 更强调本地实时流、细粒度权限和模型工具热循环。
- **Claude Code 技术上可以使用 LangGraph**，但 LangGraph 只能替换最外层的循环表达，无法替换工具、权限、上下文和交互逻辑。
- **Claude Code 选择自研的合理解释**是：它的 graph 很简单，节点内部却高度定制；直接控制循环比接入通用图运行时更可控。这个判断来自源码结构，不是官方选型声明。

## 先把一次请求画成一条时间线

本文基于 npm 发布物 source map 还原出的 `2.1.88` 源码。source map 能支持静态代码与调用关系分析，但不能证明生产环境启用了哪些功能开关，也不能说明一轮请求一定会调用工具。

我们先看最简模型：

`Host → QueryEngine.ask → submitMessage → queryLoop → API stream → tool_use → permission → tool execution → tool_result → next inference → completion`

![Claude Code 一次请求端到端流程手绘图](/images/posts/claude-code-source-reading-02/02-end-to-end-turn-handdrawn.png)

图里有两条出口。模型如果已经给出完整回答，就从 API stream 走向最终输出；如果返回 `tool_use`，Claude Code 就执行工具，把 `tool_result` 放回消息历史，再进入下一轮推理。

这意味着“一次用户请求”不等于“一次模型 API 请求”。前者可以包含多次模型调用和多次工具执行，直到某个停止条件成立。

02 的任务是先建立这张端到端地图，不在每一站提前展开实现。后续文章会沿着同一条链路逐层拆开：

| 本文经过的节点 | 本文只保留的结论 | 后续展开章节 |
|---|---|---|
| Host 与运行入口 | 不同入口最终把输入和能力交给查询内核 | 03 启动与初始化、04 多种运行入口 |
| `QueryEngine` | 保存会话状态，并把内部事件转换给宿主 | 05 会话与无头调用 |
| `queryLoop` | 用显式状态推进模型、工具与下一轮推理 | 06 Agent 循环 |
| 消息与 API stream | 模型返回的是结构化事件流，不只是一段文本 | 07 消息模型、08 API 流式传输 |
| 工具执行 | `tool_use` 要经过查找、编排、校验、权限与执行 | 09 工具契约、10 串并行编排、11 执行生命周期、12 权限引擎 |
| 文件、上下文与恢复 | 工具状态、上下文长度和错误恢复分别有独立机制 | 14 文件与回滚、17 上下文压缩、19 错误恢复、20 会话恢复 |

下面只追踪各节点之间怎样交接。相关参数、分支和异常边界留到表中的专题文章再讲。

## 第一站：Host 把能力交给 QueryEngine.ask

不同 Host 接收输入的方式并不相同。交互式 REPL 从终端拿 prompt，无头模式可能从标准输入或 SDK 拿消息，远程模式还有自己的连接层。但它们进入请求内核时，需要提供的并不只是一段文字。

`restored-src/src/QueryEngine.ts` 中的 `ask()` 会创建 `QueryEngine`。从构造参数可以看到，一轮请求同时带着工作目录、工具、命令、MCP 客户端、Agent 定义、权限回调、模型配置和读取文件状态。

也就是说，prompt 只是输入；目录和消息是上下文；工具与 MCP 是能力；`canUseTool` 是行动边界；模型、轮次和预算则限定这轮请求怎样运行。

`ask()` 随后把 prompt 交给实例，并在生成器退出时保存本轮的读文件状态：

```ts
try {
  yield* engine.submitMessage(prompt, {
    uuid: promptUuid,
    isMeta,
  })
} finally {
  setReadFileCache(engine.getReadFileState())
}
```

这段代码只需要记住两件事：`submitMessage()` 产生的是异步消息流；`finally` 会把本轮更新后的 read-file state 交还给 Host。它不是完整会话，也不会把所有读过的文件再次塞进模型上下文。

Host 怎样启动、不同入口怎样汇入内核，会在 03、04 中展开。`QueryEngine` 怎样保存跨 turn 状态，会在 05 中展开。read-file state 如何支持 Read-before-Write、并发修改保护和回滚，则留到 14。

## 第二站：submitMessage 装配一次可运行的会话

`QueryEngine.submitMessage()` 的职责不是简单转发 prompt。它会准备消息、system prompt、用户上下文、系统上下文和工具运行上下文，再调用 `query()`：

```ts
for await (const message of query({
  messages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool: wrappedCanUseTool,
  toolUseContext: processUserInputContext,
  fallbackModel,
  querySource: 'sdk',
  maxTurns,
  taskBudget,
})) {
  // 记录并向 Host 产出消息
}
```

这一步完成两个转换：用户输入被装配成模型可用的上下文，外部能力被收进循环可以直接使用的依赖。`wrappedCanUseTool` 最终面对 `allow`、`ask`、`deny` 三种权限结果；`maxTurns` 和 `taskBudget` 可以是调用方提供的限制，也可以是 `undefined`，后者只表示没有设置这一项限制。

05 会专门解释 `submitMessage()`、SDK 事件转换和跨 turn 状态；system prompt 与项目上下文的具体组装留到 16。02 只确认它们在这里完成交接。

## 第三站：queryLoop 用显式状态推进每一轮

`query()` 最终进入 `restored-src/src/query.ts` 的 `queryLoop()`。这里最值得先记住的不是某个恢复分支，而是外层结构：跨轮数据放进 `state`，然后由显式循环不断推进。

```ts
let state: State = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  turnCount: 1,
  transition: undefined,
  // 省略压缩、输出 token 恢复等状态
}

while (true) {
  const { messages, turnCount } = state
  // 准备上下文、调用模型、执行工具或结束
}
```

`messages` 决定模型当前能看到什么，`toolUseContext` 保存可调用能力，`turnCount` 支持轮次边界，`transition` 记录上一轮为何继续。工具执行结束后，循环会构造一份新状态，再进入下一轮。

一次简单问答可能只跑一轮；一次改代码任务则可能在多轮之间读文件、编辑、测试，再根据结果调整方案。循环结构能证明系统允许继续，不能预测模型实际上会继续多少次。

06 会沿一次完整迭代解释继续与停止条件；17 解释上下文过长后的压缩；19 再集中处理模型错误、重试、取消和恢复。这里不提前枚举所有 `transition.reason`。

## 第四站：模型响应是一条流，不是一次性字符串

每轮准备好消息以后，`queryLoop()` 通过 `deps.callModel()` 发起模型调用：

```ts
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    model: currentModel,
    fallbackModel,
    querySource,
    // 省略其他 options
  },
})) {
  // 处理流式事件和 assistant 消息
}
```

这里先保留三个结论：用户上下文会在请求前加入消息；工具定义和模型配置与消息一起进入调用；`AbortSignal` 会传到底层，因此取消能够影响正在进行的模型请求。

流里既可能出现文本增量，也可能形成包含 `tool_use` 的 assistant message。`queryLoop()` 会从 assistant message 的 `content` 中筛出 `type === 'tool_use'` 的块，收进 `toolUseBlocks`，并把 `needsFollowUp` 设为 `true`。

因此，是否进入工具链，不是 Host 根据文本猜出来的，而是由模型响应中的结构化 `tool_use` 块决定。07 会解释这些消息和内容块怎样关联，08 会继续拆流式事件怎样组装成完整 assistant message，以及重试、回退和取消怎样穿过 API 层。

## 第五站：tool_use 先被编排，再经过权限

模型可以一次返回多个工具调用。`queryLoop()` 会把它们交给流式执行器或 `runTools()`；调度层依据每次调用的并发安全性决定串行还是并行，而不是无条件 `Promise.all`。

单个调用随后进入 `restored-src/src/services/tools/toolExecution.ts`，依次完成工具查找、输入校验、Hook 与权限判断。最重要的副作用边界是：只有允许分支才会进入 `tool.call()`。

```ts
const resolved = await resolveHookPermissionDecision(
  hookPermissionResult,
  tool,
  processedInput,
  toolUseContext,
  canUseTool,
  assistantMessage,
  toolUseID,
)
const permissionDecision = resolved.decision
processedInput = resolved.input

// 只有允许分支才会继续到这里
const result = await tool.call(
  callInput,
  {
    ...toolUseContext,
    toolUseId: toolUseID,
    userModified: permissionDecision.userModified ?? false,
  },
  canUseTool,
  assistantMessage,
  progress => {
    onToolProgress({
      toolUseID: progress.toolUseID,
      data: progress.data,
    })
  },
)
```

`hookPermissionResult` 可以是 `allow`、`ask`、`deny`、`passthrough` 或 `undefined`；常规权限决策最终收敛为 `allow`、`ask`、`deny`。拒绝、取消和校验失败同样会形成可处理的结果，不会被伪装成执行成功。

09 会先解释工具契约与注册，10 专讲多个 `tool_use` 的串并行编排，11 追踪单次执行生命周期，12 再拆权限规则与询问流程。Hook 作为横切机制会在 18 单独展开。

## 第六站：tool_result 作为 user message 回到模型

工具返回值不能直接当作最终回答。它要先被包装成模型能识别的 `tool_result`，再进入消息历史。

在 `toolExecution.ts` 中，工具内部返回值会被映射成带同一 `tool_use_id` 的 `tool_result`，再包装进 user message。它之所以属于 user 方向，是因为 assistant 已经提出行动，工具结果代表外部环境对这次行动的回应。

`queryLoop()` 在一轮末尾把原消息、assistant 消息和工具结果接到一起，然后继续外层循环：

```ts
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  turnCount: nextTurnCount,
  // 省略其他跨轮状态
}

state = next
```

到这里，图中的回环就闭合了：`tool_result` 不是旁路日志，而是下一次推理的输入。模型可以据此输出最终答案，也可以再次请求工具。

07 会完整解释 `tool_use`、`tool_result` 与内部消息如何配对，11 会解释结果映射和持久化，06 则会从循环视角说明这批消息怎样形成下一轮状态。

## 第七站：没有后续动作，循环才真正完成

当流中没有新的 `tool_use` 时，`needsFollowUp` 保持为 `false`。循环随后处理 API 错误恢复、stop hook 等分支；没有分支要求继续时，才返回 `completed`。

不过，`completed` 只是停止原因之一。源码还明确处理了最大轮次、模型错误、流式取消、工具取消、预算限制、上下文上限和 Hook 阻止继续等边界。

因此，外部看到“没有最终文本”时，不能只检查工具有没有报错。请求可能在模型流、权限、预算、取消或 stop hook 任一层结束。反过来，源码中存在某个恢复分支，也不代表生产环境一定启用了对应功能，或它在所有错误上都会成功。

这些终止条件会分散到后文解释：05 说明无头调用怎样形成最终 result，06 说明循环何时继续或结束，17 处理上下文上限，18 解释 Stop Hook，19 汇总错误、重试、取消与恢复。

## 哪些是事实，哪些只是架构解读

读这条链路时，可以把结论分成三层。

第一层是源码事实。`ask()` 创建 `QueryEngine`，`submitMessage()` 调用 `query()`，`queryLoop()` 使用显式循环，模型 `tool_use` 经过权限后才进入 `tool.call()`，工具结果被追加到下一轮消息中。这些都有具体函数和代码位置支撑。

第二层是架构解读。我们把它概括成“专用状态机”，把 `tool_result` 看成闭环的反馈边，这是对调用关系的抽象，便于理解，但不是源码中的类型名。

第三层是运行时未知。真实请求选了哪个模型、启用了哪些 feature flag、调用了几轮工具、权限是否弹窗、网络重试多久，只靠静态源码无法确定。要回答这些问题，还需要日志、trace 或实际运行证据。

## 小结

Claude Code 的一次请求，本质上不是 prompt 进去、字符串出来，而是一段受状态和权限约束的执行循环。

Host 把输入与运行能力交给 `QueryEngine.ask`，`submitMessage` 装配模型上下文，`queryLoop` 消费 API 流。普通回答可以直接结束；`tool_use` 则经过编排、校验和权限，再由工具产生 `tool_result`。结果回到消息历史以后，模型继续推理，直到完成或触发其他停止边界。

现在，01 的静态架构图已经变成了一条时间线。把这条时间线抽象出来，它很像 Agent 领域里一个经典的执行范式：ReAct。

## 留给下一篇的问题

ReAct 是一种经典的 Agent 工作方式：模型先根据当前信息进行推理，再选择工具执行动作，然后观察工具返回的结果，继续下一轮推理。这个过程会不断重复，直到模型认为任务已经完成。

从表面上看，Claude Code 的 `queryLoop` 也在重复“模型推理 → 工具调用 → 结果返回 → 继续推理”。

那么，Claude Code 的这套 query runtime 究竟算不算 ReAct，它与经典 ReAct 又有什么区别？
