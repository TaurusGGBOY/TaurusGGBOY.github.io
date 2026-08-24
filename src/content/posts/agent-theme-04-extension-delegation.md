---
title: "Agent主题对比04｜扩展、委派与多 Agent"
published: 2026-08-12T10:04:00+08:00
updated: 2026-08-12
description: "比较三个 Agent 的 commands、skills、tasks、subagents、teams、MCP、plugins、LSP 与宿主扩展。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-04-extension-delegation/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-04-extension-delegation"
series: "agent-theme-comparison"
order: 4
difficulty: "advanced"
time: "60 min"
prerequisites:
  - "Agent主题对比 02｜消息、工具与副作用"
  - "Agent主题对比 03｜上下文、安全、恢复与会话"
topics:
  - "commands"
  - "skills"
  - "subagents"
  - "agent teams"
  - "MCP"
  - "plugins"
  - "LSP"
source_modules:
  - "restored-src/src/commands"
  - "restored-src/src/tools/AgentTool"
  - "restored-src/src/services/mcp"
  - "restored-src/src/utils/plugins"
  - "restored-src/src/services/lsp"
  - "codex-rs/core/src"
  - "packages/coding-agent/src/core/extensions"
status: "verified"
verified_at: "2026-08-12"
---


> 扩展系统的核心不是“再加几个工具”，而是把能力接进控制平面，并说明它从哪里来、什么时候可见、能改变什么、失败后谁负责。

本篇覆盖 Claude Code 源码解读 21–30：command、skill、task、subagent、team、plan/worktree、MCP、plugin、LSP，以及浏览器/IDE 外部宿主。重点是比较这些扩展和委派机制各自引入的契约：路由、能力发现、信任、生命周期和失败责任。

![Agent 扩展、委派与多 Agent](/images/posts/agent-theme-04-extension-delegation/agent-theme-04-extension-delegation-handdrawn.png)

## Section 21｜用户如何进入不同执行流程

### Claude Code：Command 首先是一种显式路由

21 说明 command 不是“把斜杠文本替换成 prompt”。命令表由内置、插件、skill 等多类来源装配；解析器先拆名字和原始参数，再根据交互/无头/远程模式判断斜杠是否有特殊含义；查找同时接受内部名、显示名和别名。handler 可能直接处理、改写输入、打开交互流程，或把请求送入 Query Loop。

参数替换遵循固定占位符规则，不能把任意字符串当成结构化参数。无头和远程模式还会裁掉不能承接的命令。把 Command、Skill 与 Query Loop 分开，保证入口路由不会偷偷复制一套 agent loop。

### Codex CLI：命令是 host/client 控制面

Codex 的 slash command、CLI flag 和 app-server request 共同形成入口路由。部分命令改变 thread/turn、模型、sandbox 或 approval，部分命令只是查询或展示。真正执行代码的工具调用仍要经过 turn/runtime，而不是因为用户输入以 `/` 开头就绕过安全策略。

### Pi：commands 由 coding-agent 和扩展提供

Pi 的 TUI/coding-agent 有内置命令、session 命令和扩展命令；扩展可以注册新的命令或响应事件。命令可以只操作 UI/session，也可以把文本送回 agent loop。它的自由度高，宿主需要明确哪些命令改变会话、哪些命令会触发模型或工具。

### 对比结论

Claude Code 把命令做成受模式约束的路由表；Codex 把命令放进 host/thread 控制面；Pi 把命令作为应用和扩展的组合点。命令系统的安全边界在于：一条入口是否能无意中跳过权限、session 或审计。

### 验证动作

分别在 REPL、print 和远程/脚本模式输入同一个命令，记录它是本地处理、送入 loop 还是被禁用。再检查命令改变 model/permissions/session 后，下一次 tool call 是否真的使用了新状态。

## Section 22｜提示词如何变成可执行能力

### Claude Code：Skill 是可发现、可展开的能力说明

22 把 Skill 拆成发现、frontmatter 元数据、目录清单、用户/模型调用、权限判断、正文展开、参数和 shell 处理、inline/fork 上下文边界。模型先看到目录，不先看到全文；动态发现让 skill 能随文件位置出现；SkillTool 自己也有 prompt budget。

