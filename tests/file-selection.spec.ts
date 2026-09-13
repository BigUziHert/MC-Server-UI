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
    const created = await request.post("/api/servers", {
      data: {
        name: "Bulk file deletion fixture",
        mode: "demo",
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
      const response = await request.delete(
        `/api/servers/${encodeURIComponent(server.id)}`,
      );
      expect(response.ok()).toBe(true);
    }
  },
});

async function openFiles(page: Page, fixture: FileFixture) {
  await page.goto("/#files");
  await page
    .getByRole("combobox", { name: "Switch server", exact: true })
    .selectOption(fixture.id);
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

test("select visible all respects filters and selection clears on directory and server changes", async ({
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
  await search.fill("alpha");
  await all.check();
  await expect(selection).toContainText("2 selected");
  await search.clear();
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  await expect(
    page.getByRole("checkbox", { name: "Select beta.txt", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "Select beta.txt", exact: true })
    .check();
  await search.fill("alpha.txt");
  await expect(selection).toContainText("3 selected");
  await expect(selection).toContainText("2 hidden by the filter");
  await all.uncheck();
  await search.clear();
  await expect(
    page.getByRole("checkbox", { name: "Select alpha.txt", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select alpha-two.txt", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select beta.txt", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select archive", exact: true }),
  ).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
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
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await expect(selection).toHaveCount(0);
  const mobileHeaderBefore = await all.boundingBox();
  await page
    .getByRole("checkbox", { name: "Select beta.txt", exact: true })
    .check();
  expect(await all.boundingBox()).toEqual(mobileHeaderBefore);
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
  await page
    .getByRole("combobox", { name: "Switch server", exact: true })
    .selectOption(files.otherServerId);
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
  expect(await fileNames(request, files)).toEqual(["archive"]);
  expect(
    attempted.filter((target) => target === `${files.folder}/alpha.txt`),
  ).toHaveLength(2);
  expect(attempted).toHaveLength(4);
  expect(maximumActive).toBe(1);
});
