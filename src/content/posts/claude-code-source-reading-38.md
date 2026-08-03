---
title: "Claude Code源码解读38：如何追踪日志、成本与诊断信息"
published: 2026-07-24T16:47:25+08:00
updated: 2026-07-24T16:47:25+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-38/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：**Claude Code 的服务器在整个远程流程中究竟承担什么作用？**

先看一条 prompt 的去向：Remote Control 服务器把本地环境注册成 worker，为 environment 和 session 分配身份，调度 work，转发事件并维护 lease；它不运行本地 query loop。模型请求由本地进程按当前 provider 发出，`Read`、`Bash`、MCP 和权限检查也留在本地；远端页面只是控制与展示端。

这里的“服务器”容易和另外两个概念混在一起：

| 组件 | 所在位置 | 在这条远程链路中的职责 | 是否在这里执行本地工具 |
| --- | --- | --- | --- |
| Remote Control 的 session service | Anthropic 远端 | 认证、environment/session 关联、work 调度、事件中继、租约和重连状态 | 否 |
| 模型 provider 服务 | Anthropic API、Bedrock、Vertex 或 Foundry | 接收本地 query loop 的模型请求并返回模型输出 | 否；它负责推理，不负责本地 `Read`/`Bash` |
| Bridge/worker 进程 | 用户的本地机器 | 保持工作目录、运行 query loop，启动工具和 MCP，连接远端服务 | 是 |

因此，`claude remote-control` 即使被文档称作 server mode，启动的也是本地 worker；它是在等待远端 work 的执行端，不是把项目目录搬到云端的服务器。Remote Control 和 Claude Code on the web 也不是同一条部署路径：后者可以把执行环境放在云端，而前者的关键承诺是继续使用这台本地机器。

## 本章先建立三个概念

- **信号分类**：debug log、event、metric、trace 与用户状态分别服务排错、统计和体验。

- **基数控制**：高基数字段适合 event 与 trace，稳定维度适合 metric 标签。

- **关联坐标**：session、prompt、tool use 和 request ID 把多条观测管道连接到同一次执行。

![日志、事件、指标与 trace 的关联坐标](/images/posts/claude-code-source-reading-38/38-observability-signals-detail-handdrawn.png)

先把“执行事实”“观测信号”和“用户可见状态”分开，后面的五本账才不会互相替代。

## YNM-9527 结束时，用户要的不只是“失败了”

核心任务最后要求：

> 报告根因、改动、测试、成本和遗留风险；失败时保留错误证据。

Claude Code 会把会话、请求、工具和后台任务用可关联的 ID 串起来：debug log 记录现场，diagnostic JSONL 记录严格字段，usage 贡献 token 与成本，events/trace 解释跨模块和跨服务的耗时。服务器可能参与认证、模型请求或遥测，但文件副作用和权限决定仍发生在执行端。

下面从这份事故报告需要的证据开始，区分日志、事件、指标、trace 与 usage 的来源。

## 服务器参与的完整流程

可以把一次远程请求画成下面这条链：

```text
远端输入
  -> session service 校验身份并关联 session
  -> work 被本地 Bridge 轮询、领取、确认
  -> 本地 query loop 调用当前 provider 的模型服务
  -> 本地 Read/Bash/MCP 与权限逻辑执行
  -> SDK 消息和 control event 经 Bridge 回到 session service
  -> 远端客户端展示结果或发出下一次控制
```

源码中的职责边界可以按阶段展开：

