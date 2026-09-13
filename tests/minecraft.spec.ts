import { test as base, expect } from "@playwright/test";
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
