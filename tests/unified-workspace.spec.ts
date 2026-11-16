import { test, expect, type Page } from "@playwright/test";

const permissions = [
  "server.view",
  "control.console",
  "control.command",
  "control.start",
  "control.stop",
  "file.read",
  "file.read-content",
  "file.update",
  "backup.read",
  "server.update",
];
const server = {
  id: "same-id",
  name: "Same name",
  mode: "live",
  status: "offline",
  software: "Paper",
  version: "1.21.1",
  minecraftVersion: "1.21.1",
  address: "play.example.test",
  players: [],
  maxPlayers: 20,
  uptime: 0,
  cpu: 0,
  memory: 0,
  memoryLimit: 2048,
  disk: 0,
  diskLimit: 1024 ** 3,
  port: 25565,
  memoryLimitMB: 2048,
  jar: "server.jar",
  javaPath: "java",
  accessPermissions: permissions,
};

async function fixture(
  page: Page,
  options: { local?: boolean; createRemote?: boolean; empty?: boolean } = {},
) {
  const local = !options.empty && options.local !== false;
  await page.addInitScript(
    ({ server, local, createRemote, empty }) => {
      const state = {
        unified: true,
        activeId: "local",
        selectedServer: (empty
          ? null
          : { panelId: local ? "local" : "a", serverId: server.id }) as {
          panelId: string;
          serverId: string;
        } | null,
        localServers: local ? [server] : [],
        panels: [
          {
            id: "local",
            local: true,
            label: "This computer",
            origin: location.origin,
            signedIn: true,
            connectionState: "connected",
            servers: [],
          },
          ...["a", "c"].map((id) => ({
            id,
            local: false,
            label: `Computer ${id.toUpperCase()}`,
            origin: `https://${id}.example.test`,
            signedIn: true,
            connectionState: "connected",
            sessionEpoch: `${id}-epoch`,
            servers: empty ? [] : [server],
            session: {
              role: "subuser",
              email: `${id}@example.test`,
              userId: id,
              serverId: server.id,
              permissions: [],
              hostPermissions: createRemote ? ["server.create"] : [],
            },
          })),
        ],
      };
      const events: unknown[] = [];
      const changed = () =>
        window.dispatchEvent(new Event("mc-panel-connections-changed"));
      Object.assign(window, {
        unifiedFixture: { state, events, changed },
        mcPanelConnections: {
          unified: true,
          list: async () => structuredClone(state),
          selectServer: async (panelId: string, serverId: string) => {
            events.push({ action: "select", panelId, serverId });
            state.selectedServer = { panelId, serverId };
            changed();
            return structuredClone(state);
          },
          retry: async (panelId: string) => {
            events.push({ action: "retry", panelId });
            const panel = state.panels.find((item) => item.id === panelId)!;
            panel.connectionState = "connected";
            changed();
            return structuredClone(state);
          },
          signOut: async (panelId: string) => {
            events.push({ action: "signOut", panelId });
            const panel = state.panels.find((item) => item.id === panelId)!;
            panel.signedIn = false;
            panel.servers = [];
            changed();
            return structuredClone(state);
          },
          activate: async () => {
            throw new Error(
              "A unified workspace cannot activate a panel frontend.",
            );
          },
          openUpdates: async () => events.push({ action: "updates" }),
        },
      });
      localStorage.removeItem("mc-panel.navigation-collapsed");
    },
    {
      server,
      local,
      createRemote: Boolean(options.createRemote),
      empty: Boolean(options.empty),
    },
  );
  const calls: {
    panel: string;
    path: string;
    method: string;
    serverId: string | null;
    epoch: string | null;
    body: unknown;
  }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const proxy = url.pathname.match(
      /^\/api\/desktop\/panels\/([^/]+)\/proxy(\/api\/.*)$/,
    );
    const panel = proxy?.[1] ?? "local";
    const path = proxy?.[2] ?? url.pathname;
    const serverId =
      url.searchParams.get("serverId") ??
      request.headers()["x-server-id"] ??
      null;
    const method = request.method();
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      /* Multipart requests are recorded by target. */
    }
    calls.push({
      panel,
      path,
      method,
      serverId,
      epoch: url.searchParams.get("desktopEpoch"),
      body,
    });
    const reply = (json: unknown) => route.fulfill({ json });
    if (path === "/api/access/session") return reply({ role: "owner" });
    if (path === "/api/desktop/preferences")
      return reply({ desktop: true, preferences: {} });
    if (path === "/api/desktop/selection")
      return reply({ desktop: true, activeServerId: server.id });
    if (path === "/api/servers")
      return reply({
        servers: local ? [server] : [],
        defaultServerId: local ? server.id : null,
      });
    if (path === "/api/server")
      return reply({ ...server, address: `${panel}.minecraft.test` });
    if (path === "/api/server/settings")
      return reply({ server: { ...server, settingsRevision: panel } });
    if (path === "/api/console")
      return reply({
        lines: [
          {
            id: panel,
            time: "12:00:00",
            level: "INFO",
            message: `Console from ${panel}`,
          },
        ],
      });
    if (path === "/api/server/power" || path === "/api/console/command")
      return reply({ ok: true });
    if (path === "/api/files")
      return reply({
        path: "",
        entries: [
          {
            name: `${panel}.txt`,
            path: `${panel}.txt`,
            type: "file",
            size: 5,
            modified: "2026-09-27T12:00:00Z",
          },
        ],
      });
    if (path === "/api/files/recycle-bin")
      return reply({ items: [], protected: true });
    if (path === "/api/minecraft/properties")
      return reply({
        files: [{ path: "server.properties", name: "Server properties" }],
      });
    if (path === "/api/minecraft/properties/file")
      return reply({
        path: "server.properties",
        revision: panel,
        status: "offline",
        fields: [
          {
            key: "motd",
            label: "MOTD",
            type: "string",
            value: `Welcome ${panel}`,
          },
        ],
      });
    if (path === "/api/backups")
      return reply({
        backups: [],
        schedule: {
          enabled: false,
          type: "interval",
          intervalHours: 6,
          time: "03:00",
          dayOfWeek: 0,
          retention: 5,
          nextRun: null,
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: `Fixture has no ${path}` },
    });
  });
  return { calls };
}

