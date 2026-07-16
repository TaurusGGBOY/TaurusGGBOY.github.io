# Fuwari Blog Theme Migration Design

## Goal

Replace the current hand-built Astro journal-magazine interface with the existing Fuwari Astro blog theme while preserving the blog's written content, Chinese text, images, static deployment, and existing post URLs.

## Current Context

The repository is already an Astro static site, but its visual system is custom-built from `src/styles/global.css`, `src/layouts/BaseLayout.astro`, and several homepage interaction components. The current content collection contains Markdown/MDX posts with `title`, `date`, `summary`, `tags`, `featured`, and `readTime` fields.

Fuwari is an existing Astro blog template with a ready-made homepage, post layout, archive, category/tag navigation, Pagefind search, light/dark themes, table of contents, RSS, and extended Markdown support. The migration should use Fuwari's existing structure instead of continuing to evolve the current custom magazine layout.

## Scope

### In scope

- Adopt the Fuwari template as the site's source structure and visual theme.
- Keep Astro and static output for GitHub Pages.
- Migrate all current posts from `src/content/posts/` into Fuwari's content model.
- Preserve post slugs and URLs such as `/posts/backend-project-notes/`.
- Preserve existing article body text, Markdown/MDX content, and image paths.
- Configure site identity, Chinese language metadata, avatar, favicon, social links, and deployment URL.
- Use Fuwari's built-in search, archive, tags/categories, responsive layout, and light/dark mode.
- Add compatibility redirects or route handling only where the existing generated site has URLs that would otherwise break.

### Out of scope

- Rewriting article prose or translating existing posts.
- Adding a CMS, backend, comments, accounts, or real contact/newsletter delivery.
- Preserving the current reading queue, preview drawer, or contact modal; these belong to the replaced custom theme.
- Rebuilding every historical Hexo-generated archive URL unless a concrete compatibility check identifies it as required.
- Adding new visual features beyond Fuwari configuration and the minimum content migration work.

## Content Mapping

Each current post will map to Fuwari frontmatter as follows:

| Current field | Fuwari field | Rule |
| --- | --- | --- |
| `title` | `title` | Preserve verbatim. |
| `date` | `published` | Preserve the original calendar date. |
| `summary` | `description` | Preserve the existing summary. |
| `tags` | `tags` | Preserve tag names, normalizing only where required by the schema. |
| `featured` | theme-specific featured behavior | Use only if Fuwari supports it; otherwise keep the field as harmless metadata or omit it. |
| `readTime` | derived/theme display | Do not make it a required content field unless the target theme needs it. |
| `cover`/image assets | `image` | Add only when a suitable cover exists; preserve inline article images. |

Every migrated post will have explicit `category`, `draft`, and language metadata according to Fuwari's schema. Existing Chinese articles will remain Chinese; the site's default language will be configured accordingly.

## Site Structure

The final site will follow Fuwari's routes and components, with these user-facing areas:

- Home: recent and highlighted posts using Fuwari's standard layout.
- Posts: individual article pages with metadata, reading layout, and table of contents where applicable.
- Archive: chronological post index.
- Categories and tags: generated browsing pages using the migrated metadata.
- About: retained as a simple personal introduction page.
- Search: Fuwari's static Pagefind search generated during the build.

The primary navigation will be concise and content-focused. Existing custom navigation labels will not force the old magazine layout to remain.

## Assets and URLs

- Existing files under `public/images/posts/` will be retained or moved only when Fuwari requires a different asset location.
- Inline image references will be updated mechanically only when their paths change; rendered images must remain available.
- The canonical site URL and GitHub Pages path will be set in Fuwari/Astro configuration.
- Post slugs will be explicitly checked against the current routes.

## Verification

Before completion:

1. Run Astro type/content checks and the production build.
2. Verify that every current post has a generated page.
3. Verify representative Chinese text, Markdown headings, code blocks if present, and inline images.
4. Verify search, archive, tag/category navigation, light/dark mode, mobile layout, RSS, and sitemap output.
5. Verify existing post URLs and the GitHub Pages deployment configuration.
6. Run the repository's automated tests, updating only tests that assert the intentionally replaced old homepage structure.

## Acceptance Criteria

- The site visibly uses Fuwari's standard theme structure rather than the current custom magazine layout.
- All current articles remain readable and their images load.
- Article URLs remain stable.
- The project builds successfully as a static Astro site.
- Search, archive, tags/categories, responsive layout, and theme switching work in a production preview.
- No unrelated content or infrastructure is introduced.
