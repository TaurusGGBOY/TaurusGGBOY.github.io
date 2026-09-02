# Pi 0.84.4 证据矩阵

本地快照：/tmp/codextmp/pi-v0.84.4，对应官方 tag v0.84.4。以下行号来自 2026-09-02 归档时的快照，正文链接指向同一 tag。

| 主张 | 本地证据 | 官方链接 | 状态 |
|---|---|---|---|
| Agent 是有状态循环，拥有消息、流、工具和队列 | packages/agent/src/agent.ts:167-204,282-357,486-544 | [agent.ts](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/agent.ts) | 直接观察 |
| Agent loop 处理 steering/follow-up、工具和 turn 收口 | packages/agent/src/agent-loop.ts:153-269 | [agent-loop.ts](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/agent-loop.ts) | 直接观察 |
| context 先 transform，再 convertToLlm | packages/agent/src/agent-loop.ts:280-304 | [agent-loop.ts](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/agent-loop.ts) | 直接观察 |
| 截断工具调用不执行，改回传错误让模型重发 | packages/agent/src/agent-loop.ts:372-403 | [agent-loop.ts](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/agent-loop.ts) | 直接观察 |
| 默认并行、可被 sequential 工具切换，消息保持 source order | packages/agent/src/agent-loop.ts:409-423; types.ts:260-269 | [types.ts](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/types.ts) | 直接观察 |
| AgentHarness 的 restore、hooks/events 与操作面仍未实现 | packages/agent/src/harness/agent-harness.ts:74-82,219-235,305-356,363-448 | [agent-harness.ts](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/harness/agent-harness.ts) | 直接观察 |
| session 使用 parentId、compaction 和 branch summary | packages/coding-agent/src/core/session-manager.ts:30-91 及同文件后续实现 | [session-manager.ts](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/session-manager.ts) | 直接观察 |
| Packages/Extensions 是高信任扩展面 | Pi Packages 文档与 Extensions 文档 | [Packages](https://pi.dev/docs/latest/packages)、[Extensions](https://pi.dev/docs/latest/extensions) | 官方说明 |
| 不内置 plan mode/subagents，提供终端、RPC、SDK 运行面 | v0.84.4 README | [Pi README](https://github.com/earendil-works/pi/blob/v0.84.4/README.md) | 官方说明 |

## 推断边界

“适合本地编码、不适合现成多租户后台”是基于上述执行、扩展和 Harness 状态的部署推断，不是 Pi 官方性能或安全认证。会话树被称为导航/恢复结构，而不是长期记忆，是根据 session entry 类型和 context 构造职责作出的概念区分。
