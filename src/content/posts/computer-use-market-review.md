---
title: "从按键精灵到 Agent Use：Computer Use 为什么能看懂屏幕，却还不能替你负责"
published: 2026-08-25
updated: 2026-08-25
description: "从按键精灵、RPA 和 ReAct 的历史出发，解释传统 GUI 自动化、Computer Use 与 Agent Use 的区别，并比较闭源、开源项目及 Codex/Claude Code 的体验差异。"
tags: ["computer-use", "agent-use", "rpa", "按键精灵", "codex", "claude-code"]
category: "AI / Architecture"
draft: false
image: ""
slug: "computer-use-market-review"
difficulty: "advanced"
time: "45 min"
---

假设有一个任务：打开订单后台，导出昨天的数据，填进财务系统，再把结果发给同事。

按键精灵可以做。你先录制或编写一段脚本，规定什么时候移动鼠标、点击哪个位置、输入什么文字。页面布局不变时，它执行得很快，也很便宜。按钮换了位置、登录弹出验证码、窗口被别的程序遮住，脚本就可能在第 17 步点错，然后继续把错误传下去。

现在的 Computer Use 也可以做。模型看到截图，决定点击、输入、滚动或等待，执行器把动作发给浏览器或桌面，再把新截图传回来。它不需要提前知道每个按钮的坐标，但每一步都要重新理解界面，速度和稳定性都受模型影响。

再往前一步，是 Agent Use：Agent 先理解目标和约束，决定哪些步骤调用 API、命令行、浏览器 DOM 或文件工具，只有没有更精确接口时才调用 Computer Use。它还要判断什么时候需要确认、如何验证结果、失败后是否重试，以及把什么证据交给用户。

这三个系统都能“操作电脑”，但它们解决的不是同一个问题。

真正的技术断点不在鼠标能不能移动，而在于：谁保存任务状态，谁选择动作媒介，谁承担失败和副作用的责任。

## 先把三个词分开

日常讨论里，Computer Use、GUI Agent、Browser Agent、RPA 和 AI Agent 经常被放在一起。它们的控制边界不同，先建立一个最小模型会更容易比较。

### 传统 GUI 自动化：脚本持有计划

传统 GUI 自动化包括宏录制、坐标脚本、浏览器自动化、RPA、Selenium、Playwright、Windows UI Automation、AppleScript、AutoHotkey 等。它们的共同点不是“有没有 AI”，而是流程主要由人或程序预先写好。

一次执行通常是：

1. 脚本指定目标窗口、元素或坐标。
2. 执行器发送鼠标、键盘、DOM 或系统级动作。
3. 程序用固定条件判断是否继续。
4. 出错后按预先写好的分支处理，或者停止。

它的优点是重复任务的成本低、结果容易复现、权限边界比较清楚。它的缺点也很明确：脚本作者必须提前知道路径，界面变化会变成维护工作。

### Computer Use：模型持有下一步动作

现代 Computer Use 通常采用下面的循环：

```text
任务 + 当前截图
        ↓
模型返回 click / type / scroll / wait
        ↓
客户端在浏览器或桌面执行
        ↓
返回新截图和执行结果
        ↺
```

Anthropic、Google 和 Microsoft 的 Computer Use API 都把动作执行放在客户端一侧：模型提出动作，应用负责执行，再把结果回填 [3][9][10]。模型并没有直接拿到鼠标，也不知道一次点击是否真的改变了业务状态。

Computer Use 解决的是“界面事先未知”这个问题。它不依赖每个网站都提供专用 API，也不要求开发者为每个软件写完连接器，因此可以处理原生桌面、远程桌面、遗留系统和只对人开放的界面。

代价是每一次动作都要经过视觉理解和环境反馈。窗口焦点、DPI、滚动位置、弹窗、加载时间、截图质量和坐标缩放，都会进入失败路径。Computer Use 是一个更通用的执行器，不是自动拥有业务判断能力的完整 Agent。

### Agent Use：Agent 持有目标，Computer Use 只是工具