| 阶段 | 本地 2.1.88 代码能确认的动作 | 服务器在这一阶段做什么 |
| --- | --- | --- |
| 1. 注册 environment | `registerBridgeEnvironment()` 向 `/v1/environments/bridge` 发送 `machine_name`、`directory`、`branch`、`git_repo_url`、`max_sessions` 和 `worker_type` | 建立或复用 `environment_id`，返回 `environment_secret`，让远端知道“哪台机器、哪个目录”可接收 work，并据此做容量与身份校验。服务器拿到的是注册元数据，不是本地文件系统的执行权。 |
| 2. 创建/关联 session | `createBridgeSession()` 向 `/v1/sessions` 提交 `environment_id`、事件、仓库上下文、模型元数据和可选权限模式 | 保存稳定的 `sessionId`，把远端 UI、environment 和一次 Agent 会话关联起来；会话标题、来源和状态也有了归属。 |
| 3. 调度 work | `pollForWork()` 长轮询 `/v1/environments/{id}/work/poll`；拿到 work 后解出 session ingress token，再调用 `acknowledgeWork()` | 暂存待处理的会话任务，并通过 work ID、ACK 和租约避免同一任务被多个 worker 无序消费。ACK 失败时本地允许服务器重新投递，再由 Bridge 去重和处理。 |
| 4. 转发消息与控制 | `RemoteSessionManager` 用 WebSocket 接收 `SDKMessage`、权限请求和取消事件；用户消息通过 HTTP POST 送回 session；`handleServerControlRequest()` 响应 `interrupt`、`set_model`、`set_permission_mode` 等控制 | 作为协议中继和访问边界，把远端输入送到正确的 session，把本地输出和权限请求送回正确的客户端；它不替本地进程调用工具。 |
| 5. 保活与恢复 | `heartbeatWork()` 定期发送 `workId` 和 session token；收到 401/403 时触发 reconnect，404/410 则视为环境或 work 已失效 | 延长活动 work 的 lease，判断 worker 是否仍然拥有执行权；过期、断线或环境被删除时，服务器可以让任务重新进入可领取状态，Bridge 再重新注册或恢复 session。 |

这里的 ACK 和 heartbeat 不是“网络层 ping”这么简单。ACK 表示本地已经看到某个 work，heartbeat 则表示这个 work 仍由当前 session 执行；服务器据此清理失联 worker 的占用，避免远端一直看到一个实际上已经死掉的会话。源码能确认的是有限重试、重新排队和租约状态，不能据此宣称跨任意网络故障提供 exactly-once 执行。

## 服务器不负责什么

第一，它不替本地 query loop 运行工具。`Read` 的路径解析、`Bash` 的子进程、MCP client 的连接和 workspace trust 都在 Bridge 所在机器上；`runBridgeHeadless()` 甚至在注册前就检查本地 workspace 是否已经被信任。服务器可以拒绝未认证的 work 或控制事件，却不能绕过本地 trust 和权限策略直接打开文件。

第二，它不等同于模型 provider。Remote Control 的 session API 里可以记录当前模型作为会话上下文，但本地 Agent 仍按当前 provider 选择和凭证策略发起模型请求。把“session service”“Anthropic 模型 API”“本地 Bridge”统称为 Claude 服务器，会误以为所有代码和数据都在同一个云端进程里执行。

第三，它不是让浏览器直接暴露一个本地监听端口。典型流程是本地进程主动建立出站连接或轮询远端接口，远端客户端只通过受认证的 session 通道收发协议事件；这样 NAT、防火墙和本地网络都不需要把项目机器暴露到公网。

## 为什么必须有这一层服务器

如果让浏览器直连本地 query loop，就要自行解决端口暴露、身份认证、session 路由、断线重连、重复投递、多个远端设备同时观看和权限请求回传。session service 把这些问题收敛成控制面：本地只需证明“我拥有这个 environment”，远端只需证明“我被允许访问这个 session”，双方不必互相暴露完整运行环境。

所以更准确的总结是：**服务器保存和转发“谁在什么环境里运行哪一个会话、当前有哪些 work、哪些控制需要确认”；本地 Bridge 保存并执行“这个会话具体要对哪些文件、进程和工具做什么”。** 远程能力的核心不是把本地执行搬走，而是用服务器把一次单机交互拆成可认证、可路由、可恢复的分布式协议。

## 先把“可观测性”拆成五本账

我们先看整体关系。

![Claude Code 日志、遥测、成本与诊断旁路](/images/posts/claude-code-source-reading-38/38-observability-cost-diagnostics-handdrawn.png)

这五本账各自保留独立出口：

1. debug log 回答“当时具体发生了什么”；
2. diagnostic JSONL 回答“受控运行环境处于哪个阶段、耗时多久”；
3. analytics events 回答“某类功能或结果是否发生”；
4. OpenTelemetry metrics / logs / traces 回答“外部观测系统怎样接入”；
5. session cost state 回答“本次会话用了多少 token、花费多少、耗时多久”。

