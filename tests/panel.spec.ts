import {
  createProcessServer,
  selectServer,
  serverButton,
  stopTestServer,
} from "./server-fixtures";
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";

const minecraftHeadFixture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 8 8"><path fill="#70513d" d="M0 0h8v8H0z"/><path fill="#c99777" d="M1 3h6v4H1z"/><path fill="#284c78" d="M1 3h2v1H1zm4 0h2v1H5z"/><path fill="#452c20" d="M2 6h4v1H2z"/></svg>';

test.beforeEach(async ({ page }) => {
  // Exercise real image decoding while keeping skin-service networking deterministic.
  await page.route("https://mc-heads.net/**", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: minecraftHeadFixture }),
  );
});

async function openPage(page: Page, hash: string, heading: string) {
  const endpoint = (
    {
      console: "/api/server",
      files: "/api/files",
      backups: "/api/backups",
      subusers: "/api/subusers",
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

async function seedServerProperties(request: APIRequestContext) {
  // File tests own their input instead of relying on process startup files.
  const content =
    "# Browser test fixture\nserver-port=25565\nmotd=E2E file workspace\nmax-players=20\n";
  const created = await request.post("/api/files", {
    data: { name: "server.properties", type: "file", content },
  });
  if (created.status() === 409) {
    const updated = await request.put("/api/files/content", {
      data: { path: "server.properties", content },
    });
    expect(updated.status(), await updated.text()).toBe(200);
  } else expect(created.status(), await created.text()).toBe(201);
}

test("console loads subprocess logs, sends commands, and controls its lifecycle", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Console" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "E2E Overworld" }),
  ).toBeVisible();
  const logs = page.getByRole("log", { name: "Server console output" });
  await expect(logs).toContainText("Done (2.314s)");

  const command = page.getByRole("textbox", { name: "Server command" });
  await command.fill("say Hello from the browser test");
  await page.getByRole("button", { name: "Send command", exact: true }).click();
  await expect(logs).toContainText("[Server] Hello from the browser test");
  await expect(command).toHaveValue("");
  const recorded = await (await request.get("/api/console")).json();
  expect(
    recorded.lines.some(
      (line: { message: string }) =>
        line.message === "> say Hello from the browser test",
    ),
  ).toBe(true);

  await page
    .locator(".server-power")
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Stop your server?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop server", exact: true }).click();
  await expect(
    page
      .locator(".server-power")
      .getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await expect(command).toBeDisabled();
  expect((await (await request.get("/api/server")).json()).status).toBe(
    "offline",
  );

  await page
    .locator(".server-power")
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await expect(
    page
      .locator(".server-power")
      .getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  await expect(command).toBeEnabled();
  await expect(logs).toContainText('Done (2.314s)! For help, type "help"');
  expect((await (await request.get("/api/server")).json()).status).toBe(
    "running",
  );
});

for (const viewport of [
  { name: "desktop", width: 1823, height: 1216 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`console stays a fixed scrolling box as logs stream in on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    let lineCount = 6;
    await page.route("**/api/console", (route) =>
      route.fulfill({
        json: {
          lines: Array.from({ length: lineCount }, (_, index) => ({
            id: `streamed-log-${index}`,
            time: "12:34:56",
            level: "info",
            message: `[Server thread] Log ${index}: Saving chunk data and processing scheduled world updates for the connected players.`,
          })),
        },
      }),
    );
    await page.goto("/#console");
    const logs = page.getByRole("log", {
      name: "Server console output",
      exact: true,
    });
    await expect(logs.locator(".log-line")).toHaveCount(lineCount);
    await page.evaluate(() => document.fonts.ready);
    const dimensions = () =>
      logs.evaluate((element) => {
        const log = element as HTMLElement;
        const panel = log.closest(".console-panel")!;
        const command = panel.querySelector<HTMLInputElement>(
          'input[aria-label="Server command"]',
        )!;
        const logRect = log.getBoundingClientRect();
        const commandRect = command.getBoundingClientRect();
        return {
          panelHeight: panel.getBoundingClientRect().height,
          pageHeight: document.documentElement.scrollHeight,
          logHeight: logRect.height,
          logBottom: logRect.bottom + window.scrollY,
          scrollHeight: log.scrollHeight,
          scrollTop: log.scrollTop,
          bottomGap: log.scrollHeight - log.clientHeight - log.scrollTop,
          commandTop: commandRect.top + window.scrollY,
          commandInsideLog: log.contains(command),
        };
      });
    const baseline = await dimensions();

    // The component's regular polling receives more lines without a page reload.
    lineCount = 180;
    await expect(logs.locator(".log-line")).toHaveCount(lineCount);
    const overflowed = await dimensions();
    expect(overflowed.panelHeight).toBeCloseTo(baseline.panelHeight, 0);
    expect(overflowed.logHeight).toBeCloseTo(baseline.logHeight, 0);
    expect(overflowed.pageHeight).toBeCloseTo(baseline.pageHeight, 0);
    expect(overflowed.scrollHeight).toBeGreaterThan(
      baseline.scrollHeight + 1000,
    );
    expect(overflowed.commandInsideLog).toBe(false);
    expect(overflowed.commandTop).toBeGreaterThanOrEqual(overflowed.logBottom);
    expect(overflowed.commandTop).toBeCloseTo(baseline.commandTop, 0);
    await expect
      .poll(async () => (await dimensions()).bottomGap)
      .toBeLessThanOrEqual(1);

    const autoscroll = page.getByRole("button", {
      name: "Autoscroll",
      exact: true,
    });
    await autoscroll.click();
    await expect(autoscroll).not.toHaveClass(/\bactive\b/);
    await logs.evaluate((element) => {
      element.scrollTop = 50;
    });
    const paused = await dimensions();
    expect(paused.scrollTop).toBe(50);
    lineCount = 360;
    await expect(logs.locator(".log-line")).toHaveCount(lineCount);
    const appended = await dimensions();
    expect(appended.scrollHeight).toBeGreaterThan(
      overflowed.scrollHeight + 1000,
    );
    expect(appended.scrollTop).toBeCloseTo(paused.scrollTop, 0);
    expect(appended.panelHeight).toBeCloseTo(baseline.panelHeight, 0);
    expect(appended.logHeight).toBeCloseTo(baseline.logHeight, 0);
    expect(appended.pageHeight).toBeCloseTo(baseline.pageHeight, 0);
    expect(appended.commandTop).toBeCloseTo(baseline.commandTop, 0);

    await autoscroll.click();
    await expect(autoscroll).toHaveClass(/\bactive\b/);
    await expect
      .poll(async () => (await dimensions()).bottomGap)
      .toBeLessThanOrEqual(1);
    await expect(
      page.getByRole("textbox", { name: "Server command", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath(`dense-console-${viewport.name}.png`),
      fullPage: true,
    });
  });
}

test("file manager creates and edits nested files and preserves upload/download bytes", async ({
  page,
  request,
}, testInfo) => {
  await seedServerProperties(request);
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
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "uploaded.bin", exact: true }),
  ).toHaveCount(0);
});

test("manual backups download a real archive and automatic schedules persist", async ({
  page,
  request,
}, testInfo) => {
  await seedServerProperties(request);
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

test("subusers can be prepared before remote setup, searched, and revoked", async ({
  page,
  request,
}) => {
  await openPage(page, "subusers", "Subusers");
  await page.getByRole("button", { name: "New user", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Create new subuser" });
  await expect(
    dialog.getByText(/No invitation link can be created/),
  ).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", {
      name: "Create invitation link",
      exact: true,
    }),
  ).toBeDisabled();
  await dialog.getByLabel("Email address").fill("operator@example.com");
  await dialog
    .getByRole("checkbox", { name: "View audit logs", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "operator@example.com" });
  await expect(row).toContainText("1 selected");
  await expect(row).toContainText("Not invited");
  expect((await (await request.get("/api/subusers")).json()).users).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        email: "operator@example.com",
        role: "custom",
        permissions: ["audit.read"],
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
  await expect(dialog).toContainText(
    "active sessions and invitation links will stop working",
  );
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

test("removing the Databases page preserves existing SQLite files", async ({
  page,
  request,
}) => {
  // Seed an existing record through the compatibility API, never user data.
  expect(
    (
      await request.post("/api/databases", {
        data: { name: "e2e_player_stats" },
      })
    ).status(),
  ).toBe(201);
  const before = (await (await request.get("/api/databases")).json()).databases;
  const record = before.find(
    (item: { name: string }) => item.name === "e2e_player_stats",
  );
  const download = await request.get(`/api/databases/${record.id}/download`);
  const original = await download.body();
  expect(original.subarray(0, 16).toString()).toBe("SQLite format 3\0");
  await page.goto("/#databases");
  await expect(
    page.getByRole("heading", { name: "Console", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Databases", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Databases", exact: true }),
  ).toHaveCount(0);
  expect(
    (await (await request.get("/api/databases")).json()).databases,
  ).toEqual(before);
  expect(
    await (await request.get(`/api/databases/${record.id}/download`)).body(),
  ).toEqual(original);
});

test("audit filters show file, server and player actions without databases", async ({
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
      await request.put("/api/files/content", {
        data: { path: "e2e-audit-probe.txt", content: "edited audit probe" },
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
  const serverStatus = async () =>
    (await (await request.get("/api/server")).json()).status;
  if ((await serverStatus()) !== "offline") {
    expect(
      (
        await request.post("/api/server/power", { data: { action: "stop" } })
      ).ok(),
    ).toBe(true);
    await expect.poll(serverStatus).toBe("offline");
  }
  for (const action of ["start", "restart"]) {
    expect(
      (await request.post("/api/server/power", { data: { action } })).ok(),
    ).toBe(true);
    await expect.poll(serverStatus).toBe("running");
  }
  for (const action of ["op", "ban", "unban", "deop"]) {
    const response = await request.post(`/api/players/${action}`, {
      data: { name: "Audit_Player" },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  const audit = await (await request.get("/api/audit")).json();
  expect(
    audit.entries.some(
      (entry: { category: string }) => entry.category === "database",
    ),
  ).toBe(false);
  await openPage(page, "audit", "Audit logs");
  const filters = page.getByRole("group", {
    name: "Filter by activity category",
  });
  const rows = page.getByRole("table").getByRole("row");
  await expect(
    filters.getByRole("button", { name: "Databases", exact: true }),
  ).toHaveCount(0);
  await expect(rows.filter({ hasText: "e2e-audit-probe.txt" })).toHaveCount(2);
  await expect(rows.filter({ hasText: "e2e_audit_database" })).toHaveCount(0);
  await filters.getByRole("button", { name: "Files", exact: true }).click();
  await expect(
    filters.getByRole("button", { name: "Files", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    rows
      .filter({ hasText: "e2e-audit-probe.txt" })
      .filter({ hasText: "File edited" }),
  ).toBeVisible();
  await expect(rows.filter({ hasText: "Audit_Player" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "e2e_audit_database" })).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Search audit logs" })
    .fill("e2e-audit-probe.txt");
  await expect(rows).toHaveCount(3);
  await page
    .getByRole("textbox", { name: "Search audit logs" })
    .fill("does-not-exist-in-log");
  await expect(
    page.getByRole("heading", { name: "No activity matches your filters" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await filters.getByRole("button", { name: "Players", exact: true }).click();
  await expect(rows.filter({ hasText: "Audit_Player" })).toHaveCount(4);
  for (const action of [
    "Player op requested",
    "Player deop requested",
    "Player ban requested",
    "Player unban requested",
  ])
    await expect(
      rows.filter({ hasText: "Audit_Player" }).filter({ hasText: action }),
    ).toBeVisible();
  await expect(rows.filter({ hasText: "e2e-audit-probe.txt" })).toHaveCount(0);
  await filters.getByRole("button", { name: "Server", exact: true }).click();
  for (const action of ["Server started", "Server restarted", "Server stopped"])
    await expect(rows.filter({ hasText: action }).first()).toBeVisible();
  await expect(rows.filter({ hasText: "Audit_Player" })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh audit logs" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Audit logs refreshed." }),
  ).toBeVisible();
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
    ["/api/backups", { name: "Mobile layout backup" }],
    ["/api/players/op", { name: "Mobile_Player" }],
  ] as const)
    expect((await request.post(endpoint, { data })).ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  const pages = [
    { hash: "console", heading: "Console" },
    { hash: "files", heading: "File Manager" },
    { hash: "subusers", heading: "Subusers" },
    { hash: "players", heading: "Players" },
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
  const response = await createProcessServer(request, {
    data: { name, mode: "live", port, memoryLimitMB: 2048 },
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
  await selectServer(page, id);
  await expect(serverButton(page, id)).toHaveAttribute("aria-pressed", "true");
}

async function chooseNewServer(page: Page) {
  const choice = page.getByRole("dialog", {
    name: "Add a server",
    exact: true,
  });
  await expect(choice).toBeVisible();
  await expect(
    choice.getByRole("button", {
      name: "Import an existing server",
      exact: true,
    }),
  ).toBeVisible();
  await choice
    .getByRole("button", { name: "Create a new server", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Server software", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Modpack", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Advanced setup", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("button", { name: "Create an empty server", exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByLabel("Mode", { exact: true })).toHaveCount(0);
  return page.getByRole("dialog");
}

test("editable server names and the selected workspace persist across reloads", async ({
  page,
  request,
}) => {
  const initial = await listServers(request);
  await page.goto("/");
  await expect(serverButton(page, initial.defaultServerId)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Existing-workspace tests use isolated API fixtures; creation is covered by onboarding.spec.ts.
  const created = await createTestServer(request, "E2E Creative", 25671);
  await page.reload();
  await switchServer(page, created.id);
  await expect(
    page.getByRole("heading", { name: "E2E Creative", exact: true }),
  ).toBeVisible();
  expect(created).toMatchObject({
    mode: "live",
    port: 25671,
    memoryLimitMB: 2048,
  });

  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Server settings",
    exact: true,
  });
  await expect(
    dialog.getByRole("combobox", { name: "Mode", exact: true }),
  ).toHaveCount(0);
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
  await expect(serverButton(page, created.id)).toHaveAccessibleName(
    "Select server E2E Creative Lab",
  );
  await page.reload();
  await expect(serverButton(page, created!.id)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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

  await openPage(page, "console", "Console");
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
  await page.getByRole("button", { name: "New user", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Create new subuser" });
  await dialog.getByLabel("Email address").fill("secondary-only@example.com");
  await dialog
    .getByRole("checkbox", { name: "View audit logs", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
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
test("Players grants and removes OP through the subprocess independently of panel access and other servers", async ({
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
      await request.post("/api/files", {
        headers: serverHeaders(secondary.id),
        data: {
          name: "usercache.json",
          type: "file",
          content: JSON.stringify([
            {
              name: "E2E_Builder",
              uuid: "12345678-1234-1234-1234-123456789abc",
            },
          ]),
        },
      })
    ).status(),
  ).toBe(201);
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
    page.getByRole("button", {
      name: "Remove OP for PrimaryGuard",
      exact: true,
    }),
  ).toHaveCount(0);
  const grantButton = page.getByRole("button", {
    name: "Grant OP for E2E_Builder",
    exact: true,
  });
  await grantButton.click();
  let dialog = page.getByRole("dialog", {
    name: "Grant operator permissions",
    exact: true,
  });
  const username = dialog.getByLabel("Minecraft username", { exact: true });
  await expect(username).toBeFocused();
  await expect(username).toHaveValue("E2E_Builder");
  await expect(username).toHaveAttribute("readonly", "");
  expect(
    (await scopedGet(request, secondary.id, "/players")).operators,
  ).toEqual([]);
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

  await expect(grantButton).toBeDisabled();
  await expect(grantButton).toHaveText("Already OP");
  expect(
    (await scopedGet(request, secondary.id, "/players")).operators,
  ).toHaveLength(1);
  await page.reload();
  await expect(serverButton(page, secondary.id)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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
    page
      .getByRole("region", { name: "Operators", exact: true })
      .getByText("No matching players", { exact: true }),
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
    page.getByRole("button", { name: "New user", exact: true }),
  ).toBeVisible();

  await openPage(page, "console", "Console");
  await page
    .locator(".server-power")
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Stop your server?", exact: true })
    .getByRole("button", { name: "Stop server", exact: true })
    .click();
  await expect(
    page
      .locator(".server-power")
      .getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  expect((await scopedGet(request, defaultServerId, "/server")).status).toBe(
    "running",
  );
  await openPage(page, "players", "Players");
  await expect(
    page.getByText("Start the server to manage operators", { exact: true }),
  ).toBeVisible();
  await expect(grantButton).toBeDisabled();
  await page.getByRole("link", { name: "Go to Console", exact: false }).click();
  await page
    .locator(".server-power")
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await expect(
    page
      .locator(".server-power")
      .getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();
  await openPage(page, "players", "Players");
  await expect(grantButton).toBeEnabled();
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
  expect(
    (
      await request.post("/api/files", {
        headers: serverHeaders(secondary.id),
        data: {
          name: "usercache.json",
          type: "file",
          content: JSON.stringify([
            {
              name: "Mobile_Builder01",
              uuid: "22345678-1234-1234-1234-123456789abc",
            },
          ]),
        },
      })
    ).status(),
  ).toBe(201);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Console", exact: true }),
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
  await page
    .locator('button[data-server-id][aria-pressed="true"]')
    .scrollIntoViewIfNeeded();
  await expect(
    page.locator('button[data-server-id][aria-pressed="true"]'),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  let dialog = await chooseNewServer(page);
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
  await page
    .getByRole("button", { name: "Grant OP for Mobile_Builder01", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Grant operator permissions",
    exact: true,
  });
  await expect(
    dialog.getByLabel("Minecraft username", { exact: true }),
  ).toHaveValue("Mobile_Builder01");
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

type MockOnlinePlayer = {
  name: string;
  uuid?: string;
  latency?: number | null;
};

async function mockOnlinePlayers(
  page: Page,
  players: () => MockOnlinePlayer[],
) {
  await page.route("**/api/server", async (route) => {
    const response = await route.fetch();
    const server = await response.json();
    await route.fulfill({
      json: {
        ...server,
        mode: "live",
        status: "running",
        playersAvailable: true,
        players: players(),
      },
    });
  });
}

async function mockOperators(
  page: Page,
  operators: Array<{ name: string; uuid?: string; level?: number }>,
) {
  await page.route("**/api/players", (route) =>
    route.fulfill({
      json: { operators, mode: "live", status: "running" },
    }),
  );
}

async function expectHeadImage(
  page: Page,
  name: string,
  identifier: string,
  size: number,
) {
  const image = page.getByRole("img", {
    name: `${name}'s Minecraft head`,
    exact: true,
  });
  await expect(image).toHaveAttribute(
    "src",
    `https://mc-heads.net/avatar/${identifier}/64`,
  );
  await expect(image).toHaveAttribute("width", String(size));
  await expect(image).toHaveAttribute("height", String(size));
  await image.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
}

test("Minecraft head images use UUIDs or usernames, while console polling updates player joins and leaves", async ({
  page,
}, testInfo) => {
  const uuid = "4bd20cf8-60be-4bf0-a791-4ec8a88c82d7";
  let online: MockOnlinePlayer[] = [
    { name: "UUID_Player", uuid },
    { name: "Name_Only", latency: 42 },
    { name: "Unknown_Ping", latency: null },
  ];
  await mockOnlinePlayers(page, () => online);
  await mockOperators(page, [
    { name: "UUID_Player", uuid, level: 4 },
    { name: "Name_Only", level: 4 },
  ]);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Console", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Console.", exact: true }),
  ).toHaveCount(0);
  const playerRows = page.locator(".online-players .player-row");
  await expect(playerRows).toHaveCount(3);
  await expectHeadImage(page, "UUID_Player", uuid, 32);
  await expectHeadImage(page, "Name_Only", "Name_Only", 32);
  await expectHeadImage(page, "Unknown_Ping", "Unknown_Ping", 32);
  await expect(playerRows.filter({ hasText: "Name_Only" })).toContainText(
    "42 ms",
  );
  await expect(
    playerRows.filter({ hasText: "UUID_Player" }).locator(".player-latency"),
  ).toHaveCount(0);
  await expect(
    playerRows.filter({ hasText: "Unknown_Ping" }).locator(".player-latency"),
  ).toHaveCount(0);
  await expect(page.locator(".online-players .count-badge")).toHaveText("3");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath("console-player-heads-desktop.png"),
    fullPage: true,
  });

  online = [{ name: "Name_Only", latency: 42 }, { name: "Joined_Player" }];
  await expect(playerRows.filter({ hasText: "Joined_Player" })).toBeVisible();
  await expect(playerRows.filter({ hasText: "UUID_Player" })).toHaveCount(0);
  await expect(playerRows.filter({ hasText: "Unknown_Ping" })).toHaveCount(0);
  await expect(playerRows).toHaveCount(2);
  await expectHeadImage(page, "Joined_Player", "Joined_Player", 32);
  await expect(page.locator(".online-players .count-badge")).toHaveText("2");
  online = [];
  await expect(playerRows).toHaveCount(0);
  await expect(page.locator(".online-players .count-badge")).toHaveText("0");
  await expect(page.locator(".online-players .players-empty")).toBeVisible();

  await openPage(page, "players", "Players");
  await expectHeadImage(page, "UUID_Player", uuid, 30);
  await expectHeadImage(page, "Name_Only", "Name_Only", 30);
  await expect(page.locator(".players-operator")).toHaveCount(2);
  await expect(
    page.getByRole("button", {
      name: "Remove OP for UUID_Player",
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: testInfo.outputPath("operator-heads-desktop.png"),
    fullPage: true,
  });
});

