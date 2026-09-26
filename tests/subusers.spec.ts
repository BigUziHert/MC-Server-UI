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

test("permission presets select explicit grantable permissions", async ({
  page,
  request,
  server,
}) => {
  await openSubusers(page, server.id);
  await page.getByRole("button", { name: "New user", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  await showPermissionDetails(dialog);
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("viewer-preset@example.test");
  await dialog
    .getByRole("button", { name: "Use Viewer preset", exact: true })
    .click();
  await expect(
    dialog.getByRole("checkbox", { name: "Start", exact: true }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "View audit logs", exact: true }),
  ).toBeChecked();
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    (await users(request))
      .find((user) => user.email === "viewer-preset@example.test")
      ?.permissions.slice()
      .sort(),
  ).toEqual(catalog.roleDefaults.viewer.slice().sort());
});

test("one panel account includes future servers and excludes an individual server without another invitation", async ({
  page,
  request,
  server,
}, testInfo) => {
  await openSubusers(page, server.id);
  let creates = 0;
  const patches: Record<string, unknown>[] = [];
  await page.route("**/api/panel-users**", (route) => {
    expect(route.request().headers()["x-server-id"]).toBeUndefined();
    if (route.request().method() === "POST") creates++;
    if (route.request().method() === "PATCH")
      patches.push(route.request().postDataJSON());
    return route.continue();
  });
  await page.getByRole("button", { name: "New user", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  await expect(
    dialog.getByLabel("Servers available to this person", { exact: true }),
  ).toHaveValue("all");
  await expect(
    dialog.locator(".subusers-permission-details"),
  ).not.toHaveAttribute("open");
  await expect(
    dialog
      .getByRole("group", { name: "Allowed servers", exact: true })
      .getByRole("checkbox", { checked: true }),
  ).toHaveCount(
    (await (await request.get("/api/servers")).json()).servers.length,
  );
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("panel-all@example.test");
  await dialog
    .getByRole("button", { name: "Use Viewer preset", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const account = (await users(request)).find(
    (user) => user.email === "panel-all@example.test",
  )!;
  expect(account).toMatchObject({
    accessMode: "all",
    serverIds: [],
    excludedServerIds: [],
  });

  const fleet = await (await request.get("/api/servers")).json();
  let port = 29300;
  while (fleet.servers.some((item: { port: number }) => item.port === port))
    port++;
  const created = await createProcessServer(request, {
    data: { name: "Future panel server", mode: "live", port },
  });
  expect(created.status()).toBe(201);
  const future = (await created.json()).server;
  try {
    await page.reload();
    await page
      .getByRole("button", {
        name: "Edit permissions for panel-all@example.test",
        exact: true,
      })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Edit subuser permissions",
      exact: true,
    });
    const futureAccess = dialog.getByRole("checkbox", {
      name: "Access to Future panel server",
      exact: true,
    });
    await expect(futureAccess).toBeChecked();
    const currentAccess = dialog.getByRole("checkbox", {
      name: "Access to Granular subusers fixture",
      exact: true,
    });
    await currentAccess.uncheck();
    await expect(futureAccess).toBeChecked();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await dialog.screenshot({
      path: testInfo.outputPath("panel-users-server-exclusions-mobile.png"),
      animations: "disabled",
    });
    await dialog
      .getByRole("button", { name: "Save permissions", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      accessMode: "all",
      serverIds: [],
      excludedServerIds: [server.id],
    });
    expect(patches[0]).not.toHaveProperty("serverOverrides");
    expect(
      (await users(request)).find((user) => user.id === account.id),
    ).toMatchObject({ accessMode: "all", excludedServerIds: [server.id] });
    await expect(
      page.getByRole("row").filter({ hasText: account.email }),
    ).toContainText("All current and future servers except 1");
    await page.reload();
    await page
      .getByRole("button", {
        name: "Edit permissions for panel-all@example.test",
        exact: true,
      })
      .click();
    await expect(currentAccess).not.toBeChecked();
    await expect(futureAccess).toBeChecked();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(creates).toBe(1);
  } finally {
    await removeTestServer(request, future.id);
  }
});

test("selected legacy account access and per-server permissions are preserved unless explicitly changed", async ({
  page,
  server,
}, testInfo) => {
  const serverList = [
    { id: server.id, name: "Existing selected server" },
    { id: server.otherServerId, name: "Another server" },
  ];
  let account = {
    id: "legacy:legacy@example.test",
    legacy: true,
    email: "legacy@example.test",
    permissions: [] as string[],
    hostPermissions: [] as string[],
    accessMode: "selected",
    serverIds: [server.id],
    excludedServerIds: [] as string[],
    serverOverrides: { [server.id]: { permissions: ["control.console"] } },
    createdAt: new Date().toISOString(),
  };
  const patches: Record<string, unknown>[] = [];
  await page.route("**/api/panel-users**", (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      patches.push(body);
      if (patches.length < 3)
        expect(body).not.toHaveProperty("serverOverrides");
      account = {
        ...account,
        ...body,
        id: "a6d4a390-444c-47d6-9b7f-b8f7a3e8f731",
        legacy: false,
      };
      return route.fulfill({ json: { user: account } });
    }
    return route.fulfill({ json: { users: [account], servers: serverList } });
  });
  await openSubusers(page, server.id);
  await page
    .getByRole("button", {
      name: `Edit permissions for ${account.email}`,
      exact: true,
    })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Edit subuser permissions",
    exact: true,
  });
  await expect(
    dialog.getByLabel("Servers available to this person", { exact: true }),
  ).toHaveValue("selected");
  await expect(
    dialog.getByRole("checkbox", {
      name: "Access to Existing selected server",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", {
      name: "Access to Another server",
      exact: true,
    }),
  ).not.toBeChecked();
  await dialog
    .getByText("Custom permissions for Existing selected server", {
      exact: true,
    })
    .click();
  await expect(dialog.locator(".subusers-server-override")).toContainText(
    "Console",
  );
  await expect(dialog).toContainText(
    "Custom server permissions are preserved.",
  );
  await expect(dialog).toContainText(
    "Existing sign-ins keep their previous server access until a panel invitation is accepted.",
  );
  await dialog.screenshot({
    path: testInfo.outputPath("panel-users-selected-legacy-desktop.png"),
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "Use Viewer preset", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(patches[0]).toMatchObject({
    accessMode: "selected",
    serverIds: [server.id],
    excludedServerIds: [],
  });
  expect(account.serverOverrides[server.id].permissions).toEqual([
    "control.console",
  ]);
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
  await dialog
    .getByLabel("Servers available to this person", { exact: true })
    .selectOption("all");
  await expect(
    dialog.getByRole("checkbox", {
      name: "Access to Existing selected server",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", {
      name: "Access to Another server",
      exact: true,
    }),
  ).not.toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "Access to Another server", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(patches[1]).toMatchObject({
    accessMode: "all",
    serverIds: [],
    excludedServerIds: [],
  });
  expect(account.serverOverrides[server.id].permissions).toEqual([
    "control.console",
  ]);
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
  const replaceOverrides = dialog.getByRole("checkbox", {
    name: "Use these permissions on every allowed server",
    exact: true,
  });
  await expect(replaceOverrides).not.toBeChecked();
  await replaceOverrides.check();
  await dialog
    .getByRole("button", { name: "Use Operator preset", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(patches[2]).toMatchObject({
    serverOverrides: {},
    permissions: catalog.roleDefaults.operator,
  });
  expect(account.serverOverrides).toEqual({});
});

test("only the owner explicitly grants computer access outside server permission presets", async ({
  page,
  request,
  server,
}) => {
  const email = "host-creator@example.test";
  await openSubusers(page, server.id);
  await page.getByRole("button", { name: "New user", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await showPermissionDetails(dialog);
  const hostPermission = dialog.getByRole("checkbox", {
    name: "Create and import servers",
    exact: true,
  });
  await dialog.getByLabel("Email address", { exact: true }).fill(email);
  await dialog
    .getByRole("button", { name: "Use Admin preset", exact: true })
    .click();
  await expect(hostPermission).not.toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "All permissions", exact: true })
    .uncheck();
  await dialog
    .getByRole("checkbox", { name: "All permissions", exact: true })
    .check();
  await expect(hostPermission).not.toBeChecked();
  await hostPermission.check();
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    (await users(request)).find((user) => user.email === email)
      ?.hostPermissions,
  ).toEqual(["server.create"]);
  await page
    .getByRole("button", { name: `Edit permissions for ${email}`, exact: true })
    .click();
  await expect(hostPermission).toBeChecked();
  await hostPermission.uncheck();
  await dialog
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    (await users(request)).find((user) => user.email === email)
      ?.hostPermissions,
  ).toEqual([]);
});

test("granular subuser permissions persist, edit, and expose accurate mixed group states", async ({
  page,
  request,
  server,
}, testInfo) => {
  const email = "permissions-fixture@example.test";
  await openSubusers(page, server.id);
  await page.getByRole("button", { name: "New user", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  await showPermissionDetails(dialog);
  await expect(dialog).toContainText("No invitation link can be created");
  await expect(
    dialog.getByRole("checkbox", {
      name: "Create invitation link",
      exact: true,
    }),
  ).toBeDisabled();
  await dialog.getByLabel("Email address", { exact: true }).fill(email);
  const all = dialog.getByRole("checkbox", {
    name: "All permissions",
    exact: true,
  });
  await expect(all).not.toBeChecked();
  const control = dialog.getByRole("checkbox", {
    name: "Select all Control",
    exact: true,
  });
  await control.check();
  await dialog
    .getByRole("checkbox", { name: "Restart", exact: true })
    .uncheck();
  await expect(control).toHaveAttribute("aria-checked", "mixed");
  expect(
    await control.evaluate(
      (element) => (element as HTMLInputElement).indeterminate,
    ),
  ).toBe(true);
  await dialog
    .getByRole("checkbox", { name: "Select all Files", exact: true })
    .check();
  await dialog
    .getByRole("checkbox", { name: "Delete files", exact: true })
    .uncheck();
  await expect(
    dialog.getByRole("checkbox", { name: "Select all Files", exact: true }),
  ).toHaveAttribute("aria-checked", "mixed");
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  await page.screenshot({
    path: testInfo.outputPath("subuser-permissions-desktop.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const expected = [
    "control.console",
    "control.start",
    "control.stop",
    "file.read",
    "file.read-content",
    "file.create",
    "file.update",
  ];
  expect(
    (await users(request)).find((user) => user.email === email)?.permissions,
  ).toEqual(expected);
  await selectServer(page, server.otherServerId);
  await expect(page.getByRole("row").filter({ hasText: email })).toBeVisible();
  await selectServer(page, server.id);
  await page.reload();
  await page
    .getByRole("button", { name: `Edit permissions for ${email}`, exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Edit subuser permissions",
    exact: true,
  });
  await showPermissionDetails(dialog);
  await expect(dialog).toContainText("Permission changes apply immediately");
  await expect(
    dialog.getByLabel("Email address", { exact: true }),
  ).toHaveJSProperty("readOnly", true);
  await expect(
    dialog.getByRole("checkbox", { name: "Console", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Restart", exact: true }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Delete files", exact: true }),
  ).not.toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "All permissions", exact: true })
    .check();
  for (const group of catalog.groups)
    await expect(
      dialog.getByRole("checkbox", {
        name: `Select all ${group.label}`,
        exact: true,
      }),
    ).toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "Select all Files", exact: true })
    .uncheck();
  await expect(
    dialog.getByRole("checkbox", { name: "All permissions", exact: true }),
  ).toHaveAttribute("aria-checked", "mixed");
  await dialog
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const updated = permissionIds.filter((id) => !id.startsWith("file."));
  expect(
    (await users(request)).find((user) => user.email === email)?.permissions,
  ).toEqual(updated);
  await page
    .getByRole("button", { name: `Edit permissions for ${email}`, exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Edit subuser permissions",
    exact: true,
  });
  await showPermissionDetails(dialog);
  await expect(
    dialog.getByRole("checkbox", { name: "Select all Files", exact: true }),
  ).not.toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "All permissions", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    (await users(request)).find((user) => user.email === email)?.permissions,
  ).toEqual(updated);
});

