---
title: "Claude Code源码解读14：如何通过快照与历史实现回滚"
published: 2026-07-24T16:47:01+08:00
updated: 2026-08-04
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-14/claude-code-source-reading-00.png"
imagePosition: "left"
---
## 回答上一篇的问题

上一篇留下的问题是：从当前版本看来，为什么很多 PowerShell 脚本要到执行时才报错？

先给结论：PowerShell 的“能被解析”和“能在当前主机上成功执行”是两件事。2.1.88 里的安全链会先用 PowerShell 自己的 AST 做语法与危险结构分析，再做权限判断；这一步的目标是判断“是否应该允许尝试”，不是提前运行脚本验证所有命令、模块、路径、数据和外部程序。真正执行时，PowerShell 才会解析命令名、绑定参数、加载模块、读取环境和文件，并产生 stdout、stderr 与退出码，所以很多错误只能在这个阶段出现。

这不是安全校验失效，而是静态检查与运行时解释之间的边界。静态检查必须避免执行未知副作用；运行时又必须面对当前机器的 PowerShell 版本、PATH、模块、执行策略、工作目录、权限和数据状态。只要其中一项依赖当前环境，解析通过也不能推出执行成功。

本文只引用 `@anthropic-ai/claude-code@2.1.88` 的还原源码；路径用于定位函数，不代表 Anthropic 内部目录。代码片段省略埋点、UI 和无关分支，但保留写入、快照和恢复的控制顺序。

## 关键结论（Key Takeaways）

- **文件安全其实是两条时间线**：Read 保存“现在”的写入凭据（content + mtime + 范围），checkpoint 保存“过去”的旧版本；前者保护并发写入，后者只负责恢复已经留下备份的文件。
- **Edit 的 `old_string` 同时约束替换目标和并发状态**：磁盘中找不到、或匹配多次而 `replace_all` 为 `false` 时都会失败；`isPartialView` 的自动注入内容被硬性拒绝，局部 Read 却不拒绝写入。
- **“缩小”竞态窗口不等于事务**：临写前检查刻意不插 `await`，但外部进程仍可能在后检查后、rename 前改盘；源码用 mtime + 内容检查，没有文件锁或 compare-and-swap，因此只能降低并发覆盖概率，不能消除。
- **原子替换允许降级**：先写同目录临时文件再 rename（POSIX 原子）；主路径失败后清理临时文件、直接覆盖目标，退化为非原子写。
- **回滚是“按文件独立恢复”，不是跨文件事务**：单文件失败只记录错误并继续；`backupFileName: null` 表示目标版本应处于缺失状态；回滚链绕过 `checkWritePermissionForTool`，属于用户主动控制路径。

## 本篇新增机制

相对上一篇“sandbox-and-bash-security”（命令如何执行），本篇在心智模型中新增三块：

| 新增机制 | 解决的问题 | 关键符号 |
|---|---|---|
| 乐观并发校验 | 写入前比较读时状态，避免基于过期内容覆盖用户或其他进程的新修改 | `FileState`、`readFileState`、`errorCode 6/7/8/9` |
| Checkpoint | 每次编辑前保存可恢复状态，让会话能够按提示词边界回退代码 | `FileHistorySnapshot`、`FileHistoryBackup`、`messageId` |
| 原子替换 | 先写临时内容再替换目标文件，把崩溃窗口压缩到文件系统可控范围 | `writeFileSyncAndFlush_DEPRECATED()`、`fs.renameSync()` |

## 问题

先接住上一篇留下的问题：**从当前版本看来，为什么很多 PowerShell 脚本要到执行时才报错？**

先给结论：**PowerShell 的“能被解析”和“能在当前主机上成功执行”是两件事。** 2.1.88 里的安全链会先用 PowerShell 自己的 AST 做语法与危险结构分析，再做权限判断；这一步的目标是判断“是否应该允许尝试”，不是提前运行脚本验证所有命令、模块、路径、数据和外部程序。真正执行时，PowerShell 才会解析命令名、绑定参数、加载模块、读取环境和文件，并产生 stdout、stderr 与退出码，所以很多错误只能在这个阶段出现。

这不是安全校验失效，而是静态检查与运行时解释之间的边界。静态检查必须避免执行未知副作用；运行时又必须面对当前机器的 PowerShell 版本、PATH、模块、执行策略、工作目录、权限和数据状态。只要其中一项依赖当前环境，解析通过也不能推出执行成功。

**本篇继续追问：写入与回滚这边，Claude Code 用什么机制防止“覆盖用户新修改”和“写坏以后无法恢复”？** 本篇沿文件工具的写入前校验、原子替换与文件历史回滚三条链路展开。

## 正文

本文只引用 `@anthropic-ai/claude-code@2.1.88` 的还原源码；路径用于定位函数，不代表 Anthropic 内部目录。代码片段省略埋点、UI 和无关分支，但保留写入、快照和恢复的控制顺序；代码块以 `[source]` 标注证据层级，块内注释注明 `restored-src/` 路径（2.1.88 还原源码）。

### 先把“现在的并发保护”和“过去的文件恢复”放进同一张图

![文件写入校验与 checkpoint 两条时间线](/images/posts/claude-code-source-reading-14/14-file-safety-timelines-detail-handdrawn.png)

