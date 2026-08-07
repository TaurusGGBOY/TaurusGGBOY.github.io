---
title: "Claude Code源码解读30：浏览器与 IDE 如何接入运行时"
published: 2026-07-24T16:47:17+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-30/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇留下的问题是，我们经常看到文章说 Claude Code 使用 Grep 而不是 RAG；那么在同时拥有 Grep 和 LSP 的情况下，Claude Code 什么时候会使用 Grep，什么时候会使用 LSP？

答案先放在前面，**2.1.88 没有实现一个按照问题语义在 Grep、LSP 和 RAG 之间自动切换的统一路由器。**Grep 是默认的文本搜索能力，LSP 是满足开关和连接条件后才出现的语义工具；两者同时可用时，模型根据工具描述、已经掌握的文件位置和当前任务选择调用哪个。RAG 也不是这个版本内置的代码搜索工具，外部 MCP 或插件可以额外提供它，但不能把它和源码里的 Grep、LSP 混成同一条控制流。

## 介绍本章的一些概念

- 三条接入线，IDE lockfile、Chrome 配对、普通 MCP 配置，在进入 Agent 前都被翻译成 MCP transport（`sse-ide` / `ws-ide` / stdio / HTTP / WebSocket），执行内核始终只处理统一消息模型。
- 工具可见性由源码先过滤，`hasEmbeddedSearchTools()` 决定是否注册 Glob/Grep 专用工具，LSP 还要过 `ENABLE_LSP_TOOL` 与 `isLspConnected()` 两道门。
- IDE 通过 lockfile 发现连接，**必须恰好一个候选且 workspace 匹配才连接**（30 秒轮询）；自动连接只是往动态 MCP 配置添加 `ide` 条目，握手后能力才算存在。
- 现场同步用 notification（`selection_changed` / `at_mentioned`），反向操作用 RPC（`openDiff` 等）；RPC 完成后必须把返回结果重新解释成 accept / reject 与新 edits。
- Chrome 复用 MCP 但连接拓扑不同，进程内 linked transport 跳过独立 subprocess；配对、权限模式、站点权限是三道不同的门。
- Grep、LSP、RAG 不是同一路由器下的三种模式，2.1.88 没有按语义自动切换的统一路由器，模型根据工具描述与当前证据选择调用。

## 本篇新增

- 工具可用性的双层过滤，注册条件（`hasEmbeddedSearchTools`、`ENABLE_LSP_TOOL`）与 `isEnabled()`（`isLspConnected()`）。
- IDE 接入整条调用链，lockfile 发现、workspace 唯一匹配、动态 MCP 配置、`ws-ide`/`sse-ide` 传输、握手后的 capabilities 与 `ide_connected`。
- 选区和文件上下文经 `selection_changed` / `at_mentioned` 通知进入候选上下文；`openDiff` 等反向 RPC 的返回结果枚举。
- Chrome 接入拓扑，`setupClaudeInChrome()` 的 stdio 声明 + 进程内 linked transport、Native Messaging 配对、三层权限门。
- 普通外部 MCP 客户端与 IDE/Chrome 共享八类配置联合，但 scope、企业策略与宿主边界各不相同，共享协议不共享信任。

## 问题｜宿主现场如何进入 Agent 工作流

IDE 知道当前选区，Chrome 知道标签页，Claude Code 的 query loop 却不应该为每种宿主各写一套执行逻辑。接入的关键是把宿主现场翻译成协议消息，同时把 Agent 发起的操作送回正确的窗口。

在这张金额单位工单里，修复分支上的单元测试已经通过，但工程师仍不放心，浏览器页面显示的是格式化后的 `99.90`，真正发给支付服务的请求可能在另一层被重新换算。他把 IDE 停在金额转换函数上，打开测试页面，给 Claude Code 的最后一段要求是，

> 完成后使用 LSP、Chrome 和相关测试验证。浏览器里确认页面显示 99.90 元、Network 请求的金额字段为预期的分；把截图、请求摘要和测试结果一起返回，不要在生产页面操作。

> 当 IDE、Chrome 与终端同时在场时，Claude Code 如何知道用哪个窗口的现场，又怎样把 Edit、LSP 与浏览器动作送回正确的地方？

本篇的答案是把外部集成放在协议边缘，lockfile 或配对信息先找到宿主，MCP transport 完成握手，notification 同步现场，RPC/tool call 返回动作结果，执行内核始终只处理统一消息模型。

## 正文

本文以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的代码只保留证明主路径所需的部分；省略的 import、日志和平台分支会明确标出。

### 三种检索能力先不要混成一个概念

先不要把三种检索能力合并成一个"代码搜索器"。它们的输入、准备成本和错误边界不同，

| 能力 | 它回答的问题 | 是否需要预先建立代码索引 |
| --- | --- | --- |
| Grep | 哪些文件或行包含这个字符串/正则？ | 不需要；每次对当前文件树即时搜索 |
| LSP | 这个位置上的符号定义在哪里、谁引用它、它是什么类型？ | 需要语言服务器维护语义状态，但不是向量索引 |
| RAG | 哪些代码片段在语义上与这段自然语言最相关？ | 通常需要 embedding、分块和向量索引 |

所以 Grep 适合未知位置的即时定位，LSP 适合已经有文件坐标的语义关系，RAG 只有在外部索引/MCP 提供后才会出现。2.1.88 没有一个按自然语言自动切换三者的路由器，模型依据工具描述和当前证据选择调用。

### 源码先决定哪些工具能被模型看到

2.1.88 的工具注册顺序已经给出第一层答案。没有可用的嵌入式搜索实现时，工具列表加入专用的 `GlobTool` 和 `GrepTool`；LSP 则必须显式满足环境开关，

