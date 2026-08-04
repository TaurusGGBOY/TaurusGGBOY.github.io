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

先看它没有做什么：Buddy 不选择工具，也不进入 `queryLoop()`；它只在普通 REPL 外叠加持久身份、回合反馈和终端表现三层产品能力。这样陪伴感不会变成另一条执行链。

第一层是持久化身份。它在全局配置里保存名字、性格和孵化时间，再根据用户 ID 稳定地产生物种、稀有度、眼睛、帽子和属性。第二层是回合后的反馈。主查询完成以后，REPL 把消息交给一个 companion observer；observer 返回一句 reaction，AppState 只保存这句临时文本。第三层是终端表现。`CompanionSprite` 把 reaction、抚摸时间和终端宽度翻译成动画、气泡、焦点与布局。

这三层都停留在体验层。Buddy 只观察回合结果并更新 UI，不选择工具、不进入 `queryLoop()`，也不接管上一章的主动任务调度。它与主 Agent 的唯一提示词联系是一条 `companion_intro` attachment：告诉 Claude 输入框旁边坐着独立 watcher，当用户直接叫它名字时，主 Agent 应少说一句，把空间让给气泡。

因此，“连续陪伴”来自一个稳定身份、一条回合后观察链，以及长期挂在输入框旁边的 UI。源码里可见的建议是首次发现 `/buddy` 的通知与输入高亮；reaction 则反馈已经完成的回合。

下面只沿可见调用链读这层体验：回合结束后谁写入 reaction、AppState 保存什么，以及终端布局怎样消费它。缺失的 observer/command 实现不做推断。

## 本章先建立三个概念

- **观察器叠加层**：Buddy 读取主 Agent 的阶段与结果，生成界面反馈，同时保持执行决策链独立。

- **确定性身份**：用户标识与固定盐派生物种、外观和性格，使同一用户获得稳定角色。

- **动画状态机**：工作、等待、成功和失败被映射成有限状态，再由 tick 推进帧。

![Buddy 观察主 Agent 并驱动动画状态](/images/posts/claude-code-source-reading-44/44-buddy-observer-detail-handdrawn.png)

先区分持久身份、回合事件和瞬时动画状态，再读 `CompanionSprite` 的渲染分支。

## 这张金额单位工单调查时，旁边还有一个 Buddy

工程师在启动准备阶段输入：

> /buddy

他选了一个安静的陪伴角色，然后继续处理金额单位工单。终端里模型正在读取回调代码时，Buddy 只在消息列表旁显示“正在核对”的短暂 reaction；模型第一次请求权限时，它不替工程师点击允许；测试失败时，它也不把失败伪装成完成。工程师可以随时静音，窄屏下 reaction 会收起，但主调查的工具调用和消息顺序不变。

Buddy 不负责决定用哪个工具，也不替主 Agent 修复金额问题；它在回合结束后观察结果，把短期 reaction 投影到输入框旁的 UI。主 Agent 只收到一次关于陪伴身份的说明，真正的动画、tick、静音和窄屏布局留在产品层。

下面从 `/buddy` 这个发现入口开始，追踪 observer 和 UI 怎样叠加在已有 Agent 内核之上。

## Buddy 由观察器与 UI 组成

先建立一个够用的基础模型。

Agent 是能够拿到上下文、请求模型、选择工具并继续循环的执行主体；observer 则只观察已经发生的消息，把观察结果变成一个更小的输出。React/Ink 组件再订阅状态，把这个输出画到终端。Buddy 处在后两层，不在第一层。

这一区分直接决定了安全边界。如果 Buddy 是独立 Agent，就需要模型、工具池、权限上下文、取消与会话历史；如果它只是 observer 和 UI，最重要的输入输出就变成“观察哪些消息”“写入哪个状态”“展示多久”。2.1.88 的可见调用链属于后者：

`query() 完成 → fireCompanionObserver(messages) → companionReaction → CompanionSprite`

![Buddy 从稳定身份到回合反馈的手绘流程图](/images/posts/claude-code-source-reading-44/44-buddy-experience-handdrawn.png)

图中实线是还原源码能够确认的调用或状态流；observer 实现未出现在还原目录中，因此其提示词、模型与失败策略保持为黑盒，后文只分析可见的调用边界与消费结果。

