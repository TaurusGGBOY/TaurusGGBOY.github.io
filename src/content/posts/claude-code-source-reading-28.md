---
title: "Claude Code源码解读28：插件系统如何扩展能力并守住信任边界"
published: 2026-07-24T16:47:15+08:00
updated: 2026-07-24T16:47:15+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-28/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 本章先建立三个概念

- **扩展打包**：Plugin 把 skills、agents、hooks、MCP 和样式组织成可安装目录。

- **来源证明**：marketplace、版本与缓存路径共同记录组件从哪里来、当前加载哪一份。

- **激活生命周期**：安装、启用、重载、更新和移除分别改变磁盘状态与运行时状态。

![Plugin 从安装缓存到运行时激活](/images/posts/claude-code-source-reading-28/28-plugin-activation-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇留下的问题是：MCP 提供外部能力以后，Claude Code 的插件系统如何把命令、Skill、Hook、Agent、MCP 与 LSP 打包、安装并按作用域加载？

先说答案：**插件是一种能力分发和生命周期容器，命令、Skill、Hook、Agent、MCP 与 LSP 仍按各自协议运行。**

MCP 解决的是“运行中的 Claude Code 怎样连接一个外部 server，并把它提供的工具、资源和提示词接入会话”。插件解决的是另一层问题：这些配置和配套文件从哪里来，以什么版本安装到本机，在哪个用户或项目中启用，什么时候进入当前会话，禁用或更新后又怎样退出运行时。

因此，一个插件可以同时携带六类能力：命令、Skill、Hook、Agent、MCP server 和 LSP server。安装时，Claude Code 先把“想启用什么”写入某个配置作用域，再把插件物化到版本化缓存；加载时，它解析 manifest 和约定目录，把不同组件送进各自的注册表。修改安装状态以后，还需要一次显式或宿主触发的刷新，当前会话才会用新组件替换旧组件。

这条链最重要的边界是：**发现只产生候选，安装只完成声明与物化，激活才把组件接入当前会话。** Marketplace 来源策略、项目信任、manifest Schema、相对路径、组织策略、组件自己的配置校验，都会在不同阶段拒绝或降级插件。

本篇仍然只讨论仓库中从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的代码。后面的源码块会省略与当前机制无关的日志、遥测和 UI 分支。

## 三层状态共同决定插件是否生效

读插件源码前，先建立声明、物化和激活三层模型：

1. **Marketplace 是目录。** 它告诉 Claude Code 有哪些插件、每个插件的来源、版本、依赖和可选组件。
2. **Plugin 是物化单元。** 它是一组文件和配置，可以包含 `.claude-plugin/plugin.json`，也可以依靠 `commands/`、`agents/`、`skills/`、`hooks/hooks.json` 等约定目录。
3. **Active components 是运行时能力。** 命令进入命令列表，Agent 进入 Agent 定义，Hook 进入生命周期回调，MCP/LSP 配置则交给各自的连接或 server manager；共同目录只提供分发边界，不改变各组件的执行模型。

源码自己的注释把生命周期写成三层：settings 中的 intent、`~/.claude/plugins/` 下的 materialization，以及 AppState/注册表中的 active components。这个模型比“下载一个压缩包然后 require”更接近真实实现。

![插件从声明、物化到运行时装配的三层流程](/images/posts/claude-code-source-reading-28/28-plugin-system-handdrawn.png)

注意图中的 `reload`。它会清缓存、重读已启用插件，并把命令、Agent、Hook、MCP 和 LSP 状态切换到当前会话。下载与版本化缓存由安装阶段负责；两阶段拆分让交互式会话避免在首屏阶段被一次 Git clone 卡住。

## 安装先确定作用域

插件作用域定义在 `restored-src/src/utils/plugins/schemas.ts`：

```ts
export const PluginScopeSchema = lazySchema(() =>
  z.enum(['managed', 'user', 'project', 'local']),
)
```

`PluginScopeSchema()` 接受四个精确值。`user` 写入用户级设置；`project` 写入项目共享设置；`local` 写入当前项目的个人覆盖；`managed` 表示企业或系统管理的只读安装。类型排除 `undefined` 与 `null`。

不过，`managed` 只用于描述管理方提供的安装，用户写入路径会被拒绝。`scopeToSettingSource()` 在 `restored-src/src/utils/plugins/pluginIdentifier.ts` 中明确实现这个边界：

```ts
export function scopeToSettingSource(
  scope: PluginScope,
): EditableSettingSource {
  if (scope === 'managed') {
    throw new Error('Cannot install plugins to managed scope')
  }
  return SCOPE_TO_EDITABLE_SOURCE[scope]
}
```

`scope` 是前面的四值联合类型；返回值只可能是 `userSettings`、`projectSettings` 或 `localSettings` 对应的可编辑来源。传入 `managed` 会抛错。管理员策略与用户主动安装意图因此写入不同配置层。

面向交互 UI 的安装入口进一步给出了默认值。`restored-src/src/utils/plugins/pluginInstallationHelpers.ts` 中的签名是：

```ts
export async function installPluginFromMarketplace({
  pluginId,
  entry,
  marketplaceName,
  scope = 'user',
  trigger = 'user',
}: InstallPluginParams): Promise<InstallPluginResult> {
```

`pluginId` 必须是 `plugin@marketplace` 形式的字符串；`entry` 是 marketplace 已校验的插件条目；`marketplaceName` 是来源目录名。`scope` 可省略，允许值只有 `user`、`project`、`local`，默认 `user`。`trigger` 可选 `hint` 或 `user`，默认 `user`，只用于区分建议触发和用户主动操作；它不改变插件权限。

安装核心 `installResolvedPlugin()` 做了三件事：检查策略和依赖，把整个依赖闭包写进对应 settings，再逐个物化到缓存。关键片段如下：

```ts
if (isPluginBlockedByPolicy(pluginId)) {
  return { ok: false, reason: 'blocked-by-policy', pluginName: entry.name }
}

const { error } = updateSettingsForSource(settingSource, {
  enabledPlugins: {
    ...getSettingsForSource(settingSource)?.enabledPlugins,
    ...closureEnabled,
  },
})

for (const id of resolution.closure) {
  // 解析 marketplace 条目与本地路径的分支省略
  await cacheAndRegisterPlugin(
    id,
    info.entry,
    scope,
    projectPath,
    localSourcePath,
  )
}
```

`pluginId` 是根插件 ID；`resolution.closure` 是解析后的依赖 ID 数组，也会逐项检查组织 block policy。`closureEnabled` 的值固定为 `true`，一次合并进当前 `settingSource`。`projectPath` 在 `user` 作用域为 `undefined`，在 `project`、`local` 作用域取当前 cwd；`localSourcePath` 只在相对本地来源解析成功时有值，否则为 `undefined`。任何依赖解析失败、策略阻断或 settings 写入失败都会返回结构化失败原因，不进入成功路径。

**字段说明：** 策略拒绝结果以 `ok: false` 标记失败，`reason` 固定为 `'blocked-by-policy'`，`pluginName` 取 marketplace 条目的 `entry.name`。设置更新对象的 `enabledPlugins` 先展开当前来源已有值，再合并 `closureEnabled`；解构出的 `error` 用于决定是否进入后续缓存循环。

这里可以得到一个很实用的结论：安装会同时更新声明层、物化层并处理依赖闭包。写入 `enabledPlugins` 后，还要运行 `/reload-plugins`，组件才会进入当前命令列表。

## 版本化缓存为什么是生命周期的一部分

插件会先经过版本化缓存。`cacheAndRegisterPlugin()` 计算版本，把内容移动到版本化路径，再记录 `installPath`。路径生成在 `restored-src/src/utils/plugins/pluginLoader.ts`：

```ts
export function getVersionedCachePathIn(
  baseDir: string,
  pluginId: string,
  version: string,
): string {
  const { name: pluginName, marketplace } = parsePluginIdentifier(pluginId)
  const sanitizedMarketplace = (marketplace || 'unknown').replace(
    /[^a-zA-Z0-9\-_]/g,
    '-',
  )
  const sanitizedPlugin = (pluginName || pluginId).replace(
    /[^a-zA-Z0-9\-_]/g,
    '-',
  )
  const sanitizedVersion = version.replace(/[^a-zA-Z0-9\-_.]/g, '-')
  return join(baseDir, 'cache', sanitizedMarketplace, sanitizedPlugin, sanitizedVersion)
}
```

`baseDir` 是插件数据根目录；`pluginId` 是开放字符串，但上层要求 `name@marketplace`，解析失败时插件名才回退到原值；`version` 可能来自 semver、Git SHA 或计算结果。三个路径片段都会替换不允许的字符，`marketplace` 缺失时回退为 `unknown`。函数不接受可选参数，`null` 和 `undefined` 都不属于签名。

版本目录把“插件名字”和“本次实际安装的内容”分开。更新时可以写入新版本并把旧版本标为 orphan；后台清理会在 `.orphaned_at` 标记超过七天后再移除。这样做既支持版本切换，也避免一次失败更新直接抹掉仍可能需要排查的旧内容。

启动读取又分成 full load 和 cache-only load。`loadAllPluginsCacheOnly()` 默认只读 `installed_plugins.json` 记录的 `installPath`，不发网络请求、不复制新版本；只有 `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` 被解释为真时，它才委托给 full loader。交互模式因此优先快速进入会话，显式刷新或同步安装模式才承担联网物化成本。

## Manifest 是受约束的组件索引

标准 manifest 位于 `.claude-plugin/plugin.json`。它把元数据与各组件 Schema 合成一个对象：

```ts
export const PluginManifestSchema = lazySchema(() =>
  z.object({
    ...PluginManifestMetadataSchema().shape,
    ...PluginManifestHooksSchema().partial().shape,
    ...PluginManifestCommandsSchema().partial().shape,
    ...PluginManifestAgentsSchema().partial().shape,
    ...PluginManifestSkillsSchema().partial().shape,
    ...PluginManifestOutputStylesSchema().partial().shape,
    ...PluginManifestChannelsSchema().partial().shape,
    ...PluginManifestMcpServerSchema().partial().shape,
    ...PluginManifestLspServerSchema().partial().shape,
    ...PluginManifestSettingsSchema().partial().shape,
    ...PluginManifestUserConfigSchema().partial().shape,
  }),
)
```

这些 `.partial()` 使 Hook、Command、Agent、Skill、output style、channel、MCP、LSP、settings 和 user config 都成为可选字段；插件不必一次提供全部能力。运行时顶层对象采用 Zod 默认行为，会剥离未知顶层键以保持向前兼容；`claude plugin validate` 则额外使用 `.strict()`，帮助作者发现拼写错误。嵌套配置仍有更严格的 Schema，不能把“顶层容错”理解为“所有字段随便写”。

更容易忽略的是：`plugin.json` 本身也是可选的。`loadPluginManifest()` 在文件不存在时生成最小 manifest：

```ts
if (!(await pathExists(manifestPath))) {
  return {
    name: pluginName,
    description: `Plugin from ${source}`,
  }
}
```

`manifestPath` 是绝对或已解析的 manifest 路径；`pluginName` 来自 marketplace 条目或 fallback name；`source` 是插件来源标识。文件缺失会返回默认对象，文件存在但 JSON 损坏或 Schema 不通过则抛错。约定目录足以构成简单插件；损坏的 manifest 进入校验错误路径。

**字段说明：** 最小 manifest 的 `name` 原样取 `pluginName`，`description` 用 `source` 生成来源说明。

Manifest 中的组件路径受明确约束。命令支持单个相对路径、相对路径数组，或“命令名到 metadata”的映射；Agent 文件要求相对 Markdown 路径；Skill 指向相对目录；Hook 可以内联，也可以引用相对 JSON；MCP/LSP 可以引用配置文件或内联对象。路径 Schema 要求以 `./` 开头，独立校验命令还会在 Schema 前检查 `commands`、`agents`、`skills` 中的 path traversal。

manifest 是一份**受约束的组件索引**：它声明插件希望加载哪些文件；组件权限仍由对应子系统决定。

## 从插件目录到六种运行时组件

`createPluginFromPath()` 位于 `restored-src/src/utils/plugins/pluginLoader.ts`。它先读 manifest，再自动探测 manifest 未显式覆盖的标准目录：

```ts
const [
  commandsDirExists,
  agentsDirExists,
  skillsDirExists,
  outputStylesDirExists,
] = await Promise.all([
  !manifest.commands ? pathExists(join(pluginPath, 'commands')) : false,
  !manifest.agents ? pathExists(join(pluginPath, 'agents')) : false,
  !manifest.skills ? pathExists(join(pluginPath, 'skills')) : false,
  !manifest.outputStyles
    ? pathExists(join(pluginPath, 'output-styles'))
    : false,
])
```

`pluginPath` 是已解析插件根目录；省略 `manifest.commands` 等字段时才自动探测约定目录，显式配置存在时则以配置路径为准。四个探测结果都是布尔值：`true` 进入相应目录加载，`false` 跳过；并行探测只优化 I/O，不改变后续装配顺序。

随后，不同组件走向不同消费者：

- Command 读取 Markdown/frontmatter，转成命令对象并进入命令列表；插件命令会带插件来源和命名空间。
- Skill 仍然以可被模型调用的 prompt command 形态进入 Skill/命令索引，但它保留 skill 的加载来源与调用规则。
- Agent Markdown 转成 `AgentDefinition`，标记 `source: 'plugin'`，再与项目和用户 Agent 定义合并。
- Hook 被转换为原生 matcher，并附加 `pluginRoot`、`pluginName`、`pluginId`，这样 shell 命令和诊断仍知道自己来自哪个插件。
- MCP 配置交给 MCP integration，环境变量和 user config 在激活时解析。
- LSP 配置交给 LSP integration，server 先进入配置集合，实际进程按需启动。

MCP 和 LSP 还会给 server 名加插件作用域。源码分别生成同样形状的名字：

```ts
const scopedName = `plugin:${pluginName}:${name}`
scopedServers[scopedName] = {
  ...config,
  scope: 'dynamic',
  source: pluginName,
}
```

这段摘自 `addPluginScopeToLspServers()`；MCP 的 `addPluginScopeToServers()` 同样使用 `plugin:${pluginName}:${name}`，但额外保存 `pluginSource`。`pluginName` 和 `name` 都是开放字符串，来源分别是已加载插件和 server 配置；`scope` 固定为 `dynamic`，表示 server 来自运行时注入。安装阶段的 `user/project/local/managed` 则记录插件启用意图所在配置层。

**字段说明：** `scopedName` 是写入 `scopedServers` 的 key；值先展开原 `config`，再把 `scope` 设为 `'dynamic'`，并用 `source` 保存 `pluginName`。

命名空间解决 key 碰撞。两个插件都声明 `typescript` server 时，它们不会互相覆盖；server 的可执行命令、环境变量、启动和授权继续经过 MCP/LSP 自己的 Schema、生命周期与权限。

## 为什么安装后还要 reload

真正把三层接起来的是 `refreshActivePlugins()`，位置在 `restored-src/src/utils/plugins/refresh.ts`：

```ts
clearAllCaches()
clearPluginCacheExclusions()

const pluginResult = await loadAllPlugins()
const [pluginCommands, agentDefinitions] = await Promise.all([
  getPluginCommands(),
  getAgentDefinitionsWithOverrides(getOriginalCwd()),
])

const { enabled, disabled, errors } = pluginResult
```

`clearAllCaches()` 同时清插件、命令、Agent、Skill prompt 和 output style 等 memoization；`clearPluginCacheExclusions()` 让显式 reload 重新扫描 orphan exclusion。`loadAllPlugins()` 是允许物化新内容的 full load；后面的命令和 Agent 加载可并行，因为 full load 已先完成并预热 cache-only 结果。`enabled`、`disabled`、`errors` 始终是数组，空数组会让后续替换逻辑清除对应的旧运行时集合。

组件准备好后，函数更新 AppState、提高 MCP reconnect key、重建 LSP manager，并原子替换 Hook：

```ts
setAppState(prev => ({
  ...prev,
  plugins: {
    ...prev.plugins,
    enabled,
    disabled,
    commands: pluginCommands,
    errors: mergePluginErrors(prev.plugins.errors, errors),
    needsRefresh: false,
  },
  agentDefinitions,
  mcp: {
    ...prev.mcp,
    pluginReconnectKey: prev.mcp.pluginReconnectKey + 1,
  },
}))

reinitializeLspServerManager()
await loadPluginHooks()
```

`setAppState` 接收基于旧 `AppState` 的更新函数；`needsRefresh` 在成功消费刷新后固定为 `false`。`pluginReconnectKey` 每次加一，用变化信号让 MCP connection effect 重跑。`reinitializeLspServerManager()` 即使当前 LSP 插件数量为 0 也会调用，以清除被移除插件的旧配置。`loadPluginHooks()` 内部采用 clear-then-register，旧 Hook 会保留到新集合准备好。

**字段说明：** `plugins` 分支保留 `prev.plugins`，再替换 `enabled`、`disabled`、`commands`，并用 `mergePluginErrors()` 计算 `errors`；`agentDefinitions` 替换 Agent 集合。`mcp` 分支保留 `prev.mcp`，只递增 `pluginReconnectKey`。

这就是安装与激活拆开的收益：网络和磁盘物化可以在明确时机发生，运行时组件则尽量以整组状态切换，减少“新命令已出现、旧 Hook 还在、MCP 尚未重连”的半刷新窗口。

## 信任边界分布在来源、文件与组件运行时

插件系统至少有五道不同的边界。

第一道是项目信任。`performStartupChecks()` 在当前目录尚未接受 trust dialog 时，直接跳过后台插件安装：

```ts
if (!checkHasTrustDialogAccepted()) {
  logForDebugging(
    'Trust not accepted for current directory - skipping plugin installations',
  )
  return
}
```

这个函数只接收 `setAppState`，无可选 flags；信任检查为假就提前返回。后续后台安装即使抛错也会被捕获并记录，不阻断 Claude Code 主启动。该门只授权根据项目声明安装插件，插件内容仍需继续通过来源、Schema 与组件权限检查。

第二道是 marketplace 来源策略。加载器读取 `strictKnownMarketplaces` 和 `blockedMarketplaces`。allowlist 即便是空数组也表示“拒绝全部”；blocklist 只有非空才构成有效限制。策略存在但 marketplace 来源无法解析时，源码明确 fail-closed，把插件记为 `marketplace-blocked-by-policy` 并停止加载。

第三道是插件级组织策略。根插件和依赖闭包都会经过 `isPluginBlockedByPolicy()`，避免一个允许的插件把被禁依赖带进来。

第四道是文件与 Schema。损坏的 JSON、错误的字段类型、路径穿越、丢失的组件文件会产生不同错误。部分组件缺失可以让插件带着错误继续加载；manifest 损坏、来源策略失败或依赖不完整则可能让插件进入 disabled 或直接返回 `null`。降级级别取决于失败是否破坏身份、来源和执行边界。

第五道是组件自己的运行时权限。插件 Hook 能否执行命令、MCP tool 能否被调用、LSP server 能否启动，仍分别受 Hook、工具权限、进程启动和配置校验约束。**插件已安装不会为其内容生成一张通用通行证。**

还有一个值得注意的失败边界：session-only 的 `--plugin-dir`、marketplace 插件和 builtin 插件会在加载后合并。session 插件通常可按名字覆盖已安装插件，但 managed settings 锁定的插件例外；依赖验证发生在并行加载之后，缺失或禁用依赖会把相关插件在本次会话中 demote 为 disabled，却不会擅自改写用户 settings。意图仍留给用户或管理员修复，当前运行时先停止装配。

## 更新和禁用为什么也需要完整生命周期

更新会把新内容写入新的 versioned cache，安装记录指向新 `installPath`，旧版本进入 orphan 清理流程。Marketplace 的 `autoUpdate` 也有明确回退：配置显式给出布尔值时按该值执行；字段为 `undefined` 时，部分官方 marketplace 默认开启，其他来源默认关闭。Schema 排除 `null`。

禁用会同时改变多个层次：设置层修改 `enabledPlugins`，缓存层可以暂时保留已安装版本，active layer 清理命令/Agent 缓存、阻止移除插件的 Hook 继续触发、让 MCP 重连，并让 LSP manager 丢弃旧 server 配置。缓存保留服务于恢复与版本管理，运行能力撤销决定当前会话的安全边界。

源码还对被 marketplace 删除的插件提供了可选的强制移除逻辑：只处理用户可控的 `user`、`project`、`local` 安装，不替企业管理员删除 managed-only 插件；单个 marketplace 检查失败时记录并继续。这类代码说明插件系统的职责已经超出“加载文件”，它还要维护来源变化、版本历史和配置所有权。

## 小结

Claude Code 的插件系统可以压缩成三层：settings 声明启用意图，versioned cache 物化具体版本，refresh 把已启用插件拆成不同运行时组件。Marketplace 提供目录和来源，manifest 提供受约束的组件索引，scope 决定谁能看到和修改启用意图，reload 决定当前会话何时真正切换能力。

命令、Skill、Hook、Agent、MCP 和 LSP 可以一起分发，运行时则分别进入对应子系统，继承各自的配置、命名空间、故障与权限边界。插件负责组织这些能力，各子系统仍保留差异。

最需要记住的是三段控制流：Marketplace 可见项先经过来源信任，安装成功后还要 reload 激活，插件启用后每个组件仍需取得自身许可。项目 trust、组织 policy、Schema、路径校验、依赖 demotion 和组件级权限共同约束扩展入口。

## 留给下一篇的问题

插件能够携带语言能力以后，Claude Code 如何启动 LSP 服务器、同步文档，并把诊断与代码导航结果注入 Agent？

## 参考资料

- [Claude Code Plugins](https://code.claude.com/docs/en/plugins)

- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference)
