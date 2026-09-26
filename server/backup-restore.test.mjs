import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { Header, c as createTar } from "tar";
import { restoreBackupArchive } from "./backup-restore.mjs";
import { createBackupArchive } from "./backup-archive.mjs";
import { createPanel } from "./index.mjs";
import { requiredPermissions } from "./remote-access.mjs";

async function fixture(t) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-backup-restore-")),
  );
  const serverDir = path.join(directory, "external-server");
  const archive = path.join(directory, "backup.tar.gz");
  await fs.mkdir(serverDir);
  const closes = [];
  t.after(async () => {
    for (const close of closes) await close();
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("mc-backup-restore-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const boot = async () => {
    const panel = await createPanel({
      dataDir: path.join(directory, "panel-data"),
      serverDir,
      existingServerDir: true,
      scheduler: false,
      publicAddress: { resolve: async () => null },
    });
    const listener = await new Promise((resolve) => {
      const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
    });
    closes.push(async () => {
      try {
        await panel.close();
      } finally {
        listener.closeAllConnections();
        await new Promise((resolve) => listener.close(resolve));
      }
    });
    const request = async (route, body, method = "POST") => {
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}${route}`,
        {
          method: body === undefined ? "GET" : method,
          headers: { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    return { ...panel, request };
  };
  return { directory, serverDir, archive, boot };
}

async function rawArchive(file, entries) {
  const chunks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const header = new Header({
      path: entry.path,
      type: entry.type ?? "File",
      mode: 0o644,
      size: content.length,
      linkpath: entry.linkpath,
    });
    header.encode();
    chunks.push(header.block, content);
    if (content.length % 512)
      chunks.push(Buffer.alloc(512 - (content.length % 512)));
  }
  chunks.push(Buffer.alloc(1024));
  await fs.writeFile(file, gzipSync(Buffer.concat(chunks)));
}

async function holdWindowsFile(t, file) {
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$handle = [IO.File]::Open($env:MC_RESTORE_LOCK_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $handle.Dispose()",
    ],
    {
      windowsHide: true,
      env: { ...process.env, MC_RESTORE_LOCK_PATH: file },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const release = async () => {
    if (!child.stdin.writableEnded) child.stdin.end("\n");
    await closed;
  };
  t.after(release);
  await new Promise((resolve, reject) => {
    child.stdout.once("data", (chunk) => {
      if (chunk.toString().includes("locked")) resolve();
      else reject(new Error(`Native file lock failed: ${chunk}`));
    });
    child.once("error", reject);
    child.once("close", (code) =>
      reject(new Error(`Native file lock exited ${code}: ${stderr}`)),
    );
  });
  return release;
}

test("restore replaces the exact tree on an external drive and retains the downloadable archive", async (t) => {
  const { serverDir, directory, boot } = await fixture(t);
  const panel = await boot();
  await fs.mkdir(path.join(serverDir, "world", "empty"), { recursive: true });
  await fs.writeFile(path.join(serverDir, "world", "level.dat"), "saved world");
  await fs.writeFile(
    path.join(serverDir, "server.properties"),
    "motd=Saved server\n",
  );
  const backup = await panel.request("/api/backups", { name: "Restore point" });
  assert.equal(backup.status, 201, JSON.stringify(backup.body));
  const archive = path.join(
    directory,
    "panel-data",
    "backups",
    `${backup.body.id}.tar.gz`,
  );
  const savedArchive = await fs.readFile(archive);
  await fs.writeFile(
    path.join(serverDir, "world", "level.dat"),
    "later progress",
  );
  await fs.mkdir(path.join(serverDir, "mods"));
  await fs.writeFile(path.join(serverDir, "mods", "new-mod.jar"), "new mod");
  const route = `/api/backups/${backup.body.id}/restore`;
  assert.equal((await panel.request(route, {})).status, 400);
  assert.equal(
    await fs.readFile(path.join(serverDir, "world", "level.dat"), "utf8"),
    "later progress",
  );
  const restored = await panel.request(route, { confirm: true });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.backupId, backup.body.id);
  assert.equal(
    await fs.readFile(path.join(serverDir, "world", "level.dat"), "utf8"),
    "saved world",
  );
  assert.equal(
    await fs.readFile(path.join(serverDir, "server.properties"), "utf8"),
    "motd=Saved server\n",
  );
  assert.equal(
    (await fs.stat(path.join(serverDir, "world", "empty"))).isDirectory(),
    true,
  );
  await assert.rejects(fs.stat(path.join(serverDir, "mods")), {
    code: "ENOENT",
  });
  assert.deepEqual(await fs.readFile(archive), savedArchive);
  assert.equal((await panel.request("/api/backups")).body.backups.length, 1);
  assert.equal((await panel.request("/api/server")).body.status, "offline");
  assert.equal(
    (await panel.request("/api/audit")).body.entries.some(
      (item) => item.action === "Backup restored",
    ),
    true,
  );
  assert.equal(
    (await fs.readdir(directory)).some((item) => item.includes("-restore-")),
    false,
  );
});

test("legacy tar backups and executable scripts remain restorable", async (t) => {
  const { serverDir, archive } = await fixture(t);
  const script = path.join(serverDir, "start.sh");
  await fs.writeFile(script, "#!/bin/sh\njava -jar server.jar\n", {
    mode: 0o755,
  });
  await createTar({ cwd: serverDir, file: archive, gzip: true }, ["."]);
  await fs.writeFile(script, "changed");
  await restoreBackupArchive(serverDir, archive);
  assert.match(await fs.readFile(script, "utf8"), /java -jar server.jar/);
  if (process.platform !== "win32")
    assert.equal((await fs.stat(script)).mode & 0o111, 0o111);
});

test("unsafe, linked, duplicate, malformed and truncated archives never change live files", async (t) => {
  const { serverDir, directory, archive } = await fixture(t);
  const original = path.join(serverDir, "current.txt");
  await fs.writeFile(original, "keep current");
  const variants = [
    [{ path: "../escaped.txt", content: "bad" }],
    [{ path: "/absolute.txt", content: "bad" }],
    [{ path: "C:/escaped.txt", content: "bad" }],
    [{ path: "world\\..\\escaped.txt", content: "bad" }],
    [{ path: "world:stream", content: "bad" }],
    [{ path: "world", type: "SymbolicLink", linkpath: "../outside" }],
    [{ path: "world", type: "Link", linkpath: "../outside" }],
    [{ path: "world", type: "FIFO" }],
    [
      { path: "world/level.dat", content: "first" },
      { path: "WORLD/LEVEL.DAT", content: "second" },
    ],
    [
      { path: "world/level.dat", content: "first" },
      { path: "world", content: "file over directory" },
    ],
    [
      { path: "world", content: "file" },
      { path: "world/level.dat", content: "bad child" },
    ],
  ];
  for (const entries of variants) {
    await rawArchive(archive, entries);
    await assert.rejects(restoreBackupArchive(serverDir, archive), {
      status: 400,
    });
    assert.equal(await fs.readFile(original, "utf8"), "keep current");
    assert.deepEqual(await fs.readdir(serverDir), ["current.txt"]);
  }
  await fs.writeFile(archive, "not an archive");
  await assert.rejects(restoreBackupArchive(serverDir, archive), {
    status: 400,
  });
  await createBackupArchive(serverDir, archive + ".valid");
  const bytes = await fs.readFile(archive + ".valid");
  await fs.writeFile(archive, bytes.subarray(0, bytes.length - 16));
  await assert.rejects(restoreBackupArchive(serverDir, archive), {
    status: 400,
  });
  assert.equal(await fs.readFile(original, "utf8"), "keep current");
  await assert.rejects(fs.stat(path.join(directory, "escaped.txt")), {
    code: "ENOENT",
  });
});

test("a failed replacement rolls the original server tree back", async (t) => {
  const { serverDir, archive, directory } = await fixture(t);
  const file = path.join(serverDir, "world.dat");
  await fs.writeFile(file, "backup world");
  await createBackupArchive(serverDir, archive);
  await fs.writeFile(file, "current world");
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (source, target) => {
    if (path.basename(source) === "restored" && target === serverDir)
      throw Object.assign(new Error("Fixture replacement denied"), {
        code: "EPERM",
      });
    return rename(source, target);
  });
  await assert.rejects(
    restoreBackupArchive(serverDir, archive),
    /original files were restored/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "current world");
  assert.equal(
    (await fs.readdir(directory)).some((item) => item.includes("-restore-")),
    false,
  );
});

test(
  "a transient native Windows sharing lock is retried before committing the restored tree",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { serverDir, archive } = await fixture(t);
    const file = path.join(serverDir, "server.jar");
    await fs.writeFile(file, "saved server files");
    await createBackupArchive(serverDir, archive);
    await fs.writeFile(file, "current server files");
    const rename = fs.rename.bind(fs);
    let release;
    let lockedFailures = 0;
    t.mock.method(fs, "rename", async (source, target) => {
      if (path.basename(source) === "restored" && target === serverDir) {
        release ??= await holdWindowsFile(t, path.join(source, "server.jar"));
        try {
          return await rename(source, target);
        } catch (cause) {
          assert.equal(cause.code, "EPERM");
          if (++lockedFailures === 2) setTimeout(() => void release(), 25);
          throw cause;
        }
      }
      return rename(source, target);
    });
    const result = await restoreBackupArchive(serverDir, archive);
    assert.equal(result.warning, null);
    assert.ok(
      lockedFailures >= 2,
      "The real Windows lock must survive at least one retry.",
    );
    assert.equal(await fs.readFile(file, "utf8"), "saved server files");
    await release();
  },
);

test(
  "a persistent native Windows sharing lock exhausts a bounded retry and restores the originals",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { serverDir, archive, directory } = await fixture(t);
    const file = path.join(serverDir, "server.jar");
    await fs.writeFile(file, "saved server files");
    await createBackupArchive(serverDir, archive);
    await fs.writeFile(file, "original server files");
    const rename = fs.rename.bind(fs);
    let release;
    let failures = 0;
    t.mock.method(fs, "rename", async (source, target) => {
      if (path.basename(source) === "restored" && target === serverDir) {
        release ??= await holdWindowsFile(t, path.join(source, "server.jar"));
        try {
          return await rename(source, target);
        } catch (cause) {
          failures++;
          throw cause;
        }
      }
      // The actual Windows lock remained held through every replacement retry.
      // Release only once rollback begins, allowing temporary files to be cleaned.
      if (path.basename(source) === "previous") await release();
      return rename(source, target);
    });
    await assert.rejects(
      restoreBackupArchive(serverDir, archive),
      /original files were restored/,
    );
    assert.ok(
      failures > 1 && failures <= 10,
      "Sharing violations must retry, then stop.",
    );
    assert.equal(await fs.readFile(file, "utf8"), "original server files");
    assert.equal(
      (await fs.readdir(directory)).some((name) => name.includes("-restore-")),
      false,
    );
  },
);

test(
  "retry never overwrites a destination another application created",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { serverDir, archive, directory } = await fixture(t);
    await fs.writeFile(path.join(serverDir, "world.dat"), "saved world");
    await createBackupArchive(serverDir, archive);
    await fs.writeFile(path.join(serverDir, "world.dat"), "original world");
    const rename = fs.rename.bind(fs);
    t.mock.method(fs, "rename", async (source, target) => {
      if (path.basename(source) === "restored" && target === serverDir) {
        await fs.mkdir(serverDir);
        await fs.writeFile(
          path.join(serverDir, "other-application.txt"),
          "keep",
        );
        throw Object.assign(new Error("Fixture sharing violation"), {
          code: "EPERM",
        });
      }
      return rename(source, target);
    });
    await assert.rejects(
      restoreBackupArchive(serverDir, archive),
      /original server files are preserved at/,
    );
    assert.equal(
      await fs.readFile(path.join(serverDir, "other-application.txt"), "utf8"),
      "keep",
    );
    const workspace = (await fs.readdir(directory)).find((name) =>
      name.includes("-restore-"),
    );
    assert.equal(
      await fs.readFile(
        path.join(directory, workspace, "previous", "world.dat"),
        "utf8",
      ),
      "original world",
    );
  },
);

test("a cleanup sharing error keeps the original actionable restore failure", async (t) => {
  const { serverDir, archive } = await fixture(t);
  const file = path.join(serverDir, "world.dat");
  await fs.writeFile(file, "saved world");
  await createBackupArchive(serverDir, archive);
  await fs.writeFile(file, "original world");
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (source, target) => {
    if (path.basename(source) === "restored" && target === serverDir)
      throw new Error("Fixture replacement blocked");
    return rename(source, target);
  });
  t.mock.method(fs, "rm", async () => {
    throw Object.assign(new Error("Fixture cleanup blocked"), {
      code: "EBUSY",
    });
  });
  await assert.rejects(restoreBackupArchive(serverDir, archive), (cause) => {
    assert.equal(cause.status, 409);
    assert.match(cause.message, /original files were restored/);
    assert.match(cause.message, /Fixture replacement blocked/);
    assert.match(cause.message, /Temporary restore files remain at/);
    return true;
  });
  assert.equal(await fs.readFile(file, "utf8"), "original world");
  t.mock.restoreAll();
});

test("insufficient space on the server drive leaves current files and backup untouched", async (t) => {
  const { serverDir, archive } = await fixture(t);
  const file = path.join(serverDir, "world.dat");
  await fs.writeFile(file, "saved world");
  await createBackupArchive(serverDir, archive);
  const bytes = await fs.readFile(archive);
  await fs.writeFile(file, "current world");
  t.mock.method(fs, "statfs", async () => ({ bavail: 0, bsize: 4096 }));
  await assert.rejects(
    restoreBackupArchive(serverDir, archive),
    /not enough free space/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "current world");
  assert.deepEqual(await fs.readFile(archive), bytes);
});

test("failed rollback preserves and identifies the original tree instead of deleting it", async (t) => {
  const { serverDir, archive, directory } = await fixture(t);
  await fs.writeFile(path.join(serverDir, "world.dat"), "saved world");
  await createBackupArchive(serverDir, archive);
  await fs.writeFile(path.join(serverDir, "world.dat"), "original world");
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (source, target) => {
    if (target === serverDir) throw new Error("Fixture target inaccessible");
    return rename(source, target);
  });
  await assert.rejects(
    restoreBackupArchive(serverDir, archive),
    /original server files are preserved at/,
  );
  const saved = (await fs.readdir(directory)).find((item) =>
    item.includes("-restore-"),
  );
  assert.ok(saved);
  assert.equal(
    await fs.readFile(
      path.join(directory, saved, "previous", "world.dat"),
      "utf8",
    ),
    "original world",
  );
});

test("restore retains its operation lock and rejects concurrent writes, backups, and power actions", async (t) => {
  const { serverDir, boot } = await fixture(t);
  const panel = await boot();
  await fs.writeFile(path.join(serverDir, "world.dat"), "world");
  const backup = (await panel.request("/api/backups", { name: "Lock fixture" }))
    .body;
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  const copy = fs.copyFile.bind(fs);
  t.mock.method(fs, "copyFile", async (source, target, ...args) => {
    if (path.basename(target) === "backup.tar.gz") {
      reached.resolve();
      await release.promise;
    }
    return copy(source, target, ...args);
  });
  const pending = panel.request(`/api/backups/${backup.id}/restore`, {
    confirm: true,
  });
  await reached.promise;
  try {
    for (const [route, body] of [
      ["/api/files", { name: "blocked.txt", type: "file" }],
      ["/api/backups", { name: "Concurrent backup" }],
      ["/api/server/power", { action: "start" }],
      [`/api/backups/${backup.id}/restore`, { confirm: true }],
    ])
      assert.equal((await panel.request(route, body)).status, 409, route);
    assert.equal(
      (await panel.request(`/api/backups/${backup.id}`, {}, "DELETE")).status,
      409,
    );
  } finally {
    release.resolve();
  }
  assert.equal((await pending).status, 200);
  assert.equal(
    (await panel.request("/api/files", { name: "allowed.txt", type: "file" }))
      .status,
    201,
  );
});

test("restore reports success with a warning when the activity log cannot be persisted", async (t) => {
  const { serverDir, boot } = await fixture(t);
  const panel = await boot();
  await fs.writeFile(path.join(serverDir, "world.dat"), "saved world");
  const backup = (
    await panel.request("/api/backups", { name: "Audit fixture" })
  ).body;
  await fs.writeFile(path.join(serverDir, "world.dat"), "later world");
  const write = fs.writeFile.bind(fs);
  t.mock.method(fs, "writeFile", async (target, ...args) => {
    if (String(target).includes("panel.json"))
      throw new Error("Fixture audit unavailable");
    return write(target, ...args);
  });
  const result = await panel.request(`/api/backups/${backup.id}/restore`, {
    confirm: true,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(result.body.warning, /restored.*activity log/i);
  assert.equal(
    await fs.readFile(path.join(serverDir, "world.dat"), "utf8"),
    "saved world",
  );
  t.mock.restoreAll();
  assert.equal(
    (await panel.request("/api/backups", { name: "After audit repair" }))
      .status,
    201,
  );
});

test("remote restore requires its explicit destructive-action permission", () => {
  assert.deepEqual(
    requiredPermissions({
      method: "POST",
      path: "/api/backups/backup-id/restore",
      query: {},
    }),
    ["backup.restore"],
  );
});
