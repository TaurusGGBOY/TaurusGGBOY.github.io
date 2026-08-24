---
title: "DeepSeek Harness 如何开发无工作区副作用的撤回插件：以 dsh-message-edit 为例"
published: 2026-08-24
description: "从 dsh-message-edit 的源码出发，区分会话版本撤回、Cordis effect 与 DSH coeffect，并给出一种不修改工作区的插件设计。"
tags: ["deepseek-harness", "plugin-system", "session-versioning", "coeffect", "typescript"]
category: "AI / Architecture"
draft: false
image: ""
---

“撤回”不是一个足够精确的技术名词。

在 DeepSeek Harness（DSH）里，撤回可以指删除一段模型上下文、切换到旧的会话分支、释放一个插件注册的资源，也可以指补偿已经发生的文件写入。它们的对象、证据和失败方式都不同。把它们都叫作 rollback，很容易把 DSH 的 `coeffect`、Cordis 的 `effect` 和业务副作用补偿混成一个概念。

本文换一个更合适的真实案例：社区插件 [`dsh-message-edit`](https://github.com/Moeblack/dsh-message-edit)。它实现的是消息编辑、重生成、任意回合重试和版本时间线。它不原地改写旧 Session 事件，也不负责恢复工作区文件、命令外部效果或已经产生的产物。撤回发生在“会话版本”这一层，因此可以把它称为**无工作区副作用的上下文撤回**。

这里的“无副作用”有明确范围：插件不把撤回动作变成文件写回或 shell 补偿；它并不意味着重新生成时不会发起新的模型请求，也不意味着已经发生的网络、数据库或进程副作用可以被撤销。

## 先把三个概念拆开

DSH 的插件代码里至少会遇到三种容易混淆的“逆操作”：

| 概念 | 它管理的对象 | 典型代码 | 它不承诺什么 |
| --- | --- | --- | --- |
| `coeffect` | 运行时所需的依赖、provider 和 consumer 关系 | 依赖注入、服务可用性与动态组合 | 不负责回到旧的用户消息 |
| `ctx.effect()` | 插件注册动作的生命周期 | 注册 HTTP route、监听器或临时资源 | 不会补偿业务数据变化 |
| 会话版本 inverse | 一个版本分支与其父分支的关系 | `restore-version`、父 Session 导航 | 不会撤回已经发出的外部请求 |

这张表是全文的边界。`coeffect` 解决的是“这段代码依赖什么，以及依赖变化时怎样重新组合”；会话版本解决的是“下一次模型请求应该从哪一段历史开始”；`ctx.effect()` 解决的是“插件卸载时如何撤销自己的注册”。三者可以同时出现在一个插件里，但不是同一条撤回链路。

## 真实插件：dsh-message-edit 做了什么

插件 README 给出的安装方式是：

```bash
dsh plugin --profile web add dsh-message-edit
```

它提供三类操作：

- `edit`：编辑已经落定的用户文本、助手思考块或助手回复文本；
- `reroll`：从最近一个已完成的助手回合之前重新生成；
- `retry`：从指定历史回合重新执行。

每次操作都产生一个新的 Session 版本。默认的 `truncate` 策略只重新执行目标输入；`preserve` 策略则保留后续用户输入，让它们在新分支中重新经过模型和工具链。原会话并不被删除，Timeline 可以展示版本树，并通过父子关系切回旧版本。

这正是一个比“恢复文件”更干净的撤回例子：插件改变的是模型将要看到的会话投影，不是工作区的字节。

## 源码路径一：把撤回目标固定在完整回合边界

插件没有尝试从一条 `assistant/message` 事件中局部抹掉几段文本，而是先找到目标回合的闭合边界。`editPlan()` 的核心逻辑是：确定目标回合，令 `boundary` 指向该回合开始之前，然后把编辑后的用户输入或助手内容放入新版本计划中。

源码中的关键片段如下：

```ts
return {
  boundary: turn.startSeq - 1,
  version: pairVersionEffect(operation.sessionId, {
    operation: "edit",
    cascade: operation.cascade,
    targetTurn: turn.turn,
    targetEventSeq: event.seq,
    // ...before / after / blockKind
  }),
  queuedUsers: [edited, ...later],
}
```

这段设计防止了一种很隐蔽的错误：只复制一条消息，却把原回合里的工具调用、工具结果和 `turn/end` 留在上下文里。这样会得到一条看似连续、实际没有对应执行来源的历史。

因此，插件把“回退”定义为**回到闭合回合之前，再创建完整的新回合**，而不是对原始事件做原地编辑。README 也明确说明，目标回合的 `turn/start`、模型请求、工具调用、工具结果和 `turn/end` 不会被局部拼接到新版本中。

## 源码路径二：effect/inverse 作为版本数据，而不是删除事件

每个新版本都会附带一个 `message-edit/version` 事件。`pairVersionEffect()` 同时写入正向效果和逆向目标：

```ts
function pairVersionEffect(sourceSessionId, effect) {
  return {
    schemaVersion: MESSAGE_EDIT_VERSION_SCHEMA,
    effect: { ...effect, id: crypto.randomUUID() },
    inverse: {
      kind: "restore-version",
      sessionId: sourceSessionId,
    },
  }
}
```

这里的 `inverse` 不是“把旧 JSON 删除掉”。它记录的是应该回到哪个父 Session。源码的 `MessageEditVersionEvent` 类型也把这两半放在同一个持久事件里：`effect` 描述编辑、重生成或重试，`inverse` 指向恢复版本。

这种做法有三个直接收益：

1. 原始 Session 事件保持 append-only，历史消息的 ID 和工具关联不会因为撤回而被重写；
2. 父 Session 和子 Session 构成版本树，旧版本仍然可以被读取和切回；
3. undo/redo 不需要复制一份“看起来像旧消息”的替代文本，而是沿着真实的版本关系导航。

这也是“无工作区副作用”的关键：撤回动作本身只新增会话元数据和新 Session，不调用文件写入接口，不调用 shell，也不对原 Session 做 destructive mutation。

## 源码路径三：从 seed 创建子 Agent

`versionSeed()` 先继承目标边界之前的事件，再追加版本事件；如果是助手块编辑，还会追加一个结构完整的手工回合。随后 `createVersionAgent()` 调用公开的 `ctx.agents.create()`：

```ts
const seed = versionSeed(source, plan)

const child = await ctx.agents.create({
  sessionId: childId,
  seed: seed.events,
  meta: {
    cwd: source.header.cwd,
    parentSession: source.id,
    seedLength: seed.inheritedLength,
  },
  agentOptions: options,
})

await ctx.sessions.flush(child.agent.session)
```

`seed` 是新会话的历史起点；`parentSession` 和 `seedLength` 让运行时知道它来自哪个版本。创建成功后，插件才把需要重跑的用户输入交给 `child.agent.followup()`。

这里有一个值得复用的事务顺序：先构造并持久化完整的子 Session，再排入后续模型任务。如果创建或 flush 失败，代码会释放 child Agent；如果 workspace 挂接失败，也会执行对应的逆操作。这个“操作失败时清理插件自己刚创建的资源”是生命周期一致性，不是业务层的全局回滚。

源码中确实调用了 `workspace.attachSession(childId)`，但这只是把新 Session 关联到已有 workspace；它没有读取快照、写回文件或恢复 Git 状态。也就是说，**关联工作区会话**和**修改工作区内容**是两个不同动作，不能因为代码出现 `workspace` 就把插件归类为文件回滚插件。

## `ctx.effect()` 不是 coeffect，也不是业务撤回

插件最后用 `ctx.effect()` 注册 HTTP route：

```ts
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/message-edit",
      handler: (request, response) => handleRoute(ctx, request, response),
    }),
    "message-edit: HTTP route",
  )
}
```

这里的 effect 表示：注册 route 后，Cordis 持有一个 disposer；插件作用域结束时，route 可以被撤销。它解决的是资源所有权问题。

而 `coeffect` 的讨论重点是依赖和组合。例如，插件入口声明：

```ts
export const inject = [
  "sessions",
  "agents",
  "sessionPersistence",
  "sessionQuery",
  "workspaceRegistry",
  "webServer",
]
```

这表示插件需要这些运行时能力，才能完成版本创建、持久化、时间线查询和 HTTP 暴露。依赖服务是否存在、何时可用、依赖改变后怎样重新绑定，属于 coeffect/依赖组合问题；它不等于撤回某个用户回合。

可以用一句话区分：

> `coeffect` 决定插件能接上哪些能力；`ctx.effect()` 决定这些接线何时被收回；`message-edit/version` 决定会话版本如何回到父分支。

## `@2-llm-adapterprovider` 能提供什么参照

LLM adapter/provider 的源码适合用来说明“能力注册”和“会话历史”为什么必须分层。provider route 的注册、替换、失效和生命周期回收，处理的是下一次调用如何找到模型能力；它并不拥有已经落盘的用户消息，也不应该负责把历史会话切回某个 turn。

因此，开发会话撤回插件时可以借用 adapter/provider 的几个工程习惯：

- 注册前校验依赖和输入，避免半成品能力进入运行时；
- 把一次操作的正向效果和逆向描述放在同一个可验证结构里；
- 让一次 prepared call 在 dispatch 后保持语义稳定，不让后续 provider 变化改写既有事实；
- 用 disposer 管理注册关系，但不要把 disposer 当成外部副作用的补偿器。

对应的官方入口可以参考 [LLM 能力包文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/README.md) 和 [`LlmRuntime` 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts)。这些源码能帮助我们理解 provider 生命周期；`dsh-message-edit` 则展示了如何在 Session 层建立自己的版本关系。

## 开发自己的无工作区副作用撤回插件

### 1. 先写清楚撤回对象

第一版不要写“支持撤回所有操作”，而要写成：

> 对一个已闭合的 Session 回合，从该回合之前创建一个新版本；原 Session 事件保持不变；撤回不修改工作区文件、Git 状态或其他外部产物。

如果插件支持 `preserve`，还要补充：后续用户输入会在新分支重新执行，因此会产生新的模型请求和新的工具效果。这个策略不是“免费复制历史”，而是一次新的执行。

### 2. 把边界放在完整回合，而不是单条消息

需要先从事件流中识别：

- `turn/start` 和 `turn/end`；
- 本回合的 user message；
- assistant message、工具调用和工具结果；
- 回合是否已经闭合。

只对闭合回合提供 edit、reroll 或 retry。目标回合之前的事件可以作为 seed；目标回合之后的输入根据 `truncate` 或 `preserve` 决定是否重新排队。

### 3. 用版本树代替 destructive mutation

每个分支至少需要：

```ts
interface VersionEvent {
  schemaVersion: number
  effect: {
    operation: "edit" | "reroll" | "retry"
    targetTurn: number
    targetEventSeq: number
  }
  inverse: {
    kind: "restore-version"
    sessionId: string
  }
}
```

提交版本前验证三件事：父 Session 存在；边界是连续事件；逆向目标与 `parentSession` 一致。验证失败时，不创建半成品 Session，也不修改当前版本。

### 4. 把 workspace 关联和 workspace 修改分开

如果插件需要让新 Session 出现在同一个 workspace 下，可以调用 workspace registry 的公开 API 关联 Session；但不要因此顺手加入文件快照和恢复逻辑。只要需求变成“恢复文件”，它就已经是另一个插件能力，需要独立的快照、权限、并发和失败补偿设计。

### 5. 明确不可撤回的外部事实

重新生成会重新调用 provider。已经发生的模型请求、网络请求、数据库写入、发送出去的消息和已经退出的进程，都不能因为会话切换而消失。UI 上可以把旧版本隐藏在当前 surface 之外，但这不等于物理擦除，也不等于外部系统回滚。

## 验收测试

| 测试 | 期望 |
| --- | --- |
| 编辑一个已闭合的用户回合 | 新 Session 从目标回合之前分支，原 Session 仍可读取 |
| 编辑 assistant response | 新版本包含完整闭合回合，不复制原工具链 |
| `reroll` 最近回复 | 新版本重新排入原用户输入 |
| `retry` 历史回合 | `truncate` 与 `preserve` 产生不同且可观察的后续策略 |
| 选择旧版本执行 undo | 沿父 Session 关系切回，不删除原事件 |
| 连续执行 undo/redo | 每次只处理一个版本效果，验证 LIFO 和直接子分支 |
| 创建子 Agent 失败 | 不留下可见的半成品 Session 或 workspace 关联 |
| 插件卸载 | HTTP route 等注册资源被 disposer 收回 |
| 运行期间检查工作区 | 插件自身不写文件、不改 Git index、branch 或既有产物 |
| 检查外部调用 | 明确记录：重生成会产生新的模型请求，旧请求不可撤回 |

## 结论：把“无副作用”写成可验证的范围

`dsh-message-edit` 的价值不是提供一个“撤回”按钮，而是把撤回对象限制在会话版本：从完整回合边界生成子 Session，用 append-only 事件记录版本效果和逆向目标，再通过父子 Session 关系实现 undo/redo。它不把文件恢复、外部 API 补偿或 provider 注销混入同一个命令。

这也解释了为什么不能用 coeffect 来代替会话撤回。coeffect 让插件能够组合运行时依赖；`ctx.effect()` 让注册资源可被收回；会话版本事件才描述用户可见历史怎样变化。三个层次各自有清楚的所有权，撤回插件才不会变成一个无法验证的“全局 undo”。

如果未来要加入文件恢复，应把它设计成单独的能力：明确快照时机、写入权限、并发策略和外部副作用边界，并在文章和 API 名称中与上下文撤回区分开。对于当前这个插件，最可信的承诺已经足够具体：**切换会话版本，不改写原历史，不修改工作区；需要重跑的内容仍然是一次新的执行。**

## 资料与源码入口

- [DeepSeek Harness：Everything is a Plugin](https://github.com/deepseek-ai/deepseek-harness)
- [`dsh-message-edit` README](https://github.com/Moeblack/dsh-message-edit/blob/main/README.md)
- [`dsh-message-edit` Host 源码](https://github.com/Moeblack/dsh-message-edit/blob/main/src/index.ts)
- [`dsh-message-edit` 版本数据模型](https://github.com/Moeblack/dsh-message-edit/blob/main/src/shared.ts)
- [DSH LLM 能力包](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/README.md)
- [`LlmRuntime` 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts)
