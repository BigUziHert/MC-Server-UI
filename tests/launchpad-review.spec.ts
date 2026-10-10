import { test as base, expect, type Page, type Route } from "@playwright/test";
import {
  createProcessServer,
  removeTestServer,
  stopTestServer,
} from "./server-fixtures";
import { createRequire } from "node:module";

const test = base.extend<{ serverId: string }>({
  serverId: async ({ request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 29600;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const response = await createProcessServer(request, {
      data: { name: "Review fixture", mode: "live", port },
    });
    expect(response.status()).toBe(201);
    const { server } = await response.json();
    try {
      await stopTestServer(request, server.id);
      await use(server.id);
    } finally {
      await removeTestServer(request, server.id);
    }
  },
});
test.beforeEach(async ({ page, serverId }) => {
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    serverId,
  );
});
const version = {
  id: "new",
  name: "New release",
  version: "2.0",
  gameVersions: ["1.21.1"],
  loaders: ["neoforge"],
  publishedAt: "2026-09-01",
  downloadable: true,
};
const installed = (id: string, platform = "modrinth") => ({
  path: `mods/${id}.jar`,
  name: `${id}.jar`,
  sha512: id,
  size: 100,
  title: id,
  platform,
  projectId: id,
  versionId: "old",
  versionName: "1.0",
  update: version,
  updateCheck: "checked",
  url: `https://modrinth.com/project/${id}`,
});
async function catalog(
  page: Page,
  type = "mod",
  job?: Record<string, unknown>,
) {
  await page.route(/\/api\/launchpad(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        platforms: ["modrinth", "curseforge"].map((id) => ({
          id,
          name: id,
          available: true,
          types: [type],
        })),
        status: "offline",
        gameVersion: "1.21.1",
        loader: "neoforge",
        gameVersions: ["1.21.1"],
        warnings: [],
        job,
      },
    }),
  );
  await page.route("**/api/launchpad/search?**", (route) =>
    route.fulfill({
      json: {
        projects: [
          {
            id: "Pack",
            title: "Pack",
            platform: "modrinth",
            description: "Pack",
          },
        ],
        total: 1,
        offset: 0,
        limit: 10,
      },
    }),
  );
  await page.route("**/api/launchpad/versions?**", (route) =>
    route.fulfill({ json: { versions: [version] } }),
  );
}
const plan = {
  planId: "review",
  title: "Pack",
  versionName: "2.0",
  expiresAt: "2099-01-01",
  files: [{ path: "mods/a.jar", size: 100, action: "replace" }],
  warnings: [],
};

const acceptedJob = {
  id: "accepted-job",
  planId: "review",
  status: "running",
  message: "Downloading example.jar",
  completed: 0,
  total: 1,
  cancellable: true,
};

