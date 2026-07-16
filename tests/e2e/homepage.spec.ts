import { expect, test, type Page } from "@playwright/test";

async function expectOk(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status(), `${path} should respond successfully`).toBe(200);
}

test("Fuwari core routes respond and identify the site", async ({ page }) => {
  await expectOk(page, "/");
  await expect(page.getByRole("link", { name: "gaoguobin" }).first()).toBeVisible();

  await expectOk(page, "/archive/");
  await expectOk(page, "/about/");

  await expectOk(page, "/posts/backend-project-notes/");
  await expect(page.getByText("Web 乱序 1：怎么打开一个后端项目", { exact: true }).first()).toBeVisible();

  // Fuwari exposes tag filtering through the archive query route.
  await expectOk(page, "/archive/?tag=backend");
});

test("Fuwari search interaction opens the search results panel", async ({ page }) => {
  await page.goto("/");

  const mobileSearchButton = page.getByRole("button", { name: "Search Panel" });
  if (await mobileSearchButton.isVisible()) {
    await mobileSearchButton.click();
    await page.getByPlaceholder("Search").fill("backend");
  } else {
    await page.getByPlaceholder("搜索").fill("backend");
  }
  const searchPanel = page.locator("#search-panel");
  await expect(searchPanel).toBeVisible();
  await expect(searchPanel.getByRole("link").first()).toBeVisible();
});

test("mobile navigation exposes Fuwari archive and about links", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.locator("#nav-menu-switch").click();
  const menu = page.locator("#nav-menu-panel");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: "归档" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "关于" })).toBeVisible();
});

test("light and dark theme controls switch the document theme", async ({ page }) => {
  await page.goto("/");

  const themeSwitch = page.getByRole("menuitem", { name: "Light/Dark Mode" });
  if (await page.getByRole("button", { name: "暗色" }).isVisible()) {
    await themeSwitch.hover();
    await page.getByRole("button", { name: "暗色" }).click();
  } else {
    await themeSwitch.click();
    await themeSwitch.click();
  }
  await expect(page.locator("html")).toHaveClass(/dark/);

  if (await page.getByRole("button", { name: "亮色" }).isVisible()) {
    await themeSwitch.hover();
    await page.getByRole("button", { name: "亮色" }).click();
  } else {
    await themeSwitch.click();
  }
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});
