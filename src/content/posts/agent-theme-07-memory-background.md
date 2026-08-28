---
title: "Agent主题对比07｜多 Agent 是成品能力还是自建工程"
published: 2026-08-12T10:07:00+08:00
updated: 2026-08-28
description: "Claude Code 提供集成式委派入口，Codex 强调任务与审查工作流，Pi 让扩展自建编排，DeepSeek Harness 抽象异构 provider；责任差异大于数量。"
tags: ["agent-theme-comparison", "ai-agent", "multi-agent", "claude-code", "codex", "pi", "deepseek-harness"]
category: "AI / Architecture"
draft: false
image: "/images/posts/agent-theme-07-memory-background/claude-code-source-reading-00.png"
imagePosition: "left"
slug: "agent-theme-07-memory-background"
series: "agent-theme-comparison"
order: 7
difficulty: "advanced"
time: "16 min"
prerequisites:
  - "需要把研究、实现、测试或审查拆成独立任务"
  - "能为并行任务指定所有者和汇合条件"
topics:
  - "多 Agent 编排"
  - "Claude Code Subagents"
  - "Codex 工作流"
  - "Pi Extensions"
  - "DeepSeek Harness Providers"
  - "任务所有权"
status: "verified"
verified_at: "2026-08-28"
---

Claude Code 最接近“直接使用多 Agent 产品能力”；Codex 更适合把执行、审查和宿主编排成工作流；Pi 把委派本身留给 extension；DeepSeek Harness 把 spawn、fork 与远程 transport 统一到 provider 抽象。四者都能产生多个执行者，但并行、所有权、汇合与失败恢复分别由不同层负责。

## Claude Code 对 Pi：成品委派，还是自己定义委派语义