const select = (page: Page, host: string) =>
  page
    .getByRole("button", {
      name: `Select server Same name on ${host}`,
      exact: true,
    })
    .click();

test("Panel Settings opens this computer's updater once from local and remote selections", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/desktop/settings", (route) =>
    route.fulfill({
      json: {
        desktop: true,
        startAtLogin: false,
        autoStartServerIds: [],
        keepInTray: false,
        startupSupported: true,
      },
    }),
  );
  await page.goto("/#console");
  await page.evaluate(() =>
    window.addEventListener("mc-panel-updates-open", () => {
      (window as any).unifiedFixture.events.push({
        action: "legacyUpdatesEvent",
      });
    }),
  );
  for (const [index, host] of ["This computer", "Computer A"].entries()) {
    await select(page, host);
    await expect(
      page.getByRole("button", { name: "App updates", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Panel Settings", exact: true })
      .click();
    const settings = page.getByRole("dialog", {
      name: "Panel Settings",
      exact: true,
    });
    await settings
      .getByRole("button", { name: "App updates", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).unifiedFixture.events.filter(
              (item: any) => item.action === "updates",
            ).length,
        ),
      )
      .toBe(index + 1);
    expect(
      await page.evaluate(() =>
        (window as any).unifiedFixture.events.some(
          (item: any) => item.action === "legacyUpdatesEvent",
        ),
      ),
    ).toBe(false);
    await settings
      .getByRole("button", { name: "Close Panel Settings", exact: true })
      .click();
  }
});

test("one workspace routes colliding local and remote servers to their own hosts", async ({
  page,
}, testInfo) => {
  const { calls } = await fixture(page);
  await page.goto("/#console");
  const initialUrl = page.url();
  for (const [host, id] of [
    ["This computer", "local"],
    ["Computer A", "a"],
    ["Computer C", "c"],
    ["This computer", "local"],
  ]) {
    await select(page, host);
    await expect(
      page.getByText(`Console from ${id}`, { exact: true }),
    ).toBeVisible();
    for (const group of ["this computer", "Computer A", "Computer C"])
      await expect(
        page.getByRole("list", { name: `Servers on ${group}`, exact: true }),
      ).toBeVisible();
    await page
      .getByRole("group", { name: "Power controls for Same name" })
      .getByRole("button", { name: "Start", exact: true })
      .click();
    await expect
      .poll(
        () =>
          calls.filter(
            (call) => call.panel === id && call.path === "/api/server/power",
          ).length,
      )
      .toBeGreaterThan(0);
    expect(page.url()).toBe(initialUrl);
    if (id === "a")
      await page.screenshot({
        path: testInfo.outputPath("unified-desktop.png"),
        fullPage: true,
      });
  }
  const mutations = calls.filter((call) => call.method === "POST");
  expect(mutations.map((call) => call.panel)).toEqual([
    "local",
    "a",
    "c",
    "local",
  ]);
  expect(mutations.every((call) => call.serverId === server.id)).toBe(true);
  expect(
    mutations
      .filter((call) => call.panel !== "local")
      .every((call) => call.epoch === `${call.panel}-epoch`),
  ).toBe(true);
  expect(page.context().pages()).toHaveLength(1);
});

