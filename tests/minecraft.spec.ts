import { test as base, expect, type Route } from "@playwright/test";
import { removeTestServer, stopTestServer } from "./server-fixtures";

const test = base.extend<{ serverId: string }>({
  serverId: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29900;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const created = await request.post("/api/servers", {
      data: { name: "Minecraft tools fixture", mode: "demo", port },
    });
    expect(created.status()).toBe(201);
    const { server } = await created.json();
    await stopTestServer(request, server.id);
    try {
      await use(server.id);
    } finally {
      await removeTestServer(request, server.id);
    }
  },
});
test.beforeEach(async ({ page, serverId }) => {
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    serverId,
  );
});
test("Minecraft navigation sits between server and management and Properties saves scoped edits", async ({
  page,
  request,
  serverId,
}) => {
  const headers = { "X-Server-Id": serverId };
  expect(
    (
      await request.post("/api/files", {
        headers,
        data: {
          name: "bukkit.yml",
          type: "file",
          content:
            "# Keep comment\nsettings:\n  allow-end: true\n  connection-throttle: 4000\n",
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/#properties");
  await expect(
    page.getByRole("heading", { name: "Properties", exact: true }),
  ).toBeVisible();
  const links = await page.locator(".sidebar a").allTextContents();
  expect(links.findIndex((value) => value.includes("Players"))).toBeLessThan(
    links.findIndex((value) => value.includes("Versions")),
  );
  expect(links.findIndex((value) => value.includes("Properties"))).toBeLessThan(
    links.findIndex((value) => value.includes("Subusers")),
  );
  await page.getByRole("tab", { name: "bukkit.yml", exact: true }).click();
  await page
    .getByLabel("settings / connection throttle", { exact: true })
    .fill("2000");
  await page
    .getByRole("button", { name: "Save changes (1)", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  const saved = await (
    await request.get("/api/files/content?path=bukkit.yml", { headers })
  ).json();
  expect(saved.content).toContain("# Keep comment");
  expect(saved.content).toContain("connection-throttle: 2000");
  await page
    .getByLabel("settings / connection throttle", { exact: true })
    .fill("3000");
  await page
    .getByRole("tab", { name: "server.properties", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Discard unsaved changes?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(
    page.getByLabel("settings / connection throttle", { exact: true }),
  ).toHaveValue("3000");
});
test("Properties reports external file changes without overwriting them", async ({
  page,
  request,
  serverId,
}) => {
  await page.goto("/#properties");
  const field = page.getByLabel("max players", { exact: true });
  await expect(field).toBeVisible();
  await field.fill("25");
  const headers = { "X-Server-Id": serverId };
  const original = await (
    await request.get("/api/files/content?path=server.properties", { headers })
  ).json();
  await request.put("/api/files/content", {
    headers,
    data: {
      path: "server.properties",
      content: original.content + "\n# changed elsewhere\n",
    },
  });
  await page
    .getByRole("button", { name: "Save changes (1)", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "changed after you opened",
  );
  expect(
    (
      await (
        await request.get("/api/files/content?path=server.properties", {
          headers,
        })
      ).json()
    ).content,
  ).toContain("# changed elsewhere");
});
test("Versions shows official builds and requires a reviewed choice before installation", async ({
  page,
}) => {
  await page.route("**/api/versions", (route) =>
    route.fulfill({
      json: {
        providers: [
          {
            id: "neoforge",
            name: "NeoForge",
            description: "Modded Minecraft server",
            kind: "server",
            installable: true,
            website: "https://neoforged.net",
          },
        ],
        job: null,
      },
    }),
  );
  await page.route("**/api/versions/neoforge", (route) =>
    route.fulfill({
      json: { versions: [{ id: "1.21.1", label: "1.21.1", stable: true }] },
    }),
  );
  await page.route("**/api/versions/neoforge/1.21.1", (route) =>
    route.fulfill({
      json: {
        builds: [
          { id: "21.1.250", label: "21.1.250", stable: true, javaVersion: 21 },
        ],
      },
    }),
  );
  await page.goto("/#versions");
  await page.getByRole("button", { name: "Choose version" }).click();
  await page.getByRole("button", { name: "1.21.1", exact: true }).click();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("21.1.250");
  await expect(dialog.getByRole("button", { name: /Install/ })).toBeDisabled();
  await expect(dialog).toContainText(/worlds|world/i);
});

test("Versions offers older stable Fabric loaders and requires opting in to experimental builds", async ({
  page,
  serverId,
}, testInfo) => {
  await page.route("**/api/versions", (route) =>
    route.fulfill({
      json: {
        providers: [
          {
            id: "fabric",
            name: "Fabric",
            description: "Fabric loader fixture",
            kind: "server",
            installable: true,
            website: "https://fabricmc.net",
          },
        ],
        job: null,
      },
    }),
  );
  await page.route("**/api/versions/fabric", (route) =>
    route.fulfill({
      json: { versions: [{ id: "1.21.11", label: "1.21.11", stable: true }] },
    }),
  );
  await page.route("**/api/versions/fabric/1.21.11", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    return route.fulfill({
      json: {
        builds: [
          {
            id: "0.19.0-beta.1",
            label: "0.19.0-beta.1",
            stable: false,
            recommended: false,
          },
          { id: "0.18.4", label: "0.18.4", stable: true, recommended: true },
          { id: "0.18.3", label: "0.18.3", stable: true, recommended: false },
          { id: "0.18.2", label: "0.18.2", stable: true, recommended: false },
        ],
      },
    });
  });
  await page.goto("/#versions");
  await page
    .getByRole("button", { name: "Choose version", exact: true })
    .click();
  await page.getByRole("button", { name: "1.21.11", exact: true }).click();
  const builds = page.locator(".versions-build");
  await expect(builds).toHaveCount(3);
  for (const version of ["0.18.4", "0.18.3", "0.18.2"])
    await expect(builds.filter({ hasText: version })).toContainText("Stable");
  await expect(builds.filter({ hasText: "0.18.4" })).toContainText(
    "Recommended",
  );
  await expect(builds.filter({ hasText: "0.18.2" })).not.toContainText(
    "Recommended",
  );
  await expect(builds.filter({ hasText: "0.19.0-beta.1" })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("fabric-stable-loaders.png"),
    fullPage: true,
  });
  const experimental = page.getByRole("checkbox", {
    name: "Include experimental releases",
    exact: true,
  });
  await experimental.check();
  await expect(builds).toHaveCount(4);
  await expect(builds.filter({ hasText: "0.19.0-beta.1" })).toContainText(
    "Experimental",
  );
  await experimental.uncheck();
  await expect(builds).toHaveCount(3);
  await builds
    .filter({ hasText: "0.18.2" })
    .getByRole("button", { name: "Install", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Install Fabric",
    exact: true,
  });
  await expect(dialog).toContainText("0.18.2");
  await expect(dialog).not.toContainText("0.18.4");
  await expect(
    dialog.getByRole("button", { name: "Install version", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
test("Launchpad exposes six platforms, only four content tabs, and a reviewed installed-mod update", async ({
  page,
  serverId,
}) => {
  const providers = [
    ["modrinth", "Modrinth", ["modpack", "mod", "datapack", "plugin"]],
    ["curseforge", "CurseForge", ["modpack", "mod"]],
    ["spigot", "Spigot", ["plugin"]],
    ["ftb", "Feed The Beast", ["modpack"]],
    ["atlauncher", "ATLauncher", ["modpack"]],
    ["voidswrath", "Voids Wrath", ["modpack"]],
  ];
  const version = {
    id: "new",
    name: "Better Mod 2.0",
    version: "2.0",
    gameVersions: ["1.21.1"],
    loaders: ["neoforge"],
    publishedAt: "2026-09-01T00:00:00Z",
    downloadable: true,
  };
  const iconUrl = "https://cdn.modrinth.com/fixture/better-mod.svg";
  await page.route(iconUrl, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#68c985"/><path d="M16 18h32v28H16z" fill="#18231c"/></svg>',
    }),
  );
  await page.route("**/api/launchpad", (route) =>
    route.fulfill({
      json: {
        platforms: providers.map(([id, name, types]) => ({
          id,
          name,
          types,
          available: true,
        })),
        gameVersion: "1.21.1",
        gameVersions: ["1.21.1"],
        loader: "neoforge",
        status: "offline",
        warnings: [],
      },
    }),
  );
  await page.route("**/api/launchpad/search?**", (route) =>
    route.fulfill({ json: { projects: [], total: 0, offset: 0, limit: 10 } }),
  );
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            path: "mods/better-1.jar",
            name: "better-1.jar",
            size: 1024,
            platform: "modrinth",
            projectId: "better",
            versionId: "old",
            versionName: "1.0",
            title: "Better Mod",
            iconUrl,
            update: version,
          },
        ],
        warnings: [],
      },
    }),
  );
  await page.route("**/api/launchpad/versions?**", (route) =>
    route.fulfill({ json: { versions: [version] } }),
  );
  let previewBody: Record<string, unknown> | undefined;
  await page.route("**/api/launchpad/preview", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    previewBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        planId: "review-token",
        title: "Better Mod",
        versionName: "2.0",
        files: [
          {
            path: "mods/better-2.jar",
            size: 2048,
            action: "replace",
            previousPath: "mods/better-1.jar",
          },
        ],
        warnings: [],
        expiresAt: "2099-01-01T00:00:00Z",
      },
    });
  });
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/launchpad/install", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      json: {
        job: {
          id: "job",
          status: "completed",
          message: "Better Mod updated",
          completed: 1,
          total: 1,
        },
      },
    });
  });
  await page.goto("/#launchpad");
  await expect(
    page.getByLabel("Platform", { exact: true }).locator("option"),
  ).toHaveCount(6);
  await expect(page.getByRole("tab")).toHaveText([
    "Modpacks",
    "Mods",
    "Datapacks",
    "Plugins",
  ]);
  await page.getByRole("tab", { name: "Mods", exact: true }).click();
  await page.getByRole("switch", { name: "Show installed content" }).check();
  const installedIcon = page
    .getByRole("article", { name: "Better Mod", exact: true })
    .locator(".launchpad-project-icon img");
  await expect(installedIcon).toHaveAttribute("src", iconUrl);
  await expect
    .poll(() =>
      installedIcon.evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: /Update/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Review/ }).click();
  await expect(dialog).toContainText("mods/better-2.jar");
  expect(previewBody).toMatchObject({
    platform: "modrinth",
    projectId: "better",
    versionId: "new",
    replacePath: "mods/better-1.jar",
    gameVersion: "1.21.1",
    loader: "neoforge",
  });
  await dialog.getByRole("button", { name: "Confirm installation" }).click();
  await expect
    .poll(() => submitted)
    .toEqual({ planId: "review-token", confirmed: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("Launchpad separates mod and plugin loaders and defaults Paper to Plugins", async ({
  page,
}) => {
  await page.route("**/api/launchpad", (route) =>
    route.fulfill({
      json: {
        platforms: [
          {
            id: "modrinth",
            name: "Modrinth",
            types: ["modpack", "mod", "datapack", "plugin"],
            available: true,
          },
        ],
        gameVersion: "1.21.4",
        loader: "paper",
        status: "offline",
        warnings: [],
      },
    }),
  );
  await page.route("**/api/launchpad/search?**", (route) =>
    route.fulfill({ json: { projects: [], total: 0, offset: 0, limit: 10 } }),
  );
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
  await page.goto("/#launchpad");
  await expect(
    page.getByRole("tab", { name: "Plugins", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Loader", { exact: true })).toHaveValue("paper");
  await page.getByRole("tab", { name: "Mods", exact: true }).click();
  await expect(page.getByLabel("Loader", { exact: true })).toHaveValue("");
  const choices = await page
    .getByLabel("Loader", { exact: true })
    .locator("option")
    .allTextContents();
  expect(choices).toContain("neoforge");
  expect(choices).not.toContain("paper");
  await page.getByRole("tab", { name: "Datapacks", exact: true }).click();
  await expect(page.getByLabel("Loader", { exact: true })).toHaveValue(
    "datapack",
  );
});

test("Launchpad catalog sorting sends scoped choices and resets pagination with platform-specific fallbacks", async ({
  page,
  serverId,
}) => {
  const searches: URL[] = [];
  await page.route("**/api/launchpad", (route) =>
    route.fulfill({
      json: {
        platforms: [
          {
            id: "modrinth",
            name: "Modrinth",
            available: true,
            types: ["mod"],
            sortOptions: [
              { id: "downloads", label: "Most downloaded" },
              { id: "updated", label: "Recently updated" },
              { id: "newest", label: "Newest" },
            ],
          },
          {
            id: "curseforge",
            name: "CurseForge",
            available: true,
            types: ["mod"],
            sortOptions: [
              { id: "popular", label: "Most popular" },
              { id: "downloads", label: "Most downloaded" },
              { id: "name", label: "Name (A–Z)" },
            ],
          },
        ],
        gameVersion: "1.21.1",
        gameVersions: ["1.21.1"],
        loader: "neoforge",
        status: "offline",
        warnings: [],
      },
    }),
  );
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
  await page.route("**/api/launchpad/search?**", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    const url = new URL(route.request().url());
    searches.push(url);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    const sort = url.searchParams.get("sort");
    const platform = url.searchParams.get("platform")!;
    return route.fulfill({
      json: {
        projects: Array.from(
          { length: Math.min(limit, 23 - offset) },
          (_, index) => ({
            id: `${platform}-${sort}-${offset + index}`,
            platform,
            title: `${sort} result ${offset + index + 1}`,
            description: "Deterministic catalog fixture",
          }),
        ),
        total: 23,
        offset,
        limit,
      },
    });
  });
  const lastSearch = () =>
    Object.fromEntries(searches.at(-1)?.searchParams ?? []);
  await page.goto("/#launchpad");
  const sort = page.getByLabel("Sort Launchpad", { exact: true });
  await expect(sort).toHaveValue("downloads");
  await expect(page.getByRole("article").first()).toHaveAccessibleName(
    "downloads result 1",
  );
  await page.getByLabel("Search Launchpad", { exact: true }).fill("copper");
  await expect
    .poll(lastSearch)
    .toMatchObject({ sort: "downloads", query: "copper", offset: "0" });
  await page
    .getByRole("button", { name: "Next Launchpad page", exact: true })
    .click();
  await expect(page.getByRole("status", { name: "Launchpad page" })).toHaveText(
    "Page 2 of 3",
  );
  await expect
    .poll(lastSearch)
    .toMatchObject({ sort: "downloads", offset: "10" });
  await sort.selectOption("updated");
  await expect.poll(lastSearch).toMatchObject({
    platform: "modrinth",
    sort: "updated",
    query: "copper",
    offset: "0",
  });
  await expect(page.getByRole("status", { name: "Launchpad page" })).toHaveText(
    "Page 1 of 3",
  );
  await expect(page.getByRole("article").first()).toHaveAccessibleName(
    "updated result 1",
  );
  await page
    .getByRole("button", { name: "Next Launchpad page", exact: true })
    .click();
  await expect(page.getByRole("status", { name: "Launchpad page" })).toHaveText(
    "Page 2 of 3",
  );
  await page.getByLabel("Platform", { exact: true }).selectOption("curseforge");
  await expect(sort).toHaveValue("popular");
  await expect(sort.locator("option")).toHaveText([
    "Most popular",
    "Most downloaded",
    "Name (A–Z)",
  ]);
  await expect.poll(lastSearch).toMatchObject({
    platform: "curseforge",
    sort: "popular",
    query: "copper",
    offset: "0",
  });
  await expect(page.getByRole("article").first()).toHaveAccessibleName(
    "popular result 1",
  );
  await sort.selectOption("downloads");
  await page.getByLabel("Platform", { exact: true }).selectOption("modrinth");
  await expect(sort).toHaveValue("downloads");
  await expect
    .poll(lastSearch)
    .toMatchObject({ platform: "modrinth", sort: "downloads", offset: "0" });
});

test("Launchpad installed updates sort before pagination and keep priority when searched on mobile", async ({
  page,
}) => {
  const current = [
    "Alpha Mod 10",
    "alpha Mod 2",
    "Alpha Mod 1",
    "Bravo Mod 1",
    "Delta Mod 1",
    "Echo Mod 1",
    "Foxtrot Mod 1",
    "Golf Mod 1",
  ];
  const updates = [
    "Zeta Mod 10",
    "Zeta Mod 2",
    "zeta Mod 1",
    "Beta Mod 1",
    "Alpha Mod 9",
    "Gamma Mod 2",
    "Gamma Mod 1",
  ];
  const version = {
    id: "new",
    name: "New version",
    version: "2.0",
    gameVersions: ["1.21.1"],
    loaders: ["neoforge"],
    publishedAt: "2026-09-01T00:00:00Z",
    downloadable: true,
  };
  await page.route("**/api/launchpad", (route) =>
    route.fulfill({
      json: {
        platforms: [
          {
            id: "modrinth",
            name: "Modrinth",
            available: true,
            types: ["mod"],
            sortOptions: [{ id: "downloads", label: "Most downloaded" }],
          },
        ],
        gameVersion: "1.21.1",
        gameVersions: ["1.21.1"],
        loader: "neoforge",
        status: "offline",
        warnings: [],
      },
    }),
  );
  await page.route("**/api/launchpad/search?**", (route) =>
    route.fulfill({ json: { projects: [], total: 0, offset: 0, limit: 10 } }),
  );
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({
      json: {
        items: [...current, ...updates].map((title, index) => ({
          path: `mods/fixture-${index}.jar`,
          name: `fixture-${index}.jar`,
          size: 1024,
          platform: "modrinth",
          projectId: `project-${index}`,
          versionId: "old",
          versionName: "1.0",
          title,
          ...(index >= current.length ? { update: version } : {}),
        })),
        warnings: [],
      },
    }),
  );
  await page.goto("/#launchpad");
  await expect(
    page.getByLabel("Sort Launchpad", { exact: true }),
  ).toBeVisible();
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await expect(page.getByLabel("Sort Launchpad", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByLabel("Sort installed content", { exact: true }),
  ).toHaveValue("updates");
  await page
    .getByLabel("Launchpad rows per page", { exact: true })
    .selectOption("5");
  const names = page.getByRole("article").getByRole("heading", { level: 3 });
  const first = [
    "Alpha Mod 9",
    "Beta Mod 1",
    "Gamma Mod 1",
    "Gamma Mod 2",
    "zeta Mod 1",
  ];
  await expect(names).toHaveText(first);
  await expect(page.getByRole("button", { name: /^Update / })).toHaveCount(5);
  await expect(page.getByRole("status", { name: "Launchpad page" })).toHaveText(
    "Page 1 of 3",
  );
  await page
    .getByRole("button", { name: "Next Launchpad page", exact: true })
    .click();
  await expect(names).toHaveText([
    "Zeta Mod 2",
    "Zeta Mod 10",
    "Alpha Mod 1",
    "alpha Mod 2",
    "Alpha Mod 10",
  ]);
  await expect(page.getByRole("button", { name: /^Update / })).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Search Launchpad", { exact: true }).fill("alpha");
  await expect(names).toHaveText([
    "Alpha Mod 9",
    "Alpha Mod 1",
    "alpha Mod 2",
    "Alpha Mod 10",
  ]);
  await expect(page.getByRole("status", { name: "Launchpad page" })).toHaveText(
    "Page 1 of 1",
  );
  await expect(
    page.getByRole("button", { name: "Next Launchpad page", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel("Search Launchpad", { exact: true }).fill("");
  await expect(names).toHaveText(first);
  await expect(page.getByRole("status", { name: "Launchpad page" })).toHaveText(
    "Page 1 of 3",
  );
});

test("Launchpad installed sorts order the entire list before paging and retain independent catalog choices", async ({
  page,
  serverId,
}, testInfo) => {
  const rows = [
    { path: "mods/twin-z.jar", title: "Twin", size: 500, author: "Gamma" },
    { path: "mods/alpha10.jar", title: "alpha 10", size: 300, author: "Beta" },
    { path: "mods/unknown-a.jar", title: "Unknown A", size: 900 },
    {
      path: "mods/zulu.jar",
      title: "Zulu",
      size: 100,
      author: "Alpha",
      update: true,
    },
    { path: "mods/twin-a.jar", title: "Twin", size: 500, author: "Gamma" },
    {
      path: "mods/alpha2.jar",
      title: "Alpha 2",
      size: 300,
      author: "Beta",
      update: true,
    },
    { path: "mods/unknown-b.jar", title: "Unknown B", size: 900, author: "" },
    { path: "mods/beta.jar", title: "Beta", size: 1000, author: "alpha" },
    { path: "mods/alpha1.jar", title: "alpha 1", size: 700, author: "Zeta" },
    {
      path: "mods/omega.jar",
      title: "Omega",
      size: 200,
      author: "Beta",
      update: true,
    },
    { path: "mods/echo.jar", title: "Echo", size: 800, author: "Delta" },
    { path: "mods/delta.jar", title: "Delta", size: 400, author: "Beta" },
  ];
  const update = {
    id: "new",
    name: "New version",
    version: "2.0",
    gameVersions: ["1.21.1"],
    loaders: ["neoforge"],
    publishedAt: "2026-09-01T00:00:00Z",
    downloadable: true,
  };
  const searches: URL[] = [];
  await page.route("**/api/launchpad", (route) =>
    route.fulfill({
      json: {
        platforms: [
          {
            id: "modrinth",
            name: "Modrinth",
            available: true,
            types: ["mod"],
            sortOptions: [
              { id: "downloads", label: "Most downloaded" },
              { id: "updated", label: "Recently updated" },
            ],
          },
        ],
        gameVersion: "1.21.1",
        gameVersions: ["1.21.1"],
        loader: "neoforge",
        status: "offline",
        warnings: [],
      },
    }),
  );
  await page.route("**/api/launchpad/search?**", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    searches.push(new URL(route.request().url()));
    return route.fulfill({
      json: { projects: [], total: 0, offset: 0, limit: 10 },
    });
  });
  await page.route("**/api/launchpad/installed?**", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    return route.fulfill({
      json: {
        items: rows.map((row, index) => ({
          ...row,
          name: row.path.slice(5),
          platform: "modrinth",
          projectId: `sort-${index}`,
          versionId: "old",
          versionName: "1.0",
          update: row.update ? update : null,
        })),
        warnings: [],
      },
    });
  });
  await page.goto("/#launchpad");
  const catalogSort = page.getByLabel("Sort Launchpad", { exact: true });
  await catalogSort.selectOption("updated");
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("sort"))
    .toBe("updated");
  const installedToggle = page.getByRole("switch", {
    name: "Show installed content",
  });
  await installedToggle.check();
  const sort = page.getByLabel("Sort installed content", { exact: true });
  await expect(sort).toHaveValue("updates");
  await expect(sort.locator("option")).toHaveText([
    "Updates first",
    "Name (A–Z)",
    "Size (largest first)",
    "Mod author (A–Z)",
  ]);
  await page
    .getByLabel("Launchpad rows per page", { exact: true })
    .selectOption("5");
  const paths = page.locator(".launchpad-project-body > p");
  const pagination = page.getByRole("status", { name: "Launchpad page" });
  const next = page.getByRole("button", {
    name: "Next Launchpad page",
    exact: true,
  });
  const orders = [
    {
      sort: "updates",
      paths: [
        "alpha2",
        "omega",
        "zulu",
        "alpha1",
        "alpha10",
        "beta",
        "delta",
        "echo",
        "twin-a",
        "twin-z",
        "unknown-a",
        "unknown-b",
      ],
    },
    {
      sort: "name",
      paths: [
        "alpha1",
        "alpha2",
        "alpha10",
        "beta",
        "delta",
        "echo",
        "omega",
        "twin-a",
        "twin-z",
        "unknown-a",
        "unknown-b",
        "zulu",
      ],
    },
    {
      sort: "size",
      paths: [
        "beta",
        "unknown-a",
        "unknown-b",
        "echo",
        "alpha1",
        "twin-a",
        "twin-z",
        "delta",
        "alpha2",
        "alpha10",
        "omega",
        "zulu",
      ],
    },
    {
      sort: "author",
      paths: [
        "beta",
        "zulu",
        "alpha2",
        "alpha10",
        "delta",
        "omega",
        "echo",
        "twin-a",
        "twin-z",
        "alpha1",
        "unknown-a",
        "unknown-b",
      ],
    },
  ];
  for (const order of orders) {
    await sort.selectOption(order.sort);
    for (let index = 0; index < 3; index++) {
      await expect(pagination).toHaveText(`Page ${index + 1} of 3`);
      await expect(paths).toHaveText(
        order.paths
          .slice(index * 5, index * 5 + 5)
          .map((name) => `mods/${name}.jar`),
      );
      if (index < 2) await next.click();
    }
    await expect(next).toBeDisabled();
  }
  await expect(page.getByRole("article").getByText(/^By /)).toHaveCount(0);
  await installedToggle.uncheck();
  await expect(catalogSort).toHaveValue("updated");
  await expect(sort).toHaveCount(0);
  await installedToggle.check();
  await expect(sort).toHaveValue("author");
  await expect(pagination).toHaveText("Page 1 of 3");
  await expect(paths).toHaveText(
    orders[3].paths.slice(0, 5).map((name) => `mods/${name}.jar`),
  );
  await page.screenshot({
    path: testInfo.outputPath("installed-author-sort-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await sort.selectOption("name");
  await installedToggle.uncheck();
  await catalogSort.selectOption("downloads");
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("sort"))
    .toBe("downloads");
  await installedToggle.check();
  await expect(sort).toHaveValue("name");
  await expect(paths).toHaveText(
    orders[1].paths.slice(0, 5).map((name) => `mods/${name}.jar`),
  );
  await sort.selectOption("author");
  await next.click();
  await page.setViewportSize({ width: 390, height: 844 });
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).not.toHaveClass(/is-open/);
  await expect
    .poll(() =>
      sidebar.evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(1);
  await page.getByLabel("Search Launchpad", { exact: true }).fill("gAmMa");
  await expect(pagination).toHaveText("Page 1 of 1");
  await expect(paths).toHaveText(["mods/twin-a.jar", "mods/twin-z.jar"]);
  await expect(
    page.getByRole("article").getByText("By Gamma", { exact: true }),
  ).toHaveCount(2);
  await sort.selectOption("size");
  await expect(sort).toHaveValue("size");
  await sort.selectOption("author");
  await expect(sort).toHaveValue("author");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("installed-author-sort-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("Launchpad keeps refreshed local files usable after installation while remote details fail and retry", async ({
  page,
  serverId,
}) => {
  await page.clock.install();
  const version = {
    id: "new",
    name: "Better Mod 2.0",
    version: "2.0",
    gameVersions: ["1.21.1"],
    loaders: ["neoforge"],
    publishedAt: "2026-09-01T00:00:00Z",
    downloadable: true,
  };
  const config = {
    platforms: [
      { id: "modrinth", name: "Modrinth", available: true, types: ["mod"] },
    ],
    gameVersion: "1.21.1",
    gameVersions: ["1.21.1"],
    loader: "neoforge",
    status: "offline",
    warnings: [],
  };
  let replaced = false,
    configRequests = 0,
    localRequests = 0;
  let holdConfig = false;
  let delayedFull: Route | undefined,
    delayedConfig: Route | undefined,
    timedOutFull: Route | undefined;
  const fullRequests: URL[] = [];
  const inventory = (remote: boolean) => [
    {
      path: replaced ? "mods/better-2.jar" : "mods/better-1.jar",
      name: replaced ? "better-2.jar" : "better-1.jar",
      title: "Better Mod",
      size: replaced ? 2048 : 1024,
      platform: "modrinth",
      projectId: "better",
      versionId: replaced ? "new" : "old",
      versionName: replaced ? "2.0" : "1.0",
      ...(remote
        ? {
            author: replaced ? "Recovered author" : "Original author",
            update: replaced ? null : version,
          }
        : {}),
    },
    {
      path: "mods/alpha.jar",
      name: "alpha.jar",
      title: "Alpha",
      size: 512,
      platform: "modrinth",
      projectId: "alpha",
      versionId: "old",
    },
    {
      path: "mods/zeta.jar",
      name: "zeta.jar",
      title: "Zeta",
      size: 4096,
      platform: "modrinth",
      projectId: "zeta",
      versionId: "old",
    },
  ];
  await page.route("**/api/launchpad", (route) => {
    configRequests++;
    if (holdConfig) {
      delayedConfig = route;
      return;
    }
    return route.fulfill({ json: config });
  });
  await page.route("**/api/launchpad/search?**", (route) =>
    route.fulfill({ json: { projects: [], total: 0, offset: 0, limit: 10 } }),
  );
  await page.route("**/api/launchpad/installed?**", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    const url = new URL(route.request().url());
    if (url.searchParams.get("local") === "true") {
      localRequests++;
      return route.fulfill({ json: { items: inventory(false), warnings: [] } });
    }
    fullRequests.push(url);
    if (fullRequests.length === 2) {
      delayedFull = route;
      return;
    }
    if (fullRequests.length === 5) {
      timedOutFull = route;
      return;
    }
    return route.fulfill({ json: { items: inventory(true), warnings: [] } });
  });
  await page.route("**/api/launchpad/versions?**", (route) =>
    route.fulfill({ json: { versions: [version] } }),
  );
  await page.route("**/api/launchpad/preview", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      replacePath: "mods/better-1.jar",
      versionId: "new",
    });
    return route.fulfill({
      json: {
        planId: "local-refresh-plan",
        title: "Better Mod",
        versionName: "2.0",
        files: [
          {
            path: "mods/better-2.jar",
            previousPath: "mods/better-1.jar",
            size: 2048,
            action: "replace",
          },
        ],
        warnings: [],
        expiresAt: "2099-01-01T00:00:00Z",
      },
    });
  });
  await page.route("**/api/launchpad/install", (route) =>
    route.fulfill({
      json: {
        job: {
          id: "local-refresh-job",
          status: "running",
          message: "Installing fixture",
          completed: 0,
          total: 1,
        },
      },
    }),
  );
  await page.route("**/api/launchpad/jobs/local-refresh-job", (route) => {
    replaced = true;
    return route.fulfill({
      json: {
        job: {
          id: "local-refresh-job",
          status: "completed",
          message: "Better Mod updated",
          completed: 1,
          total: 1,
        },
      },
    });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await expect(
    page.getByRole("button", { name: "Update Better Mod", exact: true }),
  ).toBeVisible();
  const sort = page.getByLabel("Sort installed content", { exact: true });
  await sort.selectOption("size");
  await page
    .getByRole("button", { name: "Update Better Mod", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Review/ }).click();
  await dialog
    .getByRole("button", { name: "Confirm installation", exact: true })
    .click();
  await expect.poll(() => Boolean(delayedFull)).toBe(true);
  const paths = page.locator(".launchpad-project-body > p");
  const refreshing = page.getByRole("status", {
    name: "Installed content refresh",
    exact: true,
  });
  await expect(refreshing).toBeVisible();
  await expect(paths).toHaveText([
    "mods/zeta.jar",
    "mods/better-2.jar",
    "mods/alpha.jar",
  ]);
  await expect(
    page.getByText("mods/better-1.jar", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Choose version for Better Mod",
      exact: true,
    }),
  ).toBeEnabled();
  await sort.selectOption("name");
  await expect(paths).toHaveText([
    "mods/alpha.jar",
    "mods/better-2.jar",
    "mods/zeta.jar",
  ]);
  await page.getByLabel("Search Launchpad", { exact: true }).fill("better");
  await expect(paths).toHaveText(["mods/better-2.jar"]);
  await page.getByLabel("Search Launchpad", { exact: true }).fill("");
  await delayedFull!.fulfill({
    status: 503,
    json: { error: "Provider fixture is unavailable." },
  });
  await expect(page.getByRole("alert")).toContainText(
    "Provider fixture is unavailable.",
  );
  await expect(paths).toHaveText([
    "mods/alpha.jar",
    "mods/better-2.jar",
    "mods/zeta.jar",
  ]);
  await page
    .getByRole("button", { name: "Retry installed refresh", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Better Mod", exact: true }),
  ).toContainText("By Recovered author");
  await expect(refreshing).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry installed refresh", exact: true }),
  ).toHaveCount(0);
  expect(localRequests).toBe(3);
  expect(
    fullRequests.map((url) => url.searchParams.get("refresh") === "true"),
  ).toEqual([false, false, true]);
  holdConfig = true;
  await page
    .getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    })
    .click();
  await expect.poll(() => Boolean(delayedConfig)).toBe(true);
  await expect.poll(() => fullRequests.length).toBe(4);
  await expect(refreshing).toHaveCount(0);
  await delayedConfig!.fulfill({ json: { ...config } });
  holdConfig = false;
  await expect(
    page.getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    }),
  ).toBeEnabled();
  // Advance the scan debounce after the new config object arrives, without a wall-clock sleep.
  await page.clock.runFor(1000);
  expect(configRequests).toBe(2);
  expect(localRequests).toBe(4);
  expect(fullRequests.length).toBe(4);
  expect(fullRequests[3].searchParams.get("refresh")).toBe("true");
  await expect(paths).toHaveText([
    "mods/alpha.jar",
    "mods/better-2.jar",
    "mods/zeta.jar",
  ]);
  await page
    .getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    })
    .click();
  await expect.poll(() => Boolean(timedOutFull)).toBe(true);
  await expect(refreshing).toBeVisible();
  await page.clock.runFor(45_001);
  await expect(page.getByRole("alert")).toContainText(
    "The online check took too long. Please try again shortly.",
  );
  await expect(paths).toHaveText([
    "mods/alpha.jar",
    "mods/better-2.jar",
    "mods/zeta.jar",
  ]);
  await expect(sort).toBeEnabled();
  await page
    .getByRole("button", { name: "Retry installed refresh", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Better Mod", exact: true }),
  ).toContainText("By Recovered author");
  await expect(refreshing).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(localRequests).toBe(6);
  expect(fullRequests.length).toBe(6);
  expect(fullRequests[5].searchParams.get("refresh")).toBe("true");
});

