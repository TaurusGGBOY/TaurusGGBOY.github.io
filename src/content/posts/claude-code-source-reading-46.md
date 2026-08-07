---
title: "Claude Code源码解读46：文档生成与提示词建议如何工作 🔬"
published: 2026-07-24T16:47:33+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-46/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

如果我想在 WSL 中使用 Claude Code 的 Voice，应该如何实现？

答案是先把 Windows 的麦克风通过 WSLg 暴露给 Linux，再让 ALSA 的默认录音设备转到 WSLg 提供的 PulseAudio，`voice` 配置本身不足以完成这件事。官方文档把 **WSL2 + WSLg** 列为前提；WSL1、没有 WSLg 的 WSL2、SSH 或其他远程会话没有本地麦克风通道，应该直接在 Windows 本机运行 Claude Code，或者使用外部语音转文字工具。

这不是凭空推测。一个在 Windows 11 + WSL2 + Ubuntu 上实测的配置方案安装了 `libasound2-plugins`、`alsa-utils`、SoX 和 PulseAudio 工具，再用 ALSA 配置把默认设备指向 PulseAudio；另一位 WSL2 用户进一步验证，只有 `~/.asoundrc` 时仍可能出现 `Unknown PCM default`，同时写入 `/etc/asound.conf` 才能让 `arecord` 打开 `default`。两篇方案都把“先录一段音频”作为 `/voice` 之前的验收条件。

## 介绍本章的一些概念

- MagicDocs 与 Prompt Suggestions 都是**回合后旁路**，MagicDocs 是 post-sampling hook（维护文档），Prompt Suggestions 从 `handleStopHooks()` 触发（预测下一句），可见调用图中不存在二者之间的直接边；两套能力失败都不阻断主回答。
- MagicDocs 用**文件头声明 opt-in**，`# MAGIC DOC: <title>`（正则带 `i`/`m`，允许任意行首）加紧邻斜体说明作为文档专属指令；只有被 `FileReadTool` 真读过且标题匹配的路径才进入 `trackedMagicDocs`，且 2.1.88 只在 `USER_TYPE === 'ant'` 初始化。
- 文档更新只在**主 REPL 自然收尾**时串行发生（`querySource === 'repl_main_thread'` 且最后一轮无工具调用）；它先克隆 `readFileState` 并删除当前路径缓存，避免读到 `file_unchanged` 占位符。
- 权限边界与 40 篇同构，MagicDocs 内建 Agent 只有 `Edit` 工具、模型固定 `'sonnet'`，`canUseTool` 要求 `file_path` 精确等于当前文档路径，其余一律 deny。
- Prompt Suggestions 生成时**刻意保持父请求的 cache key**，不传 `tools: []`、不改 effort/output 参数，改用客户端 `canUseTool` 拒绝工具，并 `skipTranscript: true`、`skipCacheWrite: true`，注释说明改参数会破坏与父请求共享的缓存键。
- 结果经过**确定性过滤**（拒绝 done、元文本、括号推理、API 错误、超 12 词、多句、Markdown、评价性表达等），只暂存在 AppState `promptSuggestion`（`shownAt` / `acceptedAt` 初始为 0）；Tab 接受、空输入 Enter 或内容完全相等提交算 accepted，其他提交记 ignored。
- 证据边界，声明识别、空闲判断、路径权限、缓存策略、过滤与三去向都可确认；WSL/Voice 相关的「维护型旁路」与「预测缓存」概念与 45 篇的检查链相互独立。

> 🔬 **可选实验子系统**，MagicDocs 在 2.1.88 只在 `USER_TYPE === 'ant'` 时初始化，Prompt Suggestions 受 `tengu_chomp_inflection` 灰度控制；两者都是回合后旁路。非官方追踪文章还记录了 MagicDocs 在 v2.1.91 被移除。不影响理解内核，可跳过。

## 本篇新增

承接 45 篇的输入通道，本章看两条回合后旁路，引入三个概念，

- **维护型旁路**，文档更新在主对话空闲时运行，读取受限上下文并把写权限限定到声明文件。
- **预测缓存**，建议结果按父请求和输入状态缓存，避免预测调用扰动主对话的缓存前缀。
- **临时交互状态**，候选建议停留在 AppState，接受后才进入正式 prompt 历史。

![MagicDocs 与 Prompt Suggestions 两条旁路](/images/posts/claude-code-source-reading-46/46-sidecars-detail-handdrawn.png)

先把文档副作用、模型预测和用户确认拆成三条线，后文的权限、cache key 与 ghost text 才不会混为一谈。

## 问题

上一篇（45）的问题是，**如果我想在 WSL 中使用 Claude Code 的 Voice，应该如何实现？**

答案是先把 Windows 的麦克风通过 WSLg 暴露给 Linux，再让 ALSA 的默认录音设备转到 WSLg 提供的 PulseAudio，`voice` 配置本身不足以完成这件事。官方文档把 **WSL2 + WSLg** 列为前提；WSL1、没有 WSLg 的 WSL2、SSH 或其他远程会话没有本地麦克风通道，应该直接在 Windows 本机运行 Claude Code，或者使用外部语音转文字工具。

这不是凭空推测。一个在 Windows 11 + WSL2 + Ubuntu 上实测的配置方案安装了 `libasound2-plugins`、`alsa-utils`、SoX 和 PulseAudio 工具，再用 ALSA 配置把默认设备指向 PulseAudio；另一位 WSL2 用户进一步验证，只有 `~/.asoundrc` 时仍可能出现 `Unknown PCM default`，同时写入 `/etc/asound.conf` 才能让 `arecord` 打开 `default`。两篇方案都把「先录一段音频」作为 `/voice` 之前的验收条件。

