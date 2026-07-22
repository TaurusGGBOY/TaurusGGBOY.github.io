import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("post image assets", () => {
  it("keeps localized post images served from public assets", () => {
    const postsDir = join(repoRoot, "src/content/posts");
    const imagePaths: string[] = [];
    const imageReferencePattern = /!\[[^\]]*\]\((\/images\/posts\/[^)]+)\)/g;

    for (const file of readdirSync(postsDir)) {
      if (!file.endsWith(".md") && !file.endsWith(".mdx")) {
        continue;
      }

      const post = readFileSync(join(postsDir, file), "utf8");
      expect(post).not.toContain("gitee.com/agaogao/photobed");
      expect(post).not.toContain("q5jmnw63e.bkt.clouddn.com");
      expect(post).not.toContain("img-blog.csdnimg.cn");

      let match = imageReferencePattern.exec(post);

      while (match !== null) {
        imagePaths.push(match[1]);
        match = imageReferencePattern.exec(post);
      }
    }

    expect(imagePaths).toHaveLength(46);

    for (const imagePath of imagePaths) {
      expect(existsSync(join(repoRoot, "public", imagePath))).toBe(true);
    }
  });
});
