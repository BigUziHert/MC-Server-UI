import { expect, test, type Page } from "@playwright/test";

const invitationToken = "A".repeat(43);
const panelOrigin = "https://panel.example.test";
const invitationUrl = `${panelOrigin}/#invite=${invitationToken}`;
const localServer = {
  id: "local-connection-fixture",
  name: "Local connection fixture",
  mode: "live",
  status: "offline",
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