Agent Use 不是另一个鼠标 API，而是把 Computer Use 放进一个更大的控制平面：

```text
用户目标
  ↓
规划：拆分任务、识别约束和副作用
  ↓
路由：API / CLI / DOM / UIA / Computer Use
  ↓
执行：在浏览器、桌面或隔离 VM 中完成动作
  ↓
观察：结构化结果、截图、日志、当前页面和文件状态
  ↓
验证：结果是否真的成立，是否需要回滚或人工确认
  ↺
```

因此三者的关系可以这样记：

| 类型 | 谁决定流程 | 谁选择下一步 | 最适合解决什么问题 |
|---|---|---|---|
| 传统 GUI 自动化 | 人或脚本 | 固定规则 | 高频、稳定、可重复流程 |
| Computer Use | 视觉模型 | 模型根据当前界面选择动作 | 未知界面、原生应用、遗留系统 |
| Agent Use | Agent | Agent 在多种工具之间路由 | 有目标、有约束、跨应用的长任务 |

Computer Use 可以没有 Agent，只做单次动作循环。Agent 也可以没有 Computer Use，只调用 API、代码和搜索工具。真正的产品会把两者组合起来。

## Computer Use 不是 2024 年才出现的

2024 年以后，Computer Use 变成了模型厂商的产品名，但“让程序代替人操作屏幕”已经经历了几轮演化。新产品改变的是决策来源和泛化方式，不是凭空发明了鼠标自动化。

### 第一阶段：按键精灵把“重复操作”变成脚本

按键精灵官网写明，它创立于 2001 年，由软件模拟鼠标和键盘动作，通过脚本代替用户执行一系列电脑或手机操作 [33]。它的历史定位很有代表性：让没有编程背景的用户也能录制、编辑和分享脚本，把“我每天要点几十次”变成“运行一次脚本”。

按键精灵的关键价值不只是坐标点击，而是把执行能力做成了一个普通用户可以使用的产品：

1. **录制降低了编写成本。** 用户先做一遍，系统记录动作。
2. **脚本保存了流程。** 同一套动作可以重复运行，也可以被修改和分发。
3. **插件和社区扩大了动作空间。** 脚本不再局限于几个鼠标事件，而是可以组合窗口、图像、文字和外部程序。
4. **代价由维护者承担。** 界面发生变化时，需要重新找图、改坐标、补等待或增加分支。

按键精灵今天的官网已经把 AI 视觉识别和元素定位加入产品描述，并把 ERP、浏览器、微信、钉钉等应用列入自动化场景 [33]。这说明传统脚本产品也在吸收视觉定位，但它的主语仍然是“脚本执行引擎”：流程由人定义，系统负责重复执行。

这里有一个经常被忽略的历史事实：许多所谓“AI Computer Use”解决的第一个问题，其实早已被脚本工具解决过。它们真正新增的是在任务执行时生成路径、解释新界面和处理未预先写好的分支。

### 第二阶段：screen scraping 和 RPA 进入企业流程

企业软件往往没有稳定的公开 API，尤其是旧 ERP、终端模拟器、虚拟桌面和内部系统。RPA 沿着 screen scraping 和 UI automation 的路径发展，用软件机器人读取屏幕或控件，再重复员工在界面上的操作。相关研究把 RPA 视为对早期 screen scraping 的延伸：当后端接口不可用时，UI 本身就成了自动化边界 [34]。

这一阶段的工程方法比宏脚本更系统：

- 用 DOM、控件树、UIA、OCR 或图像匹配代替单纯坐标。
- 用流程设计器、重试、日志、凭据库和队列管理批量任务。
- 用 API 或数据库连接处理能结构化处理的部分，再用 UI 自动化补齐遗留系统。

但 RPA 仍然是确定性软件。它可以通过选择器和规则提高抗变化能力，却不会自己理解“为什么这个字段应该填成这个值”。如果流程没有写出这个分支，机器人通常不会主动问用户。

### 第三阶段：LLM Agent 把“行动”放进推理循环

