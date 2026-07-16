import { describe, expect, it } from "vitest";
import { profileConfig, siteConfig } from "../../src/config";

describe("profile configuration", () => {
	it("uses the author's GitHub avatar", () => {
		expect(profileConfig.avatar).toBe("https://github.com/TaurusGGBOY.png?size=256");
	});

	it("enables the homepage banner image", () => {
		expect(siteConfig.banner.enable).toBe(true);
		expect(siteConfig.banner.src).toBe("/images/home-banner.jpg");
	});
});
