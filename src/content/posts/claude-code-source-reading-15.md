---
title: "Claude Code源码解读15：rewind 能回滚什么，不能回滚什么"
published: 2026-07-24T16:47:02+08:00
updated: 2026-07-28T17:30:00+08:00
description: ""
tags: ["claude-code", "source-code", "ai-agent"]
category: "AI / Architecture"
draft: false
image: "/images/posts/claude-code-source-reading-15/claude-code-source-reading-00.png"
imagePosition: "left"
---

## 回答上一篇的问题

上一篇留下的问题是：你知道 rewind 的时候哪些东西是无法回滚的吗？

答案先说清楚：**rewind 不是整个 Agent 会话的 Undo，而是针对 File History 检查点的文件系统恢复。** 它只能处理已经被文件历史追踪、并且在目标消息检查点上留下备份的文件版本；对话内容、模型已经产生的推理、网络和数据库副作用、没有进入追踪流程的文件修改，都不在这条恢复链里。即使是被追踪的文件，恢复也按文件逐个执行，某个文件失败不会把已经恢复的其他文件重新撤销。

因此，看到“rewind 成功”时，准确理解应该是“目标检查点对应的文件恢复流程完成”，而不是“系统回到了过去的完整世界”。

## 本章先建立三个概念

- **Checkpoint**：由 `messageId` 标识的一次文件历史检查点，保存的是文件备份索引，不是完整会话快照。

- **Tracked file**：进入 `fileHistoryTrackEdit()` 的文件才会加入 `trackedFiles`；文件历史按路径记录版本，原本不存在的文件用 `backupFileName: null` 表示。

- **Best effort**：`applySnapshot()` 按文件循环恢复并逐个捕获异常，没有跨文件事务；备份、权限、目录和磁盘状态都可能让结果停在中间。

![rewind 可恢复范围与不可恢复边界](/images/posts/claude-code-source-reading-15/15-rewind-boundaries-handdrawn.png)

这张图把“能恢复的文件状态”和“无法由 checkpoint 覆盖的外部世界”分开。后文沿着 `messageId → applySnapshot()` 这条调用链，解释每个边界具体在哪里。

本文继续限定在 `@anthropic-ai/claude-code@2.1.88` 的 source map 还原源码。下面的片段只保留证明当前结论所需的分支，不把合并后的示意代码当作完整源码。

## rewind 实际执行了什么

入口是 `restored-src/src/utils/fileHistory.ts` 的 `fileHistoryRewind()`：

```ts
export async function fileHistoryRewind(
  updateFileHistoryState,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) return

  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return

  const targetSnapshot = captured.snapshots.findLast(
    snapshot => snapshot.messageId === messageId,
  )
  if (!targetSnapshot) {
    throw new Error('The selected snapshot was not found')
  }

  await applySnapshot(captured, targetSnapshot)
}
```

这段代码有四个关键事实：

1. `fileHistoryEnabled()` 为假时，rewind 直接返回，不会补做备份或恢复。
2. `updateFileHistoryState` 在这里用 no-op updater 捕获当前状态；rewind 本身不修改内存里的历史索引。
3. `findLast` 按 `messageId` 找目标检查点。找不到 snapshot 是失败，不会“尽量恢复到最近一次”。
4. 真正的磁盘操作由 `applySnapshot()` 执行，传入的是当前状态与一个目标 snapshot。

交互式 REPL 的消息选择器和 print/SDK 的 `handleRewindFiles()` 都会进入这条链。后者可以先调用 `fileHistoryGetDiffStats()` 做 dry-run 预览，但预览和真实恢复之间磁盘仍可能变化，所以 dry-run 不是锁，也不是事务预提交。

## 哪些文件状态可以被恢复

### 1. 文件工具在修改前留下的版本

`fileHistoryTrackEdit(updateFileHistoryState, filePath, messageId)` 只在历史开关开启、当前检查点存在且该文件尚未被该检查点追踪时创建备份。源码能确认的直接调用者包括：

- `FileEditTool.call()`；
- `FileWriteTool.call()`；
- `NotebookEditTool.call()`；
- `BashTool` 的 `_simulatedSedEdit` 预览写入路径。

普通 `BashTool.call()` 执行 shell 命令时不会因为命令字符串里可能修改了文件，就自动为任意路径建立 file-history 备份；`PowerShellTool` 也不在 `fileHistoryTrackEdit()` 的调用者中。这里的边界不是“文件最后有没有变化”，而是“这次变化是否经过了历史追踪入口”。

### 2. 目标检查点上的文件内容与权限

`createBackup()` 为文件生成版本备份，备份名由路径和版本组成，保存到会话的 `~/.claude/file-history/<sessionId>/` 目录。`restoreBackup()` 用 `copyFile()` 把备份内容复制回目标路径，再用备份的 mode 调用 `chmod()`。因此，对一个有效备份来说，rewind 能恢复文件内容和备份记录的文件权限；它不是重新执行当时的 Edit，也不会重新构造一次模型调用。

### 3. 检查点时不存在的、后来被新建的文件

如果目标检查点时文件不存在，`createBackup()` 记录 `backupFileName: null`。`applySnapshot()` 看到这个标记时会尝试 `unlink(filePath)`：文件已经不存在时，`ENOENT` 被视为目标状态已经满足；删除成功时，路径加入 `filesChanged`。

所以“新文件能否回滚”的准确答案是：如果它进入了追踪集合，并且目标 snapshot 记录了它原本不存在，rewind 会尝试删除它；如果它从未被追踪，rewind 根本不知道它属于哪次修改。

