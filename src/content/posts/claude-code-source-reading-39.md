---
title: "Claude Code源码解读39：更新、迁移与首次启动如何保持兼容"
published: 2026-07-24T16:47:26+08:00
updated: 2026-07-24T16:47:26+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-39/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：**近来有报道称，Claude Code 的指标上报可能留有后门，甚至被用于识别中国用户；从 2.1.88 的源码中，能看出这类行为吗？**

先给结论：从 2.1.88 的还原源码中，能够确认 Claude Code 存在第一方 analytics/telemetry 上报链路，而且上报字段足以描述运行环境、账号与组织、会话、模型、进程资源以及在开关打开时的工具输入；但看不出一个“专门识别中国用户”的客户端后门。公开报道所指的版本范围是 2.1.91—2.1.196，晚于本系列固定分析的 2.1.88，不能把后续版本的报道直接回填到这里。更不能仅凭客户端静态代码判断服务器收到请求后如何使用 IP、账号或风控规则。

### 2.1.88 确实存在两条上报路径

第一条是第一方事件日志。`initialize1PEventLogging()` 创建独立的 `FirstPartyEventLoggingExporter`，默认把批量事件 POST 到 `https://api.anthropic.com/api/event_logging/batch`；批量失败后会把 JSONL 暂存到本地，再按退避策略重试。`is1PEventLoggingEnabled()` 并不是“是否开启了用户自定义 OpenTelemetry”，而是检查 `isAnalyticsDisabled()`：测试环境、Bedrock、Vertex、Foundry，或隐私级别关闭时才跳过。也就是说，直接 API/OAuth 用户在默认环境下确实有一方事件记录，这一点不能用“没有显式 `CLAUDE_CODE_ENABLE_TELEMETRY`”来否认。

第二条是可配置的 OpenTelemetry。`isTelemetryEnabled()` 只在 `CLAUDE_CODE_ENABLE_TELEMETRY` 为真时返回真，`bootstrapTelemetry()` 再把内部构建时的 `ANT_OTEL_*` 配置映射到标准 `OTEL_*` 变量。它与第一方事件 logger 使用不同的 provider 和 exporter：一个面向 Anthropic 内部事件，另一个面向用户配置的 OTLP endpoint。两者都叫 telemetry，不能混成一条链路。

### 源码实际会带走什么

`getEventMetadata()` 和 `buildEnvContext()` 组装的不是“中国用户”字段，而是一组通用的运行画像：

- 平台及原始 `process.platform`、CPU 架构、Node 版本、终端、已检测到的包管理器与运行时；
- CI/GitHub Actions、WSL 版本、Linux 发行版与内核、VCS、Claude Code 版本、构建时间和部署环境；
- 模型、session ID、交互/客户端类型、订阅档位、Agent/teammate 关联信息，以及经过哈希的仓库 remote（`rh`）；
- `buildProcessMetrics()` 读取 uptime、RSS、heap、external、arrayBuffers、受限内存、CPU 使用量和 CPU 百分比；
- 第一方格式化函数还会把 `accountUuid`、`organizationUuid`，以及用户资料中的 email 放进事件结构。

这些字段当然具有隐私含义，也可以被服务端用于分群或关联；但“能够推断用户属于某个区域”和“客户端代码明确检测中国并触发特殊上报”是两个不同命题。更关键的是，`EnvContext` 中没有国家、地理位置、IP、时区或代理字段，`buildEnvContext()` 也没有读取这些值。对 `China`、`Chinese`、`geolocation`、`Alibaba`、`Beijing`、`prompt steganography` 等专门标记的源码检索，也没有在 telemetry/analytics 这条路径发现对应分支；通用代码里的 `timezone` 命中属于格式化或调度用途，并未进入这套事件环境字段。

工具输入的边界也写在代码里：`extractToolInputForTelemetry()` 只有在 `OTEL_LOG_TOOL_DETAILS` 为真时才序列化输入，随后经过 `truncateToolInputValue()` 和总长度上限截断；默认则返回 `undefined`。这说明“默认不上报工具参数”和“在显式打开详情后可能上报受限参数”必须分开说，不能简单概括成“会上传全部源码”。

