---
title: "Claude Code源码解读33：终端编辑状态如何解析"
published: 2026-07-24T16:47:20+08:00
updated: 2026-07-24T16:47:20+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-33/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：REPL 能显示与接收输入以后，Claude Code 如何解析按键、管理快捷键上下文，并实现 Vim 的 normal、insert 与 operator-pending 状态？

先给结论：Claude Code 把这件事拆成了两台状态机。

第一台是快捷键解析器。终端字节先被归一化成 `input + Key`，再拿“当前激活的上下文、默认绑定、用户覆盖和未完成的 chord”做匹配。匹配成功就调用 action handler；只是某个组合键的前缀，就暂存 1 秒；没有匹配，事件才继续向输入组件传播。

第二台才是 Vim。它只在 Chat 输入最终落到 `VimTextInput` 后工作。源码的顶层 `VimState` 实际只有 `INSERT` 和 `NORMAL` 两种模式；常说的 operator-pending 并不是第三种顶层 mode，而是 `NORMAL.command` 中的 `operator`、`operatorCount`、`operatorFind`、`operatorTextObj` 等等待态。按下 `d` 不是立刻删除，而是先记住 operator，再等 `w`、`f<char>` 或 `i"` 补齐范围。

也就是说，`ctrl+x ctrl+e` 等待第二键，和 Vim 的 `d` 等待 motion，看起来都像“pending”，但属于两套不同的状态机。前者解决“哪个应用动作被触发”，后者解决“怎样编辑 prompt 文本”。

![快捷键解析与 Vim 状态机手绘图](/images/posts/claude-code-source-reading-33/33-keybindings-vim-mode-handdrawn.png)

## 一个按键不是一个字符

本文继续以 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码为边界。还原路径是阅读索引，不假定它等同于 Anthropic 内部仓库的原始目录。下面的代码只保留证明当前结论的分支，无关按键与 UI 分支会省略。

我们先从最底层的问题开始：用户按下 `Alt+B`，程序收到的并不一定是一个叫 `Alt+B` 的对象。传统终端可能发 ESC 前缀，Kitty keyboard protocol 会发 CSI u 序列，方向键、回车和鼠标又各有编码。快捷键系统如果直接比较原始字符串，同一个动作在不同终端里会变成不同配置。

`restored-src/src/ink/events/input-event.ts` 的 `parseKey()` 先把 `ParsedKey` 变成两份数据：`Key` 保存方向键、修饰键等布尔标志，`input` 保存可打印输入。下面是其中的关键收口：

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

`parseKey(keypress)` 接收 `ParsedKey`，返回 `[Key, string]`。`keypress.name` 是解析后的键名，`sequence` 是终端序列；`ctrl`、`shift`、`meta`、`option`、`super` 都是布尔值。`sequence` 为 `undefined` 时，`input` 回退为空字符串，而不是把未知序列写入 prompt。源码后续还专门处理 CSI u、modifyOtherKeys、数字键盘和无法识别的功能键，避免控制序列泄漏成普通文本。

这里已经能看到第一个平台边界：Ink 的历史兼容层把 `Alt` / `Option` 汇入 `meta`，因此传统终端里两者不能可靠区分；`super` 仍然独立，但只有支持 Kitty keyboard protocol 的终端才可能把 Cmd/Win 送进 PTY。配置文件能写出 `cmd+c`，不代表当前终端一定能产生它。

在新 Ink DOM 事件路径里，`KeyboardEvent` 又把同一个 `ParsedKey` 转成类似浏览器的 `keydown` 事件：可打印键使用字面字符，控制组合使用键名，特殊键使用 `return`、`down` 等名称。`Ink.dispatchKeyboardEvent()` 从当前 focus element 开始做 capture/bubble；只有没有 handler 调用 `preventDefault()` 时，Tab 才执行默认的焦点切换。这个事件路径解释了“按键怎样进入组件树”，而快捷键 action 的主要匹配仍使用 `InputEvent` 中的 `input + Key`。

## 绑定不是写死在组件里的按键判断

组件注册的是 `chat:submit`、`app:interrupt` 这类动作，不是到处重复判断 `key.return`。默认映射集中在 `restored-src/src/keybindings/defaultBindings.ts`，用户配置则被解析成同一种扁平结构。

`parseKeystroke()` 会处理修饰键别名和少量键名别名：

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

`parseChord(input)` 的 `input` 是开放字符串，例如 `ctrl+x ctrl+e`；空格分隔多个 keystroke，但单独一个空格被特殊解释成 Space 键。`parseBindings(blocks)` 的 `blocks` 是配置块数组，每块包含 `context` 与 `bindings`。`action` 可以是内置 action、符合 `command:<name>` 格式的命令绑定，或者 `null`；`null` 的含义不是“什么都没写”，而是显式解除默认绑定。