这意味着 skill 不是“多一段 system prompt”，而是一种延迟加载的任务协议。它告诉模型何时调用、需要什么参数、正文展开后怎样影响当前上下文。调用 skill 仍需权限判断，fork 也不会把父上下文和副作用无条件复制给子流程。

### Codex CLI：skills 是 instructions 的可选能力层

Codex 把 skill 元数据放进初始环境说明，模型在需要时读取对应文件/资源并按其中流程工作。官方文章把 skills 与 AGENTS.md 一起视为 harness 提供的可发现能力，而不是模型天然知道的知识。

Codex 的重点是让 skill 与项目环境、cwd 和验证命令配套。若 skill 只提供长文本而没有输入/输出、验证和权限边界，它更像提示词，不像可执行能力。

### Pi：skills/资源通过 coding-agent 与扩展组合

Pi 的 coding-agent 可加载项目资源、skills、prompt templates 和扩展提供的能力。扩展可以在事件上注入说明，或注册工具完成 skill 所描述的动作。由于 Pi 不强制一种 SkillTool 协议，项目可以保持轻量，也需要自定义发现、信任和参数约定。

### 对比结论

三者都在把“领域流程”从主循环里分离出来。Claude Code 的 Skill 协议最完整，Codex 强调环境可读性和按需加载，Pi 强调自由组合。好的 skill 应该同时给出目标、前置条件、动作、验证和失败出口，而不是只写一篇背景介绍。

### 验证动作

写一个最小 skill，只允许读取两个文件并运行一个测试；检查模型在未调用 skill 时是否能看到完整正文，调用后是否获得正确参数、工具范围和验证要求。

## Section 23｜前台、后台与状态机如何协作

### Claude Code：Task 描述执行实例与协作事项两条轴

23 区分 Task 的执行实例和协作事项：统一状态规定生命周期，但不规定执行算法。创建时生成安全 ID 并注册到 AppState；前台等待和后台运行共用执行实例；状态放内存，大输出放文件；结果优先读取 output file；终态通知再把后台结果送回模型；取消按类型派发；`notified` 控制终态消费。

这个设计避免把“后台”误解为 fire-and-forget。后台任务仍必须可观察、可取消、可回收，并且终态只被消费一次。Task prompt 规定的是状态推进协议，不是让模型自己管理进程。

### Codex CLI：turn、exec process 和 queue 是不同状态

Codex 的一个 turn 可以等待多个执行进程；进程有自己的 running/exited/cancelled 状态，item/turn 则有更高层的生命周期，App Server 队列还受背压影响。把这几层合成一个 boolean，会丢失“命令结束但结果尚未发送”或“客户端断开但执行仍在”的情况。

### Pi：工具执行与 session event 连接

Pi 可以执行长任务并通过事件流报告 progress，coding-agent 再把输出保存或展示。后台化能力通常由宿主/扩展提供，而不是 agent core 默认承诺。若要在 UI 关闭后继续，需要明确持有进程、session 和结果文件的组件。

### 对比结论

Claude Code 把 task 生命周期作为应用级状态机；Codex 把 turn/item/process/queue 分层；Pi 把长任务控制留给宿主。判断后台能力时应问：谁持有进程，谁保存大输出，谁发送终态，谁处理客户端断连。

### 验证动作

启动一个超过 30 秒的只读命令，分别测试前台等待、转后台、取消、客户端退出后重新连接。确认结果不会重复回流，也不会因为 UI 消失而丢失。

## Section 24｜如何隔离上下文并委派任务

### Claude Code：Subagent 是独立 Query Loop

24 明确区分 `CLAUDE.md` 与 Agent 定义：前者是项目上下文，后者描述可委派的角色、模型、system prompt、工具集合和权限。Agent 工具把委派意图变成明确输入，`createSubagentContext()` 隔离可变状态但保留必要回路；普通 subagent 与 Fork 的上下文边界不同。

前台路径边运行边汇报，最后返回 tool_result；后台路径先注册 `LocalAgentTask`，结果稍后回流。工具集合和权限是两道门，父 Agent 不应把自己的全部上下文和临时授权无条件复制给子 Agent。子任务 prompt 还规定工具清单和 context cache 边界。

### Codex CLI：subtask 更像新的 turn/runtime

Codex 可以通过 app-server 或宿主启动新的 thread/turn，让子工作获得独立上下文和 sandbox/approval profile。关键是新 thread 是否继承 workspace、instructions、环境和权限，以及结果如何回到父 turn；这些必须由 host protocol 明确，而不是用一段 prompt 模拟隔离。

