---
title: "Claude Code源码解读29：LSP 如何为 Agent 提供代码智能"
published: 2026-07-24T16:47:16+08:00
updated: 2026-07-24T16:47:16+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-29/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 本章先建立三个概念

- **语义索引**：LSP server 基于语言语法和项目图提供定义、引用、诊断等结构化结果。

- **文档同步**：didOpen、didChange 与版本号让 server 持有接近编辑器现场的文本视图。

- **诊断证据**：主动查询和 publishDiagnostics 都是辅助证据，Agent 仍需结合文件与测试判断。

![LSP 文档同步与主动被动证据路径](/images/posts/claude-code-source-reading-29/29-lsp-sync-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇最后留下的问题是：既然 Claude Code 同时提供 Grep 和 LSP，它分别会在什么情况下被使用？

先澄清一个容易混淆的名字：这里的 **Grep** 是 Claude Code 的专用工具，2.1.88 的实现会调用 `ripgrep`（命令通常写作 `rg`）。它不是检索增强生成（RAG）；很多文章把 `rg` 写成 “grep”，说的是同一类词法搜索。

结论是：**Grep 和 LSP 不是谁取代谁，而是回答两类不同的问题。**Grep 看文件里的字符，LSP 看语言里的符号关系。更重要的是，源码里没有一个“看到函数名就必定调用 LSP、看到字符串就必定调用 Grep”的硬编码分类器；模型根据当前可用的工具描述和任务语义选择工具。因此“什么时候会用到”要同时看工具是否已装配，以及用户的问题究竟是在找文本还是在问代码关系。

### 先看两种能力是否真的可用

`getAllBaseTools()` 只在没有内置搜索实现时加入 `GrepTool`；某些构建会使用内置的搜索工具，工具名不一定仍然显示为 Grep。`LSPTool` 则只有在 `ENABLE_LSP_TOOL` 为真时才会加入工具池，并且 `isEnabled()` 还要求 LSP manager 已经连接成功。manager 处于 `not-started` 或 `pending` 时，LSP 工具会被延迟；没有匹配当前文件扩展名的 server 时，调用也只能返回 “No LSP server available”。所以配置了插件不等于模型已经拥有可调用的 LSP。

### 按问题类型选择

| 你真正想问的问题 | 更合适的工具 | 原因 |
| --- | --- | --- |
| “`API_URL` 在哪些 `.env`、YAML 和文档里出现？” | Grep | 这是跨文件、跨语言的字面量搜索，LSP 不会索引配置键和普通文本。 |
| “所有包含 `TODO` 或某条日志的地方在哪里？” | Grep | 注释、字符串和日志不是语言符号；正则、glob、文件类型和上下文行也由 Grep 直接提供。 |
| “`createSession` 定义在哪里？” | LSP（如果已连接） | `goToDefinition` 按符号和作用域解析，避免把同名注释、字符串或另一个模块的函数混在一起。 |
| “重命名 `createSession` 前，谁真正调用了它？” | LSP（如果已连接） | `findReferences`、`incomingCalls` 和 `outgoingCalls` 返回语义引用，适合评估改动范围。 |
| “这个表达式的类型是什么、有哪些实现？” | LSP（如果已连接） | `hover`、`goToImplementation` 和 symbol 查询需要语言服务器的类型和索引。 |
| “刚刚 Edit 之后有没有类型错误？” | 被动 LSP 诊断 | server 推送 `publishDiagnostics`，运行时把它们作为 `diagnostics` attachment 交给 Agent，不需要模型先发起一次 LSP 查询。 |

### Grep 什么时候反而是首选

Grep 不只是 LSP 失效时的备用方案。它启动成本低，不要求项目有语言服务器，也不要求文件属于某种编程语言。首次接手陌生仓库时，先用精确字符串、正则、`glob` 或 `type` 做一次范围扫描，通常比等待语言索引更直接；查找配置、JSON、Markdown、模板、生成文件、错误信息和注释时，LSP 根本没有可解析的符号可返回。需要统计命中数、只列出文件、限制上下文或处理多行正则时，`GrepTool` 也有对应的 `output_mode`、上下文参数、`multiline`、`head_limit` 和 `offset`。

这也是源码 prompt 强调“搜索任务使用 Grep、不要把 `grep`/`rg` 当 Bash 命令直接执行”的原因：权限、忽略目录、结果截断和输出格式由宿主工具统一处理。这里的“搜索任务”是词法层面的搜索，并不意味着语义导航也必须用 Grep。

### LSP 什么时候值得优先

当问题里出现“定义、引用、调用者、实现、类型、符号、重构影响范围”这些关系词时，LSP 的价值在于先过滤再把结果交给模型。Grep 会把同名文本、注释和测试夹具一并返回，模型还得打开文件判断哪些是真的引用；LSP 则让语言服务器在索引和类型系统中完成这一步。对大型仓库或准备修改公共 API 的任务，这个差别会直接影响上下文消耗和误改风险。

LSP 还有一条不容易被注意到的被动路径：Edit/Write 后，服务器可以异步推送诊断。它不是“模型决定搜索时才使用”的一次性工具调用，而是编辑事件触发的反馈。诊断仍然只是辅助证据，最终要用 Read、编译器和测试确认。

### 为什么你有时仍会看到 Grep

即使安装了 LSP，模型也可能因为 server 尚未启动、扩展名没有映射、初始化失败、当前请求只是文本搜索，或者模型误判了任务，而继续调用 Grep。外部实践文章也把这种“静默回退”视为常见陷阱：可以直接要求“对这个符号执行 go to definition”，再看工具轨迹是否出现 `LSP`；如果只看到大量文本命中，就应检查 `ENABLE_LSP_TOOL`、插件的 `.lsp.json`、语言服务器进程和连接状态。

因此，最实用的记忆方式是：**找字面量用 Grep，找符号关系用 LSP；改完代码看诊断；LSP 不可用时再让模型退回 Grep。**两者组合起来，才同时覆盖“代码之外的文本”和“代码内部的语义”。

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的源码块都是短摘录，省略了与当前结论无关的日志和分支；还原路径只用于定位本文引用的源码。

## LSP 把文件位置映射成语言语义

我们先看整条链路。

![Claude Code LSP 生命周期、主动查询与被动诊断路径](/images/posts/claude-code-source-reading-29/29-lsp-integration-handdrawn.png)

这里先看三个概念怎样决定请求与诊断的时序。

**LSP（Language Server Protocol）**是一套编辑器与语言服务器之间的协议。客户端把“某个文件、某一行、某个字符”的位置发给对应服务器，服务器依据语言语法、类型和项目索引返回定义、引用、悬浮信息和调用关系。

**JSON-RPC**是这条协议的消息外壳。request 携带请求 ID并等待 response；notification 省略请求 ID，也不等待业务结果。`textDocument/definition` 是 request，`textDocument/didChange` 和 `textDocument/publishDiagnostics` 则是两个方向相反的 notification。

**文档同步**解决服务器内存里的文件版本与磁盘内容是否一致。只有先 `didOpen`，后续查询才有可靠的文档对象；文件变化后再发 `didChange`、`didSave`，服务器才能重新分析。notification 发出后，诊断仍会异步计算。

Claude Code 需要这套机制，是因为 Grep 可以找到同名字符串，却不知道它是局部变量、重载方法还是接口实现；LSP 能利用语言自己的索引和类型系统回答语义问题。反过来，LSP 也不能替代 Read、编译器和测试：服务器可能没安装、能力不完整、索引未完成，诊断还可能滞后。

## 第一层：LSP 配置只来自已启用插件

2.1.88 只从已启用插件收集 LSP 命令。`restored-src/src/services/lsp/config.ts` 的入口写得很直接：

```ts
export async function getAllLspServers(): Promise<{
  servers: Record<string, ScopedLspServerConfig>
}> {
  const allServers: Record<string, ScopedLspServerConfig> = {}
  const { enabled: plugins } = await loadAllPluginsCacheOnly()

  const results = await Promise.all(
    plugins.map(async plugin => {
      const errors: PluginError[] = []
      try {
        const scopedServers = await getPluginLspServers(plugin, errors)
        return { plugin, scopedServers, errors }
      } catch (e) {
        // ...
        return { plugin, scopedServers: undefined, errors }
      }
    }),
  )

  for (const { scopedServers } of results) {
    const serverCount = scopedServers ? Object.keys(scopedServers).length : 0
    if (serverCount > 0) {
      Object.assign(allServers, scopedServers)
    }
  }
  return { servers: allServers }
}
```

`getAllLspServers()` 是空参函数，返回按 scoped server name 索引的配置对象。它只遍历 `enabled` 插件；`getPluginLspServers()` 返回 `undefined` 时，该插件在合并阶段贡献零个 server。多个插件并行读取，但最后按原插件顺序合并；发生同名覆盖时，靠后的对象赋值生效。server 名还会被改成 `plugin:<pluginName>:<name>`，正常情况下插件之间会通过前缀隔离。

**字段说明：** `allServers` 是最终配置表，返回时写入 `servers`；加载结果中的 `plugin` 标识来源，`scopedServers` 保存该插件的 server 表，`errors` 保存局部解析错误。`serverCount` 通过 `Object.keys(scopedServers).length` 计算，正数时才合并。

插件可以用根目录 `.lsp.json`，也可以在 manifest 的 `lspServers` 中写相对 JSON 路径、内联对象，或者二者组成的数组。外部路径会经过“仍位于插件目录内”的校验，`..` 穿越和绝对路径不会被接受。

单个 server 配置的核心 Schema 位于 `restored-src/src/utils/plugins/schemas.ts`：

```ts
z.strictObject({
  // ...
  args: z.array(nonEmptyString()).optional(),
  transport: z.enum(['stdio', 'socket']).default('stdio'),
  env: z.record(z.string(), z.string()).optional(),
  initializationOptions: z.unknown().optional(),
  workspaceFolder: z.string().optional(),
  startupTimeout: z.number().int().positive().optional(),
  restartOnCrash: z.boolean().optional(),
  maxRestarts: z.number().int().nonnegative().optional(),
})
```

这个 Schema 是严格对象，未知字段会校验失败。`command` 必填且非空；普通命令中带空格会被拒绝，参数应该放进可选 `args`。`extensionToLanguage` 至少要有一个“扩展名 → language ID”映射。`env`、`initializationOptions`、`workspaceFolder`、`startupTimeout`、`restartOnCrash`、`maxRestarts` 都可为 `undefined`。

`transport` 的静态可选值是 `'stdio' | 'socket'`，默认 `'stdio'`。当前 `LSPClient.start()` 固定执行 `spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })`，因此 `transport` 尚未参与启动控制流。实例构造器遇到非 `undefined` 的 `restartOnCrash` 会明确报“尚未实现”。

还有一个安全顺序：交互模式下，`main.tsx` 在 workspace trust 已确认后才调用 `initializeLspServerManager()`；同一处源码注释把非交互模式的 trust 视为隐式成立。因为插件的 `command` 最终会启动本地进程，所以交互路径会在未信任目录里阻止提前执行。

## 第二层：Manager 先建路由，server 第一次使用时才启动

启动阶段的 `initializeLspServerManager()` 并不会同步等所有语言服务器起来。它创建全局 Manager，把状态设为 `pending`，然后后台加载插件配置：

```ts
export function initializeLspServerManager(): void {
  if (isBareMode()) return

  if (lspManagerInstance !== undefined && initializationState !== 'failed') {
    return
  }
  if (initializationState === 'failed') {
    lspManagerInstance = undefined
    initializationError = undefined
  }

  lspManagerInstance = createLSPServerManager()
  initializationState = 'pending'
  const currentGeneration = ++initializationGeneration

  initializationPromise = lspManagerInstance.initialize().then(() => {
    if (currentGeneration === initializationGeneration) {
      initializationState = 'success'
      if (lspManagerInstance) {
        registerLSPNotificationHandlers(lspManagerInstance)
      }
    }
  }).catch((error: unknown) => {
    if (currentGeneration === initializationGeneration) {
      initializationState = 'failed'
      initializationError = error as Error
      lspManagerInstance = undefined
    }
  })
}
```

`initializeLspServerManager()` 是空参同步入口，内部异步装配不会阻塞调用方继续启动。bare/simple 路径直接跳过 LSP。初始化状态只有 `'not-started' | 'pending' | 'success' | 'failed'`；已有实例且状态正常时保持幂等，failed 状态再次调用则允许重试。`initializationGeneration` 用来阻止旧 Promise 在 reload 或 shutdown 后覆盖新状态。

这里注册诊断 handler 的时机也值得注意：Manager 完成配置装配后就注册，而 server 进程此时通常尚未启动。`LSPClient.onNotification()` 会把 handler 暂存，等连接建立后再挂到 JSON-RPC connection。因此，被动诊断允许 server 延迟到首次访问时启动。

`LSPServerManager.initialize()` 做的主要工作是构造扩展名路由：

```ts
for (const [serverName, config] of Object.entries(serverConfigs)) {
  try {
    if (!config.command) {
      throw new Error(
        `Server ${serverName} missing required 'command' field`,
      )
    }
    if (
      !config.extensionToLanguage ||
      Object.keys(config.extensionToLanguage).length === 0
    ) {
      throw new Error(
        `Server ${serverName} missing required 'extensionToLanguage' field`,
      )
    }

    for (const ext of Object.keys(config.extensionToLanguage)) {
      const normalized = ext.toLowerCase()
      if (!extensionMap.has(normalized)) extensionMap.set(normalized, [])
      extensionMap.get(normalized)?.push(serverName)
    }

    servers.set(serverName, createLSPServerInstance(serverName, config))
  } catch (error) {
    // ...
  }
}
```

`serverName` 是加过插件 scope 的开放字符串；`config` 是对应 server 配置。扩展名统一转小写，一个扩展名可以对应多个 server，但 `getServerForFile()` 当前固定取 `serverNames[0]`，按注册顺序选择。单个配置无效只跳过该 server，其他语言能力继续装配。

更关键的是，`createLSPServerInstance()` 只创建带状态的包装器。真正访问某个文件时，`ensureServerStarted(filePath)` 才根据扩展名找到 server，并在状态为 `'stopped'` 或 `'error'` 时执行 `start()`。这就是 lazy start：访问 `.rs` 文件时才需要启动 rust-analyzer。

## 第三层：spawn、initialize、initialized 组成真正的协议握手

单个 server 的 `start()` 才进入进程与协议层。主路径位于 `restored-src/src/services/lsp/LSPServerInstance.ts`：

```ts
await client.start(config.command, config.args || [], {
  env: config.env,
  cwd: config.workspaceFolder,
})

const workspaceFolder = config.workspaceFolder || getCwd()
const workspaceUri = pathToFileURL(workspaceFolder).href

const initParams: InitializeParams = {
  processId: process.pid,
  initializationOptions: config.initializationOptions ?? {},
  workspaceFolders: [
    {
      uri: workspaceUri,
      name: path.basename(workspaceFolder),
    },
  ],
  rootPath: workspaceFolder,
  rootUri: workspaceUri,
  capabilities: {
    // ...
  },
}

const initPromise = client.initialize(initParams)
if (config.startupTimeout !== undefined) {
  await withTimeout(initPromise, config.startupTimeout, '...')
} else {
  await initPromise
}
```

`config.command` 是可执行程序；`args` 为 `undefined` 时回退为空数组。`env` 可省略，并在 Client 内与 Claude Code 的子进程环境合并；`workspaceFolder` 可省略，默认当前 cwd。`initializationOptions` 可以是任意值，`undefined` 时明确回退 `{}`。`startupTimeout` 必须是正整数毫秒；省略时 initialize 的等待行为由连接和 server 决定。

**字段说明：** `initParams.processId` 取当前进程 ID，`initializationOptions` 取配置或空对象；`workspaceFolders` 是单元素数组，其中 `uri` 取 `workspaceUri`，`name` 取目录 basename。`rootPath` 取 `workspaceFolder`，`rootUri` 取同一 `workspaceUri`，`capabilities` 保存客户端能力声明。

`LSPClient.start(command, args, options?)` 使用 `child_process.spawn` 建立 stdin/stdout/stderr 管道，再用 `vscode-jsonrpc` 的 `StreamMessageReader / StreamMessageWriter` 创建连接。`options` 整体可为 `undefined`；`options.env` 和 `options.cwd` 也都可省略。Windows 上固定 `windowsHide: true`，其他平台该值无效果。

握手包含 initialize request、能力保存与 initialized notification。Client 收到结果后保存 `result.capabilities`，再发 `initialized` notification，最后才把 `isInitialized` 设为 `true`：

```ts
async initialize(params: InitializeParams): Promise<InitializeResult> {
  if (!connection) throw new Error('LSP client not started')

  const result = await connection.sendRequest('initialize', params)
  capabilities = result.capabilities
  await connection.sendNotification('initialized', {})
  isInitialized = true
  return result
}
```

`initialize(params)` 的参数是完整 `InitializeParams`，类型排除 `null`；connection 未建立就直接报错。服务端 capabilities 允许为不同能力提供布尔值或 option 对象，源码在这里保存它。`LSPTool` 仍会发起所选请求，服务器不支持某个方法时，请求错误沿工具错误路径返回。

客户端声明的能力也比较克制：workspace configuration 和 workspace folder change 都是 `false`；文档同步声明 `didSave: true`，但 `willSave / willSaveWaitUntil` 为 `false`；诊断支持 related information 和 tag 1/2，却明确 `versionSupport: false`；position encoding 只声明 UTF-16。服务器与客户端因此按 UTF-16 position 对齐。

## 第四层：文档同步从 didOpen 开始，但版本并不完整

LSP 查询会先把磁盘文件同步成服务器文档。`LSPTool.call()` 首次访问文件时先读取内容，并建立 `didOpen`：

```ts
if (!manager.isFileOpen(absolutePath)) {
  const handle = await open(absolutePath, 'r')
  try {
    const stats = await handle.stat()
    if (stats.size > MAX_LSP_FILE_SIZE_BYTES) {
      return { data: { result: 'File too large for LSP analysis ...' } }
    }
    const fileContent = await handle.readFile({ encoding: 'utf-8' })
    await manager.openFile(absolutePath, fileContent)
  } finally {
    await handle.close()
  }
}
```

`absolutePath` 来自 `expandPath(input.filePath)`。文件大于 `10_000_000` 字节时不打开，也不发送请求；等于上限仍允许。读取编码固定 UTF-8。`manager.isFileOpen()` 只按规范化 file URI 查询内部 Map，不验证服务器是否已经遗忘该文档。

**字段说明：** 超限分支返回 `data.result` 错误文本；正常分支用 `handle` 读取文件，`stats.size` 执行上限判断，`fileContent` 通过 `encoding: 'utf-8'` 解码后传给 `manager.openFile()`。

`openFile(filePath, content)` 会按扩展名取 `languageId`，找不到映射时回退 `'plaintext'`；`didOpen.textDocument.version` 固定为 1。文件已在同一个 server 打开时重复调用会直接跳过。

Edit 与 Write 完成磁盘写入后走另一条同步路径：

```ts
const lspManager = getLspServerManager()
if (lspManager) {
  clearDeliveredDiagnosticsForFile(`file://${absoluteFilePath}`)
  lspManager
    .changeFile(absoluteFilePath, updatedFile)
    .catch((err: Error) => {
      logError(err)
    })
  lspManager.saveFile(absoluteFilePath).catch((err: Error) => {
    logError(err)
  })
}
```

`changeFile(filePath, content)` 在 server 尚未 running、或文件尚未 open 时回退到 `openFile()`；否则发送全文 `contentChanges: [{ text: content }]`。`saveFile(filePath)` 发送 `didSave`，但 server 不存在或不在 running 时直接返回。这两个调用都不接受 `null`，文件内容是完整字符串。

这里有一个必须说明的静态边界：Edit/Write 对 `changeFile()` 与 `saveFile()` 分别采用 fire-and-forget 并各自 catch。`didChange` 的 version 固定为 1，文档版本不会递增。

`closeFile()` 虽然已经实现 `didClose`，源码注释却明确说尚未接入 compact flow。不能把“有函数”写成“上下文压缩时必然关闭文档”。

## 主动路径：九种操作最终都变成 tool_result

`LSPTool` 是一个只读、并发安全、延迟展示的普通 Tool。它只有在 Manager 至少装配了一个非 error server 时 `isEnabled()` 才返回真；这并不要求 server 已经 running，第一次调用仍会 lazy start。

它的输入 Schema 公开九个 operation：

```ts
operation: z.enum([
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
]),
filePath: z.string(),
line: z.number().int().positive(),
character: z.number().int().positive(),
```

`operation` 只能取上述九个字符串。`filePath` 是相对或绝对路径的开放字符串，随后会展开并检查为普通文件；UNC 路径为避免 Windows NTLM 泄漏而跳过本地 stat，但权限检查仍走 Read 权限链。`line`、`character` 都是从 1 开始的正整数；即使 `documentSymbol` 和 `workspaceSymbol` 的协议参数不使用位置，这个工具级 Schema 仍要求提供两者。类型排除 `undefined`，数值下界排除 0。

映射到协议时，行列统一减 1：

```ts
const position = {
  line: input.line - 1,
  character: input.character - 1,
}

