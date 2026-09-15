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

test("an eight-second batch budget covers both update and current-version requests and failures cool down", async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const budgets = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    budgets.push(milliseconds);
    return timeout(milliseconds === 8000 ? 20 : milliseconds);
  });
  let calls = 0;
  const signals = [];
  const row = item(0);
  const p = provider(async (url, options) => {
    calls++;
    signals.push(options.signal);
    if (url.endsWith("/update")) return json({ [row.sha512]: raw(row) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout was not forwarded")),
        1000,
      );
      options.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(options.signal.reason);
        },
        { once: true },
      );
    });
  });
  const result = await p.updates(input, [row]);
  assert.deepEqual(budgets, [8000, 60000, 60000]);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(signals[0].reason, signals[1].reason);
  assert.deepEqual(result.updates, {});
  assert.match(result.warnings[0], /took too long/);
  await p.updates(input, [row]);
  assert.equal(calls, 2);
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
      assert.equal(milliseconds, 8000);
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
    const p = provider(async () => {
      calls++;
      if (calls === 2) entered();
      if (!failing) return json({});
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
    for (const deadline of deadlines)
      deadline.abort(
        new DOMException("Batch deadline reached", "TimeoutError"),
      );
    const results = await Promise.all([first, queued]);
    assert.equal(calls, 2);
    assert.ok(
      results.every((result) => Object.keys(result.updates).length === 0),
    );
    assert.ok(
      results.every((result) =>
        /took too long/.test(result.warnings.join(" ")),
      ),
    );
    failing = false;
    now += 30_001;
    const retry = await p.updates(input, [item(201)]);
    assert.deepEqual(retry.updates, {});
    assert.deepEqual(retry.warnings, []);
    assert.match(
      retry.issues[item(201).sha512],
      /did not return an update result/,
    );
    assert.equal(calls, 3);
    for (const reject of lateFailures)
      reject(new Error("Late uncooperative network failure"));
    await delay(0);
    assert.ok(
      results.every((result) => Object.keys(result.updates).length === 0),
    );
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
