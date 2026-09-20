import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { downloadVerified, providerJson } from "./launchpad-network.mjs";

test("catalog requests keep a deadline when a caller supplies a lifetime signal", async (t) => {
  const caller = new AbortController(),
    deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (delay) => {
    assert.equal(delay, 60000);
    return deadline.signal;
  });
  let sent;
  const response = providerJson(
    "https://api.modrinth.com/v2/tag/game_version",
    {
      signal: caller.signal,
      fetch: async (_url, { signal }) => {
        sent = signal;
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    },
  );
  assert.notEqual(sent, caller.signal);
  deadline.abort(new Error("catalog deadline"));
  await assert.rejects(response, /catalog deadline/);
  assert.equal(caller.signal.aborted, false);
});

test("catalog cancellation still propagates through the deadline signal", async (t) => {
  const caller = new AbortController(),
    deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const response = providerJson(
    "https://api.modrinth.com/v2/tag/game_version",
    {
      signal: caller.signal,
      fetch: async (_url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    },
  );
  caller.abort(new Error("closed by caller"));
  await assert.rejects(response, /closed by caller/);
  assert.equal(deadline.signal.aborted, false);
});

async function downloadFixture(t, bytes) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, "mc-download-stall-"));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    file: {
      url: "https://cdn.modrinth.com/fixture.jar",
      size: bytes.length,
      hashes: { sha512: createHash("sha512").update(bytes).digest("hex") },
    },
    target: path.join(root, "download.jar"),
    hosts: ["cdn.modrinth.com"],
  };
}

test("a progressing verified download may run past the old whole-transfer deadline", async (t) => {
  const bytes = Buffer.from("abc");
  const f = await downloadFixture(t, bytes);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let sent;
  const request = async (_url, { signal }) => {
    sent = signal;
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        for (const byte of bytes) {
          t.mock.timers.tick(59000);
          yield Buffer.from([byte]);
        }
      })(),
    };
  };
  assert.equal(await downloadVerified(f.file, f.target, f.hosts, request), 3);
  assert.deepEqual(await fs.readFile(f.target), bytes);
  assert.equal(sent.aborted, false);
  t.mock.timers.runAll();
  assert.equal(
    sent.aborted,
    false,
    "Finished downloads must remove both manual timers.",
  );
});

test("a body that stops producing data fails with an actionable stall error", async (t) => {
  const f = await downloadFixture(t, Buffer.from("fixture"));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let began;
  const reading = new Promise((resolve) => {
    began = resolve;
  });
  const result = downloadVerified(
    f.file,
    f.target,
    f.hosts,
    async (_url, { signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener(
              "abort",
              () => controller.error(signal.reason),
              { once: true },
            );
          },
          pull() {
            began();
          },
        }),
      ),
  );
  const rejected = assert.rejects(
    result,
    (cause) => cause.status === 504 && /stalled/.test(cause.message),
  );
  await reading;
  t.mock.timers.tick(60000);
  await rejected;
});

test("progress cannot extend the absolute download ceiling", async (t) => {
  const bytes = Buffer.alloc(40, 1);
  const f = await downloadFixture(t, bytes);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await assert.rejects(
    downloadVerified(f.file, f.target, f.hosts, async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        for (const byte of bytes) {
          t.mock.timers.tick(59000);
          yield Buffer.from([byte]);
        }
      })(),
    })),
    (cause) => cause.status === 504 && /30-minute/.test(cause.message),
  );
});

test("download cancellation preserves the caller's reason during headers", async (t) => {
  const f = await downloadFixture(t, Buffer.from("fixture"));
  const caller = new AbortController();
  const reason = Object.assign(new Error("Panel is closing"), { status: 503 });
  const result = downloadVerified(
    f.file,
    f.target,
    f.hosts,
    async (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new Error("fetch aborted")),
          { once: true },
        ),
      ),
    { signal: caller.signal },
  );
  caller.abort(reason);
  await assert.rejects(result, (cause) => cause === reason);
  await assert.rejects(fs.stat(f.target), { code: "ENOENT" });
});
