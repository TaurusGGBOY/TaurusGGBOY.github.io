---
title: "Claude Code源码解读23：前台、后台与状态机如何协作"
published: 2026-07-24T16:47:10+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-23/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇留下的问题是，如果你想自己定义一个 Skill slash 命令，你应该怎么实现？

答案先说，**在 2.1.88 中，通常不需要注册新的 TypeScript `Command`。创建一个 Skill 目录和 `SKILL.md`，Claude Code 就会把它加载成一个 `type: 'prompt'` 的 Command；用户输入 `/skill-name` 或模型调用 `Skill` 工具时，正文才被展开并送进 Query Loop。**

最小的项目级结构可以这样写，

```text
.claude/
└── skills/
    └── release-note/
        ├── SKILL.md
        ├── checklist.md       # 可选：按需读取的参考资料
        └── scripts/
            └── validate.sh    # 可选：由正文明确要求执行
```

`SKILL.md` 至少应该有一段清晰的说明和一组可执行指令，例如，

```markdown
---
name: release-note
description: 根据当前 Git 变更生成发布说明；用户准备发版或要求整理 changelog 时使用。
argument-hint: [version]
allowed-tools: Read Grep Bash
user-invocable: true
context: fork
---

请检查当前变更，生成版本 $ARGUMENTS 的发布说明。
先读取 checklist.md，再运行测试；不要修改源文件。
```

目录位置决定作用域，`.claude/skills/<name>/SKILL.md` 只对当前项目可见，`~/.claude/skills/<name>/SKILL.md` 可用于个人的所有项目。源码中的 `loadSkillsFromSkillsDir()` 只把目录（或符号链接）下名为 `SKILL.md` 的文件当作现代 Skill；`skills/` 下面直接放一个 `release-note.md` 不会被这个加载器接受。

旧的 `.claude/commands/` 仍然兼容单文件写法，`.claude/commands/release-note.md` 也会生成 `/release-note`。这条路径会被标记为 `commands_DEPRECATED`；普通命令名来自去掉 `.md` 的文件名，Skill 目录命令名来自目录名，嵌套目录则由 `buildNamespace()` 拼成类似 `team:release-note` 的名字。对于新项目，目录式 Skill 更适合携带参考文件和脚本。

真正的“命令化”发生在加载器内部，而不在 Markdown 文件本身，`getSkills()` 并行收集项目/个人 Skill、插件 Skill 和 bundled Skill；`loadSkillsFromSkillsDir()` 读取 frontmatter 与正文；`parseSkillFrontmatterFields()` 解析开关、参数和执行上下文；最后 `createSkillCommand()` 返回，

```ts
{
  type: 'prompt',
  name: skillName,
  description,
  userInvocable,
  disableModelInvocation,
  context: executionContext,
  async getPromptForCommand(args, toolUseContext) { /* 展开正文 */ },
}
```

这里有三个容易写错的边界。第一，在本地/项目 Skill 中，2.1.88 的路由名来自目录名，frontmatter 的 `name` 主要作为显示名称；`description` 缺省时源码会从正文第一段提取。第二，`user-invocable` 缺省为 `true`，设为 `false` 会隐藏并阻止用户直接输入 slash；`disable-model-invocation` 缺省为 `false`，设为 `true` 则禁止模型通过 `Skill` 工具调用。第三，`context` 只有精确值 `'fork'` 才会在模型通过 `Skill` 工具调用时进入隔离 Agent；`undefined`、`'inline'` 或其他字符串都会按当前会话展开，用户直接输入 slash 仍先走 PromptCommand 路径。`allowed-tools` 只是给后续工具增加允许规则，仍受 deny、沙箱和工具自身校验约束。

调用 `/release-note v1.2` 时，`getPromptForCommand()` 会先补上 Skill 根目录，再替换 `$ARGUMENTS`、命名参数以及 `${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}`；非 MCP Skill 的正文还可以经过统一的 inline shell 展开器。随后 `processPromptSlashCommand()` 把结果包装为消息，`shouldQuery: true` 让 Query Loop 继续处理。Skill 本身是一份带路由和权限元数据的 PromptCommand，不直接执行 Bash。

如果 frontmatter 写了 `context: fork`，`SkillTool.call()` 会改走 `executeForkedSkill()`，源码创建新的 `agentId`，调用 `runAgent()`，收集子 Agent 的消息和进度，最后只把提取出的结果文本返回父会话。也就是说，自定义 slash 命令的实现工作止于“定义 Skill”；上下文隔离、任务状态、输出回收和取消，交给后面的 Task 运行时处理。

命令名来源、frontmatter 默认值和 `Command` 包装方式均以仓库从 `@anthropic-ai/claude-code@2.1.88` 还原的 `restored-src/` 为准；外部资料只用于对照推荐写法。

## 介绍本章的一些概念