2022 年的 ReAct 论文把语言模型的推理轨迹和外部行动交错起来：模型一边形成计划，一边调用环境获取信息，再根据结果调整下一步 [35]。这一步的意义在于，Agent 不再只是一次性生成答案，而是可以观察外部状态、执行动作、处理异常。

早期的 Agent 主要调用搜索、知识库、网页 API 或业务函数。它们的动作对象是结构化工具，执行结果通常是文本或 JSON。这样做精确、便宜、容易验证，但前提是每个业务系统都提供可调用接口。

于是出现了两个问题：没有 API 的软件怎么办？页面上的信息如果只存在于视觉布局里怎么办？

WebArena 和 VisualWebArena 把真实网站和视觉信息引入评测；OSWorld 则把浏览器、办公软件、文件系统和操作系统组合成更开放的桌面任务 [25][30][36]。研究开始从“模型能不能调用函数”转向“模型能不能在一个持续变化的电脑环境里完成工作”。

### 第四阶段：Computer Use 被模型厂商产品化

Anthropic 在 2024 年 10 月公开 Computer Use beta，允许 Claude 看屏幕、移动光标、点击和输入；官方同时承认这一能力当时仍然实验性强、容易出错 [37]。2025 年 1 月，OpenAI 发布 Operator 研究预览，背后的 CUA 模型把视觉、推理和强化学习结合起来，通过截图和鼠标键盘动作操作 GUI [1][2]。

这两个节点让“模型直接使用电脑”从研究演示变成了 API 和产品能力。随后 Google、Microsoft、AWS 以及开源社区分别从模型、云端运行时、浏览器基础设施和本地 GUI Agent 方向进入。

但产品化没有消除旧问题，只是把问题移到了更高的层级：谁提供虚拟桌面，谁保存登录态，谁验证点击结果，谁审批付款或发送邮件，谁负责模型误操作。

## Agent Use 和传统 Computer Use 到底差在哪里

这不是“旧方案没有 Agent、新方案有 Agent”这么简单。传统自动化也有调度器，现代 Computer Use 也可以只有一个模型循环。真正的区别在于控制面是否拥有目标、状态和恢复责任。

### 1. 计划来源不同

传统脚本的计划在执行前就已经写好。执行时主要回答“下一条指令是什么”。

Computer Use 的模型根据截图临时生成下一步动作，主要回答“当前画面上应该点哪里”。

Agent Use 先维护一个任务级计划，再根据环境变化重排步骤。它要回答的是“为了完成用户目标，下一件有价值的事情是什么”。

### 2. 状态粒度不同

传统脚本通常关心窗口、元素和几个成功条件。Computer Use 关心截图、页面和动作结果。Agent Use 还要维护业务状态，例如：订单是否已经创建、邮件是否已发送、文件是否写入正确目录、这次重试会不会造成重复提交。

这也是为什么“模型说完成了”不能作为成功信号。任务状态必须由独立的结果检查确认。

### 3. 工具选择不同

传统 GUI 自动化只有一条主要路径。纯 Computer Use 也常常把所有事情都压成截图和坐标。

Agent Use 应该有路由器：

1. 能调用 API，就不要模拟点击。
2. 能用 CLI 或文件工具完成，就不要打开编辑器。
3. 浏览器有稳定 DOM 或 CDP 接口，就优先使用结构化定位。
4. 只有原生 GUI、视觉布局、远程桌面或未知控件没有更好接口时，才使用 Computer Use。

Claude Code 文档把 MCP、Bash、Chrome 放在 computer use 之前，并把后者描述为范围最广、速度最慢的路径 [4]。这不是一个小的产品偏好，而是 Agent Use 的核心原则：让模型处理意图和路由，让 Computer Use 处理最后一公里。

### 4. 失败处理不同

传统脚本失败后通常进入预定义分支。纯 Computer Use 失败后可能继续截图和猜测。

Agent Use 应该区分三种情况：

