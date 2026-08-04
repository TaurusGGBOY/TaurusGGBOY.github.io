---
title: "Claude Code源码解读29：LSP 如何为 Agent 提供代码智能"
published: 2026-07-24T16:47:16+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-29/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇最后留下的问题是：为什么在这个版本的代码里，自己编写的 Skill 如果需要作为 Slash 命令使用，就必须把它当作 Plugin 安装？

先说结论：**2.1.88 并没有把“Skill 能否用 `/` 调用”硬编码成 Plugin 专属能力。**没有组织策略时，项目里的 `.claude/skills/<name>/SKILL.md`、用户目录下的 `skills/<name>/SKILL.md`，以及兼容的 `.claude/commands/<name>.md` 都可以生成可调用的 prompt command。你看到“必须安装 Plugin”，通常是因为管理员打开了 `strictPluginOnlyCustomization`，而不是因为 Slash 命令解析器要求 Plugin。

### 源码里其实有两条加载路径

`getSkills(cwd)` 并行获取 `getSkillDirCommands(cwd)` 和 `getPluginSkills()`。前者扫描 managed、user、project 与 `--add-dir` 下的 skills（还会处理 legacy `commands` 目录），后者只处理已启用的 Plugin。`loadAllCommands()` 再把它们分别合并进同一个 `Command[]`：

```text
skillDirCommands   ← ~/.claude/skills、.claude/skills、.claude/commands
pluginCommands     ← enabled plugin 的 commands/
pluginSkills       ← enabled plugin 的 skills/<name>/SKILL.md
                         ↓
                    loadAllCommands()
                         ↓
                    Slash command registry
```

本地 Skill 由 `createSkillCommand()` 生成 `type: 'prompt'` 的命令，命令名就是 Skill 名；`user-invocable` 没有写时默认为 `true`。因此单纯想得到 `/review` 这样的入口，并不需要先写 Plugin manifest。

### 真正改变结果的是 plugin-only policy

源码把可锁定的定制面定义为四个值：`'skills' | 'agents' | 'hooks' | 'mcp'`。没有 `'commands'` 这个独立的策略值，因为旧式 `.claude/commands` 在这里已经按“commands-as-skills”走 Skill 加载器。

判断函数只有一个来源：managed 的 `policySettings`：

```ts
export function isRestrictedToPluginOnly(
  surface: CustomizationSurface,
): boolean {
  const policy =
    getSettingsForSource('policySettings')?.strictPluginOnlyCustomization
  if (policy === true) return true
  if (Array.isArray(policy)) return policy.includes(surface)
  return false
}
```

这个字段有四种静态情况：省略或 `undefined` 表示不锁定；`false` 是显式不锁定；`true` 锁定四个 surface；数组只锁定数组中列出的值，例如 `['skills']`。它来自管理员的 managed settings，不是普通项目 `.claude/settings.json` 自己就能打开或关闭的开关。

`getSkillDirCommands()` 读取 `isRestrictedToPluginOnly('skills')` 后，把它变成 `skillsLocked`。锁定时会发生三件事：

1. user、project 和 `--add-dir` 的 Skill 不再加载；
2. legacy `.claude/commands` 也直接跳过，因为它被当成 Skill 处理；
3. 文件操作期间的动态 Skill 发现 `addSkillDirectories()` 提前返回。

managed/policySettings 来源仍可加载，Plugin 来源也仍可加载。`getPluginSkills()` 和 `getPluginCommands()` 只从 `loadAllPluginsCacheOnly()` 返回的 `enabled` 插件构建命令，并在 `createPluginCommand()` 中标记 `source: 'plugin'`、保存 `pluginInfo`，同时给 Skill/command 加上 Plugin 命名空间。于是，在这条策略下，Plugin 成了绕过 user/project 文件系统入口的**受信任装配通道**。

### 为什么管理员要这样设计

Skill 不只是静态说明文字。`createSkillCommand().getPromptForCommand()` 会执行 Skill 内容里的动态 shell 片段，并把 frontmatter 的 `allowed-tools` 合并到当前工具权限上下文；Skill 还可以携带 `context: fork`、路径触发和 Hook 等行为。若任意项目文件都能在每次会话里注册可执行的 `/command`，组织就很难统一审计它的来源和权限。

因此 policy 的思路是：把 user/project/local 定制视为用户可写输入，把 managed 与 Plugin 视为管理员已审核的输入。Plugin 仍要经过 marketplace 来源、信任和 manifest 校验；“Plugin 通过”不等于“任意目录都自动安全”，只是它拥有独立的来源证明、版本和启用边界。

