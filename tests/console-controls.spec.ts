import {
  createProcessServer,
  selectServer,
  removeTestServer,
  stopTestServer,
} from "./server-fixtures";
import { test as base, expect } from "@playwright/test";

const test = base.extend<{ serverId: string }>({
  serverId: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29400;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const response = await createProcessServer(request, {
      data: { name: "Console controls", mode: "live", port },
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
      await removeTestServer(request, server.id);
    }
  },
});

test("cleared console lines stay hidden when the marker is absent and recover after a new log sequence", async ({
  page,
  serverId,
}) => {
  const line = (id: number, message: string) => ({
    id: String(id),
    message,
    level: "info",
    time: "12:00:00",
  });
  let lines = [line(10, "Earlier message"), line(20, "Clear marker")];
  await page.route("**/api/console", (route) =>
    route.fulfill({ json: { lines } }),
  );
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    serverId,
  );
  await page.goto("/#console");
  await expect(page.locator(".console-output")).toContainText("Clear marker");
  await page
    .getByRole("button", { name: "Clear console view", exact: true })
    .click();
  await expect(page.locator(".console-output")).not.toContainText(
    "Earlier message",
  );
  lines = [line(10, "Earlier message"), line(30, "New message")];
  await expect(page.locator(".console-output")).toContainText("New message");
  await expect(page.locator(".console-output")).not.toContainText(
    "Earlier message",
  );
  lines = [line(1, "New runtime sequence")];
  await expect(page.locator(".console-output")).toContainText(
    "New runtime sequence",
  );
});

