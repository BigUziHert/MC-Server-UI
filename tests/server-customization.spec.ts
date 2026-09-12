import { test as base, expect } from "@playwright/test";

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
      await request.delete(`/api/servers/${server.id}`);
    }
  },
});

test("a server icon is cropped to Minecraft size, saved, shown after reload, and reset only on Save", async ({
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
  expect(
    (
      await request.get("/api/server/icon", {
        headers: { "X-Server-Id": serverId },
      })
    ).status(),
  ).toBe(404);
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

test("live telemetry renders measured memory during CPU warmup and explains public address limits", async ({
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
  await expect(memory).toContainText("Physical memory");
  await expect(
    page.getByRole("button", { name: "Copy server address" }),
  ).toHaveAttribute("title", /not been checked/);
  await expect(page.locator(".players-metric")).toContainText("/ 7");
  await expect(page.locator(".player-capacity")).toHaveCount(0);
  reading = {
    ...reading,
    cpu: 234.5,
    metricsMessage: "Server process telemetry",
  };
  await expect(cpu).toContainText("234.5");
  await expect(cpu).toContainText("100% = one core");
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
