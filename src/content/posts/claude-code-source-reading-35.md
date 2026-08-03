---
title: "Claude Code源码解读35：配置如何分层、同步与裁剪"
published: 2026-07-24T16:47:22+08:00
updated: 2026-07-24T16:47:22+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-35/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：当你的代码需要调用 Claude Code 时，相比 Agent SDK，`claude -p` 在哪些场景下更有优势？

先看调用方真正要接管什么。`claude -p` 把 prompt、stdin、cwd 和权限参数交给一个子进程，再用 stdout、stderr 与退出码收尾；一次性、可序列化、权限可预先确定的任务，天然适合这条边界。Agent SDK 复用同一个 Agent 内核，却把会话、事件、权限回调和控制消息暴露给宿主程序，换来控制力，也换来生命周期成本。

### 2.1.88 的分叉点在 headless 宿主

`restored-src/src/cli/print.ts::runHeadless()` 的参数已经把两种用法的边界写出来了：`inputPrompt` 可以是字符串或 `AsyncIterable<string>`，`options` 则携带 `outputFormat`、`jsonSchema`、`permissionPromptToolName`、`maxTurns`、`sdkUrl`、`replayUserMessages` 与 `includePartialMessages` 等控制项。字符串 prompt 会在 `getStructuredIO()` 中包装成一条 SDK user message；省略 `sdkUrl` 时使用本地 `StructuredIO`，提供 URL 时切换到 `RemoteIO`。

随后 `runHeadless()` 把输入交给 `runHeadlessStreaming()`，再把同一条 Agent 查询链产生的消息按输出格式写出：`text` 只取最终结果，`json` 输出一个可供脚本解析的 result 对象，`stream-json` 在 `verbose` 下逐条写出 NDJSON 事件。循环结束后，源码还依据最后一条 result 的 `is_error` 设置进程退出码，再执行 graceful shutdown。对 Shell 来说，这就是一份熟悉的命令契约：输入、输出、错误流和退出状态都有明确位置。

### `claude -p` 更占优的场景

| 场景 | `claude -p` 的优势 | 选择 SDK 的信号 |
| --- | --- | --- |
| Shell、Make、cron、CI | 一条命令即可接入现有管道；stdin、stdout、stderr、退出码都能交给现有工具处理 | 需要把每个中间事件送入应用状态或业务队列 |
| 一次性检查或生成报告 | `--output-format json` 与 `--json-schema` 直接给出机器可读结果，失败可以由退出码触发重试 | 结果之外还要持续消费 assistant、tool progress、partial message 或 system event |
| 权限在启动前固定 | 用 settings、`--allowed-tools`、`--disallowed-tools` 和 `--permission-mode` 先划定边界，脚本不需要实现审批 UI | 工具执行中要由网页、IDE 或业务审批服务动态返回 allow/deny |
| 独立任务批处理 | 每个进程天然隔离 cwd、环境和会话，操作系统层的并行、超时和取消都容易接入 | 多轮任务共享同一个 session、需要精细 interrupt 或在轮次之间改写配置 |
| 快速原型与故障复现 | 用户可以把完整命令复制到终端重跑，版本、参数和输入都容易记录 | 宿主已经需要维护 pending request、事件分发和断线恢复，继续堆命令行 glue code 会变成自制协议层 |

这里的“独立任务”是一个运行方式上的推论：源码能证明每次 `claude -p` 都在一个 headless 进程里完成输入归一化、查询和收尾；至于批量启动多少个进程、并发是否合适，仍取决于机器资源、账号限流和任务之间是否互相读写文件。

### SDK 何时值得承担额外控制面

Agent SDK 的价值在于把 `StructuredIO` 背后的协议细节提升成语言层对象。宿主可以持续发送 user message，消费类型化的 assistant/result/system 事件，监听工具进度，响应 `control_request`，并在会话中主动 interrupt、切换模型或恢复 session。对 IDE、Web 服务、多人协作后台和需要审计的自动化系统，这些控制点本身就是产品功能。

