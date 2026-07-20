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

下面的代码都节选自还原源码。为了让主线清楚，我省略了与当前机制无关的参数、日志和恢复分支；函数名、关键字段与调用顺序保持不变。

## 第一站：Host 把能力交给 QueryEngine.ask

不同 Host 接收输入的方式并不相同。交互式 REPL 从终端拿 prompt，无头模式可能从标准输入或 SDK 拿消息，远程模式还有自己的连接层。但它们进入请求内核时，需要提供的并不只是一段文字。

`restored-src/src/QueryEngine.ts` 中的 `ask()` 会创建 `QueryEngine`。从构造参数可以看到，一轮请求同时带着工作目录 `cwd`、工具 `tools`、命令 `commands`、MCP 客户端 `mcpClients`、Agent 定义 `agents`、权限回调 `canUseTool`、AppState 访问器、模型配置和读取文件缓存。

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

**功能：** 这段代码把当前 prompt 交给 `QueryEngine.submitMessage()`，并把它产生的 SDK 消息流原样向 Host 转发。无论生成器正常结束、抛出异常，还是调用方提前停止消费，`finally` 都会把本轮更新后的读文件状态写回外层缓存。

**关键字段：**

- `prompt`：本轮提交的用户内容。**可选形态**有两种：普通 `string`，或 `ContentBlockParam[]` 结构化内容块数组；数组中的具体块类型由 Anthropic SDK 定义，不是一个可以由这段源码穷举的字符串枚举。
- `uuid`：本轮 prompt 的可选标识，取自 `promptUuid`。**可选值**是调用方提供的字符串或 `undefined`；提供时沿消息链保留这个标识，不提供时表示调用方没有指定外部 ID。
- `isMeta`：标记这条输入是否属于元消息。**可选值**是 `true`、`false` 或因参数缺省得到的 `undefined`；`true` 表示元消息，`false` / `undefined` 按普通输入处理。
- `engine`：本轮请求专属的 `QueryEngine` 实例，内部持有消息、工具上下文和 read-file state。
- `setReadFileCache(...)`：把引擎最终持有的文件状态交还给 Host；它保存的是文件版本认知，不会自动把缓存内容重新注入模型。

这里的 `finally` 很重要。无论正常完成、异常退出还是调用方提前结束消费，清理阶段都有机会把 `QueryEngine` 内部的 read-file state 交还给外层。

完整过程其实是一次“复制进来，再写回去”：`ask()` 创建 `QueryEngine` 时，先通过 `cloneFileStateCache(getReadFileCache())` 复制外层缓存；本轮的 Read、Edit 和 Write 工具持续更新这份副本；请求结束后，`setReadFileCache()` 再把更新结果交还给 Host。下一次调用 `ask()` 时，新引擎就能从这份状态继续工作。

这个缓存按文件路径保存 `content`、`timestamp`、`offset`、`limit` 和 `isPartialView` 等信息。它记录的不是一句简单的“这个文件读过了”，而是“模型读过这个文件的哪个版本，以及看到的是完整内容还是局部内容”。

这里很容易产生一个误解：既然缓存里保存了 `content`，下一轮请求似乎会把这些文件全部注入模型上下文。实际上并不会。`setReadFileCache()` 只是把 `FileStateCache` 交还给 Host，并没有遍历缓存、拼接 prompt，也没有创建新的消息。

模型第一次执行 Read 时，文件内容会作为工具结果进入消息历史，下一轮模型调用因此能看到这段内容。这是 `Read → tool_result → messages` 这条链路的作用。与它并行的 `readFileState` 是一份进程内状态，服务于读后才能改、文件版本校验和重复读取去重。缓存里虽然也有 `content`，但保存它不等于再次把它发送给模型。

缓存也不是无限增长的。`restored-src/src/utils/fileStateCache.ts` 给出了两个默认上限：最多 `100` 个文件路径，所有文本内容合计最多 `25 MB`。底层使用 LRU，因此任意一个限制先达到，最近最少使用的记录就会被淘汰。多个小文件最多保留 100 个；如果单个文件较大，可能在数量达到 100 之前就先触发 25 MB 限制。同一路径重复读取仍然只占一个条目，图片不会进入这份缓存。