### Pi：subagent 可由扩展或 coding-agent 组合

Pi 的 core 没有把多 Agent 绑定成单一产品策略；扩展可以创建另一个 agent loop，给它不同 provider、tools 和 context，再将结果作为 tool/event 返回。它的灵活性适合研究和定制，但隔离程度取决于是否真正创建新 session、工具集合和进程边界。

### 对比结论

委派的关键不在“开了几个模型”，而在四个边界：上下文是否独立、工具是否收窄、权限是否重建、结果是否结构化回流。Claude Code 对四点都有明确运行时位置；Codex 依赖 thread/host protocol；Pi 依赖上层组合。

### 验证动作

委派一个只读审查任务，检查子 Agent 是否能看到父任务的私密上下文、能否写文件、是否能访问同一网络、返回后父 Agent 是否能区分事实与建议。

## Section 25｜多个智能体如何协作与协调

### Claude Code：Team 在 subagent 之上增加持久控制面

25 的 Team config 建立身份和共享命名空间；成员后端可以不同但协作协议一致；Task list 把讨论变成所有权；Mailbox 同时承载业务消息和控制协议；Coordinator 受工具白名单约束并负责综合；最终收敛由依赖、验证结果和成员终态共同决定。

Team prompt 不是“请大家合作”一句口号，而是命名、领取、汇报、阻塞和交接的协议。父 Agent 最后必须验收成员结果，不能把“所有成员都说完成”当成系统正确。

### Codex CLI：多 Agent 更依赖宿主编排

Codex 的 thread/turn/app-server 适合让宿主管理多个独立 thread；共享工作区、worktree、审批和结果合并由 host 层决定。官方 harness engineering 的 worktree、日志和结构化验证思路可以作为协调基础，但不能把多个 turn 自动等同于 team protocol。

### Pi：Mailbox/任务列表通常由扩展实现

Pi 的扩展可以注册 team/task 工具，或把多个 agent session 连接起来。共享文件、消息和结果聚合由应用负责，核心 loop 只保证各自的请求—工具—结果闭环。好处是可以尝试不同协调算法；代价是没有一个默认的“所有权/依赖/终态”标准。

### 对比结论

Claude Code 把多 Agent 协作做成带命名空间和消息协议的控制面；Codex 提供适合编排的 thread/turn 基础；Pi 提供可自定义的 agent primitives。多 Agent 的主要风险是共享状态冲突和结果责任不清，而不是并发数量不足。

### 验证动作

创建两个有依赖的任务，让一名成员修改、另一名成员审查；强制出现一次阻塞和一次重复领取，检查系统是否能识别所有权、传递阻塞原因、禁止冲突写入并要求 coordinator 验收。

## Section 26｜Plan Mode 与 Worktree 如何隔离规划与执行

### Claude Code：两种隔离解决两个问题

26 把 Plan Mode 的权限状态隔离和 Worktree 的独立目录隔离分开。Plan mode 先保存旧模式，再切到 `plan`；只读不仅是提示词，还叠加工具权限；`/plan` 与模型工具走同一状态；退出时普通会话问用户，teammate 询问 leader。Worktree 创建前验证 slug，优先 Hook、回退 Git，进入新 cwd 后让依赖缓存失效，清理 fail-closed。

Plan 是“暂时不允许副作用”，worktree 是“允许副作用但不污染主目录”。把两者组合起来，才能先产出计划，再在隔离目录执行；任一机制都不能替代另一机制。

### Codex CLI：approval/sandbox 与 worktree 是不同层

Codex 可以通过 approval profile、sandbox profile 或宿主工作树隔离控制执行范围。sandbox 限制进程能做什么，worktree 限制文件改动落在哪里；计划文本和 AGENTS.md 约束模型如何推进。若只换 cwd 而不重建缓存/指令，模型仍可能带着旧环境认知工作。

### Pi：plan/worktree 通常由命令和扩展提供

Pi 的 session branch、project command 和 Git/worktree 工具可以组成规划—执行流程；但 core 不强制 plan mode 或独立目录。宿主需要把“只读计划”和“可写实现”设置成不同的工具集合/权限，再在切换 cwd 后刷新 session/context。

