import { expect, test, type Page } from "@playwright/test";

const startupServers = [
  { id: "survival", name: "Survival world", unavailable: false },
  { id: "creative", name: "Creative world", unavailable: false },
];

async function settingsFixture(
  page: Page,
  options: {
    desktop?: boolean;
    startAtLogin?: boolean;
    autoStartServerIds?: string[];
    startupSupported?: boolean;
    startupReason?: string;
    missingAutoStartServerIds?: string[];
    servers?: typeof startupServers;
  } = {},
) {
  let settings = {
    desktop: options.desktop ?? true,
    startAtLogin: options.startAtLogin ?? false,
    autoStartServerIds: options.autoStartServerIds ?? [],
    keepInTray: true,
    startupSupported: options.startupSupported ?? true,
    startupReason: options.startupReason,
    missingAutoStartServerIds: options.missingAutoStartServerIds ?? [],
  };
  const servers = options.servers ?? startupServers;
  let remote = {
    enabled: false,
    ready: false,
    publicUrl: "https://panel.example.test:3002",
    port: 3002,
    transport: "direct",
    listening: false,
  };
  const writes: unknown[] = [];
  const remoteWrites: unknown[] = [];
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { role: "owner" } }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      json: { servers, defaultServerId: servers[0]?.id ?? null },
    }),
  );
  await page.route("**/api/server", (route) =>
    route.fulfill({
      json: {
        ...servers[0],
        status: "offline",
        software: "Paper",
        minecraftVersion: "1.21.1",
        players: [],
        maxPlayers: 20,
        cpu: 0,
        memory: 0,
        memoryLimit: 2048,
        disk: 0,
        diskLimit: 1024,
      },
    }),
  );
  await page.route("**/api/console", (route) =>
    route.fulfill({ json: { lines: [] } }),
  );
  await page.route("**/api/panel-users", (route) =>
    route.fulfill({ json: { users: [], servers } }),
  );
  await page.route("**/api/desktop/settings", async (route) => {
    if (!settings.desktop)
      return route.fulfill({ status: 404, json: { error: "Not available" } });
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON());
      settings = { ...settings, ...route.request().postDataJSON() };
    }
    return route.fulfill({ json: settings });
  });
  await page.route("**/api/access/settings", async (route) => {
    if (route.request().method() === "PUT") {
      remoteWrites.push(route.request().postDataJSON());
      remote = { ...remote, ...route.request().postDataJSON() };
      remote.ready = remote.enabled;
      remote.listening = remote.enabled;
    }
    return route.fulfill({ json: remote });
  });
  return { writes, remoteWrites };
}