上半条时间线面向“现在”：Read 产生读取凭据，Edit、Write 和 NotebookEdit 在写入前检查它是否仍然有效。

下半条时间线面向“过去”：一条用户消息建立检查点，第一次修改某个文件时保存修改前版本，之后可以按消息 UUID 把文件恢复回去。

因此，Read 同时承担查看内容与建立写入凭据两项职责；文件历史则只追踪工具实际修改过的文件。两者的时间点不同：Read 保护下一次写入不要覆盖别人刚改的内容，checkpoint 保存的是修改发生前的旧版本。

沿用金额工单的分支场景：你在独立会话分支里比较“全链路使用整数分”和“保留 Decimal”两种方案：

> 在这个会话分支里比较两种金额单位修复方案；验证失败时只回滚这次分支产生的文件修改。

Claude Code 先通过 Read、Edit 或 Write 改动工作区，文件历史在第一次写入前保存快照；测试失败后，回滚请求按路径和交互上下文找到对应历史，只撤销本次改动，不会把已经发送的网络请求、远端工单或原会话 transcript 一起抹掉。

前一篇的权限边界决定“能不能写”，本章继续追问“写坏以后能恢复什么”。

### Read 把内容与修改时间保存为写入凭据

读取状态的定义在 `restored-src/src/utils/fileStateCache.ts`。核心字段很少：

```ts [source]
// restored-src/src/utils/fileStateCache.ts（2.1.88 还原源码）
export type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  isPartialView?: boolean
}
```

`FileState` 描述一次可用于后续校验的读取。`content` 是当时读到的文本，`timestamp` 是向下取整后的文件修改时间；`offset` 和 `limit` 传入数值时限定读取范围，省略时相应维度不切片；`isPartialView: true` 表示内容来自自动注入而非磁盘完整视图，Edit 和 Write 会拒绝这类凭据，省略该布尔值则按普通读取处理。

`createFileStateCacheWithSizeLimit` 同时限制条目数和内容总量：

```ts [source]
// restored-src/src/utils/fileStateCache.ts（2.1.88 还原源码）
export const READ_FILE_STATE_CACHE_SIZE = 100
const DEFAULT_MAX_CACHE_SIZE_BYTES = 25 * 1024 * 1024

export function createFileStateCacheWithSizeLimit(
  maxEntries: number,
  maxSizeBytes: number = DEFAULT_MAX_CACHE_SIZE_BYTES,
): FileStateCache {
  return new FileStateCache(maxEntries, maxSizeBytes)
}
```

`createFileStateCacheWithSizeLimit` 创建一个按路径归一化键名的 LRU 缓存。`maxEntries` 是最大条目数，调用方通常传入 `100`；`maxSizeBytes` 是缓存内容的字节上限，未传时默认为 25 MiB。LRU 淘汰会移除旧条目，因此每次写入都要重新确认目标路径的读取凭据仍在缓存中。

文本读取完成后，`restored-src/src/tools/FileReadTool/FileReadTool.ts` 的 `callInner` 才把内容和磁盘时间放进缓存：

```ts [source]
// restored-src/src/tools/FileReadTool/FileReadTool.ts（2.1.88 还原源码）
readFileState.set(fullFilePath, {
  content,
  timestamp: Math.floor(mtimeMs),
  offset,
  limit,
})
```

`callInner` 以 `fullFilePath` 作为缓存键；对象的 `content` 保存本次实际文本，`timestamp` 写入 `Math.floor(mtimeMs)`，把文件修改时间规范为整数毫秒；`offset` 和 `limit` 原样记录 Read 范围。`offset` 是非负整数，省略时从文件开头读取；`limit` 是正整数，省略时不主动切行，但仍受文件大小与 token 上限约束。

这里有一个容易忽略的细节：通过 `offset` 或 `limit` 得到的局部 Read 也会进入缓存，而且 Edit、Write 并不会仅因为读取范围不完整就拒绝写入。真正被硬性拒绝的是 `isPartialView: true` 的自动注入内容。范围字段主要影响 mtime 变化后的内容兜底：只有 `offset` 和 `limit` 都是 `undefined` 的完整读取，才能通过“磁盘内容仍相等”消除时间戳误报。

Read 自己还会利用这份状态去重。如果相同范围的修改时间保持一致，它返回 `file_unchanged`，避免再次把整段内容塞进上下文。这个优化只减少重复传输，写入校验仍按同一凭据规则执行。

### Edit 用字符串匹配同时约束目标和并发状态

Edit 的输入契约位于 `restored-src/src/tools/FileEditTool/types.ts`：

```ts [source]
// restored-src/src/tools/FileEditTool/types.ts（2.1.88 还原源码）
const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('The absolute path to the file to modify'),
    old_string: z.string().describe('The text to replace'),
    new_string: z
      .string()
      .describe(
        'The text to replace it with (must be different from old_string)',
      ),
    replace_all: semanticBoolean(
      z.boolean().default(false).optional(),
    ).describe('Replace all occurrences of old_string (default false)'),
  }),
)
```

这段 Schema 由 `inputSchema` 构造。`file_path`、`old_string` 和 `new_string` 都是必填字符串；路径经过展开后用于权限和缓存匹配。`replace_all` 只能表达布尔语义，`true` 替换所有匹配，`false` 只允许唯一匹配；省略时默认 `false`。

