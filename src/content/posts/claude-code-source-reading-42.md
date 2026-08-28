---
title: "Claude Code源码解读42：AutoDream 如何在后台自动整合记忆 🔬"
published: 2026-07-24T16:47:29+08:00
updated: 2026-08-28
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-42/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇的问题是，**普通用户可以使用 Claude Code 的 Team Memory 吗？**

答案先放在前面，**普通用户不能靠修改 `settings.json` 把 Team Memory 强行打开，但普通账号也不是永远不能用。** 是否可用取决于发行版是否编译进了 Team Memory、账号是否被灰度开关放行，以及你要的是本地 `team/` 目录还是面向团队的远端同步。

### 先分清“本地 Team Memory”和“远端同步”

这两个词经常被混在一起，源码实际上把它们拆成了不同的门槛，

| 能力 | 源码中的必要条件 | 不满足时的结果 |
| --- | --- | --- |
| 本地读取和注入 `team/` | 构建期 `TEAMMEM`、auto memory 开启、GrowthBook 的 `tengu_herring_clock` 为 `true` | 不生成 combined Team Memory prompt；普通配置不能补上构建期能力 |
| 从服务端 pull / 向服务端 push | 上一行条件，再加第一方 Anthropic OAuth、有效 access token，以及 inference/profile 两个 scope | 本地记忆即使存在，也不会远端同步；API key、BYOK 或其他 provider 不满足这道门 |
| 自动持续同步 | 上一行条件，再加 `github.com` 的仓库 remote | watcher 不启动；没有 GitHub remote 的项目不会建立团队同步 |

因此，“能不能使用”至少要先问清楚是哪一种，没有远端同步时，某个已经被放行的构建仍可能在本机读取或写入 `team/`；但这不意味着其他成员会看到相同内容。

### 第一层｜`TEAMMEM` 是构建期能力，不是设置项

`feature('TEAMMEM')` 来自 `bun:bundle`。`setup.ts` 只有在这个编译期常量为 `true` 时，才会动态加载 `startTeamMemoryWatcher()`；如果构建时为 `false`，相关分支会被裁剪，运行时再改 `settings.json` 也无法把它变回来。这里要区分两个事实，还原源码能证明它是编译期 gate，但不能仅凭 source map 证明你手上的每一个公开构建最终把该常量编译成了什么值。

### 第二层｜账号还要通过灰度开关

本地 Team Memory 的运行时判断是，

```ts
export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) return false
  return getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_herring_clock',
    false,
  )
}
```

这意味着 auto memory 关闭时，Team Memory 一定关闭；auto memory 开启也不够，还要让 `tengu_herring_clock` 返回 `true`。它的静态回退值是 `false`，所以这不是普通用户可以在设置文件里填一个字段就能打开的功能。源码还显示，`CLAUDE_INTERNAL_FC_OVERRIDES` 这类 GrowthBook 环境覆盖只在 `USER_TYPE === 'ant'` 时生效，不能当成普通用户开关。

### 第三层｜远端同步只接受第一方 OAuth

`isTeamMemorySyncAvailable()` 直接返回 `isUsingOAuth()`。后者还会检查 API provider 必须是 `firstParty`、base URL 必须是 Anthropic 第一方地址、token 必须有 access token，并且同时具备 inference 和 profile scope。也就是说，使用 API key、Bedrock、Vertex、其他兼容 provider，或者只有不完整 scope 的登录状态，都不能走远端 Team Memory 同步。

watcher 的启动顺序也很明确，先检查 `TEAMMEM` 和两个运行时开关，再调用 `getGithubRepo()`；只有解析到 `github.com/owner/repo` 才会先 pull 一次团队记忆，随后建立文件 watcher。没有 GitHub remote 时，源码会记录 `no github.com remote, skipping sync` 并退出这条同步路径。

### 所以普通用户到底能不能用？

- 如果当前安装的公开构建没有把 `TEAMMEM` 编译进去，答案是不能；改配置、改普通环境变量都无效。
- 如果发行版包含该能力，账号又被 `tengu_herring_clock` 灰度放行，那么普通的第一方 OAuth 账号可以使用本地 Team Memory；源码没有要求必须是内部用户。
- 如果还想和团队共享，就必须继续满足 OAuth scope 和 GitHub remote 条件。API key 用户即使能运行其他 Claude Code 功能，也不能因此获得远端 Team Memory。
- 如果你只是想让团队共享稳定的项目约定，官方当前文档公开推荐的仍是通过版本控制共享项目 `CLAUDE.md`；Auto memory 则是机器本地的记忆机制。这和源码里受灰度控制的 `team/` 目录不是同一个产品入口。

外部对这段 source map 的拆解，也把 Team Memory 描述为“同一组织中、经过认证且操作同一仓库的用户共享团队目录”，并强调文件会先经过 secret guard，再由 watcher 批量同步。这些分析与源码的 OAuth、GitHub 和密钥扫描分支相互印证，但它们是源码分析文章，不应被当成 Anthropic 对公开账号资格的官方承诺。

## 介绍本章的一些概念

- AutoDream 是一条**成本受控的后台维护流水线**，`stopHooks` 提供触发机会 → 五道门（开关/运行模式、24 小时、10 分钟节流、会话数、跨进程锁）→ forked agent 四阶段整合（Orient → Gather → Consolidate → Prune/Index）。
- **默认门槛是 24 小时 + 5 个会话**；GrowthBook 的 `tengu_onyx_plover` 只能提供合法正数覆盖这两个调度阈值，不能覆盖 enabled gate 之外的运行时边界。
- **互斥租约**，`.consolidate-lock` 的正文是 PID、mtime 是最后整合时间；`tryAcquireConsolidationLock()` 通过 PID 复读缩小竞争窗口，`HOLDER_STALE_MS` 一小时允许回收死进程的锁。成功不更新 mtime（保持自然成为下次基线），失败/ kill 用 `rollbackConsolidationLock()` 恢复旧时间。
- 后台 fork 的权限边界，Bash 只允许 `tool.isReadOnly()` 通过，Edit/Write 仅限 auto-memory 目录内的路径，其余工具一律 deny，能查项目与 transcript，不能改代码。
- 产物仍是普通文件（topic + `MEMORY.md` 入口），由未来会话的 `loadMemoryPrompt()` 与 `getMemoryFiles()` 正常消费；**「生成过」不等于「必然正确」**。
- 证据边界，默认阈值、门控顺序、锁与回滚都可确认；GrowthBook 真实取值、模型是否挑对事实、并发文件修改的最终一致性仍属运行时证据。

