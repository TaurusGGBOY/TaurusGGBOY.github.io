# Vanna v2.0.0rc1 证据矩阵

本地快照：/tmp/codextmp/vanna-v2.0.0rc1，对应官方 tag v2.0.0rc1。

| 主张 | 本地证据 | 官方链接 | 状态 |
|---|---|---|---|
| 2.0 package version 与 Python version 字段不一致 | pyproject.toml:5-14; src/vanna/__init__.py:8-10 | [pyproject](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/pyproject.toml)、[init](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/__init__.py) | 直接观察 |
| Agent 构造并编排 LLM、Registry、UserResolver、Memory、ConversationStore 和 hooks | src/vanna/core/agent/agent.py:56-128 及 send_message 后续实现 | [agent.py](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/agent/agent.py) | 直接观察 |
| Agent 有 workflow、context enhancer、工具循环和自动保存 | src/vanna/core/agent/agent.py:363-646,1007-1160 | [agent.py](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/agent/agent.py) | 直接观察 |
| max_tool_iterations=10、stream、auto-save 和 thinking indicators 默认值 | src/vanna/core/agent/config.py:113-123 | [config.py](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/agent/config.py) | 直接观察 |
| Audit 默认开启，完整 AI response 默认不写入，tool params 默认 sanitize | src/vanna/core/agent/config.py:85-110 | [config.py](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/agent/config.py) | 直接观察 |
| Tool schema 按 group 过滤，execute 再查权限、校验参数并调用 transform_args | src/vanna/core/registry.py:90-142,144-230 | [registry.py](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/registry.py) | 直接观察 |
| transform_args 只是默认 no-op 的 RLS 接入点 | src/vanna/core/registry.py:113-142 | [registry.py](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/core/registry.py) | 直接观察 |
| AgentMemory 为文本/工具记忆提供抽象 | src/vanna/capabilities/agent_memory/base.py:23 及抽象方法 | [agent memory](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/capabilities/agent_memory/base.py) | 直接观察 |
| FastAPI 默认 CORS 宽松，提供 health 与聊天 routes | src/vanna/servers/fastapi/app.py:35-78; routes.py:40-174 | [app.py](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/servers/fastapi/app.py)、[routes.py](https://github.com/vanna-ai/vanna/blob/v2.0.0rc1/src/vanna/servers/fastapi/routes.py) | 直接观察 |
| SQL 生成正确性与框架运行时能力不是同一命题 | official migration/quickstart + 本文基线 | [migration](https://vanna.ai/docs/migration)、[quickstart](https://vanna.ai/docs/tutorials/quickstart-5min) | 分析推断 |
| LangChain/LlamaIndex/Wren 的比较只采用其官方定位 | official SQL agent/query pipeline/context docs | [LangChain](https://docs.langchain.com/oss/python/langchain/sql-agent)、[LlamaIndex](https://docs.llamaindex.ai/en/stable/examples/pipeline/query_pipeline_sql/)、[Wren](https://docs.getwren.ai/oss/concepts/what_is_context) | 官方对照 |

## 推断边界

本文将“Vanna 节省应用胶水”作为对组件组合的工程判断，不作为性能 benchmark。将 in-memory store、宽松 CORS、默认 no-op transform_args 视为生产化前待补边界，是根据源码默认值提出的部署建议。
