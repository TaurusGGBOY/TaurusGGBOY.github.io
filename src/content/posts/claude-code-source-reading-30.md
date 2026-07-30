---
title: "Claude Code源码解读30：浏览器与 IDE 如何接入运行时"
published: 2026-07-24T16:47:17+08:00
updated: 2026-07-24T16:47:17+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-30/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 本章先建立三个概念

- **Host bridge**：外部应用把选区、标签页和编辑动作翻译成 Claude Code 可消费的协议消息。

- **双向 RPC**：宿主既能向 Agent 推送现场，也能接收 Agent 发起的编辑、导航与浏览器操作。

- **能力协商**：握手阶段确认版本、工具和权限模式，让每条连接只暴露可支持的功能。

![IDE 与浏览器的双向 RPC 能力协商](/images/posts/claude-code-source-reading-30/30-external-host-rpc-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇留下的问题是：我们经常看到文章说 Claude Code 使用 Grep 而不是 RAG；那么在同时拥有 Grep 和 LSP 的情况下，Claude Code 什么时候会使用 Grep，什么时候会使用 LSP？

先说结论：**2.1.88 没有实现一个按照问题语义在 Grep、LSP 和 RAG 之间自动切换的统一路由器。**Grep 是默认的文本搜索能力，LSP 是满足开关和连接条件后才出现的语义工具；两者同时可用时，模型根据工具描述、已经掌握的文件位置和当前任务选择调用哪个。RAG 也不是这个版本内置的代码搜索工具，外部 MCP 或插件可以额外提供它，但不能把它和源码里的 Grep、LSP 混成同一条控制流。

## 三种能力先不要混成一个概念

可以把它们看成三个不同的坐标：

| 能力 | 它回答的问题 | 是否需要预先建立代码索引 |
| --- | --- | --- |
| Grep | 哪些文件或行包含这个字符串/正则？ | 不需要；每次对当前文件树即时搜索 |
| LSP | 这个位置上的符号定义在哪里、谁引用它、它是什么类型？ | 需要语言服务器维护语义状态，但不是向量索引 |
| RAG | 哪些代码片段在语义上与这段自然语言最相关？ | 通常需要 embedding、分块和向量索引 |

因此，“Claude Code 使用 Grep 而不是 RAG”讨论的是**词法搜索和预索引检索的工程取舍**；“Claude Code 有了 LSP 以后什么时候不用 Grep”讨论的是**文本搜索和编译器语义查询如何分工**。LSP 既不是 RAG，也不是把整个代码库提前向量化。

## 源码先决定哪些工具能被模型看到

2.1.88 的工具注册顺序已经给出第一层答案。没有可用的嵌入式搜索实现时，工具列表加入专用的 `GlobTool` 和 `GrepTool`；LSP 则必须显式满足环境开关：

```ts
...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool])
...
...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool] : [])
```

前一行的含义不是“没有 Grep”，而是某些 ant-native 构建把 `find`/`grep` 通过 shell alias 接到内嵌搜索程序，因而省掉专用工具对象。通常构建仍会暴露 `GrepTool`，它的 `call()` 最终组装参数并调用 `ripGrep()`，没有先读取向量数据库。

LSP 工具注册后还有第二道门：

```ts
isEnabled() {
  return isLspConnected()
}
```

`isLspConnected()` 要求 Manager 已建立、至少有一个 server，并且至少一个 server 的状态不是 `error`。server 配置来自已启用插件；所以“安装了 LSP 插件”不等于本轮已经有可调用的 `LSP` 工具。在启用 Tool Search 的请求路径中，初始化仍在 `pending` 或尚未开始时，API 层会把 LSP 标记为 deferred，等 Manager 完成初始化后再决定是否提供。

这解释了很多看似矛盾的现象：你明明安装了 language server，模型却继续调用 Grep。可能是 `ENABLE_LSP_TOOL` 没开、插件没有 enabled、文件扩展名没有匹配 server、进程启动失败，或者 server 还没完成握手。此时不是模型“拒绝使用 LSP”，而是 LSP 根本没有通过工具可用性检查。

## Grep 什么时候是正确选择

`GrepTool` 的输入是正则模式 `pattern`，`path` 省略时回退当前工作目录；`glob` 和 `type` 可以缩小文件集合。`output_mode` 的源码可确认取值如下：

| `output_mode` | 返回内容 | 适合的问题 |
| --- | --- | --- |
| `'files_with_matches'`（默认） | 命中文件路径 | 先找可能相关的文件 |
| `'content'` | 命中行，可带上下文和行号 | 阅读字符串出现位置 |
| `'count'` | 每个文件的命中次数 | 统计影响范围 |

`head_limit` 未提供时默认 250；显式传 `0` 才表示不限制；`offset` 默认 0，用来分页。`multiline` 默认 `false`，只有显式开启才允许跨行匹配；`-n` 在 content 模式下默认显示行号。它仍然是对当前文件树的即时匹配，不知道一个名字究竟是定义、调用、注释还是测试桩。

所以这些任务应该先用 Grep：

- 搜索错误信息、日志、注释、TODO、配置键、feature flag 或字符串字面量；
- 用户只给出一个模糊的文本线索，需要先找出可能的目录和文件；
- 代码使用的语言没有已配置的 language server，或目标是 Markdown、YAML、JSON、脚本和生成文件；
- 需要对整个仓库做一次新鲜的宽范围扫描，不能接受索引滞后。

Grep 的代价也很明确：同名变量、注释和字符串会制造噪声，Agent 往往要经历“搜索—Read—再搜索”的循环。它适合建立候选集合，不适合单独证明“所有调用点都已经找到”。

## LSP 什么时候更有价值

`LSPTool` 的输入不是关键词，而是 `filePath`、1-based 的 `line` 和 `character`，再选择一个源码固定的 operation：

```text
goToDefinition       findReferences       hover
documentSymbol        workspaceSymbol      goToImplementation
prepareCallHierarchy  incomingCalls        outgoingCalls
```

这意味着 LSP 最适合“我已经知道一个符号位于哪里，现在要问它的语义关系”：跳到真实定义、找精确引用、查看类型与文档、找接口实现，或分析调用者和被调用者。工具在第一次处理文件时会先让 server `didOpen`；文件超过 10 MB、扩展名没有匹配 server、server 不健康或协议请求失败，都会落入错误/空结果路径。

编辑后的诊断还形成另一条路径。Claude Code 的 LSP Manager 会同步打开、修改和保存的文档，server 通过 `publishDiagnostics` 返回类型或语法问题；这些诊断可以作为 Agent 的辅助证据，但仍应由编译和测试完成最终确认。换句话说，LSP 不只在模型主动调用 `goToDefinition` 时有用，也会在编辑后的反馈阶段参与工作。

## 三者放在一条实际工作流里

一个更接近真实会话的顺序是：

```text
自然语言线索
    │
    ├─ “哪里出现这个错误字符串/配置键？” ──> Grep
    │                                           │
    │                                           └─ 得到文件与位置
    │                                                       │
    ├─ “这个符号定义、引用和调用关系是什么？” ────────> LSP
    │                                                       │
    └─ “修改后哪里坏了？” <── LSP diagnostics ── Edit/Write ─┘
```

如果问题是“实现认证流程的代码在哪里”，外部 RAG/语义索引可能比纯文本更快找到候选；但它返回的是相关片段，不等于真实的定义或调用图。找到候选文件后，仍然应该用 LSP 验证符号关系，再用 Read、编译器和测试确认行为。没有外部 RAG 时，Grep 通过多个文本线索和 Agent 的逐步阅读承担发现阶段。

最后可以把选择规则压缩成一句话：**不知道名字或搜索的是文本，用 Grep；知道符号位置并要语义关系，用 LSP；只知道“它大概做什么”且项目另有向量索引时，才考虑 RAG。**三者不是替代关系，真正稳妥的路径通常是 Grep（或外部 RAG）找入口，LSP 做精确导航，诊断与测试做闭环。

本文继续以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的代码只保留证明主路径所需的部分；省略的 import、日志和平台分支会明确标出，还原路径只用于定位本文引用的源码。

## 外部宿主把现场翻译成协议消息

在看调用链之前，先明确四个概念怎样划分宿主适配层。

**宿主（host）**是用户正在操作的外层环境。终端、IDE 和浏览器都可以是宿主。它们拥有模型本身不知道的现场：IDE 知道当前选区和打开的文件，浏览器知道标签页、DOM、控制台和网络请求。

**传输（transport）**负责搬运字节。`stdio`、SSE、HTTP、WebSocket、Native Messaging 都属于传输；能力含义则由后续协议握手与工具 Schema 确认。

**协议与握手（protocol / handshake）**负责约定消息结构。MCP client 连接后会得到 server version、capabilities 和 instructions；服务端声明的工具或资源决定运行时继续装配哪些能力。

**通知与 RPC**解决两个方向的问题。`selection_changed` 是宿主主动推送的通知，不要求模型先调用工具；`openDiff` 是 Claude Code 发向 IDE 的 RPC，需要等待宿主返回操作结果。一个把现场送进来，一个把动作送出去。

把这四个概念叠起来，整条链路就清楚了：

![IDE、Chrome 与外部 MCP 客户端接入 Claude Code 的适配链路](/images/posts/claude-code-source-reading-30/30-browser-ide-external-tools-handdrawn.png)

图中最值得注意的是三条线在进入 MCP 以前各自做了什么。IDE 要先确认 workspace；Chrome 要先完成扩展配对；普通外部 MCP 则要经过配置来源、认证与企业策略。统一协议把宿主差异封装在适配层里。

## IDE 先通过 lockfile 发现连接

IDE 扩展把连接信息写进 Claude 配置目录下的 lockfile。`restored-src/src/utils/ide.ts` 对新格式的定义如下：

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

`LockfileJsonContent` 描述扩展写入的 JSON。`transport` 只有 `'ws'` 和 `'sse'` 两个源码可确认的值；省略后读取逻辑把 `useWebSocket` 保持为 `false`，也就是走 SSE。`workspaceFolders` 省略时回退为空数组，后续 workspace 匹配将得不到候选；`pid`、`ideName` 和 `authToken` 都允许省略，并分别跳过进程缩小、名称展示与认证头。`runningInWindows` 只有严格等于 `true` 才启用 Windows 路径转换，其余值走本机路径分支。

`readIdeLockfile()` 还兼容旧格式：如果 JSON 解析失败，就把文件按行拆成 workspace 路径；端口则从 `<port>.lock` 的文件名提取。lockfile 同时保存 IDE 存活标记与连接发现信息。

但发现端口还不够。机器上可能同时开着多个 VS Code、Cursor 或 JetBrains 窗口。Claude Code 会把 lockfile 的 workspace 与当前 cwd 比较：当前目录必须等于某个 workspace，或者位于它下面；在内置终端场景还会结合 PID 祖先关系缩小范围。`findAvailableIDE()` 的停止条件也写得很保守：

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

`findAvailableIDE()` 是空参函数，返回 `DetectedIDEInfo | null`。它最多轮询 30 秒，每轮间隔 1 秒；只有找到**恰好一个**有效 IDE 才返回。零个候选、多个候选、超时或被新的搜索通过 `AbortController` 取消，都返回 `null`。实际源码还会在终端滚动排空期间暂停检测，片段为突出停止条件省略了该分支。

为什么多个候选时不随便挑一个？连接还必须匹配正确 workspace。把另一个窗口的选区或 diff 当成本项目事实，比暂时不连接更难发现。

检测结果最后被整理成 URL：`transport === 'ws'` 生成 `ws://<host>:<port>`，否则生成 `http://<host>:<port>/sse`。在 WSL 中，如果扩展运行在 Windows 侧，源码还会转换 workspace 路径并寻找宿主 IP。这说明“本机 IDE”也不一定和 CLI 共享同一个文件系统视角。

## 自动连接只是添加动态 MCP 配置

IDE 检测不会直接把 socket 塞进 Agent。`useIDEIntegration()` 先检查自动连接条件，再向动态 MCP 配置中添加一个名为 `ide` 的条目：

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

这段状态更新的输入 `prev` 是 `Record<string, ScopedMcpServerConfig> | undefined`；`undefined` 表示动态配置尚未建立，展开运算按空对象处理。若 `prev.ide` 已存在，函数原样返回，避免后一次检测覆盖当前连接。`type` 只有 `'ws-ide'` 与 `'sse-ide'` 两个结果，由 URL 是否以 `ws:` 开头决定；`scope` 固定为 `'dynamic'`，表示它来自本次运行时发现。

**字段说明：** 动态配置的 `ide.url` 取检测结果 URL，`ideName`、`authToken`、`ideRunningInWindows` 分别取 `ide.name`、认证令牌与宿主平台标记。

自动连接由多项条件共同控制。全局 `autoConnectIde`、CLI flag、受支持的内置终端、`CLAUDE_CODE_SSE_PORT`、待安装 IDE 类型或 `CLAUDE_CODE_AUTO_CONNECT_IDE` 任一条件可以开启；环境变量被明确设置为 falsy 时会关闭。源码还把 `autoInstallIdeExtension` 的缺省值设为 `true`，可由 `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL` 阻止自动安装。安装、发现和连接分属三个步骤。

## 握手之后，能力才算真正存在

动态配置进入通用 MCP client 后，`sse-ide` 和 `ws-ide` 才分别创建传输。WebSocket 分支会携带 lockfile 中的可选认证令牌：

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

**字段说明：** `wsHeaders` 始终包含 `'User-Agent'`，有 `serverRef.authToken` 时再加入 `'X-Claude-Code-Ide-Authorization'`。`createNodeWsClient()` 的选项中，`headers` 取 `wsHeaders`，`agent` 取当前 URL 对应的 WebSocket proxy agent。

这里的 `serverRef.type` 必须是字面量 `'ws-ide'` 才进入该分支。`serverRef.url` 是开放字符串，但来自前面的 lockfile 解析与 host/port 组装；`authToken` 为 `undefined` 或空字符串时不会添加认证头，非空时才写入 `X-Claude-Code-Ide-Authorization`。

SSE-IDE 分支则创建 `SSEClientTransport`。2.1.88 的源码注释明确写着该分支尚未使用 lockfile 提供的 auth token，因此不能把 WebSocket 的认证结论外推给 SSE。

传输连接后，MCP client 读取 `getServerCapabilities()`、`getServerVersion()` 和 `getInstructions()`。instructions 超过内部上限会被截断；IDE 连接成功还会发送一条 `ide_connected` notification，其中包含当前 Claude Code 进程 PID。握手的意义就在这里：从这一刻开始，双方交换的是带版本和能力边界的协议消息，不再只是“某端口可以打开”。

失败也有明确状态。`MCPServerConnection` 是判别联合：`'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'`。只有 `'connected'` 分支带可调用的 client 和 capabilities。UI 因此可以分别显示配置缺失、正在连接、需要认证和连接失败。

## 选区和文件上下文通过通知更新

连接建立后，IDE 扩展会主动发送 `selection_changed`。`useIdeSelection()` 注册的 Zod schema 给这条消息划定了边界：

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

`SelectionChangedSchema()` 是空参函数，返回一个延迟构造的 schema。`method` 只能是 `'selection_changed'`。`selection` 为对象时更新坐标，为 `null` 时清空当前选区，省略字段时保留“本次通知未携带坐标”的状态；省略 `text` 或 `filePath` 时，对应上下文字段也无法更新。行号和字符位置是开放数字，schema 在此处只校验数值类型。

**字段说明：** `params` 包含可选 `selection`、`text`、`filePath`；`selection.start` 与 `selection.end` 都由数值 `line`、`character` 组成。

处理函数会用 `end.line - start.line + 1` 算行数；如果结束位置的 `character === 0`，再减一行，因为这表示选区恰好停在下一行开头。连接切换时，它还会把 `lineCount` 重置为 0，并把 `lineStart`、`text`、`filePath` 设为 `undefined`，避免旧 IDE 的选区继续污染新连接。

文件提及走另一条通知 `at_mentioned`。它要求 `filePath`，允许 `lineStart`、`lineEnd` 省略，并把 IDE 的 0-based 行号加一后交给 UI。适配层会先校验、归一化原始宿主事件，再生成内部可消费的上下文。

选区最终是否进入某一轮 prompt，还要看 REPL 的输入与附件组装。notification 只提供候选现场；模型读取文件与内容校验仍由后续工具链完成。

## 反向操作通过 RPC，结果必须重新解释

Claude Code 发向 IDE 的调用复用了 MCP tool call：

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

`toolName` 是开放字符串，由调用点提供，例如 `'openDiff'`、`'close_tab'`、`'openFile'` 或 `'getDiagnostics'`，本函数本身不限制全部合法值。`args` 是开放键值对象，字段约束属于对应 IDE tool；`client` 必须已经是 `ConnectedMCPServer`，不能传 pending 或 failed 状态。返回值可能是字符串、MCP content block 数组或 `undefined`，调用方必须继续判别。

**字段说明：** `callMCPTool()` 的对象参数把 `client`、`toolName`、`args` 分别写入 `client`、`tool`、`args`，`signal` 取新建 `AbortController` 的 signal；局部 `result` 的 `content` 是本函数最终返回值。

以 `openDiff` 为例，Claude Code 发送旧路径、新路径、候选新内容和 tab 名称。IDE 返回三类可识别结果：

- `FILE_SAVED` 后跟新文本：用户在 IDE 中保存，运行时采用 IDE 返回的最终内容；
- `TAB_CLOSED`：用户关闭 diff tab，运行时采用原先生成的候选内容；
- `DIFF_REJECTED`：用户拒绝，运行时保留旧内容；
- 其他结构：抛出 `Not accepted`，不能猜测用户意图。

这里体现了外部宿主接入最重要的设计原则：**RPC 完成后还要解释业务结果。** 调用方把 IDE 返回值转换为文件编辑权限流程可以理解的 accept / reject 与新 edits。取消信号和进程退出还会触发清理，尽量关闭残留 tab。

源码也提供了更轻的外部编辑器路径：`openFileInExternalEditor()` 可以依据 `$VISUAL` / `$EDITOR` 启动 VS Code、Vim 等程序，只负责进程拉起和终端切换。MCP 握手、选区通知与结构化结果属于 IDE 运行时集成路径。

## Chrome 复用 MCP，但连接拓扑不同

Claude in Chrome 通过进程内 MCP 适配层连接浏览器。`setupClaudeInChrome()` 先生成动态 MCP 配置和允许的浏览器工具名：

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

`setupClaudeInChrome()` 是空参函数，返回 `mcpConfig`、`allowedTools` 和 `systemPrompt`。配置的 `type` 固定为 `'stdio'`，`scope` 固定为 `'dynamic'`；不同打包形态下 `args` 可能还会包含 `cli.js` 路径，片段展示的是 bundled 分支。`BROWSER_TOOLS` 来自 Chrome MCP 包，属于构建时依赖，静态文章不手工穷举包未来可能改变的全集。只有 session 已处于 bypass permissions 模式时才向子环境写入 `'skip_all_permission_checks'`。

**字段说明：** `env` 是传给 Chrome MCP 的子进程环境，bypass 模式下写入 `CLAUDE_CHROME_PERMISSION_MODE`；`mcpConfig` 以 `CLAUDE_IN_CHROME_MCP_SERVER_NAME` 为 key，`command` 取 `process.execPath`，`args` 指定 Chrome MCP 启动参数。`allowedTools` 保存带 MCP 前缀的浏览器工具名，`systemPrompt` 取 `getChromeSystemPrompt()`。

通用 MCP client 识别到 server 名称是 `claude-in-chrome` 后，会创建 `createLinkedTransportPair()`，让 MCP client 与进程内 Chrome MCP server 直接连接，从而跳过约 325 MB 的独立 subprocess。这个 server 再通过安全 socket、Native Messaging host 或可选 Bridge URL 联系浏览器扩展。

为什么外面还保留 `stdio` 形态？因为配置层只需要声明“这是一个 MCP server”；连接层可以针对已知内置 server 优化部署方式。上层工具注册、call/result 和渲染逻辑仍然复用 MCP，不必知道底下已经改成进程内传输。

Native Messaging manifest 还列出明确的 `allowed_origins`，公开构建只允许生产扩展 ID；内部构建才追加开发与内部扩展 ID。该字段控制哪些浏览器扩展能启动本地 host；网页站点权限由扩展设置管理。

## 配对、权限模式和站点权限是三道不同的门

`createChromeContext()` 会选择 Bridge URL；URL 缺失时使用 native socket。它还恢复持久化的 `pairedDeviceId`，扩展配对后保存 device ID 与名称。认证错误提示要求浏览器扩展与 Claude Code 使用同一个 claude.ai 账号。

权限模式的解析也很谨慎：

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

`env` 是可选的 `Record<string, string>`；传入值优先于进程环境变量，只有前者为 `null` 或 `undefined` 才回退，空字符串不会触发 `if (rawPermissionMode)`。合法候选由项目的 `isPermissionMode()` / `PERMISSION_MODES` 定义验证，本函数不接受任意字符串；非法值只记录警告，`initialPermissionMode` 仍为 `undefined`。公开主路径同步到扩展的执行模式实际压缩成 `'ask'`，只有 Claude Code 的 `bypassPermissions` 映射成 `'skip_all_permission_checks'`。

Chrome 设置界面还会提供站点级权限，浏览、点击和输入均继承浏览器扩展设置。于是一次浏览器动作至少跨过三层：

1. 本地 native host / Bridge 是否与正确扩展配对；
2. Claude Code 与 Chrome MCP 当前采用 ask 还是跳过检查；
3. 扩展是否允许当前站点上的具体能力。

因此，浏览器动作要同时满足会话启用、Claude Code 工具权限与扩展站点权限；任一层拒绝都会停止调用。

`shouldEnableClaudeInChrome()` 在非交互会话中默认返回 `false`，除非显式传入 `--chrome`；CLI 的 `--chrome` / `--no-chrome`、环境变量和全局默认配置按顺序决定是否启用。全局 `claudeInChromeDefaultEnabled` 为 `undefined` 时最终默认关闭。这个默认值解释了为什么浏览器能力不会仅因本机安装了扩展就悄悄进入所有 SDK 或 CI 运行。

## 浏览器消息和工具结果仍要经过结构化边界

Chrome MCP 暴露的浏览器动作最终仍按普通 MCP tools 注册。`callMCPTool()` 发出调用，结果再被 Chrome 专用渲染适配器解释；工具输入中的 tab ID 会被追踪，用于渲染 “View Tab” 链接和过滤扩展广播。

源码还定义了浏览器扩展向 Claude Code 推送 prompt 的 JSON-RPC schema：`method` 固定为 `'notifications/message'`，`prompt` 必须是字符串，`tabId` 可选为数字，图片可选为 base64，`media_type` 只能是 `image/jpeg`、`image/png`、`image/gif`、`image/webp`。处理器只接受已经追踪的 tab ID，避免其他标签页的广播被当成本轮输入。

不过，2.1.88 还原源码中的这条主动 prompt 处理路径带有内部构建门控。更稳妥的结论是：协议和校验结构存在，但具体构建是否启用要服从源码中的门控。

Chrome 断连时，context 提供专门的 `onToolCallDisconnected` 错误文本；IDE 和通用 MCP 也会进入 failed / pending 等连接状态。断连信息必须回到连接管理层，而不能把上一次页面、选区或结果继续当作当前事实。

## 普通外部客户端共享协议，不共享信任

IDE 与 Chrome 的特殊处理容易让人忽略：它们最终仍站在通用 MCP 类型系统上。`restored-src/src/services/mcp/types.ts` 的配置联合包含：

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

`McpServerConfigSchema()` 是空参函数，返回八类配置的联合。`stdio` 的 `type` 可以省略以兼容旧配置，`args` 省略时默认 `[]`；`sse`、`http`、`ws` 要求 URL，并分别支持源码定义的 headers、headers helper 或 OAuth 子字段；`sse-ide` / `ws-ide` 是内部 IDE 类型；`sdk` 只保存 name，并在 print 路径单独处理；`claudeai-proxy` 需要 URL 与 server ID。

除由 `print.ts` 单独接入的 `sdk` 类型外，其余配置会在通用连接管理中建立 MCP client，握手得到 capabilities，再拉取 tools、prompts 或 resources；SDK 路径也复用 MCP client 契约，但不经过普通 `connectToServer()` 的 transport 分支。信任不会因为协议统一而统一：

- 配置 scope 可能是 `local`、`user`、`project`、`dynamic`、`enterprise`、`claudeai` 或 `managed`；
- 企业策略可以在连接前过滤 server；
- HTTP/SSE 可以有 OAuth 与 headers，WebSocket 可以有 headers，stdio 则会启动本地命令；
- MCP tool 被模型选择后，仍要经过工具 Schema、权限和执行生命周期；
- SDK server、IDE direct RPC 与 Chrome 站点权限还有各自的宿主边界。



## 为什么要把 IDE 和浏览器接在协议边缘

现在回头看，这套设计解决了四个工程问题。

第一，**Agent 内核可以复用**。模型看到的仍是消息、通知、tool use 和 tool result，不需要为 VS Code、JetBrains、Chrome 分别实现 query loop。

第二，**宿主能力可以按运行时协商**。某个 IDE 支持 `openDiff`，不代表所有 IDE 都支持；某个 MCP server 声明 resources，也不代表另一个 server 有。capabilities 与实际工具列表比按产品名称猜测更可靠。

第三，**现场同步可以增量进行**。选区变化用 notification 推送，不必每轮轮询整个 IDE；浏览器工具只返回当前操作需要的内容，不必把整个页面常驻在主进程。

第四，**失败边界可被看见**。连接失败、认证失败、工具失败、宿主拒绝是不同状态。只有分开记录，运行时才知道应该重连、重新认证、提示用户，还是保留旧文件。

代价也很明确：系统多了一层异步状态。通知可能晚到，选区可能在发送 prompt 前已经改变，IDE diff 可能被用户关闭，浏览器扩展可能在 tool call 中途断开。源码通过 client identity 检查、schema 校验、AbortSignal、连接判别联合和结果枚举减少误判，但无法把分布式时序变成强一致事务。

## 小结

Claude Code 接入外部宿主的主线，可以压缩成五步：

1. IDE 通过 lockfile 被发现，Chrome 通过 Native Messaging / Bridge 配对，普通 MCP 通过配置进入候选集合；
2. 适配层把它们转换成 `sse-ide`、`ws-ide`、stdio、HTTP、WebSocket 等 MCP transport；
3. MCP 握手确认 server version、instructions 和 capabilities，连接状态进入 connected / failed / pending 等判别分支；
4. IDE 选区与提及通过 notification 进入候选上下文，IDE diff 和浏览器操作通过 tool call / RPC 返回结构化结果；
5. workspace 校验、认证或配对、Claude Code 权限模式、扩展站点权限与企业策略共同守住边界。

这套实现把宿主差异隔离在协议边缘，让执行内核继续处理同一种消息与工具生命周期。连接成功只表示通道可用；外部事件仍要经过校验、归一化、权限和状态更新，才能成为本轮执行的一部分。

## 留给下一篇的问题

这些外部事件进入主进程以后，Claude Code 的 AppState 如何组织会话、工具、任务、权限和 UI 共享状态，并保证更新可追踪？

## 参考资料

- [Claude Code Chrome Integration](https://code.claude.com/docs/en/chrome)

- [Claude Code IDE Integrations](https://code.claude.com/docs/en/ide-integrations)

- [Claude Code: Grep vs LSP, and When to Use Each One](https://www.amazingcto.com/grep-or-lsp-in-claude-code/)

- [Claude Code Has Been Navigating Your Codebase Like a Tourist With No Map](https://lakshminp.com/2026/03/claude-code-lsp-semantic-context-agents/)

- [How AI Searches Through Your Codebase](https://priyanshumahey.github.io/blog/how-ai-indexes-your-codebase)
