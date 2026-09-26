import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createCoreProviders } from "./launchpad-providers.mjs";

const input = { type: "mod", loader: "neoforge", gameVersion: "1.21.1" };
const hash = (value) =>
  createHash("sha512").update(String(value)).digest("hex");
const item = (number) => ({
  sha512: hash(number),
  projectId: `project${number}`,
  versionId: `old${number}`,
});
const raw = (installed, overrides = {}) => ({
  id: `new${installed.versionId}`,
  project_id: installed.projectId,
  name: "Updated mod",
  version_number: "2.0",
  game_versions: ["1.21.1"],
  loaders: ["neoforge"],
  date_published: "2026-08-01T00:00:00Z",
  environment: "server_only",
  files: [
    {
      filename: "mod.jar",
      primary: true,
      url: "https://cdn.modrinth.com/data/project/mod.jar",
      hashes: { sha512: hash(`new${installed.sha512}`) },
      size: 20,
    },
  ],
  ...overrides,
});
const current = (installed, overrides = {}) =>
  raw(installed, {
    id: installed.versionId,
    date_published: "2026-07-01T00:00:00Z",
    files: [
      { ...raw(installed).files[0], hashes: { sha512: installed.sha512 } },
    ],
    ...overrides,
  });
const json = (value) => new Response(JSON.stringify(value));
const provider = (fetch) => createCoreProviders({ fetch })[0];

test("Modrinth environment definitions agree across catalogs, current checks, updates and resolution", async () => {
  // Modrinth explicitly permits server installation for client_only_server_optional.
  // https://modrinth.com/news/article/new-environments/#new-system
  for (const environment of [
    "client_and_server",
    "client_only_server_optional",
    "server_only",
    "server_only_client_optional",
    "dedicated_server_only",
    "client_or_server",
    "client_or_server_prefers_both",
    "client_only",
    "singleplayer_only",
    "unknown",
    undefined,
  ]) {
    const row = item(0);
    const allowed = !["client_only", "singleplayer_only"].includes(environment);
    let candidate = raw(row, { environment });
    const p = provider(async (url) => {
      if (url.endsWith("/version_files/update"))
        return json({ [row.sha512]: candidate });
      if (new URL(url).pathname === "/v2/versions")
        return json([current(row, { environment })]);
      if (new URL(url).pathname === `/v2/project/${row.projectId}/version`)
        return json([candidate]);
      if (url.endsWith(`/project/${row.projectId}`))
        return json({
          id: row.projectId,
          title: "Fixture mod",
          project_type: "mod",
          server_side: "optional",
        });
      if (url.endsWith(`/version/${candidate.id}`)) return json(candidate);
      assert.fail(`Unexpected metadata request: ${url}`);
    });
    const versions = await p.versions({ ...input, projectId: row.projectId });
    assert.equal(versions[0].downloadable, allowed, environment);
    const result = await p.updates(input, [row]);
    assert.deepEqual(result.warnings, [], environment);
    if (allowed) {
      assert.equal(result.updates[row.sha512].id, candidate.id, environment);
      assert.deepEqual(result.issues, {}, environment);
      const resolved = await p.resolve({
        ...input,
        projectId: row.projectId,
        versionId: candidate.id,
      });
      assert.equal(resolved.files[0].path, "mod.jar", environment);
    } else {
      assert.equal(
        Object.hasOwn(result.updates, row.sha512),
        false,
        environment,
      );
      assert.match(
        result.issues[row.sha512],
        environment === "client_only" ? /client-only/ : /singleplayer-only/,
      );
      await assert.rejects(
        p.resolve({
          ...input,
          projectId: row.projectId,
          versionId: candidate.id,
        }),
        /intended for clients/,
      );
    }
    candidate = current(row, { environment });
    const checked = await p.updates(input, [row]);
    if (allowed) {
      assert.deepEqual(checked.updates, { [row.sha512]: null }, environment);
      assert.deepEqual(checked.issues, {}, environment);
    } else {
      assert.deepEqual(checked.updates, {}, environment);
      assert.ok(checked.issues[row.sha512], environment);
    }
  }
});

