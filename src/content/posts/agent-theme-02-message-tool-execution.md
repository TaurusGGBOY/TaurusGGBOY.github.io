---
title: "Agent主题对比02｜消息、工具与副作用"
published: 2026-08-12T10:02:00+08:00
updated: 2026-08-12
description: "比较三个 Agent 的消息协议、工具注册、调度、权限、沙箱、回滚与检索闭环，覆盖 07 到 15。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-02-message-tool-execution/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-02-message-tool-execution"
series: "agent-theme-comparison"
order: 2
difficulty: "advanced"
time: "55 min"
prerequisites:
  - "Agent主题对比 01｜控制平面与主循环"
  - "知道 tool call 与普通文本输出的区别"
topics:
  - "message protocol"
  - "tool registry"
  - "permissions"
  - "sandbox"
  - "rollback"
source_modules:
  - "restored-src/src/query.ts"
  - "restored-src/src/tools"
  - "restored-src/src/utils/permissions"
  - "restored-src/src/utils/sandbox"
  - "restored-src/src/tools/BashTool/shouldUseSandbox.ts"
  - "codex-rs/core/src"
  - "packages/coding-agent/src"
status: "verified"
verified_at: "2026-08-12"
---


> 模型说“请调用工具”只是一个意图。Agent 的执行链还要把它变成可校验、可授权、可执行、可回填、可审计的一次副作用。

上一主题确定了控制平面如何推进循环。本篇把一条 tool call 展开成副作用链：消息配对、工具注册与调度、权限与沙箱的两道门、文件修改的回滚凭据，以及检索工具如何把未知空间压缩成上下文。对应 Claude Code 源码系列 07–15，共 9 个独立 section。

![Agent 消息、工具与副作用链](/images/posts/agent-theme-02-message-tool-execution/agent-theme-02-message-tool-execution-handdrawn.png)

## 先建立一条统一的副作用链

三个系统都可以抽象成：模型输出 `tool_call` → runtime 找到契约 → 校验输入 → 决定是否允许 → 选择执行环境 → 运行工具 → 产生进度与最终结果 → 追加到消息/会话。比较的重点不是工具数量，而是每一步由哪个层持有、哪一道边界默认存在。

Claude Code 的固定源码快照来自 `restored-src`；Codex CLI 来自 `.source-commit=4ef836f883c38ba6d39e6920f335ce6452b7de33`；Pi 来自 `.source-commit=534bcbffb7e1e7551d9ee3572dfeb278e203e493`。下文不把当前实现外推成永恒产品事实。

## Section 07｜对话、工具与内部事件如何关联

### Claude Code：消息不是一层数组，而是三套投影

07 展示了 user/assistant 外壳、content block、内部事件之间的关系。流式 assistant 响应会先按块组装，再归一化到历史；`tool_use` 与 `tool_result` 通过同一个调用 ID 配对；progress 可能有独立的工具 ID；attachment 和 system 信息则把运行时状态注入消息。最终 transcript 用 JSONL 的 `uuid`/`parentUuid` 链恢复会话，UI 再消费另一种面向展示的投影。

这个设计解决了一个关键问题：传输中的部分块、模型能看到的历史、UI 要展示的进度、磁盘上可恢复的 transcript，不需要使用同一个数据结构。compact 也不是简单删除数组前半段，而是主动改写“哪些历史仍然属于上下文”。

### Codex CLI：item 是消息事件的统一承载

Codex 用 thread/turn/item 组织过程，item 可以代表用户消息、assistant message、reasoning、function/tool call 或工具结果。客户端通过事件流看到 item 的生成和状态变化，下一次模型请求则把合适的 item 转成输入。这样做比只保存最终文本更适合 IDE、审批 UI 和调试工具。

但 item 的公开并不意味着每个中间对象都原样进入模型上下文。宿主协议中的可观察事件、Responses API 的请求输入、sandbox 的执行输出仍是三种不同投影，需要沿转换函数核对。

### Pi：事件、消息和 session entry 分工