```ts
...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool])
...
...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool] : [])
```

> 证据，`restored-src/src/`（2.1.88 source map 还原源码），工具池注册条件。

前一行表示，某些 ant-native 构建把 `find`/`grep` 通过 shell alias 接到内嵌搜索程序，因而省掉专用工具对象。通常构建仍会暴露 `GrepTool`，它的 `call()` 最终组装参数并调用 `ripGrep()`，没有先读取向量数据库。

LSP 工具注册后还有第二道门，

```ts
isEnabled() {
  return isLspConnected()
}
```

> 证据，`restored-src/src/services/lsp/`（2.1.88 source map 还原源码），`LSPTool.isEnabled()`。

`isLspConnected()` 要求 Manager 已建立、至少有一个 server，并且至少一个 server 的状态不是 `error`。server 配置来自已启用插件；所以"安装了 LSP 插件"不等于本轮已经有可调用的 `LSP` 工具。在启用 Tool Search 的请求路径中，初始化仍在 `pending` 或尚未开始时，API 层会把 LSP 标记为 deferred，等 Manager 完成初始化后再决定是否提供。

这解释了很多看似矛盾的现象，你明明安装了 language server，模型却继续调用 Grep。可能是 `ENABLE_LSP_TOOL` 没开、插件没有 enabled、文件扩展名没有匹配 server、进程启动失败，或者 server 还没完成握手。此时 LSP 根本没有通过工具可用性检查，模型自然看不到它。

### Grep 什么时候是正确选择

`GrepTool` 的输入是正则模式 `pattern`，`path` 省略时回退当前工作目录；`glob` 和 `type` 可以缩小文件集合。`output_mode` 的源码可确认取值如下，

| `output_mode` | 返回内容 | 适合的问题 |
| --- | --- | --- |
| `'files_with_matches'`（默认） | 命中文件路径 | 先找可能相关的文件 |
| `'content'` | 命中行，可带上下文和行号 | 阅读字符串出现位置 |
| `'count'` | 每个文件的命中次数 | 统计影响范围 |

`head_limit` 未提供时默认 250；显式传 `0` 才表示不限制；`offset` 默认 0，用来分页。`multiline` 默认 `false`，只有显式开启才允许跨行匹配；`-n` 在 content 模式下默认显示行号。它仍然是对当前文件树的即时匹配，不知道一个名字究竟是定义、调用、注释还是测试桩。

所以这些任务应该先用 Grep，

- 搜索错误信息、日志、注释、TODO、配置键、feature flag 或字符串字面量；
- 用户只给出一个模糊的文本线索，需要先找出可能的目录和文件；
- 代码使用的语言没有已配置的 language server，或目标是 Markdown、YAML、JSON、脚本和生成文件；
- 需要对整个仓库做一次新鲜的宽范围扫描，不能接受索引滞后。

Grep 的代价也很明确，同名变量、注释和字符串会制造噪声，Agent 往往要经历"搜索，Read，再搜索"的循环。它适合建立候选集合，不适合单独证明"所有调用点都已经找到"。

### LSP 什么时候更有价值

`LSPTool` 的输入字段包括 `filePath`、1-based 的 `line` 和 `character`，再选择一个源码固定的 operation，

```text
goToDefinition       findReferences       hover
documentSymbol        workspaceSymbol      goToImplementation
prepareCallHierarchy  incomingCalls        outgoingCalls
```

这意味着 LSP 最适合"我已经知道一个符号位于哪里，现在要问它的语义关系"，跳到真实定义、找精确引用、查看类型与文档、找接口实现，或分析调用者和被调用者。工具在第一次处理文件时会先让 server `didOpen`；文件超过 10 MB、扩展名没有匹配 server、server 不健康或协议请求失败，都会落入错误/空结果路径。

编辑后的诊断也会形成一条反馈路径。Claude Code 的 LSP Manager 会同步打开、修改和保存的文档，server 通过 `publishDiagnostics` 返回类型或语法问题；这些诊断可以作为 Agent 的辅助证据，但仍应由编译和测试完成最终确认。即使模型没有主动调用 `goToDefinition`，编辑后的反馈阶段也会使用这类诊断。

### 三者放在一条实际工作流里

一个更接近真实会话的顺序是，

```text
自然语言线索
    │
    ├─ "哪里出现这个错误字符串/配置键？" ──> Grep
    │                                           │
    │                                           └─ 得到文件与位置
    │                                                       │
    ├─ "这个符号定义、引用和调用关系是什么？" ────────> LSP
    │                                                       │
    └─ "修改后哪里坏了？" <── LSP diagnostics ── Edit/Write ─┘
```

如果问题是"实现认证流程的代码在哪里"，外部 RAG/语义索引可能比纯文本更快找到候选；但它返回的是相关片段，不等于真实的定义或调用图。找到候选文件后，仍然应该用 LSP 验证符号关系，再用 Read、编译器和测试确认行为。没有外部 RAG 时，Grep 通过多个文本线索和 Agent 的逐步阅读承担发现阶段。

选择规则可以压缩成一句话，**不知道名字或搜索的是文本，用 Grep；知道符号位置并要语义关系，用 LSP；只知道"它大概做什么"且项目另有向量索引时，才考虑 RAG。**

### 外部宿主把现场翻译成协议消息

在看调用链之前，先明确四个概念怎样划分宿主适配层。