test("optional-server versions do not bypass an explicit unsupported-server project declaration", async () => {
  const row = item(0),
    candidate = raw(row, { environment: "client_only_server_optional" });
  const p = provider(async (url) =>
    json(
      url.includes("/project/")
        ? {
            id: row.projectId,
            title: "Fixture mod",
            project_type: "mod",
            server_side: "unsupported",
          }
        : candidate,
    ),
  );
  await assert.rejects(
    p.resolve({ ...input, projectId: row.projectId, versionId: candidate.id }),
    /intended for clients/,
  );
});

test("Modrinth checks hundreds of files in batches of 100 with at most two requests across overlapping callers", async () => {
  const items = Array.from({ length: 302 }, (_, index) => item(index));
  const byHash = new Map(items.map((row) => [row.sha512, row]));
  const byId = new Map(items.map((row) => [row.versionId, row]));
  let active = 0,
    maximum = 0;
  const requests = [];
  const p = provider(async (url, options) => {
    requests.push({ url, options });
    maximum = Math.max(maximum, ++active);
    await delay(2);
    active--;
    if (url.endsWith("/version_files/update")) {
      const body = JSON.parse(options.body);
      assert.equal(options.method, "POST");
      assert.equal(body.algorithm, "sha512");
      assert.deepEqual(body.loaders, ["neoforge"]);
      assert.deepEqual(body.game_versions, ["1.21.1"]);
      assert.ok(body.hashes.length <= 100);
      return json(
        Object.fromEntries(
          body.hashes.map((key) => [key, raw(byHash.get(key))]),
        ),
      );
    }
    const ids = JSON.parse(new URL(url).searchParams.get("ids"));
    assert.ok(url.startsWith("https://api.modrinth.com/v2/versions?"));
    assert.ok(ids.length <= 100);
    return json(ids.map((key) => current(byId.get(key))));
  });
  const results = await Promise.all([
    p.updates(input, items.slice(0, 201)),
    p.updates(input, items.slice(201)),
  ]);
  assert.equal(maximum, 2);
  assert.equal(requests.length, 10);
  const updates = Object.assign({}, ...results.map((result) => result.updates));
  assert.equal(Object.keys(updates).length, 302);
  for (const row of items)
    assert.equal(updates[row.sha512].id, `new${row.versionId}`);
  assert.deepEqual(
    results.flatMap((result) => result.warnings),
    [],
  );
  assert.ok(results.every((result) => Object.keys(result.issues).length === 0));
});

test("batch updates reject current, older, incompatible, wrong-project and unsafe-download candidates", async () => {
  const rows = Array.from({ length: 14 }, (_, index) => item(index));
  const newer = rows[0];
  const candidates = [
    raw(newer),
    current(rows[1]),
    raw(rows[2], { date_published: "2026-06-01T00:00:00Z" }),
    raw(rows[3], { date_published: "2026-07-01T00:00:00Z" }),
    raw(rows[4], { loaders: ["fabric"] }),
    raw(rows[5], { game_versions: ["1.20.1"] }),
    raw(rows[6], { project_id: "unrelated" }),
    raw(rows[7], { environment: "client_only" }),
    raw(rows[8], {
      files: [{ ...raw(rows[8]).files[0], hashes: { sha512: rows[8].sha512 } }],
    }),
    raw(rows[9], {
      files: [
        { ...raw(rows[9]).files[0], url: "https://outside.example/mod.jar" },
      ],
    }),
    raw(rows[10], { files: [] }),
    null,
    raw(rows[12], { loaders: "not-neoforge" }),
    raw(rows[13], {
      files: [{ ...raw(rows[13]).files[0], size: 3 * 1024 ** 3 }],
    }),
  ];
  const p = provider(async (url) =>
    url.endsWith("/update")
      ? json(
          Object.fromEntries(
            rows.map((row, index) => [row.sha512, candidates[index]]),
          ),
        )
      : json(rows.map((row) => current(row))),
  );
  const result = await p.updates(input, rows);
  assert.equal(result.updates[newer.sha512].id, `new${newer.versionId}`);
  for (const index of [1, 2, 3, 8])
    assert.equal(result.updates[rows[index].sha512], null);
  for (const index of [4, 5, 6, 7, 9, 10, 11, 12, 13])
    assert.equal(Object.hasOwn(result.updates, rows[index].sha512), false);
  assert.deepEqual(result.warnings, []);
  assert.match(result.issues[rows[4].sha512], /selected neoforge loader/);
  assert.match(result.issues[rows[5].sha512], /Minecraft 1\.21\.1/);
  assert.match(result.issues[rows[6].sha512], /different project/);
  assert.match(result.issues[rows[7].sha512], /client-only/);
  assert.match(result.issues[rows[9].sha512], /outside the provider/);
  assert.match(result.issues[rows[10].sha512], /no downloadable file/);
  assert.match(
    result.issues[rows[11].sha512],
    /did not return an update result/,
  );
  assert.match(result.issues[rows[12].sha512], /invalid update compatibility/);
  assert.match(result.issues[rows[13].sha512], /file size/);
  assert.equal(Object.keys(result.issues).length, 9);
});

