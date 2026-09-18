import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { inspectInstalledMod } from "./launchpad-mod-metadata.mjs";

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
const descriptor = (id = "example_mod", extra = "", language = "javafml") =>
  `modLoader="${language}"\nloaderVersion="[1,)"\nlicense="MIT"\n[[mods]]\nmodId="${id}"\ndisplayName="Example mod"\nversion="1.0"\n${extra}`;
const mod = (text, loader = "neoforge") =>
  zip([
    [
      `META-INF/${loader === "neoforge" ? "neoforge.mods.toml" : "mods.toml"}`,
      text,
    ],
  ]);
const inspect = (archive, loader = "neoforge") =>
  inspectInstalledMod(archive, { loader });
const dependency = (type, extra = "") =>
  `[[dependencies.example_mod]]\nmodId="shared_library"\ntype=${JSON.stringify(type)}\n${extra}`;
const wrapper = (
  nested,
  manifest = "Manifest-Version: 1.0\r\nFMLModType: LIBRARY\r\n\r\n",
) =>
  zip([
    ["META-INF/MANIFEST.MF", manifest],
    [
      "META-INF/jarjar/metadata.json",
      JSON.stringify({ jars: [{ path: "META-INF/jarjar/language-mod.jar" }] }),
    ],
    ["META-INF/jarjar/language-mod.jar", nested],
  ]);

for (const type of ["required", "REQUIRED", "ReQuIrEd"]) {
  test(`NeoForge ${type} dependencies retain required mod IDs`, async () => {
    assert.deepEqual(
      await inspect(mod(descriptor("example_mod", dependency(type)))),
      {
        title: "Example mod",
        provided: ["example_mod"],
        required: ["shared_library"],
      },
    );
  });
}
for (const type of ["OPTIONAL", "InCompatible", "DISCOURAGED"]) {
  test(`NeoForge ${type} is not a required dependency`, async () => {
    assert.deepEqual(
      (await inspect(mod(descriptor("example_mod", dependency(type)))))
        .required,
      [],
    );
  });
}
for (const type of ["unknown", " REQUIRED ", false, 1, null, {}]) {
  test(`NeoForge rejects invalid dependency type ${JSON.stringify(type)}`, async () => {
    await assert.rejects(
      inspect(mod(descriptor("example_mod", dependency(type)))),
      /could not be read reliably|Invalid TOML/,
    );
  });
}
test("client dependencies stay excluded and required server dependencies remain checked", async () => {
  const text = descriptor(
    "example_mod",
    `${dependency("REQUIRED", 'side="CLIENT"')}\n[[dependencies.example_mod]]\nmodId="server_library"\ntype="REQUIRED"\nside="SERVER"`,
  );
  assert.deepEqual((await inspect(mod(text))).required, ["server_library"]);
});
test("Forge mandatory dependencies keep their existing behavior", async () => {
  const text = descriptor(
    "example_mod",
    '[[dependencies.example_mod]]\nmodId="required_library"\nmandatory=true\n[[dependencies.example_mod]]\nmodId="optional_library"\nmandatory=false',
  );
  assert.deepEqual((await inspect(mod(text, "forge"), "forge")).required, [
    "required_library",
  ]);
});
for (const loader of ["forge", "neoforge"]) {
  test(`${loader} library wrappers expose declared nested mods and their required dependencies`, async () => {
    const nested = mod(
      descriptor("example_mod", dependency("REQUIRED")),
      loader,
    );
    const result = await inspect(wrapper(nested), loader);
    assert.deepEqual(result, {
      title: "Example mod",
      provided: ["example_mod"],
      required: ["shared_library"],
    });
  });
}
test("library wrapper recognition follows manifest main attributes and continuation rules", async () => {
  const nested = mod(descriptor());
  const folded =
    "Manifest-Version: 1.0\r\nfmlmodtype: GAME\r\n LIBRARY\r\n\r\nName: ignored\r\nFMLModType: UNKNOWN\r\n\r\n";
  assert.deepEqual((await inspect(wrapper(nested, folded))).provided, [
    "example_mod",
  ]);
  await assert.rejects(
    inspect(
      wrapper(
        nested,
        "Manifest-Version: 1.0\r\n\r\nName: ignored\r\nFMLModType: LIBRARY\r\n\r\n",
      ),
    ),
    /could not be read reliably/,
  );
});
test("a library marker alone cannot identify an empty or arbitrary package", async () => {
  await assert.rejects(
    inspect(wrapper(zip([["assets/example.txt", "not a mod"]]))),
    /could not be read reliably/,
  );
  await assert.rejects(
    inspect(
      zip([
        [
          "META-INF/MANIFEST.MF",
          "Manifest-Version: 1.0\nFMLModType: LIBRARY\n\n",
        ],
      ]),
    ),
    /could not be read reliably/,
  );
  await assert.rejects(
    inspect(
      wrapper(
        mod(descriptor()),
        "Manifest-Version: 1.0\nFMLModType: UNKNOWN\n\n",
      ),
    ),
    /could not be read reliably/,
  );
});
test("a wrapper never hides malformed nested dependency metadata", async () => {
  await assert.rejects(
    inspect(wrapper(mod(descriptor("example_mod", dependency("mystery"))))),
    /could not be read reliably/,
  );
  await assert.rejects(inspect(wrapper(mod('[[mods]]\nmodId="unfinished'))));
});
test("custom language loader requirements are retained even without explicit dependencies", async () => {
  const result = await inspect(
    mod(descriptor("consumer", "", "language_support")),
  );
  assert.deepEqual(result.required, ["language_support"]);
  const bundled = await inspect(wrapper(mod(descriptor("language_support"))));
  assert.deepEqual(bundled.provided, ["language_support"]);
  for (const language of ["javafml", "lowcodefml"])
    assert.deepEqual(
      (await inspect(mod(descriptor("consumer", "", language)))).required,
      [],
    );
});
test("Fabric metadata keeps aliases and required dependencies with metadata-only traversal", async () => {
  const result = await inspect(
    zip([
      [
        "fabric.mod.json",
        JSON.stringify({
          schemaVersion: 1,
          id: "example_mod",
          name: "Fabric example",
          provides: ["alias_mod"],
          depends: { required_library: "*" },
          suggests: { optional_library: "*" },
        }),
      ],
    ]),
    "fabric",
  );
  assert.deepEqual(result, {
    title: "Fabric example",
    provided: ["example_mod", "alias_mod"],
    required: ["required_library"],
  });
});
