import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
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
  // Windows CI can expose TEMP through an 8.3 alias. Fault injection and
  // imported-folder identities must compare the same canonical paths as the API.
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-recycle-test-")),
  );
  const dataDir = path.join(root, "panel");
  const serverDir = path.join(root, "existing-minecraft");
  await fs.mkdir(dataDir);
  await fs.mkdir(serverDir);
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-recycle-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const boot = (options = {}) =>
    createRecycleBin({ dataDir, serverDir, safePath, ...options });
  return { root, dataDir, serverDir, boot };
}

test("restore inspection hashes only the validated recycled mod and exposes no private payload path", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.serverDir, "mods"));
  const bytes = Buffer.from("recycled mod bytes");
  await fs.writeFile(path.join(f.serverDir, "mods", "example.jar"), bytes);
  const bin = await f.boot();
  const entry = await bin.recycle("mods/example.jar");
  const inspected = await bin.inspect(entry.id);
  assert.equal(inspected.originalPath, "mods/example.jar");
  assert.equal(
    inspected.sha512,
    createHash("sha512").update(bytes).digest("hex"),
  );
  assert.equal("payload" in inspected, false);
  await missing(path.join(f.serverDir, "mods", "example.jar"));
  assert.equal(await bin.restore(entry.id), "mods/example.jar");
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "mods", "example.jar")),
    bytes,
  );
});

test("cancelled restore inspection closes its file and releases the bin without finishing the hash", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.serverDir, "mods"));
  await fs.writeFile(
    path.join(f.serverDir, "mods", "example.jar"),
    Buffer.alloc(300_000),
  );
  const abort = new AbortController();
  const reason = new Error("Fixture cancellation");
  let reads = 0,
    closed = false;
  const bin = await f.boot({
    fileSystem: {
      ...fs,
      open: async (...args) => {
        const handle = await fs.open(...args);
        if (path.basename(args[0]) !== "content" || args[1] !== "r")
          return handle;
        return {
          stat: () => handle.stat(),
          read: async (...readArgs) => {
            reads++;
            const result = await handle.read(...readArgs);
            abort.abort(reason);
            return result;
          },
          close: async () => {
            await handle.close();
            closed = true;
          },
        };
      },
    },
  });
  const entry = await bin.recycle("mods/example.jar");
  await assert.rejects(
    bin.inspect(entry.id, { signal: abort.signal }),
    (cause) => cause === reason,
  );
  assert.equal(reads, 1);
  assert.equal(closed, true);
  // Deleting the record requires the same exclusive lock as inspection.
  await bin.deletePermanently(entry.id);
  assert.deepEqual(await bin.list(), []);
});

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

test("restore preview enforces its deadline and shutdown drains the actual cancelled read", async (t) => {
  const f = await apiFixture(t, { mode: "live" });
  const entered = deferred(),
    release = deferred();
  f.releases.push(release.resolve);
  try {
    const panel = await f.boot();
    await fs.mkdir(path.join(f.serverDir, "mods"));
    await fs.writeFile(
      path.join(f.serverDir, "mods", "example.jar"),
      Buffer.alloc(300_000),
    );
    const deleted = await panel.request("/api/files?path=mods/example.jar", {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    const id = deleted.body.recycled.id;
    const payload = path.join(f.dataDir, "recycle-bin", id, "content");
    const open = fs.open;
    let reads = 0,
      handleClosed = false;
    t.mock.method(fs, "open", async (...args) => {
      const handle = await open(...args);
      if (args[0] !== payload || args[1] !== "r") return handle;
      return {
        stat: () => handle.stat(),
        read: async (...readArgs) => {
          reads++;
          entered.resolve();
          await release.promise;
          return handle.read(...readArgs);
        },
        close: async () => {
          await handle.close();
          handleClosed = true;
        },
      };
    });
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", (duration) =>
      duration === 10_000 ? deadline.signal : timeout(duration),
    );
    let finished = false;
    const pending = panel
      .request(`/api/files/recycle-bin/${id}/restore-preview`)
      .then((result) => {
        finished = true;
        return result;
      });
    await entered.promise;
    assert.throws(() => panel.assertRemovable(), /current operation/);
    deadline.abort(
      new DOMException("Fixture preview deadline", "TimeoutError"),
    );
    let closed = false;
    const closing = panel.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      finished,
      false,
      "deadline must not release a still-active file read",
    );
    assert.equal(closed, false, "shutdown must drain the tracked preview");
    release.resolve();
    const response = await pending;
    assert.equal(response.status, 408);
    assert.match(response.body.error, /restore preview took too long/i);
    await closing;
    assert.equal(reads, 1);
    assert.equal(handleClosed, true);
    assert.equal((await fs.stat(payload)).size, 300_000);
  } finally {
    await f.close();
  }
});

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

