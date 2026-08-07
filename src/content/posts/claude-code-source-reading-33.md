---
title: "Claude Code源码解读33：终端编辑状态如何解析"
published: 2026-07-24T16:47:20+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-33/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇留下的问题是，**Claude Code 当前以 16ms 为渲染节流间隔，用户能否把它调成 120Hz（约 8.33ms）？**

先看代码边界。`@anthropic-ai/claude-code@2.1.88` 的 `restored-src/src/ink/constants.ts` 直接把 `FRAME_INTERVAL_MS` 写成 `16`；配置层没有为它留下入口。因此用户改 `/config`、`settings.json` 或环境变量，都不会把发布版 renderer 变成 120Hz。

```ts
export const FRAME_INTERVAL_MS = 16
```

这个常量被 `Ink` 构造函数用于，

```ts
this.scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS, {
  leading: true,
  trailing: true,
})
```

因此，16ms 表示的是“连续状态变化时，正常渲染最多大约每 16ms 排一帧”，上限约为 62.5fps，而不是保证每帧都能在 16ms 内完成。`leading: true` 让一串更新的第一帧立即执行，`trailing: true` 保证这一串更新的最后状态也会补渲染；如果布局、diff 或 `stdout` 写入耗时更长，实际帧率只会更低。

120Hz 的理想间隔是 `1000 / 120 ≈ 8.33ms`。维护自己的源码构建时，当然可以把常量改成 `8`（整数毫秒）或 `8.33` 后重新打包；但这属于修改源码，不是用户配置，官方发布包更新后也会覆盖这个改动。这个常量同时影响 `scheduleRender` 和 `ClockProvider`，后者在终端获得焦点时用它作为时钟间隔，失焦时则使用 `FRAME_INTERVAL_MS * 2`。单独改一个数，实际上会同时改变一批订阅了这个时钟的动画与计时器。

还不能把“渲染上限”误解成“菊花每秒转 120 次”。源码里有多套时钟，

| 层次 | 2.1.88 中的节奏 | 把 `FRAME_INTERVAL_MS` 改成 8ms 后 |
| --- | --- | --- |
| Ink 外层渲染节流 | `throttle(..., 16)`，约 62.5fps 上限 | 只把这一层的上限提高到约 125fps |
| `ClockProvider` | 聚焦 16ms，失焦 32ms | 聚焦 8ms，失焦 16ms |
| `SpinnerAnimationRow` | `useAnimationFrame(..., 50)` | 仍然由显式的 50ms 间隔驱动 |
| 菊花帧选择 | `Math.floor(time / 120)`，约每 120ms 换一帧 | 仍然约每 120ms 换一帧 |

这里的 `useAnimationFrame(intervalMs)` 接受 `number | null`，传入 `50` 表示每 50ms 检查一次时钟，传入 `null` 则关闭动画；它不会自动继承你对外层 renderer 做的假设。

也就是说，若目标是让菊花本身达到 120Hz，还要另改 `SpinnerAnimationRow` 的 50ms 动画间隔和 `SpinnerGlyph` 的 120ms 换帧逻辑；这会显著增加 React 更新、Yoga 布局、屏幕 diff 和终端写出的次数，已经不是“把显示器切到 120Hz”这么简单。

这也解释了为什么不能只看显示器规格。上游 Ink 的文档把 `maxFps` 描述成渲染更新的上限，并明确提醒更高值可能增加性能开销；Claude Code 2.1.88 的内置 renderer 并没有把这个上游选项暴露成自己的配置项。Claude Code 的全屏渲染文档也指出，真正的瓶颈可能在 VS Code 集成终端、tmux 或 iTerm2 的终端吞吐；即使程序请求 120fps，终端也可能合并、延迟或来不及绘制这些 ANSI 更新。JavaScript 定时器同样只是“至少等待指定延迟”，事件循环繁忙时回调会晚于目标时间。

所以答案分三层，**用户配置不能调；自己维护源码可以改，但要连带检查所有时钟消费者；改完也只能提高上限，不能保证终端实际达到 120Hz。**

接下来回到本章主题，Claude Code 把终端按键先归一化成 `input + Key`，再用快捷键上下文和 Vim 的编辑状态机解释它们。

## 介绍本章的一些概念

- 终端输入先被归一化成 **`input + Key`** 两份数据，`parseKey()` 把 `ParsedKey` 变成布尔标志键族（方向、导航、编辑键）和可打印字符串；`meta` 由 `meta || escape || option` 三者合并而成，传统终端里 `Alt`/`Option` 不可靠区分。
- 快捷键系统由**两层可组合机制**构成，`useKeybinding()` 处理单键 action，全局 `ChordInterceptor` 在事件传播链最前面观察 chord 前缀，只有 `none` 才放行给文本输入，`chord_started`/`chord_cancelled`/`unbound` 都会 `stopImmediatePropagation()`。
- chord 解析用**线性扫描而不是前缀树**，`resolveKeyWithChordState()` 在激活上下文内过滤绑定，先判断"是否可能扩展成更长 chord"（消歧等待），再做精确匹配；`CHORD_TIMEOUT_MS = 1000` 超时清空 pending。
- 绑定覆盖规则是**数组末项胜出**，`[...defaultBindings, ...userParsed]`，靠后的用户绑定覆盖默认；`null` action 会占用槽位并取消同 chord 的默认动作。整个功能受 `tengu_keybinding_customization_release` 开关门控。
- Vim 只有两个顶层模式，`INSERT | NORMAL`，NORMAL 内部是第二层判别联合 `CommandState`（idle/count/operator/operatorCount/operatorFind/operatorTextObj/find/g/operatorG/replace/indent）；operator-pending 位于 NORMAL 子状态，`d3w`、`ci"`、`dd` 都由 transition 穷举推进。

