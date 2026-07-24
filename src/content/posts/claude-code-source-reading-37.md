---
title: "Claude Code源码解读37：Bridge、Remote Control 与 Server 如何协作"
published: 2026-07-24T16:47:24+08:00
updated: 2026-07-24T16:47:24+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-37/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

模型与认证准备好以后，Claude Code 的 Bridge、Remote Control 与 Server 模式如何连接本地运行时和远端客户端，并转发消息与控制事件？

答案是：Claude Code 没有把 Agent 搬到手机或浏览器里，也没有另写一套“远程 Agent”。它把本地运行时注册成一个可领取工作的 environment，再用一个带 `sessionId` 的事件通道，把本地 query loop 产生的 `SDKMessage` 发到会话服务；远端客户端订阅这些事件，并把新 prompt、interrupt、权限结果反向送回来。

这里至少有三种角色，先别混在一起：

- `ReplBridge` 在真正执行代码的机器上。它知道 `cwd`、本地工具和 query loop。
- `RemoteSessionManager` 在远端控制客户端一侧。它订阅会话、发送用户消息、显示并回复权限请求。
- `DirectConnectSessionManager` 面向 direct-connect server。它使用 server 返回的 `wsUrl`，把同一套结构化消息协议接到自托管入口。

所以 Bridge 解决的不是“远程调用一个函数”，而是一个分布式会话问题：谁拥有执行环境，谁保存会话身份，消息怎样关联，权限由谁确认，连接断掉以后从哪里继续。

本文仍以仓库中由 `@anthropic-ai/claude-code@2.1.88` source map 还原的源码为边界。下面的片段为突出主线省略了日志、UI 和部分错误分支；路径是还原路径，不代表 Anthropic 内部源码的原始目录结构。

![Claude Code Bridge、Remote Control 与 Direct Connect 的协作关系](/images/posts/claude-code-source-reading-37/37-bridge-remote-server-handdrawn.png)

## 先建立一个简单模型：执行端、会话服务、控制端

本地终端和远端客户端看到的是同一段会话，但它们承担的责任并不对称。

本地执行端拥有工作目录和进程权限。`Read` 读的是本地文件，`Bash` 启动的是本地进程，query loop 也运行在这里。会话服务负责把事件按 `sessionId` 关联，并在 environment 与 session 之间调度 work。远端控制端主要负责输入、展示和确认，它不因为能看到会话就自动获得本地工具执行权。

可以把主链路压缩成两条方向相反的数据流：

```text
远端输入：Remote client -> session service -> ReplBridge -> query loop
本地输出：query loop -> ReplBridge -> session service -> Remote client
```

第一条把 prompt、interrupt 和权限响应送到本地；第二条把 assistant、tool、result 以及权限请求送到远端。两条流共享 `sessionId`，但消息事件和控制事件仍是不同协议类型。

为什么不让浏览器直接连本地 query loop？因为浏览器不知道本地 `cwd`，也不应该直接持有进程句柄。中间加上 session service 后，执行环境可以短暂断线、重新注册，远端也只需订阅稳定的 session 身份。

## Bridge 如何把本地机器注册成可工作的 environment

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

`runBridgeHeadless(opts, signal)` 是无 UI bridge 的入口，源码位于 `restored-src/src/bridge/bridgeMain.ts`。`opts.dir` 是执行目录；`opts.getAccessToken()` 返回当前访问令牌，返回空值时这里不会继续注册；`opts.permissionMode` 传给子会话运行时，而不是在 bridge 层被偷偷改写；`opts.sandbox` 是布尔值，决定 spawner 是否启用对应沙箱配置。`signal` 是 `AbortSignal`，用于让外部 supervisor 终止长期循环。

`HeadlessBridgeOpts.spawnMode` 的源码可选值是三种：`single-session` 表示一个目录承载一个会话并在结束时退出；`worktree` 表示为多个会话创建隔离 worktree；`same-dir` 表示多个会话共享目录，因此也明确存在互相覆盖的风险。`sessionTimeoutMs` 可以不传，类型文件中的默认会话超时是 24 小时。

这里有一个很重要的顺序：workspace trust 在网络注册之前检查。远端可达不等于本地目录可信。即使用户已经登录，未在该目录接受 trust dialog，headless bridge 仍会以永久错误退出。

