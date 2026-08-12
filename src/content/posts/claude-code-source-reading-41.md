---
title: "Claude Code源码解读41：Memdir 与团队记忆如何检索和同步 🔬"
published: 2026-07-24T16:47:28+08:00
updated: 2026-08-12
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-41/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇的问题是，**Session Memory 的 `summary.md` 会在什么时机被创建、更新和读取？**

先把两个容易混淆的文件分开，`summary.md` 是当前 session 的 Session Memory，位于项目和 `sessionId` 对应的 `session-memory/` 目录；项目级 auto memory 使用的是 `MEMORY.md`。官方文档所说的“启动时加载记忆”主要指后者，不能据此推断 `summary.md` 每次启动都会被读入上下文。

在 2.1.88 中，`summary.md` 是一个按需生成、增量维护、由几个明确消费者读取的文件，

| 时机 | 是否创建或写入 | 是否读取 | 触发条件 |
| --- | --- | --- | --- |
| 会话 setup | 否 | 否 | 只注册 post-sampling hook |
| 主 REPL 一轮采样结束 | 是，达到阈值后创建或更新 | 是，更新前先读旧内容 | 本地模式、auto compact 与 feature gate 开启，且 token/工具阈值满足 |
| 自动或手动 compact | 否 | 是 | SM Compact 路径被选中 |
| 终端失焦后的 away summary | 否 | 是 | away-summary 开关开启，失焦延迟计时器触发 |
| `/skillify` | 否 | 是 | 命令构造 skill 提示词时 |

因此，短会话可能始终没有 `summary.md`；它也不是每个普通模型请求都会被无条件读取。

### 创建和更新发生在一轮采样之后

`initSessionMemory()` 在 setup 阶段只做一件事，本地、auto compact 开启时注册 `extractSessionMemory` 这个 post-sampling hook。真正执行时，hook 先拒绝非 `repl_main_thread` 的来源，再检查 `tengu_session_memory` gate；subagent、teammate 等路径不会为主会话提炼这份文件。

通过门控后，`shouldExtractMemory()` 才检查阈值。默认首次提炼需要上下文达到 10,000 token；后续两次提炼之间至少增长 5,000 token，并且还要满足“自上次更新以来有至少 3 次工具调用”或“最后一轮 assistant 没有工具调用、形成自然停顿”之一。远端动态配置可以覆盖这些正数阈值，所以这里的数字是源码默认值，不是不可变协议。

阈值满足后才调用 `setupSessionMemoryFile()`，它创建权限为 `0700` 的目录，用 `wx` 独占创建权限为 `0600` 的文件，首次写入模板；文件已经存在时不会覆盖，而是先读取当前内容。随后 `extractSessionMemory` 启动一个受限的 forked agent，只允许它围绕这一个路径更新摘要。也就是说，文件的“创建时机”与“第一次真正有内容的更新时间”都在 post-sampling 阶段，而不是会话启动阶段。

### compact 读取它，但不会因为读取而改写它

自动 compact 达到上下文阈值，或用户手动执行 `/compact` 时，调用链会尝试 `trySessionMemoryCompaction()`。只有 `tengu_session_memory` 与 `tengu_sm_compact` 两个开关都允许时，才会进入这条路径。它先等待正在进行的提炼，最多等待 15 秒；如果提炼状态已经持续超过 60 秒，则视为 stale，不再阻塞 compact。

接着 `getSessionMemoryContent()` 读取磁盘文件。如果文件不存在、仍是空模板、已记录的摘要边界在当前消息列表中找不到，或者拼接后的压缩结果仍超过自动 compact 阈值，函数返回 `null`，上层改走传统的 compaction。成功时，源码会把摘要截断到预算内，与保留的近期消息、SessionStart hook 结果和新的 boundary 组合成 compact 结果；这次读取本身不会把新的摘要写回 `summary.md`。

这里也解释了一个容易误判的现象，`/compact` 不是 `summary.md` 的创建按钮。没有达到 post-sampling 阈值的短会话，即使直接 compact，也可能因为没有有效 Session Memory 而回退到旧的压缩流程。

### 还有两个按需读取的消费者

开启 away-summary 后，终端失焦会启动一个延迟计时器；计时器触发且当前没有正在进行的回合时，`generateAwaySummary()` 读取 `summary.md` 和最近的对话，请小模型生成一段离开时摘要。用户重新聚焦会取消在途请求，所以“失焦后延迟读取”才是准确时机，而不是每次重新打开终端都读取。

`/skillify` 也会读取它，`getPromptForCommand()` 先取得 `summary.md`，再把它和 compact boundary 之后的用户消息一起填入 skillify 提示词。这个读取是命令级的、一次性的，不会改变 Session Memory 文件。

把整个生命周期串起来就是，**主 REPL 采样结束且达到阈值时创建/更新；compact、away summary 或 `/skillify` 真正需要上下文时读取；setup 和普通请求路径不会无条件加载它。**

## 介绍本章的一些概念

