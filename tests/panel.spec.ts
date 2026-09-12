import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import * as tar from "tar";

async function openPage(page: Page, hash: string, heading: string) {
  const endpoint = (
    {
      console: "/api/server",
      files: "/api/files",
      backups: "/api/backups",
      subusers: "/api/subusers",
      databases: "/api/databases",
      audit: "/api/audit",
      players: "/api/players",
    } as Record<string, string>
  )[hash];
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === endpoint,
    ),
    page.goto(`/#${hash}`),
  ]);
  expect(response.ok()).toBe(true);
  await expect(
    page.getByRole("heading", { level: 1, name: heading, exact: true }),
  ).toBeVisible();
}

test("console loads real API logs, sends commands, and controls the demo lifecycle", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Console." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "E2E Overworld" }),
  ).toBeVisible();
  await expect(page.getByText("Demo workspace", { exact: true })).toBeVisible();
  const logs = page.getByRole("log", { name: "Server console output" });
  await expect(logs).toContainText("Done (2.314s)");

  const command = page.getByRole("textbox", { name: "Server command" });
  await command.fill("say Hello from the browser test");
  await page.getByRole("button", { name: "Send command", exact: true }).click();
  await expect(logs).toContainText(
    "[Demo] [Server] Hello from the browser test",
  );
  await expect(command).toHaveValue("");
  const recorded = await (await request.get("/api/console")).json();
  expect(
    recorded.lines.some(
      (line: { message: string }) =>
        line.message === "> say Hello from the browser test",
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Stop your server?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop server", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await expect(command).toBeDisabled();
  expect((await (await request.get("/api/server")).json()).status).toBe(
    "offline",
  );

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  await expect(command).toBeEnabled();
  await expect(logs).toContainText("[Demo] Done! Server is ready.");
  expect((await (await request.get("/api/server")).json()).status).toBe(
    "running",
  );
});

