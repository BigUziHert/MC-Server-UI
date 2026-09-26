import { expect, test, type Page } from "@playwright/test";
import { Resvg } from "@resvg/resvg-js";

const iconBytes = (fill: string) =>
  new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${fill}"/></svg>`,
  )
    .render()
    .asPng();
const iconData = (fill: string) =>
  `data:image/png;base64,${iconBytes(fill).toString("base64")}`;

const invitationToken = "A".repeat(43);
const panelOrigin = "https://panel.example.test";
const invitationUrl = `${panelOrigin}/#invite=${invitationToken}`;
const localServer = {
  id: "local-connection-fixture",
  name: "Local connection fixture",
  mode: "live",
  status: "offline" as const,
  software: "Paper",
  version: "1.21.1",
  minecraftVersion: "1.21.1",
  address: "localhost:25565",
  players: [],
  maxPlayers: 20,
  uptime: 0,
  cpu: 0,
  cpuCapacity: 800,
  memory: 0,
  memoryLimit: 2048,
  disk: 0,
  diskLimit: 1024,
};

type LocalServerDescriptor = {
  id: string;
  name: string;
  status: "running" | "offline" | "starting" | "stopping";
  software?: string;
  minecraftVersion?: string | null;
  iconDataUrl?: string;
};

async function desktopBridge(
  page: Page,
  options: {
    activeId?: string;
    senderId?: string;
    localServers?: LocalServerDescriptor[];
    remoteServers?: Record<string, LocalServerDescriptor[]>;
    listFailure?: "reject" | "hang";
    updatesFailure?: boolean;
    unavailablePanels?: string[];
  } = {},
) {
  await page.addInitScript(
    ({
      activeId,
      senderId,
      localServers,
      remoteServers,
      listFailure,
      updatesFailure,
      unavailablePanels,
    }) => {
      // The sending renderer stays fixed when native activation hides its view.
      const state = {
        activeId,
        localServers,
        panels: [
          {
            id: "local",
            label: "This computer",
            origin:
              senderId === "local" ? location.origin : "http://127.0.0.1:41234",
            local: true,
          },
          {
            id: "pc-one",
            label: "pc-one.example:3002",
            origin:
              senderId === "pc-one"
                ? location.origin
                : "https://pc-one.example:3002",
            local: false,
            servers: remoteServers["pc-one"],
          },
          {
            id: "pc-two",
            label: "pc-two.example:3002",
            origin:
              senderId === "pc-two"
                ? location.origin
                : "https://pc-two.example:3002",
            local: false,
            servers: remoteServers["pc-two"],
          },
        ],
      };
      const calls: { action: string; value: string }[] = [];
      const reports: {
        panelId: string;
        servers: LocalServerDescriptor[] | null;
      }[] = [];
      const snapshot = () => structuredClone(state);
      const changed = () =>
        window.dispatchEvent(new Event("mc-panel-connections-changed"));
      const report = (
        panelId: string,
        servers: LocalServerDescriptor[] | null,
      ) => {
        const panel = state.panels.find((item) => item.id === panelId);
        if (!panel || panel.local) return;
        panel.servers = servers ?? undefined;
        reports.push({ panelId, servers });
        changed();
      };
      Object.assign(window, {
        connectionCalls: calls,
        connectionReports: reports,
        connectionFixture: { report },
      });
      window.mcPanelConnections = {
        list: () =>
          listFailure === "reject"
            ? Promise.reject(
                new Error("Native connection list is unavailable."),
              )
            : listFailure === "hang"
              ? new Promise(() => {})
              : Promise.resolve(snapshot()),
        open: async (url) => {
          calls.push({ action: "open", value: url });
          return snapshot();
        },
        activate: async (id) => {
          calls.push({ action: "activate", value: id });
          if (unavailablePanels.includes(id))
            throw new Error("This saved panel is offline.");
          state.activeId = id;
          changed();
          return snapshot();
        },
        openUpdates: async () => {
          if (updatesFailure) {
            updatesFailure = false;
            throw new Error(
              "The local panel is still loading. Try again in a moment.",
            );
          }
          calls.push({ action: "openUpdates", value: "local" });
          state.activeId = "local";
          changed();
        },
        disconnect: async (id) => {
          calls.push({ action: "disconnect", value: id });
          state.panels = state.panels.filter((panel) => panel.id !== id);
          if (state.activeId === id) state.activeId = "local";
          changed();
          return snapshot();
        },
        selectLocalServer: async (id) => {
          calls.push({ action: "selectLocalServer", value: id });
          state.activeId = "local";
          changed();
          return snapshot();
        },
        reportServers: async (servers) => {
          report(senderId, servers);
        },
        selectRemoteServer: async (panelId, serverId) => {
          calls.push({
            action: "selectRemoteServer",
            value: `${panelId}:${serverId}`,
          });
          state.activeId = panelId;
          if (panelId === senderId)
            window.dispatchEvent(
              new CustomEvent("mc-panel-remote-server-selected", {
                detail: { serverId },
              }),
            );
          changed();
          return snapshot();
        },
      };
    },
    {
      activeId: options.activeId ?? "local",
      senderId: options.senderId ?? options.activeId ?? "local",
      localServers: options.localServers ?? [localServer],
      remoteServers: options.remoteServers ?? {},
      listFailure: options.listFailure,
      updatesFailure: options.updatesFailure,
      unavailablePanels: options.unavailablePanels ?? [],
    },
  );
}