把它们分开有两个直接好处。第一，详细日志可以留在本地，而低基数指标可以进入聚合系统；第二，用户可见状态不必依赖远端 exporter，`/cost` 和 `/status` 仍然可以从本地状态与检查器构造结果。

下面沿一次 API 调用结束后的路径，把这五本账串起来。

## 第一层：debug log 是本地排错现场

遇到 API request id 或 sandbox 错误时，先看 debug log，而不是先查 metrics。`logForDebugging()` 先检查测试环境、debug 开关和 `--debug=pattern` 过滤器，消息通过后才进入 writer；这条路径故意保留更多现场细节。

```ts
function shouldLogDebugMessage(message: string): boolean {
  if (process.env.NODE_ENV === 'test' && !isDebugToStdErr()) {
    return false
  }

  if (process.env.USER_TYPE !== 'ant' && !isDebugMode()) {
    return false
  }

  if (
    typeof process === 'undefined' ||
    typeof process.versions === 'undefined' ||
    typeof process.versions.node === 'undefined'
  ) {
    return false
  }

  const filter = getDebugFilter()
  return shouldShowDebugMessage(message, filter)
}
```

函数说明：这段来自 `restored-src/src/utils/debug.ts` 的 `shouldLogDebugMessage()`，仅省略源码注释。它只决定一条 debug 消息是否有资格继续写出，不负责脱敏，也不代表消息已经落盘。

参数说明：`message` 是待判断的任意字符串；`NODE_ENV === 'test'` 且省略 `--debug-to-stderr` 时直接丢弃。外部用户默认还需要启用 debug 模式；`isDebugMode()` 可由运行期开关、`DEBUG`、`DEBUG_SDK`、`--debug`、`-d`、`--debug=...` 或 `--debug-file` 等路径触发。`getDebugFilter()` 零匹配时返回 `null`，此时由 `shouldShowDebugMessage()` 的无过滤规则决定是否显示。

真正写出时，debug 模式走同步 append；内部用户未显式开启 debug 时可以走缓冲路径。这个差异是为了进程退出时不丢关键记录，同时避免常态下每条消息都同步 I/O。

```ts
function getDebugWriter(): BufferedWriter {
  if (!debugWriter) {
    let ensuredDir: string | null = null
    debugWriter = createBufferedWriter({
      writeFn: content => {
        const path = getDebugLogPath()
        const dir = dirname(path)
        const needMkdir = ensuredDir !== dir
        ensuredDir = dir
        if (isDebugMode()) {
          // immediateMode: must stay sync. Async writes are lost on direct
          // process.exit() and keep the event loop alive in beforeExit
          // handlers (infinite loop with Perfetto tracing). See #22257.
          if (needMkdir) {
            try {
              getFsImplementation().mkdirSync(dir)
            } catch {
              // Directory already exists
            }
          }
          getFsImplementation().appendFileSync(path, content)
          void updateLatestDebugLogSymlink()
          return
        }
        // Buffered path (ants without --debug): flushes ~1/sec so chain
        // depth stays ~1. .bind over a closure so only the bound args are
        // retained, not this scope.
        pendingWrite = pendingWrite
          .then(appendAsync.bind(null, needMkdir, dir, path, content))
          .catch(noop)
      },
      flushIntervalMs: 1000,
      maxBufferSize: 100,
      immediateMode: isDebugMode(),
    })
    registerCleanup(async () => {
      debugWriter?.dispose()
      await pendingWrite
    })
  }
  return debugWriter
}
```

函数说明：这段同样来自 `debug.ts` 的 `getDebugWriter()`。debug 模式同步写入并更新 `latest` 软链接；缓冲模式大约每秒 flush，一次最多缓存 100 条，并用 `pendingWrite` 保持异步写入顺序。cleanup 会 dispose writer，再等待未完成的异步写入。

参数说明：`writeFn` 接收已经格式化的日志文本；`flushIntervalMs: 1000` 是毫秒；`maxBufferSize: 100` 是触发 flush 的缓冲条目上限；`immediateMode` 是布尔值。日志路径优先取 `--debug-file`，其次是 `CLAUDE_CODE_DEBUG_LOGS_DIR`，否则回退到 `~/.claude/debug/<sessionId>.txt` 一类会话路径。debug 文本可携带路径、错误消息和其他细节，安全处理应按潜在敏感日志执行。

