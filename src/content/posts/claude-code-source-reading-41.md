---
title: "Claude Code源码解读41：Memdir 与团队记忆如何检索和同步"
published: 2026-07-24T16:47:28+08:00
updated: 2026-07-24T16:47:28+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-41/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

Session Memory 保存单会话长期信息以后，memdir 与 Team Memory 如何把记忆扩展到目录和团队范围，并控制共享与注入？

先看作用域边界：**memdir 把长期信息落成项目范围内可审查的 Markdown 目录，Team Memory 只从这个目录划出 `team/` 子树并同步它。** 私有索引、团队索引和主题文件各有路径；注入、上传、下载也各有门槛。

Claude Code 2.1.88 使用一套文件系统协议：私有记忆放在项目对应的 auto-memory 目录，团队记忆放在其 `team/` 子目录；两个作用域各自维护 `MEMORY.md` 索引和主题文件。系统提示词告诉模型怎样选择作用域、怎样写文件，真正进入上下文的内容由索引加载或相关性选择器控制；Session Memory 原文和未选中的主题不会被全量广播。

共享也有明确边界。只有 `team/` 会走远端同步；同步还要同时通过 auto memory、Team Memory 功能开关、第一方 OAuth 和 GitHub remote 等门槛。上传前逐文件扫描密钥，远端文件落盘前检查路径穿越和符号链接逃逸。也就是说，“模型决定这是团队知识”只是第一步，后面还有本地目录边界、认证边界和同步边界。

记忆作用域、上下文注入和共享同步是三条不同控制线。下面先确定目录，再看索引如何限流，最后追踪 pull/watch/push 的冲突与安全处理。

![Claude Code memdir 与 Team Memory 的检索、注入和同步边界](/images/posts/claude-code-source-reading-41/41-memdir-team-memory-handdrawn.png)

## 本章先建立三个概念

- **记忆索引**：入口文件保存主题摘要和位置，详细内容按需读取，控制启动上下文。

- **同步语义**：pull、watch 与 push 分别处理初始对齐、持续变化和本地成果上传。

- **共享信任边界**：路径校验、密钥扫描和作用域区分限制团队记忆可传播的内容。

![Memdir 索引与 Team Memory 同步](/images/posts/claude-code-source-reading-41/41-memory-sync-detail-handdrawn.png)

先区分“存在哪里”“什么时候注入”和“哪些文件可以离开本机”，后面的路径校验和同步语义就不会混在一起。

图里的 `private/` 是为了和 `team/` 对照的**逻辑作用域标签**；磁盘布局把私有索引和主题文件直接放在 memdir 根目录。

## 先建立一个简单模型：目录、索引和主题文件

读这部分源码前，先把三个容易混在一起的概念拆开。

**Session Memory** 关心的是从会话里提炼哪些信息。**memdir** 关心的是这些信息以什么可持久化、可审查的形态保存。**Team Memory** 关心的是其中哪些内容可以跨用户共享，以及共享文件怎样在本地和服务端之间同步。

因此，memdir 以项目根为 key 建立一份持久化目录。默认形态可以简化成：

```text
~/.claude/projects/<sanitized-project-root>/memory/
├── MEMORY.md              # 私有索引
├── user_role.md           # 私有主题文件
└── team/
    ├── MEMORY.md          # 团队索引
    └── release_policy.md  # 团队主题文件
```

这段结构是根据 `getAutoMemPath()` 与 `getTeamMemPath()` 路径组合画出的直观模型。`MEMORY.md` 保持为短索引，带 frontmatter 的具体内容进入主题文件。默认路径跟随规范化后的 Git 根，因此同一个仓库的多个 worktree 可以复用同一份项目记忆。

为什么不用一份越来越长的 `MEMORY.md`？因为索引和正文解决的是两个不同问题：索引提供低成本方向感，主题文件提供按需细节。这样既能让用户直接用普通文件工具审计，也能避免每轮都把所有历史内容塞进模型窗口。

## memdir 如何确定项目作用域

`getAutoMemPath()` 把环境覆盖、可信设置和默认项目路径排成了明确优先级：

```ts
export const getAutoMemPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
    if (override) {
      return override
    }
    const projectsDir = join(getMemoryBaseDir(), 'projects')
    return (
      join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep
    ).normalize('NFC')
  },
  () => getProjectRoot(),
)

export function getTeamMemPath(): string {
  return (join(getAutoMemPath(), 'team') + sep).normalize('NFC')
}
```