async function localPanel(page: Page, desktop = false) {
  const localCredentials: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/access/login" || path === "/api/access/accept")
      localCredentials.push(path);
  });
  // The account connection flow does not need a running Minecraft process or
  // any fixture writes to the panel's real server registry.
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/access/session")
      return route.fulfill({ json: { role: "owner" } });
    if (path === "/api/servers")
      return route.fulfill({
        json: { servers: [localServer], defaultServerId: localServer.id },
      });
    if (path === "/api/server") return route.fulfill({ json: localServer });
    if (path === "/api/console") return route.fulfill({ json: { lines: [] } });
    if (path === "/api/desktop/selection" && desktop)
      return route.fulfill({
        json: { desktop: true, activeServerId: null },
      });
    return route.fulfill({
      status: 404,
      json: { error: "This endpoint is unavailable in the fixture." },
    });
  });
  return { localCredentials };
}

for (const empty of [false, true]) {
  for (const desktop of [false, true]) {
    test(`remote app updates ${desktop ? "open the local desktop updater" : "stay unavailable in a browser"} ${empty ? "without shared servers" : "with a selected server"}`, async ({
      page,
    }) => {
      if (desktop) await desktopBridge(page, { activeId: "pc-one" });
      await localPanel(page);
      await page.route("**/api/access/session", (route) =>
        route.fulfill({
          json: {
            role: "subuser",
            email: "friend@example.test",
            userId: "friend",
            serverId: localServer.id,
            permissions: ["control.console"],
          },
        }),
      );
      await page.route("**/api/servers", (route) =>
        route.fulfill({
          json: {
            servers: empty
              ? []
              : [{ ...localServer, accessPermissions: ["control.console"] }],
            defaultServerId: empty ? null : localServer.id,
          },
        }),
      );
      const updateRequests: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/desktop/updates"))
          updateRequests.push(request.url());
      });
      await page.goto("/#console");
      await expect(
        page.getByRole("heading", {
          name: empty ? "No shared servers" : localServer.name,
          exact: true,
        }),
      ).toBeVisible();
      const updates = page.getByRole("button", {
        name: "App updates",
        exact: true,
      });
      if (desktop) {
        await expect(updates).toBeVisible();
        await expect(updates).toHaveAttribute(
          "title",
          "Open app updates on this computer",
        );
        await updates.click();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as unknown as { connectionCalls: unknown })
                  .connectionCalls,
            ),
          )
          .toEqual([{ action: "openUpdates", value: "local" }]);
      } else {
        await expect(updates).toHaveCount(0);
      }
      expect(updateRequests).toEqual([]);
    });
  }
}

test("remote update shortcut reports a bridge failure and can be retried", async ({
  page,
}) => {
  await desktopBridge(page, { activeId: "pc-one", updatesFailure: true });
  await localPanel(page);
  await page.route("**/api/access/session", (route) =>
    route.fulfill({
      json: {
        role: "subuser",
        email: "friend@example.test",
        userId: "friend",
        serverId: localServer.id,
        permissions: ["control.console"],
      },
    }),
  );
  await page.goto("/#console");
  const updates = page.getByRole("button", {
    name: "App updates",
    exact: true,
  });
  await updates.click();
  await expect(page.getByRole("alert")).toContainText(
    "The local panel is still loading",
  );
  await expect(updates).toBeEnabled();
  await updates.click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { connectionCalls: unknown }).connectionCalls,
      ),
    )
    .toEqual([{ action: "openUpdates", value: "local" }]);
});

type ConnectionMock = Window & {
  connectionReports: {
    panelId: string;
    servers: LocalServerDescriptor[] | null;
  }[];
  connectionFixture: {
    report: (panelId: string, servers: LocalServerDescriptor[] | null) => void;
  };
};

const cachedRemoteServers = {
  "pc-one": [
    {
      id: localServer.id,
      name: "Family survival world",
      iconDataUrl: iconData("blue"),
      status: "offline" as const,
      software: "Paper",
      minecraftVersion: "1.21.1",
    },
  ],
  "pc-two": [
    {
      id: localServer.id,
      name: "Friends creative world",
      iconDataUrl: iconData("green"),
      status: "offline" as const,
      software: "Paper",
      minecraftVersion: "1.21.1",
    },
  ],
};