test("subuser cancellation and save errors preserve deliberate selections without premature writes", async ({
  page,
  request,
  server,
}) => {
  const unrelated = await request.post("/api/panel-users", {
    data: {
      email: `existing-cancel-${server.id}@example.test`,
      permissions: ["file.read"],
      accessMode: "selected",
      serverIds: [server.id],
    },
  });
  expect(unrelated.status()).toBe(201);
  const baseline = await users(request);
  await openSubusers(page, server.id);
  let deny = true;
  let submitted = 0;
  await page.route("**/api/panel-users", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submitted++;
    expect(route.request().headers()["x-server-id"]).toBeUndefined();
    if (deny)
      await route.fulfill({
        status: 403,
        json: { error: "Fixture writes are disabled." },
      });
    else await route.continue();
  });
  await page.getByRole("button", { name: "New user", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  await showPermissionDetails(dialog);
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("cancelled@example.test");
  await dialog.getByRole("checkbox", { name: "Console", exact: true }).check();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(submitted).toBe(0);
  expect(await users(request)).toEqual(baseline);
  await page.getByRole("button", { name: "New user", exact: true }).click();
  dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  await showPermissionDetails(dialog);
  const email = dialog.getByLabel("Email address", { exact: true });
  await expect(email).toHaveValue("");
  await expect(
    dialog.getByRole("checkbox", { name: "Console", exact: true }),
  ).not.toBeChecked();
  await email.fill("invalid-email");
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  expect(
    await email.evaluate(
      (element) => (element as HTMLInputElement).validity.typeMismatch,
    ),
  ).toBe(true);
  expect(submitted).toBe(0);
  await email.fill("retry@example.test");
  await dialog.getByRole("checkbox", { name: "Start", exact: true }).check();
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Fixture writes are disabled.",
  );
  await expect(email).toHaveValue("retry@example.test");
  await expect(
    dialog.getByRole("checkbox", { name: "Start", exact: true }),
  ).toBeChecked();
  expect(await users(request)).toEqual(baseline);
  deny = false;
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(submitted).toBe(2);
  const saved = await users(request);
  expect(
    saved.find((user) => user.email === "retry@example.test"),
  ).toMatchObject({
    email: "retry@example.test",
    permissions: ["control.start"],
  });
  expect(saved.filter((user) => user.email !== "retry@example.test")).toEqual(
    baseline,
  );
});