公开资料也给出了一个与源码边界一致的使用层判断：headless CLI 适合把任务接到脚本和流水线；SDK 适合把 Agent 嵌入由别人使用的程序。SDK 文档还提醒，默认 system prompt 与 `claude -p` 的完整 Claude Code 提示词并不等价；如果产品确实要复刻 CLI 行为，需要显式选择 `claude_code` preset，再按需追加自己的规则。这个差异来自当前公开文档，不能反推 2.1.88 每个构建的运行时配置，但足以提醒我们：迁移到 SDK 时，除了改 API，还要检查 settings、CLAUDE.md、skills、hooks 和 prompt 是否仍然按预期加载。

因此选择标准很简单：把 Claude Code 当作一个可复现的命令行工件时用 `claude -p`，把它嵌进长期运行的应用并需要动态控制时用 Agent SDK。若宿主开始手写事件分发、权限请求表、取消传播和断线恢复，说明它已经在重复 SDK 的职责。

下图的 Settings Cascade 画的是未用 `--setting-sources` 重排时的默认顺序；显式参数怎样改变前三层，会在正文展开。

![Claude Code 配置级联、动态更新与功能开关手绘图](/images/posts/claude-code-source-reading-35/35-settings-config-flags-handdrawn.png)

本文仍以 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码为边界。还原路径用于定位证据，不假定等同于 Anthropic 内部仓库的原始目录。下面的片段只保留证明当前结论的分支，无关字段与错误上报会省略。

## 本章先建立三个概念

- **优先级格**：policy、命令行、环境变量、项目与用户设置按字段类型执行覆盖或合并。

- **来源证明**：有效值必须连同来源层一起观察，才能解释配置为何生效。

- **Runtime gate**：feature flag 在运行时裁剪路径，settings 则提供相对稳定的用户与组织意图。

![Settings 来源优先级与 Feature Flag 裁剪](/images/posts/claude-code-source-reading-35/35-config-precedence-detail-handdrawn.png)

先把“值从哪里来”“哪一层覆盖它”“代码是否允许这条路径存在”分开，后面的配置排障才有坐标。

## YNM-9527 开始前，用户先打开配置入口

用户先输入：

> /config

在配置界面里，权限模式、启用的扩展、输出方式和实验开关可能来自不同 settings source；下一次核心任务启动时，加载器还要合并 CLI、环境变量、policy、项目设置与本地设置。用户看到的是“我改了一个选项”，运行时采用的却是来源优先级、信任门槛和 feature flag 共同算出的结果。

下面以 /config 这一步为入口，说明配置为什么分层、哪些值会写回文件，以及它怎样影响后面的 YNM-9527。

## 这一篇要讲什么，配置机制有什么用

上一节解决的是“调用 Claude Code 时选 `claude -p` 还是 SDK”。从这里开始，本篇换一个角度：不再追踪一次模型请求，而是追踪一个配置值从哪里来、什么时候被覆盖、什么时候能在当前进程生效。

本篇按配置进入运行时的顺序拆成四层：

| 层 | 要看清什么 | 对使用者有什么用 |
| --- | --- | --- |
| 构建能力 | `feature()` 决定某段实现是否进入产物 | 判断一个开关为什么写进配置也没有效果；构建时被裁掉的能力无法靠运行时配置恢复 |
| Settings cascade | user、project、local、flag、policy 如何读取、校验和合并 | 找到真正生效的来源，避免只改某个 `settings.json` 却被更高优先级覆盖 |
| Policy 与信任边界 | 托管策略如何选 winner，`env` 为什么要经过信任过滤 | 分清“用户能改的偏好”和“组织强制的规则”，也避免不可信项目提前改写进程环境 |
| Runtime gate 与动态同步 | GrowthBook 缓存、默认值、刷新信号和 settings watcher 如何裁剪路径 | 区分“代码存在”“实验已开启”“文件刚改完”和“当前长会话已经重新读取”这几件事 |

这张地图也是本文的排障顺序：先确认能力是否存在，再定位配置来源，接着看合并与安全过滤，最后检查运行时 gate 和订阅者是否刷新。读完后，你应该能回答“我写的值在哪里”“为什么没有生效”“改文件后哪一部分会立即变化”，而不是把所有行为都归因于一份 `settings.json`。

