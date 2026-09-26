import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import yauzl from "yauzl";
import { createFleet, safePath } from "./index.mjs";
import { planFileDownload, streamFileArchive } from "./file-download.mjs";

const origin = "https://panel.example.test";
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const download = (...paths) => {
  const query = new URLSearchParams();
  for (const item of paths) query.append("path", item);
  return `/api/files/download?${query}`;
};

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-file-download-test-")),
  );
  const fleet = await createFleet({
    dataDir: root,
    useEnvironment: false,
    createDefaultServer: true,
    scheduler: false,
    remoteListen: false,
    publicAddress: { resolve: async () => null },
  });
  const listen = (app) =>
    new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
  const owner = await listen(fleet.app);
  const remote = await listen(fleet.remoteApp);
  const request =
    (listener, defaults = {}) =>
    (route, options = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${listener.address().port}${route}`,
          {
            method: options.method ?? "GET",
            headers: {
              "Content-Type": "application/json",
              ...defaults,
              ...options.headers,
            },
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () => {
              const bytes = Buffer.concat(chunks);
              try {
                resolve({
                  status: response.statusCode,
                  headers: response.headers,
                  bytes,
                  body: response.headers["content-type"]?.includes(
                    "application/json",
                  )
                    ? JSON.parse(bytes.toString("utf8"))
                    : undefined,
                });
              } catch (cause) {
                reject(cause);
              }
            });
          },
        );
        req.on("error", reject);
        req.end(options.body);
      });
  const local = request(owner);
  const guest = request(remote, { Host: "panel.example.test", Origin: origin });
  t.after(async () => {
    await fleet.close();
    for (const listener of [owner, remote]) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-file-download-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const id = (await local("/api/servers")).body.defaultServerId;
  const serverDir = fleet.runtimes.get(id).serverDir;
  const invite = async (permissions, email, serverId = id, existingCookie) => {
    const created = await local("/api/subusers", {
      ...json("POST", { email, permissions }),
      headers: { "X-Server-Id": serverId },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sent = await local(`/api/subusers/${created.body.id}/invite`, {
      method: "POST",
      headers: { "X-Server-Id": serverId },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const token = new URL(sent.body.invitationUrl).hash.slice(
      "#invite=".length,
    );
    const signed = await guest("/api/access/accept", {
      ...json("POST", { token, password: "Correct-test-password!" }),
      ...(existingCookie ? { headers: { Cookie: existingCookie } } : {}),
    });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    const cookie = signed.headers["set-cookie"][0].split(";")[0];
    return {
      user: created.body,
      cookie,
      asUser: request(remote, {
        Host: "panel.example.test",
        Origin: origin,
        Cookie: cookie,
      }),
    };
  };
  return { root, fleet, id, serverDir, local, guest, invite };
}

async function archiveEntries(bytes) {
  const archive = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (cause, zip) =>
      cause ? reject(cause) : resolve(zip),
    );
  });
  return new Promise((resolve, reject) => {
    const entries = new Map();
    archive.on("error", reject);
    archive.on("end", () => resolve(entries));
    archive.on("entry", async (entry) => {
      try {
        assert.equal(
          entries.has(entry.fileName),
          false,
          "ZIP entries must be unique",
        );
        if (entry.fileName.endsWith("/")) {
          entries.set(entry.fileName, null);
        } else {
          const stream = await new Promise((done, fail) => {
            archive.openReadStream(entry, (cause, value) =>
              cause ? fail(cause) : done(value),
            );
          });
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          entries.set(entry.fileName, Buffer.concat(chunks));
        }
        archive.readEntry();
      } catch (cause) {
        archive.close();
        reject(cause);
      }
    });
    archive.readEntry();
  });
}

test("single file downloads preserve binary bytes and Unicode attachment names", async (t) => {
  const { serverDir, local } = await fixture(t);
  const name = "world data 世界-é.bin";
  const original = Buffer.from([0, 255, 128, 10, 13, 26, 254, 0, 42]);
  await fs.writeFile(path.join(serverDir, name), original);
  const response = await local(download(name));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.bytes, original);
  assert.match(response.headers["content-disposition"], /^attachment;/);
  assert.ok(
    response.headers["content-disposition"].includes(encodeURIComponent(name)),
  );
  assert.equal(Number(response.headers["content-length"]), original.length);
  await fs.writeFile(path.join(serverDir, "empty.bin"), "");
  const empty = await local(download("empty.bin"));
  assert.equal(empty.status, 200);
  assert.equal(empty.bytes.length, 0);
  await fs.writeFile(path.join(serverDir, ".hidden"), original);
  const hidden = await local(download(".hidden"));
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.deepEqual(hidden.bytes, original);
  assert.match(hidden.headers["content-disposition"], /filename="\.hidden"/);
});

test("folder ZIP downloads retain their root, nested empty folders, Unicode paths and binary contents", async (t) => {
  const { serverDir, local } = await fixture(t);
  await fs.mkdir(path.join(serverDir, "world", "nested", "empty"), {
    recursive: true,
  });
  const name = "世界-é.dat";
  const bytes = Buffer.from([0, 255, 32, 127, 128]);
  await fs.writeFile(path.join(serverDir, "world", "nested", name), bytes);
  await fs.writeFile(path.join(serverDir, "world", "empty.dat"), "");
  const response = await local(download("world"));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(response.headers["content-type"], /^application\/zip\b/);
  assert.match(
    response.headers["content-disposition"],
    /filename="world\.zip"/,
  );
  const entries = await archiveEntries(response.bytes);
  assert.deepEqual(
    [...entries.keys()].sort(),
    [
      "world/",
      "world/empty.dat",
      "world/nested/",
      "world/nested/empty/",
      `world/nested/${name}`,
    ].sort(),
  );
  assert.deepEqual(entries.get(`world/nested/${name}`), bytes);
  assert.deepEqual(entries.get("world/empty.dat"), Buffer.alloc(0));
  assert.equal(entries.get("world/nested/empty/"), null);
});

test("selection ZIPs use their common parent and deduplicate duplicate or overlapping paths", async (t) => {
  const { serverDir, local } = await fixture(t);
  await fs.mkdir(path.join(serverDir, "config", "mods", "empty"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(serverDir, "config", "mods", "settings.json"),
    "mod settings",
  );
  await fs.writeFile(path.join(serverDir, "config", "options.txt"), "options");
  const response = await local(
    download(
      "config/mods/settings.json",
      "config/options.txt",
      "config/mods",
      "config/mods",
      "config/options.txt",
    ),
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(
    response.headers["content-disposition"],
    /filename="files\.zip"/,
  );
  const entries = await archiveEntries(response.bytes);
  assert.deepEqual([...entries.keys()].sort(), [
    "mods/",
    "mods/empty/",
    "mods/settings.json",
    "options.txt",
  ]);
  assert.equal(entries.get("mods/settings.json").toString(), "mod settings");
  assert.equal(entries.get("options.txt").toString(), "options");
});

test("selection ZIPs preserve different branches with identically named files", async (t) => {
  const { serverDir, local } = await fixture(t);
  for (const name of ["first", "second"]) {
    await fs.mkdir(path.join(serverDir, name));
    await fs.writeFile(path.join(serverDir, name, "config.txt"), name);
  }
  const response = await local(
    download("first/config.txt", "second/config.txt"),
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const entries = await archiveEntries(response.bytes);
  assert.deepEqual([...entries.keys()].sort(), [
    "first/config.txt",
    "second/config.txt",
  ]);
  assert.equal(entries.get("first/config.txt").toString(), "first");
  assert.equal(entries.get("second/config.txt").toString(), "second");
});

test("downloads reject invalid or missing paths before sending any attachment", async (t) => {
  const { serverDir, local } = await fixture(t);
  await fs.writeFile(path.join(serverDir, "valid.txt"), "inside");
  for (const invalid of [
    "../panel.json",
    "..\\panel.json",
    "/Windows",
    "C:/Windows",
    "world/../../panel.json",
    "world/./data",
    "valid.txt\0",
    "CON",
  ]) {
    for (const route of [download(invalid), download("valid.txt", invalid)]) {
      const response = await local(route);
      assert.equal(
        response.status,
        400,
        `${invalid}: ${JSON.stringify(response.body)}`,
      );
      assert.equal(response.headers["content-disposition"], undefined);
    }
  }
  assert.equal((await local("/api/files/download")).status, 400);
  for (const route of [
    download("missing.txt"),
    download("valid.txt", "missing.txt"),
  ]) {
    const response = await local(route);
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.equal(response.headers["content-disposition"], undefined);
  }
});

test("downloads reject selected junctions and omit nested junctions without exposing outside files", async (t) => {
  const { root, serverDir, local } = await fixture(t);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.mkdir(path.join(serverDir, "folder"));
  await fs.writeFile(
    path.join(outside, "private.txt"),
    "private outside bytes",
  );
  await fs.writeFile(path.join(serverDir, "folder", "valid.txt"), "inside");
  await fs.symlink(
    outside,
    path.join(serverDir, "folder", "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const paths of [
    ["folder/escape"],
    ["folder/escape/private.txt"],
    ["folder/valid.txt", "folder/escape"],
  ]) {
    const response = await local(download(...paths));
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.headers["content-disposition"], undefined);
    assert.equal(
      response.bytes.includes(Buffer.from("private outside bytes")),
      false,
    );
  }
  const folder = await local(download("folder"));
  assert.equal(folder.status, 200, JSON.stringify(folder.body));
  const entries = await archiveEntries(folder.bytes);
  assert.deepEqual([...entries.keys()].sort(), ["folder/", "folder/valid.txt"]);
  assert.equal(entries.get("folder/valid.txt").toString(), "inside");
  assert.equal(
    await fs.readFile(path.join(outside, "private.txt"), "utf8"),
    "private outside bytes",
  );
});

test(
  "aborting an active ZIP stream releases source handles under destination backpressure",
  { timeout: 10000 },
  async (t) => {
    const { serverDir } = await fixture(t);
    const directory = path.join(serverDir, "folder");
    await fs.mkdir(directory);
    const filename = path.join(directory, "large.bin");
    const bytes = randomBytes(8 * 1024 * 1024);
    await fs.writeFile(filename, bytes);
    const plan = await planFileDownload(serverDir, ["folder"], { safePath });
    const blocked = Promise.withResolvers();
    const sourceClosed = Promise.withResolvers();
    let source;
    let sourceHandle;
    let releaseWrite;
    const originalOpen = fs.open;
    const mockedOpen = t.mock.method(fs, "open", async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] !== filename) return handle;
      sourceHandle = handle;
      return {
        stat: () => handle.stat(),
        close: () => handle.close(),
        createReadStream: (options) => {
          source = handle.createReadStream(options);
          source.once("close", sourceClosed.resolve);
          return source;
        },
      };
    });
    const destination = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        if (source?.bytesRead > 0) {
          releaseWrite = callback;
          blocked.resolve();
        } else {
          callback();
        }
      },
    });
    const controller = new AbortController();
    const streaming = streamFileArchive(plan, destination, {
      signal: controller.signal,
    });
    const rejected = assert.rejects(streaming, { name: "AbortError" });
    try {
      await blocked.promise;
      assert.ok(
        source.bytesRead > 0,
        "Cancellation happens after actual file reads start.",
      );
      const started = performance.now();
      controller.abort();
      await rejected;
      await sourceClosed.promise;
      assert.ok(
        performance.now() - started < 2000,
        "Cancellation promptly closes the active source.",
      );
      assert.ok(
        source.bytesRead < bytes.length,
        "Backpressure prevents reading the entire source before cancellation.",
      );
      assert.equal(destination.destroyed, true);
      await assert.rejects(sourceHandle.stat(), { code: "EBADF" });
      const reopened = await originalOpen(filename, "r+");
      try {
        const actual = Buffer.alloc(32);
        await reopened.read(actual, 0, actual.length, 0);
        assert.deepEqual(actual, bytes.subarray(0, actual.length));
      } finally {
        await reopened.close();
      }
      await fs.unlink(filename);
      await assert.rejects(fs.stat(filename), { code: "ENOENT" });
    } finally {
      controller.abort();
      releaseWrite?.();
      mockedOpen.mock.restore();
    }
  },
);

test("ZIP streaming rejects a replaced file after planning before opening its content", async (t) => {
  const { root, serverDir } = await fixture(t);
  const directory = path.join(serverDir, "folder");
  await fs.mkdir(directory);
  const filename = path.join(directory, "content.bin");
  await fs.writeFile(filename, "original content");
  const plan = await planFileDownload(serverDir, ["folder"], { safePath });
  await fs.rename(filename, path.join(root, "original.bin"));
  await fs.writeFile(filename, "replaced content");
  const originalOpen = fs.open;
  let contentOpens = 0;
  const mockedOpen = t.mock.method(fs, "open", (...args) => {
    if (args[0] === filename) contentOpens++;
    return originalOpen(...args);
  });
  const destination = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  try {
    await assert.rejects(streamFileArchive(plan, destination), { status: 409 });
    assert.equal(contentOpens, 0);
    assert.equal(destination.destroyed, true);
  } finally {
    mockedOpen.mock.restore();
  }
});

test("ZIP streaming rejects an ancestor changed into a junction after planning even when file identity is unchanged", async (t) => {
  const { root, serverDir } = await fixture(t);
  const nested = path.join(serverDir, "folder", "nested");
  await fs.mkdir(nested, { recursive: true });
  const filename = path.join(nested, "content.bin");
  await fs.writeFile(filename, "original content");
  const plan = await planFileDownload(serverDir, ["folder"], { safePath });
  const outside = path.join(root, "moved-outside");
  await fs.rename(nested, outside);
  await fs.symlink(
    outside,
    nested,
    process.platform === "win32" ? "junction" : "dir",
  );
  const originalOpen = fs.open;
  let contentOpens = 0;
  const mockedOpen = t.mock.method(fs, "open", (...args) => {
    if (args[0] === filename) contentOpens++;
    return originalOpen(...args);
  });
  const destination = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  try {
    await assert.rejects(streamFileArchive(plan, destination), { status: 409 });
    assert.equal(contentOpens, 0);
    assert.equal(destination.destroyed, true);
  } finally {
    mockedOpen.mock.restore();
  }
});

test("remote downloads require content permission and remain scoped to each granted server", async (t) => {
  const { fleet, id, serverDir, local, guest, invite } = await fixture(t);
  assert.equal(
    (
      await local(
        "/api/access/settings",
        json("PUT", {
          enabled: true,
          publicUrl: origin,
          transport: "proxy",
        }),
      )
    ).status,
    200,
  );
  const created = await local(
    "/api/servers",
    json("POST", { name: "Second", port: 25566 }),
  );
  assert.equal(created.status, 201);
  const secondId = created.body.server.id;
  const secondDir = fleet.runtimes.get(secondId).serverDir;
  await fs.writeFile(
    path.join(serverDir, "proof.bin"),
    Buffer.from([0, 1, 255]),
  );
  await fs.writeFile(
    path.join(secondDir, "proof.bin"),
    Buffer.from([128, 254, 0]),
  );
  await fs.mkdir(path.join(serverDir, "folder"));
  await fs.writeFile(
    path.join(serverDir, "folder", "content.txt"),
    "authorized contents",
  );
  assert.equal((await guest(download("proof.bin"))).status, 401);
  const listing = await invite(["file.read"], "listing@example.test");
  const reader = await invite(["file.read-content"], "reader@example.test");
  for (const paths of [["proof.bin"], ["folder"], ["proof.bin", "folder"]]) {
    assert.equal((await listing.asUser(download(...paths))).status, 403);
    const response = await reader.asUser(download(...paths));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    if (paths.length === 1 && paths[0] === "proof.bin") {
      assert.deepEqual(response.bytes, Buffer.from([0, 1, 255]));
    } else {
      const entries = await archiveEntries(response.bytes);
      assert.equal(
        entries.get("folder/content.txt").toString(),
        "authorized contents",
      );
    }
  }
  assert.equal(
    (await reader.asUser(`${download("proof.bin")}&serverId=${secondId}`))
      .status,
    403,
  );
  assert.equal(
    (
      await reader.asUser(download("proof.bin"), {
        headers: { "X-Server-Id": secondId },
      })
    ).status,
    403,
  );
  const both = await invite(
    ["file.read-content"],
    "reader@example.test",
    secondId,
    reader.cookie,
  );
  for (const [serverId, expected] of [
    [id, [0, 1, 255]],
    [secondId, [128, 254, 0]],
  ]) {
    for (const [route, options] of [
      [`${download("proof.bin")}&serverId=${serverId}`, {}],
      [download("proof.bin"), { headers: { "X-Server-Id": serverId } }],
    ]) {
      const response = await both.asUser(route, options);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.bytes, Buffer.from(expected));
    }
  }
  assert.equal(
    (
      await local(`/api/subusers/${reader.user.id}`, {
        ...json("PATCH", { permissions: ["file.read"] }),
        headers: { "X-Server-Id": id },
      })
    ).status,
    200,
  );
  assert.equal(
    (await both.asUser(`${download("proof.bin")}&serverId=${id}`)).status,
    403,
  );
  assert.equal(
    (await both.asUser(`${download("proof.bin")}&serverId=${secondId}`)).status,
    200,
  );
});
