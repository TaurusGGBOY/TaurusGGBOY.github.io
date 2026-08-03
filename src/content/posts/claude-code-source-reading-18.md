---
title: "Claude Code源码解读18：生命周期机制如何横切整个运行时"
published: 2026-07-24T16:47:05+08:00
updated: 2026-07-24T16:47:05+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-18/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇最后留下的问题是：当 /compact 进行到一半时，你手动中断，然后再次执行 /compact，你觉得压缩还能继续进行吗？

先给结论：**可以再次压缩，但不能从上一次中断的位置续传。** 第二次 `/compact` 会读取当前仍然有效的消息，再从头走一遍压缩流程；上一次已经生成了一半的摘要不会被当成 checkpoint。

2.1.88 的传统路径把 `CompactionResult` 保存在 `compactConversation()` 的局部变量里。它必须先拿到完整摘要，再生成文件、计划、Skill 和 deferred tool 附件，执行 `SessionStart` / `PostCompact` hooks，最后才由 slash-command 处理器调用 `buildPostCompactMessages()`，把 boundary、summary、保留消息和附件一次性替换进会话。中途按 Esc 或 Ctrl-C 时，abort signal 会传给 PreCompact/PostCompact hooks、forked summary Agent 和流式 API；异常被 `call()` 转成 `Compaction canceled.`。因此，半截流式文本、半成品 boundary 和未完成附件都不会进入主消息数组。

这也解释了为什么重试是“重新压缩”，不是“接着压缩”：如果第一次停在传统摘要的模型请求阶段，第二次会重新执行 microcompact、重新生成摘要，重新跑后续清理。第一次调用产生的本地变量不会跨命令保留；只有 hook 已经执行过的外部副作用（例如写文件或发请求）可能留下，压缩本身不会替你回滚这些副作用。恢复方式也是先释放上下文后再次运行 `/compact`，而不是恢复某个半截摘要。

session memory 是一个容易混淆的例外。手工 `/compact` 会优先尝试 `trySessionMemoryCompaction()`：它读取当前会话的 `summary.md`，而不是调用 compact API。若另一个后台 memory extraction 正在运行，它最多等待 15 秒；等到 extraction 完成后，下一次 `/compact` 可以复用已经写完的笔记。这种“后台提前生成、触发时立即使用”的模式正是 instant compaction 的核心。

但这仍不是断点续传。`lastSummarizedMessageId` 只有 extraction 成功后才更新；如果边界不存在，源码把它当作 resumed session，重新计算近期消息保留区，并调整边界避免拆开 `tool_use` / `tool_result`。如果 memory 文件不存在、仍是模板、读取失败，或重建后的消息仍超过阈值，就返回 `null`，回退到传统 compact。若文件已经被编辑过但 extraction 尚未完整结束，源码只能看到磁盘上的当前内容，无法判断其中哪些段是“已经完成”的，因此这类内容应视为可能不完整的状态，而不是可验证的增量摘要。

所以可以把结果分成三种：**传统 compact 被中断：重跑；session memory 已完整落盘：下一次可以复用整份 memory；session memory 只写了一半：不会续写，只会把当前文件当作输入，必要时回退传统摘要。** `/compact` 的语义是“总结会话后继续”，强调的是成功后的新上下文，并不意味着中断请求拥有可恢复的中间状态。

下文引用的事实都来自 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/`；代码块只保留证明控制流所需的字段，`// ...` 表示省略埋点、UI 消息和无关分支。

一次 Hook 的主路径可以概括为五步：

1. 运行时走到 `PreToolUse`、`PostToolUse`、`PreCompact`、`Stop` 等事件点。
2. 事件调用方构造包含会话、工作目录和事件专属字段的 `HookInput`。
3. Hook 运行时合并配置，按事件字段匹配 matcher，再按可选的 `if` 条件缩小范围。
4. 命中的 command、prompt、agent、http Hook 并行执行；SDK callback 和会话 function Hook 也进入同一聚合层。
5. 调用方解释输出：PreToolUse 可以改写输入并参与 `allow / ask / deny` 决策，PostToolUse 可以补上下文，PreCompact 可以补摘要指令，Stop 可以把阻断反馈交回模型再运行一轮。

