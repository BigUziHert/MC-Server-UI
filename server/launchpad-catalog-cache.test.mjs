import test from "node:test";
import assert from "node:assert/strict";
import { createLaunchpadCatalogCache } from "./launchpad-catalog-cache.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("catalog pages reuse provider requests until refresh, expiry or settings invalidation", async () => {
  let now = 0,
    calls = 0;
  const cache = createLaunchpadCatalogCache({ now: () => now });
  const load = async () => ({ projects: [{ title: `result-${++calls}` }] });
  const first = await cache.read("query", load);
  first.projects[0].title = "changed by caller";
  for (let index = 0; index < 10; index++)
    assert.equal(
      (await cache.read("query", load)).projects[0].title,
      "result-1",
    );
  assert.equal(calls, 1);
  assert.equal(
    (await cache.read("query", load, { refresh: true })).projects[0].title,
    "result-2",
  );
  now = 30_001;
  await cache.read("query", load);
  assert.equal(calls, 3);
  cache.clear();
  await cache.read("query", load);
  assert.equal(calls, 4);
});

test("overlapping catalog pages share requests and one cancelled reader does not cancel the others", async () => {
  const cache = createLaunchpadCatalogCache(),
    gate = deferred(),
    entered = deferred();
  const caller = new AbortController();
  let calls = 0,
    upstreamSignal;
  const load = async (signal) => {
    calls++;
    upstreamSignal = signal;
    entered.resolve();
    await gate.promise;
    return { projects: [{ title: "shared" }] };
  };
  const first = cache.read("shared", load, { signal: caller.signal });
  const second = cache.read("shared", load);
  await entered.promise;
  const rejected = assert.rejects(first, /reader left/);
  caller.abort(new Error("reader left"));
  await rejected;
  assert.equal(upstreamSignal.aborted, false);
  gate.resolve();
  assert.equal((await second).projects[0].title, "shared");
  assert.equal(calls, 1);
});

test("the final cancelled catalog reader aborts provider IO and abandoned results never refill the cache", async () => {
  const cache = createLaunchpadCatalogCache(),
    gate = deferred(),
    entered = deferred();
  const caller = new AbortController();
  let upstreamSignal,
    calls = 0;
  const first = cache.read(
    "shared",
    async (signal) => {
      upstreamSignal = signal;
      entered.resolve();
      await gate.promise;
      return { stale: true };
    },
    { signal: caller.signal },
  );
  await entered.promise;
  const rejected = assert.rejects(first, /reader left/);
  caller.abort(new Error("reader left"));
  await rejected;
  assert.equal(upstreamSignal.aborted, true);
  assert.deepEqual(
    await cache.read("shared", async () => {
      calls++;
      return { fresh: true };
    }),
    { fresh: true },
  );
  gate.resolve();
  assert.deepEqual(
    await cache.read("shared", async () => {
      calls++;
      return {};
    }),
    { fresh: true },
  );
  assert.equal(calls, 1);
});

test("catalog failure is not cached and entry/byte limits evict old pages", async () => {
  const cache = createLaunchpadCatalogCache({ maxEntries: 2, maxBytes: 100 });
  await assert.rejects(
    cache.read("failure", async () => {
      throw new Error("provider unavailable");
    }),
    /unavailable/,
  );
  assert.equal(
    await cache.read("failure", async () => "recovered"),
    "recovered",
  );
  await cache.read("second", async () => "second");
  await cache.read("third", async () => "third");
  assert.equal(await cache.read("failure", async () => "evicted"), "evicted");
  let largeCalls = 0;
  const large = async () => {
    largeCalls++;
    return "a".repeat(101);
  };
  await cache.read("large", large);
  await cache.read("large", large);
  assert.equal(
    largeCalls,
    2,
    "an oversized response is returned but not retained",
  );
});

test("settings invalidation prevents an old in-flight request from replacing newer catalog pages", async () => {
  const cache = createLaunchpadCatalogCache(),
    gate = deferred(),
    entered = deferred();
  const pending = cache.read("page", async () => {
    entered.resolve();
    await gate.promise;
    return "old settings";
  });
  await entered.promise;
  cache.clear();
  await cache.read("page", async () => "new settings");
  gate.resolve();
  assert.equal(await pending, "old settings");
  assert.equal(
    await cache.read("page", async () => "unnecessary fetch"),
    "new settings",
  );
});
