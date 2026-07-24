---
title: "Claude Code源码解读42：AutoDream 如何在后台自动整合记忆"
published: 2026-07-24T16:47:29+08:00
updated: 2026-07-24T16:47:29+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-42/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：团队记忆能够积累以后，AutoDream 如何在后台挑选素材、生成 Dream，并把结果重新纳入未来会话？

先说结论。AutoDream 不按固定时刻启动，也不会把所有聊天记录重新总结一遍。它挂在主 Agent 每轮结束后的 `stopHooks` 上，依次检查开关、运行模式、距离上次整合的时间、最近有改动的会话数和跨进程锁。只有这些门槛全部通过，才注册一个可见的 `DreamTask`，再用 `runForkedAgent()` 启动隔离的后台 Agent。

它所谓的“挑选素材”，也分成两层。调度层只按 transcript 的修改时间找出“上次整合以后动过的会话”，并排除当前会话；真正进入 Dream 后，提示词要求 Agent 先看已有记忆和日志，再按需要窄范围搜索 JSONL transcript。源码没有一个为每条消息计算相关性分数的候选排序器，也没有要求它通读所有 transcript。

后台 Agent 可以自由使用 Read、Grep、Glob，也可以运行只读 Bash；Edit 和 Write 则只能落在 auto-memory 目录。它把新信息合并进 topic 文件，修正过期内容，并把 `MEMORY.md` 维护为短索引。成功时锁文件的 mtime 留作新的“上次整合时间”；失败或用户终止时恢复旧 mtime，让后续会话仍有重试机会。

这些文件不会被硬塞回已经结束的模型请求。当前主会话只可能追加一条“Improved …”系统消息。到未来会话构建上下文时，`loadMemoryPrompt()` 再提供记忆规则与目录，`getMemoryFiles()` 读取 `MEMORY.md` 入口；topic 文件由索引和搜索规则引导按需读取。于是 AutoDream 形成的是一个跨会话闭环，而不是当前轮里的二次回答。

## AutoDream 是一次有门槛的后台记忆维护

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面的片段只保留证明当前控制流所需的分支，省略遥测和无关字段；还原路径不代表 Anthropic 内部仓库的原始组织方式。

![Claude Code AutoDream 从轮次结束、门槛检查到未来会话读取记忆的流程](/images/posts/claude-code-source-reading-42/42-auto-dream-handdrawn.png)

### 先补三个基础概念

第一个概念是 **memory consolidation**，记忆整合。它不是继续追加更多摘要，而是回看已有内容，合并重复项、删除已经被推翻的事实、把相对日期改成绝对日期，并维持一个足够短的入口索引。追加解决“别忘了”，整合解决“以后还能找得到、看得懂”。

第二个概念是 **forked agent**。AutoDream 不把整合提示词插入主消息链，而是复制一份可共享 prompt cache 的上下文，创建隔离的查询循环。这样主回答已经结束，后台 Agent 仍可继续调用模型和工具；它的可变文件状态、权限和取消信号又不必与主循环混成同一个对象。

第三个概念是 **lease-like lock**。`.consolidate-lock` 既保存持有进程 PID，也把文件 mtime 当作最后整合时间。它不是数据库事务锁：两个进程仍可能同时尝试写入，所以获取后还要重读 PID 验证谁赢了；进程崩溃后，下一次运行则可根据 PID 是否存活和锁年龄回收它。

把三个概念连起来，AutoDream 的主线就很清楚了：轮次结束只是检查机会，门槛负责控制成本，锁负责减少重复执行，后台 Agent 负责真正的语义整理，普通记忆加载链路负责让结果在未来生效。

## 触发点在轮次结束，不在独立计时器

启动阶段的 `restored-src/src/utils/backgroundHousekeeping.ts` 中，`startBackgroundHousekeeping()` 会调用 `initAutoDream()`，后者只安装一个 closure-scoped runner。真正尝试运行发生在 `restored-src/src/query/stopHooks.ts` 的 `handleStopHooks()`：主 Agent 完成本轮采样后，代码以 fire-and-forget 方式调用 `executeAutoDream()`。

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