所以，Hook 既能观察，也能改变后续控制流，但能力取决于所在事件。一个 PostToolUse Hook 看见工具结果，不代表它能让已经完成的本地文件写入自动回滚；一个异步 Hook 已经让主流程继续，也不能再用普通同步返回值改写那次工具输入。

## 问题现场

同一个脚本如果只靠提示词提醒，可能被漏掉；如果挂在工具执行前，它就能在副作用发生前看到结构化输入。问题在于，工具、压缩和停止并不是同一个时刻，Hook 必须接入正确的生命周期边界。

![Hook 生命周期连接点与控制权等级](/images/posts/claude-code-source-reading-18/18-hook-control-levels-detail-handdrawn.png)

本文沿着“事件输入 → matcher → 执行器 → 控制结果”追踪 Hook。不同事件拥有不同的输出协议：有的只能观察，有的能改写输入，有的能把模型从停止状态重新唤醒。

## Hook 用生命周期协议接入运行时

调用链从事件调用方开始，而不是从 Hook 脚本开始：运行时构造 `HookInput`，`getHooksConfig()` 合并 settings 来源，matcher 过滤候选，`executeHooks()` 并行运行命中的 command、prompt、agent 或 HTTP Hook，最后由事件专属处理器解释结果。

![Claude Code Hooks 生命周期、匹配、执行与反馈路径](/images/posts/claude-code-source-reading-18/18-hooks-lifecycle-handdrawn.png)

事件位置决定控制权：`PreToolUse` 还能改写输入或阻断工具，`PostToolUse` 只能处理已经产生的结果，`PreCompact` 把成功输出变成摘要附加指令，`Stop` 则可以把阻断反馈重新排回 query loop。matcher 先匹配 `tool_name`、`manual/auto` 或 `startup/resume/clear/compact` 等事件字段；退出码和 JSON 只是传输格式，只有被事件处理器解析后才具有 allow、deny、updatedInput 或 continue 的语义。

为什么要这样设计？因为权限、工具执行、压缩和停止分散在不同模块。若每个扩展都直接修改这些模块，安全检查与状态恢复很快会失去统一边界。生命周期协议把外部逻辑放在调用前后，再由核心运行时解释结果，扩展点与主控制流仍然可以分开演进。

## 源码列出了 27 个生命周期事件

`restored-src/src/entrypoints/sdk/coreTypes.ts` 把可配置事件写成一个字符串常量数组：

```ts
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const
```

`HOOK_EVENTS` 是常量数组，用 `as const` 保留每个字符串字面量，后续 `HookEvent` 与 Zod 枚举都以这组值为边界。源码确认配置事件名只能取这 27 个枚举值。

从控制流看，可以把它们分成几类：输入边界、工具与权限边界、会话边界、压缩边界、Agent/团队任务边界，以及 MCP、配置、工作目录和文件监听边界。本文以最能说明机制的四条路径为主，不把 27 个事件逐个写成 API 清单。

还要注意版本差异。常见介绍只列 `PreToolUse`、`PostToolUse`、`Stop` 和 `PreCompact`，但 2.1.88 的静态源码已经包含 `PostCompact`、`StopFailure`、`PermissionDenied`、`FileChanged` 等事件。源码出现某个事件说明能力已被实现，是否在你项目里启用仍取决于实际配置。

## 配置先定义“事件—matcher—执行器”三层关系

持久化配置的 Schema 位于 `restored-src/src/schemas/hooks.ts`。最外层以事件为 key，中间层是 matcher，最内层才是具体 Hook：

```ts
export const HookMatcherSchema = lazySchema(() =>
  z.object({
    matcher: z.string().optional(),
    hooks: z.array(HookCommandSchema()),
  }),
)

export const HooksSchema = lazySchema(() =>
  z.partialRecord(z.enum(HOOK_EVENTS), z.array(HookMatcherSchema())),
)
```

`HookMatcherSchema` 的 `matcher` 是可选字符串；省略时，该 matcher 组不会因事件查询值而被排除。`hooks` 是必填数组，可以包含零个或多个持久化 Hook。`HooksSchema` 使用 `partialRecord`，因此 27 个事件都可省略；出现的 key 必须来自 `HOOK_EVENTS`，值则是 matcher 数组。

