---
title: "Codex 如何用 History 和 Notes 接续长任务"
published: 2026-09-07
description: "从 Codex 源码看实验性上下文管理：无摘要换窗、History 字面检索、Notes 服务端存储，以及它与传统 compaction 的恢复方式和可靠性差异。"
tags: ["codex", "ai-agent", "context-engineering", "agent-memory", "source-reading"]
category: "AI / Architecture"
lang: "zh_CN"
draft: false
---

让编码 Agent 连续改几个小时的代码，迟早会遇到一个问题：早先的约束、失败记录和工具输出，已经多到装不进下一次模型请求。传统做法是生成摘要，再带着摘要继续。Codex 的实验性 Context Management 增加了一条路径：建立新上下文窗口，通过 History 回查历史，通过 Notes 读取模型先前保存的工作状态。

理解这条路径，要跟着信息走：旧窗口退出当前请求以后，哪些内容留下来了，谁负责保存，下一窗口又如何读取？

本文以 2026 年 9 月 7 日读取的 [Codex 源码快照 `02d4529`](https://github.com/openai/codex/tree/02d4529f55342dee025a5c13f612b72488dfa627) 为准。它是实验路径的客户端实现分析；涉及服务端动机的段落是架构推断。

## 一个开关连接了两边的能力

配置入口是：

```toml
[features.context_management]
experimental_mode = true
```

它是 Codex 仓库自己的 feature flag。配置之后，客户端还会检查模型的 `supports_experimental_context`、后端路由、认证方式、账号计划，以及能否启用 `TokenBudget`。条件满足后，才启用预算管理并设置 `use_history_notes_extension = true`。[激活逻辑](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/core/src/session/token_budget.rs)

这里有一处容易误读：源码允许匹配 Plus、Pro、ProLite 枚举，不等于所有这类账号都能使用。官方当时的产品说明是支持客户端上的 Plus、Pro 用户可为 Astra 启用实验，新建任务后生效；Business、Enterprise 和 API-key 登录不在首发支持范围内。配置值、客户端判断和服务端实际开放是三个不同层次。[官方实验说明](https://learn.chatgpt.com/docs/models?surface=app#experimental-context-management)

客户端负责计算预算、发出提醒、注册工具和切换窗口。History/Notes 扩展则调用 Codex Backend 的 `alpha/history/v2/*` 与 `alpha/notes/v2/*`。因此，开源仓库可以解释控制流程，却不能单独给出完整后端实现。

## 换窗时到底发生什么

`TokenBudget` 让窗口管理进入模型可操作的范围。模型可以查询剩余容量，也可以调用 `new_context` 请求新窗口；预算阈值仍然承担自动触发的职责。

`new_context` 的 handler 先设置换窗请求，并不在工具调用现场直接删除消息。后续运行流程选择 token-budget compaction 路径。这条路径保留压缩生命周期的事件和前后 hooks，但跳过模型或服务端的摘要生成，调用 `start_new_context_window`。[工具 handler](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/core/src/tools/handlers/new_context_window.rs)、[换窗路径](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/core/src/compact_token_budget.rs)

新窗口更新窗口标识，重新构建基础上下文，用它替换旧的活跃历史，再重算 token 用量。当前快照还允许在特定开关下保留一部分客户端 developer 消息。真正移出的，是旧窗口中累积的活跃会话内容；仓库文件不会因此被删除。[窗口重建实现](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/core/src/session/mod.rs#L4219)

![旧窗口的历史进入 History、工作状态写入 Notes，新窗口通过提示和按需读取恢复任务](/images/posts/codex-context-history-notes/context-transition.svg)

图中展示逻辑数据流。历史入库、Notes 写入和换窗不能仅凭这些箭头视为一个原子事务。

## History 记录过程，Notes 维护工作状态

History 提供四种只读操作：列出窗口、列出条目、读取条目、搜索内容。条目可以按 agent、窗口、消息角色和工具过滤，使用接口返回的窗口 ID、条目 ID 定位。它暴露的是经过规范化的会话历史，不应据此声称所有内部推理、附件和原始 HTTP 数据都能完整导出。[History/Notes 工具协议](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/ext/history-notes/src/tools.rs)

Notes 是模型主动维护的虚拟文本文件。它有列举、读取、搜索、追加和覆盖操作，内容取决于模型写了什么。一个用于继续调试的笔记，可以这样组织，下面是虚构示例：

```markdown
目标：修复登录恢复失败，保持公共接口兼容。
已确认：refresh token 更新后，缓存仍返回旧值。
已排除：数据库事务隔离；单线程测试同样复现。
当前修改：缓存失效逻辑已改，Windows 路径未验证。
证据入口：测试名 test_refresh_cache，错误码 AUTH_STALE。
下一步：运行相关测试，再检查调用方。
```

这份记录既有当前结论，也保留未验证事项和查证入口。若只写“登录问题基本修好了”，下一个窗口便很难区分代码已修改、测试已通过和问题已解决。

Notes 的路径类似 `/root/notes/task-state.md`。相对路径以当前 agent 的 notes 目录为基准；协议也允许通过绝对路径读写其他 agent 的笔记。因此，agent 路径承担命名和组织作用，不能直接当成互相不可访问的安全边界。

这些都是虚拟路径，普通 shell 的 `cat` 和 `rg` 不能把它们当成本机文件读取。协议规定单文件上限为 1,000,000 UTF-8 字节；成功写入后，直接读取应反映新内容，而列举和搜索采用最终一致性，可能稍后才看到更新。客户端还把追加和覆盖操作标记为不支持并行工具调用。这些约定不等于已经证明后端具有某种跨客户端事务隔离级别。

## Notes 和摘要可以写同样的字，却承担不同职责

同一段“当前任务、约束、下一步”既可以出现在 Notes，也可以出现在摘要里。区别在它什么时候生成、怎么更新，以及如何进入下一次推理。

| 维度 | 摘要式 compaction | 实验性 History/Notes 换窗 |
| --- | --- | --- |
| 旧上下文如何退出 | 生成压缩表示，替换部分或大量旧内容 | 重建窗口，不在换窗步骤生成摘要 |
| 恢复入口 | 压缩结果直接作为新上下文的一部分 | 基础上下文、短提示，再按需读取外部记录 |
| 工作状态由谁维护 | 压缩过程提取；具体策略因实现而异 | 模型在任务中主动写 Notes |
| 精确旧内容怎么找 | 取决于另外保留的历史和工具 | 通过 History 的列举、搜索、读取接口 |
| 容易失败的环节 | 摘要遗漏、误写、反复压缩后的偏移 | 笔记缺失、服务不可用、找错或没读到记录 |

现代 compaction 也不一定产出一段人类可读的总结。OpenAI 的 Responses API 可以返回加密、不透明的 compaction item，压缩后的窗口还可能保留其他条目。因此，不宜把所有传统实现都简化成“一页自然语言摘要”。[Compaction 文档](https://developers.openai.com/api/docs/guides/compaction)

摘要式方案同样可以保留原始日志并提供检索。实验模式让外部记忆承担更直接的恢复职责。反过来，Notes 也包含模型的选择和提炼，写错或漏写仍然可能发生。无摘要换窗省掉的是那一步摘要推理，不代表整个恢复过程零成本或无损。

## History 搜索接近远程 grep，RAG 是另一个层次

在当前工具定义里，History 的 `query` 被明确描述为区分大小写的字面子串。Notes 搜索也采用字面匹配，只是针对笔记行。行为上可以类比 `grep -F`，实际请求在服务端执行。

假设旧条目包含：

```text
refresh token cache was stale
```

搜索 `refresh token` 符合子串条件；搜索 `authentication cache problem` 不会因为语义接近就按这个契约命中。`Refresh Token` 的大小写也不同。

这说明对外工具没有承诺 embedding 相似度召回，不能再推导为“后端一定使用数据库 LIKE”，或者“完全没有任何向量索引”。客户端看不到这些实现。

“grep 还是 RAG”把搜索算法和使用方式混在了一起。RAG 讨论检索结果如何补充生成所需信息，向量搜索只是常见检索方法。对 Codex 更精确的表述是：模型通过带结构化过滤的字面搜索找历史，再读取所需条目。

这样的接口尤其依赖可辨认的线索。错误码、测试名、文件路径和工具名比“之前那个登录问题”更容易定位。Notes 可以保存这些入口，让下一窗口先知道去哪里找，再回到 History 查看细节。

## Notes 存在哪里，能保存多久

后端适配器会给请求补充身份上下文：

```json
{
  "context": {
    "session_id": "当前会话标识",
    "current_agent_name": "/root"
  }
}
```

随后通过认证后的 provider 向相应接口发起 POST。对于这条实现路径，Notes 的持久化依赖 Codex Backend，而非项目目录里的 Markdown 文件。[后端适配器](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/ext/history-notes/src/backend.rs)

新窗口并不把所有 Notes 重新塞回 prompt。扩展请求 `alpha/notes/v2/thread_hint`，接收一段最多 **4,000 字节**的提示，放入窗口上下文；进一步恢复依赖模型按需读取。请求失败、缺少文本或文本超限时，这段实现返回空的上下文贡献。[thread hint 实现](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/ext/history-notes/src/extension.rs)

本地 `~/.codex/sessions/` 下的 rollout 是另一种数据：客户端会话记录。它仍然存在，只能证明本地记录可用，不能证明远端 Notes 当前可读。笔记成功读到一次，也不能证明退出进程、过一天再恢复时一定可读。

源码和所核对的实验说明没有给出明确的 Notes TTL、退出后的保留承诺或跨新任务共享保证。物理数据库、部署区域、完整删除流程同样无法由这些客户端接口确定。加密参数标记也不足以证明端到端加密或服务商无法读取内容。把它理解为同一任务跨窗口的实验性记忆服务，符合目前能看到的契约。

## 为什么把这部分放到服务端

我对这套架构的理解是：客户端管理当前工作窗口，服务端提供可寻址的任务记录。两者通过会话和 agent 身份连接。下面讨论这种分工可能带来的收益，不代表 OpenAI 已公开确认全部设计动机。

服务端接口让客户端不必各自实现笔记数据库、历史索引和提示生成。CLI 只需组织请求并消费结果，后端可以单独演进存储与检索。统一身份也为多个运行环境访问同一任务状态提供了基础，但“具备这种架构条件”距离“任意客户端之间已经无缝共享”还有产品与权限上的工作。

另一个收益是把正在推理的信息和暂时不用的记录分开。长工具输出留在可查询的存储中，下一窗口只读需要的部分；过去的假设也不必持续占据当前请求。把窗口类比为工作集、History 类比为事件档案、Notes 类比为工作笔记，有助于理解各自职责。

这个类比有边界。操作系统能通过明确的地址访问触发缺页加载；模型缺少某条信息时，可能根本没有意识到自己需要查询。记录还在，但模型没有读到，依然会影响下一步判断。存储的完整性和恢复的有效性要分别验证。

本地文件也能实现外部记忆。选择远端意味着多了一次网络依赖，数据导出、离线使用和生命周期的透明度则取决于服务商提供什么。对这一实验，服务端化带来了统一接口，也把一部分恢复能力移到了用户不能直接检查的边界之外。

## 恢复失败时，窗口还能不能留住

公开的 [Issue #43194](https://github.com/openai/codex/issues/43194) 报告了一个具体问题：普通模型请求成功，但 History/Notes 接口返回 404；在另一次测试里，笔记保存失败之后仍然发生了窗口替换。报告者没有确定服务端 404 的根因。这是特定环境的故障报告，不能当成所有账号都会失败的结论。

客户端代码能补上一条直接证据：`new_context` handler 没有要求先拿到成功写入 Notes 的回执；thread hint 获取失败时，也不会自动提供一份传统摘要。让模型在换窗前保存状态，是行为要求，和执行器确认保存成功后才允许换窗，是不同的保证。

若要设计更可靠的恢复流程，应先明确要防住的事故：旧窗口移出后，任务的唯一恢复信息不可读。针对这个事故，可以验证关键状态已写入、能按已知路径读回，并保留独立可检查的交接文件。直接读回验证的是读取路径；由于索引最终一致，刚写完立即搜索不到并不能单独证明写入失败。

跨夜任务尤其值得保存目标、约束、已验证结果、待做事项和证据位置。用户能查看和备份的项目文件，可以承担这份交接职责。但笔记写着“已部署”，不等于部署真的完成；涉及外部副作用时，恢复后还得查询真实系统状态。

我会用一个具体问题评估这种机制：换窗以后，Agent 能否找到上一步的证据，保留尚未验证的边界，并继续正确的下一步？更长的窗口和更完整的存储都能帮忙，最终仍要在这条恢复链上检验。