> 🔬 **可选实验子系统**，AutoDream 是受 `tengu_onyx_plover` 灰度开关与 `autoDreamEnabled` 设置控制的后台记忆整合实验。默认不每轮运行，也不出现在普通会话中；不影响理解内核，可跳过。

## 本篇新增

承接 41 篇的记忆文件协议，本章引入三个概念，

- **记忆整合任务（memory consolidation）**，后台 Agent 读取近期记忆，合并重复主题、修正索引并保留可追溯信息。
- **触发门**，轮次状态、token 增量、冷却期与功能开关共同决定是否启动维护。
- **互斥租约**，运行锁限定同一项目的并发 Dream 数量，并在所有终态释放。

![AutoDream 的触发门、后台任务与记忆写回](/images/posts/claude-code-source-reading-42/42-dream-gates-detail-handdrawn.png)

先把「何时尝试」「允许谁执行」和「失败后如何释放锁」分开，后文的五道门就不会被误读成一个时间定时器。

## 问题

本篇把 AutoDream 还原成后台维护任务：触发门槛筛选值得整合的会话，锁和任务状态避免并发重复，后台提示词负责重组记忆，进度与失败则通过旁路回收。它改变的是记忆维护时机，不改变主 Agent 的工具权限和会话控制流。

上一篇（41）的问题是，**普通用户可以使用 Claude Code 的 Team Memory 吗？**

答案先放在前面，**普通用户不能靠修改 `settings.json` 把 Team Memory 强行打开，但普通账号也不是永远不能用。** 是否可用取决于发行版是否编译进了 Team Memory、账号是否被灰度开关放行，以及你要的是本地 `team/` 目录还是面向团队的远端同步。

### 先分清「本地 Team Memory」和「远端同步」

这两个词经常被混在一起，源码实际上把它们拆成了不同的门槛，

| 能力 | 源码中的必要条件 | 不满足时的结果 |
| --- | --- | --- |
| 本地读取和注入 `team/` | 构建期 `TEAMMEM`、auto memory 开启、GrowthBook 的 `tengu_herring_clock` 为 `true` | 不生成 combined Team Memory prompt；普通配置不能补上构建期能力 |
| 从服务端 pull / 向服务端 push | 上一行条件，再加第一方 Anthropic OAuth、有效 access token，以及 inference/profile 两个 scope | 本地记忆即使存在，也不会远端同步；API key、BYOK 或其他 provider 不满足这道门 |
| 自动持续同步 | 上一行条件，再加 `github.com` 的仓库 remote | watcher 不启动；没有 GitHub remote 的项目不会建立团队同步 |

因此，「能不能使用」至少要先问清楚是哪一种，没有远端同步时，某个已经被放行的构建仍可能在本机读取或写入 `team/`；但这不意味着其他成员会看到相同内容。

### 第一层｜`TEAMMEM` 是构建期能力，不是设置项

`feature('TEAMMEM')` 来自 `bun:bundle`。`setup.ts` 只有在这个编译期常量为 `true` 时，才会动态加载 `startTeamMemoryWatcher()`；如果构建时为 `false`，相关分支会被裁剪，运行时再改 `settings.json` 也无法把它变回来。这里要区分两个事实，还原源码能证明它是编译期 gate，但不能仅凭 source map 证明你手上的每一个公开构建最终把该常量编译成了什么值。

### 第二层｜账号还要通过灰度开关

本地 Team Memory 的运行时判断是，

```ts
export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) return false
  return getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_herring_clock',
    false,
  )
}
```

> 证据，`restored-src/src/memdir/teamMemPaths.ts`（2.1.88 source map 还原源码）。

这意味着 auto memory 关闭时，Team Memory 一定关闭；auto memory 开启也不够，还要让 `tengu_herring_clock` 返回 `true`。它的静态回退值是 `false`，所以这不是普通用户可以在设置文件里填一个字段就能打开的功能。源码还显示，`CLAUDE_INTERNAL_FC_OVERRIDES` 这类 GrowthBook 环境覆盖只在 `USER_TYPE === 'ant'` 时生效，不能当成普通用户开关。

### 第三层｜远端同步只接受第一方 OAuth

`isTeamMemorySyncAvailable()` 直接返回 `isUsingOAuth()`。后者还会检查 API provider 必须是 `firstParty`、base URL 必须是 Anthropic 第一方地址、token 必须有 access token，并且同时具备 inference 和 profile scope。也就是说，使用 API key、Bedrock、Vertex、其他兼容 provider，或者只有不完整 scope 的登录状态，都不能走远端 Team Memory 同步。

watcher 的启动顺序也很明确，先检查 `TEAMMEM` 和两个运行时开关，再调用 `getGithubRepo()`；只有解析到 `github.com/owner/repo` 才会先 pull 一次团队记忆，随后建立文件 watcher。没有 GitHub remote 时，源码会记录 `no github.com remote, skipping sync` 并退出这条同步路径。

### 所以普通用户到底能不能用？

- 如果当前安装的公开构建没有把 `TEAMMEM` 编译进去，答案是不能；改配置、改普通环境变量都无效。
- 如果发行版包含该能力，账号又被 `tengu_herring_clock` 灰度放行，那么普通的第一方 OAuth 账号可以使用本地 Team Memory；源码没有要求必须是内部用户。
- 如果还想和团队共享，就必须继续满足 OAuth scope 和 GitHub remote 条件。API key 用户即使能运行其他 Claude Code 功能，也不能因此获得远端 Team Memory。
- 如果你只是想让团队共享稳定的项目约定，官方当前文档公开推荐的仍是通过版本控制共享项目 `CLAUDE.md`；Auto memory 则是机器本地的记忆机制。这和源码里受灰度控制的 `team/` 目录不是同一个产品入口。

外部对这段 source map 的拆解，也把 Team Memory 描述为「同一组织中、经过认证且操作同一仓库的用户共享团队目录」，并强调文件会先经过 secret guard，再由 watcher 批量同步。这些分析与源码的 OAuth、GitHub 和密钥扫描分支相互印证，但它们是源码分析文章，不应被当成 Anthropic 对公开账号资格的官方承诺。