### 为什么报道仍然值得核查

新闻报道与研究文章声称，后续的 2.1.91—2.1.196 版本出现过用于识别地理、身份、系统时区、代理或网络特征的机制；报道还转述 Anthropic 将其解释为反滥用实验。这里至少有两个边界：一是这些说法针对的不是 2.1.88，二是新闻是对逆向结果和公司回应的转述，不等于我们已经在本仓库的 2.1.88 源码中复现了同样逻辑。因此，当前证据最多支持“2.1.88 有值得审计的第一方遥测和隐私开关”，不支持“2.1.88 已证实存在识别中国用户的后门”。

还要保留一个静态分析无法消除的盲区。客户端把事件发往可由动态配置改变路径或 base URL 的 exporter；服务器可以根据网络来源、账号或事件组合做二次判断，这些规则不在本地 bundle 中。反过来，看到默认 endpoint、账号字段或 GrowthBook 实验分组，也不能单独把它们定性为后门——需要同时证明隐藏触发条件、未披露的数据用途和绕过用户选择的行为。

如果要验证报道，正确的实验应是：固定 npm 包版本和完整 hash，逐版本 diff `metadata.ts`、第一方 exporter、GrowthBook 配置与网络请求；在隔离环境中抓取实际 POST payload，再分别测试不同账号、时区、代理和出口网络。只有把“客户端采集了什么”“请求发到哪里”和“服务器如何处理”三层证据对齐，才能回答是否存在面向特定地区的后门。

![Claude Code 更新、迁移、Onboarding 与 Workspace Trust 的启动兼容链路](/images/posts/claude-code-source-reading-39/39-updates-migrations-onboarding-handdrawn.png)

## 本章先建立三个概念

- **幂等迁移**：迁移先识别目标状态，重复执行仍得到同一结果，适配中断与多版本跳跃。

- **安装来源**：native、npm、Homebrew 等安装方式决定更新命令、权限与自动更新能力。

- **分阶段发布**：release channel、staging 目录和版本指针把下载、验证与切换拆成可恢复步骤。

![迁移、更新 staging 与版本切换](/images/posts/claude-code-source-reading-39/39-update-staging-detail-handdrawn.png)

先区分“数据已经迁移”“新二进制已经就绪”和“用户已经信任目录”这三个状态，后文的函数分支就有了清晰的先后关系。

## YNM-9527 第一次启动前还没有“事故会话”

用户第一次打开项目，准备输入：

> 请检查项目中的 YNM-9527，查清金额单位问题，修复并运行测试。

在这句话进入 Query Loop 之前，Claude Code 可能先检查版本更新、执行配置迁移、完成认证、询问目录信任并初始化 Plugin 与项目设置。每个步骤都写入自己的状态或缓存；网络中断后，下次启动只重试未完成的门槛，不会把整个 onboarding 当成一次不可分割的动作。

下面从这次首次进入项目的交互开始，追踪状态、动作和门槛如何保持向后兼容。

## 先建立一个简单模型：状态、动作和门槛

更新、迁移和 onboarding 经常被统称为“启动检查”，实际分别处理四类状态。

迁移处理**旧数据结构**：新代码如何解释旧字段，以及某项设置是否已经搬到新位置。更新处理**可执行程序版本**：本机安装形态、远端渠道版本和当前进程的替换权限。Onboarding 处理**用户决策**：主题、认证和安全提示。Trust 处理**目录边界**：这个工作区是否允许启用项目配置、hooks、MCP 与命令执行。

可以压缩成下面这条时序：

```text
读取全局配置
  -> 必要时迁移旧字段并写 migrationVersion
  -> 加载交互入口
  -> 首次使用时完成 onboarding
  -> 确认 workspace trust
  -> 挂载对应安装形态的更新检查器
  -> 进入 REPL
```

这里最容易产生两个误解。

一是混淆 `migrationVersion` 与产品版本。产品版本来自 `MACRO.VERSION`；`migrationVersion` 只记录当前这组同步迁移是否执行过。

二是把更新检查当成启动阻塞步骤。交互式更新组件在挂载后检查，并每 30 分钟再检查一次；网络失败会变成空结果或失败状态。迁移和 trust 才会直接改变后续启动控制流。

