---
title: "Claude Code源码解读21：用户如何进入不同执行流程"
published: 2026-07-24T16:47:08+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-21/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇留下的问题是，你知道 Claude Code 中 `/branch`、`/fork` 和 `/new` 的区别吗？

答案先放在前面，在 `@anthropic-ai/claude-code@2.1.88` 的默认外部构建里，`/branch` 和 `/fork` 是同一条“复制当前会话并切换过去”的路径；`/new` 则是 `/clear` 的别名，创建一个没有旧对话上下文的新会话。因此，默认语义下前两者复制历史，`/new` 不复制历史；如果启用 `FORK_SUBAGENT`，`/fork` 会切换成另一条后台子代理路径。

| 命令 | 2.1.88 中的实现 | 对话历史与 session ID | 适合什么时候用 |
| --- | --- | --- | --- |
| `/branch [name]` | `local-jsx` 命令调用 `createFork()`，复制当前 transcript 的主链并切换到新会话 | 原会话保留；新会话获得新的 session ID，并带有 `forkedFrom` 来源记录 | 想保留当前上下文，尝试另一种实现或排查路径 |
| `/fork` | 默认是 `/branch` 的 alias；命令行的 `--fork-session` 也是“恢复历史但使用新 session ID”的入口 | 默认 alias 情况下与 `/branch` 相同；不会删除原会话 | 从另一个终端、脚本或恢复入口派生一条独立会话 |
| `/new` | `clear` 命令的 alias，实际执行 `clearConversation()` | 清空当前消息、缓存、计划和会话元数据，生成新的 session ID；旧 transcript 仍可用 `/resume` 找回，但不会复制到新会话 | 当前任务已经结束，想从干净上下文开始新任务 |

`/branch` 的关键是“复制后切换”。源码先读取当前 JSONL，只保留主对话消息，然后为每条复制记录写入新的 `sessionId`、重建 `parentUuid`，并附上 `forkedFrom`；原 transcript 文件不改。`--fork-session` 走的是另一入口，恢复流程加载旧历史，但保留启动时的 fresh session ID，后续消息再写入新 transcript。两者的结果相似，创建时机和来源记录不同。

`/new` 的关键则是“不要带历史”。源码把 `clear` 定义为一个 `local` 命令，并声明 `aliases: ['reset', 'new']`。`clearConversation()` 会清空消息、文件状态和计划缓存，清理会话元数据，调用 `regenerateSessionId({ setCurrentAsParent: true })`，再执行 `SessionStart('clear')` Hook。它没有复制旧 JSONL，也不会回滚已经执行的工具、文件修改或网络副作用；“新”只是新的对话坐标，不是新的工作目录。

还要留意 `/fork` 的版本/构建边界。`branch/index.ts` 中的定义是，当 `FORK_SUBAGENT` 没打开时，`aliases` 为 `['fork']`；打开该 feature 后，alias 被移除，`commands.ts` 才会装配独立的 `forkCmd`。对应的 `AgentTool/forkSubagent.ts` 会让 `/fork <directive>` 走后台 forked subagent，子代理继承父会话上下文并把结果回传，而不是把当前 REPL 切换到一份新 transcript。也就是说，不能脱离版本和 feature gate，直接把 `/fork` 固定解释成唯一含义。

最后再划一条边界，会话分叉不等于 Git 分支或 worktree 隔离。`/branch`、默认语义下的 `/fork` 只复制消息历史，当前工作目录和已经产生的外部副作用仍在原现场；需要同时尝试会改文件的方案时，还要配合 Git worktree、独立目录或 checkpoint。`/new` 更不会帮你隔离文件，它只是把模型看到的对话上下文清空。

本文继续限定在 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码。还原路径用于定位证据，不代表 Anthropic 内部仓库的原始目录结构。下面只摘录能证明控制流的真实短代码，省略无关字段、遥测和实验分支。

## 介绍本章的一些概念