- **可恢复：** 页面还在、动作未产生副作用，可以等待、重试或换工具。
- **状态不明：** 不知道是否已经提交，必须先查询或交给用户确认。
- **高风险：** 涉及支付、删除、发信、权限和生产部署，必须在动作前确认。

Agent 的“聪明”最终表现为它什么时候不继续，而不是它能连续点击多少次。

## 市场上的项目，实际上分成四类

下面的项目不是同一维度的竞品。有人卖模型，有人卖浏览器，有人提供本地执行器，有人提供研究环境。把它们放在一张表里，是为了看清每一层的责任边界。

| 类型 | 代表项目 | 强项 | 短板 |
|---|---|---|---|
| 闭源模型/API | OpenAI CUA、Anthropic Computer Use、Gemini Computer Use、Microsoft Foundry | 模型能力、模型更新、统一 API、安全策略和文档相对完整 | 需要开发者自建执行循环；模型、额度、数据边界和版本受供应商控制 |
| 闭源产品/harness | Operator lineage、Claude Code/Cowork、Nova Act | 把规划、工具、审批、运行时和用户界面组合在一起，启动成本低 | 平台和套餐限制明显，真实桌面、长任务和高风险操作仍需监督 |
| 开源/混合浏览器栈 | Browser Use、Stagehand + Browserbase、Skyvern | 浏览器操作、身份、录制、工作流和扩展能力较强；可自托管或接云 | 开源 Agent 与托管 Cloud 不是同一体验，自托管需要自己维护浏览器集群和登录态 [12][13][14] |
| 开源 GUI/Agent 研究栈 | UI-TARS、UFO、Agent S2、OpenHands、OpenAdapt | 本地化、可替换模型、专用 grounding、Windows/桌面能力和研究可复现性 | 环境、权限、回放、评测、恢复和生产治理通常需要用户自行补齐 [15][17][18][20][23] |

### 闭源项目做得好的地方

闭源项目真正卖的通常不只是模型调用，而是默认运行时：浏览器或 VM 已经准备好，登录态有保存位置，截图和动作有协议，审批有 UI，失败可以回到用户。

Anthropic 的 API 明确了“模型请求工具—客户端执行—返回 tool result”的边界 [3]。OpenAI 的 Codex app-server 则把 thread、turn、item、审批事件和流式更新纳入协议 [7]。这些设计减少了用户自己拼接消息、动作、结果和权限的工作量。

### 开源项目做得好的地方

开源项目更容易在单点上做深：UI-TARS 关注原生 GUI 模型和统一动作空间；Agent S2 研究通用模型与专用 grounding 模型的组合；UFO 关注 Windows 的 HostAgent/AppAgent 和 GUI/API 混合；OpenHands 把代码、终端、浏览器和沙箱放进开发 Agent；OpenAdapt 则把演示录制、编译、验证和可治理工作流作为重点 [15][17][18][20][23]。

它们适合需要本地模型、私有数据、特殊桌面环境或研究创新的团队。开源的价值不只是免费，而是能够替换模型、检查动作协议、修改执行器和把系统接入自己的治理面。

## 为什么 Codex 和 Claude Code 的体验通常更好

这里的“更好”要先限定范围：它们主要是软件工程 Agent，能够读代码、运行命令、修改文件和调用工具；Computer Use 是补充能力，而不是整个产品的唯一入口。因此它们并不是所有 GUI benchmark 的统一冠军，体验优势来自产品组合。

### 第一，入口不是截图，而是任务目标

用户说“把这个项目跑起来并修掉测试”，Codex 或 Claude Code 通常先读取仓库、检查配置、运行测试和查看错误。它们不会为了打开一个终端，先让视觉模型识别终端图标、点击窗口，再猜命令是否输入成功。

这条路径的信息密度更高：文件内容是文本，测试失败是日志，代码修改可以产生 diff，命令退出码可以作为状态。只有目标落在原生 GUI、浏览器视觉布局或无法结构化访问的软件上，才需要 Computer Use。

### 第二，工具路由已经成为产品行为

