import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { Resvg } from "@resvg/resvg-js";
import { createFleet } from "../server/index.mjs";
import { createRemoteTls } from "../server/remote-tls.mjs";

const sharedServerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const password = "Browser shared workspace password!";

test("browser workspace connects to independent HTTPS panels with isolated files, sign-ins and revocation", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-browser-panels-"));
  const resources: {
    server: https.Server;
    fleet: Awaited<ReturnType<typeof createFleet>>;
  }[] = [];
  let context: BrowserContext | undefined;
  try {
    async function host(name: string) {
      const dataDir = path.join(root, name);
      const options = {
        dataDir,
        useEnvironment: false,
        createDefaultServer: true,
        scheduler: false,
        remoteListen: false,
        publicAddress: { resolve: async () => null },
      };
      const seed = await createFleet(options);
      await seed.close();
      const registryPath = path.join(dataDir, "servers.json");
      const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
      registry.defaultServerId = sharedServerId;
      registry.servers[0].id = sharedServerId;
      registry.servers[0].name = "Shared name";
      await fs.writeFile(registryPath, JSON.stringify(registry));
      const fleet = await createFleet(options);
      const tls = await createRemoteTls({
        dataDir,
        localAddresses: () => [],
      }).ensure("https://127.0.0.1");
      const server = https.createServer(
        { key: tls.key, cert: tls.cert },
        fleet.remoteApp,
      );
      const received: {
        method?: string;
        path?: string;
        authorization?: string;
        cookie?: string;
        client?: string;
        origin?: string;
      }[] = [];
      server.prependListener("request", (request) =>
        received.push({
          method: request.method,
          path: request.url,
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          client: request.headers["x-mc-panel-client"] as string | undefined,
          origin: request.headers.origin,
        }),
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      resources.push({ server, fleet });
      const port = (server.address() as AddressInfo).port;
      const origin = `https://127.0.0.1:${port}`;
      await fleet.access.configure({
        enabled: true,
        publicUrl: origin,
        port,
        transport: "direct",
      });
      const email = `${name}@example.test`;
      const account = await fleet.access.createAccount({ email });
      await fleet.access.grantServer(sharedServerId, account.id, {
        permissions: [
          "server.view",
          "file.read",
          "file.read-content",
          "file.create",
          "file.update",
        ],
      });
      const directory = fleet.runtimes.get(sharedServerId)!.serverDir;
      await fs.writeFile(
        path.join(directory, "private.txt"),
        `${name} private bytes`,
      );
      const png = new Resvg(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/></svg>',
      )
        .render()
        .asPng();
      await fs.writeFile(path.join(directory, "server-icon.png"), png);
      return {
        origin,
        label: new URL(origin).host,
        email,
        account,
        fleet,
        directory,
        received,
        invitation: (await fleet.access.inviteAccount(account.id))
          .invitationUrl,
      };
    }
    const a = await host("a"),
      c = await host("c");
    context = await browser.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
    });
    let page = await context.newPage();
    await page.goto("/");
    await expect(
      page.getByRole("button", {
        name: "Account menu for Local administrator",
        exact: true,
      }),
    ).toBeVisible();
    async function accountMenu(current: Page) {
      await current.getByRole("button", { name: /^Account menu for/ }).click();
    }
    async function addPanel(invitation: string) {
      await accountMenu(page);
      await page
        .getByRole("menuitem", { name: "Add Panel", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Add Panel",
        exact: true,
      });
      await dialog
        .getByLabel("Invitation link", { exact: true })
        .fill(invitation);
      await dialog
        .getByRole("button", { name: "Continue with invitation", exact: true })
        .click();
      await dialog.getByLabel("New password", { exact: true }).fill(password);
      await dialog
        .getByLabel("Confirm password", { exact: true })
        .fill(password);
      await dialog
        .getByRole("button", { name: "Set password and continue", exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
    }
    await addPanel(a.invitation);
    await addPanel(c.invitation);
    const select = async (label: string) => {
      const button = page.getByRole("button", {
        name: `Select server Shared name on ${label}`,
        exact: true,
      });
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
    };
    await select(a.label);
    await expect(
      page.locator('img.server-icon-image[src^="blob:"]').first(),
    ).toBeVisible();
    await page.getByRole("link", { name: "File Manager", exact: true }).click();
    await page
      .getByLabel("Upload server files", { exact: true })
      .setInputFiles({
        name: "uploaded.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Browser upload to A"),
      });
    await expect(
      page.getByRole("button", { name: "Download uploaded.txt", exact: true }),
    ).toBeVisible();
    expect(
      await fs.readFile(path.join(a.directory, "uploaded.txt"), "utf8"),
    ).toBe("Browser upload to A");
    await expect(
      fs.access(path.join(c.directory, "uploaded.txt")),
    ).rejects.toThrow();
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download private.txt", exact: true })
      .click();
    const download = await downloaded;
    expect(await fs.readFile((await download.path())!, "utf8")).toBe(
      "a private bytes",
    );
    expect(new URL(download.url()).origin).toBe(a.origin);
    expect(download.url()).toContain("downloadTicket=");
    expect((await context.request.get(download.url())).status()).toBe(401);
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    for (const host of [a, c]) {
      expect(
        host.received.some((request) => request.method === "OPTIONS"),
      ).toBe(true);
      expect(
        host.received.some(
          (request) =>
            request.authorization &&
            request.client === "browser" &&
            request.origin === baseURL,
        ),
      ).toBe(true);
      expect(host.received.some((request) => request.cookie)).toBe(false);
    }
    const aToken = a.received.find(
      (request) => request.authorization,
    )?.authorization;
    expect(aToken).toBeTruthy();
    expect(c.received.some((request) => request.authorization === aToken)).toBe(
      false,
    );

    // Saved browser connections survive reload and a new browser context.
    const storageState = await context.storageState();
    await context.close();
    context = await browser.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      storageState,
    });
    page = await context.newPage();
    await page.goto("/");
    await expect(
      page.getByRole("button", {
        name: `Select server Shared name on ${a.label}`,
        exact: true,
      }),
    ).toBeVisible();
    await select(c.label);
    await accountMenu(page);
    await page
      .getByRole("menuitem", { name: "Manage Connections", exact: true })
      .click();
    let manager = page.getByRole("dialog", {
      name: "Manage Connections",
      exact: true,
    });
    await manager
      .getByRole("button", { name: `Sign out of ${a.label}`, exact: true })
      .click();
    await manager
      .getByRole("button", { name: "Sign out of this panel", exact: true })
      .click();
    await expect(
      manager.getByRole("button", {
        name: `Sign in to ${a.label}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      manager.getByRole("button", {
        name: `Sign out of ${c.label}`,
        exact: true,
      }),
    ).toBeVisible();
    await manager
      .getByRole("button", { name: "Close panel connections", exact: true })
      .click();

    // Removing a single server grant keeps the panel account; deleting that
    // account subsequently removes its saved connection without a manual retry.
    await c.fleet.access.revoke(sharedServerId, c.account.id);
    await expect(
      page.getByRole("button", {
        name: `Select server Shared name on ${c.label}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await accountMenu(page);
    await page
      .getByRole("menuitem", { name: "Manage Connections", exact: true })
      .click();
    manager = page.getByRole("dialog", {
      name: "Manage Connections",
      exact: true,
    });
    await expect(manager.getByText(c.label, { exact: true })).toBeVisible();
    await c.fleet.access.deleteAccount(c.account.id);
    await expect(manager.getByText(c.label, { exact: true })).toHaveCount(0);
    await expect(manager.getByText(a.label, { exact: true })).toBeVisible();
    expect(c.fleet.runtimes.size).toBe(1);
  } finally {
    await context?.close();
    for (const { server, fleet } of resources) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fleet.close();
    }
    const resolved = await fs.realpath(root);
    expect(path.dirname(resolved).toLowerCase()).toBe(
      (await fs.realpath(os.tmpdir())).toLowerCase(),
    );
    expect(path.basename(resolved)).toMatch(/^mc-browser-panels-/);
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
});