| 场景 | 是否必须 Plugin | 2.1.88 中的原因 |
| --- | --- | --- |
| 个人或项目里写一个普通 `SKILL.md`，手动 `/name` 调用 | 否（策略未锁定时） | `getSkillDirCommands()` 直接把本地 Skill 转成 prompt command。 |
| 继续使用 `.claude/commands/name.md` | 否（策略未锁定时） | 兼容路径由 `loadSkillsFromCommandsDir()` 作为 legacy Skill 加载。 |
| 组织 managed settings 锁定 `skills` | 是，或使用 managed Skill | user/project/legacy commands 被同一个 `skillsLocked` 分支跳过。 |
| 需要 Plugin 自带的 Hook、MCP、Agent、LSP、`CLAUDE_PLUGIN_ROOT` 等组件 | 是 | 这些能力由 Plugin loader 和对应运行时装配，普通 Skill 目录没有 Plugin 身份与根路径。 |
| 只想在当前会话测试一个 Plugin | 不必 marketplace 安装 | `--plugin-dir` 提供 inline Plugin，加载器会把它作为 Plugin 来源处理。 |

所以排查时先看三点：是否存在 managed 的 `strictPluginOnlyCustomization`；Skill 是否位于源码实际扫描的目录并包含 `SKILL.md`；frontmatter 是否把 `user-invocable` 设成了 `false`。如果第一项没有锁定，单纯因为“它需要 Slash 命令”而去安装 Plugin，反而是在绕过真正的问题。

最准确的记忆方式是：**Slash 是调用界面，Skill 是 prompt command，Plugin 是来源与装配边界。**只有组织策略把 `skills` 锁成 Plugin-only，或者 Skill 依赖 Plugin 才能提供的其他组件时，Plugin 才是必要条件；Slash 本身不是。

下文事实均来自 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/`；代码块只保留 LSP 路由和状态变化所需的字段。

## 关键结论（Key Takeaways）

- LSP 配置只来自**已启用插件**：`getAllLspServers()` 只遍历 `enabled` 插件，server 名统一改为 `plugin:<pluginName>:<name>`。
- 生命周期是 **route → spawn → initialize → initialized → didOpen/didChange → request/notification**：Manager 只建扩展名路由，server 在第一次访问匹配文件时才 lazy start。
- 主动查询与被动诊断走两条通道：九个 operation（goToDefinition、findReferences 等）的结果作为 `tool_result` 回流；`publishDiagnostics` 经 Registry 去重限量后，作为主线程 attachment 注入。
- 文档同步存在静态边界：`didOpen.version` 与 `didChange.version` 固定为 1，客户端声明 `versionSupport: false`，诊断没有强版本证明。
- LSP 是可降级的语义证据层：server 缺失、spawn/initialize 失败或诊断滞后时，主循环与文件工具照常工作；最终正确性仍由编译与测试闭环确认。

## 本篇新增

- 从插件配置到诊断回流的完整生命周期：配置收集 → 扩展名路由 → JSON-RPC 握手 → 文档同步 → 主动/被动两条消息通道。
- 主动路径九个 operation 的协议映射：行列 1-based 转 0-based、references 固定 `includeDeclaration: true`、call hierarchy 二次请求、`-32801` ContentModified 最多重试 3 次。
- 被动路径的注册表机制：UUID 防覆盖、跨 turn 去重、每文件 10 条/每次 30 条上限、500 文件 LRU、Edit/Write 后清空已交付集合。
- 文档同步的静态边界与未完成项：`closeFile()` 未接入 compact flow，Edit/Write 的 `changeFile()/saveFile()` 是 fire-and-forget。

## 问题：什么时候从文本搜索升级为语言服务

字符串搜索能告诉 Agent "这个词出现在哪里"，却不能回答"这个符号最终解析到哪一个定义"。LSP 把这类语义问题交给语言服务器，但它也引入进程启动、文档同步和诊断过期等新状态。

在这张金额单位工单里，工程师在 Grep 里搜到十几个 `amount`：有订单金额、优惠金额、网关请求字段，也有一个只用于前端展示的同名变量。仅凭字符串位置，他无法确定哪个值最终被转换成了 9991，验证要求因此写得很具体：

> 完成后使用 LSP、Chrome 和相关测试验证：确认金额转换函数的定义、所有引用和 diagnostics，再核对页面与网络请求。

> 只凭 Grep 的文本命中，如何确定一个符号的定义、引用与类型？LSP 的 server 配置、进程与文档状态又如何进入 Agent 的消息循环？

本篇沿 LSP 的三个边界回答：插件配置决定 server 路由，Manager 按需完成 JSON-RPC 握手，主动查询和被动诊断分别通过 `tool_result` 与 attachment 两条通道回到 Agent。

## 正文

本文事实均来自 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/`；代码块只保留 LSP 路由和状态变化所需的字段。

