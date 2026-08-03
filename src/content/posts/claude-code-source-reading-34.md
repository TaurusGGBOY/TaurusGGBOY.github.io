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

上一篇留下的问题是：**如果想自定义 Claude Code 的快捷键，应该如何实现？**

先抓住写入边界：不要改发布包里的 `DEFAULT_BINDINGS`，运行 `/keybindings`，再编辑它创建或打开的 `~/.claude/keybindings.json`。2.1.88 的实现把文件 watcher、schema 校验、上下文过滤和事件拦截器接成热加载链；用户保存文件后，绑定才会在当前进程重新参与匹配。

## 先用 `/keybindings` 生成正确的文件

命令实现位于 `restored-src/src/commands/keybindings/keybindings.ts`。`call()` 先检查 `isKeybindingCustomizationEnabled()`；功能开关关闭时，它会明确返回“Keybinding customization is not enabled”，这不是 JSON 写错，而是该版本构建尚未获得功能 rollout。开关开启时，命令调用 `getKeybindingsPath()`，把路径解析为 Claude 配置目录下的 `keybindings.json`（通常是 `~/.claude/keybindings.json`），用独占创建避免覆盖已有文件，然后交给编辑器打开。

模板由 `generateKeybindingsTemplate()` 生成。它包含 `$schema`、`$docs` 和 `bindings` 三个字段，并且会先过滤不能重绑定的快捷键。建议保留这两个元数据字段，这样编辑器可以提供上下文、action 和按键格式提示。

