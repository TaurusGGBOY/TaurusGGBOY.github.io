---
title: "Claude Code源码解读38：如何追踪日志、成本与诊断信息"
published: 2026-07-24T16:47:25+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-38/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇留下的问题是，**Claude Code 的服务器在整个远程流程中究竟承担什么作用？**

先看一条 prompt 的去向，Remote Control 服务器把本地环境注册成 worker，为 environment 和 session 分配身份，调度 work，转发事件并维护 lease；它不运行本地 query loop。模型请求由本地进程按当前 provider 发出，`Read`、`Bash`、MCP 和权限检查也留在本地；远端页面只是控制与展示端。

这里的“服务器”容易和另外两个概念混在一起，

| 组件 | 所在位置 | 在这条远程链路中的职责 | 是否在这里执行本地工具 |
| --- | --- | --- | --- |
| Remote Control 的 session service | Anthropic 远端 | 认证、environment/session 关联、work 调度、事件中继、租约和重连状态 | 否 |
| 模型 provider 服务 | Anthropic API、Bedrock、Vertex 或 Foundry | 接收本地 query loop 的模型请求并返回模型输出 | 否；它负责推理，不负责本地 `Read`/`Bash` |
| Bridge/worker 进程 | 用户的本地机器 | 保持工作目录、运行 query loop，启动工具和 MCP，连接远端服务 | 是 |

因此，`claude remote-control` 即使被文档称作 server mode，启动的也是本地 worker；它是在等待远端 work 的执行端，不是把项目目录搬到云端的服务器。Remote Control 和 Claude Code on the web 也不是同一条部署路径，后者可以把执行环境放在云端，而前者的关键承诺是继续使用这台本地机器。

## 介绍本章的一些概念

- 可观测性是**五本独立记账的旁路**，debug log（本地排错现场）、diagnostic JSONL（严格字段的受控环境记录）、analytics events（功能是否发生）、OpenTelemetry（外部观测系统接入）、session cost state（token/成本/耗时）。它们各自保留独立出口，观测失败不能拖垮 Agent。
- debug log 有**双模式写入**，`isDebugMode()` 为真时同步 append（进程直接 `exit()` 不丢记录），否则走 BufferedWriter（约每秒 flush、最多缓存 100 条，`pendingWrite` 保持顺序）；`shouldLogDebugMessage()` 先过滤测试环境、开关与 `--debug=pattern`。
- diagnostic JSONL 是 **No PII 调用契约**，`logForDiagnosticsNoPII()` 要求调用者排除路径、项目名和 prompt；`withDiagnosticsTiming()` 把异步操作补成 `<event>_started / _completed / _failed` 三种事件并记录 `duration_ms`，`started` 后缺失 `completed` 表示操作未正常收尾。
- 成本从**同一份 Usage 分叉**，`tokensToUSDCost()` 按输入/输出/缓存读/缓存写/每百万 token 计价、web search 按请求计价；`addToTotalSessionCost()` 一边更新本地状态，一边给低基数 metric counter 增量（`type` 只有 `input/output/cacheRead/cacheCreation`），并递归累计 advisor usage。
- `/cost` 与 `/status` 依赖**本地状态与检查器**，不要求 exporter 在线，`restoreCostStateForSession()` 只在 `projectConfig.lastSessionId === sessionId` 时恢复；`buildDiagnostics()` 聚合安装、安装健康与 memory 三类检查。

> ⚠️ **证据边界**，本文所有代码来自 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` source map 还原源码。`restored-src/` 只用于定位证据，不等同于 Anthropic 内部仓库原始目录；代码块只保留证明控制流所需的字段，`// ...` 表示省略埋点、UI 消息与无关分支。各 exporter 是否真正抵达后端、真实采样率、线上延迟和最终账单，超出静态源码能证明的范围。

## 本篇新增机制

37 解释了远程链路的执行端/会话服务/控制端分工。本篇回答观测的问题，**一次执行过后，怎样回答"发生了什么、花了多少、失败在哪"？** 它把日志、事件、指标、trace 与 usage 拆成五本账，并给出把 session、request、tool use、task 与 cost 关联起来的坐标。读懂这篇，就能在"测试失败"之外给出可审计的结论，debug log 记录现场，diagnostic JSONL 记录阶段与耗时，usage 贡献 token 与成本，events/trace 解释跨模块耗时。它是 39（更新与迁移）的对照面，`/status` 的健康检查正是 39 篇启动链路的结果展示。

## 问题现场

