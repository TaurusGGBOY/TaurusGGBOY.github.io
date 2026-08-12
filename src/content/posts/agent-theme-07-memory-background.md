---
title: "Agent主题对比07｜记忆与后台智能"
published: 2026-08-12T10:00:00+08:00
updated: 2026-08-12
description: "比较三个 Agent 的 session memory、团队记忆、压缩摘要与后台 Agent 边界。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-07-memory-background/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-07-memory-background"
series: "agent-theme-comparison"
order: 7
difficulty: "advanced"
time: "40 min"
prerequisites:
  - "Agent主题对比 03｜上下文、安全、恢复与会话"
  - "Agent主题对比 06｜配置、Provider、远程与运维"
topics:
  - "session memory"
  - "team memory"
  - "background agents"
  - "AutoDream"
  - "Kairos"
source_modules:
  - "restored-src/src/services/SessionMemory"
  - "restored-src/src/memdir"
  - "restored-src/src/services/autoDream"
  - "restored-src/src/assistant"
  - "codex-rs/core/src"
  - "packages/coding-agent/src"
status: "verified"
verified_at: "2026-08-12"
---


> 记忆不是把旧聊天全部塞回 prompt，后台 Agent 也不是偷偷多跑一个模型。两者都必须有作用域、触发门槛、持久化格式、失败边界和用户可见的回路。

本篇覆盖 Claude Code 源码解读 40–43：session memory、Memdir/team memory、AutoDream、Kairos/assistant mode。它们关注的是主 Agent 结束之后发生什么，以及哪些经验可以安全地带到下一次会话。

![Agent 记忆与后台智能](/images/posts/agent-theme-07-memory-background/agent-theme-07-memory-background-handdrawn.png)

## Section 40｜如何从会话中提炼知识

### Claude Code：Session Memory 是受限的项目记忆管道

40 的 Session Memory 以项目和会话划定作用域；启动时只注册 hook，不立刻生成记忆；是否提炼受 token 等硬条件控制；文件第一次出现时先建立结构，再让 agent 编辑；更新由受限 fork 独立执行；完成后用两个游标记录写到哪里；压缩时记忆文件再回到上下文。

这条链把“记忆”放在会话日志之外：它是从已发生对话提炼出的辅助上下文，不是对 transcript 的替代。恢复会话时文件仍在，但边界可能已经变了，因此记忆读取不能绕过当前 project trust、权限和上下文预算。失败时记忆应退化为缺失，不应阻塞主任务。

### Codex CLI：AGENTS/skills 是持久说明，自动记忆要另行核验

Codex 的固定源码和官方材料明确支持项目级 `AGENTS.md`、skills 元数据与 thread history，它们可以把团队约定带入后续 turn。但“自动从会话提炼并写回 memory”的完整产品链不能只从 agent loop 推断；应以具体实现和配置为准。

这个区别很重要：静态项目 instructions 是用户维护的事实来源，自动 memory 是模型加工后的二手资料，二者的可信度和更新策略不同。

### Pi：session history 与 compaction summary 是可追踪记忆

Pi 的 session JSONL/tree、CompactionEntry 和 BranchSummaryEntry 会保留目标、决策、文件和下一步，是一种显式的工作记忆。coding-agent 也可以通过项目资源、skills 或扩展维护长期说明。Pi core 没有强制一个后台“自动提炼记忆”服务。

因此 Pi 的默认记忆更透明：用户知道哪些 entry 被写入，想要自动归纳可以增加扩展；但扩展生成的知识必须标明来源，不能把摘要当作未经验证的事实。

### 对比结论

Claude Code 把 session memory 变成受限后台管道；Codex 主要依赖显式 instructions/thread，需要区分已确认和未确认能力；Pi 把 session/summary 做成可审计基础，自动化留给扩展。记忆系统的第一指标是“能否删掉/纠正”，而不是“记住得越多越好”。

### 验证动作

完成一个包含失败和修复的任务，检查下一次会话带入的是经过验证的结论、来源文件和时间范围，而不是把中间猜测原样写进长期记忆。再删除 memory 文件，确认主 Agent 仍能正常启动。

## Section 41｜Memdir 与团队记忆如何检索和同步

### Claude Code：目录、索引与主题文件构成存储协议

41 把 memdir 拆成目录、索引和主题文件。项目作用域由路径决定；两个开关分别控制总能力和共享能力；prompt 要求模型区分 private/team；prompt 里还包含创建、更新、索引和引用的小型存储协议。注入通过索引与相关记忆两条路径限流，年龄只触发复核提示；Team Memory 启动先 pull，再 watch。

Pull 与 Push 使用不同冲突语义；密钥扫描和路径校验守住共享边界；失败时可以继续主流程但应报告记忆同步缺失。这比“把一个团队 Markdown 放到 system prompt”更像一个小型数据库：有作用域、索引、冲突和安全规则。

### Codex CLI：共享知识通常由仓库/指令和 host 维护

Codex 的 `AGENTS.md`、skills、仓库文档和 worktree 让团队约定随着项目版本控制；多客户端/thread 可以共享 app-server 状态，但固定源码不足以证明一个等价的 memdir/team sync 产品。若要实现，应把 pull/push、冲突、secret 扫描和权限作为独立层。

### Pi：项目资源与扩展可以实现团队记忆

Pi 可以读取项目资源和扩展维护的文件，session branch 让团队共享任务轨迹；但 core 不内置一个强制的 pull/watch/team memory 协议。共享记忆的同步、密钥扫描、路径白名单和冲突解决由宿主设计。

### 对比结论