for (const width of [1348, 390]) {
  test(`console level filters combine with search, live output, and clearing at ${width}px`, async ({
    page,
    serverId,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const line = (id: number, level: string, message: string) => ({
      id,
      level,
      message,
      time: "12:00:00",
    });
    let lines = [
      line(1, "info", "Server ready"),
      line(2, "success", "World saved"),
      line(3, "debug", "Tick completed"),
      line(4, "warn", "World save delayed"),
      line(5, "WARNING", "Plugin response delayed"),
      line(6, "ERROR", "World save failed"),
      line(7, "fatal", "Plugin failed to load"),
    ];
    await page.route("**/api/console", (route) =>
      route.fulfill({ json: { lines } }),
    );
    await page.addInitScript(
      (id) => localStorage.setItem("mc-panel.active-server", id),
      serverId,
    );
    await page.goto("/#console");
    const output = page.getByRole("log");
    const messages = output.locator(".log-message");
    await expect(messages).toHaveCount(7);
    const filterToggle = page.getByRole("button", {
      name: "Filter console levels",
      exact: true,
    });
    await filterToggle.click();
    await expect(filterToggle).toHaveAttribute("aria-expanded", "true");
    const filters = page.getByRole("group", { name: "Console log level" });
    const chooseLevel = (name: string) =>
      filters.getByRole("button", { name, exact: true }).click();
    await chooseLevel("ERROR");
    await expect(messages).toHaveText([
      "World save failed",
      "Plugin failed to load",
    ]);
    await chooseLevel("INFO");
    await expect(messages).toHaveText([
      "Server ready",
      "World saved",
      "Tick completed",
    ]);
    await chooseLevel("WARNING");
    await expect(messages).toHaveText([
      "World save delayed",
      "Plugin response delayed",
    ]);
    await filterToggle.click();
    await expect(filters).toHaveCount(0);
    await expect(filterToggle).toHaveClass(/selected/);
    lines = [...lines, line(8, "warn", "World overload warning")];
    await expect(messages).toHaveCount(3);
    await page.getByRole("button", { name: "Search console logs" }).click();
    await page
      .getByRole("textbox", { name: "Filter console logs" })
      .fill("World");
    await expect(messages).toHaveText([
      "World save delayed",
      "World overload warning",
    ]);
    await page
      .getByRole("textbox", { name: "Filter console logs" })
      .fill("missing");
    await expect(output).toContainText("No logs match your filters.");
    await page.getByRole("button", { name: "Close log search" }).click();
    await expect(messages).toHaveCount(3);
    await filterToggle.click();
    await expect(
      filters.getByRole("button", { name: "WARNING", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: testInfo.outputPath(`console-filters-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Clear console view", exact: true })
      .click();
    await expect(messages).toHaveCount(0);
    await chooseLevel("All logs");
    await expect(messages).toHaveCount(0);
    lines = [...lines, line(9, "info", "New console output")];
    await expect(messages).toHaveText(["New console output"]);
  });
}

for (const width of [1348, 390]) {
  test(`a stopping server offers a confirmed Force Stop and recovers at ${width}px`, async ({
    page,
    request,
    serverId,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const seed = await (
      await request.get("/api/server", { headers: { "X-Server-Id": serverId } })
    ).json();
    let status = "running";
    const actions: Record<string, unknown>[] = [];
    let finishForce!: () => void;
    const forceGate = new Promise<void>((resolve) => {
      finishForce = resolve;
    });
    await page.route("**/api/server", (route) =>
      route.fulfill({ json: { ...seed, status } }),
    );
    await page.route("**/api/server/power", async (route) => {
      const body = route.request().postDataJSON();
      actions.push(body);
      if (body.action === "force-stop") {
        await forceGate;
        status = "offline";
      } else status = "stopping";
      await route.fulfill({ json: { status } });
    });
    await page.addInitScript(
      (id) => localStorage.setItem("mc-panel.active-server", id),
      serverId,
    );
    await page.goto("/#console");
    const consolePower = page.locator(".server-power");
    const sidebarPower = page.locator(".sidebar-power");
    await expect(consolePower.getByRole("button")).toHaveCount(3);
    await expect(
      sidebarPower.getByRole("button", { includeHidden: true }),
    ).toHaveCount(3);
    for (const name of ["Start", "Restart", "Stop"])
      await expect(
        consolePower.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    await consolePower
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Stop server", exact: true })
      .click();
    const force = consolePower.getByRole("button", {
      name: "Force Stop",
      exact: true,
    });
    const sidebarForce = sidebarPower.getByRole("button", {
      name: "Force Stop",
      exact: true,
      includeHidden: true,
    });
    await expect(force).toBeEnabled();
    await expect(sidebarForce).toBeEnabled();
    await expect(
      page
        .locator(".server-power")
        .getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    await expect(
      page
        .locator(".server-power")
        .getByRole("button", { name: "Restart", exact: true }),
    ).toBeDisabled();
    await expect(
      sidebarPower.getByRole("button", {
        name: "Start",
        exact: true,
        includeHidden: true,
      }),
    ).toBeDisabled();
    await expect(
      sidebarPower.getByRole("button", {
        name: "Restart",
        exact: true,
        includeHidden: true,
      }),
    ).toBeDisabled();
    expect(actions).toEqual([{ action: "stop" }]);
    await force.click();
    let dialog = page.getByRole("dialog", { name: "Force stop your server?" });
    await expect(dialog).toContainText(
      "Unsaved progress may be lost or world files damaged",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(actions).toEqual([{ action: "stop" }]);
    if (width < 768)
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    await sidebarForce.click();
    dialog = page.getByRole("dialog", { name: "Force stop your server?" });
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await dialog
      .getByRole("button", { name: "Force stop server", exact: true })
      .click();
    await expect(force).toBeDisabled();
    await expect(sidebarForce).toBeDisabled();
    await expect
      .poll(() => actions)
      .toEqual([{ action: "stop" }, { action: "force-stop", confirmed: true }]);
    finishForce();
    await expect(
      page
        .locator(".server-power")
        .getByRole("button", { name: "Start", exact: true }),
    ).toBeEnabled();
    await expect(
      page
        .locator(".server-power")
        .getByRole("button", { name: "Stop", exact: true }),
    ).toBeDisabled();
    await expect(
      sidebarPower.getByRole("button", {
        name: "Start",
        exact: true,
        includeHidden: true,
      }),
    ).toBeEnabled();
    await expect(
      sidebarPower.getByRole("button", {
        name: "Stop",
        exact: true,
        includeHidden: true,
      }),
    ).toBeDisabled();
    if (width < 768)
      await page.getByRole("link", { name: "Console", exact: true }).click();
    await expect(
      consolePower.getByRole("button", { name: "Start", exact: true }),
    ).toBeVisible();
    expect(actions).toHaveLength(2);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}

for (const width of [1348, 390]) {
  test(`sidebar and Console power controls share the selected server at ${width}px`, async ({
    page,
    request,
    serverId,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29450;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const created = await createProcessServer(request, {
      data: { name: "Sidebar power target", mode: "live", port },
    });
    expect(created.status()).toBe(201);
    const { server: target } = await created.json();
    try {
      await stopTestServer(request, target.id);
      await page.addInitScript(
        (id) => localStorage.setItem("mc-panel.active-server", id),
        serverId,
      );
      const actions: { id: string; action: string }[] = [];
      page.on("request", (req) => {
        if (
          new URL(req.url()).pathname === "/api/server/power" &&
          req.method() === "POST"
        )
          actions.push({
            id: req.headers()["x-server-id"],
            action: req.postDataJSON().action,
          });
      });
      await page.goto("/#properties");
      await expect(
        page.getByRole("heading", { name: "Properties", exact: true }),
      ).toBeVisible();
      const sidebar = page.locator(".sidebar");
      const openSidebar = async () => {
        if (
          width < 768 &&
          !(await sidebar.evaluate((el) => el.classList.contains("is-open")))
        )
          await page
            .getByRole("button", { name: "Open navigation", exact: true })
            .click();
      };
      await openSidebar();
      const start = sidebar.getByRole("button", {
        name: "Start",
        exact: true,
        includeHidden: true,
      });
      const restart = sidebar.getByRole("button", {
        name: "Restart",
        exact: true,
        includeHidden: true,
      });
      const stop = sidebar.getByRole("button", {
        name: "Stop",
        exact: true,
        includeHidden: true,
      });
      await expect(start).toBeDisabled();
      await expect(stop).toBeEnabled();
      await selectServer(page, target.id);
      await openSidebar();
      await expect(start).toBeEnabled();
      await expect(restart).toBeDisabled();
      await expect(stop).toBeDisabled();
      await start.click();
      await expect(stop).toBeEnabled();
      await page.getByRole("link", { name: "Console", exact: true }).click();
      const consolePower = page.locator(".server-power");
      const consoleStart = consolePower.getByRole("button", {
        name: "Start",
        exact: true,
      });
      const consoleRestart = consolePower.getByRole("button", {
        name: "Restart",
        exact: true,
      });
      const consoleStop = consolePower.getByRole("button", {
        name: "Stop",
        exact: true,
      });
      await expect(consoleStart).toBeDisabled();
      await expect(consoleStop).toBeEnabled();
      await consoleRestart.click();
      const restartDialog = page.getByRole("dialog", {
        name: "Restart your server?",
        exact: true,
      });
      await restartDialog
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      expect(actions).toEqual([{ id: target.id, action: "start" }]);
      await consoleRestart.click();
      await restartDialog
        .getByRole("button", { name: "Restart server", exact: true })
        .click();
      await expect(consoleStop).toBeEnabled();
      await openSidebar();
      await expect(stop).toBeEnabled();
      await stop.click();
      await page
        .getByRole("dialog", { name: "Stop your server?", exact: true })
        .getByRole("button", { name: "Stop server", exact: true })
        .click();
      await expect(start).toBeEnabled();
      await expect(consoleStart).toBeEnabled();
      await expect(consoleStop).toBeDisabled();
      expect(actions).toEqual([
        { id: target.id, action: "start" },
        { id: target.id, action: "restart" },
        { id: target.id, action: "stop" },
      ]);
      expect(
        (
          await (
            await request.get("/api/server", {
              headers: { "X-Server-Id": serverId },
            })
          ).json()
        ).status,
      ).toBe("running");
      await expect(page).toHaveURL(/#console$/);
      if (width < 768) await expect(sidebar).toHaveClass(/is-open/);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    } finally {
      await removeTestServer(request, target.id);
    }
  });
}

for (const stopSource of ["power", "console"] as const) {
  test(`Force Stop recovers from a hung ${stopSource} Stop request and retries failed termination`, async ({
    page,
    request,
    serverId,
  }) => {
    const seed = await (
      await request.get("/api/server", { headers: { "X-Server-Id": serverId } })
    ).json();
    let status = "running",
      forceAttempts = 0;
    let finishStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    await page.route("**/api/server", (route) =>
      route.fulfill({ json: { ...seed, status } }),
    );
    await page.route("**/api/console/command", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ command: "stop" });
      status = "stopping";
      await stopGate;
      await route.fulfill({
        status: 503,
        json: { error: "Late command failure" },
      });
    });
    await page.route("**/api/server/power", async (route) => {
      const { action, confirmed } = route.request().postDataJSON();
      if (action === "stop") {
        status = "stopping";
        await stopGate;
        await route.fulfill({ json: { status: "stopping" } });
      } else {
        expect(action).toBe("force-stop");
        expect(confirmed).toBe(true);
        if (++forceAttempts === 1) {
          await route.fulfill({
            status: 503,
            json: { error: "Could not terminate the server. Try again." },
          });
        } else {
          status = "offline";
          await route.fulfill({ json: { status } });
        }
      }
    });
    await page.addInitScript(
      (id) => localStorage.setItem("mc-panel.active-server", id),
      serverId,
    );
    await page.goto("/#console");
    if (stopSource === "console") {
      const command = page.getByRole("textbox", {
        name: "Server command",
        exact: true,
      });
      await command.fill("stop");
      await command.press("Enter");
    } else {
      await page
        .locator(".server-power")
        .getByRole("button", { name: "Stop", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Stop server", exact: true })
        .click();
    }
    const force = page
      .locator(".server-power")
      .getByRole("button", { name: "Force Stop", exact: true });
    try {
      await expect(force).toBeEnabled();
      await force.click();
      await page
        .getByRole("button", { name: "Force stop server", exact: true })
        .click();
      await expect(
        page.getByText("Could not terminate the server. Try again.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(force).toBeEnabled();
      await force.click();
      await page
        .getByRole("button", { name: "Force stop server", exact: true })
        .click();
      await expect(
        page
          .locator(".server-power")
          .getByRole("button", { name: "Start", exact: true }),
      ).toBeEnabled();
      const stopResponse = page.waitForResponse((response) =>
        response
          .url()
          .endsWith(
            stopSource === "console"
              ? "/api/console/command"
              : "/api/server/power",
          ),
      );
      finishStop();
      await stopResponse;
      await expect(
        page.getByText("Server force stop requested.", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Late command failure", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page
          .locator(".server-power")
          .getByRole("button", { name: "Start", exact: true }),
      ).toBeEnabled();
      expect(forceAttempts).toBe(2);
    } finally {
      finishStop();
    }
  });
}

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
  await expect(toggle).toHaveAttribute(
    "title",
    "Send messages to every player without typing say",
  );
  await expect(toggle.locator("svg")).toHaveCount(1);
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
  await expect(page.getByRole("log")).toContainText("The time is 6000.");
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
      ".console-heading p:not(.eyebrow)",
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
