---
title: "Claude Code源码解读34：无头 SDK 与结构化输入输出如何工作"
published: 2026-07-24T16:47:21+08:00
updated: 2026-07-24T16:47:21+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-34/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：**交互式 REPL 之外，Claude Code 如何在 `-p`、SDK 与结构化输入输出模式下运行同一套 Agent 循环，并处理不可交互的权限请求？**

答案先说：`-p`、Agent SDK 和远程结构化入口没有各自实现一套 Agent。它们先绕过 Ink/React REPL，创建一个无头 `AppState` store，再进入 `runHeadless()`；`runHeadless()` 用 `StructuredIO` 把命令行字符串或 NDJSON 输入归一化成 SDK message，`runHeadlessStreaming()` 最终仍然调用前文一直追踪的 `ask()`。模型流、`tool_use`、权限检查、工具执行、`tool_result` 和继续推理，都没有因为没有终端界面而消失。

真正变化的是 Agent 循环两端的“宿主协议”。普通 `claude -p` 可以只给一段 prompt，最后拿文本或单个 JSON；SDK 使用 `stream-json` 发送、接收一行一个 JSON 的事件，还能通过 `control_request` / `control_response` 处理权限、取消和运行时控制。没有 SDK 或 MCP 权限宿主时，权限规则若得出 `ask`，Claude Code 不会偷偷等待一个不存在的确认框：这次工具调用按未允许处理，并以错误 `tool_result` 回到循环。已有 allow 规则仍可直接执行，deny 规则仍会拒绝。

这也回答了系列前面关于 `claude -p` 的问题：`-p` 和不带 `-p` 的核心能力差别，不是“会不会调用工具”，而是“谁承载交互”。不带 `-p` 时，React REPL 可以展示权限弹窗并等待键盘；带 `-p` 时没有这个 UI，所有需要人决定的地方都必须提前变成规则，或委托给 SDK/MCP 宿主。

本篇仍以 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码为边界。下文代码行均从 `restored-src/` 摘取；为了突出执行主线，无关字段和分支会被裁掉，代码块中的中文“省略”注释是本文标记，不属于原始源码。SDK 的公开类型和 Claude Code 这一侧的协议可以由仓库确认，外部 SDK 包内部怎样拉起或管理进程，不在这份 source map 的证据范围内。

## 先补三个概念：Headless、SDK 与 Structured IO

### Headless 只是没有交互界面

Headless，直译是“无头”。这里的“头”是终端 UI，不是 Agent 的脑子。

交互式 Claude Code 有 Ink renderer、消息列表、输入框、权限弹窗和快捷键。无头模式不挂这棵 React 树，但它仍然需要会话状态、工具注册表、权限上下文、消息历史、MCP 连接和查询循环。因此，无头模式不是“把 prompt 发给模型然后打印字符串”，而是把 UI 宿主替换成输入输出协议。

### SDK 是宿主 API，不是另一种模型调用

SDK 让业务代码用类型化 API 提交消息、异步遍历事件，并在需要时回传权限决定或控制指令。它适合把 Claude Code 嵌进 IDE、CI 服务、桌面应用或自己的编排器。

`restored-src/src/entrypoints/agentSdkTypes.ts` 暴露的入口把 prompt 定义为字符串或异步消息流：

```ts
export function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: InternalOptions
}): InternalQuery
export function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query
```

`query()` 是 SDK 的类型入口。`prompt` 为 `string` 时适合一次性输入，为 `AsyncIterable<SDKUserMessage>` 时可以持续送入多轮 user message；`options` 可省略，公开 `Options` 与内部 `InternalOptions` 对应两个重载，静态类型并没有把所有运行时选项压成任意对象。返回的 `Query` / `InternalQuery` 是 SDK 侧的可消费查询对象，而不是一段最终文本。

### Structured IO 是事件协议

结构化输入输出的重点不是“结果能被 `JSON.parse()`”，而是每一条消息都有可判别的 `type`，请求与响应还有 `request_id`。文本、模型增量、工具进度、权限请求、终态和错误不再挤在同一条日志里。

