---
title: "Claude Code源码解读22：提示词如何变成可执行能力"
published: 2026-07-24T16:47:09+08:00
updated: 2026-07-24T16:47:09+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-22/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：命令系统能够加载能力以后，Claude Code 的 Skills 如何被发现、描述、按需展开，并影响模型与工具执行？

先说结论。Claude Code 2.1.88 没有把 Skill 实现成另一种模型，也没有在启动时把每份 `SKILL.md` 全文都塞进上下文。它先从 managed、user、project、plugin、bundled 与 MCP 等来源收集 Skill，把每一份定义归一化为 `type: 'prompt'` 的 Command；随后只把名称、description、`whenToUse` 等发现信息放进 `skill_listing`，让模型知道“有什么能力可以用”。

真正调用时才展开正文。用户可以输入 `/skill-name args`，模型则调用 `Skill` 工具并传入 `{ skill, args? }`。两条入口最后都会取得同一个 PromptCommand，替换参数与内置变量，注册 hooks，把 `allowed-tools` 转成当前轮的权限信息，再根据 `context` 走两条路径：

- `context` 没有写成 `fork` 时，Skill 正文作为 meta user message 进入当前 Query Loop；
- `context: fork` 时，正文交给 `runAgent()`，父会话只接收子 Agent 的结果。

这里有一个容易误解的地方：**“按需展开”指的是全文按需进入模型上下文，不代表程序直到调用时才从磁盘读取文件。** 文件型 Skill 在发现阶段已经读取并解析了 `SKILL.md`，正文保存在 Command 的闭包里；但 Claude 起初通常只看到受预算约束的简介，调用后才看到完整指令。

Skill 也不是权限后门。模型调用 `Skill` 工具本身要经过 allow、ask、deny；Skill 声明的 `allowed-tools` 会成为后续工具调用的附加规则，但仍处在统一权限引擎里。`disable-model-invocation: true` 可以禁止模型主动调用，`user-invocable: false` 则禁止用户通过斜杠入口调用。两个开关分别约束两个方向。

本文仍以仓库从 `@anthropic-ai/claude-code@2.1.88` source map 还原出的源码为边界。下面只截取证明控制流所需的真实短代码，省略日志、遥测、实验分支和无关参数；还原路径不等于 Anthropic 内部仓库的原始组织方式。

## Skill 是一份可发现、可展开的能力说明

先补三个基础概念。

第一个是 **Skill**。它通常以 `skill-name/SKILL.md` 存在，Markdown 正文描述执行方法，frontmatter 描述名称、适用时机、参数、模型、工具和运行上下文。它没有新的推理内核，最终仍要变成消息并进入 Query Loop，或者交给子 Agent 运行。

第二个是 **渐进展开（progressive disclosure）**。如果系统有几十个 Skill，把所有全文放进第一轮上下文，会同时浪费 token、污染注意力，也会让 prompt cache 因任意 Skill 改动而大面积失效。因此运行时先给模型一份短目录，模型选中后再展开一项全文。

第三个是 **PromptCommand**。上一篇讲过 Command 负责输入路由。Skill 复用了这套契约：加载器把 Markdown 包装成 `type: 'prompt'` 的 Command，于是 `/pdf`、模型的 `Skill({ skill: 'pdf' })`、插件 Skill 和 bundled Skill 可以共用参数替换、消息包装、权限附件与 fork 逻辑。

整条链可以先看成这张图：

![Claude Code Skill 发现、渐进展开与执行路径手绘图](/images/posts/claude-code-source-reading-22/22-skill-system-handdrawn.png)

图里的关键分界在 `skill_listing` 与 `expand full prompt` 之间。前者解决“Claude 如何知道有哪些能力”，后者解决“选中以后，完整指令怎样进入执行流”。

## 发现不是扫一个目录，而是合并多类来源

文件型 Skill 的基本格式很严格：`skills` 目录下面必须先有子目录，再在子目录中放 `SKILL.md`。直接丢一份 `review.md` 不会被这条加载器识别。

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