这一本账适合回答连接错误、请求 ID、沙箱失败等具体问题。比如 `logAPIError()` 会把 `x-client-request-id` 写进 debug log，方便服务端关联；代价是它天然更接近排错现场，不适合直接当聚合指标使用。

## 第二层：diagnostic JSONL 是严格约束字段的运行记录

另一个容易与 debug log 混淆的模块是 `utils/diagLogs.ts`。它生成供环境管理器和 session ingress 消费的结构化文件；源码注释明确要求调用者排除 PII，包括文件路径、项目名、仓库名和 prompt。

```ts
export function logForDiagnosticsNoPII(
  level: DiagnosticLogLevel,
  event: string,
  data?: Record<string, unknown>,
): void {
  const logFile = getDiagnosticLogFile()
  if (!logFile) {
    return
  }

  const entry: DiagnosticLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    data: data ?? {},
  }

  const fs = getFsImplementation()
  const line = jsonStringify(entry) + '\n'
  try {
    fs.appendFileSync(logFile, line)
  } catch {
    try {
      fs.mkdirSync(dirname(logFile))
      fs.appendFileSync(logFile, line)
    } catch {
      // Silently fail if logging is not possible
    }
  }
}
```

函数说明：这段来自 `restored-src/src/utils/diagLogs.ts`，仅省略源码注释。`CLAUDE_CODE_DIAGNOSTICS_FILE` 缺失时函数直接返回；有路径时，每个事件写成一行 JSON。第一次 append 失败后会尝试创建父目录再写一次，第二次仍失败则静默放弃。

参数说明：`timestamp` 在写入时由 `new Date().toISOString()` 生成，用于给每条 JSONL 事件提供 UTC 时间；`level` 的源码可选值只有 `'debug' | 'info' | 'warn' | 'error'`，这里只作为信息字段，不执行级别过滤；`event` 是调用方定义的事件名；`data` 可省略，`undefined` 时回退为空对象。函数名里的 `NoPII` 是调用契约；实现直接序列化 `data`，所以安全性依赖调用点主动排除路径和 prompt。

为了让“开始、结束、失败”形成统一结构，源码还提供了计时包装器。

```ts
export async function withDiagnosticsTiming<T>(
  event: string,
  fn: () => Promise<T>,
  getData?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const startTime = Date.now()
  logForDiagnosticsNoPII('info', `${event}_started`)
  try {
    const result = await fn()
    const additionalData = getData ? getData(result) : {}
    logForDiagnosticsNoPII('info', `${event}_completed`, {
      duration_ms: Date.now() - startTime,
      ...additionalData,
    })
    return result
  } catch (error) {
    logForDiagnosticsNoPII('error', `${event}_failed`, {
      duration_ms: Date.now() - startTime,
    })
    throw error
  }
}
```

函数说明：`withDiagnosticsTiming()` 给异步操作补上 `<event>_started`、`<event>_completed` 或 `<event>_failed` 三种事件，并在完成与失败时记录 `duration_ms`。原函数异常会继续抛出，诊断旁路不会吞掉业务错误。

参数说明：`event` 是开放字符串前缀；`fn` 必须返回 `Promise<T>`；`getData` 可为 `undefined`，存在时只在成功分支根据结果补字段。`getData` 返回什么仍受 No PII 契约约束。

这种格式把远端容器故障拆成两类：`started` 后缺失 `completed` 表示操作未正常收尾，`completed` 携带很大的 `duration_ms` 表示操作完成但耗时异常。结构化事件保留了这个差别，又避免为了诊断直接收集完整 prompt。

## 第三层：analytics event 与 OpenTelemetry 各走一条管道

Claude Code 同时存在第一方 analytics 与 OpenTelemetry。两者会在相同业务点被调用，但发送协议和配置不同。

```ts
export function logEvent(
  eventName: string,
  metadata: LogEventMetadata,
): void {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: false })
    return
  }
  sink.logEvent(eventName, metadata)
}
```

