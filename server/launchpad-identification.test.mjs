import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createCoreProviders } from "./launchpad-providers.mjs";

const hash = (index) => index.toString(16).padStart(128, "0");
const rows = (count) =>
  Array.from({ length: count }, (_, index) => hash(index));
const json = (value) => new Response(JSON.stringify(value));
const identified = (hashes) =>
  Object.fromEntries(
    hashes.map((value) => [
      value,
      {
        id: `v${parseInt(value, 16)}`,
        project_id: `p${parseInt(value, 16)}`,
        name: "Installed release",
      },
    ]),
  );

test("220 installed files use three bounded batches and overlapping callers reuse content identities", async () => {
  const batches = [];
  let active = 0,
    peak = 0;
  const [provider] = createCoreProviders({
    fetch: async (url, options) => {
      assert.equal(url, "https://api.modrinth.com/v2/version_files");
      assert.equal(options.method, "POST");
      const { hashes, algorithm } = JSON.parse(options.body);
      assert.equal(algorithm, "sha512");
      assert.ok(hashes.length <= 100);
      batches.push(hashes);
      peak = Math.max(peak, ++active);
      await delay(5);
      active--;
      return json(identified(hashes));
    },
  });
  const first = provider.identifyInstalled(rows(220));
  const overlapping = provider.identifyInstalled(rows(120));
  const [all, subset] = await Promise.all([first, overlapping]);
  assert.equal(Object.keys(all.matches).length, 220);
  assert.equal(Object.keys(subset.matches).length, 120);
  assert.equal(peak, 2);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 20],
  );
  assert.deepEqual(all.warnings, []);
  await provider.identifyInstalled(rows(220).reverse());
  assert.equal(
    batches.length,
    3,
    "unchanged content does not re-contact the provider",
  );
  await provider.identifyInstalled([hash(221)]);
  assert.equal(batches.length, 4, "a changed file gets a new identity lookup");
});

test("an identification outage stops queued batches and polling never extends its retry deadline", async (t) => {
  let now = Date.now(),
    calls = 0,
    failing = true;
  t.mock.method(Date, "now", () => now);
  const [provider] = createCoreProviders({
    fetch: async (_url, options) => {
      calls++;
      return failing
        ? new Response("offline", { status: 503 })
        : json(identified(JSON.parse(options.body).hashes));
    },
  });
  const failed = await provider.identifyInstalled(rows(220));
  assert.equal(calls, 2);
  assert.deepEqual(failed.matches, {});
  assert.equal(failed.warnings.length, 1);
  assert.match(failed.warnings[0], /503/);
  for (let scan = 0; scan < 4; scan++) {
    now += 5000;
    assert.deepEqual(await provider.identifyInstalled(rows(220)), failed);
  }
  assert.equal(calls, 2);
  failing = false;
  now += 10_001;
  const recovered = await provider.identifyInstalled(rows(220));
  assert.equal(calls, 5);
  assert.equal(Object.keys(recovered.matches).length, 220);
  assert.deepEqual(recovered.warnings, []);
});

test("successful identities survive a failed neighboring batch without caching failures as not found", async (t) => {
  let now = Date.now(),
    calls = 0,
    failing = true;
  t.mock.method(Date, "now", () => now);
  const [provider] = createCoreProviders({
    fetch: async (_url, options) => {
      calls++;
      const hashes = JSON.parse(options.body).hashes;
      return failing && hashes.includes(hash(100))
        ? new Response("gateway", { status: 502 })
        : json(identified(hashes));
    },
  });
  const result = await provider.identifyInstalled(rows(200));
  assert.equal(Object.keys(result.matches).length, 100);
  assert.equal(result.warnings.length, 1);
  now += 30_001;
  failing = false;
  const recovered = await provider.identifyInstalled(rows(200));
  assert.equal(calls, 3, "only the failed batch is retried");
  assert.equal(Object.keys(recovered.matches).length, 200);
  assert.deepEqual(recovered.warnings, []);
});

test("one cancelled reader cannot cancel a shared identification used by another installed view", async () => {
  let calls = 0,
    finish,
    entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const [provider] = createCoreProviders({
    fetch: async (_url, options) => {
      calls++;
      const result = new Promise((resolve) => {
        finish = () =>
          resolve(json(identified(JSON.parse(options.body).hashes)));
      });
      entered();
      return result;
    },
  });
  const caller = new AbortController();
  const abandoned = provider.identifyInstalled([hash(1)], {
    signal: caller.signal,
  });
  const observed = assert.rejects(abandoned, /view closed/);
  await ready;
  const surviving = provider.identifyInstalled([hash(1)]);
  caller.abort(new Error("view closed"));
  await observed;
  finish();
  assert.equal(Object.keys((await surviving).matches).length, 1);
  assert.equal(calls, 1);
});

for (const stalled of ["request", "body"])
  test(`identification has an eight-second budget even when a ${stalled} ignores abort`, async (t) => {
    const deadlines = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", (ms) => {
      if (ms !== 8000) return timeout(ms);
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    });
    let calls = 0,
      entered;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const [provider] = createCoreProviders({
      fetch: async () => {
        if (++calls === 2) entered();
        return stalled === "request"
          ? new Promise(() => {})
          : new Response(new ReadableStream({ start() {} }));
      },
    });
    const result = provider.identifyInstalled(rows(220));
    await ready;
    for (const deadline of deadlines)
      deadline.abort(new DOMException("expired", "TimeoutError"));
    const completed = await result;
    assert.equal(
      calls,
      2,
      "queued batch does not wait through another outage timeout",
    );
    assert.deepEqual(completed.matches, {});
    assert.equal(completed.warnings.length, 1);
    assert.match(completed.warnings[0], /took too long/);
  });

test("missing identities expire and invalid hashes are rejected before contacting the provider", async (t) => {
  let now = Date.now(),
    calls = 0;
  t.mock.method(Date, "now", () => now);
  const [provider] = createCoreProviders({
    fetch: async () => {
      calls++;
      return json({});
    },
  });
  await assert.rejects(provider.identifyInstalled(["invalid"]), /valid SHA512/);
  assert.equal(calls, 0);
  assert.deepEqual(await provider.identifyInstalled([hash(1)]), {
    matches: {},
    warnings: [],
  });
  now += 30_000;
  await provider.identifyInstalled([hash(1)]);
  assert.equal(calls, 1);
  now += 30_001;
  await provider.identifyInstalled([hash(1)]);
  assert.equal(calls, 2);
});

test("an overlapping gateway failure cannot shorten a provider rate-limit cooldown", async (t) => {
  let now = Date.now(),
    calls = 0;
  t.mock.method(Date, "now", () => now);
  const [provider] = createCoreProviders({
    fetch: async () => {
      const call = ++calls;
      if (call === 2) await delay(5);
      return call <= 2
        ? new Response("failed", { status: call === 1 ? 429 : 502 })
        : json({});
    },
  });
  await provider.identifyInstalled(rows(200));
  assert.equal(calls, 2);
  now += 31_000;
  await provider.identifyInstalled([hash(201)]);
  assert.equal(
    calls,
    2,
    "gateway errors retain the earlier rate-limit deadline",
  );
  now += 29_001;
  await provider.identifyInstalled([hash(202)]);
  assert.equal(calls, 3);
});