`runBridgeLoop()` 才是 environment 的“值班室”。它持续轮询 work，领取后 ACK，启动或连接 session，并通过 heartbeat 延长租约。`BridgeConfig.maxSessions` 决定容量；`spawnMode` 决定工作目录策略；`environmentSecret` 用来证明当前 worker 对 environment 的控制权；session ingress token 则用于具体 session 的事件与心跳请求。两类凭据不是一回事。

## ReplBridge 为什么不是一个 WebSocket 包装器

交互式 REPL 内部使用的是 `initBridgeCore()`。源码注释把它概括成：environment registration → session creation → poll loop → ingress transport → teardown。这个函数不自己读取 bootstrap state，所有上下文都从 `BridgeCoreParams` 注入，因此同一核心也能被 daemon 调用。

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

`initBridgeCore(params)` 位于 `restored-src/src/bridge/replBridge.ts`。`dir` 是本地工作目录；`title` 是会话初始标题；`getAccessToken` 是按需取 token 的函数；`createSession` 由调用方注入，返回 session id，失败时核心返回 `null`；`onInboundMessage` 接收远端输入；`onPermissionResponse` 接收远端权限结果；`onInterrupt` 处理反向中断。

几个可选参数会直接改变控制流：`perpetual` 为真时会尝试读取 bridge pointer 并复用之前的 environment/session；缺省或为假时，正常 teardown 会清理 pointer。`initialSSESequenceNum` 缺省为 `0`；只有确实复用旧 session 时，源码才会沿用这个高水位，创建新 session 时仍从 `0` 开始，避免把旧 session 的序号错误套到新流上。

`BridgeCoreHandle` 暴露的不只是 `writeMessages()`，还包括 `sendControlRequest()`、`sendControlResponse()`、`sendControlCancelRequest()`、`sendResult()` 和 `teardown()`。这已经说明 Bridge 的协议面比“转发聊天文本”更宽。

## transport：入站和出站甚至不必使用同一种连接

在 CCR v2 路径里，`createV2ReplTransport()` 使用 `SSETransport` 接收入站事件，用 `CCRClient` 的 HTTP POST 路径写出站事件。也就是说，“Remote Control 就是一条 WebSocket”并不准确；具体 transport 会随服务端下发的 work secret 和功能路径变化。

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

`createV2ReplTransport(opts)` 位于 `restored-src/src/bridge/replBridgeTransport.ts`。`sessionUrl` 和 `sessionId` 标识目标 code session；`ingressToken` 用于 session ingress 认证。`initialSequenceNum` 为 `undefined` 时不提供旧高水位；传入数字时，SSE 可以从上次序号继续。`epoch` 为 `undefined` 时函数主动 `registerWorker()`，传值时直接使用服务端已分配的 epoch。

`heartbeatIntervalMs` 不传时 `CCRClient` 的注释默认是 20 秒；`heartbeatJitterFraction` 缺省为 `0`，即不加抖动。`outboundOnly` 为真时不开 SSE 读取流，只保留写事件和 heartbeat，适用于纯镜像附件；缺省或为假时同时接收入站事件。`getAuthToken` 返回函数若存在，就按实例读取 token，适合一个进程管理多个 session；缺省时回退到进程级环境变量路径。

这里还出现了 `epoch`。它的意义是阻止旧 worker 在重连后继续写入：新 worker 注册会推进 epoch，旧实例收到不匹配响应后必须关闭。它处理的是“谁是当前 worker”，不是消息排序本身。

## 消息如何走：先关联 session，再做去重和顺序保护

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

`writeMessages(messages)` 是 `BridgeCoreHandle` 的方法，参数是本地消息数组。它没有返回送达确认，调用方也没有在这里等待网络完成。`initialMessageUUIDs` 防止历史消息再次发送，`recentPostedUUIDs` 同时用于发送去重和回声过滤。`flushGate.enqueue()` 返回真表示初始历史仍在写入，新消息先排队，避免历史和实时消息交错；如果 transport 不存在，源码选择记录并丢弃这批消息，而不是假装已经送达。

所以顺序保证不是 WebSocket 自动赠送的。代码显式维护初始 flush gate、UUID 去重集合和 SSE sequence high-water mark。三者分别解决历史/实时交错、回声/重复写入、重连重放范围，缺一项都会出现不同种类的重复或乱序。

入站方向也有一个 `recentInboundUUIDs` 有界集合。sequence number 是主恢复机制，UUID 集合是防御性兜底。

## 控制事件为什么必须和普通消息分开

