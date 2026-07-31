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

## 本章先建立三个概念

- **Session affinity**：远程消息先关联到具体本地会话，才能保持上下文、工具和工作目录一致。

- **双工传输**：控制端与执行端各自发送事件，入站和出站可以采用不同连接策略。

- **重连状态**：传输恢复与 Agent 会话恢复是两层目标，序号、去重和确认点负责衔接。

![Remote Control 的会话关联与双层重连](/images/posts/claude-code-source-reading-37/37-remote-session-affinity-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇留下的问题是：**为什么 Claude Code 要区分不同的 provider？**

先给结论：`provider` 不是“同一个 API 的几个别名”，而是一次请求的承载方和运行时契约。它决定请求发到哪里、用谁的身份签名、模型名称如何解析、哪些 beta header 和能力参数可以发送，以及数据、账单、区域和组织策略落在哪个边界。把这些路径强行当成同一个 provider，最容易出现的不是代码重复，而是拿错凭证、把错误的模型 ID 发给后端，或者把一个后端不支持的参数送出去。

## 2.1.88 里的 provider 是一个路由上下文

源码把 provider 定义成封闭联合类型：`'firstParty' | 'bedrock' | 'vertex' | 'foundry'`。`getAPIProvider()` 不接收参数，只读取三个环境开关：

```ts
export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : 'firstParty'
}
```

`isEnvTruthy()` 把布尔 `true`，以及忽略大小写、去掉首尾空白后为 `1`、`true`、`yes`、`on` 的字符串视为真；`undefined`、空字符串和其他字符串视为假。三个开关同时为真时，优先级是 Bedrock、Vertex、Foundry；都不成立时回退 `firstParty`。这个函数只做本地路由选择，不会先发请求测试哪个后端可达。

provider 之所以必须在这么早的阶段确定，是因为后面的模型表、client 工厂、能力判断和错误处理都会读取它。它不是请求末尾的一个标签，而是贯穿调用链的上下文。

## 同一个 Claude 模型，四套“前门”

在 `getAnthropicClient({ apiKey?, maxRetries, model?, fetchOverride?, source? })` 中，`maxRetries` 是必需的重试预算，其他字段可选；函数返回 `Promise<Anthropic>`，但内部会依据 provider 选择不同 SDK 构造器：

| provider | 2.1.88 中的 client 与认证材料 | 模型/部署边界 | 典型组织诉求 |
| --- | --- | --- | --- |
| `firstParty` | `new Anthropic(...)`；订阅 OAuth 或 API key | Anthropic 模型 ID，第一方 API 的 beta 与服务端策略 | 最快获得第一方模型和能力更新 |
| `bedrock` | `new AnthropicBedrock(...)`；AWS region、临时凭证或 `AWS_BEARER_TOKEN_BEDROCK` | Bedrock model ID、inference profile、IAM 和区域可用性 | AWS 身份、VPC/区域边界、统一账单与审计 |
| `vertex` | `new AnthropicVertex(...)`；Google ADC/`GoogleAuth`、project 和 region | Vertex 的模型名称、项目授权和区域可用性 | GCP 项目治理、服务账号和数据驻留 |
| `foundry` | `new AnthropicFoundry(...)`；API key 或 Azure AD token provider | Azure deployment name、租户与 endpoint | Azure 资源、租户策略和企业网络 |

源码中的分支可以压缩成下面的形状：

```ts
if (useBedrock) return new AnthropicBedrock(bedrockArgs)
if (useFoundry) return new AnthropicFoundry(foundryArgs)
if (useVertex) return new AnthropicVertex(vertexArgs)
return new Anthropic(firstPartyArgs)
```

四个构造器最后都被包装成近似统一的 Anthropic client 类型，所以上层 `queryModel()` 可以复用消息、工具和流式处理；但这只是接口复用，不代表四个后端的认证、地区、模型目录和能力完全相同。比如 Bedrock 分支会先刷新 AWS 凭证并选择 region，Vertex 分支会创建 `GoogleAuth` 并按模型计算 region，Foundry 分支则在缺少 API key 时创建 Azure AD token provider。

## provider 还决定“同名模型”到底发什么字符串

别名 `sonnet` 或 `opus` 只表达用户意图，不能直接当作所有后端都接受的 ID。`getBuiltinModelStrings(provider)` 遍历 canonical model key，并读取 `ALL_MODEL_CONFIGS[key][provider]`：

```ts
function getBuiltinModelStrings(provider: APIProvider): ModelStrings {
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    out[key] = ALL_MODEL_CONFIGS[key][provider]
  }
  return out
}
```

因此同一个 `/model` 选项可能落成不同字符串：Bedrock 需要带 Anthropic 前缀或 inference profile 的 ID，Vertex 使用自己的模型/版本格式，Foundry 可能直接使用 deployment name。源码和官方配置说明都把“模型别名”和“provider-specific model ID”分成两层；企业还可以用 `modelOverrides` 把某个 Anthropic 模型 ID 映射到指定 ARN、Vertex 版本名或 Foundry deployment。

这也是为什么不能只看到 UI 显示 `Sonnet` 就断言“后端已经找到同一个模型”。模型可能没有在该 region 开通、deployment 尚未创建、inference profile 没权限，或者该 provider 的默认别名仍指向较旧版本。provider 选择和模型可用性是两次不同的判断。

## provider 会裁剪能力和请求参数

2.1.88 的源码明确把 provider 放进 capability gate，而不是只用它构造 client：

| 源码 gate | provider 相关行为 |
| --- | --- |
| `modelSupportsStructuredOutputs(model)` | 先要求 provider 是 `firstParty` 或 `foundry`；Bedrock 与 Vertex 在这版直接返回 `false`，再继续检查模型家族 |
| `getToolSearchBetaHeader()` | Vertex/Bedrock 使用第三方 beta header，其他 provider 使用第一方 header |
| `modelSupportsContextManagement(model)` | Foundry 直接允许；firstParty 排除 Claude 3；其他 provider 只对 Claude 4 家族允许 |
| `vertexModelSupportsWebSearch(model)` | Vertex 只对 Claude 4 家族开放 Web Search 能力 |
| `shouldIncludeFirstPartyOnlyBetas()` | 只有 `firstParty` 或 `foundry` 且未关闭实验 beta 时返回真 |

这些判断的含义不是“某个云平台永远不支持某能力”，而是 **2.1.88 这份客户端选择的安全发送范围**。如果不区分 provider，Claude Code 就无法在发请求前决定是否添加 beta header、structured output 参数、context-management 字段或 Web Search 相关配置；结果要么被后端拒绝，要么把实验性参数发到错误的入口。

## 为什么企业通常更在意 provider，而不是只看模型名

外部资料里反复出现的共同点是：模型权重可能相同，但调用前门不同会改变身份、网络、账单、可用时间和限流边界。直连 Anthropic 通常更快拿到新模型；Bedrock、Vertex 或 Foundry 则把请求纳入各自云的 IAM、区域、VPC、审计、采购和费用体系。对企业来说，“Claude Sonnet”回答得是否相似只是第一层问题，更重要的是代码和提示词经过谁的网络、由谁记录、在哪个区域计费，以及哪个组织可以撤销访问。

因此 provider 区分还承担治理作用：它让管理员可以固定模型版本、给不同云账户分配预算、限制网络出口，并把认证刷新放进既有身份系统。代价是各平台的模型上线时间、部署名、限额和功能支持不会完全同步，Claude Code 必须把这些差异显式建模。

## provider 选择不是跨云自动故障转移

最后要把一个容易误会的边界说清楚：`getAPIProvider()` 只选出一条路径，`getAnthropicClient()` 也只创建这一条路径的 client。后面的普通重试或 529 model fallback 主要处理当前 provider 中的请求和模型，不会因为 Bedrock 失败就自动切到 Vertex 或 firstParty。

跨 provider 切换会同时改变凭证、endpoint、region、模型 ID、能力 gate、费用和数据边界，不能像换一个字符串那样安全地隐式完成。如果产品确实需要多云容灾，应在更外层显式配置路由、验证每个 provider 的模型映射和权限，再决定哪些错误允许切换。

所以可以用一句话收束：**model 回答“调用哪个模型”，provider 回答“通过谁的基础设施、身份和规则调用它”。** 只有把两者分开，Claude Code 才能在复用同一套 Agent/query 内核的同时，诚实地面对四个后端的实际差异。

本文仍以仓库中由 `@anthropic-ai/claude-code@2.1.88` source map 还原的源码为边界；后文原有的 Bridge、Remote Control 与 Server 代码保持不变。这里新增的回答只解释 provider 分层的必要性，不把最新文档中的 provider 能力表倒推成 2.1.88 的源码事实。

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

`runBridgeHeadless(opts, signal)` 是无 UI bridge 的入口，源码位于 `restored-src/src/bridge/bridgeMain.ts`。`opts.dir` 是执行目录；`opts.getAccessToken()` 返回当前访问令牌，空值会终止注册；`opts.permissionMode` 原样传给子会话运行时；`opts.sandbox` 是布尔值，决定 spawner 是否启用对应沙箱配置。`signal` 是 `AbortSignal`，用于让外部 supervisor 终止长期循环。

注册与启动字段分成两组：`reg.environment_id` 标识后续 work loop 轮询的 environment，`reg.environment_secret` 证明 worker 所有权；spawner 的 `execPath` 指向当前可执行文件，`scriptArgs` 提供子进程参数，`env` 继承当前环境，`verbose: false` 关闭子进程详细输出，`onDebug: log` 把调试信息送回 bridge logger。`runBridgeLoop()` 再同时接收 `config`、两个注册凭据、`api`、`spawner`、`logger` 与 `signal`，分别负责容量策略、认证、服务请求、会话启动、诊断和取消。

`HeadlessBridgeOpts.spawnMode` 的源码可选值是三种：`single-session` 表示一个目录承载一个会话并在结束时退出；`worktree` 表示为多个会话创建隔离 worktree；`same-dir` 表示多个会话共享目录，因此也明确存在互相覆盖的风险。`sessionTimeoutMs` 可以不传，类型文件中的默认会话超时是 24 小时。

这里有一个很重要的顺序：workspace trust 在网络注册之前检查。即使远端可达且用户已经登录，当前目录仍要单独通过 trust dialog；拒绝或缺失信任会让 headless bridge 以永久错误退出。

`runBridgeLoop()` 是 environment 的“值班室”。它持续轮询 work，领取后 ACK，启动或连接 session，并通过 heartbeat 延长租约。`BridgeConfig.maxSessions` 决定容量；`spawnMode` 决定工作目录策略；`environmentSecret` 证明当前 worker 对 environment 的控制权；session ingress token 则授权具体 session 的事件与心跳请求。

## ReplBridge 在 WebSocket 之上维护会话协议

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

`initBridgeCore(params)` 位于 `restored-src/src/bridge/replBridge.ts`。`dir` 是本地工作目录；`title` 是会话初始标题；`getAccessToken` 是按需取 token 的函数；`createSession` 由调用方注入，返回 session id，失败时核心返回 `null`。调用它时，`environmentId` 取刚注册得到的 `reg.environment_id`，把新 session 绑定到当前 bridge environment；`signal` 固定为 15 秒超时，只约束这次建会话请求。`onInboundMessage` 接收远端输入；`onPermissionResponse` 接收远端权限结果；`onInterrupt` 处理反向中断。

几个可选参数会直接改变控制流：`perpetual` 为真时会尝试读取 bridge pointer 并复用之前的 environment/session；缺省或为假时，正常 teardown 会清理 pointer。`initialSSESequenceNum` 缺省为 `0`；只有确实复用旧 session 时，源码才会沿用这个高水位，创建新 session 时仍从 `0` 开始，避免把旧 session 的序号错误套到新流上。

`BridgeCoreHandle` 同时暴露 `writeMessages()`、`sendControlRequest()`、`sendControlResponse()`、`sendControlCancelRequest()`、`sendResult()` 和 `teardown()`，协议面覆盖聊天文本、控制请求、终态和连接生命周期。

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

这里还出现了 `epoch`。新 worker 注册会推进 epoch，旧实例收到不匹配响应时触发 `onEpochMismatch`，由回调关闭相关资源并抛出 `epoch superseded` 终止旧 transport；该字段裁决当前 worker 所有权，消息排序则由 sequence 机制负责。

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

`writeMessages(messages)` 是 `BridgeCoreHandle` 的方法，参数是本地消息数组。`filtered` 只保留 bridge 允许的类型，并排除 `initialMessageUUIDs` 与 `recentPostedUUIDs` 中的 UUID；`flushGate.enqueue()` 返回真时把它们留在初始历史之后，`transport` 尚未建立时则记录并丢弃。发送前 UUID 被加入 `recentPostedUUIDs`，`toSDKMessages()` 生成 `events`，映射阶段再给每项补上当前 `session_id`。方法返回 `void`，调用方把入 transport 视为本地完成点。

顺序保证来自代码显式维护的初始 flush gate、UUID 去重集合和 SSE sequence high-water mark。三者分别处理历史/实时交错、回声/重复写入和重连重放范围。

入站方向也有一个 `recentInboundUUIDs` 有界集合。sequence number 是主恢复机制，UUID 集合是防御性兜底。

## 控制事件为什么必须和普通消息分开

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

权限结果的可选值很窄：`RemotePermissionResponse` 只有 `allow` 和 `deny`。`allow` 必须带 `updatedInput`，意味着用户可以确认经修改的工具输入；`deny` 带拒绝消息。协议通过封闭联合排除了“连接后默认允许”。

远端控制通道只承载权限决策，权限引擎仍负责生成请求和校验结果。请求带有 `request_id` 和 `tool_use_id`，响应必须匹配 pending request；第 12 篇介绍的 allow/ask/deny 决策继续位于执行端。

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

`RemoteSessionManager.connect()` 接受零个参数并返回 `void`；它使用构造时传入的 `RemoteSessionConfig`。`sessionId` 与 `orgUuid` 共同定位订阅，`getAccessToken()` 每次连接都可取新 token。`wsCallbacks.onMessage` 进入协议分流，`onConnected`、`onClose`、`onReconnecting` 更新宿主连接状态，`onError` 先记录再通知上层。`hasInitialPrompt` 为真时表示创建 session 时已有正在处理的 prompt；`viewerOnly` 为真时关闭 interrupt、标题更新和普通控制端断线超时策略。两者省略时由 `createRemoteSessionConfig()` 回退为 `false`。

`SessionsWebSocket.connect()` 把 API 的 `https://` 基址转换为 `wss://`，路径是 `/v1/sessions/ws/{sessionId}/subscribe`，并在 query 中带 `organization_uuid`。认证通过 `Authorization: Bearer ...` header 和固定的 `anthropic-version` header 完成。Bun 与 Node `ws` 分支使用不同代理/TLS 适配，但都在连接打开后才把状态改成 `connected`。

它的消息校验只要求对象有字符串 `type`，让服务端新增类型可以穿过 transport 层；真正的类型分派留给 `RemoteSessionManager` 和后续 adapter，下游通过未知 type 分支保持兼容。

## Direct Connect：另一扇门，同一套结构化协议

Direct Connect 采用独立建连路径：客户端先向指定 server 创建 session、校验返回值，再连接 server 提供的 `wsUrl`。claude.ai Remote Control 则使用前面的远程 session 服务。

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

`createDirectConnectSession()` 位于 `restored-src/src/server/createDirectConnectSession.ts`。`serverUrl` 是开放 URL 输入，静态源码未限制候选集合；`authToken` 可为 `undefined`，此时省略 Bearer header；`cwd` 是希望 server 使用的工作目录；`dangerouslySkipPermissions` 只有严格为真时才把 `dangerously_skip_permissions: true` 写入请求体，`false` 或 `undefined` 都省略该字段。

请求对象的 `method` 固定为 `'POST'`，`headers` 固定包含 `content-type: application/json` 并在有 token 时追加 `authorization`；body 始终写 `cwd`，危险权限字段按上面的布尔分支条件展开。`resp` 是 fetch 返回的 `Response`，网络异常被包装为 `DirectConnectError`，随后还要通过 HTTP 状态与 `connectResponseSchema().safeParse()` 校验。`result.success: false` 使用 schema error 终止，成功时 `data.session_id`、`data.ws_url` 分别写入返回配置的 `sessionId`、`wsUrl`，原 `serverUrl`、`authToken` 也随 `config` 保留，`data.work_dir` 则成为 `workDir`。

`DirectConnectSessionManager` 连接 `wsUrl` 后按换行拆分 JSON，每一行都是 Structured IO 消息。普通 assistant/result/system 交给 `onMessage`，`can_use_tool` 控制请求交给 `onPermissionRequest`，用户输入被编码成 `type: 'user'`，中断则编码成 subtype 为 `interrupt` 的 `control_request`。

它与 `RemoteSessionManager` 有一个明显差异：当前 `DirectConnectSessionManager` 的 `close` 只调用 `onDisconnected`；需要恢复时，外层必须重新创建 manager 或自行处理 session 生命周期。

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

`handleClose(closeCode)` 位于 `restored-src/src/remote/SessionsWebSocket.ts`。`RECONNECT_DELAY_MS` 固定为 2000 毫秒，`MAX_RECONNECT_ATTEMPTS` 把普通重连限制为 5 次，`MAX_SESSION_NOT_FOUND_RETRIES` 给 `4001` 单独提供 3 次线性等待；`PERMANENT_CLOSE_CODES` 当前包含 `4003`。`closeCode` 由 server/transport 提供：`4003` 永久终止，`4001` 使用独立预算，其他 code 只在此前状态为 `connected` 且预算未耗尽时重连。显式 `close()` 会先把 state 设成 `closed` 并清理 timer，close 回调不会再次拉起连接。

本地 Bridge 的恢复目标不同：它要证明当前 environment 仍然拥有 work。poll 返回 environment 丢失、transport epoch 被替换、heartbeat 失败时，它可能重新注册 environment，再尝试 `reconnectSession()` 保留原 `sessionId`；如果原 environment 已过期，才归档旧 session 并创建新 session。源码把 environment 重建上限设为 3 次，并使用 promise guard 合并并发重连，避免两个恢复流程同时替换 transport。

因此有两层恢复：控制端恢复订阅，执行端恢复 worker 所有权。两层成功只证明各自连接与租约恢复；本地工具存活和远端 UI 是否错过瞬时状态仍需额外状态确认。源码提供 sequence number、UUID 去重和重连预算，未提供跨任意网络故障的 exactly-once 证明。

## 安全边界：远程入口仍需逐层检查

最后把几个容易误解的安全结论收紧。

第一，Remote Control 要求访问 token，headless bridge 还要求 workspace 已被信任。`runBridgeHeadless()` 对非 localhost 的明文 `http://` base URL 直接报永久错误，只允许 HTTPS 或 localhost HTTP。

第二，session ingress token、environment secret、OAuth access token 分别服务于不同边界。源码会在每次远端 WebSocket 连接时重新调用 `getAccessToken()`，v2 transport 也提供 per-instance `getAuthToken`，就是为了避免多 session 共用进程级 token 时互相覆盖。

第三，`dangerouslySkipPermissions` 是 Direct Connect 创建 session 时明确上传的危险开关。它为假或未定义时，请求体省略该字段，连接成功也不会改变权限模式。

第四，权限请求的展示端可能缺少远端工具实现。`createToolStub()` 会为本地未知的远端工具构造一个只用于权限 UI 的 stub，并强制 `needsPermissions()` 返回真；stub 的 `call()` 会拒绝执行，真正工具仍在远端执行环境里运行。

这四条共同说明：Bridge 只建立协议边界。输入、输出和控制可以跨机器流动，但 `cwd` 所属、workspace trust、transport 认证、session 关联和工具权限仍要逐层成立。

## 小结

Claude Code 的远程能力可以理解为“本地执行，服务端协调，远端控制”。`runBridgeHeadless()` 或 `initBridgeCore()` 注册 environment 和 session，poll/ACK/heartbeat 维持 worker 所有权；transport 把远端 prompt 送入本地 query loop，再把 `SDKMessage` 写回 session service。权限、取消和模式切换使用独立 control event，不与普通对话文本混在一起。

`RemoteSessionManager` 负责 claude.ai session 的订阅和反向控制，`DirectConnectSessionManager` 则接入 server 返回的 `wsUrl`。它们复用结构化消息思想，却有不同的认证、建连和重连边界。WebSocket、SSE 和 HTTP POST 只是 transport；真正让远程会话可靠的是 session id、worker epoch、sequence high-water mark、UUID 去重、flush gate、明确的权限响应与有限重试。

更准确地说，远程模式复用 Agent 内核，并把原本发生在一台机器上的输入、输出和控制拆成一套需要身份、顺序、恢复与安全边界的分布式协议。

## 留给下一篇的问题

远端与本地运行时能够协作以后，Claude Code 如何记录日志、指标、token 与成本，并把运行状态暴露给诊断和观测系统？

## 参考资料

- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)

- [Claude Code Sessions](https://code.claude.com/docs/en/sessions)

- [Claude Code Model Configuration](https://code.claude.com/docs/en/model-config)

- [Claude Code on Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock)

- [Cloud Providers](https://github.com/anthropics/claude-code-action/blob/main/docs/cloud-providers.md)

- [Multi-provider configuration](https://claude-codex.fr/en/advanced/multi-provider/)

- [Anthropic API vs AWS Bedrock Claude (2026): Which to Use](https://www.respan.ai/articles/claude-vs-bedrock-claude)
