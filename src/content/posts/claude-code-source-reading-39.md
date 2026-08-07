---
title: "Claude Code源码解读39：更新、迁移与首次启动如何保持兼容"
published: 2026-07-24T16:47:26+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-39/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇留下的问题是，**近来有报道称，Claude Code 的指标上报可能留有后门，甚至被用于识别中国用户；从 2.1.88 的源码中，能看出这类行为吗？**

答案先放在前面，从 2.1.88 的还原源码中，能够确认 Claude Code 存在第一方 analytics/telemetry 上报链路，而且上报字段足以描述运行环境、账号与组织、会话、模型、进程资源以及在开关打开时的工具输入；但看不出一个“专门识别中国用户”的客户端后门。公开报道所指的版本范围是 2.1.91，2.1.196，晚于本系列固定分析的 2.1.88，不能把后续版本的报道直接回填到这里。更不能仅凭客户端静态代码判断服务器收到请求后如何使用 IP、账号或风控规则。

### 2.1.88 确实存在两条上报路径

第一条是第一方事件日志。`initialize1PEventLogging()` 创建独立的 `FirstPartyEventLoggingExporter`，默认把批量事件 POST 到 `https://api.anthropic.com/api/event_logging/batch`；批量失败后会把 JSONL 暂存到本地，再按退避策略重试。`is1PEventLoggingEnabled()` 检查的是 `isAnalyticsDisabled()`，不是用户自定义 OpenTelemetry 开关。测试环境、Bedrock、Vertex、Foundry，或隐私级别关闭时才跳过。也就是说，直接 API/OAuth 用户在默认环境下确实有一方事件记录，这一点不能用“没有显式 `CLAUDE_CODE_ENABLE_TELEMETRY`”来否认。

第二条是可配置的 OpenTelemetry。`isTelemetryEnabled()` 只在 `CLAUDE_CODE_ENABLE_TELEMETRY` 为真时返回真，`bootstrapTelemetry()` 再把内部构建时的 `ANT_OTEL_*` 配置映射到标准 `OTEL_*` 变量。它与第一方事件 logger 使用不同的 provider 和 exporter，一个面向 Anthropic 内部事件，另一个面向用户配置的 OTLP endpoint。两者都叫 telemetry，不能混成一条链路。

### 源码实际会带走什么

`getEventMetadata()` 和 `buildEnvContext()` 组装的是一组通用的运行画像，不是“中国用户”字段，

- 平台及原始 `process.platform`、CPU 架构、Node 版本、终端、已检测到的包管理器与运行时；
- CI/GitHub Actions、WSL 版本、Linux 发行版与内核、VCS、Claude Code 版本、构建时间和部署环境；
- 模型、session ID、交互/客户端类型、订阅档位、Agent/teammate 关联信息，以及经过哈希的仓库 remote（`rh`）；
- `buildProcessMetrics()` 读取 uptime、RSS、heap、external、arrayBuffers、受限内存、CPU 使用量和 CPU 百分比；
- 第一方格式化函数还会把 `accountUuid`、`organizationUuid`，以及用户资料中的 email 放进事件结构。

这些字段当然具有隐私含义，也可以被服务端用于分群或关联；但“能够推断用户属于某个区域”和“客户端代码明确检测中国并触发特殊上报”是两个不同命题。更关键的是，`EnvContext` 中没有国家、地理位置、IP、时区或代理字段，`buildEnvContext()` 也没有读取这些值。对 `China`、`Chinese`、`geolocation`、`Alibaba`、`Beijing`、`prompt steganography` 等专门标记的源码检索，也没有在 telemetry/analytics 这条路径发现对应分支；通用代码里的 `timezone` 命中属于格式化或调度用途，并未进入这套事件环境字段。

工具输入的边界也写在代码里，`extractToolInputForTelemetry()` 只有在 `OTEL_LOG_TOOL_DETAILS` 为真时才序列化输入，随后经过 `truncateToolInputValue()` 和总长度上限截断；默认则返回 `undefined`。这说明“默认不上报工具参数”和“在显式打开详情后可能上报受限参数”必须分开说，不能简单概括成“会上传全部源码”。

### 为什么报道仍然值得核查

新闻报道与研究文章声称，后续的 2.1.91，2.1.196 版本出现过用于识别地理、身份、系统时区、代理或网络特征的机制；报道还转述 Anthropic 将其解释为反滥用实验。这里至少有两个边界，一是这些说法针对的不是 2.1.88，二是新闻是对逆向结果和公司回应的转述，不等于我们已经在本仓库的 2.1.88 源码中复现了同样逻辑。因此，当前证据最多支持“2.1.88 有值得审计的第一方遥测和隐私开关”，不支持“2.1.88 已证实存在识别中国用户的后门”。

