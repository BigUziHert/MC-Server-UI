import { test as base, expect, type Page } from "@playwright/test";
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
