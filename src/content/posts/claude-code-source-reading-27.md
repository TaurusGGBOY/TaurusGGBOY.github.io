---
title: "Claude Code源码解读27：如何连接外部工具与资源"
published: 2026-07-24T16:47:14+08:00
updated: 2026-07-24T16:47:14+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-27/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：

> 当 teammate 的代码合并回主线发生冲突时，lead 是怎么处理的？

先给结论：在 `@anthropic-ai/claude-code@2.1.88` 的还原源码里，lead 没有调用某个 Team 专用 API 自动把两份代码揉成一份。Team control plane 负责成员身份、task、mailbox 和 worktree 生命周期；真正的 `merge`、`rebase`、冲突选择与测试，仍然由 lead 在 Git 工作树里完成。lead 可以让原 teammate 协助判断或修复，但最终整合结果和是否继续推进由 lead 负责。

### 先区分两种“冲突”

第一种是**共享工作区冲突**：几个 teammate 没有隔离 worktree，直接在同一个 cwd 写文件，未提交修改互相可见。这不是 Git merge 失败，而是执行阶段已经发生了覆盖风险。第二种才是**分支合并冲突**：每个 teammate 在独立 worktree 完成了 commit，lead 把这些分支按顺序合回主线时，Git 发现双方修改了同一片内容，或者一边修改、一边删除了同一个路径。

worktree 只能把冲突推迟到一个可审查的合并点，不能替 lead 做语义判断。文本冲突通常会被 Git 立刻标出来；接口契约相互矛盾、重复实现和锁文件不一致，则可能可以编译，却需要 lead 对照任务目标和测试才能发现。

### 2.1.88 的代码边界：团队负责保存成果，不负责合并

`AgentTool.call()` 的团队分支通过 `spawnTeammate()` 启动成员，并把成员身份、task owner、mailbox 以及可选的 `worktreePath` 交给团队控制面。这里没有把 teammate 的 branch 自动合并到 lead cwd 的步骤。

更直接的证据在清理路径。`TeamDeleteTool` 先拒绝仍有 active non-lead member 的团队，然后调用 `cleanupTeamDirectories()`。后者只读取成员保存的 `worktreePath`，逐个调用 `destroyWorktree()`，最后删除 team 和 task 目录；`destroyWorktree()` 执行的是 `git worktree remove --force`，失败时再删除目录。它处理的是回收，不是合并。

普通 Agent worktree 的自动清理也采用同样的边界：

```ts
if (!changed) {
  await removeAgentWorktree(worktreePath, worktreeBranch, gitRoot)
  return {}
}

return { worktreePath, worktreeBranch }
```

`cleanupWorktreeIfNeeded()` 只判断 worktree 相对 `headCommit` 是否有变化：没有变化才删除，有变化就把路径和分支留下。源码里对 `git merge`、`git rebase` 的识别出现在 Git 操作统计，而不是 Team 的冲突解决器。因此 lead 必须在清理前完成合并或把成果转移到主线；过早 `TeamDelete` 可能把仍有价值的 worktree 一并强制移除。

### lead 实际上的处理顺序

| 阶段 | lead 要做什么 | 为什么不能交给 Team 自动完成 |
| --- | --- | --- |
| 1. 固定边界 | 根据 team file、task owner、commit 和 worktree 路径确认每个改动属于哪个任务；让相关 teammate 暂停继续写 | task list 记录“谁负责什么”，不记录哪一侧的业务语义应该胜出 |
| 2. 选择基线 | 在干净的集成 worktree 中更新主线，决定采用 `git merge`、先 `git rebase`，还是按依赖从底层分支开始合并 | Team 没有替 lead 选择集成顺序的策略 |
| 3. 阅读三方 | 对照 merge base、主线版本和 teammate 版本，查看 `git status`、三方 diff 与冲突标记；不要机械执行 ours/theirs | Git 能定位文本冲突，但不能判断接口契约、产品行为和测试意图 |
| 4. 求证语义 | 通过 mailbox 问原 teammate 说明设计意图，必要时让它在自己的分支修复；lead 仍要审查这份修复 | teammate 能提供上下文，却没有主线的最终所有权 |
| 5. 完成并验证 | 编辑冲突文件，`git add` 后执行 `git merge --continue` 或提交 rebase 结果；重新跑测试、类型检查、lint，并检查完整 diff | 合并成功只说明 Git 接受了文件内容，不说明组合后的行为正确 |
| 6. 收敛团队 | 先更新 task 状态、通知依赖任务，再请求 teammate shutdown；确认没有 active member 后才运行 `TeamDelete` 清理目录 | 清理会删除 worktree 和 task/team 文件，必须放在成果落盘之后 |

