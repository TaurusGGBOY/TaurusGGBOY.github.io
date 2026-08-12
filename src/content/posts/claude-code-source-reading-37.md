---
title: "Claude Code源码解读37：Bridge、Remote Control 与 Server 如何协作"
published: 2026-07-24T16:47:24+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-37/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇留下的问题是，**为什么 Claude Code 要区分不同的 provider？**

先抓住一次请求的第一处分叉，`provider` 决定请求发往哪个 API、用哪套身份签名、模型别名落成什么 ID，以及哪些能力参数有资格进入 body。它不是同一个 API 的别名；把四条前门抹平，最先暴露的通常是凭证、部署名或 beta 参数错位。

## 介绍本章的一些概念

- 远程能力是 **"本地执行，服务端协调，远端控制"**，`runBridgeHeadless()` 或 `initBridgeCore()` 把本地机器注册成 environment，poll/ACK/heartbeat 维持 worker 所有权；模型请求由本地进程按当前 provider 发出，`Read`、`Bash`、MCP 和权限检查留在本地，服务器只有 protocol 边界，不获得本地文件执行权。
- 主链路是两条方向相反的数据流，`Remote client -> session service -> ReplBridge -> query loop` 与 `query loop -> ReplBridge -> session service -> Remote client`；消息事件与控制事件共享 `sessionId`，但**控制面与数据面是不同协议类型**（`control_request` / `control_response` / `control_cancel_request`）。
- transport 层**入站和出站不必使用同一种连接**，CCR v2 用 `SSETransport` 接收入站事件，用 `CCRClient` 的 HTTP POST 写出站事件；`epoch` 裁决 worker 所有权（新 worker 注册推进 epoch，旧实例收到不匹配响应抛出 `epoch superseded`），消息排序由 sequence high-water mark 负责。
- 消息可靠性由**四重机制**构成，初始 flush gate（历史/实时交错）、`recentPostedUUIDs` 去重（回声/重复写入）、SSE sequence high-water mark（重连重放范围）、`recentInboundUUIDs` 有界集合（入站防御性兜底）。源码提供有限重试与租约状态，不提供跨任意网络故障的 exactly-once 证明。
- 断线重连是**两层状态机、两个恢复目标**，观看端 `SessionsWebSocket` 恢复订阅（普通重连 2s/最多 5 次，`4001` 单独 3 次线性等待，`4003` 永久关闭）；本地 Bridge 恢复 worker 所有权（environment 重建上限 3 次，promise guard 合并并发重连）。

> ⚠️ **证据边界**，本文所有代码来自 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` source map 还原源码。`restored-src/` 只用于定位证据，不等同于 Anthropic 内部仓库原始目录；代码块只保留证明控制流所需的字段，`// ...` 表示省略埋点、UI 消息与无关分支。

## 本篇新增机制

36 解释了模型请求如何按 provider 发出。本篇回答执行环境的问题，**当用户不在笔记本前，怎样让同一会话继续跑？** 答案是 Bridge、Remote Control 与 Server 的三方协作，执行端（本地）、会话服务（远端协调）、控制端（浏览器/手机）。这套“远程”方案把一次单机交互拆成可认证、可路由、可恢复的分布式协议。读懂这篇，就能回答"服务器到底做什么、不做什么"。它是 38（可观测性）的必备前提，远程请求的日志、事件与成本仍发生在执行端。

## 问题现场

浏览器里输入一句 prompt，并不意味着浏览器拿到了本地 shell。若让浏览器直连本地 query loop，就要自行解决端口暴露、身份认证、session 路由、断线重连、重复投递、多个远端设备同时观看和权限请求回传。若把控制消息和普通对话文本混在一个通道里，权限弹窗的取消与消息回显会互相干扰。

![Remote Control 的会话关联与双层重连](/images/posts/claude-code-source-reading-37/37-remote-session-affinity-detail-handdrawn.png)

本文先建立三个概念，**Session affinity**（远程消息先关联到具体本地会话，才能保持上下文、工具和工作目录一致）、**双工传输**（控制端与执行端各自发送事件，入站和出站可以采用不同连接策略）、**重连状态**（传输恢复与 Agent 会话恢复是两层目标，序号、去重和确认点负责衔接）。先把"谁执行""谁路由""谁控制"分开，再看 `poll`、`ACK`、heartbeat 和 sequence 如何把这三者重新连起来。

## 正文

### 这张金额单位工单从办公室 CLI 续到远端设备

下午 17，20，工程师准备离开办公室，完整测试还剩最后一组浏览器用例，三个 teammate 也各自留下了未读消息。他没有把笔记本上的终端窗口当成唯一入口，而是在手机浏览器打开 Remote Control，确认显示的是同一个 session 后输入，

> 继续处理这张金额单位工单。先恢复当前 worktree、后台测试、teammate 状态和待决权限，再完成验证；不要重新执行已经成功的副作用。

本地执行端仍持有工作区、工具和 Query Loop；控制端只发送输入并接收事件。中间的 Bridge 或会话服务负责认证、连接关系和消息转发，不因此获得本地文件的直接执行权。手机上看到测试完成，只代表执行端回传了事件；真正的文件读取、Bash 和权限询问仍发生在办公室那台机器上。

### 先建立一个简单模型｜执行端、会话服务、控制端

本地执行端拥有工作目录和进程权限。`Read` 读的是本地文件，`Bash` 启动的是本地进程，query loop 也运行在这里。会话服务负责把事件按 `sessionId` 关联，并在 environment 与 session 之间调度 work。远端控制端主要负责输入、展示和确认，它不因为能看到会话就自动获得本地工具执行权。

