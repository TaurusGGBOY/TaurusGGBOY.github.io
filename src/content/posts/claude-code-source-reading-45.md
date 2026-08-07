---
title: "Claude Code源码解读45：语音如何接入终端 Agent 🔬"
published: 2026-07-24T16:47:32+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-45/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

既然 Buddy 的结果由身份 seed 确定，社区是如何实现 100% 抽到最稀有的 Buddy 的？

先修正上一版的结论，如果限定为普通用户沿着官方 `/buddy` 路径，不修改身份 seed、不修改 Claude Code，那么确实做不到 100% 抽到 `legendary`。但“控制 seed 后也做不到”是不准确的。社区已经实现了可重复命中指定稀有度的工具；它利用的是确定性映射，而不是让 1% 概率在重复尝试中变成保底。

2.1.88 的可见源码里，“抽取”由用户身份派生出确定性结果；同一身份在同一套源码规则下会一直得到同一套 `bones`，每次执行 `/buddy` 都沿用这条规则。`roll(userId)` 接收一个开放字符串 `userId`，把它与固定 `SALT` 拼接后送进 `hashString()` 和 `mulberry32()`；同一个输入就会得到同一个伪随机序列。重复打开、退出或读取 Buddy，不会把 1% 慢慢累积成保底。

最稀有档是 `legendary`。`RARITY_WEIGHTS` 的总和为 100，`rollRarity()` 先取一个 `[0, 1)` 的伪随机数，再按 `RARITIES` 的顺序扣除权重，

| 稀有度 | 权重 | 对应区间 |
| --- | ---， | --- |
| `common` | 60 | `[0, 60)` |
| `uncommon` | 25 | `[60, 85)` |
| `rare` | 10 | `[85, 95)` |
| `epic` | 4 | `[95, 99)` |
| `legendary` | 1 | `[99, 100)` |

所以从“所有可能身份”的统计角度看，`legendary` 的比例是 1%。但这不是同一个账号反复抽取时的 1% 独立试验，`roll(userId)` 把 `userId + SALT` 送进 `hashString()` 和 `mulberry32()`，第一段伪随机序列就固定下来了。`companionUserId()` 又按 `oauthAccount.accountUuid → userID → 'anon'` 的顺序选择身份；`rollCache` 只是缓存同一个 key 的结果，不会改变它。

这正是 seeded PRNG 和普通“每次重新抽卡”的区别，相同种子会产生相同序列，因此结果可复现；真正能把概率变成 100% 的抽卡系统，必须另有 hard pity、计数器或显式选择逻辑。当前 `StoredCompanion` 只保存模型生成的 `name`、`personality` 与 `hatchedAt`，没有抽取次数、失败次数或 pity 状态，源码也没有“失败后重抽直到 legendary”的循环。

如果只是做本地测试，可以利用导出的 `rollWithSeed(seed)` 找一个已知会落入 `legendary` 区间的种子。这里的 `seed` 同样是开放字符串；函数直接把它送进哈希和 PRNG，不读取全局配置，

```ts
for (let i = 0; ; i++) {
  const seed = `test-${i}`
  if (rollWithSeed(seed).bones.rarity === 'legendary') {
    console.log(seed)
    break
  }
}
```

但社区的 reroll 实现走的是离线候选搜索，不调用生产路径里的 `rollWithSeed()`。它先离线暴力生成候选身份，逐个计算物种和稀有度，找到目标结果后，再让生产路径使用这个候选身份。已有公开脚本包含 `reroll.js`、`verify.js` 和配置修复脚本，可以按物种与稀有度搜索；“100%”指先找到一个确定会落入目标区间的 seed，再重复使用它，不代表每次随机试验的概率变成 100%。

生产路径是 `getCompanion() → roll(companionUserId())`，而 `companionUserId()` 的优先级是 `oauthAccount?.accountUuid ?? userID ?? 'anon'`。因此社区方案通常分成四步，先备份配置，搜索一个会得到 `legendary` 的候选 `userID`；如果配置中存在 `oauthAccount.accountUuid`，让它回退到候选 `userID`；删除 `companion` 以触发重新孵化；重启 Claude Code 后执行 `/buddy`。直接修改 `userID` 对已有 `accountUuid` 的账号不起作用，因为可选链取到非空 `accountUuid` 后就不会继续回退。删除 `accountUuid`、依赖 OAuth 令牌继续工作，是社区实现的未受官方支持的做法，重新登录也可能把真实 UUID 写回来；不应把它当作认证兼容性的保证。

还有一类更激进的社区工具不替换身份，而是修改已安装 CLI 中的 `SALT`，再搜索一个新的盐值来命中目标 Buddy。这种方法可以保留真实账号 seed，但涉及本地程序补丁、macOS 代码签名或自动更新后的重新修补，维护成本和破坏风险更高。

这条链路还受运行时和版本约束。源码中的 `hashString()` 在存在 Bun 时使用 `Bun.hash()`，否则使用 FNV-1a 风格的回退实现；搜索脚本必须与实际 CLI 走同一分支，否则离线找到的 ID 可能在目标环境中得到不同结果。本文的源码事实边界仍是 2.1.88，后续版本已经出现 Buddy 被移除的情况，所以这些社区工具不能推断为当前所有 Claude Code 版本都可用。

直接编辑配置里的 `rarity` 同样无效。`getCompanion()` 返回 `{ ...stored, ...bones }`，重新生成的 `bones` 位于后面，会覆盖配置中残留的 `rarity`、`species` 等字段。这种设计把 Buddy 做成“稳定身份”，而不是可以靠改配置或反复重开刷新的 loot box。

因此，上一版结论应当加上边界，普通 `/buddy` 没有 reroll 或 pity；但控制生产使用的身份，或修改 CLI 的盐值，就可以把一个统计上的 1% 结果变成当前版本、当前运行时下的确定性结果。

## 介绍本章的一些概念

