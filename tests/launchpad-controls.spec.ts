import { test as base, expect, type Page } from "@playwright/test";
import {
  createProcessServer,
  removeTestServer,
  stopTestServer,
} from "./server-fixtures";

const test = base.extend<{ serverId: string }>({
  serverId: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29700;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const response = await createProcessServer(request, {
      data: { name: "Launchpad controls fixture", mode: "live", port },
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
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    serverId,
  );
});

const sorts = [
  { id: "featured", label: "Featured" },
  { id: "popular", label: "Popularity" },
  { id: "updated", label: "Latest Update" },
  { id: "newest", label: "Release Date" },
  { id: "downloads", label: "Total Downloads" },
  { id: "category", label: "Main Category" },
  { id: "gameVersion", label: "Game Version" },
  { id: "name", label: "Name" },
  { id: "author", label: "Author" },
];
const modrinthSorts = [
  { id: "downloads", label: "Total Downloads" },
  { id: "relevance", label: "Relevancy" },
  { id: "popular", label: "Popularity" },
  { id: "updated", label: "Latest Update" },
  { id: "newest", label: "Release Date" },
];
const version = {
  id: "new",
  name: "New release",
  version: "2.0",
  gameVersions: ["1.21.1"],
  loaders: ["neoforge"],
  publishedAt: "2026-10-30T12:00:00.000Z",
  downloadable: true,
};
const installed = (title: string, active = true, update = false) => ({
  path: `mods/${title}.jar${active ? "" : ".disabled"}`,
  name: `${title}.jar${active ? "" : ".disabled"}`,
  sha512: title,
  size: 100,
  title,
  platform: "curseforge",
  projectId: title,
  versionId: "old",
  versionName: "1.0",
  active,
  addedAt: "2026-10-20T12:00:00.000Z",
  modifiedAt: "2026-10-31T17:25:00.000Z",
  update: update ? version : null,
  updateCheck: "checked",
});

async function catalog(
  page: Page,
  job?: Record<string, unknown>,
  type = "mod",
  platform = "curseforge",
) {
  await page.route(/\/api\/launchpad(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        platforms: [
          {
            id: platform,
            name: platform === "modrinth" ? "Modrinth" : "CurseForge",
            available: true,
            types: [type],
            sortOptions: platform === "modrinth" ? modrinthSorts : sorts,
          },
        ],
        status: "offline",
        gameVersion: "1.21.1",
        loader: "neoforge",
        gameVersions: ["1.21.1"],
        warnings: [],
        job,
      },
    }),
  );
  await page.route("**/api/launchpad/search?**", (route) =>
    route.fulfill({
      json: {
        projects: [],
        total: 0,
        offset: 0,
        limit: 10,
      },
    }),
  );
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
}

test("completed installation notices expire after ten seconds and stay dismissed on refresh", async ({
  page,
}) => {
  await page.clock.install();
  await catalog(page, {
    id: "finished",
    status: "completed",
    message: "Example installed successfully.",
    completed: 1,
    total: 1,
  });
  await page.route("**/api/launchpad/jobs/finished/dismiss", (route) =>
    route.fulfill({ json: { dismissed: true } }),
  );
  await page.goto("/#launchpad");
  const banner = page.getByRole("status", { name: "Installation status" });
  await expect(banner).toContainText("Installation completed");
  await page.clock.fastForward(9_000);
  await expect(banner).toBeVisible();
  await page.clock.fastForward(1_100);
  await expect(banner).toHaveCount(0);
  await page
    .getByRole("button", { name: "Refresh Launchpad and check updates" })
    .click();
  await expect(banner).toHaveCount(0);
});

