---
title: "Claude Code源码解读04：一套内核如何支持多种入口"
published: 2026-07-21T11:01:53+08:00
description: "比较交互式 REPL、print、Agent SDK、MCP、Bridge 与 direct-connect，解释不同宿主如何复用 Claude Code 的执行内核。"
tags: ["claude-code", "source-code", "ai-agent", "runtime"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-04/claude-code-source-reading-00.png"
imagePosition: "left"
---


## 回答上一篇的问题

上一篇最后留下的问题来自一个很具体的命令：`claude -p`。当它无法像普通 REPL 一样停下来与用户交互时，工具权限由谁决定；而对 Claude Code 来说，带 `-p` 与不带 `-p`，究竟只是输出形式不同，还是运行模式已经变了？

答案先说：**运行模式已经变了，权限没有消失，只是失去了本地弹窗这个决策入口。**

`-p` 是 `--print` 的短写。最简单的用法是 `claude -p "解释这个项目"`，也可以通过 stdin 接收输入。普通单 prompt 用法会执行任务、输出结果并退出，适合 Shell 管道、脚本和 CI；SDK 还可以在 `stream-json` 输入模式下持续提供消息。`--output-format` 支持 `text`、`json` 和 `stream-json`：`text` 是默认的最终文本，`json` 输出聚合后的结果对象，`stream-json` 持续输出结构化事件，并要求同时启用 `--verbose`。

源码在 `main()` 中把 `-p` 或 `--print` 识别为 `hasPrintFlag`，再把整个进程标记成 non-interactive。后面的主路径不会创建 Ink root，也不会挂载 React REPL，而是进入 `runHeadless()`。workspace trust 对话框也会被跳过，所以命令帮助明确提醒：只在你信任的目录中使用 `-p`。

权限处理要分三种情况看。

第一种是普通的 `claude -p`。它仍然调用与交互模式相同的 `hasPermissionsToUseTool()`，继续检查 deny、ask、allow 规则、工具自身约束和 permission mode。已经被规则或模式允许的调用可以执行，明确禁止的调用仍会被拒绝；需要 `ask` 的动作则无法再弹出本地 React 对话框，也不会因为使用了 `-p` 就自动获得授权。要让脚本稳定运行，调用方需要预先通过 `--allowedTools`、`--disallowedTools`、`--permission-mode` 或 settings 明确权限边界。

第二种是提供 `--permission-prompt-tool`。这时 Claude Code 会把权限请求交给指定的 MCP tool，由外部逻辑返回 allow 或 deny。权限决定仍然存在，只是“询问用户”被替换成了“调用另一个工具”。

第三种是 Agent SDK 或带 `--sdk-url` 的 headless 模式。源码会把 permission prompt tool 强制设为 `stdio`，把待确认动作写成 `control_request`；外部宿主返回 `control_response` 后，工具调用才继续。如果输入流在响应到达前关闭，所有仍在等待的权限请求都会以 `Tool permission stream closed before response received` 失败。

因此，`-p` 与普通 Claude Code 的区别可以归纳成两层。

外层 Host 不同。普通模式由 React/Ink REPL 管理键盘、消息列表、权限弹窗、取消和下一轮输入；`-p` 使用 `StructuredIO` 与 `QueryEngine` 管理输入输出和会话，得到结果后结束进程。源码甚至要在 headless 中直接订阅 settings change，因为这里根本没有 React tree 可以运行对应 hook。

内层 Agent 能力仍然复用。两条路径最终都会进入 `query()` / `queryLoop()`，使用相同的模型流、工具契约、权限结果和 `tool_result` 回环。`-p` 没有把 Claude Code 变成一个更弱的“文本生成命令”，它只是把负责交互的人从本地 REPL 换成了命令行参数、stdin、配置规则或外部 SDK 宿主。

这点很容易读错。`QueryEngine.ts` 的注释明确说，2.1.88 里的 `QueryEngine` 用于 headless/SDK，REPL 接入仍属于 “a future phase”。所以“一套内核”应该理解成**分层复用**：宿主层可以分叉，会话包装也可能不同，但进入 Agent 查询循环以后，模型、工具和消息语义重新汇合。

本篇继续只讨论 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码。下面的片段省略了与当前机制无关的参数和分支，函数名、关键取值与调用关系保持不变。

## 先把运行模式拆成两个问题

我们可以先用两个问题判断一种运行模式：

1. 输入和权限决定从哪里来？可能来自本地键盘、stdin、SDK 控制消息、WebSocket，或者 MCP 请求。
2. Agent 循环在哪里运行？可能就在当前进程，也可能在 Bridge 拉起的子进程或远端 server；MCP server 则根本不运行它。

这样一来，CLI、SDK、Bridge 和 direct-connect 就不再是一排互不相关的产品名，而是几种不同的宿主与传输组合。

![Claude Code 多入口与共享内核手绘图](/images/posts/claude-code-source-reading-04/04-runtime-modes-handdrawn.png)

图中最下面的 `query() → queryLoop()` 才是主要汇合点。REPL 直接进入 `query()`；print/SDK 先经过 `StructuredIO` 和 `QueryEngine`；Bridge 会拉起带 `--sdk-url` 的 headless 子进程；MCP 的 `CallTool` 则沿旁路直接进入 `tool.call()`。

## main 先识别宿主，不急着决定业务逻辑

上一篇已经看到，`restored-src/src/main.tsx` 会在完整初始化前识别非交互模式。现在再看这段判断的用途：它不是简单地区分“有没有 UI”，而是在给后面的配置、遥测、权限和输入输出选择宿主语义。

```ts
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

这里有两组容易混淆的状态。

`isNonInteractive` 是控制流判断。`-p`、`--print`、`--init-only`、任意 `--sdk-url...` 参数，或者 stdout 不是 TTY，都会让它变成 `true`。没有命中这些条件时才是交互模式。也就是说，即使用户没有显式传 `--print`，把输出接入管道也可能让进程走非交互路径。

`clientType` 则是宿主身份标签。源码能够确认的值包括 `github-action`、`sdk-typescript`、`sdk-python`、`sdk-cli`、`claude-vscode`、`local-agent`、`claude-desktop`、`remote` 和回退值 `cli`。它们主要来自环境变量和 session-ingress token，不能反过来理解成九套 Agent 实现。

因此，运行模式的第一层复用发生在 `main.tsx`：同一个 Commander 参数解析、项目 setup 和能力装配流程，根据宿主标签选择后面的出口。

## REPL 直接持有交互状态，再进入 query

交互式模式最后挂载 `REPL.tsx`。它需要维护输入框、消息列表、终端焦点、权限弹窗、取消状态和首屏渲染，因此不能只把一行 prompt 交给一个无状态函数。

当用户提交消息时，REPL 会从当前 store 重新取得工具和 MCP clients，组装 system prompt、user context 与 `ToolUseContext`，然后直接调用 `query()`：

```ts
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

这里的“重新取得”很重要。MCP 连接可能在 REPL 首次渲染后才完成，如果一直使用 React 闭包里较早捕获的工具列表，第一轮请求就可能看不到刚刚连上的能力。源码因此让 `getToolUseContext()` 从最新 store 计算工具，再把结果交给 `query()`。

权限也是同样的道理。REPL 传入的 `canUseTool` 可以触发本地确认界面，用户的选择再回到正在等待的工具调用。终端渲染只是宿主能力；真正的工具选择、`tool_use`、`tool_result` 和继续推理仍由下面的查询链处理。

`restored-src/src/query.ts` 对这个汇合点的定义非常直接：

```ts
export async function* query(params: QueryParams) {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)

  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

也就是说，REPL 的特殊之处主要在 `query()` 之前如何维护状态，以及拿到事件以后如何渲染。`queryLoop()` 并不知道终端里有没有输入框。

## print 与 Agent SDK 共用一条 headless 管道

非交互路径在 `main.tsx` 中创建 headless store，准备命令、工具、Agent 和 MCP 配置，然后调用 `restored-src/src/cli/print.ts` 的 `runHeadless()`。

这里的 print 不能只理解成“打印最终文本”。CLI 暴露了两组明确的格式取值：

- `--input-format` 可以是 `text` 或 `stream-json`，默认是 `text`。
- `--output-format` 可以是 `text`、`json` 或 `stream-json`，默认是 `text`。`json` 聚合单次结果，`stream-json` 持续输出实时消息。

源码还限制 `stream-json` 输出必须同时启用 `--verbose`。`--include-partial-messages` 只有在 print + `stream-json` 下才有意义；`--replay-user-messages` 则要求输入和输出都采用 `stream-json`。这些值不是显示样式偏好，而是在决定宿主能看到哪一层消息。

`runHeadless()` 会先把普通字符串规范化成 SDK user message。如果传入的是异步输入流，就保留它的流式形态。接下来由 `getStructuredIO()` 决定使用本地 stdio 还是远程传输：

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

`sdkUrl` 为 `undefined` 时使用 `StructuredIO`，从 NDJSON/stdin 读取消息，并向 stdout 写出 SDK 消息和控制消息。提供 URL 时改用继承自它的 `RemoteIO`，后者根据 URL 和运行时开关选择 WebSocket，或者 SSE + HTTP POST。静态源码能够确认传输选择条件，不能证明某个远程端点一定可达。

真正处理会话的是 `QueryEngine`：

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
  // 省略其他与本段结论无关的配置字段
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

`QueryEngine.ts` 的原始注释说明，一个实例对应一段 conversation，多次 `submitMessage()` 会在同一实例中保留消息、文件缓存和 usage；它最终仍然调用与 REPL 相同的 `query()`。上面的 `ask()` 摘录还展示了 read-file cache 的边界：构造时克隆进 engine，无论请求正常结束还是抛错，`finally` 都会把最新状态写回宿主。

因此，Agent SDK 在 2.1.88 中不是另一套 Agent 内核。TypeScript、Python 或 CLI 宿主通过 `CLAUDE_CODE_ENTRYPOINT` 标记身份，再使用 headless 的结构化输入输出协议控制同一个子进程。SDK 可以发送用户消息、中断和权限响应，也可以接收 assistant、result、system、`control_request` 等事件，但模型与工具循环仍在 Claude Code 进程内部。

## 没有本地弹窗以后，权限必须变成协议

交互式 REPL 可以暂停渲染并展示确认框，headless 进程却不能假定有人盯着终端。`runHeadless()` 因此把权限处理也适配成输入输出协议。

当提供 `--sdk-url` 时，源码会把有效的 permission prompt tool 强制设为 `stdio`。工具需要确认时，`StructuredIO` 写出 `control_request`；宿主返回 `control_response` 后，等待中的调用才继续。输入流提前关闭时，仍未完成的请求会被拒绝，错误信息是 `Tool permission stream closed before response received`。

这里也说明了为什么“非交互”不等于“自动允许”。源码支持预先配置 allowed/denied rules，也支持 `--permission-prompt-tool` 或 SDK 控制消息把决定交给外部宿主。具体调用最终是 allow、ask 还是 deny，取决于权限模式、规则、hook、工具和宿主响应，不能仅凭 `--print` 推断。

取消也从按键动作变成了消息。REPL 的 Ctrl+C 可以直接操作本地 abort controller；SDK 和远程宿主则发送 `interrupt` 控制请求，再由 headless 进程中止当前 turn。宿主不同，取消语义仍需要落回同一条会话状态链。

## MCP server 复用的是工具，不是 Agent 循环

MCP server 是最容易被“多入口共享内核”这句话误导的一种模式。

`restored-src/src/entrypoints/mcp.ts` 的 `startMCPServer()` 通过 stdio 启动 MCP Server，注册 `ListToolsRequestSchema` 与 `CallToolRequestSchema`。收到工具调用后，它查找工具、检查是否启用、校验输入，然后直接执行 `tool.call()`：

```ts
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

`arguments` 缺失或为 `null` 时回退为空对象；`validateInput` 本身是可选函数，不存在就跳过这一步。工具仍会经过 `isEnabled()`、自己的校验和权限回调，但这条调用链里没有 `QueryEngine`，也没有 `queryLoop()`。

所以 MCP server 的角色发生了反转。平时 Claude Code 是 MCP client，从外部服务器取得工具；进入这个入口后，它变成 MCP server，把自己的基础工具交给另一个 Agent 或宿主调用。它复用了 Tool 接口、Schema、文件状态和权限能力，却没有复用“Claude 选择工具并继续推理”这部分内核。

源码中还有两条明确的限制：当前 handler 尚未重新暴露外部 MCP tools；`ToolUseContext` 中的 `thinkingConfig` 固定为 `{ type: 'disabled' }`，`mcpClients` 和 Agent 定义也是空集合。这进一步证明它是一条单工具服务路径，不是隐藏的完整 Claude Code 会话。

## Bridge 不是把 REPL 搬上网，而是拉起 headless worker

接下来把进程边界也加进来。

`claude remote-control` 在 CLI fast path 中进入 `bridgeMain()`。它检查登录、功能开关、最低版本、组织策略和目录信任，然后注册 Bridge environment，轮询远端工作。收到 session 后，`restored-src/src/bridge/sessionRunner.ts` 会拉起一个新的 Claude Code 子进程：

```ts
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

这段参数几乎把 Bridge 的复用方式写在了明面上：Bridge supervisor 不重新实现 Agent 循环，而是把每个 session 变成一个 headless/SDK 子进程。`--sdk-url` 让 `StructuredIO` 切到 `RemoteIO`，两端用 `stream-json` 交换用户消息、模型事件、权限请求和中断。

`permissionMode` 为 `undefined` 时不传这个参数，由子进程继续使用自己的默认和配置回退；有值时，`bridgeMain()` 会先用 `PERMISSION_MODES` 校验，静态源码能够确认候选集合来自这个常量，但本篇不提前展开各模式含义，权限优先级会在第 12 篇专门分析。

Bridge 的外层职责因此是注册、轮询、容量、子进程生命周期、token 刷新和重连。某个 session 真正开始工作以后，模型与工具仍在被拉起的 headless Claude Code 中运行。

失败边界也分成两层。Bridge 注册失败、工作区未信任、HTTP 非本机地址或认证缺失，会让 supervisor 无法接单；子进程里的模型错误、工具错误、权限拒绝和取消，则沿 SDK 消息回到远端。静态源码可以确认这些分层，不能推导真实部署的成功率、延迟或默认容量。

## direct-connect 把“创建会话”和“连接会话”分开

direct-connect 与 Bridge 都使用网络，但方向不同。

Bridge 是本机主动注册为可接收工作的 environment，再为远端 session 拉起 worker。direct-connect 则是本地 CLI 主动连接一个已经存在的 server：先请求创建 session，再通过返回的 WebSocket 地址进入它。

`restored-src/src/server/createDirectConnectSession.ts` 的契约很短：

```ts
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

`serverUrl` 和 `cwd` 是必填开放字符串；`authToken` 缺失时不会添加 Authorization header；`dangerouslySkipPermissions` 只有严格为真时才把 `dangerously_skip_permissions: true` 放进请求体，`false` 或 `undefined` 都会省略这个字段。响应必须通过 schema 校验，至少把 `session_id`、`ws_url` 转成客户端配置，`work_dir` 则可以不存在。

连接建立后，`DirectConnectSessionManager` 通过 WebSocket 发送 SDK user message、`control_response` 和 `interrupt`，接收 assistant/result/system 以及权限请求。此时本地 REPL 仍然负责展示和人工确认，但 Agent 循环运行在 direct-connect server 管理的会话中。

因此，direct-connect 复用的是 SDK 消息边界，而不是把远端工具假装成本地函数。网络断开时，本地 manager 会通知 `onDisconnected`；发送消息前若 WebSocket 不是 `OPEN`，`sendMessage()` 返回 `false`。源码没有显示这里自动补发用户消息，所以不能把“存在重连能力”进一步推断成“所有中断消息都不会丢失”。

## 六种入口到底共享了什么

现在可以把主要模式放回同一张表里：

| 模式 | 输入来源 | 会话/循环位置 | 主要适配层 | 是否进入 Agent query loop |
|---|---|---|---|---|
| 交互式 REPL | 本地键盘、终端事件 | 当前进程 | React/Ink、AppState、权限 UI | 是，REPL 直接调用 `query()` |
| print | prompt、stdin | 当前进程 | `StructuredIO`、`QueryEngine`、文本/JSON 输出 | 是 |
| Agent SDK | SDK 消息与控制消息 | Claude Code 子进程 | `StructuredIO`、`QueryEngine` | 是 |
| MCP server | MCP `ListTools` / `CallTool` | 当前 MCP server 进程 | MCP handler、`ToolUseContext` | 否，直接 `tool.call()` |
| Bridge | 远端工作队列与 session stream | Bridge 拉起的 headless 子进程 | supervisor、`RemoteIO`、SDK 协议 | 是 |
| direct-connect client | 本地 REPL + WebSocket | direct-connect server 会话 | session API、WebSocket、SDK 消息 | 本地不进入，远端进入 |

这张表也给“一套内核”划出了三个层次。

最里面是 `query()` / `queryLoop()`，负责模型流、工具编排、继续推理和停止。中间是消息、Tool、权限与会话契约，它们既能服务完整 Agent，也能被 MCP server 单独复用。最外面才是 REPL、stdio、SDK、Bridge 和 WebSocket，它们决定输入输出与生命周期。

共享越靠里，行为越一致；分叉越靠外，宿主差异越明显。比如 REPL 和 SDK 都会产生权限决定，但一个通过本地 UI 回答，另一个通过 `control_request` / `control_response` 回答。MCP server 也执行同一个 Tool，却不会在结果返回后再次请求模型。

## 静态源码还能证明到哪里

本篇可以从源码直接确认入口条件、参数候选值、调用方向、消息类型和传输分支，也可以根据调用图确认 REPL 与 QueryEngine 最终都会进入 `query()`，MCP server 则旁路到 `tool.call()`。

“Claude Code 通过宿主适配层复用执行内核”属于调用关系支撑的架构解释。它不意味着所有模式功能完全对齐，也不意味着每个 feature flag 在生产环境都开启。

至于某种传输在真实网络中的延迟、Bridge 的线上容量、WebSocket 重连成功率、某个 SDK 版本默认传入什么环境变量，单靠 2.1.88 静态源码无法确认。运行时配置、服务端实现和生产数据没有包含在 source map 中。

## 小结

Claude Code 支持多种入口，靠的不是复制多套 Agent，而是把宿主、会话包装、消息协议和执行循环分层。

交互式 REPL 直接维护 UI 与 AppState，再调用 `query()`；print 和 Agent SDK 通过 `StructuredIO` 与 `QueryEngine` 把 prompt、流式事件、权限和取消变成稳定协议；Bridge 复用这条 headless 管道，为远端 session 拉起子进程；direct-connect 把本地 REPL 变成远端会话的客户端；MCP server 只复用工具契约，直接执行 `tool.call()`。

2.1.88 的一个重要边界是：REPL 和 headless/SDK 已经共享 `query()` 与 `queryLoop()`，但尚未共享 `QueryEngine` 这个会话包装。理解这个层次，才能准确回答“共享了什么”，也能避免把入口名称误认为新的 Agent 内核。

## 留给下一篇的问题

当我们要把 Claude Code 接进自己的程序时，通常有两个入口。

第一个是直接启动 `claude -p` 子进程，通过命令行参数或 stdin 提交任务，再从 stdout 读取文本、JSON 或 `stream-json`。第二个是使用 Claude Agent SDK，用语言层 API 接收结构化消息、维持会话，并处理权限、中断等控制事件。从 Claude Code 内部看，它们最终都可能落到 headless、`StructuredIO` 和 `QueryEngine` 这条路径，但调用方承担的协议细节并不相同。

那么，当你的代码需要结合 Claude Code 时，到底应该选择 `claude -p`，还是 Claude Agent SDK；分别在什么场景下使用它们？

