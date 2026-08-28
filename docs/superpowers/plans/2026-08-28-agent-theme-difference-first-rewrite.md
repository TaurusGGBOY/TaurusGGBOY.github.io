# Agent 主题对比系列差异优先重写 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将九篇 Agent 主题文章从共性科普彻底改写为 Claude Code、Codex、Pi、DeepSeek Harness 的差异、短板、优势、代价与适用条件，并在验证通过后发布到 GitHub Pages。

**Architecture:** 保留九个 Markdown 文件及公开 URL，以九个互不重复的比较冲突重建正文；公开证据包负责事实边界，静态密度脚本负责发现共性段落，人工审查负责判断每段是否真正帮助选型。完成本地内容、构建和浏览器验证后，仅提交指定文章与计划文件，推送 `master` 触发 Pages，并逐页核对线上结果。

**Tech Stack:** Astro 5、Markdown content collections、pnpm 9.14.4、Vitest、Playwright、GitHub Actions Pages、公开官方文档与研究证据包。

## Global Constraints

- 保留九个文件名、`published`、`image`、`imagePosition`、`slug`、`series` 和 `order`。
- 更新 `title`、`description`、`tags`、`topics`、`prerequisites`、`time`、`updated` 和 `verified_at`；保留 `category` 与 `draft`。
- 每篇目标 2,200–3,200 个汉字；产品无关内容不超过正文汉字数的 10%；同时比较两个以上产品的段落不少于正文的 35%。
- 其余产品相关段落必须承担优势、短板、代价或适用条件之一；每篇至少四个明确短板。
- 每篇结尾必须有“优势 / 短板 / 代价 / 适合谁”裁决表，不使用纯功能勾选表，也不生成脱离场景的总冠军。
- 只使用公开官方文档、官方工程文章、项目 README、安全说明和方法透明的研究材料；本地源码、反编译结果、本站旧文和上一版正文不承担事实证据。
- DeepSeek Harness 的 developer preview、兼容性变化和安全边界在 03、06、07、09 中必须明确出现；其他文章只在相关主张旁出现一次。
- 九篇全部完成后必须执行 `press-conference-revision-evidence-bound`，并确认修订没有抬高主张。
- 保护未跟踪的 `.codebase-memory/`、`AGENTS.md`、`CLAUDE.md`；暂存、提交和推送时只使用明确路径。
- 当前会话不创建子代理；用户已授权继续执行并发布，因此计划完成后由主代理内联执行。

---

## File Map

- `src/content/posts/agent-theme-01-control-plane.md`：控制权与责任归属。
- `src/content/posts/agent-theme-02-message-tool-execution.md`：默认工具面与定制责任。
- `src/content/posts/agent-theme-03-context-security-recovery.md`：危险命令、审批与隔离边界。
- `src/content/posts/agent-theme-04-extension-delegation.md`：会话恢复对象与缺口。
- `src/content/posts/agent-theme-05-host-runtime.md`：CLI、IDE、云端切换时的状态所有权。
- `src/content/posts/agent-theme-06-configuration-operations.md`：扩展深度与升级成本。
- `src/content/posts/agent-theme-07-memory-background.md`：多 Agent 的成品能力与自建工程。
- `src/content/posts/agent-theme-08-experience-feedback.md`：完成证据与验证责任。
- `src/content/posts/agent-theme-09-a2a-interoperability.md`：按责任承受能力选型。
- `/Users/gaoguobin/Documents/Agent_Harness_Comparison_Research_20260828/{sources,evidence,claims}.jsonl`：来源、原文证据与可写主张。
- `/tmp/codextmp/agent-theme-difference-audit.*`：只保存可删除的临时密度与链接审计结果。

### Task 1: 固定证据与发布基线

**Files:**

- Inspect: all nine `src/content/posts/agent-theme-*.md`
- Inspect: `/Users/gaoguobin/Documents/Agent_Harness_Comparison_Research_20260828/{sources,evidence,claims}.jsonl`
- Inspect: `.github/workflows/pages.yml`
- Inspect: `scripts/verify-dist.mjs`

**Interfaces:**

- Consumes: 已批准设计、当前九篇 frontmatter、公开研究证据包。
- Produces: 九篇题目和字段契约、主张到来源的映射、当前分支与发布工作流基线。

