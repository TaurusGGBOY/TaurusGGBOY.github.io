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

## 回答上一篇的问题

上一篇最后留下的问题是：插件能够携带语言能力以后，Claude Code 如何启动 LSP 服务器、同步文档，并把诊断与代码导航结果注入 Agent？

先说结论：Claude Code 把这件事拆成了两条反馈路径。

第一条是**主动查询**。模型调用 `LSP` 工具，Claude Code 根据文件扩展名选择语言服务器，按需启动进程，发送 definition、references、hover、symbol 或 call hierarchy 请求，再把格式化结果包装成普通 `tool_result`。模型可以像消费 Read、Grep 的结果一样消费代码语义。

第二条是**被动诊断**。Edit、Write 修改文件后，运行时向语言服务器发送 `didOpen / didChange / didSave`；服务器稍后推送 `publishDiagnostics`。这些诊断先进入注册表，等主线程下一次收集 attachments 时，再作为 `diagnostics` 附件加入 Agent 上下文。

所以，LSP 并不是一段自动塞进 system prompt 的“代码知识”。它是一个按文件类型路由、按需启动的外部进程，以及两种明确的数据回流方式：

- Agent 主动问，结果走 `tool_use → tool_result`。
- Language Server 主动推，结果走 `publishDiagnostics → Registry → Attachment`。

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的源码块都是短摘录，省略了与当前结论无关的日志和分支；还原路径不等于 Anthropic 内部仓库的原始目录。

## LSP 解决的不是“读文件”，而是“理解语言”

我们先看整条链路。

![Claude Code LSP 生命周期、主动查询与被动诊断路径](/images/posts/claude-code-source-reading-29/29-lsp-integration-handdrawn.png)

这里先补三个基础概念。

**LSP（Language Server Protocol）**是一套编辑器与语言服务器之间的协议。客户端不必自己理解 TypeScript、Rust 或 Python 的语法和类型系统，只需把“某个文件、某一行、某个字符”的位置发给对应服务器，就能询问定义、引用、悬浮信息和调用关系。

**JSON-RPC**是这条协议的消息外壳。request 有请求 ID，需要 response；notification 没有请求 ID，不等待业务结果。`textDocument/definition` 是 request，`textDocument/didChange` 和 `textDocument/publishDiagnostics` 则是两个方向相反的 notification。

**文档同步**解决的是服务器内存里的文件版本与磁盘内容是否一致。只有先 `didOpen`，后续查询才有可靠的文档对象；文件变化后再发 `didChange`、`didSave`，服务器才能重新分析。但 notification 发出不等于诊断已经计算完成，因此 LSP 反馈天然具有异步性。

Claude Code 需要这套机制，是因为 Grep 可以找到同名字符串，却不知道它是局部变量、重载方法还是接口实现；LSP 能利用语言自己的索引和类型系统回答语义问题。反过来，LSP 也不能替代 Read、编译器和测试：服务器可能没安装、能力不完整、索引未完成，诊断还可能滞后。

## 第一层：LSP 配置只来自已启用插件

2.1.88 没有从普通 user/project settings 收集任意 LSP 命令。`restored-src/src/services/lsp/config.ts` 的入口写得很直接：

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

`getAllLspServers()` 没有参数，返回按 scoped server name 索引的配置对象。它只遍历 `enabled` 插件；某个插件没有 LSP 配置时，`getPluginLspServers()` 返回 `undefined`，该插件不会贡献 server。多个插件并行读取，但最后按原插件顺序合并；发生同名覆盖时，靠后的对象赋值生效。不过 server 名还会被改成 `plugin:<pluginName>:<name>`，正常情况下插件之间不会直接撞名。

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

`transport` 的静态可选值是 `'stdio' | 'socket'`，默认 `'stdio'`。但当前 `LSPClient.start()` 实际固定 `spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })`，没有读取 `transport`。。同样，实例构造器遇到非 `undefined` 的 `restartOnCrash` 会明确报“尚未实现”；配置字段存在不等于运行能力已经落地。