test("leaving Launchpad dismisses a finished banner before its timeout", async ({
  page,
}) => {
  await catalog(page, {
    id: "finished-before-navigation",
    status: "completed",
    message: "Example installed successfully.",
    completed: 1,
    total: 1,
  });
  await page.route(
    "**/api/launchpad/jobs/finished-before-navigation/dismiss",
    (route) => route.fulfill({ json: { dismissed: true } }),
  );
  await page.goto("/#launchpad");
  const banner = page.getByRole("status", { name: "Installation status" });
  await expect(banner).toBeVisible();
  await page.getByRole("link", { name: "Console", exact: true }).click();
  await expect(page).toHaveURL(/#console$/);
  await page.getByRole("link", { name: "Launchpad", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Launchpad", exact: true }),
  ).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test("running installations keep their status after ten seconds", async ({
  page,
}) => {
  await page.clock.install();
  const job = {
    id: "still-running",
    status: "running",
    message: "Downloading example.jar",
    completed: 0,
    total: 1,
  };
  await catalog(page, job);
  await page.route("**/api/launchpad/jobs/still-running", (route) =>
    route.fulfill({ json: { job } }),
  );
  await page.goto("/#launchpad");
  const banner = page.getByRole("status", { name: "Installation status" });
  await expect(banner).toContainText("Installing server content");
  await page.clock.fastForward(11_000);
  await expect(banner).toContainText("Downloading example.jar");
});

for (const recoveryRequired of [false, true]) {
  test(`${recoveryRequired ? "recovery-required" : "failed"} installation notices remain until addressed`, async ({
    page,
  }) => {
    await page.clock.install();
    await catalog(page, {
      id: "needs-attention",
      status: recoveryRequired ? "completed" : "failed",
      message: "This installation needs attention.",
      completed: 1,
      total: 1,
      recoveryRequired,
    });
    let dismissals = 0;
    await page.route(
      "**/api/launchpad/jobs/needs-attention/dismiss",
      (route) => {
        dismissals++;
        return route.fulfill({ json: { dismissed: true } });
      },
    );
    await page.goto("/#launchpad");
    const banner = page.getByRole("status", { name: "Installation status" });
    await expect(banner).toContainText("This installation needs attention.");
    await page.clock.fastForward(11_000);
    await expect(banner).toBeVisible();
    await page.getByRole("link", { name: "Console", exact: true }).click();
    await page.getByRole("link", { name: "Launchpad", exact: true }).click();
    await expect(banner).toBeVisible();
    expect(dismissals).toBe(0);
  });
}

test("installed mod controls display file modification time and toggle activity in both directions", async ({
  page,
}, testInfo) => {
  await catalog(page);
  let item = installed("Example");
  const requests: unknown[] = [];
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [item], warnings: [] } }),
  );
  await page.route("**/api/launchpad/active", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    expect(body.path).toBe(item.path);
    item = installed("Example", body.active);
    await route.fulfill({
      json: {
        ok: true,
        path: item.path,
        active: item.active,
        modifiedAt: item.modifiedAt,
      },
    });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  const row = page.getByRole("article", { name: "Example", exact: true });
  const active = row.getByRole("switch");
  await expect(active).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Sort by Date modified", exact: true }),
  ).toBeVisible();
  await expect(row.locator(`time[datetime="${item.addedAt}"]`)).toBeVisible();
  await expect(
    row.locator(`time[datetime="${item.modifiedAt}"]`),
  ).toHaveAttribute("datetime", item.modifiedAt);
  await active.click();
  await expect(active).not.toBeChecked();
  await expect(row).toContainText("mods/Example.jar.disabled");
  await active.click();
  await expect(active).toBeChecked();
  await expect(row).toContainText("mods/Example.jar");
  await expect(row.locator(`time[datetime="${item.addedAt}"]`)).toBeVisible();
  await expect(
    row.locator(`time[datetime="${item.modifiedAt}"]`),
  ).toBeVisible();
  expect(requests).toEqual([
    { path: "mods/Example.jar", active: false },
    { path: "mods/Example.jar.disabled", active: true },
  ]);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({
    path: testInfo.outputPath("installed-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    )
    .toBeLessThanOrEqual(0);
  await page.screenshot({
    path: testInfo.outputPath("installed-mobile.png"),
    fullPage: true,
  });
});

test("installed modpacks display both shared date columns", async ({
  page,
}) => {
  await catalog(page, undefined, "modpack");
  const pack = {
    ...installed("Example Pack"),
    path: ".launchpad/modpack",
    name: "Example Pack",
  };
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [pack], warnings: [] } }),
  );
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  const row = page.getByRole("article", { name: "Example Pack", exact: true });
  await expect(
    page.getByRole("button", { name: "Sort by Date added", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sort by Date modified", exact: true }),
  ).toBeVisible();
  await expect(row.locator(`time[datetime="${pack.addedAt}"]`)).toBeVisible();
  await expect(
    row.locator(`time[datetime="${pack.modifiedAt}"]`),
  ).toBeVisible();
  await expect(row.getByRole("switch")).toHaveCount(0);
});

test("installed column headers reverse sorting while updates stay first across pages", async ({
  page,
  serverId,
}, testInfo) => {
  await catalog(page);
  await page.addInitScript((id) => {
    sessionStorage.setItem(
      `mc-panel.launchpad.view.${id}`,
      JSON.stringify({
        type: "mod",
        installedOnly: true,
        installedSort: "updates",
      }),
    );
  }, serverId);
  const item = (
    title: string,
    active: boolean,
    update: boolean,
    author: string,
    day: number,
  ) => ({
    ...installed(title, active, update),
    author,
    addedAt: `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`,
  });
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({
      json: {
        items: [
          item("Cedar", false, true, "Delta", 3),
          item("Bravo", true, false, "Charlie", 4),
          item("Alpha", true, true, "Zeta", 1),
          item("Echo", false, false, "Alpha", 5),
          item("Zulu", true, true, "Beta", 2),
          item("Delta", true, false, "Echo", 6),
          item("Foxtrot", false, false, "Foxtrot", 7),
        ],
        warnings: [],
      },
    }),
  );
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  const sort = page.getByLabel("Sort installed content", { exact: true });
  await expect(sort.locator('option[value="updates"]')).toHaveCount(0);
  await expect(
    sort.locator(
      'option[value="active"], option[value="added"], option[value="modified"], option[value="size"]',
    ),
  ).toHaveCount(0);
  await expect(sort).toHaveValue("name");
  const headers = page.getByRole("group", {
    name: "Sort installed content columns",
  });
  const name = headers.getByRole("button", {
    name: "Sort by Name",
    exact: true,
  });
  const author = headers.getByRole("button", {
    name: "Sort by Author",
    exact: true,
  });
  const active = headers.getByRole("button", {
    name: "Sort by Active",
    exact: true,
  });
  const added = headers.getByRole("button", {
    name: "Sort by Date added",
    exact: true,
  });
  await expect(name).toHaveAttribute("aria-pressed", "true");
  await expect(name).toHaveAttribute(
    "aria-description",
    "Ascending. Updates always appear first.",
  );
  await expect(
    page.getByRole("article").getByText("Active", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Launchpad rows per page", { exact: true })
    .selectOption("5");
  const names = page.getByRole("article").getByRole("heading", { level: 3 });
  const pagination = page.getByRole("status", { name: "Launchpad page" });
  const next = page.getByRole("button", {
    name: "Next Launchpad page",
    exact: true,
  });
  async function checkOrder(expected: string[]) {
    await expect(pagination).toHaveText("Page 1 of 2");
    await expect(names).toHaveText(expected.slice(0, 5));
    await expect(
      page.getByRole("article").getByRole("button", { name: /^Update / }),
    ).toHaveCount(3);
    await next.click();
    await expect(pagination).toHaveText("Page 2 of 2");
    await expect(names).toHaveText(expected.slice(5));
    await expect(
      page.getByRole("article").getByRole("button", { name: /^Update / }),
    ).toHaveCount(0);
  }
  await checkOrder([
    "Alpha",
    "Cedar",
    "Zulu",
    "Bravo",
    "Delta",
    "Echo",
    "Foxtrot",
  ]);
  await name.click();
  await expect(name).toHaveAttribute(
    "aria-description",
    "Descending. Updates always appear first.",
  );
  await checkOrder([
    "Zulu",
    "Cedar",
    "Alpha",
    "Foxtrot",
    "Echo",
    "Delta",
    "Bravo",
  ]);
  await name.click();
  await expect(name).toHaveAttribute(
    "aria-description",
    "Ascending. Updates always appear first.",
  );
  await checkOrder([
    "Alpha",
    "Cedar",
    "Zulu",
    "Bravo",
    "Delta",
    "Echo",
    "Foxtrot",
  ]);
  await author.click();
  await expect(sort).toHaveValue("author");
  await expect(author).toHaveAttribute(
    "aria-description",
    "Ascending. Updates always appear first.",
  );
  await checkOrder([
    "Zulu",
    "Cedar",
    "Alpha",
    "Echo",
    "Bravo",
    "Delta",
    "Foxtrot",
  ]);
  await author.click();
  await expect(author).toHaveAttribute(
    "aria-description",
    "Descending. Updates always appear first.",
  );
  await checkOrder([
    "Alpha",
    "Cedar",
    "Zulu",
    "Foxtrot",
    "Delta",
    "Bravo",
    "Echo",
  ]);
  await active.click();
  await expect(sort).toHaveValue("");
  await expect(sort.locator("option:checked")).toHaveText("Column order");
  await expect(sort.locator("option:checked")).toBeDisabled();
  await expect(active).toHaveAttribute(
    "aria-description",
    "Descending. Updates always appear first.",
  );
  await checkOrder([
    "Alpha",
    "Zulu",
    "Cedar",
    "Bravo",
    "Delta",
    "Echo",
    "Foxtrot",
  ]);
  await active.click();
  await expect(active).toHaveAttribute(
    "aria-description",
    "Ascending. Updates always appear first.",
  );
  await checkOrder([
    "Cedar",
    "Alpha",
    "Zulu",
    "Echo",
    "Foxtrot",
    "Bravo",
    "Delta",
  ]);
  await added.click();
  await expect(sort).toHaveValue("");
  await expect(sort.locator("option:checked")).toHaveText("Column order");
  await expect(added).toHaveAttribute(
    "aria-description",
    "Descending. Updates always appear first.",
  );
  await checkOrder([
    "Cedar",
    "Zulu",
    "Alpha",
    "Foxtrot",
    "Delta",
    "Echo",
    "Bravo",
  ]);
  await added.click();
  await expect(added).toHaveAttribute(
    "aria-description",
    "Ascending. Updates always appear first.",
  );
  await checkOrder([
    "Alpha",
    "Zulu",
    "Cedar",
    "Bravo",
    "Echo",
    "Delta",
    "Foxtrot",
  ]);
  for (const value of await sort
    .locator("option:not(:disabled)")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    )) {
    await sort.selectOption(value);
    await expect(pagination).toHaveText("Page 1 of 2");
    await expect
      .poll(async () => (await names.allTextContents()).slice(0, 3).sort())
      .toEqual(["Alpha", "Cedar", "Zulu"]);
  }
  await sort.selectOption("name");
  await author.click();
  await author.click();
  await page.getByRole("link", { name: "Console", exact: true }).click();
  await page.getByRole("link", { name: "Launchpad", exact: true }).click();
  await expect(author).toHaveAttribute(
    "aria-description",
    "Descending. Updates always appear first.",
  );
  await expect(names).toHaveText([
    "Alpha",
    "Cedar",
    "Zulu",
    "Foxtrot",
    "Delta",
  ]);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({
    path: testInfo.outputPath("installed-columns-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({
    path: testInfo.outputPath("installed-columns-wide.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    )
    .toBeLessThanOrEqual(0);
  await page.screenshot({
    path: testInfo.outputPath("installed-columns-mobile.png"),
    fullPage: true,
  });
  await added.click();
  await expect(added).toHaveAttribute(
    "aria-description",
    "Descending. Updates always appear first.",
  );
  await expect(names).toHaveText([
    "Cedar",
    "Zulu",
    "Alpha",
    "Foxtrot",
    "Delta",
  ]);
  await page.screenshot({
    path: testInfo.outputPath("installed-columns-mobile-dates.png"),
    fullPage: true,
  });
});

test("a failed activation request leaves the mod's existing state visible", async ({
  page,
}) => {
  await catalog(page);
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [installed("Example")], warnings: [] } }),
  );
  await page.route("**/api/launchpad/active", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "Stop the server before changing mod activity." },
    }),
  );
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  const active = page
    .getByRole("article", { name: "Example", exact: true })
    .getByRole("switch");
  await expect(active).toBeChecked();
  await active.click();
  await expect(
    page.getByText("Stop the server before changing mod activity.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(active).toBeChecked();
  await expect(active).toBeEnabled();
});