**函数说明：** `handleStopHooks()` 是 Query Loop 的轮次收尾入口。这里的 `void executeAutoDream(...)` 表明调用方不等待 Dream 完成；`!toolUseContext.agentId` 又把触发限制在主线程，避免一个 subagent 结束时再递归启动新的 Dream。

**参数说明：** `stopHookContext` 携带当前 system prompt、user/system context、消息和 `toolUseContext`，供 fork 复用缓存安全参数；`appendSystemMessage` 是可选回调，可能为 `undefined`，缺失时 Dream 仍可执行，只是不向主 transcript 追加完成摘要。`isBareMode()` 为 `true` 时，prompt suggestion、memory extraction 和 AutoDream 整组后台维护都会跳过；这也是 `-p` 使用 bare/simple 运行时不会在退出阶段额外争用资源的边界。

`restored-src/src/services/autoDream/autoDream.ts` 里的 `executeAutoDream()` 自己很薄：`initAutoDream()` 尚未执行时，`runner` 为 `null`，可选调用直接成为 no-op；初始化以后，runner 内部保存本进程上一次扫描会话的时间。

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

**函数说明：** `executeAutoDream()` 只是稳定入口，实际实现由 `initAutoDream()` 写入 `runner`。这让测试可以在每个 case 里重新初始化 closure，也让调用点不需要判断初始化顺序。

**参数说明：** `context` 必填；`appendSystemMessage` 可为函数或 `undefined`。`runner` 的可见值是函数或 `null`，源码初值为 `null`。可选链只处理未初始化，不吞掉 runner 内部抛出的异常；实际 runner 对读取门槛和 fork 失败分别做了自己的处理。

这里没有每隔 24 小时醒来的 timer。所谓“24 小时门槛”，只有在某个主轮次结束并调用 runner 时才会被检查。如果用户几天没有运行 Claude Code，系统不会为了 Dream 单独常驻一个守护进程。

## 五道门决定这次要不要 Dream

### 第一关：开关和运行模式

`autoDream.ts` 的 `isGateOpen()` 先排除 KAIROS、Remote 和 auto-memory 关闭状态，再读取 `restored-src/src/services/autoDream/config.ts` 里的 AutoDream 开关：

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

**函数说明：** `isGateOpen()` 是 AutoDream 的组合开关。KAIROS 模式使用另一套 disk-skill dream；Remote 被明确排除；auto-memory 关闭时没有可维护的目标目录。`isAutoDreamEnabled()` 则实现“用户设置优先，实验配置兜底”。

**参数说明：** 两个函数都没有参数。`autoDreamEnabled` 可为 `true`、`false` 或 `undefined`：前两个值明确覆盖服务端默认，`undefined` 才读取 `tengu_onyx_plover`；远端值只有严格 `enabled === true` 才开启，`false`、缺失、`null` 或错误形状都不会被当作开启。`isAutoMemoryEnabled()` 还有环境变量、bare/simple、Remote 持久化目录和 `autoMemoryEnabled` 设置的优先级，本章不重复展开。

。默认阈值写在源码里，功能是否向某个运行环境开放仍属于运行时数据。

### 第二关：距离上次成功是否足够久

`autoDream.ts` 的调度配置由同一个 feature value 提供，但每个字段都独立校验。无法得到正的有限数时，回退到 `24` 小时和 `5` 个会话：

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

**函数说明：** `getConfig()` 只返回调度阈值，不负责 enabled gate。两个字段各自校验，所以一个字段合法、另一个字段错误时，只回退错误的那一个。