### 边界：文本匹配与语言语义的分工

实际调用顺序是 `manager route → spawn → initialize → initialized → didOpen/didChange → request/notification`。LSP server 没有启动或文档同步尚未完成时，Agent 得到的只是连接失败或过期诊断，不是可靠的语义答案。

![Claude Code LSP 生命周期、主动查询与被动诊断路径](/images/posts/claude-code-source-reading-29/29-lsp-integration-handdrawn.png)

LSP 把文件、行号和字符位置映射到语言语义；JSON-RPC 中 request 带 ID 等待 response，notification 则只推进状态。`didOpen`/`didChange` 更新 server 的文档视图，`textDocument/definition` 等 request 查询语义，`publishDiagnostics` 异步推送结果。因而诊断与当前文件内容之间存在时序窗口，不能当成编译器最终结果。Claude Code 需要这套机制，是因为 Grep 可以找到同名字符串，却不知道它是局部变量、重载方法还是接口实现；LSP 能利用语言自己的索引和类型系统回答语义问题。反过来，LSP 也不能替代 Read、编译器和测试：服务器可能没安装、能力不完整、索引未完成，诊断还可能滞后。

![LSP 文档同步与主动被动证据路径](/images/posts/claude-code-source-reading-29/29-lsp-sync-detail-handdrawn.png)

工单里 Claude Code 的用法正是这条链路：先用 Grep 找到金额字段，再调用 LSP 跳到定义、查引用和读取 diagnostics。LSP 配置只有在 Plugin 已启用后才进入 Manager；第一次使用还要启动 server、完成握手、同步文档，结果最后仍作为 `tool_result` 回到工单调查。若文档尚未同步，诊断就可能对应旧内容，不能把它当成最终测试结论。

### 第一层：LSP 配置只来自已启用插件

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

> 证据：`restored-src/src/services/lsp/config.ts`（2.1.88 source map 还原源码），`getAllLspServers()` —— LSP 配置的唯一入口。

`getAllLspServers()` 是空参函数，返回按 scoped server name 索引的配置对象。它只遍历 `enabled` 插件；`getPluginLspServers()` 返回 `undefined` 时，该插件在合并阶段贡献零个 server。多个插件并行读取，但最后按原插件顺序合并；发生同名覆盖时，靠后的对象赋值生效。server 名被改成 `plugin:<pluginName>:<name>`，正常情况下插件之间通过前缀隔离。插件可以用根目录 `.lsp.json`，也可以在 manifest 的 `lspServers` 中写相对 JSON 路径、内联对象，或者二者组成的数组；外部路径会经过"仍位于插件目录内"的校验，`..` 穿越和绝对路径不会被接受。

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

> 证据：`restored-src/src/utils/plugins/schemas.ts`（2.1.88 source map 还原源码），LSP server 配置 Schema。

这个 Schema 是严格对象，未知字段会校验失败。`command` 必填且非空；普通命令中带空格会被拒绝，参数应该放进可选 `args`。`extensionToLanguage` 至少要有一个"扩展名 → language ID"映射。`transport` 的静态可选值是 `'stdio' | 'socket'`，默认 `'stdio'`；当前 `LSPClient.start()` 固定执行 `spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })`，因此 `transport` 尚未参与启动控制流。实例构造器遇到非 `undefined` 的 `restartOnCrash` 会明确报"尚未实现"。

还有一个安全顺序：交互模式下，`main.tsx` 在 workspace trust 已确认后才调用 `initializeLspServerManager()`；同一处源码注释把非交互模式的 trust 视为隐式成立。因为插件的 `command` 最终会启动本地进程，所以交互路径会在未信任目录里阻止提前执行。

### 第二层：Manager 先建路由，server 第一次使用时才启动

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

> 证据：`restored-src/src/services/lsp/`（2.1.88 source map 还原源码），`initializeLspServerManager()` —— LSP Manager 的全局装配入口。

