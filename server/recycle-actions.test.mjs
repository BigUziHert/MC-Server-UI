import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createPanel } from "./index.mjs";

const json = (method, body = {}) => ({ method, body: JSON.stringify(body) });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(temporary, "mc-recycle-actions-")),
  );
  const panel = await createPanel({
    dataDir: root,
    useEnvironment: false,
    scheduler: false,
    publicAddress: { resolve: async () => null },
  });
  const listener = await new Promise((resolve) => {
    const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const releases = [];
  t.after(async () => {
    releases.forEach((release) => release());
    try {
      await panel.close();
    } finally {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-recycle-actions-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = async (route, options = {}) => {
    const response = await fetch(
      `http://127.0.0.1:${listener.address().port}${route}`,
      {
        ...options,
        headers: { "Content-Type": "application/json", ...options.headers },
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const recycle = async (name, text = "original data") => {
    await fs.writeFile(path.join(panel.serverDir, name), text);
    const result = await request(
      `/api/files?path=${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.body.recycled;
  };
  return { panel, root, request, recycle, releases };
}
const waitFor = async (work, predicate) => {
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = await work();
    if (predicate(result)) return result;
    if (Date.now() > deadline)
      assert.fail(`Outcome did not arrive: ${JSON.stringify(result)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("permanent delete progress survives disconnect, keeps its lease, and replays only the original completed result", async (t) => {
  const f = await fixture(t);
  const item = await f.recycle("delete-me");
  const requestId = randomUUID();
  const target = path.join(f.root, "recycle-bin", item.id, "content");
  const entered = deferred(),
    release = deferred();
  f.releases.push(release.resolve);
  const unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (file) => {
    if (file === target) {
      entered.resolve();
      await release.promise;
    }
    return unlink(file);
  });
  const abort = new AbortController();
  const route = `/api/files/recycle-bin/${item.id}?requestId=${requestId}`;
  const pending = f
    .request(route, { method: "DELETE", signal: abort.signal })
    .catch((cause) => cause);
  await Promise.race([
    entered.promise,
    pending.then((result) => {
      throw new Error(JSON.stringify(result));
    }),
  ]);
  const progressRoute = `/api/files/recycle-bin/operation?requestId=${requestId.toUpperCase()}`;
  const running = await f.request(progressRoute);
  assert.equal(running.status, 200);
  assert.equal(running.body.operation.status, "running");
  assert.equal(running.body.operation.type, "delete");
  assert.equal(running.body.operation.itemId, item.id);
  assert.equal(
    (
      await f.request(
        "/api/files",
        json("POST", { name: "blocked", type: "file", content: "" }),
      )
    ).status,
    409,
  );
  abort.abort();
  await pending;
  assert.equal(
    (await f.request(progressRoute)).body.operation.status,
    "running",
  );
  release.resolve();
  const completed = await waitFor(
    () => f.request(progressRoute),
    (result) => result.body.operation?.status === "completed",
  );
  assert.deepEqual(completed.body.operation.result, { ok: true, id: item.id });
  assert.deepEqual(await f.request(route, { method: "DELETE" }), {
    status: 200,
    body: { ok: true, id: item.id },
  });
  assert.equal(
    (
      await f.request(
        `/api/files/recycle-bin/${randomUUID()}?requestId=${requestId}`,
        { method: "DELETE" },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request(
        `/api/files/recycle-bin/${item.id}/restore`,
        json("POST", { requestId }),
      )
    ).status,
    409,
  );
  assert.equal(
    (await f.request("/api/files/recycle-bin/operation?requestId=bad")).status,
    400,
  );
  assert.deepEqual(
    (
      await f.request(
        `/api/files/recycle-bin/operation?requestId=${randomUUID()}`,
      )
    ).body,
    { operation: null },
  );
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
});

test("restore progress survives disconnect and its settled replay never overwrites a subsequently edited destination", async (t) => {
  const f = await fixture(t);
  const item = await f.recycle("restore-me");
  const requestId = randomUUID();
  const payload = path.join(f.root, "recycle-bin", item.id, "content");
  const entered = deferred(),
    release = deferred();
  f.releases.push(release.resolve);
  const copyFile = fs.copyFile;
  t.mock.method(fs, "copyFile", async (...args) => {
    if (args[0] === payload) {
      entered.resolve();
      await release.promise;
    }
    return copyFile(...args);
  });
  const abort = new AbortController();
  const route = `/api/files/recycle-bin/${item.id}/restore`;
  const pending = f
    .request(route, { ...json("POST", { requestId }), signal: abort.signal })
    .catch((cause) => cause);
  await Promise.race([
    entered.promise,
    pending.then((result) => {
      throw new Error(JSON.stringify(result));
    }),
  ]);
  const progressRoute = `/api/files/recycle-bin/operation?requestId=${requestId}`;
  const running = (await f.request(progressRoute)).body.operation;
  assert.equal(running.type, "restore");
  assert.equal(running.status, "running");
  assert.equal(running.item.name, "restore-me");
  assert.equal(running.item.id, item.id);
  abort.abort();
  await pending;
  release.resolve();
  await waitFor(
    () => f.request(progressRoute),
    (result) => result.body.operation?.status === "completed",
  );
  const restored = path.join(f.panel.serverDir, "restore-me");
  assert.equal(await fs.readFile(restored, "utf8"), "original data");
  await fs.writeFile(restored, "edited since restore");
  const replay = await f.request(route, json("POST", { requestId }));
  assert.deepEqual(replay, {
    status: 200,
    body: { ok: true, path: "restore-me" },
  });
  assert.equal(await fs.readFile(restored, "utf8"), "edited since restore");
});

test("failed permanent deletion reports partial progress without exposing host paths and needs a new request ID to retry", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.panel.serverDir, "folder"));
  await fs.writeFile(
    path.join(f.panel.serverDir, "folder", "retained"),
    "retained",
  );
  await fs.writeFile(
    path.join(f.panel.serverDir, "folder", "removed"),
    "removed",
  );
  const moved = await f.request("/api/files?path=folder", { method: "DELETE" });
  const item = moved.body.recycled;
  const target = path.join(
    f.root,
    "recycle-bin",
    item.id,
    "content",
    "retained",
  );
  const unlink = fs.unlink;
  let locked = true;
  t.mock.method(fs, "unlink", async (file) => {
    if (file === target && locked)
      throw Object.assign(new Error(`EPERM ${file}`), { code: "EPERM" });
    return unlink(file);
  });
  const requestId = randomUUID();
  const route = `/api/files/recycle-bin/${item.id}`;
  const failed = await f.request(`${route}?requestId=${requestId}`, {
    method: "DELETE",
  });
  assert.equal(failed.status, 409);
  const outcome = (
    await f.request(`/api/files/recycle-bin/operation?requestId=${requestId}`)
  ).body.operation;
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.phase, "failed");
  assert.equal(
    JSON.stringify(outcome).includes(JSON.stringify(f.root).slice(1, -1)),
    false,
  );
  assert.equal(await fs.readFile(target, "utf8"), "retained");
  assert.equal(
    (await f.request("/api/files/recycle-bin")).body.items[0].status,
    "incomplete",
  );
  locked = false;
  assert.equal(
    (await f.request(`${route}?requestId=${requestId}`, { method: "DELETE" }))
      .status,
    409,
  );
  assert.equal(await fs.readFile(target, "utf8"), "retained");
  assert.equal(
    (
      await f.request(`${route}?requestId=${randomUUID()}`, {
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request(`/api/files/recycle-bin/operation?requestId=${requestId}`))
      .body.operation.status,
    "failed",
  );
});

test("committed purge completes and releases mutations even when its audit save is blocked or fails", async (t) => {
  const f = await fixture(t);
  t.mock.method(console, "error", () => {});
  const item = await f.recycle("audit-purge");
  const entered = deferred(),
    release = deferred();
  f.releases.push(release.resolve);
  const rename = fs.rename;
  let failed = false;
  t.mock.method(fs, "rename", async (from, to) => {
    if (
      !failed &&
      to === path.join(f.root, "panel.json") &&
      (await fs.readFile(from, "utf8")).includes(
        "Recycle Bin item permanently deleted",
      )
    ) {
      failed = true;
      entered.resolve();
      await release.promise;
      throw new Error("Injected audit failure");
    }
    return rename(from, to);
  });
  const requestId = randomUUID();
  const pending = f.request(
    `/api/files/recycle-bin/${item.id}?requestId=${requestId}`,
    { method: "DELETE" },
  );
  await entered.promise;
  const result = await Promise.race([
    pending,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Audit blocked committed purge response")),
        1000,
      ),
    ),
  ]);
  assert.equal(result.status, 200);
  assert.equal(
    (await f.request(`/api/files/recycle-bin/operation?requestId=${requestId}`))
      .body.operation.status,
    "completed",
  );
  // Another operation can start even while the audit writer drains separately.
  const missing = await f.request(`/api/files/recycle-bin/${randomUUID()}`, {
    method: "DELETE",
  });
  assert.equal(missing.status, 404);
  release.resolve();
  assert.equal(
    (
      await f.request(
        "/api/files",
        json("POST", { name: "after-audit", type: "file", content: "success" }),
      )
    ).status,
    201,
  );
});

test("recovery outcome history stays bounded and rejects malformed request IDs before starting work", async (t) => {
  const f = await fixture(t);
  const requests = [];
  for (let index = 0; index < 65; index++) {
    const requestId = randomUUID();
    requests.push(requestId);
    assert.equal(
      (
        await f.request(
          `/api/files/recycle-bin/${randomUUID()}?requestId=${requestId}`,
          { method: "DELETE" },
        )
      ).status,
      404,
    );
  }
  const lookup = (id) =>
    f.request(`/api/files/recycle-bin/operation?requestId=${id}`);
  assert.deepEqual((await lookup(requests[0])).body, { operation: null });
  assert.equal((await lookup(requests[1])).body.operation.status, "failed");
  assert.equal((await lookup(requests.at(-1))).body.operation.status, "failed");
  assert.equal(
    (
      await f.request(
        `/api/files/recycle-bin/${randomUUID()}?requestId=invalid`,
        { method: "DELETE" },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        `/api/files/recycle-bin/${randomUUID()}/restore`,
        json("POST", { requestId: [] }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.request("/api/files/recycle-bin/operation")).body.operation.id,
    requests.at(-1),
  );
});

test("server status defers new storage-size scans during permanent deletion and resumes afterward", async (t) => {
  const f = await fixture(t);
  const item = await f.recycle("slow-purge");
  const probe = path.join(f.panel.serverDir, "disk-scan-probe");
  await fs.mkdir(probe);
  await fs.writeFile(path.join(probe, "keep.txt"), "keep this file");
  let scans = 0;
  const readdir = fs.readdir;
  t.mock.method(fs, "readdir", async (directory, ...args) => {
    if (directory === probe) scans++;
    return readdir(directory, ...args);
  });
  const entered = deferred(),
    release = deferred();
  f.releases.push(release.resolve);
  const unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (file) => {
    if (file === path.join(f.root, "recycle-bin", item.id, "content")) {
      entered.resolve();
      await release.promise;
    }
    return unlink(file);
  });
  const pending = f.request(`/api/files/recycle-bin/${item.id}`, {
    method: "DELETE",
  });
  await Promise.race([
    entered.promise,
    pending.then((result) => {
      throw new Error(JSON.stringify(result));
    }),
  ]);
  for (let index = 0; index < 3; index++)
    assert.equal((await f.request("/api/server")).status, 200);
  assert.equal(
    scans,
    0,
    "status polling must not begin a competing tree scan while deleting",
  );
  release.resolve();
  assert.equal((await pending).status, 200);
  await f.request("/api/server");
  await waitFor(
    async () => scans,
    (count) => count === 1,
  );
  assert.equal(
    await fs.readFile(path.join(probe, "keep.txt"), "utf8"),
    "keep this file",
  );
});