屏幕上如果只写一句"测试失败"，接班的人仍不知道失败发生在模型请求、MCP 查询、浏览器依赖，还是修复后的金额断言。若把详细日志直接送进聚合系统，路径和 prompt 会变成高基数字段；若把高基数字段塞进 metric 标签，指标系统就退化成另一份昂贵日志。真正需要的是，**信号分类**（debug log、event、metric、trace 与用户状态各服务排错、统计和体验）、**基数控制**（高基数字段适合 event 与 trace，稳定维度适合 metric 标签）、**关联坐标**（session、prompt、tool use 和 request ID 把多条观测管道连接到同一次执行）。

![日志、事件、指标与 trace 的关联坐标](/images/posts/claude-code-source-reading-38/38-observability-signals-detail-handdrawn.png)

先把"执行事实""观测信号"和"用户可见状态"分开，后面的五本账才不会互相替代。

## 正文

### 这张金额单位工单结束时，用户要的不只是"失败了"

17，42，工程师准备在发布群里更新工单。屏幕上的报告需要同时回答"根因是什么、改了什么、测试结果、花了多少钱、有没有遗留风险"。于是他给最后一轮任务加上验收格式，

> 报告根因、改动、测试、成本和遗留风险；失败时保留错误证据。列出可关联的会话、工具调用和后台任务信息，但不要泄露凭据或完整客户数据。

Claude Code 会把会话、请求、工具和后台任务用可关联的 ID 串起来，debug log 记录现场，diagnostic JSONL 记录严格字段，usage 贡献 token 与成本，events/trace 解释跨模块和跨服务的耗时。服务器可能参与认证、模型请求或遥测，但文件副作用和权限决定仍发生在执行端。这样发布群里看到的是可审计的结论，接班人还能沿 ID 回到具体证据，而不是一段无法复核的长文本。

### 先把"可观测性"拆成五本账

![Claude Code 日志、遥测、成本与诊断旁路](/images/posts/claude-code-source-reading-38/38-observability-cost-diagnostics-handdrawn.png)

这五本账各自保留独立出口，

1. debug log 回答"当时具体发生了什么"；
2. diagnostic JSONL 回答"受控运行环境处于哪个阶段、耗时多久"；
3. analytics events 回答"某类功能或结果是否发生"；
4. OpenTelemetry metrics / logs / traces 回答"外部观测系统怎样接入"；
5. session cost state 回答"本次会话用了多少 token、花费多少、耗时多久"。

把它们分开有两个直接好处。第一，详细日志可以留在本地，而低基数指标可以进入聚合系统；第二，用户可见状态不必依赖远端 exporter，`/cost` 和 `/status` 仍然可以从本地状态与检查器构造结果。

### 真实 trace 夹具｜一次金额单位工单的完整关联链

下面是一个**演示性 trace 夹具**（fixture），把本系列各篇出现的字段按真实链路串起来。它由 2.1.88 各模块的字段构成，会话、时间与数字为演示值，它演示的是"哪些 ID 能把观测串起来"，不是某个真实会话的截图，

```text
session: f3b8a2c1-4d7e-4a1f-9c2b-0e5d6a7b8c9d (worktree: payment-service @ branch fix/amount-unit)
  task: task_7f3a "调查金额单位差异" (subagent: leader)
    request: req_01HXA8K2MQ -> model: claude-sonnet-4.6 (firstParty, thinking: adaptive)
      turn 1: tool_use read  -> tool_use_id: toolu_01A  result: file payment/checkout.ts (0.9k tokens)
      turn 2: tool_use bash  -> tool_use_id: toolu_01B  result: grep -n "unit" (1.2k tokens)
      turn 3: tool_use read  -> tool_use_id: toolu_01C  result: payment/callback.ts (0.8k tokens)
      turn 4: assistant 给出证据与计划; stop_reason: end_turn
      usage: input 4_212 + cache_read 18_420 + cache_creation 6_040 + output 1_138
      cost: 0.0211 USD (cache_read 0.90/M, input 3/M, output 15/M)
    request: req_01HXA9C2BQ -> model: claude-sonnet-4.6
      turn 5: tool_use edit  -> tool_use_id: toolu_01D  result: 修正 9991 -> 99.91 单位换算
      turn 6: tool_use bash  -> tool_use_id: toolu_01E  result: 测试通过 (passed 42/42)
      usage: input 9_871 + cache_read 41_240 + cache_creation 0 + output 2_315
      cost: 0.0374 USD
    summary: task cost = 0.0585 USD, duration 3m12s, turns 6, permission_denials: 0
  task: task_8c1b "后台集成测试" (background: true)
    session 级累计: addToTotalSessionCost() 分 model 累加
    /cost 输出: 总成本 0.0585 USD, api 耗时 22.1s, wall 3m12s, tokens by model
  diagnostic JSONL 事件: bridge_work_polled_started -> _completed(duration_ms=120)
    -> session_created_completed(duration_ms=340) -> test_run_completed(duration_ms=81_240)
  debug log: x-client-request-id 与 sandbox 错误现场
  OTel event: api_request(api_request_id=req_01HXA8K2MQ, model, stop_reason, duration_ms)
```