还要保留一个静态分析无法消除的盲区。客户端把事件发往可由动态配置改变路径或 base URL 的 exporter；服务器可以根据网络来源、账号或事件组合做二次判断，这些规则不在本地 bundle 中。反过来，看到默认 endpoint、账号字段或 GrowthBook 实验分组，也不能单独把它们定性为后门，需要同时证明隐藏触发条件、未披露的数据用途和绕过用户选择的行为。

如果要验证报道，正确的实验应是，固定 npm 包版本和完整 hash，逐版本 diff `metadata.ts`、第一方 exporter、GrowthBook 配置与网络请求；在隔离环境中抓取实际 POST payload，再分别测试不同账号、时区、代理和出口网络。只有把“客户端采集了什么”“请求发到哪里”和“服务器如何处理”三层证据对齐，才能回答是否存在面向特定地区的后门。

![Claude Code 更新、迁移、Onboarding 与 Workspace Trust 的启动兼容链路](/images/posts/claude-code-source-reading-39/39-updates-migrations-onboarding-handdrawn.png)

## 介绍本章的一些概念

- 启动兼容由四件事组成，各管一类状态，**迁移**处理旧数据结构（`migrationVersion` 批次号），**更新**处理可执行程序版本（安装形态决定动作），**Onboarding** 处理用户决策（主题、认证、安全提示），**Trust** 处理目录边界（是否允许项目配置、hooks、MCP 与命令执行）。
- 同步迁移在 Commander `preAction` 阶段执行，**写完成标记放在最后**，`CURRENT_MIGRATION_VERSION = 11`，本地不一致时整组重跑；前面的迁移函数同步抛错时标记保持旧值，下次启动仍有重试机会。异步迁移（如 changelog）不阻塞启动，失败后靠旧字段仍在而重试。
- 幂等迁移的规则是**显式的新配置高于遗留配置**，`migrateReplBridgeEnabledToRemoteControlAtStartup()` 用 `!== undefined` 检查新字段，新值 `false` 也是有效选择，防止旧值反向覆盖；迁移成功后才删除旧字段。
- 更新器把**渠道与安装归属分开**，`autoUpdatesChannel` 只有 `latest | stable`，`getLatestVersion()` 用 `npm view`（`cwd: homedir()` 避开项目 `.npmrc`）；`AutoUpdater` 满足四条件才安装，再按 `npm-local / npm-global / development` 分派安装器。native 更新经过 staging、版本目录和软链接三步，`ENABLE_LOCKLESS_UPDATES` 时 staging 路径加 PID+时间戳。
- 配置写入有**保护认证状态的失败回退**，`saveConfigWithLock()` 持锁重读最新配置、60 秒间隔建时间戳备份、`0o600` 权限写入；`wouldLoseAuthState()` 在缓存有 `oauthAccount` 而新读缺失、或 `hasCompletedOnboarding` 从 true 变假值时拒绝覆盖。

> ⚠️ **证据边界**，本文所有代码来自 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` source map 还原源码。`restored-src/` 只用于定位证据，不等同于 Anthropic 内部仓库原始目录；代码块只保留证明控制流所需的字段，`// ...` 表示省略埋点、UI 消息与无关分支。

## 本篇新增机制

38 解释了观测与诊断。本篇回答"版本演进"的问题，**新代码怎样解释旧字段、怎样替换旧二进制、怎样把新用户领进门？** 它把迁移、更新、onboarding 与 workspace trust 拆成四类状态机，并给出"旧状态可读、新状态优先、失败可重试、安全边界由正确的人确认"四条兼容约束。读懂这篇，就能区分 `migrationVersion`（迁移批次）与 `MACRO.VERSION`（产品版本），也不会把"更新检查失败"误当成启动故障。它是系列 Phase 4 的收尾，前面所有章节的能力都以"能安全升级到新版本"为前提。

## 问题现场

一次升级可能同时面对三种输入，磁盘上的旧 `GlobalConfig` 字段（`replBridgeEnabled`、`autoUpdaterStatus`）、一个正在运行的旧二进制（更新器不能边下载边覆盖自己）、以及一个从未使用过本工具的新用户（要先认证、选主题、确认信任）。若迁移放在命令执行后，子命令会先按旧字段解释配置再被迫切换语义；若更新失败就删掉旧版本，用户会陷入"什么都没有"的中间态；若 onboarding 把每个步骤当成不可分割的整体，网络中断后就要从头再来。

![迁移、更新 staging 与版本切换](/images/posts/claude-code-source-reading-39/39-update-staging-detail-handdrawn.png)

