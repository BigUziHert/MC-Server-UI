import { expect, test, type Page } from "@playwright/test";

async function settingsFixture(page: Page, desktop = true) {
  let settings = {
    desktop: true,
    startupMode: "off",
    startupServerId: null as string | null,
    keepInTray: true,
    startupSupported: true,
  };
  let remote = {
    enabled: false,
    ready: false,
    publicUrl: "https://panel.example.test:3002",
    port: 3002,
    transport: "direct",
    listening: false,
  };
  const writes: unknown[] = [];
  await page.route("**/api/desktop/settings", async (route) => {
    if (!desktop)
      return route.fulfill({ status: 404, json: { error: "Not available" } });
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON());
      settings = { ...settings, ...route.request().postDataJSON() };
    }
    return route.fulfill({ json: settings });
  });
  await page.route("**/api/access/settings", async (route) => {
    if (route.request().method() === "PUT") {
      remote = { ...remote, ...route.request().postDataJSON() };
      remote.ready = remote.enabled;
      remote.listening = remote.enabled;
    }
    return route.fulfill({ json: remote });
  });
  return { writes };
}

test("one startup choice saves panel-plus-server and tray behavior across reopening", async ({
  page,
  request,
}) => {
  const { writes } = await settingsFixture(page);
  const fleet = await (await request.get("/api/servers")).json();
  const serverId = fleet.defaultServerId;
  await page.goto("/");
  await page
    .getByRole("button", { name: "Panel Settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Panel Settings",
    exact: true,
  });
  await dialog.getByLabel("When this PC starts").selectOption("server");
  await dialog.getByLabel("Server to start").selectOption(serverId);
  await expect(dialog).toContainText("sign in to Windows");
  await dialog
    .getByRole("switch", {
      name: "Keep MC Panel in the system tray when its window is closed",
    })
    .uncheck();
  await dialog.getByRole("button", { name: "Save startup settings" }).click();
  await expect(
    dialog.getByRole("button", { name: "Save startup settings" }),
  ).toBeDisabled();
  expect(writes).toEqual([
    { startupMode: "server", startupServerId: serverId, keepInTray: false },
  ]);
  await dialog.getByRole("button", { name: "Close Panel Settings" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Panel Settings", exact: true })
    .click();
  await expect(dialog.getByLabel("When this PC starts")).toHaveValue("server");
  await expect(dialog.getByLabel("Server to start")).toHaveValue(serverId);
  await expect(dialog.getByRole("switch")).not.toBeChecked();
  await dialog.getByLabel("When this PC starts").selectOption("panel");
  await expect(dialog.getByLabel("Server to start")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save startup settings" }).click();
  await expect(
    dialog.getByRole("button", { name: "Save startup settings" }),
  ).toBeDisabled();
  expect(writes).toHaveLength(2);
});

test("browser Panel Settings persists host Remote Access and fits a phone", async ({
  page,
}, testInfo) => {
  await settingsFixture(page, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Panel Settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Panel Settings",
    exact: true,
  });
  await expect(dialog).toContainText("available in the MC Panel desktop app");
  await expect(dialog.getByLabel("When this PC starts")).toHaveCount(0);
  await dialog
    .getByRole("checkbox", { name: "Enable remote access", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Save access settings" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Remote access is configured" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("panel-settings-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);
  await dialog.getByRole("button", { name: "Close Panel Settings" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Panel Settings", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Edit setup" }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "Enable remote access", exact: true }),
  ).toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "Enable remote access", exact: true })
    .uncheck();
  await dialog.getByRole("button", { name: "Save access settings" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Remote access", exact: true }),
  ).toBeVisible();
});

test("an invited account with no servers has no host settings or server controls", async ({
  page,
}) => {
  const calls: string[] = [];
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === "/api/access/session")
      return route.fulfill({
        json: {
          role: "subuser",
          accountId: "invited",
          userId: "invited",
          email: "invited@example.test",
          serverId: null,
          permissions: [],
          hostPermissions: [],
        },
      });
    if (path === "/api/servers")
      return route.fulfill({
        json: { servers: [], defaultServerId: null, hostPermissions: [] },
      });
    return route.fulfill({ status: 403, json: { error: "No access" } });
  });
  await page.goto("/#subusers");
  await expect(
    page.getByRole("heading", { name: "No shared servers" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Panel Settings", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
  expect(calls).toEqual(
    expect.arrayContaining(["/api/access/session", "/api/servers"]),
  );
  expect(
    calls.filter(
      (path) => !["/api/access/session", "/api/servers"].includes(path),
    ),
  ).toEqual([]);
});