源码能够确认的配置上下文包括 `Global`、`Chat`、`Autocomplete`、`Confirmation`、`Help`、`Transcript`、`HistorySearch`、`Task`、`ThemePicker`、`Settings`、`Tabs`、`Attachments`、`Footer`、`MessageSelector`、`DiffDialog`、`ModelPicker`、`Select` 和 `Plugin`。action 列表也由 schema 封闭定义。

默认配置先进入数组，用户配置随后追加，所以覆盖机制不需要修改组件。`loadKeybindings()` 中的合并就是：

```ts
const defaultBindings = getDefaultParsedBindings()

if (!isKeybindingCustomizationEnabled()) {
  return { bindings: defaultBindings, warnings: [] }
}

const userParsed = parseBindings(userBlocks)
const mergedBindings = [...defaultBindings, ...userParsed]
```

`isKeybindingCustomizationEnabled()` 没有参数，读取 `tengu_keybinding_customization_release` 功能开关，并以 `false` 为回退值。开关关闭时，函数只返回默认绑定与空 warning；打开时才读取 `~/.claude/keybindings.json`，把用户绑定放在默认绑定之后。。

配置加载失败时也不是让 REPL 无法启动。文件不存在、格式错误或解析异常都会回退默认绑定；可诊断的问题被整理为 `parse_error`、`duplicate`、`reserved`、`invalid_context` 或 `invalid_action`，严重度是 `error` 或 `warning`。

## 它没有 trie，而是每次扫描候选前缀

多键 chord 很容易让人联想到前缀树。但 2.1.88 的实现更直接：绑定总量不大，每次输入都过滤激活上下文，再扫描是否存在“更长且当前序列是其前缀”的绑定。

核心逻辑在 `restored-src/src/keybindings/resolver.ts`：

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

`input` 是归一化后的可打印字符串，`key` 是特殊键与修饰键标志，`activeContexts` 是本次允许参与匹配的上下文，`bindings` 是默认与用户配置合并后的数组。`pending` 为 `null` 表示当前没有 chord；非 `null` 时保存此前已经命中的 keystroke。返回值可能是 `match`、`none`、`unbound`、`chord_started` 或 `chord_cancelled`，调用方必须分别处理。

匹配顺序有两个值得注意的细节。

第一，如果 `testChord` 仍可能扩展成更长 chord，resolver 优先返回 `chord_started`，即使当前序列也有单键精确匹配。这是消歧必须付出的等待成本。`KeybindingSetup` 同时维护 ref 和 React state：ref 让下一次按键立即看到 pending，state 负责刷新提示；`CHORD_TIMEOUT_MS` 固定为 1000，超时就清空。

第二，它用 `Map<chordString, action | null>` 先处理相同 chord 的覆盖。靠后的 `null` 可以真正取消默认长 chord，否则只解绑完整序列，却仍会让第一个键进入等待。完成前缀判断后，精确匹配同样遍历到底，因此匹配数组中最后一个候选胜出。

这也是为什么这里不应写成“上下文数组第一个一定胜出”。`useKeybinding()` 确实按“已激活上下文、当前组件上下文、Global”构造数组并去重，但 resolver 把它转成 `Set` 只用于筛选，最终赢家仍由 `bindings` 数组的先后决定。默认表与用户表的组织方式通常让更晚的具体绑定覆盖更早绑定；真正可由源码保证的规则是“参与匹配的候选中，靠后的精确项胜出”。

## 为什么还需要全局 ChordInterceptor

假设 `ctrl+x` 已经启动 chord，第二键 `e` 先被普通文本输入处理，编辑框就会多出一个 `e`，然后快捷键系统才发现组合完整。这不是显示问题，而是事件顺序错误。

因此 `KeybindingSetup` 把 `ChordInterceptor` 放在 children 之前。它先观察所有按键，只在 chord 相关分支中阻断传播：

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

这里的 `contexts` 来自已注册 handler 的 context、当前 active context 和 `Global`；`pendingChordRef.current` 为 `null` 或当前 chord 前缀。`stopImmediatePropagation()` 会阻止后续 `useInput` handler 看到同一次事件。`none` 不阻断，让文本输入、Vim 或其他更局部的 handler 继续处理；`match` 在完成 pending chord 时由 registry 找到 action handler 并调用。

单键 action 则由组件里的 `useKeybinding()` / `useKeybindings()` 处理。handler 同步返回 `false` 表示没有消费事件，允许继续传播；返回 `void` 或 `Promise<void>` 会被视为已处理。这个约定让“滚动没有实际移动时，把滚轮交给子列表”成为可能，也避免一个声明存在但当前无效的 action 永久吞键。

