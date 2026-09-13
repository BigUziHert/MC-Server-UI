import { test as base, expect } from "@playwright/test";
import { removeTestServer } from "./server-fixtures";

const test = base.extend<{ serverId: string }>({
  serverId: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29550;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const created = await request.post("/api/servers", {
      data: { name: "Navigation fixture", mode: "demo", port },
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
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    serverId,
  );
});

test("navigation groups collapse independently, persist, and reopen for a newly selected page", async ({
  page,
}) => {
  await page.goto("/#console");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const server = nav.getByRole("button", { name: "SERVER", exact: true });
  const minecraft = nav.getByRole("button", { name: "MINECRAFT", exact: true });
  const management = nav.getByRole("button", {
    name: "MANAGEMENT",
    exact: true,
  });
  for (const heading of [server, minecraft, management]) {
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

test("Databases is absent and old bookmarks fall back to Console without database requests", async ({
  page,
}) => {
  const databaseRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(?:servers\/[^/]+\/)?databases(?:\?|$|\/)/.test(request.url()))
      databaseRequests.push(request.url());
  });
  await page.goto("/#databases");
  await expect(
    page.getByRole("heading", { name: "Console", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Databases", exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveTitle("Console · MC Panel");
  expect(databaseRequests).toEqual([]);
});

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
