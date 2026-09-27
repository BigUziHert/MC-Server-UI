import { createHash } from "node:crypto";
import { addAbortSignal } from "node:stream";
import { crc32, createInflateRaw } from "node:zlib";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 250_000;
const ZERO_TIMESTAMP = Buffer.alloc(4);

function invalid() {
  throw new Error("The JAR has an invalid or unsupported ZIP structure.");
}

// This is deliberately narrower than general ZIP equivalence. Every byte,
// including compressed contents, names, CRCs, extra fields and comments, is
// hashed unchanged except the four DOS timestamp bytes in each file header.
// Throws for malformed, ambiguous, encrypted, multi-disk or ZIP64 archives.
// Does not decompress, extract files, or mutate the caller's buffer.
function parseJar(buffer, { signal } = {}) {
  signal?.throwIfAborted();
  if (!Buffer.isBuffer(buffer)) throw new TypeError("Expected a JAR Buffer.");
  if (buffer.length < 22 || buffer.length > MAX_ARCHIVE_BYTES) invalid();
  const bounds = (offset, length, limit = buffer.length) => {
    if (offset < 0 || length < 0 || offset + length > limit) invalid();
  };
  const extras = (offset, length) => {
    const end = offset + length;
    while (offset < end) {
      signal?.throwIfAborted();
      bounds(offset, 4, end);
      const id = buffer.readUInt16LE(offset);
      const size = buffer.readUInt16LE(offset + 2);
      if (id === 0x0001) invalid(); // ZIP64 must not disguise header offsets.
      bounds(offset + 4, size, end);
      offset += 4 + size;
    }
  };

  // A ZIP comment can contain signatures. Accept only one end record whose
  // declared comment ends exactly at EOF; do not guess between alternatives.
  let eocd = -1;
  for (
    let offset = buffer.length - 22;
    offset >= Math.max(0, buffer.length - 22 - 0xffff);
    offset--
  ) {
    if ((offset & 1023) === 0) signal?.throwIfAborted();
    if (
      buffer.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length
    ) {
      if (eocd !== -1) invalid();
      eocd = offset;
    }
  }
  if (eocd === -1) invalid();
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralStart = buffer.readUInt32LE(eocd + 16);
  if (
    buffer.readUInt16LE(eocd + 4) !== 0 ||
    buffer.readUInt16LE(eocd + 6) !== 0 ||
    buffer.readUInt16LE(eocd + 8) !== count ||
    count === 0xffff ||
    count > MAX_ENTRIES ||
    centralSize === 0xffffffff ||
    centralStart === 0xffffffff ||
    centralStart + centralSize !== eocd
  )
    invalid();

  const entries = [];
  const timestamps = [];
  const names = new Set();
  let central = centralStart;
  for (let index = 0; index < count; index++) {
    signal?.throwIfAborted();
    bounds(central, 46, eocd);
    if (buffer.readUInt32LE(central) !== 0x02014b50) invalid();
    const version = buffer.readUInt16LE(central + 6);
    const flags = buffer.readUInt16LE(central + 8);
    const method = buffer.readUInt16LE(central + 10);
    const crc = buffer.readUInt32LE(central + 16);
    const compressed = buffer.readUInt32LE(central + 20);
    const uncompressed = buffer.readUInt32LE(central + 24);
    const nameSize = buffer.readUInt16LE(central + 28);
    const extraSize = buffer.readUInt16LE(central + 30);
    const commentSize = buffer.readUInt16LE(central + 32);
    const local = buffer.readUInt32LE(central + 42);
    if (
      version > 20 ||
      (flags & ~0x080e) !== 0 ||
      (method !== 0 && method !== 8) ||
      (method === 0 && (flags & 6) !== 0) ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      (method === 0 && compressed !== uncompressed) ||
      nameSize === 0 ||
      buffer.readUInt16LE(central + 34) !== 0
    )
      invalid();
    bounds(central + 46, nameSize + extraSize + commentSize, eocd);
    const name = buffer.subarray(central + 46, central + 46 + nameSize);
    const nameKey = name.toString("hex");
    if (names.has(nameKey)) invalid();
    names.add(nameKey);
    extras(central + 46 + nameSize, extraSize);

    bounds(local, 30, centralStart);
    if (
      buffer.readUInt32LE(local) !== 0x04034b50 ||
      buffer.readUInt16LE(local + 4) !== version ||
      buffer.readUInt16LE(local + 6) !== flags ||
      buffer.readUInt16LE(local + 8) !== method ||
      buffer.readUInt16LE(local + 26) !== nameSize
    )
      invalid();
    const localExtraSize = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + nameSize + localExtraSize;
    bounds(local + 30, nameSize + localExtraSize + compressed, centralStart);
    if (!name.equals(buffer.subarray(local + 30, local + 30 + nameSize)))
      invalid();
    extras(local + 30 + nameSize, localExtraSize);
    const localValues = [14, 18, 22].map((offset) =>
      buffer.readUInt32LE(local + offset),
    );
    const centralValues = [crc, compressed, uncompressed];
    if (
      !localValues.every((value, i) => value === centralValues[i]) &&
      !((flags & 8) !== 0 && localValues.every((value) => value === 0))
    )
      invalid();
    entries.push({
      local,
      name,
      dataStart,
      dataEnd: dataStart + compressed,
      flags,
      method,
      uncompressed,
      crc,
      platform: buffer.readUInt16LE(central + 4) >>> 8,
      attributes: buffer.subarray(central + 36, central + 42),
      localExtra: buffer.subarray(local + 30 + nameSize, dataStart),
      centralExtra: buffer.subarray(
        central + 46 + nameSize,
        central + 46 + nameSize + extraSize,
      ),
      comment: buffer.subarray(
        central + 46 + nameSize + extraSize,
        central + 46 + nameSize + extraSize + commentSize,
      ),
      centralValues,
    });
    timestamps.push(local + 10, central + 12);
    central += 46 + nameSize + extraSize + commentSize;
  }
  if (central !== eocd) invalid();

  // Require one unambiguous, contiguous local-file region. This prevents a
  // forged central record from treating bytes inside another file as a header.
  entries.sort((a, b) => a.local - b.local);
  let next = 0;
  for (let index = 0; index < entries.length; index++) {
    signal?.throwIfAborted();
    const { local, dataEnd, flags, centralValues } = entries[index];
    if (local !== next) invalid();
    next = entries[index + 1]?.local ?? centralStart;
    if ((flags & 8) !== 0) {
      const size = next - dataEnd;
      if (size !== 12 && size !== 16) invalid();
      bounds(dataEnd, size, centralStart);
      if (size === 16 && buffer.readUInt32LE(dataEnd) !== 0x08074b50) invalid();
      const valuesStart = dataEnd + (size === 16 ? 4 : 0);
      if (
        !centralValues.every(
          (value, i) => buffer.readUInt32LE(valuesStart + i * 4) === value,
        )
      )
        invalid();
    } else if (dataEnd !== next) invalid();
  }
  if (entries.length === 0 && centralStart !== 0) invalid();

  return { entries, timestamps };
}