`restored-src/src/entrypoints/sdk/coreSchemas.ts` 与 `controlSchemas.ts` 把 stdin、stdout 边界写得很明确：stdin 可以接收 user message、control request、control response、keep-alive 和环境变量更新；stdout 还会发送 assistant、system、result、stream event，以及控制请求与取消事件。也就是说，`stream-json` 是双向协议，不是“把最终答案逐块打印”这么简单。

## 入口先决定是否挂载 REPL

主入口很早就判断当前是不是非交互会话：

```ts
const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print')
const hasInitOnlyFlag = cliArgs.includes('--init-only')
const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'))
const isNonInteractive =
  hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY

setIsInteractive(!isNonInteractive)
initializeEntrypoint(isNonInteractive)
```

这段位于 `restored-src/src/main.tsx`。`hasPrintFlag` 同时识别短参数 `-p` 和长参数 `--print`；`hasInitOnlyFlag` 表示只执行初始化；`hasSdkUrl` 只要出现 `--sdk-url...` 就成立；stdout 不是 TTY 也会进入非交互状态。`setIsInteractive()` 接收布尔值，`false` 会让后续代码避开交互宿主；`initializeEntrypoint()` 记录的是入口形态，不负责执行 Agent。

进入无头分支后，主入口仍然创建完整状态，再加载 `runHeadless()`：

```ts
if (isNonInteractiveSession) {
  const headlessStore = createStore(headlessInitialState, onChangeAppState)
  const { runHeadless } = await import('src/cli/print.js')

  void runHeadless(
    inputPrompt,
    () => headlessStore.getState(),
    headlessStore.setState,
    commandsHeadless,
    tools,
    sdkMcpConfigs,
    agentDefinitions.activeAgents,
    {
      outputFormat,
      permissionPromptToolName: options.permissionPromptTool,
      maxTurns: options.maxTurns,
      // 省略其余 options 字段
    },
  )
  return
}
```

`runHeadless()` 的第一个参数 `inputPrompt` 是字符串或 `AsyncIterable<string>`；`getState` / `setState` 让查询循环继续读写 `AppState`；`commandsHeadless` 只保留允许非交互执行的命令；`tools` 与 `sdkMcpConfigs` 提供本地工具和 SDK MCP；`agents` 是本次可用 Agent；最后的 `options` 承载输出格式、权限宿主、预算、模型和 session 等设置。这里没有 Ink root，却并不缺状态容器。

为什么要保留 store？因为一次 `-p` 调用也可能连接 MCP、切换权限模式、运行后台任务、恢复历史或更新文件读取缓存。把这些状态塞回全局变量，反而会让交互和无头两条路径逐渐分叉。

## 输入先被统一成 SDK user message

`-p` 的默认输入格式是 `text`。prompt 参数和管道 stdin 会被合并；如果输入格式是 `stream-json`，stdin 则直接作为异步字节流交给后面解析：

```ts
async function getInputPrompt(
  prompt: string,
  inputFormat: 'text' | 'stream-json',
): Promise<string | AsyncIterable<string>> {
  if (!process.stdin.isTTY && !process.argv.includes('mcp')) {
    if (inputFormat === 'stream-json') return process.stdin
    process.stdin.setEncoding('utf8')
    let data = ''
    const onData = (chunk: string) => {
      data += chunk
    }
    process.stdin.on('data', onData)
    const timedOut = await peekForStdinData(process.stdin, 3000)
    process.stdin.off('data', onData)
    if (timedOut) {
      process.stderr.write(
        'Warning: no stdin data received in 3s, proceeding without it. ' +
          'If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n',
      )
    }
    return [prompt, data].filter(Boolean).join('\n')
  }
  return prompt
}
```

`getInputPrompt()` 的 `prompt` 是位置参数中的开放字符串；`inputFormat` 只有 `'text'` 与 `'stream-json'` 两个可选值。`text` 会等待并拼接普通 stdin，`stream-json` 不预先读完，而是返回 `process.stdin` 这个异步流。函数返回联合类型，正好把“一次性文本”和“持续协议输入”收敛到同一入口。

