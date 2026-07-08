# Astro Personal Journal Magazine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generated Hexo/NexT homepage with a source-managed Astro personal journal magazine that has real routes, testable content helpers, and realistic homepage interactions.

**Architecture:** Build a static Astro site with content collections for posts, small focused Astro components for layout, and one progressive TypeScript interaction script for homepage operations. Keep behavior backend-free: search, topic filters, preview drawer, queue state, and contact modal all run in the browser and are verified with Playwright.

**Tech Stack:** Astro, TypeScript, MDX, Vitest, Playwright, Testing Library DOM helpers where useful, static output for GitHub Pages.

---

## File Structure

Create these files:

- `package.json`: scripts and dependencies.
- `astro.config.mjs`: Astro config with MDX and static output.
- `tsconfig.json`: TypeScript config extending Astro defaults.
- `vitest.config.ts`: Vitest config.
- `playwright.config.ts`: Playwright config that runs the Astro dev server.
- `.gitignore`: ignore dependencies, build output, Playwright reports, and brainstorming artifacts.
- `src/content.config.ts`: Astro content collection schema.
- `src/content/posts/*.mdx`: initial migrated posts used by homepage, routes, and tests.
- `src/lib/posts.ts`: post view model types and pure helpers for sorting, topics, filtering, and search.
- `src/lib/queue.ts`: pure queue serialization helpers.
- `src/styles/global.css`: site-wide visual system.
- `src/layouts/BaseLayout.astro`: shared document shell.
- `src/components/SiteNav.astro`: restrained nav and search trigger.
- `src/components/FeaturedStory.astro`: lead story and two highlighted posts.
- `src/components/PostCard.astro`: repeated article card.
- `src/components/TopicFilter.astro`: topic chips and reset control.
- `src/components/SearchOverlay.astro`: accessible search overlay.
- `src/components/PreviewDrawer.astro`: article preview drawer.
- `src/components/ReadingQueue.astro`: visible queue counter.
- `src/components/CurrentFocus.astro`: personal context rail and contact CTA.
- `src/pages/index.astro`: homepage.
- `src/pages/archive.astro`: archive page.
- `src/pages/about.astro`: about page.
- `src/pages/topics/[topic].astro`: topic pages.
- `src/pages/posts/[slug].astro`: post pages.
- `src/scripts/home-interactions.ts`: browser behavior for homepage operations.
- `tests/unit/posts.test.ts`: post helper tests.
- `tests/unit/queue.test.ts`: queue helper tests.
- `tests/e2e/homepage.spec.ts`: Playwright visitor workflow tests.

Modify these files:

- Remove or stop depending on current generated `index.html`, `css/`, `js/`, `lib/`, generated archive/tag/category pages as implementation proceeds. Deletion belongs in the final cleanup task after Astro output is verified.

Do not commit `.superpowers/brainstorm/**`.

---

### Task 1: Scaffold Astro Project and Tooling

**Files:**
- Create: `package.json`
- Create: `astro.config.mjs`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Write project manifest**

Create `package.json` with:

```json
{
  "name": "taurusggboy-github-io",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev --host 127.0.0.1",
    "build": "astro check && astro build",
    "preview": "astro preview --host 127.0.0.1",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@astrojs/check": "^0.9.4",
    "@astrojs/mdx": "^4.0.0",
    "astro": "^5.0.0",
    "typescript": "^5.6.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Add Astro config**

Create `astro.config.mjs` with:

```js
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";

export default defineConfig({
  site: "https://taurusggboy.github.io",
  output: "static",
  integrations: [mdx()],
});
```

- [ ] **Step 3: Add TypeScript and test configs**

Create `tsconfig.json` with:

```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  }
}
```

Create `vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
```

Create `playwright.config.ts` with:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:4321",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev -- --port 4321",
    url: "http://127.0.0.1:4321",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"] } }
  ],
});
```

- [ ] **Step 4: Add ignore rules**

Create `.gitignore` with:

```gitignore
node_modules/
dist/
.astro/
playwright-report/
test-results/
.superpowers/
```

- [ ] **Step 5: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and npm exits with code 0.

- [ ] **Step 6: Verify base tooling fails only because source is absent**

Run:

```bash
npm run test
```

Expected: Vitest exits successfully with no tests found or reports no matching tests, depending on the installed Vitest behavior. If it exits nonzero because no tests exist, continue; tests are added in Task 2.

- [ ] **Step 7: Commit scaffold**

Run:

```bash
git add package.json package-lock.json astro.config.mjs tsconfig.json vitest.config.ts playwright.config.ts .gitignore
git commit -m "chore: scaffold Astro site tooling"
```

---

### Task 2: Add Content Collection and Initial Posts

**Files:**
- Create: `src/content.config.ts`
- Create: `src/content/posts/building-a-blog.md`
- Create: `src/content/posts/playmaker-bullet-shooting.mdx`
- Create: `src/content/posts/backend-project-notes.mdx`
- Create: `src/content/posts/final-fantasy-seven-reset.mdx`

- [ ] **Step 1: Define the post schema**

Create `src/content.config.ts` with:

```ts
import { defineCollection, z } from "astro:content";

const posts = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    summary: z.string(),
    tags: z.array(z.string()).default([]),
    featured: z.boolean().default(false),
    readTime: z.string(),
    cover: z.string().optional(),
    coverAlt: z.string().optional(),
  }),
});

export const collections = { posts };
```

- [ ] **Step 2: Add migrated post content**

Create `src/content/posts/building-a-blog.md` with:

```md
---
title: "造轮子第一步：自己搭建博客"
date: "2019-05-02"
summary: "Notes from rebuilding a personal blog from the ground up, including theme choices, static publishing, and the tradeoffs of owning the site."
tags: ["blog", "hexo", "frontend"]
featured: true
readTime: "4 min read"
---

The original blog started as an experiment in owning the publishing surface. This migrated note keeps that spirit but moves the implementation into a maintainable Astro source tree.
```