> ⚠️ **证据边界**，本文所有代码来自 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` source map 还原源码。`restored-src/` 只用于定位证据，不等同于 Anthropic 内部仓库原始目录；代码块只保留证明控制流所需的字段，`// ...` 表示省略埋点、UI 消息与无关分支。

## 本篇新增机制

32 解释了 `useInput()` 如何把终端 raw input 接进 React effect。本篇回答它之后的问题，**归一化后的按键怎样被解释成动作？** 答案是两条独立的状态机，快捷键层的 chord automaton（完整匹配/前缀等待/失配取消），以及 Vim 层的模态编辑状态机（INSERT/NORMAL + operator-pending）。它揭示"应用快捷键"与"编辑语言"分开的边界，前者随 overlay、焦点和用户配置变化，后者用确定的状态转移解释 `d3w`、`ci"` 或 `.`。它是 34（无头模式）的对照面，远程/headless 直接提交结构化消息，绕开这整套终端编辑层。

## 问题现场

同一个按键，在不同终端里可能是 ESC 前缀、Kitty keyboard protocol 的 CSI u 序列，或一段无法识别的控制字节。若快捷键系统直接比较原始字符串，同一个动作会因终端不同而落入不同分支；若把多键 chord 的中间态交给普通文本输入，编辑框就会多出半截字符。输入层必须先归一化，再按上下文分流，最后才允许未消费的按键落到文本组件。

![按键 chord 与 Vim operator-pending 状态机](/images/posts/claude-code-source-reading-33/33-key-state-machine-detail-handdrawn.png)

本文先建立三个概念，**Chord automaton**（按键序列在完整匹配、候选前缀和失配之间迁移）、**模态编辑**（同一按键在 normal/insert/operator-pending 状态中映射到不同动作）、**Pending operator**（删除、修改等操作先记录 operator，再由 motion 计算范围并提交文本变更）。这三个概念分别对应输入归一化后的按键序列、Vim 的顶层状态，以及"先按 operator、后等 motion"的中间状态。后文读到具体函数时，先判断它属于哪一层，快捷键与文本编辑就不会混成同一个状态机。

## 正文

### 这张金额单位工单为什么能用一个 chord 触发 compact

调查到 11，26 时，工程师发现终端提示上下文接近上限。手边还有一条后台测试和一份尚未整理的回调日志，他不想在输入框里重新输入 `/compact`，也不想误触发送半截说明，于是先输入 `/keybindings`，然后在配置界面里把 `ctrl+k ctrl+c` 绑定到 `command:compact`，保存后回到金额单位工单，先按 `Ctrl-K`，再按 `Ctrl-C`。第一个按键到来时程序不能立刻把它当成普通字符，也不能立刻结束当前输入；它要等第二个按键确认这是一个完整 chord。

Claude Code 先把终端事件解析成 keystroke 和 chord，按当前 context、Vim 模式和全局绑定寻找动作；完整匹配后触发 `/compact`，未完成的前缀则进入 pending 状态。这个输入来自配置文件热加载到按键拦截器的独立路径，不会先进入普通 prompt。

### 一个按键包含字符与控制信息

`restored-src/src/ink/events/input-event.ts` 的 `parseKey()` 先把 `ParsedKey` 变成两份数据，`Key` 保存方向键、修饰键等布尔标志，`input` 保存可打印输入。下面是其中的关键收口，

```ts
function parseKey(keypress: ParsedKey): [Key, string] {
  const key: Key = {
    upArrow: keypress.name === 'up',
    downArrow: keypress.name === 'down',
    leftArrow: keypress.name === 'left',
    rightArrow: keypress.name === 'right',
    pageDown: keypress.name === 'pagedown',
    pageUp: keypress.name === 'pageup',
    wheelUp: keypress.name === 'wheelup',
    wheelDown: keypress.name === 'wheeldown',
    home: keypress.name === 'home',
    end: keypress.name === 'end',
    return: keypress.name === 'return',
    escape: keypress.name === 'escape',
    fn: keypress.fn,
    ctrl: keypress.ctrl,
    shift: keypress.shift,
    tab: keypress.name === 'tab',
    backspace: keypress.name === 'backspace',
    delete: keypress.name === 'delete',
    meta: keypress.meta || keypress.name === 'escape' || keypress.option,
    super: keypress.super,
  }

  let input = keypress.ctrl ? keypress.name : keypress.sequence
  if (input === undefined) {
    input = ''
  }
  return [key, input]
}
```

> 证据，`restored-src/src/ink/events/input-event.ts`（2.1.88 source map 还原源码），`parseKey()` 收口。

