---
title: "Claude Code源码解读02：一次请求如何走完 Claude Code"
published: 2026-07-20
description: "沿着 QueryEngine、queryLoop、API 流、权限与工具执行路径，追踪 Claude Code 一次请求从输入到完成的全过程。"
tags: ["claude-code", "source-code", "ai-agent", "runtime"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-02/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-04
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

## Key Takeaways

- 一条用户请求背后是**多轮 agent loop**：模型调用、工具执行、结果回填循环多次，直到满足停止条件。
- CLI → main → QueryEngine → queryLoop：这是从命令行到 `while (true)` 的完整调用链。
- Agent loop 的骨架只有约 30 行，生产实现 `queryLoop()` 约 1488 行；多出的 1458 行是让它生产可用的工程细节。
- 每一轮都遵循同一节奏：调用模型 → 检查流中的 `tool_use` → 有则执行工具 → 把 `tool_result` 追加回消息 → 回到循环顶部。
- 停止条件不止一个：正常完成之外，还有最大轮次、预算/上下文限制、取消和错误。

## 本篇新增机制

01 画出了系统地图：四个外围区域都通过 Query Core 交换状态。本篇沿同一条请求，追踪它从终端进入 Query Core、穿过模型流与工具链、再到结果回填的完整路径——把静态地图变成一条时间线。本篇建立的调用链，是 06 深入 `queryLoop()` 单次迭代的必备前提。

## 最小心智模型：先把 Agent 循环写成 20 行 Python

在读任何 TypeScript 之前，先看这个最小模型。它只有 20 行，却已经包含 `queryLoop()` 的全部控制流骨架：调用模型、收集消息、检查工具调用、执行、回填、循环。

```python
# 证据：教学伪代码（非源码），对应 docs/blog/examples/minimal-agent/loop.py 的核心逻辑
def agent_loop(prompt, tools, max_turns=10):
    messages = [{"role": "user", "content": prompt}]
    for turn in range(max_turns):
        # 1. 调用模型
        resp = client.messages.create(model=MODEL, messages=messages, tools=tools)
        messages.append({"role": "assistant", "content": resp.content})
        # 2. 检查流中的 tool_use 块
        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        if not tool_uses:
            return "".join(b.text for b in resp.content if b.type == "text")
        # 3. 执行每个工具，收集结果
        results = []
        for b in tool_uses:
            output = execute_tool(b.name, b.input)
            results.append({"type": "tool_result", "tool_use_id": b.id, "content": output})
        # 4. 结果作为 user message 回填
        messages.append({"role": "user", "content": results})
    return "[max_turns reached]"
```

请记住这个循环的四个动作：**call model → check tool_use → execute & collect → append results → loop**。生产代码不管有多少行，循环的骨架就是这样。整篇文章后面所有的调用链、状态字段、停止条件，都是为了解释这个 20 行骨架在真实系统里被放大成了什么。

## 正文：一次请求如何走完

上午 09:18，你在 `checkout-service` 仓库里把金额单位工单交给 Claude Code：

> 请检查支付服务中的金额单位问题：订单使用优惠券后，结算页显示 99.90 元，支付回调却记录为 9991 分；请查清原因、修复并运行测试。

你看到的是终端不断刷新的工作流；源码里是这条最小调用链：

`cli.tsx → main.tsx → REPL/SDK → QueryEngine.ask → submitMessage → query → queryLoop → API stream → tool_use → permission → tool execution → tool_result → next inference → completion`

本文以 npm 发布物 source map 还原的 2.1.88 源码为边界。下面沿调用链逐站展开。

### 第一站：cli.tsx 的 fast-path 与 main.tsx 的完整入口

你敲下 `claude` 后，第一个执行的函数是 `restored-src/src/entrypoints/cli.tsx` 里的 `main()`。它的注释写得很直白：Bootstrap entrypoint，在加载完整 CLI 之前先检查特殊参数，所有 import 都是动态的，fast-path 路径零模块加载：

```ts
// 证据：restored-src/src/entrypoints/cli.tsx —— main() 的 fast-path
async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Fast-path for --version/-v: zero module loading needed
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION is inlined at build time
    console.log(`${MACRO.VERSION} (Claude Code)`)
    return
  }

  // For all other paths, load the startup profiler
  const {
    profileCheckpoint
  } = await import('../utils/startupProfiler.js')
  profileCheckpoint('cli_entry')
  ...
}
```

普通请求不会命中 fast-path，于是 `cli.tsx` 把控制权交给 `restored-src/src/main.tsx`。`main.tsx` 是完整 CLI 入口：import 副作用先并行启动 MDM 原始读取（`startMdmRawRead`）和 macOS keychain 预取（`startKeychainPrefetch`），随后用 Commander 解析参数、`init()` 完成启动初始化、`launchRepl()` 挂载交互终端。`main.tsx` 自己的注释也承认：部分命令在 `cli.tsx` fast-path 就被拦截了，`main.tsx` 里的对应分支实际上不可达。

### 第二站：REPL 与 SDK 双模式，共用同一个 QueryEngine

Claude Code 有两类宿主，但都汇入同一个查询内核：

- **REPL（交互终端）**：用户在终端输入，`launchRepl()` 挂载的界面把消息交给 `QueryEngine.ask()`，调用来源标记为 `repl_main_thread`。
- **SDK / 无头模式**：`claude -p` 或外部 SDK 调用 `QueryEngine.submitMessage()`，调用来源是 `querySource: 'sdk'`。

在 `restored-src/src/query.ts` 里能直接看到这层判断：

```ts
// 证据：restored-src/src/query.ts —— 主线程判定
const isMainThread =
  querySource.startsWith('repl_main_thread') || querySource === 'sdk'
```

两条路径的差异只在外壳：REPL 需要实时渲染和权限询问，SDK 需要结构化事件流。进入 `QueryEngine` 之后，它们走的是同一条 `submitMessage()` → `query()` 链路。

`QueryEngine.ask()` 是交互路径的便利入口。它创建一个 `QueryEngine`（构造参数携带工作目录、工具、命令、MCP 客户端、Agent 定义、权限回调、模型配置和读文件状态），然后把 prompt 交给实例，并在生成器退出时保存本轮读文件状态：

```ts
// 证据：restored-src/src/QueryEngine.ts —— ask() 的收尾
try {
  yield* engine.submitMessage(prompt, {
    uuid: promptUuid,
    isMeta,
  })
} finally {
  setReadFileCache(engine.getReadFileState())
}
```

`prompt` 是本轮用户输入，`uuid` 绑定调用方提供的消息标识，`isMeta` 标记该消息是否属于元信息。`finally` 无条件把更新后的 read-file state 交还 Host——这是文件读取凭据缓存，不会把文件正文自动追加进模型上下文。

### 第三站：submitMessage 的装配流水线

`restored-src/src/QueryEngine.ts` 的 `submitMessage()`（约 209 行起）在调用 `query()` 之前做三件事：**预处理输入 → 组装上下文 → 包装依赖**。

第一步是预处理用户输入。`processUserInput()`（QueryEngine.ts:416）把用户输入处理成消息，同时构造 `processUserInputContext`——它携带 `messages`（消息历史的可变引用）、`setMessages`（斜杠命令改消息数组的写回通道）、`handleElicitation` 以及 `options`（命令、工具池、MCP 客户端、thinking 配置、主模型等），整个上下文会成为 `queryLoop` 直接使用的 `toolUseContext`。

第二步是组装模型上下文。用户侧上下文由基础上下文和 coordinator 上下文合并而来；系统提示由 `asSystemPrompt()` 拼接：

```ts
// 证据：restored-src/src/QueryEngine.ts —— system prompt 组装
const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

第三步是调用 `query()`，把一切交给查询内核：

```ts
// 证据：restored-src/src/QueryEngine.ts —— submitMessage() 调 query()
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

`messages` 是当前消息历史，`canUseTool` 是包装后的权限回调（最终面对 `allow`、`ask`、`deny` 三种结果），`fallbackModel` 是主模型失败时的候选，`querySource: 'sdk'` 标记调用来源。`maxTurns` 与 `taskBudget` 传入数值时分别约束轮数和任务预算，省略时跳过对应限制。这一步完成两个转换：用户输入被装配成模型可用的上下文，外部能力被收进循环可以直接使用的依赖。

### 第四站：queryLoop 的 while(true) 与停止条件

`restored-src/src/query.ts` 的 `query()`（219 行）只是外壳：它委托 `queryLoop()`，循环正常返回后再补齐队列命令的生命周期通知。真正的循环从 241 行的 `async function* queryLoop()` 开始，跨约 1488 行。

跨轮数据全部放进 `state`，循环用显式状态推进：

```ts
// 证据：restored-src/src/query.ts —— queryLoop() 的 state 与主循环骨架
let state: State = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  turnCount: 1,
  transition: undefined,
  // 压缩、输出 token 恢复等跨轮状态省略
}

while (true) {
  const { messages, turnCount } = state
  // 准备上下文 → 调用模型 → 执行工具或结束
}
```

`messages` 决定模型当前能看到什么，`toolUseContext` 保存可调用能力，`turnCount` 支持轮次边界，`transition` 记录上一轮为何继续。工具执行结束后，循环构造一份新状态，再进入下一轮。

每一轮通过 `deps.callModel()` 发起模型调用：

```ts
// 证据：restored-src/src/query.ts —— queryLoop() 调用模型
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
    // 其他 options 省略
  },
})) {
  // 处理流式事件和 assistant 消息
}
```

`thinkingConfig` 控制扩展思考配置，`tools` 提供模型可见的工具定义，`signal` 把取消传播到底层请求。`deps.callModel()` 返回异步生成器，上层可以边接收边处理。

流中既可能出现文本增量，也可能形成包含 `tool_use` 的 assistant message。`queryLoop()` 从内容块中筛出 `tool_use`，并把 `needsFollowUp` 设为 `true`：

```ts
// 证据：restored-src/src/query.ts（约 554 行）—— 唯一的循环出口信号
// Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly.
// Set during streaming whenever a tool_use block arrives — the sole
// loop-exit signal. If false after streaming, we're done (modulo stop-hook retry).
const toolUseBlocks: ToolUseBlock[] = []
let needsFollowUp = false
```

这段注释是本篇最重要的证据之一：**循环不依赖 `stop_reason` 判断是否继续，而是以流中实际到达的 `tool_use` 块为准**（详见自测 2）。

`while (true)` 的停止条件一共五类：

1. **正常完成（completed）**：流中没有新 `tool_use`（`needsFollowUp === false`），且恢复信号、Stop hook、token 预算均未触发；
2. **最大轮次（max_turns）**：`nextTurnCount` 超过 `maxTurns`，产出 `max_turns_reached` 附件后返回；
3. **预算/上下文限制**：token 预算耗尽或上下文达到上限，触发压缩或直接终止；
4. **取消**：流式取消、工具取消或 `abortController` 信号到达；
5. **错误**：模型/API 错误，重试耗尽后终止。

最大轮次的实现很直观：

```ts
// 证据：restored-src/src/query.ts —— max_turns 出口
if (maxTurns && nextTurnCount > maxTurns) {
  yield createAttachmentMessage({
    type: 'max_turns_reached',
    maxTurns,
    turnCount: nextTurnCount,
  })
  return { reason: 'max_turns', turnCount: nextTurnCount }
}
```

### 第五站：tool_use 先被编排，再经过权限

模型可以一次返回多个工具调用。`queryLoop()` 把它们交给流式执行器 `StreamingToolExecutor` 或 `runTools()`；调度层依据并发安全性选择串行或并行。

单个调用进入 `restored-src/src/services/tools/toolExecution.ts`，依次完成工具查找、输入校验、Hook 与权限判断。最重要的副作用边界是：只有允许分支才会进入 `tool.call()`：

```ts
// 证据：restored-src/src/services/tools/toolExecution.ts —— 权限决定副作用
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

`hookPermissionResult` 可取 `allow`、`ask`、`deny`、`passthrough`；`resolveHookPermissionDecision()` 把它与工具、输入、上下文、权限回调和消息合并成最终决定。`resolved.input` 保留 Hook 或用户修改后的输入；上下文里的 `toolUseId` 关联原请求，`userModified` 缺省为 `false`；进度回调把 `toolUseID` 与 `data` 转交上层。拒绝、取消和校验失败会形成错误结果并在副作用前返回——权限检查必须发生在 `tool.call()` 之前，并把拒绝结果重新交给模型。

### 第六站：tool_result 回填，附件注入，进入下一轮

工具返回值不能直接当作最终回答。它先被包装成带同一 `tool_use_id` 的 `tool_result`，再放进 user message 方向——assistant 已经提出行动，工具结果代表外部环境对这次行动的回应。

一轮的工具全部执行完后，还有一道附件注入环节：排队命令（如后台任务完成通知）会被快照为 attachment 消息，让模型在本轮就能响应它们：

```ts
// 证据：restored-src/src/query.ts（约 1580 行）—— 附件注入
for await (const attachment of getAttachmentMessages(
  null,
  updatedToolUseContext,
  null,
  queuedCommandsSnapshot,
  [...messagesForQuery, ...assistantMessages, ...toolResults],
  querySource,
)) {
  yield attachment
  toolResults.push(attachment)
}
```

注意源码注释强调：必须先等工具调用完成再注入附件，因为 API 不允许把 `tool_result` 消息与普通 user 消息交错。斜杠命令则被排除在轮中注入之外，必须等本轮结束走 `processSlashCommand`。

最后，循环把原消息、assistant 消息和工具结果接到一起，构造下一轮状态：

```ts
// 证据：restored-src/src/query.ts —— 下一轮状态
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  turnCount: nextTurnCount,
  // 压缩、恢复等跨轮字段透传
  transition: { reason: 'next_turn' },
}
state = next
```

`next.messages` 依次拼接查询前消息、assistant 消息和全部工具结果，成为下一次推理的输入；`toolUseContext` 换成带本轮查询跟踪信息的版本，`transition` 记录 `next_turn`。模型随后可以输出最终答案，也可以再次请求工具——回到 `while (true)` 顶部。

## 30 行 vs 1488 行的诚实说明

现在可以回答那个必须诚实面对的问题：既然骨架只有 30 行，为什么 `queryLoop()` 要写 1488 行？

答案在 `docs/blog/examples/minimal-agent/loop.py` 的函数注释里：

```python
# 证据：docs/blog/examples/minimal-agent/loop.py —— 骨架与生产的差距
"""
Minimal Agent Loop.

This is the skeleton of what queryLoop() does. The production
version adds: token budget management, streaming event dispatch,
error retry, abort signals, hooks triggering, MCP tool special
paths, and attachment message injection.
"""
```

1488 − 30 = **1458 行**。这 1458 行没有引入新的控制流思想，它们解决的是：token 预算管理（输入/输出分别记账、恢复策略）、流式事件分发（文本增量、thinking、工具进度、权限结果沿同一条链路产出）、错误重试（模型错误、上下文溢出、恢复信号）、abort 信号（取消时先补齐消息配对再退出）、hooks 触发（本轮开始/结束、Stop hook、工具权限）、MCP 工具特殊路径（资源、命令、客户端生命周期）、附件注入（排队命令、压缩结果、`max_turns_reached`）。

**这 1458 行就是 Harness 本身。** 30 行骨架 + 1458 行生产工程，才构成一个可用的 Agent 运行时。练习部分会让你亲手把骨架跑起来，感受两者之间的差距。

## 源码映射表

| 区域 | 文件 | 关键函数 | 本篇要点 | 后续章节 |
|---|---|---|---|---|
| 入口 | `src/entrypoints/cli.tsx` | `main()` | fast-path 零加载；其他路径动态导入 | 03 启动与初始化 |
| 完整 CLI | `src/main.tsx` | `main()`、`launchRepl()` | MDM/keychain 预取；Commander 解析；挂载 REPL | 03、04 多种运行入口 |
| 查询内核 | `src/QueryEngine.ts` | `ask()`、`submitMessage()` | 预处理输入、组装 system prompt、包装依赖、调 `query()` | 05 会话与无头调用 |
| Agent 循环 | `src/query.ts` | `query()`、`queryLoop()` | `while(true)`；五类停止条件；`needsFollowUp` 唯一出口信号 | 06 Agent 循环 |
| 消息与流 | `src/query.ts`、API 层 | `deps.callModel()` | AsyncGenerator 事件流；`stop_reason` 不可靠 | 07 消息模型、08 API 流式传输 |
| 工具执行 | `src/services/tools/toolExecution.ts` | `resolveHookPermissionDecision()`、`tool.call()` | 权限在副作用前；`tool_result` 回填协议 | 09-12 工具与权限系列 |
| 附件注入 | `src/query.ts` | `getAttachmentMessages()` | 排队命令作为附件；结果与普通消息不交错 | 18 hooks、23 任务运行时 |
| 文件状态 | `src/QueryEngine.ts` | `getReadFileState()`、`setReadFileCache()` | read-file state 在生成器退出时交还 Host | 14 文件与回滚 |

## 设计决策

**为什么用 AsyncGenerator？** 一次请求是一条实时事件流：模型 token、工具进度、权限结果、附件、取消和最终消息沿同一条链路持续产出，REPL、IDE 和 SDK 可以边收边渲染。更关键的是组合性：`ask()` 用 `yield*` 委托 `submitMessage()`，后者再用 `yield*` 进入 `queryLoop()`，三层生成器直接拼接，取消通过生成器 return 自然传播，不需要额外的发布订阅层。

**为什么 REPL 和 SDK 共用同一个 QueryEngine？** 两类宿主对"外壳"的要求完全不同——终端要实时渲染和权限询问，SDK 要结构化事件——但它们驱动的是同一个 Agent 循环。宿主适配层只换外壳（`querySource` 区分 `repl_main_thread` 与 `sdk`），内核（`submitMessage` → `query` → `queryLoop`）完全复用。如果为每个入口写一套循环，错误恢复、压缩、预算这些横切逻辑就要复制 N 份。

**为什么终端 UI 用 React（Ink）？** `main.tsx` 直接 import React 并使用 Ink 的 `Root`。流式输出需要高频增量重渲染，声明式组件树比命令式 ANSI 控制序列容易维护得多；键盘绑定、组件复用和整个团队的技能栈都是现成的。React 在这里是渲染层，与查询内核通过事件契约解耦。

<details>
<summary><b>行业对比（折叠）：为什么 Claude Code 不直接用 LangGraph，Open SWE 为什么适合</b></summary>

先说结论：用 LangGraph 开发编程 Agent 是拿通用编排框架搭自己的系统，Claude Code 连编排层本身都是自研的。

| 对比项 | 用 LangGraph 开发编程 Agent | Claude Code |
|---|---|---|
| 控制流 | 开发者定义 node、edge 和条件分支 | `queryLoop` 直接控制模型流、工具执行和下一轮推理 |
| 状态 | 开发者设计 shared state 并选择 checkpointer | 以消息历史为主，维护 `ToolUseContext`、AppState、文件缓存和压缩状态 |
| 工具 | 文件、Shell、搜索工具仍要自己实现 | 已提供注册、校验、并发编排、进度事件和结果裁剪 |
| 人工介入 | 用 `interrupt()` 暂停图再从 checkpoint 恢复 | 权限判断嵌在工具执行路径中，未允许不产生副作用 |
| 运行方式 | 适合自定义工作流、云端异步任务 | 优先服务终端、IDE 和 SDK 的实时流式交互 |

原因有四。第一，主要复杂度在循环内部的产品语义：`queryLoop()` 约 1488 行直接连接模型流、工具并发、消息队列、token 预算、压缩、hooks、取消和错误恢复——换成 LangGraph，这些代码不会消失，只会被搬进 node、middleware 或 graph state。第二，一次请求是实时事件流：自研循环可以直接消费内部消息类型、权限状态和取消语义，不需要转换成通用 graph event。第三，权限直接约束副作用：`allow`/`ask`/`deny`、hooks、输入修改、沙箱和 permission mode 必须发生在 `tool.call()` 之前，这套权限引擎即使采用 LangGraph 也要自己维护。第四，自研循环让团队掌握完整热路径。

Open SWE（约 10.3k stars，2026 年 7 月）是很好的对照：它从 Slack、Linear、GitHub 接收任务，在云端沙箱改代码、跑测试、开 PR，还要管理子 Agent 和异步恢复——明显的多阶段工作流和持久化需求，LangGraph 的 graph、state、interrupt 和运行平台直接产生价值。Claude Code 的核心场景是用户坐在终端前与持续运行的模型-工具循环实时协作，通用图框架能替代的部分很小。

最后归纳：LangGraph 擅长显式工作流、共享状态、暂停恢复和云端长任务；Claude Code 强调本地实时流、细粒度权限和模型工具热循环。Claude Code 技术上可以用 LangGraph，但 LangGraph 只能替换最外层的循环表达，替换不了工具、权限、上下文和交互逻辑。这个判断来自源码结构，证据范围限于代码架构。

</details>

## 练习

**练习 1：跑最小 Agent Loop**

```bash
# 前提：pip install anthropic，且 export ANTHROPIC_API_KEY=...
cd docs/blog/examples/minimal-agent
python loop.py "Read loop.py and tell me which model it uses, then list the files in this directory"
```

观察输出中的 `─── Turn N ───`：这个 prompt 需要两次工具调用（读文件 + 列目录），至少会走两轮。数一数它最终用了几轮完成，并对照 20 行伪代码确认每一轮做了什么。

**练习 2：看生产环境的事件类型**

对同一个 prompt 运行生产版，统计事件流里出现了哪些事件：

```bash
claude -p "Read loop.py and tell me which model it uses" --output-format stream-json 2>/dev/null | grep '"type"' | sort | uniq -c
```

你会看到 `system`、`assistant`、`user`（工具结果）等事件类型——这正是"一条请求 = 多轮 agent loop"在生产事件流上的证据。

## 自测

<details>
<summary>1. Agent 循环的 5 个退出条件是什么？</summary>

正常完成（`completed`：流中没有新 `tool_use`，且恢复信号、Stop hook、token 预算未触发）、最大轮次（`max_turns`：`nextTurnCount > maxTurns`）、预算/上下文限制、取消（流式/工具/abort 信号）、错误（模型/API 错误重试耗尽）。注意 Stop hook 阻止继续发生在完成路径上，属于"正常出口前的附加检查"。

</details>

<details>
<summary>2. 为什么流式模式下 stop_reason 不可靠？</summary>

流式模式下内容块增量到达，`stop_reason` 要等 `message_delta` 在流末尾才送达，而且并不总能被正确设置（`query.ts` 约 554 行的源码注释原话：`stop_reason === 'tool_use' is unreliable -- it's not always set correctly`）。因此 `queryLoop()` 以流中实际出现的 `tool_use` 块为准：只要 `toolUseBlocks` 非空就把 `needsFollowUp` 置为 `true`——这是唯一的循环出口信号。