- **两个同名 Task 不是一回事**，运行时 Task 是真正活着的执行实例（Bash、Agent、workflow），状态与取消句柄放在 `AppState.tasks`；协作任务列表 Task 是 JSON 持久化的待办，创建它不会启动进程。前者回答"谁还在跑"，后者回答"哪项工作还没完成"。
- **生命周期与等待方式是两条正交的轴**，横向 `pending/running → completed/failed/killed` 是状态机，纵向 `isBackgrounded=false/true` 是呈现与等待方式。把前台任务切到后台只改变纵向位置，不应重新创建进程，也不应再次发出 `task_started`。
- **统一状态、分散执行**，`Task` 公共接口只保留 `kill()` 这一个取消契约，各 Task 实现拥有自己的"发动机"；`TaskStop` 是统一取消入口，`stopTask() → getTaskByType → kill` 按类型派发。
- **状态放内存，大输出放文件**，`AppState.tasks` 保存小而可订阅的状态，日志进按会话隔离的 output file；共享 poller 每秒读尾部 4096 字节供显示。5GB 磁盘保护、8MB 单次读取上限、32,000 字符工具映射默认值解决三个不同问题。
- **终态通知是结果回收主路径**，后台任务完成时以 XML `task-notification` 重新进入模型队列，模型按需用 Read 回收 output file；`notified` 标志保证终态只交付一次。
- **`notified + terminal status` 共同决定回收**，任务不能一进终态就删除，否则通知还没被消费，状态和输出路径就丢了；`evictTerminalTask()` 只有"存在 + 终态 + `notified===true`"三个条件同时满足才移除。

## 本篇新增机制

相对上一篇"skill-system"（提示词如何变成可执行能力），本篇在心智模型中新增四块，

| 新增机制 | 解决的问题 | 关键符号 |
|---|---|---|
| 任务状态机 | 把跨回合执行实例的生命周期统一成可观察状态 | `TaskStatus`、`isTerminalTaskStatus()` |
| 前台/后台正交 | 等待方式与生命周期解耦，切后台不重建进程 | `isBackgrounded`、`isBackgroundTask()` |
| 文件承载输出 | 大输出不膨胀 React 状态与模型上下文 | `outputFile`、`DiskTaskOutput`、`TaskOutput` |
| 终态通知与回收 | 后台结果重新送回模型，且只交付一次 | `task-notification`、`notified`、`evictTerminalTask()` |

## 问题｜后台任务如何保持可观察、可取消、可回收

先接住上一篇留下的问题，如果你想自己定义一个 Skill slash 命令，应该怎么实现？**结论，在 2.1.88 中通常不需要注册新的 TypeScript `Command`。创建一个 Skill 目录和 `SKILL.md`，Claude Code 就会把它加载成一个 `type: 'prompt'` 的 Command；用户输入 `/skill-name` 或模型调用 `Skill` 工具时，正文才被展开并送进 Query Loop。**

最小的项目级结构是，

```text
.claude/
└── skills/
    └── release-note/
        ├── SKILL.md
        ├── checklist.md       # 可选：按需读取的参考资料
        └── scripts/
            └── validate.sh    # 可选：由正文明确要求执行
```

`SKILL.md` 至少应有一段清晰的说明和一组可执行指令；frontmatter 的 `name`、`description`、`user-invocable`、`disable-model-invocation`、`context`、`allowed-tools` 决定路由名、显示与权限元数据。真正的"命令化"发生在加载器内部，`getSkills()` 并行收集项目/个人、插件和 bundled Skill，`loadSkillsFromSkillsDir()` 只把目录（或符号链接）下名为 `SKILL.md` 的文件当作现代 Skill 并读取 frontmatter 与正文，`parseSkillFrontmatterFields()` 解析开关，最后 `createSkillCommand()` 返回 `{ type: 'prompt', name, description, userInvocable, disableModelInvocation, context, async getPromptForCommand(...) }`。旧的 `.claude/commands/` 单文件写法仍兼容，但会被标记为 `commands_DEPRECATED`。

有三个容易写错的边界。第一，路由名来自目录名，frontmatter 的 `name` 主要作显示名；`description` 缺省时源码从正文第一段提取。第二，`user-invocable` 缺省为 `true`，`disable-model-invocation` 缺省为 `false`。第三，`context` 只有精确值 `'fork'` 才会在模型通过 `Skill` 工具调用时进入隔离 Agent；`undefined`、`'inline'` 或其他字符串都按当前会话展开。调用 `/release-note v1.2` 时，`getPromptForCommand()` 先补上 Skill 根目录，再替换 `$ARGUMENTS`、命名参数以及 `${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}`，随后 `processPromptSlashCommand()` 以 `shouldQuery: true` 让 Query Loop 继续处理。若 frontmatter 写了 `context: fork`，`SkillTool.call()` 改走 `executeForkedSkill()`，创建新的 `agentId`，调用 `runAgent()`，收集子 Agent 的消息和进度，最后只把提取出的结果文本返回父会话。也就是说，自定义 slash 命令的实现止于"定义 Skill"；上下文隔离、任务状态、输出回收和取消，正是本篇要讲的 Task 运行时。命令名来源、frontmatter 默认值和 `Command` 包装方式均以 `restored-src/`（2.1.88 source map 还原）为准，外部资料只用于对照推荐写法。

现在把问题再往前推一步，**`npm run dev`、后台 Agent 和 teammate 都可能在当前回合之外继续运行。主会话要恢复输入，运行时却不能丢掉取消句柄、输出位置和终态；把结果全塞回消息数组又会重新制造上下文压力。**