Pi 的 agent core 发出流式 agent events；coding-agent 把 assistant/tool message 追加到 session JSONL/tree；TUI 依据事件更新展示。compaction 和 branch summarization 会追加结构化 entry，再由 session 重建下一次请求上下文。扩展事件可以参与这条链，但不会自动获得额外安全权限。

Pi 的优点是投影关系容易读，风险是宿主如果只消费最终文本，就会丢失工具进度、失败原因和恢复信息。一个可嵌入 core 要求调用者认真处理 event，而不是只取最后一条 message。

### 对比结论

Claude Code 最强调 transcript 与运行时历史的双向可追踪；Codex 最强调 item 作为跨客户端协议；Pi 最强调 event 与 session 的可组合。三者都说明：消息协议的质量，取决于能否同时服务模型、执行器、UI 和恢复，而不取决于 JSON 长什么样。

### 验证动作

对一次工具调用保存四份记录：模型原始 tool call、执行前的校验/授权决策、工具结果、落盘后的 session/transcript。若其中两份只能靠字符串猜测关联，协议就不够稳。

## Section 08｜Claude 请求与响应如何传输

### Claude Code：raw stream 不是最终消息

08 从 `queryLoop` 依赖的模型调用器开始，经过内部上下文到 API 参数的整理、provider 选择、raw stream 读取、事件组装状态机，再把 `tool_use` 控制权交回 query loop。输入按换行恢复消息，输出按完整 JSON 行发送，模型事件按 content block 组装；`content_block_stop` 之后才产出完整的内部 AssistantMessage，usage 与 stop_reason 还需要回填。

错误也分层：建连/API 错误进入 `withRetry` 分类，Bedrock/Vertex 认证错误有单独映射，流中断可能降级为非流式请求，取消则要关闭底层资源。对比时不能把“收到了一个文本增量”当作 turn 已完成。

### Codex CLI：SSE 事件回到下一次请求

Codex 的 Responses API 通过 SSE 发送 reasoning、message、tool call 和状态事件；工具执行完成后，结果作为新的输入 item 回到下一次请求。它不依赖 `previous_response_id` 的一个重要原因，是让请求保持无状态，并能配合 Zero Data Retention 等部署约束。

这使得 Codex 的传输层很适合做事件回放和多宿主消费，但也要求客户端处理事件顺序、重复、取消和背压。App Server 的 bounded queue 不是附属优化，而是防止慢客户端拖垮执行循环的控制点。

### Pi：provider stream 由 agent loop 收敛

Pi 让 provider 产生统一的流式事件，再由 agent loop 处理 assistant delta、tool call、tool result 和终止状态。不同 provider 的认证、模型名和请求形态在 provider 层适配，core loop 不需要知道每个云厂商的 wire protocol。

Pi 的简洁来自边界清楚，而不是没有传输问题。流式消息何时完整、工具调用何时可执行、取消是否释放 provider 资源，仍然是上层需要验证的生命周期。

### 对比结论

Claude Code 关注“原始流如何收敛成内部消息”；Codex 关注“事件如何成为跨客户端协议”；Pi 关注“provider 差异如何被统一事件遮蔽”。排查流式 bug 时，先定位是 wire event、内部 message 还是 session entry，不要把三层日志混在一起。

### 验证动作

记录一次请求的四个时间点：首个模型事件、完整 tool call、工具结果回填、最终 stop。再注入一次半截流或取消，确认没有把不完整 assistant message 写成可恢复历史。

## Section 09｜工具契约与注册表如何工作

### Claude Code：Tool 把“模型契约”和“宿主执行”放在一起

09 的 `buildTool` 集中处理输入 schema、描述、默认行为、权限检查、执行函数和结果格式；当前会话的注册表最终是一份 Tools 数组。基础工具、条件工具、MCP 和插件都要汇入这份契约，`tool_use` 再按名称找到真正的工具。

这里有两层输入校验：先把模型输入解析成 schema 允许的形状，再由工具或执行层检查语义条件。`ToolUseContext` 则把 session、cwd、权限、abort signal 等执行上下文传入 tool.call。ToolSearch 还允许把 schema 延迟到需要时才展示，减少初始上下文压力。

### Codex CLI：工具是 core 与 host 的协议对象