## 迁移为什么要在命令执行前完成

如果迁移放在命令执行后，子命令会先按旧字段解释配置，随后才被迫切换语义。`runMigrations()` 位于 `restored-src/src/main.tsx` 的 Commander `preAction` 阶段，默认 REPL 和后续子命令都先经过同一组迁移。

```ts
const CURRENT_MIGRATION_VERSION = 11

function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings()
    migrateBypassPermissionsAcceptedToSettings()
    migrateEnableAllProjectMcpServersToSettings()
    resetProToOpusDefault()
    migrateSonnet1mToSonnet45()
    migrateLegacyOpusToCurrent()
    migrateSonnet45ToSonnet46()
    migrateOpusToOpus1m()
    migrateReplBridgeEnabledToRemoteControlAtStartup()

    saveGlobalConfig(prev =>
      prev.migrationVersion === CURRENT_MIGRATION_VERSION
        ? prev
        : { ...prev, migrationVersion: CURRENT_MIGRATION_VERSION },
    )
  }

  migrateChangelogFromConfig().catch(() => {
    // Silently ignore migration errors - will retry on next startup
  })
}
```

`runMigrations()` 位于 `restored-src/src/main.tsx`，接受零个参数并返回 `void`。`CURRENT_MIGRATION_VERSION` 在这一版本中是数字 `11`，表示整组同步迁移的批次号；本地 `migrationVersion !== 11` 时执行迁移，相等时整段跳过。

这个顺序有意把“写完成标记”放在最后。前面的迁移函数如果同步抛错，标记会保持旧值，下一次启动仍有机会重跑。整组迁移逐项写入，因此每个迁移函数都必须具备重复执行的安全性。

异步的 `migrateChangelogFromConfig()` 采用另一种策略：启动立即继续，失败也保留同步标记；旧字段仍在时，下次启动再次尝试。这里的幂等性来自目标文件的独占创建和旧字段检查。

## 幂等迁移先检查目标状态，再处理旧字段

看一个很典型的字段迁移：旧版本用 `replBridgeEnabled`，新版本改为 `remoteControlAtStartup`。

```ts
export function migrateReplBridgeEnabledToRemoteControlAtStartup(): void {
  saveGlobalConfig(prev => {
    const oldValue =
      (prev as Record<string, unknown>)['replBridgeEnabled']

    if (oldValue === undefined) return prev
    if (prev.remoteControlAtStartup !== undefined) return prev

    const next = {
      ...prev,
      remoteControlAtStartup: Boolean(oldValue),
    }
    delete (next as Record<string, unknown>)['replBridgeEnabled']
    return next
  })
}
```

`migrateReplBridgeEnabledToRemoteControlAtStartup()` 位于 `restored-src/src/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts`，接受零个参数。它把旧字段视为 `unknown`，再用 `Boolean(oldValue)` 收敛成布尔值写入 `remoteControlAtStartup`；该新字段控制后续启动时是否自动进入 Remote Control。

这里有两个明确的停止条件：旧字段为 `undefined` 时跳过迁移；新字段已有值时保留新值并跳过旧值覆盖。显式 `false` 也属于已配置状态。迁移成功后才删除旧字段。

这就是字段迁移最重要的优先级：**显式的新配置高于遗留配置**。使用 `!== undefined` 能把新值 `false` 识别为有效选择，防止旧值反向覆盖。

更早一层的兼容发生在全局配置加载时。`migrateConfigFields()` 把已经从类型中删除的 `autoUpdaterStatus` 映射为新的 `installMethod` 与 `autoUpdates`。

```ts
function migrateConfigFields(config: GlobalConfig): GlobalConfig {
  if (config.installMethod !== undefined) return config

  const legacy = config as GlobalConfig & {
    autoUpdaterStatus?:
      | 'migrated'
      | 'installed'
      | 'disabled'
      | 'enabled'
      | 'no_permissions'
      | 'not_configured'
  }

  let installMethod: InstallMethod = 'unknown'
  let autoUpdates = config.autoUpdates ?? true

  switch (legacy.autoUpdaterStatus) {
    case 'migrated':
      installMethod = 'local'
      break
    case 'installed':
      installMethod = 'native'
      break
    case 'disabled':
      autoUpdates = false
      break
    case 'enabled':
    case 'no_permissions':
    case 'not_configured':
      installMethod = 'global'
      break
  }

  return { ...config, installMethod, autoUpdates }
}
```

