import { expect, test, type Page } from "@playwright/test";

const origin = "https://sequence.example.test:3002";
type Mode = "Sign in" | "Accept invitation";

async function workspace(page: Page, saved: boolean) {
  await page.addInitScript(
    ({ origin, saved }) => {
      const account = {
        role: "subuser",
        accountId: "member",
        userId: "member",
        email: "member@example.test",
        serverId: null,
        permissions: [],
        hostPermissions: [],
      };
      const descriptor = (id: string, temporary: boolean) => ({
        id,
        label: new URL(origin).host,
        origin,
        local: false,
        signedIn: false,
        session: null,
        sessionEpoch: `${id}-epoch`,
        connectionState: temporary ? "connecting" : "connected",
        servers: [],
        ...(temporary ? { temporary: true } : {}),
      });
      const state: any = {
        unified: true,
        ready: true,
        selectedServer: null,
        localServers: [],
        panels: [
          {
            id: "local",
            label: "This computer",
            origin: location.origin,
            local: true,
            signedIn: true,
            connectionState: "connected",
            servers: [],
          },
          ...(saved ? [descriptor("saved-panel", false)] : []),
        ],
      };
      const calls: any[] = [];
      const drafts = new Map<string, any>();
      const controls: any = {};
      let opening = 0;
      let authenticationCancelled = false;
      const snapshot = () => structuredClone(state);
      const changed = () =>
        window.dispatchEvent(new Event("mc-panel-connections-changed"));
      const authenticate = async (
        action: string,
        id: string,
        input: unknown,
      ) => {
        calls.push({ action, id, input });
        if (saved)
          await new Promise<void>((resolve) => {
            controls.finishAuthentication = resolve;
          });
        if (authenticationCancelled)
          throw new Error(
            "The newer authentication was incorrectly cancelled.",
          );
        const panel =
          state.panels.find((item: any) => item.id === id) ?? drafts.get(id);
        if (!panel)
          throw new Error("The newer panel was incorrectly discarded.");
        panel.signedIn = true;
        panel.session = account;
        panel.connectionState = "connected";
        if (panel.temporary) {
          delete panel.temporary;
          drafts.delete(id);
          state.panels.push(panel);
        }
        changed();
        return snapshot();
      };
      Object.assign(window, {
        sequenceFixture: { state, calls, controls, drafts },
      });
      window.mcPanelConnections = {
        unified: true,
        runtime: "desktop",
        list: async () => snapshot(),
        open: async (url: string) => {
          const attempt = ++opening;
          const id = saved
            ? "saved-panel"
            : attempt === 1
              ? "abandoned-draft"
              : "newer-draft";
          calls.push({ action: "open", id, url });
          if (!saved) drafts.set(id, descriptor(id, true));
          if (attempt === 1)
            await new Promise<void>((resolve) => {
              controls.finishAbandonedOpen = resolve;
            });
          // The operation's own draft is appended after a newer saved connection
          // with the same origin. An origin-only lookup would select the wrong one.
          return {
            ...snapshot(),
            openedPanelId: id,
            panels: [
              ...snapshot().panels,
              ...(!saved ? [structuredClone(drafts.get(id))] : []),
            ],
          };
        },
        cancelSignIn: async (id: string) => {
          calls.push({ action: "cancelSignIn", id });
          if (saved && id === "saved-panel" && controls.finishAuthentication)
            authenticationCancelled = true;
          drafts.delete(id);
        },
        invitation: async (id: string, input: { token: string }) => {
          calls.push({ action: "invitation", id, input });
          return {
            email: account.email,
            panelAddress: origin,
            inviteExpiresAt: new Date(Date.now() + 86400000).toISOString(),
          };
        },
        signIn: (id: string, input: unknown) =>
          authenticate("signIn", id, input),
        acceptInvitation: (id: string, input: unknown) =>
          authenticate("acceptInvitation", id, input),
        openUpdates: async () => {},
      } as unknown as NonNullable<Window["mcPanelConnections"]>;
    },
    { origin, saved },
  );
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/access/session")
      return route.fulfill({ json: { role: "owner" } });
    if (path === "/api/servers")
      return route.fulfill({ json: { servers: [], defaultServerId: null } });
    if (path.startsWith("/api/desktop/"))
      return route.fulfill({ json: { desktop: false } });
    return route.fulfill({
      status: 404,
      json: { error: "Unexpected fixture request." },
    });
  });
  await page.goto("/");
}