## 一个 Buddy 由“灵魂”和“骨架”组成

Buddy 的身份被拆成两部分：`restored-src/src/buddy/types.ts` 中的 `CompanionSoul` 持久化模型生成的名字和性格，`CompanionBones` 根据用户 ID 重新计算外形与数值。

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

**类型说明：** `CompanionBones` 描述可重复生成的外形；`rarity` 可取 `common`、`uncommon`、`rare`、`epic`、`legendary`，`species` 在源码列出的 18 种物种中选择，`eye` 有 `·`、`✦`、`×`、`◉`、`@`、`°` 六种，`hat` 可取 `none`、`crown`、`tophat`、`propeller`、`halo`、`wizard`、`beanie`、`tinyduck`，`shiny` 只有 `true` / `false`，`stats` 固定包含 `DEBUGGING`、`PATIENCE`、`CHAOS`、`WISDOM`、`SNARK`。`CompanionSoul.name` 保存 Buddy 的稳定称呼，供介绍去重和点名交互使用；`personality` 保存持久化性格描述。`StoredCompanion` 只持久化这两个 soul 字段与 `hatchedAt` 数字，不保存 bones。

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

**函数说明：** `companionUserId()` 接受零个参数，优先使用 OAuth 的 `accountUuid`，其次使用全局 `userID`，两个来源都省略时使用固定字符串 `'anon'` 作为确定性种子。`getCompanion()` 同样接受零个参数；配置里省略 `companion` 时返回 `undefined`，调用方据此跳过 attachment、footer 与 sprite。存在时，展开顺序是 `stored` 在前、`bones` 在后，所以旧配置即使含有 `species`、`rarity` 等字段，也会被当前确定性结果覆盖。

`roll()` 的种子是 `userId + SALT`，结果还会按这个 key 缓存。稀有度权重分别是 60、25、10、4、1，`shiny` 的判断是 `rng() < 0.01`。同一个用户 ID 在同一份源码规则下会得到稳定结果。

这种拆分解决了两个产品问题。名字和性格需要连续存在，所以进入配置；外形规则可能随版本调整，也不希望用户只改配置就伪造稀有度，所以每次读取重新生成。

## 功能开关与 `/buddy` 发现启动生命周期

Buddy 先经过构建 gate。`restored-src/src/commands.ts` 用 `feature('BUDDY')` 决定是否加载 `/buddy`，注册表也只在模块存在时追加命令：

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

**参数与取值说明：** `feature('BUDDY')` 接收编译期功能名 `'BUDDY'`，结果只有 `true` / `false`。为 `true` 时动态加载命令模块，为 `false` 时得到 `null`；数组展开也因此分别追加一个命令或追加空数组。这个布尔值在打包阶段决定模块是否进入产物。

`restored-src/src/buddy/useBuddyNotification.tsx` 还给首次发现设置了时间窗。外部构建的 teaser 只在本地日期 2026 年 4 月 1 日至 7 日出现，`isBuddyLive()` 则从 2026 年 4 月开始返回 `true`；内部构建分支直接返回 `true`。通知 hook 还要求当前 `config.companion` 为空，才显示 15 秒的彩色 `/buddy`。

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

**函数说明：** `useBuddyNotification()` 接受零个显式参数，依赖通知 context。`key` 固定为 `'buddy-teaser'`，用于添加与清理同一条通知；`jsx` 保存 `<RainbowText text="/buddy" />`，让通知渲染彩色命令提示；`priority` 固定为 `'immediate'`，`timeoutMs` 为 15000 毫秒。`config.companion` 存在或日期落在 teaser 时间窗外时直接返回；确实添加通知后，effect 才返回移除回调。

这就是 Buddy 的“建议”入口：建议用户发现 `/buddy`，并在输入中用正则 `/\/buddy\b/g` 找出命令位置做彩虹高亮。编码任务建议和主动调度仍由各自模块处理。

需要明确一个证据缺口：`commands.ts` 引用了 `commands/buddy/index.js`，AppState 也注明 `companionPetAt` 来自 `/buddy pet`，但本仓库的还原目录缺少对应命令源码。我们能确认命令注册、持久化字段和抚摸动画的消费端；soul 生成、完整子命令和失败提示仍无源码证据，不能由 UI 结果反推。

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

