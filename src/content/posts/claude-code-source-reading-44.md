---
title: "Claude Code源码解读44：陪伴式体验如何叠加在 Agent 之上"
published: 2026-07-24T16:47:31+08:00
updated: 2026-07-24T16:47:31+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-44/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

主动助手能够推进任务以后，Buddy 如何把这些能力包装成更连续的陪伴式体验，并管理状态、建议与反馈？

先说答案：**Buddy 没有把主动助手改造成一个更拟人的 Agent，而是在普通 REPL 外面叠了三层很薄的产品能力。**

第一层是持久化身份。它在全局配置里保存名字、性格和孵化时间，再根据用户 ID 稳定地产生物种、稀有度、眼睛、帽子和属性。第二层是回合后的反馈。主查询完成以后，REPL 把消息交给一个 companion observer；observer 返回一句 reaction，AppState 只保存这句临时文本。第三层是终端表现。`CompanionSprite` 把 reaction、抚摸时间和终端宽度翻译成动画、气泡、焦点与布局。

这三层都没有取得工具权限。Buddy 不选择工具，不插进 `queryLoop()`，也不接管上一章的主动任务调度。它与主 Agent 的唯一提示词联系，是一条 `companion_intro` attachment：告诉 Claude 输入框旁边坐着一个独立 watcher，当用户直接叫它名字时，主 Agent 应少说一句，把空间让给气泡。

因此，“连续陪伴”不是另一套智能体运行时，而是一个稳定身份，加上一条回合后观察链，再加一个长期挂在输入框旁边的 UI。建议也要分清：源码里可见的建议是首次发现 `/buddy` 的通知与输入高亮；reaction 是对已完成回合的反馈。。

本篇仍只讨论仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码。下面的片段省略了与当前机制无关的类型和渲染分支；函数名、关键取值与调用顺序保持不变。

## Buddy 不是小号 Agent，而是观察器加 UI

先建立一个够用的基础模型。

Agent 是能够拿到上下文、请求模型、选择工具并继续循环的执行主体；observer 则只观察已经发生的消息，把观察结果变成一个更小的输出。React/Ink 组件再订阅状态，把这个输出画到终端。Buddy 处在后两层，不在第一层。

这一区分直接决定了安全边界。如果 Buddy 是独立 Agent，就需要模型、工具池、权限上下文、取消与会话历史；如果它只是 observer 和 UI，最重要的输入输出就变成“观察哪些消息”“写入哪个状态”“展示多久”。2.1.88 的可见调用链属于后者：

`query() 完成 → fireCompanionObserver(messages) → companionReaction → CompanionSprite`

![Buddy 从稳定身份到回合反馈的手绘流程图](/images/posts/claude-code-source-reading-44/44-buddy-experience-handdrawn.png)

图中实线是还原源码能够确认的调用或状态流；observer 内部使用什么提示词、模型与失败策略，因为对应实现没有出现在还原目录中，只能保留为黑盒。这个缺口很重要，后文不会拿函数名补写不存在的实现细节。

## 一个 Buddy 由“灵魂”和“骨架”组成

Buddy 的身份没有被整个对象原样写进配置。`restored-src/src/buddy/types.ts` 把它拆成两部分：`CompanionSoul` 是模型生成并持久化的名字和性格，`CompanionBones` 是根据用户 ID 重新计算的外形与数值。

```ts
export type CompanionBones = {
  rarity: Rarity
  species: Species
  eye: Eye
  hat: Hat
  shiny: boolean
  stats: Record<StatName, number>
}

export type CompanionSoul = {
  name: string
  personality: string
}

export type Companion = CompanionBones &
  CompanionSoul & {
    hatchedAt: number
  }

export type StoredCompanion = CompanionSoul & { hatchedAt: number }
```

**类型说明：** `CompanionBones` 描述可重复生成的外形；`rarity` 可取 `common`、`uncommon`、`rare`、`epic`、`legendary`，`species` 在源码列出的 18 种物种中选择，`eye` 有 `·`、`✦`、`×`、`◉`、`@`、`°` 六种，`hat` 可取 `none`、`crown`、`tophat`、`propeller`、`halo`、`wizard`、`beanie`、`tinyduck`，`shiny` 只有 `true` / `false`，`stats` 固定包含 `DEBUGGING`、`PATIENCE`、`CHAOS`、`WISDOM`、`SNARK`。`StoredCompanion` 只持久化 soul 与 `hatchedAt` 数字，不保存 bones。

