import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";
import { removeTestServer } from "./server-fixtures";

type Server = { id: string; name: string; mode: string; status: string };
type SetupFixture = {
  created: Server[];
  creationRequests: Record<string, unknown>[];
  mutations: string[];
  catalogRequests: string[];
  javaRequests: URLSearchParams[];
  preflightRequests: Record<string, unknown>[];
  port: number;
};

const java = {
  available: true,
  majorVersion: 21,
  version: "21.0.7",
  path: "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.8.9-hotspot\\bin\\java.exe",
};
const staleJavaPath =
  "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5.11-hotspot\\bin\\java.exe";
const alternateJavaPath =
  "C:\\Program Files\\Microsoft\\jdk-21.0.7\\bin\\java.exe";
const javaInstallations = [
  {
    path: java.path,
    version: "21.0.8",
    majorVersion: 21,
    vendor: "Eclipse Adoptium",
    architecture: "amd64",
  },
  {
    path: alternateJavaPath,
    version: "21.0.7",
    majorVersion: 21,
    vendor: "Microsoft",
    architecture: "amd64",
  },
];
const javaCatalog = {
  installations: javaInstallations,
  recommendedPath: java.path,
  detectedCount: 3,
  requiredJavaVersion: 21,
  requirement: "Java 21",
  warnings: [],
};
const provider = {
  id: "paper",
  name: "Paper",
  description: "Minecraft server with plugin support",
  website: "https://papermc.io",
  installable: true,
  kind: "server",
};
const release = { id: "1.21.1", label: "1.21.1", stable: true };
const build = {
  id: "151",
  label: "151",
  stable: true,
  recommended: true,
  javaVersion: 21,
};
const modpack = {
  id: "test-adventures",
  platform: "modrinth",
  title: "Test Adventures",
  description: "A server-ready adventure pack for the onboarding fixture.",
  author: "Fixture author",
  downloads: 12500,
};
const packVersion = {
  id: "pack-release-2",
  name: "Test Adventures 2.0",
  version: "2.0",
  gameVersions: ["1.21.1"],
  loaders: ["fabric"],
  publishedAt: "2026-09-01T00:00:00Z",
  downloadable: true,
};
const platforms = [
  {
    id: "modrinth",
    name: "Modrinth",
    available: true,
    types: ["modpack"],
    sortOptions: [{ id: "relevance", label: "Relevance" }],
  },
];

const test = base.extend<{ setup: SetupFixture }>({
  setup: async ({ page, request }, use) => {
    const fleet = await (await request.get("/api/servers")).json();
    let port = 28100;
    while (
      fleet.servers.some((server: { port: number }) => server.port === port)
    )
      port++;
    const state: SetupFixture = {
      created: [],
      creationRequests: [],
      mutations: [],
      catalogRequests: [],
      javaRequests: [],
      preflightRequests: [],
      port,
    };
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        request.method() !== "GET" &&
        (pathname === "/api/servers" ||
          pathname === "/api/server-setup" ||
          /\/install$|\/power$/.test(pathname))
      )
        state.mutations.push(pathname);
      if (
        request.method() === "GET" &&
        pathname.startsWith("/api/server-setup")
      ) {
        state.catalogRequests.push(pathname);
        expect(request.headers()["x-server-id"]).toBeUndefined();
      }
    });
    // Hide only the shared test default; keep all real fixture files untouched.
    await page.route("**/api/servers", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const body = await (await route.fetch()).json();
      const servers = body.servers.filter((server: Server) =>
        state.created.some((created) => created.id === server.id),
      );
      await route.fulfill({
        json: { servers, defaultServerId: servers[0]?.id ?? null },
      });
    });
    await page.route("**/api/server-setup", async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: {
            providers: [provider],
            platforms,
            gameVersions: ["1.21.1"],
            loaders: ["fabric", "neoforge"],
            hostMemoryMB: 16384,
            freeMemoryMB: 12288,
            suggestedMemoryMB: 4096,
            java: { ...java, path: staleJavaPath },
            warnings: [],
          },
        });
      state.creationRequests.push(route.request().postDataJSON());
      const response = await route.fetch();
      const body = await response.json();
      if (response.ok() && !state.created.some((s) => s.id === body.server.id))
        state.created.push(body.server);
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/server-setup/java?**", (route) => {
      state.javaRequests.push(new URL(route.request().url()).searchParams);
      return route.fulfill({ json: javaCatalog });
    });
    await page.route("**/api/server-setup/preflight", (route) => {
      const body = route.request().postDataJSON();
      state.preflightRequests.push(body);
      return route.fulfill({
        json: {
          hostMemoryMB: 16384,
          freeMemoryMB: 12288,
          suggestedMemoryMB: 4096,
          memoryLimitMB: 4096,
          requiredJavaVersion: 21,
          compatible: true,
          ready: true,
          java: { ...java, path: body.javaPath },
          warnings: [],
        },
      });
    });
    await page.route("**/api/server-setup/versions", (route) =>
      route.fulfill({
        json: { providers: [provider], job: null, current: null },
      }),
    );
    await page.route("**/api/server-setup/versions/paper", (route) =>
      route.fulfill({ json: { versions: [release] } }),
    );
    await page.route("**/api/server-setup/versions/paper/1.21.1", (route) =>
      route.fulfill({ json: { builds: [build] } }),
    );
    try {
      await use(state);
    } finally {
      for (const server of state.created)
        await removeTestServer(request, server.id);
    }
  },
});