- **Command 首先是一种显式路由**，不是字符串替换。`loadAllCommands()` 把内置、Skill、Plugin、MCP prompt 合并成注册表；解析器只切出命令名和原始参数，真正的 handler 才决定是否读取会话状态、修改本地缓存或再次进入 query loop。
- 三条执行路径由判别联合的 `type` 字段决定，`'prompt'` 把内容组装成模型消息（`shouldQuery: true`），`'local'` 在本地完成并返回 `text | compact | skip`，`'local-jsx'` 用 Ink/React 等待用户交互、由 `onDone()` 回调回传结果。**三个正常出口中只有 prompt 默认会查询模型**。
- **输入层先分模式**，`processUserInputBase()` 按 `mode === 'bash'`、`effectiveSkipSlash`、`startsWith('/')` 分流；远程 bridge 输入默认跳过 slash 解析，避免远端文本触发本地状态修改。
- 无头模式按宿主能力裁剪命令集合，`claude -p` 只保留允许 non-interactive 的 `prompt` 命令和声明 `supportsNonInteractive` 的 `local` 命令，`local-jsx` 在启动过滤中被排除，运行时还有第二道防御。
- 参数替换遵循固定占位符规则，完整 `$ARGUMENTS`、索引 `$ARGUMENTS[0]`、简写 `$0` 与命名参数；模板未使用占位符且允许追加时，原始参数以 `ARGUMENTS:` 段落附到末尾。

> ⚠️ **证据边界**，本文全部引用 `restored-src/`（`@anthropic-ai/claude-code@2.1.88` source map 还原源码）。`Command.type` 的候选值只有 `'prompt' | 'local' | 'local-jsx'`；`availability` 可见值只有 `'claude-ai' | 'console'`。`isEnabled` 是否命中依赖运行时平台、环境变量与 feature gate，静态源码不能穷举实际开关值。

## 本篇新增

上一篇（20）讲会话如何恢复、续接与分叉；本篇把视角从"历史"转到"入口"，新增两个认知点，

- **Command 三类型决策树**，以一张从输入到 Query Loop 的 ASCII 树，一次看清 `prompt` / `local` / `local-jsx` 在解析、查找、执行、`shouldQuery` 四个环节的分岔。
- **`shouldQuery` 闸门模型**，三条路径最终以"是否把消息送进 Query Loop"重新汇合；`local-jsx` 的 `onDone()` 可以主动要求查询，但不会默认这样做。

## 问题

用户输入同样以 `/` 开头，可能是本地清理、提示词模板，也可能是需要进入 query loop 的运行时操作。若所有命令都走同一条字符串替换路径，权限、参数和无头模式的边界都会变得模糊。

![命令解析、查找与 handler 路由](/images/posts/claude-code-source-reading-21/21-command-routing-detail-handdrawn.png)

本文只追踪命令真正改变执行流程的地方，注册表如何合并来源，解析器如何得到命令名和参数，以及 handler 如何决定调用本地逻辑、展开 prompt 或提交查询。

## 正文

### Command 首先是一种显式路由

这里的 command 表示 REPL 中的 `/name args` 路由，不是进程启动参数。`loadAllCommands()` 把内置、Skill、Plugin 和 MCP prompt 合并成注册表；解析器只切出命令名和原始参数，handler 再决定是否读取会话状态、修改本地缓存或再次进入 query loop。这样 `/clear`、`/review` 和 `/mcp__server__prompt` 共用输入语法，却不会共用副作用边界。

源码用一个判别联合把三种控制权写进类型，

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
**类型说明，** `Command` 由公共元数据 `CommandBase` 与三个互斥分支组成。`type` 只能是 `'prompt'`、`'local'`、`'local-jsx'`，调用方可以据此做穷尽分派。`prompt` 的定义还包含 `getPromptForCommand()`；两个本地类型则通过 `load()` 延迟加载实现，避免 REPL 启动时把所有命令 UI 和依赖一次性载入。
**字段说明，** `supportsNonInteractive` 只存在于 `local`，布尔值必须由每个命令明确声明；它决定该本地命令能否进入 `-p` 的候选集合。`load()` 必须返回带 `call()` 的模块。`local-jsx` 依赖终端 UI 承接 React 节点，因此 2.1.88 的无头命令过滤会直接排除这一类型。

这个联合类型集中定义后续分流。新增命令必须选择控制权属于模型、本地函数还是 UI；选择以后，运行时统一负责消息包装、错误处理和是否继续查询。

### 这张金额单位工单的几条命令为什么走不同路径

工程师没有一上来就把长 prompt 粘进终端，而是按调查阶段输入了几条命令，

```text
/config
/plan
/incident 金额单位工单：先读 CLAUDE.md、工单和支付服务代码，确认元/分转换链路后再给计划
/branch integer-cents
/compact
```

他在 `/config` 里确认当前权限和外部连接，在 `/plan` 中要求只读地整理证据；`/incident` 把工单标题和约束展开成新的 prompt；发现需要比较两种修复方向时，`/branch` 保留原会话并创建分支；工具结果过多后，`/compact` 在进程内重建上下文。几条输入都以 `/name args` 开头，但每一步的状态、权限和副作用都不同。这也解释了为什么不能把 slash command 当作普通长 prompt 的一部分，命令解析器必须先在输入边界识别它。