**参数说明：** 函数无参数。`minHours`、`minSessions` 的源码可确认候选是正且有限的 number；`0`、负数、`NaN`、`Infinity`、字符串、`null` 和 `undefined` 均回退默认值。源码没有把 `minSessions` 取整，所以远端若给出正小数，比较仍按 JavaScript number 执行；不能擅自把它解释成整数配置。

上次成功时间来自 `.consolidate-lock` 的 mtime。文件不存在时 `readLastConsolidatedAt()` 返回 `0`，第一次检查自然会跨过时间门槛。读取失败也被归到 `0`，但 runner 外层读取调用仍包了 catch，以防 `stat` 之外的实现异常。

### 第三关：十分钟扫描节流

只要时间门槛已经通过，而会话数量还不够，锁的 mtime 就不会更新。若每个用户回合都重新扫描 transcript 目录，会把一个便宜的时间判断变成频繁的文件系统遍历。源码因此用 closure 里的 `lastSessionScanAt` 做十分钟节流。

节流只存在于当前进程内，也只在时间门槛通过后生效。重启进程会把它恢复为 `0`；另一个 Claude Code 进程也有自己的值。它是成本优化，不是跨进程一致性机制。

### 第四关：最近有多少会话发生过变化

`restored-src/src/services/autoDream/consolidationLock.ts` 中，会话候选来自当前 cwd 对应的 transcript 目录：

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

**函数说明：** `listSessionsTouchedSince()` 取出 mtime 晚于上次整合时间的 session ID。`listCandidates()` 负责 UUID 校验和并行 stat，并排除 `agent-*.jsonl`；调用方再排除当前 session，因为它在刚结束一轮后必然是“最近修改”。

**参数说明：** `sinceMs` 是毫秒时间戳，没有默认值；这里传锁文件的旧 mtime。筛选条件是严格 `>`，等于边界的文件不进入结果。`listCandidates(dir, true)` 的第二个参数是 `doStat`，`true` 表示对每个候选执行 stat 并填入 mtime；最终返回开放的 session ID 字符串数组。`force` 在外部 2.1.88 构建中固定为 `false`，注释说明内部测试构建可绕过 enabled/time/session gate，但本文不把内部覆盖当成用户功能。

这不是语义相关性选择。一个会话只要文件 mtime 新，就可能进入 ID 提示；一个在其他 cwd 或 worktree 目录下的会话则可能被漏掉。源码注释把这种漏计视为安全的 skip-gate：最坏只是这次不触发，不会把错误会话强行加入当前上下文。

### 第五关：跨进程锁

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

**函数说明：** `tryAcquireConsolidationLock()` 尝试占有锁，并返回写入前的 mtime，供失败回滚；被活进程阻挡、读回失败或竞争失败时返回 `null`。两个竞争者都可能写文件，最后一次写入者通过 PID 复读获胜，另一个退出。

**参数说明：** 函数无参数。返回值是 `number | null`：正数表示旧 mtime，`0` 表示此前没有锁文件，`null` 表示本次没有取得锁。`holderPid` 和 `mtimeMs` 都可能为 `undefined`；正文 `parseInt` 后不是有限数时按无有效持有者处理。`HOLDER_STALE_MS` 固定为一小时，即使 PID 仍存活，超过该年龄也会被回收，以降低 PID 复用导致永久阻塞的风险。

这个锁仍不是完美的原子 create-if-absent。PID 复读缩小了竞争窗口，却无法提供分布式文件系统上的强一致保证。静态源码也没有网络、电量或系统空闲检测；不能把宿主没有承诺的条件补进 AutoDream 的触发模型。

## Dream 用四阶段提示词维护记忆

通过门槛后，runner 不会直接把 session 内容拼成一个巨型 prompt。它计算 auto-memory 根目录与 transcript 目录，再调用 `restored-src/src/services/autoDream/consolidationPrompt.ts` 的 `buildConsolidationPrompt(memoryRoot, transcriptDir, extra)`。提示词把任务拆成四阶段：