Codex 的工具调用通常由模型 item 描述，执行器根据工具名和参数找到 handler，再把结果作为 item 回传。shell、apply_patch、读文件等能力与 approval/sandbox policy 结合，工具 schema 之外还要有运行环境约束。

Codex 的一个明显取舍是把执行器与 App Server 分离。这样同一个 tool contract 可以被多个客户端使用，但工具的 UI 描述、审批交互和真实进程权限必须由协议和 runtime 同时维护。

### Pi：`registerTool` 让扩展直接增加工具

Pi 的扩展运行时通过 `registerTool` 注册工具定义和执行函数，coding-agent 再把工具放入 agent loop。工具定义靠 schema 告诉模型参数形状，执行函数拿到上下文后返回结果。这个 API 很适合项目级工具和快速实验。

Pi 不会因为工具来自扩展就自动给它 sandbox 或最小权限；扩展和 agent 通常在同一进程/用户权限下运行。对于可信本地工作台这是可接受的简化，对于多租户或不可信代码则必须由宿主隔离。

### 对比结论

工具注册表决定了模型“知道什么”，执行器决定了系统“能做什么”，授权与 sandbox 决定了系统“允许做到哪里”。Claude Code 把三者放在较紧的工具生命周期里；Codex 把 contract、host protocol 和 executor 分层；Pi 用最小注册 API 换取扩展灵活性。

### 验证动作

新增一个只读工具时，分别检查 schema、语义校验、权限判定、执行上下文、结果格式和 session 落盘。只写了 `registerTool` 而没有回答后五个问题，工具还没真正进入生产 harness。

## Section 10｜多个 tool_use 如何串并行执行

### Claude Code：并发安全是工具自己声明的属性

10 把多个 `tool_use` 分成冲突域、可交换性和稳定合并。调度器先依据当前输入判断并发安全性，再把相邻安全调用组成批次；批次内部并行，批次之间串行。`isReadOnly` 描述副作用，`isConcurrencySafe` 描述调度许可，两者不是同一个布尔值。

结果可能按完成速度流出，但回填上下文要按原始顺序合并；progress 可以从并发工具持续冒出，取消和错误不能伪装成成功。槽位上限还会限制同批次规模。这个实现把“看起来能 Promise.all”变成了有明确不变量的调度器。

### Codex CLI：执行队列、PTY 和背压更重要

Codex 的统一执行入口在选择 sandbox、transform 命令和启动 PTY 后收集输出。多个工具的并发策略要同时受 approval、工作区冲突、网络 profile 和队列容量影响；事件通过 bounded queue 送往客户端，慢消费者不能无限占住执行资源。

Codex 的核心差异是把并发不仅视为工具内部问题，也视为 host protocol 问题。一个安全的调度器既要保证文件写入不互相覆盖，也要保证事件顺序和取消传播可解释。

### Pi：工具调用执行策略更接近可替换组件

Pi 的 `executeToolCalls` 提供明确的工具调用推进点，扩展和上层可以观察事件或改变策略。由于 core 不强制完整的权限/冲突图，默认行为更容易理解，但并行写入、网络请求和子进程冲突需要由 coding-agent 或宿主决定。

### 对比结论

Claude Code 在工具级声明中编码并发意图；Codex 把并发和执行队列、背压、宿主事件一起考虑；Pi 把执行策略留在可组合层。并行不是“快一点”的开关，而是对副作用、顺序、取消和结果回填的联合承诺。

### 验证动作

安排三个调用：两个独立只读、一个写入同一文件。检查系统是否把读操作合并、把写入与冲突域串行化，并在一个调用失败时正确标记同批次其他结果，而不是返回一张“全成功”表。

## Section 11｜一次调用如何从校验走到持久化

### Claude Code：六道门把 tool.call 夹在中间

11 的生命周期可以压缩成六道门：名称解析、结构校验、语义校验、PreToolUse、权限判定、真正的 `tool.call`，之后还要处理 progress、最终 tool_result、大结果文件和 transcript JSONL。只有越过 allow，世界才可能改变。

