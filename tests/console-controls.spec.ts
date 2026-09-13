import { test as base, expect } from "@playwright/test";

const test = base.extend<{ serverId: string }>({
  serverId: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29400;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const response = await request.post("/api/servers", {
      data: { name: "Console controls", mode: "demo", port },
    });
    expect(response.status()).toBe(201);
    const { server } = await response.json();
    const headers = { "X-Server-Id": server.id };
    await request.post("/api/server/power", {
      headers,
      data: { action: "start" },
    });
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/server", { headers })).json()).status,
      )
      .toBe("running");
    try {
      await use(server.id);
    } finally {
      await request.post("/api/server/power", {
        headers,
        data: { action: "stop" },
      });
      await request.delete(`/api/servers/${server.id}`);
    }
  },
});

test("server messaging sends say commands and preserves separate command/message drafts and history", async ({
  page,
  request,
  serverId,
}) => {
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    serverId,
  );
  await page.goto("/#console");
  const toggle = page.getByRole("switch", { name: "Server messaging" });
  await expect(toggle).not.toBeChecked();
  await page
    .getByRole("textbox", { name: "Server command", exact: true })
    .fill("time query daytime");
  await toggle.click();
  await expect(toggle).toBeChecked();
  const message = page.getByRole("textbox", {
    name: "Server message",
    exact: true,
  });
  await expect(message).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await message.fill("Server restarting in five minutes");
  await toggle.click();
  await expect(
    page.getByRole("textbox", { name: "Server command", exact: true }),
  ).toHaveValue("time query daytime");
  await toggle.click();
  await expect(message).toHaveValue("Server restarting in five minutes");
  const sent = page.waitForRequest(
    (req) =>
      req.url().endsWith("/api/console/command") && req.method() === "POST",
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  expect((await sent).postDataJSON()).toEqual({
    command: "say Server restarting in five minutes",
  });
  await expect(page.getByRole("log")).toContainText(
    "[Server] Server restarting in five minutes",
  );
  await expect(message).toHaveValue("");
  await message.press("ArrowUp");
  await expect(message).toHaveValue("Server restarting in five minutes");
  await message.fill("stop");
  await message.press("Enter");
  await expect(page.getByRole("log")).toContainText("[Server] stop");
  const status = await (
    await request.get("/api/server", { headers: { "X-Server-Id": serverId } })
  ).json();
  expect(status.status).toBe("running");
  await toggle.click();
  const command = page.getByRole("textbox", {
    name: "Server command",
    exact: true,
  });
  await expect(command).toHaveValue("time query daytime");
  await command.press("Enter");
  await expect(page.getByRole("log")).toContainText("[Demo] The time is 6000.");
  await command.press("ArrowUp");
  await expect(command).toHaveValue("time query daytime");
  await page.reload();
  await expect(
    page.getByRole("switch", { name: "Server messaging" }),
  ).not.toBeChecked();
});

for (const viewport of [
  { width: 1348, height: 1216 },
  { width: 390, height: 844 },
]) {
  test(`console cleanup keeps player list bounded and messaging usable at ${viewport.width}px`, async ({
    page,
    request,
    serverId,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const seed = await (
      await request.get("/api/server", { headers: { "X-Server-Id": serverId } })
    ).json();
    let players: { name: string }[] = [];
    await page.route("**/api/server", (route) =>
      route.fulfill({ json: { ...seed, players, maxPlayers: 60 } }),
    );
    await page.route("https://mc-heads.net/**", (route) => route.abort());
    await page.addInitScript(
      (id) => localStorage.setItem("mc-panel.active-server", id),
      serverId,
    );
    await page.goto("/#console");
    await expect(page.locator(".console-output")).toBeVisible();
    await expect(page.locator(".server-title h2")).toHaveText(
      "Console controls",
    );
    await page.evaluate(() => document.fonts.ready);
    for (const selector of [
      ".backup-nudge",
      ".workspace-note",
      ".console-heading p",
      ".players-metric .metric-footnote",
    ]) {
      await expect(page.locator(selector)).toHaveCount(0);
    }
    const geometry = () =>
      page.evaluate(() => {
        const rect = (selector: string) =>
          document.querySelector(selector)!.getBoundingClientRect();
        const consolePanel = rect(".console-panel"),
          side = rect(".console-side"),
          playersPanel = rect(".online-players"),
          list = document.querySelector(".players-list")!;
        return {
          consoleHeight: consolePanel.height,
          consoleBottom: consolePanel.bottom,
          sideBottom: side.bottom,
          playerHeight: playersPanel.height,
          listHeight: list.clientHeight,
          listScrollHeight: list.scrollHeight,
          documentHeight: document.documentElement.scrollHeight,
          documentWidth: document.documentElement.scrollWidth,
        };
      });
    const before = await geometry();
    if (viewport.width > 1000) {
      expect(Math.abs(before.consoleBottom - before.sideBottom)).toBeLessThan(
        2,
      );
    }
    players = Array.from({ length: 45 }, (_, index) => ({
      name: `Player_${index}`,
    }));
    await expect(page.locator(".online-players .player-row")).toHaveCount(45);
    const after = await geometry();
    expect(Math.abs(after.consoleHeight - before.consoleHeight)).toBeLessThan(
      2,
    );
    expect(Math.abs(after.playerHeight - before.playerHeight)).toBeLessThan(2);
    expect(after.documentHeight).toBeLessThanOrEqual(before.documentHeight + 2);
    expect(after.documentWidth).toBeLessThanOrEqual(viewport.width);
    expect(after.listScrollHeight).toBeGreaterThan(after.listHeight);
    await page.getByRole("switch", { name: "Server messaging" }).click();
    await expect(
      page.getByRole("textbox", { name: "Server message", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`console-${viewport.width}.png`),
      fullPage: true,
    });
  });
}
