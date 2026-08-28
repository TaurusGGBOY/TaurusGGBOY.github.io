---
title: "Agent主题对比04｜长任务怎样保持上下文并恢复"
published: 2026-08-12T10:04:00+08:00
updated: 2026-08-28
description: "比较 Claude Code、Codex、Pi 与 DeepSeek Harness 如何压缩上下文、保存会话、分叉路径并让长任务安全恢复。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi", "deepseek-harness", "context-engineering", "session-recovery"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-04-extension-delegation/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-04-extension-delegation"
series: "agent-theme-comparison"
order: 4
difficulty: "advanced"
time: "18 min"
prerequisites:
  - "Agent主题对比 01｜为什么不能只比模型"
  - "Agent主题对比 02｜一次 Agent 任务怎样跑完"
topics:
  - "context engineering"
  - "session persistence"
  - "compaction"
  - "resume and fork"
  - "handoff artifacts"
  - "memory trust"
  - "DeepSeek Harness"
status: "verified"
verified_at: "2026-08-28"
---

答案很明确：长任务不能只靠更大的上下文窗口。真正能让工作跨越数小时、进程中断和多次会话的，是高信号上下文、持续保存的会话记录、可检查的交接物，以及能恢复也能分叉的执行路径。记忆可以帮忙，但必须允许人查看、修正和删除。

想象一次数据库迁移：Agent 已改完三处调用，测试还剩两组，窗口却接近上限；你合上电脑，第二天再继续。如果它只“记得聊过什么”，却不知道哪些文件已验证、哪个假设被推翻、下一步应运行什么命令，恢复出来的只是一次看似连续的新任务。

## 大窗口装不下任务的真实状态

上下文窗口保存的是当前一次模型调用能看到的材料，不等于项目状态。长任务至少有四类信息：需求与禁区、已经采取的动作、外部环境的当前结果、下一次接手所需的进度说明。它们的寿命不同，也不该全塞进聊天记录。