Create `src/content/posts/playmaker-bullet-shooting.mdx` with:

```mdx
---
title: "使用 Playmaker 实现简单的子弹射击"
date: "2019-06-12"
summary: "A Unity and Playmaker experiment that models a small gameplay mechanic and records the implementation path."
tags: ["unity", "game", "playmaker"]
featured: true
readTime: "5 min read"
---

This post records a small interaction design problem: turning input into a visible projectile behavior. The new site treats posts like this as technical field notes.
```

Create `src/content/posts/backend-project-notes.mdx` with:

```mdx
---
title: "Web 乱序 1：怎么打开一个后端项目"
date: "2020-04-17"
summary: "Practical notes about opening, reading, and orienting around an unfamiliar backend project."
tags: ["backend", "web", "notes"]
featured: false
readTime: "6 min read"
---

Opening a backend project is mostly an orientation problem: identify the runtime, entrypoints, dependencies, configuration, and test surface before changing behavior.
```

Create `src/content/posts/final-fantasy-seven-reset.mdx` with:

```mdx
---
title: "为什么重置的是 FF7"
date: "2020-04-17"
summary: "A short reflection on Final Fantasy VII, nostalgia, and why some games remain technically and emotionally interesting."
tags: ["game", "FF7", "essay"]
featured: false
readTime: "3 min read"
---

Some games become durable reference points. This note keeps the archive alive while giving the redesigned homepage a broader editorial range.
```

- [ ] **Step 3: Run Astro check**

Run:

```bash
npm run build
```

Expected: This may fail because pages are not created yet. Accept only failures that say no pages or missing source entrypoints. Fix schema syntax errors immediately before continuing.

- [ ] **Step 4: Commit content model**

Run:

```bash
git add src/content.config.ts src/content/posts
git commit -m "feat: add Astro post content collection"
```

---

### Task 3: Build and Test Post Helpers

**Files:**
- Create: `src/lib/posts.ts`
- Create: `tests/unit/posts.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `tests/unit/posts.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import {
  filterPostsByTopic,
  getSortedPosts,
  getTopics,
  searchPosts,
  type PostSummary,
} from "../../src/lib/posts";

const posts: PostSummary[] = [
  {
    slug: "older-featured",
    title: "Older Featured",
    date: new Date("2020-01-01"),
    summary: "A featured post about Unity experiments.",
    tags: ["unity", "game"],
    featured: true,
    readTime: "4 min read",
    href: "/posts/older-featured/",
  },
  {
    slug: "newer-note",
    title: "Backend Notes",
    date: new Date("2022-03-04"),
    summary: "Reading a web backend project.",
    tags: ["backend", "web"],
    featured: false,
    readTime: "5 min read",
    href: "/posts/newer-note/",
  },
  {
    slug: "newest-featured",
    title: "Newest Featured",
    date: new Date("2023-08-09"),
    summary: "A featured frontend post.",
    tags: ["frontend", "web"],
    featured: true,
    readTime: "3 min read",
    href: "/posts/newest-featured/",
  },
];

