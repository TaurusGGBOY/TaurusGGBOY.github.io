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

上一篇留下的问题是：远端与本地运行时能够协作以后，Claude Code 如何记录日志、指标、token 与成本，并把运行状态暴露给诊断和观测系统？

答案不是“把所有信息都写进一份日志”。Claude Code 实际上把观测拆成了几条用途不同的旁路：本地 debug log 保存排错细节，diagnostic JSONL 为受控环境写结构化且禁止携带 PII 的事件，analytics event 记录产品事件，OpenTelemetry 输出 logs、metrics 和可选 traces，会话状态则单独累计 token、成本与耗时，最后由 `/cost`、`/status` 等界面把其中一部分交还给用户。

这些旁路都从同一个运行时取事实，却有不同的字段、开关、生命周期与隐私边界。API 请求失败不会因为遥测 exporter 也失败而变成另一种业务错误。

这就是本篇要建立的模型：**主流程负责执行，观测旁路负责留下可关联、可裁剪、可失败的证据。**

## 先把“可观测性”拆成五本账

我们先看整体关系。

![Claude Code 日志、遥测、成本与诊断旁路](/images/posts/claude-code-source-reading-38/38-observability-cost-diagnostics-handdrawn.png)

图里最重要的不是 exporter 有几个，而是五本账没有被混成一份：

1. debug log 回答“当时具体发生了什么”；
2. diagnostic JSONL 回答“受控运行环境处于哪个阶段、耗时多久”；
3. analytics events 回答“某类功能或结果是否发生”；
4. OpenTelemetry metrics / logs / traces 回答“外部观测系统怎样接入”；
5. session cost state 回答“本次会话用了多少 token、花费多少、耗时多久”。

把它们分开有两个直接好处。第一，详细日志可以留在本地，而低基数指标可以进入聚合系统；第二，用户可见状态不必依赖远端 exporter，`/cost` 和 `/status` 仍然可以从本地状态与检查器构造结果。

下面沿一次 API 调用结束后的路径，把这五本账串起来。

## 第一层：debug log 是本地排错现场

Claude Code 的 `logForDebugging()` 不是无条件写文件。源码先检查日志级别，再检查当前是不是 debug 模式、测试环境以及 `--debug=pattern` 过滤器。

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

参数说明：`message` 是待判断的任意字符串；`NODE_ENV === 'test'` 且没有 `--debug-to-stderr` 时直接丢弃。外部用户默认还需要启用 debug 模式；`isDebugMode()` 可由运行期开关、`DEBUG`、`DEBUG_SDK`、`--debug`、`-d`、`--debug=...` 或 `--debug-file` 等路径触发。`getDebugFilter()` 没有匹配到 `--debug=pattern` 时返回 `null`，此时是否显示由 `shouldShowDebugMessage()` 的无过滤规则决定。

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

参数说明：`writeFn` 接收已经格式化的日志文本；`flushIntervalMs: 1000` 是毫秒；`maxBufferSize: 100` 是触发 flush 的缓冲条目上限；`immediateMode` 是布尔值。日志路径优先取 `--debug-file`，其次是 `CLAUDE_CODE_DEBUG_LOGS_DIR`，否则回退到 `~/.claude/debug/<sessionId>.txt` 一类会话路径。源码没有声明 debug 文本天然不含路径、错误消息或其他细节，因此不能把它当成“无 PII 通道”。

这一本账适合回答连接错误、请求 ID、沙箱失败等具体问题。比如 `logAPIError()` 会把 `x-client-request-id` 写进 debug log，方便服务端关联；代价是它天然更接近排错现场，不适合直接当聚合指标使用。

## 第二层：diagnostic JSONL 是严格约束字段的运行记录

另一个容易与 debug log 混淆的模块是 `utils/diagLogs.ts`。它不是普通调试日志，而是给环境管理器和 session ingress 消费的结构化文件。源码注释明确要求调用者不得传入 PII，包括文件路径、项目名、仓库名和 prompt。

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

函数说明：这段来自 `restored-src/src/utils/diagLogs.ts`，仅省略源码注释。没有 `CLAUDE_CODE_DIAGNOSTICS_FILE` 时函数直接返回；有路径时，每个事件写成一行 JSON。第一次 append 失败后会尝试创建父目录再写一次，第二次仍失败则静默放弃。

参数说明：`level` 的源码可选值只有 `'debug' | 'info' | 'warn' | 'error'`，这里只作为信息字段，不执行级别过滤；`event` 是调用方定义的事件名；`data` 可省略，`undefined` 时回退为空对象。函数名里的 `NoPII` 是调用契约，不是运行时自动脱敏器：源码并没有遍历 `data` 检查路径或 prompt，所以安全性仍依赖调用点遵守约定。

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