- Voice 是一条**很薄的适配链**，终端自动重复事件推断 hold/release → 本地后端采集 16 kHz / 16-bit / mono PCM → WebSocket 把音频变成 interim/final transcript → integration 按光标锚点写回 PromptInput → 后续走普通消息与普通 Agent。
- 四层边界分别隔离不同失败，`/voice` 做显式启停与首次检查，`VoiceKeybindingHandler` 解释按键，`useVoice()` 持有录音与转写会话，`useVoiceIntegration()` 只负责把 transcript 安全写回输入框。
- 认证是硬门槛，`hasVoiceAuth()` 要求 `isAnthropicAuthEnabled()` 且存在 Claude.ai OAuth `accessToken`；API key、Bedrock、Vertex、Foundry 都沿禁用分支返回。
- 按键激活先观察快速重复（120ms 间隔内 5 次）再激活，前两个裸字符允许流进输入框保证轻点空格零延迟；中文输入法还会归一化全角空格 `U+3000`。
- 录音与 WebSocket 并行，连接未 ready 时 chunk 先进 `audioBuffer`，`onReady` 后按约 32,000 字节（约一秒 PCM）合并成 frame；协议参数固定 `linear16 / 16000 / 1`，`endpointing_ms 300`、`utterance_end_ms 1000`。
- **Interim 只预览，Final 才稳定**，`TranscriptText` 回调 `onTranscript(text, false)`，`TranscriptEndpoint` 把最近一段提升为 `true`；push-to-talk 把 final 片段空格累计、松开后统一注入，focus mode 每个 final 立即注入。
- 文本回插有 race guard，`lastSetInputRef` 记住自己最后写入的完整输入，用户已 Enter 或手动编辑过就丢弃迟到的 transcript；Voice 只写输入框，不调用 submit。
- 失败按边界分层，非致命 WebSocket 失败等 250ms 只重试一次；4xx upgrade rejection 标记 `fatal` 不重连；录音超 2 秒且结果为空时按 `wsConnected` 与 `hasAudioSignal` 区分网络失败、麦克风无信号和未检测到语音。
- 隐私边界，`getVoiceKeyterms()` 最多 50 项 keyterms（项目名、git 分支、固定开发术语），当前 `useVoice()` 主路径省略 `recentFiles`；音频是本地采集、经 WebSocket 发往 `voice_stream`，服务端留存与训练用途超出本仓库证据范围。

> 🔬 **可选实验子系统**，Voice 是受 `feature('VOICE_MODE')` 构建开关、Claude.ai OAuth 与 GrowthBook 开关控制的语音输入实验（录音 → 流式 STT → 文本回插）。不影响理解内核，可跳过。

## 本篇新增

承接 44 篇的体验层，本章看另一个输入通道，引入三个概念，

- **流式转写**，音频帧持续发送到服务端，文本假设随识别进度增量返回。
- **Partial 与 Final**，临时结果用于预览，最终结果才写入稳定 prompt 文本。
- **输入回插**，转写文本按当前光标与选区合并，使语音和键盘共享一条编辑缓冲区。

![语音帧、Partial 文本与 Final 文本的回插流程](/images/posts/claude-code-source-reading-45/45-voice-stream-detail-handdrawn.png)

先把音频会话、转写会话和输入框状态分开，后文的状态机与失败分支就有了边界。

## 问题

上一篇（44）的问题是，**既然 Buddy 的结果由身份 seed 确定，社区是如何实现 100% 抽到最稀有的 Buddy 的？**

先修正上一版的结论，如果限定为普通用户沿着官方 `/buddy` 路径，不修改身份 seed、不修改 Claude Code，那么确实做不到 100% 抽到 `legendary`。但「控制 seed 后也做不到」是不准确的。社区已经实现了可重复命中指定稀有度的工具；它利用的是确定性映射，而不是让 1% 概率在重复尝试中变成保底。

2.1.88 的可见源码里，「抽取」由用户身份派生出确定性结果；同一身份在同一套源码规则下会一直得到同一套 `bones`，每次执行 `/buddy` 都沿用这条规则。`roll(userId)` 接收一个开放字符串 `userId`，把它与固定 `SALT` 拼接后送进 `hashString()` 和 `mulberry32()`；同一个输入就会得到同一个伪随机序列。重复打开、退出或读取 Buddy，不会把 1% 慢慢累积成保底。

最稀有档是 `legendary`。`RARITY_WEIGHTS` 的总和为 100，`rollRarity()` 先取一个 `[0, 1)` 的伪随机数，再按 `RARITIES` 的顺序扣除权重，

| 稀有度 | 权重 | 对应区间 |
| --- | ---， | --- |
| `common` | 60 | `[0, 60)` |
| `uncommon` | 25 | `[60, 85)` |
| `rare` | 10 | `[85, 95)` |
| `epic` | 4 | `[95, 99)` |
| `legendary` | 1 | `[99, 100)` |

所以从「所有可能身份」的统计角度看，`legendary` 的比例是 1%。但这不是同一个账号反复抽取时的 1% 独立试验，`roll(userId)` 把 `userId + SALT` 送进 `hashString()` 和 `mulberry32()`，第一段伪随机序列就固定下来了。`companionUserId()` 又按 `oauthAccount.accountUuid → userID → 'anon'` 的顺序选择身份；`rollCache` 只是缓存同一个 key 的结果，不会改变它。

这正是 seeded PRNG 和普通「每次重新抽卡」的区别，相同种子会产生相同序列，因此结果可复现；真正能把概率变成 100% 的抽卡系统，必须另有 hard pity、计数器或显式选择逻辑。当前 `StoredCompanion` 只保存模型生成的 `name`、`personality` 与 `hatchedAt`，没有抽取次数、失败次数或 pity 状态，源码也没有「失败后重抽直到 legendary」的循环。

如果只是做本地测试，可以利用导出的 `rollWithSeed(seed)` 找一个已知会落入 `legendary` 区间的种子。这里的 `seed` 同样是开放字符串；函数直接把它送进哈希和 PRNG，不读取全局配置，

```ts
for (let i = 0; ; i++) {
  const seed = `test-${i}`
  if (rollWithSeed(seed).bones.rarity === 'legendary') {
    console.log(seed)
    break
  }
}
```

