import { test, expect, type BrowserContext } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createFleet } from "../server/index.mjs";

async function freePort() {
  const listener = http.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

test("a copied invitation works over direct HTTPS through password setup, sign-in, and owner revocation", async ({
  browser,
}, testInfo) => {
  test.setTimeout(60_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-direct-e2e-"));
  let fleet: Awaited<ReturnType<typeof createFleet>> | undefined;
  let owner: http.Server | undefined;
  let context: BrowserContext | undefined;
  try {
    fleet = await createFleet({
      dataDir: root,
      useEnvironment: false,
      createDefaultServer: true,
      scheduler: false,
      name: "Direct HTTPS family fixture",
      publicAddress: { resolve: async () => null },
      remoteBindHost: "127.0.0.1",
      localAddresses: () => [],
    });
    owner = await new Promise<http.Server>((resolve) => {
      const listener = fleet!.app.listen(0, "127.0.0.1", () =>
        resolve(listener),
      );
    });
    const ownerUrl = `http://127.0.0.1:${(owner.address() as AddressInfo).port}`;
    const ownerApi = (
      route: string,
      method = "GET",
      body?: unknown,
      serverId?: string,
    ) =>
      fetch(`${ownerUrl}/api${route}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(serverId ? { "X-Server-Id": serverId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const port = await freePort();
    const publicUrl = `https://127.0.0.1:${port}`;
    const configured = await ownerApi("/access/settings", "PUT", {
      enabled: true,
      publicUrl,
      port,
      transport: "direct",
    });
    expect(configured.status).toBe(200);
    expect(await configured.json()).toMatchObject({
      ready: true,
      listening: true,
      transport: "direct",
    });
    const registered = await (await ownerApi("/servers")).json();
    const serverId = registered.defaultServerId;
    const serverName = registered.servers.find(
      (server: { id: string }) => server.id === serverId,
    ).name;
    const created = await ownerApi("/panel-users", "POST", {
      email: "sister@example.test",
    });
    expect(created.status).toBe(201);
    const accountResult = await created.json();
    const user = accountResult.user ?? accountResult;
    const invitation = await ownerApi(
      `/panel-users/${user.id}/invite`,
      "POST",
      {},
      serverId,
    );
    expect(invitation.status).toBe(200);
    const { invitationUrl } = await invitation.json();
    expect(invitationUrl).toMatch(
      new RegExp(`^https://127\\.0\\.0\\.1:${port}/#invite=`),
    );

    // This context alone trusts the isolated test's self-signed certificate.
    // The Node TLS suite separately verifies its SANs, trust, and persisted key.
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    });
    const phone = await context.newPage();
    const remoteGet = async (url: string) =>
      context!.request.get(url, {
        headers: {
          Authorization: `Bearer ${await phone.evaluate(() => localStorage.getItem("mc-panel.session.v1"))}`,
        },
      });
    await phone.goto(invitationUrl);
    await expect(
      phone.getByRole("heading", { name: "Accept invitation", exact: true }),
    ).toBeVisible();
    await expect(
      phone.getByLabel("Invitation link", { exact: true }),
    ).toHaveValue(invitationUrl);
    await phone
      .getByRole("button", { name: "Continue with invitation", exact: true })
      .click();
    await phone
      .getByLabel("New password", { exact: true })
      .fill("A memorable family password");
    await phone
      .getByLabel("Confirm password", { exact: true })
      .fill("A memorable family password");
    await phone
      .getByRole("button", { name: "Set password and continue" })
      .click();
    await expect(
      phone.getByRole("heading", { name: "No shared servers" }),
    ).toBeVisible();
    expect((await remoteGet(`${publicUrl}/api/servers`)).status()).toBe(200);
    const noServers = await (
      await remoteGet(`${publicUrl}/api/servers`)
    ).json();
    expect(noServers.servers).toEqual([]);
    expect(
      (
        await remoteGet(`${publicUrl}/api/server?serverId=${serverId}`)
      ).status(),
    ).toBe(403);
    const granted = await ownerApi(
      "/subusers",
      "POST",
      {
        accountId: user.id,
        permissions: [
          "server.view",
          "control.start",
          "control.stop",
          "control.restart",
          "control.console",
        ],
      },
      serverId,
    );
    expect(granted.status).toBe(201);
    await expect(
      phone.getByRole("heading", { name: serverName, exact: true }),
    ).toBeVisible();
    await expect(phone).toHaveURL(`${publicUrl}/#console`);
    await expect(
      phone.getByRole("button", { name: "Start", exact: true }),
    ).toBeEnabled();
    await expect(phone.getByRole("log")).toBeVisible();
    await expect(
      phone.getByRole("heading", { name: "Console", exact: true }),
    ).toBeVisible();
    await expect(phone.locator(".metric-card")).toHaveCount(4);
    expect(
      (await context.cookies(publicUrl)).some(
        (entry) => entry.name === "__Host-mc-subuser",
      ),
    ).toBe(false);
    expect(
      await phone.evaluate(() =>
        /^[A-Za-z0-9_-]{43}$/.test(
          localStorage.getItem("mc-panel.session.v1") ?? "",
        ),
      ),
    ).toBe(true);
    expect(await phone.evaluate(() => document.cookie)).not.toContain(
      "__Host-mc-subuser",
    );
    await phone.screenshot({
      path: testInfo.outputPath("direct-https-phone-controls.png"),
      fullPage: true,
    });
    await phone.reload();
    await expect(
      phone.getByRole("heading", { name: serverName, exact: true }),
    ).toBeVisible();
    await phone.getByRole("button", { name: "Open navigation" }).click();
    await phone
      .getByRole("button", { name: "Account menu for sister@example.test" })
      .click();
    await phone
      .getByRole("menuitem", { name: "Manage Connections", exact: true })
      .click();
    const connections = phone.getByRole("dialog", {
      name: "Manage Connections",
      exact: true,
    });
    await connections
      .getByRole("button", {
        name: `Sign out of 127.0.0.1:${port}`,
        exact: true,
      })
      .click();
    await connections
      .getByRole("button", { name: "Sign out of this panel", exact: true })
      .click();
    await connections
      .getByRole("button", {
        name: `Sign in to 127.0.0.1:${port}`,
        exact: true,
      })
      .click();
    await expect(phone.getByLabel("Email address")).toBeVisible();
    expect(
      (await context.cookies(publicUrl)).some(
        (entry) => entry.name === "__Host-mc-subuser",
      ),
    ).toBe(false);
    await phone.getByLabel("Email address").fill("sister@example.test");
    await phone
      .getByLabel("Password", { exact: true })
      .fill("A memorable family password");
    await connections
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    // Close is deliberately available while authentication is pending. Wait
    // for success here so this path verifies sign-in rather than cancelling it.
    await expect(
      connections.getByRole("form", { name: /^Sign in/ }),
    ).toHaveCount(0);
    await connections
      .getByRole("button", { name: "Close panel connections", exact: true })
      .click();
    await expect(
      phone.getByRole("heading", { name: serverName, exact: true }),
    ).toBeVisible();
    const revoked = await ownerApi(
      `/subusers/${user.id}`,
      "DELETE",
      undefined,
      serverId,
    );
    expect(revoked.status).toBe(200);
    await expect(
      phone.getByRole("heading", { name: "No shared servers" }),
    ).toBeVisible();
    await expect(
      phone.getByRole("heading", { name: serverName, exact: true }),
    ).toHaveCount(0);
    await phone.reload();
    await expect(
      phone.getByRole("heading", { name: "No shared servers" }),
    ).toBeVisible();
    const stillSignedIn = await (
      await remoteGet(`${publicUrl}/api/access/session`)
    ).json();
    expect(stillSignedIn.accountId).toBe(user.id);
    expect(
      (
        await remoteGet(`${publicUrl}/api/server?serverId=${serverId}`)
      ).status(),
    ).toBe(403);
    await expect(
      phone.getByRole("heading", { name: serverName, exact: true }),
    ).toHaveCount(0);
  } finally {
    await context?.close();
    if (owner) {
      owner.closeAllConnections();
      await new Promise<void>((resolve) => owner!.close(() => resolve()));
    }
    await fleet?.close();
    const realRoot = await fs.realpath(root);
    const temporary = await fs.realpath(os.tmpdir());
    expect(path.dirname(realRoot).toLowerCase()).toBe(temporary.toLowerCase());
    expect(path.basename(realRoot)).toMatch(/^mc-direct-e2e-/);
    await fs.rm(realRoot, { recursive: true, force: true });
  }
});
