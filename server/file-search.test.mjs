import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createFileSearch } from "./file-search.mjs";
import { createFleet, safePath } from "./index.mjs";

async function fixture(t, options = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-search-test-")),
  );
  const serverDir = path.join(root, "server");
  await fs.mkdir(serverDir);
  let handles = 0;
  const fileSystem = {
    ...fs,
    async opendir(...args) {
      const handle = await fs.opendir(...args);
      handles++;
      return {
        read: () => handle.read(),
        async close() {
          await handle.close();
          handles--;
        },
      };
    },
  };
  const service = createFileSearch({
    root: serverDir,
    safePath,
    fileSystem,
    pageSize: 2,
    scanSize: 3,
    ...options,
  });
  t.after(async () => {
    await service.close();
    assert.equal(handles, 0, "Search directory handles must be closed");
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-search-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (relative, text = "fixture") => {
    await fs.mkdir(path.dirname(path.join(serverDir, relative)), {
      recursive: true,
    });
    await fs.writeFile(path.join(serverDir, relative), text);
  };
  return { root, serverDir, service, write, handles: () => handles };
}

async function allPages(service, search, relative = "") {
  const entries = [],
    cursors = new Set();
  let cursor,
    pages = 0,
    emptyPages = 0;
  do {
    const result = await service.search({
      path: relative,
      search,
      ...(cursor ? { cursor } : {}),
    });
    assert.equal(result.search, search.trim());
    assert.equal(result.path, relative);
    entries.push(...result.entries);
    pages++;
    if (!result.entries.length) emptyPages++;
    cursor = result.nextCursor;
    if (cursor) {
      assert.ok(!cursors.has(cursor), "Each continuation cursor must be new");
      cursors.add(cursor);
    }
    assert.ok(pages < 1000, "The finite fixture must finish");
  } while (cursor);
  assert.equal(
    new Set(entries.map((entry) => entry.path)).size,
    entries.length,
  );
  return { entries, pages, emptyPages };
}

test("recursive filename search returns every basename match across pages and stays within the current folder", async (t) => {
  const f = await fixture(t);
  const expected = [
    "test-root.txt",
    "mods/Test-mod.jar",
    "mods/nested/TEST.json",
    "other/test.json",
    "Test-folder",
    "Test-folder/test-last.txt",
  ];
  for (const name of expected.filter((name) => name !== "Test-folder"))
    await f.write(name);
  for (let i = 0; i < 10; i++)
    await f.write(`unrelated/${i}.txt`, "test is only in the content");
  const result = await allPages(f.service, "  tEsT  ");
  assert.ok(result.pages > 2);
  assert.ok(
    result.emptyPages > 0,
    "Nonmatching subtrees still continue scanning",
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.path).sort(),
    expected.sort(),
  );
  assert.equal(
    result.entries.find((entry) => entry.path === "Test-folder").type,
    "directory",
  );
  assert.deepEqual(
    (await allPages(f.service, "test", "mods")).entries
      .map((entry) => entry.path)
      .sort(),
    ["mods/Test-mod.jar", "mods/nested/TEST.json"],
  );
  assert.equal(f.handles(), 0);
});

test("search cursors cannot be replayed or reused for another query, folder, or server", async (t) => {
  const f = await fixture(t, { pageSize: 1 });
  const other = await fixture(t);
  for (let i = 0; i < 5; i++) await f.write(`test-${i}.txt`);
  const first = await f.service.search({ search: "test" });
  assert.ok(first.nextCursor);
  await assert.rejects(
    f.service.search({ search: "different", cursor: first.nextCursor }),
    { status: 400 },
  );
  await assert.rejects(
    f.service.search({
      path: "subfolder",
      search: "test",
      cursor: first.nextCursor,
    }),
    { status: 400 },
  );
  await assert.rejects(
    other.service.search({ search: "test", cursor: first.nextCursor }),
    { status: 409 },
  );
  const second = await f.service.search({
    search: "test",
    cursor: first.nextCursor,
  });
  assert.notEqual(first.nextCursor, second.nextCursor);
  await assert.rejects(
    f.service.search({ search: "test", cursor: first.nextCursor }),
    { status: 409 },
  );
  assert.notEqual(first.entries[0].path, second.entries[0].path);
});

test("recursive search omits links and protected siblings and rejects traversal and linked starting folders", async (t) => {
  const f = await fixture(t);
  await f.write("mods/test-inside.jar");
  const outside = path.join(f.root, "private");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "test-secret.json"), "private");
  await fs.symlink(
    outside,
    path.join(f.serverDir, "test-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.deepEqual(
    (await allPages(f.service, "test")).entries.map((entry) => entry.path),
    ["mods/test-inside.jar"],
  );
  for (const relative of [
    "../private",
    "test-link",
    "mods/../../private",
    "mods\\nested",
    "C:/Windows",
    "/outside",
  ])
    await assert.rejects(f.service.search({ path: relative, search: "test" }), {
      status: 400,
    });
});

