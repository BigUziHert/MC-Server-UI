// Source-entry Electron smoke: no native menu (including Alt), live tray, and
// unified local selection persistence. Uses only a temporary app profile.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), "mc-menu-electron-smoke-"),
);
let application;
try {
  const preferencesPath = path.join(
    root,
    "profile",
    "data",
    "desktop-preferences.json",
  );
  await fs.mkdir(path.dirname(preferencesPath), { recursive: true });
  await fs.writeFile(
    preferencesPath,
    JSON.stringify({
      "mc-panel.launchpad.rows": "25",
      "mc-panel.navigation-collapsed": '{"server":true,"minecraft":false}',
      "mc-panel.launchpad.view.default":
        '{"platform":"modrinth","type":"mod","installedOnly":true}',
    }),
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  const launch = () =>
    electron.launch({
      executablePath: path.join(
        project,
        "node_modules",
        "electron",
        "dist",
        "electron.exe",
      ),
      args: [
        project,
        `--user-data-dir=${path.join(root, "profile")}`,
        "--smoke-test",
      ],
      cwd: project,
      env: environment,
      timeout: 30000,
    });
  application = await launch();
  const page = await application.firstWindow();
  await expect
    .poll(() => page.evaluate(() => Boolean(window.mcPanelConnections)))
    .toBe(true);
  const accountMenu = page.getByRole("button", {
    name: "Account menu for Local administrator",
    exact: true,
  });
  await expect(
    page.getByRole("button", { name: "Accept invitation", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toHaveCount(0);
  await accountMenu.click();
  await expect(
    page.getByRole("menuitem", { name: "Sign in", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Manage Connections", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Accept invitation", exact: true })
    .click();
  const addPanel = page.getByRole("dialog", {
    name: "Accept invitation",
    exact: true,
  });
  await expect(
    addPanel.getByLabel("Invitation link", { exact: true }),
  ).toBeVisible();
  await expect(addPanel.getByRole("button", { name: /sign in/i })).toHaveCount(
    0,
  );
  const screenshotDir = path.join(project, "release", "smoke-results");
  await fs.mkdir(screenshotDir, { recursive: true });
  await page.screenshot({
    path: path.join(screenshotDir, "add-panel-invitation.png"),
  });
  await addPanel
    .getByLabel("Invitation link", { exact: true })
    .fill("https://uncontacted.example.test");
  await addPanel
    .getByRole("button", { name: "Continue with invitation", exact: true })
    .click();
  await expect(addPanel.getByRole("alert")).toContainText(
    "complete invitation link",
  );
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.mcPanelConnections.list()).panels.filter(
          (panel) => !panel.local,
        ).length,
    ),
    0,
    "An address alone must not contact or save a remote panel.",
  );
  await page.keyboard.press("Escape");
  await expect(accountMenu).toBeFocused();
  await accountMenu.click();
  await page
    .getByRole("menuitem", { name: "Manage Connections", exact: true })
    .click();
  const connectionManager = page.getByRole("dialog", {
    name: "Manage Connections",
    exact: true,
  });
  await expect(connectionManager).toContainText("No saved panel connections.");
  await expect(
    connectionManager.getByLabel("Panel address", { exact: true }),
  ).toHaveCount(0);
  await expect(
    connectionManager.getByRole("button", {
      name: "Sign in to existing panel",
      exact: true,
    }),
  ).toHaveCount(0);
  await connectionManager
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(connectionManager).not.toBeVisible();
  const signIn = page.getByRole("dialog", { name: "Sign in", exact: true });
  await expect(
    signIn.getByLabel("Panel address", { exact: true }),
  ).toBeVisible();
  await expect(
    signIn.getByLabel("Email address", { exact: true }),
  ).toBeVisible();
  await expect(signIn.getByLabel("Password", { exact: true })).toBeVisible();
  await page.screenshot({
    path: path.join(screenshotDir, "manage-existing-panel.png"),
  });
  await signIn
    .getByLabel("Panel address", { exact: true })
    .fill("http://uncontacted.example.test");
  await signIn
    .getByRole("button", {
      name: "Sign in",
      exact: true,
    })
    .click();
  await expect(signIn.getByRole("alert")).toContainText("HTTPS");
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.mcPanelConnections.list()).panels.filter(
          (panel) => !panel.local,
        ).length,
    ),
    0,
  );
  await page.keyboard.press("Escape");
  await expect(signIn).not.toBeVisible();
  await expect(accountMenu).toBeFocused();
  const inspect = () =>
    application.evaluate(({ BrowserWindow, Menu }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        nativeMenu: Menu.getApplicationMenu() !== null,
        menuVisible: window.isMenuBarVisible(),
        windowDestroyed: window.isDestroyed(),
        tray: globalThis.__mcPanelTraySmoke?.(),
      };
    });
  let state = await inspect();
  assert.equal(state.nativeMenu, false);
  assert.equal(state.menuVisible, false);
  assert.equal(state.tray.alive, true);
  assert.ok(state.tray.actions.includes("Open MC Panel"));
  assert.ok(state.tray.actions.includes("Quit MC Panel"));
  assert.deepEqual(
    state.tray.items.find(
      (item) => item.label === "Updates require the Setup edition",
    ),
    { label: "Updates require the Setup edition", enabled: false },
  );
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("mc-panel.launchpad.rows")),
    )
    .toBe("25");
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem("mc-panel.launchpad.view.default"),
    ),
    '{"platform":"modrinth","type":"mod","installedOnly":true}',
  );
  const firstToken = await application.evaluate(
    async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({
          name: "mc-panel-desktop",
        })
      )[0].value,
  );
  await page.keyboard.press("Alt");
  state = await inspect();
  assert.equal(state.nativeMenu, false);
  assert.equal(
    state.menuVisible,
    false,
    "Alt must not reveal the removed menu.",
  );

  const selection = await page.evaluate(async () => {
    const create = async (name, port) => {
      const response = await fetch("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, port }),
      });
      if (!response.ok) throw new Error("Fixture server creation failed.");
      return (await response.json()).server.id;
    };
    const first = await create("First fixture world", 25565);
    const second = await create("Second fixture world", 25566);
    await window.mcPanelConnections.selectServer("local", first);
    const result = await window.mcPanelConnections.selectServer(
      "local",
      second,
    );
    const persisted = await window.mcPanelConnections.list();
    return {
      selected: second,
      persisted: persisted.selectedServer,
      activeId: result.activeId,
      localServers: result.localServers,
    };
  });
  assert.deepEqual(selection.persisted, {
    panelId: "local",
    serverId: selection.selected,
  });
  assert.equal(selection.activeId, "local");
  assert.equal(selection.localServers.length, 2);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(root, "profile", "data", "desktop-workspace.json"),
        "utf8",
      ),
    ).selectedServer,
    selection.persisted,
  );
  // IPC selection persists before the renderer refreshes its server roster.
  // Wait for the selected workspace so its mount cannot dismiss this dialog.
  await expect(
    page.getByRole("button", {
      name: "Select server Second fixture world on This computer",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true", { timeout: 15000 });
  await expect(
    page.getByRole("group", {
      name: "Power controls for Second fixture world",
      exact: true,
    }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByRole("button", { name: "App updates", exact: true }),
  ).toBeVisible();
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("mc-panel-updates-open");
  });
  await expect(
    page.getByRole("dialog", {
      name: "App updates on this computer",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close app updates" }).click();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  state = await inspect();
  assert.equal(state.windowDestroyed, false);
  assert.equal(state.tray.alive, true);
  assert.equal(
    await page.evaluate(async () => (await fetch("/api/servers")).status),
    200,
  );
  assert.equal(
    await page.evaluate(
      async () =>
        (
          await fetch("/api/desktop/preferences", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              key: "mc-panel.launchpad.rows",
              value: "75",
            }),
          })
        ).status,
    ),
    204,
  );
  await application.close();
  application = await launch();
  const reopened = await application.firstWindow();
  await expect
    .poll(() =>
      reopened.evaluate(
        async () => (await window.mcPanelConnections.list()).selectedServer,
      ),
    )
    .toEqual(selection.persisted);
  await expect
    .poll(() =>
      reopened.evaluate(() => localStorage.getItem("mc-panel.launchpad.rows")),
    )
    .toBe("75");
  assert.equal(
    await reopened.evaluate(() =>
      sessionStorage.getItem("mc-panel.launchpad.view.default"),
    ),
    '{"platform":"modrinth","type":"mod","installedOnly":true}',
  );
  const secondToken = await application.evaluate(
    async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({
          name: "mc-panel-desktop",
        })
      )[0].value,
  );
  assert.notEqual(
    firstToken,
    secondToken,
    "UI preference persistence must not persist the owner credential",
  );
  await reopened
    .getByRole("button", { name: "Panel Settings", exact: true })
    .click();
  const settingsDialog = reopened.getByRole("dialog", {
    name: "Panel Settings",
    exact: true,
  });
  await expect(settingsDialog).toBeVisible();
  await settingsDialog
    .getByRole("button", { name: "App updates", exact: true })
    .click();
  await expect
    .poll(
      () =>
        application
          .windows()
          .filter((page) => page.url().includes("?app-updates=1")).length,
    )
    .toBe(1);
  const settingsUpdater = application
    .windows()
    .find((page) => page.url().includes("?app-updates=1"));
  assert.equal(
    new URL(settingsUpdater.url()).origin,
    new URL(reopened.url()).origin,
  );
  await expect(
    settingsUpdater.getByRole("dialog", {
      name: "App updates on this computer",
      exact: true,
    }),
  ).toBeVisible();
  await settingsUpdater
    .getByRole("button", { name: "Close app updates" })
    .click();
  await expect(settingsDialog).toBeVisible();
  await expect(
    settingsDialog.getByRole("switch", {
      name: "Start MC Panel when I sign in",
      exact: true,
    }),
  ).toBeDisabled();
  const keepInTray = settingsDialog.getByRole("switch", {
    name: "Keep MC Panel in the system tray",
    exact: true,
  });
  await expect(keepInTray).toBeChecked();
  await keepInTray.click();
  await settingsDialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect
    .poll(() =>
      reopened.evaluate(
        async () =>
          (await (await fetch("/api/desktop/settings")).json()).keepInTray,
      ),
    )
    .toBe(false);
  await settingsDialog
    .getByRole("button", { name: "Close Panel Settings", exact: true })
    .click();
  await application.close();
  application = await launch();
  const withoutTrayClose = await application.firstWindow();
  await expect
    .poll(() =>
      withoutTrayClose.evaluate(
        async () =>
          (await (await fetch("/api/desktop/settings")).json()).keepInTray,
      ),
    )
    .toBe(false);
  const closed = application.waitForEvent("close", { timeout: 15000 });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await closed;
  application = undefined;
  console.log(
    "Passed real Electron source smoke: native menu removed including Alt, tray lifecycle preserved, disabling close-to-tray persists and quits on window close, unsupported startup and updates disabled, immediate update dialog, and display preferences and unified server selection survive relaunch with a new private owner credential.",
  );
} finally {
  if (application) await application.close().catch(() => {});
  const resolved = await fs.realpath(root);
  assert.equal(
    path.dirname(resolved).toLowerCase(),
    (await fs.realpath(os.tmpdir())).toLowerCase(),
  );
  assert.ok(path.basename(resolved).startsWith("mc-menu-electron-smoke-"));
  assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
  await fs.rm(resolved, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 300,
  });
}