Anthropic 对 context engineering 的定义强调寻找“尽可能小的一组高信号 token”，而不是把能找到的材料全部装进去；其长任务实践则要求当前会话为下一次会话留下清晰产物，例如进度文件、提交记录和可运行的测试状态。[Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)；[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

这给出一个实用分工：窗口负责眼前决策，会话记录负责追溯，仓库或任务系统里的交接物负责接班，测试和运行结果负责证明现实。压缩只能缩短第一类信息，无法代替后三类。

| 载体 | 适合保存 | 失效方式 |
| --- | --- | --- |
| 当前上下文 | 眼前目标、相关文件、最近反馈 | 达到窗口上限或被无关输出淹没 |
| 会话记录 | 消息、工具动作、事件顺序 | 记录仍在，但重要状态难以定位 |
| 显式交接物 | 已完成项、未决风险、复现命令 | 没有及时更新，内容与现实脱节 |
| 外部验证 | 测试、构建、运行态与提交 | 环境变化后旧结果不再成立 |

## 四种会话设计保留了什么

四个项目都能延长工作，但它们保存状态的方式不同。差异不在“有没有历史记录”，而在记录的结构、恢复入口和分叉语义。

### Claude Code：连续 transcript，加可重载的说明

Claude Code 把 CLI 会话持续写入本地 transcript，支持继续、按名称恢复和从既有历史分叉；恢复沿用原会话，分叉则复制历史并产生新会话 ID。[Claude Code 会话文档](https://code.claude.com/docs/en/sessions) 还把 `/compact` 定义为用摘要替换较早历史，而 `/clear` 会开启空上下文并保留旧会话可供恢复。

这里有一个容易忽略的差别：会话历史说明“发生过什么”，`CLAUDE.md` 和 auto memory 保存的是跨会话仍可能有用的项目知识。官方文档说明项目根目录的 `CLAUDE.md` 会在压缩后重新注入，auto memory 是可读写的 Markdown，用户可以检查、修改或删除。[Claude Code memory](https://code.claude.com/docs/en/memory) 这让记忆可纠正，却不保证其中每条判断都正确。

### Codex：持久 thread 与可重放事件

Codex App Server 把持续会话建模为 thread，一次用户请求是 turn，消息、工具执行、审批和 diff 等中间产物是 item。thread 可以创建、恢复、分叉和归档，事件历史会持久化，让客户端重连后重建一致时间线。[OpenAI 对 App Server 的说明](https://openai.com/index/unlocking-the-codex-harness/)

这个结构适合把“恢复”拆成两个问题：服务端是否仍持有 thread，以及新客户端是否能接收历史与后续事件。它并不自动证明跨机器、跨产品的每种切换都无缝；能否继续还受运行环境、仓库版本、凭据和客户端能力约束。

### Pi：JSONL 会话树把岔路留在原地

Pi 将每个会话保存为带树结构的 JSONL 文件。条目带有父子关系，当前叶子代表正在使用的路径；用户可以在同一文件里回到早先节点继续，也可以 fork 或 clone 到新文件。[Pi Sessions](https://pi.dev/docs/latest/sessions) 还允许在离开一条分支时生成摘要，把被放弃路径中仍有用的信息带到新位置。

树结构的价值很具体：当方案 A 失败、方案 B 可行时，你不必覆盖原对话才能继续。但分支仍共享同一工作目录中的现实状态。若代码已被方案 A 改过，跳回旧消息并不会自动把文件系统也恢复到那个时刻。

### DeepSeek Harness：append-only 事件日志

DeepSeek Harness 的 Core 文档把 session 定义为 append-only 的 `SessionEvent` 日志；默认 loop 会把模型可见的事实继续追加到日志，而不是改写既有事件。[Core subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md) 架构文档同时声明 session log、model adapter、tool registry 和 agent loop 都是可替换插件。[Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

这只是公开架构主张：事件日志有利于追踪顺序和重放，不等于长任务成功率、恢复正确性或性能已经得到独立验证。项目 README 将当前版本标为 developer preview，明确会有破坏兼容性的变化；`SAFETY.md` 说明它尚未经过安全审计，不能视为安全或生产就绪。[README](https://github.com/deepseek-ai/deepseek-harness)；[SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)

## 恢复、回退和分叉不是同一个动作

凌晨断网后继续原任务，和发现两小时前方向错了，不是同一种恢复。前者要接上原状态，后者要保留证据后另走一条路。再往前一步，如果磁盘、进程或远端环境已经改变，仅恢复对话也不够。

恢复原会话时，应核对工作目录、分支、未提交差异、进程和凭据是否仍与记录一致。分叉时，要明确新路径继承了哪些历史、是否继承权限，以及两条路径会不会同时修改同一份文件。回退则必须有代码快照、版本控制或外部检查点参与，不能从“聊天回到了旧消息”推断“项目也回到了旧状态”。

这套能力最好用故障演练验收。让 Agent 在测试执行到一半时退出进程，隔天从新窗口恢复；要求它先报告当前分支、未提交差异、最近验证和下一步，再允许继续。随后从同一检查点分叉两条方案，确认会话标识与工作目录不会混用。只有聊天连续、代码状态却对不上，恢复功能仍不合格。

Claude Code 的 resume 与 fork、Codex 的 thread resume 与 fork、Pi 的 tree 与 fork，都在公开界面上表达了这层区别。[Claude Code Sessions](https://code.claude.com/docs/en/sessions)；[Codex App Server](https://openai.com/index/unlocking-the-codex-harness/)；[Pi Sessions](https://pi.dev/docs/latest/sessions) DeepSeek Harness 的 append-only log 则为保留事件顺序提供了结构，但实际回退策略仍取决于装入 profile 的会话、工具和环境插件。[DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

## 交接物要比总结更接近现实

好的交接不是一段“我做了很多工作”的摘要。接手者需要马上知道：目标是否变化，哪些约束不可破坏，当前仓库处于什么状态，最近一次验证是什么，下一步动作是什么，哪些结论仍只是猜测。

一个实用的长任务交接物可以很短：任务目标与非目标、已完成变更、失败尝试及原因、未解决问题、精确验证命令、最近结果的时间与环境。它最好放在可版本化、可由人审核的位置，并随着关键状态变化更新。Anthropic 的长任务实践把“给下一会话留下清晰产物”视为连续工作的核心条件，而不是依赖模型从旧对话中自己猜进度。[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

交接物也不该冒充证据。“测试待跑”不能被压缩成“实现完成”，“怀疑缓存导致失败”不能变成“根因是缓存”。摘要会丢细节，所以其中的状态词必须能回到测试输出、diff、issue 或事件记录。

## 记忆必须能被质疑

跨会话记忆最适合保存稳定且复用频繁的信息，例如构建命令、目录约定、已确认的接口限制。它不适合单独保存一次任务的完成状态、临时环境值或未经验证的根因。这些信息变化太快，错误记忆反而会让下一次会话更自信地走错。

判断一种记忆机制是否可靠，可以问四件事：谁写入，何时加载，作用域多大，人能否审计和纠正。Claude Code 的 auto memory 采用可编辑 Markdown，并记录项目级加载边界；Pi 的 session 文件和分支结构可直接追踪会话路径；Codex 的持久 thread 服务于客户端重连；DeepSeek Harness 的事件日志强调追加和可追踪。[Claude Code Memory](https://code.claude.com/docs/en/memory)；[Pi Sessions](https://pi.dev/docs/latest/sessions)；[Codex App Server](https://openai.com/index/unlocking-the-codex-harness/)；[DeepSeek Core](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)

这些设计各自解决一部分问题，没有一个能替代现实检查。恢复后的第一步不应是继续写代码，而应重读目标、检查工作树、重跑最小验证，再决定日志里的“下一步”是否仍然成立。

## 选择标准：看一次中断后能否可信地继续

如果任务通常在一个终端、一两个小时内完成，清晰的会话保存和手动进度说明已经够用。若任务经常跨天、并行或跨客户端，应该额外验证事件是否持久化、恢复是否重建审批状态、分叉是否隔离工作目录、交接物是否可由人审核。

Claude Code 提供面向产品使用的会话、压缩和可编辑记忆；Codex 把 thread 与事件持久化放进可被客户端驱动的 Harness；Pi 让会话树保持显式；DeepSeek Harness 把 session 也纳入可重组插件树。[Claude Code Sessions](https://code.claude.com/docs/en/sessions)；[Codex App Server](https://openai.com/index/unlocking-the-codex-harness/)；[Pi Sessions](https://pi.dev/docs/latest/sessions)；[DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 这里没有脱离任务环境的胜负。真正的验收题只有一个：在你刻意中断一次任务之后，新会话能否用可检查的证据说明它在哪里、做过什么、接下来为何这样做。

下一篇继续追问：当任务从 CLI 移到 IDE 或云端时，究竟是谁在持有这份状态。

## 资料来源

- [Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic：Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Claude Code：Manage sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code：How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [OpenAI：Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi：Sessions](https://pi.dev/docs/latest/sessions)
- [DeepSeek Harness：Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness：Core subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)
- [DeepSeek Harness：README](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness：SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