test("catalog exposes supported CurseForge sort choices and sends the selected order", async ({
  page,
  serverId,
}) => {
  await catalog(page);
  const searches: URL[] = [];
  await page.route("**/api/launchpad/search?**", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    searches.push(new URL(route.request().url()));
    return route.fulfill({
      json: { projects: [], total: 0, offset: 0, limit: 10 },
    });
  });
  await page.goto("/#launchpad");
  const sort = page.getByLabel("Sort Launchpad", { exact: true });
  await expect(sort.locator("option")).toHaveText(
    sorts.map(({ label }) => label),
  );
  await expect(sort.locator("option:disabled")).toHaveCount(0);
  await expect(
    sort.getByRole("option", { name: "Relevancy", exact: true }),
  ).toHaveCount(0);
  for (const { id } of sorts) {
    await sort.selectOption(id);
    await expect.poll(() => searches.at(-1)?.searchParams.get("sort")).toBe(id);
  }
});

test("Modrinth shows only supported catalog sorts, headers and category children", async ({
  page,
}) => {
  await catalog(page, undefined, "mod", "modrinth");
  const searches: URL[] = [];
  await page.route("**/api/launchpad/search?**", (route) => {
    const url = new URL(route.request().url());
    searches.push(url);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return route.fulfill({
      json: {
        projects: Array.from(
          { length: Math.min(limit, 23 - offset) },
          (_, index) => ({
            id: `result-${offset + index}`,
            platform: "modrinth",
            title: `Result ${offset + index + 1}`,
            description: "Provider-backed catalog result",
          }),
        ),
        total: 23,
        offset,
        limit,
      },
    });
  });
  await page.goto("/#launchpad");
  const sort = page.getByLabel("Sort Launchpad", { exact: true });
  await expect(sort.locator("option")).toHaveText(
    modrinthSorts.map(({ label }) => label),
  );
  await expect(sort.locator("option:disabled")).toHaveCount(0);
  const header = page.getByRole("group", {
    name: "Sort catalog content columns",
  });
  await expect(header.getByRole("button")).toHaveText([
    "Date added",
    "Date modified",
  ]);
  await expect(
    header.getByRole("button", { name: "Sort by Name", exact: true }),
  ).toHaveCount(0);
  await expect(
    header.getByRole("button", { name: "Sort by Author", exact: true }),
  ).toHaveCount(0);
  await expect(
    header.getByRole("button", { name: "Sort by Active", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Next Launchpad page", exact: true })
    .click();
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("offset"))
    .toBe("10");
  await header
    .getByRole("button", { name: "Sort by Date added", exact: true })
    .click();
  await expect
    .poll(() => Object.fromEntries(searches.at(-1)?.searchParams ?? []))
    .toMatchObject({ sort: "newest", offset: "0" });
  await expect(sort).toHaveValue("newest");
  await header
    .getByRole("button", { name: "Sort by Date modified", exact: true })
    .click();
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("sort"))
    .toBe("updated");
  await page.getByRole("button", { name: /^Filters/ }).click();
  const filters = page.getByRole("region", { name: "Category filters" });
  await expect(
    filters.getByRole("checkbox", { name: "Addons", exact: true }),
  ).toHaveCount(0);
  await expect(
    filters.getByRole("checkbox", { name: "Bug Fixes", exact: true }),
  ).toHaveCount(0);
  await expect(
    filters.getByRole("checkbox", { name: "Technology", exact: true }),
  ).toBeEnabled();
  await filters
    .getByRole("button", { name: "Expand Technology", exact: true })
    .click();
  await expect(
    filters.getByRole("checkbox", { name: "Automation", exact: true }),
  ).toHaveCount(0);
  await expect(
    filters.getByRole("checkbox", { name: "Energy", exact: true }),
  ).toHaveCount(0);
  await expect(
    filters.getByRole("checkbox", { name: "Player Transport", exact: true }),
  ).toBeEnabled();
  await filters
    .getByRole("button", { name: "Expand World Gen", exact: true })
    .click();
  await expect(
    filters.getByRole("checkbox", { name: "Biomes", exact: true }),
  ).toHaveCount(0);
  await expect(
    filters.getByRole("checkbox", { name: "Structures", exact: true }),
  ).toHaveCount(0);
  await expect(
    filters.getByRole("checkbox", { name: "Mobs", exact: true }),
  ).toBeEnabled();
  await expect(filters.locator("input:disabled")).toHaveCount(0);
  await filters
    .getByRole("checkbox", { name: "Player Transport", exact: true })
    .check();
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("categories"))
    .toBe("player-transport");
  await filters.getByRole("checkbox", { name: "Mobs", exact: true }).check();
  await expect
    .poll(() =>
      searches.at(-1)?.searchParams.get("categories")?.split(",").sort(),
    )
    .toEqual(["mobs", "player-transport"]);
});