**函数说明：** `loadSkillsFromSkillsDir()` 位于 `restored-src/src/skills/loadSkillsDir.ts`。它并发枚举一个 skills 根目录，只接受目录或符号链接，并读取其下名称精确为 `SKILL.md` 的文件。示例省略了单文件错误隔离、Command 构造和返回路径；真实源码里某个条目读取失败会返回 `null`，不会让整批 Skill 一起失败。

**参数说明：** `basePath` 是开放路径字符串，没有默认值；`source` 是 `SettingSource`，源码可见的相关来源包括 `'policySettings'`、`'userSettings'`、`'projectSettings'`。目录项必须是 directory 或 symbolic link；普通 `.md` 文件被明确跳过。`readFile()` 的编码固定为 `'utf-8'`。函数返回数组，根目录不可访问或条目无 `SKILL.md` 时回退空结果，而不是返回 `undefined`。

上层的 `getSkillDirCommands()` 再把多个文件来源并行合并：

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

**代码说明：** 这段同样位于 `loadSkillsDir.ts`。正常模式会收集托管、用户、从 cwd 向上发现的项目目录、`--add-dir` 指定目录，以及兼容旧 `/commands/` 的定义。真实源码还在每项前检查 setting source、plugin-only policy 与 `CLAUDE_CODE_DISABLE_POLICY_SKILLS`，因此这里的五个调用并非在所有运行环境都无条件发生。

**参数说明：** `projectSkillsDirs` 与 `additionalDirs` 都是路径数组，空数组通过 `Promise.all([])` 得到空结果。source 的三个候选值会保留在 Command 元数据里。`--bare` 是特殊分支：它跳过 managed/user/project 自动遍历和 legacy commands，只读取显式 `--add-dir`，但 bundled Skill 在另一处注册，且 plugin-only policy 仍能阻止项目 Skill；所以 `--bare` 不是策略绕过。

合并后还会用 `realpath()` 解析符号链接，对“同一真实文件从多个路径被发现”的情况做 first-wins 去重。这里去重的是文件身份，不是 Skill 名称；两个不同文件即使同名，仍可能继续进入后续命令装配，最终由数组顺序和 `findCommand()` 的第一个匹配决定命中项。

文件目录只是来源之一。`getSkills()` 还并行加载插件 Skill，并读取启动时同步注册的 bundled Skill 与内置插件 Skill：

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

**函数说明：** `getSkills()` 位于 `restored-src/src/commands.ts`。它把磁盘 Skill、插件 Skill、bundled Skill 和内置插件 Skill 交给上一篇提到的 `loadAllCommands()` 装配。MCP Skill 不在这四项中；它来自 `AppState.mcp.commands`，在 Skill 列表和 SkillTool 查找时单独合并。

**参数说明：** `cwd` 是必填路径，传给文件加载器，没有内部默认 cwd。两个异步加载器各自 `catch` 并回退 `[]`；最外层防御性 `catch` 也会把四个字段全部置为空数组。这说明 Skill 是非关键扩展：加载失败会损失能力，但不会因此阻止 Claude Code 启动。

## Frontmatter 把 Markdown 变成可路由的元数据

发现文件以后，`parseSkillFrontmatterFields()` 负责处理默认值和特殊值：

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

**函数说明：** `parseSkillFrontmatterFields()` 位于 `restored-src/src/skills/loadSkillsDir.ts`。它把 YAML frontmatter 转成统一字段，同时从正文提取 description 作为缺省值。这里只展示最影响控制流的四项；源码还解析 `name`、`argument-hint`、`arguments`、`when_to_use`、`version`、`hooks`、`agent`、`effort`、`paths` 与 `shell`。

