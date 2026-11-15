import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createLaunchpadHistory } from "./launchpad-history.mjs";
import { containedSourcePath } from "./import.mjs";

const hash = (value) => createHash("sha512").update(value).digest("hex");
const safePath = (root, relative = "") =>
  relative ? containedSourcePath(root, relative) : fs.realpath(root);
async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "mc-launchpad-history-"));
  t.after(async () => {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-launchpad-history-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const privatePath = (relative) => safePath(root, relative);
  const boot = (fileHash = async (file) => hash(await fs.readFile(file))) =>
    createLaunchpadHistory({ privatePath, safePath, fileHash });
  const recovery = {
    directory: `recovery-${randomUUID()}`,
    originals: [
      {
        path: "mods/example.jar",
        backup: "0.original",
        sha512: hash("original package"),
      },
    ],
  };
  await fs.mkdir(await privatePath(recovery.directory));
  await fs.writeFile(
    path.join(root, recovery.directory, "0.original"),
    "original package",
  );
  const input = () => ({
    jobId: randomUUID(),
    kind: "update",
    title: "Example update",
    written: [{ path: "mods/example.jar", sha512: hash("updated package") }],
    recycled: [{ id: randomUUID(), path: "mods/example.jar" }],
    receipts: [{ path: "mods/example.jar", versionId: "old-version" }],
    afterReceipts: [{ path: "mods/example.jar", versionId: "new-version" }],
  });
  return { root, boot, input, recovery };
}

test("job history retains verified originals and receipts across transaction cleanup and restart", async (t) => {
  const f = await fixture(t);
  let history = await f.boot();
  const input = f.input();
  const saved = await history.save(input, f.recovery);
  await fs.rm(path.join(f.root, f.recovery.directory), { recursive: true });
  input.receipts[0].versionId = "caller changed its input";
  saved.receipts[0].versionId = "caller changed its result";
  history = await f.boot();
  const [record] = await history.list();
  assert.equal(record.receipts[0].versionId, "old-version");
  assert.equal(record.afterReceipts[0].versionId, "new-version");
  assert.equal(
    await fs.readFile(
      await history.source(record, record.originals[0]),
      "utf8",
    ),
    "original package",
  );
  assert.equal((await history.get(record.jobId)).undoneAt, undefined);
  await history.markUndone(record.jobId);
  assert.ok((await (await f.boot()).get(record.jobId)).undoneAt);
});

test("a failed verified copy publishes nothing and preserves earlier history", async (t) => {
  const f = await fixture(t);
  const history = await f.boot();
  const original = await history.save(f.input(), f.recovery);
  const broken = await f.boot(async (file) =>
    file.includes(".pending-")
      ? hash("corrupted copy")
      : hash(await fs.readFile(file)),
  );
  const next = f.input();
  await assert.rejects(broken.save(next, f.recovery), /changed while saving/);
  assert.equal(await history.get(next.jobId), null);
  assert.deepEqual(
    (await history.list()).map((entry) => entry.jobId),
    [original.jobId],
  );
  assert.deepEqual(
    (await fs.readdir(path.join(f.root, "history"))).filter((name) =>
      name.startsWith(".pending-"),
    ),
    [],
  );
  assert.equal(
    await fs.readFile(
      await history.source(original, original.originals[0]),
      "utf8",
    ),
    "original package",
  );
});

test("history rejects escaped paths, changed originals and unowned discard targets", async (t) => {
  const f = await fixture(t);
  const history = await f.boot();
  const input = f.input();
  await assert.rejects(
    history.save(
      { ...input, written: [{ path: "../outside.jar", sha512: hash("x") }] },
      f.recovery,
    ),
    /invalid saved path/,
  );
  await assert.rejects(
    history.discard("../history"),
    /valid Launchpad history/,
  );
  const record = await history.save(input, f.recovery);
  await assert.rejects(history.save(input, f.recovery), /already has/);
  await assert.rejects(
    history.source(record, { ...record.originals[0], backup: "../entry.json" }),
    /not part/,
  );
  await fs.writeFile(
    path.join(f.root, "history", record.jobId, "0.original"),
    "user-edited recovery bytes",
  );
  await assert.rejects(
    history.source(record, record.originals[0]),
    /recovery copy changed/,
  );
  assert.equal(
    await fs.readFile(
      path.join(f.root, "history", record.jobId, "0.original"),
      "utf8",
    ),
    "user-edited recovery bytes",
  );
});

test("history bounds published jobs to thirty while preserving non-history folders", async (t) => {
  const f = await fixture(t);
  const history = await f.boot();
  await fs.mkdir(path.join(f.root, "history", "owner-notes"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(f.root, "history", "owner-notes", "keep.txt"),
    "retained",
  );
  const saved = [];
  for (let index = 0; index < 30; index++)
    saved.push(await history.save(f.input(), f.recovery));
  const abandoned = await history.save(f.input(), f.recovery);
  assert.equal(
    (await fs.readdir(path.join(f.root, "history"))).filter((name) =>
      /^[a-f0-9-]{36}$/.test(name),
    ).length,
    31,
  );
  assert.ok(
    await history.get(saved[0].jobId),
    "Saving an uncommitted job must not evict older recovery history.",
  );
  await history.discard(abandoned.jobId);
  assert.ok(await history.get(saved[0].jobId));
  await history.save(f.input(), f.recovery);
  await history.prune();
  assert.equal((await history.list()).length, 30);
  assert.equal(
    (await fs.readdir(path.join(f.root, "history"))).filter((name) =>
      /^[a-f0-9-]{36}$/.test(name),
    ).length,
    30,
  );
  assert.equal(
    await fs.readFile(
      path.join(f.root, "history", "owner-notes", "keep.txt"),
      "utf8",
    ),
    "retained",
  );
  const [record] = await history.list();
  await history.discard(record.jobId);
  assert.equal(await history.get(record.jobId), null);
});

test("reading an unused history does not create storage", async (t) => {
  const f = await fixture(t);
  const history = await f.boot();
  assert.deepEqual(await history.list(), []);
  assert.equal(await history.get(randomUUID()), null);
  await history.discard(randomUUID());
  await assert.rejects(fs.stat(path.join(f.root, "history")), {
    code: "ENOENT",
  });
});