async function openConnection(page: Page, invitation = false) {
  await page
    .getByRole("button", {
      name: "Account menu for Local administrator",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", {
      name: "Sign in to another panel",
      exact: true,
    })
    .click();
  if (invitation)
    await page
      .getByRole("button", { name: "Use invitation", exact: true })
      .click();
  const dialog = page.getByRole("dialog", {
    name: invitation ? "Accept an invitation" : "Connect to a panel",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const failure of ["reject", "hang"] as const) {
  test(`an unavailable desktop preference bridge does not block the owner panel (${failure})`, async ({
    page,
  }) => {
    await desktopBridge(page, { listFailure: failure });
    await localPanel(page, true);
    const ownerPreferenceRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/desktop/preferences")
        ownerPreferenceRequests.push(request.method());
    });
    await page.goto("/#console");
    await expect(
      page.getByRole("heading", { name: localServer.name, exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    expect(ownerPreferenceRequests).toEqual([]);
  });
}

test("the account menu and connection dialog support Escape and restore keyboard focus", async ({
  page,
}) => {
  await localPanel(page);
  await page.goto("/#console");
  const account = page.getByRole("button", {
    name: "Account menu for Local administrator",
    exact: true,
  });
  await account.focus();
  await account.press("Enter");
  await expect(
    page.getByRole("menuitem", {
      name: "Sign in to another panel",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Accept an invitation", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  await expect(account).toBeFocused();

  await account.press("Enter");
  const signIn = page.getByRole("menuitem", {
    name: "Sign in to another panel",
    exact: true,
  });
  await signIn.focus();
  await signIn.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Connect to a panel" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Panel address or invitation link" }),
  ).toBeFocused();
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(account).toBeFocused();
  await expect(page).toHaveURL(/\/#console$/);
});

test("a fresh workspace can connect without creating or importing a local server", async ({
  page,
}) => {
  await localPanel(page, true);
  await page.route("**/api/servers", (route) =>
    route.fulfill({ json: { servers: [], defaultServerId: null } }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel" }),
  ).toBeVisible();
  await openConnection(page);
  await expect(
    page.getByRole("textbox", { name: "Panel address or invitation link" }),
  ).toBeFocused();
});

test("invalid panel URLs show validation without opening a connection or sending credentials", async ({
  page,
}) => {
  const { localCredentials } = await localPanel(page, true);
  const opens: unknown[] = [];
  await page.route("**/api/desktop/connections/open", (route) => {
    opens.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/#console");
  const initialUrl = page.url();
  const dialog = await openConnection(page);
  const address = dialog.getByRole("textbox", {
    name: "Panel address or invitation link",
  });
  const invalidAddresses = [
    "javascript:alert(1)",
    "file:///C:/private/panel.html",
    "ftp://panel.example.test/",
    "http://panel.example.test/",
    "https://owner:password@panel.example.test/",
    "https://panel.example.test/another-page",
    "https://panel.example.test/?invite=private-token",
    `${invitationUrl}&invite=${invitationToken}`,
    `${panelOrigin}/#invite=short-token`,
  ];
  for (const invalid of invalidAddresses) {
    await address.fill(invalid);
    await dialog.getByRole("button", { name: "Continue to sign in" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(initialUrl);
    expect(opens, `Connection attempted for ${invalid}`).toEqual([]);
  }
  expect(localCredentials).toEqual([]);
});

test("accepting an invitation requires the complete invitation link", async ({
  page,
}) => {
  await localPanel(page, true);
  const opens: unknown[] = [];
  await page.route("**/api/desktop/connections/open", (route) => {
    opens.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const dialog = await openConnection(page, true);
  await dialog
    .getByRole("textbox", { name: "Panel address or invitation link" })
    .fill(panelOrigin);
  await dialog
    .getByRole("button", { name: "Continue with invitation", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(opens).toEqual([]);
});

test("desktop invitations open once with the normalized URL and never collect local credentials", async ({
  page,
}) => {
  const { localCredentials } = await localPanel(page, true);
  const opens: { method: string; body: unknown }[] = [];
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/desktop/connections/open", async (route) => {
    opens.push({
      method: route.request().method(),
      body: route.request().postDataJSON(),
    });
    await pending;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/#console");
  const dialog = await openConnection(page, true);
  const address = dialog.getByRole("textbox", {
    name: "Panel address or invitation link",
  });
  await address.fill(
    `  https://PANEL.example.test:443/#invite=${invitationToken}  `,
  );
  const submit = dialog.getByRole("button", {
    name: "Continue with invitation",
    exact: true,
  });
  try {
    await submit.click();
    await expect.poll(() => opens.length).toBe(1);
    await expect(submit).toBeDisabled();
    await page.keyboard.press("Enter");
    expect(opens).toEqual([{ method: "POST", body: { url: invitationUrl } }]);
  } finally {
    release();
  }
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/#console$/);
  expect(opens).toHaveLength(1);
  expect(localCredentials).toEqual([]);
});

test("a failed desktop connection preserves the address and allows an explicit retry", async ({
  page,
}) => {
  await localPanel(page, true);
  const opens: unknown[] = [];
  await page.route("**/api/desktop/connections/open", (route) => {
    opens.push(route.request().postDataJSON());
    return opens.length === 1
      ? route.fulfill({
          status: 503,
          json: { error: "Could not open this panel. Please try again." },
        })
      : route.fulfill({ json: { ok: true } });
  });
  await page.goto("/#console");
  const dialog = await openConnection(page);
  const address = dialog.getByRole("textbox", {
    name: "Panel address or invitation link",
  });
  await address.fill(panelOrigin);
  const submit = dialog.getByRole("button", { name: "Continue to sign in" });
  await submit.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Could not open this panel. Please try again.",
  );
  await expect(address).toHaveValue(panelOrigin);
  await expect(submit).toBeEnabled();
  expect(opens).toEqual([{ url: `${panelOrigin}/` }]);
  await submit.click();
  await expect(dialog).toHaveCount(0);
  expect(opens).toEqual([
    { url: `${panelOrigin}/` },
    { url: `${panelOrigin}/` },
  ]);
  await expect(page).toHaveURL(/\/#console$/);
});

test("desktop account switches connected panels without local-switch or disconnect actions", async ({
  page,
  context,
}) => {
  await desktopBridge(page);
  await localPanel(page, true);
  await page.goto("/#console");
  const account = page.getByRole("button", {
    name: "Account menu for Local administrator",
  });
  await account.click();
  await page
    .getByRole("menuitem", {
      name: "Switch to pc-two.example:3002",
      exact: true,
    })
    .click();
  await account.click();
  await expect(
    page.getByRole("menuitem", {
      name: "Switch to this computer",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: /Disconnect from/ }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitem", {
      name: "Switch to pc-one.example:3002",
      exact: true,
    })
    .click();
  expect(
    await page.evaluate(
      () => (window as unknown as { connectionCalls: unknown }).connectionCalls,
    ),
  ).toEqual([
    { action: "activate", value: "pc-two" },
    { action: "activate", value: "pc-one" },
  ]);
  expect(context.pages()).toHaveLength(1);
});

for (const empty of [false, true]) {
  test(`an offline saved panel stays available without account disconnect actions ${empty ? "without local servers" : "with a local workspace"}`, async ({
    page,
  }) => {
    await desktopBridge(page, { unavailablePanels: ["pc-one"] });
    const { localCredentials } = await localPanel(page, true);
    if (empty)
      await page.route("**/api/servers", (route) =>
        route.fulfill({ json: { servers: [], defaultServerId: null } }),
      );
    await page.goto("/#console");
    const account = page.getByRole("button", {
      name: "Account menu for Local administrator",
      exact: true,
    });
    await account.click();
    await page
      .getByRole("menuitem", {
        name: "Switch to pc-one.example:3002",
        exact: true,
      })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "This saved panel is offline.",
    );
    await account.click();
    await expect(
      page.getByRole("menuitem", { name: /Disconnect from/ }),
    ).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(async () => window.mcPanelConnections!.list()))
      .toMatchObject({
        activeId: "local",
        panels: [{ id: "local" }, { id: "pc-one" }, { id: "pc-two" }],
      });
    await expect(
      page.getByRole("menuitem", { name: /pc-one\.example/ }),
    ).toBeEnabled();
    await expect(
      page.getByRole("menuitem", {
        name: "Switch to pc-two.example:3002",
        exact: true,
      }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { connectionCalls: unknown }).connectionCalls,
      ),
    ).toEqual([{ action: "activate", value: "pc-one" }]);
    expect(localCredentials).toEqual([]);
  });
}

for (const { width, localId, label } of [
  { width: 1434, localId: localServer.id, label: "matching server IDs" },
  { width: 390, localId: "local-only-fixture", label: "mobile navigation" },
]) {
  test(`the remote desktop selector opens local servers through the bridge with ${label}`, async ({
    page,
    context,
  }, testInfo) => {
    const localServers = [
      { ...localServer, iconDataUrl: iconData("red") },
      {
        ...localServer,
        id: "local-only-fixture",
        name: "Local survival world",
        iconDataUrl: iconData("orange"),
      },
    ];
    const remoteServers = [
      {
        ...localServer,
        name: "Shared family world",
        iconVersion: "remote-family-icon",
        accessPermissions: ["control.console"],
      },
      {
        ...localServer,
        id: "remote-second-fixture",
        name: "Shared creative world",
        iconVersion: "remote-creative-icon",
        accessPermissions: ["control.console"],
      },
    ];
    const requests: {
      path: string;
      method: string;
      serverId: string | null;
    }[] = [];
    await desktopBridge(page, { activeId: "pc-one", localServers });
    await page.route("**/api/**", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const serverId =
        request.headers()["x-server-id"] ?? url.searchParams.get("serverId");
      requests.push({ path: url.pathname, method: request.method(), serverId });
      if (url.pathname === "/api/access/session")
        return route.fulfill({
          json: {
            role: "subuser",
            email: "sister@example.test",
            userId: "sister",
            serverId: remoteServers[0].id,
            permissions: ["control.console"],
          },
        });
      if (url.pathname === "/api/servers")
        return route.fulfill({
          json: {
            servers: remoteServers,
            defaultServerId: remoteServers[0].id,
          },
        });
      if (url.pathname === "/api/server") {
        const server = remoteServers.find((item) => item.id === serverId);
        if (server) return route.fulfill({ json: server });
      }
      if (url.pathname === "/api/console")
        return route.fulfill({ json: { lines: [] } });
      if (
        url.pathname === "/api/server/icon" &&
        remoteServers.some((item) => item.id === serverId)
      )
        return route.fulfill({
          contentType: "image/png",
          body: iconBytes(serverId === remoteServers[0].id ? "blue" : "green"),
        });
      return route.fulfill({
        status: 404,
        json: { error: "Not available on this remote panel." },
      });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#console");
    await expect(
      page.getByRole("heading", { name: remoteServers[0].name, exact: true }),
    ).toBeVisible();
    if (width < 761) {
      await page.screenshot({
        path: testInfo.outputPath("mobile-local-remote-sidebar-closed.png"),
        animations: "disabled",
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    }
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    const localList = nav.getByRole("list", {
      name: "Servers on this computer",
      exact: true,
    });
    const remoteList = nav.getByRole("list", {
      name: `Servers on ${new URL(page.url()).host}`,
      exact: true,
    });
    await expect(localList.getByRole("button")).toHaveCount(2);
    await expect(remoteList.getByRole("button")).toHaveCount(2);
    const local = localList.getByRole("button", {
      name: `Open local server ${localServers.find((item) => item.id === localId)!.name}`,
      exact: true,
    });
    await expect(local).toHaveAttribute("data-local-server-id", localId);
    await expect(localList.locator("[data-server-id]")).toHaveCount(0);
    await expect(localList.locator("img")).toHaveCount(2);
    for (const server of localServers)
      await expect(
        localList.getByRole("img", {
          name: `${server.name} server icon`,
          exact: true,
        }),
      ).toHaveAttribute("src", server.iconDataUrl);
    await expect
      .poll(async () =>
        page.evaluate(async () =>
          (await window.mcPanelConnections!.list()).panels
            .find((panel) => panel.id === "pc-one")
            ?.servers?.map((server) => server.iconDataUrl),
        ),
      )
      .toEqual([iconData("blue"), iconData("green")]);
    await expect(
      remoteList.getByRole("button", {
        name: `Select server ${remoteServers[0].name}`,
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await remoteList
      .getByRole("button", {
        name: `Select server ${remoteServers[1].name}`,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("heading", { name: remoteServers[1].name, exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        requests.some(
          (request) =>
            request.path === "/api/server" &&
            request.serverId === remoteServers[1].id,
        ),
      )
      .toBe(true);
    if (width < 761)
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    await expect(local).toBeVisible();
    if (width < 761)
      await expect
        .poll(() =>
          page
            .locator(".sidebar")
            .evaluate((element) => element.getBoundingClientRect().left),
        )
        .toBe(0);
    await page.screenshot({
      path: testInfo.outputPath(
        `${width < 761 ? "mobile" : "desktop"}-local-remote-selector.png`,
      ),
      animations: "disabled",
      fullPage: width >= 761,
    });
    await local.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { connectionCalls: unknown }).connectionCalls,
        ),
      )
      .toEqual([{ action: "selectLocalServer", value: localId }]);
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(
      requests.filter((request) => request.path.startsWith("/api/desktop/")),
    ).toEqual([]);
    expect(
      requests.filter((request) => request.serverId === "local-only-fixture"),
    ).toEqual([]);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("mc-panel.active-server.sister@example.test"),
      ),
    ).toBe(remoteServers[1].id);
    expect(context.pages()).toHaveLength(1);
  });
}

test("a local server selection event switches the owner workspace and scopes subsequent requests", async ({
  page,
}) => {
  const second = {
    ...localServer,
    id: "owner-second-fixture",
    name: "Local selected world",
  };
  const servers = [localServer, second];
  const scopes: (string | undefined)[] = [];
  await desktopBridge(page, { localServers: servers });
  await localPanel(page, true);
  await page.route("**/api/servers", (route) =>
    route.fulfill({ json: { servers, defaultServerId: localServer.id } }),
  );
  await page.route("**/api/desktop/selection", (route) =>
    route.fulfill({ json: { desktop: true, activeServerId: localServer.id } }),
  );
  await page.route("**/api/server", (route) => {
    const id = route.request().headers()["x-server-id"];
    scopes.push(id);
    const server = servers.find((item) => item.id === id);
    return route.fulfill(
      server
        ? { json: server }
        : { status: 404, json: { error: "Unknown local server." } },
    );
  });
  await page.goto("/#console");
  await expect(
    page.getByRole("heading", { name: localServer.name, exact: true }),
  ).toBeVisible();
  await page.evaluate((serverId) => {
    for (const detail of [null, {}, { serverId: 42 }, { serverId: "" }])
      window.dispatchEvent(
        new CustomEvent("mc-panel-local-server-selected", { detail }),
      );
    window.dispatchEvent(
      new CustomEvent("mc-panel-local-server-selected", {
        detail: { serverId },
      }),
    );
  }, second.id);
  await expect(
    page.getByRole("heading", { name: second.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: `Select server ${second.name}`,
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => scopes.at(-1)).toBe(second.id);
  expect(scopes.every((id) => servers.some((server) => server.id === id))).toBe(
    true,
  );
  expect(
    await page.evaluate(() => localStorage.getItem("mc-panel.active-server")),
  ).toBe(second.id);
  expect(
    await page.evaluate(
      () => (window as unknown as { connectionCalls: unknown }).connectionCalls,
    ),
  ).toEqual([]);
});

test("returning to this computer keeps each remote roster and selects colliding IDs in the correct panel", async ({
  page,
}, testInfo) => {
  await desktopBridge(page, {
    activeId: "pc-one",
    senderId: "local",
    remoteServers: cachedRemoteServers,
  });
  await localPanel(page, true);
  const requests: { url: string; method: string; serverId: string | null }[] =
    [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/"))
      requests.push({
        url: request.url(),
        method: request.method(),
        serverId:
          request.headers()["x-server-id"] ?? url.searchParams.get("serverId"),
      });
  });
  await page.goto("/#console");
  await expect(
    page.getByRole("heading", { name: localServer.name, exact: true }),
  ).toBeVisible();
  await page.evaluate(async (serverId) => {
    await window.mcPanelConnections!.selectLocalServer(serverId);
    window.dispatchEvent(
      new CustomEvent("mc-panel-local-server-selected", {
        detail: { serverId },
      }),
    );
  }, localServer.id);
  const localList = page.getByRole("list", {
    name: "Servers on this computer",
    exact: true,
  });
  const family = page.getByRole("list", {
    name: "Servers on pc-one.example:3002",
    exact: true,
  });
  const friends = page.getByRole("list", {
    name: "Servers on pc-two.example:3002",
    exact: true,
  });
  await expect(
    localList.getByRole("button", {
      name: `Select server ${localServer.name}`,
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  for (const [list, panelId, server] of [
    [family, "pc-one", cachedRemoteServers["pc-one"][0]],
    [friends, "pc-two", cachedRemoteServers["pc-two"][0]],
  ] as const) {
    const row = list.getByRole("button");
    await expect(row).toHaveAttribute("data-remote-panel-id", panelId);
    await expect(row).toHaveAttribute("data-remote-server-id", server.id);
    await expect(row).toContainText(server.name);
    await expect(list.locator("[data-server-id]")).toHaveCount(0);
    await expect(
      row.getByRole("img", { name: `${server.name} server icon`, exact: true }),
    ).toHaveAttribute("src", server.iconDataUrl);
  }
  await page.screenshot({
    path: testInfo.outputPath("local-with-connected-remote-servers.png"),
    fullPage: true,
    animations: "disabled",
  });
  const beforeSelection = requests.length;
  await family.getByRole("button").click();
  await friends.getByRole("button").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { connectionCalls: unknown }).connectionCalls,
      ),
    )
    .toEqual([
      { action: "selectLocalServer", value: localServer.id },
      { action: "selectRemoteServer", value: `pc-one:${localServer.id}` },
      { action: "selectRemoteServer", value: `pc-two:${localServer.id}` },
    ]);
  expect(requests.slice(beforeSelection)).toEqual([]);
  expect(
    requests.every(
      (request) => new URL(request.url).origin === new URL(page.url()).origin,
    ),
  ).toBe(true);
  await expect(family).toBeVisible();
  await expect(friends).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("mc-panel.active-server")),
  ).toBe(localServer.id);
  // A successful sign-out in one hidden remote renderer clears only its report.
  await page.evaluate(() =>
    (window as ConnectionMock).connectionFixture.report("pc-one", null),
  );
  await expect(family).toHaveCount(0);
  await expect(friends.getByRole("button")).toBeVisible();
  await expect(localList.getByRole("button")).toBeVisible();
});

test("an empty local workspace keeps connected remote servers available without local server requests", async ({
  page,
}) => {
  await desktopBridge(page, {
    localServers: [],
    remoteServers: cachedRemoteServers,
  });
  await localPanel(page, true);
  await page.route("**/api/servers", (route) =>
    route.fulfill({ json: { servers: [], defaultServerId: null } }),
  );
  const scopedRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(?:server|console)(?:\?|$|\/)/.test(request.url()))
      scopedRequests.push(request.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Open remote server Friends creative world on pc-two.example:3002",
      exact: true,
    })
    .click();
  expect(
    await page.evaluate(
      () => (window as unknown as { connectionCalls: unknown }).connectionCalls,
    ),
  ).toEqual([
    { action: "selectRemoteServer", value: `pc-two:${localServer.id}` },
  ]);
  expect(scopedRequests).toEqual([]);
});

for (const reason of ["sign-out", "expired session"] as const) {
  test(`remote rosters survive hiding and transient failures, then clear on ${reason} without late republishing`, async ({
    page,
  }) => {
    const server = {
      ...localServer,
      name: "Authenticated family world",
      accessPermissions: ["control.console"],
    };
    await desktopBridge(page, {
      activeId: "pc-one",
      remoteServers: { "pc-two": cachedRemoteServers["pc-two"] },
    });
    let fleetMode: "ready" | "unavailable" | "pending" = "ready";
    let expired = false;
    let failedReads = 0;
    let pendingReads = 0;
    let holdStatusRead = false;
    let heldStatusReads = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseStatus!: () => void;
    const pendingStatus = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/access/session")
        return route.fulfill({
          json: {
            role: "subuser",
            email: "sister@example.test",
            userId: "sister",
            serverId: server.id,
            permissions: ["control.console"],
          },
        });
      if (path === "/api/servers") {
        if (fleetMode === "unavailable") {
          failedReads++;
          return route.fulfill({
            status: 503,
            json: { error: "Temporary connection interruption." },
          });
        }
        if (fleetMode === "pending") {
          pendingReads++;
          await pending;
        }
        return route.fulfill({
          json: { servers: [server], defaultServerId: server.id },
        });
      }
      if (path === "/api/access/logout")
        return route.fulfill({ json: { ok: true } });
      if (path === "/api/server" && holdStatusRead) {
        heldStatusReads++;
        await pendingStatus;
      }
      if (expired && ["/api/server", "/api/console"].includes(path))
        return route.fulfill({
          status: 401,
          json: { error: "Session expired." },
        });
      if (path === "/api/server") return route.fulfill({ json: server });
      if (path === "/api/console")
        return route.fulfill({ json: { lines: [] } });
      return route.fulfill({
        status: 404,
        json: { error: "Unavailable in remote fixture." },
      });
    });
    const roster = () =>
      page.evaluate(
        async () =>
          (await window.mcPanelConnections!.list()).panels.find(
            (panel) => panel.id === "pc-one",
          )?.servers ?? [],
      );
    const refreshSelected = () =>
      page.evaluate(
        (serverId) =>
          window.dispatchEvent(
            new CustomEvent("mc-panel-remote-server-selected", {
              detail: { serverId },
            }),
          ),
        server.id,
      );
    await page.goto("/#console");
    await expect.poll(roster).toEqual([
      {
        id: server.id,
        name: server.name,
        status: "offline",
        software: "Paper",
        minecraftVersion: "1.21.1",
      },
    ]);
    await page
      .getByRole("button", {
        name: "Account menu for sister@example.test",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("menuitem", {
        name: "Switch to this computer",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.mcPanelConnections!.activate("local"));
    expect((await roster()).map((item) => item.id)).toEqual([server.id]);
    fleetMode = "unavailable";
    await refreshSelected();
    await expect.poll(() => failedReads).toBeGreaterThan(0);
    expect((await roster()).map((item) => item.id)).toEqual([server.id]);
    const cachedRetry = page.getByRole("button", {
      name: `Open remote server ${server.name} on pc-one.example:3002`,
      exact: true,
    });
    await expect(cachedRetry).toBeVisible();
    await expect(cachedRetry).toHaveAttribute("data-remote-panel-id", "pc-one");
    await expect(cachedRetry).toHaveAttribute(
      "data-remote-server-id",
      server.id,
    );
    fleetMode = "ready";
    await cachedRetry.click();
    expect(
      await page.evaluate(() =>
        (
          window as unknown as {
            connectionCalls: { action: string; value: string }[];
          }
        ).connectionCalls.filter(
          (call) => call.action === "selectRemoteServer",
        ),
      ),
    ).toEqual([{ action: "selectRemoteServer", value: `pc-one:${server.id}` }]);
    await expect(
      page.getByRole("heading", { name: server.name, exact: true }),
    ).toBeVisible();
    if (reason === "expired session") {
      // Capture a real workspace poll before target selection unmounts it.
      holdStatusRead = true;
      await expect.poll(() => heldStatusReads).toBeGreaterThan(0);
    }
    fleetMode = "pending";
    await refreshSelected();
    await expect.poll(() => pendingReads).toBeGreaterThan(0);
    try {
      if (reason === "sign-out") {
        await page
          .getByRole("button", {
            name: "Account menu for sister@example.test",
            exact: true,
          })
          .click();
        await page
          .getByRole("menuitem", { name: "Sign out", exact: true })
          .click();
      } else {
        expired = true;
        releaseStatus();
      }
      await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
      await expect.poll(roster).toEqual([]);
      const responseArrived = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/servers" &&
          response.status() === 200,
      );
      release();
      await (await responseArrived).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      expect(await roster()).toEqual([]);
      const reports = await page.evaluate(() =>
        (window as ConnectionMock).connectionReports.filter(
          (report) => report.panelId === "pc-one",
        ),
      );
      expect(reports.at(-1)?.servers).toBeNull();
      expect(
        await page.evaluate(
          async () =>
            (await window.mcPanelConnections!.list()).panels.find(
              (panel) => panel.id === "pc-two",
            )?.servers,
        ),
      ).toEqual(cachedRemoteServers["pc-two"]);
    } finally {
      release();
      releaseStatus();
    }
  });
}

for (const reason of ["default icon", "sign-out"] as const) {
  test(`a late remote icon response cannot restore a cleared image after ${reason}`, async ({
    page,
  }) => {
    let iconVersion: string | null = "initial-icon";
    const server = {
      ...localServer,
      name: "Delayed icon world",
      accessPermissions: ["control.console"],
    };
    await desktopBridge(page, { activeId: "pc-one" });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetching = false;
    let finished!: () => void;
    const completed = new Promise<void>((resolve) => {
      finished = resolve;
    });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/access/session")
        return route.fulfill({
          json: {
            role: "subuser",
            email: "sister@example.test",
            userId: "sister",
            serverId: server.id,
            permissions: ["control.console"],
          },
        });
      if (path === "/api/servers")
        return route.fulfill({
          json: {
            servers: [{ ...server, iconVersion }],
            defaultServerId: server.id,
          },
        });
      if (path === "/api/server")
        return route.fulfill({ json: { ...server, iconVersion } });
      if (path === "/api/console")
        return route.fulfill({ json: { lines: [] } });
      if (path === "/api/access/logout")
        return route.fulfill({ json: { ok: true } });
      if (path === "/api/server/icon") {
        if (route.request().resourceType() === "fetch") {
          fetching = true;
          await pending;
          try {
            await route.fulfill({
              contentType: "image/png",
              body: iconBytes("red"),
            });
          } catch {
            /* The cleared icon request is expected to be aborted. */
          } finally {
            finished();
          }
          return;
        }
        return route.fulfill({
          contentType: "image/png",
          body: iconBytes("red"),
        });
      }
      return route.fulfill({
        status: 404,
        json: { error: "Unavailable in icon fixture." },
      });
    });
    const roster = () =>
      page.evaluate(
        async () =>
          (await window.mcPanelConnections!.list()).panels.find(
            (panel) => panel.id === "pc-one",
          )?.servers ?? [],
      );
    await page.goto("/#console");
    try {
      await expect.poll(() => fetching).toBe(true);
      if (reason === "sign-out") {
        await page
          .getByRole("button", {
            name: "Account menu for sister@example.test",
            exact: true,
          })
          .click();
        await page
          .getByRole("menuitem", { name: "Sign out", exact: true })
          .click();
        await expect(
          page.getByLabel("Password", { exact: true }),
        ).toBeVisible();
        await expect.poll(roster).toEqual([]);
      } else {
        iconVersion = null;
        await page.evaluate(
          (serverId) =>
            window.dispatchEvent(
              new CustomEvent("mc-panel-remote-server-selected", {
                detail: { serverId },
              }),
            ),
          server.id,
        );
        await expect(
          page.getByRole("img", {
            name: `${server.name} server icon`,
            exact: true,
          }),
        ).toHaveCount(0);
        await expect
          .poll(async () => (await roster()).map((entry) => entry.id))
          .toEqual([server.id]);
      }
      release();
      await completed;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const remaining = await roster();
      expect(remaining.map((entry) => entry.id)).toEqual(
        reason === "sign-out" ? [] : [server.id],
      );
      expect(remaining.some((entry) => entry.iconDataUrl)).toBe(false);
    } finally {
      release();
    }
  });
}

test("desktop invitations use the scoped connection bridge and keep credentials on the destination", async ({
  page,
  context,
}) => {
  await desktopBridge(page);
  const { localCredentials } = await localPanel(page, true);
  const apiOpens: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/desktop/connections/open"))
      apiOpens.push(request.url());
  });
  await page.goto("/#console");
  const dialog = await openConnection(page, true);
  await expect(dialog).toContainText(
    "Use the server list to open servers on this computer or a connected panel.",
  );
  await dialog
    .getByLabel("Panel address or invitation link")
    .fill(invitationUrl);
  await dialog
    .getByRole("button", { name: "Continue with invitation" })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { connectionCalls: unknown }).connectionCalls,
    ),
  ).toEqual([{ action: "open", value: invitationUrl }]);
  expect(localCredentials).toEqual([]);
  expect(apiOpens).toEqual([]);
  expect(context.pages()).toHaveLength(1);
});

test("a remote desktop sign-in screen can return to this computer before authentication", async ({
  page,
}) => {
  await desktopBridge(page);
  await page.route("**/api/access/session", (route) =>
    route.fulfill({ json: { role: "guest" } }),
  );
  await page.goto("/");
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to this computer" }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { connectionCalls: unknown }).connectionCalls,
    ),
  ).toEqual([{ action: "activate", value: "local" }]);
});

for (const invitation of [false, true]) {
  test(`a browser opens the remote ${invitation ? "invitation" : "sign-in address"} directly`, async ({
    page,
  }) => {
    const { localCredentials } = await localPanel(page);
    const desktopOpens: unknown[] = [];
    await page.route("**/api/desktop/connections/open", (route) => {
      desktopOpens.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    });
    const navigations: string[] = [];
    await page.route(`${panelOrigin}/`, (route) => {
      navigations.push(route.request().url());
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body><h1>Remote panel destination</h1></body></html>",
      });
    });
    await page.goto("/");
    const dialog = await openConnection(page, invitation);
    await dialog
      .getByRole("textbox", { name: "Panel address or invitation link" })
      .fill(
        invitation
          ? `https://PANEL.example.test:443/#invite=${invitationToken}`
          : "https://PANEL.example.test:443",
      );
    await dialog
      .getByRole("button", {
        name: invitation ? "Continue with invitation" : "Continue to sign in",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("heading", { name: "Remote panel destination" }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      invitation ? invitationUrl : `${panelOrigin}/`,
    );
    // Fragments are retained for the remote app but are never sent as part of
    // its HTTP navigation request.
    expect(navigations).toEqual([`${panelOrigin}/`]);
    expect(desktopOpens).toEqual([]);
    expect(localCredentials).toEqual([]);
  });
}
