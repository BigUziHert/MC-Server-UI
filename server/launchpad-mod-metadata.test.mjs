import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { inspectInstalledMod } from "./launchpad-mod-metadata.mjs";
import { installedModVersionSatisfies } from "./launchpad-dependency-ranges.mjs";

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
        providers: [{ id: "example_mod", version: "1.0" }],
        requirements: [{ id: "shared_library", range: undefined }],
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
      providers: [{ id: "example_mod", version: "1.0" }],
      requirements: [{ id: "shared_library", range: undefined }],
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
  assert.deepEqual(result.requirements, [
    { id: "language_support", range: "[1,)" },
  ]);
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
          version: "1.2.3+fabric",
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
    providers: [
      { id: "example_mod", version: "1.2.3+fabric" },
      { id: "alias_mod", version: "1.2.3+fabric" },
    ],
    requirements: [{ id: "required_library", range: "*" }],
  });
});

test("NeoForge preserves required and optional ranges for alternate-provider checks", async () => {
  const result = await inspect(
    mod(
      descriptor(
        "example_mod",
        [
          dependency("required", 'versionRange="[1.5,)"'),
          dependency("REQUIRED", 'versionRange="(,2.0)"'),
          dependency("optional", 'versionRange="[9,)"'),
          dependency("required", 'versionRange="[9,)"\nside="CLIENT"'),
        ].join("\n"),
      ),
    ),
  );
  assert.deepEqual(result.required, ["shared_library"]);
  assert.deepEqual(result.requirements, [
    { id: "shared_library", range: "[1.5,)" },
    { id: "shared_library", range: "(,2.0)" },
    { id: "shared_library", range: "[9,)" },
  ]);
});

test("Forge optional constraints do not become mandatory dependencies", async () => {
  const result = await inspect(
    mod(
      descriptor(
        "example_mod",
        '[[dependencies.example_mod]]\nmodId="shared_library"\nmandatory=false\nversionRange="[2,)"',
      ),
      "forge",
    ),
    "forge",
  );
  assert.deepEqual(result.required, []);
  assert.deepEqual(result.requirements, [
    { id: "shared_library", range: "[2,)" },
  ]);
});

for (const type of ["incompatible", "discouraged"]) {
  test(`NeoForge ${type} declarations keep alternate-provider compatibility inconclusive`, async () => {
    const result = await inspect(
      mod(descriptor("example_mod", dependency(type, 'versionRange="[2,)"'))),
    );
    assert.deepEqual(result.required, []);
    assert.deepEqual(result.requirements, [
      { id: "shared_library", range: undefined },
    ]);
  });
}

test("Forge mod versions resolve manifest substitutions without trusting ambiguous manifests", async () => {
  const source = descriptor().replace(
    'version="1.0"',
    'version="${file.jarVersion}"',
  );
  for (const [manifest, expected] of [
    [
      "Manifest-Version: 1.0\r\nImplementation-Version: 1.\r\n 8.0\r\n\r\n",
      "1.8.0",
    ],
    [
      "Manifest-Version: 1.0\nImplementation-Version: 1.8.0\nImplementation-Version: 9.0\n\n",
      undefined,
    ],
    [
      "Manifest-Version: 1.0\n\nName: nested\nImplementation-Version: 9.0\n\n",
      undefined,
    ],
    [
      "Manifest-Version: 1.0\nImplementation-Version: ${unresolved}\n\n",
      undefined,
    ],
    ["Manifest-Version: 1.0\nImplementation-Version: 1.8.0", undefined],
  ]) {
    const result = await inspect(
      zip([
        ["META-INF/mods.toml", source],
        ["META-INF/MANIFEST.MF", manifest],
      ]),
      "forge",
    );
    assert.deepEqual(result.provided, ["example_mod"]);
    assert.deepEqual(result.providers, [
      { id: "example_mod", version: expected },
    ]);
  }
});

