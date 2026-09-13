import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as tar from "tar";
import { createRecycleBin } from "./recycle-bin.mjs";
import { createPanel, createFleet, safePath } from "./index.mjs";

const json = (method, body = {}) => ({ method, body: JSON.stringify(body) });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const missing = async (target) =>
  assert.rejects(fs.stat(target), { code: "ENOENT" });
const exdev = () =>
  Object.assign(new Error("fixture crosses volumes"), { code: "EXDEV" });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-recycle-test-"));
  const dataDir = path.join(root, "panel");
  const serverDir = path.join(root, "existing-minecraft");
  await fs.mkdir(dataDir);
  await fs.mkdir(serverDir);
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-recycle-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const boot = (options = {}) =>
    createRecycleBin({ dataDir, serverDir, safePath, ...options });
  return { root, dataDir, serverDir, boot };
}

async function apiFixture(t, options = {}) {
  const f = await fixture(t);
  const runtimes = [];
  const listeners = [];
  const releases = [];
  const boot = async (extra = {}) => {
    const create = extra.fleet ? createFleet : createPanel;
    const panel = await create({
      dataDir: f.dataDir,
      serverDir: f.serverDir,
      useEnvironment: false,
      scheduler: false,
      publicAddress: { resolve: async () => null },
      ...options,
      ...extra,
    });
    runtimes.push(panel);
    const listener = await new Promise((resolve) => {
      const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
    });
    listeners.push(listener);
    const base = `http://127.0.0.1:${listener.address().port}`;
    const request = async (route, init = {}, id) => {
      const response = await fetch(base + route, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(id ? { "X-Server-Id": id } : {}),
          ...init.headers,
        },
      });
      return { status: response.status, body: await response.json() };
    };
    return { ...panel, request };
  };
  // Teardown registered by the enclosing test runs before the fixture's own
  // cleanup through this explicit drain (node:test hooks are registration order).
  const close = async () => {
    for (const release of releases) release();
    for (const panel of runtimes) await panel.close();
    for (const listener of listeners) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
  };
  return { ...f, boot, close, releases };
}

function crossVolume(source, overrides = {}) {
  return {
    ...fs,
    rename: async (from, to) => {
      if (
        path.resolve(from) === path.resolve(source) &&
        path.basename(to) === "content"
      )
        throw exdev();
      return fs.rename(from, to);
    },
    ...overrides,
  };
}

test("recycle file outside imported tree, survive restart, and restore its bytes and modification time", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.serverDir, "run.sh");
  const content = Buffer.from("#!/bin/sh\nexec java -jar server.jar\n");
  await fs.writeFile(source, content, { mode: 0o755 });
  await fs.utimes(source, new Date("2020-01-01Z"), new Date("2020-01-01Z"));
  const before = await fs.stat(source);
  const bin = await f.boot();
  const item = await bin.recycle("run.sh");
  await missing(source);
  assert.equal(item.status, "ready");
  assert.equal(item.originalPath, "run.sh");
  assert.equal(item.size, content.length);
  assert.equal(path.dirname(bin.directory), f.dataDir);
  assert.deepEqual(await fs.readdir(f.serverDir), []);
  const restarted = await f.boot();
  assert.deepEqual(await restarted.list(), [item]);
  assert.equal(await restarted.restore(item.id), "run.sh");
  assert.deepEqual(await fs.readFile(source), content);
  const after = await fs.stat(source);
  assert.equal(after.mode & 0o777, before.mode & 0o777);
  assert.ok(Math.abs(after.mtimeMs - before.mtimeMs) < 2);
  assert.deepEqual(await restarted.list(), []);
});

test("recursive recovery recreates missing parents, empty folders, binary files and refuses overwrite", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.serverDir, "world", "region", "empty"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(f.serverDir, "world", "region", "r.0.0.mca"),
    Buffer.from([0, 255, 5, 9]),
  );
  const bin = await f.boot();
  const item = await bin.recycle("world//region");
  assert.equal(item.originalPath, "world/region");
  assert.equal(item.type, "directory");
  assert.equal(item.size, 4);
  await fs.mkdir(path.join(f.serverDir, "world", "region"));
  await fs.writeFile(
    path.join(f.serverDir, "world", "region", "new.txt"),
    "never replace me",
  );
  await assert.rejects(bin.restore(item.id), /already exists/);
  assert.equal(
    await fs.readFile(
      path.join(f.serverDir, "world", "region", "new.txt"),
      "utf8",
    ),
    "never replace me",
  );
  const newer = await bin.recycle("world/region");
  await fs.rmdir(path.join(f.serverDir, "world"));
  await bin.restore(item.id);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "world", "region", "r.0.0.mca")),
    Buffer.from([0, 255, 5, 9]),
  );
  assert.deepEqual(
    await fs.readdir(path.join(f.serverDir, "world", "region", "empty")),
    [],
  );
  assert.equal((await bin.list())[0].id, newer.id);
});