## 正文

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的片段只保留证明当前控制流所需的分支，省略遥测和无关字段；还原路径不代表 Anthropic 内部仓库的原始组织方式。

### 这张金额单位工单结束后，记忆整合可能在后台发生

工程师已经在 17，40 关闭工单，主会话给出根因、改动和测试报告，他合上电脑离开值班室。几分钟后，后台仍可能在整理这次长会话，多轮调查中「先怀疑前端」「后来确认回调单位」的临时结论要合并，重复的文件路径要去掉，最终 runbook 入口要留下。用户看到的只是主任务完成，并不会看到一条新的对话抢走终端。

同一张金额单位工单经历多轮调查、分支、压缩和恢复后，回合结束会给 AutoDream 一个触发机会。它不会因为用户说了一句「记住」就无条件运行，而是继续检查开关、运行模式、账号、token、锁和当前任务状态；通过门槛后，后台 fork 才会用受限提示词整合记忆。DreamTask 负责进度、取消、锁释放和失败回收，整合失败也不应让已经完成的主任务重新执行。

![Claude Code AutoDream 从轮次结束、门槛检查到未来会话读取记忆的流程](/images/posts/claude-code-source-reading-42/42-auto-dream-handdrawn.png)

### 三个基础概念

第一个概念是 **memory consolidation**，记忆整合。它回看已有内容，合并重复项、删除已经被推翻的事实、把相对日期改成绝对日期，并维持一个足够短的入口索引。追加负责捕获事实，整合负责让未来会话仍能找到并理解这些事实。

第二个概念是 **forked agent**。AutoDream 不把整合提示词插入主消息链，而是复制一份可共享 prompt cache 的上下文，创建隔离的查询循环。这样主回答已经结束，后台 Agent 仍可继续调用模型和工具；它的可变文件状态、权限和取消信号又不必与主循环混成同一个对象。

第三个概念是 **lease-like lock**。`.consolidate-lock` 既保存持有进程 PID，也把文件 mtime 当作最后整合时间。两个进程可能同时尝试写入，所以获取后还要重读 PID 验证谁赢了；进程崩溃后，下一次运行则可根据 PID 是否存活和锁年龄回收它。

把三个概念连起来，AutoDream 的主线就很清楚了，轮次结束只是检查机会，门槛负责控制成本，锁负责减少重复执行，后台 Agent 负责真正的语义整理，普通记忆加载链路负责让结果在未来生效。

### Auto Memory 和 AutoDream：一个负责记，一个负责整理