test("unverified current identity or publication dates remain unknown instead of becoming update or no-update cache entries", async () => {
  const rows = Array.from({ length: 4 }, (_, index) => item(index));
  const p = provider(async (url) =>
    url.endsWith("/update")
      ? json(Object.fromEntries(rows.map((row) => [row.sha512, raw(row)])))
      : json([
          current(rows[0], { project_id: "unrelated" }),
          current(rows[1], { files: [{ hashes: { sha512: hash("wrong") } }] }),
          current(rows[2], { date_published: "invalid date" }),
        ]),
  );
  const result = await p.updates(input, rows);
  assert.deepEqual(result.updates, {});
  assert.deepEqual(result.warnings, []);
  assert.equal(Object.keys(result.issues).length, 4);
  assert.match(result.issues[rows[0].sha512], /different project/);
  assert.match(result.issues[rows[1].sha512], /checksum does not match/);
  assert.match(result.issues[rows[2].sha512], /publication date/);
  assert.match(result.issues[rows[3].sha512], /did not return metadata/);
});

test("confirmed current hashes become null while omitted hashes remain unknown, and duplicate hashes are coalesced", async () => {
  const row = item(0),
    unknown = item(1);
  let calls = 0;
  const p = provider(async (url, options) => {
    calls++;
    assert.ok(url.endsWith("/version_files/update"));
    assert.deepEqual(JSON.parse(options.body).hashes, [
      row.sha512,
      unknown.sha512,
    ]);
    return json({ [row.sha512]: current(row) });
  });
  const result = await p.updates(input, [row, row, unknown]);
  assert.deepEqual(result.updates, { [row.sha512]: null });
  assert.deepEqual(result.warnings, []);
  assert.match(
    result.issues[unknown.sha512],
    /did not return an update result/,
  );
  assert.equal(Object.keys(result.issues).length, 1);
  assert.equal(calls, 1);
  await assert.rejects(
    p.updates(input, [row, { ...row, versionId: "conflicting" }]),
    /conflicting version identities/,
  );
  await assert.rejects(
    p.updates(input, [{ ...row, sha512: "invalid" }]),
    /valid SHA512/,
  );
  assert.equal(calls, 1);
});

test("rate limits stop queued batches and cool down subsequent callers without caching failed hashes as current", async (t) => {
  let now = Date.now(),
    calls = 0;
  t.mock.method(Date, "now", () => now);
  const p = provider(async () => {
    calls++;
    return new Response("limited", { status: 429 });
  });
  const rows = Array.from({ length: 1100 }, (_, index) => item(index));
  const result = await p.updates(input, rows);
  assert.ok(calls <= 2);
  assert.deepEqual(result.updates, {});
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /request limit/);
  const before = calls;
  await p.updates(input, rows);
  assert.equal(calls, before);
  now += 60_001;
  await p.updates(input, [rows[0]]);
  assert.equal(calls, before + 1);
});

test("missing or invalid later responses cannot overwrite a previously discovered update with a false no-update result", async () => {
  const row = item(0);
  let response = raw(row),
    currentFails = false;
  const p = provider(async (url) => {
    if (url.endsWith("/update"))
      return json(response ? { [row.sha512]: response } : {});
    return currentFails
      ? new Response("", { status: 404 })
      : json([current(row)]);
  });
  const cached = { ...(await p.updates(input, [row])).updates };
  assert.equal(cached[row.sha512].id, `new${row.versionId}`);
  for (const value of [
    null,
    raw(row, { loaders: ["fabric"] }),
    raw(row, { environment: "client_only" }),
    raw(row, { files: [] }),
    current(row, { files: raw(row).files }),
  ]) {
    response = value;
    const next = await p.updates(input, [row]);
    assert.deepEqual(next.updates, {});
    assert.deepEqual(next.warnings, []);
    assert.ok(next.issues[row.sha512]);
    Object.assign(cached, next.updates);
    assert.equal(cached[row.sha512].id, `new${row.versionId}`);
  }
  response = raw(row);
  currentFails = true;
  const missingCurrent = await p.updates(input, [row]);
  assert.deepEqual(missingCurrent.updates, {});
  assert.match(missingCurrent.warnings.join(" "), /404/);
});