test("paths, root deletion, nested junctions and changed restore parents cannot escape boundaries", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "proof"), "protected");
  const bin = await f.boot();
  for (const relative of [
    "",
    "/",
    ".",
    "../outside",
    "C:/Windows",
    "world\\region",
  ])
    await assert.rejects(bin.recycle(relative));
  await assert.rejects(bin.restore("../outside"));
  await fs.mkdir(path.join(f.serverDir, "world"));
  await fs.symlink(
    outside,
    path.join(f.serverDir, "world", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(bin.recycle("world"), /symbolic links/i);
  await fs.unlink(path.join(f.serverDir, "world", "linked"));
  await fs.writeFile(path.join(f.serverDir, "world", "proof"), "restore me");
  const item = await bin.recycle("world/proof");
  await fs.rmdir(path.join(f.serverDir, "world"));
  await fs.symlink(
    outside,
    path.join(f.serverDir, "world"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(bin.restore(item.id), /symbolic links/i);
  assert.equal(
    await fs.readFile(path.join(outside, "proof"), "utf8"),
    "protected",
  );
  await fs.unlink(path.join(f.serverDir, "world"));
  assert.equal((await bin.list())[0].id, item.id);
});

test("a substituted private storage junction is rejected without reading or modifying its target", async (t) => {
  const f = await fixture(t);
  const bin = await f.boot();
  const original = path.join(f.dataDir, "preserved-bin");
  await fs.rename(bin.directory, original);
  await fs.symlink(
    f.serverDir,
    bin.directory,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(bin.list(), /symbolic links/i);
  await fs.writeFile(path.join(f.serverDir, "proof"), "preserve");
  await assert.rejects(bin.recycle("proof"), /symbolic links/i);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "proof"), "utf8"),
    "preserve",
  );
  await fs.unlink(bin.directory);
});

test("restore revalidates its anchored destination after a parent junction changes during journaling", async (t) => {
  const f = await fixture(t);
  const parent = path.join(f.serverDir, "world");
  const outside = path.join(f.root, "outside");
  await fs.mkdir(parent);
  await fs.mkdir(outside);
  await fs.writeFile(
    path.join(parent, "proof"),
    "recovery must stay in the server",
  );
  const bin = await f.boot();
  const item = await bin.recycle("world/proof");
  const raced = await f.boot({
    fileSystem: {
      ...fs,
      rename: async (from, to) => {
        if (
          path.basename(to) === "entry.json" &&
          JSON.parse(await fs.readFile(from, "utf8")).phase === "restoring"
        ) {
          await fs.rmdir(parent);
          await fs.symlink(
            outside,
            parent,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        return fs.rename(from, to);
      },
    },
  });
  await assert.rejects(raced.restore(item.id), /symbolic links/i);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(parent);
  assert.equal((await bin.list())[0].status, "ready");
  await bin.restore(item.id);
  assert.equal(
    await fs.readFile(path.join(parent, "proof"), "utf8"),
    "recovery must stay in the server",
  );
});

test("cross-volume recycle verifies copies before source removal and restores executable metadata", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.serverDir, "world");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "launch.sh"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  await fs.utimes(
    path.join(source, "launch.sh"),
    new Date("2021-01-01Z"),
    new Date("2021-01-01Z"),
  );
  const stat = await fs.stat(path.join(source, "launch.sh"));
  const bin = await f.boot({ fileSystem: crossVolume(source) });
  const item = await bin.recycle("world");
  await missing(source);
  await bin.restore(item.id);
  assert.equal(
    await fs.readFile(path.join(source, "launch.sh"), "utf8"),
    "#!/bin/sh\n",
  );
  const restored = await fs.stat(path.join(source, "launch.sh"));
  assert.equal(restored.mode & 0o777, stat.mode & 0o777);
  assert.ok(Math.abs(restored.mtimeMs - stat.mtimeMs) < 2);
});