- 记忆分两层消费，**入口索引**（`MEMORY.md`，最长 200 行 / 25,000 字符）控制启动上下文，**主题文件**（带 frontmatter 的具体内容）按需读取；同一份文件既是可审计的 Markdown，又是模型的可检索目录。
- 作用域由路径解析决定，`getAutoMemPath()` 优先环境覆盖，其次受信任设置 `autoMemoryDirectory`，最后回退 `<memoryBase>/projects/<sanitized-git-root>/memory/`；`team/` 固定在 auto-memory 目录内，且**不读取仓库可提交的 `projectSettings`**，防止刚 clone 的仓库把记忆目录指向敏感位置。
- 开关是两层依赖，`isAutoMemoryEnabled()` 是总开关，`isTeamMemoryEnabled()` 额外要求 `tengu_herring_clock` 为 true（静态回退 false），不存在 team-only 分支。
- 同步语义不对称，**pull（server-first，先于 watcher 执行）+ push（local-wins，按 SHA-256 delta 上传，412 冲突最多重试 2 次）**；删除不传播（upsert 只上传现存文件），`syncTeamMemory()` 的总语义是 server-first。
- 共享边界由两道扫描守住，上传前 `scanForSecrets()` 逐文件密钥扫描（命中一个规则即整文件排除），下载前 `validateTeamMemKey()` 拒绝路径穿越与符号链接逃逸。
- 证据边界，目录结构、提示词规则、选择器上限、同步 API、冲突路径和安全检查都可确认；Team Memory 只提供受控共享通道，事实验证与数据防泄漏仍需独立机制。

> 🔬 **可选实验子系统**，本章的 memdir / Team Memory 属于受构建期 `TEAMMEM` 与灰度开关控制的实验性记忆设施，普通公开构建可能未编译或未放行。不影响理解内核，可跳过；需要理解「记忆索引 + 同步」设计时再读。

## 本篇新增

承接 40 篇的 Session Memory，本章引入三个概念，

- **记忆索引**，入口文件保存主题摘要和位置，详细内容按需读取，控制启动上下文。
- **同步语义**，pull、watch 与 push 分别处理初始对齐、持续变化和本地成果上传。
- **共享信任边界**，路径校验、密钥扫描和作用域区分限制团队记忆可传播的内容。

![Memdir 索引与 Team Memory 同步](/images/posts/claude-code-source-reading-41/41-memory-sync-detail-handdrawn.png)

先区分「存在哪里」「什么时候注入」和「哪些文件可以离开本机」，后面的路径校验和同步语义就不会混在一起。图里的 `private/` 是为了和 `team/` 对照的**逻辑作用域标签**；磁盘布局把私有索引和主题文件直接放在 memdir 根目录。

## 问题

上一篇（40）的问题是，**Session Memory 的 `summary.md` 会在什么时机被创建、更新和读取？**

先把两个容易混淆的文件分开，`summary.md` 是当前 session 的 Session Memory，位于项目和 `sessionId` 对应的 `session-memory/` 目录；项目级 auto memory 使用的是 `MEMORY.md`。官方文档所说的「启动时加载记忆」主要指后者，不能据此推断 `summary.md` 每次启动都会被读入上下文。

在 2.1.88 中，`summary.md` 是一个按需生成、增量维护、由几个明确消费者读取的文件，

| 时机 | 是否创建或写入 | 是否读取 | 触发条件 |
| --- | --- | --- | --- |
| 会话 setup | 否 | 否 | 只注册 post-sampling hook |
| 主 REPL 一轮采样结束 | 是，达到阈值后创建或更新 | 是，更新前先读旧内容 | 本地模式、auto compact 与 feature gate 开启，且 token/工具阈值满足 |
| 自动或手动 compact | 否 | 是 | SM Compact 路径被选中 |
| 终端失焦后的 away summary | 否 | 是 | away-summary 开关开启，失焦延迟计时器触发 |
| `/skillify` | 否 | 是 | 命令构造 skill 提示词时 |

因此，短会话可能始终没有 `summary.md`；它也不是每个普通模型请求都会被无条件读取。

### 创建和更新发生在一轮采样之后

`initSessionMemory()` 在 setup 阶段只做一件事，本地、auto compact 开启时注册 `extractSessionMemory` 这个 post-sampling hook。真正执行时，hook 先拒绝非 `repl_main_thread` 的来源，再检查 `tengu_session_memory` gate；subagent、teammate 等路径不会为主会话提炼这份文件。

通过门控后，`shouldExtractMemory()` 才检查阈值。默认首次提炼需要上下文达到 10,000 token；后续两次提炼之间至少增长 5,000 token，并且还要满足「自上次更新以来有至少 3 次工具调用」或「最后一轮 assistant 没有工具调用、形成自然停顿」之一。远端动态配置可以覆盖这些正数阈值，所以这里的数字是源码默认值，不是不可变协议。

阈值满足后才调用 `setupSessionMemoryFile()`，它创建权限为 `0700` 的目录，用 `wx` 独占创建权限为 `0600` 的文件，首次写入模板；文件已经存在时不会覆盖，而是先读取当前内容。随后 `extractSessionMemory` 启动一个受限的 forked agent，只允许它围绕这一个路径更新摘要。也就是说，文件的「创建时机」与「第一次真正有内容的更新时间」都在 post-sampling 阶段，而不是会话启动阶段。