test("bulk update and current-version verification have independent request deadlines", async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const budgets = [];
  const deadlines = new Map();
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    budgets.push(milliseconds);
    if (![4000, 8000].includes(milliseconds)) return timeout(milliseconds);
    const controller = new AbortController();
    deadlines.set(milliseconds, controller);
    return controller.signal;
  });
  let calls = 0;
  const signals = [];
  const row = item(0);
  const p = provider(async (url, options) => {
    calls++;
    signals.push(options.signal);
    if (url.endsWith("/update")) return json({ [row.sha512]: raw(row) });
    deadlines
      .get(4000)
      .abort(new DOMException("Earlier bulk deadline", "TimeoutError"));
    options.signal.throwIfAborted();
    return json([current(row)]);
  });
  const result = await p.updates(input, [row]);
  assert.ok(budgets.includes(4000));
  assert.ok(budgets.includes(8000));
  assert.notEqual(signals[0], signals[1]);
  assert.equal(result.updates[row.sha512].id, raw(row).id);
  assert.deepEqual(result.warnings, []);
  assert.equal(calls, 2);
});

test("220 installed mods recover from failed hash POSTs using bounded cached GET project histories", async (t) => {
  let now = Date.now(),
    posts = 0,
    reads = 0,
    active = 0,
    peak = 0;
  t.mock.method(Date, "now", () => now);
  const rows = Array.from({ length: 220 }, (_, index) => item(index));
  const p = provider(async (url, options) => {
    if (options.method === "POST") {
      posts++;
      return new Response("gateway unavailable", { status: 502 });
    }
    const parsed = new URL(url);
    const project = parsed.pathname.match(
      /^\/v2\/project\/project(\d+)\/version$/,
    );
    assert.ok(project, `Expected only metadata GET: ${url}`);
    assert.equal(parsed.searchParams.get("include_changelog"), "false");
    assert.deepEqual(JSON.parse(parsed.searchParams.get("loaders")), [
      "neoforge",
    ]);
    assert.deepEqual(JSON.parse(parsed.searchParams.get("game_versions")), [
      "1.21.1",
    ]);
    reads++;
    peak = Math.max(peak, ++active);
    await delay(1);
    active--;
    const row = rows[Number(project[1])];
    return json([current(row), raw(row)]);
  });
  const result = await p.updates(input, rows);
  assert.equal(Object.keys(result.updates).length, 220);
  assert.ok(rows.every((row) => result.updates[row.sha512].id === raw(row).id));
  assert.deepEqual(result.issues, {});
  assert.deepEqual(result.warnings, []);
  assert.ok(
    posts <= 2,
    "queued batches stop retrying the failing POST endpoint",
  );
  assert.equal(reads, 220);
  assert.ok(peak <= 6);
  await p.updates({ ...input, refresh: true }, rows);
  assert.equal(reads, 220, "repeated Refresh reuses recent project histories");
  now += 30001;
  await p.updates(input, [rows[0]]);
  assert.equal(
    reads,
    221,
    "mutable project history is checked again after its short expiry",
  );
});