`getAutoMemPath()` 位于 `restored-src/src/memdir/paths.ts`，接受零个业务参数，返回带尾部分隔符的绝对路径。路径优先使用 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`，其次使用受信任设置源里的 `autoMemoryDirectory`，最后回退到 `<memoryBase>/projects/<sanitized-git-root>/memory/`。函数以 `getProjectRoot()` 作为 memoize key；源码注释说明环境变量和设置在生产会话中被视为稳定值。

`getTeamMemPath()` 位于 `restored-src/src/memdir/teamMemPaths.ts`，同样接受零个参数。它始终在 auto-memory 目录下追加 `team`，把团队目录固定为私有项目记忆目录的子树。

这里有一道容易忽略的权限防线：`autoMemoryDirectory` 不读取仓库可提交的 `projectSettings`，只读取 `policySettings`、`flagSettings`、`localSettings`、`userSettings`。否则，一个刚 clone 的仓库就可以把记忆目录指向 `~/.ssh`，再借记忆写入的权限豁口改动敏感文件。

自定义路径还会经过 `validateMemoryPath(raw, expandTilde)`。`raw` 是 `string | undefined`；空值返回 `undefined`。`expandTilde` 为 `true` 时允许设置中的 `~/...`，为 `false` 时环境覆盖必须直接给绝对路径。相对路径、根目录、Windows 盘符根、UNC 路径、空字节和会退回 home 或其父目录的 `~` 形式都会被拒绝。非法覆盖不会变成一个“尽量使用”的危险路径，而是回到下一层解析逻辑。

## 两个开关形成总能力与共享能力的依赖

目录存在不代表功能一定启用。auto memory 先决定整套文件记忆是否工作，Team Memory 再决定是否增加共享作用域：

```ts
export function isAutoMemoryEnabled(): boolean {
  const envVal = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  if (isEnvTruthy(envVal)) return false
  if (isEnvDefinedFalsy(envVal)) return true
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) return false
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    !process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  ) return false

  const settings = getInitialSettings()
  if (settings.autoMemoryEnabled !== undefined) {
    return settings.autoMemoryEnabled
  }
  return true
}

export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) return false
  return getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_herring_clock',
    false,
  )
}
```

`isAutoMemoryEnabled()` 位于 `restored-src/src/memdir/paths.ts`。它接受零个参数并返回布尔值。`CLAUDE_CODE_DISABLE_AUTO_MEMORY` 的真值表示关闭，显式假值表示开启；未定义时继续检查 `CLAUDE_CODE_SIMPLE`、缺少持久化目录的 remote 场景和 `settings.autoMemoryEnabled`。设置字段已定义时原样采用，所以显式 `false` 会覆盖默认值；所有条件都未指定时才默认 `true`。

`isTeamMemoryEnabled()` 位于 `restored-src/src/memdir/teamMemPaths.ts`。它先要求 auto memory 为 `true`，再读取 `tengu_herring_clock`，后者静态回退值是 `false`。此外相关模块还受构建期 `feature('TEAMMEM')` 控制。

这套依赖关系避免了“私有记忆关闭，但团队同步仍在后台运行”的分裂状态。auto memory 是总开关，Team Memory 是附加能力，不存在 team-only 分支。

## Prompt 如何让模型区分 private 和 team

功能开启后，`loadMemoryPrompt()` 不会简单拼接两段独立说明，而是切换到 combined prompt：

```ts
if (feature('TEAMMEM')) {
  if (teamMemPaths!.isTeamMemoryEnabled()) {
    const autoDir = getAutoMemPath()
    const teamDir = teamMemPaths!.getTeamMemPath()
    await ensureMemoryDirExists(teamDir)
    return teamMemPrompts!.buildCombinedMemoryPrompt(
      extraGuidelines,
      skipIndex,
    )
  }
}

if (autoEnabled) {
  const autoDir = getAutoMemPath()
  await ensureMemoryDirExists(autoDir)
  return buildMemoryLines(
    'auto memory',
    autoDir,
    extraGuidelines,
    skipIndex,
  ).join('\n')
}