**宿主（host）**是用户正在操作的外层环境。终端、IDE 和浏览器都可以是宿主。它们拥有模型本身不知道的现场，IDE 知道当前选区和打开的文件，浏览器知道标签页、DOM、控制台和网络请求。**传输（transport）**负责搬运字节。`stdio`、SSE、HTTP、WebSocket、Native Messaging 都属于传输；能力含义则由后续协议握手与工具 Schema 确认。**协议与握手（protocol / handshake）**负责约定消息结构。MCP client 连接后会得到 server version、capabilities 和 instructions；服务端声明的工具或资源决定运行时继续装配哪些能力。**通知与 RPC**解决两个方向的问题。`selection_changed` 是宿主主动推送的通知，不要求模型先调用工具；`openDiff` 是 Claude Code 发向 IDE 的 RPC，需要等待宿主返回操作结果。一个把现场送进来，一个把动作送出去。

![IDE、Chrome 与外部 MCP 客户端接入 Claude Code 的适配链路](/images/posts/claude-code-source-reading-30/30-browser-ide-external-tools-handdrawn.png)

三条线进入 MCP 以前各有一道门，IDE 先确认 workspace，Chrome 先完成扩展配对，普通外部 MCP 先经过配置来源、认证与企业策略。统一协议只封装宿主差异，不跳过这些门。

### IDE 先通过 lockfile 发现连接

IDE 扩展把连接信息写进 Claude 配置目录下的 lockfile。`restored-src/src/utils/ide.ts` 对新格式的定义如下，

```ts
type LockfileJsonContent = {
  workspaceFolders?: string[]
  pid?: number
  ideName?: string
  transport?: 'ws' | 'sse'
  runningInWindows?: boolean
  authToken?: string
}
```

> 证据，`restored-src/src/utils/ide.ts`（2.1.88 source map 还原源码），lockfile JSON 格式。

`LockfileJsonContent` 描述扩展写入的 JSON。`transport` 只有 `'ws'` 和 `'sse'` 两个源码可确认的值；省略后读取逻辑把 `useWebSocket` 保持为 `false`，也就是走 SSE。`workspaceFolders` 省略时回退为空数组，后续 workspace 匹配将得不到候选；`pid`、`ideName` 和 `authToken` 都允许省略，并分别跳过进程缩小、名称展示与认证头。`runningInWindows` 只有严格等于 `true` 才启用 Windows 路径转换，其余值走本机路径分支。`readIdeLockfile()` 还兼容旧格式，如果 JSON 解析失败，就把文件按行拆成 workspace 路径；端口则从 `<port>.lock` 的文件名提取。lockfile 同时保存 IDE 存活标记与连接发现信息。

但发现端口还不够。机器上可能同时开着多个 VS Code、Cursor 或 JetBrains 窗口。Claude Code 会把 lockfile 的 workspace 与当前 cwd 比较，当前目录必须等于某个 workspace，或者位于它下面；在内置终端场景还会结合 PID 祖先关系缩小范围。`findAvailableIDE()` 的停止条件也写得很保守，

```ts
export async function findAvailableIDE(): Promise<DetectedIDEInfo | null> {
  if (currentIDESearch) currentIDESearch.abort()
  currentIDESearch = createAbortController()
  const signal = currentIDESearch.signal

  await cleanupStaleIdeLockfiles()
  const startTime = Date.now()
  while (Date.now() - startTime < 30_000 && !signal.aborted) {
    const ides = await detectIDEs(false)
    if (signal.aborted) return null
    if (ides.length === 1) return ides[0]!
    await sleep(1000, signal)
  }
  return null
}
```

> 证据，`restored-src/src/utils/ide.ts`（2.1.88 source map 还原源码），`findAvailableIDE()` ， 唯一候选才连接。

`findAvailableIDE()` 是空参函数，返回 `DetectedIDEInfo | null`。它最多轮询 30 秒，每轮间隔 1 秒；只有找到**恰好一个**有效 IDE 才返回。零个候选、多个候选、超时或被新的搜索通过 `AbortController` 取消，都返回 `null`。实际源码还会在终端滚动排空期间暂停检测，片段为突出停止条件省略了该分支。

为什么多个候选时不随便挑一个？连接还必须匹配正确 workspace。把另一个窗口的选区或 diff 当成本项目事实，比暂时不连接更难发现。

检测结果最后被整理成 URL，`transport === 'ws'` 生成 `ws://<host>:<port>`，否则生成 `http://<host>:<port>/sse`。在 WSL 中，如果扩展运行在 Windows 侧，源码还会转换 workspace 路径并寻找宿主 IP。这说明"本机 IDE"也不一定和 CLI 共享同一个文件系统视角。

### 自动连接只是添加动态 MCP 配置

IDE 检测不会直接把 socket 塞进 Agent。`useIDEIntegration()` 先检查自动连接条件，再向动态 MCP 配置中添加一个名为 `ide` 的条目，

```ts
setDynamicMcpConfig(prev => {
  if (prev?.ide) return prev
  return {
    ...prev,
    ide: {
      type: ide.url.startsWith('ws:') ? 'ws-ide' : 'sse-ide',
      url: ide.url,
      ideName: ide.name,
      authToken: ide.authToken,
      ideRunningInWindows: ide.ideRunningInWindows,
      scope: 'dynamic' as const,
    },
  }
})
```

> 证据，`restored-src/src/utils/ide.ts`（2.1.88 source map 还原源码），`useIDEIntegration()` 写入动态 MCP 配置。

这段状态更新的输入 `prev` 是 `Record<string, ScopedMcpServerConfig> | undefined`；`undefined` 表示动态配置尚未建立，展开运算按空对象处理。若 `prev.ide` 已存在，函数原样返回，避免后一次检测覆盖当前连接。`type` 只有 `'ws-ide'` 与 `'sse-ide'` 两个结果，由 URL 是否以 `ws:` 开头决定；`scope` 固定为 `'dynamic'`，表示它来自本次运行时发现。

