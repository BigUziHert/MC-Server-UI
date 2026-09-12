import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { DESKTOP_COOKIE_NAME, startDesktopRuntime } from "./runtime.mjs";
import { createFleet } from "../server/index.mjs";

const json = (method, body) => ({ method, body: JSON.stringify(body) });
async function addServer(runtime, settings = {}) {
  const response = await runtime.request(
    "/api/servers",
    json("POST", { name: "My server", port: 25565, ...settings }),
  );
  assert.equal(response.status, 201);
  return (await response.json()).server;
}
async function fixture(t) {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-desktop-runtime-"),
  );
  const dataDir = path.join(rootDir, "panel");
  const runtimes = [];
  const launch = async (options = {}) => {
    const runtime = await startDesktopRuntime({
      dataDir,
      scheduler: false,
      ...options,
    });
    runtimes.push(runtime);
    return {
      ...runtime,
      request: (route, options = {}) =>
        fetch(runtime.url + route, {
          ...options,
          headers: {
            "Content-Type": "application/json",
            Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.token}`,
            ...options.headers,
          },
        }),
    };
  };
  t.after(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    assert.equal(path.dirname(rootDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(rootDir).startsWith("mc-desktop-runtime-"));
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  return { rootDir, dataDir, launch };
}

test("desktop runtime requires its random session cookie for all API, file and static routes", async (t) => {
  const { launch } = await fixture(t);
  const runtime = await launch();
  assert.match(runtime.token, /^[a-f0-9]{64}$/);
  const address = new URL(runtime.url);
  assert.equal(address.hostname, "127.0.0.1");
  assert.ok(Number(address.port) > 0);
  for (const route of [
    "/",
    "/index.html",
    "/favicon.svg",
    "/api/servers",
    "/api/files/download?path=server.properties",
  ])
    assert.equal((await fetch(runtime.url + route)).status, 401, route);
  for (const cookie of [
    "unrelated=value",
    `${DESKTOP_COOKIE_NAME}=wrong`,
    `${DESKTOP_COOKIE_NAME}=${runtime.token}x`,
    `${DESKTOP_COOKIE_NAME}=${runtime.token}; ${DESKTOP_COOKIE_NAME}=${runtime.token}`,
  ])
    assert.equal(
      (
        await fetch(runtime.url + "/api/servers", {
          headers: { Cookie: cookie },
        })
      ).status,
      401,
    );
  const api = await runtime.request("/api/servers");
  assert.equal(api.status, 200);
  assert.deepEqual(await api.json(), { servers: [], defaultServerId: null });
  await addServer(runtime);
  const file = await runtime.request(
    "/api/files/download?path=server.properties",
  );
  assert.equal(file.status, 200);
  assert.match(await file.text(), /server-port=25565/);
  assert.equal(
    (
      await runtime.request("/api/server", {
        headers: {
          Cookie: `theme=dark; ${DESKTOP_COOKIE_NAME}=${runtime.token}; other=1`,
        },
      })
    ).status,
    200,
  );
  const distIndex = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../dist/index.html",
  );
  const built = await fs.access(distIndex).then(
    () => true,
    () => false,
  );
  await t.test(
    "serves the compiled UI after authentication",
    { skip: !built && "Run npm run build to check compiled UI serving." },
    async () => {
      const ui = await runtime.request("/");
      assert.equal(ui.status, 200);
      assert.match(await ui.text(), /<div id="root"><\/div>/);
      const icon = await runtime.request("/favicon.svg");
      assert.equal(icon.status, 200);
      assert.match(await icon.text(), /<svg/);
    },
  );
});

test("desktop folder selection is available only to its authenticated session and handles cancellation", async (t) => {
  const { launch, rootDir } = await fixture(t);
  const directory = path.join(rootDir, "Existing Minecraft Server");
  await fs.mkdir(directory);
  let selections = 0;
  const runtime = await launch({
    selectServerDirectory: async () => {
      selections++;
      return selections === 1 ? null : directory;
    },
  });
  assert.deepEqual(await (await runtime.request("/api/server-import")).json(), {
    canBrowse: true,
  });
  const route = "/api/server-import/browse";
  assert.equal(
    (await fetch(runtime.url + route, { method: "POST" })).status,
    401,
  );
  assert.equal(
    (
      await runtime.request(route, {
        ...json("POST", {}),
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  assert.equal(selections, 0);
  const canceled = await runtime.request(route, json("POST", {}));
  assert.equal(canceled.status, 200);
  assert.deepEqual(await canceled.json(), { directory: null });
  const selected = await runtime.request(route, json("POST", {}));
  assert.equal(selected.status, 200);
  assert.deepEqual(await selected.json(), { directory });
  assert.equal(selections, 2);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.deepEqual(await (await runtime.request("/api/servers")).json(), {
    servers: [],
    defaultServerId: null,
  });
});

test("desktop runtime enforces its exact origin and host, even with a valid cookie", async (t) => {
  const { launch } = await fixture(t);
  const runtime = await launch();
  for (const origin of [
    "https://attacker.example",
    "null",
    runtime.url + "/",
    runtime.url.replace("127.0.0.1", "localhost"),
    "http://127.0.0.1:1",
  ])
    assert.equal(
      (await runtime.request("/api/servers", { headers: { Origin: origin } }))
        .status,
      403,
      origin,
    );
  assert.equal(
    (
      await runtime.request("/api/servers", {
        headers: { Origin: runtime.url },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await runtime.request("/api/server", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
  const hostResult = await new Promise((resolve, reject) => {
    const req = http.get(
      runtime.url + "/api/server",
      {
        headers: {
          Host: `localhost:${new URL(runtime.url).port}`,
          Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.token}`,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
  assert.equal(hostResult, 403);
  await addServer(runtime);
  assert.equal(
    (
      await runtime.request("/api/files", {
        ...json("POST", {
          name: "valid.txt",
          type: "file",
          content: "same-origin write",
        }),
        headers: { Origin: runtime.url },
      })
    ).status,
    201,
  );
});

test("desktop runtime isolates environment settings and persists its data across authenticated sessions", async (t) => {
  const { launch, rootDir } = await fixture(t);
  const keys = [
    "MC_SERVER_NAME",
    "MC_SERVER_DIR",
    "MC_SERVER_JAR",
    "JAVA_PATH",
    "PANEL_DATA_DIR",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  let first;
  try {
    process.env.MC_SERVER_NAME = "Must not leak";
    process.env.MC_SERVER_DIR = path.join(rootDir, "unrelated-server");
    process.env.MC_SERVER_JAR = "unrelated.jar";
    process.env.JAVA_PATH = "unrelated-java";
    process.env.PANEL_DATA_DIR = path.join(rootDir, "unrelated-data");
    first = await launch();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const servers = await (await first.request("/api/servers")).json();
  assert.deepEqual(servers, { servers: [], defaultServerId: null });
  const created = await addServer(first, { name: "My chosen server" });
  const id = created.id;
  assert.equal(created.name, "My chosen server");
  assert.equal(created.mode, "live");
  assert.equal(created.javaPath, "java");
  await assert.rejects(fs.access(path.join(rootDir, "unrelated-data")));
  await assert.rejects(fs.access(path.join(rootDir, "unrelated-server")));
  assert.equal(
    (
      await first.request(
        `/api/servers/${id}`,
        json("PATCH", { name: "My desktop world" }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await first.request(
        "/api/files",
        json("POST", {
          name: "kept.txt",
          type: "file",
          content: "survives restart",
        }),
      )
    ).status,
    201,
  );
  await first.close();
  await assert.rejects(fetch(first.url + "/api/servers"));
  const second = await launch();
  assert.notEqual(second.token, first.token);
  const restored = await (await second.request("/api/servers")).json();
  assert.equal(restored.defaultServerId, id);
  assert.equal(restored.servers[0].name, "My desktop world");
  assert.equal(
    await (await second.request("/api/files/download?path=kept.txt")).text(),
    "survives restart",
  );
  assert.equal(
    (
      await second.request("/api/server", {
        headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${first.token}` },
      })
    ).status,
    401,
  );
  await Promise.all([second.close(), second.close()]);
});

test("desktop close awaits graceful shutdown of managed Java and releases its listener", async (t) => {
  const { launch } = await fixture(t);
  const commands = [];
  let exited = false;
  let killed = false;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    killed = true;
    child.emit("close", 1);
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      commands.push(chunk.toString());
      if (chunk.toString() === "stop\n")
        setTimeout(() => {
          exited = true;
          child.emit("close", 0);
        }, 25);
      callback();
    },
  });
  const runtime = await launch({
    spawnServer: () => {
      setImmediate(() =>
        child.stdout.write(
          '[Server thread/INFO]: Done (1.24s)! For help, type "help"\n',
        ),
      );
      return child;
    },
  });
  const live = await (
    await runtime.request(
      "/api/servers",
      json("POST", { name: "Java", mode: "live", port: 25566 }),
    )
  ).json();
  const headers = { "X-Server-Id": live.server.id };
  await runtime.request("/api/files", {
    ...json("POST", {
      name: "server.jar",
      type: "file",
      content: "never executed",
    }),
    headers,
  });
  await runtime.request("/api/files/content", {
    ...json("PUT", { path: "eula.txt", content: "eula=true\n" }),
    headers,
  });
  assert.equal(
    (
      await runtime.request("/api/server/power", {
        ...json("POST", { action: "start" }),
        headers,
      })
    ).status,
    200,
  );
  await runtime.close();
  assert.deepEqual(commands, ["stop\n"]);
  assert.equal(exited, true);
  assert.equal(killed, false);
  await assert.rejects(fetch(runtime.url + "/api/server"));
});

test("desktop startup requires an explicit absolute data directory", async () => {
  await assert.rejects(startDesktopRuntime(), /absolute data directory/);
  await assert.rejects(
    startDesktopRuntime({ dataDir: "relative" }),
    /absolute data directory/,
  );
});

test("desktop shutdown aborts an unfinished upload without hanging or publishing partial server files", async (t) => {
  const { launch } = await fixture(t);
  const runtime = await launch();
  const created = await addServer(runtime);
  const { dataDir, serverDir } = runtime.fleet.runtimes.get(created.id);
  const upload = http.request(runtime.url + "/api/files/upload", {
    method: "POST",
    headers: {
      Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.token}`,
      "Content-Type": "multipart/form-data; boundary=desktop-shutdown-test",
      "Content-Length": "1048576",
    },
  });
  upload.on("error", () => {});
  t.after(() => upload.destroy());
  upload.write(
    '--desktop-shutdown-test\r\nContent-Disposition: form-data; name="files"; filename="partial.txt"\r\nContent-Type: text/plain\r\n\r\npartial upload',
  );
  const deadline = Date.now() + 2000;
  while (
    !(await fs.readdir(path.join(dataDir, "uploads"))).length &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok((await fs.readdir(path.join(dataDir, "uploads"))).length > 0);
  let timeout;
  try {
    await Promise.race([
      runtime.close(),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Shutdown hung on an incomplete upload")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    upload.destroy();
  }
  await assert.rejects(fs.access(path.join(serverDir, "partial.txt")));
});

test("fresh desktop stays empty across restarts and gives the first explicit server its own persistent storage", async (t) => {
  const { launch, dataDir } = await fixture(t);
  const first = await launch();
  assert.deepEqual(await (await first.request("/api/servers")).json(), {
    servers: [],
    defaultServerId: null,
  });
  assert.deepEqual(await fs.readdir(dataDir), ["servers.json"]);
  for (const route of [
    "/api/server",
    "/api/files",
    "/api/backups",
    "/api/players",
    "/api/not-an-endpoint",
  ]) {
    const response = await first.request(route);
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /Add a server/);
  }
  const distIndex = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../dist/index.html",
  );
  if (
    await fs.access(distIndex).then(
      () => true,
      () => false,
    )
  ) {
    const ui = await first.request("/");
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /<div id="root"><\/div>/);
  }
  await first.close();
  const second = await launch();
  assert.deepEqual(await (await second.request("/api/servers")).json(), {
    servers: [],
    defaultServerId: null,
  });
  assert.deepEqual(await fs.readdir(dataDir), ["servers.json"]);
  const created = await addServer(second, { name: "Actual server" });
  assert.equal(created.mode, "live");
  assert.equal(created.status, "offline");
  assert.equal(
    (await (await second.request("/api/servers")).json()).defaultServerId,
    created.id,
  );
  await second.request(
    "/api/files",
    json("POST", {
      name: "keep.txt",
      type: "file",
      content: "first explicit server",
    }),
  );
  const instance = second.fleet.runtimes.get(created.id);
  assert.equal(instance.dataDir, path.join(dataDir, "instances", created.id));
  await second.close();
  const third = await launch();
  assert.equal(third.fleet.runtimes.get(created.id).dataDir, instance.dataDir);
  assert.equal(
    await (await third.request("/api/files/download?path=keep.txt")).text(),
    "first explicit server",
  );
  assert.equal(
    (await (await third.request("/api/audit")).json()).entries.some(
      (entry) => entry.action === "File created",
    ),
    true,
  );
  await assert.rejects(fs.access(path.join(dataDir, "server")));
});

test("desktop preserves previously registered servers and their existing world files", async (t) => {
  const { launch, dataDir } = await fixture(t);
  const previous = await createFleet({
    dataDir,
    scheduler: false,
    useEnvironment: false,
  });
  const [id, instance] = previous.runtimes.entries().next().value;
  await fs.writeFile(
    path.join(instance.serverDir, "keep-world.txt"),
    "existing installation",
  );
  await previous.close();
  const runtime = await launch();
  const restored = await (await runtime.request("/api/servers")).json();
  assert.equal(restored.defaultServerId, id);
  assert.equal(restored.servers[0].name, "The Overworld");
  assert.equal(restored.servers[0].mode, "demo");
  assert.equal(
    await (
      await runtime.request("/api/files/download?path=keep-world.txt")
    ).text(),
    "existing installation",
  );
});
