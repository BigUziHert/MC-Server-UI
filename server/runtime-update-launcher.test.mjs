import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promoteRuntimeVersion } from "./minecraft.mjs";
import { parseJavaScript, parseProperties } from "./import.mjs";
import { createRecycleBin } from "./recycle-bin.mjs";
import { safePath } from "./index.mjs";

const oldArgument = "libraries/net/neoforged/neoforge/21.1.200/win_args.txt";
const newArgument = "libraries/net/neoforged/neoforge/21.1.250/win_args.txt";

async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(temporary, "mc-runtime-launcher-test-")),
  );
  const serverDir = path.join(root, "server");
  const dataDir = path.join(root, "panel");
  const stageDir = path.join(root, "stage");
  await Promise.all(
    [serverDir, dataDir, stageDir].map((directory) => fs.mkdir(directory)),
  );
  t.after(async () => {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-runtime-launcher-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const bin = await createRecycleBin({ serverDir, dataDir, safePath });
  let configuration = {
    name: "My server",
    mode: "live",
    software: "NeoForge",
    version: "21.1.200",
    minecraftVersion: "1.21.1",
    launchType: "script",
    launchScript: "scripts/custom-start.bat",
    launchArgs: ["--port", "25577"],
    javaPath: "C:\\Program Files\\Java\\bin\\java.exe",
    memoryLimitMB: 12288,
    port: 25577,
    maxPlayers: 14,
    motd: "My world",
  };
  const applied = [];
  const ctx = {
    serverDir,
    dataDir,
    safePath,
    recycle: (relative) => bin.recycle(relative),
    restore: (id) => bin.restore(id),
    getConfiguration: () => structuredClone(configuration),
    applyConfiguration: async (patch) => {
      applied.push(structuredClone(patch));
      configuration = { ...configuration, ...patch };
    },
  };
  const result = {
    stageDir,
    files: [],
    configuration: {
      software: "NeoForge",
      version: "21.1.250",
      launchType: "java-args",
      jar: "",
      launchArgs: ["@user_jvm_args.txt", `@${newArgument}`, "nogui"],
    },
    summary: { provider: "neoforge", version: "1.21.1", build: "21.1.250" },
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
  function state(script = null) {
    const config = ctx.getConfiguration();
    const parsed = script === null ? null : parseJavaScript(script);
    const args = parsed
      ? [...parsed.args, ...config.launchArgs]
      : [...config.launchArgs];
    const index = args.findIndex(
      (argument) =>
        argument.replace(/\\/g, "/").replace(/^@\.\//, "@") ===
        `@${oldArgument}`,
    );
    return {
      provider: "neoforge",
      gameVersion: "1.21.1",
      build: "21.1.200",
      configuration: config,
      script,
      args,
      argument: index < 0 ? null : { index, path: oldArgument },
      javaPath: parsed?.javaPath ?? config.javaPath,
    };
  }
  await put(serverDir, oldArgument, "original runtime arguments");
  await put(serverDir, "user_jvm_args.txt", "-Xmx12G\r\n-XX:+UseZGC\r\n");
  await put(serverDir, "world/level.dat", "existing world");
  await put(serverDir, "mods/custom.jar", "installed mod");
  await stage(newArgument, "new runtime arguments");
  await stage("user_jvm_args.txt", "-Xmx2G\n", { preserveExisting: true });
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
    state,
    applied,
  };
}

for (const [name, argument, next] of [
  ["relative forward slashes", `@./${oldArgument}`, `@./${newArgument}`],
  ["quoted forward slashes", `@"${oldArgument}"`, `@"${newArgument}"`],
  [
    "quoted backslashes",
    `"@${oldArgument.replace(/\//g, "\\")}"`,
    `"@${newArgument.replace(/\//g, "\\")}"`,
  ],
  [
    "relative quoted backslashes",
    `@".\\${oldArgument.replace(/\//g, "\\")}"`,
    `@".\\${newArgument.replace(/\//g, "\\")}"`,
  ],
]) {
  test(`script runtime updates retain custom launch bytes with ${name}`, async (t) => {
    const f = await fixture(t);
    const script = `@echo off\r\nREM Keep old documentation @${oldArgument}\r\n:: Custom launcher\r\n"C:\\Program Files\\Java\\bin\\java.exe" -Dcustom="value with spaces" @user_jvm_args.txt ${argument} --nogui%*\r\npause\r\n`;
    const current = f.state(script);
    await f.put(f.serverDir, current.configuration.launchScript, script);
    await promoteRuntimeVersion(f.result, f.ctx, current);
    const expected = script.replace(`${argument} --nogui`, `${next} --nogui`);
    assert.equal(await f.read(current.configuration.launchScript), expected);
    assert.equal(
      parseJavaScript(expected).javaPath,
      "C:\\Program Files\\Java\\bin\\java.exe",
    );
    const configuration = f.ctx.getConfiguration();
    assert.equal(configuration.launchType, "script");
    assert.equal(
      configuration.launchScript,
      current.configuration.launchScript,
    );
    assert.deepEqual(
      configuration.launchArgs,
      current.configuration.launchArgs,
    );
    assert.equal(configuration.javaPath, current.configuration.javaPath);
    assert.equal(configuration.memoryLimitMB, 12288);
    assert.equal(configuration.version, "21.1.250");
    assert.equal(
      await f.read("user_jvm_args.txt"),
      "-Xmx12G\r\n-XX:+UseZGC\r\n",
    );
    assert.equal(await f.read("world/level.dat"), "existing world");
    assert.equal(await f.read("mods/custom.jar"), "installed mod");
  });
}

test("direct Java arguments preserve custom values and exact order around the runtime reference", async (t) => {
  const f = await fixture(t);
  const originalArgs = [
    "-Xms6G",
    "-Dcustom=one two",
    "@custom-jvm.txt",
    `@./${oldArgument}`,
    "--nogui",
    "--port",
    "25577",
    "--world",
    "custom world",
  ];
  await f.ctx.applyConfiguration({
    launchType: "java-args",
    launchArgs: originalArgs,
  });
  const current = f.state();
  await promoteRuntimeVersion(f.result, f.ctx, current);
  const expected = [...originalArgs];
  expected[3] = `@./${newArgument}`;
  assert.deepEqual(f.ctx.getConfiguration().launchArgs, expected);
  assert.equal(f.ctx.getConfiguration().launchType, "java-args");
  assert.equal(
    f.ctx.getConfiguration().javaPath,
    current.configuration.javaPath,
  );
  assert.deepEqual(originalArgs, current.configuration.launchArgs);
});

async function fabricFixture(t) {
  const f = await fixture(t);
  f.result.files = [];
  f.result.configuration = {
    software: "Fabric",
    version: "0.16.14",
    launchType: "jar",
    jar: "fabric-server-launch.jar",
  };
  f.result.summary = {
    provider: "fabric",
    version: "1.21.1",
    build: "0.16.14",
  };
  await f.ctx.applyConfiguration({
    software: "Fabric",
    version: "0.16.10",
    launchType: "jar",
    jar: "fabric-server-launch.jar",
    launchArgs: ["--nogui"],
  });
  await f.put(f.serverDir, "fabric-server-launch.jar", "old launcher");
  const filename = "fabric-server-launcher.properties";
  const original =
    "# My launcher settings\r\nserverJar=libraries/old-server.jar\r\ncustom.option=keep me\r\n# Keep these comments\r\n";
  await f.put(f.serverDir, filename, original);
  await f.stage("fabric-server-launch.jar", "new launcher");
  await f.stage(
    filename,
    "serverJar=libraries/new-server.jar\nloaderVersion=0.16.14\n",
  );
  const current = {
    ...f.state(),
    provider: "fabric",
    build: "0.16.10",
    argument: null,
  };
  return { ...f, filename, original, current };
}

test("Fabric launcher properties merge new runtime values while retaining comments and custom settings", async (t) => {
  const f = await fabricFixture(t);
  await promoteRuntimeVersion(f.result, f.ctx, f.current);
  const updated = await f.read(f.filename);
  assert.ok(updated.startsWith(f.original));
  assert.doesNotMatch(updated, /(?<!\r)\n/);
  const properties = parseProperties(updated);
  assert.equal(properties.get("custom.option"), "keep me");
  assert.equal(properties.get("serverJar"), "libraries/new-server.jar");
  assert.equal(properties.get("loaderVersion"), "0.16.14");
  assert.equal(await f.read("fabric-server-launch.jar"), "new launcher");
  assert.equal(f.ctx.getConfiguration().version, "0.16.14");
});

test("a failed configuration commit restores the active script and previous server settings", async (t) => {
  const f = await fixture(t);
  const script = `@echo off\r\njava -Dcustom=retained @user_jvm_args.txt @${oldArgument} nogui %*\r\npause\r\n`;
  const current = f.state(script);
  await f.put(f.serverDir, current.configuration.launchScript, script);
  let calls = 0;
  await assert.rejects(
    promoteRuntimeVersion(
      f.result,
      {
        ...f.ctx,
        applyConfiguration: async (patch) => {
          await f.ctx.applyConfiguration(patch);
          if (++calls === 1)
            throw new Error("fixture configuration persistence failed");
        },
      },
      current,
    ),
    /fixture configuration persistence failed/,
  );
  assert.equal(calls, 2);
  assert.equal(await f.read(current.configuration.launchScript), script);
  assert.deepEqual(f.ctx.getConfiguration(), current.configuration);
  assert.equal(await f.read(oldArgument), "original runtime arguments");
  await assert.rejects(fs.stat(path.join(f.serverDir, newArgument)), {
    code: "ENOENT",
  });
  assert.equal(await f.read("world/level.dat"), "existing world");
});

test("a startup script edited after preparation cannot be overwritten by an older inspected copy", async (t) => {
  const f = await fixture(t);
  const script = `@echo off\r\njava @user_jvm_args.txt @${oldArgument} nogui%*\r\npause\r\n`;
  const current = f.state(script);
  const scriptPath = current.configuration.launchScript;
  const external = script.replace("java @", "java -Dexternal=true @");
  await f.put(f.serverDir, scriptPath, script);
  let injected = false;
  await assert.rejects(
    promoteRuntimeVersion(
      f.result,
      {
        ...f.ctx,
        safePath: async (root, relative = "") => {
          const selected = await safePath(root, relative);
          if (!injected && root === f.serverDir && relative === scriptPath) {
            injected = true;
            await fs.writeFile(selected, external);
          }
          return selected;
        },
      },
      current,
    ),
    /changed after.*inspected/i,
  );
  assert.equal(injected, true);
  assert.equal(await f.read(scriptPath), external);
  assert.deepEqual(f.ctx.getConfiguration(), current.configuration);
  assert.deepEqual(await f.bin.list(), []);
  await assert.rejects(fs.stat(path.join(f.serverDir, newArgument)), {
    code: "ENOENT",
  });
});

test("launcher properties edited after merging cannot be overwritten by stale prepared values", async (t) => {
  const f = await fabricFixture(t);
  const external = `${f.original}external.setting=latest\r\n`;
  let reads = 0;
  let injected = false;
  await assert.rejects(
    promoteRuntimeVersion(
      f.result,
      {
        ...f.ctx,
        safePath: async (root, relative = "") => {
          const selected = await safePath(root, relative);
          if (
            root === f.serverDir &&
            relative === f.filename &&
            ++reads === 2
          ) {
            injected = true;
            await fs.writeFile(selected, external);
          }
          return selected;
        },
      },
      f.current,
    ),
    /changed after.*inspected/i,
  );
  assert.equal(injected, true);
  assert.equal(await f.read(f.filename), external);
  assert.equal(await f.read("fabric-server-launch.jar"), "old launcher");
  assert.deepEqual(f.ctx.getConfiguration(), f.current.configuration);
  assert.deepEqual(await f.bin.list(), []);
});
