---
title: "Claude Code源码解读23：前台、后台与状态机如何协作"
published: 2026-07-24T16:47:10+08:00
updated: 2026-07-24T16:47:10+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-23/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：Skill 把一组指令按需展开以后，Claude Code 的 Task 运行时如何创建、调度、观察并收束长时间任务？

答案先说：**Claude Code 没有用一个中央调度器包办所有长任务。它把“任务是什么”收进统一状态，把“任务怎么跑”留给不同实现，再用输出文件、通知队列和取消接口把生命周期接回来。**

一个长时间 Bash 命令、一个本地 Agent、一个远程 Agent，执行方式完全不同。强行塞进同一个 `run()` 函数，只会得到一个满是分支的巨型调度器。2.1.88 选择的公共面更窄：运行中的实例进入 `AppState.tasks`；共同状态使用 `pending`、`running`、`completed`、`failed`、`killed`；每种任务自己负责启动、完成回调和终态通知；统一的 `TaskStop` 再按 `type` 找到对应的 `kill()`。

前台与后台也不是两种任务类型。它们描述的是**结果由谁等待**。前台时，当前工具调用还在等结果，并持续显示进度；后台时，进程或 Agent 继续运行，当前调用先把 task ID 和输出文件交还给模型。之后任务完成，通过 `task-notification` 触发新一轮处理。`isBackgrounded` 可以在运行中从 `false` 变为 `true`，但底层任务不需要重启。

这就是本篇的主线：创建状态，注册实例，执行者推进，输出落盘，终态入队，主循环回收。本文仍以仓库中由 `@anthropic-ai/claude-code@2.1.88` source map 还原的 `restored-src/` 为边界。下面的源码只省略与当前结论无关的字段和 UI 分支。

## 先分清两种叫 Task 的东西

源码里有两个很容易混淆的 “Task”。

第一种是本文要讲的**运行时任务**。它位于 `restored-src/src/Task.ts`、`restored-src/src/tasks/` 和 `restored-src/src/utils/task/`，代表已经启动或准备启动的 Bash、Agent、工作流等执行实例。它有随机 task ID、输出文件、终止状态和取消实现，状态保存在内存中的 `AppState.tasks`。

第二种是 `restored-src/src/utils/tasks.ts` 里的**协作任务列表**，对应 `TaskCreate`、`TaskGet`、`TaskList`、`TaskUpdate`。它更像多人协作的待办事项，状态是 `pending | in_progress | completed`，按 JSON 文件持久化。创建一条待办不会自动启动 Bash 或 Agent。

两者名字相同，状态集合也有重叠，但用途不同：

| 维度 | 运行时 Task | 协作任务列表 Task |
|---|---|---|
| 回答的问题 | 哪个执行实例还在跑 | 哪项工作还没完成 |
| 主要存储 | `AppState.tasks` + 输出文件 | `~/.claude/tasks/.../*.json` |
| 终态 | `completed`、`failed`、`killed` | `completed` |
| 是否直接控制进程 | 是，由具体 Task 实现负责 | 否 |

本文只讨论第一种。下一篇进入 subagent 时，才会再把运行时 Task 与 Agent 执行上下文接起来。

## 一张图看懂任务的两条轴

![Claude Code Task 运行时、前后台切换与结果回收手绘图](/images/posts/claude-code-source-reading-23/23-task-runtime-handdrawn.png)

图中要分开看两条轴。

横向是生命周期：`pending/running → completed/failed/killed`。纵向是呈现与等待方式：`isBackgrounded=false/true`。把一个正在运行的前台任务切到后台，只改变纵向位置，不应重新创建进程，也不应再次发出 `task_started`。

这张图还暴露了一个看似反直觉的事实：后台任务的主要结果载体不是一条无限增长的内存字符串，而是 output file。模型可以读取这个文件；旧的 `TaskOutput` 工具仍在，但源码已经明确标成 deprecated。

## 统一状态只规定生命周期，不规定执行算法

`restored-src/src/Task.ts` 先定义任务类型和状态：

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

