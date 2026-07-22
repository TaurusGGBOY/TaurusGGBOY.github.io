---
title: "Claude Code源码解读05：如何编排会话与无头调用"
published: 2026-07-22T10:26:41+08:00
description: "拆解 QueryEngine 如何为 headless 和 Agent SDK 维护会话状态、转换结构化事件，并处理权限、中断、预算与执行结果。"
tags: ["claude-code", "source-code", "ai-agent", "query-engine"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-05/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇的问题是：当代码需要结合 Claude Code 时，到底应该直接调用 `claude -p`，还是使用 Claude Agent SDK；分别在什么场景下使用它们？

先给结论：**如果你的程序只需要“提交任务，等待结果”，优先使用 `claude -p`；如果还要在运行过程中持续观察、控制并维持会话，使用 Claude Agent SDK。**

这里的 SDK 指 Claude Agent SDK，也就是把 Claude Code 作为 Agent 运行时接入程序的 SDK，不是只负责调用 Messages API 的 `@anthropic-ai/sdk`。后者提供模型 API 客户端，不会自动带上 Claude Code 的项目上下文、内置工具和权限系统。

两种方式可以先放进同一张表：

| 选择维度 | `claude -p` | Claude Agent SDK |
|---|---|---|
| 调用方式 | 启动 CLI 子进程，通过参数或 stdin 传入 prompt | 使用 TypeScript、Python 等语言 API 创建并消费查询 |
| 最自然的任务形态 | 一次任务、一次结果，完成后退出 | 多轮会话、长任务或需要持续交换控制消息的任务 |
| 输出 | `text`、`json` 或 NDJSON `stream-json` | 类型化的 user、assistant、result、system 与控制事件 |
| 权限 | 预先配置 allow/deny、permission mode，或接入 permission prompt tool | 由 SDK 宿主接收权限请求，再通过代码、策略或 UI 返回决定 |
| 中断与生命周期 | 主要依赖进程信号、超时、退出码和外层进程管理 | 使用 SDK 提供的中断、会话和控制接口 |
| 工程成本 | 依赖少，但参数转义、stdout 解析和异常处理由调用方负责 | 需要引入 SDK，消息解析、控制协议和会话操作由 SDK 封装 |
| 典型场景 | Shell 脚本、CI 检查、Git hook、定时任务、一次性代码分析 | IDE、Web 服务、桌面应用、聊天界面和 Agent 编排系统 |

因此，CI 中检查改动、定时生成项目摘要，或者把一份输入转换成固定 JSON，通常没有必要先搭建长期会话宿主。准备输入，执行 `claude -p --output-format json`，检查 stdout、stderr 和退出码，进程边界反而更清楚。

但如果同一个会话要连续接收消息，工具调用需要让业务 UI 动态审批，或者调用方想实时显示 assistant、工具进度、system 与 result 事件，SDK 会更合适。此时你关心的不只是“最后回答了什么”，还包括“现在进行到哪里、接下来能不能执行、用户是否中断了任务”。

两者也不是两套互不相关的 Agent。上一章已经看到，`claude -p` 和 Agent SDK 最终都可以进入 headless、`StructuredIO` 与 `QueryEngine` 这条路径。SDK 的主要价值发生在宿主一侧：它替调用方封装参数、NDJSON、权限控制消息和会话操作，并没有把 Claude Code 变成一个没有进程边界的普通函数。

一个实用的迁移顺序是：先用 `claude -p --output-format json` 验证流程；当业务代码开始大量处理流式 JSON、请求 ID、权限响应匹配、会话 ID 和中断时，再换成 Agent SDK。迁移点不由 prompt 长短决定，而由调用方已经承担了多少“宿主职责”决定。

回答完选型问题，我们正好可以进入本篇的核心：无论输入来自 `claude -p` 还是 SDK，Claude Code 为什么还需要一个 `QueryEngine`，把宿主配置、会话状态、Agent 事件和最终结果收进同一个边界？

## QueryEngine 先解决什么问题

本文继续以 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码为边界。这个版本中的 `QueryEngine` 服务 headless/SDK 路径；交互式 REPL 仍直接调用 `query()`，不能把它描述成所有运行模式统一使用的会话类。

我们先建立一个简单模型：`query()` 负责运行一次 Agent 循环，`QueryEngine` 则负责让这个循环能够被外部程序反复调用，并把内部消息转换成稳定的 SDK 事件。

![QueryEngine 会话状态与事件边界手绘图](/images/posts/claude-code-source-reading-05/05-query-engine-handdrawn.png)

图中最重要的不是类名，而是左右两侧的边界。宿主把 prompt、配置和控制动作交进来；`QueryEngine` 保存跨 turn 状态，调用 `processUserInput()` 与 `query()`；然后把内部消息整理成 `system`、`assistant`、`user`、`stream_event` 和最终 `result` 等 SDK 消息。

源码在类定义前写得很明确：一个 `QueryEngine` 对应一段 conversation，每次 `submitMessage()` 开始一个新 turn，消息、文件缓存和 usage 等状态会跨 turn 保留。

## 构造函数保存的是会话，不只是 prompt

`QueryEngineConfig` 很长，但可以按职责分成五组：工作目录与能力、权限与 AppState、已有会话状态、模型与预算、SDK 输出选项。构造函数写入的几项核心状态如下，技能发现和 nested memory 等辅助字段暂时省略：

```ts
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private readFileState: FileStateCache

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }
}
```

`config` 是完整的宿主能力集合；`initialMessages` 为 `undefined` 时回退到空数组；`abortController` 未提供时由 engine 自己创建。`readFileCache` 是必填值，不存在默认回退。`permissionDenials` 与 `totalUsage` 在构造时清空，此后随同一个 engine 的多次提交继续累计。

配置里的几个可选值会直接改变后面的控制流：

- `thinkingConfig` 可以是 `{ type: 'adaptive' }`、`{ type: 'enabled', budgetTokens: number }` 或 `{ type: 'disabled' }`。调用方未传时，源码根据默认开关选择 `adaptive` 或 `disabled`。
- `maxTurns`、`maxBudgetUsd` 和 `jsonSchema` 为 `undefined` 时，不启用对应的 turn 上限、美元预算检查或结构化输出约束。
- `verbose`、`replayUserMessages`、`includePartialMessages` 默认都是 `false`。最后一项为真时才向 SDK 暴露底层 `stream_event`。
- `customSystemPrompt` 会替换默认 system prompt；`appendSystemPrompt` 只是在选中的 prompt 后追加内容。两者都是开放字符串，不存在可穷举候选值。
- `userSpecifiedModel` 与 `fallbackModel` 是开放模型字符串，具体能否解析取决于运行时配置与模型注册表，静态源码不能列出所有合法名称。
- `agents` 未传时回退为空数组；`abortController`、`setSDKStatus`、`handleElicitation` 和 `orphanedPermission` 都可以为 `undefined`。

这也解释了为什么不能把 `QueryEngine` 简化成 `ask(prompt)`。prompt 只是这一轮输入；工具、权限、系统提示词、消息历史、预算、取消和输出格式共同定义了一段可运行会话。

## submitMessage 先处理输入，再决定要不要请求模型

`submitMessage()` 接收字符串或 Anthropic content blocks。第二个参数本身可省略，其中 `uuid` 用来让宿主关联这条输入，`isMeta` 用来标记元消息；两者为 `undefined` 时都交给下游默认逻辑处理。

每轮开始后，它先固定 cwd、读取 AppState、解析模型和 thinking 配置，再构建 system prompt。然后才调用 `processUserInput()`：

```ts
const {
  messages: messagesFromUserInput,
  shouldQuery,
  allowedTools,
  model: modelFromUserInput,
  resultText,
} = await processUserInput({
  input: prompt,
  mode: 'prompt',
  setToolJSX: () => {},
  context: {
    ...processUserInputContext,
    messages: this.mutableMessages,
  },
  messages: this.mutableMessages,
  uuid: options?.uuid,
  isMeta: options?.isMeta,
  querySource: 'sdk',
})

this.mutableMessages.push(...messagesFromUserInput)

setAppState(prev => ({
  ...prev,
  toolPermissionContext: {
    ...prev.toolPermissionContext,
    alwaysAllowRules: {
      ...prev.toolPermissionContext.alwaysAllowRules,
      command: allowedTools,
    },
  },
}))

const mainLoopModel = modelFromUserInput ?? initialMainLoopModel
```

这里的返回值说明“提交消息”并不一定等于“请求模型”。`messagesFromUserInput` 是输入处理产生的用户消息、附件或命令结果；`shouldQuery` 决定是否继续进入 Agent；`allowedTools` 把 slash command 带来的权限变化写回 AppState；`modelFromUserInput` 存在时覆盖本轮初始模型；`resultText` 则供纯本地命令直接生成结果。

`mode` 在这里固定为 `'prompt'`，`querySource` 固定为 `'sdk'`，`setToolJSX` 是空函数，因为 headless 宿主没有 REPL 的 React 工具界面。换句话说，`processUserInput()` 仍然复用命令与输入规范化能力，但 UI 副作用在这个入口被显式拿掉了。

还有一个容易忽略的持久化顺序：源码在调用模型之前就记录用户消息。这样即使进程在 API 返回前被停止，`--resume` 仍有机会找到已经接受的输入，而不是只看到不完整的队列记录。`--bare` 路径会把这次写入变成 fire-and-forget，普通路径则等待写入完成；真实磁盘是否成功仍属于运行时结果。

## system init 是宿主看到的第一份能力清单

输入处理完成后，`QueryEngine` 会从缓存加载 skills 与 plugins，然后先产出一条 `system` init 消息。它包含工具、MCP clients、模型、permission mode、commands、agents、skills、plugins 和 fast mode 状态。

这条消息的作用不是让模型继续推理，而是让 SDK 宿主知道当前会话到底装配了什么。UI 可以据此显示模型和能力，调用方也可以在真正的 assistant 消息到达前完成状态初始化。

如果 `shouldQuery` 为 `false`，控制流不会进入 `query()`。本地 slash command 的 stdout/stderr、压缩边界等消息会先被转换成 SDK 可消费的事件，随后直接返回一个 `result: success`。因此，SDK 收到 success 并不能反推出这轮一定调用过模型。

## 进入 query 后，内部消息要重新映射成 SDK 事件

真正需要模型时，`submitMessage()` 把整理好的上下文交给 `query()`。下面只保留 assistant 分支来展示映射方式，其余消息分支在源码中紧随其后：

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
  if (message.type === 'user') {
    turnCount++
  }

  switch (message.type) {
    case 'assistant':
      if (message.message.stop_reason != null) {
        lastStopReason = message.message.stop_reason
      }
      this.mutableMessages.push(message)
      yield* normalizeMessage(message)
      break
    // 其余消息分支省略
  }
}
```

这段代码展示了两层消息。`query()` 产生的是 Claude Code 内部 `Message`；`normalizeMessage()` 与各个 switch 分支把它们转换成 SDK 协议。`assistant`、`progress` 和 `user` 都有各自的写回逻辑；`stream_event` 默认只用于内部统计，只有 `includePartialMessages === true` 才向宿主透传。

这里的 `canUseTool` 也不是原始回调。`QueryEngine` 在外面包了一层：只要结果不是 `allow`，就把 `tool_name`、`tool_use_id` 和 `tool_input` 记录进 `permissionDenials`，最终随 result 返回。权限判断本身仍由调用方传入的回调完成，engine 只负责留下可观察结果。

`system` 消息不会全部透传。`compact_boundary` 会变成 SDK 的同名边界事件，并释放压缩前消息；`api_error` 会变成 `api_retry`，包含 attempt、最大重试次数、延迟与错误分类；其他内部 system 消息在 headless 模式下被过滤。宿主看到的是稳定协议，而不是内部消息类型的原样镜像。

## result 不是一段文本，而是一份终止报告

很多脚本只读取 `result.result`，但 `QueryEngine` 真正返回的是一份终止报告。正常路径的结构大致如下：

```ts
yield {
  type: 'result',
  subtype: 'success',
  is_error: isApiError,
  duration_ms: Date.now() - startTime,
  duration_api_ms: getTotalAPIDuration(),
  num_turns: turnCount,
  result: textResult,
  stop_reason: lastStopReason,
  session_id: getSessionId(),
  total_cost_usd: getTotalCost(),
  usage: this.totalUsage,
  modelUsage: getModelUsage(),
  permission_denials: this.permissionDenials,
  structured_output: structuredOutputFromTool,
  fast_mode_state: getFastModeState(
    mainLoopModel,
    initialAppState.fastMode,
  ),
  uuid: randomUUID(),
}
```

`result` 是最后一个有效 assistant 文本块提取出的字符串，没有文本时可能是空串；`structured_output` 只有结构化输出工具实际产出数据时才存在。`stop_reason` 初始为 `null`，流式响应到达 `message_delta` 后才可能更新。`is_error` 即使在 `subtype: 'success'` 下也可能为真，因为最终 assistant 消息可能被标记成 API error message，所以调用方不能只检查 subtype。

源码能够确认的主要 result subtype 包括：

- `success`：本地命令或 Agent 执行正常收口。
- `error_max_turns`：出现 `max_turns_reached` attachment。
- `error_max_budget_usd`：配置了 `maxBudgetUsd`，并且累计成本达到或超过它。
- `error_max_structured_output_retries`：提供 `jsonSchema` 后，结构化输出重试达到上限；环境变量未设置时默认上限是 5。
- `error_during_execution`：循环结束后找不到满足成功条件的 assistant/user 终态。

每个错误 result 都带上 session、耗时、turn、usage、cost、permission denials 和错误详情。这让宿主可以按结构处理失败，而不必从 stderr 文本猜测发生了什么。

`maxTurns` 与 `maxBudgetUsd` 的边界也不同。前者交给更下层的 `query()` 产生附件，后者由 `QueryEngine` 在消费每条消息后检查。静态源码能确认检查位置，不能证明一次线上调用一定会精确在某个 token 或网络请求边界停止。

## 哪些状态会跨 turn 保留

一段长会话是否成立，取决于下一次 `submitMessage()` 能不能接着使用上一次的结果。

`mutableMessages` 是最明显的状态。输入消息、assistant、工具结果、progress、attachment 和部分 system boundary 会在循环中写回；下一轮再从这份数组开始。发生 compact 或 history snip 时，旧消息可能被裁掉，因此“保留会话”不等于“永久保存完整原文”。

`readFileState` 保存文件读取缓存。`ask()` 构造 engine 前会克隆宿主缓存，并在 `finally` 中无论成功或异常都写回最新状态，避免下一轮丢失文件一致性信息。

`totalUsage` 与 `permissionDenials` 也属于 engine 生命周期。源码没有在每次 `submitMessage()` 开头清零它们，所以最终 result 反映的是同一个 engine 已累计的可观察状态，而不是天然隔离的单 turn 统计。

并非所有字段都跨 turn 无限增长。`discoveredSkillNames` 会在每次提交开始时清空；已经加载的 nested memory paths 则保留。HISTORY_SNIP 功能开启时，headless engine 还会在边界重放并缩短消息 store，避免长 SDK 会话一直持有已经失效的历史。

## interrupt、setModel 与几个读取接口

类尾部的控制接口很短，却明确了宿主能控制到哪一层：

```ts
interrupt(): void {
  this.abortController.abort()
}

