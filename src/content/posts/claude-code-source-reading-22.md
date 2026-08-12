---
title: "Claude Code源码解读22：提示词如何变成可执行能力"
published: 2026-07-24T16:47:09+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-22/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇留下的问题是，如果你在 Claude Code 中输入了一大段文字，然后回到开头在最前面输入 `/` 想选择一个 Skill，为什么这时不会弹出 slash 命令提示？

答案先放在前面，问题通常出在 2.1.88 的 typeahead。它把整个输入框的字符串当作一条 slash 命令来判断。你在已有长文本前插入 `/` 后，光标虽然在第一个字符后面，但 `value` 已经变成 `/<原来的长文本>`；提示系统没有把“光标所在的命令 token”和光标后的草稿分开。

源码里的第一道判断是，

```ts
export function isCommandInput(input: string): boolean {
  return input.startsWith('/')
}
```

它只看字符串是否以 `/` 开头，不看光标位置。接着，`findMidInputSlashCommand()` 明确先排除 `input.startsWith('/')`，所以这个场景不会进入“中间位置 slash”的 ghost text 路径；`findSlashCommandPositions()` 在 `PromptInput` 中只负责给已经存在的 slash 片段做高亮，不负责生成下拉列表。

然后是导致“没有 popup”的关键分支。用户的长文本通常包含空格，而光标不在文本末尾时，

```ts
function hasCommandWithArguments(
  isAtEndWithWhitespace: boolean,
  value: string,
) {
  return !isAtEndWithWhitespace &&
    value.includes(' ') &&
    !value.endsWith(' ')
}
```

`updateSuggestions()` 只有在 `!hasCommandWithArguments(...)` 时才会进入命令提示逻辑。于是 `"/长文本..."` 被视为“已经有命令参数的输入”，函数直接跳过 `generateCommandSuggestions()`，并清掉旧提示。即使原文恰好以空格结尾，后续分支也会把第一个空格前的整段内容当作 `commandName`；只要后面还有真实文本，就会清空下拉提示。

还有第二层限制，即便长文本没有空格，`generateCommandSuggestions(value, commands)` 搜索的也是 `value.slice(1)`，整段原文，不会只取光标前 `/` 后面的短 token。它自然很难匹配 `review`、`publish` 这类 Skill 名称。问题落在命令候选计算的输入范围。

把它和官方文档放在一起看，会发现这是一个边界/回归问题。文档说明 `user-invocable: false` 才会把 Skill 从 `/` 菜单隐藏，默认可被用户调用；而 2.1.88 这里是在 Skill 可见性判断之前，就因为输入被解释成带参数的命令而退出。官方 changelog 曾记录“`/` 出现在输入任意位置时支持 slash autocomplete”，后续又持续修复 mid-input autocomplete 相关问题，说明“支持任意位置”并不等于每个光标位置都走同一套弹窗路径。

实际使用时，最稳妥的顺序是先在空输入或只保留 `/skill` 的状态下选择 Skill，再把长文本作为它的参数粘贴进去；如果草稿已经很长，可以先把草稿暂存或复制到外部编辑器，完成 Skill 选择后再粘回。若只想让 Claude 自动使用能力，也可以直接描述任务，让 Skill 的 `description` 参与自动匹配，不必依赖 slash 下拉框。

如果要修源码，不能简单地把“有空格就不提示”这一保护删掉，它原本是为了避免用户已经输入命令参数时，Tab/Enter 又选中另一条命令。更准确的修复是以 `cursorOffset` 切出光标处的 `/token`，只对 token 做匹配，并把光标后的原文作为 suffix 保留；这也解释了为什么当前实现会在用户“回到开头”时暴露问题。

下文的控制流都以 `@anthropic-ai/claude-code@2.1.88` 的 `restored-src/` 为证据；代码块只保留真实源码中与 Skill 路由有关的字段。

## 介绍本章的一些概念

- **Skill 是可发现、可展开的能力说明，不是一段常驻 system prompt**，运行时常驻的只是名称和短 description，`getPromptForCommand()` 在用户输入 `/name` 或模型调用 `Skill` 工具时才展开完整正文，这就是渐进披露（progressive disclosure）。
- 发现阶段合并五类来源，磁盘 Skill（目录式 `SKILL.md`）、插件 Skill、bundled Skill、内置插件 Skill，加上运行期按文件路径动态发现的嵌套 `.claude/skills`；MCP Skill 单独来自 `AppState.mcp.commands`，在列表与 SkillTool 查找时合并。
- **frontmatter 的两个布尔值构成入口表**，`user-invocable` 控制用户 `/name`，`disable-model-invocation` 控制模型 `Skill` 工具；`context: fork` 把展开结果交给独立 Agent，其余值在当前 Query Loop 内继续。
- 模型看到的是**预算裁剪的索引**，`skill_listing` attachment 只占上下文窗口 1%（缺省 8,000 字符），单条 description 加 `whenToUse` 上限 250 字符；只有 Agent 拥有 Skill 工具时才注入。
- 调用 Skill 本身仍走权限系统，`SkillTool.checkPermissions()` 按 deny → allow → ask 决策；`allowed-tools` 只是为本次调用附加权限规则，不绕过沙箱与 deny。

> ⚠️ **证据边界**，本文全部引用 `restored-src/`（`@anthropic-ai/claude-code@2.1.88` source map 还原源码）。`loadedFrom` 的可见值包括 `'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'`；`user-invocable`、`disable-model-invocation`、`context` 的解析规则可以确认，但运行期 feature flag 与远程 Skill 的行为属于运行时条件。

## 本篇新增

上一篇（21）讲 Command 系统如何把输入路由到 `prompt` / `local` / `local-jsx` 三条路径；本篇沿其中最容易混淆的一支往下走，新增两个认知点，

- **Skill 生命周期图**，从发现 → 注册 → 索引 → 调用 → 展开 → 执行 → 恢复七阶段，把"同一份 Markdown 如何在不同入口拥有不同可见性与权限"一次画清。
- **渐进披露的预算机制**，模型先看到 `skill_listing` 短目录（1% 窗口、250 字/条），真正选中后才加载全文，这是 Skill 与常驻 system prompt 的根本区别。