本文先建立三个概念，**幂等迁移**（迁移先识别目标状态，重复执行仍得到同一结果，适配中断与多版本跳跃）、**安装来源**（native、npm、Homebrew 等安装方式决定更新命令、权限与自动更新能力）、**分阶段发布**（release channel、staging 目录和版本指针把下载、验证与切换拆成可恢复步骤）。先区分"数据已经迁移""新二进制已经就绪"和"用户已经信任目录"这三个状态，后文的函数分支就有了清晰的先后关系。

## 正文

### 这张金额单位工单第一次启动前还没有"事故会话"

一位刚加入支付值班组的工程师第一次把仓库克隆到本机，打开目录后准备输入，

> 请检查支付服务中的金额单位工单，查清结算页 99.90 元与回调 9991 分的差异；先给证据和计划，确认后修复并运行测试。

但这句话还没有进入 Query Loop。Claude Code 先检查版本更新，发现旧 settings 需要迁移；随后要求完成认证，询问是否信任这个项目目录，并初始化 Plugin 与项目设置。工程师在"是否允许项目 Hook 和 MCP"这一步停了几秒，因为这决定后面的调查会看到哪些能力。

每个步骤都写入自己的状态或缓存；网络中断后，下次启动只重试未完成的门槛，不会把整个 onboarding 当成一次不可分割的动作。

### 先建立一个简单模型｜状态、动作和门槛

更新、迁移和 onboarding 经常被统称为"启动检查"，实际分别处理四类状态。迁移处理**旧数据结构**；更新处理**可执行程序版本**；Onboarding 处理**用户决策**；Trust 处理**目录边界**。

```text
读取全局配置
  -> 必要时迁移旧字段并写 migrationVersion
  -> 加载交互入口
  -> 首次使用时完成 onboarding
  -> 确认 workspace trust
  -> 挂载对应安装形态的更新检查器
  -> 进入 REPL
```

这里最容易产生两个误解。一是混淆 `migrationVersion` 与产品版本，产品版本来自 `MACRO.VERSION`；`migrationVersion` 只记录当前这组同步迁移是否执行过。二是把更新检查当成启动阻塞步骤，交互式更新组件在挂载后检查，并每 30 分钟再检查一次；网络失败会变成空结果或失败状态。迁移和 trust 才会直接改变后续启动控制流。

### 迁移为什么要在命令执行前完成

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

> 证据，`restored-src/src/main.tsx`（2.1.88 source map 还原源码），`runMigrations()`。

`runMigrations()` 位于 `restored-src/src/main.tsx`，接受零个参数并返回 `void`。`CURRENT_MIGRATION_VERSION` 在这一版本中是数字 `11`，表示整组同步迁移的批次号；本地 `migrationVersion !== 11` 时执行迁移，相等时整段跳过。

这个顺序有意把"写完成标记"放在最后。前面的迁移函数如果同步抛错，标记会保持旧值，下一次启动仍有机会重跑。整组迁移逐项写入，因此每个迁移函数都必须具备重复执行的安全性。

异步的 `migrateChangelogFromConfig()` 采用另一种策略，启动立即继续，失败也保留同步标记；旧字段仍在时，下次启动再次尝试。这里的幂等性来自目标文件的独占创建和旧字段检查。

### 幂等迁移先检查目标状态，再处理旧字段

看一个很典型的字段迁移，旧版本用 `replBridgeEnabled`，新版本改为 `remoteControlAtStartup`。

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

> 证据，`restored-src/src/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts`（2.1.88 source map 还原源码）。

`migrateReplBridgeEnabledToRemoteControlAtStartup()` 位于 `restored-src/src/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts`，接受零个参数。它把旧字段视为 `unknown`，再用 `Boolean(oldValue)` 收敛成布尔值写入 `remoteControlAtStartup`；该新字段控制后续启动时是否自动进入 Remote Control。

这里有两个明确的停止条件，旧字段为 `undefined` 时跳过迁移；新字段已有值时保留新值并跳过旧值覆盖。显式 `false` 也属于已配置状态。迁移成功后才删除旧字段。

这就是字段迁移最重要的优先级，**显式的新配置高于遗留配置**。使用 `!== undefined` 能把新值 `false` 识别为有效选择，防止旧值反向覆盖。

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

> 证据，`restored-src/src/utils/config.ts`（2.1.88 source map 还原源码），`migrateConfigFields()`。

`migrateConfigFields(config)` 位于 `restored-src/src/utils/config.ts`。参数 `config` 是读出的 `GlobalConfig`；返回值是内存中的兼容后配置。`installMethod` 已有值时函数原样返回，避免重复解释旧字段。

