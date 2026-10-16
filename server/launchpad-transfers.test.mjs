import test from "node:test";
import assert from "node:assert/strict";
import { parallelTransfers } from "./launchpad-transfers.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("twelve Launchpad transfers start in three bounded waves instead of twelve serial waits", async (t) => {
  const items = Array.from({ length: 12 }, (_, index) => index);
  const gates = items.map(deferred),
    waves = [deferred(), deferred(), deferred()];
  let started = 0,
    active = 0,
    peak = 0;
  const task = parallelTransfers(items, async (item) => {
    peak = Math.max(peak, ++active);
    started++;
    if (started % 4 === 0) waves[started / 4 - 1].resolve();
    await gates[item].promise;
    active--;
  });
  for (let wave = 0; wave < 3; wave++) {
    await waves[wave].promise;
    assert.equal(started, (wave + 1) * 4);
    assert.equal(active, 4);
    for (let index = wave * 4; index < wave * 4 + 4; index++)
      gates[index].resolve();
  }
  await task;
  assert.equal(peak, 4);
  assert.equal(active, 0);
  t.diagnostic(
    "12 downloads: 3 network-latency waves with a maximum of 4 transfers; the previous serial loop required 12 waves.",
  );
});

test("failed transfers stop queued work and drain successful in-flight files before cleanup or retry", async () => {
  const entered = deferred(),
    failureGate = deferred(),
    finishGate = deferred();
  let started = 0,
    completed = 0,
    settled = false;
  const task = parallelTransfers([0, 1, 2, 3, 4, 5], async (item) => {
    if (++started === 4) entered.resolve();
    if (item === 0) {
      await failureGate.promise;
      throw new Error("provider failed");
    }
    await finishGate.promise;
    completed++;
  }).finally(() => {
    settled = true;
  });
  const rejected = assert.rejects(task, /provider failed/);
  await entered.promise;
  failureGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(started, 4);
  finishGate.resolve();
  await rejected;
  assert.equal(completed, 3);
  assert.equal(started, 4);
});

test("cancelling a transfer batch stops every worker and awaits asynchronous cleanup", async () => {
  const controller = new AbortController(),
    entered = deferred(),
    cleanup = deferred();
  let started = 0,
    closed = 0;
  const task = parallelTransfers(
    [0, 1, 2, 3, 4],
    async (_item, _index, signal) => {
      if (++started === 4) entered.resolve();
      try {
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      } finally {
        await cleanup.promise;
        closed++;
      }
    },
    controller.signal,
  );
  const rejected = assert.rejects(task, /user cancelled/);
  await entered.promise;
  controller.abort(new Error("user cancelled"));
  assert.equal(closed, 0);
  cleanup.resolve();
  await rejected;
  assert.equal(closed, 4);
  assert.equal(started, 4);
});
