import { expect, test, type Page } from "@playwright/test";

async function workspace(page: Page, offline = false) {
  await page.addInitScript(
    ({ offline }) => {
      const session = (id: string, email = `${id}@example.test`) => ({
        role: "subuser",
        accountId: id,
        userId: id,
        email,
        serverId: "same-id",
        permissions: ["server.view"],
        hostPermissions: [],
      });
      const server = {
        id: "same-id",
        name: "Same world",
        status: "offline",
        accessPermissions: ["server.view"],
        software: "Paper",
        version: "1.21.1",
        mode: "live",
        address: "play.example.test:25565",
        players: [],
        memoryLimitMB: 2048,
        port: 25565,
        jar: "server.jar",
        javaPath: "java",
      };
      const state: any = {
        unified: true,
        selectedServer: { panelId: "local", serverId: "local-id" },
        localServers: [{ ...server, id: "local-id", name: "Local world" }],
        panels: [
          {
            id: "local",
            label: "This computer",
            origin: location.origin,
            local: true,
            signedIn: true,
            sessionEpoch: "local",
            connectionState: "connected",
            servers: [],
          },
          {
            id: "computer-a",
            label: "a.example.test:3002",
            origin: "https://a.example.test:3002",
            local: false,
            signedIn: true,
            session: session("computer-a"),
            sessionEpoch: "a-1",
            connectionState: offline ? "unavailable" : "connected",
            servers: [
              {
                ...server,
                ...(offline ? { accessPermissions: undefined } : {}),
              },
            ],
          },
          {
            id: "computer-c",
            label: "c.example.test:3002",
            origin: "https://c.example.test:3002",
            local: false,
            signedIn: false,
            sessionEpoch: "c-1",
            connectionState: "connected",
            servers: [],
          },
        ],
      };
      const calls: any[] = [];
      const changed = () =>
        window.dispatchEvent(new Event("mc-panel-connections-changed"));
      const snapshot = () => structuredClone(state);
      const find = (id: string) => {
        const panel = state.panels.find((item: any) => item.id === id);
        if (!panel || panel.local) throw new Error("Choose a remote panel.");
        return panel;
      };
      Object.assign(window, { unifiedFixture: { state, calls, changed } });
      window.mcPanelConnections = {
        unified: true,
        list: async () => snapshot(),
        open: async (url: string) => {
          const origin = new URL(url).origin;
          calls.push({ action: "open", origin });
          if (!state.panels.some((panel: any) => panel.origin === origin))
            state.panels.push({
              id: "new-panel",
              label: new URL(url).host,
              origin,
              local: false,
              signedIn: false,
              sessionEpoch: "new-1",
              connectionState: "connected",
              servers: [],
            });
          changed();
          return snapshot();
        },
        signIn: async (
          id: string,
          input: { email: string; password: string },
        ) => {
          calls.push({ action: "signIn", id, email: input.email });
          if (input.password === "wrong password")
            throw new Error("The email or password is incorrect.");
          const panel = find(id);
          panel.signedIn = true;
          panel.session = session(id, input.email);
          panel.sessionEpoch += "-signedin";
          panel.servers = [{ ...server }];
          changed();
          return snapshot();
        },
        acceptInvitation: async (
          id: string,
          input: { token: string; password: string },
        ) => {
          calls.push({
            action: "acceptInvitation",
            id,
            tokenLength: input.token.length,
          });
          const panel = find(id);
          panel.signedIn = true;
          panel.session = { ...session(id), serverId: null, permissions: [] };
          panel.sessionEpoch += "-accepted";
          changed();
          return snapshot();
        },
        signOut: async (id: string) => {
          calls.push({ action: "signOut", id });
          const panel = find(id);
          panel.signedIn = false;
          panel.session = null;
          panel.servers = [];
          panel.sessionEpoch += "-signedout";
          if (state.selectedServer?.panelId === id) state.selectedServer = null;
          changed();
          return snapshot();
        },
        retry: async (id: string) => {
          calls.push({ action: "retry", id });
          throw new Error("The panel is offline. Try again later.");
        },
        forget: async (id: string) => {
          calls.push({ action: "forget", id });
          state.panels = state.panels.filter((panel: any) => panel.id !== id);
          changed();
          return snapshot();
        },
        selectServer: async (panelId: string, serverId: string) => {
          calls.push({ action: "selectServer", panelId, serverId });
          state.selectedServer = { panelId, serverId };
          changed();
          return snapshot();
        },
        openUpdates: async () => {},
      } as unknown as NonNullable<Window["mcPanelConnections"]>;
    },
    { offline },
  );
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { role: "owner" } }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      json: {
        servers: [
          {
            id: "local-id",
            name: "Local world",
            status: "offline",
            mode: "live",
            address: "localhost:25565",
            players: [],
            port: 25565,
            memoryLimitMB: 2048,
            jar: "server.jar",
            javaPath: "java",
          },
        ],
        defaultServerId: "local-id",
      },
    }),
  );
  await page.route(/\/api\/server$/, (route) =>
    route.fulfill({
      json: {
        id: "local-id",
        name: "Local world",
        status: "offline",
        address: "localhost:25565",
        players: [],
        maxPlayers: 20,
        cpu: null,
        memory: null,
      },
    }),
  );
  await page.route(/\/api\/console$/, (route) =>
    route.fulfill({ json: { lines: [] } }),
  );
  await page.route("**/api/desktop/selection", (route) =>
    route.fulfill({ json: { desktop: true, activeServerId: null } }),
  );
  await page.route("**/api/desktop/preferences", (route) =>
    route.fulfill({ json: { desktop: true, preferences: {} } }),
  );
  await page.route("**/api/desktop/panels/*/proxy/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/api/server"))
      return route.fulfill({
        json: {
          id: "same-id",
          name: "Same world",
          status: "offline",
          address: "play.example.test:25565",
          players: [],
          maxPlayers: 20,
          cpu: null,
          memory: null,
        },
      });
    if (path.endsWith("/api/console"))
      return route.fulfill({ json: { lines: [] } });
    return route.fallback();
  });
  await page.goto("/");
}