async function reviewInstallation(page: Page) {
  await page.getByRole("button", { name: "Install Pack", exact: true }).click();
  await page
    .getByRole("button", { name: "Review installation", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Review installation", exact: true });
}

for (const manual of [false, true]) {
  test(`accepted installation response loss recovers ${manual ? "with Refresh after a failed lookup" : "automatically"} and reaches its result`, async ({
    page,
  }) => {
    await catalog(page);
    await page.route("**/api/launchpad/installed?**", (route) =>
      route.fulfill({ json: { items: [], warnings: [] } }),
    );
    await page.route("**/api/launchpad/preview", (route) =>
      route.fulfill({ json: plan }),
    );
    let accepted = false;
    let installCalls = 0;
    let failedLookup = false;
    let jobReads = 0;
    let completed = false;
    await page.route(/\/api\/launchpad(?:\?.*)?$/, (route) => {
      if (accepted && manual && !failedLookup) {
        failedLookup = true;
        return route.abort("connectionreset");
      }
      return route.fulfill({
        json: {
          platforms: [
            {
              id: "modrinth",
              name: "Modrinth",
              available: true,
              types: ["mod"],
            },
          ],
          status: "offline",
          gameVersion: "1.21.1",
          loader: "neoforge",
          warnings: [],
          job: accepted
            ? {
                ...acceptedJob,
                ...(completed
                  ? {
                      status: "completed",
                      cancellable: false,
                      message: "Example Mod installed.",
                      completed: 1,
                    }
                  : {}),
              }
            : null,
        },
      });
    });
    await page.route("**/api/launchpad/install", (route) => {
      installCalls++;
      accepted = true;
      return route.abort("connectionreset");
    });
    await page.route("**/api/launchpad/jobs/accepted-job", (route) => {
      jobReads++;
      return route.fulfill({
        json: {
          job: completed
            ? {
                ...acceptedJob,
                status: "completed",
                cancellable: false,
                message: "Example Mod installed.",
                completed: 1,
              }
            : acceptedJob,
        },
      });
    });
    await page.goto("/#launchpad");
    const dialog = await reviewInstallation(page);
    await dialog
      .getByRole("button", { name: "Confirm installation", exact: true })
      .click();
    if (manual) {
      await expect(dialog.getByRole("alert")).toContainText("Failed to fetch");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page
        .getByRole("button", {
          name: "Refresh Launchpad and check updates",
          exact: true,
        })
        .click();
    }
    await expect(dialog).not.toBeVisible();
    const status = page.getByRole("status", {
      name: "Installation status",
      exact: true,
    });
    await expect(status).toContainText("Downloading example.jar");
    await expect(
      page.getByRole("button", { name: "Cancel installation", exact: true }),
    ).toBeVisible();
    await expect.poll(() => jobReads).toBeGreaterThan(0);
    completed = true;
    await expect(status).toContainText("Example Mod installed.");
    await expect(
      page.getByRole("button", { name: "Cancel installation", exact: true }),
    ).toHaveCount(0);
    expect(installCalls).toBe(1);
  });
}

test("a lost retry response recovers the new attempt and can cancel it", async ({
  page,
}) => {
  const previous = {
    ...acceptedJob,
    id: "failed-download",
    status: "failed",
    cancellable: false,
    message: "Download stalled",
    retryable: true,
    retryInput: { planId: "review", confirmed: true },
  };
  await catalog(page, "mod", previous);
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
  let accepted = false;
  let cancelled = false;
  let installs = 0;
  await page.route(/\/api\/launchpad(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        platforms: [
          { id: "modrinth", name: "Modrinth", available: true, types: ["mod"] },
        ],
        status: "offline",
        gameVersion: "1.21.1",
        loader: "neoforge",
        warnings: [],
        job: accepted ? acceptedJob : previous,
      },
    }),
  );
  await page.route("**/api/launchpad/install", (route) => {
    installs++;
    expect(route.request().postDataJSON()).toEqual(previous.retryInput);
    accepted = true;
    return route.abort("connectionreset");
  });
  const cancelledJob = {
    ...acceptedJob,
    status: "failed",
    cancelled: true,
    cancellable: false,
    message: "Installation cancelled. No server files were changed.",
  };
  await page.route("**/api/launchpad/jobs/accepted-job", (route) =>
    route.fulfill({ json: { job: cancelled ? cancelledJob : acceptedJob } }),
  );
  await page.route("**/api/launchpad/jobs/accepted-job/cancel", (route) => {
    cancelled = true;
    return route.fulfill({ json: { job: cancelledJob } });
  });
  await page.goto("/#launchpad");
  await page
    .getByRole("button", { name: "Retry download", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Cancel installation", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "Installation status", exact: true }),
  ).toContainText("Installation cancelled");
  expect(installs).toBe(1);
});

test("failed submission does not attach another review's retained job", async ({
  page,
}) => {
  await catalog(page);
  let submitted = false;
  await page.route(/\/api\/launchpad(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        platforms: [
          { id: "modrinth", name: "Modrinth", available: true, types: ["mod"] },
        ],
        status: "offline",
        gameVersion: "1.21.1",
        loader: "neoforge",
        warnings: [],
        job: submitted ? { ...acceptedJob, planId: "unrelated" } : null,
      },
    }),
  );
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
  await page.route("**/api/launchpad/preview", (route) =>
    route.fulfill({ json: plan }),
  );
  await page.route("**/api/launchpad/install", (route) => {
    submitted = true;
    return route.abort("connectionreset");
  });
  await page.goto("/#launchpad");
  const dialog = await reviewInstallation(page);
  await dialog
    .getByRole("button", { name: "Confirm installation", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Failed to fetch");
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Installation status", exact: true }),
  ).toHaveCount(0);
});

test("a failed retry does not mistake its prior failed job for a newly accepted attempt", async ({
  page,
}) => {
  await catalog(page, "mod", {
    ...acceptedJob,
    status: "failed",
    cancellable: false,
    message: "Previous download stalled",
    retryable: true,
    retryInput: { planId: "review", confirmed: true },
  });
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
  let installs = 0;
  await page.route("**/api/launchpad/install", (route) => {
    installs++;
    return route.abort("connectionreset");
  });
  await page.goto("/#launchpad");
  const retry = page.getByRole("button", {
    name: "Retry download",
    exact: true,
  });
  await retry.click();
  const status = page.getByRole("status", {
    name: "Installation status",
    exact: true,
  });
  await expect(status.getByRole("alert")).toContainText("Failed to fetch");
  await expect(status).toContainText("Previous download stalled");
  await expect(retry).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Cancel installation", exact: true }),
  ).toHaveCount(0);
  expect(installs).toBe(1);
});