读取时，`restored-src/src/buddy/companion.ts` 的 `getCompanion()` 重新 roll 一次 bones，并让重新计算的字段覆盖配置中可能残留的旧字段：

```ts
export function companionUserId(): string {
  const config = getGlobalConfig()
  return config.oauthAccount?.accountUuid ?? config.userID ?? 'anon'
}

export function getCompanion(): Companion | undefined {
  const stored = getGlobalConfig().companion
  if (!stored) return undefined
  const { bones } = roll(companionUserId())
  return { ...stored, ...bones }
}
```

**函数说明：** `companionUserId()` 没有参数，优先使用 OAuth 的 `accountUuid`，其次使用全局 `userID`，两者都是 `undefined` 或空缺时回退到固定字符串 `'anon'`。`getCompanion()` 同样没有参数；配置里的 `companion` 为 `undefined` 时返回 `undefined`，表示尚无 Buddy。存在时，展开顺序是 `stored` 在前、`bones` 在后，所以旧配置即使含有 `species`、`rarity` 等字段，也会被当前确定性结果覆盖。

`roll()` 的种子是 `userId + SALT`，结果还会按这个 key 缓存。稀有度权重分别是 60、25、10、4、1，`shiny` 的判断是 `rng() < 0.01`。这里的“随机”因此不是每次启动重新抽卡，而是同一个用户 ID 在同一份源码规则下得到稳定结果。

这种拆分解决了两个产品问题。名字和性格需要连续存在，所以进入配置；外形规则可能随版本调整，也不希望用户只改配置就伪造稀有度，所以每次读取重新生成。

## 生命周期从功能开关与一次 `/buddy` 发现开始

Buddy 不是所有构建都天然存在。`restored-src/src/commands.ts` 先经过 `feature('BUDDY')` 决定是否加载 `/buddy`，注册表也只在模块存在时追加命令：

```ts
const buddy = feature('BUDDY')
  ? (
      require('./commands/buddy/index.js') as typeof import(
        './commands/buddy/index.js'
      )
    ).default
  : null

const COMMANDS = memoize((): Command[] => [
  // 省略其他命令
  ...(buddy ? [buddy] : []),
])
```

**参数与取值说明：** `feature('BUDDY')` 接收编译期功能名 `'BUDDY'`，结果只有 `true` / `false`。为 `true` 时动态加载命令模块，为 `false` 时得到 `null`；数组展开也因此分别追加一个命令或追加空数组。这不是用户在当前会话中切换的普通布尔配置，而是构建裁剪边界。

`restored-src/src/buddy/useBuddyNotification.tsx` 还给首次发现设置了时间窗。外部构建的 teaser 只在本地日期 2026 年 4 月 1 日至 7 日出现，`isBuddyLive()` 则从 2026 年 4 月开始返回 `true`；内部构建分支直接返回 `true`。通知 hook 还要求当前没有 `config.companion`，才显示 15 秒的彩色 `/buddy`。

```tsx
export function useBuddyNotification() {
  const { addNotification, removeNotification } = useNotifications()

  useEffect(() => {
    if (!feature('BUDDY')) return
    const config = getGlobalConfig()
    if (config.companion || !isBuddyTeaserWindow()) return

    addNotification({
      key: 'buddy-teaser',
      jsx: <RainbowText text="/buddy" />,
      priority: 'immediate',
      timeoutMs: 15000,
    })
    return () => removeNotification('buddy-teaser')
  }, [addNotification, removeNotification])
}
```

**函数说明：** `useBuddyNotification()` 没有显式参数，依赖通知 context。`key` 固定为 `'buddy-teaser'`，用于添加与清理同一条通知；`priority` 固定为 `'immediate'`，`timeoutMs` 为 15000 毫秒。`config.companion` 存在或不在 teaser 时间窗时直接返回，不注册清理函数；只有确实添加通知后，effect 才返回移除回调。

这就是 Buddy 的“建议”入口：建议用户发现 `/buddy`，并在输入中用正则 `/\/buddy\b/g` 找出命令位置做彩虹高亮。它没有根据项目状态建议下一项编码任务，也没有调用主动助手的调度器。