这种格式为什么有必要？因为远端容器出了问题时，“某个操作慢”不够定位；`started` 后没有 `completed`，和 `completed` 但 `duration_ms` 很大，是两种不同故障。结构化事件保留了这个差别，又避免为了诊断直接收集完整 prompt。

## 第三层：analytics event 与 OpenTelemetry 不是同一条管道

Claude Code 同时存在第一方 analytics 与 OpenTelemetry。两者会在相同业务点被调用，但发送协议和配置不同。

。

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

函数说明：这段来自 `restored-src/src/services/analytics/index.ts`。sink 尚未初始化时，事件先进入内存队列；初始化后直接交给 sink。源码中的 `LogEventMetadata` 类型刻意限制字符串字段，降低误传代码和路径的机会，但显式类型断言仍然可以绕过它，因此这是一道开发期护栏，不是内容扫描器。

参数说明：`eventName` 是开放字符串，由各调用点定义；`metadata` 是受类型约束的对象；队列项的 `async: false` 表示同步入口类型，不等于远端网络请求会阻塞主流程。。

第一方事件还可以按事件名采样：无配置、配置非法或采样率为 1 时返回 `null`，表示不附加采样信息；0 表示全部丢弃；0 到 1 之间才随机决定保留。

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

函数说明：这段来自 `restored-src/src/services/analytics/firstPartyEventLogger.ts`。它返回的是 `number | null`，而不是简单布尔值，因为保留事件时还要把实际采样率带给下游，便于聚合时理解样本权重。

参数说明：`eventName` 用来从运行时采样配置取规则；`sample_rate` 的有效闭区间是 0 到 1。`null` 代表“不要按采样配置丢弃”，`0` 代表丢弃，0 到 1 的返回值代表本次被选中且采样率为该值。

OpenTelemetry 则是另一条用户可配置出口。`CLAUDE_CODE_ENABLE_TELEMETRY` 为 truthy 时，初始化逻辑才装载 OTLP readers、logs exporter；增强 tracing 还要再满足独立开关。metrics provider 即使没有第三方 OTLP，也可能承载内部 BigQuery reader。

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

函数说明：这段来自 `restored-src/src/utils/telemetry/instrumentation.ts` 的 `initializeTelemetry()`，省略了 resource detector、logs/traces provider 和 shutdown 注册。它说明“是否创建 meter provider”与“是否启用第三方 OTLP”不是同一个判断。

参数说明：`CLAUDE_CODE_ENABLE_TELEMETRY` 不是固定枚举，而是交给 `isEnvTruthy()` 解析的环境变量；`readers` 初始为空数组，按条件加入 OTLP 或内部 reader；`views: []` 表示这里没有额外注册 metric view。。

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

函数说明：这段来自 `restored-src/src/utils/telemetry/events.ts` 的 `logOTelEvent()`，省略了 workspace paths 和自定义 metadata 合并。事件带时间戳与进程内递增序号；没有 event logger、或处于测试环境时直接返回。

参数说明：`eventName` 是开放字符串；`metadata` 默认 `{}`，值只能是 `string | undefined`，其中 `undefined` 字段会跳过；`eventSequence` 是进程内计数，不是跨进程全局序号。用户 prompt 内容默认经 `redactIfDisabled()` 变成 `'<REDACTED>'`，只有 `OTEL_LOG_USER_PROMPTS` 被 `isEnvTruthy()` 判定为真时才保留原文。这个开关只约束使用该 helper 的内容路径，不能把它扩大解释为所有 debug 或 analytics 字段都自动脱敏。

## 第四层：token、成本和指标从同一份 Usage 分叉

模型响应携带 `Usage` 后，Claude Code 会同时更新会话内状态和 OpenTelemetry counter。成本不是按“消息数”猜出来的，而是把输入、输出、缓存读、缓存写以及 web search 请求分别乘以模型费率。

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

metric 名称也不是临时拼出来的。`setMeter()` 固定注册了 `claude_code.cost.usage`（单位 USD）、`claude_code.token.usage`（单位 tokens），还包括 session、代码行、PR、commit、权限决策与 active time 等 counter。每次 `add()` 都重新合并 `getTelemetryAttributes()`，让会话属性保持最新。

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

参数说明：`sessionId` 是待恢复会话的开放字符串；没有匹配记录时返回 `false`，成功恢复时返回 `true`。缺失的数值字段使用 `?? 0` 回退；`modelUsage` 可以是 `undefined`。

`/cost` 读取的正是这套本地状态。API 用户会看到格式化后的总成本、API/wall duration、代码变更和分模型 token；Claude.ai 订阅用户通常看到订阅或 overage 状态，而不是简单把估算美元数当账单。也就是说，源码里的 cost tracker 是运行时估算与诊断工具，不等于最终结算系统。

`/status` 则聚合安装、配置和上下文健康检查，而不是展示所有遥测字段。