## 哪些东西无法由 rewind 回滚

### 1. 对话和模型状态

`FileHistorySnapshot` 只有 `messageId`、`trackedFileBackups` 和时间戳。它没有保存完整消息历史、模型 hidden state、token 消耗、工具调用结果或已经发出的回答。rewind 通过消息 ID 选择文件目标版本，不会把模型上下文倒带，也不会让模型“忘记”已经观察到的内容。

### 2. 文件之外的副作用

Shell、PowerShell、Python 或其他程序可能已经完成了网络请求、数据库写入、进程启动、包安装、Git 提交、发送消息等操作。`applySnapshot()` 只调用 `unlink()`、`copyFile()`、`mkdir()` 和 `chmod()` 一类文件系统操作；它没有这些外部系统的反向操作，因此这些副作用无法由 file history 自动撤销。

即使命令同时改了某个被追踪文件，rewind 也只尝试恢复那个文件版本，不会根据文件内容推断并撤销命令的其他影响。

### 3. 没有进入追踪集合的文件修改

`applySnapshot()` 的循环对象是 `state.trackedFiles`，不是当前工作区扫描结果。未经过 `fileHistoryTrackEdit()` 的路径不在循环里：它可能仍然存在、被删除或被外部程序改过，rewind 都不会主动发现并补建历史。

这也解释了一个常见误区：不能把 rewind 当作“扫描整个仓库并恢复到某个时间点”。它没有 Git 那样的工作区镜像，也没有对所有路径做内容差分。

### 4. 检查点之外的目录与环境状态

备份记录的是文件路径和文件备份，目录本身不是独立的 snapshot 对象。恢复时如果目标父目录不存在，`restoreBackup()` 会按需 `mkdir(..., { recursive: true })`，但它不会恢复目录的历史权限、目录时间、符号链接拓扑、环境变量、当前 cwd 或外部挂载状态。

同理，文件工具的读取缓存、权限询问结果、沙箱状态和终端显示状态不属于 `FileHistorySnapshot`。它们不会因为文件内容恢复而自动回到检查点。

### 5. 已被淘汰或从未成功写入的备份

`fileHistoryMakeSnapshot()` 把 snapshot 保存在内存数组中，并限制最多保留 `MAX_SNAPSHOTS`（当前源码为 100）个；更早的检查点会被截掉。备份 I/O 失败时，源码记录错误，当前工具调用仍可能继续，这意味着某个文件可能有历史记录但没有可用的备份文件。

`fileHistoryRewind()` 找不到目标 snapshot 会直接失败；`applySnapshot()` 无法解析备份名、备份文件丢失或目标目录无权限时，会记录单文件失败并继续处理其他 tracked file。历史不存在或备份缺失时，系统没有另一个隐含副本可以兜底。

## 为什么恢复后可能仍然不是“原样现场”

回滚不是三方合并。`applySnapshot()` 对已有文件先判断它是否与目标备份不同，不同就直接调用 `restoreBackup()` 覆盖目标。于是：

- 检查点之后用户手工写入的修改可能被覆盖；
- 另一个进程在恢复过程中继续写入，可能让最终磁盘内容再次偏离备份；
- 一个文件恢复失败时，其他文件已经完成的恢复不会自动撤销；
- 新文件删除失败时，它会继续留在工作区。

源码通过日志和 `tengu_file_history_rewind_restore_file_failed` 事件记录单文件失败，但没有跨文件补偿事务。`tengu_file_history_rewind_success` 记录的是恢复流程的统计结果，不等于所有目标文件都成功变成检查点内容。

## 把“能否回滚”拆成五个问题

遇到一个具体文件或副作用，可以按这个顺序判断：

1. **它是文件系统状态吗？** 网络、数据库、进程和消息发送先排除在外。
2. **修改是否进入了 `fileHistoryTrackEdit()`？** 只看“文件被改过”不够。
3. **目标 `messageId` 是否仍有 snapshot？** 最多 100 个 snapshot 的保留边界要考虑。
4. **该 snapshot 是否有对应 backup？** `null` 表示当时不存在，不是备份文件损坏。
5. **批量恢复是否每个文件都成功？** 查看 diff 预览、日志和失败事件，不能只看总流程返回。

这五问把“无法回滚”从一句模糊的产品印象，落到了追踪集合、备份版本和具体副作用上。

## 小结

Claude Code 的 rewind 能回滚的是“文件历史在某个消息检查点上记录的文件版本”：包括被追踪文件的内容、备份权限，以及目标点不存在的新文件删除动作。它不能回滚对话与模型上下文、命令带来的网络和数据库副作用、未追踪路径、目录和环境状态，也不能突破历史保留、备份 I/O 和逐文件失败的边界。

最重要的一句话是：**rewind 是文件历史恢复，不是世界状态回滚。** 把它当作 best-effort 的多文件恢复工具，才不会在看到“成功”提示后误以为所有外部状态都已经回到过去。

## 留给下一篇的问题

你知道 Claude Code 会用你默认的模型进行 WebSearch 吗？

## 参考资料

- `restored-src/src/utils/fileHistory.ts`

- `restored-src/src/tools/FileEditTool/FileEditTool.ts`

- `restored-src/src/tools/FileWriteTool/FileWriteTool.ts`

- `restored-src/src/tools/NotebookEditTool/NotebookEditTool.ts`

- `restored-src/src/tools/BashTool/BashTool.tsx`