可以把主链路压缩成两条方向相反的数据流，

```text
远端输入：Remote client -> session service -> ReplBridge -> query loop
本地输出：query loop -> ReplBridge -> session service -> Remote client
```

第一条把 prompt、interrupt 和权限响应送到本地；第二条把 assistant、tool、result 以及权限请求送到远端。两条流共享 `sessionId`，但消息事件和控制事件仍是不同协议类型。

为什么不让浏览器直接连本地 query loop？因为浏览器不知道本地 `cwd`，也不应该直接持有进程句柄。中间加上 session service 后，执行环境可以短暂断线、重新注册，远端也只需订阅稳定的 session 身份。

### Bridge 如何把本地机器注册成可工作的 environment

独立的 Remote Control 入口最终会走到 `runBridgeHeadless()`。它先切换工作目录、启用配置与日志 sink，再检查 workspace trust 和登录状态；随后注册 environment，创建 session spawner，进入持久化的 work loop。

```ts
export async function runBridgeHeadless(
  opts: HeadlessBridgeOpts,
  signal: AbortSignal,
): Promise<void> {
  const { dir } = opts
  process.chdir(dir)

  if (!checkHasTrustDialogAccepted()) {
    throw new BridgeHeadlessPermanentError(
      `Workspace not trusted: ${dir}. Run \`claude\` in that directory first to accept the trust dialog.`,
    )
  }
  if (!opts.getAccessToken()) {
    throw new Error(BRIDGE_LOGIN_ERROR)
  }

  // ...省略 URL、git 信息与 BridgeConfig 组装
  const reg = await api.registerBridgeEnvironment(config)
  const spawner = createSessionSpawner({
    execPath: process.execPath,
    scriptArgs: spawnScriptArgs(),
    env: process.env,
    verbose: false,
    sandbox: opts.sandbox,
    permissionMode: opts.permissionMode,
    onDebug: log,
  })

  // ...省略 logger 与可选的初始 session 创建
  await runBridgeLoop(
    config,
    reg.environment_id,
    reg.environment_secret,
    api,
    spawner,
    logger,
    signal,
  )
}
```

> 证据，`restored-src/src/bridge/bridgeMain.ts`（2.1.88 source map 还原源码），`runBridgeHeadless()`。

`runBridgeHeadless(opts, signal)` 是无 UI bridge 的入口。`opts.dir` 是执行目录；`opts.getAccessToken()` 返回当前访问令牌，空值会终止注册；`opts.permissionMode` 原样传给子会话运行时；`opts.sandbox` 是布尔值，决定 spawner 是否启用对应沙箱配置。`signal` 是 `AbortSignal`，用于让外部 supervisor 终止长期循环。

注册与启动字段分成两组，`reg.environment_id` 标识后续 work loop 轮询的 environment，`reg.environment_secret` 证明 worker 所有权；spawner 的 `execPath` 指向当前可执行文件，`scriptArgs` 提供子进程参数，`env` 继承当前环境，`verbose: false` 关闭子进程详细输出，`onDebug: log` 把调试信息送回 bridge logger。`runBridgeLoop()` 再同时接收 `config`、两个注册凭据、`api`、`spawner`、`logger` 与 `signal`，分别负责容量策略、认证、服务请求、会话启动、诊断和取消。

`HeadlessBridgeOpts.spawnMode` 的源码可选值是三种，`single-session` 表示一个目录承载一个会话并在结束时退出；`worktree` 表示为多个会话创建隔离 worktree；`same-dir` 表示多个会话共享目录，因此也明确存在互相覆盖的风险。`sessionTimeoutMs` 可以不传，类型文件中的默认会话超时是 24 小时。

这里有一个很重要的顺序，workspace trust 在网络注册之前检查。即使远端可达且用户已经登录，当前目录仍要单独通过 trust dialog；拒绝或缺失信任会让 headless bridge 以永久错误退出。`runBridgeLoop()` 是 environment 的"值班室"，它持续轮询 work，领取后 ACK，启动或连接 session，并通过 heartbeat 延长租约。`BridgeConfig.maxSessions` 决定容量；`spawnMode` 决定工作目录策略；`environmentSecret` 证明当前 worker 对 environment 的控制权；session ingress token 则授权具体 session 的事件与心跳请求。

### ReplBridge 在 WebSocket 之上维护会话协议

交互式 REPL 内部使用的是 `initBridgeCore()`。源码注释把它概括成，environment registration → session creation → poll loop → ingress transport → teardown。这个函数不自己读取 bootstrap state，所有上下文都从 `BridgeCoreParams` 注入，因此同一核心也能被 daemon 调用。

```ts
export async function initBridgeCore(
  params: BridgeCoreParams,
): Promise<BridgeCoreHandle | null> {
  const {
    dir,
    title,
    gitRepoUrl,
    branch,
    getAccessToken,
    createSession,
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    perpetual,
    initialSSESequenceNum = 0,
  } = params

  // ...省略 bridge API 和 BridgeConfig 的组装
  const reg = await api.registerBridgeEnvironment(bridgeConfig)
  let currentSessionId: string
  const createdSessionId = await createSession({
    environmentId: reg.environment_id,
    title,
    gitRepoUrl,
    branch,
    signal: AbortSignal.timeout(15_000),
  })
  if (!createdSessionId) return null
  currentSessionId = createdSessionId
  // 后续启动 poll loop，并在 work 到达后建立 transport
}
```

> 证据，`restored-src/src/bridge/replBridge.ts`（2.1.88 source map 还原源码），`initBridgeCore()`。

`initBridgeCore(params)` 位于 `restored-src/src/bridge/replBridge.ts`。`dir` 是本地工作目录；`title` 是会话初始标题；`getAccessToken` 是按需取 token 的函数；`createSession` 由调用方注入，返回 session id，失败时核心返回 `null`。调用它时，`environmentId` 取刚注册得到的 `reg.environment_id`，把新 session 绑定到当前 bridge environment；`signal` 固定为 15 秒超时，只约束这次建会话请求。`onInboundMessage` 接收远端输入；`onPermissionResponse` 接收远端权限结果；`onInterrupt` 处理反向中断。

几个可选参数会直接改变控制流，`perpetual` 为真时会尝试读取 bridge pointer 并复用之前的 environment/session；缺省或为假时，正常 teardown 会清理 pointer。`initialSSESequenceNum` 缺省为 `0`；只有确实复用旧 session 时，源码才会沿用这个高水位，创建新 session 时仍从 `0` 开始，避免把旧 session 的序号错误套到新流上。

`BridgeCoreHandle` 同时暴露 `writeMessages()`、`sendControlRequest()`、`sendControlResponse()`、`sendControlCancelRequest()`、`sendResult()` 和 `teardown()`，协议面覆盖聊天文本、控制请求、终态和连接生命周期。

### transport｜入站和出站甚至不必使用同一种连接

远程链路最容易被画错成"一条 WebSocket"。CCR v2 的 `createV2ReplTransport()` 用 `SSETransport` 接收入站事件，用 `CCRClient` 的 HTTP POST 写出站事件；连接方向和认证材料由服务端下发的 work secret 决定。

```ts
export async function createV2ReplTransport(opts: {
  sessionUrl: string
  ingressToken: string
  sessionId: string
  initialSequenceNum?: number
  epoch?: number
  heartbeatIntervalMs?: number
  heartbeatJitterFraction?: number
  outboundOnly?: boolean
  getAuthToken?: () => string | undefined
}): Promise<ReplBridgeTransport> {
  const {
    sessionUrl,
    ingressToken,
    sessionId,
    initialSequenceNum,
    getAuthToken,
  } = opts

  // ...省略 getAuthHeaders 的选择
  const epoch = opts.epoch ??
    (await registerWorker(sessionUrl, ingressToken))

  const sse = new SSETransport(
    sseUrl,
    {},
    sessionId,
    undefined,
    initialSequenceNum,
    getAuthHeaders,
  )
  const ccr = new CCRClient(sse, new URL(sessionUrl), {
    getAuthHeaders,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    heartbeatJitterFraction: opts.heartbeatJitterFraction,
    onEpochMismatch: () => {
      // ...省略关闭资源与日志
      throw new Error('epoch superseded')
    },
  })

  return {
    write(msg) {
      return ccr.writeEvent(msg)
    },
    setOnData(cb) {
      sse.setOnData(cb)
    },
    connect() {
      if (!opts.outboundOnly) void sse.connect()
      void ccr.initialize(epoch)
    },
  }
}
```

> 证据，`restored-src/src/bridge/replBridgeTransport.ts`（2.1.88 source map 还原源码），`createV2ReplTransport()`。

`createV2ReplTransport(opts)` 位于 `restored-src/src/bridge/replBridgeTransport.ts`。`sessionUrl` 和 `sessionId` 标识目标 code session；`ingressToken` 用于 session ingress 认证。`initialSequenceNum` 为 `undefined` 时不提供旧高水位；传入数字时，SSE 可以从上次序号继续。`epoch` 为 `undefined` 时函数主动 `registerWorker()`，传值时直接使用服务端已分配的 epoch。

`heartbeatIntervalMs` 不传时 `CCRClient` 的注释默认是 20 秒；`heartbeatJitterFraction` 缺省为 `0`，即不加抖动。`outboundOnly` 为真时不开 SSE 读取流，只保留写事件和 heartbeat，适用于纯镜像附件；缺省或为假时同时接收入站事件。`getAuthToken` 返回函数若存在，就按实例读取 token，适合一个进程管理多个 session；缺省时回退到进程级环境变量路径。

这里还出现了 `epoch`。新 worker 注册会推进 epoch，旧实例收到不匹配响应时触发 `onEpochMismatch`，由回调关闭相关资源并抛出 `epoch superseded` 终止旧 transport；该字段裁决当前 worker 所有权，消息排序则由 sequence 机制负责。

### 消息如何走｜先关联 session，再做去重和顺序保护

当 query loop 产生新消息时，`writeMessages()` 只挑选允许进入 bridge 的 user/assistant 消息，过滤已发送 UUID，再转成 SDK 格式，并为每条事件补上当前 `session_id`。

```ts
writeMessages(messages) {
  const filtered = messages.filter(
    m =>
      isEligibleBridgeMessage(m) &&
      !initialMessageUUIDs.has(m.uuid) &&
      !recentPostedUUIDs.has(m.uuid),
  )
  if (filtered.length === 0) return

  if (flushGate.enqueue(...filtered)) return
  if (!transport) return

  for (const msg of filtered) recentPostedUUIDs.add(msg.uuid)
  const events = toSDKMessages(filtered).map(message => ({
    ...message,
    session_id: currentSessionId,
  }))
  void transport.writeBatch(events)
}
```

> 证据，`restored-src/src/bridge/replBridge.ts`（2.1.88 source map 还原源码），`writeMessages()`。

`writeMessages(messages)` 是 `BridgeCoreHandle` 的方法，参数是本地消息数组。`filtered` 只保留 bridge 允许的类型，并排除 `initialMessageUUIDs` 与 `recentPostedUUIDs` 中的 UUID；`flushGate.enqueue()` 返回真时把它们留在初始历史之后，`transport` 尚未建立时则记录并丢弃。发送前 UUID 被加入 `recentPostedUUIDs`，`toSDKMessages()` 生成 `events`，映射阶段再给每项补上当前 `session_id`。方法返回 `void`，调用方把入 transport 视为本地完成点。

顺序保证来自代码显式维护的初始 flush gate、UUID 去重集合和 SSE sequence high-water mark。三者分别处理历史/实时交错、回声/重复写入和重连重放范围。入站方向也有一个 `recentInboundUUIDs` 有界集合。sequence number 是主恢复机制，UUID 集合是防御性兜底。

### 控制事件为什么必须和普通消息分开

工具需要授权时，本地运行时发出 `control_request`。远端作出选择后返回 `control_response`；本地请求失效后再发 `control_cancel_request`，让远端关闭旧弹窗。

```ts
sendControlRequest(request: SDKControlRequest) {
  if (!transport) return
  const event = { ...request, session_id: currentSessionId }
  void transport.write(event)
}

