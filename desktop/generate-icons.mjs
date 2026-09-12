import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Render the existing panel logo at native Windows icon sizes.
const directory = path.dirname(fileURLToPath(import.meta.url));
const svg = await fs.readFile(path.join(directory, "../public/favicon.svg"));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) =>
  new Resvg(svg, {
    fitTo: { mode: "width", value: size },
  })
    .render()
    .asPng(),
);
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
for (const [index, bytes] of images.entries()) {
  const entry = 6 + 16 * index;
  header[entry] = header[entry + 1] = sizes[index] % 256;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(bytes.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += bytes.length;
}
await fs.mkdir(path.join(directory, "assets"), { recursive: true });
await fs.writeFile(
  path.join(directory, "assets/icon.ico"),
  Buffer.concat([header, ...images]),
);
await fs.writeFile(path.join(directory, "assets/icon.png"), images.at(-1));
