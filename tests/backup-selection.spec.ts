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

type BackupFixture = {
  id: string;
  otherServerId: string;
  backups: { id: string; name: string }[];
};
const test = base.extend<{ backups: BackupFixture }>({
  backups: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29900;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const created = await createProcessServer(request, {
      data: { name: "Backup selection fixture", mode: "live", port },
    });
    expect(created.status()).toBe(201);
    const { server } = await created.json();
    const headers = { "X-Server-Id": server.id };
    try {
      for (const name of ["Alpha backup", "Beta backup", "Gamma backup"]) {
        const response = await request.post("/api/backups", {
          headers,
          data: { name },
        });
        expect(response.ok()).toBe(true);
      }
      const result = await (
        await request.get("/api/backups", { headers })
      ).json();
      await use({
        id: server.id,
        otherServerId: fleet.defaultServerId,
        backups: result.backups,
      });
    } finally {
      // This fixture belongs to the isolated E2E runtime, never the user's server.
      await removeTestServer(request, server.id);
    }
  },
});

async function openBackups(page: Page, fixture: BackupFixture) {
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    fixture.id,
  );
  await page.goto("/#backups");
  await expect(
    page.getByRole("checkbox", {
      name: "Select backup Alpha backup",
      exact: true,
    }),
  ).toBeVisible();
}

async function backupNames(request: APIRequestContext, fixture: BackupFixture) {
  const response = await request.get("/api/backups", {
    headers: { "X-Server-Id": fixture.id },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).backups
    .map((backup: { name: string }) => backup.name)
    .sort();
}

test("backup history shows compressed sizes and savings without requiring legacy metadata", async ({
  page,
  backups,
}) => {
  await page.route("**/api/backups", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const result = await response.json();
    result.backups = result.backups.map((backup: Record<string, unknown>) => {
      const { compression, compressionLevel, originalSize, ...legacy } = backup;
      if (backup.name === "Beta backup") return { ...legacy, size: 1024 };
      return {
        ...legacy,
        size: 1024,
        compression: "gzip",
        compressionLevel: 9,
        originalSize: backup.name === "Alpha backup" ? 4096 : 512,
      };
    });
    await route.fulfill({ response, json: result });
  });
  await openBackups(page, backups);
  const alpha = page.getByRole("article").filter({ hasText: "Alpha backup" });
  await expect(alpha).toContainText("1.0 KB compressed");
  await expect(alpha).toContainText(".tar.gz");
  await expect(alpha).toContainText("3.0 KB saved");
  for (const name of ["Beta backup", "Gamma backup"]) {
    const row = page.getByRole("article").filter({ hasText: name });
    await expect(row).toContainText("1.0 KB compressed");
    await expect(row).not.toContainText("saved");
    await expect(
      row.getByRole("link", { name: `Download backup ${name}`, exact: true }),
    ).toBeVisible();
  }
});