test("editing a remote server refreshes its current page without selecting Console", async ({
  page,
}) => {
  await fixture(page, { local: false });
  await page.goto("/#properties");
  await expect(
    page.getByRole("textbox", { name: "MOTD", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Server settings",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Server name", exact: true })
    .fill("Updated A");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).unifiedFixture.events.some(
          (item: any) => item.action === "retry" && item.panelId === "a",
        ),
      ),
    )
    .toBe(true);
  await expect(page).toHaveURL(/#properties$/);
  await expect(
    page.getByRole("textbox", { name: "MOTD", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).unifiedFixture.events.filter(
        (item: any) => item.action === "select",
      ),
    ),
  ).toEqual([]);
});

test("a settings response after permission revocation cannot close a replacement manager or change hosts", async ({
  page,
}) => {
  await fixture(page, { local: false });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saving = false;
  await page.route(
    "**/api/desktop/panels/a/proxy/api/server/settings?**",
    async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      saving = true;
      await pending;
      return route.fulfill({
        json: {
          server: { ...server, name: "Updated A", settingsRevision: "saved" },
        },
      });
    },
  );
  await page.goto("/#console");
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Server settings",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Server name", exact: true })
    .fill("Updated A");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect.poll(() => saving).toBe(true);
  await page.evaluate(() => {
    const fixture = (window as any).unifiedFixture;
    const panel = fixture.state.panels.find((item: any) => item.id === "a");
    panel.servers = panel.servers.map((item: any) => ({
      ...item,
      accessPermissions: item.accessPermissions.filter(
        (permission: string) => permission !== "server.update",
      ),
    }));
    fixture.changed();
  });
  await expect(dialog).toHaveCount(0);
  await select(page, "Computer C");
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Server name", exact: true })
    .fill("Keep C draft");
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().includes("/panels/a/proxy/api/server/settings"),
  );
  release();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(
    dialog.getByRole("textbox", { name: "Server name", exact: true }),
  ).toHaveValue("Keep C draft");
  expect(
    await page.evaluate(
      () => (window as any).unifiedFixture.state.selectedServer.panelId,
    ),
  ).toBe("c");
  expect(
    await page.evaluate(() =>
      (window as any).unifiedFixture.events.filter(
        (item: any) => item.action === "retry" && item.panelId === "a",
      ),
    ),
  ).toEqual([]);
});

