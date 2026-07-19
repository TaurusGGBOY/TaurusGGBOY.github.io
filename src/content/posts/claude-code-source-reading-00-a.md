---
title: "Claude Code源码解读00-a：一篇逆向论文怎样拆开生产级 Agent"
published: 2026-07-19
description: "深度解读基于 Claude Code 2.1.88 公开源码写成的技术报告，分析作者背景、证据分层、Agent 设计空间、核心结论与推断边界。"
tags: ["claude-code", "source-code", "ai-agent", "paper"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-00-a/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 从 source map 泄露到一篇逆向论文

2026 年 3 月，Claude Code 的 npm 发布包意外带上了 source map。这个文件原本供调试器使用，其中的 `sourcesContent` 却保存了可以还原的 TypeScript 源码。npm 撤包和 GitHub DMCA 能够压缩后续传播范围，已经保存到本地的静态快照不会随之消失。

2026 年 4 月 14 日，一个来自 VILA Lab 的研究团队把技术报告提交到 arXiv，标题是 [*Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems*](https://arxiv.org/abs/2604.14228)。它的主要研究材料，就是从公开 npm 发布物中提取的 Claude Code 2.1.88 源码。

论文 v1 比较了 Claude Code 和 OpenClaw。2026 年 7 月 2 日更新的 v2 又加入 Hermes Agent，并吸收了快照之后出现的 Agent 研究。当前版本覆盖约 1884 个文件、51.2 万行 TypeScript，配套资料发布在 [VILA-Lab/Dive-into-Claude-Code](https://github.com/VILA-Lab/Dive-into-Claude-Code)。

这篇论文没有重新实现 Claude Code，也没有拿 SWE-bench 跑一组成功率。它做的是软件架构案例研究：先从源码中找出存在替代方案的设计点，再解释 Claude Code 为什么会选择现在这条路径。

## 作者介绍

这篇论文一共有四位作者：Jiacheng Liu、Xiaohan Zhao、Xinyi Shang 和 Zhiqiang Shen。按照论文署名，四人都来自 Mohamed bin Zayed University of Artificial Intelligence（MBZUAI）的 VILA Lab，Xinyi Shang 还同时署名 University College London（UCL），Zhiqiang Shen 是通讯作者。

我们先看一作 Jiacheng Liu。VILA Lab 的[成员页面](https://zhiqiangshen.com/projects/group/index.html)显示，他从 2024 年开始在 MBZUAI 机器学习系攻读博士；他的 [ORCID 记录](https://orcid.org/0009-0009-8266-9771)还列出了 2022 至 2024 年在 UCL 学习计算机科学的经历。从论文轨迹看，他此前主要沿两条路线工作：一条研究 Agent 和多模态模型的能力边界，另一条研究模型压缩与部署效率。

第一条路线里，Jiacheng Liu 参与了 [*Open CaptchaWorld*](https://arxiv.org/abs/2505.24878)。这项工作构建了一个面向多模态 Web Agent 的 CAPTCHA 测试平台，包含 20 类、225 个交互式 CAPTCHA，后来进入 NeurIPS 2025 Datasets and Benchmarks Track。沿着同一个问题，他又以共同一作身份发布 [*Next-Gen CAPTCHAs*](https://arxiv.org/abs/2602.09012)，研究当前 GUI Agent 已经能破解传统 CAPTCHA 以后，网站还能怎样利用人和 Agent 在视觉、记忆与交互上的差异建立防线。这篇论文进入 ICML 2026；[ICML 2026](https://icml.cc/Conferences/2026) 于 7 月 6 日至 11 日在韩国首尔 COEX 会展中心举行。

第二条路线里，他参与了 [*Mobile-MMLU*](https://data.mlr.press/volumes/03.html)。这个基准包含 16,186 道题，覆盖 80 个与移动设备使用有关的领域，发表于 2026 年的 *Data-centric Machine Learning Research*。他还是 [*BiGain*](https://openaccess.thecvf.com/content/CVPR2026/html/Liu_BiGain_Unified_Token_Compression_for_Joint_Generation_and_Classification_CVPR_2026_paper.html) 的一作，研究怎样在扩散模型中压缩 token，同时兼顾生成质量和分类能力。*BiGain* 发表于 CVPR 2026；[CVPR 2026](https://cvpr.thecvf.com/Conferences/2026/News/Expo) 于 6 月 3 日至 7 日在美国丹佛的 Colorado Convention Center 举行。

把这些工作连起来看，一作研究 Claude Code 延续了此前的研究脉络。他一直在研究 GUI Agent 能做什么、Agent 会在哪里失败、模型怎样以更低成本部署。Claude Code 的源码正好把问题继续向下一层推进：模型有了行动能力以后，运行时要怎样管理权限、上下文、工具和恢复。

另外三位作者也来自同一个研究网络。Xiaohan Zhao 同样是 2024 年入学的 MBZUAI 机器学习博士生，参与过 *Open CaptchaWorld*，也以一作身份研究过大型视觉语言模型的[黑盒对抗攻击](https://arxiv.org/abs/2602.17645)。[Xinyi Shang](https://shangxinyi.github.io/) 是 UCL 博士生，2025 年起在 VILA Lab 做研究实习，研究涉及视觉模型、数据中心学习和图像篡改理解。通讯作者 [Zhiqiang Shen](https://zhiqiangshen.com/) 是 MBZUAI 助理教授和 VILA Lab 负责人，此前在 Carnegie Mellon University 从事博士后研究，长期方向包括 Agentic AI、基础模型、数据中心学习、知识蒸馏、高效深度学习、计算机视觉与自然语言处理。

那么，MBZUAI 是什么机构？它的全称是 Mohamed bin Zayed University of Artificial Intelligence，校址位于阿联酋阿布扎比。[学校官方介绍](https://mbzuai.ac.ae/about/)把它定义为一所以人工智能为核心的研究型大学。学校在 2019 年成立，最初定位为全球第一所研究型、研究生层次的人工智能大学；到 2025 年以后又开始招收本科生。人工智能是整所大学的办学主题，机器学习、计算机视觉、自然语言处理、机器人和基础模型等方向都围绕这条主线展开。

VILA Lab 则是 Zhiqiang Shen 在 MBZUAI 机器学习系带领的研究组。[实验室成员页](https://zhiqiangshen.com/projects/group/index.html)给出的关键词是 Artificial Intelligence、Efficient Learning 和 Machine Learning，实际项目覆盖高效模型、数据蒸馏、基础模型、视觉语言模型、Agent 安全与评测。这里的 VILA 是研究组名称，不要把它和 NVIDIA 同名的 VILA 视觉语言模型项目混为一谈。

## 七道选择题组成了论文的主线

论文把研究问题拆成七个方面：

1. 推理应该发生在模型里，还是由 harness 中的显式状态机控制；
2. 不同入口应该共享一个执行循环，还是各自拥有一套 engine；
3. 未识别动作应该默认允许、拒绝，还是升级给人；
4. MCP、Plugin、Skill 和 Hook 应该统一，还是保留不同扩展层；
5. 有限上下文应该怎样压缩、延迟加载和跨会话保存；
6. Subagent 应该共享父会话，还是隔离上下文、权限与工作区；
7. 会话应该使用可变数据库、checkpoint，还是追加式日志持久化。

每一道题都有可用的另一套答案。

比如，LangGraph 把控制流写成状态图；SWE-Agent 和 OpenHands 把强隔离放进容器；Aider 更依赖 Git 回滚；OpenClaw 则先在 gateway 外围处理身份和访问控制。看到这些对照以后，我们才能分清哪些是 Agent 的共同需求，哪些是 Claude Code 的产品选择。

作者还用一个修复失败测试的任务贯穿全文。请求进入系统以后，会依次碰到上下文组装、模型调用、`tool_use`、权限检查、工具执行、结果回填、subagent 委派、压缩和 transcript 写入。这样阅读，文件目录退到后面，执行过程成了主线。

## 先确认研究方法，再看结论

这是一项定性研究。

论文没有受试者、benchmark 数据集和控制组，也没有统计显著性或 effect size。因此，它能够解释系统怎样组织，不能给出“某种架构让任务成功率提高多少”这样的因果结论。七种权限模式和五层压缩各自带来多少收益，论文同样没有测量。

作者的研究过程可以整理成四步：

1. 从 2.1.88 静态源码中恢复函数、类型、控制流、feature gates 和跨文件依赖；
2. 在每个子系统中识别存在替代方案的设计选择；
3. 用 Anthropic 的公开文档和创作者表述解释这些选择可能服务的价值；
4. 用 OpenClaw、Hermes Agent 以及相关研究校准这些选择的适用范围。

这套方法能回答“系统怎样组织”和“这种组织意味着什么”。生产环境的功能启用率、故障率、时延与任务成功率仍然未知。

接下来会遇到一个更重要的问题：论文里的每句话，证据强度一样吗？

## 三层证据决定结论能走多远

论文把证据分成三层。

Tier A 是 product-documented evidence，来源包括 Anthropic 官方文档、工程文章和创作者的公开表述。这一层可以说明产品公开强调了什么，不能代替实现证据。

Tier B 是 code-verified evidence，来源是 2.1.88 静态源码中的文件和函数。类型定义、参数、分支顺序、默认值与 feature gate 都在这一层。对于“代码实际怎么走”这类问题，它是最强证据。

Tier C 是 reconstructed evidence，包括社区分析、跨系统比较，以及作者根据代码模式建立的架构解释。它负责把分散实现连成系统模型，确定性低于直接源码事实。

![从源码事实到 Agent 设计空间的推理链](/images/posts/claude-code-source-reading-00-a/00-a-dive-into-claude-code-handdrawn.png)

我们用 `queryLoop()` 做一个例子。本仓库的知识图谱可以确认，它位于 `restored-src/src/query.ts`，返回 `AsyncGenerator`，接收 `QueryParams` 和已经消费的 command UUID，并连接消息、模型、工具、压缩、恢复与状态模块。这是 Tier B，可以写成源码事实。

论文据此提出“模型判断下一步，harness 负责执行与约束”。这里已经从函数进入架构解释，需要源码和官方材料共同支撑。

作者继续推演，认为未来 Agent 应该显式保护开发者的长期理解力。这属于研究方向。2.1.88 的源码并没有把它实现成一个可确认的产品目标。

所以，读这篇论文时可以记住一个简单规则：越靠近函数、类型和分支，结论越硬；越靠近价值判断和未来系统，限定条件越重要。

## 5 个价值怎样变成 13 条原则

论文先从官方材料中归纳出 5 个价值：

- Human Decision Authority：人保留最终决策权；
- Safety, Security, and Privacy：系统在用户疏忽时仍要保护代码、数据和基础设施；
- Reliable Execution：任务跨工具、压缩、恢复和委派后仍然保持一致；
- Capability Amplification：相同人力和成本完成更多工作；
- Contextual Adaptability：系统适应项目、工具、规则和用户积累下来的协作方式。

随后，作者把它们映射成 13 条可以在实现中观察的原则：

1. deny-first，并在需要时升级给人；
2. 使用渐进式信任而非单一权限级别；
3. 用相互独立的机制做纵深防御；
4. 把策略外置为配置与生命周期 Hook；
5. 把上下文视为稀缺资源，逐级处理；
6. 使用追加式持久状态；
7. 减少显式推理脚手架，增强 operational harness；
8. 让模型在确定性护栏内做情境判断；
9. 使用多种可组合的扩展机制；
10. 按动作可逆性分配监督强度；
11. 使用透明、可编辑的文件保存配置和记忆；
12. 隔离 subagent 的上下文与执行边界；
13. 对可恢复错误进行渐进式恢复。

价值、原则与代码之间是多对多关系。

例如，“人的最终决策权”同时落在权限询问、append-only transcript、resume 不恢复临时权限和外置策略上；“上下文是稀缺资源”同时落在五层压缩、延迟加载 `CLAUDE.md`、ToolSearch、工具结果预算和 subagent 摘要回传上。

一条原则只有跨多个子系统反复出现，才具备架构解释力。单个函数使用 JSONL，只能说明它选择了某种格式；会话、sidechain、compact boundary 和读取时链修补都偏向追加式设计，才有理由把“可审计状态”上升为系统原则。

这里要保留一个边界：这 5 个价值和 13 条原则是作者提出的解释框架。我们没有看到 Anthropic 的内部设计文档，源码里也不存在一份同名的正式架构规范。

## 从一次修复失败测试开始

现在，我们把论文里的研究问题放回一个具体任务。假设你把一句 `Fix the failing test in auth.test.ts` 交给 Claude Code。

接下来，它可能先读测试文件，再搜索认证逻辑，运行一遍失败用例，修改代码，最后重新执行测试。我们看到的是几次工具调用。实际上，在每一次调用背后，系统都要继续回答一组工程问题：这一轮应该给模型多少上下文，Bash 命令能不能执行，工具结果怎样写回会话，窗口快满了怎么办，任务交给 subagent 后又该返回什么。

这些问题决定了一个 Coding Agent 能不能长期运行，也决定了它出了错以后会伤到哪里。下面就沿着这条执行路径，先看 Claude Code 怎样在模型判断和确定性 harness 之间分配职责。

## 模型负责选择，harness 负责把选择变成动作

论文最核心的判断可以压缩成一句话：Claude Code 把局部行动交给模型判断，再由确定性 harness 管住外部世界的边界。

我们先看最小循环：

```text
组装上下文
    ↓
调用模型
    ↓
收到文本或 tool_use
    ↓
检查权限并执行工具
    ↓
把 tool_result 放回消息历史
    ↓
继续调用模型，直到停止
```

`queryLoop()` 的实现有 1489 行，论文仍把它称为 simple while-loop。这里的“简单”说的是循环骨架：模型给出下一步，系统执行，再把结果送回模型。它没有说明函数体很短，更没有说明外围工程简单。

模型决定先读哪个文件、是否运行测试、下一步调用哪个工具。Harness 决定这一轮模型能看到什么上下文和 Schema，工具输入是否合法，当前权限能否执行，多个调用能否并行，失败后怎样恢复，结果怎样写入 transcript，以及窗口满时保留什么。

这与显式状态图形成了清楚的对照。状态图在 harness 里规定下一步走哪条边；Claude Code 让模型选择局部路径，再用代码确保它只能通过结构化 `tool_use` 影响文件系统、shell 和网络。

论文引用一个社区估算：约 1.6% 的代码属于 AI decision logic，其余 98.4% 是 operational infrastructure。这个数字很有传播力，证据却只有 Tier C。怎样区分“决策逻辑”和“基础设施”没有统一口径，论文也没有给出可复现的逐文件分类数据。

所以，1.6% 适合表达趋势，不能当作精确的软件度量。源码能够稳定支持的结论是：权限、工具路由、上下文、恢复与持久化占据了主要实现面。

## 七个组件与五层系统是两张不同粒度的地图

论文用两种方式描述 Claude Code。

七组件模型适合解释一次任务的主数据流：

| 组件 | 职责 |
|---|---|
| User | 提交请求、批准动作、检查结果 |
| Interfaces | Interactive CLI、headless CLI、Agent SDK、IDE/Desktop/Browser 等入口 |
| Agent loop | 组装上下文、调用模型、分派工具、收集结果 |
| Permission system | 规则、模式、分类器和 Hook 共同决定动作能否执行 |
| Tools | 内置工具与 MCP 工具形成模型的行动面 |
| State & persistence | 保存 transcript、session identity、sidechain 与历史 |
| Execution environment | Shell、文件系统、网络、MCP 与远程环境 |

五层模型适合定位实现职责：

| 层 | 主要内容 |
|---|---|
| Surface | 入口、终端 UI、SDK 事件与渲染 |
| Core | `queryLoop()` 和 context shapers |
| Safety / Action | 权限、Hook、工具、sandbox、扩展与 subagent |
| State | 上下文组装、应用状态、记忆、transcript 与 sidechain |
| Backend | Shell、文件系统、远程环境和外部服务 |

这两张地图回答的问题不同。七组件模型说明任务流过哪里，五层模型说明代码职责怎样分布。两者都来自作者对源码的重建，不能当成 Anthropic 官方架构图。

论文还纠正了一个容易产生的误解。`QueryEngine` 是无头模式与 SDK 使用的 conversation wrapper，`submitMessage()` 最终委托给 `query.ts` 中的共享查询路径。交互式 CLI 也调用这条路径，却可以绕过 `QueryEngine`。

因此，多个入口共享的是 query path。`QueryEngine` 只是其中一些入口的外层封装。

## 一条命令为什么要经过多层权限判断

假设模型准备执行一条 Bash 命令。终端里出现的确认弹窗，只是这条命令可能经过的一层边界。论文从源码中恢复出的实际路径更长。

2.1.88 类型和功能开关合起来最多可以看到 7 种模式：

| 模式 | 源码能够确认的行为 |
|---|---|
| `plan` | 先形成计划，执行阶段需要批准 |
| `default` | 标准交互姿态，风险动作通常进入用户确认 |
| `acceptEdits` | 工作目录内编辑和一部分文件系统命令可以自动批准，其他 shell 命令仍需判断 |
| `auto` | `TRANSCRIPT_CLASSIFIER` 开启时，用分类器处理未走快速路径的请求 |
| `dontAsk` | 抑制询问；原本需要询问的动作转成 deny，显式 allow/deny 仍生效 |
| `bypassPermissions` | 跳过大部分询问，安全关键检查和 bypass-immune 规则仍可阻断 |
| `bubble` | 内部模式，用于 subagent 把权限请求上抛给父终端 |

公开模式数组包含 `acceptEdits`、`bypassPermissions`、`default`、`dontAsk` 和 `plan`。`auto` 受 feature gate 控制，`bubble` 用于内部权限传播。静态源码无法确认某个线上构建是否启用了 `auto`，也不能计算各模式的使用比例。

一次动作还可能经过七类安全边界：工具池预过滤、deny-first 规则、permission mode、可选分类器、shell sandbox、resume 不恢复会话权限，以及 Hook 拦截。

其中，`filterToolsByDenyRules()` 会在模型调用前移除整类被 blanket deny 的工具。这样做不仅阻止执行，还减少模型在不可用工具上浪费一次调用。

`toolMatchesRule()` 支持工具级与内容级匹配，deny 先于 allow。宽泛 deny 不会被更具体的 allow 暗中覆盖。`PreToolUse` 可以阻断、要求询问或改写输入，但 Hook 返回 allow 也不能跳过后续 deny 和安全检查。

这套设计承认用户会产生 approval fatigue。论文引用 Anthropic 的公开分析：用户批准了约 93% 的权限请求。高批准率意味着弹窗本身不能成为唯一安全边界，于是规则、分类器与 sandbox 必须在用户没有认真检查时仍能工作。

纵深防御也有代价。多个层如果共享解析器、性能预算和上下文，它们的独立性可能低于设计图呈现的程度。论文 v2 引用了长复合命令退化成通用确认、sandbox parser differential 等外部安全分析。这些是特定版本窗口里的 Tier C 证据，不能推广到所有当前版本。它们说明了一点：安全层数增加，不等于失效模式已经彼此隔离。

## 上下文快满时，系统为什么要分五步处理

长会话运行一段时间以后，历史消息、工具结果和项目指令会一起挤占上下文窗口。Claude Code 按成本从低到高分五步处理，在窗口彻底装满之前就开始减负。

论文从 `query.ts` 中整理出模型调用前的五级 context shaper：

1. budget reduction：先处理超出单条消息预算的工具结果；
2. snip：裁掉更早的历史片段；
3. microcompact：处理细粒度历史，并可考虑 prompt cache；
4. context collapse：给模型生成读取时投影，底层完整 REPL 历史仍可保留；
5. auto-compact：前四层仍不足时，调用模型生成语义摘要。

这五层处理的对象不同。Budget reduction 面向单个巨大输出，snip 面向时间深度，microcompact 还关心 cache，context collapse 改变模型看到的视图，auto-compact 的语义损失和调用成本最高，因此最后执行。

`compactConversation()` 的签名也能验证这一点。它接收消息、工具上下文、cache-safe 参数、是否抑制后续问题、自定义指令、`isAutoCompact` 和可选的重新压缩信息。其中 `isAutoCompact` 默认是 `false`；自定义指令与重新压缩信息可以是 `undefined`。这些取值会改变 Hook 信息、提示词与重新压缩分支。

论文 v2 还把可见性边界说得更准确：budget reduction 始终启用，snip、cache-aware microcompact 与 context collapse 受 feature gate 影响，auto-compact 默认启用但可以关闭。不同构建目标可能运行完全不同的组合。

上下文管理还分散在 compact 模块之外。嵌套目录指令延迟加载、ToolSearch 延迟暴露完整 Schema、单工具结果预算和 subagent summary-only return，都在减少当轮输入。

这种设计让长会话能够继续，却引入一个透明性问题：磁盘上仍保存完整 transcript，不代表模型下一轮仍看到同样的信息。Auto-compact 会留下可见摘要，microcompact 会产生边界标记，context collapse 则可以在没有用户可见输出的情况下改变模型视图。

所以，“会话可以恢复”与“模型仍然记得全部细节”是两件不同的事。

## MCP、Plugin、Skill 和 Hook 为什么没有合并

MCP、Plugin、Skill 和 Hook 都能扩展 Claude Code，看起来很容易被归到同一个“插件系统”里。论文先把它们放回 Agent loop 的三个插入点：

- assemble：决定模型看到什么；
- model：决定模型能够调用什么；
- execute：决定动作能否以及怎样执行。

MCP 主要贡献外部工具、资源与提示。`assembleToolPool(permissionContext, mcpTools)` 先取得内置工具，再按 deny 规则过滤 MCP 工具，最后合并、去重和排序。`permissionContext` 决定可见边界，`mcpTools` 来自运行时连接，静态源码不能穷举实际服务器与工具名。

Plugin 是包装与分发格式。它可以同时携带 commands、agents、skills、hooks、MCP servers、LSP servers、output styles、channels、settings 和 user configuration，再由 loader 分发到不同注册表。Plugin 自身不会增加一个独立运行时插入点。

Skill 主要按需引入工作方法。默认路径把指令带入当前上下文；v2 论文也补充了 `context: fork` 这一例外，它可以复用 `runAgent` 机制启动隔离上下文。因此，把 Skill 一概写成“永远只在当前 Agent 内运行”并不准确。

Hook 插入生命周期，可以在用户提交、工具执行前后、权限拒绝、停止和压缩等节点观察、改写或阻断行为。它可以几乎不占模型上下文，却直接改变控制流。

现在区别就清楚了。四种机制分别处理外部能力、交付方式、工作方法和生命周期策略。如果统一成 Tool，接口会更整齐，上下文成本、控制权和分发边界却会被挤进同一种抽象。

## Subagent 先隔离上下文，再提供并发

Claude Code 通过 `AgentTool.tsx` 分派内置或自定义 subagent。不同构建与入口最多可以出现 Explore、Plan、general-purpose、Claude Code Guide、Verification 和 Statusline-setup 六类内置定义。

这里的“最多”很重要。类型和 feature gates 只说明候选能力，不能保证每个外部用户都能在每个构建中看到它们。

Agent 输入 Schema 中，`isolation` 对外部构建通常只有 `worktree`，内部构建可以增加 `remote`；`cwd` 与 `run_in_background` 也受功能开关影响。未指定 isolation 时，默认是在同一文件系统中运行，但 conversation context 隔离。`worktree` 进一步隔离文件修改，`remote` 在论文分析的构建中属于内部路径。

自定义 agent 还能指定 `tools`、`disallowedTools`、`model`、`effort`、`permissionMode`、`mcpServers`、`hooks`、`maxTurns`、`skills`、memory scope、后台运行和 isolation。开放字段如 prompt、路径和轮数来自配置或运行时输入，源码只能说明类型与约束，无法穷举实际值。

默认路径中，subagent 会获得一段自包含 prompt，以及重新组装的工具与权限上下文。父会话的完整历史不会直接继承，最终只有文本与元数据返回父 Agent。Fork-subagent 是一个例外，它可以复用父上下文。

每个 subagent 还会写入独立 `.jsonl` 和 `.meta.json` sidechain。完整探索轨迹可用于调试与审计，却不会自动占据父 Agent 的上下文窗口。

所以，subagent 同时完成三件事：隔离认知噪声、缩小权限与工具面、提供并发。按照执行顺序看，隔离发生在委派开始时，并发只是随后得到的能力。

它的代价也很清楚。父 Agent 只拿到摘要，完整证据链不会自然回流；多个隔离 Agent 可能看不到彼此的局部发现，从而重复实现。局部决定都合理，合起来仍可能破坏全局一致性。

## Resume 恢复了消息，为什么还要重新判断权限

Claude Code 把会话写进项目范围的 JSONL transcript。用户消息、assistant 消息、工具结果、compact boundary 和其他元数据作为事件持续追加。全局 prompt history 和 subagent sidechain 使用独立通道。

Compact boundary 会记录 `headUuid`、`anchorUuid` 和 `tailUuid`。Loader 可以在读取时修补消息链，因此压缩通常不需要回头修改或删除旧 transcript 行。

`--resume` 通过 replay transcript 重建消息，fork 从旧会话创建新分支。会话级临时权限不会随之恢复，因为这些权限没有被序列化成 transcript 中可继承的信任状态。新会话会根据 CLI 参数和磁盘设置重新建立 permission context，未识别请求再次回到 deny-first 路径。

这是一种明确的取舍。消息历史可以跨会话延续，临时信任停在原来的 session boundary 内。

论文还提醒我们注意 `checkpoint` 的含义。这里主要指 `--rewind-files` 使用的文件历史快照，位置是 `~/.claude/file-history/<sessionId>/`。它不能恢复全部 Agent 状态。

## 同一组问题，三个 Agent 为什么给出不同答案

V2 从系统范围、信任模型、Agent runtime、扩展架构、记忆与上下文、多 Agent 路由六个维度比较 Claude Code、OpenClaw 和 Hermes Agent。

Claude Code 是围绕代码仓库和会话工作的 CLI/IDE coding harness。它把最多工程投入放在逐动作权限、项目上下文、工具执行、压缩与文件恢复上。

OpenClaw 是持续运行的多渠道 WebSocket gateway。它首先要回答谁能通过 WhatsApp、Telegram、Slack、Discord 或其他入口进入系统，因此更重视 gateway perimeter 上的身份、allowlist 和 channel routing。Agent runtime 嵌在 control plane 里面，系统中心是 gateway。

Hermes Agent 是单个 Python 进程，角色由 `hermes`、`hermes-agent` 或 `hermes-acp` 等入口决定。它保留逐动作 approval，又要把同一套批准流程渲染到 CLI、消息平台和 ACP 表面，并提供可插拔的 memory 与 model backend。

三者都需要处理工具、安全、扩展、记忆和委派，最重的边界却位于不同位置：

| 系统 | 主要部署单元 | 最突出的边界 |
|---|---|---|
| Claude Code | Repository session | 模型动作与本地执行环境之间 |
| OpenClaw | Persistent gateway | 外部发送者与 gateway 之间 |
| Hermes Agent | Multi-surface process | 多种交互表面与统一 runtime 之间 |

这组比较说明，Agent 架构必须和部署语境一起看。把 Claude Code 的逐动作权限原样搬进多渠道 gateway，可能忽略入口身份；把 gateway 的 perimeter trust 搬进 coding harness，又可能缺少文件和 shell 的细粒度控制。

论文 v2 还展示了比较研究本身的风险。作者发现 Hermes 的 `SECURITY.md` 与实际权限模式命名发生漂移，关于 delegation depth 的文档默认值也与源码不同。因此，对照系统同样要区分文档意图和实现事实。

## 三项贡献把源码细节连成系统问题

第一项贡献，是把 Claude Code 的功能列表还原成一组可以讨论的设计选择。

权限为什么需要多层边界，压缩为什么要逐级升级，Skill 与 Hook 为什么不能合并，resume 为什么恢复消息却不恢复临时权限，这些实现只有放到自治与控制、上下文成本、可审计状态等轴线上，才会显示出一致性。

第二项贡献，是给出一套可以迁移的源码阅读方法。

阅读另一个 Agent runtime 时，可以先识别它把推理放在哪里、把信任边界放在哪里、怎样管理有限上下文、怎样隔离委派、怎样保存状态，再去看文件名。这样得到的模型更适合跨语言和跨产品比较。

第三项贡献，是把模型之外的工程放回 Agent 研究中心。

论文没有提出新的搜索算法或训练方法。它说明生产系统的主要差异往往发生在 permission gate、tool routing、context shaping、recovery、persistence 和 deployment topology 中。模型能力相同，harness 设计不同，系统能安全完成的工作也会不同。

## 四个边界决定这篇论文不能证明什么

第一个边界来自静态快照。

源码能证明某个分支存在，不能证明生产 feature flag 已经打开；能证明 retry 上限，不能证明线上经常触发；能证明 permission mode 的控制流，不能给出分类器误报率；能证明五层压缩机制，不能证明它们足以维持大型代码库的一致性。

第二个边界来自 reverse-engineering epistemology。Source map 可以恢复发布物中的结构、路径与变量，却不能保证这些路径等同于 Anthropic 内部原始仓库，也不能自动确认设计者意图。

第三个边界来自外部实证材料。论文引用 Cursor 仓库复杂度、AI 生成提交的技术债、开发者理解力和长期生产率研究，用来推测 bounded context 与局部决策可能造成的全局问题。这些研究提供相邻证据，没有直接评测 Claude Code 2.1.88。

第四个边界来自时间混合。论文核心静态快照停在 2.1.88，v2 的未来方向却已经讨论 2.1.154 dynamic workflows、Claude 4.8 以及 2026 年后续政策与研究。后快照材料可以展示设计空间怎样继续移动，不能反向写成 2.1.88 已有行为。

最后，它目前是 arXiv technical report。文章可以评价其论证和贡献，不应把它描述成已经通过同行评审确认的因果结论。

## 六个未来方向，最后都回到 harness

论文最后把开放问题归纳为六类：

1. 静默失败与 observability-evaluation gap；
2. 跨会话记忆与长期人机协作关系；
3. Harness 在运行位置、行动时机、作用对象和协作者上的扩展；
4. 任务跨度从一轮会话扩展到数周项目；
5. 大规模治理、外部审计与监督接口；
6. 开发者长期理解力与能力保存。

这六类问题看起来很分散，实际都在检验会话级 harness 的边界。

模型能力提高以后，permission gate 不会自动变成外部审计系统；上下文窗口变长以后，跨月项目不会自动获得可靠记忆；subagent 数量增加以后，局部验证不会自动形成全局一致性；代码生成更快以后，开发者也不会自动理解 Agent 改过的系统。

论文在长期开发者能力上做了一个值得注意的处理。作者没有把它强行列为 Claude Code 已经体现的第六项价值，因为官方材料和 2.1.88 架构都缺少足够证据。他们把它单独列为 cross-cutting question，用来评估短期能力放大是否损害长期理解、代码库连贯性和开发者培养路径。

作者在这里保留了证据边界。源码分析能够看到系统当前优化了什么，也能看出哪些重要目标还没有成为一等架构对象。至于“保护开发者”能否算作 Claude Code 的第六个设计目标，现有材料还不足以下这个结论。

## 小结

*Dive into Claude Code* 的研究类型，是基于公开静态源码的软件架构案例研究。它不具备官方架构说明的身份，也没有提供性能实验数据。

论文先用 Tier A、Tier B 和 Tier C 区分公开意图、源码事实与重建解释，再从 2.1.88 中提炼出 5 个价值、13 条原则、7 个高层组件和 5 层实现结构。最有解释力的结论是，Claude Code 让模型保留局部行动选择，同时用密集的确定性 harness 管理工具、权限、上下文、恢复和持久化。

OpenClaw 与 Hermes Agent 的对照进一步说明，相似的 Agent 问题会因为 repository session、persistent gateway 和 multi-surface process 三种部署语境而得到不同答案。

源码泄露提供了可观察材料，论文进一步提供了分析这些材料的语言。沿着这套方法，我们可以把 Agent 系统的讨论从模型能力和功能数量，推进到能够被源码核验的边界、权衡与设计选择。
