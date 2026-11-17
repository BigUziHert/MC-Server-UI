import { test as base, expect, type Page } from "@playwright/test";
import {
  createProcessServer,
  removeTestServer,
  stopTestServer,
} from "./server-fixtures";

const test = base.extend<{ serverId: string }>({
  serverId: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29800;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const response = await createProcessServer(request, {
      data: { name: "AutoModpack fixture", mode: "live", port },
    });
    const { server } = await response.json();
    try {
      await stopTestServer(request, server.id);
      await use(server.id);
    } finally {
      await removeTestServer(request, server.id);
    }
  },
});

test.beforeEach(async ({ page, serverId }) => {
  await page.addInitScript((id) => {
    localStorage.setItem("mc-panel.active-server", id);
    const key = `mc-panel.launchpad.view.${id}`;
    if (!sessionStorage.getItem(key))
      sessionStorage.setItem(key, JSON.stringify({ type: "mod" }));
  }, serverId);
});

const kinds = [
  { type: "mod", label: "Mods", folder: "mods", extension: "jar" },
  {
    type: "resourcepack",
    label: "Resource Packs",
    folder: "resourcepacks",
    extension: "zip",
  },
  {
    type: "shader",
    label: "Shader Packs",
    folder: "shaderpacks",
    extension: "zip",
  },
] as const;
const project = {
  id: "shared",
  platform: "modrinth",
  title: "Shared project",
  description: "Client content staged for the pack",
  author: "Example author",
};
const version = {
  id: "new",
  name: "New release",
  version: "2.0",
  gameVersions: ["1.21.1"],
  loaders: ["neoforge"],
  publishedAt: "2026-11-01",
  downloadable: true,
};
const update = { ...version, id: "update", version: "3.0" };
type Item = {
  path: string;
  name: string;
  title: string;
  size: number;
  sha512: string;
  platform: string;
  projectId: string;
  versionId: string;
  versionName: string;
  active: boolean;
  update: typeof version | null;
  updateCheck: string;
  updateIssue?: string;
};
const item = (path: string, release = "1.0"): Item => ({
  path,
  name: path.split("/").at(-1)!,
  title: project.title,
  size: 100,
  sha512: path,
  platform: project.platform,
  projectId: project.id,
  versionId: release,
  versionName: release,
  active: true,
  update: release === "2.0" ? update : null,
  updateCheck: "checked",
});