test("GET recovery verifies an installed release outside the filtered history and rejects forged metadata", async () => {
  const row = item(0);
  for (const scenario of [
    "valid",
    "wrong-current-project",
    "wrong-current-hash",
    "wrong-project",
    "wrong-loader",
    "client-only",
    "unsafe-download",
    "invalid-date",
    "older",
  ]) {
    let candidate = raw(row),
      installed = current(row),
      currentReads = 0;
    if (scenario === "wrong-current-project") installed.project_id = "other";
    if (scenario === "wrong-current-hash") installed.files = raw(row).files;
    if (scenario === "wrong-project") candidate.project_id = "other";
    if (scenario === "wrong-loader") candidate.loaders = ["fabric"];
    if (scenario === "client-only") candidate.environment = "client_only";
    if (scenario === "unsafe-download")
      candidate.files[0].url = "https://untrusted.example/mod.jar";
    if (scenario === "invalid-date") candidate.date_published = "invalid";
    if (scenario === "older") candidate.date_published = "2026-01-01T00:00:00Z";
    const p = provider(async (url, options) => {
      if (options.method === "POST")
        return new Response("gateway", { status: 503 });
      if (url.includes("/project/")) return json([candidate]);
      assert.equal(new URL(url).pathname, "/v2/version/old0");
      currentReads++;
      return json(installed);
    });
    const result = await p.updates(input, [row]);
    if (scenario === "valid") {
      assert.equal(result.updates[row.sha512].id, candidate.id);
      assert.equal(currentReads, 1);
      assert.deepEqual(result.warnings, []);
    } else if (scenario === "older") {
      assert.equal(result.updates[row.sha512], null);
      assert.deepEqual(result.issues, {});
    } else {
      assert.deepEqual(result.updates, {}, scenario);
      assert.ok(result.issues[row.sha512], scenario);
    }
  }
});

test("successful primary update batches survive a neighboring fallback failure", async () => {
  const rows = Array.from({ length: 201 }, (_, index) => item(index));
  const byHash = new Map(rows.map((row) => [row.sha512, row]));
  const p = provider(async (url, options) => {
    if (options.method === "POST") {
      const hashes = JSON.parse(options.body).hashes;
      if (hashes.includes(rows[0].sha512))
        return json(
          Object.fromEntries(
            hashes.map((value) => [value, current(byHash.get(value))]),
          ),
        );
      return new Response("gateway", { status: 502 });
    }
    const index = Number(new URL(url).pathname.match(/project(\d+)/)[1]);
    if (index === 100) return new Response("not found", { status: 404 });
    return json([current(rows[index]), raw(rows[index])]);
  });
  const result = await p.updates(input, rows);
  for (const row of rows.slice(0, 100))
    assert.equal(result.updates[row.sha512], null);
  assert.equal(Object.keys(result.updates).length, 200);
  assert.equal(Object.hasOwn(result.updates, rows[100].sha512), false);
  assert.match(result.issues[rows[100].sha512], /404/);
  assert.equal(result.updates[rows[200].sha512].id, raw(rows[200]).id);
});

test("failed GET checks briefly cache only affected file scopes without extending the retry deadline", async (t) => {
  let now = Date.now(),
    requests = 0,
    failing = true;
  t.mock.method(Date, "now", () => now);
  const p = provider(async (url, options) => {
    requests++;
    if (options.method === "POST")
      return new Response("gateway", { status: 502 });
    const index = Number(new URL(url).pathname.match(/project(\d+)/)[1]);
    if (failing && index === 0)
      return new Response("unavailable", { status: 503 });
    return json([current(item(index))]);
  });
  const first = await p.updates(input, [item(0)]);
  assert.deepEqual(first.updates, {});
  assert.match(first.issues[item(0).sha512], /503/);
  const afterFailure = requests;
  now += 15000;
  const cached = await p.updates({ ...input, refresh: true }, [item(0)]);
  assert.deepEqual(cached.updates, {});
  assert.equal(requests, afterFailure);
  assert.deepEqual((await p.updates(input, [item(1)])).updates, {
    [item(1).sha512]: null,
  });
  failing = false;
  now += 15001;
  const recovered = await p.updates(input, [item(0)]);
  assert.deepEqual(recovered.updates, { [item(0).sha512]: null });
  assert.deepEqual(recovered.warnings, []);
  assert.equal(requests, afterFailure + 2);
});

test("unverified current-version GET metadata is never retained as a trusted cached identity", async () => {
  const row = item(0);
  let mismatched = true,
    currentReads = 0;
  const p = provider(async (url, options) => {
    if (options.method === "POST")
      return new Response("gateway", { status: 502 });
    if (url.includes("/project/")) return json([raw(row)]);
    currentReads++;
    return json(
      mismatched ? current(row, { files: raw(row).files }) : current(row),
    );
  });
  const first = await p.updates(input, [row]);
  assert.deepEqual(first.updates, {});
  assert.match(first.issues[row.sha512], /checksum/);
  mismatched = false;
  const recovered = await p.updates(input, [row]);
  assert.equal(recovered.updates[row.sha512].id, raw(row).id);
  assert.equal(currentReads, 2);
});

