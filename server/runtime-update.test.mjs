import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { runtimeUpdateFiles } from "./runtime-update.mjs";
import { createRecycleBin } from "./recycle-bin.mjs";
import { safePath } from "./index.mjs";

async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(temporary, "mc-runtime-update-test-")),
  );
  const serverDir = path.join(root, "server");
  const dataDir = path.join(root, "panel");
  const stageDir = path.join(root, "stage");
  await Promise.all(
    [serverDir, dataDir, stageDir].map((directory) => fs.mkdir(directory)),
  );
  t.after(async () => {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-runtime-update-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const bin = await createRecycleBin({ serverDir, dataDir, safePath });
  const ctx = {
    serverDir,
    dataDir,
    safePath,
    recycle: (relative) => bin.recycle(relative),
    restore: (id) => bin.restore(id),
    commit: async () => {},
    rollback: async () => {},
  };
  const result = {
    stageDir,
    files: [],
    configuration: { launchType: "jar", jar: "server.jar" },
    summary: { provider: "paper", version: "1.21.1", build: "2" },
  };
  async function put(directory, relative, content) {
    const target = path.join(directory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  async function stage(relative, content, options = {}) {
    await put(stageDir, relative, content);
    result.files.push({ path: relative, ...options });
  }
  const read = (relative) =>
    fs.readFile(path.join(serverDir, relative), "utf8");
  return {
    root,
    serverDir,
    dataDir,
    stageDir,
    bin,
    ctx,
    result,
    put,
    stage,
    read,
  };
}

async function digest(file) {
  return createHash("sha512")
    .update(await fs.readFile(file))
    .digest("hex");
}

test("runtime updates replace only staged runtime files and preserve server content byte for byte", async (t) => {
  const f = await fixture(t);
  const untouched = {
    "world/region/r.0.0.mca": Buffer.alloc(140_000, 181),
    "world_nether/DIM-1/region/r.0.0.mca": Buffer.from([0, 255, 71]),
    "mods/custom.jar": "installed mod",
    "plugins/custom.jar": "installed plugin",
    "config/custom.toml": "custom=true",
    "server.properties": "level-name=world\nmotd=My world\n",
    "eula.txt": "eula=true\n",
    "ops.json": '[{"name":"Owner"}]',
    "user_jvm_args.txt": "-Xmx12G\n-XX:+UseZGC\n",
    "run.bat": "@echo off\njava @user_jvm_args.txt @libraries/old_args.txt\n",
    "run.sh": "#!/bin/sh\nexec java -Xmx12G -jar server.jar\n",
    "fabric-server-launcher.properties": "custom-launch-option=true\n",
    "libraries/other/untouched.jar": "unrelated library",
    "custom-runtime.jar": "explicitly preserved runtime",
  };
  for (const [relative, bytes] of Object.entries(untouched))
    await f.put(f.serverDir, relative, bytes);
  const before = Object.fromEntries(
    await Promise.all(
      Object.keys(untouched).map(async (relative) => [
        relative,
        await digest(path.join(f.serverDir, relative)),
      ]),
    ),
  );
  await f.put(f.serverDir, "server.jar", "old runtime");
  await f.put(f.serverDir, "libraries/example/runtime.jar", "old library");
  await f.stage("server.jar", Buffer.alloc(200_000, 73));
  await f.stage("libraries/example/runtime.jar", "new library");
  await f.stage("libraries/example/new.jar", "additional library");
  for (const relative of [
    "user_jvm_args.txt",
    "run.bat",
    "run.sh",
    "fabric-server-launcher.properties",
  ])
    await f.stage(
      relative,
      "installer defaults must not replace user settings",
    );
  await f.stage("custom-runtime.jar", "do not overwrite", {
    preserveExisting: true,
  });
  let committed = 0;
  const updated = await runtimeUpdateFiles(f.result, {
    ...f.ctx,
    commit: async () => {
      committed++;
    },
  });
  assert.equal(committed, 1);
  for (const [relative, expected] of Object.entries(before))
    assert.equal(
      await digest(path.join(f.serverDir, relative)),
      expected,
      `${relative} was changed`,
    );
  assert.equal(await f.read("libraries/example/runtime.jar"), "new library");
  assert.equal(await f.read("libraries/example/new.jar"), "additional library");
  assert.equal(
    await digest(path.join(f.serverDir, "server.jar")),
    await digest(path.join(f.stageDir, "server.jar")),
  );
  assert.deepEqual(updated.recoveryEntries.map((entry) => entry.path).sort(), [
    "libraries/example/runtime.jar",
    "server.jar",
  ]);
  const original = (await f.bin.list()).find(
    (entry) => entry.originalPath === "server.jar",
  );
  assert.ok(original);
  assert.equal(
    await fs.readFile(
      path.join(f.bin.directory, original.id, "content"),
      "utf8",
    ),
    "old runtime",
  );
});

test("runtime bootstrap files are installed when absent without replacing existing settings", async (t) => {
  const f = await fixture(t);
  f.result.configuration = {
    launchType: "java-args",
    javaArgsFile: "libraries/example/win_args.txt",
  };
  await f.stage(
    "libraries/example/win_args.txt",
    "-cp libraries/runtime.jar Main",
  );
  for (const relative of [
    "user_jvm_args.txt",
    "run.bat",
    "run.sh",
    "fabric-server-launcher.properties",
  ])
    await f.stage(relative, `default ${relative}`);
  const updated = await runtimeUpdateFiles(f.result, f.ctx);
  for (const entry of f.result.files)
    assert.equal(
      await f.read(entry.path),
      await fs.readFile(path.join(f.stageDir, entry.path), "utf8"),
    );
  assert.deepEqual(updated.recoveryEntries, []);
});

test("configuration commit failure restores original runtimes and removes only newly installed files", async (t) => {
  const f = await fixture(t);
  await f.put(f.serverDir, "server.jar", "old runtime");
  await f.put(f.serverDir, "mods/keep.jar", "keep mod");
  await f.stage("server.jar", "new runtime");
  await f.stage("libraries/new/runtime.jar", "new library");
  let rolledBack = 0;
  await assert.rejects(
    runtimeUpdateFiles(f.result, {
      ...f.ctx,
      commit: async () => {
        throw new Error("fixture commit failed");
      },
      rollback: async () => {
        rolledBack++;
      },
    }),
    /fixture commit failed/,
  );
  assert.equal(rolledBack, 1);
  assert.equal(await f.read("server.jar"), "old runtime");
  assert.equal(await f.read("mods/keep.jar"), "keep mod");
  assert.equal(
    existsSync(path.join(f.serverDir, "libraries/new/runtime.jar")),
    false,
  );
});

test("a staged source changed after validation cannot be committed and the prior runtime is restored", async (t) => {
  const f = await fixture(t);
  await f.put(f.serverDir, "server.jar", "old runtime");
  await f.stage("server.jar", "verified runtime");
  let committed = false;
  let mutated = false;
  await assert.rejects(
    runtimeUpdateFiles(f.result, {
      ...f.ctx,
      recycle: async (relative) => {
        const entry = await f.bin.recycle(relative);
        if (!mutated && relative === "server.jar") {
          mutated = true;
          await f.put(f.stageDir, "server.jar", "external replacement");
        }
        return entry;
      },
      commit: async () => {
        committed = true;
      },
    }),
    /verif|changed/i,
  );
  assert.equal(mutated, true);
  assert.equal(committed, false);
  assert.equal(await f.read("server.jar"), "old runtime");
});

test("a concurrent replacement at the destination is not overwritten during install or rollback", async (t) => {
  const f = await fixture(t);
  await f.put(f.serverDir, "server.jar", "old runtime");
  await f.stage("server.jar", "new runtime");
  let injected = false;
  let committed = false;
  await assert.rejects(
    runtimeUpdateFiles(f.result, {
      ...f.ctx,
      recycle: async (relative) => {
        const entry = await f.bin.recycle(relative);
        if (!injected && relative === "server.jar") {
          injected = true;
          await f.put(f.serverDir, "server.jar", "external runtime");
        }
        return entry;
      },
      commit: async () => {
        committed = true;
      },
    }),
  );
  assert.equal(injected, true);
  assert.equal(committed, false);
  assert.equal(await f.read("server.jar"), "external runtime");
  const originals = await f.bin.list();
  const bytes = await Promise.all(
    originals.map((entry) =>
      fs.readFile(path.join(f.bin.directory, entry.id, "content"), "utf8"),
    ),
  );
  assert.ok(bytes.includes("old runtime"));
});

test("an already copied runtime changed externally is detected before configuration commit", async (t) => {
  const f = await fixture(t);
  await f.put(f.serverDir, "server.jar", "old runtime");
  await f.stage("server.jar", "verified first runtime");
  await f.stage("libraries/next.jar", "verified next runtime");
  let mutated = false;
  let committed = false;
  await assert.rejects(
    runtimeUpdateFiles(f.result, {
      ...f.ctx,
      onProgress: ({ message }) => {
        if (!mutated && message.includes("libraries/next.jar")) {
          mutated = true;
          writeFileSync(path.join(f.serverDir, "server.jar"), "external edit");
        }
      },
      commit: async () => {
        committed = true;
      },
    }),
    /verif|changed|external/i,
  );
  assert.equal(mutated, true);
  assert.equal(committed, false);
  const retained = await f.bin.list();
  const bytes = await Promise.all(
    retained.map((entry) =>
      fs.readFile(path.join(f.bin.directory, entry.id, "content"), "utf8"),
    ),
  );
  assert.ok(
    bytes.includes("external edit") ||
      (await f.read("server.jar")) === "external edit",
  );
  assert.ok(
    bytes.includes("old runtime") ||
      (await f.read("server.jar")) === "old runtime",
  );
});

for (const side of ["source", "destination"]) {
  test(`a ${side} directory junction cannot redirect runtime files outside their root`, async (t) => {
    const f = await fixture(t);
    const outside = path.join(f.root, "outside");
    await f.put(outside, "runtime.jar", "outside proof");
    if (side === "source") {
      await fs.symlink(
        outside,
        path.join(f.stageDir, "libraries"),
        process.platform === "win32" ? "junction" : "dir",
      );
      f.result.files.push({ path: "libraries/runtime.jar" });
    } else {
      await f.stage("libraries/runtime.jar", "new runtime");
      await fs.symlink(
        outside,
        path.join(f.serverDir, "libraries"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    let committed = false;
    await assert.rejects(
      runtimeUpdateFiles(f.result, {
        ...f.ctx,
        commit: async () => {
          committed = true;
        },
      }),
    );
    assert.equal(committed, false);
    assert.equal(
      await fs.readFile(path.join(outside, "runtime.jar"), "utf8"),
      "outside proof",
    );
    assert.deepEqual(await f.bin.list(), []);
  });
}

test("replacing the server root with a junction during progress cannot redirect writes or recovery", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  const original = path.join(f.root, "original-server");
  await f.put(outside, "server.jar", "outside proof");
  await f.put(f.serverDir, "server.jar", "original runtime");
  await f.stage("server.jar", "new runtime");
  let swapped = false;
  let committed = false;
  try {
    await assert.rejects(
      runtimeUpdateFiles(f.result, {
        ...f.ctx,
        onProgress: () => {
          if (swapped) return;
          swapped = true;
          renameSync(f.serverDir, original);
          symlinkSync(
            outside,
            f.serverDir,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
        commit: async () => {
          committed = true;
        },
      }),
      /changed|link|recovery/i,
    );
    assert.equal(swapped, true);
    assert.equal(committed, false);
    assert.equal(
      await fs.readFile(path.join(outside, "server.jar"), "utf8"),
      "outside proof",
    );
    assert.deepEqual(await fs.readdir(outside), ["server.jar"]);
  } finally {
    if (swapped) await fs.unlink(f.serverDir);
  }
});

for (const invalid of [
  "../outside.jar",
  "libraries/../server.jar",
  "libraries\\runtime.jar",
  "mods/new.jar",
  "config/new.toml",
  "world/level.dat",
  "server.properties",
  "eula.txt",
]) {
  test(`runtime updates reject ${invalid} before touching existing files`, async (t) => {
    const f = await fixture(t);
    await f.put(f.serverDir, "server.jar", "old runtime");
    await f.stage("server.jar", "new runtime");
    f.result.files.push({ path: invalid });
    let recycled = 0;
    await assert.rejects(
      runtimeUpdateFiles(f.result, {
        ...f.ctx,
        recycle: async (relative) => {
          recycled++;
          return f.bin.recycle(relative);
        },
      }),
    );
    assert.equal(recycled, 0);
    assert.equal(await f.read("server.jar"), "old runtime");
  });
}

test("duplicate runtime destinations are rejected before any original files are recycled", async (t) => {
  const f = await fixture(t);
  await f.put(f.serverDir, "server.jar", "old runtime");
  await f.stage("server.jar", "new runtime");
  f.result.files.push({ path: "SERVER.JAR" });
  await assert.rejects(
    runtimeUpdateFiles(f.result, f.ctx),
    /conflict|duplicate/i,
  );
  assert.equal(await f.read("server.jar"), "old runtime");
  assert.deepEqual(await f.bin.list(), []);
});

test("preserveExisting cannot grant an unrelated configuration file permission to be installed", async (t) => {
  const f = await fixture(t);
  await f.put(f.serverDir, "server.jar", "old runtime");
  await f.stage("server.jar", "new runtime");
  await f.stage("config/new.toml", "must-not-be-installed=true", {
    preserveExisting: true,
  });
  let recycled = 0;
  await assert.rejects(
    runtimeUpdateFiles(f.result, {
      ...f.ctx,
      recycle: async (relative) => {
        recycled++;
        return f.bin.recycle(relative);
      },
    }),
    /outside|runtime artifact|not allowed/i,
  );
  assert.equal(recycled, 0);
  assert.equal(await f.read("server.jar"), "old runtime");
  assert.equal(existsSync(path.join(f.serverDir, "config/new.toml")), false);
});

test("a verified bootstrap replacement overrides preservation only for the selected launcher", async (t) => {
  const f = await fixture(t);
  await f.put(f.serverDir, "server.jar", "old runtime");
  await f.put(f.serverDir, "run.bat", "java @libraries/old/win_args.txt\n");
  await f.put(f.serverDir, "run.sh", "custom unix launch script\n");
  await f.put(f.serverDir, "user_jvm_args.txt", "-Xmx12G\n");
  await f.stage("server.jar", "new runtime");
  await f.stage("run.bat", "java @libraries/new/win_args.txt\n", {
    preserveExisting: true,
  });
  await f.stage("run.sh", "new installer default script\n", {
    preserveExisting: true,
  });
  await f.stage("user_jvm_args.txt", "-Xmx2G\n");
  const result = await runtimeUpdateFiles(f.result, {
    ...f.ctx,
    replacePaths: ["run.bat"],
  });
  assert.equal(await f.read("server.jar"), "new runtime");
  assert.equal(await f.read("run.bat"), "java @libraries/new/win_args.txt\n");
  assert.equal(await f.read("run.sh"), "custom unix launch script\n");
  assert.equal(await f.read("user_jvm_args.txt"), "-Xmx12G\n");
  assert.deepEqual(result.recoveryEntries.map((entry) => entry.path).sort(), [
    "run.bat",
    "server.jar",
  ]);
});

for (const failCommit of [false, true]) {
  test(`verified custom launcher paths support ${failCommit ? "rollback on failure" : "transactional replacement"}`, async (t) => {
    const f = await fixture(t);
    const launcher = "scripts/start-my-server.bat";
    await f.put(f.serverDir, launcher, "custom original launcher\n");
    await f.put(f.serverDir, "scripts/other.bat", "other custom script\n");
    await f.put(f.serverDir, "server.jar", "old runtime");
    await f.stage(launcher, "custom updated launcher\n", {
      preserveExisting: true,
    });
    await f.stage("server.jar", "new runtime");
    let rolledBack = false;
    const update = runtimeUpdateFiles(f.result, {
      ...f.ctx,
      replacePaths: [launcher],
      commit: async () => {
        if (failCommit)
          throw new Error("fixture custom launcher commit failed");
      },
      rollback: async () => {
        rolledBack = true;
      },
    });
    if (failCommit)
      await assert.rejects(update, /fixture custom launcher commit failed/);
    else await update;
    assert.equal(rolledBack, failCommit);
    assert.equal(
      await f.read(launcher),
      failCommit ? "custom original launcher\n" : "custom updated launcher\n",
    );
    assert.equal(
      await f.read("server.jar"),
      failCommit ? "old runtime" : "new runtime",
    );
    assert.equal(await f.read("scripts/other.bat"), "other custom script\n");
  });
}

test("cancellation after recycling restores the runtime while leaving worlds and mods unchanged", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  await f.put(f.serverDir, "server.jar", "old runtime");
  await f.put(f.serverDir, "world/level.dat", "saved world");
  await f.put(f.serverDir, "mods/keep.jar", "installed mod");
  await f.stage("server.jar", "new runtime");
  let committed = false;
  await assert.rejects(
    runtimeUpdateFiles(f.result, {
      ...f.ctx,
      signal: controller.signal,
      recycle: async (relative) => {
        const entry = await f.bin.recycle(relative);
        controller.abort(new Error("fixture cancelled update"));
        return entry;
      },
      commit: async () => {
        committed = true;
      },
    }),
    /cancel|abort/i,
  );
  assert.equal(committed, false);
  assert.equal(await f.read("server.jar"), "old runtime");
  assert.equal(await f.read("world/level.dat"), "saved world");
  assert.equal(await f.read("mods/keep.jar"), "installed mod");
});