### 先判断你的 WSL 是否具备条件

在 PowerShell 中确认 WSL2 与 WSLg，

```powershell
wsl --version
wsl --status
```

你至少应当看到 WSL 2，并且 WSLg 已安装；如果版本太旧，可以先执行 `wsl --update`，然后执行 `wsl --shutdown`，重新打开发行版。Windows 的「设置 → 隐私和安全性 → 麦克风」也要允许系统和你使用的终端访问麦克风。

| 环境 | 内置 Voice 的结论 |
| --- | --- |
| Windows 11 + WSL2 + WSLg | 可以继续配置 PulseAudio/ALSA 并测试 |
| WSL1，或 WSL2 但没有 WSLg | 没有可用的音频设备，改用 Windows 原生 Claude Code |
| SSH、容器、Claude Code Remote | 麦克风在另一台机器，内置 Voice 会在本地检查阶段拒绝 |

### 把 ALSA 的默认设备接到 WSLg

以下是 Ubuntu/Debian 上最小的音频依赖。`pulseaudio` 是 WSLg 提供的服务端；这里安装的是客户端工具和 ALSA 插件，不是另起一个独立的音频服务器，

```bash
sudo apt update
sudo apt install -y libasound2-plugins alsa-utils sox pulseaudio-utils
```

先在用户级配置默认设备，

```bash
cat > ~/.asoundrc <<'EOF'
pcm.!default {
  type pulse
  fallback "sysdefault"
}

ctl.!default {
  type pulse
  fallback "sysdefault"
}
EOF
```

如果仍然报 `Unknown PCM default`，采用社区方案的第二步，先备份已有系统配置，再写入同样的映射。系统文件可能被其他 Linux 音频程序使用，所以不要在没有备份的情况下盲目覆盖，

```bash
sudo cp -a /etc/asound.conf "/etc/asound.conf.bak.$(date +%s)" 2>/dev/null || true
sudo tee /etc/asound.conf >/dev/null <<'EOF'
pcm.!default {
  type pulse
  fallback "sysdefault"
}

ctl.!default {
  type pulse
  fallback "sysdefault"
}
EOF
```

关闭当前 WSL 终端并重新打开，让 ALSA 重新读取配置。Arch 用户对应安装 `alsa-utils` 和 `pulseaudio-alsa`；不要把 Ubuntu 的 `apt` 命令原样搬过去。

### 不要直接猜 `/voice`，先复现它的录音检查

先用与 Claude Code 相同的默认设备录音三秒，

```bash
arecord -D default -f cd -d 3 /tmp/claude-voice.wav
aplay /tmp/claude-voice.wav
```

如果这条命令仍然提示 `cannot find card '0'`、`Unknown PCM default` 或没有声音，问题还在 WSLg/ALSA 桥接，和 Claude Code 的 WebSocket 无关。社区实测的 SoX 路径也可以单独验证，

```bash
rec /tmp/claude-voice.wav trim 0 3
paplay /tmp/claude-voice.wav
```

只有 `arecord` 或 `rec` 能真正打开麦克风后，再启动 Claude Code，

```bash
claude
/login
/voice
```

这里的 `/login` 不是可选装饰。2.1.88 的 `isVoiceStreamAvailable()` 只接受 Anthropic/Claude.ai OAuth token；API Key、Bedrock、Vertex 或 Foundry 不能直接使用内置语音转写。音频会通过 `voice_stream` WebSocket 发往 Anthropic 的转写服务，WSL 只负责采集和转发。

### 2.1.88 源码到底在哪里失败

源码没有把「在 WSL」本身当成永远拒绝的条件。`getPlatform()` 通过 `/proc/version` 识别 WSL；`commands/voice/voice.ts` 执行 `/voice` 时，先调用 `checkRecordingAvailability()`，再检查 OAuth、录音依赖和权限。

在 Linux/WSL 中，`services/voice.ts` 的顺序是，

1. 尝试 `audio-capture-napi`；Linux 没有 ALSA 声卡时，这条原生路径会被跳过。
2. 如果存在 `arecord`，用 16 kHz、16-bit、单声道参数启动一个短探测，并等待它真正打开设备；命令存在但设备打不开不算成功。
3. 探测成功，Voice 才继续；探测失败且平台是 WSL，返回「WSL 无法访问音频设备」的专门错误。
4. 没有 `arecord` 时才考虑 SoX 的 `rec`；WSL 在缺少两者时同样直接返回 WSL 音频不可用提示。

所以实际故障点通常在 `/voice` 的**本地录音可用性检查**，而不是 STT 请求阶段。你可以先用上面的 `arecord` 命令判断；如果它成功但当前安装的 Claude Code 仍立即说 WSL 不可用，先检查 `claude --version` 并更新到包含 WSLg 探测逻辑的版本。社区文章提到过某些版本存在硬编码的 WSL 拒绝，但不应该为了绕过提示直接修改打包后的 CLI，这会在自动更新或签名校验后失效，也会让真正的音频权限问题被隐藏。

如果你的机器无法提供 WSLg 音频，另一个可行方向是社区的 VoiceMode MCP，它把 Whisper/Kokoro 等语音服务作为 MCP 接入，并且项目文档专门列出 WSL2 需要 PulseAudio 包。它不是 Claude Code 内置 `/voice`，但可以作为「WSL 必须保留、内置 Voice 又无法通过设备检查」时的替代路径。