test("caller cancellation aborts in-flight batch requests, skips queued batches, and does not impose provider cooldown", async () => {
  const controller = new AbortController();
  let calls = 0;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const p = provider(async (url, options) => {
    calls++;
    if (controller.signal.aborted) return json({});
    if (calls === 2) entered();
    return new Promise((resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      );
    });
  });
  const operation = p.updates(
    { ...input, signal: controller.signal },
    Array.from({ length: 301 }, (_, index) => item(index)),
  );
  await ready;
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(operation, /caller cancelled/);
  const result = await p.updates(input, [item(0)]);
  assert.equal(calls, 3);
  assert.deepEqual(result.updates, {});
  assert.deepEqual(result.warnings, []);
  assert.match(
    result.issues[item(0).sha512],
    /did not return an update result/,
  );
});

for (const stalled of ["request", "response body"])
  test(`a stalled ${stalled} that ignores abort cannot permanently occupy update queue lanes`, async (t) => {
    const deadlines = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", (milliseconds) => {
      if (milliseconds === 60000) return timeout(milliseconds);
      assert.ok([4000, 8000].includes(milliseconds));
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    });
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const lateFailures = [];
    let calls = 0,
      failing = true,
      entered;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const p = provider(async (url) => {
      calls++;
      if (calls === 2) entered();
      if (!failing) {
        const project = new URL(url).pathname.match(
          /\/project\/project(\d+)\/version/,
        );
        return project ? json([current(item(Number(project[1])))]) : json({});
      }
      if (stalled === "request")
        return new Promise((resolve, reject) => lateFailures.push(reject));
      return new Response(
        new ReadableStream({
          start(controller) {
            lateFailures.push((cause) => controller.error(cause));
          },
        }),
      );
    });
    const first = p.updates(
      input,
      Array.from({ length: 101 }, (_, index) => item(index)),
    );
    await ready;
    const queued = p.updates(input, [item(200)]);
    failing = false;
    for (const deadline of deadlines)
      deadline.abort(
        new DOMException("Batch deadline reached", "TimeoutError"),
      );
    const results = await Promise.all([first, queued]);
    assert.equal(
      calls,
      104,
      "both failed batches and the queued project recover using bounded GET reads",
    );
    assert.equal(Object.keys(results[0].updates).length, 101);
    assert.deepEqual(results[1].updates, { [item(200).sha512]: null });
    assert.ok(results.every((result) => result.warnings.length === 0));
    failing = false;
    now += 30_001;
    const retry = await p.updates(input, [item(201)]);
    assert.deepEqual(retry.updates, { [item(201).sha512]: null });
    assert.deepEqual(retry.warnings, []);
    assert.deepEqual(retry.issues, {});
    assert.equal(calls, 105);
    for (const reject of lateFailures)
      reject(new Error("Late uncooperative network failure"));
    await delay(0);
    assert.equal(Object.keys(results[0].updates).length, 101);
  });

test("caller cancellation releases uncooperative update requests so the next caller can use both lanes immediately", async () => {
  const controller = new AbortController();
  let calls = 0,
    entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const p = provider(async () => {
    calls++;
    if (calls === 2) entered();
    if (controller.signal.aborted) return json({});
    return new Promise(() => {});
  });
  const cancelled = p.updates(
    { ...input, signal: controller.signal },
    Array.from({ length: 201 }, (_, index) => item(index)),
  );
  await ready;
  controller.abort(new Error("cancelled by caller"));
  await assert.rejects(cancelled, /cancelled by caller/);
  const retry = await p.updates(
    input,
    Array.from({ length: 101 }, (_, index) => item(index)),
  );
  assert.equal(calls, 4);
  assert.deepEqual(retry.updates, {});
  assert.deepEqual(retry.warnings, []);
  assert.equal(Object.keys(retry.issues).length, 101);
});

