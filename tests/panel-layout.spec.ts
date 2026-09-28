import { expect, test, type Page } from "@playwright/test";
import catalog from "../shared/subuser-permissions.json" with { type: "json" };

const permissions = catalog.groups.flatMap((group) =>
  group.permissions.map((permission) => permission.id),
);
const stamp = "2026-09-20T12:00:00.000Z";
const server = {
  id: "layout-server",
  name: "Shared world",
  mode: "live",
  status: "running",
  software: "Paper",
  version: "1.21.1",
  minecraftVersion: "1.21.1",
  address: "play.example.test",
  players: [],
  maxPlayers: 20,
  uptime: 60,
  cpu: 0,
  cpuCapacity: 800,
  memory: 0,
  memoryLimit: 2048 * 1024 ** 2,
  disk: 1024,
  diskLimit: 1024 ** 3,
  port: 25565,
  memoryLimitMB: 2048,
  jar: "server.jar",
  javaPath: "java",
};

// Exercise the same renderer with a native local-owner bridge and the real
// browser connection controller. Only API data is mocked; both use built CSS.
async function workspace(page: Page, local: boolean, grants = permissions) {
  await page.addInitScript(
    ({ server, local, grants }) => {
      localStorage.clear();
      if (!local) {
        localStorage.setItem("mc-panel.session.v1", "p".repeat(43));
        return;
      }
      const selected = { ...server, accessPermissions: grants };
      const state = {
        ready: true,
        unified: true,
        activeId: "local",
        selectedServer: { panelId: "local", serverId: server.id },
        localServers: [selected],
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
        ],
      };
      Object.assign(window, {
        mcPanelConnections: {
          unified: true,
          runtime: "desktop",
          list: async () => structuredClone(state),
          selectServer: async (panelId: string, serverId: string) => {
            state.selectedServer = { panelId, serverId };
            window.dispatchEvent(new Event("mc-panel-connections-changed"));
            return structuredClone(state);
          },
        },
      });
    },
    { server, local, grants },
  );
  const requests: string[] = [];
  const unexpected: string[] = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const proxy = url.pathname.match(
      /^\/api\/desktop\/panels\/([^/]+)\/proxy(\/api\/.*)$/,
    );
    const path = proxy?.[2] ?? url.pathname;
    requests.push(path);
    const json: Record<string, unknown> = {
      "/api/access/session": local
        ? { role: "owner" }
        : {
            role: "subuser",
            accountId: "member",
            userId: "member",
            email: "member@example.test",
            serverId: server.id,
            permissions: grants,
            hostPermissions: [],
          },
      "/api/desktop/preferences": { desktop: true, preferences: {} },
      "/api/desktop/selection": {
        desktop: true,
        activeServerId: server.id,
      },
      "/api/servers": {
        servers: [{ ...server, accessPermissions: grants }],
        defaultServerId: server.id,
      },
      "/api/server": { ...server, accessPermissions: grants },
      "/api/console": {
        lines: [
          { id: 1, time: "12:00:00", level: "INFO", message: "Server ready" },
        ],
      },
      "/api/files": {
        path: "",
        entries: [
          {
            name: "notes.txt",
            path: "notes.txt",
            type: "file",
            size: 13,
            modified: stamp,
          },
          {
            name: "world",
            path: "world",
            type: "directory",
            size: 0,
            modified: stamp,
          },
        ],
      },
      "/api/files/recycle-bin": { protected: true, items: [] },
      "/api/files/recycle-operation": { operation: null },
      "/api/players": {
        mode: "live",
        status: "running",
        operators: [],
        online: [
          {
            name: "Builder",
            online: true,
            firstSeen: stamp,
            lastSeen: stamp,
            source: "observed",
            banned: false,
          },
        ],
        history: [],
        banned: [],
        whitelist: [],
        whitelistEnabled: false,
        whitelistAvailable: true,
        whitelistSettingsAvailable: true,
      },
      "/api/versions": {
        providers: [
          {
            id: "paper",
            name: "Paper",
            description: "Plugin server",
            website: "https://papermc.io",
            installable: true,
            kind: "server",
          },
        ],
        current: { ...server, status: "offline" },
        runtimeUpdate: {
          available: false,
          provider: "paper",
          gameVersion: "1.21.1",
          build: null,
        },
      },
      "/api/launchpad": {
        platforms: [
          {
            id: "modrinth",
            name: "Modrinth",
            available: true,
            types: ["plugin"],
            sortOptions: [{ id: "downloads", label: "Downloads" }],
          },
        ],
        gameVersion: "1.21.1",
        gameVersions: ["1.21.1"],
        loader: "paper",
        loaders: ["paper"],
        status: "offline",
        warnings: [],
      },
      "/api/launchpad/search": {
        projects: [
          {
            id: "fixture-plugin",
            platform: "modrinth",
            title: "Fixture Plugin",
            description: "Catalog fixture",
            downloads: 1,
          },
        ],
        total: 1,
        offset: 0,
        limit: 10,
      },
      "/api/launchpad/installed": { items: [], warnings: [] },
      "/api/minecraft/properties": {
        files: [{ path: "server.properties", name: "server.properties" }],
      },
      "/api/minecraft/properties/file": {
        path: "server.properties",
        revision: "fixture",
        status: "running",
        fields: [
          {
            key: "max-players",
            label: "max players",
            type: "number",
            value: 20,
          },
        ],
      },
      "/api/subusers": {
        users: [
          {
            id: "helper",
            email: "helper@example.test",
            permissions: ["server.view"],
            createdAt: stamp,
          },
        ],
      },
      "/api/panel-users": { users: [] },
      "/api/backups": {
        backups: [
          {
            id: "archive",
            name: "Before changes",
            size: 1024,
            createdAt: stamp,
            status: "completed",
            trigger: "manual",
          },
        ],
        schedule: {
          enabled: false,
          type: "interval",
          intervalHours: 6,
          time: "03:00",
          dayOfWeek: 0,
          retention: 7,
          nextRun: null,
        },
      },
      "/api/audit": {
        entries: [
          {
            id: "layout-event",
            action: "file.edited",
            detail: "Updated server.properties",
            actor: "member@example.test",
            category: "file",
            createdAt: stamp,
          },
        ],
      },
    };
    if (
      local &&
      path === "/api/desktop/preferences" &&
      request.method() === "PUT"
    )
      return route.fulfill({ json: { desktop: true, preferences: {} } });
    if (Object.hasOwn(json, path) && request.method() === "GET")
      return route.fulfill({ json: json[path] });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({
      status: 404,
      json: { error: "Unexpected layout fixture request" },
    });
  });
  return { requests, unexpected };
}