旧 `autoUpdaterStatus` 的源码可选值有六个，`migrated` 对应本地 npm 安装，`installed` 对应 native，`disabled` 只关闭自动更新但无法确认安装类型，`enabled`、`no_permissions`、`not_configured` 都回退成 global。旧字段缺失时，安装方式保持 `unknown`。`autoUpdates` 若已有 `true` 或 `false` 就保留，只有 `undefined` 才默认成 `true`。

注意，这个函数主要保证**读取兼容**。`getGlobalConfig()` 每次首次加载和后台 freshness watcher 重新读取时都会经过它，但它本身不负责立即把迁移结果写回磁盘。真正的持久化仍由后续 `saveGlobalConfig()` 完成。

### 更新渠道只是第一步，安装归属才决定动作

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

> 证据，`restored-src/src/utils/autoUpdater.ts`（2.1.88 source map 还原源码），`getLatestVersion()`。

`getLatestVersion(channel)` 位于 `restored-src/src/utils/autoUpdater.ts`。`channel` 的静态可选值是 `latest | stable`，`stable` 映射到 npm 的 `stable` tag，其余合法分支映射到 `latest`。成功时返回 `stdout.trim()` 得到的版本字符串；进程退出码非零时返回 `null`，调用方据此跳过本轮安装判断，而不能把它记录成"已经是最新版"。

这里还有一个容易忽略的安全细节，`cwd` 显式设为 `homedir()`，所以 `npm view` 在 home 目录运行，避开当前项目里的 `.npmrc` 与它可能指定的 registry。`abortSignal` 则使用 5 秒 `AbortSignal.timeout()`；超时或命令失败都只得到 `null`。

拿到目标版本以后，`AutoUpdater` 还要同时满足四个条件才会安装，自动更新开启、当前版本与目标版本都存在、当前版本低于目标版本、目标版本通过 `minimumVersion` 策略。

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

> 证据，`restored-src/src/components/AutoUpdater.tsx`（2.1.88 source map 还原源码），`AutoUpdater(props)`。

四个条件分别检查是否启用、版本值是否齐全、当前版本是否已达到目标、策略是否跳过目标。`installationType` 选择 npm local、npm global 或 development 分支；`installStatus` 保存安装器终态，随后与 `latestVersion` 组成 `{ version, status }` 交给 `onAutoUpdaterResult`。`props.isUpdating` 用 ref 防止 30 分钟定时器拿到旧闭包并发起重复安装；`onChangeIsUpdating(boolean)` 更新 UI，`autoUpdaterResult` 可以是对象或 `null`，`showSuccessMessage` 和 `verbose` 都是布尔开关。

`InstallStatus` 在这些路径中可出现 `success`、`no_permissions`、`install_failed` 和 `in_progress`。`success` 表示安装器完成；`no_permissions` 提示权限不足；`install_failed` 表示安装失败；`in_progress` 表示另一个安装正在进行。不同安装函数支持的状态子集并不完全相同，例如 local 安装返回 `in_progress | success | install_failed`。

源码还存在两个独立组件，`NativeAutoUpdater` 调用 native installer；`PackageManagerAutoUpdater` 检查版本并展示对应命令。后者对 Homebrew、winget、apk 分别给出 `brew upgrade claude-code`、`winget upgrade Anthropic.ClaudeCode`、`apk upgrade claude-code`，未知包管理器则提示使用自己的更新命令；安装动作仍交给系统包管理器。

### Native 更新为什么要经过 staging、版本目录和软链接

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

> 证据，`restored-src/src/utils/nativeInstaller/installer.ts`（2.1.88 source map 还原源码），`performVersionUpdate()`。

`performVersionUpdate(version, forceReinstall)` 位于 `restored-src/src/utils/nativeInstaller/installer.ts`。`version` 是来自更新渠道或显式安装目标的开放版本字符串，具体集合由运行时渠道决定。`forceReinstall` 为 `true` 时，即使目标版本已存在也重新下载；为 `false` 时可复用已经可用的版本目录。返回布尔值只表示这次是否实际执行安装，错误通过抛出异常表达。

`ENABLE_LOCKLESS_UPDATES` 为真时，staging 路径加入 PID 和时间戳，避免并发下载踩同一路径；否则上层 `updateLatest()` 使用版本锁并重试三次。锁获取失败时 native 更新返回 `lockFailed`，交互式自动更新静默跳过本轮并等待定时器重试，当前可执行程序继续运行。

此外还有两道版本护栏，服务端 `maxVersion` 可以把目标版本封顶，设置里的 `minimumVersion` 可以跳过低于下限的目标。两者约束更新候选，`migrationVersion` 则控制配置迁移批次。

### 首次启动由条件化步骤组成

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

> 证据，`restored-src/src/interactiveHelpers.tsx`（2.1.88 source map 还原源码），`showSetupScreens()`。