test("a delayed Refresh cannot overwrite a newer accepted job", async ({
  page,
}) => {
  const previous = {
    ...acceptedJob,
    id: "previous",
    planId: "old-review",
    status: "completed",
    cancellable: false,
    message: "Earlier installation completed",
  };
  await catalog(page, "mod", previous);
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
  await page.route("**/api/launchpad/preview", (route) =>
    route.fulfill({ json: plan }),
  );
  await page.route("**/api/launchpad/install", (route) =>
    route.fulfill({ json: { job: acceptedJob } }),
  );
  await page.route("**/api/launchpad/jobs/accepted-job", (route) =>
    route.fulfill({ json: { job: acceptedJob } }),
  );
  let heldRefresh: Route | undefined;
  await page.route("**/api/launchpad?refresh=1", (route) => {
    heldRefresh = route;
  });
  await page.goto("/#launchpad");
  await page
    .getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    })
    .click();
  await expect.poll(() => Boolean(heldRefresh)).toBe(true);
  const dialog = await reviewInstallation(page);
  await dialog
    .getByRole("button", { name: "Confirm installation", exact: true })
    .click();
  const status = page.getByRole("status", {
    name: "Installation status",
    exact: true,
  });
  await expect(status).toContainText("Downloading example.jar");
  await heldRefresh!.fulfill({
    json: {
      platforms: [
        { id: "modrinth", name: "Modrinth", available: true, types: ["mod"] },
      ],
      status: "offline",
      gameVersion: "1.21.1",
      loader: "neoforge",
      warnings: [],
      job: previous,
    },
  });
  await expect(
    page.getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(status).toContainText("Downloading example.jar");
});