test("a live cross-drive recycle is refused while preserving the original", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.serverDir, "file.txt");
  await fs.writeFile(source, "running server file");
  const bin = await f.boot({
    fileSystem: crossVolume(source),
    allowCrossVolume: () => false,
  });
  await assert.rejects(bin.recycle("file.txt"), /Stop this server/);
  assert.equal(await fs.readFile(source, "utf8"), "running server file");
  assert.deepEqual(await bin.list(), []);
});

test("read-only files keep their original mode after cross-volume recovery", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.serverDir, "locked.txt");
  await fs.writeFile(source, "read-only source");
  await fs.chmod(source, 0o444);
  const originalMode = (await fs.stat(source)).mode & 0o777;
  const bin = await f.boot({ fileSystem: crossVolume(source) });
  const item = await bin.recycle("locked.txt");
  await bin.restore(item.id);
  assert.equal(await fs.readFile(source, "utf8"), "read-only source");
  assert.equal((await fs.stat(source)).mode & 0o777, originalMode);
});

test("failed source removal retains both source and a usable verified recovery copy", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.serverDir, "proof");
  await fs.writeFile(source, "still recoverable");
  const bin = await f.boot({
    fileSystem: crossVolume(source, {
      rm: async (target, options) => {
        if (path.resolve(target) === path.resolve(source))
          throw new Error("injected source removal failure");
        return fs.rm(target, options);
      },
    }),
  });
  await assert.rejects(bin.recycle("proof"), /removal failure/);
  assert.equal(await fs.readFile(source, "utf8"), "still recoverable");
  const [item] = await (await f.boot()).list();
  assert.equal(item.status, "ready");
  assert.equal(
    await fs.readFile(path.join(bin.directory, item.id, "content"), "utf8"),
    "still recoverable",
  );
});

test("interrupted cross-drive copying preserves originals and marks partial recovery as incomplete", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.serverDir, "world");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "a"), "first");
  await fs.writeFile(path.join(source, "b"), "second");
  const bin = await f.boot({
    fileSystem: crossVolume(source, {
      copyFile: async (from, to, flag) => {
        if (path.basename(from) === "b") throw new Error("injected disk full");
        return fs.copyFile(from, to, flag);
      },
    }),
  });
  await assert.rejects(bin.recycle("world"), /disk full/);
  assert.deepEqual(await fs.readdir(source), ["a", "b"]);
  const restarted = await f.boot();
  const [item] = await restarted.list();
  assert.equal(item.status, "incomplete");
  await assert.rejects(restarted.restore(item.id), /incomplete/);
  assert.equal(
    await fs.readFile(
      path.join(bin.directory, item.id, "content", "a"),
      "utf8",
    ),
    "first",
  );
});

for (const change of ["add", "edit-same-size-and-mtime"]) {
  test(`late ${change} during cross-drive commit preserves the changed source and verified recovery`, async (t) => {
    const f = await fixture(t);
    const source = path.join(f.serverDir, "world");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "a"), "first");
    const stat = await fs.stat(path.join(source, "a"));
    const io = crossVolume(source);
    const rename = io.rename;
    io.rename = async (from, to) => {
      if (
        path.basename(to) === "entry.json" &&
        JSON.parse(await fs.readFile(from, "utf8")).phase === "copied"
      ) {
        if (change === "add")
          await fs.writeFile(path.join(source, "late"), "new world data");
        else {
          await fs.writeFile(path.join(source, "a"), "other");
          await fs.utimes(path.join(source, "a"), stat.atime, stat.mtime);
        }
      }
      return rename(from, to);
    };
    const bin = await f.boot({ fileSystem: io });
    await assert.rejects(bin.recycle("world"), /source changed/i);
    assert.equal(
      await fs.readFile(path.join(source, "a"), "utf8"),
      change === "add" ? "first" : "other",
    );
    const [item] = await bin.list();
    assert.equal(item.status, "ready");
    assert.equal(
      await fs.readFile(
        path.join(bin.directory, item.id, "content", "a"),
        "utf8",
      ),
      "first",
    );
    await assert.rejects(bin.restore(item.id), /already exists/);
  });
}