1. **Orient**：列出记忆目录，读取 `MEMORY.md`，浏览已有 topic，避免重复造文件。
2. **Gather recent signal**：优先看 daily logs，再找与当前事实漂移的旧记忆；只有需要具体上下文时，才用窄关键词搜索 JSONL。
3. **Consolidate**：把值得保留的信息写入或合并到 topic 文件，绝对化日期，删除被证伪的事实。
4. **Prune and index**：清掉错误或过期指针，缩短过长索引项，把 `MEMORY.md` 保持在 200 行和约 25KB 以内。

其中“日志、漂移记忆、transcript”只是粗略优先级，不是硬编码的排序结果。提示词明确写着不要穷举读取 transcript，只搜索已经怀疑重要的内容。`extra` 又追加本次发现的 session ID 列表和后台权限说明，但源码没有把这些 ID 逐个展开成全文。

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

**函数说明：** `buildConsolidationPrompt()` 构造手动 `/dream` 与 AutoDream 可共享的整合主提示词。后台特有的只读 Bash 说明放在 `extra`，避免手动 `/dream` 在主循环正常权限下看到错误约束。

**参数说明：** `memoryRoot` 与 `transcriptDir` 都是已解析的绝对目录字符串；函数不在这里验证路径。`extra` 是必填字符串，但允许 `''`；空字符串不生成 `Additional context`，非空时原样追加。索引上限来自 `MAX_ENTRYPOINT_LINES = 200`，字节目标来自提示词中的约 25KB；每条索引建议小于约 150 字符，超过约 200 字符会被视为应下沉到 topic 的内容。

四阶段的顺序有明确作用。“先读、再写”能减少近义重复；“先合并、后索引”让入口指向最终文件，而不是中间草稿；最后单独 prune，才能把错误记忆删除，避免永远只追加一条新的矛盾说明。

## 后台 Agent 复用内核，但换掉权限与持久化边界

真正执行发生在 `autoDream.ts`，底层复用 `restored-src/src/utils/forkedAgent.ts` 的 `runForkedAgent()`：

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

**函数说明：** `runForkedAgent()` 创建隔离的 subagent context，再进入与主 Agent 共用的 `query()` / `queryLoop()`。它累计完整 token usage，并把每条产出交给进度 watcher。AutoDream 没有另写一套模型客户端或工具循环。

**参数说明：** `promptMessages` 这里只有一个 user message；`cacheSafeParams` 继承 system prompt、user/system context、工具上下文和父消息前缀，以争取 prompt cache 命中。`querySource` 与 `forkLabel` 都固定为 `'auto_dream'`，用于来源和遥测。`skipTranscript: true` 表示不另存这个 fork 自己的 sidechain transcript，不表示禁止它读取历史 transcript。`overrides.abortController` 允许任务面板终止 fork；`onMessage` 可选，这里用于 UI 进度。源码没有传 `maxTurns` 或 `maxOutputTokens`，所以不能为 AutoDream 臆造独立轮数上限或输出 token 上限。

隔离并不等于“没有工具”。权限函数给它一组非常具体的能力：

- REPL 外壳可以调用，但内部 primitive 仍会再次经过同一个 `canUseTool`。
- Read、Grep、Glob 不限制读取路径，因为它们本身只读。
- Bash 只有 `tool.isReadOnly()` 判断通过才允许；重定向写文件或修改状态会拒绝。
- Edit、Write 只有 `file_path` 是字符串且位于 auto-memory 目录时才允许。
- 其他工具统一返回 `behavior: 'deny'`，而不是弹出交互式权限确认。

这条边界解释了 AutoDream 为什么能查项目和 transcript，却不能顺手改代码或调用外部副作用工具。权限以工具实际输入为准，不靠提示词里一句“请只读”自律。

## DreamTask 把看不见的 fork 变成可取消状态

在启动 fork 以前，runner 会先用 `restored-src/src/tasks/DreamTask/DreamTask.ts` 注册 `DreamTask`：

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