test("Launchpad ignores delayed installed metadata after loader, version, type and server changes", async ({
  page,
  request,
  serverId,
}) => {
  await page.clock.install();
  const fleet = await (await request.get("/api/servers")).json();
  let port = 29910;
  while (fleet.servers.some((server: { port: number }) => server.port === port))
    port++;
  const created = await request.post("/api/servers", {
    data: { name: "Launchpad second scope", mode: "demo", port },
  });
  expect(created.status()).toBe(201);
  const second = (await created.json()).server;
  await stopTestServer(request, second.id);
  try {
    const delayed: {
      route: Route;
      title: string;
      item: Record<string, unknown>;
    }[] = [];
    await page.route("**/api/launchpad", (route) =>
      route.fulfill({
        json: {
          platforms: [
            {
              id: "modrinth",
              name: "Modrinth",
              available: true,
              types: ["mod", "datapack"],
            },
          ],
          gameVersion: "1.21.1",
          gameVersions: ["1.21.1", "1.20.1"],
          loader: "neoforge",
          status: "offline",
          warnings: [],
        },
      }),
    );
    await page.route("**/api/launchpad/search?**", (route) =>
      route.fulfill({ json: { projects: [], total: 0, offset: 0, limit: 10 } }),
    );
    await page.route("**/api/launchpad/installed?**", (route) => {
      const id = route.request().headers()["x-server-id"];
      expect([serverId, second.id]).toContain(id);
      const params = new URL(route.request().url()).searchParams;
      const title = `${id === serverId ? "First" : "Second"} ${params.get("type")} ${params.get("loader")} ${params.get("gameVersion")}`;
      const datapack = params.get("type") === "datapack";
      const item = {
        path: `${datapack ? "world/datapacks" : "mods"}/${title.replaceAll(" ", "-")}.${datapack ? "zip" : "jar"}`,
        name: datapack ? "scoped.zip" : "scoped.jar",
        title,
        size: 1024,
        platform: "modrinth",
        projectId: title.replaceAll(" ", "-"),
        versionId: "old",
      };
      if (params.get("local") === "true")
        return route.fulfill({ json: { items: [item], warnings: [] } });
      delayed.push({ route, title, item });
    });
    await page.goto("/#launchpad");
    const toggle = page.getByRole("switch", { name: "Show installed content" });
    await toggle.check();
    const names = page.getByRole("article").getByRole("heading", { level: 3 });
    const expectScope = async (title: string) => {
      await expect(names).toHaveText([title]);
      await expect
        .poll(() => delayed.some((entry) => entry.title === title))
        .toBe(true);
    };
    await expectScope("First mod neoforge 1.21.1");
    await page.getByLabel("Loader", { exact: true }).selectOption("fabric");
    await expectScope("First mod fabric 1.21.1");
    await page
      .getByLabel("Minecraft version", { exact: true })
      .selectOption("1.20.1");
    await expectScope("First mod fabric 1.20.1");
    await page.getByRole("tab", { name: "Datapacks", exact: true }).click();
    await expectScope("First datapack datapack 1.20.1");
    await page
      .getByLabel("Switch server", { exact: true })
      .selectOption(second.id);
    await expect(page.getByLabel("Loader", { exact: true })).toHaveValue(
      "neoforge",
    );
    await toggle.check();
    const current = "Second mod neoforge 1.21.1";
    await expectScope(current);
    const latest = delayed.find((entry) => entry.title === current)!;
    await latest.route.fulfill({
      json: {
        items: [{ ...latest.item, author: "Current scope author" }],
        warnings: [],
      },
    });
    await expect(page.getByRole("article")).toContainText(
      "By Current scope author",
    );
    for (const stale of delayed.filter((entry) => entry !== latest).reverse())
      await stale.route
        .fulfill({
          json: {
            items: [{ ...stale.item, title: `STALE ${stale.title}` }],
            warnings: [],
          },
        })
        .catch(() => {});
    await page.clock.runFor(500);
    await expect(names).toHaveText([current]);
    await expect(page.getByRole("article")).toContainText(
      "By Current scope author",
    );
    await expect(page.getByText(/^STALE /)).toHaveCount(0);
  } finally {
    await removeTestServer(request, second.id);
  }
});

