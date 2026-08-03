---
title: "Claude Code源码解读47：非核心反馈通道如何协作"
published: 2026-07-24T16:47:34+08:00
updated: 2026-08-03T20:08:42+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-47/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

MagicDocs 的最佳实践是什么？

先给结论：**把 MagicDocs 当成“会被持续维护的、高信号架构索引”，不要把它写成项目百科、变更日志或 API 手册。** 一份好的 Magic Doc 只回答几件读者真正需要重新发现的问题：这个子系统为什么存在，关键入口在哪里，组件怎样连接，哪些约定或陷阱不明显，以及设计取舍是什么。它应该短、稳定、能帮助下一位工程师找到源码，而不是把源码重新抄一遍。

这里有一个必须先说清楚的版本边界：本系列还原的是 2.1.88。源码中的 `initMagicDocs()` 只有在 `process.env.USER_TYPE === 'ant'` 时才注册文件读取监听器和 post-sampling hook；普通公开构建不能仅靠创建 `# MAGIC DOC:` 文件或写 `~/.claude/magic-docs/prompt.md` 打开这条内部路径。非官方追踪文章还记录了 MagicDocs 在 v2.1.91 被移除。因此，下面的“最佳实践”首先适用于理解这套内部设计；普通用户若要落地，应使用 skill、subagent、Stop hook 或插件做一个受控的等价实现，而不是假定当前 CLI 仍会自动更新它。

社区实现 Airbender 给出了一个很实用的分流原则：**描述系统如何工作**的事实适合放进 MagicDocs；**每次都必须成立的前置假设**放进 `CLAUDE.md`；**需要在某个动作发生时重新加载的步骤**做成 Skill；**可以完全机械验证的规则**交给 Hook；**偶尔才相关的个人偏好**放进 Memory。这样做的价值不是多几个目录，而是避免把所有内容塞进每轮都会消耗上下文的 `CLAUDE.md`。

**第一条实践是按架构边界拆文档。** 不要建立一份覆盖整个仓库的 `architecture.md`，也不要按每个源文件创建一份。更好的切分单位是一个子系统、一个稳定入口或一条跨模块边界，例如 `Authentication`、`Billing`、`Query Loop`。Airbender 的初始化流程会先探索仓库，再让用户在“按子系统、按顶层目录、按入口点或混合切分”之间选择；这比让模型自行决定几十个文件更容易保持长期稳定。一个文档可以从几百词的骨架开始，只有出现非显然的新洞见时才增长。

**第二条实践是把标题和作者意图当成接口。** 文件开头使用稳定的标题：

```md
# MAGIC DOC: Authentication architecture

_只保留稳定入口、安全边界和非显然的失败模式。_
```

2.1.88 的 `detectMagicDocHeader(content)` 会识别 `# MAGIC DOC:` 标题，并把标题后紧邻的斜体行作为可选的文档专属说明。源码的匹配正则实际上允许多行位置，但实践上仍应把标题放在第一行；标题和斜体说明一旦建立，就不要让自动更新器改名或重写。斜体说明应描述“这份文档应该保留什么”，而不是塞入一套与通用提示词重复的编码规范。

**第三条实践是只写高信号的当前状态。** 外部作者提炼出的 MagicDocs 原始提示词，和社区复刻实现的 README，都反复强调同一组边界：

| 应该保留 | 应该删除或避免 |
| --- | --- |
| 高层架构、关键入口、组件连接方式 | 逐函数、逐参数、逐行的代码导览 |
| 非显然约定、陷阱、失败边界 | 代码一眼就能看出的信息 |
| 设计决策及其理由、关键依赖 | 每次提交的 changelog、历史叙述 |
| 指向源码、文档和协议的导航链接 | 低级实现细节、重复的 `CLAUDE.md` 内容 |

“当前状态”比“历史过程”更重要。模块从 Redis 换成 Postgres 后，直接改写“当前使用 Postgres”这段；不要追加“以前使用 Redis，现在改成……”的流水账。这样下一次 fork 读取时得到的是可用地图，而不是考古记录。

**第四条实践是只有实质性新信息才触发更新。** 源码默认提示要求模型在没有 substantial new information 时不调用 `Edit`，而不是每次对话结束都生成一次“我检查过了”。普通用户复刻时也应保留这个门槛：一次工具调用、一次已经写进文档的事实或一条临时错误，不值得触发文档改写；新的系统边界、关键依赖、非显然 gotcha 才值得进入文档。更新必须是就地替换、删除过时内容或整理结构，不能把每轮对话追加到文件末尾。

**第五条实践是把自动写入限制在精确文件。** 2.1.88 的 MagicDocs Agent 只有 `Edit` 工具，`canUseTool` 还会检查输入的 `file_path` 必须等于当前被跟踪的文档路径；`Write`、Bash 和其他文件路径全部 deny。它在 forked context 中运行，主会话继续自己的工作。社区复刻如果只做到“后台启动一个 subagent”，却没有精确路径权限，结果很容易从维护一份架构文档变成顺手修改源码、配置甚至删除文件。最低安全线应包括：只允许目标文档的 Edit、保留 git diff/备份、自动更新前后做 Markdown 与链接检查，并把失败当成旁路失败而不是阻塞主任务。

