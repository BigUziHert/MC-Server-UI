import {
  selectServer,
  createProcessServer,
  serverButton,
  removeTestServer,
} from "./server-fixtures";
import { test as base, expect } from "@playwright/test";

const test = base.extend<{ serverId: string }>({
  serverId: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29550;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const created = await createProcessServer(request, {
      data: { name: "Navigation fixture", mode: "live", port },
    });
    expect(created.status()).toBe(201);
    const { server } = await created.json();
    try {
      await use(server.id);
    } finally {
      await removeTestServer(request, server.id);
    }
  },
});

test.beforeEach(async ({ page, serverId }) => {
  await page.addInitScript((id) => {
    if (!localStorage.getItem("mc-panel.active-server"))
      localStorage.setItem("mc-panel.active-server", id);
  }, serverId);
});

test("desktop selection is restored before scoped requests and persists subsequent changes", async ({
  page,
  request,
  serverId,
}) => {
  const fleet = await (await request.get("/api/servers")).json();
  const other = fleet.servers.find(
    (server: { id: string }) => server.id !== serverId,
  );
  expect(other).toBeTruthy();
  let savedId = other.id;
  const writes: string[] = [];
  let releaseSelection: (() => void) | undefined;
  const pendingSelection = new Promise<void>((resolve) => {
    releaseSelection = resolve;
  });
  let firstRead = true;
  await page.route("**/api/desktop/selection", async (route) => {
    if (route.request().method() === "PUT") {
      savedId = route.request().postDataJSON().activeServerId;
      writes.push(savedId);
    } else if (firstRead) {
      firstRead = false;
      await pendingSelection;
    }
    await route.fulfill({ json: { desktop: true, activeServerId: savedId } });
  });
  const scopedIds: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(?:server|console)(?:\?|$|\/)/.test(request.url()))
      scopedIds.push(request.headers()["x-server-id"]);
  });
  await page.goto("/#console");
  await expect(
    page.getByRole("heading", { name: "Opening MC Panel…" }),
  ).toBeVisible();
  expect(scopedIds).toEqual([]);
  releaseSelection!();
  await expect(serverButton(page, other.id)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => scopedIds.length).toBeGreaterThan(0);
  expect(scopedIds.every((id) => id === other.id)).toBe(true);
  expect(writes).toEqual([]);
  await selectServer(page, serverId);
  await expect.poll(() => savedId).toBe(serverId);
  await page.reload();
  await expect(serverButton(page, serverId)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(writes).toEqual([serverId]);
  // A stale desktop preference must not mount or scope requests to a removed ID.
  savedId = "00000000-0000-0000-0000-000000000000";
  scopedIds.length = 0;
  await page.reload();
  await expect(serverButton(page, fleet.defaultServerId)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => savedId).toBe(fleet.defaultServerId);
  expect(scopedIds).not.toContain("00000000-0000-0000-0000-000000000000");
});

test("browser server selection survives reload and all new workspace requests keep its scope", async ({
  page,
  request,
  serverId,
}) => {
  const fleet = await (await request.get("/api/servers")).json();
  const other = fleet.servers.find(
    (server: { id: string }) => server.id !== serverId,
  );
  await page.goto("/#console");
  await expect(serverButton(page, serverId)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await selectServer(page, other.id);
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("mc-panel.active-server")),
    )
    .toBe(other.id);
  const scopedIds: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(?:server|console)(?:\?|$|\/)/.test(request.url()))
      scopedIds.push(request.headers()["x-server-id"]);
  });
  await page.reload();
  await expect(serverButton(page, other.id)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => scopedIds.length).toBeGreaterThan(0);
  expect(scopedIds.every((id) => id === other.id)).toBe(true);
});