`parseKey(keypress)` 接收 `ParsedKey`，返回 `[Key, string]`。`keypress.name` 是解析后的键名，`sequence` 是终端序列；`ctrl`、`shift`、`meta`、`option`、`super` 都是布尔值。`sequence` 为 `undefined` 时，`input` 回退为空字符串，使未知控制序列停留在按键层。源码后续还专门处理 CSI u、modifyOtherKeys、数字键盘和无法识别的功能键，避免控制序列泄漏成普通文本。

`Key` 的布尔字段按键族分组，`upArrow/downArrow/leftArrow/rightArrow` 表示方向，`pageDown/pageUp/home/end` 表示导航，`wheelUp/wheelDown` 表示滚轮，`return/tab/backspace/delete/escape` 表示编辑与控制键；每项都由 `keypress.name` 的精确相等判断产生。`fn`、`ctrl`、`shift`、`super` 原样继承解析结果，`meta` 则在 `keypress.meta`、Escape 或 `keypress.option` 任一成立时为真，因此 Option/Alt 会并入 Meta 语义。

这里已经能看到第一个平台边界，Ink 的历史兼容层把 `Alt` / `Option` 汇入 `meta`，因此传统终端里两者不能可靠区分；`super` 仍然独立，但只有支持 Kitty keyboard protocol 的终端才可能把 Cmd/Win 送进 PTY。配置文件能写出 `cmd+c`，不代表当前终端一定能产生它。

在新 Ink DOM 事件路径里，`KeyboardEvent` 又把同一个 `ParsedKey` 转成类似浏览器的 `keydown` 事件，可打印键使用字面字符，控制组合使用键名，特殊键使用 `return`、`down` 等名称。`Ink.dispatchKeyboardEvent()` 从当前 focus element 开始做 capture/bubble；所有 handler 都放行时，Tab 才执行默认的焦点切换。这个事件路径解释了"按键怎样进入组件树"，而快捷键 action 的主要匹配仍使用 `InputEvent` 中的 `input + Key`。

### 绑定把组件动作与按键映射分开

组件注册 `chat:submit`、`app:interrupt` 这类动作；默认按键映射集中在 `restored-src/src/keybindings/defaultBindings.ts`，用户配置也被解析成同一种扁平结构。`parseKeystroke()` 会处理修饰键别名和少量键名别名，

```ts
export function parseChord(input: string): Chord {
  if (input === ' ') return [parseKeystroke('space')]
  return input.trim().split(/\s+/).map(parseKeystroke)
}

export function parseBindings(blocks: KeybindingBlock[]): ParsedBinding[] {
  const bindings: ParsedBinding[] = []
  for (const block of blocks) {
    for (const [key, action] of Object.entries(block.bindings)) {
      bindings.push({
        chord: parseChord(key),
        action,
        context: block.context,
      })
    }
  }
  return bindings
}
```

> 证据，`restored-src/src/keybindings/`（2.1.88 source map 还原源码），`parseChord()` / `parseBindings()`。

`parseChord(input)` 的 `input` 是开放字符串，例如 `ctrl+x ctrl+e`；空格分隔多个 keystroke，但单独一个空格被特殊解释成 Space 键。`parseBindings(blocks)` 的 `blocks` 是配置块数组，每块包含 `context` 与 `bindings`。`action` 可以是内置 action、符合 `command:<name>` 格式的命令绑定，或者 `null`；遇到 `null` 时，合并后的映射保留这个槽位并阻止同 chord 的默认 action 被调用。

源码能够确认的配置上下文包括 `Global`、`Chat`、`Autocomplete`、`Confirmation`、`Help`、`Transcript`、`HistorySearch`、`Task`、`ThemePicker`、`Settings`、`Tabs`、`Attachments`、`Footer`、`MessageSelector`、`DiffDialog`、`ModelPicker`、`Select` 和 `Plugin`。action 列表也由 schema 封闭定义。

默认配置先进入数组，用户配置随后追加，所以覆盖机制不需要修改组件。`loadKeybindings()` 中的合并就是，

```ts
const defaultBindings = getDefaultParsedBindings()

if (!isKeybindingCustomizationEnabled()) {
  return { bindings: defaultBindings, warnings: [] }
}

const userParsed = parseBindings(userBlocks)
const mergedBindings = [...defaultBindings, ...userParsed]
```

> 证据，`restored-src/src/keybindings/loadKeybindings.ts`（2.1.88 source map 还原源码）。

`isKeybindingCustomizationEnabled()` 接受零个参数，读取 `tengu_keybinding_customization_release` 功能开关，并以 `false` 为回退值。开关关闭时，`bindings` 直接取 `defaultBindings`，`warnings` 为空数组；打开时解析用户块得到 `userParsed`，再按 `[...defaultBindings, ...userParsed]` 生成 `mergedBindings`，使靠后的用户项参与最终覆盖。文件不存在、格式错误或解析异常时，加载器回退默认绑定并继续启动 REPL；可诊断的问题被整理为 `parse_error`、`duplicate`、`reserved`、`invalid_context` 或 `invalid_action`，严重度是 `error` 或 `warning`。

### 候选前缀通过线性扫描解析

