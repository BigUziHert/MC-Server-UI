import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { Resvg } from "@resvg/resvg-js";
import { createFleet } from "../server/index.mjs";
import { createRemoteTls } from "../server/remote-tls.mjs";

test("browser origins isolate sign-ins, replay protection, icons and streamed downloads across HTTPS ports", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-origin-auth-"));
  const resources: {
    server: https.Server;
    fleet: Awaited<ReturnType<typeof createFleet>>;
  }[] = [];
  let context: BrowserContext | undefined;
  try {
    async function host(identity: string) {
      const dataDir = path.join(root, identity);
      const fleet = await createFleet({
        dataDir,
        useEnvironment: false,
        createDefaultServer: true,
        scheduler: false,
        remoteListen: false,
        name: `${identity} private server`,
        publicAddress: { resolve: async () => null },
      });
      const tls = await createRemoteTls({
        dataDir,
        localAddresses: () => [],
      }).ensure("https://127.0.0.1");
      const server = https.createServer(
        { key: tls.key, cert: tls.cert },
        fleet.remoteApp,
      );
      const received: { cookie?: string; authorization?: string }[] = [];
      server.prependListener("request", (request) => {
        received.push({
          cookie: request.headers.cookie,
          authorization: request.headers.authorization,
        });
      });
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
      const email = `member-${identity.toLowerCase()}@example.test`;
      const account = await fleet.access.createAccount({ email });
      const id = [...fleet.runtimes.keys()][0];
      await fleet.access.grantServer(id, account.id, {
        permissions: ["server.view", "file.read", "file.read-content"],
      });
      const runtime = fleet.runtimes.get(id)!;
      await fs.writeFile(
        path.join(runtime.serverDir, "private file.txt"),
        `${identity} private download`,
      );
      const icon = new Resvg(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/></svg>',
      )
        .render()
        .asPng();
      await fs.writeFile(path.join(runtime.serverDir, "server-icon.png"), icon);
      const invitation = await fleet.access.inviteAccount(account.id);
      return {
        origin,
        email,
        account,
        id,
        received,
        invitation: invitation.invitationUrl,
      };
    }
    const A = await host("A"),
      C = await host("C");
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
    });
    const pageA = await context.newPage(),
      pageC = await context.newPage();
    async function accept(page: Page, invitation: string) {
      await page.goto(invitation);
      await page
        .getByLabel("New password", { exact: true })
        .fill("Origin isolated password!");
      await page
        .getByLabel("Confirm password", { exact: true })
        .fill("Origin isolated password!");
      await page
        .getByRole("button", { name: "Set password and continue" })
        .click();
      await expect(
        page.getByRole("heading", { name: /private server/, exact: false }),
      ).toBeVisible();
    }
    await accept(pageA, A.invitation);
    await pageC.goto(`${C.origin}/`);
    await expect(
      pageC.getByRole("heading", { name: "Welcome to your server" }),
    ).toBeVisible();
    // These assertions inspect C's own incoming headers, never A's credential.
    expect(
      C.received.some((value) => !!value.cookie || !!value.authorization),
    ).toBe(false);
    const observedByC = C.received.at(-1) ?? {};
    const replay = await context.request.get(`${A.origin}/api/access/session`, {
      headers: {
        ...(observedByC.cookie ? { Cookie: observedByC.cookie } : {}),
        ...(observedByC.authorization
          ? { Authorization: observedByC.authorization }
          : {}),
      },
    });
    expect((await replay.json()).role).toBe("guest");
    await accept(pageC, C.invitation);
    await pageA.reload();
    await expect(
      pageA.getByRole("heading", { name: "A private server", exact: true }),
    ).toBeVisible();
    await pageC.reload();
    await expect(
      pageC.getByRole("heading", { name: "C private server", exact: true }),
    ).toBeVisible();
    expect(
      (await context.cookies()).some(
        (cookie) => cookie.name === "__Host-mc-subuser",
      ),
    ).toBe(false);
    await expect(
      pageA.locator('img.server-icon-image[src^="blob:"]').first(),
    ).toBeVisible();
    await pageA
      .getByRole("link", { name: "File Manager", exact: true })
      .click();
    const downloadEvent = pageA.waitForEvent("download");
    await pageA
      .getByRole("button", { name: "Download private file.txt", exact: true })
      .click();
    const download = await downloadEvent;
    const saved = await download.path();
    expect(await fs.readFile(saved!, "utf8")).toBe("A private download");
    expect(download.url()).toContain("downloadTicket=");
    expect((await context.request.get(download.url())).status()).toBe(401);
    await pageC
      .getByRole("button", { name: `Account menu for ${C.email}` })
      .click();
    await pageC.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(pageC.getByLabel("Email address")).toBeVisible();
    await pageA.reload();
    await expect(
      pageA.getByRole("button", {
        name: `Account menu for ${A.email}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      pageA.getByRole("button", {
        name: "Download private file.txt",
        exact: true,
      }),
    ).toBeVisible();
    // Origin storage persists across a new browser context without sharing C's login.
    const storageState = await context.storageState();
    await context.close();
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      storageState,
    });
    const restarted = await context.newPage();
    await restarted.goto(A.origin);
    await expect(
      restarted.getByRole("heading", { name: "A private server", exact: true }),
    ).toBeVisible();
    await restarted.goto(C.origin);
    await expect(restarted.getByLabel("Email address")).toBeVisible();
  } finally {
    await context?.close();
    for (const { server, fleet } of resources) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fleet.close();
    }
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root).startsWith("mc-origin-auth-")).toBe(true);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