test("failed skin requests use local Minecraft heads and changing a player identity retries the correct skin", async ({
  page,
}, testInfo) => {
  const uuid = "59006320-8d7d-4c61-a2b4-2548b51c3c47";
  let online: MockOnlinePlayer[] = [{ name: "OfflineSkin" }];
  const failedRequests: string[] = [];
  await page.route(
    "https://mc-heads.net/avatar/OfflineSkin/64",
    async (route) => {
      failedRequests.push(route.request().url());
      await route.abort("failed");
    },
  );
  await mockOnlinePlayers(page, () => online);
  await mockOperators(page, [{ name: "OfflineSkin", level: 4 }]);
  await page.goto("/");
  let fallback = page.getByRole("img", {
    name: "OfflineSkin's Minecraft head (default)",
    exact: true,
  });
  await expect(fallback).toHaveAttribute("src", "/player-head-fallback.svg");
  await fallback.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      fallback.evaluate(
        (element) => (element as HTMLImageElement).naturalWidth,
      ),
    )
    .toBeGreaterThan(0);
  expect(failedRequests).toHaveLength(1);
  await expect(
    page
      .locator(".online-players .player-row")
      .filter({ hasText: "OfflineSkin" }),
  ).toBeVisible();

  // A resolved UUID for the same connected username must clear its failed-name lookup.
  online = [{ name: "OfflineSkin", uuid }];
  await expectHeadImage(page, "OfflineSkin", uuid, 32);
  await expect(
    page.getByRole("img", {
      name: "OfflineSkin's Minecraft head (default)",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(failedRequests).toHaveLength(1);

  await openPage(page, "players", "Players");
  fallback = page.getByRole("img", {
    name: "OfflineSkin's Minecraft head (default)",
    exact: true,
  });
  await expect(fallback).toHaveAttribute("src", "/player-head-fallback.svg");
  await fallback.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      fallback.evaluate(
        (element) => (element as HTMLImageElement).naturalWidth,
      ),
    )
    .toBeGreaterThan(0);
  await expect(fallback).toHaveAttribute("width", "30");
  expect(failedRequests).toHaveLength(2);
  await expect(
    page.getByRole("button", {
      name: "Remove OP for OfflineSkin",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("operator-local-head-fallback.png"),
    fullPage: true,
  });
});

test("populated Minecraft head lists fit mobile Console and Players layouts", async ({
  page,
}, testInfo) => {
  const uuid = "6eb7b2e9-3fa1-4fc6-bf8d-f293d731c421";
  const players = [
    { name: "Long_Player_1234", uuid },
    { name: "Mobile_Builder01" },
  ];
  await page.setViewportSize({ width: 390, height: 844 });
  await mockOnlinePlayers(page, () => players);
  await mockOperators(
    page,
    players.map((player) => ({ ...player, level: 4 })),
  );
  for (const [hash, heading, size, screenshot] of [
    ["console", "Console", 32, "console-player-heads-mobile.png"],
    ["players", "Players", 30, "operator-heads-mobile.png"],
  ] as const) {
    await openPage(page, hash, heading);
    await expectHeadImage(page, "Long_Player_1234", uuid, size);
    await expectHeadImage(page, "Mobile_Builder01", "Mobile_Builder01", size);
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(
      overflow,
      `${heading} with Minecraft heads must fit the mobile viewport`,
    ).toBeLessThanOrEqual(1);
    for (const head of await page
      .getByRole("img", { name: /Minecraft head/ })
      .all()) {
      const bounds = await head.boundingBox();
      expect(bounds?.width).toBe(size);
      expect(bounds?.height).toBe(size);
    }
    await page.screenshot({
      path: testInfo.outputPath(screenshot),
      fullPage: true,
    });
  }
});

test("an empty fleet shows only guided creation and refreshes after a server is added", async ({
  page,
  request,
}, testInfo) => {
  let firstServer: TestServer | undefined;
  const unexpectedServerRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      !firstServer &&
      /^\/api\/(?:server|console|files|backups|players|subusers|databases|audit)(?:\/|$)/.test(
        pathname,
      )
    ) {
      unexpectedServerRequests.push(pathname);
    }
  });
  await page.route("**/api/servers", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: {
          servers: firstServer ? [firstServer] : [],
          defaultServerId: firstServer?.id ?? null,
        },
      });
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    if (response.ok() && route.request().method() === "POST")
      firstServer = body.server;
    await route.fulfill({ response, json: body });
  });

  await page.goto("/");
  const welcome = page.getByRole("heading", {
    level: 1,
    name: "Welcome to MC Panel",
    exact: true,
  });
  await expect(welcome).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main navigation", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("button[data-server-id]")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { level: 1, name: "Console", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("log", { name: "Server console output", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("empty-fleet-desktop.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(welcome).toBeVisible();
  expect(
    unexpectedServerRequests,
    "An empty fleet must not query a fabricated selected server.",
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("empty-fleet-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Create a new server", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Server software", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Modpack", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Advanced setup", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("button", { name: "Create an empty server", exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByLabel("Mode", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(welcome).toBeVisible();
  const fixture = await request.post("/api/servers", {
    data: {
      name: "E2E First Real Server",
      mode: "live",
      port: 25675,
      memoryLimitMB: 1024,
    },
  });
  expect(fixture.status()).toBe(201);
  firstServer = (await fixture.json()).server;
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Console", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "E2E First Real Server", exact: true }),
  ).toBeVisible();
  expect(firstServer).toMatchObject({
    name: "E2E First Real Server",
    mode: "live",
    port: 25675,
    memoryLimitMB: 1024,
  });
  await expect(
    page
      .locator(".server-power")
      .getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".online-players .player-row")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "E2E First Real Server", exact: true }),
  ).toBeVisible();
  await expect(welcome).toHaveCount(0);
});

