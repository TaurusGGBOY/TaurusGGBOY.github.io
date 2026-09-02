---
title: "Vanna Agent：从 Text-to-SQL 到有权限的工具型 Agent"
published: 2026-09-02T11:00:00+08:00
updated: 2026-09-02
description: "以 Vanna 2.0.0rc1 官方源码为边界，拆解 Agent、ToolRegistry、用户身份、行级安全、记忆、会话、流式 UI 与服务端，并和无 Vanna 的 SQL Agent、LangChain、LlamaIndex、Wren AI 对照。"
tags: ["vanna", "text-to-sql", "data-agent", "agent-runtime", "source-code"]
category: "AI / Architecture"
draft: false
image: ""
lang: "zh_CN"
---

## 先给结论

Vanna 2.0 把旧版 vn.ask() 所在的调用抽象重写成一个有用户身份、有工具权限、有会话、有记忆、有审计、能流式输出 UI 组件的 Agent 运行时。

它解决的问题也随之改变。旧问题是“自然语言能不能生成可执行 SQL”；Vanna Agent 还要回答“这个用户是谁、能看到哪些工具、能否访问这些行、这次对话属于哪一个用户、工具结果怎样回到前端、哪一步应该记审计”。如果你只需要在内部脚本里生成一条 SQL，Vanna 可能显得过重；如果你要把数据问答交给真实用户，它把很多容易漏写的边界提前放进了框架。

但这里必须保留两个版本警告。v2.0.0rc1 是预发布版本；Vanna GitHub 仓库在 2026-03-29 已归档为只读。源码的 pyproject.toml 版本是 2.0.0rc1，而 src/vanna/__init__.py 仍暴露 0.1.0，这类不一致说明它适合源码级评估和受控试用，不适合不经锁版本就当作稳定基础设施。

本文还会和“无 Vanna Agent”比较。结论不是 Vanna 一定替你做好安全，而是：Vanna 把产品运行时的接口集中起来，同时把数据库执行、身份解析、行级约束、部署安全和评测责任留给应用团队。

## 版本、源码与研究边界