test("optional caller cancellation reaches existing Modrinth and CurseForge version and identification helpers", async () => {
  const caller = new AbortController();
  const signal = caller.signal;
  const requests = [];
  const [mr, cf] = createCoreProviders({
    key: async () => "fixture-key",
    fetch: async (url, options) => {
      requests.push({ url, options });
      return json(
        url.includes("curseforge")
          ? { data: [] }
          : url.includes("version_files")
            ? {}
            : [],
      );
    },
  });
  await mr.versions({ ...input, projectId: "fixture", signal });
  await mr.identify([hash(0)], { signal });
  await cf.versions({ ...input, projectId: "123", signal });
  await cf.identifyFingerprints([123], { signal });
  assert.equal(requests.length, 4);
  caller.abort(new Error("caller cancelled catalog"));
  for (const request of requests) {
    assert.equal(request.options.signal.aborted, true);
    assert.equal(request.options.signal.reason, signal.reason);
  }
});

test("Quilt mod compatibility uses Fabric in update requests and catalog validation", async () => {
  const row = item(0);
  const offered = raw(row, { loaders: ["fabric"] });
  const p = provider(async (url, options) => {
    if (url.endsWith("/update")) {
      assert.deepEqual(JSON.parse(options.body).loaders, ["quilt", "fabric"]);
      return json({ [row.sha512]: offered });
    }
    if (url.includes("/project/")) {
      assert.deepEqual(JSON.parse(new URL(url).searchParams.get("loaders")), [
        "quilt",
        "fabric",
      ]);
      return json([offered]);
    }
    return json([current(row, { loaders: ["fabric"] })]);
  });
  const selection = { ...input, loader: "quilt" };
  assert.equal(
    (await p.updates(selection, [row])).updates[row.sha512].id,
    offered.id,
  );
  assert.equal(
    (await p.versions({ ...selection, projectId: row.projectId }))[0].id,
    offered.id,
  );
});

test("a failed fallback gives the affected file a reason without blocking a later project", async () => {
  let failed = true;
  const p = provider(async (url, options) => {
    if (failed) {
      failed = false;
      return new Response("bad", { status: 503 });
    }
    if (url.includes("/project/project0/"))
      return new Response("bad", { status: 503 });
    if (url.includes("/project/project1/")) return json([current(item(1))]);
    assert.fail(`Unexpected fallback request: ${url}`);
  });
  const first = await p.updates(input, [item(0)]);
  assert.match(first.issues[item(0).sha512], /503/);
  const next = await p.updates(input, [item(1)]);
  assert.deepEqual(next.updates, { [item(1).sha512]: null });
});

test("CurseForge file pagination retains older installed releases and requires explicit specialized plugin support", async () => {
  const pages = [];
  const files = Array.from({ length: 55 }, (_, index) => ({
    id: index + 1,
    displayName: `release ${index}`,
    gameVersions: ["1.21.1", ...(index === 54 ? ["Folia"] : [])],
    fileDate: "2026-01-01",
    downloadUrl: "https://edge.forgecdn.net/example.jar",
  }));
  const p = createCoreProviders({
    key: async () => "key",
    fetch: async (url) => {
      const offset = Number(new URL(url).searchParams.get("index"));
      pages.push(offset);
      return json({
        data: files.slice(offset, offset + 50),
        pagination: { totalCount: files.length },
      });
    },
  })[1];
  const rows = await p.versions({
    type: "plugin",
    loader: "folia",
    gameVersion: "1.21.1",
    projectId: "11",
  });
  assert.deepEqual(pages, [0, 50]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["55"],
  );
  assert.equal(
    (
      await p.versions({
        type: "plugin",
        loader: "velocity",
        gameVersion: "1.21.1",
        projectId: "11",
      })
    ).length,
    0,
  );
});

test("CurseForge bounds file pagination across all compatible loaders and never returns partial history", async () => {
  for (const loader of ["neoforge", "quilt"]) {
    const pages = [];
    const p = createCoreProviders({
      key: async () => "key",
      fetch: async (url) => {
        const query = new URL(url).searchParams;
        const offset = Number(query.get("index"));
        const selected = query.get("modLoaderType");
        pages.push({ offset, selected });
        const count = loader === "quilt" && selected === "5" ? 250 : 1000;
        return json({
          data: Array.from({ length: 50 }, (_, index) => ({
            id: offset + index,
          })),
          pagination: { totalCount: count },
        });
      },
    })[1];
    await assert.rejects(
      p.versions({ ...input, loader, projectId: "11" }),
      /too many releases/,
    );
    assert.equal(pages.length, 10);
    if (loader === "quilt") {
      assert.equal(pages.filter((page) => page.selected === "5").length, 5);
      assert.equal(pages.filter((page) => page.selected === "4").length, 5);
    }
  }
});
