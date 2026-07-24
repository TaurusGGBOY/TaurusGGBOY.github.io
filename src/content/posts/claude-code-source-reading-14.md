---
title: "Claude Code源码解读14：如何通过快照与历史实现回滚"
published: 2026-07-24T16:47:01+08:00
updated: 2026-07-24T16:47:01+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-14/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇最后留下的问题是：Bash 之外，Read、Edit、Write、Notebook 等文件工具如何利用读取状态、快照与历史避免覆盖，并在失败后回滚？

先说结论：Claude Code 使用了两套不同的状态。

一套是 `FileStateCache`。它记录 Agent 上一次读到的内容、修改时间和读取范围，主要解决“我准备写入时，磁盘上的文件还是刚才看到的那一版吗”。另一套是 `FileHistoryState`。它以用户消息为检查点，在真正改文件之前备份旧版本，主要解决“这一轮改坏以后，能否回到某条用户消息开始时的状态”。

这两套状态互相配合，却不是数据库事务。普通文本写入会优先使用“临时文件 + rename”，但失败后会降级为直接写；回滚也会逐个文件恢复，某个文件失败后继续处理其他文件。准确的说法是：它提供了并发覆盖防护、单文件原子写的优先路径，以及尽力而为的多文件恢复，而不是跨文件的 ACID 事务。

本文仍以仓库中从 `@anthropic-ai/claude-code@2.1.88` source map 还原的源码为边界。为了突出主线，下面的源码片段省略了与当前结论无关的埋点、UI 和分支；路径是还原路径，不等于 Anthropic 内部仓库的原始目录。

## 文件安全其实是两条时间线

我们先把整个过程画出来。

![Claude Code 文件读取、写入与回滚流程](/images/posts/claude-code-source-reading-14/14-file-tools-rollback-handdrawn.png)

上半条时间线面向“现在”：Read 产生读取凭据，Edit、Write 和 NotebookEdit 在写入前检查它是否仍然有效。

下半条时间线面向“过去”：一条用户消息建立检查点，第一次修改某个文件时保存修改前版本，之后可以按消息 UUID 把文件恢复回去。

因此，Read 不是一个与 Edit 无关的查看工具。对已有文件来说，它还是后续写入的前置条件。文件历史也不是每次按键都复制整个项目，它只追踪实际被工具修改过的文件。

## Read 留下的不是内容副本，而是写入凭据

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

`FileState` 描述一次可用于后续校验的读取。`content` 是当时读到的文本；`timestamp` 是向下取整后的文件修改时间；`offset` 和 `limit` 表示读取范围，`undefined` 代表没有设置对应限制；`isPartialView: true` 表示内容由自动注入产生，而且模型看到的并非磁盘原文。该布尔值缺省时按非部分视图处理，但 Edit 和 Write 会显式拒绝值为 `true` 的条目。

它不是无限增长的 `Map`。`createFileStateCacheWithSizeLimit` 默认同时限制条目数和内容总量：

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

`createFileStateCacheWithSizeLimit` 创建一个按路径归一化键名的 LRU 缓存。`maxEntries` 是最大条目数，调用方通常传入 `100`；`maxSizeBytes` 是缓存内容的字节上限，未传时默认为 25 MiB。条目可能因为 LRU 淘汰而消失，所以“曾经读过”不等于本次写入一定还能拿到读取凭据。

文本读取完成后，`restored-src/src/tools/FileReadTool/FileReadTool.ts` 的 `callInner` 才把内容和磁盘时间放进缓存：

```ts
readFileState.set(fullFilePath, {
  content,
  timestamp: Math.floor(mtimeMs),
  offset,
  limit,
})
```

`callInner` 的 `fullFilePath` 是归一化后的目标路径，`content` 是本次实际返回的文本，`mtimeMs` 来自读取过程中的文件状态，`offset` 和 `limit` 来自 Read 输入。Read 的 `offset` 是非负整数，默认从文件开头读取；`limit` 是正整数或 `undefined`，后者表示未主动限制行数，但仍受文件大小与 token 上限约束。