如果冲突发生在有依赖的分支栈上，先处理最底层分支，再让上层分支 rebase 到已经稳定的结果。冲突已失去意义时，lead 可以 `git merge --abort` 或 `git rebase --abort`，保留原分支，重新给 teammate 一个基于最新主线的窄任务；这通常比让一个过时补丁继续堆叠更安全。

还有一个容易误判的地方：Git 报告“无冲突”不等于没有合并问题。两个 teammate 可能分别实现了同一个 helper，或者一个修改了 API 返回值、另一个仍按旧契约调用；这类语义冲突不会出现在 `<<<<<<<` 标记里。lead 的职责是把任务说明、接口约束、测试和运行结果放在同一个审查闭环里，而不是只看 merge 命令的退出码。

本文后续仍回到 MCP 的连接与能力发现；这里要记住的边界是：Agent Teams 提供协作控制面，Git 提供版本整合机制，lead 负责在两者之间做最后的工程判断。

## 问题现场

配置一个 MCP server 只是把连接放进候选列表。连接可能尚未完成，工具 Schema 可能不符合预期，资源读取还可能需要另一层权限；模型真正看到的能力，是这几道门都通过后的结果。

![MCP 连接生命周期与能力发现](/images/posts/claude-code-source-reading-27/27-mcp-lifecycle-detail-handdrawn.png)

本文沿着 MCP client 的生命周期阅读：配置选择 transport，连接状态决定是否发现能力，工具和资源被包装成 Claude Code 的本地对象，调用结果再回到统一的 `tool_result`。

## MCP 是一条带生命周期的协议连接

连接主线不是“读配置然后列工具”，而是 `config → transport → initialize → capability discovery → local Tool/Resource → permission → result`。任意一段失败，server 都可能停在 `pending`、`failed` 或 `needs-auth`，不会把半成品能力交给模型。

![Claude Code MCP 连接、能力发现、权限检查与结果回流](/images/posts/claude-code-source-reading-27/27-mcp-integration-handdrawn.png)

### 三个概念如何决定 MCP 的装配顺序

MCP 规定 client/server 用 JSON-RPC 风格消息握手、列出 tools/resources/prompts、执行调用。transport 决定消息和生命周期：stdio 启动本地子进程，HTTP/SSE/WebSocket 连接远端，SDK server 可以走同进程通道。只有 `initialize` 返回的 capabilities 确认了某类能力，客户端才继续请求对应列表；配置本身不等于可用工具。

这也解释了 MCP 与插件的区别。MCP 处理运行时连接和远程调用；插件处理一组文件怎样被发现、安装、启停和按作用域装配。插件可以携带 MCP 配置，但 MCP server 不必来自插件。下一篇再处理这个打包边界。

## YNM-9527 的事故单从 MCP 进来

核心任务明确要求：

> 通过 issue-tracker MCP 读取事故记录，必要时搜索 Stripe 官方文档，核对 amount 的单位和舍入规则。

Claude Code 先读取 MCP 配置，选择 transport 和来源作用域；连接完成握手与 capability 协商后，远端工具才会进入本地 Tool 注册表，资源仍走独立读取路径。模型提出调用时，还要经过本地权限，远端返回值才映射成 tool_result。

下面从 issue-tracker 的配置和连接状态开始，追踪 MCP 如何把外部工具和资源接入 YNM-9527 的调查。

## 第一步：配置先决定 transport 和来源作用域

`restored-src/src/services/mcp/types.ts` 用 Zod 把可配置的连接形态写成联合类型：