describe("post helpers", () => {
  it("sorts featured posts first, then newest first", () => {
    expect(getSortedPosts(posts).map((post) => post.slug)).toEqual([
      "newest-featured",
      "older-featured",
      "newer-note",
    ]);
  });

  it("extracts unique topics with counts sorted by count then name", () => {
    expect(getTopics(posts)).toEqual([
      { name: "web", count: 2 },
      { name: "backend", count: 1 },
      { name: "frontend", count: 1 },
      { name: "game", count: 1 },
      { name: "unity", count: 1 },
    ]);
  });

  it("filters posts by topic case-insensitively", () => {
    expect(filterPostsByTopic(posts, "WEB").map((post) => post.slug)).toEqual([
      "newer-note",
      "newest-featured",
    ]);
  });

  it("searches title, summary, and tags case-insensitively", () => {
    expect(searchPosts(posts, "unity").map((post) => post.slug)).toEqual([
      "older-featured",
    ]);
    expect(searchPosts(posts, "backend").map((post) => post.slug)).toEqual([
      "newer-note",
    ]);
    expect(searchPosts(posts, "featured frontend").map((post) => post.slug)).toEqual([
      "newest-featured",
    ]);
  });

  it("returns all posts for blank search", () => {
    expect(searchPosts(posts, "   ")).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm run test -- tests/unit/posts.test.ts
```

Expected: FAIL because `src/lib/posts.ts` does not exist.

- [ ] **Step 3: Implement post helpers**

Create `src/lib/posts.ts` with:

```ts
export type PostSummary = {
  slug: string;
  title: string;
  date: Date;
  summary: string;
  tags: string[];
  featured: boolean;
  readTime: string;
  href: string;
};

export type TopicSummary = {
  name: string;
  count: number;
};

export function getSortedPosts(posts: PostSummary[]): PostSummary[] {
  return [...posts].sort((left, right) => {
    if (left.featured !== right.featured) {
      return left.featured ? -1 : 1;
    }

    return right.date.getTime() - left.date.getTime();
  });
}

export function getTopics(posts: PostSummary[]): TopicSummary[] {
  const counts = new Map<string, number>();

  for (const post of posts) {
    for (const tag of post.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

export function filterPostsByTopic(posts: PostSummary[], topic: string): PostSummary[] {
  const normalizedTopic = topic.trim().toLocaleLowerCase();
  if (!normalizedTopic) {
    return posts;
  }

  return posts.filter((post) =>
    post.tags.some((tag) => tag.toLocaleLowerCase() === normalizedTopic),
  );
}

export function searchPosts(posts: PostSummary[], query: string): PostSummary[] {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) {
    return posts;
  }

  return posts.filter((post) => {
    const haystack = [
      post.title,
      post.summary,
      post.tags.join(" "),
    ].join(" ").toLocaleLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
npm run test -- tests/unit/posts.test.ts
```

Expected: PASS for all post helper tests.

- [ ] **Step 5: Commit post helpers**

Run:

```bash
git add src/lib/posts.ts tests/unit/posts.test.ts
git commit -m "feat: add post query helpers"
```

---

### Task 4: Build and Test Queue Helpers

**Files:**
- Create: `src/lib/queue.ts`
- Create: `tests/unit/queue.test.ts`

- [ ] **Step 1: Write failing queue tests**

Create `tests/unit/queue.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import {
  addQueuedSlug,
  deserializeQueuedSlugs,
  removeQueuedSlug,
  serializeQueuedSlugs,
} from "../../src/lib/queue";

describe("queue helpers", () => {
  it("serializes unique slugs in insertion order", () => {
    expect(serializeQueuedSlugs(["alpha", "beta", "alpha"])).toBe("[\"alpha\",\"beta\"]");
  });

  it("deserializes valid queue JSON", () => {
    expect(deserializeQueuedSlugs("[\"alpha\",\"beta\"]")).toEqual(["alpha", "beta"]);
  });

  it("returns an empty queue for invalid or unsafe JSON", () => {
    expect(deserializeQueuedSlugs("not-json")).toEqual([]);
    expect(deserializeQueuedSlugs("{\"slug\":\"alpha\"}")).toEqual([]);
    expect(deserializeQueuedSlugs("[\"alpha\", 42]")).toEqual([]);
  });

  it("adds a slug only once", () => {
    expect(addQueuedSlug(["alpha"], "beta")).toEqual(["alpha", "beta"]);
    expect(addQueuedSlug(["alpha"], "alpha")).toEqual(["alpha"]);
  });

  it("removes a slug", () => {
    expect(removeQueuedSlug(["alpha", "beta"], "alpha")).toEqual(["beta"]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm run test -- tests/unit/queue.test.ts
```

Expected: FAIL because `src/lib/queue.ts` does not exist.

- [ ] **Step 3: Implement queue helpers**

Create `src/lib/queue.ts` with:

```ts
export const QUEUE_STORAGE_KEY = "gaoguobin-reading-queue";

export function serializeQueuedSlugs(slugs: string[]): string {
  return JSON.stringify(uniqueSafeSlugs(slugs));
}

export function deserializeQueuedSlugs(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      return [];
    }

    return uniqueSafeSlugs(parsed);
  } catch {
    return [];
  }
}

export function addQueuedSlug(slugs: string[], slug: string): string[] {
  return uniqueSafeSlugs([...slugs, slug]);
}

export function removeQueuedSlug(slugs: string[], slug: string): string[] {
  return uniqueSafeSlugs(slugs).filter((item) => item !== slug);
}

function uniqueSafeSlugs(slugs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const slug of slugs) {
    const normalized = slug.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}
```

- [ ] **Step 4: Run all unit tests**

Run:

```bash
npm run test
```

Expected: PASS for `posts.test.ts` and `queue.test.ts`.

- [ ] **Step 5: Commit queue helpers**

Run:

```bash
git add src/lib/queue.ts tests/unit/queue.test.ts
git commit -m "feat: add reading queue helpers"
```

---

### Task 5: Create Layout, Global Styles, and Static Components

**Files:**
- Create: `src/styles/global.css`
- Create: `src/layouts/BaseLayout.astro`
- Create: `src/components/SiteNav.astro`
- Create: `src/components/PostCard.astro`
- Create: `src/components/ReadingQueue.astro`
- Create: `src/components/CurrentFocus.astro`

- [ ] **Step 1: Create global styles**

Create `src/styles/global.css` with:

```css
:root {
  color-scheme: light;
  --bg: #f7f4ef;
  --surface: #ffffff;
  --surface-muted: #ece7df;
  --text: #1c1f23;
  --muted: #626a73;
  --line: #d8d0c5;
  --accent: #0b6b73;
  --accent-strong: #084f56;
  --focus: #b83b5e;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  line-height: 1.55;
}

a {
  color: inherit;
  text-decoration-thickness: 0.08em;
  text-underline-offset: 0.18em;
}

button,
input,
textarea {
  font: inherit;
}

button {
  cursor: pointer;
}

.page-shell {
  min-height: 100vh;
}

.site-header {
  border-bottom: 1px solid var(--line);
  background: rgba(247, 244, 239, 0.94);
  position: sticky;
  top: 0;
  z-index: 20;
  backdrop-filter: blur(12px);
}

.site-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  width: min(1180px, calc(100% - 32px));
  min-height: 64px;
  margin: 0 auto;
}

.brand {
  font-weight: 750;
  letter-spacing: 0;
  text-decoration: none;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 18px;
}

.nav-links a,
.icon-button {
  border: 0;
  background: transparent;
  color: var(--muted);
  text-decoration: none;
}

.nav-links a[aria-current="page"] {
  color: var(--text);
  font-weight: 700;
}

.icon-button {
  min-width: 40px;
  min-height: 40px;
  border-radius: 8px;
}

.icon-button:hover,
.icon-button:focus-visible {
  background: var(--surface-muted);
  color: var(--text);
}

.main-wrap {
  width: min(1180px, calc(100% - 32px));
  margin: 0 auto;
  padding: 40px 0 64px;
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  padding: 0 14px;
  text-decoration: none;
}

.button.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #ffffff;
}

.post-card {
  display: grid;
  gap: 12px;
  border-top: 1px solid var(--line);
  padding: 18px 0;
}

.post-card h3 {
  margin: 0;
  font-size: 1.1rem;
}

.meta,
.muted {
  color: var(--muted);
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 4px 9px;
  color: var(--muted);
  font-size: 0.86rem;
}

@media (max-width: 760px) {
  .site-nav {
    align-items: flex-start;
    flex-direction: column;
    padding: 14px 0;
  }

  .nav-links {
    width: 100%;
    overflow-x: auto;
    padding-bottom: 4px;
  }
}
```

- [ ] **Step 2: Create shared layout**

Create `src/layouts/BaseLayout.astro` with:

```astro
---
import "../styles/global.css";
import SiteNav from "../components/SiteNav.astro";

interface Props {
  title: string;
  description?: string;
  activePath?: string;
}

const {
  title,
  description = "gaoguobin's personal journal magazine: writing, projects, and technical notes.",
  activePath = Astro.url.pathname,
} = Astro.props;
---

<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content={description} />
    <title>{title}</title>
  </head>
  <body>
    <div class="page-shell">
      <SiteNav activePath={activePath} />
      <main class="main-wrap">
        <slot />
      </main>
    </div>
  </body>
</html>
```

- [ ] **Step 3: Create nav component**

Create `src/components/SiteNav.astro` with:

```astro
---
interface Props {
  activePath: string;
}

const { activePath } = Astro.props;
const links = [
  { href: "/", label: "Home" },
  { href: "/archive/", label: "Writing" },
  { href: "/topics/web/", label: "Topics" },
  { href: "/archive/", label: "Archive" },
  { href: "/about/", label: "About" },
];

function isActive(href: string) {
  if (href === "/") {
    return activePath === "/";
  }

  return activePath.startsWith(href);
}
---

<header class="site-header">
  <nav class="site-nav" aria-label="Primary navigation">
    <a class="brand" href="/">gaoguobin</a>
    <div class="nav-links">
      {links.map((link) => (
        <a href={link.href} aria-current={isActive(link.href) ? "page" : undefined}>
          {link.label}
        </a>
      ))}
      <button class="icon-button" type="button" data-search-open aria-label="Open search">⌕</button>
    </div>
  </nav>
</header>
```

- [ ] **Step 4: Create repeated static components**

Create `src/components/PostCard.astro` with:

```astro
---
import type { PostSummary } from "../lib/posts";

interface Props {
  post: PostSummary;
}

const { post } = Astro.props;
---

<article class="post-card" data-post-card data-tags={post.tags.join(",")} data-slug={post.slug}>
  <div class="meta">
    <time datetime={post.date.toISOString()}>{post.date.toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" })}</time>
    <span> · {post.readTime}</span>
  </div>
  <h3><a href={post.href}>{post.title}</a></h3>
  <p>{post.summary}</p>
  <div class="tag-row">
    {post.tags.map((tag) => <span class="tag">{tag}</span>)}
  </div>
  <div>
    <a class="button primary" href={post.href}>Read article</a>
    <button class="button" type="button" data-preview-open={post.slug}>Preview</button>
  </div>
</article>
```

Create `src/components/ReadingQueue.astro` with:

```astro
<section aria-label="Reading queue">
  <h2>Reading queue</h2>
  <p class="muted"><span data-queue-count>0</span> saved for later</p>
</section>
```

Create `src/components/CurrentFocus.astro` with:

```astro
<aside class="focus-rail" aria-label="Current focus">
  <section>
    <h2>Current focus</h2>
    <p>Writing about web projects, game experiments, and the small decisions that make software easier to understand.</p>
  </section>
  <section>
    <h2>Home base</h2>
    <p class="muted">A personal journal magazine for technical notes and experiments.</p>
    <button class="button" type="button" data-contact-open>Contact</button>
  </section>
</aside>
```

- [ ] **Step 5: Run Astro check**

Run:

```bash
npm run build
```

Expected: It may fail because pages are still missing. Fix component syntax errors before continuing.

- [ ] **Step 6: Commit layout components**

Run:

```bash
git add src/styles/global.css src/layouts src/components
git commit -m "feat: add Astro layout components"
```

---

### Task 6: Create Homepage and Interactive Shell Components

**Files:**
- Create: `src/components/FeaturedStory.astro`
- Create: `src/components/TopicFilter.astro`
- Create: `src/components/SearchOverlay.astro`
- Create: `src/components/PreviewDrawer.astro`
- Create: `src/pages/index.astro`

- [ ] **Step 1: Create featured story component**

Create `src/components/FeaturedStory.astro` with:

```astro
---
import type { PostSummary } from "../lib/posts";

interface Props {
  lead: PostSummary;
  highlights: PostSummary[];
}

const { lead, highlights } = Astro.props;
---

<section class="featured-grid" aria-label="Featured writing">
  <article class="lead-story" data-post-card data-tags={lead.tags.join(",")} data-slug={lead.slug}>
    <p class="meta">Featured · {lead.readTime}</p>
    <h1><a href={lead.href}>{lead.title}</a></h1>
    <p>{lead.summary}</p>
    <div class="tag-row">
      {lead.tags.map((tag) => <span class="tag">{tag}</span>)}
    </div>
    <div>
      <a class="button primary" href={lead.href}>Read article</a>
      <button class="button" type="button" data-preview-open={lead.slug}>Preview</button>
    </div>
  </article>
  <div class="highlight-stack">
    {highlights.map((post) => (
      <article data-post-card data-tags={post.tags.join(",")} data-slug={post.slug}>
        <p class="meta">{post.readTime}</p>
        <h2><a href={post.href}>{post.title}</a></h2>
        <p>{post.summary}</p>
        <button class="button" type="button" data-preview-open={post.slug}>Preview</button>
      </article>
    ))}
  </div>
</section>
```

- [ ] **Step 2: Create topic filter component**

Create `src/components/TopicFilter.astro` with:

```astro
---
import type { TopicSummary } from "../lib/posts";

interface Props {
  topics: TopicSummary[];
}

const { topics } = Astro.props;
---

<section aria-label="Topics">
  <h2>Topics</h2>
  <div class="tag-row" data-topic-filter>
    <button class="button" type="button" data-topic-reset>All</button>
    {topics.map((topic) => (
      <button class="button" type="button" data-topic={topic.name}>
        {topic.name} <span class="muted">({topic.count})</span>
      </button>
    ))}
  </div>
</section>
```

- [ ] **Step 3: Create search and preview shells**

Create `src/components/SearchOverlay.astro` with:

```astro
---
import type { PostSummary } from "../lib/posts";

interface Props {
  posts: PostSummary[];
}

const { posts } = Astro.props;
---

<div class="overlay" data-search-overlay hidden>
  <div class="overlay-panel" role="dialog" aria-modal="true" aria-labelledby="search-title">
    <div class="dialog-head">
      <h2 id="search-title">Search writing</h2>
      <button class="icon-button" type="button" data-search-close aria-label="Close search">×</button>
    </div>
    <input data-search-input type="search" placeholder="Search by title, summary, or tag" aria-label="Search posts" />
    <div data-search-results>
      {posts.map((post) => (
        <a class="search-result" href={post.href} data-search-result data-search-text={`${post.title} ${post.summary} ${post.tags.join(" ")}`.toLocaleLowerCase()}>
          <strong>{post.title}</strong>
          <span>{post.summary}</span>
        </a>
      ))}
    </div>
  </div>
</div>
```

Create `src/components/PreviewDrawer.astro` with:

```astro
---
import type { PostSummary } from "../lib/posts";

interface Props {
  posts: PostSummary[];
}

const { posts } = Astro.props;
---

<aside class="drawer" data-preview-drawer hidden aria-label="Article preview">
  <button class="icon-button" type="button" data-preview-close aria-label="Close preview">×</button>
  {posts.map((post) => (
    <article data-preview-panel={post.slug} hidden>
      <p class="meta">{post.date.toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" })} · {post.readTime}</p>
      <h2>{post.title}</h2>
      <p>{post.summary}</p>
      <div class="tag-row">
        {post.tags.map((tag) => <span class="tag">{tag}</span>)}
      </div>
      <a class="button primary" href={post.href}>Read article</a>
      <button class="button" type="button" data-queue-add={post.slug}>Add to queue</button>
    </article>
  ))}
</aside>
```

- [ ] **Step 4: Create homepage**

Create `src/pages/index.astro` with:

```astro
---
import { getCollection } from "astro:content";
import BaseLayout from "../layouts/BaseLayout.astro";
import CurrentFocus from "../components/CurrentFocus.astro";
import FeaturedStory from "../components/FeaturedStory.astro";
import PostCard from "../components/PostCard.astro";
import PreviewDrawer from "../components/PreviewDrawer.astro";
import ReadingQueue from "../components/ReadingQueue.astro";
import SearchOverlay from "../components/SearchOverlay.astro";
import TopicFilter from "../components/TopicFilter.astro";
import { getSortedPosts, getTopics, type PostSummary } from "../lib/posts";

const entries = await getCollection("posts");
const posts: PostSummary[] = entries.map((entry) => ({
  slug: entry.slug,
  title: entry.data.title,
  date: entry.data.date,
  summary: entry.data.summary,
  tags: entry.data.tags,
  featured: entry.data.featured,
  readTime: entry.data.readTime,
  href: `/posts/${entry.slug}/`,
}));

const sortedPosts = getSortedPosts(posts);
const lead = sortedPosts[0];
const highlights = sortedPosts.slice(1, 3);
const remaining = sortedPosts.slice(3);
const topics = getTopics(posts);
---

<BaseLayout title="gaoguobin">
  <section class="home-intro">
    <div>
      <p class="meta">Personal journal magazine</p>
      <h1>Technical notes, experiments, and writing from gaoguobin.</h1>
    </div>
    <CurrentFocus />
  </section>

  <FeaturedStory lead={lead} highlights={highlights} />

  <div class="home-grid">
    <section aria-label="Recent writing">
      <h2>Recent writing</h2>
      <div data-post-list>
        {remaining.map((post) => <PostCard post={post} />)}
      </div>
    </section>
    <aside class="side-rail">
      <TopicFilter topics={topics} />
      <ReadingQueue />
      <button class="button primary" type="button" data-contact-open>Subscribe / Contact</button>
    </aside>
  </div>

  <SearchOverlay posts={sortedPosts} />
  <PreviewDrawer posts={sortedPosts} />
  <div class="overlay" data-contact-modal hidden>
    <form class="overlay-panel" data-contact-form>
      <div class="dialog-head">
        <h2>Stay in touch</h2>
        <button class="icon-button" type="button" data-contact-close aria-label="Close contact form">×</button>
      </div>
      <label>
        Name
        <input name="name" autocomplete="name" required />
      </label>
      <label>
        Email
        <input name="email" type="email" autocomplete="email" required />
      </label>
      <label>
        Message
        <textarea name="message" rows="4" required></textarea>
      </label>
      <button class="button primary" type="submit">Send</button>
      <p data-contact-success hidden>Thanks. This demo form recorded your message locally.</p>
    </form>
  </div>
</BaseLayout>

<script>
  import "../scripts/home-interactions";
</script>
```

- [ ] **Step 5: Extend CSS for homepage shells**

Append to `src/styles/global.css`:

```css
.home-intro,
.featured-grid,
.home-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.6fr);
  gap: 28px;
  align-items: start;
}

.home-intro {
  margin-bottom: 34px;
}

.home-intro h1,
.lead-story h1 {
  margin: 0;
  font-size: clamp(2rem, 4vw, 4.2rem);
  line-height: 1.02;
}

.featured-grid {
  border-top: 2px solid var(--text);
  border-bottom: 1px solid var(--line);
  padding: 28px 0;
  margin-bottom: 34px;
}

.lead-story,
.highlight-stack article,
.focus-rail,
.side-rail {
  display: grid;
  gap: 14px;
}

.highlight-stack {
  display: grid;
  gap: 18px;
}

.highlight-stack article {
  border-top: 1px solid var(--line);
  padding-top: 16px;
}

.side-rail {
  position: sticky;
  top: 92px;
}

.overlay,
.drawer {
  position: fixed;
  z-index: 50;
}

.overlay {
  inset: 0;
  display: grid;
  place-items: start center;
  padding: 80px 16px 16px;
  background: rgba(28, 31, 35, 0.4);
}

.overlay[hidden],
.drawer[hidden],
[hidden] {
  display: none !important;
}

.overlay-panel {
  width: min(720px, 100%);
  max-height: calc(100vh - 120px);
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  padding: 22px;
  box-shadow: 0 20px 60px rgba(28, 31, 35, 0.25);
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.search-result {
  display: grid;
  gap: 4px;
  border-top: 1px solid var(--line);
  padding: 14px 0;
  text-decoration: none;
}

.drawer {
  top: 0;
  right: 0;
  width: min(420px, 100%);
  height: 100vh;
  overflow: auto;
  background: var(--surface);
  border-left: 1px solid var(--line);
  padding: 24px;
  box-shadow: -20px 0 60px rgba(28, 31, 35, 0.16);
}

label {
  display: grid;
  gap: 6px;
  margin: 12px 0;
}

input,
textarea {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
}

@media (max-width: 860px) {
  .home-intro,
  .featured-grid,
  .home-grid {
    grid-template-columns: 1fr;
  }

  .side-rail {
    position: static;
  }
}
```

- [ ] **Step 6: Run build to expose missing behavior only**

Run:

```bash
npm run build
```

Expected: PASS or fail only because `src/scripts/home-interactions.ts` is missing. Continue to Task 7 for the script.

- [ ] **Step 7: Commit homepage shell**

Run:

```bash
git add src/components src/pages/index.astro src/styles/global.css
git commit -m "feat: add personal journal homepage shell"
```

---

### Task 7: Implement Homepage Interactions

**Files:**
- Create: `src/scripts/home-interactions.ts`

- [ ] **Step 1: Create client interaction script**

Create `src/scripts/home-interactions.ts` with:

```ts
import {
  QUEUE_STORAGE_KEY,
  addQueuedSlug,
  deserializeQueuedSlugs,
  serializeQueuedSlugs,
} from "../lib/queue";

function queryAll<T extends HTMLElement>(selector: string): T[] {
  return Array.from(document.querySelectorAll<T>(selector));
}

function setHidden(element: HTMLElement | null, hidden: boolean): void {
  if (element) {
    element.hidden = hidden;
  }
}

function initializeSearch(): void {
  const overlay = document.querySelector<HTMLElement>("[data-search-overlay]");
  const input = document.querySelector<HTMLInputElement>("[data-search-input]");
  const results = queryAll<HTMLAnchorElement>("[data-search-result]");

  document.querySelector<HTMLElement>("[data-search-open]")?.addEventListener("click", () => {
    setHidden(overlay, false);
    input?.focus();
  });

  document.querySelector<HTMLElement>("[data-search-close]")?.addEventListener("click", () => {
    setHidden(overlay, true);
  });

  input?.addEventListener("input", () => {
    const terms = input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    for (const result of results) {
      const text = result.dataset.searchText ?? "";
      result.hidden = terms.length > 0 && !terms.every((term) => text.includes(term));
    }
  });
}

function initializeTopicFilters(): void {
  const cards = queryAll<HTMLElement>("[data-post-card]");

  for (const button of queryAll<HTMLButtonElement>("[data-topic]")) {
    button.addEventListener("click", () => {
      const topic = button.dataset.topic?.toLocaleLowerCase() ?? "";
      for (const card of cards) {
        const tags = (card.dataset.tags ?? "").toLocaleLowerCase().split(",");
        card.hidden = !tags.includes(topic);
      }
    });
  }

  document.querySelector<HTMLButtonElement>("[data-topic-reset]")?.addEventListener("click", () => {
    for (const card of cards) {
      card.hidden = false;
    }
  });
}

function getQueuedSlugs(): string[] {
  return deserializeQueuedSlugs(window.localStorage.getItem(QUEUE_STORAGE_KEY));
}

function saveQueuedSlugs(slugs: string[]): void {
  window.localStorage.setItem(QUEUE_STORAGE_KEY, serializeQueuedSlugs(slugs));
}

function renderQueueCount(): void {
  const count = getQueuedSlugs().length;
  for (const counter of queryAll<HTMLElement>("[data-queue-count]")) {
    counter.textContent = String(count);
  }
}

function initializePreviewDrawer(): void {
  const drawer = document.querySelector<HTMLElement>("[data-preview-drawer]");
  const panels = queryAll<HTMLElement>("[data-preview-panel]");

  for (const button of queryAll<HTMLButtonElement>("[data-preview-open]")) {
    button.addEventListener("click", () => {
      const slug = button.dataset.previewOpen;
      for (const panel of panels) {
        panel.hidden = panel.dataset.previewPanel !== slug;
      }
      setHidden(drawer, false);
    });
  }

  document.querySelector<HTMLButtonElement>("[data-preview-close]")?.addEventListener("click", () => {
    setHidden(drawer, true);
  });

  for (const button of queryAll<HTMLButtonElement>("[data-queue-add]")) {
    button.addEventListener("click", () => {
      const slug = button.dataset.queueAdd;
      if (!slug) {
        return;
      }
      saveQueuedSlugs(addQueuedSlug(getQueuedSlugs(), slug));
      renderQueueCount();
    });
  }
}

function initializeContactModal(): void {
  const modal = document.querySelector<HTMLElement>("[data-contact-modal]");
  const success = document.querySelector<HTMLElement>("[data-contact-success]");

  for (const button of queryAll<HTMLButtonElement>("[data-contact-open]")) {
    button.addEventListener("click", () => setHidden(modal, false));
  }

  document.querySelector<HTMLButtonElement>("[data-contact-close]")?.addEventListener("click", () => {
    setHidden(modal, true);
  });

  document.querySelector<HTMLFormElement>("[data-contact-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    setHidden(success, false);
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setHidden(document.querySelector<HTMLElement>("[data-search-overlay]"), true);
    setHidden(document.querySelector<HTMLElement>("[data-preview-drawer]"), true);
    setHidden(document.querySelector<HTMLElement>("[data-contact-modal]"), true);
  }
});

if (typeof document !== "undefined") {
  initializeSearch();
  initializeTopicFilters();
  initializePreviewDrawer();
  initializeContactModal();
  renderQueueCount();
}
```

- [ ] **Step 2: Verify build**

Run:

```bash
npm run build
```

Expected: PASS with static output in `dist/`.

- [ ] **Step 3: Commit interactions**

Run:

```bash
git add src/scripts/home-interactions.ts
git commit -m "feat: add homepage visitor interactions"
```

---

### Task 8: Add Real Routes

**Files:**
- Create: `src/pages/archive.astro`
- Create: `src/pages/about.astro`
- Create: `src/pages/topics/[topic].astro`
- Create: `src/pages/posts/[slug].astro`

- [ ] **Step 1: Add archive route**

Create `src/pages/archive.astro` with:

```astro
---
import { getCollection } from "astro:content";
import BaseLayout from "../layouts/BaseLayout.astro";
import PostCard from "../components/PostCard.astro";
import { getSortedPosts, type PostSummary } from "../lib/posts";

const entries = await getCollection("posts");
const posts: PostSummary[] = getSortedPosts(entries.map((entry) => ({
  slug: entry.slug,
  title: entry.data.title,
  date: entry.data.date,
  summary: entry.data.summary,
  tags: entry.data.tags,
  featured: entry.data.featured,
  readTime: entry.data.readTime,
  href: `/posts/${entry.slug}/`,
})));
---

<BaseLayout title="Writing · gaoguobin" activePath="/archive/">
  <h1>Writing</h1>
  <p class="muted">All migrated notes and articles.</p>
  {posts.map((post) => <PostCard post={post} />)}
</BaseLayout>
```

- [ ] **Step 2: Add about route**

Create `src/pages/about.astro` with:

```astro
---
import BaseLayout from "../layouts/BaseLayout.astro";
---

<BaseLayout title="About · gaoguobin" activePath="/about/">
  <article class="post-card">
    <h1>About gaoguobin</h1>
    <p>This site is a personal journal magazine for technical notes, web experiments, game development notes, and project reflections.</p>
    <p>The redesign keeps the archive alive while making the homepage easier to browse and test.</p>
  </article>
</BaseLayout>
```

- [ ] **Step 3: Add topic route**

Create `src/pages/topics/[topic].astro` with:

```astro
---
import { getCollection } from "astro:content";
import BaseLayout from "../../layouts/BaseLayout.astro";
import PostCard from "../../components/PostCard.astro";
import { filterPostsByTopic, getSortedPosts, getTopics, type PostSummary } from "../../lib/posts";

const entries = await getCollection("posts");
const posts: PostSummary[] = entries.map((entry) => ({
  slug: entry.slug,
  title: entry.data.title,
  date: entry.data.date,
  summary: entry.data.summary,
  tags: entry.data.tags,
  featured: entry.data.featured,
  readTime: entry.data.readTime,
  href: `/posts/${entry.slug}/`,
}));

export function getStaticPaths() {
  const topicNames = getTopics(posts).map((topic) => topic.name);
  return topicNames.map((topic) => ({ params: { topic } }));
}

const { topic } = Astro.params;
const topicPosts = getSortedPosts(filterPostsByTopic(posts, topic ?? ""));
---

<BaseLayout title={`${topic} · gaoguobin`} activePath="/topics/">
  <h1>Topic: {topic}</h1>
  {topicPosts.map((post) => <PostCard post={post} />)}
</BaseLayout>
```

- [ ] **Step 4: Add post route**

Create `src/pages/posts/[slug].astro` with:

```astro
---
import { getCollection, render } from "astro:content";
import BaseLayout from "../../layouts/BaseLayout.astro";

export async function getStaticPaths() {
  const posts = await getCollection("posts");
  return posts.map((post) => ({
    params: { slug: post.slug },
    props: { post },
  }));
}

const { post } = Astro.props;
const { Content } = await render(post);
---

<BaseLayout title={`${post.data.title} · gaoguobin`} description={post.data.summary}>
  <article class="post-card">
    <p class="meta">
      <time datetime={post.data.date.toISOString()}>
        {post.data.date.toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" })}
      </time>
      <span> · {post.data.readTime}</span>
    </p>
    <h1>{post.data.title}</h1>
    <p>{post.data.summary}</p>
    <div class="tag-row">
      {post.data.tags.map((tag) => <a class="tag" href={`/topics/${tag}/`}>{tag}</a>)}
    </div>
    <Content />
  </article>
</BaseLayout>
```

- [ ] **Step 5: Run build**

Run:

```bash
npm run build
```

Expected: PASS and generated routes include `/`, `/archive/`, `/about/`, `/topics/*/`, and `/posts/*/`.

- [ ] **Step 6: Commit routes**

Run:

```bash
git add src/pages
git commit -m "feat: add Astro blog routes"
```

---

### Task 9: Add Playwright E2E Tests

**Files:**
- Create: `tests/e2e/homepage.spec.ts`

- [ ] **Step 1: Write e2e visitor workflow tests**

Create `tests/e2e/homepage.spec.ts` with:

```ts
import { expect, test } from "@playwright/test";

test("homepage renders magazine structure", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /technical notes/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /current focus/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /recent writing/i })).toBeVisible();
  await expect(page.getByText("Reading queue")).toBeVisible();
});

test("search overlay filters and navigates to a result", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Open search" }).click();
  await expect(page.getByRole("dialog", { name: "Search writing" })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search posts" }).fill("backend");
  await expect(page.getByRole("link", { name: /Web 乱序 1/i })).toBeVisible();
  await page.getByRole("link", { name: /Web 乱序 1/i }).click();

  await expect(page).toHaveURL(/\/posts\/backend-project-notes\/$/);
  await expect(page.getByRole("heading", { name: /Web 乱序 1/i })).toBeVisible();
});

test("topic chip filters homepage article cards and reset restores them", async ({ page }) => {
  await page.goto("/");

  const cards = page.locator("[data-post-card]");
  const visibleCards = page.locator("[data-post-card]:visible");
  const initialCount = await cards.count();
  expect(initialCount).toBeGreaterThan(1);

  await page.getByRole("button", { name: /game/i }).first().click();
  const filteredCount = await visibleCards.filter({ hasText: /FF7|Playmaker/i }).count();
  expect(filteredCount).toBeGreaterThan(0);
  await expect(visibleCards).toHaveCount(filteredCount);

  await page.getByRole("button", { name: "All" }).click();
  await expect(visibleCards).toHaveCount(initialCount);
});

test("preview drawer adds an article to reading queue and localStorage", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Preview" }).first().click();
  await expect(page.locator("[data-preview-drawer]")).toBeVisible();

  await page.getByRole("button", { name: "Add to queue" }).click();
  await expect(page.locator("[data-queue-count]").first()).toHaveText("1");

  const stored = await page.evaluate(() => window.localStorage.getItem("gaoguobin-reading-queue"));
  expect(stored).toContain("[");
});

test("contact modal accepts input and shows success state", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Subscribe / Contact" }).click();
  await page.getByLabel("Name").fill("Visitor");
  await page.getByLabel("Email").fill("visitor@example.com");
  await page.getByLabel("Message").fill("I enjoyed this journal.");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Thanks. This demo form recorded your message locally.")).toBeVisible();
});

test("mobile viewport keeps primary navigation usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("link", { name: "gaoguobin" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Archive" })).toBeVisible();
  await page.getByRole("link", { name: "About" }).click();
  await expect(page).toHaveURL(/\/about\/$/);
});
```

- [ ] **Step 2: Install Playwright browser**

Run:

```bash
npx playwright install chromium
```

Expected: Chromium browser is installed for Playwright.

- [ ] **Step 3: Run e2e tests to find integration gaps**

Run:

```bash
npm run test:e2e
```

Expected: PASS. If a selector fails because accessible names differ, fix the component markup instead of weakening the user-visible test.

- [ ] **Step 4: Commit e2e tests**

Run:

```bash
git add tests/e2e/homepage.spec.ts playwright.config.ts
git commit -m "test: add homepage visitor workflows"
```

---

### Task 10: Final Cleanup, Generated Output Replacement, and Verification

**Files:**
- Modify/Delete: existing generated root files after Astro build is verified.
- Modify: `package.json` if deployment script needs adjustment.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run test
npm run test:e2e
npm run build
```

Expected: all commands PASS.

- [ ] **Step 2: Decide static artifact strategy**

For this repository, use Astro source as the committed project and `dist/` as build output. Do not commit `dist/` unless GitHub Pages for this repo is configured to serve from the repository root and cannot be changed.

If GitHub Pages must serve root files from `master`, add this script to `package.json`:

```json
{
  "scripts": {
    "deploy:root": "npm run build && rsync -a --delete --exclude='.git/' --exclude='node_modules/' --exclude='src/' --exclude='tests/' --exclude='docs/' dist/ ./"
  }
}
```

If Pages can serve a GitHub Actions artifact or `gh-pages` branch, keep root clean and use `npm run build`.

- [ ] **Step 3: Remove obsolete generated implementation if source deployment is used**

Run:

```bash
rm -rf css js lib categories tags archives about 2019 2020 index.html search.xml content.json baidusitemap.xml sitemap.xml
```

Keep `pcct-qc-tertiary-hospital.html`, `research/`, and `images/` unless the user explicitly approves migrating or deleting those standalone assets.

- [ ] **Step 4: Run final verification after cleanup**

Run:

```bash
npm run test
npm run build
```

Expected: PASS.

- [ ] **Step 5: Inspect git diff for accidental deletion of kept assets**

Run:

```bash
git status --short
git diff --stat
```

Expected: Astro source, tests, configs, and intended generated-file deletions only. No `.superpowers/` files staged.

- [ ] **Step 6: Commit final cleanup**

Run:

```bash
git add -A
git reset .superpowers
git commit -m "feat: replace legacy blog with Astro journal magazine"
```

---

## Self-Review

Spec coverage:

- Astro framework replacement is covered by Tasks 1, 2, 5, 6, 8, and 10.
- Magazine homepage and compact personal context are covered by Tasks 5 and 6.
- Content collection and typed metadata are covered by Task 2.
- Search, topic filtering, preview drawer, queue, navigation, and modal behavior are covered by Tasks 6, 7, 8, and 9.
- Unit tests are covered by Tasks 3 and 4.
- Playwright e2e visitor operations are covered by Task 9.
- Static deployment and generated output cleanup are covered by Task 10.

Placeholder scan:

- The plan contains no deferred markers and no deferred implementation steps.
- Every code-creating step includes concrete file content.

Type consistency:

- `PostSummary` fields are used consistently across components, tests, and pages.
- Queue storage key is shared between helper code and the e2e assertion.
- Data attributes used by the interaction script match the component markup.
