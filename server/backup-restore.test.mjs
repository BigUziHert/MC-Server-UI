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
import { randomUUID } from "node:crypto";

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
    // Backups restored through the API must match retained startup settings.
    await fs.writeFile(path.join(serverDir, "server.jar"), "fixture runtime");
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

test("restore confirmation receipts survive restart and never replace later edits on replay", async (t) => {
  const { serverDir, boot } = await fixture(t);
  const panel = await boot();
  const backup = (
    await panel.request("/api/backups", { name: "Receipt fixture" })
  ).body;
  const route = `/api/backups/${backup.id}/restore`;
  const input = { confirm: true, requestId: randomUUID() };
  const first = await panel.request(route, input);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await fs.writeFile(path.join(serverDir, "later.txt"), "preserve later edits");
  assert.deepEqual(await panel.request(route, input), first);
  await panel.close();
  const restarted = await boot();
  assert.deepEqual(await restarted.request(route, input), first);
  assert.equal(
    await fs.readFile(path.join(serverDir, "later.txt"), "utf8"),
    "preserve later edits",
  );
  assert.equal(
    (await restarted.request(`/api/backups/${randomUUID()}/restore`, input))
      .status,
    409,
  );
  assert.equal(
    (await restarted.request(route, { ...input, requestId: randomUUID() }))
      .status,
    200,
  );
  await assert.rejects(fs.stat(path.join(serverDir, "later.txt")), {
    code: "ENOENT",
  });
});

