---
title: "DeepSeek Harness 如何实现可控撤回：从 dsh-file-undo 看插件边界"
published: 2026-08-24
description: "结合 DeepSeek Harness 的工具执行管线、Cordis 生命周期和 LLM adapter/provider 源码，说明怎样开发一个只补偿本地文件写入的撤回插件。"
tags: ["deepseek-harness", "plugin-system", "rollback", "side-effects", "typescript"]
category: "AI / Architecture"
draft: false
image: ""
---

DeepSeek Harness 可以把“撤回”做成一个范围受控的补偿插件：在文件工具真正执行前保存 before-state，在用户显式请求时，通过官方 `fs` 和当前 session 的沙箱策略写回原内容。

这个设计能处理一类具体事故：Agent 覆盖了尚未提交的配置或源码，用户想撤回刚才那一次 `write` / `edit`。它不承诺回滚所有副作用。恢复动作本身仍然是一次本地写入，但不会重新进入模型循环，不执行 shell，不访问网络，也不修改 Git 历史。本文把这种边界称为**可控撤回**。

真实例子是社区插件 [`dsh-file-undo`](https://github.com/QinLuza/dsh-file-undo)。它提供 `/undo`、`/undo list`、`/undo <n>` 和 `/undo prune [days]`，记录文件操作前的完整内容，再按用户指定的快照恢复。这个插件的价值不在于按钮名字，而在于它把采集点、存储、恢复权限和不支持的情况都写成了可检查的代码。

## 撤回的对象必须先定义

DeepSeek Harness 已经提供了几种相邻机制，它们的撤回对象不同：

| 机制 | 撤回或恢复的对象 | 不能替代的能力 |
| --- | --- | --- |
| Cordis 的 `ctx.effect()` | 插件注册的监听器、命令、服务和资源 | 恢复插件已经改写的文件内容 |
| session event log | 模型消息、工具调用和结果等持久事实 | 自动重建 `write` / `edit` 之前的全文 |
| `ctx.llm.registerAdapter()` | 当前 context 中的 provider route | 撤回已经发出的模型请求 |
| `dsh-file-undo` | 被捕获的一次本地 `write` / `edit` | shell 修改、删除和外部系统副作用 |

因此，文件撤回插件要防止的不是“插件卸载后监听器还在”这一类生命周期泄漏，而是“文件已经被覆盖，before-state 没有留下”。这决定了它必须进入工具执行管线，而不是只实现一个 `dispose()`。

## 采集点：`tools/pre-execute`

官方工具运行时把调用拆成一条有名字的管线：

```text
tools/pre-execute
  → registered guards
  → tools/execute
  → tools/post-execute
  → finalizeContent
  → tools/result
```

[`dsh-tools` 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md) 将 `pre-execute` 定义为可扩展的准入瀑布，将 `execute` 定义为围绕真实分发的包装点，并把 `tools/result` 保留为观察最终结果的事件。

`dsh-file-undo` 选择 `tools/pre-execute`，因为 before-state 在工具 body 运行后就可能丢失。它的 [`snapshotIfMutation()`](https://github.com/QinLuza/dsh-file-undo/blob/master/src/index.ts#L99-L116) 只处理 `write` 和 `edit`，从参数取出 `file_path`，通过官方 `fs` 解析和读取目标，再追加一条快照：

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

这个采集点绕开了两个不可靠来源：工具结果通常只返回成功文案，session 日志也不必然保存被覆盖前的全文。插件不需要修改官方工具，也不需要复制一套 Agent Loop；它只在既有执行边界上留下未来补偿所需的数据。

`pre-execute` 还有一个明确的边界：它发生在真正执行前。如果后面的 guard 拒绝调用，简单实现可能已经留下快照。`dsh-file-undo` 选择尽量不漏记；如果产品只接受成功写入，应在前置阶段保存 pending snapshot，在 `tools/post-execute` 确认成功后再提交到持久存储。

## 真实插件的四个实现点

### 1. 用 `inject` 声明能力

插件入口声明自己需要 `commands`、`tools`、`fs` 和 `sandboxPolicy`。[`src/index.ts`](https://github.com/QinLuza/dsh-file-undo/blob/master/src/index.ts#L17-L30) 中的核心定义是：

```ts
export const name = "file-undo"
export const inject = ["commands", "tools", "fs", "sandboxPolicy"]
```

这项声明同时承担类型和运行时边界。少写 `inject`，代码可能通过 TypeScript 检查，但在运行时访问 `ctx.commands` 时仍会被 Guard 拒绝。插件能编译，不代表它已经正确进入 harness。

### 2. 快照只保存补偿所需的数据

真实插件的 `FileUndoSnapshot` 包含展示路径、工具名、操作前全文和时间戳；`before: null` 表示文件原本不存在。它没有复制模型 prompt、整个 session 或 Git diff。

```ts
interface FileUndoSnapshot {
  filePath: string
  command: "write" | "edit"
  before: string | null
  time: number
}
```

快照写入 `~/.dsh/file-undo/snapshots.jsonl`，一行对应一次操作。追加路径采用 append-only，避免多个工具调用都用“读完整文件—改数组—覆盖写回”来追加记录。[存储源码](https://github.com/QinLuza/dsh-file-undo/blob/master/src/index.ts#L43-L97) 还实现了最近一项弹出、按索引删除和按时间清理。

这不是完整的并发协议。`/undo` 和 `prune` 会重写 JSONL；如果多个 Agent 共享撤回历史，应再加入单写者队列、文件锁或按 session 分片。真实插件的 README 也明确说明快照是全局共享的，这个取舍不能在新实现里被隐藏。

### 3. 把撤回做成显式 command

插件在 `apply()` 内注册 `undo` command，并声明 `input` 提示，使 `/undo list`、`/undo 1` 这类参数进入命令 handler。[命令注册源码](https://github.com/QinLuza/dsh-file-undo/blob/master/src/index.ts#L117-L175) 的结构可以概括为：

```ts
yield ctx.commands.register({
  name: "undo",
  input: { hint: "[list | <n> | prune [days]]" },
  handler: async (invocation) => {
    // 读取 list、索引、prune 或最近一项快照
  },
})
```

命令直接读取快照并调用恢复函数，不把撤回改写成新的模型输入，也不让模型自行决定补偿目标。目标路径、操作索引和恢复内容均来自插件维护的记录。

### 4. 用官方 `fs` 恢复，并重新解析沙箱策略

恢复函数先处理 `before === null`：这表示一次新文件创建，而当前官方 `fs` 没有 delete/unlink 能力，所以插件返回错误，不用 `node:fs` 越过 harness 删除文件。已有文件则通过 `ctx.fs.resolve()` 得到目标，再由 `ctx.sandboxPolicy.resolve({ session })` 解析当前会话策略，最后用 `ctx.fs.writeText()` 写回。[恢复源码](https://github.com/QinLuza/dsh-file-undo/blob/master/src/index.ts#L176-L197) 的关键逻辑如下：

```ts
if (snapshot.before === null) {
  return { kind: "error", text: "file deletion is not supported" }
}

const target = await ctx.fs.resolve(snapshot.filePath)
const policy = ctx.sandboxPolicy.resolve({ session })
await ctx.fs.writeText(target, snapshot.before, undefined, undefined, policy)
```

这里的权限语义很清楚：恢复会产生一次本地写入，但写入经过官方文件服务和原调用 session 的 workspace policy。插件不能因为自己曾经读到文件，就获得绕过当前 workspace 边界的写权限。

## `@2-llm-adapterprovider`：另一种可撤回关系

LLM adapter/provider 源码展示了“撤回注册关系”的另一种实现。`LlmRuntime.registerAdapter()` 会先校验整组 provider：名称不能为空、route 不能重复、adapter metadata 必须与 provider id 对齐；全部通过后才提交路由。返回的 registration handle 还能用 `replace()` 原子替换自己持有的 route，避免“先 dispose、再 register”让观察者看到短暂的空注册表。[`LlmRuntime` 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts) 和 [LLM 能力包文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/README.md) 都把这条关系描述成随调用 fiber 生命周期回收的注册。

`prepareCall()` 则把当前 adapter registration、解析后的 call config 和 retry policy 固定在一次 prepared call 上，而且一次 prepared call 只能 dispatch 一次。provider 在下一次请求前被替换，不会悄悄改写已经准备好的这次请求。

这两种撤回应分开理解：

| 场景 | 逆操作 | 能否回滚外部事实 |
| --- | --- | --- |
| `ctx.llm.registerAdapter()` | 从 registry 移除 provider route，并发布更新事件 | 不能撤回已经发出的模型请求 |
| `dsh-file-undo` | 写回捕获的 before-state | 只补偿目标文件，并受 sandbox policy 限制 |
| `ctx.effect()` | 按 owner 生命周期执行 disposer | 不自动补偿数据库、网络或 shell |

LLM adapter 的 disposer 撤回的是能力注册，文件快照插件补偿的是一类已发生的本地写入。两者都属于生命周期设计，却不是同一个事务。

## 开发自己的撤回插件

### 先写 claim ceiling

第一版应把承诺写成一句可测试的话：

> 对已经捕获的既有文件 `write` / `edit`，在当前 session 沙箱策略允许的范围内，把目标恢复到操作前内容。

这句话已经排除了删除、新文件清理、shell 重定向、网络、数据库和模型请求。每新增一种副作用，都应先定义它自己的补偿协议，而不是把“undo”扩展成全局回滚按钮。

### 在执行前采集，在成功后提交

如果只需要一个最小可用实现，`tools/pre-execute` 足以捕获 before-state。若要求撤回历史只包含真正成功的写入，则采用两阶段结构：前置阶段把快照放进 pending map，后置阶段确认成功后再追加 JSONL。

工具名也必须来自实际 catalog。环境可能使用 `write` / `edit`，也可能使用 `str_replace_editor`、`bash` 或 `run_code`；猜错名字时，拦截器通常不会报错，只会一直不命中。

### 让恢复路径比采集路径更保守

恢复阶段至少应满足四项约束：

- 只能写回快照中的目标；
- 每次恢复重新解析当前 session 的 sandbox policy；
- 不通过 shell 处理路径；
- 不使用未声明的 delete/unlink 能力，无法恢复时返回明确错误。

撤回失败不应自动多次重试。权限变化、用户再次编辑或路径状态变化，都可能让重试变成新的覆盖风险。

### 把插件生命周期和业务补偿分开

命令注册、事件监听、定时清理和临时资源应放进 `ctx.effect()`，在插件卸载时由 disposer 收回；文件快照则负责补偿插件已经观察到的业务写入。前者管理“插件是否还活着”，后者回答“某次文件变更是否能恢复”。

## 验收测试

| 测试 | 期望 |
| --- | --- |
| 已存在文件执行 `write`，再 `/undo` | 内容逐字节恢复到 before-state |
| 连续两次改同一文件 | 每次撤回都对应正确快照 |
| `/undo <n>` | 只恢复指定操作，不误改其他目标 |
| 新文件创建 | 清楚报告 delete/unlink 不支持 |
| shell 重定向改文件 | 不声称已捕获 |
| 工具被 guard 拒绝 | 验证是否留下孤立快照，并决定是否采用 pending 提交 |
| 恢复路径超出 workspace | 被当前 sandbox policy 拒绝 |
| 插件卸载 | 命令和监听器消失，快照文件不被误删 |
| 撤回后再次发生 Agent 写入 | 撤回写入不被错误识别为新的 Agent mutation |

最后一项尤其重要。真实插件通过 `ctx.fs.writeText()` 恢复，不会重新调用模型工具；更复杂的实现仍需区分 Agent mutation 和 user-requested compensation，避免撤回动作自己套自己。

## 结论：把“无副作用”改写成范围声明

DeepSeek Harness 适合承载这种插件，因为它把工具事件、能力注册、官方文件服务、session 策略和 LLM provider 路由都暴露成了可组合边界。`dsh-file-undo` 在这些边界上建立了一条完整链路：执行前采集、JSONL 保存、显式命令、策略约束下恢复。

它的可信度来自承诺很窄：只恢复已经捕获的 `write` / `edit`，不撤回 shell，不撤回删除，不撤回网络请求，也不抹去模型已经看到的事实。真正可迁移的经验是按副作用类型设计补偿协议：文件写入用快照，临时资源用释放句柄，外部 API 用业务级 compensation，模型调用只记录不可回滚的事实。

## 资料与源码入口

- [DeepSeek Harness 工具执行管线](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)
- [DeepSeek Harness LLM 能力包](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/README.md)
- [`LlmRuntime` 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts)
- [真实插件：`dsh-file-undo`](https://github.com/QinLuza/dsh-file-undo)
- [`dsh-file-undo` 主源码](https://github.com/QinLuza/dsh-file-undo/blob/master/src/index.ts)
- [作者在 DeepSeek Harness 社区发布的插件说明](https://github.com/deepseek-ai/deepseek-harness/discussions/2471)
