import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createModrinthRecovery } from "./launchpad-recovery.mjs";

test("failing POST routes share a circuit while GET metadata stays available", async () => {
  const calls = [];
  const recovery = createModrinthRecovery(async (url, options) => {
    calls.push(url);
    if (options.method === "POST")
      throw Object.assign(new Error("Unavailable"), {
        status: 502,
        upstreamStatus: 503,
      });
    return { id: "known" };
  });
  await assert.rejects(recovery.bulk("identify", { method: "POST" }), {
    useFallback: true,
  });
  await assert.rejects(recovery.bulk("updates", { method: "POST" }), {
    useFallback: true,
  });
  assert.deepEqual(await recovery.read("one"), { id: "known" });
  assert.deepEqual(calls, ["identify", "one"]);
});

test("authentication errors and rate limits do not fan out into fallback requests", async () => {
  for (const status of [400, 401, 403, 429]) {
    let calls = 0;
    const recovery = createModrinthRecovery(async () => {
      calls++;
      throw Object.assign(new Error("Rejected"), {
        status: status === 429 ? 429 : 502,
        upstreamStatus: status,
      });
    });
    await assert.rejects(
      recovery.bulk("identify", { method: "POST" }),
      (cause) => !cause.useFallback && cause.upstreamStatus === status,
    );
    if (status === 429) {
      await assert.rejects(recovery.bulk("updates", { method: "POST" }), {
        status: 429,
      });
      assert.equal(calls, 1);
    }
  }
});

test("concurrent readers share a cached lookup but leave independently", async () => {
  let finish;
  let calls = 0;
  const recovery = createModrinthRecovery(async () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const controller = new AbortController();
  const first = recovery.read("immutable", { signal: controller.signal });
  const firstDone = assert.rejects(first, { name: "AbortError" });
  const second = recovery.read("immutable");
  await delay(0);
  controller.abort();
  await firstDone;
  finish({ version: "one" });
  assert.deepEqual(await second, { version: "one" });
  assert.deepEqual(await recovery.read("immutable"), { version: "one" });
  assert.equal(calls, 1);
});

test("recovery enforces both concurrency and its rolling request budget", async () => {
  const starts = [];
  let running = 0,
    maximum = 0;
  const recovery = createModrinthRecovery(
    async (url) => {
      starts.push(Date.now());
      running++;
      maximum = Math.max(maximum, running);
      await delay(5);
      running--;
      return url;
    },
    { concurrency: 2, maxReads: 3, windowMs: 60 },
  );
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => recovery.read(String(i))),
    ),
    ["0", "1", "2", "3", "4", "5"],
  );
  assert.equal(maximum, 2);
  assert.ok(
    starts[3] - starts[0] >= 55,
    "the fourth request waits for the rolling window",
  );
});

test("orphaned queued reads never reach the provider", async () => {
  const calls = [];
  let finish;
  const recovery = createModrinthRecovery(
    async (url) => {
      calls.push(url);
      if (url === "first")
        return new Promise((resolve) => {
          finish = resolve;
        });
      return url;
    },
    { concurrency: 1 },
  );
  const first = recovery.read("first");
  const controller = new AbortController();
  const second = recovery.read("second", { signal: controller.signal });
  const secondDone = assert.rejects(second, { name: "AbortError" });
  await delay(0);
  controller.abort();
  await secondDone;
  finish("first");
  await first;
  await delay(0);
  assert.deepEqual(calls, ["first"]);
});

test("uncooperative requests cannot occupy a queue lane beyond their deadline", async () => {
  const recovery = createModrinthRecovery(
    async (url) => (url === "hung" ? new Promise(() => {}) : "next"),
    { concurrency: 1, requestTimeoutMs: 10, bulkTimeoutMs: 10 },
  );
  await Promise.all([
    assert.rejects(recovery.read("hung"), { name: "TimeoutError" }),
    assert.equal(await recovery.read("next"), "next"),
    delay(25),
  ]);
  await Promise.all([
    assert.rejects(recovery.bulk("hung", { method: "POST" }), {
      useFallback: true,
    }),
    delay(25),
  ]);
});

test("mutable metadata can expire independently of immutable file identity", async () => {
  let now = 0;
  let calls = 0;
  const recovery = createModrinthRecovery(async () => ++calls, {
    now: () => now,
  });
  assert.equal(await recovery.read("versions", { ttlMs: 30 }), 1);
  assert.equal(await recovery.read("file"), 2);
  now = 31;
  assert.equal(await recovery.read("versions", { ttlMs: 30 }), 3);
  assert.equal(await recovery.read("file"), 2);
});

test("servers using the same public transport share the recovery budget and circuit", async () => {
  const transport = async () => {};
  const calls = [];
  const first = createModrinthRecovery(
    async (url, options) => {
      calls.push(url);
      if (options.method === "POST")
        throw Object.assign(new Error("Unavailable"), { status: 502 });
      return url;
    },
    { sharingKey: transport },
  );
  const second = createModrinthRecovery(
    async () => {
      throw new Error("Separate request budget");
    },
    { sharingKey: transport },
  );
  assert.equal(first, second);
  await assert.rejects(first.bulk("identify", { method: "POST" }), {
    useFallback: true,
  });
  await assert.rejects(second.bulk("updates", { method: "POST" }), {
    useFallback: true,
  });
  assert.equal(await second.read("metadata"), "metadata");
  assert.deepEqual(calls, ["identify", "metadata"]);
});

test("a complete GET outage stops queued recovery without a request per file", async () => {
  let now = 0,
    calls = 0,
    failing = true;
  const recovery = createModrinthRecovery(
    async (url) => {
      calls++;
      if (failing)
        throw Object.assign(new Error("Unavailable"), {
          status: 502,
          upstreamStatus: 503,
        });
      return url;
    },
    { now: () => now },
  );
  const results = await Promise.allSettled(
    Array.from({ length: 220 }, (_, i) => recovery.read(String(i))),
  );
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.ok(calls <= 6, `outage sent ${calls} GETs`);
  const failedCalls = calls;
  await assert.rejects(recovery.read("another"), { upstreamStatus: 503 });
  assert.equal(calls, failedCalls);
  now = 30001;
  failing = false;
  assert.equal(await recovery.read("recovered"), "recovered");
});

test("an upstream rate limit stops queued reads immediately and honors retry-after", async () => {
  let now = 0,
    calls = 0;
  const recovery = createModrinthRecovery(
    async () => {
      calls++;
      throw Object.assign(new Error("Rate limited"), {
        status: 429,
        upstreamStatus: 429,
        retryAfterMs: 120000,
      });
    },
    { now: () => now },
  );
  const results = await Promise.allSettled(
    Array.from({ length: 220 }, (_, i) => recovery.read(String(i))),
  );
  assert.ok(
    results.every(
      (result) => result.status === "rejected" && result.reason.status === 429,
    ),
  );
  assert.ok(calls <= 6);
  const limitedCalls = calls;
  now = 60001;
  await assert.rejects(recovery.read("later"), { status: 429 });
  assert.equal(calls, limitedCalls);
});
