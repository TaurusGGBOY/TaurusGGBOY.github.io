---
title: "Agent主题对比04｜会话中断后，四者各自能恢复什么"
published: 2026-08-12T10:04:00+08:00
updated: 2026-08-28
description: "Claude Code 恢复产品会话，Codex 恢复可驱动 thread，Pi 保留树形路径，DeepSeek Harness 记录追加事件；恢复对象并不相同。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi", "deepseek-harness", "session-recovery"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-04-extension-delegation/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-04-extension-delegation"
series: "agent-theme-comparison"
order: 4
difficulty: "advanced"
time: "15 min"
prerequisites:
  - "了解 Claude Code、Codex、Pi 或 DeepSeek Harness 的基本会话"
  - "正在处理会跨会话或需要分叉的长任务"
topics:
  - "会话恢复"
  - "Claude Code"
  - "Codex"
  - "Pi"
  - "DeepSeek Harness"
  - "分叉与事件日志"
status: "verified"
verified_at: "2026-08-28"
---

四者都能留下历史，但“恢复”不是同一件事。Claude Code 最擅长让人回到产品会话；Codex 让客户端重建持久 thread；Pi 把走过与放弃的路径保存在一棵 JSONL 树里；DeepSeek Harness 把发生过的事实追加成事件流。谁更好，取决于你要找回对话、控制状态、分支选择，还是可替换的运行记录。

## Claude Code 对 Pi：恢复一条工作线，还是保留多条思考路径