### compact 读取它，但不会因为读取而改写它

自动 compact 达到上下文阈值，或用户手动执行 `/compact` 时，调用链会尝试 `trySessionMemoryCompaction()`。只有 `tengu_session_memory` 与 `tengu_sm_compact` 两个开关都允许时，才会进入这条路径。它先等待正在进行的提炼，最多等待 15 秒；如果提炼状态已经持续超过 60 秒，则视为 stale，不再阻塞 compact。

接着 `getSessionMemoryContent()` 读取磁盘文件。如果文件不存在、仍是空模板、已记录的摘要边界在当前消息列表中找不到，或者拼接后的压缩结果仍超过自动 compact 阈值，函数返回 `null`，上层改走传统的 compaction。成功时，源码会把摘要截断到预算内，与保留的近期消息、SessionStart hook 结果和新的 boundary 组合成 compact 结果；这次读取本身不会把新的摘要写回 `summary.md`。

这里也解释了一个容易误判的现象，`/compact` 不是 `summary.md` 的创建按钮。没有达到 post-sampling 阈值的短会话，即使直接 compact，也可能因为没有有效 Session Memory 而回退到旧的压缩流程。

### 还有两个按需读取的消费者

开启 away-summary 后，终端失焦会启动一个延迟计时器；计时器触发且当前没有正在进行的回合时，`generateAwaySummary()` 读取 `summary.md` 和最近的对话，请小模型生成一段离开时摘要。用户重新聚焦会取消在途请求，所以「失焦后延迟读取」才是准确时机，而不是每次重新打开终端都读取。

`/skillify` 也会读取它，`getPromptForCommand()` 先取得 `summary.md`，再把它和 compact boundary 之后的用户消息一起填入 skillify 提示词。这个读取是命令级的、一次性的，不会改变 Session Memory 文件。

把整个生命周期串起来就是，**主 REPL 采样结束且达到阈值时创建/更新；compact、away summary 或 `/skillify` 真正需要上下文时读取；setup 和普通请求路径不会无条件加载它。**

## 正文

本文全部引用 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` 还原源码。代码块只保留证明控制流所需的字段；每个代码块后标注证据位置。`restored-src/` 只用于定位证据，不表示内部仓库原始目录。

### 这张金额单位工单的结论怎样变成团队记忆

Team 完成验收后，lead 在工单里看到三份表面相近、作用域不同的结论，前端同事记录了页面格式化方式，支付同事确认了整数分边界，值班工程师的私有笔记还包含客户订单号和临时登录信息。他只希望下一位处理支付问题的人找到前两类工程事实，于是输入，

> 把金额单位错误的根因、最终方案和回归测试命令写入团队记忆，让下一位处理支付问题的人能找到它；排除客户数据、凭据和只对我有用的临时笔记。

Claude Code 先按项目作用域定位 memdir，再通过索引和主题文件区分 private 与 team 内容；Team Memory 还要经过 pull、watch、push 和路径/密钥扫描，不能把本地文件直接当成所有成员都能看到的共享事实。下一位值班工程师读到的应该是「支付域使用整数分、边界转换在哪里、运行哪条回归测试」，而不是上一位工程师的全部会话。

### 先建立一个简单模型｜目录、索引和主题文件

读这部分源码前，先把三个容易混在一起的概念拆开。

**Session Memory** 关心的是从会话里提炼哪些信息。**memdir** 关心的是这些信息以什么可持久化、可审查的形态保存。**Team Memory** 关心的是其中哪些内容可以跨用户共享，以及共享文件怎样在本地和服务端之间同步。

因此，memdir 以项目根为 key 建立一份持久化目录。默认形态可以简化成，

```text
~/.claude/projects/<sanitized-project-root>/memory/
├── MEMORY.md              # 私有索引
├── user_role.md           # 私有主题文件
└── team/
    ├── MEMORY.md          # 团队索引
    └── release_policy.md  # 团队主题文件
```

这段结构是根据 `getAutoMemPath()` 与 `getTeamMemPath()` 路径组合画出的直观模型。`MEMORY.md` 保持为短索引，带 frontmatter 的具体内容进入主题文件。默认路径跟随规范化后的 Git 根，因此同一个仓库的多个 worktree 可以复用同一份项目记忆。

为什么不用一份越来越长的 `MEMORY.md`？因为索引和正文解决的是两个不同问题，索引提供低成本方向感，主题文件提供按需细节。这样既能让用户直接用普通文件工具审计，也能避免每轮都把所有历史内容塞进模型窗口。

### memdir 如何确定项目作用域

`getAutoMemPath()` 把环境覆盖、可信设置和默认项目路径排成了明确优先级，

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

> 证据，`restored-src/src/memdir/paths.ts` 的 `getAutoMemPath()` 与 `restored-src/src/memdir/teamMemPaths.ts` 的 `getTeamMemPath()`（2.1.88 source map 还原源码）。`getAutoMemPath()` 接受零个业务参数，返回带尾部分隔符的绝对路径。路径优先使用 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`，其次使用受信任设置源里的 `autoMemoryDirectory`，最后回退到 `<memoryBase>/projects/<sanitized-git-root>/memory/`。函数以 `getProjectRoot()` 作为 memoize key；源码注释说明环境变量和设置在生产会话中被视为稳定值。

