---
title: "Claude Code源码解读16：WebSearch 到底用哪个模型"
published: 2026-07-24T16:47:03+08:00
updated: 2026-07-28T18:00:00+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-16/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：你知道 Claude Code 会用你默认的模型进行 WebSearch 吗？

答案不是简单的“是”或“不是”。在当前还原源码里，WebSearch 有一个默认分支和一个功能开关分支：`tengu_plum_vx3` 为假时，搜索流使用当前主循环的 `context.options.mainLoopModel`；为真时，搜索流切到 `getSmallFastModel()`，也就是 `ANTHROPIC_SMALL_FAST_MODEL` 指定的模型，未指定时再回退到默认 Haiku。

因此更准确的说法是：**默认情况下 WebSearch 会沿用当前主循环模型，但它不是永远绑定默认模型；运行时功能开关可以把它切到小而快的模型。** 这两个分支都不是本地离线搜索，最终都通过 `queryModelWithStreaming()` 发起独立的模型请求，并把服务端 `web_search_20250305` 工具注入这条请求。

## 本章先建立三个概念

- **能力检查**：`isEnabled()` 判断当前 provider 和主循环模型是否支持 WebSearch；它回答“能不能出现这个工具”，不回答“实际搜索用哪个模型”。

- **模型选择**：`WebSearchTool.call()` 根据 `tengu_plum_vx3` 选择 `mainLoopModel` 或 `getSmallFastModel()`；选择发生在真正调用工具时。

- **服务端工具**：Claude Code 不在本地实现搜索引擎，而是把 `web_search_20250305` 放进独立模型流的 `extraToolSchemas`，由 API 返回 `server_tool_use` 和搜索结果块。

![WebSearch 模型选择的两条执行路径](/images/posts/claude-code-source-reading-16/16-websearch-model-selection-handdrawn.png)

这张图把“是否支持”与“使用哪个模型”拆成两处。后文沿着 `WebSearchTool.isEnabled() → WebSearchTool.call()` 追踪，避免把 capability、模型回退和服务端工具混成一个概念。

本文继续以 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码为边界。下面的片段只保留证明模型分流所需的字段，不是完整源码。

## 第一个误区：isEnabled 不负责选模型

`restored-src/src/tools/WebSearchTool/WebSearchTool.ts` 的 `isEnabled()` 首先取得 provider 和 `getMainLoopModel()`：

```ts
isEnabled() {
  const provider = getAPIProvider()
  const model = getMainLoopModel()

  if (provider === 'firstParty') return true

  if (provider === 'vertex') {
    return (
      model.includes('claude-opus-4') ||
      model.includes('claude-sonnet-4') ||
      model.includes('claude-haiku-4')
    )
  }

  if (provider === 'foundry') return true
  return false
}
```

这个函数的返回值只有布尔值。`firstParty` 和 `foundry` 直接返回 `true`；`vertex` 只接受源码列出的 Claude 4 系列名称；其他 provider 返回 `false`。这里的 `model` 只用于 Vertex 的能力判断，函数没有调用 `getSmallFastModel()`，也没有读取 `tengu_plum_vx3`。

所以，工具已经出现在模型工具列表中，并不意味着搜索一定会使用 `getMainLoopModel()`；能力检查和调用时模型选择是两次独立判断。

## 真正的分流点在 WebSearchTool.call

进入 `WebSearchTool.call()` 后，源码先把用户的 `query` 包装成一条简短 user message，再生成服务端搜索 schema：

```ts
const userMessage = createUserMessage({
  content: 'Perform a web search for the query: ' + query,
})
const toolSchema = makeToolSchema(input)

const useHaiku = getFeatureValue_CACHED_MAY_BE_STALE(
  'tengu_plum_vx3',
  false,
)
```

`getFeatureValue_CACHED_MAY_BE_STALE('tengu_plum_vx3', false)` 的第二个参数明确给出静态默认值 `false`。但它是运行时功能配置，源码只能确认缺省回退，不足以推断线上某个账号最终拿到的开关值或分支比例。

接下来，搜索流通过 `queryModelWithStreaming()` 创建：

```ts
const queryStream = queryModelWithStreaming({
  messages: [userMessage],
  systemPrompt: asSystemPrompt([
    'You are an assistant for performing a web search tool use',
  ]),
  thinkingConfig: useHaiku
    ? { type: 'disabled' as const }
    : context.options.thinkingConfig,
  tools: [],
  signal: context.abortController.signal,
  options: {
    model: useHaiku ? getSmallFastModel() : context.options.mainLoopModel,
    toolChoice: useHaiku
      ? { type: 'tool', name: 'web_search' }
      : undefined,
    extraToolSchemas: [toolSchema],
    querySource: 'web_search_tool',
  },
})
```

这就是问题的证据核心：

- `useHaiku === false` 时，`model` 取 `context.options.mainLoopModel`，`thinkingConfig` 沿用主循环上下文，`toolChoice` 不强制指定。
- `useHaiku === true` 时，`model` 取 `getSmallFastModel()`，`thinkingConfig` 固定为 disabled，并强制 `toolChoice` 为 `web_search`。
- 两条路径都传 `tools: []`，普通客户端工具不会被带进这条搜索流；搜索 schema 通过 `extraToolSchemas: [toolSchema]` 单独注入。

这里的 `context.options.mainLoopModel` 是当前调用上下文传入的主循环模型，不应直接等同于“产品永远默认的某个型号”。用户选择、provider 适配和运行时配置都可能影响它；静态源码能确认的是这个字段的来源位置和分支选择。

## 默认分支：沿用当前主循环模型