**参数说明：** `user-invocable` 缺省时明确为 `true`；显式假值会使 `isHidden` 为真，并阻止斜杠入口。`disable-model-invocation` 经布尔解析，缺省回退假值；真值会从模型可调用列表移除，并被 SkillTool 校验拒绝。`model: inherit`、缺省值与其他 falsy 值都归一为 `undefined`，表示不覆盖当前模型。`context` 只有精确字符串 `'fork'` 被接受；`'inline'`、其他字符串、`null` 或缺省都得到 `undefined`，后续按 inline 处理。`allowed-tools` 解析后始终是字符串数组，缺省为空数组。

两个布尔值构成了一张很实用的入口表：

| `user-invocable` | `disable-model-invocation` | 用户 `/name` | 模型 `Skill` 工具 |
|---|---|---|---|
| 缺省 `true` | 缺省 `false` | 可以 | 可以 |
| `false` | `false` | 不可以 | 可以 |
| `true` | `true` | 可以 | 不可以 |
| `false` | `true` | 不可以 | 不可以 |

这两个字段不保证调用一定成功。表格只描述入口资格；后面仍有命令查找、Skill 工具权限、下游工具权限、API、取消和运行错误。

解析结果接着被包装成 PromptCommand：

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

**函数说明：** 这段来自 `createSkillCommand()`。它证明 Skill 在运行时不是独立类型，而是 `type: 'prompt'` 的 Command。完整 Markdown 被闭包捕获，`getPromptForCommand()` 延迟完成参数、变量与 shell 展开。

**参数说明：** `skillName` 对文件型 Skill 来自目录名，是开放字符串；`description` 必有字符串回退；`allowedTools` 是数组；`executionContext` 可为 `'inline' | 'fork' | undefined`，文件 frontmatter 实际只产生 `'fork' | undefined`。`contentLength` 使用 JavaScript 字符串长度，不是 token 数。`isHidden` 只跟 `userInvocable` 取反，不等于禁止模型调用。

## 模型先看到目录，不先看到全文

运行时给 Skill 目录的预算不是无限的。`formatCommandsWithinBudget()` 先计算当前上下文窗口 1% 对应的字符预算，每项 description 加 `whenToUse` 后又有 250 字符硬上限：

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

**函数说明：** `getCharBudget()` 位于 `restored-src/src/tools/SkillTool/prompt.ts`。它为 Skill 发现目录计算字符预算，不限制调用后展开的 Skill 全文。格式化器先尝试完整简介；超预算时保留 bundled Skill 的简介，对其他项均摊截断，极端情况下只保留名称。

**参数说明：** `contextWindowTokens` 类型为 `number | undefined`。环境变量能被 `Number()` 解析为真值时优先使用；`0`、空字符串和 `NaN` 不会覆盖。参数为正值时按 `tokens × 4 × 1%` 向下取整；`undefined`、`0` 等 falsy 值回退 `8_000` 字符。单条 description 与 `whenToUse` 拼接后最多 250 字符，超出以省略号截断。

目录真正通过 attachment 注入，而且只有 Agent 拥有 Skill 工具时才注入：

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

**函数说明：** `getSkillListingAttachments()` 位于 `restored-src/src/utils/attachments.ts`。它合并本地与 MCP Skill，按名称去重，只发送当前 Agent 尚未收到的项目，并生成 `skill_listing` attachment。resume 时源码会先把已有列表标为已发送，避免 transcript 中已有目录被重复注入。

**参数说明：** `toolUseContext` 必填。`options.tools` 中没有名称匹配 `Skill` 的工具时直接返回 `[]`；`agentId` 可为 `undefined`，此时源码用空字符串作为主 Agent 的去重键。`mcpSkills` 为空时保留本地数组；非空时 `uniqBy()` 对同名项 first-wins。`isInitial` 是布尔值，只有该 Agent 的 sent set 原先为空才为真。实验性的 Skill Search 开启时，静态源码还会把完整列表裁成 bundled 与 MCP，其他 Skill 走搜索发现路径；。

