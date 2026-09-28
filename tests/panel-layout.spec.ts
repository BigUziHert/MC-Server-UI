import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
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

// Exercise the built renderer with local/remote native bridges and the real
// browser connection controller. Server data and native bridge calls are mocked.
async function workspace(
  page: Page,
  local: boolean,
  grants = permissions,
  nativeRemote = false,
) {
  await page.addInitScript(
    ({ server, local, grants, nativeRemote }) => {
      localStorage.clear();
      if (!local && !nativeRemote) {
        localStorage.setItem("mc-panel.session.v1", "p".repeat(43));
        return;
      }
      const selected = { ...server, accessPermissions: grants };
      const state = {
        ready: true,
        unified: true,
        activeId: "local",
        selectedServer: {
          panelId: nativeRemote ? "remote" : "local",
          serverId: server.id,
        },
        localServers: local ? [selected] : [],
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
          ...(nativeRemote
            ? [
                {
                  id: "remote",
                  local: false,
                  label: "Remote computer",
                  origin: "https://remote.example.test",
                  signedIn: true,
                  connectionState: "connected",
                  sessionEpoch: "layout-epoch",
                  servers: [selected],
                  session: {
                    role: "subuser",
                    email: "member@example.test",
                    userId: "member",
                    serverId: server.id,
                    permissions: grants,
                    hostPermissions: [],
                  },
                },
              ]
            : []),
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
    { server, local, grants, nativeRemote },
  );
  const requests: string[] = [];
  const unexpected: string[] = [];
  const targets: { panel: string; path: string; serverId: string | null }[] =
    [];
  let players: { name: string }[] = [];
  let lines = [
    { id: 1, time: "12:00:00", level: "INFO", message: "Server ready" },
  ];
  await page.route("https://mc-heads.net/**", (route) => route.abort());
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const proxy = url.pathname.match(
      /^\/api\/desktop\/panels\/([^/]+)\/proxy(\/api\/.*)$/,
    );
    const path = proxy?.[2] ?? url.pathname;
    requests.push(path);
    targets.push({
      panel: proxy?.[1] ?? "local",
      path,
      serverId:
        url.searchParams.get("serverId") ??
        request.headers()["x-server-id"] ??
        null,
    });
    const json: Record<string, unknown> = {
      "/api/access/session":
        local || (nativeRemote && !proxy)
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
        servers:
          nativeRemote && !proxy
            ? []
            : [{ ...server, accessPermissions: grants }],
        defaultServerId: nativeRemote && !proxy ? null : server.id,
      },
      "/api/server": { ...server, players, accessPermissions: grants },
      "/api/console": { lines },
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
      (local || nativeRemote) &&
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
  return {
    requests,
    unexpected,
    targets,
    populateConsole(populated = true) {
      players = Array.from({ length: populated ? 45 : 0 }, (_, index) => ({
        name: `Player_${index}`,
      }));
      lines = Array.from({ length: populated ? 400 : 1 }, (_, index) => ({
        id: index + 1,
        time: "12:00:00",
        level: "INFO",
        message: populated
          ? `Layout log ${index}: ${"server output ".repeat(24)}`
          : "Server ready",
      }));
    },
  };
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

async function consoleGeometry(page: Page) {
  return page.evaluate(() => {
    const element = (selector: string) =>
      document.querySelector<HTMLElement>(selector)!;
    const box = (selector: string) => element(selector).getBoundingClientRect();
    const panel = box(".console-panel");
    const output = element(".console-output");
    const players = element(".players-list");
    const command = box(".command-form");
    return {
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      paddingBottom: parseFloat(
        getComputedStyle(element(".main-content")).paddingBottom,
      ),
      footerBottom: box(".footer").bottom + window.scrollY,
      panelHeight: panel.height,
      panelBottom: panel.bottom + window.scrollY,
      sideBottom: box(".console-side").bottom + window.scrollY,
      outputHeight: output.clientHeight,
      outputScrollHeight: output.scrollHeight,
      playersHeight: players.clientHeight,
      playersScrollHeight: players.scrollHeight,
      commandTop: command.top + window.scrollY,
      commandBottom: command.bottom + window.scrollY,
    };
  });
}

async function attachGeometry(
  testInfo: TestInfo,
  name: string,
  measured: unknown,
) {
  const path = testInfo.outputPath(name);
  await writeFile(path, JSON.stringify(measured, null, 2));
  await testInfo.attach(name, { path, contentType: "application/json" });
}

const consoleModes = ["local", "browser-remote", "native-remote"] as const;
for (const mode of consoleModes) {
  test(`console uses viewport height and internal scrolling for ${mode}`, async ({
    page,
  }, testInfo) => {
    const fixture = await workspace(
      page,
      mode === "local",
      permissions,
      mode === "native-remote",
    );
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/#console");
    await expect(page.getByRole("log")).toContainText("Server ready");
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => window.mcPanelConnections?.runtime)).toBe(
      mode === "browser-remote" ? "browser" : "desktop",
    );
    const measurements = [];
    for (const viewport of [
      { width: 1440, height: 960 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 960 },
      { width: 2560, height: 1368 },
      { width: 2560, height: 1392 },
    ]) {
      await page.setViewportSize(viewport);
      const measured = await consoleGeometry(page);
      measurements.push(measured);
      await attachGeometry(
        testInfo,
        `geometry-${viewport.width}x${viewport.height}.json`,
        measured,
      );
      await page.screenshot({
        path: testInfo.outputPath(
          `${mode}-${viewport.width}x${viewport.height}.png`,
        ),
      });
      expect
        .soft(measured.documentWidth, "no horizontal overflow")
        .toBeLessThanOrEqual(measured.viewportWidth + 1);
      if (viewport.height >= 1080) {
        expect
          .soft(
            measured.documentHeight,
            "the tall dashboard fits without document scrolling",
          )
          .toBeLessThanOrEqual(measured.viewportHeight + 1);
      }
      expect
        .soft(
          measured.documentHeight - measured.footerBottom,
          "footer ends at normal bottom padding, with no unused lower window or document",
        )
        .toBeCloseTo(measured.paddingBottom, 0);
      expect
        .soft(measured.panelBottom, "console and player sidebar end together")
        .toBeCloseTo(measured.sideBottom, 0);
      expect
        .soft(measured.outputHeight, "console retains a readable minimum")
        .toBeGreaterThanOrEqual(220);
      expect
        .soft(measured.commandBottom)
        .toBeLessThanOrEqual(measured.panelBottom);
    }
    const short = measurements[2];
    const tall = measurements[4];
    expect
      .soft(
        Math.abs(
          tall.outputHeight -
            short.outputHeight -
            (tall.viewportHeight - short.documentHeight),
        ),
        "same-width window growth becomes usable console space",
      )
      .toBeLessThanOrEqual(2);
    expect
      .soft(
        tall.outputHeight - measurements[3].outputHeight,
        "a taller window grows the console even without changing width breakpoints",
      )
      .toBeCloseTo(24, 0);
    fixture.populateConsole();
    await expect(page.locator(".online-players .player-row")).toHaveCount(45);
    await expect(page.getByRole("log")).toContainText("Layout log 399:");
    const populated = await consoleGeometry(page);
    expect(populated.panelHeight).toBeCloseTo(tall.panelHeight, 0);
    expect(populated.playersHeight).toBeCloseTo(tall.playersHeight, 0);
    expect(populated.documentHeight).toBeLessThanOrEqual(
      tall.documentHeight + 1,
    );
    expect(populated.documentWidth).toBeLessThanOrEqual(
      populated.viewportWidth + 1,
    );
    expect(populated.outputScrollHeight).toBeGreaterThan(
      populated.outputHeight,
    );
    expect(populated.playersScrollHeight).toBeGreaterThan(
      populated.playersHeight,
    );
    await expect(
      page.getByRole("textbox", { name: "Server command", exact: true }),
    ).toBeInViewport();
    if (mode === "native-remote") {
      expect(fixture.targets).toContainEqual({
        panel: "remote",
        path: "/api/console",
        serverId: server.id,
      });
      expect(
        fixture.targets
          .filter((target) => target.path === "/api/server")
          .every((target) => target.panel === "remote"),
      ).toBe(true);
      await expect(page.locator(".server-details")).toContainText(
        "Remote server",
      );
    }
    expect(fixture.unexpected).toEqual([]);
    await attachGeometry(
      testInfo,
      "populated-console-geometry.json",
      populated,
    );
    await page.screenshot({
      path: testInfo.outputPath(`${mode}-populated-tall.png`),
    });
  });

  test(`short and mobile console keeps controls reachable for ${mode}`, async ({
    page,
  }, testInfo) => {
    const fixture = await workspace(
      page,
      mode === "local",
      permissions,
      mode === "native-remote",
    );
    for (const viewport of [
      { width: 1280, height: 600 },
      { width: 390, height: 844 },
    ]) {
      fixture.populateConsole(false);
      await page.setViewportSize(viewport);
      await page.goto("/#console");
      await expect(page.getByRole("log")).toContainText("Server ready");
      await page.evaluate(() => document.fonts.ready);
      const before = await consoleGeometry(page);
      expect(before.outputHeight).toBeGreaterThanOrEqual(220);
      expect(before.documentWidth).toBeLessThanOrEqual(
        before.viewportWidth + 1,
      );
      expect(before.documentHeight).toBeGreaterThan(before.viewportHeight);
      fixture.populateConsole();
      await expect(page.locator(".online-players .player-row")).toHaveCount(45);
      await expect(page.getByRole("log")).toContainText("Layout log 399:");
      const after = await consoleGeometry(page);
      expect(after.panelHeight).toBeCloseTo(before.panelHeight, 0);
      expect(after.documentHeight).toBeLessThanOrEqual(
        before.documentHeight + 1,
      );
      expect(after.outputScrollHeight).toBeGreaterThan(after.outputHeight);
      expect(after.playersScrollHeight).toBeGreaterThan(after.playersHeight);
      const command = page.getByRole("textbox", {
        name: "Server command",
        exact: true,
      });
      await command.scrollIntoViewIfNeeded();
      await expect(command).toBeInViewport();
      await command.fill("help");
      await expect(command).toHaveValue("help");
      await page.locator(".footer").scrollIntoViewIfNeeded();
      await expect(page.locator(".footer")).toBeInViewport();
      await attachGeometry(
        testInfo,
        `geometry-${viewport.width}x${viewport.height}.json`,
        after,
      );
      await page.screenshot({
        path: testInfo.outputPath(
          `${mode}-${viewport.width}x${viewport.height}.png`,
        ),
        fullPage: true,
      });
    }
    expect(fixture.unexpected).toEqual([]);
  });
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
