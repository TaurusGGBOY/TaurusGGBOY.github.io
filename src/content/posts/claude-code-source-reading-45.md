---
title: "Claude Code源码解读45：语音如何接入终端 Agent"
published: 2026-07-24T16:47:32+08:00
updated: 2026-07-24T16:47:32+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-45/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

陪伴式体验建立以后，Claude Code 如何接入语音输入、转写、按键与音频状态，并把语音重新送回普通消息流程？

先说答案：**Voice 没有给 Claude Code 增加第二套 Agent，也不会把音频直接交给模型。它做的是一次输入适配：把“按住一个键”展开成录音、WebSocket 转写和文本插入，最后仍回到原来的 PromptInput。**

完整链路可以压缩成一句话：`VoiceKeybindingHandler` 识别按住动作，`useVoice()` 驱动 `idle → recording → processing → idle`，本地录音后端产生 16 kHz、16 bit、单声道 PCM，`connectVoiceStream()` 把二进制音频帧发到语音转写端点，临时与最终文本再由 `useVoiceIntegration()` 插回光标位置。用户随后按 Enter，走的仍是普通消息提交与 QueryEngine 链路。

这也是 Voice 和上一篇 Buddy 最重要的区别。Buddy 在一次回合结束后观察消息、画出气泡；Voice 发生在回合开始前，只负责把另一种输入介质变成文本。它没有工具池，没有 `canUseTool`，也没有自己的 query loop。语音识别错了，本质上是输入文本错了；只有用户真正提交后，Agent 才开始工作。

本文仍限定在本仓库由 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码。下文代码块只保留证明当前机制所需的分支，省略了无关渲染、日志和埋点；文件组织也只代表还原结果，不推断 Anthropic 内部仓库结构。

## Voice 是输入适配器，不是语音 Agent

语音输入看起来像一个按钮，内部其实跨了四个边界：终端按键、本地麦克风、远端 STT，以及正在编辑的文本框。把它们塞进一个组件，会同时遇到按键自动重复、系统权限弹窗、WebSocket 延迟和 React 过期状态。2.1.88 的实现因此拆成四层：

1. `/voice` 负责显式启停和首次检查；
2. `VoiceKeybindingHandler` 把终端按键流解释成“按住”和“松开”；
3. `useVoice()` 持有录音与转写会话；
4. `useVoiceIntegration()` 只负责把 transcript 安全写回 PromptInput。

![Claude Code Voice 从按键、录音到普通消息输入的手绘流程图](/images/posts/claude-code-source-reading-45/45-voice-interaction-handdrawn.png)

图中最右侧故意画成普通终端输入框。`Final` 只是被插到光标处，并没有自动获得更高权限。图中的 OAuth、麦克风和网络也是三类不同失败：OAuth 决定能否连接服务，系统权限决定能否取得音频，网络与 STT 决定能否得到文字。

## 五个字段把音频生命周期暴露给 UI

Voice 的共享状态没有保存音频 Buffer 或 WebSocket。`VoiceProvider` 创建一个独立 store，UI 只订阅真正需要展示的五个字段：

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

**类型与取值说明：** `voiceState` 只有 `'idle'`、`'recording'`、`'processing'` 三个值，默认 `'idle'`；`voiceError` 是 `string | null`，默认 `null`，类型不接受 `undefined`；`voiceInterimTranscript` 是尚未最终确认的开放字符串，默认空字符串；`voiceAudioLevels` 是归一化音量数组，默认空数组；`voiceWarmingUp` 是布尔值，默认 `false`。这些定义位于 `restored-src/src/context/voice.tsx`。

`VoiceProvider({ children })` 的 `children` 是 React 节点，provider 只在首次挂载时创建 store。`useVoiceState(selector)` 接收从完整状态选出任意切片的函数，并通过 `Object.is` 判断切片是否变化；`useSetVoiceState()` 返回同步 setter，`useGetVoiceState()` 返回同步 reader。同步这一点很关键：按键处理器启动录音后，会在同一个 tick 立即读回新状态，避免继续把自动重复的空格写进输入框。

