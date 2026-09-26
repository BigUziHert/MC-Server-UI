import { test, expect, type Page } from "@playwright/test";

const server = {
  id: "copy-resilience-fixture",
  name: "Copy fixture",
  mode: "live",
  status: "offline",
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
  uptime: 0,
  address: "localhost:25565",
};
const stamp = "2026-09-25T12:00:00.000Z";
const entry = (name: string, path = name, type = "file") => ({
  name,
  path,
  type,
  size: 12,
  modified: stamp,
});

async function copyFixture(
  page: Page,
  permissions: string[],
  options: { holdCopy?: Promise<void> } = {},
) {
  let copied = false;
  const mutations: { path: string; body: any }[] = [];
  let statusReads = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (json: unknown) => route.fulfill({ json });
    if (request.method() !== "GET")
      mutations.push({
        path,
        body: request.postData() ? request.postDataJSON() : null,
      });
    if (path === "/api/access/session")
      return reply({
        role: "subuser",
        email: "reader@example.test",
        userId: "reader",
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
    if (path === "/api/files" && request.method() === "GET") {
      const directory = url.searchParams.get("path") || "";
      return reply({
        path: directory,
        entries: directory
          ? copied
            ? [entry("source.txt", "destination/source.txt")]
            : []
          : [
              entry("source.txt"),
              entry("destination", "destination", "directory"),
            ],
      });
    }
    if (path === "/api/files/content")
      return reply({ content: "Source bytes", revision: "fixture" });
    if (path === "/api/files/copy-operation") {
      statusReads++;
      return reply({ operation: null });
    }
    if (path === "/api/files/copy" && request.method() === "POST") {
      await options.holdCopy;
      copied = true;
      return reply({
        copiedFiles: 1,
        copiedDirectories: 0,
        paths: ["destination/source.txt"],
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: "Not part of this fixture." },
    });
  });
  await page.goto("/#files");
  await expect(
    page.getByRole("heading", { name: "File Manager", exact: true }),
  ).toBeVisible();
  return { mutations, statusReads: () => statusReads };
}

test("read-only source files can be selected and copied with the keyboard without deletion permission", async ({
  page,
}, testInfo) => {
  const fixture = await copyFixture(page, ["file.read", "file.read-content"]);
  const selection = page.getByRole("checkbox", {
    name: "Select source.txt",
    exact: true,
  });
  await expect(selection).toBeEnabled();
  await selection.check();
  await selection.focus();
  await page.keyboard.press("Control+c");
  await expect(
    page.getByRole("status", { name: "Copied files", exact: true }),
  ).toContainText("1 item copied from Copy fixture");
  await expect(
    page.getByRole("button", { name: "Delete selected", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Copy", exact: true }),
  ).toBeEnabled();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect
      .poll(() =>
        page.locator(".files-toolbar .storage-actions").evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return [...element.children].every((child) => {
            const rect = child.getBoundingClientRect();
            return (
              rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
            );
          });
        }),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.locator(".file-selection-actions").evaluate((element) => {
          const bounds = element
            .closest(".files-panel")!
            .getBoundingClientRect();
          return [...element.children].every((child) => {
            const rect = child.getBoundingClientRect();
            return rect.left >= bounds.left && rect.right <= bounds.right;
          });
        }),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  }
  await page.screenshot({
    path: testInfo.outputPath("file-toolbar-mobile-320.png"),
    fullPage: true,
  });
  expect(fixture.mutations).toEqual([]);
});

test("an unconfirmed background copy accepts a late success and refreshes without replacing a newer dialog", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await copyFixture(
    page,
    ["file.read", "file.read-content", "file.create"],
    { holdCopy: held },
  );
  try {
    await page
      .getByRole("checkbox", { name: "Select source.txt", exact: true })
      .check();
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await page
      .getByRole("button", { name: "destination", exact: true })
      .click();
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    const progress = page.getByRole("status", {
      name: "File transfer progress",
      exact: true,
    });
    await expect(progress).toContainText("outcome could not be confirmed");
    expect(fixture.statusReads()).toBe(5);
    const requests = fixture.mutations.filter(
      (request) => request.path === "/api/files/copy",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({
      sourceServerId: server.id,
      paths: ["source.txt"],
      destinationPath: "destination",
    });
    expect(requests[0].body.requestId).toMatch(/^[\da-f-]{36}$/i);
    await page.getByRole("button", { name: "New file", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New file", exact: true });
    await dialog
      .getByLabel("File name", { exact: true })
      .fill("keep-my-draft.txt");
    release();
    await expect(progress).toContainText("Transfer complete");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("File name", { exact: true })).toHaveValue(
      "keep-my-draft.txt",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "source.txt", exact: true }),
    ).toBeVisible();
    expect(
      fixture.mutations.filter((request) => request.path === "/api/files/copy"),
    ).toHaveLength(1);
  } finally {
    release();
  }
});
