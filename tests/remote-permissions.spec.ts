import { expect, test, type Page } from "@playwright/test";

const stamp = "2026-09-20T12:00:00.000Z";
const server = {
  id: "shared-permission-fixture",
  name: "Shared permission fixture",
  mode: "live",
  status: "running",
  software: "Paper",
  version: "1.21.1",
  minecraftVersion: "1.21.1",
  players: [],
  maxPlayers: 20,
  memory: 0,
  cpu: 0,
  cpuCapacity: 800,
  memoryLimit: 2048,
  disk: 1024,
  diskLimit: 1024 ** 3,
  uptime: 60,
  address: "play.example.test",
};

async function sharedPanel(page: Page, permissions: string[]) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const users = [
    {
      id: "limited",
      email: "limited@example.test",
      permissions: ["file.read"],
      createdAt: stamp,
    },
    {
      id: "privileged",
      email: "privileged@example.test",
      permissions: ["control.console"],
      createdAt: stamp,
    },
    {
      id: "panel-managed",
      email: "panel-managed@example.test",
      permissions: ["file.read"],
      panelAccount: true,
      createdAt: stamp,
    },
  ];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    calls.push({ path, method, body });
    const reply = (json: unknown) => route.fulfill({ json });
    if (path === "/api/access/session")
      return reply({
        role: "subuser",
        email: "manager@example.test",
        userId: "manager",
        serverId: server.id,
        permissions,
      });
    if (path === "/api/servers")
      return reply({
        servers: [{ ...server, accessPermissions: permissions }],
        defaultServerId: server.id,
      });
    if (path === "/api/server") return reply(server);
    if (path === "/api/console") return reply({ lines: [] });
    if (path === "/api/audit")
      return reply({
        entries: [
          {
            id: "shared-audit-event",
            action: "file.edited",
            detail: "Updated shared server settings",
            actor: "manager@example.test",
            category: "file",
            createdAt: stamp,
          },
        ],
      });
    if (path === "/api/versions")
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
        current: { ...server, status: "offline" },
        runtimeUpdate: {
          available: false,
          provider: "paper",
          gameVersion: "1.21.1",
          build: null,
        },
      });
    if (path === "/api/versions/paper")
      return reply({
        versions: [{ id: "1.21.1", label: "1.21.1", stable: true }],
      });
    if (path === "/api/versions/paper/1.21.1")
      return reply({ builds: [{ id: "151", label: "151", stable: true }] });
    if (path === "/api/launchpad")
      return reply({
        platforms: [
          {
            id: "modrinth",
            name: "Modrinth",
            available: true,
            types: ["plugin"],
            sortOptions: [{ id: "downloads", label: "Downloads" }],
          },
        ],
        gameVersion: "1.21.1",
        gameVersions: ["1.21.1"],
        loader: "paper",
        loaders: ["paper"],
        status: "offline",
        warnings: [],
      });
    if (path === "/api/launchpad/search")
      return reply({
        projects: [
          {
            id: "fixture-plugin",
            platform: "modrinth",
            title: "Fixture Plugin",
            description: "Catalog fixture",
            downloads: 1,
          },
        ],
        total: 1,
        offset: 0,
        limit: 10,
      });
    if (path === "/api/launchpad/installed")
      return reply({ items: [], warnings: [] });
    if (path === "/api/files")
      return reply({
        path: "",
        entries: [
          {
            name: "notes.txt",
            path: "notes.txt",
            type: "file",
            size: 13,
            modified: stamp,
          },
          {
            name: "world",
            path: "world",
            type: "directory",
            size: 0,
            modified: stamp,
          },
        ],
      });
    if (path === "/api/files/content")
      return reply({ content: "Saved notes." });
    if (path === "/api/files/recycle-bin")
      return reply({
        protected: true,
        items: [
          {
            id: "recycled",
            name: "old.txt",
            originalPath: "old.txt",
            type: "file",
            size: 4,
            deletedAt: stamp,
            status: "ready",
          },
        ],
      });
    if (path === "/api/backups")
      return reply({
        backups: [
          {
            id: "archive",
            name: "Before changes",
            size: 1024,
            createdAt: stamp,
            status: "completed",
            trigger: "manual",
          },
        ],
        schedule: {
          enabled: false,
          type: "interval",
          intervalHours: 6,
          time: "03:00",
          dayOfWeek: 0,
          retention: 7,
          nextRun: null,
        },
      });
    if (path === "/api/minecraft/properties")
      return reply({
        files: [{ path: "server.properties", name: "server.properties" }],
      });
    if (path === "/api/minecraft/properties/file")
      return reply({
        path: "server.properties",
        revision: "fixture",
        status: "running",
        fields: [
          {
            key: "max-players",
            label: "max players",
            type: "number",
            value: 20,
          },
        ],
      });
    if (path === "/api/players")
      return reply({
        mode: "live",
        status: "running",
        operators: [],
        online: [
          {
            name: "Builder",
            online: true,
            firstSeen: stamp,
            lastSeen: stamp,
            source: "observed",
            banned: false,
          },
        ],
        history: [],
        banned: [],
        whitelist: [],
        whitelistEnabled: false,
        whitelistAvailable: true,
        whitelistSettingsAvailable: true,
      });
    if (path === "/api/subusers" && method === "GET") return reply({ users });
    if (path === "/api/subusers" && method === "POST") {
      const user = {
        id: "new-helper",
        email: body.email,
        permissions: body.permissions,
        createdAt: stamp,
      };
      users.push(user);
      return reply(user);
    }
    if (path === "/api/subusers/new-helper/invite")
      return reply({
        user: users.at(-1),
        invitationUrl: `https://panel.example.test/#invite=${"A".repeat(43)}`,
        inviteExpiresAt: "2099-01-01T00:00:00.000Z",
      });
    return route.fulfill({
      status: 403,
      json: { error: "The fixture does not authorize this request." },
    });
  });
  return calls;
}

