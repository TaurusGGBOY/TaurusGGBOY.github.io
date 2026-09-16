---
title: "Agent Harness 06｜谁能让 Agent 继续，谁能让它停下"
published: 2026-07-22T11:05:00+08:00
description: "对照四种 Agent Harness 的 stop reason、停止钩子、轮次与预算边界，解释 Agent 何时续跑、何时结束。"
tags: ["agent-harness", "claude-code", "codex-cli", "pi", "deepseek"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-06/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-09-16
---
## Claude Code

![Claude Code 在模型停止后依次经过恢复、Stop Hook、Token Budget 与外层门禁](/images/posts/claude-code-source-reading-06/agent-theme-06-claude-code-handdrawn.png)

*模型不再请求工具，只是进入收尾检查；恢复、Hook 和预算仍然可以让 `queryLoop()` 再请求一次模型。*

Claude Code 2.1.88 里有两套容易混淆的“停止原因”。第一套来自模型响应，例如 `message.stop_reason`；第二套来自 Harness 自己的 `queryLoop()` Terminal reason。循环不把前者直接当成控制开关。`restored-src/src/query.ts` 的注释明确记录，`stop_reason === 'tool_use'` 并不可靠，所以工具续跑依据是模型流里实际出现了 `tool_use` block。上一章讲的是有工具时怎样回填结果；这一章从没有 `tool_use` 的分支继续往下看。

没有工具调用以后，第一道门是恢复，而不是 Stop Hook。若最后一条 assistant message 是被暂存的 prompt-too-long，循环先尝试 drain 已分阶段生成的 context collapse，再尝试 reactive compact；恢复成功就更新 State 并 `continue`。若命中 `max_output_tokens`，在对应功能开启且没有显式环境变量覆盖时，可以先把单次输出上限提升到 `ESCALATED_MAX_TOKENS`，仍然截断时再注入一条“从中断处继续”的 meta user message。多轮恢复最多三次，由 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` 控制。

恢复失败后的处理也不是一律相同。无法修复的 413 返回 `prompt_too_long`，媒体尺寸问题返回 `image_error`；普通 API error 则跳过 Stop Hook，以 `completed` 收口，并异步执行 StopFailure Hook。源码注释解释了这个顺序：模型没有产出可评估的真实回答时，继续跑 Stop Hook 可能形成“API error → Hook 阻塞 → 重试 → API error”的死循环。

只有拿到有效的、没有工具调用的模型回答，`handleStopHooks()` 才接管。其结果有两条重要分支：

- `preventContinuation` 为真，循环返回 `stop_hook_prevented`。
- `blockingErrors` 非空，错误消息被追加到历史，`stopHookActive` 设为 `true`，`transition.reason` 写成 `stop_hook_blocking`，然后重新请求模型。

这里的 `stopHookActive` 不是“已经停止”，而是“当前续跑由 Stop Hook 触发”。它让后续 Hook 知道自己处于一次阻塞续写中，避免同一收尾逻辑无边界重入。也就是说，模型说“完成了”，Hook 可以拿 lint、测试或业务门禁的结果把这个结论驳回。

Stop Hook 放行后，启用了 `TOKEN_BUDGET` 才会进入 `checkTokenBudget()`。这个函数的参数边界很具体：`agentId` 非空表示子 Agent、预算为 `null`、预算小于等于 0，都会直接得到 `stop`；只有顶层 Agent 且预算为正才可能续写。可续写条件是本 Turn 输出 token 仍低于预算的 90%。每次续写会注入包含剩余预算的 nudge，并把 `transition.reason` 记为 `token_budget_continuation`。

Token Budget 还有收益递减刹车。续写次数达到 3 次后，如果本次相对上次新增输出少于 500 token，并且上一次增量也少于 500 token，`checkTokenBudget()` 会在尚未到 90% 时提前停止。这里的 90%、3 次和 500 都是固定源码可见值，不是对所有版本的产品承诺。

把 `query.ts` 中真实的 `return { reason: ... }` 汇总起来，固定窗口可见 10 类 Harness Terminal reason：`blocking_limit`、`image_error`、`model_error`、`aborted_streaming`、`prompt_too_long`、`completed`、`stop_hook_prevented`、`aborted_tools`、`hook_stopped`、`max_turns`，其中 `image_error` 在两个恢复出口出现，但属于同一种值。`model_error` 还携带 `error`，`max_turns` 还携带 `turnCount`。

这些 reason 的检查位置决定了它们能控制什么。`maxTurns?: number` 在工具批次收束、准备进入下一次模型请求时检查；`undefined` 或 0 不启用该分支。流式消费期间取消返回 `aborted_streaming`，工具执行期间取消返回 `aborted_tools`。两条取消路径都会先补齐必要的 `tool_result`，再退出协议链。

`maxBudgetUsd?: number` 又在更外层。`QueryEngine` 消费消息并累计成本后，若 `getTotalCost() >= maxBudgetUsd`，它产出 subtype 为 `error_max_budget_usd` 的 result 并返回。这个门禁不会倒流回已经发生的工具副作用，也不是 `queryLoop()` 的 Terminal reason。类似地，`taskBudget?: { total: number }` 会进入 API 的 `output_config.task_budget`，而“`+500k` 自动续写”走本地 Token Budget；名字都含 budget，作用域却分别是 API 请求、Harness 续写和整个 QueryEngine 成本。

**工具还在运行时，用户插话何时进入模型**

假设模型一次请求了 A、B、C 三个工具，A 已经返回，B、C 还在执行，用户补了一句“先别改文件”。普通提交先由 `restored-src/src/utils/handlePromptSubmit.ts::handlePromptSubmit()` 写进统一 `commandQueue`，`enqueue()` 没收到 priority 时默认使用 `next`。消息已经被界面接收，此时模型还没有看到它。

`queryLoop()` 完整消费 `getRemainingResults()` 或 `runTools()` 之后，才调用 `getCommandsByMaxPriority()` 取得待注入消息，再通过 `getAttachmentMessages()` 追加到下一次请求的上下文。因此 A 先完成并不会触发插话投递；正常路径要等当前响应产生的整批工具结果收齐，但不用等整个 Agent 任务结束。后台工作已经返回“已启动”结果时，其 tool use 已经结算，不要求后台进程也在此刻结束。

下面是这条普通路径的时序示意，不是源码摘录：

```text
模型请求 A、B、C → 工具执行 → 收齐本批 tool_result → 读取消息队列 → 下一次模型请求
                              ↑                         ↑
                    用户插话先入 commandQueue ──────────┘
```

读取队列前，源码专门提醒不要把普通 user message 插在尚未收齐的工具结果中间，否则 API 会报错。取消路径则用中断结果补齐配对，不能把“需要 result”理解成“必须正常执行成功”。消息如果错过本次队列快照，也要等后续消费点；已经发出的模型请求不会被这次提交改写。

这也解释了 steer、queue/follow-up 与 abort 的区别。steer 指当前工作链内的后续请求接收补充指令；queue/follow-up 指当前工作链准备结束以后再处理；abort 才要求取消当前执行。steer 同样可以通过队列实现，关键是消费位置。Claude Code 的普通 prompt 会被主循环中途取走，slash command 与 bash-mode 输入则不走这个普通 prompt 注入分支，而是留给回合间的队列处理器。

还有一层模型侧语义：`restored-src/src/utils/messages.ts::wrapCommandText()` 将普通插话包装为“用户在工作期间发来了新消息”，并要求完成当前任务后处理它。因此中途送达不等于强制抢占当前任务。工具是否因这次提交取消，由第 09、10 章介绍的 `interruptBehavior()` 和整批判断决定。

## Codex CLI

![Codex CLI 把普通 Turn、Stop Hook、上下文压缩、rollout budget 与 Goal 状态分层](/images/posts/claude-code-source-reading-06/agent-theme-06-codex-cli-handdrawn.png)

*普通 Turn 的 `break` 只结束本次采样链；可选 Goal 层仍可保持 active，在后续 Turn 继续目标。*

Codex CLI 固定提交 `c6dee5f` 的普通 Turn 停止点位于 `codex-rs/core/src/session/turn.rs::run_turn()`。一次 sampling 和工具执行返回后，函数计算：

```rust
let needs_follow_up = model_needs_follow_up || has_pending_input;
```

`model_needs_follow_up` 表示模型—工具链还欠一次采样，`has_pending_input` 表示当前 Turn 的输入队列又收到消息。二者任一为真都不能进入自然收尾。因此 Codex 也不能只根据模型最后一段文本判断 Turn 是否结束；运行时队列同样有继续权。

如果还需要 follow-up，同时 token 状态到达上下文限制，`should_roll_over` 为真。`run_turn()` 会执行 mid-turn auto compact，然后 `continue` 回到下一次采样。压缩是续跑前的上下文恢复，不是 stop reason。若 compact 报 `TurnAborted`，取消错误向上传递；其他压缩失败会发出 Turn error lifecycle 并结束当前路径。只有压缩成功，才有资格说“压缩让长 Turn 继续”。

当模型和输入队列都不要求 follow-up，Codex 才调用 `run_turn_stop_hooks()`。`StopOutcome` 的源码字段包括 `should_stop`、`stop_reason`、`should_block`、`block_reason` 和 `continuation_fragments`。多个 Hook 聚合时，`should_stop` 只要任一结果为真就成立；`should_block` 则要求没有 stop，同时至少一个结果要求 block。也就是说，显式停止优先于阻塞续跑。

阻塞还必须带来模型可见的新证据。`should_block` 为真且能从 `continuation_fragments` 构造 prompt 时，Codex 把这条 Hook message 记录到历史，接受当前 Turn 的 mailbox delivery，设置 `stop_hook_active = true`，然后 `continue`。如果 Hook 要求 block 却没有 continuation prompt，运行时发 Warning 并忽略这次 block，避免没有新信息的空转。`should_stop` 为真则直接 `break`；两者都不成立时，legacy after-agent Hook 未截断流程也会自然 `break`。

Codex 的成本边界不只在 `run_turn()`。固定提交包含可选的 `features.rollout_budget`。启用后，`limit_tokens` 必须为正；`reminder_at_remaining_tokens` 每个值都必须大于 0 且小于总上限；`sampling_token_weight` 与 `prefill_token_weight` 缺省都是 `1.0`，若显式提供则必须有限且非负。提醒由 `maybe_record_reminder()` 在下一次请求前写成上下文片段，它是“请准备收尾”的软信号。

硬边界发生在用量入账时。`Session::record_rollout_budget_usage()` 把 provider 返回的 `TokenUsage` 交给共享预算控制器；控制器报告越界，就返回 `CodexErr::SessionBudgetExceeded`。因此“reminder”与“SessionBudgetExceeded”不能画成同一种停止：前者仍允许下一次采样，后者是会话预算错误。

**一轮结束后，Goal 怎样启动下一轮**

假设用户要求修完一个模块，模型完成了第一部分，输出总结并结束本轮。普通 Turn 已经停止，剩余工作由谁接着推进？固定提交中的 `codex-rs/ext/goal/` 扩展负责这层调度。它把目标保存到 SQLite 的 `thread_goals` 表，记录 `objective`、`status`、`token_budget`、`tokens_used` 和 `time_used_seconds`。`thread_id` 是主键，每个线程保存一个当前目标，因此 Turn 结束不会把目标一起清掉。

`ThreadGoalStatus` 有六个值：`Active` 表示可继续推进，`Paused` 表示暂停，`Blocked` 表示受阻，`UsageLimited` 表示服务用量受限，`BudgetLimited` 表示目标预算耗尽，`Complete` 表示完成。线程进入空闲状态时，`GoalExtension::on_thread_idle()` 调用 `GoalRuntimeHandle::continue_if_idle()`：先检查扩展与工具是否可用、是否存在延迟续轮标记，再读取目标；只有 `Active` 才构造续轮消息，交给 `thread.start_turn_if_idle(...)`。下面是省略其他分支后的时序示意：

```text
普通 Turn 结束 → 线程空闲 → 读取持久化 Goal
                              ↓ Active
                    追加 Goal 续轮上下文
                              ↓
                    start_turn_if_idle()
                              ↓ 接受启动
                         新的普通 Turn
```

这里还有两处并发处理。读取目标到提交续轮之间持有目标状态锁，防止外部修改或清除目标后仍启动旧任务；真正启动则交给 `start_turn_if_idle()`，运行时可以拒绝不再满足空闲条件的提交。判断数据库里的状态不需要调用模型，启动下一轮工作才会产生新的模型请求。

**谁判断目标完成：模型调用 `update_goal`**

模型通过三个工具参与这套机制。`create_goal(objective, token_budget?)` 创建 `Active` 目标，已有未完成目标时返回错误；`get_goal()` 读取目标与用量；`update_goal(status)` 只接受 `complete` 或 `blocked`。创建预算必须为正，省略时回退到 `goals.max_goal_token_budget`，两者都未设置时不设目标 token 上限；显式预算不能超过配置上限。这些约束位于 `ext/goal/src/tool.rs`。

完成判断发生在正在工作的模型里。模型根据代码、测试或其他证据判断目标已经实现，调用 `update_goal({"status":"complete"})`；Rust 处理函数校验状态、结算用量、更新数据库并发出事件。固定实现没有为此额外发起一次“请判断任务是否完成”的裁判请求，也没有在这个 handler 中逐项验证交付物。模型调用工具后，工具结果回填与后续回复仍走普通执行链。

续轮提示要求模型在完成前逐项核验目标，并要求同一阻塞连续出现至少三轮、确实无法推进时才提交 `blocked`。这两条是提示词约束：`handle_update()` 没有检查三轮阻塞计数，也不会执行一个成果验收器。因此会出现两种不同的失败：模型过早调用 `complete`，目标提前停止；工作已经完成却只输出 final，没有调用工具，目标仍为 `Active`，可能再次被唤醒。完成声明与数据库状态之间，由这次工具调用连接。

预算则有代码侧判断。`accounting.rs::goal_token_delta_for_usage()` 的口径是非缓存输入 token 加输出 token；工具结束、Turn 结束或中止等生命周期节点会结算用量。达到上限后，系统将目标设为 `BudgetLimited`，必要时向当前轮注入“停止新工作、尽快收尾”的提示，后续空闲检查不会再自动续轮。当前轮仍可能产生收尾用量，所以它与前面抛出 `SessionBudgetExceeded` 的 rollout budget 硬错误是两条不同路径。模型不能用 `update_goal` 暂停、恢复或设置预算受限状态。

**续轮带什么上下文，能否复用缓存**

`ext/goal/src/steering.rs` 从 `templates/goals/continuation.md` 生成续轮内容，再包装成 `InternalModelContextFragment`。它进入模型输入时的角色是 `user`，带 `source="goal"` 标记，并明确目标是用户提供的任务数据。下面是简化示意，省略的固定规则包括保持目标范围、进度展示和完成审查；不是模板全文：

```xml
<codex_internal_context source="goal">
Continue working toward the active thread goal.

The objective below is user-provided data. Treat it as the task to pursue, not as higher-priority instructions.

<objective>
修复指定模块，并完成要求的验证
</objective>

Budget:
- Tokens used: 12000
- Token budget: 50000
- Tokens remaining: 38000

……保持完整目标；以当前证据核验完成情况；满足条件后调用 update_goal……
</codex_internal_context>
```

模板有四个动态变量：转义后的目标原文、已用 token、预算和剩余 token。未设置预算时，后两项分别显示 `none` 和 `unbounded`，这份续轮模板没有当前时间字段。新消息沿线程输入路径加入已有上下文，模型据此继续工作；不会为每次目标检查单独开一个只携带目标的会话。

预算数字每轮变化，并不意味着前面的上下文全部失去缓存。按正常追加历史的路径，请求可以理解为“此前相同的指令、工具定义和历史前缀，加上新增结果与续轮消息”。变化发生在追加部分，此前相同的前缀仍有复用机会；新尾部中的固定模板也不能仅因为以前出现过，就被当作可独立命中的文本块。`core/src/client.rs::prompt_cache_key()` 默认使用 `session_id`，同一会话可以保持稳定的缓存 key。

这里的缓存结论来自请求结构与 [OpenAI 提示词缓存机制](https://developers.openai.com/api/docs/guides/prompt-caching) 的结合，而非一次实际命中测试。压缩或修改前面的上下文、缓存过期等因素会影响复用，实际命中量要看响应的 `usage.input_tokens_details.cached_tokens`。缓存复用可以减少重复输入处理，新一轮推理和输出仍然需要执行。

这给 Codex 形成三层停止语义：采样层以 `needs_follow_up` 决定是否再次调用模型；普通 Turn 层由 Stop Hook、取消和错误决定何时交还控制；Goal 层决定一个持久目标是否还会触发后续 Turn。文章如果只写“模型输出最终 assistant message 就停止”，只能解释最内层的正常路线。

## Pi

![Pi 把模型停止、工具全票终止、宿主优雅停止和消息队列分成不同控制点](/images/posts/claude-code-source-reading-06/agent-theme-06-pi-handdrawn.png)

*`terminate` 由工具批次给出，`shouldStopAfterTurn` 由宿主给出，`abort` 由外部触发；三者不能互换。*

Pi 固定提交 `9d2ec7f` 先把 provider stop reason 规约成一个明确联合类型：`pending`、`stop`、`length`、`toolUse`、`error`、`aborted`、`deferred`。`packages/agent/src/agent-loop.ts::runLoop()` 不会把七个值都当作退出。它只对 `error` 和 `aborted` 立即发出 `turn_end`、`agent_end` 并返回；普通续跑仍看 assistant content 中是否实际存在 `toolCall`。

`length` 是一个特殊边界。若输出因为 token 上限被截断，同时已经出现工具调用，Pi 不执行任何可能只拿到半截参数的调用，而是通过 `failToolCallsFromTruncatedMessage()` 为整批生成错误 tool-result。该批次固定返回 `terminate: false`，让模型下一轮基于失败结果重新生成完整调用。这里的 length 没有被包装成“正常完成”，也没有把不完整参数交给工具冒险执行。

工具执行后，Pi 用 `AgentToolResult.terminate?: boolean` 表达“本批结束后不需要额外模型回复”的提示。真正的判定只有一行：

```ts
return finalizedCalls.length > 0 &&
  finalizedCalls.every(finalized => finalized.result.terminate === true)
```

`terminate` 可以是 `true`、`false` 或 `undefined`。只有非空批次中每一个 finalized result 都严格等于 `true`，`hasMoreToolCalls` 才变成 false。两个工具设为 true、第三个未设置，仍然继续；单个工具不能替整批决定停止。它也不是急停：已经开始的工具要先形成结果，steering 或 follow-up 仍可能让 run 继续。这个标志最适合“最后一步本身就是交付结果”的工具，用来省掉一次只负责说“完成了”的模型调用。

每次 `turn_end` 后，循环先调用可选的 `prepareNextTurn`。它可以返回新的 `context`、`model` 或 `thinkingLevel`；返回 `undefined` 表示全部沿用。单个字段省略也沿用当前值，只有 `thinkingLevel: 'off'` 会把 `reasoning` 设为 `undefined`。这个回调是在继续之前换装备，不是停止判断。

随后才调用 `shouldStopAfterTurn?: (...) => boolean | Promise<boolean>`。返回 `true` 时，循环立即发 `agent_end`，不会再轮询 steering 和 follow-up。返回 `false` 或没有提供该回调，才读取 `getSteeringMessages()`；内层本来要退出时，再读取 `getFollowUpMessages()`。所以这是一条优雅停止线：当前 assistant message、工具结果和 `turn_end` 都已完整产生，只阻止下一次 LLM 请求。

两个队列的时间语义不同。steering 是当前工作链内部的改向消息，进入内层下一次模型请求；follow-up 是 Agent 原本已无工具、无 steering 时才追加的工作，由外层循环重新开启。`shouldStopAfterTurn` 位于两者之前，宿主说停以后，排队消息不会在同一次 `runLoop()` 中反过来否决宿主。

外部 `Agent.abort()` 走另一条路径。它通过 `AbortController` 把 signal 传给模型流、工具准备和工具执行；串行模式会在每个调用后检查 abort，并行模式也会在 preflight 和执行边界检查。不过具体工具是否及时响应 signal，仍取决于工具实现。`abort` 可以打断正在运行的工作，`shouldStopAfterTurn` 只能在完整 Turn 边界收口，这就是急停与优雅停止的区别。

固定窗口的 `packages/agent/src/agent-loop.ts` 和 `AgentLoopConfig` 没有内建 `maxTurns` 或 `maxSteps`。这不表示所有 Pi 应用都没有上限：宿主可以在 `shouldStopAfterTurn` 中按轮数、上下文、时间或成本返回 true，也可以在外层设置 abort。准确说法是，核心循环把聚合停止策略留给装配它的宿主，没有在该固定包里给出统一默认值。

## DeepSeek Harness

![DeepSeek Harness 把 Step 候选结局收束为持久 TurnEndReason，并允许 turn-stopping 再注入一步](/images/posts/claude-code-source-reading-06/agent-theme-06-deepseek-harness-handdrawn.png)

*一次 Step 得到 completed 候选也不一定关 Turn；`turn-stopping` 期间出现新的 steering，状态机还会进入下一 Step。*

DeepSeek Harness 固定提交 `47f9438` 没有使用单个字符串同时表达模型停止和 Agent 停止。模型请求先由 `BlockAssembler.finish` 归约；Turn 最终把 `TurnEndReason` 写进持久 `turn/end` 事件。固定类型可见六种值：

- `completed`：Turn 正常完成。
- `aborted`：活动 Turn 被取消，并携带具体 reason。
- `blocked`：`agent/pre-step` 拒绝本次进入。
- `error`：Turn 失败，携带结构化 `LlmFailure`。
- `max-tokens`：至少一个 Step 撞到输出 token 上限。
- `interrupted`：持久化后端重载时关闭崩溃遗留的开放 Turn。

`aborted` 还保留取消来源。活动运行时的 `AgentCancelCause` 可选 `user`、`parent`、`hook { reason }`、`disposed`；持久化导入旧记录时还可能出现 `legacy`。`interrupted` 则不是 live loop 的取消分支，类型注释明确说明它只由 crash recovery 合成。把这两个值分开，重载后才能区分“用户确实按了取消”和“进程消失前没来得及关 Turn”。

`ReactLoopAgent.turn()` 开始后先写 `turn/start`，然后在 `while (true)` 中提议 Step。`preStep()` 返回 `reject` 时，`turnEnds = { kind: 'blocked' }`，可以形成一个没有任何模型请求的零 Step Turn。返回 `enter` 才写 `step/start`、把消息追加到 Session，并调用 `step()`。

`step()` 的结果有三种控制意义。模型没有工具调用，返回 `{ kind: 'completed' }`；模型流结束于 `max-tokens`，返回 `{ kind: 'max-tokens' }`；存在工具调用时，只有工具结果出现 `concludesTurn: true` 才返回 completed，否则返回 `null`。`null` 的意思是模型还欠一次消费工具结果的回复，`turn()` 因此直接开始下一 Step，不要求 `additionalContexts` 一定存在。

`max-tokens` 是粘性的。`turn()` 只在当前 Turn 还不是 `max-tokens` 时用后续 `stepEnd` 覆盖 `turnEnds`。即使插件通过 steering 让后面的 Step 正常完成，最终 Turn 仍保留 `max-tokens`，因为这轮工作曾经被截断。它比“只看最后一次模型请求”更诚实。

得到 completed 或 max-tokens 候选后，若 `inbox.nextStep` 为空，运行时会串行派发 `agent/turn-stopping`。监听器不能返回一个布尔值直接命令循环继续；它若认为还欠工作，需要调用 `agent.steer(...)` 把消息写入 next-step inbox。派发结束后状态机重新读取 inbox：有新消息就再跑 Step，没有才真正关闭 Turn。反方向的 `concludesTurn` 也不会清掉已经提交的 same-step additional context 或竞态 steering，队列仍要先 drain。

请求错误也有恢复层。`BlockAssembler.finish` 为 `error` 或 `aborted` 时，`agent/request-error` waterfall 可以返回 `{ kind: 'retry' }`，在同一 Step 的内部 `while (true)` 重新构建请求；没有 retry 动作才抛 `LlmError`，由 Turn catch 归约成 `error`。取消则把 Turn 记为 `aborted`，同时工具调度器会等待已启动调用收束，并为尚未派发的模型工具调用写入有序的合成错误结果。

固定窗口提供的两个“最大值”都不是整个 Turn 的迭代上限。`AgentOptions.maxTokens?: number` 必须是正的安全整数，只限制每次 conversation-model request 的输出；省略时交给 adapter/provider 路由默认值。`maxParallelToolCalls` 必须是正整数，默认 10，只限制一个 Step 内 parallel-safe 工具同时在飞的数量。

在固定 commit 的 `packages/` 与 `apps/` 中搜索 `maxSteps`、`maxTurns`、`maxIterations`、`stepLimit` 和 `turnBudget` 没有找到聚合 Step/Turn 上限，而 `turn()` 的 Step 驱动是开放的 `while (true)`。因此本证据窗口不能证明存在内建的每 Turn 最大 Step 数或花费上限。这个结论只限定于该 commit 的静态源码；provider quota、外部进程控制、插件或后续版本仍可能提供另一层边界。也正因为如此，降低 `maxParallelToolCalls`、缩小单请求 `maxTokens` 或启用压缩，都不能替代真正的聚合循环门禁。