`showSetupScreens(...)` 位于 `restored-src/src/interactiveHelpers.tsx`。`root` 是 Ink 渲染根；`permissionMode` 是权限模式，具体枚举已在第 12 篇说明。`allowDangerouslySkipPermissions` 为 `true`，或 `permissionMode` 为 `'bypassPermissions'` 时，尚未确认危险模式的会话会显示 `BypassPermissionsModeDialog`；该参数只触发确认流程，workspace trust 仍由独立对话框处理。`commands`、`claudeInChrome`、`devChannels` 都可为 `undefined`，分别影响命令风险检查、Chrome onboarding 和开发 channel 确认。

返回值是 `Promise<boolean>`，本次显示基础 onboarding 时返回 `true`。显示条件同时检查 `hasCompletedOnboarding` 和主题，主题缺失会重新进入，避免残缺配置跳过必要设置。`CLAUBBIT` 环境变量为真时，当前源码会跳过这一段 trust 与相关项目审批；它是显式特殊入口，普通交互模式仍执行审批。

Onboarding 完成时，`completeOnboarding()` 写入两个字段，`hasCompletedOnboarding: true` 和 `lastOnboardingVersion: MACRO.VERSION`。前者控制是否至少展示一次，后者记录完成时的产品版本。

Onboarding 组件会根据认证和终端环境动态组装 `steps`，

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

> 证据，`restored-src/src/components/Onboarding.tsx`（2.1.88 source map 还原源码），`Onboarding({ onDone })`。

`steps` 按实际控制流保存步骤对象，每项 `id` 是路由标识，`component` 是对应 Ink 页面；`onDone` 在最后一步结束时调用。`oauthEnabled: true` 会加入 `preflight` 和 `oauth`，为 `false` 时跳过两步；`apiKeyNeedingApproval` 非空时加入 `api-key`。`SkippableStep.skip` 决定 OAuth 页面是否自动略过，`onSkip` 与 `ConsoleOAuthFlow.onDone` 都推进到下一步。

步骤顺序很有意义，先做 preflight，再选主题，再确认环境变量中的 API key 或走 OAuth，随后明确展示安全说明，最后才询问是否修改终端按键配置。终端设置失败被记录后会继续 `goToNextStep()`，所以它属于可跳过的体验增强项。

### setup 卡住通常发生在认证与网络阶段

这部分需要把本地 setup 与网络认证分开看。`Onboarding` 在 `oauthEnabled` 为真时会加入 preflight 和 OAuth。中国大陆网络环境如果不能直连 Claude 服务，这两步可能无法完成；但主题选择、配置迁移和 workspace trust 都是本地机制。它们不应该被混成一个"setup 失败"。

如果你已经通过受支持的第三方 provider、企业代理或显式 API key 配好认证，`isAnthropicAuthEnabled()` 与 API key 状态会决定是否加入 OAuth 步骤；地理位置字符串不参与这段分支。

对自动化代码阅读，`claude -p` 会绕开整套交互式 setup screens，同时跳过 workspace trust 对话框并把当前非交互环境视作可信。因此这个入口只适合 CI 或明确受控的目录；陌生仓库仍应先经过人工信任检查。

### Workspace Trust 与工具权限是两道门

Onboarding 完成不代表当前仓库可信。`showSetupScreens()` 紧接着单独检查 `checkHasTrustDialogAccepted()`，而且注释明确说明，即便 `permissionMode === 'bypassPermissions'`，交互式 session 也仍要确认 workspace trust。

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

> 证据，`restored-src/src/utils/config.ts`（2.1.88 source map 还原源码），`computeTrustDialogAccepted()`。

`computeTrustDialogAccepted()` 位于 `restored-src/src/utils/config.ts`，接受零个参数并返回布尔值。它先看 session 内存标志，再看配置选择的项目路径，最后从当前目录逐级向父目录查找已接受标志；遍历到文件系统根目录仍零命中时返回 `false`。

Trust dialog 给用户的值只有 `enable_all` 和 `exit`。`enable_all` 表示信任当前工作区并继续，`exit` 会以状态码 `1` 退出，取消操作也映射到 `exit`。封闭联合在协议层排除了第三种只读入口。

接受时，如果当前目录正好是 home 目录，信任只写到本次 session 内存；其他目录通过 `saveCurrentProjectConfig()` 持久化。这样不会把整个用户 home 永久登记成一个普通可信项目。

Trust 之所以放在系统上下文、项目 MCP 审批、CLAUDE.md 外部 include 和完整配置环境变量之前，是因为这些行为可能读取项目指令，甚至间接执行命令。第 37 篇看到的 Bridge 也复用了同一边界，未接受目录信任时，headless bridge 会直接拒绝注册远端执行环境。

