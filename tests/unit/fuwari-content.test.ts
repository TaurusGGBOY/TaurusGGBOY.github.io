import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const postsDirectory = join(process.cwd(), "src/content/posts");
const requiredKeys = ["title", "published", "description", "tags", "category", "draft"];
const removedKeys = ["date", "summary", "featured", "readTime"];

function frontmatterKeys(source: string): Set<string> {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	expect(match, "post must start with YAML frontmatter").not.toBeNull();

	return new Set(
		(match?.[1].match(/^([A-Za-z][\w-]*):(?:\s|$)/gm) ?? []).map((line) =>
			line.slice(0, line.indexOf(":")),
		),
	);
}

describe("Fuwari post frontmatter", () => {
	it("assigns the Claude Code 00 cover image", async () => {
		const source = await readFile(
			join(postsDirectory, "claude-code-source-reading-00.md"),
			"utf8",
		);

		expect(source).toContain(
			'image: "/images/posts/claude-code-source-reading-00/claude-code-highres.png"',
		);
		expect(source).toContain('imagePosition: "left"');

		const body = source.replace(/^---[\s\S]*?---\s*/, "");
		expect(body).not.toContain("claude-code-highres.png");
	});

	it("uses the Fuwari schema for every post", async () => {
		const postFiles = (await readdir(postsDirectory))
			.filter((file) => file.endsWith(".md") || file.endsWith(".mdx"))
			.sort();

		expect(postFiles).toHaveLength(7);

		for (const file of postFiles) {
			const keys = frontmatterKeys(await readFile(join(postsDirectory, file), "utf8"));

			for (const key of requiredKeys) {
				expect(keys, `${basename(file)} should define ${key}`).toContain(key);
			}

			for (const key of removedKeys) {
				expect(keys, `${basename(file)} should not define ${key}`).not.toContain(key);
			}
		}
	});
});
