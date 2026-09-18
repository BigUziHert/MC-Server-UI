import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

type FixtureServer = { id: string; name: string; mode: "live" | "demo" };
type Factory = (mode: "live" | "demo", name: string) => Promise<FixtureServer>;
const test = base.extend<{ createServer: Factory }>({
  createServer: async ({ request }, use) => {
    const created: string[] = [];
    try {
      await use(async (mode, name) => {
        const fleet = await (await request.get("/api/servers")).json();
        const occupied = new Set(
          fleet.servers.map((server: { port: number }) => server.port),
        );
        let port = 29500;
        while (occupied.has(port)) port++;
        const response = await request.post("/api/servers", {
          data: { name, mode, port, memoryLimitMB: 1024 },
        });
        expect(response.status()).toBe(201);
        const { server } = await response.json();
        created.push(server.id);
        return server;
      });
    } finally {
      const fleet = await (await request.get("/api/servers")).json();
      for (const id of created) {
        if (!fleet.servers.some((server: { id: string }) => server.id === id))
          continue;
        await stop(request, id);
        // Only registrations created by this fixture in the isolated E2E runtime are removed.
        expect((await request.delete(`/api/servers/${id}`)).ok()).toBe(true);
      }
    }
  },
});

async function stop(request: APIRequestContext, id: string) {
  const headers = { "X-Server-Id": id };
  const server = await (await request.get("/api/server", { headers })).json();
  if (["running", "starting"].includes(server.status))
    expect(
      (
        await request.post("/api/server/power", {
          headers,
          data: { action: "stop" },
        })
      ).ok(),
    ).toBe(true);
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/server", { headers })).json()).status,
    )
    .toBe("offline");
}
async function openSettings(page: Page, server: FixtureServer) {
  await page.goto("/#console");
  await page
    .getByRole("combobox", { name: "Switch server", exact: true })
    .selectOption(server.id);
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Server settings", exact: true });
}

test("removing an offline live server confirms preserved files, handles errors and persists selection after reload", async ({
  page,
  request,
  createServer,
}, testInfo) => {
  const server = await createServer("live", "World to remove from panel");
  const original = "Keep this Minecraft world on disk.\n";
  expect(
    (
      await request.post("/api/files", {
        headers: { "X-Server-Id": server.id },
        data: { name: "world-proof.txt", type: "file", content: original },
      })
    ).ok(),
  ).toBe(true);
  let rejectRemoval = true;
  let requests = 0;
  await page.route(`**/api/servers/${server.id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    requests++;
    if (rejectRemoval)
      return route.fulfill({
        status: 409,
        json: { error: "Fixture backup is still in progress." },
      });
    await route.fulfill({ response: await route.fetch() });
  });
  const dialog = await openSettings(page, server);
  await dialog
    .getByRole("button", { name: "Remove server", exact: true })
    .click();
  let confirmation = dialog.getByRole("group", {
    name: "Remove this server from the panel?",
    exact: true,
  });
  await expect(confirmation).toContainText(server.name);
  await expect(confirmation).toContainText(
    "Minecraft server files, worlds, backups, and Recycle Bin data will stay on your computer",
  );
  await confirmation
    .getByRole("button", { name: "Cancel removal", exact: true })
    .click();
  expect(requests).toBe(0);
  await expect(
    page.getByRole("combobox", { name: "Switch server", exact: true }),
  ).toHaveValue(server.id);
  await dialog
    .getByRole("button", { name: "Remove server", exact: true })
    .click();
  confirmation = dialog.getByRole("group", {
    name: "Remove this server from the panel?",
    exact: true,
  });
  await page.screenshot({
    path: testInfo.outputPath("server-removal-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await confirmation
    .getByRole("button", { name: "Remove server", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Fixture backup is still in progress.",
  );
  await expect(confirmation).toBeVisible();
  rejectRemoval = false;
  await confirmation
    .getByRole("button", { name: "Remove server", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Switch server", exact: true }),
  ).not.toHaveValue(server.id);
  await expect(
    page.getByRole("option", { name: server.name, exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("option", { name: server.name, exact: true }),
  ).toHaveCount(0);
  expect(requests).toBe(2);
  expect(
    (
      await request.get("/api/server", {
        headers: { "X-Server-Id": server.id },
      })
    ).status(),
  ).toBe(404);
  const dataDir = process.env.PANEL_E2E_DATA_DIR!;
  expect(path.basename(dataDir)).toMatch(/^mc-panel-e2e-/);
  expect(server.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(
    await readFile(
      path.join(dataDir, "instances", server.id, "server", "world-proof.txt"),
      "utf8",
    ),
  ).toBe(original);
});

test("running servers cannot be removed and removing the final stopped server returns to onboarding on mobile", async ({
  page,
  request,
  createServer,
}, testInfo) => {
  const server = await createServer("demo", "Last visible server fixture");
  // Present this test's registration as the entire fleet; the shared E2E default
  // and registrations used by other tests remain untouched on the server.
  await page.route("**/api/servers", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const fleet = await (await route.fetch()).json();
    const entry = fleet.servers.find(
      (item: { id: string }) => item.id === server.id,
    );
    await route.fulfill({
      json: {
        servers: entry ? [entry] : [],
        defaultServerId: entry?.id ?? null,
      },
    });
  });
  let dialog = await openSettings(page, server);
  await expect(
    dialog.getByRole("button", { name: "Remove server", exact: true }),
  ).toBeDisabled();
  await expect(dialog).toContainText(
    "Stop this server from Console before removing it.",
  );
  const blocked = await request.delete(`/api/servers/${server.id}`);
  expect(blocked.status()).toBe(409);
  expect((await blocked.json()).error).toContain("Stop this server");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await stop(request, server.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Server settings", exact: true });
  await dialog
    .getByRole("button", { name: "Remove server", exact: true })
    .click();
  const confirmation = dialog.getByRole("group", {
    name: "Remove this server from the panel?",
    exact: true,
  });
  await expect(
    confirmation.getByRole("button", { name: "Remove server", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("server-removal-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await confirmation
    .getByRole("button", { name: "Remove server", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Switch server", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create a new server", exact: true }),
  ).toBeVisible();
});
