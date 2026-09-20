import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createConnectionStore } from "./connection-store.mjs";

const first = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  origin: "https://panel.example:3002",
  trustedFingerprint: Array(32).fill("AB").join(":"),
};
const second = {
  id: "123e4567-e89b-42d3-a456-426614174001",
  origin: "https://other.example",
};
const snapshot = (activeId = first.id) => ({
  activeId,
  panels: [{ ...first }, { ...second }],
});
const blank = { activeId: "local", panels: [] };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-connection-store-"));
  const dataDir = path.join(root, "data");
  const target = path.join(dataDir, "desktop-connections.json");
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-connection-store-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, dataDir, target, store: createConnectionStore({ dataDir }) };
}

test("connection identities, exact leaf trust, and active panel survive a store restart", async (t) => {
  const { dataDir, target, store } = await fixture(t);
  assert.deepEqual(await store.read(), blank);
  await assert.rejects(fs.stat(dataDir), { code: "ENOENT" });
  assert.deepEqual(await store.save(snapshot()), snapshot());
  await store.close();
  const reopened = createConnectionStore({ dataDir });
  assert.deepEqual(await reopened.read(), snapshot());
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), snapshot());
  if (process.platform !== "win32")
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  const read = await reopened.read();
  read.panels[0].origin = "https://changed.example";
  assert.deepEqual(await reopened.read(), snapshot());
  await reopened.close();
});

test("saving accepts only canonical origins, generated IDs, fingerprints, and registry fields", async (t) => {
  const { store, target } = await fixture(t);
  await store.save(snapshot());
  const original = await fs.readFile(target, "utf8");
  const urls = [
    "http://panel.example",
    "file:///private",
    "javascript:alert(1)",
    "https://panel.example/",
    "https://PANEL.example",
    "https://panel.example:443",
    "https://panel.example/private",
    "https://panel.example?token=secret",
    `https://panel.example/#invite=${"A".repeat(43)}`,
    "https://owner:secret@panel.example",
    "https://panel.example\\private",
    " https://panel.example",
    "https://panel.example#console",
  ];
  for (const origin of urls)
    await assert.rejects(
      store.save({ activeId: "local", panels: [{ ...first, origin }] }),
      { status: 400 },
      origin,
    );
  const records = [
    null,
    [],
    {},
    { ...first, id: "../../owner" },
    { ...first, id: first.id.toUpperCase() },
    { ...first, id: first.id.replace("42d3", "12d3") },
    { ...first, trustedFingerprint: "AB:CD" },
    { ...first, trustedFingerprint: first.trustedFingerprint.toLowerCase() },
    { ...first, password: "secret" },
    { ...first, cookies: [] },
    { ...first, invitation: "private" },
    { ...first, servers: [] },
    { ...first, token: "private" },
  ];
  for (const record of records)
    await assert.rejects(store.save({ activeId: "local", panels: [record] }), {
      status: 400,
    });
  for (const value of [
    null,
    {},
    [],
    { panels: [] },
    { ...snapshot(), activeId: "invalid" },
    { ...snapshot(), cookies: [] },
    { activeId: "local", panels: Array(51).fill(first) },
  ])
    await assert.rejects(store.save(value), { status: 400 });
  assert.equal(await fs.readFile(target, "utf8"), original);
  await store.close();
});

test("reads recover distinct safe entries and leave damaged or oversized files untouched", async (t) => {
  const { store, dataDir, target } = await fixture(t);
  await fs.mkdir(dataDir);
  const input = JSON.stringify({
    activeId: randomUUID(),
    panels: [
      first,
      { ...first, origin: "https://duplicate-id.example" },
      { ...second, origin: first.origin },
      null,
      { ...second, origin: "https://x.example/#invite=bad" },
      { ...second, password: "private" },
      second,
    ],
  });
  await fs.writeFile(target, input);
  assert.deepEqual(await store.read(), {
    activeId: "local",
    panels: [first, second],
  });
  assert.equal(await fs.readFile(target, "utf8"), input);
  for (const damaged of [
    "{broken",
    "null",
    '{"panels":"bad"}',
    " ".repeat(128 * 1024 + 1),
  ]) {
    await fs.writeFile(target, damaged);
    assert.deepEqual(await store.read(), blank);
    assert.equal(await fs.readFile(target, "utf8"), damaged);
  }
  await store.close();
});

test("save deduplicates identities and origins and falls back to this computer for missing active IDs", async (t) => {
  const { store } = await fixture(t);
  const saved = await store.save({
    activeId: randomUUID(),
    panels: [
      first,
      { ...first, origin: second.origin },
      { ...second, origin: first.origin },
      second,
    ],
  });
  assert.deepEqual(saved, { activeId: "local", panels: [first, second] });
  assert.deepEqual(await store.read(), saved);
  await store.close();
});

