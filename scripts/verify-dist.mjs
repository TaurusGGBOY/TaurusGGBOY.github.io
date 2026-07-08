import { existsSync } from "node:fs";
import { join } from "node:path";

const requiredPaths = [
  "index.html",
  "archive/index.html",
  "about/index.html",
  "topics/web/index.html",
  "posts/backend-project-notes/index.html",
  "pcct-qc-tertiary-hospital.html",
  "research/zizhong_earthquake/index.html",
  "images/logo.svg",
];

const missing = requiredPaths.filter((path) => !existsSync(join("dist", path)));

if (missing.length > 0) {
  console.error("Missing required dist artifacts:");
  for (const path of missing) {
    console.error(`- dist/${path}`);
  }
  process.exit(1);
}

console.log(`Verified ${requiredPaths.length} required dist artifacts.`);