这两个数字限制的是 Claude Code 进程里的缓存占用，不是模型上下文窗口。上下文长度由另一套机制控制：Read 支持通过 `offset` 和 `limit` 分段读取，并受单次读取的字节数和 token 数限制；同一路径、同一区间再次读取且文件未变化时，`FileReadTool.call()` 只返回一个 `file_unchanged` 占位结果，不再发送一份完整内容；消息历史继续增长到阈值后，还会通过 microcompact 或完整 compaction 清理、替换或总结旧的工具结果。

因此，文件内容第一次被读出来时确实会占用上下文，而且连续读取很多文件仍然可能让上下文变长。Claude Code 并不是让这部分成本消失，而是避免相同内容反复进入上下文，并在历史过长后压缩旧内容。

保留这些信息主要有三个用途。

第一，Edit 和 Write 可以检查 Read-before-Write，避免模型在没有看过文件的情况下直接覆盖。第二，写入前可以比较当前文件的修改时间和上次读取内容；如果用户或其他进程已经改过文件，就拒绝用旧版本覆盖新内容。第三，后续 turn 可以识别已经读过的文件或 memory，避免把未变化的相同内容再次放进上下文。

如果一条记录因为 LRU 被淘汰，Claude Code 并不会失去磁盘上的文件，只是失去“模型看过哪个版本”的证明。之后若要安全修改，通常需要重新读取。

因此，`setReadFileCache(engine.getReadFileState())` 保存的是一份有容量限制的文件版本认知，而不是完整会话，也不是把所有读过的文件永久写入磁盘。会话 transcript 的持久化由另一套逻辑负责；恢复会话时，也可以再从历史消息中重建部分 read-file state。

## 第二站：submitMessage 装配一次可运行的会话

`QueryEngine.submitMessage()` 的职责不是简单转发 prompt。它在前面准备 system prompt、用户上下文、系统上下文和 `ProcessUserInputContext`，再调用 `query()`：

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

**功能：** 这段代码完成从会话装配到查询循环的交接。`query()` 返回异步消息流，`submitMessage()` 一边消费它，一边记录并向 Host 产出模型消息、工具消息和内部事件。

**关键字段：**

- `messages`：进入本轮查询的消息快照，包含此前历史和刚处理完的用户输入。
- `systemPrompt`：本轮生效的系统提示词；`userContext` 与 `systemContext` 分别补充用户侧环境和系统侧环境。
- `wrappedCanUseTool`：包装后的权限回调，在执行原权限判断之外，还会记录拒绝信息供 SDK 返回。它最终返回的 `PermissionDecision.behavior` 有 `allow`、`ask`、`deny` 三种：允许执行、需要询问、拒绝执行。
- `processUserInputContext`：供工具和输入处理共享的运行上下文，包含工具、MCP、AppState、取消控制器和 read-file state 等能力。
- `fallbackModel`：主模型不可用或满足降级条件时可选的后备模型。**可选值**是模型名字符串或 `undefined`；模型名来自运行时配置，静态源码不能穷举，`undefined` 表示没有为这次查询显式提供后备模型。
- `querySource: 'sdk'`：标记查询来源。这个调用点没有多种取值，固定传入 `'sdk'`；`queryLoop()` 虽然还能服务 REPL、Agent 等其他来源，但它们由各自入口传值。
- `maxTurns`：**可选值**是数字或 `undefined`。数字表示调用方设置的最大循环轮次；`undefined` 表示不启用这项调用方限制，不代表预算、上下文或取消等其他停止条件失效。
- `taskBudget`：**可选值**是 `{ total: number }` 或 `undefined`。前者给出整个任务的预算总量，后者表示不向本轮查询传递 task budget；`total` 是开放数值，不存在固定候选列表。

这一步完成了两个转换。

第一个转换是从“用户输入”到“模型可用上下文”。system prompt、历史消息、项目环境和本轮输入在这里汇合。第二个转换是从“外部能力”到“循环依赖”。工具列表、权限函数、取消信号和状态访问器被收进 `toolUseContext`，后面的循环不需要再回到 Host 临时寻找这些对象。

