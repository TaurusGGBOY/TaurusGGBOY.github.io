import { describe, expect, it } from "vitest";
import { profileConfig } from "../../src/config";

describe("profile configuration", () => {
	it("uses the author's GitHub avatar", () => {
		expect(profileConfig.avatar).toBe("https://github.com/TaurusGGBOY.png?size=256");
	});
});