Claude Code 的 [subagent 文档](https://code.claude.com/docs/en/subagents) 让每个子代理拥有独立上下文、系统提示、工具与权限，完成后向主会话返回结果。相比 Pi，这个优势很直接：用户可以把代码搜索、测试调查或审查交给隔离上下文，不必先实现进程管理、结果格式与权限继承。

产品化入口也限定了控制权。Claude Code 替用户决定 subagent 怎样被发现、结果怎样回主会话、哪些协作形态属于后台会话或 agent team。若团队只需要减少主上下文噪声，这些默认值很合适；若需要特殊调度、公平队列、跨项目资源配额或自定义汇合算法，产品入口不会自动变成完整编排平台。

Pi 将核心保持最小，[Extensions 文档](https://pi.dev/docs/latest/extensions) 把 subagent 作为可选扩展示例，而不是固定产品语义。相比 Claude Code，Pi 可以决定子进程怎么启动、带哪些工具、返回原始事件还是摘要、失败后是否重试。委派可以非常贴合内部任务图，不必接受一个现成的“主—子”关系。

Pi 的短板是每个决定都要自己实现。取消是否传播，父任务结束时子进程是否清理，权限是否被意外继承，多个结果怎样去重，extension 升级后会不会丢失任务，都没有成品团队能力兜底。Claude Code 用户承担产品边界，Pi 用户承担分布式任务的工程细节；后者只有在委派语义确实特殊时才值得。

## Codex 对 Claude Code：工作流编排，还是内建组织入口

OpenAI 的 [Harness engineering](https://openai.com/index/harness-engineering/) 案例把实现、自审、其他 Agent 审查、修复反馈组织成循环。与 Claude Code 直接提供 subagent 和 agent team 入口相比，Codex 的鲜明点不是给组织形态命名，而是让任务、工具反馈、审查和运行态验证形成可重复工作流。

这使 Codex 适合“交付物驱动”的多 Agent：一个 Agent 产出补丁，另一个只审查特定风险，主流程根据评论和测试决定是否回到实现。Claude Code 更适合用户在产品内快速建立成员或子任务；Codex 更适合平台把不同角色接到已有 thread、review 和客户端界面。前者减少编排代码，后者更容易嵌入组织流程。

Codex 的工程案例支持“实现—审查—修复”可以在特定仓库与工具环境中形成闭环，不支持增加 reviewer 就普遍更可靠。任务队列、跨 thread 依赖、资源上限和最终仲裁仍需团队设计。Claude Code 的 agent team 也不是免费组织：持续成员越多，协调消息、重复工作和权限范围越需要监督。

两者都可能产生“审查通过”的假象。Claude Code 主 Agent 若只接收子 Agent 摘要，可能遗漏过程中的不确定性；Codex 审查循环若没有明确退出条件，可能在风格意见上来回消耗。Claude Code 需要规定子结果的证据格式，Codex 需要规定 review 的拒绝条件与最大轮次。多一个 Agent 只增加第二个判断者，不自动增加第二份事实。

## DeepSeek Harness 对 Codex：异构 provider，还是围绕交付物的执行层

DeepSeek Harness 的 [Subagent 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md) 把后端抽象为 provider，provider 可以代表进程内 spawn、继承历史的 fork 或远程 ACP transport，并在启动前声明能力。相比 Codex 围绕统一 Harness 与工作流组织角色，它更关注“不同来源的执行者怎样进入同一编排接口”。

优势是异构性。平台可以让一个 provider 继承上下文，另一个启动干净进程，第三个通过远程协议连接不同 Agent；不支持所需能力时应提前失败。Codex 更适合让同一执行层中的实现与审查协同，DeepSeek Harness 更适合研究 provider 与 transport 的组合，尤其当参与者不共享同一进程或模型适配器时。

短板是能力声明不等于语义一致。两个 provider 都声称支持 spawn，可能在取消、权限、上下文继承和结果格式上完全不同；远程 transport 还会增加认证、断线与重试问题。Codex 统一执行层减少异构差异，却较难把任意外部 Agent 当成本地角色；DeepSeek Harness 接入面更宽，也必须写更多契约测试。

项目仍处 developer preview，[README](https://github.com/deepseek-ai/deepseek-harness) 明示会有破坏兼容变化，[SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) 说明未经安全审计、不能作为不可信任务的唯一安全控制。异构 provider 当前是可研究的架构能力，不是已证明可靠的生产组织系统；远程 Agent 仍应放在独立身份与外部隔离下。

## 任务所有权与结果汇合，四者都不会替你发明答案

权限隔离会让四者出现不同误区。Claude Code subagent 可以拥有独立工具与权限，优势是按角色收窄能力，短板是主 Agent 仍可能在汇合时执行子 Agent 建议的高风险动作。Codex reviewer 可以只读审查 artifact，却要由宿主保证 reviewer 真的没有写权限。Pi 与 DeepSeek Harness 能更深自定义权限继承，也更容易因 extension 或 provider 配置把父级能力意外传下去。

上下文泄漏同样不同。Claude Code 产品负责构造 subagent 上下文，用户要检查返回摘要是否夹带敏感信息；Codex 平台要决定哪些 thread/item 可被 reviewer 读取。Pi 编排 extension 可以精确裁剪输入，却要自己处理秘密和日志；DeepSeek Harness 跨远程 transport 时还要验证数据边界。Agent 越多，敏感上下文的复制次数越多，不会因“隔离窗口”自动减少。

优先级与资源竞争也会反转并行收益。Claude Code 多个后台任务会争用用户注意力和环境；Codex 多个 thread 会争用服务、测试与 reviewer 配额；Pi 子进程可能争用本机 CPU、文件锁和端口；DeepSeek Harness 多 provider 还可能跨远程资源与速率限制。成品能力减少启动工作，自建运行时增加调度控制，但四者都需要资源上限和冲突规则。

人类介入点必须随产品边界设置。Claude Code 适合在主会话汇合时让人检查关键分歧；Codex 可在审查不通过或运行态证据不足时升级到人；Pi 编排器要显式实现暂停与可恢复状态；DeepSeek Harness 还要让不同 provider 的阻塞原因归一化。没有可理解的升级包，多 Agent 只会把更多局部日志扔给最后一个审批人。

Claude Code 可以让主 Agent 持有最终任务，但如果多个 subagents 修改相同文件，冲突处理仍要由工作流约束。Codex 可以把实现和审查放进循环，但谁有权接受风险、何时停止 review 仍是组织规则。Pi extension 可以自定义仲裁，却要自己保证并发写入不会互相覆盖；DeepSeek Harness provider 可以并存，也不自动产生跨 provider 的一致提交协议。

最稳的拆分方式在四者中也有不同成本。Claude Code 适合拆成“过程长、结论短”的研究与审查，减少主上下文压力；Codex 适合拆成有明确 artifact 的实现—验证—审查阶段；Pi 适合把固定内部任务图写进 extension；DeepSeek Harness 适合按能力选择不同 provider。若子任务无法定义独立产物，四者都会把沟通成本放大。

结果汇合时，Claude Code 主会话应要求文件、测试或引用，而不只收摘要；Codex 宿主应保存 reviewer item 与修复 turn 的关联；Pi 编排器应给每个子任务稳定 ID、超时和幂等规则；DeepSeek Harness 应记录 provider、transport、能力声明与事件来源。越靠近成品，证据格式越可以由用户规则补充；越靠近运行时，证据协议越必须由平台编码。

失败恢复也不同。Claude Code 用户可以重派某个 subagent，但对产品内部调度控制有限；Codex 平台可以按 thread 或 turn 重跑，却要防止重复副作用；Pi 可以直接修改 extension 的重试逻辑，但要自己持久化任务；DeepSeek Harness 能按 provider 故障切换，前提是不同 provider 的状态和工具副作用真的可替代。宣称“支持 failover”前，必须先证明任务可幂等重放。

成本上，Claude Code 更容易从一个子 Agent 开始，协调成本随团队形态增加；Codex 从工作流与宿主获得可观察性，也增加服务和审查轮次；Pi 初始代码少，长期要维护编排 extension；DeepSeek Harness 还要维护 provider/transport 兼容矩阵。并行节省的墙钟时间，必须扣掉重复探索、汇合冲突和人工仲裁。

## 裁决：先决定谁拥有任务，再决定开几个 Agent

| 产品 | 优势 | 短板 | 代价 | 适合谁 |
| --- | --- | --- | --- | --- |
| Claude Code | subagent、后台会话与团队入口产品化 | 深层调度、资源治理和自定义仲裁受产品边界约束 | 设计清晰任务与证据格式，监督协调开销 | 想直接委派研究、实现或审查的用户与团队 |
| Codex | 易把实现、运行态验证与 reviewer 接成交付工作流 | 不提供脱离场景的通用调度器，审查循环可能空转 | 建设 thread、任务、review 与停止规则 | 已有工程平台、强调交付物闭环的团队 |
| Pi | 委派语义可由 extension 完整自定义 | 取消、重试、权限、持久化和汇合都需自建 | 维护编排代码与并发安全 | 任务图特殊且能维护进程级编排的小团队 |
| DeepSeek Harness | spawn、fork、远程 transport 可统一为异构 provider | 预览期契约与跨 provider 语义差异大 | 维护能力协商、安全隔离和兼容矩阵 | 研究异构 Agent 与跨运行时编排的平台团队 |

只想隔离研究噪声，Claude Code 的成品 subagent 最省事；要把实现与审查嵌入现有交付平台，Codex 更合适；委派规则本身是核心资产，Pi 才值得自建；必须跨 provider 或 transport 时，DeepSeek Harness 才展现独特价值。没有任务 owner 和汇合条件时，四者都只会更快地产生冲突。

## 本篇引用来源

- [Claude Code：Create custom subagents](https://code.claude.com/docs/en/subagents)
- [OpenAI：Harness engineering](https://openai.com/index/harness-engineering/)
- [Pi Coding Agent](https://pi.dev/)
- [Pi Extensions](https://pi.dev/docs/latest/extensions)
- [DeepSeek Harness：Subagent subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)
- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
