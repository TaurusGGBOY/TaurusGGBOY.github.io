import { describe, expect, it } from "vitest";
import { normalizeSearchText, parsePostTags } from "../../src/scripts/home-interactions";

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
});
