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

test("an invitation opens controls only after an explicit acceptance", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
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
    page.getByRole("button", { name: "Accept invitation" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("mobile-invitation.png"),
    fullPage: true,
  });
  expect(accepted).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(
    page.getByRole("heading", { name: "Family survival" }),
  ).toBeVisible();
  expect(accepted).toEqual([{ token: "one-time-test-token" }]);
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

test("email sign-in gives a generic confirmation and logout returns to sign-in", async ({
  page,
}) => {
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { role: "guest" } }),
  );
  let requestedEmail = "";
  await page.route("**/api/access/login", async (route) => {
    requestedEmail = route.request().postDataJSON().email;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByLabel("Email address").fill("sister@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If this email has access",
  );
  expect(requestedEmail).toBe("sister@example.com");
  await sharedEndpoints(page);
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: sister }),
  );
  await page.route("**/api/access/logout", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.reload();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Family survival" }),
  ).toHaveCount(0);
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