这里有一个容易忽略的细节：通过 `offset` 或 `limit` 得到的局部 Read 也会进入缓存，而且 Edit、Write 并不会仅因为读取范围不完整就拒绝写入。真正被硬性拒绝的是 `isPartialView: true` 的自动注入内容。范围字段主要影响 mtime 变化后的内容兜底：只有 `offset` 和 `limit` 都是 `undefined` 的完整读取，才能通过“磁盘内容仍相等”消除时间戳误报。

Read 自己还会利用这份状态去重。如果相同范围的修改时间没有变化，它返回 `file_unchanged`，避免再次把整段内容塞进上下文。这个优化只减少重复传输，并不放松写入校验。

## Edit 不是“找到字符串就替换”

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

这段 Schema 由 `inputSchema` 构造。`file_path`、`old_string` 和 `new_string` 都是必填字符串；路径经过展开后用于权限和缓存匹配。`replace_all` 只能表达布尔语义，`true` 替换所有匹配，`false` 只允许唯一匹配；它可以省略，省略时默认 `false`。源码没有把 `null` 定义成合法值。

`old_string` 的作用不只是告诉工具“删掉什么”。它同时是一段局部的乐观并发条件：如果磁盘中已经找不到它，工具不会猜测目标位置。如果出现多个匹配而 `replace_all` 仍为 `false`，工具也不会擅自挑第一个。

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

`validateInput` 接收 `FileEditInput` 和 `ToolUseContext`。`toolUseContext.readFileState` 是当前会话共享的读取缓存；缓存不存在或 `isPartialView` 为真时返回错误码 `6`，要求先 Read。磁盘修改时间更晚时，完整读取还可以用内容相等作为兜底，避免 Windows 云同步、杀毒软件等只触碰时间戳造成误报；局部读取没有这条兜底。

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

`findActualString(file, old_string)` 在完整文件 `file` 中解析实际匹配文本，也处理引号样式差异；找不到时返回假值。`matches` 是实际出现次数。`replace_all: false` 且出现多次会返回错误码 `9`，调用方必须补充更多上下文，或者明确改成 `true`。

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

注意“缩小”这个词。JavaScript 进程内没有 `await`，可以避免同一事件循环中的其他异步任务插进来；它不能阻止另一个进程在检查之后、rename 之前修改磁盘。源码没有文件锁或 compare-and-swap，因此不能把这段逻辑说成绝对消除并发覆盖。

## Write 的保护相同，破坏半径更大

Write 的参数只有 `file_path` 和 `content`。两者都是必填字符串，没有 `replace_all`、追加模式或局部范围；文件不存在时创建，存在时用完整 `content` 覆盖。

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

`FileWriteTool.validateInput` 的 `fullFilePath` 来自 `file_path`，`fileMtimeMs` 来自当前 `stat`。不存在的文件无需先 Read；已有文件必须有非部分读取状态。这里与 Edit 有细微差别：校验阶段只要时间戳更新就拒绝，没有内容相等兜底。实际 `call` 阶段会再次读取，并在完整内容相等时容忍时间戳变化。

Write 的输出 Schema 用 `create | update` 区分新建和覆盖，并把 `originalFile` 声明成 `string | null`。不过 `FileWriteTool.call` 实际使用 `if (oldContent)` 分支：已有文件内容为非空字符串时返回 `update`，不存在时返回 `create`；已有但内容恰好是空字符串时也会进入 `create`，并返回 `originalFile: null`。这是源码中可见的空文件边界，不能只按 Schema 把 `null` 解释成“写入前一定不存在”。

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

但主路径失败后，函数不是回滚并终止，而是清理临时文件，然后直接覆盖目标：

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

这是同一个 `writeFileSyncAndFlush_DEPRECATED` 的降级分支。`tempPath` 清理失败只记录日志；`targetPath` 的直接写入不再具备 rename 主路径的原子替换语义。如果直接写也失败，错误才继续向上传播。因此文章可以说“优先原子写”，不能说“所有写入都是原子的”。

## Notebook 为什么不能当成普通 JSON 文本改

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

`NotebookEditTool.inputSchema` 中，`new_source` 必填；`edit_mode` 可取 `replace`、`insert`、`delete`，省略时默认 `replace`。`cell_type` 可取 `code` 或 `markdown`，插入时必填，替换时省略则沿用当前类型。`cell_id` 可以是 notebook 的真实 ID，也可以是 `cell-N` 形式的索引；插入时省略表示插到开头，replace/delete 时省略会失败。源码未把 `null` 声明为这些可选字段的合法输入。