![后台任务状态、输出文件与 Agent 唤醒](/images/posts/claude-code-source-reading-23/23-task-rewake-detail-handdrawn.png)

**本篇的答案，把 Task 看成执行实例的账本，状态机管理生命周期，输出文件承载大结果，通知队列负责在后台任务结束后把可消费的摘要送回 Agent。**

## 正文

### 两种 Task 分别描述执行实例与协作事项

源码里有两个同名对象。运行时 Task 位于 `Task.ts` 和 `tasks/`，代表 Bash、Agent、workflow 等真正活着的执行实例，状态和取消句柄放在 `AppState.tasks`；`TaskCreate`/`TaskGet`/`TaskUpdate` 操作的是 JSON 持久化的协作待办，创建它不会启动进程。两者名字相同、状态集合也有重叠，但用途不同，

| 维度 | 运行时 Task | 协作任务列表 Task |
|---|---|---|
| 回答的问题 | 哪个执行实例还在跑 | 哪项工作还没完成 |
| 主要存储 | `AppState.tasks` + 输出文件 | `~/.claude/tasks/.../*.json` |
| 终态 | `completed`、`failed`、`killed` | `completed` |
| 是否直接控制进程 | 是，由具体 Task 实现负责 | 否 |

本文只讨论运行时 Task；subagent 的上下文与结果回流留给下一篇。

### 一张图看懂任务的两条轴

![Claude Code Task 运行时、前后台切换与结果回收手绘图](/images/posts/claude-code-source-reading-23/23-task-runtime-handdrawn.png)

图中要分开看两条轴。横向是生命周期，`pending/running → completed/failed/killed`。纵向是呈现与等待方式，`isBackgrounded=false/true`。把一个正在运行的前台任务切到后台，只改变纵向位置，不应重新创建进程，也不应再次发出 `task_started`。

这张图还暴露了一个关键事实，后台任务的主要结果载体是 output file，模型可以按需读取。旧的 `TaskOutput` 工具仍在，但源码已经明确标成 deprecated。

### 这张金额单位工单的长测试交给后台

计划批准后，值班工程师已经在独立 worktree 里修正了元/分转换，但完整集成测试预计需要十几分钟。他不想盯着一块不再刷新的终端，也不想为了等测试结束暂停对回调样例的核对，于是输入，

> 创建独立 worktree，把金额计算、回调解析和前端复现分别交给合适的 sub-agent 或 teammate；运行完整集成测试并放到后台。前台继续整理这张金额单位工单的证据。

Claude Code 会创建 Task，先把它注册到 AppState，再让前台继续接收工单的其他消息；大段测试输出写入文件，工程师可以查询状态、读取结果或停止任务。12 分钟后，后台任务以 completed 或 failed 进入终态，通知把可消费的摘要重新送回模型或用户，而不是把整份日志一次性塞进当前消息数组。

这段交互把 Task 从"一个命令"变成可观察、可取消、可回收的执行实例，下面从创建、调度、输出和终态进入源码。

### 统一状态只规定生命周期，不规定执行算法

`restored-src/src/Task.ts` 先定义任务类型和状态，

```ts
export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}
```

> 证据，`restored-src/src/Task.ts`（2.1.88 source map 还原源码），`TaskType`、`TaskStatus` 联合定义与 `isTerminalTaskStatus()` 完整实现。

**函数说明，** `isTerminalTaskStatus()` 是终态守卫。任务一旦进入 `completed`、`failed` 或 `killed`，框架就把它视为不再继续转换的实例，用于阻止向已结束任务继续注入消息，也用于决定何时回收状态。

**参数说明，** `status` 只能取五个 `TaskStatus` 值。`pending` 表示已建立状态但尚未运行，`running` 表示执行中；`completed` 是正常完成，`failed` 是执行失败，`killed` 是被主动停止。`TaskType` 列出的七个值是 2.1.88 静态源码可确认的集合，但 `local_workflow` 与 `monitor_mcp` 的实现还受构建期 feature 控制。

统一的 `Task` 接口只保留取消契约，