> 证据说明，夹具中的每个字段都来自 2.1.88 源码，`tool_use_id` 关联工具结果（07/09 篇），`request_id` 关联重试与控制（06/34 篇），`taskId` 是 AppState 的开放字符串键（31 篇），`session_id` 是 Bridge 写入事件时的统一字段（37 篇），成本按 `modelCosts` 分项累计（`modelCost.ts`）。夹具只用于演示关联坐标，不是真实会话数据。

这条链的读法是，**request 携带 `api_request_id` 与 usage，usage 分叉成 cost 与 token counter；tool use 通过 `tool_use_id` 挂到 request 与消息；多个 request 归属一个 task（`taskId`），task 与整个 session 通过 `session_id` 关联；`/cost` 与 diagnostic JSONL 从本地状态读取同样的值。** 任一环缺 ID，发布群里的报告就只能回到"测试失败"四个字。

### 第一层｜debug log 是本地排错现场

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

> 证据，`restored-src/src/utils/debug.ts`（2.1.88 source map 还原源码），`shouldLogDebugMessage()`，仅省略源码注释。

这段来自 `restored-src/src/utils/debug.ts`。它只决定一条 debug 消息是否有资格继续写出，不负责脱敏，也不代表消息已经落盘。`message` 是待判断的任意字符串；`NODE_ENV === 'test'` 且省略 `--debug-to-stderr` 时直接丢弃。外部用户默认还需要启用 debug 模式；`isDebugMode()` 可由运行期开关、`DEBUG`、`DEBUG_SDK`、`--debug`、`-d`、`--debug=...` 或 `--debug-file` 等路径触发。`getDebugFilter()` 零匹配时返回 `null`，此时由 `shouldShowDebugMessage()` 的无过滤规则决定是否显示。

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

> 证据，`restored-src/src/utils/debug.ts`（2.1.88 source map 还原源码），`getDebugWriter()`，仅省略源码注释。

debug 模式同步写入并更新 `latest` 软链接；缓冲模式大约每秒 flush，一次最多缓存 100 条，并用 `pendingWrite` 保持异步写入顺序。cleanup 会 dispose writer，再等待未完成的异步写入。`writeFn` 接收已经格式化的日志文本；`flushIntervalMs: 1000` 是毫秒；`maxBufferSize: 100` 是触发 flush 的缓冲条目上限；`immediateMode` 是布尔值。日志路径优先取 `--debug-file`，其次是 `CLAUDE_CODE_DEBUG_LOGS_DIR`，否则回退到 `~/.claude/debug/<sessionId>.txt` 一类会话路径。debug 文本可携带路径、错误消息和其他细节，安全处理应按潜在敏感日志执行。

这一本账适合回答连接错误、请求 ID、沙箱失败等具体问题。比如 `logAPIError()` 会把 `x-client-request-id` 写进 debug log，方便服务端关联；代价是它天然更接近排错现场，不适合直接当聚合指标使用。

### 第二层｜diagnostic JSONL 是严格约束字段的运行记录

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

> 证据，`restored-src/src/utils/diagLogs.ts`（2.1.88 source map 还原源码），`logForDiagnosticsNoPII()`，仅省略源码注释。

`CLAUDE_CODE_DIAGNOSTICS_FILE` 缺失时函数直接返回；有路径时，每个事件写成一行 JSON。第一次 append 失败后会尝试创建父目录再写一次，第二次仍失败则静默放弃。`timestamp` 在写入时由 `new Date().toISOString()` 生成；`level` 的源码可选值只有 `'debug' | 'info' | 'warn' | 'error'`，这里只作为信息字段，不执行级别过滤；`event` 是调用方定义的事件名；`data` 可省略，`undefined` 时回退为空对象。函数名里的 `NoPII` 是调用契约；实现直接序列化 `data`，所以安全性依赖调用点主动排除路径和 prompt。

为了让"开始、结束、失败"形成统一结构，源码还提供了计时包装器，

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

> 证据，`restored-src/src/utils/diagLogs.ts`（2.1.88 source map 还原源码），`withDiagnosticsTiming()`。

`withDiagnosticsTiming()` 给异步操作补上 `<event>_started`、`<event>_completed` 或 `<event>_failed` 三种事件，并在完成与失败时记录 `duration_ms`。原函数异常会继续抛出，诊断旁路不会吞掉业务错误。`event` 是开放字符串前缀；`fn` 必须返回 `Promise<T>`；`getData` 可为 `undefined`，存在时只在成功分支根据结果补字段。`getData` 返回什么仍受 No PII 契约约束。

