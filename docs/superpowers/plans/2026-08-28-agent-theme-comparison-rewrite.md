# Agent 主题对比系列重写 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有九篇源码目录式 Agent 对比文章重写为九个读者问题，并在全部验证通过后发布到 GitHub Pages。

**Architecture:** 保留现有九个文件、slug、series 和 order，以三组互不重叠的文章文件并行起草。所有事实从共享研究证据包进入正文，主代理统一定位、引用、frontmatter 和跨篇衔接，再执行证据边界审查、站点构建、CI 与线上逐篇验证。

**Tech Stack:** Astro 5、Markdown content collections、pnpm 9.14.4、Vitest、Playwright、GitHub Actions Pages、公开官方文档与学术来源。

## Global Constraints

- 只把公开文章、论文、官方文档和项目 README 当作事实来源；禁止把本地源码、反编译结果或本站旧文作为证据。
- Claude Code、Codex、Pi、DeepSeek Harness 从第一篇开始进入同一比较单位。
- DeepSeek Harness 必须保留 developer preview、兼容性未稳定、未经安全审计和不能作为唯一安全控制的边界。
- 不做无控制条件下的总排名；涉及性能、成本或安全时必须说明任务、环境、来源和限制。
- 每篇只回答一个读者问题，前 150 个汉字内给答案，正文目标为 2,500–4,000 个汉字。
- 每篇二级标题原则上不超过 7 个；删除源码章节编号、源码路径清单、旧博文前置要求和机械重复的“对比结论/验证动作”。
- 保留文件名、slug、series、order 和原始 published；更新 updated、verified_at、标题、摘要、topics、tags、prerequisites 与 time；删除 source_modules。
- 封面不得在正文重复。只保留与四项目新论点一致的正文图片；三项目或源码章节结构图片必须删除。
- 子代理不得提交、推送或发布。主代理只暂存明确路径，并保护仓库现有 `.codebase-memory/`、`AGENTS.md` 和 `CLAUDE.md` 未跟踪内容。
- 文章完成后必须使用 press-conference-revision-evidence-bound 做整套审查。

---

## File Map

**Design and plan:**

- `docs/superpowers/specs/2026-08-28-agent-theme-comparison-rewrite-design.md`：已批准的内容与发布规格。
- `docs/superpowers/plans/2026-08-28-agent-theme-comparison-rewrite.md`：本实施计划。

**Article group A:**

- `src/content/posts/agent-theme-01-control-plane.md`：Harness 比较单位与系列总论点。
- `src/content/posts/agent-theme-02-message-tool-execution.md`：一次任务的端到端循环。
- `src/content/posts/agent-theme-03-context-security-recovery.md`：沙箱、审批与人工接管。

**Article group B:**

- `src/content/posts/agent-theme-04-extension-delegation.md`：长任务上下文、会话和恢复。
- `src/content/posts/agent-theme-05-host-runtime.md`：CLI、IDE、云端与宿主状态。
- `src/content/posts/agent-theme-06-configuration-operations.md`：扩展层、插件与运行时可替换性。

**Article group C:**

- `src/content/posts/agent-theme-07-memory-background.md`：subagent、团队、workflow 与跨边界协作。
- `src/content/posts/agent-theme-08-experience-feedback.md`：验证、停止条件、Trace、成本与评估。
- `src/content/posts/agent-theme-09-a2a-interoperability.md`：四项目条件式选型总结。

**Evidence package:**

- `/Users/gaoguobin/Documents/Agent_Harness_Comparison_Research_20260828/sources.jsonl`：31 个稳定来源身份。
- `/Users/gaoguobin/Documents/Agent_Harness_Comparison_Research_20260828/evidence.jsonl`：26 条原文证据与定位。
- `/Users/gaoguobin/Documents/Agent_Harness_Comparison_Research_20260828/scope.md`：研究纳入、排除和成功标准。

---

### Task 1: 固定发布前基线与九篇 frontmatter 契约

**Files:**