以 2.1.88 的内置命令为例，先建立类型直觉，

| `type` | 典型命令 | 源码入口 | 执行结果 |
| --- | --- | --- | --- |
| `local` | `/clear`（别名 `/new`）、`/compact`、`/cost`、`/files`、`/version` | 命令对象提供 `load()`，模块再实现 `call()` | 在 CLI 进程本地完成，返回文本、压缩结果或 `skip`，不会进入模型查询 |
| `local-jsx` | `/branch`、`/config`、`/model`、`/permissions`、`/resume`、`/help` | `load()` 懒加载 React/Ink UI；结束时通过 `onDone()` 回传结果 | 打开选择器、表单或其他终端界面；`onDone()` 可以决定是否继续查询 |
| `prompt` | `/review`、`/commit`、`/commit-push-pr`、`/statusline` | 命令对象直接实现 `getPromptForCommand(args)` | 把命令参数展开成 `ContentBlockParam[]`，包装成消息后交给 Query Loop |

命令分类由命令对象上的字符串字面量字段 `type` 明确标记。`/review` 虽然最终会让模型分析 Pull Request，却仍然是 `prompt`，它的本地工作只是生成一段提示词；`/branch` 即使会改变当前会话，也属于 `local-jsx`，因为它需要先交给终端 UI 完成分支操作。命令的"名字"描述用户意图，`type` 决定 Claude Code 采用哪条控制流。

![Claude Code 斜杠命令解析与三类执行路径手绘图](/images/posts/claude-code-source-reading-21/21-command-system-handdrawn.png)

图里最重要的控制字段是 `shouldQuery`，它只出现在通往 Query Loop 的路径上。`local` 可以产生输出，`local-jsx` 可以产生界面，但二者都不会因此自动调用模型。

### 一条命令走哪条路的决策树（本篇新增）

把从输入到 Query Loop 的完整分岔压缩成一张树，

```text
输入字符串
│
├─ 不以 / 开头 → processTextPrompt（普通文本）
│
└─ 以 / 开头
   ├─ mode === 'bash' → processBashCommand（bash 模式）
   ├─ effectiveSkipSlash === true → 按普通文本处理（远程 bridge 默认）
   └─ parseSlashCommand() → { commandName, args, isMcp }
      │
      ├─ findCommand() 未命中
      │  ├─ 像命令名且 /路径 缺失 → "Unknown skill" · shouldQuery: false
      │  └─ 更像路径（如 /tmp/report.md）→ 原样给模型 · shouldQuery: true
      │
      └─ 命中 Command → switch (command.type)
         │
         ├─ 'prompt' → getPromptForCommand() 展开消息
         │  ├─ context === 'fork' → executeForkedSlashCommand（隔离 sub-agent）
         │  └─ inline → shouldQuery: true → 进入 Query Loop
         │
         ├─ 'local' → load() + call(args, context)
         │  └─ text | compact | skip · shouldQuery: false（永不查询）
         │
         └─ 'local-jsx' → load() 渲染 Ink/React 面板
            └─ onDone() 后由 options.shouldQuery 决定（默认 false）
```

树上每个分岔都对应一个真实判断，`mode` 与 `skipSlashCommands` 在输入层决定斜杠是否有命令语义；`findCommand()` 决定命中哪条定义；`switch (command.type)` 决定控制权归属；`shouldQuery` 决定结果是否送回模型。记住这张树，下面每一节都是在给它的某个节点补证据。

### 命令表由多类来源装配而成

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
**函数说明，** `loadAllCommands()` 以 cwd 为缓存键，并行加载几类外部来源，最后把它们和 `COMMANDS()` 中的内置命令拼成一个数组。`memoize()` 让磁盘扫描与动态 import 的结果复用；插件或 Skill 改变时，cache clear 路径使下一次调用重新装配。
**参数说明，** `cwd` 是必填路径字符串，用于发现项目级 Skill 和工作流，调用方必须显式提供。`getWorkflowCommands` 在构建裁剪后可以是 `null`，此时明确回退为空数组。

真正查找时使用数组的第一个匹配项，因此装配顺序会决定重名结果；动态 Skill 还会先按 `name` 去重，再插到插件来源之后、内置命令之前。读源码时必须区分磁盘定义与当前会话 `commands` 中最终保留的项。

