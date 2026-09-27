import test from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import {
  jarContentIdentity,
  jarTimestampIdentity,
} from "./launchpad-jar-identity.mjs";

function zip(
  entries,
  {
    descriptor = 0,
    deflate = false,
    extra = Buffer.alloc(0),
    comment = "",
    compressedTail = Buffer.alloc(0),
  } = {},
) {
  const locals = [],
    central = [],
    offsets = [],
    timestamps = [];
  let offset = 0;
  for (const [filename, value] of entries) {
    const name = Buffer.from(filename),
      data = Buffer.from(value);
    const compressed = deflate
      ? Buffer.concat([deflateRawSync(data), compressedTail])
      : data;
    const crc = crc32(data),
      local = Buffer.alloc(30),
      row = Buffer.alloc(46);
    const flags = 0x800 | (descriptor ? 8 : 0);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(0x12345678, 10);
    if (!descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    row.writeUInt32LE(0x02014b50);
    row.writeUInt16LE(20, 4);
    row.writeUInt16LE(20, 6);
    row.writeUInt16LE(flags, 8);
    row.writeUInt16LE(deflate ? 8 : 0, 10);
    row.writeUInt32LE(0x12345678, 12);
    row.writeUInt32LE(crc, 16);
    row.writeUInt32LE(compressed.length, 20);
    row.writeUInt32LE(data.length, 24);
    row.writeUInt16LE(name.length, 28);
    row.writeUInt16LE(extra.length, 30);
    row.writeUInt32LE(offset, 42);
    const trailer = Buffer.alloc(descriptor);
    if (descriptor) {
      if (descriptor === 16) trailer.writeUInt32LE(0x08074b50);
      trailer.writeUInt32LE(crc, descriptor - 12);
      trailer.writeUInt32LE(compressed.length, descriptor - 8);
      trailer.writeUInt32LE(data.length, descriptor - 4);
    }
    offsets.push({
      local: offset,
      data: offset + 30 + name.length + extra.length,
    });
    timestamps.push(offset + 10);
    locals.push(local, name, extra, compressed, trailer);
    central.push(row, name, extra);
    offset +=
      local.length +
      name.length +
      extra.length +
      compressed.length +
      trailer.length;
  }
  let position = offset;
  for (let i = 0; i < entries.length; i++) {
    offsets[i].central = position;
    timestamps.push(position + 12);
    position += 46 + Buffer.byteLength(entries[i][0]) + extra.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22),
    endComment = Buffer.from(comment);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(endComment.length, 20);
  return {
    buffer: Buffer.concat([...locals, directory, end, endComment]),
    offsets,
    timestamps,
    eocd: position,
  };
}

const sample = (options) =>
  zip(
    [
      ["META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\n"],
      ["example/Test.class", "actual executable content"],
    ],
    options,
  );

for (const options of [
  {},
  { deflate: true },
  { descriptor: 12 },
  { descriptor: 16, deflate: true },
]) {
  test(`ignores only DOS timestamps for ${JSON.stringify(options)}`, () => {
    const { buffer, timestamps } = sample(options);
    const original = Buffer.from(buffer),
      changed = Buffer.from(buffer);
    for (let i = 0; i < timestamps.length; i++)
      changed.writeUInt32LE(i + 1, timestamps[i]);
    const identity = jarTimestampIdentity(buffer);
    assert.match(identity, /^[a-f0-9]{128}$/);
    assert.equal(jarTimestampIdentity(changed), identity);
    assert.deepEqual(
      buffer,
      original,
      "identity must not modify the caller's archive",
    );
  });
}

test("hashes actual file bytes even when all stored CRCs and sizes are unchanged", () => {
  const { buffer, offsets } = sample();
  const changed = Buffer.from(buffer);
  changed[offsets[1].data] ^= 1;
  assert.notEqual(jarTimestampIdentity(changed), jarTimestampIdentity(buffer));
});

test("retains names, comments, attributes and extended timestamps in identity", () => {
  const extra = Buffer.from([0x55, 0x54, 5, 0, 1, 1, 2, 3, 4]);
  const { buffer, offsets } = sample({ extra, comment: "archive comment" });
  for (const mutate of [
    (copy) => {
      copy[offsets[1].local + 30] ^= 1;
      copy[offsets[1].central + 46] ^= 1;
    },
    (copy) => {
      copy[copy.length - 1] ^= 1;
    },
    (copy) => {
      copy[offsets[1].central + 38] ^= 1;
    },
    (copy) => {
      copy[offsets[1].data - 1] ^= 1;
    },
  ]) {
    const changed = Buffer.from(buffer);
    mutate(changed);
    assert.notEqual(
      jarTimestampIdentity(changed),
      jarTimestampIdentity(buffer),
    );
  }
});

test("timestamp normalization does not equate recompressed or reordered archives", () => {
  assert.notEqual(
    jarTimestampIdentity(sample().buffer),
    jarTimestampIdentity(sample({ deflate: true }).buffer),
  );
  const one = zip([
    ["a", "x"],
    ["b", "y"],
  ]).buffer;
  const two = zip([
    ["b", "y"],
    ["a", "x"],
  ]).buffer;
  assert.notEqual(jarTimestampIdentity(one), jarTimestampIdentity(two));
});

test("rejects truncated, displaced and conflicting ZIP structures", () => {
  const { buffer, offsets, eocd } = sample();
  const invalid = [
    buffer.subarray(0, buffer.length - 1),
    Buffer.concat([Buffer.from([0]), buffer]),
    Buffer.concat([buffer, Buffer.from([0])]),
  ];
  for (const mutate of [
    (copy) => copy.writeUInt32LE(1, offsets[0].central + 42),
    (copy) => copy.writeUInt32LE(offsets[0].central, offsets[0].central + 42),
    (copy) => copy.writeUInt32LE(0xffffffff, offsets[0].central + 20),
    (copy) => copy.writeUInt32LE(0xffffffff, eocd + 16),
    (copy) => copy.writeUInt16LE(0xffff, eocd + 10),
    (copy) => copy.writeUInt16LE(1, eocd + 6),
    (copy) => copy.writeUInt16LE(1, offsets[0].central + 34),
    (copy) => copy.writeUInt16LE(1, offsets[0].central + 8),
    (copy) => copy.writeUInt16LE(0xffff, offsets[0].central + 30),
    (copy) => copy.writeUInt16LE(0xffff, offsets[0].local + 28),
    (copy) => {
      copy[offsets[0].local + 30] ^= 1;
    },
    (copy) => {
      copy[offsets[0].local + 14] ^= 1;
    },
    (copy) => copy.writeUInt16LE(0, eocd + 8),
    (copy) => copy.writeUInt32LE(0, eocd + 12),
  ]) {
    const changed = Buffer.from(buffer);
    mutate(changed);
    invalid.push(changed);
  }
  for (const changed of invalid)
    assert.throws(
      () => jarTimestampIdentity(changed),
      /invalid or unsupported/,
    );
});

test("rejects duplicate names and overlapping local-file regions", () => {
  assert.throws(() =>
    jarTimestampIdentity(
      zip([
        ["a", "x"],
        ["a", "y"],
      ]).buffer,
    ),
  );
  const { buffer, offsets } = sample();
  const compressed = buffer.readUInt32LE(offsets[0].central + 20) + 1;
  buffer.writeUInt32LE(compressed, offsets[0].central + 20);
  buffer.writeUInt32LE(compressed, offsets[0].central + 24);
  buffer.writeUInt32LE(compressed, offsets[0].local + 18);
  buffer.writeUInt32LE(compressed, offsets[0].local + 22);
  assert.throws(() => jarTimestampIdentity(buffer));
});

test("rejects ambiguous end records and malformed or ZIP64 extra fields", () => {
  const { buffer } = sample();
  const ambiguous = Buffer.concat([buffer, Buffer.alloc(22)]);
  ambiguous.writeUInt16LE(22, buffer.length - 2);
  ambiguous.writeUInt32LE(0x06054b50, buffer.length);
  assert.throws(() => jarTimestampIdentity(ambiguous));
  for (const extra of [
    Buffer.from([1, 0, 0, 0]),
    Buffer.from([0x55, 0x54, 9, 0, 0]),
  ]) {
    assert.throws(() => jarTimestampIdentity(sample({ extra }).buffer));
  }
});

test("checks data descriptor values against their central records", () => {
  for (const descriptor of [12, 16]) {
    const { buffer, offsets } = sample({ descriptor });
    buffer[offsets[1].local - 1] ^= 1;
    assert.throws(() => jarTimestampIdentity(buffer));
  }
});

test("supports an empty ZIP and bounds memory inputs without copying", () => {
  assert.match(jarTimestampIdentity(zip([]).buffer), /^[a-f0-9]{128}$/);
  assert.throws(() => jarTimestampIdentity(Buffer.alloc(21)));
  assert.throws(() =>
    jarTimestampIdentity(Buffer.allocUnsafe(128 * 1024 * 1024 + 1)),
  );
  assert.throws(() => jarTimestampIdentity(new Uint8Array(22)), TypeError);
});

test("honors cancellation before examining an archive", () => {
  const reason = new Error("cancel identity lookup");
  assert.throws(
    () =>
      jarTimestampIdentity(sample().buffer, {
        signal: AbortSignal.abort(reason),
      }),
    (error) => error === reason,
  );
});

const manifest = (
  implementation = "2026-06-20T17:56:17+0000",
  timestamp = "1781978177238",
) =>
  `Manifest-Version: 1.0\r\nImplementation-Version: 21.1.0.14\r\nMixinConfigs: example.mixins.json\r\nImplementation-Timestamp: ${implementation}\r\nTimestamp: ${timestamp}\r\n\r\nName: example/Test.class\r\nTimestamp: preserved named attribute\r\n\r\n`;
const contentEntries = (main = manifest()) => [
  ["META-INF/MANIFEST.MF", main],
  ["example/Test.class", "executable class contents"],
  ["assets/example/model.json", '{"resource":true}'],
  [
    "META-INF/jarjar/library.jar",
    zip([["Nested.class", "nested executable"]]).buffer,
  ],
];

test("content identity accepts reordered, recompressed members and the two unsigned build dates", async () => {
  const first = zip(contentEntries()).buffer;
  const second = zip(
    contentEntries(
      manifest("2026-06-20T17:56:48+0000", "1781978208610"),
    ).reverse(),
    { deflate: true, descriptor: 16 },
  );
  for (const offset of second.timestamps)
    second.buffer.writeUInt32LE(0, offset);
  const before = Buffer.from(second.buffer);
  assert.equal(
    await jarContentIdentity(first),
    await jarContentIdentity(second.buffer),
  );
  assert.deepEqual(second.buffer, before);
  assert.notEqual(
    jarTimestampIdentity(first),
    jarTimestampIdentity(second.buffer),
  );
});

test("all executable, resource, nested and remaining manifest contents stay significant", async () => {
  const expected = await jarContentIdentity(zip(contentEntries()).buffer);
  const variants = [
    contentEntries().map(([name, value]) => [
      name,
      name.endsWith("Test.class") ? "changed executable" : value,
    ]),
    contentEntries().map(([name, value]) => [
      name,
      name.endsWith("model.json") ? '{"resource":false}' : value,
    ]),
    contentEntries().map(([name, value]) => [
      name,
      name.endsWith("library.jar")
        ? zip([["Nested.class", "changed nested executable"]]).buffer
        : value,
    ]),
    contentEntries(manifest().replace("21.1.0.14", "21.1.0.15")),
    contentEntries(
      manifest().replace("example.mixins.json", "other.mixins.json"),
    ),
    contentEntries(
      manifest().replace(
        "preserved named attribute",
        "changed named attribute",
      ),
    ),
    contentEntries(manifest().replace("Timestamp: 1781978177238\r\n", "")),
    contentEntries(
      manifest().replace(
        "Implementation-Timestamp",
        "implementation-timestamp",
      ),
    ),
    contentEntries().map(([name, value]) => [
      name === "example/Test.class" ? "other/Test.class" : name,
      value,
    ]),
  ];
  for (const entries of variants)
    assert.notEqual(await jarContentIdentity(zip(entries).buffer), expected);
});

for (const filename of [
  "META-INF/RELEASE.SF",
  "META-INF/RELEASE.RSA",
  "META-INF/RELEASE.DSA",
  "META-INF/RELEASE.EC",
  "meta-inf/sig-release",
]) {
  test(`preserves the exact manifest for signed archive marker ${filename}`, async () => {
    const first = zip([
      ...contentEntries(),
      [filename, "signature bytes"],
    ]).buffer;
    const rebuilt = zip([
      ...contentEntries(manifest("2026-06-20T17:56:48+0000", "1781978208610")),
      [filename, "signature bytes"],
    ]).buffer;
    const changedSignature = zip([
      ...contentEntries(),
      [filename, "changed signature"],
    ]).buffer;
    const identity = await jarContentIdentity(first);
    assert.notEqual(await jarContentIdentity(rebuilt), identity);
    assert.notEqual(await jarContentIdentity(changedSignature), identity);
  });
}

test("rejects invalid, duplicated or continued build timestamps", async () => {
  for (const main of [
    manifest("not a date"),
    manifest("2026-02-30T17:56:17+0000"),
    manifest("2026-06-20T25:56:17+0000"),
    manifest("2026-06-20T17:56:17+2460"),
    manifest(undefined, "not a timestamp"),
    manifest(undefined, "1781978177"),
    manifest().replace("\r\n\r\n", "\r\nTimestamp: 1781978208610\r\n\r\n"),
    manifest().replace("\r\n\r\n", "\r\ntimestamp: 1781978208610\r\n\r\n"),
    manifest().replace(
      "Timestamp: 1781978177238",
      "Timestamp: 178197\r\n 8177238",
    ),
  ])
    await assert.rejects(
      jarContentIdentity(zip(contentEntries(main)).buffer),
      /invalid or unsupported/,
    );
});

test("content identity validates CRC, output bounds, structure, and full compressed-stream consumption", async () => {
  const badCRC = zip([["a.class", "some data"]]);
  badCRC.buffer[badCRC.offsets[0].data] ^= 1;
  await assert.rejects(jarContentIdentity(badCRC.buffer));
  const oversized = zip([["a.class", "some data"]], { deflate: true });
  oversized.buffer.writeUInt32LE(
    128 * 1024 * 1024 + 1,
    oversized.offsets[0].local + 22,
  );
  oversized.buffer.writeUInt32LE(
    128 * 1024 * 1024 + 1,
    oversized.offsets[0].central + 24,
  );
  await assert.rejects(jarContentIdentity(oversized.buffer));
  await assert.rejects(
    jarContentIdentity(
      zip([["a.class", "a"]], {
        deflate: true,
        compressedTail: Buffer.from("garbage"),
      }).buffer,
    ),
  );
  await assert.rejects(
    jarContentIdentity(
      zip([
        ["a", "x"],
        ["a", "y"],
      ]).buffer,
    ),
  );
});

test("content identity keeps attributes and extra fields and refuses Unix special files", async () => {
  const original = zip([["a.class", "a"]]);
  const changed = Buffer.from(original.buffer);
  changed[original.offsets[0].central + 38] ^= 1;
  assert.notEqual(
    await jarContentIdentity(changed),
    await jarContentIdentity(original.buffer),
  );
  const extra = zip([["a.class", "a"]], {
    extra: Buffer.from([0x55, 0x54, 1, 0, 0]),
  }).buffer;
  assert.notEqual(
    await jarContentIdentity(extra),
    await jarContentIdentity(original.buffer),
  );
  changed.writeUInt16LE(0x0314, original.offsets[0].central + 4);
  changed.writeUInt32LE((0xa000 << 16) >>> 0, original.offsets[0].central + 38);
  await assert.rejects(jarContentIdentity(changed));
  await assert.rejects(
    jarContentIdentity(
      zip([["a.class", "a"]], { extra: Buffer.from([0x75, 0x70, 0, 0]) })
        .buffer,
    ),
  );
});

test("content identity honors cancellation before and during decompression", async () => {
  const buffer = zip([["large.class", Buffer.alloc(4 * 1024 * 1024)]], {
    deflate: true,
  }).buffer;
  await assert.rejects(
    jarContentIdentity(buffer, {
      signal: AbortSignal.abort(new Error("stop identity")),
    }),
    /stop identity/,
  );
  const controller = new AbortController();
  const operation = jarContentIdentity(buffer, { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(operation, { name: "AbortError" });
});

const childPath = "META-INF/jarjar/library.jar";
const jarContainer = (
  child,
  { declared = true, signed = false, metadata } = {},
) =>
  zip([
    ["META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\n\r\n"],
    [childPath, child],
    ...(declared
      ? [
          [
            "META-INF/jarjar/metadata.json",
            metadata ??
              JSON.stringify({
                jars: [
                  { path: childPath, version: { artifactVersion: "1.0" } },
                ],
              }),
          ],
        ]
      : []),
    ...(signed ? [["META-INF/RELEASE.SF", "signed parent"]] : []),
  ]).buffer;

test("declared JarJar members of unsigned parents may differ only in their ZIP timestamps", async () => {
  const child = zip(contentEntries());
  const changed = Buffer.from(child.buffer);
  for (const offset of child.timestamps) changed.writeUInt32LE(0, offset);
  assert.equal(
    await jarContentIdentity(jarContainer(child.buffer)),
    await jarContentIdentity(jarContainer(changed)),
  );
  assert.notEqual(
    await jarContentIdentity(jarContainer(child.buffer, { declared: false })),
    await jarContentIdentity(jarContainer(changed, { declared: false })),
  );
  assert.notEqual(
    await jarContentIdentity(jarContainer(child.buffer, { signed: true })),
    await jarContentIdentity(jarContainer(changed, { signed: true })),
  );
});

test("an undeclared invalid UTF-8 name cannot alias a declared JarJar path", async () => {
  const declaredName = "META-INF/jarjar/\ufffd.jar";
  const invalidName = Buffer.concat([
    Buffer.from("META-INF/jarjar/"),
    Buffer.from([0xff]),
    Buffer.from(".jar"),
  ]);
  const child = zip([["Example.class", "class bytes"]]);
  const changed = Buffer.from(child.buffer);
  for (const offset of child.timestamps) changed.writeUInt32LE(0, offset);
  const container = (unlistedChild) =>
    zip([
      [
        "META-INF/jarjar/metadata.json",
        JSON.stringify({ jars: [{ path: declaredName }] }),
      ],
      [declaredName, child.buffer],
      [invalidName, unlistedChild],
    ]).buffer;
  assert.notEqual(
    await jarContentIdentity(container(child.buffer)),
    await jarContentIdentity(container(changed)),
  );
});

test("nested classes, manifests, signatures, metadata and recompression remain significant", async () => {
  const entries = [
    ...contentEntries(),
    ["META-INF/RELEASE.SF", "nested signature"],
  ];
  const expected = await jarContentIdentity(jarContainer(zip(entries).buffer));
  const variants = [
    entries.map(([name, value]) => [
      name,
      name === "example/Test.class" ? "changed class" : value,
    ]),
    entries.map(([name, value]) => [
      name,
      name === "META-INF/MANIFEST.MF"
        ? manifest("2026-06-20T17:56:48+0000", "1781978208610")
        : value,
    ]),
    entries.map(([name, value]) => [
      name,
      name.endsWith(".SF") ? "changed signature" : value,
    ]),
  ];
  for (const variant of variants)
    assert.notEqual(
      await jarContentIdentity(jarContainer(zip(variant).buffer)),
      expected,
    );
  assert.notEqual(
    await jarContentIdentity(
      jarContainer(zip(entries, { deflate: true }).buffer),
    ),
    expected,
  );
  assert.notEqual(
    await jarContentIdentity(
      jarContainer(zip(entries).buffer, {
        metadata: JSON.stringify({
          jars: [{ path: childPath, version: { artifactVersion: "2.0" } }],
        }),
      }),
    ),
    expected,
  );
  // This remains narrow even for an unsigned child: do not normalize its build
  // fields, or recursively visit the child's own embedded archives.
  assert.notEqual(
    await jarContentIdentity(jarContainer(zip(contentEntries()).buffer)),
    await jarContentIdentity(
      jarContainer(
        zip(
          contentEntries(manifest("2026-06-20T17:56:48+0000", "1781978208610")),
        ).buffer,
      ),
    ),
  );
});

test("rejects malformed, duplicated, missing or unsafe JarJar declarations", async () => {
  const child = zip([["Example.class", "class bytes"]]).buffer;
  for (const metadata of [
    "not json",
    JSON.stringify({ jars: null }),
    JSON.stringify({ jars: [{ path: childPath }, { path: childPath }] }),
    JSON.stringify({ jars: [{ path: "META-INF/jarjar/missing.jar" }] }),
    JSON.stringify({ jars: [{ path: "META-INF/jarjar/../library.jar" }] }),
    JSON.stringify({ jars: [{ path: "outside/library.jar" }] }),
    JSON.stringify({
      jars: Array.from({ length: 65 }, () => ({ path: childPath })),
    }),
    " ".repeat(512 * 1024 + 1),
  ])
    await assert.rejects(jarContentIdentity(jarContainer(child, { metadata })));
  await assert.rejects(
    jarContentIdentity(jarContainer(Buffer.from("not a nested archive"))),
  );
});
