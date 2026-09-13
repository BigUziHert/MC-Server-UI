import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import catalog from "../shared/subuser-permissions.json" with { type: "json" };
import { removeTestServer } from "./server-fixtures";

const permissionIds = catalog.groups.flatMap((group) =>
  group.permissions.map((permission) => permission.id),
);
type Fixture = { id: string; otherServerId: string };
const test = base.extend<{ server: Fixture }>({
  server: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    const occupied = new Set(
      fleet.servers.map((server: { port: number }) => server.port),
    );
    let port = 29200;
    while (occupied.has(port)) port++;
    const response = await request.post("/api/servers", {
      data: {
        name: "Granular subusers fixture",
        mode: "demo",
        port,
        memoryLimitMB: 1024,
      },
    });
    expect(response.status()).toBe(201);
    const { server } = await response.json();
    try {
      await use({ id: server.id, otherServerId: fleet.defaultServerId });
    } finally {
      await removeTestServer(request, server.id);
    }
  },
});

async function openSubusers(page: Page, id: string) {
  await page.goto("/#subusers");
  await page
    .getByRole("combobox", { name: "Switch server", exact: true })
    .selectOption(id);
  await expect(
    page.getByRole("heading", { name: "Subusers", exact: true }),
  ).toBeVisible();
}