`old_string` 同时描述替换目标和局部乐观并发条件：磁盘中找不到它时工具返回失败；出现多个匹配且 `replace_all` 为 `false` 时，工具同样停止并要求更精确的上下文。

真正执行修改前，`restored-src/src/tools/FileEditTool/FileEditTool.ts` 的 `FileEditTool.validateInput` 先检查读取状态和文件变化：

```ts [source]
// restored-src/src/tools/FileEditTool/FileEditTool.ts（2.1.88 还原源码）
const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
if (!readTimestamp || readTimestamp.isPartialView) {
  return {
    result: false,
    behavior: 'ask',
    message:
      'File has not been read yet. Read it first before writing to it.',
    meta: {
      isFilePathAbsolute: String(isAbsolute(file_path)),
    },
    errorCode: 6,
  }
}

// Check if file exists and get its last modified time
if (readTimestamp) {
  const lastWriteTime = getFileModificationTime(fullFilePath)
  if (lastWriteTime > readTimestamp.timestamp) {
    // Timestamp indicates modification, but on Windows timestamps can change
    // without content changes (cloud sync, antivirus, etc.). For full reads,
    // compare content as a fallback to avoid false positives.
    const isFullRead =
      readTimestamp.offset === undefined &&
      readTimestamp.limit === undefined
    if (isFullRead && fileContent === readTimestamp.content) {
      // Content unchanged, safe to proceed
    } else {
      return {
        result: false,
        behavior: 'ask',
        message:
          'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
        errorCode: 7,
      }
    }
  }
}
```

`validateInput` 接收 `FileEditInput` 和 `ToolUseContext`。`readTimestamp` 从共享 `readFileState` 取目标凭据；缺失或 `isPartialView` 为真时返回 `result: false`、`behavior: 'ask'` 与先 Read 的 `message`，`meta.isFilePathAbsolute` 记录原输入是否为绝对路径，完整分支的 `errorCode` 为 `6`。磁盘修改时间更晚时，完整读取可用内容相等消除只改变 mtime 的误报；局部读取因缺少完整内容而直接返回修改冲突，`errorCode` 为 `7`。

接着才检查字符串匹配：

```ts [source]
// restored-src/src/tools/FileEditTool/FileEditTool.ts（2.1.88 还原源码）
const actualOldString = findActualString(file, old_string)
if (!actualOldString) {
  return {
    result: false,
    behavior: 'ask',
    message: `String to replace not found in file.\nString: ${old_string}`,
    meta: {
      isFilePathAbsolute: String(isAbsolute(file_path)),
    },
    errorCode: 8,
  }
}

const matches = file.split(actualOldString).length - 1

// Check if we have multiple matches but replace_all is false
if (matches > 1 && !replace_all) {
  return {
    result: false,
    behavior: 'ask',
    message: `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
    meta: {
      isFilePathAbsolute: String(isAbsolute(file_path)),
      actualOldString,
    },
    errorCode: 9,
  }
}
```

`findActualString(file, old_string)` 在完整文件中解析实际匹配文本，也处理引号样式差异。查找失败时返回 `result: false`、`behavior: 'ask'`、包含目标字符串的 `message`，`meta.isFilePathAbsolute` 记录输入路径形态，`errorCode: 8`。`matches` 是实际出现次数；多次匹配且 `replace_all: false` 时返回同样的 `result/behavior`，`meta` 额外带 `actualOldString`，`errorCode: 9`，要求补充上下文或显式改为全量替换。

到这里仍然不能直接写。校验和工具调用之间可能经过权限询问，用户或格式化器完全可能在这个窗口修改文件。因此 `FileEditTool.call` 在最后写入前又同步读取一次：

```ts [source]
// restored-src/src/tools/FileEditTool/FileEditTool.ts（2.1.88 还原源码）
if (fileExists) {
  const lastWriteTime = getFileModificationTime(absoluteFilePath)
  const lastRead = readFileState.get(absoluteFilePath)
  if (!lastRead || lastWriteTime > lastRead.timestamp) {
    // Timestamp indicates modification, but on Windows timestamps can change
    // without content changes (cloud sync, antivirus, etc.). For full reads,
    // compare content as a fallback to avoid false positives.
    const isFullRead =
      lastRead &&
      lastRead.offset === undefined &&
      lastRead.limit === undefined
    const contentUnchanged =
      isFullRead && originalFileContents === lastRead.content
    if (!contentUnchanged) {
      throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    }
  }
}
```

`FileEditTool.call` 中的 `absoluteFilePath` 是最终路径，`lastRead` 是最后一次读取凭据，`originalFileContents` 是临写前重新读到的内容。源码特意要求从这次检查到 `writeTextContent` 之间不要插入异步操作，缩小竞态窗口。`encoding` 和 `endings` 来自原文件，因此 Edit 会保留编码与换行风格。

注意“缩小”这个词。JavaScript 进程内省去 `await`，可以避免同一事件循环中的其他异步任务插进来；外部进程仍可能在检查之后、rename 之前修改磁盘。源码采用 mtime 与内容检查而未使用文件锁或 compare-and-swap，因此这里只能降低并发覆盖概率。

### Write 的保护相同，破坏半径更大

Write 的参数只有必填字符串 `file_path` 和 `content`；文件缺失时创建，存在时用完整 `content` 覆盖。

它仍然先走 `checkWritePermissionForTool`，已有文件也必须存在可用的 Read 状态。`restored-src/src/tools/FileWriteTool/FileWriteTool.ts` 中 `FileWriteTool.validateInput` 的关键分支如下：

```ts [source]
// restored-src/src/tools/FileWriteTool/FileWriteTool.ts（2.1.88 还原源码）
const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
if (!readTimestamp || readTimestamp.isPartialView) {
  return {
    result: false,
    message:
      'File has not been read yet. Read it first before writing to it.',
    errorCode: 2,
  }
}

