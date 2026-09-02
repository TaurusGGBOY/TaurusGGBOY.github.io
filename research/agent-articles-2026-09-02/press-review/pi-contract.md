# Pi 文章证据边界契约

## 核心贡献

本文用 Pi v0.84.4 的版本化源码把三个容易混淆的层次分开：可运行的 Agent loop、coding-agent 的 AgentSession 宿主，以及已经导出但操作实现仍未完成的 AgentHarness。随后将这三个层次映射到 Claude Code 系列的 Agent 产品观察点，帮助读者决定接入层和部署边界。

## 贡献层级

- 主贡献：源码级架构拆解与 Agent / AgentSession / AgentHarness 的边界判断。
- 辅助视角：把扩展、Skills、Packages、会话树、compaction 和 steering 放入统一的 harness 坐标系。
- 有限迁移收益：为本地编码工具或二次开发宿主提供接入建议。

## 主张上限

只能声称 v0.84.4 的官方 tag 中存在的接口、行为和文档承诺。可以说 Agent 和 AgentSession 是当前可用产品路径，可以说 AgentHarness 的公共面正在成形；不能声称 AgentHarness 已经是可用的通用生产调度器，也不能把会话树称为长期记忆、把扩展权限称为沙箱。

## 必须保留的限定

- 版本与日期：v0.84.4，资料检索截至 2026-09-02。
- 来源状态：官方源码/文档控制事实；十篇非官方资料只提供生态和操作员视角。
- 负面证据：AgentHarness 的 restore、prompt、compact、steer、watch 等操作路径在该 tag 仍会走未实现分支。
- 安全边界：Packages/Extensions 拥有高权限；Pi 本身不是多租户沙箱或长期 Gateway。
- 概念边界：session tree、compaction、memory、provider adaptation、UI 和宿主策略不可互相替代。

## 修改权限

允许对文章进行集中修订、压缩重复辩护、前置已被源码支持的贡献，并修正事实边界。不得删除上述限定，不得添加未核验的 Pi 功能，不得修改站点配置或正文封面策略。

## 未决事项

若未来 v0.84.4 tag、npm 包或官方文档之间出现无法解释的冲突，应把冲突记录为版本问题，不能用推测补齐实现。
