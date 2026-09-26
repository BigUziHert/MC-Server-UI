import { test as base, expect, type Page, type Route } from "@playwright/test";
import { createProcessServer, removeTestServer } from "./server-fixtures";

const test = base.extend<{ serverId: string }>({
  serverId: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29600;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const response = await createProcessServer(request, {
      data: { name: "Review fixture", mode: "live", port },
    });
    expect(response.status()).toBe(201);
    const { server } = await response.json();
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
const version = {
  id: "new",
  name: "New release",
  version: "2.0",
  gameVersions: ["1.21.1"],
  loaders: ["neoforge"],
  publishedAt: "2026-09-01",
  downloadable: true,
};
const installed = (id: string, platform = "modrinth") => ({
  path: `mods/${id}.jar`,
  name: `${id}.jar`,
  sha512: id,
  size: 100,
  title: id,
  platform,
  projectId: id,
  versionId: "old",
  versionName: "1.0",
  update: version,
  updateCheck: "checked",
  url: `https://modrinth.com/project/${id}`,
});
async function catalog(page: Page, type = "mod") {
  await page.route(/\/api\/launchpad(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        platforms: ["modrinth", "curseforge"].map((id) => ({
          id,
          name: id,
          available: true,
          types: [type],
        })),
        status: "offline",
        gameVersion: "1.21.1",
        loader: "neoforge",
        gameVersions: ["1.21.1"],
        warnings: [],
      },
    }),
  );
  await page.route("**/api/launchpad/search?**", (route) =>
    route.fulfill({
      json: {
        projects: [
          {
            id: "Pack",
            title: "Pack",
            platform: "modrinth",
            description: "Pack",
          },
        ],
        total: 1,
        offset: 0,
        limit: 10,
      },
    }),
  );
  await page.route("**/api/launchpad/versions?**", (route) =>
    route.fulfill({ json: { versions: [version] } }),
  );
}
const plan = {
  planId: "review",
  title: "Pack",
  versionName: "2.0",
  expiresAt: "2099-01-01",
  files: [{ path: "mods/a.jar", size: 100, action: "replace" }],
  warnings: [],
};

test("220 installed files stay usable while provider checks run without rescanning on list controls", async ({
  page,
  serverId,
}, testInfo) => {
  await catalog(page);
  const items = Array.from({ length: 220 }, (_, index) => ({
    ...installed(`Mod ${String(index + 1).padStart(3, "0")}`),
    size: index + 1,
    update: null,
    updateCheck: "pending",
  }));
  const requests: URL[] = [];
  let heldOnline: Route | undefined;
  let heldRefresh: Route | undefined;
  let localReads = 0;
  let onlineReads = 0;
  const warnings = [
    "Modrinth is temporarily unavailable (503). Update checks will be available when the provider recovers.",
    "CurseForge is temporarily unavailable (502). Installed files are unchanged.",
  ];
  await page.route("**/api/launchpad/installed?**", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.searchParams.has("local")) {
      expect(url.searchParams.get("quick")).toBe("true");
      localReads++;
      if (localReads === 2) {
        heldRefresh = route;
        return;
      }
      return route.fulfill({ json: { items, warnings: [] } });
    }
    expect(url.searchParams.get("background")).toBe("true");
    onlineReads++;
    if (onlineReads === 1) {
      heldOnline = route;
      return;
    }
    return route.fulfill({
      json: {
        items: items.map((item) => ({ ...item, updateCheck: "checked" })),
        warnings: Array.from(
          { length: 220 },
          (_, index) => warnings[index % 2],
        ),
      },
    });
  });
  await page.goto("/#launchpad");
  const toggle = page.getByRole("switch", { name: "Show installed content" });
  await toggle.check();
  await expect.poll(() => Boolean(heldOnline)).toBe(true);
  await expect(page.getByRole("article")).toHaveCount(10);
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page
    .getByRole("button", { name: "Next Launchpad page", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "Launchpad page", exact: true }),
  ).toHaveText("Page 2 of 22");
  await page
    .getByLabel("Launchpad rows per page", { exact: true })
    .selectOption("25");
  await expect(page.getByRole("article")).toHaveCount(25);
  await page
    .getByLabel("Sort installed content", { exact: true })
    .selectOption("size");
  await expect(page.getByRole("article").first()).toHaveAttribute(
    "aria-label",
    "Mod 220",
  );
  const search = page.getByLabel("Search Launchpad", { exact: true });
  await search.fill("Mod 217");
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("article")).toHaveAttribute(
    "aria-label",
    "Mod 217",
  );
  await search.fill("");
  await expect(page.getByRole("article")).toHaveCount(25);
  await toggle.uncheck();
  await expect(
    page.getByRole("button", { name: "Install Pack", exact: true }),
  ).toBeVisible();
  await toggle.check();
  await expect(page.getByRole("article")).toHaveCount(25);
  expect(requests).toHaveLength(2);
  expect(localReads).toBe(1);
  expect(onlineReads).toBe(1);

  await heldOnline!.fulfill({
    json: {
      items,
      warnings: [],
      checkingUpdates: true,
      progress: { completed: 40, total: 220 },
    },
  });
  await expect(
    page.getByRole("status", {
      name: "Installed content refresh",
      exact: true,
    }),
  ).toHaveText("Checking updates for 180 of 220…");
  await expect.poll(() => onlineReads).toBe(2);
  await expect(
    page.getByRole("status", {
      name: "Installed content refresh",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(requests.at(-1)!.searchParams.has("refresh")).toBe(false);
  const notices = page.locator(".launchpad-notices");
  await expect(notices).toHaveCount(1);
  await expect(
    notices.getByText(
      "2 provider or file notices — installed files remain available",
      { exact: true },
    ),
  ).toBeVisible();
  const details = notices.getByRole("list", {
    name: "Provider and file notices",
  });
  await expect(details).toBeHidden();
  await notices.locator("summary").click();
  await expect(details.getByRole("listitem")).toHaveText(warnings);
  await notices.locator("summary").click();
  await notices.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("installed-220-notices-desktop.png"),
    animations: "disabled",
  });

  await page
    .getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    })
    .click();
  await expect.poll(() => Boolean(heldRefresh)).toBe(true);
  await expect(page.getByRole("article")).toHaveCount(25);
  await search.fill("Mod 219");
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("article")).toHaveAttribute(
    "aria-label",
    "Mod 219",
  );
  expect(requests).toHaveLength(4);
  await page.setViewportSize({ width: 390, height: 844 });
  await notices.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("installed-220-background-mobile.png"),
    animations: "disabled",
  });
  await heldRefresh!.fulfill({ json: { items, warnings: [] } });
  await expect(
    page.getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    }),
  ).toBeEnabled();
  expect(localReads).toBe(2);
  expect(onlineReads).toBe(3);
  expect(requests.at(-1)!.searchParams.get("refresh")).toBe("true");
});