test("failed final journal after atomic rename remains recoverable after restart", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.serverDir, "proof"), "recover after crash");
  const bin = await f.boot({
    fileSystem: {
      ...fs,
      rename: async (from, to) => {
        if (
          path.basename(to) === "entry.json" &&
          JSON.parse(await fs.readFile(from, "utf8")).phase === "ready"
        )
          throw new Error("injected interrupted final journal");
        return fs.rename(from, to);
      },
    },
  });
  await assert.rejects(bin.recycle("proof"), /interrupted/);
  await missing(path.join(f.serverDir, "proof"));
  const restarted = await f.boot();
  const [item] = await restarted.list();
  assert.equal(item.status, "ready");
  await restarted.restore(item.id);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "proof"), "utf8"),
    "recover after crash",
  );
});

test("failed restore retains archive and partial new destination without overwriting on retry", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.serverDir, "world"));
  await fs.writeFile(path.join(f.serverDir, "world", "a"), "first");
  await fs.writeFile(path.join(f.serverDir, "world", "b"), "second");
  const bin = await f.boot();
  const item = await bin.recycle("world");
  const broken = await f.boot({
    fileSystem: {
      ...fs,
      copyFile: async (from, to, flag) => {
        if (path.basename(from) === "b")
          throw new Error("injected restore failure");
        return fs.copyFile(from, to, flag);
      },
    },
  });
  await assert.rejects(broken.restore(item.id), /restore failure/);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "world", "a"), "utf8"),
    "first",
  );
  assert.equal((await bin.list())[0].status, "ready");
  await assert.rejects(bin.restore(item.id), /already exists/);
  const partial = await bin.recycle("world");
  await bin.restore(item.id);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "world", "b"), "utf8"),
    "second",
  );
  assert.equal((await bin.list())[0].id, partial.id);
});

