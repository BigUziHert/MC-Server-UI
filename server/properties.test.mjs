import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { createPropertiesService } from "./properties.mjs";
import { containedSourcePath, parseProperties } from "./import.mjs";

async function fixture(t, source, filename = "server.properties") {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, "mc-properties-"));
  t.after(async () => {
    assert.equal(path.dirname(root), temp);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
  await fs.writeFile(path.join(root, filename), source);
  const state = { status: "offline", config: {}, audits: [] };
  const ctx = {
    serverDir: root,
    safePath: containedSourcePath,
    getServer: () => state,
    withMinecraftMutation: (work) => work(),
    applyConfiguration: async (patch) => {
      Object.assign(state.config, patch);
    },
    audit: async (...args) => state.audits.push(args),
  };
  return { root, state, ctx, service: createPropertiesService(ctx) };
}
test("Java Properties preserves comments, continuations, escaped keys and textual numeric values", async (t) => {
  const { root, state, service } = await fixture(
    t,
    "# a comment\r\nmotd=123\r\nlevel-name=true\r\nmax-players=5\r\nwhite-list=false\r\ncustom\\ key=first\\\r\n  continuation\r\nunrelated=keep\\u0020me\r\n",
  );
  const loaded = await service.get("server.properties");
  assert.equal(
    loaded.fields.find((value) => value.key === "motd").type,
    "string",
  );
  assert.equal(
    loaded.fields.find((value) => value.key === "level-name").type,
    "string",
  );
  await service.save({
    ...loaded,
    changes: [
      { key: "motd", value: "Welcome\n第二世界" },
      { key: "custom key", value: "changed" },
      { key: "max-players", value: 12 },
    ],
  });
  const text = await fs.readFile(path.join(root, "server.properties"), "utf8");
  assert.ok(text.startsWith("# a comment\r\n"));
  assert.ok(text.includes("unrelated=keep\\u0020me\r\n"));
  assert.equal(parseProperties(text).get("motd"), "Welcome\n第二世界");
  assert.equal(parseProperties(text).get("custom key"), "changed");
  assert.equal(state.config.maxPlayers, 12);
  assert.ok(!state.audits[0].join(" ").includes("第二世界"));
});

test("Properties preserves backslash-terminated comments when editing the following property", async (t) => {
  const original =
    "# configuration directory C:\\\r\ncustom=old\r\n  ! keep this comment \\\r\nmotd=first\\\r\n  second\r\nuntouched=keep\r\n";
  const { root, service } = await fixture(t, original);
  const loaded = await service.get("server.properties");
  await service.save({
    ...loaded,
    changes: [
      { key: "custom", value: "updated" },
      { key: "motd", value: "Welcome" },
    ],
  });
  assert.equal(
    await fs.readFile(path.join(root, "server.properties"), "utf8"),
    "# configuration directory C:\\\r\ncustom=updated\r\n  ! keep this comment \\\r\nmotd=Welcome\r\nuntouched=keep\r\n",
  );
});
test("Properties edits nested YAML scalars without losing comments, sequences, anchors or unrelated fields", async (t) => {
  const original =
    '# config\nsettings:\n  # tuning\n  connection-throttle: 4000\n  enabled: true\n  list: [one, two]\ndefaults: &common\n  name: "safe"\ncopy: *common\n';
  const { root, service } = await fixture(t, original, "bukkit.yml");
  const loaded = await service.get("bukkit.yml");
  assert.equal(loaded.fields.length, 3);
  await service.save({
    ...loaded,
    changes: [{ key: '["settings","connection-throttle"]', value: 2000 }],
  });
  const text = await fs.readFile(path.join(root, "bukkit.yml"), "utf8");
  assert.match(text, /# tuning/);
  assert.match(text, /copy: \*common/);
  const doc = parseDocument(text);
  assert.equal(doc.getIn(["settings", "connection-throttle"]), 2000);
  assert.deepEqual(doc.toJS().settings.list, ["one", "two"]);
});
test("stale revisions, invalid types and out-of-range ports cannot overwrite a configuration", async (t) => {
  const { root, service } = await fixture(
    t,
    "server-port=25565\nmax-players=5\n",
  );
  const loaded = await service.get("server.properties");
  for (const value of ["25566", 65536, 1.5])
    await assert.rejects(
      service.save({ ...loaded, changes: [{ key: "server-port", value }] }),
      { status: 400 },
    );
  await fs.writeFile(
    path.join(root, "server.properties"),
    "server-port=25567\n",
  );
  await assert.rejects(
    service.save({
      ...loaded,
      changes: [{ key: "server-port", value: 25566 }],
    }),
    { status: 409 },
  );
  assert.equal(
    await fs.readFile(path.join(root, "server.properties"), "utf8"),
    "server-port=25567\n",
  );
});
test("registry rejection restores the original property file and live port edits are rejected", async (t) => {
  const original = "server-port=25565\nmax-players=5\n";
  const { root, ctx, state } = await fixture(t, original);
  ctx.applyConfiguration = async () => {
    throw Object.assign(new Error("Port is already assigned."), {
      status: 409,
    });
  };
  const service = createPropertiesService(ctx),
    loaded = await service.get("server.properties");
  await assert.rejects(
    service.save({
      ...loaded,
      changes: [{ key: "server-port", value: 25566 }],
    }),
    /already assigned/,
  );
  assert.equal(
    await fs.readFile(path.join(root, "server.properties"), "utf8"),
    original,
  );
  state.status = "running";
  await assert.rejects(
    service.save({
      ...loaded,
      changes: [{ key: "server-port", value: 25566 }],
    }),
    /Stop the server/,
  );
});
test("Properties exposes only existing allowlisted files and rejects invalid YAML and symlinks", async (t) => {
  const { root, service } = await fixture(t, "a: [unterminated", "bukkit.yml");
  assert.deepEqual(
    (await service.list()).files.map((value) => value.path),
    ["bukkit.yml"],
  );
  await assert.rejects(service.get("bukkit.yml"), /YAML syntax/);
  await assert.rejects(service.get("../outside"), { status: 400 });
  await fs.mkdir(path.join(root, "config"));
  await fs.symlink(
    path.join(root, "config"),
    path.join(root, "server.properties"),
    "junction",
  );
  await assert.rejects(service.get("server.properties"));
});

test("a file changed while the save's temporary file is written is preserved as a revision conflict", async (t) => {
  const { root, service } = await fixture(t, "white-list=false\n# original\n");
  const target = path.join(root, "server.properties");
  const loaded = await service.get("server.properties");
  const writeFile = fs.writeFile;
  let edited = false;
  t.mock.method(fs, "writeFile", async (destination, ...args) => {
    const result = await writeFile(destination, ...args);
    if (
      String(destination).startsWith(`${target}.`) &&
      String(destination).endsWith(".tmp")
    ) {
      edited = true;
      await writeFile(
        target,
        "white-list=false\n# external edit during save\n",
      );
    }
    return result;
  });
  await assert.rejects(
    service.save({ ...loaded, changes: [{ key: "white-list", value: true }] }),
    { status: 409 },
  );
  assert.equal(edited, true);
  assert.equal(
    await fs.readFile(target, "utf8"),
    "white-list=false\n# external edit during save\n",
  );
  assert.deepEqual(await fs.readdir(root), ["server.properties"]);
});

test("legacy Properties encoding keeps untouched bytes and escapes new Unicode values", async (t) => {
  const source = Buffer.from(
    "# caf\xe9\r\ncustom=old\r\nuntouched=\xe9\r\n",
    "latin1",
  );
  const { root, service } = await fixture(t, source);
  const loaded = await service.get("server.properties");
  await service.save({
    ...loaded,
    changes: [{ key: "custom", value: "\u4e16\u754c\ud83c\udf0d" }],
  });
  const buffer = await fs.readFile(path.join(root, "server.properties"));
  assert.ok(buffer.subarray(0, 8).equals(source.subarray(0, 8)));
  assert.ok(buffer.includes(Buffer.from("untouched=\xe9\r\n", "latin1")));
  assert.equal(
    parseProperties(buffer.toString("latin1")).get("custom"),
    "\u4e16\u754c\ud83c\udf0d",
  );
});

test("edited escaped Properties keys retain their control-character identity", async (t) => {
  const { root, service } = await fixture(
    t,
    "custom\\u000akey=old\nuntouched=keep\n",
  );
  const loaded = await service.get("server.properties");
  await service.save({
    ...loaded,
    changes: [{ key: "custom\nkey", value: "updated" }],
  });
  const properties = parseProperties(
    await fs.readFile(path.join(root, "server.properties"), "utf8"),
  );
  assert.equal(properties.get("custom\nkey"), "updated");
  assert.equal(properties.get("untouched"), "keep");
  assert.equal(properties.size, 2);
});

test("YAML scalar edits leave unrelated decimal precision and block formatting intact", async (t) => {
  const original =
    "# exact values\r\nthreshold: 0.1234567890123456789012345\r\nenabled: false # keep inline\r\nmessage: |\r\n  Hello\r\n  World\r\nnext: 2\r\n";
  const { root, service } = await fixture(t, original, "bukkit.yml");
  const loaded = await service.get("bukkit.yml");
  await service.save({
    ...loaded,
    changes: [
      { key: '["enabled"]', value: true },
      { key: '["message"]', value: "Updated\nmessage" },
    ],
  });
  const text = await fs.readFile(path.join(root, "bukkit.yml"), "utf8");
  assert.match(text, /threshold: 0\.1234567890123456789012345\r\n/);
  assert.match(text, /enabled: true # keep inline\r\n/);
  const doc = parseDocument(text);
  assert.equal(doc.errors.length, 0);
  assert.equal(doc.get("message"), "Updated\nmessage");
  assert.equal(doc.get("next"), 2);
});

test("editing YAML preserves unrelated integers beyond JavaScript's exact numeric range", async (t) => {
  const original =
    "seed: 9223372036854775807\nhex-seed: 0x7fffffffffffffff\nsafe-count: 12\nenabled: true\nvalues: [9223372036854775807]\n";
  const { root, service } = await fixture(t, original, "bukkit.yml");
  const loaded = await service.get("bukkit.yml");
  assert.equal(
    loaded.fields.find((entry) => entry.key === '["safe-count"]').value,
    12,
  );
  await service.save({
    ...loaded,
    changes: [{ key: '["enabled"]', value: false }],
  });
  const saved = parseDocument(
    await fs.readFile(path.join(root, "bukkit.yml"), "utf8"),
    { intAsBigInt: true },
  );
  assert.equal(saved.get("seed"), 9223372036854775807n);
  assert.equal(saved.get("hex-seed"), 9223372036854775807n);
  assert.equal(saved.getIn(["values", 0]), 9223372036854775807n);
  assert.equal(saved.get("enabled"), false);
});