**第六条实践是给自动化增加一个“清理”回路。** 内部实现只在主 REPL 自然收尾、最后一条 assistant turn 没有 tool call 时串行更新已经读过的文档；文件被删除、不可读或移除标题后，它会停止跟踪。Airbender 的公开复刻再加了一层 Stop hook：退出时检查 `git diff`，清掉失效路径和死链接。这两层职责不同：后台更新负责捕获新洞见，Stop hook 负责结构性收敛。不要用一个无限运行的 hook 在每次工具调用后重写整套文档。

**第七条实践是定期用新上下文验收，而不是只看文件变长。** 可以用一个全新的 subagent 或新会话问三类问题：能否从文档找到真正入口，能否说出一个非显然的失败边界，能否指出文档与当前代码不一致的地方。如果答案仍然需要重新扫描整个仓库，说明文档没有提供导航；如果回答大量复述源代码，说明信号密度太低；如果无法找出过期路径，说明清理回路不够。社区作者还把这种过程写成 red/green/refactor：先用干净上下文测试缺口，再加入最小文档，最后删除没有带来行为改善的内容。

最后给一个可执行的判断表：

| 信息 | 更合适的落点 |
| --- | --- |
| “认证模块由哪些组件组成、入口在哪里、为什么这样连” | MagicDocs 或等价的架构文档 |
| “这个仓库永远用 pnpm，提交前必须跑测试” | `CLAUDE.md` 或机械 Hook |
| “发布时按这 8 步执行并等待审批” | Skill |
| “用户偏好把多个小改动合成一个 PR” | Memory |
| “能用脚本 100% 判定的格式/测试规则” | Hook |

因此，MagicDocs 最佳实践不是“让 Claude 自动多写一些 Markdown”，而是维护一张小而准确的系统地图：按边界切分、稳定标题、当前状态、高信号内容、实质性变更才更新、精确路径权限、后台更新加退出清理，并且随时准备在公开版本里用 Skill/Hook/Subagent 替代它。

## 本章先建立三个概念

- **反馈通道**：生成前样式、运行中通知和跨 Agent 消息分别作用于表达、注意力与协作。

- **Mailbox 投递**：地址解析、队列和空闲唤醒把消息送到目标会话的下一次可执行时刻。

- **呈现策略**：Output Style 修改 system prompt 中的表达约束，宿主再决定终端、SDK 或系统通知的载体。

![Output Style、Notification 与 Mailbox 三条反馈通道](/images/posts/claude-code-source-reading-47/47-feedback-channels-detail-handdrawn.png)

先区分“模型如何生成”“Agent 如何收到”和“用户如何被唤回”，后面的队列与输出分支就不会混成一条消息管道。

## YNM-9527 的结果怎样回到用户身边

用户最后输入：

> 报告根因、改动、测试、成本和遗留风险；后台测试完成、Agent Team 出现合并冲突或部署前仍有风险时主动通知我。

Output Style 决定最终报告“怎么说”，UI Notification 只显示短暂状态，OS Notification、Hook 和 Mailbox 则负责在用户离开当前界面后把重要结果送回来。teammate 忙时，消息先进入 inbox 或进程内队列，空闲后才成为下一轮可消费的输入。

前面章节已经产生了 task、team、memory 和远程连接，本章把这些结果收束到三条不同反馈通道，说明它们为什么不能混成一条普通 assistant 文本。

## 三种反馈通道，解决三个不同问题

![Claude Code 的 Output Style、Mailbox、Notification 与宿主输出闭环](/images/posts/claude-code-source-reading-47/47-notifications-mailbox-output-styles-handdrawn.png)

图里的三条路径彼此并行，各自在不同阶段解决一种反馈问题：

- **Output Style 是生成约束。** 它在调用模型以前改变 system prompt。
- **Mailbox 是内容与控制消息的投递机制。** 它关心目标 Agent、忙闲状态、持久化与消费时机。
- **Notification 是注意力机制。** 它告诉人“有事发生”，但不承担完整结果的可靠传输。
- **TUI / SDK 是结果宿主。** 它们决定消息怎样呈现或序列化；模型写作风格由 Output Style 在生成前约束。

### 先补四个基础概念

第一个概念是 **feedback channel**。一次 Agent 工作结束后，至少有两种受众：模型或其他 Agent 需要可继续推理的内容，人只需要知道“完成、等待输入、需要审批”。把两类反馈混在一起，要么会让模型上下文充满 UI 状态，要么会让人只收到机器协议。

第二个概念是 **mailbox**。这个词在源码里并不只指一种东西。`utils/mailbox.ts` 是进程内、可按谓词消费的队列；Agent Teams 主要使用 `utils/teammateMailbox.ts` 的文件 inbox，并在 AppState 里保留忙时待交付消息。讨论 mailbox 时必须先说明是哪一层。

