import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createOperationReceipts } from "./operation-receipts.mjs";
import { safePath } from "./index.mjs";

async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "mc-operation-receipts-"));
  t.after(async () => {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-operation-receipts-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return () => createOperationReceipts(root, safePath);
}

test("destructive operation receipts replay across restart and bind actor and payload", async (t) => {
  const boot = await fixture(t);
  const store = await boot();
  const id = randomUUID();
  const binding = { actor: "first", target: "backup-a" };
  let writes = 0;
  const work = async () => ({ written: ++writes });
  assert.deepEqual(await store.run(id, binding, work), { written: 1 });
  assert.deepEqual(await (await boot()).run(id, binding, work), { written: 1 });
  assert.equal(writes, 1);
  for (const altered of [
    { ...binding, actor: "second" },
    { ...binding, target: "backup-b" },
  ])
    await assert.rejects(store.run(id, altered, work), { status: 409 });
  assert.equal(writes, 1);
  assert.deepEqual(await store.run(randomUUID(), binding, work), {
    written: 2,
  });
});

test("duplicate in-flight requests share work while interrupted durable receipts fail closed", async (t) => {
  const boot = await fixture(t);
  const store = await boot();
  const id = randomUUID(),
    binding = { actor: "first" };
  const reached = Promise.withResolvers(),
    release = Promise.withResolvers();
  let writes = 0;
  const pending = store.run(id, binding, async () => {
    writes++;
    reached.resolve();
    await release.promise;
    return { done: true };
  });
  await reached.promise;
  const duplicate = store.run(id, binding, () =>
    assert.fail("must not repeat"),
  );
  try {
    await assert.rejects(
      (await boot()).run(id, binding, () =>
        assert.fail("must not replay after restart"),
      ),
      /interrupted/,
    );
  } finally {
    release.resolve();
  }
  assert.deepEqual(await duplicate, await pending);
  assert.equal(writes, 1);
});

test("failed and malformed operation receipts cannot restart destructive work", async (t) => {
  const boot = await fixture(t),
    store = await boot(),
    id = randomUUID();
  await assert.rejects(
    store.run(id, {}, async () => {
      throw Object.assign(new Error("disk failed"), { status: 409 });
    }),
    /disk failed/,
  );
  await assert.rejects(
    (await boot()).run(id, {}, () =>
      assert.fail("must not retry partial work"),
    ),
    /review again/,
  );
  await assert.rejects(
    store.run("../bad", {}, () => assert.fail("invalid id")),
    { status: 400 },
  );
});

test("a proven pre-acceptance rejection can retry without retaining a failed operation", async (t) => {
  const boot = await fixture(t),
    store = await boot(),
    id = randomUUID();
  await assert.rejects(
    store.run(id, {}, async () => {
      throw Object.assign(new Error("server busy"), {
        status: 409,
        operationNotStarted: true,
      });
    }),
    /server busy/,
  );
  assert.deepEqual(await store.run(id, {}, async () => ({ accepted: true })), {
    accepted: true,
  });
});

test("a committed mutation with an unwritable final receipt stays non-replayable after restart", async (t) => {
  const boot = await fixture(t),
    store = await boot(),
    id = randomUUID();
  let writes = 0;
  t.mock.method(fs, "rename", async () => {
    throw Object.assign(new Error("receipt disk unavailable"), {
      code: "EACCES",
    });
  });
  await assert.rejects(
    store.run(id, {}, async () => ({ writes: ++writes })),
    /receipt disk unavailable/,
  );
  t.mock.restoreAll();
  await assert.rejects(
    (await boot()).run(id, {}, () => {
      writes++;
    }),
    /interrupted/,
  );
  assert.equal(writes, 1);
});