这种格式把远端容器故障拆成两类，`started` 后缺失 `completed` 表示操作未正常收尾，`completed` 携带很大的 `duration_ms` 表示操作完成但耗时异常。结构化事件保留了这个差别，又避免为了诊断直接收集完整 prompt。

### 第三层｜analytics event 与 OpenTelemetry 各走一条管道

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

> 证据，`restored-src/src/services/analytics/index.ts`（2.1.88 source map 还原源码），`logEvent()`。

sink 尚未初始化时，事件先进入内存队列；初始化后直接交给 sink。源码中的 `LogEventMetadata` 类型刻意限制字符串字段，降低误传代码和路径的机会；显式类型断言仍可绕过该限制，因此它只提供开发期类型护栏。`eventName` 是开放字符串，由各调用点定义；`metadata` 是受类型约束的对象；队列项的 `async: false` 只标记同步入口类型，远端发送时序由 sink 自己决定。

第一方事件还可以按事件名采样，

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

> 证据，`restored-src/src/services/analytics/firstPartyEventLogger.ts`（2.1.88 source map 还原源码），`shouldSampleEvent()`。

`shouldSampleEvent()` 先用 `eventName` 取得 `eventConfig`，再把其中的 `sample_rate` 规范为局部变量 `sampleRate`。返回值采用 `number | null`，让保留事件时还能把实际采样率带给下游，便于聚合时理解样本权重。`sample_rate` 的有效闭区间是 0 到 1。返回 `null` 时下游不附加抽样权重并保留事件，返回 `0` 时丢弃，返回 0 到 1 的数值时保留事件并把该值作为采样率。

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

> 证据，`restored-src/src/utils/telemetry/instrumentation.ts`（2.1.88 source map 还原源码），`initializeTelemetry()`，省略 resource detector、logs/traces provider 和 shutdown 注册。

`CLAUDE_CODE_ENABLE_TELEMETRY` 交给 `isEnvTruthy()` 解析；为真时把 OTLP readers 追加到 `readers`。`isBigQueryMetricsEnabled()` 独立决定是否追加内部 reader，因此 `telemetryEnabled` 为假也可能创建带 reader 的 `meterProvider`；`resource` 提供公共属性，`views: []` 表示这里不额外注册 metric view。

`logOTelEvent()` 还刻意区分 events 与 metrics 的字段基数，prompt ID、workspace host paths 可以加入事件，却不应该成为 metric dimensions，否则会产生近乎无限的标签组合。

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

> 证据，`restored-src/src/utils/telemetry/events.ts`（2.1.88 source map 还原源码），`logOTelEvent()`，省略 workspace paths 和自定义 metadata 合并。

事件带时间戳与进程内递增序号；event logger 缺失或处于测试环境时直接返回。`eventName` 是开放字符串；`metadata` 默认 `{}`，值只能是 `string | undefined`，其中 `undefined` 字段会跳过；`eventSequence` 只在当前进程递增。用户 prompt 内容默认经 `redactIfDisabled()` 变成 `'<REDACTED>'`，只有 `OTEL_LOG_USER_PROMPTS` 被 `isEnvTruthy()` 判定为真时才保留原文。该开关只覆盖使用这个 helper 的内容路径，debug 与 analytics 仍需各自执行敏感信息策略。

字段装配顺序也会影响覆盖，`attributes` 先展开 `getTelemetryAttributes()` 的会话公共属性，再固定写入 `'event.name'`、ISO 格式的 `'event.timestamp'` 和自增后的 `'event.sequence'`。`promptId` 来自当前 prompt 上下文；值为真时追加 `'prompt.id'`，空值时保持字段缺席，从而避免制造空标签。

### 第四层｜token、成本和指标从同一份 Usage 分叉

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

> 证据，`restored-src/src/utils/modelCost.ts`（2.1.88 source map 还原源码），`tokensToUSDCost()`。

前四项按每百万 token 计价，web search 按请求数计价；`calculateUSDCost()` 会先根据解析后的模型名和 `usage.speed` 选择 `ModelCosts`，再调用此函数。`modelCosts` 包含 `inputTokens`、`outputTokens`、`promptCacheReadTokens`、`promptCacheWriteTokens`、`webSearchRequests` 五个单价；`usage.input_tokens` 与 `usage.output_tokens` 必须存在，缓存 token、`server_tool_use` 和 `web_search_requests` 可为 `undefined`，源码统一回退到 0。未知模型会记录 `tengu_unknown_model_cost`，再回退到默认主循环模型费率或 `DEFAULT_UNKNOWN_MODEL_COST`，因此显示结果可能不准确，`formatTotalCost()` 会附加警告。

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

> 证据，`restored-src/src/cost-tracker.ts`（2.1.88 source map 还原源码），`addToTotalSessionCost()`。