- Inspect: `src/content/config.ts`
- Inspect: `src/content/posts/agent-theme-01-control-plane.md`
- Inspect: `src/content/posts/agent-theme-09-a2a-interoperability.md`
- Inspect: `src/utils/content-utils.ts`
- Inspect: `scripts/verify-dist.mjs`
- Inspect: `.github/workflows/pages.yml`

**Interfaces:**

- Consumes: 已批准设计文档与站点当前 content schema。
- Produces: 九篇共享的 frontmatter 字段表、首页排序约束、构建与线上 URL 验收清单，供三组起草任务使用。

- [ ] **Step 1: 核对 content schema 与首页排序**

  读取实际 schema、首页文章选择和排序逻辑，记录 `published`、`updated`、`draft`、`image` 等 schema 字段，以及 `series`、`order`、`slug` 等额外 frontmatter 的真实作用。确认首页只按 `published` 倒序、每页 8 篇；保留原始 `published` 意味着九篇不会被重新置顶。

- [ ] **Step 2: 核对当前公开 URL 与产物验证器**

  从九个现有文件名和 Astro 路由规则得出九个目标 URL；读取 `verify-dist.mjs` 和 Playwright 用例，确认构建后需要检查的首页无回归、归档或搜索可发现性、文章 H1、链接和资源断言。

- [ ] **Step 3: 建立九篇 frontmatter 契约**

  为每篇明确新 title、description、tags、topics、prerequisites、time、updated、verified_at，同时列出必须保留字段和必须删除的 `source_modules`。契约只存在实施记录中，不创建新的生产配置。

- [ ] **Step 4: 验证基线工作树**

  Run: `git status -sb`

  Expected: 只看到已知未跟踪 `.codebase-memory/`、`AGENTS.md`、`CLAUDE.md`，以及本计划文件；九篇文章尚未改动。

### Task 2: 并行重写 01–03

**Files:**

- Modify: `src/content/posts/agent-theme-01-control-plane.md`
- Modify: `src/content/posts/agent-theme-02-message-tool-execution.md`
- Modify: `src/content/posts/agent-theme-03-context-security-recovery.md`

**Interfaces:**

- Consumes: Task 1 frontmatter 契约；研究来源 1–13、20–29；设计文档中的文章 01–03 结构。
- Produces: 三篇可独立阅读、包含四项目和即时来源链接的完整 Markdown，新系列总论点供 04–09 沿用。

- [ ] **Step 1: 起草 01《为什么不能只比模型》**

  开头用“同一模型在不同 Harness 中得到不同成本、工具路径与监督负担”的选型困境。引用 Harness 定义论文、Scaffold Effect、AI Harness Engineering，以及四项目官方定位。明确比较单位为“模型 × Harness × 运行环境 × 任务”，结尾给出后续八篇的阅读坐标。

- [ ] **Step 2: 起草 02《一次 Agent 任务怎样跑完》**

  用一个跨文件修复任务贯穿“上下文 → 模型 → 工具 → 反馈 → 验证 → 停止”。分别依据 Claude Code How It Works、Codex agent loop、Pi 作者文章/README、DeepSeek Harness Core 文档说明公开设计。每个项目只写会改变任务结果的 2–3 个差异。

- [ ] **Step 3: 起草 03《Agent 什么时候必须停下来问人》**

  用“Agent 准备执行可能读取凭据并访问网络的命令”作为事故模型。分别比较 OS/容器隔离、sandbox policy、approval 和外部安全边界；引用 Claude Code sandbox/permissions、Codex approvals/security、Pi Security、DeepSeek Harness approval/shell/SAFETY。结尾列出低风险自动执行与必须接管的条件。

- [ ] **Step 4: 组内自检**

  检查三篇是否各自只有一个问题、前 150 字内有答案、四项目均出现、没有源码路径或旧博文引用、DeepSeek Harness 边界完整、每个事实紧邻公开链接。

- [ ] **Step 5: 主代理审阅并提交 01–03**

  Run: `git diff --check -- src/content/posts/agent-theme-0{1,2,3}-*.md`

  Expected: 无空白错误；差异只包含三篇新正文和 frontmatter。

  Commit paths explicitly with message: `docs: rewrite agent comparison 01 to 03`。