UI 对三态的翻译很克制：`recording` 显示 `listening…` 和输入光标附近的音量波形；`processing` 显示 `Voice: processing…`；`idle` 不显示 Voice indicator。`prefersReducedMotion` 为 `true` 时，processing 使用静态文本，不启动 50 毫秒动画帧。

## `/voice` 不是录音按钮，而是启用前的边界检查

语音模块首先经过构建开关、运行时 kill-switch、用户意愿和 OAuth 四道门。React 渲染路径用 `useVoiceEnabled()` 汇总后三项：

```ts
export function useVoiceEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.voiceEnabled === true)
  const authVersion = useAppState(s => s.authVersion)
  const authed = useMemo(hasVoiceAuth, [authVersion])
  return userIntent && authed && isVoiceGrowthBookEnabled()
}
```

**函数与参数说明：** `useVoiceEnabled()` 没有显式参数。`voiceEnabled` 只有严格等于 `true` 才算用户已启用，缺失、`undefined` 或 `false` 都会关闭语音；`authVersion` 变化时才重新执行较贵的 `hasVoiceAuth()`；`isVoiceGrowthBookEnabled()` 每次渲染都读取缓存的运行时开关。外层还有编译期 `feature('VOICE_MODE')`，为 `false` 时相关模块会被条件导入挡住。这段实现位于 `restored-src/src/hooks/useVoiceEnabled.ts`。

这里的认证不是“存在任意 API Key”即可。`hasVoiceAuth()` 先要求 `isAnthropicAuthEnabled()`，再检查 `getClaudeAIOAuthTokens()?.accessToken`。源码注释明确指出 voice_stream 依赖 Claude.ai OAuth，Bedrock、Vertex、Foundry 和普通 API Key 不走这条路径。

用户第一次执行 `/voice` 打开功能时，命令不会先写配置再碰运气。它依次检查录音环境、OAuth、录音依赖和麦克风权限，全部通过才保存用户设置：

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

**函数与返回值说明：** `checkRecordingAvailability()` 返回 `{ available: boolean, reason: string | null }`；不可用时 `reason` 通常给出远程环境、WSL、缺少设备或后端失败的具体原因。`isVoiceStreamAvailable()` 返回布尔值，只检查可用 OAuth token。`checkVoiceDependencies()` 返回 `available`、`missing: string[]` 与 `installCommand: string | null`。`requestMicrophonePermission()` 返回 `Promise<boolean>`：原生音频可用时通过一次短暂的真实录音探测触发系统权限，非原生后端则跳过这项探测并返回 `true`。`updateSettingsForSource()` 的来源固定为 `'userSettings'`，写入值只有 `true` 或关闭时的 `false`；如果设置文件解析失败，命令会返回错误文本，不会通知 Voice 已启用。命令实现位于 `restored-src/src/commands/voice/voice.ts`。

这段顺序也给出了隐私边界：仅仅看见 `/voice` 命令，不代表程序已经打开麦克风。音频原生模块是延迟加载的；原生后端首次启用时才通过探测触发系统权限，非原生 fallback 由后续录音进程面对系统设备权限。反过来，探测通过也不代表音频留在本机；真正录音后，PCM 会通过 WebSocket 发送给 STT 服务。源码可以确认传输路径和认证头；服务端留存时长、训练用途和治理策略需以服务端策略文档为准。

## “按住说话”是从自动重复推断出来的

终端通常不会提供可靠的 key-up 事件。Claude Code 收到的是第一次按键，以及操作系统随后不断发来的自动重复事件。所以“松开”只能被解释为：一段时间没有收到下一次同键事件。

默认绑定是空格，但裸字符不能第一次按下就开始录音，否则普通输入空格也会触发 Voice。实现先观察快速重复，再激活：

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

**参数与取值说明：** `bareChar` 是单个、无修饰符的可打印字符或 `null`；默认空格属于裸字符，`meta+k`、`ctrl+x` 这类组合键得到 `null` 并在首次按下直接激活。`rapidCountRef` 累计 120 毫秒间隔内的重复次数；裸字符达到 5 次才开始录音，第 2 次开始显示 `keep holding…`。`repeatCount` 允许终端把多个重复字符合并成一次事件。`stripTrailing(maxStrip, opts)` 的 `char` 默认空格，`anchor` 默认 `false`，`floor` 默认 0；激活时 `anchor: true` 会记录光标前缀和后缀。代码位于 `restored-src/src/hooks/useVoiceIntegration.tsx`。