```ts
export const ConfigScopeSchema = lazySchema(() =>
  z.enum([
    'local',
    'user',
    'project',
    'dynamic',
    'enterprise',
    'claudeai',
    'managed',
  ]),
)

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

`ConfigScopeSchema` 描述配置来源。源码可确认的值有：`local` 表示当前项目的本地私有配置，`user` 表示用户级配置，`project` 表示项目共享的 `.mcp.json`，`dynamic` 常用于运行时或插件注入，`enterprise`、`claudeai`、`managed` 分别表示企业、claude.ai 和托管来源。server 连接许可与工具执行许可由后续两层权限控制。

`McpServerConfigSchema` 的八个分支是静态源码能确认的配置形态。`stdio` 的 `type` 为可选值，这是兼容旧配置的回退；`command` 必须是非空字符串，`args` 缺省为 `[]`，`env` 可为 `undefined`。`sse`、`http` 和 `ws` 使用 `url`，可选 headers；`sse`、`http` 还可带 OAuth 配置。`sse-ide`、`ws-ide` 是 IDE 内部形态；`sdk` 只保存 SDK server 名称；`claudeai-proxy` 带 `url` 与 `id`。

连接入口还明确给出超时回退：

```ts
function getConnectionTimeoutMs(): number {
  return parseInt(process.env.MCP_TIMEOUT || '', 10) || 30000
}

function isLocalMcpServer(config: ScopedMcpServerConfig): boolean {
  return !config.type || config.type === 'stdio' || config.type === 'sdk'
}
```

`getConnectionTimeoutMs()` 是空参函数。`MCP_TIMEOUT` 会按十进制整数解析；未设置、空字符串、无法解析或解析为 `0` 时，因为 `||` 回退到 `30000` 毫秒。负数也能通过这段 `parseInt`，静态源码只确认整数解析与 falsy 回退。

`isLocalMcpServer(config)` 接收带 scope 的 server 配置。`config.type` 为 `undefined`、`'stdio'` 或 `'sdk'` 时返回 `true`；其他联合类型返回 `false`。连接批处理据此把本地 server 与远端 server 分组，本地默认并发 3，远端默认并发 20，环境变量可覆盖，但非法值会各自回退。

为什么要分组？启动子进程会争用本机 CPU、内存和文件描述符，网络连接则主要等待 I/O。这里的并发限制来自客户端资源保护策略。

## 第二步：连接状态采用五态联合

`restored-src/src/services/mcp/types.ts` 用五种可观察状态表达连接生命周期：

```ts
export type MCPServerConnection =
  | ConnectedMCPServer
  | FailedMCPServer
  | NeedsAuthMCPServer
  | PendingMCPServer
  | DisabledMCPServer
```

这个联合类型的判别字段是 `type`，可选值为 `'connected'`、`'failed'`、`'needs-auth'`、`'pending'`、`'disabled'`。`connected` 携带 SDK `Client`、capabilities、可选 `serverInfo`、可选 `instructions` 和 `cleanup()`；`failed` 可带错误字符串；`pending` 可带当前重连次数与最大次数；其余状态都仍保留原配置。

server 尚未进入 AppState 时，连接表中查不到对应记录；进入 `pending` 后则已经具备配置、重试次数等状态。这个联合使工具发现可以按 `connected` 分支取 client，其余分支返回认证工具或空能力集合。

真正把连接与发现接起来的是 `restored-src/src/services/mcp/client.ts` 中 `getMcpToolsCommandsAndResources()` 的内部 `processServer`。主干可以缩成：

```ts
const client = await connectToServer(name, config, serverStats)

if (client.type !== 'connected') {
  onConnectionAttempt({
    client,
    tools:
      client.type === 'needs-auth'
        ? [createMcpAuthTool(name, config)]
        : [],
    commands: [],
  })
  return
}

