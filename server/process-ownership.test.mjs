import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProcessOwnership } from "./process-ownership.mjs";

test("process recovery persists identity and refuses to adopt a recycled PID", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-process-owner-"));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith("mc-process-owner-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  let birth = "12345678";
  const options = {
    dataDir: root,
    serverDir: path.join(root, "server"),
    safePath: async (base, relative) => path.join(base, relative),
    identify: async (pid) => ({ pid, birth }),
  };
  const owner = await createProcessOwnership(options);
  await owner.remember(
    { pid: 12345, exitCode: null, signalCode: null },
    "java",
    100,
  );
  assert.equal((await owner.current()).pid, 12345);
  const recovered = await createProcessOwnership(options);
  assert.equal((await recovered.current()).birth, "12345678");
  birth = "99999999";
  assert.equal(await recovered.current(), null);
  await recovered.stop();
  await assert.rejects(fs.stat(path.join(root, "owned-process.json")), {
    code: "ENOENT",
  });
});

test("an exited wrapper retains an unresolved ownership sentinel until explicitly confirmed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-process-owner-"));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith("mc-process-owner-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  let birth = "original";
  const options = {
    dataDir: root,
    serverDir: path.join(root, "server"),
    safePath: async (base, relative) => path.join(base, relative),
    identify: async (pid) => (birth ? { pid, birth } : null),
  };
  const owner = await createProcessOwnership(options);
  await owner.remember(
    { pid: 12345, exitCode: null, signalCode: null },
    "wrapper",
    100,
    { tree: true },
  );
  await assert.rejects(owner.confirmStopped(), /launcher is still running/);
  birth = "reused";
  const recovered = await createProcessOwnership(options);
  assert.equal((await recovered.current()).unresolved, true);
  await assert.rejects(
    recovered.stop(),
    /child processes could still be running/,
  );
  assert.equal((await recovered.current()).pid, 12345);
  birth = null;
  await recovered.confirmStopped();
  assert.equal(await recovered.current(), null);
  await assert.rejects(fs.stat(path.join(root, "owned-process.json")), {
    code: "ENOENT",
  });
});

test("a live process with unknown identity is rejected unless tracking is explicitly disabled for a mock", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-process-owner-"));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith("mc-process-owner-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const options = {
    dataDir: root,
    serverDir: path.join(root, "server"),
    safePath: async (base, relative) => path.join(base, relative),
    identify: async () => null,
  };
  const owner = await createProcessOwnership(options);
  await assert.rejects(
    owner.remember(
      { pid: 12345, exitCode: null, signalCode: null },
      "java",
      100,
    ),
    /identity could not be verified/,
  );
  assert.equal((await owner.current()).unresolved, true);
  assert.equal((await owner.current()).birth, null);
  await assert.rejects(owner.stop(), /identity is unresolved/);
  await owner.confirmStopped();
  assert.equal(await owner.current(), null);
  await owner.remember(
    { pid: 12345, exitCode: 1, signalCode: null },
    "java",
    100,
  );
  const mock = await createProcessOwnership({
    ...options,
    allowUntracked: true,
  });
  await mock.remember(
    { pid: 12345, exitCode: null, signalCode: null },
    "java",
    100,
  );
  await assert.rejects(fs.stat(path.join(root, "owned-process.json")), {
    code: "ENOENT",
  });
});

test("process exit cleanup cannot race a pending ownership publication", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-process-owner-"));
  t.after(async () => {
    t.mock.restoreAll();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-process-owner-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const owner = await createProcessOwnership({
    dataDir: root,
    serverDir: path.join(root, "server"),
    safePath: async (base, relative) => path.join(base, relative),
    identify: async (pid) => ({ pid, birth: "12345678" }),
  });
  let release, reached;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (source, destination) => {
    if (destination === path.join(root, "owned-process.json")) {
      reached();
      await gate;
    }
    return rename(source, destination);
  });
  const remembering = owner.remember(
    { pid: 12345, exitCode: null, signalCode: null },
    "java",
    100,
  );
  await entered;
  const clearing = owner.clear(12345);
  release();
  await Promise.all([remembering, clearing]);
  assert.equal(await owner.current(), null);
  await assert.rejects(fs.stat(path.join(root, "owned-process.json")), {
    code: "ENOENT",
  });
});

