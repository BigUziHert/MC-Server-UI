import {
  createProcessServer,
  selectServer,
  removeTestServer,
} from "./server-fixtures";
import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
  type Locator,
} from "@playwright/test";
import catalog from "../shared/subuser-permissions.json" with { type: "json" };

const permissionIds = catalog.groups.flatMap((group) =>
  group.permissions.map((permission) => permission.id),
);
type Fixture = { id: string; otherServerId: string };
const test = base.extend<{ server: Fixture }>({
  server: async ({ request }, use) => {
    const originalUsers = new Set(
      (await users(request)).map((user) => user.id),
    );
    const fleet = await (await request.get("/api/servers")).json();
    const occupied = new Set(
      fleet.servers.map((server: { port: number }) => server.port),
    );
    let port = 29200;
    while (occupied.has(port)) port++;
    const response = await createProcessServer(request, {
      data: {
        name: "Granular subusers fixture",
        mode: "live",
        port,
        memoryLimitMB: 1024,
      },
    });
    expect(response.status()).toBe(201);
    const { server } = await response.json();
    try {
      await use({ id: server.id, otherServerId: fleet.defaultServerId });
    } finally {
      for (const user of await users(request))
        if (!originalUsers.has(user.id)) {
          const removed = await request.delete(
            `/api/panel-users/${encodeURIComponent(user.id)}`,
          );
          expect(removed.ok()).toBe(true);
        }
      await removeTestServer(request, server.id);
    }
  },
});

async function openSubusers(page: Page, id: string) {
  await page.goto("/#subusers");
  await selectServer(page, id);
  await expect(
    page.getByRole("heading", { name: "Subusers", exact: true }),
  ).toBeVisible();
}

async function openPanelUsers(page: Page) {
  await page
    .getByRole("button", { name: "Panel Settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Panel Settings",
    exact: true,
  });
  await settings
    .getByRole("tab", { name: "Remote Access", exact: true })
    .click();
  await expect(
    settings.getByRole("heading", { name: "Panel users", exact: true }),
  ).toBeVisible();
  return settings;
}

async function showPermissionDetails(dialog: Locator) {
  await expect(dialog).toBeVisible();
  const details = dialog.locator(".subusers-permission-details");
  if ((await details.count()) && (await details.getAttribute("open")) === null)
    await details.locator("summary").click();
}

async function users(request: APIRequestContext) {
  const response = await request.get("/api/panel-users");
  expect(response.status()).toBe(200);
  return (await response.json()).users as {
    id: string;
    email: string;
    permissions: string[];
    hostPermissions?: string[];
    accessMode: "all" | "selected";
    serverIds: string[];
    excludedServerIds: string[];
  }[];
}

async function serverUsers(request: APIRequestContext, serverId: string) {
  const response = await request.get("/api/subusers", {
    headers: { "X-Server-Id": serverId },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).users as {
    id: string;
    email: string;
    permissions: string[];
  }[];
}
async function createAccount(request: APIRequestContext, email: string) {
  const response = await request.post("/api/panel-users", { data: { email } });
  expect(response.status()).toBe(201);
  const result = await response.json();
  return (result.user ?? result) as { id: string; email: string };
}
async function readyRemoteAccess(page: Page) {
  await page.route("**/api/access/settings", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        publicUrl: "https://203.0.113.10:3002",
        transport: "direct",
        port: 3002,
        ready: true,
        listening: true,
      },
    }),
  );
}

for (const view of ["accounts", "server"] as const) {
  test(`the open owner ${view} list removes externally revoked access without a reload`, async ({
    page,
    request,
    server,
  }) => {
    const departed = await createAccount(
      request,
      `departed-${view}@example.test`,
    );
    const remaining = await createAccount(
      request,
      `remaining-${view}@example.test`,
    );
    for (const account of [departed, remaining]) {
      const granted = await request.post("/api/subusers", {
        headers: { "X-Server-Id": server.id },
        data: {
          accountId: account.id,
          permissions: ["server.view", "control.start"],
        },
      });
      expect(granted.status()).toBe(201);
    }
    await openSubusers(page, server.id);
    if (view === "accounts") await openPanelUsers(page);
    const list = page.locator(
      view === "accounts" ? ".panel-users" : ".subusers-page:not(.panel-users)",
    );
    await expect(
      list.getByRole("row").filter({ hasText: departed.email }),
    ).toBeVisible();
    // A remote Forget updates the same host records; this separate client does
    // not send any window event or click the owner's Refresh button.
    expect((await request.delete(`/api/panel-users/${departed.id}`)).ok()).toBe(
      true,
    );
    await expect(
      list.getByRole("row").filter({ hasText: departed.email }),
    ).toHaveCount(0);
    await expect(
      list.getByRole("row").filter({ hasText: remaining.email }),
    ).toBeVisible();
    expect(
      (await serverUsers(request, server.id)).map((user) => user.id),
    ).toEqual([remaining.id]);
  });
}