## 问题

一份 `SKILL.md` 只有几十行文字，却可能出现在 slash 菜单、模型工具列表和独立 Agent 的 system prompt 中。它的难点在于同一份文件要适配不同入口的可见性、参数替换和权限边界。

![Skill 从发现到展开的渐进式披露](/images/posts/claude-code-source-reading-22/22-skill-disclosure-detail-handdrawn.png)

本文沿着 Skill 的生命周期阅读，先发现并解析 frontmatter，再生成 prompt command，调用时才展开正文；`context: fork` 只改变后续上下文归属，不改变 Skill 的发现规则。

## 正文

### Skill 是可发现、可展开的能力说明

Skill 的 Markdown 只是来源；`loadSkillsFromSkillsDir()` 先找到目录下的 `SKILL.md`，`parseSkillFrontmatterFields()` 把 frontmatter 变成路由与权限元数据，`createSkillCommand()` 再包装成 `type: 'prompt'`。会话常驻的只是名称和描述，`getPromptForCommand()` 在用户输入 `/name` 或模型调用 `Skill` 时才展开正文；`context: fork` 让展开结果进入独立 Agent，其余路径沿当前 query loop 继续。

![Claude Code Skill 发现、渐进展开与执行路径手绘图](/images/posts/claude-code-source-reading-22/22-skill-system-handdrawn.png)

**Skill 发现 → 加载 → 执行生命周期（本篇新增）**，

```text
发现阶段  loadSkillsFromSkillsDir / getSkills / discoverSkillDirsForPaths
  │  目录（或符号链接）下的 SKILL.md；跳过普通 .md；realpath 去重
  ▼
解析阶段  parseFrontmatter → parseSkillFrontmatterFields
  │  user-invocable · disable-model-invocation · context · allowed-tools · model
  ▼
注册阶段  createSkillCommand → type: 'prompt' Command（闭包持有全文）
  │  isHidden = !userInvocable · contentLength · 延迟展开
  ▼
索引阶段  模型只看到 skill_listing attachment（1% 预算 · 250 字/条）
  │  用户入口：/name + args   模型入口：Skill 工具 { skill, args }
  ▼
调用阶段  findCommand → 入口检查 → SkillTool.checkPermissions()
  │  deny → allow → ask；user-invocable=false 时直接拒绝
  ▼
展开阶段  getPromptForCommand：baseDir 前缀 + $ARGUMENTS + ${CLAUDE_SKILL_DIR}
  │        + ${CLAUDE_SESSION_ID} + 内联 shell（loadedFrom !== 'mcp'）
  ▼
执行阶段  context: 'fork' → executeForkedSkill（独立 Agent，回传结果）
  │        否则 → processPromptSlashCommand → 当前 Query Loop
  ▼
恢复阶段  addInvokedSkill 登记已调用 Skill → compaction 后重新提供指令
```

图里的关键分界在 `skill_listing` 与 `expand full prompt` 之间。前者解决"Claude 如何知道有哪些能力"，后者解决"选中以后，完整指令怎样进入执行流"。

### 这张金额单位工单的核心任务先经过一个 Skill

支付团队不希望每个值班工程师都临时编排一套调查步骤，于是在项目里放了一份 `incident` Skill，它要求先读 `CLAUDE.md` 和工单，再通过 issue-tracker MCP 取证，必要时查官方文档；输出必须先有证据和计划，写入动作要等确认。值班工程师看到结算页和回调金额不一致后，输入，

> /incident 金额单位工单，先读 CLAUDE.md、工单和相关代码；通过 issue-tracker MCP 取证，必要时搜索官方文档；先给证据和计划，不要修改文件。

命令提示里常驻的通常只是 `incident` 的名称、描述和参数提示；真正选中后，Claude Code 才读取 `SKILL.md` 正文，把工单名称和约束填入模板并展开成 prompt。若 Skill 声明 fork，后续任务进入独立上下文；否则继续当前 Query Loop，且调用仍要经过权限判断。这里的 Skill 更像一张可发现的调查流程卡，而不是一个绕过权限的快捷键。

### 发现阶段合并多类来源

文件型 Skill 的基本格式很严格，`skills` 目录下面必须先有子目录，再在子目录中放 `SKILL.md`。直接丢一份 `review.md` 不会被这条加载器识别。

```ts
async function loadSkillsFromSkillsDir(
  basePath: string,
  source: SettingSource,
): Promise<SkillWithPath[]> {
  const fs = getFsImplementation()
  const entries = await fs.readdir(basePath)
  const results = await Promise.all(
    entries.map(async (entry): Promise<SkillWithPath | null> => {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        return null
      }

      const skillDirPath = join(basePath, entry.name)
      const skillFilePath = join(skillDirPath, 'SKILL.md')
      const content = await fs.readFile(skillFilePath, { encoding: 'utf-8' })
      const { frontmatter, content: markdownContent } = parseFrontmatter(
        content,
        skillFilePath,
      )
      const skillName = entry.name
      const parsed = parseSkillFrontmatterFields(
        frontmatter,
        markdownContent,
        skillName,
      )

      return {
        skill: createSkillCommand({
          ...parsed,
          skillName,
          markdownContent,
          source,
          baseDir: skillDirPath,
          loadedFrom: 'skills',
          paths: parseSkillPaths(frontmatter),
        }),
        filePath: skillFilePath,
      }
    }),
  )
  return results.filter((r): r is SkillWithPath => r !== null)
}
```
**函数说明，** `loadSkillsFromSkillsDir()` 位于 `restored-src/src/skills/loadSkillsDir.ts`。它并发枚举一个 skills 根目录，只接受目录或符号链接，并读取其下名称精确为 `SKILL.md` 的文件。真实源码里某个条目读取失败会返回 `null`，不会让整批 Skill 一起失败。
**参数说明，** `basePath` 是必须显式提供的开放路径字符串；`source` 是 `SettingSource`，源码可见的相关来源包括 `'policySettings'`、`'userSettings'`、`'projectSettings'`。目录项必须是 directory 或 symbolic link；普通 `.md` 文件被明确跳过。`readFile()` 的编码固定为 `'utf-8'`。根目录不可访问或条目缺少 `SKILL.md` 时，函数返回空数组。
**字段说明，** 每个 `entry` 通过 `entry.name` 派生 `skillDirPath` 与 `skillFilePath`；目录名写入 `skillName`，`parseFrontmatter()` 拆出 `frontmatter` 与 `markdownContent`。返回项的 `skill` 是 `createSkillCommand()` 生成的命令，`filePath` 保留来源文件；构造参数中的 `source`、`baseDir`、`loadedFrom`、`paths` 分别保存设置来源、Skill 根目录、加载类别与条件路径。