函数先更新本地 `ModelUsage` 和总成本状态，再增量写 counter。`?.add` 表明 counter 尚未初始化时不会抛错；advisor 返回的附加 usage 会根据自己的模型重新计价并递归累计，所以函数返回值可能大于最初传入的 `cost`。`cost` 是本次主 usage 的美元数；`usage` 是 API usage；`model` 是已经解析的开放模型字符串。metric 的 `type` 只有源码列出的 `'input'`、`'output'`、`'cacheRead'`、`'cacheCreation'`；`speed: 'fast'` 只在全局 fast mode 已启用且本次 `usage.speed === 'fast'` 时出现，否则 attributes 只有 `model`。

`totalCost` 先等于主调用 `cost`；每个 `advisorUsage` 再计算 `advisorCost`，把 `advisor_model`、`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` 和微美元 `cost_usd_micros` 写入 analytics，随后递归调用 `addToTotalSessionCost()` 并返回包含 advisor 的总成本。

metric 名称由 `setMeter()` 集中注册，包括 `claude_code.cost.usage`（单位 USD）、`claude_code.token.usage`（单位 tokens），以及 session、代码行、PR、commit、权限决策与 active time 等 counter。每次 `add()` 都重新合并 `getTelemetryAttributes()`，让会话属性保持最新。

这里体现了 events 与 metrics 的分工，API success event 可以带 request ID、stop reason、retry duration 等关联信息；counter 的标签更克制，适合聚合。若把每个 request ID 都放进 token counter，指标系统就会退化成另一份昂贵日志。

### 第五层｜成本可恢复，状态可直接给用户看

观测数据如果只存在内存里，resume 会话时 `/cost` 就会突然归零。Claude Code 因此把最后一次会话的成本、API 耗时、工具耗时、代码变更、各类 token 和分模型 usage 写入项目配置，并用 session ID 限制恢复范围。

```ts
export function restoreCostStateForSession(sessionId: string): boolean {
  const data = getStoredSessionCosts(sessionId)
  if (!data) return false
  setCostStateForRestore(data)
  return true
}
```

> 证据，`restored-src/src/cost-tracker.ts`（2.1.88 source map 还原源码），`restoreCostStateForSession()`。

`getStoredSessionCosts()` 只有在 `projectConfig.lastSessionId === sessionId` 时返回数据；匹配后才恢复总成本、耗时、代码变更和分模型 usage。`sessionId` 是待恢复会话的开放字符串；`data` 只在 `lastSessionId` 匹配时取得，取不到便返回 `false` 并保持当前成本状态，取得后交给 `setCostStateForRestore()` 并返回 `true`。持久数据中省略的数值字段由恢复器按 `?? 0` 初始化，省略 `modelUsage` 时从空的分模型统计开始。

`/cost` 读取的正是这套本地状态。API 用户会看到格式化后的总成本、API/wall duration、代码变更和分模型 token；Claude.ai 订阅用户通常看到订阅或 overage 状态。源码里的 cost tracker 提供运行时估算与诊断，最终结算仍以服务端账单系统为准。

`/status` 聚合安装、配置和上下文健康检查，把底层遥测转换成可行动结论。

```ts
export async function buildDiagnostics(): Promise<Diagnostic[]> {
  return [...(await buildInstallationDiagnostics()), ...(await buildInstallationHealthDiagnostics()), ...(await buildMemoryDiagnostics())];
}
```

> 证据，`restored-src/src/components/Settings/Status.tsx`（2.1.88 source map 还原源码），`buildDiagnostics()`。

三个检查按顺序执行并合并，安装检查、安装健康检查、memory 文件检查。返回空数组时 `Diagnostics` 组件渲染为 `null`，有问题时才展示 `System Diagnostics`。`buildDiagnostics()` 接受零个参数。三个子函数都返回 `Promise<Diagnostic[]>`；安装健康检查会报告无效 settings、doctor warnings 和缺少自动更新写权限，memory 检查会报告超过 `MAX_MEMORY_CHARACTER_COUNT` 的文件。

这解释了"暴露运行状态"的最后一公里，`/status` 把 OTel 与本地检查结果收敛为当前上下文里的可行动结论，哪里安装异常、哪里配置无效、哪个 memory 文件过大。

### 隐私边界｜开关、类型与调用约定各管一层

源码按通道采用多层隐私约束，

- diagnostic JSONL 用 `NoPII` 调用契约，明确禁止路径、项目名和 prompt；
- analytics metadata 用类型限制普通字符串，敏感调用点需要显式确认；
- OTel prompt 内容默认 `'<REDACTED>'`，只有 `OTEL_LOG_USER_PROMPTS` truthy 时放行；
- metrics 避免 prompt ID、workspace path 这类高基数字段；
- account status 在 `IS_DEMO` 环境下不显示 organization 与 email；
- debug log 面向本地排错，可能包含更详细的错误和路径，不能与 No PII 通道混为一谈。