```ts
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

> 证据，`restored-src/src/Task.ts`，`Task` 类型完整定义。

**函数说明，** `Task` 是按类型取消运行实例的最小契约。各执行路径各自拥有创建函数，例如 shell 使用 `spawnShellTask()`，Agent 使用自己的注册与生命周期函数；公共接口只保留停止时真正需要的 `kill()`。

**参数说明，** `taskId` 是运行实例的开放字符串标识，与协作任务列表里的递增数字分属不同命名空间；`setAppState` 接收一个纯更新函数。`kill()` 返回 `Promise<void>`，具体任务类型各自提供底层取消实现。

**字段说明，** `name` 是实现的展示名称，`type` 必须取 `TaskType` 联合中的一种；二者用于在统一任务表中定位实现。

这个设计很克制。任务框架负责一致的"壳"，具体 Task 负责自己的"发动机"。本地 Bash 可以杀进程，远程 Agent 可以发远端取消请求，Dream 可以终止自己的异步工作；上层不需要理解每种执行器的内部对象。

### 创建｜先生成安全 ID，再注册到 AppState

公共状态由 `createTaskStateBase()` 建立，

```ts
export function createTaskStateBase(
  id: string,
  type: TaskType,
  description: string,
  toolUseId?: string,
): TaskStateBase {
  return {
    id,
    type,
    status: 'pending',
    description,
    toolUseId,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(id),
    outputOffset: 0,
    notified: false,
  }
}
```

> 证据，`restored-src/src/Task.ts`，`createTaskStateBase()` 完整实现。

**函数说明，** `createTaskStateBase()` 生成所有运行时任务共享的初始字段。它把状态初始化为 `pending`，提前确定输出文件，把读取偏移设为 `0`，并用 `notified=false` 表示终态尚未被消费。具体实现可以在对象展开后立即覆盖状态；例如 `spawnShellTask()` 注册时直接写成 `running`，所以不能把 `pending → running` 理解成每种任务都必经、且对外可观察的两次更新。

**参数说明，** `id` 是已经生成的 task ID；`type` 必须是前述七种 `TaskType` 之一；`description` 是开放文本，用于 UI 和通知摘要；`toolUseId` 是 `string | undefined`，有值时把后台任务关联回发起它的 `tool_use`，省略时不写该关联。`endTime`、`totalPausedMs` 等字段此时未定义，只在相应生命周期发生后补齐。

**字段说明，** `status` 初始为 `'pending'`，`startTime` 记录创建时间；`outputFile` 由 `getTaskOutputPath(id)` 派生，`outputOffset` 从 `0` 开始，`notified: false` 表示终态通知尚待消费。返回对象同时原样保存 `id`、`type`、`description` 与可选 `toolUseId`。

默认的 `generateTaskId()` 用类型前缀加八位数字/小写字母随机字符。`local_bash` 使用兼容前缀 `b`，`local_agent` 使用 `a`，远程 Agent 使用 `r`。前缀让人和 UI 能快速识别类型；随机主体则避免容易猜测的输出文件名被用来抢占或构造符号链接攻击。

状态建好后由 `registerTask()` 放入 `AppState.tasks`，

```ts
export function registerTask(task: TaskState, setAppState: SetAppState): void {
  let isReplacement = false
  setAppState(prev => {
    const existing = prev.tasks[task.id]
    isReplacement = existing !== undefined
    const merged =
      existing && 'retain' in existing
        ? { ...task, retain: existing.retain, startTime: existing.startTime,
            messages: existing.messages, diskLoaded: existing.diskLoaded,
            pendingMessages: existing.pendingMessages }
        : task
    return { ...prev, tasks: { ...prev.tasks, [task.id]: merged } }
  })

  if (isReplacement) return
  enqueueSdkEvent({ type: 'system', subtype: 'task_started', /* ... */ })
}
```

> 证据，`restored-src/src/utils/task/framework.ts`，`registerTask()` 完整实现。

**函数说明，** `registerTask()` 既是注册入口，也是 SDK `task_started` 事件的边界。相同 ID 已存在时被视为 resume replacement，它保留面板和消息相关状态，并跳过第二次 started 事件。这样恢复一个 Agent 不会在消费者眼里变成两个任务。

**参数说明，** `task` 是联合类型 `TaskState`，具体字段取决于 `type`；`setAppState` 负责原子替换状态。`prev.tasks[task.id]` 首次注册时是 `undefined`，有值时才走替换分支。`workflow_name`、`prompt` 等 SDK 字段从具体任务按需读取，缺失时省略。

**字段说明，** replacement 分支从旧任务保留 `retain`、`startTime`、`messages`、`diskLoaded`、`pendingMessages`，其余字段取新 `task`；合并结果写入 `tasks[task.id]`。首次注册还发送 `type: 'system'`、`subtype: 'task_started'` 的 SDK 事件。

### 调度｜前台等待与后台运行共用同一个执行实例

这里的"调度"指**分散式生命周期调度**，BashTool 决定何时执行命令、何时前台等待或转后台；AgentTool 决定何时运行 Agent；各 Task 实现把状态变化汇入公共表。操作系统负责进程调度，源码这一层负责状态、输出与结果交付。

以本地 shell 为例。`spawnShellTask()` 取得已有 `ShellCommand` 的 `taskId`，注册 running 状态，再调用 `shellCommand.background(taskId)`；原命令进程继续运行。

```ts
export async function spawnShellTask(input, context): Promise<TaskHandle> {
  const { command, description, shellCommand, toolUseId, agentId, kind } = input
  const taskId = shellCommand.taskOutput.taskId
  const taskState: LocalShellTaskState = {
    ...createTaskStateBase(taskId, 'local_bash', description, toolUseId),
    status: 'running',
    command,
    shellCommand,
    isBackgrounded: true,
    agentId,
    kind,
    /* ... */
  }
  registerTask(taskState, context.setAppState)
  shellCommand.background(taskId)
  void shellCommand.result.then(/* 写入终态并通知 */)
  return { taskId, cleanup: () => unregisterCleanup() }
}
```

> 证据，`restored-src/src/tasks/LocalShellTask/LocalShellTask.tsx`，`spawnShellTask()` 主体（省略与主线无关的可选分支）。

**函数说明，** `spawnShellTask()` 把一个已经开始执行的 `ShellCommand` 纳入统一任务运行时。注册之后，结果 Promise 在后台完成；回调根据 exit code 写入 `completed` 或 `failed`，若此前已经被停止则保持 `killed`，最后发送通知并清理内存输出对象。

**参数说明，** `command` 是实际 shell 文本；`description` 是展示摘要；`shellCommand` 是已创建的进程包装对象。提供 `toolUseId` 时，终态通知可以关联回发起调用；省略时跳过这项关联。提供 `agentId` 时任务归属对应 Agent，省略时归入主线程。`kind` 可取 `'bash'` 或 `'monitor'`，省略按普通 Bash 展示。返回的 `cleanup` 是可选清理句柄，不会杀掉已经交给后台继续运行的任务本身。

如果命令最初在前台运行，系统可以先用 `registerForeground()` 写入 `isBackgrounded:false`，再由 Ctrl+B、自动后台计时或显式 `run_in_background` 路径原地切换。`backgroundExistingForegroundTask()` 特别避免重新注册，否则会重复发出 `task_started`，还可能泄漏第一次注册的 cleanup callback。

因此，前台/后台是与 `TaskStatus` 正交的等待属性。一个任务可以同时满足 `status === 'running'` 且 `isBackgrounded === false`；切到后台后仍是 `running`，只是 `isBackgrounded === true`。

`isBackgroundTask()` 把这个判定写得很明确，

```ts
export function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  if (task.status !== 'running' && task.status !== 'pending') return false
  if ('isBackgrounded' in task && task.isBackgrounded === false) return false
  return true
}
```

> 证据，`restored-src/src/tasks/types.ts`，`isBackgroundTask()` 完整实现。

**函数说明，** `isBackgroundTask()` 判断一个任务是否应该进入后台任务指示器和后台等待逻辑。终态任务会被排除，显式标记为前台的任务也会被排除。省略 `isBackgrounded` 字段的任务只要仍是 `pending/running`，就按后台任务处理。

**参数说明，** `task` 是运行时任务联合类型。`status` 只有 `pending`、`running` 能返回 `true`；当具体类型包含 `isBackgrounded` 时，显式 `false` 会排除，`true` 会通过。字段缺失采用后台任务回退语义。

### 观察｜状态放内存，大输出放文件

长任务的主要压力来自可能持续数小时的输出。如果每个 chunk 都追加到 React 状态或对话历史，内存和 token 都会一起膨胀。

Claude Code 把状态与输出分开，`AppState.tasks` 保存小而可订阅的状态；`TaskOutput` 与 `DiskTaskOutput` 保存日志；任务状态中的 `outputFile` 指向当前会话的任务目录。Bash 的 file mode 甚至让 stdout/stderr 直接进入文件描述符，不先经过 JavaScript 字符串。

文件模式下，进度由共享 poller 读取尾部，

```ts
static startPolling(taskId: string): void {
  const instance = TaskOutput.#registry.get(taskId)
  if (!instance || !instance.#onProgress) return
  TaskOutput.#activePolling.set(taskId, instance)
  if (!TaskOutput.#pollInterval) {
    TaskOutput.#pollInterval = setInterval(TaskOutput.#tick, 1000)
    TaskOutput.#pollInterval.unref()
  }
}
```

> 证据，`restored-src/src/utils/task/TaskOutput.ts`，`startPolling()` 完整实现。

**函数说明，** `TaskOutput.startPolling()` 只把当前可见、且注册了进度回调的文件型输出加入共享轮询器。所有活跃实例复用一个 1 秒定时器；对应组件卸载时 `stopPolling()` 移除实例，集合为空就关闭定时器。这避免每个任务各建一个永久 timer。

**参数说明，** `taskId` 是开放字符串，用于从内部 registry 取实例。找不到实例或 `onProgress` 为 `null` 时跳过注册，因此不会启动无消费者的轮询。轮询间隔固定为 `1000ms`；`unref()` 使该定时器不再单独阻止 Node/Bun 进程退出。轮询只读末尾 4096 字节用于显示，完整结果仍保留在输出文件中。

输出文件还有两层上限。任务输出共用 5GB 的粗粒度磁盘保护，pipe mode 的 `DiskTaskOutput` 超过后丢弃后续 chunk 并写入截断标记，Bash file mode 则由文件大小 watchdog 终止进程；通用读取默认只取文件尾部 8MB。`TaskOutput` 工具映射给模型时还通过 `TASK_MAX_OUTPUT_LENGTH` 控制字符数，源码默认 32,000，上限 160,000。

这些数字解决的是不同问题，5GB 防止磁盘被无限写满，8MB 防止一次读取吞掉进程内存，32,000 字符默认值防止一次 `tool_result` 吞掉模型上下文。它们不能互相替代。

### 结果回收｜优先读取 output file，TaskOutput 只是兼容层

后台启动结果会给出 task ID 与 output file。任务完成时，通知里再次携带同一路径。2.1.88 的 `TaskOutputTool.prompt()` 与 `description()` 都明确建议直接用 Read 读取输出文件；`TaskOutput` 主要保留给旧 transcript 和 SDK 用户。

兼容工具仍完整支持阻塞和非阻塞读取，

```ts
const inputSchema = z.strictObject({
  task_id: z.string(),
  block: semanticBoolean(z.boolean().default(true)),
  timeout: z.number().min(0).max(600000).default(30000),
})
```

> 证据，`restored-src/src/tools/TaskOutputTool/`，`TaskOutputTool` 输入 schema 完整定义。

**函数说明，** 这是 `TaskOutputTool` 的输入 schema。工具先在 `AppState.tasks` 中查找任务；`block=false` 立即返回当前状态和现有输出，`block=true` 则每 100ms 检查一次，直到任务进入终态、调用被取消或 timeout 到达。

**参数说明，** `task_id` 是必填字符串；`block` 是布尔值，默认 `true`，语义布尔解析器还负责接受运行时允许的等价输入；`timeout` 是 `0..600000` 毫秒，默认 `30000`。`block=false` 且任务仍是 `pending/running` 时返回 `retrieval_status:'not_ready'`；阻塞等待超时返回 `'timeout'`，此时 `task` 可能仍包含当前输出，也可能因为任务已被移除而是 `null`；终态返回 `'success'`。

读取结果时，本地 Bash 优先从仍在内存的 `shellCommand.taskOutput` 取 stdout/stderr，句柄已释放后回退到磁盘文件；本地 Agent 则优先使用内存里的干净 final answer，避免把包含所有消息和工具调用的 transcript symlink 当成最终答案。这个按类型恢复结果的分支说明，公共状态统一，不代表所有任务的"结果"语义相同。

### 完成｜终态通知把后台结果重新送回模型

后台任务不会因为当前工具调用已经返回，就变成无人管理的 detached process。具体 Task 在完成回调中更新状态，并把 XML 格式的 `task-notification` 放入 message queue。通知包含 task ID、可选 tool use ID、类型、output file、终态和摘要。

交互模式的队列处理器会把通知作为后续输入；print/headless 路径还会转换成 SDK `system` 事件，并继续让模型看到这条通知。也就是说，"后台"只是不阻塞原来的工具调用，不代表模型永远不再处理结果。

这里还要注意通知的幂等性。`enqueueShellNotification()` 先原子检查并写入 `notified:true`；如果 `TaskStop` 已经消费了终态，就跳过重复通知。对 SDK 而言，注册发 `task_started`，执行中的 Agent/工作流可以发 `task_progress`，终态发 `task_notification`。这些事件只描述状态变化，完整状态仍保存在 `AppState.tasks`。

在非交互模式里，主循环在命令队列暂时为空后还会检查后台任务，只要仍有符合 `isBackgroundTask()` 的任务，就每 100ms 等待并再次排空队列。`in_process_teammate` 被显式排除，因为 teammate 的 `running` 是长生命周期常态；如果也等待它变成 completed，print 模式可能永远无法退出。

这体现了调度边界，运行时只等待需要收束的后台工作。

### 取消｜统一入口，按类型派发

`TaskStop` 接受新的 `task_id`，同时兼容已废弃的 `shell_id`。停止动作由 `restored-src/src/tasks/stopTask.ts` 执行，

```ts
export async function stopTask(taskId: string, context: StopTaskContext) {
  const task = context.getAppState().tasks?.[taskId]
  if (!task) throw new StopTaskError(/* ... */, 'not_found')
  if (task.status !== 'running') {
    throw new StopTaskError(/* ... */, 'not_running')
  }
  const taskImpl = getTaskByType(task.type)
  if (!taskImpl) {
    throw new StopTaskError(/* ... */, 'unsupported_type')
  }
  await taskImpl.kill(taskId, context.setAppState)
  /* shell 通知去重与 SDK 终态事件 */
}
```

> 证据，`restored-src/src/tasks/stopTask.ts`，`stopTask()` 主体（省略通知与 SDK 事件细节）。

**函数说明，** `stopTask()` 是 LLM 调用的 `TaskStopTool` 与 SDK `stop_task` 控制请求共享的停止路径。它验证任务存在且仍在运行，然后根据 `task.type` 取得实现并调用 `kill()`。本地 Bash 会额外抑制常见的 exit 137 噪声，同时直接补发 SDK stopped 事件，保证消费者仍能看到任务闭合。

**参数说明，** `taskId` 必须指向当前 `AppState.tasks` 中的运行实例；零命中、状态偏离 `running`、类型缺少可用实现时，错误码分别是 `'not_found'`、`'not_running'`、`'unsupported_type'`。`context` 只要求 `getAppState` 与 `setAppState`。`TaskStopTool` 的 `task_id`、兼容字段 `shell_id` 都是可选字符串，优先使用 `task_id`；两者都省略会校验失败。工具调用签名虽能取得 `abortController`，这条 `call()` 路径只把 `taskId` 与 `context` 传给 `stopTask()`。

类型表由 `getAllTasks()` 组装。`LocalShellTask`、`LocalAgentTask`、`RemoteAgentTask`、`DreamTask` 固定进入数组；`LocalWorkflowTask` 与 `MonitorMcpTask` 只有对应构建 feature 为真才加载。`TaskType` 联合类型里还包含 `in_process_teammate`，但 `getAllTasks()` 未为它注册可取消实现，因此通过这条统一入口停止它会落到 `unsupported_type`。静态源码只确认已注册类型支持 `TaskStop`。

### 收束｜notified 控制终态消费

一个任务进入终态，还不能立刻从 `AppState.tasks` 删除。否则通知还没被模型或 SDK 消费，状态和输出路径就丢了。`notified` 正是"终态是否已经交付"的确认位。

`evictTerminalTask()` 只有同时满足三个条件才删除，任务存在、状态是 `completed/failed/killed`、`notified===true`。本地 Agent 面板还有 30 秒 grace period；若 `retain` 为真或 `evictAfter` 尚未到期，会继续保留。`generateTaskAttachments()` 也保留了惰性回收逻辑，但从当前仓库能直接检索到的调用关系看，具体任务自己的完成通知才是终态交付主路径，不能把导出的 `pollTasks()` 误写成所有任务唯一的中央循环。

输出对象与状态也分开清理。`evictTaskOutput()` 会先 flush 写队列，再从进程内 `Map` 删除 `DiskTaskOutput`，但不会删除磁盘文件；`cleanupTaskOutput()` 才会删除文件。这样终态后释放 JavaScript 内存的同时，通知里的 output file 仍可供 Read 回收。

这套机制的核心是把所有权拆清楚，

- 执行器拥有启动方式和完成回调；
- `AppState.tasks` 拥有可观察生命周期；
- `TaskOutput`/output file 拥有长输出；
- message queue 与 SDK event queue 拥有结果交付；
- `TaskStop → getTaskByType → kill` 拥有统一取消入口；
- `notified + terminal status` 共同决定何时可以回收。

### Task prompt 规定的是状态推进协议

`TodoWriteTool/prompt.ts` 先给当前 coding session 一个轻量任务表：任务达到三步、存在明显复杂度、用户明确要求分解或有多个独立任务时才使用；开始执行后立刻把一个任务标成 `in_progress`，完成后改成 `completed`，其余保持 `pending`。字段也有写作约束，`content` 用祈使式，`activeForm` 用现在进行时。它与 Plan mode、记忆文件分别解决短期执行视图、审批前计划和长期事实沉淀。

V2 的 `TaskCreate/Get/List/Update/Stop` prompt 把同一协议扩展到持久任务：Create 负责描述任务和团队分配，Get 读取完整描述与依赖，List 只展示可用的 pending、未拥有且未阻塞任务，Update 只在真正完成或删除时收束状态，Stop 按任务 ID 取消后台执行。prompt 规定模型什么时候改变状态；`Task`、AppState、output file 和终态通知才是实际持久化与回收边界。

## 源码映射

| 主题 | 关键文件（`restored-src/src/`） | 关键函数 / 符号 | 证据 |
|---|---|---|---|
| 状态机与任务契约 | `Task.ts` | `TaskType`、`TaskStatus`、`isTerminalTaskStatus()`、`Task.kill`、`createTaskStateBase()` | 源码已确认 |
| 注册与 started 事件 | `utils/task/framework.ts` | `registerTask()`、resume replacement、`task_started` | 源码已确认 |
| 后台判定 | `tasks/types.ts` | `isBackgroundTask()` | 源码已确认 |
| Shell 任务 | `tasks/LocalShellTask/LocalShellTask.tsx` | `spawnShellTask()`、`backgroundExistingForegroundTask()` | 源码已确认 |
| 输出轮询与上限 | `utils/task/TaskOutput.ts` | `startPolling()`、`TASK_MAX_OUTPUT_LENGTH`、5GB/8MB 上限 | 源码已确认 |
| 兼容读取工具 | `tools/TaskOutputTool/` | `TaskOutputTool` 输入 schema、`retrieval_status` | 源码已确认 |
| 统一取消 | `tasks/stopTask.ts` | `stopTask()`、`getTaskByType()`、`getAllTasks()` | 源码已确认 |
| 终态回收 | `utils/task/framework.ts`、`Task.ts` | `evictTerminalTask()`、`evictTaskOutput()`、`cleanupTaskOutput()`、`notified` | 调用关系确认 |

## 设计决策

**第一，统一状态，分散执行。** `Task` 接口只保留 `kill()`，各执行器自备创建与推进逻辑。这让上层能用一个任务表观察所有长执行，又不必理解 Bash、Agent、Dream 各自的内部对象；代价是"结果语义"按类型分化（Bash 看 stdout/stderr，Agent 看 final answer）。

**第二，生命周期与等待方式正交。** `TaskStatus` 与 `isBackgrounded` 是两条独立轴，切后台只改等待属性，不重建进程、不重复 `task_started`。如果混成一个维度，前台转后台就会变成"杀旧建新"，取消句柄和输出位置都会丢。

**第三，状态与输出分层存放。** 小而可订阅的状态进 `AppState.tasks`，大输出进文件；5GB、8MB、32,000 字符三层上限各防一种资源失控，不能互相替代。输出文件因此成为后台任务的"结果容器"，通知只带摘要和路径。

**第四，终态交付必须是幂等的。** `notified` 是"终态是否已消费"的确认位，配合 `evictTerminalTask()` 的"存在 + 终态 + notified"三条件才回收；通知队列与 SDK 事件只描述状态变化，完整状态始终留在 `AppState.tasks`。

**第五，取消统一入口、按类型派发。** `TaskStop → stopTask → getTaskByType → kill` 让 LLM 与 SDK 共用一条停止路径，错误码把"找不到/没在跑/不支持"三种失败分清楚；`in_process_teammate` 故意不注册 kill 实现，静态源码只能确认已注册类型支持取消。

## 练习｜把一条长命令推进状态机

不打开源码，用 10到15 分钟做下面这件事，

1. 在 Claude Code 里运行 `run_in_background: true` 的一个长 Bash（例如 `sleep 30 && echo done`），观察返回值里的 `task_id` 与 `outputFile`。
2. 用 `TaskStop` 停止它之前，先回答三个问题，任务现在是什么 `status`？`isBackgrounded` 是什么？终端里能否看到"正在运行"的指示？
3. 用 Read 读一次 `outputFile`，再对比 `TaskOutput` 工具返回的 `retrieval_status`，确认"优先读文件"为什么是 2.1.88 的推荐路径。
4. 停止任务后再次调用 `TaskStop`，观察返回的错误码是 `not_running` 还是 `not_found`，并说明 `notified` 在这个过程里起了什么作用。

## 自测

1. 运行时 Task 与协作任务列表 Task 有什么本质区别？为什么两者不能用同一个终态替代？
2. 前台任务切到后台时，为什么源码要避免重新注册、避免重复发送 `task_started`？
3. `TaskOutput` 工具为什么被标记 deprecated？推荐用什么方式回收后台任务的结果？
4. 一个任务进入 `completed` 后，为什么不能立刻从 `AppState.tasks` 删除？`evictTerminalTask()` 的三个条件是什么？

<details>
<summary>参考答案</summary>

1. **运行时 Task 是执行实例**，状态和取消句柄放在 `AppState.tasks`，终态有 `completed/failed/killed`，直接控制进程；**协作任务列表 Task 是 JSON 持久化的待办**，创建它不会启动进程，终态只有 `completed`。前者回答"谁还在跑"，后者回答"哪项工作还没完成"。

2. **避免重复副作用**，`registerTask()` 把相同 ID 视为 resume replacement，保留面板和消息状态并跳过第二次 `task_started`；`backgroundExistingForegroundTask()` 如果重新注册，会重复发出 `task_started`，还可能泄漏第一次注册的 cleanup callback。切后台只是纵向位置变化，进程仍是原来那一个。

3. **因为结果的主载体已经是 output file**，`TaskOutputTool.prompt()` 与 `description()` 都明确建议直接用 Read 读取输出文件，`TaskOutput` 主要保留给旧 transcript 和 SDK 用户。回收结果应读 `outputFile`，而不是把整份日志塞回 `tool_result`。

4. **因为通知可能还没被消费**，如果一进终态就删除，模型或 SDK 就丢了状态和输出路径。`evictTerminalTask()` 三个条件是，任务存在、状态是 `completed/failed/killed`、`notified===true`。本地 Agent 面板还有 30 秒 grace period，`retain` 为真或 `evictAfter` 未到期时继续保留。

</details>

## 回顾｜前台、后台与状态机如何协作

<details>
<summary>展开查看回顾</summary>

Claude Code 的 Task 运行时可以压成一句话，**统一状态，分散执行，文件承载输出，通知收回结果，类型派发取消。**

`TaskStatus` 解决"任务走到哪一步"，`isBackgrounded` 解决"当前调用是否还要等"，二者是正交维度。`registerTask()` 把实例挂进 `AppState.tasks`，具体 Task 自己推进运行与终态；大输出落到按会话隔离的文件；完成通知（XML `task-notification`）重新进入模型队列，`notified` 保证只交付一次；`TaskStop` 再通过最小 `kill()` 契约停止不同执行器。

这样设计可以避免长任务绑死一次 query loop，主线程继续处理别的输入，后台任务仍然可观察、可取消、可恢复结果，并且最终有明确的收束条件（`notified + terminal status`）。运行时只等待需要收束的后台工作，`in_process_teammate` 的 `running` 是常态，print 模式不会傻等它变 completed。

理解了这个执行实例账本以后，下一篇将回答，在 Claude Code 的执行链路中，tool-use 与 Task 之间是如何关联的？

</details>

## 留给下一篇的问题

在 Claude Code 的执行链路中，tool-use 与 Task 之间是如何关联的？

## 相关链接

- **上一篇**，[22 提示词如何变成可执行能力](./22-skill-system.md)
- **下一篇**，[24 如何隔离上下文并委派任务](./24-subagent-delegation.md)，`tool_use` 与 Task 如何关联，subagent 的上下文与结果回流
- [Claude Code 交互模式与任务列表](https://code.claude.com/docs/en/interactive-mode)
- [Claude Code Commands](https://code.claude.com/docs/en/commands)
- [Extend Claude with skills - Claude Code Docs](https://code.claude.com/docs/en/slash-commands)
- [How to create custom skills - Claude Help Center](https://support.claude.com/en/articles/12512198-how-to-create-custom-skills)
- [Claude Code Custom Slash Commands， Build Reusable Workflows with Skills](https://thepromptshelf.dev/blog/claude-code-custom-slash-commands/)
