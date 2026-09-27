import { test, expect, type Page } from "@playwright/test";

const home = "http://127.0.0.1:3111";
const origins = ["https://a.example.test", "https://c.example.test"];
const permissions = ["server.view", "control.console", "control.start"];
const server = {
  id: "same-id",
  name: "Shared world",
  status: "offline",
  mode: "live",
  software: "Paper",
  minecraftVersion: "1.21.1",
  version: "1.21.1",
  address: "play.example.test",
  players: [],
  maxPlayers: 20,
  uptime: 0,
  cpu: 0,
  memory: 0,
  memoryLimit: 2048,
  disk: 0,
  diskLimit: 1024 ** 3,
  port: 25565,
  memoryLimitMB: 2048,
  jar: "server.jar",
  javaPath: "java",
  accessPermissions: permissions,
};
type Host = {
  token: string;
  active: boolean;
  servers: (typeof server)[];
  create: boolean;
  revoked?: boolean;
};

async function fixture(
  page: Page,
  role: "owner" | "guest" | "subuser" = "guest",
  homeOrigin = home,
) {
  const hosts = new Map<string, Host>(
    [homeOrigin, ...origins].map((origin, index) => [
      origin,
      {
        token: String(index + 1).repeat(43),
        active: origin === homeOrigin && role === "subuser",
        servers: origin === homeOrigin ? [] : [server],
        create: false,
      },
    ]),
  );
  const calls: {
    origin: string;
    path: string;
    method: string;
    authorization?: string;
    client?: string;
    serverId?: string;
    body: any;
  }[] = [];
  if (role === "subuser")
    await page.addInitScript(
      (token) => localStorage.setItem("mc-panel.session.v1", token),
      hosts.get(homeOrigin)!.token,
    );
  const session = (origin: string) => ({
    role: "subuser",
    accountId: `account-${new URL(origin).hostname}`,
    userId: `user-${new URL(origin).hostname}`,
    email: `${new URL(origin).hostname}@example.test`,
    serverId: null,
    permissions,
    hostPermissions: hosts.get(origin)!.create ? ["server.create"] : [],
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      host = hosts.get(url.origin);
    if (!host) return route.abort();
    const headers = request.headers();
    const cors = {
      "Access-Control-Allow-Origin": homeOrigin,
      "Access-Control-Allow-Headers":
        "authorization,content-type,x-mc-panel-client,x-server-id",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    };
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: cors });
    calls.push({
      origin: url.origin,
      path: url.pathname,
      method: request.method(),
      authorization: headers.authorization,
      client: headers["x-mc-panel-client"],
      serverId: headers["x-server-id"],
      body: request.postDataJSON(),
    });
    const reply = (body: unknown, status = 200) =>
      route.fulfill({ status, headers: cors, json: body });
    const authorized =
      host.active && headers.authorization === `Bearer ${host.token}`;
    if (url.pathname === "/api/access/session") {
      if (url.origin === homeOrigin && role === "owner")
        return reply({ role: "owner" });
      return reply(
        authorized && !host.revoked
          ? session(url.origin)
          : { role: "guest", ...(host.revoked ? { accessRevoked: true } : {}) },
      );
    }
    if (["/api/access/login", "/api/access/accept"].includes(url.pathname)) {
      host.active = true;
      return reply({ ...session(url.origin), sessionToken: host.token });
    }
    if (url.pathname === "/api/access/logout") {
      host.active = false;
      return reply({ ok: true });
    }
    if (url.origin !== homeOrigin || role !== "owner") {
      if (!authorized || host.revoked)
        return reply(
          {
            error: "Sign in required",
            ...(host.revoked ? { accessRevoked: true } : {}),
          },
          401,
        );
    }
    if (url.pathname === "/api/servers")
      return reply({
        servers: host.servers,
        defaultServerId: host.servers[0]?.id ?? null,
        hostPermissions: host.create ? ["server.create"] : [],
      });
    if (url.pathname === "/api/server")
      return reply(
        host.servers.find((item) => item.id === headers["x-server-id"]) ??
          server,
      );
    if (url.pathname === "/api/players")
      return reply({
        mode: "live",
        status: "offline",
        online: [],
        history: [],
        operators: [],
        banned: [],
        whitelist: [],
      });
    if (url.pathname === "/api/console")
      return reply({
        lines: [
          {
            id: 1,
            time: "12:00:00",
            level: "INFO",
            message: `Console from ${url.host}`,
          },
        ],
      });
    if (url.pathname === "/api/server/power") return reply({ ok: true });
    if (url.pathname === "/api/desktop/settings")
      return reply({ desktop: false });
    if (url.pathname === "/api/desktop/updates")
      return reply({ desktop: false, supported: false });
    if (url.pathname === "/api/server/software")
      return reply({ software: [], java: [] });
    if (url.pathname === "/api/server-setup")
      return reply({
        providers: [],
        platforms: [],
        gameVersions: [],
        hostMemoryMB: 8192,
        java: { available: false },
      });
    return reply({ error: `Unexpected fixture endpoint ${url.pathname}` }, 404);
  });
  return { hosts, calls };
}