装配之后还要过滤可用性，

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
**函数说明，** `getCommands()` 先取得已经装配的命令，再重新计算认证/Provider 可用性和运行期开关；随后才合并文件操作期间发现的动态 Skill。这里每次都重新过滤，是为了让 `/login` 之类会改变认证状态的操作不受旧过滤结果束缚。
**参数说明，** `cwd` 必填并原样传给 `loadAllCommands()`。`availability` 省略时默认可用；源码可确认的候选值只有 `'claude-ai'` 和 `'console'`，数组中满足任意一个即可。`isEnabled` 是可选函数，`undefined` 回退 `true`；显式返回 `false` 才被过滤。`dynamicSkills` 为空时直接返回 `baseCommands`，跳过插入逻辑。

这里还要区分三个看起来相似的字段，

- `availability` 回答"当前认证/Provider 是否符合静态要求"。
- `isEnabled()` 回答"这个功能此刻是否被平台、环境变量或 feature gate 打开"。
- `isHidden` 只控制 typeahead/help 的可见性；`getCommands()` 仍会保留该命令。

### 解析器只负责切开名字和原始参数

输入 `/review src/auth "only errors"` 以后，第一步只做克制的词法切分，

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
**函数说明，** `parseSlashCommand()` 去掉首尾空白，要求第一个有效字符是 `/`，把第一个空格分隔词作为命令名，其余部分重新连接为参数字符串。第二个词恰好为 `'(MCP)'` 时，它会被并入命令名，并把 `isMcp` 设为 `true`；这是 MCP 命令显示格式的兼容分支。
**参数说明，** `input` 是必填字符串，类型排除 `undefined` 与 `null`。返回值是 `ParsedSlashCommand | null`，首字符偏离 `/` 或 `/` 后命令名为空时返回 `null`。成功时 `args` 始终是字符串，省略参数时为 `''`；`isMcp` 默认 `false`，只有严格命中第二词 `'(MCP)'` 才为 `true`。

注意，这里只保留原始参数串，参数数量与引号语义交给具体命令解释。这样 `/review` 可以把整段文本交给 prompt，`/resume` 可以自己解释会话 ID，交互式命令也可以把字符串当作 UI 初始值。"识别这是哪个命令"和"解释该命令参数"被有意拆开；Skill/自定义 prompt 中的占位符替换是后续另一层（见下文）。

### 输入层先分模式，再决定斜杠是否有特殊含义

`processUserInputBase()` 是真正把普通消息和命令分开的地方。它先处理图片、粘贴内容和附件边界，然后按输入模式分流，

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
**函数说明，** 这段位于 `processUserInputBase()`。Bash 模式优先进入 `processBashCommand()`；允许斜杠解析且以 `/` 开头的字符串进入 `processSlashCommand()`；其余输入继续走普通文本处理。两个处理器都用动态 import，只在命中分支时加载。
**参数说明，** `inputString` 的类型是 `string | null`，当原始输入是内容块数组时为 `null`，不会触发字符串命令解析。`mode` 的实际来源是输入组件，代码在这里显式处理 `'bash'`，普通交互路径使用 `'prompt'`。`effectiveSkipSlash` 是布尔值，通常继承可选参数 `skipSlashCommands`；它为真时，即使输入以 `/` 开头也按普通文本处理。

为什么远程消息要能跳过命令？因为 `/config` 在本地终端里可以打开 Ink 面板，Remote Control 则缺少可接管的本地面板。2.1.88 对 bridge 输入默认保留 `skipSlashCommands`，只允许显式判定安全的命令穿过，`prompt` 类型可以扩成文本，`local` 必须在 allowlist 中，`local-jsx` 一律拦截。因此，"以 `/` 开头"只有在允许本地命令解析的输入来源里才会被当作路由符号。

### 查找同时接受内部名、显示名和别名

解析器得到 `commandName` 后，运行时在会话的命令集合里寻找第一个匹配项，

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
**函数说明，** `findCommand()` 按数组顺序匹配内部 `name`、`getCommandName()` 返回的用户可见名称，以及 `aliases`。`getCommandName()` 允许插件等来源保留带前缀的内部唯一名，同时向用户展示另一个名称。
**参数说明，** `commandName` 是解析出的开放字符串，按原大小写查找；`commands` 是当前上下文的必填数组。返回 `Command | undefined`，零命中时为 `undefined`。`aliases` 与 `userFacingName` 都可省略；`aliases === undefined` 时可选链产生 `undefined`，匹配失败；`userFacingName === undefined` 或其调用结果为 nullish 时回退 `cmd.name`。

别名直接参与同一个 Command 对象的查找。例如 `/reset` 可以命中 `clear` 的 alias，随后遥测、显示名和具体实现继续使用其规范 `name`。