test("catalog and installed rows share columns with compact headers and update versions below their action", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await catalog(page);
  const entry = { ...installed("Alpha", true, true), author: "Mod Maker" };
  const published = "2025-12-01T12:00:00.000Z";
  const updated = "2026-10-30T16:00:00.000Z";
  const searches: URL[] = [];
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [entry], warnings: [] } }),
  );
  await page.route("**/api/launchpad/search?**", (route) => {
    const url = new URL(route.request().url());
    searches.push(url);
    return route.fulfill({
      json: {
        projects: [
          {
            id: "Zulu",
            platform: "curseforge",
            title: "Zulu",
            description: "Uninstalled project",
            author: "Another Author",
            releasedAt: published,
            updatedAt: updated,
          },
          {
            id: "Alpha",
            platform: "curseforge",
            title: "Alpha",
            description: "Installed project",
            author: "Mod Maker",
            releasedAt: published,
            updatedAt: updated,
          },
        ],
        total: 2,
        offset: 0,
        limit: 10,
      },
    });
  });
  await page.goto("/#launchpad");
  const header = page.getByRole("group", {
    name: "Sort catalog content columns",
  });
  const row = page.getByRole("article", { name: "Alpha", exact: true });
  await expect(header).toBeVisible();
  await expect(header.getByText("Remove", { exact: true })).toHaveCount(0);
  await expect(header.getByRole("button")).toHaveText([
    "Name",
    "Author",
    "Date added",
    "Date modified",
  ]);
  await expect(
    row.getByRole("switch", { name: "Active: Alpha", exact: true }),
  ).toBeChecked();
  await expect(
    page
      .getByRole("article", { name: "Zulu", exact: true })
      .getByRole("switch"),
  ).toHaveCount(0);
  await expect(
    row.getByRole("button", { name: "Remove Alpha", exact: true }),
  ).toBeVisible();
  await expect(row.getByText("100 B", { exact: true })).toHaveCount(0);
  await expect(row.locator(".launchpad-project-meta")).not.toContainText(
    "Available:",
  );
  const action = row.locator(".launchpad-version-action");
  const updateButton = action.getByRole("button", {
    name: "Update Alpha",
    exact: true,
  });
  const available = action.getByText("Available: 2.0", { exact: true });
  await expect(updateButton).toBeVisible();
  await expect(available).toBeVisible();
  const buttonBounds = await updateButton.boundingBox();
  const versionBounds = await available.boundingBox();
  expect(versionBounds!.y).toBeGreaterThanOrEqual(
    buttonBounds!.y + buttonBounds!.height,
  );
  await expect(row.locator(`time[datetime="${published}"]`)).toBeVisible();
  await expect(row.locator(`time[datetime="${updated}"]`)).toBeVisible();
  const catalogColumns = await header.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns,
  );
  await expect(row).toHaveCSS("grid-template-columns", catalogColumns);
  const assertTightArrows = async (mode: "catalog" | "installed") => {
    const gaps = await page
      .getByRole("group", { name: `Sort ${mode} content columns` })
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const text = Array.from(button.childNodes).find(
            (node) =>
              node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
          );
          const icon = button.querySelector("svg");
          if (!text || !icon) return Number.NaN;
          const range = document.createRange();
          range.selectNode(text);
          return (
            icon.getBoundingClientRect().left -
            range.getBoundingClientRect().right
          );
        }),
      );
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(3);
      expect(gap).toBeLessThanOrEqual(10);
    }
  };
  await assertTightArrows("catalog");
  await header
    .getByRole("button", { name: "Sort by Name", exact: true })
    .click();
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("sort"))
    .toBe("name");
  await expect(
    page.getByRole("article").getByRole("heading", { level: 3 }),
  ).toHaveText(["Zulu", "Alpha"]);
  await page.screenshot({
    path: testInfo.outputPath("catalog-cleanup-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    )
    .toBeLessThanOrEqual(0);
  await page.screenshot({
    path: testInfo.outputPath("catalog-cleanup-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole("switch", { name: "Show installed content" }).check();
  const installedHeader = page.getByRole("group", {
    name: "Sort installed content columns",
  });
  await expect(installedHeader).toHaveCSS(
    "grid-template-columns",
    catalogColumns,
  );
  await expect(row).toHaveCSS("grid-template-columns", catalogColumns);
  await expect(
    installedHeader.getByText("Remove", { exact: true }),
  ).toHaveCount(0);
  await expect(row.getByText("100 B", { exact: true })).toHaveCount(0);
  await expect(row.locator(".launchpad-project-meta")).not.toContainText(
    "Available:",
  );
  await expect(available).toBeVisible();
  await expect(row.locator(`time[datetime="${entry.addedAt}"]`)).toBeVisible();
  await expect(
    row.locator(`time[datetime="${entry.modifiedAt}"]`),
  ).toBeVisible();
  await assertTightArrows("installed");
  await page.screenshot({
    path: testInfo.outputPath("installed-cleanup-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    )
    .toBeLessThanOrEqual(0);
  await page.screenshot({
    path: testInfo.outputPath("installed-cleanup-mobile.png"),
    fullPage: true,
  });
});

test("category filters expose Technology and World Gen children and reset catalog pagination", async ({
  page,
}, testInfo) => {
  await catalog(page);
  const searches: URL[] = [];
  await page.route("**/api/launchpad/search?**", (route) => {
    const url = new URL(route.request().url());
    searches.push(url);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return route.fulfill({
      json: {
        projects: Array.from(
          { length: Math.min(limit, 23 - offset) },
          (_, index) => ({
            id: String(index + offset + 1),
            title: `Example ${index + offset + 1}`,
            platform: "curseforge",
            description: "Catalog filter fixture",
          }),
        ),
        total: 23,
        offset,
        limit,
      },
    });
  });
  await page.goto("/#launchpad");
  await page
    .getByRole("button", { name: "Next Launchpad page", exact: true })
    .click();
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("offset"))
    .toBe("10");
  const filters = page.getByRole("button", { name: /^Filters/ });
  await filters.click();
  await expect(filters).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("group", { name: "Launchpad top controls", exact: true }),
  ).toHaveCSS("overflow", "visible");
  await page
    .getByRole("button", { name: "Expand Technology", exact: true })
    .click();
  for (const label of [
    "Automation",
    "Energy",
    "Energy, Fluid, and Item Transport",
    "Farming",
    "Genetics",
    "Player Transport",
    "Processing",
  ])
    await expect(
      page.getByRole("checkbox", { name: label, exact: true }),
    ).toBeVisible();
  await page.getByRole("checkbox", { name: "Automation", exact: true }).check();
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("categories"))
    .toBe("automation");
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("offset"))
    .toBe("0");
  await page
    .getByRole("button", { name: "Expand World Gen", exact: true })
    .click();
  for (const label of [
    "Biomes",
    "Dimensions",
    "Mobs",
    "Ores and Resources",
    "Structures",
  ])
    await expect(
      page.getByRole("checkbox", { name: label, exact: true }),
    ).toBeVisible();
  await page.getByRole("checkbox", { name: "Structures", exact: true }).check();
  await expect
    .poll(() =>
      searches.at(-1)?.searchParams.get("categories")?.split(",").sort(),
    )
    .toEqual(["automation", "structures"]);
  await page
    .getByRole("checkbox", { name: "Automation", exact: true })
    .uncheck();
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("categories"))
    .toBe("structures");
  await page.screenshot({
    path: testInfo.outputPath("category-filters.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Close filters", exact: true })
    .click();
  await filters.click();
  await expect(
    page.getByRole("group", { name: "Launchpad top controls", exact: true }),
  ).toHaveCSS("overflow", "visible");
  const panel = page.getByRole("region", { name: "Category filters" });
  await expect
    .poll(async () => {
      const bounds = await panel.boundingBox();
      return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
    })
    .toBe(true);
  await page
    .getByRole("checkbox", { name: "Structures", exact: true })
    .uncheck();
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("categories") ?? "")
    .toBe("");
  await page.getByRole("checkbox", { name: "Structures", exact: true }).check();
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("categories"))
    .toBe("structures");
  await page.screenshot({
    path: testInfo.outputPath("category-filters-mobile.png"),
    fullPage: true,
  });
});

test("installed category filters include matching descendants and preserve the selected sort", async ({
  page,
}) => {
  await catalog(page);
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({
      json: {
        items: [
          { ...installed("Factory"), categories: ["automation"] },
          { ...installed("Landscape", true, true), categories: ["biomes"] },
        ],
        warnings: [],
      },
    }),
  );
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await expect(page.getByRole("article")).toHaveCount(2);
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(
    page.getByRole("group", { name: "Launchpad top controls", exact: true }),
  ).toHaveCSS("overflow", "visible");
  await page.getByRole("checkbox", { name: "Technology", exact: true }).check();
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("article").first()).toHaveAccessibleName(
    "Factory",
  );
  await expect(
    page.getByLabel("Sort installed content", { exact: true }),
  ).toHaveValue("name");
});