函数说明：这段来自 `restored-src/src/services/analytics/index.ts`。sink 尚未初始化时，事件先进入内存队列；初始化后直接交给 sink。源码中的 `LogEventMetadata` 类型刻意限制字符串字段，降低误传代码和路径的机会；显式类型断言仍可绕过该限制，因此它只提供开发期类型护栏。

参数说明：`eventName` 是开放字符串，由各调用点定义；`metadata` 是受类型约束的对象；队列项的 `async: false` 只标记同步入口类型，远端发送时序由 sink 自己决定。

第一方事件还可以按事件名采样：无配置、配置非法或采样率为 1 时返回 `null`，下游按未采样事件处理；0 表示丢弃；0 到 1 之间随机决定是否保留，并在保留时携带实际采样率。

```ts
export function shouldSampleEvent(eventName: string): number | null {
  const eventConfig = getEventSamplingConfig()[eventName]
  if (!eventConfig) return null

  const sampleRate = eventConfig.sample_rate
  if (typeof sampleRate !== 'number' || sampleRate < 0 || sampleRate > 1) {
    return null
  }
  if (sampleRate >= 1) return null
  if (sampleRate <= 0) return 0
  return Math.random() < sampleRate ? sampleRate : 0
}
```

函数说明：这段来自 `restored-src/src/services/analytics/firstPartyEventLogger.ts`。`shouldSampleEvent()` 先用 `eventName` 取得 `eventConfig`，再把其中的 `sample_rate` 规范为局部变量 `sampleRate`。返回值采用 `number | null`，让保留事件时还能把实际采样率带给下游，便于聚合时理解样本权重。

参数说明：`eventName` 用来从运行时采样配置取规则；`sample_rate` 的有效闭区间是 0 到 1。返回 `null` 时下游不附加抽样权重并保留事件，返回 `0` 时丢弃，返回 0 到 1 的数值时保留事件并把该值作为采样率。

OpenTelemetry 是另一条用户可配置出口。`CLAUDE_CODE_ENABLE_TELEMETRY` 为 truthy 时，初始化逻辑才装载 OTLP readers、logs exporter；增强 tracing 还要再满足独立开关。即使第三方 OTLP 关闭，metrics provider 仍可能承载内部 BigQuery reader。

```ts
const telemetryEnabled = isTelemetryEnabled()
if (telemetryEnabled) {
  readers.push(...(await getOtlpReaders()))
}
if (isBigQueryMetricsEnabled()) {
  readers.push(getBigQueryExportingReader())
}

const meterProvider = new MeterProvider({ resource, views: [], readers })
```

函数说明：这段来自 `restored-src/src/utils/telemetry/instrumentation.ts` 的 `initializeTelemetry()`，省略了 resource detector、logs/traces provider 和 shutdown 注册。meter provider 的创建条件同时考虑内部 reader；第三方 OTLP 则由独立环境开关控制。

参数说明：`CLAUDE_CODE_ENABLE_TELEMETRY` 交给 `isEnvTruthy()` 解析；为真时把 OTLP readers 追加到 `readers`。`isBigQueryMetricsEnabled()` 独立决定是否追加内部 reader，因此 `telemetryEnabled` 为假也可能创建带 reader 的 `meterProvider`；`resource` 提供公共属性，`views: []` 表示这里不额外注册 metric view。

`logOTelEvent()` 还刻意区分 events 与 metrics 的字段基数：prompt ID、workspace host paths 可以加入事件，却不应该成为 metric dimensions，否则会产生近乎无限的标签组合。

```ts
const attributes: Attributes = {
  ...getTelemetryAttributes(),
  'event.name': eventName,
  'event.timestamp': new Date().toISOString(),
  'event.sequence': eventSequence++,
}

const promptId = getPromptId()
if (promptId) {
  attributes['prompt.id'] = promptId
}
```

函数说明：这段来自 `restored-src/src/utils/telemetry/events.ts` 的 `logOTelEvent()`，省略了 workspace paths 和自定义 metadata 合并。事件带时间戳与进程内递增序号；event logger 缺失或处于测试环境时直接返回。

