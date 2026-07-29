---
title: "Claude Code源码解读21：用户如何进入不同执行流程"
published: 2026-07-24T16:47:08+08:00
updated: 2026-07-24T16:47:08+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-21/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 本章先建立三个概念

- **显式路由**：斜杠命令把用户意图直接交给已注册 handler，绕开自然语言工具选择。

- **Handler 类型**：本地执行、提示词展开和运行时控制拥有不同输入输出与权限边界。

- **能力裁剪**：交互、无头和远程宿主按可承接能力过滤命令集合。

![命令解析、查找与 handler 路由](/images/posts/claude-code-source-reading-21/21-command-routing-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

上一篇留下的问题是：作为用户，你应该什么时候使用 `branch`，什么时候使用 `fork`？

先把结论说清楚：在 Claude Code 里，`branch` 不是 Git branch，`fork` 也不是 GitHub 仓库 fork。两者最终都做同一件事——从已有会话复制出一份新的 transcript，分配新的 session ID，让原会话保持不变；差别主要在入口和进程边界。

如果你已经在交互式 REPL 里，并且刚走到一个需要比较方案的决策点，优先用 `/branch [name]`。它从当前对话点复制主链，立即切换到新会话；你可以在新会话里试重构、替换实现或验证另一种排查路径，原来的上下文仍可通过 `/resume` 找回。这种方式适合“先保留现场，再在同一终端继续探索”。

如果你要从另一个终端、脚本或程序中派生会话，则使用 `claude --continue --fork-session`、`claude --resume <session-id> --fork-session`，或 SDK 的 `forkSession: true`。这里的 fork 是更通用的会话复制机制：调用方明确提供来源 session，得到独立的 session ID，适合并行运行多个尝试、批量自动化，或在启动新进程时复用已有上下文。

因此可以按三个问题选择：

1. **还在当前 REPL、只想从此刻试另一条路？** 用 `branch`（`/branch`）。
2. **需要新进程、另一个终端或程序化调用？** 用 `fork`（`--fork-session` / `forkSession`）。
3. **只是继续原来的工作？** 用 `--continue` 或 `--resume`，不要额外复制会话。

还有一个必须提前设定的边界：session fork 只复制对话历史，不复制工作目录，也不会撤销已经执行的 Bash、网络请求、部署或其他外部副作用。要让两条实现真正同时改动而互不覆盖，还需要 Git worktree、独立目录或 checkpoint；`branch`/`fork` 解决的是“上下文分叉”，不是“文件系统分叉”。

从 2.1.88 的实现看，`/branch` 对应 `createFork()`：它立即复制主链 JSONL，并给复制记录附上 `forkedFrom`；`--fork-session` 则在恢复流程里保留 fresh session ID，后续由正常写入路径落到新 transcript。理解这层关系后，`branch` 可以看成一个交互式 fork 入口，而不是与 fork 并列的另一种会话类型。

本文继续限定在 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码。还原路径用于定位证据，不代表 Anthropic 内部仓库的原始目录结构。下面只摘录能证明控制流的真实短代码，省略无关字段、遥测和实验分支。

## Command 首先是一种显式路由

在普通 CLI 程序里，command 往往指 `git commit` 这种进程启动参数。Claude Code 的 Command 系统处理的是 REPL 内部的 `/name args`：进程已经启动，会话也已经存在，用户只是要求当前运行时切换到另一条处理路径。

斜杠命令需要访问当前消息历史、权限上下文、模型选择、MCP 连接、React 状态和恢复函数；执行完以后，有的返回文本，有的修改本地状态，有的再发起一次模型查询。因此，它由 REPL 内部路由表承接，与顶层 CLI 参数解析器分工。

源码用一个判别联合把三种控制权写进类型：

```ts
export type Command = CommandBase &
  (PromptCommand | LocalCommand | LocalJSXCommand)

type LocalCommand = {
  type: 'local'
  supportsNonInteractive: boolean
  load: () => Promise<LocalCommandModule>
}

type LocalJSXCommand = {
  type: 'local-jsx'
  load: () => Promise<LocalJSXCommandModule>
}
```

**类型说明：** `Command` 由公共元数据 `CommandBase` 与三个互斥分支组成。`type` 只能是 `'prompt'`、`'local'`、`'local-jsx'`，调用方可以据此做穷尽分派。`prompt` 的定义还包含 `getPromptForCommand()`；两个本地类型则通过 `load()` 延迟加载实现，避免 REPL 启动时把所有命令 UI 和依赖一次性载入。

**字段说明：** `supportsNonInteractive` 只存在于 `local`，布尔值必须由每个命令明确声明；它决定该本地命令能否进入 `-p` 的候选集合。`load()` 必须返回带 `call()` 的模块。`local-jsx` 依赖终端 UI 承接 React 节点，因此 2.1.88 的无头命令过滤会直接排除这一类型。

这个联合类型集中定义后续分流。新增命令必须选择控制权属于模型、本地函数还是 UI；选择以后，运行时统一负责消息包装、错误处理和是否继续查询。

![Claude Code 斜杠命令解析与三类执行路径手绘图](/images/posts/claude-code-source-reading-21/21-command-system-handdrawn.png)

图里最重要的控制字段是 `shouldQuery`，它只出现在通往 Query Loop 的路径上。`local` 可以产生输出，`local-jsx` 可以产生界面，但二者都不会因此自动调用模型。

## 命令表由多类来源装配而成

用户在输入框里看到的命令，不只来自 `src/commands/`。`loadAllCommands()` 同时收集内置命令、Skill 目录、插件命令、插件 Skill、bundled Skill、工作流，以及运行期间发现的动态 Skill。

```ts
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const [
    { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
    pluginCommands,
    workflowCommands,
  ] = await Promise.all([
    getSkills(cwd),
    getPluginCommands(),
    getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
  ])

  return [
    ...bundledSkills,
    ...builtinPluginSkills,
    ...skillDirCommands,
    ...workflowCommands,
    ...pluginCommands,
    ...pluginSkills,
    ...COMMANDS(),
  ]
})
```

**函数说明：** `loadAllCommands()` 以 cwd 为缓存键，并行加载几类外部来源，最后把它们和 `COMMANDS()` 中的内置命令拼成一个数组。`memoize()` 让磁盘扫描与动态 import 的结果复用；插件或 Skill 改变时，cache clear 路径使下一次调用重新装配。

**参数说明：** `cwd` 是必填路径字符串，用于发现项目级 Skill 和工作流，调用方必须显式提供。`getWorkflowCommands` 在构建裁剪后可以是 `null`，此时明确回退为空数组。各加载器的失败处理各有分支。

真正查找时使用数组的第一个匹配项，因此装配顺序会决定重名结果；动态 Skill 还会先按 `name` 去重，再插到插件来源之后、内置命令之前。读源码时必须区分磁盘定义与当前会话 `commands` 中最终保留的项。

装配之后还要过滤可用性：

```ts
export async function getCommands(cwd: string): Promise<Command[]> {
  const allCommands = await loadAllCommands(cwd)
  const dynamicSkills = getDynamicSkills()

  const baseCommands = allCommands.filter(
    _ => meetsAvailabilityRequirement(_) && isCommandEnabled(_),
  )

  if (dynamicSkills.length === 0) {
    return baseCommands
  }
  // dynamic skill dedupe and insertion omitted
}
```

**函数说明：** `getCommands()` 先取得已经装配的命令，再重新计算认证/Provider 可用性和运行期开关；随后才合并文件操作期间发现的动态 Skill。这里每次都重新过滤，是为了让 `/login` 之类会改变认证状态的操作不受旧过滤结果束缚。

**参数说明：** `cwd` 必填并原样传给 `loadAllCommands()`。`availability` 省略时默认可用；源码可确认的候选值只有 `'claude-ai'` 和 `'console'`，数组中满足任意一个即可。`isEnabled` 是可选函数，`undefined` 回退 `true`；显式返回 `false` 才被过滤。`dynamicSkills` 为空时直接返回 `baseCommands`，跳过插入逻辑。

这里还要区分三个看起来相似的字段：

- `availability` 回答“当前认证/Provider 是否符合静态要求”。
- `isEnabled()` 回答“这个功能此刻是否被平台、环境变量或 feature gate 打开”。
- `isHidden` 只控制 typeahead/help 的可见性；`getCommands()` 仍会保留该命令。



## 解析器只负责切开名字和原始参数

输入 `/review src/auth "only errors"` 以后，第一步只做克制的词法切分：

```ts
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmedInput = input.trim()
  if (!trimmedInput.startsWith('/')) return null

  const withoutSlash = trimmedInput.slice(1)
  const words = withoutSlash.split(' ')
  if (!words[0]) return null

  let commandName = words[0]
  let isMcp = false
  let argsStartIndex = 1
  if (words.length > 1 && words[1] === '(MCP)') {
    commandName = commandName + ' (MCP)'
    isMcp = true
    argsStartIndex = 2
  }

  return {
    commandName,
    args: words.slice(argsStartIndex).join(' '),
    isMcp,
  }
}
```

**函数说明：** `parseSlashCommand()` 去掉首尾空白，要求第一个有效字符是 `/`，把第一个空格分隔词作为命令名，其余部分重新连接为参数字符串。第二个词恰好为 `'(MCP)'` 时，它会被并入命令名，并把 `isMcp` 设为 `true`；这是 MCP 命令显示格式的兼容分支。

**参数说明：** `input` 是必填字符串，类型排除 `undefined` 与 `null`。返回值是 `ParsedSlashCommand | null`：首字符偏离 `/` 或 `/` 后命令名为空时返回 `null`。成功时 `args` 始终是字符串，省略参数时为 `''`；`isMcp` 默认 `false`，只有严格命中第二词 `'(MCP)'` 才为 `true`。

注意，这里只保留原始参数串，参数数量与引号语义交给具体命令解释。这样 `/review` 可以把整段文本交给 prompt，`/resume` 可以自己解释会话 ID，交互式命令也可以把字符串当作 UI 初始值。

Skill/自定义 prompt 中的占位符替换是后续另一层。`substituteArguments()` 支持完整 `$ARGUMENTS`、索引 `$ARGUMENTS[0]`、简写 `$0` 与命名参数；其中参数 token 才尝试使用 shell quote 解析，失败时回退空白切分。也就是说，“识别这是哪个命令”和“解释该命令参数”被有意拆开了。

## 输入层先分模式，再决定斜杠是否有特殊含义

`processUserInputBase()` 是真正把普通消息和命令分开的地方。它先处理图片、粘贴内容和附件边界，然后按输入模式分流：

```ts
if (inputString !== null && mode === 'bash') {
  const { processBashCommand } = await import('./processBashCommand.js')
  return processBashCommand(/* omitted */)
}

if (
  inputString !== null &&
  !effectiveSkipSlash &&
  inputString.startsWith('/')
) {
  const { processSlashCommand } = await import('./processSlashCommand.js')
  return processSlashCommand(/* omitted */)
}

return processTextPrompt(/* omitted */)
```

**函数说明：** 这段位于 `processUserInputBase()`。Bash 模式优先进入 `processBashCommand()`；允许斜杠解析且以 `/` 开头的字符串进入 `processSlashCommand()`；其余输入继续走普通文本处理。两个处理器都用动态 import，只在命中分支时加载。

**参数说明：** `inputString` 的类型是 `string | null`，当原始输入是内容块数组时为 `null`，不会触发字符串命令解析。`mode` 的实际来源是输入组件，代码在这里显式处理 `'bash'`，普通交互路径使用 `'prompt'`。`effectiveSkipSlash` 是布尔值，通常继承可选参数 `skipSlashCommands`；它为真时，即使输入以 `/` 开头也按普通文本处理。`startsWith('/')` 是严格首字符检查，而前面的输入流程已保留用于解析的字符串。

为什么远程消息要能跳过命令？因为 `/config` 在本地终端里可以打开 Ink 面板，Remote Control 则缺少可接管的本地面板。2.1.88 对 bridge 输入默认保留 `skipSlashCommands`，只允许显式判定安全的命令穿过：`prompt` 类型可以扩成文本，`local` 必须在 allowlist 中，`local-jsx` 一律拦截。

因此，“以 `/` 开头”只在允许本地命令解析的输入来源里具有路由意义。这个边界还能防止远端文本无意触发本地状态修改。

## 查找同时接受内部名、显示名和别名

解析器得到 `commandName` 后，运行时在会话的命令集合里寻找第一个匹配项：

```ts
export function findCommand(
  commandName: string,
  commands: Command[],
): Command | undefined {
  return commands.find(
    _ =>
      _.name === commandName ||
      getCommandName(_) === commandName ||
      _.aliases?.includes(commandName),
  )
}

export function getCommandName(cmd: CommandBase): string {
  return cmd.userFacingName?.() ?? cmd.name
}
```

**函数说明：** `findCommand()` 按数组顺序匹配内部 `name`、`getCommandName()` 返回的用户可见名称，以及 `aliases`。`getCommandName()` 允许插件等来源保留带前缀的内部唯一名，同时向用户展示另一个名称。

**参数说明：** `commandName` 是解析出的开放字符串，按原大小写查找；`commands` 是当前上下文的必填数组。返回 `Command | undefined`，零命中时为 `undefined`。`aliases` 与 `userFacingName` 都可省略；`aliases === undefined` 时可选链产生 `undefined`，匹配失败；`userFacingName === undefined` 或其调用结果为 nullish 时回退 `cmd.name`。

别名直接参与同一个 Command 对象的查找。例如 `/reset` 可以命中 `clear` 的 alias，随后遥测、显示名和具体实现继续使用其规范 `name`。

未知输入会多做一层路径判断。`processSlashCommand()` 先检查 `hasCommand()`；若名字看起来像命令、同时 `/${commandName}` 对应路径缺失，就返回 `Unknown skill`，`shouldQuery: false`。如果它更像路径或普通输入，则保留原始字符串并返回 `shouldQuery: true`，让模型看到它。

这个回退是为了不把 `/tmp/report` 之类绝对路径误判成拼错的命令。代价是未知斜杠输入的行为依赖 `looksLikeCommand()` 和一次文件 `stat`，不能简单概括为“一律报错”或“一律发给模型”。

## 三类 handler 决定消息是否进入 Query Loop

命中 Command 后，`getMessagesForSlashCommand()` 使用 `switch (command.type)` 做最终分派。我们先看最容易理解的 `local`：

```ts
case 'local': {
  const mod = await command.load()
  const result = await mod.call(args, context)

  if (result.type === 'skip') {
    return { messages: [], shouldQuery: false, command }
  }

  if (result.type === 'compact') {
    return {
      messages: buildPostCompactMessages(/* omitted */),
      shouldQuery: false,
      command,
    }
  }

  return {
    messages: [userMessage, createCommandInputMessage(
      `<local-command-stdout>${result.value}</local-command-stdout>`,
    )],
    shouldQuery: false,
    command,
    resultText: result.value,
  }
}
```

**函数说明：** `local` 分支延迟加载模块并调用 `call(args, context)`。返回值只能是 `text`、`compact` 或 `skip`：文本被包装为本地命令输出，compact 重建压缩后的消息，skip 不留下消息。三个正常出口都把 `shouldQuery` 固定为 `false`。

**参数说明：** `args` 是解析器产生的字符串，缺省参数表现为 `''`；`context` 是包含工具状态和本地 JSX 能力的必填上下文。`result.type` 的候选值是 `'text' | 'compact' | 'skip'`。`compact.displayText` 可为 `undefined`，省略时跳过显示文本；`text.value` 是必填字符串。异常会被捕获并包装为 `<local-command-stderr>`，仍不查询模型。

**字段说明：** 三个出口都返回 `messages`、`shouldQuery`、`command`；文本分支额外返回 `resultText: result.value`。skip 使用空 `messages`，compact 使用 `buildPostCompactMessages()`，文本分支组合 `userMessage` 与本地 stdout 消息。

`local-jsx` 的 handler 返回 React 节点，并通过回调决定何时结束：

```ts
const onDone = (result?: string, options?: {
  display?: 'skip' | 'system' | 'user'
  shouldQuery?: boolean
  metaMessages?: string[]
  nextInput?: string
  submitNextInput?: boolean
}) => {
  if (options?.display === 'skip') {
    resolve({ messages: [], shouldQuery: false, command })
    return
  }

  resolve({
    messages: /* local transcript messages omitted */,
    shouldQuery: options?.shouldQuery ?? false,
    command,
    nextInput: options?.nextInput,
    submitNextInput: options?.submitNextInput,
  })
}
```

**字段说明：** `onDone` 的 `result` 是可选文本；`options` 可包含 `display`、`shouldQuery`、`metaMessages`、`nextInput`、`submitNextInput`。`display: 'skip'` 返回空 `messages`；普通完成使用本地 transcript `messages`，并让 `shouldQuery` 缺省为 `false`。

**函数说明：** `onDone()` 是 `local-jsx` 实现拿到的完成回调。命令可以先返回 JSX 供 `setToolJSX()` 渲染，等用户在面板里完成选择后再调用 `onDone()`。运行时随后清理界面、整理 transcript，并把结果交回输入执行器。

**参数说明：** `result` 是 `string | undefined`。`options` 整体可省略；`display` 可选 `'skip'`、`'system'`、`'user'`，未设置时走 user 形式，`'skip'` 明确不写消息。`shouldQuery` 是可选布尔值，`undefined` 回退 `false`；因此 UI 命令可以主动要求把结果交给模型，但不会默认这样做。`metaMessages` 默认为空数组，内容对模型可见、对用户隐藏。`nextInput` 可预填下一次输入；`submitNextInput` 可选布尔值，控制是否自动提交。

这也是为什么 React 适合这条路径。命令可能需要一个 picker、确认框或设置面板，完成时间取决于用户交互，单个同步字符串返回值表达不了这种生命周期。React 节点负责描述界面，`onDone()` 负责把 UI 的终态重新转换成命令结果。

最后是 `prompt`：

```ts
case 'prompt': {
  if (command.context === 'fork') {
    return executeForkedSlashCommand(/* omitted */)
  }
  return getMessagesForPromptSlashCommand(
    command,
    args,
    context,
    precedingInputBlocks,
    imageContentBlocks,
    uuid,
  )
}
```

**函数说明：** `prompt` 分支不会在这里直接调用 Claude API。它先把命令内容转换为消息；`context === 'fork'` 时交给隔离的 sub-agent 执行，否则通过 `getMessagesForPromptSlashCommand()` 在当前会话内展开。后者返回 `shouldQuery: true`，上层再把消息送入 Query Loop。

**参数说明：** `command.context` 可为 `'inline' | 'fork' | undefined`，`undefined` 按 inline 路径处理。`args` 是原始参数字符串。`precedingInputBlocks` 与 `imageContentBlocks` 是数组，调用方必传；函数签名内部的默认值是空数组。`uuid` 是 `string | undefined`，用于保持输入消息身份；省略不阻止命令执行。

inline prompt 命令通常会生成四类内容：命令加载元数据、真正的 prompt/Skill 内容、从内容中发现的附件，以及 `command_permissions` 附件。`allowedTools` 缺省时回退空数组；`model`、`effort` 都可以是 `undefined`，此时不会由命令覆盖当前选择。也就是说，命令不仅能改写文字，还能为这一轮携带受限的工具和模型配置。

这里必须守住证据边界：`shouldQuery: true` 只说明消息已进入查询流程；是否调用工具、是否成功仍受权限、上下文、API 错误、取消和 query loop 停止条件约束。

## 参数替换遵循固定占位符规则

prompt 命令和 Skill 常需要把 `/review src/auth` 中的参数填进模板。2.1.88 的替换规则是明确的：

```ts
export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder = true,
  argumentNames: string[] = [],
): string {
  if (args === undefined || args === null) return content

  const parsedArgs = parseArguments(args)
  // named, indexed and shorthand replacements omitted
  content = content.replaceAll('$ARGUMENTS', args)

  if (content === originalContent && appendIfNoPlaceholder && args) {
    content = content + `\n\nARGUMENTS: ${args}`
  }
  return content
}
```

**函数说明：** `substituteArguments()` 先解析参数 token，再依次处理命名占位符、`$ARGUMENTS[n]`、`$n` 和完整 `$ARGUMENTS`。模板未使用占位符、允许追加且参数非空时，原始参数会以 `ARGUMENTS:` 段落附到末尾。

**参数说明：** `content` 是必填模板字符串。类型虽然把 `args` 写为 `string | undefined`，实现也显式接受运行时 `null`：二者都原样返回模板；空字符串 `''` 则是有效输入，会把占位符替换为空。`appendIfNoPlaceholder` 默认 `true`；显式 `false` 禁止末尾追加。`argumentNames` 默认空数组，名称来自 frontmatter，开放输入但会在解析时过滤空值和纯数字名称。缺少的索引/命名实参回退 `''`。

参数先尝试按 shell quote 规则切分，使 `"hello world"` 成为一个位置参数；解析失败则回退简单空白切分。该步骤只生成 prompt 内容，Bash 执行仍需走工具权限路径。

## 无头模式和远程模式会裁掉不能承接的命令

同一个 Command 系统要服务交互式 REPL 和 `claude -p`，但两种宿主能力不同。主入口为无头模式构造命令集合时使用这样的过滤：

```ts
const commandsHeadless = disableSlashCommands
  ? []
  : commands.filter(
      command =>
        (command.type === 'prompt' && !command.disableNonInteractive) ||
        (command.type === 'local' && command.supportsNonInteractive),
    )
```

**代码说明：** 这段位于 `main.tsx` 的启动装配。禁用斜杠命令时直接给无头执行器空数组；否则保留允许 non-interactive 的 prompt 命令，以及明确声明支持 non-interactive 的 local 命令。`local-jsx` 在该过滤器中始终被排除。

**参数说明：** `disableSlashCommands` 是布尔值，真值表示不加载任何 Skill/斜杠命令；假值进入过滤。`PromptCommand.disableNonInteractive` 是可选布尔值，`undefined` 经 `!` 判断等同允许；显式 `true` 才排除。`LocalCommand.supportsNonInteractive` 是必填布尔值，只有 `true` 保留。

这个过滤说明命令定义与入口资格分属两层。交互式界面能等待 picker，`-p` 无法等待；Remote Control 可以安全展开 prompt，却不能让远端文字弹出本地配置面板。运行时会在入口处按宿主能力缩小命令集合。

`processSlashCommand()` 里仍有第二道保护：如果 `local-jsx` 意外在 non-interactive 上下文返回 JSX，源码会解析为空消息且 `shouldQuery: false`，并跳过渲染。这是对启动过滤的防御性补充。

## 为什么要把 Command、Skill 和 Query Loop 分开

把三层揉在一起，看起来可以少几个类型，实际上会制造三个问题。

第一，所有本地设置都要伪装成模型消息。切换主题、打开配置面板、复制上一条回复，本来不需要 token、网络和模型不确定性。

第二，所有 prompt 扩展都要写成 UI handler。这样无头模式、插件和模型主动调用 Skill 就很难复用同一份能力描述。

第三，权限边界会变模糊。Command 负责“用户显式选择了哪条流程”，Skill/prompt 负责“向模型增加什么能力和上下文”，Query Loop 负责“模型与工具怎样继续执行”。本地命令能够读取共享状态，不代表它自动获得工具执行权限；prompt 命令声明 `allowedTools`，也只是给后续权限流程增加本轮配置。

因此，一个更准确的心智模型是：

`输入路由 → Command handler →（可选）模型消息 → Query Loop → 工具与权限`

其中前两步一定在本地发生，后面两步只有 `shouldQuery` 为真时才发生。React/Ink 是 `local-jsx` 命令承接用户交互的宿主；REPL 负责把终端事件转成结构化输入和状态变化。

## 小结

Claude Code 的 Command 系统是一层 REPL 内部路由。

输入层先决定斜杠是否具有命令语义；解析器只拆命令名与原始参数；当前会话的命令表再按内部名、显示名和 alias 找到定义。真正的执行方向由三值 `type` 决定：`prompt` 把内容组装成模型消息，`local` 在本地完成，`local-jsx` 用 Ink/React 等待用户交互。

`shouldQuery` 是三条路径重新汇合前的关键闸门。它为真，结果才进入 Query Loop；它为假，命令可以在本地结束。无头和远程入口还会按宿主能力过滤命令，避免缺少终端 UI 的调用误走交互路径。

这套分层让显式用户动作、能力扩展和 Agent 循环各自拥有清楚的职责。下一篇要继续追踪其中最容易混淆的一支：一个 prompt 型 Command 怎样进一步成为可发现、可按需加载的 Skill。

## 留给下一篇的问题

如果你在 Claude Code 中输入了一大段文字，然后回到开头在最前面输入 `/` 想选择一个 Skill，为什么这时不会弹出 slash 命令提示？

## 参考资料

- [Claude Code Commands](https://code.claude.com/docs/en/commands)

- [Claude Code 交互模式](https://code.claude.com/docs/en/interactive-mode)

- [Manage sessions - Claude Code Docs](https://code.claude.com/docs/en/sessions)

- [Work with sessions - Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/sessions)

- [Claude Code /branch: Fork Sessions to Test Multiple Paths](https://claudcod.com/blog/claude-code-branch-sessions/)