export function jarTimestampIdentity(buffer, { signal } = {}) {
  const { timestamps } = parseJar(buffer, { signal });
  timestamps.sort((a, b) => a - b);
  const hash = createHash("sha512");
  let cursor = 0;
  const hashUntil = (end) => {
    while (cursor < end) {
      signal?.throwIfAborted();
      const chunkEnd = Math.min(end, cursor + 1024 * 1024);
      hash.update(buffer.subarray(cursor, chunkEnd));
      cursor = chunkEnd;
    }
  };
  for (const offset of timestamps) {
    if (offset < cursor) invalid();
    hashUntil(offset);
    hash.update(ZERO_TIMESTAMP);
    cursor = offset + 4;
  }
  hashUntil(buffer.length);
  signal?.throwIfAborted();
  return hash.digest("hex");
}

const MAX_MEMBER_BYTES = 128 * 1024 * 1024;
const MAX_CONTENT_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const BUILD_FIELDS = new Set(["implementation-timestamp", "timestamp"]);

function validImplementationTimestamp(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:?\d{2})$/.exec(
      value,
    );
  if (!match) return false;
  const [, y, m, d, h, minute, second, zone] = match;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(h) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return false;
  const offset = zone.replace(":", "");
  return (
    zone === "Z" ||
    (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(3)) <= 59)
  );
}

