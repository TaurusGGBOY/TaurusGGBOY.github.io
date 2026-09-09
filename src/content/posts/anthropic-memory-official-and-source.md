---
title: "Anthropic 的 Memory 分几类？读完官方文章，再看 Claude Code 源码"
published: 2026-09-09T10:07:00+08:00
updated: 2026-09-09
description: "通读 17 篇 Anthropic 官方资料，结合 Claude Code 源码，区分记忆的用途、四种内容类型与作用域，追踪写入、召回、会话压缩和 dreaming。"
tags: ["claude-code", "source-code", "ai-agent", "memory"]
category: "AI / Architecture"
draft: false
image: "/images/posts/anthropic-memory-official-and-source/claude-code-source-reading-00.png"
imagePosition: "left"
---

你告诉 Claude：“这个项目的集成测试要连真实数据库，别全部换成 mock。”这次它照做了。第二天换一个会话，它还能记住吗？

再换一种情况：一个改造任务做到一半，上下文快满了。你希望它记得哪些文件改过、哪个测试失败、下一步查哪里。

这两件事都叫“记住”，需要保存的信息却不同。前者是一条可能反复影响协作的反馈，后者是一份当前任务的交接记录。把它们都塞进一个越来越长的文件，很快就会遇到另一个问题：东西确实存着，但模型这次没读到，或者读到了已经过期的版本。

我检索并通读了文末列出的 **17 篇 Anthropic 官方文章、文档与 Cookbook**，再对照这个仓库恢复出的 Claude Code 源码。它们共同指向一个工程问题：**哪些信息值得离开当前上下文保存下来，下一次又怎样把合适的部分送回上下文？**

资料检索截至 **2026 年 9 月 9 日**，这是围绕 memory 的核心阅读清单，不是官网所有提及该词的页面全集。源码边界是本系列的 **2.1.88 恢复源码快照**；当前产品文档可能已经演进。下面会分别标明官方定义、本文的分类，以及这份代码能够确认的实现。

## 先介绍几个概念：保存、检索与使用

模型这一轮能直接利用的是输入上下文。把内容写进文件或数据库以后，应用还需要通过预加载、搜索或工具读取，把它重新放进某一轮请求里。“磁盘里有记录”本身不会让模型凭空知道它。

Anthropic 的 [context engineering 文章](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)把压缩、结构化笔记和多 Agent 分工放在同一问题下讨论：上下文有限，进入上下文的信息需要选择。沿着这个思路，可以把记忆系统拆成四步：

1. **提炼**：从交互中挑出以后仍有用的信息。
2. **保存**：写进一个能够跨越所需生命周期的载体。
3. **召回**：为当前任务找出相关记录。
4. **维护**：修正错误，合并重复，移除过期信息。

这是本文采用的分析框架，不是 Anthropic 对所有产品规定的一套统一 API。