上层的 `getSkillDirCommands()` 再把多个文件来源并行合并，

```ts
const [
  managedSkills,
  userSkills,
  projectSkillsNested,
  additionalSkillsNested,
  legacyCommands,
] = await Promise.all([
  isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS)
    ? Promise.resolve([])
    : loadSkillsFromSkillsDir(managedSkillsDir, 'policySettings'),
  isSettingSourceEnabled('userSettings') && !skillsLocked
    ? loadSkillsFromSkillsDir(userSkillsDir, 'userSettings')
    : Promise.resolve([]),
  projectSettingsEnabled
    ? Promise.all(projectSkillsDirs.map(dir =>
        loadSkillsFromSkillsDir(dir, 'projectSettings'),
      ))
    : Promise.resolve([]),
  projectSettingsEnabled
    ? Promise.all(additionalDirs.map(dir =>
        loadSkillsFromSkillsDir(
          join(dir, '.claude', 'skills'),
          'projectSettings',
        ),
      ))
    : Promise.resolve([]),
  skillsLocked ? Promise.resolve([]) : loadSkillsFromCommandsDir(cwd),
])
```
**代码说明，** 这段同样位于 `loadSkillsDir.ts`。正常模式会收集托管、用户、从 cwd 向上发现的项目目录、`--add-dir` 指定目录，以及兼容旧 `/commands/` 的定义。真实源码还在每项前检查 setting source、plugin-only policy 与 `CLAUDE_CODE_DISABLE_POLICY_SKILLS`，因此运行环境会决定五个分支中哪些实际执行。
**参数说明，** `projectSkillsDirs` 与 `additionalDirs` 都是路径数组，空数组通过 `Promise.all([])` 得到空结果。`--bare` 是特殊分支，它跳过 managed/user/project 自动遍历和 legacy commands，只读取显式 `--add-dir`；bundled Skill 在另一处注册。

合并后还会用 `realpath()` 解析符号链接，对"同一真实文件从多个路径被发现"的情况做 first-wins 去重。该阶段按文件身份去重；不同文件即使同名，仍可能继续进入后续命令装配，最终由数组顺序和 `findCommand()` 的第一个匹配决定命中项。

文件目录只是来源之一。`getSkills()` 还并行加载插件 Skill，并读取启动时同步注册的 bundled Skill 与内置插件 Skill，

```ts
const [skillDirCommands, pluginSkills] = await Promise.all([
  getSkillDirCommands(cwd).catch(err => {
    logError(toError(err))
    return []
  }),
  getPluginSkills().catch(err => {
    logError(toError(err))
    return []
  }),
])
const bundledSkills = getBundledSkills()
const builtinPluginSkills = getBuiltinPluginSkillCommands()

return {
  skillDirCommands,
  pluginSkills,
  bundledSkills,
  builtinPluginSkills,
}
```
**函数说明，** `getSkills()` 位于 `restored-src/src/commands.ts`。它把磁盘 Skill、插件 Skill、bundled Skill 和内置插件 Skill 交给上一篇提到的 `loadAllCommands()` 装配。MCP Skill 不在这四项中；它来自 `AppState.mcp.commands`，在 Skill 列表和 SkillTool 查找时单独合并。
**参数说明，** `cwd` 是必填路径，直接传给文件加载器。两个异步加载器各自 `catch` 并回退 `[]`；最外层防御性 `catch` 也会把四个字段全部置为空数组。这说明 Skill 是非关键扩展，加载失败会损失能力，但不会因此阻止 Claude Code 启动。

### Frontmatter 把 Markdown 变成可路由的元数据

发现文件以后，`parseSkillFrontmatterFields()` 负责处理默认值和特殊值，

```ts
const userInvocable =
  frontmatter['user-invocable'] === undefined
    ? true
    : parseBooleanFrontmatter(frontmatter['user-invocable'])

const model =
  frontmatter.model === 'inherit'
    ? undefined
    : frontmatter.model
      ? parseUserSpecifiedModel(frontmatter.model as string)
      : undefined

return {
  allowedTools: parseSlashCommandToolsFromFrontmatter(
    frontmatter['allowed-tools'],
  ),
  disableModelInvocation: parseBooleanFrontmatter(
    frontmatter['disable-model-invocation'],
  ),
  userInvocable,
  executionContext: frontmatter.context === 'fork' ? 'fork' : undefined,
}
```
**函数说明，** `parseSkillFrontmatterFields()` 位于 `restored-src/src/skills/loadSkillsDir.ts`。它把 YAML frontmatter 转成统一字段，同时从正文提取 description 作为缺省值。这里只展示最影响控制流的四项；源码还解析 `name`、`argument-hint`、`arguments`、`when_to_use`、`version`、`hooks`、`agent`、`effort`、`paths` 与 `shell`。
**参数说明，** `user-invocable` 缺省时明确为 `true`；显式假值会使 `isHidden` 为真，并阻止斜杠入口。`disable-model-invocation` 经布尔解析，缺省回退假值；真值会从模型可调用列表移除，并被 SkillTool 校验拒绝。`model: inherit`、缺省值与其他 falsy 值都归一为 `undefined`，表示不覆盖当前模型。`context` 只有精确字符串 `'fork'` 被接受；`'inline'`、其他字符串、`null` 或缺省都得到 `undefined`，后续按 inline 处理。`allowed-tools` 解析后始终是字符串数组，缺省为空数组。