test("recycle and restore reject a replaced server root before touching another folder", async (t) => {
  for (const action of ["recycle", "restore"])
    await t.test(action, async (t) => {
      const f = await fixture(t);
      const outside = path.join(f.root, "outside");
      const moved = path.join(f.root, "original-server");
      await fs.mkdir(outside);
      await fs.writeFile(
        path.join(outside, "proof"),
        "outside stays untouched",
      );
      await fs.writeFile(
        path.join(f.serverDir, "proof"),
        "original server file",
      );
      const original = await f.boot();
      const entry =
        action === "restore" ? await original.recycle("proof") : null;
      let swapped = false;
      const bin = await f.boot({
        fileSystem: {
          ...fs,
          rename: async (from, to) => {
            await fs.rename(from, to);
            if (!swapped && path.basename(to) === "entry.json") {
              const metadata = JSON.parse(await fs.readFile(to, "utf8"));
              if (
                metadata.phase ===
                (action === "recycle" ? "prepared" : "restoring")
              ) {
                swapped = true;
                await fs.rename(f.serverDir, moved);
                await fs.symlink(
                  outside,
                  f.serverDir,
                  process.platform === "win32" ? "junction" : "dir",
                );
              }
            }
          },
        },
      });
      await assert.rejects(
        action === "recycle" ? bin.recycle("proof") : bin.restore(entry.id),
        /server folder changed/i,
      );
      assert.equal(swapped, true);
      assert.equal(
        await fs.readFile(path.join(outside, "proof"), "utf8"),
        "outside stays untouched",
      );
      await fs.unlink(f.serverDir);
      await fs.rename(moved, f.serverDir);
      if (entry) {
        await (await f.boot()).restore(entry.id);
      }
      assert.equal(
        await fs.readFile(path.join(f.serverDir, "proof"), "utf8"),
        "original server file",
      );
    });
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

test("cross-drive recycle and restore preserve unused configuration and unrelated server files", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.serverDir, "config"));
  const source = path.join(f.serverDir, "config", "unused-mod.toml");
  const unrelated = path.join(f.serverDir, "config", "active-mod.toml");
  const contents = Buffer.from("# Unused mod configuration\nenabled = false\n");
  await fs.writeFile(source, contents);
  await fs.writeFile(unrelated, "# Active configuration stays untouched\n");
  const bin = await f.boot({
    fileSystem: crossVolume(source),
  });
  const item = await bin.recycle("config/unused-mod.toml");
  assert.equal(item.status, "ready");
  await missing(source);
  assert.deepEqual(
    await fs.readFile(path.join(bin.directory, item.id, "content")),
    contents,
  );
  assert.equal(
    await fs.readFile(unrelated, "utf8"),
    "# Active configuration stays untouched\n",
  );
  await bin.restore(item.id);
  assert.deepEqual(await fs.readFile(source), contents);
  assert.equal(
    await fs.readFile(unrelated, "utf8"),
    "# Active configuration stays untouched\n",
  );
  assert.deepEqual(await bin.list(), []);
});

