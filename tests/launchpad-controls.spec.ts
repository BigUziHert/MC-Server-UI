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
) {
  await page.route(/\/api\/launchpad(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        platforms: [
          {
            id: "curseforge",
            name: "CurseForge",
            available: true,
            types: [type],
            sortOptions: sorts,
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
  await expect(sort).toHaveValue("active");
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
  await expect(sort).toHaveValue("added");
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
    .locator("option")
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
  await expect(sort.locator("option:not([disabled])")).toHaveText(
    sorts.map(({ label }) => label),
  );
  await expect(
    sort.getByRole("option", { name: "Relevancy", exact: true }),
  ).toHaveAttribute("disabled", "");
  for (const { id } of sorts) {
    await sort.selectOption(id);
    await expect.poll(() => searches.at(-1)?.searchParams.get("sort")).toBe(id);
  }
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
  await expect(page.locator(".launchpad-toolbar")).toHaveCSS(
    "overflow",
    "visible",
  );
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
  await expect(page.locator(".launchpad-toolbar")).toHaveCSS(
    "overflow",
    "visible",
  );
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
  await expect(page.locator(".launchpad-toolbar")).toHaveCSS(
    "overflow",
    "visible",
  );
  await page.getByRole("checkbox", { name: "Technology", exact: true }).check();
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("article").first()).toHaveAccessibleName(
    "Factory",
  );
  await expect(
    page.getByLabel("Sort installed content", { exact: true }),
  ).toHaveValue("name");
});