sendControlCancelRequest(requestId: string) {
  if (!transport) return
  void transport.write({
    type: 'control_cancel_request',
    request_id: requestId,
    session_id: currentSessionId,
  })
}
```

> 证据，`restored-src/src/bridge/replBridge.ts`（2.1.88 source map 还原源码），控制事件发送。

`sendControlRequest(request)` 接收完整 `SDKControlRequest`，其中 `request.request_id` 关联后续响应；Bridge 只补当前 `session_id`。`sendControlCancelRequest(requestId)` 接收开放字符串 id，并构造固定类型 `control_cancel_request`。两者在 `transport` 为 `null` 时都直接返回，不会把权限请求缓存成普通聊天消息。

远端的 `RemoteSessionManager` 会把普通 SDK 消息和控制消息分流，

```ts
private handleMessage(
  message:
    | SDKMessage
    | SDKControlRequest
    | SDKControlResponse
    | SDKControlCancelRequest,
): void {
  if (message.type === 'control_request') {
    this.handleControlRequest(message)
    return
  }
  if (message.type === 'control_cancel_request') {
    const { request_id } = message
    const pendingRequest = this.pendingPermissionRequests.get(request_id)
    this.pendingPermissionRequests.delete(request_id)
    this.callbacks.onPermissionCancelled?.(
      request_id,
      pendingRequest?.tool_use_id,
    )
    return
  }
  if (message.type === 'control_response') return
  if (isSDKMessage(message)) this.callbacks.onMessage(message)
}
```

> 证据，`restored-src/src/remote/RemoteSessionManager.ts`（2.1.88 source map 还原源码），`handleMessage()`。

`handleMessage(message)` 的参数联合类型包括 `SDKMessage`、`SDKControlRequest`、`SDKControlResponse` 和 `SDKControlCancelRequest`。`control_request` 目前只明确处理 `can_use_tool`；未知 subtype 会回一条 `error` response，避免 server 永久等待。`control_cancel_request` 会删除 pending request；普通 `SDKMessage` 才进入 UI 消息回调。

权限结果的可选值很窄，`RemotePermissionResponse` 只有 `allow` 和 `deny`。`allow` 必须带 `updatedInput`，意味着用户可以确认经修改的工具输入；`deny` 带拒绝消息。协议通过封闭联合排除了"连接后默认允许"。远端控制通道只承载权限决策，权限引擎仍负责生成请求和校验结果。请求带有 `request_id` 和 `tool_use_id`，响应必须匹配 pending request；第 12 篇介绍的 allow/ask/deny 决策继续位于执行端。

### Remote client 如何订阅会话并反向控制

`RemoteSessionManager.connect()` 会创建 `SessionsWebSocket`，把连接、重连、关闭和错误映射为上层回调。用户输入则不走这条订阅连接，而是通过 `sendEventToRemoteSession()` 的 HTTP POST 发往会话。

```ts
connect(): void {
  const wsCallbacks: SessionsWebSocketCallbacks = {
    onMessage: message => this.handleMessage(message),
    onConnected: () => {
      this.callbacks.onConnected?.()
    },
    onClose: () => {
      this.callbacks.onDisconnected?.()
    },
    onReconnecting: () => {
      this.callbacks.onReconnecting?.()
    },
    onError: error => {
      logError(error)
      this.callbacks.onError?.(error)
    },
  }

  this.websocket = new SessionsWebSocket(
    this.config.sessionId,
    this.config.orgUuid,
    this.config.getAccessToken,
    wsCallbacks,
  )
  void this.websocket.connect()
}
```

> 证据，`restored-src/src/remote/RemoteSessionManager.ts`（2.1.88 source map 还原源码），`connect()`。

`RemoteSessionManager.connect()` 接受零个参数并返回 `void`；它使用构造时传入的 `RemoteSessionConfig`。`sessionId` 与 `orgUuid` 共同定位订阅，`getAccessToken()` 每次连接都可取新 token。`wsCallbacks.onMessage` 进入协议分流，`onConnected`、`onClose`、`onReconnecting` 更新宿主连接状态，`onError` 先记录再通知上层。`hasInitialPrompt` 为真时表示创建 session 时已有正在处理的 prompt；`viewerOnly` 为真时关闭 interrupt、标题更新和普通控制端断线超时策略。两者省略时由 `createRemoteSessionConfig()` 回退为 `false`。

`SessionsWebSocket.connect()` 把 API 的 `https://` 基址转换为 `wss://`，路径是 `/v1/sessions/ws/{sessionId}/subscribe`，并在 query 中带 `organization_uuid`。认证通过 `Authorization: Bearer ...` header 和固定的 `anthropic-version` header 完成。Bun 与 Node `ws` 分支使用不同代理/TLS 适配，但都在连接打开后才把状态改成 `connected`。