多键 chord 很容易让人联想到前缀树。但 2.1.88 的实现更直接，绑定总量不大，每次输入都过滤激活上下文，再扫描是否存在"更长且当前序列是其前缀"的绑定。核心逻辑在 `restored-src/src/keybindings/resolver.ts`，

```ts
export function resolveKeyWithChordState(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending: ParsedKeystroke[] | null,
): ChordResolveResult {
  if (key.escape && pending !== null) {
    return { type: 'chord_cancelled' }
  }

  const currentKeystroke = buildKeystroke(input, key)
  if (!currentKeystroke) {
    return pending !== null ? { type: 'chord_cancelled' } : { type: 'none' }
  }

  const testChord = pending
    ? [...pending, currentKeystroke]
    : [currentKeystroke]

  // 后续执行上下文过滤、前缀扫描与精确匹配
}
```

> 证据，`restored-src/src/keybindings/resolver.ts`（2.1.88 source map 还原源码），`resolveKeyWithChordState()` 开头。

`input` 是归一化后的可打印字符串，`key` 是特殊键与修饰键标志，`activeContexts` 是本次允许参与匹配的上下文，`bindings` 是默认与用户配置合并后的数组。`pending` 为数组时把当前键追加到此前前缀，为 `null` 时从当前键开始新序列。返回值可能是 `match`、`none`、`unbound`、`chord_started` 或 `chord_cancelled`，调用方必须分别处理。

匹配顺序有两个值得注意的细节。

第一，如果 `testChord` 仍可能扩展成更长 chord，resolver 优先返回 `chord_started`，即使当前序列也有单键精确匹配。这是消歧必须付出的等待成本。`KeybindingSetup` 同时维护 ref 和 React state，ref 让下一次按键立即看到 pending，state 负责刷新提示；`CHORD_TIMEOUT_MS` 固定为 1000，超时就清空。

第二，它用 `Map<chordString, action | null>` 先处理相同 chord 的覆盖。靠后的 `null` 可以真正取消默认长 chord，否则只解绑完整序列，却仍会让第一个键进入等待。完成前缀判断后，精确匹配同样遍历到底，因此匹配数组中最后一个候选胜出。

这也是为什么这里不应写成"上下文数组第一个一定胜出"。`useKeybinding()` 确实按"已激活上下文、当前组件上下文、Global"构造数组并去重，但 resolver 把它转成 `Set` 只用于筛选，最终赢家仍由 `bindings` 数组的先后决定。默认表与用户表的组织方式通常让更晚的具体绑定覆盖更早绑定；真正可由源码保证的规则是"参与匹配的候选中，靠后的精确项胜出"。

### 为什么还需要全局 ChordInterceptor

假设 `ctrl+x` 已经启动 chord，第二键 `e` 若先被普通文本输入处理，编辑框就会多出一个 `e`，随后快捷键系统才发现组合完整。根因是事件消费顺序颠倒。因此 `KeybindingSetup` 把 `ChordInterceptor` 放在 children 之前，它先观察所有按键，只在 chord 相关分支中阻断传播，

```ts
const result = resolveKeyWithChordState(
  input,
  key,
  contexts,
  bindings,
  pendingChordRef.current,
)

switch (result.type) {
  case 'chord_started':
    setPendingChord(result.pending)
    event.stopImmediatePropagation()
    break
  case 'chord_cancelled':
    setPendingChord(null)
    event.stopImmediatePropagation()
    break
  case 'unbound':
    setPendingChord(null)
    event.stopImmediatePropagation()
    break
  case 'none':
    break
}
```

> 证据，`restored-src/src/keybindings/KeybindingSetup.tsx`（2.1.88 source map 还原源码），ChordInterceptor 分支。

这里的 `contexts` 来自已注册 handler 的 context、当前 active context 和 `Global`；`pendingChordRef.current` 为 `null` 或当前 chord 前缀。`stopImmediatePropagation()` 会阻止后续 `useInput` handler 看到同一次事件。`none` 不阻断，让文本输入、Vim 或其他更局部的 handler 继续处理；`match` 在完成 pending chord 时由 registry 找到 action handler 并调用。

单键 action 则由组件里的 `useKeybinding()` / `useKeybindings()` 处理。handler 同步返回 `false` 表示事件继续传播；返回 `void` 或 `Promise<void>` 表示已处理。这个约定让未发生位移的滚动事件继续交给子列表，也避免当前无效的 action 永久吞键。

上下文本质上是 UI 所有权。确认框挂载时注册 `Confirmation`，历史搜索注册 `HistorySearch`，Chat 输入注册 `Chat`。它们决定某个动作此刻是否有资格响应，不会改变 QueryEngine、工具权限或 Agent 循环。快捷键最多触发"提交""取消""选择 yes"等宿主动作，不能凭一个绑定绕过工具授权。

### 冲突校验同时考虑上下文与终端保留键

`restored-src/src/keybindings/validate.ts` 会检查同一块 JSON 中的重复键、非法 context/action 和保留快捷键。不同 context 中都绑定 `enter` 是合法的，因为焦点与 overlay 会决定谁参与匹配。

