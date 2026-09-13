import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

type BinFixture = {
  id: string;
  otherServerId: string;
  headers: Record<string, string>;
};
const test = base.extend<{ bin: BinFixture }>({
  bin: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    const occupied = new Set(
      fleet.servers.map((server: { port: number }) => server.port),
    );
    let port = 29400;
    while (occupied.has(port)) port++;
    const response = await request.post("/api/servers", {
      data: {
        name: "Recycle Bin fixture",
        mode: "demo",
        port,
        memoryLimitMB: 1024,
      },
    });
    expect(response.status()).toBe(201);
    const { server } = await response.json();
    const bin = {
      id: server.id,
      otherServerId: fleet.defaultServerId,
      headers: { "X-Server-Id": server.id },
    };
    try {
      await create(request, bin, "", "recovery", "directory");
      await create(request, bin, "recovery", "archive", "directory");
      await create(request, bin, "recovery/archive", "nested", "directory");
      await create(
        request,
        bin,
        "recovery/archive/nested",
        "world.dat",
        "file",
        "Original nested world bytes\n",
      );
      await create(
        request,
        bin,
        "recovery",
        "treasure.txt",
        "file",
        "Original treasure bytes\n",
      );
      await use(bin);
    } finally {
      // Only the fresh demo registered by this fixture in the isolated E2E runtime is removed.
      expect((await request.delete(`/api/servers/${bin.id}`)).ok()).toBe(true);
    }
  },
});

async function create(
  request: APIRequestContext,
  bin: BinFixture,
  path: string,
  name: string,
  type: "file" | "directory",
  content = "",
) {
  const response = await request.post("/api/files", {
    headers: bin.headers,
    data: { path, name, type, content },
  });
  expect(response.ok()).toBe(true);
}
async function recycle(
  request: APIRequestContext,
  bin: BinFixture,
  path: string,
) {
  const response = await request.delete(
    `/api/files?path=${encodeURIComponent(path)}`,
    { headers: bin.headers },
  );
  expect(response.ok()).toBe(true);
  return (await response.json()).recycled;
}
async function openFiles(page: Page, bin: BinFixture) {
  await page.goto("/#files");
  await page
    .getByRole("combobox", { name: "Switch server", exact: true })
    .selectOption(bin.id);
  await expect(
    page.getByRole("heading", { name: "File Manager", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Recycle Bin", exact: true }),
  ).toBeVisible();
}
async function openBin(page: Page) {
  await page
    .getByRole("button", { name: "Open Recycle Bin", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Recycle Bin", exact: true }),
  ).toBeVisible();
}
async function contents(
  request: APIRequestContext,
  bin: BinFixture,
  path: string,
) {
  const response = await request.get(
    `/api/files/content?path=${encodeURIComponent(path)}`,
    { headers: bin.headers },
  );
  expect(response.ok()).toBe(true);
  return (await response.json()).content;
}

test("protected Recycle Bin restores deleted files and complete folders to their original paths", async ({
  page,
  request,
  bin,
}, testInfo) => {
  await openFiles(page, bin);
  const protectedRow = page.getByRole("row", {
    name: "Protected Recycle Bin",
    exact: true,
  });
  await expect(protectedRow.getByRole("checkbox")).toHaveCount(0);
  await expect(protectedRow.getByRole("button")).toHaveCount(1);
  await page
    .getByRole("checkbox", {
      name: "Select all visible files and folders",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Move selected items to Recycle Bin?",
    exact: true,
  });
  await expect(
    dialog.getByRole("list", { name: "Items to recycle" }),
  ).not.toContainText("Recycle Bin");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "recovery", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete treasure.txt", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Move this item to Recycle Bin?",
    exact: true,
  });
  await expect(dialog).toContainText(
    "You can restore these items from Recycle Bin.",
  );
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Delete archive", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Move this item to Recycle Bin?",
    exact: true,
  });
  await expect(dialog).toContainText("everything inside it");
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Server root", exact: true }).click();
  await openBin(page);
  await expect(
    page
      .getByRole("list", { name: "Recycled items", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(2);
  const folder = page.getByRole("listitem", {
    name: "Recycled recovery/archive",
    exact: true,
  });
  await expect(folder).toContainText("Original path /recovery/archive");
  await expect(folder).toContainText("Folder · includes all contents");
  await expect(folder).toContainText("Deleted Just now");
  await expect(folder).toContainText("28 B");
  await page.screenshot({
    path: testInfo.outputPath("recycle-bin-desktop.png"),
    animations: "disabled",
    fullPage: true,
  });
  await page.reload();
  await openBin(page);
  const restoreRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/restore")
    )
      restoreRequests.push(request.headers()["x-server-id"]);
  });
  await page
    .getByRole("button", { name: "Restore archive", exact: true })
    .click();
  await expect(folder).toHaveCount(0);
  expect(
    await contents(request, bin, "recovery/archive/nested/world.dat"),
  ).toBe("Original nested world bytes\n");
  await page
    .getByRole("button", { name: "Restore treasure.txt", exact: true })
    .click();
  await expect(
    page.getByText("Recycle Bin is empty", { exact: true }),
  ).toBeVisible();
  expect(await contents(request, bin, "recovery/treasure.txt")).toBe(
    "Original treasure bytes\n",
  );
  expect(restoreRequests).toEqual([bin.id, bin.id]);
  await page
    .getByRole("button", { name: "Back to files", exact: true })
    .click();
  await page.getByRole("button", { name: "recovery", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "archive", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "treasure.txt", exact: true }),
  ).toBeVisible();
});