Claude Code 在源码中把 private/team memory 的作用域与同步边界写得最具体；Codex 更依赖 Git/AGENTS/host 这一类显式来源；Pi 提供可实现的扩展点但不预设治理。团队记忆不是普通上下文，必须有写入资格和冲突规则。

### 验证动作

让两个会话同时修改同一主题记忆，另一个会话 pull；检查是否能检测冲突、拒绝密钥、限制路径并保留来源。再关闭共享能力，确认 private memory 不会被推送。

## Section 42｜AutoDream 如何在后台自动整合记忆

### Claude Code：Dream 有五道门和四阶段提示词

42 先区分本地 Team Memory 与远端同步，再检查 `TEAMMEM` 构建能力、账号灰度开关和第一方 OAuth。真正触发 Dream 时，还要通过运行模式/开关、距离上次成功时间、十分钟扫描节流、最近会话变化量和跨进程锁五道门。

Dream 用四阶段 prompt 维护记忆，后台 Agent 复用内核但更换权限和持久化边界；DreamTask 把不可见 fork 变成可取消状态；成功、失败和终止都要正确处理锁；结果再进入未来会话。它不是“每次退出都总结”，而是一个带节流、锁和失败回收的维护任务。

### Codex CLI：后台维护需要由 host 明确调度

Codex 的 turn/exec/session 结构可以支持后台总结或维护任务，但固定源码与官方材料主要证明 agent loop、compact 和 host protocol，不自动证明一个 AutoDream 等价物。若宿主实现，必须重新定义 sandbox、模型调用预算、锁、可取消性和结果写入权限。

### Pi：后台 compaction/branch 机制可扩展，但默认不隐式运行

Pi 的 compaction 和 branch summary 是明确触发的 session 操作，扩展可以在 session event 后启动整理任务。由于扩展同进程运行且没有内置 sandbox，后台写入 memory、调用网络或运行 shell 的风险必须由宿主控制。

### 对比结论

Claude Code 把后台记忆维护做成受门槛和锁保护的 task；Codex 提供可编排的 runtime primitives；Pi 提供扩展点而不隐式替用户启动后台 Agent。后台智能的可信度来自“什么时候不运行”以及“运行后能写到哪里”。

### 验证动作

连续结束两次会话、跨过节流窗口、模拟并发进程和中途取消，检查 Dream/后台任务是否只运行一次、是否释放锁、是否留下可解释状态，主 Agent 是否完全可用。

## Section 43｜辅助模式如何区别于主 Agent

### Claude Code：Kairos 把主动规划接回主 Agent，而不是伪装成新产品

43 把辅助模式拆成开关、显式设置与目录信任；主动规划的本质是给同一个 Query Loop 更多再次运行机会；记忆先读取蒸馏结果，新事实写 daily log；提醒由 Cron 保存未来 prompt；后台 Agent 完成后，主 Agent 还要再次判断；SendUserMessage 提供用户出口；执行端与 Viewer 分开。

权限、优先级和失败边界仍与主 Agent 分开说明。Sleep 的 prompt 是把等待交给调度器，不是让模型无限循环。辅助模式的价值是提高长期任务的连续性，风险则是后台动作可能在用户离开后改变环境，所以必须有明确通知、权限和停止点。

### Codex CLI：后台/远程控制要保持 host 可见

Codex 的 app-server 让 turn、exec、approval 和结果对客户端可观察；若宿主安排后台 turn，必须保留 thread ownership、sandbox/approval profile、取消和事件回流。模型自行决定再次唤醒，不能替代 host 的调度政策。

### Pi：扩展可以实现 assistant mode，但责任更外置

Pi 的事件、session、cron/RPC 和 extension API 足以组合长期助手；扩展可以在未来 prompt 到达时启动 agent loop，并把结果写入 session 或通知用户。默认 core 不会为后台模式提供完整的权限、隔离和远程控制，部署者需明确补上。

### 对比结论

Claude Code 把 Kairos 的主动性仍挂在主 Query Loop、memory、task 和用户消息边界上；Codex 用 thread/host protocol 保持后台 turn 可见；Pi 让扩展自由组合。辅助 Agent 的判定标准不是“能不能自动运行”，而是用户能否知道它为何运行、改了什么、怎样停止。

### 验证动作

创建一个只读提醒和一个会修改文件的后台任务，分别测试定时触发、用户通知、取消、权限和断线。确保后台任务不能借用主会话的临时授权，也不会把结果静默写回生产目录。

## 这一主题的共同答案：记忆和后台任务必须彼此制约

记忆决定未来会话看见什么，后台任务决定现在会发生什么；如果两者没有边界，错误会被自动写入并自动执行。一个可信实现至少要有：

- 作用域：项目、会话、用户、团队和远端空间分别是什么。
- 触发：token、时间、变化量、显式命令或调度器何时满足。
- 写入：能写哪些文件，是否扫描 secret，是否需要用户确认。
- 恢复：失败、取消、锁冲突和重启后如何继续或放弃。
- 可见性：用户怎样看到来源、变更、权限和后台状态。

Claude Code 源码在这组能力上最接近完整后台系统；Codex 的核心更像可编排的线程/执行基础设施；Pi 的核心最适合搭建实验性后台 Agent，但默认不替应用承担隔离和治理。

## 本主题覆盖清单

本篇覆盖 40、41、42、43，共 4 个独立 comparison sections。主题 01–07 累计覆盖 45 个 Claude Code 章节。

## 下一篇

最后一篇处理 44–48：Buddy、voice、MagicDocs、通知/mailbox、输出风格和系列收束。它会把剩下 5 个章节放进体验层，并给出 8 个主题、50 个 section 的完整目录。