真正不可重绑的项目在 `reservedShortcuts.ts` 中很少，`ctrl+c` 用于 interrupt/exit，`ctrl+d` 用于 exit，`ctrl+m` 与 Enter 在终端中发送相同 CR。`ctrl+z`、`ctrl+\\` 以及 macOS 的若干 Cmd 组合则是终端或系统可能提前截获的 warning/error。这个区分很重要，程序拒绝重绑和按键根本到不了程序，是两类失败。

默认绑定也包含平台回退。例如 Windows 终端缺少可靠 VT mode 时，模式切换从 `shift+tab` 回退为 `meta+m`；图片粘贴在 Windows 使用 `alt+v`，其他平台使用 `ctrl+v`。

到这里，快捷键系统已经完成分流，能解析成 action 的按键被消费，零匹配的 Chat 输入继续落到文本组件。下面进入 Vim。

### Vim 只有两个顶层模式

`restored-src/src/vim/types.ts` 把状态边界写得很明确，

```ts
export type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; command: CommandState }

export type CommandState =
  | { type: 'idle' }
  | { type: 'count'; digits: string }
  | { type: 'operator'; op: Operator; count: number }
  | { type: 'operatorCount'; op: Operator; count: number; digits: string }
  | { type: 'operatorFind'; op: Operator; count: number; find: FindType }
  | { type: 'operatorTextObj'; op: Operator; count: number; scope: TextObjScope }
  | { type: 'find'; find: FindType; count: number }
  | { type: 'g'; count: number }
  | { type: 'operatorG'; op: Operator; count: number }
  | { type: 'replace'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }
```

> 证据，`restored-src/src/vim/types.ts`（2.1.88 source map 还原源码），Vim 状态类型。

`VimState.mode` 只有 `'INSERT'` 与 `'NORMAL'`。INSERT 的 `insertedText` 用于记录可被 `.` 重放的插入；NORMAL 的 `command` 是第二层判别联合。`digits` 保存 count 等待态已累计的原始数字字符，后续 transition 再把它转换成计数并应用 `MAX_VIM_COUNT` 上限。`Operator` 的可选值只有 `'delete'`、`'change'`、`'yank'`；`FindType` 是 `'f' | 'F' | 't' | 'T'`；`TextObjScope` 是 `'inner' | 'around'`。这些封闭值决定 transition 能穷举每个等待态。

初始化状态是 `{ mode: 'INSERT', insertedText: '' }`。另有 `PersistentState` 保存 `lastChange`、`lastFind`、register 内容和 linewise 标志；`lastChange` 与 `lastFind` 为 `null` 时，`.`、`;`、`,` 等重复命令直接保持当前文本，register 初始为空字符串。它们跨 command 保存，但只活在当前输入组件实例的内存里。

`VimTextInput` 调用 `useVimInput()` 生成兼容普通文本输入的 `inputState`，再交给同一个 `BaseTextInput`。因此 Vim 只增加输入语义，渲染仍复用普通 REPL。

### Esc 由 Vim 模式直接处理

`useVimInput()` 先复用 `useTextInput()`，然后在 `handleVimInput()` 中按模式分流，

```ts
if (key.ctrl) {
  textInput.onInput(input, key)
  return
}

if (key.escape && state.mode === 'INSERT') {
  switchToNormalMode()
  return
}

if (key.escape && state.mode === 'NORMAL') {
  vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
  return
}

if (key.return) {
  textInput.onInput(input, key)
  return
}
```

> 证据，`restored-src/src/vim/useVimInput.ts`（2.1.88 source map 还原源码），`handleVimInput()` 前置分流。

`handleVimInput(rawInput, key)` 的 `rawInput` 是进入 Vim 前的原始字符串，`key` 是 Ink 的按键标志。Ctrl 组合统一下放给基础输入，让 readline 风格与应用快捷键继续工作；Esc 在 INSERT 中固定切到 NORMAL，在 NORMAL 中固定取消 pending command；Enter 无论模式都交给基础输入，因此 NORMAL 下仍可提交 prompt。这些分支直接返回固定结果，跳过 `transition()`。

源码注释明确说，INSERT → NORMAL 的 Esc 是 Vim 用户依赖的标准语义，因此该键固定由 Vim 状态机处理。外层 `CancelRequestHandler` 在 Vim INSERT 模式下停用 `chat:cancel`，确保默认的 `escape: chat:cancel` 不会抢先消费 Esc。切出 INSERT 时，`switchToNormalMode()` 会把非空 `insertedText` 记为 `lastChange`，并在光标位于行首之外时左移一个 grapheme。切回 INSERT 时清空本轮 `insertedText`。这份数据保存 dot-repeat 所需的编辑记忆；`mode` 另存在 `useState` 中，负责 footer 等组件刷新。

### operator-pending 是怎样推进的

NORMAL 输入最终交给 `transition(state.command, vimInput, ctx)`。这个函数只做两件事，返回 `next` 表示继续等待，返回 `execute` 表示信息已经足够，可以修改文本或光标。从 idle 按下 `d` 时，`isOperatorKey('d')` 把它映射为 `delete`，返回 `{ type: 'operator', op: 'delete', count: 1 }`。再按 `w`，`handleOperatorInput()` 才构造执行闭包，