同时还要区分两个看起来相近的总开关。第三方 OpenTelemetry 由 `CLAUDE_CODE_ENABLE_TELEMETRY` 控制；第一方 analytics 的 `isAnalyticsDisabled()` 还会在测试、Bedrock、Vertex、Foundry 或 telemetry-disabled 条件下关闭。两套系统共享部分业务事件来源，各自拥有独立启停条件。

因此，阅读任何一个 `logEvent()` 或 `logOTelEvent()` 调用点时，都要继续追三件事，字段是怎样构造的、当前 sink/exporter 是否启用、内容是否经过对应通道的隐私规则。只看到函数名就断言"Claude Code 上传了某段内容"，证据是不够的。

### 为什么观测失败不能拖垮 Agent

观测是旁路，就意味着它必须有自己的失败语义。源码里能看到几种典型处理，

- diagnostic 文件不存在时直接返回，append 最终失败时静默放弃；
- debug 缓冲写入的 promise 用 `.catch(noop)` 避免未处理异常；
- OTel event logger 未初始化时丢弃事件，只向 debug log 警告一次；
- 进程退出时 telemetry flush 与 shutdown 受 `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS` 限制，默认回退字符串是 `2000` 毫秒；
- startup perf 只有被抽样且确实存在 performance marks 时才发送；
- `/status` 和 `/cost` 依赖本地状态与检查器，不要求 exporter 在线。

旁路失败策略让 Bash、Edit 或 API 请求保留原业务结果，同时单独记录观测故障；这样遥测后端抖动不会连带终止 Agent 主循环。

调用图还能确认，API 成功路径会同时调用 `logAPISuccess()`、`logOTelEvent('api_request', ...)` 和 span 结束逻辑；错误路径调用 `logEvent('tengu_api_error', ...)`、`logOTelEvent('api_error', ...)` 与失败 span。成功事件记录 input/output/cache token、cost、duration、speed；错误事件记录 model、error、status、duration、attempt。它们共同提供关联线索，但各 exporter 是否真正抵达后端、真实采样率、线上延迟和最终账单，都超出了 2.1.88 静态源码能证明的范围。

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码，行号以当前仓库为准。

| 机制 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| debug 过滤 | `shouldLogDebugMessage()` / `getDebugFilter()` | `src/utils/debug.ts` | 已确认 |
| debug 写入 | `getDebugWriter()` 同步/缓冲双模式 | `src/utils/debug.ts` | 已确认 |
| 诊断 JSONL | `logForDiagnosticsNoPII()` / `withDiagnosticsTiming()` | `src/utils/diagLogs.ts` | 已确认 |
| Analytics | `logEvent()` sink 队列 / `shouldSampleEvent()` | `src/services/analytics/` | 已确认 |
| OTel | `initializeTelemetry()` / `logOTelEvent()` 字段装配 | `src/utils/telemetry/` | 已确认 |
| 成本换算 | `tokensToUSDCost()` 分项单价 | `src/utils/modelCost.ts` | 已确认 |
| 累计 | `addToTotalSessionCost()` counter + advisor 递归 | `src/cost-tracker.ts` | 已确认 |
| 成本恢复 | `restoreCostStateForSession()` lastSessionId 门控 | `src/cost-tracker.ts` | 已确认 |
| 状态检查 | `buildDiagnostics()` 三类检查 | `src/components/Settings/Status.tsx` | 已确认 |

> 证据说明，五本账各有独立出口与失败语义（`debug.ts` 的 `.catch(noop)`、`diagLogs.ts` 的静默失败、telemetry 的丢弃策略）；cost 与 metrics 从同一份 `Usage` 分叉（`modelCost.ts` → `cost-tracker.ts`），events 与 metrics 的字段基数策略在 `telemetry/events.ts`。

## 设计决策｜为什么五本账而不是一个统一日志系统

源码里找不到官方选型记录，下面的判断来自代码结构，属于解释而非官方声明。

**第一，为什么 debug log 与 diagnostic JSONL 分开？** 因为消费方和约束不同，debug log 面向本地排错，允许路径、错误消息等高细节字段，写入策略随 debug 开关变化（同步 vs 缓冲）；diagnostic JSONL 面向环境管理器和 session ingress，必须保持 No PII 与固定字段结构，用 `started/completed/failed` 三事件表达阶段。把两者混在一起，要么把敏感字段带进受控文件，要么让本地排错失去细节。