const pages = [
  { id: "console", root: ".server-banner", ready: ".console-output" },
  { id: "files", root: ".storage-page", ready: ".file-table" },
  { id: "players", root: ".players-page", ready: ".players-online-banner" },
  { id: "versions", root: ".versions-page", ready: ".version-provider" },
  { id: "launchpad", root: ".launchpad-page", ready: ".launchpad-filters" },
  { id: "properties", root: ".properties-page", ready: ".property-field" },
  { id: "subusers", root: ".subusers-page", ready: ".subusers-table" },
  { id: "backups", root: ".storage-page", ready: ".backup-stats" },
  { id: "audit", root: ".management-page", ready: ".management-audit-table" },
];

async function geometry(page: Page, selector: string) {
  return page.evaluate((selector) => {
    const main = document.querySelector<HTMLElement>(".main-content")!;
    const root = document.querySelector<HTMLElement>(selector)!;
    const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
    const mainBox = main.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    const styles = getComputedStyle(main);
    return {
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      mainLeft: mainBox.left,
      mainRight: mainBox.right,
      mainWidth: mainBox.width,
      pageLeft: rootBox.left,
      pageRight: rootBox.right,
      pageWidth: rootBox.width,
      paddingLeft: parseFloat(styles.paddingLeft),
      paddingRight: parseFloat(styles.paddingRight),
      sidebarRight: sidebar.getBoundingClientRect().right,
      fontSize: styles.fontSize,
      rootZoom: getComputedStyle(document.documentElement).zoom,
      bodyZoom: getComputedStyle(document.body).zoom,
      consoleHeight:
        document.querySelector(".console-output")?.getBoundingClientRect()
          .height ?? null,
    };
  }, selector);
}