大结果不会全部塞进上下文，而是持久化到独立文件并返回预览；文件工具在 `tool.call` 内部处理快照/修改记录；最终结果才进入 transcript。失败发生在哪道门，决定调试应查 schema、hook、权限、执行器还是持久化。

### Codex CLI：approval 与 sandbox 是执行前的双重门

Codex 的工具调用在执行前要经过安全策略：是否需要用户 approval，使用哪种 sandbox profile，是否允许网络，当前 cwd 与文件范围如何限定。命令被 transform 后才进入 PTY/子进程，stdout/stderr 和退出状态再作为工具结果回传。

如果 approval 允许但 sandbox profile 不允许，命令仍不能获得超出 profile 的能力；反过来 sandbox 可运行也不代表用户策略允许自动执行。两者解决不同问题。

### Pi：生命周期短，但信任边界外置

Pi 通过工具 schema 和执行函数完成基本校验与调用，扩展可以在调用前后观察/改变行为，session 再记录消息和结果。它没有 Claude Code/Codex 那样强制的统一 permission+sandbox 门，因此“执行前是否确认”“进程能访问什么”依赖宿主和运行环境。

这种外置带来的好处是简单，代价是每个部署都要重新做安全审计。一个内部工具可以接受，一个下载并运行陌生扩展的服务则不应只依赖 Pi 默认行为。

### 对比结论

真正的工具安全不是一条 `if (allowed)`，而是一串分层门：契约、编排、hook、审批、资源隔离、执行、结果持久化。Claude Code 把链条做得最显式；Codex 把审批与 OS sandbox 分成两套策略；Pi 把很多门交给宿主。

### 验证动作

让工具分别在 schema 错误、hook 拒绝、权限拒绝、sandbox 拒绝、进程非零退出、结果过大六种情况下失败。每种失败都应有不同 reason 或可追踪事件。

## Section 12｜如何在允许、询问与拒绝之间决策

### Claude Code：权限是瀑布，不是弹窗

12 的权限引擎有多层输入：启动时装配的规则、工具名和可选内容、优先级、`transcript_classifier` 的自动判断、permission mode、工具自己的 `checkPermissions`、PreToolUse hook、宿主 `canUseTool` 以及“Always allow”带来的规则更新。只有最终 allow 才进入 `tool.call`。

auto 模式也不是“把一切交给模型”：快速路径先处理明显结果，剩下的 ask 才请求 classifier；system prompt 与安全投影后的 transcript 构成判断输入；输出契约和失败处理是 fail closed。子任务还要按运行方式重建会话级授权，不能把父任务的临时批准无条件继承。

### Codex CLI：approval mode 与 sandbox preference 分开

Codex 的安全策略通常由 approval profile 与 sandbox preference 共同决定。`SandboxablePreference` 可为 `Auto`、`Require`、`Forbid`；`SandboxType` 则按平台选择 None、macOS Seatbelt、Linux Seccomp 或 Windows Restricted Token 等。它们共同影响工具是否需要询问、如何运行和是否允许网络/写入。

重要的是，模型不能自己把 `Require` 改成 `Forbid`。控制策略来自 host/runtime 配置，模型输出只是请求动作。这样能把 prompt injection 造成的“自我授权”挡在控制平面外。

### Pi：权限能力取决于宿主信任模型

Pi 的核心扩展和工具注册 API 没有内置一个等价的全局 permission waterfall。项目 trust、扩展加载策略和宿主进程权限决定了工具是否出现、是否执行。对本地可信项目，这种自由度便于工作；对不可信仓库，必须把 Pi 放进外部 sandbox 或给扩展单独运行时。

### 对比结论

Claude Code 用瀑布和 hook 让每次工具调用都可解释；Codex 用审批 profile + sandbox type 让用户策略和 OS 隔离分工；Pi 把权限模型交给 host。不能用“是否有确认弹窗”评价安全性，应该问：拒绝的来源能否追踪，允许的范围能否收紧，恢复/子任务是否重新判定。

### 验证动作

分别测试默认、自动、只读、允许编辑和禁止 sandbox 等模式，记录同一个 `Bash` 或文件写入请求的 decision path。若模式名改变了结果但看不出是哪层改变，权限系统就缺少可观测性。

