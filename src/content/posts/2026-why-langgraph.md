---
title: "2026 年你为什么选 LangGraph"
published: 2026-09-02
updated: 2026-09-10
description: "从 LangChain 的 LCEL、create_agent 到 LangGraph 的 StateGraph 与 Functional API，讲清条件分支、状态传递和 checkpoint 的实际边界，再讨论什么时候值得自己编排。"
tags: ["langgraph", "langchain", "ai-agent", "agent-framework", "architecture", "decision-making"]
category: "AI / Architecture"
draft: false
image: "/images/posts/2026-why-langgraph/2026-why-langgraph-cover.png"
imagePosition: "left"
---

老板把需求丢过来：“我们要做一个能查资料、调用工具、自己判断下一步，还能在出错后继续跑的 Agent。LangGraph、CrewAI、AutoGen、OpenAI Agents SDK、Google ADK，选哪个？”

我先问一句：我们要买一个能干活的 Agent，还是要把 Agent 的执行过程嵌进自己的业务系统？这两个问题看起来只差一个名词，交付边界完全不同。

如果任务只是一次问答、一次检索，或者一条稳定的函数调用链，直接使用模型 API 和少量业务代码就够了。如果目标是让编码 Agent 在仓库里改文件、跑测试，Claude Code、Codex、Cursor 或 OpenHands 这样的现成入口应先纳入评估，团队可以直接沿用它们已经装配好的工具和交互边界。

我会在下面这种条件下直接选择 LangGraph：应用已经有自己的执行设计，需要把业务步骤、状态转移和恢复范围交给运行时管理；现成 Agent 循环不能清楚表达它，现有后端也没有承担这些责任。只有长任务、分支、重试或人工审批，还不足以得出这个选择。

LangChain 1.x 的 `create_agent` 本身就运行在 LangGraph 上，能使用持久化、流式输出和人工介入等能力。选型要比较的是：复用现成 Agent 循环，还是自己组织工作流。以下 LangChain / LangGraph 接口说明按 2026-09-10 的官方文档核对；其他框架保留为候选方向，不构成跨框架性能排名。

## LangChain 和 LangGraph：能替代，不等于接口相同

同一个业务往往可以用两者实现。用 LangGraph 重建普通工具调用 Agent，需要维护原本由 `create_agent` 提供的循环行为；用 LangChain 加普通 Python 实现专门流程，则需要自行承担现成接口没有覆盖的编排与恢复逻辑。企业采用某个框架的案例，只能说明一种实现可行，不能证明另一种无法完成。

先把四种入口分开：

| 入口 | 谁定义流程 | 数据与状态 | Checkpoint |
| --- | --- | --- | --- |
| LangChain LCEL：`a \| b \| c` | 用 Runnable 组合顺序、分支和并行 | 前一步输出传给下一步 | 普通 pipeline 不会自动获得工作流断点恢复 |
| LangChain `create_agent` | 工厂构建模型与工具循环，middleware 扩展行为 | 消息与自定义 Agent state | 配置 checkpointer 后使用底层 LangGraph 机制 |
| LangGraph `StateGraph` | 自己注册节点、连接边、定义路由 | 节点返回状态更新，按字段 reducer 合并 | 配置后按图的 superstep 保存检查点 |
| LangGraph Functional API | 用 `@entrypoint`、`@task` 和普通控制流组织 | task 结果由运行时保存，可复用 | 配置后使用同一运行时，无须显式定义图 |

