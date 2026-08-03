---
title: "Claude Code源码解读15：本地与网络检索如何协作"
published: 2026-07-24T16:47:02+08:00
updated: 2026-07-24T16:47:02+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-15/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：你知道 rewind 的时候哪些东西是无法回滚的吗？

把 rewind 当成“给 Claude Code 加了一个 Ctrl+Z”很容易误导。真正的问题是：当模型已经改文件、跑命令、推送 Git，又想回到某个消息时，哪一层状态有快照，哪一层根本没有进入文件历史？

本文只分析 `@anthropic-ai/claude-code@2.1.88` 的还原源码，不把后续版本的 `/rewind` UI 选项倒灌进来。对这一版，结论可以沿调用链落地：`fileHistoryRewind → applySnapshot → restoreBackup/unlink` 只恢复已有备份的磁盘文件，不撤销外部副作用，也不提供跨文件事务。

## 先把“不能回滚”拆成六类

| 边界 | 为什么不能回滚 | `2.1.88` 源码落点 |
|---|---|---|
| **Bash 或人工改动** | 文件历史只在 Write、Edit、NotebookEdit 真正落盘前调用 `fileHistoryTrackEdit`；通过 Bash 的 `sed`、`mv`、`cp` 或用户编辑器改文件，不会自动留下同一套备份。 | `fileHistoryTrackEdit` 的调用方是文件编辑工具，而不是任意进程监控器。 |
| **网络、数据库、部署和 Git 外部副作用** | `git push`、数据库写入、API 请求、发布部署已经改变了外部系统，复制一份本地文件备份无法反向撤销它们。 | `fileHistoryRewind` 最终只调用 `copyFile`、`chmod` 或 `unlink`。 |
| **没有进入当前 trackedFiles 的文件** | 没有在目标消息检查点建立备份，就没有可供 `applySnapshot` 解析的 `backupFileName`；其他会话或检查点之外的文件不属于这次恢复范围。 | `FileHistorySnapshot.trackedFileBackups` 与 `applySnapshot(state, targetSnapshot)`。 |
| **对话和模型已经产生的上下文** | 这条 `fileHistoryRewind` 调用链没有截断 transcript，也没有撤销已经完成的模型推理。较新的交互式产品可能另外提供“恢复对话”选项，但那是另一条控制路径，不能和本版文件恢复混为一谈。 | `REPL.tsx` / `print.ts` 调用的是文件历史恢复函数。 |
| **不存在、被淘汰或未启用的 checkpoint** | checkpointing 被关闭、备份创建失败、snapshot 被淘汰，或者 `messageId` 找不到匹配 snapshot 时，系统没有完整的目标版本可恢复。 | `fileHistoryEnabled`、最多保留 100 个 snapshot、`The selected snapshot was not found`。 |
| **跨文件的完整一致性** | `applySnapshot` 按文件循环并逐个捕获异常；某个文件恢复失败时，前面已经恢复的文件不会自动回滚。 | `applySnapshot` 的单文件 `try/catch` 与 `tengu_file_history_rewind_restore_file_failed` 事件。 |

这个表也解释了为什么“代码回来了”不等于“任务回到了过去”。最多只能说：在目标消息对应的文件检查点里，仍有备份、且恢复操作成功执行的那些文件回来了。命令产生的构建目录、Git 指针、远程服务状态、另一会话的修改，以及模型已经看过的上下文，都要分别处理。

还有一个容易被忽略的风险：`checkOriginFileChanged` 只是在恢复前判断当前文件是否与备份不同，并不会替你做三方合并。随后 `restoreBackup` 直接复制备份内容；如果用户在 checkpoint 之后手工改过同一个文件，这些修改可能被目标版本覆盖。所谓 rewind 是“回到旧文件快照”，不是“把旧版本和新版本智能合并”。

因此，实践中可以按问题类型选择动作：只是文件改错了，优先用 code-only 的思路恢复文件；如果是模型已经陷入错误推理，单纯恢复文件不够，还要考虑恢复对话或重新开会话；如果是命令已经推送到远端、写入数据库或完成部署，就应该使用对应系统的补偿操作或 Git/发布系统的回滚，而不是继续寻找一个本地 checkpoint。

