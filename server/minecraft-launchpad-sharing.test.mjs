import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import express from "express";
import { createMinecraft } from "./minecraft.mjs";
import { containedSourcePath } from "./import.mjs";

const sha512 = (bytes) => createHash("sha512").update(bytes).digest("hex");
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function eventually(work) {
  const deadline = performance.now() + 5000;
  do {
    const value = await work();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  assert.fail("The fixture did not reach its expected state.");
}
async function fixture(t, request) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "mc-minecraft-sharing-"));
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes) {
      await runtime.service.close();
      runtime.listener.closeAllConnections();
      await new Promise((resolve) => runtime.listener.close(resolve));
    }
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-minecraft-sharing-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const open = async (name) => {
    const serverDir = path.join(root, name, "server"),
      dataDir = path.join(root, name, "panel");
    await fs.mkdir(path.join(serverDir, "mods"), { recursive: true });
    await fs.mkdir(dataDir);
    const state = {
      status: "offline",
      mode: "live",
      loader: "neoforge",
      gameVersion: "1.21.1",
    };
    const service = await createMinecraft({
      serverDir,
      dataDir,
      safePath: (root, relative = "") =>
        relative ? containedSourcePath(root, relative) : fs.realpath(root),
      getConfiguration: () => state,
      getServer: async () => state,
      withMinecraftMutation: (work) => work(),
      audit: async () => {},
      fetch: request,
      extraProviders: [],
      versionsService: {},
    });
    const app = express();
    service.mount(app);
    const listener = await new Promise((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
    const runtime = {
      service,
      listener,
      add: (name, bytes) =>
        fs.writeFile(path.join(serverDir, "mods", name), bytes),
      installed: async (background = false) => {
        const response = await fetch(
          `http://127.0.0.1:${listener.address().port}/api/launchpad/installed?type=mod${background ? "&background=true" : ""}`,
        );
        assert.equal(response.status, 200);
        return response.json();
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
  return { open };
}

test("Minecraft runtimes coalesce public recovery and closing its first owner leaves another server's lookup alive", async (t) => {
  const shared = "the same bytes installed on two servers",
    hash = sha512(shared);
  const reading = gate(),
    release = gate();
  t.after(() => release.resolve());
  let sharedSignal;
  const requests = [];
  const f = await fixture(t, async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    if (pathname === "/v2/version_files")
      return new Response(null, { status: 502 });
    assert.ok(pathname.startsWith("/v2/version_file/"), pathname);
    if (pathname.endsWith(hash)) {
      sharedSignal = options.signal;
      reading.resolve();
      await release.promise;
      options.signal.throwIfAborted();
    }
    return new Response(null, { status: 404 });
  });
  const first = await f.open("first"),
    second = await f.open("second");
  await first.add("seed.jar", "seed the shared failing POST circuit");
  await first.installed();
  assert.equal(
    requests.filter((route) => route === "/v2/version_files").length,
    1,
  );

  await first.add("shared.jar", shared);
  await second.add("shared.jar", shared);
  assert.equal((await first.installed(true)).checkingUpdates, true);
  await reading.promise;
  assert.equal((await second.installed(true)).checkingUpdates, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    requests.filter((route) => route.endsWith(hash)).length,
    1,
    "both real runtimes join one GET",
  );
  assert.equal(
    requests.filter((route) => route === "/v2/version_files").length,
    1,
    "both real runtimes share the POST outage budget",
  );
  await first.service.close();
  assert.equal(
    sharedSignal.aborted,
    false,
    "the transport must not capture the first runtime's lifetime",
  );
  release.resolve();
  const completed = await eventually(async () => {
    const result = await second.installed();
    return !result.checkingUpdates && result;
  });
  assert.equal(completed.items.length, 1);
  assert.deepEqual(completed.warnings, [
    "Choose this server's Minecraft version and loader above to check for updates.",
  ]);

  await second.add("later.jar", "a new hash after the first runtime closes");
  const later = await second.installed();
  assert.equal(later.items.length, 2);
  assert.ok(
    requests.some((route) =>
      route.endsWith(sha512("a new hash after the first runtime closes")),
    ),
  );
  assert.equal(
    requests.filter((route) => route === "/v2/version_files").length,
    1,
  );
});

test("Minecraft runtimes use one six-request public recovery budget", async (t) => {
  const held = [],
    requests = [];
  let holding = true,
    active = 0,
    maximum = 0;
  t.after(() => {
    holding = false;
    for (const release of held) release();
  });
  const f = await fixture(t, async (url) => {
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    if (pathname === "/v2/version_files")
      return new Response(null, { status: 502 });
    assert.ok(pathname.startsWith("/v2/version_file/"), pathname);
    active++;
    maximum = Math.max(maximum, active);
    try {
      if (holding) await new Promise((resolve) => held.push(resolve));
      return new Response(null, { status: 404 });
    } finally {
      active--;
    }
  });
  const first = await f.open("first"),
    second = await f.open("second");
  for (let index = 0; index < 7; index++) {
    await first.add(`${index}.jar`, `first server unique mod ${index}`);
    await second.add(`${index}.jar`, `second server unique mod ${index}`);
  }
  await first.installed(true);
  await eventually(() => held.length === 6);
  await second.installed(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 6);
  assert.equal(
    requests.filter((route) => route === "/v2/version_files").length,
    1,
  );
  holding = false;
  for (const release of held) release();
  for (const runtime of [first, second])
    await eventually(async () => {
      const result = await runtime.installed();
      return !result.checkingUpdates && result;
    });
  assert.equal(maximum, 6);
  assert.equal(
    requests.filter((route) => route.startsWith("/v2/version_file/")).length,
    14,
  );
});