### 对比结论

Plan Mode 是控制权限和意图，Worktree 是隔离文件状态。Claude Code 把两者写进运行时；Codex 由 host/sandbox/workspace 组合；Pi 由应用编排。不要把“模型先输出计划”误写成真正的只读阶段，真正的判断在工具授权。

### 验证动作

在计划阶段尝试写文件、启动网络命令和修改配置；在 worktree 阶段执行同样动作并检查主目录。再切换目录后确认 cwd、缓存、工具输出和验证命令全部更新。

## Section 27｜如何连接外部工具与资源

### Claude Code：MCP 是带生命周期的协议连接

27 先按配置决定 transport 和作用域，再用五态连接状态管理启动/握手/可用/断开/失败；server tool 变成本地 Tool，资源不直接塞进 system prompt，而是按需读取；调用仍要过工具权限和 MCP 自身边界。认证、断线和失败也有独立出口。

MCP prompt 的“空壳”不能直接当作 server 能力。只有连接状态、工具清单、资源读取和权限都闭环，外部能力才真正存在。

### Codex CLI：MCP/外部工具进入 host protocol

Codex 可以让宿主把外部工具、远程服务或 MCP-like provider 暴露给 thread；工具调用仍需经过 approval、sandbox、网络 proxy 和结果回填。将远程工具接入 JSON-RPC 的好处是客户端无需知道连接细节，代价是要处理超时、认证、断线、版本和背压。

### Pi：扩展/API 连接点更开放

Pi 可以通过 extensions 注册远程 API、文件资源或项目工具，统一成 tool/event。它不强制某一个外部协议，因此集成成本低；安全、重试、secret 和连接生命周期则必须由扩展和宿主自己维护。

### 对比结论

外部工具的集成难点不是“能不能发 HTTP”，而是如何把连接状态、能力发现、认证、失败、权限和审计接回本地 agent loop。Claude Code 提供最完整的协议适配层；Codex 提供可跨宿主的执行/事件边界；Pi 提供最自由的扩展面。

### 验证动作

让外部 server 在启动、握手、工具调用、资源读取、断线和重新连接时分别失败一次，观察 agent 是否得到可区分的状态，而不是一个含糊的“工具不可用”。

## Section 28｜插件系统如何扩展能力并守住信任边界

### Claude Code：插件生效需要三层状态

28 把 plugin 状态分成安装/来源作用域、版本化缓存/manifest、当前会话 reload。manifest 是受约束的组件索引，从插件目录可以得到 command、skill、MCP server、LSP 等六类运行时组件；安装成功后还要 reload，当前会话才看得到。

信任边界分布在来源、文件和组件运行时：插件不是一份无害 Markdown，里面可能注册工具、启动 server、改变 prompt。更新和禁用也需要完整生命周期，不能只删除一个目录或修改一行配置。

### Codex CLI：插件/skills 的信任由 host 与项目约束承担

Codex 的能力可以由项目 instructions、skills、外部工具和宿主插件提供；是否自动加载、是否允许执行、怎样缓存版本取决于 host。最重要的设计是把“发现了组件”和“当前 turn 可以使用组件”分开。

### Pi：扩展加载简单，但同进程信任风险直接

Pi 的 extensions loader 发现并加载模块，`registerTool`/事件 API 让能力进入 runtime。项目 trust 可以控制资源加载，但已加载扩展通常与 agent 共享进程权限。因此扩展包来源、依赖、版本和可禁用性需要应用明确治理。

### 对比结论

Claude Code 把插件当成生命周期对象；Codex 把插件/skills 当作 host 能力来源；Pi 把扩展当作可组合代码。越接近同进程加载，越需要在“安装、启用、运行、升级、卸载”五个阶段分别做审计。

### 验证动作

安装一个只提供 skill 的插件和一个注册工具的插件，分别观察 manifest、缓存、reload、permission 和 disable 是否更新。卸载后重启并确认旧工具不会从缓存残留。

## Section 29｜LSP 如何为 Agent 提供代码智能

### Claude Code：LSP 是插件提供的语义辅助证据

29 明确区分文本匹配与语言语义。LSP 配置只来自已启用插件，Manager 先建路由，第一次使用时才启动 server；spawn、initialize、initialized 构成握手；didOpen/didChange 同步文档；主动操作最终变成 tool_result；publishDiagnostics 则进入 attachment 收集。失败时 LSP 只是可降级辅助证据。