test("a failed desktop selection read waits for retry without opening the default server", async ({
  page,
  serverId,
}) => {
  let available = false;
  await page.route("**/api/desktop/selection", (route) =>
    route.fulfill(
      available
        ? { json: { desktop: true, activeServerId: serverId } }
        : {
            status: 500,
            json: { error: "Could not read the saved server choice." },
          },
    ),
  );
  const serverRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(?:server|console)(?:\?|$|\/)/.test(request.url()))
      serverRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(
    "Could not read the saved server choice.",
  );
  expect(serverRequests).toEqual([]);
  available = true;
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(serverButton(page, serverId)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("native selection flush retries once after failure and drains choices queued while waiting", async ({
  page,
  request,
  serverId,
}) => {
  const fleet = await (await request.get("/api/servers")).json();
  const other = fleet.servers.find(
    (server: { id: string }) => server.id !== serverId,
  );
  let savedId = other.id;
  let fail = true;
  let gated = false;
  const attempts: string[] = [];
  const releases: (() => void)[] = [];
  await page.route("**/api/desktop/selection", async (route) => {
    if (route.request().method() === "PUT") {
      const id = route.request().postDataJSON().activeServerId;
      attempts.push(id);
      if (fail)
        return route.fulfill({
          status: 500,
          json: { error: "Fixture preference save failed." },
        });
      if (gated)
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      savedId = id;
    }
    await route.fulfill({ json: { desktop: true, activeServerId: savedId } });
  });
  await page.goto("/");
  await expect(serverButton(page, other.id)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await selectServer(page, serverId);
  await expect(
    page.getByRole("status").filter({ hasText: "choice could not be saved" }),
  ).toBeVisible();
  const failure = await page.evaluate(async () => {
    try {
      await window.__mcPanelFlushSelection?.();
      return "unexpected success";
    } catch (cause) {
      return (cause as Error).message;
    }
  });
  expect(failure).toBe("Fixture preference save failed.");
  expect(attempts).toEqual([serverId, serverId]);
  fail = false;
  await page.evaluate(() => window.__mcPanelFlushSelection?.());
  expect(attempts).toEqual([serverId, serverId, serverId]);
  expect(savedId).toBe(serverId);
  gated = true;
  await selectServer(page, other.id);
  await expect.poll(() => releases.length).toBe(1);
  let flushed = false;
  const flush = page
    .evaluate(() => window.__mcPanelFlushSelection?.())
    .then(() => {
      flushed = true;
    });
  await selectServer(page, serverId);
  releases[0]();
  await expect.poll(() => releases.length).toBe(2);
  expect(flushed).toBe(false);
  releases[1]();
  await flush;
  expect(savedId).toBe(serverId);
});

test("navigation groups collapse independently, persist, and reopen for a newly selected page", async ({
  page,
}) => {
  await page.goto("/#console");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const server = nav.getByRole("button", {
    name: "SERVER",
    exact: true,
  });
  const minecraft = nav.getByRole("button", { name: "MINECRAFT", exact: true });
  const management = nav.getByRole("button", {
    name: "MANAGEMENT",
    exact: true,
  });
  const servers = nav.getByRole("button", {
    name: "SERVER SELECTOR",
    exact: true,
  });
  for (const heading of [server, minecraft, management, servers]) {
    await expect(heading).toHaveAttribute("aria-expanded", "true");
    const controlled = await heading.getAttribute("aria-controls");
    await expect(page.locator(`#${controlled}`)).toBeVisible();
    expect(
      await heading.evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      ),
    ).toBeGreaterThanOrEqual(12);
  }
  await minecraft.click();
  await expect(minecraft).toHaveAttribute("aria-expanded", "false");
  await expect(
    nav.getByRole("link", { name: "Versions", exact: true }),
  ).toBeHidden();
  await expect(
    nav.getByRole("link", { name: "Console", exact: true }),
  ).toBeVisible();
  await expect(
    nav.getByRole("link", { name: "Subusers", exact: true }),
  ).toBeVisible();
  await server.click();
  await expect(server).toHaveClass(/contains-active/);
  await expect(
    page.getByRole("heading", { name: "Console", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(server).toHaveAttribute("aria-expanded", "false");
  await expect(minecraft).toHaveAttribute("aria-expanded", "false");
  await expect(management).toHaveAttribute("aria-expanded", "true");
  await management.click();
  await page.evaluate(() => {
    window.location.hash = "audit";
  });
  await expect(management).toHaveAttribute("aria-expanded", "true");
  await expect(
    nav.getByRole("link", { name: "Audit Logs", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(server).toHaveAttribute("aria-expanded", "false");
  await expect(minecraft).toHaveAttribute("aria-expanded", "false");
  await server.click();
  await nav.getByRole("link", { name: "Console", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Console", exact: true }),
  ).toBeVisible();
});

for (const width of [1348, 390]) {
  test(`Servers navigation preserves collapse state and opens Add server at ${width}px`, async ({
    page,
    serverId,
  }) => {
    await page.setViewportSize({ width, height: 667 });
    await page.goto("/#properties");
    const openSidebar = async () => {
      if (width < 768)
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .click();
    };
    await openSidebar();
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    const servers = nav.getByRole("button", {
      name: "SERVER SELECTOR",
      exact: true,
    });
    const switcher = serverButton(page, serverId);
    const add = nav.getByRole("button", { name: "Add server", exact: true });
    const settings = nav.getByRole("button", {
      name: "Server settings",
      exact: true,
    });
    await expect(servers).toHaveAttribute("aria-expanded", "true");
    await expect(serverButton(page, serverId)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await servers.click();
    await expect(servers).toHaveAttribute("aria-expanded", "false");
    await expect(switcher).toBeHidden();
    await expect(add).toBeHidden();
    await expect(settings).toBeHidden();
    await expect(
      nav.getByRole("link", { name: "Properties", exact: true }),
    ).toBeVisible();
    await page.reload();
    await openSidebar();
    await expect(servers).toHaveAttribute("aria-expanded", "false");
    await servers.focus();
    await servers.press("Enter");
    await expect(servers).toHaveAttribute("aria-expanded", "true");
    await add.scrollIntoViewIfNeeded();
    await expect(add).toBeInViewport();
    await add.click();
    const dialog = page.getByRole("dialog", {
      name: "Add a server",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Create a new server", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", {
        name: "Import an existing server",
        exact: true,
      }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Create a new server", exact: true })
      .click();
    const createDialog = page.getByRole("dialog", {
      name: "What would you like to play?",
      exact: true,
    });
    await expect(
      createDialog.getByRole("button", {
        name: "Server software",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      createDialog.getByRole("button", { name: "Modpack", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(createDialog).toBeHidden();
    await expect(page).toHaveURL(/#properties$/);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}

test("mobile group controls support keyboard reopening and keep navigation within the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 667 });
  await page.goto("/#console");
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const management = nav.getByRole("button", {
    name: "MANAGEMENT",
    exact: true,
  });
  await management.focus();
  await management.press("Enter");
  await expect(management).toHaveAttribute("aria-expanded", "false");
  await expect(
    nav.getByRole("link", { name: "Subusers", exact: true }),
  ).toBeHidden();
  await management.press("Space");
  await expect(management).toHaveAttribute("aria-expanded", "true");
  await nav
    .getByRole("link", { name: "Audit Logs", exact: true })
    .scrollIntoViewIfNeeded();
  const auditBox = await nav
    .getByRole("link", { name: "Audit Logs", exact: true })
    .boundingBox();
  expect(auditBox!.y + auditBox!.height).toBeLessThanOrEqual(667);
  const dimensions = await nav.evaluate((element) => ({
    height: element.clientHeight,
    scroll: element.scrollHeight,
  }));
  expect(dimensions.scroll).toBeGreaterThan(dimensions.height);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await nav.getByRole("link", { name: "Audit Logs", exact: true }).click();
  await expect(page.locator(".sidebar")).not.toHaveClass(/is-open/);
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await expect(management).toHaveAttribute("aria-expanded", "true");
  await expect(
    nav.getByRole("link", { name: "Audit Logs", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});