这里的 matcher 对不同事件有不同语义。例如 `PreToolUse` 的 matcher 会对工具名匹配，`PreCompact` 会对 `'manual' | 'auto'` 匹配。字符串既可能按工具权限规则的精确语法处理，也可能作为正则表达式处理；无效正则不会抛到主流程，而是记录调试信息并返回不匹配。

持久化 Hook 又分成四类：

```ts
return z.discriminatedUnion('type', [
  BashCommandHookSchema,
  PromptHookSchema,
  AgentHookSchema,
  HttpHookSchema,
])
```

`HookCommandSchema()` 是空参函数，返回以 `type` 为判别字段的联合类型。源码确认的可选值是：`'command'` 执行 shell 命令；`'prompt'` 让一次 LLM 调用判断；`'agent'` 启动带消息上下文的验证 Agent；`'http'` 把事件 JSON POST 到 URL。它们的核心输入分别是 `command`、`prompt`、`prompt` 和 `url`。

四类都支持可选 `timeout`、`statusMessage`、`once`，并可用 `if` 做工具权限规则式过滤。`timeout` 必须是正数，单位为秒；省略后由各执行路径使用默认值。`once` 是可选布尔值。`command` 还支持 `shell: 'bash' | 'powershell'`，省略回退为 `bash`；以及 `async`、`asyncRewake` 两个可选布尔值。`prompt/agent` 省略时分别回退到快速小模型和 Haiku 路径。

运行时还会注册 callback 与 function Hook：callback 来自 SDK 或内部注册逻辑，function Hook 按 session 存储并接收消息历史。普通 settings 只覆盖 command、prompt、agent、http 四类持久化协议。

## 输入：先给公共会话坐标，再补事件字段

所有事件先经过 `restored-src/src/utils/hooks.ts` 的 `createBaseHookInput()`：

```ts
export function createBaseHookInput(
  permissionMode?: string,
  sessionId?: string,
  agentInfo?: { agentId?: string; agentType?: string },
) {
  const resolvedSessionId = sessionId ?? getSessionId()
  const resolvedAgentType = agentInfo?.agentType ?? getMainThreadAgentType()
  return {
    session_id: resolvedSessionId,
    transcript_path: getTranscriptPathForSession(resolvedSessionId),
    cwd: getCwd(),
    permission_mode: permissionMode,
    agent_id: agentInfo?.agentId,
    agent_type: resolvedAgentType,
  }
}
```

`createBaseHookInput(permissionMode?, sessionId?, agentInfo?)` 的三个参数都可省略。省略 `sessionId` 时回退到当前主 session；省略 `agentInfo.agentType` 时回退到主线程的 `--agent` 类型；省略 `agentInfo.agentId` 时，输出对象无法提供子 Agent 身份。因此，调用方应依据 `agent_id` 是否有值区分 subagent 调用，`agent_type` 仍可能来自主线程回退。

**字段说明：** `session_id` 保存解析后的会话 ID，`transcript_path` 指向该会话的 transcript，`cwd` 是当前工作目录，`permission_mode` 透传可选权限模式；`agent_id` 标识具体子 Agent，`agent_type` 保存子 Agent 类型或主线程回退类型。局部变量 `resolvedSessionId` 与 `resolvedAgentType` 分别承接两个回退结果。

公共字段让 Hook 知道当前 session、transcript、cwd 和权限模式，但事件还要补自己的有效载荷。以 `PreToolUse` 为例：

```ts
const hookInput: PreToolUseHookInput = {
  ...createBaseHookInput(permissionMode, undefined, toolUseContext),
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: toolUseID,
}
```

这段代码位于 `executePreToolHooks()`。`permissionMode` 可为 `undefined`；第二个参数明确传 `undefined`，让 session ID 使用默认回退；`toolUseContext` 通过结构类型提供可选的 `agentId / agentType`。输出中的 `hook_event_name` 固定为 `'PreToolUse'`，`tool_name` 取开放字符串 `toolName`，`tool_input` 透传泛型 `toolInput`，`tool_use_id` 取本次调用的开放字符串 `toolUseID`。