test("automatic saves of a recovered view preserve original bytes until a genuine connection change", async (t) => {
  const { dataDir, target } = await fixture(t);
  await fs.mkdir(dataDir);
  for (const original of [
    "{unfinished",
    JSON.stringify({
      activeId: first.id,
      panels: [first, { id: "obsolete", origin: "http://old.example" }],
    }),
    " ".repeat(128 * 1024 + 1),
  ]) {
    await fs.writeFile(target, original);
    const automatic = createConnectionStore({ dataDir });
    const recovered = await automatic.read();
    await automatic.save(recovered);
    await automatic.close();
    assert.equal(await fs.readFile(target, "utf8"), original);

    const changed = createConnectionStore({ dataDir });
    assert.deepEqual(await changed.read(), recovered);
    await changed.save(snapshot(second.id));
    await changed.close();
    assert.deepEqual(
      JSON.parse(await fs.readFile(target, "utf8")),
      snapshot(second.id),
    );
  }
});

test("concurrent writes capture their input and reads/close drain the last atomic save", async (t) => {
  const { store } = await fixture(t);
  const rename = fs.rename;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let firstRename;
  const started = new Promise((resolve) => {
    firstRename = resolve;
  });
  const seen = [];
  t.mock.method(fs, "rename", async (source, destination) => {
    seen.push(JSON.parse(await fs.readFile(source, "utf8")));
    if (seen.length === 1) {
      firstRename();
      await gate;
    }
    return rename(source, destination);
  });
  const input = snapshot();
  const initial = store.save(input);
  input.panels[0].origin = "https://mutated-after-save.example";
  const latest = store.save(snapshot(second.id));
  await started;
  let readFinished = false;
  const reading = store.read().then((value) => {
    readFinished = true;
    return value;
  });
  const closing = store.close();
  await assert.rejects(store.save(snapshot()), { status: 503 });
  assert.equal(readFinished, false);
  assert.deepEqual(seen, [snapshot()]);
  release();
  await Promise.all([initial, latest, closing]);
  assert.deepEqual(await reading, snapshot(second.id));
  assert.deepEqual(seen, [snapshot(), snapshot(second.id)]);
});

test("failed atomic replacement preserves the previous file and later saves recover", async (t) => {
  const { store, dataDir, target } = await fixture(t);
  await store.save(snapshot());
  const original = await fs.readFile(target, "utf8");
  const rename = fs.rename;
  let fail = true;
  t.mock.method(fs, "rename", (...args) => {
    if (fail)
      return Promise.reject(
        Object.assign(new Error("Fixture write failure"), { code: "EIO" }),
      );
    return rename(...args);
  });
  await assert.rejects(store.save(snapshot(second.id)), { code: "EIO" });
  assert.equal(await fs.readFile(target, "utf8"), original);
  assert.deepEqual(await fs.readdir(dataDir), ["desktop-connections.json"]);
  assert.deepEqual(await store.read(), snapshot());
  fail = false;
  await store.save(snapshot(second.id));
  await store.close();
  assert.deepEqual(
    JSON.parse(await fs.readFile(target, "utf8")),
    snapshot(second.id),
  );
});

test("directory junctions cannot redirect the registry root, ancestors, or file path", async (t) => {
  const { root, dataDir, target, store } = await fixture(t);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  const sentinel = path.join(outside, "desktop-connections.json");
  await fs.writeFile(sentinel, JSON.stringify(snapshot()));
  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(outside, dataDir, symlinkType);
  await assert.rejects(store.read(), { code: "PANEL_CONNECTION_PATH_INVALID" });
  await assert.rejects(store.save(snapshot(second.id)), {
    code: "PANEL_CONNECTION_PATH_INVALID",
  });
  const nested = createConnectionStore({
    dataDir: path.join(dataDir, "child"),
  });
  await assert.rejects(nested.save(snapshot()), {
    code: "PANEL_CONNECTION_PATH_INVALID",
  });
  await assert.rejects(fs.stat(path.join(outside, "child")), {
    code: "ENOENT",
  });
  await fs.unlink(dataDir);
  await fs.mkdir(dataDir);
  await fs.symlink(outside, target, symlinkType);
  await assert.rejects(store.read(), { code: "PANEL_CONNECTION_PATH_INVALID" });
  await assert.rejects(store.save(snapshot(second.id)), {
    code: "PANEL_CONNECTION_PATH_INVALID",
  });
  assert.deepEqual(await fs.readdir(outside), ["desktop-connections.json"]);
  assert.deepEqual(JSON.parse(await fs.readFile(sentinel, "utf8")), snapshot());
});

test("a symbolic registry file cannot be read or overwritten", async (t) => {
  const { root, dataDir, target, store } = await fixture(t);
  await fs.mkdir(dataDir);
  const outside = path.join(root, "private.json");
  await fs.writeFile(outside, JSON.stringify(snapshot()));
  try {
    await fs.symlink(outside, target, "file");
  } catch (cause) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES"].includes(cause.code)
    ) {
      t.skip("Windows file symlinks require developer mode or privilege.");
      return;
    }
    throw cause;
  }
  await assert.rejects(store.read(), { code: "PANEL_CONNECTION_PATH_INVALID" });
  await assert.rejects(store.save(snapshot(second.id)), {
    code: "PANEL_CONNECTION_PATH_INVALID",
  });
  assert.deepEqual(JSON.parse(await fs.readFile(outside, "utf8")), snapshot());
});

test("the store rejects missing and relative data directories", () => {
  for (const dataDir of [undefined, "relative", "", "\0"])
    assert.throws(
      () => createConnectionStore({ dataDir }),
      /absolute data directory/,
    );
});