这就是渐进展开真正节省 token 的地方：程序可以已经读过全文，但模型上下文只承担短索引。description 写得含糊，Claude 就可能选不中；description 写成一篇小作文，又会被 250 字符和总预算截断。

## 用户调用与模型调用在同一个定义上汇合

用户输入 `/pdf invoice.pdf` 时，上一篇的 Command 路由会找到 PromptCommand。模型主动调用时，则通过一个明确的工具 Schema：

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

**类型说明：** 这段位于 `restored-src/src/tools/SkillTool/SkillTool.ts`。`Skill` 工具不接收任意 JSON 配置，只接收名称和可选参数。后续 `validateInput()` 会去掉名称首尾空白，并兼容一个前导 `/`，再查找当前 Command。

**字段说明：** `skill` 是必填字符串，trim 后为空会校验失败；值可以写 `pdf`，兼容写法 `/pdf` 会被归一化。`args` 是 `string | undefined`，省略时调用路径通常回退 `''`；`null` 不在 Zod Schema 的候选值里。参数不会参与 Skill 名称查找，它在展开正文时交给占位符替换。

模型入口还明确拒绝三种情况：未知名称、`disableModelInvocation` 为真、以及找到的 Command 不是 `type: 'prompt'`。因此模型不能借 SkillTool 猜测并执行 `/help`、`/clear` 这类本地 CLI 命令。

用户入口则检查另一个字段：

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

**代码说明：** 这段来自 `restored-src/src/utils/processUserInput/processSlashCommand.tsx` 的 prompt 命令路径。`userInvocable === false` 会在展开正文之前结束，并把 `shouldQuery` 设为 `false`。

**参数说明：** 这里用的是严格等于 `false`；字段缺省已在解析期归一为 `true`，不会误伤旧 Skill。返回的 `messages` 只用于告知用户拒绝原因，`shouldQuery: false` 表示这条拒绝不会继续发给模型执行。

## 调用 Skill 本身也要经过权限判断

模型发出 `Skill` tool_use 后，权限顺序仍是 deny 优先、allow 次之、最后 ask：

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

**函数说明：** 这段精简自 `SkillTool.checkPermissions()`，省略了远端 canonical Skill、安全属性自动允许和规则建议。真实实现先检查 Skill deny 规则，再检查 allow；只有未命中规则、且不满足安全属性自动允许的 Skill 才询问用户。

**参数说明：** 第三个参数候选值在这里分别为 `'deny'` 与 `'allow'`。规则内容支持精确名称，也支持以 `:*` 结尾的前缀；比较前会移除规则和输入的前导 `/`。返回 `behavior` 候选值为 `'deny' | 'allow' | 'ask'`。`args` 保持 `string | undefined`，权限允许不会修改 Skill 正文，只把 `updatedInput` 交回工具生命周期。

Skill 获准调用以后，`allowed-tools` 才影响正文里的后续工具：

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

**代码说明：** 这段来自 `processPromptSlashCommand()`。它把 Skill 声明的工具字符串解析成权限规则，并附加到这次 prompt 命令产生的消息后面。后续 Query Loop 读取 `command_permissions`，而不是让 Markdown 自己直接执行工具。

**参数说明：** `command.allowedTools` 可为 `string[] | undefined`；`undefined` 通过 `?? []` 回退空数组。`allowedTools` 为空表示 Skill 不附加工具允许规则，不表示“允许全部工具”。`model` 可为字符串或 `undefined`；`undefined` 表示沿用当前模型。附加 allow 也不会删除现有 deny、宿主限制或沙箱边界，因此不能把它解释成无条件授权。

## 展开正文时还会处理参数、变量和 shell

`createSkillCommand()` 的闭包在调用时才生成最终文本：

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

**函数说明：** `getPromptForCommand()` 位于 `createSkillCommand()` 返回的对象中。它先在正文前补 Skill 根目录，再替换 `$ARGUMENTS`、位置/命名参数，最后替换 Skill 目录和当前 session ID。Windows 下 `skillDir` 会把反斜杠归一为正斜杠，避免 shell 把它当转义符。