`restored-src/src/cli/print.ts` 中的 `runHeadless()` 随后调用 `getStructuredIO()`。即使拿到的是普通字符串，也会先包装成一条 `SDKUserMessage`：

```ts
function getStructuredIO(
  inputPrompt: string | AsyncIterable<string>,
  options: { sdkUrl: string | undefined; replayUserMessages?: boolean },
): StructuredIO {
  let inputStream: AsyncIterable<string>
  if (typeof inputPrompt === 'string') {
    if (inputPrompt.trim() !== '') {
      inputStream = fromArray([
        jsonStringify({
          type: 'user',
          session_id: '',
          message: { role: 'user', content: inputPrompt },
          parent_tool_use_id: null,
        }),
      ])
    } else {
      inputStream = fromArray([])
    }
  } else {
    inputStream = inputPrompt
  }

  return options.sdkUrl
    ? new RemoteIO(options.sdkUrl, inputStream, options.replayUserMessages)
    : new StructuredIO(inputStream, options.replayUserMessages)
}
```

`getStructuredIO()` 的 `inputPrompt` 接受字符串或字符串异步流；`sdkUrl` 为 `undefined` 时使用本地 `StructuredIO`，为 URL 字符串时使用继承自它的 `RemoteIO`；`replayUserMessages` 是可选布尔值，真值会把收到的用户/控制消息重新发到输出端作为确认，省略或 `false` 则不回放。空字符串在完整源码中会变成空流，而不是一条空 user message。

这一步很关键：后面的循环不需要关心输入来自命令行参数、管道、SDK stdin 还是远端 transport。它只消费统一的 message。

![Claude Code 无头模式、结构化 IO 与权限宿主手绘图](/images/posts/claude-code-source-reading-34/34-headless-sdk-structured-io-handdrawn.png)

## 中间仍是同一个 `ask()`

`restored-src/src/cli/print.ts` 中的 `runHeadless()` 负责初始化和最终输出，持续运行的部分在 `runHeadlessStreaming()`。它从结构化输入中取出 command，然后把参数传给 `ask()`：

```ts
for await (const message of ask({
  commands: uniqBy(
    [...currentCommands, ...appState.mcp.commands],
    'name',
  ),
  prompt: input,
  cwd: cwd(),
  tools: allTools,
  canUseTool,
  maxTurns: options.maxTurns,
  maxBudgetUsd: options.maxBudgetUsd,
  mutableMessages,
  getAppState,
  setAppState,
  abortController,
  includePartialMessages: options.includePartialMessages,
})) {
  output.enqueue(message)
}
```

`ask()` 的 `prompt` 是本轮字符串或内容块；`commands`、`tools` 是当时已装配的命令与工具；`canUseTool` 是本篇后半的权限宿主适配器；`maxTurns`、`maxBudgetUsd` 均可为 `undefined`，表示没有由对应 CLI 参数设置这一项限制；`mutableMessages` 是跨轮次复用的历史数组；`abortController` 承载中断；`includePartialMessages` 为真时才把模型原始增量映射进 SDK 输出，省略或假值时仍会得到完整消息与终态。

因此，SDK 并不是绕开 Claude Code 自己去调用 Messages API。至少从 Claude Code 这一侧可以确认：结构化入口进入的仍是 `ask()`，而 `ask()` 继续进入前文分析过的 query loop。工具选择、安全检查、上下文压缩和 transcript 也沿用同一实现。

## 三种输出格式，不是三套执行逻辑

CLI 对 `--output-format` 给出的封闭选项是 `'text' | 'json' | 'stream-json'`。循环结束后，`runHeadless()` 只改变怎样消费已经产生的 SDK messages：

```ts
switch (options.outputFormat) {
  case 'json':
    if (options.verbose) {
      writeToStdout(jsonStringify(messages) + '\n')
      break
    }
    writeToStdout(jsonStringify(lastMessage) + '\n')
    break
  case 'stream-json':
    break // 事件此前已经逐条写出
  default:
    if (lastMessage.subtype === 'success') {
      writeToStdout(
        lastMessage.result.endsWith('\n')
          ? lastMessage.result
          : lastMessage.result + '\n',
      )
    }
    // 省略其余 error subtype 分支
}
```

