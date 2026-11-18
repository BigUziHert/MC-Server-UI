import {
  createProcessServer,
  selectServer,
  removeTestServer,
} from "./server-fixtures";
import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

type FileFixture = { id: string; folder: string; otherServerId: string };
const test = base.extend<{ files: FileFixture }>({
  files: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    const occupied = new Set(
      fleet.servers.map((server: { port: number }) => server.port),
    );
    let port = 29100;
    while (occupied.has(port)) port++;
    const created = await createProcessServer(request, {
      data: {
        name: "Bulk file deletion fixture",
        mode: "live",
        port,
        memoryLimitMB: 1024,
      },
    });
    expect(created.status()).toBe(201);
    const { server } = await created.json();
    const folder = "bulk-files";
    const create = async (
      directory: string,
      name: string,
      type: "file" | "directory",
      content = "Fixture contents\n",
    ) => {
      const response = await request.post("/api/files", {
        headers: { "X-Server-Id": server.id },
        data: { path: directory, name, type, content },
      });
      expect(response.ok()).toBe(true);
    };
    try {
      await create("", folder, "directory");
      for (const name of ["alpha.txt", "alpha-two.txt", "beta.txt"])
        await create(folder, name, "file");
      await create(folder, "archive", "directory");
      await create(`${folder}/archive`, "nested", "directory");
      await create(`${folder}/archive/nested`, "keep.txt", "file");
      await use({
        id: server.id,
        folder,
        otherServerId: fleet.defaultServerId,
      });
    } finally {
      // This ID belongs to the demo created by this fixture in the isolated E2E runtime.
      await removeTestServer(request, server.id);
    }
  },
});

async function openFiles(page: Page, fixture: FileFixture) {
  await page.goto("/#files");
  await selectServer(page, fixture.id);
  await expect(
    page.getByRole("heading", { name: "File Manager", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: fixture.folder, exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Select alpha.txt", exact: true }),
  ).toBeVisible();
}

async function fileNames(request: APIRequestContext, fixture: FileFixture) {
  const response = await request.get(
    `/api/files?path=${encodeURIComponent(fixture.folder)}`,
    { headers: { "X-Server-Id": fixture.id } },
  );
  expect(response.status()).toBe(200);
  const result = await response.json();
  return result.entries.map((entry: { name: string }) => entry.name).sort();
}

test("renaming a file preserves its bytes and lets you retry when a name is taken", async ({
  page,
  files,
  request,
}) => {
  const headers = { "X-Server-Id": files.id };
  const original = "client.jar";
  const renamed = "client.jar.disabled";
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x80]);
  const uploaded = await request.post(
    `/api/files/upload?path=${files.folder}`,
    {
      headers,
      multipart: {
        files: {
          name: original,
          mimeType: "application/octet-stream",
          buffer: bytes,
        },
      },
    },
  );
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  await openFiles(page, files);
  await page
    .getByRole("checkbox", { name: `Select ${original}`, exact: true })
    .check();
  const dialog = page.getByRole("dialog", { name: "Rename file", exact: true });
  const name = dialog.getByRole("textbox", { name: "File name", exact: true });
  await page.keyboard.press("F2");
  await expect(name).toBeFocused();
  expect(
    await name.evaluate((element: HTMLInputElement) =>
      element.value.slice(element.selectionStart!, element.selectionEnd!),
    ),
  ).toBe("client");
  await page.keyboard.press("Escape");
  const source = page.getByRole("button", { name: original, exact: true });
  await source.click({ button: "right" });
  await page
    .getByRole("menu", { name: "File actions" })
    .getByRole("menuitem", { name: "Rename", exact: true })
    .click();
  await expect(name).toHaveValue(original);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const renameAction = page.getByRole("button", {
    name: `Rename ${original}`,
    exact: true,
  });
  await renameAction.click();
  await expect(name).toHaveValue(original);
  await name.fill("alpha.txt");
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(dialog).toContainText(/already exists|already in use/i);
  await name.fill(renamed);
  await name.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(renameAction).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: renamed, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: `Select ${renamed}`, exact: true }),
  ).toBeChecked();
  expect(await fileNames(request, files)).toEqual([
    "alpha-two.txt",
    "alpha.txt",
    "archive",
    "beta.txt",
    renamed,
  ]);
  for (const [filename, expected] of [
    [renamed, bytes],
    ["alpha.txt", Buffer.from("Fixture contents\n")],
  ] as const) {
    const response = await request.get(
      `/api/files/download?path=${files.folder}/${filename}`,
      { headers },
    );
    expect(response.status()).toBe(200);
    expect(await response.body()).toEqual(expected);
  }
});

