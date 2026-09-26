import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createModrinthRecovery } from "./launchpad-recovery.mjs";

test("a failing identification POST does not suppress the independent update route", async () => {
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
  assert.deepEqual(calls, ["identify", "updates", "one"]);
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

test("public hash POST firewall denials use GET recovery and cool down the blocked route", async () => {
  let now = 0;
  const calls = [];
  const recovery = createModrinthRecovery(
    async (url, options) => {
      calls.push(url);
      if (options.method === "POST")
        throw Object.assign(new Error("Modrinth firewall rejection"), {
          status: 502,
          upstreamStatus: 403,
          upstreamContentType: "text/html; charset=utf-8",
        });
      return { id: "known" };
    },
    { now: () => now },
  );
  const identify = "https://api.modrinth.com/v2/version_files";
  const updates = `${identify}/update`;
  const file = "https://api.modrinth.com/v2/version_file/hash";
  for (const url of [identify, updates, identify, updates])
    await assert.rejects(recovery.bulk(url, { method: "POST" }), {
      useFallback: true,
    });
  assert.deepEqual(await recovery.read(file), { id: "known" });
  assert.deepEqual(calls, [identify, updates, file]);
  now = 60001;
  await assert.rejects(recovery.bulk(identify, { method: "POST" }), {
    useFallback: true,
  });
  assert.deepEqual(calls, [identify, updates, file, identify]);
});

test("firewall recovery does not apply to authorization, rate limits or unrelated routes", async () => {
  const url = "https://api.modrinth.com/v2/version_files";
  const cases = [
    { status: 401 },
    { status: 429 },
    { contentType: "application/json" },
    { contentType: "" },
    { headers: { Authorization: "fixture-token" } },
    { headers: new Headers({ "X-API-Key": "fixture-key" }) },
    { method: "GET" },
    { url: "https://api.modrinth.com/v2/project/private" },
    { url: "https://api.modrinth.com/v2/version/private" },
    { url: "https://api.curseforge.com/v1/fingerprints/432" },
    { url: "https://untrusted.example/v2/version_files" },
  ];
  for (const input of cases) {
    const status = input.status ?? 403;
    const recovery = createModrinthRecovery(async () => {
      throw Object.assign(new Error("Rejected"), {
        status: status === 429 ? 429 : 502,
        upstreamStatus: status,
        upstreamContentType: input.contentType ?? "text/html",
      });
    });
    await assert.rejects(
      recovery.bulk(input.url ?? url, {
        method: input.method ?? "POST",
        headers: input.headers,
      }),
      (cause) => !cause.useFallback && cause.upstreamStatus === status,
    );
  }
});

test("a cached public firewall denial cannot redirect an authenticated batch into recovery", async () => {
  let calls = 0;
  const recovery = createModrinthRecovery(async () => {
    calls++;
    throw Object.assign(new Error("Rejected"), {
      status: 502,
      upstreamStatus: 403,
      upstreamContentType: "text/html",
    });
  });
  const url = "https://api.modrinth.com/v2/version_files";
  await assert.rejects(recovery.bulk(url, { method: "POST" }), {
    useFallback: true,
  });
  await assert.rejects(
    recovery.bulk(url, {
      method: "POST",
      headers: { Authorization: "fixture-token" },
    }),
    (cause) => !cause.useFallback && cause.upstreamStatus === 403,
  );
  assert.equal(calls, 2);
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
  await assert.rejects(second.bulk("identify", { method: "POST" }), {
    useFallback: true,
  });
  assert.equal(await second.read("metadata"), "metadata");
  assert.deepEqual(calls, ["identify", "metadata"]);
});

test("three slow files cannot give their timeout to the remaining 221-file refresh", async () => {
  const calls = [];
  const recovery = createModrinthRecovery(
    async (url) => {
      const index = Number(new URL(url).searchParams.get("index"));
      calls.push(index);
      if (index >= 49 && index < 52) return new Promise(() => {});
      return index;
    },
    { requestTimeoutMs: 15 },
  );
  const work = Promise.allSettled(
    Array.from({ length: 221 }, (_, index) =>
      recovery.read(
        `https://api.modrinth.com/v2/project/p${index}/version?index=${index}`,
      ),
    ),
  );
  const [results] = await Promise.all([work, delay(40)]);
  assert.equal(calls.length, 221);
  assert.equal(
    results.filter((value) => value.status === "fulfilled").length,
    218,
  );
  assert.deepEqual(
    results.flatMap((value, index) =>
      value.status === "rejected" ? [index] : [],
    ),
    [49, 50, 51],
  );
});

test("a bulk metadata outage leaves project-history recovery available", async () => {
  const calls = [];
  const recovery = createModrinthRecovery(async (url) => {
    calls.push(url);
    if (new URL(url).pathname === "/v2/versions")
      throw Object.assign(new Error("Bulk unavailable"), {
        status: 502,
        upstreamStatus: 503,
      });
    return [{ id: "verified" }];
  });
  for (let index = 0; index < 3; index++)
    await assert.rejects(
      recovery.read(`https://api.modrinth.com/v2/versions?ids=${index}`),
    );
  await assert.rejects(
    recovery.read("https://api.modrinth.com/v2/versions?ids=4"),
  );
  assert.deepEqual(
    await recovery.read("https://api.modrinth.com/v2/project/healthy/version"),
    [{ id: "verified" }],
  );
  assert.equal(calls.length, 4, "only the failing bulk route is paused");
});

test("update POST can retain its earlier request budget without extending identity probes", async () => {
  const optionsSeen = [];
  const recovery = createModrinthRecovery(
    async (_url, options) => {
      optionsSeen.push(options);
      await delay(25);
      return { verified: true };
    },
    { bulkTimeoutMs: 10 },
  );
  await assert.rejects(recovery.bulk("identify", { method: "POST" }), {
    useFallback: true,
  });
  assert.deepEqual(
    await recovery.bulk("updates", { method: "POST", timeoutMs: 60 }),
    { verified: true },
  );
  assert.ok(optionsSeen.every((options) => !("timeoutMs" in options)));
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