### 配置写入失败时，为什么不能拿默认值覆盖旧认证

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

> 证据，`restored-src/src/utils/config.ts`（2.1.88 source map 还原源码），`saveConfigWithLock()`。

`currentConfig` 是持锁后重新读取的最新快照；`mergedConfig` 是 `mergeFn(currentConfig)` 的结果，返回同一引用会跳过写入。`MIN_BACKUP_INTERVAL_MS` 固定 60 秒，`shouldCreateBackup` 控制本次是否复制时间戳备份；最终写入固定使用 UTF-8 和 `0o600` 权限。`file` 是目标配置路径，`createDefault()` 提供缺省结构，函数返回布尔值表示是否真的写过。

`wouldLoseAuthState(fresh)` 只保护两类关键状态，缓存里有 `oauthAccount`、新读取却缺失；或缓存里 `hasCompletedOnboarding === true`、新读取却变为假值。命中任意一种都拒绝覆盖，避免并发写入或瞬时损坏把认证和 onboarding 状态清空。

备份至少间隔 60 秒创建一次，并只保留最近 5 份。配置损坏时，`getConfig()` 会把损坏内容单独复制成 `.corrupted.<timestamp>`，向 stderr 告知备份路径，然后回退默认配置。文件完全丢失但存在备份时，它只提示手工恢复命令，不会静默猜测该恢复哪一份。

这是一种很克制的失败回退，更新失败继续使用旧二进制，异步迁移失败下次再试，配置损坏保留证据并回退默认值，关键认证状态疑似丢失则拒绝写回。源码只覆盖这些可恢复路径，其他故障仍需用户或安装器介入。

### 版本状态到底保存了什么

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

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码，行号以当前仓库为准。

| 机制 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| 迁移批次 | `runMigrations()` / `CURRENT_MIGRATION_VERSION = 11` | `src/main.tsx` | 已确认 |
| 字段迁移 | `migrateReplBridgeEnabledToRemoteControlAtStartup()` | `src/migrations/` | 已确认 |
| 读取兼容 | `migrateConfigFields()` 六态映射 | `src/utils/config.ts` | 已确认 |
| 渠道查询 | `getLatestVersion()`（npm view + homedir cwd） | `src/utils/autoUpdater.ts` | 已确认 |
| 安装分派 | `AutoUpdater` 四条件 + 三安装类型 | `src/components/AutoUpdater.tsx` | 已确认 |
| Native 更新 | `performVersionUpdate()` staging/install/symlink | `src/utils/nativeInstaller/installer.ts` | 已确认 |
| 首启步骤 | `showSetupScreens()` 条件化 onboarding/trust | `src/interactiveHelpers.tsx` | 已确认 |
| Onboarding | `steps` 动态组装（preflight/theme/api-key/oauth/security） | `src/components/Onboarding.tsx` | 已确认 |
| Trust | `computeTrustDialogAccepted()` 逐级父目录查找 | `src/utils/config.ts` | 已确认 |
| 安全写入 | `saveConfigWithLock()` / `wouldLoseAuthState()` | `src/utils/config.ts` | 已确认 |

> 证据说明，同步迁移先于命令执行（`preAction`）、写标记放最后、单个迁移幂等（`main.tsx`、`src/migrations/`）；更新与迁移是两条独立管线，`migrationVersion` 管配置数据，版本护栏管二进制候选（`autoUpdater.ts`、`installer.ts`）。

## 设计决策｜为什么迁移幂等、更新分阶段、写入保护认证

源码里找不到官方选型记录，下面的判断来自代码结构，属于解释而非官方声明。

**第一，为什么迁移必须幂等且写标记放在最后？** 一次启动可能在任何迁移函数中间崩溃或被杀。若标记先写，崩溃后下次启动会跳过未完成的迁移，旧字段与新语义并存；若每个迁移函数自身幂等（先查目标状态再处理旧字段）且标记最后写，任何中断都只是"下次重跑整组"。这是用"可重试"换取"无中间态"。

**第二，为什么更新走 staging → 版本目录 → 软链接三步？** 正在运行的二进制不能被覆盖，Windows 甚至不允许删除正在执行的 exe。staging 先放下载产物，install 落到带版本号的独立目录，最后才原子切换软链接；`ENABLE_LOCKLESS_UPDATES` 用 PID+时间戳避免并发下载踩同一路径。任一步失败，旧版本与旧软链接都原样保留，用户继续用旧版。

**第三，为什么 trust 与权限是两道门？** `permissionMode === 'bypassPermissions'` 只改变工具权限的裁决方式，不改变"这个目录是否可信"的判断。项目目录可能携带 hooks、MCP 配置、CLAUDE.md 外部 include，这些在权限引擎介入之前就可能执行；trust 是目录级前提，权限是工具级前提。两者不可互相替代。

