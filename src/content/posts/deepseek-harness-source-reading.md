---
title: "DeepSeek Harness 源码阅读：把 Agent 运行时拆成一棵可替换的插件树"
published: 2026-08-13
description: "从源码追踪 DeepSeek Harness 的插件装配、Agent Loop、会话事件日志、LLM Adapter、工具执行和多智能体工作流，说明它怎样把一次模型调用变成可恢复的执行过程。"
tags: ["deepseek-harness", "ai-agent", "agent-runtime", "source-code", "typescript"]
category: "AI / Architecture"
draft: false
image: "/images/posts/deepseek-harness/deepseek-harness-overview.png"
imagePosition: "center"
---

当任务变成“读代码、改文件、运行命令、搜索资料、等待用户审批，失败后还能继续”时，模型只是执行链中的一个环节。DeepSeek Harness 的主要贡献在于把这条链组织成可替换的插件树：插件负责装配能力，turn/step/event log 记录推进过程，会话数据平面承接恢复，provider 则把模型、工具和多 Agent 后端接入同一运行时。

本文依据仓库当前源码，并对照项目的 [README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md) 和 [架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)。截至 2026 年 8 月 13 日，官方把它描述为 DeepSeek AI 开发的开源 Agent harness，当前仍处于 developer preview，存在兼容性破坏式变更。下文只说明源码和文档能支持的骨架，以及仍由使用者负责的边界。

## 先看结论：它不是一个更大的聊天循环

DeepSeek Harness 的关键判断是：**Agent 的可扩展性不应该靠不断向主循环里塞条件分支，而应该靠插件、事件和可替换的能力提供者来完成。**