本文继续限定在 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码。下面的代码均来自 `restored-src/`，只省略与本段结论无关的字段与分支。

## 本章先建立三个概念

- **检索流水线**：候选发现、内容读取、相关性裁剪和证据回填是四个独立步骤。

- **有界结果**：分页、截断与范围参数限制一次检索占用的上下文和执行时间。

- **证据局部性**：模型应拿到与问题最接近的路径、行号和片段，以便继续验证。

![本地与网络检索的有界流水线](/images/posts/claude-code-source-reading-15/15-retrieval-pipeline-detail-handdrawn.png)

这张图把检索拆成“发现路径、定位内容、读取证据、回填上下文”四步；分页和截断不是装饰，而是控制单次调用的成本和信息范围。

## YNM-9527 先查本地，再查外部

核心任务把检索顺序写得很清楚：

> 先读取 CLAUDE.md、事故单和相关代码；通过 issue-tracker MCP 读取事故记录，必要时搜索 Stripe 官方文档。

Claude Code 先用 Glob、Grep、Read 缩小本地范围，再按需调用 MCP、WebSearch 或 WebFetch。路径、匹配片段、事故单字段和网页正文都会回到同一条调查上下文，但每种检索的权限、分页、截断和失败边界不同。

下面沿“本地定位—MCP 取证—网络核对”的路线，说明这些工具如何协作，而不是把所有搜索都叫作 RAG。

## 先建立一张检索地图

当任务只问一个函数时，从根目录读取所有文件既慢又会污染上下文。Claude Code 把检索拆成三个问题：先找候选路径，再定位内容，最后读取能支撑判断的局部证据；网络检索再把“发现来源”和“读取页面”分开。

| 层级 | 工具 | 要回答的问题 | 主要裁剪方式 |
|---|---|---|---|
| 路径发现 | `Glob` | 目标文件可能在哪里 | glob pattern、搜索目录、100 条默认上限 |
| 内容定位 | `Grep` | 哪些文件、哪些行包含目标 | regex、文件类型、输出模式、250 条默认上限、offset |
| 定点读取 | `Read` | 目标文件的具体内容是什么 | 行 offset/limit、字节与 token 上限、文件类型分支 |
| 网络发现 | `WebSearch` | 哪些公开页面可能相关 | query、域名 allow/block、单次最多 8 次服务端搜索 |
| 网络提取 | `WebFetch` | 指定页面里与任务相关的内容是什么 | URL 校验、内容大小、HTML 转 Markdown、二次模型提取 |

![Claude Code 本地与网络分层检索流程手绘图](/images/posts/claude-code-source-reading-15/15-search-retrieval-handdrawn.png)

图里的回箭头表示检索不会一次完成。模型先用 `Glob` 确定范围，再用更窄的 `Grep` 找行，最后 `Read` 相邻片段；网页路径同样先用 `WebSearch` 找候选，再交给 `WebFetch` 读取指定页面。每一步的截断结果都必须被模型解释后，才能决定下一步检索。

## Glob 先找路径，不读取文件内容

`restored-src/src/tools/GlobTool/GlobTool.ts` 的输入很小：必填 `pattern`，可选 `path`。调用方省略 `path` 时，`GlobTool.getPath()` 把搜索根回退到 `getCwd()`。

```ts
async call(input, { abortController, getAppState, globLimits }) {
  const start = Date.now()
  const appState = getAppState()
  const limit = globLimits?.maxResults ?? 100
  const { files, truncated } = await glob(
    input.pattern,
    GlobTool.getPath(input),
    { limit, offset: 0 },
    abortController.signal,
    appState.toolPermissionContext,
  )
  const filenames = files.map(toRelativePath)
  const output: Output = {
    filenames,
    durationMs: Date.now() - start,
    numFiles: filenames.length,
    truncated,
  }
  return {
    data: output,
  }
}
```

**函数说明：** `GlobTool.call()` 调用 `utils/glob.ts` 中的 `glob()` 枚举匹配路径，再把 cwd 内的绝对路径转成相对路径，以减少消息里的 token。返回值同时保留 `truncated`，因此模型能判断路径列表是否完整。