**参数说明：** `baseDir` 是 `string | undefined`；文件型 Skill 通常有值，MCP 或部分注册型 Skill 可以没有。`args` 是 `string | undefined`，但调用方常把省略值转成 `''`；`appendIfNoPlaceholder` 在这里固定 `true`，因此模板没有占位符且 args 非空时，会追加 `ARGUMENTS:` 段落。`argumentNames` 是数组，缺省为空。`${CLAUDE_SESSION_ID}` 总会替换；`${CLAUDE_SKILL_DIR}` 只有 `baseDir` 存在时替换。

正文还支持内联 shell 展开，但这里有一条明确的信任边界：

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

**代码说明：** 仍然来自 `getPromptForCommand()`。非 MCP Skill 可以通过统一的 prompt shell 执行器处理内联命令；MCP Skill 被视为远端、不受信任的内容，直接跳过这一步。是否每个非 MCP Skill 都执行 shell 由正文语法和后续校验共同决定。

**参数说明：** `loadedFrom` 的源码联合值包括 `'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'`；只有精确 `'mcp'` 被排除。第三个参数是用于显示和审计的 `/${skillName}`。`shell` 可为解析后的 frontmatter 配置或 `undefined`；工具上下文会加入 `allowedTools` 对应的 command allow rules，但仍由 shell 执行器和权限系统处理。

## inline 与 fork 决定谁持有后续上下文

SkillTool 真正调用时先看 `command.context`：

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

**函数说明：** 这段位于 `SkillTool.call()`。`fork` 分支把 Skill 交给独立 Agent；其余情况通过 `processPromptSlashCommand()` 展开为当前会话的新消息。inline 不是同步执行完 Markdown，而是把完整指令送回 Query Loop，Claude 再依据指令决定是否调用其他工具。

**参数说明：** `command` 可能是 `undefined`，但此前 `validateInput()` 正常完成时应已证明命令存在；这里仍用可选链防御。`context` 只有精确 `'fork'` 进入子 Agent；`undefined` 和 `'inline'` 都走当前会话。`args || ''` 会把 `undefined` 与空字符串统一为空字符串。`onProgress` 是可选回调，只用于汇报 fork 执行进度，不决定成功。

fork 为什么存在？一份长 Skill 可能需要大量 Read、Grep 和中间推理。如果全部塞回主会话，它的过程消息会迅速占满上下文。`executeForkedSkill()` 创建 Agent ID、准备隔离上下文、调用 `runAgent()`，最后把抽取后的结果返回父会话。代价也很清楚：父会话拿到的是结果，不天然拥有子 Agent 的全部思考和工具历史。

inline 则适合需要继续利用当前对话上下文、且结果应自然成为本轮一部分的 Skill。两者共享同一份 Skill 定义，却选择不同的上下文所有权。

展开成功后，`processPromptSlashCommand()` 还会把正文登记到 `invokedSkills`：

```ts
addInvokedSkill(
  command.name,
  skillPath,
  skillContent,
  getAgentContext()?.agentId ?? null,
)
```

**函数说明：** `addInvokedSkill()` 把 Skill 名称、来源路径、已展开内容、时间和 Agent ID 写进 bootstrap state。第 17 篇讲过，compaction 后系统需要重新提供仍有效的执行指令；这份状态就是恢复已调用 Skill 的依据之一。

**参数说明：** `skillName`、`skillPath`、`content` 都是必填字符串。`agentId` 类型为 `string | null`，这里没有 Agent 上下文时通过 `?? null` 明确归到主会话；函数签名本身也默认 `null`。内部 key 使用 `${agentId ?? ''}:${skillName}`，使同名 Skill 在不同 Agent 之间隔离，避免压缩恢复时串线。fork Agent 结束后还有清理该 Agent Skill 状态的路径，因此不能把它理解成永久存储。