最小可用配置可以这样写：

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+e": "chat:externalEditor",
        "ctrl+k ctrl+c": "command:compact",
        "ctrl+u": null
      }
    },
    {
      "context": "Global",
      "bindings": {
        "ctrl+shift+t": "app:toggleTodos"
      }
    }
  ]
}
```

这里有三种不同意图：把 `ctrl+e` 映射到内置 action，把两步 chord `ctrl+k ctrl+c` 映射到 `/compact`，以及用 `null` 解除一个默认绑定。`command:<name>` 不是任意 action 字符串：源码校验它只能由字母、数字、冒号、连字符和下划线组成，而且 command binding 必须放在 `Chat` context 中。

## 配置格式如何变成可匹配的按键

`KeybindingBlockSchema` 要求顶层 `bindings` 是数组；每个 block 必须有 `context` 和 `bindings` 对象。2.1.88 能识别的上下文包括 `Global`、`Chat`、`Autocomplete`、`Confirmation`、`Help`、`Transcript`、`HistorySearch`、`Task`、`ThemePicker`、`Settings`、`Tabs`、`Attachments`、`Footer`、`MessageSelector`、`DiffDialog`、`ModelPicker`、`Select` 和 `Plugin`。同一个按键放在不同 context，可以在不同界面触发不同动作；`Global` 则参与所有界面。

动作值有三类：

| 写法 | 含义 |
| --- | --- |
| `chat:externalEditor`、`app:toggleTodos` 等枚举值 | 调用源码已注册的 action；可用列表由 schema 静态定义 |
| `command:compact` | 在 Chat 输入上下文执行一个 slash command |
| `null` | 在该 context 解除匹配到的默认快捷键 |

按键字符串先由 `parseChord(input)` 按空格切成多个步骤，再由 `parseKeystroke(input)` 按 `+` 解析修饰键。源码确认的别名包括 `ctrl`/`control`、`alt`/`opt`/`option`、`shift`、`meta`、`cmd`/`command`/`super`/`win`，特殊键包括 `esc`、`return`、`space` 和方向键。单独的空格会被识别成 Space，而不是 chord 分隔符。因此 `ctrl+k ctrl+c` 是“先按 Ctrl+K，再按 Ctrl+C”，不是一个名字里带空格的按键。

加载顺序也很关键。`loadKeybindings()` 先得到 `DEFAULT_BINDINGS`，再把用户解析结果拼到数组末尾：

```ts
const mergedBindings = [...defaultBindings, ...userParsed]
```

解析器反向查找匹配项，所以用户绑定可以覆盖默认绑定；`null` 则会让默认 action 不再被调用。快捷键解析不是只看一组全局字符串，`ChordInterceptor` 会把当前注册的 handler context、组件激活 context 和 `Global` 组合起来，再调用 `resolveKeyWithChordState()`。前缀匹配会进入 pending 状态，完整匹配才触发 handler，失配或取消才把事件继续交给输入组件。

## 保存后为什么不用重启

`KeybindingSetup` 首次渲染时同步加载配置，并在 effect 中启动 `initializeKeybindingWatcher()`。watcher 使用 chokidar 监听同一个 `keybindings.json`，等待文件写入稳定后重新读取；热更新结果会替换 React context 中的 bindings，并把新的 warnings 显示到 UI。文件不存在时继续使用默认绑定；JSON 结构错误、未知 context、非法 action、重复绑定或保留快捷键冲突，则回退到默认绑定并记录警告。可以运行 `/doctor` 集中查看这些问题。

这里有三个常见陷阱：

1. **把快捷键写进 `settings.json`。** 2.1.88 的这条路径读取的是独立的 `keybindings.json`，不是设置合并器。
2. **把 `/compact` 直接当 action。** slash command 需要写成 `command:compact`，并放在 `Chat` context；内置 action 才使用 `chat:*`、`app:*` 等命名空间。
3. **忽略终端和 Vim。** Ctrl+C、Ctrl+D 等硬编码或终端保留快捷键不能可靠重绑定；tmux、screen 也可能先截获 Ctrl+B、Ctrl+A。Vim 模式在文本输入层处理 normal/insert，keybindings 在组件 action 层处理，Escape 在 Vim 中通常先负责切换模式，不会被当成普通的 `chat:cancel`。

因此，实际实现步骤就是：运行 `/keybindings` → 选择正确 context 和 action → 用显式修饰键写 chord → 保存 → 看热更新提示 → 必要时用 `/doctor` 修复 warning。这个机制让用户只替换绑定数据，快捷键解析、优先级和事件传播仍由 Claude Code 的统一运行时负责。

## 本章先建立三个概念

- **协议 framing**：`text`、`JSON` 与 `NDJSON` 用不同边界标记一条结果或一串实时事件。

- **stdout 纪律**：无头模式把 stdout 作为机器协议通道，诊断与交互信息必须走其他出口。

- **Schema-bound result**：JSON Schema 把模型输出约束成调用方可验证的结构化结果。

![Headless 模式的 text、JSON 与 stream-json 分帧](/images/posts/claude-code-source-reading-34/34-structured-io-framing-detail-handdrawn.png)

这三个概念把本篇的读法固定下来：先区分界面与协议，再看消息怎样分帧，最后检查结果是否满足 schema。

## 先补三个概念：Headless、SDK 与 Structured IO

### Headless 用协议替换交互界面

交互式 Claude Code 有 Ink renderer、消息列表、输入框、权限弹窗和快捷键。无头模式跳过这棵 React 树，仍保留会话状态、工具注册表、权限上下文、消息历史、MCP 连接和查询循环，并用输入输出协议承接原先由 UI 承担的交互。

### SDK 以宿主 API 复用同一模型调用链

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

`query()` 是 SDK 的类型入口。`prompt` 为 `string` 时适合一次性输入，为 `AsyncIterable<SDKUserMessage>` 时可以持续送入多轮 user message；`options` 可省略，公开 `Options` 与内部 `InternalOptions` 对应两个重载，静态类型保留了各自的运行时选项。返回的 `Query` / `InternalQuery` 供 SDK 宿主持续消费事件和终态。

### Structured IO 是事件协议

结构化输入输出为每一条消息提供可判别的 `type`，请求与响应还通过 `request_id` 关联。文本、模型增量、工具进度、权限请求、终态和错误因此能够分别处理。

`restored-src/src/entrypoints/sdk/coreSchemas.ts` 与 `controlSchemas.ts` 把 stdin、stdout 边界写得很明确：stdin 可以接收 user message、control request、control response、keep-alive 和环境变量更新；stdout 还会发送 assistant、system、result、stream event，以及控制请求与取消事件。`stream-json` 因此是一套带控制面的双向协议。

## 入口先决定是否挂载 REPL

同一条命令为什么有时挂 Ink、有时只输出一行 JSON？答案在入口，而不在 `ask()`：主入口先判断 stdout 是否可交互，再决定是否挂载 REPL。

```ts
const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print')
const hasInitOnlyFlag = cliArgs.includes('--init-only')
const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'))
const isNonInteractive =
  hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY

