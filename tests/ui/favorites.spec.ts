import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  disableAnimations,
  ensureOnboarded,
  ensureChatsList,
  getSelectedConversationId,
} from "./helpers";

const openFavoriteMenuItem = async (page: Page, row: Locator) => {
  const convId = await row.getAttribute("data-conversation-id");
  if (!convId) {
    throw new Error("Conversation row missing data-conversation-id");
  }
  await page.getByTestId(`conversation-menu-${convId}`).click();
  const favoriteItem = page.getByTestId(`conversation-favorite-${convId}`);
  await expect(favoriteItem).toBeVisible();
  return { convId, favoriteItem };
};

test.describe("Favorites interaction", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await disableAnimations(page);
    await ensureOnboarded(page);
    await ensureChatsList(page);
  });

  test("favorite on non-selected row does not change selection", async ({ page }) => {
    const rows = page.locator('[data-testid^="conversation-row-"]');
    await expect(rows.first()).toBeVisible();

    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(1);

    const selectedRow = rows.first();
    await selectedRow.click();
    await expect(selectedRow).toHaveAttribute("data-selected", "true");

    const selectedBefore = await getSelectedConversationId(page);

    const targetRow = rows.nth(1);
    const { convId, favoriteItem } = await openFavoriteMenuItem(page, targetRow);
    const beforePressed = await favoriteItem.getAttribute("aria-pressed");

    await favoriteItem.click();

    const selectedAfter = await getSelectedConversationId(page);
    expect(selectedAfter).toBe(selectedBefore);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("chat-view")).toBeVisible();

    await page.getByTestId(`conversation-menu-${convId}`).click();
    const favoriteAfter = page.getByTestId(`conversation-favorite-${convId}`);
    await expect(favoriteAfter).toBeVisible();
    const afterPressed = await favoriteAfter.getAttribute("aria-pressed");
    expect(afterPressed).not.toBe(beforePressed);
  });

  test("favorite on selected row does not trigger navigation", async ({ page }) => {
    const rows = page.locator('[data-testid^="conversation-row-"]');
    await expect(rows.first()).toBeVisible();

    const selectedRow = rows.first();
    await selectedRow.click();

    const selectedBefore = await getSelectedConversationId(page);

    const { convId, favoriteItem } = await openFavoriteMenuItem(page, selectedRow);
    const beforePressed = await favoriteItem.getAttribute("aria-pressed");

    await favoriteItem.click();

    const selectedAfter = await getSelectedConversationId(page);
    expect(selectedAfter).toBe(selectedBefore);

    await page.getByTestId(`conversation-menu-${convId}`).click();
    const favoriteAfter = page.getByTestId(`conversation-favorite-${convId}`);
    await expect(favoriteAfter).toBeVisible();
    const afterPressed = await favoriteAfter.getAttribute("aria-pressed");
    expect(afterPressed).not.toBe(beforePressed);
  });
});