async function openCreate(page: Page, screenshots?: TestInfo) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel", exact: true }),
  ).toBeVisible();
  if (screenshots)
    await page.screenshot({
      path: screenshots.outputPath("welcome-desktop.png"),
      fullPage: true,
    });
  await page
    .getByRole("button", { name: "Create a new server", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Server software", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Modpack", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Advanced setup", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("button", { name: "Create an empty server", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("combobox", { name: "Mode", exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByText(/demo/i)).toHaveCount(0);
  if (screenshots)
    await page.screenshot({
      path: screenshots.outputPath("setup-source-desktop.png"),
      fullPage: true,
    });
  return dialog;
}

async function choosePaper(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Server software", exact: true })
    .click();
  await dialog.getByRole("button", { name: /Paper/ }).click();
  await dialog
    .getByRole("combobox", { name: "Minecraft version", exact: true })
    .selectOption("1.21.1");
  await expect(
    dialog
      .getByRole("combobox", { name: "Build", exact: true })
      .locator('option[value=""]'),
  ).toHaveJSProperty("disabled", true);
  await expect(
    dialog.getByRole("combobox", { name: "Build", exact: true }),
  ).toHaveValue("");
  await expect(
    dialog.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("combobox", { name: "Build", exact: true })
    .selectOption("151");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
}

async function configure(
  page: Page,
  state: SetupFixture,
  name: string,
  selectedJavaMajor = 21,
) {
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("combobox", { name: "Java executable", exact: true }),
  ).toHaveValue(String(selectedJavaMajor));
  await dialog.getByLabel("Server name", { exact: true }).fill(name);
  await dialog.getByLabel("Memory (GB)", { exact: true }).fill("4");
  await dialog.getByText("Advanced settings", { exact: true }).click();
  await dialog
    .getByLabel("Server port", { exact: true })
    .fill(String(state.port));
  await dialog
    .getByRole("button", { name: "Review installation", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Create and install", exact: true }),
  ).toBeDisabled();
  expect(state.created).toEqual([]);
  expect(state.mutations).toEqual([]);
  await dialog
    .getByRole("checkbox", {
      name: "I agree to the Minecraft EULA",
      exact: true,
    })
    .check();
  await expect(
    dialog.getByRole("button", { name: "Create and install", exact: true }),
  ).toBeEnabled();
  return dialog;
}

async function assertStopped(request: APIRequestContext, serverId: string) {
  const response = await request.get("/api/server", {
    headers: { "X-Server-Id": serverId },
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    status: "offline",
    mode: "live",
  });
  const eula = await request.get("/api/files/content?path=eula.txt", {
    headers: { "X-Server-Id": serverId },
  });
  expect(eula.ok()).toBe(true);
  expect((await eula.json()).content).toMatch(/^eula=true\s*$/m);
}

test("Welcome opens the import folder workflow directly and cancelling preserves the empty state", async ({
  page,
  setup,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Import an existing server", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Import an existing server",
    exact: true,
  });
  await expect(
    dialog.getByLabel("Server folder", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Inspect folder", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel", exact: true }),
  ).toBeVisible();
  expect(setup.created).toEqual([]);
  expect(setup.mutations).toEqual([]);
  expect(setup.catalogRequests).toEqual([]);
});

