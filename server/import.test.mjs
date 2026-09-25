import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import * as tar from "tar";
import {
  createFleet,
  terminateProcessTree,
  validateServerConfiguration,
} from "./index.mjs";
import {
  parseProperties,
  parseJavaScript,
  buildScriptInvocation,
  inspectJavaArguments,
  validateStartupFiles,
} from "./import.mjs";

const json = (method, body) => ({ method, body: JSON.stringify(body) });
async function fixture(t, options = {}) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, "mc-import-test-"));
  const dataDir = path.join(root, "panel");
  const directory = path.join(root, "Existing World");
  const launched = [];
  const listeners = [];
  const boot = async (extra = {}) => {
    const fleet = await createFleet({
      dataDir,
      createDefaultServer: false,
      scheduler: false,
      useEnvironment: false,
      publicAddress: { resolve: async () => null },
      ...options,
      ...extra,
    });
    launched.push(fleet);
    const listener = await new Promise((resolve) => {
      const server = fleet.app.listen(0, "127.0.0.1", () => resolve(server));
    });
    listeners.push(listener);
    const base = `http://127.0.0.1:${listener.address().port}`;
    const request = async (route, options = {}) => {
      const response = await fetch(base + route, {
        ...options,
        headers: { "Content-Type": "application/json", ...options.headers },
      });
      return { status: response.status, body: await response.json() };
    };
    return { ...fleet, request, base };
  };
  const prepare = async (
    target = directory,
    {
      jars = ["server.jar"],
      properties = "server-port=25571\nmotd=Existing world\nmax-players=42\nlevel-name=world\n",
    } = {},
  ) => {
    await fs.mkdir(path.join(target, "world"), { recursive: true });
    await fs.mkdir(path.join(target, "plugins"), { recursive: true });
    await fs.writeFile(path.join(target, "server.properties"), properties);
    await fs.writeFile(
      path.join(target, "eula.txt"),
      "# User has not accepted\neula=false\n",
    );
    await fs.writeFile(
      path.join(target, "world", "level.dat"),
      Buffer.from([0x1f, 0x8b, 0, 255, 11]),
    );
    await fs.writeFile(
      path.join(target, "plugins", "plugin.yml"),
      "keep: exactly\n",
    );
    for (const jar of jars)
      await fs.writeFile(
        path.join(target, jar),
        "test JAR bytes, never execute",
      );
    return target;
  };
  t.after(async () => {
    for (const fleet of launched) await fleet.close();
    for (const listener of listeners) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
    assert.equal(path.dirname(root), tempRoot);
    assert.ok(path.basename(root).startsWith("mc-import-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, directory, prepare, boot };
}
async function snapshot(root, relative = "") {
  const result = {};
  for (const entry of await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink())
      result[name] = `link:${await fs.readlink(path.join(root, name))}`;
    else if (entry.isDirectory()) {
      result[`${name}/`] = "directory";
      Object.assign(result, await snapshot(root, name));
    } else
      result[name] = (await fs.readFile(path.join(root, name))).toString("hex");
  }
  return result;
}

test("Java properties parsing preserves escaped separators, continuations, comments and duplicate semantics", () => {
  const values = parseProperties(
    [
      "  # comment ending in a backslash\\",
      "! another comment",
      "server\\u002dport : 25571",
      "max-players\t=\t42",
      "motd=First\\nSecond\\",
      "   continued",
      "escaped\\ key\\:part=value\\=yes",
      "even=ends-with-two-backslashes\\\\",
      "unicode=\\u263A",
      "duplicate=old",
      "duplicate:new",
      "__proto__=data-only",
      "value without-equals",
    ].join("\r\n"),
  );
  assert.equal(values.get("server-port"), "25571");
  assert.equal(values.get("max-players"), "42");
  assert.equal(values.get("motd"), "First\nSecondcontinued");
  assert.equal(values.get("escaped key:part"), "value=yes");
  assert.equal(values.get("even"), "ends-with-two-backslashes\\");
  assert.equal(values.get("unicode"), "☺");
  assert.equal(values.get("duplicate"), "new");
  assert.equal(values.get("__proto__"), "data-only");
  assert.equal(values.get("value"), "without-equals");
  for (const malformed of ["motd=\\u123", "motd=\\uu0041", "motd=\\uZZZZ"])
    assert.throws(() => parseProperties(malformed), /invalid Unicode escape/);
});

test("inspection and in-place import preserve every source byte, retain properties, and never start Java", async (t) => {
  let spawned = 0;
  const { root, directory, dataDir, prepare, boot } = await fixture(t, {
    spawnServer: () => {
      spawned++;
      throw new Error("Import must not execute Java");
    },
  });
  await prepare(directory, {
    jars: ["SERVER.JAR"],
    properties:
      "# Keep comments and original escapes\r\nserver\\-port : 25571\r\nserver-ip=127.0.0.2\r\nmax\\-players\t=\t42\r\nlevel-name=my\\ world\r\nmotd=Welcome \\u263A\\nSecond\\\r\n  continued\r\n",
  });
  await fs.mkdir(path.join(directory, "my world"));
  await fs.writeFile(
    path.join(directory, "my world", "level.dat"),
    "original alternate world",
  );
  await fs.writeFile(
    path.join(directory, "run.bat"),
    "@echo This script must not run\r\n",
  );
  const before = await snapshot(directory);
  const first = await boot();
  const inspected = await first.request(
    "/api/server-import/inspect",
    json("POST", { directory }),
  );
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.directory, await fs.realpath(directory));
  assert.equal(inspected.body.port, 25571);
  assert.equal(inspected.body.maxPlayers, 42);
  assert.equal(inspected.body.world, "my world");
  assert.equal(inspected.body.motd, "Welcome ☺\nSecondcontinued");
  assert.deepEqual(inspected.body.jars, ["SERVER.JAR"]);
  assert.equal(inspected.body.jar, "SERVER.JAR");
  assert.equal(inspected.body.eulaAccepted, false);
  assert.ok(
    inspected.body.warnings.some((warning) =>
      warning.includes("scripts are not executed"),
    ),
  );
  const imported = await first.request(
    "/api/server-import",
    json("POST", {
      directory,
      name: "Our existing world",
      jar: "SERVER.JAR",
      port: 25572,
      memoryLimitMB: 3072,
      javaPath: "java",
    }),
  );
  assert.equal(imported.status, 201);
  const id = imported.body.server.id;
  assert.equal(imported.body.server.source, "imported");
  assert.equal(imported.body.server.serverDir, await fs.realpath(directory));
  assert.equal(imported.body.server.status, "offline");
  assert.equal(imported.body.server.mode, "live");
  assert.equal(imported.body.server.address, "127.0.0.2:25572");
  assert.equal(imported.body.server.motd, inspected.body.motd);
  assert.deepEqual(await snapshot(directory), before);
  assert.equal(spawned, 0);
  assert.equal((await first.request("/api/server")).body.maxPlayers, 42);
  const bytes = Buffer.from(
    await (
      await fetch(first.base + "/api/files/download?path=world/level.dat")
    ).arrayBuffer(),
  );
  assert.deepEqual(bytes, Buffer.from([0x1f, 0x8b, 0, 255, 11]));
  const backup = await first.request(
    "/api/backups",
    json("POST", { name: "Imported world archive" }),
  );
  assert.equal(backup.status, 201);
  assert.deepEqual(await snapshot(directory), before);
  const metadata = path.join(dataDir, "instances", id);
  await assert.rejects(fs.access(path.join(metadata, "server")));
  const unpacked = path.join(root, "verify");
  await fs.mkdir(unpacked);
  await tar.x({
    file: path.join(metadata, "backups", `${backup.body.id}.tar.gz`),
    cwd: unpacked,
  });
  assert.equal(
    await fs.readFile(path.join(unpacked, "my world", "level.dat"), "utf8"),
    "original alternate world",
  );
  await first.close();
  const restarted = await boot();
  const record = (await restarted.request("/api/servers")).body.servers[0];
  assert.equal(record.id, id);
  assert.equal(record.motd, inspected.body.motd);
  assert.equal(record.serverDir, await fs.realpath(directory));
  assert.equal(
    (
      await restarted.request(
        `/api/servers/${id}`,
        json("PATCH", {
          name: "Renamed imported world",
          javaPath: "custom-java",
          memoryLimitMB: 4096,
        }),
      )
    ).status,
    200,
  );
  assert.deepEqual(await snapshot(directory), before);
  assert.equal(
    (await restarted.request("/api/backups")).body.backups[0].id,
    backup.body.id,
  );
  assert.equal(
    (
      await restarted.request(
        "/api/files",
        json("POST", {
          name: "written-through-panel.txt",
          type: "file",
          content: "in place",
        }),
      )
    ).status,
    201,
  );
  assert.equal(
    await fs.readFile(
      path.join(directory, "written-through-panel.txt"),
      "utf8",
    ),
    "in place",
  );
  assert.equal(spawned, 0);
});

test("zero and multiple root JARs require an explicit usable selection and do not create source files", async (t) => {
  const { directory, prepare, boot } = await fixture(t);
  await prepare(directory, { jars: [] });
  const panel = await boot();
  const before = await snapshot(directory);
  const empty = await panel.request(
    "/api/server-import/inspect",
    json("POST", { directory }),
  );
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.jars, []);
  assert.equal(empty.body.jar, null);
  assert.ok(
    empty.body.warnings.some((warning) => warning.includes("No root-level")),
  );
  assert.equal(
    (
      await panel.request(
        "/api/server-import",
        json("POST", { directory, jar: "server.jar" }),
      )
    ).status,
    400,
  );
  assert.deepEqual(await snapshot(directory), before);
  await fs.writeFile(path.join(directory, "paper.jar"), "test");
  await fs.writeFile(path.join(directory, "installer.jar"), "test");
  await fs.mkdir(path.join(directory, "libraries"));
  await fs.writeFile(
    path.join(directory, "libraries", "not-a-root.jar"),
    "test",
  );
  const multiple = await panel.request(
    "/api/server-import/inspect",
    json("POST", { directory }),
  );
  assert.deepEqual(multiple.body.jars, ["installer.jar", "paper.jar"]);
  assert.equal(multiple.body.jar, null);
  assert.equal(
    (await panel.request("/api/server-import", json("POST", { directory })))
      .status,
    400,
  );
  assert.equal(
    (
      await panel.request(
        "/api/server-import",
        json("POST", { directory, jar: "libraries/not-a-root.jar" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await panel.request(
        "/api/server-import",
        json("POST", { directory, jar: "paper.jar" }),
      )
    ).status,
    201,
  );
});

test("import rejects duplicate/nested folders, panel storage overlap and serialized port conflicts", async (t) => {
  const { directory, dataDir, prepare, boot } = await fixture(t);
  await prepare();
  const panel = await boot();
  const competing = await Promise.all([
    panel.request(
      "/api/server-import",
      json("POST", { directory, jar: "server.jar", port: 25571 }),
    ),
    panel.request(
      "/api/servers",
      json("POST", { name: "Competing server", port: 25571 }),
    ),
  ]);
  assert.deepEqual(competing.map((result) => result.status).sort(), [201, 409]);
  let imported = competing[0];
  if (imported.status !== 201)
    imported = await panel.request(
      "/api/server-import",
      json("POST", { directory, jar: "server.jar", port: 25572 }),
    );
  assert.equal(imported.status, 201);
  assert.equal(
    (
      await panel.request(
        "/api/server-import",
        json("POST", { directory, jar: "server.jar", port: 25573 }),
      )
    ).status,
    409,
  );
  const nested = await prepare(path.join(directory, "nested"));
  assert.equal(
    (
      await panel.request(
        "/api/server-import/inspect",
        json("POST", { directory: nested }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await panel.request(
        "/api/server-import/inspect",
        json("POST", { directory: path.dirname(directory) }),
      )
    ).status,
    409,
  );
  const inside = await prepare(path.join(dataDir, "inside-panel"));
  assert.equal(
    (
      await panel.request(
        "/api/server-import/inspect",
        json("POST", { directory: inside }),
      )
    ).status,
    409,
  );
});

test("inspection rejects malformed input, escaping worlds and symbolic links without changing sources", async (t) => {
  const { root, directory, prepare, boot } = await fixture(t);
  await prepare();
  const panel = await boot();
  for (const directory of [undefined, "relative", "C:\\invalid\nfolder"])
    assert.equal(
      (
        await panel.request(
          "/api/server-import/inspect",
          json("POST", { directory }),
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await panel.request(
        "/api/server-import/inspect",
        json("POST", { directory: path.join(root, "missing") }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await panel.request(
        "/api/server-import/inspect",
        json("POST", { directory: path.join(directory, "server.jar") }),
      )
    ).status,
    400,
  );
  const noProperties = path.join(root, "not-server");
  await fs.mkdir(noProperties);
  assert.equal(
    (
      await panel.request(
        "/api/server-import/inspect",
        json("POST", { directory: noProperties }),
      )
    ).status,
    400,
  );
  for (const properties of [
    "server-port=bad",
    "server-port=99999",
    "motd=\\uZZZZ",
    "level-name=../outside",
    "max-players=-1",
  ]) {
    await fs.writeFile(path.join(directory, "server.properties"), properties);
    assert.equal(
      (
        await panel.request(
          "/api/server-import/inspect",
          json("POST", { directory }),
        )
      ).status,
      400,
    );
    assert.equal(
      await fs.readFile(path.join(directory, "server.properties"), "utf8"),
      properties,
    );
  }
  await fs.writeFile(
    path.join(directory, "server.properties"),
    "level-name=linked-world\n",
  );
  const outside = path.join(root, "outside-world");
  await fs.mkdir(outside);
  await fs.symlink(
    outside,
    path.join(directory, "linked-world"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    (
      await panel.request(
        "/api/server-import/inspect",
        json("POST", { directory }),
      )
    ).status,
    400,
  );
  const alias = path.join(root, "alias");
  await fs.symlink(
    directory,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    (
      await panel.request(
        "/api/server-import/inspect",
        json("POST", { directory: alias }),
      )
    ).status,
    400,
  );
  assert.deepEqual((await panel.request("/api/servers")).body.servers, []);
});

test("unavailable imported folders are not recreated and recover without blocking unrelated servers", async (t) => {
  const { root, directory, prepare, boot } = await fixture(t);
  await prepare();
  const first = await boot();
  const imported = await first.request(
    "/api/server-import",
    json("POST", { directory, jar: "server.jar" }),
  );
  const id = imported.body.server.id;
  await first.request(
    "/api/subusers",
    json("POST", { email: "existing@example.com", role: "viewer" }),
  );
  await first.close();
  const parked = path.join(root, "temporarily-disconnected");
  assert.equal(path.dirname(directory), root);
  assert.equal(path.dirname(parked), root);
  await fs.rename(directory, parked);
  const restarted = await boot();
  const record = (await restarted.request("/api/servers")).body.servers[0];
  assert.equal(record.id, id);
  assert.equal(record.status, "offline");
  assert.equal(record.unavailable, true);
  assert.match(record.sourceError, /unavailable/);
  assert.equal((await restarted.request("/api/server")).status, 409);
  await assert.rejects(fs.access(directory));
  assert.equal(
    (
      await restarted.request(
        "/api/servers",
        json("POST", { name: "Unrelated new world", port: 25572 }),
      )
    ).status,
    201,
  );
  assert.equal(path.dirname(directory), root);
  assert.equal(path.dirname(parked), root);
  await fs.rename(parked, directory);
  const requests = await Promise.all(
    ["/api/server", "/api/console", "/api/files", "/api/subusers"].map(
      (route) => restarted.request(route, { headers: { "X-Server-Id": id } }),
    ),
  );
  assert.ok(requests.every((response) => response.status === 200));
  assert.equal(requests[3].body.users[0].email, "existing@example.com");
  assert.equal(
    (await restarted.request("/api/servers")).body.servers.find(
      (entry) => entry.id === id,
    ).unavailable,
    undefined,
  );
});

test("imported nested JAR settings survive panel restart and remain launchable", async (t) => {
  const launches = [];
  const { directory, prepare, boot } = await fixture(t, {
    spawnServer(executable, args) {
      launches.push({ executable, args });
      return mockServer();
    },
  });
  await prepare();
  const first = await boot();
  const imported = await first.request(
    "/api/server-import",
    json("POST", { directory, jar: "server.jar" }),
  );
  const id = imported.body.server.id;
  await fs.mkdir(path.join(directory, "runtime"));
  await fs.rename(
    path.join(directory, "server.jar"),
    path.join(directory, "runtime", "server.jar"),
  );
  const updated = await first.request(
    `/api/servers/${id}`,
    json("PATCH", { jar: "runtime/server.jar" }),
  );
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  await first.close();
  const restarted = await boot();
  const record = (await restarted.request("/api/servers")).body.servers[0];
  assert.equal(record.id, id);
  assert.equal(record.jar, "runtime/server.jar");
  assert.equal(record.unavailable, undefined);
  await fs.writeFile(path.join(directory, "eula.txt"), "eula=true\n");
  const started = await restarted.request(
    "/api/server/power",
    json("POST", { action: "start" }),
  );
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.ok(
    launches[0].args.includes(path.join(directory, "runtime", "server.jar")),
  );
});

test("Settings repairs an unavailable imported launcher while preserving identity and properties", async (t) => {
  const { dataDir, directory, prepare, boot } = await fixture(t);
  await prepare();
  const first = await boot();
  const imported = await first.request(
    "/api/server-import",
    json("POST", { directory, jar: "server.jar" }),
  );
  const id = imported.body.server.id;
  await first.close();
  await fs.rename(
    path.join(directory, "server.jar"),
    path.join(directory, "updated.jar"),
  );
  const restarted = await boot();
  assert.equal(
    (await restarted.request("/api/servers")).body.servers[0].unavailable,
    true,
  );
  const invalid = await restarted.request(
    `/api/servers/${id}`,
    json("PATCH", { jar: "missing.jar", port: 25572 }),
  );
  assert.equal(invalid.status, 409);
  assert.equal(restarted.runtimes.get(id).unavailable, true);
  const placeholder = restarted.runtimes.get(id);
  let entered, release;
  const persistenceEntered = new Promise((resolve) => {
    entered = resolve;
  });
  const releasePersistence = new Promise((resolve) => {
    release = resolve;
  });
  const rename = fs.rename.bind(fs);
  const mocked = t.mock.method(fs, "rename", async (source, destination) => {
    if (destination === path.join(dataDir, "servers.json")) {
      entered();
      await releasePersistence;
      throw Object.assign(new Error("Registry persistence fixture failure"), {
        code: "EIO",
      });
    }
    return rename(source, destination);
  });
  const logged = t.mock.method(console, "error", () => {});
  const pending = restarted.request(
    `/api/servers/${id}`,
    json("PATCH", { jar: "updated.jar", port: 25572 }),
  );
  await persistenceEntered;
  // A repair must not expose new handlers to remote requests until committed.
  assert.equal(restarted.runtimes.get(id), placeholder);
  release();
  const failed = await pending;
  assert.equal(failed.status, 500);
  assert.equal(restarted.runtimes.get(id), placeholder);
  assert.equal(
    parseProperties(
      await fs.readFile(path.join(directory, "server.properties"), "utf8"),
    ).get("server-port"),
    "25571",
  );
  mocked.mock.restore();
  logged.mock.restore();
  const repaired = await restarted.request(
    `/api/servers/${id}`,
    json("PATCH", { jar: "updated.jar", port: 25572, motd: "Repaired world" }),
  );
  assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
  assert.equal(repaired.body.server.id, id);
  assert.equal(repaired.body.server.unavailable, undefined);
  const properties = parseProperties(
    await fs.readFile(path.join(directory, "server.properties"), "utf8"),
  );
  assert.equal(properties.get("server-port"), "25572");
  assert.equal(properties.get("motd"), "Repaired world");
  const registry = JSON.parse(
    await fs.readFile(path.join(dataDir, "servers.json"), "utf8"),
  );
  assert.equal(registry.servers[0].id, id);
  assert.equal(registry.servers[0].jar, "updated.jar");
  await restarted.close();
  const restored = await boot();
  assert.equal((await restored.request("/api/server")).status, 200);
});

test("remote authentication restores an imported runtime after its folder returns", async (t) => {
  const { root, directory, prepare, boot } = await fixture(t, {
    remoteListen: false,
  });
  await prepare();
  const first = await boot();
  const imported = await first.request(
    "/api/server-import",
    json("POST", { directory, jar: "server.jar" }),
  );
  const id = imported.body.server.id;
  await first.access.configure({
    enabled: true,
    publicUrl: "https://panel.example.test",
    transport: "proxy",
  });
  const user = (
    await first.request(
      "/api/subusers",
      json("POST", {
        email: "returning@example.test",
        permissions: ["control.console"],
      }),
    )
  ).body;
  const invitation = await first.access.invite({ serverId: id, user });
  const token = new URL(invitation.invitationUrl).hash.slice("#invite=".length);
  const signed = await first.access.accept(token, "Correct-test-password!");
  await first.close();
  const parked = path.join(root, "parked-server");
  await fs.rename(directory, parked);
  const restarted = await boot();
  assert.equal(restarted.runtimes.get(id).unavailable, true);
  const listener = await new Promise((resolve) => {
    const server = restarted.remoteApp.listen(0, "127.0.0.1", () =>
      resolve(server),
    );
  });
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  });
  const remote = (route, cookie) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${listener.address().port}${route}`,
        {
          headers: { Host: "panel.example.test", Cookie: cookie.split(";")[0] },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, body: JSON.parse(body) }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  assert.equal(
    (await remote("/api/access/session", signed.cookie)).body.role,
    "guest",
  );
  await fs.rename(parked, directory);
  // No owner request may be needed to wake the restored runtime.
  const requests = await Promise.all([
    remote("/api/access/session", signed.cookie),
    remote("/api/servers", signed.cookie),
  ]);
  assert.equal(requests[0].body.role, "subuser");
  assert.equal(requests[1].status, 200);
  assert.equal(requests[1].body.servers[0].id, id);
  assert.equal(restarted.runtimes.get(id).unavailable, undefined);
  const login = await restarted.access.login({
    email: user.email,
    password: "Correct-test-password!",
  });
  assert.equal(login.session.serverId, id);
});

test("folder browsing capability is explicit and cancellation performs no import", async (t) => {
  const { boot, directory } = await fixture(t);
  const ordinary = await boot();
  assert.deepEqual((await ordinary.request("/api/server-import")).body, {
    canBrowse: false,
  });
  assert.equal(
    (await ordinary.request("/api/server-import/browse", json("POST", {})))
      .status,
    400,
  );
  await ordinary.close();
  let selected = null;
  const desktop = await boot({ selectServerDirectory: async () => selected });
  assert.deepEqual((await desktop.request("/api/server-import")).body, {
    canBrowse: true,
  });
  assert.deepEqual(
    (await desktop.request("/api/server-import/browse", json("POST", {}))).body,
    { directory: null },
  );
  selected = directory;
  assert.deepEqual(
    (await desktop.request("/api/server-import/browse", json("POST", {}))).body,
    { directory },
  );
  assert.deepEqual((await desktop.request("/api/servers")).body.servers, []);
});

const forgeArgs = (family = "neoforged/neoforge") => [
  "@user_jvm_args.txt",
  `@libraries/net/${family}/21.1.200/win_args.txt`,
  "nogui",
];
async function prepareForge(directory, family = "neoforged/neoforge") {
  const args = forgeArgs(family);
  const generated = path.join(directory, args[1].slice(1));
  await fs.mkdir(path.dirname(generated), { recursive: true });
  await fs.writeFile(
    generated,
    "# Generated launcher arguments\n-Dfixture=preserved\nnet.fixture.Main\n",
  );
  await fs.writeFile(
    path.join(directory, "user_jvm_args.txt"),
    "# -Xmx1G is only a comment\n-Xms2G\n-Xmx6G\n",
  );
  await fs.writeFile(
    path.join(directory, "run.bat"),
    `@echo off\r\nREM Preserve installed argument files\r\njava ${args.slice(0, 2).join(" ")} %*\r\npause\r\n`,
  );
  return args;
}
const eventually = async (condition) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Expected state transition did not complete");
};
function mockServer(onCommand = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    setImmediate(() => child.emit("close", 1));
    return true;
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const command = chunk.toString();
      onCommand(command);
      if (command === "stop\n") setImmediate(() => child.emit("close", 0));
      callback();
    },
  });
  return child;
}

for (const [family, software] of [
  ["neoforged/neoforge", "NeoForge"],
  ["minecraftforge/forge", "Forge"],
]) {
  test(`${software} import needs no root JAR and preserves its world, launcher files, RAM and lifecycle`, async (t) => {
    const launches = [];
    const commands = [];
    const { directory, prepare, boot } = await fixture(t, {
      spawnServer: (executable, args, options) => {
        const child = mockServer((command) => commands.push(command));
        launches.push({ executable, args, options, child });
        setImmediate(() =>
          child.stdout.write(
            '[Server thread/INFO]: Done (1.0s)! For help, type "help"\n',
          ),
        );
        return child;
      },
    });
    await prepare(directory, { jars: [] });
    const args = await prepareForge(directory, family);
    await fs.writeFile(path.join(directory, "eula.txt"), "eula=true\n");
    const before = await snapshot(directory);
    const first = await boot();
    const inspected = (
      await first.request(
        "/api/server-import/inspect",
        json("POST", { directory }),
      )
    ).body;
    assert.equal(inspected.launchType, "java-args");
    assert.equal(inspected.launchScript, "");
    assert.equal(inspected.jar, null);
    assert.deepEqual(inspected.launchArgs, args);
    assert.equal(inspected.memoryLimitMB, 6144);
    assert.equal(inspected.launches[0].software, software);
    assert.equal(inspected.worldExists, true);
    const imported = await first.request(
      "/api/server-import",
      json("POST", {
        directory,
        launchType: "java-args",
        launchArgs: args,
        memoryLimitMB: 1024,
      }),
    );
    assert.equal(imported.status, 201);
    const id = imported.body.server.id;
    assert.equal(imported.body.server.memoryLimitMB, 6144);
    assert.equal(imported.body.server.jar, "");
    assert.equal(imported.body.server.software, software);
    assert.deepEqual(await snapshot(directory), before);
    assert.equal(launches.length, 0);
    await first.close();
    const restarted = await boot();
    const saved = (await restarted.request("/api/servers")).body.servers[0];
    assert.equal(saved.id, id);
    assert.deepEqual(saved.launchArgs, args);
    assert.deepEqual(await snapshot(directory), before);
    assert.equal(
      (
        await restarted.request(
          "/api/server/power",
          json("POST", { action: "start" }),
        )
      ).status,
      200,
    );
    await eventually(
      async () =>
        (await restarted.request("/api/server")).body.status === "running",
    );
    assert.equal(launches[0].executable, "java");
    assert.deepEqual(launches[0].args, args);
    assert.equal(launches[0].options.cwd, await fs.realpath(directory));
    assert.equal(launches[0].options.shell, false);
    assert.ok(!launches[0].args.some((arg) => arg.startsWith("-Xmx")));
    assert.equal(
      (
        await restarted.request(
          `/api/servers/${id}`,
          json("PATCH", { name: "Rename while running", launchArgs: args }),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await restarted.request(
          "/api/server/power",
          json("POST", { action: "restart" }),
        )
      ).status,
      200,
    );
    await eventually(() => launches.length === 2);
    assert.deepEqual(launches[1].args, args);
    assert.equal(
      (
        await restarted.request(
          "/api/server/power",
          json("POST", { action: "stop" }),
        )
      ).status,
      200,
    );
    await eventually(
      async () =>
        (await restarted.request("/api/server")).body.status === "offline",
    );
    assert.deepEqual(commands, ["stop\n", "stop\n"]);
    const after = await snapshot(directory);
    delete before["server.properties"];
    delete after["server.properties"];
    assert.deepEqual(after, before);
  });
}

test("startup parsing preserves quoted Java paths, explicit flags and @files without executing shell syntax", () => {
  const parsed = parseJavaScript(
    '"C:\\Program Files\\Java\\bin\\java.exe" "-Dlabel=Our world" -Xmx8G @user_jvm_args.txt @libraries\\net\\neoforged\\neoforge\\21.1.200\\win_args.txt %*',
  );
  assert.equal(parsed.javaPath, "C:\\Program Files\\Java\\bin\\java.exe");
  assert.deepEqual(parsed.args, [
    "-Dlabel=Our world",
    "-Xmx8G",
    ...forgeArgs(),
  ]);
  for (const script of [
    "java @user_jvm_args.txt & echo unwanted",
    "java @user_jvm_args.txt > output.log",
    "set JAVA=java\n%JAVA% @user_jvm_args.txt",
    "start java @user_jvm_args.txt",
    'java "unterminated',
    "call run-other.bat",
    "java @args.txt\njava @args.txt",
    "java @args.txt %DYNAMIC%",
    "java @args.txt !DYNAMIC!",
    "java @args.txt ^& echo bad",
  ])
    assert.throws(() => parseJavaScript(script), /commands beyond/);
});

test("NeoForge nogui joined directly to trailing batch arguments is recognized without accepting arbitrary percent expansion", () => {
  const files = [
    "@user_jvm_args.txt",
    "@libraries/net/neoforged/neoforge/21.1.250/win_args.txt",
  ];
  for (const noGui of ["nogui", "--nogui"]) {
    const parsed = parseJavaScript(
      `@echo off\r\nREM Keep the installed files\r\njava ${files.join(" ")} ${noGui}%*\r\npause\r\n`,
    );
    assert.deepEqual(parsed.args, [...files, noGui]);
    assert.equal(parsed.software, "NeoForge");
    assert.equal(parsed.version, "21.1.250");
  }
  for (const ending of [
    "nogui%*extra",
    "%*nogui",
    "prefix%*",
    "--nogui%JAVA%",
    "nogui%* argument",
  ]) {
    assert.throws(
      () => parseJavaScript(`java ${files.join(" ")} ${ending}`),
      /commands beyond/,
    );
  }
});

test("Java-argument imports reject missing or escaping launch files and recover when dependencies return", async (t) => {
  const { directory, prepare, boot } = await fixture(t);
  await prepare(directory, { jars: [] });
  const args = await prepareForge(directory);
  const panel = await boot();
  const importWith = (launchArgs) =>
    panel.request(
      "/api/server-import",
      json("POST", { directory, launchType: "java-args", launchArgs }),
    );
  for (const launchArgs of [
    ["@missing.txt"],
    ["@../outside.txt"],
    ["@C:/outside.txt"],
    ["-jar", "missing.jar"],
  ]) {
    const response = await importWith(launchArgs);
    assert.equal(response.status, 400);
  }
  const imported = await importWith(args);
  assert.equal(imported.status, 201);
  await panel.close();
  const argumentFile = path.join(directory, args[1].slice(1));
  const original = await fs.readFile(argumentFile);
  await fs.unlink(argumentFile);
  const restarted = await boot();
  const unavailable = (await restarted.request("/api/servers")).body.servers[0];
  assert.equal(unavailable.unavailable, true);
  assert.match(unavailable.sourceError, /Startup requires/);
  assert.equal((await restarted.request("/api/server")).status, 409);
  await fs.writeFile(argumentFile, original);
  assert.equal((await restarted.request("/api/server")).status, 200);
});

test("Java startup validates the expanded JAR entry point and ignores game arguments named -jar", async (t) => {
  const { directory, prepare } = await fixture(t);
  await prepare(directory);
  const argumentFile = path.join(directory, "startup_args.txt");
  for (const contents of [
    "-Xmx2G -jar missing.jar nogui",
    "-Xmx2G -jar ../outside.jar nogui",
    "-Xmx2G -jar",
  ]) {
    await fs.writeFile(argumentFile, contents);
    await assert.rejects(
      inspectJavaArguments(directory, ["@startup_args.txt"]),
      {
        status: 400,
      },
    );
  }
  await fs.writeFile(argumentFile, "-Xmx2G -jar server.jar nogui");
  assert.equal(
    (await inspectJavaArguments(directory, ["@startup_args.txt"]))
      .memoryLimitMB,
    2048,
  );
  for (const args of [
    ["-Xmx2G", "example.Main", "-jar", "game-option"],
    ["-Xmx2G", "-cp", "-jar", "example.Main"],
    ["-Xmx2G", "--module", "example/server", "-jar", "game-option"],
  ])
    assert.equal(
      (await inspectJavaArguments(directory, args)).memoryLimitMB,
      2048,
    );
});

test("custom script and executable imports retain explicit startup options without running anything", async (t) => {
  const { directory, root, prepare, boot } = await fixture(t, {
    spawnServer: () => assert.fail("Import cannot start a process"),
  });
  await prepare(directory, { jars: [] });
  await fs.writeFile(
    path.join(directory, "run.bat"),
    "@echo off\ncall custom-launcher.bat\n",
  );
  const before = await snapshot(directory);
  const panel = await boot();
  const inspected = (
    await panel.request(
      "/api/server-import/inspect",
      json("POST", { directory }),
    )
  ).body;
  assert.equal(inspected.launchType, "script");
  assert.equal(inspected.launchScript, "run.bat");
  const imported = await panel.request(
    "/api/server-import",
    json("POST", {
      directory,
      launchType: "script",
      launchScript: "run.bat",
      launchArgs: ["nogui"],
    }),
  );
  assert.equal(imported.status, 201);
  assert.deepEqual(imported.body.server.launchArgs, ["nogui"]);
  assert.deepEqual(await snapshot(directory), before);
  const second = await prepare(path.join(root, "Executable server"), {
    jars: [],
  });
  const custom = await panel.request(
    "/api/server-import",
    json("POST", {
      directory: second,
      port: 25572,
      launchType: "executable",
      launchExecutable: "custom-server.exe",
      launchArgs: ["--config", "config with spaces.json"],
    }),
  );
  assert.equal(custom.status, 201);
  assert.equal(custom.body.server.launchExecutable, "custom-server.exe");
  assert.deepEqual(custom.body.server.launchArgs, [
    "--config",
    "config with spaces.json",
  ]);
  const created = await panel.request(
    "/api/servers",
    json("POST", {
      name: "Fresh custom",
      port: 25573,
      launchType: "java-args",
      launchArgs: ["@not-uploaded-yet.txt"],
    }),
  );
  assert.equal(created.status, 201);
  assert.equal(
    (
      await panel.request(
        `/api/servers/${created.body.server.id}`,
        json("PATCH", { launchArgs: ["@upload-next.txt"] }),
      )
    ).status,
    200,
  );
});

test("Windows script invocation quotes spaced paths and argument boundaries and rejects shell expansion", async (t) => {
  const script = "C:\\Servers\\Our world\\run.bat";
  const invocation = buildScriptInvocation(
    script,
    ["one two", "(three)", ""],
    "win32",
  );
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args, [
    "/d",
    "/v:off",
    "/s",
    "/c",
    '""C:\\Servers\\Our world\\run.bat" "one two" "(three)" """',
  ]);
  for (const value of [
    '"',
    "%PATH%",
    "!value!",
    "x&echo y",
    "a|b",
    "a>b",
    "a<b",
    "^x",
    "a\nb",
  ])
    assert.throws(
      () => buildScriptInvocation(script, [value], "win32"),
      /cannot contain/,
    );
  assert.throws(
    () => buildScriptInvocation(script, [], "linux"),
    /require Windows/,
  );
  assert.throws(
    () => buildScriptInvocation("/server/run.sh", [], "win32"),
    /require a Unix shell/,
  );
  if (process.platform !== "win32") return;
  const { directory, prepare } = await fixture(t);
  await prepare();
  const actual = path.join(directory, "echo arguments.cmd");
  await fs.writeFile(
    actual,
    "@echo off\r\necho FIRST=%~1\r\necho SECOND=%~2\r\nexit /b 0\r\n",
  );
  const real = buildScriptInvocation(actual, ["one two", "(three)"]);
  const output = await new Promise((resolve, reject) => {
    const child = spawn(real.executable, real.args, {
      cwd: directory,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    let result = "";
    child.stdout.on("data", (chunk) => (result += chunk));
    child.stderr.on("data", (chunk) => (result += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(result) : reject(new Error(result)),
    );
  });
  assert.match(output, /FIRST=one two/);
  assert.match(output, /SECOND=\(three\)/);
});

test("Windows process termination targets the owned tree and waits for taskkill completion", async () => {
  const child = {
    pid: 12345,
    kill: () => assert.fail("Do not kill just the wrapper"),
  };
  const killer = new EventEmitter();
  let completed = false;
  const stopping = terminateProcessTree(child, {
    tree: true,
    platform: "win32",
    spawnProcess: (executable, args, options) => {
      assert.match(executable, /System32\\taskkill\.exe$/i);
      assert.deepEqual(args, ["/PID", "12345", "/T", "/F"]);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      return killer;
    },
  }).then(() => (completed = true));
  await Promise.resolve();
  assert.equal(completed, false);
  killer.emit("close", 0);
  await stopping;
  assert.equal(completed, true);
});

test("startup configuration rejects malformed arguments and paths", () => {
  for (const config of [
    { launchType: "unknown" },
    { launchType: "java-args", launchArgs: [] },
    { launchType: "java-args", launchArgs: ["a\nb"] },
    { launchType: "java-args", launchArgs: "--flags" },
    { launchType: "script", launchScript: "../run.bat" },
    { launchType: "script", launchScript: "C:/run.bat" },
    { launchType: "executable", launchExecutable: "run.bat" },
  ])
    assert.throws(() => validateServerConfiguration(config));
});

test("custom launcher restart waits for the entire owned tree after its wrapper exits", async (t) => {
  const launches = [];
  const killers = [];
  const { directory, prepare, boot } = await fixture(t, {
    stopTimeoutMs: 5,
    spawnServer: () => {
      const child = mockServer();
      child.pid = 12345 + launches.length;
      // This wrapper does not exit in response to stop; its tree must be drained.
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      launches.push(child);
      return child;
    },
    spawnProcess: () => {
      const killer = new EventEmitter();
      killers.push(killer);
      return killer;
    },
  });
  await prepare(directory, { jars: [] });
  await fs.writeFile(
    path.join(directory, "run.bat"),
    "call custom-server.bat\n",
  );
  await fs.writeFile(path.join(directory, "eula.txt"), "eula=true\n");
  const panel = await boot();
  assert.equal(
    (
      await panel.request(
        "/api/server-import",
        json("POST", {
          directory,
          launchType: "script",
          launchScript: "run.bat",
        }),
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await panel.request(
        "/api/server/power",
        json("POST", { action: "start" }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await panel.request(
        "/api/server/power",
        json("POST", { action: "restart" }),
      )
    ).status,
    200,
  );
  await eventually(() => killers.length === 1);
  launches[0].emit("close", 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(launches.length, 1);
  assert.equal((await panel.request("/api/server")).body.status, "stopping");
  assert.equal(
    (
      await panel.request(
        "/api/server/power",
        json("POST", { action: "start" }),
      )
    ).status,
    409,
  );
  killers[0].emit("close", 0);
  await eventually(() => launches.length === 2);
  let closed = false;
  const closing = panel.close().then(() => (closed = true));
  await eventually(() => killers.length === 2);
  launches[1].emit("close", 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, false);
  killers[1].emit("close", 0);
  await closing;
  assert.equal(closed, true);
});

test("graceful-only fleet shutdown cancels an existing stop deadline and waits for the world save", async (t) => {
  const child = mockServer();
  const commands = [];
  child.pid = 12345;
  child.kill = () =>
    assert.fail("An update must not force-kill the saving server");
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      commands.push(chunk.toString());
      callback();
    },
  });
  const { directory, prepare, boot } = await fixture(t, {
    stopTimeoutMs: 30,
    spawnServer: () => child,
    spawnProcess: () =>
      assert.fail("An update must not terminate the process tree"),
  });
  await prepare(directory, { jars: [] });
  await fs.writeFile(
    path.join(directory, "run.bat"),
    "call custom-server.bat\n",
  );
  await fs.writeFile(path.join(directory, "eula.txt"), "eula=true\n");
  const panel = await boot();
  await panel.request(
    "/api/server-import",
    json("POST", { directory, launchType: "script", launchScript: "run.bat" }),
  );
  await panel.request("/api/server/power", json("POST", { action: "start" }));
  await panel.request("/api/server/power", json("POST", { action: "stop" }));
  let completed = false;
  const closing = panel
    .close({ gracefulOnly: true })
    .then(() => (completed = true));
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(completed, false);
    assert.ok(commands.every((command) => command === "stop\n"));
  } finally {
    child.emit("close", 0);
  }
  await closing;
  assert.equal(completed, true);
});

test("an imported folder disappearing during the session does not block unrelated import or creation", async (t) => {
  const { root, directory, prepare, boot } = await fixture(t);
  await prepare();
  const panel = await boot();
  assert.equal(
    (
      await panel.request(
        "/api/server-import",
        json("POST", { directory, jar: "server.jar" }),
      )
    ).status,
    201,
  );
  const parked = path.join(root, "Parked original");
  assert.equal(path.dirname(directory), root);
  assert.equal(path.dirname(parked), root);
  await fs.rename(directory, parked);
  const second = await prepare(path.join(root, "Second import"));
  assert.equal(
    (
      await panel.request(
        "/api/server-import",
        json("POST", { directory: second, jar: "server.jar", port: 25572 }),
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await panel.request(
        "/api/servers",
        json("POST", { name: "Independent", port: 25573 }),
      )
    ).status,
    201,
  );
  await assert.rejects(fs.access(directory));
});

test("Java metadata reads the last actual heap option and NeoForge version without mistaking comments or game arguments", async (t) => {
  const { directory, prepare } = await fixture(t);
  await prepare(directory, { jars: [] });
  const args = await prepareForge(directory);
  const jvmFile = path.join(directory, "user_jvm_args.txt");
  await fs.writeFile(
    jvmFile,
    '# -Xmx1G is only an example\n-Xms6G -Xmx12G\n-XX:+UseZGC\n-XX:+ZGenerational\n-Dnote="Example # -Xmx99G"\n',
  );
  const before = await snapshot(directory);
  const metadata = await inspectJavaArguments(directory, [...args, "-Xmx99G"]);
  assert.equal(metadata.memoryLimitMB, 12 * 1024);
  assert.equal(metadata.software, "NeoForge");
  assert.equal(metadata.version, "21.1.200");
  assert.equal(
    (
      await inspectJavaArguments(directory, [
        args[0],
        "-Xmx14G",
        ...args.slice(1),
      ])
    ).memoryLimitMB,
    14336,
  );
  assert.deepEqual(await snapshot(directory), before);
  const variants = [
    ['-Xmx3G\n"-Xmx12288M"\n', 12288],
    ["-Xmx12884901888\n", 12288],
    ["-Xmx1G -XX:MaxHeapSize=12G\n", 12288],
    ["# -Xmx12G\n-Xms6G\n-XX:MaxRAMPercentage=60\n", null],
    ['-Xmx2G -cp "libraries with spaces/*" Main -Xmx12G\n', 2048],
  ];
  for (const [contents, expected] of variants) {
    await fs.writeFile(jvmFile, contents);
    assert.equal(
      (await inspectJavaArguments(directory, args)).memoryLimitMB,
      expected,
    );
  }
});

for (const launchType of ["java-args", "script"]) {
  test(
    `${launchType} metadata repairs existing registrations and preserves the running launch snapshot until restart`,
    { skip: launchType === "script" && process.platform !== "win32" },
    async (t) => {
      const launches = [];
      const { directory, dataDir, prepare, boot } = await fixture(t, {
        startupMetadataTtlMs: 0,
        spawnServer(executable, args, options) {
          const child = mockServer();
          launches.push({ executable, args, options, child });
          setImmediate(() =>
            child.stdout.write(
              '[Server thread/INFO]: Done (1s)! For help, type "help"\n',
            ),
          );
          return child;
        },
      });
      await prepare(directory, { jars: [] });
      const args = await prepareForge(directory);
      const neoArgs = "libraries/net/neoforged/neoforge/21.1.250/win_args.txt";
      await fs.mkdir(path.dirname(path.join(directory, neoArgs)), {
        recursive: true,
      });
      await fs.rename(
        path.join(directory, args[1].slice(1)),
        path.join(directory, neoArgs),
      );
      args[1] = `@${neoArgs}`;
      const jvmFile = path.join(directory, "user_jvm_args.txt");
      const originalJvm = [
        "# Xmx and Xms set the maximum and minimum RAM usage, respectively.",
        "# They can take any number, followed by an M or a G.",
        "# M means Megabyte, G means Gigabyte.",
        "# For example, to set the maximum to 3GB: -Xmx3G",
        "# To set the minimum to 2.5GB: -Xms2500M",
        "-Xms6G",
        "-Xmx12G",
        "-XX:+UseZGC",
        "-XX:+ZGenerational",
        "-XX:+DisableExplicitGC",
        "",
      ].join("\r\n");
      await fs.writeFile(jvmFile, originalJvm);
      const originalScript = [
        "@echo off",
        "REM Forge requires a configured set of both JVM and program arguments.",
        "REM Add custom JVM arguments to the user_jvm_args.txt",
        "REM Add custom program arguments {such as nogui} to this file in the next line before the %* or",
        "REM  pass them to this script directly",
        `java ${args.slice(0, 2).join(" ")} ${launchType === "script" ? "nogui%*" : "%*"}`,
        "pause",
        "",
      ].join("\r\n");
      await fs.writeFile(path.join(directory, "run.bat"), originalScript);
      await fs.writeFile(path.join(directory, "eula.txt"), "eula=true\n");
      const original = await snapshot(directory);
      const first = await boot();
      const inspected = (
        await first.request(
          "/api/server-import/inspect",
          json("POST", { directory }),
        )
      ).body;
      assert.equal(inspected.version, "21.1.250");
      assert.equal(inspected.memoryLimitMB, 12288);
      const imported = await first.request(
        "/api/server-import",
        json("POST", {
          directory,
          launchType,
          ...(launchType === "script"
            ? { launchScript: "run.bat" }
            : { launchArgs: args }),
        }),
      );
      assert.equal(imported.status, 201, JSON.stringify(imported.body));
      const id = imported.body.server.id;
      assert.equal(imported.body.server.configuredMemoryLimitMB, 12288);
      assert.equal(imported.body.server.version, "21.1.250");
      if (launchType === "script")
        assert.deepEqual(imported.body.server.launchArgs, []);
      assert.deepEqual(await snapshot(directory), original);
      await first.close();
      // Simulate a registration saved by the earlier version of the desktop app.
      const registryFile = path.join(dataDir, "servers.json");
      const registry = JSON.parse(await fs.readFile(registryFile, "utf8"));
      Object.assign(registry.servers[0], {
        memoryLimitMB: 4096,
        version: "Configured launch",
        software: "Java",
      });
      await fs.writeFile(registryFile, JSON.stringify(registry));
      const panel = await boot();
      const read = async () => (await panel.request("/api/server")).body;
      const restored = (await panel.request("/api/servers")).body.servers[0];
      assert.equal(restored.configuredMemoryLimitMB, 12288);
      assert.equal(restored.software, "NeoForge");
      assert.equal(restored.version, "21.1.250");
      if (launchType === "script") assert.deepEqual(restored.launchArgs, []);
      assert.equal((await read()).memoryLimit, 12 * 1024 ** 3);
      assert.equal((await read()).memoryLimitState, "configured");
      assert.deepEqual(await snapshot(directory), original);
      assert.equal(
        (
          await panel.request(
            "/api/server/power",
            json("POST", { action: "start" }),
          )
        ).status,
        200,
      );
      await eventually(async () => (await read()).status === "running");
      assert.equal((await read()).memoryLimitState, "started");
      assert.equal((await read()).memoryLimitSource, "launch");
      assert.equal(await fs.readFile(jvmFile, "utf8"), originalJvm);
      assert.equal(
        await fs.readFile(path.join(directory, "run.bat"), "utf8"),
        originalScript,
      );
      if (launchType === "script") {
        const invocation = buildScriptInvocation(
          path.join(await fs.realpath(directory), "run.bat"),
          [],
        );
        assert.equal(launches[0].executable, invocation.executable);
        assert.deepEqual(launches[0].args, invocation.args);
        assert.equal(launches[0].options.cwd, await fs.realpath(directory));
      }
      await fs.writeFile(jvmFile, "-Xms6G -Xmx16G\n-XX:+UseZGC\n");
      assert.equal((await read()).memoryLimit, 12 * 1024 ** 3);
      assert.equal(
        (await panel.request("/api/servers")).body.servers[0]
          .configuredMemoryLimitMB,
        12288,
      );
      assert.equal(
        (
          await panel.request(
            `/api/servers/${id}`,
            json("PATCH", { name: "Safe rename" }),
          )
        ).status,
        200,
      );
      assert.equal((await read()).memoryLimit, 12 * 1024 ** 3);
      assert.equal(
        (
          await panel.request(
            "/api/server/power",
            json("POST", { action: "restart" }),
          )
        ).status,
        200,
      );
      await eventually(
        async () =>
          launches.length === 2 && (await read()).status === "running",
      );
      assert.equal((await read()).memoryLimit, 16 * 1024 ** 3);
      assert.equal((await read()).version, "21.1.250");
      assert.equal(
        await fs.readFile(path.join(directory, "run.bat"), "utf8"),
        originalScript,
      );
      assert.equal(
        await fs.readFile(jvmFile, "utf8"),
        "-Xms6G -Xmx16G\n-XX:+UseZGC\n",
      );
      assert.deepEqual(launches[1].args, launches[0].args);
      assert.equal(
        (
          await panel.request(
            "/api/server/power",
            json("POST", { action: "stop" }),
          )
        ).status,
        200,
      );
      await eventually(async () => (await read()).status === "offline");
      await fs.writeFile(jvmFile, "-Xms6G\n-XX:MaxRAMPercentage=60\n");
      assert.equal((await read()).memoryLimit, null);
      assert.equal((await read()).memoryLimitSource, "unknown");
      assert.equal((await read()).version, "21.1.250");
    },
  );
}

test("generic wrappers report unknown heap and version instead of borrowing unrelated JVM files", async (t) => {
  const { directory, prepare, boot } = await fixture(t, {
    startupMetadataTtlMs: 0,
  });
  await prepare(directory, { jars: [] });
  await prepareForge(directory);
  await fs.writeFile(
    path.join(directory, "run.bat"),
    "@echo off\nset JAVA=java\n%JAVA% @user_jvm_args.txt\npause\n",
  );
  assert.deepEqual(
    await validateStartupFiles(directory, {
      launchType: "script",
      launchScript: "run.bat",
    }),
    {},
  );
  const panel = await boot();
  const response = await panel.request(
    "/api/server-import",
    json("POST", { directory, launchType: "script", launchScript: "run.bat" }),
  );
  assert.equal(response.status, 201);
  const server = (await panel.request("/api/server")).body;
  assert.equal(server.memoryLimit, null);
  assert.equal(server.memoryLimitSource, "unknown");
  assert.equal(server.version, "Unknown");
  assert.equal(response.body.server.configuredMemoryLimitMB, null);
});

for (const initialLaunch of ["java-args", "jar"]) {
  test(`selecting a new server JAR clears the previous ${initialLaunch} build labels and persists them`, async (t) => {
    const { directory, dataDir, prepare, boot } = await fixture(t);
    await prepare(directory, { jars: ["server.jar", "replacement.jar"] });
    const args = await prepareForge(directory);
    const before = await snapshot(directory);
    const first = await boot();
    const imported = await first.request(
      "/api/server-import",
      json("POST", {
        directory,
        launchType: initialLaunch,
        ...(initialLaunch === "java-args"
          ? { launchArgs: args }
          : { jar: "server.jar" }),
      }),
    );
    assert.equal(imported.status, 201);
    const id = imported.body.server.id;
    await first.close();
    // A previous build may have retained a detected label on its registration.
    const registryFile = path.join(dataDir, "servers.json");
    const registry = JSON.parse(await fs.readFile(registryFile, "utf8"));
    Object.assign(registry.servers[0], {
      software: "NeoForge",
      version: "21.1.200",
    });
    await fs.writeFile(registryFile, JSON.stringify(registry));
    const panel = await boot();
    assert.equal(
      (await panel.request("/api/server")).body.software,
      "NeoForge",
    );
    const changed = await panel.request(
      `/api/servers/${id}`,
      json("PATCH", {
        launchType: "jar",
        jar: "replacement.jar",
      }),
    );
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.server.software, "Java");
    assert.equal(changed.body.server.version, "Configured JAR");
    assert.equal((await panel.request("/api/server")).body.software, "Java");
    assert.deepEqual(await snapshot(directory), before);
    await panel.close();
    const restored = await boot();
    const server = (await restored.request("/api/server")).body;
    assert.equal(server.software, "Java");
    assert.equal(server.version, "Configured JAR");
  });
}