未知输入会多做一层路径判断。`processSlashCommand()` 先检查 `hasCommand()`；若名字看起来像命令、同时 `/${commandName}` 对应路径缺失，就返回 `Unknown skill`，`shouldQuery: false`。如果它更像路径或普通输入，则保留原始字符串并返回 `shouldQuery: true`，让模型看到它。这个回退是为了不把 `/tmp/report` 之类绝对路径误判成拼错的命令；代价是未知斜杠输入的行为依赖 `looksLikeCommand()` 和一次文件 `stat`，不能简单概括为"一律报错"或"一律发给模型"。

### 三类 handler 决定消息是否进入 Query Loop

命中 Command 后，`getMessagesForSlashCommand()` 使用 `switch (command.type)` 做最终分派。先看最容易理解的 `local`，

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
**函数说明，** `local` 分支延迟加载模块并调用 `call(args, context)`。返回值只能是 `text`、`compact` 或 `skip`，文本被包装为本地命令输出，compact 重建压缩后的消息，skip 不留下消息。三个正常出口都把 `shouldQuery` 固定为 `false`。
**参数说明，** `args` 是解析器产生的字符串，缺省参数表现为 `''`；`context` 是包含工具状态和本地 JSX 能力的必填上下文。`result.type` 的候选值是 `'text' | 'compact' | 'skip'`。`compact.displayText` 可为 `undefined`，省略时跳过显示文本；`text.value` 是必填字符串。异常会被捕获并包装为 `<local-command-stderr>`，仍不查询模型。

`local-jsx` 的 handler 返回 React 节点，并通过回调决定何时结束，

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
**函数说明，** `onDone()` 是 `local-jsx` 实现拿到的完成回调。命令可以先返回 JSX 供 `setToolJSX()` 渲染，等用户在面板里完成选择后再调用 `onDone()`；运行时随后清理界面、整理 transcript，并把结果交回输入执行器。
**参数说明，** `result` 是 `string | undefined`。`options` 整体可省略；`display` 可选 `'skip'`、`'system'`、`'user'`，未设置时走 user 形式，`'skip'` 明确不写消息。`shouldQuery` 是可选布尔值，`undefined` 回退 `false`；因此 UI 命令可以主动要求把结果交给模型，但不会默认这样做。`metaMessages` 默认为空数组，内容对模型可见、对用户隐藏。`nextInput` 可预填下一次输入；`submitNextInput` 可选布尔值，控制是否自动提交。

这也是为什么 React 适合这条路径。命令可能需要一个 picker、确认框或设置面板，完成时间取决于用户交互，单个同步字符串返回值表达不了这种生命周期。React 节点负责描述界面，`onDone()` 负责把 UI 的终态重新转换成命令结果。

最后是 `prompt`，

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
**函数说明，** `prompt` 分支不会在这里直接调用 Claude API。它先把命令内容转换为消息；`context === 'fork'` 时交给隔离的 sub-agent 执行，否则通过 `getMessagesForPromptSlashCommand()` 在当前会话内展开。后者返回 `shouldQuery: true`，上层再把消息送入 Query Loop。
**参数说明，** `command.context` 可为 `'inline' | 'fork' | undefined`，`undefined` 按 inline 路径处理。`args` 是原始参数字符串。`precedingInputBlocks` 与 `imageContentBlocks` 是数组，调用方必传；函数签名内部的默认值是空数组。`uuid` 是 `string | undefined`，用于保持输入消息身份；省略不阻止命令执行。

inline prompt 命令通常会生成四类内容，命令加载元数据、真正的 prompt/Skill 内容、从内容中发现的附件，以及 `command_permissions` 附件。`allowedTools` 缺省时回退空数组；`model`、`effort` 都可以是 `undefined`，此时不会由命令覆盖当前选择。也就是说，命令不仅能改写文字，还能为这一轮携带受限的工具和模型配置。

这里必须守住证据边界，`shouldQuery: true` 只说明消息已进入查询流程；是否调用工具、是否成功仍受权限、上下文、API 错误、取消和 query loop 停止条件约束。

### 参数替换遵循固定占位符规则

prompt 命令和 Skill 常需要把 `/review src/auth` 中的参数填进模板。2.1.88 的替换规则是明确的，

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
**函数说明，** `substituteArguments()` 先解析参数 token，再依次处理命名占位符、`$ARGUMENTS[n]`、`$n` 和完整 `$ARGUMENTS`。模板未使用占位符、允许追加且参数非空时，原始参数会以 `ARGUMENTS:` 段落附到末尾。
**参数说明，** `content` 是必填模板字符串。类型虽然把 `args` 写为 `string | undefined`，实现也显式接受运行时 `null`，二者都原样返回模板；空字符串 `''` 则是有效输入，会把占位符替换为空。`appendIfNoPlaceholder` 默认 `true`；显式 `false` 禁止末尾追加。`argumentNames` 默认空数组，名称来自 frontmatter，开放输入但会在解析时过滤空值和纯数字名称。缺少的索引/命名实参回退 `''`。