test("a running live server recycles and restores unused configuration across drives without stopping or changing unrelated files", async (t) => {
  const commands = [];
  let starts = 0;
  let exits = 0;
  const f = await apiFixture(t, {
    mode: "live",
    existingServerDir: true,
    jar: "server.jar",
    spawnServer: () => {
      starts++;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const finish = () => {
        exits++;
        child.emit("close", 0);
      };
      child.kill = () => {
        setImmediate(finish);
        return true;
      };
      child.stdin = new Writable({
        write(chunk, _encoding, done) {
          const command = chunk.toString();
          commands.push(command);
          if (command === "stop\n") setImmediate(finish);
          done();
        },
      });
      setImmediate(() =>
        child.stdout.write(
          '[Server thread/INFO]: Done (0.5s)! For help, type "help"\n',
        ),
      );
      return child;
    },
  });
  try {
    const configDir = path.join(f.serverDir, "config");
    await fs.mkdir(configDir);
    const source = path.join(configDir, "unused-mod.toml");
    const unrelated = path.join(configDir, "active-mod.toml");
    const original = "# Safe unused configuration\nenabled = false\n";
    await fs.writeFile(source, original);
    await fs.writeFile(unrelated, "preserved unrelated configuration\n");
    await fs.writeFile(
      path.join(f.serverDir, "server.jar"),
      "inert fixture, never executed",
    );
    await fs.writeFile(path.join(f.serverDir, "eula.txt"), "eula=true\n");
    const panel = await f.boot();
    assert.equal(
      (
        await panel.request(
          "/api/server/power",
          json("POST", { action: "start" }),
        )
      ).status,
      200,
    );
    assert.equal((await panel.request("/api/server")).body.status, "running");
    let crossedDrive = 0;
    let recycleCopies = 0;
    let restoreCopies = 0;
    const rename = fs.rename;
    const copyFile = fs.copyFile;
    t.mock.method(fs, "rename", async (from, to) => {
      if (from === source && path.basename(to) === "content") {
        crossedDrive++;
        throw exdev();
      }
      return rename(from, to);
    });
    t.mock.method(fs, "copyFile", async (from, to, flags) => {
      if (from === source || to === source) {
        assert.equal(
          (await panel.request("/api/server")).body.status,
          "running",
        );
        assert.equal(
          flags,
          1,
          "exclusive copies cannot overwrite existing files",
        );
        if (from === source) recycleCopies++;
        else restoreCopies++;
      }
      return copyFile(from, to, flags);
    });
    const recycled = await panel.request(
      "/api/files?path=config%2Funused-mod.toml",
      { method: "DELETE" },
    );
    assert.equal(recycled.status, 200, JSON.stringify(recycled));
    assert.equal(recycled.body.recycled.status, "ready");
    await missing(source);
    const id = recycled.body.recycled.id;
    assert.equal(
      await fs.readFile(
        path.join(f.dataDir, "recycle-bin", id, "content"),
        "utf8",
      ),
      original,
    );
    assert.equal((await panel.request("/api/server")).body.status, "running");
    assert.equal(
      await fs.readFile(unrelated, "utf8"),
      "preserved unrelated configuration\n",
    );
    const restored = await panel.request(
      `/api/files/recycle-bin/${id}/restore`,
      json("POST"),
    );
    assert.equal(restored.status, 200, JSON.stringify(restored));
    assert.equal(await fs.readFile(source, "utf8"), original);
    assert.equal(
      await fs.readFile(unrelated, "utf8"),
      "preserved unrelated configuration\n",
    );
    assert.deepEqual(
      (await panel.request("/api/files/recycle-bin")).body.items,
      [],
    );
    assert.equal((await panel.request("/api/server")).body.status, "running");
    assert.equal(crossedDrive, 1);
    assert.equal(recycleCopies, 1);
    assert.equal(restoreCopies, 1);
    assert.equal(starts, 1);
    assert.equal(exits, 0);
    assert.deepEqual(
      commands,
      [],
      "file recovery must not stop, restart, or send commands to Java",
    );
  } finally {
    await f.close();
  }
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

test("a locked source file retains both source and a usable verified recovery copy", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.serverDir, "proof");
  await fs.writeFile(source, "still recoverable");
  const bin = await f.boot({
    fileSystem: crossVolume(source, {
      unlink: async (target) => {
        if (path.resolve(target) === path.resolve(source))
          throw Object.assign(new Error("injected locked source file"), {
            code: "EPERM",
          });
        return fs.unlink(target);
      },
    }),
  });
  await assert.rejects(bin.recycle("proof"), { status: 409, code: "EPERM" });
  assert.equal(await fs.readFile(source, "utf8"), "still recoverable");
  const [item] = await (await f.boot()).list();
  assert.equal(item.status, "ready");
  assert.equal(
    await fs.readFile(path.join(bin.directory, item.id, "content"), "utf8"),
    "still recoverable",
  );
});

test("a new file arriving during source removal is neither deleted nor claimed as archived", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.serverDir, "world");
  await fs.mkdir(source);
  const known = path.join(source, "a");
  const late = path.join(source, "late.txt");
  await fs.writeFile(known, "verified original snapshot");
  let inserted = false;
  const bin = await f.boot({
    fileSystem: crossVolume(source, {
      unlink: async (target) => {
        if (target === known && !inserted) {
          // The verified snapshot is already complete. Simulate an external
          // server write at the final unlink boundary, after all copy checks.
          inserted = true;
          await fs.writeFile(
            late,
            "new live-server data, absent from the archive",
          );
        }
        return fs.unlink(target);
      },
    }),
  });
  await assert.rejects(
    bin.recycle("world"),
    (cause) =>
      cause.status === 409 &&
      ["ENOTEMPTY", "EEXIST"].includes(cause.code) &&
      /no longer empty/i.test(cause.message),
  );
  assert.equal(inserted, true);
  assert.equal(
    await fs.readFile(late, "utf8"),
    "new live-server data, absent from the archive",
  );
  const [item] = await bin.list();
  assert.equal(item.status, "ready");
  const payload = path.join(bin.directory, item.id, "content");
  assert.equal(
    await fs.readFile(path.join(payload, "a"), "utf8"),
    "verified original snapshot",
  );
  await missing(path.join(payload, "late.txt"));
  await assert.rejects(bin.restore(item.id), /already exists/);
});