这样分层以后，故障定位就很明确，**WSLg/Windows 权限 → ALSA 默认设备 → `arecord`/`rec` 实测 → Claude Code 本地检查 → OAuth WebSocket**。不要把「能在 WSL 里启动 Claude Code」和「WSL 能访问麦克风」当成同一件事。

## 正文

本文全部引用 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` 还原源码。代码块只保留证明控制流所需的字段；每个代码块后标注证据位置。`restored-src/` 只用于定位证据，不表示内部仓库原始目录。

### 这张金额单位工单结束后，系统还会替用户准备下一步

工程师在发布群里写完根因报告，还想把结论沉淀进团队维护的事故 runbook。他把主任务要求写成，

> 更新受 MagicDocs 管理的事故 runbook，并报告这张金额单位工单的根因、改动、测试、成本和遗留风险；不要把临时客户数据写进文档。

主对话完成后，MagicDocs 旁路只在空闲时串行更新声明要维护的文档；Prompt Suggestions 则根据刚完成的工单上下文，预测用户下一句可能是「把整数分边界加入回归测试」或「查看部署差异」。工程师看到建议后可以选择忽略，文档旁路也要遵守自己的写入边界；文档更新和候选 prompt 都不能污染主对话，也不应抢走主 Agent 的权限。

### 两条旁路分别维护文档与预测输入

先补两个基础概念。

**forked agent** 是从当前会话上下文分叉出来的一次模型执行。它能看见父会话提供的历史和配置，但可以拥有更窄的提示词、工具与持久化策略。这样做的价值是，文档维护和下一句预测都不必污染主 Agent 的回答，也不需要把结果塞回主对话，让主模型再判断一次。

**post-sampling hook** 是模型采样完成后的内部回调，由 2.1.88 的 `postSamplingHooks.ts` 管理；用户 Hook 则从 `settings.json` 注册。MagicDocs 使用前者。Prompt Suggestions 虽然也发生在回合尾部，却从 `handleStopHooks()` 直接触发。

两条链可以压成下面这张图，

![MagicDocs 与 Prompt Suggestions 两条回合后旁路的手绘流程图](/images/posts/claude-code-source-reading-46/46-magicdocs-prompt-suggestions-handdrawn.png)

图中实线对应还原源码可确认的调用或状态流。上、下两条线各自从回合尾部启动，MagicDocs 维护文件，Prompt Suggestions 生成输入候选，可见调用图中不存在二者之间的直接边。

### MagicDocs｜先用文件头声明「这份文档要被维护」

MagicDocs 只监听已经被 `FileReadTool` 读过的内容，再用特殊标题识别 opt-in 文件。核心识别函数在 `restored-src/src/services/MagicDocs/magicDocs.ts`，

```ts
const MAGIC_DOC_HEADER_PATTERN = /^#\s*MAGIC\s+DOC:\s*(.+)$/im
const ITALICS_PATTERN = /^[_*](.+?)[_*]\s*$/m

export function detectMagicDocHeader(
  content: string,
): { title: string; instructions?: string } | null {
  const match = content.match(MAGIC_DOC_HEADER_PATTERN)
  if (!match || !match[1]) return null

  const title = match[1].trim()
  // 省略「标题后下一行或隔一个空行」的定位代码
  const italicsMatch = nextLine.match(ITALICS_PATTERN)
  if (italicsMatch && italicsMatch[1]) {
    return { title, instructions: italicsMatch[1].trim() }
  }
  return { title }
}
```

> 证据，`restored-src/src/services/MagicDocs/magicDocs.ts`（2.1.88 source map 还原源码），`detectMagicDocHeader(content)`。`content` 是完整文件字符串。匹配成功时返回 `{ title }`，紧随标题的斜体行存在时再增加可选字符串 `instructions`；不匹配返回 `null`，文件读取监听器据此跳过 `registerMagicDoc()`。正则带 `i` 和 `m`，大小写不敏感，并允许 `^` 匹配任意行首；因此实现实际上不只认文件第一行，尽管源码注释写着 first line。文章以可执行正则为准。

斜体说明会作为文档维护 Agent 的额外指令。例如，

```md
# MAGIC DOC: Authentication architecture

_Only preserve stable entry points and security boundaries._
```

**格式说明，** 标题的 `MAGIC` 与 `DOC` 之间至少一个空白，冒号后必须有非空标题；斜体说明由 `_` 或 `*` 包住。源码注释的设计意图是「紧邻下一行，允许一个空行」，但定位正则开头用了也能匹配换行的 `\s*`，实际可能吞掉更多空白；因此不能把「至多一个空行」当成严格校验规则。与标题区段无关的普通斜体不会进入 `instructions`。

只有文件真的被读过，路径才进入 `trackedMagicDocs`。同一路径只登记一次，Map 不保存当时的标题和内容，更新前会重新读取，

```ts
const trackedMagicDocs = new Map<string, MagicDocInfo>()

export function registerMagicDoc(filePath: string): void {
  if (!trackedMagicDocs.has(filePath)) {
    trackedMagicDocs.set(filePath, { path: filePath })
  }
}