test("file APIs expose a protected bin, restore across restart and reject unsupported mutations", async (t) => {
  const f = await apiFixture(t, { existingServerDir: true });
  try {
    const panel = await f.boot();
    await fs.writeFile(path.join(f.serverDir, "proof"), "original data");
    const deleted = await panel.request("/api/files?path=proof", {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted));
    assert.equal(deleted.body.ok, true);
    const id = deleted.body.recycled.id;
    const listing = await panel.request("/api/files/recycle-bin");
    assert.equal(listing.body.protected, true);
    assert.equal(listing.body.items[0].id, id);
    assert.deepEqual((await panel.request("/api/files")).body.entries, []);
    assert.equal(
      (await panel.request("/api/files?path=../recycle-bin")).status,
      400,
    );
    assert.equal(
      (
        await panel.request(`/api/files/recycle-bin/${id}`, {
          method: "DELETE",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await panel.request(
          `/api/files/recycle-bin/${randomUUID()}/restore`,
          json("POST"),
        )
      ).status,
      404,
    );
    await panel.close();
    const restarted = await f.boot();
    const restored = await restarted.request(
      `/api/files/recycle-bin/${id}/restore`,
      json("POST"),
    );
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body, { ok: true, path: "proof" });
    assert.equal(
      await fs.readFile(path.join(f.serverDir, "proof"), "utf8"),
      "original data",
    );
    assert.deepEqual(
      (await restarted.request("/api/files/recycle-bin")).body.items,
      [],
    );
  } finally {
    await f.close();
  }
});

test("fleet recycle data belongs only to its server", async (t) => {
  const f = await apiFixture(t);
  try {
    const panel = await f.boot({ fleet: true });
    const first = (await panel.request("/api/servers")).body.defaultServerId;
    const created = await panel.request(
      "/api/servers",
      json("POST", {
        name: "Second",
        mode: "demo",
        port: 25566,
        memoryLimitMB: 2048,
      }),
    );
    assert.equal(created.status, 201);
    const second = created.body.server.id;
    assert.equal(
      (
        await panel.request(
          "/api/files",
          json("POST", {
            name: "private",
            type: "file",
            content: "server one",
          }),
          first,
        )
      ).status,
      201,
    );
    const deleted = await panel.request(
      "/api/files?path=private",
      { method: "DELETE" },
      first,
    );
    assert.equal(deleted.status, 200);
    const id = deleted.body.recycled.id;
    assert.deepEqual(
      (await panel.request("/api/files/recycle-bin", {}, second)).body.items,
      [],
    );
    assert.equal(
      (
        await panel.request(
          `/api/files/recycle-bin/${id}/restore`,
          json("POST"),
          second,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await panel.request(
          `/api/files/recycle-bin/${id}/restore`,
          json("POST"),
          first,
        )
      ).status,
      200,
    );
    assert.equal(
      (await panel.request("/api/files/content?path=private", {}, second))
        .status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("backups block recycling and restoring and exclude protected recovery storage", async (t) => {
  const f = await apiFixture(t);
  const entered = deferred();
  const release = deferred();
  f.releases.push(release.resolve);
  try {
    const panel = await f.boot();
    await fs.writeFile(
      path.join(f.serverDir, "deleted"),
      "only in recovery storage",
    );
    await fs.writeFile(path.join(f.serverDir, "active"), "in server backup");
    const removed = await panel.request("/api/files?path=deleted", {
      method: "DELETE",
    });
    const id = removed.body.recycled.id;
    const originalRename = fs.rename;
    t.mock.method(fs, "rename", async (from, to) => {
      if (from.endsWith(".tar.gz.tmp")) {
        entered.resolve();
        await release.promise;
      }
      return originalRename(from, to);
    });
    const backup = panel.request(
      "/api/backups",
      json("POST", { name: "Protected archive" }),
    );
    await Promise.race([
      entered.promise,
      backup.then((result) => {
        throw new Error(
          `Backup completed before gated rename: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    assert.equal(
      (await panel.request("/api/files?path=active", { method: "DELETE" }))
        .status,
      409,
    );
    assert.equal(
      (
        await panel.request(
          `/api/files/recycle-bin/${id}/restore`,
          json("POST"),
        )
      ).status,
      409,
    );
    assert.equal(
      await fs.readFile(path.join(f.serverDir, "active"), "utf8"),
      "in server backup",
    );
    release.resolve();
    const completed = await backup;
    assert.equal(completed.status, 201);
    const entries = [];
    await tar.t({
      file: path.join(f.dataDir, "backups", `${completed.body.id}.tar.gz`),
      onReadEntry: (entry) => entries.push(entry.path),
    });
    assert.ok(entries.some((entry) => entry.endsWith("active")));
    assert.ok(
      entries.every(
        (entry) => !entry.includes("recycle-bin") && !entry.endsWith("deleted"),
      ),
    );
    assert.equal(
      (
        await panel.request(
          `/api/files/recycle-bin/${id}/restore`,
          json("POST"),
        )
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("a gated restore excludes other mutations and backups, and graceful shutdown waits even after disconnect", async (t) => {
  const f = await apiFixture(t);
  const entered = deferred();
  const release = deferred();
  f.releases.push(release.resolve);
  try {
    const panel = await f.boot();
    await fs.writeFile(path.join(f.serverDir, "proof"), "drain before update");
    const deleted = await panel.request("/api/files?path=proof", {
      method: "DELETE",
    });
    const id = deleted.body.recycled.id;
    const target = path.join(await fs.realpath(f.serverDir), "proof");
    const originalCopy = fs.copyFile;
    t.mock.method(fs, "copyFile", async (from, to, flags) => {
      if (to === target) {
        entered.resolve();
        await release.promise;
      }
      return originalCopy(from, to, flags);
    });
    const abort = new AbortController();
    const pending = panel
      .request(`/api/files/recycle-bin/${id}/restore`, {
        ...json("POST"),
        signal: abort.signal,
      })
      .catch((cause) => cause);
    await Promise.race([
      entered.promise,
      pending.then((response) => {
        throw new Error(
          `Restore completed before its gated copy: ${JSON.stringify(response)}`,
        );
      }),
    ]);
    for (const [route, body] of [
      ["/api/files", { name: "race", type: "file", content: "no" }],
      ["/api/backups", { name: "blocked" }],
      ["/api/server/power", { action: "start" }],
      [`/api/files/recycle-bin/${id}/restore`, {}],
    ])
      assert.equal(
        (await panel.request(route, json("POST", body))).status,
        409,
        route,
      );
    abort.abort();
    await pending;
    let closed = false;
    const closing = panel.close({ gracefulOnly: true }).then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, false);
    release.resolve();
    await closing;
    assert.equal(await fs.readFile(target, "utf8"), "drain before update");
    assert.deepEqual(
      await (
        await f.boot()
      )
        .request("/api/files/recycle-bin")
        .then((result) => result.body.items),
      [],
    );
  } finally {
    await f.close();
  }
});