这里要先把两个容易混在一起的词拆开。官方文档里的 **Auto memory** 是跨会话积累知识的持久化机制：主 Agent 可以在对话中直接保存，轮次结束后，源码还会让 `ExtractMemories` 这个 forked agent 检查最近消息，补上主 Agent 漏掉的长期信息。**AutoDream** 则是更低频的 consolidation pass，面对的是已经存在的一批记忆，负责去重、纠错、删掉过期入口并重建索引。它们都可能触碰 `MEMORY.md`，但这里的文件角色始终是索引；真正的记忆内容位于独立的 topic 文件中。官方文档也明确把 `MEMORY.md` 描述为每行一个记忆入口，而不是内容仓库（[How Claude remembers your project](https://code.claude.com/docs/en/memory)）。

| 对比项 | Auto Memory（含 `ExtractMemories` 补捞） | AutoDream |
| --- | --- | --- |
| 核心职责 | 把当前对话中值得跨会话保留的新信息写成记忆 | 把多轮会话积累的记忆重新合并、校正和裁剪 |
| 主要对象 | 当前轮次的消息，以及待写入或更新的 topic 文件 | 整个 memory 目录、历史 transcript 和最近变更的会话 |
| 触发时机 | 主 Agent 工作中可直接写；主轮次结束后再由 `ExtractMemories` 异步补捞 | 同样在主轮次结束时获得检查机会，但只有调度门槛通过才启动 |
| `MEMORY.md` 的作用 | 新建记忆时通常追加一个 topic 指针；已有指针不必重复改写 | Phase 4 清理失效指针、压缩过长入口并补齐重要指针 |
| 频率与门槛 | 没有 AutoDream 的 24 小时/5 会话门槛；仍受功能开关、主 Agent、Remote 等条件约束 | `2.1.88` 静态默认至少间隔 24 小时、积累 5 个其他会话，并以 10 分钟扫描节流控制检查成本；这些调度值可被远程实验配置覆盖 |

因此，一轮结束时的统一时序是：

```text
主 Agent 在会话中发现新信息
    └─ 直接写入 topic（必要时同步 MEMORY.md 索引）

主轮次结束
    ├─ ExtractMemories：若主 Agent 本轮没有写 memory，就 fork 检查最近消息并补捞
    │                    正常路径写 topic + MEMORY.md；skipIndex 实验路径只写 topic
    └─ AutoDream：低频检查时间、会话积累和锁，满足门槛后批量整理 topic + MEMORY.md
```

`skipIndex` 不是 AutoDream 的另一种触发方式，而是 `ExtractMemories` 提示词的索引例外：`tengu_moth_copse` 开启时，补捞 Agent 仍可按类型写入独立 topic，但提示词会移除“第二步：在 `MEMORY.md` 添加指针”。这说明“可能修改 `MEMORY.md`”不是两个系统都在每轮重写索引：Auto Memory 的正常保存路径和 AutoDream 的整理阶段会维护它，具体是否写入仍取决于有没有新入口或需要清理；topic 文件才是两条路径共同维护的事实载体。

### 轮次结束提供触发机会

启动阶段的 `restored-src/src/utils/backgroundHousekeeping.ts` 中，`startBackgroundHousekeeping()` 会调用 `initAutoDream()`，后者只安装一个 closure-scoped runner。真正尝试运行发生在 `restored-src/src/query/stopHooks.ts` 的 `handleStopHooks()`，主 Agent 完成本轮采样后，代码以 fire-and-forget 方式调用 `executeAutoDream()`。

```ts
// restored-src/src/query/stopHooks.ts
if (!isBareMode()) {
  // prompt suggestion and extraction omitted
  if (!toolUseContext.agentId) {
    void executeAutoDream(
      stopHookContext,
      toolUseContext.appendSystemMessage,
    )
  }
}
```

> 证据，`restored-src/src/query/stopHooks.ts`（2.1.88 source map 还原源码），`handleStopHooks()` 的轮次收尾入口。这里的 `void executeAutoDream(...)` 表明调用方不等待 Dream 完成；`!toolUseContext.agentId` 又把触发限制在主线程，避免一个 subagent 结束时再递归启动新的 Dream。

`stopHookContext` 携带当前 system prompt、user/system context、消息和 `toolUseContext`，供 fork 复用缓存安全参数；`appendSystemMessage` 是可选回调，可能为 `undefined`，缺失时 Dream 仍可执行，只是不向主 transcript 追加完成摘要。`isBareMode()` 为 `true` 时，prompt suggestion、memory extraction 和 AutoDream 整组后台维护都会跳过；这也是 `-p` 使用 bare/simple 运行时不会在退出阶段额外争用资源的边界。

`restored-src/src/services/autoDream/autoDream.ts` 里的 `executeAutoDream()` 自己很薄，`initAutoDream()` 尚未执行时，`runner` 为 `null`，可选调用直接成为 no-op；初始化以后，runner 内部保存本进程上一次扫描会话的时间。

```ts
let runner:
  | ((context: REPLHookContext,
      appendSystemMessage?: AppendSystemMessageFn) => Promise<void>)
  | null = null

export async function executeAutoDream(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessageFn,
): Promise<void> {
  await runner?.(context, appendSystemMessage)
}
```

> 证据，`restored-src/src/services/autoDream/autoDream.ts`（2.1.88 source map 还原源码），`executeAutoDream()` 是稳定入口，实际实现由 `initAutoDream()` 写入 `runner`。初始化前 `runner` 为 `null`，可选调用直接结束；初始化后才等待真正的维护函数。这让测试可以在每个 case 里重新初始化 closure，也让调用点保持统一。

`context` 必填；传入 `appendSystemMessage` 时，成功且确实触碰文件后可向主 transcript 追加摘要，省略时 Dream 仍执行，只跳过通知。可选链只处理未初始化，不吞掉 runner 内部异常；实际 runner 对读取门槛和 fork 失败分别处理。

「24 小时门槛」在主轮次结束并调用 runner 时检查。AutoDream 不创建独立常驻 timer，因此 Claude Code 停止运行期间不会自行唤醒。

### 五道门决定这次要不要 Dream

五道门不是同一层的重复判断，第一道决定功能是否存在，第二和第三道限制调度频率，第四道选择候选会话，第五道处理跨进程竞争。只有拿到锁之后，模型调用和文件写入才会发生。

#### 第一关｜开关和运行模式

`autoDream.ts` 的 `isGateOpen()` 先排除 KAIROS、Remote 和 auto-memory 关闭状态，再读取 `restored-src/src/services/autoDream/config.ts` 里的 AutoDream 开关，

```ts
function isGateOpen(): boolean {
  if (getKairosActive()) return false
  if (getIsRemoteMode()) return false
  if (!isAutoMemoryEnabled()) return false
  return isAutoDreamEnabled()
}

export function isAutoDreamEnabled(): boolean {
  const setting = getInitialSettings().autoDreamEnabled
  if (setting !== undefined) return setting
  const gb = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_onyx_plover',
    null,
  )
  return gb?.enabled === true
}
```

> 证据，`restored-src/src/services/autoDream/autoDream.ts` 与 `config.ts`（2.1.88 source map 还原源码）。`isGateOpen()` 是 AutoDream 的组合开关。KAIROS 模式使用另一套 disk-skill dream；Remote 被明确排除；auto-memory 关闭时目标目录为空。`isAutoDreamEnabled()` 则实现「用户设置优先，实验配置兜底」。

两个函数都接受零个参数。`autoDreamEnabled` 可为 `true`、`false` 或 `undefined`，前两个值明确覆盖服务端默认，`undefined` 才读取 `tengu_onyx_plover`；远端值只有严格 `enabled === true` 才开启，`false`、缺失、`null` 或错误形状都落到关闭。`isAutoMemoryEnabled()` 还有环境变量、bare/simple、Remote 持久化目录和 `autoMemoryEnabled` 设置的优先级，本章不重复展开。

注意一个证据边界，默认阈值写在源码里，功能是否向某个运行环境开放仍属于运行时数据。

#### 第二关｜距离上次成功是否足够久

`autoDream.ts` 的调度配置由同一个 feature value 提供，但每个字段都独立校验。无法得到正的有限数时，回退到 `24` 小时和 `5` 个会话，

```ts
const DEFAULTS = { minHours: 24, minSessions: 5 }

function getConfig(): AutoDreamConfig {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_onyx_plover',
    null,
  )
  return {
    minHours:
      typeof raw?.minHours === 'number' &&
      Number.isFinite(raw.minHours) && raw.minHours > 0
        ? raw.minHours : DEFAULTS.minHours,
    minSessions:
      typeof raw?.minSessions === 'number' &&
      Number.isFinite(raw.minSessions) && raw.minSessions > 0
        ? raw.minSessions : DEFAULTS.minSessions,
  }
}
```

> 证据，`restored-src/src/services/autoDream/autoDream.ts`（2.1.88 source map 还原源码），`getConfig()` 只返回调度阈值，不负责 enabled gate。两个字段各自校验，所以一个字段合法、另一个字段错误时，只回退错误的那一个。

函数接受零个参数。`minHours`、`minSessions` 只有正且有限的 number 才进入比较；`0`、负数、`NaN`、`Infinity`、字符串、`null` 和 `undefined` 分别让对应字段回退到 24 小时或 5 个会话。`minSessions` 保持 JavaScript number，正小数会直接参与比较。

上次成功时间来自 `.consolidate-lock` 的 mtime。文件不存在时 `readLastConsolidatedAt()` 返回 `0`，第一次检查自然会跨过时间门槛。读取失败也被归到 `0`，但 runner 外层读取调用仍包了 catch，以防 `stat` 之外的实现异常。

#### 第三关｜十分钟扫描节流

只要时间门槛已经通过，而会话数量还不够，锁的 mtime 就不会更新。若每个用户回合都重新扫描 transcript 目录，会把一个便宜的时间判断变成频繁的文件系统遍历。源码因此用 closure 里的 `lastSessionScanAt` 做十分钟节流。

节流只存在于当前进程内，也只在时间门槛通过后生效。重启进程会把它恢复为 `0`，另一个 Claude Code 进程也有自己的值；跨进程协调由后面的锁承担。

#### 第四关｜最近有多少会话发生过变化

`restored-src/src/services/autoDream/consolidationLock.ts` 中，会话候选来自当前 cwd 对应的 transcript 目录，

```ts
export async function listSessionsTouchedSince(
  sinceMs: number,
): Promise<string[]> {
  const dir = getProjectDir(getOriginalCwd())
  const candidates = await listCandidates(dir, true)
  return candidates
    .filter(c => c.mtime > sinceMs)
    .map(c => c.sessionId)
}

sessionIds = sessionIds.filter(id => id !== getSessionId())
if (!force && sessionIds.length < cfg.minSessions) return
```

> 证据，`restored-src/src/services/autoDream/consolidationLock.ts`（2.1.88 source map 还原源码），`listSessionsTouchedSince()` 取出 mtime 晚于上次整合时间的 session ID。`listCandidates()` 负责 UUID 校验和并行 stat，并排除 `agent-*.jsonl`；调用方再排除当前 session，因为它在刚结束一轮后必然是「最近修改」。

`sinceMs` 是必填毫秒时间戳，这里传锁文件的旧 mtime。筛选条件是严格 `>`，等于边界的文件被排除。`listCandidates(dir, true)` 的第二个参数是 `doStat`，`true` 表示对每个候选执行 stat 并填入 mtime；最终返回开放的 session ID 字符串数组。`force` 在外部 2.1.88 构建中固定为 `false`，注释说明内部测试构建可绕过 enabled/time/session gate；该覆盖不属于外部用户功能。

这里按文件 mtime 选择候选。更新时间较新的会话可能进入 ID 提示，其他 cwd 或 worktree 目录下的会话则可能被漏掉。源码注释把这种漏计视为安全的 skip-gate，本轮最多延后触发，错误会话不会被强行加入当前上下文。

#### 第五关｜跨进程锁

`consolidationLock.ts` 中，`.consolidate-lock` 的正文是 PID，mtime 是上次整合时间。获取流程先并行读取两者；一小时以内且 PID 仍存活时返回 `null`，调用方直接放弃。PID 已死、正文不可解析，或者锁已经超过一小时，都允许回收。

```ts
const HOLDER_STALE_MS = 60 * 60 * 1000

export async function tryAcquireConsolidationLock(
): Promise<number | null> {
  // read previous mtime and PID omitted
  if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
    if (holderPid !== undefined && isProcessRunning(holderPid)) {
      return null
    }
  }

  await mkdir(getAutoMemPath(), { recursive: true })
  await writeFile(path, String(process.pid))
  const verify = await readFile(path, 'utf8')
  if (parseInt(verify.trim(), 10) !== process.pid) return null
  return mtimeMs ?? 0
}
```

> 证据，`restored-src/src/services/autoDream/consolidationLock.ts`（2.1.88 source map 还原源码），`tryAcquireConsolidationLock()` 尝试占有锁，并返回写入前的 mtime，供失败回滚；被活进程阻挡、读回失败或竞争失败时返回 `null`。两个竞争者都可能写文件，最后一次写入者通过 PID 复读获胜，另一个退出。

函数接受零个参数。返回正数时把旧 mtime 交给失败回滚，返回 `0` 时表示原先无锁、失败后应删除新锁，返回 `null` 时调用方跳过本轮 Dream。`holderPid` 或 `mtimeMs` 省略时跳过对应存活/年龄判断；正文 `parseInt` 得到非有限数时按无有效持有者处理。`HOLDER_STALE_MS` 固定为一小时，即使 PID 仍存活，超过该年龄也会被回收，以降低 PID 复用导致永久阻塞的风险。

这个锁通过 PID 复读缩小竞争窗口，但未提供分布式文件系统上的强一致保证。静态源码的触发条件只包含门控、时间、会话数和锁；网络、电量或系统空闲状态不在这套模型中。

### Dream 用四阶段提示词维护记忆

通过门槛后，runner 不会直接把 session 内容拼成一个巨型 prompt。它计算 auto-memory 根目录与 transcript 目录，再调用 `restored-src/src/services/autoDream/consolidationPrompt.ts` 的 `buildConsolidationPrompt(memoryRoot, transcriptDir, extra)`。提示词把任务拆成四阶段，

1. **Orient**，列出记忆目录，读取 `MEMORY.md`，浏览已有 topic，避免重复造文件。
2. **Gather recent signal**，优先看 daily logs，再找与当前事实漂移的旧记忆；只有需要具体上下文时，才用窄关键词搜索 JSONL。
3. **Consolidate**，把值得保留的信息写入或合并到 topic 文件，绝对化日期，删除被证伪的事实。
4. **Prune and index**，清掉错误或过期指针，缩短过长索引项，把 `MEMORY.md` 保持在 200 行和约 25KB 以内。

其中「日志、漂移记忆、transcript」是提示词给出的粗略优先级。提示词要求按需搜索已经怀疑重要的 transcript；`extra` 追加本次发现的 session ID 列表和后台权限说明，Agent 再自行决定读取哪些文件。

```ts
export function buildConsolidationPrompt(
  memoryRoot: string,
  transcriptDir: string,
  extra: string,
): string {
  return `# Dream: Memory Consolidation
  ...
  Memory directory: \`${memoryRoot}\`
  Session transcripts: \`${transcriptDir}\`
  ...
  Return a brief summary ...${
    extra ? `\n\n## Additional context\n\n${extra}` : ''
  }`
}
```