源码能够确认这些字段怎样传入 `query()`；至于某次真实运行最终拼出了怎样的完整 prompt，还会受到配置、项目内容、压缩和功能开关影响，需要运行时抓取才能回答。

## 第三站：queryLoop 用显式状态推进每一轮

`query()` 最终进入 `restored-src/src/query.ts` 的 `queryLoop()`。这里最值得先记住的不是某个分支，而是外层结构：跨轮数据放进 `state`，然后由一个显式循环不断推进。

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

**功能：** 这段代码建立 `queryLoop()` 的跨轮状态，并用 `while (true)` 反复推进“准备上下文、调用模型、执行工具、决定继续或结束”这条主线。每一轮结束时都会生成新的 `State`，而不是依靠一组分散的局部变量维持会话。

**关键字段：**

- `messages`：当前轮要交给模型的消息历史；工具结果也会在后续被追加到这里。
- `toolUseContext`：工具执行所需的能力与状态集合，包括工具列表、权限、取消信号和 AppState 访问器。
- `turnCount`：当前查询循环的轮次计数，初始值为 `1`，用于实施最大轮次等停止边界。
- `transition`：记录“上一轮为什么执行了 `continue`”，而不是命令状态机下一步做什么。第一次进入循环时还没有上一轮，因此它是 `undefined`。源码中的 `reason` 有七种：`next_turn` 表示工具结果触发正常下一轮；`collapse_drain_retry` 表示清理折叠上下文后重试；`reactive_compact_retry` 表示响应式压缩后重试；`max_output_tokens_escalate` 表示提高输出 token 上限后重试；`max_output_tokens_recovery` 表示插入续写提示后恢复，并额外携带 `attempt`；`stop_hook_blocking` 表示 Stop Hook 返回阻塞错误后重试；`token_budget_continuation` 表示预算策略要求模型继续。`collapse_drain_retry` 还会携带本次提交的折叠数量 `committed`。
- `state`：跨轮状态容器。循环开头从中取值，轮末再整体替换，从而把一次用户请求扩展成多次模型与工具交互。

这里要把“原因标签”和“控制动作”分开。真正让循环进入下一轮的是某个分支先构造新的 `State`，执行 `state = next`，然后调用 `continue`；`transition.reason` 只是随新状态一起保存这次继续的原因。它主要方便测试和排查恢复路径，不需要通过检查消息内容来猜测上一轮发生了什么。

不过，它也不完全是只写不读的调试字段。处理上下文溢出时，如果上一轮已经记录为 `collapse_drain_retry`，下一轮再次遇到相同的 413 错误就不会重复 drain context collapse，而会继续尝试 reactive compact 等后续恢复路径。这个判断避免系统在“清理折叠上下文 → 重试 → 再次 413 → 再清理”的路径里原地循环。因此，更准确地说，`transition` 是一份跨轮的“上次继续原因”，少数恢复分支会用它做去重和防循环保护。

这就是前面说的“专用状态机”。`messages` 决定模型当前能看到什么，`toolUseContext` 保存可调用能力和运行状态，`turnCount` 支持轮次边界，其他字段负责压缩与恢复。

一次简单问答可能只跑一轮；一次改代码任务则可能在多轮之间读文件、编辑、测试，再根据结果调整方案。循环结构能证明系统允许继续，不能预测模型实际上会继续多少次。

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

**功能：** 这段代码组装一轮模型调用，并以异步流的方式消费返回事件。消息、系统提示词、thinking 配置、工具定义和取消信号在这里跨过 Query Core 与模型层的边界；循环体再把流式增量整理成可继续处理的 assistant message。

**关键字段：**