`migrateConfigFields(config)` 位于 `restored-src/src/utils/config.ts`。参数 `config` 是读出的 `GlobalConfig`；返回值是内存中的兼容后配置。`installMethod` 已有值时函数原样返回，避免重复解释旧字段。

旧 `autoUpdaterStatus` 的源码可选值有六个：`migrated` 对应本地 npm 安装，`installed` 对应 native，`disabled` 只关闭自动更新但无法确认安装类型，`enabled`、`no_permissions`、`not_configured` 都回退成 global。旧字段缺失时，安装方式保持 `unknown`。`autoUpdates` 若已有 `true` 或 `false` 就保留，只有 `undefined` 才默认成 `true`。

注意，这个函数主要保证**读取兼容**。`getGlobalConfig()` 每次首次加载和后台 freshness watcher 重新读取时都会经过它，但它本身不负责立即把迁移结果写回磁盘。真正的持久化仍由后续 `saveGlobalConfig()` 完成。

## 更新渠道只是第一步，安装归属才决定动作

更新器先读取 `autoUpdatesChannel`。这一设置在 schema 中只有 `latest` 和 `stable` 两个可选值；字段省略时回退到 `latest`。

```ts
export async function getLatestVersion(
  channel: ReleaseChannel,
): Promise<string | null> {
  const npmTag = channel === 'stable' ? 'stable' : 'latest'

  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', `${MACRO.PACKAGE_URL}@${npmTag}`, 'version', '--prefer-online'],
    {
      abortSignal: AbortSignal.timeout(5000),
      cwd: homedir(),
    },
  )

  if (result.code !== 0) {
    // 省略调试日志
    return null
  }
  return result.stdout.trim()
}
```

`getLatestVersion(channel)` 位于 `restored-src/src/utils/autoUpdater.ts`。`channel` 的静态可选值是 `latest | stable`：`stable` 映射到 npm 的 `stable` tag，其余合法分支映射到 `latest`。成功时返回 `stdout.trim()` 得到的版本字符串；进程退出码非零时返回 `null`，调用方据此跳过本轮安装判断，而不能把它记录成“已经是最新版”。

这里还有一个容易忽略的安全细节：`cwd` 显式设为 `homedir()`，所以 `npm view` 在 home 目录运行，避开当前项目里的 `.npmrc` 与它可能指定的 registry。`abortSignal` 则使用 5 秒 `AbortSignal.timeout()`；超时或命令失败都只得到 `null`。

拿到目标版本以后，`AutoUpdater` 还要同时满足四个条件才会安装：自动更新开启、当前版本与目标版本都存在、当前版本低于目标版本、目标版本通过 `minimumVersion` 策略。

```ts
if (
  !isDisabled &&
  currentVersion &&
  latestVersion &&
  !gte(currentVersion, latestVersion) &&
  !shouldSkipVersion(latestVersion)
) {
  const installationType = await getCurrentInstallationType()

  if (installationType === 'npm-local') {
    installStatus = await installOrUpdateClaudePackage(channel)
  } else if (installationType === 'npm-global') {
    installStatus = await installGlobalPackage()
  } else if (installationType === 'development') {
    return
  }

  onAutoUpdaterResult({
    version: latestVersion,
    status: installStatus,
  })
}

useEffect(() => {
  void checkForUpdates()
}, [checkForUpdates])

useInterval(checkForUpdates, 30 * 60 * 1000)
```

这段来自 `restored-src/src/components/AutoUpdater.tsx` 的 `AutoUpdater(props)`。四个条件分别检查是否启用、版本值是否齐全、当前版本是否已达到目标、策略是否跳过目标。`installationType` 选择 npm local、npm global 或 development 分支；`installStatus` 保存安装器终态，随后与 `latestVersion` 组成 `{ version, status }` 交给 `onAutoUpdaterResult`。`props.isUpdating` 用 ref 防止 30 分钟定时器拿到旧闭包并发起重复安装；`onChangeIsUpdating(boolean)` 更新 UI，`autoUpdaterResult` 可以是对象或 `null`，`showSuccessMessage` 和 `verbose` 都是布尔开关。