test("a 120-second background check deadline preserves completed rows and fails only unfinished checks", async ({
  page,
}) => {
  await catalog(page);
  await page.clock.install();
  const items = [
    { ...installed("Current Mod"), update: null },
    installed("Verified Update"),
    { ...installed("Pending Mod"), update: null, updateCheck: "pending" },
    {
      ...installed("Provider Failure"),
      update: null,
      updateCheck: "unavailable",
      updateIssue: "Provider is temporarily unavailable (503).",
    },
    ...Array.from({ length: 170 }, (_, index) => ({
      ...installed(`Z verified ${index}`),
      update: null,
    })),
    ...Array.from({ length: 47 }, (_, index) => ({
      path: `mods/z-unreadable-${index}.jar`,
      name: `z-unreadable-${index}.jar`,
      size: 100,
      platform: null,
      updateCheck: "unavailable",
    })),
  ];
  let onlineReads = 0;
  await page.route("**/api/launchpad/installed?**", (route) => {
    const local = new URL(route.request().url()).searchParams.has("local");
    if (!local) onlineReads++;
    return route.fulfill({
      json: {
        items,
        warnings: [],
        ...(!local && {
          checkingUpdates: true,
          progress: { completed: 220, total: 221 },
        }),
      },
    });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  const progress = page.getByRole("status", {
    name: "Installed content refresh",
    exact: true,
  });
  await expect(progress).toHaveText("Checking updates for 1 of 221…");
  await page.clock.fastForward(120_001);
  await expect(progress).toHaveCount(0);
  await expect(
    page.getByText(/The update check is taking longer than expected/).first(),
  ).toBeVisible();
  const current = page.getByRole("article", {
    name: "Current Mod",
    exact: true,
  });
  await expect(current.getByText("Up to date", { exact: true })).toBeVisible();
  await expect(current.getByText("Update check unavailable")).toHaveCount(0);
  const verified = page.getByRole("article", {
    name: "Verified Update",
    exact: true,
  });
  await expect(
    verified.getByRole("button", {
      name: "Update Verified Update",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(verified.getByText("Update check unavailable")).toHaveCount(0);
  await expect(
    page
      .getByRole("article", { name: "Pending Mod", exact: true })
      .getByText("Update check unavailable"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("article", { name: "Provider Failure", exact: true })
      .getByText("Provider is temporarily unavailable (503).", { exact: true }),
  ).toBeVisible();
  expect(onlineReads).toBe(1);
});

test("a failed initial online refresh does not reuse an old checked status but keeps known updates", async ({
  page,
}) => {
  await catalog(page);
  const items = [
    { ...installed("Current Mod"), update: null },
    installed("Verified Update"),
  ];
  let onlineReads = 0;
  await page.route("**/api/launchpad/installed?**", (route) => {
    const local = new URL(route.request().url()).searchParams.has("local");
    if (!local && ++onlineReads === 2)
      return route.fulfill({
        status: 503,
        json: { error: "Fixture provider gateway offline." },
      });
    return route.fulfill({
      json: {
        items:
          local && onlineReads > 0
            ? items.map((item) => ({ ...item, updateCheck: "pending" }))
            : items,
        warnings: [],
      },
    });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  const current = page.getByRole("article", {
    name: "Current Mod",
    exact: true,
  });
  await expect(current.getByText("Up to date", { exact: true })).toBeVisible();
  await expect.poll(() => onlineReads).toBe(1);
  const refresh = page.getByRole("button", {
    name: "Refresh Launchpad and check updates",
    exact: true,
  });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(current.getByText("Update check unavailable")).toBeVisible();
  await expect(current.getByText("Up to date", { exact: true })).toHaveCount(0);
  await expect(
    current.getByText("Fixture provider gateway offline.", { exact: true }),
  ).toBeVisible();
  const verified = page.getByRole("article", {
    name: "Verified Update",
    exact: true,
  });
  await expect(
    verified.getByRole("button", {
      name: "Update Verified Update",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(verified.getByText("Update check unavailable")).toBeVisible();
  await expect(refresh).toBeEnabled();
  expect(onlineReads).toBe(2);
});

test("installed content tabs retain their own snapshots and ignore late responses for another type", async ({
  page,
}) => {
  await catalog(page);
  const mod = installed("Known Mod");
  const datapack = {
    ...installed("Datapack"),
    path: "world/datapacks/pack.zip",
  };
  let staleDatapack: Route | undefined;
  let heldMods: Route | undefined;
  let modReads = 0;
  await page.route("**/api/launchpad/installed?**", (route) => {
    const url = new URL(route.request().url());
    const local = url.searchParams.has("local");
    if (url.searchParams.get("type") === "datapack") {
      if (!local) {
        staleDatapack = route;
        return;
      }
      return route.fulfill({ json: { items: [datapack], warnings: [] } });
    }
    if (local && ++modReads === 2) {
      heldMods = route;
      return;
    }
    return route.fulfill({ json: { items: [mod], warnings: [] } });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await expect(
    page.getByRole("article", { name: "Known Mod", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", {
      name: "Installed content refresh",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Datapacks", exact: true }).click();
  await expect.poll(() => Boolean(staleDatapack)).toBe(true);
  await expect(
    page.getByRole("article", { name: "Datapack", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Mods", exact: true }).click();
  await expect.poll(() => Boolean(heldMods)).toBe(true);
  await expect(
    page.getByRole("article", { name: "Known Mod", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await staleDatapack!
    .fulfill({
      json: {
        items: [{ ...datapack, title: "Stale datapack result" }],
        warnings: ["Stale warning"],
      },
    })
    .catch(() => {});
  await heldMods!.fulfill({ json: { items: [mod], warnings: [] } });
  await expect(
    page.getByRole("status", {
      name: "Installed content refresh",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("article", { name: "Known Mod", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Stale datapack result", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Stale warning", { exact: true })).toHaveCount(0);
});

test("installed project buttons resolve older panel responses without metadata URLs", async ({
  page,
}) => {
  await catalog(page);
  const items = [
    { ...installed("Alpha"), url: undefined },
    { ...installed("238222", "curseforge"), title: "JEI", url: undefined },
    {
      ...installed("Unknown"),
      platform: null,
      projectId: undefined,
      update: undefined,
      url: undefined,
    },
  ];
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items, warnings: [] } }),
  );
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await expect(
    page.getByRole("link", { name: "Open Alpha project page" }),
  ).toHaveAttribute("href", "https://modrinth.com/project/Alpha");
  await expect(
    page.getByRole("link", { name: "Open JEI project page" }),
  ).toHaveAttribute("href", "https://www.curseforge.com/projects/238222");
  await expect(
    page.getByRole("link", { name: "Open Unknown project page" }),
  ).toHaveCount(0);
  await page
    .getByRole("article", { name: "Alpha", exact: true })
    .getByRole("button", { name: "Update Alpha", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("link", { name: "Open project page" }),
  ).toHaveAttribute("href", "https://modrinth.com/project/Alpha");
});

test("installed project links and update-all review span platforms and retry the accepted download", async ({
  page,
}) => {
  await catalog(page);
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({
      json: {
        items: [installed("Alpha"), installed("Beta", "curseforge")],
        warnings: [],
      },
    }),
  );
  let updates: unknown,
    installs: unknown[] = [];
  await page.route("**/api/launchpad/updates/preview", (route) => {
    updates = route.request().postDataJSON();
    return route.fulfill({ json: plan });
  });
  const retryInput = { planId: "review", confirmed: true };
  await page.route("**/api/launchpad/install", (route) => {
    installs.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        job:
          installs.length === 1
            ? {
                id: "job",
                status: "failed",
                message: "Download stalled",
                completed: 1,
                total: 2,
                retryable: true,
                retryInput,
              }
            : {
                id: "job-retry",
                status: "completed",
                message: "Installed",
                completed: 2,
                total: 2,
              },
      },
    });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await expect(
    page.getByRole("link", { name: "Open Alpha project page" }),
  ).toHaveAttribute("href", "https://modrinth.com/project/Alpha");
  await expect(
    page.getByRole("link", { name: "Open Beta project page" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Platform", exact: true }),
  ).toHaveValue("all");
  await expect(
    page.getByRole("combobox", { name: "Minecraft version", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Loader", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Update all", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Review installation" }),
  ).toBeVisible();
  expect(updates).toMatchObject({
    updates: [
      { platform: "modrinth", replacePath: "mods/Alpha.jar" },
      { platform: "curseforge", replacePath: "mods/Beta.jar" },
    ],
  });
  await page
    .getByRole("button", { name: "Confirm installation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry download", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "Installation status", exact: true }),
  ).toContainText("Installation completed");
  expect(installs).toEqual([retryInput, retryInput]);
});

test("unreadable removal dependencies require acknowledgement before confirmation", async ({
  page,
}) => {
  await catalog(page);
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [installed("Alpha")], warnings: [] } }),
  );
  await page.route("**/api/launchpad/removal-preview", (route) =>
    route.fulfill({
      json: {
        planId: "removal",
        title: "Alpha",
        files: [{ path: "mods/Alpha.jar", size: 100 }],
        warnings: ["mods/broken.jar: unreadable metadata"],
        dependents: [],
        blocked: false,
        requiresAcknowledgement: true,
      },
    }),
  );
  let body: unknown;
  await page.route("**/api/launchpad/remove", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await page.getByRole("button", { name: "Remove Alpha", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Remove mod", exact: true });
  const remove = dialog.getByRole("button", {
    name: "Remove mod",
    exact: true,
  });
  await expect(remove).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: /unreadable dependencies/ })
    .check();
  await remove.click();
  await expect(dialog).not.toBeVisible();
  expect(body).toEqual({
    planId: "removal",
    confirmed: true,
    acknowledgedUnreadableDependencies: true,
  });
});

test("modpack installation waits for the requested backup and stops on backup failure", async ({
  page,
}) => {
  await catalog(page, "modpack");
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
  await page.route("**/api/launchpad/preview", (route) =>
    route.fulfill({
      json: { ...plan, cleanInstall: true, hasExistingContent: true },
    }),
  );
  const calls: string[] = [];
  let fail = true;
  await page.route("**/api/backups", (route) => {
    calls.push("backup");
    return route.fulfill(
      fail
        ? { status: 409, json: { error: "Backup destination unavailable" } }
        : { status: 201, json: { ok: true } },
    );
  });
  await page.route("**/api/launchpad/install", (route) => {
    calls.push("install");
    return route.fulfill({
      json: {
        job: {
          id: "pack",
          status: "completed",
          message: "Installed",
          completed: 1,
          total: 1,
          recoveryEntries: [{ id: "old", path: "world" }],
        },
      },
    });
  });
  await page.goto("/#launchpad");
  await page.getByRole("button", { name: "Install Pack", exact: true }).click();
  await page
    .getByRole("button", { name: "Review installation", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Review installation" });
  await expect(dialog).toContainText("will move to Recycle Bin");
  await dialog
    .getByRole("checkbox", { name: /I understand this replaces/ })
    .check();
  await dialog.getByRole("checkbox", { name: "Create a backup first" }).check();
  await dialog.getByRole("button", { name: "Confirm installation" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Backup destination unavailable",
  );
  expect(calls).toEqual(["backup"]);
  fail = false;
  await dialog.getByRole("button", { name: "Confirm installation" }).click();
  await expect(dialog).not.toBeVisible();
  expect(calls).toEqual(["backup", "backup", "install"]);
  await page
    .getByRole("link", { name: "View replaced files in Recycle Bin" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Recycle Bin", exact: true }),
  ).toBeVisible();
});
