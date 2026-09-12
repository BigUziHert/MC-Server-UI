import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const iconError = (message) =>
  Object.assign(new Error(message), { status: 400 });

export function validateIcon(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 45 ||
    bytes.length > 262144 ||
    !bytes.subarray(0, 8).equals(signature) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(16) !== 64 ||
    bytes.readUInt32BE(20) !== 64
  )
    throw iconError("Use a 64 × 64 PNG icon under 256 KB.");
  const depth = bytes[24],
    color = bytes[25],
    interlace = bytes[28];
  const depths = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !depths[color]?.includes(depth) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    interlace > 1
  )
    throw iconError("Invalid PNG image format.");
  let offset = 8,
    ended = false,
    palette = false;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12)
      throw iconError("Invalid PNG icon.");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (
      crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
      bytes.readUInt32BE(offset + 8 + length)
    )
      throw iconError("PNG icon is damaged. Choose the image again.");
    if (type === "IHDR" && offset !== 8) throw iconError("Invalid PNG icon.");
    if (type === "PLTE") {
      palette = length > 0 && length <= 768 && length % 3 === 0;
    }
    if (type === "IDAT")
      compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === "IEND") {
      ended = length === 0 && offset === bytes.length;
      break;
    }
  }
  if (!compressed.length || !ended || (color === 3 && !palette))
    throw iconError("Invalid PNG icon.");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  try {
    const pixels = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: 65536,
    });
    let position = 0;
    for (const [x, y, dx, dy] of passes) {
      const width = Math.ceil((64 - x) / dx),
        height = Math.ceil((64 - y) / dy);
      const stride = Math.ceil((width * channels * depth) / 8) + 1;
      for (let row = 0; row < height; row++) {
        if (position + stride > pixels.length || pixels[position] > 4)
          throw new Error();
        position += stride;
      }
    }
    if (position !== pixels.length) throw new Error();
  } catch {
    throw iconError("PNG image data is damaged or invalid.");
  }
  return bytes;
}

export function decodeIcon(value) {
  if (
    typeof value !== "string" ||
    value.length > 350000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw iconError("Choose an image to use as your server icon.");
  return validateIcon(Buffer.from(value.slice(22), "base64"));
}

export async function readServerIcon(directory, safePath) {
  try {
    const target = await safePath(directory, "server-icon.png");
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 262144) return null;
    const bytes = validateIcon(await fs.readFile(target));
    return { bytes, version: `${stat.mtimeMs}-${stat.size}` };
  } catch (cause) {
    if (cause.code === "ENOENT" || cause.status === 400) return null;
    throw cause;
  }
}

export async function writeServerIcon(directory, bytes, safePath) {
  const target = await safePath(directory, "server-icon.png");
  const temporary = path.join(directory, `.panel-icon-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, validateIcon(bytes), { flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