test("bottom pagination stays in sync with top controls in catalog and installed views", async ({
  page,
}, testInfo) => {
  await catalog(page);
  const searches: URL[] = [];
  await page.route("**/api/launchpad/search?**", (route) => {
    const url = new URL(route.request().url());
    searches.push(url);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return route.fulfill({
      json: {
        projects: Array.from(
          { length: Math.min(limit, 23 - offset) },
          (_, index) => ({
            id: `result-${offset + index + 1}`,
            platform: "curseforge",
            title: `Result ${offset + index + 1}`,
            description: "Bottom pagination fixture",
          }),
        ),
        total: 23,
        offset,
        limit,
      },
    });
  });
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({
      json: {
        items: Array.from({ length: 23 }, (_, index) =>
          installed(`Installed ${index + 1}`),
        ),
        warnings: [],
      },
    }),
  );
  await page.goto("/#launchpad");
  const topRows = page.getByLabel("Launchpad rows per page", { exact: true });
  const bottomRows = page.getByLabel("Launchpad bottom rows per page", {
    exact: true,
  });
  const topPage = page.getByRole("status", {
    name: "Launchpad page",
    exact: true,
  });
  const bottomPage = page.getByRole("status", {
    name: "Launchpad bottom page",
    exact: true,
  });
  const bottomNext = page.getByRole("button", {
    name: "Next Launchpad bottom page",
    exact: true,
  });
  await topRows.selectOption("10");
  await expect(bottomRows).toHaveValue("10");
  await expect(bottomPage).toHaveText("Page 1 of 3");
  const footer = page.locator(".launchpad-pagination-footer");
  await footer.scrollIntoViewIfNeeded();
  const footerBounds = await footer.boundingBox();
  const lastRowBounds = await page.getByRole("article").last().boundingBox();
  expect(footerBounds!.y).toBeGreaterThanOrEqual(
    lastRowBounds!.y + lastRowBounds!.height,
  );
  await bottomNext.click();
  await expect(topPage).toHaveText("Page 2 of 3");
  await expect(bottomPage).toHaveText("Page 2 of 3");
  await expect(page.getByRole("article").first()).toHaveAccessibleName(
    "Result 11",
  );
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("offset"))
    .toBe("10");
  await bottomRows.selectOption("5");
  await expect(topRows).toHaveValue("5");
  await expect(topPage).toHaveText("Page 1 of 5");
  await expect(bottomPage).toHaveText("Page 1 of 5");
  await expect
    .poll(() => Object.fromEntries(searches.at(-1)?.searchParams ?? []))
    .toMatchObject({ limit: "5", offset: "0" });

  await page.getByRole("switch", { name: "Show installed content" }).check();
  await expect(page.getByRole("article").first()).toHaveAccessibleName(
    "Installed 1",
  );
  await bottomNext.click();
  await expect(topPage).toHaveText("Page 2 of 5");
  await expect(bottomPage).toHaveText("Page 2 of 5");
  await expect(page.getByRole("article").first()).toHaveAccessibleName(
    "Installed 6",
  );
  await page
    .getByRole("button", { name: "Previous Launchpad page", exact: true })
    .click();
  await expect(bottomPage).toHaveText("Page 1 of 5");
  await bottomRows.selectOption("25");
  await expect(topRows).toHaveValue("25");
  await expect(bottomNext).toBeDisabled();
  await expect(page.getByRole("article")).toHaveCount(23);
  await page.setViewportSize({ width: 390, height: 844 });
  await footer.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    )
    .toBeLessThanOrEqual(0);
  await page.screenshot({
    path: testInfo.outputPath("bottom-pagination-mobile.png"),
  });
});