**函数与参数说明：** `messages` 是 `Message[] | undefined`；`undefined` 通过 `messages ?? []` 当作空历史处理。功能关闭、companion 缺失、`companionMuted` 为真，或历史中已有相同名字的 `companion_intro` 时都返回空数组。其余情况只返回一个 attachment，字段 `name` 与 `species` 来自当前 companion。

attachment 随后被转换成 meta user message。提示文本把输入框旁的 Buddy 定义为“separate watcher”；当用户直接叫 Buddy 名字时，主 Agent 最多回应一行，把后续表达留给 Buddy 气泡。

这条提示用于管理两个角色的表达顺序。主 Agent 仍按普通消息流程运行，Buddy 的气泡在回合结束后另行产生；Tool、`canUseTool` 和 permission context 都保持原值。

## 回合结束后，observer 才写入临时反馈

Buddy 的反馈不能抢在工具执行中出现，否则 reaction 会和主回合的状态竞争。`restored-src/src/screens/REPL.tsx` 等 `query()` 的异步事件流完全结束以后，才触发 companion observer：

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

**函数与参数说明：** `query()` 接收本轮消息、system/user context、权限回调和工具上下文；`querySource` 由 `getQuerySourceForREPL()` 生成，用于把这次主循环归因到当前 REPL 来源。事件逐个交给 `onQueryEvent()` 后，循环终止才进入 Buddy 分支。`fireCompanionObserver()` 的第一个参数是 `messagesRef.current`，即调用时最新消息数组；第二个参数是 reaction 回调。调用前的 `void` 表示 REPL 不等待它完成。回调收到的 `reaction` 在可见调用处作为字符串状态使用；新值与旧值严格相等时返回原 AppState，避免无意义更新，否则只覆盖 `companionReaction`。

这条顺序让 Buddy 的反馈避开主答案和工具执行控制流，成为回合后的旁观评论。observer 异步失败是否重试、是否吞错、怎样裁剪消息，在缺失的实现文件中都无法验证；情绪识别或质量打分也缺少源码证据。

它与主动能力的关系也在这里分开了。REPL 顶部把 `proactiveModule` 作为另一条条件模块加载，主动模式会影响工具集合、后台建议和 `terminalFocus` context；Buddy 的可见路径只在 query 结束后读取消息并写 reaction。两者可以同时出现在同一个 REPL，但可见调用图中不存在 Buddy → proactive 调度或 reaction → 下一轮任务的边。

## AppState 只保存两项短期状态

Buddy 把持久身份放在 `restored-src/src/utils/config.ts` 的 `GlobalConfig.companion`，只把 UI 短期变化写入 `restored-src/src/state/AppStateStore.ts` 的 AppState：

```ts
// Latest companion reaction from the friend observer (src/buddy/observer.ts)
companionReaction?: string
// Timestamp of last /buddy pet — CompanionSprite renders hearts while recent
companionPetAt?: number
```

**字段说明：** `companionReaction` 为字符串时渲染气泡，为 `undefined` 时 reaction effect 提前返回，sprite 保持 idle；`companionPetAt` 为数字时计算 `petAge` 并在 2500 毫秒窗口内播放心形动画，省略时直接走普通 idle/reaction 分支。二者的类型都排除了 `null`，也未在这里定义默认文案或默认时间。

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

`companionPetAt` 则被换算成 `petAge`。时间仍在 2500 毫秒以内时，宽屏 sprite 在五帧心形之间切换，窄屏显示一个心形。reaction 和 petting 都为空时，它按固定的 `IDLE_SEQUENCE` 休息、轻微动作或眨眼。这里的“情绪”由 UI 状态机生成，不能作为模型内部状态的证据。

还有一个容易忽略的反馈清理：全屏模式下，用户向上滚动 transcript 会立即把 `companionReaction` 清空。因为气泡浮在右下角，滚动意味着用户想看被它覆盖的内容。陪伴层可以存在，但不能挡住主任务信息。

## 同一状态投影成宽屏、窄屏与全屏布局