// Reuse mtime from the stat above — avoids a redundant statSync via
// getFileModificationTime. The readTimestamp guard above ensures this
// block is always reached when the file exists.
const lastWriteTime = Math.floor(fileMtimeMs)
if (lastWriteTime > readTimestamp.timestamp) {
  return {
    result: false,
    message:
      'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
    errorCode: 3,
  }
}
```

`FileWriteTool.validateInput` 的 `fullFilePath` 来自 `file_path`，`fileMtimeMs` 来自当前 `stat`。新文件直接进入创建路径；已有文件必须有非部分 `readTimestamp`。凭据缺失时返回 `result: false`、先 Read 的 `message` 和 `errorCode: 2`；`lastWriteTime > readTimestamp.timestamp` 时返回相同失败形状，`message` 改为外部修改提示，`errorCode: 3`。校验阶段按时间戳拒绝，实际 `call` 还会再次读取，并在完整内容相等时容忍时间戳变化。

Write 的输出 Schema 用 `create | update` 区分新建和覆盖，并把 `originalFile` 声明成 `string | null`。`FileWriteTool.call` 实际按 `if (oldContent)` 分支：非空旧内容返回 `update` 并保留原文；文件缺失或旧内容为空串时返回 `create` 与 `originalFile: null`。因此这个 `null` 同时覆盖新文件和空文件两种运行路径。

### 单文件写入优先原子化，但允许降级

Edit、Write 和 NotebookEdit 最终都调用 `writeTextContent`，再进入 `restored-src/src/utils/file.ts` 的 `writeFileSyncAndFlush_DEPRECATED`。

```ts [source]
// restored-src/src/utils/file.ts（2.1.88 还原源码）
fsWriteFileSync(tempPath, content, writeOptions)
logForDebugging(
  `Temp file written successfully, size: ${content.length} bytes`,
)

// For existing files or if mode was not set atomically, apply permissions
if (targetExists && targetMode !== undefined) {
  chmodSync(tempPath, targetMode)
  logForDebugging(`Applied original permissions to temp file`)
}

// Atomic rename (on POSIX systems, this is atomic)
// On Windows, this will overwrite the destination if it exists
logForDebugging(`Renaming ${tempPath} to ${targetPath}`)
fs.renameSync(tempPath, targetPath)
logForDebugging(`File ${targetPath} written atomically`)
```

`writeFileSyncAndFlush_DEPRECATED(filePath, content, options)` 的 `filePath` 是逻辑目标，遇到符号链接时会改写其目标文件；`content` 是完整待写文本；`options.encoding` 指定编码，整个 `options` 省略时默认 `{ encoding: 'utf-8' }`；`options.mode` 是数字或 `undefined`，只用于新文件权限。主路径先写同目录临时文件并 flush，再 rename；源码只明确注释 POSIX rename 的原子性。

主路径失败后，函数清理临时文件，再直接覆盖目标：

```ts [source]
// restored-src/src/utils/file.ts（2.1.88 还原源码）
// Clean up temp file on error
try {
  logForDebugging(`Cleaning up temp file: ${tempPath}`)
  fs.unlinkSync(tempPath)
} catch (cleanupError) {
  logForDebugging(`Failed to clean up temp file: ${cleanupError}`)
}

