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

观测系统能够看见运行状态以后，Claude Code 如何检查更新、执行迁移，并引导新用户完成首次启动与环境准备？

答案是：它没有把这些事情塞进一个巨大的 `setup` 函数里顺序执行，而是拆成三条彼此衔接、失败边界不同的链路。

第一条是**版本兼容链路**。CLI 在命令执行前读取全局配置；如果 `migrationVersion` 不是当前值 `11`，就依次运行同步迁移，最后才写入新版本标记。已经写过标记的环境，下次启动直接跳过整组同步迁移。

第二条是**更新链路**。更新器先读取 `latest` 或 `stable` 渠道，再识别当前究竟是 native、npm local、npm global，还是由 Homebrew、winget、apk 等包管理器托管。前几类可以走各自的安装器；包管理器托管的安装只提示正确命令，不越权替用户修改系统包。

第三条是**交互式首次启动链路**。只有交互模式会进入 onboarding 和 workspace trust：先完成主题、认证、安全说明、可选终端配置，再确认当前目录是否可信。`claude -p` 不展示这些对话框，因此“没有弹窗”不等于源码忘了做安全检查，而是无头入口采用了另一套信任前提。

这三条链路共同维持向后兼容：迁移旧状态，更新可执行程序，再让用户明确接受新环境的认证与信任边界。任何一条失败，都不应该把旧配置悄悄覆盖掉。

本文仍以仓库中由 `@anthropic-ai/claude-code@2.1.88` source map 还原出的代码为边界。为突出主线，下面的源码片段省略了日志、遥测和无关分支；还原路径不代表 Anthropic 内部仓库的原始目录结构。

![Claude Code 更新、迁移、Onboarding 与 Workspace Trust 的启动兼容链路](/images/posts/claude-code-source-reading-39/39-updates-migrations-onboarding-handdrawn.png)

## 先建立一个简单模型：状态、动作和门槛

更新、迁移和 onboarding 经常被统称为“启动检查”，但它们处理的不是同一种状态。

迁移处理的是**旧数据结构**：旧字段还能不能被新代码理解，某项设置是否已经搬到新位置。更新处理的是**可执行程序版本**：本机正在运行什么安装形态，远端渠道提供什么版本，当前进程有没有权限替换它。Onboarding 处理的是**用户决策**：主题怎么显示、使用哪种认证、是否理解安全提示。Trust 处理的是**目录边界**：这个工作区能不能启用项目配置、hooks、MCP 与命令执行。

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

一是把 `migrationVersion` 当成 Claude Code 的产品版本。它不是。产品版本来自 `MACRO.VERSION`，而 `migrationVersion` 只是“当前这组同步迁移是否执行过”的本地标记。

二是把更新检查当成启动阻塞步骤。交互式更新组件在挂载后检查，并每 30 分钟再检查一次；网络失败会变成空结果或失败状态。迁移和 trust 才会直接改变后续启动控制流。

## 迁移为什么要在命令执行前完成

`runMigrations()` 的调用位置在 `restored-src/src/main.tsx` 的 Commander `preAction` 阶段。也就是说，不只是默认 REPL，后续子命令在读取新配置语义之前，也先经过同一组版本迁移。

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

`runMigrations()` 位于 `restored-src/src/main.tsx`，没有参数，也不返回迁移结果。`CURRENT_MIGRATION_VERSION` 在这一版本中是数字 `11`；它是整组同步迁移的批次号，不是语义化版本。只有本地 `migrationVersion !== 11` 时，同步迁移才会执行；相等时整段被跳过。

这个顺序有意把“写完成标记”放在最后。前面的迁移函数如果同步抛错，标记就不会被写成 `11`，下一次启动仍有机会重跑。源码没有事务把所有迁移包成一次原子提交，因此单个迁移自身仍必须具备重复执行的安全性。

异步的 `migrateChangelogFromConfig()` 则采用另一种策略：启动不等待它，失败也不把同步标记回滚。旧字段仍在时，下次启动继续尝试。这里的幂等性来自目标文件的独占创建和旧字段检查，而不是 `migrationVersion`。

## 幂等迁移不是口号，而是“先看新状态，再动旧状态”

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

`migrateReplBridgeEnabledToRemoteControlAtStartup()` 位于 `restored-src/src/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts`，没有参数。它把旧字段视为 `unknown`，再用 `Boolean(oldValue)` 收敛成布尔值。