## 先分清三类经常被叫作“配置”的东西

排查“写了配置却没生效”时，先问它属于哪一类。一个 `if` 可能是构建裁剪，也可能是运行时实验，或只是 settings 合并结果；三者的生效时间和可观测入口不同。

`SettingsJson` 是用户、项目、CLI 与管理员提供的数据，例如权限规则、hook、sandbox、model、env。它们先通过 schema 校验，再合成一份有效 settings。

GrowthBook feature 是远端或缓存的运行时值。调用方必须自己提供 `defaultValue`，远端不可用时不会凭空推导一个默认行为。

`feature()` 来自 `bun:bundle`，属于构建能力开关。源码里常用正向三元表达式配合动态 `require()`，让非目标构建连相关模块和实验 key 字符串都能被裁掉；GrowthBook 则在已进入产物的代码中选择运行时分支。

`restored-src/src/bridge/bridgeEnabled.ts` 把两层 gate 放在了一起：

```ts
export function isBridgeEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() &&
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_bridge', false)
    : false
}
```

`isBridgeEnabled()` 接受零个参数并返回布尔值。构建开关 `BRIDGE_MODE` 为假时直接返回 `false`，跳过订阅身份和 GrowthBook 读取。构建中包含 Bridge 时，才继续要求 `isClaudeAISubscriber()` 为真并读取 `tengu_ccr_bridge`；这个运行时 gate 的明确回退值是 `false`。

这段代码给出三级可用性：源码包含实现、构建产物包含模块、当前账号通过运行时 gate。

## CLI 必须在完整初始化前先划定来源

`--settings` 如果等普通参数解析结束再加载，就会太晚：认证、网络代理、插件和模型初始化可能已经读过默认 settings。`main.tsx` 因此在 `init()` 前做一次 eager parse：

```ts
function eagerLoadSettings(): void {
  const settingsFile = eagerParseCliFlag('--settings')
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile)
  }

  const settingSourcesArg = eagerParseCliFlag('--setting-sources')
  if (settingSourcesArg !== undefined) {
    loadSettingSourcesFromFlag(settingSourcesArg)
  }
}
```

`eagerLoadSettings()` 接受零个参数并返回 `void`。`--settings` 缺失或值为空时跳过 flag source；`--setting-sources` 则故意用 `!== undefined` 判断，因此显式空字符串会禁用 user、project、local，省略参数则保留启动状态中的默认来源。

`loadSettingsFromFlag(settingsFile)` 接受开放字符串。首尾去空白后，如果同时以 `{` 开头、以 `}` 结尾，就按内联 JSON 处理；否则按文件路径处理。非法 JSON、文件不存在或读取失败都会打印错误并退出，防止显式 CLI 配置被静默忽略。内联 JSON 会写入按内容 hash 命名的临时文件；相同内容保持稳定路径，避免路径进入 Bash tool 描述后反复破坏 API prompt cache。

另一个参数只接受封闭集合。`restored-src/src/utils/settings/constants.ts` 的解析如下：

```ts
export function parseSettingSourcesFlag(flag: string): SettingSource[] {
  if (flag === '') return []

  const result: SettingSource[] = []
  for (const name of flag.split(',').map(s => s.trim())) {
    switch (name) {
      case 'user':
        result.push('userSettings')
        break
      case 'project':
        result.push('projectSettings')
        break
      case 'local':
        result.push('localSettings')
        break
      default:
        throw new Error(`Invalid setting source: ${name}`)
    }
  }
  return result
}
```

`flag` 是逗号分隔字符串，源码能够确认的合法值只有 `user`、`project`、`local`；空字符串返回空数组，未知值直接抛错。`result` 按输入顺序收集内部枚举 `userSettings`、`projectSettings`、`localSettings`；这里保留重复项，后续 `getEnabledSettingSources()` 再用 `Set` 去重，并补入 `flagSettings` 与 `policySettings`。