第三个概念是 **output style**。它是写给模型的行为提示，例如默认、`Explanatory`、`Learning`，以及用户、项目或插件提供的 Markdown style。ANSI 颜色和 Ink 布局由 renderer 负责，CLI 的 `--output-format` 则由输出宿主处理。

第四个概念是 **delivery 与 attention 的区别**。一条 teammate 消息被可靠写入 inbox，解决的是 delivery；终端响铃或桌面弹窗解决的是 attention。二者各自保留确认点：inbox 记录读取消费，通知通道只记录发起动作。

## Output Style：在生成之前决定“怎么说”

内置 output style 只有 `default`、`Explanatory` 和 `Learning`。`default` 对应 `null`，表示不追加专门的 style prompt；后两种都保留通用 coding instructions，并额外要求解释实现选择或邀请用户完成小段关键代码。

自定义 style 来自 Markdown 文件和插件。加载顺序决定同名覆盖关系，强制插件 style 则在普通 settings 选择之前生效：

```ts
export async function getOutputStyleConfig(): Promise<OutputStyleConfig | null> {
  const allStyles = await getAllOutputStyles(getCwd())
  const forcedStyles = Object.values(allStyles).filter(
    style =>
      style !== null &&
      style.source === 'plugin' &&
      style.forceForPlugin === true,
  )

  const firstForcedStyle = forcedStyles[0]
  if (firstForcedStyle) return firstForcedStyle

  const settings = getSettings_DEPRECATED()
  const outputStyle = settings?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME
  return allStyles[outputStyle] ?? null
}
```

**函数说明：** `getOutputStyleConfig()` 位于 `restored-src/src/constants/outputStyles.ts`。`getAllOutputStyles()` 先放入内置 style，再按 plugin、user、project、managed 的实际数组顺序覆盖同名项；因此同名时后写入的 managed 优先级最高。随后它从 `allStyles` 中收集 `forcedStyles`，取第一个 `firstForcedStyle`；该数组为空时才读取 settings。

**参数说明：** 函数接受零个参数，返回 `OutputStyleConfig | null`。settings 未选择 style 时，`outputStyle` 回退 `'default'`；该名字或显式配置的名字在 `allStyles` 中零匹配时，返回 `null`，后续 system prompt 会保留通用任务说明并跳过专门的 style section。`forceForPlugin` 可为 `true`、`false` 或 `undefined`，只有严格等于 `true` 才进入 `forcedStyles`。

style 在 system prompt 装配阶段生效：

```ts
const [skillToolCommands, outputStyleConfig, envInfo] = await Promise.all([
  getSkillToolCommands(cwd),
  getOutputStyleConfig(),
  computeSimpleEnvInfo(model, additionalWorkingDirectories),
])

const dynamicSections = [
  systemPromptSection('output_style', () =>
    getOutputStyleSection(outputStyleConfig),
  ),
  // unrelated dynamic sections omitted
]

const resolvedDynamicSections =
  await resolveSystemPromptSections(dynamicSections)

return [
  getSimpleIntroSection(outputStyleConfig),
  getSimpleSystemSection(),
  outputStyleConfig === null ||
  outputStyleConfig.keepCodingInstructions === true
    ? getSimpleDoingTasksSection()
    : null,
  // unrelated static sections omitted
  ...resolvedDynamicSections,
].filter(s => s !== null)
```

**函数说明：** 这段来自 `restored-src/src/constants/prompts.ts` 的 `getSystemPrompt()`，展示普通主循环怎样读取 style、决定是否保留通用 coding instructions，并把 `# Output Style: ...` 段落加入动态 system prompt。style 因而在模型生成前影响自然语言与行动方式。

**参数说明：** `getSystemPrompt(tools, model, additionalWorkingDirectories?, mcpClients?)` 的 `tools` 是当前工具数组，`model` 是开放模型标识；两个后置参数都可为 `undefined`。`outputStyleConfig` 只有具体配置或 `null`：为 `null` 时保留通用任务说明并跳过 style section；`keepCodingInstructions === true` 时也保留，`false` 或 `undefined` 时只要存在自定义 style 就移除该通用段。若 `CLAUDE_CODE_SIMPLE` 为真，函数会提前返回极简 prompt；proactive/KAIROS 激活也走另一条提前返回路径。这两条静态路径在拼接 output style 前结束，因此适用范围只覆盖普通主循环。

自定义 Markdown 的 `keep-coding-instructions` 接受布尔 `true` / `false`，也接受字符串 `'true'` / `'false'`；其他值落到 `undefined`。插件还可以提供 `force-for-plugin`，其他来源设置该字段会记录警告并忽略。output style 因此是一段带来源、优先级和解析规则的 system-prompt 配置。

### 同一个用户问题，三份不同的 system prompt

这里用同一个用户输入作对照：

```text
请解释 src/auth/validateInput.ts 的校验流程，指出一个容易被忽略的失败边界。
```