其他事件遵循同一模式，但专属字段不同。`PostToolUse` 多一个 `tool_response`；`PostToolUseFailure` 带 `error` 和可选布尔值 `is_interrupt`；`PreCompact.trigger` 只有 `'manual' | 'auto'`，`custom_instructions` 的类型是 `string | null`：字符串会把用户要求暴露给 Hook，`null` 让 Hook 按默认压缩要求执行，并保持事件 JSON 的字段形状稳定。`Stop.stop_hook_active` 是必填布尔值，用来告诉 Hook 当前是否已经处于 Stop Hook 驱动的续跑中。

输入统一之后，command、HTTP 和 SDK callback 就能共享同一份协议，不必分别猜测当前 cwd 或自己解析 transcript 路径。

## 匹配：先合并来源，再按事件字段过滤

`getHooksConfig()` 会把多个来源组装为本次事件的候选集合：

```ts
const hooks = [...(getHooksConfigFromSnapshot()?.[hookEvent] ?? [])]
const managedOnly = shouldAllowManagedHooksOnly()

const registeredHooks = getRegisteredHooks()?.[hookEvent]
if (registeredHooks) {
  for (const matcher of registeredHooks) {
    if (managedOnly && 'pluginRoot' in matcher) continue
    hooks.push(matcher)
  }
}

if (!managedOnly && appState !== undefined) {
  // ...
}
```

`getHooksConfig(appState, sessionId, hookEvent)` 的 `appState` 可以省略；兼容旧调用时省略它会跳过 session Hook，只合并配置快照与已注册 Hook。`sessionId` 用于隔离当前会话或 Agent；`hookEvent` 必须是前面的 27 个枚举之一。配置快照缺少该事件时通过 `?? []` 从空候选集开始。随后加入已注册 callback/plugin Hook；若策略要求 managed-only，plugin Hook 会被跳过，session Hook 也全部跳过。

这条来源合并很重要。SDK callback、插件、Skill/Agent frontmatter 和普通 settings 并不天然拥有同样的信任级别。

下一步，`getMatchingHooks()` 根据输入事件选择查询值：

```ts
switch (hookInput.hook_event_name) {
  case 'PreToolUse':
  case 'PostToolUse':
  case 'PostToolUseFailure':
  case 'PermissionRequest':
  case 'PermissionDenied':
    matchQuery = hookInput.tool_name
    break
  case 'PreCompact':
  case 'PostCompact':
    matchQuery = hookInput.trigger
    break
  default:
    break
}

const filteredMatchers = matchQuery
  ? hookMatchers.filter(
      matcher => !matcher.matcher || matchesPattern(matchQuery, matcher.matcher),
    )
  : hookMatchers
```

`getMatchingHooks(appState, sessionId, hookEvent, hookInput, tools?)` 前四个参数用于取得候选并解释事件；`tools` 只参与工具型 `if` 条件的解析，省略时这类条件无法构造 permission matcher，相应 Hook 会被跳过。工具事件使用 `tool_name`，压缩事件使用 `trigger`。`Stop` 不设置 `matchQuery`，因此保留该事件下的全部 matcher；空字符串查询也走同一条不过滤路径。

匹配后还会按来源上下文去重。command 的去重身份包含 shell、command 和 `if`；prompt/agent 用 prompt 与 `if`；HTTP 用 URL 与 `if`。同一 settings 来源中冲突时，`Map` 保留后合并的条目；插件与 Skill 会用各自 root 加命名空间，避免两个扩展恰好写了相同命令就误删一个。

最后才评估 `if`。它使用类似 `Bash(git *)`、`Read(*.ts)` 的权限规则语法，并借助目标工具的 `preparePermissionMatcher()` 理解具体输入。对非工具事件，matcher 构造器返回 `undefined`，配置了 `if` 的 command/prompt/agent/http Hook 随即被跳过。

## 执行：同一事件的 Hook 并行，但结果仍由核心聚合

共享执行器 `executeHooks()` 在真正匹配前还有两个总开关：

```ts
if (shouldDisableAllHooksIncludingManaged()) return
if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) return

if (shouldSkipHookDueToTrust()) {
  logForDebugging(
    `Skipping ${hookName} hook execution - workspace trust not accepted`,
  )
  return
}
```