getMessages(): readonly Message[] {
  return this.mutableMessages
}

getReadFileState(): FileStateCache {
  return this.readFileState
}

getSessionId(): string {
  return getSessionId()
}

setModel(model: string): void {
  this.config.userSpecifiedModel = model
}
```

`interrupt()` 没有参数，也没有返回状态，只是触发当前 `AbortController`。这能证明取消信号进入同一条查询链，不能证明已经发生的工具副作用会自动回滚。`setModel()` 接收任意模型字符串并写回配置，下次提交时再解析；源码没有在这个 setter 中提前校验候选模型。

`getMessages()` 返回只读视图类型，但底层仍是 engine 自己维护的数组；`getReadFileState()` 暴露文件缓存；`getSessionId()` 返回全局 bootstrap session id，而不是在类内部另行生成一个 conversation id。也就是说，QueryEngine 管理会话状态，却不是所有会话身份和持久化机制的唯一所有者。

还有一个实现边界值得注意：当前 `interrupt()` 只 abort 已有 controller，类中没有在下一次 `submitMessage()` 前自动替换 controller 的代码。调用方在中断后是否复用同一实例，要结合上层 SDK 生命周期处理，不能仅凭这个方法推断“中断后直接提交下一轮一定可用”。

## ask 是一次性便利包装，不是另一套引擎

文件最后还导出了一个 `ask()`。它接收完整配置，创建一个新的 `QueryEngine`，提交一次消息，并在 `finally` 中同步 read-file cache：

```ts
const engine = new QueryEngine({
  cwd,
  tools,
  commands,
  mcpClients,
  agents,
  canUseTool,
  getAppState,
  setAppState,
  initialMessages: mutableMessages,
  readFileCache: cloneFileStateCache(getReadFileCache()),
  // 省略其余可选配置
})