`options.outputFormat` 为 `undefined` 或 `'text'` 时走默认分支，只输出成功 result 的文本，错误 subtype 会转换成简短错误文本；`'json'` 默认输出单个最终 `result` 对象，配合 `verbose: true` 时输出收集到的消息数组；`'stream-json'` 在遍历过程中已经逐条写出，不会在结尾重复。源码还要求 print 模式的 `stream-json` 同时打开 `verbose`。

主要事件可以用三个层次理解：

- `system/init` 告诉宿主版本、cwd、模型、工具、MCP server、permission mode、skills 和 plugins。
- `assistant`、`user`、可选的 `stream_event`、工具进度与 hook 事件描述执行过程。`stream_event` 只有 `includePartialMessages` 打开时才会包含模型原始增量。
- `result` 是一轮的终态。成功 subtype 为 `success`；错误 subtype 可以是 `error_during_execution`、`error_max_turns`、`error_max_budget_usd` 或 `error_max_structured_output_retries`。成功消息还带 duration、turn 数、cost、usage、permission denials 与可选 `structured_output`。

结构化结果和结构化传输也不是一回事。`--output-format=json` 决定“外层怎样封装运行结果”；`--json-schema` 则会注册合成输出工具，要求模型产出符合业务 schema 的 `structured_output`。前者解决机器读取，后者解决结果形状约束，两者可以组合，但不能混为一个开关。

## 为什么 `stream-json` 必须保护 stdout

NDJSON 的边界是一行一个 JSON。某个依赖库随手 `console.log('connected')`，就足以让 SDK 的逐行解析器崩掉。因此 `restored-src/src/utils/streamJsonStdoutGuard.ts` 在第一次结构化写出前替换了 `process.stdout.write`：

```ts
if (options.outputFormat === 'stream-json') {
  installStreamJsonStdoutGuard()
}

// installStreamJsonStdoutGuard() 内部
if (isJsonLine(line)) {
  originalWrite!(line + '\n')
} else {
  process.stderr.write(`${STDOUT_GUARD_MARKER} ${line}\n`)
}
```

`installStreamJsonStdoutGuard()` 没有参数，也没有返回值；重复调用会直接返回。它缓冲到换行后再判断完整行：合法 JSON 留在 stdout，非 JSON 被转移到 stderr；进程清理时还会处理未换行的残片并恢复原始 writer。这说明 stdout 在 SDK 模式中是协议通道，不再是调试控制台。

`StructuredIO` 还把普通 SDK event 和内部 `sendRequest()` 产生的 control message 放进同一个 `outbound` FIFO。这样 permission request 不会越过已经排队的模型增量。结构化协议的价值不只是字段齐全，也包括可解释的事件顺序。

## 不可交互权限到底怎样处理



有。工具自己的 `checkPermissions()`、allow/ask/deny 规则、permission mode、Hook 与安全检查仍然执行。对外可见的 mode 包括 `default`、`acceptEdits`、`bypassPermissions`、`plan`、`dontAsk`，以及受功能开关约束的 `auto`；它们改变规则怎样处理，却不会凭空创建确认 UI。缺少的只是 React `PermissionPrompt` 这个人机宿主。`restored-src/src/cli/print.ts` 的 `getCanUseToolFn()` 把“需要询问”分成三条路。

### 第一条：普通 `-p` 没有权限宿主

没有指定 permission prompt tool 时，适配器只返回权限引擎的结果：

```ts
if (!permissionPromptToolName) {
  return async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseId,
    forceDecision,
  ) =>
    forceDecision ??
    (await hasPermissionsToUseTool(
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseId,
    ))
}
```

`permissionPromptToolName` 为 `undefined` 时进入此分支。`forceDecision` 若存在，优先使用；否则调用 `hasPermissionsToUseTool()`。`toolUseId` 用于把决定关联到原始 `tool_use`，`assistantMessage` 与 `toolUseContext` 提供消息和运行状态。注意，这段没有把 `ask` 自动升级成 `allow`，也没有读取 stdin 的 yes/no。

