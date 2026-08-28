---
title: "Agent Harness 09｜工具契约、注册表与服务端工具"
published: 2026-07-24T09:00:00+08:00
description: "比较四种 Agent Harness 的工具契约、注册表、延迟发现、服务端工具与 Tool Search 边界。"
tags: ["agent-harness", "claude-code", "codex-cli", "pi", "deepseek"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-09/claude-code-source-reading-00.png"
imagePosition: "left"
updated: 2026-08-28
---
## Claude Code

![Claude Code 把工具契约、本地 Tool Search 和 API 服务端展开分成三层](/images/posts/claude-code-source-reading-09/agent-theme-09-claude-code-tool-contract-handdrawn.png)

*模型只接收当前可见的 Schema；延迟工具由本地检索，API 服务端参与协议处理和后续展开。*

Claude Code 2.1.88 的 `Tool` 不是单纯的 JSON Schema，也不是一个可以直接调用的 JavaScript 函数。它把两侧放在同一个对象里：`name`、`aliases`、`description()`、`inputSchema` 和可选的 `inputJSONSchema` 决定模型能看到什么；`validateInput()`、`checkPermissions()`、`call()`、`isConcurrencySafe()`、`isReadOnly()`、`isDestructive()` 和 `interruptBehavior()` 决定宿主怎样执行。模型拿到的是从该对象投影出的契约，Claude Code 运行时保留完整对象。模型输出同名 `tool_use` 后，宿主还要重新查注册表、校验输入、判断权限，不能把“模型选中了工具”直接等同于“函数获得执行权”。

`buildTool()` 把保守缺省值集中起来。没有覆盖时，工具默认启用，默认不允许并发，默认既不声明只读，也不声明破坏性；默认 `checkPermissions()` 返回 allow，但仍要进入通用权限系统，而不是绕过授权。`interruptBehavior()` 的可选返回值只有 `cancel` 和 `block`：前者允许用户中断取消工具，后者阻止中断；没有实现该函数时按 `block` 处理。`shouldDefer?: boolean` 表示 Schema 是否可以延后发送，`alwaysLoad?: boolean` 用于强制常驻，两者负责模型可见性，不负责选择执行机器。

当前会话的工具池由 `tools.ts` 装配。内置工具先经过运行模式、配置、deny 规则和 `isEnabled()` 过滤，再与 MCP 工具合并。`assembleToolPool()` 会先把内置和扩展来源分区排序，以保持请求中的工具顺序稳定，随后按名称去重；同名冲突时内置工具在前，所以内置实现胜出。这个数组既是下一次请求生成工具 Schema 的来源，也是收到 `tool_use` 后寻找执行对象的依据。注册表因此不是静态的全局清单，而是“这个会话、这一轮条件下实际可见且可执行的工具快照”。

工具多到不适合把全部 Schema 塞进 prompt 时，Claude Code 才考虑 Tool Search。源码中的模式只有三种：`standard` 完整发送普通工具；`tst` 使用 Tool Search；`tst-auto` 根据工具规模自动判断。环境变量未设置时回退到 `tst`；`true` 或 `auto:0` 映射到 `tst`，`false` 或 `auto:100` 映射到 `standard`，`auto` 以及 `auto:1` 到 `auto:99` 映射到自动模式。第一方实验 Beta kill switch 生效时会强制回到 `standard`。即使模式允许，模型、provider、工具数量和 deferred 工具是否存在仍要逐项通过，不能把一个开关理解成 Tool Search 必然进入请求。

`tool_search` 到底放在哪里，需要把“搜索”和“协议展开”拆开回答。2.1.88 的 `ToolSearchTool.call()` 是 Claude Code 本地 TypeScript 实现：它读取当前工具池中 `shouldDefer` 的工具，对 query 做精确名称、`select:`、名称前缀和关键词计分，`+term` 表示必含词；`max_results` 可省略，默认返回 5 个。它返回的不是普通文本，而是 `tool_reference` block。也就是说，决定哪些 deferred 工具被发现的检索逻辑在客户端。

API 服务端仍参与后半段。Claude Code 在请求中发送对应 Beta 和 `defer_loading` 协议字段，从消息历史中收集已经发现的名称，下一轮只携带这些 deferred 工具的完整 Schema；第一方和 Foundry 路径可让服务端根据 `tool_reference` 展开定义。源码还提示 Bedrock、Vertex 对客户端产生的 reference 支持存在差异。因此，准确结论不是“`tool_search` 在服务端”，而是：**Claude Code 的目录检索在本地；API 服务端接受延迟加载协议，并参与 reference 到完整工具定义的展开。**

服务端工具则是另一类对象：模型供应商执行能力，CLI 消费其结果块，不调用本地 `Tool.call()`。固定窗口中能直接确认进入普通路径的是 `web_search`，其协议类型为 `web_search_20250305`，可带 `allowed_domains`、`blocked_domains`，并把 `max_uses` 设为 8；源码还会在条件满足时追加内部、实验性的 `advisor_20260301`。消息解析器认识 `server_tool_use`、`code_execution_tool_result`、`web_fetch_tool_result`、`bash_code_execution_tool_result`、`text_editor_code_execution_tool_result`、`tool_search_tool_result` 等更多 block，只能证明 CLI 有兼容解析能力，不能据此宣称这些服务端工具全都在 2.1.88 的正常请求中注册。回答“有哪些服务端工具”时，必须把“直接注册”“条件注册”和“仅认识结果格式”分开。

## Codex CLI

![Codex CLI 将模型工具规格、暴露方式和实际执行位置拆开](/images/posts/claude-code-source-reading-09/agent-theme-09-codex-cli-tool-registry-handdrawn.png)

*同一个工具是否出现在模型上下文、由谁执行，是两个彼此独立的决策。*

Codex CLI 固定提交 `c6dee5f` 把模型协议与执行器拆得更明显。`ToolSpec` 是发给模型的规格联合，完整变体包括 `Function`、`Namespace`、`ToolSearch`、`WebSearch` 和 `Freeform`；`ToolRegistry` 保存对应 handler 和执行元数据。收到模型输出后，router 先把 `ResponseItem` 还原为内部 `ToolCall`，再交给 registry 中的 executor。模型可见的 JSON 与真正执行命令、读文件或回调客户端的 Rust 对象不是同一个结构。

工具暴露由 `ToolExposure` 单独描述，六个值分别是 `Direct`、`Deferred`、`DeferredModelOnly`、`DirectModelOnly`、`CodeModeOnly` 和 `Hidden`。`Direct` 是默认值，表示直接进入常规模型工具列表；`Deferred` 进入可搜索目录；带 `ModelOnly` 的两个值只改变模型侧可见性，不为 registry 增加本地执行入口；`CodeModeOnly` 只通过代码模式暴露；`Hidden` 不进入模型。执行器是否支持并行是另一项布尔元数据，默认 `false`。所以 deferred 不是“放到服务端执行”，direct 也不是“只能本地执行”，它们先回答 Schema 怎样暴露。

Codex 自己创建的 Tool Search spec 带有 `query` 必填参数和可选数值 `limit`，并把 `execution` 固定写成 `client`。对应 handler 在本地用 BM25 搜索 registry 中的 deferred entries；空 query 或 `limit: 0` 会报错，省略 limit 则使用内部默认值。这个 handler 声明可并行，因为它只查本地目录，不直接触发外部副作用。

协议同时允许服务端 Tool Search。router 处理 `ResponseItem::ToolSearchCall` 时，只有存在 `call_id` 且 `execution == "client"` 才构造本地 `ToolCall`；`execution` 不是 `client` 时直接返回 `None`，原因是 provider 已经处理，Codex 不应再执行一次。因此这里的答案也不能压成一句“`tool_search` 在哪边”：**Codex 默认构造并实际使用的是客户端 Tool Search；协议还能承载 provider 处理的 Tool SearchCall，router 会刻意跳过它。**

固定提交中能直接确认的 provider-hosted 工具是 `web_search`。它只有在模型声明支持、provider 能力允许、搜索模式开启，且没有独立 extension web search 冲突时才进入 hosted specs。`WebSearch` 的结构包含可选的搜索上下文大小、用户位置和是否允许外网等协议字段；这些字段由 provider 解释，Codex 本地没有对应网页搜索 executor。看到 `ToolSpec::WebSearch` 时，应把它理解为“模型供应商托管的工具声明”，而不是本地函数注册。

dynamic tool 又处在第三个位置。外部应用通过 app-server 协议提供名称、描述、输入 Schema 和 `defer_loading`；Codex 将后者映射为 `Deferred` 或 `Direct`，模型调用后，dynamic handler 使用 `request_dynamic_tool` 向外部客户端发回调并等待结果。代码不是在模型供应商服务端运行，也不是在 Codex 的 shell sandbox 中运行，而是在注册它的 App 客户端进程中执行。它和 hosted web search 都“不是 Codex 内置 handler”，但信任边界完全不同：前者是客户端回调，后者是 provider 服务。

于是 Codex 的工具系统可以用两条轴阅读。第一条轴是模型如何发现它：Direct、Deferred、CodeModeOnly 或 Hidden；第二条轴是谁履行调用：Codex 本地 executor、外部 App 客户端，或者 provider-hosted tool。`ToolSpec`、`ToolExposure` 和 registry executor 分开存在，正是为了避免用一个“server tool”标签把这些边界混在一起。

## Pi

![Pi 从 ToolDefinition 建立会话注册表，再包装成 AgentTool 执行](/images/posts/claude-code-source-reading-09/agent-theme-09-pi-tool-registry-handdrawn.png)

*Pi 的扩展重点是宿主内注册和覆盖；模型获得的是筛选后的 AgentTool 数组。*

Pi 固定提交 `9d2ec7f` 用两份类型完成工具交接。扩展作者提交 `ToolDefinition`：`name`、`label`、`description`、`parameters` 是必填契约，`promptSnippet`、`promptGuidelines`、参数准备、渲染和执行方式是可选控制。`defineTool()` 只是保留泛型的 identity helper，它不注册工具，也不包办执行。Agent runtime 最终消费的是 `AgentTool`，其中有模型所需的 Schema，也有真正的 `execute()`。

几个可选值会直接改变行为。`executionMode` 只有 `sequential` 和 `parallel`；缺省时由 Agent 的工具执行配置决定。`constrainedSampling` 可以是 `false` 或配置对象，用于声明参数是否走受约束采样；`renderShell` 只能是 `default` 或 `self`，决定 shell 调用由框架还是工具自己展示。`prepareArguments` 可在执行前规范化参数。执行结果必须包含 `content` 和 `details`，`usage`、`addedToolNames`、`terminate` 可省略；工具可以在结果中通知 Agent 新增工具，或要求终止后续循环。

`AgentSession` 建注册表时先放入内置定义，再合并 SDK custom tools 与 extensions。Pi 不拒绝同名冲突，而是让后加入的定义按名称覆盖前者；包装成 `AgentTool` 时沿用相同覆盖顺序。随后 allow/exclude 过滤决定 active tool names，只有筛选后的数组交给模型。固定提交存在七个基础定义：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`；没有显式覆盖时，默认启用的是前四个。扩展调用 `registerTool()` 后会立即触发 `refreshTools()`，所以注册表是会话运行期可更新的。

这个设计把“有定义”与“当前可用”分开，却没有引入 Claude/Codex 那种原生 deferred catalogue。对固定提交的 `packages/` 检索没有发现统一的 `tool_search` 协议、server-tool registry 或 deferred exposure 枚举；内置工具、SDK custom tools 与 extension tools 都包装成宿主进程中的 `AgentTool.execute()`。provider adapter 负责把筛选后的 Schema 翻译为各模型 API 的工具格式，模型返回调用后，Pi 的 Agent loop 在宿主侧查找并执行。

因此 Pi 中“服务端工具有哪些”没有一张由核心注册表提供的清单。某个 provider 可能拥有自己的服务端能力，扩展也可以自行请求远程服务，但它们在这个固定窗口里不是 Pi 原生工具类型；一旦接入 Agent，会表现为普通 ToolDefinition/AgentTool。类似地，“没有原生 `tool_search`”只限定该提交的核心机制，不意味着扩展永远不能实现一个名为 tool_search 的工具，也不推断后续版本行为。

Pi 的取舍适合工具集较小、扩展可信且需要高自由度的宿主：定义入口简单，同名覆盖方便定制，工具执行位置明确。但覆盖本身也是能力替换，不能只把它当作 UI 定制。一个 extension 用同名 `bash` 覆盖内置定义后，模型仍看到熟悉名称，实际 Schema、渲染和执行函数都可能已经变化；审计工具系统时必须读取最终 session registry，不能只查看基础工具目录。

## DeepSeek Harness

![DeepSeek Harness 通过分层注册表投影 Schema，并把远程搜索封装在本地工具之后](/images/posts/claude-code-source-reading-09/agent-theme-09-deepseek-harness-tool-runtime-handdrawn.png)

*主对话调用本地 web_search 契约；底层 provider 可以另发辅助请求使用服务端搜索。*

DeepSeek Harness 固定提交 `47f9438` 的 `ToolDefinition` 强制输入和输出都可验证。工具必须给出名称、描述、参数 Schema、输出 Schema 和 `execute()`；执行函数返回规范 JSON，再由可选的 `finalizeContent()` 转成会话内容。`finalizeContent()` 返回 `undefined` 时保留已有内容。`timeoutMs` 省略表示框架不施加 deadline，提供时必须是正有限数；只有 `isConcurrencySafe === true` 才允许并行，省略或任何其他值都按独占执行。`presentCall`、`presentResult` 只影响展示，不进入模型工具 Schema。

注册表由 layer 和 scope 共同约束。同一 layer 中注册同名工具会报错，跨 layer 则按可见范围解析；`register()` 会校验 input/output Schema、timeout 和保留名称，`run_code` 不能被普通工具占用。注册成功返回 disposer，插件卸载时可撤销这次能力。`restrict()` 的 allow/deny 只在当前 scope 生效，未知工具和无意义限制会显式报错，而不是静默形成一份与作者预期不同的工具集。

模型侧投影刻意很小：`schemas()` 只输出 `name`、`description` 和 `parameters`，SDK 投影可以额外包含 `output`；`execute`、timeout、并发与呈现函数全部留在 host runtime。工具呈现模式的完整取值是 `native`、`code`、`both`，默认 `native`。native 直接发送标准 tool schema；code 只向模型提供保留的 `run_code` 入口，由代码运行时再访问注册表；both 同时提供两种入口。`maxParallelSubCalls` 必须是正整数，默认 10。这个模式决定工具如何表达和编排，不是 deferred discovery：固定提交核心中没有原生 `tool_search` 或可搜索的延迟目录。

Web 工具揭示了“本地契约背后仍可使用服务端工具”的嵌套边界。`tool-web` 向主对话注册的 `web_search`、`web_fetch` 都是普通本地 ToolDefinition；模型调用后，`execute()` 进入 `ctx.web`。如果配置的是 DeepSeek web-search provider，后者会另发一次 Anthropic-compatible 辅助模型请求，并在那条请求中注册 provider-native 的 `web_search_20250305`，默认 `max_uses` 为 5。辅助模型得到服务端搜索结果后，再由本地工具整理为主对话的结果。

所以从主 Agent 的观察面看，`web_search` 是宿主工具；从搜索 provider 的内部实现看，它又委托了模型供应商的服务端工具。二者并不矛盾，因为发生在两条不同请求里。主对话模型没有直接获得 `web_search_20250305` 的 schema，也不会收到那条辅助请求的原始 `server_tool_use`；它只看到 Harness 注册表投影出的本地 `web_search`，并等待规范化结果。

DeepSeek Harness 对“有哪些服务端工具”的回答也必须带观察层级。核心工具运行时没有维护通用服务端工具目录，固定窗口能确认的是 DeepSeek 搜索 provider 内部使用的 `web_search_20250305`；主对话暴露的是本地 `web_search` 和 `web_fetch`。固定提交未发现原生 `tool_search`，`native/code/both` 也不能当成其替代品：code mode 压缩的是调用表达，tool search 解决的是大规模 Schema 的延迟发现，两者优化的是不同成本。