// These two attributes are emitted by Gradle builds of otherwise identical
// releases. Only valid main-section values are ignored, and only in unsigned
// archives. Attribute spelling, presence, all other lines and named sections
// remain significant. In particular, never rewrite signed manifest contents.
function normalizeBuildTimestamps(buffer) {
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer) || /\r(?!\n)/.test(text))
    invalid();
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const seen = new Set();
  const output = [];
  let previous,
    main = true,
    terminated = false;
  for (const line of lines) {
    if (!main) {
      output.push(line);
      continue;
    }
    const content = line.replace(/\r?\n$/, "");
    if (!content) {
      main = false;
      terminated = true;
      output.push(line);
      continue;
    }
    if (content.startsWith(" ")) {
      if (!previous || BUILD_FIELDS.has(previous)) invalid();
      output.push(line);
      continue;
    }
    const match = /^([A-Za-z0-9_-]{1,70}): (.*)$/.exec(content);
    if (!match) invalid();
    const [, name, value] = match;
    previous = name.toLowerCase();
    if (seen.has(previous)) invalid();
    seen.add(previous);
    if (BUILD_FIELDS.has(previous)) {
      if (
        previous === "implementation-timestamp"
          ? !validImplementationTimestamp(value)
          : !/^[1-9]\d{12}$/.test(value)
      )
        invalid();
      const newline = line.slice(content.length);
      output.push(`${name}: <build-timestamp>${newline}`);
    } else output.push(line);
  }
  if (!terminated) invalid();
  return Buffer.from(output.join(""));
}

function declaredJarPaths(buffer, entries) {
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) invalid();
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch {
    invalid();
  }
  if (
    !metadata ||
    Array.isArray(metadata) ||
    !Array.isArray(metadata.jars) ||
    metadata.jars.length > 64
  )
    invalid();
  const declared = new Set();
  for (const jar of metadata.jars) {
    const name = jar?.path;
    if (
      typeof name !== "string" ||
      !name.startsWith("META-INF/jarjar/") ||
      !/\.jar$/i.test(name) ||
      /[\\\x00-\x1f\x7f]/.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      Buffer.from(name, "utf8").toString("utf8") !== name ||
      declared.has(name) ||
      !entries.some((entry) => entry.name.equals(Buffer.from(name, "utf8")))
    )
      invalid();
    declared.add(name);
  }
  // Keep exact bytes: decoding an undeclared invalid UTF-8 name can otherwise
  // alias a separately declared path containing a replacement character.
  return new Set(
    [...declared].map((name) => Buffer.from(name, "utf8").toString("hex")),
  );
}

