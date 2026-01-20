import { test, expect, type Page } from "@playwright/test";
import {
  disableAnimations,
  ensureOnboarded,
  ensureChatsList,
  openNetworkSettings,
} from "./helpers";

// NOTE: Electron Playwright launch is not supported by this Electron build
// (no --remote-debugging-port), so we run against the Vite dev server in browser mode.

const getStoredProxyUrl = async (page: Page) =>
  page.evaluate(() => {
    const raw = localStorage.getItem("netConfig.v1");
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as { onionProxyUrl?: string }).onionProxyUrl ?? null;
    } catch {
      return null;
    }
  });

const createLargePngBuffer = (sizeBytes: number) => {
  const header = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (sizeBytes <= header.length) return header;
  const padding = Buffer.alloc(sizeBytes - header.length);
  return Buffer.concat([header, padding]);
};

test.describe("Settings and media E2E", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await disableAnimations(page);
    await ensureOnboarded(page);
  });

  test("proxy URL without port shows inline error and is not applied", async ({ page }) => {
    await openNetworkSettings(page);

    await page.getByTestId("network-mode-onionRouter").check();
    const proxyInput = page.getByTestId("proxy-url-input");
    await expect(proxyInput).toBeVisible();

    const beforeUrl = await getStoredProxyUrl(page);
    await proxyInput.fill("socks5://127.0.0.1");

    await expect(page.getByTestId("proxy-url-error")).toBeVisible();
    const afterUrl = await getStoredProxyUrl(page);
    expect(afterUrl).toBe(beforeUrl);
  });

  test("direct P2P requires confirmation before switching modes", async ({ page }) => {
    await openNetworkSettings(page);

    const effectiveMode = page.getByTestId("effective-mode-label");
    const initialLabel = (await effectiveMode.textContent())?.trim() ?? "";

    await page.getByTestId("network-mode-directP2P").click();
    await expect(page.getByTestId("direct-p2p-confirm-dialog")).toBeVisible();
    await expect(effectiveMode).toHaveText(initialLabel);

    await page.getByTestId("direct-p2p-confirm").click();
    await expect(page.getByTestId("direct-p2p-warning")).toBeVisible();
    await expect(effectiveMode).not.toHaveText(initialLabel);

    await page.getByTestId("network-mode-selfOnion").click();
    await expect(effectiveMode).toHaveText(initialLabel);
  });

  test("large media send keeps UI responsive and reloads safely", async ({ page }) => {
    test.setTimeout(120_000);

    await ensureChatsList(page);
    const rows = page.locator('[data-testid^="conversation-row-"]');
    await expect(rows.first()).toBeVisible();

    const target = rows.first();
    const convId = await target.getAttribute("data-conversation-id");
    await target.click();

    const messageInput = page.getByTestId("chat-message-input");
    await expect(messageInput).toBeEditable();

    const mediaBubbles = page.getByTestId("media-message-bubble");
    const beforeCount = await mediaBubbles.count();

    const buffer = createLargePngBuffer(20 * 1024 * 1024);
    await page
      .getByTestId("chat-attach-input")
      .setInputFiles({ name: "large.png", mimeType: "image/png", buffer });

    await expect(messageInput).toBeEditable();
    await messageInput.fill("still responsive");
    await expect(messageInput).toHaveValue("still responsive");

    await expect(mediaBubbles).toHaveCount(beforeCount + 1);
    await expect(mediaBubbles.nth(beforeCount)).toBeVisible();

    if (convId) {
      const fallback = rows.nth(1);
      await fallback.click();
      await page.locator(`[data-conversation-id="${convId}"]`).click();
      await expect(mediaBubbles.nth(beforeCount)).toBeVisible();
    }
  });
});