`getTeamMemPath()` 同样接受零个参数。它始终在 auto-memory 目录下追加 `team`，把团队目录固定为私有项目记忆目录的子树。

这里有一道容易忽略的权限防线，`autoMemoryDirectory` 不读取仓库可提交的 `projectSettings`，只读取 `policySettings`、`flagSettings`、`localSettings`、`userSettings`。否则，一个刚 clone 的仓库就可以把记忆目录指向 `~/.ssh`，再借记忆写入的权限豁口改动敏感文件。

自定义路径还会经过 `validateMemoryPath(raw, expandTilde)`。`raw` 是 `string | undefined`；空值返回 `undefined`。`expandTilde` 为 `true` 时允许设置中的 `~/...`，为 `false` 时环境覆盖必须直接给绝对路径。相对路径、根目录、Windows 盘符根、UNC 路径、空字节和会退回 home 或其父目录的 `~` 形式都会被拒绝。非法覆盖不会变成一个「尽量使用」的危险路径，而是回到下一层解析逻辑。

### 两个开关形成总能力与共享能力的依赖

目录存在不代表功能一定启用。auto memory 先决定整套文件记忆是否工作，Team Memory 再决定是否增加共享作用域，

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

> 证据，`restored-src/src/memdir/paths.ts` 的 `isAutoMemoryEnabled()` 与 `restored-src/src/memdir/teamMemPaths.ts` 的 `isTeamMemoryEnabled()`（2.1.88 source map 还原源码）。`CLAUDE_CODE_DISABLE_AUTO_MEMORY` 的真值表示关闭，显式假值表示开启；未定义时继续检查 `CLAUDE_CODE_SIMPLE`、缺少持久化目录的 remote 场景和 `settings.autoMemoryEnabled`。设置字段已定义时原样采用，所以显式 `false` 会覆盖默认值；所有条件都未指定时才默认 `true`。

`isTeamMemoryEnabled()` 先要求 auto memory 为 `true`，再读取 `tengu_herring_clock`，后者静态回退值是 `false`。此外相关模块还受构建期 `feature('TEAMMEM')` 控制。

这套依赖关系避免了「私有记忆关闭，但团队同步仍在后台运行」的分裂状态。auto memory 是总开关，Team Memory 是附加能力，不存在 team-only 分支。

### Prompt 如何让模型区分 private 和 team

功能开启后，`loadMemoryPrompt()` 不会简单拼接两段独立说明，而是切换到 combined prompt，

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

> 证据，`restored-src/src/memdir/memdir.ts`（2.1.88 source map 还原源码），`loadMemoryPrompt()`。接受零个参数，返回 `Promise<string | null>`。Team Memory 开启时返回同时描述 private 与 team 的提示；只开启 auto memory 时返回单目录提示；auto memory 关闭时返回 `null`，调用方据此跳过整段 memory system-prompt section。`extraGuidelines` 有值时追加宿主规则，省略时跳过该段；`skipIndex` 静态默认 `false`，为 `true` 时切换成只维护主题文件的提示。

`ensureMemoryDirExists(teamDir)` 会递归创建目录。由于 `team/` 位于 auto-memory 目录内，创建它也会创建父目录；权限或只读文件系统导致的失败会记日志，但 prompt 构建仍继续，真正写入时由文件工具暴露错误。这是一种刻意的失败边界，目录准备失败不伪装成「记忆功能已经成功写入」。

combined prompt 把记忆限制为四类，`user`、`feedback`、`project`、`reference`。其中 `user` 始终 private；`feedback` 默认 private，只有明确的项目级约定才进入 team；`project` 可以二选一但强烈倾向 team；`reference` 通常 team。`parseMemoryType(raw)` 对非字符串、缺失值和未知字符串都返回 `undefined`，因此旧文件不会因为少一个 `type` 字段而完全失效。

`buildCombinedMemoryPrompt(extraGuidelines?, skipIndex = false)` 位于 `restored-src/src/memdir/teamMemPrompts.ts`。`extraGuidelines` 省略时不追加宿主策略；`skipIndex` 为 `false` 时要求「写主题文件，再更新同目录 `MEMORY.md`」两步保存，为 `true` 时只写独立主题文件。

### Prompt 里藏着一份小型存储协议

如果只把 `buildCombinedMemoryPrompt()` 当成给模型看的说明文案，会漏掉它最有意思的一层：它是在运行时把宿主状态编译成模型的写入协议。函数先把 private/team 两个目录的真实路径和「目录已经存在」的前提写进 prompt，再按 `skipIndex` 选择保存步骤，最后叠加读取、过期校验和其他持久化边界。模型拿到的不是笼统的「你可以保存记忆」，而是「应该以什么格式、写到哪个作用域、是否还要更新索引」。

