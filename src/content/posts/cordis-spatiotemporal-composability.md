---
title: "从插件能加载到组件可撤回：Spatiotemporal Composability 论文与 DeepSeek Harness"
published: 2026-08-13
description: "读完 A Programming Paradigm for Spatiotemporal Composability 后，结合 Cordis 与 DeepSeek Harness 源码，解释可撤回副作用、响应式依赖、组件生命周期，以及这套理论的适用边界。"
tags: ["spatiotemporal-composability", "cordis", "deepseek-harness", "agent-runtime", "plugin-system"]
category: "AI / Architecture"
draft: false
image: "/images/posts/cordis-spatiotemporal-composability/spatiotemporal-composability-map.png"
imagePosition: "center"
---

插件系统最难的部分，从来不是“把一个模块加载进来”，而是模块离开之后，运行时还是否保持干净；它依赖的服务消失或换了实现之后，使用它的组件又是否能按正确顺序停下来、重新连接。一个 Agent harness 还要面对模型流、工具、沙盒、审批、子 Agent 和持久化会话，这些对象的生命周期彼此交错，靠入口函数里的几组 `if` 很快就会失控。

我读完了 [A Programming Paradigm for Spatiotemporal Composability](https://github.com/cordiverse/paper/blob/main/paper.pdf) 的正文和参考文献，并对照了论文仓库的 [README](https://github.com/cordiverse/paper) 、[Cordis](https://github.com/cordiverse/cordis) 以及 DeepSeek Harness 当前的 [README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md) 和[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)。论文 README 把它标为 2026 年 8 月 13 日的 Draft，并明确说明仍是可能大幅变化的活跃预印本；因此，下面会把“论文的形式化保证”“Cordis 的实现”“DeepSeek Harness 的应用”分开叙述，不把预印本结论写成已经完成的产品承诺。

## 先给结论：这不是另一种 Agent Loop，而是动态组合的运行时基础

论文的核心判断可以压缩成一句话：动态插件系统要同时解决两个正交问题——**时间上的可撤回**和**空间上的可响应依赖**。

“时间”问的是：组件加载时做了哪些修改，卸载时能否只恢复自己的修改；“空间”问的是：组件需要哪些能力，能力出现、消失或换 provider 时，运行时能否自动决定它何时激活、何时停用。前者对应论文的 revertible effects，后者对应 reactive coeffects。

Cordis 把这两个机制放进一个统一的 context，再用 component、fiber 和生命周期状态组织一棵动态组件树。DeepSeek Harness 选择 Cordis 作为底层运行时，所以它的 “everything is a plugin” 并不只是目录结构上的口号，而是把 LLM、工具、会话、策略、沙盒和工作流都放进可组合的上下文中。

这也意味着一个重要的边界：**这套模型解决的是运行时组件怎样组合和撤回，不是模型怎样思考，也不是任意外部副作用怎样被时间机器式地回滚。**

## 一、论文究竟在解决什么问题

传统静态组合有两个成熟答案：词法作用域、RAII 或 `bracket` 负责在固定范围结束时释放资源；模块导入和依赖注入负责在程序启动时解析依赖。但插件热插拔、自更新运行时和自演化 Agent harness 的组合关系不是固定的：组件可能在进程已经运行很久之后加入，也可能在依赖更换时离开；组件的状态和异步操作还可能跨越多个调用栈。

论文把这种问题拆成下面的对应关系：

| 维度 | 要回答的问题 | 运行时机制 | 没有它时常见的退化 |
| --- | --- | --- | --- |
| Temporal composability | 卸载组件后，自己的效果能否被恢复 | 每个上下文变换携带 inverse，运行时跟踪并按逆序回收 | 只能重启宿主进程，或把清理责任分散给插件作者 |
| Spatial composability | 依赖变化后，谁应该激活、停用或重新绑定 | 组件声明依赖，context 变化触发通知和刷新 | 依赖只在启动时注入，provider 替换后 consumer 仍握着旧引用 |
| 统一 context | 如何让效果与依赖在同一棵动态组件树里协同 | effect、coeffect、fiber、生命周期和作用域 | 资源清理、依赖解析和配置更新各自维护一套状态 |

论文用 VS Code 扩展宿主和自演化 Agent harness 说明动机：如果多个扩展共享同一个宿主进程，禁用一个扩展通常不能安全地卸载它已经注册的监听器、路由、定时器和状态；最粗粒度的替代方案是重启进程或容器，但这样会丢掉进程内状态，也不能表达同一地址空间中的细粒度依赖。Agent harness 的模型适配器、工具集、执行环境、权限、会话、记忆和用户界面同样需要动态加入和撤回。

论文并没有把“动态”理解成随意修改全局变量。它试图给出一个可以推理的协议：组件必须知道自己修改了什么，必须声明自己需要什么，运行时要把这些修改和依赖变化纳入同一套生命周期规则。

## 二、两个核心概念：effect 负责撤回，coeffect 负责响应

### 1. Revertible effect：动作和逆动作成对出现

论文把一个效果抽象成：输入当前 context，返回新 context 和一个能够恢复旧 context 的 inverse。可以写成下面这个简化形式：

```text
effect : Γ → (Γ, Γ → Γ)
```

真实的实现不要求整个程序都可逆，而要求每个进入模型边界的原子 context 变换都提供可信的逆操作。多个效果组合时，逆操作按后进先出顺序组合：后注册的监听器先移除，后打开的资源先关闭，后加入的路由先撤掉。

Cordis 的核心 API `ctx.effect()` 正是这个思想的运行时版本。它接受普通效果或可迭代的异步效果，收集每一步 yield 出来的 disposer，再形成一个复合 disposer。论文特别强调两件事：组件作者负责提供 inverse，运行时不会自动证明这个 inverse 真能恢复旧状态；同一个 disposer 也不能被重复执行，否则它可能作用在一个从未被对应效果产生过的状态上。

可以用一个示意例子理解它：

```ts
const dispose = ctx.effect(function* () {
  const remove = bus.on("event", handler)
  yield () => remove()
})
```

这段代码真正重要的不是 `yield` 的语法，而是“注册”和“撤销”在同一个效果范围里被结构性地绑定。一个更大的组件由很多这样的原子效果组成时，运行时可以自动拼出整体的清理顺序。

### 2. Reactive coeffect：依赖变化驱动生命周期

Coeffect 可以先理解成“组件运行所需要的上下文”。组件声明依赖集合 `d`，context 中的 key 由不同 fiber 提供。每次 key 的提供关系发生变化，运行时重新判断依赖是否满足：

- 从不满足变成满足，组件进入加载或激活；
- 从满足变成不满足，组件进入卸载；
- 满足关系没有变化，属于中性变化，不应无谓地重载组件。

论文没有只记录“这个 key 有没有值”，而是记录依赖解析到哪个 provider。这样，provider A 被 provider B 替换时，即使两个 provider 提供的值看起来相同，consumer 仍能识别出“绑定身份变了”，从而重新建立自己的 committed view。

论文还引入了 isolate 和 intercept。前者允许同一个 key 在不同作用域解析到不同 binding，适合多租户、测试和沙盒；后者允许在不改变依赖身份的情况下，把访问元数据或策略叠加到调用上。这两个机制的共同点是：它们改变上下文中的解析或访问方式，而不是偷偷修改组件代码里的全局变量。

### 3. 统一 context：效果和依赖其实是同一个组合问题

论文把 effect context 和 coeffect context 统一成递归的 context。一个组件拥有自己的 fiber 和子 context：它的 effect 修改自己能看到的上下文，它的 coeffect 从声明的 provider 中解析依赖，它的子组件又可以挂在同一个生命周期树下。

这里最容易被忽略的是 observational equivalence。卸载之后，内存布局、对象身份或内部计数器未必能逐字节恢复；论文因此允许按照观察者真正能区分的操作定义“等价”。例如，一个资源分配器只要在释放后表现出与原状态相同的可观察行为，就可以认为恢复成立。

但这不是对“任何副作用都可以忽略差异”的授权。效果之间还需要满足独立性：如果两个组件都在修改一个有顺序意义的 middleware 链或共享队列，简单交换它们的加载/卸载顺序可能改变行为。这类效果要么声明顺序，要么通过 broker 把不稳定的 provider 注册隔离起来，不能假设所有插件都能任意并发热插拔。

## 三、为什么论文要引入 fiber 和这么多生命周期状态

论文中的 component 是依赖声明、provision 集合和 effect 函数的组合；fiber 是它在某个 context 中的一次实例。fiber 不是普通对象，它还记录父子关系、当前 target view、已经提交的 committed view、累计 disposer 和异步转换状态。

最简的生命周期是 `INACTIVE → RELOADING → ACTIVE → UNLOADING → INACTIVE`。论文又细化了过渡中的状态，是因为异步加载期间不能把组件当成已经 ACTIVE：如果一个组件正在安装工具注册或打开连接，它不应该在中途就把自己提供的 key 暴露给下游 consumer。

卸载 provider 时，顺序也不能反过来。论文的做法是先把 provider 标记为不再提供服务，让依赖它的 consumer 感知到 target view 已变化；然后等待这些 consumer 完成自己的卸载；最后才执行 provider 的 inverse。这样，consumer 的清理过程仍然可以读到它原先依赖的 binding，避免出现“依赖先被删掉，使用依赖的 teardown 反而无法执行”的竞态。

论文还处理了三种实际运行时问题：可迭代效果允许在多个步骤之间检查 target 是否变化；异步 in-flight 操作一旦启动就必须落地，不能假设所有 Promise 都能瞬间取消；效果失败时，已经完成的部分仍要走累计 inverse，失败组件记录为 inactive，而不是自动在原状态上盲目重试。

## 四、论文证明了什么，又没有证明什么

论文第四章把这些规则写成动态组合演算，并给出了几类元理论结果。对工程实现来说，最值得记住的不是定理编号，而是每个结果的前提：

1. **Preservation。** 只要初始 fiber 注册表满足父子关系、provision 不冲突、已激活组件的依赖解析有效，生命周期步骤会保持这些不变量。
2. **Recovery exactness。** 在效果相互独立、inverse 仍然适用的条件下，一个 fiber 的卸载会撤回自己的贡献，不会把其他 fiber 在期间完成的修改一起抹掉。
3. **Ordering and resolution coherence。** consumer 只在依赖已提供时激活；一个 transition 的多个步骤针对同一个 committed view 执行，不会在一次安装过程中悄悄切换 provider。
4. **Progress。** 当依赖优先关系无环、fiber 数量有限、每个效果迭代有界时，生命周期不会因为 provider 等待 consumer 而永久死锁，最终会到达 quiescent 状态。
5. **Confluence。** 在没有失败、效果独立且组件完整安装自己声明的 provision 时，动态加载、卸载和重新加载的历史不会改变最终规范状态；它应当等价于把最终配置从头装起来。

最后一条尤其重要，也最容易被误读。论文明确排除了失败对 confluence 的无条件保证：某个效果是否失败可能取决于它实际运行时看到的状态，不同调度可能得到不同的失败结果。论文证明的是有条件的动态组合性质，不是“热更新永远成功”或“组件作者写错 inverse 也没有后果”。

## 五、Cordis 怎样把形式化模型变成工程 API

论文第五章给出了理论对象与 Cordis 实现的对应关系：`Γ∞` 对应一棵 context 树，effect 对应 `ctx.effect()`，fiber 对应 `ctx.use()` 创建的组件实例，`fiber.dispose` 对应累计的恢复函数，`fiber.committed` 保存已经提交的依赖视图，`refresh()` 负责重新解析 target。

实现的关键路径大致是：

- `ctx.effect()` 是所有 context mutation 的底层入口，安装、注册、提供 coeffect 和创建组件都经过它；
- `ctx.set()` 把 provider 写入 store，并在写入和删除时调用 `notify()`；
- `notify()` 找到声明了受影响 key 且解析到对应 realm 的 fiber，调用 `refresh()`；
- `reload()` 先记录 committed view，再执行效果；如果执行期间 target 改变，就转入 unload；
- `unload()` 先通知并等待 dependents 退出，再运行累计 disposer，最后根据新的 target 决定保持 inactive 还是重新加载。

组件 loader 又在这些命令式原语之上增加声明式配置。配置中的 id、模块 URL、isolate、intercept、config 和 disabled 字段组成一棵配置树；配置变化被增量 reconcile 成 fiber 的创建、更新、禁用或重建。论文还给出了事务式 HMR：先判断模块依赖图，缓存失效后替换 stale entries，任一模块导入失败就恢复旧缓存并重建旧组件。

论文的案例是 Koishi，而不是 DeepSeek Harness。论文称 Koishi 生态已经积累了超过 4000 个社区插件，并用 IM adapter、数据库驱动、控制台等场景说明这套模型可以承载一个真实的开放插件生态；同时也承认这是单一生态、单一宿主语言下的观察性案例，不是针对替代架构的受控性能比较。

## 六、它在 DeepSeek Harness 中的具体落点

### 1. Agent scope：把一次 Agent 活动变成可回收的组件范围

DeepSeek Harness 的 [`ReactLoopAgent`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts) 构造时会为当前 Agent 创建 scope，再从 scope context 扩展出带有 agent 身份的 context。这个 scope 不是装饰性对象：Agent 的局部事件、工具可见性和生命周期注册可以绑定在这里，driver 退出后由 scope owner 统一 quiesce 和 disposal。

这正是论文中“一个组件拥有自己的 fiber 和子 context”的工程落点。它让 Agent 的局部能力不会自然泄漏到父运行时，也让子 Agent 可以拥有自己的生命周期，而不是和根 Agent 共享一组不可区分的全局监听器。项目的 [scope 实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/scope/src/index.ts) 还支持父 scope 关系和作用域过滤，说明“上下文树”在这个项目里是实际的运行时结构。

### 2. LLM adapter：provider 注册本身就是可撤回效果

在 [`LlmRuntime.registerAdapter()`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts) 中，adapter 路由的注册通过 `ctx.effect()` 完成；它记录当前持有的 provider 集合，disposer 执行时删除这些路由并发出 adapter 更新事件，同时暴露 `replace()` 让同一个注册句柄调整自己持有的路由。

这不是“调用一个 map.set 就结束了”。注册需要一个 owner，替换需要知道旧集合，释放需要幂等，事件需要在注册和撤销时保持一致。这些细节正好对应论文的 effect tracking 和 provider withdrawal。

[`LlmRuntime.prepareCall()`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts) 则体现了 spatial composability 的另一面：它先解析当前 provider registration 和模型配置，再冻结 resolved config，返回只能 dispatch 一次的 prepared call。这样，调用已经提交之后，路由或默认值变化不会悄悄改写这一次请求；后续请求才会重新解析新的 provider 关系。这和论文的 committed view、resolution coherence 是同一类设计取向。

### 3. Agent Loop：动态组合之外，还有一条可重建的会话数据平面

`ReactLoopAgent` 把一次工作拆成 `turn → step`。`preStep()` 从 inbox claim 输入，组装 system prompt 和工具 schema；`step()` 再消费 LLM stream，把 chunk、assistant message、tool call 和 tool result 写入 session event log。模型可见的请求内容必须能从日志重建，这是项目文档中的明确不变量。

这一点需要和 Cordis 的 effect recovery 分开看：**context disposer 负责回收进程内的注册关系，session event log 负责留下可恢复的事实。** 回收一个插件不意味着删除已经发生的模型输出、工具执行记录或用户消息；那些信息属于持久化数据平面，通常是 append-only 的。把两者混为一谈，会错误地把“组件可撤回”理解成“对话可以回滚”。

### 4. Workflow 与 subagent：生命周期可以递归，但安全边界要另算

在 [`WorkflowExecution.agent()`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow-worker-thread/src/runtime.ts) 中，workflow 会检查取消状态和总 Agent 上限，获取并发 slot，启动 child handle；如果取消发生在启动前后，它会重新检查并释放刚启动的 child，最后在 `finally` 中 dispose 并释放 slot。`parallel()` 与 `pipeline()` 也区分普通子任务失败和 fatal workflow error。

这与论文的 fiber、inertia、failure 讨论非常接近：异步对象要有明确 owner，取消要覆盖竞态窗口，失败要沿着定义好的生命周期出口离开。但它不能被夸大成安全沙箱。论文第六章明确说，依赖声明和 interception 是能力访问控制；不可信代码隔离仍需要软件故障隔离、独立运行时、进程、容器或其他执行边界。DeepSeek Harness 中 worker thread、子进程、E2B 和本地 shell 的安全含义也必须分别验证，不能仅凭一个 context scope 得出“代码已经被隔离”的结论。

### 5. capability seam：论文的 coeffect 在项目里变成 Service Definition / Provider / Consumer

DeepSeek Harness 的架构文档把能力拆成 Service Definition、Service Provider 和 Consumer 三个角色。例如 LLM 有服务接口、DeepSeek provider 和 Agent Loop consumer；shell、filesystem、web、subagent、skill、workflow 等能力也沿用同样的分层。

这就是 coeffect 的工程化表达：consumer 声明它要用什么，provider 负责把 key 放入 context，运行时在 provider 变化时重新判断 consumer 的生命周期。相比把一套工具直接硬编码进主循环，这种分层让本地实现、远程实现、沙盒实现和测试实现能够占据同一个能力位置。

## 七、这套理论应用到本项目时，必须说明的事项

### 1. “可撤回”有系统边界，不等于外部世界被回滚

论文把外部操作分成 acquisition 和 emission。打开文件、申请内存、创建子进程，通常可以先在边界内留下一个可关闭、可释放、可终止的 acquisition 记录；向网络发送数据、写入其他程序会读取的文件、调用第三方 API、产生模型输出，则是跨出边界的 emission，运行时不能凭空把对方已经看到的事实抹掉。

放到 DeepSeek Harness 里，取消一个 LLM stream 可以停止本地消费并释放连接；但不能让 provider 忘记已经处理的请求。撤销一个工具注册可以让后续请求看不到它；但不能自动撤销工具已经执行的数据库写入、网络请求或 shell 命令。需要回滚时，要么把 emission 延迟到提交点，要么为具体业务设计 compensation，例如删除临时文件、撤销临时资源或执行退款，而不能只写一个形式上存在的 `dispose()`。

### 2. 依赖声明带来可审计性，但不自动解决接口兼容

论文的基础模型主要按 key identity 连接 provider 和 consumer。独立发布的包仍然可能遇到接口漂移和 key collision。论文讨论了 key 命名空间、peer dependency 和结构兼容三条路线，并指出它们各有代价。

因此，在 DeepSeek Harness 中把能力拆成 typed service 并不意味着版本问题消失。Service Definition 需要稳定的类型和行为约定，provider 替换需要兼容性测试，跨包 key 最好有明确命名空间；否则 context 里的 key 虽然存在，consumer 拿到的值仍可能不满足它的行为预期。

### 3. 不是所有效果都能并发撤回

论文的 recovery exactness 依赖效果独立性。两个互不相关的 provider 注册可以交换顺序，但有序 middleware、优先级列表、共享连接池、单写者状态机和具有时序语义的事件总线不能被简单地当作可交换 map entry。

工程上通常有三种做法：把顺序写进生命周期约束；把共享状态收敛到一个明确的 broker；或者把组件拆细，让每个组件只拥有自己可以完整恢复的资源。DeepSeek Harness 的 shell、filesystem、web 和 LLM 适配器如果要做动态替换，也应先定义“请求进行中如何排空”“旧 provider 何时不再接收新请求”“替换失败后是否保留旧 provider”，而不是只测试静态启动。

### 4. isolate/intercept 不是权限系统，更不是沙箱

同一个 key 在不同 realm 中有不同 binding，可以解决多租户或测试隔离；intercept 可以让 provider 根据上下文元数据施加路径、只读或调用策略。这些机制提升了 capability 的可见性和可审计性，但如果不可信组件仍然能够直接访问宿主语言的全局对象、文件系统或网络，它就可以绕过代理。

DeepSeek Harness 的 sandbox policy、approval、local process、E2B 和 worker thread 必须作为独立的安全层验证。论文给出的准确说法是：context mediation 解决“组件通过声明的能力访问什么”，外部 sandbox 才解决“组件能否绕过这层 mediation”。

### 5. 动态配置不是无损热更新，组件内存状态也未必迁移

论文的 HMR 通过撤回旧 fiber 再加载新 fiber，强调事务性和半更新状态的恢复。这种方式适合把组件恢复到一个干净状态，但不会自动把旧组件的任意内存状态迁移到新版本。需要保留的状态应该放进更长生命周期的依赖、持久化 session 或显式 migration 过程。

这和 DeepSeek Harness 的会话日志设计形成互补：对话事实可以通过日志持久化和 projection 重建，短生命周期的 adapter、工具注册和 Agent scope 则可以在运行时重新装配。两条数据流应该有清晰的 owner，不要让“热重载插件”顺便隐式改写 durable session。

### 6. 论文仍是活跃预印本，DeepSeek Harness 也不是它的形式化验证对象

论文的案例研究是 Koishi，并不是 DeepSeek Harness；把论文概念映射到本项目，是基于当前源码与架构文档的工程分析，不是论文已经证明了 DeepSeek Harness 的全部行为。项目本身也处在 developer preview，Cordis 的 API 仍可能变化。

更准确的判断是：论文提供了 DeepSeek Harness 所采用的运行时设计语言和一组可检查的不变量；DeepSeek Harness 则把这套语言应用到了 Agent 的 LLM、工具、会话和工作流能力上。要声称某个具体插件满足论文保证，还需要在项目里补上对应的 dispose、替换、异步取消、失败恢复和跨组件独立性测试。

## 八、它和 LangChain / LangGraph 是什么关系

如果把问题放回 Agent 工程，Cordis/DeepSeek Harness 与 LangChain/LangGraph 解决的是不同层次的问题。

LangChain 更接近模型、工具和调用链的应用编程接口；LangGraph 更强调一个 Agent 或工作流内部的节点、状态、条件边、checkpoint 和执行控制。它们回答的是“这次任务如何走图、如何保存图状态”。

Cordis 的 context/fiber 模型回答的是“运行时有哪些能力、这些能力由谁提供、依赖变化时哪些组件要退出或重新加载、组件卸载时怎样回收自己的注册”。它面对的是更长生命周期的宿主运行时和动态能力组合。

所以，**它不是 LangGraph 的直接替代品**。更合理的组合是：把 LangGraph 作为一个业务工作流或某个 capability 的内部执行器，把 Cordis/DeepSeek Harness 作为承载模型 provider、工具、权限、会话和子 Agent 的运行时；或者在不需要动态插件和长期生命周期管理的项目里，继续使用 LangChain/LangGraph 的更轻量抽象。只有当你的主要痛点是“运行中替换能力、隔离作用域、自动响应依赖变化和撤回资源”时，论文里的这套范式才真正有增量价值。

## 最后：从这篇论文带走的工程判断

这篇论文最有价值的地方，不是把 `effect` 和 `coeffect` 换成了两个新名词，而是把插件系统中经常靠约定维持的事情，明确成了几条可检查的关系：每个效果有 owner 和 inverse，每个依赖有声明和 provider，每次变化都有生命周期响应，每个异步过渡都要有稳定的中间状态。

对 DeepSeek Harness 来说，这解释了为什么项目宁愿把 Agent Loop、LLM、工具、shell、filesystem、web、workflow、subagent、approval 和 session 拆成很多 package，也不把所有能力揉进一个主循环。拆分的目的不只是代码组织，而是让能力可以被注入、替换、限定作用域，并在离开时有机会回收。

但这套设计的正确使用方式也很明确：把 context-mediated registration 当作运行时资源管理，把 session event log 当作持久事实，把 worker/process/E2B 当作安全边界，把外部写入当作需要提交或补偿的业务副作用。只有把这些边界分清楚，“可组合”才不会被误读成“什么都能自动撤销”。

如果未来要验证这套范式对自演化 Agent harness 的价值，最值得补的不是一张更复杂的架构图，而是一组可重复的动态测试：在 Agent 正在流式请求、执行工具、等待审批和运行子 Agent 时，分别替换 provider、撤销 capability、触发失败和恢复配置，然后检查旧注册是否消失、依赖是否按顺序停用、日志是否仍可重建，以及外部副作用是否被正确标记为不可回滚或已补偿。这才是论文从形式化模型走向 Agent 产品时，真正需要补上的证据链。

## 参考资料与源码入口

- [论文原文：A Programming Paradigm for Spatiotemporal Composability](https://github.com/cordiverse/paper/blob/main/paper.pdf)
- [论文仓库 README（摘要、贡献与预印本状态）](https://github.com/cordiverse/paper)
- [Cordis 官方仓库](https://github.com/cordiverse/cordis)
- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)
- [DeepSeek Harness 架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [ReactLoopAgent](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts)
- [Scope 实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/scope/src/index.ts)
- [LLM Runtime](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/index.ts)
- [WorkflowExecution](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow-worker-thread/src/runtime.ts)
