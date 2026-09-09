---
title: "LangChain 如何定义 Memory：短期、长期，与事实、经历、做法"
published: 2026-09-09T11:28:00+08:00
description: "从 LangChain 官方定义出发，讲清短期与长期记忆、语义与情景及程序性记忆，以及 LangMem 自动提炼和 RAG 召回分别负责什么。"
tags: ["langchain", "langgraph", "langmem", "memory", "rag"]
category: "AI / Architecture"
draft: false
image: "/images/posts/langchain-memory-definition/cover.png"
---

你告诉 Agent：“我熟悉 Go，刚开始学 React。”几轮之后，它还能按你的背景解释问题，这是会话内记忆。换一个聊天，它仍然知道这件事，就涉及跨会话记忆。

再往下问：它保存的是用户背景、过去解决问题的经历，还是一条以后应当遵守的工作方法？这些内容又由谁提炼，怎样读回来？

LangChain 的 memory 文档把这些问题拆开讨论。理解它，先记住两个维度：

**短期／长期，回答信息是否跨会话使用；语义／情景／程序性，回答保存的是事实、经历还是做法。**

本文依据截至 2026 年 9 月 9 日的 LangChain、LangGraph 与 LangMem 官方文档。示例用于解释概念；分类不代表所有 Agent 接入框架后，就会自动拥有三套管理完善的记忆库。

## 短期与长期，先看会话范围