但社区的 reroll 实现走的是离线候选搜索，不调用生产路径里的 `rollWithSeed()`。它先离线暴力生成候选身份，逐个计算物种和稀有度，找到目标结果后，再让生产路径使用这个候选身份。已有公开脚本包含 `reroll.js`、`verify.js` 和配置修复脚本，可以按物种与稀有度搜索；「100%」指先找到一个确定会落入目标区间的 seed，再重复使用它，不代表每次随机试验的概率变成 100%。

生产路径是 `getCompanion() → roll(companionUserId())`，而 `companionUserId()` 的优先级是 `oauthAccount?.accountUuid ?? userID ?? 'anon'`。因此社区方案通常分成四步，先备份配置，搜索一个会得到 `legendary` 的候选 `userID`；如果配置中存在 `oauthAccount.accountUuid`，让它回退到候选 `userID`；删除 `companion` 以触发重新孵化；重启 Claude Code 后执行 `/buddy`。直接修改 `userID` 对已有 `accountUuid` 的账号不起作用，因为可选链取到非空 `accountUuid` 后就不会继续回退。删除 `accountUuid`、依赖 OAuth 令牌继续工作，是社区实现的未受官方支持的做法，重新登录也可能把真实 UUID 写回来；不应把它当作认证兼容性的保证。

还有一类更激进的社区工具不替换身份，而是修改已安装 CLI 中的 `SALT`，再搜索一个新的盐值来命中目标 Buddy。这种方法可以保留真实账号 seed，但涉及本地程序补丁、macOS 代码签名或自动更新后的重新修补，维护成本和破坏风险更高。

这条链路还受运行时和版本约束。源码中的 `hashString()` 在存在 Bun 时使用 `Bun.hash()`，否则使用 FNV-1a 风格的回退实现；搜索脚本必须与实际 CLI 走同一分支，否则离线找到的 ID 可能在目标环境中得到不同结果。本文的源码事实边界仍是 2.1.88，后续版本已经出现 Buddy 被移除的情况，所以这些社区工具不能推断为当前所有 Claude Code 版本都可用。

直接编辑配置里的 `rarity` 同样无效。`getCompanion()` 返回 `{ ...stored, ...bones }`，重新生成的 `bones` 位于后面，会覆盖配置中残留的 `rarity`、`species` 等字段。这种设计把 Buddy 做成「稳定身份」，而不是可以靠改配置或反复重开刷新的 loot box。

因此，上一版结论应当加上边界，普通 `/buddy` 没有 reroll 或 pity；但控制生产使用的身份，或修改 CLI 的盐值，就可以把一个统计上的 1% 结果变成当前版本、当前运行时下的确定性结果。

## 正文

本文全部引用 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` 还原源码。代码块只保留证明控制流所需的字段；每个代码块后标注证据位置。`restored-src/` 只用于定位证据，不表示内部仓库原始目录。

### 这张金额单位工单可以不用键盘输入

工程师正在机房值班，双手要看着另一台屏幕上的发布流水线，没法一边切窗口一边敲长 prompt。他先执行，

> /voice

按住说话：「请检查支付服务中的金额单位工单，查清结算页显示 99.90 元、回调却记录 9991 分的原因；先给出证据和计划，确认后修复并测试。」

Voice 先检查录音环境、OAuth、依赖和麦克风权限；工程师说到一半时，Interim 文本可能把「九十九点九零」显示成临时预览，他松开按键后，只有 Final 文本才插入 PromptInput。最终这句话与键盘输入走同一个 query 入口，模型并不知道它最初来自音频；源码里的差异集中在录音、STT、WebSocket 和错误边界。

### Voice 把语音收敛到普通文本输入

语音输入看起来像一个按钮，内部其实跨了四个边界，终端按键、本地麦克风、远端 STT，以及正在编辑的文本框。把它们塞进一个组件，会同时遇到按键自动重复、系统权限弹窗、WebSocket 延迟和 React 过期状态。2.1.88 的实现因此拆成四层，

1. `/voice` 负责显式启停和首次检查；
2. `VoiceKeybindingHandler` 把终端按键流解释成「按住」和「松开」；
3. `useVoice()` 持有录音与转写会话；
4. `useVoiceIntegration()` 只负责把 transcript 安全写回 PromptInput。

![Claude Code Voice 从按键、录音到普通消息输入的手绘流程图](/images/posts/claude-code-source-reading-45/45-voice-interaction-handdrawn.png)

图中最右侧故意画成普通终端输入框。`Final` 插到光标处后沿普通提交和权限流程前进。图中的 OAuth、麦克风和网络也是三类不同失败，OAuth 决定能否连接服务，系统权限决定能否取得音频，网络与 STT 决定能否得到文字。

### 五个字段把音频生命周期暴露给 UI

Voice 的共享状态只保存 UI 投影。音频 Buffer 与 WebSocket 留在 hook 和 service 内部；`VoiceProvider` 创建独立 store，UI 订阅五个展示字段，

```ts
export type VoiceState = {
  voiceState: 'idle' | 'recording' | 'processing'
  voiceError: string | null
  voiceInterimTranscript: string
  voiceAudioLevels: number[]
  voiceWarmingUp: boolean
}