test("removing the last listed demo returns to onboarding and preserves its files and backups", async ({
  page,
  request,
}) => {
  const demo = await createTestServer(request, "E2E Demo To Remove", 25676);
  const marker =
    "Preserve these files when removing the demonstration server.\n";
  const file = await request.post("/api/files", {
    headers: serverHeaders(demo.id),
    data: {
      path: "",
      name: "keep-after-removal.txt",
      type: "file",
      content: marker,
    },
  });
  expect(file.ok()).toBe(true);
  const backupResponse = await request.post("/api/backups", {
    headers: serverHeaders(demo.id),
    data: { name: "Keep after demo removal" },
  });
  expect(backupResponse.ok()).toBe(true);
  const backup = await backupResponse.json();
  expect(process.env.PANEL_E2E_DATA_DIR).toBeTruthy();
  const instanceDirectory = path.join(
    process.env.PANEL_E2E_DATA_DIR!,
    "instances",
    demo.id,
  );
  const markerPath = path.join(
    instanceDirectory,
    "server",
    "keep-after-removal.txt",
  );
  const backupPath = path.join(
    instanceDirectory,
    "backups",
    `${backup.id}.tar.gz`,
  );
  expect(await readFile(markerPath, "utf8")).toBe(marker);
  const archiveBefore = await readFile(backupPath);
  await stopTestServer(request, demo.id);
  demo.status = "offline";
  let removed = false;
  let removalResult: { filesPreserved: boolean } | undefined;
  await page.route("**/api/servers", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: {
          servers: removed ? [] : [demo],
          defaultServerId: removed ? null : demo.id,
        },
      });
    }
    return route.fallback();
  });
  await page.route(`**/api/servers/${demo.id}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    if (response.ok()) {
      removed = true;
      removalResult = body;
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "E2E Demo To Remove", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Server settings",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Remove server", exact: true })
    .click();
  const confirmation = dialog.getByRole("group", {
    name: "Remove this server from the panel?",
    exact: true,
  });
  await expect(confirmation).toContainText("E2E Demo To Remove");
  await expect(confirmation).toContainText("will stay on your computer");
  await confirmation
    .getByRole("button", { name: "Cancel removal", exact: true })
    .click();
  await expect(confirmation).not.toBeVisible();
  expect(removed).toBe(false);
  await dialog
    .getByRole("button", { name: "Remove server", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Remove server", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const welcome = page.getByRole("heading", {
    level: 1,
    name: "Welcome to MC Panel",
    exact: true,
  });
  await expect(welcome).toBeVisible();
  await expect(page.locator("button[data-server-id]")).toHaveCount(0);
  expect(removalResult?.filesPreserved).toBe(true);
  expect(
    (await listServers(request)).servers.some(
      (server) => server.id === demo.id,
    ),
  ).toBe(false);
  expect(await readFile(markerPath, "utf8")).toBe(marker);
  expect(await readFile(backupPath)).toEqual(archiveBefore);
  await page.reload();
  await expect(welcome).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create a new server", exact: true }),
  ).toBeVisible();
});

async function existingServerFixture({
  multipleJars = false,
  neoforge = false,
  customLauncher = false,
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "mc-panel-import-e2e-"));
  const files: Record<string, string | Buffer> = {
    "server.properties":
      "# Existing server: preserve these exact bytes\r\nserver-port=25681\r\nmotd=Imported E2E world\r\nlevel-name=existing-world\r\nmax-players=37\r\nonline-mode=true\r\n",
    "eula.txt": "# The panel must not accept this agreement.\r\neula=false\r\n",
    "existing-world/level.dat": Buffer.from([31, 139, 8, 0, 45, 127, 128, 254]),
    "plugins/Example/config.yml":
      "enabled: true\nmessage: Existing plugin settings\n",
    "logs/latest.log": "[12:00:00] [Server thread/INFO]: Existing log entry\n",
  };
  if (neoforge) {
    files["server.properties"] =
      "# Existing NeoForge server\r\nserver-port=25683\r\nmotd=Original NeoForge world\r\nlevel-name=existing-world\r\nmax-players=37\r\n";
    files["run.bat"] =
      "@echo off\r\nREM NeoForge requires JVM arguments.\r\njava @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.250/win_args.txt nogui%*\r\npause\r\n";
    files["user_jvm_args.txt"] =
      "# Keep this original RAM configuration\r\n-Xms6G\r\n-Xmx12G\r\n-XX:+UseZGC\r\n-XX:+ZGenerational\r\n-XX:+DisableExplicitGC\r\n";
    files["libraries/net/neoforged/neoforge/21.1.250/win_args.txt"] =
      "# Existing generated NeoForge arguments\r\n--launchTarget neoforgeserver\r\n";
  } else if (customLauncher) {
    files["server.properties"] =
      "# Existing custom launcher server\r\nserver-port=25684\r\nmotd=Original custom world\r\nlevel-name=existing-world\r\nmax-players=37\r\n";
    files["run.bat"] = "@echo off\r\ncall custom-launcher.bat\r\n";
    files["custom-launcher.bat"] =
      "@echo off\r\nREM Test fixture: never execute this launcher.\r\nexit /b 0\r\n";
  } else files["paper-fixture.jar"] = Buffer.from([80, 75, 3, 4, 0, 128, 255]);
  if (multipleJars)
    files["alternate-fixture.jar"] = Buffer.from([80, 75, 5, 6]);
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(directory, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  const [panelDirectory, canonicalDirectory] = await Promise.all([
    realpath(process.env.PANEL_E2E_DATA_DIR!),
    realpath(directory),
  ]);
  const relative = path.relative(panelDirectory, canonicalDirectory);
  expect(
    relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative),
  ).toBe(true);
  return directory;
}

async function snapshotExistingFolder(
  directory: string,
  prefix = "",
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      snapshot[`${relative}/`] = "directory";
      Object.assign(snapshot, await snapshotExistingFolder(absolute, relative));
    } else {
      snapshot[relative] = (await readFile(absolute)).toString("base64");
    }
  }
  return snapshot;
}

async function removeExistingFixture(directory: string) {
  expect((await lstat(directory)).isSymbolicLink()).toBe(false);
  const target = await realpath(directory);
  expect(path.dirname(target).toLowerCase()).toBe(
    (await realpath(tmpdir())).toLowerCase(),
  );
  expect(path.basename(directory).startsWith("mc-panel-import-e2e-")).toBe(
    true,
  );
  expect(path.basename(target).startsWith("mc-panel-import-e2e-")).toBe(true);
  await rm(target, { recursive: true, force: true, maxRetries: 3 });
}

async function chooseImportServer(page: Page) {
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  const choice = page.getByRole("dialog", {
    name: "Add a server",
    exact: true,
  });
  await choice
    .getByRole("button", { name: "Import an existing server", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Import an existing server",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("imports an existing external server in place without changing its files or accepting the EULA", async ({
  page,
  request,
}, testInfo) => {
  const directory = await existingServerFixture();
  const original = await snapshotExistingFolder(directory);
  try {
    await page.goto("/");
    let dialog = await chooseImportServer(page);
    await expect(
      dialog.getByRole("button", { name: "Browse", exact: true }),
    ).toHaveCount(0);
    await dialog.getByLabel("Server folder", { exact: true }).fill(directory);
    await dialog
      .getByRole("button", { name: "Inspect folder", exact: true })
      .click();
    await expect(dialog.getByLabel("Server JAR", { exact: true })).toHaveValue(
      "paper-fixture.jar",
    );
    await expect(dialog).toContainText("25681");
    await expect(dialog).toContainText(/EULA/i);
    await expect(dialog).toContainText(/not accepted/i);
    expect(await snapshotExistingFolder(directory)).toEqual(original);
    await dialog
      .getByLabel("Server name", { exact: true })
      .fill("E2E Imported World");
    await page.screenshot({
      path: testInfo.outputPath("import-review-desktop.png"),
      fullPage: true,
    });
    const importedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/server-import" &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Import server", exact: true })
      .click();
    const response = await importedResponse;
    expect(response.status()).toBe(201);
    const { server } = await response.json();
    expect(server).toMatchObject({
      name: "E2E Imported World",
      mode: "live",
      status: "offline",
      port: 25681,
      jar: "paper-fixture.jar",
      source: "imported",
    });
    expect(server.serverDir).toBe(await realpath(directory));
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: "E2E Imported World", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator(".server-power")
        .getByRole("button", { name: "Start", exact: true }),
    ).toBeEnabled();
    expect((await scopedGet(request, server.id, "/server")).status).toBe(
      "offline",
    );
    expect(await snapshotExistingFolder(directory)).toEqual(original);

    await page.getByRole("link", { name: "File Manager", exact: true }).click();
    for (const name of [
      "server.properties",
      "eula.txt",
      "paper-fixture.jar",
      "existing-world",
      "plugins",
    ])
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    await page
      .getByRole("button", { name: "existing-world", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "level.dat", exact: true }),
    ).toBeVisible();
    const downloadEvent = page.waitForEvent("download");
    await page
      .getByRole("link", { name: "Download level.dat", exact: true })
      .click();
    const download = await downloadEvent;
    const downloadPath = testInfo.outputPath("imported-level.dat");
    await download.saveAs(downloadPath);
    expect((await readFile(downloadPath)).toString("base64")).toBe(
      original["existing-world/level.dat"],
    );
    await page.reload();
    await expect(serverButton(page, server.id)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      (await listServers(request)).servers.some(
        (item) => item.id === server.id,
      ),
    ).toBe(true);
    expect(
      (await scopedGet(request, server.id, "/files/content?path=eula.txt"))
        .content,
    ).toContain("eula=false");

    dialog = await chooseImportServer(page);
    await dialog.getByLabel("Server folder", { exact: true }).fill(directory);
    await dialog
      .getByRole("button", { name: "Inspect folder", exact: true })
      .click();
    await expect(dialog).toContainText(/already|overlap/i);
    await expect(
      dialog
        .getByRole("button", { name: "Import server", exact: true })
        .and(page.locator(":enabled")),
    ).toHaveCount(0);
    expect(await snapshotExistingFolder(directory)).toEqual(original);
  } finally {
    await removeExistingFixture(directory);
  }
});

test("import review handles canceled folder selection, invalid folders, and multiple JARs on mobile", async ({
  page,
}, testInfo) => {
  const directory = await existingServerFixture({ multipleJars: true });
  const invalidDirectory = path.join(directory, "not-a-server");
  await mkdir(invalidDirectory);
  const original = await snapshotExistingFolder(directory);
  let browseCalls = 0;
  await page.route("**/api/server-import", async (route) => {
    if (route.request().method() === "GET")
      await route.fulfill({ json: { canBrowse: true } });
    else await route.continue();
  });
  await page.route("**/api/server-import/browse", async (route) => {
    browseCalls += 1;
    await route.fulfill({ json: { directory: null } });
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    const dialog = await chooseImportServer(page);
    const folder = dialog.getByLabel("Server folder", { exact: true });
    await folder.fill(invalidDirectory);
    await dialog.getByRole("button", { name: "Browse", exact: true }).click();
    await expect.poll(() => browseCalls).toBe(1);
    await expect(folder).toHaveValue(invalidDirectory);
    await dialog
      .getByRole("button", { name: "Inspect folder", exact: true })
      .click();
    await expect(dialog).toContainText(/server\.properties/i);
    await expect(
      dialog
        .getByRole("button", { name: "Import server", exact: true })
        .and(page.locator(":enabled")),
    ).toHaveCount(0);
    await folder.fill(directory);
    await dialog
      .getByRole("button", { name: "Inspect folder", exact: true })
      .click();
    const jar = dialog.getByLabel("Server JAR", { exact: true });
    await expect(jar).toHaveValue("");
    await expect(
      dialog.getByRole("button", { name: "Import server", exact: true }),
    ).toBeDisabled();
    const port = dialog.getByLabel("Server port", { exact: true });
    if (!(await port.isVisible()))
      await dialog.getByText("Advanced settings", { exact: true }).click();
    await expect(port).toHaveValue("25681");
    await port.fill("25682");
    await jar.selectOption("paper-fixture.jar");
    await expect(
      dialog.getByRole("button", { name: "Import server", exact: true }),
    ).toBeEnabled();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(391);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: testInfo.outputPath("import-review-mobile.png"),
      fullPage: true,
    });
    await folder.fill(invalidDirectory);
    await expect(
      dialog
        .getByRole("button", { name: "Import server", exact: true })
        .and(page.locator(":enabled")),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Back", exact: true }).click();
    const choice = page.getByRole("dialog", {
      name: "Add a server",
      exact: true,
    });
    await expect(choice).toBeVisible();
    await choice.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(choice).not.toBeVisible();
    expect(await snapshotExistingFolder(directory)).toEqual(original);
  } finally {
    await removeExistingFixture(directory);
  }
});

test("detects NeoForge with joined nogui%* and preserves its script, JVM arguments and existing world", async ({
  page,
  request,
}, testInfo) => {
  const directory = await existingServerFixture({ neoforge: true });
  const original = await snapshotExistingFolder(directory);
  try {
    await page.goto("/");
    let dialog = await chooseImportServer(page);
    await dialog.getByLabel("Server folder", { exact: true }).fill(directory);
    const inspectedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/server-import/inspect",
    );
    await dialog
      .getByRole("button", { name: "Inspect folder", exact: true })
      .click();
    const inspectionResponse = await inspectedResponse;
    expect(inspectionResponse.status()).toBe(200);
    const inspection = await inspectionResponse.json();
    const launchArgs = [
      "@user_jvm_args.txt",
      "@libraries/net/neoforged/neoforge/21.1.250/win_args.txt",
      "nogui",
    ];
    expect(inspection).toMatchObject({
      jars: [],
      jar: null,
      launchType: "java-args",
      launchScript: "",
      javaPath: "java",
      memoryLimitMB: 12288,
      software: "NeoForge",
      version: "21.1.250",
      launchArgs,
    });
    expect(inspection.launches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "java-args",
          path: "run.bat",
          label: "NeoForge · run.bat",
          launchArgs,
        }),
      ]),
    );
    await expect(dialog).toContainText("NeoForge");
    await expect(
      dialog.getByLabel("Launch method", { exact: true }),
    ).toHaveValue("java-args");
    await expect(
      dialog.getByLabel("Detected launcher", { exact: true }),
    ).toHaveValue("run.bat");
    await expect(dialog).toContainText("user_jvm_args.txt");
    await expect(dialog.getByLabel("Server JAR", { exact: true })).toHaveCount(
      0,
    );
    await expect(dialog.getByLabel("Memory (MB)", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      dialog.getByRole("button", { name: "Import server", exact: true }),
    ).toBeEnabled();
    expect(await snapshotExistingFolder(directory)).toEqual(original);
    await dialog
      .getByLabel("Server name", { exact: true })
      .fill("E2E NeoForge World");
    await page.screenshot({
      path: testInfo.outputPath("neoforge-import-review.png"),
      fullPage: true,
    });
    const importedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/server-import" &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Import server", exact: true })
      .click();
    const response = await importedResponse;
    expect(response.status()).toBe(201);
    const { server } = await response.json();
    expect(server).toMatchObject({
      name: "E2E NeoForge World",
      mode: "live",
      status: "offline",
      port: 25683,
      jar: "",
      launchType: "java-args",
      launchScript: "",
      launchArgs,
      memoryLimitMB: 12288,
      software: "NeoForge",
      version: "21.1.250",
      source: "imported",
    });
    expect(server.serverDir).toBe(await realpath(directory));
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: "E2E NeoForge World", exact: true }),
    ).toBeVisible();
    expect((await scopedGet(request, server.id, "/server")).status).toBe(
      "offline",
    );
    expect(await snapshotExistingFolder(directory)).toEqual(original);

    await page
      .getByRole("button", { name: "Server settings", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "Server settings", exact: true });
    await expect(
      dialog.getByLabel("Launch method", { exact: true }),
    ).toHaveValue("java-args");
    await expect(
      dialog.getByLabel("Startup arguments", { exact: true }),
    ).toHaveValue(launchArgs.join("\n"));
    await expect(dialog).toContainText("user_jvm_args.txt");
    await expect(dialog.getByLabel("Server JAR", { exact: true })).toHaveCount(
      0,
    );
    await expect(dialog.getByLabel("Memory (MB)", { exact: true })).toHaveCount(
      0,
    );
    await dialog
      .getByLabel("Launch method", { exact: true })
      .selectOption("script");
    await dialog.getByLabel("Startup script", { exact: true }).fill("run.bat");
    await expect(
      dialog.getByLabel("Startup arguments", { exact: true }),
    ).toHaveValue("");
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".server-details")).toContainText("NeoForge");
    await expect(page.locator(".server-details")).toContainText("21.1.250");
    await expect(
      page
        .locator(".metric-card")
        .filter({ hasText: "Memory" })
        .locator(".metric-value"),
    ).toContainText("/ 12 GB");
    expect(await snapshotExistingFolder(directory)).toEqual(original);

    await page.getByRole("link", { name: "File Manager", exact: true }).click();
    for (const name of [
      "run.bat",
      "user_jvm_args.txt",
      "libraries",
      "existing-world",
    ])
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    await page
      .getByRole("button", { name: "existing-world", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "level.dat", exact: true }),
    ).toBeVisible();
    const download = await request.get(
      "/api/files/download?path=existing-world/level.dat",
      { headers: serverHeaders(server.id) },
    );
    expect(download.status()).toBe(200);
    expect((await download.body()).toString("base64")).toBe(
      original["existing-world/level.dat"],
    );
    await page.reload();
    await expect(serverButton(page, server.id)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      (await listServers(request)).servers.find(
        (item) => item.id === server.id,
      ),
    ).toMatchObject({
      launchType: "script",
      launchScript: "run.bat",
      launchArgs: [],
      jar: "",
    });
    expect(
      (
        await scopedGet(
          request,
          server.id,
          "/files/content?path=user_jvm_args.txt",
        )
      ).content,
    ).toContain("-Xmx12G");
    expect(
      (await scopedGet(request, server.id, "/files/content?path=eula.txt"))
        .content,
    ).toContain("eula=false");
    expect(await snapshotExistingFolder(directory)).toEqual(original);
  } finally {
    await removeExistingFixture(directory);
  }
});

test("imports a custom startup script without requiring a JAR or executing its commands", async ({
  page,
  request,
}, testInfo) => {
  const directory = await existingServerFixture({ customLauncher: true });
  const original = await snapshotExistingFolder(directory);
  const launchArgs = ["--world", "existing-world", "--label=Friends world"];
  try {
    await page.goto("/");
    let dialog = await chooseImportServer(page);
    await dialog.getByLabel("Server folder", { exact: true }).fill(directory);
    const responseEvent = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/server-import/inspect",
    );
    await dialog
      .getByRole("button", { name: "Inspect folder", exact: true })
      .click();
    const inspectionResponse = await responseEvent;
    expect(inspectionResponse.status()).toBe(200);
    const inspection = await inspectionResponse.json();
    expect(inspection.jars).toEqual([]);
    expect(inspection.launches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "script", path: "run.bat" }),
      ]),
    );
    await dialog
      .getByLabel("Launch method", { exact: true })
      .selectOption("script");
    await dialog.getByLabel("Startup script", { exact: true }).fill("run.bat");
    await dialog
      .getByLabel("Server name", { exact: true })
      .fill("E2E Custom Launcher World");
    await expect(dialog.getByLabel("Server JAR", { exact: true })).toHaveCount(
      0,
    );
    await expect(dialog.getByLabel("Memory (MB)", { exact: true })).toHaveCount(
      0,
    );
    await dialog.getByText("Advanced settings", { exact: true }).click();
    await dialog
      .getByLabel("Startup arguments", { exact: true })
      .fill(launchArgs.join("\n"));
    await expect(
      dialog.getByRole("button", { name: "Import server", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("custom-launcher-import.png"),
      fullPage: true,
    });
    const importedEvent = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/server-import" &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Import server", exact: true })
      .click();
    const response = await importedEvent;
    expect(response.status()).toBe(201);
    const { server } = await response.json();
    expect(server).toMatchObject({
      name: "E2E Custom Launcher World",
      mode: "live",
      status: "offline",
      launchType: "script",
      launchScript: "run.bat",
      launchArgs,
      jar: "",
      source: "imported",
      port: 25684,
    });
    expect(server.serverDir).toBe(await realpath(directory));
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "E2E Custom Launcher World",
        exact: true,
      }),
    ).toBeVisible();
    expect((await scopedGet(request, server.id, "/server")).status).toBe(
      "offline",
    );
    expect(await snapshotExistingFolder(directory)).toEqual(original);
    await page
      .getByRole("button", { name: "Server settings", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "Server settings", exact: true });
    await expect(
      dialog.getByLabel("Launch method", { exact: true }),
    ).toHaveValue("script");
    await expect(
      dialog.getByLabel("Startup script", { exact: true }),
    ).toHaveValue("run.bat");
    await expect(
      dialog.getByLabel("Startup arguments", { exact: true }),
    ).toHaveValue(launchArgs.join("\n"));
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", {
        name: "E2E Custom Launcher World",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await listServers(request)).servers.find(
        (item) => item.id === server.id,
      ),
    ).toMatchObject({
      launchType: "script",
      launchScript: "run.bat",
      launchArgs,
      jar: "",
    });
    expect(await snapshotExistingFolder(directory)).toEqual(original);
  } finally {
    await removeExistingFixture(directory);
  }
});
