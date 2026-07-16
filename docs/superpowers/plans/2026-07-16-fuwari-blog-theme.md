# Fuwari Blog Theme Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom Astro journal-magazine UI with the Fuwari Astro blog theme while preserving the site's content, assets, static deployment, and current post URLs.

**Architecture:** Import the upstream Fuwari template as the site's Astro source structure, then configure its site/profile/navigation files and migrate the existing Markdown/MDX posts into Fuwari's content schema. Keep the existing public post images, use Fuwari's Pagefind search and generated archive/category/tag routes, and update the GitHub Pages workflow to the pnpm-based build supplied by Fuwari.

**Tech Stack:** Astro 5.13.x, Svelte 5, Tailwind CSS, Fuwari, Pagefind, pnpm, Markdown/MDX, Vitest, Playwright, GitHub Pages.

---

## File Map

The upstream Fuwari template supplies most of the implementation. The following project-owned files are configured or verified during migration:

- Replace with Fuwari template files: `astro.config.mjs`, `package.json`, `pnpm-lock.yaml`, `src/`, `public/`, `tsconfig.json`, Tailwind/PostCSS config files.
- Configure: `src/config.ts` for site identity, navigation, profile, theme color, favicon, table of contents, and license.
- Migrate: `src/content/posts/*.md` and `src/content/posts/*.mdx` frontmatter and content body.
- Preserve: `public/images/posts/**` and the article image paths referenced by Markdown.
- Modify: `.github/workflows/pages.yml` for pnpm setup, install, build, and Pagefind output.
- Modify: `scripts/verify-dist.mjs` for Fuwari's generated routes and search artifacts.
- Replace obsolete tests: `tests/e2e/homepage.spec.ts` and custom-helper tests that import removed modules.
- Keep and adapt: `tests/unit/post-assets.test.ts` so all migrated inline images remain available.

### Task 1: Import the Fuwari template and establish a clean baseline

**Files:**
- Replace: `src/`, `astro.config.mjs`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `tailwind.config.cjs`, `postcss.config.mjs`
- Modify: `public/` while preserving `public/images/posts/**`
- Remove as obsolete after the template is copied: `package-lock.json`, `src/components/**`, `src/layouts/**`, `src/lib/**`, `src/scripts/**`, `src/styles/**`
- Preserve until Task 5: `vitest.config.ts`, `playwright.config.ts`, and the existing test files.

- [ ] **Step 1: Capture the current post files and public post-image tree**

Run:

```bash
find src/content/posts -maxdepth 1 -type f -print | sort
find public/images/posts -type f -print | sort
```

Expected: five source posts are listed and the existing post image tree is present.

- [ ] **Step 2: Fetch the upstream Fuwari template into a temporary directory**

Run:

```bash
rm -rf /tmp/fuwari-theme-template
git clone --depth 1 https://github.com/saicaca/fuwari.git /tmp/fuwari-theme-template
```

Use the fetched template's current commit as the migration source. Do not copy its `.git` directory or overwrite the repository's `.git` directory.

- [ ] **Step 3: Replace the custom application shell with the template and restore project content assets**

Copy the template's tracked application files into the repository root, excluding `.git`, `.github`, `src/content/posts`, and `public/images/posts`. Preserve the repository's existing `src/content/posts` and `public/images/posts` until the content migration task is complete. Remove the custom components, layouts, helpers, interaction scripts, and styles that are no longer imported by Fuwari.

- [ ] **Step 4: Install the template dependencies using pnpm**

Run:

```bash
pnpm install
```

Expected: a generated `pnpm-lock.yaml` exists and dependency installation succeeds without npm-only lockfile conflicts.

- [ ] **Step 5: Verify the imported template before content migration**

Run:

```bash
pnpm check
```

Expected: the template itself type-checks; any errors should be limited to the intentionally retained old post frontmatter and are recorded for Task 2.

- [ ] **Step 6: Commit the template import**

```bash
git add -A
git commit -m "feat: adopt Fuwari Astro blog theme"
```

### Task 2: Configure site identity, profile, navigation, and deployment URL

**Files:**
- Modify: `src/config.ts`
- Modify: `astro.config.mjs`
- Modify: `public/` favicon/profile assets as needed

- [ ] **Step 1: Configure the site metadata and visual defaults**

Set the Fuwari config to the following values:

```ts
siteConfig.title = "gaoguobin";
siteConfig.subtitle = "写代码、做游戏，也记录一路上的想法";
siteConfig.lang = "zh_CN";
siteConfig.themeColor.hue = 250;
siteConfig.banner.enable = false;
siteConfig.toc.enable = true;
siteConfig.toc.depth = 2;
```