return null
```

`loadMemoryPrompt()` 位于 `restored-src/src/memdir/memdir.ts`，接受零个参数，返回 `Promise<string | null>`。Team Memory 开启时返回同时描述 private 与 team 的提示；只开启 auto memory 时返回单目录提示；auto memory 关闭时返回 `null`，调用方据此跳过整段 memory system-prompt section。`extraGuidelines` 有值时追加宿主规则，省略时跳过该段；`skipIndex` 静态默认 `false`，为 `true` 时切换成只维护主题文件的提示。

`ensureMemoryDirExists(teamDir)` 会递归创建目录。由于 `team/` 位于 auto-memory 目录内，创建它也会创建父目录；权限或只读文件系统导致的失败会记日志，但 prompt 构建仍继续，真正写入时由文件工具暴露错误。这是一种刻意的失败边界：目录准备失败不伪装成“记忆功能已经成功写入”。

combined prompt 把记忆限制为四类：`user`、`feedback`、`project`、`reference`。其中 `user` 始终 private；`feedback` 默认 private，只有明确的项目级约定才进入 team；`project` 可以二选一但强烈倾向 team；`reference` 通常 team。`parseMemoryType(raw)` 对非字符串、缺失值和未知字符串都返回 `undefined`，因此旧文件不会因为少一个 `type` 字段而完全失效。

`buildCombinedMemoryPrompt(extraGuidelines?, skipIndex = false)` 位于 `restored-src/src/memdir/teamMemPrompts.ts`。`extraGuidelines` 省略时不追加宿主策略；`skipIndex` 为 `false` 时要求“写主题文件，再更新同目录 `MEMORY.md`”两步保存，为 `true` 时只写独立主题文件。

## 注入通过索引与相关记忆两条路径限流

启动时最先进入上下文的不是所有 topic，而是两个受限的 `MEMORY.md` 入口。传统路径里，`getMemoryFiles()` 把它们标成 `AutoMem` 与 `TeamMem`；团队索引再包上来源标签，提醒模型这是共享线索而非无条件事实。

```ts
if (feature('TEAMMEM') && file.type === 'TeamMem') {
  memories.push(
    `Contents of ${file.path}${description}:\n\n` +
      `<team-memory-content source="shared">\n` +
      `${content}\n` +
      `</team-memory-content>`,
  )
} else {
  memories.push(`Contents of ${file.path}${description}:\n\n${content}`)
}
```

这段来自 `restored-src/src/utils/claudemd.ts` 的 `getClaudeMds(memoryFiles, filter?)`。`memoryFiles` 是已发现的记忆/指令文件数组；`filter` 是可选的类型筛选函数，省略时接受全部类型。Team Memory 使用 `source="shared"` 包裹，给模型一个明确的共享来源信号；该标签只标记来源，团队文件内容仍需按外部上下文验证。

两个索引还受相同上限保护：`MEMORY.md` 最多加载 200 行、25,000 字符。超出后先按行截断，再按最后一个换行位置截断字节，并附加警告。这样长索引不会无限占用上下文，代价是排在后面的条目可能不可见，所以 prompt 才反复要求索引保持简短。

另一条路径由 `tengu_moth_copse` 控制。开启时，索引不再直接注入 system prompt，而是在用户回合开始后异步选择相关主题文件：

```ts
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter(
    m => !alreadySurfaced.has(m.filePath),
  )
  if (memories.length === 0) return []

  const selectedFilenames = await selectRelevantMemories(
    query, memories, signal, recentTools,
  )
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  return selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)
    .map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}