// Fallback to non-atomic write
logForDebugging(`Falling back to non-atomic write for ${targetPath}`)
try {
  const fallbackOptions: {
    encoding: BufferEncoding
    flush: boolean
    mode?: number
  } = {
    encoding: options.encoding,
    flush: true,
  }
  // Only set mode for new files
  if (!targetExists && options.mode !== undefined) {
    fallbackOptions.mode = options.mode
  }

  fsWriteFileSync(targetPath, content, fallbackOptions)
  logForDebugging(
    `File ${targetPath} written successfully with non-atomic fallback`,
  )
} catch (fallbackError) {
  logForDebugging(`Non-atomic write also failed: ${fallbackError}`)
  throw fallbackError
}
```

这是同一个 `writeFileSyncAndFlush_DEPRECATED` 的降级分支。`tempPath` 清理失败只记录日志；`fallbackOptions.encoding` 沿用调用配置，`flush: true` 要求直接写后刷新，`mode` 只在目标原先不存在且调用方提供权限位时加入。`targetPath` 的直接写入失去 rename 主路径的原子替换语义；直接写也失败时才向上传播异常。

### NotebookEdit 按 cell 语义修改 JSON

`.ipynb` 在磁盘上确实是 JSON，但 NotebookEdit 操作的是 cell 语义。`restored-src/src/tools/NotebookEditTool/NotebookEditTool.ts` 的输入 Schema 明确列出三种模式：

```ts [source]
// restored-src/src/tools/NotebookEditTool/NotebookEditTool.ts（2.1.88 还原源码）
export const inputSchema = lazySchema(() =>
  z.strictObject({
    notebook_path: z
      .string()
      .describe(
        'The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)',
      ),
    cell_id: z
      .string()
      .optional()
      .describe(
        'The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.',
      ),
    new_source: z.string().describe('The new source for the cell'),
    cell_type: z
      .enum(['code', 'markdown'])
      .optional()
      .describe(
        'The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.',
      ),
    edit_mode: z
      .enum(['replace', 'insert', 'delete'])
      .optional()
      .describe(
        'The type of edit to make (replace, insert, delete). Defaults to replace.',
      ),
  }),
)
```

`NotebookEditTool.inputSchema` 中，`notebook_path` 是必填绝对路径，`new_source` 是必填新内容；`edit_mode` 可取 `replace`、`insert`、`delete`，省略时默认 `replace`。`cell_type` 可取 `code` 或 `markdown`，插入时必填，替换时省略则沿用当前类型。`cell_id` 可以是真实 ID 或 `cell-N` 索引；插入时省略表示放到开头，replace/delete 时省略会失败。

NotebookEdit 同样要求先 Read，并在 `validateInput` 中检查 mtime。Edit、Write 会在异步历史备份后再次执行临写前 mtime 校验；NotebookEdit 的 `call` 省略了这次复检，因此留下更宽的外部修改竞态窗口。真正修改时，它会解析并更新 notebook 数据结构：

```ts [source]
// restored-src/src/tools/NotebookEditTool/NotebookEditTool.ts（2.1.88 还原源码）
if (edit_mode === 'delete') {
  notebook.cells.splice(cellIndex, 1)
} else if (edit_mode === 'insert') {
  notebook.cells.splice(cellIndex, 0, new_cell)
} else {
  const targetCell = notebook.cells[cellIndex]!
  targetCell.source = new_source
  if (targetCell.cell_type === 'code') {
    targetCell.execution_count = null
    targetCell.outputs = []
  }
}
```

这是 `NotebookEditTool.call` 的 cell 修改分支。`edit_mode: 'delete'` 删除 `cellIndex` 处一项，`insert` 插入 `new_cell`，其他值走替换；`cellIndex` 由 `cell_id` 解析，`new_cell` 根据 `cell_type` 创建，`new_source` 写入目标 `source`。替换代码单元格时，`execution_count: null` 把单元格状态重置为尚未执行，`outputs: []` 清除与旧源码对应的输出。

对于 nbformat 4.5 及以上，新插入 cell 会生成 ID；替换越过末尾一个位置时，调用阶段还会把 `replace` 转成 `insert`，`cell_type` 省略时回退为 `code`。这些行为说明 NotebookEdit 维护 notebook 数据结构，并按 cell 语义生成补丁。

### 快照生命周期：检查点先行，备份在第一次修改前补入

现在把下半条时间线完整展开。文件历史的状态定义在 `restored-src/src/utils/fileHistory.ts`：

```ts [source]
// restored-src/src/utils/fileHistory.ts（2.1.88 还原源码）
export type FileHistorySnapshot = {
  messageId: UUID
  trackedFileBackups: Record<string, FileHistoryBackup>
  timestamp: Date
}

export type FileHistoryBackup = {
  backupFileName: string | null
  version: number
  backupTime: Date
}
```

`FileHistorySnapshot.messageId` 把检查点绑定到一条用户消息；`trackedFileBackups` 是文件路径到备份版本的映射。`backupFileName` 为字符串时指向会话备份文件，为 `null` 时表示目标版本应处于文件缺失状态，回滚会据此删除目标。`version` 从 1 递增，`backupTime` 和 snapshot 的 `timestamp` 记录文件历史时间点，与数据库事务提交无关。

一次完整生命周期是这样的：

```mermaid
flowchart LR
    M1[用户消息 A<br/>建立检查点 snapshot A] --> T1[第一次修改 file.ts<br/>fileHistoryTrackEdit]
    T1 --> V1[备份 v1<br/>~/.claude/file-history/&lt;sessionId&gt;]
    V1 --> T2[同消息内再次修改<br/>复用 v1 · 不覆盖]
    T2 --> M2[用户消息 B<br/>检查所有已追踪文件<br/>内容变则 v2 · 不变则复用]
    M2 --> R[用户选择 rewind 到 A]
    R --> R1[applySnapshot<br/>逐文件恢复或删除]