这就是 Agent SDK 的隔离能力为什么只能裁掉三类普通来源。`settingSources: []` 可以阻止 `~/.claude/settings.json` 与当前项目文件污染一次 SDK 调用，却不能绕过显式传入的 `--settings`，也不能绕过管理员策略。

## 默认五层 settings 按低到高深合并

真正的来源顺序写在同一个 constants 文件中：

```ts
export const SETTING_SOURCES = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const
```

`SETTING_SOURCES` 是只读元组，也是 bootstrap state 的默认顺序，方向从低优先级到高优先级。`userSettings` 通常来自 Claude 配置目录的 `settings.json`；`projectSettings` 是原始工作目录下 `.claude/settings.json`；`localSettings` 是 `.claude/settings.local.json`；`flagSettings` 来自 `--settings` 文件以及 SDK inline settings；`policySettings` 是托管策略的统一槽位。用户目录在 cowork 模式下可能改用 `cowork_settings.json`，所以不能把所有 user settings 都绝对写成一个固定文件名。

这里有一个源码细节值得单独指出：显式 `--setting-sources project,user` 会让 bootstrap state 保存 `[projectSettings, userSettings]`，`getEnabledSettingSources()` 用保持插入顺序的 `Set` 去重后，再追加 flag 与 policy。因此该调用下 user 的普通字段会在 project 之后合并。CLI 文案把这个参数描述成来源选择器，但 2.1.88 的实现也让参数顺序参与优先级；图中和下文的 user → project → local 表示未显式重排时的默认链。

`restored-src/src/utils/settings/settings.ts` 的 `loadSettingsFromDisk()` 先取 plugin base，再遍历启用来源：

```ts
const pluginSettings = getPluginSettingsBase()
let mergedSettings: SettingsJson = {}
if (pluginSettings) {
  mergedSettings = mergeWith(
    mergedSettings,
    pluginSettings,
    settingsMergeCustomizer,
  )
}

for (const source of getEnabledSettingSources()) {
  // 读取、校验当前 source
  if (settings) {
    mergedSettings = mergeWith(
      mergedSettings,
      settings,
      settingsMergeCustomizer,
    )
  }
}
```

`loadSettingsFromDisk()` 接受零个参数，返回 `{ settings, errors }`。`pluginSettings` 存在时先作为最低层合入，省略时 `mergedSettings` 从空对象开始；循环变量 `source` 按 `getEnabledSettingSources()` 的顺序读取普通来源和必选的 flag/policy。每个文件先经 `SettingsSchema()` 校验，合法值才写回 `mergedSettings`；错误按 `file:path:message` 去重后进入 `errors`，失败来源跳过合并，保留已经生效的低优先级值。

普通标量和对象遵循 Lodash `mergeWith` 的后者覆盖与递归合并，数组却有专门规则：

```ts
function mergeArrays<T>(targetArray: T[], sourceArray: T[]): T[] {
  return uniq([...targetArray, ...sourceArray])
}

export function settingsMergeCustomizer(
  objValue: unknown,
  srcValue: unknown,
): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return mergeArrays(objValue, srcValue)
  }
  return undefined
}
```

`settingsMergeCustomizer(objValue, srcValue)` 接收当前累计值和更高优先级来源值。两者都是数组时，返回“旧数组在前、新数组在后”的去重结果；其他类型返回 `undefined`，Lodash 收到该返回值后继续执行默认深合并，而不会把目标字段赋成 `undefined`。`null` 也进入 Lodash 默认分支。

因此“高优先级覆盖低优先级”对数组并不准确。权限规则、hook 等数组字段可能累计多个来源的内容；真正的 allow/ask/deny 冲突，还要由第 12 篇讲过的权限引擎解释，不能只凭 settings merge 顺序判断最终授权。

## Flag 层里，SDK inline 又覆盖文件

Flag source 同时承载 `--settings path` 和 SDK 写入 bootstrap state 的 inline settings：

