import { expect, test, type Page } from "@playwright/test";
import permissionCatalog from "../shared/subuser-permissions.json" with { type: "json" };

const sister = {
  role: "subuser",
  email: "sister@example.com",
  userId: "sister",
  serverId: "family",
  permissions: [
    "control.start",
    "control.stop",
    "control.restart",
    "control.console",
  ],
};
const password = "family server password";
const browserToken = "s".repeat(43);
const invitationOrigin = "https://invited.example.test";
async function signedOutSession(page: Page) {
  await page.addInitScript(() =>
    localStorage.removeItem("mc-panel.session.v1"),
  );
  await page.route("**/api/access/session", (route) =>
    route.fulfill({
      json:
        route.request().headers().authorization === `Bearer ${browserToken}`
          ? sister
          : { role: "guest" },
    }),
  );
}
async function invitation(page: Page, token: string) {
  await page.route("**/api/access/invitation", (route) =>
    route.fulfill({
      json: {
        email: sister.email,
        panelAddress: invitationOrigin,
        inviteExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    }),
  );
  await page.route(`${invitationOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) return route.fallback();
    return route.fulfill({
      response: await route.fetch({
        url: `http://127.0.0.1:3111${url.pathname}${url.search}`,
      }),
    });
  });
  await page.goto(`${invitationOrigin}/#invite=${token}`);
  await page
    .getByRole("button", { name: "Continue with invitation", exact: true })
    .click();
}
async function openConnections(page: Page) {
  const account = page.getByRole("button", { name: /^Account menu for/ });
  if (!(await account.isVisible()))
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await account.click();
  await page
    .getByRole("menuitem", { name: "Manage Connections", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Manage Connections", exact: true });
}
async function openSignIn(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: "Manage Connections",
    exact: true,
  });
  if (!(await dialog.isVisible())) await openConnections(page);
  const saved = dialog.getByRole("button", {
    name: `Sign in to ${new URL(page.url()).host}`,
    exact: true,
  });
  if (await saved.isVisible()) await saved.click();
  else
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Panel address", { exact: true })).toHaveValue(
    new URL(page.url()).origin,
  );
}
async function finishSignIn(page: Page) {
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  const close = page.getByRole("button", {
    name: "Close panel connections",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
}
async function signOut(page: Page) {
  const dialog = await openConnections(page);
  await dialog
    .getByRole("button", {
      name: `Sign out of ${new URL(page.url()).host}`,
      exact: true,
    })
    .click();
  await dialog
    .getByRole("button", { name: "Sign out of this panel", exact: true })
    .click();
}
const server = {
  id: "family",
  name: "Family survival",
  status: "offline",
  software: "Paper",
  minecraftVersion: "1.21",
  players: [],
  maxPlayers: 20,
  memory: 0,
  cpu: 0,
  cpuCapacity: 800,
  memoryLimit: 4 * 1024 ** 3,
  disk: 128 * 1024 ** 2,
  diskLimit: 1024 ** 4,
  uptime: 0,
  address: "play.example.com",
};
async function sharedEndpoints(page: Page, permissions = sister.permissions) {
  await page.addInitScript(
    (token) => localStorage.setItem("mc-panel.session.v1", token),
    browserToken,
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      json: { servers: [{ ...server, accessPermissions: permissions }] },
    }),
  );
  await page.route(/\/api\/server(?:\?|$)/, (route) =>
    route.fulfill({ json: server }),
  );
  await page.route(/\/api\/console(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        lines: [
          {
            id: 1,
            time: "12:00:00",
            level: "INFO",
            message: "Family server is ready.",
          },
        ],
      },
    }),
  );
}