本文以 2026-09-02 可取得的 [Vanna v2.0.0rc1 release](https://github.com/vanna-ai/vanna/releases/tag/v2.0.0rc1)和对应源码 tag 为准，配合官方 [Vanna 文档](https://vanna.ai/docs)、[migration guide](https://vanna.ai/docs/migration)、[5 分钟 quickstart](https://vanna.ai/docs/tutorials/quickstart-5min)与[数据安全说明](https://vanna.ai/data-security)核对产品边界。官方仓库的 [archive notice](https://github.com/vanna-ai/vanna)是成熟度判断的重要证据。

十篇非官方文章已下载到本项目的 [Vanna Agent 研究归档](https://github.com/TaurusGGBOY/TaurusGGBOY.github.io/blob/master/research/agent-articles-2026-09-02/vanna-agent/sources.md)。它们帮助本文选择了“本地模型、可靠 SQL、RAG2SQL、产品替代方案和 agentic retrieval”这些对照面，但 API、权限和版本事实以官方源码和文档为准。

## 1. Vanna 2.0 改变了抽象层

官方迁移指南把 0.x 的 VannaBase、train、ask 路径与 2.0 的 Agent、modular tools、streaming components 和 user awareness 分开。2.0 不是把 ask() 做得更大，而是把最小组合改成：

    Agent
      -> LLM service
      -> ToolRegistry
      -> UserResolver
      -> AgentMemory
      -> ConversationStore
      -> hooks / middleware / context enhancers
      -> FastAPI or Flask server
      -> web component

这条链路的中心是 Agent，而不是一个只接收 question、返回 SQL 的对象。看 [core/agent/agent.py](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/agent/agent.py)可以看到，send_message 会先解析用户，再决定是否有 starter UI 或 workflow，加载或创建 conversation，执行 before_message hooks，构造 ToolContext，生成可见工具 schema，拼接 system prompt 与 memory context，调用 LLM，进入工具循环，最后保存消息并返回 UI component。

一次普通请求可以画成：

    HTTP / WebSocket / poll request
        -> RequestContext: cookies, headers, remote_addr, query
        -> UserResolver.resolve_user
        -> ConversationStore: load or create
        -> ContextEnrichers / workflow / starter UI
        -> ToolRegistry.get_schemas(user)
        -> system prompt + memory enhancement
        -> LLM request
        -> tool calls, max_tool_iterations = 10
        -> ToolRegistry.execute(user, ToolContext, args)
        -> ToolResult for LLM + UI component
        -> conversation persistence + audit
        -> SSE / WebSocket / poll / web component

模型仍然负责自然语言理解和 SQL 计划；但“能调用什么工具”和“结果怎样被呈现”已经由宿主控制。这个变化正是 Agent 与函数调用 demo 的分界。

## 2. 四个关键抽象

### 用户不是 prompt 里的一个名字

UserResolver 接收 RequestContext，返回 User。User 有 id、username/email、metadata 和 group_memberships。它可以从 cookie、header、JWT 解析结果或应用自己的 session 中得到身份。

身份随后流入 ToolRegistry。每个 Tool 有 name、description、Pydantic 参数 schema 和 access_groups；get_schemas(user) 只把用户有权限的工具暴露给模型。execute() 还会再次检查权限、校验参数、记录 audit，并把 user、conversation_id、request_id、agent_memory 和 observability 放进 ToolContext。

这两次检查很重要。只在 system prompt 中写“你不能查工资表”不是权限系统；只在工具列表里隐藏一个工具，也不能替代数据库账号和行级策略。Vanna 至少把“用户身份进入工具调用”做成了显式接口。

### ToolRegistry 把工具的三件事放在一起

官方 [registry.py](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/registry.py)的 execute 路径依次处理 access_groups、Pydantic args、transform_args、审计、异步 execute 和 execution_time_ms。transform_args 的默认实现是 no-op，但它预留了把用户条件、租户条件或 row-level filter 注入工具参数的入口。

这个接口很有价值，也很容易被误读。transform_args 不是数据库本身的 RLS。若 SQL runner 允许任意查询，或者团队把用户条件作为普通字符串拼接，工具层依然可能绕过行级约束。真正的 RLS 应由数据库角色、视图、参数化查询或经过验证的查询计划共同完成。

ToolResult 也不只有一个字符串：它区分 success、result_for_llm、ui_component、error 和 metadata。这样一条 SQL 可以把简洁的结果给模型，把表格或图表给前端，把 request_id 和耗时给审计系统，而不必让所有消费者共享同一段原始数据。

### Agent 的工具循环有上限

AgentConfig 默认 max_tool_iterations 为 10，stream_responses 为 true，auto_save_conversations 为 true，include_thinking_indicators 为 true；AuditConfig 默认启用，记录访问检查、工具调用、工具结果和 AI response，但默认不保存完整响应，并会清理工具参数。

Agent 的循环实现是顺序的：模型返回一批 tool calls 后，Agent 逐个调用 registry.execute，再把 tool response 继续交给 LLM。顺序执行简化了数据库查询、审计和 UI 更新的可解释性，但长时间工具会增加延迟；如果业务需要并发，应在一个受控工具内部做，并重新定义事务、限流和结果顺序。

workflow_handler 可以在 starter request 阶段直接提供自定义流程或 UI，短路普通 LLM 路径。这个扩展点适合“先选数据源”“先确认导出范围”“先展示指标卡”的产品流程，避免让模型承担每个交互的全部决策。

### Memory 是可插拔服务，不是神奇的训练

AgentMemory 抽象了 save_tool_usage、save_text_memory、search_similar_usage、search_text_memories、get_recent_memories 和删除/清空操作。DefaultLlmContextEnhancer 会按用户问题检索文本记忆，最多附加若干相关上下文；默认 system prompt 还会要求模型在调用前搜索可用记忆，在成功后保存工具使用经验。

这让 Vanna 可以记住 schema/domain terminology、用户偏好或成功的工具参数，而不必把每条历史消息都塞回 prompt。与此同时，记忆中的 SQL、表名、用户输入和业务规则可能过时或带有恶意指令。必须区分“检索参考资料”和“不可绕过的权限策略”，并提供租户隔离、过期、删除和人工审核。

## 3. 从 Agent 到可用 Web 应用

### ConversationStore 管理的是用户自己的会话

ConversationStore 接口按 user scope 创建、读取、更新、删除和列举 conversation。默认 Agent 没有传入 store 时，会导入内存实现；文件 store 则把消息追加到用户拥有的 JSON 文件，并在读取与更新时检查 owner。

内存实现适合 quickstart，不适合重启恢复和多实例部署。文件追加也不自动提供跨进程锁、备份、加密、并发合并和审计保留策略。生产环境应明确选择数据库或其他持久化实现，并把 user id、tenant id、retention 和删除语义写进数据模型。

### FastAPI Server 的协议面是完整的，但默认配置仍需改

官方 FastAPI server 提供 health、根路由、SSE、WebSocket 和 poll 三种聊天接口：POST /api/vanna/v2/chat_sse、WebSocket /api/vanna/v2/chat_websocket、POST /api/vanna/v2/chat_poll。请求上下文会从 cookie、header、query 和远端地址提取，再交给 UserResolver。

这使 Vanna 与 web component 的连接成本很低，也让它比一个 Python 函数更像应用服务器。但 [fastapi/app.py](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/servers/fastapi/app.py)的默认 CORS 配置允许 origins 为 *、credentials 为 true，methods 和 headers 也较宽。它是开发便利配置，不是生产安全基线；部署时必须明确允许的 origin、cookie 属性、反向代理、CSRF、TLS 和认证中间件。

流式响应还要区分三个完成点：LLM 产生最后一个 delta、ToolRegistry 的工具结果已经保存、浏览器已收到并渲染最终 UI。SSE/WS/poll 只是传输方式，不能自动解决断线重连、重复请求和前端幂等。

### Hooks、middleware 与 recovery 把生命周期暴露出来

Agent 构造器支持 lifecycle_hooks、llm_middlewares、context_enrichers、conversation_filters、observability_provider、audit_logger、workflow_handler 和 error_recovery_strategy。它们覆盖 before/after message、工具执行、LLM 请求、conversation 保存和错误恢复。

这组接口是 Vanna 2.0 最像生产 Agent 的部分：你可以在模型前做脱敏和限额，在工具前做策略检查，在结果后做 UI 转换，在审计系统里记录调用。但 hooks 越多，越需要明确顺序、异常处理和重入规则。一个 hook 抛错后，是回给模型、终止回答、重试工具，还是给用户一个可见错误，必须由应用写测试。

## 4. 没有 Vanna 时，你仍然可以做出什么

一个“无 Vanna Agent”并不等于裸奔。使用 LLM SDK、数据库 driver 和普通 Web 框架，可以自己搭出下面的流水线：

    用户请求
      -> 应用认证与租户解析
      -> schema / semantic context 检索
      -> LLM 生成 SQL
      -> SQL parser / allowlist / read-only policy
      -> 参数化执行或数据库 RLS
      -> 结果校验与错误修复
      -> 表格/图表/文本渲染
      -> conversation / audit / metrics

对于内部脚本或一个受控 API，这条路线通常更轻、更透明。你可以只允许 SELECT，只暴露几个参数化查询，使用数据库角色隔离，或完全不引入 memory 和多轮工具。

Vanna 的差异在于，它把上面许多“应用胶水”变成了命名清楚的组件：UserResolver、ToolRegistry、ToolContext、ConversationStore、AgentMemory、AuditConfig、FastAPI routes、UI component 和 lifecycle hooks。团队少写一套运行时，但要接受 Vanna 的 Agent 生命周期、版本节奏和默认配置，并仍然实现真正的数据安全。

换句话说，Vanna 节省的是“把数据问答做成可用产品”的集成成本，不是“让模型突然更懂你的数据库”的准确率成本。SQL 质量仍由模型、schema 描述、示例、语义层、检索、数据库反馈和评测集共同决定。

## 按 Claude Code 系列的 42 个观察点映射

| 观察点 | Vanna 2.0.0rc1 的落点 | 对照 Claude Code 系列或自建 Agent 时应追问 |
|---|---|---|
| 任务边界 | 面向数据分析、SQL、可视化与文件工具的 Agent | Agent 是通用执行器还是领域运行时 |
| 控制平面 | Agent 编排 LLM、工具、用户、会话和 UI | 谁持有一轮运行的最终状态 |
| 用户身份 | UserResolver 从 RequestContext 解析 User | 身份是否真的进入工具和数据库 |
| 会话作用域 | ConversationStore 按 user 归属会话 | 会话是否跨租户、跨用户泄露 |
| ToolRegistry | 集中注册 schema、权限、校验、执行和审计 | 工具定义与策略是否分离 |
| Tool schema | Pydantic args schema + description | 模型看到的参数是否与执行参数一致 |
| 工具组 ACL | access_groups 与 group_memberships 交集过滤 | “看不到工具”是否还有第二次检查 |
| 行级安全 | transform_args 提供 RLS 注入点 | RLS 是数据库强制还是字符串约定 |
| 参数校验 | Pydantic 校验后再执行 | 非法参数是拒绝、修复还是重试 |
| SQL runner | 由工具/应用注入，非 Agent 自动安全 | 数据库账号、只读和超时怎样控制 |
| SQL 校验 | 可在工具或 middleware 接入 | 是否拦截写操作、跨租户和危险函数 |
| Tool loop | AgentConfig 默认最多 10 次 | 工具循环是否有成本和时间上限 |
| 工具并发 | Agent 内按调用顺序执行 | 并发查询是否破坏事务和审计顺序 |
| Workflow | starter UI/workflow 可短路 LLM | 哪些交互不应交给模型自由决定 |
| System prompt | 动态加入工具名、记忆规则和用户上下文 | prompt 是否承载了不该承载的权限 |
| Context enhancer | 可在 LLM 前追加上下文 | 外部资料与策略指令是否分层 |
| Schema retrieval | 由 LLM service、工具或 memory 接入 | schema、样例行和语义定义怎样选取 |
| Text memory | search_text_memories 供上下文增强 | 记忆是否有租户、来源和过期 |
| Tool memory | 保存成功工具用法和参数 | 旧 SQL 会不会成为未来错误模板 |
| Memory backend | 抽象接口，可替换向量/文本存储 | 默认实现是否适合规模与合规 |
| Conversation | 自动创建、加载、保存消息 | conversation 是业务记录还是 prompt 缓存 |
| Persistence | 默认可内存；文件 store 追加 JSON | 重启、并发、删除和备份怎么做 |
| Streaming | stream_responses 默认开启 | delta、tool result、最终 UI 如何收口 |
| UI component | ToolResult 可携带表格/图表等组件 | 前端渲染是否信任模型生成内容 |
| HTTP server | FastAPI/Flask server | 应用 server 与 Agent runtime 是否解耦 |
| SSE | chat_sse 路由 | 断线重连和重复请求如何处理 |
| WebSocket | chat_websocket 路由 | 长连接认证、超时和反压如何处理 |
| Poll | chat_poll 路由 | 多次轮询怎样保持 request/conversation id |
| Lifecycle hooks | message、tool、conversation 等 hook | hook 顺序和异常是否可测试 |
| LLM middleware | 请求前后可观测、改写或限流 | provider 重试是否会重复工具动作 |
| Error recovery | error_recovery_strategy 可注入 | 哪些错误回给模型，哪些直接给用户 |
| Audit | 默认记录访问、调用、结果与 AI response | 审计是否包含足够证据又避免泄露 |
| Observability | request_id、耗时、provider 接口 | 能否定位 SQL 慢还是模型慢 |
| Rate limiting | 可由应用层/中间件接入，需部署落实 | 限额按用户、租户、工具还是 token |
| 多租户 | User、group、conversation 提供切点 | 数据库和 memory 是否同样隔离 |
| 认证 | UserResolver 与中间件接入 cookie/JWT | 身份解析失败是否 fail closed |
| CORS | 默认配置偏开发便利 | origin、credentials、CSRF 是否改过 |
| DB credentials | 由 SQL runner/应用提供 | 模型是否可能看到原始凭证 |
| 数据外泄 | ToolResult 可分离 LLM/UI，但需自定义脱敏 | 原始行、prompt 和日志是否越权 |
| 模型/provider | LLM service 可替换 | provider 的日志、数据驻留和重试怎样管 |
| Tool output | result_for_llm、ui_component、metadata 分层 | 大结果是否会污染上下文 |
| Compaction | AgentConfig 暴露上下文与对话扩展点 | 长会话如何摘要且不丢权限条件 |
| Background | 核心重点是请求/会话服务，不是 cron 平台 | 后台任务由谁调度、去重和投递 |
| Subagents | 没有作为核心主路径突出 | 委派是否真的需要，权限如何继承 |
| Skills | 没有 Pi/OpenClaw 式技能目录作为核心 | 领域知识由工具、prompt 还是插件承载 |
| MCP | 可由应用/工具层接入，非本文核心抽象 | 外部工具的身份和审计是否统一 |
| Evaluation | 可接 observability/eval hooks，业务集需自建 | SQL execution、语义正确和权限正确怎样分开测 |
| 部署 | FastAPI/Flask + web component，需自行生产化 | 多实例、数据库、队列和密钥如何部署 |
| 成熟度 | v2.0.0rc1，仓库已归档，版本字段还有不一致 | 依赖升级与安全修复由谁承担 |

这张表把“有功能”和“有安全保证”明确分开。例如 Vanna 有 user resolver，不代表数据库已经完成 RLS；有 audit logger，不代表日志不会保存敏感结果；有 SSE，不代表断线后不会重复执行；有 memory，不代表记忆中的 SQL 可信。

## 5. 与相邻 Agent 方案怎样比较

### 与直接调用 LLM + SQL tool 比

直接方案最小，流程和成本都容易理解。它适合内部分析、固定查询、只读报表 API，尤其适合团队已经有成熟 auth、DB policy、前端和审计系统的情况。缺点是每个项目都要重新处理会话、工具 schema、流式 UI、用户上下文和错误恢复，久而久之会出现多个略有不同的安全实现。

Vanna 适合把这些胶水集中起来，快速形成面向用户的 Web 数据 Agent。它的强项是“运行时组件齐全”，不是“天然生成正确 SQL”。决定选型的关键，是你更希望拥有一个可替换的领域运行时，还是拥有一条完全由自己控制的窄流水线。

### 与 LangChain SQL agent 比

[LangChain 官方 SQL agent 文档](https://docs.langchain.com/oss/python/langchain/sql-agent)展示的典型路径是获取表名和 schema、生成 SQL、检查 SQL、执行、根据错误修正，再向用户回答；[SQLDatabaseToolkit reference](https://reference.langchain.com/python/langchain-community/agent_toolkits/sql/toolkit/SQLDatabaseToolkit)则把数据库相关工具组合起来。它提供更通用的编排自由度，适合把 SQL agent 嵌入已有 LangChain 图或工作流。

Vanna 的重心更靠近一个面向用户的应用运行时：用户解析、工具 ACL、conversation、memory、UI component 和 FastAPI routes 直接出现。LangChain 的安全文档同样强调应使用受限数据库角色、只读权限和沙箱；两者都不能把 LLM 生成 SQL 当成安全边界。

### 与 LlamaIndex SQL query engine 比

[LlamaIndex 的 query pipeline 示例](https://docs.llamaindex.ai/en/stable/examples/pipeline/query_pipeline_sql/)更强调 NLSQLTableQueryEngine、SQLTableRetrieverQueryEngine、表选择、schema 和样例行的检索组合。它适合构建检索增强的 SQL 查询管线，尤其适合已经在使用 LlamaIndex 数据抽象的应用。

Vanna 也可以使用 memory 和 context enhancer，但它的差异在用户/工具/会话/前端一侧。LlamaIndex 的 query engine 不是一个完整的多用户 Web Agent；Vanna 的 Agent 也不是一个替你完成所有 schema 建模与查询评测的语义引擎。

### 与 Wren AI 比

[Wren AI 官方文档](https://docs.getwren.ai/oss/introduction)和 [MDL/context 说明](https://docs.getwren.ai/oss/concepts/what_is_context)把重点放在语义层、受治理的上下文和可复用的数据模型上，让 Agent 在 fetch、recall、plan、execute、repair、clarify 等阶段选择动作。

如果企业首先缺的是业务指标定义、语义模型和治理上下文，Wren 的方向更贴近问题；如果首先缺的是一个可以解析用户、注册工具、流式展示表格/图表并保存会话的 Python Agent 应用，Vanna 更直接。两者也可以组合：语义层约束“应该怎样理解数据”，Vanna 负责“这个用户怎样通过工具得到结果”。

## 6. Vanna 生产化前必须补齐的边界

### SQL 安全要落到数据库

最小生产配置应使用只读数据库用户、语句 allowlist、查询超时、结果行数上限、资源组或沙箱，并让租户与用户条件由数据库视图、RLS 或参数化查询强制执行。不能只依赖模型提示、access_groups 或 transform_args。

表名、列名、注释、样例行和历史 SQL 都可能携带 prompt injection。schema retrieval 应当把描述性资料和控制指令分开；工具结果回给模型前做大小、字段和敏感数据过滤；展示给用户的 UI component 还要通过前端的安全渲染策略。

### 会话和记忆要有生命周期

为 conversation 和 memory 定义 owner、tenant、retention、delete、export 和审计策略。成功工具参数可以作为经验，但不能自动升级为权限。用户偏好可以共享给同一用户的多个会话，数据库访问条件却不应因为 memory 检索而跨用户继承。

### 默认配置不能直接上线

开发 quickstart 的 in-memory ConversationStore、宽松 CORS、默认示例用户和本地存储都应视为样例。生产部署要加入 TLS、明确 origin、cookie/JWT 安全属性、CSRF/重放防护、反向代理超时、SSE/WS 鉴权、多实例共享存储和结构化审计。

### 评测必须至少有三套答案

第一套检查 SQL 是否能执行；第二套检查结果是否符合业务语义；第三套检查用户是否有权得到这个结果。一个越权但语法正确的 SQL 不能算成功，一个结果正确但被写入不该访问的 memory 的响应也不能算成功。再加上延迟、token、工具次数、重试和 UI 完成率，才是可运营的 data agent 指标。

## 它适合什么，不适合什么

Vanna Agent 适合希望快速交付“有用户、有会话、有流式表格/图表、有工具权限”的数据问答产品，尤其是 Python/FastAPI 团队。它也适合把 SQL、可视化、文件和领域工具放在同一个受控 Agent 里，由 ToolRegistry 统一做入口检查。

它不适合被当成“只要接上数据库就自动安全”的 Text-to-SQL 黑盒，也不适合对预发布且已归档的版本做无锁定依赖。若你的场景只是一个内部、固定 schema、只读查询函数，直接调用 LLM 加一个窄 SQL tool 可能更容易审计；若你的难题是复杂指标语义和数据治理，应该优先建设语义层，而不是只增加 prompt。

最终可以这样记：

    无 Vanna Agent = 你自己组合 auth、schema context、SQL policy、tool loop、UI、会话和审计；
    Vanna Agent  = 把这些组合点变成一套可替换的领域运行时，
                   但数据库安全、部署安全、评测和版本责任仍在你手里。

## 资料与代码索引

### 官方资料与源码

- [Vanna 文档](https://vanna.ai/docs)、[Migration](https://vanna.ai/docs/migration)、[Quickstart](https://vanna.ai/docs/tutorials/quickstart-5min)：2.0 Agent 的产品入口。
- [Release v2.0.0rc1](https://github.com/vanna-ai/vanna/releases/tag/v2.0.0rc1)、[仓库归档状态](https://github.com/vanna-ai/vanna)：版本成熟度。
- [Agent](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/agent/agent.py)、[AgentConfig](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/agent/config.py)：循环、工作流、记忆、审计与响应配置。
- [ToolRegistry](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/registry.py)、[Tool base](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/tool/base.py)、[Tool models](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/tool/models.py)：工具、参数、用户上下文与结果。
- [Agent memory](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/capabilities/agent_memory/base.py)、[context enhancer](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/enhancer/default.py)：记忆接口与上下文注入。
- [User resolver](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/user/resolver.py)、[FastAPI app](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/servers/fastapi/app.py)、[routes](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/servers/fastapi/routes.py)：身份与 Web 运行面。
- [Data security](https://vanna.ai/data-security)：托管与自托管的数据边界。
- [LangChain SQL agent](https://docs.langchain.com/oss/python/langchain/sql-agent)、[LlamaIndex SQL pipeline](https://docs.llamaindex.ai/en/stable/examples/pipeline/query_pipeline_sql/)、[Wren AI context](https://docs.getwren.ai/oss/concepts/what_is_context)：相邻方案的官方对照。

### 十篇非官方阅读池

以下文章用于补充迁移、可靠性、本地模型和替代方案视角，事实以官方 v2.0.0rc1 为准：[TeachMeIDEA](https://teachmeidea.com/vanna-2-text-to-sql-postgres/)、[The Menon Lab](https://blog.themenonlab.com/blog/text-to-sql-open-source-local)、[Firebird Technologies](https://www.firebird-technologies.com/blog/building-a-reliable-text-to-sql-pipeline-pt-1)、[DeepWiki](https://deepwiki.com/r0mymendez/text-to-sql/2-vanna.ai-text-to-sql-tutorial/)、[AI Log](https://app.ailog.fr/en/blog/guides/rag-structured-data-sql)、[ReviewsAZ](https://reviewsaz.com/vanna-ai-review/)、[Nat Taylor](https://nattaylor.com/blog/2024/text-to-sql/)、[AI for Database](https://www.aifordatabase.com/blog/vanna-ai-alternatives-2026/)、[PK Hamdee](https://pkhamdee.blog/2026/06/04/agentic-retrieval-the-complete-guide-from-document-ingestion-to-compiled-knowledge/)、[火山引擎开发者社区](https://developer.volcengine.com/articles/7386867770900381722)。
