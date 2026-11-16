import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { installedMinecraftMetadata } from "./installed-minecraft.mjs";
import { safePath, createPanel } from "./index.mjs";
import { inspectJavaArguments } from "./import.mjs";

function zip(entries) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name),
      data = Buffer.from(value),
      header = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(header, filename, data);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "mc-installed-meta-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-installed-meta-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    read: (configuration, detected = {}) =>
      installedMinecraftMetadata({
        serverDir: root,
        safePath,
        configuration,
        detected,
      }),
  };
}
test("an imported Fabric launcher identifies the release from its own install.properties, not its filename", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.root, "unrelated-name.jar"),
    zip([
      [
        "install.properties",
        "game-version=1.21.1\nfabric-loader-version=0.16.14\n",
      ],
    ]),
  );
  assert.deepEqual(
    await f.read({
      launchType: "jar",
      jar: "unrelated-name.jar",
      software: "Java",
    }),
    { software: "Fabric", version: "0.16.14", gameVersion: "1.21.1" },
  );
});
for (const loader of ["fabric", "quilt"])
  test(`${loader} uses the configured vanilla JAR's version.json`, async (t) => {
    const f = await fixture(t),
      software = loader === "fabric" ? "Fabric" : "Quilt";
    await fs.writeFile(
      path.join(f.root, "launcher.jar"),
      zip([[`${loader}-server-launch.properties`, "launch.mainClass=ignored"]]),
    );
    await fs.writeFile(
      path.join(f.root, `${loader}-server-launcher.properties`),
      "serverJar=renamed.jar\n",
    );
    await fs.writeFile(
      path.join(f.root, "renamed.jar"),
      zip([["version.json", '{"id":"1.20.1"}']]),
    );
    assert.deepEqual(await f.read({ launchType: "jar", jar: "launcher.jar" }), {
      software,
      gameVersion: "1.20.1",
    });
  });
test("expanded launch arguments retain authoritative Minecraft overrides internally", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.root, "launcher.jar"),
    zip([["fabric-server-launch.properties", "launch.mainClass=ignored"]]),
  );
  await fs.writeFile(
    path.join(f.root, "launch.txt"),
    "-Dfabric.gameVersion=1.21.1 -Dsecret=value -jar launcher.jar nogui",
  );
  const configuration = {
    launchType: "java-args",
    launchArgs: ["@launch.txt"],
    software: "Fabric",
  };
  const detected = await inspectJavaArguments(f.root, configuration.launchArgs);
  assert.equal((await f.read(configuration, detected)).gameVersion, "1.21.1");
  const panel = await createPanel({
    dataDir: path.join(f.root, "private"),
    serverDir: path.join(f.root, "server"),
    mode: "live",
    useEnvironment: false,
    scheduler: false,
  });
  try {
    assert.equal("expandedArgs" in panel.descriptor(), false);
  } finally {
    await panel.close();
  }
});
test("stale loader files and guessed JAR names do not misidentify an unknown server", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.root, "fabric-1.21.1.jar"),
    zip([["README.txt", "fabric server 1.21.1"]]),
  );
  await fs.writeFile(
    path.join(f.root, "fabric-server-launcher.properties"),
    "serverJar=server.jar\n",
  );
  await fs.writeFile(
    path.join(f.root, "server.jar"),
    zip([["version.json", '{"id":"1.20.1"}']]),
  );
  assert.deepEqual(
    await f.read({
      launchType: "jar",
      jar: "fabric-1.21.1.jar",
      software: "Java",
    }),
    {},
  );
});
test("unsafe or ambiguous launcher metadata remains unidentified", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.root, "launcher.jar"),
    zip([
      [
        "install.properties",
        "fabric-loader-version=0.16.14\ngame-version=1.21.1",
      ],
      [
        "install.properties",
        "fabric-loader-version=0.16.14\ngame-version=1.20.1",
      ],
    ]),
  );
  assert.deepEqual(
    await f.read({ launchType: "jar", jar: "launcher.jar" }),
    {},
  );
  await fs.writeFile(
    path.join(f.root, "launcher.jar"),
    zip([["quilt-server-launch.properties", "launch.mainClass=ignored"]]),
  );
  await fs.writeFile(
    path.join(f.root, "quilt-server-launcher.properties"),
    "serverJar=../outside.jar\n",
  );
  assert.equal(
    (await f.read({ launchType: "jar", jar: "launcher.jar" })).gameVersion,
    undefined,
  );
});

test("oversized metadata and unsupported launchers cannot supply inferred releases", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.root, "launcher.jar"),
    zip([
      [
        "install.properties",
        `fabric-loader-version=0.16.14\ngame-version=1.21.1\n${"x".repeat(256 * 1024)}`,
      ],
    ]),
  );
  assert.deepEqual(
    await f.read({ launchType: "jar", jar: "launcher.jar" }),
    {},
  );
  await fs.writeFile(
    path.join(f.root, "server.jar"),
    zip([["version.json", '{"id":"1.21.1"}']]),
  );
  for (const launchType of ["script", "executable"])
    assert.deepEqual(
      await f.read({
        launchType,
        software: "Fabric",
        launchArgs: ["-Dfabric.gameVersion=1.21.1"],
      }),
      {},
    );
});