两个布尔值构成了一张很实用的入口表，

| `user-invocable` | `disable-model-invocation` | 用户 `/name` | 模型 `Skill` 工具 |
|---|---|---|---|
| 缺省 `true` | 缺省 `false` | 可以 | 可以 |
| `false` | `false` | 不可以 | 可以 |
| `true` | `true` | 可以 | 不可以 |
| `false` | `true` | 不可以 | 不可以 |

这两个字段不保证调用一定成功。表格只描述入口资格；后面仍有命令查找、Skill 工具权限、下游工具权限、API、取消和运行错误。

解析结果接着被包装成 PromptCommand，

```ts
return {
  type: 'prompt',
  name: skillName,
  description,
  allowedTools,
  context: executionContext,
  model,
  disableModelInvocation,
  userInvocable,
  isHidden: !userInvocable,
  contentLength: markdownContent.length,
  async getPromptForCommand(args, toolUseContext) {
    // expand markdown when invoked
  },
}
```
**函数说明，** 这段来自 `createSkillCommand()`。Skill 在运行时被归一为 `type: 'prompt'` 的 Command。完整 Markdown 被闭包捕获，`getPromptForCommand()` 延迟完成参数、变量与 shell 展开。
**参数说明，** `skillName` 对文件型 Skill 来自目录名，是开放字符串；`description` 必有字符串回退；`allowedTools` 是数组；`executionContext` 可为 `'inline' | 'fork' | undefined`，文件 frontmatter 实际只产生 `'fork' | undefined`。`contentLength` 使用 JavaScript 字符串长度。`isHidden` 只跟 `userInvocable` 取反，模型入口则读取 `disableModelInvocation`。

### 模型先看到目录，不先看到全文

运行时给 Skill 目录设置明确预算。`formatCommandsWithinBudget()` 先计算当前上下文窗口 1% 对应的字符预算，每项 description 加 `whenToUse` 后又有 250 字符硬上限，

```ts
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000
export const MAX_LISTING_DESC_CHARS = 250

export function getCharBudget(contextWindowTokens?: number): number {
  if (Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)) {
    return Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  }
  if (contextWindowTokens) {
    return Math.floor(
      contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
    )
  }
  return DEFAULT_CHAR_BUDGET
}
```
**函数说明，** `getCharBudget()` 位于 `restored-src/src/tools/SkillTool/prompt.ts`。它为 Skill 发现目录计算字符预算，不限制调用后展开的 Skill 全文。格式化器先尝试完整简介；超预算时保留 bundled Skill 的简介，对其他项均摊截断，极端情况下只保留名称。
**参数说明，** `contextWindowTokens` 类型为 `number | undefined`。环境变量能被 `Number()` 解析为真值时优先使用；`0`、空字符串和 `NaN` 不会覆盖。参数为正值时按 `tokens × 4 × 1%` 向下取整；`undefined`、`0` 等 falsy 值回退 `8_000` 字符。单条 description 与 `whenToUse` 拼接后最多 250 字符，超出以省略号截断。
**字段说明，** `SKILL_BUDGET_CONTEXT_PERCENT` 固定为 `0.01`，`CHARS_PER_TOKEN` 固定为 `4`；`DEFAULT_CHAR_BUDGET` 是缺省的 `8_000` 字符，`MAX_LISTING_DESC_CHARS` 是单条简介的 `250` 字符上限。`SLASH_COMMAND_TOOL_CHAR_BUDGET` 能解析为真值数字时拥有最高优先级。

目录真正通过 attachment 注入，而且只有 Agent 拥有 Skill 工具时才注入，

```ts
if (!toolUseContext.options.tools.some(t =>
  toolMatchesName(t, SKILL_TOOL_NAME),
)) {
  return []
}

const localCommands = await getSkillToolCommands(cwd)
const mcpSkills = getMcpSkillCommands(
  toolUseContext.getAppState().mcp.commands,
)
const allCommands = mcpSkills.length > 0
  ? uniqBy([...localCommands, ...mcpSkills], 'name')
  : localCommands

return [{
  type: 'skill_listing',
  content: formatCommandsWithinBudget(newSkills, contextWindowTokens),
  skillCount: newSkills.length,
  isInitial,
}]
```
**函数说明，** `getSkillListingAttachments()` 位于 `restored-src/src/utils/attachments.ts`。它合并本地与 MCP Skill，按名称去重，只发送当前 Agent 尚未收到的项目，并生成 `skill_listing` attachment。resume 时源码会先把已有列表标为已发送，避免 transcript 中已有目录被重复注入。
**参数说明，** `toolUseContext` 必填。`options.tools` 中零个工具名称匹配 `Skill` 时直接返回 `[]`；`agentId` 可为 `undefined`，此时源码用空字符串作为主 Agent 的去重键。`mcpSkills` 为空时保留本地数组；非空时 `uniqBy()` 对同名项 first-wins。`isInitial` 是布尔值，只有该 Agent 的 sent set 原先为空才为真。

这就是渐进展开真正节省 token 的地方，程序可以已经读过全文，但模型上下文只承担短索引。description 写得含糊，Claude 就可能选不中；description 写成一篇小作文，又会被 250 字符和总预算截断。

### 用户调用与模型调用在同一个定义上汇合

用户输入 `/pdf invoice.pdf` 时，上一篇的 Command 路由会找到 PromptCommand。模型主动调用时，则通过一个明确的工具 Schema，

```ts
export const inputSchema = lazySchema(() =>
  z.object({
    skill: z
      .string()
      .describe('The skill name. E.g., "commit", "review-pr", or "pdf"'),
    args: z.string().optional().describe('Optional arguments for the skill'),
  }),
)
```
**类型说明，** 这段位于 `restored-src/src/tools/SkillTool/SkillTool.ts`。`Skill` 工具不接收任意 JSON 配置，只接收名称和可选参数。后续 `validateInput()` 会去掉名称首尾空白，并兼容一个前导 `/`，再查找当前 Command。
**字段说明，** `skill` 是必填字符串，trim 后为空会校验失败；值可以写 `pdf`，兼容写法 `/pdf` 会被归一化。`args` 是 `string | undefined`，省略时调用路径通常回退 `''`；`null` 不在 Zod Schema 的候选值里。参数不会参与 Skill 名称查找，它在展开正文时交给占位符替换。