async function openSettings(page: Page) {
  await page
    .getByRole("button", { name: "Panel Settings", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Panel Settings", exact: true });
}

test("General settings save multiple automatic servers independently of sign-in and persist deselection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const { writes } = await settingsFixture(page);
  await page.goto("/");
  const dialog = await openSettings(page);
  await expect(
    dialog.getByRole("tab", { name: "General", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const login = dialog.getByRole("switch", {
    name: "Start MC Panel when I sign in",
    exact: true,
  });
  const tray = dialog.getByRole("switch", {
    name: "Keep MC Panel in the system tray",
    exact: true,
  });
  const picker = dialog.getByRole("button", {
    name: "Servers to start when the panel opens",
    exact: true,
  });
  const save = dialog.getByRole("button", {
    name: "Save settings",
    exact: true,
  });
  await login.check();
  await tray.uncheck();
  await picker.click();
  const survival = dialog.getByRole("checkbox", {
    name: "Survival world",
    exact: true,
  });
  const creative = dialog.getByRole("checkbox", {
    name: "Creative world",
    exact: true,
  });
  await dialog.getByText("Survival world", { exact: true }).click();
  await expect(survival).toBeChecked();
  await creative.check();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeVisible();
  await save.click();
  await expect(save).toBeDisabled();
  expect(writes).toEqual([
    {
      startAtLogin: true,
      autoStartServerIds: ["survival", "creative"],
      keepInTray: false,
    },
  ]);
  await dialog.getByRole("button", { name: "Close Panel Settings" }).click();
  await page.reload();
  await openSettings(page);
  await expect(login).toBeChecked();
  await expect(tray).not.toBeChecked();
  await picker.click();
  await expect(survival).toBeChecked();
  await expect(creative).toBeChecked();
  await creative.press("Tab");
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeVisible();
  await picker.click();
  await survival.uncheck();
  await login.uncheck();
  await save.click();
  await expect(save).toBeDisabled();
  expect(writes.at(-1)).toEqual({
    startAtLogin: false,
    autoStartServerIds: ["creative"],
    keepInTray: false,
  });
  if (!(await creative.isVisible())) await picker.click();
  await creative.uncheck();
  await save.click();
  await expect(save).toBeDisabled();
  expect(writes.at(-1)).toEqual({
    startAtLogin: false,
    autoStartServerIds: [],
    keepInTray: false,
  });
  await dialog.getByRole("button", { name: "Close Panel Settings" }).click();
  await openSettings(page);
  await picker.click();
  await expect(survival).not.toBeChecked();
  await expect(creative).not.toBeChecked();
});

test("unavailable automatic servers stay visible and can be removed from the selection", async ({
  page,
}) => {
  const { writes } = await settingsFixture(page, {
    autoStartServerIds: ["missing-world", "creative"],
    missingAutoStartServerIds: ["missing-world"],
    servers: [startupServers[0]!, { ...startupServers[1]!, unavailable: true }],
  });
  await page.goto("/");
  const dialog = await openSettings(page);
  await dialog
    .getByRole("button", {
      name: "Servers to start when the panel opens",
      exact: true,
    })
    .click();
  const missing = dialog.getByRole("checkbox", { name: /missing-world/ });
  const unavailable = dialog.getByRole("checkbox", { name: /Creative world/ });
  await expect(missing).toBeChecked();
  await expect(unavailable).toBeChecked();
  // Removing a missing server also removes its checkbox from the choices.
  await missing.click();
  await expect(missing).toHaveCount(0);
  await expect(unavailable).toBeVisible();
  await unavailable.uncheck();
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  expect(writes).toEqual([
    { startAtLogin: false, autoStartServerIds: [], keepInTray: true },
  ]);
});

test("an unsupported sign-in registration still allows automatic servers on manual launch", async ({
  page,
}) => {
  const { writes } = await settingsFixture(page, {
    startupSupported: false,
    startupReason:
      "Install the Setup edition to start MC Panel when you sign in.",
  });
  await page.goto("/");
  const dialog = await openSettings(page);
  await expect(
    dialog.getByRole("switch", {
      name: "Start MC Panel when I sign in",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(dialog).toContainText("Install the Setup edition");
  await dialog
    .getByRole("button", {
      name: "Servers to start when the panel opens",
      exact: true,
    })
    .click();
  await dialog
    .getByRole("checkbox", { name: "Survival world", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  expect(writes).toEqual([
    { startAtLogin: false, autoStartServerIds: ["survival"], keepInTray: true },
  ]);
});

test("General settings can open the desktop updater", async ({ page }) => {
  await settingsFixture(page);
  await page.route("**/api/desktop/updates**", (route) =>
    route.fulfill({
      json: {
        desktop: true,
        supported: true,
        version: "0.1.3-dev.0",
        channel: "dev",
        status: "idle",
        availableVersion: null,
        message: "",
      },
    }),
  );
  await page.goto("/");
  const dialog = await openSettings(page);
  await dialog
    .getByRole("button", { name: "App updates", exact: true })
    .click();
  const updates = page.getByRole("dialog", {
    name: "App updates on this computer",
    exact: true,
  });
  await expect(updates).toBeVisible();
  await expect(
    updates.getByRole("button", { name: "Check for updates", exact: true }),
  ).toBeVisible();
});

test("browser Panel Settings persists host Remote Access and fits a phone", async ({
  page,
}, testInfo) => {
  const { remoteWrites } = await settingsFixture(page, { desktop: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const dialog = await openSettings(page);
  await expect(dialog).toContainText(
    "Startup and system tray settings are managed in the desktop app.",
  );
  await expect(dialog).toContainText(
    "Use Manage Connections to manage this browser's panel sign-ins.",
  );
  await expect(
    dialog.getByRole("switch", {
      name: "Start MC Panel when I sign in",
      exact: true,
    }),
  ).toHaveCount(0);
  await dialog.getByRole("tab", { name: "Remote Access", exact: true }).click();
  await expect(
    dialog.getByRole("tab", { name: "Remote Access", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    dialog.getByRole("heading", { name: "Panel users", exact: true }),
  ).toBeVisible();
  await dialog
    .getByLabel("Public panel address", { exact: true })
    .fill("https://updated-panel.example.test:3002");
  await dialog.getByRole("tab", { name: "General", exact: true }).click();
  await dialog.getByRole("tab", { name: "Remote Access", exact: true }).click();
  await expect(
    dialog.getByLabel("Public panel address", { exact: true }),
  ).toHaveValue("https://updated-panel.example.test:3002");
  await dialog
    .getByRole("checkbox", { name: "Enable remote access", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Save access settings" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Remote access is configured" }),
  ).toBeVisible();
  expect(remoteWrites).toEqual([
    expect.objectContaining({
      enabled: true,
      publicUrl: "https://updated-panel.example.test:3002",
    }),
  ]);
  await page.screenshot({
    path: testInfo.outputPath("panel-settings-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);
  await dialog.getByRole("button", { name: "Close Panel Settings" }).click();
  await page.reload();
  await openSettings(page);
  await dialog.getByRole("tab", { name: "Remote Access", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit setup" }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "Enable remote access", exact: true }),
  ).toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "Enable remote access", exact: true })
    .uncheck();
  await dialog.getByRole("button", { name: "Save access settings" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Remote access", exact: true }),
  ).toBeVisible();
  expect(remoteWrites).toHaveLength(2);
  expect(remoteWrites[1]).toEqual(expect.objectContaining({ enabled: false }));
});

test("an invited account with no servers has no host settings or server controls", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("mc-panel.session.v1", "s".repeat(43)),
  );
  const calls: string[] = [];
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path === "/api/access/session")
      return route.fulfill({
        json: {
          role: "subuser",
          accountId: "invited",
          userId: "invited",
          email: "invited@example.test",
          serverId: null,
          permissions: [],
          hostPermissions: [],
        },
      });
    if (path === "/api/servers")
      return route.fulfill({
        json: { servers: [], defaultServerId: null, hostPermissions: [] },
      });
    return route.fulfill({ status: 403, json: { error: "No access" } });
  });
  await page.goto("/#subusers");
  await expect(
    page.getByRole("heading", { name: "No shared servers" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Panel Settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Panel Settings",
    exact: true,
  });
  await expect(
    settings.getByRole("tab", { name: "Remote Access", exact: true }),
  ).toHaveCount(0);
  await expect(settings).toContainText("Use Manage Connections");
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
  expect(calls).toEqual(
    expect.arrayContaining(["/api/access/session", "/api/servers"]),
  );
  expect(
    calls.filter(
      (path) => !["/api/access/session", "/api/servers"].includes(path),
    ),
  ).toEqual([]);
});

type ManagedSettingsFixture = {
  enabled: boolean;
  ready: boolean;
  publicUrl: string;
  port: number;
  transport: string;
  listening: boolean;
  error?: string;
  networkWarning?: string;
  managedHttps?: {
    state: string;
    ready: boolean;
    message: string;
    certificate?: { validTo: string };
  };
};

async function managedSettingsFixture(
  page: Page,
  initial: Partial<ManagedSettingsFixture> = {},
) {
  await settingsFixture(page, { desktop: false });
  const fixture = {
    settings: {
      enabled: false,
      ready: false,
      publicUrl: "",
      port: 3002,
      transport: "direct",
      listening: false,
      ...initial,
    } as ManagedSettingsFixture,
    writes: [] as Record<string, unknown>[],
    reads: 0,
    failRead: false,
  };
  await page.route("**/api/access/network", (route) =>
    route.fulfill({
      json: {
        publicIp: "203.0.113.20",
        localAddresses: ["192.168.1.5"],
        port: 3002,
      },
    }),
  );
  await page.route("**/api/panel-users", (route) =>
    route.fulfill({
      json: {
        users: [
          {
            id: "invited",
            email: "invited@example.test",
            panelAccount: true,
            inviteStatus: "pending",
            serverIds: ["survival"],
            permissions: ["server.view"],
          },
        ],
        servers: startupServers,
      },
    }),
  );
  await page.route("**/api/access/settings", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      fixture.writes.push(body);
      fixture.settings = {
        ...fixture.settings,
        ...body,
        ready: false,
        listening: true,
        error: undefined,
        managedHttps: {
          state: "provisioning",
          ready: false,
          message:
            "Requesting a trusted certificate. Check that TCP port 443 is forwarded to this computer.",
        },
      };
    } else {
      fixture.reads++;
      if (fixture.failRead) return route.abort("failed");
    }
    return route.fulfill({ json: fixture.settings });
  });
  return fixture;
}

test("new remote setup recommends trusted HTTPS on 443 and waits for the certificate without replacing edits", async ({
  page,
}, testInfo) => {
  const fixture = await managedSettingsFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const dialog = await openSettings(page);
  await dialog.getByRole("tab", { name: "Remote Access", exact: true }).click();
  const setup = dialog.getByRole("region", { name: "Remote access setup" });
  await expect(setup.getByLabel("HTTPS setup", { exact: true })).toHaveValue(
    "managed",
  );
  await expect(
    setup.getByLabel("Remote access port", { exact: true }),
  ).toHaveCount(0);
  await expect(
    setup.getByLabel("Internal service port", { exact: true }),
  ).not.toBeVisible();
  await expect(setup).toContainText("Forward TCP port 443");
  await expect(setup).toContainText("CGNAT");
  await setup
    .getByRole("button", { name: "Use my public IP", exact: true })
    .click();
  await expect(
    setup.getByLabel("Public panel address", { exact: true }),
  ).toHaveValue("https://203.0.113.20");
  const invite = dialog.getByRole("button", {
    name: "Create invite link for invited@example.test",
    exact: true,
  });
  await expect(invite).toBeDisabled();
  await setup
    .getByRole("checkbox", { name: "Enable remote access", exact: true })
    .check();
  await setup
    .getByRole("button", { name: "Save access settings", exact: true })
    .click();
  await expect(setup.getByRole("status")).toContainText(
    "Requesting a trusted certificate",
  );
  expect(fixture.writes).toEqual([
    {
      enabled: true,
      transport: "managed",
      publicUrl: "https://203.0.113.20",
      port: 3002,
    },
  ]);
  await expect(invite).toBeDisabled();
  await setup
    .getByLabel("Public panel address", { exact: true })
    .fill("https://unfinished.example.test");
  fixture.settings.ready = true;
  fixture.settings.networkWarning =
    "A different public IP was detected. Confirm your router’s address before updating it.";
  fixture.settings.managedHttps = {
    state: "ready",
    ready: true,
    message: "Your public address has a trusted certificate.",
    certificate: { validTo: "2028-01-01T00:00:00Z" },
  };
  await expect(setup.getByRole("status")).toContainText(
    "Trusted certificate is ready",
    { timeout: 10000 },
  );
  await expect(invite).toBeEnabled();
  await expect(setup.getByRole("status")).toContainText(
    "A different public IP was detected",
  );
  await expect(
    setup.getByLabel("Public panel address", { exact: true }),
  ).toHaveValue("https://unfinished.example.test");
  await expect(
    setup.getByRole("link", { name: "Open public panel" }),
  ).toHaveAttribute("href", "https://203.0.113.20");
  await expect(setup).toContainText("using mobile data to check access");
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("managed-https-mobile.png"),
    fullPage: true,
  });
});

for (const transport of ["direct", "proxy"]) {
  test(`existing ${transport} setup is retained until the owner explicitly selects trusted HTTPS`, async ({
    page,
  }) => {
    await managedSettingsFixture(page, {
      transport,
      publicUrl: "https://existing.example.test:3004",
      port: 3004,
    });
    await page.goto("/");
    const dialog = await openSettings(page);
    await dialog
      .getByRole("tab", { name: "Remote Access", exact: true })
      .click();
    const setup = dialog.getByRole("region", { name: "Remote access setup" });
    await expect(setup.getByLabel("HTTPS setup", { exact: true })).toHaveValue(
      transport,
    );
    await expect(
      setup.getByLabel("Public panel address", { exact: true }),
    ).toHaveValue("https://existing.example.test:3004");
    await expect(
      setup.getByLabel("Remote access port", { exact: true }),
    ).toHaveValue("3004");
    await setup
      .getByLabel("HTTPS setup", { exact: true })
      .selectOption("managed");
    await expect(
      setup.getByLabel("Public panel address", { exact: true }),
    ).toHaveValue("https://existing.example.test");
    await setup
      .getByText("Advanced connection options", { exact: true })
      .click();
    await expect(
      setup.getByLabel("Internal service port", { exact: true }),
    ).toHaveValue("3004");
  });
}

test("managed certificate failures and unavailable status disable invitations, retry recovers without losing accounts or draft edits", async ({
  page,
}) => {
  const fixture = await managedSettingsFixture(page, {
    enabled: true,
    transport: "managed",
    publicUrl: "https://203.0.113.20",
    listening: true,
    // Even a mismatched overall ready flag cannot enable invitation creation.
    ready: true,
    managedHttps: {
      state: "error",
      ready: false,
      message: "Port 443 is already in use. Close the other service and retry.",
    },
  });
  await page.goto("/");
  const dialog = await openSettings(page);
  await dialog.getByRole("tab", { name: "Remote Access", exact: true }).click();
  const setup = dialog.getByRole("region", { name: "Remote access setup" });
  const invite = dialog.getByRole("button", {
    name: "Create invite link for invited@example.test",
    exact: true,
  });
  await expect(setup.getByRole("status")).toContainText(
    "Port 443 is already in use",
  );
  await expect(invite).toBeDisabled();
  await setup
    .getByRole("button", { name: "Retry HTTPS setup", exact: true })
    .click();
  await expect(setup.getByRole("status")).toContainText(
    "Requesting a trusted certificate",
  );
  await expect.poll(() => fixture.writes.length).toBe(1);
  fixture.settings.ready = true;
  fixture.settings.managedHttps = {
    state: "ready",
    ready: true,
    message: "Your public address has a trusted certificate.",
  };
  await expect(invite).toBeEnabled({ timeout: 10000 });
  await setup
    .getByLabel("Public panel address", { exact: true })
    .fill("https://editing.example.test");
  fixture.failRead = true;
  await expect(setup.getByRole("status")).toContainText(
    "Unable to check certificate status",
    { timeout: 10000 },
  );
  await expect(invite).toBeDisabled();
  await expect(
    setup.getByLabel("Public panel address", { exact: true }),
  ).toHaveValue("https://editing.example.test");
  fixture.failRead = false;
  await expect(invite).toBeEnabled({ timeout: 10000 });
  await expect(
    setup.getByLabel("Public panel address", { exact: true }),
  ).toHaveValue("https://editing.example.test");
  expect(fixture.writes).toHaveLength(1);
  await expect(
    dialog.getByText("invited@example.test", { exact: true }),
  ).toBeVisible();
});