test("F2 renames a folder with its contents and keeps the existing folder on a name conflict", async ({
  page,
  files,
  request,
}) => {
  const headers = { "X-Server-Id": files.id };
  const original = "client.mods";
  const renamed = "client-mods";
  const created = await request.post("/api/files", {
    headers,
    data: { path: files.folder, name: original, type: "directory" },
  });
  expect(created.status()).toBe(201);
  const child = await request.post("/api/files", {
    headers,
    data: {
      path: `${files.folder}/${original}`,
      name: "notes.txt",
      type: "file",
      content: "Client pack",
    },
  });
  expect(child.status()).toBe(201);
  await openFiles(page, files);
  await expect(
    page.getByRole("button", { name: `Rename ${original}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: `Select ${original}`, exact: true })
    .check();
  await page.keyboard.press("F2");
  const dialog = page.getByRole("dialog", {
    name: "Rename folder",
    exact: true,
  });
  const name = dialog.getByRole("textbox", {
    name: "Folder name",
    exact: true,
  });
  await expect(name).toBeFocused();
  expect(
    await name.evaluate((input: HTMLInputElement) =>
      input.value.slice(input.selectionStart!, input.selectionEnd!),
    ),
  ).toBe(original);
  await name.fill("archive");
  await name.press("Enter");
  await expect(dialog).toContainText(/already exists|already in use/i);
  await name.fill(renamed);
  await name.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: original, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: `Select ${renamed}`, exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: renamed, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "notes.txt", exact: true }),
  ).toBeVisible();
  for (const [path, content] of [
    [`${renamed}/notes.txt`, "Client pack"],
    ["archive/nested/keep.txt", "Fixture contents\n"],
  ]) {
    const response = await request.get(
      `/api/files/content?path=${files.folder}/${path}`,
      { headers },
    );
    expect(response.status()).toBe(200);
    expect((await response.json()).content).toBe(content);
  }
});

test("a host supporting only file renames offers Rename on files only", async ({
  page,
  files,
}) => {
  await page.route("**/api/files?**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.supportsFolderRename;
    await route.fulfill({ response, json: body });
  });
  await openFiles(page, files);
  await expect(
    page.getByRole("button", { name: "Rename beta.txt", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Rename archive", exact: true }),
  ).toHaveCount(0);
});

test("file context menu and shortcuts copy, select all, and confirm deletion without intercepting text", async ({
  page,
  files,
  request,
}) => {
  await openFiles(page, files);
  const beta = page.getByRole("button", { name: "beta.txt", exact: true });
  await beta.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "File actions" });
  await expect(menu).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select beta.txt", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  await beta.click({ button: "right" });
  await menu.getByRole("menuitem", { name: /Copy/ }).click();
  await page.getByRole("button", { name: "archive", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Select nested", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+v");
  await expect(
    page.getByRole("status", { name: "File transfer progress" }),
  ).toContainText(`copied to /${files.folder}/archive.`);
  const response = await request.get(
    `/api/files/content?path=${files.folder}/archive/beta.txt`,
    { headers: { "X-Server-Id": files.id } },
  );
  expect((await response.json()).content).toBe("Fixture contents\n");
  await expect(
    page.getByRole("button", { name: "beta.txt", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+v");
  await expect(
    page.getByRole("status", { name: "File transfer progress" }),
  ).toContainText("Skipped 1 identical file.");
  await page.keyboard.press("Backspace");
  await expect(beta).toBeVisible();
  await page.keyboard.press("Control+a");
  await expect(
    page.getByRole("region", { name: "Selected files and folders" }),
  ).toContainText("4 selected");
  await page.keyboard.press("Delete");
  const dialog = page.getByRole("dialog", {
    name: "Move selected items to Recycle Bin?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await fileNames(request, files)).toContain("beta.txt");
  const search = page.getByRole("textbox", {
    name: "Search files and folders",
    exact: true,
  });
  await search.fill("beta");
  await search.press("Control+a");
  await expect(
    page.getByRole("region", { name: "Selected files and folders" }),
  ).toHaveCount(0);
  await expect(search).toHaveValue("beta");
});

test("pasting browser clipboard files uploads into the current folder and leaves text fields alone", async ({
  page,
  files,
  request,
}) => {
  await openFiles(page, files);
  await page.locator("body").evaluate((body) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(
      new File(["Copied on this PC"], "clipboard.txt", { type: "text/plain" }),
    );
    body.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  await expect(
    page.getByRole("status", { name: "File transfer progress" }),
  ).toContainText("Transfer complete");
  const response = await request.get(
    `/api/files/content?path=${files.folder}/clipboard.txt`,
    { headers: { "X-Server-Id": files.id } },
  );
  expect((await response.json()).content).toBe("Copied on this PC");
  const search = page.getByRole("textbox", {
    name: "Search files and folders",
    exact: true,
  });
  await search.evaluate((input) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(
      new File(["Do not upload from an editor"], "not-uploaded.txt"),
    );
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  expect(await fileNames(request, files)).not.toContain("not-uploaded.txt");
});

test("Ctrl+V reads copied desktop folders and files and newer server copies take precedence", async ({
  page,
  files,
  request,
}) => {
  await page.addInitScript(() => {
    let internal = false;
    window.mcPanelClipboard = {
      readFiles: async () =>
        internal
          ? null
          : {
              id: "selection",
              files: [
                {
                  id: "file",
                  path: "desktop-folder/copied.txt",
                  name: "copied.txt",
                  size: 12,
                  lastModified: 1234567890000,
                },
              ],
              directories: ["desktop-folder", "desktop-folder/empty"],
            },
      readFile: async () => new TextEncoder().encode("desktop data"),
      releaseFiles: async () => {},
      markInternalCopy: async () => {
        internal = true;
      },
    };
  });
  await openFiles(page, files);
  await page.keyboard.press("Control+v");
  await expect(
    page.getByRole("status", { name: "File transfer progress" }),
  ).toContainText("Transfer complete");
  const headers = { "X-Server-Id": files.id };
  const response = await request.get(
    `/api/files/content?path=${files.folder}/desktop-folder/copied.txt`,
    { headers },
  );
  expect((await response.json()).content).toBe("desktop data");
  const empty = await request.get(
    `/api/files?path=${files.folder}/desktop-folder/empty`,
    { headers },
  );
  expect((await empty.json()).entries).toEqual([]);
  await page
    .getByRole("checkbox", { name: "Select beta.txt", exact: true })
    .check();
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "archive", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Select nested", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+v");
  await expect(
    page.getByRole("status", { name: "File transfer progress" }),
  ).toContainText(`copied to /${files.folder}/archive.`);
  const listing = await request.get(`/api/files?path=${files.folder}/archive`, {
    headers,
  });
  const names = (await listing.json()).entries.map(
    (entry: { name: string }) => entry.name,
  );
  expect(names).toContain("beta.txt");
  expect(names).not.toContain("desktop-folder");
});

test("pasting 43 desktop JARs into AutoModpack skips the two already dropped there", async ({
  page,
  files,
  request,
}) => {
  const folder = "automodpack/host-modpack/main/mods";
  const headers = { "X-Server-Id": files.id };
  let parent = "";
  for (const name of folder.split("/")) {
    const created = await request.post("/api/files", {
      headers,
      data: { path: parent, name, type: "directory" },
    });
    expect(created.ok(), await created.text()).toBe(true);
    parent = [parent, name].filter(Boolean).join("/");
  }
  const jars = Array.from({ length: 43 }, (_, index) => ({
    name: `client-${String(index + 1).padStart(2, "0")}.jar`,
    bytes: [0x50, 0x4b, 0, index, 0xff],
  }));
  await page.addInitScript((copied) => {
    window.mcPanelClipboard = {
      readFiles: async () => ({
        id: "desktop-selection",
        files: copied.map((jar, index) => ({
          id: String(index),
          name: jar.name,
          path: jar.name,
          size: jar.bytes.length,
          lastModified: 1672531200000,
        })),
        directories: [],
      }),
      readFile: async (_, id, offset) =>
        Uint8Array.from(copied[Number(id)].bytes.slice(offset)),
      releaseFiles: async () => {},
      markInternalCopy: async () => {},
    };
  }, jars);
  await page.goto("/#files");
  await selectServer(page, files.id);
  for (const name of folder.split("/"))
    await page.getByRole("button", { name, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Paste", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("region", { name: "Server files", exact: true })
    .evaluate(
      (element, firstTwo) => {
        const dataTransfer = new DataTransfer();
        for (const jar of firstTwo)
          dataTransfer.items.add(
            new File([Uint8Array.from(jar.bytes)], jar.name),
          );
        element.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }),
        );
      },
      jars.slice(0, 2),
    );
  const progress = page.getByRole("status", { name: "File transfer progress" });
  await expect(progress).toContainText("2 files uploaded");
  await expect(
    page.getByRole("checkbox", { name: `Select ${jars[0].name}`, exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+v");
  await expect(progress).toContainText("41 files uploaded");
  await expect(progress).toContainText("Skipped 2 identical files");
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await expect(progress).toContainText("Skipped 43 identical files");
  await expect(progress).toContainText("Transfer complete");
  expect(await fileNames(request, { ...files, folder })).toEqual(
    jars.map((jar) => jar.name),
  );
  for (const jar of jars) {
    const response = await request.get(
      `/api/files/download?path=${folder}/${jar.name}`,
      { headers },
    );
    expect(response.ok()).toBe(true);
    expect(await response.body()).toEqual(Buffer.from(jar.bytes));
  }
});

test("cut and paste moves selected server files and consumes the cut selection", async ({
  page,
  files,
  request,
}) => {
  await openFiles(page, files);
  await page
    .getByRole("checkbox", { name: "Select beta.txt", exact: true })
    .check();
  await page.keyboard.press("Control+x");
  await expect(
    page.getByRole("status", { name: "Copied files" }),
  ).toContainText("cut from");
  await page.getByRole("button", { name: "archive", exact: true }).click();
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "File transfer progress" }),
  ).toContainText("moved to");
  await expect(page.getByRole("status", { name: "Copied files" })).toHaveCount(
    0,
  );
  expect(await fileNames(request, files)).not.toContain("beta.txt");
  const response = await request.get(
    `/api/files/content?path=${files.folder}/archive/beta.txt`,
    { headers: { "X-Server-Id": files.id } },
  );
  expect((await response.json()).content).toBe("Fixture contents\n");
});

test("Ctrl+S saves edited text without opening the browser save dialog", async ({
  page,
  files,
  request,
}) => {
  await openFiles(page, files);
  await page.getByRole("button", { name: "beta.txt", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "File contents",
    exact: true,
  });
  await editor.fill("Saved with Ctrl+S");
  await editor.press("Control+s");
  await expect(
    page.getByRole("dialog", { name: "beta.txt", exact: true }),
  ).not.toBeVisible();
  const response = await request.get(
    `/api/files/content?path=${files.folder}/beta.txt`,
    { headers: { "X-Server-Id": files.id } },
  );
  expect((await response.json()).content).toBe("Saved with Ctrl+S");
});

test("Cut refuses an older server without move support instead of silently copying files", async ({
  page,
  files,
}) => {
  await page.route("**/api/files?**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.supportsFileMoves;
    await route.fulfill({ response, json: body });
  });
  await openFiles(page, files);
  await page
    .getByRole("checkbox", { name: "Select beta.txt", exact: true })
    .check();
  await page.keyboard.press("Control+x");
  await expect(
    page.getByText(
      "Update MC Panel on the server computer to use Cut and Paste.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("status", { name: "Copied files" })).toHaveCount(
    0,
  );
});

test("file dialogs keep native modal focus and restore search when the deleted trigger disappears", async ({
  page,
  files,
}) => {
  await openFiles(page, files);
  const create = page.getByRole("button", { name: "New file", exact: true });
  await create.click();
  let dialog = page.getByRole("dialog", { name: "New file", exact: true });
  await expect
    .poll(() => dialog.evaluate((element) => element.matches("dialog:modal")))
    .toBe(true);
  await expect(
    dialog.getByRole("textbox", { name: "File name", exact: true }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(create).toBeFocused();

  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/files?**", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await pending;
    await route.fulfill({ response: await route.fetch() });
  });
  await page
    .getByRole("button", { name: "Delete beta.txt", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Move this item to Recycle Bin?",
    exact: true,
  });
  await expect
    .poll(() => dialog.evaluate((element) => element.matches("dialog:modal")))
    .toBe(true);
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  release!();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete beta.txt", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", {
      name: "Search files and folders",
      exact: true,
    }),
  ).toBeFocused();
});

test("selected file and folder deletion confirms exact targets and preserves unselected items", async ({
  page,
  request,
  files,
}, testInfo) => {
  await openFiles(page, files);
  const headerBefore = await page
    .getByRole("checkbox", {
      name: "Select all visible files and folders",
      exact: true,
    })
    .boundingBox();
  const deletes: { path: string; serverId: string | undefined }[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "DELETE" &&
      new URL(request.url()).pathname === "/api/files"
    )
      deletes.push({
        path: new URL(request.url()).searchParams.get("path")!,
        serverId: request.headers()["x-server-id"],
      });
  });
  await page
    .getByRole("checkbox", { name: "Select alpha.txt", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Select archive", exact: true })
    .check();
  const all = page.getByRole("checkbox", {
    name: "Select all visible files and folders",
    exact: true,
  });
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  expect(await all.boundingBox()).toEqual(headerBefore);
  expect(
    await all.evaluate(
      (element) => (element as HTMLInputElement).indeterminate,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("region", { name: "Selected files and folders" }),
  ).toContainText("2 selected");
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Move selected items to Recycle Bin?",
    exact: true,
  });
  const targets = dialog.getByRole("list", {
    name: "Items to recycle",
    exact: true,
  });
  await expect(targets.getByRole("listitem")).toHaveCount(2);
  await expect(targets).toContainText(`/${files.folder}/alpha.txt`);
  await expect(targets).toContainText(`/${files.folder}/archive`);
  await expect(targets).not.toContainText("beta.txt");
  await expect(dialog).toContainText("including nested files and folders");
  await page.screenshot({
    path: testInfo.outputPath("file-selection-confirmation.png"),
    animations: "disabled",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(deletes).toEqual([]);
  expect(await fileNames(request, files)).toEqual([
    "alpha-two.txt",
    "alpha.txt",
    "archive",
    "beta.txt",
  ]);
  await expect(
    page.getByRole("checkbox", { name: "Select archive", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Move selected items to Recycle Bin?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(await fileNames(request, files)).toEqual([
    "alpha-two.txt",
    "beta.txt",
  ]);
  expect(deletes.map((item) => item.path).sort()).toEqual([
    `${files.folder}/alpha.txt`,
    `${files.folder}/archive`,
  ]);
  expect(deletes.every((item) => item.serverId === files.id)).toBe(true);
  const nested = await request.get(
    `/api/files/content?path=${encodeURIComponent(`${files.folder}/archive/nested/keep.txt`)}`,
    { headers: { "X-Server-Id": files.id } },
  );
  expect(nested.status()).toBe(404);
  const recycled = await (
    await request.get("/api/files/recycle-bin", {
      headers: { "X-Server-Id": files.id },
    })
  ).json();
  expect(
    recycled.items
      .map((item: { originalPath: string }) => item.originalPath)
      .sort(),
  ).toEqual([`${files.folder}/alpha.txt`, `${files.folder}/archive`]);
  await expect(
    page.getByRole("region", { name: "Selected files and folders" }),
  ).toHaveCount(0);
});

test("select visible all respects search and selection clears on query, directory and server changes", async ({
  page,
  files,
}, testInfo) => {
  await openFiles(page, files);
  const search = page.getByRole("textbox", {
    name: "Search files and folders",
    exact: true,
  });
  const all = page.getByRole("checkbox", {
    name: "Select all visible files and folders",
    exact: true,
  });
  const selection = page.getByRole("region", {
    name: "Selected files and folders",
  });
  const searchField = search.locator("xpath=../..");
  const unfocusedBorder = await searchField.evaluate(
    (element) => getComputedStyle(element).borderColor,
  );
  const unfocusedInputBorder = await search.evaluate(
    (element) => getComputedStyle(element).borderColor,
  );
  await search.fill("alpha");
  await expect(
    page.getByRole("checkbox", { name: "Select beta.txt", exact: true }),
  ).toHaveCount(0);
  await all.check();
  await expect(selection).toContainText("2 selected");
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(search).toHaveCSS("outline-style", "none");
  await expect(search).toHaveCSS("box-shadow", "none");
  await expect(search).toHaveCSS("border-color", unfocusedInputBorder);
  await expect(searchField).toHaveCSS("border-color", unfocusedBorder);
  await expect(searchField).toHaveCSS("box-shadow", "none");
  await expect(searchField).toHaveCSS("outline-style", "solid");
  await expect(searchField).toHaveCSS("outline-width", "2px");
  await expect(selection).toHaveCount(0);
  await expect(all).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select beta.txt", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "Select beta.txt", exact: true })
    .check();
  await search.fill("alpha.txt");
  await expect(selection).toHaveCount(0);
  await all.check();
  await expect(selection).toContainText("1 selected");
  await search.clear();
  await expect(selection).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "Select alpha.txt", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select alpha-two.txt", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select beta.txt", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select archive", exact: true }),
  ).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await search.fill("alpha");
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("file-selection-mobile.png"),
    animations: "disabled",
    fullPage: true,
  });
  await expect(selection).toHaveCount(0);
  // Focusing a lower row can scroll the smaller viewport. Compare document
  // coordinates so this checks layout movement, not the browser's focus scroll.
  const mobileHeaderPosition = () =>
    all.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x: x + window.scrollX, y: y + window.scrollY, width, height };
    });
  const mobileHeaderBefore = await mobileHeaderPosition();
  await page
    .getByRole("checkbox", { name: "Select beta.txt", exact: true })
    .check();
  expect(await mobileHeaderPosition()).toEqual(mobileHeaderBefore);
  await page.getByRole("button", { name: "archive", exact: true }).click();
  await expect(selection).toHaveCount(0);
  await page
    .getByRole("checkbox", { name: "Select nested", exact: true })
    .check();
  await page.getByRole("button", { name: "Server root", exact: true }).click();
  await expect(selection).toHaveCount(0);
  await page
    .getByRole("checkbox", { name: `Select ${files.folder}`, exact: true })
    .check();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await selectServer(page, files.otherServerId);
  await expect(selection).toHaveCount(0);
});

test("partial deletion failures retain only failed targets and retry sequentially", async ({
  page,
  request,
  files,
}) => {
  await openFiles(page, files);
  let deny = true;
  let active = 0;
  let maximumActive = 0;
  const attempted: string[] = [];
  await page.route("**/api/files?**", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const target = new URL(route.request().url()).searchParams.get("path")!;
    expect(route.request().headers()["x-server-id"]).toBe(files.id);
    attempted.push(target);
    active++;
    maximumActive = Math.max(maximumActive, active);
    try {
      // Keep requests in flight long enough to expose accidental concurrent deletes.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (deny && target === `${files.folder}/alpha.txt`)
        await route.fulfill({
          status: 403,
          json: { error: "Fixture permission denied." },
        });
      else await route.fulfill({ response: await route.fetch() });
    } finally {
      active--;
    }
  });
  for (const name of ["alpha.txt", "alpha-two.txt", "beta.txt"])
    await page
      .getByRole("checkbox", { name: `Select ${name}`, exact: true })
      .check();
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Move selected items to Recycle Bin?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "2 items moved to Recycle Bin. 1 item could not be moved and remains selected.",
  );
  await expect(page.getByRole("alert", { name: "Notification" })).toHaveCount(
    0,
  );
  await expect(dialog.getByRole("list", { name: "Move errors" })).toContainText(
    "alpha.txt: Fixture permission denied.",
  );
  await expect(
    dialog
      .getByRole("list", { name: "Items to recycle" })
      .getByRole("listitem"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("checkbox", { name: "Select alpha.txt", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("region", { name: "Selected files and folders" }),
  ).toContainText("1 selected");
  expect(await fileNames(request, files)).toEqual(["alpha.txt", "archive"]);
  expect(maximumActive).toBe(1);
  deny = false;
  await dialog
    .getByRole("button", { name: "Retry failed moves", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("status", { name: "Notification" })).toHaveText(
    "alpha.txt moved to Recycle Bin.",
  );
  expect(await fileNames(request, files)).toEqual(["archive"]);
  expect(
    attempted.filter((target) => target === `${files.folder}/alpha.txt`),
  ).toHaveLength(2);
  expect(attempted).toHaveLength(4);
  expect(maximumActive).toBe(1);
});

test("a failed background move reports its result while another file dialog is open", async ({
  page,
  files,
}) => {
  await openFiles(page, files);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/files?**", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await pending;
    await route.fulfill({
      status: 403,
      json: { error: "Fixture permission denied." },
    });
  });
  await page
    .getByRole("button", { name: "Delete beta.txt", exact: true })
    .click();
  const origin = page.getByRole("dialog", {
    name: "Move this item to Recycle Bin?",
  });
  await origin
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await origin.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "New file", exact: true }).click();
  const current = page.getByRole("dialog", { name: "New file", exact: true });
  await expect(current).toBeVisible();
  release();
  await expect(
    current.getByRole("alert", { name: "Notification" }),
  ).toContainText("1 item could not be moved");
  await expect(
    current.getByRole("textbox", { name: "File name" }),
  ).toBeVisible();
});