> 证据，`restored-src/src/services/autoDream/consolidationPrompt.ts`（2.1.88 source map 还原源码），`buildConsolidationPrompt()` 构造手动 `/dream` 与 AutoDream 可共享的整合主提示词。后台特有的只读 Bash 说明放在 `extra`，避免手动 `/dream` 在主循环正常权限下看到错误约束。

`memoryRoot` 与 `transcriptDir` 都是已解析的绝对目录字符串，并分别写入提示词的记忆与 transcript 位置；路径校验由上游完成。`extra` 为空字符串时省略 `Additional context`，非空时原样追加 session ID 与后台权限说明。索引上限来自 `MAX_ENTRYPOINT_LINES = 200`，字节目标来自提示词中的约 25KB；每条索引建议小于约 150 字符，超过约 200 字符会被视为应下沉到 topic 的内容。

四阶段的顺序有明确作用。「先读、再写」能减少近义重复；「先合并、后索引」让入口指向最终文件；最后单独 prune，把错误记忆直接删除，避免持续追加互相矛盾的说明。

### 后台 Agent 复用内核，但换掉权限与持久化边界

真正执行发生在 `autoDream.ts`，底层复用 `restored-src/src/utils/forkedAgent.ts` 的 `runForkedAgent()`，

```ts
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: prompt })],
  cacheSafeParams: createCacheSafeParams(context),
  canUseTool: createAutoMemCanUseTool(memoryRoot),
  querySource: 'auto_dream',
  forkLabel: 'auto_dream',
  skipTranscript: true,
  overrides: { abortController },
  onMessage: makeDreamProgressWatcher(taskId, setAppState),
})
```