**参数说明：** `input.pattern` 是必填 glob 字符串，例如 `**/*.ts`，候选值开放；`input.path` 是 `string | undefined`，省略时回退 cwd。`abortController.signal` 允许上游取消搜索。`globLimits?.maxResults` 是 `number | undefined`，缺省值为 `100`；`offset` 固定为 `0`，所以 `Glob` 的公开输入只覆盖首个窗口。`toolPermissionContext` 提供文件读取规则与忽略模式。

**字段说明：** `start` 记录计时起点，`appState` 提供当前应用状态，`limit` 保存本次结果上限；底层返回的 `files` 是候选路径，`truncated` 标记上限之后是否仍有候选。输出把路径转换为 `filenames`，用 `durationMs` 记录耗时、`numFiles` 记录返回数量，并将整个 `output` 放入 `data`。

真正的文件枚举由 `restored-src/src/utils/glob.ts` 完成。绝对 glob 会先通过 `extractGlobBaseDirectory()` 拆成静态根目录和相对 pattern，再交给 ripgrep 的 `--files`。源码传入 `--sort=modified`，注释明确写的是按修改时间从旧到新排列。随后才执行 `slice(offset, offset + limit)`。

Glob 对 ignore 的处理有一个容易忽略的默认值：

- `CLAUDE_CODE_GLOB_NO_IGNORE` 默认按 `true` 处理，因此默认添加 `--no-ignore`，不会遵守 `.gitignore`；显式设为假值才让 ripgrep 恢复 ignore 文件行为。
- `CLAUDE_CODE_GLOB_HIDDEN` 默认按 `true` 处理，因此默认包含隐藏文件；显式设为假值才不加 `--hidden`。
- 权限上下文里的文件读取 ignore pattern 仍会转换成排除 glob；孤立的插件缓存版本目录也会被排除。

Glob 的可见集合同时取决于 pattern、搜索根、两个环境变量、权限 ignore 与插件缓存排除。空数组只证明这个组合产出 0 条路径。

在调用前，`GlobTool.validateInput()` 还会检查显式 `path` 是否存在且为目录。Windows UNC 路径会跳过这次预先 `stat`，以规避验证阶段触发 NTLM 凭据泄漏；后续仍进入共享权限流程。目录缺失返回 `errorCode: 1`，路径存在但类型为非目录时返回 `errorCode: 2`。

## Grep 在内容里定位，并把排序与分页说清楚

`Glob` 只看路径。需要寻找函数名、错误文本或调用痕迹时，`GrepTool` 才进入文件内容。它在 `restored-src/src/tools/GrepTool/GrepTool.ts` 中组装参数，再调用 `restored-src/src/utils/ripgrep.ts` 的 `ripGrep()` 执行正则搜索。

```ts
function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number = 0,
): { items: T[]; appliedLimit: number | undefined } {
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined }
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT
  const sliced = items.slice(offset, offset + effectiveLimit)
  const wasTruncated = items.length - offset > effectiveLimit
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  }
}
```

**函数说明：** `applyHeadLimit()` 是 `GrepTool.call()` 三种输出模式共用的分页函数。它先跳过 offset，再截取当前窗口；只有窗口之后确实还有结果时，才回传 `appliedLimit` 提醒模型继续翻页。常量 `DEFAULT_HEAD_LIMIT` 在同一文件中固定为 `250`。

**参数说明：** `items` 是 ripgrep 返回的行或文件条目数组；`limit` 是 `number | undefined`，`undefined` 使用 250，显式 `0` 表示跳过条数上限；`offset` 是数字，默认 `0`。输入 schema 用 `semanticNumber` 接收 `head_limit` 和 `offset`，两者按开放数值处理。

`GrepTool.call()` 还负责把其他结构化输入翻译成 ripgrep 参数。`pattern` 是必填 ripgrep 正则；`path` 为文件、目录或 `undefined`，省略时使用 cwd；`glob` 与 `type` 都是可选字符串过滤器。`output_mode` 只能是 `content`、`files_with_matches`、`count`，默认 `files_with_matches`。`-n` 默认 `true`，但只影响 `content`；`-i` 默认 `false`；`multiline` 默认 `false`，设为 `true` 时加入 `-U --multiline-dotall`。工具始终添加 `--hidden` 和 `--max-columns 500`。