test("author names open individual profiles and preserve unlinked names in both views", async ({
  page,
}) => {
  await catalog(page);
  const authorLinks = [
    {
      name: "Mod Maker",
      url: "https://www.curseforge.com/members/modmaker/projects",
    },
    {
      name: "Second Maker",
      url: "https://www.curseforge.com/members/secondmaker/projects",
    },
    { name: "Offline Contributor" },
  ];
  const entries = [
    {
      ...installed("Alpha"),
      author: "Mod Maker, Second Maker, Offline Contributor",
      authorLinks,
    },
    { ...installed("Legacy"), author: "Legacy Author" },
    installed("Unknown"),
  ];
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: entries, warnings: [] } }),
  );
  await page.route("**/api/launchpad/search?**", (route) =>
    route.fulfill({
      json: {
        projects: entries.map((entry) => ({
          ...entry,
          id: entry.projectId,
          description: "Author link fixture",
        })),
        total: entries.length,
        offset: 0,
        limit: 10,
      },
    }),
  );
  await page.context().route(authorLinks[0].url!, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Mod Maker profile</h1>",
    }),
  );
  await page.goto("/#launchpad");
  const authors = page
    .getByRole("article", { name: "Alpha", exact: true })
    .locator(".launchpad-installed-author");
  for (const installedOnly of [false, true]) {
    if (installedOnly)
      await page
        .getByRole("switch", { name: "Show installed content" })
        .check();
    await expect(authors.locator("a")).toHaveText([
      "Mod Maker",
      "Second Maker",
    ]);
    for (const [index, author] of authorLinks.slice(0, 2).entries()) {
      const link = authors.locator("a").nth(index);
      await expect(link).toHaveAttribute("href", author.url!);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", /noreferrer/);
    }
    await expect(authors).toContainText("Offline Contributor");
    const legacy = page
      .getByRole("article", { name: "Legacy", exact: true })
      .locator(".launchpad-installed-author");
    await expect(legacy).toContainText("Legacy Author");
    await expect(legacy.locator("a")).toHaveCount(0);
    const unknown = page
      .getByRole("article", { name: "Unknown", exact: true })
      .locator(".launchpad-installed-author");
    await expect(unknown).toHaveText("Unknown");
    await expect(unknown.locator("a")).toHaveCount(0);
  }
  const [profile] = await Promise.all([
    page.waitForEvent("popup"),
    authors.locator("a").first().click(),
  ]);
  await expect(profile).toHaveURL(authorLinks[0].url!);
  await expect(profile.getByRole("heading")).toHaveText("Mod Maker profile");
  await profile.close();
  await expect(page).toHaveURL(/#launchpad$/);
});