for (const action of [
  "grant",
  "edit",
  "remove",
  "reset",
  "invitation",
] as const) {
  test(`a host removal closes a stale ${action} dialog while ordinary refresh preserves its input`, async ({
    page,
    request,
    server,
  }) => {
    const account = await createAccount(
      request,
      `stale-${action}@example.test`,
    );
    const panelAction = action === "reset" || action === "invitation";
    await readyRemoteAccess(page);
    if (action === "reset") {
      await page.route("**/api/panel-users", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        return route.fulfill({
          response,
          json: {
            ...body,
            users: body.users.map((user: { id: string }) =>
              user.id === account.id
                ? { ...user, inviteStatus: "accepted" }
                : user,
            ),
          },
        });
      });
    }
    if (action === "invitation") {
      await page.route(`**/api/panel-users/${account.id}/invite`, (route) =>
        route.fulfill({
          json: {
            user: { ...account, inviteStatus: "pending" },
            invitationUrl: "https://example.test/#invite=fixture-private-link",
            inviteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        }),
      );
    }
    if (action === "edit" || action === "remove") {
      const granted = await request.post("/api/subusers", {
        headers: { "X-Server-Id": server.id },
        data: { accountId: account.id, permissions: ["server.view"] },
      });
      expect(granted.status()).toBe(201);
    }
    await openSubusers(page, server.id);
    if (panelAction) await openPanelUsers(page);
    await page
      .getByRole("button", {
        name:
          action === "grant"
            ? "Grant server access"
            : action === "edit"
              ? `Edit permissions for ${account.email}`
              : action === "remove"
                ? `Remove access record for ${account.email}`
                : action === "reset"
                  ? `Reset access for ${account.email}`
                  : `Create invite link for ${account.email}`,
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name:
        action === "grant"
          ? "Grant server access"
          : action === "edit"
            ? "Edit subuser permissions"
            : action === "remove"
              ? "Remove access record?"
              : action === "reset"
                ? "Reset subuser access?"
                : "Share invitation link",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    if (action === "grant") {
      await dialog
        .getByLabel("Panel account", { exact: true })
        .selectOption(account.id);
      await dialog
        .getByRole("button", { name: "Use Viewer preset", exact: true })
        .click();
    }
    if (action === "edit") {
      await showPermissionDetails(dialog);
      await dialog
        .getByRole("checkbox", { name: "Start", exact: true })
        .check();
    }
    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          (panelAction ? "/api/panel-users" : "/api/subusers") &&
        response.request().method() === "GET",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    await expect(dialog).toBeVisible();
    if (action === "grant")
      await expect(
        dialog.getByLabel("Panel account", { exact: true }),
      ).toHaveValue(account.id);
    if (action === "edit")
      await expect(
        dialog.getByRole("checkbox", { name: "Start", exact: true }),
      ).toBeChecked();

    expect((await request.delete(`/api/panel-users/${account.id}`)).ok()).toBe(
      true,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(dialog).not.toBeVisible();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "This access record was removed on the host" }),
    ).toBeVisible();
    expect((await users(request)).some((user) => user.id === account.id)).toBe(
      false,
    );
    expect(await serverUsers(request, server.id)).toEqual([]);
  });
}

