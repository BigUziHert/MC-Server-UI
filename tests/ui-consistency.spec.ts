import { test, expect, type Route } from "@playwright/test";

test("Versions refresh retains the selected release and an old dismissal cannot hide a new job", async ({
  page,
}) => {
  const provider = {
    id: "neoforge",
    name: "NeoForge",
    description: "Modded server",
    website: "https://neoforged.net",
    installable: true,
    kind: "server",
  };
  const oldJob = {
    id: "completed-a",
    status: "completed",
    message: "Previous install completed.",
  };
  const newJob = {
    id: "running-b",
    status: "running",
    message: "Installing the next runtime.",
  };
  let accepted = false,
    polls = 0;
  let heldDismiss: Route | undefined;
  const refreshed: string[] = [];
  await page.route("**/api/server", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), status: "offline" },
    });
  });
  await page.route(/\/api\/versions(?:\?.*)?$/, (route) => {
    if (new URL(route.request().url()).searchParams.get("refresh") === "1")
      refreshed.push("catalog");
    return route.fulfill({
      json: {
        providers: [provider],
        current: {
          software: "NeoForge",
          version: "21.1.250",
          status: "offline",
        },
        runtimeUpdate: {
          available: true,
          provider: "neoforge",
          gameVersion: "1.21.1",
          build: "21.1.250",
        },
        job: accepted ? newJob : oldJob,
      },
    });
  });
  await page.route(/\/api\/versions\/neoforge(?:\?.*)?$/, (route) => {
    if (new URL(route.request().url()).searchParams.get("refresh") === "1")
      refreshed.push("releases");
    return route.fulfill({
      json: { versions: [{ id: "1.21.1", label: "1.21.1", stable: true }] },
    });
  });
  await page.route(/\/api\/versions\/neoforge\/1\.21\.1(?:\?.*)?$/, (route) => {
    if (new URL(route.request().url()).searchParams.get("refresh") === "1")
      refreshed.push("builds");
    return route.fulfill({
      json: { builds: [{ id: "21.1.251", label: "21.1.251", stable: true }] },
    });
  });
  await page.route("**/api/versions/jobs/completed-a/dismiss", (route) => {
    heldDismiss = route;
  });
  await page.route("**/api/versions/install", (route) => {
    accepted = true;
    return route.fulfill({ json: { job: newJob } });
  });
  await page.route("**/api/versions/jobs/running-b", (route) => {
    polls++;
    return route.fulfill({ json: { job: newJob } });
  });
  await page.goto("/#versions");
  await page
    .getByRole("button", { name: "Choose version", exact: true })
    .click();
  const search = page.getByRole("textbox", {
    name: "Search Minecraft versions",
    exact: true,
  });
  await search.fill("1.21");
  await page.getByRole("button", { name: "1.21.1", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Update", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh versions", exact: true })
    .click();
  await expect
    .poll(() => refreshed.sort())
    .toEqual(["builds", "catalog", "releases"]);
  await expect(search).toHaveValue("1.21");
  await expect(page.locator(".versions-build")).toContainText("21.1.251");
  await page
    .getByRole("button", { name: "Dismiss installation status", exact: true })
    .click();
  await expect.poll(() => Boolean(heldDismiss)).toBe(true);
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Update NeoForge", exact: true })
    .getByRole("button", { name: "Update runtime", exact: true })
    .click();
  await expect(page.locator(".versions-job")).toContainText(newJob.message);
  await heldDismiss!.fulfill({ json: { dismissed: true } });
  await expect.poll(() => polls).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".versions-job")).toContainText(newJob.message);
});

const event = {
  id: "ui-event",
  action: "file.edited",
  detail: "Updated server.properties",
  actor: "Local administrator",
  category: "file",
  createdAt: new Date(Date.now() - 3_700_000).toISOString(),
};