test("software builds require an explicit choice and reset after changing Minecraft or software", async ({
  page,
  setup,
}) => {
  await page.route("**/api/server-setup/versions/paper", (route) =>
    route.fulfill({
      json: {
        versions: [release, { id: "1.20.1", label: "1.20.1", stable: true }],
      },
    }),
  );
  await page.route("**/api/server-setup/versions/paper/1.20.1", (route) =>
    route.fulfill({
      json: { builds: [{ ...build, id: "196", label: "196" }] },
    }),
  );
  const dialog = await openCreate(page);
  await dialog
    .getByRole("button", { name: "Server software", exact: true })
    .click();
  await dialog.getByRole("button", { name: /Paper/ }).click();
  const builds = dialog.getByRole("combobox", { name: "Build", exact: true });
  const versions = dialog.getByRole("combobox", {
    name: "Minecraft version",
    exact: true,
  });
  const next = dialog.getByRole("button", { name: "Continue", exact: true });
  await expect(builds).toBeEnabled();
  await expect(builds).toHaveValue("");
  await expect(builds.locator('option[value=""]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(next).toBeDisabled();
  await builds.selectOption("151");
  await expect(next).toBeEnabled();
  await versions.selectOption("1.20.1");
  await expect(builds.locator('option[value="196"]')).toHaveCount(1);
  await expect(builds).toHaveValue("");
  await expect(next).toBeDisabled();
  await builds.selectOption("196");
  await expect(next).toBeEnabled();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByRole("button", { name: /Paper/ }).click();
  await expect(builds.locator('option[value="151"]')).toHaveCount(1);
  await expect(builds).toHaveValue("");
  await expect(next).toBeDisabled();
  expect(setup.preflightRequests).toEqual([]);
  expect(setup.mutations).toEqual([]);
});

test("Java choices group duplicate installations by major and review uses the newest refreshed executable", async ({
  page,
  setup,
}) => {
  const newlyInstalled = {
    path: "C:\\Program Files\\Amazon Corretto\\jdk21.0.9_10\\bin\\java.exe",
    version: "21.0.9",
    majorVersion: 21,
    vendor: "Amazon.com Inc.",
    architecture: "amd64",
  };
  let refreshed = false;
  await page.route("**/api/server-setup/java?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    setup.javaRequests.push(params);
    refreshed ||= params.get("refresh") === "1";
    return route.fulfill({
      json: {
        ...javaCatalog,
        installations: refreshed
          ? [...javaInstallations, newlyInstalled]
          : javaInstallations,
        recommendedPath: refreshed ? newlyInstalled.path : alternateJavaPath,
      },
    });
  });
  await openCreate(page);
  await choosePaper(page);
  const dialog = page.getByRole("dialog");
  const chooser = dialog.getByRole("combobox", {
    name: "Java executable",
    exact: true,
  });
  await expect(chooser).toBeVisible();
  await expect(chooser).toHaveValue("21");
  expect(
    await chooser.locator("option").evaluateAll((options) =>
      options
        .filter((option) => !(option as HTMLOptionElement).disabled)
        .map((option) => ({
          value: (option as HTMLOptionElement).value,
          label: option.textContent,
        })),
    ),
  ).toEqual([{ value: "21", label: "JAVA 21" }]);
  await expect(dialog).not.toContainText(java.path);
  await expect(dialog).not.toContainText(alternateJavaPath);
  await expect(dialog).not.toContainText(staleJavaPath);
  expect(setup.javaRequests.at(-1)?.get("gameVersion")).toBe("1.21.1");
  expect(setup.javaRequests.at(-1)?.get("provider")).toBe("paper");
  expect(setup.javaRequests.at(-1)?.get("requiredJavaVersion")).toBe("21");
  await dialog
    .getByRole("button", { name: "Refresh Java", exact: true })
    .click();
  await expect(chooser.locator("option:not([disabled])")).toHaveCount(1);
  await expect(chooser).toHaveValue("21");
  await expect(chooser).toBeEnabled();
  await configure(page, setup, "Compatible Java world");
  expect(setup.preflightRequests.at(-1)).toMatchObject({
    javaPath: newlyInstalled.path,
    gameVersion: "1.21.1",
    requiredJavaVersion: 21,
  });
  expect(setup.created).toHaveLength(0);
});

test("missing compatible Java blocks review until a refreshed scan finds an installed runtime", async ({
  page,
  setup,
}) => {
  let refreshed = false;
  await page.route("**/api/server-setup/java?**", (route) => {
    refreshed ||=
      new URL(route.request().url()).searchParams.get("refresh") === "1";
    return route.fulfill({
      json: refreshed
        ? javaCatalog
        : {
            ...javaCatalog,
            installations: [],
            recommendedPath: null,
            detectedCount: 1,
            warnings: [
              "No installed Java runtime is compatible with this Minecraft version.",
            ],
          },
    });
  });
  await openCreate(page);
  await choosePaper(page);
  const dialog = page.getByRole("dialog");
  const chooser = dialog.getByRole("combobox", {
    name: "Java executable",
    exact: true,
  });
  await expect(chooser).toHaveValue("");
  await expect(chooser.locator('option[value=""]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(
    dialog.getByRole("button", { name: "Review installation", exact: true }),
  ).toBeDisabled();
  expect(setup.preflightRequests).toHaveLength(0);
  expect(setup.mutations).toHaveLength(0);
  await dialog
    .getByRole("button", { name: "Refresh Java", exact: true })
    .click();
  await expect(chooser).toHaveValue("21");
  await configure(page, setup, "New Java installation");
  expect(setup.preflightRequests).toHaveLength(1);
  expect(setup.preflightRequests[0].javaPath).toBe(java.path);
  expect(setup.created).toHaveLength(0);
});

test("missing Java can be installed with progress, then selected automatically for review", async ({
  page,
  setup,
}, testInfo) => {
  const managedJava = {
    ...javaInstallations[0],
    path: "C:\\MC Panel\\java-runtimes\\temurin-21\\bin\\java.exe",
  };
  let installed = false;
  let finish = false;
  const installRequests: Record<string, unknown>[] = [];
  const job = {
    id: "java-install-21",
    status: "running",
    message: "Downloading Java 21…",
    majorVersion: 21,
    downloadedBytes: 1024,
    totalBytes: 2048,
  };
  await page.route("**/api/server-setup/java?**", (route) =>
    route.fulfill({
      json: {
        ...javaCatalog,
        installations: installed ? [managedJava] : [],
        recommendedPath: installed ? managedJava.path : null,
        installSupported: true,
      },
    }),
  );
  await page.route("**/api/server-setup/java/install", (route) => {
    installRequests.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { job } });
  });
  await page.route("**/api/server-setup/java/jobs/*", (route) => {
    installed = finish;
    return route.fulfill({
      json: {
        job: installed
          ? {
              ...job,
              status: "completed",
              message: "Java 21 is ready.",
              java: managedJava,
            }
          : job,
      },
    });
  });
  await openCreate(page);
  await choosePaper(page);
  const dialog = page.getByRole("dialog");
  const review = dialog.getByRole("button", {
    name: "Review installation",
    exact: true,
  });
  await expect(review).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Install Java 21", exact: true })
    .click();
  await expect(
    dialog.getByRole("progressbar", { name: "Java download progress" }),
  ).toHaveAttribute("value", "1024");
  await expect(
    dialog.getByRole("button", { name: "Close add server", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Back", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("java-install-progress.png"),
    fullPage: true,
  });
  expect(installRequests).toEqual([
    { gameVersion: "1.21.1", provider: "paper", build: "151" },
  ]);
  finish = true;
  await expect(
    dialog.getByRole("combobox", { name: "Java executable", exact: true }),
  ).toHaveValue("21");
  await expect(dialog.getByRole("status")).toContainText("Java 21 is ready.");
  await expect(review).toBeEnabled();
  await review.click();
  await expect(
    dialog.getByRole("button", { name: "Create and install", exact: true }),
  ).toBeVisible();
  expect(setup.preflightRequests.at(-1)?.javaPath).toBe(managedJava.path);
  expect(setup.created).toEqual([]);
  expect(setup.mutations).toEqual(["/api/server-setup/java/install"]);
});

test("Java installation failures can be retried without selecting an unavailable runtime", async ({
  page,
  setup,
}) => {
  let attempts = 0;
  const job = {
    id: "java-retry",
    status: "failed",
    message: "Java download failed.",
    error: "Download interrupted. Try again.",
    majorVersion: 21,
    downloadedBytes: 0,
    totalBytes: null,
  };
  await page.route("**/api/server-setup/java?**", (route) =>
    route.fulfill({
      json: {
        ...javaCatalog,
        installations: [],
        recommendedPath: null,
        installSupported: true,
      },
    }),
  );
  await page.route("**/api/server-setup/java/install", (route) => {
    attempts++;
    return route.fulfill({ status: 202, json: { job } });
  });
  await openCreate(page);
  await choosePaper(page);
  const dialog = page.getByRole("dialog");
  const install = dialog.getByRole("button", {
    name: "Install Java 21",
    exact: true,
  });
  await install.click();
  await expect(dialog.getByRole("alert")).toContainText("Download interrupted");
  await expect(
    dialog.getByRole("button", { name: "Review installation", exact: true }),
  ).toBeDisabled();
  await expect(install).toBeEnabled();
  await install.click();
  await expect.poll(() => attempts).toBe(2);
  await expect(
    dialog.getByRole("button", { name: "Close add server", exact: true }),
  ).toBeEnabled();
  expect(setup.preflightRequests).toEqual([]);
  expect(setup.created).toEqual([]);
});

test("setup resumes an active Java download after reopening without submitting it twice", async ({
  page,
  setup,
}) => {
  let finished = false;
  let submissions = 0;
  const job = {
    id: "java-resume",
    status: "running",
    message: "Checking Java…",
    majorVersion: 21,
    downloadedBytes: 0,
    totalBytes: null,
  };
  await page.route("**/api/server-setup/java?**", (route) =>
    route.fulfill({
      json: {
        ...javaCatalog,
        installations: finished ? javaInstallations : [],
        recommendedPath: finished ? java.path : null,
        installSupported: true,
        installJob: { ...job, status: finished ? "completed" : "running" },
      },
    }),
  );
  await page.route("**/api/server-setup/java/install", (route) => {
    submissions++;
    return route.fulfill({ status: 202, json: { job } });
  });
  await page.route("**/api/server-setup/java/jobs/*", (route) => {
    finished = true;
    return route.fulfill({
      json: {
        job: { ...job, status: "completed", message: "Java 21 is ready." },
      },
    });
  });
  await openCreate(page);
  await choosePaper(page);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("combobox", { name: "Java executable", exact: true }),
  ).toHaveValue("21");
  await expect(
    dialog.getByRole("button", { name: "Review installation", exact: true }),
  ).toBeEnabled();
  expect(submissions).toBe(0);
  expect(setup.created).toEqual([]);
});