`initializeLspServerManager()` 是空参同步入口，内部异步装配不会阻塞调用方继续启动。bare/simple 路径直接跳过 LSP。初始化状态只有 `'not-started' | 'pending' | 'success' | 'failed'`；已有实例且状态正常时保持幂等，failed 状态再次调用则允许重试。`initializationGeneration` 用来阻止旧 Promise 在 reload 或 shutdown 后覆盖新状态。这里注册诊断 handler 的时机也值得注意：Manager 完成配置装配后就注册，而 server 进程此时通常尚未启动——`LSPClient.onNotification()` 会把 handler 暂存，等连接建立后再挂到 JSON-RPC connection。因此，被动诊断允许 server 延迟到首次访问时启动。

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

> 证据：`restored-src/src/services/lsp/`（2.1.88 source map 还原源码），`LSPServerManager.initialize()` 的扩展名路由装配。

`serverName` 是加过插件 scope 的开放字符串；`config` 是对应 server 配置。扩展名统一转小写，一个扩展名可以对应多个 server，但 `getServerForFile()` 当前固定取 `serverNames[0]`，按注册顺序选择。单个配置无效只跳过该 server，其他语言能力继续装配。更关键的是，`createLSPServerInstance()` 只创建带状态的包装器。真正访问某个文件时，`ensureServerStarted(filePath)` 才根据扩展名找到 server，并在状态为 `'stopped'` 或 `'error'` 时执行 `start()`。这就是 lazy start：访问 `.rs` 文件时才需要启动 rust-analyzer。

### 第三层：spawn、initialize、initialized 组成真正的协议握手

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

> 证据：`restored-src/src/services/lsp/LSPServerInstance.ts`（2.1.88 source map 还原源码），`start()` 的进程与握手主路径。

`config.command` 是可执行程序；`args` 为 `undefined` 时回退为空数组。`env` 可省略，并在 Client 内与 Claude Code 的子进程环境合并；`workspaceFolder` 可省略，默认当前 cwd。`initializationOptions` 可以是任意值，`undefined` 时明确回退 `{}`。`startupTimeout` 必须是正整数毫秒；省略时 initialize 的等待行为由连接和 server 决定。`initParams.processId` 取当前进程 ID，`workspaceFolders` 是单元素数组，`rootPath`/`rootUri` 取同一 workspace，`capabilities` 保存客户端能力声明。

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

> 证据：`restored-src/src/services/lsp/`（2.1.88 source map 还原源码），`LSPClient.initialize()` —— 握手完成点。

`initialize(params)` 的参数是完整 `InitializeParams`，类型排除 `null`；connection 未建立就直接报错。服务端 capabilities 允许为不同能力提供布尔值或 option 对象，源码在这里保存它。`LSPTool` 仍会发起所选请求，服务器不支持某个方法时，请求错误沿工具错误路径返回。客户端声明的能力也比较克制：workspace configuration 和 workspace folder change 都是 `false`；文档同步声明 `didSave: true`，但 `willSave / willSaveWaitUntil` 为 `false`；诊断支持 related information 和 tag 1/2，却明确 `versionSupport: false`；position encoding 只声明 UTF-16。服务器与客户端因此按 UTF-16 position 对齐。

### 第四层：文档同步从 didOpen 开始，但版本并不完整

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

> 证据：`restored-src/src/services/lsp/`（2.1.88 source map 还原源码），`LSPTool.call()` 的 didOpen 同步路径。

`absolutePath` 来自 `expandPath(input.filePath)`。文件大于 `10_000_000` 字节时不打开，也不发送请求；等于上限仍允许。读取编码固定 UTF-8。`manager.isFileOpen()` 只按规范化 file URI 查询内部 Map，不验证服务器是否已经遗忘该文档。`openFile(filePath, content)` 会按扩展名取 `languageId`，找不到映射时回退 `'plaintext'`；`didOpen.textDocument.version` 固定为 1。文件已在同一个 server 打开时重复调用会直接跳过。

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

> 证据：`restored-src/src/services/lsp/`（2.1.88 source map 还原源码），Edit/Write 完成后的 `changeFile()`/`saveFile()` 同步。

`changeFile(filePath, content)` 在 server 尚未 running、或文件尚未 open 时回退到 `openFile()`；否则发送全文 `contentChanges: [{ text: content }]`。`saveFile(filePath)` 发送 `didSave`，但 server 不存在或不在 running 时直接返回。这两个调用都不接受 `null`，文件内容是完整字符串。

