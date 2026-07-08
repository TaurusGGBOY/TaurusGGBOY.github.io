import { expect, test } from "@playwright/test";

const queueStorageKey = "gaoguobin-reading-queue";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate((storageKey) => window.localStorage.removeItem(storageKey), queueStorageKey);
  await page.reload();
  await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; pointer-events: none !important; }" });
});

test("homepage renders the magazine structure", async ({ page }) => {
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Notes on building, reading, and playing with software." }),
  ).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Homepage tools" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Current focus" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent writing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reading queue" })).toBeVisible();
});

test("search overlay navigates to a matching post", async ({ page }) => {
  await page.getByRole("button", { name: "Open search" }).click();

  const searchDialog = page.getByRole("dialog", { name: "Search writing" });
  await expect(searchDialog).toBeVisible();
  await searchDialog.getByLabel("Search writing").fill("backend");

  const matchingResult = searchDialog.getByRole("link", { name: /后端项目/i });
  await expect(matchingResult).toBeVisible();
  await matchingResult.click();

  await expect(page).toHaveURL(/\/posts\/backend-project-notes\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Web 乱序 1：怎么打开一个后端项目" })).toBeVisible();
});

test("topic filtering narrows and restores visible post cards", async ({ page }) => {
  const activeCards = page.locator("[data-post-card]:not([hidden])");
  const initialCardCount = await activeCards.count();

  await page.getByRole("button", { name: /^game\s+\d+$/i }).click();

  await expect(page.locator("[data-post-card][data-slug='final-fantasy-seven-reset']")).not.toHaveAttribute("hidden", "");
  await expect(page.locator("[data-post-card][data-slug='playmaker-bullet-shooting']")).not.toHaveAttribute("hidden", "");
  await expect(page.locator("[data-post-card][data-slug='backend-project-notes']")).toHaveAttribute("hidden", "");
  expect(await activeCards.count()).toBeLessThan(initialCardCount);

  await page.getByRole("button", { name: "All writing" }).click();

  await expect(activeCards).toHaveCount(initialCardCount);
});

test("preview drawer can add the previewed post to the reading queue", async ({ page }) => {
  const firstPreviewButton = page.getByRole("button", { name: "Preview" }).first();
  const previewedSlug = await firstPreviewButton.getAttribute("data-preview-open");
  await firstPreviewButton.click();

  const previewDrawer = page.locator("[data-preview-drawer]");
  await expect(previewDrawer).toBeVisible();
  await expect(previewDrawer.getByRole("heading", { name: "Preview" })).toBeVisible();

  await previewDrawer.getByRole("button", { name: "Add to queue" }).click();

  await expect(page.locator("[data-queue-count]").first()).toHaveText("1");
  const storedQueue = await page.evaluate((storageKey) => window.localStorage.getItem(storageKey), queueStorageKey);
  expect(storedQueue).not.toBeNull();
  expect(JSON.parse(storedQueue ?? "[]")).toEqual([previewedSlug]);
});

test("contact modal accepts a visitor message", async ({ page }) => {
  await page.getByRole("button", { name: "Contact" }).click();

  const contactDialog = page.getByRole("dialog", { name: "Contact" });
  await expect(contactDialog).toBeVisible();
  await contactDialog.getByLabel("Name").fill("Ada Lovelace");
  await contactDialog.getByLabel("Email").fill("ada@example.com");
  await contactDialog.getByLabel("Message").fill("I would like to talk about backend project notes.");
  await contactDialog.getByRole("button", { name: "Send message" }).click();

  await expect(contactDialog.getByText("Message queued. Thank you for reaching out.")).toBeVisible();
});

test("mobile navigation exposes brand and archive/about links", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(primaryNavigation.getByRole("link", { name: "gaoguobin" })).toBeVisible();
  await expect(primaryNavigation.getByRole("link", { name: "Archive" })).toBeVisible();

  await primaryNavigation.getByRole("link", { name: "About" }).click();

  await expect(page).toHaveURL(/\/about\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "About gaoguobin" })).toBeVisible();
});
