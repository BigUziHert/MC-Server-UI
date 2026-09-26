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
    const response = await createProcessServer(request, {
      data: {
        name: "Recycle Bin fixture",
        mode: "live",
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
      await removeTestServer(request, bin.id);
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
  await selectServer(page, bin.id);
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

test("a slow cross-drive move can close, survive page navigation, and finish without replacing another dialog", async ({
  page,
  request,
  bin,
}, testInfo) => {
  const folderName = `tacz-${"long-folder-name-".repeat(9)}`;
  await create(request, bin, "recovery", folderName, "directory");
  const target = `recovery/${folderName}`;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let operation: any = null;
  let deletes = 0;
  await page.route("**/api/files/recycle-operation*", (route) =>
    route.fulfill({ json: { operation } }),
  );
  await page.route("**/api/files?**", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletes++;
    const url = new URL(route.request().url());
    operation = {
      id: url.searchParams.get("requestId"),
      path: target,
      status: "running",
      phase: "copying",
      crossDrive: true,
      filesProcessed: 2,
      totalFiles: 10,
      bytesProcessed: 1024,
      totalBytes: 4096,
    };
    await held;
    const response = await route.fetch();
    operation = { ...operation, status: "completed", phase: "completed" };
    await route.fulfill({ response });
  });
  try {
    await openFiles(page, bin);
    await page.getByRole("button", { name: "recovery", exact: true }).click();
    await page
      .getByRole("button", { name: `Delete ${folderName}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Move this item to Recycle Bin?",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Move to Recycle Bin", exact: true })
      .click();
    await expect(dialog).toContainText("Moving between drives");
    await expect(dialog).toContainText("2 of 10 files");
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("slow-recycle-modal-desktop.png"),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    const progress = page.getByRole("status", {
      name: "Move to Recycle Bin progress",
      exact: true,
    });
    await expect(progress).toContainText("Copying and checking files");
    await expect(
      page.getByRole("button", { name: `Delete ${folderName}`, exact: true }),
    ).toBeDisabled();
    await page.getByRole("link", { name: "Console", exact: true }).click();
    await page.getByRole("link", { name: "File Manager", exact: true }).click();
    await expect(progress).toContainText("2 of 10 files");
    await page
      .getByRole("button", { name: "Server root", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("slow-recycle-progress-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "New file", exact: true }).click();
    const newDialog = page.getByRole("dialog", {
      name: "New file",
      exact: true,
    });
    await newDialog
      .getByLabel("File name", { exact: true })
      .fill("unrelated.txt");
    release();
    await expect(progress).not.toBeVisible();
    await expect(newDialog).toBeVisible();
    await expect(
      newDialog.getByLabel("File name", { exact: true }),
    ).toHaveValue("unrelated.txt");
    await newDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    expect(deletes).toBe(1);
    const result = await (
      await request.get("/api/files/recycle-bin", { headers: bin.headers })
    ).json();
    expect(
      result.items.some(
        (item: { originalPath: string }) => item.originalPath === target,
      ),
    ).toBe(true);
  } finally {
    release();
  }
});

test("a lost delete response is reconciled by request ID without another mutation", async ({
  page,
  request,
  bin,
}) => {
  let deletes = 0;
  let requestId = "";
  const statusLookups: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === "/api/files/recycle-operation" &&
      url.searchParams.has("requestId")
    )
      statusLookups.push(url.searchParams.get("requestId")!);
  });
  await page.route("**/api/files?**", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletes++;
    requestId = new URL(route.request().url()).searchParams.get("requestId")!;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.abort("failed");
  });
  await openFiles(page, bin);
  await page.getByRole("button", { name: "recovery", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete archive", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Move this item to Recycle Bin?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete archive", exact: true }),
  ).toHaveCount(0);
  expect(deletes).toBe(1);
  expect(statusLookups).toContain(requestId);
  const result = await (
    await request.get("/api/files/recycle-bin", { headers: bin.headers })
  ).json();
  expect(
    result.items.filter(
      (item: { originalPath: string }) =>
        item.originalPath === "recovery/archive",
    ),
  ).toHaveLength(1);
});

test("an unconfirmed move stops the bulk queue and checks status without replaying deletion", async ({
  page,
  request,
  bin,
}) => {
  const attempted: { path: string; requestId: string }[] = [];
  await page.route("**/api/files?**", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const url = new URL(route.request().url());
    attempted.push({
      path: url.searchParams.get("path")!,
      requestId: url.searchParams.get("requestId")!,
    });
    await route.abort("failed");
  });
  await openFiles(page, bin);
  await page.getByRole("button", { name: "recovery", exact: true }).click();
  for (const name of ["archive", "treasure.txt"])
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
    "outcome could not be confirmed",
  );
  expect(attempted).toHaveLength(1);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const progress = page.getByRole("status", {
    name: "Move to Recycle Bin progress",
    exact: true,
  });
  await expect(progress).toContainText("Move not confirmed");
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "New file", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  const operation = attempted[0];
  const response = await request.delete(
    `/api/files?${new URLSearchParams(operation)}`,
    { headers: bin.headers },
  );
  expect(response.ok()).toBe(true);
  await progress
    .getByRole("button", { name: "Check move status", exact: true })
    .click();
  await expect(progress).not.toBeVisible();
  expect(attempted).toHaveLength(1);
  const files = await (
    await request.get("/api/files?path=recovery", { headers: bin.headers })
  ).json();
  expect(files.entries).toHaveLength(1);
  expect(files.entries[0].path).not.toBe(operation.path);
});

test("status permission loss stops polling and an inspected unconfirmed move can be dismissed without retry", async ({
  page,
  request,
  bin,
}) => {
  let deletes = 0;
  let deniedStatusChecks = 0;
  await page.clock.install();
  await page.route("**/api/files/recycle-operation*", (route) => {
    if (!deletes) return route.fulfill({ json: { operation: null } });
    deniedStatusChecks++;
    return route.fulfill({
      status: 403,
      json: { error: "Permission revoked." },
    });
  });
  await page.route("**/api/files?**", (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletes++;
    return route.fulfill({
      status: 503,
      json: { error: "Response unavailable." },
    });
  });
  await openFiles(page, bin);
  await page.getByRole("button", { name: "recovery", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete archive", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Move this item to Recycle Bin?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "outcome could not be confirmed",
  );
  await page.clock.fastForward(10000);
  expect(deniedStatusChecks).toBe(1);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const progress = page.getByRole("status", {
    name: "Move to Recycle Bin progress",
    exact: true,
  });
  await expect(progress).toContainText(
    "This does not cancel a move on the server.",
  );
  await progress
    .getByRole("button", { name: "I've checked the files", exact: true })
    .click();
  await expect(progress).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete archive", exact: true }),
  ).toBeEnabled();
  expect(deletes).toBe(1);
  expect(
    await contents(request, bin, "recovery/archive/nested/world.dat"),
  ).toBe("Original nested world bytes\n");
});

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
  await selectServer(page, bin.otherServerId);
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
                  id: "986cb8d3-8657-4323-bcb8-97078c86614a",
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
      name: /Upload files|New file|New folder/,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /Select/ })).toHaveCount(2);
  await row.getByRole("checkbox").check();
  await expect(
    page.getByRole("button", { name: "Restore selected", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Delete selected permanently", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Permanently delete from Recycle Bin?",
    exact: true,
  });
  await expect(confirmation).toContainText("Incomplete recovery item");
  await expect(confirmation).toContainText("It cannot be undone.");
  await expect(
    confirmation.getByRole("button", {
      name: "Delete permanently",
      exact: true,
    }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("recycle-delete-mobile.png"),
    animations: "disabled",
    fullPage: true,
  });
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
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

test("recovery selection stays stationary, selects visible items only, and confirms bulk restore", async ({
  page,
  request,
  bin,
}, testInfo) => {
  await recycle(request, bin, "recovery/archive");
  await recycle(request, bin, "recovery/treasure.txt");
  await create(
    request,
    bin,
    "recovery",
    "untouched.txt",
    "file",
    "Unselected recovery bytes",
  );
  const untouched = await recycle(request, bin, "recovery/untouched.txt");
  await openFiles(page, bin);
  await openBin(page);
  const all = page.getByRole("checkbox", {
    name: "Select all visible recycled items",
    exact: true,
  });
  // Row clicks may scroll the viewport. Compare the control's document position
  // so a selection-induced layout shift still fails independently of scrolling.
  const position = () =>
    all.evaluate((input) => {
      const bounds = input.getBoundingClientRect();
      return {
        x: bounds.left + window.scrollX,
        y: bounds.top + window.scrollY,
      };
    });
  const before = await position();
  const expectStationary = async () => {
    const current = await position();
    expect(current.x).toBeCloseTo(before.x, 1);
    expect(current.y).toBeCloseTo(before.y, 1);
  };
  await page
    .getByRole("checkbox", { name: "Select recycled archive", exact: true })
    .check();
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  expect(
    await all.evaluate((input: HTMLInputElement) => input.indeterminate),
  ).toBe(true);
  await expectStationary();
  await all.click();
  await expect(all).toBeChecked();
  await expectStationary();
  await all.click();
  await expect(all).not.toBeChecked();
  await expectStationary();
  await page
    .getByRole("checkbox", { name: "Select recycled archive", exact: true })
    .check();
  await expectStationary();
  const search = page.getByRole("textbox", {
    name: "Search recycled items",
    exact: true,
  });
  await search.fill("treasure");
  await expect(
    page.getByRole("checkbox", {
      name: "Select recycled untouched.txt",
      exact: true,
    }),
  ).toHaveCount(0);
  await all.check();
  await expect(
    page.getByRole("region", { name: "Recycle Bin selection" }),
  ).toContainText("2 selected");
  await expect(
    page.getByRole("region", { name: "Recycle Bin selection" }),
  ).toContainText("1 hidden by the filter");
  await page
    .getByRole("button", { name: "Restore selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Restore selected items?",
    exact: true,
  });
  const targets = dialog.getByRole("list", {
    name: "Confirmed recovery items",
  });
  await expect(targets.getByRole("listitem")).toHaveCount(2);
  await expect(targets).toContainText("/recovery/archive");
  await expect(targets).toContainText("/recovery/treasure.txt");
  await expect(targets).not.toContainText("untouched.txt");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("recycle-bulk-restore-desktop.png"),
    animations: "disabled",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(
    (
      await (
        await request.get("/api/files/recycle-bin", { headers: bin.headers })
      ).json()
    ).items,
  ).toHaveLength(3);
  await page
    .getByRole("button", { name: "Restore selected", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Restore selected items", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    await contents(request, bin, "recovery/archive/nested/world.dat"),
  ).toBe("Original nested world bytes\n");
  expect(await contents(request, bin, "recovery/treasure.txt")).toBe(
    "Original treasure bytes\n",
  );
  const remaining = (
    await (
      await request.get("/api/files/recycle-bin", { headers: bin.headers })
    ).json()
  ).items;
  expect(remaining.map((item: { id: string }) => item.id)).toEqual([
    untouched.id,
  ]);
  await search.fill("");
  await all.check();
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await expect(all).not.toBeChecked();
  await all.check();
  await page
    .getByRole("button", { name: "Back to files", exact: true })
    .click();
  await openBin(page);
  await expect(all).not.toBeChecked();
  await expect(
    page.getByRole("region", { name: "Recycle Bin selection" }),
  ).toContainText("0 selected");
});

test("permanent deletion confirms exact targets, retains failed selections, and retries only failures", async ({
  page,
  request,
  bin,
}, testInfo) => {
  const folder = await recycle(request, bin, "recovery/archive");
  const treasure = await recycle(request, bin, "recovery/treasure.txt");
  await create(
    request,
    bin,
    "recovery",
    "treasure.txt",
    "file",
    "Current live file stays intact",
  );
  await create(
    request,
    bin,
    "recovery",
    "untouched.txt",
    "file",
    "Other recovery copy stays intact",
  );
  const untouched = await recycle(request, bin, "recovery/untouched.txt");
  let blocked = true;
  const purges: string[] = [];
  await page.route("**/api/files/recycle-bin/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    expect(route.request().headers()["x-server-id"]).toBe(bin.id);
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    purges.push(id);
    if (id === folder.id && blocked)
      return route.fulfill({
        status: 409,
        json: {
          error: "Fixture recovery file is locked. Release it and retry.",
        },
      });
    await route.continue();
  });
  await openFiles(page, bin);
  await openBin(page);
  await page
    .getByRole("button", {
      name: "Permanently delete treasure.txt",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Permanently delete from Recycle Bin?",
    exact: true,
  });
  await expect(
    dialog
      .getByRole("list", { name: "Confirmed recovery items" })
      .getByRole("listitem"),
  ).toHaveCount(1);
  await expect(dialog).toContainText("/recovery/treasure.txt");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(purges).toEqual([]);
  await page
    .getByRole("checkbox", { name: "Select recycled archive", exact: true })
    .check();
  await page
    .getByRole("checkbox", {
      name: "Select recycled treasure.txt",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Delete selected permanently", exact: true })
    .click();
  const targets = dialog.getByRole("list", {
    name: "Confirmed recovery items",
  });
  await expect(targets.getByRole("listitem")).toHaveCount(2);
  await expect(targets).not.toContainText("/recovery/untouched.txt");
  await expect(dialog).toContainText("It cannot be undone.");
  await page.screenshot({
    path: testInfo.outputPath("recycle-permanent-delete-desktop.png"),
    animations: "disabled",
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "1 item permanently deleted. 1 item failed and remains selected.",
  );
  await expect(
    dialog.getByRole("list", { name: "Recovery action errors" }),
  ).toContainText("Fixture recovery file is locked");
  await expect(targets.getByRole("listitem")).toHaveCount(1);
  await expect(targets).toContainText("/recovery/archive");
  await expect(targets).not.toContainText("/recovery/treasure.txt");
  expect(new Set(purges)).toEqual(new Set([folder.id, treasure.id]));
  expect(purges).toHaveLength(2);
  blocked = false;
  await dialog
    .getByRole("button", { name: "Retry failed items", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(purges.filter((id) => id === folder.id)).toHaveLength(2);
  expect(purges.filter((id) => id === treasure.id)).toHaveLength(1);
  const remaining = (
    await (
      await request.get("/api/files/recycle-bin", { headers: bin.headers })
    ).json()
  ).items;
  expect(remaining.map((item: { id: string }) => item.id)).toEqual([
    untouched.id,
  ]);
  expect(await contents(request, bin, "recovery/treasure.txt")).toBe(
    "Current live file stays intact",
  );
  await expect(
    page.getByRole("region", { name: "Recycle Bin selection" }),
  ).toContainText("0 selected");
  await page
    .getByRole("checkbox", {
      name: "Select recycled untouched.txt",
      exact: true,
    })
    .check();
  await selectServer(page, bin.otherServerId);
  await openBin(page);
  await expect(
    page.getByRole("region", { name: "Recycle Bin selection" }),
  ).toContainText("0 selected");
});

test("bulk restore keeps conflicts selected while restoring other entries without overwrite", async ({
  page,
  request,
  bin,
}) => {
  const conflict = await recycle(request, bin, "recovery/treasure.txt");
  await recycle(request, bin, "recovery/archive");
  await create(
    request,
    bin,
    "recovery",
    "treasure.txt",
    "file",
    "Existing replacement is protected",
  );
  await openFiles(page, bin);
  await openBin(page);
  await page
    .getByRole("checkbox", {
      name: "Select all visible recycled items",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Restore selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Restore selected items?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Restore selected items", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "1 item restored. 1 item failed and remains selected.",
  );
  await expect(
    dialog.getByRole("list", { name: "Recovery action errors" }),
  ).toContainText("already exists");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "Select recycled treasure.txt",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", {
      name: "Select recycled archive",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(await contents(request, bin, "recovery/treasure.txt")).toBe(
    "Existing replacement is protected",
  );
  expect(
    await contents(request, bin, "recovery/archive/nested/world.dat"),
  ).toBe("Original nested world bytes\n");
  const remaining = (
    await (
      await request.get("/api/files/recycle-bin", { headers: bin.headers })
    ).json()
  ).items;
  expect(remaining.map((item: { id: string }) => item.id)).toEqual([
    conflict.id,
  ]);
});