Claude Code 的文档明确给出了 MCP、Bash、Chrome、computer use 的优先顺序 [4]。Codex CLI 则把探索、计划、编辑、运行、审批和复查放在同一个终端循环中 [6]。

这比“给模型一张截图，让它自己想办法”少了很多不确定性。模型在高信息密度的接口上工作，Computer Use 只承担结构化工具触达不了的部分。

### 第三，权限和副作用是显式状态

Claude Code 提供项目范围、编辑确认、计划模式、自动批准和沙箱等权限层 [5]。Codex 的事件协议能够在活动 turn 中发出审批请求，用户可以看到正在批准什么 [7]。

用户感受到的是“我知道它要改什么，必要时可以拦住”，而不是“它已经在屏幕上点了几下，我只能等结果”。

### 第四，验证材料天然存在

代码 Agent 的结果通常可以用测试、diff、编译产物、退出码和文件状态验证。即使 Computer Use 参与了启动浏览器或检查界面，前后的日志和代码变化仍然可以作为上下文。

纯 GUI Agent 必须从截图里推断成功；Codex 和 Claude Code 往往能把截图放进一个更大的证据链里。这个差别会直接影响恢复和信任。

所以，Codex 和 Claude Code 的体验优势更接近下面这个公式：

```text
体验 = 工具路由 + 可观察状态 + 权限审批 + 结果验证 + 会话恢复
```

视觉模型能力当然重要，但它只是公式中的一个变量。

## 为什么很多开源 Computer Use 项目用起来不够顺

先把“开源体验不够好”改成一个更准确的问题：开源项目通常把哪些责任留给了使用者？

### 1. 用户需要自己准备执行环境

API 文档只告诉你模型返回了一个点击动作，但你还要准备虚拟显示器、浏览器或桌面、输入注入、截图、分辨率、DPI、网络和登录态。任何一层不稳定，模型都会表现得像是“不会操作”。

### 2. 用户需要自己定义成功条件

很多 demo 的成功条件是“模型最后说完成”。真正的任务需要检查数据库、文件、页面记录、发送回执和权限状态。验证器没有默认提供时，开源 Agent 很容易完成动作，却没有完成业务。

### 3. 用户需要自己处理恢复

浏览器崩溃、登录过期、弹窗遮挡、验证码、焦点丢失和部分提交，都要求 session、checkpoint、幂等性和回滚策略。开源项目常常有单个组件，但缺少把这些状态串起来的默认控制面。

### 4. 用户需要自己承担安全治理

Computer Use 看到的网页、邮件、文档和图片都可能包含诱导模型改变目标的文字。OS-Harm 和 VPI-Bench 分别从桌面误用、提示注入和视觉注入角度评估了这一风险 [31][32]。沙箱、最小权限、审批、网络隔离和敏感数据脱敏不能靠一个 system prompt 代替。

### 5. 开源项目的强项通常是专用能力

UI-TARS、Agent S2、UFO、OpenHands 和 OpenAdapt 并不是“一个按钮替代所有平台”的产品。它们在原生 GUI、grounding、Windows、代码 Agent 或工作流编译上各有强项 [15][17][18][20][23]。

如果用户期待的是云产品那种“注册、登录、输入目标、持续运行”，拿一个模型仓库或研究框架直接比较，结果当然会觉得不顺。开源路线把控制权交给用户，也把平台工程交给用户。

## Computer Use 应该怎样和 Agent 配合

一个可落地的架构，至少需要以下六个角色。

### 1. Planner：只负责目标和约束

Planner 把自然语言目标拆成步骤，识别数据范围、成功条件和副作用。它不应该默认拥有所有写入权限，也不应该把每个低层点击提前写死。

### 2. Router：选择最便宜、最可验证的媒介

Router 按以下顺序尝试：API、MCP、CLI、文件工具、DOM/CDP、Accessibility Tree/UIA，最后才是截图和鼠标键盘。每次降级都意味着更高的延迟、更弱的可观测性和更严格的验证要求。

### 3. Computer-use worker：只执行当前最小动作