test("an incompatible backup never replaces files or the retained JAR and loader launch settings", async (t) => {
  const { serverDir, boot } = await fixture(t);
  const panel = await boot();
  const backup = (
    await panel.request("/api/backups", { name: "Before runtime change" })
  ).body;
  await fs.writeFile(
    path.join(serverDir, "replacement.jar"),
    "keep current runtime",
  );
  await fs.writeFile(path.join(serverDir, "later.txt"), "keep later world");
  await panel.updateConfiguration({
    ...panel.descriptor(),
    jar: "replacement.jar",
  });
  let result = await panel.request(`/api/backups/${backup.id}/restore`, {
    confirm: true,
    requestId: randomUUID(),
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.match(result.body.error, /incompatible.*retained launch settings/);
  assert.equal(
    await fs.readFile(path.join(serverDir, "replacement.jar"), "utf8"),
    "keep current runtime",
  );
  assert.equal(panel.descriptor().jar, "replacement.jar");
  await fs.writeFile(
    path.join(serverDir, "new_args.txt"),
    "-jar replacement.jar\n",
  );
  await panel.updateConfiguration({
    ...panel.descriptor(),
    launchType: "java-args",
    launchArgs: ["@new_args.txt"],
  });
  result = await panel.request(`/api/backups/${backup.id}/restore`, {
    confirm: true,
    requestId: randomUUID(),
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(
    await fs.readFile(path.join(serverDir, "later.txt"), "utf8"),
    "keep later world",
  );
  assert.deepEqual(panel.descriptor().launchArgs, ["@new_args.txt"]);
});

test("restore validates retained absolute and relative bundled binaries without requiring external executables in the archive", async (t) => {
  const { serverDir, boot } = await fixture(t);
  const panel = await boot();
  const original = panel.descriptor();
  const backup = (
    await panel.request("/api/backups", { name: "Before bundled runtime" })
  ).body;
  const binary = path.join(serverDir, "runtime", "bin", "runner.exe");
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, "bundled binary; never executed");
  await fs.writeFile(
    path.join(serverDir, "bundled.exe"),
    "local executable; never executed",
  );
  await fs.writeFile(
    path.join(serverDir, "java.exe"),
    "local Java; never executed",
  );
  await fs.writeFile(path.join(serverDir, "later.txt"), "preserve later edits");
  const route = `/api/backups/${backup.id}/restore`;
  for (const config of [
    { launchType: "executable", launchExecutable: binary },
    { launchType: "executable", launchExecutable: "./runtime/bin/runner.exe" },
    { launchType: "jar", jar: "server.jar", javaPath: binary },
    {
      launchType: "java-args",
      launchArgs: ["-jar", "server.jar"],
      javaPath: "./runtime/bin/runner.exe",
    },
    ...(process.platform === "win32" &&
    process.env.NoDefaultCurrentDirectoryInExePath === undefined
      ? [
          { launchType: "executable", launchExecutable: "bundled.exe" },
          { launchType: "executable", launchExecutable: "bundled" },
          { launchType: "jar", jar: "server.jar", javaPath: "java" },
        ]
      : []),
  ]) {
    await panel.updateConfiguration({ ...original, ...config });
    const result = await panel.request(route, {
      confirm: true,
      requestId: randomUUID(),
    });
    assert.equal(result.status, 409, JSON.stringify({ config, result }));
    assert.match(result.body.error, /incompatible.*retained launch settings/);
    assert.equal(
      await fs.readFile(binary, "utf8"),
      "bundled binary; never executed",
    );
    assert.equal(
      await fs.readFile(path.join(serverDir, "later.txt"), "utf8"),
      "preserve later edits",
    );
  }
  const compatible = (
    await panel.request("/api/backups", { name: "With bundled runtime" })
  ).body;
  await panel.updateConfiguration({
    ...original,
    launchType: "executable",
    launchExecutable: binary,
  });
  const restored = await panel.request(
    `/api/backups/${compatible.id}/restore`,
    { confirm: true, requestId: randomUUID() },
  );
  assert.equal(restored.status, 200, JSON.stringify(restored));
  assert.equal(panel.descriptor().launchExecutable, binary);
  assert.equal(
    await fs.readFile(binary, "utf8"),
    "bundled binary; never executed",
  );

  // Absolute paths outside this server tree stay host settings. They need not
  // be bundled into a server backup (and are never executed by this test).
  for (const config of [
    { launchType: "executable", launchExecutable: process.execPath },
    { launchType: "jar", jar: "server.jar", javaPath: process.execPath },
  ]) {
    await panel.updateConfiguration({ ...original, ...config });
    const result = await panel.request(route, {
      confirm: true,
      requestId: randomUUID(),
    });
    assert.equal(result.status, 200, JSON.stringify(result));
  }
});

test("schedule revisions reject a concurrent stale save without disabling the newer schedule", async (t) => {
  const { boot } = await fixture(t);
  const panel = await boot();
  const baseline = (await panel.request("/api/backups")).body.schedule;
  assert.match(baseline.revision, /^[a-f0-9]{64}$/);
  const [first, second] = await Promise.all([
    panel.request(
      "/api/backups/schedule",
      { ...baseline, enabled: true, intervalHours: 12 },
      "PUT",
    ),
    panel.request(
      "/api/backups/schedule",
      { ...baseline, retention: 19 },
      "PUT",
    ),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const current = (await panel.request("/api/backups")).body.schedule;
  assert.equal(current.enabled, first.status === 200 ? true : baseline.enabled);
  assert.equal(
    current.intervalHours,
    first.status === 200 ? 12 : baseline.intervalHours,
  );
  assert.equal(
    current.retention,
    first.status === 200 ? baseline.retention : 19,
  );
  assert.notEqual(current.revision, baseline.revision);
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

for (const cleanupWarning of [false, true]) {
  test(`restored folders support deletion and existing recovery immediately${cleanupWarning ? " after a cleanup warning" : " across repeated restores"}`, async (t) => {
    const { serverDir, boot } = await fixture(t);
    const panel = await boot();
    await fs.writeFile(
      path.join(serverDir, "older.txt"),
      "older recovery bytes",
    );
    const older = await panel.request(
      "/api/files?path=older.txt",
      {},
      "DELETE",
    );
    assert.equal(older.status, 200, JSON.stringify(older));
    await fs.writeFile(path.join(serverDir, "world.dat"), "saved world");
    const backup = await panel.request("/api/backups", {
      name: "Recycle after restore",
    });
    assert.equal(backup.status, 201, JSON.stringify(backup));
    if (cleanupWarning) {
      const remove = fs.rmdir.bind(fs);
      t.mock.method(fs, "rmdir", async (target, options) => {
        if (path.basename(target).startsWith(".external-server-restore-"))
          throw Object.assign(new Error("Fixture cleanup busy"), {
            code: "EBUSY",
          });
        return remove(target, options);
      });
    }
    for (let iteration = 0; iteration < (cleanupWarning ? 1 : 2); iteration++) {
      const restored = await panel.request(
        `/api/backups/${backup.body.id}/restore`,
        {
          confirm: true,
          requestId: randomUUID(),
        },
      );
      assert.equal(restored.status, 200, JSON.stringify(restored));
      assert.equal("restoredRoot" in restored.body, false);
      assert.equal("ino" in restored.body, false);
      if (cleanupWarning)
        assert.match(restored.body.warning, /temporary restore files/);
      const deleted = await panel.request(
        "/api/files?path=world.dat",
        {},
        "DELETE",
      );
      assert.equal(deleted.status, 200, JSON.stringify(deleted));
      const recovered = await panel.request(
        `/api/files/recycle-bin/${deleted.body.recycled.id}/restore`,
        {},
      );
      assert.equal(recovered.status, 200, JSON.stringify(recovered));
      assert.equal(
        await fs.readFile(path.join(serverDir, "world.dat"), "utf8"),
        "saved world",
      );
    }
    const recovered = await panel.request(
      `/api/files/recycle-bin/${older.body.recycled.id}/restore`,
      {},
    );
    assert.equal(recovered.status, 200, JSON.stringify(recovered));
    assert.equal(
      await fs.readFile(path.join(serverDir, "older.txt"), "utf8"),
      "older recovery bytes",
    );
    t.mock.restoreAll();
  });
}

test("a rolled-back backup replacement keeps the original Recycle Bin root usable", async (t) => {
  const { serverDir, boot } = await fixture(t);
  const panel = await boot();
  await fs.writeFile(path.join(serverDir, "world.dat"), "saved world");
  const backup = await panel.request("/api/backups", {
    name: "Rollback binding",
  });
  await fs.writeFile(path.join(serverDir, "world.dat"), "current world");
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (source, target) => {
    if (path.basename(source) === "restored" && target === serverDir)
      throw new Error("Fixture replacement denied");
    return rename(source, target);
  });
  const result = await panel.request(`/api/backups/${backup.body.id}/restore`, {
    confirm: true,
  });
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.match(result.body.error, /original files were restored/);
  const deleted = await panel.request(
    "/api/files?path=world.dat",
    {},
    "DELETE",
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted));
  const recovered = await panel.request(
    `/api/files/recycle-bin/${deleted.body.recycled.id}/restore`,
    {},
  );
  assert.equal(recovered.status, 200, JSON.stringify(recovered));
  assert.equal(
    await fs.readFile(path.join(serverDir, "world.dat"), "utf8"),
    "current world",
  );
});

for (const replacementTime of ["before restore", "after promotion"]) {
  test(`restore does not adopt an externally substituted folder ${replacementTime}`, async (t) => {
    const { serverDir, directory, boot } = await fixture(t);
    const panel = await boot();
    await fs.writeFile(path.join(serverDir, "world.dat"), "saved world");
    const backup = await panel.request("/api/backups", {
      name: "Root identity",
    });
    const parked = path.join(directory, "parked-server");
    const substitute = async () => {
      await fs.rename(serverDir, parked);
      await fs.mkdir(serverDir);
      await fs.writeFile(
        path.join(serverDir, "other.txt"),
        "untouched replacement",
      );
    };
    if (replacementTime === "before restore") await substitute();
    else {
      const remove = fs.rmdir.bind(fs);
      let replaced = false;
      t.mock.method(fs, "rmdir", async (target, options) => {
        const result = await remove(target, options);
        if (
          !replaced &&
          path.basename(target).startsWith(".external-server-restore-")
        ) {
          replaced = true;
          await substitute();
        }
        return result;
      });
    }
    const result = await panel.request(
      `/api/backups/${backup.body.id}/restore`,
      { confirm: true },
    );
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.match(result.body.error, /server folder changed/i);
    const deleted = await panel.request(
      "/api/files?path=other.txt",
      {},
      "DELETE",
    );
    assert.equal(deleted.status, 409, JSON.stringify(deleted));
    assert.equal(
      await fs.readFile(path.join(serverDir, "other.txt"), "utf8"),
      "untouched replacement",
    );
    assert.equal(
      await fs.readFile(path.join(parked, "world.dat"), "utf8"),
      "saved world",
    );
    t.mock.restoreAll();
  });
}