自动连接由多项条件共同控制。全局 `autoConnectIde`、CLI flag、受支持的内置终端、`CLAUDE_CODE_SSE_PORT`、待安装 IDE 类型或 `CLAUDE_CODE_AUTO_CONNECT_IDE` 任一条件可以开启；环境变量被明确设置为 falsy 时会关闭。源码还把 `autoInstallIdeExtension` 的缺省值设为 `true`，可由 `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL` 阻止自动安装。安装、发现和连接分属三个步骤。

### 握手之后，能力才算真正存在

动态配置进入通用 MCP client 后，`sse-ide` 和 `ws-ide` 才分别创建传输。WebSocket 分支会携带 lockfile 中的可选认证令牌，

```ts
} else if (serverRef.type === 'ws-ide') {
  const wsHeaders = {
    'User-Agent': getMCPUserAgent(),
    ...(serverRef.authToken && {
      'X-Claude-Code-Ide-Authorization': serverRef.authToken,
    }),
  }

  const wsClient = await createNodeWsClient(serverRef.url, {
    headers: wsHeaders,
    agent: getWebSocketProxyAgent(serverRef.url),
  })
  transport = new WebSocketTransport(wsClient)
}
```

> 证据，`restored-src/src/services/mcp/`（2.1.88 source map 还原源码），`ws-ide` 传输分支。

`wsHeaders` 始终包含 `'User-Agent'`，有 `serverRef.authToken` 时再加入 `'X-Claude-Code-Ide-Authorization'`；`authToken` 为 `undefined` 或空字符串时不会添加认证头。`createNodeWsClient()` 的选项中，`headers` 取 `wsHeaders`，`agent` 取当前 URL 对应的 WebSocket proxy agent。SSE-IDE 分支则创建 `SSEClientTransport`；2.1.88 的源码注释明确写着该分支尚未使用 lockfile 提供的 auth token，因此不能把 WebSocket 的认证结论外推给 SSE。

传输连接后，MCP client 读取 `getServerCapabilities()`、`getServerVersion()` 和 `getInstructions()`。instructions 超过内部上限会被截断；IDE 连接成功还会发送一条 `ide_connected` notification，其中包含当前 Claude Code 进程 PID。握手的意义就在这里，从这一刻开始，双方交换的是带版本和能力边界的协议消息，不再只是"某端口可以打开"。

失败也有明确状态。`MCPServerConnection` 是判别联合，`'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'`。只有 `'connected'` 分支带可调用的 client 和 capabilities。UI 因此可以分别显示配置缺失、正在连接、需要认证和连接失败。

### 选区和文件上下文通过通知更新

连接建立后，IDE 扩展会主动发送 `selection_changed`。`useIdeSelection()` 注册的 Zod schema 给这条消息划定了边界，

```ts
const SelectionChangedSchema = lazySchema(() =>
  z.object({
    method: z.literal('selection_changed'),
    params: z.object({
      selection: z.object({
        start: z.object({ line: z.number(), character: z.number() }),
        end: z.object({ line: z.number(), character: z.number() }),
      }).nullable().optional(),
      text: z.string().optional(),
      filePath: z.string().optional(),
    }),
  }),
)
```

> 证据，`restored-src/src/`（2.1.88 source map 还原源码），`SelectionChangedSchema()`。

`SelectionChangedSchema()` 是空参函数，返回一个延迟构造的 schema。`method` 只能是 `'selection_changed'`。`selection` 为对象时更新坐标，为 `null` 时清空当前选区，省略字段时保留"本次通知未携带坐标"的状态；省略 `text` 或 `filePath` 时，对应上下文字段也无法更新。行号和字符位置是开放数字，schema 在此处只校验数值类型。

处理函数会用 `end.line - start.line + 1` 算行数；如果结束位置的 `character === 0`，再减一行，因为这表示选区恰好停在下一行开头。连接切换时，它还会把 `lineCount` 重置为 0，并把 `lineStart`、`text`、`filePath` 设为 `undefined`，避免旧 IDE 的选区继续污染新连接。

文件提及走另一条通知 `at_mentioned`。它要求 `filePath`，允许 `lineStart`、`lineEnd` 省略，并把 IDE 的 0-based 行号加一后交给 UI。适配层会先校验、归一化原始宿主事件，再生成内部可消费的上下文。选区最终是否进入某一轮 prompt，还要看 REPL 的输入与附件组装；notification 只提供候选现场，模型读取文件与内容校验仍由后续工具链完成。

### 反向操作通过 RPC，结果必须重新解释

Claude Code 发向 IDE 的调用复用了 MCP tool call，

```ts
export async function callIdeRpc(
  toolName: string,
  args: Record<string, unknown>,
  client: ConnectedMCPServer,
): Promise<string | ContentBlockParam[] | undefined> {
  const result = await callMCPTool({
    client,
    tool: toolName,
    args,
    signal: createAbortController().signal,
  })
  return result.content
}
```

> 证据，`restored-src/src/`（2.1.88 source map 还原源码），`callIdeRpc()`。

`toolName` 是开放字符串，由调用点提供，例如 `'openDiff'`、`'close_tab'`、`'openFile'` 或 `'getDiagnostics'`，本函数本身不限制全部合法值。`args` 是开放键值对象，字段约束属于对应 IDE tool；`client` 必须已经是 `ConnectedMCPServer`，不能传 pending 或 failed 状态。返回值可能是字符串、MCP content block 数组或 `undefined`，调用方必须继续判别。

以 `openDiff` 为例，Claude Code 发送旧路径、新路径、候选新内容和 tab 名称。IDE 返回三类可识别结果，