**第二，为什么成本与指标从同一份 Usage 分叉？** 一次 `Usage` 到达时，`tokensToUSDCost()` 计算美元数、`addToTotalSessionCost()` 同时更新本地 `ModelUsage` 与 metric counter。如果两条管道各自解析 usage，费率表或字段口径迟早分叉；同源分叉保证 `/cost` 显示的本地数字与 counter 的累计口径一致（估算误差只来自未知模型费率，不来自解析差异）。

**第三，为什么高基数字段只进事件不进 metrics？** 每个 request ID 都是新标签值；若放进 token counter，指标系统会因为标签爆炸退化成果昂贵日志。`logOTelEvent()` 允许 `prompt.id`、workspace paths 进事件（便于关联），metrics 只保留 `model`、`speed`、`type` 等稳定维度。这是"关联能力"与"聚合能力"的显式分工。

**第四，为什么观测必须是旁路？** 遥测后端抖动不该让 Agent 主循环失败。所有观测管道都有独立失败语义，静默丢弃、`.catch(noop)`、shutdown 超时上限、本地状态兜底。旁路把"业务控制流与观测流物理隔离"落实为结构保证，观测失败不会改变业务控制流。

## 练习｜在真实会话里观察五本账

1. **复现 trace 夹具的关联链。** 用 `claude --debug` 跑一次上文金额单位工单风格的任务（搜索 + 修复 + 测试），从 debug 日志里抓出 `x-client-request-id`、`tool_use_id` 与 `session_id`，对照夹具验证它们能否串成 request → tool → task → session → cost 的完整链路。

2. **观察 `/cost` 与 `/status`。** 完成一次多轮任务后运行 `/cost`，记录总成本、API/wall duration 与分模型 token；再运行 `/status` 查看安装与配置健康检查。比较两者对 exporter 是否在线的依赖程度。

3. **验证诊断 JSONL 的结构。** 设置 `CLAUDE_CODE_DIAGNOSTICS_FILE` 后运行一次远程或 bridge 相关操作，用 `jq` 检查 `started/completed/failed` 三事件结构与 `duration_ms`；再尝试在 `data` 里混入路径字段，确认它只是调用约定而非运行时强制。

## 自测

1. debug 模式与缓冲模式的写入策略为什么不同？
2. `withDiagnosticsTiming()` 的三种事件能区分哪两类故障？
3. 为什么 request ID 不能放进 metric 标签？
4. `/cost` 显示的金额与账单金额一定一致吗？

<details>
<summary>参考答案</summary>

1. **同步 vs 异步各有代价。** debug 模式同步 append，进程直接 `exit()` 时不丢关键记录（异步写入在直接退出时丢失，还会在 beforeExit handler 里让事件循环空转）；常态缓冲路径约每秒 flush、最多缓存 100 条，避免每条消息同步 I/O。`immediateMode` 就是 `isDebugMode()`（`debug.ts`）。

2. **`started` 后缺失 `completed` 表示操作未正常收尾**（崩溃、超时、断连），`completed` 携带很大的 `duration_ms` 表示操作完成但耗时异常。结构化事件保留了这个差别，又避免为了诊断直接收集完整 prompt（`diagLogs.ts`）。

3. **因为每个 request ID 都是新标签值，会造成标签爆炸。** 指标系统把标签维度聚合后，无限增长的标签组合会让存储与查询退化。`logOTelEvent()` 允许 `prompt.id`、workspace paths 进事件（事件按 ID 关联），metrics 只保留 `model`、`speed`、`type` 等稳定维度，关联能力与聚合能力分工（`telemetry/events.ts`）。

4. **不一定。** cost tracker 提供运行时估算与诊断，未知模型会记录 `tengu_unknown_model_cost` 并回退默认费率，`formatTotalCost()` 会附加警告；Claude.ai 订阅用户通常看到订阅或 overage 状态。最终结算以服务端账单系统为准（`modelCost.ts`、`cost-tracker.ts`）。

</details>

## 回顾（折叠）｜服务器在远程流程中承担什么作用

<details>
<summary>回答 37 留下的问题，Claude Code 的服务器在整个远程流程中究竟承担什么作用？</summary>

先看一条 prompt 的去向，Remote Control 服务器把本地环境注册成 worker，为 environment 和 session 分配身份，调度 work，转发事件并维护 lease；它不运行本地 query loop。模型请求由本地进程按当前 provider 发出，`Read`、`Bash`、MCP 和权限检查也留在本地；远端页面只是控制与展示端。

| 组件 | 所在位置 | 在这条远程链路中的职责 | 是否在这里执行本地工具 |
| --- | --- | --- | --- |
| Remote Control 的 session service | Anthropic 远端 | 认证、environment/session 关联、work 调度、事件中继、租约和重连状态 | 否 |
| 模型 provider 服务 | Anthropic API、Bedrock、Vertex 或 Foundry | 接收本地 query loop 的模型请求并返回模型输出 | 否；它负责推理，不负责本地 `Read`/`Bash` |
| Bridge/worker 进程 | 用户的本地机器 | 保持工作目录、运行 query loop，启动工具和 MCP，连接远端服务 | 是 |