export async function initMagicDocs(): Promise<void> {
  if (process.env.USER_TYPE === 'ant') {
    registerFileReadListener((filePath, content) => {
      if (detectMagicDocHeader(content)) registerMagicDoc(filePath)
    })
    registerPostSamplingHook(updateMagicDocs)
  }
}
```

> 证据，`restored-src/src/services/MagicDocs/magicDocs.ts`（2.1.88 source map 还原源码）。`registerMagicDoc(filePath)` 接受由文件读取监听器提供的路径字符串。重复路径保持原记录并跳过追加。`initMagicDocs()` 接受零个参数，返回 `Promise<void>`；`USER_TYPE` 严格等于字符串 `'ant'` 时注册两个回调，`undefined`、`'external'` 或其他值都沿关闭分支返回。

因此文档维护从声明与发现开始。用户（或已有文件）用标题声明这份 Markdown 可以被后台维护，主 Agent 的普通 `Read` 再让运行时发现它。跟踪集合只包含已经读取且标题匹配的文件。

### 更新只在主对话空闲时串行发生

文档维护不应该在工具还没收尾时抢写文件。注册后的 `updateMagicDocs` 先检查来源是否为 `repl_main_thread`、最后一个 assistant turn 是否自然收尾，以及 Map 里是否已有文档；多个文档逐个等待完成，外层 `sequential()` 再串起多次 hook。

```ts
const updateMagicDocs = sequential(async function (
  context: REPLHookContext,
): Promise<void> {
  const { messages, querySource } = context

  if (querySource !== 'repl_main_thread') return
  if (hasToolCallsInLastAssistantTurn(messages)) return
  if (trackedMagicDocs.size === 0) return

  for (const docInfo of Array.from(trackedMagicDocs.values())) {
    await updateMagicDoc(docInfo, context)
  }
})
```

> 证据，`restored-src/src/services/MagicDocs/magicDocs.ts`（2.1.88 source map 还原源码），`updateMagicDocs`。`context` 包含完整 `messages`、system/user/system context 和 `toolUseContext`。`querySource` 只有精确值 `'repl_main_thread'` 才继续，省略值、`'sdk'`、`'magic_docs'` 以及其他子 Agent 来源都会结束本次 hook。`hasToolCallsInLastAssistantTurn()` 为 `true` 时推迟更新，为 `false` 时继续；Map 为空时跳过模型调用。循环中的 `docInfo` 至少含跟踪路径，并与同一份 `context` 一起交给 `updateMagicDoc()`，`await` 使多个文档串行维护。

「空闲」在这里是很窄的代码判断，最后一次 assistant turn 自然收尾。该条件只描述模型回合状态；每次 post-sampling hook 获得机会时重新判断，操作系统空闲和固定分钟 timer 都不参与。

### 上下文合并四个来源

更新单个文档时，MagicDocs 会重新读取最新内容。它特意克隆 `readFileState`，再删掉当前路径的缓存项，避免 `FileReadTool` 因「文件未变化」只返回 `file_unchanged` 占位符。

```ts
const clonedReadFileState = cloneFileStateCache(
  toolUseContext.readFileState,
)
clonedReadFileState.delete(docInfo.path)

const result = await FileReadTool.call(
  { file_path: docInfo.path },
  { ...toolUseContext, readFileState: clonedReadFileState },
)
```

> 证据，`restored-src/src/services/MagicDocs/magicDocs.ts`（2.1.88 source map 还原源码）。`cloneFileStateCache()` 接收父会话的 `toolUseContext.readFileState`，产生隔离的 `clonedReadFileState`；`delete(docInfo.path)` 只清当前 Magic Doc。`FileReadTool.call()` 的输入对象只有开放字符串 `file_path`，值固定来自跟踪记录，不由模型临时选择；返回的 `result` 随后提供最新文件内容。第二个参数沿用父 `toolUseContext` 的其他字段，但把 `readFileState` 替换为缓存副本，因此读取不会破坏主会话自己的去重状态。

随后，`buildMagicDocsUpdatePrompt()` 把四个变量塞进模板，当前文档全文、文件路径、标题、可选说明。模板默认要求维护当前状态并跳过 changelog 式追加；内容已经完整时结束工具调用。用户还可以在 `~/.claude/magic-docs/prompt.md` 放自定义模板，

```ts
export async function buildMagicDocsUpdatePrompt(
  docContents: string,
  docPath: string,
  docTitle: string,
  instructions?: string,
): Promise<string> {
  const promptTemplate = await loadMagicDocsPrompt()
  const customInstructions = instructions
    ? `DOCUMENT-SPECIFIC UPDATE INSTRUCTIONS: ... "${instructions}"`
    : ''

  return substituteVariables(promptTemplate, {
    docContents,
    docPath,
    docTitle,
    customInstructions,
  })
}
```

> 证据，`restored-src/src/services/MagicDocs/magicDocs.ts`（2.1.88 source map 还原源码）。`docContents`、`docPath`、`docTitle` 都是开放字符串，分别来自最新文件、跟踪路径和重新识别的标题；`instructions` 是 `string | undefined`，缺省时 `customInstructions` 回退为空字符串。`promptTemplate` 来自 `loadMagicDocsPrompt()`；自定义模板不存在或不可读时静默回退默认模板。替换对象只提供 `docContents`、`docPath`、`docTitle`、`customInstructions` 四个键；未知变量保留原样，而且单次 `replace()` 不会再次替换文档正文里碰巧出现的占位符。

最终的 Agent 同时拿到两类上下文，`forkContextMessages: messages` 提供父会话历史；`override` 继续使用本轮 `systemPrompt`、`userContext` 和 `systemContext`；新的 user message 则装入维护规则和当前文档。这比「把聊天总结成 Markdown」更精确，它是在父会话语义、项目环境与文档现状之间做受限更新。

### 文档更新通过精确路径权限自动决策

MagicDocs 使用内建 Agent 定义，模型固定为 `'sonnet'`，工具声明只含 `Edit`。更关键的是，它另写了一层 `canUseTool`，工具名必须是 `Edit`，输入必须是非 `null` 对象，`file_path` 必须是字符串，并且必须等于当前文档路径。

```ts
function getMagicDocsAgent(): BuiltInAgentDefinition {
  return {
    agentType: 'magic-docs',
    tools: [FILE_EDIT_TOOL_NAME],
    model: 'sonnet',
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => '',
  }
}

