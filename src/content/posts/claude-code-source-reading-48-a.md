---
title: "Claude Code源码解读48-a：五层工程体系——Prompt、Context、Harness、Loop、Graph"
published: 2026-08-04
updated: 2026-08-04
description: "从 Prompt、Context、Harness、Loop 与 Graph 五个层次，理解 Claude Code 如何组织上下文、执行边界、持续循环和多 Agent 协作。"
tags: ["claude-code", "source-code", "ai-agent", "engineering"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-48-a/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 关键结论（Key Takeaways）

- **五层是嵌套而不是并列**，Prompt 控制「怎么说」，Context 控制「知道什么」，Harness 控制「如何安全持久可观测地运营」，Loop 控制「何时再跑、何时停止」，Graph 控制「多个节点如何组织」。外层包含内层，每一层控制不同的对象。
- **控制权迁移是主线**，从 2022 年人写 prompt，到 2026 年人写循环让 AI 自己 prompt 自己，每一次范式升级，都是把原来由人的注意力承担的控制交给系统承担。Boris Cherny「我不再 prompt Claude 了」的表述是这条主线的标志。
- **每一层都有源码证据**，Prompt 落在 `getSystemPrompt()` / `fetchSystemPromptParts()`，Context 落在 `queryLoop()` 的五级压缩链，Harness 落在 `PermissionContext` / `executeHooks()` / queryLoop 状态机，Loop 落在 `/loop` / `/goal` 与 Cron，Graph 落在 subagent / Agent Teams / Workflow 工具。
- **诊断顺序与建设顺序相反**，故障排查先问「哪一层失守」，能力积累却要从内向外补，先写清楚 prompt 和 CLAUDE.md，再配 hook 与权限，最后才设计循环与图。
- **五层框架比源码版本稳定**，本系列的证据边界停在 2.1.88，文件会移动、符号会改名，但「输入在哪一层被改写、权限在哪一层被拒绝、状态在哪一层丢失、结果在哪一层没有抵达受众」的责任边界不变。

## 问题

上一篇（48）用一张系统图回答了「Claude Code 由哪些边界组成」。这篇可选补充要回答一个更基本的问题，**「Claude Code 是不是一个大 prompt」这句话错在哪里？Prompt、Context、Harness、Loop、Graph 五层之间到底是什么嵌套关系？**

答案先放在前面，**prompt 只是五层嵌套体系的最内层。把 Claude Code 说成「一个大 prompt」，等于把五层边界压缩成一层**，它解释不了「为什么模型想调用工具却被权限拒绝」（Harness），解释不了「为什么上下文塞满后模型开始忘事」（Context），也解释不了「为什么同一个任务可以被 `/loop` 挂起来反复执行直到收敛」（Loop）。五层的正确关系是嵌套，不是并列，

```text
Graph（空间结构：节点怎么拆、怎么连）
  └─ Loop（时间节奏：何时再跑、何时停止）
      └─ Harness（确定性边界：安全、持久、可观测地执行）
          └─ Context（模型视野：这一轮窗口里看到什么）
              └─ Prompt（文本表达：进来的内容怎么说）
```

外层包含内层，一个 Graph 节点内部跑着自己的 Loop，每个 Loop 的每一轮都要经过 Harness 的执行边界，Harness 决定模型看到哪些 Context，而 Context 决定哪些 Prompt 文本真正进了窗口。下面每一层的判断，都落在 `@anthropic-ai/claude-code@2.1.88` 的还原源码上。

## 正文

### 先建立三个概念

- **五层嵌套关系**，Prompt 在最内层，Context 决定模型看到什么，Harness 守住执行边界，Loop 控制时间节奏，Graph 组织空间结构。外层包含内层，每一层控制不同的对象。
- **控制权迁移**，从 2022 年人写 prompt，到 2026 年人写循环让 AI 自己 prompt 自己，每一次范式升级，都是把原来由人的注意力承担的控制，交给系统承担。
- **源码证据优先**，下面每个判断都落在 `@anthropic-ai/claude-code@2.1.88` 的具体文件和函数上。概念框架来自社区讨论和学术论文，实现证据来自 source map 还原的 TypeScript 源码。

这三件事决定本文的读法，先看每一层控制什么对象，再看 Claude Code 源码里谁在实现它，最后判断你现在最需要补哪一层。

### 为什么是这五层

2026 年上半年，AI 编程工具从「写 prompt 让模型干活」迅速演进到「写循环让 AI prompt AI」。Anthropic Claude Code 负责人 Boris Cherny 说过一句被反复引用的话，

> 我不再 prompt Claude 了。我有循环在运行，这些循环 prompt Claude 并决定要做什么。我的工作是写循环。

这句话把五层工程的嵌套关系说清楚了。Prompt 是内容，Context 是信息边界，Harness 是安全运行的确定性约束，Loop 是何时再跑的时序控制，Graph 是多个工作单元怎么拆、怎么连。

网上很多文章把这五层讲成了产品理念，但 Claude Code 2.1.88 的 4756 个 source map 条目给出了它们的具体实现。下面从源码出发，一层一层看。

### 第一层 Prompt Engineering｜控制「怎么说」

一句话定位，**优化文本措辞，让模型理解并服从。**

控制对象是上下文窗口内的文本表达，指令措辞、角色设定、Few-shot 示例、输出格式约束。它不负责「哪些内容进入模型眼睛」，只负责「进了眼睛的内容怎么表达」。

#### 在 Claude Code 源码里怎么看

入口在 `restored-src/src/constants/prompts.ts` 的 `getSystemPrompt`。它返回 `SystemPrompt` 类型，`readonly string[]`，不是随便拼出来的字符串。稳定前缀、动态区块与缓存边界保持可追踪。

`restored-src/src/utils/queryContext.ts` 的 `fetchSystemPromptParts` 把原料分成三路并行准备，

```ts
const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
  customSystemPrompt !== undefined
    ? Promise.resolve([])
    : getSystemPrompt(tools, mainLoopModel, additionalWorkingDirectories, mcpClients),
  getUserContext(),
  customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext(),
])
```

三条通道在请求前合并，system prompt 承载身份和行为边界，user context 承载 CLAUDE.md 和项目规则，system context 承载 git 状态和环境信息。分开准备才能让稳定前缀保持缓存命中，动态内容独立更新。

CLAUDE.md 的加载层级也是 Prompt Engineering 的一部分。从最低到最高优先级，`/etc/claude-code/CLAUDE.md` → `~/.claude/CLAUDE.md` → `project-root/CLAUDE.md` → `project-root/.claude/CLAUDE.md` → `.claude/rules/*.md` → `CLAUDE.local.md`。每一层都在回答「怎么说」。

#### 判断口诀

问「怎么说」 → Prompt Engineering。问「知道什么」 → 下一层。

### 42 个 `*prompt.ts` 文件对应哪篇文章

这次按大小写不敏感的 `*prompt.ts` 文件名匹配，共得到 42 个文件。它们不是 42 套互相独立的“大 prompt”，而是分散在工具契约、输入路由、上下文压缩、协作协议和宿主适配边界上的小型行为协议。下面按本系列主文章归档；同一工具在运行时可能被另一篇文章再次引用，但只列一个主归属，避免重复解释。

| 主文章 | 对应的 `prompt.ts` | 这组 prompt 补上的源码证据 |
|---|---|---|
| 09 工具契约与注册表 | `src/tools/ToolSearchTool/prompt.ts` | deferred tool 目录、`select:<name>` 选择语法与二级 Schema 装配 |
| 13 沙箱与 Bash 安全 | `src/tools/BashTool/prompt.ts`、`src/tools/PowerShellTool/prompt.ts` | timeout、后台任务、sandbox、git、PowerShell edition 与专用工具路由 |
| 14 文件工具与回滚 | `src/tools/FileReadTool/prompt.ts`、`FileEditTool/prompt.ts`、`FileWriteTool/prompt.ts`、`NotebookEditTool/prompt.ts` | Read-before-Write、2000 行读取上限、唯一替换与 notebook cell 操作 |
| 15 搜索与检索工具 | `src/tools/GlobTool/prompt.ts`、`GrepTool/prompt.ts`、`WebFetchTool/prompt.ts`、`WebSearchTool/prompt.ts` | 本地搜索分工、Sources 链接、15 分钟缓存与 125 字符引文边界 |
| 16 System Prompt 与项目上下文 | `src/utils/systemPrompt.ts` | override、coordinator、agent、custom、default、append 的最终优先级 |
| 17 上下文压缩 | `src/services/compact/prompt.ts` | 无工具摘要、`from/up_to` 方向、摘要清洗与 transcript 恢复提示 |
| 21 命令系统 | `src/utils/processUserInput/processTextPrompt.ts` | 字符串/内容块归一化、图片拼接、prompt id 与 OTEL 观测 |
| 22 Skill 系统 | `src/tools/SkillTool/prompt.ts` | 1% 上下文预算、250 字符描述上限、bundled 与非 bundled 渐进披露 |
| 23 Task Runtime | `src/tools/TodoWriteTool/prompt.ts`、`TaskCreateTool/prompt.ts`、`TaskGetTool/prompt.ts`、`TaskListTool/prompt.ts`、`TaskStopTool/prompt.ts`、`TaskUpdateTool/prompt.ts` | 任务状态、依赖、所有权、完成与后台停止的模型侧协议 |
| 24 Subagent 委派 | `src/tools/AgentTool/prompt.ts` | agent allow/deny 交集、列表 attachment、fork 上下文和 cache 边界 |
| 25 Agent Teams 与 Coordinator | `src/tools/TeamCreateTool/prompt.ts`、`TeamDeleteTool/prompt.ts`、`SendMessageTool/prompt.ts` | 团队创建/清理、成员命名、广播与结构化协作消息 |
| 26 Plan Mode 与 Worktree | `src/tools/AskUserQuestionTool/prompt.ts`、`EnterPlanModeTool/prompt.ts`、`ExitPlanModeTool/prompt.ts`、`EnterWorktreeTool/prompt.ts`、`ExitWorktreeTool/prompt.ts` | 澄清、计划审批、显式 worktree 意图与脏目录清理 |
| 27 MCP 集成 | `src/tools/MCPTool/prompt.ts`、`ListMcpResourcesTool/prompt.ts`、`ReadMcpResourceTool/prompt.ts` | 静态空壳、运行时覆盖、server/URI 资源读取 |
| 29 LSP 集成 | `src/tools/LSPTool/prompt.ts` | 九种语言服务操作与 1 起始坐标契约 |
| 30 Browser、IDE 与外部工具 | `src/utils/claudeInChrome/prompt.ts` | tab context、旧 ID、dialog、console、录制和真实 Chrome 宿主规则 |
| 35 Settings、Config 与 Feature Flags | `src/tools/ConfigTool/prompt.ts` | 从 `SUPPORTED_SETTINGS`、GrowthBook 和模型列表动态生成帮助 |
| 37 Bridge、Remote 与 Server | `src/tools/RemoteTriggerTool/prompt.ts` | CCR remote agent 控制动作与进程内 OAuth 边界 |
| 42 AutoDream | `src/services/autoDream/consolidationPrompt.ts` | Orient、Gather、Consolidate、Prune/index 四阶段记忆整合 |
| 43 Assistant/KAIROS | `src/tools/BriefTool/prompt.ts`、`ScheduleCronTool/prompt.ts`、`SleepTool/prompt.ts` | proactive 出口、未来 prompt、调度式等待 |
| 44 Buddy Experience | `src/buddy/prompt.ts` | 一次性 companion attachment 与主 Agent 发言限制 |
| 47 Notifications、Mailbox 与 Output Styles | `SendMessageTool/prompt.ts`、`BriefTool/prompt.ts`（跨章节复用） | 消息可见性、normal/proactive 出口与受众路由 |

因此，查看某个 prompt 文件时，先按上表进入主文章，再沿着 prompt.ts 的调用方追到执行器。另有一个相邻但不计入本次匹配的文件：src/memdir/teamMemPrompts.ts 文件名是复数，它属于第 41 篇的团队记忆协议，不能因为不匹配单数 *prompt.ts 就漏掉。

### 第二层 Context Engineering｜控制「模型知道什么」

一句话定位，**策划和维护最优 token 集，决定什么内容该进、该砍、何时注入。**

这是现阶段 Claude Code 源码中实现密度最高的一层。提示词写得再好，进不了上下文窗口也白搭；提示词写得很烂但上下文干净，往往还能出活。

#### 五级压缩｜源码中最完整的 Context Engineering 实现

`restored-src/src/query.ts` 中的 `queryLoop()`（241-1729 行）在每次模型调用前，按成本从低到高执行五级 context shaper，

| 层级 | 机制 | 源码位置 | 做什么 |
|------|------|---------|--------|
| 1 | Budget Reduction | `query.ts` 内 `applyToolResultBudget()` | 处理超出单条消息预算的工具结果，截断而非删除 |
| 2 | Snip | `query.ts` 内 snip 逻辑 | 裁掉更早的历史片段，优先保护近期上下文 |
| 3 | Microcompact | `services/compact/microCompact.ts` | 细粒度历史处理，保护 prompt cache 前缀 |
| 4 | Context Collapse | `services/compact/compact.ts` 的 `compactConversation()` | 给模型生成读取时的投影，底层完整 JSONL 仍保留 |
| 5 | Auto Compact | 同上，`isAutoCompact: true` 路径 | 调用模型生成语义摘要，成本最高 |

第五层 `compactConversation()`（387-763 行）的签名本身就说明了设计的精细程度，

```ts
export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
): Promise<CompactionResult>
```

压缩后会重新注入文件附件、plan mode 指令、skill 附件和 deferred tool delta，确保模型在压缩后仍然知道当前项目状态。每一步都受 feature gate 控制，不同构建目标可能运行完全不同的压缩组合。

#### 不只是压缩｜上下文成本的全局管控

Context Engineering 分散在压缩模块之外。嵌套目录的 CLAUDE.md 延迟加载、`ToolSearch` 只暴露工具名而不暴露完整 Schema、单工具结果预算限制、subagent 只向父 Agent 返回摘要，这些都是在压缩之前就减少上下文占用的机制。

`restored-src/src/utils/sessionStorage.ts` 里的 `applyToolResultBudget` 甚至在工具结果进入消息历史之前就做了截断。这里要问的是「每一轮往窗口里塞什么」，不是「模型能不能处理长上下文」。

#### 判断口诀

问「知道什么」 → Context Engineering。问「怎么安全持久可观测地运营」 → 下一层。

### 第三层 Harness Engineering｜控制「系统如何安全运营」

一句话定位，**构建模型之外的一切确定性基础设施，让错误结构性不可重犯。**

公式，**Agent = Model + Harness**。模型做推理，harness 管执行。Claude Code 源码里，权限系统、Hook 管道、沙箱、状态恢复和 transcript 持久化都是 harness 的一部分。社区估算约 98.4% 的代码属于 operational infrastructure，这个数字的统计口径有争议，但趋势是对的，harness 占据了主要实现面。

#### 确定性约束替代概率性遵守

`restored-src/src/hooks/toolPermission/PermissionContext.ts` 实现了多层安全判断。重点是 `filterToolsByDenyRules()`，在模型调用前就移除被 blanket deny 的整类工具。这样做不仅阻止执行，还减少模型在不可用工具上浪费一次调用。

权限决策的完整路径长得多，工具池预过滤 → deny-first 规则 → permission mode → 可选分类器 → shell sandbox → resume 不恢复临时权限 → Hook 拦截。七层独立机制，每层有自己的判断逻辑。

`restored-src/src/utils/hooks.ts` 的 `executeHooks()`（1952-2972 行，超过 1000 行）是 Hook 系统的执行核心。Hook 可以在 UserPromptSubmit、PreToolUse、PostToolUse、Stop、SubagentStart、SessionStart 等生命周期节点观察、改写或阻断行为。退出码规范，0 表示成功（stdout 按事件类型处理），2 表示 stderr 展示给模型，其他只展示给用户。

#### Query Loop 是不用递归的状态机

`restored-src/src/query.ts` 的 `queryLoop()` 是 harness 的核心，一个 1489 行的 async generator。它的关键设计是用**状态赋值**（`state = next`）驱动迭代，而不是递归调用，

```ts
let state: State = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  // ...
}
// 循环体内部：
state = { ...state, messages: newMessages, turnCount: state.turnCount + 1 }
```

这保证了内存稳定、状态可追踪、错误恢复可控。模型负责选择局部行动，harness 负责决定这一轮模型能看到什么 Schema、工具输入是否合法、当前权限能否执行、失败后怎样恢复、结果怎样写入 transcript。

#### Harness 的七个核心组件

Claude Code 的 harness 可以拆成 ETCLOVG 七个组件，

1. **Execution（执行环境）**，MCP Server/Client、沙箱、`BashTool` 的 shell 解析（`restored-src/src/utils/bash/bashParser.ts`）
2. **Orchestration（调度）**，Scheduler/Cron（`CronCreate`/`CronDelete` 工具）、TimedTask
3. **State（状态管理）**，`QueryEngine` 的跨 turn 状态、`AppState` 共享状态
4. **Evaluation（验证）**，PreToolUse/PostToolUse Hook、linter gate、test gate
5. **Safety（安全）**，deny-first 权限、sandbox、`filterToolsByDenyRules`
6. **Observability（可观测性）**，日志、telemetry、成本追踪、query profiler
7. **Presentation（呈现）**，MCP Apps、人工审批弹出、REPL 渲染

#### 判断口诀

问「怎么安全持久可观测地运营」 → Harness Engineering。问「何时跑、何时停」 → 下一层。

### 第四层 Loop Engineering｜控制「何时再次运行、何时停止」

一句话定位，**设计循环来 prompt Agent，让系统自主迭代直到目标达成。**

Harness 把单次执行管住，Loop 管的是「什么时候再来一次、怎么判断已经好了」。区别在于时间维度，Harness 是空间里的边界，Loop 是时间上的节奏。

#### Claude Code 的四种 Loop 形态

| 形态 | 触发方式 | 停止条件 | 源码位置 |
|------|---------|---------|---------|
| Turn-based | 用户输入 | 模型判断完成或需要更多上下文 | `query.ts` 的 `queryLoop()` |
| Goal-based | `/goal` 命令 | 目标条件满足或达到 max turns | `skills/bundled/loop.ts` |
| Time-based | `/loop` 命令 | 用户取消或工作完成 | 同上 |
| Proactive | 事件/定时触发 | 每个任务完成即止 | Cron + hooks |

`restored-src/src/skills/bundled/loop.ts` 中 `registerLoopSkill` 注册了 `/loop` 命令，`buildPrompt` 构造循环 prompt。它决定「什么时候该再叫模型一次」，并不等于让模型承担更多工作。

#### Loop 的六个构成要素

Addy Osmani 把 Loop Engineering 拆成「5 + Memory」，

1. **Automations（自动化心跳）**，`/loop` 定时触发、Cron 调度、Hook 生命周期
2. **Worktrees（工作树隔离）**，`restored-src/src/utils/forkedAgent.ts` 的 `createSubagentContext()`（345-462 行），为每个 Agent 创建独立 git worktree
3. **Skills（技能编码）**，`SKILL.md` 固化项目知识，瘦入口按需加载。源码在 `restored-src/src/skills/loadSkillsDir.ts`
4. **Plugins/Connectors（插件连接器）**，基于 MCP 连接外部工具，在 `assembleToolPool()` 中合并
5. **Subagents（子代理）**，Maker-Checker 分离，写的人看不了自己的 bug，查的人改不了代码
6. **External State（外部状态）**，Markdown 文件、git log、Linear Board，状态留在上下文窗口之外

#### Loop 层的核心问题在于判断

Loop 设得太短，成本爆炸；设得太长，干等浪费时间。验证器太严格，永远停不下来；验证器太宽松，结果不可靠。这层不再是「怎么写 prompt」，而是「怎么设计一个能自己收敛的系统」。

#### 判断口诀

问「何时跑、何时停」 → Loop Engineering。问「多个节点怎么拆怎么连」 → 最后一层。

### 第五层 Graph Engineering｜控制「多个节点如何组织」

一句话定位，**用有向图将多个 Agent/节点连接起来，每个节点运行自己的 Loop。**

Graph 是空间结构（节点怎么拆、怎么连），Loop 是时间结构（何时继续、何时停止）。两者正交组合，一个 Graph 可以被外部 /loop 触发，Graph 中的每个节点又可以拥有自己的内部 Loop。

#### Claude Code 中的 Graph 原语

**SubAgent**（`restored-src/src/utils/forkedAgent.ts`）是最小的图节点。每个 subagent 有独立 prompt、工具和上下文窗口，父子之间通过摘要回传，

> 每个 subagent 写入独立 `.jsonl` 和 `.meta.json` sidechain。完整探索轨迹可用于调试与审计，却不会自动占据父 Agent 的上下文窗口。

**Agent Teams**（第 25 章详述）在 subagent 之上增加协作控制面，Team config 管身份，task list 管所有权（`pending | in_progress | completed`），mailbox 管消息路由，Coordinator 负责把状态变成下一步调度。三种协调模式，

1. **Coordinator**（零继承），控制器委托专家，必须综合结果而非委托理解
2. **Fork**（全继承、单层），父上下文分裂到子 Agent
3. **Swarm**（平级对等群），无层级协作

**Workflow 工具**提供三种编排原语，
- `parallel`，fan-out barrier，等待所有任务完成
- `pipeline`，无 barrier 流水线，项目 A 在阶段 3 时项目 B 可能仍在阶段 1
- `phase`，分组标签，不改变执行逻辑

这些原语的脚本嵌入在系统 prompt 的 Workflow tool 描述中。模型看到 `agent()`、`parallel()`、`pipeline()` 的完整 API 文档，然后自己写 JavaScript 脚本来编排多 Agent 工作流。

#### 图里的模型只在需要它的地方出现

Graph Engineering 的一个核心原则，模型只在真正需要它的地方出现。去重用代码，复验用验证器，只有综合判断才需要模型。如果把模型放进每个节点，成本随节点数量线性增长；如果每个节点的结果都不验证，汇总节点拿到的是垃圾。

#### Graph 层的核心风险

串行慢、重复劳动、结果不可验证是图设计失败的三个典型症状。更隐蔽的问题是，局部决策都合理，合起来仍可能破坏全局一致性。第 25 章提到的 Coordinator 不替 worker 阅读代码，它消费的是 task 状态和 mailbox 消息，不能把理解责任外包出去。

#### 判断口诀

问「怎么拆、怎么连」 → Graph Engineering。

### 五层故障诊断速查

| 症状 | 归属层 | 修法 |
|------|--------|------|
| 输出格式乱、不听话 | Prompt | 收紧指令，补范例，约束输出格式 |
| 幻觉、遗忘关键信息 | Context | 审计上下文窗口内容，修 RAG/记忆/工具描述 |
| 危险操作未拦截、静默失败 | Harness | 加 Hook、权限门、验证 pipeline |
| 过早停或无限循环 | Loop | 加验证器、安全阀（maxTurns/token budget） |
| 串行慢、重复劳动、结果漂移 | Graph | 设计 fan-out、节点契约、验证门 |

### 回到那张金额单位工单

你在第 01 章开了一张工单，订单显示 99.90 元，回调却是 9991 分。现在用五层框架重新看这次执行，

- **Prompt**，你写的那段指令，从「先读 CLAUDE.md」到「先给证据和计划不要直接改文件」，这是模型听到的「怎么说」。
- **Context**，CLAUDE.md 的项目规则、git status、当前分支、相关代码文件，这些决定模型「知道什么」。
- **Harness**，Read 工具读文件、Grep 工具搜索金额字段、Bash 工具跑测试、权限系统确认每个操作安全、transcript 记录每步操作，这些是「系统怎么运营」。
- **Loop**，模型读文件后决定搜索、搜索后决定改代码、改完后跑测试、测试不通过再改，每一轮判断「还要继续吗」就是 Loop Engineering。
- **Graph**，如果你把金额计算交给一个 subagent、回调解析交给另一个、前端复现交给第三个，再由 Coordinator 汇总，这就是 Graph Engineering。

同一张工单，五层同时在工作。区别只是，哪些层你已经设计好了，哪些层还在靠运气。

### 你现在最应该关注哪一层

这是一个阶段问题，技术实现只是承载方式。

如果你刚开始用 Claude Code，最直接的杠杆在 **Prompt** 和 **Context**。把 CLAUDE.md 写清楚，把规则文件组织好，效果立竿见影。

如果你已经在项目里深度使用，上下文频繁膨胀、权限弹窗太多、任务跑丢，你缺的是 **Harness**。加 Hook、配 sandbox、理解 permission mode 的七层判断逻辑。

如果你需要 Claude Code 在后台持续工作，定时检查、自动修复，你在做 **Loop Engineering**。`/loop` 和 `/goal` 是入口，但真正的挑战是设计验证器和停止条件。

如果你在编排多个 Agent 协作，拆分大型任务，你进入了 **Graph Engineering**。subagent 的角色定义、team 的协调模式、workflow 的 pipeline 原语是你需要掌握的工具。

五层不需要同时精通。但要知道你现在卡在哪一层，以及下一层应该往哪里走。

## 源码映射

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。行号以当前仓库为准；五层框架不依赖这些行号，符号移动后责任边界不变。

| 层 | 关键符号 | 位置 |
| --- | --- | --- |
| Prompt | `getSystemPrompt()`（返回 `SystemPrompt`，`readonly string[]`） | `src/constants/prompts.ts` |
| Prompt | `fetchSystemPromptParts()`（三路并行，system prompt / user context / system context） | `src/utils/queryContext.ts` |
| Prompt | CLAUDE.md 六层优先级，`/etc/claude-code` → `~/.claude` → 项目根 → `.claude/CLAUDE.md` → `.claude/rules/*.md` → `CLAUDE.local.md` | 配置加载模块 |
| Context | `queryLoop()` 五级 context shaper，`applyToolResultBudget()` → snip → microcompact → `compactConversation()` → auto compact | `src/query.ts`、`src/services/compact/microCompact.ts`、`src/services/compact/compact.ts` |
| Context | `applyToolResultBudget()`（进入消息历史之前截断） | `src/utils/sessionStorage.ts` |
| Harness | `filterToolsByDenyRules()` / 七层权限路径（预过滤 → deny-first → permission mode → 分类器 → sandbox → resume → Hook） | `src/hooks/toolPermission/PermissionContext.ts` |
| Harness | `executeHooks()`（1952-2972 行；退出码 0/2 语义） | `src/utils/hooks.ts` |
| Harness | `queryLoop()` 状态机（1489 行 async generator，状态赋值驱动迭代） | `src/query.ts` |
| Loop | `registerLoopSkill()` / `buildPrompt`；四种形态（Turn-based / Goal-based / Time-based / Proactive） | `src/skills/bundled/loop.ts`、`CronCreate`/`CronDelete` |
| Loop | `createSubagentContext()`（345-462 行，独立 git worktree） | `src/utils/forkedAgent.ts` |
| Graph | SubAgent（最小图节点，sidechain `.jsonl` / `.meta.json`） | `src/utils/forkedAgent.ts` |
| Graph | Agent Teams（Coordinator / Fork / Swarm 协调模式） | 第 25 章详述 |
| Graph | Workflow 工具（`parallel` / `pipeline` / `phase` 原语，脚本嵌入系统 prompt） | 工具注册模块 |

## 设计决策

**第一，为什么是五层而不是三层或六层？** 分层的依据是「每一层控制什么对象」，而不是「模块叫什么名字」。文本表达（Prompt）、模型视野（Context）、执行边界（Harness）、时间节奏（Loop）、空间结构（Graph）是五种不能互相替代的控制对象，因此嵌套关系从控制对象的包含关系推导而来，不是人为凑数。六层方案往往把 Context 拆成「记忆」和「检索」，三层方案把 Loop 和 Graph 合并，合并会丢失「时间」与「空间」两个正交维度。

**第二，为什么概念框架与实现证据必须分开？** 五层框架本身来自社区讨论与学术论文（Boris Cherny 的循环观、Addy Osmani 的 Loop Engineering、Agent 设计空间论文），Claude Code 的源码只提供实现证据。两者不能互相证明，理念文章说「harness 占主要实现面」，不等于源码里每一行都是 harness；源码里找到了 `filterToolsByDenyRules()`，也不等于所有产品都按这套权限路径运营。本系列一贯的证据边界在这里同样适用，能确认的确认（`restored-src/` 里的符号与行号），不能确认的标注（社区统计口径、产品形态随时间的变化）。

**第三，为什么「你最应该关注哪一层」是阶段问题而不是技术问题？** 五层不需要同时精通，新用户的杠杆在 Prompt 和 Context，重度用户的瓶颈在 Harness，自动化诉求指向 Loop，多 Agent 协作进入 Graph。把「哪一层重要」问成一个普遍问题，答案必然失真；把它问成「我现在卡在哪一层」，才能得到可执行的答案。这也呼应第 48 篇的能力清单，按阶段自检，而不是按章节通读。

## 自测

1. 「Claude Code 是不是一个大 prompt」错在哪里？五层的嵌套关系是什么，每一层控制什么对象？
2. 控制权迁移的主线是什么？从「人写 prompt」到「人写循环让 AI 自己 prompt 自己」，控制权经历了怎样的下放？
3. 请为五层中的每一层各举一个 `restored-src/` 中的源码证据，并说明它为什么属于这一层而不是相邻层。

<details>
<summary>参考答案</summary>

1. **prompt 只是五层嵌套体系的最内层。** 把 Claude Code 说成「一个大 prompt」，等于把五层边界压缩成一层，它解释不了权限拒绝（Harness）、解释不了上下文膨胀后的遗忘（Context）、解释不了 `/loop` 的反复执行（Loop）、也解释不了 subagent 拆分任务（Graph）。正确的关系是嵌套，Graph 包含 Loop，Loop 的每一轮经过 Harness，Harness 决定 Context，Context 决定哪些 Prompt 文本真正进入窗口。每一层控制不同的对象，措辞、视野、执行边界、时间节奏、空间结构。

2. **控制权从人的注意力迁移到系统结构。** 2022 年范式是「人写 prompt 让模型干活」，控制点在人的措辞；2026 年范式是「人写循环让 AI 自己 prompt 自己」，控制点变成循环、验证器和停止条件。Boris Cherny 的「我不再 prompt Claude 了」是这条主线的标志，每一次范式升级，都是把原来由人的注意力承担的控制（怎么说、知道什么、何时再跑、怎么拆怎么连），逐步交给 Context 策划、Harness 约束、Loop 调度、Graph 编排。

3. **证据各归其位。** Prompt，`getSystemPrompt()` 返回 `readonly string[]` 的 `SystemPrompt`，控制的是「措辞与角色」；Context，`queryLoop()` 的五级 shaper 与 `applyToolResultBudget()` 决定「窗口里塞什么」，哪怕 `sessionStorage.ts` 里的截断发生在消息历史之前；Harness，`filterToolsByDenyRules()` 在模型调用前移除整类工具、`executeHooks()` 在生命周期节点改写或阻断行为，管的是「确定性执行边界」；Loop，`registerLoopSkill()` 与 `buildPrompt` 决定「何时再叫模型一次」，四种形态区别在触发与停止条件；Graph，`createSubagentContext()` 与 Workflow 的 `parallel`/`pipeline` 原语决定「节点怎么拆、怎么连」。判断口诀，问「怎么说」归 Prompt，问「知道什么」归 Context，问「怎么运营」归 Harness，问「何时跑」归 Loop，问「怎么连」归 Graph。

</details>

## 回顾

<details>
<summary>展开查看回顾</summary>

这篇是把本系列的内核章节重新组合成一张纵向视图，向下看，模型每次调用只是一次 prompt 经过 Context 视野与 Harness 边界的短暂旅程；向上看，`/loop`、Cron、subagent 与 Agent Teams 把这些旅程组织成会自己收敛的系统。控制权迁移解释了产品演进的动力，人越来越不直接写 prompt，而是设计让 AI 互相 prompt 的结构。

五层框架用于诊断，不要求背诵。输出格式乱先查 Prompt，幻觉先查 Context，危险操作未拦截先查 Harness，过早停或无限循环先查 Loop，串行慢与结果漂移先查 Graph。框架比 2.1.88 的源码快照更稳定，版本升级后文件会移动，但「输入在哪一层被改写、权限在哪一层被拒绝、结果在哪一层没有抵达受众」的责任边界不变。

</details>

## 相关链接

- **上一篇**，[48 系列总结与能力清单](./48-series-summary-and-timeline.md)，本篇的可选补充定位由此而来
- **平行阅读**，[16 系统提示词与项目上下文](./16-system-prompt-and-project-context.md)，Prompt 层的完整源码拆解
- **平行阅读**，[17 长会话如何继续运行](./17-context-compaction.md)，Context 层五级压缩的实现细节
- **平行阅读**，[12 权限引擎](./12-permission-engine.md) 与 [18 Hook 生命周期](./18-hooks-lifecycle.md)，Harness 层证据
- **平行阅读**，[24 subagent 委派](./24-subagent-delegation.md) 与 [25 Agent Teams](./25-agent-teams-and-coordinator.md)，Graph 层原语
- [Agent 五大工程体系，Prompt、Context、Loop、Graph 与 Harness](https://developer.aliyun.com/article/1752893)
- [Prompt, Context, Harness, Loop， The Four Layers of AI Agent Engineering](https://futureagi.com/blog/loop-engineering/prompt-context-harness-loop-layers/)
- [Loop Engineering ， Building Autonomous Loops with Claude Code](https://dev.classmethod.jp/en/articles/loop-engineering-claude-code-autonomous/)
- [How to build an agent harness with Claude Code - LogRocket](https://blog.logrocket.com/building-an-agent-harness-with-claude-code/)
- [Effective context engineering for AI agents - Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Dive into Claude Code，生产级 Agent 的设计空间](https://arxiv.org/abs/2604.14228)
- [Anthropic CWC Long-Running Agents](https://github.com/anthropics/cwc-long-running-agents)
- [深度解析 Claude Code 在 Prompt / Context / Harness 的设计与实践](https://developer.aliyun.com/article/1730264)