test("Java setup does not offer an unknown requirement or follow another release's download", async ({
  page,
  setup,
}) => {
  let known = false;
  const polls: string[] = [];
  await page.route("**/api/server-setup/java?**", (route) =>
    route.fulfill({
      json: {
        ...javaCatalog,
        installations: known ? javaInstallations : [],
        recommendedPath: known ? java.path : null,
        requiredJavaVersion: known ? 21 : null,
        requirement: known ? "Java 21" : "Java requirement unavailable",
        installSupported: true,
        installJob: {
          id: "other-java-download",
          status: "running",
          majorVersion: 8,
          message: "Downloading Java 8…",
          downloadedBytes: 0,
          totalBytes: null,
        },
      },
    }),
  );
  await page.route("**/api/server-setup/java/jobs/*", (route) => {
    polls.push(route.request().url());
    return route.fulfill({
      status: 500,
      json: { error: "Unrelated job must not be followed." },
    });
  });
  await openCreate(page);
  await choosePaper(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Java requirement unavailable");
  await expect(
    dialog.getByRole("button", { name: /Install Java/ }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Close add server", exact: true }),
  ).toBeEnabled();
  known = true;
  await dialog
    .getByRole("button", { name: "Refresh Java", exact: true })
    .click();
  await expect(
    dialog.getByRole("combobox", { name: "Java executable", exact: true }),
  ).toHaveValue("21");
  await expect(
    dialog.getByRole("button", { name: "Review installation", exact: true }),
  ).toBeEnabled();
  expect(polls).toEqual([]);
  expect(setup.created).toEqual([]);
});

test("software catalog errors retry and cancellation leaves the fleet empty", async ({
  page,
  setup,
}, testInfo) => {
  let attempts = 0;
  await page.route("**/api/server-setup/versions/paper", (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill({
          status: 503,
          json: { error: "The software catalog is temporarily unavailable." },
        })
      : route.fulfill({ json: { versions: [release] } });
  });
  const dialog = await openCreate(page, testInfo);
  await dialog
    .getByRole("button", { name: "Server software", exact: true })
    .click();
  await expect(dialog.getByRole("button", { name: /Paper/ })).toBeVisible();
  await expect
    .poll(() =>
      dialog.locator(".software-logo-paper").evaluate((image) => {
        const element = image as HTMLImageElement;
        return element.complete && element.naturalWidth > 0;
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("software-catalog-desktop.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: /Paper/ }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "temporarily unavailable",
  );
  await dialog.getByRole("button", { name: /Retry/ }).click();
  await dialog
    .getByRole("combobox", { name: "Minecraft version", exact: true })
    .selectOption("1.21.1");
  await dialog
    .getByRole("combobox", { name: "Build", exact: true })
    .selectOption("151");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog
    .getByLabel("Server name", { exact: true })
    .fill("Cancelled world");
  await dialog
    .getByRole("button", { name: "Close add server", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(attempts).toBe(2);
  expect(setup.created).toEqual([]);
  expect(setup.mutations).toEqual([]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Welcome to MC Panel", exact: true }),
  ).toBeVisible();
  expect(setup.catalogRequests).toContain(
    "/api/server-setup/versions/paper/1.21.1",
  );
});

test("confirmed software creation retries installation on the same stopped server and opens Console", async ({
  page,
  request,
  setup,
}, testInfo) => {
  const installs: { serverId?: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/versions/install", (route) => {
    installs.push({
      serverId: route.request().headers()["x-server-id"],
      body: route.request().postDataJSON(),
    });
    return route.fulfill({
      status: 202,
      json: { id: `install-${installs.length}`, state: "queued" },
    });
  });
  await page.route("**/api/versions/jobs/*", (route) => {
    expect(route.request().headers()["x-server-id"]).toBe(setup.created[0]?.id);
    const failed = route.request().url().endsWith("install-1");
    return route.fulfill({
      json: failed
        ? {
            id: "install-1",
            state: "failed",
            error: "Fixture download interrupted. Retry this installation.",
          }
        : {
            id: "install-2",
            state: "complete",
            message: "Paper installed successfully.",
          },
    });
  });
  await openCreate(page);
  await choosePaper(page);
  const dialog = await configure(page, setup, "Guided Paper world");
  await expect(dialog).toContainText("Paper");
  await expect(dialog).toContainText("1.21.1");
  await page.screenshot({
    path: testInfo.outputPath("software-install-review.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Create and install", exact: true })
    .click();
  await expect(
    dialog.getByRole("progressbar", {
      name: "Installation progress",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Fixture download interrupted");
  expect(setup.created).toHaveLength(1);
  await expect(
    page.getByRole("heading", { level: 1, name: "Console", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Retry installation", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Open Console", exact: true }),
  ).toBeEnabled();
  expect(setup.creationRequests.length).toBeGreaterThanOrEqual(1);
  expect(
    new Set(setup.creationRequests.map((body) => body.requestId)).size,
  ).toBe(1);
  expect(setup.creationRequests[0]).toMatchObject({
    confirmed: true,
    acceptedEula: true,
    configuration: {
      name: "Guided Paper world",
      memoryLimitMB: 4096,
      port: setup.port,
      mode: "live",
      javaPath: java.path,
    },
  });
  expect(installs).toHaveLength(2);
  for (const install of installs) {
    expect(install.serverId).toBe(setup.created[0].id);
    expect(install.body).toMatchObject({
      provider: "paper",
      version: "1.21.1",
      build: "151",
      confirmed: true,
      cleanInstall: true,
    });
  }
  expect(setup.mutations.some((url) => url.endsWith("/power"))).toBe(false);
  await assertStopped(request, setup.created[0].id);
  await dialog
    .getByRole("button", { name: "Open Console", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Console", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Guided Paper world", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Guided Paper world", exact: true }),
  ).toBeVisible();
});

test("mobile software review stays within the viewport and can be cancelled without creation", async ({
  page,
  setup,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCreate(page);
  await choosePaper(page);
  await expect(
    page.getByRole("combobox", { name: "Java executable", exact: true }),
  ).toHaveValue("21");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("guided-java-mobile.png"),
    fullPage: true,
  });
  const dialog = await configure(page, setup, "A mobile Minecraft world");
  await page.evaluate(() => document.fonts.ready);
  const dimensions = await dialog.boundingBox();
  expect(dimensions).not.toBeNull();
  expect(dimensions!.x).toBeGreaterThanOrEqual(0);
  expect(dimensions!.x + dimensions!.width).toBeLessThanOrEqual(391);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("guided-review-mobile.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Close add server", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(setup.mutations).toEqual([]);
  expect(setup.created).toEqual([]);
});

test("an accepted installation with a lost response recovers its completed job and refreshed server descriptor", async ({
  page,
  request,
  setup,
}) => {
  let accepted = false;
  let installationCalls = 0;
  const recoveryScopes: string[] = [];
  const descriptorRequests: number[] = [];
  await page.route("**/api/servers", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const fleet = await (await route.fetch()).json();
    const servers = fleet.servers
      .filter((server: Server) =>
        setup.created.some((created) => created.id === server.id),
      )
      .map((server: Server) =>
        accepted
          ? {
              ...server,
              software: "Paper",
              version: "151",
              minecraftVersion: "1.21.1",
            }
          : server,
      );
    if (accepted) descriptorRequests.push(Date.now());
    await route.fulfill({
      json: { servers, defaultServerId: servers[0]?.id ?? null },
    });
  });
  await page.route("**/api/versions/install", async (route) => {
    installationCalls++;
    expect(route.request().headers()["x-server-id"]).toBe(setup.created[0]?.id);
    accepted = true;
    await route.fulfill({
      status: 502,
      json: { error: "The installation response was lost." },
    });
  });
  await page.route("**/api/versions", async (route) => {
    recoveryScopes.push(route.request().headers()["x-server-id"]);
    await route.fulfill({
      json: {
        providers: [provider],
        job: {
          id: "accepted-install",
          state: "complete",
          message: "Paper installed successfully.",
        },
      },
    });
  });
  await openCreate(page);
  await choosePaper(page);
  const dialog = await configure(page, setup, "Recovered Paper world");
  await dialog
    .getByRole("button", { name: "Create and install", exact: true })
    .click();
  await expect(
    dialog.getByText("Installed and stopped", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Retry installation", exact: true }),
  ).toHaveCount(0);
  expect(setup.created).toHaveLength(1);
  expect(installationCalls).toBe(1);
  expect(recoveryScopes).toEqual([setup.created[0].id]);
  expect(descriptorRequests.length).toBeGreaterThan(0);
  await assertStopped(request, setup.created[0].id);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recovered Paper world", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Switch server", exact: true }),
  ).toHaveValue(setup.created[0].id);
  await expect(page.locator(".fleet-mode")).toContainText("Paper");
  expect(setup.mutations.some((url) => url.endsWith("/power"))).toBe(false);
});

test("modpack creation reviews an exact release and scopes runtime and pack installation to the new server", async ({
  page,
  request,
  setup,
}, testInfo) => {
  const originalFleet = await (await request.get("/api/servers")).json();
  const existingId = originalFleet.defaultServerId;
  const previousSettings = await (
    await request.get("/api/server", { headers: { "X-Server-Id": existingId } })
  ).json();
  // This case begins in an existing workspace to catch accidental use of its scope.
  await page.unroute("**/api/servers");
  await page.addInitScript(
    (id) => localStorage.setItem("mc-panel.active-server", id),
    existingId,
  );
  await page.route("**/api/server-setup/launchpad", (route) =>
    route.fulfill({
      json: {
        platforms,
        gameVersions: ["1.21.1"],
        loaders: ["fabric"],
        warnings: [],
      },
    }),
  );
  await page.route("**/api/server-setup/launchpad/search?**", (route) => {
    expect(new URL(route.request().url()).searchParams.get("type")).toBe(
      "modpack",
    );
    return route.fulfill({
      json: {
        projects: [modpack],
        total: 1,
        offset: 0,
        limit: 10,
        warnings: [],
      },
    });
  });
  await page.route("**/api/server-setup/launchpad/versions?**", (route) =>
    route.fulfill({ json: { versions: [packVersion] } }),
  );
  const plan = {
    planId: "pack-plan",
    title: modpack.title,
    versionName: packVersion.name,
    expiresAt: "2099-01-01T00:00:00Z",
    files: [{ path: "mods/adventures.jar", size: 2048, action: "install" }],
    warnings: [],
    cleanInstall: true,
    summary: { fileCount: 1, totalBytes: 2048 },
    runtime: {
      provider: "fabric",
      version: "1.21.1",
      build: "0.16.10",
      software: "Fabric",
    },
    loaderInstall: {
      loader: "fabric",
      gameVersion: "1.21.1",
      loaderVersion: "0.16.10",
    },
  };
  await page.route("**/api/server-setup/modpack-preview", (route) =>
    route.fulfill({ json: plan }),
  );
  const scopedRequests: {
    path: string;
    serverId?: string;
    body?: Record<string, unknown>;
  }[] = [];
  const capture = (route: Route) =>
    scopedRequests.push({
      path: new URL(route.request().url()).pathname,
      serverId: route.request().headers()["x-server-id"],
      body:
        route.request().method() === "POST"
          ? route.request().postDataJSON()
          : undefined,
    });
  await page.route("**/api/launchpad/preview", (route) => {
    capture(route);
    return route.fulfill({ json: plan });
  });
  await page.route("**/api/server-setup/versions/fabric/1.21.1", (route) => {
    return route.fulfill({
      json: { builds: [{ id: "0.16.10", label: "0.16.10", stable: true }] },
    });
  });
  await page.route("**/api/versions/install", (route) => {
    capture(route);
    return route.fulfill({
      status: 202,
      json: {
        id: "loader-install",
        state: "complete",
        message: "Fabric installed.",
      },
    });
  });
  await page.route("**/api/launchpad/install", (route) => {
    capture(route);
    return route.fulfill({
      status: 202,
      json: {
        job: {
          id: "pack-install",
          status: "completed",
          completed: 1,
          total: 1,
          message: "Modpack installed.",
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create a new server", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Modpack", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: /Test Adventures/ }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("modpack-catalog-desktop.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: /Test Adventures/ }).click();
  await dialog
    .getByRole("combobox", { name: "Modpack version", exact: true })
    .selectOption(packVersion.id);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await configure(page, setup, "Guided adventure pack");
  await expect(dialog).toContainText("Test Adventures");
  await expect(dialog).not.toContainText("mods/adventures.jar");
  await expect(
    dialog.getByRole("list", { name: "Modpack installation files" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("modpack-install-review.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Create and install", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Open Console", exact: true }),
  ).toBeEnabled();
  expect(setup.created).toHaveLength(1);
  expect(scopedRequests.length).toBeGreaterThanOrEqual(2);
  for (const call of scopedRequests) {
    expect(call.serverId).toBe(setup.created[0].id);
    expect(call.serverId).not.toBe(existingId);
  }
  expect(
    scopedRequests.find((call) => call.path === "/api/versions/install")?.body,
  ).toBeUndefined();
  expect(
    scopedRequests.find((call) => call.path === "/api/launchpad/install")?.body,
  ).toMatchObject({ planId: plan.planId, confirmed: true, cleanInstall: true });
  expect(setup.mutations.some((url) => url.endsWith("/power"))).toBe(false);
  await assertStopped(request, setup.created[0].id);
  const currentSettings = await (
    await request.get("/api/server", { headers: { "X-Server-Id": existingId } })
  ).json();
  expect(currentSettings).toMatchObject({
    name: previousSettings.name,
    mode: previousSettings.mode,
    status: previousSettings.status,
  });
  const currentFleet = await (await request.get("/api/servers")).json();
  const originalServer = originalFleet.servers.find(
    (server: Server) => server.id === existingId,
  );
  expect(
    currentFleet.servers.find((server: Server) => server.id === existingId),
  ).toMatchObject({
    memoryLimitMB: originalServer.memoryLimitMB,
    port: originalServer.port,
    jar: originalServer.jar,
  });
  await dialog
    .getByRole("button", { name: "Open Console", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Switch server", exact: true }),
  ).toHaveValue(setup.created[0].id);
  await expect(
    page.getByRole("heading", { name: "Guided adventure pack", exact: true }),
  ).toBeVisible();
});
