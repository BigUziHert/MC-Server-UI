import { test, expect } from "@playwright/test";
import {
  createProcessServer,
  stopTestServer,
  removeTestServer,
  selectServer,
} from "./server-fixtures";

test("a delayed authorization error cannot sign out a replacement account", async ({
  page,
  context,
}) => {
  const firstToken = "a".repeat(43),
    secondToken = "b".repeat(43);
  const permissions = ["server.view"];
  const member = (account: string) => ({
    role: "subuser",
    accountId: account,
    userId: account,
    email: `${account}@example.test`,
    serverId: "shared-server",
    permissions,
    hostPermissions: [],
  });
  const server = {
    id: "shared-server",
    name: "Shared fixture server",
    status: "offline",
    players: [],
    address: "play.example.test:25565",
    accessPermissions: permissions,
  };
  // Fetch resolves when the headers arrive, before its error body finishes.
  // Keep that real response body pending across another tab's account change.
  await page.addInitScript((token) => {
    localStorage.setItem("mc-panel.session.v1", token);
    const original = window.fetch.bind(window);
    let delayed = false;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (
        !delayed &&
        response.status === 401 &&
        response.url.endsWith("/api/server")
      ) {
        delayed = true;
        const json = response.json.bind(response);
        response.json = async () => {
          (window as any).reviewErrorBodyPending = true;
          await new Promise<void>((resolve) => {
            (window as any).releaseReviewErrorBody = resolve;
          });
          const result = await json();
          (window as any).reviewErrorBodyConsumed = true;
          return result;
        };
      }
      return response;
    };
  }, firstToken);
  await context.route("**/review-account-switch", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Second tab</title>",
    }),
  );
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const second =
      route.request().headers().authorization === `Bearer ${secondToken}`;
    const reply = (json: unknown) => route.fulfill({ json });
    if (pathname === "/api/access/session")
      return reply(member(second ? "second" : "first"));
    if (pathname === "/api/servers")
      return reply({ servers: [server], defaultServerId: server.id });
    if (pathname === "/api/server") {
      if (!second)
        return route.fulfill({
          status: 401,
          json: { error: "The former session expired." },
        });
      return reply(server);
    }
    return reply({});
  });
  const other = await context.newPage();
  try {
    await page.goto("/#console");
    await expect
      .poll(() => page.evaluate(() => (window as any).reviewErrorBodyPending))
      .toBe(true);
    await other.goto("/review-account-switch");
    await other.evaluate(
      (token) => localStorage.setItem("mc-panel.session.v1", token),
      secondToken,
    );
    const account = page.getByRole("button", {
      name: "Account menu for second@example.test",
      exact: true,
    });
    await expect(account).toBeVisible();
    await page.evaluate(() => (window as any).releaseReviewErrorBody());
    await expect
      .poll(() => page.evaluate(() => (window as any).reviewErrorBodyConsumed))
      .toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(account).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("mc-panel.session.v1")),
    ).toBe(secondToken);
    await expect(page.getByLabel("Email address", { exact: true })).toHaveCount(
      0,
    );
  } finally {
    await page
      .evaluate(() => (window as any).releaseReviewErrorBody?.())
      .catch(() => {});
    await other.close();
  }
});