三种 `output_mode` 分别服务于三个检索阶段：

- `files_with_matches` 返回匹配文件名。正常运行时先按 mtime 从新到旧排序，相同时间再按文件名排序；测试环境直接按文件名排序。
- `content` 返回实际命中行，可以使用 `-A`、`-B`、`-C` 或 `context`。`context` 优先于 `-C`；两者均省略时才分别使用 `-B` 与 `-A`。
- `count` 返回 `文件:数量`，并计算当前返回窗口里的总命中数与文件数。

`GrepTool` 默认执行 `applyHeadLimit(results, undefined, 0)`，有效上限为 250。只有真的还有更多条目时，输出里才出现 `appliedLimit`；只传了非零 `offset` 时则会出现 `appliedOffset`。模型可以增加 `offset` 继续读下一页。显式 `head_limit: 0` 会取消这一层限制，工具的 20,000 字符持久化阈值、ripgrep 20 MB stdout buffer 和上下文容量仍会约束总成本。

Grep 保留 ripgrep 自己的 ignore 规则，参数中省略 `--no-ignore`。同时，它会显式排除 `.git`、`.svn`、`.hg`、`.bzr`、`.jj`、`.sl`，再叠加权限上下文中的读取 ignore pattern 和插件缓存排除。因此，可见范围始终受 ignore 与权限配置约束。

`ripGrep()` 对退出状态做了专门区分：退出码 `1` 才是正常的无匹配；`ENOENT`、`EACCES`、`EPERM` 会抛出；EAGAIN 会以单线程 `-j 1` 重试一次。默认超时在 WSL 为 60 秒，其他平台为 20 秒，可由 `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS` 的正整数秒覆盖。超时且结果为空时抛出 `RipgrepTimeoutError`，明确提醒模型缩小路径或 pattern，从状态上区分搜索未完成与零命中。如果异常发生前已有完整行，部分错误路径会返回这些行，因此读者仍要把它理解成一次有执行边界的观察。

## Read 读取确定范围，并阻止一个文件吞掉上下文

搜索最终需要落到内容。`FileReadTool` 同时处理文本、`image`、`notebook`、`pdf`、PDF 页图片 `parts`，以及重复读取命中的 `file_unchanged`。本篇聚焦最常见的文本路径。

```ts
const defaults = getDefaultFileReadingLimits()
const maxSizeBytes =
  fileReadingLimits?.maxSizeBytes ?? defaults.maxSizeBytes
const maxTokens =
  fileReadingLimits?.maxTokens ?? defaults.maxTokens
```

**函数说明：** 这段源码位于 `FileReadTool.call()`。函数优先采用 `ToolUseContext` 的宿主覆盖值，缺省时读取 `getDefaultFileReadingLimits()`；随后还会规范化路径、检查相同范围去重，并进入 `callInner()` 按文件类型读取。

**参数说明：** `file_path` 是必填绝对路径字符串；`offset` 是非负整数，默认 `1`，文本读取时表示从第 1 行开始，显式 `0` 也会映射到底层第 0 行索引；`limit` 是正整数，省略时跳过显式行数切片，但字节与 token 上限仍然生效；`pages` 是 PDF 专用的可选页码字符串，支持 `"3"`、`"1-5"` 这类单页和闭区间，一次最多 20 页。宿主省略 `fileReadingLimits` 时，函数采用默认字节与 token 限制。

`restored-src/src/tools/FileReadTool/limits.ts` 给出的硬编码回退是：总文件大小 256 KB，输出最多 25,000 token。`maxTokens` 的优先级是环境变量 `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`、GrowthBook 配置、25,000；无效值都会回退。

文本路径的 `callInner()` 调用 `readFileInRange()`。提供 `limit` 时按行切片；省略时，总文件大小上限会先挡住过大的文件。返回内容还会做 token 估算，接近阈值时调用 token count API 精确计算，超过上限抛出 `MaxFileReadTokenExceededError`。这也是为什么大文件应该先 Grep，再用 `offset + limit` 读取局部。