const DEFAULT_STATE: VoiceState = {
  voiceState: 'idle',
  voiceError: null,
  voiceInterimTranscript: '',
  voiceAudioLevels: [],
  voiceWarmingUp: false,
}
```

> 证据，`restored-src/src/hooks/useVoice.ts` 附近的 VoiceState 类型（2.1.88 source map 还原源码）。`voiceState` 只有 `'idle'`、`'recording'`、`'processing'` 三个值，默认 `'idle'`；`voiceError` 为字符串时错误 UI 展示对应文本，为 `null` 时跳过错误提示；`voiceInterimTranscript` 保存临时预览，空字符串时跳过预览；`voiceAudioLevels` 驱动波形，空数组时渲染空波形；`voiceWarmingUp: true` 显示按住提示，默认 `false`。

`VoiceProvider({ children })` 的 `children` 是 React 节点，provider 只在首次挂载时创建 store。`useVoiceState(selector)` 接收从完整状态选出任意切片的函数，并通过 `Object.is` 判断切片是否变化；`useSetVoiceState()` 返回同步 setter，`useGetVoiceState()` 返回同步 reader。同步这一点很关键，按键处理器启动录音后，会在同一个 tick 立即读回新状态，避免继续把自动重复的空格写进输入框。

UI 对三态的翻译很克制，`recording` 显示 `listening…` 和输入光标附近的音量波形；`processing` 显示 `Voice: processing…`；`idle` 不显示 Voice indicator。`prefersReducedMotion` 为 `true` 时，processing 使用静态文本，不启动 50 毫秒动画帧。

### `/voice` 在录音前检查四层启用条件

语音模块首先经过构建开关、运行时 kill-switch、用户意愿和 OAuth 四道门。React 渲染路径用 `useVoiceEnabled()` 汇总后三项，

```ts
export function useVoiceEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.voiceEnabled === true)
  const authVersion = useAppState(s => s.authVersion)
  const authed = useMemo(hasVoiceAuth, [authVersion])
  return userIntent && authed && isVoiceGrowthBookEnabled()
}
```

> 证据，`restored-src/src/hooks/useVoiceEnabled.ts`（2.1.88 source map 还原源码）。`useVoiceEnabled()` 接受零个显式参数。`voiceEnabled` 只有严格等于 `true` 才算用户已启用，缺失、`undefined` 或 `false` 都会关闭语音；`authVersion` 变化时才重新执行较贵的 `hasVoiceAuth()`；`isVoiceGrowthBookEnabled()` 每次渲染都读取缓存的运行时开关。外层还有编译期 `feature('VOICE_MODE')`，为 `false` 时相关模块会被条件导入挡住。

这里的认证条件是 Claude.ai OAuth，`hasVoiceAuth()` 先要求 `isAnthropicAuthEnabled()`，再检查 `getClaudeAIOAuthTokens()?.accessToken`。Bedrock、Vertex、Foundry 和普通 API Key 会沿禁用分支返回。

用户第一次执行 `/voice` 打开功能时，命令不会先写配置再碰运气。它依次检查录音环境、OAuth、录音依赖和麦克风权限，全部通过才保存用户设置，

```ts
const recording = await checkRecordingAvailability()
if (!recording.available) {
  return {
    type: 'text' as const,
    value:
      recording.reason ?? 'Voice mode is not available in this environment.',
  }
}

if (!isVoiceStreamAvailable()) {
  return {
    type: 'text' as const,
    value:
      'Voice mode requires a Claude.ai account. Please run /login to sign in.',
  }
}

const deps = await checkVoiceDependencies()
if (!deps.available) {
  const hint = deps.installCommand
    ? `\nInstall audio recording tools? Run: ${deps.installCommand}`
    : '\nInstall SoX manually for audio recording.'
  return {
    type: 'text' as const,
    value: `No audio recording tool found.${hint}`,
  }
}

if (!(await requestMicrophonePermission())) {
  let guidance: string
  if (process.platform === 'win32') {
    guidance = 'Settings → Privacy → Microphone'
  } else if (process.platform === 'linux') {
    guidance = "your system's audio settings"
  } else {
    guidance = 'System Settings → Privacy & Security → Microphone'
  }
  return {
    type: 'text' as const,
    value: `Microphone access is denied. To enable it, go to ${guidance}, then run /voice again.`,
  }
}

const result = updateSettingsForSource('userSettings', { voiceEnabled: true })
```

> 证据，`restored-src/src/commands/voice/voice.ts`（2.1.88 source map 还原源码）。各失败分支都返回 `type: 'text'`，其中 `value` 是 `/voice` 命令直接展示给用户的环境、认证、依赖或权限说明。`recording.available` 决定是否继续，失败时优先显示 `recording.reason`，该值为 `null` 时回退通用文本。`isVoiceStreamAvailable()` 只检查可用 OAuth token。`deps.available` 为假时，`deps.installCommand` 有值便拼入可执行提示，为 `null` 时使用手工安装说明；`missing` 保存缺失依赖名。`requestMicrophonePermission()` 返回 `Promise<boolean>`，原生音频可用时通过短录音触发系统权限，非原生后端跳过探测并返回 `true`；拒绝时 `guidance` 按 Windows、Linux、macOS 选择设置路径。`result` 接收 `updateSettingsForSource('userSettings', { voiceEnabled: true })` 的写入结果，解析失败时命令返回错误文本，不会通知 Voice 已启用。

这段顺序也给出了隐私边界，仅仅看见 `/voice` 命令，不代表程序已经打开麦克风。音频原生模块是延迟加载的；原生后端首次启用时才通过探测触发系统权限，非原生 fallback 由后续录音进程面对系统设备权限。反过来，探测通过也不代表音频留在本机；真正录音后，PCM 会通过 WebSocket 发送给 STT 服务。源码可以确认传输路径和认证头；服务端留存时长、训练用途和治理策略需以服务端策略文档为准。

### 「按住说话」是从自动重复推断出来的

终端通过首次按键和随后连续的自动重复事件表达按住状态。Claude Code 把一段时间内未收到下一次同键事件解释为「松开」。

默认绑定是空格，但裸字符不能第一次按下就开始录音，否则普通输入空格也会触发 Voice。实现先观察快速重复，再激活，

```ts
const RAPID_KEY_GAP_MS = 120
const HOLD_THRESHOLD = 5
const WARMUP_THRESHOLD = 2

