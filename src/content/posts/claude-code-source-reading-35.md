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

上一篇留下的问题是：同一套运行时支持多种入口以后，Claude Code 如何合并用户、项目、本地、策略、CLI 设置与功能开关，并决定最终行为？

先给结论：Claude Code 没有一张“万能配置表”，而是连续做三次裁决。

第一次发生在构建时。`bun:bundle` 的 `feature('VOICE_MODE')`、`feature('BRIDGE_MODE')` 等开关决定一段代码是否进入当前产物。没有进入产物的能力，改 JSON、环境变量或远端实验都无法补回来。

第二次是 settings cascade。默认情况下，插件设置先做最低优先级底座，然后依次合并 `userSettings → projectSettings → localSettings → flagSettings → policySettings`；越靠后的来源覆盖越靠前的普通字段，数组则拼接并去重。`--setting-sources` 不仅可以关掉 user、project、local，它提供的顺序也会成为这三者的遍历顺序；flag 与 policy 总是在其后补入。托管策略内部又不是继续 merge，而是从 Remote、MDM、managed file、HKCU 中选择第一个非空来源。

第三次才是运行时功能开关。GrowthBook getter 按“环境覆盖、内部配置覆盖、进程内远端值、磁盘缓存、调用方默认值”取值。它可以打开或关闭已经存在于构建产物里的路径，却不能改变 settings 的来源优先级。

也就是说，最终行为不是某个文件单独决定的，而是：

`build capability ∩ effective settings ∩ runtime gate ∩ 当前宿主与权限上下文`。

下图的 Settings Cascade 画的是未用 `--setting-sources` 重排时的默认顺序；显式参数怎样改变前三层，会在正文展开。

![Claude Code 配置级联、动态更新与功能开关手绘图](/images/posts/claude-code-source-reading-35/35-settings-config-flags-handdrawn.png)

本文仍以 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码为边界。还原路径用于定位证据，不假定等同于 Anthropic 内部仓库的原始目录。下面的片段只保留证明当前结论的分支，无关字段与错误上报会省略。

## 先分清三类经常被叫作“配置”的东西

工程里最容易出现的误判，是看到一个 `if` 就把它统称为 feature flag。实际上这三类机制的生效时间不同。

`SettingsJson` 是用户、项目、CLI 与管理员提供的数据，例如权限规则、hook、sandbox、model、env。它们先通过 schema 校验，再合成一份有效 settings。

GrowthBook feature 是远端或缓存的运行时值。调用方必须自己提供 `defaultValue`，远端不可用时不会凭空推导一个默认行为。

`feature()` 来自 `bun:bundle`，属于构建能力开关。源码里常用正向三元表达式配合动态 `require()`，让非目标构建连相关模块和实验 key 字符串都能被裁掉。它不是 GrowthBook 的别名。

`restored-src/src/bridge/bridgeEnabled.ts` 把两层 gate 放在了一起：

```ts
export function isBridgeEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() &&
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_bridge', false)
    : false
}
```

`isBridgeEnabled()` 没有参数，返回布尔值。构建开关 `BRIDGE_MODE` 为假时直接返回 `false`，运行时不再读取订阅身份和 GrowthBook。只有构建中包含 Bridge，才继续要求 `isClaudeAISubscriber()` 为真，并读取 `tengu_ccr_bridge`；这个运行时 gate 的明确回退值是 `false`。

这段代码说明了“源码里存在”为什么不等于“当前二进制可用”，也不等于“当前账号已启用”。

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

`eagerLoadSettings()` 没有参数，也没有返回值。`--settings` 缺失或值为空时不创建 flag source；`--setting-sources` 则故意用 `!== undefined` 判断，因此显式传空字符串与完全不传是两种状态：前者表示 user、project、local 一个都不要，后者保留启动状态中的默认来源。

`loadSettingsFromFlag(settingsFile)` 接受开放字符串。首尾去空白后，如果同时以 `{` 开头、以 `}` 结尾，就按内联 JSON 处理；否则按文件路径处理。非法 JSON、文件不存在或读取失败都会打印错误并退出，而不是悄悄退回其他来源。内联 JSON 会写入按内容 hash 命名的临时文件；相同内容保持稳定路径，避免路径进入 Bash tool 描述后反复破坏 API prompt cache。

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

`flag` 是逗号分隔字符串，源码能够确认的合法值只有 `user`、`project`、`local`；空字符串返回空数组，未知值直接抛错。结果中的内部枚举分别是 `userSettings`、`projectSettings`、`localSettings`。重复项在这里不会主动去重，但后续 `getEnabledSettingSources()` 使用 `Set`，并无条件补入 `flagSettings` 与 `policySettings`。

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