async function openForm(page: Page, mode: Mode, newer: boolean) {
  await page
    .getByRole("button", {
      name: "Account menu for Local administrator",
      exact: true,
    })
    .click();
  if (mode === "Sign in") {
    await page
      .getByRole("menuitem", { name: "Manage Connections", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Manage Connections", exact: true })
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
  } else await page.getByRole("menuitem", { name: mode, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: mode, exact: true });
  if (mode === "Sign in") {
    await dialog.getByLabel("Panel address", { exact: true }).fill(origin);
    await dialog
      .getByLabel("Email address", { exact: true })
      .fill(newer ? "member@example.test" : "abandoned@example.test");
    await dialog
      .getByLabel("Password", { exact: true })
      .fill(newer ? "newer-password-value" : "abandoned-password-value");
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  } else {
    await dialog
      .getByLabel("Invitation link", { exact: true })
      .fill(`${origin}/#invite=${(newer ? "b" : "a").repeat(43)}`);
    await dialog
      .getByRole("button", { name: "Continue with invitation", exact: true })
      .click();
    if (newer) {
      await dialog
        .getByLabel("New password", { exact: true })
        .fill("newer-password-value");
      await dialog
        .getByLabel("Confirm password", { exact: true })
        .fill("newer-password-value");
      await dialog
        .getByRole("button", { name: "Set password and continue", exact: true })
        .click();
    }
  }
  return dialog;
}

for (const mode of ["Sign in", "Accept invitation"] as const) {
  for (const saved of [false, true]) {
    test(`${mode}: a late ${saved ? "saved-panel" : "temporary-panel"} open cannot disturb a newer attempt at the same address`, async ({
      page,
    }) => {
      await workspace(page, saved);
      const first = await openForm(page, mode, false);
      await expect
        .poll(() =>
          page.evaluate(() =>
            Boolean(
              (window as any).sequenceFixture.controls.finishAbandonedOpen,
            ),
          ),
        )
        .toBe(true);
      await first
        .getByRole("button", { name: "Close connection dialog", exact: true })
        .click();
      await expect(first).toHaveCount(0);
      const newer = await openForm(page, mode, true);
      const action = mode === "Sign in" ? "signIn" : "acceptInvitation";
      if (saved) {
        await expect
          .poll(() =>
            page.evaluate(() =>
              Boolean(
                (window as any).sequenceFixture.controls.finishAuthentication,
              ),
            ),
          )
          .toBe(true);
        await expect(newer).toBeVisible();
      } else await expect(newer).toHaveCount(0);
      await page.evaluate(async () => {
        (window as any).sequenceFixture.controls.finishAbandonedOpen();
        // Flush the delayed promise's continuation and the resulting UI cleanup.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      const cancellations = await page.evaluate(() =>
        (window as any).sequenceFixture.calls.filter(
          (call: any) => call.action === "cancelSignIn",
        ),
      );
      expect(cancellations).toEqual(
        saved ? [] : [{ action: "cancelSignIn", id: "abandoned-draft" }],
      );
      if (saved) {
        await expect(newer).toBeVisible();
        await expect(newer.getByRole("alert")).toHaveCount(0);
        await page.evaluate(() =>
          (window as any).sequenceFixture.controls.finishAuthentication(),
        );
        await expect(newer).toHaveCount(0);
      }
      expect(
        await page.evaluate(() => (window as any).sequenceFixture.drafts.size),
      ).toBe(0);
      expect(
        await page.evaluate(
          (action) =>
            (window as any).sequenceFixture.calls.filter(
              (call: any) => call.action === action,
            ),
          action,
        ),
      ).toEqual([
        {
          action,
          id: saved ? "saved-panel" : "newer-draft",
          input:
            mode === "Sign in"
              ? {
                  email: "member@example.test",
                  password: "newer-password-value",
                }
              : { token: "b".repeat(43), password: "newer-password-value" },
        },
      ]);
      const panels = (
        await page.evaluate(() => window.mcPanelConnections!.list())
      ).panels.filter((panel) => !panel.local);
      expect(panels).toHaveLength(1);
      expect(panels[0]).toMatchObject({
        id: saved ? "saved-panel" : "newer-draft",
        signedIn: true,
        session: { email: "member@example.test" },
      });
      if (mode === "Accept invitation")
        expect(
          await page.evaluate(() =>
            (window as any).sequenceFixture.calls.filter(
              (call: any) => call.action === "invitation",
            ),
          ),
        ).toEqual([
          {
            action: "invitation",
            id: saved ? "saved-panel" : "newer-draft",
            input: { token: "b".repeat(43) },
          },
        ]);
    });
  }
}