参数说明：`eventName` 是开放字符串；`metadata` 默认 `{}`，值只能是 `string | undefined`，其中 `undefined` 字段会跳过；`eventSequence` 只在当前进程递增。用户 prompt 内容默认经 `redactIfDisabled()` 变成 `'<REDACTED>'`，只有 `OTEL_LOG_USER_PROMPTS` 被 `isEnvTruthy()` 判定为真时才保留原文。该开关只覆盖使用这个 helper 的内容路径，debug 与 analytics 仍需各自执行敏感信息策略。

字段装配顺序也会影响覆盖：`attributes` 先展开 `getTelemetryAttributes()` 的会话公共属性，再固定写入 `'event.name'`、ISO 格式的 `'event.timestamp'` 和自增后的 `'event.sequence'`。`promptId` 来自当前 prompt 上下文；值为真时追加 `'prompt.id'`，空值时保持字段缺席，从而避免制造空标签。

## 第四层：token、成本和指标从同一份 Usage 分叉

模型响应携带 `Usage` 后，Claude Code 会同时更新会话内状态和 OpenTelemetry counter。成本按输入、输出、缓存读、缓存写以及 web search 请求分别乘以模型费率后累加。

```ts
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}
```

函数说明：这段来自 `restored-src/src/utils/modelCost.ts`。前四项按每百万 token 计价，web search 按请求数计价；`calculateUSDCost()` 会先根据解析后的模型名和 `usage.speed` 选择 `ModelCosts`，再调用此函数。

参数说明：`modelCosts` 包含 `inputTokens`、`outputTokens`、`promptCacheReadTokens`、`promptCacheWriteTokens`、`webSearchRequests` 五个单价；`usage.input_tokens` 与 `usage.output_tokens` 必须存在，缓存 token、`server_tool_use` 和 `web_search_requests` 可为 `undefined`，源码统一回退到 0。未知模型会记录 `tengu_unknown_model_cost`，再回退到默认主循环模型费率或 `DEFAULT_UNKNOWN_MODEL_COST`，因此显示结果可能不准确，`formatTotalCost()` 会附加警告。

得到单次成本后，`addToTotalSessionCost()` 一边累计本地状态，一边给 metric counter 增量。

```ts
export function addToTotalSessionCost(
  cost: number,
  usage: Usage,
  model: string,
): number {
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  addToTotalCostState(cost, modelUsage, model)

  const attrs =
    isFastModeEnabled() && usage.speed === 'fast'
      ? { model, speed: 'fast' }
      : { model }

  getCostCounter()?.add(cost, attrs)
  getTokenCounter()?.add(usage.input_tokens, { ...attrs, type: 'input' })
  getTokenCounter()?.add(usage.output_tokens, { ...attrs, type: 'output' })
  getTokenCounter()?.add(usage.cache_read_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheRead',
  })
  getTokenCounter()?.add(usage.cache_creation_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheCreation',
  })

  let totalCost = cost
  for (const advisorUsage of getAdvisorUsage(usage)) {
    const advisorCost = calculateUSDCost(advisorUsage.model, advisorUsage)
    logEvent('tengu_advisor_tool_token_usage', {
      advisor_model:
        advisorUsage.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      input_tokens: advisorUsage.input_tokens,
      output_tokens: advisorUsage.output_tokens,
      cache_read_input_tokens: advisorUsage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens:
        advisorUsage.cache_creation_input_tokens ?? 0,
      cost_usd_micros: Math.round(advisorCost * 1_000_000),
    })
    totalCost += addToTotalSessionCost(
      advisorCost,
      advisorUsage,
      advisorUsage.model,
    )
  }
  return totalCost
}
```

函数说明：这段来自 `restored-src/src/cost-tracker.ts`。函数先更新本地 `ModelUsage` 和总成本状态，再增量写 counter。`?.add` 表明 counter 尚未初始化时不会抛错；advisor 返回的附加 usage 会根据自己的模型重新计价并递归累计，所以函数返回值可能大于最初传入的 `cost`。

参数说明：`cost` 是本次主 usage 的美元数；`usage` 是 API usage；`model` 是已经解析的开放模型字符串。metric 的 `type` 只有源码列出的 `'input'`、`'output'`、`'cacheRead'`、`'cacheCreation'`；`speed: 'fast'` 只在全局 fast mode 已启用且本次 `usage.speed === 'fast'` 时出现，否则 attributes 只有 `model`。