switch (input.operation) {
  case 'goToDefinition':
    return {
      method: 'textDocument/definition',
      params: {
        textDocument: { uri },
        position,
      },
    }
  case 'findReferences':
    return {
      method: 'textDocument/references',
      params: {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      },
    }
  case 'hover':
    return {
      method: 'textDocument/hover',
      params: {
        textDocument: { uri },
        position,
      },
    }
}
```

`getMethodAndParams(input, absolutePath)` 的 `input` 是已校验工具输入，`absolutePath` 是展开后的路径；返回 method 开放字符串与 method-specific `params: unknown`。references 固定 `includeDeclaration: true`。`workspaceSymbol` 固定空 query，表示请求全部 workspace symbols；incoming/outgoing calls 先请求 `prepareCallHierarchy`，只取返回数组第一项，再发第二次调用方向请求。

**字段说明：** `position.line` 与 `position.character` 分别取输入值减 1；每个位置型 `params` 都含 `textDocument.uri` 与 `position`。references 额外加入 `context.includeDeclaration: true`，各分支的 `method` 保存对应 JSON-RPC 方法名。

位置型结果还会过滤 gitignored 文件。definition、implementation 兼容 `Location` 与 `LocationLink`；空值由 formatter 变成“零结果”，非法 URI 会记录错误。最后，输出经过：

```ts
mapToolResultToToolResultBlockParam(output, toolUseID) {
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: output.result,
  }
}
```

`output` 是格式化后的 LSP 工具输出；`toolUseID` 是本次模型 tool_use 的开放字符串，用于把结果配回原调用。`type` 固定 `'tool_result'`，`content` 只放格式化字符串。`resultCount`、`fileCount` 会留在工具结构化输出中，但这段 API block 不会把它们单独展开。

**字段说明：** `tool_use_id` 原样取 `toolUseID`，`content` 取 `output.result`。

若扩展名缺少 server，Manager 返回 `undefined`，工具返回“No LSP server available”；spawn、initialize 或 request 抛错时，工具也把错误文案放进结果，把故障限制在当前工具调用。唯一被自动重试的协议错误是 code `-32801`（ContentModified）：最多额外重试 3 次，延迟依次为 500、1000、2000ms；其他错误立即结束这条请求。

## 被动路径：publishDiagnostics 要等 attachment 收集

server 的 `textDocument/publishDiagnostics` 不会直接插进当前 assistant message。`registerLSPNotificationHandlers()` 先校验通知至少含 `uri` 和 `diagnostics`，再把 LSP severity 映射成 Claude 的诊断级别：1→Error、2→Warning、3→Info、4→Hint，缺失或其他数字回退 Error。空诊断不会注册。

真正的缓存入口很小：

```ts
export function registerPendingLSPDiagnostic({
  serverName,
  files,
}: {
  serverName: string
  files: DiagnosticFile[]
}): void {
  pendingDiagnostics.set(randomUUID(), {
    serverName,
    files,
    timestamp: Date.now(),
    attachmentSent: false,
  })
}
```

`serverName` 是来源 server 名，`files` 是已经标准化的诊断文件数组；二者都必填。UUID 只用于避免快速通知互相覆盖。`timestamp` 记录接收时间，后续 attachment 内容只展示诊断内容；`attachmentSent` 初始固定 `false`。

`checkForLSPDiagnostics()` 会跨通知、跨 turn 去重，然后按 Error、Warning、Info、Hint 排序。每个文件最多保留 10 条，一次最多保留 30 条；跨 turn 的已交付 key 放在最多 500 个文件的 LRU 中。Edit/Write 修改文件时清掉该文件的已交付集合，使相同错误在新版本上可以再次出现。

最后，`getLSPDiagnosticAttachments()` 把注册表内容转成 conversation attachment：

```ts
async function getLSPDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!toolUseContext.options.tools.some(
    t => toolMatchesName(t, BASH_TOOL_NAME),
  )) {
    return []
  }

  const diagnosticSets = checkForLSPDiagnostics()
  return diagnosticSets.map(({ files }) => ({
    type: 'diagnostics' as const,
    files,
    isNew: true,
  }))
}
```

`toolUseContext` 必填，函数从其中读取本轮工具集合；Bash 缺席时直接返回空数组。它本身还只位于 `getAttachments()` 的 main-thread attachment 列表，因此 subagent 线程跳过这条自动注入路径。返回的 attachment `type` 固定 `'diagnostics'`，`isNew` 固定 `true`。

这解释了“诊断如何进入 Agent”：后续 attachment 收集点会把语言服务器通知包装成内部诊断上下文，system prompt 与普通 user message 保持原样。

## 失败边界：LSP 提供可降级的辅助证据

现在可以把容易误解的边界集中起来。

第一，**server 来源是已启用插件**。Manager 可以成功初始化为 0 个 server；Read、Edit、Bash 与主 Agent 循环仍可继续。

第二，**进程可用性要经过 spawn 与 initialize。** 命令可能缺失，spawn 可能失败，initialize 可能超时，server 也可能崩溃。`maxRestarts` 为 `undefined` 时回退 3；超过 crash recovery 上限后停止拉起子进程。关闭时即使 `shutdown / exit` 失败，也会继续 dispose connection 和 kill process。

第三，**能力声明与请求结果分层。** Client 保存服务端 capabilities；LSPTool 仍会发起所选 operation。某个 server 只支持 definition、缺少 call hierarchy 时，后者会走协议错误路径。

第四，**诊断缺少强版本证明。** 客户端声明 `versionSupport: false`，`didChange.version` 又固定为 1；Registry 以内容和位置去重，不按文档版本仲裁。诊断适合提醒 Agent“这里可能有新错误”；编译结果仍需由实际构建或测试确认。

因此，LSP 最合理的位置是语义反馈层：比字符串搜索更懂语言，比真实 build/test 更轻、更快，但最终修改仍要回到文件工具、权限链、编译与测试验证。

## 小结

Claude Code 的 LSP 集成让已启用插件提供 server 配置，再由 Manager 按扩展名路由、按需启动子进程。

server 启动后通过 stdio JSON-RPC 完成 `initialize → initialized` 握手。文档第一次使用时 `didOpen`，Edit/Write 后尝试 `didChange / didSave`。Agent 主动查询 definition、references、hover、symbols 和 call hierarchy 时，结果作为 `tool_result` 回流；server 被动推送 diagnostics 时，结果经 Registry 去重、限量，再作为主线程 attachment 注入。

这套设计把语言语义变成一种可降级的结构化证据。server 缺失、启动失败或诊断滞后时，主循环仍然能够继续；最终正确性仍要靠源码阅读、编译和测试闭环。

## 留给下一篇的问题

语言服务器解决代码语义以后，Claude Code 如何与 IDE、浏览器和其他外部客户端建立连接，并同步选区、文件与操作结果？

## 参考资料

- [Claude Code Tools Reference：LSP](https://code.claude.com/docs/en/tools-reference)

- [Claude Code Plugins Reference：LSP servers](https://code.claude.com/docs/en/plugins-reference)

- [Language Server Protocol Specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)

- [Claude Code: Grep vs LSP, and When to Use Each One](https://www.amazingcto.com/grep-or-lsp-in-claude-code/)

- [LSP for Claude Code: Symbol Search at Scale](https://claudefa.st/blog/tools/mcp-extensions/lsp-mcp-server)

- [Code Search for AI Agents: ripgrep, ast-grep, or Semantic?](https://ceaksan.com/en/code-search-for-ai-agents-which-tool-when)