if (bareChar === null || rapidCountRef.current >= HOLD_THRESHOLD) {
  e.stopImmediatePropagation()
  if (bareChar !== null) {
    recordingFloorRef.current = stripTrailing(
      charsInInputRef.current + repeatCount,
      { char: bareChar, anchor: true },
    )
    charsInInputRef.current = 0
    voiceHandleKeyEvent()
  } else {
    stripTrailing(0, { anchor: true })
    voiceHandleKeyEvent(MODIFIER_FIRST_PRESS_FALLBACK_MS)
  }
}
```

> 证据，`restored-src/src/hooks/useVoiceIntegration.tsx`（2.1.88 source map 还原源码）。`bareChar` 是单个、无修饰符的可打印字符或 `null`；默认空格属于裸字符，`meta+k`、`ctrl+x` 这类组合键得到 `null` 并在首次按下直接激活。`rapidCountRef` 累计 120 毫秒间隔内的重复次数；裸字符达到 5 次才开始录音，第 2 次开始显示 `keep holding…`。`repeatCount` 允许终端把多个重复字符合并成一次事件。`stripTrailing(maxStrip, opts)` 的 `char` 默认空格，`anchor` 默认 `false`，`floor` 默认 0；激活时 `anchor: true` 会记录光标前缀和后缀。

前两个裸字符允许流进输入框，这保证轻点空格仍然零延迟地输入空格；确定是 hold 后，再精确移除本次 warmup 泄漏的字符。对于中文输入法，空格扫描还会把全角空格 `U+3000` 归一化后判断。源码同时承认一个边界，如果用户把 push-to-talk 绑定为裸字母，输入本来就以该字母结尾时，防御性清理可能多删一个字符，因此校验会发出警告。

按键绑定来自 `Chat` context 下的 `voice:pushToTalk`。存在 KeybindingProvider 且用户把该绑定设为 `null` 或改给其他 action 时，结果保持 `null`；provider 缺失的 headless/test 场景才使用硬编码默认空格。Modal、权限对话框或隐藏 PromptInput 时也跳过按键接管，避免把 transcript 写进已经失焦的输入框。

### 录音必须先同步进入 recording，再做异步检查

录音最容易出错的地方在第一个 `await` 之前的状态窗口，PCM 格式只是后续的编码约束。`useVoice()` 开始一次 session 时，先同步把状态改成 `recording`，再进入麦克风异步初始化，

```ts
async function startRecordingSession(): Promise<void> {
  if (!voiceModule) {
    onErrorRef.current?.('Voice module not loaded yet. Try again in a moment.')
    return
  }

  updateState('recording')
  recordingStartRef.current = Date.now()
  const myGen = ++sessionGenRef.current

  const availability = await voiceModule.checkRecordingAvailability()
  if (!availability.available) {
    onErrorRef.current?.(availability.reason ?? 'Audio recording is not available.')
    cleanup()
    updateState('idle')
    return
  }
  // 后续启动录音并连接 voice_stream
}
```

> 证据，`restored-src/src/hooks/useVoice.ts`（2.1.88 source map 还原源码），`startRecordingSession()`。接受零个参数，返回 `Promise<void>`；调用方用 `void` 启动后继续当前事件处理。`updateState('recording')` 必须发生在第一个 `await` 前，让同步 store reader 立刻看到新状态。`sessionGenRef` 是递增数字；异步回调捕获 `myGen`，一旦新 session 已开始，旧连接的回调就被视为 stale。`availability.reason` 可为字符串或 `null`，为空时回退到通用错误。

这个 generation guard 解决的是典型异步竞态，第一次 WebSocket 很慢，用户已经松开又重新按住；如果旧连接稍后才 `onReady`，它不能覆盖第二次 session 的 `connectionRef`。`attemptGenRef` 又在同一 session 内区分第一次连接与重试连接，避免第一次连接关闭时的尾随错误把第二次连接清理掉。

### 本地录音按平台选择后端

录音数据统一为 16 kHz、16 bit signed、mono PCM。`startRecording()` 优先尝试 `audio-capture-napi`，Linux 原生不可用时尝试可实际打开设备的 `arecord`，最后才尝试 SoX 的 `rec`，

```ts
export async function startRecording(
  onData: (chunk: Buffer) => void,
  onEnd: () => void,
  options?: { silenceDetection?: boolean },
): Promise<boolean> {
  const napi = await loadAudioNapi()
  const nativeAvailable =
    napi.isNativeAudioAvailable() &&
    (process.platform !== 'linux' || (await linuxHasAlsaCards()))
  const useSilenceDetection = options?.silenceDetection !== false

  if (nativeAvailable) {
    const started = napi.startNativeRecording(
      (data: Buffer) => {
        onData(data)
      },
      () => {
        if (useSilenceDetection) {
          nativeRecordingActive = false
          onEnd()
        }
      },
    )
    if (started) {
      nativeRecordingActive = true
      return true
    }
  }
  if (process.platform === 'win32') return false
  if (
    process.platform === 'linux' &&
    hasCommand('arecord') &&
    (await probeArecord()).ok
  ) {
    return startArecordRecording(onData, onEnd)
  }
  return startSoxRecording(onData, onEnd, options)
}
```

> 证据，`restored-src/src/services/voice.ts`（2.1.88 source map 还原源码），`startRecording()`。`onData` 每次接收一个 PCM `Buffer`；`onEnd` 在设备或子进程结束时调用；`options` 可省略，`silenceDetection` 也可省略。只有明确传入 `false` 才关闭静音自动停止，push-to-talk 路径正是如此；`true` 或 `undefined` 允许后端的静音检测。返回 `true` 表示某个后端已启动，`false` 表示所有候选后端均不可用。片段省略了启动前停止旧 recorder 的防御分支，但保留了后端选择与回调语义。

这里需要特别强调，`checkVoiceDependencies()` 只返回建议安装命令，安装动作交给用户或宿主执行。远程 Homespace 和设置了 `CLAUDE_CODE_REMOTE` 的环境直接报告本地音频设备不可用。Windows 只尝试原生模块；Linux 即便 PATH 里存在 `arecord`，还会用 150 毫秒探测确认它真的能打开设备，避免在 WSL 或无声卡服务器上把命令发现误判成录音可用。

每个音频 chunk 还会计算 RMS，经过平方根曲线压到 0 到 1，用最近 16 个值驱动波形。`level > 0.01` 才标记 `hasAudioSignal`。该值只驱动 UI，并区分「音频信号低于阈值」和「已有声音但尚未识别出文字」；语义识别由远端 STT 完成。

### 录音和 WebSocket 并行，先到的音频先缓冲

如果等 WebSocket 连接完成才打开麦克风，用户开头一两秒很容易丢失。实现反过来，先启动录音，连接尚未 ready 时把 chunk 放进 `audioBuffer`；`onReady` 后按约 32,000 字节，也就是约一秒 PCM，合并成较少的 WebSocket frame，再把后续 chunk 直接发送。

`connectVoiceStream()` 构造的协议参数是明确的，

```ts
const params = new URLSearchParams({
  encoding: 'linear16',
  sample_rate: '16000',
  channels: '1',
  endpointing_ms: '300',
  utterance_end_ms: '1000',
  language: options?.language ?? 'en',
})