> 证据，`restored-src/src/services/autoDream/autoDream.ts`（2.1.88 source map 还原源码）。`runForkedAgent()` 创建隔离的 subagent context，再进入与主 Agent 共用的 `query()` / `queryLoop()`。它累计完整 token usage，并把每条产出交给进度 watcher；AutoDream 因而复用主运行时的模型客户端和工具循环。

`promptMessages` 这里只有一个 user message；`cacheSafeParams` 继承 system prompt、user/system context、工具上下文和父消息前缀，以争取 prompt cache 命中。`querySource` 与 `forkLabel` 都固定为 `'auto_dream'`，用于来源和遥测。`skipTranscript: true` 只跳过这个 fork 自己的 sidechain transcript 写入，历史 transcript 仍可通过 Read/Grep 获取。`overrides.abortController` 允许任务面板终止 fork；`onMessage` 可选，这里用于 UI 进度。这个调用点省略 `maxTurns` 和 `maxOutputTokens`，两者沿 `runForkedAgent` 默认路径处理。

隔离上下文同时配有一组受限工具能力，

- REPL 外壳可以调用，但内部 primitive 仍会再次经过同一个 `canUseTool`。
- Read、Grep、Glob 不限制读取路径，因为它们本身只读。
- Bash 只有 `tool.isReadOnly()` 判断通过才允许；重定向写文件或修改状态会拒绝。
- Edit、Write 只有 `file_path` 是字符串且位于 auto-memory 目录时才允许。
- 其他工具统一返回 `behavior: 'deny'`，直接结束该工具请求。

这条边界解释了 AutoDream 为什么能查项目和 transcript，却不能顺手改代码或调用外部副作用工具。权限以工具实际输入为准，不靠提示词里一句「请只读」自律。

### DreamTask 把看不见的 fork 变成可取消状态

在启动 fork 以前，runner 会先用 `restored-src/src/tasks/DreamTask/DreamTask.ts` 注册 `DreamTask`，

```ts
const task: DreamTaskState = {
  ...createTaskStateBase(id, 'dream', 'dreaming'),
  type: 'dream',
  status: 'running',
  phase: 'starting',
  sessionsReviewing: opts.sessionsReviewing,
  filesTouched: [],
  turns: [],
  abortController: opts.abortController,
  priorMtime: opts.priorMtime,
}
```

> 证据，`restored-src/src/tasks/DreamTask/DreamTask.ts`（2.1.88 source map 还原源码），`DreamTaskState` 是通用 `TaskStateBase` 的判别分支。`type` 固定为 `'dream'`；`status` 初始为 `'running'`，终态可由通用任务框架表现为 `'completed'`、`'failed'` 或 `'killed'`；`phase` 只有 `'starting'` 与 `'updating'`，它不解析提示词中的四个语义阶段。

`sessionsReviewing` 是候选 session 数；`filesTouched` 初始空数组，只收集 watcher 看见的 Edit/Write `file_path`；`turns` 最多保留最近 30 个 assistant turn，并把 tool use 折叠为计数。`abortController` 运行时存在，完成、失败或终止后设为 `undefined`；`priorMtime` 必填，专供 kill 时回滚锁。

`makeDreamProgressWatcher()` 只处理 assistant message。它拼接 text block，统计 `tool_use`，遇到 Edit/Write 时提取 `file_path`。第一次观察到新路径后，phase 从 `starting` 变成 `updating`。因此 UI 上的 phase 是一个文件写入信号，不等同于 Agent 已经进入提示词的 Phase 3。

源码注释也提醒，`filesTouched` 只记录观察到的 Edit/Write block，可能低估真实触碰集合。当前权限会拒绝 Bash 写入，因此正常 AutoDream 的主要写路径可被覆盖；该数组仍只适合进度展示，不能承担文件系统事务审计。

### 成功、失败与终止怎样处理锁

锁的 mtime 在获取时已经被 `writeFile()` 更新为当前时间。成功路径故意不再改它，于是这个时间自然成为下一轮的 `lastConsolidatedAt`。随后任务标记完成；只有 watcher 确认至少触碰一个文件，并且主上下文提供 `appendSystemMessage` 时，才追加 `verb: 'Improved'` 的 memory saved message。

这条消息写入主 transcript，`MEMORY.md` 只接收 Dream 的实际编辑，fork 的中间推理也留在隔离上下文。`completeDreamTask()` 把 `notified` 直接设为 `true`，因为这条系统消息就是唯一 model-facing 通知；任务注册表需要 terminal + notified 才能正常淘汰。

失败路径则调用 `consolidationLock.ts` 的 `rollbackConsolidationLock()` 恢复旧时间，

```ts
export async function rollbackConsolidationLock(
  priorMtime: number,
): Promise<void> {
  if (priorMtime === 0) {
    await unlink(lockPath())
    return
  }
  await writeFile(lockPath(), '')
  const t = priorMtime / 1000
  await utimes(lockPath(), t, t)
}
```

> 证据，`restored-src/src/services/autoDream/consolidationLock.ts`（2.1.88 source map 还原源码），`rollbackConsolidationLock()` 把锁恢复到获取前状态。fork 抛错时 runner 调用它；用户从后台任务面板 kill 时，`DreamTask.kill()` 也走同一条路径。

`priorMtime` 是必填毫秒 number。值为 `0` 表示原本无锁文件，因此直接删除；非零值先清空 PID 正文，再把 atime/mtime 都恢复到对应秒数。函数 catch 所有文件错误并记 debug 日志后返回；若回滚失败，当前较新的 mtime 可能使下一次触发推迟到 `minHours` 以后。