上下文本质上是 UI 所有权。确认框挂载时注册 `Confirmation`，历史搜索注册 `HistorySearch`，Chat 输入注册 `Chat`。它们决定某个动作此刻是否有资格响应，不会改变 QueryEngine、工具权限或 Agent 循环。快捷键最多触发“提交”“取消”“选择 yes”等宿主动作，不能凭一个绑定绕过工具授权。

## 冲突不是只看有没有重复键

`restored-src/src/keybindings/validate.ts` 会检查同一块 JSON 中的重复键、非法 context/action 和保留快捷键。不同 context 中都绑定 `enter` 是合法的，因为焦点与 overlay 会决定谁参与匹配。

真正不可重绑的项目在 `reservedShortcuts.ts` 中很少：`ctrl+c` 用于 interrupt/exit，`ctrl+d` 用于 exit，`ctrl+m` 与 Enter 在终端中发送相同 CR。`ctrl+z`、`ctrl+\\` 以及 macOS 的若干 Cmd 组合则是终端或系统可能提前截获的 warning/error。这个区分很重要：程序拒绝重绑和按键根本到不了程序，是两类失败。

默认绑定也包含平台回退。例如 Windows 终端缺少可靠 VT mode 时，模式切换从 `shift+tab` 回退为 `meta+m`；图片粘贴在 Windows 使用 `alt+v`，其他平台使用 `ctrl+v`。

到这里，快捷键系统已经做完它的工作：能解析成 action 的按键被消费；没有匹配的 Chat 输入继续落到文本组件。下面才进入 Vim。

## Vim 只有两个顶层模式

`restored-src/src/vim/types.ts` 把状态边界写得很明确：

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

`VimState.mode` 只有 `'INSERT'` 与 `'NORMAL'`。INSERT 的 `insertedText` 用于记录可被 `.` 重放的插入；NORMAL 的 `command` 是第二层判别联合。`Operator` 的可选值只有 `'delete'`、`'change'`、`'yank'`；`FindType` 是 `'f' | 'F' | 't' | 'T'`；`TextObjScope` 是 `'inner' | 'around'`。这些封闭值决定 transition 能穷举每个等待态。

初始化不是 Normal，而是 `{ mode: 'INSERT', insertedText: '' }`。另有 `PersistentState` 保存 `lastChange`、`lastFind`、register 内容和 linewise 标志；前两项初始为 `null`，register 初始为空字符串。它们跨 command 保存，但只活在这个输入组件实例的内存里，不能把它理解成会话 transcript 或系统剪贴板。

`VimTextInput` 并没有重新实现渲染。它调用 `useVimInput()` 生成一个兼容普通文本输入的 `inputState`，再交给同一个 `BaseTextInput`。因此 Vim 是输入语义适配层，不是另一套 REPL。

## Esc 为什么没有迁移成可配置 action

`useVimInput()` 先复用 `useTextInput()`，然后在 `handleVimInput()` 中按模式分流：

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

`handleVimInput(rawInput, key)` 的 `rawInput` 是未经过 Vim 解释的字符串，`key` 是 Ink 的按键标志。Ctrl 组合统一下放给基础输入，让 readline 风格与应用快捷键继续工作；Esc 在 INSERT 中固定切到 NORMAL，在 NORMAL 中固定取消 pending command；Enter 无论模式都交给基础输入，因此 NORMAL 下仍可提交 prompt。这些分支没有可选返回值，也不会进入 `transition()`。

源码注释明确说，INSERT → NORMAL 的 Esc 是 Vim 用户依赖的标准语义，所以故意没有迁移成可配置 keybinding。外层也配合这条规则：`CancelRequestHandler` 在 Vim INSERT 模式下不激活 `chat:cancel`；否则默认 `escape: chat:cancel` 会先被快捷键层吞掉，Vim 永远收不到 Esc。

切出 INSERT 时，`switchToNormalMode()` 会把非空 `insertedText` 记为 `lastChange`，并在不是行首时把光标左移一个 grapheme 位置。切回 INSERT 时清空本轮 `insertedText`。这里保存的是 dot-repeat 所需的编辑记忆，不是 React 展示状态；`mode` 另存在 `useState` 中，负责 footer 等组件刷新。

## operator-pending 是怎样推进的

NORMAL 输入最终交给 `transition(state.command, vimInput, ctx)`。这个函数只做两件事：返回 `next` 表示继续等待，返回 `execute` 表示信息已经足够，可以修改文本或光标。

从 idle 按下 `d` 时，`isOperatorKey('d')` 把它映射为 `delete`，返回 `{ type: 'operator', op: 'delete', count: 1 }`。再按 `w`，`handleOperatorInput()` 才构造执行闭包：

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