内部字段按两段累计：`modelUsage` 是 `addToTotalModelUsage()` 返回的分模型快照，并与 `cost`、`model` 一起交给 `addToTotalCostState()`；`attrs` 为成本和四类 token counter 提供公共标签，`usage.input_tokens`、`usage.output_tokens` 直接写入，`usage.cache_read_input_tokens`、`usage.cache_creation_input_tokens` 通过 `?? 0` 写入。`totalCost` 先等于主调用 `cost`；每个 `advisorUsage` 再计算 `advisorCost`，把 `advisor_model`、`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` 和微美元 `cost_usd_micros` 写入 analytics，随后递归调用 `addToTotalSessionCost()` 并返回包含 advisor 的总成本。

metric 名称由 `setMeter()` 集中注册，包括 `claude_code.cost.usage`（单位 USD）、`claude_code.token.usage`（单位 tokens），以及 session、代码行、PR、commit、权限决策与 active time 等 counter。每次 `add()` 都重新合并 `getTelemetryAttributes()`，让会话属性保持最新。

这里体现了 events 与 metrics 的分工：API success event 可以带 request ID、stop reason、retry duration 等关联信息；counter 的标签更克制，适合聚合。若把每个 request ID 都放进 token counter，指标系统就会退化成另一份昂贵日志。

## 第五层：成本可恢复，状态可直接给用户看

观测数据如果只存在内存里，resume 会话时 `/cost` 就会突然归零。Claude Code 因此把最后一次会话的成本、API 耗时、工具耗时、代码变更、各类 token 和分模型 usage 写入项目配置，并用 session ID 限制恢复范围。

```ts
export function restoreCostStateForSession(sessionId: string): boolean {
  const data = getStoredSessionCosts(sessionId)
  if (!data) return false
  setCostStateForRestore(data)
  return true
}
```

函数说明：这段来自 `restored-src/src/cost-tracker.ts`。`getStoredSessionCosts()` 只有在 `projectConfig.lastSessionId === sessionId` 时返回数据；匹配后才恢复总成本、耗时、代码变更和分模型 usage。

参数说明：`sessionId` 是待恢复会话的开放字符串；`data` 只在 `lastSessionId` 匹配时取得，取不到便返回 `false` 并保持当前成本状态，取得后交给 `setCostStateForRestore()` 并返回 `true`。持久数据中省略的数值字段由恢复器按 `?? 0` 初始化，省略 `modelUsage` 时从空的分模型统计开始。

`/cost` 读取的正是这套本地状态。API 用户会看到格式化后的总成本、API/wall duration、代码变更和分模型 token；Claude.ai 订阅用户通常看到订阅或 overage 状态。源码里的 cost tracker 提供运行时估算与诊断，最终结算仍以服务端账单系统为准。

`/status` 聚合安装、配置和上下文健康检查，把底层遥测转换成可行动结论。

```ts
export async function buildDiagnostics(): Promise<Diagnostic[]> {
  return [...(await buildInstallationDiagnostics()), ...(await buildInstallationHealthDiagnostics()), ...(await buildMemoryDiagnostics())];
}
```

函数说明：这段来自 `restored-src/src/components/Settings/Status.tsx`。三个检查按顺序执行并合并：安装检查、安装健康检查、memory 文件检查。返回空数组时 `Diagnostics` 组件渲染为 `null`，有问题时才展示 `System Diagnostics`。

参数说明：`buildDiagnostics()` 接受零个参数。三个子函数都返回 `Promise<Diagnostic[]>`；安装健康检查会报告无效 settings、doctor warnings 和缺少自动更新写权限，memory 检查会报告超过 `MAX_MEMORY_CHARACTER_COUNT` 的文件。

这解释了“暴露运行状态”的最后一公里：`/status` 把 OTel 与本地检查结果收敛为当前上下文里的可行动结论——哪里安装异常、哪里配置无效、哪个 memory 文件过大。

## 隐私边界：开关、类型与调用约定各管一层

源码按通道采用多层隐私约束：