Use `/images/avatar.gif` for the profile avatar and use an existing SVG/PNG favicon from `public/images` rather than introducing a new generated image.

- [ ] **Step 2: Configure navigation and profile links**

Use Home, Archive, About, and an external GitHub link to `https://github.com/TaurusGGBOY/TaurusGGBOY.github.io`. Set the profile name to `gaoguobin`. Keep the bio concise and content-focused: `记录软件、游戏实验和一路上的学习。` Do not add placeholder social accounts.

- [ ] **Step 3: Set Astro static deployment configuration**

Set `astro.config.mjs` to preserve:

```js
site: "https://taurusggboy.github.io",
base: "/",
trailingSlash: "always",
```

Keep the Fuwari integrations and Markdown plugins intact, including sitemap, Svelte, Tailwind, Swup, Expressive Code, and Pagefind's postbuild command.

- [ ] **Step 4: Commit the site configuration**

```bash
git add src/config.ts astro.config.mjs public
git commit -m "feat: configure Fuwari for gaoguobin blog"
```

### Task 3: Migrate all posts to Fuwari's content schema

**Files:**
- Modify: `src/content/config.ts`
- Modify: `package.json` and `pnpm-lock.yaml` to make the existing Vitest test command available after the Fuwari template import
- Modify: `src/content/posts/backend-project-notes.mdx`
- Modify: `src/content/posts/building-a-blog.md`
- Modify: `src/content/posts/claude-code-source-reading-00.md`
- Modify: `src/content/posts/final-fantasy-seven-reset.mdx`
- Modify: `src/content/posts/playmaker-bullet-shooting.mdx`

- [ ] **Step 1: Add a frontmatter validation test before changing the posts**

Create `tests/unit/fuwari-content.test.ts` that reads each file in `src/content/posts` and asserts every post has `title`, `published`, `description`, `tags`, `category`, and `draft` frontmatter keys. The test must also assert that no post still contains the old keys `date`, `summary`, `featured`, or `readTime`.

If the imported Fuwari package no longer includes Vitest, add the existing repository's `vitest` dev dependency and retain the `test` script before running this test; Task 5 will complete the Playwright/test-script alignment.

- [ ] **Step 2: Run the new validation test and confirm the expected failure**

Run:

```bash
pnpm exec vitest run tests/unit/fuwari-content.test.ts
```

Expected: the test fails because the current posts still use `date` and `summary`.

- [ ] **Step 3: Migrate the frontmatter without changing article bodies**

For every post, apply this exact mapping:

```yaml
title: copy the current title value
published: copy the current date value
description: copy the current summary value
tags: copy the current tags array
category: use the category table below
draft: false
```

Use these categories:

```text
backend-project-notes          Backend
building-a-blog                Web
claude-code-source-reading-00  AI / Security
final-fantasy-seven-reset      Game
playmaker-bullet-shooting      Game Development
```

Remove `featured` and `readTime`; Fuwari derives reading time and does not use the old custom homepage's featured flag. Do not alter the Markdown/MDX body text or existing `/images/posts/...` references. Add `lang: zh_CN` only when required by the installed Fuwari schema; otherwise rely on the site-level language.

- [ ] **Step 4: Run content validation and Astro checks**

Run:

```bash
pnpm exec vitest run tests/unit/fuwari-content.test.ts
pnpm check
```

Expected: the new frontmatter test passes and Fuwari's content collection validates all five posts.

- [ ] **Step 5: Commit the content migration**

```bash
git add src/content/config.ts src/content/posts tests/unit/fuwari-content.test.ts
git commit -m "feat: migrate posts to Fuwari content schema"
```

### Task 4: Preserve assets and generated route compatibility

**Files:**
- Modify: `scripts/verify-dist.mjs`
- Modify: `tests/unit/post-assets.test.ts`
- Add: compatibility redirect pages only for legacy routes confirmed by the route check

- [ ] **Step 1: Update the distribution verification targets**

Replace the old custom-theme expectations with these required artifacts:

```js
const requiredPaths = [
  "index.html",
  "archive/index.html",
  "about/index.html",
  "posts/backend-project-notes/index.html",
  "posts/claude-code-source-reading-00/index.html",
  "tags/backend/index.html",
  "categories/backend/index.html",
];
```

Also assert that `dist/pagefind/pagefind.js` exists after the Fuwari postbuild step and that `dist/images/posts/backend-project-notes/20200302095416.png` exists.

