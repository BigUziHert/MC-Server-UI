import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  createProcessServer,
  removeTestServer,
  selectServer,
} from "./server-fixtures";

type Fixture = { id: string; other: string };
async function create(
  request: APIRequestContext,
  id: string,
  path: string,
  name: string,
  type: "file" | "directory",
  content = "fixture\n",
) {
  const response = await request.post("/api/files", {
    headers: { "X-Server-Id": id },
    data: { path, name, type, content },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
async function contents(request: APIRequestContext, id: string, path: string) {
  return request.get(`/api/files/content?path=${encodeURIComponent(path)}`, {
    headers: { "X-Server-Id": id },
  });
}
const formats = {
  "plain.json": '{"enabled":true}\n',
  "upper.JSON": '{"enabled":false}\n',
  "settings.json5": "// JSON5 comment\n{enabled: true,}\n",
  "settings.jsonc": '// JSONC comment\n{"enabled": true}\n',
};
const test = base.extend<{ files: Fixture }>({
  files: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    const occupied = new Set(
      fleet.servers.map((item: { port: number }) => item.port),
    );
    let port = 29710;
    while (occupied.has(port)) port++;
    const created = await createProcessServer(request, {
      data: {
        name: "Recursive search fixture",
        port,
        mode: "live",
        memoryLimitMB: 1024,
      },
    });
    const { server } = await created.json();
    try {
      for (const name of ["mods", "config", "destination"])
        await create(request, server.id, "", name, "directory");
      await create(request, server.id, "config", "deep", "directory");
      await create(request, server.id, "config", "test-folder", "directory");
      await create(
        request,
        server.id,
        "mods",
        "test.json",
        "file",
        '{"source":"mods"}\n',
      );
      await create(
        request,
        server.id,
        "config/deep",
        "test.json",
        "file",
        '{"source":"config"}\n',
      );
      await create(
        request,
        server.id,
        "config/test-folder",
        "test-child.txt",
        "file",
        "Nested child\n",
      );
      await create(
        request,
        server.id,
        "config/test-folder",
        "keep.txt",
        "file",
        "Unmatched basename\n",
      );
      for (const [name, content] of Object.entries(formats))
        await create(request, server.id, "config", name, "file", content);
      await use({ id: server.id, other: fleet.defaultServerId });
    } finally {
      await removeTestServer(request, server.id);
    }
  },
});
const search = (page: Page) =>
  page.getByRole("textbox", { name: "Search files and folders", exact: true });
const selection = (page: Page) =>
  page.getByRole("region", { name: "Selected files and folders" });
async function openFiles(page: Page, id: string) {
  await page.goto("/#files");
  await selectServer(page, id);
  await expect(
    page.getByRole("button", { name: "mods", exact: true }),
  ).toBeVisible();
}

test("root search shows nested duplicate paths and edits, downloads, copies and deletes the chosen file", async ({
  page,
  request,
  files,
}, testInfo) => {
  await openFiles(page, files.id);
  await search(page).fill("TeSt");
  const mods = "mods/test.json",
    config = "config/deep/test.json";
  await expect(
    page.getByRole("button", { name: mods, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: config, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".file-search-path")).toHaveCount(4);
  await expect(page.locator(".file-search-path")).toContainText([
    "/config/test-folder",
    "/config/test-folder/test-child.txt",
    `/${config}`,
    `/${mods}`,
  ]);
  await expect(
    page.getByRole("button", { name: /keep.txt/, exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: `Edit ${mods}`, exact: true }).click();
  const editor = page.getByRole("dialog", { name: "test.json", exact: true });
  await expect(editor).toContainText(`/${mods}`);
  await expect(
    editor.getByRole("textbox", { name: "File contents" }),
  ).toHaveValue('{"source":"mods"}\n');
  const saved = '{"source":"edited mods"}\n';
  await editor.getByRole("textbox", { name: "File contents" }).fill(saved);
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  expect(
    (await (await contents(request, files.id, config)).json()).content,
  ).toBe('{"source":"config"}\n');
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: `Download ${mods}`, exact: true })
    .click();
  const download = await downloadEvent;
  expect(await download.failure()).toBeNull();
  expect(await readFile((await download.path())!, "utf8")).toBe(saved);
  await page
    .getByRole("checkbox", { name: `Select ${mods}`, exact: true })
    .check();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(selection(page)).toHaveCount(0);
  await page.getByRole("button", { name: "destination", exact: true }).click();
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await expect
    .poll(async () =>
      (await contents(request, files.id, "destination/test.json")).status(),
    )
    .toBe(200);
  expect(
    (await (await contents(request, files.id, "destination/test.json")).json())
      .content,
  ).toBe(saved);
  await page.getByRole("button", { name: "Server root", exact: true }).click();
  await search(page).fill("test");
  await page
    .getByRole("button", { name: `Delete ${config}`, exact: true })
    .click();
  const confirm = page.getByRole("dialog", {
    name: "Move this item to Recycle Bin?",
    exact: true,
  });
  await expect(confirm).toContainText(`/${config}`);
  await confirm
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(confirm).not.toBeVisible();
  expect((await contents(request, files.id, config)).status()).toBe(404);
  expect((await (await contents(request, files.id, mods)).json()).content).toBe(
    saved,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: mods, exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("nested-search-mobile.png"),
    fullPage: true,
  });
});

test("search stays under the current folder, paginates every match and clears on query, folder and server changes", async ({
  page,
  request,
  files,
}) => {
  for (let index = 0; index < 34; index++)
    await create(
      request,
      files.id,
      "config/deep",
      `match-${String(index).padStart(2, "0")}.txt`,
      "file",
    );
  await openFiles(page, files.id);
  await page.getByRole("button", { name: "config", exact: true }).click();
  await search(page).fill("test");
  await expect(
    page.getByRole("button", { name: "config/deep/test.json", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "mods/test.json", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "config/test-folder", exact: true })
    .click();
  await expect(search(page)).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "keep.txt", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Server root", exact: true }).click();
  await search(page).fill("match-");
  await expect(page.getByLabel("files pagination")).toContainText(
    "1–25 of 34 files",
  );
  await page
    .getByRole("checkbox", { name: "Select all visible files and folders" })
    .check();
  await page
    .getByRole("button", { name: "Next files page", exact: true })
    .click();
  await expect(page.getByLabel("files pagination")).toContainText(
    "26–34 of 34 files",
  );
  await expect(
    page.getByRole("button", { name: "config/deep/match-33.txt", exact: true }),
  ).toBeVisible();
  await expect(selection(page)).toContainText("25 outside this page");
  await search(page).fill("test.json");
  await expect(selection(page)).toHaveCount(0);
  await page
    .getByRole("checkbox", { name: "Select mods/test.json", exact: true })
    .check();
  await selectServer(page, files.other);
  await expect(search(page)).toHaveValue("");
  await expect(selection(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "mods/test.json", exact: true }),
  ).toHaveCount(0);
});

test("JSON, uppercase JSON, JSON5 and JSONC expose editors and preserve raw contents and revisions", async ({
  page,
  request,
  files,
}, testInfo) => {
  await openFiles(page, files.id);
  await page.getByRole("button", { name: "config", exact: true }).click();
  for (const [name, original] of Object.entries(formats)) {
    const path = `config/${name}`;
    const before = await (await contents(request, files.id, path)).json();
    await page
      .getByRole("button", { name: `Edit ${name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name, exact: true });
    const editor = dialog.getByRole("textbox", { name: "File contents" });
    await expect(editor).toHaveValue(original);
    if (/\.json[5c]$/i.test(name))
      await page.screenshot({
        path: testInfo.outputPath(`${name}-editor.png`),
        fullPage: true,
      });
    const replacement = original.replace(/true|false/, '"changed"');
    await editor.fill(replacement);
    const write = page.waitForRequest(
      (request) =>
        request.method() === "PUT" &&
        new URL(request.url()).pathname === "/api/files/content",
    );
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    const submitted = (await write).postDataJSON();
    expect(submitted).toMatchObject({
      path,
      content: replacement,
      revision: before.revision,
    });
    await expect(dialog).not.toBeVisible();
    const after = await (await contents(request, files.id, path)).json();
    expect(after.content).toBe(replacement);
    expect(after.revision).not.toBe(before.revision);
  }
});

test("search waits for every continuation and discards late queries, partial failures and old-host results", async ({
  page,
  files,
}) => {
  await openFiles(page, files.id);
  const entry = (path: string) => ({
    name: path.split("/").pop(),
    path,
    type: "file",
    size: 7,
    modified: "2026-09-28T12:00:00Z",
  });
  let release: (() => void) | undefined;
  let pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  await page.route("**/api/files?**", async (route) => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get("search");
    if (!query || route.request().method() !== "GET") return route.continue();
    const cursor = url.searchParams.get("cursor");
    calls.push(`${query}:${cursor || "first"}`);
    if (query === "old")
      return route.fulfill({
        json: { path: "", entries: [entry("old-partial.txt")] },
      });
    if (query === "fail" && cursor)
      return route.fulfill({
        status: 500,
        json: { error: "Search scan failed" },
      });
    if (query === "fail")
      return route.fulfill({
        json: {
          path: "",
          search: query,
          entries: [entry("fail-partial.txt")],
          nextCursor: "failed-page",
        },
      });
    if (query === "slow") {
      await pending;
      return route
        .fulfill({
          json: {
            path: "",
            search: query,
            entries: [entry("slow-stale.txt")],
            nextCursor: null,
          },
        })
        .catch(() => {});
    }
    if (query === "pages" && !cursor)
      return route.fulfill({
        json: {
          path: "",
          search: query,
          entries: [entry("deep/pages-first.txt")],
          nextCursor: "empty-page",
        },
      });
    if (cursor === "empty-page")
      return route.fulfill({
        json: { path: "", search: query, entries: [], nextCursor: "last-page" },
      });
    if (cursor === "last-page") await pending;
    return route.fulfill({
      json: {
        path: "",
        search: query,
        entries: [entry(`deep/${query}-last.txt`)],
        nextCursor: null,
      },
    });
  });
  await search(page).fill("pages");
  await expect.poll(() => calls).toContain("pages:last-page");
  await expect(
    page.getByRole("button", { name: "deep/pages-first.txt", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("1 matches found. Checking remaining folders…", {
      exact: true,
    }),
  ).toBeVisible();
  release!();
  await expect(page.locator(".file-search-path")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "deep/pages-last.txt", exact: true }),
  ).toBeVisible();
  pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await search(page).fill("slow");
  await expect.poll(() => calls).toContain("slow:first");
  await search(page).fill("fast");
  await expect(
    page.getByRole("button", { name: "deep/fast-last.txt", exact: true }),
  ).toBeVisible();
  release!();
  await page
    .getByRole("button", { name: "Refresh files", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "deep/fast-last.txt", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "slow-stale.txt", exact: true }),
  ).toHaveCount(0);
  await search(page).fill("fast ");
  await expect(
    page.getByRole("button", { name: "deep/fast-last.txt", exact: true }),
  ).toBeVisible();
  await search(page).fill("fail");
  await expect(
    page.getByText("Search scan failed", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".file-search-path")).toHaveCount(0);
  await search(page).fill("old");
  await expect(
    page.getByText(/Update the panel on the server computer/),
  ).toBeVisible();
  await expect(page.locator(".file-search-path")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "mods", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "config", exact: true }).click();
  pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await search(page).fill("slow");
  await expect
    .poll(() => calls.filter((call) => call === "slow:first").length)
    .toBe(2);
  await page.getByRole("button", { name: "Server root", exact: true }).click();
  await expect(search(page)).toHaveValue("");
  release!();
  await expect(
    page.getByRole("button", { name: "mods", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "slow-stale.txt", exact: true }),
  ).toHaveCount(0);
});

test("JSON5 and JSONC search results preserve browse-only and read-only permissions", async ({
  page,
  request,
  files,
}) => {
  const seed = await (
    await request.get("/api/server", { headers: { "X-Server-Id": files.id } })
  ).json();
  let permissions = ["server.view", "file.read"];
  const writes: string[] = [];
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("mc-panel.session.v1", "p".repeat(43));
  });
  await page.route("**/api/access/session", (route) =>
    route.fulfill({
      json: {
        role: "subuser",
        accountId: "reader",
        userId: "reader",
        email: "reader@example.test",
        serverId: files.id,
        permissions,
        hostPermissions: [],
      },
    }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      json: {
        servers: [{ ...seed, accessPermissions: permissions }],
        defaultServerId: files.id,
      },
    }),
  );
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      new URL(request.url()).pathname === "/api/files/content"
    )
      writes.push(request.url());
  });
  for (const canContent of [false, true]) {
    permissions = [
      "server.view",
      "file.read",
      ...(canContent ? ["file.read-content"] : []),
    ];
    await page.goto("/#files");
    const selectFolder = page.getByRole("checkbox", {
      name: "Select config",
      exact: true,
    });
    if (canContent) await expect(selectFolder).toBeEnabled();
    else await expect(selectFolder).toBeDisabled();
    await search(page).fill("settings.json");
    for (const extension of ["json5", "jsonc"]) {
      const path = `config/settings.${extension}`;
      const file = page.getByRole("button", { name: path, exact: true });
      await expect(file).toBeVisible();
      await expect(
        page.getByRole("button", { name: `Edit ${path}`, exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: `Delete ${path}`, exact: true }),
      ).toBeDisabled();
      if (!canContent) {
        await expect(file).toBeDisabled();
        await expect(
          page.getByRole("button", { name: `Download ${path}`, exact: true }),
        ).toHaveCount(0);
      } else {
        await page
          .getByRole("button", { name: `View ${path}`, exact: true })
          .click();
        const dialog = page.getByRole("dialog", {
          name: `settings.${extension}`,
          exact: true,
        });
        await expect(
          dialog.getByRole("textbox", { name: "File contents" }),
        ).toHaveAttribute("readonly", "");
        await expect(
          dialog.getByRole("button", { name: "Save changes", exact: true }),
        ).toBeDisabled();
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
      }
    }
  }
  expect(writes).toEqual([]);
});

test("selecting a matching folder and its matching descendants moves each source only once", async ({
  page,
  request,
  files,
}) => {
  await openFiles(page, files.id);
  const deleted: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "DELETE" && url.pathname === "/api/files")
      deleted.push(url.searchParams.get("path")!);
  });
  await search(page).fill("test");
  await expect(page.locator(".file-search-path")).toHaveCount(4);
  await page
    .getByRole("checkbox", {
      name: "Select all visible files and folders",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Move selected items to Recycle Bin?",
    exact: true,
  });
  await expect(dialog.getByRole("listitem")).toHaveCount(3);
  await expect(dialog).toContainText("including nested files and folders");
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(deleted.sort()).toEqual([
    "config/deep/test.json",
    "config/test-folder",
    "mods/test.json",
  ]);
  expect(
    (await contents(request, files.id, "config/test-folder/keep.txt")).status(),
  ).toBe(404);
  expect(
    (await contents(request, files.id, "config/settings.json5")).status(),
  ).toBe(200);
});