参数先尝试按 shell quote 规则切分，使 `"hello world"` 成为一个位置参数；解析失败则回退简单空白切分。该步骤只生成 prompt 内容，Bash 执行仍需走工具权限路径。

### 无头模式和远程模式会裁掉不能承接的命令

同一个 Command 系统要服务交互式 REPL 和 `claude -p`，但两种宿主能力不同。主入口为无头模式构造命令集合时使用这样的过滤，

```ts
const commandsHeadless = disableSlashCommands
  ? []
  : commands.filter(
      command =>
        (command.type === 'prompt' && !command.disableNonInteractive) ||
        (command.type === 'local' && command.supportsNonInteractive),
    )
```
**代码说明，** 这段位于 `main.tsx` 的启动装配。禁用斜杠命令时直接给无头执行器空数组；否则保留允许 non-interactive 的 prompt 命令，以及明确声明支持 non-interactive 的 local 命令。`local-jsx` 在该过滤器中始终被排除。
**参数说明，** `disableSlashCommands` 是布尔值，真值表示不加载任何 Skill/斜杠命令；假值进入过滤。`PromptCommand.disableNonInteractive` 是可选布尔值，`undefined` 经 `!` 判断等同允许；显式 `true` 才排除。`LocalCommand.supportsNonInteractive` 是必填布尔值，只有 `true` 保留。

这个过滤说明命令定义与入口资格分属两层。交互式界面能等待 picker，`-p` 无法等待；Remote Control 可以安全展开 prompt，却不能让远端文字弹出本地配置面板。运行时会在入口处按宿主能力缩小命令集合。

`processSlashCommand()` 里仍有第二道保护，如果 `local-jsx` 意外在 non-interactive 上下文返回 JSX，源码会解析为空消息且 `shouldQuery: false`，并跳过渲染。这是对启动过滤的防御性补充。

### 为什么要把 Command、Skill 和 Query Loop 分开

把三层揉在一起会制造三个问题，所有本地设置（切主题、开面板、复制回复）都要伪装成模型消息，白白消耗 token；所有 prompt 扩展都要写成 UI handler，无头模式、插件和模型主动调用 Skill 就很难复用同一份能力描述；权限边界会变模糊，Command 负责"用户显式选择了哪条流程"，Skill/prompt 负责"向模型增加什么能力和上下文"，Query Loop 负责"模型与工具怎样继续执行"。本地命令能读共享状态，不代表它自动获得工具执行权限。

因此，更准确的心智模型是，

`输入路由 → Command handler →（可选）模型消息 → Query Loop → 工具与权限`

其中前两步一定在本地发生，后面两步只有 `shouldQuery` 为真时才发生。

### 小结

Claude Code 的 Command 系统是一层 REPL 内部路由。输入层先决定斜杠是否具有命令语义；解析器只拆命令名与原始参数；命令表按内部名、显示名和 alias 找到定义；真正的执行方向由三值 `type` 决定。`shouldQuery` 是三条路径重新汇合前的关键闸门，为真才进入 Query Loop，为假命令可以在本地结束；无头和远程入口还会按宿主能力过滤命令。

这套分层让显式用户动作、能力扩展和 Agent 循环各自拥有清楚的职责。下一篇继续追踪其中最容易混淆的一支，一个 prompt 型 Command 怎样进一步成为可发现、可按需加载的 Skill。

### processTextPrompt 是输入归一化与可观测性边界

`restored-src/src/utils/processUserInput/processTextPrompt.ts` 里的 prompt 不是给模型看的行为指令，而是把不同宿主的输入变成统一消息。它同时接受字符串和 `ContentBlockParam[]`：首个文本块用于 interaction span、负向关键词和 keep-going 判断；最后一个文本块用于 `user_prompt` OTEL 事件，因为 IDE 的选区或附件可能排在真正用户问题之前。函数每次生成 prompt id，并对事件中的文本执行配置允许的脱敏。

有图片时，文本与图片被组合成一个用户消息，再把 attachment messages 接在后面；没有图片时直接把原始字符串或内容块交给 `createUserMessage()`。无论输入形状如何，返回的 `shouldQuery` 都是 `true`。因此输入 prompt 的职责是“归一化、标记、可观测、送入 Query Loop”，不是在这里决定命令、Skill 或工具路由；后续路由才能在统一的消息形状上工作。

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。行号以当前仓库为准。