用户输入本身没有变化，变化的是模型收到的动态 system-prompt section。`getOutputStyleSection()` 的实现非常直接：有 style 时先写入 `# Output Style: <name>`，再拼接该 style 的 `prompt`；没有 style 时返回 `null`。因此，下面展示的是实际会被拼进 system prompt 的关键片段（为便于阅读，Learning 的长示例只保留与行为有关的部分）：

| 选择 | 追加到 system prompt 的内容 | 对同一问题的可观察倾向 |
| --- | --- | --- |
| `default` | 不追加 `# Output Style` section；通用 coding instructions 保留 | 直接完成解释和代码工作，不额外要求教学格式或暂停等待用户 |
| `Explanatory` | 追加教育性说明，并要求用 `Insight` 框展示 2–3 个代码库相关洞见 | 在回答前后解释实现选择，通常比默认模式更愿意说明“为什么这样做” |
| `Learning` | 追加 hands-on practice 规则，生成较长代码时要求用户贡献 2–10 行关键代码 | 把设计决策留给用户，先加 `TODO(human)`，再发出分段练习请求 |

`default` 的“prompt”看起来像空白，其实是一个重要差异：内置配置把它映射成 `null`，所以不会出现下面这个标题，也不会因为选择 default 额外改变模型行为。

`Explanatory` 实际拼接的开头是：

```text
# Output Style: Explanatory
You are an interactive CLI tool that helps users with software engineering tasks. In addition to software engineering tasks, you should provide educational insights about the codebase along the way.

You should be clear and educational, providing helpful explanations while remaining focused on the task. Balance educational content with task completion.

# Explanatory Style Active
## Insights
... before and after writing code, always provide brief educational explanations ...
```

`Learning` 则会得到另一组约束：

```text
# Output Style: Learning
You are an interactive CLI tool that helps users with software engineering tasks. In addition to software engineering tasks, you should help users learn more about the codebase through hands-on practice and educational insights.

# Learning Style Active
## Requesting Human Contributions
In order to encourage learning, ask the human to contribute 2-10 line code pieces when generating 20+ lines involving:
- Design decisions (error handling, data structures)
- Business logic with multiple valid approaches
- Key algorithms or interface definitions
```

所以 Output Style 不是 renderer 的颜色主题，也不是把用户问题改写一遍。它在模型调用前改变“应该怎样回答”的约束；真正的输出仍要经过 Query Loop、工具执行以及 TUI/SDK 的宿主序列化。若把同一问题分别放进三种 style，最明显的差异通常不是事实答案，而是解释密度、是否插入洞见，以及是否把一段实现交还给用户完成。

## UI Notification：短暂状态不应污染对话

“插件已安装”这类状态若写进 transcript，resume 和下一轮模型都会把它当成对话事实。TUI 内部通知因此只进入 AppState 的 `notifications.current` 与 `notifications.queue`，适合承载升级、IDE 状态、MCP 连接和 rate limit 等短暂反馈。

队列提供优先级、去重、折叠和失效关系：

```ts
type Priority = 'low' | 'medium' | 'high' | 'immediate'
const DEFAULT_TIMEOUT_MS = 8000

const PRIORITIES: Record<Priority, number> = {
  immediate: 0,
  high: 1,
  medium: 2,
  low: 3,
}

export function getNext(queue: Notification[]): Notification | undefined {
  if (queue.length === 0) return undefined
  return queue.reduce((min, n) =>
    PRIORITIES[n.priority] < PRIORITIES[min.priority] ? n : min,
  )
}
```

**函数说明：** `getNext()` 位于 `restored-src/src/context/notifications.tsx`，由 `useNotifications()` 的 `processQueue()` 调用。普通通知等待当前项结束后按优先级选择；同优先级保留 reduce 首次遇到的项。`immediate` 会走单独分支，立即替换当前通知，并只把原来非 immediate、且未被失效的通知放回队列。

**参数说明：** `queue` 是 `Notification[]`，通知内容只能是 `text` 或 `jsx` 两种联合类型；`priority` 必须是 `'immediate'`、`'high'`、`'medium'`、`'low'` 之一，数值映射依次为 0、1、2、3，数值越小越先出队。`timeoutMs` 可为数字或 `undefined`，缺失时回退 8000 毫秒；负数和超大值也会沿数字路径进入定时器。`invalidates` 可为 key 数组或 `undefined`，用于清掉已经过时的通知。`fold` 可为合并函数或 `undefined`；存在时相同 key 可以更新当前项或队列项，否则相同 key 被去重。空队列返回 `undefined`。

这层通知的关键价值，是**状态反馈不进入 transcript**。如果“插件已安装”被当作普通 assistant message，resume、compact、SDK 消费者和模型下一轮都会把一条纯 UI 状态当成对话事实。AppState notification 用完即过期，正好表达了它的短暂性。

## OS Notification 与 Hook 负责唤回用户

当 Claude 完成工作、等待输入、请求审批或完成 MCP elicitation 时，运行时还可以走操作系统/终端通知。入口先执行用户配置的 Notification hooks，再选择本地 channel：

