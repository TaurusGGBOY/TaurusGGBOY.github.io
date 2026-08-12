---
title: "Agent主题对比03｜上下文、安全、恢复与会话"
published: 2026-08-12T10:06:00+08:00
updated: 2026-08-12
description: "比较 Claude Code、Codex CLI 与 Pi 的项目上下文、压缩、Hook、错误恢复和会话分支。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-03-context-security-recovery/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-03-context-security-recovery"
series: "agent-theme-comparison"
order: 3
difficulty: "advanced"
time: "50 min"
prerequisites:
  - "Agent主题对比 01｜控制平面与主循环"
  - "Agent主题对比 02｜消息、工具与副作用"
topics:
  - "context engineering"
  - "compaction"
  - "hooks"
  - "recovery"
  - "session resume"
source_modules:
  - "restored-src/src/utils/queryContext.ts"
  - "restored-src/src/context.ts"
  - "restored-src/src/utils/hooks"
  - "restored-src/src/query.ts"
  - "restored-src/src/utils/sessionStorage.ts"
  - "restored-src/src/utils/sessionRestore.ts"
  - "codex-rs/core/src"
  - "packages/coding-agent/src"
status: "verified"
verified_at: "2026-08-12"
---


> 长会话真正难的不是把 token 塞进窗口，而是在删掉、摘要、重试和恢复之后，模型仍然知道哪些约束有效、哪些副作用已经发生。

本篇覆盖 Claude Code 源码解读 16–20：项目上下文、四层压缩、Hook 生命周期、错误恢复、session/resume/branch。前两篇讨论了控制循环和工具副作用；这里讨论它们的“时间维度”：一次请求如何继承过去，失败之后如何继续，重启之后如何不越过权限边界。

![Agent 上下文、安全、恢复与会话](/images/posts/agent-theme-03-context-security-recovery/agent-theme-03-context-security-recovery-handdrawn.png)

## Section 16｜项目上下文如何组装并注入

### Claude Code：三条上下文通道，不是一个长字符串

16 把一次模型请求拆成 system prompt、项目级 user context 和运行时消息三条通道。默认 system prompt 先装稳定内容，再补动态内容；工具描述和缓存边界保持分块数组；`CLAUDE.md` 按目录层级发现，但走 user context；git 状态也是会话快照；default/custom/append 决定最终 prompt 的选择关系。

`queryLoop` 直到真正调用模型前才把三条通道合起来，深入子目录时还可能动态补充项目指令。这个设计避免把项目文件内容误当成系统级约束，也让缓存稳定部分与每轮变化部分分开。系统 prompt 的“优先级”比简单字符串拼接更重要。

### Codex CLI：instructions、cwd 和 skills 是初始输入的一部分

Codex 的 harness 会把系统 instructions、目录层级 `AGENTS.md`、当前 cwd/shell、sandbox 权限说明和可用 skills 元数据装进初始请求。官方文章指出，目录级 instructions 会按路径聚合，并受大小限制；这说明上下文装配本身就是有预算和来源的控制流程。

Codex 更强调让模型知道“自己在哪里、能做什么、如何验证”。但这些信息的优先级和缓存方式要看具体 prompt builder，不能仅凭官方总览推断所有运行模式一致。

### Pi：资源文件、settings 与 extension context 汇合

Pi 的 coding-agent 会加载项目/全局资源、settings、skills 和扩展提供的 prompt/context，再交给 agent core。trust 控制资源是否加载；扩展可以通过事件注入上下文或改变 system prompt，但和 Claude Code 一样，必须区分系统约束、用户指令和外部项目文本。

Pi 的可组合性很强，也意味着 context 组合顺序更依赖宿主约定。扩展作者不能假设自己追加的文本拥有系统级优先级。

### 对比结论

Claude Code 把上下文通道和缓存边界写得最显式；Codex 把 instructions、环境和权限摘要作为 harness 输入；Pi 把资源与扩展留给组合层。三者共同的安全原则是：上下文来源必须可识别，权限说明不能被普通项目文本覆盖，动态信息要受预算约束。

### 验证动作

在项目根目录和子目录分别启动，记录最终 system/user context 的来源、顺序和长度；再放入一条与系统约束冲突的 `AGENTS.md`/资源文件，确认它不会改变宿主安全策略。

## Section 17｜长会话如何继续运行

### Claude Code：压缩是四层防御，不是一个按钮

17 详细追踪 Budget Reduction、HISTORY_SNIP、Microcompact、CONTEXT_COLLAPSE 和 Autocompact。前置层先控制单个 API message 的工具结果总量；HISTORY_SNIP 剪掉不值得携带的旧消息并修 transcript 链；Microcompact 优先削减工具结果；collapse 把旧对话变成可重放投影视图；Autocompact 最后完整重建上下文。

