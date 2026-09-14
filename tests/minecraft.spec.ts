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
}, testInfo) => {
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
  const onlineMode = page.getByRole("switch", {
    name: "online mode",
    exact: true,
  });
  await expect(onlineMode).toBeChecked();
  await onlineMode.focus();
  await page.keyboard.press("Space");
  await expect(onlineMode).not.toBeChecked();
  await page
    .getByRole("button", { name: "Save changes (1)", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  expect(
    (
      await (
        await request.get("/api/files/content?path=server.properties", {
          headers,
        })
      ).json()
    ).content,
  ).toContain("online-mode=false");
  await page.getByRole("tab", { name: "bukkit.yml", exact: true }).click();
  const allowEnd = page.getByRole("switch", {
    name: "settings / allow end",
    exact: true,
  });
  await expect(allowEnd).toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath("properties-boolean-on.png"),
    fullPage: true,
    animations: "disabled",
  });
  await allowEnd.click();
  await expect(allowEnd).not.toBeChecked();
  await page
    .getByLabel("settings / connection throttle", { exact: true })
    .fill("2000");
  await page
    .getByRole("button", { name: "Save changes (2)", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  const saved = await (
    await request.get("/api/files/content?path=bukkit.yml", { headers })
  ).json();
  expect(saved.content).toContain("# Keep comment");
  expect(saved.content).toContain("allow-end: false");
  expect(saved.content).toContain("connection-throttle: 2000");
  await page.reload();
  await expect(onlineMode).not.toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath("properties-boolean-saved.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "bukkit.yml", exact: true }).click();
  await expect(allowEnd).not.toBeChecked();
  await expect(
    page.getByLabel("settings / connection throttle", { exact: true }),
  ).toHaveValue("2000");
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
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("properties-boolean-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
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
}, testInfo) => {
  await page.route("**/api/server", async (route) => {
    const response = await route.fetch();
    const server = await response.json();
    await route.fulfill({
      json: {
        ...server,
        software: "NeoForge",
        version: "21.1.200",
        minecraftVersion: "1.21.1",
      },
    });
  });
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
  await expect(page.locator(".versions-build-icon img")).toHaveAttribute(
    "src",
    "/software-icons/neoforge.svg",
  );
  await page.screenshot({
    path: testInfo.outputPath("neoforge-current-and-build-icons.png"),
    fullPage: true,
    animations: "disabled",
  });
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
}, testInfo) => {
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
  let alreadyInstalled = false;
  await page.route("**/api/launchpad/preview", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    previewBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        planId: "review-token",
        title: "Better Mod",
        versionName: "2.0",
        unchangedCount: alreadyInstalled ? 3 : 2,
        files: alreadyInstalled
          ? []
          : [
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
  await expect(dialog).not.toContainText("files are already up to date");
  await expect(dialog).not.toContainText("left unchanged");
  await expect(dialog).toContainText("Review 1 file before continuing.");
  await expect(
    dialog
      .getByRole("list", { name: "Installation files" })
      .getByRole("listitem"),
  ).toHaveCount(1);
  expect(previewBody).toMatchObject({
    platform: "modrinth",
    projectId: "better",
    versionId: "new",
    replacePath: "mods/better-1.jar",
    gameVersion: "1.21.1",
    loader: "neoforge",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("review-changes-mobile.png"),
  });
  alreadyInstalled = true;
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByRole("button", { name: /Review/ }).click();
  await expect(dialog).toContainText("No file changes are needed for 2.0.");
  await expect(dialog).not.toContainText("files are already up to date");
  await expect(
    dialog.getByRole("list", { name: "Installation files" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Already up to date" }),
  ).toBeDisabled();
  await expect(dialog).not.toContainText("Review 0 files");
  expect(submitted).toBeUndefined();
  alreadyInstalled = false;
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByRole("button", { name: /Review/ }).click();
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
  expect(choices).toEqual([
    "All loaders",
    "Fabric",
    "Forge",
    "NeoForge",
    "Quilt",
  ]);
  expect(choices).not.toContain("Paper");
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

test("Launchpad preserves known updates and exposes successful-response provider failures after reentry", async ({
  page,
  serverId,
}) => {
  const version = {
    id: "better-new",
    name: "Better Mod 2.0",
    version: "2.0",
    gameVersions: ["1.21.1"],
    loaders: ["neoforge"],
    publishedAt: "2026-09-01T00:00:00Z",
    downloadable: true,
  };
  const issue = "Modrinth returned 404 while checking this project's versions.";
  let knownUpdate = false;
  let localReads = 0;
  let reentryResponse: Route | undefined;
  const fullRequests: URL[] = [];
  const inventory = (
    updateCheck: "checked" | "pending" | "unavailable",
    compatible = true,
  ) => [
    {
      path: "mods/better-1.jar",
      name: "better-1.jar",
      title: "Better Mod",
      size: 1024,
      platform: "modrinth",
      projectId: "better",
      versionId: "better-old",
      versionName: "1.0",
      update: knownUpdate && compatible ? version : null,
      updateCheck: compatible ? updateCheck : "pending",
      updateIssue:
        compatible && updateCheck === "unavailable" ? issue : undefined,
    },
    {
      path: "mods/companion.jar",
      name: "companion.jar",
      title: "Companion Mod",
      size: 2048,
      platform: "modrinth",
      projectId: "companion",
      versionId: "companion-current",
      versionName: "3.0",
      update: null,
      updateCheck: compatible ? updateCheck : "pending",
      updateIssue:
        compatible && updateCheck === "unavailable" ? issue : undefined,
    },
  ];
  await page.route("**/api/launchpad", (route) =>
    route.fulfill({
      json: {
        platforms: [
          { id: "modrinth", name: "Modrinth", available: true, types: ["mod"] },
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
  await page.route("**/api/launchpad/installed?**", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    const url = new URL(route.request().url());
    const compatible = Boolean(
      url.searchParams.get("gameVersion") && url.searchParams.get("loader"),
    );
    if (url.searchParams.get("local") === "true") {
      localReads++;
      expect(url.searchParams.has("refresh")).toBe(false);
      return route.fulfill({
        json: { items: inventory("pending", compatible), warnings: [] },
      });
    }
    fullRequests.push(url);
    if (fullRequests.length === 3) {
      reentryResponse = route;
      return;
    }
    knownUpdate = true;
    const unavailable = fullRequests.length === 2;
    return route.fulfill({
      status: 200,
      json: {
        items: inventory(unavailable ? "unavailable" : "checked", compatible),
        warnings: [],
      },
    });
  });
  await page.goto("/#launchpad");
  const installedToggle = page.getByRole("switch", {
    name: "Show installed content",
  });
  await installedToggle.check();
  const better = page.getByRole("article", { name: "Better Mod", exact: true });
  const companion = page.getByRole("article", {
    name: "Companion Mod",
    exact: true,
  });
  const update = page.getByRole("button", {
    name: "Update Better Mod",
    exact: true,
  });
  const retry = page.getByRole("button", {
    name: "Retry updates",
    exact: true,
  });
  await expect(update).toBeEnabled();
  await expect(better).toContainText("Available: 2.0");
  await expect(
    companion.getByText("Up to date", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not check updates for 2 installed items.",
  );
  await expect(better.getByText(issue, { exact: true })).toBeVisible();
  await expect(companion.getByText(issue, { exact: true })).toBeVisible();
  await expect(retry).toBeVisible();
  await expect(update).toBeEnabled();
  await expect(better).toContainText("Available: 2.0");
  await expect(companion).toContainText("mods/companion.jar");
  await expect(
    better.getByText("Update check unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    companion.getByText("Update check unavailable", { exact: true }),
  ).toBeVisible();
  await expect(companion.getByText("Up to date", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("link", { name: "Console", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Console", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Launchpad", exact: true }).click();
  await expect(installedToggle).toBeChecked();
  await expect(
    page.getByRole("tab", { name: "Mods", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Loader", { exact: true })).toHaveValue(
    "neoforge",
  );
  await expect.poll(() => Boolean(reentryResponse)).toBe(true);
  await expect(update).toBeEnabled();
  await expect(companion).toContainText("mods/companion.jar");
  await expect(
    companion.getByText("Checking updates…", { exact: true }),
  ).toBeVisible();
  await expect(companion.getByText("Up to date", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("status", {
      name: "Installed content refresh",
      exact: true,
    }),
  ).toBeVisible();
  await reentryResponse!.fulfill({
    status: 200,
    json: { items: inventory("unavailable"), warnings: [] },
  });
  await expect(page.getByRole("alert")).toContainText(
    "Could not check updates for 2 installed items.",
  );
  await expect(better.getByText(issue, { exact: true })).toBeVisible();
  await expect(companion.getByText(issue, { exact: true })).toBeVisible();
  await expect(retry).toBeVisible();
  await expect(update).toBeEnabled();
  await expect(better).toContainText("Available: 2.0");
  await expect(
    better.getByText("Update check unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    companion.getByText("Update check unavailable", { exact: true }),
  ).toBeVisible();
  await expect(companion.getByText("Up to date", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator(".launchpad-project-body > p")).toHaveText([
    "mods/better-1.jar",
    "mods/companion.jar",
  ]);
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(page.getByText(issue, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(update).toBeEnabled();
  await expect(better).toContainText("Available: 2.0");
  await expect(companion).toContainText("mods/companion.jar");
  await expect(
    companion.getByText("Up to date", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Update check unavailable", { exact: true }),
  ).toHaveCount(0);
  expect(localReads).toBe(4);
  expect(
    fullRequests.map((url) => url.searchParams.get("refresh") === "true"),
  ).toEqual([false, true, false, true]);
  // An intentional "All loaders" selection must survive reentry as well.
  await page.getByLabel("Loader", { exact: true }).selectOption("");
  await expect(update).toBeEnabled();
  await expect(
    companion.getByText("Up to date", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Console", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Console", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Launchpad", exact: true }).click();
  await expect(installedToggle).toBeChecked();
  await expect(page.getByLabel("Loader", { exact: true })).toHaveValue("");
  await expect.poll(() => fullRequests.length).toBe(5);
  expect(Object.fromEntries(fullRequests[4].searchParams)).toMatchObject({
    gameVersion: "1.21.1",
    loader: "neoforge",
  });
  await expect(update).toBeEnabled();
  await expect(better).toContainText("Available: 2.0");
  await expect(companion).toContainText("mods/companion.jar");
  await expect(
    companion.getByText("Up to date", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Update check unavailable", { exact: true }),
  ).toHaveCount(0);
});

for (const browse of [
  { name: "All", gameVersion: "", loader: "" },
  { name: "conflicting", gameVersion: "26.2", loader: "fabric" },
]) {
  test(`Launchpad finds updates after installing older JEI and returning from File Manager with ${browse.name} filters`, async ({
    page,
    serverId,
  }) => {
    const latest = {
      id: "jei-latest",
      name: "JEI 19.56.0.439",
      version: "19.56.0.439",
      gameVersions: ["1.21.1"],
      loaders: ["neoforge"],
      publishedAt: "2026-09-01T00:00:00Z",
      downloadable: true,
    };
    const older = {
      ...latest,
      id: "jei-older",
      name: "JEI 19.54.0.429",
      version: "19.54.0.429",
      publishedAt: "2026-08-01T00:00:00Z",
    };
    let installedOlder = false;
    const installedRequests: URL[] = [];
    await page.addInitScript(
      ({ id, gameVersion, loader }) => {
        sessionStorage.setItem(
          `mc-panel.launchpad.view.${id}`,
          JSON.stringify({
            platform: "modrinth",
            type: "mod",
            gameVersion,
            loader,
            installedOnly: true,
          }),
        );
      },
      { id: serverId, gameVersion: browse.gameVersion, loader: browse.loader },
    );
    await page.route("**/api/launchpad", (route) =>
      route.fulfill({
        json: {
          platforms: [
            {
              id: "modrinth",
              name: "Modrinth",
              available: true,
              types: ["mod"],
            },
          ],
          gameVersion: "1.21.1",
          gameVersions: ["26.2", "1.21.1"],
          loader: "neoforge",
          status: "offline",
          warnings: [],
        },
      }),
    );
    await page.route("**/api/launchpad/search?**", (route) =>
      route.fulfill({
        json: { projects: [], total: 0, offset: 0, limit: 10 },
      }),
    );
    await page.route("**/api/launchpad/installed?**", (route) => {
      expect(route.request().headers()["x-server-id"]).toBe(serverId);
      const url = new URL(route.request().url());
      installedRequests.push(url);
      const compatible =
        url.searchParams.get("gameVersion") === "1.21.1" &&
        url.searchParams.get("loader") === "neoforge";
      const local = url.searchParams.get("local") === "true";
      const version = installedOlder ? older : latest;
      return route.fulfill({
        json: {
          items: [
            {
              path: `mods/${version.id}.jar`,
              name: `${version.id}.jar`,
              title: "JEI",
              size: 1024,
              platform: "modrinth",
              projectId: "jei",
              versionId: version.id,
              versionName: version.version,
              update: installedOlder && compatible && !local ? latest : null,
              updateCheck: compatible && !local ? "checked" : "pending",
            },
            {
              path: "mods/companion.jar",
              name: "companion.jar",
              title: "Companion Mod",
              size: 2048,
              platform: "modrinth",
              projectId: "companion",
              versionId: "companion-current",
              versionName: "3.0",
              update: null,
              updateCheck: compatible && !local ? "checked" : "pending",
            },
          ],
          warnings: [],
        },
      });
    });
    await page.route("**/api/launchpad/versions?**", (route) => {
      expect(
        Object.fromEntries(new URL(route.request().url()).searchParams),
      ).toMatchObject({
        gameVersion: "1.21.1",
        loader: "neoforge",
        projectId: "jei",
      });
      return route.fulfill({ json: { versions: [latest, older] } });
    });
    await page.route("**/api/launchpad/preview", (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        gameVersion: "1.21.1",
        loader: "neoforge",
        projectId: "jei",
        versionId: older.id,
        replacePath: "mods/jei-latest.jar",
      });
      return route.fulfill({
        json: {
          planId: "jei-downgrade",
          title: "JEI",
          versionName: older.version,
          files: [
            {
              path: "mods/jei-older.jar",
              previousPath: "mods/jei-latest.jar",
              size: 1024,
              action: "replace",
            },
          ],
          warnings: [],
          expiresAt: "2099-01-01T00:00:00Z",
        },
      });
    });
    await page.route("**/api/launchpad/install", (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        planId: "jei-downgrade",
        confirmed: true,
      });
      installedOlder = true;
      return route.fulfill({
        json: {
          job: {
            id: "jei-downgrade-job",
            status: "completed",
            message: "Older JEI installed",
            completed: 1,
            total: 1,
          },
        },
      });
    });

    await page.goto("/#launchpad");
    const installedToggle = page.getByRole("switch", {
      name: "Show installed content",
    });
    const browseVersion = page.getByLabel("Minecraft version", { exact: true });
    const browseLoader = page.getByLabel("Loader", { exact: true });
    await expect(installedToggle).toBeChecked();
    await expect(browseVersion).toHaveValue(browse.gameVersion);
    await expect(browseLoader).toHaveValue(browse.loader);
    const jei = page.getByRole("article", { name: "JEI", exact: true });
    const companion = page.getByRole("article", {
      name: "Companion Mod",
      exact: true,
    });
    await expect(jei.getByText("Up to date", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Choose version for JEI", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Project version", { exact: true })
      .selectOption(older.id);
    await dialog.getByRole("button", { name: /Review/ }).click();
    await expect(dialog).toContainText("mods/jei-older.jar");
    await dialog
      .getByRole("button", { name: "Confirm installation", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(jei).toContainText("Installed: 19.54.0.429");
    const update = page.getByRole("button", {
      name: "Update JEI",
      exact: true,
    });
    await expect(update).toBeEnabled();

    await page.getByRole("link", { name: "File Manager", exact: true }).click();
    await expect(page).toHaveURL(/#files$/);
    await page.getByRole("link", { name: "Launchpad", exact: true }).click();
    await expect(installedToggle).toBeChecked();
    await expect(browseVersion).toHaveValue(browse.gameVersion);
    await expect(browseLoader).toHaveValue(browse.loader);
    await expect(jei).toContainText("mods/jei-older.jar");
    await expect(jei).toContainText("Available: 19.56.0.439");
    await expect(update).toBeEnabled();
    await expect(
      companion.getByText("Up to date", { exact: true }),
    ).toBeVisible();
    await expect(
      companion.getByText("Update available", { exact: true }),
    ).toHaveCount(0);
    const fullCount = () =>
      installedRequests.filter(
        (url) => url.searchParams.get("local") !== "true",
      ).length;
    const beforeRefresh = fullCount();
    await page
      .getByRole("button", {
        name: "Refresh Launchpad and check updates",
        exact: true,
      })
      .click();
    await expect.poll(fullCount).toBeGreaterThan(beforeRefresh);
    await expect(update).toBeEnabled();
    await expect(jei).toContainText("Installed: 19.54.0.429");
    await expect(
      companion.getByText("Up to date", { exact: true }),
    ).toBeVisible();
    expect(installedRequests.at(-1)!.searchParams.get("refresh")).toBe("true");
    for (const url of installedRequests)
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        type: "mod",
        gameVersion: "1.21.1",
        loader: "neoforge",
      });
  });
}

test("Launchpad confines installed update issues to the matching files and platform", async ({
  page,
  serverId,
}) => {
  const clientIssue =
    "This Modrinth project is client-only and cannot be installed on a server.";
  const curseIssue =
    "CurseForge returned 503 while checking this project's versions.";
  const identificationNotice =
    "Modrinth identification: the provider could not identify one local file.";
  const healthy = {
    id: "healthy-optional",
    platform: "modrinth",
    title: "Healthy Optional Mod",
    description: "Compatible with dedicated servers.",
  };
  const update = {
    id: "healthy-new",
    name: "Healthy Optional Mod 2.0",
    version: "2.0",
    gameVersions: ["1.21.1"],
    loaders: ["neoforge"],
    publishedAt: "2026-09-01T00:00:00Z",
    downloadable: true,
  };
  const items = [
    {
      path: "mods/healthy-optional.jar",
      name: "healthy-optional.jar",
      title: healthy.title,
      size: 1024,
      platform: "modrinth",
      projectId: healthy.id,
      versionId: "healthy-old",
      updateCheck: "checked",
      update,
    },
    {
      path: "mods/client-renderer.jar",
      name: "client-renderer.jar",
      title: "Client Renderer",
      size: 2048,
      platform: "modrinth",
      projectId: "client-renderer",
      versionId: "client-old",
      updateCheck: "unavailable",
      updateIssue: clientIssue,
    },
    {
      path: "mods/local-helper.jar",
      name: "local-helper.jar",
      size: 512,
      platform: null,
      updateCheck: "unavailable",
    },
    {
      path: "mods/curse-addon.jar",
      name: "curse-addon.jar",
      title: "Curse Addon",
      size: 3072,
      platform: "curseforge",
      projectId: "12345",
      versionId: "123456",
      updateCheck: "unavailable",
      updateIssue: curseIssue,
    },
  ];
  await page.route("**/api/launchpad", (route) =>
    route.fulfill({
      json: {
        platforms: [
          { id: "modrinth", name: "Modrinth", available: true, types: ["mod"] },
          {
            id: "curseforge",
            name: "CurseForge",
            available: true,
            types: ["mod"],
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
    route.fulfill({
      json: { projects: [healthy], total: 1, offset: 0, limit: 10 },
    }),
  );
  let fullReads = 0;
  await page.route("**/api/launchpad/installed?**", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    const local =
      new URL(route.request().url()).searchParams.get("local") === "true";
    if (!local) fullReads++;
    return route.fulfill({
      json: {
        items: local
          ? items.map((item) => ({
              ...item,
              updateCheck: "pending",
              updateIssue: undefined,
            }))
          : items,
        warnings: local ? [] : [identificationNotice],
      },
    });
  });
  await page.goto("/#launchpad");
  await expect.poll(() => fullReads).toBe(1);
  await expect(
    page.getByRole("article", { name: healthy.title, exact: true }),
  ).toBeVisible();
  const installedToggle = page.getByRole("switch", {
    name: "Show installed content",
  });
  const retry = page.getByRole("button", {
    name: "Retry updates",
    exact: true,
  });
  await expect(
    page.getByText(identificationNotice, { exact: true }),
  ).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await installedToggle.check();
  const healthyRow = page.getByRole("article", {
    name: healthy.title,
    exact: true,
  });
  const clientRow = page.getByRole("article", {
    name: "Client Renderer",
    exact: true,
  });
  const unidentified = page.getByRole("article", {
    name: "local-helper.jar",
    exact: true,
  });
  const summary = page.getByRole("alert");
  await expect(summary).toHaveCount(1);
  await expect(summary).toContainText(
    "Could not check updates for 1 installed item.",
  );
  await expect(retry).toBeEnabled();
  await expect(clientRow.getByText(clientIssue, { exact: true })).toBeVisible();
  await expect(page.locator(".launchpad-project-issue")).toHaveCount(1);
  await expect(healthyRow.locator(".launchpad-project-issue")).toHaveCount(0);
  await expect(unidentified.locator(".launchpad-project-issue")).toHaveCount(0);
  await expect(
    unidentified.getByText("Unidentified file", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Curse Addon", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(curseIssue, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `Update ${healthy.title}`, exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText(identificationNotice, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Unidentified files stay visible/)).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Some installed update checks could not be completed.", {
      exact: true,
    }),
  ).toHaveCount(0);
  const search = page.getByLabel("Search Launchpad", { exact: true });
  await search.fill("healthy");
  await expect(healthyRow).toBeVisible();
  await expect(summary).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await search.fill("local-helper");
  await expect(unidentified).toBeVisible();
  await expect(summary).toHaveCount(0);
  await search.fill("");
  await expect(summary).toContainText(
    "Could not check updates for 1 installed item.",
  );
  await page.getByLabel("Platform", { exact: true }).selectOption("curseforge");
  await expect(summary).toContainText(
    "Could not check updates for 1 installed item.",
  );
  await expect(
    page
      .getByRole("article", { name: "Curse Addon", exact: true })
      .getByText(curseIssue, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(clientIssue, { exact: true })).toHaveCount(0);
  await expect(page.locator(".launchpad-project-issue")).toHaveCount(1);
  await page.getByLabel("Platform", { exact: true }).selectOption("modrinth");
  await expect(
    page.getByRole("button", { name: `Update ${healthy.title}`, exact: true }),
  ).toBeEnabled();
  await installedToggle.uncheck();
  await expect(healthyRow).toBeVisible();
  await expect(summary).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(
    page.getByText(identificationNotice, { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".launchpad-project-issue")).toHaveCount(0);
});

test("Launchpad lists every affected file and reason beyond the current installed page", async ({
  page,
  serverId,
}, testInfo) => {
  const update = {
    id: "jei-new",
    name: "JEI 19.0",
    version: "19.0",
    gameVersions: ["1.21.1"],
    loaders: ["neoforge"],
    publishedAt: "2026-09-01T00:00:00Z",
    downloadable: true,
  };
  const failures = [
    {
      title: "Zulu Client Renderer",
      reason:
        "This project is client-only and cannot be installed on a server.",
    },
    {
      title: "Zulu Missing Project",
      reason: "Modrinth returned 404 for this installed project's versions.",
    },
    {
      title: "Zulu Offline Provider",
      reason: "The provider could not be reached. Retry this update check.",
    },
    { title: "Zulu Unknown Result", reason: undefined },
  ].map((item, index) => ({
    ...item,
    path: `mods/zulu-${index + 1}.jar`,
    name: `zulu-${index + 1}.jar`,
    size: 2048,
    platform: "modrinth",
    projectId: `failed-${index + 1}`,
    versionId: "old",
    updateCheck: "unavailable",
    updateIssue: item.reason,
  }));
  const healthy = Array.from({ length: 9 }, (_, index) => ({
    title: `Alpha Healthy ${index + 1}`,
    path: `mods/alpha-${index + 1}.jar`,
    name: `alpha-${index + 1}.jar`,
    size: 1024,
    platform: "modrinth",
    projectId: `healthy-${index + 1}`,
    versionId: "current",
    updateCheck: "checked",
  }));
  const items = [
    ...failures,
    {
      title: "JEI",
      path: "mods/jei-old.jar",
      name: "jei-old.jar",
      size: 4096,
      platform: "modrinth",
      projectId: "jei",
      versionId: "old",
      updateCheck: "checked",
      update,
    },
    ...healthy,
    {
      path: "mods/local-helper.jar",
      name: "local-helper.jar",
      size: 512,
      platform: null,
      updateCheck: "unavailable",
    },
    {
      title: "Other Provider Failure",
      path: "mods/other-provider.jar",
      name: "other-provider.jar",
      size: 1024,
      platform: "curseforge",
      projectId: "12345",
      updateCheck: "unavailable",
      updateIssue: "A separate provider is unavailable.",
    },
  ];
  await page.route("**/api/launchpad", (route) =>
    route.fulfill({
      json: {
        platforms: [
          { id: "modrinth", name: "Modrinth", available: true, types: ["mod"] },
          {
            id: "curseforge",
            name: "CurseForge",
            available: true,
            types: ["mod"],
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
  await page.route("**/api/launchpad/installed?**", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    const local =
      new URL(route.request().url()).searchParams.get("local") === "true";
    return route.fulfill({
      json: {
        items: local
          ? items.map((item) => ({
              ...item,
              updateCheck: "pending",
              updateIssue: undefined,
            }))
          : items,
        warnings: [],
      },
    });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await expect(
    page.getByLabel("Launchpad rows per page", { exact: true }),
  ).toHaveValue("10");
  const names = page.getByRole("article").getByRole("heading", { level: 3 });
  await expect(names).toHaveText(["JEI", ...healthy.map((item) => item.title)]);
  await expect(
    page.getByRole("button", { name: "Update JEI", exact: true }),
  ).toBeEnabled();
  const summary = page.getByRole("alert");
  await expect(summary).toContainText(
    "Could not check updates for 4 installed items.",
  );
  const affected = summary.getByRole("list", {
    name: "Files with unavailable update checks",
    exact: true,
  });
  await expect(affected).toBeHidden();
  await summary.getByText("View affected files", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(affected).toBeVisible();
  await expect(affected.getByRole("listitem")).toHaveCount(4);
  for (const item of failures) {
    const entry = affected
      .getByRole("listitem")
      .filter({ has: page.getByText(item.title, { exact: true }) });
    await expect(entry).toContainText(item.path);
    await expect(entry).toContainText(
      item.reason ??
        "No verified update result is available for this file. Retry the check.",
    );
    await expect(
      page.getByRole("article", { name: item.title, exact: true }),
    ).toHaveCount(0);
  }
  await expect(affected).not.toContainText("local-helper.jar");
  await expect(affected).not.toContainText("Other Provider Failure");
  await expect(affected).not.toContainText("JEI");
  await summary.screenshot({
    path: testInfo.outputPath("all-unavailable-files-desktop.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Next Launchpad page", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "Launchpad page", exact: true }),
  ).toHaveText("Page 2 of 2");
  await expect(names).toHaveText([
    "local-helper.jar",
    ...failures.map((item) => item.title),
  ]);
  await expect(affected).toBeVisible();
  await expect(affected.getByRole("listitem")).toHaveCount(4);
  const search = page.getByLabel("Search Launchpad", { exact: true });
  await search.fill("Missing Project");
  await expect(summary).toContainText(
    "Could not check updates for 1 installed item.",
  );
  await expect(affected.getByRole("listitem")).toHaveCount(1);
  await expect(affected).toContainText(failures[1].reason!);
  await search.fill("JEI");
  await expect(summary).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Update JEI", exact: true }),
  ).toBeEnabled();
  await search.fill("local-helper");
  await expect(summary).toHaveCount(0);
  await search.fill("");
  await expect(summary).toContainText(
    "Could not check updates for 4 installed items.",
  );
  await summary.getByText("View affected files", { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(1);
  await expect(affected).toBeVisible();
  await expect(affected.getByRole("listitem")).toHaveCount(4);
  await expect
    .poll(() =>
      affected.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeGreaterThan(270);
  await affected.getByRole("listitem").last().scrollIntoViewIfNeeded();
  await expect(affected.getByRole("listitem").last()).toBeInViewport();
  await affected.getByRole("listitem").first().scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await summary.screenshot({
    path: testInfo.outputPath("all-unavailable-files-mobile.png"),
    animations: "disabled",
  });
});

test("Launchpad requires an explicit Install anyway choice for unchecked requirements", async ({
  page,
  serverId,
}) => {
  const version = {
    id: "jei-new",
    name: "JEI 19.0",
    version: "19.0",
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
        items: [
          {
            path: "mods/jei-old.jar",
            name: "jei-old.jar",
            title: "JEI",
            size: 1024,
            platform: "modrinth",
            projectId: "jei",
            versionId: "jei-old",
            updateCheck: "checked",
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
  let reviews = 0;
  await page.route("**/api/launchpad/preview", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    expect(route.request().postDataJSON()).toMatchObject({
      platform: "modrinth",
      projectId: "jei",
      versionId: "jei-new",
      replacePath: "mods/jei-old.jar",
    });
    return route.fulfill({
      json: {
        planId: `jei-review-${++reviews}`,
        title: "JEI",
        versionName: "19.0",
        files: [
          {
            path: "mods/jei-new.jar",
            previousPath: "mods/jei-old.jar",
            size: 2048,
            action: "replace",
          },
        ],
        unavailableDependencies: [
          {
            platform: "modrinth",
            projectId: "7tEfOcA7",
            requiredBy: "JEI",
          },
        ],
        warnings: [],
        expiresAt: "2099-01-01T00:00:00Z",
      },
    });
  });
  const installations: unknown[] = [];
  await page.route("**/api/launchpad/install", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    installations.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        job: {
          id: "jei-job",
          status: "completed",
          message: "JEI updated with the reviewed dependency choice",
          completed: 1,
          total: 1,
        },
      },
    });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await page.getByRole("button", { name: "Update JEI", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Review/ }).click();
  await expect(
    dialog.getByText("Some requirements couldn’t be checked", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("list", { name: "Installation files", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(1);
  await expect(dialog).toContainText("mods/jei-new.jar");
  const technical = dialog.getByText("Technical details", { exact: true });
  const missing = dialog.getByRole("list", {
    name: "Unavailable required dependencies",
  });
  await expect(missing).toBeHidden();
  await technical.click();
  await expect(missing).toHaveText(
    "Modrinth project 7tEfOcA7 · required by JEI",
  );
  await technical.click();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Confirm installation", exact: true }),
  ).toHaveCount(0);
  const confirm = dialog.getByRole("button", {
    name: "Install anyway",
    exact: true,
  });
  await expect(confirm).toBeEnabled();
  await dialog
    .getByRole("list", { name: "Installation files", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  expect(installations).toHaveLength(0);
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByRole("button", { name: /Review/ }).click();
  await expect(confirm).toBeEnabled();
  await expect(missing).toBeHidden();
  expect(installations).toHaveLength(0);
  await confirm.click();
  await expect(dialog).not.toBeVisible();
  expect(installations).toEqual([
    {
      planId: "jei-review-2",
      confirmed: true,
      acknowledgedUnavailableDependencies: true,
    },
  ]);
  await expect(
    page.getByRole("status", { name: "Installation status", exact: true }),
  ).toContainText("JEI updated with the reviewed dependency choice");
});

for (const unavailable of [true, false])
  test(`Launchpad reviews bundled libraries ${unavailable ? "alongside unresolved catalog dependencies" : "without an unnecessary catalog acknowledgment"}`, async ({
    page,
    serverId,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1200 });
    const version = {
      id: "example-mod-new",
      name: "Example Mod 2.0",
      version: "2.0",
      gameVersions: ["1.21.1"],
      loaders: ["neoforge"],
      publishedAt: "2026-09-01T00:00:00Z",
      downloadable: true,
    };
    const previousPath = "mods/example-mod-1.0.jar";
    const nextPath = "mods/example-mod-2.0.jar";
    const bundledPath = "META-INF/jarjar/bundled-library-0.5.6.jar";
    await page.route("**/api/launchpad", (route) =>
      route.fulfill({
        json: {
          platforms: [
            {
              id: "modrinth",
              name: "Modrinth",
              available: true,
              types: ["mod"],
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
          items: [
            {
              path: previousPath,
              name: previousPath.split("/").pop(),
              title: "Example Mod",
              size: 1024,
              platform: "modrinth",
              projectId: "example-mod",
              versionId: "example-mod-old",
              updateCheck: "checked",
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
    await page.route("**/api/launchpad/preview", (route) => {
      expect(route.request().headers()["x-server-id"]).toBe(serverId);
      expect(route.request().postDataJSON()).toMatchObject({
        platform: "modrinth",
        projectId: "example-mod",
        versionId: version.id,
        replacePath: previousPath,
      });
      return route.fulfill({
        json: {
          planId: "bundled-example-mod",
          title: "Example Mod",
          versionName: version.version,
          files: [
            { path: nextPath, previousPath, size: 2048, action: "replace" },
          ],
          warnings: [],
          bundledDependencies: [
            {
              title: "Bundled Library",
              version: "0.5.6",
              path: bundledPath,
              bundledWith: nextPath,
              serverCompatible: true,
            },
            ...(unavailable
              ? [
                  {
                    title: "Client Library",
                    version: "1.0",
                    path: "META-INF/jarjar/client-library-1.0.jar",
                    bundledWith: nextPath,
                    serverCompatible: false,
                  },
                ]
              : []),
          ],
          unavailableDependencies: unavailable
            ? [
                {
                  platform: "modrinth",
                  projectId: "unresolved-catalog-project",
                  requiredBy: "Example Mod",
                },
              ]
            : [],
          expiresAt: "2099-01-01T00:00:00Z",
        },
      });
    });
    let submitted: Record<string, unknown> | undefined;
    await page.route("**/api/launchpad/install", (route) => {
      expect(route.request().headers()["x-server-id"]).toBe(serverId);
      submitted = route.request().postDataJSON();
      return route.fulfill({
        json: {
          job: {
            id: "example-mod-job",
            status: "completed",
            message: "Example Mod 2.0 updated",
            completed: 1,
            total: 1,
          },
        },
      });
    });
    await page.goto("/#launchpad");
    await page.getByRole("switch", { name: "Show installed content" }).check();
    await page
      .getByRole("button", { name: "Update Example Mod", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /Review/ }).click();
    const files = dialog.getByRole("list", {
      name: "Installation files",
      exact: true,
    });
    await expect(files.getByRole("listitem")).toHaveCount(unavailable ? 3 : 2);
    const bundled = files.getByRole("listitem").filter({
      hasText: "Bundled Library",
    });
    await expect(bundled).toContainText("Bundled Library 0.5.6");
    await expect(bundled).toContainText("Included in example-mod-2.0.jar");
    await expect(files.getByText("Included", { exact: true })).toHaveCount(
      unavailable ? 2 : 1,
    );
    await expect(files).not.toContainText(bundledPath);
    const inactive = files.getByText("Not active on the server");
    if (unavailable) {
      await expect(inactive).toHaveCount(1);
      await expect(
        files.getByRole("listitem").filter({ hasText: "Client Library" }),
      ).toContainText("Not active on the server");
    } else await expect(inactive).toHaveCount(0);
    await expect(bundled).not.toContainText("Not active on the server");
    await expect(files).toContainText(nextPath);
    await expect(dialog).toContainText(
      `Review 1 file and ${unavailable ? "2 included libraries" : "1 included library"} before continuing.`,
    );
    const missing = dialog.getByRole("list", {
      name: "Unavailable required dependencies",
      exact: true,
    });
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    const confirm = dialog.getByRole("button", {
      name: unavailable ? "Install anyway" : "Confirm installation",
      exact: true,
    });
    if (unavailable) {
      await expect(missing).toBeHidden();
      const technical = dialog.getByText("Technical details", { exact: true });
      await technical.click();
      await expect(missing).toContainText("unresolved-catalog-project");
      await technical.click();
      await expect(confirm).toBeEnabled();
      await expect(
        dialog.getByText("Some requirements couldn’t be checked", {
          exact: true,
        }),
      ).toBeVisible();
    } else {
      await expect(missing).toHaveCount(0);
      await expect(
        dialog.getByText("Some requirements couldn’t be checked", {
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        dialog.getByText("Technical details", { exact: true }),
      ).toHaveCount(0);
      await expect(confirm).toBeEnabled();
    }
    await dialog.screenshot({
      path: testInfo.outputPath(
        `bundled-dependency-${unavailable ? "unresolved-catalog" : "complete"}.png`,
      ),
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(files).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await dialog.screenshot({
      path: testInfo.outputPath(
        `bundled-dependency-${unavailable ? "unresolved-catalog" : "complete"}-mobile.png`,
      ),
      animations: "disabled",
    });
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport();
    if (unavailable)
      await dialog.screenshot({
        path: testInfo.outputPath(
          "bundled-dependency-unresolved-catalog-mobile-actions.png",
        ),
        animations: "disabled",
      });
    await confirm.click();
    await expect(dialog).not.toBeVisible();
    expect(submitted).toEqual({
      planId: "bundled-example-mod",
      confirmed: true,
      ...(unavailable ? { acknowledgedUnavailableDependencies: true } : {}),
    });
    await expect(
      page.getByRole("status", { name: "Installation status", exact: true }),
    ).toContainText("Example Mod 2.0 updated");
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
    // An unknown runtime still uses the saved browse targets and must cancel
    // metadata belonging to an earlier manual target or content type.
    await page.addInitScript((id) => {
      sessionStorage.setItem(
        `mc-panel.launchpad.view.${id}`,
        JSON.stringify({
          platform: "modrinth",
          type: "mod",
          gameVersion: "1.21.1",
          loader: "neoforge",
        }),
      );
    }, serverId);
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
          gameVersion:
            route.request().headers()["x-server-id"] === serverId
              ? null
              : "1.21.1",
          gameVersions: ["1.21.1", "1.20.1"],
          loader:
            route.request().headers()["x-server-id"] === serverId
              ? null
              : "neoforge",
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

for (const browse of [
  { name: "blank", gameVersion: "", loader: "" },
  { name: "conflicting", gameVersion: "26.2", loader: "fabric" },
]) {
  test(`Launchpad install targets use the configured server with ${browse.name} saved browse filters`, async ({
    page,
    serverId,
  }) => {
    const versionRequests: URL[] = [];
    await page.route("**/api/launchpad", (route) =>
      route.fulfill({
        json: {
          platforms: [
            {
              id: "modrinth",
              name: "Modrinth",
              available: true,
              types: ["mod"],
            },
          ],
          gameVersion: "1.21.1",
          gameVersions: ["26.2", "1.21.1"],
          loader: "neoforge",
          status: "offline",
          warnings: [],
        },
      }),
    );
    await page.route("**/api/launchpad/installed?**", (route) =>
      route.fulfill({ json: { items: [], warnings: [] } }),
    );
    await page.route("**/api/launchpad/search?**", (route) =>
      route.fulfill({
        json: {
          projects: [
            {
              id: "jei",
              platform: "modrinth",
              title: "JEI",
              description: "Just Enough Items",
            },
          ],
          total: 1,
          offset: 0,
          limit: 10,
        },
      }),
    );
    await page.route("**/api/launchpad/versions?**", (route) => {
      expect(route.request().headers()["x-server-id"]).toBe(serverId);
      const url = new URL(route.request().url());
      versionRequests.push(url);
      // An unfiltered catalog really would choose the newer incompatible build.
      const gameVersion = url.searchParams.get("gameVersion") || "26.2";
      const loader = url.searchParams.get("loader") || "fabric";
      return route.fulfill({
        json: {
          versions: [
            {
              id: `jei-${gameVersion}-${loader}`,
              name: gameVersion === "1.21.1" ? "JEI 19.27" : "JEI 27.4",
              version: gameVersion === "1.21.1" ? "19.27" : "27.4",
              gameVersions: [gameVersion],
              loaders: [loader],
              publishedAt: "2026-09-01T00:00:00Z",
              downloadable: true,
            },
          ],
        },
      });
    });

    await page.goto("/#launchpad");
    const browseVersion = page.getByLabel("Minecraft version", { exact: true });
    const browseLoader = page.getByLabel("Loader", { exact: true });
    await expect(browseVersion).toHaveValue("1.21.1");
    await browseVersion.selectOption(browse.gameVersion);
    await browseLoader.selectOption(browse.loader);
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            JSON.parse(
              sessionStorage.getItem(`mc-panel.launchpad.view.${id}`) || "null",
            ),
          serverId,
        ),
      )
      .toMatchObject({
        gameVersion: browse.gameVersion,
        loader: browse.loader,
      });
    await page.reload();
    await expect(browseVersion).toHaveValue(browse.gameVersion);
    await expect(browseLoader).toHaveValue(browse.loader);
    await page
      .getByRole("button", { name: "Install JEI", exact: true })
      .click();

    const dialog = page.getByRole("dialog");
    const targetVersion = dialog.getByLabel("Target Minecraft version", {
      exact: true,
    });
    const targetLoader = dialog.getByLabel("Target loader", { exact: true });
    const projectVersion = dialog.getByLabel("Project version", {
      exact: true,
    });
    await expect(targetVersion).toHaveValue("1.21.1");
    await expect(targetLoader).toHaveValue("neoforge");
    await expect(projectVersion).toHaveValue("jei-1.21.1-neoforge");
    await expect(projectVersion.locator("option")).toHaveText([
      "Select a version",
      "JEI 19.27",
    ]);
    expect(versionRequests.length).toBeGreaterThan(0);
    for (const request of versionRequests)
      expect(Object.fromEntries(request.searchParams)).toMatchObject({
        projectId: "jei",
        type: "mod",
        gameVersion: "1.21.1",
        loader: "neoforge",
      });

    await targetVersion.selectOption("26.2");
    await expect(projectVersion).toHaveValue("jei-26.2-neoforge");
    await targetLoader.selectOption("fabric");
    await expect(projectVersion).toHaveValue("jei-26.2-fabric");
    expect(
      Object.fromEntries(versionRequests.at(-1)!.searchParams),
    ).toMatchObject({
      gameVersion: "26.2",
      loader: "fabric",
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(browseVersion).toHaveValue(browse.gameVersion);
    await expect(browseLoader).toHaveValue(browse.loader);
  });
}

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
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(logos).toHaveCount(18);
  await page.screenshot({
    path: testInfo.outputPath("software-logos-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
});