```ts
export async function buildDiagnostics(): Promise<Diagnostic[]> {
  return [...(await buildInstallationDiagnostics()), ...(await buildInstallationHealthDiagnostics()), ...(await buildMemoryDiagnostics())];
}
```

函数说明：这段来自 `restored-src/src/components/Settings/Status.tsx`。三个检查按顺序执行并合并：安装检查、安装健康检查、memory 文件检查。返回空数组时 `Diagnostics` 组件渲染为 `null`，有问题时才展示 `System Diagnostics`。

参数说明：`buildDiagnostics()` 没有参数。三个子函数都返回 `Promise<Diagnostic[]>`；安装健康检查会报告无效 settings、doctor warnings 和无自动更新写权限，memory 检查会报告超过 `MAX_MEMORY_CHARACTER_COUNT` 的文件。

这解释了“暴露运行状态”的最后一公里：不是把 OTel dashboard 嵌进终端，而是让用户在当前上下文里看到可行动的结论——哪里安装异常、哪里配置无效、哪个 memory 文件过大。

## 隐私边界：开关、类型与调用约定各管一层

Claude Code 没有一个可以包治所有通道的 `sanitizeEverything()`。源码采用的是多层约束：

- diagnostic JSONL 用 `NoPII` 调用契约，明确禁止路径、项目名和 prompt；
- analytics metadata 用类型限制普通字符串，敏感调用点需要显式确认；
- OTel prompt 内容默认 `'<REDACTED>'`，只有 `OTEL_LOG_USER_PROMPTS` truthy 时放行；
- metrics 避免 prompt ID、workspace path 这类高基数字段；
- account status 在 `IS_DEMO` 环境下不显示 organization 与 email；
- debug log 面向本地排错，可能包含更详细的错误和路径，不能与 No PII 通道混为一谈。

同时还要区分两个看起来相近的总开关。第三方 OpenTelemetry 由 `CLAUDE_CODE_ENABLE_TELEMETRY` 控制；第一方 analytics 的 `isAnalyticsDisabled()` 还会在测试、Bedrock、Vertex、Foundry 或 telemetry-disabled 条件下关闭。它们共享一些业务事件来源，却不是一个布尔值控制的同一系统。

因此，阅读任何一个 `logEvent()` 或 `logOTelEvent()` 调用点时，都要继续追三件事：字段是怎样构造的、当前 sink/exporter 是否启用、内容是否经过对应通道的隐私规则。只看到函数名就断言“Claude Code 上传了某段内容”，证据是不够的。

## 为什么观测失败不能拖垮 Agent

观测是旁路，就意味着它必须有自己的失败语义。源码里能看到几种典型处理：

- diagnostic 文件不存在时直接返回，append 最终失败时静默放弃；
- debug 缓冲写入的 promise 用 `.catch(noop)` 避免未处理异常；
- OTel event logger 未初始化时丢弃事件，只向 debug log 警告一次；
- 进程退出时 telemetry flush 与 shutdown 受 `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS` 限制，默认回退字符串是 `2000` 毫秒；
- startup perf 只有被抽样且确实存在 performance marks 时才发送；
- `/status` 和 `/cost` 依赖本地状态与检查器，不要求 exporter 在线。

这不是说观测丢失无所谓，而是说“写日志失败”不应改写 Bash、Edit 或 API 请求本来的业务结果。否则，遥测后端抖动会让 Agent 主循环也失败，诊断系统反而成了新的故障源。

调用图还能确认，API 成功路径会同时调用 `logAPISuccess()`、`logOTelEvent('api_request', ...)` 和 span 结束逻辑；错误路径调用 `logEvent('tengu_api_error', ...)`、`logOTelEvent('api_error', ...)` 与失败 span。成功事件记录 input/output/cache token、cost、duration、speed；错误事件记录 model、error、status、duration、attempt。它们共同提供关联线索，但各 exporter 是否真正抵达后端、真实采样率、线上延迟和最终账单，都超出了 2.1.88 静态源码能证明的范围。

## 小结

Claude Code 的可观测性不是一份万能日志，而是一组按用途拆开的旁路。

debug log 保存本地排错细节；diagnostic JSONL 用结构化 started/completed/failed 事件观察受控环境；analytics 和 OpenTelemetry 分别承载产品事件与可配置的 logs、metrics、traces；cost tracker 从模型 Usage 精确拆分输入、输出、缓存和 web search，既更新本地会话状态，也更新低基数 counter；`/cost` 与 `/status` 再把用户真正能行动的信息显示出来。

这种设计的关键不在“记录得多”，而在边界清楚：内容与指标分开，本地与远端分开，估算成本与账单分开，观测失败与运行时失败分开。只有把这些边界保留下来，日志才是在解释系统，而不是制造第二套系统。

## 留给下一篇的问题

观测系统能够看见运行状态以后，Claude Code 如何检查更新、执行迁移，并引导新用户完成首次启动与环境准备？