test("Properties drafts survive links, history and server switching; refresh explicitly discards", async ({
  page,
  request,
}) => {
  const fleet = await (await request.get("/api/servers")).json();
  const firstId = fleet.defaultServerId;
  const created = await createProcessServer(request, {
    data: { name: "Draft isolation", mode: "live", port: 29851 },
  });
  expect(created.status()).toBe(201);
  const secondId = (await created.json()).server.id;
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    firstId,
  );
  await page.route("**/api/minecraft/properties", (route) =>
    route.fulfill({
      json: {
        files: [{ name: "server.properties", path: "server.properties" }],
      },
    }),
  );
  let revision = "1";
  await page.route("**/api/minecraft/properties/file?*", (route) =>
    route.fulfill({
      json: {
        path: "server.properties",
        status: "offline",
        revision,
        fields: [
          {
            key: "motd",
            label: "Server message",
            type: "string",
            value: "Saved message",
          },
        ],
      },
    }),
  );
  try {
    await page.goto("/#properties");
    const field = page.getByRole("textbox", {
      name: "Server message",
      exact: true,
    });
    await field.fill("Important unsaved edits");
    await page.getByRole("link", { name: "Console", exact: true }).click();
    await page.goBack();
    await expect(field).toHaveValue("Important unsaved edits");
    await selectServer(page, secondId);
    await page.getByRole("link", { name: "Properties", exact: true }).click();
    await expect(field).toHaveValue("Saved message");
    await selectServer(page, firstId);
    revision = "2";
    await page.getByRole("link", { name: "Properties", exact: true }).click();
    await expect(field).toHaveValue("Important unsaved edits");
    await expect(
      page.getByRole("heading", { name: "Properties changed on the host" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Refresh properties", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Keep editing", exact: true })
      .click();
    await expect(field).toHaveValue("Important unsaved edits");
    await page
      .getByRole("button", { name: "Refresh properties", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Reload properties", exact: true })
      .click();
    await expect(field).toHaveValue("Saved message");
    await page.getByRole("link", { name: "Console", exact: true }).click();
    await page.getByRole("link", { name: "Properties", exact: true }).click();
    await expect(field).toHaveValue("Saved message");
  } finally {
    await removeTestServer(request, secondId);
  }
});

test("Properties save failures preserve drafts and retry the save rather than reload", async ({
  page,
}) => {
  await page.route("**/api/minecraft/properties", (route) =>
    route.fulfill({
      json: {
        files: [{ name: "server.properties", path: "server.properties" }],
      },
    }),
  );
  const config = {
    path: "server.properties",
    status: "offline",
    revision: "1",
    fields: [
      { key: "motd", label: "Server message", type: "string", value: "Saved" },
    ],
  };
  await page.route("**/api/minecraft/properties/file?*", (route) =>
    route.fulfill({ json: config }),
  );
  let saves = 0;
  await page.route("**/api/minecraft/properties/save", (route) =>
    ++saves === 1
      ? route.fulfill({
          status: 500,
          json: { error: "Fixture storage unavailable" },
        })
      : route.fulfill({
          json: {
            ...config,
            revision: "2",
            fields: [{ ...config.fields[0], value: "My edit" }],
            message: "Saved.",
          },
        }),
  );
  await page.goto("/#properties");
  await page.getByRole("textbox", { name: "Server message" }).fill("My edit");
  await page.getByRole("button", { name: "Save changes (1)" }).click();
  await expect(
    page.getByRole("heading", { name: "Unable to save properties" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Server message" }),
  ).toHaveValue("My edit");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  expect(saves).toBe(2);
});

for (const remainingFile of [true, false]) {
  test(`Properties preserves a missing-file draft with ${remainingFile ? "another configuration file" : "an empty catalog"}`, async ({
    page,
  }) => {
    let missing = false;
    await page.route("**/api/minecraft/properties", (route) =>
      route.fulfill({
        json: {
          files: missing
            ? remainingFile
              ? [{ name: "server.properties", path: "server.properties" }]
              : []
            : [
                { name: "server.properties", path: "server.properties" },
                { name: "bukkit.yml", path: "bukkit.yml" },
              ],
        },
      }),
    );
    await page.route("**/api/minecraft/properties/file?*", (route) => {
      const path = new URL(route.request().url()).searchParams.get("path");
      if (missing && path === "bukkit.yml")
        return route.fulfill({
          status: 404,
          json: { error: "The configuration file is missing." },
        });
      return route.fulfill({
        json: {
          path,
          status: "offline",
          revision: "1",
          fields: [
            {
              key: "fixture",
              label: "Fixture value",
              type: "string",
              value: "Saved value",
            },
          ],
        },
      });
    });
    await page.goto("/#properties");
    await page.getByRole("tab", { name: "bukkit.yml", exact: true }).click();
    const field = page.getByRole("textbox", {
      name: "Fixture value",
      exact: true,
    });
    await field.fill("Keep this missing-file edit");
    await page.getByRole("link", { name: "Console", exact: true }).click();
    missing = true;
    await page.getByRole("link", { name: "Properties", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Draft file is missing on the host" }),
    ).toBeVisible();
    await expect(field).toHaveValue("Keep this missing-file edit");
    await expect(field).toHaveAttribute("readonly", "");
    await expect(
      page.getByRole("button", { name: "Save changes (1)", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Check for file", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Unable to load properties" }),
    ).toBeVisible();
    await expect(field).toHaveValue("Keep this missing-file edit");
    await page
      .getByRole("button", { name: "Discard missing-file draft", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Keep editing", exact: true })
      .click();
    await expect(field).toHaveValue("Keep this missing-file edit");
    await page
      .getByRole("button", { name: "Discard missing-file draft", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    if (remainingFile) await expect(field).toHaveValue("Saved value");
    else
      await expect(
        page.getByRole("heading", { name: "No configuration files yet" }),
      ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Draft file is missing on the host" }),
    ).toHaveCount(0);
  });
}

for (const location of ["away", "returned", "edited"] as const) {
  test(`a Properties save finishing after navigation reconciles its draft when ${location}`, async ({
    page,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saves = 0;
    let config = {
      path: "server.properties",
      status: "offline",
      revision: "1",
      fields: [
        {
          key: "motd",
          label: "Server message",
          type: "string",
          value: "Saved",
        },
      ],
    };
    await page.route("**/api/minecraft/properties", (route) =>
      route.fulfill({
        json: {
          files: [{ name: "server.properties", path: "server.properties" }],
        },
      }),
    );
    await page.route("**/api/minecraft/properties/file?*", (route) =>
      route.fulfill({ json: config }),
    );
    await page.route("**/api/minecraft/properties/save", async (route) => {
      saves++;
      await gate;
      config = {
        ...config,
        revision: "2",
        fields: [{ ...config.fields[0], value: "Submitted edit" }],
      };
      await route.fulfill({ json: { ...config, message: "Saved." } });
    });
    try {
      await page.goto("/#properties");
      const field = page.getByRole("textbox", {
        name: "Server message",
        exact: true,
      });
      await field.fill("Submitted edit");
      await page
        .getByRole("button", { name: "Save changes (1)", exact: true })
        .click();
      await expect.poll(() => saves).toBe(1);
      await page.getByRole("link", { name: "Console", exact: true }).click();
      if (location !== "away") {
        await page
          .getByRole("link", { name: "Properties", exact: true })
          .click();
        await expect(field).toHaveValue("Submitted edit");
        if (location === "edited") await field.fill("Newer unsaved edit");
      }
      const response = page.waitForResponse("**/api/minecraft/properties/save");
      release();
      await (await response).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      if (location === "returned")
        await expect(
          page.getByRole("button", { name: "Save changes", exact: true }),
        ).toBeDisabled();
      if (location !== "away")
        await page.getByRole("link", { name: "Console", exact: true }).click();
      await page.getByRole("link", { name: "Properties", exact: true }).click();
      await expect(field).toHaveValue(
        location === "edited" ? "Newer unsaved edit" : "Submitted edit",
      );
      if (location === "edited") {
        await expect(
          page.getByRole("button", { name: "Save changes (1)", exact: true }),
        ).toBeEnabled();
        await expect(
          page.getByRole("heading", { name: "Properties changed on the host" }),
        ).toBeVisible();
      } else {
        await expect(
          page.getByRole("button", { name: "Save changes", exact: true }),
        ).toBeDisabled();
        await expect(
          page.getByRole("heading", { name: "Properties changed on the host" }),
        ).toHaveCount(0);
      }
    } finally {
      release();
    }
  });
}

test("late status and console polls cannot replace newer responses", async ({
  page,
  request,
}) => {
  const original = await (await request.get("/api/server")).json();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let statuses = 0,
    logs = 0;
  await page.route(/\/api\/server$/, async (route) => {
    const read = ++statuses;
    if (read === 1) await gate;
    await route.fulfill({
      json: { ...original, status: read === 1 ? "offline" : "running" },
    });
  });
  await page.route(/\/api\/console$/, async (route) => {
    const read = ++logs;
    if (read === 1) await gate;
    await route.fulfill({
      json: {
        lines: [
          {
            id: read === 1 ? "1" : "2",
            time: new Date().toISOString(),
            level: "info",
            message: read === 1 ? "Old response" : "Current response",
          },
        ],
      },
    });
  });
  try {
    await page.goto("/#console");
    await expect(page.locator(".server-banner .status-badge")).toHaveText(
      "running",
    );
    await expect(
      page.getByText("Current response", { exact: true }),
    ).toBeVisible();
    release();
    await page.unrouteAll({ behavior: "wait" });
    await expect(page.locator(".server-banner .status-badge")).toHaveText(
      "running",
    );
    await expect(
      page
        .getByRole("main")
        .getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    await expect(page.getByText("Old response", { exact: true })).toHaveCount(
      0,
    );
  } finally {
    release();
  }
});

test("settings conflicts retain the draft and require explicit reload before overwriting", async ({
  page,
  request,
}) => {
  const created = await createProcessServer(request, {
    data: { name: "Concurrent settings", mode: "live", port: 29852 },
  });
  expect(created.status()).toBe(201);
  const { server } = await created.json();
  await stopTestServer(request, server.id);
  const headers = { "X-Server-Id": server.id };
  try {
    await page.addInitScript(
      (id) => localStorage.setItem("mc-panel.active-server", id),
      server.id,
    );
    await page.goto("/#console");
    await page
      .getByRole("button", { name: "Rename server", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Server name", exact: true })
      .fill("My rename");
    const initial = (
      await (await request.get("/api/server/settings", { headers })).json()
    ).server;
    expect(initial.settingsRevision).toBeTruthy();
    expect(
      (
        await request.patch("/api/server/settings", {
          headers,
          data: {
            settingsRevision: initial.settingsRevision,
            motd: "Saved by computer B",
          },
        })
      ).ok(),
    ).toBeTruthy();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "Server settings changed on the host",
    );
    await expect(
      page.getByRole("textbox", { name: "Server name", exact: true }),
    ).toHaveValue("My rename");
    const latest = (
      await (await request.get("/api/server/settings", { headers })).json()
    ).server;
    expect(latest.motd).toBe("Saved by computer B");
    expect(latest.name).toBe("Concurrent settings");
    await page
      .getByRole("button", { name: "Reload and discard my edits", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Server name", exact: true }),
    ).toHaveValue("Concurrent settings");
    await page
      .getByRole("textbox", { name: "Server name", exact: true })
      .fill("Reviewed rename");
    const sent = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" &&
        request.url().endsWith(`/api/servers/${server.id}`),
    );
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    expect((await sent).postDataJSON()).toEqual({
      name: "Reviewed rename",
      settingsRevision: latest.settingsRevision,
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const final = (
      await (await request.get("/api/server/settings", { headers })).json()
    ).server;
    expect(final.motd).toBe("Saved by computer B");
    expect(final.name).toBe("Reviewed rename");
  } finally {
    await removeTestServer(request, server.id);
  }
});

test("Ctrl and Cmd K respect modal focus and resume after closing", async ({
  page,
}) => {
  await page.goto("/#console");
  const command = page.getByRole("textbox", {
    name: "Server command",
    exact: true,
  });
  await expect(command).toBeEnabled();
  const help = page.getByRole("button", {
    name: "Help and documentation",
    exact: true,
  });
  await help.click();
  const dialog = page.getByRole("dialog", { name: "Your server starts here." });
  await expect(dialog).toBeVisible();
  for (const shortcut of ["Control+k", "Meta+k"]) {
    await page.keyboard.press(shortcut);
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(help).toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(command).toBeFocused();
});

test("remote address stays unavailable until verified host details arrive", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          (window as any).copied = text;
        },
      },
    }),
  );
  const member = {
    role: "subuser",
    accountId: "loading-address",
    userId: "loading-address",
    email: "b@example.test",
    serverId: "a-server",
    permissions: ["server.view"],
  };
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: member }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      json: {
        servers: [
          {
            id: "a-server",
            name: "Server on computer A",
            status: "offline",
            address: "a.example.test:25580",
            accessPermissions: member.permissions,
          },
        ],
        defaultServerId: "a-server",
      },
    }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/server$/, async (route) => {
    await gate;
    await route.fulfill({
      json: {
        id: "a-server",
        name: "Server on computer A",
        status: "offline",
        address: "a.example.test:25580",
        players: [],
      },
    });
  });
  try {
    await page.goto("/#console");
    const button = page.getByRole("button", {
      name: "Copy server address",
      exact: true,
    });
    await expect(button).toBeDisabled();
    await expect(button).toHaveText("Loading address…");
    expect(await page.evaluate(() => (window as any).copied)).toBeUndefined();
    release();
    await expect(button).toBeEnabled();
    await button.click();
    await expect
      .poll(() => page.evaluate(() => (window as any).copied))
      .toBe("a.example.test:25580");
  } finally {
    release();
  }
});

test("signing out clears private clipboard metadata before another account opens files", async ({
  page,
}) => {
  const permissions = [
    "server.view",
    "file.read",
    "file.read-content",
    "file.create",
  ];
  let account = "first";
  const server = () => ({
    id: account === "first" ? "private-server" : "public-server",
    name:
      account === "first" ? "Private customer project" : "Public family server",
    mode: "live",
    status: "offline",
    software: "Paper",
    version: "1.21.1",
    players: [],
    maxPlayers: 20,
    address: "play.example.test",
    accessPermissions: permissions,
  });
  const session = () => ({
    role: "subuser",
    accountId: account,
    email: `${account}@example.test`,
    userId: account,
    serverId: server().id,
    permissions,
    hostPermissions: [],
  });
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const reply = (json: unknown) => route.fulfill({ json });
    if (pathname === "/api/access/session") return reply(session());
    if (pathname === "/api/access/logout") return reply({ ok: true });
    if (pathname === "/api/access/login") {
      account = "second";
      return reply(session());
    }
    if (pathname === "/api/servers")
      return reply({
        servers: [server()],
        defaultServerId: server().id,
        hostPermissions: [],
      });
    if (pathname === "/api/server") return reply(server());
    if (pathname === "/api/console") return reply({ lines: [] });
    if (pathname === "/api/files")
      return reply({
        path: "",
        entries:
          account === "first"
            ? [
                {
                  name: "private.txt",
                  path: "private.txt",
                  type: "file",
                  size: 10,
                  modified: "2026-09-27T00:00:00.000Z",
                },
              ]
            : [],
      });
    if (pathname === "/api/files/recycle-operation")
      return reply({ operation: null });
    return reply({});
  });
  await page.goto("/#files");
  await page.getByRole("checkbox", { name: "Select private.txt" }).check();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Copied files" }),
  ).toContainText("Private customer project");
  await page
    .getByRole("button", {
      name: "Account menu for first@example.test",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email address").fill("second@example.test");
  await page.getByLabel("Password", { exact: true }).fill("a fixture password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "File Manager", exact: true }).click();
  await expect(page.getByRole("status", { name: "Copied files" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Paste", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Private customer project", { exact: true }),
  ).toHaveCount(0);
});
