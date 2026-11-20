import { test as base, expect, type Page, type Route } from "@playwright/test";
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
  catalogAliases?: { platform: string; projectId: string; versionId: string }[];
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

async function catalog(
  page: Page,
  supportsAutoModpack = true,
  platform = "modrinth",
  platforms = [platform],
) {
  const inventories = new Map<string, Item[]>([
    ["server:mod", [{ ...item("mods/shared.jar"), platform }]],
  ]);
  const projects = [{ ...project, platform }];
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
        platforms: platforms.map((id) => ({
          id,
          name: id === "curseforge" ? "CurseForge" : "Modrinth",
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
            { id: "newest", label: "Release Date" },
          ],
        })),
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
    const matches = projects.filter(
      (entry) => entry.platform === url.searchParams.get("platform"),
    );
    return route.fulfill({
      json: { projects: matches, total: matches.length, offset: 0, limit: 10 },
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
  return { reads, writes, inventories, folder, projects };
}

test("AutoModpack resource packs use the selected catalog's dates and available date sorts", async ({
  page,
}) => {
  const state = await catalog(page, true, "modrinth", [
    "modrinth",
    "curseforge",
  ]);
  const modrinth = { ...project, releasedAt: "2024-02-20T12:00:00.000Z" };
  const curseforge = {
    ...project,
    platform: "curseforge",
    addedAt: "2024-03-01T12:00:00.000Z",
    releasedAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-11-01T12:00:00.000Z",
  };
  state.projects.splice(0, 1, modrinth, curseforge);
  await page.goto("/#launchpad");
  await page.getByRole("tab", { name: "AutoModpack", exact: true }).click();
  await page
    .getByRole("group", { name: "AutoModpack content" })
    .getByRole("button", { name: "Resource Packs", exact: true })
    .click();
  const row = page.getByRole("article", { name: project.title, exact: true });
  const header = page.getByRole("group", {
    name: "Sort catalog content columns",
  });
  await expect(row.locator(".launchpad-date-added time")).toHaveAttribute(
    "datetime",
    modrinth.releasedAt,
  );
  await expect(
    header.getByRole("button", { name: "Sort by Date added" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Platform", exact: true })
    .selectOption("curseforge");
  await expect(row.locator(".launchpad-date-added time")).toHaveAttribute(
    "datetime",
    curseforge.addedAt,
  );
  await expect(row.locator(".launchpad-date-modified time")).toHaveAttribute(
    "datetime",
    curseforge.updatedAt,
  );
  await expect(header.getByText("Date added", { exact: true })).toBeVisible();
  await expect(
    header.getByRole("button", { name: "Sort by Date added" }),
  ).toHaveCount(0);
  await header.getByRole("button", { name: "Sort by Date modified" }).click();
  await expect
    .poll(() => {
      const query = state.reads.findLast((url) =>
        url.pathname.endsWith("/search"),
      )?.searchParams;
      return query && Object.fromEntries(query);
    })
    .toMatchObject({
      platform: "curseforge",
      type: "resourcepack",
      target: "automodpack",
      sort: "updated",
    });
});

test("switching catalogs keeps resource packs, shaders, datapacks and plugins marked installed", async ({
  page,
}) => {
  const state = await catalog(page, true, "modrinth", [
    "modrinth",
    "curseforge",
  ]);
  const other = {
    ...project,
    id: "491",
    title: "Alternate catalog title",
    platform: "curseforge",
  };
  state.projects.push(other);
  const targets = [
    {
      label: "Resource Packs",
      type: "resourcepack",
      target: "automodpack",
      path: "automodpack/host-modpack/main/resourcepacks/local.zip.disabled",
    },
    {
      label: "Shader Packs",
      type: "shader",
      target: "automodpack",
      path: "automodpack/host-modpack/main/shaderpacks/local.zip.disabled",
    },
    {
      label: "Datapacks",
      type: "datapack",
      target: "server",
      path: "world/datapacks/local.zip",
    },
    {
      label: "Plugins",
      type: "plugin",
      target: "server",
      path: "plugins/local.jar",
    },
  ];
  for (const { type, target, path } of targets)
    state.inventories.set(`${target}:${type}`, [
      {
        ...item(path),
        active: !path.endsWith(".disabled"),
        catalogAliases: [
          { platform: other.platform, projectId: other.id, versionId: "621" },
        ],
      },
    ]);
  await page.goto("/#launchpad");
  const tabs = page.getByRole("tablist", { name: "Content type" });
  for (const { label, target } of targets) {
    if (target === "automodpack") {
      await tabs.getByRole("tab", { name: "AutoModpack", exact: true }).click();
      await page
        .getByRole("group", { name: "AutoModpack content" })
        .getByRole("button", { name: label, exact: true })
        .click();
    } else {
      await tabs.getByRole("tab", { name: label, exact: true }).click();
    }
    for (const listing of [project, other]) {
      await page
        .getByRole("combobox", { name: "Platform", exact: true })
        .selectOption(listing.platform);
      const row = page.getByRole("article", {
        name: listing.title,
        exact: true,
      });
      await expect(row.getByText("Installed", { exact: true })).toBeVisible();
      await expect(
        row.getByRole("button", {
          name: `Choose version for ${listing.title}`,
          exact: true,
        }),
      ).toBeVisible();
      await expect(row.getByRole("button", { name: /^Install / })).toHaveCount(
        0,
      );
      if (target === "automodpack")
        await expect(row.getByText("Disabled", { exact: true })).toBeVisible();
    }
  }
  expect(state.writes).toEqual([]);
});

test("Mods catalog recognizes AutoModpack projects across providers and opens the matching installed file", async ({
  page,
}) => {
  const state = await catalog(page, true, "curseforge");
  const [listing] = state.projects;
  const matching = {
    ...item("automodpack/host-modpack/main/mods/renamed.jar.disabled"),
    title: "Client bindings",
    platform: "modrinth",
    projectId: "84",
    active: false,
    catalogAliases: [
      { platform: listing.platform, projectId: "491", versionId: "621" },
    ],
  };
  const native = {
    ...item("automodpack/host-modpack/main/mods/mouse.jar"),
    title: "Mouse Tweaks",
    platform: listing.platform,
    projectId: "500",
  };
  state.inventories.set("automodpack:mod", [
    matching,
    native,
    { ...item(state.folder("mod"), "2.0"), platform: listing.platform },
    // The requested file would be on the second installed page without navigation.
    ...Array.from({ length: 11 }, (_, n) => ({
      ...item(`automodpack/host-modpack/main/mods/addon-${n}.jar`),
      title: `Addon ${n}`,
      projectId: `addon-${n}`,
    })),
  ]);
  state.projects.push(
    { ...listing, id: "491", title: "Controlling" },
    { ...listing, id: native.projectId, title: native.title },
    { ...listing, id: matching.projectId, title: matching.title },
  );
  // A freshly dropped pack JAR has no cached project identity on the quick scan.
  await page.route("**/api/launchpad/installed?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("target") === "automodpack" && params.has("local"))
      return route.fulfill({
        json: {
          items: [
            {
              ...matching,
              platform: null,
              projectId: null,
              catalogAliases: [],
            },
          ],
          warnings: [],
        },
      });
    return route.fallback();
  });
  await page.goto("/#launchpad");
  const row = (name: string) =>
    page.getByRole("article", { name, exact: true });
  const badge = (name: string) =>
    row(name).getByText("Installed in AutoModpack", { exact: true });
  const manage = (name: string) =>
    row(name).getByRole("button", {
      name: "Manage in AutoModpack",
      exact: true,
    });
  for (const title of ["Controlling", native.title]) {
    await expect(badge(title)).toBeVisible();
    await expect(manage(title)).toBeEnabled();
    await expect(
      row(title).getByRole("button", { name: /^Install / }),
    ).toHaveCount(0);
    await expect(row(title).getByRole("switch")).toHaveCount(0);
    await expect(
      row(title).getByRole("button", { name: /^Remove / }),
    ).toHaveCount(0);
  }
  // A project present in both locations keeps the controls for its server file.
  await expect(badge(project.title)).toBeVisible();
  await expect(manage(project.title)).toBeEnabled();
  await expect(row(project.title)).toContainText("Installed: 1.0");
  await expect(row(project.title).getByRole("switch")).toBeChecked();
  await expect(
    row(project.title).getByRole("button", { name: /^Remove / }),
  ).toBeEnabled();
  // Same title and numeric ID as the Modrinth file on a different platform.
  await expect(badge(matching.title)).toHaveCount(0);
  await expect(
    row(matching.title).getByRole("button", {
      name: `Install ${matching.title}`,
    }),
  ).toBeEnabled();

  const installedOnly = page.getByRole("switch", {
    name: "Show installed content",
    exact: true,
  });
  await installedOnly.check();
  await expect(row(project.title)).toContainText("mods/shared.jar");
  await expect(row(native.title)).toHaveCount(0);
  await expect(row(matching.title)).toHaveCount(0);
  await installedOnly.uncheck();
  await page
    .getByRole("textbox", { name: "Search Launchpad", exact: true })
    .fill("Controlling");
  await manage("Controlling").click();
  await expect(
    page.getByRole("tab", { name: "AutoModpack", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page
      .getByRole("group", { name: "AutoModpack content" })
      .getByRole("button", { name: "Mods", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(installedOnly).toBeChecked();
  await expect(row(matching.title)).toContainText(matching.path);
  await expect(row(matching.title).getByRole("switch")).not.toBeChecked();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(row("Addon 0")).toBeVisible();
  expect(state.writes).toEqual([]);
});

test("browsing AutoModpack Mods lets a catalog reader manage the matching file in regular Mods", async ({
  page,
  serverId,
}) => {
  const permissions = ["server.view", "file.read"];
  await page.addInitScript(() =>
    localStorage.setItem("mc-panel.session.v1", "p".repeat(43)),
  );
  await page.route("**/api/access/session", (route) =>
    route.fulfill({
      json: {
        role: "subuser",
        userId: "reader",
        email: "reader@example.test",
        serverId,
        permissions,
      },
    }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      json: {
        servers: [
          {
            id: serverId,
            name: "Shared",
            status: "offline",
            accessPermissions: permissions,
          },
        ],
        defaultServerId: serverId,
      },
    }),
  );
  const state = await catalog(page, true, "curseforge");
  const [listing] = state.projects;
  const linked = {
    ...item("mods/renamed.jar.disabled"),
    title: "Client bindings",
    platform: "modrinth",
    projectId: "84",
    active: false,
    catalogAliases: [
      { platform: listing.platform, projectId: "491", versionId: "621" },
    ],
  };
  state.inventories.get("server:mod")!.push(linked);
  state.inventories.set("automodpack:mod", [
    { ...item(state.folder("mod"), "2.0"), platform: listing.platform },
  ]);
  state.projects.push(
    { ...listing, id: "491", title: "Controlling" },
    { ...listing, id: linked.projectId, title: linked.title },
  );
  await page.goto("/#launchpad");
  const regularMods = page.getByRole("tab", { name: "Mods", exact: true });
  await page.getByRole("tab", { name: "AutoModpack", exact: true }).click();
  const row = (name: string) =>
    page.getByRole("article", { name, exact: true });
  const manage = (name: string) =>
    row(name).getByRole("button", { name: "Manage in Mods", exact: true });
  await expect(
    row("Controlling").getByText("Installed in Mods", { exact: true }),
  ).toBeVisible();
  await expect(manage("Controlling")).toBeEnabled();
  await expect(
    row("Controlling").getByRole("button", { name: /^Install / }),
  ).toHaveCount(0);
  await expect(row("Controlling").getByRole("switch")).toHaveCount(0);
  await expect(
    row("Controlling").getByRole("button", { name: /^Remove / }),
  ).toHaveCount(0);
  // Its staged copy keeps its own version and permissions.
  await expect(manage(project.title)).toBeEnabled();
  await expect(row(project.title)).toContainText("Installed: 2.0");
  await expect(row(project.title).getByRole("switch")).toBeDisabled();
  // Same title and numeric ID as the server file, on a different catalog.
  await expect(manage(linked.title)).toHaveCount(0);
  await expect(
    row(linked.title).getByRole("button", { name: `Install ${linked.title}` }),
  ).toBeDisabled();

  const installedOnly = page.getByRole("switch", {
    name: "Show installed content",
    exact: true,
  });
  await installedOnly.check();
  await expect(row(project.title)).toContainText(state.folder("mod"));
  await expect(row(linked.title)).toHaveCount(0);
  await installedOnly.uncheck();
  await manage("Controlling").click();
  await expect(regularMods).toHaveAttribute("aria-selected", "true");
  await expect(installedOnly).toBeChecked();
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(row(linked.title)).toContainText(linked.path);
  await expect(row(linked.title).getByRole("switch")).not.toBeChecked();
  await expect(row(linked.title).getByRole("switch")).toBeDisabled();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(row(project.title)).toContainText("mods/shared.jar");
  expect(state.writes).toEqual([]);
});

test("refreshing the Mods catalog clears the AutoModpack badge after the staged file is removed", async ({
  page,
}) => {
  const state = await catalog(page);
  state.inventories.set("server:mod", []);
  state.inventories.set("automodpack:mod", [item(state.folder("mod"))]);
  await page.goto("/#launchpad");
  const row = page.getByRole("article", { name: project.title, exact: true });
  const badge = row.getByText("Installed in AutoModpack", { exact: true });
  await expect(badge).toBeVisible();
  state.inventories.set("automodpack:mod", []);
  await page
    .getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    })
    .click();
  await expect(
    row.getByRole("button", { name: `Install ${project.title}` }),
  ).toBeEnabled();
  await expect(badge).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

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
  let held: Route | undefined;
  await page.route("**/api/launchpad/installed?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (
      params.get("target") === "automodpack" &&
      params.has("refresh") &&
      !params.has("local")
    ) {
      held = route;
      return;
    }
    return route.fallback();
  });
  await refresh.click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(refresh).toBeDisabled();
  await expect(refresh.locator("svg.spin")).toBeVisible();
  await held!.fallback();
  const warning = page.locator(".launchpad-update-warning");
  await expect(warning).toContainText(
    "Could not check updates for 1 installed item.",
  );
  await expect(refresh).toBeEnabled();
  await expect(
    page.getByText("Launchpad refreshed.", { exact: true }),
  ).toHaveCount(0);
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
      .getByRole("button", {
        name: "Choose version for GroovyModLoader (GML)",
      }),
  ).toBeEnabled();
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
    // Leave the project being installed absent from regular Mods.
    const serverProject = { ...project, id: "server-mod", title: "Server mod" };
    state.projects.push(serverProject);
    state.inventories.set("server:mod", [
      {
        ...item("mods/server.jar"),
        projectId: serverProject.id,
        title: serverProject.title,
      },
    ]);
    await page.goto("/#launchpad");
    const row = page.getByRole("article", { name: project.title, exact: true });
    const serverRow = page.getByRole("article", {
      name: serverProject.title,
      exact: true,
    });
    await expect(serverRow).toContainText("Installed: 1.0");
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
    await expect(serverRow).toContainText("Installed: 1.0");
    await expect(
      serverRow.getByRole("switch", { name: `Active: ${serverProject.title}` }),
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
      path: "mods/server.jar",
      versionName: "1.0",
      active: true,
    });
  });
}