- `messages`：真正发送给模型的消息；`prependUserContext()` 会先把本轮用户环境补到 `messagesForQuery` 前面。
- `systemPrompt`：已经组装完成的系统提示词，决定模型在本轮遵循的全局约束。
- `thinkingConfig`：控制本轮 thinking 模式，来自 `toolUseContext.options`。`ThinkingConfig` 有三种值：`{ type: 'adaptive' }` 让服务端自适应分配 thinking；`{ type: 'enabled', budgetTokens: number }` 显式开启并给出 token 预算；`{ type: 'disabled' }` 关闭 thinking。`submitMessage()` 未收到显式配置时，会根据默认策略选择 `adaptive` 或 `disabled`。
- `tools`：暴露给模型的工具定义；模型据此生成结构化 `tool_use`，这里并不直接执行工具。
- `signal`：来自 `AbortController` 的取消信号。它的关键状态是 `aborted: false` 或 `true`：前者允许请求继续，后者通知模型调用停止；`reason` 可以携带开放的运行时原因，源码没有固定枚举可穷举。
- `model`：当前实际选择的主模型，是开放的模型名字符串；`fallbackModel` 则是模型名字符串或 `undefined`。具体名字受配置和运行环境影响，不能只靠静态源码列全。
- `querySource`：记录查询来源。沿本文的 `submitMessage()` 路径它固定为 `'sdk'`；其他 Host 或 Agent 入口会传入自己的来源值，因此这里不把 `'sdk'` 误写成整个系统唯一选项。

这里有三个直接结论。

第一，用户上下文会在发请求前加到消息上。第二，工具定义和模型配置与消息一起进入调用。第三，`AbortSignal` 也穿过了这条边界，所以取消不是 UI 自己隐藏输出，而是能够影响正在进行的模型调用。

流里既可能出现文本增量，也可能形成包含 `tool_use` 的 assistant message。`queryLoop()` 会从 assistant message 的 `content` 中筛出 `type === 'tool_use'` 的块，收进 `toolUseBlocks`，并把 `needsFollowUp` 设为 `true`。

因此，是否进入工具链，不是 Host 根据文本猜出来的，而是由模型响应中的结构化 `tool_use` 块决定。

## 第五站：tool_use 先被编排，再经过权限

模型可以一次返回多个工具调用。`queryLoop()` 会优先消费 `streamingToolExecutor.getRemainingResults()`；没有流式执行器时，则把收集到的工具块交给 `runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)`。

`runTools()` 位于 `restored-src/src/services/tools/toolOrchestration.ts`。它不会无条件并行所有调用，而是先按 `isConcurrencySafe` 分组。连续的并发安全调用可以批量运行，非只读调用则串行执行。

```ts
for (const { isConcurrencySafe, blocks } of partitionToolCalls(
  toolUseMessages,
  currentContext,
)) {
  if (isConcurrencySafe) {
    for await (const update of runToolsConcurrently(
      blocks,
      assistantMessages,
      canUseTool,
      currentContext,
    )) {
      // 省略延迟应用的 context modifier
      yield {
        message: update.message,
        newContext: currentContext,
      }
    }
  } else {
    for await (const update of runToolsSerially(
      blocks,
      assistantMessages,
      canUseTool,
      currentContext,
    )) {
      // 省略 currentContext 更新
      yield {
        message: update.message,
        newContext: currentContext,
      }
    }
  }
}
```

**功能：** 这段代码先把多个 `tool_use` 按并发安全性分组，再选择并发或串行执行器。两条分支都把执行过程中产生的消息持续 `yield` 给上层，同时携带本轮最新的工具上下文。

**关键字段：**

- `toolUseMessages`：这一批等待执行的工具调用消息，是分组算法的输入。
- `isConcurrencySafe`：当前分组是否允许并发执行，只有 `true` 和 `false` 两种值。`true` 进入 `runToolsConcurrently()`，`false` 进入 `runToolsSerially()`；这个布尔值来自具体工具的并发安全判断，而不是简单按工具名称推断。
- `blocks`：同一分组内的 `tool_use` 内容块，交给并发或串行执行器处理。
- `assistantMessages`：发起这些工具调用的 assistant 消息，用于保留调用与结果之间的关联。
- `canUseTool`：工具真正产生副作用前必须经过的权限回调。
- `currentContext`：当前工具执行上下文；串行调用或 context modifier 可以让它随执行结果更新。
- `update.message`：执行器产生的进度、结果或错误消息；`newContext` 则把对应时刻的上下文一起交回 `queryLoop()`。

