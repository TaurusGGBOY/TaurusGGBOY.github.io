---
title: "Agent Harness 10｜多个工具调用如何串并行"
published: 2026-07-24T09:30:00+08:00
description: "比较四种 Agent Harness 如何判定工具并发安全、建立独占屏障、限制并发并按原顺序提交结果。"
tags: ["agent-harness", "claude-code", "codex-cli", "pi", "deepseek"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-10/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-28
---
## Claude Code

![Claude Code 用相邻安全批次和独占屏障调度多个工具调用](/images/posts/claude-code-source-reading-10/agent-theme-10-claude-code-tool-orchestration-handdrawn.png)

*静态路径先切批次，流式路径逐个准入；两者都不允许调用越过独占屏障。*

Claude Code 2.1.88 有两套工具编排器。`runTools()` 用于已经拿到完整 `ToolUseBlock[]` 的静态路径，先切批次再执行；`StreamingToolExecutor` 在模型 response 仍返回时逐个接收完成的 tool block，边到边排队。两条路径共享一条安全原则：只有工具针对这次输入明确声明并发安全，调用主体才可以重叠；未知、解析失败或无法判断的调用都走保守路径。

静态路径的 `partitionToolCalls()` 从左到右扫描模型给出的顺序。它先按名称查当前工具池，再用该工具的 `inputSchema.safeParse()` 解析输入；只有解析成功，才调用 `isConcurrencySafe(parsedInput)`。返回值经 `Boolean()` 归一化；函数抛错、工具不存在或 schema 失败都得到 `false`。连续的 true 合进同一并发批次，每个 false 单独成为一个串行批次。例如 `Read A → Grep X → Edit A → Read B` 会形成 `[Read A, Grep X] → [Edit A] → [Read B]`，后一个 Read 不能越过 Edit 提前和前面的读取合并。

并发批次由通用异步生成器 `all()` 执行。它先启动不超过 cap 的 generator，任一 generator 完成后再从等待队列补位；消息更新可以按实际到达速度 yield。cap 来自 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`，代码是 `parseInt(value, 10) || 10`：未设置、无法解析或解析为 0 都回退到 10；正整数是正常覆盖方式。源码没有拒绝负数，负数会让“当前 promise 数小于 cap”永远为假，导致该并发批次无法启动，所以负数只能视为未防御的非法输入，而不是受支持选项。

消息可以实时交错，共享上下文却不能按完成速度乱序修改。并发工具返回的 `contextModifier` 先按 `tool_use_id` 缓冲；整个批次完成后，`runTools()` 按原始 block 顺序逐个回放 modifier，再进入下一个批次。串行工具则在每个 update 到达时立即修改 `currentContext`，后一调用拿到的是前一调用收敛后的上下文。这里维护的不是“所有输出严格有序”，而是副作用可见顺序：并发主体允许乱序完成，跨屏障的 context 不能乱序提交。

流式路径没有预先切好的完整数组。`addTool()` 收到一个 block 后立即完成相同的查找、schema 解析和安全分类，并把它标成 queued。`canExecuteTool()` 的条件只有两个：当前没有执行中的工具；或者新调用是安全的，并且所有正在执行的工具也都是安全的。于是多个安全调用可在模型流尚未结束时重叠；不安全调用必须等当前执行清空，开始后独占。队列扫描遇到无法启动的不安全调用会停止，后续调用不能越过它。

StreamingToolExecutor 没有调用静态路径的数字 cap，因此固定窗口里看不到 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 对这条动态路径的限制。它的约束来自模型逐块产出的速度、完整 block 提交点和安全 gate，而不是“最多 10 个”。这也是两个实现不能混为一谈的地方：静态并发批次有 cap，流式安全 siblings 在源码层没有同一 cap。

进度和最终结果也采用不同排序承诺。每个工具的 progress 会放入 `pendingProgress`，只要可用就立即 yield；最终结果按内部工具数组扫描。一个仍在执行的并发安全工具不会阻止后面的安全 sibling 先交付结果，因为 `tool_use_id` 能保持配对；但执行中的独占工具会让扫描停止，阻止后续结果跨越屏障。换句话说，Claude Code 维护必要的因果顺序，不把所有可观察事件强制压成一条完成顺序。

错误级联同样按依赖假设收口。只有 `Bash` 产生 error tool_result 时，streaming executor 才触发 `siblingAbortController.abort('sibling_error')`；源码解释 shell 命令更可能构成隐式依赖链。Read、WebFetch 等错误不会取消其他 siblings。用户中断与 streaming fallback 使用另外的 abort reason 和 synthetic result。下一轮模型请求仍要等当前 response 结束并把剩余工具结果 drain 完；提前并行只缩短等待窗口，不改变第 08 篇确认的双门禁。

## Codex CLI

![Codex CLI 用读写锁控制并行准入，并用 FuturesOrdered 有序写回结果](/images/posts/claude-code-source-reading-10/agent-theme-10-codex-cli-tool-orchestration-handdrawn.png)

*工具 future 可以重叠执行；不支持并行的 handler 持写锁形成独占区，history 按调用顺序 drain。*

Codex CLI 固定提交 `c6dee5f` 先把“模型能否一次返回多个工具调用”和“某个 handler 能否并发执行”分开。发采样请求时，`parallel_tool_calls` 取自当前模型的 `supports_parallel_tool_calls` 能力；这允许 provider 在一个 response 中产生多个调用，但不自动授权本地同时执行它们。每个 `ToolExecutor` 还有 `supports_parallel_tool_calls()`，默认返回 `false`，只有 handler 显式 opt in 才进入共享执行区。

完整 `OutputItemDone` 到达后，Codex 把工具调用交给 `handle_output_item_done()`。如果它产生 `tool_future`，sampling loop 立即将 future 压入 `FuturesOrdered`，然后继续读取后续 output item、文本 delta 和 `response.completed`。工具 future 因此可以与其他工具以及剩余模型流重叠；普通 function arguments 仍要到完整 item 才启动，不是看见一段参数 delta 就执行。

真正的并发 gate 位于 `ToolCallRuntime`。一个 sampling request 共享一把 Tokio `RwLock<()>`：声明支持 parallel 的调用等待并持有 read guard，不支持的调用等待并持有 write guard。多个 reader 可以同时进入 handler；writer 必须等当前 readers 清空，持有期间又阻止其他 reader 和 writer 准入，所以自然形成独占屏障。工具 runtime 的 readiness 在拿锁之前等待，真正通过 gate 时才记录 handler execution start。

这个分类是按工具运行时声明，不是按当前参数计算。`exec_command` 和 `shell_command` 在固定提交中都显式返回 true，因此两条命令可以并发进入各自 sandbox/进程生命周期；这并不证明两条命令访问同一文件就安全，调用者和命令自身仍要负责资源冲突。MCP handler 在 server 明确 opt in，或者工具 annotation 的 `read_only_hint` 为 true 时允许并行；两项都没有时回到 false。隐藏工具即使 runtime 声明并行，也不会被 registry 当作可并行的模型工具。

Codex 没有像 Claude 静态路径或 DeepSeek Harness 那样在这个固定提交中设置一个全局数字并发上限。一个 response 能形成多少并行 future，先受 provider 返回 item 数量约束，再受 handler opt-in 与 RwLock gate 约束；真正的进程、MCP server、sandbox 和系统资源还可能各自限流。源码只能支持“没有统一数字 cap”，不能推出无限并发能力。

`FuturesOrdered` 解决的是写回顺序，不是串行执行。future 入队后即可各自推进，后面的短工具可能先完成；消费端只有在前面的 future ready 后，才按插入顺序取得后续结果。`drain_in_flight()` 将每个 `ResponseInputItem` 依次写进 conversation history，并检查外部上下文污染标记。它会产生 head-of-line wait，但换来模型请求顺序与结果账本顺序一致。

采样循环必须先看见 response terminal，随后再 drain 全部 `FuturesOrdered`。因此工具 future 的并发分成三层：handler 主体可以在 RwLock read guard 下重叠；结果在 `FuturesOrdered` 中按调用顺序提交；下一次采样等当前 stream 和整个 future 队列共同收敛。这里的“parallel tool calls”从未把 turn 本身变成多个并发 turn。

取消时还要区分 runtime 是否拥有自己的清理职责。如果 terminal outcome 已经产生或 task 已完成，Codex 等待并保留真实结果；需要 runtime cancellation 的工具由取消路径取得 terminal outcome 所有权，同时等待进程 teardown；其他工具 task 可直接 abort。最终都形成结构化 aborted response 并发出工具取消事件，避免 history 只留下无结果的调用。并发优化不能绕过这个清理屏障。

## Pi

![Pi 先顺序准备整批调用，再并发执行主体，最后按模型顺序发送结果](/images/posts/claude-code-source-reading-10/agent-theme-10-pi-tool-orchestration-handdrawn.png)

*Pi 采用整批开关：任一 sequential 工具让全批串行；并行批次没有框架级数字 cap。*

Pi 固定提交 `9d2ec7f` 的调度策略比前两套更直接。`ToolExecutionMode` 只有 `sequential` 和 `parallel`。Agent loop 收到一条完整 assistant message 后提取其中全部 tool calls：如果 `config.toolExecution === 'sequential'`，或者任意被调用工具的 `executionMode === 'sequential'`，整批调用走串行；否则整批走 parallel。它不会在一批中切出 `[并行 → 独占 → 并行]` 三个区间，一个 sequential 声明会让所有 siblings 一起降级。

串行路径对每个调用依次执行完整生命周期：发 `tool_execution_start`，完成参数准备与验证，运行 `beforeToolCall`，执行工具，运行 `afterToolCall`，发 `tool_execution_end`，创建并发送 ToolResultMessage，然后才处理下一个调用。准备阶段找不到工具、参数无效、before hook 阻止或 signal 已取消时，会直接产生 immediate error outcome；signal 在一个调用之后变为 aborted，循环停止，不再启动剩余调用。

parallel 路径需要更精确地理解。外层 `for` 仍按模型顺序发 start 事件并 `await prepareToolCall()`，所以参数转换、schema 校验和 `beforeToolCall` 不会彼此并发。准备成功后，Pi 保存一个异步 thunk，并没有当场启动工具主体；只有所有可接受调用准备结束，`Promise.all(finalizedCalls.map(...))` 才逐个调用这些 thunk，让 `tool.execute()` 和随后的 `afterToolCall`/finalize 重叠。

因此 parallel 不是“prepare、execute、finalize 全部并行”。prepare 有确定顺序，execute 与每个调用自己的 finalize 可以重叠，`tool_execution_end` 会随各 thunk 完成而交错；`Promise.all` 的返回数组仍保持输入顺序，Pi 再按该顺序创建和发送 ToolResultMessage。UI 可以先看到后一个工具结束，下一轮模型上下文中的结果消息仍按原始 tool call 排列。

Pi 的固定循环没有 parallel 数字 cap。只要整批没有 sequential 标记，所有准备成功的 thunk 都进入同一个 `Promise.all`。工具数量通常由单条 assistant message 限定，具体工具或外部服务可以自行限流，但核心 AgentLoopConfig 没有 `maxParallelToolCalls`。工具作者如果不能保证主体并发，要显式声明 `executionMode: 'sequential'`；省略时不会自动按“可能有副作用”保守串行。

七个基础工具 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 在固定提交中都没有声明 sequential，因此默认进入 parallel 候选路径。文件一致性由更细一层补上：Edit 与 Write 在真正修改前都调用 `withFileMutationQueue(absolutePath, fn)`。队列先把路径规范成 mutation key，同一个 canonical path 的任务串接等待，不同 key 仍可并发。这允许 `Edit A` 与 `Write B` 重叠，同时阻止两个调用同时改 A。

取消不会通过事件监听器立刻释放这把文件队列。Edit/Write 在每个 await 后检查 `signal.aborted`，但一直持有 queue，直到当前异步文件操作真正 settle 才进入 finally 释放下一个 waiter。否则一个已经被标记取消、但底层写入仍可能完成的 promise 会与后来的修改同时操作同一文件。这个局部机制说明：框架级 parallel 只决定何时启动工具，资源级安全仍应由最了解冲突域的工具实现。

工具主体抛错也不会让 `Promise.all` 直接 reject。`executePreparedToolCall()` 捕获异常、等待已经排队的 partial update 事件，然后转成错误 ToolResult；after hook 还有自己的错误归一化。整批结果全部收敛后，`shouldTerminateToolBatch()` 再归约 `terminate`。并发路径提高的是主体重叠度，错误、结果和终止仍被编码回同一条 Agent 协议。

## DeepSeek Harness

![DeepSeek Harness 用有界滚动池、动态重分类和独占提交屏障调度工具](/images/posts/claude-code-source-reading-10/agent-theme-10-deepseek-harness-tool-orchestration-handdrawn.png)

*只有 dispatch/body 重叠；prepare、post-execute、持久化结果和附加上下文都按模型顺序提交。*

DeepSeek Harness 固定提交 `47f9438` 把每个待执行调用分类为 `parallel` 或 `exclusive`。`ctx.tools.executionMode(exec)` 解析当前 agent scope 中真正可见的工具，只有 `isConcurrencySafe(arguments)` **精确返回 `true`** 才得到 parallel；工具未知、隐藏、没有 classifier、参数无效、返回其他 truthy 值或抛异常都得到 exclusive。这个 fail-closed 判定发生在宿主，不进入模型 Schema。

native agent loop 先按模型顺序把 arguments JSON 解析为 `PlannedCall[]`。外层调度读取第一项的实时 classification：exclusive 只组成单调用 group；parallel 则把后续计划作为候选交给 rolling pool。pool 在每次真正 start 前重新调用 `executionMode()`，因为前面工具的有序提交可能修改 registry；一个排队时看似 parallel 的工具可以在启动前变成 exclusive。此时 pool 不让它挤入当前窗口，而是先 drain 已启动 siblings，再把它留给下一轮独占 barrier。

全局 `maxParallelToolCalls` 必须是大于等于 1 的整数，省略时使用 `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10`；0、负数和小数在插件加载或设置更新时直接报错。值为 1 时 rolling pool 退化为全串行。它只限制一个 Agent step 内已经分类为 parallel 的 native 调用，不是 provider response 的工具数量限制，也不控制 Code Mode 内部子调用。

调度器把生命周期拆成有序 lane 和可重叠区。`startCall()` 先写 durable `tool/call`，再按顺序完成 pre-execute/guards 的 prepare；只有 prepared dispatch 的 around-execute/tool body 放进 `inFlight`，这部分可以重叠。结果落入按模型 index 编号的 slot，`commitReady()` 只沿连续的 head-of-line slot 前进，依次运行 post-execute/finalize、写 `tool/result`、接收 `additionalContexts`，再读取下一项。后面的主体即使先完成，也不能让结果和上下文越过前项。

exclusive barrier 覆盖的不只是 tool body。只有该调用的 post-execute 和结果 commit 完成，后续调用才重新分类并启动。这比“写工具执行完就释放锁”更严格，因为 post policy 可以替换结果、附加下一 step 上下文，甚至改变注册表；让后项提前启动，会使它依据一个尚未提交的旧世界分类。

取消路径保持 call/result 配对。signal aborted 后，scheduler 停止补充 pool，等待所有已启动 dispatch settle，并按模型顺序提交它们；尚未启动的调用会追加 synthetic `TOOL_ABORTED_BEFORE_DISPATCH` 结果。内部 scheduler failure 的语义不同：它停止新 dispatch，`Promise.allSettled` 等待已经启动的工作，然后把第一个内部错误抛到 turn boundary，不为未提交调用伪造成功或普通工具失败结果。普通取消是可表示的运行结果，scheduler 崩溃是执行基础设施失效。

工具结果的 `concludesTurn === true` 在有序 commit 时归约到批次 outcome。它不会回滚或抢停已经启动的 siblings，而是在 group 收敛后通知 Agent loop 结束后续 step。工具可通过结果影响控制流，但仍不能跳过当前批次的审计和 drain。

Code Mode 还有第二个调度池。模型只发一个 `run_code`，程序中的 SDK sub-call 进入 bridge；`maxParallelSubCalls` 同样必须为正整数，默认 10，设为 1 可恢复串行。bridge 复用 parallel/exclusive classifier、启动前重分类和模型/提交顺序，exclusive sub-call 也会一直占据 barrier 到 post-execute commit 完成。它与 native 的 `maxParallelToolCalls` 是两个独立计数器：前者限制一个 run_code 程序内部，后者限制一条 assistant step 的原生 sibling calls。

run_code 结束时会 abort 并 drain 尚未完成的 bindings，排队但未启动的 sub-call 被放弃；已经发生的工具副作用不会因为程序最终失败而自动回滚。Code Mode 减少模型与 harness 的往返，并没有把并发变成事务。无论 native 还是 code，DeepSeek Harness 真正维持的是同一条提交纪律：并发只开放给明确安全的主体，有序 policy、结果和上下文始终是屏障的一部分。