它的消息校验只要求对象有字符串 `type`，让服务端新增类型可以穿过 transport 层；真正的类型分派留给 `RemoteSessionManager` 和后续 adapter，下游通过未知 type 分支保持兼容。

### Direct Connect｜另一扇门，同一套结构化协议

Direct Connect 采用独立建连路径，客户端先向指定 server 创建 session、校验返回值，再连接 server 提供的 `wsUrl`。claude.ai Remote Control 则使用前面的远程 session 服务。

```ts
export async function createDirectConnectSession({
  serverUrl,
  authToken,
  cwd,
  dangerouslySkipPermissions,
}: {
  serverUrl: string
  authToken?: string
  cwd: string
  dangerouslySkipPermissions?: boolean
}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (authToken) {
    headers['authorization'] = `Bearer ${authToken}`
  }

  let resp: Response
  try {
    resp = await fetch(`${serverUrl}/sessions`, {
      method: 'POST',
      headers,
      body: jsonStringify({
        cwd,
        ...(dangerouslySkipPermissions && {
          dangerously_skip_permissions: true,
        }),
      }),
    })
  } catch (err) {
    throw new DirectConnectError(
      `Failed to connect to server at ${serverUrl}: ${errorMessage(err)}`,
    )
  }

  const result = connectResponseSchema().safeParse(await resp.json())
  if (!result.success) {
    throw new DirectConnectError(
      `Invalid session response: ${result.error.message}`,
    )
  }
  const data = result.data
  return {
    config: {
      serverUrl,
      sessionId: data.session_id,
      wsUrl: data.ws_url,
      authToken,
    },
    workDir: data.work_dir,
  }
}
```