test("a saved Size sort falls back to Name without restoring removed dropdown options", async ({
  page,
  serverId,
}) => {
  await catalog(page);
  await page.addInitScript((id) => {
    sessionStorage.setItem(
      `mc-panel.launchpad.view.${id}`,
      JSON.stringify({
        type: "mod",
        installedOnly: true,
        installedSort: "size",
      }),
    );
  }, serverId);
  await page.goto("/#launchpad");
  const sort = page.getByLabel("Sort installed content", { exact: true });
  await expect(sort).toHaveValue("name");
  await expect(
    sort.locator(
      'option[value="active"], option[value="added"], option[value="modified"], option[value="size"]',
    ),
  ).toHaveCount(0);
});

test("the complete bottom toolbar shares search, sort and installed state with the top toolbar", async ({
  page,
}) => {
  await catalog(page);
  const searches: URL[] = [];
  const projects = Array.from({ length: 12 }, (_, index) => ({
    id: `catalog-${index + 1}`,
    platform: "curseforge",
    title: `Catalog ${index + 1}`,
    description: "Shared toolbar fixture",
  }));
  await page.route("**/api/launchpad/search?**", (route) => {
    const url = new URL(route.request().url());
    searches.push(url);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    const matching = projects.filter((project) =>
      project.title
        .toLowerCase()
        .includes((url.searchParams.get("query") ?? "").toLowerCase()),
    );
    return route.fulfill({
      json: {
        projects: matching.slice(offset, offset + limit),
        total: matching.length,
        offset,
        limit,
      },
    });
  });
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({
      json: {
        items: [installed("Alpha", true, true), installed("Bravo")],
        warnings: [],
      },
    }),
  );
  await page.goto("/#launchpad");
  const top = page.getByRole("group", {
    name: "Launchpad top controls",
    exact: true,
  });
  const bottom = page.getByRole("group", {
    name: "Launchpad bottom controls",
    exact: true,
  });
  const topSearch = top.getByLabel("Search Launchpad", { exact: true });
  const bottomSearch = bottom.getByLabel("Search bottom Launchpad", {
    exact: true,
  });
  await bottomSearch.fill("Missing project");
  await expect(topSearch).toHaveValue("Missing project");
  await expect(
    page.getByText("No projects found", { exact: true }),
  ).toBeVisible();
  await expect(bottomSearch).toBeFocused();
  await bottom
    .getByRole("button", { name: "Clear bottom search", exact: true })
    .click();
  await expect(bottomSearch).toHaveValue("");
  await expect(bottomSearch).toBeFocused();
  await expect(topSearch).toHaveValue("");
  await expect(page.getByRole("article")).toHaveCount(10);
  await topSearch.fill("Catalog 1");
  await expect(bottomSearch).toHaveValue("Catalog 1");
  await expect(page.getByRole("article")).toHaveCount(4);
  await top.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(bottomSearch).toHaveValue("");
  const topSort = top.getByLabel("Sort Launchpad", { exact: true });
  const bottomSort = bottom.getByLabel("Sort bottom Launchpad", {
    exact: true,
  });
  await bottomSort.selectOption("newest");
  await expect(topSort).toHaveValue("newest");
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("sort"))
    .toBe("newest");
  await topSort.selectOption("downloads");
  await expect(bottomSort).toHaveValue("downloads");
  const topToggle = top.getByRole("switch", {
    name: "Show installed content",
    exact: true,
  });
  const bottomToggle = bottom.getByRole("switch", {
    name: "Show bottom installed content",
    exact: true,
  });
  await bottomToggle.check();
  await expect(topToggle).toBeChecked();
  await expect(page.getByRole("article")).toHaveCount(2);
  const topInstalledSort = top.getByLabel("Sort installed content", {
    exact: true,
  });
  const bottomInstalledSort = bottom.getByLabel(
    "Sort bottom installed content",
    { exact: true },
  );
  await bottomInstalledSort.selectOption("author");
  await expect(topInstalledSort).toHaveValue("author");
  expect(await bottomInstalledSort.getAttribute("id")).not.toBe(
    await topInstalledSort.getAttribute("id"),
  );
  await topInstalledSort.selectOption("downloads");
  await expect(bottomInstalledSort).toHaveValue("downloads");
  await expect(
    bottomInstalledSort.locator(
      'option[value="active"], option[value="added"], option[value="modified"], option[value="size"]',
    ),
  ).toHaveCount(0);
  const topReverse = top.getByRole("button", {
    name: "Reverse installed sort order",
    exact: true,
  });
  const bottomReverse = bottom.getByRole("button", {
    name: "Reverse bottom installed sort order",
    exact: true,
  });
  await bottomReverse.click();
  await expect(topReverse).toHaveAttribute("title", /^Ascending/);
  await topReverse.click();
  await expect(bottomReverse).toHaveAttribute("title", /^Descending/);
  await expect(
    bottom.getByRole("button", {
      name: "Update all from bottom toolbar",
      exact: true,
    }),
  ).toBeEnabled();
  await topToggle.uncheck();
  await expect(bottomToggle).not.toBeChecked();
  const priorRequests = searches.length;
  await bottom
    .getByRole("button", {
      name: "Refresh bottom Launchpad and check updates",
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      searches
        .slice(priorRequests)
        .some((url) => url.searchParams.get("refresh") === "true"),
    )
    .toBe(true);
});