### Task 3: 并行重写 04–06

**Files:**

- Modify: `src/content/posts/agent-theme-04-extension-delegation.md`
- Modify: `src/content/posts/agent-theme-05-host-runtime.md`
- Modify: `src/content/posts/agent-theme-06-configuration-operations.md`

**Interfaces:**

- Consumes: Task 1 frontmatter 契约；Task 2 的稳定术语；Anthropic context/long-running materials、Codex App Server、Pi session/extensions、DeepSeek Harness architecture/core/Cordis materials。
- Produces: 三篇关于持续状态、宿主与扩展边界的文章，并为多 Agent 与选型篇提供运行时层次。

- [ ] **Step 1: 起草 04《长任务怎样保持上下文并恢复》**

  用数小时任务在上下文压缩或进程中断后失去约束的场景开篇。比较高信号上下文、显式交接物、session/transcript/event log、resume/fork 与记忆可信度。DeepSeek Harness 重点写 append-only session log；Pi 写 JSONL tree；Claude Code 和 Codex 只写官方资料明确支持的恢复与跨会话机制。

- [ ] **Step 2: 起草 05《CLI、IDE 与云端由谁持有状态》**

  用“同一任务从终端切换 IDE 或云端后能否继续”开篇。比较 Claude Code 产品工作台、Codex Harness/App Server 的 thread/turn/item 与多客户端、Pi 的 TUI/RPC/SDK、DeepSeek Harness 的 profile/plugin tree。明确宿主决定审批入口、会话生命周期和并发，而不是单纯 UI。

- [ ] **Step 3: 起草 06《扩展能力应该装插件还是改运行时》**

  以团队需要加入数据库工具、项目规则和自定义审批为场景。比较 CLAUDE.md/AGENTS.md、skills、hooks、MCP、extensions/provider 和 DeepSeek Harness 的可替换 loop/session/sandbox。解释扩展的插入位置、作用域、生命周期和信任边界，避免功能勾选表。

- [ ] **Step 4: 组内自检**

  检查三篇是否把上下文、宿主和扩展分成三个不同问题；删除与 01–03 重复的通用 loop 解释；所有 Cordis/插件论断标记为公开架构主张而非效果证明。

- [ ] **Step 5: 主代理审阅并提交 04–06**

  Run: `git diff --check -- src/content/posts/agent-theme-0{4,5,6}-*.md`

  Expected: 无空白错误；差异只包含三篇新正文和 frontmatter。

  Commit paths explicitly with message: `docs: rewrite agent comparison 04 to 06`。

### Task 4: 并行重写 07–09

**Files:**

- Modify: `src/content/posts/agent-theme-07-memory-background.md`
- Modify: `src/content/posts/agent-theme-08-experience-feedback.md`
- Modify: `src/content/posts/agent-theme-09-a2a-interoperability.md`

**Interfaces:**

- Consumes: Task 2–3 的稳定定位；Claude/Codex subagent docs、Pi philosophy/extensions、DeepSeek Harness subagent/workflow docs、SWE-agent、OpenHands、VSC-Bench 和 Harness evaluation sources。
- Produces: 多 Agent、完成证明和最终选型三篇收束文章。

- [ ] **Step 1: 起草 07《多 Agent 是委派工具还是组织系统》**

  用主 Agent 同时派出研究、实现和审查任务的场景区分四层：上下文隔离、并行委派、持续团队协作、跨产品互操作。比较四项目的公开能力；DeepSeek Harness 写异构 provider 和受限 workflow。A2A 只用一节说明跨组织边界，不写历史沿革。

- [ ] **Step 2: 起草 08《Agent 如何证明任务真的完成》**

  用“最终回复称已完成，但 UI、测试或性能未验证”开篇。比较测试、静态检查、运行态验证、外部 reviewer、trace、失败归因和停止条件。引用 SWE-agent、OpenHands、VSC-Bench、OpenAI/Anthropic eval 资料；把成功率、token、延迟、重试、无行动回合和人工监督列为结果成本，不生成无数据排名。