test("backup dialogs use native modal focus, restore the trigger, and stay open while saving", async ({
  page,
  backups,
}) => {
  await openBackups(page, backups);
  const trigger = page.getByRole("button", {
    name: "Create backup",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Create a backup",
    exact: true,
  });
  await expect
    .poll(() => dialog.evaluate((element) => element.matches("dialog:modal")))
    .toBe(true);
  await expect(dialog.getByRole("textbox")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  // Chromium may send the boundary tab stop to browser chrome. The page
  // underneath the native modal must still never receive keyboard focus.
  expect(
    await dialog.evaluate(
      (element) =>
        document.activeElement === document.body ||
        element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();

  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/backups", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await pending;
    await route.fulfill({ json: {} });
  });
  await trigger.click();
  await dialog
    .getByRole("button", { name: "Create backup", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Creating backup…", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release!();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("specific backups confirm exact targets and preserve unselected archives", async ({
  page,
  request,
  backups,
}, testInfo) => {
  await openBackups(page, backups);
  const attempted: { id: string; serverId: string | undefined }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "DELETE" &&
      url.pathname.startsWith("/api/backups/")
    )
      attempted.push({
        id: url.pathname.split("/").at(-1)!,
        serverId: request.headers()["x-server-id"],
      });
  });
  const deletion = page.getByRole("button", {
    name: "Delete selected",
    exact: true,
  });
  await expect(deletion).toBeDisabled();
  for (const name of ["Alpha backup", "Gamma backup"])
    await page
      .getByRole("checkbox", { name: `Select backup ${name}`, exact: true })
      .check();
  const all = page.getByRole("checkbox", {
    name: "Select all backups",
    exact: true,
  });
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  expect(
    await all.evaluate(
      (element) => (element as HTMLInputElement).indeterminate,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("region", { name: "Backup selection" }),
  ).toContainText("2 selected");
  await deletion.click();
  const dialog = page.getByRole("dialog", {
    name: "Move selected backups to Recycle Bin?",
    exact: true,
  });
  const targets = dialog.getByRole("list", {
    name: "Backups to recycle",
    exact: true,
  });
  await expect(targets.getByRole("listitem")).toHaveCount(2);
  await expect(targets).toContainText("Alpha backup");
  await expect(targets).toContainText("Gamma backup");
  await expect(targets).not.toContainText("Beta backup");
  await page.screenshot({
    path: testInfo.outputPath("backup-selection-confirmation.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(attempted).toEqual([]);
  expect(await backupNames(request, backups)).toEqual([
    "Alpha backup",
    "Beta backup",
    "Gamma backup",
  ]);
  await deletion.click();
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(await backupNames(request, backups)).toEqual(["Beta backup"]);
  expect(attempted.map((item) => item.id).sort()).toEqual(
    backups.backups
      .filter((backup) => backup.name !== "Beta backup")
      .map((backup) => backup.id)
      .sort(),
  );
  expect(attempted.every((item) => item.serverId === backups.id)).toBe(true);
  await expect(deletion).toBeDisabled();
  await expect(
    page.getByRole("link", {
      name: "Download backup Beta backup",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete backup Beta backup", exact: true })
    .click();
  const single = page.getByRole("dialog", {
    name: "Move this backup to Recycle Bin?",
    exact: true,
  });
  await single
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(single).not.toBeVisible();
  expect(await backupNames(request, backups)).toEqual([]);
  const recycled = await (
    await request.get("/api/files/recycle-bin", {
      headers: { "X-Server-Id": backups.id },
    })
  ).json();
  expect(recycled.items).toHaveLength(3);
  expect(
    recycled.items.every((item: { kind: string }) => item.kind === "backup"),
  ).toBe(true);
});

test("select all toggles every backup, stays usable on mobile, and clears when switching servers", async ({
  page,
  backups,
}, testInfo) => {
  await openBackups(page, backups);
  const all = page.getByRole("checkbox", {
    name: "Select all backups",
    exact: true,
  });
  await all.check();
  for (const backup of backups.backups)
    await expect(
      page.getByRole("checkbox", {
        name: `Select backup ${backup.name}`,
        exact: true,
      }),
    ).toBeChecked();
  await expect(
    page.getByRole("region", { name: "Backup selection" }),
  ).toContainText("3 selected");
  await all.uncheck();
  await expect(
    page.getByRole("button", { name: "Delete selected", exact: true }),
  ).toBeDisabled();
  await all.check();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Move selected backups to Recycle Bin?",
    exact: true,
  });
  await expect(dialog.getByRole("listitem")).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("backup-selection-mobile.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 1348, height: 1000 });
  await selectServer(page, backups.otherServerId);
  await expect(
    page.getByRole("checkbox", {
      name: "Select backup Alpha backup",
      exact: true,
    }),
  ).toHaveCount(0);
  await selectServer(page, backups.id);
  await expect(all).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Delete selected", exact: true }),
  ).toBeDisabled();
});

test("bulk recycling retains failed backups for a scoped sequential retry", async ({
  page,
  request,
  backups,
}) => {
  await openBackups(page, backups);
  const failedId = backups.backups.find(
    (backup) => backup.name === "Beta backup",
  )!.id;
  let deny = true;
  let active = 0;
  let maximumActive = 0;
  const attempted: string[] = [];
  await page.route("**/api/backups/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    expect(route.request().headers()["x-server-id"]).toBe(backups.id);
    attempted.push(id);
    active++;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (deny && id === failedId)
        await route.fulfill({
          status: 403,
          json: { error: "Fixture permission denied." },
        });
      else await route.fulfill({ response: await route.fetch() });
    } finally {
      active--;
    }
  });
  await page
    .getByRole("checkbox", { name: "Select all backups", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Move selected backups to Recycle Bin?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "2 backups moved to Recycle Bin. 1 backup could not be moved and remains selected.",
  );
  await expect(
    dialog.getByRole("list", { name: "Move errors", exact: true }),
  ).toContainText("Beta backup: Fixture permission denied.");
  await expect(
    dialog
      .getByRole("list", { name: "Backups to recycle", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("checkbox", {
      name: "Select backup Beta backup",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("region", { name: "Backup selection" }),
  ).toContainText("1 selected");
  expect(await backupNames(request, backups)).toEqual(["Beta backup"]);
  deny = false;
  await dialog
    .getByRole("button", { name: "Retry failed moves", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(await backupNames(request, backups)).toEqual([]);
  expect(attempted.filter((id) => id === failedId)).toHaveLength(2);
  expect(attempted).toHaveLength(4);
  expect(maximumActive).toBe(1);
});

test("Recycle Bin restores archive bytes and backup history without changing server files, and confirms permanent deletion", async ({
  page,
  request,
  backups,
}, testInfo) => {
  const headers = { "X-Server-Id": backups.id };
  const original = (
    await (await request.get("/api/backups", { headers })).json()
  ).backups;
  const alpha = backups.backups.find(
    (backup) => backup.name === "Alpha backup",
  )!;
  const archive = await (
    await request.get(`/api/backups/${alpha.id}/download`, { headers })
  ).body();
  const marker = await request.post("/api/files", {
    headers,
    data: {
      name: "current-world.txt",
      type: "file",
      content: "Keep the current server files",
    },
  });
  expect(marker.ok()).toBe(true);
  const otherHeaders = { "X-Server-Id": backups.otherServerId };
  const otherBefore = await (
    await request.get("/api/files/recycle-bin", { headers: otherHeaders })
  ).json();
  await openBackups(page, backups);
  await page
    .getByRole("checkbox", { name: "Select all backups", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Move selected backups to Recycle Bin?",
    exact: true,
  });
  await expect(dialog).toContainText("You can restore these archives");
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(await backupNames(request, backups)).toEqual([]);

  await page.getByRole("link", { name: "File Manager", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Recycle Bin", exact: true })
    .click();
  const items = page.getByRole("list", { name: "Recycled items", exact: true });
  await expect(items.getByText("Backup archive", { exact: true })).toHaveCount(
    3,
  );
  const alphaRow = items.getByRole("listitem", {
    name: "Recycled backup Alpha backup",
    exact: true,
  });
  await expect(alphaRow).toContainText("Restore to Backups");
  await page.screenshot({
    path: testInfo.outputPath("backup-archives-recycle-bin.png"),
    fullPage: true,
    animations: "disabled",
  });
  await alphaRow
    .getByRole("button", { name: "Restore Alpha backup", exact: true })
    .click();
  await expect(alphaRow).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(
    "Alpha backup restored to Backups.",
  );
  for (const name of ["Beta backup", "Gamma backup"])
    await page
      .getByRole("checkbox", { name: `Select recycled ${name}`, exact: true })
      .check();
  await page
    .getByRole("button", { name: "Restore selected", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Restore selected items?",
    exact: true,
  });
  await expect(dialog).toContainText("Restore backup archives to Backups");
  await expect(
    dialog
      .getByRole("list", { name: "Confirmed recovery items" })
      .getByRole("listitem"),
  ).toHaveCount(2);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await backupNames(request, backups)).toEqual(["Alpha backup"]);
  await page
    .getByRole("button", { name: "Restore selected", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Restore selected items", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Restored archives are available in Backups.",
  );
  await expect(
    page.getByText("Recycle Bin is empty", { exact: true }),
  ).toBeVisible();
  const restored = (
    await (await request.get("/api/backups", { headers })).json()
  ).backups;
  expect(
    restored.sort((a: { id: string }, b: { id: string }) =>
      a.id.localeCompare(b.id),
    ),
  ).toEqual(
    original.sort((a: { id: string }, b: { id: string }) =>
      a.id.localeCompare(b.id),
    ),
  );
  expect(
    await (
      await request.get(`/api/backups/${alpha.id}/download`, { headers })
    ).body(),
  ).toEqual(archive);
  const currentFile = await (
    await request.get("/api/files/content?path=current-world.txt", { headers })
  ).json();
  expect(currentFile.content).toBe("Keep the current server files");

  await page.getByRole("link", { name: "Backups", exact: true }).click();
  for (const backup of backups.backups)
    await expect(
      page.getByRole("link", {
        name: `Download backup ${backup.name}`,
        exact: true,
      }),
    ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete backup Beta backup", exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Move this backup to Recycle Bin?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Move to Recycle Bin", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("link", { name: "File Manager", exact: true }).click();
  const betaRow = page.getByRole("listitem", {
    name: "Recycled backup Beta backup",
    exact: true,
  });
  await betaRow
    .getByRole("button", {
      name: "Permanently delete Beta backup",
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Permanently delete from Recycle Bin?",
    exact: true,
  });
  await expect(dialog).toContainText("It cannot be undone.");
  await expect(dialog).toContainText("Backup archive");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(betaRow).toBeVisible();
  await betaRow
    .getByRole("button", {
      name: "Permanently delete Beta backup",
      exact: true,
    })
    .click();
  await dialog
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(betaRow).toHaveCount(0);
  expect(await backupNames(request, backups)).toEqual([
    "Alpha backup",
    "Gamma backup",
  ]);
  expect(
    await (
      await request.get("/api/files/recycle-bin", { headers: otherHeaders })
    ).json(),
  ).toEqual(otherBefore);
});