LSP prompt 固定坐标与操作契约，避免模型把“定义跳转”理解成任意搜索。诊断版本不强求完全一致，是为了在异步 editor/server 环境中保持可用性。

### Codex CLI：代码智能可由工具与环境提供

Codex 的 harness engineering 重点是可读环境和验证；语言服务可以作为 app/IDE host 或外部 tool 接入。IDE 负责文档同步和诊断，agent 通过结构化结果使用；CLI 没有 IDE 时可降级为 grep、编译器和测试。

### Pi：LSP 通常是扩展或外部工具

Pi 的扩展可以连接语言 server，注册 definition/reference/diagnostics 工具，再把结果作为 tool_result 或附件回流。由于 core 不强制 LSP 协议，项目可以选择轻量文本搜索，也可以接完整语言服务。

### 对比结论

LSP 的价值是提供结构语义和可定位证据，不是替代搜索。Claude Code 把它做成受插件和生命周期管理的辅助面；Codex 让 IDE/host 提供代码智能；Pi 把它留给扩展生态。三者都应有降级路径，不能让语言 server 一次启动失败拖垮主 loop。

### 验证动作

对同一符号分别做文本搜索、definition、references 和 diagnostics；让 server 延迟/崩溃一次，确认 agent 仍能使用搜索、编译或测试继续工作，并且错误说明了证据可靠性下降。

## Section 30｜浏览器与 IDE 如何接入运行时

### Claude Code：宿主差异停在协议边缘

30 先区分 Grep、LSP、RAG，再让 IDE 通过 lockfile 发现连接，自动连接只是添加动态 MCP 配置；握手后能力才存在；选区和文件上下文通过通知更新；反向操作通过 RPC 发送，结果重新解释。Chrome 复用 MCP，但连接拓扑不同，配对、权限模式、站点权限是三道门。

普通外部客户端共享协议，不共享信任。浏览器消息和工具结果仍需经过结构化边界，不能因为来自 UI 就跳过 agent 工具契约。

### Codex CLI：App Server 让 IDE 成为一等客户端

Codex 的 JSON-RPC/App Server 本身就是 IDE 接入层：客户端订阅 thread/turn/item，发送用户输入、审批和取消，宿主提供当前文件/选区等 context。执行仍留在受控 runtime，UI 只展示或发起控制请求。

### Pi：TUI、RPC 和扩展共同构成宿主边缘

Pi 的事件流和扩展 API 可以让 IDE/browser 把现场翻译成 tool/input，再把结果渲染回编辑器。由于没有统一的远程安全边界，接入方必须处理配对、origin、凭证、权限和进程隔离。

### 对比结论

Claude Code 通过 MCP/bridge 把外部宿主隔离在协议边缘；Codex 通过 App Server/JSON-RPC 把多客户端正式化；Pi 通过事件与扩展保持自由。外部宿主的真正难题是“谁拥有信任”，不是“能不能传一条消息”。

### 验证动作

让 IDE 选区、浏览器页面和普通 RPC 客户端分别发起同一个工具调用，确认它们的身份、权限、资源范围和结果回流路径不同且可审计。

## 这一主题的共同答案：扩展要有四个契约

一个扩展、skill 或 subagent 只有在四个契约都清楚时才算完成接入：

1. 发现契约：从哪里发现、何时加载、版本和作用域是什么。
2. 能力契约：模型能看到什么 schema、prompt、资源和事件。
3. 信任契约：哪些文件、网络、进程和用户操作可以被影响。
4. 生命周期契约：启动、调用、失败、取消、reload、禁用和恢复怎样发生。

Claude Code 把这些契约做成较完整的产品运行时；Codex 把一部分放进 host protocol 和 sandbox；Pi 给开发者最大的组合自由，也把治理责任推回宿主。

## 本主题覆盖清单

本篇覆盖 21、22、23、24、25、26、27、28、29、30，共 10 个独立 comparison sections。主题 01–04 累计覆盖 32 个 Claude Code 章节。

## 下一篇

扩展和多 Agent 解决“能力从哪里来、怎样协作”。下一篇把镜头拉回宿主：AppState、TUI、快捷键和结构化 IO 怎样把运行时状态变成用户可操作的产品。