`skipIndex` 这个参数尤其值得看。它的静态默认值是 `false`，`loadMemoryPrompt()` 再把 `tengu_moth_copse` 的运行时值传进来；同一个开关也被记忆提取 agent 使用。因此它不是少读一次文件的微优化，而是改变了模型维护目录的协议，

| `skipIndex` | 提示词要求 | 直接后果 |
| --- | --- | --- |
| `false` | 先写带 frontmatter 的主题文件，再在同目录 `MEMORY.md` 写一行指针；索引不能放 frontmatter 或正文 | private 与 team 各有自己的入口索引，索引超过 200 行后会被截断 |
| `true` | 只写主题文件，仍要维护 `name`、`description`、`type`，检查重复并更新过时记忆 | 不再要求这次写入同步维护 `MEMORY.md`，详细内容继续以独立 Markdown 文件存在 |

这也解释了为什么索引条目被要求保持很短：它不是第二份正文，而是启动时加载的导航层。`MEMORY.md` 的行数上限是 200，字节上限是 25,000；主题文件则承担真正的细节。一个模型如果把完整结论直接塞进索引，即使信息没有丢失，也会把后续条目挤出启动上下文。

用户指令在这里也不是简单的「说了记住就无条件落盘」。源码同时编码了几种容易被忽略的优先级，

| 用户说法 | Prompt 规定的行为 |
| --- | --- |
| 「记住这个」 | 立即选择合适的类型和作用域，但仍受 `What NOT to save` 的排除项约束 |
| 「忘掉这个」 | 找到对应条目并删除 |
| 「不要使用记忆」 | 把 `MEMORY.md` 当作空文件；不应用、不引用、不比较，也不提及记忆内容 |
| 「把当前任务计划存下来」 | 当前会话的计划和任务应使用 Plan/Tasks，不应污染长期 memory |

所以「显式保存」只是跳过了普通的相关性判断，并没有给代码模式、Git 历史、调试步骤、`CLAUDE.md` 已有内容或临时任务状态开绿灯。甚至用户要求保存一份 PR 列表或活动摘要时，prompt 还要求追问其中真正反常、非显然、值得跨会话保留的部分。相反，「ignore memory」也不是先读出来再口头说一句“我不采纳”，而是要求模型在行为上把它当成不存在；这是一个很少见但很明确的隐私语义。

还有一个可插拔的最后一公里：`loadMemoryPrompt()` 只在 `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` 非空且去掉首尾空白后仍有内容时，把它包装成 `extraGuidelines` 传入；`buildCombinedMemoryPrompt()` 会把这些字符串追加在内置的 memory/Plan/Tasks 规则之后、过去上下文搜索说明之前。也就是说，静态源码能确认「宿主可以追加策略」，却不能枚举某个运行环境实际注入了什么文本。读源码时，不能把 `teamMemPrompts.ts` 看到的内容误认为最终 system prompt 的全部。

> 证据，`restored-src/src/memdir/teamMemPrompts.ts` 的 `buildCombinedMemoryPrompt()`；`restored-src/src/memdir/memdir.ts` 的 `loadMemoryPrompt()`；`restored-src/src/memdir/memoryTypes.ts` 的 `WHAT_NOT_TO_SAVE_SECTION`、`MEMORY_DRIFT_CAVEAT` 与 `TRUSTING_RECALL_SECTION`。`skipIndex` 的默认值、`tengu_moth_copse` 的传递、`extraGuidelines` 的环境变量来源和插入位置都能由源码确认；运行时最终是否存在某条宿主规则，则取决于外部环境。

### 注入通过索引与相关记忆两条路径限流

启动时最先进入上下文的是两个受限的 `MEMORY.md` 入口，所有 topic 不会一次性进入。传统路径里，`getMemoryFiles()` 把它们标成 `AutoMem` 与 `TeamMem`；团队索引再包上来源标签，提醒模型这是共享线索而非无条件事实。

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

> 证据，`restored-src/src/utils/claudemd.ts` 的 `getClaudeMds(memoryFiles, filter?)`（2.1.88 source map 还原源码）。`memoryFiles` 是已发现的记忆/指令文件数组；`filter` 是可选的类型筛选函数，省略时接受全部类型。Team Memory 使用 `source="shared"` 包裹，给模型一个明确的共享来源信号；该标签只标记来源，团队文件内容仍需按外部上下文验证。

两个索引还受相同上限保护，`MEMORY.md` 最多加载 200 行、25,000 字符。超出后先按行截断，再按最后一个换行位置截断字节，并附加警告。这样长索引不会无限占用上下文，代价是排在后面的条目可能不可见，所以 prompt 才反复要求索引保持简短。

另一条路径由 `tengu_moth_copse` 控制。开启时，索引不再直接注入 system prompt，而是在用户回合开始后异步选择相关主题文件，

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