// A second, bounded comparison for repacked/rebuilt releases. It preserves
// every member name and byte (including signing files),
// except the two allowlisted unsigned-manifest build dates above. Compression,
// member ordering and DOS timestamps are irrelevant; all other ZIP metadata
// used below remains significant. In an unsigned container, explicitly declared
// JarJar members may differ only in their ZIP DOS timestamps. Their compressed
// contents, manifests and signatures remain exact; this does not recursively
// decompress or normalize nested manifests. The original JAR is never modified.
export async function jarContentIdentity(buffer, { signal } = {}) {
  const { entries } = parseJar(buffer, { signal });
  let declaredBytes = 0;
  for (const entry of entries) {
    // Unicode path overrides can make readers disagree about whether an entry
    // is a manifest/signature. Decline that ambiguity instead of normalizing it.
    for (const extra of [entry.localExtra, entry.centralExtra]) {
      for (let offset = 0; offset < extra.length;) {
        if (extra.readUInt16LE(offset) === 0x7075) invalid();
        offset += 4 + extra.readUInt16LE(offset + 2);
      }
    }
    const attributes = entry.attributes.readUInt32LE(2);
    const kind = entry.platform === 3 ? (attributes >>> 16) & 0xf000 : 0;
    if (
      (kind && kind !== 0x8000 && kind !== 0x4000) ||
      entry.uncompressed > MAX_MEMBER_BYTES
    )
      invalid();
    declaredBytes += entry.uncompressed;
    if (declaredBytes > MAX_CONTENT_BYTES) invalid();
  }
  const signed = entries.some(({ name }) =>
    /^META-INF\/(?:[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]+)$/i.test(
      name.toString("latin1"),
    ),
  );
  const sorted = [...entries].sort((a, b) => Buffer.compare(a.name, b.name));
  const metadata =
    !signed &&
    sorted.find((entry) =>
      entry.name.equals(Buffer.from("META-INF/jarjar/metadata.json")),
    );
  // Read the declaration once, before any declared child, and retain its exact
  // bytes in the identity. This read order is deterministic for both archives.
  const ordered = metadata
    ? [metadata, ...sorted.filter((entry) => entry !== metadata)]
    : sorted;
  let declared = new Set();
  const identity = createHash("sha512").update("launchpad-jar-contents-v2\0");
  const field = (value) => {
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(value.length));
    identity.update(size).update(value);
  };
  let actualTotal = 0;
  for (const entry of ordered) {
    signal?.throwIfAborted();
    const manifest =
      !signed && entry.name.equals(Buffer.from("META-INF/MANIFEST.MF"));
    const declaration = entry === metadata;
    const nested = declared.has(entry.name.toString("hex"));
    if ((manifest || declaration) && entry.uncompressed > MAX_MANIFEST_BYTES)
      invalid();
    const digest = createHash("sha512"),
      chunks = [];
    let size = 0,
      checksum = 0;
    const consume = (chunk) => {
      signal?.throwIfAborted();
      size += chunk.length;
      actualTotal += chunk.length;
      if (
        size > entry.uncompressed ||
        size > MAX_MEMBER_BYTES ||
        actualTotal > MAX_CONTENT_BYTES
      )
        invalid();
      checksum = crc32(chunk, checksum);
      if (manifest || declaration || nested) chunks.push(chunk);
      else digest.update(chunk);
    };
    if (entry.method === 0) {
      for (
        let offset = entry.dataStart;
        offset < entry.dataEnd;
        offset += 64 * 1024
      )
        consume(
          buffer.subarray(offset, Math.min(entry.dataEnd, offset + 64 * 1024)),
        );
    } else {
      const inflate = createInflateRaw();
      if (signal) addAbortSignal(signal, inflate);
      try {
        inflate.end(buffer.subarray(entry.dataStart, entry.dataEnd));
        for await (const chunk of inflate) consume(chunk);
        // zlib accepts a valid stream followed by junk; such bytes must never
        // disappear from the content comparison without validation.
        if (inflate.bytesWritten !== entry.dataEnd - entry.dataStart) invalid();
      } finally {
        inflate.destroy();
      }
    }
    if (size !== entry.uncompressed || checksum !== entry.crc) invalid();
    if (manifest) {
      const normalized = normalizeBuildTimestamps(Buffer.concat(chunks, size));
      size = normalized.length;
      digest.update(normalized);
    } else if (declaration) {
      const bytes = Buffer.concat(chunks, size);
      declared = declaredJarPaths(bytes, entries);
      digest.update(bytes);
    }
    // The mode tag separates a timestamp-normalized child digest from a raw
    // member digest. Raw compressed child size may differ solely because of
    // those timestamp bytes, so use the fixed digest length in this mode.
    const memberDigest = nested
      ? Buffer.from(
          jarTimestampIdentity(Buffer.concat(chunks, size), { signal }),
          "hex",
        )
      : digest.digest();
    if (nested) size = memberDigest.length;
    field(entry.name);
    field(Buffer.from([entry.platform, (entry.flags >>> 8) & 8]));
    field(entry.attributes);
    field(entry.localExtra);
    field(entry.centralExtra);
    field(entry.comment);
    field(Buffer.from([nested ? 1 : 0]));
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(size));
    field(length);
    field(memberDigest);
  }
  signal?.throwIfAborted();
  return identity.digest("hex");
}
