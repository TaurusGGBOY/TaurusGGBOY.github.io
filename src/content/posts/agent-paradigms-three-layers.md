---
title: "Anthropic 与 LangChain 如何定义多 Agent：模式异同与三棵选型决策树"
published: 2026-08-28
updated: 2026-09-09
description: "对齐 Anthropic 与 LangChain 的多 Agent 定义，比较双方五种模式、解释分类差异，并用三棵决策树判断是否需要多 Agent、如何选协作模式和应用编排。"
tags: ["ai-agent", "multi-agent", "anthropic", "langchain", "langgraph", "coordination", "agent-architecture"]
category: "AI / Architecture"
draft: false
image: ""
---

同样叫 multi-agent，Anthropic 列出 Generator-verifier、Orchestrator-subagent、Agent teams、Message bus、Shared state；LangChain 列出 Subagents、Handoffs、Skills、Router、Custom workflow。两边都有五项，名称却只在子 Agent 上明显相遇。更容易让人困惑的是：LangChain 的 Skills 明明可以只有一个 Agent，为什么也出现在多 Agent 文档里？

**两套分类关注不同的问题。Anthropic 这组文章先用独立上下文界定多 Agent，再讨论执行者如何协作；LangChain 当前文档把专业能力怎样组合、上下文怎样提供、控制权怎样转移放在一起讨论，覆盖了单 Agent 的替代方案。** 理解这个差别，才能把两边的模式组合起来选型。

本文沿用文档升级案例：接口字段变了，Python、Java、Go 指南和示例需要同步更新。先对齐定义，再介绍双方模式、比较异同与差异成因，最后用三棵决策树选择起点。官方资料核对日期为 **2026 年 9 月 9 日**；案例、模式映射和决策树是本文的工程整理。

## 一、双方分别怎样定义 multi-agent

### Anthropic：多个实例，各有上下文，由代码协调

Anthropic 在 2026 年 1 月 23 日的 [Building multi-agent systems: When and how to use them](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) 中给出了明确的架构定义：多个 LLM 实例分别运行在独立的会话上下文中，通过代码协调，各自承担任务的一部分。

这里有三个观察点：**执行实例、会话边界、协调机制**。同一个模型可以被调用成多个 Agent；不需要分别购买三个不同品牌的模型。反过来，在同一段对话里连续要求模型“先当研究员，再当编辑”，没有因此建立独立的会话上下文。

独立上下文也不要求每个 Agent 都有独立的操作系统进程，更不等于文件或权限已经隔离。应用可以在同一进程内维护多份消息历史，也可以让不同 Agent 访问同一份资料库。上下文、进程、存储和权限是不同边界，需要分别描述。

这与 Anthropic 2024 年的 [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) 还要分开读。那篇用控制流区分 workflow 与 agent：前者主要沿预定义代码路径推进，后者由模型动态决定过程与工具使用；其中五种 workflow 是 Prompt chaining、Routing、Parallelization、Orchestrator-workers、Evaluator-optimizer。**它们不是本文后面介绍的五种多 Agent 协调模式。** 一个 workflow 可以包含多个 Agent，一个 Agent 也可以在内部循环很多次。

### LangChain：围绕专业组件协作，也讨论何时保留单 Agent

