import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { createFleet } from "./index.mjs";
import { parseProperties } from "./import.mjs";

const json = (method, body) => ({ method, body: JSON.stringify(body) });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-import-test-"));
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
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
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
