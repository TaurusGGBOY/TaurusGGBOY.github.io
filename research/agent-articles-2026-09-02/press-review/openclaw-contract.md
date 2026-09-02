# OpenClaw 文章证据边界契约

## 核心贡献

本文以 OpenClaw 2026.8.1 的 2.0 运行模型和 2026.8.2 修复线为边界，说明 Gateway 如何把渠道、节点、会话、嵌入式 Agent loop、记忆、插件、Skills、Cron 和长期投递接成一个系统，并把它映射到 Claude Code 系列的控制平面与运行时观察点。

## 贡献层级

- 主贡献：Gateway-first、session lane/writer claim 和长期运行闭环的源码/文档拆解。
- 辅助视角：子 Agent、节点、浏览器、Canvas、memory provenance、plugin capability 与 Cron 的组合风险。
- 有限迁移收益：给自托管部署者一份控制面、恢复、幂等和安全检查框架。

## 主张上限

只能声称 v2026.8.2 官方源码、官方发布说明和官方文档明确存在的能力与约束。可以说 2026.8.1 被官方称作 OpenClaw 2.0，可以说 v2026.8.2 强化恢复、安全和长期运行路径；不能把发布说明中的修复项目推成所有部署场景已经安全，也不能把技能 allowlist 当成 shell sandbox。

## 必须保留的限定

- 版本与日期：v2026.8.2，资料检索截至 2026-09-02；2.0 指官方 2026.8.1 发布线。
- 来源状态：官方 tag/docs/release notes 控制事实；十篇非官方文章只提供架构图和自托管视角。
- 长期运行边界：accepted、transcript written、reply delivered 是不同状态；event 不重放，需刷新状态。
- 安全边界：Gateway、插件、Skills、浏览器、节点和凭证共享较大的信任面；loopback/pairing/auth 是基础条件而非充分保证。
- 设计边界：memory provenance、writer claim、idempotency 和 locks 是实现护栏，不能被写成完整合规保证。

## 修改权限

允许集中修订表达顺序、合并重复风险提示、将官方支持的重量级能力前置，并缩窄超出证据的结论。不得删除故障恢复、供应链、事件 gap、网络暴露和重复副作用限定，不得把非官方评论写成官方事实。

## 未决事项

若某个跨版本功能只出现在 release note 而未在当前 tag 找到实现，文章应标为发布说明中的功能/修复，不得扩写成已验证的内部调用链。
