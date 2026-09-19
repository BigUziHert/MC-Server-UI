import { test, expect } from "@playwright/test";
import {
  removeTestServer,
  selectServer,
  serverButton,
} from "./server-fixtures";

for (const width of [1434, 390]) {
  test(`server list and folder breadcrumbs stay scoped and usable at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29940;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const created = await request.post("/api/servers", {
      data: { name: `Folder navigation ${width}`, port },
    });
    expect(created.status()).toBe(201);
    const { server } = await created.json();
    const headers = { "X-Server-Id": server.id };
    const folder = "folder with spaces # and %";
    try {
      for (const [parent, name] of [
        ["", "world"],
        ["world", folder],
      ]) {
        const response = await request.post("/api/files", {
          headers,
          data: { path: parent, name, type: "directory" },
        });
        expect(response.status(), await response.text()).toBe(201);
      }
      const file = await request.post("/api/files", {
        headers,
        data: {
          path: `world/${folder}`,
          name: "proof.txt",
          type: "file",
          content: "This server only.",
        },
      });
      expect(file.status()).toBe(201);
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (id) => localStorage.setItem("mc-panel.active-server", id),
        server.id,
      );
      await page.goto("/#files");
      const nav = page.getByRole("navigation", {
        name: "Main navigation",
        exact: true,
      });
      if (width < 761)
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .click();
      await expect(nav.getByRole("heading").first()).toHaveText(
        "SERVER SELECTOR",
      );
      await expect(
        nav.getByRole("button", { name: "SERVER", exact: true }),
      ).toBeVisible();
      await expect(
        nav.getByRole("list", { name: "Your servers" }).getByRole("button"),
      ).toHaveCount(fleet.servers.length + 1);
      await expect(serverButton(page, server.id)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(nav.getByRole("combobox")).toHaveCount(0);
      if (width < 761)
        await nav
          .getByRole("link", { name: "File Manager", exact: true })
          .click();

      const breadcrumb = page.getByRole("navigation", {
        name: "Breadcrumb",
        exact: true,
      });
      const files = page.getByRole("region", {
        name: "Server files",
        exact: true,
      });
      await files.getByRole("button", { name: "world", exact: true }).click();
      await expect(
        breadcrumb.getByRole("button", { name: "world", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await files.getByRole("button", { name: folder, exact: true }).click();
      await expect(
        breadcrumb.getByRole("button", { name: folder, exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        files.getByRole("button", { name: "proof.txt", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath(`folders-${width}.png`),
        fullPage: true,
      });
      await breadcrumb
        .getByRole("button", { name: "world", exact: true })
        .click();
      await expect(
        files.getByRole("button", { name: folder, exact: true }),
      ).toBeVisible();
      await expect(
        breadcrumb.getByRole("button", { name: folder, exact: true }),
      ).toHaveCount(0);
      await breadcrumb
        .getByRole("button", { name: "File Manager", exact: true })
        .click();
      await expect(
        files.getByRole("button", { name: "world", exact: true }),
      ).toBeVisible();
      await expect(
        breadcrumb.getByRole("button", { name: "world", exact: true }),
      ).toHaveCount(0);
      await files
        .getByRole("button", { name: "Open Recycle Bin", exact: true })
        .click();
      await expect(breadcrumb).toContainText("Recycle Bin");
      await breadcrumb
        .getByRole("button", { name: "File Manager", exact: true })
        .click();
      await expect(files).toBeVisible();
      await files.getByRole("button", { name: "world", exact: true }).click();
      await selectServer(page, fleet.defaultServerId);
      await expect(
        breadcrumb.getByRole("button", { name: "world", exact: true }),
      ).toHaveCount(0);
      await expect(breadcrumb).toContainText("E2E Overworld");
    } finally {
      await removeTestServer(request, server.id);
    }
  });
}