NotebookEdit 同样要求先 Read，并在 `validateInput` 中检查 mtime。与 Edit、Write 不同，它的 `call` 在异步执行 `fileHistoryTrackEdit` 后没有再做一次临写前 mtime 校验；这会留下一个更宽的外部修改竞态窗口。真正修改时，它不会只替换 JSON 字符串：

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

这是 `NotebookEditTool.call` 的 cell 修改分支。`cellIndex` 由 `cell_id` 解析；`new_cell` 根据 `cell_type` 创建；`new_source` 是新单元格内容。替换代码单元格时，`execution_count` 被设为 `null`，输出数组被清空，避免源码已经变化但旧运行结果仍挂在下面。这个 `null` 是 Jupyter cell 的“尚未执行”语义，与前面的可选参数无关。

对于 nbformat 4.5 及以上，新插入 cell 会生成 ID；替换越过末尾一个位置时，调用阶段还会把 `replace` 转成 `insert`，并在没有 `cell_type` 时回退为 `code`。这些行为说明 NotebookEdit 维护的是 notebook 数据结构，不是普通文本补丁。

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

`FileHistorySnapshot.messageId` 把检查点绑定到一条用户消息；`trackedFileBackups` 是文件路径到备份版本的映射。`backupFileName` 为字符串时指向会话备份文件，为 `null` 时表示目标版本里该文件不存在；它不是备份失败。`version` 从 1 递增，`backupTime` 和 snapshot 的 `timestamp` 用于记录时间，不是数据库提交时间。

检查点是在处理可选择的用户消息时调用 `fileHistoryMakeSnapshot(updateFileHistoryState, messageId)` 创建的。真正的旧内容则由 Edit、Write、NotebookEdit 在落盘前调用：

```ts
await fileHistoryTrackEdit(
  updateFileHistoryState,
  absoluteFilePath,
  parentMessage.uuid,
)
```

`fileHistoryTrackEdit` 的 `updateFileHistoryState` 是会话状态更新器，`absoluteFilePath` 是即将修改的文件，`parentMessage.uuid` 是触发本次工具调用的消息 ID。函数必须在修改前执行；同一检查点已记录过该文件时直接复用，避免重复调用把修改后的内容覆盖到 v1 备份。

备份名不是原路径，而是路径 SHA-256 的前 16 位加版本号，存放在 `~/.claude/file-history/<sessionId>/`。文件原本不存在时，`createBackup` 返回 `backupFileName: null`；这样回滚就知道应该删除本轮新建的文件。

新的消息检查点还会检查所有已追踪文件。如果文件与最近备份相比没有变化就复用版本；变化则创建下一版本；文件已删除则记录新的 `null`。内存中最多保留 100 个 snapshot，超过后只保留最后 100 个。

## 文件历史并非在所有运行模式默认开启

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

`fileHistoryEnabled()` 没有参数。交互式会话中，`fileCheckpointingEnabled` 只要不是显式 `false` 就开启，同时环境变量 `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` 不能为真。非交互式路径进入 `fileHistoryEnabledSdk()`：必须显式开启 `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`，并且仍未被 disable 变量关闭。`isEnvTruthy` 将忽略大小写和首尾空格的 `1`、`true`、`yes`、`on` 解释为真；`undefined`、空字符串和其他值为假。

。开关关闭、状态更新器为空实现、备份 I/O 失败，都会让历史不可用；追踪失败被记录后，文件工具仍可能继续执行。

## 回滚是逐文件恢复，不是一次整体提交

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

`applySnapshot(state, targetSnapshot)` 的 `state.trackedFiles` 是整个会话追踪过的路径集合，`targetSnapshot` 是目标消息检查点。`backupFileName: null` 表示当时不存在，因此现在应删除；字符串表示从备份复制回来。每个文件有独立 `try/catch`，失败只记录并继续，所以函数返回成功不等于每个文件都恢复成功。

`restoreBackup(filePath, backupFileName)` 使用 `copyFile` 恢复内容，再用 `chmod` 恢复备份权限。它没有使用普通编辑工具的临时文件 rename 路径，也没有在所有文件恢复失败时把已恢复文件重新撤销。由此可以得出一个很重要的边界：