前两个裸字符允许流进输入框，这保证轻点空格仍然零延迟地输入空格；确定是 hold 后，再精确移除本次 warmup 泄漏的字符。对于中文输入法，空格扫描还会把全角空格 `U+3000` 归一化后判断。源码同时承认一个边界：如果用户把 push-to-talk 绑定为裸字母，输入本来就以该字母结尾时，防御性清理可能多删一个字符，因此校验会发出警告。

按键绑定来自 `Chat` context 下的 `voice:pushToTalk`。存在 KeybindingProvider 且用户把该绑定设为 `null` 或改给其他 action 时，结果就是 `null`，不会偷偷回退到空格；只有根本没有 provider 的 headless/test 场景才使用硬编码默认空格。Modal、权限对话框或隐藏 PromptInput 时也不接管按键，避免把 transcript 写进已经失焦的输入框。

## 录音必须先同步进入 recording，再做异步检查

`useVoice()` 真正开始一次 session 时，第一件事不是 `await` 麦克风，而是同步改变状态：

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

**函数与状态说明：** `startRecordingSession()` 没有参数，返回 `Promise<void>`；调用方用 `void` 启动它，不等待完成。`updateState('recording')` 必须发生在第一个 `await` 前，让同步 store reader 立刻看到新状态。`sessionGenRef` 是递增数字；异步回调捕获 `myGen`，一旦新 session 已开始，旧连接的回调就被视为 stale。`availability.reason` 可为字符串或 `null`，为空时回退到通用错误。实现位于 `restored-src/src/hooks/useVoice.ts`。

这个 generation guard 解决的是典型异步竞态：第一次 WebSocket 很慢，用户已经松开又重新按住；如果旧连接稍后才 `onReady`，它不能覆盖第二次 session 的 `connectionRef`。`attemptGenRef` 又在同一 session 内区分第一次连接与重试连接，避免第一次连接关闭时的尾随错误把第二次连接清理掉。

## 本地录音有后端优先级，不等于自动安装依赖

录音数据统一为 16 kHz、16 bit signed、mono PCM。`startRecording()` 优先尝试 `audio-capture-napi`，Linux 原生不可用时尝试可实际打开设备的 `arecord`，最后才尝试 SoX 的 `rec`：

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

**函数与参数说明：** `onData` 每次接收一个 PCM `Buffer`；`onEnd` 在设备或子进程结束时调用；`options` 可省略，`silenceDetection` 也可省略。只有明确传入 `false` 才关闭静音自动停止，push-to-talk 路径正是如此；`true` 或 `undefined` 允许后端的静音检测。返回 `true` 表示某个后端已启动，`false` 表示没有可用后端。片段省略了启动前停止旧 recorder 的防御分支，但保留了后端选择与回调语义。源文件是 `restored-src/src/services/voice.ts`。

这里需要特别强调：`checkVoiceDependencies()` 只返回建议安装命令，不会自己执行 `brew install`、`apt-get`、`dnf` 或 `pacman`。远程 Homespace 和设置了 `CLAUDE_CODE_REMOTE` 的环境直接报告没有本地音频设备。Windows 原生模块失败后没有 SoX fallback；Linux 即便 PATH 里存在 `arecord`，还会用 150 毫秒探测确认它真的能打开设备，避免在 WSL 或无声卡服务器上把“命令存在”误判成“能录音”。

每个音频 chunk 还会计算 RMS，经过平方根曲线压到 0 到 1，用最近 16 个值驱动波形。`level > 0.01` 才标记 `hasAudioSignal`。这不是语音活动检测，也不会判断用户说了什么；它只用于 UI 和区分“没有音频信号”与“有声音但没有识别出文字”。

## 录音和 WebSocket 并行，先到的音频先缓冲