setIsInteractive(!isNonInteractive)
initializeEntrypoint(isNonInteractive)
```

这段位于 `restored-src/src/main.tsx`。`hasPrintFlag` 同时识别短参数 `-p` 和长参数 `--print`；`hasInitOnlyFlag` 表示只执行初始化；`hasSdkUrl` 只要出现 `--sdk-url...` 就成立；stdout 为非 TTY 时也进入非交互状态。`setIsInteractive(false)` 让后续代码避开交互宿主；`initializeEntrypoint()` 只记录入口形态，Agent 执行由后续链路启动。

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

`headlessStore` 以 `headlessInitialState` 为初始快照，并把有效变化交给 `onChangeAppState`。`runHeadless()` 的第一个参数 `inputPrompt` 是字符串或 `AsyncIterable<string>`；`getState` / `setState` 让查询循环继续读写 `AppState`；`commandsHeadless` 只保留允许非交互执行的命令；`tools` 与 `sdkMcpConfigs` 提供本地工具和 SDK MCP；`agents` 是本次可用 Agent。`options.outputFormat` 决定输出封装，`permissionPromptToolName` 选择权限宿主，`maxTurns` 提供可选轮数上限；其余字段继续承载预算、模型和 session 设置。

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

`getStructuredIO()` 的 `inputPrompt` 接受字符串或字符串异步流；`options` 汇集 transport 选择与回放策略，其中 `sdkUrl` 为 URL 字符串时创建 `RemoteIO`，省略时创建本地 `StructuredIO`；`replayUserMessages: true` 会把收到的用户/控制消息重新发到输出端作为确认，省略或 `false` 时跳过回放。包装消息的 `type` 固定为 `'user'`，`message.role` 固定为 `'user'`，`content` 保存原 prompt；空 `session_id` 交给后续会话初始化补齐，`parent_tool_use_id: null` 表示这条输入属于顶层会话而非某个工具调用。空字符串会变成空流。

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

`ask()` 的 `prompt` 是本轮字符串或内容块；`cwd` 由调用时的 `cwd()` 固定为当前工作目录，供路径解析、工具执行和上下文构造共用；`commands`、`tools` 是当时已装配的命令与工具；`canUseTool` 是本篇后半的权限宿主适配器；`maxTurns`、`maxBudgetUsd` 均可为 `undefined`，此时对应限制保持关闭；`mutableMessages` 是跨轮次复用的历史数组；`abortController` 承载中断；`includePartialMessages` 为真时才把模型原始增量映射进 SDK 输出，省略或假值时仍会得到完整消息与终态。

因此，SDK 从结构化入口进入 `ask()`，再继续进入前文分析过的 query loop。工具选择、安全检查、上下文压缩和 transcript 都沿用同一实现。

## 三种输出格式共享一套执行逻辑

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

结构化结果和结构化传输位于两层：`--output-format=json` 决定外层怎样封装运行结果；`--json-schema` 注册合成输出工具，要求模型产出符合业务 schema 的 `structured_output`。前者解决机器读取，后者解决结果形状约束，两者可以组合。

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

`installStreamJsonStdoutGuard()` 接受零个参数并返回 `void`；重复调用会直接返回。它缓冲到换行后再判断完整行：合法 JSON 留在 stdout，非 JSON 被转移到 stderr；进程清理时还会处理未换行的残片并恢复原始 writer。stdout 在 SDK 模式中由此成为只承载协议消息的通道。

`StructuredIO` 还把普通 SDK event 和内部 `sendRequest()` 产生的 control message 放进同一个 `outbound` FIFO。permission request 会排在已经入队的模型增量之后，事件顺序因此可被宿主解释。

## 非交互权限沿三类宿主分流

工具自己的 `checkPermissions()`、allow/ask/deny 规则、permission mode、Hook 与安全检查仍然执行。对外可见的 mode 包括 `default`、`acceptEdits`、`bypassPermissions`、`plan`、`dontAsk`，以及受功能开关约束的 `auto`；它们改变规则怎样处理，确认动作则由无头宿主承接。`restored-src/src/cli/print.ts` 的 `getCanUseToolFn()` 把“需要询问”分成三条路。

### 第一条：普通 `-p` 使用规则终态

省略 permission prompt tool 时，适配器直接返回权限引擎的结果：

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

`permissionPromptToolName` 省略时进入此分支。`forceDecision` 若存在，优先使用；否则调用 `hasPermissionsToUseTool()`。`toolUseId` 用于把决定关联到原始 `tool_use`，`assistantMessage` 与 `toolUseContext` 提供消息和运行状态。该分支保留 `ask` 原值，也不从 stdin 读取 yes/no。

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

这里的 `permissionDecision.behavior` 可见值包括 `allow`、`ask` 和 `deny`；只有 `allow` 越过分支。其余值创建一条 `user` 消息：`permissionDecision.message` 被复制到 `tool_result.content`，作为模型可见的权限决定文本；`tool_use_id` 精确关联原调用，`is_error: true` 告诉模型工具未执行。于是普通 `-p` 中的 `ask` 作为未获许可结果回到模型。

这意味着脚本要提前把权限写清楚：用精确 allow 规则或 `--allowed-tools` 放行必要操作，用 deny 规则收紧边界，或选择合适 permission mode。`--dangerously-skip-permissions` 会绕过检查；源码帮助文本将它标为危险选项，并建议只在无网络的隔离沙箱使用。

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

这里还有一个容易漏掉的细节：PermissionRequest Hook 和 SDK 弹窗并行竞速。Hook 先返回 allow/deny，就取消未完成的 SDK request；Hook 返回中性结果时继续等待 SDK；SDK 先返回，则采用宿主结果。输入流关闭、响应不合法或请求异常时，catch 分支统一转换成 deny。

SDK 相比普通 `-p` 多出一个可编程、可取消、能返回结构化权限决定的宿主。

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

`permissionPromptTool.call()` 的输入对象含 `tool_name`、`input`、`tool_use_id`：前两项描述待审批动作，后者关联原始调用；后续参数提供工具上下文、递归权限回调与原 assistant message。`toolCallPromise` 与 abort signal 竞速；返回内容必须是单个 text block，并通过 permission output schema，取消时则转换为 deny。被选作 prompt host 的 MCP 工具会从普通可用工具列表中移除，避免模型把它当业务工具直接调用。

因此三条路的安全语义是一致的：规则能直接决定就直接返回；确实需要 ask 时，必须有明确宿主；宿主失联、取消或响应非法都不能变成 allow。

## `claude -p` 与 SDK 到底怎么选

如果你的代码需要结合 Claude Code，可以先看你需要的是“一个命令的结果”，还是“一个可控制的会话”。

适合直接用 `claude -p` 的场景：

- Shell、Makefile、CI job 里的一次性任务，输入已经是一段文本，结束后只关心 stdout 和退出状态。
- 权限集合可以在启动前确定，不需要执行途中弹出自定义确认 UI。
- 只需要最终文本，或一个 `json` result；业务对象有固定形状时，再叠加 `--json-schema`。
- 你愿意自己管理子进程、超时、stderr、版本和 session 参数。

适合使用 Agent SDK 的场景：

- 应用要持续接收 assistant、tool progress、partial message、system status 和最终 result。
- 执行途中需要 `canUseTool` 之类的权限回调，由 IDE、网页或业务审批逻辑决定 allow/deny。
- 需要主动 interrupt、切换模型或 permission mode、管理 MCP、恢复多轮 session，或把 user message 持续送入同一协议。
- 希望用 SDK 类型屏蔽 NDJSON、`request_id`、取消和消息兼容细节。

两者之间还有一条实用的中间路线：先用 `claude -p --output-format stream-json --verbose` 验证协议和自动化流程；当你开始手写 pending-request map、事件类型分发、取消传播与权限回调时，就说明这段 glue code 已经接近 SDK 的职责，应该迁移到 SDK。

反过来，如果代码只是每天跑一次“检查仓库并输出符合 schema 的报告”，引入完整 SDK 会增加生命周期管理，却未必增加业务价值。`-p` 更小，也更容易从命令行复现。

## 无头运行把安全责任交给调用方

最后收一下安全边界。

第一，`-p` 会跳过 workspace trust 对话框。CLI 帮助文本直接提醒只能在信任目录使用，主入口也会在 print 分支应用完整环境变量。自动化系统必须自己决定 cwd、项目配置和环境变量是否可信。

第二，权限与 sandbox 是两层边界。allow 决定工具能不能尝试执行，sandbox 决定执行后能访问什么。源码发现用户要求 sandbox、但运行依赖缺失时，会警告命令将不受网络和文件限制；若 `failIfUnavailable` 生效则直接拒绝启动。

第三，stdout 在 `stream-json` 下是机器协议，诊断必须去 stderr。宿主也应按 schema 的未知事件分支处理扩展类型；2.1.88 的消息联合已经包含 rate limit、task、hook、auth、compact boundary 等系统事件。

。集成代码仍应固定并记录 Claude Code/SDK 版本，测试权限超时、断流、重复 response 与部分结果。

## 小结

Claude Code 的交互式 REPL 与无头模式共享 Agent 内核，差别集中在宿主层。

`-p`、SDK stdin 和 Remote URL 先被 `StructuredIO` 归一化，`runHeadlessStreaming()` 再把每轮输入交给同一个 `ask()`。`text`、`json`、`stream-json` 改变消息输出方式；`--json-schema` 则约束业务结果。

权限规则在无头模式中继续执行。普通 `-p` 将未获 allow 的 `ask` 生成错误 `tool_result`；SDK 用 `control_request` / `control_response` 把决定交给调用方；`--permission-prompt-tool` 则委托给 MCP 工具。三个分支都保留规则和安全检查，异常、取消与断流统一收敛到非 allow 结果。

选择上，一次性、权限静态、只取终态的自动化优先 `claude -p`；需要事件流、多轮控制、动态权限和类型化协议时使用 Agent SDK。两者共享 Agent 运行时，分别提供一次性命令和可编程宿主契约。

## 留给下一篇的问题

当你的代码需要调用 Claude Code 时，相比 Agent SDK，`claude -p` 在哪些场景下更有优势？

## 参考资料

- [Claude Code 非交互模式](https://code.claude.com/docs/en/headless)

- [Agent SDK Structured Outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)

- [Claude Code Keybindings](https://code.claude.com/docs/en/keybindings)

- [Claude Code Keybindings: Complete Keyboard Shortcuts Guide](https://claudefa.st/blog/tools/keybindings-guide)
