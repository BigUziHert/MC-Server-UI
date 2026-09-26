import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { copyServerFiles, uploadServerFiles } from "./file-transfer.mjs";
import { createFleet, safePath } from "./index.mjs";

const json = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const deferred = () => {
  let resolve;
  return {
    promise: new Promise((done) => {
      resolve = done;
    }),
    resolve,
  };
};
const missing = (target) => assert.rejects(fs.stat(target), { code: "ENOENT" });
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-transfer-test-")),
  );
  const sourceDir = path.join(root, "source"),
    serverDir = path.join(root, "target");
  await fs.mkdir(sourceDir);
  await fs.mkdir(serverDir);
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-transfer-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    sourceDir,
    serverDir,
    copy: (options = {}) =>
      copyServerFiles({ sourceDir, serverDir, safePath, ...options }),
  };
}

test("native copy preserves nested files, empty folders, source bytes and modification times", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.sourceDir, "mods", "empty"), { recursive: true });
  const source = path.join(f.sourceDir, "mods", "test.jar");
  await fs.writeFile(source, Buffer.alloc(2_100_000, 71), { mode: 0o755 });
  await fs.utimes(source, new Date("2021-01-02Z"), new Date("2021-01-02Z"));
  const before = await fs.stat(source),
    events = [];
  const result = await f.copy({
    paths: ["mods", "mods/test.jar"],
    onProgress: (event) => {
      events.push(event);
      throw new Error("observer failure");
    },
  });
  assert.deepEqual(result, {
    copiedFiles: 1,
    copiedDirectories: 2,
    paths: ["mods"],
  });
  const target = path.join(f.serverDir, "mods", "test.jar");
  assert.deepEqual(await fs.readFile(target), await fs.readFile(source));
  const copied = await fs.stat(target);
  assert.equal(copied.mode & 0o777, before.mode & 0o777);
  assert.ok(Math.abs(copied.mtimeMs - before.mtimeMs) < 2);
  assert.ok(
    (await fs.stat(path.join(f.serverDir, "mods", "empty"))).isDirectory(),
  );
  assert.ok(
    events.some(
      (event) =>
        event.phase === "copying" &&
        event.bytesProcessed > 0 &&
        event.bytesProcessed < before.size,
    ),
  );
});

test("same-server copy rejects its source and descendants, duplicates and existing destinations before writing", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.sourceDir, "mods", "nested"), { recursive: true });
  await fs.writeFile(path.join(f.sourceDir, "mods", "proof"), "original");
  for (const destinationPath of ["", "mods", "mods/nested"])
    await assert.rejects(
      f.copy({ serverDir: f.sourceDir, paths: ["mods"], destinationPath }),
      { status: 409 },
    );
  await fs.mkdir(path.join(f.serverDir, "mods"));
  await assert.rejects(f.copy({ paths: ["mods"] }), { status: 409 });
  assert.deepEqual(await fs.readdir(path.join(f.serverDir, "mods")), []);
  for (const paths of [
    ["../outside"],
    ["/outside"],
    [""],
    ["mods\\proof"],
    ["mods/../proof"],
  ])
    await assert.rejects(f.copy({ paths }), { status: 400 });
  assert.equal(
    await fs.readFile(path.join(f.sourceDir, "mods", "proof"), "utf8"),
    "original",
  );
});

test("copy rejects source junctions and target parent junctions without touching outside data", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret"), "outside");
  await fs.symlink(
    outside,
    path.join(f.sourceDir, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(f.copy({ paths: ["link"] }), /symbolic links/i);
  await fs.writeFile(path.join(f.sourceDir, "proof"), "inside");
  await fs.symlink(
    outside,
    path.join(f.serverDir, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    f.copy({ paths: ["proof"], destinationPath: "linked" }),
    /symbolic links/i,
  );
  assert.deepEqual(await fs.readdir(outside), ["secret"]);
});

test("a racing destination is never overwritten and partial copy counts describe only completed data", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.sourceDir, "a"), "first");
  await fs.writeFile(path.join(f.sourceDir, "b"), "second");
  const open = fs.open;
  await assert.rejects(
    f.copy({
      paths: ["a", "b"],
      fileSystem: {
        ...fs,
        open: async (target, flags, ...args) => {
          if (target === path.join(f.serverDir, "b") && flags === "wx")
            await fs.writeFile(target, "external change");
          return open(target, flags, ...args);
        },
      },
    }),
    (cause) => {
      assert.equal(cause.code, "EEXIST");
      assert.equal(cause.transferResult.copiedFiles, 1);
      return true;
    },
  );
  assert.equal(await fs.readFile(path.join(f.serverDir, "a"), "utf8"), "first");
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "b"), "utf8"),
    "external change",
  );
  assert.equal(
    await fs.readFile(path.join(f.sourceDir, "b"), "utf8"),
    "second",
  );
});