for (const change of [
  "same-size-and-mtime edit",
  "file identity replacement",
]) {
  test(`a ${change} after global verification is retained by the per-file removal check`, async (t) => {
    const f = await fixture(t);
    const source = path.join(f.serverDir, "world");
    await fs.mkdir(source);
    const first = path.join(source, "a");
    const second = path.join(source, "b");
    const parked = path.join(f.root, "parked-original-a");
    await fs.writeFile(first, "first");
    await fs.writeFile(second, "second");
    const original = await fs.stat(first);
    let changed = false;
    const bin = await f.boot({
      fileSystem: crossVolume(source, {
        unlink: async (target) => {
          if (target === second && !changed) {
            // Reverse traversal removes b first. All global checks have passed;
            // this change must be caught by the subsequent per-file check of a.
            changed = true;
            if (change === "file identity replacement")
              await fs.rename(first, parked);
            await fs.writeFile(
              first,
              change === "same-size-and-mtime edit" ? "other" : "first",
            );
            await fs.chmod(first, original.mode & 0o777);
            await fs.utimes(first, original.atime, original.mtime);
          }
          return fs.unlink(target);
        },
      }),
    });
    await assert.rejects(
      bin.recycle("world"),
      (cause) =>
        cause.status === 409 &&
        /source changed during removal/i.test(cause.message),
    );
    assert.equal(changed, true);
    assert.equal(
      await fs.readFile(first, "utf8"),
      change === "same-size-and-mtime edit" ? "other" : "first",
    );
    if (change === "file identity replacement")
      assert.equal(await fs.readFile(parked, "utf8"), "first");
    const [item] = await bin.list();
    assert.equal(item.status, "ready");
    const payload = path.join(bin.directory, item.id, "content");
    assert.equal(await fs.readFile(path.join(payload, "a"), "utf8"), "first");
    assert.equal(await fs.readFile(path.join(payload, "b"), "utf8"), "second");
  });
}

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
  let recoveryId;
  await assert.rejects(bin.recycle("proof"), (cause) => {
    assert.match(cause.message, /interrupted/);
    assert.equal(cause.originalPath, "proof");
    assert.match(cause.recoveryId, /^[a-f0-9-]{36}$/i);
    recoveryId = cause.recoveryId;
    return true;
  });
  await missing(path.join(f.serverDir, "proof"));
  const restarted = await f.boot();
  const [item] = await restarted.list();
  assert.equal(item.id, recoveryId);
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
          method: "PUT",
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
        mode: "live",
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
          `/api/files/recycle-bin/${id}`,
          { method: "DELETE" },
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
        await panel.request(`/api/files/recycle-bin/${id}`, {
          method: "DELETE",
        })
      ).status,
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
    assert.equal(
      (
        await panel.request(`/api/files/recycle-bin/${id}`, {
          method: "DELETE",
        })
      ).status,
      409,
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

test("permanent deletion removes only the chosen recovery entry and supports damaged metadata", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.serverDir, "active"), "active server data");
  await fs.writeFile(
    path.join(f.serverDir, "first"),
    "delete this recovery copy",
  );
  await fs.mkdir(path.join(f.serverDir, "second"));
  await fs.writeFile(
    path.join(f.serverDir, "second", "proof"),
    "retain this other recovery copy",
  );
  const bin = await f.boot();
  const first = await bin.recycle("first");
  const second = await bin.recycle("second");
  await bin.deletePermanently(first.id);
  await missing(path.join(bin.directory, first.id));
  assert.equal((await bin.list())[0].id, second.id);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "active"), "utf8"),
    "active server data",
  );
  assert.equal(
    await fs.readFile(
      path.join(bin.directory, second.id, "content", "proof"),
      "utf8",
    ),
    "retain this other recovery copy",
  );
  const incompleteId = randomUUID();
  const incomplete = path.join(bin.directory, incompleteId);
  await fs.mkdir(incomplete);
  await fs.writeFile(path.join(incomplete, "entry.json"), "[invalid metadata");
  await fs.writeFile(path.join(incomplete, "content"), "incomplete data");
  assert.equal(
    (await bin.list()).find((item) => item.id === incompleteId).status,
    "incomplete",
  );
  await bin.deletePermanently(incompleteId);
  await missing(incomplete);
  await assert.rejects(bin.deletePermanently("../server"), { status: 400 });
  await assert.rejects(bin.deletePermanently(randomUUID()), { status: 404 });
  await bin.deletePermanently(second.id);
  assert.deepEqual(await bin.list(), []);
});