- `FILE_SAVED` 后跟新文本，用户在 IDE 中保存，运行时采用 IDE 返回的最终内容；
- `TAB_CLOSED`，用户关闭 diff tab，运行时采用原先生成的候选内容；
- `DIFF_REJECTED`，用户拒绝，运行时保留旧内容；
- 其他结构，抛出 `Not accepted`，不能猜测用户意图。

这里体现了外部宿主接入最重要的设计原则，**RPC 完成后还要解释业务结果。** 调用方把 IDE 返回值转换为文件编辑权限流程可以理解的 accept / reject 与新 edits。取消信号和进程退出还会触发清理，尽量关闭残留 tab。

源码也提供了更轻的外部编辑器路径，`openFileInExternalEditor()` 可以依据 `$VISUAL` / `$EDITOR` 启动 VS Code、Vim 等程序，只负责进程拉起和终端切换。MCP 握手、选区通知与结构化结果属于 IDE 运行时集成路径。

### Chrome 复用 MCP，但连接拓扑不同

Claude in Chrome 通过进程内 MCP 适配层连接浏览器。`setupClaudeInChrome()` 先生成动态 MCP 配置和允许的浏览器工具名，

```ts
export function setupClaudeInChrome() {
  const allowedTools = BROWSER_TOOLS.map(
    tool => `mcp__claude-in-chrome__${tool.name}`,
  )

  const env: Record<string, string> = {}
  if (getSessionBypassPermissionsMode()) {
    env.CLAUDE_CHROME_PERMISSION_MODE = 'skip_all_permission_checks'
  }

  return {
    mcpConfig: {
      [CLAUDE_IN_CHROME_MCP_SERVER_NAME]: {
        type: 'stdio' as const,
        command: process.execPath,
        args: ['--claude-in-chrome-mcp'],
        scope: 'dynamic' as const,
        ...(Object.keys(env).length > 0 && { env }),
      },
    },
    allowedTools,
    systemPrompt: getChromeSystemPrompt(),
  }
}
```

> 证据，`restored-src/src/`（2.1.88 source map 还原源码），`setupClaudeInChrome()`。

`setupClaudeInChrome()` 是空参函数，返回 `mcpConfig`、`allowedTools` 和 `systemPrompt`。配置的 `type` 固定为 `'stdio'`，`scope` 固定为 `'dynamic'`；不同打包形态下 `args` 可能还会包含 `cli.js` 路径，片段展示的是 bundled 分支。`BROWSER_TOOLS` 来自 Chrome MCP 包，属于构建时依赖。只有 session 已处于 bypass permissions 模式时才向子环境写入 `'skip_all_permission_checks'`。

通用 MCP client 识别到 server 名称是 `claude-in-chrome` 后，会创建 `createLinkedTransportPair()`，让 MCP client 与进程内 Chrome MCP server 直接连接，从而跳过约 325 MB 的独立 subprocess。这个 server 再通过安全 socket、Native Messaging host 或可选 Bridge URL 联系浏览器扩展。

为什么外面还保留 `stdio` 形态？因为配置层只需要声明"这是一个 MCP server"；连接层可以针对已知内置 server 优化部署方式。上层工具注册、call/result 和渲染逻辑仍然复用 MCP，不必知道底下已经改成进程内传输。Native Messaging manifest 还列出明确的 `allowed_origins`，公开构建只允许生产扩展 ID；内部构建才追加开发与内部扩展 ID。该字段控制哪些浏览器扩展能启动本地 host；网页站点权限由扩展设置管理。

### 配对、权限模式和站点权限是三道不同的门

`createChromeContext()` 会选择 Bridge URL；URL 缺失时使用 native socket。它还恢复持久化的 `pairedDeviceId`，扩展配对后保存 device ID 与名称。认证错误提示要求浏览器扩展与 Claude Code 使用同一个 claude.ai 账号。

权限模式的解析也很谨慎，

```ts
const rawPermissionMode =
  env?.CLAUDE_CHROME_PERMISSION_MODE ??
  process.env.CLAUDE_CHROME_PERMISSION_MODE

let initialPermissionMode: PermissionMode | undefined
if (rawPermissionMode) {
  if (isPermissionMode(rawPermissionMode)) {
    initialPermissionMode = rawPermissionMode
  } else {
    logger.warn(`Invalid CLAUDE_CHROME_PERMISSION_MODE`)
  }
}
```

> 证据，`restored-src/src/`（2.1.88 source map 还原源码），权限模式解析。

`env` 是可选的 `Record<string, string>`；传入值优先于进程环境变量，只有前者为 `null` 或 `undefined` 才回退，空字符串不会触发 `if (rawPermissionMode)`。合法候选由项目的 `isPermissionMode()` / `PERMISSION_MODES` 定义验证，本函数不接受任意字符串；非法值只记录警告，`initialPermissionMode` 仍为 `undefined`。公开主路径同步到扩展的执行模式实际压缩成 `'ask'`，只有 Claude Code 的 `bypassPermissions` 映射成 `'skip_all_permission_checks'`。

Chrome 设置界面还会提供站点级权限，浏览、点击和输入均继承浏览器扩展设置。于是一次浏览器动作至少跨过三层，

1. 本地 native host / Bridge 是否与正确扩展配对；
2. Claude Code 与 Chrome MCP 当前采用 ask 还是跳过检查；
3. 扩展是否允许当前站点上的具体能力。

因此，浏览器动作要同时满足会话启用、Claude Code 工具权限与扩展站点权限；任一层拒绝都会停止调用。`shouldEnableClaudeInChrome()` 在非交互会话中默认返回 `false`，除非显式传入 `--chrome`；CLI 的 `--chrome` / `--no-chrome`、环境变量和全局默认配置按顺序决定是否启用。全局 `claudeInChromeDefaultEnabled` 为 `undefined` 时最终默认关闭。这个默认值解释了为什么浏览器能力不会仅因本机安装了扩展就悄悄进入所有 SDK 或 CI 运行。