test("a failed invitation preserves the subuser and clipboard retries keep the same private link", async ({
  page,
  request,
  server,
}, testInfo) => {
  const unrelated = await request.post("/api/panel-users", {
    data: {
      email: `existing-invite-${server.id}@example.test`,
      permissions: ["file.read"],
      accessMode: "selected",
      serverIds: [server.id],
    },
  });
  expect(unrelated.status()).toBe(201);
  const baseline = await users(request);
  const invitationUrl =
    "https://203.0.113.10:3002/#invite=fixture-secret-token";
  await page.addInitScript(() => {
    const originalCommand = document.execCommand.bind(document);
    document.execCommand = (command, ...args) =>
      command === "copy" ? false : originalCommand(command, ...args);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard denied");
        },
      },
    });
  });
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
  let creates = 0;
  let invitations = 0;
  await page.route("**/api/panel-users", (route) => {
    if (route.request().method() === "POST") creates++;
    return route.continue();
  });
  await page.route("**/api/panel-users/*/invite", async (route) => {
    invitations++;
    expect(route.request().headers()["x-server-id"]).toBeUndefined();
    if (invitations === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Remote access is unavailable." },
      });
    const userId = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-2)!,
    );
    const user = (await users(request)).find((item) => item.id === userId);
    expect(user?.email).toBe("phone@example.test");
    return route.fulfill({
      json: {
        message: "Invitation link created.",
        invitationUrl,
        inviteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        user: {
          ...user,
          inviteStatus: "pending",
          invitedAt: new Date().toISOString(),
        },
      },
    });
  });
  await openSubusers(page, server.id);
  await expect(
    page.getByRole("heading", {
      name: "Remote access is configured",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New user", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Create new subuser",
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
  await expect(editor).toContainText("no email is sent");
  await editor
    .getByRole("button", { name: "Use Control preset", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "The subuser is saved" }),
  ).toContainText("Remote access is unavailable.");
  const saved = await users(request);
  const account = saved.find((user) => user.email === "phone@example.test");
  expect(saved.filter((user) => user.id !== account?.id)).toEqual(baseline);
  expect(account?.permissions).toEqual([
    "control.console",
    "control.start",
    "control.stop",
    "control.restart",
  ]);
  const row = page.getByRole("row").filter({ hasText: "phone@example.test" });
  await expect(row).toContainText("Not invited");
  await row
    .getByRole("button", {
      name: "Create invite link for phone@example.test",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Share invitation link",
    exact: true,
  });
  await showPermissionDetails(dialog);
  await expect(dialog).toBeVisible();
  const link = dialog.getByLabel("Invitation link", { exact: true });
  await expect(link).toHaveValue(invitationUrl);
  await expect(link).toHaveJSProperty("readOnly", true);
  await expect(dialog).toContainText("Works once. Expires");
  await expect(dialog).toContainText("at least 12 characters");
  await expect(row).toContainText("Link created · awaiting acceptance");
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Copy the selected link manually",
  );
  await expect(link).toHaveValue(invitationUrl);
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
  // Embedded browsers may not expose the async API. Copy must still select
  // the invitation inside the open modal, without creating another invite.
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
  await expect(dialog.getByRole("status")).toHaveText(
    "Invitation link copied.",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { fallbackCopy: unknown }).fallbackCopy,
    ),
  ).toEqual({ value: invitationUrl, inDialog: true });
  expect(creates).toBe(1);
  expect(invitations).toBe(2);
  const afterCopy = await users(request);
  expect(
    afterCopy.filter((user) => user.email === "phone@example.test"),
  ).toHaveLength(1);
  expect(
    afterCopy.filter((user) => user.email !== "phone@example.test"),
  ).toEqual(baseline);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "fixture-secret-token",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dialog.getByRole("button", { name: "Copy link", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("subusers-invitation-mobile.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Invitation link", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "The subuser is saved" }),
  ).toHaveCount(0);
});

