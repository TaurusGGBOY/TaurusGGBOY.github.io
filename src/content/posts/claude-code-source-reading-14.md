---
title: "Claude Code源码解读14：如何通过快照与历史实现回滚"
published: 2026-07-24T16:47:01+08:00
updated: 2026-07-28T17:30:00+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-14/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 本章先建立三个概念

- **乐观并发校验**：写入前比较读时状态，避免基于过期内容覆盖用户或其他进程的新修改。

- **Checkpoint**：每次编辑前保存可恢复状态，让会话能够按提示词边界回退代码。

- **原子替换**：先写临时内容再替换目标文件，把崩溃窗口压缩到文件系统可控范围。

![文件写入校验与 checkpoint 两条时间线](/images/posts/claude-code-source-reading-14/14-file-safety-timelines-detail-handdrawn.png)

这张图先固定本章的观察坐标。后文出现具体函数、字段和分支时，都可以回到这几个概念判断它位于哪一层。

## 回答上一篇的问题

改写前我阅读了 Netnerds 的 [PowerShell 与 Claude Code hooks 实践](https://blog.netnerds.net/2026/02/claude-code-powershell-hooks/) 和 Microsoft 的 [PowerShell 异常处理说明](https://learn.microsoft.com/en-us/powershell/scripting/learn/deep-dives/everything-about-exceptions?view=powershell-7.5)。前者展示了 Bash/PowerShell 边界、引用和模块环境造成的真实失败，后者把 parse error、parameter binding 和运行时异常明确分层。

上一篇留下的问题是：从当前版本看来，为什么很多 PowerShell 脚本要到执行时才报错？

先给结论：PowerShell 的“能被解析”和“能在当前主机上成功执行”是两件事。2.1.88 里的安全链会先用 PowerShell 自己的 AST 做语法与危险结构分析，再做权限判断；这一步的目标是判断“是否应该允许尝试”，不是提前运行脚本验证所有命令、模块、路径、数据和外部程序。真正执行时，PowerShell 才会解析命令名、绑定参数、加载模块、读取环境和文件，并产生 stdout、stderr 与退出码，所以很多错误只能在这个阶段出现。

这不是安全校验失效，而是静态检查与运行时解释之间的边界。静态检查必须避免执行未知副作用；运行时又必须面对当前机器的 PowerShell 版本、PATH、模块、执行策略、工作目录、权限和数据状态。只要其中一项依赖当前环境，解析通过也不能推出执行成功。

本文仍以仓库中从 `@anthropic-ai/claude-code@2.1.88` source map 还原的源码为边界。为了突出主线，下面的源码片段省略了与当前结论无关的埋点、UI 和分支；文中路径只定位还原文件，Anthropic 内部仓库目录属于证据范围之外。

## 文件安全其实是两条时间线

我们先把整个过程画出来。

![Claude Code 文件读取、写入与回滚流程](/images/posts/claude-code-source-reading-14/14-file-tools-rollback-handdrawn.png)

上半条时间线面向“现在”：Read 产生读取凭据，Edit、Write 和 NotebookEdit 在写入前检查它是否仍然有效。

下半条时间线面向“过去”：一条用户消息建立检查点，第一次修改某个文件时保存修改前版本，之后可以按消息 UUID 把文件恢复回去。

因此，Read 同时承担查看内容与建立写入凭据两项职责。文件历史只追踪工具实际修改过的文件，并在消息检查点上保存版本。

## Read 把内容与修改时间保存为写入凭据

读取状态的定义在 `restored-src/src/utils/fileStateCache.ts`。核心字段很少：

```ts
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

```ts
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

```ts
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

## Edit 用字符串匹配同时约束目标和并发状态

Edit 的输入契约位于 `restored-src/src/tools/FileEditTool/types.ts`：

```ts
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

```ts
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

```ts
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

```ts
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

## Write 的保护相同，破坏半径更大

Write 的参数只有必填字符串 `file_path` 和 `content`；文件缺失时创建，存在时用完整 `content` 覆盖。

它仍然先走 `checkWritePermissionForTool`，已有文件也必须存在可用的 Read 状态。`restored-src/src/tools/FileWriteTool/FileWriteTool.ts` 中 `FileWriteTool.validateInput` 的关键分支如下：

```ts
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

## 单文件写入优先原子化，但允许降级

Edit、Write 和 NotebookEdit 最终都调用 `writeTextContent`，再进入 `restored-src/src/utils/file.ts` 的 `writeFileSyncAndFlush_DEPRECATED`。

```ts
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

```ts
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

## NotebookEdit 按 cell 语义修改 JSON

`.ipynb` 在磁盘上确实是 JSON，但 NotebookEdit 操作的是 cell 语义。`restored-src/src/tools/NotebookEditTool/NotebookEditTool.ts` 的输入 Schema 明确列出三种模式：

```ts
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

```ts
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

## 检查点先建立，备份在第一次修改前补进去

文件历史的状态定义在 `restored-src/src/utils/fileHistory.ts`：

```ts
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

检查点是在处理可选择的用户消息时调用 `fileHistoryMakeSnapshot(updateFileHistoryState, messageId)` 创建的。真正的旧内容则由 Edit、Write、NotebookEdit 在落盘前调用：

```ts
await fileHistoryTrackEdit(
  updateFileHistoryState,
  absoluteFilePath,
  parentMessage.uuid,
)
```

`fileHistoryTrackEdit` 的 `updateFileHistoryState` 是会话状态更新器，`absoluteFilePath` 是即将修改的文件，`parentMessage.uuid` 是触发本次工具调用的消息 ID。函数必须在修改前执行；同一检查点已记录过该文件时直接复用，避免重复调用把修改后的内容覆盖到 v1 备份。

备份名由路径 SHA-256 的前 16 位和版本号组成，存放在 `~/.claude/file-history/<sessionId>/`。文件原本缺失时，`createBackup` 返回 `backupFileName: null`；回滚据此删除本轮新建的文件。

新的消息检查点还会检查所有已追踪文件。文件与最近备份内容相同时复用版本；内容变化时创建下一版本；文件已删除时记录新的 `null`。内存中最多保留 100 个 snapshot，超过后只保留最后 100 个。

## 文件历史按交互模式选择默认值

`fileHistoryEnabled` 把交互式会话和非交互式会话分开：

```ts
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

## 回滚按文件独立恢复

`fileHistoryRewind` 先按 `messageId` 找最后一个匹配的 snapshot，找不到会抛出 “The selected snapshot was not found”。找到后交给 `applySnapshot`：

```ts
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

`restoreBackup(filePath, backupFileName)` 使用 `copyFile` 恢复内容，再用 `chmod` 恢复备份权限。该路径直接复制备份，省略普通编辑工具的临时文件 rename；批量恢复中某个文件失败时，已经恢复的文件保持现状。由此可以得出一个很重要的边界：

- 一次回滚可能只恢复部分文件；
- 恢复过程中还可能覆盖用户在检查点之后手工完成的修改；
- 新文件删除失败、备份文件丢失、目录权限不足，都可能留下混合状态；
- 文件历史只覆盖进入 `fileHistoryTrackEdit` 的修改，覆盖范围小于 Git 或工作区镜像。

交互式 REPL 会在 `restored-src/src/screens/REPL.tsx` 的消息选择器中调用 `fileHistoryRewind`。`restored-src/src/cli/print.ts` 的 print/SDK 控制路径还提供 dry-run：`handleRewindFiles` 用 `fileHistoryGetDiffStats` 先计算预计变化的文件、增加行和删除行，再决定是否实际恢复。dry-run 是预览，不会让后续真实恢复获得事务保证，因为两次调用之间磁盘仍可能变化。

## 权限保护的是修改入口，不自动覆盖回滚入口

Edit 和 Write 都通过 `checkWritePermissionForTool` 检查写权限，NotebookEdit 也走同一类检查。拒绝规则还会在输入校验阶段提前阻止访问对应路径。因此正常工具调用的写入，位于前一篇所讲的权限边界内。

但从本文追踪到的调用关系看，REPL 的 `MessageSelector` 和 print/SDK 的 `handleRewindFiles` 都直接调用 `fileHistoryRewind`；`fileHistoryRewind -> applySnapshot -> restoreBackup/unlink` 这条链绕过 `checkWritePermissionForTool`。因此在这份 2.1.88 还原源码中，回滚由用户或宿主以会话控制操作发起，恢复阶段不会逐文件重新进入工具权限询问。

这也是为什么回滚确认和 diff 预览很重要：权限引擎负责 Agent 发起的文件工具，用户主动选择 rewind 则进入另一条控制路径。

## 失败时究竟会留下什么

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

这里采用“冲突后停止并重新 Read”策略，而非自动三方合并。历史恢复遇到冲突时则按目标备份覆盖，用户后来修改的语义不会参与合并。两条路径分别保护写入前的新鲜度和回滚目标的一致性。

## 小结

Claude Code 的文件安全可以压缩成四步：Read 保存一份带范围和 mtime 的读取凭据；Edit、Write、NotebookEdit 在权限检查后验证凭据，其中 Edit 与 Write 还会在实际调用里重复检查；文件历史在修改前保存旧版本，并把版本绑定到用户消息检查点；用户选择 rewind 时，再逐个文件复制旧版本或删除当时不存在的新文件。

这套设计比直接 `readFile + replace + writeFile` 多做了很多工作。它能显著减少 Agent 覆盖用户新修改的概率，也给交互式会话提供代码回退能力。源码同时留下明确边界：缓存会淘汰，备份可能失败，原子写可以降级，回滚可以部分成功，回滚操作还会绕过文件工具的逐次权限检查。

所以，把它理解成“带读取凭据和检查点的文件操作系统”是准确的；把它叫作“跨文件事务”就过头了。

## 留给下一篇的问题

你知道 rewind 的时候哪些东西是无法回滚的吗？

## 参考资料

- [Claude Code Checkpointing](https://code.claude.com/docs/en/checkpointing)

- [Claude Code 权限配置](https://code.claude.com/docs/en/permissions)