for (const invitationResult of ["none", "success", "failure"] as const) {
  test(`panel account audit warnings survive invitation ${invitationResult} without repeating the saved change`, async ({
    page,
    request,
    server,
  }) => {
    const creationWarning =
      "The account was saved, but its creation audit history could not be saved.";
    const invitationWarning =
      "The invitation was saved, but its audit history could not be saved.";
    const editWarning =
      "Computer permissions were saved, but their audit history could not be saved.";
    const email = `audit-${invitationResult}@example.test`;
    let created: { id: string; email: string } | undefined;
    let creates = 0;
    let invitations = 0;
    await readyRemoteAccess(page);
    await page.route("**/api/panel-users", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      creates++;
      const response = await route.fetch();
      const body = await response.json();
      created = body.user ?? body;
      return route.fulfill({
        response,
        json: { ...body, warning: creationWarning },
      });
    });
    await page.route("**/api/panel-users/*/invite", (route) => {
      invitations++;
      if (invitationResult === "failure")
        return route.fulfill({
          status: 503,
          json: { error: "Fixture invitation unavailable." },
        });
      return route.fulfill({
        json: {
          user: { ...created, inviteStatus: "pending" },
          invitationUrl: "https://example.test/#invite=audit-warning-fixture",
          inviteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          warning: invitationWarning,
        },
      });
    });
    await openSubusers(page, server.id);
    await openPanelUsers(page);
    await page
      .getByRole("button", { name: "Invite person", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Invite person",
      exact: true,
    });
    await editor.getByLabel("Email address", { exact: true }).fill(email);
    if (invitationResult === "none")
      await editor
        .getByRole("checkbox", { name: "Create invitation link", exact: true })
        .uncheck();
    await editor
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(editor).not.toBeVisible();
    if (invitationResult === "success") {
      const invitation = page.getByRole("dialog", {
        name: "Share invitation link",
        exact: true,
      });
      await expect(invitation).toBeVisible();
      await expect(invitation.getByRole("alert")).toContainText(
        creationWarning,
      );
      await expect(invitation.getByRole("alert")).toContainText(
        invitationWarning,
      );
      await expect(
        invitation.getByLabel("Invitation link", { exact: true }),
      ).toHaveValue("https://example.test/#invite=audit-warning-fixture");
    } else {
      const warning = page
        .getByRole("alert")
        .filter({ hasText: creationWarning });
      await expect(warning).toBeVisible();
      if (invitationResult === "failure")
        await expect(warning).toContainText("Fixture invitation unavailable.");
    }
    expect(creates).toBe(1);
    expect(invitations).toBe(invitationResult === "none" ? 0 : 1);
    const stored = (await users(request)).filter(
      (user) => user.email === email,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(created?.id);
    expect(stored[0].serverIds).toEqual([]);
    expect(await serverUsers(request, server.id)).toEqual([]);

    if (invitationResult === "none") {
      let edits = 0;
      await page.route(`**/api/panel-users/${stored[0].id}`, async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        edits++;
        expect(route.request().postDataJSON()).toEqual({
          hostPermissions: ["server.create"],
        });
        const response = await route.fetch();
        return route.fulfill({
          response,
          json: { ...(await response.json()), warning: editWarning },
        });
      });
      await page
        .getByRole("button", { name: `Edit account for ${email}`, exact: true })
        .click();
      const edit = page.getByRole("dialog", {
        name: "Edit account",
        exact: true,
      });
      await edit
        .getByRole("checkbox", {
          name: "Create and import servers",
          exact: true,
        })
        .check();
      await edit
        .getByRole("button", { name: "Save account", exact: true })
        .click();
      await expect(edit).not.toBeVisible();
      await expect(
        page.getByRole("alert").filter({ hasText: editWarning }),
      ).toBeVisible();
      expect(edits).toBe(1);
      expect(
        (await users(request)).find((user) => user.id === stored[0].id)
          ?.hostPermissions,
      ).toEqual(["server.create"]);
      expect(await serverUsers(request, server.id)).toEqual([]);
    }
  });
}

