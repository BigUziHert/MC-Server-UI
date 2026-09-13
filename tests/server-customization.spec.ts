import { test as base, expect } from "@playwright/test";
import { removeTestServer } from "./server-fixtures";

const test = base.extend<{ serverId: string }>({
  serverId: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29300;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const response = await request.post("/api/servers", {
      data: { name: "Custom world", mode: "demo", port },
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

test("a server icon is cropped, saved, and hidden by a persistent panel preference without deleting its file", async ({
  page,
  request,
  serverId,
}) => {
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    serverId,
  );
  await page.goto("/#console");
  await page
    .getByRole("button", { name: "Edit server icon", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Server icon", exact: true });
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 96;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#e33c66";
    context.fillRect(0, 0, 128, 96);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await dialog.getByLabel("Choose server icon image").setInputFiles({
    name: "my-world.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await expect(
    dialog.getByRole("img", { name: "Server icon preview" }),
  ).toBeVisible();
  const before = await request.get("/api/server/icon", {
    headers: { "X-Server-Id": serverId },
  });
  expect(before.status()).toBe(404);
  await dialog.getByRole("button", { name: "Save icon", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const icons = page.getByRole("img", {
    name: "Custom world server icon",
    exact: true,
  });
  await expect(icons).toHaveCount(2);
  const bannerIcon = page.getByRole("button", {
    name: "Edit server icon",
    exact: true,
  });
  const box = await bannerIcon.boundingBox();
  const picture = await bannerIcon.locator("img").boundingBox();
  expect(picture!.width).toBeGreaterThanOrEqual(box!.width - 2);
  expect(picture!.height).toBeGreaterThanOrEqual(box!.height - 2);
  await expect
    .poll(() =>
      icons
        .first()
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(64);
  const downloaded = await request.get("/api/server/icon", {
    headers: { "X-Server-Id": serverId },
  });
  const bytes = await downloaded.body();
  expect(bytes.readUInt32BE(16)).toBe(64);
  expect(bytes.readUInt32BE(20)).toBe(64);
  await page.reload();
  await expect(
    page.getByRole("img", { name: "Custom world server icon", exact: true }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Edit server icon" }).click();
  await dialog.getByRole("button", { name: "Use default icon" }).click();
  await expect(dialog).toContainText("Your server-icon.png file is kept");
  expect(
    (
      await request.get("/api/server/icon", {
        headers: { "X-Server-Id": serverId },
      })
    ).status(),
  ).toBe(200);
  await dialog.getByRole("button", { name: "Save icon" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("img", { name: "Custom world server icon", exact: true }),
  ).toHaveCount(0);
  const savedIcon = () =>
    request.get("/api/server/icon", { headers: { "X-Server-Id": serverId } });
  expect(await (await savedIcon()).body()).toEqual(bytes);
  const fileDownload = await request.get(
    "/api/files/download?path=server-icon.png",
    { headers: { "X-Server-Id": serverId } },
  );
  expect(fileDownload.status()).toBe(200);
  expect(await fileDownload.body()).toEqual(bytes);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Edit server icon", exact: true }),
  ).toBeVisible();
  await expect(icons).toHaveCount(0);
  const state = await (
    await request.get("/api/server", { headers: { "X-Server-Id": serverId } })
  ).json();
  expect(state.iconPreference).toBe("default");
  expect(state.iconVersion).toBeNull();
  expect(state.serverIconVersion).toBeTruthy();
  const fleet = await (await request.get("/api/servers")).json();
  const other = fleet.servers.find(
    (server: { id: string }) => server.id !== serverId,
  );
  if (other) {
    await page
      .getByRole("combobox", { name: "Switch server", exact: true })
      .selectOption(other.id);
    await expect(
      page.getByRole("button", { name: "Edit server icon", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Switch server", exact: true })
      .selectOption(serverId);
    await expect(
      page.getByRole("button", { name: "Edit server icon", exact: true }),
    ).toBeVisible();
    await expect(icons).toHaveCount(0);
  }
  await page
    .getByRole("button", { name: "Edit server icon", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Use server icon", exact: true })
    .click();
  await expect(
    dialog.getByRole("img", { name: "Server icon preview" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close server icon", exact: true })
    .click();
  await expect(icons).toHaveCount(0);
  await page
    .getByRole("button", { name: "Edit server icon", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Use server icon", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Save icon", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(icons).toHaveCount(2);
  expect(await (await savedIcon()).body()).toEqual(bytes);
  await page.reload();
  await expect(icons).toHaveCount(2);
});

test("custom connection hostname persists while running without rewriting bind settings", async ({
  page,
  request,
  serverId,
}) => {
  const headers = { "X-Server-Id": serverId };
  const before = await (
    await request.get("/api/files/content?path=server.properties", { headers })
  ).json();
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    serverId,
  );
  await page.goto("/#console");
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Server settings",
    exact: true,
  });
  await dialog.getByLabel("Player connection address").fill("play.example.com");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy server address", exact: true }),
  ).toContainText("play.example.com:");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Copy server address", exact: true }),
  ).toContainText("play.example.com:");
  const after = await (
    await request.get("/api/files/content?path=server.properties", { headers })
  ).json();
  expect(after).toEqual(before);
  await page
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  await dialog.getByLabel("Player connection address").fill("");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy server address", exact: true }),
  ).toContainText("localhost:");
});

test("live telemetry renders memory against its allocation and CPU against whole-processor capacity", async ({
  page,
  request,
  serverId,
}, testInfo) => {
  await page.setViewportSize({ width: 1823, height: 1216 });
  const seed = await (
    await request.get("/api/server", { headers: { "X-Server-Id": serverId } })
  ).json();
  let reading = {
    ...seed,
    mode: "live",
    metricsAvailable: true,
    cpu: null as number | null,
    cpuCapacity: 800,
    memoryLimit: 16 * 1024 ** 3,
    memory: (768 * 1024 ** 2) as number | null,
    metricsMessage: "Measuring CPU usage…",
    address: "203.0.113.10:25565",
    addressSource: "public",
    addressNote:
      "Public IP detected. Port forwarding and firewall access have not been checked.",
    maxPlayers: 7,
  };
  await page.route("**/api/server", (route) =>
    route.fulfill({ json: reading }),
  );
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    serverId,
  );
  await page.goto("/#console");
  const cpu = page.locator(".metric-card").filter({ hasText: "CPU usage" });
  const memory = page.locator(".metric-card").filter({ hasText: "Memory" });
  await expect(cpu).toContainText("Measuring CPU usage");
  await expect(memory).toContainText("0.75");
  await expect(memory.locator(".metric-value")).toContainText("/ 16 GB");
  await expect(memory).toContainText("Physical memory");
  await expect(
    page.getByRole("button", { name: "Copy server address" }),
  ).toHaveAttribute("title", /not been checked/);
  await expect(page.locator(".players-metric")).toContainText("/ 7");
  await expect(page.locator(".player-capacity")).toHaveCount(0);
  await expect(page.locator(".address-source")).toHaveCount(0);
  reading = {
    ...reading,
    cpu: 234.5,
    metricsMessage: "Server process telemetry",
  };
  await expect(cpu.locator(".metric-value")).toHaveText("29.3%/ 100% (800%)");
  await expect(cpu).toContainText("Whole processor · 8 logical cores");
  await page.screenshot({
    path: testInfo.outputPath("charcoal-console.png"),
    fullPage: true,
  });
  reading = {
    ...reading,
    cpu: null,
    memory: null,
    metricsAvailable: false,
    metricsMessage: "Process counters unavailable. Retrying…",
  };
  await expect(cpu).toContainText("Process counters unavailable");
  await expect(memory).toContainText("Process counters unavailable");
  await expect(cpu.locator(".metric-value")).toHaveText("—");
  await expect(memory.locator(".metric-value")).toHaveText("—");
});

test("console shows detected NeoForge heap and version without substituting a default for unknown limits", async ({
  page,
  request,
  serverId,
}) => {
  const seed = await (
    await request.get("/api/server", { headers: { "X-Server-Id": serverId } })
  ).json();
  let reading = {
    ...seed,
    mode: "live",
    status: "running",
    metricsAvailable: true,
    memory: 11.2 * 1024 ** 3,
    memoryLimit: (12 * 1024 ** 3) as number | null,
    memoryLimitSource: "launch",
    memoryLimitState: "started",
    software: "NeoForge",
    version: "21.1.250",
  };
  await page.route("**/api/server", (route) =>
    route.fulfill({ json: reading }),
  );
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    serverId,
  );
  await page.goto("/#console");
  const memory = page.locator(".metric-card").filter({ hasText: "Memory" });
  await expect(memory.locator(".metric-value")).toHaveText("11.20/ 12 GB");
  await expect(memory).toContainText("startup heap limit");
  await expect(page.locator(".server-details")).toContainText("NeoForge");
  await expect(page.locator(".server-details")).toContainText("21.1.250");

  reading = {
    ...reading,
    status: "offline",
    memory: 0,
    memoryLimit: 16 * 1024 ** 3,
    memoryLimitState: "configured",
  };
  await expect(memory.locator(".metric-value")).toHaveText("0.00/ 16 GB");
  await expect(memory).toContainText("next launch allocation");

  reading = {
    ...reading,
    status: "running",
    memory: 11.2 * 1024 ** 3,
    memoryLimit: null,
    memoryLimitSource: "unknown",
    software: "Java",
    version: "Unknown",
  };
  await expect(memory.locator(".metric-value")).toHaveText("11.20/ — GB");
  await expect(memory).toContainText("heap limit unknown");
  await expect(page.locator(".server-details")).toContainText("Unknown");
  await expect(page.locator(".server-details")).not.toContainText("21.1.250");
});
