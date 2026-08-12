---
title: "Agent源码对比02｜三套 Agent 怎样保存、压缩和分叉上下文"
published: 2026-08-12T10:10:00+08:00
updated: 2026-08-12
description: "比较 Claude Code、Codex 与 Pi 的历史存储、prompt 投影、上下文压缩、恢复和分支语义。"
tags: ["agent-source-comparison", "ai-agent", "context-engineering", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-comparison-02-context-and-session/agent-comparison-cover-handdrawn.png"
imagePosition: "left"
---

# Agent源码对比02｜三套 Agent 怎样保存、压缩和分叉上下文

上一篇最后问的是：**一次 turn 结束之后，三套系统怎样保证下一次请求还记得必要的内容？**

从官方产品说明看，context window 是模型一次能看到的全部内容，compaction 会把旧消息总结成更短的描述；从源码看，真正困难的是另一件事：**保存下来的历史、当前 prompt 和用户想要恢复的分支，往往不是同一份数据。**

Claude Code 的 `queryLoop()` 在每次采样前重新投影消息，并把 compact 结果回填到当前循环；Codex 把 Thread、Turn、Item 作为会话协议的基本单位，再让 `run_turn()` 在中途做 context rollover；Pi 把 JSONL 文件做成一棵带 `id/parentId` 的树，当前分支只是这棵树的一条路径。

这也是为什么“上下文管理”不能只理解成把旧消息截短。它至少包含三种状态：历史事实、模型视图和用户选择的工作分支。

## 回答上一篇的问题

上一篇说，三个主循环分别由生成器、事件流和 session submission 驱动。这个结论还缺一块：循环下一次迭代拿到的 `messages` 从哪里来？

外部资料给了两个有用的提醒。Anthropic 的 session 管理文章把继续、rewind、clear、compact 和 subagent 都看成 turn 之后的不同分叉点；关于 context compaction 的研究则把摘要看成有损的状态变换，而不是无损压缩。将这两个观点放回固定源码窗口，可以得到一个更稳妥的结论：**压缩是 prompt 视图的重建，分叉是历史游标的改变，恢复是重新选择一条可见路径。三件事不能混写。**

## 介绍本章的一些概念

- **Transcript / history**：按时间记录发生过什么，可能保留完整工具输入、输出和系统事件。
- **Prompt projection**：为了下一次模型请求，从历史中挑出、压缩、注入后得到的消息集合。
- **Compaction**：将一段旧上下文替换成摘要和保留尾部；它可能减少 token，但不保证每个细节都存在于新 prompt。
- **Branch**：从旧历史节点重新开始，旧节点仍然存在，但当前工作路径发生改变。
- **Resume**：重新打开已有会话并恢复一条历史路径；它不必等于重新把所有原始消息发送给模型。
- **Memory**：跨 turn 或跨 session 的额外知识层。它可能是 prompt 注入，也可能是文件、索引或后台整理结果。

本文里的“保留”有两种含义：**仍在磁盘或数据库里**，以及**下一次模型能直接看到**。前者不等于后者。

## 一张上下文生命周期图

![三套 Agent 的历史、压缩和 prompt 视图](/images/posts/agent-comparison-02-context-and-session/agent-comparison-02-context-and-session-handdrawn.png)

图中的 `History` 是事实仓库，`Compact Summary` 是为了继续工作而生成的投影，`Prompt View` 是一次请求真正拿给模型的内容。`Fork` 和 `Resume` 改变的是当前树的路径，不应该被描述成“删除历史”。

## Claude Code：完整历史与当前视图分开变化

在 `restored-src/src/query.ts` 的 `queryLoop()` 中，每次迭代都会先从 state 取出消息，然后通过 `getMessagesAfterCompactBoundary(messages)` 得到本轮可用视图。之后，tool result budget、HISTORY_SNIP、microcompact、Context Collapse 和 `deps.autocompact()` 按顺序参与处理。

当 `compactionResult` 存在时，代码记录压缩前后的 token 统计，重置 compact tracking，调用 `buildPostCompactMessages(compactionResult)`，把摘要、保留的尾部和附件逐条 `yield` 出去，并把新的消息视图赋回 `messagesForQuery`。因此“压缩发生过”既是上下文事实，也是宿主可以观察到的事件。

这里有个容易被忽略的细节：源码注释明确区分了消息数组、collapse store 和每次请求的投影。Context Collapse 可以把旧消息在读时折叠成视图，而不是立即把原始历史改成一条摘要。换句话说，Claude 的上下文层并不只有一把“删除旧消息”的剪刀。

会话恢复还要看 `restored-src/src/utils/sessionStorage.ts`。它负责把 session 记录刷新到持久化边界；`queryLoop()` 中的状态变化不是自动等于磁盘文件变化。阅读时要沿着“记录消息 → flush → resume 读取 → 重新构造消息”追，不能仅凭内存变量推断会话已经保存。

Session Memory 和 memdir 又是另一层。它们可以把会话中提炼出的信息放进后续 prompt，但这不是原始 transcript 的替身。因而 Claude 的上下文可以画成三层：当前 query 视图、会话历史、跨会话记忆。

> **source**：`queryLoop()` 会在 compact 后构造 `postCompactMessages` 并继续当前循环。
>
> **inference**：这说明“继续工作”依赖的是新的 prompt 投影，不等于把旧 transcript 从存储中抹掉。
>
> **runtime**：哪些 feature flag 打开、摘要如何生成、外部服务是否返回记忆，需要运行配置和实际服务才能确认。

## Codex：Thread 容器、Turn 工作单元、Item 历史项

Codex App Server 的文档把三种会话原语说得很清楚：Thread 是长期会话容器，Turn 是一次用户输入触发的 Agent 工作，Item 是用户消息、Agent 消息、工具执行、审批或 diff 等原子输入/输出。

源码侧，`codex-rs/app-server-protocol/src/protocol/thread_history.rs` 提供 Thread history 的 item/turn 组织；`codex-rs/core/src/session/turn.rs` 的 `run_turn()` 则在一次 turn 内维护 `world_state`、step context、pending input 和 token status。模型采样结束后，如果 `model_needs_follow_up` 或 `has_pending_input` 为真，循环会继续；如果触发 context limit，则执行 `run_auto_compact()`，压缩完成后再回到采样循环。

这产生一个很有用的分层：

- Thread 解决“我和这个 Agent 的长期会话是谁”；
- Turn 解决“这一次工作怎样推进”；
- Item 解决“中间发生了哪些可渲染、可持久化的输入输出”；
- prompt history 解决“下一次模型请求要看到什么”。

它们看起来像消息列表，但职责并不重合。宿主可以只渲染 Item 的增量，也可以通过 Thread resume/fork 选择历史；内核则要把 turn 内的上下文更新和 compact 结果接上下一次采样。

## Pi：JSONL 树上的 leaf pointer

Pi 的 coding-agent 文档把 session 直接描述为 JSONL tree：每个 entry 有 `id` 和 `parentId`，所有历史可以在同一个文件中形成多个分支。`SessionManager.branch(branchFromId)` 的实现也很直白：验证节点存在，然后把 `leafId` 移到指定 entry；下一次 append 会从这个节点产生新的 child，旧 entry 不被删除。

这是一种很容易读懂、也很适合终端交互的模型。`/tree` 可以在原地切换路径，`/fork` 可以从旧节点创建新文件，`/clone` 复制当前活动分支。重要的是“移动 leaf”和“复制文件”是两个不同动作，不能都叫 fork。

Pi 的 `AgentSession.compact(customInstructions?: string)` 则展示了 prompt 视图如何更新。它先 abort 当前操作，发出 `compaction_start`，从 SessionManager 获取当前 branch，调用 `prepareCompaction()`；如果扩展没有提供自定义摘要，就用 summarization model 生成结果，随后 `appendCompaction()`，重建 `sessionContext.messages`，再把消息交给 Agent。

这个签名里的 `customInstructions` 是 `undefined` 时使用默认压缩提示；它是额外指令，不是新的历史分支。压缩失败会发出带错误信息的 `compaction_end` 并抛出异常，不能被文章写成“总会自动恢复”。

## 三种会话模型的对照

| 问题 | Claude Code | Codex | Pi |
|:--|:--|:--|:--|
| 历史中心 | transcript/session storage，加 collapse 与 compact 投影 | Thread/Turn/Item 与 thread-store/rollout | JSONL tree，`id/parentId` 和 `leafId` |
| 当前 prompt | 每轮从消息和压缩边界重新投影 | step context、world state、history、skills/plugins 注入 | SessionManager 当前 branch 的 messages |
| 压缩入口 | auto/manual compact，另有 microcompact/snipping 等层 | turn 内 pre/mid-turn compact | `AgentSession.compact(customInstructions?)` 与自动 compact |
| 分叉语义 | resume/fork 与主循环/会话存储共同决定 | Thread fork/resume 是协议级操作 | branch 移 leaf；fork/clone 可创建新文件 |
| 记忆层 | Session Memory、memdir、AutoDream 等额外层 | thread metadata、memory/skills 等由具体能力接入 | context files、skills、extensions 和 session tree |

这张表不表示三套格式能互相导入。它只说明一个共同设计规律：**把长期事实、当前 prompt 和用户当前路径分开，才能同时支持长任务、恢复和分支。**

## 一个手算实验

假设有五条记录：用户目标、一次搜索、一个很大的文件结果、一次工具修改、用户纠正。请分别回答：

1. 压缩后，哪一条必须留在摘要里才能继续？
2. 如果历史文件仍保留完整记录，模型下一次是否一定能看到大文件结果？
3. 从第二条搜索之后分叉，原来的修改和纠正是否应当进入新分支？
4. 恢复会话时，应该恢复完整历史，还是只恢复当前 branch 的投影？

这个练习的价值在于，它迫使你把“存储正确性”和“模型记忆”分开。没有这个区分，任何 compact bug 都会被误诊成“Agent 失忆”。

## 本篇新增机制

相对上一篇的主循环，本篇加入了**上下文的三层模型**：历史记录负责可追溯，prompt projection 负责当前采样，branch/memory 负责跨路径或跨会话的连续性。下一篇的工具权限问题，必须建立在这三层之上：模型看到了什么，不代表进程允许做什么。

## 留给下一篇的问题

如果模型在压缩后提出一个写文件或执行 shell 的工具调用，谁决定它能不能做？这个决定是在工具契约、用户审批、策略文件还是 OS sandbox 中完成的？

## 参考资料

- [Claude：Using Claude Code: session management and 1M context](https://claude.com/blog/using-claude-code-session-management-and-1m-context)
- [Claude Code Docs：How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [OpenAI：Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)
- [Context Compaction Theory](https://arxiv.org/abs/2608.01326)
