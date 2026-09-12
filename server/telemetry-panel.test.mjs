import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createFleet } from "./index.mjs";

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const metric = (cpu = 123.4, memory = 314572800) => ({
  available: true,
  cpu,
  memory,
  processCount: 2,
  sampledAt: Date.now(),
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-telemetry-panel-"));
  const children = [];
  const resets = [];
  const calls = [];
  let sample = async () => metric();
  const pendingGates = [];
  const fleet = await createFleet({
    dataDir: root,
    createDefaultServer: false,
    useEnvironment: false,
    scheduler: false,
    publicAddress: { resolve: async () => null },
    telemetry: {
      sample: (pid) => {
        calls.push(pid);
        return sample(pid);
      },
      reset: (pid) => resets.push(pid),
      close: () => {},
    },
    spawnServer: () => {
      const child = new EventEmitter();
      child.pid = 4000 + children.length;
      child.exitCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stop = () => {
        child.exitCode = 0;
        child.emit("close", 0);
      };
      child.kill = child.stop;
      child.stdin = new Writable({
        write(chunk, _encoding, done) {
          if (chunk.toString() === "stop\n") setImmediate(child.stop);
          done();
        },
      });
      children.push(child);
      setImmediate(() =>
        child.stdout.write(
          '[Server thread/INFO]: Done (1.0s)! For help, type "help"\n',
        ),
      );
      return child;
    },
  });
  const listener = await new Promise((resolve) => {
    const server = fleet.app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const request = async (route, options = {}, id) => {
    const response = await fetch(base + route, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(id ? { "X-Server-Id": id } : {}),
        ...options.headers,
      },
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    for (const gate of pendingGates) gate.resolve(metric());
    await fleet.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-telemetry-panel-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const create = async (port = 25565) => {
    const response = await request(
      "/api/servers",
      json("POST", { name: "Telemetry server", mode: "live", port }),
    );
    assert.equal(response.status, 201);
    const id = response.body.server.id;
    const serverDir = fleet.runtimes.get(id).serverDir;
    await fs.writeFile(path.join(serverDir, "server.jar"), "never executed");
    await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
    return id;
  };
  return {
    request,
    create,
    children,
    calls,
    resets,
    setSample: (next) => {
      sample = next;
    },
    gate: () => {
      const gate = deferred();
      pendingGates.push(gate);
      return gate;
    },
  };
}

test("live panel exposes process CPU and resident memory while retaining the configured heap limit", async (t) => {
  const panel = await fixture(t);
  const id = await panel.create();
  const offline = (await panel.request("/api/server", {}, id)).body;
  assert.equal(offline.cpu, 0);
  assert.equal(offline.memory, 0);
  assert.equal(panel.calls.length, 0);
  assert.equal(
    (
      await panel.request(
        "/api/server/power",
        json("POST", { action: "start" }),
        id,
      )
    ).status,
    200,
  );
  panel.setSample(async () => metric(null));
  const first = (await panel.request("/api/server", {}, id)).body;
  assert.equal(first.metricsAvailable, true);
  assert.equal(first.cpu, null);
  assert.equal(first.memory, 314572800);
  assert.match(first.metricsMessage, /Measuring CPU/);
  panel.setSample(async () => metric());
  const measured = (await panel.request("/api/server", {}, id)).body;
  assert.equal(measured.cpu, 123.4);
  assert.equal(measured.processCount, 2);
  assert.equal(measured.memoryLimit, 4096 * 1024 ** 2);
  assert.deepEqual(panel.calls, [4000, 4000]);
  assert.ok(panel.resets.includes(4000));
});

test("live panel reports telemetry failures without claiming a measured zero", async (t) => {
  const panel = await fixture(t);
  const id = await panel.create();
  await panel.request(
    "/api/server/power",
    json("POST", { action: "start" }),
    id,
  );
  panel.setSample(async () => ({
    available: false,
    cpu: null,
    memory: null,
    processCount: 0,
    error: "Process counters unavailable",
  }));
  const response = await panel.request("/api/server", {}, id);
  assert.equal(response.status, 200);
  assert.equal(response.body.metricsAvailable, false);
  assert.equal(response.body.cpu, null);
  assert.equal(response.body.memory, null);
  assert.equal(response.body.metricsMessage, "Process counters unavailable");
});

test("telemetry requested before exit cannot populate offline or restarted server metrics", async (t) => {
  const panel = await fixture(t);
  const id = await panel.create();
  await panel.request(
    "/api/server/power",
    json("POST", { action: "start" }),
    id,
  );
  const waiting = panel.gate();
  const entered = panel.gate();
  panel.setSample(async () => {
    entered.resolve();
    return waiting.promise;
  });
  const pending = panel.request("/api/server", {}, id);
  await entered.promise;
  panel.children[0].stop();
  await panel.request(
    "/api/server/power",
    json("POST", { action: "start" }),
    id,
  );
  waiting.resolve(metric(999, 999999));
  const stale = (await pending).body;
  assert.equal(stale.cpu, null);
  assert.equal(stale.memory, null);
  assert.equal(stale.metricsAvailable, false);
  panel.setSample(async () => metric(25, 500000));
  const fresh = (await panel.request("/api/server", {}, id)).body;
  assert.equal(fresh.cpu, 25);
  assert.equal(fresh.memory, 500000);
  assert.equal(panel.calls.at(-1), 4001);
  assert.ok(panel.resets.filter((pid) => pid === 4000).length >= 2);
});

test("an exited child with open inherited output pipes cannot retain live resource metrics", async (t) => {
  const panel = await fixture(t);
  const id = await panel.create();
  await panel.request(
    "/api/server/power",
    json("POST", { action: "start" }),
    id,
  );
  const waiting = panel.gate();
  const entered = panel.gate();
  panel.setSample(async () => {
    entered.resolve();
    return waiting.promise;
  });
  const pending = panel.request("/api/server", {}, id);
  await entered.promise;
  panel.children[0].exitCode = 0;
  waiting.resolve(metric());
  const response = (await pending).body;
  assert.equal(response.metricsAvailable, false);
  assert.equal(response.cpu, null);
  assert.equal(response.memory, null);
  panel.children[0].stop();
});

test("the fleet samples only the process belonging to the selected server", async (t) => {
  const panel = await fixture(t);
  const first = await panel.create(25565);
  const second = await panel.create(25566);
  await panel.request(
    "/api/server/power",
    json("POST", { action: "start" }),
    first,
  );
  await panel.request(
    "/api/server/power",
    json("POST", { action: "start" }),
    second,
  );
  panel.setSample(async (pid) => metric(pid === 4000 ? 10 : 20, pid * 100));
  const responses = await Promise.all([
    panel.request("/api/server", {}, first),
    panel.request("/api/server", {}, second),
  ]);
  assert.deepEqual(
    responses.map((response) => response.body.cpu),
    [10, 20],
  );
  assert.deepEqual(new Set(panel.calls), new Set([4000, 4001]));
});
