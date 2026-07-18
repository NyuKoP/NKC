import { test, expect } from "@playwright/test";
import {
  disableAnimations,
  ensureOnboarded,
  ensureChatsList,
  openNetworkSettings,
} from "./helpers";

test.describe("Visual snapshots", () => {
  test("onboarding screen", async ({ page }) => {
    await page.goto("/");
    await disableAnimations(page);
    await expect(page.getByTestId("onboarding-create-button")).toBeVisible();
    await expect(page).toHaveScreenshot("onboarding.png");
  });

  test("start key login does not ask for a display name", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("onboarding-start-key-tab").click();

    await expect(page.getByTestId("onboarding-start-key-input")).toBeVisible();
    await expect(page.getByTestId("onboarding-display-name")).toBeHidden();
    await expect(page.getByTestId("onboarding-start-key-button")).toBeVisible();
  });

  test("settings network", async ({ page }) => {
    await page.goto("/");
    await disableAnimations(page);
    await ensureOnboarded(page);
    await openNetworkSettings(page);
    await expect(page).toHaveScreenshot("settings-network.png");
  });

  test("sidebar list view", async ({ page }) => {
    await page.goto("/");
    await disableAnimations(page);
    await ensureOnboarded(page);
    await ensureChatsList(page);

    const sidebar = page.getByTestId("sidebar");
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveScreenshot("sidebar.png");
  });

  test("chat view", async ({ page }) => {
    await page.goto("/");
    await disableAnimations(page);
    await ensureOnboarded(page);
    await ensureChatsList(page);

    const rows = page.locator('[data-testid^="conversation-row-"]');
    await expect(rows.first()).toBeVisible();
    await rows.first().click();

    const chatView = page.getByTestId("chat-view");
    await expect(chatView).toBeVisible();
    await expect(chatView).toHaveScreenshot("chat-view.png");
  });
});