### 浏览器消息和工具结果仍要经过结构化边界

Chrome MCP 暴露的浏览器动作最终仍按普通 MCP tools 注册。`callMCPTool()` 发出调用，结果再被 Chrome 专用渲染适配器解释；工具输入中的 tab ID 会被追踪，用于渲染 "View Tab" 链接和过滤扩展广播。

源码还定义了浏览器扩展向 Claude Code 推送 prompt 的 JSON-RPC schema，`method` 固定为 `'notifications/message'`，`prompt` 必须是字符串，`tabId` 可选为数字，图片可选为 base64，`media_type` 只能是 `image/jpeg`、`image/png`、`image/gif`、`image/webp`。处理器只接受已经追踪的 tab ID，避免其他标签页的广播被当成本轮输入。不过，2.1.88 还原源码中的这条主动 prompt 处理路径带有内部构建门控；更稳妥的结论是，协议和校验结构存在，但具体构建是否启用要服从源码中的门控。

Chrome 断连时，context 提供专门的 `onToolCallDisconnected` 错误文本；IDE 和通用 MCP 也会进入 failed / pending 等连接状态。断连信息必须回到连接管理层，而不能把上一次页面、选区或结果继续当作当前事实。

### 普通外部客户端共享协议，不共享信任

IDE 与 Chrome 的特殊处理容易让人忽略，它们最终仍站在通用 MCP 类型系统上。`restored-src/src/services/mcp/types.ts` 的配置联合包含，

```ts
export const McpServerConfigSchema = lazySchema(() =>
  z.union([
    McpStdioServerConfigSchema(),
    McpSSEServerConfigSchema(),
    McpSSEIDEServerConfigSchema(),
    McpWebSocketIDEServerConfigSchema(),
    McpHTTPServerConfigSchema(),
    McpWebSocketServerConfigSchema(),
    McpSdkServerConfigSchema(),
    McpClaudeAIProxyServerConfigSchema(),
  ]),
)
```

> 证据，`restored-src/src/services/mcp/types.ts`（2.1.88 source map 还原源码），`McpServerConfigSchema()`。

`McpServerConfigSchema()` 是空参函数，返回八类配置的联合。`stdio` 的 `type` 可以省略以兼容旧配置，`args` 省略时默认 `[]`；`sse`、`http`、`ws` 要求 URL，并分别支持源码定义的 headers、headers helper 或 OAuth 子字段；`sse-ide` / `ws-ide` 是内部 IDE 类型；`sdk` 只保存 name，并在 print 路径单独处理；`claudeai-proxy` 需要 URL 与 server ID。

除由 `print.ts` 单独接入的 `sdk` 类型外，其余配置会在通用连接管理中建立 MCP client，握手得到 capabilities，再拉取 tools、prompts 或 resources；SDK 路径也复用 MCP client 契约，但不经过普通 `connectToServer()` 的 transport 分支。信任不会因为协议统一而统一，

- 配置 scope 可能是 `local`、`user`、`project`、`dynamic`、`enterprise`、`claudeai` 或 `managed`；
- 企业策略可以在连接前过滤 server；
- HTTP/SSE 可以有 OAuth 与 headers，WebSocket 可以有 headers，stdio 则会启动本地命令；
- MCP tool 被模型选择后，仍要经过工具 Schema、权限和执行生命周期；
- SDK server、IDE direct RPC 与 Chrome 站点权限还有各自的宿主边界。

### 为什么要把 IDE 和浏览器接在协议边缘

这套设计解决了四个工程问题。

第一，**Agent 内核可以复用**。模型看到的仍是消息、通知、tool use 和 tool result，不需要为 VS Code、JetBrains、Chrome 分别实现 query loop。

第二，**宿主能力可以按运行时协商**。某个 IDE 支持 `openDiff`，不代表所有 IDE 都支持；某个 MCP server 声明 resources，也不代表另一个 server 有。capabilities 与实际工具列表比按产品名称猜测更可靠。

第三，**现场同步可以增量进行**。选区变化用 notification 推送，不必每轮轮询整个 IDE；浏览器工具只返回当前操作需要的内容，不必把整个页面常驻在主进程。

第四，**失败边界可被看见**。连接失败、认证失败、工具失败、宿主拒绝是不同状态。只有分开记录，运行时才知道应该重连、重新认证、提示用户，还是保留旧文件。

代价也很明确，系统多了一层异步状态。通知可能晚到，选区可能在发送 prompt 前已经改变，IDE diff 可能被用户关闭，浏览器扩展可能在 tool call 中途断开。源码通过 client identity 检查、schema 校验、AbortSignal、连接判别联合和结果枚举减少误判，但无法把分布式时序变成强一致事务。

接入的主线可以压缩成五步，

1. IDE 通过 lockfile 被发现，Chrome 通过 Native Messaging / Bridge 配对，普通 MCP 通过配置进入候选集合；
2. 适配层把它们转换成 `sse-ide`、`ws-ide`、stdio、HTTP、WebSocket 等 MCP transport；
3. MCP 握手确认 server version、instructions 和 capabilities，连接状态进入 connected / failed / pending 等判别分支；
4. IDE 选区与提及通过 notification 进入候选上下文，IDE diff 和浏览器操作通过 tool call / RPC 返回结构化结果；
5. workspace 校验、认证或配对、Claude Code 权限模式、扩展站点权限与企业策略共同守住边界。