这里有一个必须说明的静态边界：Edit/Write 对 `changeFile()` 与 `saveFile()` 分别采用 fire-and-forget 并各自 catch。`didChange` 的 version 固定为 1，文档版本不会递增。`closeFile()` 虽然已经实现 `didClose`，源码注释却明确说尚未接入 compact flow。不能把"有函数"写成"上下文压缩时必然关闭文档"。

### 主动路径：九种操作最终都变成 tool_result

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

> 证据：`restored-src/src/services/lsp/`（2.1.88 source map 还原源码），`LSPTool` 输入 Schema。

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

> 证据：`restored-src/src/services/lsp/`（2.1.88 source map 还原源码），`getMethodAndParams()` 的 operation → JSON-RPC 映射。

`getMethodAndParams(input, absolutePath)` 的 `input` 是已校验工具输入，`absolutePath` 是展开后的路径；返回 method 开放字符串与 method-specific `params: unknown`。references 固定 `includeDeclaration: true`。`workspaceSymbol` 固定空 query，表示请求全部 workspace symbols；incoming/outgoing calls 先请求 `prepareCallHierarchy`，只取返回数组第一项，再发第二次调用方向请求。位置型结果还会过滤 gitignored 文件。definition、implementation 兼容 `Location` 与 `LocationLink`；空值由 formatter 变成"零结果"，非法 URI 会记录错误。

最后，输出经过：

```ts
mapToolResultToToolResultBlockParam(output, toolUseID) {
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: output.result,
  }
}
```

> 证据：`restored-src/src/services/lsp/`（2.1.88 source map 还原源码），`mapToolResultToToolResultBlockParam()` —— 主动查询结果回流。

`output` 是格式化后的 LSP 工具输出；`toolUseID` 是本次模型 tool_use 的开放字符串，用于把结果配回原调用。`type` 固定 `'tool_result'`，`content` 只放格式化字符串。`resultCount`、`fileCount` 会留在工具结构化输出中，但这段 API block 不会把它们单独展开。若扩展名缺少 server，Manager 返回 `undefined`，工具返回"No LSP server available"；spawn、initialize 或 request 抛错时，工具也把错误文案放进结果，把故障限制在当前工具调用。唯一被自动重试的协议错误是 code `-32801`（ContentModified）：最多额外重试 3 次，延迟依次为 500、1000、2000ms；其他错误立即结束这条请求。

### 被动路径：publishDiagnostics 要等 attachment 收集

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

> 证据：`restored-src/src/services/lsp/`（2.1.88 source map 还原源码），`registerPendingLSPDiagnostic()` —— 诊断注册表入口。

`serverName` 是来源 server 名，`files` 是已经标准化的诊断文件数组；二者都必填。UUID 只用于避免快速通知互相覆盖。`timestamp` 记录接收时间，后续 attachment 内容只展示诊断内容；`attachmentSent` 初始固定 `false`。`checkForLSPDiagnostics()` 会跨通知、跨 turn 去重，然后按 Error、Warning、Info、Hint 排序。每个文件最多保留 10 条，一次最多保留 30 条；跨 turn 的已交付 key 放在最多 500 个文件的 LRU 中。Edit/Write 修改文件时清掉该文件的已交付集合，使相同错误在新版本上可以再次出现。

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

> 证据：`restored-src/src/services/lsp/`（2.1.88 source map 还原源码），`getLSPDiagnosticAttachments()` —— 诊断转 attachment。

`toolUseContext` 必填，函数从其中读取本轮工具集合；Bash 缺席时直接返回空数组。它本身还只位于 `getAttachments()` 的 main-thread attachment 列表，因此 subagent 线程跳过这条自动注入路径。返回的 attachment `type` 固定 `'diagnostics'`，`isNew` 固定 `true`。这解释了"诊断如何进入 Agent"：后续 attachment 收集点会把语言服务器通知包装成内部诊断上下文，system prompt 与普通 user message 保持原样。

### 失败边界：LSP 提供可降级的辅助证据

第一，**server 来源是已启用插件**。Manager 可以成功初始化为 0 个 server；Read、Edit、Bash 与主 Agent 循环仍可继续。

第二，**进程可用性要经过 spawn 与 initialize。** 命令可能缺失，spawn 可能失败，initialize 可能超时，server 也可能崩溃。`maxRestarts` 为 `undefined` 时回退 3；超过 crash recovery 上限后停止拉起子进程。关闭时即使 `shutdown / exit` 失败，也会继续 dispose connection 和 kill process。

第三，**能力声明与请求结果分层。** Client 保存服务端 capabilities；LSPTool 仍会发起所选 operation。某个 server 只支持 definition、缺少 call hierarchy 时，后者会走协议错误路径。

