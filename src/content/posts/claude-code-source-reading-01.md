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

## 本章先建立三个概念

- **控制平面**：负责决定下一步动作、权限与停止条件；Query Core 是这条决策链的中心。

- **数据平面**：承载消息、工具结果、文件状态和扩展能力，让控制决策能够作用到真实环境。

- **宿主适配层**：REPL、IDE、SDK 与远程入口通过稳定事件契约复用同一套运行时。

![Claude Code 控制平面与数据平面的关系](/images/posts/claude-code-source-reading-01/01-control-data-planes-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇最后留下的问题是，因为这次源码泄漏事件，网友们发现了 Claude Code 中的哪些 bug。

先说答案。源码公开以后，网友确实顺着它找到了不少有意思的问题。不过，这些发现并不都代表 Claude Code 现在仍然存在漏洞。有些 bug 可以实际复现，有些只是源码注释记录下来的历史事故，还有一些属于值得继续验证的攻击面。

第一个问题和 prompt cache 有关。一份公开 issue 记录了这样一个现象：恢复会话以后，Skills 列表和其他系统信息移动到了新的位置。人眼看到的文本内容近似不变；按照前缀匹配的缓存会因顺序变化而重写后续内容。复现数据中，每恢复一次会话，都会重新创建大约 3800 个缓存 token。这也解释了为什么有些用户只是继续一段旧对话，token 消耗却像重新开始了一次会话。

第二个问题更夸张。泄露源码中的一段注释记录，Claude Code 曾经有 1279 个会话连续压缩失败 50 次以上，最严重的一个会话失败了 3272 次，每天因此浪费大约 25 万次 API 调用。独立的源码整理也记录了这组数字。2.1.88 已经加上熔断保护，连续失败 3 次就停止重试。因此，这段源码记录的是已经加入保护的历史故障。

第三个问题出现在权限检查里。某些看起来安全的命令曾经可以提前得到允许，后面的重定向检查因此不会继续执行。一条原本只是提交 Git 记录的命令，就可能把输出写进 shell 启动配置，并在用户下次打开终端时产生副作用。2.1.88 中已经能看到针对这个路径的保护。安全分析也把重点放在了多套 shell 解析逻辑之间的差异上。

这三个 bug 分别落在上下文与模型、会话内核、执行与权限三个区域。理解它们的共同前提，是把 Claude Code 看成一套由多个区域协作的 Agent 系统。

## 这一篇从系统地图开始

Claude Code 2.1.88 的源码规模不小。第一次开始阅读时，很容易在终端界面、工具、权限、MCP、Plugin 和各种状态模块之间来回跳，最后记住了很多名字，却仍然说不清整个系统是怎么组织的。

阅读大型项目时，先建立地图才能给后续细节定位。

所以，这一篇先不追具体调用，也不分析某一个工具怎样执行。我们只回答 Claude Code 由哪些区域组成、每个区域分别负责什么。

本文以 Query Core 为中心，把外围职责分成 Host / UI、Context & Model、Execution & State、Extensions 四个区域。讨论范围是 `@anthropic-ai/claude-code@2.1.88`；下图是根据公开发布物中可观察模块职责整理出的阅读模型，证据身份属于源码重建图。

![Claude Code 2.1.88 手绘系统架构地图](/images/posts/claude-code-source-reading-01/01-architecture-map.png)

整张图以 Query Core 为中心，外围分成 Host / UI、Context & Model、Execution & State、Extensions 四个区域。

这样划分以后，Claude Code 就不再是一堆互相调用的文件，而是一个以会话内核为中心、不断从外围获得输入、上下文、执行能力和扩展能力的 Agent 系统。

## Query Core：把各个区域组织起来

Query Core 位于整张图中间。

它接收来自宿主的请求，带上当前会话的上下文和可用能力，推动模型继续工作，并把产生的事件交回外部。一次任务可能很短，也可能需要多轮思考和工具调用，但这些变化都由同一个会话中心协调。

Query Core 的职责是组织各区域协作。

它不会自己渲染终端，也不会亲自读写每一个文件，更不会实现所有外部协议。它做的是把不同区域连接起来，让输入、模型、工具和状态可以围绕同一个会话协作。

这也是为什么把它放在地图中央。后面无论读到权限、上下文压缩、MCP 还是后台任务，都可以先判断它向 Query Core 提供了什么。

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

现在可以把 Claude Code 理解成一个以 Query Core 为中心的 Agent runtime。

Host / UI 负责接入，Context & Model 提供当前认知，Execution & State 提供受控行动，Extensions 继续扩大能力边界。Query Core 把这些内容组织成一个可以持续工作的会话。

这张图表达职责关系；请求的执行顺序由具体路径决定。简单问答通常只经过部分区域，MCP 也只在完成配置和连接后进入工具池。

下一篇才会把这张静态地图变成一条时间线，追踪一次请求怎样从用户输入走到模型、工具和最终输出。01 负责说明“系统里有什么”，02 再解释“请求怎样运行”。

## 小结

阅读 Claude Code 时，可以先记住五个坐标。

Query Core 是会话中心，Host / UI 是宿主边界，Context & Model 管理模型当前看到的信息，Execution & State 承担真实能力和状态管理，Extensions 把新的能力接入系统。

有了这张地图，后面遇到任何模块时，我们都可以先判断它属于哪个区域，再理解它怎样与会话中心配合。这样读下去，细节会越来越多，整体结构却不会丢。

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