连接成功只表示通道可用；外部事件仍要经过校验、归一化、权限和状态更新，才能成为本轮执行的一部分。

## 源码映射表

| 接入线 | 关键文件（`restored-src/src/`） | 关键函数 / 符号 | 证据 | 要点 |
|---|---|---|---|---|
| 工具池 | 工具注册路径 | `hasEmbeddedSearchTools()`、`ENABLE_LSP_TOOL`、`LSPTool.isEnabled()` | 函数按还原源码引用 | 双层过滤决定模型可见工具 |
| IDE 发现 | `utils/ide.ts` | `LockfileJsonContent`、`readIdeLockfile()`、`detectIDEs()`、`findAvailableIDE()` | 源码已确认 | lockfile + workspace 唯一匹配，30 秒轮询 |
| IDE 接入 | `utils/ide.ts` | `useIDEIntegration()`、`setDynamicMcpConfig()` | 源码已确认 | 自动连接 = 添加 `ide` 动态条目 |
| MCP 握手 | `services/mcp/` | `ws-ide` 分支、`SSEClientTransport`、`ide_connected`、`MCPServerConnection` | 函数按还原源码引用 | 能力协商与判别联合 |
| 现场同步 | 选区/提及通知路径 | `SelectionChangedSchema()`、`at_mentioned` 处理 | 函数按还原源码引用 | 0-based 转 1-based，行数修正 |
| 反向 RPC | `callIdeRpc()`、`callMCPTool()` | `openDiff` 结果枚举 | 函数按还原源码引用 | 结果必须重新解释 |
| Chrome | Chrome 接入路径 | `setupClaudeInChrome()`、`createLinkedTransportPair()`、`createChromeContext()`、`shouldEnableClaudeInChrome()` | 函数按还原源码引用 | 进程内传输 + 三层权限门 |
| 配置联合 | `services/mcp/types.ts` | `McpServerConfigSchema()` | 源码已确认 | 八类配置；共享协议不共享信任 |

> 证据说明，标"源码已确认"的行沿用本系列已核对文件；其余函数按还原源码中的符号引用。路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。

## 设计决策｜为什么把宿主差异隔离在协议边缘

源码没有官方选型文档，下面的判断来自代码结构本身，属于解释。

**第一，内核不感知宿主。** 如果 query loop 直接 import 浏览器或 IDE 的实现，每加一种宿主就要改一次控制流；把宿主差异全部翻译成 MCP transport 与消息，内核只消费统一消息模型。IDE 的 `sse-ide`/`ws-ide` 和 Chrome 的 stdio 声明都落在这条边界上。

**第二，发现与连接分步。** IDE 检测只产出"可能的目标"，自动连接才写入动态 MCP 配置，握手后才出现可调用能力。三步之间任一失败都可被单独观察，没有 lockfile、workspace 不匹配、连接被拒。这个分层也避免了"检测成功 = 连接成功"的误判。

**第三，唯一候选才连接。** 多开 IDE 时把另一个窗口的选区当成本项目事实，比暂时不连接更难发现。30 秒轮询 + 恰好一个候选，本质是用"保守的连接"换"正确的现场"。

**第四，通知与 RPC 分工。** 宿主→Agent 的现场用 notification（无需模型参与、无返回值）；Agent→宿主的动作用 RPC/tool call（有返回值、要解释结果）。如果反用，模型每轮都要被选区变化打断；如果统一成通知，`openDiff` 就不知道用户是否保存了文件。

**第五，部署形态与配置解耦。** Chrome 配置层声明 stdio，连接层却能创建进程内 linked transport 跳过 325 MB 的独立 subprocess。上层逻辑复用 MCP，底层按已知 server 优化，这是"协议边缘"隔离带来的直接收益。

**第六，权限分层而不是合并。** 配对（谁是扩展）、权限模式（ask 还是跳过）、站点权限（这个页面允不允许）是三个不同变化节奏的问题，合并成一个开关会让任一层拒绝都无法定位。

## 练习｜走一遍 IDE 自动连接与 Chrome 调用

**练习 A，IDE 自动连接。** 把"在内置终端里启动 Claude Code，VS Code 已打开当前项目"走一遍，

1. 启动时检查自动连接条件（`autoConnectIde`、内置终端、CLI flag 等），需要时触发 IDE 扩展自动安装。
2. `findAvailableIDE()` 开始 30 秒轮询，`detectIDEs()` 读取 lockfile、清理 stale lockfile、按 workspace 与 cwd 匹配。若同时开着 VS Code 和 Cursor 且都匹配，本轮返回 `null`，不连接。
3. 唯一候选找到后，`useIDEIntegration()` 把 `ide` 条目写进动态 MCP 配置（`sse-ide` 或 `ws-ide`）。
4. 通用 MCP client 创建 transport（`ws-ide` 带 `X-Claude-Code-Ide-Authorization` 头），握手后读 capabilities / version / instructions，发送 `ide_connected`。
5. 用户在 IDE 里移动光标，扩展推送 `selection_changed`；`end.character === 0` 时行数再减一。之后模型在下一轮可能根据选区上下文继续编辑。

**练习 B，Chrome 浏览器动作。** 走一遍"Claude 点击页面上的提交按钮"，

1. 会话启用 `--chrome`，`setupClaudeInChrome()` 生成 stdio 动态配置与 `mcp__claude-in-chrome__*` 工具名。
2. 连接层识别 `claude-in-chrome`，创建 `createLinkedTransportPair()` 跳过独立 subprocess；server 经 native socket / Bridge 联系已配对扩展。
3. 动作跨过三道门，配对（扩展 ID 在 `allowed_origins` 中）、权限模式（`ask` 或 `skip_all_permission_checks`）、站点权限（扩展设置允许当前页面点击）。
4. 工具被模型选择后，经过工具 Schema、权限与执行生命周期；结果经 Chrome 渲染适配器解释，tab ID 被追踪用于 "View Tab" 链接。
5. 扩展中途断连 → `onToolCallDisconnected` 错误回到连接管理层，而不是继续使用旧页面事实。