| 机制 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| 类型 | `Command` 判别联合（`prompt` / `local` / `local-jsx`） | `src/commands.ts` 附近 | 已确认 |
| 装配 | `loadAllCommands()` 来源合并 | `src/commands.ts` | 已确认 |
| 过滤 | `getCommands()` / `meetsAvailabilityRequirement` / `isCommandEnabled` | `src/commands.ts` | 已确认 |
| 解析 | `parseSlashCommand()` / `ParsedSlashCommand` | `src/utils/processUserInput/` | 已确认 |
| 输入分流 | `processUserInputBase()` bash / slash / text | `src/utils/processUserInput/` | 已确认 |
| 查找 | `findCommand()` / `getCommandName()` / aliases | `src/utils/processUserInput/` | 已确认 |
| 未知输入 | `looksLikeCommand()` 路径回退 | `src/utils/processUserInput/processSlashCommand.tsx` | 已确认 |
| 分派 | `getMessagesForSlashCommand()` 三分支 | `src/utils/processUserInput/processSlashCommand.tsx` | 已确认 |
| local | `LocalCommandModule.call()` → text / compact / skip | `src/commands/branch/branch.ts` 等实现 | 已确认 |
| local-jsx | `onDone()` / `display` / `shouldQuery` / `nextInput` | `src/utils/processUserInput/processSlashCommand.tsx` | 已确认 |
| prompt | `getMessagesForPromptSlashCommand()` / `executeForkedSlashCommand()` | `src/utils/processUserInput/processSlashCommand.tsx` | 已确认 |
| 参数 | `substituteArguments()` / `parseArguments()` | `src/utils/` | 已确认 |
| 无头 | `commandsHeadless` 启动过滤 | `src/main.tsx` | 已确认 |

## 设计决策

**第一，为什么用判别联合而不是"每个命令一个类"？** 三种 `type` 让运行时可以做穷尽分派，`switch (command.type)` 覆盖所有分支，新增类型会触发编译检查。同时 `load()` 延迟加载把 UI 依赖和本地模块成本移出启动路径，REPL 启动时不必实例化全部命令。
**第二，为什么 `shouldQuery` 默认是 `false`？** 本地命令（切换主题、打开面板、复制输出）本来不需要模型参与；如果默认查询，每个本地动作都会消耗 token 并引入模型不确定性。`local-jsx` 的 `onDone()` 把 `shouldQuery` 设为可选，允许 UI 命令主动把结果交给模型，但把"默认不查询"作为安全基线。
**第三，为什么命令名查找用"数组第一个匹配项"而不是 Map？** 装配顺序（bundled → plugin → skill → workflow → 内置）天然表达优先级，同名命令，先装配的覆盖后装配的。Map 只能表达唯一键，无法表达"同样名字、来源不同"的叠加语义；去重只在动态 Skill 与 MCP Skill 等明确需要去重的来源上执行。
**第四，为什么无头模式要裁剪命令集合而不是运行时再报错？** 宿主能力是静态事实，`-p` 无法等待 picker，Remote Control 无法弹出本地面板。启动时裁剪让"入口资格"成为命令定义的一部分（`supportsNonInteractive`、`disableNonInteractive`），出错发生在装配期而不是用户输入之后；`processSlashCommand()` 里的第二道防御则兜住意外路径。

## 练习

1. **对照决策树观察一次真实命令**，启动 `claude`，输入 `/model`，观察它属于 `local-jsx`（打开选择器面板）；再输入 `/clear`，确认它是 `local`（本地清空、`shouldQuery: false`，终端不会出现新的模型回复）。用 `/statusline help` 之类带参数的 prompt 命令验证参数传递。
2. **验证参数替换**，定义一个简单 Skill，正文同时使用 `$ARGUMENTS` 和 `$ARGUMENTS[0]`，然后分别用 `/skill`、`/skill one "two words"` 调用，对比展开后的消息，命名占位符与索引占位符、shell quote 分组行为都应符合上文规则。
3. **观察无头过滤**，用 `claude -p "/config"` 和 `claude -p "/review"` 对比，`local-jsx` 的 `/config` 在无头模式被过滤，不会打开面板；`/review` 作为 `prompt` 会进入查询流程。如果输出与预期不符，检查 `disableSlashCommands` 与命令的 `supportsNonInteractive` / `disableNonInteractive` 字段。

## 自测