## Section 13｜如何建立命令执行安全边界

### Claude Code：解析、权限、sandbox、进程管理四层叠加

13 先固定 Bash 输入 schema，再解析复合命令、重定向和真实操作，检查危险模式；权限放行后，sandbox 还会做资源边界判断；真正启动进程前再确定 shell、cwd、环境、超时和 Abort。输出也有预览边界，模型看到的不是无限 stdout。

Claude 的 sandbox 运行时按平台选择 macOS Seatbelt、Linux bubblewrap/proxy/seccomp 等机制；`shouldUseSandbox` 还会综合工具输入、配置、平台能力和运行模式。沙箱起不来时的 fallback 不是一个可以忽略的细节，必须看当前模式是询问、拒绝还是允许降级。

### Codex CLI：原生命令执行器与 Landlock/Seatbelt

Codex 的 `SandboxManager` 负责判断是否 sandbox、选择 `SandboxType` 并 transform 命令。Linux profile 可以组合 Landlock 文件系统限制、网络代理和当前 cwd；macOS 走 Seatbelt；Windows 走 Restricted Token；也存在明确的 none/forbid 路径。统一执行器随后在 PTY 中启动经过变换的命令。

这里的关键是 OS 原语实际约束子进程及其子进程，而不是只检查模型写出来的字符串。代理网络也要限制域名；否则文件系统隔离仍可能被网络外传绕开。

### Pi：没有内置 sandbox，能力取决于运行环境

Pi 的 README 明确把自己定位为 minimal harness，并说明 extensions 与 agent 在同一进程/用户权限中运行、没有 built-in sandbox。它可以调用 shell 或项目工具，但不会自动给每条命令套 Seatbelt/Landlock。

这不是“Pi 不安全”的完整结论，而是清晰的责任分配：可信本地工作台可以由用户自己的 OS/容器边界承担；服务化、共享机器或陌生扩展场景必须外包给容器、虚拟机、沙箱 runner 或权限受限账户。

### 对比结论

Claude Code 的强项是把命令语义检查、权限、sandbox 和进程生命周期串成一条链；Codex 的强项是将 profile 选择和 OS 执行器做成明确的运行时；Pi 的强项是轻量和可嵌入，但安全边界不在 core。把三者放在同一安全基线下比较，必须把“默认提供的边界”和“可以由部署补上的边界”分别计分。

### 验证动作

尝试四类逃逸：shell 复合命令、子进程、访问 cwd 外文件、访问未允许域名。只做字符串过滤而没有 OS 级阻断的实现，不能算完成 sandbox。

## Section 14｜如何通过快照与历史实现回滚

### Claude Code：并发保护与历史恢复是两条时间线

14 把 Read/Edit/Write 的并发保护和文件历史回滚分开。Read 保存内容与修改时间作为写入凭据；Edit 用字符串匹配和并发状态约束目标；Write 保护相同但破坏半径更大；NotebookEdit 按 cell 语义修改。检查点先行，第一次修改前补入备份，回滚按文件独立恢复。

这套机制防止两类不同问题：文件在模型读取后被别人改了，以及模型自己改错后用户想恢复。权限保护的是修改入口，不自动覆盖回滚入口；回滚也有边界，不能把所有外部副作用倒推回去。

### Codex CLI：checkpoint 更依赖 workspace/git 与 host 策略

Codex 的 harness 强调 worktree、版本控制和应用层 checkpoint；shell/apply_patch 改动会回到工作区，用户可以通过 git diff、worktree 或 host 的 undo 能力审阅和恢复。它的 sandbox 主要限制“能访问什么”，不等价于“已经改变的文件可以自动回滚”。

因此评估 Codex 的 rollback 时要区分：OS sandbox、进程取消、workspace snapshot、git revert、客户端 undo。若只看到命令被限制，就不能推断文件修改具备时间旅行能力。

### Pi：session 分支不是文件快照

Pi 的 JSONL/tree session 能回到旧的对话分支，compaction 也能保留决策和文件列表；但切换 session branch 不会自动恢复工作区文件。实际文件恢复通常依赖 git、编辑器历史或宿主扩展。