> 证据，`restored-src/src/server/createDirectConnectSession.ts`（2.1.88 source map 还原源码），`createDirectConnectSession()`。

`createDirectConnectSession()` 位于 `restored-src/src/server/createDirectConnectSession.ts`。`serverUrl` 是开放 URL 输入，静态源码未限制候选集合；`authToken` 可为 `undefined`，此时省略 Bearer header；`cwd` 是希望 server 使用的工作目录；`dangerouslySkipPermissions` 只有严格为真时才把 `dangerously_skip_permissions: true` 写入请求体，`false` 或 `undefined` 都省略该字段。

请求对象的 `method` 固定为 `'POST'`，`headers` 固定包含 `content-type: application/json` 并在有 token 时追加 `authorization`；body 始终写 `cwd`，危险权限字段按布尔分支条件展开。`resp` 是 fetch 返回的 `Response`，网络异常被包装为 `DirectConnectError`，随后还要通过 HTTP 状态与 `connectResponseSchema().safeParse()` 校验。`result.success: false` 使用 schema error 终止，成功时 `data.session_id`、`data.ws_url` 分别写入返回配置的 `sessionId`、`wsUrl`，原 `serverUrl`、`authToken` 也随 `config` 保留，`data.work_dir` 则成为 `workDir`。

`DirectConnectSessionManager` 连接 `wsUrl` 后按换行拆分 JSON，每一行都是 Structured IO 消息。普通 assistant/result/system 交给 `onMessage`，`can_use_tool` 控制请求交给 `onPermissionRequest`，用户输入被编码成 `type: 'user'`，中断则编码成 subtype 为 `interrupt` 的 `control_request`。

它与 `RemoteSessionManager` 有一个明显差异，当前 `DirectConnectSessionManager` 的 `close` 只调用 `onDisconnected`；需要恢复时，外层必须重新创建 manager 或自行处理 session 生命周期。

### 断线重连｜两层状态机，两个恢复目标

远端观看端的 `SessionsWebSocket` 关心"还能不能继续订阅这个 session"。当前源码常量是，普通重连等待 2 秒，最多 5 次；ping 间隔 30 秒。`4003` 表示未授权，直接永久关闭。`4001` 表示 session not found，但压缩期间可能短暂出现，因此单独允许 3 次重试，等待时间依次是 2、4、6 秒。

```ts
const RECONNECT_DELAY_MS = 2000
const MAX_RECONNECT_ATTEMPTS = 5
const MAX_SESSION_NOT_FOUND_RETRIES = 3
const PERMANENT_CLOSE_CODES = new Set([4003])

private handleClose(closeCode: number): void {
  if (PERMANENT_CLOSE_CODES.has(closeCode)) {
    this.callbacks.onClose?.()
    return
  }
  if (closeCode === 4001) {
    this.sessionNotFoundRetries++
    if (this.sessionNotFoundRetries > MAX_SESSION_NOT_FOUND_RETRIES) {
      this.callbacks.onClose?.()
      return
    }
    this.scheduleReconnect(
      RECONNECT_DELAY_MS * this.sessionNotFoundRetries,
      `4001 attempt ${this.sessionNotFoundRetries}/${MAX_SESSION_NOT_FOUND_RETRIES}`,
    )
    return
  }
  // ...
}
```

> 证据，`restored-src/src/remote/SessionsWebSocket.ts`（2.1.88 source map 还原源码），`handleClose()`。