`executeHooks({...})` 接收对象参数。其中 `hookInput` 与 `toolUseID` 必填；省略 `matchQuery` 时不按查询值裁剪 matcher，省略 `signal` 时只受内部超时控制，`toolUseContext` 和 `messages` 则只在对应 Hook 类型需要工具状态或历史时参与执行。`timeoutMs` 缺失时默认 `10 * 60 * 1000` 毫秒。全局禁用开关或 `CLAUDE_CODE_SIMPLE` 为真会直接跳过。交互模式下若 workspace trust 尚未接受，也会跳过全部 Hook；非交互 SDK 路径把信任视作隐式成立。

这是集中执行门。SessionEnd、SubagentStop 等非工具事件也必须通过 workspace trust 检查，才能执行外部命令。

命中后，运行时为每个 Hook 创建独立异步生成器：

```ts
const hookPromises = matchingHooks.map(async function* (
  { hook, pluginRoot, pluginId, skillRoot },
  hookIndex,
) {
  const commandTimeoutMs = hook.timeout ? hook.timeout * 1000 : timeoutMs
  const { signal: abortSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: commandTimeoutMs,
  })
  // ...
})

for await (const result of all(hookPromises)) {
  // ...
}
```

`matchingHooks` 是已去重、已过滤的列表；`hookIndex` 是该列表中的位置，用于进度与部分会话初始化逻辑。每个 Hook 显式设置正数 `timeout` 时，秒数乘 1000；省略则回退到事件调用方的 `timeoutMs`。外部 `signal` 与计时器通过 `createCombinedAbortSignal()` 合并，任一取消都能结束当前 Hook。

`all(hookPromises)` 说明同一事件的 Hook 并行推进，主流程要等同步 Hook 聚合完成。每个结果仍要回到核心聚合器，转成 progress、attachment、permission、additionalContext 或 stop 标志。

多个权限结果的优先级由源码固定为 `deny > ask > allow`。`passthrough` 不设置聚合权限行为。这样，即使一个 Hook 允许、另一个 Hook 拒绝，运行时也不会因为完成顺序不同而把拒绝覆盖掉。

## 输出：退出码适合简单脚本，JSON 才能表达精细控制

command Hook 可以只靠退出码工作：

- 退出码 0 表示成功，stdout 作为成功内容记录。
- 退出码 2 产生 blocking feedback。
- 其他非零退出码是 non-blocking error，显示给用户，但不会自动等价为拒绝整个 Agent。

需要改输入、补上下文或区分权限行为时，应返回 JSON。Schema 的公共部分位于 `restored-src/src/types/hooks.ts`：

```ts
z.object({
  continue: z.boolean().optional(),
  suppressOutput: z.boolean().optional(),
  stopReason: z.string().optional(),
  decision: z.enum(['approve', 'block']).optional(),
  reason: z.string().optional(),
  systemMessage: z.string().optional(),
  hookSpecificOutput: z.union([
    PreToolUseHookSpecificOutputSchema(),
    PostToolUseHookSpecificOutputSchema(),
    // ...
  ]).optional(),
})
```

同步 JSON 的这些字段都可省略。`continue` 省略等价于不要求停止，只有严格为 `false` 才设置 `preventContinuation`；`suppressOutput` 的文档默认是 `false`；`stopReason` 只在停止时提供原因。兼容字段 `decision` 只有 `'approve' | 'block'`，分别映射到 allow 与 deny；更精确的新协议放在 `hookSpecificOutput` 中，并用 `hookEventName` 校验返回事件与当前事件一致。

`reason` 为兼容的 approve/block 决策提供解释文本，只有对应决策路径会消费；`systemMessage` 生成面向用户的系统提示，不替代权限结果或 `additionalContext`。`hookSpecificOutput` 省略时，运行时只解释这些公共字段；有值时再按当前事件的专属 Schema 解析，事件名不匹配会进入校验失败路径。

`PreToolUse` 的 event-specific 输出支持：

