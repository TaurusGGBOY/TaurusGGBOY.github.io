---
title: "Claude Code 源码解读 02：一次请求如何走完全程"
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

两者确实都有“模型调用工具，工具返回结果，模型继续推理”这条循环。

### 为什么 Claude Code 不直接使用 LangGraph

这里先说明证据边界。还原源码的依赖和引用中找不到 LangGraph，Anthropic 也未公开内部技术选型记录。下面的工程原因来自 `queryLoop` 结构，而非官方选型声明。

第一，主要复杂度位于循环内部的产品语义。

如果用 LangGraph 表示，Claude Code 的主干可能只有下面三个节点：

`Model → Tools → Model`

但是，`restored-src/src/query.ts` 中的 `queryLoop()` 跨约 1489 行。代码图显示它直接连接了模型流、工具并发、消息队列、token 预算、上下文压缩、hooks、取消和多种错误恢复逻辑。换成 LangGraph 以后，这些代码不会消失，只会被搬进 node、middleware 或 graph state。

也就是说，LangGraph 能替换循环的表达方式，却不能替 Claude Code 实现循环里的产品语义。对于只有两三个稳定节点、但节点内部高度定制的系统，引入通用图引擎不一定能减少复杂度，反而会多一层状态映射。

第二，Claude Code 的一次请求是一条实时事件流。

`QueryEngine.submitMessage()` 和 `queryLoop()` 都使用 `AsyncGenerator`。模型 token、工具进度、权限结果、附件、取消和最终消息会沿同一条链路不断产出，REPL、IDE 和 SDK 可以立即消费。LangGraph 也支持 streaming，但 Claude Code 仍要把自己的消息类型、权限状态和取消语义接到图运行时上。自研循环可以直接使用这些内部对象，不需要先转换成通用 graph event。

第三，权限在 Claude Code 中直接约束副作用能否发生。

LangGraph 可以用 `interrupt()` 实现人工审批，但 Claude Code 还要处理 allow、ask、deny、hooks、工具输入修改、沙箱和不同 permission mode。权限检查必须发生在 `tool.call()` 之前，并把拒绝结果重新交给模型。即使采用 LangGraph，这套权限引擎仍然需要 Claude Code 自己维护。

第四，自研循环让产品团队掌握完整的热路径。

Claude Code 以 TypeScript/Node.js CLI 交付，又要同时服务 REPL、IDE、SDK 和远程入口。模型 API、thinking、tool use、上下文策略和功能开关都在快速变化。自己控制 query runtime，可以直接调整 state、checkpoint 和事件语义。这一点属于基于代码结构的工程判断；Anthropic 的公开材料未披露框架选型过程。

### Open SWE 为什么适合 LangGraph

LangChain 官方开源的 Open SWE 是一个很好的对照。截至 2026 年 7 月，它在 GitHub 上约有 10.3k stars，基于 LangGraph 和 Deep Agents 构建。

Open SWE 从 Slack、Linear 或 GitHub 接收任务，在云端沙箱中修改代码、运行测试并创建 Pull Request，还要管理子 Agent、任务状态和异步恢复。它有明显的多阶段工作流和持久化需求，所以 LangGraph 的 graph、state、interrupt 和运行平台能够直接产生价值。

Claude Code 的核心场景则是用户坐在终端或 IDE 前，与一个持续运行的模型—工具循环实时协作。它当然也可以用 LangGraph 重写，但仍然要保留自己的消息、权限、工具、压缩和交互系统。此时通用图框架能够替代的部分很小，自研专用循环反而更直接。

最后把答案归纳一下：

- **LangGraph 编程 Agent 是“基于通用框架开发”**；Claude Code 是“为自身产品定制整套 query runtime”。
- **LangGraph 擅长显式工作流、共享状态、暂停恢复和云端长任务**；Claude Code 更强调本地实时流、细粒度权限和模型工具热循环。
- **Claude Code 技术上可以使用 LangGraph**，但 LangGraph 只能替换最外层的循环表达，无法替换工具、权限、上下文和交互逻辑。
- **Claude Code 选择自研的合理解释**是：它的 graph 很简单，节点内部却高度定制；直接控制循环比接入通用图运行时更可控。这个判断来自源码结构，证据范围限于代码架构。

## 本章先建立三个概念

- **Agent turn**：一次模型决策及其产生的消息；一条用户请求可以跨越多个 turn。

- **状态迁移**：模型事件、工具结果和停止条件共同把循环从一个可执行状态推进到下一个状态。

- **循环不变量**：每个 `tool_use` 都要获得匹配结果，消息顺序和权限上下文在回环前保持可解释。

![一次用户请求中的多轮状态迁移](/images/posts/claude-code-source-reading-02/02-turn-state-machine-detail-handdrawn.png)

这张图把一次 turn 的不变量画出来：模型可以产生文本或 `tool_use`，但每个调用都必须经过执行并得到配对结果，循环才有资格继续。