test("finishing an import refresh cannot override a newer server selection", async ({
  page,
}) => {
  await fixture(page, { local: false, createRemote: true });
  const imported = {
    ...server,
    id: "created-server",
    name: "Imported world",
    port: 25566,
  };
  await page.route(
    "**/api/desktop/panels/a/proxy/api/server-import/inspect?**",
    (route) =>
      route.fulfill({
        json: {
          directory: "C:\\fixtures\\import",
          name: imported.name,
          port: imported.port,
          motd: "Imported",
          maxPlayers: 20,
          jars: ["server.jar"],
          jar: "server.jar",
          eulaAccepted: true,
          warnings: [],
        },
      }),
  );
  await page.route(
    "**/api/desktop/panels/a/proxy/api/server-import?**",
    async (route) => {
      await page.evaluate((created) => {
        (window as any).unifiedFixture.state.panels
          .find((item: any) => item.id === "a")
          .servers.push(created);
      }, imported);
      return route.fulfill({ json: { server: imported } });
    },
  );
  await page.goto("/#console");
  await page.evaluate(() => {
    const bridge = window.mcPanelConnections!;
    const retry = bridge.retry!;
    bridge.retry = async (panelId) => {
      await new Promise<void>((resolve) => {
        (window as any).unifiedFixture.releaseRetry = resolve;
      });
      return retry(panelId);
    };
  });
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Choose a computer", exact: true })
    .getByRole("button", { name: "Computer A", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import an existing server", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Import an existing server",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Server folder", exact: true })
    .fill("C:\\fixtures\\import");
  await dialog
    .getByRole("button", { name: "Inspect folder", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Server name", exact: true }),
  ).toHaveValue(imported.name);
  await dialog
    .getByRole("button", { name: "Import server", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).unifiedFixture.releaseRetry),
    )
    .toBe("function");
  await select(page, "Computer C");
  await expect(page.getByText("Console from c", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).unifiedFixture.releaseRetry());
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).unifiedFixture.events.some(
          (item: any) => item.action === "retry" && item.panelId === "a",
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(
    await page.evaluate(
      () => (window as any).unifiedFixture.state.selectedServer.panelId,
    ),
  ).toBe("c");
  expect(
    await page.evaluate(() =>
      (window as any).unifiedFixture.events.filter(
        (item: any) =>
          item.action === "select" && item.serverId === "created-server",
      ),
    ),
  ).toEqual([]);
});

test("empty workspace offers host setup only for a separate computer grant", async ({
  page,
}) => {
  const { calls } = await fixture(page, { empty: true, createRemote: true });
  await page.goto("/#console");
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create a new server", exact: true })
    .click();
  const chooser = page.getByRole("dialog", {
    name: "Choose a computer",
    exact: true,
  });
  await expect(
    chooser.getByRole("button", { name: "This computer", exact: true }),
  ).toBeVisible();
  await chooser
    .getByRole("button", { name: "Computer C", exact: true })
    .click();
  await expect
    .poll(() =>
      calls.some(
        (call) => call.panel === "c" && call.path === "/api/server-setup",
      ),
    )
    .toBe(true);
  expect(
    calls
      .filter((call) => call.path.startsWith("/api/server-setup"))
      .every((call) => call.panel === "c" && call.epoch === "c-epoch"),
  ).toBe(true);
});

test("combined selector stays reachable on a narrow remote workspace", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { local: false });
  await page.goto("/#console");
  await expect(page.getByText("Console from a", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  for (const host of ["Computer A", "Computer C"])
    await expect(
      page.getByRole("button", {
        name: `Select server Same name on ${host}`,
        exact: true,
      }),
    ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("unified-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await select(page, "Computer C");
  await expect(page.getByText("Console from c", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("remote workspace routes files backups and properties, preserving separate drafts for identical IDs", async ({
  page,
}) => {
  const { calls } = await fixture(page, { local: false });
  await page.goto("/#console");
  await select(page, "Computer A");
  await page.getByRole("link", { name: "File Manager", exact: true }).click();
  await expect(page.getByText("a.txt", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Backups", exact: true }).click();
  await expect
    .poll(() =>
      calls.some((call) => call.panel === "a" && call.path === "/api/backups"),
    )
    .toBe(true);
  await page.getByRole("link", { name: "Properties", exact: true }).click();
  await page
    .getByRole("textbox", { name: "MOTD", exact: true })
    .fill("Unsaved A draft");
  await select(page, "Computer C");
  await page.getByRole("link", { name: "Properties", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "MOTD", exact: true }),
  ).toHaveValue("Welcome c");
  await page
    .getByRole("textbox", { name: "MOTD", exact: true })
    .fill("Unsaved C draft");
  await select(page, "Computer A");
  await page.getByRole("link", { name: "Properties", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "MOTD", exact: true }),
  ).toHaveValue("Unsaved A draft");
  expect(
    calls
      .filter((call) =>
        /\/api\/(files|backups|minecraft\/properties)/.test(call.path),
      )
      .every((call) => call.panel !== "local" && call.serverId === server.id),
  ).toBe(true);
});

test("offline selected panel keeps unavailable rows and removes operations until reconnect", async ({
  page,
}, testInfo) => {
  const { calls } = await fixture(page, { local: false });
  await page.goto("/#console");
  await expect(page.getByText("Console from a", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const fixture = (window as any).unifiedFixture;
    fixture.state.panels.find(
      (panel: any) => panel.id === "a",
    ).connectionState = "unavailable";
    fixture.changed();
  });
  await expect(
    page.getByRole("heading", { name: "Computer unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Select server Same name on Computer A",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("group", { name: "Power controls for Same name" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", {
      name: "Select server Same name on Computer C",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("unified-offline-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  const last = calls.length;
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByText("Console from a", { exact: true })).toBeVisible();
  expect(
    calls
      .slice(last)
      .some((call) => call.panel === "a" && call.epoch === "a-epoch"),
  ).toBe(true);
  await select(page, "Computer C");
  await expect(page.getByText("Console from c", { exact: true })).toBeVisible();
});

test("revoking one panel's permissions never grants local owner controls or changes the other panel", async ({
  page,
}) => {
  const { calls } = await fixture(page, { local: false });
  await page.goto("/#console");
  await expect(page.getByText("Console from a", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const fixture = (window as any).unifiedFixture;
    const a = fixture.state.panels.find((panel: any) => panel.id === "a");
    a.servers = a.servers.map((item: any) => ({
      ...item,
      accessPermissions: ["server.view", "control.console"],
    }));
    fixture.changed();
  });
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "File Manager", exact: true }),
  ).toHaveCount(0);
  await select(page, "Computer C");
  await expect(
    page.getByRole("link", { name: "File Manager", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("group", { name: "Power controls for Same name" })
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await expect
    .poll(() =>
      calls.filter((call) => call.method === "POST").map((call) => call.panel),
    )
    .toEqual(["c"]);
});