这里有两个明确的停止条件：旧字段为 `undefined`，说明没有东西可迁；新字段不是 `undefined`，说明用户或新版本已经给过明确值，此时旧值不能覆盖新值。`false` 不是“缺失”，所以会被保留。迁移成功后才删除旧字段。

这就是字段迁移最重要的优先级：**显式的新配置高于遗留配置**。如果函数只判断真假，那么新值 `false` 会被误认为“还没有设置”，旧值就可能反向覆盖用户选择。

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

`migrateConfigFields(config)` 位于 `restored-src/src/utils/config.ts`。参数 `config` 是读出的 `GlobalConfig`；返回值是内存中的兼容后配置。只要 `installMethod` 已经不是 `undefined`，函数就原样返回，避免重复解释旧字段。

旧 `autoUpdaterStatus` 的源码可选值有六个：`migrated` 对应本地 npm 安装，`installed` 对应 native，`disabled` 只关闭自动更新但无法确认安装类型，`enabled`、`no_permissions`、`not_configured` 都回退成 global。旧字段缺失时，安装方式保持 `unknown`。`autoUpdates` 若已有 `true` 或 `false` 就保留，只有 `undefined` 才默认成 `true`。

注意，这个函数主要保证**读取兼容**。`getGlobalConfig()` 每次首次加载和后台 freshness watcher 重新读取时都会经过它，但它本身不负责立即把迁移结果写回磁盘。真正的持久化仍由后续 `saveGlobalConfig()` 完成。。

## 更新渠道只是第一步，安装归属才决定动作

更新器先读取 `autoUpdatesChannel`。这一设置在 schema 中只有 `latest` 和 `stable` 两个可选值；没有设置时回退到 `latest`。

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

`getLatestVersion(channel)` 位于 `restored-src/src/utils/autoUpdater.ts`。`channel` 的静态可选值是 `latest | stable`：`stable` 映射到 npm 的 `stable` tag，其余合法分支映射到 `latest`。返回值是版本字符串或 `null`；进程退出码非零时返回 `null`，调用方不能把它当成“已经是最新版”。

这里还有一个容易忽略的安全细节：`npm view` 在 home 目录运行，不在当前项目目录运行。这样不会读取项目里的 `.npmrc`，避免一个未信任仓库把 registry 重定向到攻击者地址。检查本身还有 5 秒 `AbortSignal.timeout()`；超时或命令失败都只得到 `null`。

拿到目标版本以后，`AutoUpdater` 还要同时满足四个条件才会安装：自动更新未禁用、当前版本与目标版本都存在、当前版本低于目标版本、目标版本没有被 `minimumVersion` 策略跳过。

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

这段来自 `restored-src/src/components/AutoUpdater.tsx` 的 `AutoUpdater(props)`。`props.isUpdating` 是布尔值，用 ref 防止 30 分钟定时器拿到旧闭包并发起重复安装；`onChangeIsUpdating(boolean)` 更新 UI 状态；`onAutoUpdaterResult(result)` 接收结果；`autoUpdaterResult` 可以是对象或 `null`；`showSuccessMessage` 和 `verbose` 都是布尔开关。

`InstallStatus` 在这些路径中可出现 `success`、`no_permissions`、`install_failed` 和 `in_progress`。`success` 表示安装器完成；`no_permissions` 提示权限不足；`install_failed` 表示安装失败；`in_progress` 表示另一个安装正在进行。不同安装函数支持的状态子集并不完全相同，例如 local 安装返回 `in_progress | success | install_failed`。

源码还存在两个独立组件：`NativeAutoUpdater` 调用 native installer；`PackageManagerAutoUpdater` 只检查版本并展示对应命令。后者对 Homebrew、winget、apk 分别给出 `brew upgrade claude-code`、`winget upgrade Anthropic.ClaudeCode`、`apk upgrade claude-code`，未知包管理器则提示使用自己的更新命令。这里没有替系统包管理器执行自动安装。

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

`performVersionUpdate(version, forceReinstall)` 位于 `restored-src/src/utils/nativeInstaller/installer.ts`。`version` 是开放版本字符串，来源于更新渠道或显式安装目标；源码没有在这个函数里枚举所有版本。`forceReinstall` 为 `true` 时，即使目标版本已存在也重新下载；为 `false` 时可复用已经可用的版本目录。返回布尔值表示这次是否真的进行了安装，而不是通用的成功/失败状态；失败通过抛错表达。

