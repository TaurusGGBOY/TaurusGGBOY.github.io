---
title: "Claude Code源码解读10：多个 tool_use 如何串并行执行"
published: 2026-07-24T09:30:00+08:00
description: "拆解 Claude Code 如何依据单次输入的并发安全性划分 tool_use 批次，并按原顺序串并行执行、回传进度和处理取消与错误。"
tags: ["claude-code", "source-code", "ai-agent", "tool-orchestration"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-10/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：当同一次模型响应包含多个 `tool_use` 时，Claude Code 如何判断哪些工具可以并行执行，哪些必须串行？

答案不是维护一张“Read 并行、Edit 串行”的固定名单。Claude Code 会先找到每个工具，用它的输入 Schema 解析这一次调用，再执行工具自己的 `isConcurrencySafe(parsedInput)`。只有返回 `true` 的调用才属于并发安全调用；工具不存在、输入解析失败、判断函数抛错，都会保守地按 `false` 处理。

接着，调度器按模型给出的顺序扫描这些调用。相邻的并发安全调用会合并成一个并行批次；任何不安全调用都会单独成为一个串行屏障。批次之间始终按原顺序执行。

所以更准确的说法是：**Claude Code 并行的是连续出现、且针对当前输入明确声明并发安全的工具调用；其余调用逐个串行。**

## 不要把多个 tool_use 想成 Promise.all

我们先看一个具体例子。假设 Claude 一次返回了六个调用：

```text
Read A → Grep B → Edit C → Read D → Write E → Glob F
```

如果两个读取、搜索调用都判断为并发安全，而 Edit、Write 不安全，调度结果会变成：

```text
[Read A, Grep B] → [Edit C] → [Read D] → [Write E] → [Glob F]
     并行             串行        并行        串行        并行
```

注意最后三个调用不会被重新排列。Claude Code 不会为了“跑得更快”，把 `Read D` 和 `Glob F` 越过 `Write E` 合并。这样做的原因很直接：后面的读取可能应该看到前面写入后的文件状态。

这套机制位于 `restored-src/src/services/tools/toolOrchestration.ts`。本文基于仓库还原出的 Claude Code 2.1.88 源码，只讨论静态代码能够确认的控制流；。下文源码块均为真实源码的短摘录，未展示的日志、类型和无关分支会在正文中明确说明。

![Claude Code 多工具串并行调度流程](/images/posts/claude-code-source-reading-10/10-tool-orchestration-handdrawn.png)

## 第一步：判断的是这次调用，不只是工具名称

真正的分组函数叫 `partitionToolCalls`：

```ts
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            return false
          }
        })()
      : false
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}
```

`partitionToolCalls` 在 `restored-src/src/services/tools/toolOrchestration.ts` 中负责把一组调用切成有序批次。

- `toolUseMessages` 是模型这次响应里的 `ToolUseBlock[]`，数组顺序就是扫描顺序。
- `toolUseContext` 提供当前可用工具集合；这里实际读取的是 `toolUseContext.options.tools`。
- 返回值 `Batch[]` 中，每个批次都有布尔值 `isConcurrencySafe` 和调用数组 `blocks`。`true` 批次可以包含多个连续调用；`false` 批次在这段实现中只包含一个调用。

这里有三层“失败即串行”。`findToolByName` 没找到工具时，`tool` 是 `undefined`；可选链让 `parsedInput` 也成为 `undefined`，最终落到 `false`。`safeParse` 返回失败结果时同样是 `false`。即使输入合法，只要 `isConcurrencySafe` 抛出异常，`catch` 仍然返回 `false`。

这意味着无效输入不会因为“看起来像读取命令”而提前并发执行。真正的输入校验和错误结果会在单工具执行阶段完成；这里的 `safeParse` 只是调度前的保守分类。

## isReadOnly 和 isConcurrencySafe 不是同一个问题

“只读”通常意味着“适合并发”，但源码把它们保留成两个能力。以 Bash 工具为例：

```ts
isConcurrencySafe(input) {
  return this.isReadOnly?.(input) ?? false;
},
isReadOnly(input) {
  const compoundCommandHasCd = commandHasAnyCd(input.command);
  const result = checkReadOnlyConstraints(input, compoundCommandHasCd);
  return result.behavior === 'allow';
},
```

这段代码位于 `restored-src/src/tools/BashTool/BashTool.tsx`。`isConcurrencySafe(input)` 接收已经按 Schema 解析的本次 Bash 输入，并复用 `isReadOnly(input)` 的判断；如果 `isReadOnly` 是 `undefined`，空值合并运算符 `??` 会回退到 `false`。`isReadOnly` 检查具体的 `input.command`，所以同一个 Bash 工具可能因命令不同得到不同分类。

相比之下，FileRead 的两个函数都固定返回 `true`。但这不代表调度器直接读取 `isReadOnly`：`partitionToolCalls` 调用的仍然是 `isConcurrencySafe`。

还有一个容易忽略的默认值。`restored-src/src/Tool.ts` 的 `buildTool` 会为没有声明该能力的工具补上 `isConcurrencySafe: () => false`。也就是说，新工具忘记声明时不会被乐观地并行，而是默认串行。这个默认值没有 `null` 分支；返回值经过 `Boolean(...)` 归一化后，只剩 `true` 和 `false` 两种调度结果。

## 第二步：相邻安全调用组成批次

`partitionToolCalls` 的关键不只是分类，还有“相邻”二字。

当当前调用安全，并且最后一个批次也安全时，它会被追加到最后一个批次。除此之外，都会新建批次。于是一个不安全调用天然成为屏障：它前后的两个安全区间不会跨屏障合并。

这个设计没有分析两个工具会不会访问同一路径，也不会现场构建文件依赖图。是否安全由工具根据解析后的输入自行回答，调度器只执行统一规则。

## 第三步：批次并行，批次之间串行

分组完成后，`runTools` 顺序遍历每个批次：

```ts
export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(
    toolUseMessages,
    currentContext,
  )) {
    if (isConcurrencySafe) {
      const queuedContextModifiers: Record<
        string,
        ((context: ToolUseContext) => ToolUseContext)[]
      > = {}
      // Run read-only batch concurrently
      for await (const update of runToolsConcurrently(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )) {
        if (update.contextModifier) {
          const { toolUseID, modifyContext } = update.contextModifier
          if (!queuedContextModifiers[toolUseID]) {
            queuedContextModifiers[toolUseID] = []
          }
          queuedContextModifiers[toolUseID].push(modifyContext)
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
      for (const block of blocks) {
        const modifiers = queuedContextModifiers[block.id]
        if (!modifiers) {
          continue
        }
        for (const modifier of modifiers) {
          currentContext = modifier(currentContext)
        }
      }
      yield { newContext: currentContext }
    } else {
      // Run non-read-only batch serially
      for await (const update of runToolsSerially(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )) {
        if (update.newContext) {
          currentContext = update.newContext
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
    }
  }
}
```

这是 `restored-src/src/services/tools/toolOrchestration.ts` 中完整的 `runTools` 函数。并行分支收集和回放 `contextModifier` 的原因，下一节单独解释。

- `toolUseMessages` 是待调度的所有工具调用。
- `assistantMessages` 用来按 `tool_use.id` 找到产生该调用的 assistant 消息，后续错误和结果才能保留关联。
- `canUseTool` 是权限决策函数；它不负责并发分类，而是在单工具执行链中决定允许、询问或拒绝。
- `toolUseContext` 包含工具列表、应用状态、文件状态与 `abortController` 等运行上下文。
- 生成器产出 `MessageUpdate`。其中 `message` 是可选字段，可以为 `undefined`；`runTools` 产出的 `newContext` 是必填字段，每次更新都携带当时的上下文。`queryLoop` 仍对 `update.newContext` 做存在性检查，因为 `toolUpdates` 还可能来自另一种执行器。

外层是普通 `for...of`。因此，当前批次的异步生成器结束以后，才会进入下一个批次。所谓“串行执行不安全工具”，在当前分组规则下实际表现为：每个不安全批次只有一个 `blocks` 元素，必须等它结束，后面的批次才能启动。

## 并发不是无限并发

安全批次交给 `runToolsConcurrently`。它把每个调用包装成异步生成器，再交给通用的 `all` 合并：

```ts
yield* all(
  toolUseMessages.map(async function* (toolUse) {
    toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(toolUse.id),
    )
    yield* runToolUse(
      toolUse,
      assistantMessages.find(_ =>
        _.message.content.some(
          _ => _.type === 'tool_use' && _.id === toolUse.id,
        ),
      )!,
      canUseTool,
      toolUseContext,
    )
    markToolUseAsComplete(toolUseContext, toolUse.id)
  }),
  getMaxToolUseConcurrency(),
)
```

这段代码来自 `runToolsConcurrently`。它的四个参数与 `runTools` 对应，但 `toolUseMessages` 在这里已经是当前安全批次，而不是整次模型响应。每个调用开始前把自己的字符串 `toolUse.id` 加入 `inProgressToolUseIDs`，`runToolUse` 结束后再删除。这个集合用于表达“哪些调用仍在运行”，不是结果数组，也不决定输出顺序。

并发上限来自同文件的 `getMaxToolUseConcurrency`：

```ts
function getMaxToolUseConcurrency(): number {
  return (
    parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
  )
}
```

这个函数没有参数。；`parseInt(..., 10)` 按十进制解析。变量缺失、空字符串、解析成 `NaN` 或解析成 `0` 时，`|| 10` 都会回退到默认值 `10`。源码没有在这里校验正数范围，因此不能把其他整数解释为官方承诺的有效配置。

通用合并器 `all(generators, concurrencyCap = Infinity)` 位于 `restored-src/src/utils/generators.ts`。第二个参数省略时默认是 `Infinity`，但 `runToolsConcurrently` 明确传入了上面的上限，所以这条调用路径默认最多同时推进 10 个工具生成器。

## 结果按完成速度流出，上下文按原顺序合并

并发之后最麻烦的问题不是“怎么一起启动”，而是“谁先返回”。`all` 的核心是 `Promise.race`：

```ts
while (promises.size > 0) {
  const { done, value, generator, promise } = await Promise.race(promises)
  promises.delete(promise)

  if (!done) {
    promises.add(next(generator))
    if (value !== undefined) {
      yield value
    }
  } else if (waiting.length > 0) {
    const nextGen = waiting.shift()!
    promises.add(next(nextGen))
  }
}
```

`all` 位于 `restored-src/src/utils/generators.ts`，负责把多个异步生成器合并成一个异步输出流。参数 `generators` 是待合并的 `AsyncGenerator[]`；`concurrencyCap` 是同时推进的生成器上限，省略时默认 `Infinity`，本调用路径则明确传入 `getMaxToolUseConcurrency()` 的结果。

`promises` 保存正在推进的生成器，`waiting` 保存超过并发上限、尚未启动的生成器。`Promise.race` 谁先完成就先产出谁的 `value`；`value === undefined` 时不会向外 yield。一个生成器结束后，才从 `waiting` 的头部启动下一个。。

然而，工具还可能返回 `contextModifier`，例如更新共享的文件读取状态。若按完成速度立即修改上下文，慢工具和快工具会让最终状态依赖时序。`runTools` 因此先按 `toolUseID` 暂存并发批次的 modifier，等整批完成后，再按原始 `blocks` 顺序逐个应用：

```ts
for (const block of blocks) {
  const modifiers = queuedContextModifiers[block.id]
  if (!modifiers) {
    continue
  }
  for (const modifier of modifiers) {
    currentContext = modifier(currentContext)
  }
}
yield { newContext: currentContext }
```

`block.id` 是模型为每个 `tool_use` 给出的关联 ID。若某个调用没有产生 modifier，`queuedContextModifiers[block.id]` 是 `undefined`，代码直接 `continue`；它不是错误，也不需要用 `null` 占位。若同一个调用产生多个 modifier，它们保持该调用内部的产出顺序。这样，消息可以实时交错显示，共享上下文却仍以模型给出的调用顺序收敛。

串行分支不需要排队：每收到一个 `contextModifier`，`runToolsSerially` 就立刻基于当前上下文执行它，后一个工具拿到的是更新后的 `currentContext`。

## progress 为什么能从并发工具里不断冒出来

单个工具不是只返回一次最终结果。`streamedCheckPermissionsAndCallTool` 把执行过程中的 progress 和最终结果放进同一个 `Stream<MessageUpdateLazy>`。完成、失败和关闭流的部分如下：

```ts
.then(results => {
  for (const result of results) {
    stream.enqueue(result)
  }
})
.catch(error => {
  stream.error(error)
})
.finally(() => {
  stream.done()
})
```

这个函数位于 `restored-src/src/services/tools/toolExecution.ts`。`results` 是单工具执行完成后得到的更新数组；每个元素依次入队。Promise 拒绝时，异常进入 `stream.error`；无论成功或失败，`finally` 都调用 `stream.done()` 结束流。函数前半段的 progress 回调也会调用 `stream.enqueue`，并用 `toolUseID` 和 `parentToolUseID` 标记来源。

于是 UI 看见的不是“整批结束后突然出现六个结果”，而是多个生成器的进度与消息持续交错。`runTools` 不负责解释这些消息，它只负责不丢失来源、转发更新并维护上下文。

## 取消和错误不会伪装成成功

并发执行必须有明确的停止语义。`runToolUse` 在真正进入权限与调用链之前先检查共享的 abort signal：

```ts
const content = createToolResultStopMessage(toolUse.id)
content.content = withMemoryCorrectionHint(CANCEL_MESSAGE)
yield {
  message: createUserMessage({
    content: [content],
    toolUseResult: CANCEL_MESSAGE,
    sourceToolAssistantUUID: assistantMessage.uuid,
  }),
}
return
```

这段代码位于 `restored-src/src/services/tools/toolExecution.ts` 的 abort 分支。`toolUse.id` 被写回取消结果，使取消消息仍能与原 `tool_use` 配对；随后 `return` 结束该工具生成器。`abortController.signal.aborted` 只有 `true` 和 `false`，而 `signal.reason` 可以是运行时提供的任意值。

未知工具和执行异常也会被转换成 `is_error: true` 的 `tool_result`，并保留 `tool_use_id`。这非常重要：对模型而言，“工具失败”通常仍是一条可以进入下一轮推理的数据，而不是一个失去关联的 JavaScript 异常。

边界也要说清楚。上面的取消检查发生在调用前；已经运行的工具是否能立刻停止，还取决于具体工具是否继续监听同一个 `AbortSignal`。

## 最后怎样回到 queryLoop

知识图谱中的调用关系是 `queryLoop → runTools → runToolsConcurrently/runToolsSerially → runToolUse`。在 `restored-src/src/query.ts` 中，`queryLoop` 消费调度器产生的更新：

```ts
for await (const update of toolUpdates) {
  if (update.message) {
    yield update.message
    toolResults.push(
      ...normalizeMessagesForAPI(
        [update.message],
        toolUseContext.options.tools,
      ).filter(_ => _.type === 'user'),
    )
  }
  if (update.newContext) {
    updatedToolUseContext = {
      ...update.newContext,
      queryTracking,
    }
  }
}
```

`toolUpdates` 在普通路径中是 `runTools(...)` 返回的异步生成器；。`update.message` 为 `undefined` 时只更新上下文；存在消息时先向宿主 yield，再规范化并筛出 API 能接收的 user 消息，追加到 `toolResults`。`update.newContext` 存在时则覆盖最新工具上下文，并补回当前 `queryTracking`。

工具批次全部结束、没有 abort 或 hook 阻止继续后，`queryLoop` 构造下一轮状态：

```ts
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  pendingToolUseSummary: nextPendingToolUseSummary,
  maxOutputTokensOverride: undefined,
  stopHookActive,
  transition: { reason: 'next_turn' },
}
state = next
```

这里的 `messages` 把原消息、assistant 的 `tool_use` 和收集到的 `toolResults` 接在一起，随后状态机进入 `next_turn`，再次请求 Claude API。`maxOutputTokensOverride: undefined` 表示下一轮没有沿用临时的输出 token 覆盖值；`pendingToolUseSummary` 的可选值是 `Promise<ToolUseSummaryMessage | null> | undefined`：`undefined` 表示本轮没有启动摘要任务，Promise resolve 为 `null` 表示任务存在但没有可注入摘要。这些值不参与工具串并行判断。

因此，调度的完整闭环不是“执行完就结束”，而是：模型产出多个 `tool_use`，Claude Code 分批执行并收集带 ID 的结果，再把这些 `tool_result` 放回消息链，让模型决定下一步。

## 小结

多个工具调用的调度可以压缩成五条规则：

1. 先解析本次输入，再调用工具的 `isConcurrencySafe(input)`；找不到工具、解析失败或判断异常都按不安全处理。
2. 只合并相邻的安全调用，不跨越任何不安全调用重排。
3. 安全批次受并发上限约束，默认上限是 10；不安全调用各自形成串行屏障。
4. progress 和结果按完成速度流出，但并发产生的上下文修改在批次结束后按原 `tool_use` 顺序应用。
5. 错误和取消仍转换成可关联的 `tool_result`；`queryLoop` 收齐结果与新上下文后，才进入下一轮推理。

Tool orchestration 的目标不是最大化并发数，而是在不打乱副作用顺序的前提下，释放工具自己明确声明安全的并行空间。

## 留给下一篇的问题

一个工具被选中以后，它如何依次经过输入校验、权限检查、实际调用、结果转换与持久化？