视觉 Worker 不需要承担整个任务。它接收当前目标、允许的区域、动作预算和成功条件，只完成一步或一个局部子任务，然后返回截图、动作和环境变化。

### 4. Verifier：不要相信模型的自我报告

Verifier 检查真实结果：记录是否存在、文件是否写入、页面是否跳转、消息是否发送、金额是否正确、当前用户是否仍然有权限。对不可逆操作，Verifier 还要检查是否已经取得用户确认。

### 5. Checkpoint：让长任务可以继续

每个重要阶段保存当前 URL、窗口、登录态引用、已完成步骤、业务对象 ID、截图和最后一次确认。否则 Agent 失败后只能从头猜测，重复提交的风险会随着重试次数增加。

### 6. Human takeover：把不确定性交给人

付款、删除、发邮件、修改权限、接受条款、发布生产和提交表单，都应该在副作用前显示：动作目标、影响范围、当前截图、是否可撤销以及允许用户选择的下一步。

完整流程可以写成：

```text
目标
 → 计划
 → 工具路由
 → 最小动作
 → 结构化结果 + 截图
 → 独立验证
 → 继续 / 重试 / 回滚 / 人工接管
```

对于每天重复的流程，不要永远让大模型从头推理。可以先让 Agent 观察和录制，再把稳定路径编译成脚本或工作流；只有页面漂移、异常分支和无法结构化判断的地方，才重新调用模型。这正是传统自动化低成本和 Agent 泛化能力可以结合的地方。

## 体验差异应该怎么测

只比较“成功率”不够。WebArena 早期结果中，最好的 GPT-4 Agent 端到端成功率为 14.41%，人类为 78.24% [30]；OpenAI 在发布 CUA 时报告 OSWorld 38.1%、WebArena 58.1%、WebVoyager 87.0% [1]。这些数字说明模型在不同环境中的能力差异很大，但仍不能直接回答用户体验问题。

OSWorld-Human 的分析发现，一些 Agent 即使完成任务，也会使用必要步骤的 1.4–2.7 倍 [27]。多余截图、重复点击、错误恢复和长规划都会增加等待时间。一个系统是否值得使用，还要看它能不能用更少的动作完成任务，失败后能不能继续，以及何时会主动停下来。

建议至少记录以下指标：

| 指标 | 说明 |
|---|---|
| 任务成功率 | 业务结果是否成立，而不是模型是否输出“完成” |
| 动作数和端到端延迟 | 识别重复观察、无效点击和过长规划 |
| 恢复率 | 页面变化、超时或部分成功后能否继续 |
| 人工接管次数 | Agent 是否经常把不确定性转嫁给用户 |
| 副作用前确认准确率 | 是否在付款、删除、发信前正确停下 |
| 证据完整度 | 能否给出截图、日志、记录 ID、diff 或回执 |
| 安全事件 | 提示注入、越权、敏感数据暴露和错误提交 |

评测时还要固定模型版本、窗口大小、DPI、浏览器/OS 镜像、登录态、动作上限、网络条件和成功判定脚本。否则比较出来的很可能是环境差异，而不是产品差异。

## 选型结论：不要从“能不能控制电脑”开始问

如果任务是代码、数据查询、文件处理或业务 API，优先选择 Codex、Claude Code 或其他工具型 Agent，让它们在文本和结构化接口中完成工作。

如果任务是浏览器表单、后台录入和网页流程，Browser Use、Stagehand、Skyvern 或托管浏览器服务更合适。它们把浏览器会话、DOM、CDP、身份和可观测性放在同一条链路里 [12][13][14]。

如果任务是原生桌面、远程桌面、旧软件或视觉验证，UI-TARS、UFO、Anthropic Computer Use、Gemini Computer Use 或 Microsoft Foundry 这类 Computer Use 路线才有价值 [3][9][10][15][18]。

如果任务每天重复、路径稳定，应先做成确定性工作流；如果任务长尾、界面未知、需要跨应用判断，再让 Agent 使用 Computer Use 作为降级执行器。