const require = createRequire(import.meta.url);
const { build: bundleHarness } = createRequire(require.resolve("vite"))(
  "esbuild",
);
let recoveryHarness: Promise<string> | undefined;
function recoveryScopeHarness() {
  recoveryHarness ??= bundleHarness({
    stdin: {
      contents: `
        import React, { useMemo, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { PanelScope, ServerScope } from './src/api';
        import Launchpad from './src/pages/Launchpad';
        const notify = () => {};
        function Harness() {
          const [scope, setScope] = useState({ panelId:'A', sessionEpoch:'epoch-A', serverId:'same-server' });
          const panel = useMemo(() => ({ ...scope, label:scope.panelId, origin:'https://' + scope.panelId.toLowerCase() + '.example.test' }), [scope]);
          return <>
            <button onClick={() => setScope(current => ({...current, serverId:'other-server'}))}>Switch server</button>
            <button onClick={() => setScope(current => ({...current, panelId:'B'}))}>Switch connection</button>
            <button onClick={() => setScope(current => ({...current, sessionEpoch:'replacement-A'}))}>Replace session</button>
            <PanelScope.Provider value={panel}><ServerScope.Provider value={scope.serverId}>
              <Launchpad notify={notify}/>
            </ServerScope.Provider></PanelScope.Provider>
          </>;
        }
        createRoot(document.getElementById('root')).render(<Harness/>);
      `,
      resolveDir: process.cwd(),
      sourcefile: "launchpad-recovery-harness.tsx",
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"test"' },
  }).then(
    (result: { outputFiles: { text: string }[] }) => result.outputFiles[0].text,
  );
  return recoveryHarness!;
}

for (const switchScope of [
  "Switch server",
  "Switch connection",
  "Replace session",
]) {
  for (const delayed of ["submission", "recovery"]) {
    test(`late ${delayed} response stays in its original scope after ${switchScope.toLowerCase()}`, async ({
      page,
    }) => {
      let accepted = false;
      let held: Route | undefined;
      let installs = 0;
      const jobReads: string[] = [];
      const config = (job: Record<string, unknown> | null) => ({
        platforms: [
          { id: "modrinth", name: "Modrinth", available: true, types: ["mod"] },
        ],
        status: "offline",
        gameVersion: "1.21.1",
        loader: "neoforge",
        warnings: [],
        job,
      });
      const destinationJob = {
        ...acceptedJob,
        id: "destination-job",
        planId: "destination-review",
        status: "completed",
        cancellable: false,
        message: "Destination installation completed",
      };
      await page.route("**/api/desktop/panels/**/proxy/api/**", (route) => {
        const url = new URL(route.request().url());
        const original =
          url.pathname.includes("/panels/A/") &&
          url.searchParams.get("desktopEpoch") === "epoch-A" &&
          url.searchParams.get("serverId") === "same-server";
        const path = url.pathname.split("/proxy/api")[1];
        if (path === "/launchpad") {
          if (original && accepted && delayed === "recovery") {
            held = route;
            return;
          }
          return route.fulfill({
            json: config(original ? null : destinationJob),
          });
        }
        if (path === "/server")
          return route.fulfill({ json: { status: "offline" } });
        if (path === "/launchpad/search")
          return route.fulfill({
            json: {
              projects: [
                {
                  id: "Pack",
                  title: "Pack",
                  platform: "modrinth",
                  description: "Pack",
                },
              ],
              total: 1,
              offset: 0,
              limit: 10,
            },
          });
        if (path === "/launchpad/versions")
          return route.fulfill({ json: { versions: [version] } });
        if (path === "/launchpad/installed")
          return route.fulfill({ json: { items: [], warnings: [] } });
        if (path === "/launchpad/preview") return route.fulfill({ json: plan });
        if (path === "/launchpad/install") {
          expect(original).toBe(true);
          installs++;
          accepted = true;
          if (delayed === "submission") {
            held = route;
            return;
          }
          return route.abort("connectionreset");
        }
        if (path.startsWith("/launchpad/jobs/")) jobReads.push(path);
        return route.fulfill({ json: { ok: true } });
      });
      await page.route("**/launchpad-recovery-harness", async (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><div id="root"></div><script>${(await recoveryScopeHarness()).replace(/<\/script/gi, "<\\/script")}</script>`,
        }),
      );
      await page.goto("/launchpad-recovery-harness");
      const dialog = await reviewInstallation(page);
      await dialog
        .getByRole("button", { name: "Confirm installation", exact: true })
        .click();
      await expect.poll(() => Boolean(held)).toBe(true);
      // Model a workspace context change while its native review dialog is open.
      await page
        .getByRole("button", { name: switchScope, exact: true })
        .evaluate((button) => (button as HTMLButtonElement).click());
      const status = page.getByRole("status", {
        name: "Installation status",
        exact: true,
      });
      await expect(status).toContainText("Destination installation completed");
      const response = page.waitForResponse(
        (response) => response.url() === held!.request().url(),
      );
      await held!.fulfill({
        json:
          delayed === "submission" ? { job: acceptedJob } : config(acceptedJob),
      });
      await (await response).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(status).toContainText("Destination installation completed");
      await expect(dialog).not.toBeVisible();
      expect(installs).toBe(1);
      expect(jobReads).toEqual([]);
    });
  }
}

test("Refresh keeps polling after an older job poll fails", async ({
  page,
}) => {
  const job = { ...acceptedJob };
  await catalog(page, "mod", job);
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
  let heldPoll: Route | undefined;
  let polls = 0;
  await page.route("**/api/launchpad/jobs/accepted-job", (route) => {
    if (++polls === 1) {
      heldPoll = route;
      return;
    }
    Object.assign(job, {
      status: "completed",
      message: "Refreshed installation completed",
      cancellable: false,
      completed: 1,
    });
    return route.fulfill({ json: { job } });
  });
  await page.goto("/#launchpad");
  await expect.poll(() => Boolean(heldPoll)).toBe(true);
  const refresh = page.getByRole("button", {
    name: "Refresh Launchpad and check updates",
    exact: true,
  });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await heldPoll!.abort("connectionreset");
  await expect(
    page.getByRole("status", { name: "Installation status", exact: true }),
  ).toContainText("Refreshed installation completed");
  expect(polls).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("accepted installation cancellation waits for the action and ignores an older cancellable poll", async ({
  page,
}) => {
  const job = {
    id: "cancellable-job",
    status: "running",
    message: "Downloading reviewed files",
    completed: 0,
    total: 2,
    cancellable: true,
  };
  await catalog(page, "mod", job);
  let heldPoll: Route | undefined;
  let heldCancel: Route | undefined;
  let polls = 0;
  let cancels = 0;
  let cancelled = false;
  await page.route("**/api/launchpad/jobs/cancellable-job", (route) => {
    if (++polls === 1) {
      heldPoll = route;
      return;
    }
    return route.fulfill({
      json: {
        job: cancelled
          ? {
              ...job,
              status: "failed",
              cancellable: false,
              cancelled: true,
              message: "Installation cancelled. No server files were changed.",
            }
          : job,
      },
    });
  });
  await page.route("**/api/launchpad/jobs/cancellable-job/cancel", (route) => {
    cancels++;
    heldCancel = route;
  });
  await page.goto("/#launchpad");
  const cancel = page.getByRole("button", {
    name: "Cancel installation",
    exact: true,
  });
  await expect.poll(() => Boolean(heldPoll)).toBe(true);
  await cancel.click();
  await expect.poll(() => Boolean(heldCancel)).toBe(true);
  await expect(cancel).toBeDisabled();
  await heldPoll!.fulfill({ json: { job } });
  await expect(cancel).toBeDisabled();
  expect(cancels).toBe(1);
  cancelled = true;
  await heldCancel!.fulfill({ json: { job: { ...job, cancellable: false } } });
  await expect(
    page.getByRole("status", { name: "Installation status", exact: true }),
  ).toContainText("Installation cancelled. No server files were changed.");
  await expect(page.locator(".launchpad-job strong")).toHaveText(
    "Installation cancelled",
  );
  await expect(cancel).toHaveCount(0);
  expect(cancels).toBe(1);
});

test("interrupted installation recovery stays visible through a failed retry and releases controls after recovery", async ({
  page,
}) => {
  const job = {
    id: "interrupted-job",
    status: "failed",
    message: "Interrupted installation needs recovery.",
    completed: 0,
    total: 1,
    recoveryRequired: true,
    retainedRecoveryPath: "private/launchpad/recovery",
  };
  await catalog(page, "mod", job);
  const retries: Route[] = [];
  await page.route("**/api/launchpad/recovery/resolve", (route) => {
    retries.push(route);
  });
  await page.goto("/#launchpad");
  const status = page.getByRole("status", {
    name: "Installation status",
    exact: true,
  });
  const retry = page.getByRole("button", {
    name: "Retry recovery",
    exact: true,
  });
  const dismiss = page.getByRole("button", {
    name: "Dismiss installation status",
    exact: true,
  });
  await expect(status).toContainText(
    "Recovery copies: private/launchpad/recovery",
  );
  await expect(dismiss).toHaveCount(0);
  await retry.click();
  await expect.poll(() => retries.length).toBe(1);
  await expect(retry).toBeDisabled();
  await retries[0].fulfill({
    status: 503,
    json: { error: "Recovery storage unavailable" },
  });
  await expect(page.getByRole("alert")).toContainText(
    "Recovery storage unavailable",
  );
  await expect(retry).toBeEnabled();
  await expect(dismiss).toHaveCount(0);
  await retry.click();
  await expect.poll(() => retries.length).toBe(2);
  await retries[1].fulfill({
    json: {
      ok: true,
      job: {
        ...job,
        recoveryRequired: false,
        retainedRecoveryPath: undefined,
        message: "Previous server files were restored.",
      },
    },
  });
  await expect(status).toContainText("Previous server files were restored.");
  await expect(retry).toHaveCount(0);
  await expect(dismiss).toBeVisible();
});

test("catalog pagination follows the provider canonical offset and explicit refresh requests fresh metadata", async ({
  page,
}) => {
  await catalog(page);
  const searches: URL[] = [];
  let clamped = false;
  await page.route("**/api/launchpad/search?**", (route) => {
    const url = new URL(route.request().url());
    searches.push(url);
    if (Number(url.searchParams.get("offset")) > 0) clamped = true;
    return route.fulfill({
      json: {
        projects: [
          {
            id: "Canonical",
            title: "Canonical",
            platform: "modrinth",
            description: "Current provider page",
          },
        ],
        total: clamped ? 1 : 21,
        offset: 0,
        limit: Number(url.searchParams.get("limit")),
      },
    });
  });
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
  await page.goto("/#launchpad");
  const next = page.getByRole("button", {
    name: "Next Launchpad page",
    exact: true,
  });
  await expect(next).toBeEnabled();
  await next.click();
  await expect
    .poll(() => searches.map((url) => Number(url.searchParams.get("offset"))))
    .toEqual([0, 10, 0]);
  await expect(
    page.getByRole("status", { name: "Launchpad page", exact: true }),
  ).toHaveText("Page 1 of 1");
  await expect(next).toBeDisabled();
  const beforeRefresh = searches.length;
  await page
    .getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      searches
        .slice(beforeRefresh)
        .some((url) => url.searchParams.get("refresh") === "true"),
    )
    .toBe(true);
  await expect(
    page.getByRole("article", { name: "Canonical", exact: true }),
  ).toBeVisible();
});

test("220 installed files stay usable while provider checks run without rescanning on list controls", async ({
  page,
  serverId,
}, testInfo) => {
  await catalog(page);
  const items = Array.from({ length: 220 }, (_, index) => ({
    ...installed(`Mod ${String(index + 1).padStart(3, "0")}`),
    size: index + 1,
    update: null,
    updateCheck: "pending",
  }));
  const requests: URL[] = [];
  let heldOnline: Route | undefined;
  let heldRefresh: Route | undefined;
  let localReads = 0;
  let onlineReads = 0;
  const warnings = [
    "Modrinth is temporarily unavailable (503). Update checks will be available when the provider recovers.",
    "CurseForge is temporarily unavailable (502). Installed files are unchanged.",
  ];
  await page.route("**/api/launchpad/installed?**", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(serverId);
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.searchParams.has("local")) {
      expect(url.searchParams.get("quick")).toBe("true");
      localReads++;
      if (localReads === 2) {
        heldRefresh = route;
        return;
      }
      return route.fulfill({ json: { items, warnings: [] } });
    }
    expect(url.searchParams.get("background")).toBe("true");
    onlineReads++;
    if (onlineReads === 1) {
      heldOnline = route;
      return;
    }
    return route.fulfill({
      json: {
        items: items.map((item) => ({ ...item, updateCheck: "checked" })),
        warnings: Array.from(
          { length: 220 },
          (_, index) => warnings[index % 2],
        ),
      },
    });
  });
  await page.goto("/#launchpad");
  const toggle = page.getByRole("switch", { name: "Show installed content" });
  await toggle.check();
  await expect.poll(() => Boolean(heldOnline)).toBe(true);
  await expect(page.getByRole("article")).toHaveCount(10);
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page
    .getByRole("button", { name: "Next Launchpad page", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "Launchpad page", exact: true }),
  ).toHaveText("Page 2 of 22");
  await page
    .getByLabel("Launchpad rows per page", { exact: true })
    .selectOption("25");
  await expect(page.getByRole("article")).toHaveCount(25);
  await page
    .getByLabel("Sort installed content", { exact: true })
    .selectOption("size");
  await expect(page.getByRole("article").first()).toHaveAttribute(
    "aria-label",
    "Mod 220",
  );
  const search = page.getByLabel("Search Launchpad", { exact: true });
  await search.fill("Mod 217");
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("article")).toHaveAttribute(
    "aria-label",
    "Mod 217",
  );
  await search.fill("");
  await expect(page.getByRole("article")).toHaveCount(25);
  await toggle.uncheck();
  await expect(
    page.getByRole("button", { name: "Install Pack", exact: true }),
  ).toBeVisible();
  await toggle.check();
  await expect(page.getByRole("article")).toHaveCount(25);
  expect(requests).toHaveLength(2);
  expect(localReads).toBe(1);
  expect(onlineReads).toBe(1);

  await heldOnline!.fulfill({
    json: {
      items,
      warnings: [],
      checkingUpdates: true,
      progress: { completed: 40, total: 220 },
    },
  });
  await expect(
    page.getByRole("status", {
      name: "Installed content refresh",
      exact: true,
    }),
  ).toHaveText("Checking updates for 180 of 220…");
  await expect.poll(() => onlineReads).toBe(2);
  await expect(
    page.getByRole("status", {
      name: "Installed content refresh",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(requests.at(-1)!.searchParams.has("refresh")).toBe(false);
  const notices = page.locator(".launchpad-notices");
  await expect(notices).toHaveCount(1);
  await expect(
    notices.getByText(
      "2 provider or file notices — installed files remain available",
      { exact: true },
    ),
  ).toBeVisible();
  const details = notices.getByRole("list", {
    name: "Provider and file notices",
  });
  await expect(details).toBeHidden();
  await notices.locator("summary").click();
  await expect(details.getByRole("listitem")).toHaveText(warnings);
  await notices.locator("summary").click();
  await notices.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("installed-220-notices-desktop.png"),
    animations: "disabled",
  });

  await page
    .getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    })
    .click();
  await expect.poll(() => Boolean(heldRefresh)).toBe(true);
  await expect(page.getByRole("article")).toHaveCount(25);
  await search.fill("Mod 219");
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("article")).toHaveAttribute(
    "aria-label",
    "Mod 219",
  );
  expect(requests).toHaveLength(4);
  await page.setViewportSize({ width: 390, height: 844 });
  await notices.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("installed-220-background-mobile.png"),
    animations: "disabled",
  });
  await heldRefresh!.fulfill({ json: { items, warnings: [] } });
  await expect(
    page.getByRole("button", {
      name: "Refresh Launchpad and check updates",
      exact: true,
    }),
  ).toBeEnabled();
  expect(localReads).toBe(2);
  expect(onlineReads).toBe(3);
  expect(requests.at(-1)!.searchParams.get("refresh")).toBe("true");
});

test("a 120-second background check deadline preserves completed rows and fails only unfinished checks", async ({
  page,
}) => {
  await catalog(page);
  await page.clock.install();
  const items = [
    { ...installed("Current Mod"), update: null },
    installed("Verified Update"),
    { ...installed("Pending Mod"), update: null, updateCheck: "pending" },
    {
      ...installed("Provider Failure"),
      update: null,
      updateCheck: "unavailable",
      updateIssue: "Provider is temporarily unavailable (503).",
    },
    ...Array.from({ length: 170 }, (_, index) => ({
      ...installed(`Z verified ${index}`),
      update: null,
    })),
    ...Array.from({ length: 47 }, (_, index) => ({
      path: `mods/z-unreadable-${index}.jar`,
      name: `z-unreadable-${index}.jar`,
      size: 100,
      platform: null,
      updateCheck: "unavailable",
    })),
  ];
  let onlineReads = 0;
  await page.route("**/api/launchpad/installed?**", (route) => {
    const local = new URL(route.request().url()).searchParams.has("local");
    if (!local) onlineReads++;
    return route.fulfill({
      json: {
        items,
        warnings: [],
        ...(!local && {
          checkingUpdates: true,
          progress: { completed: 220, total: 221 },
        }),
      },
    });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  const progress = page.getByRole("status", {
    name: "Installed content refresh",
    exact: true,
  });
  await expect(progress).toHaveText("Checking updates for 1 of 221…");
  await page.clock.fastForward(120_001);
  await expect(progress).toHaveCount(0);
  await expect(
    page.getByText(/The update check is taking longer than expected/).first(),
  ).toBeVisible();
  const current = page.getByRole("article", {
    name: "Current Mod",
    exact: true,
  });
  await expect(current.getByText("Up to date", { exact: true })).toBeVisible();
  await expect(current.getByText("Update check unavailable")).toHaveCount(0);
  const verified = page.getByRole("article", {
    name: "Verified Update",
    exact: true,
  });
  await expect(
    verified.getByRole("button", {
      name: "Update Verified Update",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(verified.getByText("Update check unavailable")).toHaveCount(0);
  await expect(
    page
      .getByRole("article", { name: "Pending Mod", exact: true })
      .getByText("Update check unavailable"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("article", { name: "Provider Failure", exact: true })
      .getByText("Provider is temporarily unavailable (503).", { exact: true }),
  ).toBeVisible();
  expect(onlineReads).toBe(1);
});

test("a failed initial online refresh does not reuse an old checked status but keeps known updates", async ({
  page,
}) => {
  await catalog(page);
  const items = [
    { ...installed("Current Mod"), update: null },
    installed("Verified Update"),
  ];
  let onlineReads = 0;
  await page.route("**/api/launchpad/installed?**", (route) => {
    const local = new URL(route.request().url()).searchParams.has("local");
    if (!local && ++onlineReads === 2)
      return route.fulfill({
        status: 503,
        json: { error: "Fixture provider gateway offline." },
      });
    return route.fulfill({
      json: {
        items:
          local && onlineReads > 0
            ? items.map((item) => ({ ...item, updateCheck: "pending" }))
            : items,
        warnings: [],
      },
    });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  const current = page.getByRole("article", {
    name: "Current Mod",
    exact: true,
  });
  await expect(current.getByText("Up to date", { exact: true })).toBeVisible();
  await expect.poll(() => onlineReads).toBe(1);
  const refresh = page.getByRole("button", {
    name: "Refresh Launchpad and check updates",
    exact: true,
  });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(current.getByText("Update check unavailable")).toBeVisible();
  await expect(current.getByText("Up to date", { exact: true })).toHaveCount(0);
  await expect(
    current.getByText("Fixture provider gateway offline.", { exact: true }),
  ).toBeVisible();
  const verified = page.getByRole("article", {
    name: "Verified Update",
    exact: true,
  });
  await expect(
    verified.getByRole("button", {
      name: "Update Verified Update",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(verified.getByText("Update check unavailable")).toBeVisible();
  await expect(refresh).toBeEnabled();
  expect(onlineReads).toBe(2);
});

test("installed content tabs retain their own snapshots and ignore late responses for another type", async ({
  page,
}) => {
  await catalog(page);
  const mod = installed("Known Mod");
  const datapack = {
    ...installed("Datapack"),
    path: "world/datapacks/pack.zip",
  };
  let staleDatapack: Route | undefined;
  let heldMods: Route | undefined;
  let modReads = 0;
  await page.route("**/api/launchpad/installed?**", (route) => {
    const url = new URL(route.request().url());
    const local = url.searchParams.has("local");
    if (url.searchParams.get("type") === "datapack") {
      if (!local) {
        staleDatapack = route;
        return;
      }
      return route.fulfill({ json: { items: [datapack], warnings: [] } });
    }
    if (local && ++modReads === 2) {
      heldMods = route;
      return;
    }
    return route.fulfill({ json: { items: [mod], warnings: [] } });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await expect(
    page.getByRole("article", { name: "Known Mod", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", {
      name: "Installed content refresh",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Datapacks", exact: true }).click();
  await expect.poll(() => Boolean(staleDatapack)).toBe(true);
  await expect(
    page.getByRole("article", { name: "Datapack", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Mods", exact: true }).click();
  await expect.poll(() => Boolean(heldMods)).toBe(true);
  await expect(
    page.getByRole("article", { name: "Known Mod", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await staleDatapack!
    .fulfill({
      json: {
        items: [{ ...datapack, title: "Stale datapack result" }],
        warnings: ["Stale warning"],
      },
    })
    .catch(() => {});
  await heldMods!.fulfill({ json: { items: [mod], warnings: [] } });
  await expect(
    page.getByRole("status", {
      name: "Installed content refresh",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("article", { name: "Known Mod", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Stale datapack result", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Stale warning", { exact: true })).toHaveCount(0);
});

test("installed project buttons resolve older panel responses without metadata URLs", async ({
  page,
}) => {
  await catalog(page);
  const items = [
    { ...installed("Alpha"), url: undefined },
    { ...installed("238222", "curseforge"), title: "JEI", url: undefined },
    {
      ...installed("Unknown"),
      platform: null,
      projectId: undefined,
      update: undefined,
      url: undefined,
    },
  ];
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items, warnings: [] } }),
  );
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await expect(
    page.getByRole("link", { name: "Open Alpha project page" }),
  ).toHaveAttribute("href", "https://modrinth.com/project/Alpha");
  await expect(
    page.getByRole("link", { name: "Open JEI project page" }),
  ).toHaveAttribute("href", "https://www.curseforge.com/projects/238222");
  await expect(
    page.getByRole("link", { name: "Open Unknown project page" }),
  ).toHaveCount(0);
  await page
    .getByRole("article", { name: "Alpha", exact: true })
    .getByRole("button", { name: "Update Alpha", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("link", { name: "Open project page" }),
  ).toHaveAttribute("href", "https://modrinth.com/project/Alpha");
});

test("installed project links and update-all review span platforms and retry the accepted download", async ({
  page,
}) => {
  await catalog(page);
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({
      json: {
        items: [installed("Alpha"), installed("Beta", "curseforge")],
        warnings: [],
      },
    }),
  );
  let updates: unknown,
    installs: unknown[] = [];
  await page.route("**/api/launchpad/updates/preview", (route) => {
    updates = route.request().postDataJSON();
    return route.fulfill({ json: plan });
  });
  const retryInput = { planId: "review", confirmed: true };
  await page.route("**/api/launchpad/install", (route) => {
    installs.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        job:
          installs.length === 1
            ? {
                id: "job",
                status: "failed",
                message: "Download stalled",
                completed: 1,
                total: 2,
                retryable: true,
                retryInput,
              }
            : {
                id: "job-retry",
                status: "completed",
                message: "Installed",
                completed: 2,
                total: 2,
              },
      },
    });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await expect(
    page.getByRole("link", { name: "Open Alpha project page" }),
  ).toHaveAttribute("href", "https://modrinth.com/project/Alpha");
  await expect(
    page.getByRole("link", { name: "Open Beta project page" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Platform", exact: true }),
  ).toHaveValue("all");
  await expect(
    page.getByRole("combobox", { name: "Minecraft version", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Loader", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Update all", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Review installation" }),
  ).toBeVisible();
  expect(updates).toMatchObject({
    updates: [
      { platform: "modrinth", replacePath: "mods/Alpha.jar" },
      { platform: "curseforge", replacePath: "mods/Beta.jar" },
    ],
  });
  await page
    .getByRole("button", { name: "Confirm installation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry download", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "Installation status", exact: true }),
  ).toContainText("Installation completed");
  expect(installs).toEqual([retryInput, retryInput]);
});

test("unreadable removal dependencies require acknowledgement before confirmation", async ({
  page,
}) => {
  await catalog(page);
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [installed("Alpha")], warnings: [] } }),
  );
  await page.route("**/api/launchpad/removal-preview", (route) =>
    route.fulfill({
      json: {
        planId: "removal",
        title: "Alpha",
        files: [{ path: "mods/Alpha.jar", size: 100 }],
        warnings: ["mods/broken.jar: unreadable metadata"],
        dependents: [],
        blocked: false,
        requiresAcknowledgement: true,
      },
    }),
  );
  let body: unknown;
  await page.route("**/api/launchpad/remove", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/#launchpad");
  await page.getByRole("switch", { name: "Show installed content" }).check();
  await page.getByRole("button", { name: "Remove Alpha", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Remove mod", exact: true });
  const remove = dialog.getByRole("button", {
    name: "Remove mod",
    exact: true,
  });
  await expect(remove).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: /unreadable dependencies/ })
    .check();
  await remove.click();
  await expect(dialog).not.toBeVisible();
  expect(body).toEqual({
    planId: "removal",
    confirmed: true,
    acknowledgedUnreadableDependencies: true,
  });
});

test("modpack installation waits for the requested backup and stops on backup failure", async ({
  page,
}) => {
  await catalog(page, "modpack");
  await page.route("**/api/launchpad/installed?**", (route) =>
    route.fulfill({ json: { items: [], warnings: [] } }),
  );
  await page.route("**/api/launchpad/preview", (route) =>
    route.fulfill({
      json: { ...plan, cleanInstall: true, hasExistingContent: true },
    }),
  );
  const calls: string[] = [];
  let fail = true;
  await page.route("**/api/backups", (route) => {
    calls.push("backup");
    return route.fulfill(
      fail
        ? { status: 409, json: { error: "Backup destination unavailable" } }
        : { status: 201, json: { ok: true } },
    );
  });
  await page.route("**/api/launchpad/install", (route) => {
    calls.push("install");
    return route.fulfill({
      json: {
        job: {
          id: "pack",
          status: "completed",
          message: "Installed",
          completed: 1,
          total: 1,
          recoveryEntries: [{ id: "old", path: "world" }],
        },
      },
    });
  });
  await page.goto("/#launchpad");
  await page.getByRole("button", { name: "Install Pack", exact: true }).click();
  await page
    .getByRole("button", { name: "Review installation", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Review installation" });
  await expect(dialog).toContainText("will move to Recycle Bin");
  await dialog
    .getByRole("checkbox", { name: /I understand this replaces/ })
    .check();
  await dialog.getByRole("checkbox", { name: "Create a backup first" }).check();
  await dialog.getByRole("button", { name: "Confirm installation" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Backup destination unavailable",
  );
  expect(calls).toEqual(["backup"]);
  fail = false;
  await dialog.getByRole("button", { name: "Confirm installation" }).click();
  await expect(dialog).not.toBeVisible();
  expect(calls).toEqual(["backup", "backup", "install"]);
  await page
    .getByRole("link", { name: "View replaced files in Recycle Bin" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Recycle Bin", exact: true }),
  ).toBeVisible();
});
