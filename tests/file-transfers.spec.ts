import { test, expect, type Download, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import yauzl from "yauzl";
import {
  createProcessServer,
  selectServer,
  removeTestServer,
} from "./server-fixtures";

async function openFiles(page: Page, id: string) {
  await selectServer(page, id);
  await page.getByRole("link", { name: "File Manager", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "File Manager", exact: true }),
  ).toBeVisible();
}

async function zipContents(download: Download) {
  const filename = await download.path();
  expect(await download.failure()).toBeNull();
  expect(filename).toBeTruthy();
  const bytes = await readFile(filename!);
  return new Promise<Record<string, string>>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const contents: Record<string, string> = {};
      zip.on("error", reject);
      zip.on("end", () => resolve(contents));
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const chunks: Buffer[] = [];
          stream.on("error", reject);
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            contents[entry.fileName] = Buffer.concat(chunks).toString("utf8");
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

test("shared panel readers download files, folders, and selections to their computer", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const fleet = await (await request.get("/api/servers")).json();
  const occupied = new Set(
    fleet.servers.map((server: { port: number }) => server.port),
  );
  let port = 29240;
  while (occupied.has(port)) port++;
  const created = await createProcessServer(request, {
    data: {
      name: "Server PC downloads",
      port,
      mode: "live",
      memoryLimitMB: 1024,
    },
  });
  const { server } = await created.json();
  const headers = { "X-Server-Id": server.id };
  const create = async (
    path: string,
    name: string,
    type: "file" | "directory",
    content = "",
  ) => {
    const response = await request.post("/api/files", {
      headers,
      data: { path, name, type, content },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  try {
    await create(
      "",
      "download & café.txt",
      "file",
      "Saved from the server PC.\n",
    );
    await create("", "world copy", "directory");
    await create("world copy", "empty", "directory");
    await create("world copy", "nested", "directory");
    await create("world copy/nested", "level.txt", "file", "World contents\n");
    await create("", "unselected.txt", "file", "Leave this on the server.\n");
    const permissions = ["file.read", "file.read-content"];
    const serverInfo = await (
      await request.get("/api/server", { headers })
    ).json();
    await page.route("**/api/access/session", (route) =>
      route.fulfill({
        json: {
          role: "subuser",
          email: "gaming-pc@example.test",
          userId: "gaming-pc",
          serverId: server.id,
          permissions,
        },
      }),
    );
    await page.route("**/api/servers", (route) =>
      route.fulfill({
        json: {
          servers: [{ ...serverInfo, accessPermissions: permissions }],
          defaultServerId: server.id,
        },
      }),
    );
    await page.goto("/#files");
    await expect(
      page.getByRole("heading", { name: "File Manager", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New file", exact: true }),
    ).toBeDisabled();

    const fileLink = page.getByRole("link", {
      name: "Download download & café.txt",
      exact: true,
    });
    const fileUrl = new URL((await fileLink.getAttribute("href"))!, page.url());
    expect(fileUrl.searchParams.get("serverId")).toBe(server.id);
    expect(fileUrl.searchParams.get("path")).toBe("download & café.txt");
    let downloadEvent = page.waitForEvent("download");
    await fileLink.click();
    let download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("download & café.txt");
    expect(await readFile((await download.path())!, "utf8")).toBe(
      "Saved from the server PC.\n",
    );

    const folderLink = page.getByRole("link", {
      name: "Download world copy",
      exact: true,
    });
    await expect(folderLink).toHaveAttribute(
      "title",
      "Download folder as ZIP to this computer",
    );
    downloadEvent = page.waitForEvent("download");
    await folderLink.click();
    download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("world copy.zip");
    let contents = await zipContents(download);
    expect(contents["world copy/nested/level.txt"]).toBe("World contents\n");
    expect(contents).toHaveProperty("world copy/empty/", "");
    expect(
      Object.keys(contents).every((path) => path.startsWith("world copy/")),
    ).toBe(true);

    await page
      .getByRole("checkbox", { name: "Select world copy", exact: true })
      .check();
    await page
      .getByRole("checkbox", {
        name: "Select download & café.txt",
        exact: true,
      })
      .check();
    await page
      .getByRole("textbox", { name: "Search files and folders", exact: true })
      .fill("world");
    await expect(
      page.getByRole("region", { name: "Selected files and folders" }),
    ).toContainText("1 outside this page or filter");
    downloadEvent = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download selected", exact: true })
      .click();
    download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("files.zip");
    contents = await zipContents(download);
    expect(contents["download & café.txt"]).toBe("Saved from the server PC.\n");
    expect(contents["world copy/nested/level.txt"]).toBe("World contents\n");
    expect(contents).not.toHaveProperty("unselected.txt");
    await expect(page).toHaveURL(/#files$/);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("button", { name: "Download selected", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  } finally {
    await removeTestServer(request, server.id);
  }
});

test("Copy and Paste retain nested files across folder and server navigation without overwriting", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const fleet = await (await request.get("/api/servers")).json();
  const occupied = new Set(
    fleet.servers.map((server: { port: number }) => server.port),
  );
  const ids: string[] = [];
  for (const name of ["Transfer source", "Transfer destination"]) {
    let port = 29220;
    while (occupied.has(port)) port++;
    occupied.add(port);
    const response = await createProcessServer(request, {
      data: { name, port, mode: "live", memoryLimitMB: 1024 },
    });
    ids.push((await response.json()).server.id);
  }
  const [sourceId, targetId] = ids;
  const create = async (
    path: string,
    name: string,
    type: "file" | "directory",
    content = "",
  ) => {
    const response = await request.post("/api/files", {
      headers: { "X-Server-Id": sourceId },
      data: { path, name, type, content },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const content = async (id: string, path: string) => {
    const response = await request.get(
      `/api/files/content?path=${encodeURIComponent(path)}`,
      { headers: { "X-Server-Id": id } },
    );
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).content;
  };
  try {
    await create("", "transfer-pack", "directory");
    await create("transfer-pack", "nested", "directory");
    await create("transfer-pack", "empty", "directory");
    await create(
      "transfer-pack/nested",
      "settings.txt",
      "file",
      "keep original settings\n",
    );
    await create("", "copies", "directory");
    await page.goto("/#console");
    await openFiles(page, sourceId);
    await page
      .getByRole("checkbox", { name: "Select transfer-pack", exact: true })
      .check();
    await expect(
      page.getByRole("button", { name: "Copy", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Control+c");
    await expect(
      page.getByRole("status", { name: "Copied files" }),
    ).toContainText("Transfer source");
    await page.getByRole("button", { name: "copies", exact: true }).click();
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(
      page.getByRole("status", { name: "File transfer progress" }),
    ).toContainText("Transfer complete");
    expect(
      await content(sourceId, "copies/transfer-pack/nested/settings.txt"),
    ).toBe("keep original settings\n");

    await openFiles(page, targetId);
    await expect(
      page.getByRole("status", { name: "Copied files" }),
    ).toContainText("Transfer source");
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(
      page.getByRole("status", { name: "File transfer progress" }),
    ).toContainText("Transfer complete");
    expect(await content(targetId, "transfer-pack/nested/settings.txt")).toBe(
      "keep original settings\n",
    );
    expect(await content(sourceId, "transfer-pack/nested/settings.txt")).toBe(
      "keep original settings\n",
    );
    const empty = await request.get("/api/files?path=transfer-pack/empty", {
      headers: { "X-Server-Id": targetId },
    });
    expect(empty.ok()).toBe(true);
    expect((await empty.json()).entries).toEqual([]);

    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await expect(
      page.getByRole("status", { name: "File transfer progress" }),
    ).toContainText("already exists");
    expect(await content(targetId, "transfer-pack/nested/settings.txt")).toBe(
      "keep original settings\n",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("checkbox", { name: "Select transfer-pack", exact: true })
      .check();
    await expect(
      page.getByRole("button", { name: "Copy", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: "release/review-upload/file-transfer-mobile.png",
      fullPage: true,
    });
  } finally {
    for (const id of ids.reverse()) await removeTestServer(request, id);
  }
});
