import test from "node:test";
import assert from "node:assert/strict";
import { ZipFile } from "yazl";
import { inspectPluginIdentity } from "./launchpad-plugin-metadata.mjs";

async function zip(entries) {
  const archive = new ZipFile();
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    archive.outputStream.once("error", reject);
    archive.once("error", reject);
  });
  for (const [name, text] of entries)
    archive.addBuffer(Buffer.from(text), name);
  archive.end();
  return result;
}
const inspect = async (entries, loader) =>
  inspectPluginIdentity(await zip(entries), { loader });

test("Bukkit plugin declarations retain required, soft and alias identities", async () => {
  const result = await inspect(
    [
      [
        "plugin.yml",
        "name: Shops\nversion: '1.2.3'\ndepend: [Vault, ProtocolLib]\nsoftdepend: [Vault, PlaceholderAPI]\nprovides: [ShopAPI]\nloadbefore: [NotADependency]\n",
      ],
    ],
    "spigot",
  );
  assert.deepEqual(result.provided, ["shops", "shopapi"]);
  assert.deepEqual(result.required, ["vault", "protocollib"]);
  assert.deepEqual(result.optional, ["placeholderapi"]);
  assert.deepEqual(result.providers, [
    { id: "shops", version: "1.2.3" },
    { id: "shopapi", version: "1.2.3" },
  ]);
  assert.equal(
    result.requirements.every(
      (row) => row.range === "*" && row.source === "plugin",
    ),
    true,
  );
});

test("Paper server and bootstrap dependencies default to required and honor false", async () => {
  const result = await inspect(
    [
      [
        "paper-plugin.yml",
        "name: Shops\nversion: '2.0'\ndependencies:\n  bootstrap:\n    RegistryPlugin: {}\n  server:\n    Vault: {required: true}\n    PlaceholderAPI: {required: false}\n    DefaultRequired: {}\n",
      ],
      ["plugin.yml", "name: Shops\ndepend: [OnlyOnBukkit]\n"],
    ],
    "paper",
  );
  assert.deepEqual(result.required, [
    "registryplugin",
    "vault",
    "defaultrequired",
  ]);
  assert.deepEqual(result.optional, ["placeholderapi"]);
  assert.equal(result.required.includes("onlyonbukkit"), false);
});

test("Bungee and Waterfall use depends and softDepends including plugin.yml fallback", async () => {
  for (const filename of ["bungee.yml", "plugin.yml"]) {
    const result = await inspect(
      [
        [
          filename,
          "name: ProxyAuth\nversion: '1.0'\ndepends: [Core]\nsoftDepends: [Metrics]\n",
        ],
      ],
      "waterfall",
    );
    assert.deepEqual(result.required, ["core"]);
    assert.deepEqual(result.optional, ["metrics"]);
  }
});

test("Velocity selects its stable id and honors optional dependencies in universal jars", async () => {
  const result = await inspect(
    [
      [
        "velocity-plugin.json",
        JSON.stringify({
          id: "proxy-auth",
          name: "Proxy Auth",
          version: "3.1",
          dependencies: [{ id: "core" }, { id: "metrics", optional: true }],
          provides: ["old-auth"],
        }),
      ],
      ["plugin.yml", "name: ProxyAuthBukkit\ndepend: [Vault]\n"],
    ],
    "velocity",
  );
  assert.deepEqual(result.provided, ["proxy-auth", "old-auth"]);
  assert.deepEqual(result.required, ["core"]);
  assert.deepEqual(result.optional, ["metrics"]);
  assert.equal(result.title, "Proxy Auth");
});

test("unreadable dependency declarations remain advisory while invalid or oversized identity stays rejected", async () => {
  const malformed = await inspect([
    [
      "plugin.yml",
      "name: Example\ndepend: not-a-list\nsoftdepend: [Known, {invalid: value}]\n",
    ],
  ]);
  assert.deepEqual(malformed.provided, ["example"]);
  assert.deepEqual(malformed.optional, ["known"]);
  assert.ok(malformed.warnings.length);
  await assert.rejects(
    inspect([["plugin.yml", "name: First\nname: Second\n"]]),
    /invalid/,
  );
  await assert.rejects(
    inspect([
      ["plugin.yml", `name: Example\ndescription: ${"x".repeat(1024 ** 2)}\n`],
    ]),
    /oversized/,
  );
  await assert.rejects(
    inspect([["velocity-plugin.json", "{id: invalid-json}"]], "velocity"),
  );
  await assert.rejects(
    inspectPluginIdentity(await zip([["plugin.yml", "name: Example\n"]]), {
      signal: AbortSignal.abort(new Error("Cancelled fixture")),
    }),
    /Cancelled fixture/,
  );
});
