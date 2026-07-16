import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const distDir = join(process.cwd(), "dist");

const requiredPaths = [
  "index.html",
  "archive/index.html",
  "about/index.html",
  "posts/backend-project-notes/index.html",
  "posts/claude-code-source-reading-00/index.html",
  "pagefind/pagefind.js",
  "images/posts/backend-project-notes/20200302095416.png",
  // Confirmed legacy topic URL; this page redirects to Fuwari's archive filter.
  "topics/web/index.html",
];

const missing = requiredPaths.filter((path) => !existsSync(join(distDir, path)));

if (missing.length > 0) {
  console.error("Missing required dist artifacts:");
  for (const path of missing) {
    console.error(`- dist/${path}`);
  }
  process.exit(1);
}

const archiveHtml = readFileSync(join(distDir, "archive/index.html"), "utf8");
const archiveRoutes = [
  // Fuwari filters tags and categories on its generated archive route.
  "/archive/?tag=backend",
  "/archive/?category=Backend",
];
const missingArchiveRoutes = archiveRoutes.filter(
  (route) => !archiveHtml.includes(`href="${route}"`),
);

if (missingArchiveRoutes.length > 0) {
  console.error("Missing generated archive filter routes:");
  for (const route of missingArchiveRoutes) {
    console.error(`- ${route}`);
  }
  process.exit(1);
}

if (!archiveHtml.includes('id="writing"')) {
  console.error("Missing legacy archive anchor: #writing");
  process.exit(1);
}

const topicRedirectHtml = readFileSync(
  join(distDir, "topics/web/index.html"),
  "utf8",
);
if (!topicRedirectHtml.includes("/archive/?tag=web")) {
  console.error("Legacy /topics/web/ redirect does not target the Web archive filter.");
  process.exit(1);
}

console.log(
  `Verified ${requiredPaths.length} required dist artifacts and ${archiveRoutes.length} archive filter routes.`,
);
