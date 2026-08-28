---
title: "Agent主题对比06｜扩展能力应该装插件还是改运行时"
published: 2026-08-12T10:06:00+08:00
updated: 2026-08-28
description: "从插入位置、作用域、生命周期和信任边界比较 Claude Code、Codex、Pi 与 DeepSeek Harness 的扩展方式。"
tags: ["agent-theme-comparison", "ai-agent", "claude-code", "codex-cli", "pi", "deepseek-harness", "plugins", "mcp"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-06-configuration-operations/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-06-configuration-operations"
series: "agent-theme-comparison"
order: 6
difficulty: "advanced"
time: "20 min"
prerequisites:
  - "Agent主题对比 02｜一次 Agent 任务怎样跑完"
  - "Agent主题对比 05｜CLI、IDE 与云端由谁持有状态"
topics:
  - "extension architecture"
  - "skills and instructions"
  - "hooks and events"
  - "MCP"
  - "plugins and providers"
  - "lifecycle and scope"
  - "trust boundary"
  - "DeepSeek Harness"
status: "verified"
verified_at: "2026-08-28"
---

答案是：先按插入位置选扩展，再考虑是否改运行时。项目规则放持久说明，按需知识放 Skill，外部数据与动作走工具或 MCP，确定性拦截放 Hook 或事件处理器。只有当 session、agent loop、provider 或 sandbox 本身不符合需求时，才值得替换运行时组件。

团队想让 Agent 查询内部数据库、遵守迁移规范，并在执行写操作前走自定义审批。把三件事全塞进一个“大插件”当然能跑，却很难回答：规则何时加载，数据库凭据给了谁，审批在模型决定前还是工具执行前触发，插件卸载后连接是否关闭。

扩展项数量没有比较价值。真正决定风险和维护成本的是四个问题：插在哪里，影响谁，活多久，信任到哪里。

插入位置决定扩展能改变什么。

持久说明进入模型上下文，改变它如何理解任务；Skill 在需要时提供知识或流程；工具与 MCP 增加可执行动作；Hook 和事件处理器在固定生命周期点观察、修改或阻止行为；provider 改变模型调用；替换 session 或 loop 则改变 Harness 的运行语义。

这几层不能互相冒充。把数据库 schema 写进说明文件，不会凭空产生查询能力。用 Skill 告诉模型“每次修改后运行 lint”，也不等于 lint 一定执行。反过来，Hook 可以在每次编辑后启动命令，但它不负责向模型解释业务规则。Anthropic 的扩展总览把 `CLAUDE.md`、Skills、MCP、subagents、hooks 和 plugins 放在不同加载点，正是为了区分这些责任。[Extend Claude Code](https://code.claude.com/docs/en/features-overview)

一个简单判断法是看事故模型：担心模型忘记约定，用可审计的持久说明；担心大段知识占满上下文，用按需 Skill；担心没有外部能力，增加工具；担心某个动作必须被检查，用模型无法随意跳过的执行拦截；担心整个调度语义不合适，才动 loop 或 session。

## Claude Code：扩展组件分层，再由插件打包

Claude Code 官方文档给每种扩展安排了明确位置：`CLAUDE.md` 在会话中提供持久项目说明；Skill 保存可复用知识与工作流，完整内容在调用时加载；MCP 连接外部服务；Hook 在工具执行、会话、权限请求或压缩等事件发生时运行。[Extend Claude Code](https://code.claude.com/docs/en/features-overview)

Plugin 是分发层，不是新的执行语义。一个插件可以打包 Skills、agents、hooks、MCP 和 LSP 配置，适合跨项目或团队版本化复用；个人或单项目试验也可以直接放在 `.claude/` 下。[Create plugins](https://code.claude.com/docs/en/plugins) 因而，“装插件”只说明交付方式，真正的信任边界仍要逐项检查。

例如，一个只含 Skill 的插件主要把文本带进上下文；包含 Hook 的插件可以启动外部进程；包含 MCP server 的插件可能访问数据库或 SaaS；带可执行文件的插件还会把程序加入 Bash 工具可见的路径。[Claude Code plugin structure](https://code.claude.com/docs/en/plugins) 安装前应审查每类组件，而不是看到统一的插件清单就一次性授权。

Claude Code 的路线适合希望在完整产品工作台中增量扩展的团队。它没有要求你为加一套部署流程就替换 agent loop，减少了运行时分叉；代价是复杂扩展会跨越上下文、事件和外部服务多层配置，需要单独测试每层失效时的表现。

## Codex：说明、Skill、MCP 与 Harness 接口各负其责

Codex 在任务开始时读取 `AGENTS.md`，并按全局到项目目录的层级构建指令链；更具体目录中的说明覆盖更宽范围的约定。[Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md) 这种机制适合保存仓库规则和命令约定，但它仍是上下文，不是强制执行门禁。

Codex 的 Skills 用于打包可发现的说明、脚本和资源，让模型按任务选择或由用户明确调用；MCP 则把外部工具和上下文接入 Codex。[Build skills](https://developers.openai.com/codex/skills)；[Model Context Protocol](https://developers.openai.com/codex/mcp) 如果数据库写入必须审批，可靠边界应该落在工具权限、MCP 服务端或 Harness 审批路径，而不是只在 Skill 里写一句“请先询问”。

需要自建客户端时，Codex App Server 提供双向 JSON-RPC：客户端接收 item 生命周期事件，服务端可以发起审批并暂停 turn。[Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/) 这是宿主集成面，不应和“给模型增加一段知识”的 Skill 混为一层。

Codex 的取向是保留一套可复用 Harness，再通过说明、Skills、MCP 和 App Server 扩展不同责任。是否需要改 Codex core，应由现有接口挡不住的具体事故来证明。若只是新增团队规则或外部工具，先扩展稳定表面通常更容易升级和审计。

## Pi：Extension 直接进入行为与事件层

Pi 把 core 保持精简，把大量定制留给 TypeScript extensions。官方文档说明 extension 可以注册工具与命令、订阅 Agent 和 session 事件、修改上下文、拦截工具调用，也可以提供 UI；SDK 的 ResourceLoader 能从用户、项目或显式路径加载它们。[Pi Extensions](https://pi.dev/docs/latest/extensions)；[Pi SDK](https://pi.dev/docs/latest/sdk)

这种能力很直接。你可以在 `tool_call` 事件检查命令并阻止执行，也能在 `context` 事件返回修改后的消息，在 session shutdown 时释放自己打开的资源。[Pi Extensions events](https://pi.dev/docs/latest/extensions) 代价同样直接：extension 是运行在宿主进程中的代码，不是受限提示文本。它能接触什么，取决于进程权限和你暴露的 API。

Pi 也支持 Skills、prompt templates 和项目上下文文件，但它的鲜明取向是让使用者自己塑造 Harness。项目主页称 Pi 为 minimal agent harness，README 解释精简 core 是为了让扩展适配工作流。[Pi](https://pi.dev/)；[Pi coding agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md) 这是一项设计取舍，不证明扩展后的系统更快、更安全或更容易维护。

选择 Pi 时，团队需要自己定义扩展的版本、加载顺序、错误隔离和升级测试。它很适合愿意拥有这部分工程责任的人；只想安装经过产品化整合的功能时，这份自由会变成运维工作。

## DeepSeek Harness：连 loop 与 session 也放进插件树

DeepSeek Harness 对“插件”的定义更深。其架构文档声称 model adapter、tool registry、session log 和 agent loop 都是 Cordis plugins，运行实例由 profile、bundles 与有序 patch 组合成一棵 plugin tree；`dsh-base` 还装配持久化、sandbox、approval、settings、credentials 与 telemetry。[DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

“一切皆插件”在这里意味着没有一个特权 core 等着手工打补丁：扩展可以把新插件装到同一上下文中，也可以通过配置替换既有行。Cordis 文档称服务、类型化事件和可逆 effects 由共享 context 管理；注册会在所属插件卸载时撤销，外部资源需要显式 disposer。[Cordis lifecycle and effects](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md)

作用域也不只是一份配置文件。Cordis context 可以派生子 context、隔离服务或拦截解析，而不修改父 scope。[Cordis Context](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/context.md) 从架构上看，这给 provider、工具、会话和 UI 的局部替换提供了共同模型。

这些都是项目公开的架构主张，不能写成“Cordis 已证明插件不会泄漏资源”或“替换 loop 后性能更高”。可替换面越深，组合错误、版本漂移和安全审查面也越大。DeepSeek Harness 仍处于 developer preview，README 预告会有兼容性破坏；`SAFETY.md` 明确说明项目未经过安全审计，不能视为生产就绪或不可信任务的唯一安全控制。[README](https://github.com/deepseek-ai/deepseek-harness)；[SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)

## 作用域、生命周期和信任要一起看

同一种扩展放在用户级、项目级和组织级，影响面完全不同。项目说明可以随仓库审查，用户级配置会跨项目生效；MCP server 可能位于本机，也可能由外部团队运营；进程内 extension 与宿主共享权限；可替换 sandbox 插件甚至会改变安全边界本身。

生命周期决定故障是否会残留。一次性 Skill 用完后主要留下上下文成本，长期连接需要断线与凭据轮换，Hook 要处理超时与重复触发，session 插件要保证记录可读和迁移。Cordis 提供 effects 随插件卸载撤销的架构约定，Pi 提供 session shutdown 等事件，Claude Code hooks 在固定生命周期点触发。[Cordis lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md)；[Pi Extensions](https://pi.dev/docs/latest/extensions)；[Claude Code Hooks](https://code.claude.com/docs/en/hooks-guide)

信任审查应按能力而不是名字做。Markdown Skill 可能诱导高风险动作，MCP 工具可能直接写生产数据，Hook 和进程内插件可以运行代码，provider 会接触提示与凭据，sandbox 扩展则决定工具究竟能碰什么。扩展框架提供插入点，不会替你证明第三方扩展可信。

团队还应保存一份扩展清单：来源与版本、加载作用域、所需凭据、能触发的副作用、卸载方式和负责人。每次升级先在隔离任务中验证加载顺序、失败降级与资源释放。否则，某个扩展被删除后，遗留的 Hook、后台进程或长期令牌仍可能继续影响任务，表面上的“已卸载”并没有恢复原边界。

## 什么时候该改运行时

先用最浅、最容易撤销的层解决问题。团队约定写进可审查说明；大量按需知识做成 Skill；数据库和工单系统接成范围受控的 MCP 或工具；每次都必须执行的检查放到 Hook、事件处理器或服务端策略。只有现有 session 无法表达你的事件、审批无法覆盖事故点、provider 接口不兼容，或 loop 的停止与调度语义根本不合用时，才替换运行时组件。

Claude Code 在工作台内组合多种扩展；Codex 以 AGENTS.md、Skills、MCP 和 App Server 覆盖从上下文到客户端集成；Pi 让 TypeScript extension 深入行为和事件层；DeepSeek Harness 把可替换边界推进到 loop、session 与 sandbox。[Claude Code extension overview](https://code.claude.com/docs/en/features-overview)；[Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)；[Pi Extensions](https://pi.dev/docs/latest/extensions)；[DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 选择的不是“插件多不多”，而是你愿意维护多深的插入点。

验收时可以拿同一事故做测试：撤销插件后资源是否释放，项目级配置会不会污染其他仓库，断开 MCP 后模型是否知道工具消失，Hook 失败时动作是否继续，替换 sandbox 后最坏损失是否仍由外部隔离限制。答不清具体事故与现有机制为何不足，就没有理由再加一层扩展。

下一篇会讨论另一种常见扩展：把任务交给 subagent、团队或跨产品工作流时，究竟是在委派工具，还是在搭建组织系统。

## 资料来源

- [Claude Code：Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- [Claude Code：Create plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code：Automate workflows with hooks](https://code.claude.com/docs/en/hooks-guide)
- [OpenAI：Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [OpenAI：Build skills](https://developers.openai.com/codex/skills)
- [OpenAI：Model Context Protocol](https://developers.openai.com/codex/mcp)
- [OpenAI：Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi：Extensions](https://pi.dev/docs/latest/extensions)
- [Pi：SDK](https://pi.dev/docs/latest/sdk)
- [Pi：Coding Agent](https://pi.dev/)
- [Pi Coding Agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)
- [DeepSeek Harness：Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness：Cordis lifecycle and effects](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md)
- [DeepSeek Harness：Cordis Context](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/context.md)
- [DeepSeek Harness：README](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness：SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