async function catalog(page: Page, supportsAutoModpack = true) {
  const inventories = new Map<string, Item[]>([
    ["server:mod", [item("mods/shared.jar")]],
  ]);
  const reads: URL[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let reviewedType = "mod";
  let reviewNumber = 0;
  const folder = (type: string) => {
    const kind = kinds.find((entry) => entry.type === type)!;
    return `automodpack/host-modpack/main/${kind.folder}/shared.${kind.extension}`;
  };
  await page.route(/\/api\/launchpad(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        ...(supportsAutoModpack ? { targets: ["server", "automodpack"] } : {}),
        platforms: [
          {
            id: "modrinth",
            name: "Modrinth",
            available: true,
            types: [
              "modpack",
              "mod",
              "datapack",
              "plugin",
              "resourcepack",
              "shader",
            ],
            sortOptions: [
              { id: "downloads", label: "Total Downloads" },
              { id: "updated", label: "Latest Update" },
            ],
          },
        ],
        status: "offline",
        gameVersion: "1.21.1",
        loader: "neoforge",
        gameVersions: ["1.21.1"],
        loaders: ["fabric", "forge", "neoforge", "quilt"],
        warnings: [],
      },
    }),
  );
  await page.route("**/api/launchpad/search?**", (route) => {
    const url = new URL(route.request().url());
    reads.push(url);
    return route.fulfill({
      json: { projects: [project], total: 1, offset: 0, limit: 10 },
    });
  });
  await page.route("**/api/launchpad/installed?**", (route) => {
    const url = new URL(route.request().url());
    reads.push(url);
    const key = `${url.searchParams.get("target") ?? "server"}:${url.searchParams.get("type")}`;
    return route.fulfill({
      json: { items: inventories.get(key) ?? [], warnings: [] },
    });
  });
  await page.route("**/api/launchpad/versions?**", (route) => {
    const url = new URL(route.request().url());
    reads.push(url);
    return route.fulfill({ json: { versions: [update, version] } });
  });
  await page.route(/\/api\/launchpad\/(?:updates\/)?preview$/, (route) => {
    const body = route.request().postDataJSON();
    writes.push({ path: new URL(route.request().url()).pathname, body });
    reviewedType = body.type;
    return route.fulfill({
      json: {
        planId: `review-${++reviewNumber}`,
        title: project.title,
        versionName: "2.0",
        expiresAt: "2099-01-01",
        files: [
          {
            path: folder(body.type),
            size: 100,
            action: body.replacePath || body.updates ? "replace" : "install",
          },
        ],
        warnings: [],
      },
    });
  });
  await page.route("**/api/launchpad/preview/*/cancel", (route) =>
    route.fulfill({ json: { cancelled: true } }),
  );
  await page.route("**/api/launchpad/install", (route) => {
    const body = route.request().postDataJSON();
    writes.push({ path: "/api/launchpad/install", body });
    inventories.set(`automodpack:${reviewedType}`, [
      item(folder(reviewedType), "2.0"),
    ]);
    return route.fulfill({
      json: {
        job: {
          id: "installed",
          planId: body.planId,
          status: "completed",
          message: "Content staged.",
          completed: 1,
          total: 1,
        },
      },
    });
  });
  await page.route("**/api/launchpad/jobs/*/dismiss", (route) =>
    route.fulfill({ json: { dismissed: true } }),
  );
  await page.route("**/api/launchpad/active", (route) => {
    const body = route.request().postDataJSON();
    writes.push({ path: "/api/launchpad/active", body });
    const previous = inventories.get(`automodpack:${body.type}`)![0];
    const next = {
      ...previous,
      path: `${folder(body.type)}${body.active ? "" : ".disabled"}`,
      active: body.active,
    };
    inventories.set(`automodpack:${body.type}`, [next]);
    return route.fulfill({ json: { path: next.path, active: next.active } });
  });
  await page.route("**/api/launchpad/removal-preview", (route) => {
    const body = route.request().postDataJSON();
    writes.push({ path: "/api/launchpad/removal-preview", body });
    return route.fulfill({
      json: {
        planId: "remove",
        files: [{ path: body.path, size: 100 }],
        dependents: [],
        warnings: [],
        blocked: false,
      },
    });
  });
  await page.route("**/api/launchpad/removal-preview/*/cancel", (route) =>
    route.fulfill({ json: { cancelled: true } }),
  );
  await page.route("**/api/launchpad/remove", (route) => {
    const body = route.request().postDataJSON();
    writes.push({ path: "/api/launchpad/remove", body });
    inventories.set(`automodpack:${body.type}`, []);
    return route.fulfill({ json: { removed: true } });
  });
  return { reads, writes, inventories, folder };
}