```

`findRelevantMemories()` 位于 `restored-src/src/memdir/findRelevantMemories.ts`。`query` 是本轮开放文本；`memoryDir` 是要递归扫描的目录，普通情况下为 `getAutoMemPath()`，所以其 `team/` 子目录也在候选集合中；`signal` 用于取消；`recentTools` 默认空数组，用来降低正在使用的工具参考文档误命中；`alreadySurfaced` 默认空集合，用来避免重复注入。

`scanMemoryFiles()` 只读取 `.md` 文件 frontmatter 的前若干行，排除 `MEMORY.md`，按 `mtimeMs` 从新到旧排序并截取静态上限。选择器再让默认 Sonnet 根据 query、文件名、描述和最近工具选择最多 5 个文件。返回文件名还要和候选集合交叉验证，模型无法借返回 `../../...` 读取候选目录外的任意文件。

选择失败、解析失败或取消都会返回空数组，主请求继续运行。prefetch 也只在准备好时消费；单词 prompt、会话累计记忆字节达到上限、功能关闭等情况会直接跳过。因此相关记忆是一份按条件注入的有界辅助上下文。

## 年龄只触发复核提示

主题文件的 `mtimeMs` 会一路带到注入附件。`memoryAgeDays()` 用整天向下取整，未来时间会钳制为 0；今天显示 `today`，昨天显示 `yesterday`，更早显示 `N days ago`。

超过一天的内容不会被自动删除，而是附加一条 freshness 提醒：记忆是某个时点的观察，代码行为和 `file:line` 引用可能已经过期，回答前应重新核对当前代码。

年龄只触发重新验证提示。用户的沟通偏好可能半年不变，发布截止日期可能明天就失效；最终相关性仍由模型结合内容判断。

## Team Memory 的启动顺序：先 pull，再 watch

共享目录出现以后，还要有一条独立同步链路。`startTeamMemoryWatcher()` 先检查构建标志、功能开关、第一方 OAuth 与 GitHub remote，然后创建本会话的 `SyncState`：

```ts
export async function startTeamMemoryWatcher(): Promise<void> {
  if (!feature('TEAMMEM')) return
  if (!isTeamMemoryEnabled() || !isTeamMemorySyncAvailable()) return

  const repoSlug = await getGithubRepo()
  if (!repoSlug) return

  syncState = createSyncState()
  try {
    await pullTeamMemory(syncState)
  } catch (e) {
    // 记录失败，继续建立 watcher
  }

  await startFileWatcher(getTeamMemPath())
}
```

`startTeamMemoryWatcher()` 位于 `restored-src/src/services/teamMemorySync/watcher.ts`，无参数，返回 `Promise<void>`。第一方 OAuth 还要求 inference 与 profile scope；repo slug 来自 `github.com` remote。任何门槛不满足都提前返回，不创建同步状态。

顺序很关键：初始 pull 发生在 watcher 之前，因此远端文件写入本地会跳过本地编辑回推。即使初始 pull 失败或服务端内容为空，代码仍会创建目录并启动 watcher，保证第一次团队记忆写入可以被观察到。

watcher 使用递归 `fs.watch`。文件变化后等待 2 秒 debounce，再调用 `pushTeamMemory()`；如果 push 正在进行，就重新安排。文件工具的 PostToolUse 路径还会显式调用 `notifyTeamMemoryWrite()`，用来补偿平台可能合并或漏掉文件事件的情况。进程退出时会关闭 watcher，并在关闭预算内尽力 flush 尚未提交的变化，但源码明确把它定义为 best-effort。

## Pull 与 Push 使用不同冲突语义

完整同步入口非常短：

```ts
export async function syncTeamMemory(state: SyncState): Promise<{
  success: boolean
  filesPulled: number
  filesPushed: number
  error?: string
}> {
  const pullResult = await pullTeamMemory(
    state,
    { skipEtagCache: true },
  )
  if (!pullResult.success) {
    return { success: false, filesPulled: 0, filesPushed: 0,
      error: pullResult.error }
  }

  const pushResult = await pushTeamMemory(state)
  if (!pushResult.success) {
    return { success: false, filesPulled: pullResult.filesWritten,
      filesPushed: 0, error: pushResult.error }
  }
  return { success: true,
    filesPulled: pullResult.filesWritten,
    filesPushed: pushResult.filesUploaded }
}
```

`syncTeamMemory(state)` 位于 `restored-src/src/services/teamMemorySync/index.ts`。`state` 是本会话可变同步状态，包含 `lastKnownChecksum: string | null`、每个 key 的 `serverChecksums: Map<string, string>` 和从服务端 413 学到的 `serverMaxEntries: number | null`。返回对象的 `success` 标记整次同步是否完成；`filesPulled` 与 `filesPushed` 分别记录实际落盘数和上传数；`error` 只在失败路径携带 pull 或 push 的错误字符串。

`skipEtagCache: true` 表示完整同步的 pull 不使用已有 ETag 快速返回；普通 watcher pull 默认值是 `false`。pull 先完成，服务端同 key 内容会覆盖本地，因此 `syncTeamMemory()` 的总语义是 server-first。pull 失败时不继续 push，避免拿过期本地状态覆盖未知远端状态。

由本地编辑触发的单独 `pushTeamMemory()` 采用 local-wins。它计算本地 SHA-256 与 `serverChecksums` 的差集，只上传发生变化的 key。遇到 `412` 时最多进行 2 次冲突重试：先请求 `view=hashes` 刷新远端哈希，再重新计算 delta。同一 key 被双方修改时，本地版本最终可能覆盖远端版本；服务端新增且本地缺失的文件要等下一次 pull 才落盘。

还有一个常被误读的限制：上传接口采用 upsert，删除本地文件不会删除服务端条目；未出现在 PUT 中的 key 会被保留，下一次 pull 还会把文件恢复回来。源码注释提到需要 `soft_delete_keys` 才能传播删除，而当前同步主线只上传现存文件。

## 密钥扫描与路径校验守住共享边界

写进 `team/` 后还要通过 `readLocalTeamMemory()` 的逐文件密钥扫描：

```ts
const content = await readFile(fullPath, 'utf8')
const relPath = relative(teamDir, fullPath).replaceAll('\\', '/')
const secretMatches = scanForSecrets(content)