`loadSettingsFromDisk()` 没有参数，返回 `{ settings, errors }`。plugin base 是可选值，缺失时从空对象开始；`getEnabledSettingSources()` 返回允许的普通来源以及必选的 flag/policy。每个文件先经 `SettingsSchema()` 校验，合法部分才进入合并；错误会按 `file:path:message` 去重后随结果返回。源码没有把坏文件解释成高优先级的“空配置”，因此它不会替你抹掉前面已经合并成功的来源。

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

`settingsMergeCustomizer(objValue, srcValue)` 接收当前累计值和更高优先级来源值。两者都是数组时，返回“旧数组在前、新数组在后”的去重结果；不是数组时返回 `undefined`，这里的 `undefined` 是明确协议：交回 Lodash 的默认深合并逻辑，不表示把配置字段写成 `undefined`。`null` 没有专门分支，会按默认 merge 语义处理。

因此“高优先级覆盖低优先级”对数组并不准确。权限规则、hook 等数组字段可能累计多个来源的内容；真正的 allow/ask/deny 冲突，还要由第 12 篇讲过的权限引擎解释，不能只凭 settings merge 顺序判断最终授权。

## Flag 层里，SDK inline 又覆盖文件

Flag 并非只有 `--settings path`。SDK 可以把 inline settings 写入 bootstrap state，读取 flag source 时再合并：

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

托管策略的行为与普通来源不同。它不是把四种管理渠道叠加，而是选中第一份非空策略后停止：

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

`source` 为 `policySettings` 时，候选顺序固定为 Remote → MDM → managed files → HKCU。MDM 在 macOS 对应 plist，在 Windows 对应 HKLM；文件候选包含 `managed-settings.json` 与 `managed-settings.d/`；HKCU 最低。全部没有内容时返回 `null`，表示当前没有托管策略，而不是一份会清空前面来源的空对象。

选中的 policy 随后作为 settings cascade 的最后一层合并，所以它的普通字段优先级最高。但“Remote 和本机 managed file 谁覆盖谁”这个问题本身不成立：只要 Remote 非空，本机候选根本不会参加字段级合并。

还要注意失败边界。`loadSettingsFromDisk()` 会对 Remote 做 schema 校验；Remote 存在但无效时记录错误并继续尝试 MDM，而不是把无效对象当成 winner。

## env 不是普通字段：信任决定何时写入进程

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

变化不是立刻生效。它先执行 `ConfigChange` hook：

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

交互式 `AppStateProvider` 和无头 `runHeadless()` 都订阅这条信号，并调用 `applySettingsChange(source, setAppState)`。后者重新取得有效 settings、磁盘权限规则和 hook snapshot，再更新 `AppState.settings` 与 `toolPermissionContext`。因此 headless 并没有因为缺少 React 设置界面就失去动态同步。

但动态同步不是“所有配置立即重放”。源码明确同步了 settings、权限、hook、计划/自动模式转换和有条件的 effort；已经启动的子进程、正在执行的 tool call、已构造但没有订阅刷新信号的对象，不会因为一个 JSON 改动自动重建。某个字段从当前任务还是下一轮生效，要看它的 consumer 是否每次读取 AppState，静态地列出 watcher 并不能一概而论。

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

；`defaultValue` 是调用方提供的泛型回退值，可以是布尔、字符串、数字或对象。优先级是内部环境覆盖 → 内部配置覆盖 → GrowthBook 是否启用 → 进程内 Remote Eval 值 → `~/.claude.json` 磁盘缓存 → `defaultValue`。只有值为 `undefined` 才落到默认值，缓存中的 `false`、`0`、空字符串都属于有效结果。

前两种 override 还有限制：`CLAUDE_INTERNAL_FC_OVERRIDES` 和 `/config` Gates override 只在 `USER_TYPE === 'ant'` 生效，不能写成面向所有外部用户的公开配置接口。

函数名中的 `MAY_BE_STALE` 是诚实的契约。它为了同步启动路径立即返回，允许读取上个进程留下的磁盘值。远端 payload 成功到达后会同步更新进程 Map 与磁盘，并发出 refresh signal。长期持有 gate 值的系统需要调用 `onGrowthBookRefresh(listener)` 自己重建；每次调用 getter 的热路径天然会读到进程内新值。

源码还保留了 `getFeatureValue_CACHED_WITH_REFRESH(feature, defaultValue, _refreshIntervalMs)`，但 2.1.88 中第三个参数带下划线且完全未使用，函数只是转调 `MAY_BE_STALE`。真正的周期刷新集中在 GrowthBook client：外部构建间隔 6 小时，`ant` 为 20 分钟；定时器会 `unref()`，不会单独阻止进程退出。。

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

配置确定以后，Claude Code 如何选择模型、处理认证，并在 Anthropic、Bedrock、Vertex 与 Foundry 等 provider 之间适配请求？

