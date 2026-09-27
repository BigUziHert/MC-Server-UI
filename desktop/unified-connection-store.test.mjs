import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createUnifiedConnectionStore,
  displayRoster,
} from "./unified-connection-store.mjs";
import { createConnectionStore } from "./connection-store.mjs";

const token = "a".repeat(43);
const fingerprint = Array(32).fill("AB").join(":");
const account = {
  role: "subuser",
  email: "fixture@example.test",
  userId: "fixture",
  accountId: "account",
  serverId: "server",
  permissions: ["server.update"],
  hostPermissions: ["server.create"],
};
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value.split("").reverse().join("")),
  decryptString: (value) => value.toString().split("").reverse().join(""),
};
const panel = (overrides = {}) => ({
  id: randomUUID(),
  origin: "https://fixture.example.test",
  trustedFingerprint: fingerprint,
  token,
  session: account,
  servers: [
    {
      id: "server",
      name: "Saved server",
      status: "running",
      accessPermissions: ["file.update"],
      serverDir: "C:/private",
    },
  ],
  ...overrides,
});
async function fixture(t, encryption = safeStorage) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-unified-store-test-"),
  );
  const store = createUnifiedConnectionStore({
    dataDir: root,
    safeStorage: encryption,
  });
  t.after(async () => {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store, file: path.join(root, "desktop-workspace.json") };
}

test("all 25000 supported roster rows survive save and restore with bounded metadata", async (t) => {
  const h = await fixture(t);
  const panels = Array.from({ length: 50 }, (_, index) =>
    panel({
      origin: `https://panel-${index}.example.test`,
      servers: Array.from({ length: 500 }, (_, server) => ({
        id: `server-${server}`,
        name: "界".repeat(180),
        software: "界".repeat(128),
        minecraftVersion: "界".repeat(128),
        status: "running",
      })),
    }),
  );
  const selectedServer = { panelId: panels.at(-1).id, serverId: "server-499" };
  await h.store.save({ panels, selectedServer });
  assert.ok((await fs.stat(h.file)).size < 128 * 1024 * 1024);
  const saved = await h.store.read();
  assert.equal(saved.panels.length, 50);
  assert.ok(saved.panels.every((entry) => entry.token === token));
  assert.deepEqual(saved.selectedServer, selectedServer);
  assert.equal(
    saved.panels.reduce((count, entry) => count + entry.servers.length, 0),
    25000,
  );
  assert.equal(saved.panels[0].session.permissions, undefined);
  assert.equal(saved.panels[0].session.hostPermissions, undefined);
  assert.equal(saved.warning, undefined);
  const bytes = await fs.readFile(h.file, "utf8");
  assert.ok(!bytes.includes(token));
  assert.ok(!bytes.includes("C:/private"));
});

test("damaged JSON remains untouched on read and unchanged save, then is preserved before a new connection is saved", async (t) => {
  const h = await fixture(t);
  const original = "{damaged fixture bytes";
  await fs.writeFile(h.file, original);
  const recovered = await h.store.read();
  assert.match(recovered.warning, /could not be restored/);
  assert.deepEqual(recovered.panels, []);
  await h.store.save(recovered);
  assert.equal(await fs.readFile(h.file, "utf8"), original);
  const created = panel({ token: undefined, session: undefined });
  await h.store.save({ panels: [created], selectedServer: null });
  const backups = (await fs.readdir(h.root)).filter((name) =>
    name.startsWith("desktop-workspace-recovered-"),
  );
  assert.equal(backups.length, 1);
  assert.equal(
    await fs.readFile(path.join(h.root, backups[0]), "utf8"),
    original,
  );
  assert.equal((await h.store.read()).panels[0].id, created.id);
});

test("damaged entries recover independently and malformed rosters never authorize or crash restore", async (t) => {
  const h = await fixture(t);
  const valid = panel({ token: undefined, session: undefined });
  await fs.writeFile(
    h.file,
    JSON.stringify({
      version: 1,
      selectedServer: { panelId: valid.id, serverId: "server" },
      panels: [
        null,
        { id: "invalid", origin: "https://invalid.example.test" },
        {
          id: valid.id,
          origin: valid.origin,
          servers: null,
          trustedFingerprint: fingerprint,
        },
        { id: valid.id, origin: "https://duplicate.example.test", servers: [] },
      ],
    }),
  );
  const saved = await h.store.read();
  assert.match(saved.warning, /could not be restored/);
  assert.equal(saved.panels.length, 1);
  assert.deepEqual(saved.panels[0].servers, []);
  assert.equal(saved.panels[0].token, undefined);
  assert.equal(saved.selectedServer, null);
  assert.deepEqual(displayRoster(null), []);
  assert.deepEqual(displayRoster({}), []);
});

