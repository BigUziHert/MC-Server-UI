import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { downloadVerified, providerJson } from "./launchpad-network.mjs";

test("CurseForge download credentials rotate at execution and only follow trusted CDN redirects", async (t) => {
  const f = await downloadFixture(t, Buffer.from("fixture"));
  f.file.url = "https://edge.forgecdn.net/files/example.jar";
  const hosts = [
    "edge.forgecdn.net",
    "mediafilez.forgecdn.net",
    "cdn.modrinth.com",
  ];
  let secret = "canary-first-key";
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, key: new Headers(options.headers).get("x-api-key") });
    return new URL(url).hostname === "edge.forgecdn.net"
      ? new Response(null, {
          status: 302,
          headers: {
            location: "https://mediafilez.forgecdn.net/files/example.jar",
          },
        })
      : new Response("fixture");
  };
  await downloadVerified(f.file, f.target, hosts, request, {
    curseforgeKey: async () => secret,
  });
  assert.deepEqual(
    requests.map((entry) => entry.key),
    [secret, secret],
  );
  await fs.unlink(f.target);
  secret = "canary-rotated-key";
  await downloadVerified(f.file, f.target, hosts, request, {
    curseforgeKey: async () => secret,
  });
  assert.deepEqual(
    requests.slice(2).map((entry) => entry.key),
    [secret, secret],
  );
  await fs.unlink(f.target);
  let calls = 0;
  await assert.rejects(
    downloadVerified(
      f.file,
      f.target,
      hosts,
      async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.modrinth.com/unrelated.jar" },
        });
      },
      { curseforgeKey: async () => secret },
    ),
    /different service/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    downloadVerified(f.file, f.target, hosts, request, {
      curseforgeKey: async () => null,
    }),
    /Add a CurseForge API key/,
  );
  assert.equal(requests.length, 4);
  for (const status of [401, 403]) {
    await assert.rejects(
      downloadVerified(
        f.file,
        f.target,
        hosts,
        async () => new Response(secret, { status }),
        { curseforgeKey: async () => secret },
      ),
      (cause) =>
        !cause.message.includes(secret) && /denied access/.test(cause.message),
    );
  }
  f.file.url = "https://cdn.modrinth.com/unrelated.jar";
  await downloadVerified(
    f.file,
    f.target,
    hosts,
    async (_url, options) => {
      assert.equal(new Headers(options.headers).get("x-api-key"), null);
      return new Response("fixture");
    },
    { curseforgeKey: async () => secret },
  );
});

test("failed download never deletes a pre-existing target", async (t) => {
  const f = await downloadFixture(t, Buffer.from("fixture"));
  await fs.writeFile(f.target, "external file");
  await assert.rejects(
    downloadVerified(
      f.file,
      f.target,
      f.hosts,
      async () => new Response("fixture"),
    ),
    { code: "EEXIST" },
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "external file");
});

test("Retry-After preserves long deadlines and HTTP dates", async () => {
  for (const header of ["7200", new Date(Date.now() + 7200000).toUTCString()])
    await assert.rejects(
      providerJson("https://api.curseforge.com/v1/mods", {
        fetch: async () =>
          new Response(null, {
            status: 429,
            headers: { "Retry-After": header },
          }),
      }),
      (cause) => cause.retryAfterMs >= 7198000,
    );
});

test("provider errors preserve upstream status and retry-after for safe recovery", async () => {
  for (const status of [401, 403, 429, 503]) {
    await assert.rejects(
      providerJson("https://api.modrinth.com/v2/version_files", {
        fetch: async () =>
          new Response("Unavailable", {
            status,
            headers: { "Retry-After": "120" },
          }),
      }),
      (cause) =>
        cause.upstreamStatus === status &&
        cause.retryAfterMs === 120000 &&
        cause.status === (status === 429 ? 429 : 502),
    );
  }
});

test("Modrinth firewall errors retain their response type without API-key advice", async () => {
  await assert.rejects(
    providerJson("https://api.modrinth.com/v2/version_files", {
      method: "POST",
      fetch: async () =>
        new Response("<html>Request blocked</html>", {
          status: 403,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    }),
    (cause) =>
      cause.upstreamStatus === 403 &&
      cause.upstreamContentType === "text/html; charset=utf-8" &&
      /Modrinth rejected.*HTTP 403/.test(cause.message) &&
      /do not require an API key/.test(cause.message),
  );
  await assert.rejects(
    providerJson("https://api.curseforge.com/v1/mods", {
      fetch: async () => new Response("Forbidden", { status: 403 }),
    }),
    /Check its API key or download restrictions/,
  );
});

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