test("resetting activated access explains immediate revocation and allows cancelling before creating a link", async ({
  page,
  server,
}) => {
  const user = {
    id: "activated-user",
    email: "activated@example.test",
    permissions: ["control.console"],
    createdAt: new Date().toISOString(),
    inviteStatus: "accepted",
    invitedAt: new Date().toISOString(),
  };
  await page.route("**/api/access/settings", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        publicUrl: "https://203.0.113.10:3002",
        port: 3002,
        transport: "direct",
        ready: true,
        listening: true,
      },
    }),
  );
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
  await page
    .getByRole("button", {
      name: "Reset access for activated@example.test",
      exact: true,
    })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Reset subuser access?",
    exact: true,
  });
  await showPermissionDetails(dialog);
  await expect(dialog).toContainText(
    "Their current password and sessions stop working immediately",
  );
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  expect(resets).toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(resets).toBe(0);
  await page
    .getByRole("button", {
      name: "Reset access for activated@example.test",
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Reset subuser access?",
    exact: true,
  });
  await showPermissionDetails(dialog);
  await dialog
    .getByRole("button", { name: "Reset and create link", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Share invitation link", exact: true }),
  ).toBeVisible();
  await expect(dialog).not.toBeVisible();
  expect(resets).toBe(1);
});

test("direct remote setup detects the public IP on request, supports a proxy, and surfaces listener failures", async ({
  page,
  server,
}, testInfo) => {
  const changes: Record<string, unknown>[] = [];
  const configured = {
    enabled: true,
    publicUrl: "https://203.0.113.10:3002",
    transport: "direct",
    port: 3002,
    ready: true,
    listening: true,
    certificate: {
      fingerprint256: "AA:BB:CC:DD:EE:FF",
      validTo: "2028-01-01T00:00:00Z",
      hosts: ["203.0.113.10"],
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
      return route.fulfill({
        json: {
          ...configured,
          ...(changes.length === 3
            ? {
                enabled: false,
                ready: false,
                listening: false,
                error: "Remote access port is already in use.",
              }
            : {}),
        },
      });
    const body = route.request().postDataJSON();
    changes.push(body);
    if (changes.length === 3)
      return route.fulfill({
        status: 409,
        json: { error: "Remote access port is already in use." },
      });
    return route.fulfill({ json: { ...configured, ...body } });
  });
  await openSubusers(page, server.id);
  await page.getByRole("button", { name: "Edit setup", exact: true }).click();
  const setup = page.getByRole("region", {
    name: "Remote access setup",
    exact: true,
  });
  expect(discoveries).toBe(0);
  await expect(
    setup.getByLabel("Certificate SHA-256 fingerprint", { exact: true }),
  ).toHaveValue(configured.certificate.fingerprint256);
  await expect(setup.getByText("Sending address", { exact: true })).toHaveCount(
    0,
  );
  await expect(setup.getByText("Resend API key", { exact: true })).toHaveCount(
    0,
  );
  await setup.getByLabel("Remote access port", { exact: true }).fill("3004");
  await setup
    .getByRole("button", { name: "Use my public IP", exact: true })
    .click();
  await expect(
    setup.getByLabel("Public panel address", { exact: true }),
  ).toHaveValue("https://203.0.113.20:3004");
  await expect(setup).not.toContainText("192.168.1.5");
  await expect(setup).not.toContainText("mobile data");
  await expect(setup).not.toContainText("Forward only the remote access port");
  await expect(setup).toContainText("Compare the certificate below.");
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
    publicUrl: "https://203.0.113.20:3004",
    transport: "direct",
    port: 3004,
  });
  await expect(
    setup.getByRole("button", { name: "Save access settings", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("subusers-access-setup-desktop.png"),
    fullPage: true,
  });
  await setup.getByText("Advanced connection options", { exact: true }).click();
  await setup
    .getByRole("checkbox", { name: "HTTPS handled by a proxy", exact: true })
    .check();
  await expect(setup).toContainText("http://127.0.0.1:3004");
  await setup
    .getByLabel("Public panel address", { exact: true })
    .fill("https://panel.example.test");
  await setup
    .getByRole("button", { name: "Save access settings", exact: true })
    .click();
  await expect.poll(() => changes.length).toBe(2);
  expect(changes[1].transport).toBe("proxy");
  await setup
    .getByRole("checkbox", { name: "HTTPS handled by a proxy", exact: true })
    .uncheck();
  await setup.getByLabel("Remote access port", { exact: true }).fill("80");
  await setup
    .getByRole("button", { name: "Save access settings", exact: true })
    .click();
  expect(changes).toHaveLength(2);
  await setup.getByLabel("Remote access port", { exact: true }).fill("3003");
  await setup
    .getByLabel("Public panel address", { exact: true })
    .fill("https://203.0.113.20:3003");
  await setup
    .getByRole("button", { name: "Save access settings", exact: true })
    .click();
  await expect.poll(() => changes.length).toBe(3);
  await expect(setup.getByRole("alert")).toContainText(
    "Remote access port is already in use.",
  );
  await expect(
    setup.getByRole("heading", { name: "Set up phone access", exact: true }),
  ).toBeVisible();
  await expect(
    setup.getByLabel("Remote access port", { exact: true }),
  ).toHaveValue("3003");
  await page.getByRole("button", { name: "New user", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("checkbox", { name: "Create invitation link", exact: true }),
  ).toBeDisabled();
});

test("permission groups and confirmation controls fit a mobile viewport", async ({
  page,
  server,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#subusers");
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await selectServer(page, server.id);
  await expect(
    page.getByRole("region", { name: "Remote access setup", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("subusers-access-setup-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "New user", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  await showPermissionDetails(dialog);
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("mobile@example.test");
  await dialog
    .getByRole("checkbox", { name: "All permissions", exact: true })
    .check();
  await dialog
    .getByRole("checkbox", { name: "Console", exact: true })
    .uncheck();
  await expect(
    dialog.getByRole("checkbox", { name: "All permissions", exact: true }),
  ).toHaveAttribute("aria-checked", "mixed");
  await expect(
    dialog.getByRole("checkbox", { name: "Select all Control", exact: true }),
  ).toHaveAttribute("aria-checked", "mixed");
  await expect(
    dialog.getByRole("checkbox", { name: "Select all Backups", exact: true }),
  ).toBeChecked();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("subuser-permissions-mobile.png"),
    fullPage: true,
  });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeInViewport();
  await cancel.click();
  await expect(dialog).not.toBeVisible();
});
