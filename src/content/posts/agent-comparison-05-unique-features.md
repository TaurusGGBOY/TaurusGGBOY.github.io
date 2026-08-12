---
title: "Agent源码对比05｜三套源码各自不可替代的部分"
published: 2026-08-12T10:25:00+08:00
updated: 2026-08-12
description: "从源码证据看 Claude Code、Codex 与 Pi 各自最有辨识度的记忆、宿主安全和扩展设计。"
tags: ["agent-source-comparison", "ai-agent", "agent-architecture", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-comparison-05-unique-features/agent-comparison-cover-handdrawn.png"
imagePosition: "left"
---

# Agent源码对比05｜三套源码各自不可替代的部分

上一篇最后问的是：**如果所有 Agent 都有主循环、工具、上下文和宿主，什么才是 Claude Code、Codex、Pi 各自最有辨识度的源码设计？**

先限定“不可替代”的意思。本文不是证明某家公司在全世界没有类似功能，而是对三个固定源码窗口做 bounded comparison：**在本次 Claude Code 2.1.88、Codex CLI commit `4ef836f...`、Pi commit `534bcbf...` 中，我没有看到另外两套提供同等接口或同样组合。** 这是源码阅读结论，不是产品排行榜。

外部资料也提示了三个方向：Claude 的 session 管理强调 compact、rewind、clear 和 subagent 的不同连续性选择；OpenAI 把 Codex App Server 描述成长期 thread 的 JSON-RPC 控制面；Pi 的作者则把“不内置 sub-agent、plan mode、permission popup”解释成让用户用扩展和外部工具组合工作流的哲学。把这些观点放回源码后，三个中心分别变得清楚：Claude 把产品记忆与协作层叠加到 Agent 上，Codex 把宿主/安全控制面做成一等协议，Pi 把 TypeScript 可塑性和极简核心交给使用者。

## 回答上一篇的问题

宿主协议解决的是“外部程序怎样看见和驱动 Agent”，但它不决定 Agent 产品的全部性格。决定性差异往往出现在协议之后：

- 如果系统关心跨会话的个人/团队知识，它需要持久化、检索、同步和隐私边界。
- 如果系统关心 IDE、审批和长期运行，它需要把 Thread、Turn、Item、sandbox 和事件生命周期稳定化。
- 如果系统关心快速改造和不被内置流程束缚，它需要让扩展真正能够注册、覆盖和重组内部能力。

## 介绍本章的一些概念

- **Positive evidence**：源码直接出现的函数、类型、调用链和文档说明。
- **Negative evidence**：在明确检查过的源码范围内没有找到同等接口。它只能支持“本窗口未见”，不能证明全世界不存在。
- **组合能力**：几个普通模块组合以后产生的架构特征，例如 Thread/Turn/Item + bounded queue + native sandbox。
- **Feature flag / runtime dependency**：源码有入口，但是否执行还取决于设置、GrowthBook、平台、服务端或宿主能力。
- **Product layer**：不改变基本模型循环，却改变 Agent 如何记忆、协作、显示进度或被扩展的上层能力。

![Claude Code、Codex 与 Pi 的设计中心](/images/posts/agent-comparison-05-unique-features/agent-comparison-05-unique-features-handdrawn.png)

## Claude Code：把“记住什么”变成产品级的多层系统

在这三个源码窗口里，Claude Code 最有辨识度的不是“有 memory”这三个字，而是它把 private/team scope、类型化提示词、索引入口、同步、秘密扫描和后台 consolidation 串成了一套产品层。

### `teamMemPrompts.ts`：记忆不是一张 MEMORY.md

`restored-src/src/memdir/teamMemPrompts.ts` 的 `buildCombinedMemoryPrompt()` 直接把记忆系统写成了 prompt 契约。它同时描述 private directory 和 shared team directory，并把记忆分成 user、feedback、project、reference 四类；每种类型还有 scope guidance。

更有意思的是“如何保存”的两步约束：

1. 每条记忆写入独立文件，带 name、description、type 等 frontmatter。
2. 如果没有 `skipIndex`，还要在对应目录的 entrypoint index 中追加指针；每条指针控制在约 150 字符以内，entrypoint 本身不放完整记忆内容。

`skipIndex = false` 是默认路径，prompt 会要求“写文件 + 更新入口索引”；`skipIndex = true` 时只写记忆文件。这不是文案细节，而是一个很有工程味的读写分离：**正文适合长期存储，短入口适合每轮加载和检索。**

同一份 prompt 还写出了安全和协作边界：team memory 禁止保存 API key/credential；用户明确要求 recall 时必须访问 memory；用户说 ignore memory 时，Agent 要把记忆视为空；plan/task 用于当前工作，不要拿 memory 代替当前任务状态。

这个设计在本次 Codex 和 Pi 快照中没有看到同等的“scope + closed taxonomy + file pointer + prompt contract”组合，因此可以作为 Claude 这一窗口内的产品层特色。但它不是说其他 Agent 不能通过扩展实现类似系统，而是说它在这里已经作为内核周边的明确契约存在。

### AutoDream：后台整理有门、锁和回滚

`restored-src/src/services/autoDream/autoDream.ts` 的 `initAutoDream()` 不是简单地“后台跑一次总结”。它依次检查 feature gate、上次 consolidation 时间、扫描节流、最近被触碰的 session 数量和 consolidation lock；当前 session 会被排除，拿不到 lock 就不启动。

真正执行时，它创建后台 task 和 `AbortController`，用 `runForkedAgent()` 读取多个会话，`querySource: 'auto_dream'`、`forkLabel: 'auto_dream'`、`skipTranscript: true`，并通过 `createAutoMemCanUseTool()` 限制 Bash 只能使用只读命令。完成后，主 transcript 可以收到“Improved”类系统摘要；失败时会记录失败、标记任务并回滚 lock 时间。

这里可以看到一个值得借鉴的边界：后台 Agent 不是主 Agent 的一个普通 tool call。它有自己的触发门槛、任务状态、取消信号、权限约束、跳过 transcript 的策略和失败回滚。`isAutoDreamEnabled()` 还说明用户 setting `autoDreamEnabled` 未定义时会回退到 GrowthBook 的 `tengu_onyx_plover`，所以“源码有 AutoDream”不等于“每次运行都会 AutoDream”。

### 团队同步：冲突解决和秘密扫描也在能力边界里

`restored-src/src/services/teamMemorySync/index.ts` 的 `pushTeamMemory()` 先要求 OAuth 和 git remote，再读取本地 entries；发现 secret 时只跳过对应文件，不记录 secret value。上传使用 hash delta，遇到 412 会重新拉取 server checksums，再缩小下一次 delta；批量上传部分成功时，已提交的 batch 不会在 retry 中盲目重复上传。

这说明 Claude 的 team memory 不是“共享目录换个名字”。它有权限、隐私、冲突、ETag/checksum、批次和回滚语义。`utils/mailbox.ts` 的 `Mailbox.send()` 还展示了本地协作的另一种最小原语：有匹配 waiter 就直接唤醒，否则入队并 `notify()`。记忆同步和 Agent mailbox 一个偏持久化协作，一个偏运行时投递，但都把“谁什么时候消费”从模型上下文里抽了出来。

## Codex：Thread/Turn/Item 加原生 sandbox，宿主与安全成为一等公民

Codex 的特色不是单个 `run_turn()`，而是把长期会话控制面和执行安全组合得很完整。

### App Server 不是 CLI 的另一个输出格式

`codex-rs/app-server/README.md` 把 Thread、Turn、Item 写成三种顶层原语，并为它们定义生命周期：Thread 可 start/resume/fork，Turn 由用户输入启动，Item 可以是消息、命令、文件编辑、审批或其他中间产物。

`initialize` 之后，宿主可以用 `thread/start`、`thread/resume`、`thread/fork` 选择会话路径，用 `turn/start` 发起工作，再消费 `item/started`、delta、`item/completed` 和 `turn/completed`。服务端还可以反向发 approval request，让 turn 等待客户端回复。这种“中间副作用是协议对象”的设计，在本次 Claude 和 Pi 源码窗口中没有看到同等的统一 JSON-RPC 控制面。

更特别的是它有 bounded queues 和明确的 `-32001` retryable overload error。宿主可以把背压和重试当成协议语义，而不是猜某个 stdout 是否卡住。

### PermissionProfile 到 OS sandbox 的组合

Codex 的 permission profile 从配置层进入 execpolicy、sandbox manager 和平台实现。Linux 使用 Landlock/bubblewrap 等路径，Windows 使用 restricted token/private desktop 等不同实现；这些模块通过 workspace roots、read/write overrides、network proxy 选项把高层 profile 落到进程边界。

因此 Codex 的 bounded uniqueness 应该写成组合判断：**在本次快照中，Thread/Turn/Item 宿主协议、审批生命周期、bounded queue 和 native sandbox 是同一套源码里的联动设计。** 不能把它缩写成“Codex 有沙箱”，那会漏掉真正可迁移的架构经验。

### 多 Agent/Guardian 只在有证据时扩大结论

固定快照里还能看到 `codex-rs/core/src/session/multi_agents.rs` 和 `core/src/guardian/`，但这类能力的具体启用方式与协议曝光程度要看调用链、配置和 feature flags。本文只把它作为“可继续阅读的附加边界”，不把目录存在直接写成“默认多 Agent”或“每个 turn 都经过 Guardian”。

## Pi：TypeScript Extension Runtime 是第一等可塑性

Pi 的最有辨识度部分，是扩展不是外围脚本，而是能够进入运行时、改变工具和 UI 的 TypeScript 模块。

### 从模块加载到运行时注册

`packages/coding-agent/src/core/extensions/loader.ts` 的 `loadExtension()` 接收 `extensionPath`、`cwd`、`eventBus`、`runtime` 和可选 `cacheToken`。它解析路径、加载模块、创建 extension、创建 API，然后执行 factory；模块没有合法 factory 或执行抛错，会返回包含 error 的结果。

在 API 中，`registerTool(tool)` 会先 `runtime.assertActive()`，再把工具放进 extension 的 map，最后调用 `runtime.refreshTools()`。这个三步很有信息量：扩展工具有生命周期，注册不是静态启动时拼接；运行时还能刷新模型可见工具集合。

官方 extensions 文档还列出可以注册 custom tools、commands、shortcuts、event handlers、UI components、providers 和 renderers，也可以替换内置工具或定制 compaction。`/reload` 会重新加载 extensions、skills、prompts、themes 和 context files。它让 Pi 成为一个“可以逐步长成自己工作流”的 Agent runtime。

### 极简不是缺功能，而是把责任外置

Pi 的 README 明确说不内置 sub-agents、plan mode、permission popups、background bash 等功能；文档也明确没有 built-in sandbox。它把这些能力交给 extensions、packages、tmux、容器或用户自己实现。

这带来两面性：

- 对想快速定制的人，核心非常薄，扩展能把确认弹窗、子 Agent、sandbox execution 和自定义 compaction 接进来。
- 对安全要求高的无人值守任务，不能把 trust 或 extension hook 当 OS 隔离；扩展和内置工具仍以 Pi 进程权限运行，应该把整个 Pi 放入容器/VM/策略 sandbox。

因此 Pi 的特色不是“默认能力最多”，而是**让缺失的能力成为可组合的 TypeScript 接口**。在本次 Claude 2.1.88 和 Codex 快照中，没有看到同等形式的 in-process TypeScript extension runtime 能够同时注册工具、命令、provider、renderer 并覆盖内置工具。

## 三个中心放在一张表里

| 源码窗口 | 本文 bounded feature | 它解决的问题 | 代价/边界 |
|:--|:--|:--|:--|
| Claude Code 2.1.88 | private/team memory、类型化记忆 prompt、同步、AutoDream、mailbox | 让 Agent 在跨会话和多人协作中积累可检索知识 | feature gate、OAuth、服务端、秘密扫描和后台任务让行为依赖运行时 |
| Codex 固定快照 | Thread/Turn/Item app-server + bounded queue + native sandbox/profile | 让 IDE/宿主稳定观察和控制长期工作，同时落到 OS 执行边界 | 协议/平台/实验 API 多，宿主必须处理版本、能力和背压 |
| Pi 固定快照 | TypeScript extension runtime + 极简 core | 让用户在不 fork 内核的情况下重组工具、UI、provider 和工作流 | 扩展拥有进程权限；缺失的安全/计划/子 Agent 能力需外部补齐 |

没有一个“总冠军”。如果你要做跨 session 的团队知识层，Claude 的 memdir prompt 契约很值得研究；如果你要做 IDE-first 的长期运行时，Codex 的 Thread/Turn/Item 和背压值得借鉴；如果你要在 TypeScript 项目里不断改造 Agent，Pi 的 extension runtime 更像一套可移植的拼装接口。

## 最后一个源码阅读清单

当你以后再比较一个 Agent 时，可以问六个问题：

1. 它的主循环由谁拥有？
2. 历史和 prompt 视图是否分开？
3. 工具授权和 OS 隔离是否分层？
4. 宿主看到的是最终文本，还是完整的中间 Item/event 生命周期？
5. 扩展能否改变工具、上下文、UI 和 provider？
6. 记忆、协作和后台任务有没有自己的锁、取消、失败和隐私边界？

如果某个结论只能从 README 的一句宣传语得到，就把它标成待运行验证；如果只在一个目录看到了名字，就不要把它写成默认行为；如果另外两套没有相同文件，也只说“本次源码窗口未见同等接口”。这三条限制，比一张“功能对比表”更能保护源码解读的可信度。

## 本篇新增机制

本专题从地图、主循环、上下文、工具安全走到这里，最后增加的是**按责任边界选型**：Claude 偏产品化的记忆与协作层，Codex 偏宿主协议与原生执行边界，Pi 偏 TypeScript 可塑性与极简组合。它们不是互相替代的功能清单，而是三种不同的 Agent 工程重心。

## 参考资料

- [Claude：Using Claude Code: session management and 1M context](https://claude.com/blog/using-claude-code-session-management-and-1m-context)
- [OpenAI：Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi coding-agent README](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- [Pi extensions documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi security documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/security.md)