如果等 WebSocket 连接完成才打开麦克风，用户开头一两秒很容易丢失。实现反过来：先启动录音，连接尚未 ready 时把 chunk 放进 `audioBuffer`；`onReady` 后按约 32,000 字节，也就是约一秒 PCM，合并成较少的 WebSocket frame，再把后续 chunk 直接发送。

`connectVoiceStream()` 构造的协议参数是明确的：

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

**函数与参数说明：** `connectVoiceStream(callbacks, options?)` 的 `callbacks` 必须提供 `onTranscript(text, isFinal)`、`onError(error, opts?)`、`onClose()` 与 `onReady(connection)`；`opts?.fatal` 是可选布尔值，4xx upgrade rejection 会标记为 `true`，调用方不做无意义重试。`options.language` 是可选字符串，缺失时回退 `'en'`；静态源码支持的本地归一化代码集合包括 `en`、`es`、`fr`、`ja`、`de`、`pt`、`it`、`ko`、`hi`、`id`、`ru`、`pl`、`tr`、`nl`、`uk`、`el`、`cs`、`da`、`sv`、`no`，不支持的设置回退英文并记录原值。`options.keyterms` 是可选字符串数组；`getVoiceKeyterms(recentFiles?)` 最多返回 50 项，能组合项目名、git 分支、固定开发术语，以及调用方显式传入的最近文件名。当前 `useVoice()` 调用没有传 `recentFiles`，所以这条可见主路径不会加入最近文件名。这个构造过程没有模型调用。实现位于 `restored-src/src/services/voiceStreamSTT.ts` 与 `voiceKeyterms.ts`。

连接通过 `Authorization: Bearer <OAuth token>` 认证，打开后立即发送 `KeepAlive`，随后每 8 秒一次。`send()` 会复制 NAPI Buffer 再发二进制帧，避免复用内存被异步 WebSocket 读到旧数据。`finalize()` 发送 `CloseStream` 后有多个结束来源：收到 endpoint、1.5 秒无数据超时、5 秒安全超时、WebSocket close，或连接已经关闭。它们分别映射到 `FinalizeSource` 的 `'post_closestream_endpoint'`、`'no_data_timeout'`、`'safety_timeout'`、`'ws_close'`、`'ws_already_closed'`。

## Interim 负责预览，Final 才成为稳定文本

服务端消息主要有 `TranscriptText`、`TranscriptEndpoint` 和 `TranscriptError`。Text 先作为 interim 回调，Endpoint 再把最近一段提升为 final：

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

**消息与参数说明：** `TranscriptText.data` 是开放字符串；`onTranscript` 的第二个参数 `false` 表示可被后续识别修订的临时文本，`true` 表示提交给调用层的最终片段。`TranscriptEndpoint` 没有文本字段，它消费 `lastTranscriptText`。如果连接关闭时仍有未报告 interim，close handler 也会把它提升为 final，避免丢字。完整源码还区分旧后端的分段文本和 Nova 3 的累计修订，以上片段只证明共同主路径。

`useVoice()` 对两种工作模式的 final 处理不同。push-to-talk 会把 final 片段用空格累计，用户松开后统一注入；focus mode 会在每个 final 到来时立即注入并继续录音。本文主线中的 `useVoiceIntegration()` 传入 `focusMode: false`，因此普通 REPL 走前一种模式；。

## 文本插回光标，而不是覆盖整条 prompt

录音激活时，integration 记录光标前后的 prefix 与 suffix。interim 到来后，文本被放在两者之间；final 到来后，仍然使用同一锚点，并把光标定位到转写文本后、原 suffix 前：

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

**变量与参数说明：** `prefix_1`、`text`、`suffix_1` 都是开放字符串；`leadingSpace_0` 只在 prefix 非空、末尾没有空白且 transcript 非空时为单个空格，否则为空；`trailingSpace_0` 对 suffix 做对称处理。`insertTextRef.current` 是 `InsertTextHandle | null`，存在时同时设置文本和数字光标位置，为 `null` 时退化为只设置文本。`setInputWithCursor(value, cursor)` 的 `value` 是完整输入，`cursor` 是字符串索引。逻辑位于 `restored-src/src/hooks/useVoiceIntegration.tsx`。