test("a new invitation remains usable when its follow-up account refresh fails", async ({
  page,
  request,
  server,
}) => {
  let created: { id: string; email: string } | undefined;
  let failReads = false;
  let failedReads = 0;
  await readyRemoteAccess(page);
  await page.route("**/api/panel-users", async (route) => {
    if (route.request().method() === "GET" && failReads) {
      failedReads++;
      return route.fulfill({
        status: 503,
        json: { error: "Fixture refresh unavailable." },
      });
    }
    const response = await route.fetch();
    if (route.request().method() === "POST") {
      const result = await response.json();
      created = result.user ?? result;
      failReads = true;
    }
    return route.fulfill({ response });
  });
  await page.route("**/api/panel-users/*/invite", (route) =>
    route.fulfill({
      json: {
        user: { ...created, inviteStatus: "pending" },
        invitationUrl:
          "https://example.test/#invite=created-before-read-failure",
        inviteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }),
  );
  await openSubusers(page, server.id);
  await openPanelUsers(page);
  await page
    .getByRole("button", { name: "Invite person", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Invite person",
    exact: true,
  });
  await editor
    .getByLabel("Email address", { exact: true })
    .fill("refresh-failed@example.test");
  await editor
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect.poll(() => failedReads).toBeGreaterThan(0);
  const invitation = page.getByRole("dialog", {
    name: "Share invitation link",
    exact: true,
  });
  await expect(invitation).toBeVisible();
  await expect(
    invitation.getByLabel("Invitation link", { exact: true }),
  ).toHaveValue("https://example.test/#invite=created-before-read-failure");
  expect((await users(request)).some((user) => user.id === created?.id)).toBe(
    true,
  );
  expect(await serverUsers(request, server.id)).toEqual([]);
  // A subsequent confirmed read preserves the same invitation, too.
  failReads = false;
  const recovered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/panel-users" && response.ok(),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await recovered;
  await expect(invitation).toBeVisible();
});

test("an account invite grants no server access, and grant/edit/revoke affect only the current server", async ({
  page,
  request,
  server,
}, testInfo) => {
  await openSubusers(page, server.id);
  await expect(
    page.getByRole("button", { name: "Invite person", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Panel accounts", exact: true }),
  ).toHaveCount(0);
  const settings = await openPanelUsers(page);
  await page
    .getByRole("button", { name: "Invite person", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "Invite person", exact: true });
  await expect(dialog).toContainText("no server access");
  await expect(
    dialog.getByRole("group", { name: "Server permissions", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("separate-account@example.test");
  await dialog
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    settings.getByRole("heading", { name: "Panel users", exact: true }),
  ).toBeVisible();
  const account = (await users(request)).find(
    (user) => user.email === "separate-account@example.test",
  )!;
  expect(account).toMatchObject({ permissions: [], serverIds: [] });
  expect(await serverUsers(request, server.id)).toEqual([]);
  expect(
    (await serverUsers(request, server.otherServerId)).some(
      (user) => user.email === account.email,
    ),
  ).toBe(false);

  await settings
    .getByRole("button", { name: "Close Panel Settings", exact: true })
    .click();
  await expect(settings).not.toBeVisible();
  await page
    .getByRole("button", { name: "Grant server access", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Grant server access",
    exact: true,
  });
  await expect(dialog.getByRole("combobox")).toHaveCount(1);
  await expect(dialog.getByLabel("Email address", { exact: true })).toHaveCount(
    0,
  );
  await expect(dialog.locator(".subusers-permission-details")).toHaveJSProperty(
    "open",
    false,
  );
  await expect(
    dialog.getByLabel("Servers available to this person", { exact: true }),
  ).toHaveCount(0);
  await expect(dialog).not.toContainText("All current and future servers");
  await dialog
    .getByLabel("Panel account", { exact: true })
    .selectOption(account.id);
  await showPermissionDetails(dialog);
  const basic = dialog.getByRole("checkbox", {
    name: "Can View Server",
    exact: true,
  });
  const consoleAccess = dialog.getByRole("checkbox", {
    name: "Console",
    exact: true,
  });
  await expect(basic).not.toBeChecked();
  await expect(consoleAccess).toBeDisabled();
  await basic.check();
  await consoleAccess.check();
  await dialog
    .getByRole("button", { name: "Grant access", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    (await serverUsers(request, server.id)).find(
      (user) => user.id === account.id,
    )?.permissions,
  ).toEqual(["server.view", "control.console"]);
  expect(
    (await serverUsers(request, server.otherServerId)).some(
      (user) => user.email === account.email,
    ),
  ).toBe(false);

  const otherGrant = await request.post("/api/subusers", {
    headers: { "X-Server-Id": server.otherServerId },
    data: { accountId: account.id, permissions: ["server.view", "file.read"] },
  });
  expect(otherGrant.status()).toBe(201);
  await page
    .getByRole("button", {
      name: `Edit permissions for ${account.email}`,
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Edit subuser permissions",
    exact: true,
  });
  await showPermissionDetails(dialog);
  await expect(
    dialog.getByLabel("Email address", { exact: true }),
  ).toHaveJSProperty("readOnly", true);
  await dialog.getByRole("checkbox", { name: "Start", exact: true }).check();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await expect(
    dialog.getByRole("button", { name: "Save permissions", exact: true }),
  ).toBeInViewport();
  await dialog.screenshot({
    path: testInfo.outputPath("server-access-mobile.png"),
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    (await serverUsers(request, server.id)).find(
      (user) => user.id === account.id,
    )?.permissions,
  ).toEqual(["server.view", "control.console", "control.start"]);
  expect(
    (await serverUsers(request, server.otherServerId)).find(
      (user) => user.id === account.id,
    )?.permissions,
  ).toEqual(["server.view", "file.read"]);
  await page
    .getByRole("button", {
      name: `Remove access record for ${account.email}`,
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Remove access record?",
    exact: true,
  });
  await expect(dialog).toContainText("access to other servers stay the same");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await dialog
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(await serverUsers(request, server.id)).toEqual([]);
  expect(
    (await serverUsers(request, server.otherServerId)).find(
      (user) => user.id === account.id,
    )?.permissions,
  ).toEqual(["server.view", "file.read"]);
  expect((await users(request)).some((user) => user.id === account.id)).toBe(
    true,
  );
});

test("permission presets and mixed groups preserve Can View Server as the required base", async ({
  page,
  request,
  server,
}) => {
  const account = await createAccount(request, "presets@example.test");
  await openSubusers(page, server.id);
  await page
    .getByRole("button", { name: "Grant server access", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Grant server access",
    exact: true,
  });
  await dialog
    .getByLabel("Panel account", { exact: true })
    .selectOption(account.id);
  await dialog
    .getByRole("button", { name: "Use Viewer preset", exact: true })
    .click();
  await showPermissionDetails(dialog);
  await expect(
    dialog.getByRole("checkbox", { name: "Can View Server", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "View audit logs", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Start", exact: true }),
  ).not.toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "Select all Control", exact: true })
    .check();
  await dialog
    .getByRole("checkbox", { name: "Restart", exact: true })
    .uncheck();
  await expect(
    dialog.getByRole("checkbox", { name: "Select all Control", exact: true }),
  ).toHaveAttribute("aria-checked", "mixed");
  await expect(
    dialog.getByRole("checkbox", { name: "All permissions", exact: true }),
  ).toHaveAttribute("aria-checked", "mixed");
  await dialog
    .getByRole("button", { name: "Grant access", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const expected = permissionIds.filter(
    (id) =>
      (catalog.roleDefaults.viewer as string[]).includes(id) ||
      [
        "server.view",
        "control.console",
        "control.start",
        "control.stop",
      ].includes(id),
  );
  expect(
    (await serverUsers(request, server.id)).find(
      (user) => user.id === account.id,
    )?.permissions,
  ).toEqual(expected);
  await page.reload();
  await page
    .getByRole("button", {
      name: `Edit permissions for ${account.email}`,
      exact: true,
    })
    .click();
  const edit = page.getByRole("dialog", {
    name: "Edit subuser permissions",
    exact: true,
  });
  await showPermissionDetails(edit);
  await edit
    .getByRole("checkbox", { name: "Can View Server", exact: true })
    .uncheck();
  await expect(
    edit.getByRole("checkbox", { name: "Console", exact: true }),
  ).not.toBeChecked();
  await expect(
    edit.getByRole("checkbox", { name: "Console", exact: true }),
  ).toBeDisabled();
  await edit
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(edit.getByRole("alert")).toContainText("use Revoke access");
  await edit.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    (await serverUsers(request, server.id)).find(
      (user) => user.id === account.id,
    )?.permissions,
  ).toEqual(expected);
});

test("grant cancellation, save errors, and audit warnings preserve deliberate server access", async ({
  page,
  request,
  server,
}) => {
  const account = await createAccount(request, "retry@example.test");
  let deny = true,
    submitted = 0;
  await page.route("**/api/subusers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submitted++;
    expect(route.request().headers()["x-server-id"]).toBe(server.id);
    expect(route.request().postDataJSON()).toEqual({
      accountId: account.id,
      permissions: ["server.view", "control.start"],
    });
    if (deny)
      return route.fulfill({
        status: 403,
        json: { error: "Fixture writes are disabled." },
      });
    const response = await route.fetch();
    return route.fulfill({
      response,
      json: {
        ...(await response.json()),
        warning:
          "Server access was saved, but its audit entry could not be saved.",
      },
    });
  });
  await openSubusers(page, server.id);
  await page
    .getByRole("button", { name: "Grant server access", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Grant server access",
    exact: true,
  });
  await dialog
    .getByLabel("Panel account", { exact: true })
    .selectOption(account.id);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(submitted).toBe(0);
  await page
    .getByRole("button", { name: "Grant server access", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Grant server access",
    exact: true,
  });
  await expect(dialog.getByLabel("Panel account", { exact: true })).toHaveValue(
    "",
  );
  await dialog
    .getByLabel("Panel account", { exact: true })
    .selectOption(account.id);
  await showPermissionDetails(dialog);
  await dialog
    .getByRole("checkbox", { name: "Can View Server", exact: true })
    .check();
  await dialog.getByRole("checkbox", { name: "Start", exact: true }).check();
  await dialog
    .getByRole("button", { name: "Grant access", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Fixture writes are disabled.",
  );
  await expect(dialog.getByLabel("Panel account", { exact: true })).toHaveValue(
    account.id,
  );
  await expect(
    dialog.getByRole("checkbox", { name: "Start", exact: true }),
  ).toBeChecked();
  expect(await serverUsers(request, server.id)).toEqual([]);
  deny = false;
  await dialog
    .getByRole("button", { name: "Grant access", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(submitted).toBe(2);
  await expect(page.getByRole("alert")).toContainText(
    "Server access was saved, but its audit entry could not be saved.",
  );
  expect((await serverUsers(request, server.id))[0].permissions).toEqual([
    "server.view",
    "control.start",
  ]);
});

test("panel account changes preserve legacy server mappings and show saved access needing review", async ({
  page,
  server,
}) => {
  let account = {
    id: "legacy:legacy@example.test",
    email: "legacy@example.test",
    legacy: true,
    permissions: [] as string[],
    hostPermissions: [] as string[],
    serverIds: [server.id],
    serverOverrides: {
      [server.id]: { permissions: ["server.view", "control.console"] },
    },
    accessReview: {
      message:
        "Some saved server grants need review before they can be restored.",
    },
  };
  const patches: Record<string, unknown>[] = [];
  await page.route("**/api/panel-users**", (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      patches.push(body);
      account = { ...account, ...body };
      return route.fulfill({ json: { user: account } });
    }
    return route.fulfill({ json: { users: [account] } });
  });
  await openSubusers(page, server.id);
  await openPanelUsers(page);
  const row = page.getByRole("row").filter({ hasText: account.email });
  await expect(row).toContainText(account.accessReview.message);
  await expect(row).toContainText(
    "Existing sign-ins keep their previous server access",
  );
  await row
    .getByRole("button", {
      name: `Edit account for ${account.email}`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Edit account",
    exact: true,
  });
  await expect(
    dialog.getByRole("checkbox", { name: "Can View Server", exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await dialog
    .getByRole("checkbox", { name: "Create and import servers", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Save account", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(patches).toEqual([{ hostPermissions: ["server.create"] }]);
  expect(account.serverOverrides[server.id].permissions).toEqual([
    "server.view",
    "control.console",
  ]);
  expect(account.serverIds).toEqual([server.id]);
});

test("a failed account invitation preserves zero grants and clipboard retries retain the private link", async ({
  page,
  request,
  server,
}, testInfo) => {
  const invitationUrl =
    "https://203.0.113.10:3002/#invite=fixture-secret-token";
  await page.addInitScript(() => {
    const original = document.execCommand.bind(document);
    document.execCommand = (command, ...args) =>
      command === "copy" ? false : original(command, ...args);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard denied");
        },
      },
    });
  });
  await readyRemoteAccess(page);
  let creates = 0,
    invitations = 0;
  await page.route("**/api/panel-users", (route) => {
    if (route.request().method() === "POST") {
      creates++;
      expect(route.request().postDataJSON()).toEqual({
        email: "phone@example.test",
      });
      expect(route.request().headers()["x-server-id"]).toBeUndefined();
    }
    return route.continue();
  });
  await page.route("**/api/panel-users/*/invite", async (route) => {
    invitations++;
    if (invitations === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Remote access is unavailable." },
      });
    const userId = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-2)!,
    );
    const user = (await users(request)).find((item) => item.id === userId);
    return route.fulfill({
      json: {
        invitationUrl,
        inviteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        user: { ...user, inviteStatus: "pending" },
      },
    });
  });
  await openSubusers(page, server.id);
  await openPanelUsers(page);
  await page
    .getByRole("button", { name: "Invite person", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Invite person",
    exact: true,
  });
  await editor
    .getByLabel("Email address", { exact: true })
    .fill("phone@example.test");
  await expect(
    editor.getByRole("checkbox", {
      name: "Create invitation link",
      exact: true,
    }),
  ).toBeChecked();
  await editor
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "The account is saved" }),
  ).toContainText("Remote access is unavailable.");
  const account = (await users(request)).find(
    (user) => user.email === "phone@example.test",
  )!;
  expect(account.permissions).toEqual([]);
  expect(account.serverIds).toEqual([]);
  expect(await serverUsers(request, server.id)).toEqual([]);
  await page
    .getByRole("button", {
      name: `Create invite link for ${account.email}`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Share invitation link",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const link = dialog.getByLabel("Invitation link", { exact: true });
  await expect(link).toHaveValue(invitationUrl);
  await expect(dialog).toContainText("This invitation grants no server access");
  await expect(dialog).toContainText("at least 12 characters");
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Copy the selected link manually",
  );
  expect(
    await link.evaluate(
      (element) => (element as HTMLTextAreaElement).selectionEnd,
    ),
  ).toBe(invitationUrl.length);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as unknown as { copied: string }).copied = value;
        },
      },
    });
  });
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Invitation link copied.",
  );
  expect(
    await page.evaluate(() => (window as unknown as { copied: string }).copied),
  ).toBe(invitationUrl);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    document.execCommand = (command) => {
      const field = document.activeElement;
      if (command !== "copy" || !(field instanceof HTMLTextAreaElement))
        return false;
      (window as unknown as { fallbackCopy: unknown }).fallbackCopy = {
        value: field.value.slice(field.selectionStart, field.selectionEnd),
        inDialog: Boolean(field.closest("dialog[open]")),
      };
      return true;
    };
  });
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { fallbackCopy: unknown }).fallbackCopy,
    ),
  ).toEqual({ value: invitationUrl, inDialog: true });
  expect(creates).toBe(1);
  expect(invitations).toBe(2);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "fixture-secret-token",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dialog.getByRole("button", { name: "Copy link", exact: true }),
  ).toBeInViewport();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await dialog.screenshot({
    path: testInfo.outputPath("account-invitation-mobile.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(link).toHaveCount(0);
});

test("resetting activated access explains immediate sign-out and can be cancelled", async ({
  page,
  server,
}) => {
  const user = {
    id: "activated-user",
    email: "activated@example.test",
    permissions: [],
    inviteStatus: "accepted",
  };
  await readyRemoteAccess(page);
  await page.route("**/api/panel-users", (route) =>
    route.fulfill({ json: { users: [user] } }),
  );
  let resets = 0;
  await page.route("**/api/panel-users/activated-user/invite", (route) => {
    resets++;
    return route.fulfill({
      json: {
        user: { ...user, inviteStatus: "pending" },
        invitationUrl: "https://203.0.113.10:3002/#invite=reset-token",
        inviteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
  });
  await openSubusers(page, server.id);
  const settings = await openPanelUsers(page);
  const reset = page.getByRole("button", {
    name: "Reset access for activated@example.test",
    exact: true,
  });
  await reset.click();
  let dialog = page.getByRole("dialog", {
    name: "Reset subuser access?",
    exact: true,
  });
  await expect(dialog).toContainText(
    "Their current password and sessions stop working immediately",
  );
  await expect(dialog).toContainText("existing server grants stay the same");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(settings).toBeVisible();
  expect(resets).toBe(0);
  await reset.click();
  dialog = page.getByRole("dialog", {
    name: "Reset subuser access?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Reset and create link", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Share invitation link", exact: true }),
  ).toBeVisible();
  await expect(dialog).not.toBeVisible();
  expect(resets).toBe(1);
});

test("trusted remote setup detects the public IP on request and surfaces listener failures while retaining edits", async ({
  page,
  server,
}, testInfo) => {
  const changes: Record<string, unknown>[] = [];
  let configured = {
    enabled: true,
    publicUrl: "https://203.0.113.10",
    transport: "managed",
    port: 3002,
    ready: true,
    listening: true,
    error: "",
    managedHttps: {
      state: "ready",
      ready: true,
      message: "Trusted certificate is ready.",
    },
  };
  let discoveries = 0;
  await page.route("**/api/access/network", (route) => {
    discoveries++;
    return route.fulfill({
      json: {
        publicIp: "203.0.113.20",
        localAddresses: ["192.168.1.5"],
        port: 3002,
      },
    });
  });
  await page.route("**/api/access/settings", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: configured });
    const body = route.request().postDataJSON();
    changes.push(body);
    if (changes.length === 2) {
      configured = {
        ...configured,
        enabled: false,
        ready: false,
        listening: false,
        error: "Internal service port is already in use.",
        managedHttps: {
          state: "error",
          ready: false,
          message: "Internal service port is already in use.",
        },
      };
      return route.fulfill({ status: 409, json: { error: configured.error } });
    }
    configured = { ...configured, ...body };
    return route.fulfill({ json: configured });
  });
  await openSubusers(page, server.id);
  await openPanelUsers(page);
  await page.getByRole("button", { name: "Edit setup", exact: true }).click();
  const setup = page.getByRole("region", {
    name: "Remote access setup",
    exact: true,
  });
  expect(discoveries).toBe(0);
  await expect(setup.getByRole("combobox")).toHaveCount(0);
  await expect(
    setup.getByLabel("Certificate SHA-256 fingerprint", { exact: true }),
  ).toHaveCount(0);
  await setup.getByText("Advanced connection options", { exact: true }).click();
  await setup.getByLabel("Internal service port", { exact: true }).fill("3004");
  await setup
    .getByRole("button", { name: "Use my public IP", exact: true })
    .click();
  await expect(
    setup.getByLabel("Public panel address", { exact: true }),
  ).toHaveValue("https://203.0.113.20");
  await expect(setup).toContainText("Forward TCP port 443");
  await expect(setup).toContainText(
    "These settings do not open router or firewall ports",
  );
  expect(discoveries).toBe(1);
  await setup
    .getByRole("button", { name: "Save access settings", exact: true })
    .click();
  await expect.poll(() => changes.length).toBe(1);
  expect(changes[0]).toEqual({
    enabled: true,
    publicUrl: "https://203.0.113.20",
    transport: "managed",
    port: 3004,
  });
  await expect(
    setup.getByRole("button", { name: "Save access settings", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("subusers-access-setup-desktop.png"),
    fullPage: true,
  });
  await setup.getByLabel("Internal service port", { exact: true }).fill("80");
  await setup
    .getByRole("button", { name: "Save access settings", exact: true })
    .click();
  expect(changes).toHaveLength(1);
  await setup.getByLabel("Internal service port", { exact: true }).fill("3003");
  await setup
    .getByLabel("Public panel address", { exact: true })
    .fill("https://203.0.113.30");
  await setup
    .getByRole("button", { name: "Save access settings", exact: true })
    .click();
  await expect.poll(() => changes.length).toBe(2);
  await expect(setup.getByRole("alert")).toContainText(
    "Internal service port is already in use.",
  );
  await expect(
    setup.getByRole("heading", { name: "Remote access", exact: true }),
  ).toBeVisible();
  await expect(
    setup.getByLabel("Internal service port", { exact: true }),
  ).toHaveValue("3003");
  await expect(
    setup.getByLabel("Public panel address", { exact: true }),
  ).toHaveValue("https://203.0.113.30");
});
