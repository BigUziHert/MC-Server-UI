import { test as base, expect, type Page } from "@playwright/test";

const profile = {
  name: "History_Player",
  uuid: "12345678-1234-1234-1234-123456789abc",
};
const banned = {
  name: "Banned_Player",
  uuid: "22345678-1234-1234-1234-123456789abc",
  reason: "Existing server ban",
};
const test = base.extend<{ server: { id: string; other: string } }>({
  server: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29400;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const created = await request.post("/api/servers", {
      data: { name: "Player history fixture", mode: "demo", port },
    });
    expect(created.status()).toBe(201);
    const { server } = await created.json();
    const headers = { "X-Server-Id": server.id };
    for (const [name, content] of [
      [
        "usercache.json",
        JSON.stringify([
          { ...profile, expiresOn: "2099-01-01 00:00:00 +0000" },
        ]),
      ],
      ["banned-players.json", JSON.stringify([banned])],
      [
        "whitelist.json",
        JSON.stringify([
          {
            name: "White_Player",
            uuid: "42345678-1234-1234-1234-123456789abc",
          },
        ]),
      ],
      ["server.properties", "white-list=false\nmax-players=20\n"],
    ]) {
      const added = await request.post("/api/files", {
        headers,
        data: { name, type: "file", content },
      });
      if (added.status() === 409)
        expect(
          (
            await request.put("/api/files/content", {
              headers,
              data: { path: name, content },
            })
          ).status(),
        ).toBe(200);
      else expect(added.status()).toBe(201);
    }
    if (
      (await (await request.get("/api/server", { headers })).json()).status !==
      "running"
    ) {
      expect(
        (
          await request.post("/api/server/power", {
            headers,
            data: { action: "start" },
          })
        ).ok(),
      ).toBe(true);
      await expect
        .poll(
          async () =>
            (await (await request.get("/api/server", { headers })).json())
              .status,
        )
        .toBe("running");
    }
    try {
      await use({ id: server.id, other: fleet.defaultServerId });
    } finally {
      const current = await (
        await request.get("/api/server", { headers })
      ).json();
      if (current.status !== "offline") {
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
              (await (await request.get("/api/server", { headers })).json())
                .status,
          )
          .toBe("offline");
      }
      expect((await request.delete(`/api/servers/${server.id}`)).ok()).toBe(
        true,
      );
    }
  },
});

async function open(page: Page, id: string) {
  await page.addInitScript(
    (value) => localStorage.setItem("mc-panel.active-server", value),
    id,
  );
  await page.route("https://mc-heads.net/**", (route) => route.abort());
  await page.goto("/#players");
  await expect(
    page.getByRole("heading", { name: "Player history", exact: true }),
  ).toBeVisible();
}