## 先把一次请求画成一条时间线

本文以 npm 发布物 source map 还原的 `2.1.88` 源码为边界。假设用户输入“修复这个失败测试”，最容易观察到的现象是终端连续出现读取、编辑和测试输出；真正需要追踪的是这些事件如何在模型调用之间交接。

先把最小调用链写出来：

`Host → QueryEngine.ask → submitMessage → queryLoop → API stream → tool_use → permission → tool execution → tool_result → next inference → completion`

![Claude Code 一次请求端到端流程手绘图](/images/posts/claude-code-source-reading-02/02-end-to-end-turn-handdrawn.png)

图里有两条出口：完整文本直接结束；`tool_use` 先经过编排、校验和权限，`tool_result` 回到消息历史后才允许下一次模型调用。一次用户请求因此可能展开成多轮 API 调用，但每一轮都必须满足消息配对和停止条件。

本篇只追踪交接点，不把每个工具的内部实现混在主线上；表中的后续章节再分别展开启动、会话、消息、工具和恢复。

| 本文经过的节点 | 本文只保留的结论 | 后续展开章节 |
|---|---|---|
| Host 与运行入口 | 不同入口最终把输入和能力交给查询内核 | 03 启动与初始化、04 多种运行入口 |
| `QueryEngine` | 保存会话状态，并把内部事件转换给宿主 | 05 会话与无头调用 |
| `queryLoop` | 用显式状态推进模型、工具与下一轮推理 | 06 Agent 循环 |
| 消息与 API stream | 模型返回包含文本、thinking、工具调用与控制状态的结构化事件流 | 07 消息模型、08 API 流式传输 |
| 工具执行 | `tool_use` 要经过查找、编排、校验、权限与执行 | 09 工具契约、10 串并行编排、11 执行生命周期、12 权限引擎 |
| 文件、上下文与恢复 | 工具状态、上下文长度和错误恢复分别有独立机制 | 14 文件与回滚、17 上下文压缩、19 错误恢复、20 会话恢复 |

下面只追踪各节点之间怎样交接。相关参数、分支和异常边界留到表中的专题文章再讲。

## 第一站：Host 把能力交给 QueryEngine.ask

不同 Host 接收输入的方式各异。交互式 REPL 从终端拿 prompt，无头模式可能从标准输入或 SDK 拿消息，远程模式还有自己的连接层。进入请求内核时，它们都要提供消息、会话状态、权限与工具上下文。

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

`submitMessage()` 产生异步消息流；`prompt` 是本轮用户输入，`uuid` 绑定调用方提供的消息标识，`isMeta` 标记该消息是否属于元信息。生成器退出后，`finally` 无条件把更新后的 read-file state 交还给 Host。这份 state 是文件读取凭据缓存，不会把文件正文自动追加到模型上下文。

Host 怎样启动、不同入口怎样汇入内核，会在 03、04 中展开。`QueryEngine` 怎样保存跨 turn 状态，会在 05 中展开。read-file state 如何支持 Read-before-Write、并发修改保护和回滚，则留到 14。

## 第二站：submitMessage 装配一次可运行的会话

`QueryEngine.submitMessage()` 会准备消息、system prompt、用户上下文、系统上下文和工具运行上下文，再调用 `query()`：

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

这一步完成两个转换：用户输入被装配成模型可用的上下文，外部能力被收进循环可以直接使用的依赖。`messages` 是本轮消息历史，`systemPrompt` 是系统提示块，`userContext` 和 `systemContext` 分别补入用户侧与运行时上下文；`canUseTool` 接收包装后的权限回调，最终面对 `allow`、`ask`、`deny` 三种结果；`toolUseContext` 携带工具池、取消、文件缓存和状态访问能力；`fallbackModel` 是主模型失败时的候选模型，`querySource: 'sdk'` 标记调用来源。`maxTurns` 与 `taskBudget` 传入数值时分别约束轮数和任务预算，省略时跳过对应限制。

05 会专门解释 `submitMessage()`、SDK 事件转换和跨 turn 状态；system prompt 与项目上下文的具体组装留到 16。02 只确认它们在这里完成交接。

## 第三站：queryLoop 用显式状态推进每一轮

`query()` 最终进入 `restored-src/src/query.ts` 的 `queryLoop()`。它把跨轮数据放进 `state`，再由显式循环不断推进。

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

一次简单问答可能只跑一轮；一次改代码任务则可能在多轮之间读文件、编辑、测试，再根据结果调整方案。

06 会沿一次完整迭代解释继续与停止条件；17 解释上下文过长后的压缩；19 再集中处理模型错误、重试、取消和恢复。这里不提前枚举所有 `transition.reason`。

## 第四站：模型响应按事件流逐步到达

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

`messages` 是拼入用户上下文后的消息序列；`systemPrompt` 是本轮完整系统提示；`thinkingConfig` 控制扩展思考配置；`tools` 提供模型可见的工具定义；`signal` 把取消传播到底层请求。`options.model` 指定当前模型，`fallbackModel` 提供降级候选，`querySource` 标记调用入口。`deps.callModel()` 返回异步生成器，因此上层可以边接收边处理。

