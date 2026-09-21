import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFleet } from "./index.mjs";

const oldArgs = "libraries/net/neoforged/neoforge/21.1.250/win_args.txt";
const newArgs = "libraries/net/neoforged/neoforge/21.1.251/win_args.txt";
const selection = {
  provider: "neoforge",
  version: "1.21.1",
  build: "21.1.251",
  confirmed: true,
  updateRuntime: true,
};
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const originalScript = `@echo off\r\nREM Keep my custom launch settings\r\njava -Dexample=value @user_jvm_args.txt @${oldArgs} nogui%*\r\npause\r\n`;

async function fixture(
  t,
  { launchType = "script", stageHook, customScript } = {},
) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "mc-runtime-api-test-"));
  const dataDir = path.join(root, "panel"),
    serverDir = path.join(root, "Imported server");
  const put = async (directory, relative, bytes) => {
    const file = path.join(directory, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  };
  const preserved = {
    "world/level.dat": Buffer.from([0, 1, 255, 60, 83]),
    "mods/keep.jar": Buffer.from([80, 75, 3, 4, 23]),
    "plugins/keep.jar": "custom plugin",
    "config/keep.toml": "my-setting=true\r\n",
    "server.properties":
      "server-port=25585\nmotd=Imported world\nlevel-name=world\n",
    "user_jvm_args.txt":
      "# Keep the heap and GC options\r\n-Xms6G\r\n-Xmx12G\r\n-XX:+UseZGC\r\n",
    "eula.txt": "eula=true\n",
    "ops.json": "[]",
    [oldArgs]: "-cp libraries/old.jar example.Main\n",
    "libraries/old.jar": "old runtime library",
  };
  for (const [relative, bytes] of Object.entries(preserved))
    await put(serverDir, relative, bytes);
  await put(serverDir, "run.bat", customScript ?? originalScript);
  let staged = 0,
    panel,
    listener,
    id;
  const versionsService = {
    listProviders: () => [
      { id: "neoforge", name: "NeoForge", installable: true },
    ],
    versions: async () => ({ versions: [{ id: "1.21.1", stable: true }] }),
    builds: async () => ({ builds: [{ id: "21.1.251", stable: true }] }),
    stage: async (input, ctx) => {
      staged++;
      await stageHook?.({ input, ctx, serverDir, put });
      const output = path.join(ctx.stageDir, "server");
      await put(output, newArgs, "-cp libraries/new.jar example.Main\n");
      await put(output, "libraries/new.jar", "new runtime library");
      await put(output, "user_jvm_args.txt", "installer defaults");
      await put(
        output,
        "run.bat",
        `java @user_jvm_args.txt @${newArgs} %*\r\n`,
      );
      return {
        stageDir: output,
        files: [
          { path: newArgs },
          { path: "libraries/new.jar" },
          { path: "user_jvm_args.txt", preserveExisting: true },
          { path: "run.bat", preserveExisting: true },
        ],
        configuration: {
          software: "NeoForge",
          version: "21.1.251",
          launchType: "java-args",
          launchArgs: ["@user_jvm_args.txt", `@${newArgs}`, "nogui"],
          launchScript: "",
          launchExecutable: "",
          jar: "",
        },
        summary: { provider: "neoforge", version: "1.21.1", build: "21.1.251" },
      };
    },
  };
  const boot = async () => {
    panel = await createFleet({
      dataDir,
      createDefaultServer: false,
      scheduler: false,
      useEnvironment: false,
      versionsService,
      extraProviders: [],
      publicAddress: { resolve: async () => null },
      telemetry: { reset() {}, sample: async () => null },
      spawnServer: () =>
        assert.fail("Runtime update tests must not launch a real server"),
    });
    listener = await new Promise((resolve) => {
      const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
    });
  };
  const close = async () => {
    await panel.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  };
  t.after(async () => {
    if (panel && listener) await close();
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-runtime-api-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = async (route, options = {}) => {
    const response = await fetch(
      `http://127.0.0.1:${listener.address().port}${route}`,
      {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(id ? { "X-Server-Id": id } : {}),
          ...options.headers,
        },
      },
    );
    return { status: response.status, body: await response.json() };
  };
  await boot();
  const imported = await request(
    "/api/server-import",
    json("POST", {
      directory: serverDir,
      launchType,
      ...(launchType === "script"
        ? { launchScript: "run.bat" }
        : {
            launchArgs: [
              "-Dexample=value",
              "@user_jvm_args.txt",
              `@${oldArgs}`,
              "nogui",
            ],
          }),
    }),
  );
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  id = imported.body.server.id;
  const read = (relative) => fs.readFile(path.join(serverDir, relative));
  const assertPreserved = async () => {
    for (const [relative, bytes] of Object.entries(preserved))
      assert.deepEqual(
        await read(relative),
        Buffer.from(bytes),
        `${relative} was changed`,
      );
  };
  const finish = async (input = selection) => {
    const response = await request(
      "/api/versions/install",
      json("POST", input),
    );
    if (response.status !== 202)
      return {
        state: "rejected",
        error: response.body.error,
        status: response.status,
      };
    const deadline = performance.now() + 15_000;
    let result;
    do {
      result = (await request(`/api/versions/jobs/${response.body.id}`)).body;
      if (["complete", "failed"].includes(result.state)) return result;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
    assert.fail(`Runtime update did not finish: ${JSON.stringify(result)}`);
  };
  return {
    request,
    finish,
    serverDir,
    dataDir,
    id,
    read,
    put,
    assertPreserved,
    stages: () => staged,
    restart: async () => {
      await close();
      await boot();
    },
  };
}

for (const launchType of ["script", "java-args"]) {
  test(`imported NeoForge ${launchType} updates to the selected build and preserves server data and startup options`, async (t) => {
    const f = await fixture(t, { launchType });
    const current = (await f.request("/api/versions")).body;
    assert.equal(current.current.gameVersion, "1.21.1");
    assert.equal(current.runtimeUpdate.available, true);
    assert.equal(current.runtimeUpdate.provider, "neoforge");
    assert.equal(current.runtimeUpdate.gameVersion, "1.21.1");
    const receiptFile = path.join(
      f.dataDir,
      "instances",
      f.id,
      "launchpad",
      "installed.json",
    );
    const receipts = JSON.stringify([
      {
        provider: "modrinth",
        projectId: "existing-pack",
        title: "Existing modpack",
        pack: true,
      },
    ]);
    await fs.writeFile(receiptFile, receipts);
    await f.restart();
    const before = (await f.request("/api/servers")).body.servers[0];
    const result = await f.finish();
    assert.equal(result.state, "complete", result.error);
    assert.equal(f.stages(), 1);
    await f.assertPreserved();
    assert.equal(
      (await f.read("libraries/new.jar")).toString(),
      "new runtime library",
    );
    assert.equal(await fs.readFile(receiptFile, "utf8"), receipts);
    const updated = (await f.request("/api/servers")).body.servers[0];
    for (const field of [
      "javaPath",
      "launchType",
      "launchScript",
      "configuredMemoryLimitMB",
      "port",
      "name",
      "source",
    ])
      assert.equal(updated[field], before[field], field);
    if (launchType === "script")
      assert.equal(
        (await f.read("run.bat")).toString(),
        originalScript.replace(oldArgs, newArgs),
      );
    else {
      assert.deepEqual(
        updated.launchArgs,
        before.launchArgs.map((arg) =>
          arg === `@${oldArgs}` ? `@${newArgs}` : arg,
        ),
      );
      assert.equal((await f.read("run.bat")).toString(), originalScript);
    }
    await f.restart();
    const restored = (await f.request("/api/versions")).body.current;
    assert.equal(restored.software, "NeoForge");
    assert.equal(restored.version, "21.1.251");
    assert.equal(restored.status, "offline");
    await f.assertPreserved();
  });
}

test("runtime updates reject loader and Minecraft switches before downloading, and reject conflicting install modes", async (t) => {
  const f = await fixture(t);
  for (const changes of [
    { provider: "fabric" },
    { version: "1.20.1" },
    { cleanInstall: true },
  ]) {
    const result = await f.finish({ ...selection, ...changes });
    assert.notEqual(result.state, "complete");
    assert.ok(result.error);
    assert.equal(f.stages(), 0);
    await f.assertPreserved();
    assert.equal((await f.read("run.bat")).toString(), originalScript);
  }
});

test("a changed imported launcher invalidates an in-flight update before runtime files are promoted", async (t) => {
  const changed = "@echo off\r\ncall custom-launcher.bat\r\n";
  const f = await fixture(t, {
    stageHook: async ({ serverDir, put }) => put(serverDir, "run.bat", changed),
  });
  assert.equal(
    (await f.request("/api/versions")).body.runtimeUpdate.available,
    true,
  );
  const result = await f.finish();
  assert.equal(result.state, "failed");
  assert.ok(result.error);
  await f.assertPreserved();
  assert.equal((await f.read("run.bat")).toString(), changed);
  await assert.rejects(f.read("libraries/new.jar"), { code: "ENOENT" });
});

test("unsupported imported wrappers are not advertised or accepted for an automatic runtime update", async (t) => {
  const f = await fixture(t, {
    customScript: "@echo off\r\ncall custom-launcher.bat\r\n",
  });
  assert.equal(
    (await f.request("/api/versions")).body.runtimeUpdate.available,
    false,
  );
  const result = await f.finish();
  assert.notEqual(result.state, "complete");
  assert.equal(f.stages(), 0);
  await f.assertPreserved();
});