```ts
export async function sendNotification(
  notif: NotificationOptions,
  terminal: TerminalNotification,
): Promise<void> {
  const channel = getGlobalConfig().preferredNotifChannel
  await executeNotificationHooks(notif)
  await sendToChannel(channel, notif, terminal)
}

async function sendToChannel(
  channel: string,
  opts: NotificationOptions,
  terminal: TerminalNotification,
): Promise<string> {
  const title = opts.title || DEFAULT_TITLE

  try {
    switch (channel) {
      case 'auto':
        return sendAuto(opts, terminal)
      case 'iterm2':
        terminal.notifyITerm2(opts)
        return 'iterm2'
      case 'iterm2_with_bell':
        terminal.notifyITerm2(opts)
        terminal.notifyBell()
        return 'iterm2_with_bell'
      case 'kitty':
        terminal.notifyKitty({ ...opts, title, id: generateKittyId() })
        return 'kitty'
      case 'ghostty':
        terminal.notifyGhostty({ ...opts, title })
        return 'ghostty'
      case 'terminal_bell':
        terminal.notifyBell()
        return 'terminal_bell'
      case 'notifications_disabled':
        return 'disabled'
      default:
        return 'none'
    }
  } catch {
    return 'error'
  }
}
```

**函数说明：** `sendNotification()` 与 `sendToChannel()` 位于 `restored-src/src/services/notifier.ts`。Hook 和本地 channel 是两段连续动作：即使 channel 是 `notifications_disabled`，`executeNotificationHooks()` 仍已执行。终端实现位于 `ink/useTerminalNotification.ts`，通过 OSC 序列适配 iTerm2、Kitty、Ghostty，或写原始 BEL。

**参数说明：** `notif` 是 Hook 与 channel 共享的原始 `NotificationOptions`；`sendToChannel()` 内的 `opts` 是同一对象的参数名，各 channel 从中读取消息和可选标题，并在 Kitty/Ghostty 分支补入回退标题。`notif.message` 与 `notificationType` 是必填开放字符串，`title` 可为字符串或 `undefined`，缺失时本地 channel 使用 `'Claude Code'`。`preferredNotifChannel` 的源码可选值是 `'auto'`、`'iterm2'`、`'iterm2_with_bell'`、`'terminal_bell'`、`'kitty'`、`'ghostty'`、`'notifications_disabled'`，新配置默认 `'auto'`。未知字符串落到 `'none'`，channel 内异常被捕获为 `'error'`。`auto` 依据检测到的终端选择能力。

REPL 的“Claude is waiting for your input”还会检查完成时间、最近交互、弹窗和工具 UI，避免用户刚看完答案就立刻收到提醒。这里传出去的是一句注意力摘要和 `notificationType`，完整回答仍留在 TUI 或 SDK 输出里。Notification hook 可以接企业通知系统；阅读回执需要由目标系统另行提供。

## Mailbox 有两层：进程内队列与团队 inbox

最小的 `Mailbox` 是一个进程内队列。它支持按谓词等待，消息到来时优先交给第一个匹配 waiter，否则进入 queue：

```ts
export type MessageSource = 'user' | 'teammate' | 'system' | 'tick' | 'task'

send(msg: Message): void {
  this._revision++
  const idx = this.waiters.findIndex(w => w.fn(msg))
  if (idx !== -1) {
    const waiter = this.waiters.splice(idx, 1)[0]
    if (waiter) {
      waiter.resolve(msg)
      this.notify()
      return
    }
  }
  this.queue.push(msg)
  this.notify()
}

poll(fn: (msg: Message) => boolean = () => true): Message | undefined {
  const idx = this.queue.findIndex(fn)
  if (idx === -1) return undefined
  return this.queue.splice(idx, 1)[0]
}
```

**函数说明：** 这段来自 `restored-src/src/utils/mailbox.ts` 的 `Mailbox.send()` 与 `poll()`。`send()` 先递增 `_revision`，再用 `idx` 找到 `waiters` 中第一个谓词匹配项；找到的 `waiter` 会从数组移除并立即 resolve，否则消息进入 `queue`。`poll()` 则在 `queue` 中查找并移除第一条匹配消息。`MailboxProvider` 为 React 树创建实例，`useMailboxBridge()` 在 REPL 不忙时 poll 一条并交给 `onSubmitMessage()`；递增的 `_revision` 配合 `useSyncExternalStore` 触发消费检查。

**参数说明：** `Message.source` 只能是 `'user' | 'teammate' | 'system' | 'tick' | 'task'`；`from` 与 `color` 可为字符串或 `undefined`。`send()` 返回 `void`；一个消息最多唤醒一个匹配 waiter。`poll()` 的谓词可省略，默认接受任意消息；零匹配时返回 `undefined`。`receive()` 采用相同默认谓词，等待时长由消息到达决定，Promise 会持续 pending。还原源码中能看到 provider、consumer 和数据结构；静态调用图里未找到该实例 `send()` 的生产者，所以已证明的使用范围只到 REPL consumer。