```ts
function fromOperator(
  state: { type: 'operator'; op: Operator; count: number },
  input: string,
  ctx: TransitionContext,
): TransitionResult {
  if (input === state.op[0]) {
    return { execute: () => executeLineOp(state.op, state.count, ctx) }
  }

  if (/[0-9]/.test(input)) {
    return {
      next: {
        type: 'operatorCount',
        op: state.op,
        count: state.count,
        digits: input,
      },
    }
  }

  const result = handleOperatorInput(state.op, state.count, input, ctx)
  if (result) return result

  return { next: { type: 'idle' } }
}
```

> 证据，`restored-src/src/vim/transition.ts`（2.1.88 source map 还原源码），`fromOperator()`。

`state.op` 只能是 delete/change/yank，`state.count` 是 operator 前的计数，`input` 是当前 NORMAL 命令字符，`ctx` 提供文本、Cursor、setter、register 和 repeat 回调。返回 `next` 会继续停留在 NORMAL 的子状态；返回 `execute` 后，`useVimInput()` 在仍处于 NORMAL 时把 command 复位到 `idle`。未知输入直接取消当前 operator。

这套拆分可以自然表达组合语法，`dd` / `cc` / `yy` 进入整行操作；`d3w` 进入 `operatorCount`，其中 `digits` 累积 operator 后输入的数字；`dfx` 进入 `operatorFind`；`di"` 先进入 `operatorTextObj(inner)`，再等待对象类型。operator 前后的 count 会相乘，累计数字被 `MAX_VIM_COUNT = 10000` 截断，避免异常长数字让 motion 循环失控。

`change` 和 `delete` 还会导向不同状态。`applyOperator()` 对 yank 只更新 register 和光标，对 delete 拼接范围两侧，对 change 删除范围后调用 `enterInsert(from)`。所以 change 箭头会回到 INSERT，delete/yank 完成后回到 NORMAL idle。

### motion 计算与文本修改为什么分开

`resolveMotion(key, cursor, count)` 是纯位置计算，`h/l/j/k`、`w/b/e`、`0/^/$` 等命令不断产生新 `Cursor`，到达边界时提前停止。operator 再根据 motion 是否 inclusive、linewise，决定真正的 `[from, to)` 范围。

这种分层解决了两个问题。一是同一个 motion 可以独立移动，也可以被 `d/c/y` 复用，`w` 只移动，`dw` 先算目标，再删除范围。二是文本边界集中处理，`x`、replace 和普通 motion 按 grapheme 推进，不直接用 UTF-16 code unit；word motion 落进 `[Image #N]` 占位片段时，operator range 会扩到整个 image ref，避免删除半个占位符。

源码也保留了 Vim 的特殊规则。例如 `cw` / `cW` 把范围截到当前词尾；`j/k/G/gg` 与 operator 结合时按整行处理；`f/F/t/T` 会更新 `lastFind`，`;` 和 `,` 再按原方向或反方向重复。

### 两套 pending 怎样避免互相踩踏

现在可以把整条链收回来。终端输入先经过全局 chord interceptor。若它是一个有效 action 或 chord 前缀，事件被消费，Vim 看不到它；若结果是 `none`，事件继续传播到 Chat 输入。Vim INSERT 把普通字符交给基础文本编辑器；Vim NORMAL 把字符解释为 command state transition。

组件按场景注册 handler，形成动态优先级。例如 Vim INSERT 时，外层主动停用 Esc 的 `chat:cancel`，把 Esc 留给模式切换；有任务运行且 Vim 已在 NORMAL 时，Esc 才由取消 handler 接管。控制键也由 `useVimInput()` 下放，避免 Vim 字符命令吞掉 `ctrl+c` 等全局动作。

远程或 headless 模式直接向核心提交 user message、permission response 或 control event，省去终端按键、chord 与 Vim command state。Keybindings 与 Vim 都属于交互宿主，它们决定 prompt 怎样被编辑、哪个 UI 动作被调用；Agent 查询循环继续沿用同一套工具与权限语义。

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码，行号以当前仓库为准。

| 机制 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| 归一化 | `parseKey()` → `[Key, string]` | `src/ink/events/input-event.ts` | 已确认 |
| 解析 | `parseChord()` / `parseBindings()` | `src/keybindings/` | 已确认 |
| 合并 | `[...defaultBindings, ...userParsed]` + 功能开关 | `src/keybindings/loadKeybindings.ts` | 已确认 |
| 匹配 | `resolveKeyWithChordState()` 前缀扫描 | `src/keybindings/resolver.ts` | 已确认 |
| 拦截 | `ChordInterceptor` 的 `stopImmediatePropagation()` | `src/keybindings/KeybindingSetup.tsx` | 已确认 |
| 校验 | `validate.ts` / `reservedShortcuts.ts` | `src/keybindings/` | 已确认 |
| Vim 类型 | `VimState` / `CommandState` 封闭联合 | `src/vim/types.ts` | 已确认 |
| Vim 分流 | `handleVimInput()` Esc/Ctrl/Enter 前置分支 | `src/vim/useVimInput.ts` | 已确认 |
| Operator | `fromOperator()` / `MAX_VIM_COUNT` | `src/vim/transition.ts` | 已确认 |
| Motion | `resolveMotion()` 与 operator 范围拼接 | `src/vim/` | 已确认 |
| 渲染节流 | `FRAME_INTERVAL_MS = 16` + ClockProvider | `src/ink/constants.ts` | 已确认 |