工具需要授权时，本地运行时发出的不是 assistant 文本，而是 `control_request`。远端作出选择后返回 `control_response`；如果本地请求已不再有效，还可以发 `control_cancel_request` 让远端关闭旧弹窗。

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

`sendControlRequest(request)` 接收完整 `SDKControlRequest`，其中 `request.request_id` 关联后续响应；Bridge 只补当前 `session_id`。`sendControlCancelRequest(requestId)` 接收开放字符串 id，并构造固定类型 `control_cancel_request`。两者在 `transport` 为 `null` 时都直接返回，不会把权限请求缓存成普通聊天消息。

远端的 `RemoteSessionManager` 会把普通 SDK 消息和控制消息分流：

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

`handleMessage(message)` 位于 `restored-src/src/remote/RemoteSessionManager.ts`，参数联合类型包括 `SDKMessage`、`SDKControlRequest`、`SDKControlResponse` 和 `SDKControlCancelRequest`。`control_request` 目前只明确处理 `can_use_tool`；未知 subtype 会回一条 `error` response，避免 server 永久等待。`control_cancel_request` 会删除 pending request；普通 `SDKMessage` 才进入 UI 消息回调。

权限结果的可选值也很窄：`RemotePermissionResponse` 是 `allow` 或 `deny`。`allow` 必须带 `updatedInput`，意味着用户可以确认经修改的工具输入；`deny` 带拒绝消息。远端客户端没有第三个“连接后默认允许”的行为值。

这就是权限边界的核心：远端控制通道可以承载权限决策，但不替代权限引擎。请求仍然有 `request_id` 和 `tool_use_id`，响应仍然必须匹配 pending request。第 12 篇介绍过的 allow/ask/deny 决策，并没有因为加入 Bridge 就消失。

## Remote client 如何订阅会话并反向控制

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

`RemoteSessionManager.connect()` 没有参数和返回值；它使用构造时传入的 `RemoteSessionConfig`。其中 `sessionId` 与 `orgUuid` 共同定位订阅，`getAccessToken()` 每次连接都可取新 token。`hasInitialPrompt` 与 `viewerOnly` 都是可选布尔值：`hasInitialPrompt` 表示 session 创建时已有正在处理的 prompt；`viewerOnly` 为真时客户端是纯观看者，不应发送 interrupt、更新标题，也不启用普通控制端的断线超时策略。两者缺省都是 `undefined`，而辅助构造函数 `createRemoteSessionConfig()` 会分别回退为 `false`。

`SessionsWebSocket.connect()` 把 API 的 `https://` 基址转换为 `wss://`，路径是 `/v1/sessions/ws/{sessionId}/subscribe`，并在 query 中带 `organization_uuid`。认证通过 `Authorization: Bearer ...` header 和固定的 `anthropic-version` header 完成。Bun 与 Node `ws` 分支使用不同代理/TLS 适配，但都在连接打开后才把状态改成 `connected`。

它的消息校验刻意只要求对象有字符串 `type`，没有硬编码完整 allowlist。这样服务端新增消息类型时不会在 transport 层被静默丢掉，真正的类型分派留给 `RemoteSessionManager` 和后续 adapter。代价是下游必须继续防御未知 type。

## Direct Connect：另一扇门，同一套结构化协议

Direct Connect 与 claude.ai Remote Control 不是同一条建连路径。客户端先向指定 server 创建 session，校验返回值，再连接 server 提供的 `wsUrl`。

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

`createDirectConnectSession()` 位于 `restored-src/src/server/createDirectConnectSession.ts`。`serverUrl` 是开放 URL 输入，源码没有列举固定候选；`authToken` 可为 `undefined`，此时不添加 Bearer header；`cwd` 是希望 server 使用的工作目录；`dangerouslySkipPermissions` 只有严格为真时才把 `dangerously_skip_permissions: true` 写入请求体，`false` 或 `undefined` 都省略该字段。

实际源码在返回前还检查网络错误、非 2xx 状态和 response schema。有效响应提供 `session_id`、`ws_url`，`work_dir` 可选。；最终目录要看经过 schema 验证的 `work_dir`。

`DirectConnectSessionManager` 连接 `wsUrl` 后按换行拆分 JSON，每一行都是 Structured IO 消息。普通 assistant/result/system 交给 `onMessage`，`can_use_tool` 控制请求交给 `onPermissionRequest`，用户输入被编码成 `type: 'user'`，中断则编码成 subtype 为 `interrupt` 的 `control_request`。

