---
title: "Claude Code源码解读04：一套内核如何支持多种入口"
published: 2026-07-21T11:01:53+08:00
description: "比较交互式 REPL、print、Agent SDK、MCP、Bridge 与 direct-connect，解释不同宿主如何复用 Claude Code 的执行内核。"
tags: ["claude-code", "source-code", "ai-agent", "runtime"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-04/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-04
---
## 回答上一篇的问题

上一篇最后留下的问题来自一个很具体的命令：`claude -p`。当它无法像普通 REPL 一样停下来与用户交互时，工具权限由谁决定；而对 Claude Code 来说，带 `-p` 与不带 `-p`，究竟只是输出形式不同，还是运行模式已经变了？

答案先说：**运行模式改变了权限的交互入口；本地弹窗改由配置规则或外部协议承担。**

`-p` 是 `--print` 的短写。最简单的用法是 `claude -p "解释这个项目"`，也可以通过 stdin 接收输入。普通单 prompt 用法会执行任务、输出结果并退出，适合 Shell 管道、脚本和 CI；SDK 还可以在 `stream-json` 输入模式下持续提供消息。`--output-format` 支持 `text`、`json` 和 `stream-json`：`text` 是默认的最终文本，`json` 输出聚合后的结果对象，`stream-json` 持续输出结构化事件，并要求同时启用 `--verbose`。

源码在 `main()` 中把 `-p` 或 `--print` 识别为 `hasPrintFlag`，再把整个进程标记成 non-interactive。后面的主路径不会创建 Ink root，也不会挂载 React REPL，而是进入 `runHeadless()`。workspace trust 对话框也会被跳过，所以命令帮助明确提醒：只在你信任的目录中使用 `-p`。

权限处理要分三种情况看。

第一种是普通的 `claude -p`。它仍然调用与交互模式相同的 `hasPermissionsToUseTool()`，继续检查 deny、ask、allow 规则、工具自身约束和 permission mode。已经被规则或模式允许的调用可以执行，明确禁止的调用仍会被拒绝；需要 `ask` 的动作则无法再弹出本地 React 对话框，也不会因为使用了 `-p` 就自动获得授权。要让脚本稳定运行，调用方需要预先通过 `--allowedTools`、`--disallowedTools`、`--permission-mode` 或 settings 明确权限边界。

第二种是提供 `--permission-prompt-tool`。这时 Claude Code 会把权限请求交给指定的 MCP tool，由外部逻辑返回 allow 或 deny。权限决定仍然存在，只是“询问用户”被替换成了“调用另一个工具”。

第三种是 Agent SDK 或带 `--sdk-url` 的 headless 模式。源码会把 permission prompt tool 强制设为 `stdio`，把待确认动作写成 `control_request`；外部宿主返回 `control_response` 后，工具调用才继续。如果输入流在响应到达前关闭，所有仍在等待的权限请求都会以 `Tool permission stream closed before response received` 失败。

因此，`-p` 与普通 Claude Code 的区别可以归纳成两层。

外层 Host 不同。普通模式由 React/Ink REPL 管理键盘、消息列表、权限弹窗、取消和下一轮输入；`-p` 使用 `StructuredIO` 与 `QueryEngine` 管理输入输出和会话，得到结果后结束进程。headless 路径直接订阅 settings change，以替代 React tree 中对应 hook 的职责。

这里的 `StructuredIO` 是 **Structured Input/Output（结构化输入输出）** 的缩写：它把 prompt、stdin 或远程消息整理成带 `type` 的协议消息，再把 assistant、工具进度、权限控制请求和最终 result 序列化给宿主。它属于无头入口的消息适配层，Agent 模型仍由后面的查询循环承载；后文会继续拆解它如何处理这些消息。

内层 Agent 能力仍然复用。两条路径最终都会进入 `query()` / `queryLoop()`，使用相同的模型流、工具契约、权限结果和 `tool_result` 回环。`-p` 保留完整 Agent 内核，把交互职责从本地 REPL 转交给命令行参数、stdin、配置规则或外部 SDK 宿主。

这点很容易读错。`QueryEngine.ts` 的注释明确说，2.1.88 里的 `QueryEngine` 用于 headless/SDK，REPL 接入仍属于 “a future phase”。所以“一套内核”应该理解成**分层复用**：宿主层可以分叉，会话包装也可能不同，但进入 Agent 查询循环以后，模型、工具和消息语义重新汇合。

本篇继续只讨论 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码。下面的片段省略了与当前机制无关的参数和分支，函数名、关键取值与调用关系保持不变。

## Key Takeaways

- `claude` 命令的多种入口——交互式 REPL、`claude -p`、Agent SDK、MCP server、Bridge、direct-connect——不是六套 Agent，而是**同一套内核的不同宿主组合**。判别点只有两个：输入与权限从哪里来，Agent 循环在哪里运行。
- `main.tsx` 在完整初始化之前完成模式分流：`isNonInteractive` 是控制流判断（`-p`、`--init-only`、`--sdk-url` 或 stdout 非 TTY），`clientType` 是宿主身份标签（`github-action`、`sdk-typescript`、`sdk-python`、`sdk-cli`、`claude-vscode`、`local-agent`、`claude-desktop`、`remote`、`cli`）。
- REPL 直接调用 `query()`；print 与 Agent SDK 共用 `StructuredIO` + `QueryEngine` 的 headless 管道；两条路径最终都汇入 `query()` / `queryLoop()`。
- headless 模式不取消权限判断，只更换交互入口：规则与 permission mode 直接决策，`--permission-prompt-tool` 或 SDK 的 `control_request` / `control_response` 把待确认动作交给外部宿主。
- MCP server 是最容易被误读的入口：它只复用工具契约，直接执行 `tool.call()`，不进入 Agent 查询循环。
- 2.1.88 的边界：REPL 与 headless 已共享 `query()` / `queryLoop()`，但 `QueryEngine` 这个会话包装只服务 headless/SDK——源码注释写明 REPL 接入属于 "a future phase"。

## 本篇新增机制

上一篇（03）看完引导与初始化：入口分流 → 运行环境准备 → 能力装配 → 宿主就绪。本篇回答"一套内核如何支持多种入口"，新增机制包括：

- **运行模式分流**：`isNonInteractive`（控制流开关）与 `clientType`（宿主身份标签）双层识别，同一个 Commander 解析与 setup 流程根据标签选择出口。
- **传输与执行解耦**：`StructuredIO` 与 `SDKUserMessage` 的消息形状（`type`、`session_id`、`parent_tool_use_id`、`message.role`）；`RemoteIO` 走 WebSocket 或 SSE + HTTP POST。
- **权限协议化**：headless 权限闭环 `control_request` / `control_response` 与 `--sdk-url` 强制 permission prompt tool 为 `stdio` 的规则。
- **MCP server 旁路**：只复用工具执行契约，直接 `tool.call()`；两条限制（`thinkingConfig` 禁用、外部 MCP tools 不重新暴露）。
- **Bridge worker 化**：supervisor 为每个远端 session 拉起带 `--print --sdk-url` 的 headless 子进程；direct-connect 先创建 session 再经 WebSocket 连接。
- **同一任务三种出口**：REPL、`stream-json`、`json` 对同一内核事件的不同投影形态。

## 问题

发布窗口临近，同一个排查任务——"登录接口偶发超时，找出原因并给出修复计划"——同时出现在四种场景里：你在终端里交互式排查，CI 用 `claude -p` 做一次只读复现，内部诊断脚本通过 SDK 保留会话上下文，远程同事从 Remote Control 接管你已经打开的目录。

四种入口提交的是同一段任务，外壳却完全不同：交互式入口需要 TUI，`claude -p` 需要结构化输出，SDK 由宿主消费事件，Remote 把输入转发给远端 session。它们各自维护一套 Agent 实现吗？如果共享内核，共享的边界又在哪里？本篇的核心问题是：**谁接收输入、谁处理权限、Agent 循环在哪个进程里继续？**

## 正文

本文只讨论 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码。下面的片段省略了与当前机制无关的参数和分支，函数名、关键取值与调用关系保持不变。

### 先把运行模式拆成两个问题

可以用两个问题判断一种运行模式：

1. **输入和权限决定从哪里来？** 可能来自本地键盘、stdin、SDK 控制消息、WebSocket，或者 MCP 请求。
2. **Agent 循环在哪里运行？** 可能就在当前进程，也可能在 Bridge 拉起的子进程或远端 server；MCP server 则根本不运行它。

CLI、SDK、Bridge 和 direct-connect 是几种宿主与传输组合，而不是六套 Agent。决定行为的关键点是输入/权限来源和循环所在进程；传输本身只负责把结构化消息送到那条循环。

![Claude Code 多入口与共享内核手绘图](/images/posts/claude-code-source-reading-04/04-runtime-modes-handdrawn.png)

图中最下面的 `query()` → `queryLoop()` 是主要汇合点。REPL 直接进入 `query()`；print/SDK 先经过 `StructuredIO` 和 `QueryEngine`；Bridge 拉起带 `--sdk-url` 的 headless 子进程；MCP 的 `CallTool` 则沿旁路直接进入 `tool.call()`。

### 这些入口对应 Claude 的什么功能

出问题时，先问"谁接收输入、谁弹权限、谁运行 Agent"，比按入口名称猜是否共享内核更可靠。下表把用户可见的入口和源码中的宿主/传输组合对齐：

| 本文名称 | 用户在哪里遇到 | 在 2.1.88 源码中的位置 |
|---|---|---|
| 交互式 CLI / REPL | 在项目目录运行 `claude` | 当前进程挂载 React/Ink REPL，并在本地进入 Agent 循环 |
| print / headless | 运行 `claude -p "..."`，或把输入输出接进 Shell、脚本和 CI | 当前进程使用 `StructuredIO` 与 `QueryEngine`，不创建终端 UI |
| Agent SDK | Python、TypeScript 应用，或自行编写的 Agent 宿主 | 宿主通过结构化消息控制 Claude Code 子进程；CLI 的 `-p` 是这条无头能力最直接的入口 |
| MCP server | 运行 `claude mcp serve`，由 Claude Desktop 等 MCP client 连接 | 只处理 `ListTools` / `CallTool`，直接进入 `tool.call()`，不替调用方运行完整 Agent 循环 |
| Bridge | Remote Control：从 claude.ai/code、手机或另一浏览器继续控制本机任务 | 本机注册 environment、领取远端 session，再为它拉起 headless worker；"Bridge"是内部实现名，用户侧产品名是 Remote Control |
| direct-connect | 由 `cc://` 或 `cc+unix://` 地址打开的内部 server session | 客户端先向 server 创建 session，再连接返回的 WebSocket；本地负责 UI 和权限交互，Agent 在 server 会话中运行 |

其中前三种最容易对应到日常经验：`claude` 是终端产品，`claude -p` 是它的[脚本化用法](https://code.claude.com/docs/en/headless)，Agent SDK 则把同一套能力交给 Python 或 TypeScript 程序。MCP server 入口会让 Claude Code 自己成为服务器，把内置工具提供给其他宿主；平时连接 Notion、GitHub 等外部 MCP server 的路径则让 Claude Code 充当客户端（[`claude mcp serve`](https://code.claude.com/docs/en/mcp#use-claude-code-as-an-mcp-server)）。Bridge 对应的产品功能是 [Remote Control](https://code.claude.com/docs/en/remote-control)。direct-connect 的边界要更谨慎：2.1.88 客户端源码明确识别 `cc://` 与 `cc+unix://`，内部 `open <cc-url>` 命令也把自己描述为连接 Claude Code server；结合公开行为，更稳妥的理解是它是一条供 Desktop、Dispatch 或其他内部宿主接入 server session 的底层通道。

### main 先识别宿主，不急着决定业务逻辑

上一篇已经看到，`restored-src/src/main.tsx` 会在完整初始化前识别非交互模式。这段判断为后面的配置、遥测、权限和输入输出选择宿主语义，UI 是否挂载只是其中一个结果。

```ts
// [source] restored-src/src/main.tsx（2.1.88 source map 还原源码，省略无关分支）
const cliArgs = process.argv.slice(2)
const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print')
const hasInitOnlyFlag = cliArgs.includes('--init-only')
const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'))

const isNonInteractive =
  hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY

setIsInteractive(!isNonInteractive)
initializeEntrypoint(isNonInteractive)

const clientType = (() => {
  if (isEnvTruthy(process.env.GITHUB_ACTIONS)) return 'github-action'
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts') return 'sdk-typescript'
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-py') return 'sdk-python'
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return 'sdk-cli'
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode') return 'claude-vscode'
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent') return 'local-agent'
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return 'claude-desktop'
  const hasSessionIngressToken =
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN ||
    process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'remote' || hasSessionIngressToken) {
    return 'remote'
  }
  return 'cli'
})()
```

这里有两组容易混淆的状态。`isNonInteractive` 是控制流判断：`-p`、`--print`、`--init-only`、任意 `--sdk-url...` 参数，或者 stdout 为非 TTY，都会让它变成 `true`；其余情况进入交互模式。因此，即使用户省略 `--print`，把输出接入管道也可能让进程走非交互路径。`clientType` 则是宿主身份标签：源码能够确认的值包括 `github-action`、`sdk-typescript`、`sdk-python`、`sdk-cli`、`claude-vscode`、`local-agent`、`claude-desktop`、`remote` 和回退值 `cli`，主要来自环境变量和 session-ingress token，不能反过来理解成九套 Agent 实现。

因此，运行模式的第一层复用发生在 `main.tsx`：同一个 Commander 参数解析、项目 setup 和能力装配流程，根据宿主标签选择后面的出口。

### REPL 直接持有交互状态，再进入 query

交互式模式最后挂载 `REPL.tsx`。它需要维护输入框、消息列表、终端焦点、权限弹窗、取消状态和首屏渲染，因此不能只把一行 prompt 交给一个无状态函数。

当用户提交消息时，REPL 会从当前 store 重新取得工具和 MCP clients，组装 system prompt、user context 与 `ToolUseContext`，然后直接调用 `query()`：

```ts
// [source] restored-src/src/screens/REPL.tsx（2.1.88 source map 还原源码，省略无关参数）
const toolUseContext = getToolUseContext(
  messagesIncludingNewMessages,
  newMessages,
  abortController,
  mainLoopModelParam,
)

const { tools: freshTools, mcpClients: freshMcpClients } =
  toolUseContext.options

const systemPrompt = buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,
  toolUseContext,
  customSystemPrompt,
  defaultSystemPrompt,
  appendSystemPrompt,
})

for await (const event of query({
  messages: messagesIncludingNewMessages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool,
  toolUseContext,
  querySource: getQuerySourceForREPL(),
})) {
  onQueryEvent(event)
}
```

这里的"重新取得"很重要：MCP 连接可能在 REPL 首次渲染后才完成，源码因此让 `getToolUseContext()` 从最新 store 计算工具，避免 React 闭包里的旧列表漏掉刚连接的能力。`messagesIncludingNewMessages` 是含本轮输入的完整历史，`newMessages` 是本次新增消息，`abortController` 传播取消，`mainLoopModelParam` 指定本轮模型参数；返回值的 `options.tools` 与 `options.mcpClients` 分别是最新工具池和 MCP 连接。`buildEffectiveSystemPrompt()` 用 `mainThreadAgentDefinition` 选择主 Agent 定义，以 `toolUseContext` 注入能力边界；`customSystemPrompt` 可替换默认提示，`defaultSystemPrompt` 提供回退，`appendSystemPrompt` 在最终选择后追加内容。调用 `query()` 时，`messages`、`systemPrompt`、`userContext`、`systemContext` 构成模型输入，`canUseTool` 提供权限回调，`toolUseContext` 提供工具运行环境，`querySource` 标记 REPL 来源；返回的每个 `event` 都交给 `onQueryEvent()` 更新宿主。

权限也是同样的道理：REPL 传入的 `canUseTool` 可以触发本地确认界面，用户的选择再回到正在等待的工具调用。终端渲染只是宿主能力；真正的工具选择、`tool_use`、`tool_result` 和继续推理仍由下面的查询链处理。

`restored-src/src/query.ts` 对这个汇合点的定义非常直接：

```ts
// [source] restored-src/src/query.ts（2.1.88 source map 还原源码）
export async function* query(params: QueryParams) {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)

  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

也就是说，REPL 的特殊之处主要在 `query()` 之前如何维护状态，以及拿到事件以后如何渲染。`queryLoop()` 只消费宿主提供的上下文和回调，与终端输入框解耦。

### print 与 Agent SDK 共用一条 headless 管道

非交互路径在 `main.tsx` 中创建 headless store，准备命令、工具、Agent 和 MCP 配置，然后调用 `restored-src/src/cli/print.ts` 的 `runHeadless()`。

这里的 print 不能只理解成"打印最终文本"。CLI 暴露了两组格式取值：`--input-format` 可以是 `text` 或 `stream-json`（默认 `text`）；`--output-format` 可以是 `text`、`json` 或 `stream-json`（默认 `text`，`json` 聚合单次结果，`stream-json` 持续输出实时消息）。源码还限制 `stream-json` 输出必须同时启用 `--verbose`；`--include-partial-messages` 只有在 print + `stream-json` 下才有意义；`--replay-user-messages` 则要求输入和输出都采用 `stream-json`。这些值直接决定宿主能看到的消息层级。

`runHeadless()` 会先把普通字符串规范化成 SDK user message；传入异步输入流时保留流式形态。接下来由 `getStructuredIO()` 决定使用本地 stdio 还是远程传输：

```ts
// [source] restored-src/src/cli/print.ts（2.1.88 source map 还原源码）
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
        } satisfies SDKUserMessage),
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

