import { expect, type Page } from "@playwright/test";

export const disableAnimations = async (page: Page) => {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }
    `,
  });
};

export const ensureOnboarded = async (page: Page) => {
  const createButton = page.getByTestId("onboarding-create-button");
  if (await createButton.isVisible()) {
    await page.getByTestId("onboarding-display-name").fill("Tester");
    await page.getByTestId("onboarding-confirm-checkbox").check();
    await createButton.click();
  }
  await expect(page.getByTestId("open-settings")).toBeVisible();
};

export const openNetworkSettings = async (page: Page) => {
  await page.getByTestId("open-settings").click();
  const networkButton = page.getByTestId("settings-network-button");
  await expect(networkButton).toBeVisible();
  await networkButton.click();
  await expect(page.getByTestId("network-mode-directP2P")).toBeVisible();
};

export const getSelectedConversationId = async (page: Page) => {
  const selected = page.locator(
    '[data-selected="true"][data-testid^="conversation-row-"]'
  );
  if ((await selected.count()) === 0) return null;
  return selected.first().getAttribute("data-conversation-id");
};

export const ensureChatsList = async (page: Page) => {
  const chatsToggle = page.getByTestId("list-mode-chats");
  if (await chatsToggle.isVisible()) {
    await chatsToggle.click();
  }
};