**第四，为什么配置写入要保护认证状态？** 并发进程或瞬时损坏可能让新读取的配置"看起来没有 oauthAccount"。若直接拿这份配置覆盖，用户的登录状态就永久丢失且无备份可救。`wouldLoseAuthState()` 的拒绝覆盖 + 60 秒间隔备份 + `.corrupted.<timestamp>` 留证，是"宁可这次不写，也不可破坏认证"的保守策略。

## 练习｜在真实会话里观察启动兼容

1. **观察 `migrationVersion`。** 用文本编辑器打开 `~/.claude.json`，记录当前的 `migrationVersion`；把它临时改成 `10` 后启动 Claude Code，观察启动日志中迁移函数执行与 `migrationVersion` 回写到 `11`。完成后再改回原值（或删除该字段，观察重跑路径）。

2. **观察更新检查的节奏。** 开启 debug 日志观察 `getLatestVersion()` 的 `npm view` 调用（注意 `cwd: homedir()` 与 5 秒超时）；把网络断开后重启，观察更新检查变成 `null` 而不阻塞启动，更新失败不是启动故障。

3. **验证 trust 的父目录继承。** 在已信任目录的子目录里启动 `claude`，观察 `computeTrustDialogAccepted()` 的逐级查找不会再次弹窗；在 home 目录接受信任，确认只写入 session 内存而不持久化到 `projects`。

## 自测

1. `migrationVersion` 与 `MACRO.VERSION` 有什么区别？
2. 为什么同步迁移要把"写完成标记"放在最后？
3. `performVersionUpdate()` 为什么先下载到 staging 而不是直接覆盖安装路径？
4. `wouldLoseAuthState()` 保护哪两类状态？

<details>
<summary>参考答案</summary>

1. **`MACRO.VERSION` 是当前产品版本**（构建期宏，源码路径中直接使用）；**`migrationVersion` 只记录当前这组同步迁移是否执行过**，在这一还原版本中的固定值是 `11`。混淆两者会把"数据还没迁移"误判成"产品版本不对"。

2. **因为中断安全。** 前面的迁移函数如果同步抛错，标记会保持旧值，下一次启动仍有机会重跑整组。若标记先写，崩溃后下次启动会跳过未完成的迁移，旧字段与新语义并存（`runMigrations()`）。

3. **因为正在运行的二进制不能被边下载边覆盖。** staging 先放下载产物，`installVersion()` 落到带版本号的独立目录，最后 `updateSymlink()` 原子切换软链接；`ENABLE_LOCKLESS_UPDATES` 用 PID+时间戳避免并发下载踩同一路径。任一步失败，旧版本与旧软链接都原样保留。

4. **缓存里有 `oauthAccount`、新读取却缺失**，以及**缓存里 `hasCompletedOnboarding === true`、新读取却变为假值**。命中任意一种都拒绝覆盖并记录 `tengu_config_auth_loss_prevented`，避免并发写入或瞬时损坏把认证和 onboarding 状态清空（`saveConfigWithLock()`）。

</details>

## 回顾（折叠）｜2.1.88 源码里能看到"识别中国用户的后门"吗

<details>
<summary>回答 38 留下的问题，报道称 Claude Code 的指标上报可能留有后门，甚至被用于识别中国用户；从 2.1.88 的源码中，能看出这类行为吗？</summary>

答案先放在前面，从 2.1.88 的还原源码中，能够确认 Claude Code 存在第一方 analytics/telemetry 上报链路，而且上报字段足以描述运行环境、账号与组织、会话、模型、进程资源以及在开关打开时的工具输入；但**看不出一个"专门识别中国用户"的客户端后门**。公开报道所指的版本范围是 2.1.91，2.1.196，晚于本系列固定分析的 2.1.88，不能把后续版本的报道直接回填到这里。更不能仅凭客户端静态代码判断服务器收到请求后如何使用 IP、账号或风控规则。

**2.1.88 确实存在两条上报路径。** 第一条是第一方事件日志，`initialize1PEventLogging()` 创建独立的 `FirstPartyEventLoggingExporter`，默认把批量事件 POST 到 `https://api.anthropic.com/api/event_logging/batch`；批量失败后会把 JSONL 暂存到本地，再按退避策略重试。`is1PEventLoggingEnabled()` 检查的是 `isAnalyticsDisabled()`，不是用户自定义 OpenTelemetry 开关。测试环境、Bedrock、Vertex、Foundry，或隐私级别关闭时才跳过。也就是说，直接 API/OAuth 用户在默认环境下确实有一方事件记录，这一点不能用"没有显式 `CLAUDE_CODE_ENABLE_TELEMETRY`"来否认。

