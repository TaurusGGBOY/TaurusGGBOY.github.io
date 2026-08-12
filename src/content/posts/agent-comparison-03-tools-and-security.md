---
title: "Agent源码对比03｜模型能做什么，进程允许做什么"
published: 2026-08-12T10:15:00+08:00
updated: 2026-08-12
description: "把工具契约、审批、执行策略和 OS sandbox 分开，比较 Claude Code、Codex 与 Pi 的安全边界。"
tags: ["agent-source-comparison", "agent-security", "ai-agent", "codex-cli", "pi"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-comparison-03-tools-and-security/agent-comparison-cover-handdrawn.png"
imagePosition: "left"
---

# Agent源码对比03｜模型能做什么，进程允许做什么

上一篇最后留下的问题是：**如果模型在压缩后提出一个写文件或执行 shell 的工具调用，谁决定它能不能做？**

答案不是“权限系统”。在三套源码里，至少有四段链路：工具契约先说明调用长什么样；授权层决定是否需要用户或宿主参与；策略层判断命令、路径和配置是否允许；执行隔离层再决定真实进程能触碰哪些文件、网络和系统资源。

把这四段合成一个“安全开关”，就会把最危险的误解藏起来：**用户点了允许，不等于 OS sandbox 消失；工具 schema 校验通过，也不等于副作用已经安全完成。**

## 回答上一篇的问题

外部安全文档通常会把 Agent 的风险拆成工具调用、权限、隔离和部署环境几类；Pi 的安全文档甚至明确把 project trust 定义为“资源加载守门”，而不是 sandbox。把这些定义拿回源码后，可以验证一件事：上下文压缩只改变模型看到的提示，真正的执行边界仍然要重新经过工具、授权和进程策略。

因此，如果 compact 后模型又提出 `bash`，排查顺序不应是“摘要有没有说允许”，而应是：

1. 这个 tool call 是否符合工具 schema？
2. 当前权限上下文是否允许或需要询问？
3. 命令/路径策略是否允许？
4. 实际进程有没有被 sandbox 限制？
5. 工具结果和副作用是否正确回流到历史？

## 介绍本章的一些概念

- **Tool contract**：工具名、输入 schema、结果形状和能力元数据。它负责“调用是否合法”，不负责保证外部副作用安全。
- **Approval**：询问用户、宿主或策略服务是否继续。它可以是允许、拒绝、修改参数或等待。
- **Policy**：规则、permission profile、命令解析和路径判断。它通常比一次 UI 确认更稳定。
- **Sandbox**：操作系统或容器级隔离，限制进程可以读写的目录、网络和其他资源。
- **Trust**：是否加载项目提供的配置、技能、扩展或资源。它不自动等于执行隔离。
- **Escalation**：从较窄的执行边界进入更宽的边界。源码能确认某个请求路径存在，不代表当前配置一定会触发它。

函数参数里的布尔值和可选值也不能被忽略。比如 Codex sandbox helper 的 `use_legacy_landlock` 与 `allow_network_for_proxy` 是两个独立开关；Pi 扩展的 hook 可以阻断工具，但它运行在与 Pi 相同的进程权限下；Claude 的 `ToolPermissionContext` 由当前模式、规则和宿主状态共同构成，不能只看工具函数本身。

## 一张工具安全边界图

![Claude Code、Pi 与 Codex 的工具安全链](/images/posts/agent-comparison-03-tools-and-security/agent-comparison-03-tools-and-security-handdrawn.png)

图里的四层不是每套 Agent 都由同一个模块实现，但它们是比较时必须逐层问的问题。

## Claude Code：permission context 连接工具和产品策略

Claude Code 的工具执行链并不是“模型返回 JSON → 直接调用函数”。`restored-src/src/Tool.ts` 定义 `ToolPermissionContext`，`restored-src/src/hooks/toolPermission/PermissionContext.ts` 负责上下文更新路径，`queryLoop()` 再把 `canUseTool` 传给 streaming tool executor 或工具执行路径。

权限规则还会经过 `restored-src/src/utils/permissions/` 下的解析、模式切换、危险模式和 classifier 逻辑。比如 permission rule 可以是只指定工具名的 `Bash`，也可以带规则内容的 `Bash(npm install)`；开放字符串的具体匹配由解析器和后续策略决定，不应在文章里写成固定的几种命令。

Bash 和 sandbox 又是另一层。命令解析会处理重定向、管道、路径和危险模式，sandbox 决定实际执行环境。一个权限结果是 `allow`，最多说明当前 permission context 没有阻挡；它不自动说明 shell 的所有子进程、网络访问或文件写入都不受限制。

> **source**：`queryLoop()` 中的 `canUseTool` 会成为工具执行器的输入，权限决策处在模型提出调用与工具产生副作用之间。
>
> **inference**：把 `ToolPermissionContext`、Bash 解析和 sandbox 分开，才能解释为什么同一个工具名在不同 permission mode 或目录下有不同结果。
>
> **runtime**：classifier、feature flag、平台 sandbox 和服务端策略是否开启，不能仅由还原源码静态确定。

## Codex：PermissionProfile 贯穿策略、审批和 OS sandbox

Codex 的固定快照里，permission profile 不只是 UI 中的一项设置。`codex-rs/core/src/config/permissions.rs` 能看到内置 profile 的构造路径，包括 read-only、workspace-write 和 disabled 等具体分支；命名 profile 与运行时配置还可以形成更多 profile，开放配置不应被写成固定列表。

策略层和执行层通过 profile 连接。`codex-rs/execpolicy/src/policy.rs` 负责执行策略；`codex-rs/sandboxing/src/manager.rs` 负责根据 profile 选择或兼容 sandbox；Linux 路径的 `create_linux_sandbox_command_args_for_permission_profile()` 接受 command、command cwd、sandbox policy cwd、`use_legacy_landlock` 和 `allow_network_for_proxy`，把 profile 序列化后传给 sandbox runner。

这个函数签名告诉我们三件事：

1. sandbox 不只看命令字符串，还需要命令 cwd 与策略 cwd；
2. 网络代理放行是一个显式布尔开关，不是“工具联网”四个字自动推断；
3. profile 是结构化数据，不能只用一个字符串替代。

Windows 路径的 `create_windows_sandbox_command_args_for_permission_profile()` 还会处理 workspace roots、环境变量、临时桌面、读写覆盖和 deny paths。也就是说，Codex 的隔离边界具有平台实现差异；“Linux 和 Windows 一样”不是源码可确认的结论。

Approval 是另一条线。宿主可以收到 approval request，回复后 turn 才继续；但回复 allow 仍然要经过 profile/execpolicy 和 sandbox。这里的安全设计更接近“策略先定义可行域，审批在可行域内选择一次动作”。

## Pi：内置工具很小，安全边界交给外部组合

Pi 默认给模型 `read`、`write`、`edit`、`bash` 四个工具。源码在 `packages/coding-agent/src/core/tools/` 下分别实现这些能力，`packages/agent/src/agent-loop.ts` 的 `prepareToolCall()` 和 `executeToolCalls()` 负责调用前后事件与结果回流。

但 Pi 的 README 和 `packages/coding-agent/docs/security.md` 都明确写出设计边界：它没有内置 sandbox，内置工具和 TypeScript extensions 以启动 Pi 的用户权限运行；project trust 只控制是否加载项目 settings、skills、prompts、themes 和 extensions。它不是“默认安全模式”，而是“默认信任本地开发环境，真正隔离交给容器、VM、micro-VM 或策略 sandbox”。

这不是遗漏，而是架构取舍。Pi 的扩展可以自己注册 permission gate，也可以把执行转发到 SSH、容器或远端环境；但扩展本身具备完整进程权限，所以扩展的存在不能被写成安全保证。

Pi 还有一个很鲜明的参数边界：扩展 hook 可以在 `beforeToolCall`/`tool_call` 类事件中阻断或修改调用，但“是否阻断”由扩展实现；静态源码只能确认 hook 机制存在，不能确认每个项目的安全规则。

## 三套安全链放在一起

| 层 | Claude Code | Codex | Pi |
|:--|:--|:--|:--|
| 契约 | Tool schema、输入验证、工具注册 | ToolRouter、工具参数和 item | 内置工具定义、`ToolDefinition`、扩展工具 |
| 授权 | `canUseTool`、permission context、hooks | approval request、permission profile | 无内置权限弹窗；可由 extension 自建 |
| 策略 | permission rules、Bash 解析、模式 | execpolicy、profile、路径/命令策略 | trust 只管加载；策略通常由扩展/外部系统提供 |
| 隔离 | sandbox/平台执行边界 | Seatbelt、Landlock、Windows sandbox 等 | 进程本身无内置 sandbox，外接容器或 VM |
| 结果 | tool result、transcript、事件 | Item、turn lifecycle、thread history | tool result、AgentEvent、JSONL session |

这里最值得借鉴的不是“哪套更安全”，而是**安全责任有没有被拆成可审计的段**。如果一个项目只有 UI 确认，没有策略和 OS 隔离；或者只有容器，没有工具结果审计，依然会留下难排查的边界。

## 一个工具审计练习

拿一个看起来很普通的动作：“把配置文件中的端口改成 8080，然后运行测试”。逐层列出：

- 工具 schema 是否限制只能编辑一个文件？
- 用户批准的是工具调用、命令，还是一个更宽的权限 profile？
- 策略是否允许这个路径和 shell 子命令？
- sandbox 是否允许写入工作区、创建临时文件和访问网络？
- 失败时，模型收到的是拒绝、命令错误、sandbox 错误还是超时？

如果这五个问题只能回答一个，系统仍然不能称为“有完整的工具安全链”。

## 本篇新增机制

相对上下文篇，本篇加入了**模型可见性与进程能力的分离**：compact 决定模型看到什么，permission 决定调用能否继续，policy 决定规则是否允许，sandbox 决定进程实际能触碰什么。下一篇要看宿主如何观察并驱动这条链，否则审批和事件都只是内核内部状态。

## 留给下一篇的问题

如果 IDE 或脚本想在工具执行前显示审批、执行中渲染增量、执行后恢复同一个 Thread，它需要从 Agent 内核拿到什么协议？三套系统谁拥有这个控制平面？

## 参考资料

- [Claude Code Docs：Securely deploying AI agents](https://code.claude.com/docs/en/agent-sdk/hosting)
- [OpenAI：Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)
- [Pi coding-agent security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)