test("oversized existing stores recover without reading or rewriting unlimited data", async (t) => {
  const h = await fixture(t);
  const large = await fs.open(h.file, "w");
  await large.truncate(128 * 1024 * 1024 + 1);
  await large.close();
  const before = await fs.stat(h.file);
  const recovered = await h.store.read();
  assert.match(recovered.warning, /could not be restored/);
  await h.store.save(recovered);
  assert.equal((await fs.stat(h.file)).size, before.size);
  await h.store.save({ panels: [panel()], selectedServer: null });
  assert.equal((await h.store.read()).panels.length, 1);
  const backups = (await fs.readdir(h.root)).filter((name) =>
    name.startsWith("desktop-workspace-recovered-"),
  );
  assert.equal(
    (await fs.stat(path.join(h.root, backups[0]))).size,
    before.size,
  );
});

test("sign-out removes credentials and stale roster while preserving certificate trust", async (t) => {
  const h = await fixture(t);
  const initial = panel();
  await h.store.save({
    panels: [initial],
    selectedServer: { panelId: initial.id, serverId: "server" },
  });
  await h.store.save({
    panels: [{ ...initial, token: null, session: null }],
    selectedServer: { panelId: initial.id, serverId: "server" },
  });
  const saved = await h.store.read();
  assert.equal(saved.panels[0].trustedFingerprint, fingerprint);
  assert.equal(saved.panels[0].token, undefined);
  assert.equal(saved.panels[0].session, undefined);
  assert.deepEqual(saved.panels[0].servers, []);
  assert.equal(saved.selectedServer, null);
  const disk = JSON.parse(await fs.readFile(h.file, "utf8"));
  assert.equal(disk.panels[0].credential, undefined);
  assert.deepEqual(disk.panels[0].servers, []);
});

test("unavailable OS decryption gives a renewal warning and preserves the existing credential on unchanged close", async (t) => {
  const h = await fixture(t);
  await h.store.save({ panels: [panel()], selectedServer: null });
  const original = await fs.readFile(h.file, "utf8");
  const unavailable = createUnifiedConnectionStore({
    dataDir: h.root,
    safeStorage: { ...safeStorage, isEncryptionAvailable: () => false },
  });
  const restored = await unavailable.read();
  assert.match(restored.warning, /could not be decrypted/);
  assert.equal(restored.panels[0].token, undefined);
  assert.deepEqual(restored.panels[0].servers, []);
  await unavailable.save(restored);
  await unavailable.close();
  assert.equal(await fs.readFile(h.file, "utf8"), original);
  assert.equal((await h.store.read()).panels[0].token, token);
});

test("legacy migration retains addresses and trust, and independent cleanup cannot resurrect another forgotten panel", async (t) => {
  const h = await fixture(t);
  const a = panel(),
    c = panel({ origin: "https://c.example.test" });
  const legacy = createConnectionStore({ dataDir: h.root });
  await legacy.save({
    activeId: a.id,
    panels: [a, c].map(({ id, origin, trustedFingerprint }) => ({
      id,
      origin,
      trustedFingerprint,
      signedIn: true,
    })),
  });
  await legacy.close();
  const migrated = await h.store.read();
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.panels.length, 2);
  assert.ok(
    migrated.panels.every(
      (entry) =>
        entry.trustedFingerprint === fingerprint &&
        !entry.token &&
        !entry.servers.length,
    ),
  );
  await h.store.save(migrated);
  const before = await fs.readFile(h.file, "utf8");
  await Promise.all([h.store.forgetLegacy(a.id), h.store.forgetLegacy(c.id)]);
  const prior = JSON.parse(
    await fs.readFile(path.join(h.root, "desktop-connections.json"), "utf8"),
  );
  assert.deepEqual(prior, { activeId: "local", panels: [] });
  assert.equal(await fs.readFile(h.file, "utf8"), before);
});

test("unchanged roster polls do not rewrite or re-encrypt the whole connection store", async (t) => {
  let encryptions = 0;
  const h = await fixture(t, {
    ...safeStorage,
    encryptString: (value) => {
      encryptions++;
      return safeStorage.encryptString(value);
    },
  });
  const snapshot = { panels: [panel()], selectedServer: null };
  await h.store.save(snapshot);
  const saved = await h.store.read();
  await h.store.save(snapshot);
  await h.store.save(saved);
  assert.equal(encryptions, 1);
});

