import { expect, test, type Page } from "@playwright/test";
import catalog from "../shared/subuser-permissions.json" with { type: "json" };

const initialPermissions = [
  "control.start",
  "control.stop",
  "control.console",
  "user.read",
  "user.create",
  "user.update",
  "user.delete",
];
const adminPermissions = catalog.groups.flatMap((group) =>
  group.permissions.map((permission) => permission.id),
);
const java = {
  available: true,
  majorVersion: 21,
  version: "21.0.8",
  path: "D:\\Java\\bin\\java.exe",
};
const existing = {
  id: "shared-survival",
  name: "Existing survival",
  status: "offline",
  mode: "live",
  software: "Paper",
  version: "1.21.1",
  minecraftVersion: "1.21.1",
  port: 25565,
  accessPermissions: initialPermissions,
};
type Record = typeof existing & { source?: string };
type Call = { path: string; method: string; body: any; serverId?: string };

async function remotePanel(page: Page, granted = true) {
  const state = {
    hostPermissions: granted ? ["server.create"] : [],
    // A stale session grant must never override the roster's current decision.
    sessionHostPermissions: ["server.create"],
    servers: [{ ...existing }] as Record[],
    calls: [] as Call[],
    users: [
      {
        id: "host-grantee",
        email: "creator@example.test",
        permissions: ["control.start"],
        hostPermissions: ["server.create"],
        createdAt: "2026-09-25T12:00:00Z",
      },
    ],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;
    const serverId = request.headers()["x-server-id"];
    state.calls.push({ path, method, body, serverId });
    const reply = (json: unknown, status = 200) =>
      route.fulfill({ json, status });
    if (path === "/api/access/session")
      return reply({
        role: "subuser",
        email: "manager@example.test",
        userId: "manager",
        serverId: existing.id,
        permissions: initialPermissions,
        hostPermissions: state.sessionHostPermissions,
      });
    if (path === "/api/servers")
      return reply({
        servers: state.servers,
        defaultServerId: existing.id,
        hostPermissions: state.hostPermissions,
      });
    if (path === "/api/server")
      return reply({
        ...state.servers.find(
          (server) => server.id === (serverId || existing.id),
        ),
        address: "server.example.test",
        players: [],
        maxPlayers: 20,
        cpu: 0,
        cpuCapacity: 800,
        memory: 0,
        memoryLimit: 4096 * 1024 ** 2,
        disk: 0,
        diskLimit: 1024 ** 4,
        uptime: 0,
      });
    if (path === "/api/console") return reply({ lines: [] });
    if (path === "/api/subusers" && method === "GET")
      return reply({ users: state.users });
    if (path === "/api/subusers" && method === "POST") {
      const user = {
        ...body,
        id: "new-subuser",
        createdAt: "2026-09-25T12:00:00Z",
      };
      state.users.push(user);
      return reply(user, 201);
    }
    if (path === "/api/server-setup/directories") {
      const directory = url.searchParams.get("directory");
      return reply({
        directory,
        parent: directory === "D:\\Servers" ? "D:\\" : null,
        separator: "\\",
        truncated: false,
        folders:
          directory === null
            ? [{ name: "D:\\", path: "D:\\" }]
            : directory === "D:\\"
              ? [{ name: "Servers", path: "D:\\Servers" }]
              : [],
      });
    }
    if (path === "/api/server-import/inspect")
      return reply({
        directory: body.directory,
        name: "Imported adventure",
        port: 25566,
        motd: "Existing adventure",
        maxPlayers: 20,
        jars: ["server.jar"],
        jar: "server.jar",
        launchType: "jar",
        javaPath: java.path,
        eulaAccepted: true,
        warnings: [],
        world: "world",
      });
    if (path === "/api/server-import" && method === "POST") {
      const server = {
        ...existing,
        id: "new-import",
        name: body.name,
        port: body.port,
        source: "imported",
        accessPermissions: adminPermissions,
      };
      state.servers.push(server);
      return reply({ server }, 201);
    }
    if (path === "/api/server-setup" && method === "GET")
      return reply({
        providers: [
          {
            id: "paper",
            name: "Paper",
            description: "Plugin server",
            website: "https://papermc.io",
            installable: true,
            kind: "server",
          },
        ],
        platforms: [],
        gameVersions: ["1.21.1"],
        hostMemoryMB: 16384,
        freeMemoryMB: 12288,
        suggestedMemoryMB: 4096,
        java,
        warnings: [],
        managedServersDir: "D:\\MC Panel\\instances",
      });
    if (path === "/api/server-setup/java")
      return reply({
        installations: [
          {
            path: java.path,
            version: java.version,
            majorVersion: 21,
            vendor: "Fixture Java",
            architecture: "amd64",
          },
        ],
        recommendedPath: java.path,
        detectedCount: 1,
        requiredJavaVersion: 21,
        requirement: "Java 21",
        warnings: [],
      });
    if (path === "/api/server-setup/versions/paper")
      return reply({
        versions: [{ id: "1.21.1", label: "1.21.1", stable: true }],
      });
    if (path === "/api/server-setup/versions/paper/1.21.1")
      return reply({
        builds: [
          {
            id: "151",
            label: "151",
            stable: true,
            recommended: true,
            javaVersion: 21,
          },
        ],
      });
    if (path === "/api/server-setup/preflight")
      return reply({
        hostMemoryMB: 16384,
        freeMemoryMB: 12288,
        memoryLimitMB: 4096,
        requiredJavaVersion: 21,
        compatible: true,
        ready: true,
        java,
        warnings: [],
        installationDirectory: body.installationDirectory,
        supportDirectory: "D:\\Servers\\.mc-panel",
      });
    if (path === "/api/server-setup" && method === "POST") {
      const server = {
        ...existing,
        id: "new-created",
        name: body.configuration.name,
        port: body.configuration.port,
        accessPermissions: adminPermissions,
      };
      state.servers.push(server);
      return reply({ server }, 201);
    }
    if (path === "/api/versions/install")
      return reply({ job: { id: "created-install", state: "completed" } }, 202);
    return reply(
      { error: `Unexpected fixture request: ${method} ${path}` },
      404,
    );
  });
  return state;
}