模型入口会拒绝三种情况，未知名称、`disableModelInvocation` 为真、以及找到的 Command 类型偏离 `prompt`。因此模型无法借 SkillTool 猜测并执行 `/help`、`/clear` 这类本地 CLI 命令。

用户入口则检查另一个字段，

```ts
if (command.userInvocable === false) {
  return {
    messages: [createUserMessage({
      content: prepareUserContent({
        inputString: `/${commandName}`,
        precedingInputBlocks,
      }),
    }), createUserMessage({
      content: `This skill can only be invoked by Claude, not directly by users. Ask Claude to use the "${commandName}" skill for you.`,
    })],
    shouldQuery: false,
    command,
  }
}
```
**代码说明，** 这段来自 `restored-src/src/utils/processUserInput/processSlashCommand.tsx` 的 prompt 命令路径。`userInvocable === false` 会在展开正文之前结束，并把 `shouldQuery` 设为 `false`。
**参数说明，** 这里用的是严格等于 `false`；字段缺省已在解析期归一为 `true`，不会误伤旧 Skill。返回的 `messages` 只用于告知用户拒绝原因，`shouldQuery: false` 表示这条拒绝不会继续发给模型执行。

### 调用 Skill 本身也要经过权限判断

模型发出 `Skill` tool_use 后，权限顺序仍是 deny 优先、allow 次之、最后 ask，

```ts
const denyRules = getRuleByContentsForTool(
  permissionContext, SkillTool as Tool, 'deny',
)
for (const [ruleContent, rule] of denyRules.entries()) {
  if (ruleMatches(ruleContent)) {
    return {
      behavior: 'deny',
      message: `Skill execution blocked by permission rules`,
      decisionReason: { type: 'rule', rule },
    }
  }
}

const allowRules = getRuleByContentsForTool(
  permissionContext, SkillTool as Tool, 'allow',
)
for (const [ruleContent, rule] of allowRules.entries()) {
  if (ruleMatches(ruleContent)) {
    return {
      behavior: 'allow',
      updatedInput: { skill, args },
      decisionReason: { type: 'rule', rule },
    }
  }
}

return {
  behavior: 'ask',
  message: `Execute skill: ${commandName}`,
  updatedInput: { skill, args },
}
```
**函数说明，** 这段精简自 `SkillTool.checkPermissions()`，省略了远端 canonical Skill、安全属性自动允许和规则建议。真实实现先检查 Skill deny 规则，再检查 allow；只有未命中规则、且不满足安全属性自动允许的 Skill 才询问用户。
**参数说明，** 第三个参数候选值在这里分别为 `'deny'` 与 `'allow'`。规则内容支持精确名称，也支持以 `:*` 结尾的前缀；比较前会移除规则和输入的前导 `/`。返回 `behavior` 候选值为 `'deny' | 'allow' | 'ask'`。`args` 保持 `string | undefined`，权限允许不会修改 Skill 正文，只把 `updatedInput` 交回工具生命周期。

Skill 获准调用以后，`allowed-tools` 才影响正文里的后续工具，

```ts
const additionalAllowedTools = parseToolListFromCLI(
  command.allowedTools ?? [],
)

const messages = [
  createUserMessage({ content: metadata, uuid }),
  createUserMessage({ content: mainMessageContent, isMeta: true }),
  ...attachmentMessages,
  createAttachmentMessage({
    type: 'command_permissions',
    allowedTools: additionalAllowedTools,
    model: command.model,
  }),
]
```
**代码说明，** 这段来自 `processPromptSlashCommand()`。它把 Skill 声明的工具字符串解析成权限规则，并附加到这次 prompt 命令产生的消息后面。后续 Query Loop 读取 `command_permissions`，Markdown 只提供指令内容。
**参数说明，** `command.allowedTools` 可为 `string[] | undefined`；`undefined` 通过 `?? []` 回退空数组。`allowedTools` 为空表示 Skill 不附加工具允许规则，不表示"允许全部工具"。`model` 可为字符串或 `undefined`；`undefined` 表示沿用当前模型。附加 allow 也不会删除现有 deny、宿主限制或沙箱边界，因此不能把它解释成无条件授权。

### 展开正文时还会处理参数、变量和 shell

`createSkillCommand()` 的闭包在调用时才生成最终文本，

```ts
let finalContent = baseDir
  ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
  : markdownContent

finalContent = substituteArguments(
  finalContent, args, true, argumentNames,
)

if (baseDir) {
  finalContent = finalContent.replace(
    /\$\{CLAUDE_SKILL_DIR\}/g, skillDir,
  )
}
finalContent = finalContent.replace(
  /\$\{CLAUDE_SESSION_ID\}/g, getSessionId(),
)
```
**函数说明，** `getPromptForCommand()` 位于 `createSkillCommand()` 返回的对象中。它先在正文前补 Skill 根目录，再替换 `$ARGUMENTS`、位置/命名参数，最后替换 Skill 目录和当前 session ID。Windows 下 `skillDir` 会把反斜杠归一为正斜杠，避免 shell 把它当转义符。
**参数说明，** `baseDir` 是 `string | undefined`；文件型 Skill 通常有值，MCP 或部分注册型 Skill 可以省略。`args` 是 `string | undefined`，但调用方常把省略值转成 `''`；`appendIfNoPlaceholder` 在这里固定 `true`，因此模板省略占位符且 args 非空时，会追加 `ARGUMENTS:` 段落。`argumentNames` 是数组，缺省为空。`${CLAUDE_SESSION_ID}` 总会替换；`${CLAUDE_SKILL_DIR}` 只在 `baseDir` 存在时替换。

正文还支持内联 shell 展开，但这里有一条明确的信任边界，