test("pending departure proof restores only from encrypted credentials and requires durable encryption", async (t) => {
  const h = await fixture(t);
  const requestId = randomUUID();
  const savedPanel = panel({ pendingLeave: { requestId } });
  await h.store.save({ panels: [savedPanel], selectedServer: null });
  const bytes = await fs.readFile(h.file, "utf8");
  assert.ok(!bytes.includes(requestId));
  assert.ok(!bytes.includes(token));
  assert.equal(JSON.parse(bytes).panels[0].pendingLeave, undefined);
  const restored = await h.store.read();
  assert.deepEqual(restored.panels[0].pendingLeave, { requestId });
  assert.equal(restored.panels[0].token, token);
  const unavailable = createUnifiedConnectionStore({
    dataDir: h.root,
    safeStorage: { ...safeStorage, isEncryptionAvailable: () => false },
  });
  await assert.rejects(
    unavailable.save({ panels: [savedPanel], selectedServer: null }),
    /retry proof could not be encrypted/,
  );
  assert.equal(await fs.readFile(h.file, "utf8"), bytes);
  await unavailable.close();
});

test("promoting a new connection requires encryption and preserves the original file when secure storage is unavailable", async (t) => {
  let available = true;
  const h = await fixture(t, {
    ...safeStorage,
    isEncryptionAvailable: () => available,
  });
  const existing = panel({ token: undefined, session: undefined }),
    draft = panel({ origin: "https://new.example.test" });
  const prior = { panels: [existing], selectedServer: null };
  await h.store.save(prior);
  const original = await fs.readFile(h.file, "utf8"),
    entries = await fs.readdir(h.root);
  available = false;
  await assert.rejects(
    h.store.save({
      panels: [existing, draft],
      selectedServer: null,
      requireCredentialFor: draft.id,
    }),
    /sign-in could not be encrypted and saved/,
  );
  assert.equal(await fs.readFile(h.file, "utf8"), original);
  assert.deepEqual(await fs.readdir(h.root), entries);
  assert.equal(original.includes(draft.origin), false);
  // Existing unsigned entries retain their old save behavior.
  await h.store.save(prior);
  assert.equal(await fs.readFile(h.file, "utf8"), original);
  available = true;
  await h.store.save({
    panels: [existing, draft],
    selectedServer: null,
    requireCredentialFor: draft.id,
  });
  const restored = await h.store.read();
  assert.equal(
    restored.panels.find((entry) => entry.id === draft.id).token,
    token,
  );
});

test("required promotion rejects missing or malformed credentials before writing an unsigned record", async (t) => {
  const h = await fixture(t),
    existing = panel(),
    draft = panel({ origin: "https://new.example.test" });
  await h.store.save({ panels: [existing], selectedServer: null });
  const original = await fs.readFile(h.file, "utf8");
  for (const changed of [
    { ...draft, token: "invalid" },
    { ...draft, session: null },
    { ...draft, session: { ...account, email: "" } },
  ]) {
    await assert.rejects(
      h.store.save({
        panels: [existing, changed],
        selectedServer: null,
        requireCredentialFor: draft.id,
      }),
      /sign-in could not be encrypted and saved/,
    );
    assert.equal(await fs.readFile(h.file, "utf8"), original);
  }
  await assert.rejects(
    h.store.save({
      panels: [existing],
      selectedServer: null,
      requireCredentialFor: draft.id,
    }),
    /no longer available/,
  );
  assert.equal(await fs.readFile(h.file, "utf8"), original);
});

test("promotion rechecks secure storage when its queued save begins", async (t) => {
  let available = true;
  const h = await fixture(t, {
    ...safeStorage,
    isEncryptionAvailable: () => available,
  });
  const existing = panel(),
    draft = panel({ origin: "https://new.example.test" }),
    prior = { panels: [existing], selectedServer: null };
  await h.store.save(prior);
  const original = await fs.readFile(h.file, "utf8");
  const queued = h.store.save({
    panels: [existing, draft],
    selectedServer: null,
    requireCredentialFor: draft.id,
  });
  available = false;
  await assert.rejects(queued, /sign-in could not be encrypted and saved/);
  assert.equal(await fs.readFile(h.file, "utf8"), original);
  available = true;
  await h.store.save(prior);
});