`inputPrompt` 可以是单个字符串或异步字符串流：非空字符串被包装成一条 SDK user message，空白字符串产生空输入流，异步流原样透传。包装消息中 `type: 'user'` 与 `message.role: 'user'` 固定方向，`session_id: ''` 等待会话层填充，`message.content` 保存输入文本，`parent_tool_use_id: null` 表示顶层输入。`options.sdkUrl` 省略时用 `StructuredIO` 读写 NDJSON/stdin/stdout；提供 URL 时用 `RemoteIO`，由 URL 与运行时开关选择 WebSocket 或 SSE + HTTP POST。`replayUserMessages` 为真时把收到的用户消息重新发给宿主。

真正处理会话的是 `QueryEngine`——它就是下一篇的主角，这里先看它怎样被使用：

```ts
// [source] restored-src/src/cli/print.ts（2.1.88 source map 还原源码，省略无关配置字段）
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

`QueryEngine` 构造参数中的 `cwd` 固定工作目录，`tools`、`commands`、`mcpClients` 与 `agents` 定义能力集合，`canUseTool` 提供权限回调，`getAppState`/`setAppState` 连接宿主状态；`initialMessages` 提供起始历史，`readFileCache` 克隆本轮读取凭据。`submitMessage()` 的 `prompt` 是输入，`uuid` 关联消息，`isMeta` 标记元消息。一个实例对应一段 conversation，多次提交会保留消息、文件缓存和 usage；无论正常结束还是抛错，`finally` 都把最新 read-file state 写回宿主。

因此，Agent SDK 在 2.1.88 中复用同一套 Agent 内核。TypeScript、Python 或 CLI 宿主通过 `CLAUDE_CODE_ENTRYPOINT` 标记身份，再使用 headless 的结构化输入输出协议控制 Claude Code 子进程。SDK 可以发送用户消息、中断和权限响应，也可以接收 assistant、result、system、`control_request` 等事件；模型与工具循环仍在子进程内部。

### Headless 权限通过配置与控制协议闭环

`runHeadless()` 因此把权限处理也适配成输入输出协议：当提供 `--sdk-url` 时，源码把有效的 permission prompt tool 强制设为 `stdio`，工具需要确认时 `StructuredIO` 写出 `control_request`，宿主返回 `control_response` 后等待中的调用才继续；输入流提前关闭时，仍未完成的请求会被拒绝，错误信息是 `Tool permission stream closed before response received`。非交互模式仍执行权限判断：预配置的 allowed/denied rules 可以直接决策，`--permission-prompt-tool` 或 SDK 控制消息则把待确认动作交给外部宿主。

取消也从按键动作变成了消息。REPL 的 Ctrl+C 可以直接操作本地 abort controller；SDK 和远程宿主则发送 `interrupt` 控制请求，再由 headless 进程中止当前 turn。宿主不同，取消语义仍需要落回同一条会话状态链。

### MCP server 只复用工具执行契约

MCP server 是最容易被"多入口共享内核"这句话误导的一种模式。

`restored-src/src/entrypoints/mcp.ts` 的 `startMCPServer()` 通过 stdio 启动 MCP Server，注册 `ListToolsRequestSchema` 与 `CallToolRequestSchema`。收到工具调用后，它查找工具、检查是否启用、校验输入，然后直接执行 `tool.call()`：

```ts
// [source] restored-src/src/entrypoints/mcp.ts（2.1.88 source map 还原源码）
server.setRequestHandler(CallToolRequestSchema, async ({
  params: { name, arguments: args },
}) => {
  const toolPermissionContext = getEmptyToolPermissionContext()
  const tools = getTools(toolPermissionContext)
  const tool = findToolByName(tools, name)
  if (!tool) throw new Error(`Tool ${name} not found`)

  if (!tool.isEnabled()) {
    throw new Error(`Tool ${name} is not enabled`)
  }

  const validationResult = await tool.validateInput?.(
    (args as never) ?? {},
    toolUseContext,
  )
  if (validationResult && !validationResult.result) {
    throw new Error(
      `Tool ${name} input is invalid: ${validationResult.message}`,
    )
  }

  const finalResult = await tool.call(
    (args ?? {}) as never,
    toolUseContext,
    hasPermissionsToUseTool,
    createAssistantMessage({ content: [] }),
  )

  return {
    content: [{
      type: 'text' as const,
      text:
        typeof finalResult === 'string'
          ? finalResult
          : jsonStringify(finalResult.data),
    }],
  }
})
```

handler 从 `params` 读取 `name` 与 `arguments`：`name` 用于注册表查找，`arguments` 为 `null` 或省略时传入空对象。`toolPermissionContext` 是空权限上下文，`tools` 是据此取得的基础工具池，`tool` 是名称命中的单个工具。`isEnabled()` 必须为真；可选的 `validateInput` 存在时校验 `args`，失败结果用 `message` 组成异常。`tool.call()` 接收最终输入、工具上下文、权限函数和空内容 assistant 消息；返回值为字符串时直接写入 `content[0].text`，否则序列化 `finalResult.data`。该路径直接服务一次工具调用，不进入 `QueryEngine` 或 `queryLoop()`。

所以 MCP server 的角色发生了反转：平时 Claude Code 是 MCP client，从外部服务器取得工具；进入这个入口后它变成 MCP server，把自己的基础工具交给另一个 Agent 或宿主调用。它复用 Tool 接口、Schema、文件状态和权限能力，调用选择与后续推理由外部宿主负责。源码中还有两条明确限制：当前 handler 尚未重新暴露外部 MCP tools；`ToolUseContext` 中的 `thinkingConfig` 固定为 `{ type: 'disabled' }`，`mcpClients` 和 Agent 定义也是空集合。因此这条路径只提供单次工具服务，完整会话循环留在调用方。

### Bridge 与 direct-connect：把进程边界加进来

`claude remote-control` 在 CLI fast path 中进入 `bridgeMain()`。它检查登录、功能开关、最低版本、组织策略和目录信任，然后注册 Bridge environment，轮询远端工作。收到 session 后，`restored-src/src/bridge/sessionRunner.ts` 会拉起一个新的 Claude Code 子进程：

```ts
// [source] restored-src/src/bridge/sessionRunner.ts（2.1.88 source map 还原源码）
const args = [
  ...deps.scriptArgs,
  '--print',
  '--sdk-url',
  opts.sdkUrl,
  '--session-id',
  opts.sessionId,
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--replay-user-messages',
  ...(deps.verbose ? ['--verbose'] : []),
  ...(deps.permissionMode
    ? ['--permission-mode', deps.permissionMode]
    : []),
]
```

这段参数几乎把 Bridge 的复用方式写在了明面上：Bridge supervisor 不重新实现 Agent 循环，而是把每个 session 变成一个 headless/SDK 子进程。`--sdk-url` 让 `StructuredIO` 切到 `RemoteIO`，两端用 `stream-json` 交换用户消息、模型事件、权限请求和中断。`permissionMode` 为 `undefined` 时不传这个参数，由子进程使用自己的默认和配置回退；有值时，`bridgeMain()` 会先用 `PERMISSION_MODES` 校验。Bridge 的外层职责是注册、轮询、容量、子进程生命周期、token 刷新和重连；session 真正开始工作后，模型与工具仍在被拉起的 headless Claude Code 中运行。失败边界也分成两层：注册失败、工作区未信任、HTTP 非本机地址或认证缺失会让 supervisor 无法接单；子进程里的模型错误、工具错误、权限拒绝和取消，则沿 SDK 消息回到远端。

direct-connect 与 Bridge 都使用网络，但方向不同：Bridge 是本机主动注册为可接收工作的 environment；direct-connect 则是本地 CLI 主动连接一个已存在的 server——先请求创建 session，再通过返回的 WebSocket 地址进入它。`restored-src/src/server/createDirectConnectSession.ts` 的契约很短：

```ts
// [source] restored-src/src/server/createDirectConnectSession.ts（2.1.88 source map 还原源码）
const resp = await fetch(`${serverUrl}/sessions`, {
  method: 'POST',
  headers,
  body: jsonStringify({
    cwd,
    ...(dangerouslySkipPermissions && {
      dangerously_skip_permissions: true,
    }),
  }),
})