**类型说明：** `DreamTaskState` 是通用 `TaskStateBase` 的判别分支。`type` 固定为 `'dream'`；`status` 初始为 `'running'`，终态可由通用任务框架表现为 `'completed'`、`'failed'` 或 `'killed'`；`phase` 只有 `'starting'` 与 `'updating'`，它不解析提示词中的四个语义阶段。

**字段说明：** `sessionsReviewing` 是候选 session 数；`filesTouched` 初始空数组，只收集 watcher 看见的 Edit/Write `file_path`；`turns` 最多保留最近 30 个 assistant turn，并把 tool use 折叠为计数。`abortController` 运行时存在，完成、失败或终止后设为 `undefined`；`priorMtime` 必填，专供 kill 时回滚锁。

`makeDreamProgressWatcher()` 只处理 assistant message。它拼接 text block，统计 `tool_use`，遇到 Edit/Write 时提取 `file_path`。第一次观察到新路径后，phase 从 `starting` 变成 `updating`。因此 UI 上的 phase 是一个文件写入信号，不等同于 Agent 已经进入提示词的 Phase 3。

源码注释也提醒：`filesTouched` 是“不少于这些”，不是完整审计日志。它依赖对 Edit/Write block 的模式匹配。当前权限会拒绝 Bash 写入，因此正常 AutoDream 的主要写路径可被覆盖；但从类型设计上，不能把这个数组当成文件系统事务清单。

## 成功、失败与终止怎样处理锁

锁的 mtime 在获取时已经被 `writeFile()` 更新为当前时间。成功路径故意不再改它，于是这个时间自然成为下一轮的 `lastConsolidatedAt`。随后任务标记完成；只有 watcher 确认至少触碰一个文件，并且主上下文提供 `appendSystemMessage` 时，才追加 `verb: 'Improved'` 的 memory saved message。

这条消息写入主 transcript，不写入 `MEMORY.md`，也不会把 Dream 的全部推理过程塞回主会话。`completeDreamTask()` 把 `notified` 直接设为 `true`，因为 Dream 没有另一条 model-facing 通知路径；任务注册表需要 terminal + notified 才能正常淘汰。

失败路径则调用 `consolidationLock.ts` 的 `rollbackConsolidationLock()` 恢复旧时间：

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

**函数说明：** `rollbackConsolidationLock()` 把锁恢复到获取前状态。fork 抛错时 runner 调用它；用户从后台任务面板 kill 时，`DreamTask.kill()` 也走同一条路径。

**参数说明：** `priorMtime` 是毫秒 number，没有 `null` 或 `undefined` 候选。值为 `0` 表示原本无锁文件，因此直接删除；非零值先清空 PID 正文，再把 atime/mtime 都恢复到对应秒数。函数 catch 所有文件错误并记 debug 日志，不继续抛出；若回滚失败，当前较新的 mtime 可能使下一次触发推迟到 `minHours` 以后。

用户 kill 还有一个容易忽略的去重边界。`DreamTask.kill()` 先 `abort()`、回滚并把状态设为 `'killed'`；fork 随后抛错进入 runner 的 catch 时，看到 `abortController.signal.aborted` 就直接返回，不再标 failed，也不做第二次回滚。普通异常没有 abort 信号，才会执行 `failDreamTask()` 和回滚。

崩溃则不同。进程来不及进入 catch 时，新 mtime 会暂时保留；下一进程发现 PID 已死即可回收。若 PID 状态无法可靠判断，最长一小时的 stale 边界仍允许再次尝试。这是“可恢复调度”，不是对 topic 文件写入的事务回滚：AutoDream 已经完成一半的 Edit 不会随 mtime 回滚自动撤销。

## 结果怎样进入未来会话