第四，**诊断缺少强版本证明。** 客户端声明 `versionSupport: false`，`didChange.version` 又固定为 1；Registry 以内容和位置去重，不按文档版本仲裁。诊断适合提醒 Agent"这里可能有新错误"；编译结果仍需由实际构建或测试确认。

因此，LSP 最合理的位置是语义反馈层：比字符串搜索更懂语言，比真实 build/test 更轻、更快，但最终修改仍要回到文件工具、权限链、编译与测试验证。

## 源码映射表

| 层 | 关键文件（`restored-src/src/`） | 关键函数 / 符号 | 证据 | 要点 |
|---|---|---|---|---|
| 配置 | `services/lsp/config.ts` | `getAllLspServers()`、`getPluginLspServers()` | 源码已确认 | 只收集 enabled 插件，server 名加插件前缀 |
| 配置 | `utils/plugins/schemas.ts` | LSP server 配置 Schema | 源码已确认 | 严格对象；`transport` 枚举暂未参与启动 |
| 装配 | `services/lsp/` | `initializeLspServerManager()`、`LSPServerManager.initialize()` | 函数按还原源码引用 | 状态机 `not-started/pending/success/failed` + generation 防旧 Promise 覆盖 |
| 路由 | `services/lsp/` | `createLSPServerInstance()`、`ensureServerStarted()` | 函数按还原源码引用 | 扩展名小写映射，`getServerForFile()` 取首个；lazy start |
| 握手 | `services/lsp/LSPServerInstance.ts` | `start()`、`LSPClient.initialize()` | 源码已确认 | spawn 管道 + initialize/initialized；capabilities 保存 |
| 同步 | `services/lsp/` | `openFile()`、`changeFile()`、`saveFile()`、`closeFile()` | 函数按还原源码引用 | version 固定 1；`closeFile()` 未接入 compact flow |
| 主动路径 | `services/lsp/` | `LSPTool.call()`、`getMethodAndParams()`、`mapToolResultToToolResultBlockParam()` | 函数按还原源码引用 | 九种 operation；`-32801` 重试 3 次 |
| 被动路径 | `services/lsp/` | `registerLSPNotificationHandlers()`、`registerPendingLSPDiagnostic()`、`checkForLSPDiagnostics()`、`getLSPDiagnosticAttachments()` | 函数按还原源码引用 | UUID 注册、限量去重、main-thread attachment |

> 证据说明：表中标"源码已确认"的路径直接出现在还原源码注释或本系列已核对文件中；其余函数按还原源码中的符号引用，具体实现路径以各节证据行为准。沿用系列约定，路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。

## 设计决策：为什么诊断不强求版本一致

源码没有官方选型文档，下面的判断来自代码结构本身，属于解释。

**第一，配置与进程分离。** 插件只声明配置，Manager 只建路由，进程与协议握手延后到第一次访问文件：`initializeLspServerManager()` 是同步入口、异步装配，不阻塞 CLI 启动，把一次性启动成本变成按需成本。

**第二，主动与被动分通道。** 主动查询走工具调用，是请求/响应对；被动诊断走注册表 + attachment，跨 turn 去重、限量注入。两者的消费者不同：`tool_result` 回到模型推理链，attachment 由主线程装配进下一轮上下文。如果都走工具通道，诊断通知会被误当成模型请求的结果，时序语义就乱了。

**第三，诊断不强求版本一致。** 客户端声明 `versionSupport: false`、`didChange.version` 固定 1，等于主动放弃"按文档版本仲裁诊断"的复杂度。代价是诊断可能与文件内容有时序窗口；收益是同步路径极简（全文替换 + fire-and-forget），双方都不需要版本簿记。这符合 LSP 的定位——提醒层，不是结论层。

**第四，故障局部化。** 单个 server 配置无效只跳过该 server；spawn/initialize 失败只影响对应扩展名的查询；"No LSP server available" 与协议错误都作为普通工具结果返回。主循环、文件工具和 Bash 不依赖 LSP 的可用性，这是"可降级证据"的前提。

**第五，信任边界沿用插件体系。** 配置只来自已启用插件、路径校验不允许逃出插件目录、交互模式在 workspace trust 之后才初始化——延续第 28 章的思路：能启动本地进程的声明，必须是管理员可审计的来源。

## 练习：走一遍 goToDefinition 的完整链路

不打开源码，把一次 `goToDefinition` 沿状态变化走一遍：