`create_agent` 不是 LCEL pipeline。它内部已经是一张编译好的图。LangChain 也没有另外提供一套等价于 `StateGraph` 的通用业务图构建器；需要任意业务节点和连线时，直接使用 LangGraph。[官方分层说明](https://docs.langchain.com/oss/python/concepts/products) · [Functional API](https://docs.langchain.com/oss/python/langgraph/functional-api)

### edge 和 conditional edge 在 LangChain 中怎么表达

对于简单的顺序与条件逻辑，LCEL 可以用 `|` 和 `RunnableBranch`：

```python
from langchain_core.runnables import RunnableLambda, RunnableBranch

def check_order(order):
    return {**order, "needs_review": order["amount"] > 1000}

def manual_review(order):
    return {**order, "status": "pending_review"}

def auto_approve(order):
    return {**order, "status": "approved"}

workflow = RunnableLambda(check_order) | RunnableBranch(
    (lambda order: order["needs_review"], RunnableLambda(manual_review)),
    RunnableLambda(auto_approve),  # 默认分支
)

result = workflow.invoke({"order_id": "A001", "amount": 1500})
assert result["status"] == "pending_review"
```

`a | b` 表达先执行 a，再把输出交给 b；`RunnableBranch` 执行第一个条件成立的分支，否则执行默认分支。这里的判断完全由代码控制，不需要模型选择工具。示例中的人工审核仅返回待审核状态，没有实现持久化暂停或审批后的恢复。[RunnableSequence](https://reference.langchain.com/python/langchain-core/runnables/base/RunnableSequence) · [RunnableBranch](https://reference.langchain.com/python/langchain-core/runnables/branch/RunnableBranch)

这与 LangGraph 的边在控制逻辑上相似，状态语义却不同。LCEL 中，如果 a 输出 `{"name": "张三"}`，b 只输出 `{"score": 90}`，c 就只收到后者。要保留 name，可以显式返回合并后的字典，或用 `RunnablePassthrough.assign` 增加字段。`StateGraph` 则允许 b 只返回 score 的更新，运行时按已声明状态及 reducer 保留或合并其他字段；同一字段如何更新取决于它的规则。

如果使用 `create_agent`，middleware 可以在模型或工具调用周围更新状态、重试、调整工具与提示，也可以条件跳转。但公开的 `jump_to` 目标是 `model`、`tools` 和 `end`，不能仅写 `jump_to="合同审核"` 就注册并连接任意业务节点。自定义流程可以包住 Agent，也可以把 Agent 作为 LangGraph 的节点。[Middleware 跳转](https://docs.langchain.com/oss/python/langchain/middleware/custom#agent-jumps) · [自定义工作流](https://docs.langchain.com/oss/python/langchain/multi-agent/custom-workflow)

### 没有 create_agent，checkpoint 还能用吗

可以。Checkpoint 属于 LangGraph 运行时，并不要求流程里有 Agent，甚至不要求有模型。

如果只运行普通 LCEL 的 `a | b | c`，没有一个给 pipeline 配上 checkpointer 就自动逐步恢复的通用入口。可以把步骤接入 `StateGraph`，也可以采用不显式建图的 Functional API：

```python
from langgraph.func import entrypoint, task
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command, interrupt

@task
def prepare_document(text):
    return {"text": text.strip(), "status": "prepared"}

@entrypoint(checkpointer=InMemorySaver())
def review_workflow(text):
    document = prepare_document(text).result()
    approved = interrupt({"document": document, "action": "approve"})
    return {**document, "approved": approved}

config = {"configurable": {"thread_id": "review-1"}}
review_workflow.invoke(" 合同草稿 ", config)  # 暂停，等待审核
result = review_workflow.invoke(Command(resume=True), config)
assert result["approved"] is True
```

恢复时 entrypoint 从函数开头重新进入，已保存的 task 结果可以复用；这不是保存 Python 每一行的执行现场。把需要复用的工作划成 task，有别于把整个长流程放在一个普通函数里。示例用内存 checkpointer，只适合演示；进程重启后继续需要持久化后端。[官方 Functional API 示例与恢复语义](https://docs.langchain.com/oss/python/langgraph/functional-api)

对于 `create_agent`，checkpointer 保存的是预构建 Agent 图的状态与进度。若一个工具内部依次执行提取、审核和发布，给外层 Agent 配 checkpointer，不代表这三个内部函数之间自动各有检查点。要控制内部恢复范围，需要拆成运行时认识的执行单元，或自行记录进度。外部写入的幂等性也不会由 checkpoint 自动保证。

### 真正值得比较的是替换后的维护责任

客服让模型查订单、追问、回答，再用 middleware 限制工具与增加审批，可以优先用 `create_agent`。固定的“检索一次 → 分析 → 评审 → 未通过时重新分析”也能用普通 `for` 和 `if` 实现；仅有循环，不足以要求 LangGraph。

当这几个阶段需要各自的运行状态、恢复范围和明确路由，而现有系统没有相应机制时，LangGraph 才可能减少自研。若退款后端已经负责风控、审批和事务，Agent 只调用一个退款接口，就不必在 Agent 层重复实现整条业务流程。

我的判断是：复用现成 Agent 行为时选 LangChain；已经有专门执行设计、需要运行时管理时评估 LangGraph；普通代码或现有工作流足够时保留它们。LangGraph 外层流程与 LangChain 内层 Agent 也可以组合，业务复杂度本身不能决定二选一。

第三方建议可作对照：[Workflow Builder（2026-07-30）](https://www.workflowbuilder.io/blog/langgraph-vs-langchain)强调默认循环是否匹配；[Uvik（2026-09-03 更新）](https://uvik.net/blog/langchain-vs-langgraph/)根据其交付经验反对仅为未来灵活性提前手写图；[Linfield Labs（2026-02-24）](https://linfieldlabs.com/blog/graph-over-chain-part-2.html)也建议先用 `create_agent`。这些是作者的选型建议，不是独立性能实验。尤其“有循环、有记忆、有人审就必须直接用 LangGraph”的清单，不能忽略 LangChain 1.x 已有的能力。

## 先别把 Agent 和 Agent 框架混成一层

“Agent”至少有三种东西。

第一种是模型加工具的循环：模型决定要不要调用工具，工具返回结果，模型再决定下一步。它可以只有几十行代码。

第二种是 Agent 框架或 SDK：它提供 Agent、工具、状态、路由、交接、守卫、会话等构件，让你把循环接进应用。

第三种是已经包装好的 Agent 产品或 harness。它把提示词、工具集、权限、沙箱、上下文压缩和交互界面放在一起，目标是完成一类任务。你使用的是它的边界，而不是从零设计它的运行时。

[Claude Code](https://code.claude.com/docs/en/overview) 面向软件开发；[Codex CLI](https://learn.chatgpt.com/docs/codex/cli) 可以在终端检查、修改和运行代码；[Cursor Agent](https://docs.cursor.com/en/agent/modes) 把代码搜索、多文件编辑和命令执行放进编辑器里的 Agent 模式；[OpenHands CLI](https://docs.openhands.dev/overview/quickstart) 和 [OpenHands SDK](https://docs.openhands.dev/sdk/index) 分别提供产品入口与可编程接口。它们与 LangGraph 处在不同层级。

你想把一个编码任务交付给一个已经能工作的工具，和你想构建“客服分流—查订单—判断退款—人工审批—写回工单”的业务流程，应该走两条选型路径。前者看任务完成体验和安全边界，后者看状态、控制和恢复。

## 老板真正需要你回答的四个问题

### 1. 一次运行会不会跨过请求边界

一次 HTTP 请求里的单轮回答，不需要为了“以后可能变复杂”引入持久化图。只要把输入变成结构化参数，调用模型和工具，再把结果返回，普通代码更容易读，也更容易测试。

跨过请求边界的任务就不同了。客服工单可能等两个小时的主管批准，研究任务可能跑几分钟，数据处理任务可能在第三个工具调用处遇到限流。此时状态不再是上下文里的一个大 JSON，而是下一次执行能否找到正确位置的依据。

### 2. 下一步是不是依赖运行时结果

固定顺序的流程可以写成函数：读取资料、生成摘要、保存结果。动态流程会在运行中分叉：SQL 校验失败就回到生成节点；退款金额超过阈值就进入人工审批；检索为空就改用另一个数据源；某个专家已经给出结论，就不要重复调用。

这类约束应在代码中明确表达。普通条件语句、LCEL 分支、Agent middleware 或 LangGraph 条件边都可以承担相应逻辑；需要运行时管理到什么粒度，才是进一步选择结构的依据。

### 3. 谁负责副作用

模型可以提出“退款”“发邮件”“修改权限”这样的动作，业务代码必须决定动作能否执行。审批、权限、幂等键、金额上限和审计记录都属于执行边界。

一个实用的分工是：模型提出下一步，节点检查约束，工具执行副作用，状态记录结果。这样换模型不会顺手换掉业务规则。

### 4. 失败时要不要从中间继续

“失败后重跑”有两种含义：从头再来，或者从已确认的检查点继续。后者要求系统知道哪些节点已经完成、当时的状态是什么、工具副作用是否已经发生，以及人工批准对应哪一个线程。

LangGraph 官方文档把长时间运行、有状态的 Agent orchestration 作为定位，并提供持久化、流式执行和 human-in-the-loop 等运行时能力；它也明确说自己是低层编排层，不替你决定 prompt 或整体架构。[LangGraph 文档](https://langchain-ai.github.io/langgraph/index.html)

## 这就是 LangGraph 解决的问题

我会把一个业务 Agent 拆成四样东西：状态、节点、边和副作用。

- **状态**回答“系统现在知道什么”：用户请求、检索结果、工具错误、重试次数、审批意见、最终产物。
- **节点**回答“这一步做什么”：解析输入、查库、生成 SQL、校验、执行、汇总、请求人工确认。
- **边**回答“下一步怎么走”：固定转移、条件路由、循环、结束。
- **副作用**回答“哪些动作真的改变了外部世界”：扣款、写库、发通知、提交代码。

![Agent 工作流中的输入、工具、校验回路、人工确认与状态检查点](/images/posts/2026-why-langgraph/agent-workflow-concept.png)

LangGraph 把这些转移组织成可以被检查、暂停和恢复的运行结构。官方的 [Thinking in LangGraph](https://docs.langchain.com/oss/python/langgraph/thinking-in-langgraph) 用离散节点、共享状态和错误路径来描述这种思路；节点怎么切，还会决定检查点在哪里产生，以及失败重试会重做多大范围。

人工确认也是同一套结构的一部分。使用 `interrupt()` 时，运行可以暂停，把状态交给外部的人或系统；恢复时通过命令继续，并用 `thread_id` 找回对应的执行线程。[Interrupts 文档](https://langchain-ai.github.io/langgraph/concepts/breakpoints/)

持久化仍需配合副作用治理。LangGraph 的持久化文档提醒，回放会重新执行检查点之后的节点，因此数据库写入、发信和扣款一类操作要放进可重试、可幂等的边界里。[Persistence 文档](https://docs.langchain.com/oss/python/langgraph/persistence)

框架负责保存状态；幂等键和邮件去重仍是业务系统的责任。

## 五个老板会真的遇到的场景

### 场景一：内部知识库问答

需求是“查公司文档，回答问题，给出引用”。流程大多是检索、拼接上下文、生成回答。在权限路由、检索失败改道、跨天任务和人工复核都不需要时，我会先选直接 API、高层 Agent SDK 或现成问答产品。

如果问答需要模型反复检索和调用工具，可以先用 LangChain 的现成 Agent 循环，无须手写同样的图。

### 场景二：Text-to-SQL 分析助手

用户问：“本季度华东区域退款率为什么上升？”系统需要识别指标，选择表和字段，生成 SQL，做语法与权限检查，执行查询，读取数据库错误，必要时修正并重试，最后解释结果。

这里 LangGraph 是一个合理候选。因为失败不是异常分支之外的事情，而是正常工作流的一部分；“生成 SQL”“校验 SQL”“执行 SQL”也需要共享状态。人工审批可以放在高风险查询或大数据量扫描之前。

SQL Agent 也可以沿其他路线实现。如果团队已经以 LlamaIndex 的数据工作流为中心，或只需要一个类型约束很强的 Python Agent，就先沿那条路线验证。关键在于把错误、权限和重试写成测试条件，而不是在演示里只跑通一次。

### 场景三：客服退款与工单闭环

流程可能是：识别用户、查询订单、判断政策、计算退款、超过阈值时请求主管批准、调用支付系统、写回工单、通知用户。

此时暂停—恢复就是业务动作的时间模型。批准发生后，系统要继续原来的线程；重试支付时不能重复扣款；通知发送失败不能把整个审批状态抹掉。LangGraph 的状态和中断机制能表达这条链，但权限、幂等和审计仍然要由业务系统负责。

### 场景四：编码 Agent

如果老板要的是“让工程师在仓库里描述任务，然后 Agent 修改文件、运行测试”，我会先评估 Claude Code、Codex CLI、Cursor Agent 或 OpenHands 这样的现成入口。它们已经把编码任务需要的工具和交互装配起来。

公司要做自己的编码 Agent 平台时，例如接入内部构建集群、权限系统、代码评审和多租户审计，问题才会回到框架层。此时可以把“计划—修改—测试—失败归因—修复—人工合并”做成自己的图；也可以选择 OpenHands SDK 这类更贴近编码任务的 SDK。产品入口与通用编排 runtime 应当分层评估。

### 场景五：多 Agent 研究报告

研究员、检索员、分析员和写作者听起来很适合多 Agent，但角色越多不代表系统越可靠。先确认每个角色的输入输出能不能定义，谁拥有哪种工具，重复工作如何停止，最终稿件怎样经过事实检查。

如果团队想用角色和任务来表达协作，[CrewAI 的 Crews 与 Flows](https://docs.crewai.com/core-concepts/Agents) 可以进入候选；如果应用主要围绕 Google 的 Agent 运行时，[Google ADK 的 workflow agents](https://github.com/google/adk-docs/blob/main/docs/workflows/index.md) 也有对应抽象。若你更在意每个检查点、状态字段和路由都可逐条控制，LangGraph 会更贴近需求。

## 和其他框架怎么比较

下面按各自的最小心智模型和适合优先验证的条件呈现，不做总排名。官方文档会变化，真正上线前还要锁定版本并跑自己的任务集。

| 方案 | 主要抽象 | 可以优先验证的场景 | 需要提前确认的边界 |
| --- | --- | --- | --- |
| 直接 API + 业务代码 | 模型调用、工具函数、普通控制流 | 单轮问答、短链路、固定顺序任务 | 状态、暂停和恢复都要自己写 |
| LangChain create_agent | 预构建 Agent 循环与 middleware | 标准工具调用、上下文管理、工具审批 | 底层已是 LangGraph；任意业务节点拓扑需另行编排 |
| LangGraph | 以状态、节点、边组织长流程 Agent | 分支、循环、重试、人审、长任务、需要自有运行控制 | 图设计、状态 schema、幂等性、checkpointer 和运维责任在团队 |
| CrewAI | Crews 表达角色协作，Flows 表达事件驱动流程 | 角色、任务和团队协作是主要语言 | 需要把业务状态和精确副作用边界再落回代码 |
| OpenAI Agents SDK | Agent、Runner、tools、handoffs、guardrails、sessions | 已经以 OpenAI 模型和运行方式为中心的应用 | 是否接受供应商路径，以及低层状态控制是否够用 |
| Google ADK | Agent 与 workflow agents / executable nodes | Google 生态或希望沿其 Agent 运行时组织应用 | 托管与模型生态绑定、部署边界和版本路线 |
| Microsoft Agent Framework | Agent、workflow、memory/persistence、hosting 等 | Microsoft / Azure 体系，或从 AutoGen、Semantic Kernel 迁移 | 新旧项目的迁移路径、托管选择和版本成熟度 |
| LlamaIndex Workflows | 围绕数据、检索和查询的工作流 | RAG、索引、数据处理是产品主轴 | 通用 Agent 编排是否只是附属需求；Query Pipeline 文档已提示转向 Workflows |
| PydanticAI | 类型优先的 Python Agent 与结构化结果 | 输入输出 schema、类型约束、Python 业务代码优先 | 图级编排是否需要另加；durable execution 依赖相应集成 |

Microsoft 的当前路线需要单独看。[Microsoft Agent Framework 文档](https://learn.microsoft.com/en-us/agent-framework/) 已把 Agent、workflow、记忆、持久化和 hosting 放在同一条新路线里；[AutoGen 仓库](https://github.com/microsoft/autogen) 也把新项目引向 Microsoft Agent Framework。迁移成本和团队已有资产仍然是现实因素，旧项目仍要按自己的迁移窗口评估。

同样，LlamaIndex 的 [Query Pipeline 文档](https://docs.llamaindex.ai/en/stable/module_guides/querying/pipeline/) 已标注 feature-freeze / deprecation phase，并建议查看 Workflows。选型时看当前官方文档，不要把几年前的教程当成今天的产品路线图。

## 现成 Agent 什么时候比框架更合适

可以把两者的交付目标写成一句话：

> 现成 Agent 交付“某类任务可以被完成”；框架交付“这类任务的执行过程由我们拥有”。

当验收标准是“能不能改好代码”“能不能在终端运行测试”“能不能让一个人完成一项研究”，现成 Agent 往往先满足结果。你要评估的是权限、沙箱、上下文、模型选择、数据留存和是否能插入自己的工具。

当验收标准是“每次退款都要经过某条政策”“审批等待后要恢复同一个线程”“每个工具副作用都要审计”“失败要从指定检查点继续”，你就已经在拥有执行过程。此时现成 Agent 仍可以作为一个节点或工具，但不一定能承担整个业务编排。

两者解决的是不同层级：现成 Agent 更靠近用户任务，LangGraph 更靠近应用团队如何组织、暂停和恢复自己的 Agent 工作流。

## 决策树：先问问题，再看到框架名

![Agent 实现入口选择：现成产品、普通代码或 LCEL、LangChain create_agent，以及 LangGraph StateGraph 或 Functional API](/images/posts/2026-why-langgraph/2026-langgraph-decision-tree.svg)

如果图片不方便查看，可以把它压缩成这条路径：

~~~text
现成 Agent 产品已满足任务与接入要求？
├─ 是 → 使用现成产品
└─ 否 → 自己构建应用
   ├─ 普通代码或现有后端已能管理流程？
   │  └─ 是 → 保留现有编排；按需加入模型调用或 LCEL
   └─ 需要 Agent 循环或新的工作流运行机制
      ├─ create_agent + middleware 能清楚表达？
      │  └─ 是 → LangChain；按需配置 checkpointer
      └─ 需要自定义执行流程及运行保障
         ├─ 用共享状态、节点与边表达 → LangGraph StateGraph
         └─ 用函数、if / for 与 task 表达 → LangGraph Functional API
~~~

这棵树用于区分实现入口，各分支可以组合。Google、Microsoft、OpenAI 生态或专门的数据框架仍可按上表并行评估；它们并不是在 LangChain / LangGraph 之间选完后就失去意义。图中没有把“有人工审批”直接连到 LangGraph，因为现成 Agent middleware 也能处理工具审批。

## 那么，为什么我会选 LangGraph

如果老板一定要我在评审会上给出一句选择理由，我会说四点。

第一，状态是业务对象，而不是日志里的附属信息。审批意见、工具错误、检索结果和重试次数会影响下一步，它们应该有明确的 schema 和生命周期。

第二，失败路径和成功路径一样重要。SQL 生成错了怎么办，支付接口超时怎么办，检索没有结果怎么办，人工拒绝怎么办。节点和边是一种方便逐条评审的表达方式；普通代码和 middleware 也能表达可测试的约束。选择图的理由应是它更贴合这份执行设计。

第三，暂停和恢复可以进入正常流程。人审不再是运行时外面的一封邮件，而是图里一个有状态的边界。长任务也不必靠一段不断变长的对话历史维持“我跑到哪了”。

第四，LangGraph 相对低层，反过来给团队留下了取舍空间。它不强迫你采用某一种 prompt 组织方式，也不替你决定所有 Agent 架构；你可以让一个节点调用普通 Python 代码，也可以让不同节点使用不同模型和工具。代价是团队必须自己把图设计好，把副作用做成幂等，把观测和评估接上。

我的结论是条件式选择：

> 当专门的执行流程需要由运行时管理，而现成 Agent 循环和已有后端不能清楚承担时，评估直接使用 LangGraph；标准工具循环优先复用 LangChain，需要的只是短流程时，普通代码也可以满足。

## 交给老板的选型记录

我会把这些问题写进决策记录，替代一句“大家都觉得 LangGraph 更稳”：

- 一次运行是否跨请求，最长会等待多久？
- 哪些状态需要在重启后保留，哪些状态可以重新计算？
- 哪些节点会产生外部副作用，怎样保证重试不重复执行？
- 哪些条件会分支、循环、提前结束或进入人工审批？
- 现成 Agent 能否满足工具、权限、沙箱、审计和数据留存要求？
- 团队愿不愿意维护状态 schema、checkpointer、幂等策略、trace 和评估集？

只要这几项还没有答案，框架对比表就只是采购目录。先用真实任务把失败路径画出来，再决定要不要让 LangGraph 进生产。

## 本文参考的十篇非官方博客

这些文章提供了教程、项目经验和观察角度。它们不是官方 API 规范，也没有被我当成跨框架 benchmark；文中涉及当前能力的判断回到了各项目官方文档。

- [Agentic Workflows](https://cobusgreyling.substack.com/p/agentic-workflows)，Cobus Greyling：从 RPA 到自治 Agent 之间看 workflow 的控制边界。
- [Building Agents with LangGraph Course #7](https://todatabeyond.substack.com/p/building-agents-with-langgraph-course-92e)，Youssef Hosni：用 planner、researcher、writer、reflector 组织多 Agent 写作流程。
- [Agentic AI for Dummies](https://dataengineeringcentral.substack.com/p/agentic-ai-for-dummies)，Daniel Beach：把 Agent 当成带路由和工具的流程来拆解。
- [Build your own Job Agent - Part 1](https://jamwithai.substack.com/p/build-your-own-job-agent-part-1)，Shirin Khosravi Jam：展示 typed profile、预算、追踪和人工提交边界。
- [LangGraph vs CrewAI vs AutoGen](https://pratikpathak.com/langgraph-vs-crewai-vs-autogen-2026/)，Pratik Pathak：提供控制、原型和云环境等比较维度。
- [Build Agent workflows using LangGraph and Trace using LangSmith](https://domakuntlasnehitha.substack.com/p/build-agent-workflows-using-langgraph)，Snehitha Domakuntla：用 state、node、edge 和 trace 说明 Text-to-SQL 流程。
- [Building a Production-Ready SQL Agent with LangGraph](https://mlnotes.substack.com/p/building-a-production-ready-sql-agent)，Mehdi Allahyari：展示 SQL 校验、错误回路、线程和人工审批。
- [Building a Multi-Agent Financial Analyst — Part II](https://andyli2026.substack.com/p/building-a-multi-agent-financial-3ba)，Andy Li：讨论 supervisor 路由、专家工具边界和重复执行标记。
- [How to Build AI Agents with LangGraph](https://aispaces.substack.com/p/how-to-build-ai-agents-with-langgraph)，AISpaces：从状态、边、重试和检查点给出入门框架。
- [The ReAct Agent Pattern in LangGraph](https://abstractalgorithms.hashnode.dev/langgraph-react-agent-pattern)，Abstract Algorithms：从 Think—Act—Observe 回路讨论工具错误和迭代上限。