`handleClose(closeCode)` 位于 `restored-src/src/remote/SessionsWebSocket.ts`。`RECONNECT_DELAY_MS` 固定为 2000 毫秒，`MAX_RECONNECT_ATTEMPTS` 把普通重连限制为 5 次，`MAX_SESSION_NOT_FOUND_RETRIES` 给 `4001` 单独提供 3 次线性等待；`PERMANENT_CLOSE_CODES` 当前包含 `4003`。`closeCode` 由 server/transport 提供，`4003` 永久终止，`4001` 使用独立预算，其他 code 只在此前状态为 `connected` 且预算未耗尽时重连。显式 `close()` 会先把 state 设成 `closed` 并清理 timer，close 回调不会再次拉起连接。

本地 Bridge 的恢复目标不同，它要证明当前 environment 仍然拥有 work。poll 返回 environment 丢失、transport epoch 被替换、heartbeat 失败时，它可能重新注册 environment，再尝试 `reconnectSession()` 保留原 `sessionId`；如果原 environment 已过期，才归档旧 session 并创建新 session。源码把 environment 重建上限设为 3 次，并使用 promise guard 合并并发重连，避免两个恢复流程同时替换 transport。

因此有两层恢复，控制端恢复订阅，执行端恢复 worker 所有权。两层成功只证明各自连接与租约恢复；本地工具存活和远端 UI 是否错过瞬时状态仍需额外状态确认。源码提供 sequence number、UUID 去重和重连预算，未提供跨任意网络故障的 exactly-once 证明。

### 安全边界｜远程入口仍需逐层检查

最后把几个容易误解的安全结论收紧。

第一，Remote Control 要求访问 token，headless bridge 还要求 workspace 已被信任。`runBridgeHeadless()` 对非 localhost 的明文 `http://` base URL 直接报永久错误，只允许 HTTPS 或 localhost HTTP。

第二，session ingress token、environment secret、OAuth access token 分别服务于不同边界。源码会在每次远端 WebSocket 连接时重新调用 `getAccessToken()`，v2 transport 也提供 per-instance `getAuthToken`，就是为了避免多 session 共用进程级 token 时互相覆盖。

第三，`dangerouslySkipPermissions` 是 Direct Connect 创建 session 时明确上传的危险开关。它为假或未定义时，请求体省略该字段，连接成功也不会改变权限模式。

第四，权限请求的展示端可能缺少远端工具实现。`createToolStub()` 会为本地未知的远端工具构造一个只用于权限 UI 的 stub，并强制 `needsPermissions()` 返回真；stub 的 `call()` 会拒绝执行，真正工具仍在远端执行环境里运行。

这四条共同说明，Bridge 只建立协议边界。输入、输出和控制可以跨机器流动，但 `cwd` 所属、workspace trust、transport 认证、session 关联和工具权限仍要逐层成立。

### RemoteTrigger prompt 暴露的是另一条控制平面

`RemoteTriggerTool/prompt.ts` 面向 claude.ai CCR 的 scheduled remote agents，允许模型在同一个工具契约下执行 list、get、create、update、run 等动作，并以原始 JSON 传递对应输入。OAuth token 在进程内使用，prompt 明确不允许把它通过 shell 暴露给用户或子进程。

这条链路和本文前面讲的 Bridge WebSocket 数据平面不是同一个问题：Bridge 负责会话消息、环境和远端执行连接，RemoteTrigger 负责远程 Agent 的控制 API。二者都可能叫 remote，但 prompt 已经把受众、认证边界和动作集合分开；上线时仍要分别检查 feature gate、网络、权限与服务端状态。

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码，行号以当前仓库为准。

| 机制 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| 无头 Bridge | `runBridgeHeadless()` / `runBridgeLoop()` / spawnMode | `src/bridge/bridgeMain.ts` | 已确认 |
| 交互 Bridge | `initBridgeCore()` / `BridgeCoreHandle` | `src/bridge/replBridge.ts` | 已确认 |
| Transport | `createV2ReplTransport()` SSE + CCRClient | `src/bridge/replBridgeTransport.ts` | 已确认 |
| 消息写出 | `writeMessages()` flush gate + UUID 去重 | `src/bridge/replBridge.ts` | 已确认 |
| 控制事件 | `sendControlRequest()` / `sendControlCancelRequest()` | `src/bridge/replBridge.ts` | 已确认 |
| 远端分流 | `RemoteSessionManager.handleMessage()` | `src/remote/RemoteSessionManager.ts` | 已确认 |
| 订阅连接 | `SessionsWebSocket`（wss subscribe + Bearer） | `src/remote/SessionsWebSocket.ts` | 已确认 |
| 重连 | `handleClose()` 4001/4003 独立预算 | `src/remote/SessionsWebSocket.ts` | 已确认 |
| Direct Connect | `createDirectConnectSession()` / `connectResponseSchema()` | `src/server/createDirectConnectSession.ts` | 已确认 |
| 权限 stub | `createToolStub()` 强制 `needsPermissions()` | `src/remote/` | 已确认 |

> 证据说明，`epoch` 裁决 worker 所有权、`initialSSESequenceNum` 管理重放范围、`recentPostedUUIDs` 防御重复，三者的职责在 `replBridge.ts` / `replBridgeTransport.ts` 中分离；`SessionsWebSocket` 的消息校验只要求字符串 `type`，类型分派留给上层。

## 设计决策｜为什么需要服务端协调，而不是直连

源码里找不到官方选型记录，下面的判断来自代码结构，属于解释而非官方声明。