`ENABLE_LOCKLESS_UPDATES` 为真时，staging 路径加入 PID 和时间戳，避免并发下载踩同一路径；否则上层 `updateLatest()` 使用版本锁并重试三次。拿不到锁时 native 更新返回 `lockFailed`，交互式自动更新把它视为本轮静默跳过，稍后定时器再试，而不是把当前可执行程序判坏。

此外还有两道版本护栏：服务端 `maxVersion` 可以把目标版本封顶，设置里的 `minimumVersion` 可以跳过低于下限的目标。它们是更新选择约束，不是迁移批次号。

## 首次启动不是一个页面，而是一组按条件拼出来的步骤

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

`showSetupScreens(...)` 位于 `restored-src/src/interactiveHelpers.tsx`。`root` 是 Ink 渲染根；`permissionMode` 是权限模式，具体枚举已在第 12 篇说明；。`commands`、`claudeInChrome`、`devChannels` 都可为 `undefined`，分别影响命令风险检查、Chrome onboarding 和开发 channel 确认。

返回值是 `Promise<boolean>`：只有本次真的显示了基础 onboarding 才返回 `true`。显示条件不是单看 `hasCompletedOnboarding`；主题缺失也会重新进入。这避免一个残缺配置带着“已完成”标志跳过必要设置。`CLAUBBIT` 环境变量为真时，当前源码会跳过这一段 trust 与相关项目审批；它是显式特殊入口，不能当作普通交互模式的默认行为。

Onboarding 完成时，`completeOnboarding()` 写入两个字段：`hasCompletedOnboarding: true` 和 `lastOnboardingVersion: MACRO.VERSION`。前者控制是否至少展示一次，后者记录完成时的产品版本。。

Onboarding 组件并不是固定五屏。它会根据认证和终端环境动态组装 `steps`：

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

这段来自 `restored-src/src/components/Onboarding.tsx` 的 `Onboarding({ onDone })`。`onDone` 是无参数回调，在最后一步结束时调用。`oauthEnabled` 是初始化时读取的布尔值；为 `false` 时不会加入 `preflight` 和 `oauth`。`apiKeyNeedingApproval` 是空字符串或截断后的 key；只有非空时才加入确认步骤。

步骤顺序很有意义：先做 preflight，再选主题，再确认环境变量中的 API key 或走 OAuth，随后明确展示安全说明，最后才询问是否修改终端按键配置。终端设置失败被记录后会继续 `goToNextStep()`，所以它是体验增强项，不是启动成功的硬门槛。

## 中国用户看到的“卡在 setup”，通常不是迁移失败

这部分需要把本地 setup 与网络认证分开看。

`Onboarding` 在 `oauthEnabled` 为真时会加入 preflight 和 OAuth。中国大陆网络环境如果不能直连 Claude 服务，这两步可能无法完成；但主题选择、配置迁移和 workspace trust 都是本地机制。它们不应该被混成一个“setup 失败”。

如果你已经通过受支持的第三方 provider、企业代理或显式 API key 配好认证，真正决定是否加入 OAuth 步骤的是 `isAnthropicAuthEnabled()` 与 API key 状态，而不是地理位置字符串。。

对自动化代码阅读，`claude -p` 的确会绕开整套交互式 setup screens；但它同时跳过 workspace trust 对话框，并把当前非交互环境视作可信。因此这个入口适合 CI 或你明确控制的目录，不是用来对陌生仓库“一键跳过安全提示”的捷径。

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

`computeTrustDialogAccepted()` 位于 `restored-src/src/utils/config.ts`，没有参数，返回布尔值。它先看 session 内存标志，再看配置选择的项目路径，最后从当前目录逐级向父目录查找已接受标志；一直到文件系统根目录仍没有命中才返回 `false`。

Trust dialog 给用户的值只有 `enable_all` 和 `exit`。`enable_all` 表示信任当前工作区并继续，`exit` 会以状态码 `1` 退出。取消操作也按 `exit` 处理，没有“先进入只读模式再说”的第三个静态选项。