流里既可能出现文本增量，也可能形成包含 `tool_use` 的 assistant message。`queryLoop()` 会从 assistant message 的 `content` 中筛出 `type === 'tool_use'` 的块，收进 `toolUseBlocks`，并把 `needsFollowUp` 设为 `true`。

结构化 `tool_use` 块决定是否进入工具链，Host 无需从文本猜测动作。07 会解释这些消息和内容块怎样关联，08 会继续拆流式事件怎样组装成完整 assistant message，以及重试、回退和取消怎样穿过 API 层。

## 第五站：tool_use 先被编排，再经过权限

模型可以一次返回多个工具调用。`queryLoop()` 会把它们交给流式执行器或 `runTools()`；调度层依据每次调用的并发安全性选择串行或并行。

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

`hookPermissionResult` 可取 `allow`、`ask`、`deny`、`passthrough`，省略时直接进入常规权限判断；`resolveHookPermissionDecision()` 把它与 `tool`、`processedInput`、`toolUseContext`、`canUseTool`、`assistantMessage` 和 `toolUseID` 合并成最终决定。`resolved.decision` 收敛到常规权限语义，`resolved.input` 保留 Hook 或用户修改后的输入。调用阶段的 `callInput` 是最终参数；上下文中的 `toolUseId` 关联原请求，`userModified` 缺省为 `false`；进度回调再把 `progress.toolUseID` 与 `progress.data` 转交上层。拒绝、取消和校验失败会形成错误结果并在副作用前返回。

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

`next.messages` 依次拼接查询前消息、assistant 消息和全部工具结果，成为下一次推理的输入；`toolUseContext` 换成带本轮查询跟踪信息的版本，`turnCount` 更新为下一轮计数。其他压缩与恢复字段在真实 `State` 中继续透传。模型随后可以输出最终答案，也可以再次请求工具。

07 会完整解释 `tool_use`、`tool_result` 与内部消息如何配对，11 会解释结果映射和持久化，06 则会从循环视角说明这批消息怎样形成下一轮状态。

## 第七站：所有继续条件清空后完成本轮

当流中未产生新的 `tool_use` 时，`needsFollowUp` 保持为 `false`。循环随后处理 API 错误恢复、stop hook 等分支；所有继续条件都未触发时返回 `completed`。

不过，`completed` 只是停止原因之一。源码还明确处理了最大轮次、模型错误、流式取消、工具取消、预算限制、上下文上限和 Hook 阻止继续等边界。

因此，请求以“无最终文本”状态结束时，需要依次检查模型流、权限、预算、取消和 stop hook，工具错误只是其中一层。源码中存在某个恢复分支，只能证明客户端具备该路径；生产环境是否启用以及恢复成功率仍取决于运行时配置与真实请求。

这些终止条件会分散到后文解释：05 说明无头调用怎样形成最终 result，06 说明循环何时继续或结束，17 处理上下文上限，18 解释 Stop Hook，19 汇总错误、重试、取消与恢复。

## 小结

Claude Code 的一次请求是一段受状态和权限约束的执行循环：输入可以跨越多次模型调用和工具执行，最终以明确的停止原因收口。

Host 把输入与运行能力交给 `QueryEngine.ask`，`submitMessage` 装配模型上下文，`queryLoop` 消费 API 流。普通回答可以直接结束；`tool_use` 则经过编排、校验和权限，再由工具产生 `tool_result`。结果回到消息历史以后，模型继续推理，直到完成或触发其他停止边界。

现在，01 的静态架构图已经变成了一条时间线。把这条时间线抽象出来，它很像 Agent 领域里一个经典的执行范式：ReAct。

## 留给下一篇的问题

ReAct 是一种经典的 Agent 工作方式：模型先根据当前信息进行推理，再选择工具执行动作，然后观察工具返回的结果，继续下一轮推理。这个过程会不断重复，直到模型认为任务已经完成。

从表面上看，Claude Code 的 `queryLoop` 也在重复“模型推理 → 工具调用 → 结果返回 → 继续推理”。

那么，Claude Code 的这套 query runtime 究竟算不算 ReAct，它与经典 ReAct 又有什么区别？

## 参考资料

- [How to Turn Claude Code into a Domain-Specific Coding Agent](https://www.langchain.com/blog/how-to-turn-claude-code-into-a-domain-specific-coding-agent)
- [Claude Agent SDK vs LangGraph](https://www.developersdigest.tech/blog/claude-agent-sdk-vs-langgraph)
- [Open SWE](https://github.com/langchain-ai/open-swe)
- [Claude Code 的工作方式](https://code.claude.com/docs/en/how-claude-code-works)

- [Dive into Claude Code：生产级 Agent 的设计空间](https://arxiv.org/abs/2604.14228)
