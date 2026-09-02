# 三篇文章回归检查

检查日期：2026-09-02。

## 主张变化

- Pi 的主张从“Pi 有 Harness”收窄为“v0.84.4 有公共 Harness 契约，但操作路径仍未实现；当前二次开发入口是 Agent/AgentSession”。
- OpenClaw 的主张保持在 v2026.8.2 官方源码、2.0 release notes 和 docs；自托管风险段删除了对宣传材料的比较性修辞，并把插件风险限定为同一 Gateway 共享状态/凭证时的工程推断。
- Vanna 的主张从“不是更大的 ask”改为“改变抽象层”，保留预发布、归档、版本字段不一致、RLS/CORS/store 和评测边界。

未发现修订把“可能、可接入、需配置、官方发布说明中的能力”提高为“默认启用、已安全、已实现或普遍有效”。

## 证据状态

- 直接观察：Pi v0.84.4 tag 的 Agent loop、tool execution 和 AgentHarness unavailable paths；Vanna v2.0.0rc1 的 Agent、Registry、FastAPI 和 config；OpenClaw v2026.8.2 的 Gateway/embedded-runner/memory/cron/plugin 路径。
- 官方报告：OpenClaw 2026.8.1 的 2.0 变化与 2026.8.2 的 release fixes；Vanna migration、quickstart 和 data-security 文档；Pi latest/extension/package 文档。
- 非官方观点：每个主题的十篇本地归档文章，仅用于选择比较维度和部署视角。
- 本文推断：适用场景、部署建议、重复副作用风险和相邻框架的定位；这些段落使用“适合、需要、不能等同于”等条件词，并没有伪装成 benchmark 结果。

## 范围与来源回归

- 时间范围在三篇文章的版本段落中各自明确为 2026-09-02。
- Pi 的未实现 Harness 结论旁保留了版本化源码链接；session tree、memory、extension trust 和 sandbox 没有被合并为同一概念。
- OpenClaw 的 accepted/run completion、writer claim、event gap、pairing、skill allowlist 与 shell boundary 仍分别出现。
- Vanna 的 access_groups/transform_args 与真正数据库 RLS、stream transport 与幂等、memory 与权限、in-memory store 与生产持久化仍分别出现。
- 三篇文章都没有在正文重新插入封面图片；image frontmatter 为空。

## 引用角色

官方源码链接承担实现细节；官方 docs/release 链接承担产品行为、配置和版本说明；LangChain、LlamaIndex、Wren AI 只承担相邻方案的官方定位；十篇非官方文章在正文末尾以阅读池列出，并标明不替代官方版本证据。

## 写作声音

前置主张后再给限制，删除了已识别的预防性辩护，保留了版本、权限、恢复、供应链、来源和可复现性限定。未进行基于关键词的全局删除；“不是、不代表、不能”等仍在承担必要边界时保留。