test("top and bottom category filters have distinct panels and share selections on mobile", async ({
  page,
}, testInfo) => {
  await catalog(page);
  const searches: URL[] = [];
  await page.route("**/api/launchpad/search?**", (route) => {
    searches.push(new URL(route.request().url()));
    return route.fulfill({
      json: {
        projects: [
          {
            id: "mod",
            platform: "curseforge",
            title: "Mod",
            description: "Shared category filters",
          },
        ],
        total: 1,
        offset: 0,
        limit: 10,
      },
    });
  });
  await page.goto("/#launchpad");
  const top = page.getByRole("group", {
    name: "Launchpad top controls",
    exact: true,
  });
  const bottom = page.getByRole("group", {
    name: "Launchpad bottom controls",
    exact: true,
  });
  const topFilters = top.getByRole("button", { name: /^Filters/ });
  const bottomFilters = bottom.getByRole("button", { name: /^Bottom filters/ });
  const topPanelId = await topFilters.getAttribute("aria-controls");
  const bottomPanelId = await bottomFilters.getAttribute("aria-controls");
  expect(topPanelId).toBeTruthy();
  expect(bottomPanelId).toBeTruthy();
  expect(bottomPanelId).not.toBe(topPanelId);
  await bottomFilters.click();
  const bottomPanel = bottom.getByRole("region", {
    name: "Bottom category filters",
    exact: true,
  });
  await expect(bottomPanel).toHaveAttribute("id", bottomPanelId!);
  await bottomPanel
    .getByRole("checkbox", { name: "Adventure and RPG", exact: true })
    .check();
  await expect(topFilters).toContainText("1");
  await expect
    .poll(() => searches.at(-1)?.searchParams.get("categories"))
    .toBe("adventure-rpg");
  await page.keyboard.press("Escape");
  await expect(bottomPanel).toHaveCount(0);
  await topFilters.click();
  const topPanel = top.getByRole("region", {
    name: "Category filters",
    exact: true,
  });
  await expect(topPanel).toHaveAttribute("id", topPanelId!);
  await expect(
    topPanel.getByRole("checkbox", { name: "Adventure and RPG", exact: true }),
  ).toBeChecked();
  await topPanel.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(bottomFilters).toHaveAccessibleName("Bottom filters");
  await page.keyboard.press("Escape");
  await expect(topPanel).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await bottomFilters.click();
  await expect(bottomPanel).toBeVisible();
  const bounds = await bottomPanel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  const triggerBounds = await bottomFilters.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(triggerBounds!.y);
  await page.screenshot({
    path: testInfo.outputPath("bottom-toolbar-filters-mobile.png"),
  });
});