test("file manager creates and edits nested files and preserves upload/download bytes", async ({
  page,
  request,
}, testInfo) => {
  await openPage(page, "files", "File Manager");
  await expect(
    page.getByRole("button", { name: "server.properties", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Folder name").fill("e2e-folder");
  await dialog
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "e2e-folder", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "File path" }),
  ).toContainText("e2e-folder");

  await page.getByRole("button", { name: "New file", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("File name").fill("test.properties");
  await dialog
    .getByLabel("Contents (optional)")
    .fill("motd=Original test world\n");
  await dialog
    .getByRole("button", { name: "Create file", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Edit test.properties", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("File contents")).toHaveValue(
    "motd=Original test world\n",
  );
  const updated = "motd=Browser-tested world\nmax-players=32\n";
  await dialog.getByLabel("File contents").fill(updated);
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    (
      await (
        await request.get("/api/files/content?path=e2e-folder/test.properties")
      ).json()
    ).content,
  ).toBe(updated);

  const bytes = Buffer.from([0, 1, 2, 10, 13, 128, 200, 254, 255]);
  await page.getByLabel("Upload server files").setInputFiles({
    name: "uploaded.bin",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await expect(
    page.getByRole("button", { name: "uploaded.bin", exact: true }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Download uploaded.bin", exact: true })
    .click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("uploaded.bin");
  const downloadedPath = testInfo.outputPath("uploaded.bin");
  await download.saveAs(downloadedPath);
  expect(await readFile(downloadedPath)).toEqual(bytes);

  await page.reload();
  await page.getByRole("button", { name: "e2e-folder", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "uploaded.bin", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete uploaded.bin", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete permanently" })
    .click();
  await expect(
    page.getByRole("button", { name: "uploaded.bin", exact: true }),
  ).toHaveCount(0);
});

test("manual backups download a real archive and automatic schedules persist", async ({
  page,
  request,
}, testInfo) => {
  const seed = await request.post("/api/files", {
    data: {
      path: "",
      name: "e2e-backup-probe.txt",
      type: "file",
      content: "This file must be inside the backup.\n",
    },
  });
  expect(seed.ok()).toBe(true);
  await openPage(page, "backups", "Backups");
  await page
    .getByRole("button", { name: "Create backup", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Create a backup" });
  await dialog.getByLabel(/Backup name/).fill("Before browser test");
  await dialog
    .getByRole("button", { name: "Create backup", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Before browser test" }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Download backup Before browser test" })
    .click();
  const download = await downloadEvent;
  const archivePath = testInfo.outputPath("backup.tar.gz");
  await download.saveAs(archivePath);
  const archiveEntries: string[] = [];
  await tar.t({
    file: archivePath,
    onReadEntry: (entry) => {
      archiveEntries.push(entry.path);
    },
  });
  expect(
    archiveEntries.some((name) => name.endsWith("/e2e-backup-probe.txt")),
  ).toBe(true);
  expect(
    archiveEntries.some((name) => name.endsWith("/server.properties")),
  ).toBe(true);

  await page.getByRole("switch", { name: "Enable automatic backups" }).click();
  await page
    .getByRole("combobox", { name: "Frequency", exact: true })
    .selectOption("interval");
  await page.getByLabel(/Back up every/).fill("12");
  await page.getByLabel(/Scheduled backups to keep/).fill("4");
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Schedule saved", exact: true }),
  ).toBeVisible();
  let result = await (await request.get("/api/backups")).json();
  expect(result.schedule).toMatchObject({
    enabled: true,
    type: "interval",
    intervalHours: 12,
    retention: 4,
  });
  expect(Date.parse(result.schedule.nextRun)).toBeGreaterThan(Date.now());

  await page
    .getByRole("combobox", { name: "Frequency", exact: true })
    .selectOption("daily");
  await page.getByLabel("Time", { exact: true }).fill("02:30");
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Schedule saved", exact: true }),
  ).toBeVisible();
  result = await (await request.get("/api/backups")).json();
  expect(result.schedule).toMatchObject({
    enabled: true,
    type: "daily",
    time: "02:30",
    retention: 4,
  });

  await page
    .getByRole("combobox", { name: "Frequency", exact: true })
    .selectOption("weekly");
  await page
    .getByRole("combobox", { name: "Day", exact: true })
    .selectOption("2");
  await page.getByLabel("Time", { exact: true }).fill("04:15");
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Schedule saved", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("switch", { name: "Enable automatic backups" }),
  ).toBeChecked();
  await expect(
    page.getByRole("combobox", { name: "Frequency", exact: true }),
  ).toHaveValue("weekly");
  await expect(
    page.getByRole("combobox", { name: "Day", exact: true }),
  ).toHaveValue("2");
  await expect(page.getByLabel("Time", { exact: true })).toHaveValue("04:15");
  await expect(page.getByLabel(/Scheduled backups to keep/)).toHaveValue("4");
  result = await (await request.get("/api/backups")).json();
  expect(result.schedule).toMatchObject({
    type: "weekly",
    dayOfWeek: 2,
    time: "04:15",
  });
});

test("subusers records are clearly local and can be added, searched, and removed", async ({
  page,
  request,
}) => {
  await openPage(page, "subusers", "Subusers");
  await expect(
    page.getByText(/Adding a record does not grant access/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add access record", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "Add someone to your team" });
  await expect(dialog.getByText(/No invitation will be sent/)).toBeVisible();
  await dialog.getByLabel("Email address").fill("operator@example.com");
  await dialog.getByRole("radio", { name: /Viewer/ }).check();
  await dialog
    .getByRole("button", { name: "Add access record", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "operator@example.com" });
  await expect(row).toContainText("Viewer");
  expect((await (await request.get("/api/subusers")).json()).users).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        email: "operator@example.com",
        role: "viewer",
      }),
    ]),
  );
  await page
    .getByRole("textbox", { name: "Search access records" })
    .fill("no-such-person");
  await expect(
    page.getByRole("heading", { name: "No matching people" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search access records" })
    .fill("operator");
  await expect(row).toBeVisible();
  await row
    .getByRole("button", {
      name: "Remove access record for operator@example.com",
    })
    .click();
  dialog = page.getByRole("dialog", { name: "Remove access record?" });
  await dialog
    .getByRole("button", { name: "Remove record", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toHaveCount(0);
  expect(
    (await (await request.get("/api/subusers")).json()).users.some(
      (user: { email: string }) => user.email === "operator@example.com",
    ),
  ).toBe(false);
});

test("databases create actual SQLite files and support confirmed deletion", async ({
  page,
  request,
}, testInfo) => {
  await openPage(page, "databases", "Databases");
  await expect(
    page.getByText("Local SQLite databases", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create database", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "Create a database" });
  await dialog.getByLabel("Database name").fill("e2e_player_stats");
  await dialog
    .getByRole("button", { name: "Create database", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "e2e_player_stats" });
  await expect(row).toContainText("SQLite");
  const downloadEvent = page.waitForEvent("download");
  await row
    .getByRole("link", { name: "Download e2e_player_stats", exact: true })
    .click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("e2e_player_stats.sqlite");
  const databasePath = testInfo.outputPath("e2e_player_stats.sqlite");
  await download.saveAs(databasePath);
  const database = await readFile(databasePath);
  expect(database.subarray(0, 16).toString()).toBe("SQLite format 3\0");
  expect(database.length).toBeGreaterThan(1024);
  expect(
    (await (await request.get("/api/databases")).json()).databases,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "e2e_player_stats",
        type: "SQLite",
        size: database.length,
      }),
    ]),
  );
  await row
    .getByRole("button", { name: "Delete database e2e_player_stats" })
    .click();
  dialog = page.getByRole("dialog", { name: "Delete database?" });
  await expect(
    dialog.getByRole("link", { name: "Download database" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Delete database", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toHaveCount(0);
  expect(
    (await (await request.get("/api/databases")).json()).databases.some(
      (item: { name: string }) => item.name === "e2e_player_stats",
    ),
  ).toBe(false);
});

test("audit filters distinguish real file and database actions and support search", async ({
  page,
  request,
}) => {
  expect(
    (
      await request.post("/api/files", {
        data: {
          path: "",
          name: "e2e-audit-probe.txt",
          type: "file",
          content: "audit probe",
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await request.post("/api/databases", {
        data: { name: "e2e_audit_database" },
      })
    ).ok(),
  ).toBe(true);
  await openPage(page, "audit", "Audit logs");
  const filters = page.getByRole("group", {
    name: "Filter by activity category",
  });
  const rows = page.getByRole("table").getByRole("row");
  await expect(rows.filter({ hasText: "e2e-audit-probe.txt" })).toBeVisible();
  await expect(rows.filter({ hasText: "e2e_audit_database" })).toBeVisible();
  await filters.getByRole("button", { name: "Files", exact: true }).click();
  await expect(
    filters.getByRole("button", { name: "Files", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(rows.filter({ hasText: "e2e-audit-probe.txt" })).toBeVisible();
  await expect(rows.filter({ hasText: "e2e_audit_database" })).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Search audit logs" })
    .fill("e2e-audit-probe.txt");
  await expect(rows).toHaveCount(2);
  await page
    .getByRole("textbox", { name: "Search audit logs" })
    .fill("does-not-exist-in-log");
  await expect(
    page.getByRole("heading", { name: "No activity matches your filters" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await filters.getByRole("button", { name: "Databases", exact: true }).click();
  await expect(rows.filter({ hasText: "e2e_audit_database" })).toBeVisible();
  await expect(rows.filter({ hasText: "e2e-audit-probe.txt" })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh activity" }).click();
  await expect(page.getByRole("status")).toContainText("Audit log refreshed.");
});

test("all pages fit a mobile viewport and navigation remains usable", async ({
  page,
  request,
}) => {
  for (const [endpoint, data] of [
    [
      "/api/files",
      {
        path: "",
        name: "mobile-layout-probe.txt",
        type: "file",
        content: "mobile layout",
      },
    ],
    [
      "/api/subusers",
      { email: "mobile.viewport@example.com", role: "operator" },
    ],
    ["/api/databases", { name: "mobile_layout_probe" }],
    ["/api/backups", { name: "Mobile layout backup" }],
    ["/api/players/op", { name: "Mobile_Player" }],
  ] as const)
    expect((await request.post(endpoint, { data })).ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  const pages = [
    { hash: "console", heading: "Console." },
    { hash: "files", heading: "File Manager" },
    { hash: "subusers", heading: "Subusers" },
    { hash: "players", heading: "Players" },
    { hash: "databases", heading: "Databases" },
    { hash: "backups", heading: "Backups" },
    { hash: "audit", heading: "Audit logs" },
  ];
  for (const destination of pages) {
    await test.step(destination.heading, async () => {
      await openPage(page, destination.hash, destination.heading);
      await expect(
        page.getByRole("button", { name: "Open navigation" }),
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => ({
        pixels: document.documentElement.scrollWidth - window.innerWidth,
        elements: Array.from(document.querySelectorAll("body *"))
          .filter(
            (element) =>
              element.getBoundingClientRect().right > window.innerWidth + 1,
          )
          .map((element) => ({
            tag: element.tagName,
            className: element.className,
            right: element.getBoundingClientRect().right,
            width: element.getBoundingClientRect().width,
          }))
          .slice(0, 12),
      }));
      expect(
        overflow.pixels,
        `${destination.heading} must not create horizontal page scrolling: ${JSON.stringify(overflow.elements)}`,
      ).toBeLessThanOrEqual(1);
    });
  }
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "File Manager" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "File Manager", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close navigation" }),
  ).not.toBeVisible();
});

type TestServer = {
  id: string;
  name: string;
  mode: string;
  port: number;
  memoryLimitMB: number;
};

async function listServers(request: APIRequestContext) {
  const response = await request.get("/api/servers");
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{
    servers: TestServer[];
    defaultServerId: string;
  }>;
}

async function createTestServer(
  request: APIRequestContext,
  name: string,
  port: number,
) {
  const response = await request.post("/api/servers", {
    data: { name, mode: "demo", port, memoryLimitMB: 2048 },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).server as TestServer;
}

function serverHeaders(serverId: string) {
  return { "X-Server-Id": serverId };
}

async function scopedGet(
  request: APIRequestContext,
  serverId: string,
  endpoint: string,
) {
  const response = await request.get(`/api${endpoint}`, {
    headers: serverHeaders(serverId),
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function switchServer(page: Page, id: string) {
  await page
    .getByRole("combobox", { name: "Switch server", exact: true })
    .selectOption(id);
  await expect(
    page.getByRole("combobox", { name: "Switch server", exact: true }),
  ).toHaveValue(id);
}

test("server creation, editable names, and the selected workspace persist across reloads", async ({
  page,
  request,
}) => {
  const initial = await listServers(request);
  await page.goto("/");
  const selector = page.getByRole("combobox", {
    name: "Switch server",
    exact: true,
  });
  await expect(selector).toHaveValue(initial.defaultServerId);
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Add a server", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Server name", { exact: true }).fill("E2E Creative");
  await dialog.getByLabel("Mode", { exact: true }).selectOption("demo");
  await dialog.getByLabel("Server port", { exact: true }).fill("25671");
  await dialog
    .getByRole("button", { name: "Create server", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const created = (await listServers(request)).servers.find(
    (server) => server.name === "E2E Creative",
  );
  expect(created).toBeDefined();
  await expect(selector).toHaveValue(created!.id);
  await expect(
    page.getByRole("heading", { name: "E2E Creative", exact: true }),
  ).toBeVisible();
  expect(created).toMatchObject({
    mode: "demo",
    port: 25671,
    memoryLimitMB: 4096,
  });

  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Server settings", exact: true });
  await expect(dialog.getByLabel("Server name", { exact: true })).toHaveValue(
    "E2E Creative",
  );
  await dialog
    .getByLabel("Server name", { exact: true })
    .fill("E2E Creative Lab");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "E2E Creative Lab", exact: true }),
  ).toBeVisible();
  await expect(selector.locator("option:checked")).toHaveText(
    "E2E Creative Lab",
  );
  await page.reload();
  await expect(selector).toHaveValue(created!.id);
  await expect(
    page.getByRole("heading", { name: "E2E Creative Lab", exact: true }),
  ).toBeVisible();
  expect(
    (await listServers(request)).servers.find(
      (server) => server.id === created!.id,
    )?.name,
  ).toBe("E2E Creative Lab");

  await switchServer(page, initial.defaultServerId);
  await expect(
    page.getByRole("heading", { name: "E2E Overworld", exact: true }),
  ).toBeVisible();
  await switchServer(page, created!.id);
  await expect(
    page.getByRole("heading", { name: "E2E Creative Lab", exact: true }),
  ).toBeVisible();
});

test("server selection scopes file edits and downloads, console commands, backups, and access records", async ({
  page,
  request,
}, testInfo) => {
  const { defaultServerId } = await listServers(request);
  const secondary = await createTestServer(
    request,
    "E2E Isolated World",
    25672,
  );
  for (const [serverId, content, marker] of [
    [defaultServerId, "Original world contents\n", "e2e-default-only.txt"],
    [secondary.id, "Secondary world contents\n", "e2e-secondary-only.txt"],
  ]) {
    for (const [name, text] of [
      ["e2e-shared-name.txt", content],
      [marker, marker],
    ]) {
      const response = await request.post("/api/files", {
        headers: serverHeaders(serverId),
        data: { path: "", name, type: "file", content: text },
      });
      expect(response.ok()).toBe(true);
    }
  }
  const originalBackup = await request.post("/api/backups", {
    headers: serverHeaders(defaultServerId),
    data: { name: "E2E original world snapshot" },
  });
  expect(originalBackup.ok()).toBe(true);
  const originalSchedule = (
    await scopedGet(request, defaultServerId, "/backups")
  ).schedule;

  await page.goto("/#files");
  await switchServer(page, secondary.id);
  await expect(
    page.getByRole("button", { name: "e2e-secondary-only.txt", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "e2e-default-only.txt", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Edit e2e-shared-name.txt", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("File contents")).toHaveValue(
    "Secondary world contents\n",
  );
  const updated = "Edited in the selected secondary server\n";
  await dialog.getByLabel("File contents").fill(updated);
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    (
      await scopedGet(
        request,
        secondary.id,
        "/files/content?path=e2e-shared-name.txt",
      )
    ).content,
  ).toBe(updated);
  expect(
    (
      await scopedGet(
        request,
        defaultServerId,
        "/files/content?path=e2e-shared-name.txt",
      )
    ).content,
  ).toBe("Original world contents\n");
  let downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Download e2e-shared-name.txt", exact: true })
    .click();
  let download = await downloadEvent;
  const filePath = testInfo.outputPath("secondary-server-file.txt");
  await download.saveAs(filePath);
  expect(await readFile(filePath, "utf8")).toBe(updated);

  await page.getByLabel("Upload server files").setInputFiles({
    name: "e2e-secondary-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A selected-server upload"),
  });
  await expect(
    page.getByRole("button", { name: "e2e-secondary-upload.txt", exact: true }),
  ).toBeVisible();
  expect((await scopedGet(request, secondary.id, "/files")).entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "e2e-secondary-upload.txt" }),
    ]),
  );
  expect(
    (await scopedGet(request, defaultServerId, "/files")).entries,
  ).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "e2e-secondary-upload.txt" }),
    ]),
  );

  await openPage(page, "console", "Console.");
  await expect(
    page.getByRole("heading", { name: "E2E Isolated World", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Server command", exact: true })
    .fill("say E2E second-world-only message");
  await page.getByRole("button", { name: "Send command", exact: true }).click();
  await expect(
    page.getByRole("log", { name: "Server console output" }),
  ).toContainText("E2E second-world-only message");
  expect(
    (await scopedGet(request, secondary.id, "/console")).lines.some(
      (line: { message: string }) =>
        line.message.includes("E2E second-world-only message"),
    ),
  ).toBe(true);
  expect(
    (await scopedGet(request, defaultServerId, "/console")).lines.some(
      (line: { message: string }) =>
        line.message.includes("E2E second-world-only message"),
    ),
  ).toBe(false);

  await openPage(page, "backups", "Backups");
  await expect(
    page.getByRole("heading", {
      name: "E2E original world snapshot",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Create backup", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Create a backup" });
  await dialog.getByLabel(/Backup name/).fill("E2E secondary world snapshot");
  await dialog
    .getByRole("button", { name: "Create backup", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "E2E secondary world snapshot",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await scopedGet(request, defaultServerId, "/backups")).backups,
  ).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "E2E secondary world snapshot" }),
    ]),
  );
  downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("link", {
      name: "Download backup E2E secondary world snapshot",
      exact: true,
    })
    .click();
  download = await downloadEvent;
  const archivePath = testInfo.outputPath("secondary-server-backup.tar.gz");
  await download.saveAs(archivePath);
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    onReadEntry: (entry) => {
      entries.push(entry.path);
    },
  });
  expect(entries.some((name) => name.endsWith("/e2e-secondary-only.txt"))).toBe(
    true,
  );
  expect(entries.some((name) => name.endsWith("/e2e-default-only.txt"))).toBe(
    false,
  );
  await page
    .getByRole("switch", { name: "Enable automatic backups", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Frequency", exact: true })
    .selectOption("interval");
  await page.getByLabel(/Back up every/).fill("8");
  await page.getByLabel(/Scheduled backups to keep/).fill("3");
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Schedule saved", exact: true }),
  ).toBeVisible();
  expect(
    (await scopedGet(request, secondary.id, "/backups")).schedule,
  ).toMatchObject({
    enabled: true,
    type: "interval",
    intervalHours: 8,
    retention: 3,
  });
  expect(
    (await scopedGet(request, defaultServerId, "/backups")).schedule,
  ).toEqual(originalSchedule);

  await openPage(page, "subusers", "Subusers");
  await expect(
    page.getByRole("button", { name: /Grant OP|Revoke OP|Remove OP/ }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add access record", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Add someone to your team" });
  await dialog.getByLabel("Email address").fill("secondary-only@example.com");
  await dialog.getByRole("radio", { name: /Viewer/ }).check();
  await dialog
    .getByRole("button", { name: "Add access record", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "secondary-only@example.com" }),
  ).toBeVisible();
  expect((await scopedGet(request, secondary.id, "/subusers")).users).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ email: "secondary-only@example.com" }),
    ]),
  );
  expect(
    (await scopedGet(request, defaultServerId, "/subusers")).users,
  ).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ email: "secondary-only@example.com" }),
    ]),
  );
  await switchServer(page, defaultServerId);
  await expect(
    page.getByRole("row").filter({ hasText: "secondary-only@example.com" }),
  ).toHaveCount(0);
});
test("Players grants and removes simulated OP independently of panel access and other servers", async ({
  page,
  request,
}) => {
  const { defaultServerId } = await listServers(request);
  const secondary = await createTestServer(
    request,
    "E2E Player Permissions",
    25673,
  );
  expect(
    (
      await request.post("/api/players/op", {
        headers: serverHeaders(defaultServerId),
        data: { name: "PrimaryGuard" },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/#players");
  await switchServer(page, secondary.id);
  await expect(
    page.getByRole("heading", { level: 1, name: "Players", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Demo mode · Simulated operators", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Remove OP for PrimaryGuard",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Grant OP", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "Grant operator permissions",
    exact: true,
  });
  const username = dialog.getByLabel("Minecraft username", { exact: true });
  await expect(username).toBeFocused();
  await username.fill("bad name!");
  await dialog.getByRole("button", { name: "Grant OP", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(
    await username.evaluate(
      (input) => (input as HTMLInputElement).validity.valid,
    ),
  ).toBe(false);
  expect(
    (await scopedGet(request, secondary.id, "/players")).operators,
  ).toEqual([]);
  await username.fill("E2E_Builder");
  await dialog.getByRole("button", { name: "Grant OP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  let removeButton = page.getByRole("button", {
    name: "Remove OP for E2E_Builder",
    exact: true,
  });
  await expect(removeButton).toBeVisible();
  expect(
    (await scopedGet(request, secondary.id, "/players")).operators,
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "E2E_Builder" })]),
  );
  expect(
    (await scopedGet(request, defaultServerId, "/players")).operators,
  ).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "E2E_Builder" })]),
  );
  expect(
    (await scopedGet(request, secondary.id, "/subusers")).users,
  ).toHaveLength(0);

  await page.getByRole("button", { name: "Grant OP", exact: true }).click();
  dialog = page.getByRole("dialog", {
    name: "Grant operator permissions",
    exact: true,
  });
  await dialog
    .getByLabel("Minecraft username", { exact: true })
    .fill("e2e_builder");
  await dialog.getByRole("button", { name: "Grant OP", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("already an operator");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(
    (await scopedGet(request, secondary.id, "/players")).operators,
  ).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Switch server", exact: true }),
  ).toHaveValue(secondary.id);
  await expect(removeButton).toBeVisible();

  await switchServer(page, defaultServerId);
  await expect(
    page.getByRole("button", {
      name: "Remove OP for PrimaryGuard",
      exact: true,
    }),
  ).toBeVisible();
  await expect(removeButton).toHaveCount(0);
  await switchServer(page, secondary.id);
  await expect(removeButton).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search operators", exact: true })
    .fill("no_such_player");
  await expect(
    page.getByRole("heading", { name: "No matching players", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search operators", exact: true })
    .fill("builder");
  await expect(removeButton).toBeVisible();
  await removeButton.click();
  dialog = page.getByRole("dialog", {
    name: "Remove operator permissions?",
    exact: true,
  });
  await expect(dialog).toContainText("E2E_Builder");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(removeButton).toBeVisible();
  await removeButton.click();
  await dialog.getByRole("button", { name: "Remove OP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(removeButton).toHaveCount(0);
  expect(
    (await scopedGet(request, secondary.id, "/players")).operators,
  ).toEqual([]);
  expect(
    (await scopedGet(request, defaultServerId, "/players")).operators,
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "PrimaryGuard" })]),
  );
  await page.reload();
  await expect(removeButton).toHaveCount(0);

  await openPage(page, "subusers", "Subusers");
  await expect(
    page.getByRole("button", { name: /Grant OP|Remove OP|Revoke OP/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add access record", exact: true }),
  ).toBeVisible();

  await openPage(page, "console", "Console.");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Stop your server?", exact: true })
    .getByRole("button", { name: "Stop server", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  expect((await scopedGet(request, defaultServerId, "/server")).status).toBe(
    "running",
  );
  await openPage(page, "players", "Players");
  await expect(
    page.getByText("Start the server to manage operators", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Grant OP", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Go to Console", exact: false }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  await openPage(page, "players", "Players");
  await expect(
    page.getByRole("button", { name: "Grant OP", exact: true }),
  ).toBeEnabled();
});

test("mobile navigation exposes server controls and the Players page without horizontal overflow", async ({
  page,
  request,
}) => {
  const secondary = await createTestServer(
    request,
    "Mobile Creative Workshop",
    25674,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Console.", exact: true }),
  ).toBeVisible();
  const assertFits = async (label: string) => {
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(
      overflow,
      `${label} must fit the mobile viewport`,
    ).toBeLessThanOrEqual(1);
  };

  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Switch server", exact: true }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Add a server", exact: true });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel("Server name", { exact: true })
    .fill("A longer mobile server name");
  await dialog.getByLabel("Mode", { exact: true }).selectOption("demo");
  await assertFits("Add server dialog");
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  const closeNavigation = page.getByRole("button", {
    name: "Close navigation",
    exact: true,
  });
  if (await closeNavigation.isVisible()) {
    // Tap the exposed shade to the right of the 208px mobile sidebar.
    await closeNavigation.click({ position: { x: 380, y: 120 } });
  }

  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Server settings", exact: true });
  await expect(dialog.getByLabel("Server name", { exact: true })).toBeVisible();
  await assertFits("Server settings dialog");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  if (!(await closeNavigation.isVisible()))
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await switchServer(page, secondary.id);
  if (!(await closeNavigation.isVisible())) {
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  }
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("link", { name: "Players", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Players", exact: true }),
  ).toBeVisible();
  await expect(closeNavigation).not.toBeVisible();
  await page.getByRole("button", { name: "Grant OP", exact: true }).click();
  dialog = page.getByRole("dialog", {
    name: "Grant operator permissions",
    exact: true,
  });
  await dialog
    .getByLabel("Minecraft username", { exact: true })
    .fill("Mobile_Builder01");
  await assertFits("Grant OP dialog");
  await dialog.getByRole("button", { name: "Grant OP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Remove OP for Mobile_Builder01",
      exact: true,
    }),
  ).toBeVisible();
  await assertFits("Populated Players page");
});
