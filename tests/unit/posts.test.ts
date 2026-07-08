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