这里反映的是副作用边界。多个读操作通常可以同时推进，但写文件、执行命令或修改状态如果任意并发，结果会更难预测。源码中的判断最终由具体工具的 schema 和 `isConcurrencySafe()` 实现决定，所以“读操作一定并行”也不是可靠结论。

这里的“流式执行”解决的是等待时间问题。普通路径要等模型响应流结束，收齐这一轮所有 `tool_use`，才统一调用 `runTools()`。流式执行器则在模型流仍然继续时，看到一条完整 assistant message 中的 `tool_use` 块，就立刻调用 `addTool()` 入队。模型可以继续生成后面的内容，前面已经完整到达的工具则同时等待权限或开始执行，两段时间因此可以重叠。

需要注意，它不是“收到半截工具参数就开始执行”。`StreamingToolExecutor.addTool()` 接收的是完整的 `ToolUseBlock`，其中已经有 `id`、`name` 和 `input`。它先按名称查找工具，再用 `inputSchema.safeParse()` 尝试解析输入，以便计算 `isConcurrencySafe`。找不到工具时，它直接生成一条带 `is_error: true` 的 `tool_result`；输入暂时无法通过 schema 时，并不会猜测或修补参数，而是把该调用按不支持并发处理，后面的正式执行路径仍会完成输入校验并返回错误。

并发安全不是 `queryLoop()` 按工具名称写死的。输入通过 schema 后，执行器会把解析后的参数交给该工具自己的 `isConcurrencySafe(input)`；工具不存在、输入校验失败或判断过程抛错时，都保守地得到 `false`。不同工具可以采用不同策略：`Read`、`Grep`、`WebSearch` 固定返回 `true`；`Bash` 则继续调用 `isReadOnly(input)` 分析具体命令，因此同一个工具也可能因参数不同得到不同结果；动态 MCP 工具读取服务端的 `readOnlyHint`，未声明时按 `false` 处理。普通路径会把连续的 `true` 调用合并并发执行，把 `false` 调用拆成单独的串行批次。

每个入队调用会经历 `queued`、`executing`、`completed`、`yielded` 四种状态。`processQueue()` 只有在当前没有工具执行，或者新工具与所有执行中工具的 `isConcurrencySafe` 都为 `true` 时，才会启动它。遇到不支持并发的工具时，队列会保留顺序，等前面的调用完成再继续。因此，流式执行器缩短的是空等时间，并没有取消原来的串并行边界。

执行本身仍然通过 `runToolUse()` 进入同一套工具生命周期，继续使用 `canUseTool`、`ToolUseContext` 和子 `AbortController`。也就是说，提前启动不等于绕过 schema、hook 或权限。进度消息会先放进 `pendingProgress`，`queryLoop()` 在消费模型流的间隙调用 `getCompletedResults()`，可以立即把进度和已经完成的结果向 Host 产出。

等模型流结束后，`getRemainingResults()` 负责收尾。它会反复启动当前允许执行的队列项，产出已经完成的结果；如果只剩执行中的工具，就用 `Promise.race()` 等待任意工具结束或出现新进度，直到所有调用都进入 `yielded`。所以这里的“remaining”不是把同一批工具再执行一次，而是等待并排空前面已经启动的队列。

错误和取消也有额外保护。用户中断时，执行器会为尚未正常返回的 `tool_use` 生成合成错误结果，避免消息历史里出现只有调用、没有对应 `tool_result` 的悬空结构。Bash 工具产生错误时会取消同批仍在运行的 sibling tools，因为连续命令常有隐式依赖；其他工具失败则不会默认取消整批。模型发生 streaming fallback 时，旧执行器会被 `discard()`，随后创建新实例，防止旧模型响应中的 `tool_use_id` 与新响应的结果串线。