if (secretMatches.length > 0) {
  const firstMatch = secretMatches[0]!
  skippedSecrets.push({
    path: relPath,
    ruleId: firstMatch.ruleId,
    label: firstMatch.label,
  })
  return
}

entries[relPath] = content
```

这段位于 `restored-src/src/services/teamMemorySync/index.ts`。`content` 是 UTF-8 文件内容；`relPath` 是相对 `team/` 的跨平台 key。命中密钥规则时，`path` 保存这个 `relPath`，让诊断能指出被跳过的团队记忆文件。`scanForSecrets(content)` 位于 `secretScanner.ts`，返回按 rule ID 去重的 `SecretMatch[]`，只包含 `ruleId` 和人类可读 `label`，故意不返回命中的真实秘密值。

只要命中一个规则，整个文件就从上传集合排除；其他安全文件仍可继续同步。单文件超过 250,000 bytes 也会跳过。服务端 entry 数上限来自结构化 `413 team_memory_too_many_entries` 响应；客户端缓存其中的 `max_entries`，下一次按稳定的文件名字母顺序截取。

远端到本地的方向则经过 `validateTeamMemKey(relativeKey)`。它拒绝空字节、绝对路径、反斜杠、URL 编码穿越和 Unicode 规范化穿越，再解析最深已存在祖先的真实路径，防止 `team/` 内的符号链接指向目录外。验证失败的单个条目被跳过，不会让整个批次越过目录边界。

普通文件权限还有一层区别。默认 auto-memory 路径位于 `~/.claude` 这类危险目录下，因此源码给受控记忆目录提供内部读写 allow；`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 指向调用方选择的任意目录时，需要 SDK 调用方提供正常 allow rule。共享能力只放行受控默认路径。

## 失败时会发生什么

这套设计的失败方式比“同步成功/失败”更细。

auto memory 或 Team Memory 开关关闭时，prompt 与 watcher 跳过初始化。第一方 OAuth 或 GitHub remote 不满足时，本地 combined prompt 仍可能描述团队目录，远端同步则停在启动门槛；网络超时、解析失败和服务端错误会让本轮 pull/push 返回失败。

watcher 会把 `no_oauth`、`no_repo` 和除 `409`、`429` 外的大多数 4xx 视为不会自行恢复的失败，暂停后续 push，避免文件事件形成无限重试。删除文件会清除 suppression，支持“条目过多”场景恢复；认证问题通常要重启新会话后重新建立同步状态。

读取与注入采用降级策略。目录扫描失败返回空列表，某个 frontmatter 读取失败只丢掉那个候选，相关性 side query 失败返回空选择，主题文件过大会截断并提示使用 Read 查看全文。主循环因此可以在空记忆结果下继续工作。

最后要保留一个证据边界。源码能确认目录结构、提示词规则、选择器上限、同步 API、冲突路径和安全检查。Team Memory 只提供受控共享通道；事实验证与数据防泄漏仍需独立机制。

## 小结

memdir 把长期记忆拆成项目作用域的目录、短索引和可按需读取的主题文件。它用路径解析和功能开关决定存储位置，用 prompt 约束内容与更新方式，用索引或相关性选择器控制上下文注入，并用年龄提醒把旧记忆降回“待验证线索”。

Team Memory 在这套文件协议上增加 `team/` 共享作用域。它只同步团队子目录，启动时先 pull 再 watch，本地变化经 debounce、密钥扫描和 delta push 送往服务端；远端内容落盘前还要经过路径与符号链接校验。私有内容不进入同步 payload，共享内容也不因为“来自团队”就自动可信。

从架构上看，Session Memory 负责发现候选知识，memdir 负责保存与检索，Team Memory 负责受控共享。三者接起来，才形成从一次会话到未来会话、再到同一项目团队成员的记忆链路。

## 留给下一篇的问题

团队记忆能够积累以后，AutoDream 如何在后台挑选素材、生成 Dream，并把结果重新纳入未来会话？

## 参考资料

- [Claude Code Memory](https://code.claude.com/docs/en/memory)

- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