AutoDream 的产物仍是普通文件：topic 保存具体内容，`MEMORY.md` 保存一行一个的入口。未来会话里，`restored-src/src/memdir/memdir.ts` 的 `loadMemoryPrompt()` 与 `restored-src/src/utils/claudemd.ts` 的 `getMemoryFiles()` 共同消费它们。

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

**函数说明：** `loadMemoryPrompt()` 向 system prompt 提供 auto-memory 的目录、类型、写入和搜索规则；`getMemoryFiles()` 则把 `MEMORY.md` 当作 `AutoMem` 类型入口加入 Claude.md/记忆上下文。调用图可见，前者会被 `getSystemPrompt()` 和 `QueryEngine.submitMessage()` 等入口消费。

**参数说明：** `loadMemoryPrompt()` 无参数，返回 `Promise<string | null>`；auto-memory 关闭时为 `null`。`extraGuidelines` 可为 `string[] | undefined`，只在 Cowork 环境变量存在且 trim 后非空时生成。`skipIndex` 来自 feature value，默认 `false`；为 `true` 时提示词使用“不维护索引”的保存规则。`safelyReadMemoryFileAsync()` 的路径来自 `getAutoMemEntrypoint()`，文件不存在或无法形成有效信息时 `info` 为空，不加入结果。

topic 文件并不会全部常驻模型窗口。正常模式始终加载的是精简入口，模型再根据链接和“搜索过去上下文”的规则选择性 Read/Grep。这样 AutoDream 改进索引后，未来会话更容易发现正确主题；是否点到哪个链接、是否采信 Dream 的内容，仍由后续会话决策和用户行为共同决定。

## 这套实现守住了哪些边界

第一，AutoDream 维护的是个人 auto-memory 目录，不是一个可以无条件覆盖团队共享知识的事务系统。KAIROS 直接跳过这条自动链路，TEAMMEM 的同步与冲突仍由第 41 篇讨论的路径处理。

第二，锁只协调“是否启动整合”，不保护每个 memory 文件的原子更新。成功时没有 commit 清单，失败时也不回滚已经落盘的 Edit。提示词通过“先读已有内容、优先合并”降低冲突，但并发文件修改仍需实际运行和故障注入验证。

第三，候选 session 以 mtime 为依据。它能回答“哪些会话最近动过”，不能回答“哪条事实最重要”。语义筛选交给 forked Agent 的提示词和工具搜索，因此成本、质量与遗漏率都不能从阈值代码直接推导。

第四，后台不等于无限制。bare/simple、Remote、KAIROS、auto-memory 和 AutoDream 开关都可能让它不运行；读目录、列会话、取锁、模型请求或写文件任一步失败，也可能提前返回或进入失败路径。

最后，静态源码能确认默认 `24h / 5 sessions / 10min scan throttle / 1h stale lock`，但 GrowthBook 可以提供合法正数覆盖前两个值。不能把源码默认值写成所有用户线上永远不变的产品承诺。

## 小结

AutoDream 把长期记忆维护拆成了一条成本受控的后台流水线：`stopHooks` 提供检查机会，运行模式与时间门槛做第一轮过滤，session mtime 给出粗候选，`.consolidate-lock` 减少跨进程重复，`DreamTask` 暴露进度和取消，`runForkedAgent()` 用受限工具完成 Orient、Gather、Consolidate、Prune/Index 四阶段整理。

它成功后保留新的锁 mtime，并在确实观察到文件变化时给主 transcript 一条简短通知；失败或 kill 则恢复旧 mtime。真正的知识仍落在 topic 文件和 `MEMORY.md`，由未来会话的记忆提示、入口加载与按需检索继续消费。

这也是本章最重要的边界：AutoDream 能自动整理记忆，但不会把“生成过”变成“必然正确”，也不会把后台 Agent 变成绕过权限、并发和上下文成本的特殊通道。

## 留给下一篇的问题

Dream 把经验沉淀下来以后，Assistant 与 KAIROS 如何利用这些记忆主动规划、提醒并推进用户任务？

