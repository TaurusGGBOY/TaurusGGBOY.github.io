import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("post image assets", () => {
  it("keeps Final Fantasy VII images served from local public assets", () => {
    const postPath = join(repoRoot, "src/content/posts/final-fantasy-seven-reset.mdx");
    const post = readFileSync(postPath, "utf8");
    const imagePaths: string[] = [];
    const imageReferencePattern =
      /!\[[^\]]*\]\((\/images\/posts\/final-fantasy-seven-reset\/[^)]+)\)/g;
    let match = imageReferencePattern.exec(post);

    while (match !== null) {
      imagePaths.push(match[1]);
      match = imageReferencePattern.exec(post);
    }

    expect(post).not.toContain("gitee.com/agaogao/photobed");
    expect(imagePaths).toHaveLength(20);

    for (const imagePath of imagePaths) {
      expect(existsSync(join(repoRoot, "public", imagePath))).toBe(true);
    }
  });
});