这个区别很容易被用户误解：你可以回到“模型当时说了什么”，但文件系统已经改变。Pi 的 session 是决策历史，不是完整事务日志。

### 对比结论

Claude Code 把读写凭据、checkpoint、backup 和 rollback 作为文件工具生命周期的一部分；Codex 更依赖 workspace/git 与宿主可观察性；Pi 把 session 分支与文件恢复明确分开。一个成熟系统必须告诉用户：哪些副作用可撤销，哪些只能人工修复。

### 验证动作

做一次“读—外部修改—Edit”、一次“模型写错—回滚”、一次“命令修改文件—取消”。分别检查冲突检测、文件恢复和 shell 外部副作用是否符合承诺。

## Section 15｜本地与网络检索如何协作

### Claude Code：五条通道各自压缩一种未知

15 把检索拆成 Glob 找路径、Grep 定位内容、Read 读取确定范围、WebSearch 找候选来源、WebFetch 抓取指定 URL。cwd、ignore、权限、分页和输出预览共同限制本地检索；网络工具还要把失败作为独立状态返回，并通过 prompt 规定证据如何进入上下文。

这个设计的核心不是工具多，而是每条通道都缩小不同维度的不确定性：路径未知用 Glob，关键词未知用 Grep，内容范围已知用 Read，来源未知用 Search，页面已知用 Fetch。工具契约把“怎么检索”也变成模型可学习的策略。

### Codex CLI：本地 shell/搜索与环境可读性相连

Codex 更依赖 shell、文件工具、AGENTS.md 和可观察工作区构成检索面。模型可以使用命令搜索与读取项目，再通过 harness 的 cwd、sandbox 和输出限制获得环境反馈。官方 harness engineering 写法强调日志、结构化验证和环境 legibility：不是把所有文件塞给模型，而是让模型能可靠找到证据。

网络访问则受 sandbox profile、代理和审批策略影响；“能调用 curl”不等于拥有无限网络检索权限。

### Pi：工具和 skills 通过扩展增加检索能力

Pi core 只需要知道工具 schema；coding-agent 可以提供搜索、读取、shell、skills 或项目自定义检索工具。这个扩展面很灵活，适合把团队知识库、代码索引或专用 API 接进同一 loop，但工具质量、返回长度和网络边界要由宿主设计。

### 对比结论

Claude Code 把检索通道做成较完整的内置协作面；Codex 强调让工作区、日志和验证可被模型看懂；Pi 把检索当成可插拔工具生态。三者都不应把“给模型更多上下文”当成默认优化：更好的检索契约通常比更大的上下文更可靠。

### 验证动作

给一个需要跨文件、跨命令和外部文档的任务，记录模型先调用哪条检索通道、每次返回多少内容、失败后是否换路。好的 harness 应让模型逐步缩小范围，而不是一次读取整个仓库。

## 这一主题的共同答案：副作用必须有回路

工具系统的最低闭环不是“注册一个函数”，而是：

```text
tool_call
  -> schema / semantic validation
  -> scheduling decision
  -> hook / approval
  -> sandbox or host boundary
  -> execution and progress
  -> bounded result
  -> message pairing
  -> transcript / session persistence
  -> next model input
```

Claude Code 在源码里把这条链铺得最完整；Codex 将其中的执行、审批、sandbox 和事件协议分层；Pi 提供最小而可扩展的链，安全与回滚由宿主补齐。对比时最危险的误读，是把某一层的能力当成全链路能力：有工具不代表有权限，有 sandbox 不代表有回滚，有 session 不代表恢复了文件。

## 本主题覆盖清单

本篇覆盖 07、08、09、10、11、12、13、14、15，共 9 个独立 comparison sections。加上主题 01 的 8 个 sections，已经覆盖 Claude Code 50 章中的 17 章；后续主题继续保持“一章一 section、每章只出现一次”。

## 下一篇

副作用被控制后，新的问题是上下文会不会失真：系统提示怎样装配，工具输出怎样被压缩，hook 如何改变恢复路径，会话怎样从磁盘重新变成可继续的状态。下一篇进入上下文、安全、恢复与会话。