test("file listing access does not fetch file contents or enable file changes", async ({
  page,
}) => {
  const calls = await sharedPanel(page, ["file.read"]);
  await page.goto("/#files");
  await expect(
    page.getByRole("heading", { name: "File Manager", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "notes.txt", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "New file", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Upload files", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Delete notes.txt", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Download notes.txt" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Download world", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Download selected",
      exact: true,
      includeHidden: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Open Recycle Bin" }),
  ).toHaveCount(0);
  expect(
    calls.filter(
      (call) =>
        call.path === "/api/files/content" ||
        call.path === "/api/files/recycle-bin" ||
        call.method !== "GET",
    ),
  ).toEqual([]);
});

test("large download selections explain how to download the folder instead", async ({
  page,
}) => {
  const calls = await sharedPanel(page, ["file.read", "file.read-content"]);
  await page.route("**/api/files?**", (route) =>
    route.fulfill({
      json: {
        path: "",
        entries: Array.from({ length: 25 }, (_, index) => ({
          name: `settings-${index}.txt`,
          path: `${"long-folder-name/".repeat(24)}settings-${index}.txt`,
          type: "file",
          size: 0,
          modified: stamp,
        })),
      },
    }),
  );
  await page.goto("/#files");
  await page
    .getByRole("checkbox", {
      name: "Select all visible files and folders",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Download selected", exact: true })
    .click();
  await expect(
    page.getByText(
      "Select fewer items at once, or download their folder as a ZIP.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(calls.filter((call) => call.path === "/api/files/download")).toEqual(
    [],
  );
  await expect(page).toHaveURL(/#files$/);
});

test("file readers get a read-only editor and recycling requires both storage grants", async ({
  page,
}) => {
  const calls = await sharedPanel(page, [
    "file.read",
    "file.read-content",
    "file.create",
    "backup.read",
  ]);
  await page.goto("/#files");
  await page
    .getByRole("button", { name: "View notes.txt", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "notes.txt", exact: true });
  await expect(editor.getByLabel("File contents")).toHaveValue("Saved notes.");
  await expect(editor.getByLabel("File contents")).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(
    editor.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Open Recycle Bin" }).click();
  await expect(
    page.getByRole("button", { name: "Restore old.txt", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Permanently delete old.txt",
      exact: true,
    }),
  ).toBeDisabled();
  expect(
    calls.filter(
      (call) => call.method !== "GET" || call.path.endsWith("/restore-preview"),
    ),
  ).toEqual([]);
});

test("backup readers can inspect archives and schedules without changing or downloading them", async ({
  page,
}) => {
  const calls = await sharedPanel(page, ["backup.read"]);
  await page.goto("/#backups");
  await expect(
    page.getByRole("heading", { name: "Before changes", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create backup", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Delete backup Before changes",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("switch", { name: "Enable automatic backups" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save schedule", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Download backup Before changes" }),
  ).toHaveCount(0);
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
});

test("catalog readers can browse Versions and Launchpad while content changes and settings remain unavailable", async ({
  page,
}) => {
  const calls = await sharedPanel(page, ["file.read"]);
  await page.route("**/api/server", (route) =>
    route.fulfill({ json: { ...server, status: "offline" } }),
  );
  await page.goto("/#versions");
  await page
    .getByRole("button", { name: "Choose version", exact: true })
    .click();
  await page.getByRole("button", { name: "1.21.1", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Install", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Launchpad", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Fixture Plugin", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Install Fixture Plugin", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Platform settings", exact: true }),
  ).toHaveCount(0);
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
});

test("properties and player controls stay disabled for read-only access", async ({
  page,
}) => {
  const calls = await sharedPanel(page, ["file.read-content"]);
  await page.goto("/#properties");
  await expect(page.getByLabel("max players", { exact: true })).toHaveValue(
    "20",
  );
  await expect(page.getByLabel("max players", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Players", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Kick online player Builder",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Add player to whitelist", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("switch", { name: "Enable whitelist", exact: true }),
  ).toBeDisabled();
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
});

test("remote audit readers keep server filters without offering owner-only panel activity", async ({
  page,
}) => {
  const calls = await sharedPanel(page, ["audit.read"]);
  await page.goto("/#audit");
  await expect(
    page.getByRole("heading", { name: "Audit logs", exact: true }),
  ).toBeVisible();
  const row = page.getByRole("row").filter({
    hasText: "Updated shared server settings",
  });
  await expect(row).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Audit scope" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(row).toBeVisible();
  const search = page.getByRole("textbox", {
    name: "Search audit logs",
    exact: true,
  });
  await search.fill("no matching event");
  await expect(
    page.getByRole("heading", { name: "No activity matches your filters" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "Refresh audit logs" }).click();
  await expect(
    page.getByText("Audit logs refreshed.", { exact: true }),
  ).toBeVisible();
  expect(calls.some((call) => call.path === "/api/panel/audit")).toBe(false);
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
});

test("remote subuser managers grant only their own permissions and invite without owner setup calls", async ({
  page,
}) => {
  const permissions = [
    "user.read",
    "user.create",
    "user.update",
    "user.delete",
    "file.read",
  ];
  const calls = await sharedPanel(page, permissions);
  await page.goto("/#subusers");
  const panelAccount = page
    .getByRole("row")
    .filter({ hasText: "panel-managed@example.test" });
  await expect(panelAccount).toContainText("Managed by panel owner");
  for (const action of [
    "Edit permissions for",
    "Remove access record for",
    "Create invite link for",
  ])
    await expect(
      panelAccount.getByRole("button", {
        name: `${action} panel-managed@example.test`,
        exact: true,
      }),
    ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Edit permissions for limited@example.test",
    }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: "Edit permissions for privileged@example.test",
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Remove access record for privileged@example.test",
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Create invite link for privileged@example.test",
    }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "New user", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  await editor
    .getByLabel("Email address", { exact: true })
    .fill("helper@example.test");
  await expect(
    editor.getByRole("checkbox", { name: "Console", exact: true }),
  ).toHaveCount(0);
  await expect(
    editor.getByRole("checkbox", { name: "Edit files", exact: true }),
  ).toHaveCount(0);
  await editor
    .getByRole("checkbox", { name: "All permissions", exact: true })
    .check();
  await editor
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  const invitation = page.getByRole("dialog", {
    name: "Share invitation link",
    exact: true,
  });
  await expect(invitation.getByLabel("Invitation link")).toHaveValue(
    `https://panel.example.test/#invite=${"A".repeat(43)}`,
  );
  expect(
    calls.find(
      (call) => call.path === "/api/subusers" && call.method === "POST",
    )?.body,
  ).toEqual({ email: "helper@example.test", permissions });
  expect(
    calls.filter(
      (call) =>
        call.path.startsWith("/api/access/") &&
        call.path !== "/api/access/session",
    ),
  ).toEqual([]);
  expect(calls.filter((call) => call.path.endsWith("/invite"))).toHaveLength(1);
  expect(
    calls.filter((call) => call.path.startsWith("/api/panel-users")),
  ).toEqual([]);
});

test("remote managers cannot reset their own access but can reset another user's access", async ({
  page,
}) => {
  const permissions = ["user.read", "user.create"];
  const calls = await sharedPanel(page, permissions);
  const ownUser = {
    id: "manager",
    email: "manager@example.test",
    permissions,
    createdAt: stamp,
    inviteStatus: "accepted",
  };
  const otherUser = {
    ...ownUser,
    id: "helper",
    email: "helper@example.test",
  };
  await page.route("**/api/subusers", (route) =>
    route.fulfill({ json: { users: [ownUser, otherUser] } }),
  );
  const invitations: string[] = [];
  const warning = "Invitation created, but its audit entry could not be saved.";
  await page.route("**/api/subusers/*/invite", (route) => {
    invitations.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      json: {
        user: { ...otherUser, inviteStatus: "pending" },
        invitationUrl: `https://panel.example.test/#invite=${"B".repeat(43)}`,
        inviteExpiresAt: "2099-01-01T00:00:00.000Z",
        warning,
      },
    });
  });
  await page.goto("/#subusers");
  const ownReset = page.getByRole("button", {
    name: "Reset access for manager@example.test",
    exact: true,
  });
  await expect(ownReset).toBeDisabled();
  await expect(ownReset).toHaveAttribute(
    "title",
    "Ask the panel owner to reset your own access.",
  );
  await expect(
    page.getByText("Ask the panel owner to reset your own access.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Reset access for helper@example.test",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "Reset subuser access?", exact: true })
    .getByRole("button", { name: "Reset and create link", exact: true })
    .click();
  const invitation = page.getByRole("dialog", {
    name: "Share invitation link",
    exact: true,
  });
  await expect(invitation.getByLabel("Invitation link")).toHaveValue(
    `https://panel.example.test/#invite=${"B".repeat(43)}`,
  );
  await expect(invitation.getByRole("alert")).toHaveText(warning);
  await expect(ownReset).toBeDisabled();
  expect(invitations).toEqual(["/api/subusers/helper/invite"]);
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
});