test("AutoModpack shows unlisted releases as neutral results and keeps real failures and regular Mods separate", async ({
  page,
}) => {
  const state = await catalog(page);
  const note =
    "Modrinth does not list a release for Minecraft 1.21.1 and NeoForge. The installed file is recognized, but its compatibility is not confirmed by this listing.";
  const releases = [
    {
      title: "Eating Animations",
      projectId: "X8CISwXp",
      filename: "eatinganimation-1.21.0-6.0.1.jar",
      version: "6.0.1",
    },
    {
      title: "GroovyModLoader (GML)",
      projectId: "zg2tT2Vu",
      filename: "gml-6.0.2.jar",
      version: "6.0.2",
    },
  ];
  const staged = releases.map((release) => ({
    ...item(
      `automodpack/host-modpack/main/mods/${release.filename}`,
      release.version,
    ),
    title: release.title,
    projectId: release.projectId,
    updateCheck: "unlisted",
    updateIssue: note,
  }));
  state.inventories.set("automodpack:mod", staged);
  state.inventories.set(
    "server:mod",
    releases.map((release, index) => ({
      ...item(`mods/${release.filename}`, "1.0"),
      title: release.title,
      projectId: release.projectId,
      update: index === 0 ? update : null,
    })),
  );
  await page.goto("/#launchpad");
  await page.getByRole("tab", { name: "AutoModpack", exact: true }).click();
  await page.getByRole("switch", { name: "Show installed content" }).check();
  for (const release of releases) {
    const row = page.getByRole("article", { name: release.title, exact: true });
    await expect(
      row.locator(".launchpad-badge", { hasText: "No release listed" }),
    ).toBeVisible();
    await expect(row.getByText(note, { exact: true })).toBeVisible();
    await expect(row.getByText("Up to date", { exact: true })).toHaveCount(0);
    await expect(
      row.getByText("Update available", { exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: `Update ${release.title}`, exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByRole("button", {
        name: `Choose version for ${release.title}`,
        exact: true,
      }),
    ).toBeEnabled();
  }
  await expect(page.locator(".launchpad-update-warning")).toHaveCount(0);
  state.inventories.set("automodpack:mod", [
    ...staged,
    {
      ...item("automodpack/host-modpack/main/mods/failed.jar"),
      title: "Provider Failure",
      projectId: "failure",
      updateCheck: "unavailable",
      updateIssue: "Provider is temporarily unavailable (503).",
    },
  ]);
  const refresh = page.getByRole("button", {
    name: "Refresh Launchpad and check updates",
    exact: true,
  });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  const warning = page.locator(".launchpad-update-warning");
  await expect(warning).toContainText(
    "Could not check updates for 1 installed item.",
  );
  await warning.getByText("View affected files", { exact: true }).click();
  await expect(warning).toContainText("Provider Failure");
  await expect(warning).not.toContainText("Eating Animations");
  await expect(warning).not.toContainText("GroovyModLoader");
  await page.getByRole("tab", { name: "Mods", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Update Eating Animations", exact: true }),
  ).toBeEnabled();
  await expect(
    page
      .getByRole("article", { name: "GroovyModLoader (GML)", exact: true })
      .getByText("Up to date", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No release listed", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".launchpad-update-warning")).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

for (const kind of kinds) {
  test(`AutoModpack ${kind.label} reuses reviews and scopes every operation independently`, async ({
    page,
  }, testInfo) => {
    const state = await catalog(page);
    await page.goto("/#launchpad");
    const row = page.getByRole("article", { name: project.title, exact: true });
    await expect(row).toContainText("Installed: 1.0");
    const tabs = page.getByRole("tablist", { name: "Content type" });
    await expect(tabs.getByRole("tab")).toHaveText([
      "Modpacks",
      "Mods",
      "Datapacks",
      "Plugins",
      "AutoModpack",
    ]);
    await tabs.getByRole("tab", { name: "AutoModpack", exact: true }).click();
    const selector = page.getByRole("group", {
      name: "AutoModpack content",
      exact: true,
    });
    await expect(
      selector.getByRole("button", { name: "Mods", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await selector
      .getByRole("button", { name: kind.label, exact: true })
      .click();
    await expect(
      row.getByRole("button", {
        name: `Install ${project.title}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(row).not.toContainText("Installed: 1.0");
    await expect(
      page.getByRole("combobox", {
        name: "Launchpad rows per page",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Filters", exact: true }),
    ).toBeVisible();
    if (kind.type === "resourcepack")
      await expect(
        page.getByRole("combobox", { name: "Loader", exact: true }),
      ).toBeDisabled();
    if (kind.type === "shader") {
      await expect(
        page
          .getByRole("combobox", { name: "Loader", exact: true })
          .locator("option"),
      ).toHaveText(["All loaders", "Iris", "OptiFine", "Canvas", "Vanilla"]);
    }
    await row
      .getByRole("button", { name: `Install ${project.title}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Review installation", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      state.folder(kind.type),
    );
    await page
      .getByRole("button", { name: "Confirm installation", exact: true })
      .click();
    await expect(row).toContainText("Installed: 2.0");
    await page.screenshot({
      path: testInfo.outputPath("automodpack-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: testInfo.outputPath("automodpack-narrow.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(
      row.getByRole("switch", { name: `Active: ${project.title}` }),
    ).toBeChecked();
    await row
      .getByRole("button", { name: `Update ${project.title}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Review installation", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      state.folder(kind.type),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await page
      .getByRole("switch", { name: "Show installed content", exact: true })
      .check();
    await expect(row).toContainText(state.folder(kind.type));
    await page.getByRole("button", { name: "Update all", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(
      state.folder(kind.type),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await row.getByRole("switch", { name: `Active: ${project.title}` }).click();
    await expect(
      row.getByRole("switch", { name: `Active: ${project.title}` }),
    ).not.toBeChecked();
    await expect(row).toContainText("Disabled");
    await row
      .getByRole("button", { name: `Remove ${project.title}`, exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Remove / })
      .click();
    await expect(row).toHaveCount(0);
    await tabs.getByRole("tab", { name: "Mods", exact: true }).click();
    await expect(row).toContainText("Installed: 1.0");
    await expect(
      row.getByRole("switch", { name: `Active: ${project.title}` }),
    ).toBeChecked();
    await tabs.getByRole("tab", { name: "AutoModpack", exact: true }).click();
    await expect(
      selector.getByRole("button", { name: "Mods", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(state.writes.map((request) => request.path)).toEqual(
      expect.arrayContaining([
        "/api/launchpad/preview",
        "/api/launchpad/install",
        "/api/launchpad/updates/preview",
        "/api/launchpad/active",
        "/api/launchpad/removal-preview",
        "/api/launchpad/remove",
      ]),
    );
    for (const request of state.writes)
      expect(request.body).toMatchObject({
        target: "automodpack",
        type: kind.type,
      });
    const scopedReads = state.reads.filter(
      (url) =>
        url.searchParams.get("target") === "automodpack" &&
        url.searchParams.get("type") === kind.type,
    );
    for (const endpoint of ["search", "installed", "versions"])
      expect(
        scopedReads.some((url) => url.pathname.endsWith(`/${endpoint}`)),
      ).toBe(true);
    expect(state.inventories.get("server:mod")?.[0]).toMatchObject({
      path: "mods/shared.jar",
      versionName: "1.0",
      active: true,
    });
  });
}

test("AutoModpack stays available when the selected provider only offers plugins", async ({
  page,
  serverId,
}) => {
  await catalog(page);
  await page.route(/\/api\/launchpad(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        targets: ["server", "automodpack"],
        platforms: [
          { id: "hangar", name: "Hangar", available: true, types: ["plugin"] },
          {
            id: "modrinth",
            name: "Modrinth",
            available: true,
            types: ["mod", "resourcepack", "shader"],
          },
        ],
        status: "offline",
        gameVersion: "1.21.1",
        loader: "paper",
        warnings: [],
      },
    }),
  );
  await page.goto("/#launchpad");
  await page
    .getByRole("combobox", { name: "Platform", exact: true })
    .selectOption("hangar");
  const auto = page.getByRole("tab", { name: "AutoModpack", exact: true });
  await expect(auto).toBeEnabled();
  await auto.click();
  await expect(auto).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("combobox", { name: "Platform", exact: true }),
  ).toHaveValue("modrinth");
  await expect(
    page.getByRole("button", { name: `Install ${project.title}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("group", { name: "AutoModpack content", exact: true })
    .getByRole("button", { name: "Shader Packs", exact: true })
    .click();
  await page.evaluate((id) => {
    sessionStorage.setItem(
      `mc-panel.launchpad.view.${id}`,
      JSON.stringify({
        type: "automodpack",
        platform: "hangar",
        loader: "iris",
      }),
    );
  }, serverId);
  await page.reload();
  await expect(auto).toHaveAttribute("aria-selected", "true");
  await expect(
    page
      .getByRole("group", { name: "AutoModpack content", exact: true })
      .getByRole("button", { name: "Mods", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("combobox", { name: "Platform", exact: true }),
  ).toHaveValue("modrinth");
});

test("older panels never receive AutoModpack requests and regular Mods stays available", async ({
  page,
}) => {
  const state = await catalog(page, false);
  await page.goto("/#launchpad");
  const row = page.getByRole("article", { name: project.title, exact: true });
  await expect(row).toContainText("Installed: 1.0");
  await page.getByRole("tab", { name: "AutoModpack", exact: true }).click();
  for (const kind of kinds) {
    await page
      .getByRole("group", { name: "AutoModpack content", exact: true })
      .getByRole("button", { name: kind.label, exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Update this MC Panel to use AutoModpack",
        exact: true,
      }),
    ).toBeVisible();
    await expect(row).toHaveCount(0);
  }
  await page
    .getByRole("switch", { name: "Show installed content", exact: true })
    .check();
  await expect(row).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    }),
  ).toBeEnabled();
  expect(state.reads.some((url) => url.searchParams.has("target"))).toBe(false);
  expect(state.writes).toEqual([]);
  await page.getByRole("tab", { name: "Mods", exact: true }).click();
  await expect(row).toContainText("Installed: 1.0");
});