1. `/compact` 的 `type` 是什么？它会产生模型调用吗？
2. 在 Remote Control（bridge）输入中，`local-jsx` 命令为什么会被拦截？
3. `shouldQuery: true` 是否等于"一定会调用模型"？

<details>
<summary>参考答案</summary>

1. **`local`。** `/compact` 由本地模块执行压缩，返回 `type: 'compact'` 的结果（内部仍会发起一次压缩请求，但那是命令实现自身的模型调用，不是 slash 命令路由层的行为）；三个正常出口的 `shouldQuery` 都固定为 `false`，不会把压缩结果作为普通消息再送进 Query Loop。
2. **因为 Remote Control 没有可接管的本地面板。** `/config` 这类命令需要 Ink 面板交互，bridge 输入无法承载；2.1.88 对 bridge 输入默认保留 `skipSlashCommands`，只允许 `prompt` 类型扩成文本、`local` 在 allowlist 中穿过，`local-jsx` 一律拦截，防止远端文本触发本地状态修改。
3. **不等于。** `shouldQuery: true` 只说明消息已进入查询流程；是否调用工具、是否成功仍受权限规则、上下文大小、API 错误、用户取消和 query loop 停止条件约束。

</details>

## 回顾｜/branch、/fork、/new 的区别

<details>
<summary>展开查看回顾</summary>

上一篇问，你知道 Claude Code 中 `/branch`、`/fork` 和 `/new` 的区别吗？

在 `@anthropic-ai/claude-code@2.1.88` 的默认外部构建里，`/branch` 和 `/fork` 是同一条"复制当前会话并切换过去"的路径；`/new` 则是 `/clear` 的别名，创建一个没有旧对话上下文的新会话。默认语义下前两者复制历史，`/new` 不复制历史；如果启用 `FORK_SUBAGENT`，`/fork` 会切换成另一条后台子代理路径。

| 命令 | 2.1.88 中的实现 | 对话历史与 session ID |
| --- | --- | --- |
| `/branch [name]` | `local-jsx` 命令调用 `createFork()`，复制当前 transcript 主链并切换到新会话 | 原会话保留；新会话获得新 session ID，并带 `forkedFrom` 来源记录 |
| `/fork` | 默认是 `/branch` 的 alias；`--fork-session` 是"恢复历史但使用新 session ID"的入口 | 默认 alias 下与 `/branch` 相同；不会删除原会话 |
| `/new` | `clear` 命令的 alias，执行 `clearConversation()` | 清空消息、缓存、计划和会话元数据并生成新 session ID；旧 transcript 仍可 `/resume` 找回，但不会复制到新会话 |

`/branch` 的关键是"复制后切换"，源码读取当前 JSONL，只保留主对话消息，为每条复制记录写新 `sessionId`、重建 `parentUuid`、附上 `forkedFrom`，原文件不改。`/new` 的关键是"不要带历史"，`clearConversation()` 清空消息与计划缓存，调用 `regenerateSessionId({ setCurrentAsParent: true })`，再执行 `SessionStart('clear')` Hook；它不复制旧 JSONL，也不会回滚已执行工具的副作用。还要留意 `/fork` 的版本/构建边界，`FORK_SUBAGENT` 打开后 alias 被移除，`commands.ts` 才装配独立的 `forkCmd`（`AgentTool/forkSubagent.ts` 走后台 forked subagent）。最后，会话分叉不等于 Git 分支或 worktree 隔离，它们只复制消息历史，当前工作目录与外部副作用仍在原现场。

</details>

## 留给下一篇的问题

如果你在 Claude Code 中输入了一大段文字，然后回到开头在最前面输入 `/` 想选择一个 Skill，为什么这时不会弹出 slash 命令提示？

## 相关链接

- **上一篇**，[20 如何恢复、续接与分叉对话](./20-session-history-and-resume.md)，`/branch` 与 transcript 恢复
- **下一篇**，[22 提示词如何变成可执行能力](./22-skill-system.md)，回答本文的 typeahead 问题
- **平行阅读**，[32 Ink TUI 与 REPL 输入](./32-ink-tui-and-repl.md)，输入层与终端事件
- **官方文档**，[Claude Code Commands](https://code.claude.com/docs/en/commands)、[交互模式](https://code.claude.com/docs/en/interactive-mode)、[How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- **外部资料**，[Claude Code /branch， Fork Sessions to Test Multiple Paths](https://claudcod.com/blog/claude-code-branch-sessions/)、[What is /branch Command in Claude Code](https://claudelog.com/faqs/what-is-branch-command-in-claude-code/)、[Fork vs. Branch in Claude， What's the Difference?](https://claudekit.app/blog/claude-fork-vs-branch)