test("source changes or revoked access remove only the incomplete new file and preserve originals", async (t) => {
  for (const mode of ["change", "revoke"]) {
    const f = await fixture(t);
    const source = path.join(f.sourceDir, "proof");
    await fs.writeFile(source, Buffer.alloc(2_100_000, 40));
    const open = fs.open;
    let changed = false;
    await assert.rejects(
      f.copy({
        paths: ["proof"],
        assertAccess: async () => {
          if (mode === "revoke" && changed)
            throw Object.assign(new Error("permission revoked"), {
              status: 403,
            });
        },
        fileSystem: {
          ...fs,
          open: async (...args) => {
            const handle = await open(...args);
            if (args[0] !== source || args[1] !== "r") return handle;
            return {
              stat: () => handle.stat(),
              close: () => handle.close(),
              read: async (...readArgs) => {
                const result = await handle.read(...readArgs);
                if (!changed) {
                  changed = true;
                  if (mode === "change") await fs.appendFile(source, "changed");
                }
                return result;
              },
            };
          },
        },
      }),
      (cause) => {
        assert.equal(cause.status, mode === "change" ? 409 : 403);
        assert.equal(cause.transferResult.copiedFiles, 0);
        return true;
      },
    );
    await missing(path.join(f.serverDir, "proof"));
    assert.ok((await fs.stat(source)).size >= 2_100_000);
  }
});

test("nested upload preserves paths and empty directories while refusing overwrite and malformed batches", async (t) => {
  const f = await fixture(t);
  const temporary = path.join(f.root, "upload");
  await fs.writeFile(temporary, "mod bytes");
  const files = [{ path: temporary, originalname: "example.jar" }];
  const options = {
    serverDir: f.serverDir,
    safePath,
    files,
    fields: {
      paths: JSON.stringify(["pack/mods/example.jar"]),
      directories: JSON.stringify(["pack/empty"]),
      modified: JSON.stringify([Date.parse("2022-01-01Z")]),
    },
  };
  const result = await uploadServerFiles(options);
  assert.deepEqual(result, { uploaded: 1, directories: 3 });
  assert.equal(
    await fs.readFile(
      path.join(f.serverDir, "pack", "mods", "example.jar"),
      "utf8",
    ),
    "mod bytes",
  );
  assert.deepEqual(
    await fs.readdir(path.join(f.serverDir, "pack", "empty")),
    [],
  );
  assert.equal(
    (
      await fs.stat(path.join(f.serverDir, "pack", "mods", "example.jar"))
    ).mtime.toISOString(),
    "2022-01-01T00:00:00.000Z",
  );
  await assert.rejects(uploadServerFiles(options), { status: 409 });
  for (const fields of [
    { paths: "[]" },
    { paths: '["../outside"]' },
    { directories: "null" },
    { modified: '["yesterday"]' },
    { paths: '["file"]', directories: '["file/nested"]' },
  ])
    await assert.rejects(uploadServerFiles({ ...options, fields }), (cause) =>
      [400, 409].includes(cause.status),
    );
  await missing(path.join(f.root, "outside"));
});

