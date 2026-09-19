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
} from "@playwright/test";
import catalog from "../shared/subuser-permissions.json" with { type: "json" };

const permissionIds = catalog.groups.flatMap((group) =>
  group.permissions.map((permission) => permission.id),
);
type Fixture = { id: string; otherServerId: string };
const test = base.extend<{ server: Fixture }>({
  server: async ({ request }, use) => {
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

async function users(request: APIRequestContext, id: string) {
  const response = await request.get("/api/subusers", {
    headers: { "X-Server-Id": id },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).users as {
    id: string;
    email: string;
    permissions: string[];
  }[];
}

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
  await expect(dialog).toContainText("No invitation will be sent");
  await expect(
    dialog.getByRole("checkbox", {
      name: "Send invitation by email",
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
    (await users(request, server.id)).find((user) => user.email === email)
      ?.permissions,
  ).toEqual(expected);
  expect(
    (await users(request, server.otherServerId)).some(
      (user) => user.email === email,
    ),
  ).toBe(false);
  await page.reload();
  await page
    .getByRole("button", { name: `Edit permissions for ${email}`, exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Edit subuser permissions",
    exact: true,
  });
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
    (await users(request, server.id)).find((user) => user.email === email)
      ?.permissions,
  ).toEqual(updated);
  await page
    .getByRole("button", { name: `Edit permissions for ${email}`, exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Edit subuser permissions",
    exact: true,
  });
  await expect(
    dialog.getByRole("checkbox", { name: "Select all Files", exact: true }),
  ).not.toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "All permissions", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    (await users(request, server.id)).find((user) => user.email === email)
      ?.permissions,
  ).toEqual(updated);
});

test("subuser cancellation and save errors preserve deliberate selections without premature writes", async ({
  page,
  request,
  server,
}) => {
  await openSubusers(page, server.id);
  let deny = true;
  let submitted = 0;
  await page.route("**/api/subusers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submitted++;
    expect(route.request().headers()["x-server-id"]).toBe(server.id);
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
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("cancelled@example.test");
  await dialog.getByRole("checkbox", { name: "Console", exact: true }).check();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(submitted).toBe(0);
  expect(await users(request, server.id)).toEqual([]);
  await page.getByRole("button", { name: "New user", exact: true }).click();
  dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
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
  expect(await users(request, server.id)).toEqual([]);
  deny = false;
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(submitted).toBe(2);
  expect((await users(request, server.id))[0]).toMatchObject({
    email: "retry@example.test",
    permissions: ["control.start"],
  });
});

test("a failed invitation preserves the created subuser and retry sends without duplicate creation", async ({
  page,
  request,
  server,
}) => {
  await page.route("**/api/access/settings", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        publicUrl: "https://panel.example.test",
        from: "panel@example.test",
        emailConfigured: true,
        port: 3002,
        ready: true,
        listening: true,
      },
    }),
  );
  let creates = 0;
  let invitations = 0;
  await page.route("**/api/subusers", (route) => {
    if (route.request().method() === "POST") creates++;
    return route.continue();
  });
  await page.route("**/api/subusers/*/invite", async (route) => {
    invitations++;
    expect(route.request().headers()["x-server-id"]).toBe(server.id);
    if (invitations === 1)
      return route.fulfill({
        status: 502,
        json: { error: "Email delivery is unavailable." },
      });
    const user = (await users(request, server.id))[0];
    return route.fulfill({
      json: {
        message: "Invitation sent.",
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
      name: "Invitations are configured",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New user", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("phone@example.test");
  await expect(
    dialog.getByRole("checkbox", {
      name: "Send invitation by email",
      exact: true,
    }),
  ).toBeChecked();
  await dialog
    .getByRole("button", { name: "Use Control preset", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "The subuser is saved" }),
  ).toContainText("Email delivery is unavailable.");
  const saved = await users(request, server.id);
  expect(saved).toHaveLength(1);
  expect(saved[0].permissions).toEqual([
    "control.console",
    "control.start",
    "control.stop",
    "control.restart",
  ]);
  const row = page.getByRole("row").filter({ hasText: "phone@example.test" });
  await expect(row).toContainText("Not invited");
  await row
    .getByRole("button", {
      name: "Send invitation to phone@example.test",
      exact: true,
    })
    .click();
  await expect(row).toContainText("Invitation sent · awaiting sign-in");
  await expect(
    row.getByRole("button", {
      name: "Resend invitation to phone@example.test",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole("alert").filter({ hasText: "The subuser is saved" }),
  ).toHaveCount(0);
  expect(creates).toBe(1);
  expect(invitations).toBe(2);
  expect(await users(request, server.id)).toHaveLength(1);
});

test("remote setup keeps saved email keys private and surfaces listener failures", async ({
  page,
  server,
}, testInfo) => {
  const changes: Record<string, unknown>[] = [];
  const configured = {
    enabled: true,
    publicUrl: "https://panel.example.test",
    from: "panel@example.test",
    emailConfigured: true,
    port: 3002,
    ready: true,
    listening: true,
  };
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
    return route.fulfill({
      json: {
        ...configured,
        ...body,
        apiKey: undefined,
      },
    });
  });
  await openSubusers(page, server.id);
  await page.getByRole("button", { name: "Edit setup", exact: true }).click();
  const setup = page.getByRole("region", {
    name: "Remote access setup",
    exact: true,
  });
  await page.screenshot({
    path: testInfo.outputPath("subusers-access-setup-desktop.png"),
    fullPage: true,
  });
  await expect(setup.getByLabel("Resend API key", { exact: true })).toHaveValue(
    "",
  );
  await setup
    .getByLabel("Sending address", { exact: true })
    .fill("MC Panel <new@example.test>");
  await setup
    .getByRole("button", { name: "Save access settings", exact: true })
    .click();
  await expect.poll(() => changes.length).toBe(1);
  expect(changes[0]).toEqual({
    enabled: true,
    publicUrl: configured.publicUrl,
    from: "MC Panel <new@example.test>",
    port: 3002,
  });
  await expect(
    setup.getByRole("button", { name: "Save access settings", exact: true }),
  ).toBeEnabled();
  await setup
    .getByLabel("Resend API key", { exact: true })
    .fill("re_fixture_replacement");
  await setup
    .getByRole("button", { name: "Save access settings", exact: true })
    .click();
  await expect.poll(() => changes.length).toBe(2);
  expect(changes[1].apiKey).toBe("re_fixture_replacement");
  await expect(setup.getByLabel("Resend API key", { exact: true })).toHaveValue(
    "",
  );
  await setup.getByLabel("Remote access port", { exact: true }).fill("3003");
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
      .getByRole("checkbox", { name: "Send invitation by email", exact: true }),
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