第二条是可配置的 OpenTelemetry。`isTelemetryEnabled()` 只在 `CLAUDE_CODE_ENABLE_TELEMETRY` 为真时返回真，`bootstrapTelemetry()` 再把内部构建时的 `ANT_OTEL_*` 配置映射到标准 `OTEL_*` 变量。它与第一方事件 logger 使用不同的 provider 和 exporter，一个面向 Anthropic 内部事件，另一个面向用户配置的 OTLP endpoint。两者都叫 telemetry，不能混成一条链路。

**源码实际会带走什么？** `getEventMetadata()` 和 `buildEnvContext()` 组装的是一组通用的运行画像，不是"中国用户"字段，平台及原始 `process.platform`、CPU 架构、Node 版本、终端、已检测到的包管理器与运行时；CI/GitHub Actions、WSL 版本、Linux 发行版与内核、VCS、Claude Code 版本、构建时间和部署环境；模型、session ID、交互/客户端类型、订阅档位、Agent/teammate 关联信息，以及经过哈希的仓库 remote（`rh`）；`buildProcessMetrics()` 读取 uptime、RSS、heap、external、arrayBuffers、受限内存、CPU 使用量和 CPU 百分比；第一方格式化函数还会把 `accountUuid`、`organizationUuid`，以及用户资料中的 email 放进事件结构。

这些字段当然具有隐私含义，也可以被服务端用于分群或关联；但"能够推断用户属于某个区域"和"客户端代码明确检测中国并触发特殊上报"是两个不同命题。更关键的是，`EnvContext` 中没有国家、地理位置、IP、时区或代理字段，`buildEnvContext()` 也没有读取这些值。对 `China`、`Chinese`、`geolocation`、`Alibaba`、`Beijing`、`prompt steganography` 等专门标记的源码检索，也没有在 telemetry/analytics 这条路径发现对应分支；通用代码里的 `timezone` 命中属于格式化或调度用途，并未进入这套事件环境字段。

工具输入的边界也写在代码里，`extractToolInputForTelemetry()` 只有在 `OTEL_LOG_TOOL_DETAILS` 为真时才序列化输入，随后经过 `truncateToolInputValue()` 和总长度上限截断；默认则返回 `undefined`。这说明"默认不上报工具参数"和"在显式打开详情后可能上报受限参数"必须分开说，不能简单概括成"会上传全部源码"。

**为什么报道仍然值得核查？** 新闻报道与研究文章声称，后续的 2.1.91，2.1.196 版本出现过用于识别地理、身份、系统时区、代理或网络特征的机制；报道还转述 Anthropic 将其解释为反滥用实验。这里至少有两个边界，一是这些说法针对的不是 2.1.88，二是新闻是对逆向结果和公司回应的转述，不等于我们已经在本仓库的 2.1.88 源码中复现了同样逻辑。因此，当前证据最多支持"2.1.88 有值得审计的第一方遥测和隐私开关"，不支持"2.1.88 已证实存在识别中国用户的后门"。

还要保留一个静态分析无法消除的盲区。客户端把事件发往可由动态配置改变路径或 base URL 的 exporter；服务器可以根据网络来源、账号或事件组合做二次判断，这些规则不在本地 bundle 中。反过来，看到默认 endpoint、账号字段或 GrowthBook 实验分组，也不能单独把它们定性为后门，需要同时证明隐藏触发条件、未披露的数据用途和绕过用户选择的行为。

如果要验证报道，正确的实验应是，固定 npm 包版本和完整 hash，逐版本 diff `metadata.ts`、第一方 exporter、GrowthBook 配置与网络请求；在隔离环境中抓取实际 POST payload，再分别测试不同账号、时区、代理和出口网络。只有把"客户端采集了什么""请求发到哪里"和"服务器如何处理"三层证据对齐，才能回答是否存在面向特定地区的后门。

</details>

## 留给下一篇的问题

普通用户能把 Claude Code 更新到内部版本或测试版本（即非 `stable`、`latest` 渠道的版本）吗？

## 相关链接

- **上一篇**，[38 如何追踪日志、成本与诊断信息](./38-observability-cost-and-diagnostics.md)，`/status` 健康检查与遥测边界
- **下一篇**，[40 如何从会话中提炼知识](./40-session-memory.md)，Autocompact 优先路径的产物如何产生
- **平行阅读**，[35 配置如何分层、同步与裁剪](./35-settings-config-and-feature-flags.md)，`autoUpdatesChannel` 与 `minimumVersion` 的配置面
- **平行阅读**，[03 启动与引导如何工作](./03-startup-and-bootstrap.md)，`preAction` 迁移之前的启动顺序