const supportsResources = !!client.capabilities?.resources
const [tools, mcpCommands, mcpSkills, resources] = await Promise.all([
  fetchToolsForClient(client),
  fetchCommandsForClient(client),
  feature('MCP_SKILLS') && supportsResources
    ? fetchMcpSkillsForClient!(client)
    : Promise.resolve([]),
  supportsResources
    ? fetchResourcesForClient(client)
    : Promise.resolve([]),
])
```

**参数与分支说明：** `name` 是配置表中的 server 名称，属于开放字符串；`config` 是前面的 `ScopedMcpServerConfig`；`serverStats` 可省略，省略时只跳过这部分连接埋点。`onConnectionAttempt` 会收到 client、工具、命令与可选资源。

非 `connected` 状态不会继续发现能力。只有 `needs-auth` 会临时暴露一个认证工具，其他状态工具数组为空。`supportsResources` 通过双重取反转成布尔值；capability 缺失或为 `undefined` 时是 `false`。

连接成功后四类发现并行执行。并行只减少等待时间，每类 capability 仍需由 server 显式提供。任一步抛错，外层 catch 会把当前 server 记成 `failed`，工具与命令清空；因此本轮模型的可见工具取决于连接和发现都成功。

**字段说明：** `client` 保存连接结果；非 connected 分支传给 `onConnectionAttempt()` 的对象包含 `client`、临时 `tools` 与空 `commands`。connected 分支用 `supportsResources` 控制资源相关调用，并行结果分别写入 `tools`、`mcpCommands`、`mcpSkills`、`resources`。

## 第三步：server 工具怎样变成本地 Tool

`fetchToolsForClient()` 先检查 capability，再发送 `tools/list`。返回值经 MCP SDK 的 `ListToolsResultSchema` 解析和 Unicode 清理，然后才映射：

```ts
const fullyQualifiedName = buildMcpToolName(client.name, tool.name)
return {
  ...MCPTool,
  name: skipPrefix ? tool.name : fullyQualifiedName,
  mcpInfo: { serverName: client.name, toolName: tool.name },
  isMcp: true,
  async description() {
    return tool.description ?? ''
  },
  isConcurrencySafe() {
    return tool.annotations?.readOnlyHint ?? false
  },
  isDestructive() {
    return tool.annotations?.destructiveHint ?? false
  },
  isOpenWorld() {
    return tool.annotations?.openWorldHint ?? false
  },
  inputJSONSchema: tool.inputSchema as Tool['inputJSONSchema'],
}
```

`skipPrefix` 只有 SDK MCP 且环境变量 `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` 判真时才可能为 `true`；即使显示名不带前缀，`mcpInfo` 仍保存原 server 与 tool，供权限检查恢复完整名称。

`tool.description` 可以为 `undefined`，回退成空字符串；发送给模型的 prompt 还会限制到 2048 个字符。`readOnlyHint` 缺失时按 `false`，因此 server 省略声明时不会被乐观并发；`destructiveHint`、`openWorldHint` 也都默认 `false`。这些 annotation 服务于调度和风险分类，授权仍由权限引擎决定。

**字段说明：** `fullyQualifiedName` 由 client 与原始工具名生成；返回对象的 `name` 根据 `skipPrefix` 选择原名或完整名，`mcpInfo.serverName` 与 `mcpInfo.toolName` 始终保留原坐标，`isMcp` 固定为 `true`。`description`、`isConcurrencySafe`、`isDestructive`、`isOpenWorld` 分别读取描述和三类 annotation，`inputJSONSchema` 保存 server 的输入 schema。

Schema 需要看得更细。外部 `tool.inputSchema` 被保存为 `inputJSONSchema`，`restored-src/src/utils/api.ts` 会优先把它放进 Anthropic API 的 `input_schema`。基础 `MCPTool.inputSchema` 本身是 `z.object({}).passthrough()`；这段包装流程把即将发送的 `args` 透传，业务校验由 MCP server 或更外层协议承担。

名称前缀同时解决重名与权限粒度问题：规则可以允许一个具体工具，也可以允许一个 server 下的所有工具，并与同名内置工具隔离。

## 第四步：资源为什么不直接塞进 system prompt

资源可以是文档、数据库条目、文件或二进制对象。启动时把所有资源内容提前读取并塞进上下文，既浪费 token，也会把不相关数据带进请求。因此连接阶段只请求 `resources/list`，并给每项补上 server 名称；真正内容按需读取。

`ReadMcpResourceTool` 的输入契约很小：

```ts
export const inputSchema = lazySchema(() =>
  z.object({
    server: z.string().describe('The MCP server name'),
    uri: z.string().describe('The resource URI to read'),
  }),
)