几个邻近概念也值得分开。**Compaction** 改写当前会话的历史表示；**RAG** 描述检索后把材料交给模型的方式，检索对象可以是文档，也可以是历史记录；**prompt caching** 复用重复输入的计算，并不负责判断一条用户反馈是否值得长期保存。它们可以组合使用，各自解决的问题不同。[平台 context management 文章](https://claude.com/blog/context-management)和[官方 context engineering Cookbook](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)展示的正是组合，而不是要求选一个包办全部。

## 第一种分类：这份信息要帮你完成什么事

“短期记忆、长期记忆”适合入门，但做实现时还不够。一个任务可能持续几周，它的进度文件仍然服务于这个任务；一句长期偏好也可能明天就被用户改掉。

下面按用途划分。**这是本文对官方材料的归纳，不是源码中的枚举。**

| 用途 | 典型内容 | 对应载体或机制 | 主要问题 |
| --- | --- | --- | --- |
| 当前推理所需的信息 | 本轮消息、刚读到的代码、工具结果 | 活跃上下文 | 此刻该保留什么 |
| 任务续接与交接 | 已完成步骤、未解决问题、下一步 | Session Memory、进度文件、任务清单 | 换上下文后怎样继续 |
| 跨会话可复用的信息 | 用户背景、反馈、项目背景、外部资料入口 | Auto Memory、产品 memory、应用记忆库 | 以后什么时候还会有用 |
| 显式工作指令 | 测试要求、代码约定、操作规则 | CLAUDE.md、规则文件等 | 每次工作应遵守什么 |

[长任务 harness 文章](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)给了很具体的例子：初始化 Agent 准备环境、功能清单和进度文件；后续 Agent 先读这些产物，再逐项实现、测试和记录。这里的文件帮助任务跨越多个上下文窗口，它们不必成为用户的永久画像。

[多 Agent research system 文章](https://www.anthropic.com/engineering/multi-agent-research-system)也讲到把计划保存在外部、利用产物和摘要衔接工作。这能说明外部状态的作用，但不能仅凭文章里的 “Memory” 一词，就认定它调用了后来公开的同名 memory tool。

显式指令则有另一种来源。[Claude Code 当前 memory 文档](https://code.claude.com/docs/en/memory)区分了人写的 CLAUDE.md 与 Claude 自动积累的记忆。前者告诉它如何工作，后者记录交互中发现的、以后可能有用的信息。两者都可能进入上下文，但自动记忆里的“过去是这样”不应自行升级成新的授权。

## 第二种分类：Claude Code 官方的四种内容类型

真正写进这份源码枚举的是下面四个小写字符串：

```ts
export const MEMORY_TYPES = [
  'user', 'feedback', 'project', 'reference'
] as const
```

定义位于 [memoryTypes.ts](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/memdir/memoryTypes.ts)。当前官方文档也已经给出这四类。

**这四类是平级的内容分类，没有高低优先级，也不决定在哪个范围生效。** 在本节讨论的 Auto Memory 中，它们用于组织跨会话可复用的信息。

| 类型 | 保存什么 | 示例（本文构造） | 容易放错的内容 |
| --- | --- | --- | --- |
| `user` | 用户角色、知识背景，以及对协作有帮助的个人信息 | 用户熟悉后端，但希望前端解释多一些背景 | 当前任务的临时进度 |
| `feedback` | 用户希望避免或重复的协作行为及原因 | 集成测试需要真实数据库，以覆盖 SQL 行为 | 只存一句禁止事项，丢掉原因和适用范围 |
| `project` | 正在推进的事情、目标、约束和背后的原因 | 当前迁移优先保持旧接口兼容，因为外部客户端尚未升级 | 能直接从代码或 Git 历史重新查到的事实 |
| `reference` | 相关信息应当到哪里找 | 接口变更登记在某个外部追踪系统 | 无差别复制整个外部知识库 |

`feedback` 不只记录批评，也可以保存用户认可、以后希望继续采用的做法。源码提示要求保留原因与应用方式；这比“永远不要 mock”更有用，因为用户可能只是在限定某一类集成测试。

`project` 也不等于“任何和仓库有关的东西”。源码明确排除可以从当前代码、目录结构或 Git 历史推导的信息。记忆更适合保存**代码里看不出的动机和协作背景**。

再给每类三个具体例子。下面的内容都是示意；若信息已经记录在 CLAUDE.md 中，源码提示要求避免重复保存。

| 类型 | 值得保存的信息 |
| --- | --- |
| `user` | 用户有多年 Go 经验，刚开始接触 React |
| `user` | 用户负责后端架构和技术评审 |
| `user` | 用户的学习目标是理解 Agent 上下文管理机制 |
| `feedback` | 解释函数时，要说明参数可选值及默认行为 |
| `feedback` | 数据库集成测试要验证真实 SQL 行为，因为测试替身曾掩盖迁移问题 |
| `feedback` | 用户认可这类紧密关联的重构合并成一个 PR，便于整体评审 |
| `project` | 保留旧接口是因为外部客户端尚未完成升级 |
| `project` | 为准备发布，从 2026-09-15 起冻结非关键变更 |
| `project` | 重写认证模块主要由合规要求驱动 |
| `reference` | 接口规范维护在指定飞书文档中，保存其链接与用途 |
| `reference` | 数据管道问题统一在某个 Linear 项目追踪，保存项目入口 |
| `reference` | 某个 Grafana 看板用于观察请求延迟，保存看板入口 |

“我刚开始学 React”描述用户背景，适合归入 `user`；“解释 React 时，请用后端概念作类比”直接指导协作方式，适合归入 `feedback`。分类帮助后续理解内容，无法替代对具体语境的判断。

类型解析也有一个边界：

```ts
parseMemoryType(raw: unknown): MemoryType | undefined
```

输入可以是任意未知值；只有精确匹配这四个字符串才返回相应类型。非字符串、未知字符串，以及缺少字段的旧文件都会得到 `undefined`。它表示没有识别出类型，并不是第五种记忆，更不会自动回退成 `project`。

这一步只能识别分类字段。它无法证明正文是真的，也无法判断一条记录现在是否仍适用。

## 第三种分类：谁的记忆，谁能读写

内容类型回答“存的是什么”；作用域回答“归谁所有、在哪里生效”。这两个维度需要分开。

在 [agentMemory.ts](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/tools/AgentTool/agentMemory.ts) 中，子 Agent 的作用域是：

```ts
type AgentMemoryScope = 'user' | 'project' | 'local'
```

| 作用域 | 普通本地路径布局 | 意义 |
| --- | --- | --- |
| `user` | 用户记忆根目录下的 `agent-memory/<agent>/` | 这个子 Agent 在用户范围内积累信息 |
| `project` | `<cwd>/.claude/agent-memory/<agent>/` | 记忆放在项目目录内 |
| `local` | `<cwd>/.claude/agent-memory-local/<agent>/` | 项目本地的另一套目录 |

这里的 `user` 是**存放作用域**，不是上节的**用户背景类型**。用户范围的目录里完全可以保存一条 `feedback`。

路径函数 `getAgentMemoryDir(agentType, scope)` 的第二个参数必须是以上三值之一，没有默认作用域；第一个参数来自配置中的 Agent 名称，是开放字符串，并非固定 Agent 名单。远程记忆挂载环境另有路径分支，上表不适合直接套到所有运行方式。目录位于项目内也不自动意味着它已经被 Git 提交或跨机器同步。

源码还有一组大写名称：`User`、`Project`、`Local`、`Managed`、`AutoMem`，以及受编译特性控制的 `TeamMem`。它们出现在[记忆加载类型](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/utils/memory/types.ts)中，用于区分加载来源。不能把这组来源、子 Agent 作用域和四种内容类型拼成一张“官方记忆等级表”。

### 同一个项目的所有会话都会读取吗

普通本地会话在解析到同一个 Auto Memory 目录时，可以共享其中的记忆。[paths.ts](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/memdir/paths.ts)的默认路径以规范化的 Git 仓库根目录确定项目，因此同一仓库的 worktree 也可落到共同的项目记忆目录；显式目录配置和远程环境另有分支。

但“共享”要分成三个动作看：

| 动作 | 发生条件 |
| --- | --- |
| 加载 MEMORY.md 索引 | Auto Memory 启用，入口存在且能读取；进入上下文的内容受长度限制 |
| 读取某个主题文件 | 与当前任务相关时按需展开，不保证每条都读取 |
| 新增或更新记忆 | 出现值得保存的信息时进行；后台提炼另有功能条件 |

这个共享范围不自动覆盖另一台机器、团队其他成员或所有子 Agent。子 Agent 可以使用自己的目录。**`type: project` 只描述项目背景，真正决定跨哪些会话共享的是目录解析和加载机制。**

## 一条反馈怎样进入下一次会话

回到“集成测试连接真实数据库”的例子。跨会话保存大致走下面这条路径。

![Session Memory 用摘要衔接当前任务；Auto Memory 用主题文件与索引保存跨会话信息](/images/posts/anthropic-memory-official-and-source/anthropic-memory-paths.png)

图中下方索引指向主题文件；读取时先获得入口，再按需展开。图里的主题文件名是示意名称，不是四种类型的枚举。

### 先写主题，再建立入口

[buildMemoryLines()](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/memdir/memdir.ts#L199)生成记忆使用提示。普通索引模式要求分两步保存：一份独立 Markdown 主题文件，以及 MEMORY.md 中指向它的一行链接。

下面是符合这种结构的示意，内容来自本文的假设场景：

```markdown
---
name: integration-test-policy
description: 集成测试需要验证真实 SQL 行为
type: feedback
---

集成测试应连接测试数据库。

原因：用户需要覆盖 SQL 与数据库约束的实际行为。
应用范围：数据库集成测试；不据此禁止其他层面的单元测试替身。
```

MEMORY.md 只保留简短入口：

```markdown
- [集成测试约定](feedback-integration-tests.md) — 数据库集成测试需验证真实 SQL 行为
```

这让系统可以先付出较小的上下文成本，等任务相关时再读取完整原因和适用范围。

这个提示构造函数的 `skipIndex` 参数默认是 `false`，要求维护索引；取 `true` 时省去索引写入指引，保留主题文件规则。它不是“禁用记忆”的开关。可选的 `extraGuidelines` 是追加指引的字符串数组，未提供时按空数组处理；目录与显示名称是调用方传入的开放字符串。

### 什么时候分文件，文件名由谁决定

**准备保存时，就由模型判断应当新建主题还是更新已有文件。** `buildMemoryLines()` 的提示要求每份记忆使用独立文件，按语义主题组织，并在新建前检查是否已有可更新的记忆。这些是给模型的组织规则；这里没有按正文长度自动切文件的算法。

例如，第一次得知数据库集成测试的要求，可以创建 `feedback_integration_testing.md`。后来用户补充“因为以前测试替身掩盖过迁移失败”，应当更新同一文件的原因；再得知“解释源码时要说明默认值”，则适合新建 `feedback_source_explanation.md`。两条都属于 `feedback`，但分别影响测试与解释工作，可以独立召回。

所以，四种类型不意味着只有四个大文件，也不要求一句话一个文件。具体主题边界由模型判断。MEMORY.md 的 200 行预算限制索引加载，**不是等写满 200 行才开始拆文件的触发器**。

源码提示给出的文件名例子包括 `user_role.md` 和 `feedback_testing.md`。`<类型>_<具体主题>.md` 是容易理解的命名方式，但在这段实现中不是强制命名算法；文件名由模型选择，索引链接应与实际路径一致。名字应让主题容易辨认，而不是按日期堆成一份会话日志。

文件名与文件内的字段也要分开：

| 项目 | 用途 | 示例 |
| --- | --- | --- |
| 文件名 | 定位主题文件 | `feedback_source_explanation.md` |
| `name` | 记忆名称 | 源码解释要求 |
| `description` | 提供召回时判断相关性的线索 | 讲解函数时说明参数可选值、默认值和行为差异 |
| `type` | 声明内容类型 | `feedback` |

类型解析读取 `type` 字段，不是从文件名的 `feedback_` 前缀推导。普通索引模式下，创建主题文件之后，还要在 MEMORY.md 中补上入口。

### 入口有预算，正文按需读取

[claudemd.ts](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/utils/claudemd.ts#L980)在 Auto Memory 启用且入口存在时，将它作为 `AutoMem` 来源加入加载结果。加载索引不等于启动时把所有主题文件全文读进来。

[memdir.ts 的截断实现](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/memdir/memdir.ts)还有一个值得对照文档的小细节：入口限制包含 **200 行**与名为字节上限的 **25,000**。但这份快照计算长度用的是 JavaScript 字符串的 `.length`，实际是 UTF-16 码元计数，并非 UTF-8 文件字节数。中文内容不能简单按“严格 25KB 文件上限”理解。

这种“先给入口，再展开正文”的方式，就是渐进式披露。会话判断该读什么，首先靠索引里的标题和短描述。例如模型已经看到“数据库集成测试需验证真实 SQL 行为”，你再要求它补数据库测试，它就可以判断这条记忆相关，通过 Read 工具打开对应文件，取得完整原因和范围。若索引只写“项目经验”，提供的召回线索就弱得多。

[记忆访问提示](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/memdir/memoryTypes.ts)要求在记忆看起来相关、用户提及之前的工作时访问记忆；用户明确要求检查或回忆时，也要求访问。这条路径依赖主模型的相关性判断，不保证每次选对。

源码还提供一种相关记忆筛选路径。[findRelevantMemories()](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/memdir/findRelevantMemories.ts)把候选文件的名称、描述交给一次辅助模型请求，选择与当前输入相关的记忆，再由[附件构造函数](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/utils/attachments.ts#L2196)过滤已读内容、最终截取最多五份并读取。

这条路径展示的是“先筛元信息，再展开正文”。筛选函数本身的“五份”是提示目标，调用方的 `.slice(0, 5)` 才提供实际数量上限。它受相关功能路径控制，不能由源码存在就推断每位用户每轮都会运行；筛选失败返回空结果，也不意味着记忆已被删除。

这就是第二条召回路径：程序把当前输入、最近使用的工具以及候选元信息用于辅助筛选，再把选中文件的正文作为附件交给主模型。此时主模型不必先自行发出 Read。两条路径都依据任务相关性展开内容，不会因为某份记忆标了 `project` 就无条件全文加载。

### 写入还可以由后台提炼完成

[extractMemories.ts](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/services/extractMemories/extractMemories.ts)实现了另一条写入路径：从会话中提炼可复用信息，运行独立的 forked Agent。该调用设置 `maxTurns: 5`，并有单独的工具许可逻辑。

许可允许读取、搜索和被判定为只读的 Bash 操作；Edit、Write 则检查目标是否处于 Auto Memory 路径。限制写入位置由执行代码承担，不能只依赖提示词中的“请只修改记忆”。

这条提炼路径有功能开关，并限制在相应主会话、本地运行条件下。源码还检查主 Agent 是否已经发出记忆写入工具调用，以避免重复提炼。这里检测的是工具调用记录，不能单凭它证明对应文件已成功落盘。

所以，设计应用时至少应该分开观察：提炼产生了什么、写入是否成功、下一次是否召回、回答是否正确采用。只统计“今天新增了多少条记忆”，很容易奖励重复和噪声。

## Session Memory 为什么另有一份 summary.md

Auto Memory 的提示明确把当前计划和任务进度导向计划、任务等机制。那当前工作做到哪一步，由谁保存？

[Session Memory](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/services/SessionMemory/sessionMemory.ts)维护当前会话目录下的 `session-memory/summary.md`。它围绕会话提炼续接信息，与跨会话主题文件的目的不同。

这份实现的默认触发参数是：首次约到 10,000 token 后开始；后续新增约 5,000 token，并且满足“累计工具调用达到 3 次”或者“到达没有工具调用的 assistant 轮次末尾”之一。不能简化成“每三次工具调用就总结”。这些是默认值，远程配置可以调整。

提炼器先取得摘要文件内容，随后 fork 的工具权限只允许编辑指定摘要文件。它更新已总结消息边界时，还要顾及工具调用与结果的配对。

进入自动压缩时，[autoCompact.ts](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/services/compact/autoCompact.ts#L288)会尝试 Session Memory 压缩路径。[trySessionMemoryCompaction()](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/services/compact/sessionMemoryCompact.ts#L514)在功能未开启、摘要不存在、只有空模板，或无法确定有效边界等情况下返回 `null`，让调用方继续传统压缩；成功时则用摘要和保留的消息构造压缩结果。

因此，有这段代码不等于每次压缩都走它。它也不能保证总结保留了未来任务会需要的一切。[官方 session management 文章](https://claude.com/blog/using-claude-code-session-management-and-1m-context)提醒的恰好是这个问题：总结时尚不知道下一轮会问什么，较大的上下文也没有消除选择信息的必要。

## “做梦”在整理什么？两种实现别混用

随着主题文件积累，需要处理重复、矛盾与过期信息。源码里的 AutoDream 把这个维护步骤单独拿出来。

[consolidationPrompt.ts](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/services/autoDream/consolidationPrompt.ts)依次要求：了解已有记忆，寻找近期相关信息，合并和纠正主题，最后清理索引。它特别要求把相对日期转成绝对日期，以及在新证据推翻旧记录时直接修正原处。

[AutoDream 调度代码](https://github.com/TaurusGGBOY/claude-code-sourcemap/blob/ae63175c5bf1d46e2471d067cd18c84b59e65906/restored-src/src/services/autoDream/autoDream.ts)的默认门槛包括距离上次整理 24 小时，以及此后至少 5 个符合条件的其他会话；当前会话不计入后者。这些是检查时的条件，不是一个保证每天执行的定时承诺。

`autoDreamEnabled` 若显式设为 `true` 或 `false`，优先采用该值；为 `undefined` 时才读取远程配置，而且只有远程字段严格为 `true` 才启用。时间和会话数配置接受有限正数，无效值回退默认值。另有本地运行、Auto Memory 等前提，不能只改一个开关就推导所有条件都满足。

Anthropic 后来公开的 [Managed Agents dreaming](https://claude.com/blog/new-in-claude-managed-agents)也处理经验整理，但交付方式不同：

| 比较项 | 这份 Claude Code AutoDream 源码 | 当前 Managed Agents Dreams 文档 |
| --- | --- | --- |
| 工作对象 | 本地记忆目录及可读取的会话记录 | 调用方指定的输入 memory store 与 session |
| 输出方式 | 直接修改本地记忆文件 | 克隆输入，产生新的输出 store |
| 后续使用 | 后续读取修改后的文件 | 调用方把输出 store 用于后续会话 |
| 失败后的理解 | 回滚整理锁状态不等于撤销文件编辑 | 输入 store 保持不变；失败也可能留下部分输出 |

右列依据[官方 Dreams 文档](https://platform.claude.com/docs/en/managed-agents/dreams)。新 store 的设计给了调用方检查与选择采用的机会。左列的异常处理恢复的是锁的时间状态，源码没有因此获得整个目录的事务回滚能力。

这也是为什么“都有 dreaming”不足以说明它们是同一个实现。

## Claude 产品、API 工具与托管记忆分别由谁管理

官方页面使用同一个 memory 词，但部署边界差别很大。

| 使用场景 | 谁负责持久化 | 应当核对的边界 |
| --- | --- | --- |
| Claude chat 与云端 Cowork 的产品记忆 | Anthropic 产品 | 项目隔离、开关、编辑删除、产品适用范围 |
| Claude Code Auto Memory | CLI 所使用的文件存储 | 本地目录、项目与 Agent 作用域、实际同步安排 |
| Messages API memory tool | 应用开发者 | 工具执行、路径限制、用户隔离、跨请求复用 |
| Managed Agents memory | 托管 memory store；特定自托管 worker 另有同步安排 | store 挂载、读写模式、版本与删除 |

2025 年的 [Bringing memory to Claude](https://claude.com/blog/memory)主要介绍从对话形成记忆以及项目区分。2026 年 8 月的[更新文章](https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it)则描述 chat 与 Cowork 共用的主题式记忆。按[当前帮助文档](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)，这里的 Cowork 指云端体验，不能顺手推导成 Claude Code 本地目录也自动同步。帮助页还同时保留了少量组织使用的旧版记忆说明，阅读时要区分新旧段落。

产品中的聊天搜索与记忆也是两种能力。删除一段聊天，不应被当成必然删除已从中提炼出的新式记忆；需要检查对应记忆项。关闭使用、暂停积累、删除内容分别会改变什么，要以所用产品版本的控制项为准。

[API memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)提供的类型名是 `memory_20250818`，命令包括 `view`、`create`、`str_replace`、`insert`、`delete`、`rename`，分别用于查看、创建、替换片段、插入、删除和重命名。它是客户端工具：应用接到工具调用后执行操作，再返回结果。模型发出“保存”请求，不意味着 Anthropic 已经替应用建立一个永久数据库。

[Managed Agents memory 文档](https://platform.claude.com/docs/en/managed-agents/memory)则提供托管 store 与文件版本。挂载访问模式有 `read_write` 和 `read_only`，默认前者，后者通过文件系统约束写入。版本让审计和恢复成为可能，也意味着删除当前文件与清除历史内容是不同操作；文档另有 redaction 能力。选择托管方案时，这些数据生命周期语义比“是否支持 memory”更具体。

## 文件是好入口，但不是唯一答案

Claude Code 的主题 Markdown 与索引适合代码工作流：容易查看，能用现有文件工具检索，修改也很直接。[Managed Agents memory 发布文章](https://claude.com/blog/claude-managed-agents-memory)同样强调可检查和管理的持久状态。

但官方并没有把所有 memory 都限定为 Markdown 文件。[commerce agents 文章](https://claude.com/blog/the-anatomy-of-effective-commerce-agents)展示的是数据库记录：带类型、键值和来源会话，按真实用户隔离；写入由异步提炼器完成，读取又分成常驻、逐轮预取和显式查询几个层次。

这套安排适合它讨论的业务条件，不能反过来要求所有 Agent 都异步写入，或都使用同样的数据模型。源码中“用户明确要求记住时立即保存”也有合理用途。

真正应先确定的是：这条信息属于谁、适用多久、从哪次交互得来、哪些请求可能用到。确定这些之后，再选择文件、关系数据库或检索系统，架构会清楚得多。

## 最后还要检查：记住的东西是否正确

[Sonnet memory Cookbook](https://platform.claude.com/cookbook/tool-use-memory-cookbook)用多会话代码审查演示经验如何复用。它展示了工作流程，但示例中的模型审查结论仍然需要回到代码验证；进入下一次上下文不会自动提高一条结论的真实性。

另一份 [context engineering Cookbook](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)则明确把演示与具体任务、预算和策略放在一起。比较其中的 token 或效果数字时，需要先确认是否使用同一工作负载；不能把不同会话、不同设置下的结果直接当成通用收益。

Claude Code 的记忆提示也要求核对当前代码，并更新已经漂移的事实。这条要求值得落到验证流程中：

| 想验证的能力 | 可以怎样检查 |
| --- | --- |
| 跨会话保留反馈 | 新开会话给出相关任务，检查是否读到并采用反馈 |
| 作用域隔离 | 切换用户或项目，检查是否错误带入其他范围的信息 |
| 更新旧事实 | 明确更正旧约束，检查后续是否仍采用旧版本 |
| 删除与遗忘 | 删除目标记录后，检查索引、其他副本和版本机制 |
| 节省上下文 | 比较相同任务下实际读取的内容和 token，而非只看文件体积 |
| 改善任务结果 | 检查任务完成质量，确认模型没有只在回答中复述记忆 |

对开头那个例子，完整的结果应该是：保存带原因和范围的测试反馈；在下一次数据库集成测试任务中召回；结合当前要求正确使用；用户更改约定后，能修正旧记录。做到这一整条链路，“记住”才真正减少了下一次协作的成本。

## 官方阅读清单

以下 17 篇均已通读。日期是文章发布日期或明确的更新日期；持续维护的文档以本次检索日为阅读边界。

| 官方资料 | 时间 | 这篇主要帮助理解什么 |
| --- | --- | --- |
| [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | 2025-06-13 | 计划、外部产物与多 Agent 上下文衔接 |
| [Bringing memory to Claude](https://claude.com/blog/memory) | 2025-09-11；10-23 更新 | 产品记忆早期设计与项目区分 |
| [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 2025-09-29 | 压缩、结构化笔记与上下文选择 |
| [Managing context on the Claude Developer Platform](https://claude.com/blog/context-management) | 2025-09-29 | Context editing 与 memory tool 的组合 |
| [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 2025-11-26 | 长任务的进度、清单与交接产物 |
| [Using Claude Code: session management and 1M context](https://claude.com/blog/using-claude-code-session-management-and-1m-context) | 2026-04-15 | 会话管理与压缩的使用边界 |
| [Built-in memory for Claude Managed Agents](https://claude.com/blog/claude-managed-agents-memory) | 2026-04-23 | 托管持久化、检查与管理 |
| [New in Claude Managed Agents: dreaming, outcomes, and multiagent orchestration](https://claude.com/blog/new-in-claude-managed-agents) | 2026-05-19 | 跨会话整理与其他托管能力的区别 |
| [Claude’s memory works everywhere, and you decide what’s in it](https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it) | 2026-08-25 | 新式主题记忆与 chat／Cowork 共享 |
| [A guide to the anatomy of effective commerce agents](https://claude.com/blog/the-anatomy-of-effective-commerce-agents) | 2026-09-02 | 数据库记忆、用户隔离与分层读取 |
| [How Claude remembers your project](https://code.claude.com/docs/en/memory) | 持续更新 | CLAUDE.md、Auto Memory 与四种内容类型 |
| [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) | 持续更新 | 客户端工具协议与开发者责任 |
| [Using agent memory](https://platform.claude.com/docs/en/managed-agents/memory) | 持续更新 | Memory store、访问模式、版本管理 |
| [Dreams](https://platform.claude.com/docs/en/managed-agents/dreams) | 持续更新 | 异步整理、新输出 store 与采用流程 |
| [Use Claude’s chat search and memory to build on previous context](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context) | 持续更新 | 聊天搜索、新旧记忆、用户控制 |
| [Context engineering: memory, compaction, and tool clearing](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools) | Cookbook | 多种策略的可运行实验与预算边界 |
| [Memory and context management with Claude Sonnet 4.6](https://platform.claude.com/cookbook/tool-use-memory-cookbook) | Cookbook | 跨会话代码审查示例与工具执行 |

本文的源码链接固定到仓库提交 `ae63175c5bf1d46e2471d067cd18c84b59e65906`。这里引用的是从 sourcemap 恢复的实现，不应据此推断 Anthropic 当前生产环境的全部开关、部署范围或服务端细节。