test("only the live host grant exposes Add server, and revocation removes it", async ({
  page,
}) => {
  const state = await remotePanel(page, false);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: existing.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add server", exact: true }),
  ).toHaveCount(0);
  state.hostPermissions = ["server.create"];
  await expect(
    page.getByRole("button", { name: "Add server", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  state.hostPermissions = [];
  await expect(
    page.getByRole("button", { name: "Add server", exact: true }),
  ).toHaveCount(0, { timeout: 10000 });
  expect(
    state.calls.filter(
      (call) =>
        call.path.startsWith("/api/server-setup") ||
        call.path.startsWith("/api/server-import"),
    ),
  ).toEqual([]);
});

test("a remote creator imports a server through the inline host picker and retains both memberships", async ({
  page,
}, testInfo) => {
  const state = await remotePanel(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Import an existing server", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Browse", exact: true }).click();
  const picker = dialog.getByRole("region", { name: "Choose server folder" });
  await expect(
    picker.getByText(`Folders on ${new URL(page.url()).host}`, { exact: true }),
  ).toBeVisible();
  await picker.getByRole("button", { name: "D:\\", exact: true }).click();
  await picker.getByRole("button", { name: "Servers", exact: true }).click();
  await expect(picker.getByLabel("New folder name (optional)")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("remote-import-picker.png"),
    fullPage: true,
  });
  await picker
    .getByRole("button", { name: "Use this folder", exact: true })
    .click();
  await expect(dialog.getByLabel("Server folder", { exact: true })).toHaveValue(
    "D:\\Servers",
  );
  await dialog
    .getByRole("button", { name: "Inspect folder", exact: true })
    .click();
  await expect(
    dialog.getByText("Folder inspected", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Import server", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Imported adventure", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('button[data-server-id="shared-survival"]'),
  ).toBeVisible();
  await expect(
    page.locator('button[data-server-id="new-import"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("link", { name: "File Manager", exact: true }),
  ).toBeVisible();
  const imported = state.calls.find(
    (call) => call.path === "/api/server-import" && call.method === "POST",
  )!;
  expect(imported.body).toMatchObject({
    directory: "D:\\Servers",
    name: "Imported adventure",
    port: 25566,
  });
  expect(imported.serverId).toBeUndefined();
  expect(state.calls.some((call) => call.path.endsWith("/browse"))).toBe(false);
  expect(
    state.calls.some((call) => call.path.startsWith("/api/desktop/")),
  ).toBe(false);
});

test("remote guided creation installs into the created membership without changing existing server access", async ({
  page,
}) => {
  const state = await remotePanel(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Create a new server", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Server software", exact: true })
    .click();
  await dialog.getByRole("button", { name: /Paper/ }).click();
  await dialog
    .getByRole("combobox", { name: "Minecraft version", exact: true })
    .selectOption("1.21.1");
  await dialog
    .getByRole("combobox", { name: "Build", exact: true })
    .selectOption("151");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog
    .getByLabel("Server name", { exact: true })
    .fill("Created adventure");
  await expect(
    dialog.getByRole("combobox", { name: "Java executable", exact: true }),
  ).toHaveValue("21");
  await dialog
    .getByRole("button", { name: "Review installation", exact: true })
    .click();
  await dialog
    .getByRole("checkbox", {
      name: "I agree to the Minecraft EULA",
      exact: true,
    })
    .check();
  await dialog
    .getByRole("button", { name: "Create and install", exact: true })
    .click();
  await expect(
    dialog.getByText("Installed and stopped", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Open Console", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Created adventure", exact: true }),
  ).toBeVisible();
  expect(
    state.calls.filter((call) => call.path === "/api/versions/install"),
  ).toMatchObject([
    {
      serverId: "new-created",
      body: {
        provider: "paper",
        version: "1.21.1",
        build: "151",
        confirmed: true,
      },
    },
  ]);
  expect(state.servers[0].accessPermissions).toEqual(initialPermissions);
  await page.locator('button[data-server-id="shared-survival"]').click();
  await expect(
    page.getByRole("heading", { name: existing.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "File Manager", exact: true }),
  ).toHaveCount(0);
  const creation = state.calls.find(
    (call) => call.path === "/api/server-setup" && call.method === "POST",
  )!;
  expect(creation.body).toMatchObject({
    confirmed: true,
    acceptedEula: true,
    configuration: { name: "Created adventure", port: 25566 },
  });
  expect(creation.body.requestId).toEqual(expect.any(String));
  expect(creation.serverId).toBeUndefined();
});

test("a remote user manager cannot grant computer permissions or edit an existing host grantee", async ({
  page,
}) => {
  const state = await remotePanel(page);
  await page.goto("/#subusers");
  await expect(
    page.getByRole("button", {
      name: "Edit permissions for creator@example.test",
      exact: true,
    }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "New user", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  await expect(
    dialog.getByRole("checkbox", {
      name: "Create and import servers",
      exact: true,
    }),
  ).toHaveCount(0);
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("helper@example.test");
  await dialog
    .getByRole("button", { name: "Use Control preset", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const created = state.calls.find(
    (call) => call.path === "/api/subusers" && call.method === "POST",
  )!;
  expect(created.body.email).toBe("helper@example.test");
  expect(created.body).not.toHaveProperty("hostPermissions");
});