- [ ] **Step 1: 核对九篇不可变字段**

  逐篇记录 `published`、`image`、`imagePosition`、`slug`、`series`、`order`，确认正文重写后这些值逐字符保持不变。

- [ ] **Step 2: 建立九个比较问题的证据映射**

  从 `claims.jsonl` 和 `evidence.jsonl` 为每篇选择能直接支持设计差异、成熟度或安全限制的证据；没有证据的排名、效果和稳定性判断不得进入正文。

- [ ] **Step 3: 核对发布与验证入口**

  确认 `master` 推送触发 `.github/workflows/pages.yml`，工作流依次执行 `pnpm check`、Vitest、构建、`verify:dist` 和 Playwright，再部署 Pages。

- [ ] **Step 4: 验证工作树基线**

  Run: `git status --short`

  Expected: 除新计划外，只存在已知未跟踪 `.codebase-memory/`、`AGENTS.md`、`CLAUDE.md`；九篇尚未产生本轮修改。

### Task 2: 重写控制权、工具面与安全边界 01–03

**Files:**

- Modify: `src/content/posts/agent-theme-01-control-plane.md`
- Modify: `src/content/posts/agent-theme-02-message-tool-execution.md`
- Modify: `src/content/posts/agent-theme-03-context-security-recovery.md`

**Interfaces:**

- Consumes: Task 1 的证据映射与不可变字段；设计中的 01–03 冲突轴。
- Produces: 三篇只讨论产品差异的完整 Markdown，为后续文章固定“责任落在哪里”的比较语言。

- [ ] **Step 1: 重写 01《四种 Harness 到底把控制权交给谁》**

  直接比较 Claude Code 的集成式产品控制、Codex 的 Harness 与客户端协议、Pi 的最小核心、DeepSeek Harness 的插件化运行时。每项判断同时说明难以替换的部分、团队接手的责任和适用组织，不解释通用 Harness 定义。

- [ ] **Step 2: 重写 02《默认工具越多越好吗》**

  围绕开箱工具面、工具结果质量、定制成本和故障排查责任组织正面对比。Claude Code 与 Codex 重点写产品化便利及受产品边界约束的代价；Pi 与 DeepSeek Harness 重点写可塑性及自建责任。

- [ ] **Step 3: 重写 03《谁真正替你隔离危险命令》**

  用同一危险命令作为唯一共同基准，对照 Claude Code 与 Codex 的权限/沙箱组合、Pi 不内建沙箱的明确边界、DeepSeek Harness 仍处预览期的审批与隔离设计。明确“不额外配置”时的责任人和最容易误读的安全边界。

- [ ] **Step 4: 添加三篇裁决表并自审**

  每篇结尾表格必须包含“产品 / 优势 / 短板 / 代价 / 适合谁”，正文至少四处明确短板；删除任何只说明四者共同能力的完整段落。

- [ ] **Step 5: 验证并提交 01–03**

  Run: `git diff --check -- src/content/posts/agent-theme-01-control-plane.md src/content/posts/agent-theme-02-message-tool-execution.md src/content/posts/agent-theme-03-context-security-recovery.md`

  Expected: 无空白错误；不可变 frontmatter 字段未变化。

  Commit paths explicitly with message: `docs: rewrite agent differences 01 to 03`。

### Task 3: 重写恢复、宿主与扩展成本 04–06

**Files:**

- Modify: `src/content/posts/agent-theme-04-extension-delegation.md`
- Modify: `src/content/posts/agent-theme-05-host-runtime.md`
- Modify: `src/content/posts/agent-theme-06-configuration-operations.md`

**Interfaces:**

- Consumes: Task 1 证据映射；Task 2 的责任归属术语；设计中的 04–06 冲突轴。
- Produces: 三篇关于恢复对象、状态所有权和升级负担的完整 Markdown。

- [ ] **Step 1: 重写 04《会话中断后，四者各自能恢复什么》**

  正面对照 Claude Code 的 resume/fork/compact、Codex 的 thread/turn/item、Pi 的树形 JSONL session、DeepSeek Harness 的 append-only event log。每段区分聊天记录、控制状态、代码环境和分支路径，指出恢复后仍需人工复核的缺口。