const canUseTool = async (tool: Tool, input: unknown) => {
  if (
    tool.name === FILE_EDIT_TOOL_NAME &&
    typeof input === 'object' && input !== null &&
    'file_path' in input && input.file_path === docInfo.path
  ) {
    return { behavior: 'allow' as const, updatedInput: input }
  }
  return { behavior: 'deny' as const, message: `only Edit is allowed ...` }
}
```

> 证据，`restored-src/src/services/MagicDocs/magicDocs.ts`（2.1.88 source map 还原源码）。`getMagicDocsAgent()` 接受零个参数。`agentType`、`source`、`baseDir` 是固定字符串；`tools` 只声明 `FILE_EDIT_TOOL_NAME`，`model` 固定为 `'sonnet'`，`getSystemPrompt` 返回空字符串，由单独构造的 MagicDocs user prompt 承载维护规则。这个调用点未暴露模型配置入口。`canUseTool(tool, input)` 的 `input` 类型是 `unknown`，必须逐层收窄；精确路径上的 `Edit` 返回 `behavior: 'allow'` 并原样返回 `updatedInput`。其余工具、`null`、非对象、缺少路径、非字符串路径或其他文件路径都返回 `behavior: 'deny'`；封闭返回路径只包含 allow/deny。

这回答了「接受/拒绝」的一半，opt-in 发生在文件标记与被读取时，执行阶段由内部权限回调自动允许精确文件上的 `Edit`，其他行为统一 deny。工具集合和路径检查把副作用收窄到当前文档，`Write`、Bash 与其他仓库路径都被拒绝。

`runAgent()` 的消息被 `for await` 完整消费，主 transcript 和 UI 都只观察最终文件副作用。若模型判断内容已经完整，默认提示允许它返回简短解释并停止，此时文件保持原状。

### Prompt Suggestions 预测用户的下一句输入

Prompt Suggestions 的提示词把目标限定得非常死，看最近消息与原始请求，预测用户自然会输入的下一句；不要评价、不要提问、不要引入新想法、不要用 Claude 的口吻，输出 2 到 12 个词或者保持空白。

这一区分很重要。任务规划回答「系统下一步应该做什么」，Prompt Suggestions 回答「用户大概率正准备输入什么」。即使两者碰巧都生成 `run tests`，评价标准也不同，前者看任务正确性，后者看对用户意图的延续。

初始化开关先经过一条明确的优先级链，

```ts
export function shouldEnablePromptSuggestion(): boolean {
  const envOverride = process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION
  if (isEnvDefinedFalsy(envOverride)) return false
  if (isEnvTruthy(envOverride)) return true

  if (!getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_chomp_inflection', false,
  )) return false
  if (getIsNonInteractiveSession()) return false
  if (isAgentSwarmsEnabled() && isTeammate()) return false

  return getInitialSettings()?.promptSuggestionEnabled !== false
}
```

> 证据，`restored-src/src/services/promptSuggestions/`（2.1.88 source map 还原源码），`shouldEnablePromptSuggestion()`。函数接受零个参数。环境变量若被帮助函数识别为显式假值则强制关闭，识别为真值则强制开启，并且优先于后续所有门；具体真/假值集合由共享 helper 定义。环境变量未形成覆盖时，GrowthBook 键以 `false` 为回退值；非交互会话关闭；启用 swarm 且当前是 teammate 时关闭。设置字段为 `boolean | undefined`，`false` 关闭，`true` 与 `undefined` 都通过最后一关。

环境变量真值会「覆盖所有门」是源码注释表达的测试通道语义。因此它甚至早于非交互与 teammate 判断。正常产品路径下则先要求实验开关存在，再谈用户设置。Settings UI 只有 GrowthBook 开启时才显示 `Prompt suggestions`；用户打开时把持久字段写回 `undefined`，关闭时写 `false`，用缺省值表达默认开启。

### 生成之前先判断是否值得花这次模型调用

`handleStopHooks()` 在非 bare 模式下 fire-and-forget 调用 `executePromptSuggestion()`。真正生成前，`tryGenerateSuggestion()` 还会检查会话成熟度、上一条响应、缓存成本与 AppState，

```ts
export function getSuggestionSuppressReason(
  appState: AppState,
): string | null {
  if (!appState.promptSuggestionEnabled) return 'disabled'
  if (appState.pendingWorkerRequest || appState.pendingSandboxRequest)
    return 'pending_permission'
  if (appState.elicitation.queue.length > 0) return 'elicitation_active'
  if (appState.toolPermissionContext.mode === 'plan') return 'plan_mode'
  if (process.env.USER_TYPE === 'external' &&
      currentLimits.status !== 'allowed') return 'rate_limit'
  return null
}
```

> 证据，`restored-src/src/services/promptSuggestions/`（2.1.88 source map 还原源码），`getSuggestionSuppressReason()`。`appState` 是当前状态快照。返回字符串时，调用方记录该 suppress reason 并跳过模型调用；返回 `null` 时继续执行会话成熟度、缓存成本和生成步骤。`pendingWorkerRequest` 与 `pendingSandboxRequest` 任一个为对象时归为 `'pending_permission'`，两者都为 `null` 才通过；elicitation 队列非空、权限模式精确为 `'plan'`、外部用户当前限额状态处于 `'allowed'` 之外也会分别阻止。

除此之外，assistant 消息少于 2 条会记为 `early_conversation`；上一条 assistant 是 API 错误会停止；父请求最新 usage 的 `input_tokens + cache_creation_input_tokens + output_tokens` 超过 10,000，会以 `cache_cold` 停止。这个阈值只约束该 fork 的未缓存成本，和会话总 token、模型窗口上限分别统计。

### 生成参数保持父请求的 cache key

建议生成调用 `runForkedAgent()`，却刻意不传 `tools: []`，也不改 effort 或输出 token 参数。源码注释说明，这些改变会破坏与父请求共享的缓存键。它改用客户端 `canUseTool` 拒绝工具，并且不写 transcript、不增加新的 cache write 标记，

```ts
const canUseTool = async () => ({
  behavior: 'deny' as const,
  message: 'No tools needed for suggestion',
  decisionReason: { type: 'other' as const, reason: 'suggestion only' },
})