自动压缩还会先走 session memory，再决定是否使用传统 `compactConversation()`；重建顺序决定压缩后还能不能继续调用工具。缓存断点、token 估算、cleanup 和历史事故都属于压缩协议的一部分。一个摘要若丢掉“已修改文件”和“下一步”，模型可能继续工作，但已经不是原来的任务。

### Codex CLI：compact item 保留模型状态而非复制全部历史

Codex 的 agent loop 在接近 `auto_compact_limit` 时调用 Responses compact endpoint；返回 compaction item 和用于保留模型状态的 `encrypted_content`，再把压缩结果用于后续请求。官方文章把 compact 描述为输入重建流程，而不是简单截断。

它的优势是让 context compaction 进入模型 API/turn 语义，客户端可以看到事件；限制是更细的摘要 prompt、文件清单和产品级记忆策略仍要看实现，不能由 endpoint 名字推断。

### Pi：CompactionEntry 与 BranchSummaryEntry 都写回 session

Pi 的 compaction 在 `contextTokens > contextWindow - reserveTokens` 时触发，默认 `reserveTokens` 和近期 token 保留量可配置。算法找 cut point，调用模型生成 Goal、Constraints、Progress、Key Decisions、Next Steps、Critical Context 等结构化摘要，然后追加 `CompactionEntry`。分支切换则追加 `BranchSummaryEntry`。

这种设计把“压缩后的历史”变成可审计的 session entry，扩展还可以通过 `session_before_compact`、`session_before_tree` 取消或自定义。它比只在内存里替换 messages 更容易恢复，但摘要质量仍取决于模型和宿主注入的细节。

### 对比结论

Claude Code 用多层预算与历史投影保护长会话；Codex 用 compact item 与无状态请求衔接模型上下文；Pi 用结构化 session entry 保存压缩与分支。三者都验证了一个原则：压缩必须同时保留语义、控制状态和可恢复线索，不能只追求 token 数下降。

### 验证动作

构造一个包含“已读文件、已修改文件、失败命令、用户约束、下一步计划”的长会话，触发压缩后检查五项是否仍可回答。若摘要只剩主题名，没有文件和约束，压缩并没有完成任务。

## Section 18｜生命周期机制如何横切整个运行时

### Claude Code：Hook 是生命周期协议

18 列出 27 个生命周期事件，并把每个 Hook 拆成事件、matcher、执行器三层。输入带公共会话坐标和事件字段；matcher 先合并来源再过滤；同一事件的 Hook 可并行，但结果由核心聚合；退出码适合简单脚本，JSON 才能表达精细控制。`async` 解决等待，`asyncRewake` 解决事后叫醒。

几个边界很典型：PreToolUse 可以改输入或建议判决，PostToolUse 适合观察结果和补上下文，PreCompact 的成功 stdout 可以变成摘要附加指令，Stop 的阻断反馈可以驱动模型继续。大多数 Hook 失败默认不拖垮主任务，但 blocking 结果必须单独处理。

### Codex CLI：事件协议和宿主回调承担横切能力

Codex 没有把所有生命周期扩展都塞成 Claude Code 同名 Hook，而是通过 app-server events、approval request、turn/item 状态、工具执行输出和 host protocol 让客户端接入。IDE 可以在 tool call 前请求审批、在运行中显示状态、在结束后收集结果。

这种协议化横切能力适合多客户端，但扩展点的粒度、可修改字段和失败语义必须以具体 protocol schema 为准。客户端能观察，不代表能安全修改控制状态。

### Pi：extensions 订阅 agent/session 事件

Pi 的扩展 runtime 提供事件订阅和 session hook，compaction、tree branch、tool call、agent start/end 等阶段可以被观察或取消/改写。扩展与 coding-agent 同进程运行，调用者需要自己决定哪些事件可被扩展阻断、哪些只读。

Pi 的优势是事件 API 简单；风险是扩展拥有的进程权限也更直接。把一个 Hook 当成普通回调，会忽略它可能改变 prompt、工具输入或压缩结果。

### 对比结论

Claude Code 的 Hook 更像运行时协议；Codex 的横切能力更像跨进程事件与审批协议；Pi 的扩展更像同进程插件事件。选型时应问的是“扩展能改变什么，失败如何传播”，而不是“有没有 hook 这个词”。

### 验证动作

为 PreToolUse、PostToolUse、PreCompact、Stop 各写一个最小处理器，分别测试修改输入、追加上下文、改变摘要、阻断收口。再让处理器异常，确认主任务是否按文档的 blocking/non-blocking 语义运行。

## Section 19｜如何重试、降级并恢复执行

### Claude Code：错误类型决定恢复动作

19 把遥测标签与控制决策分开，再按 API、流、工具、Hook、取消和模型输入错误建立恢复矩阵。API 重试每次重发前重新判断环境；退避按服务端提示或指数公式；连续 529 可能触发换模；流失败可以降级非流式但要防止重复副作用；工具失败回填给模型；Hook 失败按 blocking/non-blocking 分流；取消走独立终止路径。