`InstallStatus` 在这些路径中可出现 `success`、`no_permissions`、`install_failed` 和 `in_progress`。`success` 表示安装器完成；`no_permissions` 提示权限不足；`install_failed` 表示安装失败；`in_progress` 表示另一个安装正在进行。不同安装函数支持的状态子集并不完全相同，例如 local 安装返回 `in_progress | success | install_failed`。

源码还存在两个独立组件：`NativeAutoUpdater` 调用 native installer；`PackageManagerAutoUpdater` 检查版本并展示对应命令。后者对 Homebrew、winget、apk 分别给出 `brew upgrade claude-code`、`winget upgrade Anthropic.ClaudeCode`、`apk upgrade claude-code`，未知包管理器则提示使用自己的更新命令；安装动作仍交给系统包管理器。

## Native 更新为什么要经过 staging、版本目录和软链接

Native 安装不能边下载边覆盖当前正在运行的二进制。`performVersionUpdate()` 先确定 staging 和版本目录，下载完成后安装到目标版本路径，最后再更新 `~/.local/bin/claude` 指向的软链接。

```ts
async function performVersionUpdate(
  version: string,
  forceReinstall: boolean,
): Promise<boolean> {
  const { stagingPath: baseStagingPath, installPath } =
    await getVersionPaths(version)
  const { executable: executablePath } = getBaseDirectories()

  const stagingPath = isEnvTruthy(process.env.ENABLE_LOCKLESS_UPDATES)
    ? `${baseStagingPath}.${process.pid}.${Date.now()}`
    : baseStagingPath

  const needsInstall =
    !(await versionIsAvailable(version)) || forceReinstall

  if (needsInstall) {
    const downloadType = await downloadVersion(version, stagingPath)
    await installVersion(stagingPath, installPath, downloadType)
  }

  await updateSymlink(executablePath, installPath)

  if (!(await isPossibleClaudeBinary(executablePath))) {
    let installPathExists = false
    try {
      await stat(installPath)
      installPathExists = true
    } catch {
      // installPath doesn't exist
    }
    throw new Error(
      `Failed to create executable at ${executablePath}. ` +
        `Source file exists: ${installPathExists}. ` +
        `Check write permissions to ${executablePath}.`,
    )
  }
  return needsInstall
}
```

`performVersionUpdate(version, forceReinstall)` 位于 `restored-src/src/utils/nativeInstaller/installer.ts`。`version` 是来自更新渠道或显式安装目标的开放版本字符串，具体集合由运行时渠道决定。`forceReinstall` 为 `true` 时，即使目标版本已存在也重新下载；为 `false` 时可复用已经可用的版本目录。返回布尔值只表示这次是否实际执行安装，错误通过抛出异常表达。

`ENABLE_LOCKLESS_UPDATES` 为真时，staging 路径加入 PID 和时间戳，避免并发下载踩同一路径；否则上层 `updateLatest()` 使用版本锁并重试三次。锁获取失败时 native 更新返回 `lockFailed`，交互式自动更新静默跳过本轮并等待定时器重试，当前可执行程序继续运行。

此外还有两道版本护栏：服务端 `maxVersion` 可以把目标版本封顶，设置里的 `minimumVersion` 可以跳过低于下限的目标。两者约束更新候选，`migrationVersion` 则控制配置迁移批次。

## 首次启动由条件化步骤组成

同步迁移完成后，默认交互入口才会创建 Ink root 并调用 `showSetupScreens()`。无头模式在调用点就被排除，因此 `claude -p` 不会进入 onboarding 或 trust dialog。