终端 UI 根据当前列宽投影布局。源码用 100 列作为完整 sprite 的门槛：低于 100 列时折叠成“脸 + 名字/短句”的单行形态，reaction 超过 24 个字符就截成 23 个字符加省略号。达到 100 列后，sprite 至少占 12 列；非全屏正在说话时，再为 36 列气泡预留空间。

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

**函数与参数说明：** `terminalColumns` 是终端列数，开放数字输入；小于 `MIN_COLS_FOR_FULL_SPRITE` 的 100 时返回 0，因为窄屏由 REPL 另起一行。`speaking` 是布尔值，只有 `true` 且当前处于非全屏时才增加 `BUBBLE_WIDTH` 的 36 列。功能关闭、companion 为 `undefined`、或 `companionMuted` 为真也都返回 0。最终宽度取名字显示宽度与 12 列 sprite body 的较大者，再加左右 padding；正常列数来自终端尺寸 hook，负值沿“小于 100”分支返回 0。

全屏时，气泡不和输入框抢宽度，而是通过 `FullscreenLayout.bottomFloat` 浮到 scrollback 之上；非全屏无法可靠清掉 Static scrollback 里的浮层，所以气泡与 sprite 内联，输入区域相应收窄。这里复用的是同一个 `companionReaction`，差别只在 renderer 的布局策略。

Footer 也把 companion 当成普通可导航项。全局配置已有 companion 且 `companionMuted` 为假时，`footerItems` 才包含 `'companion'`；焦点移动到它以后按 Enter，PromptInput 提交 `/buddy`。Buddy 因此复用普通命令输入与权限通道。

## 开关、静音和失败边界必须分开看

Buddy 至少有三道不同的门：

1. `feature('BUDDY')` 是构建级功能门。关闭时命令、attachment、observer 调用和组件渲染都被条件分支挡住，部分模块还会被 dead-code elimination 裁掉。
2. `config.companion` 是身份存在门。它为 `undefined` 时 `getCompanion()` 返回 `undefined`，UI 不渲染，启动阶段才可能显示 `/buddy` teaser。
3. `companionMuted` 是用户表现门。为真时 sprite、气泡与 intro attachment 都隐藏；类型是可选布尔值，`undefined` 与 `false` 都沿启用展示分支。

三层 gate 分别控制构建能力、持久身份和当前展示；静音只隐藏 UI，配置删除才移除持久身份。

失败路径还有四个静默边界。observer 是 `void` 异步调用，主回合直接继续；reaction 为空时 UI 保持 idle；窄终端主动降低信息量；滚动、10 秒 timeout 或组件卸载会清理气泡和 timer。最关键的是，`commands/buddy` 与 `buddy/observer.ts` 的实现未出现在本仓库还原文件中。

Buddy 的可见路径只消费消息和配置、写入临时 reaction、再把字符串画出来；它未接收 `ToolUseContext`、`canUseTool` 或 permission mode，也未注册自己的 query loop。

## 小结

Buddy 把陪伴感拆成了三个可控层次：GlobalConfig 保存稳定的 soul，用户 ID 确定性生成 bones；回合结束后的 observer 把消息压成一句 reaction；React/Ink 再用 AppState、定时器和终端宽度把 reaction 画成 sprite 与气泡。

这套实现最值得借鉴的是边界。Buddy 与主 Agent 共享同一块屏幕，工具权限仍归主 Agent；它给主消息链注入一次角色说明，query loop 继续由原运行时控制；通知负责功能发现，reaction 负责回合后反馈，两者都不进入主动任务调度。

源码能够确认持久字段、确定性外形、attachment、回合后触发、UI 状态和各层开关；缺失 command/observer 内部的生成、重试和线上启用效果仍属未知。沿这条证据线，Buddy 可以被准确描述为一层可关闭、失败时绕开主任务的产品体验。

## 留给下一篇的问题

既然 Buddy 的结果由身份 seed 确定，社区是如何实现 100% 抽到最稀有的 Buddy 的？

## 参考资料

- [Dive into Claude Code：未来体验层分析](https://arxiv.org/abs/2604.14228)

- [Broski：Claude Code 源码功能拆解](https://broskiapp.com/source)