用户 kill 还有一个容易忽略的去重边界。`DreamTask.kill()` 先 `abort()`、回滚并把状态设为 `'killed'`；fork 随后抛错进入 runner 的 catch 时，看到 `abortController.signal.aborted` 就直接返回，保留 killed 终态并跳过第二次回滚。普通异常才会执行 `failDreamTask()` 和回滚。

崩溃则不同。进程来不及进入 catch 时，新 mtime 会暂时保留；下一进程发现 PID 已死即可回收。若 PID 状态无法可靠判断，最长一小时的 stale 边界仍允许再次尝试。这套机制只恢复调度租约；AutoDream 已经落盘的 Edit 会保持现状。

### 结果怎样进入未来会话

AutoDream 的产物仍是普通文件，topic 保存具体内容，`MEMORY.md` 保存一行一个的入口。未来会话里，`restored-src/src/memdir/memdir.ts` 的 `loadMemoryPrompt()` 与 `restored-src/src/utils/claudemd.ts` 的 `getMemoryFiles()` 共同消费它们。

```ts
export async function loadMemoryPrompt(): Promise<string | null> {
  const autoEnabled = isAutoMemoryEnabled()
  // KAIROS / TEAMMEM branches omitted
  if (autoEnabled) {
    const autoDir = getAutoMemPath()
    await ensureMemoryDirExists(autoDir)
    return buildMemoryLines('auto memory', autoDir, extraGuidelines, skipIndex)
      .join('\n')
  }
  return null
}

// in getMemoryFiles()
if (isAutoMemoryEnabled()) {
  const { info } = await safelyReadMemoryFileAsync(
    getAutoMemEntrypoint(),
    'AutoMem',
  )
  if (info) result.push(info)
}
```

> 证据，`restored-src/src/memdir/memdir.ts` 与 `restored-src/src/utils/claudemd.ts`（2.1.88 source map 还原源码）。`loadMemoryPrompt()` 向 system prompt 提供 auto-memory 的目录、类型、写入和搜索规则；`getMemoryFiles()` 则把 `MEMORY.md` 当作 `AutoMem` 类型入口加入 Claude.md/记忆上下文。调用图可见，前者会被 `getSystemPrompt()` 和 `QueryEngine.submitMessage()` 等入口消费。

`loadMemoryPrompt()` 无参数，返回 `Promise<string | null>`；auto-memory 关闭时为 `null`。`extraGuidelines` 可为 `string[] | undefined`，只在 Cowork 环境变量存在且 trim 后非空时生成。`skipIndex` 来自 feature value，默认 `false`；为 `true` 时提示词使用「不维护索引」的保存规则。`safelyReadMemoryFileAsync()` 的路径来自 `getAutoMemEntrypoint()`，文件不存在或无法形成有效信息时 `info` 为空，不加入结果。

topic 文件并不会全部常驻模型窗口。正常模式始终加载的是精简入口，模型再根据链接和「搜索过去上下文」的规则选择性 Read/Grep。这样 AutoDream 改进索引后，未来会话更容易发现正确主题；是否点到哪个链接、是否采信 Dream 的内容，仍由后续会话决策和用户行为共同决定。

### 这套实现守住了哪些边界

第一，AutoDream 只维护个人 auto-memory 目录。KAIROS 直接跳过这条自动链路，TEAMMEM 的同步与冲突仍由 41 篇讨论的路径处理。

第二，锁只协调「是否启动整合」，每个 memory 文件仍按普通 Edit/Write 落盘。成功路径不生成 commit 清单，失败路径也保留已经完成的 Edit。提示词通过「先读已有内容、优先合并」降低冲突，但并发文件修改仍需实际运行和故障注入验证。

第三，候选 session 以 mtime 为依据。它能回答「哪些会话最近动过」，不能回答「哪条事实最重要」。语义筛选交给 forked Agent 的提示词和工具搜索，因此成本、质量与遗漏率都不能从阈值代码直接推导。

第四，后台运行仍受 bare/simple、Remote、KAIROS、auto-memory 和 AutoDream 开关约束；读目录、列会话、取锁、模型请求或写文件任一步失败，也可能提前返回或进入失败路径。

最后，静态源码能确认默认 `24h / 5 sessions / 10min scan throttle / 1h stale lock`，但 GrowthBook 可以提供合法正数覆盖前两个值。不能把源码默认值写成所有用户线上永远不变的产品承诺。

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。**MISSING** 表示实现不在 source map 中。

| 阶段 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| 触发 | `handleStopHooks()` → `void executeAutoDream(...)` | `src/query/stopHooks.ts` | 已确认 |
| 初始化 | `initAutoDream()` / closure runner / `startBackgroundHousekeeping()` | `src/services/autoDream/autoDream.ts`、`src/utils/backgroundHousekeeping.ts` | 已确认 |
| 第一关 | `isGateOpen()` / `isAutoDreamEnabled()` / `tengu_onyx_plover` | `autoDream.ts`、`config.ts` | 已确认 |
| 第二关 | `getConfig()` / `DEFAULTS = { minHours: 24, minSessions: 5 }` | `autoDream.ts` | 已确认（可被合法正数覆盖） |
| 第三关 | `lastSessionScanAt` 十分钟节流 | `autoDream.ts` | 已确认 |
| 第四关 | `listSessionsTouchedSince()` / `listCandidates(dir, true)` | `consolidationLock.ts` | 已确认 |
| 第五关 | `tryAcquireConsolidationLock()` / `HOLDER_STALE_MS = 1h` | `consolidationLock.ts` | 已确认 |
| 提示词 | `buildConsolidationPrompt()` 四阶段 / `MAX_ENTRYPOINT_LINES = 200` | `consolidationPrompt.ts` | 已确认 |
| 执行 | `runForkedAgent()`（`querySource: 'auto_dream'`、`skipTranscript`）+ `createAutoMemCanUseTool()` | `autoDream.ts`、`utils/forkedAgent.ts` | 已确认 |
| 任务 | `DreamTaskState` / `makeDreamProgressWatcher()`（`starting` → `updating`） | `src/tasks/DreamTask/DreamTask.ts` | 已确认 |
| 回滚 | `rollbackConsolidationLock()` / kill 去重（`signal.aborted`） | `consolidationLock.ts` | 已确认 |
| 消费 | `loadMemoryPrompt()` / `getMemoryFiles()` `AutoMem` | `src/memdir/memdir.ts`、`src/utils/claudemd.ts` | 已确认 |