- `permissionDecision: 'allow' | 'deny' | 'ask'`，也可以省略，让普通权限流程继续。
- `permissionDecisionReason?: string`，给权限决策补原因。
- `updatedInput?: Record<string, unknown>`，替换后续工具输入。
- `additionalContext?: string`，作为 Hook 上下文消息加入会话。

`PostToolUse` 支持 `additionalContext` 与 `updatedMCPToolOutput`。后者类型是 `unknown`，只在目标是 MCP 工具时被工具执行层采用；普通本地工具的结果已经在 Hook 之前映射并加入消息，PostToolUse 不提供通用回滚接口。

还有一个容易混淆的边界：`permissionDecision: 'deny'` 拒绝当前工具，`continue: false` 请求事件调用方停止后续执行。两字段可以独立出现，也可以同时出现，最终语义由 PreToolUse、Stop 等调用位置分别处理。

## 同步与异步：`async` 解决等待，`asyncRewake` 解决事后叫醒

同步 Hook 会卡在生命周期边界上等待，因此才能在工具执行前改输入或做权限决策。耗时的审计、上传或通知不一定值得阻塞主流程，command Hook 因此提供两种后台模式。

配置里写 `async: true` 时，进程启动后交给后台 registry，当前 Hook 立即按成功返回。脚本也可以把 `{"async": true, ...}` 作为 stdout 第一行，运行时检测后转入后台。`asyncTimeout` 是可选数字；配置对象的 `timeout` 仍是运行时的主要超时来源。

`asyncRewake: true` 同样后台执行，但完成后若退出码为 2，会把阻断内容排入消息队列，叫醒主循环继续处理。普通 `async` 的完成结果只进入异步 Hook registry，不会重新打开已经过去的 PreToolUse 边界。

因此，选择同步还是异步会改变控制能力。需要 `allow / ask / deny`、`updatedInput` 或当场阻止的 Hook 必须同步等待；只做日志、通知、上报的 Hook 才适合异步。`asyncRewake` 适合“先让主流程走，后台发现问题后再要求 Agent 处理”的场景，但无法提供事务回滚。

## 四个关键事件，分别能改变什么

### PreToolUse：工具执行前的最后一道扩展门

`runPreToolUseHooks()` 位于 `checkPermissionsAndCallTool()` 的工具路径上。它把 Hook 结果转换为三类真正影响执行的值：`hookPermissionResult`、`hookUpdatedInput` 和 `preventContinuation`。

permission 为 allow 或 ask 时，`updatedInput` 可以随决策一起传播；deny 时输入会被丢弃。若 Hook 只返回 `updatedInput`，运行时走 `hookUpdatedInput`，改完输入后继续正常权限判断。

这解释了 Hook 与权限引擎的关系：Hook 是权限决策来源之一。最终工具是否执行，还要结合聚合后的 Hook 结果与原有 `canUseTool` 路径；Hook 聚合结果为 passthrough 时，普通权限流程继续计算 allow、ask 或 deny。

### PostToolUse：结果已经产生，适合观察和补上下文

成功工具调用完成后，执行层运行 PostToolUse。普通工具先把结果加入消息，再运行 Hook；MCP 工具则暂缓最终映射，让 `updatedMCPToolOutput` 有机会替换输出后再加入消息。

因此，`updatedMCPToolOutput` 只对 MCP 工具生效；普通 Read/Edit/Bash 保持原结果。图中的 observe/context 图标表达的正是这个源码边界。

工具抛错走的是 `PostToolUseFailure`，输入额外包含错误文本与可选的 `is_interrupt`。这为下一篇的错误分类留下了接口：Hook 能观察失败并补上下文，但错误是否重试、降级或终止，仍由工具执行和 query loop 的上层逻辑决定。

### PreCompact：成功 stdout 会变成摘要附加指令

`executePreCompactHooks()` 接收的触发类型只有 `'manual' | 'auto'`，并把 `customInstructions: string | null` 传给 Hook。执行完成后，它只选取 `succeeded === true` 且非空的输出，用两个换行连接为 `newCustomInstructions`；筛选结果为空时，后续摘要 prompt 跳过 Hook 附加指令。

上一篇看到 `compactConversation()` 会把这些内容和用户压缩指令合并。PreCompact 在摘要 Agent 开始前补充“摘要要保留什么”的指令，旧消息数组保持不变。失败输出只进入用户展示信息，不会混入摘要要求。