Agent Teams 的 mailbox 则是另一套系统：每个 Agent 有一个 JSON inbox，路径位于 `~/.claude/teams/<team>/inboxes/<agent>.json`。写入时加文件锁，读不到文件时返回空数组。它用磁盘换来了跨进程 teammate 的可见性，但也引入了轮询、去重和已读标记。

## 地址先决定受众，再决定传输

`SendMessage` 先解释收件地址，再选择 bridge、UDS、进程内 Agent、广播或文件 inbox：

```ts
const inputSchema = lazySchema(() =>
  z.object({
    to: z.string(),
    summary: z.string().optional(),
    message: z.union([z.string(), StructuredMessage()]),
  }),
)

// After bridge, UDS and in-process agent routing branches:
async call(input, context, canUseTool, assistantMessage) {
  if (typeof input.message === 'string') {
    if (input.to === '*') {
      return handleBroadcast(input.message, input.summary, context)
    }
    return handleMessage(input.to, input.message, input.summary, context)
  }

  if (input.to === '*') {
    throw new Error('structured messages cannot be broadcast')
  }

  switch (input.message.type) {
    case 'shutdown_request':
      return handleShutdownRequest(input.to, input.message.reason, context)
    case 'shutdown_response':
      if (input.message.approve) {
        return handleShutdownApproval(input.message.request_id, context)
      }
      return handleShutdownRejection(
        input.message.request_id,
        input.message.reason!,
      )
    case 'plan_approval_response':
      if (input.message.approve) {
        return handlePlanApproval(
          input.to,
          input.message.request_id,
          context,
        )
      }
      return handlePlanRejection(
        input.to,
        input.message.request_id,
        input.message.feedback ?? 'Plan needs revision',
        context,
      )
  }
}
```

**函数说明：** 这段来自 `restored-src/src/tools/SendMessageTool/SendMessageTool.ts`。路由顺序很重要：启用 `UDS_INBOX` 时，`bridge:<session-id>` 与 `uds:<socket-path>` 先走点对点传输；运行中的 `LocalAgentTask` 走进程内 pending message；停止或已被 AppState 淘汰但有 transcript 的 Agent 会尝试后台 resume；普通 teammate 名字最后写文件 inbox，`'*'` 则遍历团队成员广播。

**参数说明：** `input.to` 是必填字符串；基础模式允许 teammate 名字或 `'*'`，`UDS_INBOX` 构建还允许 `uds:` 与 `bridge:` 地址。`input.message` 可以是普通字符串，也可以是 `shutdown_request`、`shutdown_response`、`plan_approval_response` 三类结构化消息；结构化消息禁止广播和跨 session。`summary` 可为字符串或 `undefined`：发给 teammate/团队的普通字符串要求非空 summary，schema 描述建议 5–10 词；bridge 与 UDS 字符串路径在校验中提前返回，不要求 summary。`approve` 使用 semantic boolean，接受布尔值以及字符串 `'true'` / `'false'`，其他值仍交给内部 boolean schema 拒绝。拒绝 shutdown 时 `reason` 必须非空；拒绝 plan 时缺少 `feedback` 回退 `'Plan needs revision'`。bridge 发送前会重新检查连接；进程内 Agent 已停止时恢复可能失败，`success: true` 表示该路由动作已触发，是否对方成功执行需看后续状态。

普通文件写入通过锁内重读保证并发更新：

```ts
export async function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName?: string,
): Promise<void> {
  await ensureInboxDir(teamName)
  const inboxPath = getInboxPath(recipientName, teamName)
  const lockFilePath = `${inboxPath}.lock`

  try {
    await writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') return
  }

  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(inboxPath, { lockfilePath, ...LOCK_OPTIONS })
    const messages = await readMailbox(recipientName, teamName)
    messages.push({ ...message, read: false })
    await writeFile(inboxPath, jsonStringify(messages, null, 2), 'utf-8')
  } finally {
    if (release) await release()
  }
}
```

**函数说明：** `writeToMailbox()` 位于 `restored-src/src/utils/teammateMailbox.ts`。它先确保目录和空 inbox 存在，再用 `proper-lockfile` 的异步锁串行化并发写者；拿锁以后重新读取，避免基于旧快照覆盖别人的消息，最后把新消息标为 `read: false`。

**参数说明：** `recipientName` 是经过 `sanitizePathComponent()` 处理的 Agent 名字；`message` 必须提供 `from`、`text`、ISO timestamp，`color` 与 `summary` 可为 `undefined`，缺失时省略对应展示元数据，投递目标保持不变；`read` 由函数固定写成 `false`。`teamName` 可省略，依次回退当前 team 环境和 `'default'`。锁重试配置为 10 次，退避 5–100 毫秒；`release` 在拿锁前为 `undefined`，因此成功获得锁后 `finally` 才调用释放函数。

## 目标 Agent 忙时，消息先排队；空闲时，才成为下一轮