## 设计决策

**第一，为什么用五道门而不是一个时间定时器？** 定时器无法表达「功能是否开启、是否 Remote、auto memory 是否可用、候选会话是否足够、另一个进程是否在跑」这五类独立约束。把门槛拆开，每一道都能独立失败且独立可测；`isGateOpen()` 决定能力，调度阈值决定频率，进程内节流限制扫描成本，会话数过滤低价值候选，锁处理跨进程竞争。AutoDream 不创建常驻 timer，因此 CLI 停止运行期间不会自行唤醒，后台语义来自「进程活着时的机会式触发」，不是守护进程。

**第二，为什么锁的 mtime 即上次整合时间，且成功路径故意不改？** 写 PID 时 `writeFile()` 已经更新 mtime，成功后再写一次反而引入额外文件操作；「获取时的时间 = 上次整合时间」让 `lastConsolidatedAt` 自然形成，失败回滚则用 `utimes` 恢复旧值。崩溃时新 mtime 暂时保留，由下一进程的 PID 存活检查和一小时 stale 边界兜底，锁只恢复调度租约，不负责撤销已经落盘的 Edit。

**第三，为什么后台 fork 的 Bash 只放行只读、Edit/Write 仅限 auto-memory 目录？** Dream 需要读取 transcript 与项目文件才能整合，但绝不能产生代码副作用。权限以工具实际输入为准（`tool.isReadOnly()`、`file_path` 前缀校验），而不是提示词里的一句「请只读」，这保证整合失败也不会把「后台维护」变成绕过权限的通道。

**第四，为什么 `filesTouched` 只用于进度展示？** 它只观察 Edit/Write block，可能低估真实触碰集合，且不参与文件系统事务。UI 的 phase 是「观察到文件写入」的信号，不是 Agent 进入提示词第几阶段的证据；审计必须回到普通文件操作本身。

## 练习

1. **观察一次 Dream 的触发门槛。** 在本地项目（auto memory 开启）连续工作多个会话，观察 `.consolidate-lock` 文件，第一次出现的时间、正文 PID、mtime 与最后整合时间的关系。验证，少于 24 小时或少于 5 个候选会话时不会触发。

2. **验证锁的回收语义。** 手工向 `.consolidate-lock` 写入一个不存在的 PID，并检查 mtime；理解「PID 已死即可回收」。再把 mtime 改成超过一小时，验证 `HOLDER_STALE_MS` 边界即使 PID 存活也会回收。

3. **阅读四阶段提示词。** 找到 `buildConsolidationPrompt()` 的还原源码，对照 Orient / Gather / Consolidate / Prune/Index 四阶段，回答，为什么 Gather 优先看 daily logs 而不是直接搜索 JSONL？为什么 Prune 单独放在最后？

## 自测

1. AutoDream 的默认调度门槛是什么？哪些值可以被远程覆盖？
2. `.consolidate-lock` 同时保存了什么？`tryAcquireConsolidationLock()` 怎样解决两个进程同时竞争？
3. Dream 的 forked agent 为什么能读项目文件，却不能改代码？

<details>
<summary>参考答案</summary>

1. **距上次整合至少 24 小时、至少 5 个其他会话被修改；同一进程还有 10 分钟扫描节流。** `tengu_onyx_plover` 的 `minHours` / `minSessions` 只有是正且有限的 number 时才覆盖对应字段，其余情况回退默认；enabled gate 之外的其他运行时边界（KAIROS、Remote、auto memory 关闭）不受该配置影响。

2. **正文保存持有进程 PID，mtime 保存上次整合时间。** 获取流程先读两者，一小时以内且 PID 存活返回 `null`；否则写 `String(process.pid)` 后再读回验证 `parseInt(verify) === process.pid`，最后一次写入者通过 PID 复读获胜。PID 已死、正文不可解析或锁超过一小时都允许回收。

3. **权限以工具输入为准。** Bash 只放行 `tool.isReadOnly()` 通过的命令（重定向写文件会被拒绝），Edit/Write 只允许 `file_path` 位于 auto-memory 目录内，其余工具统一 `deny`。Read/Grep/Glob 本身只读所以不限制路径；这样 Dream 能查项目和 transcript，却不会把「后台维护」变成修改源代码或调用外部副作用的通道。

</details>

## 回顾｜本章的后台维护链

<details>
<summary>展开查看回顾</summary>

AutoDream 把长期记忆维护拆成了一条成本受控的后台流水线，`stopHooks` 提供检查机会，运行模式与时间门槛做第一轮过滤，session mtime 给出粗候选，`.consolidate-lock` 减少跨进程重复，`DreamTask` 暴露进度和取消，`runForkedAgent()` 用受限工具完成 Orient、Gather、Consolidate、Prune/Index 四阶段整理。

它成功后保留新的锁 mtime，并在确实观察到文件变化时给主 transcript 一条简短通知；失败或 kill 则恢复旧 mtime。真正的知识仍落在 topic 文件和 `MEMORY.md`，由未来会话的记忆提示、入口加载与按需检索继续消费。

这也是本章最重要的边界，AutoDream 能自动整理记忆，但不会把「生成过」变成「必然正确」，也不会把后台 Agent 变成绕过权限、并发和上下文成本的特殊通道。

</details>

## 留给下一篇的问题

从用户角度看，AutoDream 有什么实际作用？

## 相关链接

- **上一篇**，[41 memdir 与团队记忆如何检索和同步](./41-memdir-and-team-memory.md)，Team Memory 可用性门槛
- **下一篇**，[43 辅助模式如何区别于主 Agent](./43-assistant-kairos.md)，回答 AutoDream 的实际作用
- **平行阅读**，[23 前台、后台与状态机](./23-task-runtime.md)，DreamTask 复用的通用任务抽象
- [Claude Code Auto Memory](https://code.claude.com/docs/en/memory)
- [Dive into Claude Code，生产级 Agent 的设计空间](https://arxiv.org/abs/2604.14228)
- [Inside Claude Code's Team Memory Sync](https://jakegoldsborough.com/blog/2026/inside-claude-codes-team-memory-sync/)
- [Session Transcripts and Team Memory](https://leehongji.github.io/Relearn-Claude-Code/claude-code/session-transcripts-and-team-memory)