```ts
if (loadedFrom !== 'mcp') {
  finalContent = await executeShellCommandsInPrompt(
    finalContent,
    {
      ...toolUseContext,
      getAppState() {
        const appState = toolUseContext.getAppState()
        return {
          ...appState,
          toolPermissionContext: {
            ...appState.toolPermissionContext,
            alwaysAllowRules: {
              ...appState.toolPermissionContext.alwaysAllowRules,
              command: allowedTools,
            },
          },
        }
      },
    },
    `/${skillName}`,
    shell,
  )
}
```
**代码说明，** 仍然来自 `getPromptForCommand()`。非 MCP Skill 可以通过统一的 prompt shell 执行器处理内联命令；MCP Skill 被视为远端、不受信任的内容，直接跳过这一步。是否每个非 MCP Skill 都执行 shell 由正文语法和后续校验共同决定。
**参数说明，** `loadedFrom` 的源码联合值包括 `'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'`；只有精确 `'mcp'` 被排除。第三个参数是用于显示和审计的 `/${skillName}`。`shell` 可为解析后的 frontmatter 配置或 `undefined`；包装后的 `getAppState()` 会把 `toolPermissionContext.alwaysAllowRules.command` 覆盖为 `allowedTools`，但仍由 shell 执行器和权限系统处理。

### inline 与 fork 决定谁持有后续上下文

SkillTool 真正调用时先看 `command.context`，

```ts
if (command?.type === 'prompt' && command.context === 'fork') {
  return executeForkedSkill(
    command,
    commandName,
    args,
    context,
    canUseTool,
    parentMessage,
    onProgress,
  )
}

const processedCommand = await processPromptSlashCommand(
  commandName,
  args || '',
  commands,
  context,
)
```
**函数说明，** 这段位于 `SkillTool.call()`。`fork` 分支把 Skill 交给独立 Agent；其余情况通过 `processPromptSlashCommand()` 展开为当前会话的新消息。inline 会把完整指令送回 Query Loop，Claude 再依据指令决定是否调用其他工具。
**参数说明，** `command` 可能是 `undefined`，但此前 `validateInput()` 正常完成时应已证明命令存在；这里仍用可选链防御。`context` 只有精确 `'fork'` 进入子 Agent；`undefined` 和 `'inline'` 都走当前会话。`args || ''` 会把 `undefined` 与空字符串统一为空字符串。`onProgress` 是可选回调，只用于汇报 fork 执行进度，不决定成功。

fork 为什么存在？一份长 Skill 可能需要大量 Read、Grep 和中间推理。如果全部塞回主会话，它的过程消息会迅速占满上下文。`executeForkedSkill()` 创建 Agent ID、准备隔离上下文、调用 `runAgent()`，最后把抽取后的结果返回父会话。代价也很清楚，父会话拿到的是结果，不天然拥有子 Agent 的全部思考和工具历史。inline 则适合需要继续利用当前对话上下文、且结果应自然成为本轮一部分的 Skill。两者共享同一份 Skill 定义，却选择不同的上下文所有权。

展开成功后，`processPromptSlashCommand()` 还会把正文登记到 `invokedSkills`，

```ts
addInvokedSkill(
  command.name,
  skillPath,
  skillContent,
  getAgentContext()?.agentId ?? null,
)
```
**函数说明，** `addInvokedSkill()` 把 Skill 名称、来源路径、已展开内容、时间和 Agent ID 写进 bootstrap state。第 17 篇讲过，compaction 后系统需要重新提供仍有效的执行指令；这份状态就是恢复已调用 Skill 的依据之一。
**参数说明，** `skillName`、`skillPath`、`content` 都是必填字符串。`agentId` 类型为 `string | null`，Agent 上下文缺失时通过 `?? null` 明确归到主会话。内部 key 使用 `${agentId ?? ''}:${skillName}`，使同名 Skill 在不同 Agent 之间隔离，避免压缩恢复时串线。fork Agent 结束后还会清理该 Agent 的 Skill 状态。

### 动态发现让 Skill 跟着文件位置出现

启动扫描之后，文件工具触及项目深处的路径时，Claude Code 还会从文件父目录向 cwd 回溯，寻找嵌套的 `.claude/skills`，

```ts
while (currentDir.startsWith(resolvedCwd + pathSep)) {
  const skillDir = join(currentDir, '.claude', 'skills')
  if (!dynamicSkillDirs.has(skillDir)) {
    dynamicSkillDirs.add(skillDir)
    await fs.stat(skillDir)
    if (!(await isPathGitignored(currentDir, resolvedCwd))) {
      newDirs.push(skillDir)
    }
  }
  currentDir = dirname(currentDir)
}

return newDirs.sort(
  (a, b) => b.split(pathSep).length - a.split(pathSep).length,
)
```
**函数说明，** `discoverSkillDirsForPaths()` 位于 `restored-src/src/skills/loadSkillsDir.ts`。它只发现 cwd 以下的嵌套 Skill 目录，因为 cwd 层已经在启动时加载；每个候选目录无论存在与否都记入 `dynamicSkillDirs`，避免后续文件操作反复 `stat`。gitignored 路径会被跳过。
**参数说明，** `filePaths` 是必填路径数组；`cwd` 是回溯上界。空数组返回 `[]`。前缀检查带 `pathSep`，避免 `/project-backup` 被误判为 `/project` 子目录。返回值按路径深度从深到浅排序；`addSkillDirectories()` 随后反向处理，让更深、离文件更近的同名 Skill 最后写入 Map 并覆盖较浅项。

frontmatter 的 `paths` 还支持条件 Skill，启动时先把它们放进 `conditionalSkills`，当实际文件路径匹配 gitignore 风格 pattern 时才加入动态集合。`paths` 为空、全是 `**`、或解析后缺少有效 pattern，会回退为无条件 Skill。动态加载完成后会发送 signal 清理 Command/Skill 索引缓存，并在后续 attachment 中只宣布该 Agent 首次见到的新 Skill。因此，Skill 列表是会话中的增量视图。

### 小结