文件 inbox 的 consumer 是 `useInboxPoller()`。它先把权限、sandbox、shutdown、计划审批等结构化协议消息分类到专门 handler，普通 teammate 内容才进入模型通道。这样一条 shutdown response 不会被当成自然语言建议交给模型自由解释。

普通消息的忙闲分支如下：

```ts
if (!isLoading && !focusedInputDialog) {
  const submitted = onSubmitTeammateMessage(formatted)
  if (!submitted) {
    queueMessages()
  }
} else {
  queueMessages()
}

markRead()

// Later, when idle, after formatting pendingMessages as above:
const submitted = onSubmitTeammateMessage(formatted)
if (submitted) {
  const submittedIds = new Set(pendingMessages.map(m => m.id))
  setAppState(prev => ({
    ...prev,
    inbox: {
      messages: prev.inbox.messages.filter(m => !submittedIds.has(m.id)),
    },
  }))
}
```

**函数说明：** 这段来自 `restored-src/src/hooks/useInboxPoller.ts`。目标会话空闲且 `focusedInputDialog` 为空时，普通消息立即包装为 `<teammate-message>` 并提交新 turn；忙时进入 `AppState.inbox.messages`，状态为 `'pending'`，等空闲 effect 再试。消息成功提交或可靠排入 AppState 后才把文件消息标为 read，降低崩溃窗口里的永久丢失风险。

**参数说明：** `enabled`、`isLoading` 是布尔值；`focusedInputDialog` 可以是当前 dialog 标识或 `undefined`。`onSubmitMessage(content)` 接收开放字符串并返回布尔值，`false` 表示本次提交未被接收，消息随后留在待处理路径。AppState inbox 状态在此处可见 `'pending'` 与 `'processed'`；文件消息另有独立 `read: boolean`，两组状态各自服务内存重试和磁盘消费。轮询间隔由 `INBOX_POLL_INTERVAL_MS` 常量控制；跨进程调度延迟还取决于进程负载与文件系统。

如果消息在一个长工具回合中到达，attachment 链还会读取 unread mailbox 与 AppState pending 项，做 `from + timestamp + text prefix` 去重，再构造 `teammate_mailbox` attachment。结构化协议消息明确被过滤，留给 InboxPoller 的专门 handler。Attachment 构建成功后才标已读/processed，这使 teammate 反馈既能在空闲时开启新 turn，也能在合适的工具边界进入正在延续的上下文。

## TUI 与 SDK：相同内容，宿主协议不同

一旦目标 Agent 处理了 mailbox 内容，最终 assistant/result 消息仍进入普通 Query Loop。交互式模式由 Messages、Tool UI、PromptInput notification 等 React/Ink 组件消费；headless/SDK 模式则由 `runHeadless()` 根据 `outputFormat` 写给宿主：

```ts
switch (options.outputFormat) {
  case 'json':
    if (!lastMessage || lastMessage.type !== 'result') {
      throw new Error('No messages returned')
    }
    if (options.verbose) {
      writeToStdout(jsonStringify(messages) + '\n')
      break
    }
    writeToStdout(jsonStringify(lastMessage) + '\n')
    break
  case 'stream-json':
    // messages were already written as NDJSON while streaming
    break
  default:
    if (!lastMessage || lastMessage.type !== 'result') {
      throw new Error('No messages returned')
    }
    if (lastMessage.subtype === 'success') {
      writeToStdout(
        lastMessage.result.endsWith('\n')
          ? lastMessage.result
          : lastMessage.result + '\n',
      )
    }
}
```

**函数说明：** 这段来自 `restored-src/src/cli/print.ts` 的 `runHeadless()` 尾部。它说明 output host 的职责是序列化已有 SDK messages：默认写最终文本，`json` 写最终 result 或 verbose 全量数组，`stream-json` 在迭代期间逐条写 NDJSON。SDK/control 消息、task notification 与 stream event 还有各自过滤和写出规则。

**参数说明：** `options.outputFormat` 在这里识别 `'json'`、`'stream-json'` 或其他/`undefined`，后者进入默认文本分支；CLI 上游还负责拒绝不支持的值。`verbose` 可为 `true`、`false` 或 `undefined`：只有 `json + true` 写出累积的 `messages`，否则 JSON 模式只写 `lastMessage`；`stream-json` 在 print 模式要求 verbose，并已在迭代过程中逐条写出，因此尾部不再重复输出。`lastMessage` 可为 `undefined`，JSON 和默认文本分支缺少 `result` 都会抛错；result 的 `subtype` 包含 `success` 及 max turns、budget、execution、structured output retries 等错误分支。

SDK 宿主还可能接收 `control_request`、权限响应、task notification 和 session state。它们是机器可消费事件；TUI notification 则是 React 状态。两边共享底层 Agent 与消息模型，各自由协议 serializer 和 React 组件呈现。

## 一次完整闭环，按时间顺序看

现在把最后一章涉及的部件按执行顺序重新拼起来：