还有一个安全顺序：交互模式下，`main.tsx` 在 workspace trust 已确认后才调用 `initializeLspServerManager()`；同一处源码注释把非交互模式的 trust 视为隐式成立。因为插件的 `command` 最终会启动本地进程，所以交互路径不能在未信任目录里提前执行。这是上一篇“插件已安装不等于可以无条件运行”在 LSP 路径上的具体落点。

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

`initializeLspServerManager()` 没有参数，也没有返回 Promise；调用方不会被配置加载阻塞。bare/simple 路径直接跳过 LSP。初始化状态只有 `'not-started' | 'pending' | 'success' | 'failed'`；已有实例且不是 failed 时保持幂等，failed 状态再次调用则允许重试。`initializationGeneration` 用来阻止旧 Promise 在 reload 或 shutdown 后覆盖新状态。

这里注册诊断 handler 的时机也值得注意：Manager 完成配置装配后就注册，而 server 进程此时通常还没有启动。`LSPClient.onNotification()` 会把 handler 暂存，等连接建立后再挂到 JSON-RPC connection。因此，被动诊断不要求 server 在应用启动时常驻。

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

`serverName` 是加过插件 scope 的开放字符串；`config` 是对应 server 配置。扩展名统一转小写，一个扩展名可以对应多个 server，但 `getServerForFile()` 当前固定取 `serverNames[0]`，没有运行时优先级选择。单个配置无效只跳过该 server，不会让其他语言能力一起失败。

更关键的是，`createLSPServerInstance()` 只创建带状态的包装器，不启动子进程。真正访问某个文件时，`ensureServerStarted(filePath)` 才根据扩展名找到 server，并在状态为 `'stopped'` 或 `'error'` 时执行 `start()`。这就是 lazy start：没有访问 `.rs` 文件，就没有必要启动 rust-analyzer。

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

`config.command` 是可执行程序；`args` 为 `undefined` 时回退为空数组。`env` 可省略，并在 Client 内与 Claude Code 的子进程环境合并；`workspaceFolder` 可省略，默认当前 cwd。`initializationOptions` 可以是任意值，`undefined` 时明确回退 `{}`。`startupTimeout` 必须是正整数毫秒；省略时源码没有为 initialize 增加本地超时包装，最终等待行为取决于连接和 server。

`LSPClient.start(command, args, options?)` 使用 `child_process.spawn` 建立 stdin/stdout/stderr 管道，再用 `vscode-jsonrpc` 的 `StreamMessageReader / StreamMessageWriter` 创建连接。`options` 整体可为 `undefined`；`options.env` 和 `options.cwd` 也都可省略。Windows 上固定 `windowsHide: true`，其他平台该值无效果。

握手不是只发一个 initialize request。Client 收到结果后保存 `result.capabilities`，再发 `initialized` notification，最后才把 `isInitialized` 设为 `true`：

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

`initialize(params)` 的参数是完整 `InitializeParams`，不存在 `null` 回退；connection 未建立就直接报错。服务端 capabilities 允许为不同能力提供布尔值或 option 对象，源码在这里保存它，但 `LSPTool` 发请求前没有逐项做 capability gate。服务器不支持某个方法时，请求错误会沿工具错误路径返回，而不是被静态能力表提前隐藏。

客户端声明的能力也比较克制：workspace configuration 和 workspace folder change 都是 `false`；文档同步声明 `didSave: true`，但 `willSave / willSaveWaitUntil` 为 `false`；诊断支持 related information 和 tag 1/2，却明确 `versionSupport: false`；position encoding 只声明 UTF-16。也就是说，行列换算不是任意编码，服务器与客户端要按 UTF-16 position 对齐。

## 第四层：文档同步从 didOpen 开始，但版本并不完整

LSP 查询不是把磁盘路径直接丢给服务器。`LSPTool.call()` 首次访问文件时先读取内容，并建立 `didOpen`：

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

这里有一个必须说明的静态边界：Edit/Write 没有 await `changeFile()` 再调用 `saveFile()`，而是分别 fire-and-forget 并各自 catch。`didChange` 的 version 也固定为 1，没有递增的文档版本。

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