还有一道看似多余但很重要的保护：hook 用 `lastSetInputRef` 记住自己最后写入的完整输入。如果 WebSocket 收尾期间用户已经按 Enter 清空输入，或手动编辑了文本，当前输入就与该 ref 不同，迟到的 transcript 会被丢弃，而不是重新填回已经提交的旧 prompt。这条 race guard 才保证“重新送回普通消息流程”不会变成“转写服务替用户偷偷再次提交”。

Voice 只写输入框，不调用 submit。用户可以看到 interim 变成 final、继续编辑、删除误识别内容，最后自己按 Enter。之后发生的一切——消息对象、QueryEngine、模型调用、工具权限——都复用前面章节已经解释过的普通路径。

## 失败处理按边界分层，不能统一成“没听清”

`idle → recording → processing → idle` 是成功主路径，失败则可能在每一层返回：

- 模块尚未延迟加载完成：提示稍后重试，状态不进入录音；
- 远程环境、WSL、无设备或录音后端不可用：清理资源并回到 `idle`；
- OAuth 不存在：提示执行 `/login`；
- WebSocket 在任何 transcript 前非致命失败：等待 250 毫秒，只重试一次；
- 4xx upgrade rejection 等 fatal 错误：直接向用户显示，不重复连接；
- 录音超过 2 秒但没有结果：再按 `wsConnected` 与 `hasAudioSignal` 区分网络失败、麦克风无信号和未检测到语音；
- 新 session 已开始：旧 generation 的 `onReady`、`onError` 和 finalize continuation 全部忽略。

还有一个更窄的恢复分支：WebSocket 确实连接、麦克风有信号、非 focus session、`finalize()` 因 1.5 秒无数据超时结束且 transcript 为空时，客户端会把本次完整音频缓冲在新连接上重放一次。它有一次性 guard，并在重连前等待 250 毫秒。。

清理同样有明确范围。`cleanup()` 会让旧 session 失效、清除 release/fallback/focus timer、停止录音后端、关闭 WebSocket、清空 transcript、音量与音频 buffer。组件卸载或 Voice 被关闭时都会调用它。这样权限已经授予也不意味着麦克风一直录制；实际录音是否活动由 session 状态和 recorder 生命周期决定。

最后再回到隐私问题。源码能确认以下事实：音频是本地采集的 PCM；连接携带 OAuth Bearer token；音频通过 WebSocket 二进制帧发往 voice_stream；项目名、分支和固定开发术语会组成最多 50 个 keyterms，用于提高代码术语识别；`getVoiceKeyterms()` 虽接受可选最近文件集合，但当前 `useVoice()` 主路径没有传入；调试路径会记录 transcript 长度，并在可见代码里存在截取文本写调试日志的语句。文章只能把这些输入和边界说清楚，不能替服务端补一份隐私承诺。

## 小结

Claude Code 的 Voice 是一条设计得很“薄”的适配链：终端自动重复事件推断 hold/release，本地后端采集 16 kHz PCM，WebSocket 把音频变成 interim/final transcript，integration 再按光标锚点写回 PromptInput。到这里语音能力就结束了，后续仍是普通消息和普通 Agent。

这套实现真正复杂的地方不在 STT API，而在边界管理。同步 store 解决同 tick 按键竞态，session generation 隔离迟到回调，audio buffer 遮住连接延迟，finalize 多终态避免无限等待，prefix/suffix 和 `lastSetInputRef` 防止覆盖用户输入。OAuth、系统麦克风权限和网络错误被分别呈现，也让“功能不可用”不至于都伪装成“没听清”。

源码能够证明客户端状态机、录音后端优先级、WebSocket 协议、一次重试、文本注入与清理。守住这条证据线，Voice 才能被准确理解为一个可取消、可观察、失败后能回到普通文本输入的适配器。

## 留给下一篇的问题

语音输入补充交互以后，MagicDocs 与 Prompt Suggestions 如何从上下文生成文档和下一步建议，并把结果展示给用户？