1. 会话启动时，配置层解析 output style。普通主循环把 style prompt 加入 system prompt；特殊极简或 proactive 路径可能不加入。
2. 用户、Cron、远程 peer 或 teammate 触发一轮工作。跨 Agent 消息先根据地址选择进程内队列、bridge、UDS 或团队文件 inbox。
3. 目标 Agent 空闲时直接开始下一轮；忙时先进入 pending，或在后续工具边界作为 mailbox attachment 注入。协议消息走专门状态机，不交给模型猜。
4. Query Loop 调用模型、执行工具、回填 tool result，直到停止、失败、取消或等待输入。Output style 影响这一步里“如何表达”，不改变权限与工具副作用。
5. 最终消息交给当前宿主：REPL 渲染对话与工具状态，print/SDK 写 text、JSON 或事件流；如果内容是发给另一个 Agent，则 `SendMessage` 再进入对应 mailbox 路由。
6. 完成、等待、审批等需要人注意的事件，另行加入 TUI notification 或调用 OS/terminal notification；Notification hooks 可把摘要转交外部系统。
7. 人看到提醒后返回并输入，或 teammate 消费 inbox 后回复。新输入再次进入 Query Loop，闭环成立。

这条闭环提供的是分层确认语义：文件锁减少并发覆盖，read/pending/processed 降低丢失概率，dedup 降低重复注入，地址校验降低错投，优先级减少提示轰炸。进程崩溃、Hook 失败、终端静音、网络断开、模型误解和工具副作用仍分别属于不同失败域，源码未建立跨越全部层级的 exactly-once 协议。

## 如果你也想让 Agent 的结果抵达桌面

如果你在实际使用 Claude Code、Codex 或 OpenClaw，最容易错过的往往不是模型最终输出，而是“任务已经开始”“后台任务完成”或“需要回来审批”这类时刻。为了解决这个问题，我维护了一个小项目 [AgentNotify](https://github.com/TaurusGGBOY/agent-notification)：它在本地运行一个桌面通知接收器，让 Agent 把 start/stop 事件发到局域网服务，再由 macOS 或 Windows 的原生通知中心提醒你。

它和本章的分层正好对应：桌面端用 Tauri 打包，通知服务是 Go sidecar；局域网通过 mDNS/DNS-SD 自动发现；Agent 侧通过 `agent-notify-discovery` skill 配置 hook，不必手写一长串平台相关命令。Claude Code、Codex 和 OpenClaw 都可以接入，同一台电脑也可以同时接收多个 Agent 的任务状态。

最快的试用方式是从 GitHub 安装 skill：

```bash
npx skills add TaurusGGBOY/agent-notification
```

启动桌面端后，在 Claude Code 中运行 `/agent-notify-discovery`，让它发现通知服务并配置任务开始/结束事件。它不替代 mailbox 的可靠投递，也不把完整回答塞进弹窗；它只负责把“值得你回头看一眼”的信号送到桌面。项目地址仍是 [github.com/TaurusGGBOY/agent-notification](https://github.com/TaurusGGBOY/agent-notification)，欢迎试用、提 issue 或贡献适配。

## 小结

Claude Code 的最后一段运行闭环，本质上是一次“受众分离”。

Output Style 面向即将推理的模型，规定回答的表达方式；Mailbox 面向另一个 Agent 或会话，保存内容、协议和消费时机；Notification 面向暂时离开终端的人，用短摘要争取注意力；TUI 与 SDK/print 则面向宿主，决定完整结果怎样显示或序列化。

这套设计让每层保留自己的确认语义：system prompt 是否装配、消息是否入箱、Agent 是否消费、结果是否写出、提醒是否发起，分别可观察、可失败、可恢复。也正因为这些边界被拆开，Claude Code 才能从一次用户输入出发，经过模型、工具、权限、任务、团队、远程宿主和产品体验层，最后把结果送到正确的对象，再等待下一次输入。

到这里，整个源码解读系列也形成了自己的闭环：从一次请求怎样进入 Agent 开始，最终回到结果怎样离开 Agent、抵达人或另一个 Agent。

## 留给下一篇的问题

mailbox 和 A2A 协议的异同点是什么？

## 参考资料

- [Claude Code Output Styles](https://code.claude.com/docs/en/output-styles)

- [Claude Code Hooks：Notification](https://code.claude.com/docs/en/hooks)

- [Claude Code Agent Teams：Mailbox](https://code.claude.com/docs/en/agent-teams)

- [Stop putting everything in CLAUDE.md：Airbender 与 MagicDocs 的设计取舍](https://translunar.io/blog/2026/04/06/airbender/)

- [Anthropic quietly removed MagicDocs from Claude Code](https://translunar.io/blog/2026/04/05/magicdocs-removed/)

- [Claude Code 提示词全景目录：Magic Docs 提示词规则整理](https://xdlkc.github.io/2026/04/01/claude-code-prompts-catalog/index.html)

- [translunar/airbender：公开复刻 MagicDocs 的插件与决策树](https://github.com/translunar/airbender)