最后一层不是无脑 `catch`：系统要决定继续、结束，还是把现场交给用户。错误恢复之所以不能做成全局 catch，是因为 API 重试和工具重试的副作用风险完全不同。

### Codex CLI：重试围绕 turn、approval 和执行结果

Codex 的执行器区分模型请求失败、工具进程失败、sandbox 启动失败、用户拒绝和取消。模型请求可以按照 provider/服务策略重试；已经写入文件或提交外部副作用的工具不能因为网络重连就自动重复。turn/item 状态应让客户端知道是在等待、失败还是结束。

Codex 的多宿主协议还要求错误能被结构化传递，而不是只把 stderr 拼进终端。否则 IDE 无法决定是否重试或请求用户介入。

### Pi：core 处理 loop，session 提供恢复锚点

Pi 的 agent loop 可以继续处理 provider error、tool error 和 abort 事件；coding-agent session 保存已有消息和分支，让用户能从失败现场继续。扩展可以在错误事件上做通知或清理，但不会自动保证 shell 副作用可撤销。

Pi 的简单性让恢复策略更容易替换，也让“默认会恢复到什么程度”更依赖上层。做服务化包装时，必须显式定义 retry budget、幂等键和用户确认点。

### 对比结论

Claude Code 把恢复策略写成细粒度控制流；Codex 让错误进入 turn/item/host protocol；Pi 把最小恢复锚点放在 session，再由应用决定政策。评价重试时，首先检查是否知道副作用已经发生，而不是只看有没有指数退避。

### 验证动作

注入一次 429/529、一次流中断、一次工具非零退出、一次 Hook 阻断、一次用户取消。记录是否重复执行工具、是否保留原始错误、是否能从 session 继续。

## Section 20｜如何恢复、续接与分叉对话

### Claude Code：加载消息只是恢复的一半

20 把 session 当成可重建事件日志：session ID 与 transcript 路径一起切换；写入前去重并补齐父链；JSONL 追加账本保存 `uuid`/`parentUuid`；读取先找叶子再沿 parentUuid 回到根。resume 不仅加载消息，还要重建模型、工具、权限、cwd 和运行状态；`/branch` 复制 transcript 并保存来源关系。

最重要的边界是：恢复状态不能回滚已经发生的副作用。一个会话可以重新看见“已执行 rm”这条记录，但不能因此恢复被删除的文件；权限也要按当前运行重新判断。

### Codex CLI：thread 恢复与客户端状态分开

Codex 的 thread/turn/item 使会话可继续，app-server 可以让不同客户端读取同一 thread 并继续发起 turn。由于请求保持无状态，恢复依赖 thread/event history 与当前 host/runtime 重新装配。旧 turn 的 approval、sandbox profile 或 cwd 不能假设仍然适用于新进程。

这也是协议化架构的优点：客户端可以换，thread 仍是稳定锚点；代价是 schema、事件顺序和权限重建必须非常明确。

### Pi：树状 session 让 branch 成为一等操作

Pi session 用父子关系组织消息树，`/tree` 可以切换分支；compaction 和 branch summary 记录被舍弃路径中的目标、决策、文件和下一步。这个模型比线性“复制一份聊天记录”更省空间，也更接近真实探索过程。

但 Pi 的 branch 主要是对话控制流；如果工作区没有 git/worktree 或 snapshot，切换 branch 不会让文件系统返回旧状态。

### 对比结论

Claude Code 最强调恢复时重新装配权限和运行状态；Codex 最强调 thread 作为多宿主协议锚点；Pi 最强调 session tree 与 branch summarization。恢复的完成标准应是“消息、控制状态、权限和副作用状态都被明确说明”，只恢复消息还不够。

### 验证动作

启动会话、修改文件、切换模型、触发权限、退出进程，再 resume/branch。检查四件事：消息是否完整、模型/工具是否重建、权限是否重新判断、文件是否被错误地假定为可回滚。

## 这一主题的共同答案：上下文是控制状态的压缩表示

上下文不是“模型记忆”，而是当前控制平面的一个有损投影。它需要保留至少五类信息：用户目标与约束、已验证事实、已发生副作用、当前权限与环境、下一步可执行计划。压缩、Hook、重试和恢复任何一个环节丢掉其中一类，模型就会在逻辑上重新做已经发生的事情。

三套系统的取舍可以这样概括：Claude Code 追求控制链条完整，Codex 追求协议可观察和跨宿主恢复，Pi 追求 session/扩展可组合。没有一种方案能仅靠摘要 prompt 解决所有问题；可靠性来自上下文、执行状态和持久化日志互相校验。

## 本主题覆盖清单

本篇覆盖 16、17、18、19、20，共 5 个独立 comparison sections。主题 01–03 现在累计覆盖 22 个 Claude Code 章节。

## 下一篇

核心循环、工具副作用和恢复边界已经清楚，接下来进入“能力怎样接进来”：commands、skills、task、subagent、team、MCP、plugin、LSP 以及 IDE/browser 等扩展与委派机制。
