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
    ])
      expect(
        (
          await request.post("/api/files", {
            headers,
            data: { name, type: "file", content },
          })
        ).status(),
      ).toBe(201);
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
  await expect(
    row.getByRole("button", { name: "Ban History_Player" }),
  ).toBeVisible();
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
