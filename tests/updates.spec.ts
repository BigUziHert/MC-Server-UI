import { test, expect } from "@playwright/test";

test("restarting to update waits for the selected server to finish saving", async ({
  page,
}) => {
  let releaseSave: (() => void) | undefined;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let saving = false;
  let installed = false;
  await page.route("**/api/desktop/selection", async (route) => {
    if (route.request().method() === "PUT") {
      saving = true;
      await saveGate;
    }
    await route.fulfill({ json: { desktop: true, activeServerId: null } });
  });
  await page.route("**/api/desktop/updates**", (route) => {
    if (route.request().method() === "POST") installed = true;
    return route.fulfill({
      json: {
        desktop: true,
        supported: true,
        version: "0.1.3-dev.0",
        channel: "dev",
        status: installed ? "installing" : "downloaded",
        availableVersion: "0.1.3-dev.9.1",
        message: "Update downloaded.",
      },
    });
  });
  await page.goto("/");
  await expect.poll(() => saving).toBe(true);
  await page.getByRole("button", { name: "App updates", exact: true }).click();
  const restart = page.getByRole("button", {
    name: "Restart to update",
    exact: true,
  });
  await restart.click();
  await expect(restart).toBeDisabled();
  expect(installed).toBe(false);
  releaseSave!();
  await expect.poll(() => installed).toBe(true);
});

test("desktop updates show version, manual download, and restart without submitting before a click", async ({
  page,
}) => {
  let state = {
    desktop: true,
    supported: true,
    version: "0.1.3-dev.0",
    channel: "dev",
    status: "idle",
    availableVersion: null as string | null,
    message: "",
  };
  const actions: string[] = [];
  await page.route("**/api/desktop/updates**", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "POST") {
      actions.push(action);
      if (action === "check")
        state = {
          ...state,
          status: "available",
          availableVersion: "0.1.3-dev.9.1",
          message: "A new dev build is ready to download.",
        };
      if (action === "download")
        state = {
          ...state,
          status: "downloaded",
          message: "Update downloaded.",
        };
      if (action === "install")
        state = {
          ...state,
          status: "installing",
          message: "Preparing to restart MC Panel…",
        };
    }
    await route.fulfill({ json: state });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "App updates", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "App updates" });
  await expect(dialog).toContainText("0.1.3-dev.0");
  expect(actions).toEqual([]);
  await dialog.getByRole("button", { name: "Check for updates" }).click();
  await expect(dialog).toContainText("0.1.3-dev.9.1");
  expect(actions).toEqual(["check"]);
  await dialog.getByRole("button", { name: "Download update" }).click();
  await expect(dialog).toContainText(
    "Running servers will be stopped after active backups finish",
  );
  expect(actions).toEqual(["check", "download"]);
  await dialog.getByRole("button", { name: "Restart to update" }).click();
  expect(actions).toEqual(["check", "download", "install"]);
  await expect(
    dialog.getByRole("button", { name: "Restarting…" }),
  ).toBeDisabled();
});

test("portable builds explain the one-time Setup requirement and never offer an install action", async ({
  page,
}) => {
  await page.route("**/api/desktop/updates**", (route) =>
    route.fulfill({
      json: {
        desktop: true,
        supported: false,
        version: "0.1.3-dev.0",
        channel: "dev",
        status: "unsupported",
        message:
          "Install the Setup edition once to enable in-app updates. Portable and unpacked copies do not update themselves.",
      },
    }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({ json: { servers: [], defaultServerId: null } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "App updates", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "App updates" });
  await expect(dialog).toContainText("Setup edition once");
  await expect(
    dialog.getByRole("button", { name: "Check for updates" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