> 证据，`restored-src/src/memdir/findRelevantMemories.ts`（2.1.88 source map 还原源码），`findRelevantMemories()`。`query` 是本轮开放文本；`memoryDir` 是要递归扫描的目录，普通情况下为 `getAutoMemPath()`，所以其 `team/` 子目录也在候选集合中；`signal` 用于取消；`recentTools` 默认空数组，用来降低正在使用的工具参考文档误命中；`alreadySurfaced` 默认空集合，用来避免重复注入。

`scanMemoryFiles()` 只读取 `.md` 文件 frontmatter 的前若干行，排除 `MEMORY.md`，按 `mtimeMs` 从新到旧排序并截取静态上限。选择器再让默认 Sonnet 根据 query、文件名、描述和最近工具选择最多 5 个文件。返回文件名还要和候选集合交叉验证，模型无法借返回 `../../...` 读取候选目录外的任意文件。

选择失败、解析失败或取消都会返回空数组，主请求继续运行。prefetch 也只在准备好时消费；单词 prompt、会话累计记忆字节达到上限、功能关闭等情况会直接跳过。因此相关记忆是一份按条件注入的有界辅助上下文。

### 年龄只触发复核提示

主题文件的 `mtimeMs` 会一路带到注入附件。`memoryAgeDays()` 用整天向下取整，未来时间会钳制为 0；今天显示 `today`，昨天显示 `yesterday`，更早显示 `N days ago`。

超过一天的内容不会被自动删除，而是附加一条 freshness 提醒，记忆是某个时点的观察，代码行为和 `file:line` 引用可能已经过期，回答前应重新核对当前代码。

年龄只触发重新验证提示。用户的沟通偏好可能半年不变，发布截止日期可能明天就失效；最终相关性仍由模型结合内容判断。

### Team Memory 的启动顺序｜先 pull，再 watch

共享目录出现以后，还要有一条独立同步链路。`startTeamMemoryWatcher()` 先检查构建标志、功能开关、第一方 OAuth 与 GitHub remote，然后创建本会话的 `SyncState`，

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

> 证据，`restored-src/src/services/teamMemorySync/watcher.ts`（2.1.88 source map 还原源码），`startTeamMemoryWatcher()`。无参数，返回 `Promise<void>`。第一方 OAuth 还要求 inference 与 profile scope；repo slug 来自 `github.com` remote。任何门槛不满足都提前返回，不创建同步状态。

顺序很关键，初始 pull 发生在 watcher 之前，因此远端文件写入本地会跳过本地编辑回推。即使初始 pull 失败或服务端内容为空，代码仍会创建目录并启动 watcher，保证第一次团队记忆写入可以被观察到。

watcher 使用递归 `fs.watch`。文件变化后等待 2 秒 debounce，再调用 `pushTeamMemory()`；如果 push 正在进行，就重新安排。文件工具的 PostToolUse 路径还会显式调用 `notifyTeamMemoryWrite()`，用来补偿平台可能合并或漏掉文件事件的情况。进程退出时会关闭 watcher，并在关闭预算内尽力 flush 尚未提交的变化，但源码明确把它定义为 best-effort。

### Pull 与 Push 使用不同冲突语义

完整同步入口非常短，

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

> 证据，`restored-src/src/services/teamMemorySync/index.ts`（2.1.88 source map 还原源码），`syncTeamMemory(state)`。`state` 是本会话可变同步状态，包含 `lastKnownChecksum: string | null`、每个 key 的 `serverChecksums: Map<string, string>` 和从服务端 413 学到的 `serverMaxEntries: number | null`。返回对象的 `success` 标记整次同步是否完成；`filesPulled` 与 `filesPushed` 分别记录实际落盘数和上传数；`error` 只在失败路径携带 pull 或 push 的错误字符串。

`skipEtagCache: true` 表示完整同步的 pull 不使用已有 ETag 快速返回；普通 watcher pull 默认值是 `false`。pull 先完成，服务端同 key 内容会覆盖本地，因此 `syncTeamMemory()` 的总语义是 server-first。pull 失败时不继续 push，避免拿过期本地状态覆盖未知远端状态。

由本地编辑触发的单独 `pushTeamMemory()` 采用 local-wins。它计算本地 SHA-256 与 `serverChecksums` 的差集，只上传发生变化的 key。遇到 `412` 时最多进行 2 次冲突重试，先请求 `view=hashes` 刷新远端哈希，再重新计算 delta。同一 key 被双方修改时，本地版本最终可能覆盖远端版本；服务端新增且本地缺失的文件要等下一次 pull 才落盘。

还有一个常被误读的限制，上传接口采用 upsert，删除本地文件不会删除服务端条目；未出现在 PUT 中的 key 会被保留，下一次 pull 还会把文件恢复回来。源码注释提到需要 `soft_delete_keys` 才能传播删除，而当前同步主线只上传现存文件。

### 密钥扫描与路径校验守住共享边界

写进 `team/` 后还要通过 `readLocalTeamMemory()` 的逐文件密钥扫描，

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