需要明确一个证据缺口：`commands.ts` 引用了 `commands/buddy/index.js`，AppState 也注明 `companionPetAt` 来自 `/buddy pet`，但本仓库的还原目录没有对应命令源码。我们能确认命令注册、持久化字段、抚摸动画的消费端；不能从这些片段还原孵化时如何生成 soul、有哪些完整子命令、失败时怎样提示。把 UI 结果反推成命令实现，会越过 source map 证据边界。

## 主 Agent 只收到一次“它坐在旁边”的说明

Buddy 与主消息链确实有连接，但连接非常克制。`restored-src/src/utils/attachments.ts` 的 `getAttachments()` 会调用 `restored-src/src/buddy/prompt.ts`，尝试加入 `companion_intro`；同名 Buddy 已经在历史 attachment 中出现过时，不再重复注入。`restored-src/src/utils/messages.ts` 再把它转换成 meta user message。

```ts
export function getCompanionIntroAttachment(
  messages: Message[] | undefined,
): Attachment[] {
  if (!feature('BUDDY')) return []
  const companion = getCompanion()
  if (!companion || getGlobalConfig().companionMuted) return []

  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment.type !== 'companion_intro') continue
    if (msg.attachment.name === companion.name) return []
  }

  return [{
    type: 'companion_intro',
    name: companion.name,
    species: companion.species,
  }]
}
```

**函数与参数说明：** `messages` 是 `Message[] | undefined`；`undefined` 通过 `messages ?? []` 当作空历史处理。功能关闭、没有 companion、`companionMuted` 为真，或历史中已有相同名字的 `companion_intro` 时都返回空数组。其余情况只返回一个 attachment，字段 `name` 与 `species` 来自当前 companion；它们不是调用方随意传入的候选值。

attachment 随后被转换成 meta user message。提示文本明确告诉主 Agent：输入框旁边是“separate watcher”，Claude 不是它；当用户直接叫 Buddy 名字时，主 Agent 最多回应一行，不解释、不替 Buddy 编台词。

这不是给 Buddy 授权，而是在管理两个角色抢话的问题。主 Agent 仍按普通消息流程运行，Buddy 的气泡则在回合结束后另行产生。提示只约束 Claude 如何让出表达空间，并没有新增 Tool、`canUseTool` 或 permission context。

## 回合结束后，observer 才写入临时反馈

`restored-src/src/screens/REPL.tsx` 等 `query()` 的异步事件流完全结束以后，才触发 companion observer：

```ts
for await (const event of query({
  messages: messagesIncludingNewMessages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool,
  toolUseContext,
  querySource: getQuerySourceForREPL(),
})) {
  onQueryEvent(event)
}

if (feature('BUDDY')) {
  void fireCompanionObserver(
    messagesRef.current,
    reaction => setAppState(prev =>
      prev.companionReaction === reaction
        ? prev
        : { ...prev, companionReaction: reaction },
    ),
  )
}
```

**函数与参数说明：** `query()` 接收本轮消息、system/user context、权限回调、工具上下文和来源，片段保留的是与时序有关的字段；事件逐个交给 `onQueryEvent()` 后，循环终止才进入 Buddy 分支。`fireCompanionObserver()` 的第一个参数是 `messagesRef.current`，即调用时最新消息数组；第二个参数是 reaction 回调。调用前的 `void` 表示 REPL 不等待它完成。回调收到的 `reaction` 在可见调用处作为字符串状态使用；新值与旧值严格相等时返回原 AppState，避免无意义更新，否则只覆盖 `companionReaction`。

这条顺序说明 Buddy 的反馈不会阻塞主答案，也不会在工具执行到一半时改变控制流。它更像回合后的旁观评论，而不是 Agent 循环里的 observation。observer 异步失败是否重试、是否吞错、怎样裁剪消息，在缺失的实现文件中都无法验证；文章不能因为调用名里有 observer，就臆造它做了情绪识别或质量打分。

它与主动能力的关系也在这里分开了。REPL 顶部把 `proactiveModule` 作为另一条条件模块加载，主动模式会影响工具集合、后台建议和 `terminalFocus` context；Buddy 的可见路径只在 query 结束后读取消息并写 reaction。两者可以同时出现在同一个 REPL，但源码没有显示 Buddy 调用 proactive 调度器，也没有显示 reaction 会被回填成下一轮任务。