> 证据说明，快捷键层与 Vim 层共享同一个 `useInput()` 事件源，但分别维护自己的状态机；"数组末项胜出"是绑定覆盖的源码级规则，`null` 槽位取消默认 action（`loadKeybindings.ts`）。

## 设计决策｜为什么不是一棵前缀树、为什么只有两个 Vim 顶层模式

源码里找不到官方选型记录，下面的判断来自代码结构，属于解释而非官方声明。

**第一，为什么 chord 用线性扫描而不是前缀树？** 因为绑定总量有限（默认表 + 用户表通常只有几十到几百条），每次按键做一次 O(bindings) 扫描成本可忽略；前缀树带来的增量收益不值得额外维护一个动态结构，用户保存 `keybindings.json` 后绑定集合会热更新，重建一棵树反而增加正确性风险。线性数组配合"靠后的精确项胜出"规则，让覆盖语义与配置文件的书写顺序直接对应。

**第二，为什么 `FRAME_INTERVAL_MS` 与 `CHORD_TIMEOUT_MS` 都是固定常量？** 固定常量换来可预测性，chord 等待窗口 1 秒、渲染节流 16ms，都是横切全局的节奏参数。若把它们暴露成配置，用户必须理解"渲染上限"与"时钟间隔"的区别才能安全调节（见回顾折叠），而源码选择把这类调优成本转移到维护者身上。

**第三，为什么 Vim 只有 INSERT/NORMAL 两个顶层模式，而不是完整复刻 Vim 的 VISUAL/COMMAND 模式？** 因为 Claust 的输入场景是"prompt 编辑"而非"文档编辑"，INSERT 负责输入，NORMAL 负责移动与修改，COMMAND-LINE 的职责由 REPL 的斜杠命令层承担。把 `Operator` 限制为 delete/change/yank、`TextObjScope` 限制为 inner/around，是刻意缩小状态面，状态越少，`d3w`、`ci"`、`.` 的判定越容易穷举和测试。

**第四，为什么 motion 与 operator 分开？** 因为纯位置计算（`resolveMotion`）可以被移动命令和修改命令复用，而且文本边界（grapheme、image ref 占位符）只需要在一个地方处理。operator 只负责"根据范围应用修改"，change 切回 INSERT，delete/yank 回到 NORMAL idle，两层职责分离让组合语法成为结构，而不是一堆 if 分支。

## 练习｜在真实会话里观察按键分流

1. **自己写一个 chord 绑定。** 运行 `/keybindings`，把 `ctrl+k ctrl+c` 绑定到 `command:compact`（或任意 `command:<name>`），保存后观察，按第一个键时界面出现 pending 提示，约 1 秒后未按第二键则超时取消；完整输入后触发命令。再把同一个绑定改成 `null`，验证默认动作被取消。

2. **在 Vim 模式下练习组合语法。** 开启 Vim 模式后输入 `d3w`、`ci"`、`dd`，观察 NORMAL 状态的推进，operator 先进入等待态，数字进入 `operatorCount`，对象选择进入 `operatorTextObj`，完整组合才执行文本修改。再按 `.` 重放上次修改，观察 `lastChange` 的效果。

3. **用不同终端验证 `Alt` 语义。** 在传统终端（如 macOS Terminal）和启用 Kitty keyboard protocol 的终端（如 Kitty、最新 iTerm2）里分别按 `Alt+某键`，体验 `meta` 合并后行为一致但 `super`（Cmd/Win）可能根本收不到的现象。

## 自测

1. `Ctrl+K` 之后 1 秒内没有按第二个键，会发生什么？
2. 为什么 `useKeybinding()` 中"已激活上下文"数组的先后顺序，不决定匹配赢家？
3. NORMAL 模式下按 `d` 之后按 `w` 与按 `d` 之后按 `d`，状态机分别走到哪？
4. Esc 在 INSERT 和 NORMAL 两个模式下的语义分别是什么？

<details>
<summary>参考答案</summary>

1. **`CHORD_TIMEOUT_MS = 1000` 超时清空 pending。** `KeybindingSetup` 维护 ref 与 state，ref 让下一次按键立即看到 pending，state 负责刷新提示；超时后 pending 置空，`Ctrl+K` 不再被当作任何 chord 的前缀。若该键同时有单键 action，超时后它也错过了一次触发机会，这是消歧等待的代价。

2. **因为 resolver 把它转成 `Set` 只用于筛选。** `useKeybinding()` 按"已激活上下文、当前组件上下文、Global"构造数组并去重，但最终赢家仍由 `bindings` 数组的先后决定，`[...defaultBindings, ...userParsed]` 中靠后的精确项胜出。上下文数组只决定"谁有资格参与"，不决定"谁赢"。