Claude Code 的 [Sessions 文档](https://code.claude.com/docs/en/sessions) 支持继续、按名称恢复和从历史分叉；`/compact` 用摘要替换较早内容，`/clear` 则让当前上下文重新开始。相比 Pi，Claude Code 的优势是面向日常产品使用：用户不需要理解底层文件结构，就能回到一段任务或从已有会话开新支线。

短板是恢复后的“连续感”容易超过实际保证。Claude Code transcript 能说明聊过什么，CLAUDE.md 和可编辑 memory 能重新注入项目知识，但它们不会自动证明工作区仍在同一提交、后台服务仍运行、凭据仍有效。产品把会话恢复做得顺滑，却也更需要用户主动核对代码现实，避免把连贯对话误当成完整运行状态。

Pi 的 [Sessions 文档](https://pi.dev/docs/latest/sessions) 把每个会话保存为树形 JSONL，条目存在父子关系，当前叶子代表正在使用的路径。相较 Claude Code，Pi 的优势是分支不是一个隐藏操作：用户可以回到早先节点继续，把被放弃路径中的信息摘要到新分支，也可以 clone 到新文件。对需要比较两种实现方案的人，路径所有权更清楚。

Pi 的短板来自同一份显式性。树能保存消息与路径，不替你同步 Git 分支、数据库、终端进程和扩展内部状态；JSONL 可检查，也意味着工具若要跨机器共享、并发写入或迁移格式，责任落在使用者。Claude Code 更适合“我想继续昨天那次工作”，Pi 更适合“我想知道昨天到底在哪个节点改变了方向”。

## Codex 对 Claude Code：恢复给人看，还是恢复给客户端驱动

Codex App Server 把会话拆成 thread、turn、item，并允许 thread 创建、恢复、分叉和归档。[官方工程文章](https://openai.com/index/unlocking-the-codex-harness/) 强调事件历史持久化，让客户端重连后重建时间线。与 Claude Code 的产品会话相比，Codex 的优势在于恢复对象是客户端可消费的运行语义：消息、工具执行、审批和 diff 都可以拥有明确生命周期。

这使 Codex 更适合浏览器、IDE 或内部任务台。客户端崩溃不必等于 Agent thread 消失，新的客户端可以追上服务端状态。Claude Code 的本地 transcript 与云端会话迁移更接近日常工作台连续性；Codex 更接近“服务端继续持有任务，前端只是观察和控制”。如果目标是多端产品，后者更容易成为共同底座。

Codex 的短板是恢复复杂度不会消失，只是被协议化。客户端必须处理重复或迟到事件、进行中的 item、审批等待和断线重连，还要确定哪一端拥有取消权。Claude Code 用户接受官方会话语义，少写代码；Codex 集成者获得状态控制，却要证明自己的客户端确实能重建同一现实，而不是只把聊天消息重新画出来。

## DeepSeek Harness 对 Pi：不可改的事件，还是可导航的分支

DeepSeek Harness 的 [Core 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md) 将 session 描述为 append-only 的 `SessionEvent` 日志，默认 loop 会把模型可见事实继续追加进去；[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 又把 session log 本身列为可替换插件。相比 Pi 的树形文件，它更强调时间顺序、事件消费与运行时组合，而不是把用户导航分支作为主要体验。

Append-only 的优势是既有记录不必为“当前真相”被重写，审计或 telemetry 可以沿事件序列消费。Pi 的优势则是人能直接看见父子路径，并从某个节点重走。要复盘“一次批准后发生了什么”，DeepSeek Harness 的事件取向更自然；要比较“方案 A 与方案 B 从哪里分开”，Pi 的树结构更直观。

两者的短板也不能互相抵消。Pi 的树不会自动捕获 extension 在进程外产生的全部副作用；DeepSeek Harness 的事件日志也只记录插件选择写入的事实，漏记的外部动作不会因 append-only 自动出现。前者需要补环境快照，后者需要验证事件覆盖面。任何一方都不能仅凭日志结构宣称恢复正确。

DeepSeek Harness 当前仍处 developer preview，[README](https://github.com/deepseek-ai/deepseek-harness) 警告会有破坏兼容变化。把 session log 设计成可替换插件有研究价值，但长期迁移、重放兼容和恢复成功率还需要具体版本与实测；Pi 的公开 JSONL 树较容易直接检查，却同样把格式消费者和并发策略交给使用者。

## 四种恢复都缺少同一块，但缺口位置不同

多人交接时，Claude Code 的优势是接手者可以从命名会话、摘要和项目 memory 快速理解前任意图，短板是他仍要相信或复核前任留下的自然语言。Pi 的树能显示哪条分支被放弃，比线性 transcript 更容易追溯决策；但接手者也要理解树上每个节点对应哪个 Git 状态。前者优化阅读连续性，后者优化路径透明度。

Codex 更适合把交接做成产品功能：宿主可以基于 thread 与 item 显示当前工具、待审批项和 diff，而不只给接手者一段摘要。代价是这些视图必须由客户端实现并验证。Claude Code 把更多交接体验交给官方产品，Codex 把结构化事件交给集成者；一个省产品开发，一个允许按组织流程定制。

DeepSeek Harness 可以让事件日志接入自建审计或恢复服务，甚至让不同 profile 使用不同 session 插件；这比 Pi 直接读取 JSONL 更有运行时可塑性，也更依赖插件契约。若审计消费者落后于事件版本，日志仍在却无法可靠解释；Pi 的文件格式较直接，但缺少平台级消费者也会让交接退化成人工翻阅。

存储成本同样不是越完整越好。Claude Code compact 主动牺牲部分旧细节换上下文空间；Codex 可以让服务端长期保存更细 item，却要处理保留期与敏感数据；Pi 的树保留多条路径，文件会随试验增加；DeepSeek Harness 的事件流若覆盖细密 telemetry，查询和迁移成本会同步增长。四者都在信息量与可用性之间取舍，只是决策人不同。

删除权也值得比较。Claude Code 用户可以清理会话与可编辑 memory，但云端和本地边界要分别处理；Codex 平台需要定义 thread 归档与数据生命周期；Pi 用户直接管理本地 JSONL，控制最直接也最容易误删；DeepSeek Harness 可替换持久化，却必须保证插件真的执行组织的删除要求。恢复能力越强，隐私与保留责任通常越重。

任务中断后，Claude Code 最容易让人找回意图与对话，最需要补查工作区和外部服务；Codex 最容易让客户端找回事件生命周期，最需要补证客户端重放与实际执行环境一致；Pi 最容易找回分叉路径，最需要补齐每条路径对应的代码与进程状态；DeepSeek Harness 最容易建立自定义事件审计，最需要证明日志插件没有漏掉关键副作用。

压缩还会制造不同损失。Claude Code 的 compact 便利，但摘要可能丢掉低频约束；Codex 的 thread 历史可以更细，客户端却可能只呈现部分 item；Pi 可以保留旧分支，带到新分支的摘要仍需判断；DeepSeek Harness 保存事件序列，但新的 loop 怎样把旧事件选择进上下文取决于插件。保存得多不等于下一轮看得对。

跨机器恢复时，差别更明显。Claude Code 需要区分本地 resume 与云端会话迁移；Codex 要确认服务端 thread 与新客户端身份；Pi 要搬运 JSONL 及其引用的项目环境；DeepSeek Harness 要重建兼容的 profile、插件版本与事件消费者。真正可恢复的最小单元从来不只是一个会话 ID。

验收时应故意在工具执行中、审批等待中和分支切换后三次中断。Claude Code 要证明恢复后没有把摘要当新事实；Codex 要证明 item 状态不重放副作用；Pi 要证明选择的叶子对应正确 Git 状态；DeepSeek Harness 要证明插件重启能继续读取事件且不会重复执行。四者只有在这些坏路径中，才会暴露各自恢复边界。

## 裁决：先说清你要恢复的对象

| 产品 | 优势 | 短板 | 代价 | 适合谁 |
| --- | --- | --- | --- | --- |
| Claude Code | resume、fork、compact 面向人使用，连续体验完整 | 对话连续容易掩盖工作区与进程已经变化 | 恢复后人工核对代码、环境和摘要约束 | 以个人或结对长任务为主的开发者 |
| Codex | thread/turn/item 适合客户端重连和状态重建 | 客户端必须正确处理事件、审批与重复消息 | 实现可靠重放、身份和取消语义 | 需要持久任务与多客户端的产品团队 |
| Pi | JSONL 树让分支路径显式、可检查 | 外部副作用与并发写入不由会话树解决 | 自管文件迁移、环境快照与扩展状态 | 经常回看或比较多条实现路径的使用者 |
| DeepSeek Harness | 追加事件流与可替换日志适合定制审计 | 预览期兼容性、事件覆盖与重放正确性待验证 | 固定插件图并维护事件迁移测试 | 研究事件驱动运行时和恢复策略的平台团队 |

想“回到昨天继续做”，Claude Code 的产品会话最省力；想让 Web 或 IDE 在断线后接管，Codex 的 thread 更合适；想保留每次转向，Pi 的树最直观；想自己定义什么事件值得保存，DeepSeek Harness 控制最深。四种选择都必须与代码环境一起验收，否则恢复的只是叙事。

## 本篇引用来源

- [Claude Code：Manage sessions](https://code.claude.com/docs/en/sessions)
- [Claude Code：How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [OpenAI：Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi：Sessions](https://pi.dev/docs/latest/sessions)
- [DeepSeek Harness：Core subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)
- [DeepSeek Harness：Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness：README](https://github.com/deepseek-ai/deepseek-harness)
