import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { inspectBundledDependencies } from "./launchpad-bundled.mjs";

// Small deterministic archives, including malformed metadata, need no ZIP CLI.
function zip(entries) {
  const chunks = [],
    central = [];
  let offset = 0;
  for (const [filename, value, options = {}] of entries) {
    const name = Buffer.from(filename),
      data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let encoded = options.compress ? deflateRawSync(data) : data;
    if (options.encrypted) encoded = Buffer.concat([Buffer.alloc(12), encoded]);
    const checksum = (options.crc ?? crc32(data)) >>> 0;
    const method = options.compress ? 8 : 0;
    const flags = options.encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(encoded.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const row = Buffer.alloc(46);
    row.writeUInt32LE(0x02014b50);
    row.writeUInt16LE(0x314, 4);
    row.writeUInt16LE(20, 6);
    row.writeUInt16LE(flags, 8);
    row.writeUInt16LE(method, 10);
    row.writeUInt32LE(checksum, 16);
    row.writeUInt32LE(encoded.length, 20);
    row.writeUInt32LE(data.length, 24);
    row.writeUInt16LE(name.length, 28);
    row.writeUInt32LE(((options.mode ?? 0o100644) << 16) >>> 0, 38);
    row.writeUInt32LE(offset, 42);
    chunks.push(local, name, encoded);
    central.push(row, name);
    offset += local.length + name.length + encoded.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
const json = JSON.stringify;
const hashes = (buffer) =>
  Object.fromEntries(
    ["sha512", "sha1"].map((algorithm) => [
      algorithm,
      createHash(algorithm).update(buffer).digest("hex"),
    ]),
  );
const nested = (
  title = "Shared Settings",
  id = "shared_settings",
  version = "1.2.3",
) =>
  zip([
    [
      "META-INF/neoforge.mods.toml",
      `[[mods]]\nmodId = '${id}'\ndisplayName = "${title}"\nversion = "${version}"\n`,
    ],
  ]);
const fabricParent = (files) =>
  zip([
    [
      "fabric.mod.json",
      json({
        schemaVersion: 1,
        id: "parent_mod",
        version: "1.0",
        jars: files.map(([file]) => ({ file })),
      }),
    ],
    ...files,
  ]);

async function fixture(t) {
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, "mc-bundled-test-"));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved).toLowerCase(), base.toLowerCase());
    assert.ok(path.basename(resolved).startsWith("mc-bundled-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const archive = path.join(root, "verified-review.jar");
  return {
    root,
    archive,
    async inspect(bytes, options) {
      await fs.writeFile(archive, bytes);
      return inspectBundledDependencies(archive, {
        loader: "fabric",
        ...options,
      });
    },
  };
}

test("Forge and NeoForge JarJar declarations reveal nested mod names, versions and exact file identities without extracting", async (t) => {
  const f = await fixture(t);
  for (const filename of [
    "META-INF/neoforge.mods.toml",
    "META-INF/mods.toml",
  ]) {
    const child = zip([
      [
        "META-INF/MANIFEST.MF",
        "Manifest-Version: 1.0\r\nImplementation-Version: 1.2.3\r\n\r\n",
      ],
      [
        filename,
        `[[mods]]\nmodId = 'shared_settings'\ndisplayName = "Shared Settings"\nversion = "${"${file.jarVersion}"}"\ndescription = '''\n[[mods]]\nmodId = "spoofed_id"\ndisplayName = "Spoofed"\n'''\n`,
      ],
    ]);
    const archive = zip([
      [
        "META-INF/jarjar/metadata.json",
        json({
          jars: [
            {
              path: "META-INF/jarjar/settings.jar",
              identifier: { artifact: "fallback-artifact" },
              version: { artifactVersion: "0.1" },
            },
          ],
        }),
      ],
      ["META-INF/jarjar/settings.jar", child, { compress: true }],
      ["undeclared.jar", "This is not a ZIP and must not be inspected."],
    ]);
    let fingerprintInput;
    const result = await f.inspect(archive, {
      loader: filename.includes("neoforge") ? "neoforge" : "forge",
      fingerprint(bytes) {
        fingerprintInput = Buffer.from(bytes);
        return 123456;
      },
    });
    assert.deepEqual(result, [
      {
        title: "Shared Settings",
        version: "1.2.3",
        modId: "shared_settings",
        path: "META-INF/jarjar/settings.jar",
        ...hashes(child),
        serverCompatible: true,
        fingerprint: 123456,
      },
    ]);
    assert.deepEqual(fingerprintInput, child);
    assert.deepEqual(await fs.readFile(f.archive), archive);
    assert.deepEqual(await fs.readdir(f.root), ["verified-review.jar"]);
  }
});

test("Fabric and Quilt declared nested JARs use their loader metadata and support bounded recursion", async (t) => {
  const f = await fixture(t);
  const leaf = zip([
    [
      "fabric.mod.json",
      json({
        schemaVersion: 1,
        id: "leaf_lib",
        name: "Leaf Library",
        version: "2.4",
      }),
    ],
  ]);
  const child = zip([
    [
      "quilt.mod.json",
      json({
        schema_version: 1,
        quilt_loader: {
          id: "quilt_lib",
          version: "3.0",
          metadata: { name: "Quilt Library" },
          jars: ["inside/leaf.jar"],
        },
      }),
    ],
    ["inside/leaf.jar", leaf],
  ]);
  const result = await f.inspect(fabricParent([["lib/quilt.jar", child]]), {
    loader: "quilt",
  });
  assert.deepEqual(result, [
    {
      title: "Quilt Library",
      version: "3.0",
      modId: "quilt_lib",
      path: "lib/quilt.jar",
      ...hashes(child),
      serverCompatible: true,
    },
    {
      title: "Leaf Library",
      version: "2.4",
      modId: "leaf_lib",
      path: "lib/quilt.jar!/inside/leaf.jar",
      ...hashes(leaf),
      serverCompatible: true,
    },
  ]);
});

test("manifest and JarJar names are display fallbacks and undeclared archives are ignored", async (t) => {
  const f = await fixture(t);
  const plain = zip([
    [
      "META-INF/MANIFEST.MF",
      "Manifest-Version: 1.0\r\nSpecification-Title: Shared \r\n Library\r\nImplementation-Version: 4.5\r\n\r\nName: unrelated.class\r\nSpecification-Title: Wrong Name\r\n",
    ],
  ]);
  const other = zip([]);
  const result = await f.inspect(
    zip([
      [
        "META-INF/jarjar/metadata.json",
        json({
          jars: [
            { path: "one.jar" },
            {
              path: "two.jar",
              identifier: { artifact: "other-library" },
              version: { artifactVersion: "6.7" },
            },
          ],
        }),
      ],
      ["one.jar", plain],
      ["two.jar", other],
      ["not-declared.jar", "invalid ZIP"],
    ]),
    { loader: "neoforge" },
  );
  assert.equal(result[0].title, "Shared Library");
  assert.equal(result[0].version, "4.5");
  assert.equal(result[0].modId, undefined);
  assert.equal(result[1].title, "other-library");
  assert.equal(result[1].version, "6.7");
  assert.deepEqual(await f.inspect(zip([["unlisted.jar", nested()]])), []);
});

test("universal archives only expose the selected loader's declared dependencies at every nested level", async (t) => {
  const f = await fixture(t);
  const universal = (files) =>
    zip([
      [
        "META-INF/jarjar/metadata.json",
        json({ jars: [{ path: files[0][0] }] }),
      ],
      [
        "META-INF/neoforge.mods.toml",
        '[[mods]]\nmodId="neo_library"\nversion="1"\n',
      ],
      ["META-INF/mods.toml", '[[mods]]\nmodId="forge_library"\nversion="2"\n'],
      [
        "fabric.mod.json",
        json({
          schemaVersion: 1,
          id: "fabric_library",
          version: "3",
          jars: [{ file: files[1][0] }],
        }),
      ],
      [
        "quilt.mod.json",
        json({
          schema_version: 1,
          quilt_loader: {
            id: "quilt_library",
            version: "4",
            jars: [files[2][0]],
          },
        }),
      ],
      ...files,
    ]);
  const child = universal([
    ["deep/neo.jar", zip([])],
    ["deep/fabric.jar", zip([])],
    ["deep/quilt.jar", zip([])],
  ]);
  const outer = universal([
    ["neo.jar", child],
    ["fabric.jar", child],
    ["quilt.jar", child],
  ]);
  for (const [loader, filename, modId] of [
    ["neoforge", "neo", "neo_library"],
    ["forge", "neo", "forge_library"],
    ["fabric", "fabric", "fabric_library"],
    ["quilt", "quilt", "quilt_library"],
  ]) {
    const result = await f.inspect(outer, { loader });
    assert.deepEqual(
      result.map((row) => row.path),
      [`${filename}.jar`, `${filename}.jar!/deep/${filename}.jar`],
      loader,
    );
    assert.equal(result[0].modId, modId, loader);
  }
  await assert.rejects(
    inspectBundledDependencies(f.archive),
    /supported mod loader/,
  );
});

test("client-only Fabric and Quilt bundles remain visible but cannot satisfy a server dependency, including descendants", async (t) => {
  const f = await fixture(t);
  const grandchild = zip([
    [
      "fabric.mod.json",
      json({
        schemaVersion: 1,
        id: "grandchild",
        name: "Child of a client library",
        version: "1",
        environment: "server",
      }),
    ],
  ]);
  for (const loader of ["fabric", "quilt"]) {
    const client = zip([
      [
        loader === "fabric" ? "fabric.mod.json" : "quilt.mod.json",
        json(
          loader === "fabric"
            ? {
                schemaVersion: 1,
                id: "client_lib",
                version: "1",
                environment: "client",
                jars: [{ file: "nested.jar" }],
              }
            : {
                schema_version: 1,
                quilt_loader: {
                  id: "client_lib",
                  version: "1",
                  jars: ["nested.jar"],
                },
                minecraft: { environment: "client" },
              },
        ),
      ],
      ["nested.jar", grandchild],
    ]);
    const result = await f.inspect(
      fabricParent([
        ["client.jar", client],
        ["server.jar", grandchild],
      ]),
      { loader },
    );
    assert.deepEqual(
      result.map((row) => row.serverCompatible),
      [false, false, true],
      loader,
    );
    assert.equal(result[0].modId, "client_lib", loader);
  }
});

test("inspection rejects unsafe, duplicate, conflicting, encrypted and nonregular ZIP entries even outside declared files", async (t) => {
  const f = await fixture(t);
  const cases = [
    [["../escape", "x"]],
    [["/absolute", "x"]],
    [["back\\slash", "x"]],
    [
      ["same", "a"],
      ["SAME", "b"],
    ],
    [
      ["file", "a"],
      ["file/child", "b"],
    ],
    [
      ["file/child", "b"],
      ["file", "a"],
    ],
    [["link", "target", { mode: 0o120777 }]],
    [["device", "", { mode: 0o020600 }]],
    [["secret", "x", { encrypted: true }]],
  ];
  for (const entries of cases)
    await assert.rejects(
      f.inspect(zip(entries)),
      /unsafe|invalid|absolute|duplicate|conflicting|links|special|[Ee]ncrypted/,
    );
});

test("declarations must identify existing regular JAR entries and valid bounded loader metadata", async (t) => {
  const f = await fixture(t);
  const cases = [
    zip([["fabric.mod.json", json({ jars: [{ file: "absent.jar" }] })]]),
    zip([
      ["fabric.mod.json", json({ jars: [{ file: "folder.jar" }] })],
      ["folder.jar/", "", { mode: 0o040755 }],
    ]),
    zip([["fabric.mod.json", json({ jars: [{ file: "../outside.jar" }] })]]),
    zip([["fabric.mod.json", json({ jars: "not-an-array" })]]),
    zip([["META-INF/jarjar/metadata.json", "{malformed"]]),
    zip([["fabric.mod.json", "[]"]]),
    fabricParent([["broken.jar", "not a ZIP"]]),
  ];
  for (const archive of cases) await assert.rejects(f.inspect(archive));
  await assert.rejects(
    f.inspect(
      zip([
        ["quilt.mod.json", json({ quilt_loader: { jars: ["not-a-jar.txt"] } })],
      ]),
      { loader: "quilt" },
    ),
    /not a JAR/,
  );
  const child = nested();
  await assert.rejects(
    f.inspect(
      zip([
        ["fabric.mod.json", json({ jars: [{ file: "child.jar" }] })],
        ["child.jar", child, { crc: crc32(child) ^ 1 }],
      ]),
    ),
    /CRC/,
  );
});

test("metadata, nested file, traversal depth, archive count and central directory limits are enforced", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.inspect(
      zip([
        ["fabric.mod.json", " ".repeat(512 * 1024 + 1), { compress: true }],
      ]),
    ),
    /inspection limit/,
  );
  await assert.rejects(
    f.inspect(
      fabricParent([
        ["large.jar", Buffer.alloc(16 * 1024 ** 2 + 1), { compress: true }],
      ]),
    ),
    /inspection limit/,
  );
  await assert.rejects(
    f.inspect(
      fabricParent(
        Array.from({ length: 65 }, (_, index) => [`${index}.jar`, zip([])]),
      ),
    ),
    /64 bundled/,
  );
  let chain = nested();
  for (let index = 0; index < 4; index++)
    chain = fabricParent([["next.jar", chain]]);
  await assert.rejects(f.inspect(chain), /three nested/);
  await assert.rejects(
    f.inspect(
      zip(Array.from({ length: 10001 }, (_, index) => [`entry-${index}`, ""])),
    ),
    /10,000 ZIP entries/,
  );
});