async function manage(page: Page) {
  await page
    .getByRole("button", {
      name: "Account menu for Local administrator",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Manage Connections", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Manage Connections", exact: true });
}

test("unified connection manager signs in and out independently without replacing the workspace", async ({
  page,
}) => {
  await workspace(page);
  const originalUrl = page.url();
  const dialog = await manage(page);
  await expect(dialog.getByRole("button", { name: /^Open / })).toHaveCount(0);
  await dialog
    .getByRole("button", {
      name: "Sign in to c.example.test:3002",
      exact: true,
    })
    .click();
  const form = dialog.getByRole("form", {
    name: "Sign in on c.example.test:3002",
  });
  await expect(form.getByLabel("Panel address or invitation link")).toHaveCount(
    0,
  );
  await form
    .getByLabel("Email address", { exact: true })
    .fill("member-c@example.test");
  await form.getByLabel("Password", { exact: true }).fill("wrong password");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("incorrect");
  await expect(form.getByLabel("Email address", { exact: true })).toHaveValue(
    "member-c@example.test",
  );
  await form
    .getByLabel("Password", { exact: true })
    .fill("Correct fixture password!");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    dialog.getByRole("button", {
      name: "Sign out of c.example.test:3002",
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByRole("button", {
      name: "Sign out of a.example.test:3002",
      exact: true,
    })
    .click();
  await expect(
    dialog.getByRole("heading", {
      name: "Sign out of a.example.test:3002?",
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Sign out of this panel", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: "Sign in to a.example.test:3002",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Sign out of c.example.test:3002",
      exact: true,
    }),
  ).toBeVisible();
  expect(page.url()).toBe(originalUrl);
  expect(
    await page.evaluate(() => (window as any).unifiedFixture.calls),
  ).toEqual([
    { action: "signIn", id: "computer-c", email: "member-c@example.test" },
    { action: "signIn", id: "computer-c", email: "member-c@example.test" },
    { action: "signOut", id: "computer-a" },
  ]);
});

test("unified offline retry and forget preserve other panels and the current document", async ({
  page,
}) => {
  await workspace(page, true);
  const originalUrl = page.url();
  const dialog = await manage(page);
  await expect(dialog).toContainText("Saved server information only");
  await dialog
    .getByRole("button", { name: "Retry a.example.test:3002", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("offline");
  await dialog
    .getByRole("button", { name: "Forget a.example.test:3002", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", {
      name: "Forget a.example.test:3002?",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    dialog.getByRole("button", {
      name: "Retry a.example.test:3002",
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Forget a.example.test:3002", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Forget connection", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: "Forget a.example.test:3002",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", {
      name: "Sign in to c.example.test:3002",
      exact: true,
    }),
  ).toBeVisible();
  expect(page.url()).toBe(originalUrl);
  expect(
    await page.evaluate(() => (window as any).unifiedFixture.calls),
  ).toEqual([
    { action: "retry", id: "computer-a" },
    { action: "forget", id: "computer-a" },
  ]);
});

test("the connection manager stays open when signing out the selected remote account", async ({
  page,
}) => {
  await workspace(page);
  await page
    .getByRole("button", {
      name: "Select server Same world on a.example.test:3002",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "Account menu for computer-a@example.test",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Manage Connections", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Manage Connections",
    exact: true,
  });
  await dialog
    .getByRole("button", {
      name: "Sign out of a.example.test:3002",
      exact: true,
    })
    .click();
  await dialog
    .getByRole("button", { name: "Sign out of this panel", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Sign in to a.example.test:3002",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Sign in to c.example.test:3002",
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close panel connections" }).click();
  await expect(
    page.getByRole("button", {
      name: "Select server Local world on This computer",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("unified invitation setup captures the destination and accepts within the workspace", async ({
  page,
}) => {
  await workspace(page);
  const originalUrl = page.url();
  await page
    .getByRole("button", {
      name: "Account menu for Local administrator",
      exact: true,
    })
    .click();
  await expect(page.getByRole("menuitem", { name: /^Switch / })).toHaveCount(0);
  await page
    .getByRole("menuitem", { name: "Accept an invitation", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Accept an invitation",
    exact: true,
  });
  await dialog
    .getByLabel("Panel address or invitation link")
    .fill(`https://new.example.test:3003/#invite=${"a".repeat(43)}`);
  await dialog
    .getByRole("button", { name: "Continue with invitation", exact: true })
    .click();
  const form = dialog.getByRole("form", {
    name: "Accept invitation on new.example.test:3003",
  });
  await expect(form).toContainText("https://new.example.test:3003");
  await form
    .getByLabel("New password", { exact: true })
    .fill("Fixture invite password!");
  await form
    .getByLabel("Confirm password", { exact: true })
    .fill("Does not match!");
  await form
    .getByRole("button", { name: "Set password and continue", exact: true })
    .click();
  await expect(form.getByRole("alert")).toContainText("do not match");
  await form
    .getByLabel("Confirm password", { exact: true })
    .fill("Fixture invite password!");
  await form
    .getByRole("button", { name: "Set password and continue", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(page.url()).toBe(originalUrl);
  expect(
    await page.evaluate(() => (window as any).unifiedFixture.calls),
  ).toEqual([
    { action: "open", origin: "https://new.example.test:3003" },
    { action: "acceptInvitation", id: "new-panel", tokenLength: 43 },
  ]);
  expect(
    await page.evaluate(() => localStorage.getItem("mc-panel.session.v1")),
  ).toBeNull();
});