它与 `RemoteSessionManager` 有一个明显差异：当前 `DirectConnectSessionManager` 没有自动重连状态机，`close` 只调用 `onDisconnected`。；外层若需要恢复，必须重新创建 manager 或自行处理 session 生命周期。

## 断线重连：两层状态机，两个恢复目标

远端观看端的 `SessionsWebSocket` 关心“还能不能继续订阅这个 session”。当前源码常量是：普通重连等待 2 秒，最多 5 次；ping 间隔 30 秒。`4003` 表示未授权，直接永久关闭。`4001` 表示 session not found，但压缩期间可能短暂出现，因此单独允许 3 次重试，等待时间依次是 2、4、6 秒。

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

`handleClose(closeCode)` 位于 `restored-src/src/remote/SessionsWebSocket.ts`。`closeCode` 是 server/transport 提供的数字，不是任意用户配置。`4003` 走永久终止；`4001` 使用独立预算；其他 code 只有在断线前状态为 `connected` 且次数未到 5 时才重连。显式 `close()` 会先把 state 设成 `closed` 并清理 timer，因此不会被 close 回调重新拉起。

本地 Bridge 的恢复目标不同：它要证明当前 environment 仍然拥有 work。poll 返回 environment 丢失、transport epoch 被替换、heartbeat 失败时，它可能重新注册 environment，再尝试 `reconnectSession()` 保留原 `sessionId`；如果原 environment 已过期，才归档旧 session 并创建新 session。源码把 environment 重建上限设为 3 次，并使用 promise guard 合并并发重连，避免两个恢复流程同时替换 transport。

因此有两层恢复：控制端恢复订阅，执行端恢复 worker 所有权。前者成功不代表本地工具还在运行；后者成功也不代表远端 UI 从未错过瞬时状态。源码提供 sequence number、UUID 去重和重连预算，但它没有证明跨任意网络故障的 exactly-once delivery。

## 安全边界：远程化增加了入口，没有消除检查

最后把几个容易误解的安全结论收紧。

第一，Remote Control 要求访问 token，headless bridge 还要求 workspace 已被信任。`runBridgeHeadless()` 对非 localhost 的明文 `http://` base URL 直接报永久错误，只允许 HTTPS 或 localhost HTTP。

第二，session ingress token、environment secret、OAuth access token 分别服务于不同边界。源码会在每次远端 WebSocket 连接时重新调用 `getAccessToken()`，v2 transport 也提供 per-instance `getAuthToken`，就是为了避免多 session 共用进程级 token 时互相覆盖。

第三，`dangerouslySkipPermissions` 是 Direct Connect 创建 session 时明确上传的危险开关，不是连接成功后的隐含默认值。它为假或未定义时，请求体根本没有这个字段。

第四，权限请求的展示端可能没有加载远端所有工具。`createToolStub()` 会为本地未知的远端工具构造一个只用于权限 UI 的 stub，并强制 `needsPermissions()` 返回真；它的 `call()` 不是实际执行入口。真正工具仍在远端执行环境里运行。

这四条共同说明：Bridge 是协议边界，不是信任捷径。它让输入、输出和控制跨机器流动，但 `cwd` 所属、workspace trust、transport 认证、session 关联和工具权限仍要逐层成立。

## 小结

Claude Code 的远程能力可以理解为“本地执行，服务端协调，远端控制”。`runBridgeHeadless()` 或 `initBridgeCore()` 注册 environment 和 session，poll/ACK/heartbeat 维持 worker 所有权；transport 把远端 prompt 送入本地 query loop，再把 `SDKMessage` 写回 session service。权限、取消和模式切换使用独立 control event，不与普通对话文本混在一起。

`RemoteSessionManager` 负责 claude.ai session 的订阅和反向控制，`DirectConnectSessionManager` 则接入 server 返回的 `wsUrl`。它们复用结构化消息思想，却有不同的认证、建连和重连边界。WebSocket、SSE 和 HTTP POST 只是 transport；真正让远程会话可靠的是 session id、worker epoch、sequence high-water mark、UUID 去重、flush gate、明确的权限响应与有限重试。

更准确地说，远程模式没有制造第二套 Agent 内核。它只是把原本发生在一台机器上的输入、输出和控制，拆成了一套需要身份、顺序、恢复与安全边界的分布式协议。

## 留给下一篇的问题

远端与本地运行时能够协作以后，Claude Code 如何记录日志、指标、token 与成本，并把运行状态暴露给诊断和观测系统？