for (const viewport of [
  { width: 1440, height: 960 },
  { width: 2560, height: 1368 },
  { width: 390, height: 844 },
]) {
  test(`local and remote pages fill the shared layout at ${viewport.width}x${viewport.height}`, async ({
    browser,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    // Separate contexts keep preferences and account state independent.
    const localContext = await browser.newContext({ viewport, baseURL });
    const remoteContext = await browser.newContext({ viewport, baseURL });
    try {
      const localPage = await localContext.newPage();
      const remotePage = await remoteContext.newPage();
      const local = await workspace(localPage, true);
      const remote = await workspace(remotePage, false);
      const snapshots: Record<string, unknown> = {};
      for (const entry of pages) {
        const measurements = [];
        for (const [mode, page] of [
          ["local", localPage],
          ["remote", remotePage],
        ] as const) {
          await page.goto(`/#${entry.id}`);
          await expect(page.locator(entry.ready).first()).toBeVisible();
          expect(
            await page.evaluate(() => window.mcPanelConnections?.runtime),
          ).toBe(mode === "local" ? "desktop" : "browser");
          await page.evaluate(() => document.fonts.ready);
          const measured = await geometry(page, entry.root);
          const label = `${mode} ${entry.id}`;
          expect(
            measured.scrollWidth,
            `${label}: no horizontal document overflow`,
          ).toBeLessThanOrEqual(measured.viewport + 1);
          expect(
            measured.mainRight,
            `${label}: shell reaches viewport edge`,
          ).toBeCloseTo(measured.viewport, 0);
          expect(
            measured.mainLeft,
            `${label}: shell starts beside the sidebar`,
          ).toBeCloseTo(viewport.width <= 760 ? 0 : measured.sidebarRight, 0);
          expect(
            measured.pageLeft - measured.mainLeft,
            `${label}: only normal left padding`,
          ).toBeCloseTo(measured.paddingLeft, 0);
          expect(
            measured.mainRight - measured.pageRight,
            `${label}: only normal right padding`,
          ).toBeCloseTo(measured.paddingRight, 0);
          expect(measured.paddingLeft).toBeLessThanOrEqual(45);
          expect(measured.paddingRight).toBeLessThanOrEqual(45);
          // The app must leave display scaling to Windows/the browser.
          expect(measured.rootZoom).toBe("1");
          expect(measured.bodyZoom).toBe("1");
          await page.screenshot({
            path: testInfo.outputPath(`${mode}-${entry.id}.png`),
            fullPage: true,
          });
          snapshots[`${mode}-${entry.id}`] = measured;
          measurements.push(measured);
        }
        const [localSize, remoteSize] = measurements;
        expect(
          remoteSize,
          `${entry.id}: identical shell and page geometry for both account types`,
        ).toEqual(localSize);
      }
      expect(local.unexpected).toEqual([]);
      expect(remote.unexpected).toEqual([]);
      expect(remote.requests).not.toContain("/api/panel-users");
      await testInfo.attach("page-geometry.json", {
        body: JSON.stringify(snapshots, null, 2),
        contentType: "application/json",
      });
    } finally {
      await localContext.close();
      await remoteContext.close();
    }
  });
}

test("a wide remote layout keeps console content and actions permission-restricted", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 2560, height: 1368 });
  const fixture = await workspace(page, false, ["server.view"]);
  await page.goto("/#console");
  await expect(page.locator(".console-layout-summary")).toBeVisible();
  await expect(page.locator(".server-banner")).toContainText(server.name);
  await expect(page.locator(".console-output")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /command/i })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^(Start|Stop|Restart|Force stop)$/ }),
  ).toHaveCount(0);
  expect(fixture.requests).not.toContain("/api/console");
  const measured = await geometry(page, ".server-banner");
  expect(measured.mainRight - measured.pageRight).toBeCloseTo(
    measured.paddingRight,
    0,
  );
  expect(measured.scrollWidth).toBeLessThanOrEqual(measured.viewport + 1);
  expect(fixture.unexpected).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("restricted-console.png"),
    fullPage: true,
  });
});