**第一，为什么浏览器不能直连本地 query loop？** 因为浏览器不知道本地 `cwd`，也不应该直接持有进程句柄。直连方案必须自行解决端口暴露、身份认证、session 路由、断线重连、重复投递、多设备观看和权限请求回传，这些正是 session service 收敛成的控制面，本地只需证明"我拥有这个 environment"，远端只需证明"我被允许访问这个 session"，双方不必互相暴露完整运行环境。代价是引入一个需要认证与租约的中间层。

**第二，为什么入站用 SSE、出站用 HTTP POST？** 因为方向不对称，入站是服务端主动推送（模型事件、控制请求），SSE 的 long-lived 连接天然适合；出站是客户端主动提交（输入、权限响应、heartbeat），普通 POST 更简单、更易重试，也避免写方向的长连接被 NAT/防火墙掐断。双工不一定是一条双向 WebSocket，这是"transport 是传输细节"的直接体现。

**第三，为什么控制事件必须与普通消息分开？** 因为权限弹窗有生命周期，`control_request` 创建、`control_response` 结算、`control_cancel_request` 取消。若混在普通消息流里，取消请求会被当成一条聊天消息回显，pending 映射也会被消息顺序破坏。分开后，`handleMessage()` 可以按类型分流，未知 subtype 回 error 而不是永久等待。

**第四，为什么序列化采用"sequence 主 + UUID 兜底"？** 纯 sequence 重放在断线期间会漏掉未编号的写入，纯 UUID 去重无法决定重放范围。sequence high-water mark 是主恢复机制（从上次序号继续），UUID 集合是防御性兜底（拦截回声与重复写入），初始 flush gate 处理历史与实时的交错，每一层补另一层的盲区，但不承诺 exactly-once。

## 练习｜在真实会话里观察远程链路

1. **观察 poll/ACK/heartbeat。** 启用 Remote Control 后开启 debug 日志，把笔记本留在办公室机器上，观察 `pollForWork()` 的长轮询、`acknowledgeWork()` 的 ACK 与 `heartbeatWork()` 的租约延长在日志里的节奏；断开网络后观察 environment 重建与 `reconnectSession()` 的 3 次上限。

2. **制造一次权限请求的往返。** 在手机上打开 Remote Control，让模型执行一个需要确认的操作，观察，本地 `control_request`（`subtype: 'can_use_tool'`）到达手机、远端 `allow`（带 `updatedInput`）或 `deny` 返回、`control_cancel_request` 在超时后关闭旧弹窗的完整流程；注意 `request_id` 与 `tool_use_id` 的关联。

3. **对比 Direct Connect 与 Remote Control。** 如果环境允许，用 `createDirectConnectSession` 的流程（POST `/sessions` → 校验 `ws_url` → 按行解析 JSON）连接自建 server，与 claude.ai Remote Control 对比，认证方式、session 归属、`close()` 后是否需要外层重建 manager。

## 自测

1. `runBridgeHeadless()` 为什么在网络注册前检查 workspace trust？
2. `epoch` 与 `initialSSESequenceNum` 分别裁决什么？
3. `RemotePermissionResponse` 为什么只有 `allow` 和 `deny` 两个值？
4. Bridge 断线后，控制端恢复订阅与执行端恢复 worker 所有权是同一件事吗？

<details>
<summary>参考答案</summary>

1. **因为目录信任是本地的安全前提。** 即使远端可达且用户已登录，当前目录仍要单独通过 trust dialog；拒绝或缺失信任会让 headless bridge 以永久错误退出（`BridgeHeadlessPermanentError`）。顺序保证了"服务器能收到注册"不等于"本地允许执行"，`cwd` 所属、trust、认证、session 关联和工具权限逐层成立（`bridgeMain.ts`）。

2. **`epoch` 裁决当前 worker 所有权**，新 worker 注册推进 epoch，旧实例收到不匹配响应触发 `onEpochMismatch` 抛出 `epoch superseded` 终止旧 transport。**`initialSSESequenceNum` 管理消息重放范围**，复用旧 session 时沿用高水位，创建新 session 时从 `0` 开始，避免把旧序号套到新流上（`replBridgeTransport.ts`、`replBridge.ts`）。

3. **因为协议通过封闭联合排除了"连接后默认允许"。** `allow` 必须带 `updatedInput`（用户可以确认经修改的工具输入），`deny` 带拒绝消息。远端控制通道只承载权限决策，权限引擎仍负责生成请求和校验结果，远端 UI 不能凭空放行（`RemoteSessionManager.ts`）。

4. **这是两个恢复目标。** 控制端 `SessionsWebSocket` 恢复的是"还能不能继续订阅这个 session"（2s/5 次，4001 单独 3 次，4003 永久关闭）；本地 Bridge 恢复的是"当前 environment 是否仍拥有 work"（重建上限 3 次、promise guard 合并并发）。两层成功只证明各自连接与租约恢复，本地工具存活和远端 UI 是否错过瞬时状态仍需额外状态确认。

</details>

## 回顾（折叠）｜为什么 Claude Code 要区分不同的 provider

<details>
<summary>回答 36 留下的问题，为什么 Claude Code 要区分不同的 provider？</summary>

先抓住一次请求的第一处分叉，`provider` 决定请求发往哪个 API、用哪套身份签名、模型别名落成什么 ID，以及哪些能力参数有资格进入 body。它不是同一个 API 的别名；把四条前门抹平，最先暴露的通常是凭证、部署名或 beta 参数错位。

**2.1.88 里的 provider 是一个路由上下文。** 源码把 provider 定义成封闭联合类型，`'firstParty' | 'bedrock' | 'vertex' | 'foundry'`。`getAPIProvider()` 不接收参数，只读取三个环境开关（`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY`，优先级 Bedrock > Vertex > Foundry，都不成立时回退 `firstParty`）；`isEnvTruthy()` 解释布尔语义。这个函数只做本地路由选择，不会先发请求测试哪个后端可达。provider 之所以必须在这么早的阶段确定，是因为后面的模型表、client 工厂、能力判断和错误处理都会读取它。它从请求开始前贯穿整条调用链。