`state.op` 只能是 delete/change/yank，`state.count` 是 operator 前的计数，`input` 是当前 NORMAL 命令字符，`ctx` 提供文本、Cursor、setter、register 和 repeat 回调。返回 `next` 会继续停留在 NORMAL 的子状态；返回 `execute` 后，`useVimInput()` 在没有切入 INSERT 的情况下把 command 复位到 `idle`。未知输入不会猜测，直接取消当前 operator。

这套拆分可以自然表达组合语法：`dd` / `cc` / `yy` 进入整行操作；`d3w` 进入 `operatorCount`；`dfx` 进入 `operatorFind`；`di"` 先进入 `operatorTextObj(inner)`，再等待对象类型。operator 前后的 count 会相乘，累计数字被 `MAX_VIM_COUNT = 10000` 截断，避免异常长数字让 motion 循环失控。

`change` 和 `delete` 的差异不只是最终文本。`applyOperator()` 对 yank 只更新 register 和光标，对 delete 拼接范围两侧，对 change 删除范围后调用 `enterInsert(from)`。所以图中的 change 箭头会回到 INSERT，而 delete/yank 完成后回到 NORMAL idle。

## motion 计算与文本修改为什么分开

`resolveMotion(key, cursor, count)` 是纯位置计算：`h/l/j/k`、`w/b/e`、`0/^/$` 等命令不断产生新 `Cursor`，到达边界时提前停止。operator 再根据 motion 是否 inclusive、linewise，决定真正的 `[from, to)` 范围。

这种分层解决了两个问题。

一是同一个 motion 可以独立移动，也可以被 `d/c/y` 复用。`w` 只移动；`dw` 先算目标，再删除范围。二是文本边界集中处理。`x`、replace 和普通 motion 按 grapheme 推进，不直接用 UTF-16 code unit；word motion 落进 `[Image #N]` 占位片段时，operator range 会扩到整个 image ref，避免删除半个占位符。

源码也保留了 Vim 的特殊规则。例如 `cw` / `cW` 不是简单走到下一个词首，而是改到当前词尾；`j/k/G/gg` 与 operator 结合时按整行处理；`f/F/t/T` 会更新 `lastFind`，`;` 和 `,` 再按原方向或反方向重复。。

## 两套 pending 怎样避免互相踩踏

现在可以把整条链收回来。

终端输入先经过全局 chord interceptor。若它是一个有效 action 或 chord 前缀，事件被消费，Vim 看不到它；若结果是 `none`，事件继续传播到 Chat 输入。Vim INSERT 把普通字符交给基础文本编辑器；Vim NORMAL 把字符解释为 command state transition。

这里不是简单的“快捷键优先级高于 Vim”规则，而是组件按场景注册 handler。例如 Vim INSERT 时，外层主动停用 Esc 的 `chat:cancel`，把 Esc 留给模式切换；有任务运行且 Vim 已在 NORMAL 时，Esc 才可以由取消 handler 接管。控制键也由 `useVimInput()` 下放，避免 Vim 字符命令吞掉 `ctrl+c` 等全局动作。

远程或 headless 模式没有终端按键，自然也不需要维持 chord 与 Vim command state。它们向核心提交的仍是 user message、permission response 或 control event。换句话说，Keybindings 与 Vim 都属于交互宿主：它们决定 prompt 怎样被编辑、哪个 UI 动作被调用，不改变同一条 Agent 查询循环的工具与权限语义。

## 小结

Claude Code 的终端输入不是一组散落的 `if (key === ...)`，而是两层可组合机制。

快捷键层把终端差异归一化成 `input + Key`，用 context 过滤绑定，用数组末项实现用户覆盖，用前缀扫描和 1 秒 pending 支持 chord，再通过事件传播把未消费输入交给组件。它的边界是终端协议、操作系统保留键与运行时功能开关。

Vim 层复用普通文本输入，只增加 `INSERT | NORMAL` 顶层状态、NORMAL 内部 command 状态机，以及 register、lastFind、lastChange 等短期记忆。operator-pending 是 NORMAL 的子状态，不是第三个模式；motion 负责算范围，operator 负责应用修改，change 才会切回 INSERT。

这套实现的意义不在于复刻完整 Vim，而在于把“应用快捷键”和“编辑语言”分开。前一层可以随着 overlay、焦点和用户配置变化，后一层仍然用确定的状态转移解释 `d3w`、`ci"` 或 `.`。

## 留给下一篇的问题

交互式 REPL 之外，Claude Code 如何在 `-p`、SDK 与结构化输入输出模式下运行同一套 Agent 循环，并处理不可交互的权限请求？

