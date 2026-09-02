# OpenClaw 2026.8.2 证据矩阵

本地快照：/tmp/codextmp/openclaw-v2026.8.2，对应官方 tag v2026.8.2。发布说明、文档与源码事实分开记录。

| 主张 | 本地证据 | 官方链接 | 状态 |
|---|---|---|---|
| 2026.8.2 包含后台 session、升级恢复、回复收口、Chrome relay 等重量级变化 | CHANGELOG.md:6-17 | [2026.8.2 release](https://docs.openclaw.ai/releases/2026.8.2) | 官方发布说明 |
| 2026.8.1 是官方 2.0 发布线 | release docs | [2026.8.1](https://docs.openclaw.ai/releases/2026.8.1) | 官方发布说明 |
| 一个长驻 Gateway 统一 channels、clients、nodes 和 widget surface | docs/concepts/architecture.md:8-45 | [architecture](https://docs.openclaw.ai/concepts/architecture) | 官方文档 |
| WS handshake、认证、pairing、幂等和 event gap 语义 | docs/concepts/architecture.md:55-110 | [architecture](https://docs.openclaw.ai/concepts/architecture) | 官方文档 |
| agent 先 accepted，再由 agent.wait 等 lifecycle end/error | docs/concepts/agent-loop.md:9-30 | [agent loop](https://docs.openclaw.ai/concepts/agent-loop) | 官方文档 |
| session/global lane、activeWriterRunId、expectedWriterRunId 和 state lock | docs/concepts/agent-loop.md:26-30; src/agents/embedded-agent-runner/run-orchestrator.ts:126-209 | [agent loop](https://docs.openclaw.ai/concepts/agent-loop)、[orchestrator](https://github.com/openclaw/openclaw/blob/v2026.8.2/src/agents/embedded-agent-runner/run-orchestrator.ts) | 文档 + 直接观察 |
| hooks、tool result sanitize、compaction retry 和 reply settled | docs/concepts/agent-loop.md:58-125 | [agent loop](https://docs.openclaw.ai/concepts/agent-loop) | 官方文档 |
| memory 使用 SQLite/FTS/vector、hybrid、MMR、temporal decay 和 cache | src/agents/memory-search.ts:222-345 | [memory-search.ts](https://github.com/openclaw/openclaw/blob/v2026.8.2/src/agents/memory-search.ts) | 直接观察 |
| Skills 是分层、条件过滤和 allowlist；allowlist 不是 shell authorization | official skills docs | [skills](https://docs.openclaw.ai/tools/skills) | 官方文档 |
| 子 Agent 使用独立 session/background task/announce | official subagents docs | [subagents](https://docs.openclaw.ai/tools/subagents) | 官方文档 |
| Cron 支持 at/every/cron/on-exit/stream event 和 delivery | src/cron/types.ts, src/cron/service.ts | [cron jobs](https://docs.openclaw.ai/automation/cron-jobs) | 源码 + 文档 |

## 推断边界

本文将“能力集中在一个 Gateway”推断为更大的组合信任面，将 writer claim/idempotency/event refresh 推断为可靠性护栏；它们不是“系统已安全”或“所有部署均无重复副作用”的证明。2.0 release notes 中的修复项目被标为发布说明，不被扩写成每个环境都已验证的内部行为。