async function users(request: APIRequestContext, id: string) {
  const response = await request.get("/api/subusers", {
    headers: { "X-Server-Id": id },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).users as {
    id: string;
    email: string;
    permissions: string[];
  }[];
}

test("granular subuser permissions persist, edit, and expose accurate mixed group states", async ({
  page,
  request,
  server,
}, testInfo) => {
  const email = "permissions-fixture@example.test";
  await openSubusers(page, server.id);
  await page.getByRole("button", { name: "New user", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  await expect(dialog).toContainText("No invitation will be sent");
  await dialog.getByLabel("Email address", { exact: true }).fill(email);
  const all = dialog.getByRole("checkbox", {
    name: "All permissions",
    exact: true,
  });
  await expect(all).not.toBeChecked();
  const control = dialog.getByRole("checkbox", {
    name: "Select all Control",
    exact: true,
  });
  await control.check();
  await dialog
    .getByRole("checkbox", { name: "Restart", exact: true })
    .uncheck();
  await expect(control).toHaveAttribute("aria-checked", "mixed");
  expect(
    await control.evaluate(
      (element) => (element as HTMLInputElement).indeterminate,
    ),
  ).toBe(true);
  await dialog
    .getByRole("checkbox", { name: "Select all Files", exact: true })
    .check();
  await dialog
    .getByRole("checkbox", { name: "Delete files", exact: true })
    .uncheck();
  await expect(
    dialog.getByRole("checkbox", { name: "Select all Files", exact: true }),
  ).toHaveAttribute("aria-checked", "mixed");
  await expect(all).toHaveAttribute("aria-checked", "mixed");
  await page.screenshot({
    path: testInfo.outputPath("subuser-permissions-desktop.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const expected = [
    "control.console",
    "control.start",
    "control.stop",
    "file.read",
    "file.read-content",
    "file.create",
    "file.update",
  ];
  expect(
    (await users(request, server.id)).find((user) => user.email === email)
      ?.permissions,
  ).toEqual(expected);
  expect(
    (await users(request, server.otherServerId)).some(
      (user) => user.email === email,
    ),
  ).toBe(false);
  await page.reload();
  await page
    .getByRole("button", { name: `Edit permissions for ${email}`, exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Edit subuser permissions",
    exact: true,
  });
  await expect(
    dialog.getByLabel("Email address", { exact: true }),
  ).toHaveJSProperty("readOnly", true);
  await expect(
    dialog.getByRole("checkbox", { name: "Console", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Restart", exact: true }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Delete files", exact: true }),
  ).not.toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "All permissions", exact: true })
    .check();
  for (const group of catalog.groups)
    await expect(
      dialog.getByRole("checkbox", {
        name: `Select all ${group.label}`,
        exact: true,
      }),
    ).toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "Select all Files", exact: true })
    .uncheck();
  await expect(
    dialog.getByRole("checkbox", { name: "All permissions", exact: true }),
  ).toHaveAttribute("aria-checked", "mixed");
  await dialog
    .getByRole("button", { name: "Save permissions", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const updated = permissionIds.filter((id) => !id.startsWith("file."));
  expect(
    (await users(request, server.id)).find((user) => user.email === email)
      ?.permissions,
  ).toEqual(updated);
  await page
    .getByRole("button", { name: `Edit permissions for ${email}`, exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Edit subuser permissions",
    exact: true,
  });
  await expect(
    dialog.getByRole("checkbox", { name: "Select all Files", exact: true }),
  ).not.toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "All permissions", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    (await users(request, server.id)).find((user) => user.email === email)
      ?.permissions,
  ).toEqual(updated);
});

test("subuser cancellation and save errors preserve deliberate selections without premature writes", async ({
  page,
  request,
  server,
}) => {
  await openSubusers(page, server.id);
  let deny = true;
  let submitted = 0;
  await page.route("**/api/subusers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submitted++;
    expect(route.request().headers()["x-server-id"]).toBe(server.id);
    if (deny)
      await route.fulfill({
        status: 403,
        json: { error: "Fixture writes are disabled." },
      });
    else await route.continue();
  });
  await page.getByRole("button", { name: "New user", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("cancelled@example.test");
  await dialog.getByRole("checkbox", { name: "Console", exact: true }).check();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(submitted).toBe(0);
  expect(await users(request, server.id)).toEqual([]);
  await page.getByRole("button", { name: "New user", exact: true }).click();
  dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  const email = dialog.getByLabel("Email address", { exact: true });
  await expect(email).toHaveValue("");
  await expect(
    dialog.getByRole("checkbox", { name: "Console", exact: true }),
  ).not.toBeChecked();
  await email.fill("invalid-email");
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  expect(
    await email.evaluate(
      (element) => (element as HTMLInputElement).validity.typeMismatch,
    ),
  ).toBe(true);
  expect(submitted).toBe(0);
  await email.fill("retry@example.test");
  await dialog.getByRole("checkbox", { name: "Start", exact: true }).check();
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Fixture writes are disabled.",
  );
  await expect(email).toHaveValue("retry@example.test");
  await expect(
    dialog.getByRole("checkbox", { name: "Start", exact: true }),
  ).toBeChecked();
  expect(await users(request, server.id)).toEqual([]);
  deny = false;
  await dialog
    .getByRole("button", { name: "Create subuser", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(submitted).toBe(2);
  expect((await users(request, server.id))[0]).toMatchObject({
    email: "retry@example.test",
    permissions: ["control.start"],
  });
});

test("permission groups and confirmation controls fit a mobile viewport", async ({
  page,
  server,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#subusers");
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Switch server", exact: true })
    .selectOption(server.id);
  await page.getByRole("button", { name: "New user", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create new subuser",
    exact: true,
  });
  await dialog
    .getByLabel("Email address", { exact: true })
    .fill("mobile@example.test");
  await dialog
    .getByRole("checkbox", { name: "All permissions", exact: true })
    .check();
  await dialog
    .getByRole("checkbox", { name: "Console", exact: true })
    .uncheck();
  await expect(
    dialog.getByRole("checkbox", { name: "All permissions", exact: true }),
  ).toHaveAttribute("aria-checked", "mixed");
  await expect(
    dialog.getByRole("checkbox", { name: "Select all Control", exact: true }),
  ).toHaveAttribute("aria-checked", "mixed");
  await expect(
    dialog.getByRole("checkbox", { name: "Select all Backups", exact: true }),
  ).toBeChecked();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("subuser-permissions-mobile.png"),
    fullPage: true,
  });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeInViewport();
  await cancel.click();
  await expect(dialog).not.toBeVisible();
});
