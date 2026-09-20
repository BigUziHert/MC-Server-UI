import { expect, test, type Page } from "@playwright/test";

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
};

async function desktopBridge(
  page: Page,
  options: { activeId?: string; localServers?: LocalServerDescriptor[] } = {},
) {
  await page.addInitScript(
    ({ activeId, localServers }) => {
      const state = {
        activeId,
        localServers,
        panels: [
          {
            id: "local",
            label: "This computer",
            origin: location.origin,
            local: true,
          },
          {
            id: "pc-one",
            label: "pc-one.example:3002",
            origin: "https://pc-one.example:3002",
            local: false,
          },
          {
            id: "pc-two",
            label: "pc-two.example:3002",
            origin: "https://pc-two.example:3002",
            local: false,
          },
        ],
      };
      const calls: { action: string; value: string }[] = [];
      Object.assign(window, { connectionCalls: calls });
      window.mcPanelConnections = {
        list: async () => state,
        open: async (url) => {
          calls.push({ action: "open", value: url });
          return state;
        },
        activate: async (id) => {
          calls.push({ action: "activate", value: id });
          state.activeId = id;
          window.dispatchEvent(new Event("mc-panel-connections-changed"));
          return state;
        },
        disconnect: async (id) => {
          calls.push({ action: "disconnect", value: id });
          return state;
        },
        selectLocalServer: async (id) => {
          calls.push({ action: "selectLocalServer", value: id });
          state.activeId = "local";
          window.dispatchEvent(new Event("mc-panel-connections-changed"));
          return state;
        },
      };
    },
    {
      activeId: options.activeId ?? "local",
      localServers: options.localServers ?? [localServer],
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

async function openConnection(page: Page, invitation = false) {
  await page
    .getByRole("button", {
      name: "Account menu for Local administrator",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", {
      name: invitation ? "Accept an invitation" : "Sign in to another panel",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: invitation ? "Accept an invitation" : "Connect to a panel",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
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
  ).toBeVisible();
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

test("desktop account switches between this computer and multiple connected panels in one window", async ({
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
  await page
    .getByRole("menuitem", { name: "Switch to this computer", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => (window as unknown as { connectionCalls: unknown }).connectionCalls,
    ),
  ).toEqual([
    { action: "activate", value: "pc-two" },
    { action: "activate", value: "local" },
  ]);
  expect(context.pages()).toHaveLength(1);
});

for (const { width, localId, label } of [
  { width: 1434, localId: localServer.id, label: "matching server IDs" },
  { width: 390, localId: "local-only-fixture", label: "mobile navigation" },
]) {
  test(`the remote desktop selector opens local servers through the bridge with ${label}`, async ({
    page,
    context,
  }, testInfo) => {
    const localServers = [
      localServer,
      {
        ...localServer,
        id: "local-only-fixture",
        name: "Local survival world",
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
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path fill="#82b362" d="M0 0h64v64H0z"/></svg>',
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
    await expect(localList.locator("img")).toHaveCount(0);
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
    "Switch between this computer and connected panels",
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