3. **`d` → `fromOperator({ type: 'operator', op: 'delete', count: 1 })`。** 按 `w` 走 `handleOperatorInput()` 构造执行闭包（词移动 + 删除）；按 `d`（`input === state.op[0]`）走 `executeLineOp` 整行删除。两者都进入 `execute`，随后 `useVimInput()` 把 command 复位到 `idle`。

4. **INSERT 中 Esc 固定切到 NORMAL**（并把非空 `insertedText` 记为 `lastChange`）；**NORMAL 中 Esc 固定取消 pending command**（command 复位 `idle`）。这两个分支直接返回固定结果，跳过 `transition()`；外层 `CancelRequestHandler` 在 INSERT 下停用 `chat:cancel`，保证 Esc 不被默认的 `escape: chat:cancel` 抢先消费。

</details>

## 回顾（折叠）｜用户能把渲染节流调成 120Hz 吗

<details>
<summary>回答 32 留下的问题，Claude Code 当前以 16ms 为渲染节流间隔，用户能否把它调成 120Hz（约 8.33ms）？</summary>

**用户配置不能调。** `restored-src/src/ink/constants.ts` 直接把 `FRAME_INTERVAL_MS` 写成 `16`；配置层没有为它留下入口。用户改 `/config`、`settings.json` 或环境变量，都不会把发布版 renderer 变成 120Hz。

```ts
export const FRAME_INTERVAL_MS = 16
```

> 证据，`restored-src/src/ink/constants.ts`（2.1.88 source map 还原源码）。

这个常量被 `Ink` 构造函数用于 `throttle(deferredRender, FRAME_INTERVAL_MS, { leading: true, trailing: true })`。因此，16ms 表示的是"连续状态变化时，正常渲染最多大约每 16ms 排一帧"，上限约为 62.5fps，而不是保证每帧都能在 16ms 内完成。`leading: true` 让一串更新的第一帧立即执行，`trailing: true` 保证这一串更新的最后状态也会补渲染；如果布局、diff 或 `stdout` 写入耗时更长，实际帧率只会更低。

120Hz 的理想间隔是 `1000 / 120 ≈ 8.33ms`。维护自己的源码构建时，当然可以把常量改成 `8`（整数毫秒）或 `8.33` 后重新打包；但这属于修改源码，不是用户配置，官方发布包更新后也会覆盖这个改动。这个常量同时影响 `scheduleRender` 和 `ClockProvider`，后者在终端获得焦点时用它作为时钟间隔，失焦时则使用 `FRAME_INTERVAL_MS * 2`。单独改一个数，实际上会同时改变一批订阅了这个时钟的动画与计时器。

还不能把"渲染上限"误解成"菊花每秒转 120 次"。源码里有多套时钟，

| 层次 | 2.1.88 中的节奏 | 把 `FRAME_INTERVAL_MS` 改成 8ms 后 |
| --- | --- | --- |
| Ink 外层渲染节流 | `throttle(..., 16)`，约 62.5fps 上限 | 只把这一层的上限提高到约 125fps |
| `ClockProvider` | 聚焦 16ms，失焦 32ms | 聚焦 8ms，失焦 16ms |
| `SpinnerAnimationRow` | `useAnimationFrame(..., 50)` | 仍然由显式的 50ms 间隔驱动 |
| 菊花帧选择 | `Math.floor(time / 120)`，约每 120ms 换一帧 | 仍然约每 120ms 换一帧 |

`useAnimationFrame(intervalMs)` 接受 `number | null`，传入 `50` 表示每 50ms 检查一次时钟，传入 `null` 则关闭动画；它不会自动继承你对外层 renderer 做的假设。若目标是让菊花本身达到 120Hz，还要另改 `SpinnerAnimationRow` 的 50ms 动画间隔和 `SpinnerGlyph` 的 120ms 换帧逻辑；这会显著增加 React 更新、Yoga 布局、屏幕 diff 和终端写出的次数，已经不是"把显示器切到 120Hz"这么简单。

上游 Ink 的文档把 `maxFps` 描述成渲染更新的上限，并明确提醒更高值可能增加性能开销；Claude Code 2.1.88 的内置 renderer 并没有把这个上游选项暴露成自己的配置项。全屏渲染文档也指出，真正的瓶颈可能在 VS Code 集成终端、tmux 或 iTerm2 的终端吞吐；即使程序请求 120fps，终端也可能合并、延迟或来不及绘制这些 ANSI 更新。JavaScript 定时器同样只是"至少等待指定延迟"，事件循环繁忙时回调会晚于目标时间。

所以答案分三层，**用户配置不能调；自己维护源码可以改，但要连带检查所有时钟消费者；改完也只能提高上限，不能保证终端实际达到 120Hz。**

</details>

## 留给下一篇的问题

如果想自定义 Claude Code 的快捷键，应该如何实现？

## 相关链接

- **上一篇**，[32 Ink TUI 与交互式 REPL 如何渲染与刷新](./32-ink-tui-and-repl.md)，`useInput()` 与事件传播
- **下一篇**，[34 无头 SDK 与结构化输入输出如何工作](./34-headless-sdk-and-structured-io.md)，没有终端时的输入路径
- **平行阅读**，[27 MCP 集成如何工作](./27-mcp-integration.md)，快捷键配置文件的 watcher 与 MCP 热加载共享同一套监听模式