const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: prompt })],
  cacheSafeParams,
  canUseTool,
  querySource: 'prompt_suggestion',
  forkLabel: 'prompt_suggestion',
  overrides: { abortController },
  skipTranscript: true,
  skipCacheWrite: true,
})
```

> 证据，`restored-src/src/services/promptSuggestions/`（2.1.88 source map 还原源码）。`promptMessages` 只放一条由建议 prompt 构造的 user message；`cacheSafeParams` 由父回合上下文生成，用于保持服务端 cache-key 相关参数一致，它并不保存建议文本。`canUseTool` 返回固定对象，`behavior: 'deny'` 阻止执行，`message` 形成工具拒绝文本，`decisionReason.type/reason` 为诊断保留结构化原因。`overrides` 只覆盖 `abortController`，让建议旁路继承本轮取消信号而不改其他 agent 参数；`querySource` 与 `forkLabel` 固定标识建议旁路；`skipTranscript: true` 跳过会话记录，`skipCacheWrite: true` 跳过新的 cache write 标记。

模型仍可能先尝试工具、被拒绝后再输出文本，所以代码遍历 fork 返回的所有 assistant 消息，取第一个非空 text block。第一条 assistant 的 `requestId` 还会保存为 `generationRequestId`，用于后续统计关联；request ID 缺失时存为 `null`。

文本回来后先经过确定性过滤。过滤器拒绝 `done`、空建议元文本、括号包裹的推理、API 错误、`label: value` 前缀、超过 12 词、长度达到 100、多个句子、Markdown、评价性表达与 Claude 口吻。单词建议通常被拒绝，但 slash command 和 `yes`、`push`、`commit`、`deploy`、`stop`、`continue` 等白名单值可以通过。

### 候选只保存在临时 AppState

通过过滤的结果写入 AppState，文本与 prompt variant 一起保存，`shownAt`、`acceptedAt` 初始化为 0。候选只存在当前进程的临时状态，会话恢复链不读取它。

```ts
promptSuggestion: {
  text: result.suggestion,
  promptId: result.promptId,
  shownAt: 0,
  acceptedAt: 0,
  generationRequestId: result.generationRequestId,
}

const suggestion =
  isAssistantResponding || inputValue.length > 0
    ? null
    : suggestionText
```

> 证据，`restored-src/src/state/AppStateStore.ts` 与 promptSuggestions 消费端（2.1.88 source map 还原源码）。`promptSuggestion` 是 AppState 中承载整份临时候选的字段；`text` 为字符串时提供 ghost text，为 `null` 时展示层跳过候选；`promptId` 与 `generationRequestId` 有值时关联父 prompt 和生成请求，为 `null` 时对应遥测字段保持空值，但候选仍可展示。当前 `PromptVariant` 类型包含 `'user_intent' | 'stated_intent'`，而 `getPromptVariant()` 在 2.1.88 固定返回 `'user_intent'`。`shownAt` 和 `acceptedAt` 是毫秒时间戳，0 表示待展示/待接受。`inputValue` 非空或主 Agent 正在响应时，三元表达式返回 `null` 并隐藏候选；两者都满足展示条件时才返回 `suggestionText`。

PromptInput 还要求当前处于 prompt mode、普通 typeahead 候选为空、teammate 任务视图关闭。满足后才把 `shownAt` 改为 `Date.now()`，并把 suggestion 当作输入框 placeholder。若候选已生成，却因为用户已经开始输入等时序原因无法展示，代码记录 `timing` suppression 并清空状态。

AppState 里的候选要等 `shownAt > 0` 才算完成展示。这个时间戳随后用于判断接受、忽略和停留时间。

### Tab、Enter 与继续打字，对应三条结果

建议显示后有三种主要去向。

1. Tab 接受，typeahead 路径把 ghost text 放入输入，并记录 `acceptedAt`。
2. 空输入框按 Enter，或提交内容与候选完全相等，PromptInput 把候选作为真正输入提交；如果 speculative execution 已开始，还会接管已经流出的推测结果。
3. 用户输入其他内容并提交，结果记为 `'ignored'`，然后清空 suggestion。

核心判断在 `usePromptSuggestion()`，

```ts
const tabWasPressed = acceptedAt > shownAt
const wasAccepted =
  tabWasPressed || finalInput === suggestionText

logEvent('tengu_prompt_suggestion', {
  outcome: wasAccepted ? 'accepted' : 'ignored',
  ...(wasAccepted && {
    acceptMethod: tabWasPressed ? 'tab' : 'enter',
  }),
})