- [ ] **Step 2: Keep the post asset test focused on migrated content**

Keep the existing external-image safety assertions and verify every Markdown reference matching `/images/posts/**` exists under `public/images/posts/**`. Update only the expected count if the Fuwari import or content migration changes the number of references; do not remove the path existence checks.

- [ ] **Step 3: Build and inspect generated routes**

Run:

```bash
pnpm build
node scripts/verify-dist.mjs
```

Expected: Astro generates all required post/archive/category/tag artifacts and Pagefind output. If Fuwari uses a different category URL convention, update the verification target to the actual generated convention and add the equivalent assertion; do not weaken the route check.

- [ ] **Step 4: Add redirects only for confirmed broken legacy URLs**

Compare the current generated URLs with the Fuwari output. If `/topics/web/` or `/archive/#writing` are part of the supported existing links, add static redirect pages or equivalent Astro routes. Do not add broad wildcard redirects without a confirmed source URL.

- [ ] **Step 5: Commit asset and route verification changes**

```bash
git add scripts/verify-dist.mjs tests/unit/post-assets.test.ts src/pages
git commit -m "test: verify Fuwari routes and post assets"
```

### Task 5: Update tests and GitHub Pages workflow

**Files:**
- Modify: `.github/workflows/pages.yml`
- Modify: `vitest.config.ts` and `playwright.config.ts`
- Modify: `src/content/spec/about.md` to remove the imported Fuwari demo copy
- Replace: `tests/e2e/homepage.spec.ts` with Fuwari smoke coverage
- Remove: `tests/unit/posts.test.ts`, `tests/unit/queue.test.ts`, `tests/unit/home-interactions.test.ts` when their imported custom modules are removed
- Modify: `package.json` to retain Vitest, Playwright, and the repository's test scripts alongside Fuwari's scripts

- [ ] **Step 1: Replace obsolete custom interaction assertions**

Remove assertions for the custom reading queue, preview drawer, contact modal, topic filter buttons, and `Recent writing` heading. Keep the existing Playwright setup, change its web-server command to `pnpm dev -- --port 4321`, and add a smoke test that starts the site with the configured dev server and verifies:

```text
GET /                              -> 200 and contains gaoguobin
GET /archive/                      -> 200
GET /about/                        -> 200
GET /posts/backend-project-notes/  -> 200 and contains the Chinese title
GET /tags/backend/                 -> 200
```

Keep mobile navigation and light/dark theme checks using Fuwari's stable accessible controls.

- [ ] **Step 2: Switch GitHub Actions to pnpm**

Update `.github/workflows/pages.yml` to use Node 20, `pnpm/action-setup@v4` with the package manager version from `package.json`, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm exec vitest run`, and `pnpm exec playwright test`. Keep the existing Pages permissions, artifact upload, deployment job, and `dist` artifact path.

Replace the template's demo About content with a short gaoguobin introduction and keep it free of Fuwari placeholder text.

- [ ] **Step 3: Run the complete local verification suite**

Run:

```bash
pnpm check
pnpm exec vitest run
pnpm exec playwright test
pnpm build
node scripts/verify-dist.mjs
```

Expected: all checks pass, the static build contains Pagefind output, and the route verifier reports all required artifacts.

- [ ] **Step 4: Commit the test and workflow migration**

```bash
git add .github/workflows/pages.yml package.json tests
git commit -m "ci: verify and deploy Fuwari site with pnpm"
```

### Task 6: Production preview and final review

**Files:**
- Modify only files required by findings from the verification steps above.

- [ ] **Step 1: Start a production preview**

Run:

```bash
pnpm preview --host 127.0.0.1
```

Inspect the homepage, archive, one technical post, one game post, search, category/tag pages, mobile layout, theme switcher, and table of contents in a browser.

- [ ] **Step 2: Check content and links**

Confirm all five migrated posts render, inline images load, no placeholder Fuwari text remains, navigation links point to gaoguobin content, and no custom-magazine-only UI remains.

- [ ] **Step 3: Run final checks and review the diff**

Run:

```bash
pnpm check
pnpm exec vitest run
pnpm build
node scripts/verify-dist.mjs
git diff master^..HEAD --stat
git status --short
```

Expected: checks pass, the working tree is clean, and the diff contains only the Fuwari migration plus its tests, configuration, deployment, and documentation.

- [ ] **Step 4: Commit any final verification-only fixes**

```bash
git add -A
git commit -m "chore: finalize Fuwari theme migration"
```
