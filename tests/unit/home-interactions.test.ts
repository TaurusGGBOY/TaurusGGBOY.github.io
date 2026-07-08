import { describe, expect, it } from "vitest";
import { createQueueStore, normalizeSearchText, parsePostTags } from "../../src/scripts/home-interactions";

describe("homepage interaction helpers", () => {
  it("normalizes search text for case-insensitive filtering", () => {
    expect(normalizeSearchText("  Web Games  ")).toBe("web games");
  });

  it("parses JSON tag arrays and trims unsafe values", () => {
    expect(parsePostTags("[\"Web\", \" games \", 12, \"\"]")).toEqual(["Web", "games"]);
  });

  it("falls back to comma separated tags", () => {
    expect(parsePostTags("web, games, notes")).toEqual(["web", "games", "notes"]);
  });

  it("keeps queue state in memory when storage throws", () => {
    const store = createQueueStore({
      getItem() {
        throw new Error("storage blocked");
      },
      setItem() {
        throw new Error("storage blocked");
      },
    });

    expect(store.read()).toEqual([]);
    store.write(["alpha"]);
    expect(store.read()).toEqual(["alpha"]);
  });
});