因此，`claude remote-control` 即使被文档称作 server mode，启动的也是本地 worker；它是在等待远端 work 的执行端，不是把项目目录搬到云端的服务器。Remote Control 和 Claude Code on the web 也不是同一条部署路径，后者可以把执行环境放在云端，而前者的关键承诺是继续使用这台本地机器。

**服务器参与的完整流程**可以压缩成，远端输入 → session service 校验身份并关联 session → work 被本地 Bridge 轮询、领取、确认 → 本地 query loop 调用当前 provider 的模型服务 → 本地 Read/Bash/MCP 与权限逻辑执行 → SDK 消息和 control event 经 Bridge 回到 session service → 远端客户端展示结果或发出下一次控制。

各阶段的职责边界，**注册 environment**，`registerBridgeEnvironment()` 向 `/v1/environments/bridge` 发送 `machine_name`、`directory`、`branch`、`git_repo_url`、`max_sessions` 和 `worker_type`，服务器建立或复用 `environment_id` 并返回 `environment_secret`；**创建/关联 session**，`createBridgeSession()` 提交 `environment_id`、事件、仓库上下文、模型元数据和可选权限模式，服务器保存稳定 `sessionId` 把远端 UI、environment 和一次 Agent 会话关联起来；**调度 work**，`pollForWork()` 长轮询 `/v1/environments/{id}/work/poll`，拿到 work 后解出 session ingress token 再 `acknowledgeWork()`，服务器用 work ID、ACK 和租约避免同一任务被多个 worker 无序消费；**转发消息与控制**，`RemoteSessionManager` 用 WebSocket 接收 `SDKMessage`、权限请求和取消事件，用户消息通过 HTTP POST 送回 session，`handleServerControlRequest()` 响应 `interrupt`、`set_model`、`set_permission_mode` 等控制；**保活与恢复**，`heartbeatWork()` 定期发送 `workId` 和 session token，收到 401/403 时触发 reconnect，404/410 视为环境或 work 已失效。

这里的 ACK 和 heartbeat 不是"网络层 ping"这么简单。ACK 表示本地已经看到某个 work，heartbeat 则表示这个 work 仍由当前 session 执行；服务器据此清理失联 worker 的占用，避免远端一直看到一个实际上已经死掉的会话。源码能确认的是有限重试、重新排队和租约状态，不能据此宣称跨任意网络故障提供 exactly-once 执行。

**服务器不负责什么？** 第一，它不替本地 query loop 运行工具，`runBridgeHeadless()` 甚至在注册前就检查本地 workspace 是否已经被信任。第二，它不等同于模型 provider，本地 Agent 仍按当前 provider 选择和凭证策略发起模型请求。第三，它不是让浏览器直接暴露一个本地监听端口，典型流程是本地进程主动建立出站连接或轮询远端接口，远端客户端只通过受认证的 session 通道收发协议事件；这样 NAT、防火墙和本地网络都不需要把项目机器暴露到公网。

**为什么必须有这一层服务器？** 如果让浏览器直连本地 query loop，就要自行解决端口暴露、身份认证、session 路由、断线重连、重复投递、多个远端设备同时观看和权限请求回传。session service 把这些问题收敛成控制面，本地只需证明"我拥有这个 environment"，远端只需证明"我被允许访问这个 session"。

所以更准确的总结是，**服务器保存和转发"谁在什么环境里运行哪一个会话、当前有哪些 work、哪些控制需要确认"；本地 Bridge 保存并执行"这个会话具体要对哪些文件、进程和工具做什么"。** 远程能力把一次单机交互拆成可认证、可路由、可恢复的分布式协议，本地执行仍留在 Bridge。

</details>

## 留给下一篇的问题

近来有报道称，Claude Code 的指标上报可能留有后门，甚至被用于识别中国用户；从 2.1.88 的源码中，能看出这类行为吗？

## 相关链接

- **上一篇**，[37 Bridge、Remote 与 Server 如何协作](./37-bridge-remote-and-server.md)，远程链路的执行端与观测端
- **下一篇**，[39 更新、迁移与首次启动如何保持兼容](./39-updates-migrations-and-onboarding.md)，`/status` 健康检查的启动链路
- **平行阅读**，[08 API 流式传输如何工作](./08-api-streaming.md)，`Usage` 字段的来源
- **平行阅读**，[20 会话历史如何持久化与恢复](./20-session-history-and-resume.md)，`lastSessionId` 与成本恢复
