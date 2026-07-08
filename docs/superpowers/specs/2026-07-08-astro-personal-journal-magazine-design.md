# Astro Personal Journal Magazine Homepage Design

## Context

The current repository is a generated static Hexo/NexT site with HTML, CSS, and legacy client scripts checked in as output. The redesign can fully abandon the existing framework and generated structure. The new site will use Astro as the source-managed framework for a modern personal blog/homepage.

## Product Direction

Rebuild the homepage as an Astro-powered Personal Journal Magazine. The site should be article-first, with enough personal context that it also works as gaoguobin's home base.

The first viewport will include:

- A restrained top nav: Home, Writing, Topics, Archive, About, and a search icon.
- A compact identity block for gaoguobin.
- A featured writing area with one lead article and two smaller recent or highlighted posts.
- A side rail for current focus, topic chips, and reading queue state.

The design should avoid a marketing landing page. Visitors should immediately see writing, topics, and ways to browse.

## Framework Choice

Use Astro because it fits a content-driven personal blog while still supporting targeted interactive components. The output can remain static and suitable for GitHub Pages. Blog content will use Markdown or MDX with typed metadata.

Next.js was rejected because the site does not need to become a full React application. Hugo was rejected because it is better suited to classic theme-driven blogging than custom homepage interactions. Eleventy was rejected because it would require more site structure to be assembled manually.

## Architecture

Create a source-managed Astro app and replace the current generated homepage implementation.

Proposed structure:

- `src/pages/index.astro`: homepage composition.
- `src/pages/archive.astro`: archive route.
- `src/pages/about.astro`: about route.
- `src/pages/topics/[topic].astro`: topic route.
- `src/pages/posts/[slug].astro`: individual post route.
- `src/content/posts/*.mdx`: post content with frontmatter.
- `src/components/SiteNav.astro`: navigation and active states.
- `src/components/FeaturedStory.astro`: lead story presentation.
- `src/components/PostCard.astro`: repeated article cards.
- `src/components/TopicFilter.astro`: homepage topic filter controls.
- `src/components/SearchOverlay.astro`: search UI shell.
- `src/components/PreviewDrawer.astro`: article preview drawer shell.
- `src/components/ReadingQueue.astro`: visible reading queue state.
- `src/components/CurrentFocus.astro`: compact personal context rail.
- `src/lib/posts.ts`: typed post querying, sorting, topics, search helpers.
- `src/lib/queue.ts`: queue serialization helpers.
- `src/scripts/home-interactions.ts`: progressive client behavior for the homepage.

The site should remain mostly static. JavaScript should be scoped to interactions that visitors can actually perform.

## Content Model

Each post will have frontmatter with:

- `title`
- `date`
- `summary`
- `tags`
- `featured`
- `readTime`
- `cover` or `coverAlt` when useful

Initial content can migrate a small set of existing posts and standalone pages into MDX so the homepage has real data to render. The implementation should preserve old standalone HTML pages only when keeping them is necessary for existing URLs.

## Homepage Behavior

The homepage will simulate real visitor operations without requiring a backend.

Search:

- Clicking the search icon opens an overlay.
- Typing filters posts by title, summary, and tags.
- `Escape` closes the overlay.
- Selecting a result navigates to the post route.

Topic filtering:

- Clicking topic chips filters the visible homepage article list without a page reload.
- A reset control restores all posts.
- Topic pages also exist as real Astro routes.

Article preview:

- Clicking a preview button opens a drawer.
- The drawer shows title, metadata, summary, tags, and actions.
- Actions include Read article, Add to queue, and Close.

Reading queue:

- Add to queue updates a visible queue counter.
- Queued slugs are stored in `localStorage`.
- The behavior is simulated but persistent enough to feel real during a visit.

Navigation:

- Header nav links route to real Astro pages.
- Active states should be visible where appropriate.

Light modal:

- A contact or newsletter-style CTA opens a modal.
- The modal includes fields that can be typed into.
- Submission shows a success state and does not require a backend.

## Visual Direction

Use a modern editorial layout with compact personal context. Avoid oversized hero marketing composition. The site should feel like a thoughtful writing surface rather than a product landing page.

Use restrained typography, clear article hierarchy, and dense but readable information. Cards are acceptable for repeated articles, but avoid nested cards and decorative page-section cards.

## Testing

Use Vitest for unit tests:

- `getSortedPosts` orders posts newest-first and handles featured posts.
- `getTopics` extracts unique topic names and counts.
- `filterPostsByTopic` returns expected posts.
- `searchPosts` matches title, summary, and tags.
- Queue helpers serialize and deserialize slugs safely.

Use Playwright for e2e tests:

- Load the homepage and verify the lead story, nav, topic rail, and post cards render.
- Open search, type a query, verify results update, and navigate to a result.
- Click a topic chip, verify article cards change, and reset the filter.
- Open an article preview drawer, add it to the queue, and verify queue counter plus `localStorage`.
- Open the contact/newsletter modal, type into fields, submit, and verify success state.
- Check basic mobile viewport navigation behavior.

Expected local commands:

- `npm run test`
- `npm run test:e2e`
- `npm run build`

## Deployment

The site should build to static assets suitable for GitHub Pages. The implementation plan should choose the exact Astro output directory and deployment script after scaffolding the Astro project.

## Out of Scope

- Backend search service.
- Real newsletter subscription or contact form delivery.
- User accounts.
- Comment system.
- Full CMS integration.
- Rebuilding every historic generated archive page before the new homepage works.