test("AutoModpack follows the selected platform when browsing and stays accessible in Installed only", async ({
  page,
  serverId,
}) => {
  await catalog(page);
  const specialists = [
    { id: "ftb", name: "Feed The Beast", type: "modpack", tab: "Modpacks" },
    { id: "atlauncher", name: "ATLauncher", type: "modpack", tab: "Modpacks" },
    { id: "voidswrath", name: "Voids Wrath", type: "modpack", tab: "Modpacks" },
    { id: "spigot", name: "Spigot", type: "plugin", tab: "Plugins" },
  ];
  await page.route(/\/api\/launchpad(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        targets: ["server", "automodpack"],
        platforms: [
          ...specialists.map(({ id, name, type }) => ({
            id,
            name,
            available: true,
            types: [type],
          })),
          {
            id: "modrinth",
            name: "Modrinth",
            available: true,
            types: ["mod", "resourcepack", "shader"],
          },
          {
            id: "curseforge",
            name: "CurseForge",
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
  const platform = page.getByRole("combobox", {
    name: "Platform",
    exact: true,
  });
  const auto = page.getByRole("tab", { name: "AutoModpack", exact: true });
  for (const provider of specialists) {
    await platform.selectOption(provider.id);
    const tab = page.getByRole("tab", { name: provider.tab, exact: true });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(auto).toBeDisabled();
    await tab.press("End");
    await expect(tab).toBeFocused();
    await expect(platform).toHaveValue(provider.id);
  }
  const installed = page.getByRole("switch", {
    name: "Show installed content",
    exact: true,
  });
  await installed.check();
  await expect(platform).toHaveValue("all");
  await expect(auto).toBeEnabled();
  await auto.click();
  await expect(auto).toHaveAttribute("aria-selected", "true");
  await installed.uncheck();
  await expect(platform).toHaveValue("spigot");
  await expect(
    page.getByRole("tab", { name: "Plugins", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(auto).toBeDisabled();
  await platform.selectOption("modrinth");
  await expect(auto).toBeEnabled();
  await auto.click();
  await expect(auto).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("combobox", { name: "Platform", exact: true }),
  ).toHaveValue("modrinth");
  await expect(
    page.getByRole("button", { name: "Manage in Mods", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("group", { name: "AutoModpack content", exact: true })
    .getByRole("button", { name: "Shader Packs", exact: true })
    .click();
  await platform.selectOption("curseforge");
  await expect(auto).toHaveAttribute("aria-selected", "true");
  await expect(platform.locator("option")).toHaveCount(6);
  await platform.selectOption("ftb");
  await expect(auto).toBeDisabled();
  await expect(
    page.getByRole("tab", { name: "Modpacks", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.evaluate((id) => {
    sessionStorage.setItem(
      `mc-panel.launchpad.view.${id}`,
      JSON.stringify({
        type: "automodpack",
        platform: "spigot",
        loader: "iris",
      }),
    );
  }, serverId);
  await page.reload();
  await expect(platform).toHaveValue("spigot");
  await expect(auto).toBeDisabled();
  await expect(
    page.getByRole("tab", { name: "Plugins", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
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