</details>

<details>
<summary>3. submitMessage() 在调用 query() 之前做了什么？</summary>

三步：`processUserInput()` 预处理用户输入并构造 `processUserInputContext`（消息引用、命令、工具池、MCP 客户端、thinking 配置）；组装上下文——`userContext` 合并 coordinator 上下文，`systemPrompt` 由 `asSystemPrompt()` 拼接默认/自定义提示与追加提示；包装依赖——`wrappedCanUseTool` 权限回调、`fallbackModel`、`querySource`、`maxTurns`、`taskBudget`。

</details>

## 回顾（折叠）

<details>
<summary>用 LangGraph 开发编程 Agent，与 Claude Code 有什么区别？（回答 01 留下的问题）</summary>

区别很大。两者都有"模型调用工具、工具返回结果、模型继续推理"这条循环，但层次不同。

第一，**Claude Code 自研了整个 query runtime**。`queryLoop()` 约 1488 行直接控制模型流、工具并发、消息队列、token 预算、上下文压缩、hooks、取消和错误恢复。换成 LangGraph，这些逻辑不会消失，只是搬进 node、middleware 或 graph state——通用图引擎替换的是循环的表达方式，不是循环里的产品语义。

第二，**Claude Code 的一次请求是一条实时事件流**。`submitMessage()` 与 `queryLoop()` 都是 AsyncGenerator，token、工具进度、权限结果、附件沿同一条链路产出，REPL、IDE、SDK 立即消费。LangGraph 也支持 streaming，但需要把自己的消息类型、权限状态和取消语义接到图运行时上。

第三，**权限直接约束副作用**。`allow`/`ask`/`deny`、hooks、输入修改、沙箱必须在 `tool.call()` 之前完成判断，拒绝结果再交回模型。即使采用 LangGraph，这套权限引擎仍然要自己维护。

第四，**Open SWE 的反例**：它从 Slack/Linear/GitHub 接收任务、云端沙箱执行、管理子 Agent 和异步恢复，多阶段工作流与持久化需求让 LangGraph 的 graph、state、interrupt 直接产生价值。Claude Code 的场景是终端前的实时协作，能替代的部分很小。

结论：LangGraph 擅长显式工作流、共享状态、暂停恢复和云端长任务；Claude Code 强在本地实时流、细粒度权限和模型工具热循环。Claude Code 选择自研的合理解释是——它的 graph 很简单，节点内部却高度定制，直接控制循环比接入通用图运行时更可控。

</details>

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