return {
  config: {
    serverUrl,
    sessionId: data.session_id,
    wsUrl: data.ws_url,
    authToken,
  },
  workDir: data.work_dir,
}
```

请求使用 `serverUrl` 拼接 `/sessions`，`method: 'POST'` 固定创建语义，`headers` 承载内容类型以及可选认证，`body.cwd` 是服务端工作目录。`authToken` 省略时不添加 Authorization header；`dangerouslySkipPermissions` 只有严格为真时才写入 `dangerously_skip_permissions: true`，假值走服务端默认权限路径。响应通过 schema 校验后，`config.serverUrl` 保留入口地址，`sessionId` 与 `wsUrl` 分别来自 `session_id`、`ws_url`，`authToken` 供后续连接复用；`workDir` 来自可选的 `work_dir`。

连接建立后，`DirectConnectSessionManager` 通过 WebSocket 发送 SDK user message、`control_response` 和 `interrupt`，接收 assistant/result/system 以及权限请求。此时本地 REPL 仍负责展示和人工确认，但 Agent 循环运行在 direct-connect server 管理的会话中。网络断开时，本地 manager 通知 `onDisconnected`；发送消息前若 WebSocket 处于非 `OPEN` 状态，`sendMessage()` 返回 `false`。

### 六种入口到底共享了什么

现在可以把主要模式放回同一张表里：

| 模式 | 输入来源 | 会话/循环位置 | 主要适配层 | 是否进入 Agent query loop |
|---|---|---|---|---|
| 交互式 REPL | 本地键盘、终端事件 | 当前进程 | React/Ink、AppState、权限 UI | 是，REPL 直接调用 `query()` |
| print | prompt、stdin | 当前进程 | `StructuredIO`、`QueryEngine`、文本/JSON 输出 | 是 |
| Agent SDK | SDK 消息与控制消息 | Claude Code 子进程 | `StructuredIO`、`QueryEngine` | 是 |
| MCP server | MCP `ListTools` / `CallTool` | 当前 MCP server 进程 | MCP handler、`ToolUseContext` | 否，直接 `tool.call()` |
| Bridge | 远端工作队列与 session stream | Bridge 拉起的 headless 子进程 | supervisor、`RemoteIO`、SDK 协议 | 是 |
| direct-connect client | 本地 REPL + WebSocket | direct-connect server 会话 | session API、WebSocket、SDK 消息 | 本地不进入，远端进入 |

这张表也给"一套内核"划出了三个层次：最里面是 `query()` / `queryLoop()`，负责模型流、工具编排、继续推理和停止；中间是消息、Tool、权限与会话契约，既能服务完整 Agent，也能被 MCP server 单独复用；最外面才是 REPL、stdio、SDK、Bridge 和 WebSocket，决定输入输出与生命周期。共享越靠里，行为越一致；分叉越靠外，宿主差异越明显。比如 REPL 和 SDK 都会产生权限决定，但一个通过本地 UI 回答，另一个通过 `control_request` / `control_response` 回答。MCP server 也执行同一个 Tool，却不会在结果返回后再次请求模型。

### 同一任务，三种出口

把"列出项目里所有测试文件"这个最小任务分别放进 REPL、`stream-json` 和 SDK JSON 三种出口，差异立刻可见。

| 出口 | 形态 | 消息粒度 | 谁消费 |
|---|---|---|---|
| REPL | 终端界面 | 渲染级（用户输入、模型文本、工具进度逐屏更新） | 人 |
| `-p --output-format stream-json` | NDJSON 事件流 | 事件级（system init、assistant、result 逐条输出） | 脚本、程序 |
| `-p --output-format json`（SDK 聚合视图） | 单个结果对象 | 汇总级（只保留最终 result 报告） | 只读结果的一次性调用方 |

三个示例面向同一任务，内容为示意，字段形状参照 2.1.88 的 SDK 消息类型与 result 结构：

```text
// [inference] REPL 出口：终端渲染示意（React/Ink 交互式界面）
$ claude
  ✦ 正在加载会话…
  你: 列出项目里所有测试文件
  ✦ 使用 Glob 搜索 **/*.test.ts … [允许]
  ✦ 共找到 12 个测试文件：src/utils/retry.test.ts、src/services/order.test.ts …
  你: █
```

```jsonc
// [inference] stream-json 出口：NDJSON 事件流示意（需同时启用 --verbose）
{"type":"system","subtype":"init","session_id":"abc123","tools":[{"name":"Glob","description":"…"}],"model":"claude-sonnet-4-5","permissionMode":"default","commands":[],"agents":[],"skills":[],"plugins":[],"fastMode":false}
{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"共找到 12 个测试文件。"}],"stop_reason":"end_turn","usage":{"input_tokens":1820,"output_tokens":214}},"parent_tool_use_id":null,"session_id":"abc123"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":3120,"num_turns":1,"result":"共找到 12 个测试文件。","session_id":"abc123","total_cost_usd":0.0042,"usage":{"input_tokens":1820,"output_tokens":214},"permission_denials":[]}
```

```json
// [inference] SDK JSON 出口：聚合后的单个结果对象示意（--output-format json）
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 3120,
  "num_turns": 1,
  "result": "共找到 12 个测试文件。",
  "session_id": "abc123",
  "total_cost_usd": 0.0042,
  "usage": { "input_tokens": 1820, "output_tokens": 214 },
  "permission_denials": []
}
```

> 三个示例均为示意（[inference]），字段名与形状参照 2.1.88 源码中 `SDKUserMessage`、`normalizeMessage()` 与 result 终止报告的类型定义；实际值需运行验证。

三种出口背后是同一条 `query()` / `queryLoop()`：REPL 把事件渲染成界面，`stream-json` 逐条序列化成 NDJSON，`json` 只保留最终 result。输出格式决定宿主看到多少层消息，不决定 Agent 如何运行。

### 小结

Claude Code 通过宿主、会话包装、消息协议和执行循环的分层支持多种入口。交互式 REPL 直接维护 UI 与 AppState，再调用 `query()`；print 和 Agent SDK 通过 `StructuredIO` 与 `QueryEngine` 把 prompt、流式事件、权限和取消变成稳定协议；Bridge 复用这条 headless 管道，为远端 session 拉起带 `--sdk-url` 的子进程；direct-connect 把本地 REPL 变成远端会话的客户端；MCP server 只复用工具契约，直接执行 `tool.call()`。

2.1.88 的一个重要边界是：REPL 和 headless/SDK 已经共享 `query()` 与 `queryLoop()`，但尚未共享 `QueryEngine` 这个会话包装。理解这个层次，才能准确回答"共享了什么"，也能避免把入口名称误认为新的 Agent 内核。

## 源码映射

| 概念 | 路径 | 符号 | 说明 |
|---|---|---|---|
| 模式分流 | `src/main.tsx` | `hasPrintFlag`、`isNonInteractive`、`initializeEntrypoint()`、`clientType` | 控制流开关 + 宿主身份标签 |
| 交互式 REPL | `src/screens/REPL.tsx` | `getToolUseContext()`、`buildEffectiveSystemPrompt()`、`onQueryEvent()` | 从最新 store 取工具，组装后调 `query()` |
| 执行汇合点 | `src/query.ts` | `query()`、`queryLoop()`、`consumedCommandUuids` | `yield* queryLoop(...)`，结束后通知命令生命周期 |
| print / headless | `src/cli/print.ts` | `runHeadless()`、`getStructuredIO()`、`SDKUserMessage` | 规范化 prompt，选择 `StructuredIO` / `RemoteIO` |
| 会话状态壳 | `src/QueryEngine.ts` | `QueryEngine` 构造、`submitMessage()`、`ask()` | headless/SDK 会话包装（下一篇展开） |
| 权限协议 | `StructuredIO` | `control_request` / `control_response` | `--sdk-url` 时 permission prompt tool 强制 `stdio` |
| MCP 反转 | `src/entrypoints/mcp.ts` | `startMCPServer()`、`CallToolRequestSchema` handler | 直接 `tool.call()`，不进入 Agent 循环 |
| Bridge | `src/bridge/sessionRunner.ts` | worker 参数组装、`PERMISSION_MODES` | `--print --sdk-url ... --replay-user-messages` 拉起子进程 |
| direct-connect | `src/server/createDirectConnectSession.ts` | `POST /sessions`、`DirectConnectSessionManager` | 先创建 session，再经 WebSocket 连接 |

> 证据：表中函数名与关键取值均来自 2.1.88 source map 还原源码，静态可确认；`bridgeMain()` 的注册轮询与 `DirectConnectSessionManager` 的重连策略等行为细节在对应章节逐步核对。

## 设计决策

既然 REPL 与 headless 的外壳差异如此之大，为什么不干脆维护两套独立的 Agent 实现？源码里找不到官方选型记录，下面的判断来自代码结构本身，属于解释而非官方声明。

**第一，真正的复杂度在共享的循环里，不在入口。** `queryLoop()` 跨约 1489 行：模型流、工具并发、token 预算、压缩、hooks、取消与错误恢复都住在那里。入口层只是消息通道，拆成两套代码等于把最贵的部分复制两份，任何模型或预算语义的修改都要同步两遍。

**第二，宿主差异集中在边界处，适配层可以薄。** REPL 多出来的只是渲染与键盘状态，headless 多出来的只是消息序列化。两者通过 `query()` 的同一组参数（`messages`、`systemPrompt`、`canUseTool`、`toolUseContext`、`querySource`）对接内核，适配层是一层薄壳，而不是一套完整实现。

**第三，双模式允许两条路径独立演进。** `QueryEngine.ts` 的注释明确写着 `QueryEngine` 用于 headless/SDK，REPL 接入仍属于 "a future phase"——这是渐进式迁移的产物：先让脚本场景获得稳定的会话状态壳，再逐步把 REPL 搬过来；两套代码库会锁定这个决策。

**第四，单交付物让"入口数量"不等于"内核数量"。** 同一个 npm 包同时交付 REPL、`-p`、SDK、MCP server 与 Bridge，靠参数和入口文件分流。用户看到六个入口，源码里却只有一条查询链；排障时先问"谁接收输入、谁弹权限、谁运行 Agent"，比按入口名称猜是否共享内核更可靠。

**第五，也是反直觉的一点：共享不等于耦合。** 两条路径共享 `query()` / `queryLoop()`，但 `StructuredIO`、`QueryEngine` 与 REPL 的状态管理互不引用。共享的是执行语义，保留的是宿主差异——"一套内核"的正确读法是分层复用，而不是单体合并。

## 练习（15-25 分钟）

在任意项目目录里，用同一个任务分别走 REPL 与 headless 两条路径，比较两者的差异：

```bash
# [runtime] 练习命令：本地实际运行观察输出差异
# 路径一：交互式 REPL
claude

# 路径二：headless + stream-json
claude -p "列出项目里所有测试文件" --output-format stream-json --verbose
```

1. 在 REPL 里先执行一次只读任务，再执行一次需要权限确认的任务（比如写文件），观察权限弹窗的出现与选择流程。
2. 用 `claude -p` 执行同样两个任务，观察：权限确认如何从弹窗变成规则决策或 `control_request` / `control_response`；`stream-json` 输出了哪些事件类型（`system`、`assistant`、`result`）。
3. 再加 `--output-format json` 跑一次，比较聚合结果对象与事件流的信息差异：哪些字段被保留（`num_turns`、`permission_denials`、`usage`），哪些中间事件被丢弃。
4. 把 stdout 接入管道执行 `claude "列出测试文件" | cat`，验证 `isNonInteractive` 的 TTY 判断——即使不带 `-p`，非 TTY 输出也会让进程走非交互路径。

对照正文的"两个判别问题"，回答：这几次运行里，输入与权限分别来自哪里，Agent 循环运行在哪个进程？

## 自测

1. `isNonInteractive` 与 `clientType` 的区别是什么？
2. `claude -p --sdk-url ...` 时，权限确认为什么不会弹窗？
3. MCP server 入口为什么不进入 `queryLoop()`？

<details>
<summary>参考答案</summary>

1. **`isNonInteractive` 是控制流判断**：`-p` / `--print`、`--init-only`、任意 `--sdk-url` 参数或 stdout 非 TTY 都会置为 `true`，决定进程挂不挂 REPL、走不走 `runHeadless()`。**`clientType` 是宿主身份标签**：从 `GITHUB_ACTIONS`、`CLAUDE_CODE_ENTRYPOINT` 和 session-ingress token 推导出 `github-action`、`sdk-typescript`、`remote`、`cli` 等取值，用于遥测与行为选择。一个是开关，一个是身份，不要混读。

2. **权限判断没有取消，只是交互入口被替换**。`--sdk-url` 时源码把有效的 permission prompt tool 强制设为 `stdio`：待确认动作写成 `control_request`，宿主返回 `control_response` 后工具调用才继续；`ask` 类动作不会自动放行。输入流提前关闭时，所有等待中的请求以 `Tool permission stream closed before response received` 失败；要稳定运行，调用方需预先通过 `--allowedTools`、`--disallowedTools`、`--permission-mode` 或 settings 明确权限边界。

3. **因为 MCP server 是工具服务入口，不是会话入口**。`CallToolRequestSchema` handler 直接执行 `findToolByName()` → `tool.call()`，一次调用一个工具，没有消息历史、没有模型推理、没有下一轮决策——那些职责由调用 MCP server 的外部 Agent 承担。2.1.88 中该路径的 `thinkingConfig` 固定为 `{ type: 'disabled' }`，`mcpClients` 与 Agent 定义为空集合，也印证了这一点。

</details>

## 回顾：上一篇的问题

<details>
<summary>带 `-p` 与不带 `-p`，只是输出形式不同，还是运行模式已经变了；无法停下来交互时，工具权限由谁决定？</summary>

**运行模式变了，权限的交互入口跟着变：本地弹窗改由配置规则或外部协议承担。** `main()` 把 `-p` / `--print` 识别为 `hasPrintFlag`，进程标记为 non-interactive：不挂载 Ink REPL，进入 `runHeadless()`，workspace trust 对话框也被跳过（`-p` 的 help 文本明确提醒只在你信任的目录中使用）。但权限判断没有取消，仍走 `hasPermissionsToUseTool()` 检查 deny/ask/allow 规则、工具自身约束和 permission mode；`ask` 类动作在无头模式下不弹窗，也不会因为用了 `-p` 就自动放行。

权限有三种替代出口：规则与 permission mode 直接决策（脚本需预先通过 `--allowedTools`、`--disallowedTools`、`--permission-mode` 或 settings 明确边界）；`--permission-prompt-tool` 把请求交给指定的 MCP tool，由外部逻辑返回 allow/deny；`--sdk-url` 时强制 permission prompt tool 为 `stdio`，用 `control_request` / `control_response` 闭环，输入流提前关闭则报 `Tool permission stream closed before response received`。

换掉的只是外层 Host（REPL ↔ `StructuredIO` / `QueryEngine`），内层能力完全复用：两条路径最终都进入 `query()` / `queryLoop()`，使用相同的模型流、工具契约、权限结果和 `tool_result` 回环。

</details>

## 留给下一篇的问题

当我们要把 Claude Code 接进自己的程序时，通常有两个入口。

第一个是直接启动 `claude -p` 子进程，通过命令行参数或 stdin 提交任务，再从 stdout 读取文本、JSON 或 `stream-json`。第二个是使用 Claude Agent SDK，用语言层 API 接收结构化消息、维持会话，并处理权限、中断等控制事件。从 Claude Code 内部看，它们最终都可能落到 headless、`StructuredIO` 和 `QueryEngine` 这条路径，但调用方承担的协议细节并不相同。

那么，当你的代码需要结合 Claude Code 时，到底应该选择 `claude -p`，还是 Claude Agent SDK；分别在什么场景下使用它们？