`restored-src/src/services/tools/toolExecution.ts` 只执行 `behavior === 'allow'`，其他行为都生成错误结果：

```ts
if (permissionDecision.behavior !== 'allow') {
  resultingMessages.push({
    message: createUserMessage({
      content: [{
        type: 'tool_result',
        content: permissionDecision.message,
        is_error: true,
        tool_use_id: toolUseID,
      }],
    }),
  })
}
```

这里的 `permissionDecision.behavior` 可见值包括 `allow`、`ask` 和 `deny`；只有 `allow` 越过分支。`toolUseID` 精确关联被拒绝的调用，`is_error: true` 让模型知道工具没有执行。于是普通 `-p` 中的 `ask` 不会挂起，也不会绕过权限，而是作为未获许可回到模型。

这意味着脚本要提前把权限写清楚：用精确 allow 规则或 `--allowed-tools` 放行必要操作，用 deny 规则收紧边界，或选择合适 permission mode。`--dangerously-skip-permissions` 确实可以绕过检查，但源码帮助文本也明确把它限定为危险选项，并建议只在无网络的隔离沙箱使用。它不是“让 `-p` 正常工作”的默认答案。

### 第二条：SDK 通过 stdio 请求宿主决定

当 `permissionPromptToolName === 'stdio'`，`getCanUseToolFn()` 返回 `restored-src/src/cli/structuredIO.ts` 的 `structuredIO.createCanUseTool()`。启用这类权限回调的 SDK 会使用该控制协议；`--sdk-url` 还会强制把有效 prompt tool 设为 `'stdio'`，因此远端 SDK 也进入同一协议分支。

权限引擎先跑；只有结果仍是 `ask`，才创建控制请求：

```ts
const sdkPromise = this.sendRequest<PermissionToolOutput>(
  {
    subtype: 'can_use_tool',
    tool_name: tool.name,
    input,
    permission_suggestions: mainPermissionResult.suggestions,
    tool_use_id: toolUseID,
  },
  permissionPromptToolOutputSchema(),
  hookAbortController.signal,
  requestId,
)

const winner = await Promise.race([hookPromise, sdkPromise])
```

`sendRequest()` 的 request subtype 是 `'can_use_tool'`；`tool_name`、`input`、`tool_use_id` 告诉宿主正在批准什么；`permission_suggestions` 可为 `undefined`，或包含“始终允许”等可持久化建议；schema 校验宿主返回值；`AbortSignal` 在查询取消或 Hook 先决定时中止等待；`requestId` 把异步 response 与这一次请求配对。

这里还有一个容易漏掉的细节：PermissionRequest Hook 和 SDK 弹窗并行竞速。Hook 先返回 allow/deny，就取消未完成的 SDK request；Hook 没有决定，才继续等待 SDK；SDK 先返回，则采用宿主结果。输入流关闭、响应不合法或请求异常时，catch 分支转换成 deny，而不是默认放行。

这正是 SDK 相比普通 `-p` 多出来的能力：不是权限更宽，而是拥有一个可编程、可取消、能返回结构化决定的宿主。

### 第三条：`-p` 把询问委托给 MCP 工具

`--permission-prompt-tool <tool>` 提供另一种宿主。Claude Code 在 MCP 工具列表中按名字找到它，把当前 `tool_name`、`input` 和 `tool_use_id` 作为一次工具调用发送，再把返回文本解析成 permission decision。

```ts
const toolCallPromise = permissionPromptTool.call(
  { tool_name: tool.name, input, tool_use_id: toolUseId },
  toolUseContext,
  canUseTool,
  assistantMessage,
)

return permissionPromptToolResultToPermissionDecision(
  permissionToolOutputSchema().parse(
    safeParseJSON(permissionToolResultBlockParam.content[0].text),
  ),
  permissionPromptTool,
  input,
  toolUseContext,
)
```

`permissionPromptTool.call()` 的第一个参数是开放的工具名、输入对象和关联 ID；后续参数提供上下文、递归权限回调与原 assistant message。返回值必须能映射成单个 text block，文本还必须通过 permission output schema；否则抛错。调用同时与 abort signal 竞速，被取消时返回 deny。被选作 prompt host 的 MCP 工具会从普通可用工具列表中移除，避免模型把它当业务工具直接调用。