test("aborting a search page closes its directory and invalidates its continuation", async (t) => {
  const abort = new AbortController();
  let cancelOnCheck = false;
  const f = await fixture(t, {
    pageSize: 1,
    safePath: async (...args) => {
      const result = await safePath(...args);
      if (cancelOnCheck) abort.abort();
      return result;
    },
  });
  for (let i = 0; i < 5; i++) await f.write(`test-${i}.txt`);
  const first = await f.service.search({ search: "test" });
  assert.equal(f.handles(), 1);
  cancelOnCheck = true;
  await assert.rejects(
    f.service.search({
      search: "test",
      cursor: first.nextCursor,
      signal: abort.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(f.handles(), 0);
  await assert.rejects(
    f.service.search({ search: "test", cursor: first.nextCursor }),
    { status: 409 },
  );
});

test("expired and closed searches release handles and active-search limits fail explicitly", async (t) => {
  const f = await fixture(t, {
    pageSize: 1,
    cursorTtlMs: 30,
    maximumActive: 1,
  });
  await f.write("test-one.txt");
  await f.write("test-two.txt");
  const first = await f.service.search({ search: "test" });
  assert.equal(f.handles(), 1);
  await assert.rejects(f.service.search({ search: "test" }), { status: 429 });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(f.handles(), 0);
  await assert.rejects(
    f.service.search({ search: "test", cursor: first.nextCursor }),
    { status: 409 },
  );
  await f.service.search({ search: "test" });
  await f.service.close();
  assert.equal(f.handles(), 0);
  await assert.rejects(f.service.search({ search: "test" }), { status: 503 });
});

test("a directory replaced between search pages fails instead of following the replacement", async (t) => {
  const f = await fixture(t, { pageSize: 1 });
  await f.write("mods/test-one.txt");
  await f.write("mods/test-two.txt");
  const first = await f.service.search({ path: "mods", search: "test" });
  await fs.rename(
    path.join(f.serverDir, "mods"),
    path.join(f.serverDir, "original"),
  );
  await f.write("mods/test-secret.txt");
  await assert.rejects(
    f.service.search({
      path: "mods",
      search: "test",
      cursor: first.nextCursor,
    }),
    { status: 409 },
  );
  assert.equal(f.handles(), 0);
});

async function apiFixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-search-api-")),
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
  const owner = await listen(fleet.app),
    remote = await listen(fleet.remoteApp);
  const request =
    (listener, headers = {}) =>
    (route, options = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${listener.address().port}${route}`,
          {
            method: options.method ?? "GET",
            headers: {
              "Content-Type": "application/json",
              ...headers,
              ...options.headers,
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode, body: JSON.parse(text) });
              } catch (cause) {
                reject(cause);
              }
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end(options.body);
      });
  const local = request(owner);
  const guest = request(remote, {
    Host: "panel.example.test",
    Origin: "https://panel.example.test",
  });
  t.after(async () => {
    await fleet.close();
    for (const listener of [owner, remote]) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-search-api-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const id = (await local("/api/servers")).body.defaultServerId;
  return {
    root,
    fleet,
    base: `http://127.0.0.1:${owner.address().port}`,
    local,
    guest,
    id,
    serverDir: fleet.runtimes.get(id).serverDir,
  };
}
const json = (method, body) => ({ method, body: JSON.stringify(body) });

test("disconnecting a real HTTP search closes its pending directory handle", async (t) => {
  const f = await apiFixture(t);
  await fs.writeFile(path.join(f.serverDir, "test.txt"), "fixture");
  let entered, release, closed;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const finished = new Promise((resolve) => {
    closed = resolve;
  });
  const original = fs.opendir.bind(fs);
  let reads = 0;
  t.mock.method(fs, "opendir", async (...args) => {
    const handle = await original(...args);
    return {
      async read() {
        reads++;
        entered();
        await gate;
        return handle.read();
      },
      async close() {
        await handle.close();
        closed();
      },
    };
  });
  const req = http.get(`${f.base}/api/files?search=test`);
  req.on("error", () => {});
  t.after(() => {
    release();
    req.destroy();
  });
  await started;
  req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await finished;
  assert.equal(reads, 1, "The disconnected scan must not read another entry");
});

test("files API preserves ordinary listing and returns complete recursive search pages with a host capability marker", async (t) => {
  const f = await apiFixture(t);
  await fs.mkdir(path.join(f.serverDir, "mods"));
  for (let i = 0; i < 205; i++)
    await fs.writeFile(path.join(f.serverDir, "mods", `Test-${i}.json`), "{}");
  for (const suffix of ["", "&search=", "&search=%20%20"]) {
    const listing = await f.local(`/api/files?path=${suffix}`);
    assert.equal(listing.status, 200);
    assert.ok(listing.body.entries.some((entry) => entry.path === "mods"));
    assert.ok(
      !listing.body.entries.some((entry) => entry.path.startsWith("mods/")),
    );
    assert.equal(listing.body.search, undefined);
  }
  const paths = [],
    cursors = new Set();
  let cursor;
  do {
    const query = new URLSearchParams({ path: "", search: "test" });
    if (cursor) query.set("cursor", cursor);
    const response = await f.local(`/api/files?${query}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.search, "test");
    paths.push(...response.body.entries.map((entry) => entry.path));
    cursor = response.body.nextCursor;
    if (cursor) {
      assert.ok(!cursors.has(cursor));
      cursors.add(cursor);
    }
  } while (cursor);
  assert.equal(paths.length, 205);
  assert.equal(new Set(paths).size, 205);
  assert.ok(paths.every((name) => name.startsWith("mods/Test-")));
  assert.ok(cursors.size > 0);
  for (const route of [
    "/api/files?search=a&search=b",
    `/api/files?search=${"a".repeat(257)}`,
    "/api/files?search=%00",
    "/api/files?path=../&search=test",
    "/api/files?path=mods/Test-0.json&search=test",
  ])
    assert.equal((await f.local(route)).status, 400, route);
});

test("recursive file search enforces listing permission, selected-server access and live permission revocation", async (t) => {
  const f = await apiFixture(t);
  assert.equal(
    (
      await f.local(
        "/api/access/settings",
        json("PUT", {
          enabled: true,
          publicUrl: "https://panel.example.test",
          transport: "proxy",
        }),
      )
    ).status,
    200,
  );
  await fs.mkdir(path.join(f.serverDir, "mods"));
  await fs.writeFile(path.join(f.serverDir, "mods", "test.json"), "{}");
  assert.equal((await f.guest("/api/files?search=test")).status, 401);
  const user = await f.local(
    "/api/subusers",
    json("POST", {
      email: "search@example.test",
      permissions: ["server.view"],
    }),
  );
  assert.equal(user.status, 201, JSON.stringify(user.body));
  const invite = await f.local(`/api/subusers/${user.body.id}/invite`, {
    method: "POST",
  });
  const accepted = await f.guest(
    "/api/access/accept",
    json("POST", {
      token: new URL(invite.body.invitationUrl).hash.slice(8),
      password: "Search-fixture-password!",
    }),
  );
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const signed = (route) =>
    f.guest(route, {
      headers: { Authorization: `Bearer ${accepted.body.sessionToken}` },
    });
  assert.equal((await signed("/api/files?search=test")).status, 403);
  assert.equal(
    (
      await f.local(
        `/api/subusers/${user.body.id}`,
        json("PATCH", { permissions: ["server.view", "file.read"] }),
      )
    ).status,
    200,
  );
  const allowed = await signed("/api/files?search=test");
  assert.equal(allowed.status, 200);
  assert.deepEqual(
    allowed.body.entries.map((entry) => entry.path),
    ["mods/test.json"],
  );
  assert.equal(
    (await signed("/api/files/content?path=mods/test.json")).status,
    403,
    "Listing does not grant content read",
  );
  const second = await f.local(
    "/api/servers",
    json("POST", { name: "Other server", port: 25566 }),
  );
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(
    (await signed(`/api/files?search=test&serverId=${second.body.server.id}`))
      .status,
    403,
  );
  for (let i = 0; i < 205; i++)
    await fs.writeFile(
      path.join(f.serverDir, "mods", `test-${i}.txt`),
      "fixture",
    );
  const firstPage = await signed("/api/files?search=test");
  assert.equal(firstPage.status, 200);
  assert.ok(firstPage.body.nextCursor);
  assert.equal(
    (
      await f.local(
        `/api/subusers/${user.body.id}`,
        json("PATCH", { permissions: ["server.view"] }),
      )
    ).status,
    200,
  );
  assert.equal((await signed("/api/files?search=test")).status, 403);
  assert.equal(
    (await signed(`/api/files?search=test&cursor=${firstPage.body.nextCursor}`))
      .status,
    403,
    "Each continuation rechecks current permission",
  );
});