test("permanent deletion refuses private entry junctions and nested symlinks without touching outside files", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "proof"), "outside must survive");
  const bin = await f.boot();
  const linkId = randomUUID();
  const link = path.join(bin.directory, linkId);
  await fs.symlink(
    outside,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(bin.deletePermanently(linkId), /symbolic links/i);
  await fs.unlink(link);
  const nestedId = randomUUID();
  const nested = path.join(bin.directory, nestedId);
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "retained"), "unchanged private data");
  await fs.symlink(
    outside,
    path.join(nested, "content"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(bin.deletePermanently(nestedId), /symbolic links/i);
  assert.equal(
    await fs.readFile(path.join(outside, "proof"), "utf8"),
    "outside must survive",
  );
  assert.equal(
    await fs.readFile(path.join(nested, "retained"), "utf8"),
    "unchanged private data",
  );
  await missing(path.join(nested, ".deleting"));
  await fs.unlink(path.join(nested, "content"));
});

test("a failed permanent deletion keeps a retryable incomplete entry and prevents restoring a partial archive", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.serverDir, "world"));
  await fs.writeFile(
    path.join(f.serverDir, "world", "a"),
    "locked recovery data",
  );
  await fs.writeFile(
    path.join(f.serverDir, "world", "b"),
    "permanently deleted part",
  );
  const bin = await f.boot();
  const item = await bin.recycle("world");
  const locked = path.join(bin.directory, item.id, "content", "a");
  const failed = await f.boot({
    fileSystem: {
      ...fs,
      unlink: async (target) => {
        if (target === locked)
          throw Object.assign(new Error("fixture locked file"), {
            code: "EPERM",
          });
        return fs.unlink(target);
      },
    },
  });
  await assert.rejects(failed.deletePermanently(item.id), {
    status: 409,
    code: "EPERM",
  });
  assert.equal(await fs.readFile(locked, "utf8"), "locked recovery data");
  await missing(path.join(bin.directory, item.id, "content", "b"));
  const restarted = await f.boot();
  assert.equal((await restarted.list())[0].status, "incomplete");
  await assert.rejects(restarted.restore(item.id), /incomplete/);
  await restarted.deletePermanently(item.id);
  assert.deepEqual(await restarted.list(), []);
});

test("permanent-delete API remains locked and shutdown drains its work after client disconnect", async (t) => {
  const f = await apiFixture(t);
  const entered = deferred();
  const release = deferred();
  f.releases.push(release.resolve);
  try {
    const panel = await f.boot();
    await fs.writeFile(
      path.join(f.serverDir, "proof"),
      "delete this private recovery data",
    );
    await fs.writeFile(path.join(f.serverDir, "active"), "active data stays");
    const deleted = await panel.request("/api/files?path=proof", {
      method: "DELETE",
    });
    const id = deleted.body.recycled.id;
    const target = path.join(f.dataDir, "recycle-bin", id, "content");
    const unlink = fs.unlink;
    t.mock.method(fs, "unlink", async (file) => {
      if (file === target) {
        entered.resolve();
        await release.promise;
      }
      return unlink(file);
    });
    const abort = new AbortController();
    const pending = panel
      .request(`/api/files/recycle-bin/${id}`, {
        method: "DELETE",
        signal: abort.signal,
      })
      .catch((cause) => cause);
    await Promise.race([
      entered.promise,
      pending.then((result) => {
        throw new Error(
          `Purge completed before gated unlink: ${JSON.stringify(result)}`,
        );
      }),
    ]);
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
      (
        await panel.request(`/api/files/recycle-bin/${id}`, {
          method: "DELETE",
        })
      ).status,
      409,
    );
    assert.equal(
      (await panel.request("/api/files?path=active", { method: "DELETE" }))
        .status,
      409,
    );
    assert.equal(
      (await panel.request("/api/backups", json("POST", { name: "blocked" })))
        .status,
      409,
    );
    abort.abort();
    await pending;
    let closed = false;
    const closing = panel.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, false);
    release.resolve();
    await closing;
    await missing(path.join(f.dataDir, "recycle-bin", id));
    assert.equal(
      await fs.readFile(path.join(f.serverDir, "active"), "utf8"),
      "active data stays",
    );
  } finally {
    await f.close();
  }
});
