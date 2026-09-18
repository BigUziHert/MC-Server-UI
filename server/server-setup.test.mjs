import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createFleet } from "./index.mjs";
import { probeJava } from "./server-setup.mjs";
import { createLaunchpad } from "./launchpad.mjs";
import { validateStartupFiles } from "./import.mjs";

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const java = {
  path: "java",
  available: true,
  version: "21.0.4",
  majorVersion: 21,
};
const configuration = {
  name: "Guided server",
  mode: "live",
  port: 25565,
  memoryLimitMB: 4096,
  javaPath: "java",
};
const requestBody = (extra = {}) => ({
  requestId: randomUUID(),
  confirmed: true,
  configuration,
  ...extra,
});
const versionService = () => ({
  listProviders: () => [{ id: "paper", name: "Paper", installable: true }],
  versions: async () => ({ versions: [{ id: "1.21.1", stable: true }] }),
  builds: async () => ({
    builds: [{ id: "12", stable: true, javaVersion: 21 }],
  }),
  stage: async (_input, { stageDir }) => {
    await fs.writeFile(
      path.join(stageDir, "server.jar"),
      "verified runtime fixture",
    );
    return {
      stageDir,
      files: [{ path: "server.jar" }],
      configuration: {
        jar: "server.jar",
        software: "Paper",
        version: "1.21.1",
      },
      summary: { provider: "paper", version: "1.21.1", build: "12" },
    };
  },
});
async function fixture(t, options = {}) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "mc-setup-test-"));
  let fleet, listener;
  const start = async () => {
    fleet = await createFleet({
      dataDir: root,
      createDefaultServer: false,
      useEnvironment: false,
      scheduler: false,
      publicAddress: { resolve: async () => null },
      javaProbe: async () => java,
      totalMemory: () => 16 * 1024 ** 3,
      freeMemory: () => 8 * 1024 ** 3,
      versionsService: versionService(),
      catalogFetch: async (url) => {
        if (String(url).endsWith("/tag/game_version"))
          return Response.json([
            { version: "1.21.1", version_type: "release" },
          ]);
        throw new Error(`Unexpected catalog request: ${url}`);
      },
      ...options,
    });
    listener = await new Promise((resolve) => {
      const listening = fleet.app.listen(0, "127.0.0.1", () =>
        resolve(listening),
      );
    });
  };
  const close = async () => {
    await fleet.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  };
  await start();
  t.after(async () => {
    await close();
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-setup-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    get runtimes() {
      return fleet.runtimes;
    },
    restart: async () => {
      await close();
      await start();
    },
    request: async (route, init = {}, id) => {
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}${route}`,
        {
          ...init,
          headers: {
            "Content-Type": "application/json",
            ...(id ? { "X-Server-Id": id } : {}),
            ...init.headers,
          },
        },
      );
      return { status: response.status, body: await response.json() };
    },
  };
}

test("empty fleet catalogs expose every Launchpad platform without creating a server or workspace", async (t) => {
  const f = await fixture(t);
  const before = await fs.readdir(f.root);
  const config = await f.request(
    "/api/server-setup",
    {},
    "nonexistent-selection",
  );
  assert.equal(config.status, 200);
  assert.deepEqual(config.body.gameVersions, ["1.21.1"]);
  assert.equal(config.body.hostMemoryMB, 16384);
  assert.equal(config.body.java.available, true);
  assert.equal(config.body.managedServersDir, path.join(f.root, "instances"));
  for (const id of [
    "modrinth",
    "curseforge",
    "ftb",
    "atlauncher",
    "voidswrath",
    "spigot",
  ])
    assert.ok(
      config.body.platforms.some((platform) => platform.id === id),
      id,
    );
  assert.equal(
    (await f.request("/api/server-setup/versions/paper/1.21.1")).body.builds[0]
      .id,
    "12",
  );
  assert.equal(
    (await f.request("/api/server-setup/versions/paper")).body.versions[0].id,
    "1.21.1",
  );
  assert.equal((await f.request("/api/servers")).body.servers.length, 0);
  assert.deepEqual(await fs.readdir(f.root), before);
});

test("desktop setup discovers OS JAVA_HOME without importing legacy server environment", async (t) => {
  const previous = {
    JAVA_HOME: process.env.JAVA_HOME,
    MC_SERVER_NAME: process.env.MC_SERVER_NAME,
    JAVA_PATH: process.env.JAVA_PATH,
  };
  process.env.JAVA_HOME = path.join(os.tmpdir(), "Setup Java Home");
  process.env.JAVA_PATH = "legacy-config-must-not-win";
  process.env.MC_SERVER_NAME = "Do not import this server";
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  let probed;
  const f = await fixture(t, {
    javaProbe: async (javaPath) => {
      probed = javaPath;
      return { ...java, path: javaPath };
    },
  });
  const config = await f.request("/api/server-setup");
  assert.equal(config.status, 200);
  assert.equal(
    probed,
    path.join(
      process.env.JAVA_HOME,
      "bin",
      process.platform === "win32" ? "java.exe" : "java",
    ),
  );
  assert.equal((await f.request("/api/servers")).body.servers.length, 0);
  assert.equal(
    (
      await f.request(
        "/api/server-setup/preflight",
        json("POST", { javaPath: "explicit-java", memoryLimitMB: 4096 }),
      )
    ).body.java.path,
    "explicit-java",
  );
});

test("catalog-only Launchpad exposes no install or file-management methods and never touches storage", async () => {
  const catalog = await createLaunchpad({
    catalogOnly: true,
    safePath: () => assert.fail("Catalog-only services must not touch storage"),
    getServer: async () => ({ status: "offline" }),
    fetch: async () => Response.json([]),
  });
  assert.deepEqual(Object.keys(catalog).sort(), [
    "close",
    "config",
    "search",
    "settings",
    "versions",
  ]);
  assert.equal((await catalog.config()).job, null);
  await catalog.close();
});

test("abandoning a scratch pack review aborts its archive download and removes every temporary file", async (t) => {
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  let cancelled = false;
  const f = await fixture(t, {
    extraProviders: [
      {
        id: "fixturepack",
        name: "Fixture pack",
        types: ["modpack"],
        available: true,
        downloadHosts: ["cdn.modrinth.com"],
        resolve: async () => ({
          title: "Fixture",
          versionName: "1",
          archive: {
            format: "server-zip",
            url: "https://cdn.modrinth.com/slow.zip",
            size: 10,
            hashes: { sha512: "a".repeat(128) },
          },
        }),
      },
    ],
    catalogFetch: async (_url, init) => {
      began();
      return new Promise((_resolve, reject) => {
        const abort = () => {
          cancelled = true;
          reject(init.signal.reason);
        };
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = f.request("/api/server-setup/modpack-preview", {
    ...json("POST", {
      platform: "fixturepack",
      type: "modpack",
      projectId: "pack",
      versionId: "1",
      gameVersion: "1.21.1",
      loader: "neoforge",
    }),
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending, /abort/i);
  await started;
  controller.abort();
  await rejected;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      cancelled &&
      !(await fs.readdir(f.root)).some((name) =>
        name.startsWith("setup-preview-"),
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(cancelled, true);
  assert.deepEqual(await fs.readdir(f.root), ["servers.json"]);
  assert.equal((await f.request("/api/servers")).body.servers.length, 0);
});

test("failed guided registry persistence publishes neither the server nor its idempotency fingerprint", async (t) => {
  const f = await fixture(t);
  const registryPath = path.join(f.root, "servers.json");
  const before = await fs.readFile(registryPath, "utf8");
  const rename = fs.rename;
  const failure = t.mock.method(fs, "rename", async (source, target) => {
    if (target === registryPath)
      throw Object.assign(new Error("Fixture registry unavailable"), {
        status: 503,
      });
    return rename(source, target);
  });
  const body = requestBody({ acceptedEula: true });
  assert.equal(
    (await f.request("/api/server-setup", json("POST", body))).status,
    503,
  );
  assert.equal(await fs.readFile(registryPath, "utf8"), before);
  assert.equal(f.runtimes.size, 0);
  failure.mock.restore();
  const created = await f.request("/api/server-setup", json("POST", body));
  assert.equal(created.status, 201);
  assert.equal(
    (await f.request("/api/server-setup", json("POST", body))).body.server.id,
    created.body.server.id,
  );
  assert.equal((await f.request("/api/servers")).body.servers.length, 1);
  assert.match(
    await fs.readFile(
      path.join(created.body.server.serverDir, "eula.txt"),
      "utf8",
    ),
    /eula=true/,
  );
});

test("guided memory reaches Java argument launchers and packs preserve installed runtime files", async (t) => {
  const versionsService = versionService();
  versionsService.stage = async (_input, { stageDir }) => {
    await fs.mkdir(path.join(stageDir, "libraries"));
    const files = {
      "server.jar": "verified runtime",
      "libraries/runtime_args.txt": "-jar server.jar\n",
      "user_jvm_args.txt": "-Xmx12G\n",
    };
    for (const [name, bytes] of Object.entries(files))
      await fs.writeFile(path.join(stageDir, name), bytes);
    return {
      stageDir,
      files: Object.keys(files).map((name) => ({
        path: name,
        ...(name === "user_jvm_args.txt" ? { preserveExisting: true } : {}),
      })),
      configuration: {
        launchType: "java-args",
        jar: "",
        launchArgs: [
          "@user_jvm_args.txt",
          "@libraries/runtime_args.txt",
          "nogui",
        ],
        software: "NeoForge",
        version: "21.1.200",
      },
      summary: { provider: "neoforge", version: "1.21.1", build: "21.1.200" },
    };
  };
  const payload = Buffer.from("new pack content");
  const paths = [
    "mods/fixture.jar",
    "user_jvm_args.txt",
    "libraries/runtime_args.txt",
    "server.jar",
  ];
  const f = await fixture(t, {
    versionsService,
    extraProviders: [
      {
        id: "fixturepack",
        name: "Fixture pack",
        types: ["modpack"],
        available: true,
        downloadHosts: ["cdn.modrinth.com"],
        resolve: async () => ({
          title: "Fixture",
          versionName: "1",
          files: paths.map((name) => ({
            path: name,
            url: "https://cdn.modrinth.com/fixture.jar",
            size: payload.length,
            hashes: {
              sha512: createHash("sha512").update(payload).digest("hex"),
            },
          })),
        }),
      },
    ],
    catalogFetch: async () => new Response(payload),
  });
  const created = await f.request(
    "/api/server-setup",
    json(
      "POST",
      requestBody({ configuration: { ...configuration, memoryLimitMB: 6144 } }),
    ),
  );
  const { id, serverDir } = created.body.server;
  const queued = await f.request(
    "/api/versions/install",
    json("POST", {
      provider: "neoforge",
      version: "1.21.1",
      build: "21.1.200",
      confirmed: true,
    }),
    id,
  );
  let runtimeJob;
  for (let attempt = 0; attempt < 200; attempt++) {
    runtimeJob = (
      await f.request(`/api/versions/jobs/${queued.body.id}`, {}, id)
    ).body;
    if (["failed", "complete"].includes(runtimeJob.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(runtimeJob.state, "complete", JSON.stringify(runtimeJob));
  const detected = await validateStartupFiles(serverDir, {
    launchType: "java-args",
    launchArgs: ["@user_jvm_args.txt", "@libraries/runtime_args.txt", "nogui"],
  });
  assert.equal(detected.memoryLimitMB, 6144);
  const reviewed = await f.request(
    "/api/launchpad/preview",
    json("POST", {
      platform: "fixturepack",
      type: "modpack",
      projectId: "pack",
      versionId: "1",
      gameVersion: "1.21.1",
      loader: "neoforge",
    }),
    id,
  );
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.deepEqual(
    reviewed.body.files.map((file) => file.path),
    ["mods/fixture.jar"],
  );
  for (const name of paths.slice(1))
    assert.ok(reviewed.body.warnings.some((warning) => warning.includes(name)));
  const installed = await f.request(
    "/api/launchpad/install",
    json("POST", { planId: reviewed.body.planId, confirmed: true }),
    id,
  );
  let packJob;
  for (let attempt = 0; attempt < 200; attempt++) {
    packJob = (
      await f.request(`/api/launchpad/jobs/${installed.body.job.id}`, {}, id)
    ).body.job;
    if (["failed", "completed"].includes(packJob.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(packJob.status, "completed", JSON.stringify(packJob));
  assert.match(
    await fs.readFile(path.join(serverDir, "user_jvm_args.txt"), "utf8"),
    /-Xmx6144M/,
  );
  assert.equal(
    await fs.readFile(
      path.join(serverDir, "libraries/runtime_args.txt"),
      "utf8",
    ),
    "-jar server.jar\n",
  );
  assert.equal(
    await fs.readFile(path.join(serverDir, "server.jar"), "utf8"),
    "verified runtime",
  );
});

test("guided creation is confirmed, idempotent across concurrent retries and restart, and leaves EULA off by default", async (t) => {
  let starts = 0;
  const f = await fixture(t, {
    spawnServer: () => {
      starts++;
      throw new Error("Must not start automatically");
    },
  });
  const body = requestBody();
  assert.equal(
    (
      await f.request(
        "/api/server-setup",
        json("POST", { ...body, confirmed: false }),
      )
    ).status,
    400,
  );
  assert.equal((await f.request("/api/servers")).body.servers.length, 0);
  const responses = await Promise.all(
    Array.from({ length: 3 }, () =>
      f.request("/api/server-setup", json("POST", body)),
    ),
  );
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 200, 201],
  );
  const server = responses[0].body.server;
  assert.equal(
    new Set(responses.map((response) => response.body.server.id)).size,
    1,
  );
  assert.equal(server.status, "offline");
  assert.match(
    await fs.readFile(path.join(server.serverDir, "eula.txt"), "utf8"),
    /eula=false/,
  );
  await f.restart();
  const retried = await f.request("/api/server-setup", json("POST", body));
  assert.equal(retried.status, 200);
  assert.equal(retried.body.server.id, server.id);
  assert.equal(retried.body.reused, true);
  assert.equal(
    (
      await f.request(
        "/api/server-setup",
        json("POST", { ...body, acceptedEula: true }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request(
        "/api/server-setup",
        json("POST", {
          ...body,
          configuration: { ...configuration, name: "Changed review" },
        }),
      )
    ).status,
    409,
  );
  assert.equal((await f.request("/api/servers")).body.servers.length, 1);
  assert.equal(starts, 0);
});

test("unavailable Java and an offline game-version service do not hide the software or platform catalogs", async (t) => {
  const f = await fixture(t, {
    javaProbe: async () => ({
      path: "java",
      available: false,
      version: null,
      majorVersion: null,
      error: "Java was not found.",
    }),
    catalogFetch: async () => {
      throw Object.assign(new Error("Catalog offline; retry later"), {
        status: 503,
      });
    },
  });
  const config = await f.request("/api/server-setup");
  assert.equal(config.status, 200);
  assert.equal(config.body.java.available, false);
  assert.equal(config.body.compatible, false);
  assert.ok(config.body.platforms.length >= 6);
  assert.equal(config.body.providers[0].id, "paper");
  assert.ok(
    config.body.warnings.some((warning) => warning.includes("Catalog offline")),
  );
  assert.ok(
    config.body.warnings.some((warning) =>
      warning.includes("Java was not found"),
    ),
  );
  assert.equal(
    (await f.request("/api/server-setup/preflight", json("POST", null))).status,
    400,
  );
  assert.equal((await f.request("/api/servers")).body.servers.length, 0);
});

test("explicit EULA acceptance and the new-server CurseForge key are persisted without exposing secrets", async (t) => {
  const f = await fixture(t);
  const settings = await f.request(
    "/api/server-setup/launchpad/settings",
    json("PUT", { curseforgeApiKey: "fixture-key" }),
  );
  assert.equal(settings.status, 200);
  assert.equal(
    settings.body.platforms.find((platform) => platform.id === "curseforge")
      .keyConfigured,
    true,
  );
  assert.ok(!JSON.stringify(settings.body).includes("fixture-key"));
  const created = await f.request(
    "/api/server-setup",
    json("POST", requestBody({ acceptedEula: true })),
  );
  assert.equal(created.status, 201);
  assert.match(
    await fs.readFile(
      path.join(created.body.server.serverDir, "eula.txt"),
      "utf8",
    ),
    /eula=true/,
  );
  const instanceDir = path.dirname(created.body.server.serverDir);
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(instanceDir, "catalog-settings.json"),
        "utf8",
      ),
    ).curseforgeApiKey,
    "fixture-key",
  );
  assert.equal(
    (
      await f.request("/api/launchpad", {}, created.body.server.id)
    ).body.platforms.find((platform) => platform.id === "curseforge")
      .keyConfigured,
    true,
  );
});

test("host and Java preflight report actionable compatibility and allocation failures", async (t) => {
  const f = await fixture(t, {
    javaProbe: async (javaPath) => ({
      ...java,
      path: javaPath,
      majorVersion: 17,
    }),
  });
  const result = await f.request(
    "/api/server-setup/preflight",
    json("POST", {
      memoryLimitMB: 16384,
      javaPath: "C:\\Java\\bin\\java.exe",
      gameVersion: "1.21.1",
    }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.compatible, false);
  assert.equal(result.body.ready, false);
  assert.equal(result.body.requiredJavaVersion, 21);
  assert.ok(
    result.body.warnings.some((warning) =>
      warning.includes("requires Java 21"),
    ),
  );
  assert.ok(result.body.warnings.some((warning) => warning.includes("no RAM")));
  assert.equal(
    (
      await f.request(
        "/api/server-setup/preflight",
        json("POST", { memoryLimitMB: -1 }),
      )
    ).status,
    400,
  );
  assert.equal((await f.request("/api/servers")).body.servers.length, 0);
});

test("pack reviews expose verified runtime requirements, clean scratch data and never register or start a server", async (t) => {
  const bytes = Buffer.from("pack server content");
  let invalid = false;
  const required = {
    loader: "neoforge",
    gameVersion: "1.21.1",
    loaderVersion: "21.1.200",
  };
  const f = await fixture(t, {
    extraProviders: [
      {
        id: "fixturepack",
        name: "Fixture pack",
        types: ["modpack"],
        available: true,
        downloadHosts: ["cdn.modrinth.com"],
        resolve: async () => ({
          title: "Fixture",
          versionName: "1",
          loaderInstall: required,
          files: [
            {
              path: invalid ? "../unsafe.jar" : "mods/fixture.jar",
              url: "https://cdn.modrinth.com/fixture.jar",
              size: bytes.length,
              hashes: {
                sha512: createHash("sha512").update(bytes).digest("hex"),
              },
            },
          ],
        }),
      },
    ],
  });
  const before = await fs.readdir(f.root);
  const input = {
    platform: "fixturepack",
    type: "modpack",
    projectId: "pack",
    versionId: "1",
    gameVersion: "1.21.1",
    loader: "neoforge",
  };
  const reviewed = await f.request(
    "/api/server-setup/modpack-preview",
    json("POST", input),
  );
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.deepEqual(reviewed.body.loaderInstall, required);
  assert.deepEqual(
    reviewed.body.files.map((file) => file.path),
    ["mods/fixture.jar"],
  );
  assert.deepEqual(await fs.readdir(f.root), before);
  invalid = true;
  assert.equal(
    (await f.request("/api/server-setup/modpack-preview", json("POST", input)))
      .status,
    400,
  );
  assert.deepEqual(await fs.readdir(f.root), before);
  assert.equal((await f.request("/api/servers")).body.servers.length, 0);
});

test("failed runtime installs retry on the same created server through the existing scoped jobs", async (t) => {
  const versionsService = versionService();
  const stage = versionsService.stage;
  let attempts = 0;
  versionsService.stage = async (...args) => {
    if (++attempts === 1) throw new Error("Download interrupted; retry");
    return stage(...args);
  };
  const f = await fixture(t, { versionsService });
  const body = requestBody();
  const created = await f.request("/api/server-setup", json("POST", body));
  const id = created.body.server.id;
  async function install() {
    const queued = await f.request(
      "/api/versions/install",
      json("POST", {
        provider: "paper",
        version: "1.21.1",
        build: "12",
        confirmed: true,
      }),
      id,
    );
    assert.equal(queued.status, 202);
    for (let tries = 0; tries < 200; tries++) {
      const job = (
        await f.request(`/api/versions/jobs/${queued.body.id}`, {}, id)
      ).body;
      if (["failed", "complete"].includes(job.state)) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Installation job did not finish");
  }
  assert.equal((await install()).state, "failed");
  const reused = await f.request("/api/server-setup", json("POST", body));
  assert.equal(reused.body.server.id, id);
  assert.equal((await install()).state, "complete");
  assert.equal((await f.request("/api/servers")).body.servers.length, 1);
  assert.equal((await f.request("/api/server", {}, id)).body.status, "offline");
  assert.equal(
    await fs.readFile(
      path.join(created.body.server.serverDir, "server.jar"),
      "utf8",
    ),
    "verified runtime fixture",
  );
  assert.match(
    await fs.readFile(
      path.join(created.body.server.serverDir, "eula.txt"),
      "utf8",
    ),
    /eula=false/,
  );
});

test("Java probe uses a bounded hidden shell-free executable check and handles missing Java", async () => {
  let invocation;
  const spawnProcess = (...args) => {
    invocation = args;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.write('openjdk version "21.0.4" 2024-07-16');
      child.emit("close", 0);
    });
    return child;
  };
  const checked = await probeJava("C:\\Java Path\\java.exe", { spawnProcess });
  assert.equal(checked.majorVersion, 21);
  assert.equal(checked.available, true);
  assert.deepEqual(invocation[1], ["-version"]);
  assert.equal(invocation[2].shell, false);
  assert.equal(invocation[2].windowsHide, true);
  const missing = await probeJava("not-found", {
    spawnProcess: () => {
      const child = new EventEmitter();
      queueMicrotask(() =>
        child.emit(
          "error",
          Object.assign(new Error("missing"), { code: "ENOENT" }),
        ),
      );
      return child;
    },
  });
  assert.equal(missing.available, false);
  assert.match(missing.error, /Java was not found/);
});