接受时，如果当前目录正好是 home 目录，信任只写到本次 session 内存；其他目录通过 `saveCurrentProjectConfig()` 持久化。这样不会把整个用户 home 永久登记成一个普通可信项目。

Trust 之所以放在系统上下文、项目 MCP 审批、CLAUDE.md 外部 include 和完整配置环境变量之前，是因为这些行为可能读取项目指令，甚至间接执行命令。第 37 篇看到的 Bridge 也复用了同一边界：未接受目录信任时，headless bridge 会直接拒绝注册远端执行环境。

## 配置写入失败时，为什么不能拿默认值覆盖旧认证

迁移是否安全，最后取决于配置写入。`saveGlobalConfig()` 不是简单的“读 JSON、改字段、写回”。它使用文件锁，锁内重新读取最新配置，再建立时间戳备份。

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

这段来自 `restored-src/src/utils/config.ts` 的 `saveConfigWithLock(file, createDefault, mergeFn)`。`file` 是目标配置路径；`createDefault()` 提供缺省结构；`mergeFn(current)` 必须返回新配置，若返回同一对象引用就表示无变化并跳过写入。函数返回布尔值，表示是否真的写过。

`wouldLoseAuthState(fresh)` 只保护两类关键状态：缓存里有 `oauthAccount`、新读取却没有；或缓存里 `hasCompletedOnboarding === true`、新读取却不再为真。命中任意一种都拒绝覆盖，避免并发写入或瞬时损坏把认证和 onboarding 状态清空。

备份至少间隔 60 秒创建一次，并只保留最近 5 份。配置损坏时，`getConfig()` 会把损坏内容单独复制成 `.corrupted.<timestamp>`，向 stderr 告知备份路径，然后回退默认配置。文件完全丢失但存在备份时，它只提示手工恢复命令，不会静默猜测该恢复哪一份。

这是一种很克制的失败回退：更新失败继续使用旧二进制，异步迁移失败下次再试，配置损坏保留证据并回退默认值，关键认证状态疑似丢失则拒绝写回。源码没有承诺所有失败都能自动修复，但尽量避免把一次故障升级为不可逆的数据覆盖。

## 版本状态到底保存了什么

把本章出现的几个版本字段放在一起，就不容易混淆了。

| 状态 | 作用 | 缺失时的行为 |
|---|---|---|
| `MACRO.VERSION` | 当前 Claude Code 产品版本 | 构建期宏，源码路径中直接使用 |
| `migrationVersion` | 已执行的同步迁移批次 | 不等于 `11` 就重跑整组同步迁移 |
| `lastOnboardingVersion` | 最近完成 onboarding 时的产品版本 | 不单独决定当前代码是否展示 onboarding |
| `lastReleaseNotesSeen` | 最近确认看过 release notes 的版本 | 用于决定是否准备 release notes 数据 |
| `autoUpdatesChannel` | 更新渠道 | `undefined` 回退到 `latest` |
| `minimumVersion` | 不安装低于该下限的目标 | `undefined` 表示不启用这道跳过规则 |
| `maxVersion` | 更新目标的远端封顶值 | `undefined` 表示不封顶 |

表里只有 `migrationVersion` 在这一还原版本中有固定值 `11`。

## 小结

Claude Code 的启动兼容不是“发现新版本就覆盖安装”这么简单。

同步迁移先用 `migrationVersion` 把旧配置推进到当前语义，单个迁移再通过 `undefined` 检查、显式新值优先和重复执行保护维持幂等。异步迁移不阻塞启动，失败后依靠旧字段仍然存在而在下次启动重试。

更新器把渠道和安装归属分开：`latest | stable` 决定去哪里取版本，native、npm local、npm global、package manager 决定谁有权执行更新。staging、版本锁、软链接验证和失败状态共同保证旧二进制不会因为一次下载失败立刻失效。

Onboarding 负责用户级准备，Workspace Trust 负责项目级信任。`bypassPermissions` 不能替代 trust；`claude -p` 虽然跳过交互屏幕，却意味着调用者自己承担目录可信的前提。

真正的向后兼容，靠的不是某个万能迁移脚本，而是这四条约束：旧状态可读，新状态不被旧值覆盖，失败能够重试，安全边界必须由正确的人确认。

## 留给下一篇的问题

首次启动完成以后，Claude Code 的 Session Memory 如何从长会话中提炼、保存并在后续压缩和恢复中复用长期信息？

