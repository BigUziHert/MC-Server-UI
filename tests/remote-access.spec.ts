import { expect, test, type Page } from "@playwright/test";

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
const server = {
  id: "family",
  name: "Family survival",
  status: "offline",
  software: "Paper",
  minecraftVersion: "1.21",
  players: [],
  maxPlayers: 20,
  memory: 0,
  address: "play.example.com",
};
async function sharedEndpoints(page: Page, permissions = sister.permissions) {
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      json: { servers: [{ ...server, accessPermissions: permissions }] },
    }),
  );
  await page.route("**/api/server", (route) => route.fulfill({ json: server }));
  await page.route("**/api/console", (route) =>
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
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { role: "guest" } }),
  );
  const accepted: unknown[] = [];
  await page.route("**/api/access/accept", async (route) => {
    accepted.push(route.request().postDataJSON());
    await route.fulfill({ json: sister });
  });
  await page.goto("/#invite=one-time-test-token");
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
  await expect(confirmation).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show confirm password" }).click();
  await expect(confirmation).toHaveAttribute("type", "text");
  await page
    .getByRole("button", { name: "Hide password", exact: true })
    .click();
  await page.getByRole("button", { name: "Hide confirm password" }).click();
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
  expect(accepted).toEqual([{ token: "one-time-test-token", password }]);
  await expect(page).not.toHaveURL(/invite=/);
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("log")).toContainText("Family server is ready.");
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
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/console") consoleRequests++;
  });
  const actions: unknown[] = [];
  await page.route("**/api/server/power", async (route) => {
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
    page.getByRole("textbox", { name: "Console command" }),
  ).toHaveCount(0);
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
  await page.route("**/api/server", (route) =>
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
    .getByRole("combobox", { name: "Select shared server" })
    .selectOption("creative");
  await expect(
    page.getByRole("heading", { name: "Creative world", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("log")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
});

test("email and password sign-in opens the shared panel and logout returns to sign-in", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await sharedEndpoints(page);
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { role: "guest" } }),
  );
  let requestedCredentials: unknown;
  await page.route("**/api/access/login", async (route) => {
    requestedCredentials = route.request().postDataJSON();
    await route.fulfill({ json: sister });
  });
  await page.goto("/");
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
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
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
  await page
    .getByRole("button", { name: "Account menu for sister@example.com" })
    .click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
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
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { role: "guest" } }),
  );
  await page.goto("/#invite=first-token");
  for (const field of ["New password", "Confirm password"]) {
    await page.getByLabel(field, { exact: true }).fill(password);
  }
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .click();
  await page.getByRole("button", { name: "Show confirm password" }).click();
  await page.evaluate(() => {
    window.location.hash = "invite=second-token";
  });
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
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
});

test("an invitation validates password length and confirmation before sending credentials", async ({
  page,
}) => {
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { role: "guest" } }),
  );
  let acceptRequests = 0;
  await page.route("**/api/access/accept", (route) => {
    acceptRequests++;
    return route.fulfill({ json: sister });
  });
  await page.goto("/#invite=password-validation-token");
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
  await expect(page).toHaveURL(/invite=password-validation-token/);
});

test("an expired invitation keeps its URL and offers a clear way back to sign-in", async ({
  page,
}) => {
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { role: "guest" } }),
  );
  await page.route("**/api/access/accept", (route) =>
    route.fulfill({
      status: 401,
      json: { error: "This invitation link is invalid or expired." },
    }),
  );
  await page.goto("/#invite=expired-token");
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set password and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "This invitation is unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText("Ask the server owner for a new invitation link.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("invalid or expired");
  await expect(page).toHaveURL(/invite=expired-token/);
  await expect(page.getByLabel("Email address")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome to your server" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page).toHaveURL(/invite=expired-token/);
});

test("failed credentials stay on sign-in with the generic server error and allow a retry", async ({
  page,
}) => {
  await sharedEndpoints(page);
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { role: "guest" } }),
  );
  let attempts = 0;
  await page.route("**/api/access/login", (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill({
          status: 401,
          json: { error: "Email or password is incorrect." },
        })
      : route.fulfill({ json: sister });
  });
  await page.goto("/");
  await page.getByLabel("Email address").fill("sister@example.com");
  await page.getByLabel("Password", { exact: true }).fill("incorrect password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Email or password is incorrect.",
  );
  await expect(
    page.getByRole("heading", { name: "Family survival" }),
  ).toHaveCount(0);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Family survival" }),
  ).toBeVisible();
});

test("leaving an invitation cancels a pending acceptance and ignores its late result", async ({
  page,
}) => {
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { role: "guest" } }),
  );
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
      await route.fulfill({ json: sister }).catch(() => {});
      resolve();
    });
  });
  await page.goto("/#invite=pending-token");
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set password and continue" }).click();
  await requestReceived;
  await expect(
    page.getByRole("button", { name: "Show password", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Show confirm password" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(page.getByLabel("Email address")).toBeVisible();
  finishAcceptance?.();
  await routeDone;
  await expect(
    page.getByRole("heading", { name: "Welcome to your server" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Family survival" }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(/invite=pending-token/);
});

test("an unavailable session endpoint never opens owner controls", async ({
  page,
}) => {
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ status: 503, json: { error: "Panel is unavailable" } }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Unable to connect" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toHaveCount(0);
});

test("the mobile account menu stays onscreen and a failed sign-out can be retried", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await sharedEndpoints(page);
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: sister }),
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
  const account = page.getByRole("button", {
    name: `Account menu for ${sister.email}`,
  });
  await account.click();
  const menu = page.getByRole("menu", { name: "Account", exact: true });
  await expect(menu).toContainText(sister.email);
  const anchor = await account.boundingBox();
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
  await page.screenshot({
    path: testInfo.outputPath("mobile-account-menu.png"),
  });
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Sign-out could not complete. Try again.",
  );
  await expect(
    page.getByRole("heading", { name: "Family survival" }),
  ).toBeVisible();
  await account.click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(account).toHaveCount(0);
  expect(attempts).toBe(2);
});
