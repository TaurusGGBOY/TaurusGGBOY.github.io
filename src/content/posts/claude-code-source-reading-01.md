---
title: "Claude Code源码解读01：从系统地图开始，认识 Claude Code 的整体架构"
published: 2026-07-17
description: "从 Claude Code 2.1.88 的系统地图开始，理解入口、查询内核、上下文、执行状态和扩展能力之间的边界。"
tags: ["claude-code", "source-code", "ai-agent", "architecture"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-01/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇最后留下的问题是，因为这次源码泄漏事件，网友们发现了 Claude Code 中的哪些 bug。

先说答案。源码公开以后，网友确实顺着它找到了不少有意思的问题。不过，这些发现并不都代表 Claude Code 现在仍然存在漏洞。有些 bug 可以实际复现，有些只是源码注释记录下来的历史事故，还有一些属于值得继续验证的攻击面。

第一个问题和 prompt cache 有关。一份公开 issue 记录了这样一个现象：恢复会话以后，Skills 列表和其他系统信息移动到了新的位置。人眼看到的文本内容近似不变；按照前缀匹配的缓存会因顺序变化而重写后续内容。复现数据中，每恢复一次会话，都会重新创建大约 3800 个缓存 token。这也解释了为什么有些用户只是继续一段旧对话，token 消耗却像重新开始了一次会话。

第二个问题更夸张。泄露源码中的一段注释记录，Claude Code 曾经有 1279 个会话连续压缩失败 50 次以上，最严重的一个会话失败了 3272 次，每天因此浪费大约 25 万次 API 调用。独立的源码整理也记录了这组数字。2.1.88 已经加上熔断保护，连续失败 3 次就停止重试。因此，这段源码记录的是已经加入保护的历史故障。

第三个问题出现在权限检查里。某些看起来安全的命令曾经可以提前得到允许，后面的重定向检查因此不会继续执行。一条原本只是提交 Git 记录的命令，就可能把输出写进 shell 启动配置，并在用户下次打开终端时产生副作用。2.1.88 中已经能看到针对这个路径的保护。安全分析也把重点放在了多套 shell 解析逻辑之间的差异上。

这三个 bug 分别落在上下文与模型、会话内核、执行与权限三个区域。理解它们的共同前提，是把 Claude Code 看成一套由多个区域协作的 Agent 系统。

## 本章先建立三个概念

- **控制平面**：负责决定下一步动作、权限与停止条件；Query Core 是这条决策链的中心。

- **数据平面**：承载消息、工具结果、文件状态和扩展能力，让控制决策能够作用到真实环境。

- **宿主适配层**：REPL、IDE、SDK 与远程入口通过稳定事件契约复用同一套运行时。

![Claude Code 控制平面与数据平面的关系](/images/posts/claude-code-source-reading-01/01-control-data-planes-detail-handdrawn.png)

这张图只表达职责边界。读到具体函数时，先判断它是在做决策、搬运数据，还是把能力接给宿主，再追它如何回到 Query Core。

## 09:12，一张金额单位工单进入值班群

假设你是支付结算组的值班工程师。周二上午 09:12，客服把一张线上工单转进值班群：用户的订单页显示“实付 99.90 元”，支付回调里的 `amount` 却变成了 `9991`。财务对账还没有大面积报警，但这笔订单已经被标记成“待人工核对”，如果午间批处理前不能确认原因，值班同事就得逐笔补偿。

你先在群里问清三件事：页面金额来自哪个接口，回调里的数字是元还是分，问题只发生在使用优惠券的订单上，还是所有支付都可能受影响。客服随后补了一张截图，后端同事贴出一条脱敏日志，测试同事说昨天刚合并过一批优惠券回归用例。线索不完整，却足够说明这不是单纯改一个显示字符串，而是一次跨前端、订单服务和支付回调的调用链调查。

你切到支付服务的工作目录，确认当前分支没有未提交修改，打开 `claude`，输入：

> 请检查支付服务中的金额单位工单：订单使用优惠券后，结算页显示 99.90 元，支付回调却记录为 9991 分。请沿调用链查清元/分转换发生在哪一层，先给出证据和计划，不要直接修改文件；确认后修复，并运行受影响的测试。

这句话看起来只是一个 prompt，进入 Claude Code 后却会穿过多个区域：Host 负责接收输入并展示权限询问，Query Core 负责组织回合，Context/Model 决定模型这一刻能看到哪些规则和证据，Execution/State 把读取、测试和修改落到工作区，Extensions 则可能提供工单系统、浏览器或团队协作能力。你关心的是金额单位，源码要处理的却是这些区域之间的边界。

本章先不急着追某个函数。我们把这张工单当作一张系统地图的入口，沿着“输入进入—模型决策—工具执行—状态回流”的方向看清 Claude Code 的四个外围区域。后面每篇文章都会回到这个现场，但只截取与当前主题有关的一段。

## 这一篇从系统地图开始

当一次请求失败时，错误可能出现在终端渲染、提示词组装、工具权限、文件执行或 MCP 连接。只按文件名找入口，通常会把“谁决定”和“谁执行”混在一起。架构图的作用，是先把这两类职责分开。

本文的判断是：2.1.88 的代码可以沿一次会话分成四个外围区域，但它们都通过 Query Core 交换状态；这是一张源码重建图，不是 Anthropic 发布的官方模块图。

接下来只回答两个问题：每个区域保存什么状态，哪个调用边界把它交给 Query Core。具体工具的实现先留到后文。

![Claude Code 2.1.88 手绘系统架构地图](/images/posts/claude-code-source-reading-01/01-architecture-map.png)

整张图以 Query Core 为中心，外围分成 Host / UI、Context & Model、Execution & State、Extensions 四个区域。

这样划分以后，Claude Code 就不再是一堆互相调用的文件，而是一个以会话内核为中心、不断从外围获得输入、上下文、执行能力和扩展能力的 Agent 系统。

## Query Core：把各个区域组织起来

Query Core 接收宿主提交的消息和能力快照，调用模型，消费 `tool_use`，再把事件交回宿主。它持有的是一次会话的控制流，不是终端状态或某个文件的内容。

这条边界解释了许多调用关系：REPL 负责输入和渲染，Context & Model 准备模型看到的内容，Execution & State 执行并记录副作用，Extensions 只通过工具、命令或生命周期接口加入能力。Query Core 把这些输入拼成下一轮请求。

如果一个模块既直接改终端、又直接决定工具权限，就很可能跨越了这张图的职责边界；阅读源码时应继续追它把状态交给哪个区域，而不是按目录名猜职责。

## Host / UI：系统怎样被使用

Host / UI 是 Claude Code 与用户或其他程序接触的边界。

最常见的宿主是命令行和交互式终端。用户在这里输入任务，看到模型输出、工具进度和权限确认。除此之外，同一套能力也可以通过 SDK 或远程连接交给其他程序使用。

不同宿主关心的东西并不一样。终端更重视交互体验，SDK 更重视结构化事件，远程模式还要处理连接和传输。但它们最终完成的是同一件事：把外部输入交给会话内核，再把内核产生的结果变成外部能够使用的形式。

因此，终端只是 Claude Code 的一种外壳。换一个宿主，并不需要重新实现整个 Agent。

## Context & Model：模型这一刻知道什么

模型输入由用户消息和运行时上下文共同构成。

系统指令、项目说明、历史消息、Memory 和可用能力都会共同形成当前上下文。会话变长以后，系统还要处理内容压缩和历史保留，否则上下文会不断膨胀。

Model 部分则决定当前使用什么模型，以及相关的推理和资源配置。相同的用户输入，在不同上下文、不同模型或不同历史状态下，可能产生完全不同的下一步。

所以，Context & Model 区域管理的是模型眼中的世界。Query Core 负责让会话继续，Context & Model 决定这一轮会话建立在什么信息之上。

## Execution & State：让决定落到真实环境

模型可以提出读取文件、搜索代码、执行命令或修改内容，但这些动作最终要由 Claude Code 在真实环境中完成。

Tools 提供具体能力，Permission 控制能力边界，Task 管理持续时间更长的工作，State 记录系统当前处于什么状态。它们共同组成执行区域。

这个区域之所以重要，是因为 Agent 与普通聊天产品的差别就在这里。聊天产品主要生成内容，Agent 还会对外部环境产生影响。一旦涉及文件、命令和网络，系统就必须知道当前能做什么、是否允许做、执行到哪里，以及怎样停止。

执行能力越强，状态和权限就越不能被当成附属功能。它们决定了模型的想法能否安全地变成真实动作。

## Extensions：把能力继续向外扩展

Claude Code 通过扩展接口继续增加核心之外的能力。

Skill 可以提供可复用的工作方法，MCP 可以接入外部工具和服务，Plugin 可以组合命令、能力与配置，LSP 则把语言服务引入代码工作流。

这些扩展来自不同位置，却有一个共同目标：在不重写会话内核的前提下，让 Claude Code 获得新的能力。

这说明扩展系统的核心指标是边界稳定性。只要新能力能够通过已有接口进入系统，Query Core 只依赖接口契约即可推进请求。

当然，某种扩展存在，不代表它会在每次会话中启用。最终可用能力仍然取决于配置、运行模式和当前环境。

## 四个区域怎样配合

这张图表达职责，不表达每次请求都会经过的固定顺序。简单问答可能只触及 Host、Context 和 Model；启用 MCP 后，扩展能力才会装进当前工具池；涉及文件修改时，Execution & State 才跨过副作用边界。

下一篇把同一张图改成时间线：从 Host 提交输入，到 Query Core 触发模型、工具和结果回环。01 要记住的是“谁拥有哪类状态”，而不是模块数量。

## 小结

阅读 Claude Code 时，先问模块维护的是哪类状态，以及它通过什么事件或回调回到 Query Core。这个判断比记住文件路径更稳定：模型流、权限结果和工具输出最后都要回到同一条会话控制流。

## 留给下一篇的问题

LangGraph 是一个有状态 Agent 编排框架。开发者可以把模型调用、工具执行和状态更新组织成不同节点，再通过节点之间的连接和条件，决定任务接下来怎样运行。

如果我们用 LangGraph 开发一个编程 Agent，它和 Claude Code 到底有什么区别？

## 参考资料

- [What the Claude Code Leak Tells Us About Supply Chain Security](https://coder.com/blog/what-the-claude-code-leak-tells-us-about-supply-chain-security)
- [Claude Code Security: What It Actually Secures](https://blog.vidocsecurity.com/blog/claude-code-security-what-it-actually-secures)
- [Claude Code Source Leak: Analysis](https://alex000kim.com/posts/2026-03-31-claude-code-source-leak/)
- [Claude Code Source Leak: With Great Agency Comes Great Responsibility](https://www.straiker.ai/blog/claude-code-source-leak-with-great-agency-comes-great-responsibility)
- [Claude Code 的工作方式](https://code.claude.com/docs/en/how-claude-code-works)

- [Dive into Claude Code：生产级 Agent 的设计空间](https://arxiv.org/abs/2604.14228)