test("partially failed file uploads reload files that reached disk", async ({
  page,
}) => {
  let uploaded = false;
  await page.route(/\/api\/files\?/, (route) =>
    route.fulfill({
      json: {
        path: "",
        entries: uploaded
          ? [
              {
                name: "landed.txt",
                path: "landed.txt",
                size: 10,
                type: "file",
                modified: new Date().toISOString(),
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/files/upload?*", (route) => {
    uploaded = true;
    return route.fulfill({
      status: 409,
      json: { error: "second.txt could not be uploaded" },
    });
  });
  await page.goto("/#files");
  await expect(
    page.getByRole("heading", { name: "A fresh start", exact: true }),
  ).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles([
    {
      name: "landed.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("first file"),
    },
    {
      name: "second.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("second file"),
    },
  ]);
  await expect(
    page.getByText("second.txt could not be uploaded", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select landed.txt", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("2 files uploaded.", { exact: true }),
  ).toHaveCount(0);
});

test("audit refresh retains rows and reports failure without a success notification", async ({
  page,
}) => {
  let requestCount = 0;
  let held: Route | undefined;
  await page.route("**/api/audit", async (route) => {
    if (++requestCount === 1)
      await route.fulfill({ json: { entries: [event] } });
    else held = route;
  });
  await page.goto("/#audit");
  const row = page.getByRole("row").filter({ hasText: event.detail });
  await expect(row).toBeVisible();
  await expect(row).toContainText("1 hour ago");
  const refresh = page.getByRole("button", {
    name: "Refresh audit logs",
    exact: true,
  });
  await refresh.click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(refresh).toBeDisabled();
  await expect(row).toBeVisible();
  await held!.fulfill({
    status: 503,
    json: { error: "Activity service unavailable" },
  });
  await expect(page.getByRole("alert")).toContainText(
    "Activity service unavailable",
  );
  await expect(row).toBeVisible();
  await expect(refresh).toBeEnabled();
  await expect(
    page.getByText("Audit logs refreshed.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
});

test("audit polling refreshes in place and panel history remains available with no servers", async ({
  page,
}) => {
  await page.route("**/api/servers", (route) =>
    route.fulfill({ json: { servers: [], defaultServerId: null } }),
  );
  await page.route("**/api/desktop/selection", (route) =>
    route.fulfill({ json: { desktop: false, activeServerId: null } }),
  );
  await page.clock.install();
  let polls = 0;
  await page.route("**/api/panel/audit", (route) =>
    route.fulfill({
      json: {
        entries: [
          {
            ...event,
            action: "server.removed",
            category: "server",
            detail:
              ++polls === 1
                ? "Removed final server: Old survival"
                : "Removed final server: Old survival (verified)",
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Panel audit logs", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Audit logs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Removed final server: Old survival", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Panel activity, including removed servers", {
      exact: true,
    }),
  ).toBeVisible();
  await page.clock.runFor(10_100);
  await expect(
    page.getByText("Removed final server: Old survival (verified)", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Databases", exact: true }),
  ).toHaveCount(0);
});

test("file pagination preserves selections across pages and resets after searching", async ({
  page,
}) => {
  const entries = Array.from({ length: 60 }, (_, index) => {
    const name = `file-${String(index + 1).padStart(2, "0")}.txt`;
    return {
      name,
      path: name,
      type: "file",
      size: 10,
      modified: new Date().toISOString(),
    };
  });
  await page.route(/\/api\/files\?/, (route) =>
    route.fulfill({ json: { path: "", entries } }),
  );
  await page.goto("/#files");
  await page
    .getByRole("checkbox", { name: "Select file-01.txt", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Next files page", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "files page", exact: true }),
  ).toHaveText("Page 2 of 3");
  await page
    .getByRole("checkbox", { name: "Select file-26.txt", exact: true })
    .check();
  await expect(
    page.getByText("1 outside this page or filter", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Previous files page", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Select file-01.txt", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Next files page", exact: true })
    .click();
  const search = page.getByRole("textbox", { name: "Search files" });
  await search.fill("file-60");
  await expect(search).toHaveValue("file-60");
  await expect(
    page.getByRole("status", { name: "files page", exact: true }),
  ).toHaveText("Page 1 of 1");
  await expect(
    page.getByRole("checkbox", { name: "Select file-60.txt", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("2 outside this page or filter", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Select file-01.txt", exact: true }),
  ).toBeChecked();
});

test("dirty property refresh confirms reload and file changes clear the search", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/minecraft/properties", (route) =>
    route.fulfill({
      json: {
        files: [
          { name: "server.properties", path: "server.properties" },
          { name: "bukkit.yml", path: "bukkit.yml" },
        ],
      },
    }),
  );
  await page.route("**/api/minecraft/properties/file?*", (route) => {
    reads++;
    const path = new URL(route.request().url()).searchParams.get("path");
    return route.fulfill({
      json: {
        path,
        status: "offline",
        revision: String(reads),
        fields: [
          {
            key: "motd",
            label: "Server message",
            type: "string",
            value:
              path === "server.properties" ? "Saved message" : "Bukkit message",
          },
        ],
      },
    });
  });
  await page.goto("/#properties");
  const field = page.getByRole("textbox", {
    name: "Server message",
    exact: true,
  });
  await field.fill("Unsaved message");
  await page
    .getByRole("button", { name: "Refresh properties", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Reload and discard 1 unsaved changes?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect(reads).toBe(1);
  await dialog
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(field).toHaveValue("Unsaved message");
  await page
    .getByRole("button", { name: "Refresh properties", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Reload properties", exact: true })
    .click();
  await expect(field).toHaveValue("Saved message");
  const search = page.getByRole("textbox", {
    name: "Search properties",
    exact: true,
  });
  await search.fill("not-present");
  await expect(
    page.getByRole("heading", { name: "No matching properties" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "bukkit.yml", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(field).toHaveValue("Bukkit message");
});

test("restoring a mod previews duplicate copies before writing files", async ({
  page,
}) => {
  let restored = false;
  const item = {
    id: "old-mod",
    name: "sample-old.jar",
    originalPath: "mods/sample-old.jar",
    type: "file",
    status: "ready",
    size: 500,
    deletedAt: new Date().toISOString(),
  };
  await page.route("**/api/files/recycle-bin", (route) =>
    route.fulfill({ json: { protected: true, items: restored ? [] : [item] } }),
  );
  await page.route(
    "**/api/files/recycle-bin/old-mod/restore-preview",
    (route) =>
      route.fulfill({
        json: {
          duplicates: [{ path: "mods/sample-new.jar", title: "Sample mod" }],
          warnings: [],
        },
      }),
  );
  await page.route("**/api/files/recycle-bin/old-mod/restore", (route) => {
    restored = true;
    return route.fulfill({ json: { message: "Restored" } });
  });
  await page.goto("/#files");
  await page
    .getByRole("button", { name: "Open Recycle Bin", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Restore sample-old.jar", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Restore selected items?",
    exact: true,
  });
  await expect(dialog).toContainText("Review duplicate mods before restoring");
  await expect(dialog).toContainText("mods/sample-new.jar");
  expect(restored).toBe(false);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(restored).toBe(false);
  await page
    .getByRole("button", { name: "Restore sample-old.jar", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Restore selected items", exact: true })
    .click();
  await expect.poll(() => restored).toBe(true);
});

test("shared search keeps neutral focus styling and places clear control inside the field", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/audit", (route) =>
    route.fulfill({ json: { entries: [event] } }),
  );
  await page.goto("/#audit");
  const search = page.getByRole("textbox", {
    name: "Search audit logs",
    exact: true,
  });
  await search.fill("Edited");
  const wrapper = page.locator(".search-field").filter({ has: search });
  await expect(wrapper).toHaveCSS("height", "36px");
  await expect(wrapper).toHaveCSS("border-radius", "6px");
  await expect(wrapper).toHaveCSS("border-color", "rgb(48, 49, 64)");
  await expect(wrapper).toHaveCSS("box-shadow", "none");
  await expect(search).toHaveCSS("outline-style", "none");
  const box = await wrapper.boundingBox();
  const clear = await page
    .getByRole("button", { name: "Clear search", exact: true })
    .boundingBox();
  expect(box && clear).toBeTruthy();
  expect(clear!.x + clear!.width).toBeLessThanOrEqual(box!.x + box!.width);
  expect(clear!.x).toBeGreaterThan(box!.x);
  await page.screenshot({
    path: testInfo.outputPath("shared-search-mobile.png"),
    fullPage: true,
  });
});
