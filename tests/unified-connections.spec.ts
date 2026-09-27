import { expect, test, type Page } from "@playwright/test";

async function workspace(page: Page, offline = false, noSavedPanels = false) {
  await page.addInitScript(
    ({ offline, noSavedPanels }) => {
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
      if (noSavedPanels)
        state.panels = state.panels.filter((panel: any) => panel.local);
      const calls: any[] = [];
      const drafts = new Map<string, any>();
      const changed = () =>
        window.dispatchEvent(new Event("mc-panel-connections-changed"));
      const snapshot = () => structuredClone(state);
      const find = (id: string) => {
        const panel =
          state.panels.find((item: any) => item.id === id) ?? drafts.get(id);
        if (!panel || panel.local) throw new Error("Choose a remote panel.");
        return panel;
      };
      const controls: any = { failForget: offline };
      Object.assign(window, {
        unifiedFixture: { state, calls, changed, controls, drafts },
      });
      window.mcPanelConnections = {
        unified: true,
        list: async () => snapshot(),
        open: async (url: string) => {
          const origin = new URL(url).origin;
          calls.push({ action: "open", origin });
          if (controls.pauseValidation)
            await new Promise<void>((resolve) => {
              controls.releaseValidation = resolve;
            });
          if (controls.rejectCertificate)
            throw new Error("Certificate confirmation was cancelled.");
          if (!state.panels.some((panel: any) => panel.origin === origin)) {
            const panel = {
              id: "new-panel",
              label: new URL(url).host,
              origin,
              local: false,
              signedIn: false,
              sessionEpoch: "new-1",
              connectionState: "connected",
              servers: [],
              temporary: true,
            };
            drafts.set(panel.id, panel);
            return {
              ...snapshot(),
              panels: [...snapshot().panels, structuredClone(panel)],
            };
          }
          return snapshot();
        },
        cancelSignIn: async (id: string) => {
          if (!drafts.has(id)) return;
          calls.push({ action: "cancelSignIn", id });
          drafts.delete(id);
        },
        invitation: async (id: string, input: { token: string }) => {
          calls.push({
            action: "invitation",
            id,
            tokenLength: input.token.length,
          });
          if (input.token.startsWith("e"))
            throw new Error(
              "This invitation has expired. Ask the panel owner to reissue it for your existing account.",
            );
          return {
            email: "invited@example.test",
            panelAddress: find(id).origin,
            inviteExpiresAt: new Date(Date.now() + 86400000).toISOString(),
          };
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
          if (panel.temporary) {
            delete panel.temporary;
            drafts.delete(id);
            state.panels.push(panel);
          }
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
          if (input.token.startsWith("e"))
            throw new Error(
              "This invitation has expired. Ask the panel owner for a new invitation.",
            );
          const panel = find(id);
          panel.signedIn = true;
          panel.session = { ...session(id), serverId: null, permissions: [] };
          panel.sessionEpoch += "-accepted";
          if (panel.temporary) {
            delete panel.temporary;
            drafts.delete(id);
            state.panels.push(panel);
          }
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
        forget: async (id: string, expectedAccountId: string) => {
          calls.push({ action: "forget", id, expectedAccountId });
          const panel = find(id);
          if (
            expectedAccountId !==
            (panel.session?.accountId ?? panel.session?.userId)
          )
            throw new Error(
              "The signed-in account changed. Confirm Forget again.",
            );
          if (!panel.signedIn && !panel.pendingLeave)
            throw new Error("Sign in before forgetting this panel.");
          panel.pendingLeave = true;
          panel.connectionState = "unavailable";
          if (state.selectedServer?.panelId === id) state.selectedServer = null;
          changed();
          if (controls.failForget)
            throw new Error(
              "The panel is offline. Account removal is unconfirmed. Retry Forget when it is reachable.",
            );
          state.panels = state.panels.filter((panel: any) => panel.id !== id);
          changed();
          return snapshot();
        },
        removeSavedConnection: async (id: string, expectedEpoch: string) => {
          calls.push({ action: "removeSavedConnection", id, expectedEpoch });
          const panel = find(id);
          if (
            !expectedEpoch ||
            panel.sessionEpoch !== expectedEpoch ||
            panel.signedIn ||
            panel.pendingLeave
          )
            throw new Error("This connection changed. Confirm removal again.");
          state.panels = state.panels.filter((item: any) => item.id !== id);
          if (state.selectedServer?.panelId === id) state.selectedServer = null;
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
    { offline, noSavedPanels },
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

async function openSignIn(page: Page) {
  await page
    .getByRole("button", {
      name: "Account menu for Local administrator",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Sign in", exact: true }).click();
  return page.getByRole("dialog", { name: "Sign in", exact: true });
}

async function fillSignIn(
  dialog: ReturnType<Page["getByRole"]>,
  address = "https://existing.example.test:3002",
  password = "Existing password!",
) {
  await dialog.getByLabel("Panel address", { exact: true }).fill(address);
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("existing@example.test");
  await dialog.getByLabel("Password", { exact: true }).fill(password);
}

test("a new panel uses one sign-in form and saves only after authentication", async ({
  page,
}) => {
  await workspace(page, false, true);
  const originalUrl = page.url();
  let dialog = await openSignIn(page);
  await fillSignIn(dialog);
  expect(
    await page.evaluate(() => (window as any).unifiedFixture.calls),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  dialog = await openSignIn(page);
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveValue("");
  await fillSignIn(dialog, undefined, "wrong password");
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("incorrect");
  expect(
    await page.evaluate(() =>
      (window as any).unifiedFixture.state.panels.filter(
        (panel: any) => !panel.local,
      ),
    ),
  ).toEqual([]);
  await dialog
    .getByLabel("Password", { exact: true })
    .fill("Existing password!");
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(page.url()).toBe(originalUrl);
  const manager = await manage(page);
  await expect(
    manager.getByRole("button", {
      name: "Sign out of existing.example.test:3002",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    manager.getByRole("button", {
      name: "Sign in to existing panel",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    manager.getByLabel("Panel address", { exact: true }),
  ).toHaveCount(0);
});

for (const cancel of ["Escape", "Close"] as const) {
  test(`${cancel} during certificate validation discards the temporary panel and never transmits credentials`, async ({
    page,
  }) => {
    await workspace(page, false, true);
    await page.evaluate(() => {
      (window as any).unifiedFixture.controls.pauseValidation = true;
    });
    const dialog = await openSignIn(page);
    await fillSignIn(dialog);
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean((window as any).unifiedFixture.controls.releaseValidation),
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(() => (window as any).unifiedFixture.calls),
    ).toEqual([
      { action: "open", origin: "https://existing.example.test:3002" },
    ]);
    if (cancel === "Escape") await page.keyboard.press("Escape");
    else
      await dialog
        .getByRole("button", { name: "Close connection dialog", exact: true })
        .click();
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => {
      (window as any).unifiedFixture.controls.releaseValidation();
    });
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).unifiedFixture.drafts.size),
      )
      .toBe(0);
    expect(
      await page.evaluate(() => (window as any).unifiedFixture.calls),
    ).toEqual([
      { action: "open", origin: "https://existing.example.test:3002" },
      { action: "cancelSignIn", id: "new-panel" },
    ]);
    const manager = await manage(page);
    await expect(manager).toContainText("No saved panel connections");
  });
}

test("certificate rejection and invalid addresses never start authentication", async ({
  page,
}) => {
  await workspace(page, false, true);
  const dialog = await openSignIn(page);
  await fillSignIn(dialog);
  for (const address of [
    "http://existing.example.test",
    "https://existing.example.test/path",
    "https://user:password@existing.example.test",
    `https://existing.example.test/#invite=${"a".repeat(43)}`,
  ]) {
    await dialog.getByLabel("Panel address", { exact: true }).fill(address);
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
  }
  expect(
    await page.evaluate(() => (window as any).unifiedFixture.calls),
  ).toEqual([]);
  await page.evaluate(() => {
    (window as any).unifiedFixture.controls.rejectCertificate = true;
  });
  await fillSignIn(dialog);
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Certificate confirmation was cancelled",
  );
  expect(
    await page.evaluate(() => (window as any).unifiedFixture.calls),
  ).toEqual([{ action: "open", origin: "https://existing.example.test:3002" }]);
  expect(
    await page.evaluate(() => (window as any).unifiedFixture.drafts.size),
  ).toBe(0);
});

test("signing in an already connected address preserves its current account", async ({
  page,
}) => {
  await workspace(page);
  const dialog = await openSignIn(page);
  await fillSignIn(dialog, "https://a.example.test:3002/");
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("computer-a@example.test");
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).unifiedFixture.calls),
  ).toEqual([{ action: "open", origin: "https://a.example.test:3002" }]);
  expect(
    await page.evaluate(
      () =>
        (window as any).unifiedFixture.state.panels.find(
          (panel: any) => panel.id === "computer-a",
        ).session.email,
    ),
  ).toBe("computer-a@example.test");
});

test("unified connection manager signs in and out independently without replacing the workspace", async ({
  page,
}) => {
  await workspace(page);
  const originalUrl = page.url();
  const dialog = await manage(page);
  await expect(dialog.getByRole("button", { name: /^Open / })).toHaveCount(0);
  await expect(
    dialog.getByRole("button", {
      name: "Remove saved connection to c.example.test:3002",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(dialog).not.toContainText(
    "Sign in before forgetting this panel",
  );
  await dialog
    .getByRole("button", {
      name: "Sign in to c.example.test:3002",
      exact: true,
    })
    .click();
  const form = dialog.getByRole("form", {
    name: "Sign in on c.example.test:3002",
  });
  await expect(form.getByLabel("Panel address", { exact: true })).toHaveValue(
    "https://c.example.test:3002",
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
  await expect(
    dialog.getByRole("button", {
      name: "Forget c.example.test:3002",
      exact: true,
    }),
  ).toBeEnabled();
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
    { action: "open", origin: "https://c.example.test:3002" },
    { action: "signIn", id: "computer-c", email: "member-c@example.test" },
    { action: "open", origin: "https://c.example.test:3002" },
    { action: "signIn", id: "computer-c", email: "member-c@example.test" },
    { action: "signOut", id: "computer-a" },
  ]);
});

test("removing a saved panel during sign-in releases Manage Connections without accepting the late result", async ({
  page,
}) => {
  await workspace(page);
  await page.evaluate(() => {
    const fixture = (window as any).unifiedFixture;
    window.mcPanelConnections!.signIn = async () => {
      await new Promise<void>((resolve) => {
        fixture.releaseSignIn = resolve;
      });
      throw new Error("Late sign-in failure after access removal.");
    };
  });
  const dialog = await manage(page);
  await dialog
    .getByRole("button", {
      name: "Sign in to c.example.test:3002",
      exact: true,
    })
    .click();
  const form = dialog.getByRole("form", {
    name: "Sign in on c.example.test:3002",
    exact: true,
  });
  await form
    .getByLabel("Email address", { exact: true })
    .fill("member@example.test");
  await form.getByLabel("Password", { exact: true }).fill("in-flight-password");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  const close = dialog.getByRole("button", {
    name: "Close panel connections",
    exact: true,
  });
  await expect(close).toBeDisabled();
  await page.evaluate(() => {
    const fixture = (window as any).unifiedFixture;
    fixture.state.panels = fixture.state.panels.filter(
      (panel: any) => panel.id !== "computer-c",
    );
    fixture.changed();
  });
  await expect(form).toHaveCount(0);
  await expect(close).toBeEnabled();
  await expect(
    dialog.getByRole("button", {
      name: "Sign out of a.example.test:3002",
      exact: true,
    }),
  ).toBeEnabled();
  await page.evaluate(() => (window as any).unifiedFixture.releaseSignIn());
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await close.click();
  await expect(dialog).toHaveCount(0);
});

test("automatic access revocation removes its saved panel and sidebar group while Manage Connections stays open", async ({
  page,
}) => {
  await workspace(page);
  const dialog = await manage(page);
  await expect(
    dialog.getByRole("button", {
      name: "Forget a.example.test:3002",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", {
      name: "Servers on a.example.test:3002",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(1);
  await page.evaluate(() => {
    const fixture = (window as any).unifiedFixture;
    fixture.state.panels = fixture.state.panels.filter(
      (panel: any) => panel.id !== "computer-a",
    );
    fixture.changed();
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Forget a.example.test:3002",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("list", {
      name: "Servers on a.example.test:3002",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", {
      name: "Sign in to c.example.test:3002",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", {
      name: "Servers on this computer",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(1);
  expect(
    await page.evaluate(() => (window as any).unifiedFixture.calls),
  ).toEqual([]);
});

for (const connection of ["connected", "unavailable", "unverified"]) {
  test(`a ${connection} signed-out panel can be removed locally without signing in or leaving its host account`, async ({
    page,
  }) => {
    await workspace(page);
    const originalUrl = page.url();
    const unchanged = await page.evaluate((connection) => {
      const fixture = (window as any).unifiedFixture;
      const panel = fixture.state.panels.find(
        (item: any) => item.id === "computer-c",
      );
      panel.connectionState =
        connection === "unavailable" ? "unavailable" : "connected";
      if (connection === "unverified") panel.signedIn = undefined;
      fixture.changed();
      return fixture.state.panels.filter((item: any) => item.id !== panel.id);
    }, connection);
    const dialog = await manage(page);
    const removeRow = dialog.getByRole("button", {
      name: "Remove saved connection to c.example.test:3002",
      exact: true,
    });
    await removeRow.click();
    await expect(
      dialog.getByRole("heading", {
        name: "Remove saved connection to c.example.test:3002?",
        exact: true,
      }),
    ).toBeVisible();
    await expect(dialog).toContainText(
      "this computer's saved connection and certificate trust",
    );
    await expect(dialog).toContainText(
      "Accounts, permissions, and Minecraft servers on the host stay unchanged",
    );
    await expect(dialog).not.toContainText("signed out on all devices");
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(removeRow).toBeVisible();
    expect(
      await page.evaluate(() => (window as any).unifiedFixture.calls),
    ).toEqual([]);
    await removeRow.click();
    await dialog
      .getByRole("button", {
        name: "Remove saved connection",
        exact: true,
      })
      .click();
    await expect(dialog).toBeVisible();
    await expect(removeRow).toHaveCount(0);
    await expect(
      dialog.getByRole("button", {
        name: "Forget a.example.test:3002",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => (window as any).unifiedFixture.calls),
    ).toEqual([
      {
        action: "removeSavedConnection",
        id: "computer-c",
        expectedEpoch: "c-1",
      },
    ]);
    expect(
      await page.evaluate(() => (window as any).unifiedFixture.state.panels),
    ).toEqual(unchanged);
    expect(
      await page.evaluate(
        () => (window as any).unifiedFixture.state.selectedServer,
      ),
    ).toEqual({
      panelId: "local",
      serverId: "local-id",
    });
    expect(page.url()).toBe(originalUrl);
  });
}

for (const change of ["sign-in", "session-epoch", "pending-leave"]) {
  test(`saved-connection removal cannot follow a ${change} change while confirmation is open`, async ({
    page,
  }) => {
    await workspace(page);
    const dialog = await manage(page);
    await dialog
      .getByRole("button", {
        name: "Remove saved connection to c.example.test:3002",
        exact: true,
      })
      .click();
    await page.evaluate((change) => {
      const fixture = (window as any).unifiedFixture;
      const panel = fixture.state.panels.find(
        (item: any) => item.id === "computer-c",
      );
      if (change === "sign-in") {
        panel.signedIn = true;
        panel.session = {
          role: "subuser",
          accountId: "replacement",
          userId: "replacement",
          email: "replacement@example.test",
          serverId: null,
          permissions: [],
          hostPermissions: [],
        };
      } else if (change === "session-epoch")
        panel.sessionEpoch = "c-replacement";
      else panel.pendingLeave = true;
      fixture.changed();
    }, change);
    await expect(dialog.getByRole("alert")).toContainText(
      change === "pending-leave"
        ? "Account removal is pending"
        : "This connection changed",
    );
    await expect(
      dialog.getByRole("button", {
        name: "Remove saved connection",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Forget connection", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).unifiedFixture.calls),
    ).toEqual([]);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    if (change === "pending-leave") {
      await expect(
        dialog.getByRole("button", {
          name: "Remove saved connection to c.example.test:3002",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("button", {
          name: "Retry Forget c.example.test:3002",
          exact: true,
        }),
      ).toBeVisible();
    } else if (change === "session-epoch") {
      await dialog
        .getByRole("button", {
          name: "Remove saved connection to c.example.test:3002",
          exact: true,
        })
        .click();
      await dialog
        .getByRole("button", { name: "Remove saved connection", exact: true })
        .click();
      expect(
        await page.evaluate(() => (window as any).unifiedFixture.calls),
      ).toEqual([
        {
          action: "removeSavedConnection",
          id: "computer-c",
          expectedEpoch: "c-replacement",
        },
      ]);
    } else {
      await expect(
        dialog.getByRole("button", {
          name: "Forget c.example.test:3002",
          exact: true,
        }),
      ).toBeVisible();
    }
  });
}

test("unified Forget confirms whole-panel removal and retains an offline request for retry", async ({
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
  await expect(dialog).toContainText(
    "access to every shared server and all computer permissions",
  );
  await expect(dialog).toContainText("signed out on all devices");
  await expect(dialog).toContainText("new invitation to connect again");
  await expect(dialog).toContainText(
    "Minecraft servers keep running and their files stay on the host",
  );
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
  await expect(dialog.getByRole("alert")).toContainText(
    "Account removal is unconfirmed",
  );
  await expect(
    dialog.getByRole("button", { name: "Retry Forget", exact: true }),
  ).toBeEnabled();
  await expect(dialog).toContainText("Closing this dialog does not cancel it");
  await dialog
    .getByRole("button", { name: "Back to connections", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: "Retry Forget a.example.test:3002",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Sign in to a.example.test:3002",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", {
      name: "Sign out of a.example.test:3002",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", {
      name: "Retry a.example.test:3002",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", {
      name: "Remove saved connection to a.example.test:3002",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).unifiedFixture.state.panels.some(
        (panel: any) => panel.id === "computer-a",
      ),
    ),
  ).toBe(true);
  await page.evaluate(() => {
    (window as any).unifiedFixture.controls.failForget = false;
  });
  await dialog
    .getByRole("button", {
      name: "Retry Forget a.example.test:3002",
      exact: true,
    })
    .click();
  await dialog
    .getByRole("button", { name: "Retry Forget", exact: true })
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
    { action: "forget", id: "computer-a", expectedAccountId: "computer-a" },
    { action: "forget", id: "computer-a", expectedAccountId: "computer-a" },
  ]);
});

test("Forget confirmation cannot retarget a changed panel account", async ({
  page,
}) => {
  await workspace(page);
  const dialog = await manage(page);
  await dialog
    .getByRole("button", { name: "Forget a.example.test:3002", exact: true })
    .click();
  await expect(dialog).toContainText("computer-a@example.test");
  await page.evaluate(() => {
    const fixture = (window as any).unifiedFixture;
    const panel = fixture.state.panels.find(
      (item: any) => item.id === "computer-a",
    );
    panel.session = {
      ...panel.session,
      accountId: "replacement-account",
      userId: "replacement-account",
      email: "replacement@example.test",
    };
    panel.sessionEpoch = "replacement-epoch";
    fixture.changed();
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "signed-in account has changed",
  );
  await expect(
    dialog.getByRole("button", { name: "Forget connection", exact: true }),
  ).toBeDisabled();
  await expect(dialog).toContainText("computer-a@example.test");
  expect(
    await page.evaluate(() => (window as any).unifiedFixture.calls),
  ).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Forget a.example.test:3002", exact: true })
    .click();
  await expect(dialog).toContainText("replacement@example.test");
  await expect(
    dialog.getByRole("button", { name: "Forget connection", exact: true }),
  ).toBeEnabled();
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

test("Accept invitation accepts invitations only and captures the destination within the workspace", async ({
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
  await expect(
    page.getByRole("menuitem", { name: "Add Panel", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitem", { name: "Accept invitation", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Accept invitation",
    exact: true,
  });
  await expect(
    dialog.getByRole("group", { name: "Connection method" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Sign in", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByLabel("Invitation link", { exact: true })
    .fill("https://new.example.test:3003");
  await dialog
    .getByRole("button", { name: "Continue with invitation", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "complete invitation link",
  );
  expect(
    await page.evaluate(() => (window as any).unifiedFixture.calls),
  ).toEqual([]);
  await dialog
    .getByLabel("Invitation link", { exact: true })
    .fill(`https://new.example.test:3003/#invite=${"a".repeat(43)}`);
  await dialog
    .getByRole("button", { name: "Continue with invitation", exact: true })
    .click();
  const form = dialog.getByRole("form", {
    name: "Accept invitation on new.example.test:3003",
  });
  await expect(form).toContainText("https://new.example.test:3003");
  expect(
    await page.evaluate(async () =>
      (await window.mcPanelConnections!.list()).panels.some(
        (panel) => panel.origin === "https://new.example.test:3003",
      ),
    ),
  ).toBe(false);
  await expect(form.getByLabel("Email address", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("button", {
      name: "Sign in with an existing account",
      exact: true,
    }),
  ).toBeVisible();
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
  expect(
    await page.evaluate(async () =>
      (await window.mcPanelConnections!.list()).panels.some(
        (panel) => panel.origin === "https://new.example.test:3003",
      ),
    ),
  ).toBe(false);
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
    { action: "invitation", id: "new-panel", tokenLength: 43 },
    { action: "acceptInvitation", id: "new-panel", tokenLength: 43 },
  ]);
  expect(
    await page.evaluate(() => localStorage.getItem("mc-panel.session.v1")),
  ).toBeNull();
});

for (const saved of [true, false]) {
  test(`an expired invitation for a ${saved ? "saved" : "new"} panel offers reissue guidance and normal sign-in recovery`, async ({
    page,
  }) => {
    await workspace(page);
    const host = saved ? "c.example.test:3002" : "new.example.test:3003";
    const panelId = saved ? "computer-c" : "new-panel";
    await page
      .getByRole("button", {
        name: "Account menu for Local administrator",
        exact: true,
      })
      .click();
    await page
      .getByRole("menuitem", { name: "Accept invitation", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Accept invitation",
      exact: true,
    });
    await dialog
      .getByLabel("Invitation link", { exact: true })
      .fill(`https://${host}/#invite=${"e".repeat(43)}`);
    await dialog
      .getByRole("button", { name: "Continue with invitation", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "invitation has expired",
    );
    await expect(dialog).toContainText("existing account");
    await expect(dialog).toContainText("server permissions are preserved");
    await expect(
      dialog.getByLabel("New password", { exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        async (origin) =>
          (await window.mcPanelConnections!.list()).panels.some(
            (panel) => panel.origin === origin,
          ),
        `https://${host}`,
      ),
    ).toBe(saved);
    await dialog
      .getByRole("button", {
        name: "Sign in with an existing account",
        exact: true,
      })
      .click();
    const recovery = page.getByRole("dialog", { name: "Sign in", exact: true });
    await expect(
      recovery.getByLabel("Panel address", { exact: true }),
    ).toHaveValue(`https://${host}`);
    await expect(recovery.getByLabel("Password", { exact: true })).toHaveValue(
      "",
    );
    expect(
      await page.evaluate(() => (window as any).unifiedFixture.drafts.size),
    ).toBe(0);
    expect(
      await page.evaluate(() => (window as any).unifiedFixture.calls),
    ).toEqual([
      { action: "open", origin: `https://${host}` },
      { action: "invitation", id: panelId, tokenLength: 43 },
      ...(!saved ? [{ action: "cancelSignIn", id: panelId }] : []),
    ]);
  });
}