export type VoiceStreamConnection = {
  send: (audioChunk: Buffer) => void
  finalize: () => Promise<FinalizeSource>
  close: () => void
  isConnected: () => boolean
}
```

> 证据，`restored-src/src/services/voiceStreamSTT.ts` 与 `voiceKeyterms.ts`（2.1.88 source map 还原源码）。`connectVoiceStream(callbacks, options?)` 的 `callbacks` 必须提供 `onTranscript(text, isFinal)`、`onError(error, opts?)`、`onClose()` 与 `onReady(connection)`；`opts?.fatal` 是可选布尔值，4xx upgrade rejection 会标记为 `true`，调用方据此停止重试。`options.language` 是可选字符串，缺失时回退 `'en'`；静态源码支持的本地归一化代码集合包括 `en`、`es`、`fr`、`ja`、`de`、`pt`、`it`、`ko`、`hi`、`id`、`ru`、`pl`、`tr`、`nl`、`uk`、`el`、`cs`、`da`、`sv`、`no`，集合外设置回退英文并记录原值。`options.keyterms` 是可选字符串数组；`getVoiceKeyterms(recentFiles?)` 最多返回 50 项，能组合项目名、git 分支、固定开发术语，以及调用方显式传入的最近文件名。当前 `useVoice()` 调用省略 `recentFiles`，所以这条可见主路径只组合前三类术语。整个构造过程使用本地字符串处理。

局部 `params` 是传给 WebSocket URL 的 `URLSearchParams`，其中 `encoding: 'linear16'`、`sample_rate: '16000'`、`channels: '1'` 固定为 16 kHz 单声道 PCM；`endpointing_ms: '300'` 控制端点检测窗口，`utterance_end_ms: '1000'` 控制语句结束等待，`language` 使用显式选项或 `'en'`。`VoiceStreamConnection.send(audioChunk)` 写入一个 PCM `Buffer`，`finalize` 返回结束来源，`close` 主动关闭连接，`isConnected` 读取当前连接状态；四个方法把 WebSocket 生命周期隐藏在稳定接口后。

连接通过 `Authorization: Bearer <OAuth token>` 认证，打开后立即发送 `KeepAlive`，随后每 8 秒一次。`send()` 会复制 NAPI Buffer 再发二进制帧，避免复用内存被异步 WebSocket 读到旧数据。`finalize()` 发送 `CloseStream` 后有多个结束来源，收到 endpoint、1.5 秒无数据超时、5 秒安全超时、WebSocket close，或连接已经关闭。它们分别映射到 `FinalizeSource` 的 `'post_closestream_endpoint'`、`'no_data_timeout'`、`'safety_timeout'`、`'ws_close'`、`'ws_already_closed'`。

### Interim 负责预览，Final 才成为稳定文本

服务端消息主要有 `TranscriptText`、`TranscriptEndpoint` 和 `TranscriptError`。Text 先作为 interim 回调，Endpoint 再把最近一段提升为 final，

```ts
case 'TranscriptText': {
  const transcript = msg.data
  if (transcript) {
    // 省略旧后端分段检测分支
    lastTranscriptText = transcript
    callbacks.onTranscript(transcript, false)
  }
  break
}
case 'TranscriptEndpoint': {
  const finalText = lastTranscriptText
  lastTranscriptText = ''
  if (finalText) callbacks.onTranscript(finalText, true)
  if (finalized) resolveFinalize?.('post_closestream_endpoint')
  break
}
```

> 证据，`restored-src/src/services/voiceStreamSTT.ts`（2.1.88 source map 还原源码）。`TranscriptText.data` 是开放字符串；`onTranscript` 的第二个参数 `false` 表示可被后续识别修订的临时文本，`true` 表示提交给调用层的最终片段。`TranscriptEndpoint` 作为边界事件消费 `lastTranscriptText`；连接关闭时仍有未报告 interim，close handler 也会把它提升为 final，避免丢字。完整源码还区分旧后端的分段文本和 Nova 3 的累计修订，以上片段只证明共同主路径。

`useVoice()` 对两种工作模式的 final 处理不同。push-to-talk 会把 final 片段用空格累计，用户松开后统一注入；focus mode 会在每个 final 到来时立即注入并继续录音。本文主线中的 `useVoiceIntegration()` 传入 `focusMode: false`，因此普通 REPL 走前一种模式。

### 文本按光标位置拼回 prompt

录音激活时，integration 记录光标前后的 prefix 与 suffix。interim 到来后，文本被放在两者之间；final 到来后，仍然使用同一锚点，并把光标定位到转写文本后、原 suffix 前，

```ts
const newInput =
  prefix_1 + leadingSpace_0 + text + trailingSpace_0 + suffix_1
const cursorPos_0 = prefix_1.length + leadingSpace_0.length + text.length