读取成功后，工具会把内容、mtime、offset 和 limit 写入 `readFileState`。下一次读取完全相同范围且 mtime 未变时，可以返回 `file_unchanged` stub，避免把同一段内容再次塞进上下文。功能开关 `tengu_read_dedup_killswitch` 默认为 `false`，也就是去重默认启用。

`Read` 同样先经过 `checkReadPermissionForTool()`。显式 deny 路径在输入校验阶段就会返回错误，危险设备文件也会被拒绝。路径在 cwd 之外时，权限上下文和内部可读路径共同给出 allow、ask 或 deny；只读属性只影响副作用分类，不扩大可读目录。

## 本地搜索的边界由 cwd、ignore 和权限共同决定

把三种本地工具放在一起看，可以得到一个更准确的范围公式：

`可见结果 = 搜索根 ∩ pattern/type/glob ∩ ignore 后剩余路径 ∩ 权限可读范围 ∩ 本页与大小限制`

cwd 只是省略 `path` 时的默认根。显式绝对路径可以指向 cwd 外部，此时会进入 `checkReadPermissionForTool()`：deny 规则优先拒绝，ask 规则要求确认，allow 规则或受认可的内部只读路径才能继续。上一章讨论的权限与沙箱边界，在检索工具这里仍然有效。

ignore 由多层规则组成：Glob 与 Grep 使用不同的 ripgrep 参数，权限系统还会生成自己的 ignore pattern。因此，排查漏搜时要同时记录工具、cwd、path、环境变量和权限配置。

排序更不能混为一谈。Glob 的底层列表按修改时间从旧到新；Grep 的 `files_with_matches` 在工具层重排为从新到旧；`content` 和 `count` 则保留 ripgrep 返回顺序再分页。Claude Code 选择这些顺序，是为了让路径发现稳定、让最近修改的命中文件优先进入有限窗口。

## WebSearch 找候选来源，不直接抓页面

`WebSearchTool` 与本地 Grep 的实现差异很大。它构造 Anthropic API 的 `web_search_20250305` server tool，再发起一条独立的模型流。

```ts
function makeToolSchema(input: Input): BetaWebSearchTool20250305 {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    allowed_domains: input.allowed_domains,
    blocked_domains: input.blocked_domains,
    max_uses: 8,
  }
}
```

**函数说明：** `makeToolSchema()` 把 Claude Code 的输入转换为服务端 web search schema。`WebSearchTool.call()` 把该 schema 放进 `extraToolSchemas`，再启动一条专用模型流，收集 `server_tool_use`、`web_search_tool_result` 与文本块，最后交给 `makeOutputFromSearchResponse()` 整理。

**参数说明：** `query` 是长度至少为 2 的必填字符串；`allowed_domains` 与 `blocked_domains` 均为 `string[] | undefined`，分别表示只包含指定域名和排除指定域名，域名字符串属于开放输入，静态源码不枚举清单。两个数组都为非空时校验失败；空数组或 `undefined` 不增加对应过滤。`max_uses` 固定为 `8`，指这次服务端工具调用中允许的搜索次数上限。`tools: []` 表示这条二次模型流不加载普通客户端工具，`extraToolSchemas` 只注入当前 web search schema。

**字段说明：** 服务端 schema 的 `type` 固定为 `'web_search_20250305'`，`name` 固定为 `'web_search'`；`allowed_domains` 与 `blocked_domains` 原样取 `input` 对应字段。

具体使用哪个模型受 `tengu_plum_vx3` 控制。该开关在此处的默认回退是 `false`：假值使用主循环模型和当前 thinking 配置；真值使用 small fast model、禁用 thinking，并强制 `toolChoice` 为 `web_search`。

搜索流到达时，工具会持续发出 `query_update` 和 `search_results_received` 进度事件。最终输出只保留搜索文本以及每条命中的 `title`、`url`；错误块会转成 `Web search error: <error_code>`。映射成 `tool_result` 时，末尾还会提醒主模型在最终回答中用 Markdown 链接列出来源。

`allowed_domains` 只负责结果过滤。搜索结果的标题、摘要和链接来自外部服务与页面，可能过时、错误或包含 prompt injection。`WebSearchTool` 只提供候选来源；主模型需要通过 `WebFetch`、来源比较和清楚引用完成事实校验，不能把搜索摘要当成最终证据。