LangChain 当前 [Multi-agent 总览](https://docs.langchain.com/oss/python/langchain/multi-agent/index) 将多 Agent 系统描述为协调专业化组件来处理复杂工作流，并立即指出：配置合适工具和提示词的单 Agent，往往也能取得类似结果。

文档从开发者的需求出发，列出上下文管理、不同团队独立开发能力、并行执行三类动机。它因此把“启动多个执行者”和“给同一个执行者按需提供专业知识”放进同一组选项。后者正是 Skills。

这影响我们怎样读它的目录：**被列在 multi-agent 章节里，不代表每种实现都会产生多个独立 Agent。** Skills 明确保持单 Agent 控制；Handoffs 既能在多个 Agent 之间交接，也能让同一个 Agent 随状态改变提示词和工具；Custom workflow 的节点则可能只是普通函数。

| 对齐维度 | Anthropic 本文所引用的定义与协调文章 | LangChain 当前 multi-agent 文档 |
| --- | --- | --- |
| 定义的着眼点 | 多个 LLM 实例、独立会话上下文、代码协调 | 专业组件协作，以及满足相关需求的编排方式 |
| 分类主要回答 | 多个执行者怎样交付、通信和持续工作 | 能力怎样加载、谁控制下一步、用户与谁交互 |
| 单 Agent 放在哪里 | 先评估是否已经足够 | 也列入候选方案，如 Skills 和单 Agent Handoffs |
| 是否要求不同模型 | 独立实例可以使用同一模型 | 模式也不以模型品牌或种类区分 |
| 选型时必须补问 | 成员活多久，发现怎样流动，谁验收 | 是否另开上下文，是否交接控制权，状态怎样延续 |

## 二、Anthropic 的五种协调模式

2026 年 4 月 10 日，Cara Phillips 在 [Multi-agent coordination patterns: Five approaches and when to use them](https://claude.com/blog/multi-agent-coordination-patterns) 中介绍了五种模式。它们分别突出验证反馈、层级委派、持续成员、事件通信和共同资料，可以组合使用。


### 1. Generator-verifier：让拒绝结果能推动下一次修改

这一模式由生成者提交产物，验证者按标准检查；未通过时，把反馈送回生成者修订。原文把它用于评价标准明确、错误代价较高的交付。[Generator-verifier 原文](https://claude.com/blog/multi-agent-coordination-patterns)

![Generator 生成草稿后交给 Verifier；Verifier 依据标准和来源材料检查，通过后交付，未通过则反馈修订，达到上限或证据无法补足时升级处理](/images/posts/agent-paradigms-three-layers/generator-verifier.svg)

*图 1：实线表示提交与验收，虚线表示带反馈修订。停止分支是本例设计的兜底处理。*

#### 验证者必须拿到哪些东西

在文档更新任务里，Generator 读接口变更，写出新的使用指南。Verifier 如果只看到这份指南，最多能检查语言是否通顺、前后有没有矛盾。要判断字段和行为是否正确，它还需要接口定义、目标版本和验收要求。

例如，接口把分页参数从页码改成了游标。可以把验收要求拆到可检查的位置：请求示例有没有继续传旧参数，响应示例有没有解释下一页游标，终止翻页的条件有没有写清楚。

这样，验证失败时就能给出具体反馈：“示例仍然发送旧分页参数，与本次接口定义不一致，请同时更新请求示例和分页说明。”生成者知道该改什么，也能知道改动有没有覆盖问题。

“再详细一点”则没有这种作用。生成者可以增加三段解释，却完全保留那个错误参数。

#### 为什么会出现反复修改却没有进展

考虑另一种情况：接口定义只写了字段类型，没有交代游标是否会过期。Verifier 要求补充有效期，Generator 从现有资料里找不到答案，下一轮就可能改成更含糊的说法。Verifier 再次拒绝，循环继续。

这里缺的是事实来源。继续生成无法补齐事实，流程需要转入补查或人工确认。为这个例子设计停止规则时，我会区分“可以靠修订解决”和“需要新增证据”两类拒绝，并给修订设置上限。

还要把验证标准中的两种能力分开：字段名、链接有效性等项目可以交给程序检查；解释是否覆盖用户问题，则需要结合语义判断。没有必要让验证 Agent 重新猜测一个工具已经能够确定的结果。

这一模式适合解决**已有产物怎样被可靠验收**。如果任务本身还没有拆清楚，或者正确答案也缺乏可用依据，多放一个验证者并不会自动建立标准。

### 2. Orchestrator-subagent：把探索限制在可交付的子任务内

原文中的主 Agent 负责计划、委派和综合；子 Agent 承担范围明确的工作，返回结果。这种结构适合能够拆出清楚边界的任务。[Orchestrator-subagent 原文](https://claude.com/blog/multi-agent-coordination-patterns)

![Orchestrator 向接口字段、示例代码和文档链接三个子 Agent 委派任务并接收回报，同时自己处理编辑和整体验证](/images/posts/agent-paradigms-three-layers/orchestrator-subagent.svg)

*图 2：双向箭头表示任务下发与结果回报。子 Agent 有自己的上下文，主 Agent 仍承担整体交付。*

文档更新开始时，主 Agent 可以自己修改指南，同时把几个调查交出去：哪些页面引用了旧字段，哪些示例仍使用旧参数，哪些链接指向已删除的章节。这些调查过程可能很长，最后需要返回的结果却很短。

比如“查旧字段引用”可以交付一张表：文档路径、出现位置、上下文含义、是否需要修改。主 Agent 不必把每次搜索命中都放进自己的对话，只需要读这张表并核查关键位置。

为了让这个交付成立，任务说明应包含搜索范围和目标版本。“查一下分页相关内容”太宽泛；“检查开发指南中旧页码参数的使用位置，区分历史说明与需要迁移的现行示例”，才让调查者知道什么算完成。

#### 汇总者也会成为信息瓶颈

假设检查接口的子 Agent 发现，游标只适用于新的列表接口；检查示例的子 Agent 却已经把所有分页示例改成游标。两项任务最初看似独立，执行中出现了新的依赖。

如果第一份结果只返回“分页方式有变化”，主 Agent 就很难把影响范围准确转给第二个子 Agent。在这个例子中，我会要求结果保留“受影响接口列表”和原始定义位置，让汇总时能够看出另一项任务的前提已经失效。

遇到大量这样的交叉依赖，应当重新检查拆分方式。可以把同一个接口的定义、示例和迁移说明放进同一项任务，让相关上下文由同一个执行者持有。按“搜索、写作、检查”分工未必比按内容边界分工更好。

#### 子任务结束和总任务结束是两回事

“旧字段扫描完成”不能直接证明文档升级完成。主 Agent 还要检查修改是否落地、示例是否通过验证、各语言指南是否一致。子 Agent 的完成状态应指向一份结果或产物，整体结束则要对照用户的完整要求。

这种结构适合一次委派后能交出明确结果的工作。是否能节省等待时间，还取决于运行时有没有实际并行执行：三个独立子任务如果按顺序启动，结构上有多个 Agent，时间上仍然是串行的。

### 3. Agent teams：让成员跨多个任务保留上下文

原文用持续工作的成员和共享任务队列描述 Agent teams。相较于一次性子任务，成员会继续承担后续工作，保留对负责领域的认识。[Agent teams 原文](https://claude.com/blog/multi-agent-coordination-patterns)

![Coordinator 通过共享任务队列组织 Python、Java、Go 三个 Teammate，各成员完成一个任务后继续处理下一个任务并保留上下文](/images/posts/agent-paradigms-three-layers/agent-teams.svg)

*图 3：关注成员的生命周期。图中省略成员间消息，具体产品可以支持直接通信。*

如果文档升级持续涉及多个章节，可以让三个成员分别负责 Python、Java、Go。负责 Python 的成员先调整快速开始，再处理异步调用，随后核查异常处理。前一项任务里弄清楚的客户端初始化方式，在后续任务中仍然有用。

对这个例子来说，是否采用 teams，关键看这种上下文能否复用。如果每项任务只是对单个页面做一次链接检查，保留长期成员带来的收益就不明显。如果每一项都要反复理解同一套客户端约定，持续工作的成员更容易保持一致的处理口径。

#### 共享任务队列不等于共享文件的编辑权

队列至少要让成员知道：哪个任务尚未领取，哪个正在处理，哪个已经完成。但“领取了 Python 指南”仍然没有回答一个细节：如果升级需要修改三种语言共用的导航文件，谁来修改？

我会在这个例子里把共享导航单独交给一个所有者。各语言成员返回需要新增或删除的入口，导航所有者统一修改。这样可以避免三名成员根据各自看到的旧版本覆盖同一份文件。

任务边界也不必完全按目录划分。公共术语表、示例运行环境和版本切换配置都可能跨目录存在，需要把这些共享资源一起纳入分工。

#### 成员还活着，和任务已经做完，不能混用

长任务会出现部分完成：Python 已经交付，Java 卡在依赖下载，Go 的示例还在验证。协调者需要知道 Java 是“仍在执行”还是“没有继续推进的条件”，才能决定等待、补充资源或调整安排。

在本例中，任务状态应关联产物和验证结果。一个成员发来“完成了”，还应能找到它负责的修改、验证输出和未处理事项。最后再运行跨语言的一致性检查，才能确认三个局部结果组成了完整交付。

还需要区分文章中的抽象模式与具体产品。Claude Code 的官方文档明确支持 teammates 直接通信，也支持通过共享任务列表领取工作；所以不能把“teams 适合相对独立的分区”理解成“成员不允许互相发消息”。[Claude Code Agent teams 文档](https://code.claude.com/docs/en/agent-teams)

### 4. Message bus：让新事件找到合适的处理者

Message bus 用发布、订阅和路由连接 Agent。处理者订阅自己关心的主题，事件触发相应工作。[Message bus 原文](https://claude.com/blog/multi-agent-coordination-patterns)

![接口变更事件发布到消息总线后投递给内容 Agent，内容 Agent 发布草稿更新事件，总线再投递给校验 Agent，后者产生校验结果事件](/images/posts/agent-paradigms-three-layers/message-bus.svg)

*图 4：事件名是本文示例约定，不是某个框架的内置 API。箭头区分发布与投递。*

前面的任务都有一个明确起点：“把文档更新到新版本。”如果系统要长期响应变化，入口就会变多：接口定义更新、示例测试失败、用户报告文档问题、翻译材料发生变化，都可能触发后续处理。

在一个自拟实现里，接口变更产生 `api.changed` 事件，内容 Agent 订阅它并更新草稿，随后发布 `draft.updated`。校验 Agent 收到草稿更新后检查结果，再产生 `validation.completed`。增加一种新的内容检查时，可以增加订阅者，保持既有事件含义稳定。

总线负责把事情送到合适的处理者，但业务是否完成，需要另外判断。一条消息已经投递，并不等于文档已经写好；文档已经写好，也不等于校验通过。

#### 先追踪事件，再追踪一次业务任务

调试时会遇到一个典型问题：用户问“这次接口更新为什么没有同步到指南”，系统中却有很多次内容更新与校验记录。仅凭 Agent 名称，无法知道哪些记录属于同一次变更。

下面这组字段是本例的设计约定：

| 信息 | 在这个例子里解决什么问题 |
| --- | --- |
| 任务标识 | 把接口变更、草稿修改和校验关联起来 |
| 事件标识与前序事件 | 说明哪次处理触发了后续工作 |
| 文档版本 | 防止旧草稿的校验结果被当成新版结果 |
| 产物位置与处理状态 | 区分消息已接收、内容已产生和任务已完成 |

这些信息能帮助回答“卡在哪一步”。如果校验没有发生，应能区分没有产生事件、事件没有匹配订阅者、处理失败，以及结果属于旧版本。

#### 重复事件会把一次动作执行两遍

采用消息系统还要检查它的投递语义。例如，Amazon SQS 标准队列采用至少一次投递，官方文档要求应用按幂等方式处理可能重复的消息。[SQS 至少一次投递说明](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html)

放到文档例子里，同一个变更事件重试后再次到达，可能生成两份相互覆盖的草稿。可以让处理记录关联事件与目标文档版本：同一版本已经成功处理过时，重复消息复用已有结果；目标版本已经变化时，旧事件不能覆盖新产物。具体做法要与实际消息中间件和写入方式一起设计。

因此，消息总线更适合处理者会增加、触发路径会随事件变化的系统。若只是一个负责人固定委派几个检查，引入主题、重试、订阅和关联日志，会增加额外的维护工作。

### 5. Shared state：让发现进入共同维护的资料库

Shared state 让 Agent 通过共同读写持久化存储协作，其他成员可以基于已有发现继续工作。[Shared state 原文](https://claude.com/blog/multi-agent-coordination-patterns)

![接口、示例、迁移和资料四个 Agent 直接读写共享状态库，库中保存事实、来源、版本和待验证项，并设置独立的停止条件](/images/posts/agent-paradigms-three-layers/shared-state.svg)

*图 5：箭头表示读取与写回。中间是持久化资料库，没有在图中设置负责转述所有发现的主 Agent。*

文档升级最难的部分，可能不是修改已知字段，而是查清一项变化究竟影响哪些使用方式。接口 Agent 发现旧参数被删除，示例 Agent 验证出某个旧用法仍能工作，迁移 Agent 又发现这是服务端保留的兼容入口。几份发现之间有相互解释的关系。

在共享状态的设计里，它们可以写进同一个问题条目：删除了什么，在哪个版本验证过，兼容入口有什么限制，哪些说法尚待确认。后续调查读取整个条目，再决定需要补什么证据。

这里需要共享的是能改变判断的事实。把每个 Agent 的整段对话都写进公共文档，会让后来者重新筛选大量尝试过程。对这个例子，我会保留结论、适用条件、来源和未解决问题；个人探索记录放在各自的执行日志中。

#### 同一份资料里，要区分事实和推测

假设示例 Agent 只验证了一个旧参数仍然有效，却写下“旧版全部兼容”。迁移 Agent 基于这条记录删除了升级提醒，资料库就会把一个过度概括传播到后续任务。

本例中的记录因此需要保留验证范围。“在某个接口、某个目标版本下验证成功”能让其他 Agent 决定是否继续查；“全部兼容”会隐藏尚未验证的部分。共享得更快，也要求每条共享信息把边界交代清楚。

#### 并发写入和研究不收敛，是两种问题

两个 Agent 同时更新一个条目，可能互相覆盖修改。这属于存储一致性问题，可以根据实现选择分区写入、版本检查或事务。数据库能保证什么也要具体看配置：例如 PostgreSQL 的 Serializable 隔离仍要求应用处理序列化失败并重试事务。[PostgreSQL 事务隔离文档](https://www.postgresql.org/docs/current/transaction-iso.html)

另一个问题发生在内容上：A 补充一条解释，B 把它换一种说法写回，A 又把 B 的话扩展成新段落。写入都成功了，资料却没有增加新的证据。数据库锁解决不了这种循环。

为这个例子定义结束条件时，我会回到交付要求：关键接口的变化已经有证据，矛盾已经解决或明确列出，迁移说明覆盖了目标用户。预算耗尽时则保存当前结果和缺口。单看“还有没有 Agent 在写东西”，无法判断任务是否在接近完成。

共享存储还不等于整套系统自动消除了单点故障。去掉负责中转发现的主 Agent 后，资料库、访问权限和存储服务仍然要保证可用。持久化让某个 Agent 退出后，其发现有机会被接着使用；基础设施怎样恢复，需要单独设计。

## 三、LangChain 的五种编排方式

继续使用同一个文档升级项目。这里要决定的是：把专业能力接到应用的哪个位置，谁负责下一步，以及哪些材料进入哪份上下文。

### 1. Subagents：主 Agent 把专家作为工具调用

[Subagents 文档](https://docs.langchain.com/oss/python/langchain/multi-agent/subagents)描述的主 Agent，也叫 supervisor，决定调用哪个子 Agent、给它什么输入、怎样组合结果。主 Agent 可以自己使用工具和完成工作。

文档升级时，主 Agent 把“检查 Python 示例里的旧分页参数”交给专家，只收回路径、问题和证据。这与 Anthropic 的 Orchestrator-subagent 最接近：探索在子上下文里进行，总体交付仍由主 Agent 掌握。

LangChain 默认让每次子调用使用新的状态；但当前文档也提供跨调用保留子 Agent 历史的 continuations 方式。因此，“Subagents 默认无状态”不能扩大成“LangChain 的子 Agent 永远无法保留状态”。保留历史以后，任务队列、持续成员身份与完成检测仍要另行设计，它不会仅凭记住对话就自动变成完整的 Agent teams。

### 2. Handoffs：根据状态改变当前处理者或能力

[Handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs)通过工具更新 `current_step`、`active_agent` 等状态，随后调整当前 Agent 的配置，或把控制权路由给另一个 Agent。它适合阶段约束和跨轮对话。

例如，文档助手需要先向用户确认目标 SDK 版本，确认后才进入相应语言的迁移指导。采用单 Agent 方案时，只切换它的提示词和工具；采用多 Agent 子图时，则切换到独立实现的专家。LangChain 当前文档建议多数 handoff 场景先用前一种较简单的实现。

它与 Subagents 的区别落在对话控制上：Subagents 通常把调查结果交回主 Agent；Handoffs 可以让当前专家继续直接回应用户。**一次“移交给 Python 专家”也不能说明系统已经并行运行了一支团队。**

### 3. Skills：同一个 Agent 按需读取专业知识

[Skills](https://docs.langchain.com/oss/python/langchain/multi-agent/skills)把专业提示、知识以及关联资源组织成可按需加载的能力。文档升级助手可以先只看到三种语言规范的简介，真正编辑 Python 指南时，再读取 Python 规范。

全过程仍由同一个 Agent 控制。Skills 减少了预先塞入全部资料的需要，但加载后的内容会进入当前上下文；它不会自动提供另一个独立的探索窗口。若 Python 调查产生大量只对本次子任务有用的记录，Subagents 更容易把这些记录留在子上下文中。

所以二者也可以组合：每个语言子 Agent 内部再加载自己的 Skills。**Skills 管理知识如何进入执行者；Subagents 管理工作如何交给另一个执行者。**

### 4. Router：先分类，再分发到一个或多个领域

[Router](https://docs.langchain.com/oss/python/langchain/multi-agent/router)使用专门的路由步骤，把输入分发到适合的 Agent，再汇总结果。路由可以由模型完成，也可以使用规则。

如果变更清单已经注明哪些语言受影响，就可以先路由到相应处理者；同时涉及 Python 和 Java 时，可以扇出调用。若调查途中需要依据新发现不断安排后续任务，维护对话上下文的 supervisor 更适合作为持续决策者。

这是默认形态的差别。Router 文档也讨论了有状态路由，或把无状态 router 包装成对话 Agent 的工具。选型应说明实际实现，不能把“通常是一次分类”写成“只能调用一次模型”。

### 5. Custom workflow：用图明确控制步骤与分支

[Custom workflow](https://docs.langchain.com/oss/python/langchain/multi-agent/custom-workflow)允许用 LangGraph 混合顺序、分支、循环、并行与 Agent 行为。一个节点可以是普通函数、一次模型调用，也可以是完整的 Agent 或多 Agent 子系统。

文档升级可以先由程序读取版本差异，再调 Agent 修改指南，接着运行示例测试；失败时进入修订分支，满足验收要求后结束。这里的程序测试节点不需要被命名为“测试 Agent”。

Custom workflow 是组合其他模式的实现入口。因此，它可以承载 Generator-verifier，也可以承载 Subagents 或 Router；图里有共享 state，也仍然需要检查实际控制流，才能知道它是哪种协调结构。

## 四、哪些相似，哪些不能直接对应

### 共同点：都把上下文和实际收益放在角色名称之前

两边都支持从较简单的方案开始，也都关心专业化、上下文管理和并行的价值。把三种语言的全部资料塞进同一段历史，可能带来无关信息；为每个小操作新增 Agent，又会增加调用、交接和汇总。这正是两套文档都要解决的取舍。

更合适的任务边界往往是“理解并更新 Python 指南”，而非机械拆成“搜索员、阅读员、写作员”。前一种分法让高度相关的材料留在一起；后一种分法可能让每一步都重新解释目标。最终是否受益，需要用实际任务验证。

### 模式映射：有最接近的实现，没有整齐的一一配对

| Anthropic 模式 | 在 LangChain / LangGraph 中较接近的表达 | 对应到哪里，差别又在哪里 |
| --- | --- | --- |
| Generator-verifier | Custom workflow 中的生成—验证循环；验证者也可作为 subagent | 前者命名质量反馈关系，后者提供调用和循环的组织方式 |
| Orchestrator-subagent | Subagents / supervisor | 都是主 Agent 委派并综合；具体子状态、并行和恢复方式取决于实现 |
| Agent teams | 持久化子 Agent 或子图，加任务调度与成员管理 | 保存历史只是其中一项；持续成员、任务领取和完成检测还需设计 |
| Message bus | 事件接入加路由、Agent 或自定义工作流 | Router 负责分类分发；总线还涉及发布订阅、事件生命周期与投递语义 |
| Shared state | 共同存储加多个自主执行者 | LangGraph state 只是状态机制；由中央图调度节点，仍不等于去中心化协调 |

这张表是实现层面的对应分析，不表示 LangChain 为右列所有组合提供了同名、开箱即用的产品。

### 三组同名附近的陷阱

**Router 与 Message bus 都有“路由”，但关注的时间范围不同。** 前者可以完成一次请求的分类、扇出与汇总；后者要组织不断到来的事件和不断增加的订阅者。一个函数返回 `python_agent`，还没有建立消息总线。

**LangGraph state 与 Anthropic Shared state 都能共享信息，但控制者可能不同。** Anthropic 这篇模式文章的 Shared state 明确描述：多个 Agent 自主读取共同存储并写回发现，没有负责中转全部信息的中央协调者。LangGraph 图中的节点却可以严格由边和调度规则驱动。共享同一个字典，不能独自决定协作拓扑。

**Handoffs 与 Agent teams 都涉及多个角色，但前者看控制权，后者看成员生命周期。** 用户从通用助手切换到 Python 专家，是 handoff；Python、Java、Go 成员持续领取各自任务，是 teams。它们可以组合，也可以各自存在。

## 五、为什么会出现这些差异

### 1. 文章的起点不同

Anthropic 五种协调模式文章在开头就说明，读者已经判断需要多 Agent，接下来要选协作结构。它于是比较：短期子任务还是持续成员，负责人中转还是事件通知，工作成果怎样积累。

LangChain 总览则从“开发者说需要 multi-agent 时，究竟想获得什么能力”展开。一个团队可能只是想让多个业务组独立维护专业知识，这用 Skills 就能满足。把 Skills 放进目录，是对选型问题范围的扩展；读者不能反过来把每份 skill 都算成一个 Agent。

### 2. 分类轴不同，模式就会交叉

Anthropic 这五项也并非同一层级的互斥拓扑：Generator-verifier 关注验收关系，Agent teams 关注生命周期，Message bus 和 Shared state 关注信息传播方式。LangChain 同样把上下文加载、控制权转移和自定义执行图放在同一张选择表里。

因此，一套系统可以同时是“持续存在的语言团队”“用共享资料库交流发现”“最终经过生成—验证循环”，实现时又采用“LangGraph 工作流里的有状态子 Agent”。出现多个标签，可能只是从不同角度描述同一个系统。

### 3. 各自要帮助读者完成的设计工作不同

从材料内容看，Anthropic 协调文章更像系统设计评审：信息瓶颈、成员退出、并发写入、研究不收敛该怎样处理。LangChain 文档更靠近应用搭建：主 Agent 如何调用工具、状态如何切换能力、节点怎样组合。

**我的理解是，前者更强调协作的运行语义，后者更强调开发者可组合的实现方式。** 这是对所引用材料的分析，并非两家公司对彼此路线的官方解释。不能据此推导“Anthropic 只关心研究”或“LangChain 不关心长期协作”；双方的产品和文档都覆盖更广的范围。

### 4. 文档版本也会改变看起来的分歧

Anthropic 2024 年的 workflow 分类、2026 年 1 月的多 Agent 定义、4 月的协调模式，回答的是相邻但不同的问题。LangChain 的在线文档也持续更新，当前已明确写出单 Agent Handoffs，以及 Subagents 的跨调用持久化选项。

比较时应固定材料和日期，再核对具体能力。用某篇旧教程里的“双模式分类”，去反驳当前的五项选择表，会把版本差异误读成概念冲突。

## 六、决策树一：先判断是否需要多个 Agent

下面三棵树都是本文根据官方机制整理的选型工具；按当前主要瓶颈选择起点，多个条件成立时可以组合。叶子节点表示值得验证的候选方案。

~~~text
已有方案能否满足准确性、覆盖范围、耗时和成本要求？
├─ 能 → 保留当前方案
└─ 不能 → 先定位失败原因
   ├─ 资料缺失、工具返回错误、目标不明确
   │  → 先补数据、修工具或明确验收要求
   ├─ 只是步骤固定、需要可靠的前后约束
   │  → 普通代码 / workflow；节点数量不等于 Agent 数量
   ├─ 只是知识或工具太多，按需加载就能解决
   │  → 单 Agent + Skills / 动态工具配置
   └─ 确实需要独立探索上下文、专业执行者或并行覆盖
      ├─ 子任务必须反复共享大量中间细节
      │  → 先调整拆分；拆不开时保留单 Agent 或紧密工作流
      └─ 子任务能靠明确输入与成果衔接
         → 试验多 Agent，再进入下面两棵树
~~~

例如，“查不到新版接口定义”是来源问题，增加三个写作者不会补齐来源。“扫描三套独立 SDK，并给出可核查清单”则有清楚的上下文边界，值得比较子 Agent 方案。

## 七、决策树二：按 Anthropic 的协作需求选模式

![Anthropic 协调模式选型：从单 Agent 是否足够开始，按验收、共享发现、事件触发、任务边界与成员上下文持续性选择模式](/images/posts/agent-paradigms-three-layers/selection-decision-tree.svg)

*这张树按主要问题选择协作结构；验证层、消息层和共享资料可以叠加。分支顺序是本文的阅读安排。*

~~~text
已经确认需要多个执行者，主要瓶颈是什么？
├─ 产物需要独立验收，而且有明确标准
│  → Generator-verifier
├─ 多人需要不断利用彼此发现，共同资料驱动后续工作
│  → Shared state；明确结束条件和写入责任
├─ 长期接收事件，处理者和触发路径持续增加
│  → Message bus；明确投递、重试与业务完成的区别
└─ 主要是拆分并交付任务
   ├─ 边界不清、频繁相互等待 → 先重新划分任务
   └─ 边界清楚
      ├─ 一次委派能返回明确成果 → Orchestrator-subagent
      └─ 后续任务反复复用同一成员的领域上下文 → Agent teams
~~~

任务耗时长，不足以单独选择 teams；长期事件流也不等于必须去中心化。决定模式的是信息和责任怎样延续。若共享发现与事件触发同时存在，可以用总线通知“某条资料已更新”，让处理者读取对应版本的共同资料。

## 八、决策树三：按 LangChain 的应用需求选编排

![LangChain 编排选型决策树：依次判断精确流程约束、阶段与对话控制权、按需知识加载、入口分类及持续委派，选择 Custom workflow、Handoffs、Skills、Router 或 Subagents](/images/posts/agent-paradigms-three-layers/langchain-selection-decision-tree.svg)

~~~text
应用当前最需要解决什么？
├─ 必须精确规定分支、循环和程序步骤，标准模式放不下
│  → Custom workflow；内部仍可嵌入以下模式
└─ 标准模式可以表达
   ├─ 行为随阶段改变，或专家需要接手与用户的后续对话
   │  → Handoffs
   │     ├─ 只是提示词和工具切换 → 单 Agent + middleware
   │     └─ 需要不同的专家实现 → 多 Agent 子图
   ├─ 同一个 Agent 只需按需加载专业知识
   │  → Skills；若探索记录仍挤占上下文，再评估 Subagents
   └─ 需要把工作交给独立的专业执行者
      ├─ 入口分类就能确定去哪些领域，再合并结果
      │  → Router；按需求选择单路分发或并行扇出
      └─ 主 Agent 需要结合历史和新结果，持续决定委派
         → Subagents / supervisor
~~~

选择 Handoffs 的理由应是状态与交互关系；选择 Skills 的理由应是按需专业化；选择 Router 的理由应是入口分流；选择 Subagents 的理由应是持续委派与上下文隔离。业务先后条件需要由代码约束时，可以把所选模式嵌进 Custom workflow。

## 九、把两棵模式树用在同一个文档升级项目里

先限定一次发布：三个语言 SDK、明确的目标版本、一套需要通过的示例测试。一次性扫描能交回结果，所以协作结构先选 **Orchestrator-subagent**；主 Agent 会根据扫描结果继续安排补查，因此 LangChain 一侧先选 **Subagents**。

每个语言专家按需加载自己的编写规范，这是子 Agent 内部的 **Skills**。主 Agent 汇总修改后，程序运行示例测试，再由验证者核对迁移说明是否覆盖接口变化；用 **Custom workflow** 把生成、运行测试、语义验证和必要的修订连起来，就承载了 **Generator-verifier**。

这套设计不必一次引入全部模式。只有后续出现具体需求，才沿另一条分支变化：

| 新出现的需求 | 协调结构怎样变化 | 应用实现需要补什么 |
| --- | --- | --- |
| 每种语言要连续维护多轮升级，领域上下文能反复复用 | 考虑 Agent teams | 成员身份、子状态延续、任务领取、退出后的任务归属 |
| 用户要和 Java 专家连续确认兼容行为 | 增加面向用户的交接 | Handoffs，以及交接时传入哪些已确认信息 |
| 变更单已经标清语言，入口即可决定分工 | 使用轻量分发即可 | Router，必要时并行扇出再汇总 |
| 系统持续接收接口、测试和用户反馈事件 | 考虑 Message bus | 发布订阅、事件关联、失败重试；Router 只承担其中的分类 |
| 专家发现会持续改变其他专家的调查方向 | 加入共同事实记录；必要时采用 Shared state 协调 | 来源、适用版本、待确认状态、写入冲突和收敛条件 |

这也说明为什么不能把最终问题写成“选 Anthropic，还是选 LangChain”。**协作模式、框架和模型是三项不同决定。** 可以用 LangChain / LangGraph 实现 Anthropic 描述的协调模式，也可以选择其他运行时；采用哪种模型，需要另看任务效果、工具支持和运行约束。框架层的进一步取舍见站内 [《2026 年你为什么选 LangGraph》](/posts/2026-why-langgraph/)。

## 十、用一次对照试验决定是否保留复杂度

选出候选后，用同一批真实任务比较“单 Agent”“单 Agent 加按需能力”“多个独立子 Agent”。尽量固定数据来源、验收标准和预算，记录最终结果正确率、覆盖缺口、总 token、端到端耗时、重复工作与人工返工。

如果多 Agent 只在获得更多搜索次数或更大预算时更好，就需要继续区分：收益来自更多计算，还是来自上下文隔离与专业化。并行减少了某些等待，也可能增加总工作量；模型调用次数少，也可能每次都带着更长的历史。不要用单一调用数替代完整的成本和质量评估。

对文档项目，验收最终应该落到三个成果：旧接口引用是否处理完，示例是否实际通过，迁移说明是否符合目标版本。成员说“已完成”以后，仍要找到对应修改和验证结果。

**先说明哪些执行者需要独立上下文，再说明它们怎样交接工作，最后说明代码怎样实现这套关系。** 这样读 Anthropic 和 LangChain，两套分类就能共同服务于一个可验证的设计。

## 官方资料

- [Anthropic：Building multi-agent systems: When and how to use them](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)，2026-01-23：多 Agent 定义、上下文隔离与适用条件。
- [Anthropic：Multi-agent coordination patterns](https://claude.com/blog/multi-agent-coordination-patterns)，2026-04-10：五种协调模式及演进。
- [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)，2024-12-19 发布、页面持续更新：workflow 与 agent 的控制流区分。
- [Claude Code：Agent teams](https://code.claude.com/docs/en/agent-teams)：产品中的任务列表、成员通信与协作边界。
- [LangChain：Multi-agent 总览](https://docs.langchain.com/oss/python/langchain/multi-agent/index)：问题范围、五项模式及示例比较。
- [Subagents](https://docs.langchain.com/oss/python/langchain/multi-agent/subagents)、[Handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs)、[Skills](https://docs.langchain.com/oss/python/langchain/multi-agent/skills)、[Router](https://docs.langchain.com/oss/python/langchain/multi-agent/router)、[Custom workflow](https://docs.langchain.com/oss/python/langchain/multi-agent/custom-workflow)：具体实现语义与适用条件。
