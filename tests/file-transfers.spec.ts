import { test, expect, type Page } from "@playwright/test";
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
