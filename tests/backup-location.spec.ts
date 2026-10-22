import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createProcessServer,
  removeTestServer,
  selectServer,
  stopTestServer,
} from "./server-fixtures";

type Backup = { id: string; name: string; size: number };
type Fixture = {
  id: string;
  otherServerId: string;
  destination: string;
  backup: Backup;
};

// Custom backup storage must be outside panel storage, so each fixture owns a
// separate, narrowly prefixed temporary root and validates it before cleanup.
async function removeFixtureStorage(directory: string) {
  const root = path.resolve(directory);
  if (
    path.dirname(root).toLowerCase() !== path.resolve(tmpdir()).toLowerCase() ||
    !path.basename(root).startsWith("mc-panel-e2e-backups-") ||
    (await lstat(root)).isSymbolicLink() ||
    (await realpath(root)).toLowerCase() !== root.toLowerCase()
  )
    throw new Error("Refusing to remove an unexpected backup test directory.");
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 300,
  });
}

const test = base.extend<{ backups: Fixture }>({
  backups: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29970;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const created = await createProcessServer(request, {
      data: { name: "Backup location fixture", mode: "live", port },
    });
    const { server } = await created.json();
    const headers = { "X-Server-Id": server.id };
    let externalRoot: string | undefined;
    try {
      externalRoot = await mkdtemp(
        path.join(tmpdir(), "mc-panel-e2e-backups-"),
      );
      await stopTestServer(request, server.id);
      const response = await request.post("/api/backups", {
        headers,
        data: { name: "Before changing location" },
      });
      expect(response.ok(), await response.text()).toBe(true);
      const { backups } = await (
        await request.get("/api/backups", { headers })
      ).json();
      await use({
        id: server.id,
        otherServerId: fleet.defaultServerId,
        destination: path.join(externalRoot, "Moved backups"),
        backup: backups[0],
      });
    } finally {
      await removeTestServer(request, server.id);
      if (externalRoot) await removeFixtureStorage(externalRoot);
    }
  },
});