> 证据，`restored-src/src/services/teamMemorySync/index.ts`（2.1.88 source map 还原源码），`readLocalTeamMemory()` 的密钥扫描分支。`content` 是 UTF-8 文件内容；`relPath` 是相对 `team/` 的跨平台 key。命中密钥规则时，`path` 保存这个 `relPath`，让诊断能指出被跳过的团队记忆文件。`scanForSecrets(content)` 位于 `secretScanner.ts`，返回按 rule ID 去重的 `SecretMatch[]`，只包含 `ruleId` 和人类可读 `label`，故意不返回命中的真实秘密值。

只要命中一个规则，整个文件就从上传集合排除；其他安全文件仍可继续同步。单文件超过 250,000 bytes 也会跳过。服务端 entry 数上限来自结构化 `413 team_memory_too_many_entries` 响应；客户端缓存其中的 `max_entries`，下一次按稳定的文件名字母顺序截取。

远端到本地的方向则经过 `validateTeamMemKey(relativeKey)`。它拒绝空字节、绝对路径、反斜杠、URL 编码穿越和 Unicode 规范化穿越，再解析最深已存在祖先的真实路径，防止 `team/` 内的符号链接指向目录外。验证失败的单个条目被跳过，不会让整个批次越过目录边界。

普通文件权限还有一层区别。默认 auto-memory 路径位于 `~/.claude` 这类危险目录下，因此源码给受控记忆目录提供内部读写 allow；`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 指向调用方选择的任意目录时，需要 SDK 调用方提供正常 allow rule。共享能力只放行受控默认路径。

### 失败时会发生什么

这套设计的失败方式比「同步成功/失败」更细。

auto memory 或 Team Memory 开关关闭时，prompt 与 watcher 跳过初始化。第一方 OAuth 或 GitHub remote 不满足时，本地 combined prompt 仍可能描述团队目录，远端同步则停在启动门槛；网络超时、解析失败和服务端错误会让本轮 pull/push 返回失败。

watcher 会把 `no_oauth`、`no_repo` 和除 `409`、`429` 外的大多数 4xx 视为不会自行恢复的失败，暂停后续 push，避免文件事件形成无限重试。删除文件会清除 suppression，支持「条目过多」场景恢复；认证问题通常要重启新会话后重新建立同步状态。

读取与注入采用降级策略。目录扫描失败返回空列表，某个 frontmatter 读取失败只丢掉那个候选，相关性 side query 失败返回空选择，主题文件过大会截断并提示使用 Read 查看全文。主循环因此可以在空记忆结果下继续工作。

最后要保留一个证据边界。源码能确认目录结构、提示词规则、选择器上限、同步 API、冲突路径和安全检查。Team Memory 只提供受控共享通道；事实验证与数据防泄漏仍需独立机制。

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。**MISSING** 表示实现不在 source map 中。

| 阶段 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| 路径 | `getAutoMemPath()` / `validateMemoryPath()` | `src/memdir/paths.ts` | 已确认 |
| 路径 | `getTeamMemPath()` / `isTeamMemoryEnabled()` | `src/memdir/teamMemPaths.ts` | 已确认 |
| 开关 | `isAutoMemoryEnabled()` | `src/memdir/paths.ts` | 已确认 |
| Prompt | `loadMemoryPrompt()` / `buildCombinedMemoryPrompt()` | `src/memdir/memdir.ts`、`src/memdir/teamMemPrompts.ts` | 已确认 |
| 注入 | `getClaudeMds()` `source="shared"` 标签、`MEMORY.md` 200 行 / 25,000 字符上限 | `src/utils/claudemd.ts` | 已确认 |
| 相关记忆 | `findRelevantMemories()` / `scanMemoryFiles()` / 最多 5 个文件 | `src/memdir/findRelevantMemories.ts` | 已确认 |
| 年龄 | `memoryAgeDays()` freshness 提示 | memdir 模块 | 已确认 |
| 同步启动 | `startTeamMemoryWatcher()`（先 pull 再 watch、2 秒 debounce） | `src/services/teamMemorySync/watcher.ts` | 已确认 |
| 同步语义 | `syncTeamMemory()` / `pullTeamMemory()` / `pushTeamMemory()`（server-first / local-wins、412 重试 2 次） | `src/services/teamMemorySync/index.ts` | 已确认 |
| 密钥扫描 | `scanForSecrets()` / 单文件 250,000 bytes 上限 / 413 `max_entries` | `secretScanner.ts`、`index.ts` | 已确认 |
| 路径校验 | `validateTeamMemKey()`（穿越与符号链接拒绝） | `src/services/teamMemorySync/index.ts` | 已确认 |

## 设计决策

**第一，为什么用「短索引 + 按需主题文件」而不是一份越来越长的 `MEMORY.md`？** 索引解决方向感，主题文件解决细节；两者让启动上下文有界（200 行 / 25,000 字符），让审计仍是普通 Markdown 文件。代价是索引截断后排在后面的条目不可见，所以 prompt 反复要求索引保持简短。

**第二，为什么 `team/` 必须是 auto-memory 目录的子树，且开关是两级依赖？** 把团队目录固定为私有目录的子目录，同步与权限就复用同一条受控路径；`isTeamMemoryEnabled()` 先要求 `isAutoMemoryEnabled()`，避免「私有记忆关闭但团队同步还在后台跑」的分裂状态。team-only 分支不存在。

**第三，为什么 pull 与 push 用不同冲突语义？** 同步起点（startup）与服务端对齐，必须是 server-first，否则本地过期状态会覆盖团队真相；本地编辑是用户的主动成果，采用 local-wins，否则用户每次写文件都要等待远端批准。对称会带来一种「谁的本地先改谁赢」的隐含保证，而源码实际提供的是方向不对称的语义。

**第四，为什么密钥扫描命中就整文件跳过，而不是清洗后上传？** 清洗需要对秘密格式做语义理解，容易漏；整文件排除是保守且可诊断的，`skippedSecrets` 只记录 `ruleId` 与 `label`，故意不返回命中的真实秘密值，防止诊断日志本身泄密。

## 练习

1. **画出自己项目的 memdir。** 在项目里运行带记忆的会话，检查 `~/.claude/projects/<sanitized-git-root>/memory/` 的目录结构，`MEMORY.md` 索引与主题文件如何分工；再验证 `team/` 子目录是否存在。用 `stat` 检查权限位，理解为什么 auto-memory 落在 `~/.claude` 这类受控目录。

2. **验证注入上限与相关记忆开关。** 把一个 `MEMORY.md` 写到超过 200 行，观察注入时按行截断并附加警告的行为；在支持 `tengu_moth_copse` 的构建里开启相关记忆，观察索引不再直接注入 system prompt、而是异步选择最多 5 个主题文件。

3. **推演同步时序。** 用 `fs.watch` 与 debounce 的语义推演，本地编辑后 2 秒内再次编辑会发生什么？push 正在进行时新的文件事件会怎样？删除本地 `team/` 文件后，下一次 pull 为什么还会把它恢复回来？

## 自测

1. `syncTeamMemory()` 为什么必须先 pull 再 push，且 pull 失败就不 push？
2. `MEMORY.md` 的注入上限是多少？超限后行为是什么？
3. 密钥扫描为什么返回 `ruleId` 和 `label` 而不是命中的秘密值？

<details>
<summary>参考答案</summary>

1. **server-first 总语义。** `syncTeamMemory()` 的 pull 带 `skipEtagCache: true` 强制对齐，服务端同 key 内容覆盖本地；pull 失败时不继续 push，避免拿过期本地状态覆盖未知远端状态。单独的 `pushTeamMemory()` 才采用 local-wins，并按 SHA-256 差集只上传变化的 key，`412` 冲突最多重试 2 次。

2. **最多 200 行、25,000 字符。** 超出后先按行截断，再按最后一个换行位置截断字节，并附加警告；代价是排在后面的条目不可见，所以 prompt 要求索引保持简短。

3. **防止诊断泄密。** 如果 `SecretMatch` 携带真实秘密值，日志、遥测和 UI 都可能把它带出去。只保留 `ruleId`（哪条规则命中）和人类可读 `label`，既能定位被跳过的文件，又不把秘密复制到第二处。

</details>

## 回顾｜本章的记忆检索与同步链路

<details>
<summary>展开查看回顾</summary>

memdir 把长期记忆拆成项目作用域的目录、短索引和可按需读取的主题文件。它用路径解析和功能开关决定存储位置，用 prompt 约束内容与更新方式，用索引或相关性选择器控制上下文注入，并用年龄提醒把旧记忆降回「待验证线索」。

Team Memory 在这套文件协议上增加 `team/` 共享作用域。它只同步团队子目录，启动时先 pull 再 watch，本地变化经 debounce、密钥扫描和 delta push 送往服务端；远端内容落盘前还要经过路径与符号链接校验。私有内容不进入同步 payload，共享内容也不因为「来自团队」就自动可信。

从架构上看，Session Memory 负责发现候选知识，memdir 负责保存与检索，Team Memory 负责受控共享。三者接起来，才形成从一次会话到未来会话、再到同一项目团队成员的记忆链路。

</details>

## 留给下一篇的问题

普通用户可以使用 Claude Code 的 Team Memory 吗？

## 相关链接

- **上一篇**，[40 如何从会话中提炼知识](./40-session-memory.md)，`summary.md` 的完整生命周期
- **下一篇**，[42 AutoDream 如何在后台自动整合记忆](./42-auto-dream.md)，回答 Team Memory 可用性问题
- **平行阅读**，[16 项目上下文如何组装并注入](./16-system-prompt-and-project-context.md)，`MEMORY.md` 注入的位置
- [Claude Code Memory](https://code.claude.com/docs/en/memory)
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Explore the context window](https://code.claude.com/docs/en/context-window)
- [Using Claude Code， session management and 1M context](https://claude.com/blog/using-claude-code-session-management-and-1m-context)
- [Session memory compaction](https://platform.claude.com/cookbook/misc-session-memory-compaction)
- [Claude Code /compact， What It Does, What Survives](https://okhlopkov.com/claude-code-compaction-explained/)