因此三条路的安全语义是一致的：规则能直接决定就直接返回；确实需要 ask 时，必须有明确宿主；宿主失联、取消或响应非法都不能变成 allow。

## `claude -p` 与 SDK 到底怎么选

如果你的代码需要结合 Claude Code，可以先看你需要的是“一个命令的结果”，还是“一个可控制的会话”。

适合直接用 `claude -p` 的场景：

- Shell、Makefile、CI job 里的一次性任务，输入已经是一段文本，结束后只关心 stdout 和退出状态。
- 权限集合可以在启动前确定，不需要执行途中弹出自定义确认 UI。
- 只需要最终文本，或一个 `json` result；业务对象有固定形状时，再叠加 `--json-schema`。
- 你愿意自己管理子进程、超时、stderr、版本和 session 参数。

适合使用 Agent SDK 的场景：

- 应用要持续接收 assistant、tool progress、partial message、system status 和最终 result，而不是等进程结束再解析一段文本。
- 执行途中需要 `canUseTool` 之类的权限回调，由 IDE、网页或业务审批逻辑决定 allow/deny。
- 需要主动 interrupt、切换模型或 permission mode、管理 MCP、恢复多轮 session，或把 user message 持续送入同一协议。
- 希望用 SDK 类型屏蔽 NDJSON、`request_id`、取消和消息兼容细节。

两者之间还有一条实用的中间路线：先用 `claude -p --output-format stream-json --verbose` 验证协议和自动化流程；当你开始手写 pending-request map、事件类型分发、取消传播与权限回调时，就说明这段 glue code 已经接近 SDK 的职责，应该迁移到 SDK。

反过来，如果代码只是每天跑一次“检查仓库并输出符合 schema 的报告”，引入完整 SDK 会增加生命周期管理，却未必增加业务价值。`-p` 更小，也更容易从命令行复现。

## 无头不等于无人负责

最后收一下安全边界。

第一，`-p` 会跳过 workspace trust 对话框。CLI 帮助文本直接提醒只能在信任目录使用，主入口也会在 print 分支应用完整环境变量。自动化系统必须自己决定 cwd、项目配置和环境变量是否可信。

第二，权限与 sandbox 是两层边界。allow 决定工具能不能尝试执行，sandbox 决定执行后能访问什么。源码发现用户要求 sandbox、但运行依赖缺失时，会警告命令将不受网络和文件限制；若 `failIfUnavailable` 生效则直接拒绝启动。。

第三，stdout 在 `stream-json` 下是机器协议，诊断必须去 stderr。宿主也应按 schema 处理未知事件，而不是假设永远只有 assistant/result；2.1.88 的消息联合已经包含 rate limit、task、hook、auth、compact boundary 等系统事件。

。集成代码仍应固定并记录 Claude Code/SDK 版本，测试权限超时、断流、重复 response 与部分结果。

## 小结

Claude Code 的交互式 REPL 与无头模式共享 Agent 内核，差别集中在宿主层。

`-p`、SDK stdin 和 Remote URL 先被 `StructuredIO` 归一化，`runHeadlessStreaming()` 再把每轮输入交给同一个 `ask()`。`text`、`json`、`stream-json` 只改变消息怎样输出；`--json-schema` 约束的是业务结果，不是传输协议。

权限也没有因为无头而消失。普通 `-p` 没有确认宿主，`ask` 因未获 allow 而生成错误 `tool_result`；SDK 用 `control_request` / `control_response` 把决定交给调用方；`--permission-prompt-tool` 则委托给 MCP 工具。三个分支都保留规则和安全检查，异常、取消与断流都不会默认放行。

选择上，一次性、权限静态、只取终态的自动化优先 `claude -p`；需要事件流、多轮控制、动态权限和类型化协议时使用 Agent SDK。它们不是两套 Agent，而是同一套运行时的两种宿主契约。

## 留给下一篇的问题

同一套运行时支持多种入口以后，Claude Code 如何合并用户、项目、本地、策略、CLI 设置与功能开关，并决定最终行为？