**同一个 Claude 模型，四套"前门"。** 在 `getAnthropicClient()` 中，`maxRetries` 是必需的重试预算，其他字段可选；函数返回 `Promise<Anthropic>`，但内部会依据 provider 选择不同 SDK 构造器，

| provider | 2.1.88 中的 client 与认证材料 | 模型/部署边界 | 典型组织诉求 |
| --- | --- | --- | --- |
| `firstParty` | `new Anthropic(...)`；订阅 OAuth 或 API key | Anthropic 模型 ID，第一方 API 的 beta 与服务端策略 | 最快获得第一方模型和能力更新 |
| `bedrock` | `new AnthropicBedrock(...)`；AWS region、临时凭证或 `AWS_BEARER_TOKEN_BEDROCK` | Bedrock model ID、inference profile、IAM 和区域可用性 | AWS 身份、VPC/区域边界、统一账单与审计 |
| `vertex` | `new AnthropicVertex(...)`；Google ADC/`GoogleAuth`、project 和 region | Vertex 的模型名称、项目授权和区域可用性 | GCP 项目治理、服务账号和数据驻留 |
| `foundry` | `new AnthropicFoundry(...)`；API key 或 Azure AD token provider | Azure deployment name、租户与 endpoint | Azure 资源、租户策略和企业网络 |

```ts
if (useBedrock) return new AnthropicBedrock(bedrockArgs)
if (useFoundry) return new AnthropicFoundry(foundryArgs)
if (useVertex) return new AnthropicVertex(vertexArgs)
return new Anthropic(firstPartyArgs)
```

> 证据，`restored-src/src/services/api/client.ts`（2.1.88 source map 还原源码），provider 分支形状。

四个构造器最后都被包装成近似统一的 Anthropic client 类型，所以上层 `queryModel()` 可以复用消息、工具和流式处理；但这只是接口复用，不代表四个后端的认证、地区、模型目录和能力完全相同。别名 `sonnet` 或 `opus` 只表达用户意图，`getBuiltinModelStrings(provider)` 遍历 canonical model key 并读取 `ALL_MODEL_CONFIGS[key][provider]`，因此同一个 `/model` 选项可能落成不同字符串，Bedrock 需要带 Anthropic 前缀或 inference profile 的 ID，Vertex 使用自己的模型/版本格式，Foundry 可能直接使用 deployment name。企业还可以用 `modelOverrides` 把某个 Anthropic 模型 ID 映射到指定 ARN、Vertex 版本名或 Foundry deployment。

**provider 会裁剪能力和请求参数。** `modelSupportsStructuredOutputs(model)` 先要求 provider 是 `firstParty` 或 `foundry`，Bedrock 与 Vertex 在这版直接返回 `false`；`getToolSearchBetaHeader()` 对 Vertex/Bedrock 使用第三方 beta header；`modelSupportsContextManagement(model)` 对 Foundry 直接允许、firstParty 排除 Claude 3；`shouldIncludeFirstPartyOnlyBetas()` 只有 firstParty/foundry 且未关闭实验 beta 时返回真。这些判断描述的是 **2.1.88 这份客户端选择的安全发送范围**，不代表某个云平台永久不支持某能力。如果不区分 provider，就无法在发请求前决定是否添加 beta header、structured output 参数或 context-management 字段。

**为什么企业通常更在意 provider？** 模型权重可能相同，但调用前门不同会改变身份、网络、账单、可用时间和限流边界。直连 Anthropic 通常更快拿到新模型；Bedrock、Vertex 或 Foundry 则把请求纳入各自云的 IAM、区域、VPC、审计、采购和费用体系。provider 区分还承担治理作用，管理员可以固定模型版本、给不同云账户分配预算、限制网络出口，并把认证刷新放进既有身份系统。代价是各平台的模型上线时间、部署名、限额和功能支持不会完全同步。

**provider 选择不是跨云自动故障转移。** `getAPIProvider()` 只选出一条路径，`getAnthropicClient()` 也只创建这一条路径的 client。后面的普通重试或 529 model fallback 主要处理当前 provider 中的请求和模型，不会因为 Bedrock 失败就自动切到 Vertex 或 firstParty。跨 provider 切换会同时改变凭证、endpoint、region、模型 ID、能力 gate、费用和数据边界，不能像换一个字符串那样安全地隐式完成。

所以可以用一句话收束，**model 回答"调用哪个模型"，provider 回答"通过谁的基础设施、身份和规则调用它"。** 只有把两者分开，Claude Code 才能在复用同一套 Agent/query 内核的同时，诚实地面对四个后端的实际差异。

</details>

## 留给下一篇的问题

Claude Code 的服务器在整个远程流程中究竟承担什么作用？

## 相关链接

- **上一篇**，[36 认证与云提供商如何接入](./36-model-routing-auth-and-providers.md)，远程请求的模型调用仍走本地 provider
- **下一篇**，[38 如何追踪日志、成本与诊断信息](./38-observability-cost-and-diagnostics.md)，远程链路的观测与证据
- **平行阅读**，[20 会话历史如何持久化与恢复](./20-session-history-and-resume.md)，remote resume 的会话状态来源
- **平行阅读**，[12 权限引擎如何工作](./12-permission-engine.md)，`control_request` 背后的 allow/ask/deny