test("the total inflated read budget applies across distinct nested archives", async (t) => {
  const f = await fixture(t);
  const child = zip([["padding.bin", Buffer.alloc(15 * 1024 ** 2)]]);
  await assert.rejects(
    f.inspect(
      fabricParent(
        Array.from({ length: 9 }, (_, index) => [
          `${index}.jar`,
          child,
          { compress: true },
        ]),
      ),
    ),
    /128 MB/,
  );
});

test("cancellation closes staged archives without extraction or partial results", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController(),
    reason = new Error("review cancelled");
  const archive = fabricParent([
    ["first.jar", nested()],
    ["second.jar", nested("Second Library")],
  ]);
  await assert.rejects(
    f.inspect(archive, {
      signal: controller.signal,
      fingerprint() {
        controller.abort(reason);
        return 1;
      },
    }),
    (error) => error === reason,
  );
  await assert.rejects(
    inspectBundledDependencies(f.archive, {
      signal: controller.signal,
      loader: "fabric",
    }),
    (error) => error === reason,
  );
  // The same file remains available for the next review after cancellation.
  assert.equal(
    (await inspectBundledDependencies(f.archive, { loader: "fabric" })).length,
    2,
  );
  assert.deepEqual(await fs.readdir(f.root), ["verified-review.jar"]);
  await assert.rejects(
    inspectBundledDependencies(f.root, { loader: "fabric" }),
    /regular staged JAR/,
  );
});