test("known profiles show heads and unknown login dates; demo ban/unban persist without changing Minecraft files or another server", async ({
  page,
  request,
  server,
}, info) => {
  await open(page, server.id);
  const row = page.getByRole("listitem", {
    name: "Player History_Player",
    exact: true,
  });
  await expect(row).toContainText("Offline");
  await expect(row).toContainText("Login time unknown");
  await expect(
    row.getByRole("img", { name: /History_Player's Minecraft head/ }),
  ).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Kick History_Player" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "Operators", exact: true }),
  ).toBeVisible();
  await row.getByRole("button", { name: "Ban History_Player" }).click();
  let dialog = page.getByRole("dialog", { name: "Ban player?", exact: true });
  await expect(dialog).toContainText("This action is simulated");
  await dialog
    .getByLabel("Reason (optional)")
    .fill("Browser fixture moderation");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Ban History_Player" }),
  ).toBeVisible();
  await row.getByRole("button", { name: "Ban History_Player" }).click();
  await dialog
    .getByLabel("Reason (optional)")
    .fill("Browser fixture moderation");
  await dialog.getByRole("button", { name: "Ban player", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toContainText("Banned (simulated)");
  await expect(row).toContainText("Browser fixture moderation");
  await page.reload();
  await expect(
    row.getByRole("button", { name: "Unban History_Player" }),
  ).toBeVisible();
  const headers = { "X-Server-Id": server.id };
  const bans = await (
    await request.get("/api/files/content?path=banned-players.json", {
      headers,
    })
  ).json();
  expect(JSON.parse(bans.content)).toEqual([banned]);
  const other = await (
    await request.get("/api/players", {
      headers: { "X-Server-Id": server.other },
    })
  ).json();
  expect(
    other.history.some(
      (player: { name: string }) => player.name === profile.name,
    ),
  ).toBe(false);
  await page.screenshot({
    path: info.outputPath("player-history-desktop.png"),
    fullPage: true,
  });
  await row.getByRole("button", { name: "Unban History_Player" }).click();
  dialog = page.getByRole("dialog", { name: "Unban player?", exact: true });
  await expect(dialog.getByLabel("Reason (optional)")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Unban player", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    row.getByRole("button", { name: "Ban History_Player" }),
  ).toBeEnabled();
  await page.getByLabel("Search player history").fill("Banned_Player");
  await expect(row).toHaveCount(0);
  await expect(
    page.getByRole("listitem", { name: "Player Banned_Player", exact: true }),
  ).toBeVisible();
});

test("mobile moderation confirms a single-line reason, recovers from command errors, and waits for real disconnect confirmation", async ({
  page,
  server,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/players", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        mode: "live",
        status: "running",
        history: [
          {
            ...profile,
            source: "observed",
            online: true,
            banned: false,
            firstSeen: "2026-09-12T09:00:00Z",
            lastSeen: "2026-09-12T10:00:00Z",
          },
        ],
      },
    });
  });
  let requests = 0;
  let command: unknown;
  await page.route("**/api/players/kick", async (route) => {
    command = route.request().postDataJSON();
    requests++;
    await route.fulfill({
      status: requests === 1 ? 409 : 200,
      json:
        requests === 1
          ? { error: "The server is not ready to receive commands." }
          : {
              simulated: false,
              message:
                "Requested kick History_Player Browser reason. Check Console for confirmation.",
            },
    });
  });
  await open(page, server.id);
  const row = page.getByRole("listitem", {
    name: "Player History_Player",
    exact: true,
  });
  await expect(row).toContainText("Online");
  await row.getByRole("button", { name: "Kick History_Player" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Kick player?",
    exact: true,
  });
  await dialog.getByLabel("Reason (optional)").fill("Browser reason");
  await expect(dialog.getByLabel("Reason (optional)")).toHaveAttribute(
    "maxlength",
    "200",
  );
  await dialog
    .getByRole("button", { name: "Kick player", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("not ready");
  await page.screenshot({
    path: info.outputPath("player-moderation-mobile.png"),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await dialog
    .getByRole("button", { name: "Kick player", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(command).toEqual({ ...profile, reason: "Browser reason" });
  await expect(row).toContainText("Online");
  await expect(
    page.getByText("Player command requested", { exact: true }),
  ).toBeVisible();
});

test("offline and unreadable ban states retain history but disable unsafe player actions", async ({
  page,
  server,
}) => {
  let offline = true;
  await page.route("**/api/players", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        status: offline ? "offline" : "running",
        bansAvailable: false,
        warnings: [
          "banned-players.json could not be read. Check its JSON and file permissions, then refresh.",
        ],
        history: [
          {
            ...profile,
            source: "cache",
            online: false,
            banned: null,
            firstSeen: null,
            lastSeen: null,
          },
        ],
      },
    });
  });
  await open(page, server.id);
  const row = page.getByRole("listitem", {
    name: "Player History_Player",
    exact: true,
  });
  await expect(row).toContainText("Ban status unavailable");
  await expect(
    row.getByRole("button", { name: "Ban History_Player" }),
  ).toBeDisabled();
  await expect(
    row.getByRole("button", {
      name: "Grant OP for History_Player",
      exact: true,
    }),
  ).toBeDisabled();
  offline = false;
  await page.getByRole("button", { name: "Refresh player history" }).click();
  await expect(
    row.getByRole("button", {
      name: "Grant OP for History_Player",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    row.getByRole("button", { name: "Ban History_Player" }),
  ).toBeDisabled();
  await expect(
    page.getByText(/banned-players.json could not be read/),
  ).toBeVisible();
});

test("Grant OP belongs to a known-player row and guards the selected identity and existing operator", async ({
  page,
  request,
  server,
}, info) => {
  await open(page, server.id);
  await expect(page.locator(".page-heading").getByRole("button")).toHaveCount(
    0,
  );
  await expect(page.locator(".page-heading p")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Grant your first OP" }),
  ).toHaveCount(0);
  const row = page.getByRole("listitem", {
    name: "Player History_Player",
    exact: true,
  });
  const grant = row.getByRole("button", {
    name: "Grant OP for History_Player",
    exact: true,
  });
  await grant.click();
  const dialog = page.getByRole("dialog", {
    name: "Grant operator permissions",
    exact: true,
  });
  await expect(
    dialog.getByLabel("Minecraft username", { exact: true }),
  ).toHaveValue(profile.name);
  await expect(
    dialog.getByLabel("Minecraft username", { exact: true }),
  ).toHaveAttribute("readonly", "");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const headers = { "X-Server-Id": server.id };
  expect(
    (await (await request.get("/api/players", { headers })).json()).operators,
  ).toEqual([]);
  await grant.click();
  await dialog.getByRole("button", { name: "Grant OP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(grant).toBeDisabled();
  await expect(grant).toHaveText("Already OP");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: info.outputPath("player-row-op-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page
    .getByRole("button", { name: "Remove OP for History_Player", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Remove operator permissions?", exact: true })
    .getByRole("button", { name: "Remove OP", exact: true })
    .click();
  await expect(grant).toBeEnabled();
});

test("live row OP preserves pending state until Minecraft saves the operator record", async ({
  page,
  server,
}) => {
  let confirmed = false;
  await page.route("**/api/players", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        mode: "live",
        status: "running",
        operators: confirmed ? [{ ...profile, level: 4 }] : [],
      },
    });
  });
  let command: unknown;
  await page.route("**/api/players/op", async (route) => {
    command = route.request().postDataJSON();
    await route.fulfill({
      json: {
        simulated: false,
        message: "Requested op History_Player. Check Console for confirmation.",
      },
    });
  });
  await open(page, server.id);
  const grant = page.getByRole("button", {
    name: "Grant OP for History_Player",
    exact: true,
  });
  await grant.click();
  const dialog = page.getByRole("dialog", {
    name: "Grant operator permissions",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Grant OP", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(command).toEqual(profile);
  await expect(
    page.getByText("Player command requested", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Remove OP for History_Player",
      exact: true,
    }),
  ).toHaveCount(0);
  confirmed = true;
  await page
    .getByRole("button", { name: "Refresh operators", exact: true })
    .click();
  await expect(grant).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Remove OP for History_Player",
      exact: true,
    }),
  ).toBeVisible();
});

test("four compact rosters expose online actions and fit desktop and mobile layouts", async ({
  page,
  server,
}, info) => {
  const longPlayer = {
    ...profile,
    name: "Long_Player_1234",
    online: true,
    banned: false,
    firstSeen: "2026-09-13T10:00:00Z",
    lastSeen: "2026-09-13T10:00:00Z",
    source: "observed",
  };
  await page.route("**/api/players", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        online: [longPlayer],
        maxPlayers: 20,
        history: [
          longPlayer,
          ...data.history.filter(
            (player: { name: string }) => player.name !== profile.name,
          ),
        ],
        operators: [{ ...longPlayer, level: 4 }],
      },
    });
  });
  let operatorRequest: unknown;
  await page.route("**/api/players/deop", async (route) => {
    operatorRequest = route.request().postDataJSON();
    await route.fulfill({
      status: 409,
      json: {
        error: "This player's identity changed. Refresh the operator list.",
      },
    });
  });
  await page.setViewportSize({ width: 1823, height: 1216 });
  await open(page, server.id);
  const online = page.getByRole("region", {
    name: "Online Players",
    exact: true,
  });
  const banList = page.getByRole("region", {
    name: "Banned Players",
    exact: true,
  });
  const ops = page.getByRole("region", { name: "Operators", exact: true });
  const whitelist = page.getByRole("region", {
    name: "Whitelist",
    exact: true,
  });
  await expect(page.locator(".players-online-banner")).toContainText(
    "1 / 20 players online",
  );
  await expect(
    online.getByRole("button", {
      name: `Kick online player ${longPlayer.name}`,
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    online.getByRole("button", {
      name: `Ban online player ${longPlayer.name}`,
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    online.getByRole("button", {
      name: `Remove OP for online player ${longPlayer.name}`,
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    online.getByRole("button", {
      name: `Add online player ${longPlayer.name} to whitelist`,
      exact: true,
    }),
  ).toBeEnabled();
  const boxes = await Promise.all(
    [online, banList, ops, whitelist].map((panel) => panel.boundingBox()),
  );
  expect(new Set(boxes.map((box) => Math.round(box!.y))).size).toBe(1);
  expect(boxes.every((box) => Math.abs(box!.width - boxes[0]!.width) < 1)).toBe(
    true,
  );
  const visibleName = online.locator(".players-roster-row > strong");
  expect(
    await visibleName.evaluate((element) => element.clientWidth),
  ).toBeGreaterThan(80);
  await page.screenshot({
    path: info.outputPath("players-rosters-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await online
    .getByRole("button", {
      name: `Remove OP for online player ${longPlayer.name}`,
      exact: true,
    })
    .click();
  const remove = page.getByRole("dialog", {
    name: "Remove operator permissions?",
    exact: true,
  });
  await remove.getByRole("button", { name: "Remove OP", exact: true }).click();
  await expect(remove.getByRole("alert")).toContainText("identity changed");
  expect(operatorRequest).toEqual({
    name: longPlayer.name,
    uuid: longPlayer.uuid,
  });
  await remove.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  expect(
    await visibleName.evaluate((element) => element.clientWidth),
  ).toBeGreaterThan(80);
  await page.screenshot({
    path: info.outputPath("players-rosters-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("whitelist membership and enable switch confirm changes and preserve demo source files", async ({
  page,
  request,
  server,
}) => {
  await open(page, server.id);
  const roster = page.getByRole("region", { name: "Whitelist", exact: true });
  const toggle = roster.getByRole("switch", {
    name: "Enable whitelist",
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await roster
    .getByRole("button", { name: "Add player to whitelist", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Add player to whitelist",
    exact: true,
  });
  await dialog
    .getByLabel("Minecraft username", { exact: true })
    .fill("New_White_Player");
  await dialog
    .getByRole("button", { name: "Add to whitelist", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    roster.getByText("New_White_Player", { exact: true }),
  ).toBeVisible();
  await toggle.click();
  dialog = page.getByRole("dialog", { name: "Enable whitelist?", exact: true });
  await expect(dialog).toContainText("Only whitelisted players");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await dialog
    .getByRole("button", { name: "Enable whitelist", exact: true })
    .click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  const headers = { "X-Server-Id": server.id };
  const source = await (
    await request.get("/api/files/content?path=whitelist.json", { headers })
  ).json();
  expect(JSON.parse(source.content)).toEqual([
    { name: "White_Player", uuid: "42345678-1234-1234-1234-123456789abc" },
  ]);
  const properties = await (
    await request.get("/api/files/content?path=server.properties", { headers })
  ).json();
  expect(properties.content).toContain("white-list=false");
  await roster
    .getByRole("button", {
      name: "Remove saved whitelist player New_White_Player",
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Remove player from whitelist?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Remove from whitelist", exact: true })
    .click();
  await expect(
    roster.getByText("New_White_Player", { exact: true }),
  ).toHaveCount(0);
  await toggle.click();
  dialog = page.getByRole("dialog", {
    name: "Disable whitelist?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Disable whitelist", exact: true })
    .click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("live whitelist requests wait for readback and unavailable settings disable the switch", async ({
  page,
  server,
}) => {
  let enabled = false;
  let available = true;
  await page.route("**/api/players", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        mode: "live",
        whitelistEnabled: available ? enabled : null,
        whitelistSettingsAvailable: available,
        whitelistAvailable: available,
        warnings: available
          ? []
          : ["whitelist.json could not be read. Fix the file and refresh."],
      },
    });
  });
  let payload: unknown;
  await page.route("**/api/players/whitelist/state", async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      json: {
        simulated: false,
        message: "Requested whitelist on. Check Console for confirmation.",
      },
    });
  });
  await open(page, server.id);
  const toggle = page.getByRole("switch", {
    name: "Enable whitelist",
    exact: true,
  });
  await toggle.click();
  const dialog = page.getByRole("dialog", {
    name: "Enable whitelist?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Enable whitelist", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(payload).toEqual({ enabled: true });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  enabled = true;
  await page
    .getByRole("button", { name: "Refresh players", exact: true })
    .click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  available = false;
  await page
    .getByRole("button", { name: "Refresh players", exact: true })
    .click();
  await expect(toggle).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Add player to whitelist", exact: true }),
  ).toBeDisabled();
});

const pagedLists = [
  "Online Players",
  "Banned Players",
  "Operators",
  "Whitelist",
  "Player history",
];

function pagingProfiles(count: number, prefix = "Paging") {
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}_${String(index + 1).padStart(3, "0")}`,
    uuid: `12345678-1234-1234-1234-${String(index + 1).padStart(12, "0")}`,
    source: "observed",
    online: true,
    banned: false,
    firstSeen: "2026-09-13T10:00:00Z",
    lastSeen: "2026-09-13T10:00:00Z",
  }));
}

function pagingResponse(players: ReturnType<typeof pagingProfiles>) {
  return {
    mode: "demo",
    status: "running",
    maxPlayers: 150,
    online: players,
    banned: players.map((player) => ({ ...player, banned: true })),
    operators: players.map((player) => ({ ...player, level: 4 })),
    whitelist: players,
    history: players,
    whitelistEnabled: false,
    whitelistAvailable: true,
    whitelistSettingsAvailable: true,
    bansAvailable: true,
    warnings: [],
  };
}

test("all five player lists page independently, remember row counts, and reset searches and server changes", async ({
  page,
  server,
}) => {
  await page.setViewportSize({ width: 1823, height: 1216 });
  await page.route("**/api/players", (route) =>
    route.fulfill({
      json: pagingResponse(
        pagingProfiles(
          13,
          route.request().headers()["x-server-id"] === server.id
            ? "Paging"
            : "Other",
        ),
      ),
    }),
  );
  await open(page, server.id);
  for (const title of pagedLists) {
    const region = page.getByRole("region", { name: title, exact: true });
    const size = region.getByRole("combobox", {
      name: `${title} rows per page`,
      exact: true,
    });
    const status = region.getByRole("status", {
      name: `${title} page`,
      exact: true,
    });
    const next = region.getByRole("button", {
      name: `${title} next page`,
      exact: true,
    });
    const previous = region.getByRole("button", {
      name: `${title} previous page`,
      exact: true,
    });
    await expect(size).toHaveValue("5");
    await expect(size.locator("option")).toHaveText([
      "5",
      "10",
      "25",
      "50",
      "75",
      "100",
    ]);
    await expect(region.getByRole("listitem")).toHaveCount(5);
    await expect(status).toHaveText("Page 1 of 3");
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(status).toHaveText("Page 2 of 3");
    await expect(region.getByRole("listitem").first()).toContainText(
      "Paging_006",
    );
    await next.click();
    await expect(region.getByRole("listitem")).toHaveCount(3);
    await expect(status).toHaveText("Page 3 of 3");
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(region.getByRole("listitem").first()).toContainText(
      "Paging_006",
    );
  }

  for (const [title, search] of [
    ["Operators", "Search operators"],
    ["Player history", "Search player history"],
  ]) {
    const region = page.getByRole("region", { name: title, exact: true });
    await page.getByLabel(search, { exact: true }).fill("Paging_013");
    await expect(region.getByRole("listitem")).toHaveCount(1);
    await expect(
      region.getByRole("status", { name: `${title} page`, exact: true }),
    ).toHaveText("Page 1 of 1");
    await page.getByLabel(search, { exact: true }).fill("");
    await expect(region.getByRole("listitem").first()).toContainText(
      "Paging_001",
    );
    await expect(
      region.getByRole("status", { name: `${title} page`, exact: true }),
    ).toHaveText("Page 1 of 3");
  }
  await page
    .getByRole("combobox", {
      name: "Online Players rows per page",
      exact: true,
    })
    .selectOption("10");
  await page
    .getByRole("combobox", { name: "Whitelist rows per page", exact: true })
    .selectOption("25");
  await expect(
    page
      .getByRole("region", { name: "Online Players", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(10);
  await expect(
    page
      .getByRole("region", { name: "Whitelist", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(13);
  await page.reload();
  for (const title of pagedLists) {
    const selected =
      title === "Online Players" ? "10" : title === "Whitelist" ? "25" : "5";
    await expect(
      page.getByRole("combobox", {
        name: `${title} rows per page`,
        exact: true,
      }),
    ).toHaveValue(selected);
  }
  await page
    .getByRole("button", { name: "Operators next page", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Player history next page", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Switch server", exact: true })
    .selectOption(server.other);
  for (const title of pagedLists) {
    const region = page.getByRole("region", { name: title, exact: true });
    await expect(region.getByRole("listitem").first()).toContainText(
      "Other_001",
    );
    await expect(
      region.getByRole("button", {
        name: `${title} previous page`,
        exact: true,
      }),
    ).toBeDisabled();
    await expect(region.getByText(/Paging_/)).toHaveCount(0);
  }
});

test("removing the last player on a page clamps the roster and refreshed smaller lists keep valid pages", async ({
  page,
  server,
}) => {
  let players = pagingProfiles(11);
  let whitelisted = [...players];
  let removed: unknown;
  await page.route("**/api/players", (route) =>
    route.fulfill({
      json: { ...pagingResponse(players), whitelist: whitelisted },
    }),
  );
  await page.route("**/api/players/whitelist/remove", async (route) => {
    removed = route.request().postDataJSON();
    whitelisted = whitelisted.filter(
      (player) => player.name !== route.request().postDataJSON().name,
    );
    await route.fulfill({
      json: { simulated: true, message: "Demo whitelist entry removed." },
    });
  });
  await open(page, server.id);
  for (const title of pagedLists) {
    const next = page.getByRole("button", {
      name: `${title} next page`,
      exact: true,
    });
    await next.click();
    await next.click();
    await expect(
      page.getByRole("status", { name: `${title} page`, exact: true }),
    ).toHaveText("Page 3 of 3");
  }
  await page
    .getByRole("button", {
      name: "Remove saved whitelist player Paging_011",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Remove player from whitelist?",
    exact: true,
  });
  await expect(dialog).toContainText("Paging_011");
  await dialog
    .getByRole("button", { name: "Remove from whitelist", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(removed).toEqual({ name: players[10].name, uuid: players[10].uuid });
  await expect(
    page.getByRole("status", { name: "Whitelist page", exact: true }),
  ).toHaveText("Page 2 of 2");
  await expect(
    page
      .getByRole("region", { name: "Whitelist", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(5);

  players = players.slice(0, 6);
  whitelisted = whitelisted.slice(0, 6);
  await page
    .getByRole("button", { name: "Refresh players", exact: true })
    .click();
  for (const title of pagedLists) {
    const region = page.getByRole("region", { name: title, exact: true });
    await expect(
      region.getByRole("status", { name: `${title} page`, exact: true }),
    ).toHaveText("Page 2 of 2");
    await expect(region.getByRole("listitem")).toHaveCount(1);
    await expect(region.getByRole("listitem")).toContainText("Paging_006");
  }
  players = [];
  whitelisted = [];
  await page
    .getByRole("button", { name: "Refresh players", exact: true })
    .click();
  for (const title of pagedLists) {
    const region = page.getByRole("region", { name: title, exact: true });
    await expect(region.getByRole("listitem")).toHaveCount(0);
    await expect(
      region.getByRole("status", { name: `${title} page`, exact: true }),
    ).toHaveText("Page 1 of 1");
    await expect(
      region.getByRole("button", {
        name: `${title} previous page`,
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      region.getByRole("button", { name: `${title} next page`, exact: true }),
    ).toBeDisabled();
  }
});

test("large selected player pages scroll internally and keep every paging control usable on desktop and mobile", async ({
  page,
  server,
}, info) => {
  await page.route("**/api/players", (route) =>
    route.fulfill({ json: pagingResponse(pagingProfiles(101)) }),
  );
  await page.setViewportSize({ width: 1823, height: 1216 });
  await open(page, server.id);
  for (const title of pagedLists) {
    const region = page.getByRole("region", { name: title, exact: true });
    for (const size of [10, 25, 50, 75, 100]) {
      await region
        .getByRole("combobox", { name: `${title} rows per page`, exact: true })
        .selectOption(String(size));
      await expect(region.getByRole("listitem")).toHaveCount(size);
    }
  }
  for (const viewport of [
    { width: 1823, height: 1216 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const title of pagedLists) {
      const region = page.getByRole("region", { name: title, exact: true });
      const list = region.getByRole("list", {
        name: `${title} list`,
        exact: true,
      });
      const bounds = await list.evaluate((element) => ({
        height: element.clientHeight,
        content: element.scrollHeight,
      }));
      expect(bounds.height).toBeLessThanOrEqual(
        title === "Player history" ? 540 : 320,
      );
      expect(bounds.content).toBeGreaterThan(bounds.height);
      await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await region
        .getByRole("button", { name: `${title} next page`, exact: true })
        .click();
      await expect(region.getByRole("listitem")).toHaveCount(1);
      await expect(region.getByRole("listitem")).toContainText("Paging_101");
      await region
        .getByRole("button", { name: `${title} previous page`, exact: true })
        .click();
      await expect(region.getByRole("listitem")).toHaveCount(100);
      expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(viewport.width);
    await page.screenshot({
      path: info.outputPath(`players-pagination-${viewport.width}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
});
