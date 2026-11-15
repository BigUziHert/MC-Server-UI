import test from "node:test";
import assert from "node:assert/strict";
import { startSelectedServers } from "./automatic-start.mjs";

test("automatic startup waits for readiness before starting the next server and records memory as advisory", async () => {
  const states = new Map(
    ["a", "b"].map((id) => [
      id,
      { name: id, status: "offline", configuredMemoryLimitMB: 6000 },
    ]),
  );
  const order = [];
  const result = await startSelectedServers({
    serverIds: ["a", "b"],
    runtimeFor: (id) => ({ descriptor: () => states.get(id) }),
    start: async (id) => {
      if (id === "b") assert.equal(states.get("a").status, "running");
      order.push(id);
      states.get(id).status = "starting";
    },
    wait: async () => {
      states.get(order.at(-1)).status = "running";
    },
    hostMemoryMB: 8192,
  });
  assert.deepEqual(order, ["a", "b"]);
  assert.deepEqual(result.startedServerIds, ["a", "b"]);
  assert.deepEqual(result.failures, []);
  assert.match(result.warnings.join("\n"), /12000 MB/);
});

test("unavailable folders retry with backoff but removed IDs never start and keep their saved name", async () => {
  let attempts = 0;
  const state = {
    name: "External modpack",
    status: "offline",
    unavailable: true,
    sourceError: "Drive not connected",
    configuredMemoryLimitMB: null,
  };
  const waits = [];
  const result = await startSelectedServers({
    serverIds: ["gone", "external"],
    names: { gone: "Old modpack" },
    runtimeFor: (id) =>
      id === "external" ? { descriptor: () => state } : undefined,
    start: async (id) => {
      assert.equal(id, "external");
      if (++attempts < 3) throw new Error("Unavailable");
      state.unavailable = false;
      state.status = "running";
    },
    retryDelays: [15, 30],
    wait: async (ms) => waits.push(ms),
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [15, 30]);
  assert.deepEqual(result.startedServerIds, ["external"]);
  assert.match(result.failures[0].message, /Old modpack: Removed/);
  assert.match(result.warnings[0], /unknown memory/);
});

test("startup exit is reported and the remaining server still starts", async () => {
  const states = {
    a: { name: "Failed pack", status: "offline" },
    b: { name: "Good pack", status: "offline", configuredMemoryLimitMB: 2048 },
  };
  const result = await startSelectedServers({
    serverIds: ["a", "b"],
    runtimeFor: (id) => ({ descriptor: () => states[id] }),
    start: async (id) => {
      states[id].status = id === "a" ? "offline" : "running";
    },
  });
  assert.deepEqual(result.startedServerIds, ["b"]);
  assert.match(result.failures[0].message, /Failed pack.*exited before/);
});

test("retry recognizes a server started manually without starting another process", async () => {
  const state = {
    name: "Already repaired",
    status: "starting",
    configuredMemoryLimitMB: 2048,
  };
  const result = await startSelectedServers({
    serverIds: ["one"],
    runtimeFor: () => ({ descriptor: () => state }),
    start: async () => assert.fail("A process is already starting"),
    wait: async () => {
      state.status = "running";
    },
  });
  assert.deepEqual(result.startedServerIds, ["one"]);
  assert.deepEqual(result.failures, []);
});