```

生命周期由两类调用驱动：**检查点建立**发生在处理可选择的用户消息时，调用 `fileHistoryMakeSnapshot(updateFileHistoryState, messageId)`；**备份补入**则由 Edit、Write、NotebookEdit 在落盘前调用：

```ts [source]
// restored-src/src/utils/fileHistory.ts（2.1.88 还原源码）
await fileHistoryTrackEdit(
  updateFileHistoryState,
  absoluteFilePath,
  parentMessage.uuid,
)
```

`fileHistoryTrackEdit` 的 `updateFileHistoryState` 是会话状态更新器，`absoluteFilePath` 是即将修改的文件，`parentMessage.uuid` 是触发本次工具调用的消息 ID。函数必须在修改前执行；同一检查点已记录过该文件时直接复用，避免重复调用把修改后的内容覆盖到 v1 备份。

备份名由路径 SHA-256 的前 16 位和版本号组成，存放在 `~/.claude/file-history/<sessionId>/`。文件原本缺失时，`createBackup` 返回 `backupFileName: null`；回滚据此删除本轮新建的文件。

新的消息检查点还会检查所有已追踪文件。文件与最近备份内容相同时复用版本；内容变化时创建下一版本；文件已删除时记录新的 `null`。内存中最多保留 100 个 snapshot，超过后只保留最后 100 个。

### 文件历史按交互模式选择默认值

`fileHistoryEnabled` 把交互式会话和非交互式会话分开：

```ts [source]
// restored-src/src/utils/fileHistory.ts（2.1.88 还原源码）
export function fileHistoryEnabled(): boolean {
  if (getIsNonInteractiveSession()) {
    return fileHistoryEnabledSdk()
  }
  return (
    getGlobalConfig().fileCheckpointingEnabled !== false &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)
  )
}
```

`fileHistoryEnabled()` 是零参数模式判断。非交互式会话委托给 `fileHistoryEnabledSdk()`：只有显式开启 `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` 且 disable 变量为假才启用。交互式会话中，`fileCheckpointingEnabled !== false` 且 `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` 为假时启用。`isEnvTruthy` 将忽略大小写和首尾空格的 `1`、`true`、`yes`、`on` 解释为真，其他值为假。

开关关闭、状态更新器为空实现、备份 I/O 失败，都会让历史不可用；追踪失败被记录后，文件工具仍可能继续执行。

### 回滚按文件独立恢复

`fileHistoryRewind` 先按 `messageId` 找最后一个匹配的 snapshot，找不到会抛出 “The selected snapshot was not found”。找到后交给 `applySnapshot`：

```ts [source]
// restored-src/src/utils/fileHistory.ts（2.1.88 还原源码）
if (backupFileName === null) {
  // File did not exist at the target version; delete it if present.
  try {
    await unlink(filePath)
    logForDebugging(`FileHistory: [Rewind] Deleted ${filePath}`)
    filesChanged.push(filePath)
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e
    // Already absent; nothing to do.
  }
  continue
}