是否创建流式执行器由 `config.gates.streamingToolExecution` 决定：`true` 使用 `StreamingToolExecutor`，`false` 回到 `runTools()`。静态源码可以确认两条路径及其行为，但不能证明某次生产请求一定启用了这个 gate，也不能据此推断真实延迟收益。

为什么不只保留流式执行器？因为它目前仍是一条提速路径，而不是与普通执行完全等价的替代品。它会在模型响应结束前启动工具；一旦发生 streaming fallback，`discard()` 可以丢弃旧结果，却未必能撤销已经产生的外部副作用。源码还注明，并发工具暂不支持 `contextModifier`。相比之下，`runTools()` 不依赖模型流，可以作为更稳定的通用执行路径；保留 feature gate，也方便在出现时序或兼容问题时退回普通执行。

单个工具进入 `restored-src/src/services/tools/toolExecution.ts` 后，还要先找到工具、校验 schema 与工具自己的输入约束，然后解析 hook 和权限决策。关键顺序如下：

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

**功能：** 这段代码把 hook 决策、权限规则和用户确认收敛成最终的 `permissionDecision`，并允许权限阶段修改工具输入。只有得到允许后，流程才会进入 `tool.call()`；工具执行期间产生的进度会通过回调继续上报。

**关键字段：**

- `hookPermissionResult`：类型是 `PermissionResult | undefined`。`behavior` 有四种：`allow` 允许继续，`ask` 要求进入询问流程，`deny` 直接拒绝，`passthrough` 表示 hook 不作最终决定、交给常规权限流程；`undefined` 表示 hook 没有返回权限结果。`allow` / `ask` 还可能通过 `updatedInput` 携带修改后的输入。
- `tool`：当前准备执行的工具实现，提供输入约束、权限特征和最终的 `call()`。
- `processedInput`：经过 schema、工具校验及 hook 处理后的输入；权限解析返回的新输入会覆盖旧值。
- `toolUseContext`：执行所需的 cwd、消息、AppState、取消状态和其他共享能力。
- `canUseTool`：在规则要求确认时作出最终权限决定的回调。返回值是 `PermissionDecision`，其 `behavior` 有 `allow`、`ask`、`deny` 三种；与 `hookPermissionResult` 不同，这个类型不包含 `passthrough`。
- `assistantMessage` 与 `toolUseID`：把执行动作关联回模型发出的那条 assistant 消息和具体 `tool_use` 块。
- `callInput`：真正传给工具的已确认输入；它与权限解析后的 `processedInput` 对应。
- `userModified`：记录允许执行时用户是否修改过输入。来源字段可以是 `true`、`false` 或 `undefined`，但传给 `tool.call()` 时通过 `?? false` 收敛成布尔值：只有明确为 `true` 才表示用户改过参数，其余情况都按 `false` 处理。
- `progress`：工具执行中的增量进度，通过 `onToolProgress()` 变成上层可以消费的事件。

也就是说，`tool_use` 是模型提出的行动请求，不是已经发生的副作用。真正的 `tool.call()` 位于权限决策之后。拒绝、取消和校验失败也会形成可处理的结果，而不是假装工具成功执行。

## 第六站：tool_result 作为 user message 回到模型

工具返回值不能直接当作最终回答。它要先被包装成模型能识别的 `tool_result`，再进入消息历史。

在 `toolExecution.ts` 的 `addToolResult()` 中，工具返回值先被映射成 API 使用的结果块，再被放进一条 user message：

```ts
const toolResultBlock = preMappedBlock
  ? await processPreMappedToolResultBlock(
      preMappedBlock,
      tool.name,
      tool.maxResultSizeChars,
    )
  : await processToolResultBlock(tool, toolUseResult, toolUseID)

const contentBlocks: ContentBlockParam[] = [toolResultBlock]

resultingMessages.push({
  message: createUserMessage({
    content: contentBlocks,
    imagePasteIds: allowImageIds,
    toolUseResult:
      toolUseContext.agentId && !toolUseContext.preserveToolUseResults
        ? undefined
        : toolUseResult,
    mcpMeta: toolUseContext.agentId ? undefined : mcpMeta,
    sourceToolAssistantUUID: assistantMessage.uuid,
  }),
})
```