for (const loader of ["forge", "neoforge"]) {
  test(`${loader} uses its own clientSideOnly semantics for mods and bundled descendants`, async () => {
    const name = `META-INF/${loader === "neoforge" ? "neoforge.mods.toml" : "mods.toml"}`;
    const client = zip([
      [
        name,
        `clientSideOnly=true\n${descriptor("client_mod", dependency("required"))}`,
      ],
      [
        "META-INF/jarjar/metadata.json",
        JSON.stringify({ jars: [{ path: "libs/descendant.jar" }] }),
      ],
      ["libs/descendant.jar", mod(descriptor("descendant_mod"), loader)],
    ]);
    const root = await inspect(client, loader);
    const markedProviders =
      loader === "forge"
        ? []
        : [
            { id: "client_mod", version: "1.0" },
            { id: "descendant_mod", version: "1.0" },
          ];
    const markedRequirements =
      loader === "forge" ? [] : [{ id: "shared_library", range: undefined }];
    assert.deepEqual(
      root.provided,
      markedProviders.map(({ id }) => id),
    );
    assert.deepEqual(
      root.required,
      markedRequirements.map(({ id }) => id),
    );
    assert.deepEqual(root.providers, markedProviders);
    assert.deepEqual(root.requirements, markedRequirements);

    const server = await inspect(
      zip([
        [name, descriptor("server_mod")],
        [
          "META-INF/jarjar/metadata.json",
          JSON.stringify({
            jars: [{ path: "libs/client.jar" }, { path: "libs/server.jar" }],
          }),
        ],
        ["libs/client.jar", client],
        ["libs/server.jar", mod(descriptor("server_library"), loader)],
      ]),
      loader,
    );
    assert.deepEqual(server.providers, [
      { id: "server_mod", version: "1.0" },
      ...markedProviders,
      { id: "server_library", version: "1.0" },
    ]);
    assert.deepEqual(server.requirements, markedRequirements);
    const nonBoolean = inspect(
      mod(`clientSideOnly="true"\n${descriptor()}`, loader),
      loader,
    );
    if (loader === "forge")
      await assert.rejects(nonBoolean, /could not be read reliably/);
    else assert.deepEqual((await nonBoolean).provided, ["example_mod"]);
  });
}

test("Fabric preserves raw alternative ranges and excludes client-only metadata", async () => {
  const metadata = {
    schemaVersion: 1,
    id: "example_mod",
    version: "2.0.0",
    depends: { shared_library: [">=1.0", "~2.0"] },
  };
  const archive = (value) => zip([["fabric.mod.json", JSON.stringify(value)]]);
  assert.deepEqual((await inspect(archive(metadata), "fabric")).requirements, [
    { id: "shared_library", range: [">=1.0", "~2.0"] },
  ]);
  const client = await inspect(
    archive({ ...metadata, environment: "client" }),
    "fabric",
  );
  assert.deepEqual(client.providers, []);
  assert.deepEqual(client.requirements, []);
});

test("Quilt records alias versions but keeps conditional requirements inconclusive", async () => {
  const result = await inspect(
    zip([
      [
        "quilt.mod.json",
        JSON.stringify({
          schema_version: 1,
          quilt_loader: {
            id: "example_mod",
            version: "2.0",
            provides: [{ id: "group:alias_mod", version: "1.0" }],
            depends: [
              { id: "shared_library", versions: ">=1.5" },
              [
                { id: "alternative_one", versions: "*" },
                { id: "alternative_two", versions: "*" },
              ],
              {
                id: "conditional_mod",
                versions: "*",
                unless: { id: "unless_mod", versions: "*" },
              },
              { id: "optional_mod", versions: "*", optional: true },
              { id: "client_mod", versions: "*", environment: "client" },
            ],
          },
        }),
      ],
    ]),
    "quilt",
  );
  assert.deepEqual(result.providers, [
    { id: "example_mod", version: "2.0" },
    { id: "alias_mod", version: "1.0" },
  ]);
  assert.deepEqual(result.requirements, [
    { id: "shared_library", range: ">=1.5" },
    { id: "alternative_one", range: undefined },
    { id: "alternative_two", range: undefined },
    { id: "conditional_mod", range: undefined },
    { id: "unless_mod", range: undefined },
  ]);
});

test("alternate provider proof accepts numeric Maven ranges and explicit wildcards conservatively", () => {
  for (const [version, range] of [
    ["1.8.0", "[1.7.7,)"],
    ["1.5", "[1.5,2)"],
    ["1.0.0", "[1]"],
    ["3", "(,1],[3,)"],
    ["1.6.0", "*"],
    ["1.6.0-beta", " * "],
  ])
    assert.equal(
      installedModVersionSatisfies(version, range),
      true,
      `${version}: ${range}`,
    );
  for (const [version, range] of [
    ["1.4.8", "[1.7.7,)"],
    ["2.0", "[1.5,2)"],
    ["1.0-beta", "[1,)"],
    ["1.5", "1.5"],
    ["1.5", ">=1.0"],
    ["1.5", undefined],
    ["1.5", ["*"]],
    [undefined, "*"],
    ["${file.jarVersion}", "*"],
    ["", "*"],
    ["1.5\n", "*"],
  ])
    assert.equal(
      installedModVersionSatisfies(version, range),
      false,
      `${version}: ${range}`,
    );
});