const result = await connectedClient.client.request(
  {
    method: 'resources/read',
    params: { uri },
  },
  ReadResourceResultSchema,
)
```

`server` 和 `uri` 都是必填的开放字符串。`server` 必须匹配当前 `mcpClients` 中的名称；零命中、未连接或 capability 缺少 resources 都会抛错。

**字段说明：** 工具 schema 的 `server` 选择连接，`uri` 选择资源；协议请求的 `method` 固定为 `'resources/read'`，`params.uri` 原样取输入 URI。`result` 由 `ReadResourceResultSchema` 校验后进入文本或 blob 分支。

请求返回后由 `ReadResourceResultSchema` 检查协议结构。文本内容直接进入结果；blob 会 base64 解码，通过 `persistBinaryContent()` 保存到磁盘，再返回 `blobSavedTo` 与说明文本。`mimeType` 可为 `undefined`，持久化层会据此选择回退处理。这样做避免一个大二进制资源以 base64 形式直接撑爆模型上下文。

`ListMcpResourcesTool` 的 `server` 参数则是可选字符串。`undefined` 表示列出所有已知 server 的资源；给定名称只处理匹配 server，找不到会列出当前可用名称。两个资源工具都标记为 read-only、concurrency-safe 和 `shouldDefer: true`，但仍会通过普通工具链产生 `tool_result`。

## 第五步：MCP 仍然要过两层权限

这里容易混淆两件事。

第一层是 **project MCP server 是否获准连接**。项目共享的 `.mcp.json` 可能来自仓库，不能仅因文件存在就执行其中的命令。`restored-src/src/services/mcp/utils.ts` 返回三态：

```ts
export function getProjectMcpServerStatus(
  serverName: string,
): 'approved' | 'rejected' | 'pending' {
  const settings = getSettings_DEPRECATED()
  const normalizedName = normalizeNameForMCP(serverName)

  if (
    settings?.disabledMcpjsonServers?.some(
      name => normalizeNameForMCP(name) === normalizedName,
    )
  ) {
    return 'rejected'
  }

  if (
    settings?.enabledMcpjsonServers?.some(
      name => normalizeNameForMCP(name) === normalizedName,
    ) ||
    settings?.enableAllProjectMcpServers
  ) {
    return 'approved'
  }

  if (
    hasSkipDangerousModePermissionPrompt() &&
    isSettingSourceEnabled('projectSettings')
  ) {
    return 'approved'
  }

  if (
    getIsNonInteractiveSession() &&
    isSettingSourceEnabled('projectSettings')
  ) {
    return 'approved'
  }

  return 'pending'
}
```

`serverName` 是任意配置名称，函数先归一化再比较。返回值只有 `'approved'`、`'rejected'`、`'pending'`：禁用列表优先于启用列表；明确启用或 `enableAllProjectMcpServers` 为真时批准；普通交互路径规则未命中时保持 pending。完整函数还处理危险跳过权限和非交互模式，但都要求 `projectSettings` setting source 已启用；项目配置无法替用户接受危险模式确认。

第二层是 **某个已连接 server 的具体工具是否可执行**。外部工具包装后的 `checkPermissions()` 返回 `passthrough`，把最终判断交给通用权限引擎：

```ts
async checkPermissions() {
  return {
    behavior: 'passthrough' as const,
    message: 'MCPTool requires permission.',
    suggestions: [
      {
        type: 'addRules' as const,
        rules: [
          {
            toolName: fullyQualifiedName,
            ruleContent: undefined,
          },
        ],
        behavior: 'allow' as const,
        destination: 'localSettings' as const,
      },
    ],
  }
}
```

这个方法是空参方法。`behavior` 固定为 `'passthrough'`，表示继续让通用规则、权限模式、Hook 与用户确认决定。建议规则中的 `toolName` 是完整名称；`ruleContent: undefined` 表示匹配整个工具；`destination: 'localSettings'` 表示建议把允许规则写到当前项目的本地设置。

**字段说明：** 返回对象的 `message` 提供权限提示，`suggestions` 保存建议更新；每条建议以 `type: 'addRules'` 添加 `rules`，规则的 `behavior` 固定为 `'allow'`，`destination` 固定为 `'localSettings'`。

通用权限代码还支持 `mcp__server` 与 `mcp__server__*` 匹配该 server 下全部工具。SDK 去前缀模式下也会用 `mcpInfo` 恢复完整名称再匹配，所以名为 `Write` 的 MCP 工具不会意外吃到内置 `Write` 的规则。

因此，server approval 与 tool permission 不能合并成一个“信任 MCP”按钮：前者决定是否建立可能启动进程或访问网络的连接，后者决定本次模型提出的具体副作用是否允许发生。

## 第六步：调用如何回到 tool_result

权限通过后，动态 Tool 的 `call()` 会先提取原 assistant message 中的 `tool_use.id`，放进 `_meta['claudecode/toolUseId']`，然后调用 `callMCPToolWithUrlElicitationRetry()`。底层 `callMCPTool()` 的核心请求是：

```ts
const result = await Promise.race([
  client.callTool(
    {
      name: tool,
      arguments: args,
      _meta: meta,
    },
    CallToolResultSchema,
    {
      signal,
      timeout: timeoutMs,
      onprogress: onProgress
        ? sdkProgress => {
            onProgress({
              type: 'mcp_progress',
              status: 'progress',
              serverName: name,
              toolName: tool,
              progress: sdkProgress.progress,
              total: sdkProgress.total,
              progressMessage: sdkProgress.message,
            })
          }
        : undefined,
    },
  ),
  timeoutPromise,
])
```

`tool` 是 server 原始工具名，模型侧完整前缀名保存在包装 Tool；`args` 是开放的键值对象；`meta` 可为 `undefined`，普通动态包装会传对象，有 tool use id 时包含关联字段。`signal` 是必填 `AbortSignal`，用户中断会沿这条链取消请求。`onProgress` 可为 `undefined`。

**字段说明：** SDK 请求对象用 `name`、`arguments`、`_meta` 分别承载 `tool`、`args`、`meta`；调用选项把取消、超时与进度回调写入 `signal`、`timeout`、`onprogress`。进度对象的 `type` 固定为 `'mcp_progress'`，`status` 固定为 `'progress'`，`serverName` 与 `toolName` 标识来源，`progress`、`total`、`progressMessage` 透传 SDK 进度。`result` 取 `client.callTool()` 与 `timeoutPromise` 的先完成者。

`timeoutMs` 来自 `MCP_TOOL_TIMEOUT`，解析失败时默认 `100_000_000` 毫秒，约 27.8 小时。代码同时把它传给 SDK，并用 `Promise.race` 自建超时，覆盖流中断导致 SDK 内部计时器失效的场景。server 返回 `isError: true` 时会转成异常。

协议结果还不能直接成为模型消息。`transformMCPResult()` 接受三种顶层形态：

```ts
if (result && typeof result === 'object') {
  if ('toolResult' in result) {
    return {
      content: String(result.toolResult),
      type: 'toolResult',
    }
  }

  if (
    'structuredContent' in result &&
    result.structuredContent !== undefined
  ) {
    return {
      content: jsonStringify(result.structuredContent),
      type: 'structuredContent',
      schema: inferCompactSchema(result.structuredContent),
    }
  }

  if ('content' in result && Array.isArray(result.content)) {
    const transformedContent = (
      await Promise.all(
        result.content.map(item => transformResultContent(item, name)),
      )
    ).flat()
    return {
      content: transformedContent,
      type: 'contentArray',
      schema: inferCompactSchema(transformedContent),
    }
  }
}
```

`result` 的静态类型是 `unknown`，必须先确认是对象。`toolResult` 会被强制转成字符串；`structuredContent` 只排除 `undefined`，所以 `null` 也会被序列化为 JSON；`content` 必须是数组，内部可见的处理分支包括 text、audio、image、resource、resource_link，未知类型回退为空数组。三个分支均未命中时函数抛出“unexpected response format”，任意对象不会进入上下文。

**字段说明：** 三种返回形态都包含 `content` 与判别字段 `type`；`structuredContent` 和内容数组分支还生成 `schema`。数组分支先得到 `transformedContent`，再将其作为内容与 schema 推断输入。

`processMCPResult()` 随后处理大输出。普通内容未超限就原样返回；大文本或结构化内容在开关允许时持久化到文件并返回读取说明，包含图片时为了保持压缩与可查看性回退为截断。环境变量 `ENABLE_MCP_LARGE_OUTPUT_FILES` 明确判假时也走旧截断路径。

最后，`restored-src/src/tools/MCPTool/MCPTool.ts` 把规范化内容映射成模型认识的 block：

```ts
mapToolResultToToolResultBlockParam(content, toolUseID) {
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content,
  }
}
```

`content` 是前面规范化后的字符串、内容块数组或 `undefined`；`toolUseID` 是原 assistant `tool_use` 的 id，属于必填字符串。返回对象的 `type` 固定为 `'tool_result'`。因此模型下一轮看到的关联方式与 Bash、Read 等本地工具一致：同一个 id 把请求与结果接起来，`queryLoop()` 不需要知道结果跨过了哪个 transport。

**字段说明：** `tool_use_id` 原样取 `toolUseID`，`content` 原样取规范化结果，`type` 固定为 `'tool_result'`。

## 认证、断线与失败边界

远端连接的 401 不会被当成普通 failed。SSE、HTTP 或 claude.ai proxy 的认证失败会进入 `needs-auth`，并把 server id 写入一个 15 分钟 TTL 的缓存。后续启动在缓存有效期内会跳过无意义的重复探测，暴露认证工具；用户完成授权后再重连。OAuth 的 client id、callback port 与 metadata URL 都是可选配置，且 metadata URL schema 要求 HTTPS。

工具调用期间出现 401 会抛 `McpAuthError`。HTTP 会话过期则要求同时识别 HTTP 404 与 JSON-RPC `-32001`，避免把错误 URL 的普通 404 归入 session 过期。命中后清理连接缓存，动态 Tool 外层最多重试 1 次；该次数只适用于 session 恢复。

连接关闭后的策略又不同。`useManageMCPConnections()` 只为远端 transport 自动重连，`stdio` 与 `sdk` 断开后直接标成 failed。远端最多尝试 5 次，初始退避 1 秒，按指数增长并封顶 30 秒；等待期间若 server 被禁用会立刻停止。每次重连前还会清理 connection、tools、resources、commands 和可选 Skill 缓存，避免旧能力继续留在 AppState。

还有四个不能忽略的边界：

- `disabled` server 不建立连接，也不提供工具；切换为 disabled 时会先持久化状态，再清理已连接 client。
- server instructions 和工具 description 都来自外部；2048 字符限制与 Unicode 清理只规范输入形状，内容仍需按不可信数据处理，本地权限策略继续生效。
- `tools/list`、`resources/list` 和 `prompts/list` 有 LRU 缓存，server 发出对应 `list_changed` notification 时才会清缓存并刷新；静态源码无法确认缺少通知时远端目录的变化时点。
- AppState 按 server 保存连接、工具、命令与资源，更新时使用 server 前缀替换对应能力；故障隔离粒度是单个 server。

这就是 MCP 集成最重要的实现取舍：把不稳定的外部连接收口在适配层里，把命名、权限、消息关联和 Agent 循环保留在本地统一契约里。

## 小结

Claude Code 接入 MCP 可以归纳成六步：

1. 从不同 scope 收集配置，按 stdio、HTTP、SSE、WebSocket、SDK 等 transport 建立连接。
2. 用 `pending`、`connected`、`needs-auth`、`failed`、`disabled` 表达完整连接状态，只有 connected 才发现能力。
3. 根据 capability 请求工具、prompt 与资源目录，把外部工具包装成带完整名称和 JSON Schema 的本地 Tool。
4. 先做项目 server approval，再让具体 MCP 工具走通用权限引擎；外部能力不拥有权限捷径。
5. 通过 `tools/call` 执行，把文本、结构化内容、图片与资源规范化，并处理取消、超时、大结果与认证错误。
6. 用原 `tool_use.id` 生成标准 `tool_result`，交回同一个 `queryLoop()` 继续推理。

MCP 的价值是把跨进程、跨网络能力放进一个可发现、可授权、可取消、可诊断的协议边界。

## 留给下一篇的问题

在第一次对话时，Claude Code 会把哪些 MCP 信息发送给 LLM？

## 参考资料

- [Claude Code MCP](https://code.claude.com/docs/en/mcp)

- [MCP 官方规范](https://modelcontextprotocol.io/specification/latest)

- [Agent Teams - Claude Code Docs](https://code.claude.com/docs/en/agent-teams)

- [How to Run a Multi-Agent Coding Workspace (2026)](https://www.augmentcode.com/guides/how-to-run-a-multi-agent-coding-workspace)

- [How to Fix Merge Conflicts Created by Coding Agents](https://treq.dev/learn/how-to/merge-conflicts-with-coding-agents/)

- [Git - git-merge Documentation](https://git-scm.com/docs/git-merge.html)

- [About merge conflicts - GitHub Docs](https://docs.github.com/en/pull-requests/reference/merge-conflicts)
