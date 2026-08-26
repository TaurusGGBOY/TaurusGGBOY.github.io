---
title: "Claude Code源码解读10：多个 tool_use 如何串并行执行"
published: 2026-07-24T09:30:00+08:00
description: "拆解 Claude Code 如何依据单次输入的并发安全性划分 tool_use 批次，并按原顺序串并行执行、回传进度和处理取消与错误。"
tags: ["claude-code", "source-code", "ai-agent", "tool-orchestration"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-10/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-04
---
## 回答上一篇的问题

上一篇留下的问题是，**你知道 Claude Code 自带哪些 tool 吗？**

工具清单不是调度器的输入原样。源码先在 `getAllBaseTools()` 建候选集，再经过 `isEnabled()`、deny 规则、运行模式、provider 能力和 feature gate，最终把本轮真正存在的工具交给模型；调度器只对这份会话快照负责。

### `getAllBaseTools()` 里的基础清单

源码把常用工具直接放进数组，把条件工具用展开表达式接入，

```ts
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    // 其余条件工具省略
  ]
}
```

因此，最稳定的核心工具可以按职责记，

| 类别 | 工具 |
| --- | --- |
| 文件与命令 | `Bash`、`Read`、`Edit`、`Write`、`NotebookEdit`、`Glob`、`Grep` |
| Agent 与计划 | `Agent`、`TaskOutput`、`EnterPlanMode`、`ExitPlanMode`、`TaskStop` |
| 网络与交互 | `WebFetch`、`WebSearch`、`AskUserQuestion` |
| 会话辅助 | `TodoWrite`、`Skill` |
| MCP 与发现 | `ListMcpResources`、`ReadMcpResource`、`ToolSearch` |

源码中的真实名称带有 `Tool` 后缀，例如 `FileReadTool` 的模型名称通常是 `Read`，所以文章里同时写源码名和用户可见名，避免把实现对象名误当成 API 工具名。

### 条件工具才是清单里最容易漏掉的部分

`getAllBaseTools()` 后面还会根据构建能力和运行时状态追加工具，

- `USER_TYPE === 'ant'` 时才追加 `ConfigTool`、`TungstenTool`，并可能追加 `REPLTool`；
- `isTodoV2Enabled()` 打开时追加 `TaskCreate`、`TaskGet`、`TaskUpdate`、`TaskList`；
- `ENABLE_LSP_TOOL` 为 truthy 时追加 `LSPTool`；工作树模式打开时追加 `EnterWorktree`、`ExitWorktree`；
- `isAgentSwarmsEnabled()` 打开时追加 `TeamCreate`、`TeamDelete`；已有能力模块还可能提供 `SendMessage`、`ListPeers`；
- `WebBrowserTool`、`WorkflowTool`、`SleepTool`、cron、`MonitorTool`、通知、PowerShell 等工具，取决于构建产物是否提供对应实现；
- `ToolSearchTool` 会先在“可能启用”的检查中进入基础池，真正是否用于本轮请求，还要看模型、工具规模和延迟发现条件。

所以“Claude Code 自带多少个 tool”要带上运行上下文回答。源码能确认装配规则和候选集合；具体某次运行的数量取决于构建 feature、环境变量、功能开关和当前连接的 MCP server。

### 从候选清单到当前会话工具池

普通模式下，`getTools(permissionContext)` 会从基础集合出发，排除特殊工具，再依次应用 deny 规则和 `isEnabled()`，

```ts
const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))
let allowedTools = filterToolsByDenyRules(tools, permissionContext)

const isEnabled = allowedTools.map(_ => _.isEnabled())
return allowedTools.filter((_, i) => isEnabled[i])
```

`permissionContext` 包含权限模式和规则。`CLAUDE_CODE_SIMPLE` 会走特殊分支，普通情况下只保留 `Bash`、`Read`、`Edit`；REPL 模式同时生效时可能只把 `REPLTool` 暴露给模型，原语工具由 REPL 内部间接使用。

因此，后面讨论的 `tool_use` 调度直接读取当前会话筛选完成的 `toolUseContext.options.tools`。同一个 `Read` 是否存在、同一个工具是否启用，都会影响模型能否调用它，以及调度器后面能否找到它。

## 介绍本章的一些概念

- **并行不是 `Promise.all`**，Claude Code 只并行"同一次模型响应里相邻出现、且对本次输入明确声明并发安全"的调用；其余调用逐个串行，且从不跨越不安全调用重排顺序。
- **并发安全由工具自己声明**，`partitionToolCalls` 先对输入做 Schema `safeParse`，再调用 `isConcurrencySafe(parsedInput)`；查找失败、解析失败或判断抛异常，一律按串行处理（三层"失败即串行"）。
- **并发有槽位上限**，`getMaxToolUseConcurrency()` 默认并发数为 **10**，可用环境变量 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 覆盖；批次之间永远按模型给出的调用顺序执行。
- **顺序一致性靠回放保证**，并发批次的 `contextModifier` 不按完成速度即时应用，而是整批结束后按原始 `tool_use` 顺序回放，消息可以实时交错，共享上下文却按模型顺序收敛。
- **新工具默认串行**，`buildTool` 为未声明该能力的工具补上 `isConcurrencySafe: () => false`，返回值经 `Boolean(...)` 归一化后只有 `true`/`false` 两种调度结果。

## 本篇新增机制

- **串并行决策流程图**，把"两个调用能不能并行"的完整判定分支画成一张图，从查找工具一路到批次合并与槽位约束。
- **并发安全声明表**，按工具列出 2.1.88 中各内置工具的并发安全声明、默认回退与证据位置。
- 全部代码块按 `[source]` / `[pseudocode]` / `[inference]` / `[runtime]` 标注证据层级（见 [00-series-guide](00-series-guide.md)）。

## 问题

金额工单的调查要求混合使用多种工具，

> 并行检查金额计算、支付回调和最近改动；通过 issue-tracker MCP 读取事故记录，必要时搜索官方文档。

模型可能在一次响应里同时给出 `Read A`、`Grep B`、`Edit C` 和 `Read D`。本章要回答，**同一次模型响应里的多个 `tool_use`，Claude Code 如何判断哪些可以并行执行、哪些必须串行？** 答案是分批执行，不是四个 Promise 一起丢进 `Promise.all`，但批次怎么切、槽位怎么限、顺序怎么保，都需要看源码。

### 面经回看｜并发优化先问“能否改变语义”

面试里问“怎么控制 Agent 并发、为什么不把工具全部并行”时，源码给出的回答是：先按原始顺序划分批次，再只并发执行声明为安全、且不会依赖前一副作用结果的调用；写入、权限询问、取消和需要前序结果的调用要保留顺序。并发槽位改善等待时间，但不等于系统获得了无限吞吐，也不自动解决共享资源冲突。

## 正文

本文全部引用 `@anthropic-ai/claude-code@2.1.88` source map 还原出的代码。代码块保留真实控制流，删去日志、埋点、遥测与无关分支；`// ...` 表示删节。`[source]` 是还原源码直接片段，`[pseudocode]` 是按源码结构简化的示意，`[inference]` 是依据调用关系推出的解释，`[runtime]` 是运行命令与实测输出。

### 工具池装配｜调度器只对会话快照负责

先交代调度器读取的工具集合从哪来。`getAllBaseTools()` 先建候选集，常用工具直接放进数组，条件工具用展开表达式接入，

```ts [source]
// restored-src/src/tools.ts（2.1.88 还原源码，条件工具展开已省略部分）
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    // 其余条件工具省略
  ]
}
```

最稳定的核心工具可以按职责记，

| 类别 | 工具 |
| --- | --- |
| 文件与命令 | `Bash`、`Read`、`Edit`、`Write`、`NotebookEdit`、`Glob`、`Grep` |
| Agent 与计划 | `Agent`、`TaskOutput`、`EnterPlanMode`、`ExitPlanMode`、`TaskStop` |
| 网络与交互 | `WebFetch`、`WebSearch`、`AskUserQuestion` |
| 会话辅助 | `TodoWrite`、`Skill` |
| MCP 与发现 | `ListMcpResources`、`ReadMcpResource`、`ToolSearch` |

源码中的真实名称带 `Tool` 后缀（如 `FileReadTool` 的模型名称是 `Read`），所以文章同时写源码名和用户可见名，避免把实现对象名误当成 API 工具名。条件工具才是清单里最容易漏掉的部分，`USER_TYPE === 'ant'` 时才追加 `ConfigTool`、`TungstenTool` 并可能追加 `REPLTool`；`isTodoV2Enabled()` 打开时追加 `TaskCreate`、`TaskGet`、`TaskUpdate`、`TaskList`；`ENABLE_LSP_TOOL` 为 truthy 时追加 `LSPTool`；工作树模式打开时追加 `EnterWorktree`、`ExitWorktree`；`isAgentSwarmsEnabled()` 打开时追加 `TeamCreate`、`TeamDelete`，已有能力模块还可能提供 `SendMessage`、`ListPeers`；`WebBrowserTool`、`WorkflowTool`、`SleepTool`、cron、`MonitorTool`、通知、PowerShell 等取决于构建产物；`ToolSearchTool` 先在"可能启用"检查中进入基础池，真正是否用于本轮请求还看模型、工具规模和延迟发现条件。

候选集不等于本轮工具池。普通模式下 `getTools(permissionContext)` 从基础集合出发，排除特殊工具，再依次应用 deny 规则和 `isEnabled()`，

```ts [source]
// restored-src/src/Tool.ts（2.1.88 还原源码）
const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))
let allowedTools = filterToolsByDenyRules(tools, permissionContext)

const isEnabled = allowedTools.map(_ => _.isEnabled())
return allowedTools.filter((_, i) => isEnabled[i])
```

`CLAUDE_CODE_SIMPLE` 走特殊分支，普通情况下只保留 `Bash`、`Read`、`Edit`；REPL 模式同时生效时可能只把 `REPLTool` 暴露给模型。因此后面讨论的 `tool_use` 调度直接读取当前会话筛选完成的 `toolUseContext.options.tools`，同一个 `Read` 是否存在，都影响调度器能否找到它。

### 三个概念｜冲突域、可交换性、稳定合并

- **冲突域**，两次调用是否可并发取决于它们访问的资源与副作用范围，而非工具名称本身。
- **可交换性**，执行顺序变化仍产生等价结果的调用具备并行基础。
- **稳定合并**，执行可以按完成速度流出，回填模型上下文时仍按原始调用顺序配对。

![工具调用如何按冲突域组成并发批次](/images/posts/claude-code-source-reading-10/10-conflict-batches-detail-handdrawn.png)

这张图要回答的是每个调用能否安全地和相邻调用共享执行窗口。批次边界由工具属性、输入和并发槽位共同决定，Promise 数量只是实现细节。

### 不要把多个 tool_use 想成 Promise.all

假设 Claude 一次返回了六个调用，

```text [pseudocode]
Read A → Grep B → Edit C → Read D → Write E → Glob F
```

如果两个读取、搜索调用都判断为并发安全，而 Edit、Write 不安全，调度结果会变成，

```text [pseudocode]
[Read A, Grep B] → [Edit C] → [Read D] → [Write E] → [Glob F]
     并行             串行        并行        串行        并行
```

注意最后三个调用不会被重新排列，Claude Code 不会为了"跑得更快"把 `Read D` 和 `Glob F` 越过 `Write E` 合并，因为后面的读取可能应该看到前面写入后的文件状态。这套机制位于 `restored-src/src/services/tools/toolOrchestration.ts`。2.1.88 的静态代码没有构建跨文件依赖图，也没有依据工具名做全局排序；它只按本次响应顺序和每个输入的安全声明切批次。

![Claude Code 多工具串并行调度流程](/images/posts/claude-code-source-reading-10/10-tool-orchestration-handdrawn.png)

### 串并行决策流程图

把上面的判定过程画成决策图（本文依据下文 `[source]` 代码块绘制，证据层级 `[inference]`），

```mermaid
flowchart TD
    A[模型返回多个 tool_use<br/>ToolUseBlock[] 按响应顺序] --> B{逐个扫描}
    B --> C{在当前工具池<br/>findToolByName 找到?}
    C -- 否 --> S[串行处理<br/>各自独立批次]
    C -- 是 --> D{inputSchema.safeParse<br/>成功?}
    D -- 否 --> S
    D -- 是 --> E{isConcurrencySafe(parsedInput)<br/>是否为 true?}
    E -- 抛异常 --> S
    E -- false --> S
    E -- true --> F{前一个批次<br/>也是并发安全?}
    F -- 是 --> G[追加进当前并行批次]
    F -- 否 --> H[新建并行批次<br/>前序成为串行屏障]
    G --> I[runToolsConcurrently<br/>槽位上限默认 10]
    H --> I
    S --> I
    I --> J[按完成速度流出 progress/结果<br/>contextModifier 按原顺序回放]
```

记住两条线，**同侧合并、异侧阻断**，只有相邻且都安全的调用合并；**先分类后执行**，`validateInput` 不参与分组，留到单次执行链。

### 第一步｜按本次输入判断并发安全性

真正的分组函数叫 `partitionToolCalls`，

```ts [source]
// restored-src/src/services/tools/toolOrchestration.ts（2.1.88 还原源码）
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

`toolUseMessages` 是模型这次响应里的 `ToolUseBlock[]`，数组顺序就是扫描顺序；`toolUseContext` 提供当前可用工具集合（实际读取 `toolUseContext.options.tools`）；返回值 `Batch[]` 中每个批次有布尔值 `isConcurrencySafe` 和调用数组 `blocks`，`true` 批次可含多个连续调用，`false` 批次在这段实现中只含一个调用。

这里有三层"失败即串行"，`findToolByName` 查找失败时，可选链跳过解析并落到 `false`；`safeParse` 失败同样返回 `false`；输入合法但 `isConcurrencySafe` 抛出异常时，`catch` 仍返回 `false`。无效输入不会因为"看起来像读取命令"而提前并发执行。

### 调度阶段的 safeParse 不等于执行阶段的 validateInput

`inputSchema.safeParse` 先执行工具声明的静态 Schema 约束，必填字段、类型、对象结构，也包括 Schema 声明的长度、数值范围、正则或 refine。可选的 `validateInput` 是第二道工具自定义语义校验，回答"这组已经解析成功的值，在当前运行上下文里能不能继续"，它可以检查跨字段关系、路径规则、运行时状态。例如 `FileReadTool.validateInput` 会检查 PDF 页码范围、路径 deny 规则、不能读取的二进制扩展名和特殊设备路径。`restored-src/src/Tool.ts` 把它定义成可选异步方法，

```ts [source]
// restored-src/src/Tool.ts（2.1.88 还原源码，合并展示 ValidationResult 与 Tool 相关片段）
export type ValidationResult =
  | { result: true }
  | {
      result: false
      message: string
      errorCode: number
    }

// Tool<Input, Output> 契约中的可选方法
validateInput?(
  input: z.infer<Input>,
  context: ToolUseContext,
): Promise<ValidationResult>
```

第一个参数 `input` 已通过该工具的 Schema，类型由 `Input` 推导；第二个参数 `context` 是当前 `ToolUseContext`，因此校验可读取运行时状态。返回值只有两个分支，成功必须是 `{ result: true }`；失败必须同时给出 `message: string` 和 `errorCode: number`。通用接口没有规定错误码枚举，具体数字及含义由各工具实现，静态源码无法统一穷举。

可选的是方法本身，而不是失败字段。工具没有实现 `validateInput` 时，执行器的可选链得到 `undefined` 并继续向下，不会凭空补出 `{ result: true }`；实现了该方法时，只有显式返回 `result === false` 才会拦住调用，`message` 进入调试日志、分析事件和带原 `tool_use_id` 的 `is_error: true` 工具结果；`errorCode` 只作为 `tengu_tool_use_error` 分析事件字段记录。随后不会再运行 PreToolUse、权限判断或 `tool.call`。两条顺序应该分开记，

```text [pseudocode]
调度分组：safeParse → isConcurrencySafe
单次执行：重新 safeParse → validateInput（若有）→ PreToolUse → 权限决策 → tool.call
```

`partitionToolCalls` 不会调用 `validateInput`。一次调用可以先被归入并发安全批次，随后在执行链里因值级或上下文校验失败；批次标签只说明"可以和谁共享调度窗口"，不代表已越过校验或真正产生副作用。

### isReadOnly 与 isConcurrencySafe 分别描述副作用和调度

"只读"通常意味着"适合并发"，但源码把它们保留成两个能力。以 Bash 工具为例，

```ts [source]
// restored-src/src/tools/BashTool/BashTool.tsx（2.1.88 还原源码）
isConcurrencySafe(input) {
  return this.isReadOnly?.(input) ?? false;
},
isReadOnly(input) {
  const compoundCommandHasCd = commandHasAnyCd(input.command);
  const result = checkReadOnlyConstraints(input, compoundCommandHasCd);
  return result.behavior === 'allow';
},
```

`isConcurrencySafe(input)` 接收已按 Schema 解析的本次 Bash 输入，并复用 `isReadOnly(input)` 的判断；如果 `isReadOnly` 是 `undefined`，`??` 回退到 `false`。`isReadOnly` 检查具体的 `input.command`，所以同一个 Bash 工具可能因命令不同得到不同分类。相比之下，`FileReadTool` 的两个函数都固定返回 `true`（`restored-src/src/tools/FileReadTool/FileReadTool.ts:373`），但这不代表调度器直接读取 `isReadOnly`，`partitionToolCalls` 调用的仍然是 `isConcurrencySafe`。

还有一个容易忽略的默认值。`restored-src/src/Tool.ts` 的 `buildTool` 会为省略该能力声明的工具补上 `isConcurrencySafe: () => false`（`Tool.ts:759`，注释写着 "assume not safe"）。新工具因此默认串行；返回值经过 `Boolean(...)` 归一化后，只产生 `true` 和 `false` 两种调度结果。

### 第二步｜相邻安全调用组成批次

`partitionToolCalls` 同时约束类别与相邻关系。当当前调用安全、且最后一个批次也安全时，它被追加到最后一个批次；除此之外都新建批次。于是不安全调用天然成为屏障，它前后的两个安全区间不会跨屏障合并。调度器不构建跨工具文件依赖图；具体工具根据解析后的输入声明并发安全性，编排层执行统一分组规则。

### 第三步｜批次并行，批次之间串行

分组完成后，`runTools` 顺序遍历每个批次，

```ts [source]
// restored-src/src/services/tools/toolOrchestration.ts（2.1.88 还原源码，完整 runTools）
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

参数语义，`toolUseMessages` 是待调度的所有调用；`assistantMessages` 用来按 `tool_use.id` 找到产生该调用的 assistant 消息，后续错误和结果才能保留关联；`canUseTool` 是权限决策函数，不负责并发分类，而是在单工具执行链中决定允许、询问或拒绝；`toolUseContext` 包含工具列表、应用状态、文件状态与 `abortController` 等运行上下文。生成器产出 `MessageUpdate`，`message` 可选、可以为 `undefined`；`newContext` 必填，每次更新都携带当时上下文。`queryLoop` 仍对 `update.newContext` 做存在性检查，因为 `toolUpdates` 还可能来自另一种执行器。

外层是普通 `for...of`，当前批次的异步生成器结束以后，才进入下一个批次。所谓"串行执行不安全工具"，在当前分组规则下实际表现为，每个不安全批次只有一个 `blocks` 元素，必须等它结束，后面的批次才能启动。

### 并发批次还受槽位上限约束

安全批次交给 `runToolsConcurrently`。它把每个调用包装成异步生成器，再交给通用的 `all` 合并，

```ts [source]
// restored-src/src/services/tools/toolOrchestration.ts（2.1.88 还原源码）
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

`toolUseMessages` 在这里已经是当前安全批次。每个调用开始前把自己的字符串 `toolUse.id` 加入 `inProgressToolUseIDs`，`runToolUse` 结束后再删除，这个集合只表达哪些调用仍在运行；结果数组与输出顺序由其他结构维护。并发上限来自同文件的 `getMaxToolUseConcurrency`，

```ts [source]
// restored-src/src/services/tools/toolOrchestration.ts（2.1.88 还原源码）
function getMaxToolUseConcurrency(): number {
  return (
    parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
  )
}
```

这个零参数函数用 `parseInt(..., 10)` 按十进制解析环境变量。变量缺失、空字符串、解析成 `NaN` 或 `0` 时，`|| 10` 回退到默认并发数 `10`；源码未额外校验正数范围，其他整数只代表这份静态实现会接受的运行时输入。

通用合并器 `all(generators, concurrencyCap = Infinity)` 位于 `restored-src/src/utils/generators.ts:32`。第二个参数省略时默认 `Infinity`，但 `runToolsConcurrently` 明确传入上面的上限，所以这条调用路径默认最多同时推进 10 个工具生成器。

### 并发安全声明表｜谁说自己可以并行

把上面出现的声明集中成表（`[source]` 位置已列出），

| 工具 | `isConcurrencySafe` | 依据 | 说明 |
| --- | --- | --- | --- |
| `Bash` | 按命令判断 | 复用 `isReadOnly(input)`（`BashTool.tsx`） | 同一工具因命令不同分类不同；复合命令含 `cd` 时走 `commandHasAnyCd` 分支 |
| `Read`（FileReadTool） | `true` | 固定返回（`FileReadTool.ts:373`） | 读取不修改共享状态 |
| `WebSearch` | `true` | 固定返回（`WebSearchTool.ts:200`） | 网络检索视为只读；见下篇边界 |
| 未声明能力的新工具 | `false` | `buildTool` 补丁 `() => false`（`Tool.ts:759`） | 默认串行，声明安全才放开 |
| 找不到工具 / 解析失败 / 判断抛异常 | `false` | `partitionToolCalls` 三层失败即串行 | 保守分类，校验留给执行阶段 |

这张表回答"能不能并发"；真正"是否并发执行"还要叠加相邻关系与槽位上限。

### 结果按完成速度流出，上下文按原顺序合并

并发调用通过 `Promise.race` 持续取得最先返回的更新，

```ts [source]
// restored-src/src/utils/generators.ts（2.1.88 还原源码，all 主循环）
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

`all` 把多个 `AsyncGenerator` 合并成一个异步输出流；`concurrencyCap` 是同时推进的生成器上限。`promises` 保存正在推进的生成器，`waiting` 保存超过并发上限、尚未启动的生成器；`Promise.race` 谁先完成就先产出谁的 `value`，`value === undefined` 时不向外 yield，一个生成器结束后才从 `waiting` 头部启动下一个。

然而，工具还可能返回 `contextModifier`，例如更新共享的文件读取状态。若按完成速度立即修改上下文，慢工具和快工具会让最终状态依赖时序。`runTools` 因此先按 `toolUseID` 暂存并发批次的 modifier，等整批完成后，再按原始 `blocks` 顺序逐个应用，

```ts [source]
// restored-src/src/services/tools/toolOrchestration.ts（runTools 并行分支尾部）
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

`block.id` 是模型为每个 `tool_use` 给出的关联 ID。若某个调用未产生 modifier，`queuedContextModifiers[block.id]` 为 `undefined`，直接 `continue`；若同一个调用产生多个 modifier，它们保持该调用内部的产出顺序。消息可以实时交错显示，共享上下文却仍以模型给出的调用顺序收敛。串行分支不需要排队，每收到一个 `contextModifier`，`runToolsSerially` 立刻基于当前上下文执行它，后一个工具拿到的是更新后的 `currentContext`。

### progress 为什么能从并发工具里不断冒出来

单个工具通过同一个 `Stream<MessageUpdateLazy>` 先后产出 progress 与最终结果。`streamedCheckPermissionsAndCallTool`（`restored-src/src/services/tools/toolExecution.ts:492`）中完成、失败和关闭流的部分如下，

```ts [source]
// restored-src/src/services/tools/toolExecution.ts（2.1.88 还原源码）
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

`results` 是单工具执行完成后得到的更新数组，每个元素依次入队；Promise 拒绝时异常进入 `stream.error`；无论成功或失败，`finally` 都调用 `stream.done()` 结束流。函数前半段的 progress 回调也会调用 `stream.enqueue`，并用 `toolUseID` 和 `parentToolUseID` 标记来源。于是 UI 会持续看到多个生成器交错产生的进度与消息。

### 取消和错误不会伪装成成功

并发执行必须有明确的停止语义。`runToolUse` 在真正进入权限与调用链之前先检查共享的 abort signal，

```ts [source]
// restored-src/src/services/tools/toolExecution.ts（runToolUse abort 分支）
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

局部 `content` 由 `createToolResultStopMessage(toolUse.id)` 创建，内部 `tool_use_id` 与原调用配对；随后把 `content.content` 改为带 memory correction hint 的取消文本。yield 对象的 `message` 是 user message，`content: [content]` 作为模型回执，`toolUseResult` 为宿主保留 `CANCEL_MESSAGE`，`sourceToolAssistantUUID` 指向发起调用的 assistant 节点；`return` 随即结束该工具生成器。`signal.aborted` 是布尔值，`signal.reason` 可以是运行时任意值。

未知工具和执行异常也会被转换成 `is_error: true` 的 `tool_result`，并保留 `tool_use_id`。对模型而言，工具失败由此成为一条可进入下一轮推理且保留调用关联的数据。边界也要说清楚，取消检查发生在调用前；已经运行的工具是否能立刻停止，还取决于具体工具是否继续监听同一个 `AbortSignal`。

### 最后怎样回到 queryLoop

知识图谱中的调用关系是 `queryLoop → runTools → runToolsConcurrently/runToolsSerially → runToolUse`。在 `restored-src/src/query.ts` 中，`queryLoop` 消费调度器产生的更新，

```ts [source]
// restored-src/src/query.ts（2.1.88 还原源码）
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

`toolUpdates` 在普通路径中是 `runTools(...)` 返回的异步生成器。`update.message` 省略时只更新上下文；存在消息时先向宿主 yield，再规范化并筛出 API 能接收的 user 消息，追加到 `toolResults`。`update.newContext` 存在时则覆盖最新工具上下文，并补回当前 `queryTracking`。工具批次全部结束且 abort、hook 均允许继续时，`queryLoop` 构造下一轮状态，

```ts [source]
// restored-src/src/query.ts（2.1.88 还原源码，next State 构造）
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

`messages` 依次拼接查询前历史、assistant 的 `tool_use` 和 `toolResults`；`toolUseContext` 使用带 query tracking 的上下文；`autoCompactTracking` 保存本轮压缩跟踪；`turnCount` 切到下一轮；`maxOutputTokensRecoveryCount: 0` 与 `hasAttemptedReactiveCompact: false` 重置两类恢复状态；`pendingToolUseSummary` 保存可选摘要 Promise；`maxOutputTokensOverride` 清除临时输出上限；`stopHookActive` 延续 Hook 状态；`transition.reason: 'next_turn'` 标记回环原因。随后 `state = next`，再次请求 Claude API。调度的完整闭环是，模型产出多个 `tool_use`，Claude Code 分批执行并收集带 ID 的结果，再把这些 `tool_result` 放回消息链，让模型决定下一步。

### 小结

多个工具调用的调度可以压缩成五条规则，

1. 调度阶段先解析本次输入，再调用工具的 `isConcurrencySafe(input)`；找不到工具、解析失败或判断异常都按不安全处理，`validateInput` 留到单次执行阶段。
2. 只合并相邻的安全调用，不跨越任何不安全调用重排。
3. 安全批次受并发上限约束，默认上限是 10；不安全调用各自形成串行屏障。
4. progress 和结果按完成速度流出，但并发产生的上下文修改在批次结束后按原 `tool_use` 顺序应用。
5. 错误和取消仍转换成可关联的 `tool_result`；`queryLoop` 收齐结果与新上下文后，才进入下一轮推理。

Tool orchestration 在保持副作用顺序的前提下，释放工具明确声明安全的并行空间。

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。行号以当前仓库为准。

| 机制 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| 候选清单 | `getAllBaseTools()` | `src/tools.ts` | 已确认 |
| 工具池筛选 | `getTools()` / `filterToolsByDenyRules()` / `isEnabled()` | `src/Tool.ts` | 已确认 |
| 并发分组 | `partitionToolCalls()` | `src/services/tools/toolOrchestration.ts:91` | 已确认 |
| 批次调度 | `runTools()` | `src/services/tools/toolOrchestration.ts:18` | 已确认 |
| 串行执行 | `runToolsSerially()` | `src/services/tools/toolOrchestration.ts:118` | 已确认 |
| 并行执行 | `runToolsConcurrently()` / `markToolUseAsComplete()` | `src/services/tools/toolOrchestration.ts:152,179` | 已确认 |
| 并发上限 | `getMaxToolUseConcurrency()` | `src/services/tools/toolOrchestration.ts:8` | 已确认（默认 10） |
| 生成器合并 | `all()` | `src/utils/generators.ts:32` | 已确认 |
| 工具契约 | `validateInput` / `ValidationResult` / `buildTool` 默认 `isConcurrencySafe` | `src/Tool.ts:759` | 已确认 |
| Bash 声明 | `isConcurrencySafe` / `isReadOnly` | `src/tools/BashTool/BashTool.tsx` | 已确认 |
| Read 声明 | `isConcurrencySafe` / `isReadOnly` | `src/tools/FileReadTool/FileReadTool.ts:373` | 已确认 |
| 单工具执行 | `streamedCheckPermissionsAndCallTool()` | `src/services/tools/toolExecution.ts:492` | 已确认 |
| 取消分支 | `runToolUse()` abort | `src/services/tools/toolExecution.ts:337` | 已确认 |
| 结果回环 | `queryLoop()` 消费与 `next` State | `src/query.ts` | 已确认 |

## 设计决策

源码里找不到官方选型记录，以下判断来自代码结构与注释，属于解释而非官方声明。

**第一，为什么按相邻合并，而不是全局排序或构建依赖图？** 2.1.88 的静态代码没有跨文件依赖图。相邻合并是成本最低且语义最安全的方案，模型给出的顺序本身就是"预期观察顺序"，后面的读取大概率想看到前面写入的状态。跨屏障重排（把 `Read D` 挪到 `Write E` 之前）会破坏这个假设，因此被明确禁止。代价是并行的收益被限制在连续的安全区间内，这正是"安全优先于速度"的取舍。

**第二，为什么并发安全由工具自己声明？** 副作用语义只有工具自己知道。统一编排层无法从参数推断 `Read` 与 `Bash git status` 的区别，更无法判断一条 shell 命令是否只读；把声明权交给工具（`isConcurrencySafe(input)` 可以按本次输入分支），编排层只执行统一分组规则，职责边界最清晰。

**第三，为什么默认串行？** `buildTool` 为未声明的工具补 `isConcurrencySafe: () => false`，注释 "assume not safe" 直接写明意图，新工具先按保守处理，作者显式声明安全才放开并发，防止未经审视的并发引入竞态。`FileRead`、`WebSearch` 这类固定 `true` 是明确声明过的例外，而不是默认值。

**第四，为什么 contextModifier 回放而不是即时应用？** 若按完成速度立即修改共享上下文，慢工具与快工具会让最终状态依赖调度时序，同样的输入在不同运行时可能收敛到不同状态。先暂存、整批结束后按原始 `tool_use` 顺序回放，保证结果等价于"串行执行"的收敛路径，消息层可以实时交错，状态层保持确定性。

## 练习｜观察一次多工具响应怎样分批

**练习 1（约 10 分钟），默认配置下观察并发批次。** 用 `claude --debug` 启动，在一个目录里执行一条需要同时读取多个文件的任务（例如"读取项目里的三个源文件，说明各自职责"）。打开 `--debug` 日志，找到工具执行事件。期望输出，日志中相邻的 `Read` 调用出现在同一执行窗口内（`inProgressToolUseIDs` 同时包含多个 ID），进度消息交错出现；随后模型拿到的是按原始顺序回填的结果。

**练习 2（约 10 分钟），把并发上限压到 1 再对比。** 运行 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=1 claude --debug`，重跑练习 1 的同一任务。期望输出，工具严格逐个执行，`inProgressToolUseIDs` 任意时刻最多一个元素，进度不再交错；最终结果顺序不变。对比两次日志，确认"结果顺序由模型调用顺序决定，与并发配置无关"。

**练习 3（约 10 分钟），用混合批次验证串行屏障。** 提示词明确要求"先读取 A，再修改 B，再搜索 C"（模型通常会连续给出 Read、Edit、Grep）。期望输出，日志中 `Read A` 与 `Grep C` 分属两个批次，`Edit B` 是中间的独立串行批次，即使 Read 与 Grep 都声明并发安全，也不会跨过 Edit 合并。

## 自测

1. `partitionToolCalls` 判断并发安全时，"失败即串行"的三个位置分别是什么？
2. 为什么并发批次的 `contextModifier` 要等整批结束后再按原始顺序回放？
3. `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 的默认值与回退规则是什么？

<details>
<summary>参考答案</summary>

1. `findToolByName` 查找失败（可选链跳过解析落到 `false`）；`inputSchema.safeParse` 失败；输入合法但 `isConcurrencySafe` 抛出异常（`catch` 返回 `false`）。三层都让本次调用按不安全处理，校验细节留到单次执行阶段。

2. 因为若按完成速度立即修改共享上下文，慢工具和快工具会让最终状态依赖调度时序。`runTools` 先按 `toolUseID` 暂存 modifier，等整批 `blocks` 结束后再按模型给出的原始顺序逐个应用（`toolOrchestration.ts` 并行分支尾部），保证收敛状态与"串行执行"等价；同一调用产生多个 modifier 时保持内部产出顺序。

3. `getMaxToolUseConcurrency()` 用 `parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10` 解析，变量缺失、空字符串、解析成 `NaN` 或 `0` 时都回退到默认值 `10`；源码未额外校验正数范围。`all()` 的第二参数省略时默认 `Infinity`，但 `runToolsConcurrently` 明确传入该上限。

</details>

## 回顾｜上一篇的问题

<details>
<summary>展开查看回顾</summary>

上一篇问，**你知道 Claude Code 自带哪些 tool 吗？** 结论是，工具清单不是调度器的输入原样。源码先在 `getAllBaseTools()`（`restored-src/src/tools.ts`）建候选集，常用工具直接进数组（`AgentTool`、`BashTool`、`FileRead/FileEdit/FileWriteTool`、`WebFetchTool`、`WebSearchTool`、`TodoWriteTool`、`SkillTool` 等），条件工具用展开表达式接入，`USER_TYPE === 'ant'` 时追加 `ConfigTool`、`TungstenTool`、`REPLTool`；`isTodoV2Enabled()` 追加 Task 系列；`ENABLE_LSP_TOOL` 追加 `LSPTool`；工作树模式追加 `Enter/ExitWorktree`；Agent Swarms 追加 Team 系列；`WebBrowserTool`、`WorkflowTool`、`SleepTool`、cron、`MonitorTool` 等取决于构建产物。候选集不等于本轮工具池，普通模式下 `getTools(permissionContext)` 先排除特殊工具，再经 `filterToolsByDenyRules` 应用 deny 规则，最后按 `isEnabled()` 逐个过滤；`CLAUDE_CODE_SIMPLE` 分支只保留 `Bash`、`Read`、`Edit`。调度器读的是这份会话快照（`toolUseContext.options.tools`），同一个 `Read` 是否存在直接决定模型能否调用它。所以"自带多少个 tool"要带运行上下文回答，源码能确认装配规则与候选集合，具体数量取决于构建 feature、环境变量、功能开关和 MCP server。

</details>

## 留给下一篇的问题

`WebSearch` 是 Claude Code 的内置网络检索工具。它接收查询词，还可以用 `allowed_domains` 或 `blocked_domains` 限定结果来源；真正执行时，会再发起一轮带服务端 `web_search` 工具的模型请求。

**你认为 `WebSearch` 在任何情况下都可以并发执行吗？**