async function openBackups(page: Page, fixture: Fixture) {
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    fixture.id,
  );
  await page.goto("/#backups");
  await expect(
    page.getByRole("heading", { name: "Backup location", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Change location", exact: true }),
  ).toBeEnabled();
}

async function location(request: APIRequestContext, id: string) {
  const response = await request.get("/api/backups/location", {
    headers: { "X-Server-Id": id },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

function changeDialog(page: Page) {
  return page.getByRole("dialog", {
    name: "Change backup location",
    exact: true,
  });
}

test("a typed folder moves real archives and preserves downloads, restores, and future backups", async ({
  page,
  request,
  backups,
}, testInfo) => {
  const headers = { "X-Server-Id": backups.id };
  const initial = await location(request, backups.id);
  const before = await (await request.get("/api/backups", { headers })).json();
  const bytes = await (
    await request.get(`/api/backups/${backups.backup.id}/download`, { headers })
  ).body();
  await openBackups(page, backups);
  await page
    .getByRole("button", { name: "Change location", exact: true })
    .click();
  const dialog = changeDialog(page);
  await dialog
    .getByLabel("Backup folder", { exact: true })
    .fill(backups.destination);
  await dialog
    .getByRole("button", { name: "Review move", exact: true })
    .click();
  await expect(dialog).toContainText(initial.directory);
  await expect(dialog).toContainText(backups.destination);
  await expect(dialog).toContainText(/1 backup/);
  await page.screenshot({
    path: testInfo.outputPath("backup-location-review-desktop.png"),
    fullPage: true,
  });
  // Review is read-only; the source remains current until the user confirms.
  expect((await location(request, backups.id)).directory).toBe(
    initial.directory,
  );
  await dialog
    .getByRole("button", { name: "Move backups", exact: true })
    .click();
  await expect
    .poll(async () => (await location(request, backups.id)).directory)
    .toBe(backups.destination);
  await expect
    .poll(async () => (await location(request, backups.id)).job?.status)
    .toBe("completed");
  await expect(dialog).not.toBeVisible();
  const after = await (await request.get("/api/backups", { headers })).json();
  expect(after.backups).toEqual(before.backups);
  expect(after.schedule).toEqual(before.schedule);
  expect(
    await readFile(
      path.join(backups.destination, `${backups.backup.id}.tar.gz`),
    ),
  ).toEqual(bytes);
  expect(
    await (
      await request.get(`/api/backups/${backups.backup.id}/download`, {
        headers,
      })
    ).body(),
  ).toEqual(bytes);
  await expect(
    page.getByRole("button", {
      name: `Download backup ${backups.backup.name}`,
      exact: true,
    }),
  ).toBeEnabled();

  const marker = await request.post("/api/files", {
    headers,
    data: {
      type: "file",
      name: "after-location-change.txt",
      content: "replace on restore",
    },
  });
  expect(marker.status()).toBe(201);
  await page
    .getByRole("button", {
      name: `Restore backup ${backups.backup.name}`,
      exact: true,
    })
    .click();
  const restore = page.getByRole("dialog", {
    name: "Restore this backup?",
    exact: true,
  });
  await restore.getByRole("checkbox").check();
  await restore
    .getByRole("button", { name: "Restore backup", exact: true })
    .click();
  await expect(restore).not.toBeVisible();
  expect(
    (
      await request.get("/api/files/content?path=after-location-change.txt", {
        headers,
      })
    ).status(),
  ).toBe(404);
  const next = await request.post("/api/backups", {
    headers,
    data: { name: "At new location" },
  });
  expect(next.ok(), await next.text()).toBe(true);
  const newBackup = (
    await (await request.get("/api/backups", { headers })).json()
  ).backups.find((item: Backup) => item.name === "At new location");
  expect(
    (await readFile(path.join(backups.destination, `${newBackup.id}.tar.gz`)))
      .length,
  ).toBeGreaterThan(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Backup location", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(backups.destination, { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("backup-location-desktop.png"),
    fullPage: true,
  });
  // The default lives inside protected panel storage; this exact destination
  // must remain selectable without allowing arbitrary support-folder moves.
  await page
    .getByRole("button", { name: "Change location", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Use default folder", exact: true })
    .click();
  await expect(dialog.getByLabel("Backup folder", { exact: true })).toHaveValue(
    initial.defaultDirectory,
  );
  await dialog
    .getByRole("button", { name: "Review move", exact: true })
    .click();
  await expect(dialog).toContainText("2 backups");
  await dialog
    .getByRole("button", { name: "Move backups", exact: true })
    .click();
  await expect
    .poll(async () => (await location(request, backups.id)).directory)
    .toBe(initial.defaultDirectory);
  await expect
    .poll(async () => (await location(request, backups.id)).job?.status)
    .toBe("completed");
  await expect(dialog).not.toBeVisible();
  expect(
    await readFile(
      path.join(initial.defaultDirectory, `${backups.backup.id}.tar.gz`),
    ),
  ).toEqual(bytes);
});

test("the folder browser selects a new destination and fits a phone viewport", async ({
  page,
  request,
  backups,
}, testInfo) => {
  await mkdir(backups.destination);
  const destination = path.join(backups.destination, "Selected backups");
  await page.setViewportSize({ width: 390, height: 844 });
  await openBackups(page, backups);
  await page
    .getByRole("button", { name: "Change location", exact: true })
    .click();
  const dialog = changeDialog(page);
  await dialog
    .getByRole("button", { name: "Browse folders", exact: true })
    .click();
  const picker = dialog.getByRole("region", {
    name: "Choose backup folder",
    exact: true,
  });
  await expect(picker).toBeVisible();
  await picker
    .getByLabel("Folder path", { exact: true })
    .fill(backups.destination);
  await picker.getByRole("button", { name: "Open", exact: true }).click();
  await picker
    .getByLabel("New folder name (optional)", { exact: true })
    .fill("Selected backups");
  await expect(
    picker.getByRole("button", { name: "Use new folder", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("backup-location-picker-mobile.png"),
    fullPage: true,
  });
  await picker
    .getByRole("button", { name: "Use new folder", exact: true })
    .click();
  await expect(dialog.getByLabel("Backup folder", { exact: true })).toHaveValue(
    destination,
  );
  await dialog
    .getByRole("button", { name: "Review move", exact: true })
    .click();
  await expect(dialog).toContainText(destination);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await dialog
    .getByRole("button", { name: "Move backups", exact: true })
    .click();
  await expect
    .poll(async () => (await location(request, backups.id)).job?.status)
    .toBe("completed");
  expect((await location(request, backups.id)).directory).toBe(destination);
  await expect(dialog).not.toBeVisible();
});

test("closing a pending review and switching servers discards its late response and draft", async ({
  page,
  backups,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/api/backups/location/preview", async (route) => {
    requested = true;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await openBackups(page, backups);
    await page
      .getByRole("button", { name: "Change location", exact: true })
      .click();
    const dialog = changeDialog(page);
    await dialog
      .getByLabel("Backup folder", { exact: true })
      .fill(backups.destination);
    await dialog
      .getByRole("button", { name: "Review move", exact: true })
      .click();
    await expect.poll(() => requested).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await selectServer(page, backups.otherServerId);
    release();
    await expect(
      page.getByRole("button", { name: "Change location", exact: true }),
    ).toBeEnabled();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByText(backups.destination, { exact: true }),
    ).toHaveCount(0);
    await selectServer(page, backups.id);
    await page
      .getByRole("button", { name: "Change location", exact: true })
      .click();
    await expect(
      dialog.getByLabel("Backup folder", { exact: true }),
    ).not.toHaveValue(backups.destination);
    await expect(
      dialog.getByRole("button", { name: "Move backups", exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
  }
});

test("move progress follows its server across reloads and cannot enable conflicting backup actions", async ({
  page,
  backups,
}, testInfo) => {
  await page.route("**/api/backups/location", async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    if (route.request().headers()["x-server-id"] === backups.id)
      result.job = {
        id: "fixture-location-move",
        status: "running",
        phase: "copying",
        processedBytes: 1024,
        totalBytes: 4096,
        processedFiles: 1,
        totalFiles: 4,
      };
    await route.fulfill({ response, json: result });
  });
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    backups.id,
  );
  await page.goto("/#backups");
  const progress = page.getByRole("region", {
    name: "Backup location progress",
    exact: true,
  });
  await expect(progress).toContainText("Copying backups");
  await expect(
    page.getByRole("button", { name: "Change location", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Create backup", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: `Restore backup ${backups.backup.name}`,
      exact: true,
    }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("backup-location-progress-mobile.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(progress).toContainText("Copying backups");
  await selectServer(page, backups.otherServerId);
  await expect(progress).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create backup", exact: true }),
  ).toBeEnabled();
  await selectServer(page, backups.id);
  await expect(progress).toContainText("Copying backups");
});

test("an unavailable backup drive shows the problem and disables archive operations", async ({
  page,
  backups,
}) => {
  await page.route("**/api/backups/location", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        available: false,
        error: "Reconnect the backup drive to continue.",
      },
    });
  });
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    backups.id,
  );
  await page.goto("/#backups");
  await expect(
    page.getByText("Reconnect the backup drive to continue.", { exact: true }),
  ).toBeVisible();
  for (const name of [
    "Create backup",
    `Download backup ${backups.backup.name}`,
    `Restore backup ${backups.backup.name}`,
    `Delete backup ${backups.backup.name}`,
  ])
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
});

test("a shared administrator cannot browse or change host backup storage", async ({
  page,
  backups,
}) => {
  const permissions = [
    "server.view",
    "backup.read",
    "backup.create",
    "backup.download",
    "backup.restore",
    "backup.delete",
  ];
  const storageRequests: string[] = [];
  await page.addInitScript(() =>
    localStorage.setItem("mc-panel.session.v1", "b".repeat(43)),
  );
  // Simulate a shared session in the renderer while forwarding ordinary
  // fixture reads to the isolated owner's API, never to a real remote host.
  await page.route("**/api/**", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers.authorization;
    await route.fulfill({ response: await route.fetch({ headers }) });
  });
  await page.route("**/api/access/session", (route) =>
    route.fulfill({
      json: {
        role: "subuser",
        email: "backup-admin@example.test",
        userId: "backup-admin",
        serverId: backups.id,
        permissions,
      },
    }),
  );
  await page.route("**/api/servers", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers.authorization;
    const response = await route.fetch({ headers });
    const fleet = await response.json();
    await route.fulfill({
      response,
      json: {
        ...fleet,
        defaultServerId: backups.id,
        servers: fleet.servers
          .filter((item: { id: string }) => item.id === backups.id)
          .map((item: object) => ({ ...item, accessPermissions: permissions })),
      },
    });
  });
  await page.route("**/api/backups/location**", (route) => {
    storageRequests.push(route.request().url());
    return route.fulfill({
      status: 403,
      json: { error: "Only the panel owner can change backup storage." },
    });
  });
  await page.goto("/#backups");
  await expect(
    page.getByRole("heading", { name: "Backups", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: `Download backup ${backups.backup.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Backup location", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Change location", exact: true }),
  ).toHaveCount(0);
  expect(storageRequests).toEqual([]);
});