test("Launchpad Minecraft selects show stable releases only and scope filters and reviewed targets", async ({
  page,
  serverId,
}) => {
  const catalog = ["26.2", "1.21.11", "1.21.1", "1.20.6", "1.7.10", "1.0"];
  const experimental = [
    "26.3-rc-2",
    "26.3-pre-1",
    "25w01a",
    "b1.7.3",
    "a1.2.6",
    "rd-132211",
    "custom-1.21.1",
  ];
  const searches: URL[] = [];
  await page.route("**/api/launchpad", (route) =>
    route.fulfill({
      json: {
        platforms: [
          {
            id: "modrinth",
            name: "Modrinth",
            available: true,
            types: ["mod"],
            sortOptions: [{ id: "downloads", label: "Most downloaded" }],
          },
        ],
        gameVersion: experimental[0],
        gameVersions: [...catalog, ...experimental, "1.21.1"],
        loader: "neoforge",
        status: "offline",
        warnings: [],
      },
    }),
  );
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
  await page.route("**/api/launchpad/search?**", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    const url = new URL(route.request().url());
    searches.push(url);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return route.fulfill({
      json: {
        projects: Array.from(
          { length: Math.min(limit, 12 - offset) },
          (_, index) => ({
            id: `catalog-${offset + index}`,
            platform: "modrinth",
            title: `Catalog mod ${offset + index + 1}`,
            description: "Version filter fixture",
          }),
        ),
        total: 12,
        offset,
        limit,
      },
    });
  });
  await page.route("**/api/launchpad/versions?**", (route) =>
    route.fulfill({
      json: {
        versions: [
          {
            id: "build",
            name: "Reviewed build",
            version: "2.0",
            gameVersions: catalog,
            loaders: ["neoforge"],
            publishedAt: "2026-09-01T00:00:00Z",
            downloadable: true,
          },
        ],
      },
    }),
  );
  let review: Record<string, unknown> | undefined;
  await page.route("**/api/launchpad/preview", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    review = route.request().postDataJSON();
    return route.fulfill({
      json: {
        planId: "version-review",
        title: "Catalog mod 1",
        versionName: "2.0",
        files: [{ path: "mods/catalog.jar", size: 1024, action: "install" }],
        warnings: [],
        expiresAt: "2099-01-01T00:00:00Z",
      },
    });
  });
  await page.goto("/#launchpad");
  const version = page.getByRole("combobox", {
    name: "Minecraft version",
    exact: true,
  });
  await expect(version).toHaveValue("");
  await expect(version.locator("option")).toHaveText([
    "All versions",
    ...catalog,
  ]);
  await expect
    .poll(
      () =>
        searches.length > 0 &&
        !searches.at(-1)?.searchParams.has("gameVersion"),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Next Launchpad page", exact: true })
    .click();
  await expect(page.getByRole("status", { name: "Launchpad page" })).toHaveText(
    "Page 2 of 2",
  );
  await version.selectOption("26.2");
  await expect
    .poll(() => Object.fromEntries(searches.at(-1)?.searchParams ?? []))
    .toMatchObject({ gameVersion: "26.2", offset: "0" });
  await expect(page.getByRole("status", { name: "Launchpad page" })).toHaveText(
    "Page 1 of 2",
  );
  await version.selectOption("");
  await expect
    .poll(() => searches.at(-1)?.searchParams.has("gameVersion"))
    .toBe(false);
  await page
    .getByRole("button", { name: "Install Catalog mod 1", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const target = dialog.getByRole("combobox", {
    name: "Target Minecraft version",
    exact: true,
  });
  await expect(target).toHaveValue("");
  await expect(target.locator("option")).toHaveText([
    "Select Minecraft version",
    ...catalog,
  ]);
  await target.selectOption("1.21.1");
  await dialog.getByRole("button", { name: /Review/ }).click();
  await expect
    .poll(() => review)
    .toMatchObject({
      gameVersion: "1.21.1",
      loader: "neoforge",
      projectId: "catalog-0",
      versionId: "build",
    });
  await expect(dialog).toContainText("mods/catalog.jar");
});

test("Launchpad refresh retries a failed stable catalog while preserving configured and selected release versions", async ({
  page,
}) => {
  const custom = "1.99.2";
  const catalog = ["26.2", "1.21.11", "1.21.1", "1.7.10"];
  let configRequests = 0;
  await page.route("**/api/launchpad", (route) => {
    configRequests++;
    return route.fulfill({
      json: {
        platforms: [
          { id: "modrinth", name: "Modrinth", available: true, types: ["mod"] },
        ],
        gameVersion: custom,
        gameVersions:
          configRequests === 1
            ? []
            : configRequests === 2
              ? [
                  ...catalog,
                  "26.3-rc-2",
                  "26.3-pre-1",
                  "25w01a",
                  "b1.7.3",
                  "a1.2.6",
                ]
              : [...catalog.slice(1), "26.3-rc-2"],
        loader: "neoforge",
        status: "offline",
        warnings:
          configRequests === 1
            ? ["Minecraft version catalog: provider temporarily unavailable."]
            : [],
      },
    });
  });
  await page.route("**/api/launchpad/search?**", (route) =>
    route.fulfill({ json: { projects: [], total: 0, offset: 0, limit: 10 } }),
  );
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
  await page.goto("/#launchpad");
  const version = page.getByRole("combobox", {
    name: "Minecraft version",
    exact: true,
  });
  await expect(version).toHaveValue(custom);
  await expect(version.locator("option")).toHaveText(["All versions", custom]);
  await expect(
    page.getByText(
      "Minecraft version catalog: provider temporarily unavailable.",
      { exact: true },
    ),
  ).toBeVisible();
  const refresh = page.getByRole("button", {
    name: "Refresh Launchpad and check updates",
    exact: true,
  });
  await refresh.click();
  await expect.poll(() => configRequests).toBe(2);
  await expect(version.locator("option")).toHaveText([
    "All versions",
    ...catalog,
    custom,
  ]);
  await expect(version).toHaveValue(custom);
  await expect(
    page.getByText(
      "Minecraft version catalog: provider temporarily unavailable.",
      { exact: true },
    ),
  ).toHaveCount(0);
  await version.selectOption("26.2");
  await refresh.click();
  await expect.poll(() => configRequests).toBe(3);
  await expect(version).toHaveValue("26.2");
  await expect(version.locator("option")).toHaveText([
    "All versions",
    ...catalog.slice(1),
    custom,
    "26.2",
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("Versions decodes all eighteen bundled software logos without external image requests", async ({
  page,
}, testInfo) => {
  const assets: Record<string, string> = {
    vanilla: "vanilla.png",
    paper: "paper.svg",
    pufferfish: "pufferfish.png",
    spigot: "spigot.png",
    purpur: "purpur.svg",
    waterfall: "waterfall.svg",
    velocity: "velocity.svg",
    fabric: "fabric.png",
    quilt: "quilt.svg",
    forge: "forge.png",
    neoforge: "neoforge.svg",
    mohist: "mohist.png",
    arclight: "arclight.png",
    sponge: "sponge.svg",
    leaves: "leaves.svg",
    canvas: "canvas.png",
    magma: "magma.png",
    folia: "folia.png",
  };
  const externalImages: string[] = [];
  page.on("request", (request) => {
    if (
      request.resourceType() === "image" &&
      new URL(request.url()).origin !==
        new URL(testInfo.project.use.baseURL!).origin
    )
      externalImages.push(request.url());
  });
  await page.goto("/#versions");
  const logos = page.locator(".version-provider-mark img");
  await expect(logos).toHaveCount(18);
  for (const [id, filename] of Object.entries(assets))
    await expect(
      page.locator(`.version-provider-${id} .version-provider-mark img`),
    ).toHaveAttribute("src", `/software-icons/${filename}`);
  await expect
    .poll(() =>
      logos.evaluateAll((images: HTMLImageElement[]) =>
        images.every(
          (image) =>
            image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
        ),
      ),
    )
    .toBe(true);
  expect(externalImages).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("software-logos-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(logos).toHaveCount(18);
  await page.screenshot({
    path: testInfo.outputPath("software-logos-mobile.png"),
    fullPage: true,
  });
});