- [ ] **Step 3: 起草 09《Claude Code、Codex、Pi、DeepSeek Harness 怎么选》**

  综合前八篇，按任务复杂度、运行位置、隔离责任、定制深度、并行需求、成熟度和监督成本给条件式建议。稳定定位分别是集成式工作台、跨表面的可靠执行层、可塑的最小 Harness、可重组运行时。保留 DeepSeek Harness developer preview 与安全边界，不设总冠军。

- [ ] **Step 4: 组内自检**

  检查 07 不把 A2A 当内部委派通用底座，08 不伪造 benchmark，09 的每项建议都能回指前八篇论据。删除旧 A2A 版本史、生态清单和旧源码结论。

- [ ] **Step 5: 主代理审阅并提交 07–09**

  Run: `git diff --check -- src/content/posts/agent-theme-0{7,8,9}-*.md`

  Expected: 无空白错误；差异只包含三篇新正文和 frontmatter。

  Commit paths explicitly with message: `docs: rewrite agent comparison 07 to 09`。

### Task 5: 跨系列一致性与证据边界审查

**Files:**

- Modify: all nine `src/content/posts/agent-theme-*.md`
- Read: `/Users/gaoguobin/Documents/Agent_Harness_Comparison_Research_20260828/sources.jsonl`
- Read: `/Users/gaoguobin/Documents/Agent_Harness_Comparison_Research_20260828/evidence.jsonl`

**Interfaces:**

- Consumes: Tasks 2–4 的九篇完整草稿。
- Produces: 术语、主张强度、引用和跨篇衔接一致的九篇终稿；证据边界审查记录。

- [ ] **Step 1: 建立贡献与范围契约**

  按 press-conference-revision-evidence-bound 记录核心贡献、四项目定位、最高允许主张、必须保留的成熟度/安全限制、可编辑范围和未决问题。

- [ ] **Step 2: 批量诊断防御性与失焦写法**

  逐篇标记工作日志叙事、方法自证、重复 caveat、功能清单、无必要竞品输赢和被埋藏的核心结论。将真实的时间截面、官方/独立证据差异、安全限制和 rival explanation 标为 KEEP。

- [ ] **Step 3: 集中修订九篇**

  先修订标题、摘要、开头、每节首句和结尾，使问题与答案前置；再压缩重复背景和四项目百科。每个改句执行“同等或更低主张、相同来源状态、相同引用作用”检查。

- [ ] **Step 4: 执行全系列回归**

  检查九篇标题到结尾的主线、四项目稳定定位、术语、日期、数字、链接、引用角色和 DeepSeek Harness 边界。搜索并消除 `source_modules`、`Section 0`、本地路径、旧博文引用和“总冠军”式判断。

- [ ] **Step 5: 内容静态检查**

  Run searches that assert:

  - nine files contain `DeepSeek Harness`；
  - zero files contain `source_modules:`；
  - zero body lines contain `/Users/`、`restored-src`、`codex-rs` or old source-reading links；
  - each file has at most seven H2 headings unless a documented readability exception is justified；
  - each file contains at least four external `https://` source links；
  - no body image repeats its frontmatter cover path。

- [ ] **Step 6: 提交审查修订**

  Run: `git diff --check`

  Expected: 无空白错误；只包含九篇审查修订和本计划的追踪更新。

  Commit article paths explicitly with message: `docs: refine agent comparison evidence boundaries`。

### Task 6: 本地站点验证

**Files:**

- Verify: all nine `src/content/posts/agent-theme-*.md`
- Verify: generated `dist/`
- Modify only if a stale site assertion directly blocks the intended article diff: `scripts/verify-dist.mjs` or an existing Playwright expectation

**Interfaces:**

- Consumes: Task 5 的九篇终稿。
- Produces: schema、测试、生产构建和浏览器烟测全部通过的站点产物。

- [ ] **Step 1: 运行 Astro 内容和类型检查**

  Run: `pnpm check`

  Expected: exit 0；九篇 frontmatter 全部符合 schema，无 Markdown/Astro 诊断。

