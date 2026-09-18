import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanInstall, prepareCleanSettings } from "./clean-install.mjs";
import { createRecycleBin } from "./recycle-bin.mjs";
import { safePath } from "./index.mjs";

async function fixture(t, recycleOptions = {}) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(temporary, "mc-clean-install-test-")),
  );
  const dataDir = path.join(root, "panel");
  const serverDir = path.join(root, "server");
  const stageDir = path.join(root, "stage");
  await Promise.all([dataDir, serverDir, stageDir].map((dir) => fs.mkdir(dir)));
  t.after(async () => {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-clean-install-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const bin = await createRecycleBin({
    dataDir,
    serverDir,
    safePath,
    ...recycleOptions,
  });
  const configuration = { port: 25577, memoryLimitMB: 6144, maxPlayers: 12 };
  const ctx = {
    dataDir,
    serverDir,
    safePath,
    getConfiguration: () => configuration,
    recycle: (relative) => bin.recycle(relative),
    restore: (id) => bin.restore(id),
    commit: async () => {},
  };
  const result = { stageDir, configuration: { launchType: "jar" }, files: [] };
  async function put(directory, relative, content) {
    const target = path.join(directory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  async function stage(relative, content) {
    await put(stageDir, relative, content);
    result.files.push({ path: relative });
  }
  return { root, dataDir, serverDir, stageDir, bin, ctx, result, put, stage };
}

test("clean install replaces the entire selected server and keeps all previous files in recovery", async (t) => {
  const f = await fixture(t);
  await f.put(f.serverDir, "server.jar", "previous runtime");
  await f.put(f.serverDir, "world/region/r.0.0.mca", "previous world");
  await f.put(f.serverDir, "mods/old.jar", "previous mod");
  await f.put(f.root, "sibling/untouched.txt", "outside server");
  const binary = Buffer.alloc(600_000, 173);
  await f.stage("server.jar", binary);
  await f.stage("mods/new.jar", "new mod");
  await f.stage("config/new.toml", "setting=true");
  let committed = false;
  const recovery = await cleanInstall(f.result, {
    ...f.ctx,
    commit: async () => {
      committed = true;
    },
  });
  assert.equal(committed, true);
  assert.deepEqual(
    await fs.readFile(path.join(f.serverDir, "server.jar")),
    binary,
  );
  assert.deepEqual((await fs.readdir(f.serverDir)).sort(), [
    "config",
    "mods",
    "server.jar",
  ]);
  assert.deepEqual(await fs.readdir(path.join(f.serverDir, "mods")), [
    "new.jar",
  ]);
  assert.equal(
    await fs.readFile(path.join(f.root, "sibling/untouched.txt"), "utf8"),
    "outside server",
  );
  assert.equal(recovery.recoveryEntries.length, 3);
  const items = await f.bin.list();
  assert.deepEqual(items.map((item) => item.originalPath).sort(), [
    "mods",
    "server.jar",
    "world",
  ]);
  const world = items.find((item) => item.originalPath === "world");
  await f.bin.restore(world.id);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "world/region/r.0.0.mca"), "utf8"),
    "previous world",
  );
});

test("failed configuration commit restores the previous tree and invokes configuration rollback", async (t) => {
  const f = await fixture(t);
  await f.put(f.serverDir, "server.jar", "original server");
  await f.put(f.serverDir, "config/original.toml", "original setting");
  await f.stage("server.jar", "replacement");
  await f.stage("config/new.toml", "new setting");
  let rolledBack = false;
  await assert.rejects(
    cleanInstall(f.result, {
      ...f.ctx,
      commit: async () => {
        throw new Error("fixture configuration write failed");
      },
      rollback: async () => {
        rolledBack = true;
      },
    }),
    /configuration write failed.*Previous server files were restored/,
  );
  assert.equal(rolledBack, true);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "server.jar"), "utf8"),
    "original server",
  );
  assert.deepEqual(await fs.readdir(path.join(f.serverDir, "config")), [
    "original.toml",
  ]);
});

test("external files created while originals are recycled remain untouched on rollback", async (t) => {
  const f = await fixture(t);
  await f.put(f.serverDir, "original.txt", "previous data");
  await f.stage("server.jar", "new runtime");
  await assert.rejects(
    cleanInstall(f.result, {
      ...f.ctx,
      recycle: async (relative) => {
        const entry = await f.bin.recycle(relative);
        if (relative === "original.txt")
          await f.put(f.serverDir, "external.txt", "concurrent data");
        return entry;
      },
    }),
    /New files appeared/,
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "external.txt"), "utf8"),
    "concurrent data",
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "original.txt"), "utf8"),
    "previous data",
  );
});