if (insertTextRef.current) {
  insertTextRef.current.setInputWithCursor(newInput, cursorPos_0)
} else {
  setInputValueRaw(newInput)
}
```

> 证据，`restored-src/src/hooks/useVoiceIntegration.tsx`（2.1.88 source map 还原源码）。`prefix_1`、`text`、`suffix_1` 都是开放字符串；`leadingSpace_0` 只在 prefix 非空、末尾缺少空白且 transcript 非空时为单个空格，否则为空；`trailingSpace_0` 对 suffix 做对称处理。`insertTextRef.current` 有 handle 时同时写入 `newInput` 与 `cursorPos_0`，为 `null` 时调用 `setInputValueRaw(newInput)`，文本仍会回插，只是光标由基础输入状态处理。

hook 还用 `lastSetInputRef` 记住自己最后写入的完整输入。如果 WebSocket 收尾期间用户已经按 Enter 清空输入，或手动编辑了文本，当前输入就与该 ref 不同，迟到的 transcript 会被丢弃。这个 race guard 防止已经提交的旧 prompt 被再次填回。

Voice 只写输入框，不调用 submit。用户可以看到 interim 变成 final、继续编辑、删除误识别内容，最后自己按 Enter。之后发生的一切，消息对象、QueryEngine、模型调用、工具权限，都复用前面章节已经解释过的普通路径。

### 失败处理按边界分层，不能统一成「没听清」

`idle → recording → processing → idle` 是成功主路径，失败则可能在每一层返回，

- 模块尚未延迟加载完成，提示稍后重试，状态不进入录音；
- 远程环境、WSL、无设备或录音后端不可用，清理资源并回到 `idle`；
- OAuth 不存在，提示执行 `/login`；
- WebSocket 在任何 transcript 前非致命失败，等待 250 毫秒，只重试一次；
- 4xx upgrade rejection 等 fatal 错误，直接向用户显示，不重复连接；
- 录音超过 2 秒且结果为空，再按 `wsConnected` 与 `hasAudioSignal` 区分网络失败、麦克风无信号和未检测到语音；
- 新 session 已开始，旧 generation 的 `onReady`、`onError` 和 finalize continuation 全部忽略。

还有一个更窄的恢复分支，WebSocket 确实连接、麦克风有信号、非 focus session、`finalize()` 因 1.5 秒无数据超时结束且 transcript 为空时，客户端会把本次完整音频缓冲在新连接上重放一次。它有一次性 guard，并在重连前等待 250 毫秒。

清理同样有明确范围。`cleanup()` 会让旧 session 失效、清除 release/fallback/focus timer、停止录音后端、关闭 WebSocket、清空 transcript、音量与音频 buffer。组件卸载或 Voice 被关闭时都会调用它。这样权限已经授予也不意味着麦克风一直录制；实际录音是否活动由 session 状态和 recorder 生命周期决定。

最后再回到隐私问题。源码能确认以下事实，音频是本地采集的 PCM；连接携带 OAuth Bearer token；音频通过 WebSocket 二进制帧发往 voice_stream；项目名、分支和固定开发术语会组成最多 50 个 keyterms，用于提高代码术语识别；`getVoiceKeyterms()` 虽接受可选最近文件集合，但当前 `useVoice()` 主路径省略该参数；调试路径会记录 transcript 长度，并在可见代码里存在截取文本写调试日志的语句。服务端保存期限和训练用途超出本仓库证据范围，需要以服务端政策为准。

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。**MISSING** 表示实现不在 source map 中。

| 阶段 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| 状态 | `VoiceState` 五字段 / `VoiceProvider` / 同步 store | `src/hooks/useVoice.ts` 附近 | 已确认 |
| 启用 | `useVoiceEnabled()`（`voiceEnabled === true` + OAuth + GrowthBook） | `src/hooks/useVoiceEnabled.ts` | 已确认 |
| 检查 | `/voice` 四层检查（录音环境 → OAuth → 依赖 → 权限） | `src/commands/voice/voice.ts` | 已确认 |
| 按键 | `RAPID_KEY_GAP_MS 120` / `HOLD_THRESHOLD 5` / 全角空格归一化 | `src/hooks/useVoiceIntegration.tsx` | 已确认 |
| 会话 | `startRecordingSession()`（同步 `recording` + `sessionGenRef`） | `src/hooks/useVoice.ts` | 已确认 |
| 录音 | `startRecording()`（napi → arecord 探测 → SoX） | `src/services/voice.ts` | 已确认 |
| 协议 | `connectVoiceStream()`（`linear16 / 16000 / 1`、`endpointing_ms 300`、`utterance_end_ms 1000`） | `src/services/voiceStreamSTT.ts` | 已确认 |
| keyterms | `getVoiceKeyterms()` 最多 50 项（当前主路径省略 `recentFiles`） | `src/services/voiceKeyterms.ts` | 已确认 |
| 转写 | `TranscriptText`（interim）/ `TranscriptEndpoint`（final） | `src/services/voiceStreamSTT.ts` | 已确认 |
| 回插 | prefix/suffix 锚点 + `lastSetInputRef` race guard | `src/hooks/useVoiceIntegration.tsx` | 已确认 |
| 重放 | 1.5 秒超时 + 空 transcript 时的完整缓冲重放（一次性 guard） | `src/hooks/useVoice.ts` | 已确认 |

## 设计决策

**第一，为什么用四层组件而不是一个「语音按钮」组件？** 终端按键、麦克风、远端 STT 和输入框是四个独立失败域，按键有自动重复语义，麦克风有系统权限弹窗，WebSocket 有延迟与重试，输入框有 React 过期状态。拆开让每层只回答一个问题，也让「失败按边界分层」成为可能，OAuth、系统权限和网络错误分别呈现，而不是统一伪装成「没听清」。

**第二，为什么先录音后连 WebSocket？** 如果等连接 ready 才开麦克风，开头一两秒容易丢失。先启动录音、chunk 进 `audioBuffer`，`onReady` 后合并成约一秒的 frame 再发送；`send()` 复制 NAPI Buffer 避免异步 WebSocket 读到被复用的内存。`finalize()` 有五个结束来源（endpoint、1.5 秒无数据、5 秒安全超时、ws close、已关闭），避免无限等待。

**第三，为什么 push-to-talk 的 final 统一在松开后注入？** 普通 REPL 里逐字注入会让用户看到不断变动的文本，也与键盘输入抢编辑权。push-to-talk 把 final 片段空格累计，松开后按录音时的光标锚点一次性回插；focus mode 才在每段 final 到来时立即注入并继续录音。两条模式共用同一套 prefix/suffix 合并逻辑。

**第四，为什么 Voice 绝不调用 submit？** 语音只是输入通道，不是执行决策。用户看到 interim 变成 final、继续编辑、删除误识别内容、最后自己按 Enter，之后的一切（QueryEngine、模型、权限）都走普通路径。Voice 的可取消、可观察、可回退特性，正来自它没有越过输入框这一层。

## 练习

1. **观察音频协议参数。** 在支持 Voice 的构建里按住 push-to-talk 说话，在调试日志或抓包里核对 `voice_stream` 连接的 query 参数（`linear16 / 16000 / 1`、`endpointing_ms 300`、`utterance_end_ms 1000`）与 `Authorization: Bearer` 头。

2. **复现 hold 判定。** 对照 `RAPID_KEY_GAP_MS 120` / `HOLD_THRESHOLD 5` 的逻辑，在终端里快速连按空格 5 次观察录音启动、轻点 1 次观察空格正常输入；再验证组合键（如 `meta+k`）首次按下直接激活的行为。

3. **验证 race guard。** 说话后立刻按 Enter 清空输入框，观察迟到的 final transcript 是否被 `lastSetInputRef` 丢弃而不是重新填回；再在说话过程中手动编辑文本，观察回插锚点是否仍然正确。

## 自测

1. `useVoice()` 为什么要在第一个 `await` 之前同步设置 `recording`？
2. Interim 和 Final 有什么区别？push-to-talk 模式怎样处理 final 片段？
3. 为什么「在 WSL 里能启动 Claude Code」不等于「WSL 能访问麦克风」？

<details>
<summary>参考答案</summary>

1. **避免同 tick 按键竞态。** 按键处理器启动录音后会在同一个 tick 用同步 reader 读回新状态；如果先 `await` 麦克风初始化再改状态，自动重复的空格会继续写进输入框。`sessionGenRef` 的 generation guard 又保证旧连接的迟到回调不能覆盖新 session 的 `connectionRef`。

2. **Interim 是临时预览，Final 才是稳定文本。** `TranscriptText` 回调 `onTranscript(text, false)`，`TranscriptEndpoint` 把最近一段提升为 `true`（连接关闭时未报告的 interim 也会提升为 final 避免丢字）。push-to-talk 把 final 片段用空格累计，用户松开后按光标锚点统一注入；focus mode 则在每个 final 到来时立即注入并继续录音。

3. **设备访问是独立于进程启动的检查链。** `/voice` 先走本地录音可用性检查，Linux 下尝试 `audio-capture-napi`（无 ALSA 声卡跳过），`arecord` 存在还要用 150 毫秒探测确认能真正打开设备，都不行才考虑 SoX；探测失败且平台是 WSL 时返回专门的「WSL 无法访问音频设备」错误。这一步发生在 STT 请求之前，所以麦克风通道是否打通要看 WSLg/ALSA 桥接，而不是 Claude Code 能否启动。

</details>

## 回顾｜本章的语音适配链

<details>
<summary>展开查看回顾</summary>

Claude Code 的 Voice 是一条很薄的适配链，终端自动重复事件推断 hold/release，本地后端采集 16 kHz PCM，WebSocket 把音频变成 interim/final transcript，integration 再按光标锚点写回 PromptInput。后续继续走普通消息和普通 Agent。

这套实现真正复杂的地方不在 STT API，而在边界管理。同步 store 解决同 tick 按键竞态，session generation 隔离迟到回调，audio buffer 遮住连接延迟，finalize 多终态避免无限等待，prefix/suffix 和 `lastSetInputRef` 防止覆盖用户输入。OAuth、系统麦克风权限和网络错误被分别呈现，也让「功能不可用」不至于都伪装成「没听清」。

源码能够证明客户端状态机、录音后端优先级、WebSocket 协议、一次重试、文本注入与清理。守住这条证据线，Voice 才能被准确理解为一个可取消、可观察、失败后能回到普通文本输入的适配器。

</details>

## 留给下一篇的问题

如果我想在 WSL 中使用 Claude Code 的 Voice，应该如何实现？

## 相关链接

- **上一篇**，[44 陪伴式体验如何叠加在 Agent 之上](./44-buddy-experience.md)，Buddy reroll 的确定性 seed 机制
- **下一篇**，[46 文档生成与提示词建议如何工作](./46-magicdocs-and-prompt-suggestions.md)，回答 WSL Voice 问题
- **平行阅读**，[33 终端编辑状态如何解析](./33-keybindings-and-vim-mode.md)，`voice:pushToTalk` 绑定来源
- [Claude Code Voice Dictation](https://code.claude.com/docs/en/voice-dictation)
- [Claude Code Settings](https://code.claude.com/docs/en/settings)
- [Random Number Generators and Seeding](https://finsberg.github.io/IN1910/docs/lectures/stochastic_processes/random_number_generators.html)
- [Seeds and Deterministic Generation](https://www.abratabia.com/procedural-generation/seeds-and-determinism.php)
- [Gacha Probability Calculator，Pull Odds & Pity System](https://www.hakaru.io/tools/gacha-probability-calculator)
- [I Reverse-Engineered Claude Code's /buddy System and Got a Legendary Cat](https://dev.to/ithiria894/i-reverse-engineered-claude-codes-buddy-system-heres-how-to-reroll-yours-2ghj)
- [claude-code-buddy-reroll，暴力搜索身份并校验 Buddy 结果](https://github.com/ithiria894/claude-code-buddy-reroll)
- [`reroll.js`，社区实现的候选身份搜索脚本](https://github.com/ithiria894/claude-code-buddy-reroll/blob/master/reroll.js)
- [Claude Code Buddy Marketplace，社区选择工具与版本提示](https://claude-buddy.org/)
- [Claude Code issue #42677，后续版本移除 Buddy 的兼容性线索](https://github.com/anthropics/claude-code/issues/42677)