if (!opts?.skipReset) resetSuggestion()
```

> 证据，`restored-src/src/hooks/usePromptSuggestion.ts`（2.1.88 source map 还原源码），`logOutcomeAtSubmission(finalInput, opts?)`。`finalInput` 是用户最终提交的开放字符串。`tabWasPressed` 由 `acceptedAt > shownAt` 判定，`wasAccepted` 还接受最终输入与候选完全相等；`outcome` 因而只有 `'accepted'` 或 `'ignored'`，`acceptMethod` 只在接受时写入 `'tab'` 或 `'enter'`。`opts.skipReset` 省略或为 `false` 时调用 `resetSuggestion()`，为 `true` 时让 speculative execution 暂时保留状态。继续输入并提交构成 ignored 语义。

这里也有隐私边界。通用事件会上报 outcome、prompt id、用时、焦点状态和长度相似度；只有 `USER_TYPE === 'ant'` 的分支才额外附带 suggestion 与 userInput 原文。

### 取消、失败与不可见结果

两套能力都被设计成旁路失败，不阻断主回答，但失败方式不同。

MagicDocs 重新读取时，如果文件不存在、EACCES/EPERM，或内容已不再匹配 Magic Doc 标题，就从 Map 删除路径并返回。其他异常会向 post-sampling hook 冒泡，由统一执行器记录错误后继续，不会让 queryLoop 因文档维护失败而失败。自定义提示词读取失败静默回退默认模板。

Prompt Suggestions 使用模块级 `currentAbortController`。新生成开始后可以由 `abortPromptSuggestion()` 取消；`AbortError` 和 `APIUserAbortError` 记为 aborted 并静默返回，其他错误只写日志。空输出、过滤命中、过早会话、API 错误、缓存过冷、权限等待、elicitation、plan mode、rate limit 和展示时序都可能产生空候选；源码把静默结束定义为合法终态。

还要注意 fire-and-forget 的时序，`handleStopHooks()` 用 `void executePromptSuggestion(...)` 启动建议生成，主回合不等待它；MagicDocs 由 post-sampling hook 执行器 `await`，但 hook 自己处在主采样之后。

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。**MISSING** 表示实现不在 source map 中。

| 阶段 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| 声明 | `MAGIC_DOC_HEADER_PATTERN` / `detectMagicDocHeader()` | `src/services/MagicDocs/magicDocs.ts` | 已确认 |
| 跟踪 | `registerMagicDoc()` / `initMagicDocs()`（`USER_TYPE === 'ant'`） | `src/services/MagicDocs/magicDocs.ts` | 已确认 |
| 空闲判断 | `updateMagicDocs`（`repl_main_thread` + 自然收尾 + 串行） | `src/services/MagicDocs/magicDocs.ts` | 已确认 |
| 读取 | `cloneFileStateCache()` + `FileReadTool.call()` 绕过 `file_unchanged` | `src/services/MagicDocs/magicDocs.ts` | 已确认 |
| 提示词 | `buildMagicDocsUpdatePrompt()` 四变量 / 自定义模板回退 | `src/services/MagicDocs/magicDocs.ts` | 已确认 |
| 权限 | `getMagicDocsAgent()`（sonnet、仅 Edit）+ 精确路径 `canUseTool` | `src/services/MagicDocs/magicDocs.ts` | 已确认 |
| 启用 | `shouldEnablePromptSuggestion()` / `tengu_chomp_inflection` | `src/services/promptSuggestions/` | 已确认 |
| 抑制 | `getSuggestionSuppressReason()` / `cache_cold` 10,000 上限 | `src/services/promptSuggestions/` | 已确认 |
| 生成 | `runForkedAgent()`（保持 cache key、`skipCacheWrite`、deny 工具） | `src/services/promptSuggestions/` | 已确认 |
| 展示 | `promptSuggestion` AppState / `shownAt > 0` 才算展示 | `src/state/AppStateStore.ts` | 已确认 |
| 结果 | `logOutcomeAtSubmission()`（tab / enter / ignored） | `src/hooks/usePromptSuggestion.ts` | 已确认 |

## 设计决策

**第一，为什么 MagicDocs 用「文件头声明 + Read 监听」而不是目录扫描？** 目录扫描会覆盖仓库里所有 Markdown，包括用户不想被改写的；文件头声明把 opt-in 放进文档本身（「这份文档可以被维护」），Read 监听又要求它真的被模型读过。跟踪集合因此只包含「用户声明 + 实际进入过上下文」的交集，其余文件不受影响。

**第二，为什么更新必须等主 REPL 自然收尾？** 如果工具调用还没结束就抢写文件，文档内容会建立在半途状态上；`hasToolCallsInLastAssistantTurn(messages)` 为真就推迟，「空闲」是模型回合意义上的窄判断。`sequential()` 保证多个文档逐个更新，不并发编辑同一批文件。

**第三，为什么建议 fork 不能传 `tools: []`？** 表面上更干净，但改变 tools 参数会破坏与父请求共享的缓存键，服务端缓存按请求前缀精确匹配，任何一层的参数变化都会让整个前缀失效。源码因此用客户端 `canUseTool` 拒绝工具、`skipTranscript` + `skipCacheWrite` 不产生旁路副作用，让建议调用在「与主请求共享缓存」的前提下完成。

**第四，为什么候选只存在于 AppState？** 建议是「用户大概率正准备输入什么」的瞬时猜测，进入 transcript 或恢复链就会变成对话事实。`shownAt` / `acceptedAt` 把展示、接受、忽略变成可观测时间戳；Tab、Enter 与继续打字给出三条明确去向，静默结束是合法终态。

## 练习

1. **写一个 MagicDoc 声明文件。** 在一个支持该路径的构建里，创建带 `# MAGIC DOC:` 标题和斜体说明的 Markdown，主动 `Read` 它，观察其进入跟踪集合；再验证，不 Read 的文件不会被维护，标题被移除后跟踪被删除。