Claude Code 的 Skill 系统复用 Command 与 Query Loop 执行内核。它把多来源的 `SKILL.md` 与注册型能力归一为 PromptCommand，用短 description 和 `whenToUse` 建立发现索引，再在用户或模型真正选中时展开完整正文。`user-invocable` 与 `disable-model-invocation` 分别控制用户和模型入口；`allowed-tools` 把附加规则交给权限系统，并不绕过 deny 与沙箱；`context: fork` 把长过程隔离到子 Agent，其他值则在当前 Query Loop 内继续。动态目录与 `paths` 条件又让能力可以随着文件位置按需出现。

把 Skill 直接拼进 system prompt，代码会短一些，但会付出四个代价，全文 token 常驻、入口无法统一（用户斜杠、模型调用、插件、MCP 各写一套执行器）、权限混淆（`allowed-tools` 只是把规则交给权限上下文，真正的 Bash、Edit、MCP 工具仍执行自己的校验）、上下文难隔离（重任务需要 fork 才能只回传结果）。因此，Skill 更准确的心智模型是，

`可发现元数据 + 延迟展开的正文 + Command 路由 + Tool 权限 + 可选 Agent 上下文`

它把"团队经验"变成一种声明式扩展，但执行能力仍来自 Claude Code 已有的 Query Loop、工具注册表、权限引擎和 Agent 运行时。下一篇就沿 fork 背后的公共设施继续往下看，Claude Code 怎样把一次长时间工作变成可创建、可观察、可取消并最终收束的 Task。

### SkillTool 的 prompt 自己也有一个预算

`restored-src/src/tools/SkillTool/prompt.ts` 把 Skill 发现做成渐进披露，而不是把所有 Markdown 全塞进上下文。默认清单预算按上下文窗口字符数的 1% 计算，源码常量是 `SKILL_BUDGET_CONTEXT_PERCENT = .01`、`CHARS_PER_TOKEN = 4`，默认至少 8000 字符；`SLASH_COMMAND_TOOL_CHAR_BUDGET` 可以覆盖它，单条非 bundled 描述还受 250 字符上限约束。Bundled prompt skill 不截断，非 bundled skill 则保留名称，或在预算内均匀截短描述。

调用入口的 prompt 还明确要求：遇到对应任务必须先调用 Skill，不能把 Skill 当成一个无需展开的 CLI 别名。清单和生成结果会被 memoize，避免每轮重复计算。因此 Skill 系统有两次控制：先用小预算暴露“有哪些能力”，再按需加载正文；目录本身也是被管理的上下文资源。

## 源码映射表

路径前缀 `restored-src/` 表示 2.1.88 source map 还原源码。行号以当前仓库为准。

| 机制 | 关键符号 | 位置 | 证据状态 |
| --- | --- | --- | --- |
| 发现 | `loadSkillsFromSkillsDir()` | `src/skills/loadSkillsDir.ts` | 已确认 |
| 发现 | `getSkillDirCommands()` 多来源合并 | `src/skills/loadSkillsDir.ts` | 已确认 |
| 发现 | `getSkills()` / `loadAllCommands()` 装配 | `src/commands.ts` | 已确认 |
| 解析 | `parseSkillFrontmatterFields()` | `src/skills/loadSkillsDir.ts` | 已确认 |
| 注册 | `createSkillCommand()` → PromptCommand | `src/skills/loadSkillsDir.ts` | 已确认 |
| 索引 | `getCharBudget()` / `formatCommandsWithinBudget()` | `src/tools/SkillTool/prompt.ts` | 已确认 |
| 索引 | `getSkillListingAttachments()` / `skill_listing` | `src/utils/attachments.ts` | 已确认 |
| 模型入口 | `inputSchema` / `validateInput()` | `src/tools/SkillTool/SkillTool.ts` | 已确认 |
| 用户入口 | `userInvocable === false` 拒绝 | `src/utils/processUserInput/processSlashCommand.tsx` | 已确认 |
| 权限 | `SkillTool.checkPermissions()` deny/allow/ask | `src/tools/SkillTool/SkillTool.ts` | 已确认 |
| 权限 | `command_permissions` 附件 / `allowed-tools` | `src/utils/processUserInput/processSlashCommand.tsx` | 已确认 |
| 展开 | `getPromptForCommand()` 参数/变量/shell | `src/skills/loadSkillsDir.ts` | 已确认 |
| 执行 | `SkillTool.call()` inline / `executeForkedSkill()` | `src/tools/SkillTool/SkillTool.ts` | 已确认 |
| 恢复 | `addInvokedSkill()` | `src/utils/processUserInput/processSlashCommand.tsx` | 已确认 |
| 动态 | `discoverSkillDirsForPaths()` / `paths` 条件 | `src/skills/loadSkillsDir.ts` | 已确认 |

## 设计决策

**第一，为什么渐进披露而不是全文常驻？** 全文常驻的成本随 Skill 数量线性增长，且每个 Skill 的 token 都由所有请求承担。渐进披露把常驻成本压成"名称 + 短 description + whenToUse"（1% 窗口、250 字/条），全文只在选中后展开；代价是描述质量直接影响模型能否选对，预算截断会惩罚写得过长的描述。
**第二，为什么归一为 PromptCommand 而不是独立执行器？** 用户斜杠、模型 SkillTool、插件与 MCP 如果各写一套执行器，参数、权限与错误语义会分叉。归一为 `type: 'prompt'` 后，入口表（`user-invocable` × `disable-model-invocation`）、`allowed-tools` 与 `context: fork` 全部复用 Command 的消息路径与 Query Loop；Skill 因此获得"和命令一致"的恢复与遥测语义。
**第三，为什么 `allowed-tools` 不构成无条件授权？** 权限系统必须区分"说明怎样做"（Skill 正文）与"是否允许做"（工具校验）。`command_permissions` 只把附加 allow 规则交给权限上下文，现有 deny、宿主限制与沙箱边界仍然生效；如果把 Skill 声明当成授权本身，一个恶意或过期的 Skill 就能绕过用户权限配置。
**第四，为什么 fork 是上下文所有权决策而不是固定模式？** 长 Skill 的过程消息会快速占满主会话窗口，隔离到子 Agent 后父会话只收结果；但 fork 也切断了子 Agent 的完整历史可见性。因此 `context: fork` 是显式声明，重任务默认隔离，轻任务 inline。同一份定义、两种所有权，代价由 Skill 作者按任务形状选择。