**功能：** 这段代码把工具实现返回的内部值映射成 API 可识别的 `tool_result` 内容块，再包装成一条 user message 放入 `resultingMessages`。这一步完成了从执行层返回值到下一轮模型输入的格式转换。

**关键字段：**

- `preMappedBlock`：**可选值**是一个已经映射好的 `ToolResultBlockParam` 或 `undefined`。存在时只做尺寸处理；缺省时从 `toolUseResult` 和 `toolUseID` 重新映射。
- `toolResultBlock`：最终写入消息 `content` 的 `tool_result` 块，受工具名和 `maxResultSizeChars` 限制。
- `toolUseResult`：工具实现返回的原始结果，类型是开放的 `unknown`。写入内部消息时有两种结果：若当前是子 Agent 且 `preserveToolUseResults` 为 `false` / `undefined`，字段被设为 `undefined`；其他情况保留原始值。
- `toolUseID`：关联这份结果与原始 `tool_use` 的标识，模型据此知道结果对应哪次调用。
- `contentBlocks`：本条 user message 的内容块数组；片段中首先放入工具结果，完整路径还可能追加确认反馈或图片。
- `imagePasteIds`：**可选值**是 `number[]` 或 `undefined`。有图片内容块时生成连续编号；没有图片时不写这个字段。
- `mcpMeta`：**可选值**是 MCP 元数据对象或 `undefined`。顶层调用可以保留；`toolUseContext.agentId` 存在时说明处于子 Agent 上下文，此时不继续透传。
- `sourceToolAssistantUUID`：指向发起工具调用的 assistant message，使内部消息链保持可追踪。

它之所以是 user 方向，而不是 assistant 方向，是因为 assistant 已经发出了 `tool_use`，工具结果是外部环境对这次调用的回应。下一次模型推理需要同时看到自己的调用和环境返回的结果，才能判断任务是否完成。

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

**功能：** 这段代码构造工具执行后的下一轮 `State`：保留本轮查询消息，依次追加 assistant 响应和工具结果，再更新工具上下文与轮次。把 `state` 替换为 `next` 后，外层循环便会用这组新输入再次调用模型。

**关键字段：**

- `messagesForQuery`：本轮实际送入模型的基础消息数组，可能已经经过上下文整理或压缩；允许为空数组，但是否能形成有效 API 请求还取决于 system prompt 和上游装配。
- `assistantMessages`：本轮模型产生的 assistant 消息数组。没有模型消息时可以为空；需要继续工具链时，其中至少包含带 `tool_use` 的消息。
- `toolResults`：工具执行后形成的 user message / attachment 数组。没有工具结果时可以为空；进入正常工具回环时，其中包含与调用对应的 `tool_result`。
- `toolUseContextWithQueryTracking`：带有本轮查询追踪信息的工具上下文，供下一轮继续共享能力和状态。
- `nextTurnCount`：下一轮的正整数计数，由 `turnCount + 1` 得到。它不是枚举；达到调用方提供的 `maxTurns` 后，循环会返回 `max_turns`，否则继续增长。
- `next`：完整的下一轮状态快照；赋给 `state` 后闭合“模型 → 工具 → 结果 → 模型”的循环。

到这里，图中的回环就闭合了：`tool_result` 不是旁路日志，而是下一次推理的输入。模型可以据此输出最终答案，也可以再次请求工具。

## 第七站：没有后续动作，循环才真正完成

当流中没有新的 `tool_use` 时，`needsFollowUp` 保持为 `false`。循环随后处理 API 错误恢复、stop hook 等分支；没有分支要求继续时，才返回 `completed`。

不过，`completed` 只是停止原因之一。源码还明确处理了最大轮次、模型错误、流式取消、工具取消、预算限制、上下文上限和 hook 阻止继续等边界。

因此，外部看到“没有最终文本”时，不能只检查工具有没有报错。请求可能在模型流、权限、预算、取消或 stop hook 任一层结束。反过来，源码中存在某个恢复分支，也不代表生产环境一定启用了对应功能，或它在所有错误上都会成功。

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