```ts
if (source === 'flagSettings') {
  const inlineSettings = getFlagSettingsInline()
  if (inlineSettings) {
    const parsed = SettingsSchema().safeParse(inlineSettings)
    if (parsed.success) {
      return mergeWith(
        fileSettings || {},
        parsed.data,
        settingsMergeCustomizer,
      ) as SettingsJson
    }
  }
}
return fileSettings
```

这里 `source` 是五个 `SettingSource` 之一；只有 `flagSettings` 进入该分支。`inlineSettings` 为 `undefined`、`null` 或其他假值时不参与；schema 校验失败时也不合并，函数回到文件值。成功时参数顺序是 `fileSettings || {}` 在前、`parsed.data` 在后，所以 SDK inline 普通字段覆盖 `--settings` 文件中的同名字段，数组仍按拼接去重处理。

这一层常被 CLI 参数的名字误导。`--model`、`--permission-mode`、`--effort` 等独立 Commander 参数未必先被塞进 `SettingsJson` 再统一 merge；有些会进入 session/AppState 或专用参数对象，并由调用点决定是否压过 settings。例如运行中同步 settings 时，`applySettingsChange()` 只有在新的 `effortLevel !== undefined` 且确实变化时才更新顶层 `effortValue`，特意避免无关文件变动抹掉会话级 `--effort`。

。每个独立 flag 仍要沿自己的 consumer 查证。

## Policy 是一个槽位，但槽位内部 first source wins

托管策略采用优先级选择：选中第一份非空策略后停止：

```ts
if (source === 'policySettings') {
  const remoteSettings = getRemoteManagedSettingsSyncFromCache()
  if (remoteSettings && Object.keys(remoteSettings).length > 0) {
    return remoteSettings
  }

  const mdmResult = getMdmSettings()
  if (Object.keys(mdmResult.settings).length > 0) {
    return mdmResult.settings
  }

  const { settings: fileSettings } = loadManagedFileSettings()
  if (fileSettings) return fileSettings

  const hkcu = getHkcuSettings()
  if (Object.keys(hkcu.settings).length > 0) return hkcu.settings
  return null
}
```

`source` 为 `policySettings` 时，候选顺序固定为 Remote → MDM → managed files → HKCU。MDM 在 macOS 对应 plist，在 Windows 对应 HKLM；文件候选包含 `managed-settings.json` 与 `managed-settings.d/`；HKCU 最低。全部候选为空时返回 `null`，调用方据此跳过 policy merge，前面来源的有效值保持不变。

选中的 policy 随后作为 settings cascade 的最后一层合并，所以它的普通字段优先级最高。但“Remote 和本机 managed file 谁覆盖谁”这个问题本身不成立：只要 Remote 非空，本机候选根本不会参加字段级合并。

还要注意失败边界。`loadSettingsFromDisk()` 会对 Remote 做 schema 校验；Remote 存在但无效时记录错误并继续尝试 MDM，只有通过校验的对象才能成为 winner。

## env 需要经过目录信任才写入进程

如果把 settings 中的 `env` 与 `theme` 一样合并后立刻 `Object.assign(process.env)`，一个刚 clone 的恶意项目就能在信任对话框出现前改写 `ANTHROPIC_BASE_URL`、`PATH` 或 `LD_PRELOAD`。

因此 `restored-src/src/utils/managedEnv.ts` 把环境变量分两阶段应用。信任前只完整接受 user、flag、policy 三个可信来源；project/local 只能贡献安全白名单中的键：

```ts
const TRUSTED_SETTING_SOURCES = [
  'userSettings',
  'flagSettings',
  'policySettings',
] as const

for (const source of TRUSTED_SETTING_SOURCES) {
  if (source === 'policySettings') continue
  if (!isSettingSourceEnabled(source)) continue
  Object.assign(
    process.env,
    filterSettingsEnv(getSettingsForSource(source)?.env),
  )
}

isRemoteManagedSettingsEligible()
Object.assign(
  process.env,
  filterSettingsEnv(getSettingsForSource('policySettings')?.env),
)
```

