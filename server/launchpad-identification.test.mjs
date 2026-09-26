import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createCoreProviders } from "./launchpad-providers.mjs";
import { createInstalledIdentification } from "./launchpad-identification.mjs";
import { providerJson } from "./launchpad-network.mjs";

// Preserve the original batch-only API's behavior independently of the new
// provider recovery transport used by createCoreProviders.
const batchOnlyProvider = ({ fetch }) => [
  {
    identifyInstalled: createInstalledIdentification((hashes, signal) =>
      providerJson("https://api.modrinth.com/v2/version_files", {
        fetch,
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hashes, algorithm: "sha512" }),
      }),
    ),
  },
];

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
  const [provider] = batchOnlyProvider({
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
  const [provider] = batchOnlyProvider({
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
  const [provider] = batchOnlyProvider({
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
  const [provider] = batchOnlyProvider({
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
    const [provider] = batchOnlyProvider({
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
  const [provider] = batchOnlyProvider({
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
  const [provider] = batchOnlyProvider({
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

const fallbackError = () =>
  Object.assign(new Error("Bulk endpoint unavailable"), {
    status: 502,
    useFallback: true,
  });
const recoveredVersion = (value) => ({
  id: `v${parseInt(value, 16)}`,
  project_id: `p${parseInt(value, 16)}`,
  name: "Verified installed release",
  files: [{ hashes: { sha512: value } }],
});

test("220 installed identities recover through verified GET requests after the bulk endpoint fails", async () => {
  let posts = 0,
    reads = 0,
    active = 0,
    peak = 0;
  const [provider] = createCoreProviders({
    fetch: async (url, options) => {
      const address = new URL(url);
      if (options.method === "POST") {
        posts++;
        assert.equal(address.pathname, "/v2/version_files");
        return new Response("gateway", { status: 502 });
      }
      assert.equal(address.searchParams.get("algorithm"), "sha512");
      const value = address.pathname.split("/").at(-1);
      assert.ok(rows(220).includes(value));
      reads++;
      peak = Math.max(peak, ++active);
      await delay(1);
      active--;
      return json(recoveredVersion(value));
    },
  });
  const [result, overlapping] = await Promise.all([
    provider.identifyInstalled(rows(220)),
    provider.identifyInstalled(rows(120)),
  ]);
  assert.equal(Object.keys(result.matches).length, 220);
  assert.equal(Object.keys(overlapping.matches).length, 120);
  assert.deepEqual(result.warnings, []);
  assert.equal(reads, 220);
  assert.ok(
    posts >= 1 && posts <= 2,
    `expected the failed POST circuit to stop queued batches, got ${posts}`,
  );
  assert.ok(peak <= 6, `shared GET recovery exceeded six readers: ${peak}`);
  await provider.identifyInstalled(rows(220).reverse());
  assert.equal(reads, 220, "verified recovered identities stay cached");
});

test("GET identity recovery isolates missing files, bad hashes and unsafe IDs while retaining verified successes", async (t) => {
  let now = Date.now(),
    recovered = false;
  t.mock.method(Date, "now", () => now);
  const calls = new Map();
  const lookup = createInstalledIdentification(
    async () => {
      throw fallbackError();
    },
    {
      loadOne: async (value) => {
        calls.set(value, (calls.get(value) ?? 0) + 1);
        if (value === hash(2))
          throw Object.assign(new Error("not found"), { status: 404 });
        if (!recovered && value === hash(3)) return recoveredVersion(hash(999));
        if (!recovered && value === hash(4)) throw new Error("GET unavailable");
        if (!recovered && value === hash(5))
          return { ...recoveredVersion(value), project_id: "../unsafe" };
        return recoveredVersion(value);
      },
    },
  );
  const requested = [1, 2, 3, 4, 5].map(hash);
  const first = await lookup(requested);
  assert.deepEqual(Object.keys(first.matches), [hash(1)]);
  assert.equal(first.warnings.length, 2);
  assert.ok(first.warnings.some((warning) => /unverified/.test(warning)));
  assert.ok(first.warnings.some((warning) => /GET unavailable/.test(warning)));
  now += 20_000;
  await lookup(requested);
  assert.ok([...calls.values()].every((count) => count === 1));
  recovered = true;
  now += 10_001;
  const retried = await lookup(requested);
  assert.equal(Object.keys(retried.matches).length, 4);
  assert.deepEqual(retried.warnings, []);
  assert.equal(calls.get(hash(1)), 1);
  assert.equal(calls.get(hash(2)), 1, "verified 404 remains negatively cached");
  assert.equal(
    calls.get(hash(3)),
    2,
    "an invalid hash is retried as a failure",
  );
  now += 30_000;
  await lookup(requested);
  assert.equal(
    calls.get(hash(2)),
    2,
    "verified missing identities expire after one minute",
  );
});

test("an unverified GET response is retried after the failure cache instead of entering the transport success cache", async (t) => {
  let now = Date.now(),
    reads = 0,
    posts = 0;
  t.mock.method(Date, "now", () => now);
  const [provider] = createCoreProviders({
    fetch: async (_url, options) => {
      if (options.method === "POST") {
        posts++;
        return new Response("gateway", { status: 502 });
      }
      return json(recoveredVersion(++reads === 1 ? hash(999) : hash(1)));
    },
  });
  const failed = await provider.identifyInstalled([hash(1)]);
  assert.deepEqual(failed.matches, {});
  assert.match(failed.warnings[0], /unverified/);
  now += 30_001;
  const retried = await provider.identifyInstalled([hash(1)]);
  assert.equal(Object.keys(retried.matches).length, 1);
  assert.deepEqual(retried.warnings, []);
  assert.equal(reads, 2);
  assert.equal(posts, 1, "bulk recovery still observes the shared circuit");
});

test("a Modrinth rate limit never starts identification GET recovery", async () => {
  let posts = 0,
    reads = 0;
  const [provider] = createCoreProviders({
    fetch: async (_url, options) => {
      if (options.method === "POST") posts++;
      else reads++;
      return new Response("limited", { status: 429 });
    },
  });
  const result = await provider.identifyInstalled(rows(220));
  assert.deepEqual(result.matches, {});
  assert.ok(result.warnings.every((warning) => /request limit/.test(warning)));
  assert.ok(posts <= 2);
  assert.equal(reads, 0);
});

test("cancelling one GET recovery reader leaves overlapping callers and cached results intact", async () => {
  let entered,
    release,
    calls = 0;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const lookup = createInstalledIdentification(
    async () => {
      throw fallbackError();
    },
    {
      loadOne: async (value, signal) => {
        calls++;
        entered();
        await held;
        assert.equal(signal.aborted, false);
        return recoveredVersion(value);
      },
    },
  );
  const caller = new AbortController();
  const first = lookup([hash(1)], { signal: caller.signal });
  const rejected = assert.rejects(first, /view closed/);
  await ready;
  const second = lookup([hash(1)]);
  caller.abort(new Error("view closed"));
  await rejected;
  release();
  assert.equal(Object.keys((await second).matches).length, 1);
  await lookup([hash(1)]);
  assert.equal(calls, 1);
});

test("GET recovery has a shared ninety-second lifetime including queued batches even when reads ignore cancellation", async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const deadlines = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    if (ms !== 90_000) return timeout(ms);
    const deadline = new AbortController();
    deadlines.push(deadline);
    return deadline.signal;
  });
  let reads = 0,
    batches = 0,
    entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const lookup = createInstalledIdentification(
    async () => {
      batches++;
      throw fallbackError();
    },
    {
      loadOne: async () => {
        if (++reads === 200) entered();
        return new Promise(() => {});
      },
    },
  );
  const result = lookup(rows(220));
  await ready;
  assert.equal(
    deadlines.length,
    3,
    "the queued batch deadline starts when scheduled",
  );
  for (const deadline of deadlines)
    deadline.abort(new DOMException("expired", "TimeoutError"));
  const expired = await result;
  assert.deepEqual(expired.matches, {});
  assert.equal(expired.warnings.length, 1);
  assert.match(expired.warnings[0], /took too long/);
  assert.equal(batches, 2, "expired queued batches do not start another POST");
  assert.equal(
    reads,
    200,
    "expired queued batches do not start more GET requests",
  );
});