LangChain 在 [Memory overview](https://docs.langchain.com/oss/python/concepts/memory) 中，将记忆描述为帮助系统保留过去交互信息的能力。按召回范围，它区分两类：

| 分类 | 范围 | 典型信息 |
| --- | --- | --- |
| Short-term memory，短期记忆 | 一个 thread 内 | 当前消息历史和工作状态 |
| Long-term memory，长期记忆 | 跨 thread／会话 | 用户信息、经验、可复用知识 |

这里的 thread 可以理解为一条持续的对话线程，里面包含多轮交互。不要把它等同于操作系统线程，也不要把一轮工具调用当成整个会话。

“短期”并不是一个倒计时。会话保存多久、是否写入数据库，是持久化配置的问题；“长期”也没有规定必须保存满多少天才算数。

### 短期记忆也可以落数据库

[短期记忆文档](https://docs.langchain.com/oss/python/langchain/short-term-memory)把会话历史放在 Agent state 中。配置 checkpointer 后，框架会在执行过程中保存状态，之后可以根据 thread 恢复工作。状态还可以包含应用定义的其他字段。

因此，应用退出后再恢复同一个 thread，并不自动意味着使用了长期记忆。它可能只是在恢复原来的会话状态。

另一个容易混淆的操作是总结。LangChain 提供 `SummarizationMiddleware`，可以在配置的触发条件下，调用指定模型压缩消息历史。checkpointer 负责保存状态，总结中间件负责改写历史表示；单纯配置前者，不会自动提炼出用户画像。

例如，“用户背景＋刚才讨论了什么＋下一步做什么”可以一起留在会话摘要中。这份摘要的首要用途是让当前会话继续，不代表每项内容都已被另存为跨会话记忆。

### 长期记忆用 Store 跨越 thread

[长期记忆文档](https://docs.langchain.com/oss/python/langchain/long-term-memory)使用 LangGraph Store 保存 JSON 文档，以 namespace 与 key 组织数据。应用可以让不同 thread 访问同一份用户记忆，也可以按用户、组织、应用范围分别组织。

可以把 namespace 想成目录，key 想成条目名称：

```text
namespace = ("users", "user_001", "memories")
key       = "technical_background"
value     = {"content": "熟悉 Go，刚开始学 React"}
```

这个例子表达的是存储结构，名称由应用定义。换一个会话，只要应用仍然访问同一用户范围，就能读取这条记录。namespace 帮助组织数据，但用户身份与访问边界仍须由应用正确处理，不能让模型随意选择其他用户的范围。

官方示例中的 `InMemoryStore` 支持同一进程内跨 thread 共享。若需要重启后保留数据，应采用数据库后端。这说明**跨会话范围与磁盘持久化是两个独立问题**。

## 语义、情景、程序性，分别保存什么

LangChain 在讨论长期记忆时借用认知科学分类，将内容分成 semantic、episodic、procedural。它们帮助我们设计记忆的用途，没有要求应用必须建三张表或三个目录。

| 分类 | 便于记忆的说法 | 示例 |
| --- | --- | --- |
| Semantic memory，语义记忆 | 知道什么：事实与知识 | 用户熟悉 Go，正在学习 React |
| Episodic memory，情景记忆 | 发生过什么：具体经历 | 上一次迁移如何排查、采取了什么行动 |
| Procedural memory，程序性记忆 | 怎么做：行为规则与方法 | 验证迁移时使用真实测试数据库 |

这三个简写用于帮助理解。尤其是“程序性”，不能只按中文字面理解成“保存程序代码”。

### 语义记忆：提炼出可复用的事实

假设用户连续聊了自己的工作内容、技术经验和学习计划，应用可以提炼出：

```json
{
  "backend_experience": "熟悉 Go",
  "frontend_experience": "React 初学者",
  "learning_goal": "理解前端状态管理"
}
```

这是本文构造的画像示例。它保留以后解释问题时可能有用的信息，没有逐句复制整段对话。

LangMem 的[语义记忆提炼指南](https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/)提供了从对话提取记忆的组件，也支持按自定义 schema 表示信息。应用可以选择维护集中画像，或拆成多条独立记忆。

集中画像便于一次读取，但更新时要保留已有字段。独立条目便于按主题检索，但要处理重复和相互矛盾。这个选择取决于信息规模与读取方式；给每条记录贴上 semantic 标签，并不能替你完成这些维护工作。

还有一个名字上的区别：**semantic memory 是内容分类，semantic search 是检索方法**。用户背景可以按 key 直接读取，完全不需要先做向量检索。

### 情景记忆：保留一次经历中的情境与结果

假设团队有过这样的经历：

> 某次数据库迁移中，使用测试替身的测试全部通过，但在真实数据库上失败。排查发现，测试替身没有覆盖相关数据库约束。

这是一个假设案例。它可以作为情景记忆，记录当时的问题、采取的行动和结果。后来遇到类似迁移时，Agent 可以参考这个案例，而不只是看到一句抽象结论。

LangMem 的[情景记忆指南](https://langchain-ai.github.io/langmem/guides/extract_episodic_memories/)展示了用结构化方式提取经历的做法。经历的价值在于保留“在什么条件下，做了什么，结果怎样”，帮助判断新任务是否真的相似。

案例也不能自动升级成普遍规律。一次迁移失败，可以支持检查相同条件下的风险，不能仅凭一次事件断言所有测试替身都不可用。

### 程序性记忆：让经验影响之后的行为

从前面的案例中，团队可能形成一条工作规则：

> 验证数据库迁移时，在真实测试数据库上执行，覆盖真实约束行为。

这时保存的重点变成了“下一次应当怎么做”。

LangChain 对程序性记忆的讨论覆盖模型权重、Agent 代码与提示对行为的影响；实际应用中，更新提示是一个常见实现方向。LangMem 也提供提示优化能力，用交互和反馈帮助改进指令。[LangMem 官方介绍](https://langchain-ai.github.io/langmem/)

一条规则被写入 Store，并不会自动修改 Agent 的行为。应用还要决定何时读取它、放进哪个提示或执行环节，以及怎样检查更新后的效果。“保存了一条程序性记忆”与“Agent 已经可靠遵守这条规则”之间，还有应用和验证的过程。

## 同一件事，可以形成不同的记忆

沿用数据库迁移这个例子，可以这样区分：

| 保存的表达 | 更接近的类型 |
| --- | --- |
| 上次迁移时测试替身通过、真实数据库失败，后来如何定位 | 情景：一次经历 |
| 当前测试替身没有覆盖某项数据库约束 | 语义：一条事实 |
| 数据库迁移验证要覆盖真实数据库行为 | 程序性：一条做法 |

这是本文对分类的应用示例，不是要求模型为每次经历机械地产生三条记录。

从经历到事实，再到做法，需要判断证据和适用范围。一次观察还未确认时，可以保留为待验证的经历；不必立刻把它写成长期有效的规则。后来测试方案改变，相关事实和方法也应更新。

所以，这三类更像设计记忆时的三个问题：需要留下事实，还是案例，还是以后执行的方法？它们不是按重要程度排列的三个等级。

## 谁负责总结？框架默认做了多少

“支持 memory”可能指保存历史，也可能指提炼长期信息。具体接入时，最好逐项确认。

| 能力 | 主要执行者 | 开发者需要接入什么 |
| --- | --- | --- |
| 保存和恢复会话状态 | LangGraph checkpointer | 存储后端与 thread 标识 |
| 压缩长对话 | 配置的总结模型 | 总结中间件与触发条件 |
| 保存、更新、检索跨会话记录 | Store 与工具代码 | namespace、数据结构、读写流程 |
| 从交互中提炼长期信息 | 主模型或独立记忆处理模型 | 提炼指引、输入与执行时机 |
| 将召回内容用于回答 | Agent 与上下文构造流程 | 工具结果或提示注入 |

LangMem 有现成组件，不需要从零实现所有操作。但三种内容类型首先是设计框架，不是创建一个普通 Agent 后就默认启用的三套自动记忆系统。

### Hot path：主 Agent 边工作边保存

[LangMem Hot Path 示例](https://langchain-ai.github.io/langmem/hot_path_quickstart/)把记忆管理工具交给 Agent。模型判断哪些内容值得保存，生成工具参数；工具完成实际写入。

```text
用户说出值得记住的信息
        ↓
主模型判断内容与保存方式
        ↓
调用记忆管理工具
        ↓
更新 Store，继续回答
```

这里的写入位于当前请求路径内。它能及时记录明确反馈，但也会增加主 Agent 的工作和请求耗时。

用户说“记住我熟悉 Go”，不代表所有模型都一定正确执行了保存。检查时应查看 Store 中是否出现了预期内容，而不只看最终回复有没有“我记住了”。

### Background：独立流程提炼和整合

[LangMem Background 示例](https://langchain-ai.github.io/langmem/background_quickstart/)使用 `create_memory_store_manager` 从消息中提炼、整合记忆。应用把选定的对话交给这个处理流程，可以安排在后台执行。

```text
会话记录 → 记忆处理模型 → 提炼与整合 → Store
```

需要注意，创建 manager 本身不等于启动了一个监听所有会话的服务。应用仍需把消息提交给它，并决定何时执行。

“使用 async 函数”也不自动意味着用户请求不会等待：如果当前请求直接 await 整个提炼过程，它仍处在这次请求的完成路径上。是否真正脱离主请求，要看应用如何调度。

两种方式可以组合。例如，明确要求立即记住的信息走主流程，较长对话中的经验在后台整理。选择依据是对及时性、响应时间和处理成本的要求。

## 用向量检索召回记忆，是不是 RAG

**是。检索记忆，再把结果交给模型辅助回答，就是一个 RAG 流程。**

[LangChain 的 Retrieval 文档](https://docs.langchain.com/oss/python/deepagents/retrieval)将 RAG 描述为检索与生成的结合。检索对象可以是文档、数据库记录，也可以是此前保存的记忆。

下面只是展示 Store 调用的区别，假定 `store` 与用户范围 `namespace` 已建立：

```python
# 在这个 namespace 下取最多 20 条。
# 没有提供当前问题，不是在按问题的语义相关性排序。
items = store.search(namespace, limit=20)
```

若 Store 已配置 embedding 索引，可以加入查询：

```python
# 按查询的语义相似度取最多 3 条候选。
items = store.search(
    namespace,
    query="用户的编程背景和解释偏好",
    limit=3,
)
```

这里的 `namespace` 是应用定义的字符串元组，`query` 是开放的自然语言查询，`limit` 是本次示例显式指定的结果数量上限；20 和 3 都不是记忆类型的固定规则。只添加 `query`，不能替代配置 embedding 索引。[Store 使用文档](https://docs.langchain.com/oss/python/langchain/long-term-memory)

当召回结果通过工具输出进入上下文，主模型再依据它回答，就完成了“检索增强生成”。如果主模型自己决定何时调用召回工具，这属于 Agentic RAG 的方式；如果程序在生成前固定执行检索，则更接近两步式 RAG。

但一次 RAG 召回不负责整套记忆生命周期。此前如何提炼、何时修改、怎样删除旧信息，仍是其他流程。反过来，记忆也可以按明确 key 直接读取，或作为小份画像加载，不要求全部存进向量数据库。

还有一个容易漏掉的边界：取最相近的三条，不意味着三条都真正适用。应当继续检查内容与当前任务是否相关、事实是否过期，而不是把检索排序当作真实性判断。

## 判断记忆有没有工作，要分别看四件事

对“我熟悉 Go，刚开始学 React”这条信息，可以设计一个简单验证过程：

1. 在会话 A 表达背景，检查实际存储内容。
2. 开启不携带 A 消息历史的会话 B，检查能否召回。
3. 提问 React 概念，观察是否正确采用背景作解释。
4. 更正背景或删除记录，检查后续行为是否相应变化。

这四步分别检查写入、跨会话读取、正确使用和维护。若需要重启持久化，再加一次进程重启验证；若有多个用户，还应检查用户之间的隔离。

同样，一份摘要保存成功，只能证明摘要存在；向量搜索返回结果，只能证明检索找到候选；回答提到用户偏好，也不一定说明行为真的符合偏好。

读 LangChain 的 memory 定义时，记住两组词就够了：**会话内与跨会话，事实、经历与做法。** 真正实现时，再把提炼、保存、召回和维护连接起来。这时你就能判断某个组件究竟提供了哪一段能力，而不会只停留在“它支持记忆”这个笼统描述上。

## 官方资料

- [Memory overview](https://docs.langchain.com/oss/python/concepts/memory)：短期／长期与三种内容性质。
- [Short-term memory](https://docs.langchain.com/oss/python/langchain/short-term-memory)：会话状态、checkpointer 与总结中间件。
- [Long-term memory](https://docs.langchain.com/oss/python/langchain/long-term-memory)：Store、namespace、读写和搜索。
- [LangMem Introduction](https://langchain-ai.github.io/langmem/)：记忆提炼、工具与提示优化能力。
- [Extract Semantic Memories](https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/)：事实记忆的结构化提炼。
- [Extract Episodic Memories](https://langchain-ai.github.io/langmem/guides/extract_episodic_memories/)：经历的表示与提炼。
- [Hot Path Quickstart](https://langchain-ai.github.io/langmem/hot_path_quickstart/)：Agent 使用工具主动管理记忆。
- [Background Quickstart](https://langchain-ai.github.io/langmem/background_quickstart/)：单独处理对话并整合记忆。
- [Retrieval](https://docs.langchain.com/oss/python/deepagents/retrieval)：RAG 与 Agentic RAG 的实现关系。