## 动态发现让 Skill 跟着文件位置出现

启动扫描并不是全部。文件工具触及项目深处的路径时，Claude Code 会从文件父目录向 cwd 回溯，寻找嵌套的 `.claude/skills`：

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

**函数说明：** `discoverSkillDirsForPaths()` 位于 `restored-src/src/skills/loadSkillsDir.ts`。它只发现 cwd 以下的嵌套 Skill 目录，因为 cwd 层已经在启动时加载；每个候选目录无论存在与否都记入 `dynamicSkillDirs`，避免后续文件操作反复 `stat`。gitignored 路径会被跳过。

**参数说明：** `filePaths` 是必填路径数组；`cwd` 是回溯上界。空数组返回 `[]`。前缀检查带 `pathSep`，避免 `/project-backup` 被误判为 `/project` 子目录。返回值按路径深度从深到浅排序；`addSkillDirectories()` 随后反向处理，让更深、离文件更近的同名 Skill 最后写入 Map 并覆盖较浅项。

frontmatter 的 `paths` 还支持条件 Skill：启动时先把它们放进 `conditionalSkills`，当实际文件路径匹配 gitignore 风格 pattern 时才加入动态集合。`paths` 为空、全是 `**`、或解析后没有有效 pattern，会回退为无条件 Skill。这个机制让语言或目录专用能力不必永远占据全局 Skill 列表。

动态加载完成后会发送 signal 清理 Command/Skill 索引缓存，并在后续 attachment 中只宣布该 Agent 没见过的新 Skill。也就是说，Skill 列表是会话中的增量视图，不是启动瞬间冻结的一份常量。

## 为什么这样实现

把 Skill 直接拼进 system prompt，代码会短一些，但会带来四个问题。

第一，成本不可控。每新增一份 Skill，所有请求都承担全文 token；渐进展开把常驻成本压成名称和短描述。

第二，入口难统一。用户斜杠命令、模型主动调用、插件和 MCP 各写一套执行器，会产生不同的参数、权限和错误语义。归一为 PromptCommand 后，它们复用同一条消息路径。

第三，权限容易混淆。Skill 的“说明怎样做”与工具的“是否允许做”必须分开。`allowed-tools` 只是把规则交给权限上下文，真正的 Bash、Edit、MCP 工具仍执行自己的校验。

第四，上下文难隔离。简单 Skill 可以 inline，重任务可以 fork；如果 Skill 天生等于一段全局 prompt，就很难把长过程放进独立 Agent 再只回传结果。

因此，Skill 更准确的心智模型是：

`可发现元数据 + 延迟展开的正文 + Command 路由 + Tool 权限 + 可选 Agent 上下文`

它把“团队经验”变成一种声明式扩展，但执行能力仍来自 Claude Code 已有的 Query Loop、工具注册表、权限引擎和 Agent 运行时。

## 小结

Claude Code 的 Skill 系统没有另造一套执行内核。它把多来源的 `SKILL.md` 与注册型能力归一为 PromptCommand，用短 description 和 `whenToUse` 建立发现索引，再在用户或模型真正选中时展开完整正文。

`user-invocable` 与 `disable-model-invocation` 分别控制用户和模型入口；`allowed-tools` 把附加规则交给权限系统，并不绕过 deny 与沙箱；`context: fork` 把长过程隔离到子 Agent，其他值则在当前 Query Loop 内继续。动态目录与 `paths` 条件又让能力可以随着文件位置按需出现。

所以，Skill 的核心价值不是“保存一段提示词”，而是给提示词补上发现、路由、权限、上下文与恢复语义。下一篇就沿 fork 背后的公共设施继续往下看：Claude Code 怎样把一次长时间工作变成可创建、可观察、可取消并最终收束的 Task。

## 留给下一篇的问题

Skill 把一组指令按需展开以后，Claude Code 的 Task 运行时如何创建、调度、观察并收束长时间任务？