`PostCompact` 则拿到 `compact_summary`，适合审计或通知。它的返回结构只含可选 `userDisplayMessage`，生成后的摘要保持不变。

### Stop：阻断反馈会驱动模型继续

Stop Hook 在 Agent 准备结束时运行。输入中的 `stop_hook_active` 默认 `false`；当 Stop Hook 的阻断反馈驱动模型继续后，后续调用可以把它设为 `true`，让脚本识别自己是否处在 Hook 续跑链中。

command Hook 退出码 2 或 JSON block 会形成 blocking error。`handleStopHooks()` 把它包装成隐藏的 meta user message，内容以 `Stop hook feedback:` 开头，再交回 query loop。此时 `preventContinuation` 仍为 `false`，含义是“不要接受这次停止，请让模型根据反馈继续”。

若 JSON 明确返回 `continue: false`，则是另一条路径：运行时设置 `preventContinuation: true`，记录 `stopReason`，不再因为 blocking feedback 启动下一轮。取消信号同样会让 Stop 路径停止继续。

这两个分支看起来接近，实际方向相反：blocking feedback 让 Agent 继续修正，`continue: false` 阻止继续。写 Stop Hook 时若不区分它们，很容易得到和名字直觉相反的行为。

## 失败默认值：大多数 Hook 错误不会拖垮主任务

共享执行器把结果分为 `'success' | 'blocking' | 'non_blocking_error' | 'cancelled'`。command 的普通非零码、HTTP 非 2xx、JSON 校验失败、prompt/agent 执行异常，通常变成 non-blocking attachment；只有明确退出码 2、block/deny 或事件专属阻断字段才进入控制分支。

`getMatchingHooks()` 自身用 `try/catch` 包裹，异常时回退到空数组。`handleStopHooks()` 的外层异常也只生成用户可见、模型不可见的 warning，然后返回 `{ blockingErrors: [], preventContinuation: false }`。这体现的是 fail-open 倾向：辅助扩展出错时，默认不要让整个编码任务永久卡死。

但不能把它概括成“所有 Hook 都 fail-open”。PreToolUse 的 blocking error 会拒绝当前工具；AbortSignal 会停止 Hook 与相应工具路径；managed-only、全局禁用和 workspace trust 还会在执行前改变哪些 Hook 有资格运行。事件调用方才是最终语义的拥有者。

## 小结

Claude Code 的 Hooks 是一套以生命周期事件为入口、以结构化输入输出为契约的横切扩展机制。

它先从配置快照、注册表和 session 状态合并候选，再按工具名、压缩触发类型等事件字段匹配；命中的 command、prompt、agent、http、callback 和 function Hook 进入共享执行器并行运行。核心运行时随后聚合权限、输入改写、附加上下文、停止信号和进度消息，query loop 的控制权始终归核心运行时。

PreToolUse 能改变尚未发生的工具调用；PostToolUse 主要观察结果并补充上下文；PreCompact 影响摘要指令；Stop 的阻断反馈可以让模型继续一轮。同步 Hook 能当场参与决策，异步 Hook 则用等待能力换取主流程延迟，`asyncRewake` 再提供有限的事后唤醒。

这套设计给安全策略、自动校验、审计和外部系统留下了扩展口，同时也引入了新的失败面：脚本可能超时，HTTP 可能断开，prompt Hook 可能失败，多个结果还要合并。下一篇先不继续抽象失败分类，而是看看社区如何把这些生命周期连接点变成真正有用的工作流。

## 留给下一篇的问题

你能想到 Hook 有什么妙用？

## 参考资料

- [Claude Code 错误说明](https://code.claude.com/docs/en/errors)
- [Session memory compaction cookbook](https://platform.claude.com/cookbook/misc-session-memory-compaction)
- [Using Claude Code: session management and 1M context](https://claude.com/blog/using-claude-code-session-management-and-1m-context)
- [Claude Code Hooks 参考](https://code.claude.com/docs/en/hooks)

- [Claude Code Hooks 指南](https://code.claude.com/docs/en/hooks-guide)
