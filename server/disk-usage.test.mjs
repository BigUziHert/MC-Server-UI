import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPanel } from "./index.mjs";

async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "mc-disk-usage-"));
  const serverDir = path.join(root, "server");
  const worldFile = path.join(serverDir, "world", "region", "r.0.0.mca");
  await fs.mkdir(path.dirname(worldFile), { recursive: true });
  await fs.writeFile(worldFile, "original");
  const panel = await createPanel({
    dataDir: path.join(root, "data"),
    serverDir,
    mode: "live",
    useEnvironment: false,
    scheduler: false,
    minecraftVersion: "1.21.1",
    publicAddress: { resolve: async () => null },
    catalogFetch: async () => Response.json([]),
  });
  const listener = await new Promise((resolve) => {
    const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(async () => {
    await panel.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-disk-usage-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const request = async (route = "/api/server", body) => {
    const response = await fetch(
      `http://127.0.0.1:${listener.address().port}${route}`,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    assert.equal(response.status, body === undefined ? 200 : 201);
    return response.json();
  };
  const waitFor = async (predicate) => {
    const deadline = performance.now() + 3000;
    do {
      const value = await request();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    } while (performance.now() < deadline);
    assert.fail("Disk usage did not reach the expected state.");
  };
  return {
    serverDir,
    worldFile,
    request,
    waitFor,
    advance: (milliseconds) => (now += milliseconds),
  };
}

test("routine status polling reuses disk usage for one minute", async (t) => {
  const f = await fixture(t);
  const read = fs.readdir;
  let scans = 0;
  t.mock.method(fs, "readdir", async (target, ...args) => {
    if (target === f.serverDir) scans++;
    return read(target, ...args);
  });
  await f.waitFor((value) => value.disk === 8);
  assert.equal(scans, 1);

  for (let i = 0; i < 19; i++) {
    f.advance(3000);
    assert.equal((await f.request()).disk, 8);
  }
  assert.equal(scans, 1, "three-second UI polls must not walk the world");

  // An external change is picked up at the periodic refresh boundary.
  await fs.writeFile(f.worldFile, "externally changed");
  f.advance(4000);
  await f.waitFor((value) => value.disk === 18);
  assert.equal(scans, 2);
});

test("known file changes refresh usage before the periodic deadline", async (t) => {
  const f = await fixture(t);
  await f.waitFor((value) => value.disk === 8);
  await f.request("/api/files", {
    name: "added.txt",
    type: "file",
    content: "new",
  });
  assert.equal((await f.waitFor((value) => value.disk === 11)).disk, 11);
});

test("usage scans never overlap or erase a newer file-change invalidation", async (t) => {
  const f = await fixture(t);
  const read = fs.readdir;
  const stat = fs.stat;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  let scans = 0;
  let held = false;
  t.mock.method(fs, "readdir", async (target, ...args) => {
    if (target === f.serverDir) scans++;
    return read(target, ...args);
  });
  t.mock.method(fs, "stat", async (target, ...args) => {
    const result = await stat(target, ...args);
    if (target === f.worldFile && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return result;
  });
  await f.request();
  await entered.promise;
  f.advance(70_000);
  await Promise.all(Array.from({ length: 4 }, () => f.request()));
  assert.equal(scans, 1, "even expired polls must share the active scan");

  await f.request("/api/files", {
    name: "added-during-scan.txt",
    type: "file",
    content: "new",
  });
  release.resolve();
  await f.waitFor((value) => value.disk === 11);
  assert.equal(scans, 2, "the older result must not cache stale usage");
});

test("usage scan failures are cached and recover at the next refresh", async (t) => {
  const f = await fixture(t);
  const read = fs.readdir;
  let scans = 0;
  let unavailable = true;
  t.mock.method(fs, "readdir", async (target, ...args) => {
    if (target === f.serverDir) {
      scans++;
      if (unavailable)
        throw Object.assign(new Error("Fixture drive unavailable"), {
          code: "EIO",
        });
    }
    return read(target, ...args);
  });
  await f.waitFor((value) => value.unavailable);
  f.advance(30_000);
  assert.equal((await f.request()).unavailable, true);
  assert.equal(
    scans,
    1,
    "an unavailable drive must not be probed on every poll",
  );

  unavailable = false;
  f.advance(31_000);
  const recovered = await f.waitFor(
    (value) => value.disk === 8 && !value.unavailable,
  );
  assert.equal(recovered.sourceError, null);
  assert.equal(scans, 2);
});