for (const phase of ["Saving previous", "Installing"]) {
  test(`a root junction swap during ${phase.toLowerCase()} cannot redirect the transaction`, async (t) => {
    const f = await fixture(t);
    const outside = path.join(f.root, "outside");
    const preserved = path.join(f.root, "original-root");
    await fs.mkdir(outside);
    await f.put(outside, "original.txt", "outside original");
    await f.put(outside, "proof.txt", "outside proof");
    await f.put(f.serverDir, "original.txt", "server original");
    await f.stage("new-runtime.jar", "new runtime");
    let swapped = false;
    try {
      await assert.rejects(
        cleanInstall(f.result, {
          ...f.ctx,
          onProgress: ({ message }) => {
            if (!swapped && message.startsWith(phase)) {
              swapped = true;
              renameSync(f.serverDir, preserved);
              symlinkSync(
                outside,
                f.serverDir,
                process.platform === "win32" ? "junction" : "dir",
              );
            }
          },
        }),
        /server folder changed|recovery|symbolic link/i,
      );
      assert.equal(swapped, true);
      assert.deepEqual((await fs.readdir(outside)).sort(), [
        "original.txt",
        "proof.txt",
      ]);
      assert.equal(
        await fs.readFile(path.join(outside, "original.txt"), "utf8"),
        "outside original",
      );
      assert.equal(
        await fs.readFile(path.join(outside, "proof.txt"), "utf8"),
        "outside proof",
      );
    } finally {
      if (swapped) await fs.unlink(f.serverDir);
    }
  });
}

test("a final recycle journal failure still restores the original that was already moved", async (t) => {
  let injected = false;
  const f = await fixture(t, {
    fileSystem: {
      ...fs,
      rename: async (from, to) => {
        if (!injected && path.basename(to) === "entry.json") {
          const payloadExists = await fs
            .stat(path.join(path.dirname(to), "content"))
            .then(
              () => true,
              () => false,
            );
          if (payloadExists) {
            injected = true;
            throw Object.assign(new Error("fixture ready journal failed"), {
              code: "EIO",
            });
          }
        }
        return fs.rename(from, to);
      },
    },
  });
  await f.put(f.serverDir, "original.txt", "must be restored");
  await f.stage("server.jar", "replacement");
  await assert.rejects(
    cleanInstall(f.result, f.ctx),
    /ready journal failed.*Previous server files were restored/,
  );
  assert.equal(injected, true);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "original.txt"), "utf8"),
    "must be restored",
  );
  assert.deepEqual(await fs.readdir(f.serverDir), ["original.txt"]);
});

test("changing an already copied file aborts before commit and retains its external bytes in recovery", async (t) => {
  const f = await fixture(t);
  await f.put(f.serverDir, "original.txt", "old server");
  await f.stage("a.jar", "verified first file");
  await f.stage("b.jar", "verified second file");
  let committed = false;
  await assert.rejects(
    cleanInstall(f.result, {
      ...f.ctx,
      onProgress: ({ message }) => {
        if (message === "Installing b.jar…")
          writeFileSync(path.join(f.serverDir, "a.jar"), "external edit");
      },
      commit: async () => {
        committed = true;
      },
    }),
    /verif|changed|external/i,
  );
  assert.equal(committed, false);
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "original.txt"), "utf8"),
    "old server",
  );
  const edited = (await f.bin.list()).find(
    (item) => item.originalPath === "a.jar",
  );
  assert.ok(edited);
  assert.equal(
    await fs.readFile(path.join(f.bin.directory, edited.id, "content"), "utf8"),
    "external edit",
  );
});