- 一次回滚可能只恢复部分文件；
- 恢复过程中还可能覆盖用户在检查点之后手工完成的修改；
- 新文件删除失败、备份文件丢失、目录权限不足，都可能留下混合状态；
- 文件历史只覆盖进入 `fileHistoryTrackEdit` 的修改，不是 Git，也不是整个工作区镜像。

交互式 REPL 会在 `restored-src/src/screens/REPL.tsx` 的消息选择器中调用 `fileHistoryRewind`。`restored-src/src/cli/print.ts` 的 print/SDK 控制路径还提供 dry-run：`handleRewindFiles` 用 `fileHistoryGetDiffStats` 先计算预计变化的文件、增加行和删除行，再决定是否实际恢复。dry-run 是预览，不会让后续真实恢复获得事务保证，因为两次调用之间磁盘仍可能变化。

## 权限保护的是修改入口，不自动覆盖回滚入口

Edit 和 Write 都通过 `checkWritePermissionForTool` 检查写权限，NotebookEdit 也走同一类检查。拒绝规则还会在输入校验阶段提前阻止访问对应路径。因此正常工具调用的写入，位于前一篇所讲的权限边界内。

但从本文追踪到的调用关系看，REPL 的 `MessageSelector` 和 print/SDK 的 `handleRewindFiles` 都是直接调用 `fileHistoryRewind`，而 `fileHistoryRewind -> applySnapshot -> restoreBackup/unlink` 这条链上没有再次调用 `checkWritePermissionForTool`。所以不能笼统地写“回滚仍会逐文件重新询问权限”。至少在这份 2.1.88 还原源码中，回滚更像一个已经由用户或宿主发起的会话控制操作。

这也是为什么回滚确认和 diff 预览很重要：权限引擎负责 Agent 发起的文件工具，用户主动选择 rewind 则进入另一条控制路径。。

## 失败时究竟会留下什么

现在可以把几种失败放回同一个模型里：

| 失败位置 | 源码行为 | 能否继续写入或恢复 |
|---|---|---|
| 没有 Read，或只有 `isPartialView` 自动注入 | Edit/Write 拒绝已有文件 | 显式 Read 后才能继续 |
| Read 后文件被修改 | 校验或临写前检查失败 | 重新读取，不自动合并 |
| `old_string` 不存在或不唯一 | Edit 拒绝 | 增加上下文或明确 `replace_all: true` |
| 备份创建失败 | 记录错误，工具调用仍可能继续 | 本次修改可能没有可用回滚点 |
| 临时文件/rename 失败 | 清理临时文件并直接写目标 | 退化成非原子写 |
| 单个文件恢复失败 | 记录错误并处理下一个文件 | 可能出现部分回滚 |
| snapshot 不存在或已淘汰 | rewind 失败 | 无法靠该历史恢复 |

这里没有自动三方合并。读取状态发现冲突后的策略是停止，让 Agent 重新 Read；历史恢复遇到冲突时则按目标备份覆盖，不会理解用户后来修改的语义。两者看起来都在“保护文件”，解决的却是不同问题。

## 小结

Claude Code 的文件安全可以压缩成四步：Read 保存一份带范围和 mtime 的读取凭据；Edit、Write、NotebookEdit 在权限检查后验证凭据，其中 Edit 与 Write 还会在实际调用里重复检查；文件历史在修改前保存旧版本，并把版本绑定到用户消息检查点；用户选择 rewind 时，再逐个文件复制旧版本或删除当时不存在的新文件。

这套设计比直接 `readFile + replace + writeFile` 多做了很多工作。它能显著减少 Agent 覆盖用户新修改的概率，也给交互式会话提供代码回退能力。但源码同样清楚地留下了边界：缓存会淘汰，备份可能失败，原子写可以降级，回滚可以部分成功，回滚链路也不等于再次执行文件工具权限检查。

所以，把它理解成“带读取凭据和检查点的文件操作系统”是准确的；把它叫作“跨文件事务”就过头了。

## 留给下一篇的问题

当 Agent 不知道目标在哪里时，Glob、Grep、Read、WebSearch 与 WebFetch 等检索工具如何分层搜索并裁剪结果？