## 练习

1. **从零定义一个 Skill 并观察生命周期**，在项目 `.claude/skills/release-note/SKILL.md` 写一个带 `name`、`description`、`argument-hint`、`allowed-tools: Read Grep Bash`、`context: fork` 的 Skill。启动 `claude`，输入 `/` 确认它出现在候选里（发现+索引阶段），然后调用它并检查 `/context` 或 debug 日志中的消息，正文是否在调用后才展开，`Base directory for this skill` 前缀是否出现（展开阶段）。
2. **验证入口表**，把同一个 Skill 的 `user-invocable` 改为 `false`，输入 `/release-note`，确认得到拒绝消息且 `shouldQuery: false`；把 `disable-model-invocation` 改为 `true`，确认模型无法通过 `Skill` 工具调用它。两组观察应各自独立成立。
3. **验证权限路径**，给 Skill 声明 `allowed-tools: Bash`，然后在项目里配置 deny `Bash:*` 的权限规则，再调用 Skill，确认 Skill 本身可以被调用（或询问），但正文要求执行的 Bash 仍会被 deny，`allowed-tools` 没有绕过 deny。
4. **观察动态发现**，在项目深层子目录放一个嵌套 `.claude/skills/` 与 `SKILL.md`，用文件工具打开该目录下的文件，确认 Skill 列表在会话中出现新增（增量视图），且只宣布首次见到的 Skill。

## 自测

1. `user-invocable: false` 与 `disable-model-invocation: true` 分别控制什么入口？
2. `skill_listing` attachment 在什么条件下才注入？模型看到的内容为什么只是短索引？
3. `loadedFrom: 'mcp'` 的 Skill 为什么跳过内联 shell 展开？

<details>
<summary>参考答案</summary>

1. **分别控制用户与模型入口。** `user-invocable: false` 使 `isHidden` 为真并阻止用户 `/name`（`processSlashCommand.tsx` 在展开前返回拒绝消息、`shouldQuery: false`）；`disable-model-invocation: true` 把 Skill 从模型可调用列表移除，并被 SkillTool 校验拒绝。两者独立，组合后四种入口状态见上文入口表。
2. **只有 Agent 拥有 Skill 工具时才注入。** `getSkillListingAttachments()` 先检查 `options.tools` 是否包含名称匹配 `Skill` 的工具，没有则返回 `[]`。模型看到的只是 `formatCommandsWithinBudget()` 裁剪后的短索引（1% 窗口、单条 250 字上限），因为渐进披露的设计目标就是让模型上下文只承担"知道有哪些能力"，全文由 `getPromptForCommand()` 在选中后展开。
3. **因为 MCP Skill 被视为远端、不受信任的内容。** `getPromptForCommand()` 里 `if (loadedFrom !== 'mcp')` 才调用 `executeShellCommandsInPrompt()`；精确值 `'mcp'` 直接跳过内联 shell 执行，避免远端注入的正文在本地执行 shell 命令。

</details>

## 回顾｜为什么在长文本开头输入 / 不会弹出 Skill 提示

<details>
<summary>展开查看回顾</summary>

上一篇问，如果你在 Claude Code 中输入了一大段文字，然后回到开头在最前面输入 `/` 想选择一个 Skill，为什么这时不会弹出 slash 命令提示？

这通常是 2.1.88 的 typeahead 处理范围过大。它把整个输入框的字符串当作一条 slash 命令来判断。你在已有长文本前插入 `/` 后，光标虽然在第一个字符后面，但 `value` 已经变成 `/<原来的长文本>`；提示系统没有把"光标所在的命令 token"和光标后的草稿分开。

源码里的第一道判断是 `isCommandInput(input)`，它只返回 `input.startsWith('/')`，不看光标位置。接着，`findMidInputSlashCommand()` 明确先排除 `input.startsWith('/')`，所以这个场景不会进入"中间位置 slash"的 ghost text 路径。然后是导致"没有 popup"的关键分支 `hasCommandWithArguments()`，用户的长文本通常包含空格，而光标不在文本末尾时，`"/长文本..."` 被视为"已经有命令参数的输入"，`updateSuggestions()` 直接跳过 `generateCommandSuggestions()` 并清掉旧提示。即便长文本没有空格，`generateCommandSuggestions()` 搜索的也是 `value.slice(1)`，整段原文，而不是光标前 `/` 后面的短 token，自然很难匹配 `review`、`publish` 这类 Skill 名称。

因此，问题在于命令候选计算使用了整段输入。修复时不能简单删掉"有空格就不提示"的保护，它原本是为了避免用户已经输入命令参数时，Tab/Enter 又选中另一条命令。更准确的修复是以 `cursorOffset` 切出光标处的 `/token` 只做匹配，并把光标后的原文作为 suffix 保留。实际使用时，最稳妥的顺序是先在空输入或只保留 `/skill` 的状态下选择 Skill，再把长文本作为参数粘贴进去。

</details>

## 留给下一篇的问题

如果你想自己定义一个 Skill slash 命令，你应该怎么实现？

## 相关链接

- **上一篇**，[21 用户如何进入不同执行流程](./21-command-system.md)，Command 三类型路由
- **下一篇**，[23 前台、后台与状态机如何协作](./23-task-runtime.md)，回答本文的 Skill 自定义问题
- **平行阅读**，[17 长会话如何继续运行](./17-context-compaction.md)，`addInvokedSkill` 与压缩恢复
- **官方文档**，[Claude Code Skills](https://code.claude.com/docs/en/skills)、[扩展能力总览](https://code.claude.com/docs/en/features-overview)、[Extend Claude with skills](https://code.claude.com/docs/en/slash-commands)
- **外部资料**，[Lessons from building Claude Code， How we use skills](https://claude.com/blog/lessons-from-building-claude-code-how-we-use-skills)、[Skills from marketplace plugins don't appear in slash command autocomplete #18949](https://github.com/anthropics/claude-code/issues/18949)
