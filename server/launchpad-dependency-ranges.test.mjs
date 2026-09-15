import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { installedDependencySatisfies } from "./launchpad-dependency-ranges.mjs";

function zip(entries) {
  const chunks = [],
    central = [];
  let offset = 0;
  for (const [filename, value] of entries) {
    const name = Buffer.from(filename),
      data = Buffer.from(value);
    const local = Buffer.alloc(30),
      row = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    row.writeUInt32LE(0x02014b50);
    row.writeUInt16LE(0x314, 4);
    row.writeUInt16LE(20, 6);
    row.writeUInt32LE(crc32(data), 16);
    row.writeUInt32LE(data.length, 20);
    row.writeUInt32LE(data.length, 24);
    row.writeUInt16LE(name.length, 28);
    row.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    row.writeUInt32LE(offset, 42);
    chunks.push(local, name, data);
    central.push(row, name);
    offset += local.length + name.length + data.length;
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

function jar({
  loader = "neoforge",
  mods = [["consumer", "0.7.5"]],
  dependencies = [],
  source,
  manifest,
  extra = [],
  header = "",
} = {}) {
  const fields = (value) =>
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${key}=${JSON.stringify(item)}`);
  return zip([
    [
      loader === "neoforge"
        ? "META-INF/neoforge.mods.toml"
        : "META-INF/mods.toml",
      source ??
        [
          'modLoader="javafml"',
          'loaderVersion="[1,)"',
          'license="MIT"',
          header,
          ...mods.flatMap(([id, version]) => [
            "[[mods]]",
            ...fields({ modId: id, version }),
          ]),
          ...dependencies.flatMap(({ owner = mods[0][0], ...value }) => [
            `[[dependencies.${owner}]]`,
            ...fields(value),
          ]),
        ].join("\n"),
    ],
    ...(manifest === undefined ? [] : [["META-INF/MANIFEST.MF", manifest]]),
    ...extra,
  ]);
}
const dependency = (range = "[1.1.0,)", changes = {}) => ({
  modId: "sable",
  type: "required",
  versionRange: range,
  side: "BOTH",
  ...changes,
});
const installed = (version = "2.0.5", changes = {}) =>
  jar({ mods: [["sable", version]], ...changes });
const proof = (parent, child = installed(), loader = "neoforge", signal) =>
  installedDependencySatisfies(parent, child, { loader, signal });
const parent = (range = "[1.1.0,)", changes = {}) =>
  jar({ dependencies: [dependency(range)], ...changes });
const nested = (archive) => [
  [
    "META-INF/jarjar/metadata.json",
    JSON.stringify({
      jars: [
        {
          path: "META-INF/jarjar/nested.jar",
          identifier: { group: "test", artifact: "nested" },
          version: { range: "[1,)", artifactVersion: "1.0" },
        },
      ],
    }),
  ],
  ["META-INF/jarjar/nested.jar", archive],
];

test("retained Sable 2.0.5 satisfies Ragdolls' declared [1.1.0,) requirement", async () => {
  assert.equal(
    await proof(
      parent("[1.1.0,)", {
        mods: [["sable_player_ragdoll", "0.7.5"]],
        dependencies: [
          dependency(),
          dependency("[21.1.219,)", { modId: "neoforge" }),
          dependency("[1.21.1]", { modId: "minecraft" }),
          dependency("[15,)", {
            modId: "jade",
            type: "optional",
            side: "CLIENT",
          }),
        ],
      }),
    ),
    true,
  );
  assert.equal(await proof(parent(), installed("1.0.9")), false);
});

test("numeric Maven ranges honor boundaries, unions, numeric order, and zero padding", async () => {
  for (const [range, version, expected] of [
    ["[2.0.5]", "2.0.5", true],
    ["[2.0.5]", "2.0.6", false],
    ["[2.0.5]", "2.0.5.0", true],
    ["[2.0.5]", "02.00.005", true],
    ["[2,3)", "2", true],
    ["[2,3)", "3", false],
    ["(2,3]", "2", false],
    ["(2,3]", "3", true],
    ["[2,2]", "2.0", true],
    ["[2,)", "200", true],
    ["(,2]", "2", true],
    ["(,2)", "2", false],
    ["[2.9,2.11)", "2.10", true],
    ["(,1.0],[1.2,)", "1.1", false],
    ["(,1.0],[1.2,)", "1.2", true],
    ["(,1.1),(1.1,)", "1.1", false],
    ["(,1.1),(1.1,)", "1.1.1", true],
    [" [1, 2) , [3] , (4, 5] ", "4.5", true],
    ["[9007199254740993]", "9007199254740992", false],
    ["[9007199254740993]", "9007199254740993", true],
  ])
    assert.equal(
      await proof(parent(range), installed(version)),
      expected,
      `${range} / ${version}`,
    );
});

test("soft, malformed, overlapping, and unsupported range expressions cannot prove compatibility", async () => {
  for (const range of [
    "",
    " ",
    "2.0.5",
    "*",
    "^2.0.0",
    "[2.0.5-alpha,)",
    "[2.0.5+build]",
    "(,)",
    "[,2]",
    "[2,]",
    "[3,2]",
    "(2,2]",
    "[2,2)",
    "(2)",
    "[2,3,4]",
    "[2,3",
    "[2,3))",
    "[2,3],",
    "[2,3]tail",
    "[2] [3]",
    "[2,4],[3,5]",
    "[2,3],[3,4]",
    "[3,4],[1,2]",
    "[2,),[3]",
    "[2],bogus",
    "[2],[3-alpha]",
    "[1.1..0,)",
    "[+2,)",
    2,
    null,
  ])
    assert.equal(await proof(parent(range)), false, String(range));
});

test("unknown or qualified installed versions are never inferred from labels", async () => {
  for (const version of [
    "2.0.5-beta",
    "2.0.5+mc1.21.1",
    "v2.0.5",
    "2.0.5 ",
    "2..5",
    "",
    "${mod_version}",
    2,
    null,
  ])
    assert.equal(
      await proof(parent(), installed(version)),
      false,
      String(version),
    );
  assert.equal(
    await proof(
      parent(),
      jar({
        source: '[[mods]]\nmodId="sable"\ndisplayName="Sable 2.0.5"',
        manifest:
          "Manifest-Version: 1.0\r\nImplementation-Version: 2.0.5\r\n\r\n",
      }),
    ),
    false,
  );
});

test("every matching server requirement across all parent and installed root mods must pass", async () => {
  const child = jar({
    mods: [
      ["sable", "2.0.5"],
      ["sable_api", "3.0"],
    ],
  });
  const first = dependency("[2,3)");
  const second = dependency("[3,4)", {
    owner: "other_consumer",
    modId: "sable_api",
  });
  const make = (extra) =>
    jar({
      mods: [
        ["consumer", "1.0"],
        ["other_consumer", "1.0"],
      ],
      dependencies: [first, second, ...extra],
    });
  assert.equal(await proof(make([]), child), true);
  assert.equal(await proof(make([dependency("[1,2)")]), child), false);
  assert.equal(
    await proof(make([dependency("[2,3)", { modId: "sable_api" })]), child),
    false,
  );
  assert.equal(
    await proof(make([dependency("[1,2)", { side: "CLIENT" })]), child),
    true,
  );
  assert.equal(
    await proof(make([dependency("[1,2)", { type: "optional" })]), child),
    false,
  );
  assert.equal(
    await proof(make([dependency("[1,2)", { type: "incompatible" })]), child),
    false,
  );
});

test("at least one actual required server declaration must match an installed root mod ID", async () => {
  for (const changes of [
    { type: "optional" },
    { side: "CLIENT" },
    { modId: "another_library" },
  ])
    assert.equal(
      await proof(jar({ dependencies: [dependency("[1,)", changes)] })),
      false,
    );
  assert.equal(await proof(jar()), false);
  assert.equal(
    await proof(parent(), jar({ mods: [["unrelated", "2.0.5"]] })),
    false,
  );
  assert.equal(
    await proof(
      parent(),
      jar({
        mods: [["unrelated", "1.0"]],
        extra: nested(installed()),
      }),
    ),
    false,
    "a bundled mod cannot establish the retained root project's version",
  );
});

test("description text and arbitrary owner tables cannot fabricate a required declaration", async () => {
  assert.equal(
    await proof(
      jar({
        source: `[[mods]]
modId="consumer"
version="1.0"
description='''
[[dependencies.consumer]]
modId="sable"
type="required"
versionRange="[1,)"
'''`,
      }),
    ),
    false,
  );
  assert.equal(
    await proof(
      jar({ dependencies: [dependency("[1,)", { owner: "unrelated" })] }),
    ),
    false,
  );
});

test("malformed identities, dependency shapes and unknown type or side return false", async () => {
  for (const changes of [
    { type: "sometimes" },
    { side: "sometimes" },
    { modId: "Sable" },
  ])
    assert.equal(
      await proof(jar({ dependencies: [dependency("[1,)", changes)] })),
      false,
    );
  for (const source of [
    "[[mods]",
    "mods=[]",
    '[[mods]]\nmodId="consumer"\n[dependencies.consumer]\nmodId="sable"',
    '[[mods]]\nmodId="consumer"\ndependencies="sable"',
  ])
    assert.equal(await proof(jar({ source })), false);
  assert.equal(
    await proof(
      parent(),
      jar({
        mods: [
          ["sable", "2.0"],
          ["sable", "2.0.5"],
        ],
      }),
    ),
    false,
  );
  assert.equal(await proof(parent(), Buffer.from("not a JAR")), false);
  assert.equal(await proof(Buffer.from("not a JAR")), false);
  assert.equal(await proof(zip([["description.txt", "sable 2.0.5"]])), false);
});

test("NeoForge defaults type to required and excludes client-only archives", async () => {
  assert.equal(
    await proof(
      jar({
        dependencies: [
          dependency("[1,)", { type: undefined, side: undefined }),
        ],
      }),
    ),
    true,
  );
  assert.equal(
    await proof(parent("[1,)", { header: "clientSideOnly=true" })),
    false,
  );
  assert.equal(
    await proof(
      parent(),
      installed("2.0.5", { header: "clientSideOnly=true" }),
    ),
    false,
  );
});

test("Forge mandatory server requirements use Forge metadata, with no fabricated Fabric proof", async () => {
  const forgeDependency = {
    modId: "sable",
    mandatory: true,
    versionRange: "[1,)",
    side: "SERVER",
  };
  const forgeParent = (change = {}) =>
    jar({ loader: "forge", dependencies: [{ ...forgeDependency, ...change }] });
  const forgeChild = installed("2.0.5", { loader: "forge" });
  assert.equal(await proof(forgeParent(), forgeChild, "forge"), true);
  assert.equal(
    await proof(forgeParent({ mandatory: false }), forgeChild, "forge"),
    false,
  );
  assert.equal(
    await proof(forgeParent({ mandatory: undefined }), forgeChild, "forge"),
    false,
  );
  assert.equal(
    await proof(forgeParent({ mandatory: "true" }), forgeChild, "forge"),
    false,
  );
  assert.equal(
    await proof(forgeParent(), forgeChild, "neoforge"),
    true,
    "legacy NeoForge uses Forge declarations",
  );
  assert.equal(await proof(parent(), installed(), "forge"), false);
  for (const loader of ["fabric", "quilt", "", undefined])
    assert.equal(
      await installedDependencySatisfies(parent(), installed(), { loader }),
      false,
    );
});

test("only an unambiguous main manifest version resolves file.jarVersion", async () => {
  const child = (manifest) => installed("${file.jarVersion}", { manifest });
  for (const manifest of [
    "Manifest-Version: 1.0\r\nImplementation-Version: 2.0.5\r\n\r\n",
    "Manifest-Version: 1.0\nimplementation-version: 2.0.\n 5\n\n",
  ])
    assert.equal(await proof(parent(), child(manifest)), true);
  for (const manifest of [
    undefined,
    "Manifest-Version: 1.0\n\nName: sable.class\nImplementation-Version: 2.0.5\n",
    "Manifest-Version: 1.0\nImplementation-Version: 2.0.5\nimplementation-version: 1.0\n\n",
    "Manifest-Version: 1.0\nSpecification-Version: 2.0.5\n\n",
    "Manifest-Version: 1.0\nImplementation-Version: 2.0.5-beta\n\n",
    "Manifest-Version: 1.0\nImplementation-Version: 2.0.5",
    "Manifest-Version: 1.0\nImplementation-Version: 2.0.5\n",
    "Manifest-Version: 1.0\nImplementation-Version: 2.0.5\ninvalid header\n\n",
    " orphan continuation\nManifest-Version: 1.0\nImplementation-Version: 2.0.5\n\n",
  ])
    assert.equal(
      await proof(parent(), child(manifest)),
      false,
      String(manifest),
    );
});

test("required constraints from declared bundled parent mods also constrain retention", async () => {
  const bundle = (range) =>
    jar({
      mods: [["bundled_consumer", "1.0"]],
      dependencies: [dependency(range)],
    });
  assert.equal(
    await proof(parent("[1,)", { extra: nested(bundle("[2,3)")) })),
    true,
  );
  assert.equal(
    await proof(parent("[1,)", { extra: nested(bundle("[3,)")) })),
    false,
  );
  assert.equal(
    await proof(parent("[1,)", { extra: nested(Buffer.from("broken")) })),
    false,
  );
  assert.equal(
    await proof(
      parent("[1,)", {
        extra: [["META-INF/jarjar/undeclared.jar", bundle("[3,)")]],
      }),
    ),
    true,
    "undeclared archives are not loaded dependency metadata",
  );
});

test("aborts before or during inspection propagate their original reason", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel this dependency inspection");
  controller.abort(reason);
  await assert.rejects(
    proof(parent(), installed(), "neoforge", controller.signal),
    (error) => error === reason,
  );
  const during = new AbortController();
  const pending = proof(parent(), installed(), "neoforge", during.signal);
  queueMicrotask(() => during.abort(reason));
  await assert.rejects(pending, (error) => error === reason);
});