`operation` 只能取上述九个字符串。`filePath` 是相对或绝对路径的开放字符串，随后会展开并检查为普通文件；UNC 路径为避免 Windows NTLM 泄漏而跳过本地 stat，但权限检查仍走 Read 权限链。`line`、`character` 都是从 1 开始的正整数；即使 `documentSymbol` 和 `workspaceSymbol` 的协议参数不使用位置，这个工具级 Schema 仍要求提供两者。没有 `undefined` 或 0 的合法分支。

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

位置型结果还会过滤 gitignored 文件。definition、implementation 兼容 `Location` 与 `LocationLink`；空值由 formatter 变成“没有结果”，非法 URI 会记录错误。最后，输出经过：

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

若扩展名没有 server，Manager 返回 `undefined`，工具返回“No LSP server available”；spawn、initialize 或 request 抛错时，工具也把错误文案放进结果，而不是让整个 Agent loop 崩溃。唯一被自动重试的协议错误是 code `-32801`（ContentModified）：最多额外重试 3 次，延迟依次为 500、1000、2000ms；其他错误立即结束这条请求。

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

`serverName` 是来源 server 名，`files` 是已经标准化的诊断文件数组；二者都必填。UUID 只用于避免快速通知互相覆盖。`timestamp` 记录接收时间，但后续 attachment 内容没有把它展示给 Agent；`attachmentSent` 初始固定 `false`。

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

`toolUseContext` 必填，函数从其中读取本轮工具集合；没有 Bash 时直接返回空数组。它本身还只位于 `getAttachments()` 的 main-thread attachment 列表，因此 subagent 线程不会走这条自动注入路径。返回的 attachment `type` 固定 `'diagnostics'`，`isNew` 固定 `true`。

这解释了“诊断如何进入 Agent”：不是修改 system prompt，也不是语言服务器直接发一条 user message，而是在后续 attachment 收集点被包装成内部诊断上下文。

## 失败边界：LSP 是辅助证据，不是提交门禁

现在可以把容易误解的边界集中起来。

第一，**没有插件就没有 server**。Manager 可以成功初始化为 0 个 server；这不影响 Read、Edit、Bash 或主 Agent 循环。

第二，**server 配置存在也不等于进程可用**。命令可能不存在，spawn 可能失败，initialize 可能超时，server 也可能崩溃。`maxRestarts` 为 `undefined` 时回退 3；超过 crash recovery 上限后不再无界拉起子进程。关闭时即使 `shutdown / exit` 失败，也会继续 dispose connection 和 kill process。

第三，**能力声明不是能力保证**。Client 保存服务端 capabilities，却没有在每个 LSPTool operation 前做完整 capability gate。某个 server 只支持 definition、不支持 call hierarchy 时，后者仍可能走到协议错误路径。

第四，**诊断没有强版本证明**。客户端声明 `versionSupport: false`，`didChange.version` 又固定为 1；Registry 以内容和位置去重，不按文档版本仲裁。诊断适合提醒 Agent“这里可能有新错误”，不适合单独证明当前磁盘内容已经通过编译。

。

因此，LSP 最合理的位置是语义反馈层：比字符串搜索更懂语言，比真实 build/test 更轻、更快，但最终修改仍要回到文件工具、权限链、编译与测试验证。

## 小结

Claude Code 的 LSP 集成不是“内置所有语言”，而是让已启用插件提供 server 配置，再由 Manager 按扩展名路由、按需启动子进程。

server 启动后通过 stdio JSON-RPC 完成 `initialize → initialized` 握手。文档第一次使用时 `didOpen`，Edit/Write 后尝试 `didChange / didSave`。Agent 主动查询 definition、references、hover、symbols 和 call hierarchy 时，结果作为 `tool_result` 回流；server 被动推送 diagnostics 时，结果经 Registry 去重、限量，再作为主线程 attachment 注入。

这套设计的重点不是让 LSP 接管 Agent，而是把语言语义变成一种可降级的结构化证据。没有 server、启动失败或诊断滞后时，主循环仍然能够继续；真正的正确性仍要靠源码阅读、编译和测试闭环。

## 留给下一篇的问题

语言服务器解决代码语义以后，Claude Code 如何与 IDE、浏览器和其他外部客户端建立连接，并同步选区、文件与操作结果？