2. **观察建议的展示时序。** 开启 Prompt Suggestions 后，在对话末尾观察 ghost text 出现条件（prompt mode、无 typeahead 候选、teammate 视图关闭）；分别用 Tab、空输入 Enter、输入其他内容提交，对照 `tengu_prompt_suggestion` 事件里 `outcome` 与 `acceptMethod` 的值。

3. **对照两条旁路的失败语义。** 分别制造 MagicDocs 读取失败（删除文件、改权限）与 Prompt Suggestions 取消（新生成开始后 abort），确认前者不阻断主回答、后者静默结束；再检查 suppress reason 列表里 `pending_permission`、`plan_mode`、`cache_cold` 各自在什么状态下出现。

## 自测

1. MagicDocs 的 opt-in 机制是什么？为什么必须「被 Read 过」？
2. 为什么建议 fork 不传 `tools: []`，而是用 `canUseTool` 拒绝？
3. `shownAt` 与 `acceptedAt` 各自记录什么？三种提交去向是什么？

<details>
<summary>参考答案</summary>

1. **文件头声明 + Read 监听。** `detectMagicDocHeader()` 用 `# MAGIC DOC: <title>` 识别 opt-in 文件，`registerFileReadListener` 只在文件真的被 `FileReadTool` 读过且标题匹配时把路径登记进 `trackedMagicDocs`。这样未被声明的 Markdown 不会被改写，未被读过的文件也不会进入跟踪集合；2.1.88 里整条链路只在 `USER_TYPE === 'ant'` 初始化。

2. **保持父请求的 cache key。** 注释明确说明 `tools: []` 等参数变化会破坏与父请求共享的缓存键；服务端缓存按前缀精确匹配，参数变了前缀就失效。改用客户端 `canUseTool` 拒绝工具（`behavior: 'deny'`），再加 `skipTranscript: true`、`skipCacheWrite: true`，让建议调用既不能执行工具，也不污染主请求的缓存与 transcript。

3. **`shownAt` 记录候选真正展示（`Date.now()`，0 表示待展示），`acceptedAt` 记录被接受的时间。** 三种去向，Tab 接受（typeahead 把 ghost text 放入输入并记 `acceptedAt`）；空输入 Enter 或提交内容与候选完全相等（候选作为真正输入提交，必要时接管 speculative 结果）；用户输入其他内容提交（记 `'ignored'` 并清空 suggestion）。判定用 `acceptedAt > shownAt` 区分 tab 与 enter。

</details>

## 回顾｜本章的两条回合后旁路

<details>
<summary>展开查看回顾</summary>

MagicDocs 与 Prompt Suggestions 都复用了 Claude Code 已有的会话上下文和 Agent 执行能力，但它们刻意选择了不同的落点。

MagicDocs 通过特殊文件头和 `Read` 监听建立进程内跟踪，在主 REPL 自然收尾时重新读取当前文档，把父会话、系统上下文和文档指令交给 Sonnet fork。内部权限回调自动允许当前精确路径上的 `Edit`，其余行为直接 deny；文件消失、不可读或移除标题后就停止跟踪。2.1.88 里它只在 `USER_TYPE === 'ant'` 初始化，这是一条关键产品边界。

Prompt Suggestions 在停止阶段预测用户下一句，先经过功能门与运行时 suppress guards，再用父请求的 cache-safe 参数启动禁用工具、跳过 transcript 的 fork。通过确定性过滤的短文本只存在 AppState，在输入框真正可展示后才记录 `shownAt`。Tab 或 Enter 把候选变成普通输入，其他提交记为 ignored；取消、过滤和失败都可以安静结束。

每次旁路生成都要回答四个问题，它读哪些上下文，能产生什么副作用，谁负责确认，失败是否影响主路径。MagicDocs 和 Prompt Suggestions 给出了两套不同但都很克制的答案。

</details>

## 留给下一篇的问题

MagicDocs 的最佳实践是什么？

## 相关链接

- **上一篇**，[45 语音如何接入终端 Agent](./45-voice-interaction.md)，WSL Voice 的分层故障定位
- **下一篇**，[47 非核心反馈通道如何协作](./47-notifications-mailbox-and-output-styles.md)，回答 MagicDocs 最佳实践
- **平行阅读**，[22 提示词如何变成 Skill](./22-skill-system.md)，旁路能力与可复用分发单元的关系
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
- [Dive into Claude Code，生产级 Agent 的设计空间](https://arxiv.org/abs/2604.14228)
- [Voice dictation - Claude Code Docs](https://code.claude.com/docs/en/voice-dictation)
- [Claude Code Voice Mode，Windows 11 + WSL2 实测配置](https://www.cursosdesarrolloweb.es/blog/claude-code-voice-mode-programa-con-voz-terminal)
- [Fix， Claude Code /voice not working on WSL2 (Windows)](https://www.reddit.com/r/ClaudeCode/comments/1rs2784/fix_claude_code_voice_not_working_on_wsl2_windows/)
- [VoiceMode，WSL2 的 PulseAudio 依赖与 MCP 替代方案](https://github.com/mbailey/voicemode)