**选择小练习**，判断下面三个任务各用什么检索能力起步，并说明依据。

1. "把日志里出现的 `timeout: 30000` 都找出来。" → **Grep**，这是字符串字面量，语义索引没有优势。
2. "`convertAmount` 的调用者有哪些？" → **LSP `findReferences`**，已经有符号坐标，需要精确引用。
3. "帮我找一段实现支付金额换算的代码。" → Grep 起步（如 `convertAmount`、`amount`），外部 RAG 可加速发现；找到候选后用 LSP 验证定义与引用。

## 自测

不看上文，先凭记忆回答，再展开参考答案核对。

1. `findAvailableIDE()` 在什么条件下返回 `null`？
2. IDE 的自动连接为什么不能只看 lockfile 的端口？
3. `selection_changed` 里 `end.character === 0` 表示什么，处理函数怎么修正行数？
4. `openDiff` 返回 `TAB_CLOSED` 时，运行时采用哪份内容？
5. Chrome 动作必须同时满足哪三层权限？
6. 为什么 `shouldEnableClaudeInChrome()` 在非交互会话中默认返回 `false`？

<details>
<summary>参考答案</summary>

1. **零个候选、多个候选、超时或被 AbortController 取消**。只有恰好一个有效 IDE 才返回；多个候选时不随便挑，因为连接必须匹配正确 workspace，错配现场比暂不连接更难发现。

2. 端口只是发现信息。**workspace 必须匹配**（当前 cwd 等于某个 workspace 或位于其下），内置终端场景还会结合 PID 祖先关系缩小；自动连接还受 `autoConnectIde`、CLI flag、内置终端、环境变量等条件控制，且"自动连接"本身只是往动态 MCP 配置添加条目，握手后才出现能力。

3. **选区恰好停在下一行开头**。处理函数按 `end.line - start.line + 1` 计算行数，`end.character === 0` 时再减一行；连接切换时还会重置 `lineCount`、清空 `lineStart`、`text`、`filePath`，避免旧 IDE 选区污染新连接。

4. **运行时采用原先生成的候选内容**。`FILE_SAVED` 用 IDE 返回的最终内容；`DIFF_REJECTED` 保留旧内容；其他结构抛出 `Not accepted`，不能猜测用户意图，RPC 完成后必须把返回值重新解释成 accept / reject 与新 edits。

5. **配对层**（native host / Bridge 与正确扩展，`allowed_origins` 控制谁能启动本地 host）、**权限模式层**（`ask` 还是 `skip_all_permission_checks`）、**站点权限层**（扩展是否允许当前站点能力）。任一层拒绝都会停止调用。

6. 默认关闭是有意的保守策略，**浏览器能力不应仅因本机安装了扩展就悄悄进入 SDK 或 CI 运行**。除非显式传入 `--chrome`，非交互会话默认不启用；全局 `claudeInChromeDefaultEnabled` 为 `undefined` 时最终默认关闭。

</details>

## 回顾｜Grep、LSP 和 RAG 到底怎么选

回到上一篇留给本篇的问题，用工具可用性收束答案。

<details>
<summary>展开查看回顾</summary>

**2.1.88 没有实现一个按照问题语义在 Grep、LSP 和 RAG 之间自动切换的统一路由器。** Grep 是默认的文本搜索能力，LSP 是满足开关和连接条件后才出现的语义工具；两者同时可用时，模型根据工具描述、已经掌握的文件位置和当前任务选择调用哪个。RAG 也不是这个版本内置的代码搜索工具，外部 MCP 或插件可以额外提供它，但不能把它和源码里的 Grep、LSP 混成同一条控制流。

模型能"选择"的前提是工具真的在池子里，`hasEmbeddedSearchTools()` 决定是否注册 `GlobTool`/`GrepTool` 专用对象；`LSPTool` 还要过 `ENABLE_LSP_TOOL` 与 `isLspConnected()`。所以"安装了 language server 却看到模型一直在 Grep"时，先查注册条件与连接状态，而不是质疑模型的选择。

选型规则一句话，**不知道名字或搜索的是文本，用 Grep；知道符号位置并要语义关系，用 LSP；只知道"它大概做什么"且项目另有向量索引时，才考虑 RAG。** 三者不是替代关系，稳妥的路径通常是 Grep（或外部 RAG）找入口，LSP 做精确导航，诊断与测试做闭环。

</details>

## 留给下一篇的问题

没有开启 Chrome 调试模式时，Claude Code 还能使用 Chrome MCP 吗？

## 相关链接

- **上一篇**，[29 LSP 如何为 Agent 提供代码智能](./29-lsp-integration.md)
- **下一篇**，[31 应用状态架构](./31-app-state-architecture.md)
- **参考资料**，[Claude Code Chrome Integration](https://code.claude.com/docs/en/chrome)；[Claude Code IDE Integrations](https://code.claude.com/docs/en/ide-integrations)；[Claude Code， Grep vs LSP, and When to Use Each One](https://www.amazingcto.com/grep-or-lsp-in-claude-code/)；[Claude Code Has Been Navigating Your Codebase Like a Tourist With No Map](https://lakshminp.com/2026/03/claude-code-lsp-semantic-context-agents/)；[How AI Searches Through Your Codebase](https://priyanshumahey.github.io/blog/how-ai-indexes-your-codebase)