async function manage(page: Page) {
  await page.getByRole("button", { name: /^Account menu for/ }).click();
  await page
    .getByRole("menuitem", { name: "Manage Connections", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Manage Connections", exact: true });
}

async function signIn(page: Page, origin: string) {
  const dialog = await manage(page);
  await dialog
    .getByRole("button", { name: "Sign in to existing panel", exact: true })
    .click();
  await dialog.getByLabel("Panel address", { exact: true }).fill(origin);
  await dialog
    .getByRole("button", { name: "Continue to sign in", exact: true })
    .click();
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("member@example.test");
  await dialog
    .getByLabel("Password", { exact: true })
    .fill("browser-password-123");
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    dialog.getByRole("button", {
      name: `Sign out of ${new URL(origin).host}`,
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close panel connections", exact: true })
    .click();
}

test("browser owner uses shared account menus and host settings capabilities", async ({
  page,
}) => {
  const { calls } = await fixture(page, "owner");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.mcPanelConnections?.runtime)).toBe(
    "browser",
  );
  await expect(
    page.getByRole("button", { name: "Create a new server", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Account menu for Local administrator/ })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Add Panel", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Manage Connections", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close panel connections", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Panel Settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Panel Settings",
    exact: true,
  });
  await expect(
    settings.getByRole("tab", { name: "General", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("tab", { name: "Remote Access", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => calls.some((call) => call.path === "/api/desktop/settings"))
    .toBe(true);
  expect(calls.some((call) => call.path.includes("/desktop/preferences"))).toBe(
    false,
  );
});

test("browser member with zero servers retains their account without local owner controls", async ({
  page,
}) => {
  const { calls } = await fixture(page, "subuser");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "No shared servers", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /^Account menu for 127.0.0.1@example.test/,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Local administrator", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create a new server", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "Servers on this computer", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Panel Settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Panel Settings",
    exact: true,
  });
  await expect(
    settings.getByRole("tab", { name: "General", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("tab", { name: "Remote Access", exact: true }),
  ).toHaveCount(0);
  expect(
    calls.filter(
      (call) =>
        call.path.startsWith("/api/desktop/") ||
        call.path.startsWith("/api/panel-users"),
    ),
  ).toEqual([]);
  expect(
    calls
      .filter((call) => call.path === "/api/servers")
      .every((call) => call.authorization === `Bearer ${"1".repeat(43)}`),
  ).toBe(true);
});

test("browser restores the requested page and recovers a removed local selection", async ({
  page,
}) => {
  const { hosts } = await fixture(page, "owner");
  hosts.get(home)!.servers = [server];
  await page.goto("/#players");
  await expect(
    page.getByRole("button", {
      name: "Select server Shared world on This computer",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(`${home}/#players`);
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Select server Shared world on This computer",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(`${home}/#players`);
  hosts.get(home)!.servers = [];
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel", exact: true }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.mcPanelConnections!.list()))
      .selectedServer,
  ).toBeNull();
  hosts.get(home)!.servers = [
    { ...server, id: "new-id", name: "Replacement world" },
  ];
  const persisted = await page.evaluate(async () => {
    await window.mcPanelConnections!.selectServer!("local", "new-id");
    // Let the renderer observe the new selection while its previous empty
    // roster is still displayed. That old read cannot revoke this choice.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return (await window.mcPanelConnections!.list()).selectedServer;
  });
  expect(persisted).toEqual({ panelId: "local", serverId: "new-id" });
  await expect(
    page.getByRole("button", {
      name: "Select server Replacement world on This computer",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(`${home}/#players`);
});

test("browser invitation opens shared Add Panel with its complete link", async ({
  page,
}) => {
  const invitationOrigin = "https://invited.example.test";
  await page.route(`${invitationOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) return route.fallback();
    const response = await route.fetch({
      url: `${home}${url.pathname}${url.search}`,
    });
    return route.fulfill({ response });
  });
  const { calls } = await fixture(page, "guest", invitationOrigin);
  const invitation = `${invitationOrigin}/#invite=${"i".repeat(43)}`;
  await page.goto(invitation);
  const dialog = page.getByRole("dialog", { name: "Add Panel", exact: true });
  await expect(
    dialog.getByLabel("Invitation link", { exact: true }),
  ).toHaveValue(invitation);
  await dialog
    .getByRole("button", { name: "Continue with invitation", exact: true })
    .click();
  await dialog
    .getByLabel("New password", { exact: true })
    .fill("browser-password-123");
  await dialog
    .getByLabel("Confirm password", { exact: true })
    .fill("browser-password-123");
  await dialog
    .getByRole("button", { name: "Set password and continue", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No shared servers", exact: true }),
  ).toBeVisible();
  expect(page.url()).toBe(`${invitationOrigin}/`);
  expect(
    calls.find((call) => call.path === "/api/access/accept")?.body,
  ).toEqual({ token: "i".repeat(43), password: "browser-password-123" });
});

test("browser combines colliding servers from two HTTPS panels and signs out only one", async ({
  page,
}) => {
  const { calls } = await fixture(page);
  await page.goto("/");
  await signIn(page, origins[0]);
  await signIn(page, origins[1]);
  for (const origin of origins) {
    const host = new URL(origin).host;
    await page
      .getByRole("button", {
        name: `Select server Shared world on ${host}`,
        exact: true,
      })
      .click();
    await expect(
      page.getByText(`Console from ${host}`, { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("group", {
        name: "Power controls for Shared world",
        exact: true,
      })
      .getByRole("button", { name: "Start", exact: true })
      .click();
    await expect
      .poll(() =>
        calls.some(
          (call) => call.origin === origin && call.path === "/api/server/power",
        ),
      )
      .toBe(true);
  }
  const power = calls.filter((call) => call.path === "/api/server/power");
  expect(
    power.map((call) => [
      call.origin,
      call.authorization,
      call.serverId,
      call.client,
    ]),
  ).toEqual(
    origins.map((origin, index) => [
      origin,
      `Bearer ${String(index + 2).repeat(43)}`,
      "same-id",
      "browser",
    ]),
  );
  expect(page.context().pages()).toHaveLength(1);
  expect(new URL(page.url()).origin).toBe(home);
  await page.reload();
  await expect(
    page.getByRole("list", { name: "Servers on a.example.test", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Servers on c.example.test", exact: true }),
  ).toBeVisible();
  const dialog = await manage(page);
  await dialog
    .getByRole("button", { name: "Sign out of a.example.test", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Sign out of this panel", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: "Sign in to a.example.test",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Sign out of c.example.test",
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close panel connections", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Select server Shared world on a.example.test",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Select server Shared world on c.example.test",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    calls
      .filter((call) => call.path === "/api/access/logout")
      .map((call) => call.origin),
  ).toEqual([origins[0]]);
});

test("browser removes verified revoked panel while connections is open and retains other panels", async ({
  page,
}) => {
  const { hosts } = await fixture(page);
  await page.goto("/");
  await signIn(page, origins[0]);
  await signIn(page, origins[1]);
  const dialog = await manage(page);
  hosts.get(origins[0])!.revoked = true;
  await expect(
    dialog.getByRole("button", {
      name: "Sign out of a.example.test",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText("https://a.example.test", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", {
      name: "Sign out of c.example.test",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Sign in to 127.0.0.1:3111",
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close panel connections", exact: true })
    .click();
  await expect(
    page.getByRole("list", { name: "Servers on a.example.test", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "Servers on c.example.test", exact: true }),
  ).toBeVisible();
});

test("browser creation and import use only the host that granted creation access", async ({
  page,
}) => {
  const { hosts, calls } = await fixture(page);
  for (const origin of origins) hosts.get(origin)!.servers = [];
  hosts.get(origins[1])!.create = true;
  await page.goto("/");
  await signIn(page, origins[0]);
  await expect(
    page.getByRole("button", { name: "Create a new server", exact: true }),
  ).toHaveCount(0);
  await signIn(page, origins[1]);
  await page
    .getByRole("button", { name: "Create a new server", exact: true })
    .click();
  await expect(page.locator(".setup-host-context")).toContainText(
    "c.example.test",
  );
  await expect
    .poll(() =>
      calls
        .filter((call) => call.path === "/api/server-setup")
        .map((call) => call.origin),
    )
    .toEqual([origins[1]]);
  await page
    .getByRole("button", { name: "Close add server", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Import an existing server", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Import an existing server",
      exact: true,
    }),
  ).toContainText("Server PC: c.example.test");
  expect(
    calls.some(
      (call) => call.path === "/api/server-setup" && call.origin === home,
    ),
  ).toBe(false);
});