## AppState 只保存两项短期状态

Buddy 没有把整套对象塞进 React store。持久身份在 `restored-src/src/utils/config.ts` 的 `GlobalConfig.companion`，UI 的短期变化才进入 `restored-src/src/state/AppStateStore.ts` 的 AppState：

```ts
// Latest companion reaction from the friend observer (src/buddy/observer.ts)
companionReaction?: string
// Timestamp of last /buddy pet — CompanionSprite renders hearts while recent
companionPetAt?: number
```

**字段说明：** `companionReaction` 是 `string | undefined`；字符串表示当前有气泡内容，`undefined` 表示没有正在展示的反馈。`companionPetAt` 是 `number | undefined`；数字表示最近一次抚摸的时间戳，`undefined` 表示尚未记录。二者都没有在类型上接受 `null`，也没有在这里定义默认文案或默认时间。

这是一种很实用的分层：名字、性格、孵化时间需要跨进程保留，放进 GlobalConfig；气泡和心形动画只是眼前这一段 UI 生命周期，放进 AppState。这样 observer 不必重写整个 companion，动画 tick 也不会持续写磁盘。

## 500 毫秒一个 tick，把状态翻译成动画

`restored-src/src/buddy/CompanionSprite.tsx` 的 `CompanionSprite()` 每 500 毫秒增加一次本地 tick。reaction 出现时记录发言 tick，并启动清理定时器；20 个 tick 后把 `companionReaction` 清成 `undefined`。最后 6 个 tick，也就是约 3 秒，气泡改成 inactive 色。

```tsx
const TICK_MS = 500
const BUBBLE_SHOW = 20
const FADE_WINDOW = 6
const PET_BURST_MS = 2500

useEffect(() => {
  const timer = setInterval(() => setTick(t => t + 1), TICK_MS)
  return () => clearInterval(timer)
}, [])

useEffect(() => {
  if (!reaction) return
  lastSpokeTick.current = tick
  const timer = setTimeout(() => {
    setAppState(prev =>
      prev.companionReaction === undefined
        ? prev
        : { ...prev, companionReaction: undefined },
    )
  }, BUBBLE_SHOW * TICK_MS)
  return () => clearTimeout(timer)
}, [reaction, setAppState])
```

**参数与取值说明：** `TICK_MS` 固定为 500 毫秒；`BUBBLE_SHOW * TICK_MS` 得到约 10 秒展示时间，`FADE_WINDOW * TICK_MS` 对应末尾约 3 秒淡出，`PET_BURST_MS` 为 2500 毫秒。第一个 effect 的依赖数组为空，只在组件挂载与卸载时建立、清理 interval；第二个 effect 依赖 `reaction` 与 `setAppState`，reaction 为空字符串或 `undefined` 时都提前返回，变化时重建 timeout。清理状态前再次检查是否已经是 `undefined`，避免无变化的 store 写入。

`companionPetAt` 则被换算成 `petAge`。时间仍在 2500 毫秒以内时，宽屏 sprite 在五帧心形之间切换，窄屏显示一个心形。没有 reaction、也没有 petting 时，它按固定的 `IDLE_SEQUENCE` 休息、轻微动作或眨眼。这里的“情绪”完全是 UI 状态机，不应解读成模型内部真的有情绪。

还有一个容易忽略的反馈清理：全屏模式下，用户向上滚动 transcript 会立即把 `companionReaction` 清空。因为气泡浮在右下角，滚动意味着用户想看被它覆盖的内容。陪伴层可以存在，但不能挡住主任务信息。

## 宽屏、窄屏与全屏是三种布局，不是三套状态

终端 UI 没有固定画布。源码用 100 列作为完整 sprite 的门槛：低于 100 列时折叠成“脸 + 名字/短句”的单行形态，reaction 超过 24 个字符就截成 23 个字符加省略号。达到 100 列后，sprite 至少占 12 列；非全屏正在说话时，再为 36 列气泡预留空间。