当 `tengu_plum_vx3` 使用默认假值时，WebSearch 不再额外调用模型选择函数，而是直接读取 `context.options.mainLoopModel`。这意味着：

1. 用户或宿主如果切换了主循环模型，WebSearch 的默认分支也会跟着使用新的上下文模型。
2. 主循环的 thinking 配置会透传到搜索流，而不是在 WebSearch 内部硬编码另一套思考预算。
3. 搜索仍然是独立的一次模型流。它使用一条新的 user message 和短 system prompt，不是把搜索请求直接拼到主循环本次响应里。

这里的“沿用”只描述模型字段，不表示主循环和搜索共享同一段消息历史。`WebSearchTool.call()` 只把当前 query 包成 `Perform a web search...`，再额外传入 `agents`、`mcpTools`、权限上下文和其他调用选项。

## 开关分支：切到 small fast model

`getSmallFastModel()` 的实现很短：

```ts
export function getSmallFastModel(): ModelName {
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()
}
```

因此开关分支的可见取值是：

- `ANTHROPIC_SMALL_FAST_MODEL` 有值时使用该环境变量指定的模型名；这是开放字符串，源码不枚举所有候选值。
- 环境变量为空或未设置时使用 `getDefaultHaikuModel()`。

同时，WebSearch 把 thinking 关闭并强制选择 `web_search`。这不是简单地把“默认模型名”替换成 Haiku，而是同时改变了该次搜索请求的推理配置与 tool choice。至于实际延迟、质量和成本，静态源码没有提供运行时统计，不能从分支代码直接推断。

## `web_search_20250305` 到底在哪里执行

`makeToolSchema(input)` 返回的结构是：

```ts
{
  type: 'web_search_20250305',
  name: 'web_search',
  allowed_domains: input.allowed_domains,
  blocked_domains: input.blocked_domains,
  max_uses: 8,
}
```

`allowed_domains` 和 `blocked_domains` 原样来自工具输入；两个字段都是可选的开放字符串数组。`max_uses` 在源码中固定为 `8`，代表这条服务端搜索调用允许的搜索次数上限。

注意 `WebSearchTool.call()` 本身没有 `fetch`、爬虫或搜索引擎客户端实现。它消费 `queryModelWithStreaming()` 产生的事件：

- `server_tool_use` 开始时记录工具调用 ID；
- `input_json_delta` 中逐步解析 query，用于进度事件；
- `web_search_tool_result` 到达时记录结果数量与实际 query；
- 最终由 `makeOutputFromSearchResponse()` 把文本块、标题和 URL 整理成工具输出。

所以模型选择发生在“请求 WebSearch 服务端工具的那条 API 流”上，而不是本地另起一个搜索模型进程。`tool_result` 回到主循环后，主模型才继续生成后续回答。

## 三个名字不要混淆

| 名字 | 出现位置 | 作用 |
|---|---|---|
| `getMainLoopModel()` | `isEnabled()` 与其他主循环初始化路径 | 获取当前主循环模型，用于能力判断或主循环配置 |
| `context.options.mainLoopModel` | `WebSearchTool.call()` | WebSearch 默认分支实际使用的模型字段 |
| `getSmallFastModel()` | `WebSearchTool.call()` 的 `useHaiku` 分支 | 使用环境变量或默认 Haiku 的搜索模型 |

把第一行看到的 `getMainLoopModel()` 当作 WebSearch 的最终模型，是最容易产生的误读。源码真正决定搜索请求模型的表达式只有：

```ts
useHaiku ? getSmallFastModel() : context.options.mainLoopModel
```

而 `useHaiku` 的静态默认值是 `false`，运行时是否被功能配置改写，属于外部状态。

## 最终答案：默认使用，但不是始终使用

现在可以精确回答上一篇的问题：

- **问“默认情况下是不是默认模型？”** 是。`tengu_plum_vx3` 默认回退为 `false`，WebSearch 使用当前主循环模型。
- **问“是不是永远使用默认模型？”** 不是。功能开关为真时，改用 `getSmallFastModel()`，优先读 `ANTHROPIC_SMALL_FAST_MODEL`，否则回退到默认 Haiku。
- **问“WebSearch 是否本地执行？”** 不是。两条路径都通过 `queryModelWithStreaming()` 调用 API，把服务端 web search schema 注入独立模型流。
- **问“isEnabled 返回 true 是否说明最终模型？”** 不是。它只说明 provider/model 组合具备 WebSearch 能力。

这几个答案必须同时成立，才不会把“默认回退”“运行时分流”“服务端工具”和“能力检查”混成一句模糊的“WebSearch 用默认模型”。

## 小结

Claude Code 的 WebSearch 模型选择可以压缩成一行：

`useHaiku ? getSmallFastModel() : context.options.mainLoopModel`

前半句由 `tengu_plum_vx3` 决定，默认值是 `false`；后半句沿用当前主循环模型。`getSmallFastModel()` 又有自己的回退：环境变量 `ANTHROPIC_SMALL_FAST_MODEL` 优先，否则使用默认 Haiku。

因此，读源码时要把三个边界分开：`isEnabled()` 决定工具能否启用，`call()` 决定本次搜索使用哪个模型，`extraToolSchemas` 决定 API 如何执行服务端 WebSearch。默认模型只是一个分支的回退值，不是所有情况下的硬绑定。

## 留给下一篇的问题

WebSearch 选定模型之后，为什么 WebFetch 还要再启动一次模型来提取页面内容？

## 参考资料

- `restored-src/src/tools/WebSearchTool/WebSearchTool.ts`

- `restored-src/src/utils/model/model.ts`

- `restored-src/src/utils/betas.ts`