test("cross-volume recycling verifies its copies before a successful clean install", async (t) => {
  let copied = 0;
  const f = await fixture(t, {
    fileSystem: {
      ...fs,
      rename: async (from, to) => {
        if (path.basename(to) === "content") {
          copied++;
          throw Object.assign(new Error("fixture other volume"), {
            code: "EXDEV",
          });
        }
        return fs.rename(from, to);
      },
    },
  });
  await f.put(f.serverDir, "world/region/data.mca", Buffer.from([0, 255, 12]));
  await f.stage("server.jar", "replacement");
  await cleanInstall(f.result, f.ctx);
  assert.equal(copied, 1);
  const [world] = await f.bin.list();
  assert.equal(world.status, "ready");
  assert.deepEqual(
    await fs.readFile(
      path.join(f.bin.directory, world.id, "content/region/data.mca"),
    ),
    Buffer.from([0, 255, 12]),
  );
  assert.deepEqual(await fs.readdir(f.serverDir), ["server.jar"]);
});

test("fresh settings use pack defaults with the explicit EULA decision and selected memory and port", async (t) => {
  const f = await fixture(t);
  await f.put(f.serverDir, "eula.txt", "eula=true\n");
  await f.put(
    f.serverDir,
    "server.properties",
    "level-name=old-world\nmotd=Old server\n",
  );
  await f.stage(
    "server.properties",
    "level-name=pack-world\nserver-port=12345\nmax-players=45\nmotd=Pack adventures\n",
  );
  await f.stage("eula.txt", "eula=false\n");
  await f.stage("user_jvm_args.txt", "-Xmx2G\n");
  f.result.configuration.launchType = "java-args";
  await prepareCleanSettings(f.result, f.ctx);
  const properties = await fs.readFile(
    path.join(f.stageDir, "server.properties"),
    "utf8",
  );
  assert.match(properties, /server-port=25577/);
  assert.match(properties, /level-name=pack-world/);
  assert.match(properties, /^max-players=45$/m);
  assert.match(properties, /^motd=Pack adventures$/m);
  assert.doesNotMatch(properties, /old-world|Old server|12345/);
  assert.equal(f.result.configuration.maxPlayers, 45);
  assert.equal(f.result.configuration.motd, "Pack adventures");
  assert.equal(f.ctx.getConfiguration().maxPlayers, 12);
  assert.match(
    await fs.readFile(path.join(f.stageDir, "eula.txt"), "utf8"),
    /eula=true/,
  );
  assert.match(
    await fs.readFile(path.join(f.stageDir, "user_jvm_args.txt"), "utf8"),
    /-Xmx6144M/,
  );
  assert.equal(f.result.files.length, 3);
});

test("without pack properties fresh defaults replace the old server settings and world name", async (t) => {
  const f = await fixture(t);
  Object.assign(f.ctx.getConfiguration(), {
    maxPlayers: 3,
    motd: "Previous panel message",
    world: "previous-world",
  });
  const oldProperties =
    "level-name=previous-world\nmax-players=99\nmotd=Previous file message\nserver-port=12345\n";
  await f.put(f.serverDir, "server.properties", oldProperties);
  await f.put(f.serverDir, "eula.txt", "eula=false\n");
  await f.stage("server.jar", "new runtime");
  await prepareCleanSettings(f.result, f.ctx);
  const properties = await fs.readFile(
    path.join(f.stageDir, "server.properties"),
    "utf8",
  );
  assert.match(properties, /^level-name=world$/m);
  assert.match(properties, /^max-players=20$/m);
  assert.match(properties, /^motd=A Minecraft Server$/m);
  assert.match(properties, /^server-port=25577$/m);
  assert.doesNotMatch(
    properties,
    /previous-world|Previous|max-players=(?:3|99)\b|12345/,
  );
  assert.equal(f.result.configuration.maxPlayers, 20);
  assert.equal(f.result.configuration.motd, "A Minecraft Server");
  assert.match(
    await fs.readFile(path.join(f.stageDir, "eula.txt"), "utf8"),
    /^eula=false$/m,
  );
  assert.equal(
    await fs.readFile(path.join(f.serverDir, "server.properties"), "utf8"),
    oldProperties,
  );
  assert.deepEqual(f.result.files.map((file) => file.path).sort(), [
    "eula.txt",
    "server.jar",
    "server.properties",
  ]);
});

test("the clean install root cannot contain panel recovery storage", async (t) => {
  const f = await fixture(t);
  await f.put(f.root, "proof.txt", "must remain outside a server transaction");
  await f.stage("server.jar", "replacement");
  await assert.rejects(
    cleanInstall(f.result, {
      ...f.ctx,
      serverDir: f.root,
    }),
    /dedicated server folder/,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, "proof.txt"), "utf8"),
    "must remain outside a server transaction",
  );
  assert.deepEqual(await f.bin.list(), []);
});