```ts
export function companionReservedColumns(
  terminalColumns: number,
  speaking: boolean,
): number {
  if (!feature('BUDDY')) return 0
  const companion = getCompanion()
  if (!companion || getGlobalConfig().companionMuted) return 0
  if (terminalColumns < MIN_COLS_FOR_FULL_SPRITE) return 0

  const nameWidth = stringWidth(companion.name)
  const bubble = speaking && !isFullscreenActive() ? BUBBLE_WIDTH : 0
  return spriteColWidth(nameWidth) + SPRITE_PADDING_X + bubble
}
```

**函数与参数说明：** `terminalColumns` 是终端列数，开放数字输入；小于 `MIN_COLS_FOR_FULL_SPRITE` 的 100 时返回 0，因为窄屏由 REPL 另起一行。`speaking` 是布尔值，只有 `true` 且当前不是全屏时才增加 `BUBBLE_WIDTH` 的 36 列。功能关闭、companion 为 `undefined`、或 `companionMuted` 为真也都返回 0。最终宽度取名字显示宽度与 12 列 sprite body 的较大者，再加左右 padding；源码没有为负列数单独设计业务分支，正常值来自终端尺寸 hook。

全屏时，气泡不和输入框抢宽度，而是通过 `FullscreenLayout.bottomFloat` 浮到 scrollback 之上；非全屏无法可靠清掉 Static scrollback 里的浮层，所以气泡与 sprite 内联，输入区域相应收窄。这里复用的是同一个 `companionReaction`，差别只在 renderer 的布局策略。

Footer 也把 companion 当成普通可导航项。只有全局配置已有 companion 且没有 muted 时，`footerItems` 才包含 `'companion'`；焦点移动到它以后按 Enter，PromptInput 提交 `/buddy`。这说明 Buddy 的交互仍然复用普通命令输入通道，并没有绕开命令系统创建隐形按钮权限。

## 开关、静音和失败边界必须分开看

Buddy 至少有三道不同的门：

1. `feature('BUDDY')` 是构建级功能门。关闭时命令、attachment、observer 调用和组件渲染都被条件分支挡住，部分模块还会被 dead-code elimination 裁掉。
2. `config.companion` 是身份存在门。它为 `undefined` 时 `getCompanion()` 返回 `undefined`，UI 不渲染，启动阶段才可能显示 `/buddy` teaser。
3. `companionMuted` 是用户表现门。为真时 sprite、气泡与 intro attachment 都不出现；类型是可选布尔值，`undefined` 与 `false` 在这些真假判断中都会被当成“没有静音”。

它们不能互相替代。静音不会证明持久身份已删除，功能构建关闭也不等于配置文件中没有旧 companion。

失败路径还有四个静默边界。observer 是 `void` 异步调用，主回合不等待它；reaction 没有出现时 UI 仍保持 idle；窄终端会主动降低信息量；滚动、10 秒 timeout 或组件卸载会清理气泡和 timer。最关键的是，`commands/buddy` 与 `buddy/observer.ts` 的实现未出现在本仓库还原文件中。

这也解释了 Buddy 为什么没有改变安全模型：在能够确认的代码里，它没有 `ToolUseContext`、`canUseTool`、permission mode，也没有自己的 query loop。它消费消息和配置，写一个临时字符串，再把字符串画出来。

## 小结

Buddy 把陪伴感拆成了三个可控层次：GlobalConfig 保存稳定的 soul，用户 ID 确定性生成 bones；回合结束后的 observer 把消息压成一句 reaction；React/Ink 再用 AppState、定时器和终端宽度把 reaction 画成 sprite 与气泡。

这套实现最值得借鉴的不是拟人化文案，而是边界。Buddy 与主 Agent 共享同一块屏幕，却不共享工具权限；它给主消息链注入一次角色说明，却不接管 query loop；它能用通知建议用户发现功能，也能在任务结束后给反馈，但不把这些反馈伪装成主动任务调度。

源码能够确认持久字段、确定性外形、attachment、回合后触发、UI 状态和各层开关；无法确认缺失 command/observer 内部的生成、重试和线上启用效果。把这条证据线守住，Buddy 才是一层可以解释、可以关闭、失败时不影响主任务的产品体验，而不是一个被想象出来的第二人格。

## 留给下一篇的问题

陪伴式体验建立以后，Claude Code 如何接入语音输入、转写、按键与音频状态，并把语音重新送回普通消息流程？

