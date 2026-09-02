# Vanna Agent 文章证据边界契约

## 核心贡献

本文以 Vanna v2.0.0rc1 为边界，拆解 Agent、UserResolver、ToolRegistry、ToolContext、AgentMemory、ConversationStore、FastAPI/Web UI 和审计/生命周期扩展，并与无 Vanna 的 SQL Agent、LangChain、LlamaIndex 和 Wren AI 区分“领域运行时”与“SQL 生成/语义层”。

## 贡献层级

- 主贡献：说明 Vanna 2.0 从 vn.ask() 迁移到有用户、有权限、有工具循环的 Agent。
- 辅助视角：把 ACL、RLS 接入点、memory、conversation、streaming、UI 和部署默认值放入同一张矩阵。
- 有限迁移收益：帮助团队判断何时采用 Vanna，何时用窄 SQL tool，何时优先做语义层。

## 主张上限

只能声称 v2.0.0rc1 官方源码、文档和发布记录明确存在的组件与默认值。可以说 Vanna 把应用胶水组件化；不能说它自动保证 SQL 正确、RLS 生效、CORS 安全、会话持久化或生产可用。版本成熟度必须明确写为预发布且仓库已归档。

## 必须保留的限定

- 版本与日期：v2.0.0rc1，资料检索截至 2026-09-02。
- 来源状态：官方源码/docs/release 控制事实；十篇非官方资料只提供实践和替代方案视角。
- 版本信号：pyproject.toml 与 src/vanna/__init__.py 的版本字段不一致。
- 权限边界：access_groups 和 transform_args 是工具层检查/接入点，不等于数据库 RLS。
- 默认边界：in-memory conversation、宽松 CORS 和示例配置不能直接上线。
- 评测边界：SQL 可执行、业务语义正确和用户有权取得结果必须分开测试。

## 修改权限

允许集中修订、前置贡献、压缩自我防御并修正“框架能力不等于安全保证”的措辞。不得删除版本警告、CORS/default store、RLS 和评测限定，不得把比较框架的官方文档扩写成性能结论。

## 未决事项

若官方文档与 v2.0.0rc1 源码对某项 memory/backend/安全能力描述不一致，应在文章中保留“可接入/需配置”的状态，不能推断默认实现。