**函数说明：** `isTerminalTaskStatus()` 是终态守卫。任务一旦进入 `completed`、`failed` 或 `killed`，框架就把它视为不再继续转换的实例，用于阻止向已结束任务继续注入消息，也用于决定何时回收状态。

**参数说明：** `status` 只能取五个 `TaskStatus` 值。`pending` 表示已建立状态但尚未运行，`running` 表示执行中；`completed` 是正常完成，`failed` 是执行失败，`killed` 是被主动停止。这里没有 `undefined` 或 `null` 分支，调用者必须先取得合法任务状态。`TaskType` 列出的七个值是 2.1.88 静态源码可确认的集合，但 `local_workflow` 与 `monitor_mcp` 的实现还受构建期 feature 控制。

统一的 `Task` 接口甚至没有 `spawn()`：

```ts
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

**函数说明：** `Task` 是按类型取消运行实例的最小契约。各执行路径各自拥有创建函数，例如 shell 使用 `spawnShellTask()`，Agent 使用自己的注册与生命周期函数；公共接口只保留停止时真正需要的 `kill()`。

**参数说明：** `taskId` 是运行实例的开放字符串标识，不是协作任务列表里的递增数字；`setAppState` 接收一个纯更新函数。`kill()` 返回 `Promise<void>`，不承诺所有任务使用相同的底层取消机制，也没有默认实现。

这个设计很克制。任务框架负责一致的“壳”，具体 Task 负责自己的“发动机”。本地 Bash 可以杀进程，远程 Agent 可以发远端取消请求，Dream 可以终止自己的异步工作；上层不需要理解每种执行器的内部对象。

## 创建：先生成安全 ID，再注册到 AppState

公共状态由 `createTaskStateBase()` 建立：

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

**函数说明：** `createTaskStateBase()` 生成所有运行时任务共享的初始字段。它把状态初始化为 `pending`，提前确定输出文件，把读取偏移设为 `0`，并用 `notified=false` 表示终态尚未被消费。具体实现可以在对象展开后立即覆盖状态；例如 `spawnShellTask()` 注册时直接写成 `running`，所以不能把 `pending → running` 理解成每种任务都必经、且对外可观察的两次更新。

**参数说明：** `id` 是已经生成的 task ID；`type` 必须是前述七种 `TaskType` 之一；`description` 是开放文本，用于 UI 和通知摘要；`toolUseId` 是 `string | undefined`，有值时把后台任务关联回发起它的 `tool_use`，省略时不写该关联。`endTime`、`totalPausedMs` 等字段此时为 `undefined`，只在相应生命周期发生后补齐。

默认的 `generateTaskId()` 用类型前缀加八位数字/小写字母随机字符。`local_bash` 使用兼容前缀 `b`，`local_agent` 使用 `a`，远程 Agent 使用 `r`。前缀让人和 UI 能快速识别类型；随机主体则避免容易猜测的输出文件名被用来抢占或构造符号链接攻击。

状态建好后由 `registerTask()` 放入 `AppState.tasks`：

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

**函数说明：** `registerTask()` 既是注册入口，也是 SDK `task_started` 事件的边界。相同 ID 已存在时被视为 resume replacement：它保留面板和消息相关状态，并跳过第二次 started 事件。这样恢复一个 Agent 不会在消费者眼里变成两个任务。

**参数说明：** `task` 是联合类型 `TaskState`，具体字段取决于 `type`；`setAppState` 负责原子替换状态。`prev.tasks[task.id]` 可能是 `undefined`，表示首次注册；有值时才走替换分支。`workflow_name`、`prompt` 等 SDK 字段从具体任务按需读取，缺少时为 `undefined`，不是空字符串或 `null`。

## 调度：前台等待与后台运行共用同一个执行实例

这里的“调度”不是操作系统级 CPU 调度，也不是一个带优先级队列的 worker pool。源码呈现的是**分散式生命周期调度**：BashTool 决定何时执行命令、何时前台等待或转后台；AgentTool 决定何时运行 Agent；各 Task 实现把状态变化汇入公共表。

以本地 shell 为例。`spawnShellTask()` 取得已有 `ShellCommand` 的 `taskId`，注册 running 状态，再调用 `shellCommand.background(taskId)`。它不是重新执行命令：

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

**函数说明：** `spawnShellTask()` 把一个已经开始执行的 `ShellCommand` 纳入统一任务运行时。注册之后，结果 Promise 在后台完成；回调根据 exit code 写入 `completed` 或 `failed`，若此前已经被停止则保持 `killed`，最后发送通知并清理内存输出对象。

**参数说明：** `command` 是实际 shell 文本；`description` 是展示摘要；`shellCommand` 是已创建的进程包装对象；`toolUseId`、`agentId` 都允许 `undefined`，分别表示没有工具调用关联、由主线程而非某个 Agent 创建；`kind` 是 `'bash' | 'monitor' | undefined`，省略按普通 Bash 展示。返回的 `cleanup` 是可选清理句柄，不会杀掉已经交给后台继续运行的任务本身。

如果命令最初在前台运行，系统可以先用 `registerForeground()` 写入 `isBackgrounded:false`，再由 Ctrl+B、自动后台计时或显式 `run_in_background` 路径原地切换。`backgroundExistingForegroundTask()` 特别避免重新注册，否则会重复发出 `task_started`，还可能泄漏第一次注册的 cleanup callback。

因此，前台/后台不是状态机中的第六、第七个状态。一个任务完全可以同时满足 `status === 'running'` 且 `isBackgrounded === false`；切到后台后仍是 `running`，只是 `isBackgrounded === true`。

`isBackgroundTask()` 把这个判定写得很明确：

```ts
export function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  if (task.status !== 'running' && task.status !== 'pending') return false
  if ('isBackgrounded' in task && task.isBackgrounded === false) return false
  return true
}
```

**函数说明：** `isBackgroundTask()` 判断一个任务是否应该进入后台任务指示器和后台等待逻辑。终态任务不再算“后台运行中”；显式标记为前台的任务也被排除。没有 `isBackgrounded` 字段的任务，只要仍是 `pending/running`，就按后台任务处理。

**参数说明：** `task` 是运行时任务联合类型，不接受 `null` 或 `undefined`。`status` 只有 `pending`、`running` 能返回 `true`；当具体类型包含 `isBackgrounded` 时，只有显式 `false` 会排除，`true` 会通过。字段不存在不是 `false` 的同义词，这是联合类型间的回退逻辑。

## 观察：状态放内存，大输出放文件

长任务最棘手的不是“有没有一个 Promise”，而是输出可能持续数小时。如果每个 chunk 都追加到 React 状态或对话历史，内存和 token 都会一起膨胀。

Claude Code 把状态与输出分开：`AppState.tasks` 保存小而可订阅的状态；`TaskOutput` 与 `DiskTaskOutput` 保存日志；任务状态中的 `outputFile` 指向当前会话的任务目录。Bash 的 file mode 甚至让 stdout/stderr 直接进入文件描述符，不先经过 JavaScript 字符串。

文件模式下，进度由共享 poller 读取尾部：

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

**函数说明：** `TaskOutput.startPolling()` 只把当前可见、且注册了进度回调的文件型输出加入共享轮询器。所有活跃实例复用一个 1 秒定时器；对应组件卸载时 `stopPolling()` 移除实例，集合为空就关闭定时器。这避免每个任务各建一个永久 timer。

**参数说明：** `taskId` 是开放字符串，用于从内部 registry 取实例。找不到实例或 `onProgress` 为 `null` 时直接返回。轮询间隔在这段实现中固定为 `1000ms`，不是调用参数；`unref()` 表示该定时器不会单独阻止 Node/Bun 进程退出。轮询只读末尾 4096 字节用于显示，并不等于读取完整结果。

输出文件还有两层上限。任务输出共用 5GB 的粗粒度磁盘保护：pipe mode 的 `DiskTaskOutput` 超过后丢弃后续 chunk 并写入截断标记，Bash file mode 则由文件大小 watchdog 终止进程；通用读取默认只取文件尾部 8MB。`TaskOutput` 工具映射给模型时还通过 `TASK_MAX_OUTPUT_LENGTH` 控制字符数，源码默认 32,000，上限 160,000。

这些数字解决的是不同问题：5GB 防止磁盘被无限写满，8MB 防止一次读取吞掉进程内存，32,000 字符默认值防止一次 `tool_result` 吞掉模型上下文。它们不能互相替代。

## 结果回收：优先读取 output file，TaskOutput 只是兼容层

后台启动结果会给出 task ID 与 output file。任务完成时，通知里再次携带同一路径。2.1.88 的 `TaskOutputTool.prompt()` 与 `description()` 都明确建议直接用 Read 读取输出文件；`TaskOutput` 主要保留给旧 transcript 和 SDK 用户。

兼容工具仍完整支持阻塞和非阻塞读取：

```ts
const inputSchema = z.strictObject({
  task_id: z.string(),
  block: semanticBoolean(z.boolean().default(true)),
  timeout: z.number().min(0).max(600000).default(30000),
})
```

**函数说明：** 这是 `TaskOutputTool` 的输入 schema。工具先在 `AppState.tasks` 中查找任务；`block=false` 立即返回当前状态和现有输出，`block=true` 则每 100ms 检查一次，直到任务进入终态、调用被取消或 timeout 到达。

**参数说明：** `task_id` 是必填字符串；`block` 是布尔值，默认 `true`，语义布尔解析器还负责接受运行时允许的等价输入；`timeout` 是 `0..600000` 毫秒，默认 `30000`。`block=false` 且任务仍是 `pending/running` 时返回 `retrieval_status:'not_ready'`；阻塞等待超时返回 `'timeout'`，此时 `task` 可能仍包含当前输出，也可能因为任务已被移除而是 `null`；终态返回 `'success'`。

读取结果时，本地 Bash 优先从仍在内存的 `shellCommand.taskOutput` 取 stdout/stderr，句柄已释放后回退到磁盘文件；本地 Agent 则优先使用内存里的干净 final answer，避免把包含所有消息和工具调用的 transcript symlink 当成最终答案。这个按类型恢复结果的分支说明：公共状态统一，不代表所有任务的“结果”语义相同。

## 完成：终态通知把后台结果重新送回模型

后台任务不会因为当前工具调用已经返回，就变成无人管理的 detached process。具体 Task 在完成回调中更新状态，并把 XML 格式的 `task-notification` 放入 message queue。通知包含 task ID、可选 tool use ID、类型、output file、终态和摘要。

交互模式的队列处理器会把通知作为后续输入；print/headless 路径还会转换成 SDK `system` 事件，并继续让模型看到这条通知。也就是说，“后台”只是不阻塞原来的工具调用，不代表模型永远不再处理结果。

这里还要注意通知的幂等性。`enqueueShellNotification()` 先原子检查并写入 `notified:true`；如果 `TaskStop` 已经消费了终态，就跳过重复通知。对 SDK 而言，注册发 `task_started`，执行中的 Agent/工作流可以发 `task_progress`，终态发 `task_notification`。这些是事件流，不是对 `AppState.tasks` 的完整快照。

在非交互模式里，主循环在命令队列暂时为空后还会检查后台任务：只要仍有符合 `isBackgroundTask()` 的任务，就每 100ms 等待并再次排空队列。`in_process_teammate` 被显式排除，因为 teammate 的 `running` 是长生命周期常态；如果也等待它变成 completed，print 模式可能永远无法退出。

这体现了调度边界：运行时等待的是“需要收束的后台工作”，不是所有状态为 running 的对象。

## 取消：统一入口，按类型派发

`TaskStop` 接受新的 `task_id`，同时兼容已废弃的 `shell_id`。真正停止任务的是 `restored-src/src/tasks/stopTask.ts`：

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

**函数说明：** `stopTask()` 是 LLM 调用的 `TaskStopTool` 与 SDK `stop_task` 控制请求共享的停止路径。它验证任务存在且仍在运行，然后根据 `task.type` 取得实现并调用 `kill()`。本地 Bash 会额外抑制常见的 exit 137 噪声，同时直接补发 SDK stopped 事件，保证消费者仍能看到任务闭合。

**参数说明：** `taskId` 必须指向当前 `AppState.tasks` 中的运行实例；找不到、不是 `running`、类型没有可用实现时，错误码分别是 `'not_found'`、`'not_running'`、`'unsupported_type'`。`context` 只要求 `getAppState` 与 `setAppState`。`TaskStopTool` 的 `task_id`、兼容字段 `shell_id` 都是 `string | undefined`，优先使用 `task_id`；两者都省略会校验失败。虽然工具调用签名里还能拿到 `abortController`，这条 `call()` 路径没有把它传给 `stopTask()`。

类型表由 `getAllTasks()` 组装。`LocalShellTask`、`LocalAgentTask`、`RemoteAgentTask`、`DreamTask` 固定进入数组；`LocalWorkflowTask` 与 `MonitorMcpTask` 只有对应构建 feature 为真才加载。`TaskType` 联合类型里还包含 `in_process_teammate`，但 `getAllTasks()` 没有为它注册可取消实现，因此通过这条统一入口停止它会落到 `unsupported_type`。这是静态源码显示的边界，不应脑补成所有 `TaskType` 都支持 `TaskStop`。

## 收束：notified 不是装饰字段

一个任务进入终态，还不能立刻从 `AppState.tasks` 删除。否则通知还没被模型或 SDK 消费，状态和输出路径就丢了。`notified` 正是“终态是否已经交付”的确认位。

`evictTerminalTask()` 只有同时满足三个条件才删除：任务存在、状态是 `completed/failed/killed`、`notified===true`。本地 Agent 面板还有 30 秒 grace period；若 `retain` 为真或 `evictAfter` 尚未到期，会继续保留。`generateTaskAttachments()` 也保留了惰性回收逻辑，但从当前仓库能直接检索到的调用关系看，具体任务自己的完成通知才是终态交付主路径，不能把导出的 `pollTasks()` 误写成所有任务唯一的中央循环。

输出对象与状态也分开清理。`evictTaskOutput()` 会先 flush 写队列，再从进程内 `Map` 删除 `DiskTaskOutput`，但不会删除磁盘文件；`cleanupTaskOutput()` 才会删除文件。这样终态后释放 JavaScript 内存的同时，通知里的 output file 仍可供 Read 回收。

这套机制的核心不是“异步”三个字，而是把所有权拆清楚：

- 执行器拥有启动方式和完成回调；
- `AppState.tasks` 拥有可观察生命周期；
- `TaskOutput`/output file 拥有长输出；
- message queue 与 SDK event queue 拥有结果交付；
- `TaskStop → getTaskByType → kill` 拥有统一取消入口；
- `notified + terminal status` 共同决定何时可以回收。

## 小结

Claude Code 的 Task 运行时可以压成一句话：**统一状态，分散执行，文件承载输出，通知收回结果，类型派发取消。**

`TaskStatus` 解决“任务走到哪一步”，`isBackgrounded` 解决“当前调用是否还要等”，二者是正交维度。`registerTask()` 把实例挂进 `AppState.tasks`，具体 Task 自己推进运行与终态；大输出落到按会话隔离的文件；完成通知重新进入模型队列；`TaskStop` 再通过最小 `kill()` 契约停止不同执行器。

这样做的价值不是抽象得漂亮，而是避免长任务绑死一次 query loop：主线程可以继续处理别的输入，后台任务仍然可观察、可取消、可恢复结果，并且最终有明确的收束条件。

## 留给下一篇的问题

当一个任务需要独立上下文和专门能力时，Claude Code 如何创建 subagent、选择 Agent 定义，并在主线程与子线程之间传递结果？