工具是否出现还取决于 provider 与模型。2.1.88 的 `isEnabled()` 对 first-party 和 Foundry 返回 `true`，Vertex 仅对源码列出的 Claude 4 系列名称返回 `true`，其他 provider 返回 `false`。这只是客户端启用条件，不代表当前账号、地区、网络和服务端一定可用。

## WebFetch 把指定 URL 变成与问题相关的内容

拿到链接后，`WebFetchTool` 才负责抓页面。它的输入只有 `url` 和 `prompt`：前者告诉工具去哪里，后者告诉二次模型从页面里提取什么。`prompt` 必填，工具始终按提取要求处理页面。

```ts
const isPreapproved = isPreapprovedUrl(url)

let result: string
if (
  isPreapproved &&
  contentType.includes('text/markdown') &&
  content.length < MAX_MARKDOWN_LENGTH
) {
  result = content
} else {
  result = await applyPromptToMarkdown(
    prompt,
    content,
    abortController.signal,
    isNonInteractiveSession,
    isPreapproved,
  )
}
```

**函数说明：** `WebFetchTool.call()` 先让 `getURLMarkdownContent()` 完成 URL 校验、域名预检、HTTP 请求、重定向控制、内容转换与缓存；只有预批准域名返回的小型 Markdown 才直接返回原文，其余内容交给 `applyPromptToMarkdown()` 使用 small fast model 提取。

**参数说明：** `url` 是必填、可被 `URL` 解析的完整字符串；`prompt` 是必填开放字符串，用来描述要提取的信息。`abortController.signal` 同时控制网络请求与二次模型请求。`isNonInteractiveSession` 是布尔值，透传给二次模型调用；它不改变页面内容本身。`MAX_MARKDOWN_LENGTH` 固定为 100,000 字符，超过时只把前 100,000 字符和截断提示交给二次模型。

这里有四道网络边界。

第一道是 URL。`validateURL()` 拒绝超过 2,000 字符、带 username/password、无法解析或 hostname 少于两个点分段的地址；HTTP 会在请求前升级为 HTTPS。

第二道是域名权限。预批准 host 可以直接 allow；其他域名把权限规则写成 `domain:<hostname>`，依次检查 deny、ask、allow，规则未命中时默认 ask。每个重定向目标仍需独立授权。

第三道是域名预检。`skipWebFetchPreflight` 为 `false` 或 `undefined` 时，会向 Anthropic 的 domain info 接口查询是否允许抓取，超时为 10 秒；值为 `true` 时跳过这一步，源码注释把它定位为受限企业网络的选项。跳过预检只省略这次检查，不会关闭工具权限、HTTP 限制或代理出口策略。

第四道是实际请求。单次 fetch 超时 60 秒，响应上限 10 MB，同 host 或仅增删 `www` 的同协议、同端口重定向最多跟随 10 跳。跳到不同 host 时，工具返回 redirect 信息，让模型使用新 URL 再发起一次 WebFetch，从而重新经过目标域名权限。出口代理如果以 `403` 和 `X-Proxy-Error: blocked-by-allowlist` 拒绝，会抛出带域名的 `EGRESS_BLOCKED` 错误。

响应内容也不会原样无条件回流。HTML 通过 Turndown 转为 Markdown；二进制内容会尝试持久化到磁盘，并在结果中附上保存路径；URL 内容缓存使用 15 分钟 TTL 和 50 MB 总量，域名允许预检另有 5 分钟缓存。对于未预批准域名，二次模型 prompt 还限制单一来源逐字引用不超过 125 个字符。这里的 `prompt` 是“从已经抓到的内容里提取什么”，不能让工具绕过认证：源码的工具说明明确提示，私有或需要登录的 URL 会失败，应优先使用具备认证能力的 MCP 工具。

外部页面必须按不可信输入处理。域名 allow、HTTPS、blocklist 和重定向检查只决定连接资格；页面事实与 prompt injection 仍需独立判断。`applyPromptToMarkdown()` 会把页面 Markdown 与提取要求一起交给二次模型；静态源码只显示连接与提取流程，未提供通用 sanitizer 保证。因此，页面返回的命令、配置建议和事实仍要由主 Agent 结合用户任务、权限规则与其他证据判断。

