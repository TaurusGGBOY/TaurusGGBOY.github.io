---
title: "DeepSeek Harness 插件开发：怎样做一个无副作用撤回"
published: 2026-08-24
description: "结合 DeepSeek Harness 的工具执行管线、Cordis 生命周期和 LLM adapter/provider 源码，拆解一个真实的 dsh-file-undo 文件撤回插件。"
tags: ["deepseek-harness", "plugin-system", "rollback", "side-effects", "typescript"]
category: "AI / Architecture"
draft: false
image: ""
---

让 Agent 改文件很容易，让它改错之后只撤回自己的那一次改动，就没那么容易了。

这篇文章讨论的“无副作用撤回”有一个严格边界：撤回只恢复插件自己记录的本地文件写入，不重新进入模型循环，不执行 shell，不访问网络，不修改 Git 历史，也不把其他文件一起恢复。恢复动作本身仍然是一次受沙箱策略约束的本地写入，所以它不是物理意义上的“零写入”；更准确的说法是**不扩散副作用的可控补偿**。

真实例子是社区插件 [`dsh-file-undo`](https://github.com/QinLuza/dsh-file-undo)。它给 DeepSeek Harness 增加 `/undo`、`/undo list`、`/undo <n>` 和 `/undo prune [days]`，在 `write` / `edit` 执行前保存目标文件的完整内容，再把指定快照写回。下面按源码说明它为什么这样做、哪些地方可以复用，以及哪些事情它故意不做。

## 先把事故定义清楚

需要防止的具体事故是：Agent 覆盖了一个尚未提交的配置文件或源码文件，用户想撤回刚才那一次写入，却只能依赖 Git、编辑器历史或人工修复。

DeepSeek Harness 已经有几种相关机制，但它们解决的不是同一个问题：

| 机制 | 能解决什么 | 不能替代什么 |
| --- | --- | --- |
| Cordis 的 `ctx.effect()` | 插件卸载时撤销监听器、命令和服务注册 | 恢复插件已经改写过的文件内容 |
| session event log | 记录模型消息、工具调用和结果，便于恢复会话 | 不一定保存 `write` / `edit` 之前的文件内容 |
| Git | 恢复已提交或已暂存的版本 | 不覆盖未提交文件，也不按 Agent 的单次操作记录 |
| `dsh-file-undo` | 恢复被它捕获的本地 `write` / `edit` | shell 修改、删除和外部系统副作用 |

这里的关键不是“再加一个命令”，而是找到**最后一个还来得及保存 before-state 的位置**。官方工具结果只告诉插件操作成功或失败，并不会自动把被覆盖前的全文交给后续撤回逻辑。已经发生的覆盖，不能靠一条普通 session 日志凭空重建。

## DeepSeek Harness 的工具管线给了哪个插槽

官方工具文档把一次工具调用拆成下面几段：

```text
tools/pre-execute
  → registered guards
  → tools/execute
  → tools/post-execute
  → finalizeContent
  → tools/result
```

`pre-execute` 是可扩展的准入瀑布；`execute` 适合做围绕真实分发的包装；`post-execute` 可以处理或替换结果；`result` 只负责观察最终结果。[工具运行时文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md) 还特别区分了模型可见的工具结果和之后写入 session 的持久事件。

`dsh-file-undo` 选择 `tools/pre-execute`，理由很实际：它必须在工具 body 运行之前读文件。源码的 `snapshotIfMutation()` 先筛选工具名，再读取 `exec.arguments.file_path`，通过 `ctx.fs.resolve()` 和 `ctx.fs.readText()` 得到规范路径及旧内容，最后把快照追加到 JSONL 文件。[源码中的快照函数](https://github.com/QinLuza/dsh-file-undo/blob/master/src/index.ts#L99-L116) 可以压缩成下面这样：

```ts
async function snapshotIfMutation(exec, fs) {
  if (exec.name !== "write" && exec.name !== "edit") return

  const filePath = exec.arguments?.file_path
  if (typeof filePath !== "string") return

  const target = await fs.resolve(filePath)
  const before = await readExistingTextOrNull(fs, target)
  await appendSnapshot({
    filePath,
    command: exec.name,
    before,
    time: Date.now(),
  })
}
```

这个位置有两个好处。它不需要修改官方 `write` / `edit` 工具，也不需要把撤回逻辑塞进 Agent Loop；插件只观察一个既有执行边界，并保存未来补偿所需的最小信息。

它也有一个必须说清楚的代价：`pre-execute` 发生在真正执行前。如果后面的 guard 拒绝了调用，简单实现可能已经留下了一条快照。真实插件选择的是“尽量不漏记”，生产版本若要只记录成功写入，可以在前置阶段把快照放进 pending map，再在 `tools/post-execute` 确认成功后提交到持久存储。

## 真实插件：`dsh-file-undo` 做了什么

### 1. 依赖声明先把能力边界写进插件入口

插件入口导出了 `name` 和 `inject`，声明自己需要 `commands`、`tools`、`fs`、`sandboxPolicy` 四项能力。源码还通过类型导入把这些服务的类型合并到 `Context`，避免把 `ctx` 当成无边界的全局对象。[入口定义](https://github.com/QinLuza/dsh-file-undo/blob/master/src/index.ts#L17-L30) 的含义可以读成：

```ts
export const name = "file-undo"
export const inject = ["commands", "tools", "fs", "sandboxPolicy"]
```

这不是装饰信息。DeepSeek Harness 的插件 Guard 会检查依赖是否真的声明；少写 `inject`，代码可能通过 TypeScript 检查，但在运行时访问 `ctx.commands` 时失败。插件能编译，不等于它已经正确进入 harness。

### 2. 快照只保存恢复所需的数据

真实插件的 `FileUndoSnapshot` 只有五个字段：展示路径、工具名、操作前全文、时间戳，以及用 `null` 表示“文件原本不存在”。它没有保存模型 prompt、整个 session 或 Git diff。

```ts
interface FileUndoSnapshot {
  filePath: string
  command: "write" | "edit"
  before: string | null
  time: number
}
```

存储位置是 `~/.dsh/file-undo/snapshots.jsonl`。每次快照一行，写入采用 append-only 方式，避免多个工具调用都用“读取整个文件、修改数组、再覆盖写回”的方式追加记录。这个选择很朴素，但它把撤回历史做成了可以检查的事实列表，也让 `/undo list` 很容易实现。[快照存储源码](https://github.com/QinLuza/dsh-file-undo/blob/master/src/index.ts#L43-L97) 同时实现了弹出最近一项、按索引删除和按时间清理。

这里还要留一个工程提醒：真实插件的追加路径是 append-only，但 `/undo` 和 `prune` 会重写 JSONL 文件。如果要支持高并发工具调用或多个 Agent 共享历史，应再加单写者队列、文件锁或按会话分片；不能仅因为文件名叫 JSONL，就把整个存储层当成并发安全。

### 3. 撤回是显式命令，不是隐式重放

插件在 `apply()` 中注册一个 `undo` command，并声明 `input` 提示，让 `/undo list`、`/undo 1` 这类带参数输入真的进入命令 handler，而不是退化成普通用户消息。[命令注册源码](https://github.com/QinLuza/dsh-file-undo/blob/master/src/index.ts#L117-L175) 的核心结构是：

```ts
yield ctx.commands.register({
  name: "undo",
  input: { hint: "[list | <n> | prune [days]]" },
  handler: async (invocation) => {
    // 解析 list、索引、prune 或默认的最近一次撤回
  },
})
```

这里没有把撤回动作作为一条新的模型输入，也没有让模型自行决定要不要补偿。用户输入 `/undo` 后，命令直接从快照存储读取一条明确记录，再调用恢复函数。撤回对象、目标路径和恢复内容都由插件控制。

### 4. 恢复通过官方 fs，并带上当前 session 的沙箱策略

恢复函数先处理 `before === null` 的情况：这代表一次新文件创建，但官方 `fs` 没有 delete/unlink 能力，因此插件返回错误，不用 `node:fs` 越过 harness 去删除文件。对于已有文件，插件调用 `ctx.fs.resolve()`，再用 `ctx.sandboxPolicy.resolve({ session })` 得到当前会话的策略，最后通过 `ctx.fs.writeText()` 写回旧内容。[恢复源码](https://github.com/QinLuza/dsh-file-undo/blob/master/src/index.ts#L176-L197) 的关键逻辑如下：

```ts
if (snapshot.before === null) {
  return { kind: "error", text: "file deletion is not supported" }
}

const target = await ctx.fs.resolve(snapshot.filePath)
const policy = ctx.sandboxPolicy.resolve({ session })
await ctx.fs.writeText(target, snapshot.before, undefined, undefined, policy)
```

这正是“无副作用”边界的落点：恢复确实会写文件，但写入经过官方文件服务和原调用会话的 workspace policy；它不会变成一个脱离 sandbox 的任意路径写入器。插件作者没有把“我能读到这个文件”误当成“我应该能绕过当前权限写回这个文件”。

## `@2-llm-adapterprovider`：插件注册的撤回与文件撤回不是一回事

用户提到的 `@2-llm-adapterprovider` 可以对应到 DeepSeek Harness 的 LLM adapter/provider 这一组源码。它提供了另一个更接近 Cordis 原生语义的例子：插件注册 provider route 时，注册本身就是一个可撤回 effect。

在 [`LlmRuntime.registerAdapter()`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts) 中，运行时会先校验整组 provider：名称不能为空、同一 scope 内不能重复、adapter 的 metadata 必须与 provider id 对齐；全部通过后才提交路由。返回的 registration handle 还能用 `replace()` 原子替换自己持有的 route，避免“先 dispose、再 register”导致观察者看到短暂的空注册表。[LLM package 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/README.md) 把这个句柄描述成随调用 fiber 一起释放的注册关系。

`prepareCall()` 又把当前 adapter registration、解析后的 call config 和 retry policy 固定在一次 prepared call 上，而且一个 prepared call 只能 dispatch 一次。这样，provider 在下一次请求前被替换，不会偷偷改写已经准备好的这一次请求。

两类撤回可以放在一张表里：

| 场景 | 撤回的对象 | 逆操作 | 是否回滚已发生的外部事实 |
| --- | --- | --- | --- |
| `ctx.llm.registerAdapter()` | provider route 注册关系 | 从 registry 移除 route，发布更新事件 | 不会。已经发出的模型请求不可能被抹掉 |
| `dsh-file-undo` | 一次本地文件写入 | 写回捕获的 before-state | 只补偿目标文件，且依赖 sandbox policy |
| `ctx.effect()` | 插件在 context 中登记的资源 | disposer 按生命周期回收 | 不会自动补偿数据库、网络或 shell |

所以，不能把 LLM adapter 的 `dispose()` 当成“撤回模型调用”，也不能把文件快照插件当成通用事务系统。前者撤回的是能力注册，后者补偿的是一小类已发生的本地写入。

## 如果自己开发，建议沿着这条顺序落地

### 第一步：写出不可承诺的边界

先回答四个问题：

- 哪些工具会产生要保护的副作用？
- before-state 从哪个官方服务取得？
- 恢复动作是否仍然经过同一份权限策略？
- 哪些操作只能报“不支持”，不能偷偷绕过 API？

如果答案是“所有副作用都能回滚”，说明范围还没有定义清楚。第一版最好只支持既有文件的 `write` / `edit`，把创建、删除、shell、网络和数据库明确排除。

### 第二步：在最后一个可观察的执行前边界采集

工具结果通常太晚了。使用 `tools/pre-execute` 能捕获 before-state，但要接受它可能记录失败或被拒绝的调用；如果业务要求“只记录成功副作用”，就采用 `pre-execute` 保存 pending、`post-execute` 成功后提交的两阶段结构。

不要直接用字符串猜工具名。先查看实际工具 catalog，确认环境使用的是 `write` / `edit`，还是 `str_replace_editor`、`bash`、`run_code` 等其他入口。拦截错误名字时，插件通常不会报错，只是永远不命中。

### 第三步：让存储是插件自己的事实表

快照应包含目标、操作类型、before-state、时间和必要的 session/agent 标识。不要把恢复依赖在某个 UI store 的当前状态上；也不要把 session log 中的 tool result 当成 before-state。

如果多个会话共用撤回存储，必须决定撤回索引是全局的还是按 session 隔离。`dsh-file-undo` 的 README 明确写出它的快照是全局共享的，这是可用性取舍，不应在新插件里默默复制。

### 第四步：恢复路径要比捕获路径更保守

捕获阶段可以尽量多记，恢复阶段必须尽量少做：

- 只允许写回快照记录中的目标；
- 重新解析当前 session 的 sandbox policy；
- 不通过 shell 处理路径；
- 不使用未声明的 delete/unlink 能力；
- 快照不适用时返回错误，不猜测用户意图。

撤回失败时不要自动重试多次。一次写回失败可能是权限、文件已被用户再次修改或路径状态发生变化；盲目重试会把“撤回”变成新的覆盖风险。

### 第五步：把插件自身的生命周期也接回 `ctx.effect()`

命令注册、事件监听、定时清理和临时资源都应在 effect 作用域内创建，并在插件卸载时由 disposer 收回。这个 disposer 负责的是插件还活着时的资源管理；文件快照负责的是插件已经观察到的业务补偿。两者不要混成一个“万能 undo”。

## 测试要验证什么

一个小插件至少要覆盖下面几条路径：

| 测试 | 期望 |
| --- | --- |
| 已存在文件执行 `write`，再 `/undo` | 内容逐字节恢复到 before-state |
| 连续两次改同一文件 | 后进先出时，每次撤回都对应正确快照 |
| `/undo <n>` | 只恢复指定操作，不改其他记录的当前文件 |
| 新文件创建 | 清楚报告 delete/unlink 不支持，不偷偷删文件 |
| shell 重定向改文件 | 不声称已捕获，明确记录覆盖范围 |
| 工具被权限 guard 拒绝 | 若采用前置快照，验证是否会产生孤立记录；生产实现应决定是否清理 |
| 恢复路径超出 workspace | 被当前 sandbox policy 拒绝 |
| 插件卸载 | 命令和监听器消失，快照文件不会被误删 |

尤其要测试“撤回之后又发生一次写入”的情况。恢复动作本身如果再次经过同一个捕获 hook，可能把撤回写入也记成新的 undo 操作。真实插件的恢复走 `ctx.fs.writeText()`，它没有重新调用模型工具；但一个更复杂的插件仍应明确区分“Agent mutation”和“user-requested compensation”，避免撤回自己套自己。

## 最后的判断：把“无副作用”改写成可证明的范围

DeepSeek Harness 的插件接口适合做这类能力，是因为它把几个关键边界暴露出来了：工具执行前后有命名事件，能力注册有 owner 和 disposer，文件访问有官方 fs，恢复时可以重新解析 session policy，LLM provider 切换也有 registration 和 prepared call 这样的稳定对象。

但这些边界不会自动产生通用事务。`dsh-file-undo` 真正可靠的地方，恰恰是它只承诺一件很窄的事：**对已经捕获的 `write` / `edit`，把目标文件恢复到操作前内容。** 它不撤回 shell，不撤回删除，不撤回网络请求，也不假装把模型已经看到的内容从世界上抹掉。

如果要继续扩展，正确方向不是再加一个更强的“全局撤回”按钮，而是为每一种副作用定义自己的补偿协议：文件写入用快照，临时资源用释放句柄，外部 API 用业务级 compensation，模型调用只记录不可回滚的事实。插件的安全感来自这些边界可以被代码和测试逐条证明，而不是来自 `undo` 这个名字。

## 资料与源码入口

- [DeepSeek Harness 工具执行管线](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)
- [DeepSeek Harness LLM 能力包](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/README.md)
- [`LlmRuntime` 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts)
- [真实插件：`dsh-file-undo`](https://github.com/QinLuza/dsh-file-undo)
- [`dsh-file-undo` 主源码](https://github.com/QinLuza/dsh-file-undo/blob/master/src/index.ts)
- [作者在 DeepSeek Harness 社区发布的插件说明](https://github.com/deepseek-ai/deepseek-harness/discussions/2471)