test("an invitation opens controls only after a password is chosen and explicitly submitted", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await sharedEndpoints(page);
  await signedOutSession(page);
  const accepted: unknown[] = [];
  await page.route("**/api/access/accept", async (route) => {
    accepted.push(route.request().postDataJSON());
    await route.fulfill({ json: { ...sister, sessionToken: browserToken } });
  });
  await invitation(page, "i".repeat(43));
  await expect(
    page.getByRole("button", { name: "Set password and continue" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("mobile-invitation.png"),
    fullPage: true,
  });
  expect(accepted).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
  const newPassword = page.getByLabel("New password", { exact: true });
  const confirmation = page.getByLabel("Confirm password", { exact: true });
  await expect(newPassword).toHaveAttribute("type", "password");
  await expect(confirmation).toHaveAttribute("type", "password");
  await newPassword.fill(password);
  await confirmation.fill(password);
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .click();
  await expect(newPassword).toHaveAttribute("type", "text");
  await expect(confirmation).toHaveAttribute("type", "text");
  await page
    .getByRole("button", { name: "Hide password", exact: true })
    .click();
  await expect(newPassword).toHaveAttribute("type", "password");
  await expect(confirmation).toHaveAttribute("type", "password");
  await expect(newPassword).toHaveValue(password);
  await expect(confirmation).toHaveValue(password);
  expect(accepted).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Set password and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Family survival" }),
  ).toBeVisible();
  expect(accepted).toEqual([{ token: "i".repeat(43), password }]);
  await expect(page).not.toHaveURL(/invite=/);
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("log")).toContainText("Family server is ready.");
  await expect(
    page.getByRole("heading", { name: "Console", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Server resources" }),
  ).toBeVisible();
  await expect(page.locator(".metric-card")).toHaveCount(4);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("mobile-controls.png"),
    fullPage: true,
  });
});