这也解释了为什么“按键精灵”和今天的 Agent 并没有被谁彻底替代。按键精灵擅长把确定的事情低成本重复做；Computer Use 擅长在界面未知时找到下一步；Agent Use 负责把目标、工具、状态、权限和验证串起来。

## 小结

按键精灵把“人做一遍、机器重复做”变成了普通用户可以使用的脚本产品。RPA 把这种能力带进了企业流程，用控件、选择器、OCR、日志和队列提高了可维护性。ReAct 让模型开始在行动和观察之间更新计划。Computer Use 把动作接口从 API 扩展到人类看到的屏幕。Agent Use 再把 Computer Use 放回一个更完整的任务控制平面。

因此，Computer Use 的终点不是让模型永远模仿人的鼠标轨迹。更合理的方向是：能调用 API 时调用 API，能运行代码时运行代码，只有在界面本身成为唯一接口时才看屏幕；每一次降级都配套状态记录、结果验证和人工接管。

判断一个项目是否成熟，可以先问三个问题：它能否选择更精确的工具？它能否证明副作用已经发生或没有发生？它能否在不确定时停下来？

## Bibliography

[1] OpenAI (2025). "Computer-Using Agent". OpenAI. https://openai.com/index/computer-using-agent/
[2] OpenAI (2025). "Operator System Card". OpenAI. https://openai.com/index/operator-system-card/
[3] Anthropic (2026). "Computer use tool - Claude Platform Docs". Anthropic. https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
[4] Anthropic (2026). "Let Claude use your computer from the CLI". Claude Code Docs. https://code.claude.com/docs/en/computer-use
[5] Anthropic (2026). "Configure permissions". Claude Code Docs. https://code.claude.com/docs/en/permissions
[6] OpenAI (2026). "Codex CLI". ChatGPT Learn. https://learn.chatgpt.com/docs/codex/cli
[7] OpenAI (2026). "codex-app-server". GitHub. https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
[8] Google DeepMind (2025). "Introducing the Gemini 2.5 Computer Use model". Google Blog. https://blog.google/innovation-and-ai/models-and-research/google-deepmind/gemini-computer-use-model/
[9] Google (2026). "Computer use | Gemini API". Google AI for Developers. https://ai.google.dev/gemini-api/docs/generate-content/computer-use
[10] Microsoft (2026). "Use the computer use tool for agents". Microsoft Learn. https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/computer-use
[11] Amazon Web Services (2026). "Amazon Nova Act Documentation". AWS. https://docs.aws.amazon.com/nova-act/
[12] Browserbase (2026). "Stagehand". GitHub. https://github.com/browserbase/stagehand
[13] Browser Use (2026). "Browser Use". GitHub. https://github.com/browser-use/browser-use
[14] Skyvern (2026). "Skyvern: Automate Browser-based Workflows with AI". GitHub. https://github.com/skyvern-ai/skyvern
[15] ByteDance Seed (2026). "UI-TARS Desktop". GitHub. https://github.com/bytedance/ui-tars-desktop
[16] Qin, Yujia, Yining Ye, and Junjie Fang (2025). "UI-TARS: Pioneering Automated GUI Interaction with Native Agents". arXiv. https://arxiv.org/abs/2501.12326
[17] Agashe, Saaket, Kyle Wong, and Vincent Tu (2025). "Agent S2: A Compositional Generalist-Specialist Framework for Computer Use Agents". arXiv. https://arxiv.org/abs/2504.00906
[18] Microsoft (2026). "UFO: A UI-Focused Agent for Windows OS Interaction". GitHub. https://github.com/microsoft/UFO
[19] Microsoft (2026). "UFO2: Weaving the Digital Agent Galaxy". OpenReview. https://openreview.net/pdf/480181d05d662b8858afdba83246a9ff756836fe.pdf
[20] OpenHands (2026). "OpenHands: AI-Driven Development". GitHub. https://github.com/OpenHands/OpenHands
[21] Wang, Xingyao, Boxuan Li, and Yufan Song (2024). "OpenHands: An Open Platform for AI Software Developers as Generalist Agents". arXiv. https://arxiv.org/abs/2407.16741
[22] ServiceNow (2026). "BrowserGym: A Gym Environment for Web Task Automation". GitHub. https://github.com/ServiceNow/BrowserGym
[23] OpenAdapt (2026). "OpenAdapt: AI-First Process Automation with Large Multimodal Models". GitHub. https://github.com/OpenAdaptAI/OpenAdapt
[24] Open Interpreter (2026). "Open Interpreter: A Natural Language Interface for Computers". GitHub. https://github.com/OpenInterpreter/open-interpreter
[25] XLang (2024). "OSWorld: Benchmarking Multimodal Agents for Open-Ended Tasks in Real Computer Environments". arXiv. https://arxiv.org/abs/2404.07972
[26] XLang (2026). "OSWorld". GitHub. https://github.com/xlang-ai/osworld
[27] Yu, Jing, Yuan Yang, and Yueqian Zhang (2025). "OSWorld-Human: Benchmarking the Efficiency of Computer-Use Agents". arXiv. https://arxiv.org/abs/2506.16042
[28] Microsoft (2026). "Windows Agent Arena". GitHub. https://github.com/microsoft/WindowsAgentArena
[29] Google DeepMind (2024). "AndroidWorld: A Dynamic Benchmarking Environment for Autonomous Agents". Google Research. https://google-research.github.io/android_world/
[30] Zhou, Shuyan, Frank F. Xu, and Hao Zhu (2023). "WebArena: A Realistic Web Environment for Building Autonomous Agents". arXiv. https://arxiv.org/abs/2307.13854
[31] OS-Harm authors (2025). "OS-Harm: A Benchmark for Measuring Safety of Computer Use Agents". NeurIPS. https://proceedings.neurips.cc/paper_files/paper/2025/hash/4009bff0cd87ba2203c8e3a2f082aaec-Abstract-Datasets_and_Benchmarks_Track.html
[32] VPI-Bench authors (2025). "VPI-Bench: Visual Prompt Injection Attacks for Computer-Use Agents". arXiv. https://arxiv.org/abs/2506.02456
[33] 按键精灵官方. "按键精灵软件介绍". https://www.anjian.com/intro.shtml
[34] van der Aalst, Wil, et al. (2022). "Reactive synthesis of software robots in RPA from user interface logs". ScienceDirect. https://www.sciencedirect.com/science/article/pii/S016636152200118X
[35] Yao, Shunyu, et al. (2022). "ReAct: Synergizing Reasoning and Acting in Language Models". arXiv. https://arxiv.org/abs/2210.03629
[36] Koh, Jing Yu, et al. (2024). "VisualWebArena: Evaluating Multimodal Agents on Realistic Visual Web Tasks". ACL Anthology. https://aclanthology.org/2024.acl-long.50/
[37] Anthropic (2024). "Introducing computer use, a new Claude 3.5 Sonnet, and Claude 3.5 Haiku". https://www.anthropic.com/news/3-5-models-and-computer-use

## Methodology Appendix

本文先按“传统 GUI 自动化—RPA—LLM Agent—Computer Use—Agent Use”的时间和机制顺序整理材料，再比较产品的开放性、执行媒介、运行时和治理边界。历史节点使用官方产品页面、论文或官方研究博客；市场判断使用产品文档、项目仓库和评测论文。

文中关于“Codex/Claude Code 体验更好”“开源项目需要更多工程拼装”的部分，是基于工具路由、权限、运行时、验证和恢复机制的综合判断，不是所有任务上的统一 benchmark 排名。厂商自报结果与独立评测分开引用，成功率、动作数和延迟只有在给出数据集与口径时才作比较。

复现实验时应固定：模型和版本、截图尺寸与 DPI、浏览器/OS 镜像、登录态、任务初始状态、动作上限、网络条件、成功判定脚本、人工确认规则和是否允许 API/DOM/CLI 工具。至少同时记录成功率、动作数、端到端延迟、恢复率、人工接管次数和最终证据完整度。
