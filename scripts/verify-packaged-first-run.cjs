const path = require("node:path");
const { _electron: electron } = require("playwright");

const executablePath = path.resolve(
  process.argv[2] || path.join("release", "win-unpacked", "NKC.exe")
);
const userDataDir = path.join(
  process.env.TEMP || "C:\\tmp",
  `nkc-packaged-first-run-${process.pid}-${Date.now()}`
);

const run = async () => {
  const env = {
    ...process.env,
    VITE_DEV_SERVER_URL: "http://127.0.0.1:9",
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const launch = () =>
    electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDir}`],
      env,
    });

  const electronApp = await launch();

  try {
    const page = await electronApp.firstWindow({ timeout: 30_000 });
    await page.waitForLoadState("domcontentloaded");
    const createVisible = await page.getByTestId("onboarding-create-tab").isVisible();
    const result = {
      url: page.url(),
      title: await page.title(),
      createVisible,
      userDataDir,
    };
    console.log(JSON.stringify(result));

    if (!page.url().startsWith("file:") || !createVisible) {
      throw new Error("Packaged app did not open its local first-run account screen");
    }

    await page.getByTestId("onboarding-display-name").fill("Packaged Test");
    await page.getByTestId("onboarding-confirm-checkbox").check();
    await page.getByTestId("onboarding-create-button").click();
    await page.getByTestId("open-settings").waitFor({ state: "visible", timeout: 30_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    const startKeyVisible = await page.getByTestId("onboarding-start-key-input").isVisible();
    const displayNameVisible = await page.getByTestId("onboarding-display-name").isVisible();
    console.log(JSON.stringify({ startKeyVisible, displayNameVisible, automaticLogin: false }));

    if (!startKeyVisible || displayNameVisible) {
      throw new Error("Existing account did not require start-key login after renderer restart");
    }
  } finally {
    await electronApp.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