// File should exist at a specific version. Restore only if it differs.
if (await checkOriginFileChanged(filePath, backupFileName)) {
  await restoreBackup(filePath, backupFileName)
  logForDebugging(
    `FileHistory: [Rewind] Restored ${filePath} from ${backupFileName}`,
  )
  filesChanged.push(filePath)
}
} catch (error) {
  logError(error)
  logEvent('tengu_file_history_rewind_restore_file_failed', {
    dryRun: false,
  })
}
```

`applySnapshot(state, targetSnapshot)` 遍历 `state.trackedFiles`，用目标检查点解析每个 `filePath` 和 `backupFileName`。`backupFileName: null` 进入删除分支：`unlink` 成功后把路径加入 `filesChanged`，`ENOENT` 表示已达到目标状态，其他错误抛给外层 catch；字符串值先经 `checkOriginFileChanged` 比较，再由 `restoreBackup` 恢复并记录变化。单文件异常会 `logError` 并发送 `tengu_file_history_rewind_restore_file_failed`，事件字段 `dryRun: false` 表示这次失败发生在真实恢复阶段。

`restoreBackup(filePath, backupFileName)` 使用 `copyFile` 恢复内容，再用 `chmod` 恢复备份权限。该路径直接复制备份，省略普通编辑工具的临时文件 rename；批量恢复中某个文件失败时，已经恢复的文件保持现状。

### 回滚边界：能恢复什么、不能恢复什么

由此可以画出一张回滚边界表。它回答“rewind 到底覆盖哪一层状态”：

| 维度 | 覆盖范围 | 2.1.88 源码落点 | 边界内的典型场景 |
|---|---|---|---|
| 文件覆盖 | 进入过 `fileHistoryTrackEdit` 的磁盘文件，且有可用备份 | `applySnapshot` → `restoreBackup`（`copyFile` + `chmod`） | 编辑、覆盖、删除过的目标文件回到检查点版本 |
| 文件创建 | 检查点之后新建、而目标版本不存在的文件 | `backupFileName: null` → `unlink`（`ENOENT` 视为已达成） | 本轮新建但方案废弃的文件被删除 |
| 未追踪的改动 | Bash 的 `sed` / `mv` / `cp`、用户编辑器改的文件 | `fileHistoryTrackEdit` 只在编辑工具落盘前被调用 | 命令改动的文件没有同套备份，rewind 不感知 |
| 外部副作用 | 网络请求、数据库写入、Git 推送、部署 | `applySnapshot` 最终只调 `copyFile` / `chmod` / `unlink` | `git push` 已经改变远端，本地备份无法撤销 |
| 上下文与推理 | 模型已消费的 transcript、已完成推理 | `fileHistoryRewind` 调用链不截断 transcript | “代码回来了”不等于“任务回到过去” |
| 丢失的检查点 | checkpointing 关闭、备份失败、snapshot 被淘汰 | `fileHistoryEnabled()`、最多保留 100 个 snapshot、`The selected snapshot was not found` | 目标消息没有可解析的 `backupFileName` |
| 跨文件一致性 | 一次回滚整体成功 | `applySnapshot` 单文件 `try/catch` | 某个文件恢复失败时，已恢复的文件保持现状，出现部分回滚 |

表里还有一个容易被忽略的风险：`checkOriginFileChanged` 只是在恢复前判断当前文件是否与备份不同，并不会替你做三方合并；随后 `restoreBackup` 直接复制备份内容。如果用户在 checkpoint 之后手工改过同一个文件，这些修改可能被目标版本覆盖。回滚是“回到旧文件快照”，不是“把旧版本和新版本智能合并”。

### 权限保护的是修改入口，不自动覆盖回滚入口

Edit 和 Write 都通过 `checkWritePermissionForTool` 检查写权限，NotebookEdit 也走同一类检查。拒绝规则还会在输入校验阶段提前阻止访问对应路径。因此正常工具调用的写入，位于上一篇所讲的权限边界内。

但从本文追踪到的调用关系看，REPL 的 `MessageSelector` 和 print/SDK 的 `handleRewindFiles` 都直接调用 `fileHistoryRewind`；`fileHistoryRewind -> applySnapshot -> restoreBackup/unlink` 这条链绕过 `checkWritePermissionForTool`。因此在这份 2.1.88 还原源码中，回滚由用户或宿主以会话控制操作发起，恢复阶段不会逐文件重新进入工具权限询问。

这也是为什么回滚确认和 diff 预览很重要：权限引擎负责 Agent 发起的文件工具，用户主动选择 rewind 则进入另一条控制路径。

### 失败时究竟会留下什么

现在可以把几种失败放回同一个模型里：

| 失败位置 | 源码行为 | 能否继续写入或恢复 |
|---|---|---|
| 读取凭据缺失，或只有 `isPartialView` 自动注入 | Edit/Write 拒绝已有文件 | 显式 Read 后才能继续 |
| Read 后文件被修改 | 校验或临写前检查失败 | 重新读取，不自动合并 |
| `old_string` 不存在或不唯一 | Edit 拒绝 | 增加上下文或明确 `replace_all: true` |
| 备份创建失败 | 记录错误，工具调用仍可能继续 | 本次修改可能缺少可用回滚点 |
| 临时文件/rename 失败 | 清理临时文件并直接写目标 | 退化成非原子写 |
| 单个文件恢复失败 | 记录错误并处理下一个文件 | 可能出现部分回滚 |
| snapshot 不存在或已淘汰 | rewind 失败 | 无法靠该历史恢复 |

这里采用“冲突后停止并重新 Read”策略，而非自动三方合并；历史恢复遇到冲突时按目标备份覆盖，用户后来修改的语义不会参与合并。前者保护写入前的新鲜度，后者只保证恢复目标明确，二者都不提供跨文件事务。

## 源码映射

| 主题 | 关键文件（`restored-src/src/`） | 关键函数 / 符号 | 证据 |
|---|---|---|---|
| 读取凭据 | `utils/fileStateCache.ts` | `FileState`、`createFileStateCacheWithSizeLimit()`、`READ_FILE_STATE_CACHE_SIZE` | 源码已确认 |
| Read 写入凭据 | `tools/FileReadTool/FileReadTool.ts` | `callInner()`、`Math.floor(mtimeMs)`、`file_unchanged` | 源码已确认 |
| Edit 校验 | `tools/FileEditTool/FileEditTool.ts`、`types.ts` | `validateInput()`、`findActualString()`、`errorCode 6/7/8/9` | 源码已确认 |
| Edit 临写复检 | `tools/FileEditTool/FileEditTool.ts` | `FILE_UNEXPECTEDLY_MODIFIED_ERROR`、`contentUnchanged` | 源码已确认 |
| Write 校验 | `tools/FileWriteTool/FileWriteTool.ts` | `validateInput()`、`errorCode 2/3`、`create \| update` | 源码已确认 |
| 原子写入 | `utils/file.ts` | `writeFileSyncAndFlush_DEPRECATED()`、`fs.renameSync()`、降级分支 | 源码已确认 |
| Notebook 编辑 | `tools/NotebookEditTool/NotebookEditTool.ts` | `inputSchema`、cell splice 分支、`execution_count: null` | 源码已确认 |
| 快照与备份 | `utils/fileHistory.ts` | `FileHistorySnapshot`、`fileHistoryMakeSnapshot()`、`fileHistoryTrackEdit()` | 源码已确认 |
| 开关判断 | `utils/fileHistory.ts` | `fileHistoryEnabled()`、`fileHistoryEnabledSdk()`、`isEnvTruthy()` | 源码已确认 |
| 回滚执行 | `utils/fileHistory.ts` | `fileHistoryRewind()`、`applySnapshot()`、`restoreBackup()`、`checkOriginFileChanged()` | 源码已确认 |
| 回滚入口 | `screens/REPL.tsx`、`cli/print.ts` | `MessageSelector`、`handleRewindFiles()`、`fileHistoryGetDiffStats()` | 调用关系确认 |

## 设计决策

**第一，写入前凭据与检查点各管一个时间方向。** 凭据（content + mtime + 范围）防止“现在”的覆盖冲突，检查点保存“过去”的旧版本供回退。如果把两者合并成一套，并发保护和恢复语义都会互相污染；分开后各自保持简单。

**第二，冲突时停止并重新 Read，不做三方合并。** 自动合并会把用户的语义选择悄悄写进文件；停止并重读让模型在最新内容上重新决策。代价是多一轮往返，换来的是不会在未知修改上叠写。

**第三，原子性是尽力而为。** POSIX rename 原子、Windows 覆盖、失败后直接写目标——源码在主路径之外保留一条降级路径，并明确注释原子性只保证在 POSIX 上。把“崩溃窗口”从整个文件写压缩到 rename 一步，但不承诺事务。

**第四，回滚是用户主动控制，不重复走 Agent 权限。** `fileHistoryRewind` 绕过 `checkWritePermissionForTool`，因此确认与 diff 预览成为这条路径上的把关点；这也解释了为什么“回滚能覆盖的文件”严格小于“Git 或工作区镜像能覆盖的”。

## 练习：观察一次快照的生命周期

用 15–20 分钟做下面这件事，全部在测试目录进行：

1. 在测试目录建 `ledger.ts`，内容为 `export const unit = 'fen'`。启动交互式 Claude Code，先 Read 该文件，再要求它“改成 Decimal 方案”，观察工具顺序：Read → Edit →（自动）`fileHistoryTrackEdit`。
2. 在同一会话里连续两次修改 `ledger.ts`（先改成 `'yuan'`，再改回带备注的版本），然后检查 `~/.claude/file-history/<sessionId>/` 下新增的备份文件名，对照“路径 SHA-256 前 16 位 + 版本号”的命名规则，确认第二个检查点是否复用了第一个版本的备份。
3. 在消息选择器里选择最早那条消息并执行 rewind，观察提示的 diff 预览；随后让另一个工具（例如 Bash 的 `sed`）修改同一文件，再 rewind，观察该修改是否被还原。
4. 用 `claude -p`（非交互）重复第 1 步，确认 `fileHistoryEnabled()` 走 `fileHistoryEnabledSdk()` 分支时默认不启用，`~/.claude/file-history/` 下没有新增备份。

**预期输出：**

- 第 1 步：日志中出现 `FileHistory: [Snapshot]` 与 `FileHistory: [Tracked edit]` 类事件；`~/.claude/file-history/<sessionId>/` 出现形如 `<sha256-16>.json` 或按版本命名的备份文件。
- 第 2 步：同一条消息内第二次修改不产生新版本；新消息检查点后内容变化才生成 v2。
- 第 3 步：rewind 先展示预计恢复的文件与行数变化（dry-run diff），确认后文件回到旧内容；但 Bash `sed` 的修改在 rewind 后仍然存在——它没有进入 `fileHistoryTrackEdit`。
- 第 4 步：非交互会话默认不产生文件历史备份，除非显式设置 `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`。

## 自测

1. `isPartialView: true` 的读取凭据和局部 Read（带 `offset`/`limit`）在写入校验中有什么区别？
2. `writeFileSyncAndFlush_DEPRECATED` 的原子主路径失败后会怎样？原子性在什么条件下成立？
3. 为什么说 rewind 可能“部分成功”？`backupFileName: null` 表示什么？

<details>
<summary>参考答案</summary>

1. **局部 Read 可以用于写入校验，`isPartialView` 会被硬性拒绝**。`isPartialView: true` 表示内容来自自动注入而非磁盘完整视图，Edit/Write 直接拒绝；局部 Read 仍作为凭据，只是 mtime 变化时因缺少完整内容无法用“磁盘内容仍相等”消除误报，只能直接返回冲突（`errorCode 7`）。

2. **清理临时文件后直接覆盖目标**，退化为非原子写（`flush: true`，`mode` 只对不存在的目标设置）；原子性由 POSIX rename 保证，Windows 上 rename 是覆盖语义而非严格原子。直接写也失败时才向上传播异常。

3. **`applySnapshot` 按文件循环并逐个捕获异常**：某个文件恢复失败时，已恢复的文件保持现状，留下部分回滚；`backupFileName: null` 表示目标版本时该文件不存在，回滚会据此删除它（`ENOENT` 视为已达到目标状态）。

</details>

## 回顾：文件安全为什么需要两条时间线

<details>
<summary>展开查看回顾</summary>

Claude Code 的文件安全可以压缩成四步：Read 保存带范围和 mtime 的读取凭据；Edit、Write、NotebookEdit 在权限检查后验证凭据，Edit 与 Write 还会在临写前复检；文件历史在修改前保存旧版本并绑定到用户消息检查点；用户选择 rewind 时逐文件复制旧版本或删除当时不存在的新文件。回滚边界表提醒：只有进入过 `fileHistoryTrackEdit` 的文件有备份，Bash 改动、网络副作用、Git 推送、已消耗的上下文都不在恢复范围内。把它理解成带读取凭据和检查点的文件操作系统是准确的，叫跨文件事务就过头了。

</details>

## 留给下一篇的问题

你知道 rewind 的时候哪些东西是无法回滚的吗？

## 相关链接

- **上一篇**：[13 如何建立命令执行安全边界](./13-sandbox-and-bash-security.md)——PowerShell 延迟报错的来源
- **下一篇**：[15 本地与网络检索如何协作](./15-search-and-retrieval-tools.md)——回答本文的 rewind 边界问题
- [Claude Code Checkpointing](https://code.claude.com/docs/en/checkpointing)
- [Claude Code 权限配置](https://code.claude.com/docs/en/permissions)