- diagnostic JSONL 用 `NoPII` 调用契约，明确禁止路径、项目名和 prompt；
- analytics metadata 用类型限制普通字符串，敏感调用点需要显式确认；
- OTel prompt 内容默认 `'<REDACTED>'`，只有 `OTEL_LOG_USER_PROMPTS` truthy 时放行；
- metrics 避免 prompt ID、workspace path 这类高基数字段；
- account status 在 `IS_DEMO` 环境下不显示 organization 与 email；
- debug log 面向本地排错，可能包含更详细的错误和路径，不能与 No PII 通道混为一谈。

同时还要区分两个看起来相近的总开关。第三方 OpenTelemetry 由 `CLAUDE_CODE_ENABLE_TELEMETRY` 控制；第一方 analytics 的 `isAnalyticsDisabled()` 还会在测试、Bedrock、Vertex、Foundry 或 telemetry-disabled 条件下关闭。两套系统共享部分业务事件来源，各自拥有独立启停条件。

因此，阅读任何一个 `logEvent()` 或 `logOTelEvent()` 调用点时，都要继续追三件事：字段是怎样构造的、当前 sink/exporter 是否启用、内容是否经过对应通道的隐私规则。只看到函数名就断言“Claude Code 上传了某段内容”，证据是不够的。

## 为什么观测失败不能拖垮 Agent

观测是旁路，就意味着它必须有自己的失败语义。源码里能看到几种典型处理：

- diagnostic 文件不存在时直接返回，append 最终失败时静默放弃；
- debug 缓冲写入的 promise 用 `.catch(noop)` 避免未处理异常；
- OTel event logger 未初始化时丢弃事件，只向 debug log 警告一次；
- 进程退出时 telemetry flush 与 shutdown 受 `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS` 限制，默认回退字符串是 `2000` 毫秒；
- startup perf 只有被抽样且确实存在 performance marks 时才发送；
- `/status` 和 `/cost` 依赖本地状态与检查器，不要求 exporter 在线。

旁路失败策略让 Bash、Edit 或 API 请求保留原业务结果，同时单独记录观测故障；这样遥测后端抖动不会连带终止 Agent 主循环。

调用图还能确认，API 成功路径会同时调用 `logAPISuccess()`、`logOTelEvent('api_request', ...)` 和 span 结束逻辑；错误路径调用 `logEvent('tengu_api_error', ...)`、`logOTelEvent('api_error', ...)` 与失败 span。成功事件记录 input/output/cache token、cost、duration、speed；错误事件记录 model、error、status、duration、attempt。它们共同提供关联线索，但各 exporter 是否真正抵达后端、真实采样率、线上延迟和最终账单，都超出了 2.1.88 静态源码能证明的范围。

## 小结

Claude Code 的可观测性是一组按用途拆开的旁路。

debug log 保存本地排错细节；diagnostic JSONL 用结构化 started/completed/failed 事件观察受控环境；analytics 和 OpenTelemetry 分别承载产品事件与可配置的 logs、metrics、traces；cost tracker 从模型 Usage 精确拆分输入、输出、缓存和 web search，既更新本地会话状态，也更新低基数 counter；`/cost` 与 `/status` 再把用户真正能行动的信息显示出来。

这种设计依靠边界清楚：内容与指标分开，本地与远端分开，估算成本与账单分开，观测失败与运行时失败分开。保留这些边界后，日志才能解释系统，同时避免介入业务控制流。

## 留给下一篇的问题

近来有报道称，Claude Code 的指标上报可能留有后门，甚至被用于识别中国用户；从 2.1.88 的源码中，能看出这类行为吗？

## 参考资料

- [Claude Code Monitoring](https://code.claude.com/docs/en/monitoring-usage)

- [Claude Code Costs](https://code.claude.com/docs/en/costs)

- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)

- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)

- [Bridge Loop and Session Spawning](https://deepwiki.com/sanbuphy/claude-code-source-code/6.1-bridge-loop-and-session-spawning)

- [Claude Code Remote Control: A Guide For Beginners](https://www.datacamp.com/tutorial/claude-code-remote-control)

- [Anthropic reveals Remote Control, a mobile version of Claude Code](https://www.techradar.com/pro/anthropic-reveals-remote-control-a-mobile-version-of-claude-code-to-keep-you-productive-on-the-move)
