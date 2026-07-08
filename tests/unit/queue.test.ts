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

  it("trims the removal target before removing", () => {
    expect(removeQueuedSlug(["alpha"], " alpha ")).toEqual([]);
  });
});