```ts
export async function showSetupScreens(
  root: Root,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  commands?: Command[],
  claudeInChrome?: boolean,
  devChannels?: ChannelEntry[],
): Promise<boolean> {
  const config = getGlobalConfig()
  let onboardingShown = false

  if (!config.theme || !config.hasCompletedOnboarding) {
    onboardingShown = true
    const { Onboarding } = await import('./components/Onboarding.js')
    await showSetupDialog(
      root,
      done => (
        <Onboarding
          onDone={() => {
            completeOnboarding()
            void done()
          }}
        />
      ),
      { onChangeAppState },
    )
  }

  if (!isEnvTruthy(process.env.CLAUBBIT)) {
    if (!checkHasTrustDialogAccepted()) {
      const { TrustDialog } =
        await import('./components/TrustDialog/TrustDialog.js')
      await showSetupDialog(
        root,
        done => <TrustDialog commands={commands} onDone={done} />,
      )
    }
  }

  return onboardingShown
}
```

`showSetupScreens(...)` 位于 `restored-src/src/interactiveHelpers.tsx`。`root` 是 Ink 渲染根；`permissionMode` 是权限模式，具体枚举已在第 12 篇说明。`allowDangerouslySkipPermissions` 为 `true`，或 `permissionMode` 为 `'bypassPermissions'` 时，尚未确认危险模式的会话会显示 `BypassPermissionsModeDialog`；该参数只触发确认流程，workspace trust 仍由独立对话框处理。`commands`、`claudeInChrome`、`devChannels` 都可为 `undefined`，分别影响命令风险检查、Chrome onboarding 和开发 channel 确认。

返回值是 `Promise<boolean>`：本次显示基础 onboarding 时返回 `true`。显示条件同时检查 `hasCompletedOnboarding` 和主题，主题缺失会重新进入，避免残缺配置跳过必要设置。`CLAUBBIT` 环境变量为真时，当前源码会跳过这一段 trust 与相关项目审批；它是显式特殊入口，普通交互模式仍执行审批。

Onboarding 完成时，`completeOnboarding()` 写入两个字段：`hasCompletedOnboarding: true` 和 `lastOnboardingVersion: MACRO.VERSION`。前者控制是否至少展示一次，后者记录完成时的产品版本。

Onboarding 组件会根据认证和终端环境动态组装 `steps`：

```ts
const steps: OnboardingStep[] = []

if (oauthEnabled) {
  steps.push({
    id: 'preflight',
    component: preflightStep,
  })
}

steps.push({
  id: 'theme',
  component: themeStep,
})

if (apiKeyNeedingApproval) {
  steps.push({
    id: 'api-key',
    component: <ApproveApiKey
      customApiKeyTruncated={apiKeyNeedingApproval}
      onDone={handleApiKeyDone} />,
  })
}

if (oauthEnabled) {
  steps.push({
    id: 'oauth',
    component: <SkippableStep
      skip={skipOAuth}
      onSkip={goToNextStep}>
      <ConsoleOAuthFlow onDone={goToNextStep} />
    </SkippableStep>,
  })
}

steps.push({
  id: 'security',
  component: securityStep,
})
```

这段来自 `restored-src/src/components/Onboarding.tsx` 的 `Onboarding({ onDone })`。`steps` 按实际控制流保存步骤对象，每项 `id` 是路由标识，`component` 是对应 Ink 页面；`onDone` 在最后一步结束时调用。`oauthEnabled: true` 会加入 `preflight` 和 `oauth`，为 `false` 时跳过两步；`apiKeyNeedingApproval` 非空时加入 `api-key`。`SkippableStep.skip` 决定 OAuth 页面是否自动略过，`onSkip` 与 `ConsoleOAuthFlow.onDone` 都推进到下一步。

步骤顺序很有意义：先做 preflight，再选主题，再确认环境变量中的 API key 或走 OAuth，随后明确展示安全说明，最后才询问是否修改终端按键配置。终端设置失败被记录后会继续 `goToNextStep()`，所以它属于可跳过的体验增强项。

## setup 卡住通常发生在认证与网络阶段

这部分需要把本地 setup 与网络认证分开看。

`Onboarding` 在 `oauthEnabled` 为真时会加入 preflight 和 OAuth。中国大陆网络环境如果不能直连 Claude 服务，这两步可能无法完成；但主题选择、配置迁移和 workspace trust 都是本地机制。它们不应该被混成一个“setup 失败”。