test("restore conflicts retain both versions and missing parent folders are recreated safely", async ({
  page,
  request,
  bin,
}) => {
  const original = await recycle(request, bin, "recovery/treasure.txt");
  await create(
    request,
    bin,
    "recovery",
    "treasure.txt",
    "file",
    "New replacement bytes\n",
  );
  await openFiles(page, bin);
  await openBin(page);
  const row = page.getByRole("listitem", {
    name: "Recycled recovery/treasure.txt",
    exact: true,
  });
  await row
    .getByRole("button", { name: "Restore treasure.txt", exact: true })
    .click();
  await expect(row.getByRole("alert")).toContainText(
    /already exists|overwrite/i,
  );
  expect(await contents(request, bin, "recovery/treasure.txt")).toBe(
    "New replacement bytes\n",
  );
  const retained = await (
    await request.get("/api/files/recycle-bin", { headers: bin.headers })
  ).json();
  expect(
    retained.items.some((item: { id: string }) => item.id === original.id),
  ).toBe(true);
  const wrongServer = await request.post(
    `/api/files/recycle-bin/${original.id}/restore`,
    {
      headers: { "X-Server-Id": bin.otherServerId },
      data: {},
    },
  );
  expect(wrongServer.status()).toBe(404);
  await recycle(request, bin, "recovery/treasure.txt");
  await recycle(request, bin, "recovery");
  await row
    .getByRole("button", { name: "Restore treasure.txt", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  expect(await contents(request, bin, "recovery/treasure.txt")).toBe(
    "Original treasure bytes\n",
  );
  const remaining = await (
    await request.get("/api/files/recycle-bin", { headers: bin.headers })
  ).json();
  expect(
    remaining.items.some((item: { id: string }) => item.id === original.id),
  ).toBe(false);
  expect(remaining.items).toHaveLength(2);
  await page
    .getByRole("combobox", { name: "Switch server", exact: true })
    .selectOption(bin.otherServerId);
  await openBin(page);
  await expect(
    page.getByRole("listitem", { name: "Recycled recovery", exact: true }),
  ).toHaveCount(0);
});

test("Recycle Bin handles loading errors and incomplete entries without exposing editing controls on mobile", async ({
  page,
  bin,
}, testInfo) => {
  let fail = true;
  let restoreCalls = 0;
  await page.route("**/api/files/recycle-bin", async (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(bin.id);
    await route.fulfill(
      fail
        ? {
            status: 503,
            json: { error: "Fixture bin is temporarily unavailable." },
          }
        : {
            json: {
              protected: true,
              items: [
                {
                  id: "incomplete-fixture",
                  name: "world-archive-with-a-long-name",
                  originalPath:
                    "very-long-existing-folder-name/world-archive-with-a-long-name",
                  type: "directory",
                  size: 1234,
                  deletedAt: "2026-09-12T12:00:00Z",
                  status: "incomplete",
                  message:
                    "This interrupted move is protected; restore is unavailable.",
                },
              ],
            },
          },
    );
  });
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/restore")
    )
      restoreCalls++;
  });
  await openFiles(page, bin);
  await page.setViewportSize({ width: 390, height: 844 });
  await openBin(page);
  await expect(page.getByRole("alert")).toContainText(
    "Fixture bin is temporarily unavailable.",
  );
  fail = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  const row = page.getByRole("listitem", {
    name: /^Recycled very-long-existing-folder-name/,
  });
  await expect(row).toContainText("This interrupted move is protected");
  await expect(
    row.getByRole("button", {
      name: "Restore world-archive-with-a-long-name",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: /Upload files|New file|New folder|Delete selected/,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /Select/ })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("recycle-bin-mobile.png"),
    animations: "disabled",
    fullPage: true,
  });
  await page
    .getByRole("textbox", { name: "Search recycled items", exact: true })
    .fill("not-in-bin");
  await expect(
    page.getByText("No matching recycled items", { exact: true }),
  ).toBeVisible();
  expect(restoreCalls).toBe(0);
});