- [ ] **Step 2: 重写 05《从 CLI 切到 IDE 或云端，状态会不会断》**

  比较 Claude Code 各工作台及 teleport、Codex App Server、Pi 的 TUI/RPC/SDK、DeepSeek Harness profiles。围绕状态持有者、客户端消失后的任务生命周期和集成者必须维护的协议给出条件式判断。

- [ ] **Step 3: 重写 06《扩展越深，升级越痛》**

  对照 Claude Code 分层扩展与插件打包、Codex 的 AGENTS/Skills/MCP/App Server、Pi 进程内 TypeScript extensions、DeepSeek Harness 的 everything-is-a-plugin。明确能改多深、故障半径、兼容责任和预览期风险。

- [ ] **Step 4: 添加三篇裁决表并自审**

  每篇至少四个明确短板；不重复解释上下文、宿主、Skill、MCP、Hook 或插件的通用定义；DeepSeek Harness 的成熟度限制只放在承担判断的句子旁。

- [ ] **Step 5: 验证并提交 04–06**

  Run: `git diff --check -- src/content/posts/agent-theme-04-extension-delegation.md src/content/posts/agent-theme-05-host-runtime.md src/content/posts/agent-theme-06-configuration-operations.md`

  Expected: 无空白错误；不可变 frontmatter 字段未变化。

  Commit paths explicitly with message: `docs: rewrite agent differences 04 to 06`。

### Task 4: 重写多 Agent、完成证明与选型 07–09

**Files:**

- Modify: `src/content/posts/agent-theme-07-memory-background.md`
- Modify: `src/content/posts/agent-theme-08-experience-feedback.md`
- Modify: `src/content/posts/agent-theme-09-a2a-interoperability.md`

**Interfaces:**

- Consumes: Tasks 2–3 的稳定产品定位和责任差异；设计中的 07–09 冲突轴。
- Produces: 三篇关于编排责任、验证责任和最终选型的收束文章。

- [ ] **Step 1: 重写 07《多 Agent 是成品能力还是自建工程》**

  比较 Claude Code 的集成入口、Codex 的任务/审查工作流与集成面、Pi 的扩展自建、DeepSeek Harness 的 provider/transport 组合。逐项指出并行、任务所有权、结果汇合和跨产品调用由谁实现，不解释通用多 Agent 分层。

- [ ] **Step 2: 重写 08《谁最容易证明任务真的完成》**

  对照 Claude Code 工具与 hooks、Codex 运行态反馈与 Harness engineering 取向、Pi 的验证扩展责任、DeepSeek Harness 的事件与 telemetry。说明默认留下的证据、用户必须补的门禁和出现“口头完成”的具体条件。

- [ ] **Step 3: 重写 09《四种 Agent 怎么选：看你愿意承担什么责任》**

  按个人开发者、产品集成团队、内部平台团队和运行时研究者分别给出首选条件与反转条件。所有建议必须回指前八篇的维护、安全、集成、恢复或验证责任；保留 DeepSeek Harness 的预览与安全边界，不做总排名。

- [ ] **Step 4: 添加三篇裁决表并自审**

  每篇至少四个明确短板；07 不把跨产品协议写成内建组织系统，08 不以官方设计自述替代效果证据，09 不重复四份产品简介。

- [ ] **Step 5: 验证并提交 07–09**

  Run: `git diff --check -- src/content/posts/agent-theme-07-memory-background.md src/content/posts/agent-theme-08-experience-feedback.md src/content/posts/agent-theme-09-a2a-interoperability.md`

  Expected: 无空白错误；不可变 frontmatter 字段未变化。

  Commit paths explicitly with message: `docs: rewrite agent differences 07 to 09`。

### Task 5: 执行差异密度与证据边界审查

**Files:**

- Modify if required: all nine `src/content/posts/agent-theme-*.md`
- Create temporarily: `/tmp/codextmp/agent-theme-difference-audit.*`
- Update: `/Users/gaoguobin/Documents/Agent_Harness_Comparison_Research_20260828/defensive-writing-audit.md`

**Interfaces:**

- Consumes: Tasks 2–4 的九篇草稿和证据包。
- Produces: 满足密度指标、没有抬高主张的九篇终稿，以及可复核的审查记录。

- [ ] **Step 1: 运行静态密度审计**

  统计每篇正文汉字数、产品无关段落占比、同时出现至少两个产品的直接比较段落占比、H2 数量、短板关键词、裁决表列名和外链数。预期九篇分别满足 2,200–3,200 字、产品无关不超过 10%、直接比较不少于 35%。