test("a phone only offers granted controls and scopes every action to the shared server", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await sharedEndpoints(page, ["control.start"]);
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { ...sister, permissions: ["control.start"] } }),
  );
  let consoleRequests = 0;
  const forbiddenRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/console") consoleRequests++;
    if (/^\/api\/(desktop|files|backups|subusers|audit)(\/|$)/.test(pathname))
      forbiddenRequests.push(pathname);
  });
  const actions: unknown[] = [];
  await page.route(/\/api\/server\/power(?:\?|$)/, async (route) => {
    actions.push({
      body: route.request().postDataJSON(),
      server: route.request().headers()["x-server-id"],
    });
    await route.fulfill({ json: { status: "starting" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Server start requested.",
  );
  expect(actions).toEqual([{ body: { action: "start" }, server: "family" }]);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Restart", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("log")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Server command" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("link", { name: "File Manager", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Players", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = "files";
  });
  await expect(
    page.getByRole("heading", { name: "Console", exact: true }),
  ).toBeVisible();
  expect(forbiddenRequests).toEqual([]);
  expect(consoleRequests).toBe(0);
  await expect(
    page.getByRole("button", { name: "Add server", exact: true }),
  ).toHaveCount(0);
});

test("switching shared servers drops the previous console and uses the next membership's permissions", async ({
  page,
}) => {
  await sharedEndpoints(page);
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: sister }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      json: {
        servers: [
          { ...server, accessPermissions: sister.permissions },
          {
            ...server,
            id: "creative",
            name: "Creative world",
            accessPermissions: ["control.start"],
          },
        ],
      },
    }),
  );
  await page.route(/\/api\/server(?:\?|$)/, (route) =>
    route.fulfill({
      json:
        route.request().headers()["x-server-id"] === "creative"
          ? { ...server, name: "Creative world" }
          : server,
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("log")).toContainText("Family server is ready.");
  await page
    .getByRole("button", { name: "Select server Creative world" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Creative world", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("log")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("main").getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
});

for (const width of [1280, 390]) {
  test(`a granted remote user edits safe server settings and can return to Console at ${width}px`, async ({
    page,
  }) => {
    const permissions = ["server.update", "control.console"];
    await sharedEndpoints(page, permissions);
    await page.route("**/api/access/session", (route) =>
      route.fulfill({ json: { ...sister, permissions } }),
    );
    let settings = {
      ...server,
      mode: "live",
      launchType: "jar",
      settingsRevision: "initial-settings-revision",
      connectionHost: "play.example.com",
      port: 25565,
      memoryLimitMB: 2048,
      motd: "Family server",
      accessPermissions: permissions,
    };
    const patches: unknown[] = [];
    await page.route(/\/api\/server\/settings(?:\?|$)/, async (route) => {
      expect(route.request().headers()["x-server-id"]).toBe(server.id);
      if (route.request().method() === "PATCH") {
        const update = route.request().postDataJSON();
        patches.push(update);
        settings = { ...settings, ...update };
      }
      await route.fulfill({ json: { server: settings } });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#players");
    const openNavigation = async () => {
      if (width < 768)
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .click();
    };
    await openNavigation();
    await page
      .getByRole("button", {
        name: "Select server Family survival on 127.0.0.1:3111",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/#console$/);
    await expect(
      page.getByRole("heading", { name: "Console", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Rename server", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Server settings",
      exact: true,
    });
    await expect(dialog.getByLabel("Server name", { exact: true })).toHaveValue(
      server.name,
    );
    await expect(dialog.getByLabel("Server port", { exact: true })).toHaveValue(
      "25565",
    );
    await expect(dialog.getByLabel("Memory (MB)", { exact: true })).toHaveValue(
      "2048",
    );
    await expect(
      dialog.getByText("Launch method", { exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Remove server", exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByLabel("Server folder", { exact: true }),
    ).toHaveCount(0);
    await dialog
      .getByLabel("Server name", { exact: true })
      .fill("Family renamed");
    await dialog.getByLabel("Memory (MB)", { exact: true }).fill("3072");
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(patches).toEqual([
      {
        name: "Family renamed",
        memoryLimitMB: 3072,
        settingsRevision: "initial-settings-revision",
      },
    ]);
    await expect(page.getByRole("status")).toContainText("Server saved.");
    await openNavigation();
    const account = page.getByRole("button", {
      name: `Account menu for ${sister.email}`,
      exact: true,
    });
    await account.click();
    for (const name of [
      "Switch to this computer",
      "Disconnect from this panel",
      "Accept an invitation",
    ])
      await expect(
        page.getByRole("menuitem", { name, exact: true }),
      ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(account).toBeFocused();
  });
}

test("a fully shared account uses the complete desktop workspace and mobile navigation", async ({
  page,
}, testInfo) => {
  const permissions = permissionCatalog.groups.flatMap((group) =>
    group.permissions.map((permission) => permission.id),
  );
  await sharedEndpoints(page, permissions);
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { ...sister, permissions } }),
  );
  const ownerRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/desktop/")) ownerRequests.push(pathname);
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const pages = [
    "Console",
    "File Manager",
    "Players",
    "Versions",
    "Launchpad",
    "Properties",
    "Subusers",
    "Backups",
    "Audit Logs",
  ];
  for (const name of pages) {
    await expect(
      navigation.getByRole("link", { name, exact: true }),
    ).toBeVisible();
  }
  await expect(page.locator(".metric-card")).toHaveCount(4);
  await expect(page.getByRole("log")).toContainText("Family server is ready.");
  await expect(
    page.getByRole("button", { name: "Add server", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Server settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Rename server" })).toHaveCount(
    1,
  );
  await page.screenshot({
    path: testInfo.outputPath("shared-desktop-workspace.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(navigation).toBeHidden();
  await page.getByRole("button", { name: "Open navigation" }).click();
  for (const name of pages) {
    await expect(
      navigation.getByRole("link", { name, exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: `Account menu for ${sister.email}` }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  expect(ownerRequests).toEqual([]);
  await expect
    .poll(async () =>
      Math.round((await page.locator(".sidebar").boundingBox())!.x),
    )
    .toBe(0);
  await page.screenshot({
    path: testInfo.outputPath("shared-mobile-navigation.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: `Account menu for ${sister.email}` })
    .focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "MC Panel home" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(navigation).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeFocused();
});

test("an expired shared session leaves the workspace when an action returns 401", async ({
  page,
}) => {
  await sharedEndpoints(page, ["control.start"]);
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: sister }),
  );
  await page.route(/\/api\/server\/power(?:\?|$)/, (route) =>
    route.fulfill({ status: 401, json: { error: "Sign in again." } }),
  );
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel" }),
  ).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveCount(0);
});

test("a late response from a signed-out workspace cannot end the next session", async ({
  page,
}) => {
  await sharedEndpoints(page, ["control.start"]);
  await page.route("**/api/access/session", (route) =>
    route.fulfill({
      json: route.request().headers().authorization
        ? sister
        : { role: "guest" },
    }),
  );
  await page.route("**/api/access/logout", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/access/login", (route) =>
    route.fulfill({ json: { ...sister, sessionToken: browserToken } }),
  );
  let releaseResponse!: () => void;
  const pendingResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let finishRoute!: () => void;
  const routeDone = new Promise<void>((resolve) => {
    finishRoute = resolve;
  });
  await page.route(/\/api\/server\/power(?:\?|$)/, async (route) => {
    await pendingResponse;
    await route
      .fulfill({
        status: 401,
        json: { error: "Old session expired." },
      })
      .catch(() => {});
    finishRoute();
  });
  await page.goto("/");
  const requestReceived = page.waitForRequest(/\/api\/server\/power(?:\?|$)/);
  await page
    .getByRole("main")
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await requestReceived;
  await signOut(page);
  await openSignIn(page);
  await page.getByLabel("Email address").fill(sister.email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("form", { name: /^Sign in/ })
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await finishSignIn(page);
  await expect(page.getByRole("heading", { name: server.name })).toBeVisible();
  releaseResponse();
  await routeDone;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(
    page.getByRole("main").getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel" }),
  ).toHaveCount(0);
});

test("email and password sign-in opens the shared panel and logout returns to sign-in", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await sharedEndpoints(page);
  await signedOutSession(page);
  let requestedCredentials: unknown;
  await page.route("**/api/access/login", async (route) => {
    requestedCredentials = route.request().postDataJSON();
    await route.fulfill({ json: { ...sister, sessionToken: browserToken } });
  });
  await page.goto("/");
  await openSignIn(page);
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "autocomplete",
    "current-password",
  );
  await page.screenshot({
    path: testInfo.outputPath("mobile-sign-in.png"),
    fullPage: true,
  });
  await page.getByLabel("Email address").fill("sister@example.com");
  const passwordInput = page.getByLabel("Password", { exact: true });
  await expect(passwordInput).toHaveAttribute("type", "password");
  await passwordInput.fill(password);
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .focus();
  await page.keyboard.press("Space");
  await expect(passwordInput).toHaveAttribute("type", "text");
  await page
    .getByRole("button", { name: "Hide password", exact: true })
    .click();
  await expect(passwordInput).toHaveAttribute("type", "password");
  await expect(passwordInput).toHaveValue(password);
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .click();
  expect(requestedCredentials).toBeUndefined();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  await page
    .getByRole("form", { name: /^Sign in/ })
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await finishSignIn(page);
  await expect(
    page.getByRole("heading", { name: "Family survival" }),
  ).toBeVisible();
  expect(requestedCredentials).toEqual({
    email: "sister@example.com",
    password,
  });
  await page.route("**/api/access/logout", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await signOut(page);
  await openSignIn(page);
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(passwordInput).toHaveAttribute("type", "password");
  await expect(passwordInput).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Family survival" }),
  ).toHaveCount(0);
});

test("a new invitation and returning to sign-in hide and clear passwords", async ({
  page,
}) => {
  await signedOutSession(page);
  await invitation(page, "a".repeat(43));
  for (const field of ["New password", "Confirm password"]) {
    await page.getByLabel(field, { exact: true }).fill(password);
  }
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .click();
  await page.evaluate(() => {
    window.location.hash = `invite=${"b".repeat(43)}`;
  });
  await expect(page.getByLabel("Invitation link", { exact: true })).toHaveValue(
    `${invitationOrigin}/#invite=${"b".repeat(43)}`,
  );
  await page
    .getByRole("button", { name: "Continue with invitation", exact: true })
    .click();
  for (const field of ["New password", "Confirm password"]) {
    await expect(page.getByLabel(field, { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    await expect(page.getByLabel(field, { exact: true })).toHaveValue("");
  }
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close connection dialog", exact: true })
    .click();
  await openSignIn(page);
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
});

test("an invitation validates password length and confirmation before sending credentials", async ({
  page,
}) => {
  await signedOutSession(page);
  let acceptRequests = 0;
  await page.route("**/api/access/accept", (route) => {
    acceptRequests++;
    return route.fulfill({ json: sister });
  });
  await invitation(page, "v".repeat(43));
  const newPassword = page.getByLabel("New password", { exact: true });
  const confirmation = page.getByLabel("Confirm password", { exact: true });
  await expect(newPassword).toHaveAttribute("autocomplete", "new-password");
  await newPassword.fill("too short");
  await confirmation.fill("too short");
  await page.getByRole("button", { name: "Set password and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("12 and 128 characters");
  await newPassword.fill(password);
  await confirmation.fill("another password");
  await page.getByRole("button", { name: "Set password and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("passwords do not match");
  expect(acceptRequests).toBe(0);
  await expect(page).toHaveURL(`${invitationOrigin}/#invite=${"v".repeat(43)}`);
});

test("an expired invitation keeps its URL and offers a clear way back to sign-in", async ({
  page,
}) => {
  await signedOutSession(page);
  await page.route("**/api/access/accept", (route) =>
    route.fulfill({
      status: 401,
      json: { error: "This invitation link is invalid or expired." },
    }),
  );
  await invitation(page, "e".repeat(43));
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set password and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("invalid or expired");
  await expect(page).toHaveURL(`${invitationOrigin}/#invite=${"e".repeat(43)}`);
  await expect(page.getByLabel("Email address")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Back to invitation link", exact: true })
    .click();
  await expect(page.getByLabel("Invitation link", { exact: true })).toHaveValue(
    `${invitationOrigin}/#invite=${"e".repeat(43)}`,
  );
  await page
    .getByRole("button", { name: "Close connection dialog", exact: true })
    .click();
  await openSignIn(page);
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page).not.toHaveURL(/invite=/);
});

test("failed credentials stay on sign-in with the generic server error and allow a retry", async ({
  page,
}) => {
  await sharedEndpoints(page);
  await signedOutSession(page);
  let attempts = 0;
  await page.route("**/api/access/login", (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill({
          status: 401,
          json: { error: "Email or password is incorrect." },
        })
      : route.fulfill({ json: { ...sister, sessionToken: browserToken } });
  });
  await page.goto("/");
  await openSignIn(page);
  await page.getByLabel("Email address").fill("sister@example.com");
  await page.getByLabel("Password", { exact: true }).fill("incorrect password");
  await page
    .getByRole("form", { name: /^Sign in/ })
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Email or password is incorrect.",
  );
  await expect(
    page.getByRole("heading", { name: "Family survival" }),
  ).toHaveCount(0);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("form", { name: /^Sign in/ })
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await finishSignIn(page);
  await expect(
    page.getByRole("heading", { name: "Family survival" }),
  ).toBeVisible();
});

test("leaving the page during invitation acceptance ignores its late result", async ({
  page,
}) => {
  await signedOutSession(page);
  let finishAcceptance: (() => void) | undefined;
  let received: (() => void) | undefined;
  const requestReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const responseReady = new Promise<void>((resolve) => {
    finishAcceptance = resolve;
  });
  const routeDone = new Promise<void>((resolve) => {
    void page.route("**/api/access/accept", async (route) => {
      received?.();
      await responseReady;
      await route
        .fulfill({ json: { ...sister, sessionToken: browserToken } })
        .catch(() => {});
      resolve();
    });
  });
  await invitation(page, "p".repeat(43));
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set password and continue" }).click();
  await requestReceived;
  await expect(
    page.getByRole("button", { name: "Show password", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Close connection dialog" }),
  ).toBeEnabled();
  await page.goto(`${invitationOrigin}/`);
  finishAcceptance?.();
  await routeDone;
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Family survival" }),
  ).toHaveCount(0);
  await openSignIn(page);
  await expect(page.getByLabel("Email address")).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("mc-panel.session.v1")),
  ).toBeNull();
});

test("an unavailable new panel remains unsaved and never opens owner controls", async ({
  page,
}) => {
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ status: 503, json: { error: "Panel is unavailable" } }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create a new server", exact: true }),
  ).toHaveCount(0);
  const connections = await openConnections(page);
  await expect(connections).toContainText("No saved panel connections.");
  await openSignIn(page);
  await page.getByLabel("Email address").fill(sister.email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("form", { name: /^Sign in/ })
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Panel is unavailable");
  await expect(
    page
      .getByRole("form", { name: /^Sign in/ })
      .getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toHaveCount(0);
});

test("the mobile account menu stays onscreen and local sign-out completes when the host is unavailable", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await sharedEndpoints(page);
  await page.route("**/api/access/session", (route) =>
    route.fulfill({
      json:
        route.request().headers().authorization === `Bearer ${browserToken}`
          ? sister
          : { role: "guest" },
    }),
  );
  let attempts = 0;
  await page.route("**/api/access/logout", (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill({
          status: 503,
          json: { error: "Sign-out could not complete. Try again." },
        })
      : route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const account = page.getByRole("button", {
    name: `Account menu for ${sister.email}`,
  });
  await account.click();
  const menu = page.getByRole("menu", { name: "Account", exact: true });
  await expect(menu).toContainText(sister.email);
  const anchor = await account.boundingBox();
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(anchor!.y);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
  await page.screenshot({
    path: testInfo.outputPath("mobile-account-menu.png"),
  });
  await page
    .getByRole("menuitem", { name: "Manage Connections", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Sign out of 127.0.0.1:3111", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Sign out of this panel", exact: true })
    .click();
  await openSignIn(page);
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(account).toHaveCount(0);
  await expect.poll(() => attempts).toBe(1);
  expect(
    await page.evaluate(() => localStorage.getItem("mc-panel.session.v1")),
  ).toBeNull();
});