如果你已经通过受支持的第三方 provider、企业代理或显式 API key 配好认证，`isAnthropicAuthEnabled()` 与 API key 状态会决定是否加入 OAuth 步骤；地理位置字符串不参与这段分支。

对自动化代码阅读，`claude -p` 会绕开整套交互式 setup screens，同时跳过 workspace trust 对话框并把当前非交互环境视作可信。因此这个入口只适合 CI 或明确受控的目录；陌生仓库仍应先经过人工信任检查。

## Workspace Trust 与工具权限是两道门

Onboarding 完成不代表当前仓库可信。`showSetupScreens()` 紧接着单独检查 `checkHasTrustDialogAccepted()`，而且注释明确说明：即便 `permissionMode === 'bypassPermissions'`，交互式 session 也仍要确认 workspace trust。

```ts
function computeTrustDialogAccepted(): boolean {
  if (getSessionTrustAccepted()) return true

  const config = getGlobalConfig()
  const projectPath = getProjectPathForConfig()

  if (config.projects?.[projectPath]?.hasTrustDialogAccepted) {
    return true
  }

  let currentPath = normalizePathForConfigKey(getCwd())
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(
      resolve(currentPath, '..'),
    )
    if (parentPath === currentPath) break
    currentPath = parentPath
  }

  return false
}
```

`computeTrustDialogAccepted()` 位于 `restored-src/src/utils/config.ts`，接受零个参数并返回布尔值。它先看 session 内存标志，再看配置选择的项目路径，最后从当前目录逐级向父目录查找已接受标志；遍历到文件系统根目录仍零命中时返回 `false`。

Trust dialog 给用户的值只有 `enable_all` 和 `exit`。`enable_all` 表示信任当前工作区并继续，`exit` 会以状态码 `1` 退出，取消操作也映射到 `exit`。封闭联合在协议层排除了第三种只读入口。

接受时，如果当前目录正好是 home 目录，信任只写到本次 session 内存；其他目录通过 `saveCurrentProjectConfig()` 持久化。这样不会把整个用户 home 永久登记成一个普通可信项目。

Trust 之所以放在系统上下文、项目 MCP 审批、CLAUDE.md 外部 include 和完整配置环境变量之前，是因为这些行为可能读取项目指令，甚至间接执行命令。第 37 篇看到的 Bridge 也复用了同一边界：未接受目录信任时，headless bridge 会直接拒绝注册远端执行环境。

## 配置写入失败时，为什么不能拿默认值覆盖旧认证

迁移是否安全，最后取决于配置写入。`saveGlobalConfig()` 使用文件锁，在锁内重新读取最新配置，再建立时间戳备份后写回。

```ts
const currentConfig = getConfig(file, createDefault)

if (
  file === getGlobalClaudeFile() &&
  wouldLoseAuthState(currentConfig)
) {
  logEvent('tengu_config_auth_loss_prevented', {})
  return false
}

const mergedConfig = mergeFn(currentConfig)
if (mergedConfig === currentConfig) return false

const MIN_BACKUP_INTERVAL_MS = 60_000
const shouldCreateBackup =
  Number.isNaN(mostRecentTimestamp) ||
  Date.now() - mostRecentTimestamp >= MIN_BACKUP_INTERVAL_MS

if (shouldCreateBackup) {
  fs.copyFileSync(
    file,
    join(backupDir, `${fileBase}.backup.${Date.now()}`),
  )
}

writeFileSyncAndFlush_DEPRECATED(
  file,
  jsonStringify(filteredConfig, null, 2),
  { encoding: 'utf-8', mode: 0o600 },
)
```

这段来自 `restored-src/src/utils/config.ts` 的 `saveConfigWithLock(file, createDefault, mergeFn)`。`currentConfig` 是持锁后重新读取的最新快照；`mergedConfig` 是 `mergeFn(currentConfig)` 的结果，返回同一引用会跳过写入。`MIN_BACKUP_INTERVAL_MS` 固定 60 秒，`shouldCreateBackup` 控制本次是否复制时间戳备份；最终写入固定使用 UTF-8 和 `0o600` 权限。`file` 是目标配置路径，`createDefault()` 提供缺省结构，函数返回布尔值表示是否真的写过。