`TRUSTED_SETTING_SOURCES` 是封闭元组，不含 `projectSettings` 和 `localSettings`。`getSettingsForSource(source)?.env` 可能是 `undefined`，过滤器会把它规范化为空对象。policy 被故意留到最后：程序先应用 user/flag env，计算 Remote managed settings 是否有资格启用，再读取并应用 policy env。这样既让 `CLAUDE_CODE_USE_BEDROCK`、`ANTHROPIC_BASE_URL` 等用户显式路由影响 Remote eligibility，又让最终托管值保持最高优先级。

信任完成后的 `applyConfigEnvironmentVariables()` 才把完整有效 settings 的 env 写入进程，并清理 CA、mTLS、proxy 缓存、重建全局网络 agent。即便如此，`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 等宿主边界仍可让过滤器剥离 provider-routing 变量。配置优先级只是数据顺序，安全边界仍可拒绝某个字段进入副作用层。

## 文件更新会失效缓存，但不会回放整个进程

读取 settings 有三层 session cache：合并结果、按 source 的结果、按路径解析结果。`getInitialSettings()` 命中缓存时不重复做磁盘 I/O；所有入口通过同一个 `resetSettingsCache()` 一起失效。

运行中，`restored-src/src/utils/settings/changeDetector.ts` 用 Chokidar 监听文件，用轮询观察 registry/plist。它故意跳过 `flagSettings`：CLI 临时文件不会变化，而且临时目录可能包含 FIFO、socket 等特殊文件。普通写入还要等待 1000ms 稳定，500ms 轮询；删除则有 `1000 + 500 + 200 = 1700ms` grace，吸收常见的 delete-and-recreate。

变化先执行 `ConfigChange` hook，再进入状态同步：

```ts
void executeConfigChangeHooks(
  settingSourceToConfigChangeSource(source),
  path,
).then(results => {
  if (hasBlockingResult(results)) {
    return
  }
  fanOut(source)
})