- [ ] **Step 2: 运行单元测试**

  Run: `pnpm exec vitest run`

  Expected: exit 0；全部测试通过。

- [ ] **Step 3: 创建生产构建**

  Run: `pnpm build`

  Expected: exit 0；九个 slug 均生成 HTML，Pagefind 索引完成。

- [ ] **Step 4: 验证构建产物**

  Run: `pnpm verify:dist`

  Expected: exit 0；首页、文章数量、标题、既有归档路由和必要资源满足验证器。`series/order` 不作为运行时排序断言，因为当前 schema 和页面逻辑不消费这两个字段。

- [ ] **Step 5: 检查九篇生成 HTML**

  对每个目标 HTML 断言：document title 与 frontmatter 一致、正文只有一个 H1、开头答案存在、关键小标题存在、结尾条件式建议存在、外部来源链接可见、旧源码标题和正文封面重复不存在。

- [ ] **Step 6: 运行浏览器端烟测**

  Run: `pnpm exec playwright test --workers=1`

  Expected: exit 0；首页和文章页在生产预览中可访问，无控制台级别的页面结构回归。

### Task 7: 发布预检、提交与 GitHub Pages

**Files:**

- Commit: the nine `src/content/posts/agent-theme-*.md`
- Commit if not already committed: `docs/superpowers/plans/2026-08-28-agent-theme-comparison-rewrite.md`
- Exclude: `.codebase-memory/`, `AGENTS.md`, `CLAUDE.md`

**Interfaces:**

- Consumes: Task 6 通过验证的九篇终稿。
- Produces: 已推送到 `origin/master` 的已知 commit SHA，以及该 SHA 对应的成功 Pages run。

- [ ] **Step 1: 审阅发布差异**

  Run: `git status -sb`, `git diff --stat`, `git diff`, `git diff --check`。

  Expected: 没有无关已跟踪改动；未跟踪用户文件保持未暂存。

- [ ] **Step 2: 提交计划或最后修订**

  明确暂存计划文件和仍未提交的九篇路径。提交信息准确描述重写，不使用 `git add -A`。

- [ ] **Step 3: 推送默认分支**

  Run: `git push origin master`

  Expected: push 成功；记录远端 commit SHA。

- [ ] **Step 4: 等待对应 Pages workflow**

  使用 `gh run list` 找到该 SHA 的 `Deploy Astro site to GitHub Pages` run，再执行 `gh run watch <run-id> --exit-status`。

  Expected: build 与 deploy jobs 均成功；不能用其他 SHA 的绿色 run 证明本次发布。

### Task 8: 线上站点发现性与九篇逐页验证

**Files:**

- Verify only: public homepage and nine public article URLs

**Interfaces:**

- Consumes: Task 7 成功部署的 commit SHA 与公共站点 URL。
- Produces: 首页无回归、归档或搜索发现性和九篇线上内容的最终完成证据。

- [ ] **Step 1: 验证线上首页与系列发现性**

  先截图再检查 DOM。确认首页正常加载且近期文章列表无结构回归；再通过归档或站内搜索找到重写后的系列标题。九篇保留原始 `published`，因此不要求全部出现在首页第一页。

- [ ] **Step 2: 逐篇打开九个公共 URL**

  每篇先截图，再检查最终 URL、document title、唯一 H1、开头答案、至少两个关键小标题、结尾建议和来源链接。确认 404、旧标题、旧源码 Section 和三项目旧图均不存在。

- [ ] **Step 3: 核对发布 SHA 与线上内容**

  将 Pages run 的 head SHA、Git 本地 SHA 与线上文章内容对应起来；记录首页和九篇验证结果。

- [ ] **Step 4: 完成审计**

  按用户目标逐项确认：文章资料已收集；源码/旧博文已排除；DeepSeek Harness 已进入九篇；多个子代理参与；九篇已重写；证据审查已完成；本地验证、Pages CI 和线上逐页验证均有直接证据。只有全部为真才标记目标 complete。