async function apiFixture(t) {
  const f = await fixture(t);
  const fleet = await createFleet({
    dataDir: path.join(f.root, "panel"),
    useEnvironment: false,
    scheduler: false,
    remoteListen: false,
    publicAddress: { resolve: async () => null },
  });
  const listener = await new Promise((resolve) => {
    const server = fleet.app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const request = async (route, init = {}, id) => {
    const response = await fetch(base + route, {
      ...init,
      headers: { ...(id ? { "X-Server-Id": id } : {}), ...init.headers },
    });
    return { status: response.status, body: await response.json() };
  };
  const first = (await request("/api/servers")).body.defaultServerId;
  const added = await request(
    "/api/servers",
    json({
      name: "Destination",
      mode: "live",
      port: 25566,
      memoryLimitMB: 2048,
    }),
  );
  assert.equal(added.status, 201);
  const second = added.body.server.id;
  const close = async () => {
    await fleet.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  };
  return { ...f, fleet, request, first, second, close };
}

test("fleet copy supports two local servers, request history and no overwrite on replay", async (t) => {
  const f = await apiFixture(t);
  try {
    const source = f.fleet.runtimes.get(f.first).serverDir,
      target = f.fleet.runtimes.get(f.second).serverDir;
    await fs.mkdir(path.join(source, "mods", "empty"), { recursive: true });
    await fs.writeFile(path.join(source, "mods", "proof.jar"), "jar bytes");
    const requestId = randomUUID(),
      body = {
        sourceServerId: f.first,
        paths: ["mods"],
        destinationPath: "",
        requestId,
      };
    const copied = await f.request("/api/files/copy", json(body), f.second);
    assert.equal(copied.status, 201, JSON.stringify(copied));
    assert.deepEqual(copied.body, {
      copiedFiles: 1,
      copiedDirectories: 2,
      paths: ["mods"],
    });
    assert.equal(
      await fs.readFile(path.join(target, "mods", "proof.jar"), "utf8"),
      "jar bytes",
    );
    await fs.writeFile(
      path.join(target, "mods", "proof.jar"),
      "changed destination",
    );
    assert.deepEqual(
      await f.request(
        "/api/files/copy",
        json({ ...body, requestId: requestId.toUpperCase() }),
        f.second,
      ),
      copied,
    );
    assert.equal(
      await fs.readFile(path.join(target, "mods", "proof.jar"), "utf8"),
      "changed destination",
    );
    assert.equal(
      (
        await f.request(
          `/api/files/copy-operation?requestId=${requestId}`,
          {},
          f.second,
        )
      ).body.operation.status,
      "completed",
    );
    assert.equal(
      (
        await f.request(
          `/api/files/copy-operation?requestId=${requestId}`,
          {},
          f.first,
        )
      ).body.operation,
      null,
    );
    assert.equal(
      (
        await f.request(
          "/api/files/copy",
          json({ ...body, requestId: randomUUID() }),
          f.second,
        )
      ).status,
      409,
    );
    assert.equal(
      await fs.readFile(path.join(source, "mods", "proof.jar"), "utf8"),
      "jar bytes",
    );
  } finally {
    await f.close();
  }
});

test("cross-server copy holds both runtimes through disconnect and graceful shutdown", async (t) => {
  const f = await apiFixture(t),
    entered = deferred(),
    release = deferred();
  try {
    const source = f.fleet.runtimes.get(f.first).serverDir,
      target = f.fleet.runtimes.get(f.second).serverDir;
    const file = path.join(source, "large.bin");
    await fs.writeFile(file, Buffer.alloc(2_100_000, 55));
    const open = fs.open;
    let reads = 0;
    t.mock.method(fs, "open", async (...args) => {
      const handle = await open(...args);
      if (args[0] !== file || args[1] !== "r") return handle;
      return {
        stat: () => handle.stat(),
        close: () => handle.close(),
        read: async (...readArgs) => {
          if (++reads === 2) {
            entered.resolve();
            await release.promise;
          }
          return handle.read(...readArgs);
        },
      };
    });
    const abort = new AbortController(),
      requestId = randomUUID();
    const pending = f
      .request(
        "/api/files/copy",
        {
          ...json({ sourceServerId: f.first, paths: ["large.bin"], requestId }),
          signal: abort.signal,
        },
        f.second,
      )
      .catch((cause) => cause);
    await entered.promise;
    const operation = (
      await f.request(
        `/api/files/copy-operation?requestId=${requestId}`,
        {},
        f.second,
      )
    ).body.operation;
    assert.equal(operation.status, "running");
    assert.ok(
      operation.bytesProcessed > 0 &&
        operation.bytesProcessed < operation.totalBytes,
    );
    for (const id of [f.first, f.second]) {
      assert.equal(
        (await f.request("/api/files?path=large.bin", { method: "DELETE" }, id))
          .status,
        409,
      );
      assert.equal(
        (await f.request("/api/backups", json({ name: "blocked" }), id)).status,
        409,
      );
      assert.throws(
        () => f.fleet.runtimes.get(id).assertRemovable(),
        /current operation/,
      );
    }
    abort.abort();
    await pending;
    let closed = false;
    const closing = f.fleet.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, false);
    release.resolve();
    await closing;
    assert.deepEqual(
      await fs.readFile(path.join(target, "large.bin")),
      await fs.readFile(file),
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

test("200-plus nested uploads complete as bounded sequential batches and preserve empty directories", async (t) => {
  const f = await apiFixture(t);
  try {
    const target = f.fleet.runtimes.get(f.first).serverDir;
    const directoryForm = new FormData();
    directoryForm.append(
      "directories",
      JSON.stringify(["modpack/empty", "modpack/mods"]),
    );
    assert.equal(
      (
        await f.request(
          "/api/files/upload",
          { method: "POST", body: directoryForm },
          f.first,
        )
      ).status,
      201,
    );
    for (let start = 0; start < 205; start += 20) {
      const form = new FormData(),
        paths = [],
        modified = [];
      for (let i = start; i < Math.min(start + 20, 205); i++) {
        form.append("files", new Blob([`jar ${i}`]), `mod-${i}.jar`);
        paths.push(`modpack/mods/mod-${i}.jar`);
        modified.push(Date.parse("2022-01-01Z"));
      }
      form.append("paths", JSON.stringify(paths));
      form.append("modified", JSON.stringify(modified));
      const uploaded = await f.request(
        "/api/files/upload",
        { method: "POST", body: form },
        f.first,
      );
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded));
      assert.equal(uploaded.body.uploaded, paths.length);
    }
    assert.equal(
      (await fs.readdir(path.join(target, "modpack", "mods"))).length,
      205,
    );
    assert.deepEqual(
      await fs.readdir(path.join(target, "modpack", "empty")),
      [],
    );
    assert.equal(
      await fs.readFile(
        path.join(target, "modpack", "mods", "mod-204.jar"),
        "utf8",
      ),
      "jar 204",
    );
    const oversized = new FormData();
    for (let i = 0; i < 21; i++)
      oversized.append("files", new Blob(["one"]), `too-many-${i}.jar`);
    assert.equal(
      (
        await f.request(
          "/api/files/upload",
          { method: "POST", body: oversized },
          f.first,
        )
      ).status,
      400,
    );
    await missing(path.join(target, "too-many-0.jar"));
  } finally {
    await f.close();
  }
});

test("direct nested upload APIs reject reserved and invalid names before creating parent folders", async (t) => {
  const f = await apiFixture(t);
  try {
    const target = f.fleet.runtimes.get(f.first).serverDir;
    const before = await fs.readdir(target);
    for (const name of [
      "NUL",
      "CON.jar",
      "trailing.",
      "trailing ",
      "bad?name",
      "control\u0001name",
    ]) {
      for (const kind of ["file", "directory"]) {
        const form = new FormData();
        if (kind === "file") {
          form.append("files", new Blob(["bytes"]), "innocent.jar");
          form.append("paths", JSON.stringify([`new-parent/${name}`]));
        } else {
          form.append("directories", JSON.stringify([`new-parent/${name}`]));
        }
        const result = await f.request(
          "/api/files/upload",
          { method: "POST", body: form },
          f.first,
        );
        assert.equal(result.status, 400, `${kind}: ${JSON.stringify(name)}`);
        assert.equal(result.body.uploaded, 0);
        assert.equal(result.body.directories, 0);
      }
    }
    assert.deepEqual(await fs.readdir(target), before);
    await missing(path.join(target, "new-parent"));
  } finally {
    await f.close();
  }
});