## 失败必须作为独立状态回到 Agent

五种工具最终都要回到同一套工具执行生命周期。`restored-src/src/services/tools/toolExecution.ts` 的 `checkPermissionsAndCallTool()` 在调用成功后执行工具自己的 `mapToolResultToToolResultBlockParam()`；`restored-src/src/utils/toolResultStorage.ts` 的 `processToolResultBlock()` 还会对过大的普通文本结果执行持久化处理。得到的块形如：

```ts
return {
  tool_use_id: toolUseID,
  type: 'tool_result',
  content: result,
}
```

**函数说明：** 片段是 `WebFetchTool.mapToolResultToToolResultBlockParam()` 的完整返回结构。Glob、Grep、Read 与 WebSearch 也实现同名映射函数，把各自内部输出转换成 Anthropic 消息协议里的 `tool_result`。共享执行器随后把它追加为用户侧工具结果消息，query loop 才能基于这次观察继续推理。

**参数说明：** `toolUseID` 是当前 `tool_use` 的开放字符串标识，必须原样关联请求与结果；`result` 根据工具而变化，可能是文件列表、带行号文本、搜索链接、网页提取结果或结构化内容。失败路径不会都进入这个成功片段：权限拒绝、验证错误、取消、网络错误和执行异常会由共享执行器生成对应的错误结果或终止事件。

**字段说明：** `tool_use_id` 原样取 `toolUseID`，`type` 固定为 `'tool_result'`，`content` 原样取 `result`。

不同工具对“空”与“失败”做了有意区分：

- Glob 的空数组映射成 `No files found`，截断时追加更具体的 path/pattern 提示。
- Grep 的退出码 1 才映射成空匹配；无结果、分页信息和 count 摘要进入不同文案。
- Read 对空文件和 offset 超过文件长度给出不同 system reminder；文件不存在会尝试建议 cwd 下的相似路径。
- WebSearch 把服务端错误码保留在结果数组中；链接数组为空与调用失败使用不同状态。
- WebFetch 的无效 URL、域名拒绝、预检失败、超时、出口代理拦截和取消都会抛错；二次模型返回空内容时才回退为 `No response from model`。

主模型拿到 `tool_result` 后，可以缩小 pattern、翻到下一页、读取另一个范围、改用其他来源，或者向用户说明当前边界。这里才是分层搜索真正闭环的地方：工具负责产生可解释的观察，query loop 负责决定下一步。

## 小结

Claude Code 的检索能力可以概括成三条原则。

第一，先缩范围，再读内容。Glob 发现路径，Grep 定位命中，Read 读取确定片段；WebSearch 发现来源，WebFetch 提取指定页面。工具之间允许跳步，但职责边界清楚。

第二，限制本身也是结果。100 个路径、250 条 grep 结果、Read 的字节/token 上限、WebSearch 的 8 次搜索和 WebFetch 的 100,000 字符，都必须连同截断、offset 或错误状态一起解释。空结果从来只对本次搜索窗口成立。

第三，搜索范围由运行环境决定。cwd、ignore、权限、provider、域名规则、代理和网络状态都会改变可见结果。

从 query loop 的角度看，检索工具的共同价值只有一个：把一个过大的未知空间，压缩成下一轮模型可以继续判断的观察结果。

## 留给下一篇的问题

你知道 Claude Code 会用你默认的模型进行 WebSearch 吗？

## 参考资料

- [Claude Code Checkpoints and Rewind](https://www.clearly.sh/blog/claude-code-checkpoints-rewind)
- [Claude Code Checkpoints & Rewind](https://jordanjamesmedia.com/blog/post/claude-code-checkpoints-rewind/)
- [Claude Code session resume/continue guide](https://thepromptshelf.dev/blog/claude-code-session-resume-continue-guide-2026/)
- [Claude Code 工具参考](https://code.claude.com/docs/en/tools-reference)

- [Claude Code 上下文窗口](https://code.claude.com/docs/en/context-window)