1. 插件已启用，`initializeLspServerManager()` 完成，状态 `success`，但 server 进程尚未启动（`initializationState` 与 server 状态是两回事）。
2. 模型给出 `filePath`、`line: 42`、`character: 17`，`operation: 'goToDefinition'`。
3. 工具展开路径，发现 `manager.isFileOpen()` 为假：读文件、校验 10 MB 上限、`openFile()` 发 `didOpen`（version 1，languageId 来自扩展名映射）。
4. `ensureServerStarted()` 触发 lazy start：spawn 管道 → `initialize` request → 保存 capabilities → `initialized` notification → `isInitialized = true`。
5. `getMethodAndParams()` 把行列减 1，映射成 `textDocument/definition`，`position: { line: 41, character: 16 }`。
6. server 返回 `Location` 数组，formatter 过滤 gitignored 文件，输出经 `mapToolResultToToolResultBlockParam()` 成为带同一 `tool_use_id` 的 `tool_result`。

再对照三个失败场景：扩展名没有匹配 server（第 3 步直接返回"No LSP server available"）；server 不支持 definition（第 6 步沿工具错误路径返回）；文档修改后诊断未更新（被动路径，与这条主动链路无关）。

**追踪练习**：跟着一条 `publishDiagnostics` 走一遍注册表——notification 到达 → severity 映射 → `registerPendingLSPDiagnostic()` 写入 UUID key → `checkForLSPDiagnostics()` 去重限量 → 主线程 `getLSPDiagnosticAttachments()` 转成 `type: 'diagnostics'` attachment。然后回答：为什么 Bash 缺席时这条路径直接返回空数组？为什么 subagent 线程不会自动注入诊断？

**识别小练习**：判断三个说法是否正确。

1. "安装了 LSP 插件后，模型这一轮就一定能调用 LSP 工具。" → 错误。工具注册要求 Manager 已装配非 error server；`isEnabled()` 还可能因 `ENABLE_LSP_TOOL` 或连接状态失败。
2. "`didChange` 的 version 固定为 1，所以诊断永远对应最新内容。" → 错误。版本不递增意味着没有强版本证明，诊断与内容之间存在时序窗口。
3. "`closeFile()` 已实现，上下文压缩时会关闭 LSP 文档。" → 错误。源码注释明确说尚未接入 compact flow，"有函数"不等于"已接入"。

## 自测

不看上文，先凭记忆回答，再展开参考答案核对。

1. LSP server 进程在什么时候真正启动？
2. 主动查询与被动诊断分别通过什么通道回到 Agent？
3. `line: 1, character: 1` 在发给 server 的 position 里是多少？为什么？
4. Edit 文件后 `changeFile()` 与 `saveFile()` 的调用方式有什么值得注意的边界？
5. 为什么安装 LSP 插件后模型仍可能继续调用 Grep？

<details>
<summary>参考答案</summary>

1. **第一次访问匹配扩展名的文件时**。`ensureServerStarted(filePath)` 找到 server 且状态为 `stopped`/`error` 时才 `start()`；初始化阶段只建路由，不会同步等待任何 server 进程。

2. **主动查询走 `tool_result`**：九种 operation 的结果经 formatter 和 `mapToolResultToToolResultBlockParam()` 变成带 `tool_use_id` 的 tool result 回到消息历史。**被动诊断走 attachment**：`publishDiagnostics` → severity 映射 → 注册表去重限量 → 主线程 `getLSPDiagnosticAttachments()` 注入 `type: 'diagnostics'` 附件；subagent 线程没有这条自动注入路径。

3. **`{ line: 0, character: 0 }`**。工具级 Schema 从 1 开始计数，协议映射时 `line - 1`、`character - 1`；客户端还只声明 UTF-16 position encoding，与服务器按 UTF-16 对齐。

4. **fire-and-forget + 各自 catch**：`changeFile()` 与 `saveFile()` 分别在 `.catch()` 中记录错误，不阻塞编辑流程；`didChange` 发送全文 `contentChanges: [{ text: content }]`，version 固定 1 不递增；server 未 running 或文件未 open 时 `changeFile()` 回退到 `openFile()`，`saveFile()` 直接返回。另一个边界是 `closeFile()` 尚未接入 compact flow。

5. 工具可用性检查未通过：`ENABLE_LSP_TOOL` 未开启、插件未 enabled（配置只来自已启用插件）、文件扩展名没有匹配 server、spawn/initialize 失败、或 server 还没完成握手。此时不是模型"拒绝使用 LSP"，而是 LSP 没有通过工具可用性检查——扩展是条件性装配。

