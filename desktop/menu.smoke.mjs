// Source-entry Electron smoke: no native menu (including Alt), live tray, and
// native local selection flush ordering. Uses only a temporary app profile.
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
    const events = [];
    window.addEventListener("mc-panel-local-server-selected", (event) =>
      events.push(event.detail),
    );
    // Simulate the owner's older pending save. Main must flush this before the
    // requested native selection so the earlier choice cannot win the race.
    window.__mcPanelFlushSelection = async () => {
      const response = await fetch("/api/desktop/selection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeServerId: first }),
      });
      if (!response.ok) throw new Error("Fixture flush failed.");
    };
    const result = await window.mcPanelConnections.selectLocalServer(second);
    const persisted = await (await fetch("/api/desktop/selection")).json();
    return {
      selected: second,
      persisted: persisted.activeServerId,
      activeId: result.activeId,
      localServers: result.localServers,
      events,
    };
  });
  assert.equal(selection.persisted, selection.selected);
  assert.equal(selection.activeId, "local");
  assert.equal(selection.localServers.length, 2);
  assert.deepEqual(selection.events, [{ serverId: selection.selected }]);
  await expect(
    page.getByRole("button", { name: "App updates", exact: true }),
  ).toBeVisible();
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("mc-panel-updates-open");
  });
  await expect(
    page.getByRole("dialog", { name: "App updates", exact: true }),
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
  console.log(
    "Passed real Electron source smoke: native menu removed including Alt, tray lifecycle preserved, unsupported updates disabled, immediate update dialog, local display preferences survive relaunch with a new private credential, and owner selection flush/persist/event ordering.",
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
