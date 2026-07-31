---
title: "Claude Code源码解读36：认证与云提供商如何接入"
published: 2026-07-24T16:47:23+08:00
updated: 2026-07-24T16:47:23+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-36/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 本章先建立三个概念

- **Provider routing**：运行时根据显式开关选择 Anthropic、Bedrock、Vertex 或 Foundry 客户端。

- **凭据策略**：OAuth、API key、云身份与辅助脚本各自生成不同认证材料和刷新路径。

- **模型身份**：用户别名、Anthropic 模型 ID 与云平台部署名需要分层解析，才能保持功能判断稳定。

![Provider 选择、认证材料与模型 ID 映射](/images/posts/claude-code-source-reading-36/36-provider-routing-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇留下的问题是：**在 `/config` 中修改配置后，`settings.json` 中对应的配置也会同步修改吗？**

先给结论：**有些设置会写入某个 `settings.json`，但 `/config` 不会把整份“当前生效配置”统一同步回一个 `settings.json`。** 在 `@anthropic-ai/claude-code@2.1.88` 中，`/config` 只是打开设置界面；每个控件自己的 `onChange` 决定写入全局配置文件、哪一层 settings 文件，还是只更新当前会话。

入口本身没有“保存全部配置”的逻辑：

```tsx
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <Settings onClose={onDone} context={context} defaultTab="Config" />
}
```

`Config` 组件同时读取两种数据：`getGlobalConfig()` 得到全局应用状态，`getInitialSettings()` 得到按来源合并后的 settings。因为后者已经是合并结果，界面显示的一个值并不能反推出它原来来自 user、project、local 还是 policy；真正的写入目标要看该选项绑定的函数。

### `/config` 中的控件到底写到哪里

| 控件使用的写入路径 | 2.1.88 的实际文件或状态 | 可以观察到的典型选项 | 是否会改 `settings.json` |
| --- | --- | --- | --- |
| `saveGlobalConfig(...)` | `getGlobalClaudeFile()`，通常是 `~/.claude.json` | `verbose`、自动 compact、主题、编辑器模式、通知、部分界面偏好 | 不会；这是全局应用状态文件 |
| `updateSettingsForSource('userSettings', ...)` | 通常是 `~/.claude/settings.json`；cowork 模式可能是 `cowork_settings.json` | 权限默认模式、`alwaysThinkingEnabled`、fast mode、语言、自动更新通道、提示建议 | 会，写用户层 settings |
| `updateSettingsForSource('localSettings', ...)` | 当前项目的 `.claude/settings.local.json` | spinner tips、减少动画、output style、默认视图等本机偏好 | 会写 settings 文件，但不是共享的 `.claude/settings.json` |
| `setAppState(...)` 或会话状态更新 | 当前进程的 AppState / session | 模型选择的即时状态、当轮 thinking 状态等 | 不一定；没有对应的磁盘写入调用 |

这里的“全局”容易造成误解：`~/.claude.json` 确实是跨项目的 JSON 文件，但它不是用户 settings 文件。源码中的 `saveGlobalConfig()` 通过锁写入 `getGlobalClaudeFile()`，并过滤默认值、保护认证状态；它和 `updateSettingsForSource()` 的 settings 写入链是两套 API。相反，`userSettings` 的路径由 `getSettingsFilePathForSource()` 计算，正常才是 `~/.claude/settings.json`；project 与 local 则分别落在项目目录的 `.claude/settings.json` 和 `.claude/settings.local.json`。

因此，若你在界面里切换“主题”或“自动 compact”，看到 `~/.claude.json` 变化是预期行为；若切换权限默认模式或语言，才应检查 `~/.claude/settings.json`。Config 面板在这版源码中没有直接调用 `updateSettingsForSource('projectSettings', ...)`，所以不能把它理解成会替你改写团队共享的项目 settings。

### 写入是在什么时候发生的

这些控件不是点击“保存”后统一提交。大多数 `onChange` 在用户切换选项时就调用写入函数，同时更新 AppState 让界面立即反馈。`updateSettingsForSource()` 会先读取目标文件，再按 `mergeWith` 合并：对象字段深合并，数组用新数组替换，传入 `undefined` 表示删除键；如果原文件有 JSON 语法错误，它会返回错误而拒绝覆盖，避免一次设置操作抹掉原文件。写入后还会重置 settings 缓存；local settings 的写入则异步把 `.claude/settings.local.json` 加入 gitignore。

按 Escape 也不是“什么都没发生”。Config 在打开时保存了全局、user/local settings 和 AppState 的快照；已经发生过改动时，`revertChanges()` 会把这些快照重新写回对应位置。所以取消操作可能再次触碰磁盘，但目标仍然是各自原来的文件，不是把合并后的结果写入一个总文件。

### 版本边界与实际判断方法

当前官方文档已经描述了更新版本中 `/config key=value` 的命令形式，但那是 2.1.181 之后的能力，不能倒推到本系列分析的 2.1.88。对 2.1.88，源码能确认的是 `/config` 打开 `Settings` UI，以及每个设置项分别选择上述写入路径。

实际排查时可以按这条规则走：团队共享的规则编辑项目 `.claude/settings.json` 并提交；跨项目的个人默认值编辑 `~/.claude/settings.json`；只想让本机当前项目生效就编辑 `.claude/settings.local.json`；界面主题、认证和项目历史等应用状态则检查 `~/.claude.json`。最后还要看来源优先级：某个文件即使被改了，也可能被 local、CLI flag 或 policy 层覆盖，界面显示的是合并后的有效值，而不是某个文件的原样内容。

本篇仍以 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码为边界；下文原有的模型路由与 provider 代码保持不变。这里新增的结论只涉及 `/config` 的写入分流，不把“当前值生效”误写成“所有 settings 文件都同步”。

## 先把三个容易混在一起的概念拆开

### 模型设置先经过别名与 provider 映射

用户写下的可能是 `sonnet`，也可能是 Foundry 中区分大小写的 deployment ID，还可能带 `[1m]`。它首先只是一个 `ModelSetting`。Claude Code 要结合 provider、订阅类型、默认模型表和覆盖配置，才能得到真正发送给 SDK 的字符串。

这层间接性让 `sonnet` 这样的意图可以在第一方、Bedrock、Vertex 和 Foundry 上映射到各自的 ID；模型发布时只需更新映射表，用户配置仍保持稳定。

### provider 决定请求宿主与能力边界

同一个 Claude 模型，可以通过 Anthropic 第一方 API、AWS Bedrock、Google Vertex AI 或 Azure AI Foundry 调用。模型能力可能相近，但认证、区域、模型 ID、beta 参数乃至 SDK 支持面并不完全相同。

所以源码把两件事分开处理：`getMainLoopModel()` 决定“用哪个模型”，`getAPIProvider()` 决定“通过谁发请求”。这也是阅读这一章最重要的坐标轴。

### 认证只解决“你是谁”，不解决“请求一定成功”

API key、OAuth access token、AWS 临时凭证、Google ADC 和 Azure AD token provider 都属于身份材料。凭证装进 client 后，请求仍可能因为模型不存在、区域不匹配、配额不足、组织策略拒绝、网络失败或服务过载而失败。

![Claude Code 模型路由、认证、provider 适配与降级流程](/images/posts/claude-code-source-reading-36/36-model-routing-auth-providers-handdrawn.png)

## 第一步：从四个来源选出模型设置

主循环通过 `restored-src/src/utils/model/model.ts` 统一处理会话、启动参数、环境变量与 settings：

```ts
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    specifiedModel = process.env.ANTHROPIC_MODEL || settings.model || undefined
  }

  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }
  return specifiedModel
}

export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}
```

`getUserSpecifiedModelSetting()` 接受零个参数，返回 `ModelSetting | undefined`。源码注释给出的优先级是：运行中的 `/model` 覆盖最高，其次是启动时 `--model`，再到 `ANTHROPIC_MODEL`，最后是 settings。前两者都由 `getMainLoopModelOverride()` 统一暴露，所以代码里只需一个 override 分支。

返回值需要区分三种状态：字符串进入 `parseUserSpecifiedModel()`；`null` 表示用户显式选择 Default，`undefined` 表示来源未给出有效值或被 `availableModels` allowlist 拦下，二者都会让 `getMainLoopModel()` 调用内置默认策略。allowlist 拒绝只触发本地回退，不会向 provider 验证该字符串。

默认值由订阅类型、provider 与 `[1m]` eligibility 共同计算。Max 与 Team Premium 的默认路径可选 Opus，其他外部用户默认走 Sonnet；第三方 provider 的 Sonnet 默认在这份源码中仍可能落到较旧版本。因此 UI 上的“Default”表示一项选择策略，最终模型 ID 要到映射完成后才能确定。

## 第二步：别名解析成 provider 对应的真实 ID

别名解析集中在 `parseUserSpecifiedModel()`：

```ts
if (isModelAlias(modelString)) {
  switch (modelString) {
    case 'opusplan':
      return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '')
    case 'sonnet':
      return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '')
    case 'haiku':
      return getDefaultHaikuModel() + (has1mTag ? '[1m]' : '')
    case 'opus':
      return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
    case 'best':
      return getBestModel()
    default:
  }
}

if (has1mTag) {
  return modelInputTrimmed.replace(/\[1m\]$/i, '').trim() + '[1m]'
}
return modelInputTrimmed
```

`parseUserSpecifiedModel(modelInput)` 接受 `ModelName | ModelAlias`，两者运行时都是字符串。源码能确认的别名包括 `opusplan`、`sonnet`、`haiku`、`opus`、`best`；`best` 在 2.1.88 中调用 `getBestModel()`，而该函数直接返回默认 Opus。

`[1m]` 是客户端策略标签：解析器先剥离、解析基础别名，再把标签接回。真正发 API 前，`normalizeModelStringForAPI()` 会移除 `[1m]` 或 `[2m]`，上下文能力通过 beta 与请求配置表达。对非别名的开放字符串，函数保留原始大小写，这一点对 Foundry deployment ID 很重要。源码不会替任意自定义字符串穷举合法值。

别名之所以能随 provider 变化，是因为底层模型表按 provider 取值：

```ts
function getBuiltinModelStrings(provider: APIProvider): ModelStrings {
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    out[key] = ALL_MODEL_CONFIGS[key][provider]
  }
  return out
}

export function getModelStrings(): ModelStrings {
  const ms = getModelStringsState()
  if (ms === null) {
    initModelStrings()
    return applyModelOverrides(getBuiltinModelStrings(getAPIProvider()))
  }
  return applyModelOverrides(ms)
}
```

`getBuiltinModelStrings(provider)` 的 `provider` 只有 `firstParty`、`bedrock`、`vertex`、`foundry` 四个值，返回每个 canonical model key 对应的 provider ID。`getModelStrings()` 接受零个参数；状态未初始化时先启动初始化，再返回当前 provider 的内置表，最后叠加 settings 中的 `modelOverrides`。

Bedrock 多了一步异步 inference profile 发现：能列出 profile 时，代码按 canonical substring 找第一个匹配项；查询失败、列表为空或某个模型零匹配时，回退硬编码 Bedrock ID。`modelOverrides` 随后还能把 canonical ID 改成任意非空 provider 字符串，例如 inference profile ARN。这一 fallback 发生在本地 ID 映射阶段；请求过载后的切模则发生在 API 错误处理阶段。

## 第三步：provider 按开关优先级确定，不做连通性竞赛

`restored-src/src/utils/model/providers.ts` 的选择函数非常短，也因此很容易被过度解读：

```ts
export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : 'firstParty'
}
```

`getAPIProvider()` 接受零个参数，返回封闭联合类型 `APIProvider`。三个环境变量通过 `isEnvTruthy()` 解释布尔语义：布尔 `true`，或忽略大小写与首尾空白后的字符串 `1`、`true`、`yes`、`on` 才算真；`undefined`、空字符串及其他值都算假。三个开关都不成立时回退 `firstParty`。多个开关同时为真时，优先级固定为 Bedrock、Vertex、Foundry，只创建最高优先级对应的 client。

上一章已经讲过 settings 中的 `env` 还要经过来源优先级、项目信任和宿主管理过滤。因此“配置文件里写了开关”与“`process.env` 最终包含开关”之间仍隔着安全边界。到了 `getAPIProvider()` 这里，它只读取已经生效的进程环境，不再关心变量来自 user、project、policy 还是宿主注入。

这个选择还会反向影响默认模型、thinking 支持、beta headers、价格展示和错误文案。provider 是被多个 consumer 重复读取的进程级路由状态。

## 第四步：先验证名字，再谈真实可用性

模型菜单对自定义字符串有一条轻量验证路径。`restored-src/src/utils/model/validateModel.ts` 的顺序是：空值、allowlist、已知别名、自定义预验证值、成功缓存，最后才发最小请求：

```ts
export async function validateModel(
  model: string,
): Promise<{ valid: boolean; error?: string }> {
  const normalizedModel = model.trim()
  if (!normalizedModel) {
    return { valid: false, error: 'Model name cannot be empty' }
  }
  if (!isModelAllowed(normalizedModel)) {
    return {
      valid: false,
      error: `Model '${normalizedModel}' is not in the list of available models`,
    }
  }

  const lowerModel = normalizedModel.toLowerCase()
  if ((MODEL_ALIASES as readonly string[]).includes(lowerModel)) {
    return { valid: true }
  }

  // 省略自定义预验证值与成功缓存捷径
  try {
    await sideQuery({
      model: normalizedModel,
      max_tokens: 1,
      maxRetries: 0,
      querySource: 'model_validation',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hi',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    })
    validModelCache.set(normalizedModel, true)
    return { valid: true }
  } catch (error) {
    return handleValidationError(error, normalizedModel)
  }
}
```

`validateModel(model)` 的 `model` 是开放字符串；返回 Promise，成功形态是 `{ valid: true }`，失败形态是 `{ valid: false, error?: string }`。最小 `sideQuery()` 使用 `max_tokens: 1`、`maxRetries: 0` 和 `querySource: 'model_validation'`，只验证当前 provider 是否接受这个 ID。`messages` 只含一条 `role: 'user'` 的消息；其 `content` 只含一个 `type: 'text'` 块，`text` 固定为 `'Hi'`，`cache_control.type: 'ephemeral'` 把这次探测标成临时缓存内容。

已知别名直接返回 valid，因为它们能被本地解析；这表示命中本地快捷路径。自定义 `ANTHROPIC_CUSTOM_MODEL_OPTION` 与成功缓存也会跳过网络。未命中这些捷径时，认证失败、网络失败、404 和其他 APIError 会变成不同错误文案。

第三方 provider 的 404 可能附带上一代模型建议：Opus 4.6 建议 provider 表中的 Opus 4.1，Sonnet 4.6 建议 Sonnet 4.5，Sonnet 4.5 再建议 Sonnet 4。这个函数只返回字符串建议；`mainLoopModel` 保持原值，第二次请求由调用方决定。

## 第五步：一个 client 工厂，四套认证材料

真正发请求前，`restored-src/src/services/api/client.ts` 进入 `getAnthropicClient()`：

```ts
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic> {
  // 省略 headers 与公共 client 参数构造
  await checkAndRefreshOAuthTokenIfNeeded()
  if (!isClaudeAISubscriber()) {
    await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession())
  }
  const resolvedFetch = buildFetch(fetchOverride, source)
  // provider branches follow
}
```

`apiKey` 是可选 Anthropic API key，缺失时第一方非订阅路径再读本地 key；`maxRetries` 是必填 `number`，调用方把它当重试预算，但 TypeScript 签名仍允许负数和小数；`model` 是可选开放字符串，会影响 Bedrock 小模型 region 与 Vertex model region；`fetchOverride` 可替换底层 fetch；`source` 是可选调用来源标签，其取值由运行时调用点提供。返回类型写成 `Promise<Anthropic>`，但第三方 client 通过类型转换满足公共入口，运行时只实现各自 provider 支持的能力；第一方专有的 `batching` 或 `models` 调用会超出该公共契约。

工厂先构造公共 headers、600 秒默认 timeout、代理/TLS fetch options 与 fetch wrapper。`API_TIMEOUT_MS` 存在时用 `parseInt()` 取代默认值；这段源码只展示直接解析路径，非法值会沿解析结果进入后续配置。OAuth refresh check 会对并发的默认调用去重；`retryCount` 默认 `0`、`force` 默认 `false`，只有首次且非强制调用共享 `pendingRefreshCheck`。

### Anthropic 第一方：订阅 OAuth 与非订阅凭证路径

第一方分支最后构造官方 `Anthropic` client：

```ts
const clientConfig = {
  apiKey: isClaudeAISubscriber() ? null : apiKey || getAnthropicApiKey(),
  authToken: isClaudeAISubscriber()
    ? getClaudeAIOAuthTokens()?.accessToken
    : undefined,
  ...ARGS,
}
return new Anthropic(clientConfig)
```

订阅用户把 `apiKey` 明确设为 `null`，并把可选 OAuth `accessToken` 放入 `authToken`；非订阅用户的 `authToken` 为 `undefined`，`apiKey` 优先使用函数参数，否则读取本地 `ANTHROPIC_API_KEY` 等 key source。除此以外，非订阅路径的 `configureApiKeyHeaders()` 还会优先读取 `ANTHROPIC_AUTH_TOKEN`，或调用 api-key helper，把非空 token 写成 `Authorization: Bearer ...`。

订阅路径把 `apiKey` 设为 `null`，使 SDK 跳过 API-key 认证，并把 access token 写入 `authToken`；非订阅路径让 `authToken` 保持 `undefined`，因此该字段不会进入 client 配置，认证改由 `apiKey` 或 Bearer helper 承担。OAuth 刷新失败或 key helper 无输出时，client 仍可能构造，但首个请求会暴露认证错误。

### Bedrock：Bearer、AWS 凭证或显式 skipAuth

Bedrock 分支动态加载 `AnthropicBedrock`。如果设置 `AWS_BEARER_TOKEN_BEDROCK`，代码把 `skipAuth` 设为 `true`，并写入 Bearer Authorization；否则，在 `CLAUDE_CODE_SKIP_BEDROCK_AUTH` 为假时刷新 AWS credentials，并传入 access key、secret key 与可选 session token。

区域通常来自 `getAWSRegion()`，其顺序是 `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`；只有当前 `model` 恰好等于 small-fast model 且 `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` 非空时，才使用小模型专属 region。`CLAUDE_CODE_SKIP_BEDROCK_AUTH` 同样用 `isEnvTruthy()` 解释，开启后跳过 SDK 正常签名，主要服务测试或代理场景；实际授权责任随之交给代理或测试环境。

Bedrock 还有独立 control-plane client 用于列 inference profiles。其 region 同样由 `AWS_REGION` / `AWS_DEFAULT_REGION` 解析并在缺失时回退 `us-east-1`，可以带 `ANTHROPIC_BEDROCK_BASE_URL` 与 proxy config。查询 profile 失败只让模型 ID 发现回退内置表，不会自动把 provider 改成第一方。

### Vertex：GoogleAuth 与按模型选 region

Vertex 在未开启 `CLAUDE_CODE_SKIP_VERTEX_AUTH` 时先执行 GCP credential refresh，再并行加载 `AnthropicVertex` 与 `google-auth-library`。正常路径创建带 Cloud Platform scope 的 `GoogleAuth`；只有未发现 project 环境变量和 credential file path 时，才把 `ANTHROPIC_VERTEX_PROJECT_ID` 作为 projectId fallback，避免无意义的 metadata server 等待。

skipAuth 路径会构造一个返回空 headers 的 mock `GoogleAuth`，将鉴权责任交给代理端。`region` 由 `getVertexRegionForModel(model)` 决定：已知模型前缀可以命中各自的 `VERTEX_REGION_*` 环境变量，否则读取 `CLOUD_ML_REGION`，最后回退 `us-east5`。`model` 为 `undefined` 或空字符串时直接走同一默认 region。

### Foundry：deployment ID、API key 与 Azure AD

Foundry 动态加载 `AnthropicFoundry`。如果 `ANTHROPIC_FOUNDRY_API_KEY` 存在，SDK 自行读取它，Claude Code 不创建 Azure AD provider；如果 API key 不存在且 `CLAUDE_CODE_SKIP_FOUNDRY_AUTH` 为真，代码提供一个返回空字符串的 token provider；其余情况通过 `DefaultAzureCredential` 和 `getBearerTokenProvider()` 获取 `https://cognitiveservices.azure.com/.default` scope 的 token。

这也解释了为什么解析自定义模型名时要保留大小写：Foundry 传入的可能是用户部署名，不一定符合第一方 `claude-*` ID 格式。

## 第六步：请求骨架统一，能力开关仍然看 model 与 provider

四个 client 最后进入同一个 `queryModel()`。它在 `paramsFromContext(retryContext)` 中生成公共请求骨架：

```ts
return {
  model: normalizeModelStringForAPI(options.model),
  messages: addCacheBreakpoints(
    messagesForAPI,
    enablePromptCaching,
    options.querySource,
    // 省略其余缓存编辑参数
  ),
  system,
  tools: allTools,
  tool_choice: options.toolChoice,
  ...(useBetas && { betas: betasParams }),
  max_tokens: maxOutputTokens,
  thinking,
  ...(temperature !== undefined && { temperature }),
  ...extraBodyParams,
  ...(Object.keys(outputConfig).length > 0 && { output_config: outputConfig }),
  ...(speed !== undefined && { speed }),
}
```

`paramsFromContext(retryContext)` 接收本次重试上下文。`retryContext.model` 和 `maxTokensOverride` 可以在重试时修正模型与输出上限；主 `options.model` 是原始模型配置。`messages` 经过 `addCacheBreakpoints()` 加入缓存边界，`system` 承载系统块，`tools` 则接收 `allTools` 形成当前工具 schema，`max_tokens` 使用本轮输出上限。`tool_choice` 或 `thinking` 省略时，SDK 走各自默认分支；`temperature` 只在 thinking 关闭时发送并回退为 `1`。`betas`、`output_config`、`speed` 仅在对应 gate 产生值时展开进请求。

统一骨架之上仍有 provider 能力矩阵。Bedrock 的 beta headers 会额外写入 body 的 `anthropic_beta`；第一方专用 beta 会在严格代理路径被过滤。structured output、prompt caching、fast mode、1M context、tool search 都有各自的 model/provider gate。

thinking 的判定尤其典型：

```ts
const supported3P = get3PModelCapabilityOverride(model, 'thinking')
if (supported3P !== undefined) return supported3P

// 省略内部用户模型分支
const canonical = getCanonicalName(model)
const provider = getAPIProvider()
if (provider === 'foundry' || provider === 'firstParty') {
  return !canonical.includes('claude-3-')
}
return canonical.includes('sonnet-4') || canonical.includes('opus-4')
```

`modelSupportsThinking(model)` 接受开放模型字符串，先查第三方 capability override；这个结果为 `true` 或 `false` 时直接采用，只有 `undefined` 才走静态规则。第一方与 Foundry 默认允许非 Claude 3 的 canonical model，Bedrock 与 Vertex 静态回退只允许 Sonnet 4 或 Opus 4。canonicalization 会把 provider ID 与配置 override 尽量还原成统一家族名。

adaptive thinking 又有更窄的 allowlist：已知 Opus 4.6 与 Sonnet 4.6 返回 `true`，其他已知 opus/sonnet/haiku 返回 `false`；未知字符串只在第一方与 Foundry 默认 `true`。tool reference 则采用反向规则：命中不支持 pattern 才返回 `false`，新模型默认 `true`。不同能力函数有不同 fail-open / fail-closed 策略，不能从“支持 thinking”推导“支持所有工具协议”。

在请求组装时，如果 thinking 被关闭或模型不支持，`thinking` 保持 `undefined`；支持 adaptive 的模型发送 `{ type: 'adaptive' }`；否则发送 `{ type: 'enabled', budget_tokens }`，且 budget 会被限制在 `maxOutputTokens - 1` 以内。这些差异发生在 client 调用前，不需要让 Query Core 为四个 provider 各写一套循环。

## 第七步：失败后的重试、切模与终止边界

普通瞬时错误由 `withRetry()` 按错误分类和预算重试。后台 summary、title、suggestion、classifier 等非前台 query source 遇到 529 会先直接退出，避免容量故障时放大流量；`querySource === undefined` 与源码列出的前台来源才允许继续走 529 重试。模型切换发生在更窄的分支：

```ts
if (
  is529Error(error) &&
  (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
    (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
) {
  consecutive529Errors++
  if (consecutive529Errors >= MAX_529_RETRIES) {
    if (options.fallbackModel) {
      throw new FallbackTriggeredError(
        options.model,
        options.fallbackModel,
      )
    }
  }
}
```

`options.fallbackModel` 是可选模型字符串；缺失时，连续 529 达到阈值仍沿原模型错误路径结束。原代码要求 `FALLBACK_FOR_ALL_PRIMARY_MODELS` 为 JavaScript truthy，或者当前属于“外部非订阅用户使用非自定义 Opus”的场景。这里直接使用 JavaScript truthiness，所以任何非空字符串（包括字面量 `0` 或 `false`）都会打开该分支。`MAX_529_RETRIES` 在模块中明确为 `3`，只计算这个分支里的连续 529；通用 `DEFAULT_MAX_RETRIES` 为 `10`，调用方仍可通过 `maxRetries` 覆盖。

`FallbackTriggeredError(originalModel, fallbackModel)` 本身不执行第二次请求，它把两个模型 ID 带到外层 `queryLoop()`。外层捕获后才清理失败尝试产生的 assistant/tool 中间状态、更新 `toolUseContext.options.mainLoopModel`，必要时移除与原模型绑定的 thinking signature，然后 `continue` 重跑本轮请求，并向用户产生 warning system message。

这个清理顺序很关键。若只替换 `model` 而保留失败流里未配对的 `tool_use` / `tool_result`，下一次请求会带着孤儿 ID；若把原模型签名过的 thinking block 直接交给另一个模型，也可能被服务端拒绝。

404 走模型建议路径：模型不存在或部署未开放时，错误适配器生成“使用 `/model` 或 `--model` 切换”的消息，第三方场景可能附具体建议，然后终止当前失败路径。认证错误也锁定在当前 provider；环境开关决定 AWS、Google、Azure 或 Anthropic client，修复配置后才会进入另一条分支。

最后，还要区分 fast mode fallback 与 model fallback。API 拒绝 fast 参数时，重试上下文会关闭 fast mode 并复用同一模型；model fallback 才替换模型 ID。两者分别修改请求速度模式和模型路由。

## 用一张决策表收束调用链

| 阶段 | 决定什么 | 关键特殊值或回退 |
|---|---|---|
| `getUserSpecifiedModelSetting()` | 选模型设置来源 | 字符串为显式值；`null` / `undefined` 走默认；allowlist 拒绝也回默认 |
| `parseUserSpecifiedModel()` | 别名与 `[1m]` 解析 | 五类已知别名；自定义字符串保留大小写 |
| `getModelStrings()` | canonical key 映射 provider ID | Bedrock profile 失败回内置 ID；settings override 最后覆盖 |
| `getAPIProvider()` | 选请求宿主 | Bedrock > Vertex > Foundry > firstParty；不做网络探测 |
| `getAnthropicClient()` | 注入认证、region、代理与 fetch | API key/OAuth、AWS、Google、Azure 四套材料；skipAuth 不代表授权成功 |
| `paramsFromContext()` | 组装统一请求 | capability gate 决定 thinking、beta、tool-related 能力是否发送 |
| `withRetry()` / `queryLoop()` | 重试或切模 | 满足条件的连续 529 + 非空 `fallbackModel` 才自动切模；404 只建议 |

这张表也给出排障顺序：先看模型设置是否被 allowlist 接受，再看别名映射到哪个 provider ID，然后确认 provider 环境开关、相应凭证与 region，最后才讨论服务端能力和 fallback。只盯着 `/model` 显示名称，很容易把四层问题压成一个“模型不可用”。

## 小结

Claude Code 的模型调用由两条独立选择链在 client 工厂汇合：一条把会话、CLI、环境与 settings 解析为 provider-specific model ID；另一条按固定环境优先级选定 Anthropic、Bedrock、Vertex 或 Foundry，并装配各自凭证、区域、代理与 SDK。

汇合之后，Query Core 继续使用同一套 `messages`、`tools`、`thinking` 与流式处理逻辑，但 capability gate 会按 model/provider 裁掉不支持的参数。认证成功不代表模型存在，别名有效不代表部署可用，provider 选中也不代表会自动跨云容灾。

失败边界同样明确：普通瞬时错误按预算重试；符合条件的连续 529 且存在 `fallbackModel` 才向外层发出切模信号；404 与认证失败只返回错误或建议。读清这条边界，才能区分“本地路由决定”“远端能力事实”和“运行时故障恢复”。

## 留给下一篇的问题

为什么 Claude Code 要区分不同的 provider？

## 参考资料

- [Claude Code Model Configuration](https://code.claude.com/docs/en/model-config)

- [Claude Code Organization Setup](https://code.claude.com/docs/en/admin-setup)

- [Claude Code settings](https://code.claude.com/docs/en/configuration)

- [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory)

- [The Definitive Guide to Every Claude Code Configuration File](https://wittmannf.github.io/blog/claude-code-config-guide/)

- [Claude Code settings.json: the configuration guide](https://scalably.io/blog/claude-code-settings-json)