</details>

## 回顾：Skill 需要 Plugin 才能做 Slash 命令吗

回到上一篇留给本篇的问题，用 LSP 的配置来源收束答案。

<details>
<summary>展开查看回顾</summary>

**2.1.88 并没有把"Skill 能否用 `/` 调用"硬编码成 Plugin 专属能力。** 没有组织策略时，项目里的 `.claude/skills/<name>/SKILL.md`、用户目录下的 `skills/<name>/SKILL.md`，以及兼容的 `.claude/commands/<name>.md` 都可以生成可调用的 prompt command。`getSkills(cwd)` 并行获取 `getSkillDirCommands(cwd)` 和 `getPluginSkills()`，`loadAllCommands()` 再把它们合并进同一个 `Command[]`；本地 Skill 由 `createSkillCommand()` 生成 `type: 'prompt'` 命令，`user-invocable` 未写时默认为 `true`。

真正改变结果的是 `strictPluginOnlyCustomization`，它来自 managed 的 `policySettings`：

```ts
export function isRestrictedToPluginOnly(
  surface: CustomizationSurface,
): boolean {
  const policy =
    getSettingsForSource('policySettings')?.strictPluginOnlyCustomization
  if (policy === true) return true
  if (Array.isArray(policy)) return policy.includes(surface)
  return false
}
```

可锁定的 surface 只有四个值：`'skills' | 'agents' | 'hooks' | 'mcp'`，没有独立的 `'commands'`——旧式 `.claude/commands` 已按"commands-as-skills"走 Skill 加载器。锁定时发生三件事：user/project/`--add-dir` 的 Skill 不再加载；legacy `.claude/commands` 直接跳过；动态 Skill 发现 `addSkillDirectories()` 提前返回。managed 与 Plugin 来源仍可加载。

| 场景 | 是否必须 Plugin | 原因 |
| --- | --- | --- |
| 个人或项目里写一个普通 `SKILL.md`，手动 `/name` 调用 | 否（策略未锁定时） | `getSkillDirCommands()` 直接把本地 Skill 转成 prompt command。 |
| 继续使用 `.claude/commands/name.md` | 否（策略未锁定时） | 兼容路径由 `loadSkillsFromCommandsDir()` 作为 legacy Skill 加载。 |
| 组织 managed settings 锁定 `skills` | 是，或使用 managed Skill | user/project/legacy commands 被同一个 `skillsLocked` 分支跳过。 |
| 需要 Plugin 自带的 Hook、MCP、Agent、LSP、`CLAUDE_PLUGIN_ROOT` 等组件 | 是 | 这些能力由 Plugin loader 和对应运行时装配，普通 Skill 目录没有 Plugin 身份与根路径。 |

本篇的 LSP 正是"Plugin 才提供的组件"之一：server 配置只从已启用插件收集，普通 Skill 目录没有 `lspServers` 声明面。最准确的记忆方式是：**Slash 是调用界面，Skill 是 prompt command，Plugin 是来源与装配边界。** 只有组织策略把 `skills` 锁成 Plugin-only，或者 Skill 依赖 Plugin 才能提供的组件（例如 LSP）时，Plugin 才是必要条件；Slash 本身不是。

</details>

## 留给下一篇的问题

我们经常看到文章说 Claude Code 使用 Grep 而不是 RAG；那么在同时拥有 Grep 和 LSP 的情况下，Claude Code 什么时候会使用 Grep，什么时候会使用 LSP？

## 相关链接

- **上一篇**：[28 插件系统如何扩展能力并守住信任边界](./28-plugin-system.md)
- **下一篇**：[30 浏览器与 IDE 如何接入运行时](./30-browser-ide-and-external-tools.md)
- **参考资料**：[Claude Code Tools Reference：LSP](https://code.claude.com/docs/en/tools-reference)；[Claude Code Plugins Reference：LSP servers](https://code.claude.com/docs/en/plugins-reference)；[Language Server Protocol Specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)；[Extend Claude with skills](https://code.claude.com/docs/en/slash-commands)；[Create plugins](https://code.claude.com/docs/en/plugins)；[Skills vs Custom Commands in Claude Code — When to Use Which](https://dangquan1402.github.io/llm-engineering-notes/2026/04/03/skills-vs-custom-commands.html)；[Essential Claude Code Skills and Commands](https://batsov.com/articles/2026/03/11/essential-claude-code-skills-and-commands/)