function fanOut(source: SettingSource): void {
  resetSettingsCache()
  settingsChanged.emit(source)
}
```

`source` 是五类内部来源；不过文件 watcher 不会产生 `flagSettings` 事件。`path` 是开放文件路径。`hasBlockingResult(results)` 为 `true` 时保留当前 session 状态；为 `false` 时统一清缓存，再通知订阅者。先 reset、后 emit 很重要：第一个 listener 负责重新读盘，后续 listener 直接命中新缓存，避免 N 个订阅者各自清一次缓存。

交互式 `AppStateProvider` 和无头 `runHeadless()` 都订阅这条信号，并调用 `applySettingsChange(source, setAppState)`。后者重新取得有效 settings、磁盘权限规则和 hook snapshot，再更新 `AppState.settings` 与 `toolPermissionContext`。headless 由同一订阅机制获得动态同步，无需 React 设置界面参与。

动态同步覆盖 settings、权限、hook、计划/自动模式转换和有条件的 effort。已经启动的子进程、正在执行的 tool call，以及未订阅刷新信号的既有对象会保持原实例；某个字段从当前任务还是下一轮生效，取决于 consumer 是否在每次使用前重新读取 AppState。

## GrowthBook 走另一套缓存与刷新协议

运行时实验不进入 `SETTING_SOURCES`。启动关键路径常用同步的 `getFeatureValue_CACHED_MAY_BE_STALE()`：

```ts
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  const overrides = getEnvOverrides()
  if (overrides && feature in overrides) return overrides[feature] as T

  const configOverrides = getConfigOverrides()
  if (configOverrides && feature in configOverrides) {
    return configOverrides[feature] as T
  }

  if (!isGrowthBookEnabled()) return defaultValue
  if (remoteEvalFeatureValues.has(feature)) {
    return remoteEvalFeatureValues.get(feature) as T
  }

  const cached = getGlobalConfig().cachedGrowthBookFeatures?.[feature]
  return cached !== undefined ? (cached as T) : defaultValue
}
```

`feature` 是开放字符串 key；`defaultValue` 是调用方提供的泛型回退值，可以是布尔、字符串、数字或对象。优先级是内部环境覆盖 → 内部配置覆盖 → GrowthBook 是否启用 → 进程内 Remote Eval 值 → `~/.claude.json` 磁盘缓存 → `defaultValue`。只有缓存查询得到 `undefined` 才落到默认值，`false`、`0`、空字符串都会原样返回。

前两种 override 还有限制：`CLAUDE_INTERNAL_FC_OVERRIDES` 和 `/config` Gates override 只在 `USER_TYPE === 'ant'` 生效，不能写成面向所有外部用户的公开配置接口。

函数名中的 `MAY_BE_STALE` 是诚实的契约。它为了同步启动路径立即返回，允许读取上个进程留下的磁盘值。远端 payload 成功到达后会同步更新进程 Map 与磁盘，并发出 refresh signal。长期持有 gate 值的系统需要调用 `onGrowthBookRefresh(listener)` 自己重建；每次调用 getter 的热路径天然会读到进程内新值。

源码还保留了 `getFeatureValue_CACHED_WITH_REFRESH(feature, defaultValue, _refreshIntervalMs)`，但 2.1.88 中第三个参数带下划线且完全未使用，函数只是转调 `MAY_BE_STALE`。真正的周期刷新集中在 GrowthBook client：外部构建间隔 6 小时，`ant` 为 20 分钟；定时器会 `unref()`，不会单独阻止进程退出。

## 读配置时，用一张决策表避免串层

遇到“为什么我写了设置却没生效”，可以按执行顺序排查：

| 层 | 要问的问题 | 源码可确认的结果 |
|---|---|---|
| 构建 | 当前能力是否被 `feature()` 包进产物 | 关闭时运行时无法恢复 |
| 来源过滤 | `--setting-sources` 是否允许 user/project/local | flag、policy 始终保留 |
| 文件校验 | 当前来源是否通过 `SettingsSchema()` | 失败记录错误，不合并无效值 |
| Settings merge | 同名字段来自哪一层 | 默认 plugin < user < project < local < flag < policy；前三个可被 `--setting-sources` 筛选、重排；数组例外 |
| Policy 选择 | 哪个管理渠道成为 winner | Remote > MDM > managed file > HKCU，first non-empty wins |
| 信任边界 | env 是否允许写入进程 | 信任前排除 project/local 的危险变量 |
| Runtime gate | GrowthBook 最终取到什么 | override > memory > disk > 调用方 default |
| 动态更新 | consumer 是否订阅并重建 | 不能由 watcher 存在推导所有对象立即更新 |

这张表也给出了静态分析的边界。我们可以从源码证明候选值、先后顺序、缓存失效和调用关系；无法仅凭 source map 证明具体发布构建、企业策略内容、远端实验分桶、网络刷新结果，以及某个长生命周期对象在真实会话里何时被重新创建。

## 小结

Claude Code 的 settings 主链可以压缩成一句话：**先由 CLI 决定允许哪些来源及其普通层顺序，再按低到高深合并，最后让安全边界和具体 consumer 把数据变成行为。**

其中有三个不能混写的例外：数组是拼接去重；policy 内部 first source wins；env 还要经过工作区信任与宿主管理过滤。文件变化会统一清缓存并同步 AppState、权限和 hook，但不承诺重启所有正在运行的对象。

Feature Flags 则有两层：`bun:bundle feature()` 决定代码是否存在，GrowthBook 决定已存在路径此刻是否启用。GrowthBook 的缓存、默认值与刷新信号独立于 settings cascade。把这两层画开以后，“代码里有”“二进制里有”“配置允许”“线上已开”就不再是同一件事。

## 留给下一篇的问题

在 `/config` 中修改配置后，`settings.json` 中的配置也会被同步修改吗？

## 参考资料

- [Claude Code Settings](https://code.claude.com/docs/en/settings)

- [Debug Claude Code Configuration](https://code.claude.com/docs/en/debug-your-config)

- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)

- [Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features)

- [Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)

- [Claude Agent SDK vs Claude Code: when to use which](https://onautopilot.com.au/claude-code/claude-agent-sdk-vs-claude-code-when-to-use-which/)