async function ownershipFixture(t, identify) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-process-owner-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-process-owner-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const options = {
    dataDir: root,
    serverDir: path.join(root, "server"),
    safePath: async (base, relative) => path.join(base, relative),
    identify,
  };
  return { root, options, owner: await createProcessOwnership(options) };
}
test("a wrapper that exits before identification leaves a durable unresolved sentinel without adopting a reused PID", async (t) => {
  let found = null;
  const f = await ownershipFixture(t, async () => found);
  await f.owner.remember(
    { pid: 12345, exitCode: 0, signalCode: null },
    "wrapper",
    100,
    { tree: true },
  );
  const recovered = await createProcessOwnership(f.options);
  assert.deepEqual(await recovered.current(), {
    pid: 12345,
    birth: null,
    unresolved: true,
    tree: true,
    executable: "wrapper",
    serverDir: f.options.serverDir,
    startedAt: 100,
  });
  found = { pid: 12345, birth: "unrelated-reused-pid" };
  await assert.rejects(recovered.stop(), /identity is unresolved/);
  await assert.rejects(
    recovered.confirmStopped(),
    /PID cannot yet be ruled out/,
  );
  assert.equal((await recovered.current()).birth, null);
  found = null;
  await recovered.confirmStopped();
  assert.equal(await recovered.current(), null);
});
test("the sentinel is durable during identity lookup and preserves wrappers that exit while lookup is pending", async (t) => {
  let release, reached;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const f = await ownershipFixture(t, async (pid) => {
    reached();
    await gate;
    return { pid, birth: "original" };
  });
  const child = { pid: 12345, exitCode: null, signalCode: null };
  const remembering = f.owner.remember(child, "wrapper", 100, { tree: true });
  await entered;
  const saved = JSON.parse(
    await fs.readFile(path.join(f.root, "owned-process.json"), "utf8"),
  );
  assert.equal(saved.unresolved, true);
  assert.equal(saved.birth, null);
  child.exitCode = 0;
  release();
  await remembering;
  const recovered = await createProcessOwnership(f.options);
  assert.equal((await recovered.current()).unresolved, true);
  assert.equal((await recovered.current()).birth, "original");
  await assert.rejects(recovered.stop(), /identity is unresolved/);
});
test("a production identity lookup failure retains an unresolved record across restart before rejecting launch", async (t) => {
  const f = await ownershipFixture(t, async () => {
    throw new Error("OS identity service unavailable");
  });
  await assert.rejects(
    f.owner.remember(
      { pid: 12345, exitCode: null, signalCode: null },
      "java",
      100,
    ),
    /identity could not be verified/,
  );
  const recovered = await createProcessOwnership(f.options);
  assert.equal((await recovered.current()).unresolved, true);
  assert.equal((await recovered.current()).birth, null);
  await assert.rejects(recovered.stop(), /identity is unresolved/);
});
test("exit cleanup queued during identity lookup cannot be overtaken by late publication", async (t) => {
  let release, reached;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const f = await ownershipFixture(t, async (pid) => {
    reached();
    await gate;
    return { pid, birth: "original" };
  });
  const remembering = f.owner.remember(
    { pid: 12345, exitCode: null, signalCode: null },
    "java",
    100,
  );
  await entered;
  const clearing = f.owner.clear(12345);
  release();
  await Promise.all([remembering, clearing]);
  assert.equal(await f.owner.current(), null);
  await assert.rejects(fs.stat(path.join(f.root, "owned-process.json")), {
    code: "ENOENT",
  });
});