`wouldLoseAuthState(fresh)` 只保护两类关键状态：缓存里有 `oauthAccount`、新读取却缺失；或缓存里 `hasCompletedOnboarding === true`、新读取却变为假值。命中任意一种都拒绝覆盖，避免并发写入或瞬时损坏把认证和 onboarding 状态清空。

备份至少间隔 60 秒创建一次，并只保留最近 5 份。配置损坏时，`getConfig()` 会把损坏内容单独复制成 `.corrupted.<timestamp>`，向 stderr 告知备份路径，然后回退默认配置。文件完全丢失但存在备份时，它只提示手工恢复命令，不会静默猜测该恢复哪一份。

这是一种很克制的失败回退：更新失败继续使用旧二进制，异步迁移失败下次再试，配置损坏保留证据并回退默认值，关键认证状态疑似丢失则拒绝写回。源码只覆盖这些可恢复路径，其他故障仍需用户或安装器介入。

## 版本状态到底保存了什么

把本章出现的几个版本字段放在一起，就不容易混淆了。

| 状态 | 作用 | 缺失时的行为 |
|---|---|---|
| `MACRO.VERSION` | 当前 Claude Code 产品版本 | 构建期宏，源码路径中直接使用 |
| `migrationVersion` | 已执行的同步迁移批次 | 与 `11` 不同时重跑整组同步迁移 |
| `lastOnboardingVersion` | 最近完成 onboarding 时的产品版本 | 不单独决定当前代码是否展示 onboarding |
| `lastReleaseNotesSeen` | 最近确认看过 release notes 的版本 | 用于决定是否准备 release notes 数据 |
| `autoUpdatesChannel` | 更新渠道 | 省略时查询 `latest` tag |
| `minimumVersion` | 不安装低于该下限的目标 | 省略时 `shouldSkipVersion()` 不应用下限过滤 |
| `maxVersion` | 更新目标的远端封顶值 | 省略时目标版本不经过远端封顶裁剪 |

表里只有 `migrationVersion` 在这一还原版本中有固定值 `11`。

## 小结

Claude Code 的启动兼容由迁移、更新、onboarding 与 workspace trust 共同组成。

同步迁移先用 `migrationVersion` 把旧配置推进到当前语义，单个迁移再通过 `undefined` 检查、显式新值优先和重复执行保护维持幂等。异步迁移不阻塞启动，失败后依靠旧字段仍然存在而在下次启动重试。

更新器把渠道和安装归属分开：`latest | stable` 决定去哪里取版本，native、npm local、npm global、package manager 决定谁有权执行更新。staging、版本锁、软链接验证和失败状态共同保证旧二进制不会因为一次下载失败立刻失效。

Onboarding 负责用户级准备，Workspace Trust 负责项目级信任。`bypassPermissions` 不能替代 trust；`claude -p` 虽然跳过交互屏幕，却意味着调用者自己承担目录可信的前提。

真正的向后兼容依靠四条约束：旧状态可读，新状态优先于旧值，失败能够重试，安全边界必须由正确的人确认。

## 留给下一篇的问题

普通用户能把 Claude Code 更新到内部版本或测试版本（即非 `stable`、`latest` 渠道的版本）吗？

## 参考资料

- [Claude Code Installation and Updates](https://code.claude.com/docs/en/installation)

- [Claude Code Changelog](https://code.claude.com/docs/en/changelog)

- [Claude Code Data Usage](https://code.claude.com/docs/en/data-usage)

- [Claude Code Monitoring](https://code.claude.com/docs/en/monitoring-usage)

- [Telemetry & Privacy — Claude Code v2.1.88 source analysis](https://sanbuphy-claude-code-source-code.mintlify.app/reference/analysis/telemetry-privacy)

- [China warns users of alleged security backdoor vulnerabilities in Claude Code](https://www.techradar.com/pro/china-warns-users-of-alleged-security-backdoor-vulnerabilities-in-anthropics-claude-code-tells-users-to-uninstall-for-sfaety-reasons)

- [Anthropic and China Clash Over Reported Security Risks in Claude Code](https://expertinsights.com/news/anthropic-and-china-clash-over-reported-security-risks-in-claude-code)