try {
  yield* engine.submitMessage(prompt, {
    uuid: promptUuid,
    isMeta,
  })
} finally {
  setReadFileCache(engine.getReadFileState())
}
```

`ask()` 的 `prompt` 可以是字符串或 content block 数组；`promptUuid`、`isMeta` 与多数模型、预算、输出选项都可以为 `undefined`。`verbose`、`replayUserMessages`、`includePartialMessages` 默认是 `false`，`mutableMessages` 与 `agents` 默认是空数组。

它适合“已有宿主状态，完成一次提交”的调用点。真正要让多轮状态自然驻留在对象中，宿主需要持有同一个 `QueryEngine` 并多次调用 `submitMessage()`；如果每轮都重新调用 `ask()`，就必须由外层把消息和文件缓存再次传回来。

因此，`ask()`、`QueryEngine` 与 `query()` 可以这样区分：`ask()` 是一次性入口包装，`QueryEngine` 是 headless conversation 的状态壳，`query()` 是一次 Agent 执行的生成器。三个名字靠得很近，生命周期却不一样。

## 静态源码还能证明到哪里

本篇可以从源码直接确认构造参数、默认值、状态字段、消息转换、result subtype 和调用方向，也可以确认一个 engine 设计为承载多个 turn。

“QueryEngine 是 headless 宿主与 Agent loop 之间的会话边界”属于调用关系支撑的架构解释。它不代表服务端替你永久托管了会话，也不代表 SDK 自动解决并发、进程恢复和资源隔离。

真实任务的耗时、费用、重试次数、消息规模、磁盘写入成功率和中断响应速度仍取决于模型、网络、工具、运行时配置与外部宿主，不能由 2.1.88 的静态代码直接推出。

## 小结

`QueryEngine` 的价值不是再实现一遍 Agent，而是给 headless/SDK 提供稳定的 conversation 边界。

它接收宿主提供的工具、权限、AppState、模型和预算，把 prompt 先交给 `processUserInput()`，在需要时进入 `query()`，再把内部消息转换成 SDK 事件与结构化 result。同一个实例保留消息、文件缓存、usage 和权限拒绝信息；取消、切换模型和状态读取也从这里暴露给宿主。

理解这层以后，`claude -p` 与 Agent SDK 的差异就更清楚了：两者可以复用相同的 engine 和 Agent loop，区别主要在谁负责长期持有会话、解释事件并回应控制请求。

## 留给下一篇的问题

`QueryEngine.submitMessage()` 把整理好的会话状态交给 `query()` 以后，`queryLoop()` 怎样判断应该继续调用模型、执行工具，还是结束这一轮 Agent 运行？