仓库的架构文档把这件事写得很直接：everything is a plugin。模型适配器、工具注册表、会话日志和 Agent Loop 本身，都挂在 [Cordis](https://github.com/cordiverse/cordis) 提供的共享上下文上。插件通过 service、typed event 和可撤销 effect 参与运行，卸载时登记关系也会一起回收。

这个选择改变了产品的组织方式。一个功能不再只有“写一个工具函数”这一条路径，而是通常要回答三个问题：

- 服务接口是什么，其他组件依赖哪一个稳定的 `ctx` 能力？
- 这个能力由哪个 provider 实现，如何替换为本地、远程或沙盒版本？
- 它怎样作为 consumer 进入 Agent，尤其是怎样形成模型可见的工具 Schema？

这就是文档里所谓的 capability seam：Service Definition、Service Provider 和 Consumer 三个角色共同组成一个可替换能力。只写其中一层，功能可以跑起来，但不能算一个完整的 seam。

## 一、插件树：运行时由 profile 和 bundle 组装出来

启动一个 `dsh`，并不是固定地加载一个“大应用”。项目把运行时拆成 profile、bundle 和 patch 几层：`web`、`headless` 是可复用的入口模板；`dsh-base` 提供模型、工具、持久化、沙盒、审批、设置、凭证和 telemetry 等基础能力；Web 应用或无服务器的一次性执行器再叠加到上面。

配置层按顺序合并。profile 先列出 bundles，然后应用 profile 自己的 `cordis.patch.yml`、用户目录下的 patch，最后才是命令行 `--patch`。patch 按 row id 替换整行配置，或者插入一行新的插件配置。官方文档提供了一个很实用的检查入口：

```sh
dsh --profile web --dump-config
```

这条命令的价值不在于“打印配置”本身，而在于把最终运行时变成可检查的对象。你可以看到当前到底挂载了哪些 provider、工具和策略，再决定是替换一行，还是增加一个新能力。

这也带来一个明确的代价：**配置图会变得比单体应用复杂。** 你不再只读一个入口函数就能知道所有行为；要理解一次启动，需要同时看 profile、bundle、patch 和插件注册。对需要定制 Agent 的开发者，这是扩展点；对只想马上使用聊天界面的用户，这是学习成本。

## 二、主线不是“请求模型”，而是 turn → step → event log

读 [`packages/core/agent-loop/src/agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts) 时，最值得注意的是 `ReactLoopAgent` 没有把一次用户输入简单地映射成一次 HTTP 请求。它维护了 inbox、运行 phase、Agent 级别的 scope 和一组生命周期事件。

源码里的两个概念很重要：

- 一个 `step` 是一次模型请求，以及这次请求触发的工具调用。
- 一个 `turn` 可以包含零个或多个 step，直到没有待处理的工具结果或下一步输入。

所以，当模型先读文件，再运行测试，最后根据测试结果继续改文件时，用户看到的是一次任务，内部却可能是多个 step。源码把这个过程拆成了明确的持久化节点：

```text
turn/start
  claim inbox input
  assemble prompt sections + tool schemas
  -> agent/pre-step
     step/start
     user/message
     agent/request -> llm/stream
     assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute
     tool/result*
     step/end
  -> agent/turn-stopping
turn/end
```

`ReactLoopAgent.turn()` 先追加 `turn/start`，然后让 `preStep()` 从 inbox 中 claim 输入、装配 system prompt 和 scoped tool schema，再通过 `agent/pre-step` 允许插件重写或拒绝这次进入。`step()` 才真正建立请求，消费 LLM stream，把每个 chunk 写入 `assistant/chunk`，最后组装成 `assistant/message`。如果消息里有 tool call，就交给工具执行管线，并把结果放入下一步。

下面这张图把这条调用链和“哪些信息要落盘”放在一起看。它不是 UI 截图，而是按源码里的事件名称重新画的生命周期图。

![DeepSeek Harness 一次 turn 的数据流：从 inbox、prompt 和 tool schema 到模型流、工具执行与 session log。](/images/posts/deepseek-harness/deepseek-harness-turn-flow.png)

这里有一个比普通聊天记录更严格的约束：**model-visible means logged。** 任何进入模型请求的内容，都必须能从 session log 重建。`deriveMessages()` 从事件日志投影模型历史，原始的 `assistant/chunk` 则保留流式回放和 UI 展示所需要的细粒度信息。fork、resume、transcript、telemetry 和持久化都围绕这条事件流展开。

这个约束会影响后续开发。如果一个插件往 prompt 里偷偷加一段模型可见上下文，却没有增加对应的 session event，那么当前请求可能能工作，恢复会话时却无法复原同一个输入。Harness 把这个错误前置为运行时不变量，而不是等用户发现“恢复后模型变笨了”才处理。

## 三、会话数据平面：JSONL 和 SQLite 只是存储后端

会话包的职责不只是把消息写进文件。`core/session` 持有 append-only 的 `SessionEvent` 日志和内存 store；session persistence 再提供 JSONL 与 SQLite 后端；projection、标题和 telemetry 从同一条日志派生出面向客户端的视图。

这让“当前页面看到的对话”与“真正保存的事实”分开了。页面可以使用投影后的会话状态，恢复和分叉则回到事件流；模型上下文也不应该依赖某个 UI store 的偶然状态。

这种设计特别适合长任务，因为失败的位置有名字。模型请求前有 `agent/request`，流式响应有 `assistant/chunk`，工具阶段有 `tools/pre-execute`、`tools/execute` 和 `tools/post-execute`，本轮结束还有 `turn/end` 的原因。出了问题，系统至少可以区分是请求错误、工具错误、取消，还是模型已经达到 token 上限。

它也没有把持久化格式假装成永远稳定。仓库的开发说明明确处于 pre-release 立场，session format 和 SQLite schema 都由项目自己的版本机制管理；官方 README 同时提醒 developer preview 会有兼容性破坏。使用者应该把当前日志当作项目版本的一部分，而不是跨多个未来版本无条件迁移的公共协议。

## 四、模型层：Adapter 不只负责把 URL 换掉

LLM 目录把模型能力定义成一个 seam。`llm` 包拥有消息、内容块和 stream chunk 的共享词汇；`llm-deepseek` 提供直接 DeepSeek adapter；`llm-pi-ai` 提供多 provider 的 pi-ai adapter；retry 和 token measurement 作为独立 consumer 接在请求边界上。

在 `ReactLoopAgent.buildRequest()` 里，Agent 先通过 `ctx.llm.prepareCall()` 解析 provider、model 以及 adapter defaults，再把最终请求绑定到这个 prepared call：

```ts
const preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
```

这个过程解决了两个容易被忽略的问题。

第一，配置解析发生在明确的 `prepareCall()` 阶段。`LlmRuntime` 会复制并冻结解析后的配置、上下文和默认值；prepared call 只能 dispatch 一次，dispatch 前如果请求配置发生变化，会返回 `INVALID_PREPARED_CALL`。这比在 `run()` 内部随手 `?? default` 更容易审计，因为“这次请求到底采用了什么模型配置”有一个固定的解析点。

第二，Direct DeepSeek adapter 把一条 stream 当作完整生命周期处理。它在一次 stream 开始时冻结连接配置和凭证，合并调用方取消信号，启动 idle watchdog，并把异常映射成 `TIMEOUT`、`ABORTED` 或 `TRANSPORT` 等 LLM 错误。流没有正常耗尽时，它还会尝试关闭底层 iterator。

这意味着 adapter 的职责不是“把 OpenAI 兼容参数发出去”这么简单。它还要处理配置代际、凭证一致性、流超时、调用方取消和资源回收。对于工具调用 Agent，这些边界比一次成功的普通聊天请求更重要：工具可能已经执行了一半，下一次请求却被取消；如果 stream 和 session log 没有一致的生命周期，恢复时就很难说明究竟发生了什么。

## 五、执行世界：工具列表背后是可替换的 provider

DeepSeek Harness 的工具能力比较宽：Web search/fetch、Bash 或 PowerShell、filesystem、persistent PTY、LSP、E2B sandbox，以及 subagent 和 workflow。把它们并列放在产品介绍图里很直观，但源码真正有意思的地方在于它们不是一堆互相调用的工具脚本。

例如 shell、subprocess、filesystem、terminal 和 sandbox 之间通过 capability seam 连接。架构文档给出了一条很具体的推论：如果把 filesystem 和 subprocess 指向远程 sandbox，Bash、PTY 和 LSP 可以跟着进入同一个执行世界，而不需要为每一个工具再做一套远程分支。

这套关系可以压缩成：

```text
Service Definition
       ↓
Provider：local / sandbox / E2B / PowerShell …
       ↓
Consumer：model-facing tool / Agent / UI
```

`SandboxPolicyService.resolve()` 也没有把沙盒策略藏在执行器内部。它的优先级是请求级 `mode`，其次是当前 session 的 override，最后才是默认模式；workspace root 则从 session header 的 `cwd` 或服务默认值解析，并在有 session 时带上 session id。这使得“这一次 Agent 为什么在这个目录、使用这个模式”可以沿请求追踪，而不是靠工具函数里的隐式全局变量猜测。

权限控制也进入了 Agent 的事件和消息体系。`ApprovalService.setPolicy()` 更新 session 的有效策略后，会向 Agent inbox 注入一条由用户触发的说明消息，明确记录旧策略和新策略。这样，审批策略变化不只是宿主内存里的一个布尔值，后续模型请求也能看到这次变化的上下文。

这类设计有一个边界需要明确：**能力可替换不等于能力天然安全。** 沙盒 provider、文件权限、进程隔离和审批策略仍然要由部署者配置和验证；尤其是 workflow 的 worker thread 只隔离宿主事件循环，官方文档明确说它不是 security boundary。

## 六、多智能体和动态工作流：并发也被放进生命周期里

Workflow capability 允许模型编排 subagent，并提供 `agent()`、`parallel()`、`pipeline()` 这类操作。实现位于 worker thread 中，脚本通过受控的 hook 使用宿主能力，而不是直接拿到宿主上下文。

源码里的 `WorkflowExecution.agent()` 有几个很实在的保护点：

- 每次启动前检查取消状态，并用 `maxTotalAgents` 限制整个 run 能创建的 child agent 数量。
- 通过 slot 控制并发，child 启动、完成、失败、取消都有对应的 observer 事件。
- 取消发生在启动 round-trip 的间隙时，会主动 dispose 刚启动的 child，避免脚本已经结束而 child 还活着。

`parallel()` 和 `pipeline()` 对普通 item/stage 异常返回 `null`，而 `WorkflowError` 这样的 fatal error 才会中断整个脚本。这个选择适合批量任务：一个子项失败不必抛掉其他结果；但它也意味着调用方需要理解 `null` 的语义，不能把“空结果”简单当作“模型返回了空字符串”。

所以这里的多智能体不是一个“同时开很多模型窗口”的 UI 功能，而是一次可取消、有限额、可观测的执行过程。并发、子 agent 生命周期和工作流错误如何落到 session 里，仍然是产品体验的一部分。

## 七、它适合什么，不适合什么

从源码和文档看，DeepSeek Harness 更适合以下场景：

- 想搭建自己的 coding agent、research agent 或带工具的内部助手，并且需要替换模型、工具、沙盒或交互策略。
- 想把 Agent 的请求、流、工具结果、取消和恢复都作为可查询的事件处理，而不是只保留最后一条 assistant message。
- 想在同一套核心能力上同时提供 Web UI、headless runner、SDK、JSON-RPC 或 ACP 等宿主入口。
- 想研究一个“插件优先”的 Agent runtime 怎样保持可组合，同时把扩展点写进架构文档。

它不适合被理解成一个安装后就替你完成所有工程工作的黑盒。当前官方定位仍是 developer preview；不同 profile 的工具和 provider 取决于实际装配、凭证和运行环境；worker thread 也不能替代真正的安全隔离。想把它放进生产系统，至少需要自己验证配置层、沙盒后端、日志持久化、凭证管理、工具权限和升级策略。

如果只是想试运行，官方 README 给出的入口很短：

```sh
npx @deepseek-ai/dsh web
```

默认 Web UI 在 `http://127.0.0.1:3080` 提供服务。若从源码运行，则是 `pnpm install`、`pnpm run build`，再执行 `pnpm dsh web`。真正开始定制前，我会建议先运行 `dsh --profile web --dump-config`，然后从一个 capability seam 入手，而不是直接修改 Agent Loop。

## 最后：它把复杂度放到了正确但不轻松的位置

DeepSeek Harness 的核心价值不在于多列出几个工具，而在于它把 Agent 的复杂度拆成了几条可以分别替换、分别记录的链：

1. profile / bundle 决定运行时由哪些插件组成；
2. Agent Loop 用 turn 和 step 驱动模型请求与工具调用；
3. session event log 保存模型可见事实，并派生恢复、投影和 telemetry；
4. LLM adapter 处理模型路由、流式生命周期、取消和错误；
5. capability seam 把 shell、文件、Web、终端、沙盒和 subagent 接到执行世界；
6. workflow worker thread 在有限额和可取消的条件下编排 child agent。

它没有消灭 Agent 系统的复杂度，而是把复杂度从一个不断膨胀的主循环，搬到了明确的插件边界、事件边界和 provider 边界上。这个交换对需要定制运行时的人很有价值；对只想使用一个固定产品的人，则意味着更多配置和更多需要理解的部件。

## 资料与代码索引

本文事实以 2026-08-13 检查到的 `master` 源码和官方文档为准：

- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)：项目定位、developer preview、安装与运行入口、许可证。
- [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)：Cordis、profile/bundle、turn flow、session log 和 capability seam。
- [`ReactLoopAgent`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts)：inbox、turn/step、请求构建、流式消费与工具调用。
- [`LlmRuntime`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts)：provider registration、`prepareCall()` 和 adapter stream 生命周期。
- [`DeepSeekAdapter`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/src/adapter.ts)：凭证快照、idle watchdog、取消与错误映射。
- [Session capability family](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session)：JSONL、SQLite、projection、标题和 telemetry。
- [`WorkflowExecution`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow-worker-thread/src/runtime.ts)：worker-thread workflow、child agent、并发与取消。
- [`SandboxPolicyService`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-policy/src/index.ts) 与 [`ApprovalService`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/user-approval/src/index.ts)：执行策略和用户审批的源码入口。