- [ ] **Step 2: 使用 press-conference-revision-evidence-bound 审查**

  逐篇建立贡献与范围契约，标记无证据排名、重复 caveat、方法自证、工作日志叙事、竞争性结论和被埋藏的主判断。真实时间截面、官方与独立证据差异、安全限制和替代解释必须保留。

- [ ] **Step 3: 修订所有失败项**

  删除共性段落；把孤立产品介绍改成同轴对比；把宣传式优势改为来源支持的设计后果；把重复免责声明压缩到首次相关判断旁。任何改句只能维持或降低原主张强度。

- [ ] **Step 4: 运行全系列回归审计**

  确认四个产品在全系列都有证据支持的具体短板；同一定位句没有跨篇原样重复；03、06、07、09 均含 DeepSeek Harness 预览或安全边界；正文不含本地路径、旧源码路径或本站旧文证据。

- [ ] **Step 5: 提交审查修订**

  Run: `git diff --check`

  Expected: 无空白错误；只包含九篇终稿、审查记录和本计划的任务勾选更新。

  Commit article and audit paths explicitly with message: `docs: audit agent difference claims`。

### Task 6: 本地内容、构建与浏览器验证

**Files:**

- Verify: all nine `src/content/posts/agent-theme-*.md`
- Verify: generated `dist/`
- Modify only if an existing assertion is stale because of approved title changes: `scripts/verify-dist.mjs` or matching Playwright test

**Interfaces:**

- Consumes: Task 5 终稿。
- Produces: 通过 schema、单元测试、生产构建、产物断言和浏览器烟测的发布候选提交。

- [ ] **Step 1: 运行内容与类型检查**

  Run: `pnpm check`

  Expected: exit 0，无 Astro content schema 或 TypeScript 错误。

- [ ] **Step 2: 运行单元测试**

  Run: `pnpm test`

  Expected: exit 0，全部 Vitest 用例通过。

- [ ] **Step 3: 构建生产站点并验证产物**

  Run: `pnpm build && pnpm verify:dist`

  Expected: exit 0；Pagefind 索引生成；九个 slug 产物存在且标题与新 frontmatter 一致。

- [ ] **Step 4: 运行浏览器烟测**

  Run: `pnpm test:e2e -- --workers=1`

  Expected: exit 0；首页、文章页、导航和静态资源无回归。

- [ ] **Step 5: 核对发布候选差异并提交**

  Run: `git status --short && git diff --check && git log --oneline -6`

  Expected: 未跟踪用户文件仍未暂存；本轮文章、计划和必要测试修改均已提交。

  Commit only remaining intended paths with message: `docs: finalize agent difference series`。

### Task 7: 推送、等待 Pages 并线上逐页验收

**Files:**

- Publish: committed `master` branch to `origin`
- Verify: nine public URLs derived from the retained slugs

**Interfaces:**

- Consumes: Task 6 已验证提交和用户本轮明确发布授权。
- Produces: 成功的 GitHub Actions Pages 部署、九个线上页面的标题和正文验收结果。

- [ ] **Step 1: 推送明确分支**

  Run: `git push origin master`

  Expected: push succeeds without force and contains only reviewed commits.

- [ ] **Step 2: 监控 Pages 工作流**

  使用 GitHub CLI 查看由该推送触发的 Pages run，等待 build 与 deploy 两个 job 成功；若失败，只诊断并修复与本轮变更直接相关的问题，然后重新运行本地对应检查并追加提交。

- [ ] **Step 3: 验证九个线上 URL**

  对九个保留 slug 逐页检查 HTTP 成功、页面 title、新 H1、裁决表和至少一个关键差异句；确认旧标题未残留在公开页面与 Pagefind 索引中。

- [ ] **Step 4: 核对最终仓库状态**

  Run: `git status --short && git log -1 --oneline`

  Expected: 只剩用户原有未跟踪 `.codebase-memory/`、`AGENTS.md`、`CLAUDE.md`；`HEAD` 已包含在 `origin/master`。

- [ ] **Step 5: 向用户报告发布结果**

  报告最终提交、Pages run、九页线上验证结论、内容密度结果以及任何仍存在但不阻塞发布的限制。
