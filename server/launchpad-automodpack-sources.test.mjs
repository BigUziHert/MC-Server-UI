import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import yazl from "yazl";
import { readAutoModpackSources } from "./launchpad-automodpack-sources.mjs";

async function jar(entries) {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries))
    zip.addBuffer(Buffer.from(content), name);
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const neo = (extra = "", modExtra = "") => ({
  "META-INF/neoforge.mods.toml": `modLoader="javafml"\nloaderVersion="[1,)"\n[[mods]]\nmodId="coroutil"\nversion="1.0"\n${modExtra}\n${extra}`,
});
const fabric = (environment) => ({
  "fabric.mod.json": JSON.stringify({
    schemaVersion: 1,
    id: "library",
    version: "1.0",
    ...(environment ? { environment } : {}),
  }),
});
const main = (rules) =>
  `modpack { name: "Test pack" General { main { ${rules} } } }`;
async function fixture(t, config) {
  const serverDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-auto-sources-"),
  );
  t.after(() => fs.rm(serverDir, { recursive: true, force: true }));
  const safePath = (root, relative = "") => {
    const result = path.resolve(root, relative);
    if (!result.startsWith(path.resolve(root) + path.sep))
      throw new Error("unsafe path");
    return result;
  };
  const write = async (relative, bytes) => {
    const target = safePath(serverDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  };
  if (config !== undefined) await write("automodpack/server.conf", config);
  return {
    serverDir,
    write,
    read: (signal) => readAutoModpackSources({ serverDir, safePath, signal }),
    mod: async (name = "coroutil.jar", metadata = neo()) => {
      const relative = `mods/${name}`;
      await write(relative, await jar(metadata));
      return {
        path: relative,
        active: true,
        platform: "modrinth",
        projectId: name,
      };
    },
  };
}

test("absent AutoModpack config uses factory main sources before installation without writing config", async (t) => {
  const f = await fixture(t);
  const item = await f.mod();
  const result = await f.read();
  assert.equal(await result.includes(item, "neoforge"), true);
  assert.equal(
    await result.includes({ ...item, active: false }, "neoforge"),
    false,
  );
  assert.equal(
    await result.includes(
      { ...item, path: item.path + ".disabled" },
      "neoforge",
    ),
    false,
  );
  assert.equal(
    await result.includes(
      { ...item, path: "../mods/coroutil.jar" },
      "neoforge",
    ),
    false,
  );
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(await fs.readdir(f.serverDir), ["mods"]);
});

test("current HOCON factory syntax handles comments, unquoted brace globs and category names", async (t) => {
  const f = await fixture(
    t,
    `# AutoModpack\ngenerate-modpack-on-start: true
modpack {
  name: "My server"
  "General content" {
    main {
      from-server: [mods/*.jar, kubejs/**, emotes/*]
      exclude: [**/.*, **/.*/**, **/*.{tmp,disabled,bak}, kubejs/server_scripts/**]
      editable: [options.txt, config/**]
      auto-exclude-server-side-mods: metadata
    }
  }
}`,
  );
  const result = await f.read();
  assert.deepEqual(result.warnings, []);
  assert.equal(await result.includes(await f.mod(), "neoforge"), true);
  assert.equal(
    await result.includes(await f.mod(".hidden.jar"), "neoforge"),
    false,
  );
});

test("from-server negation, exclusion negation, leading slashes and case-sensitive rules are respected", async (t) => {
  const f = await fixture(
    t,
    main(`from-server: ["/mods/*.jar", "!/mods/skip.jar"]
exclude: ["mods/{blocked,allowed}.jar", "!mods/allowed.jar"]`),
  );
  const result = await f.read();
  for (const [name, expected] of [
    ["skip.jar", false],
    ["blocked.jar", false],
    ["allowed.jar", true],
    ["other.jar", true],
    ["upper.JAR", false],
  ]) {
    assert.equal(
      await result.includes(await f.mod(name), "neoforge"),
      expected,
      name,
    );
  }
});

for (const rules of [
  "",
  "from-server: []",
  "from-server: [config/**]",
  "from-server: [mods/*.jar] exclude: [mods/**]",
]) {
  test(`explicit main rules do not inherit factory inclusions: ${rules || "empty group"}`, async (t) => {
    const f = await fixture(t, main(rules));
    assert.equal(
      await (await f.read()).includes(await f.mod(), "neoforge"),
      false,
    );
  });
}

test("auto exclusion rejects server-only root metadata without mistaking ordinary dependencies for sided mods", async (t) => {
  const f = await fixture(t);
  const result = await f.read();
  assert.equal(
    await result.includes(
      await f.mod("fabric.jar", fabric("server")),
      "fabric",
    ),
    false,
  );
  assert.equal(
    await result.includes(
      await f.mod("client.jar", fabric("client")),
      "fabric",
    ),
    true,
  );
  assert.equal(
    await result.includes(await f.mod("common.jar", fabric("*")), "fabric"),
    true,
  );
  const forge = {
    "META-INF/mods.toml": neo("", 'displayTest="IGNORE_SERVER_VERSION"')[
      "META-INF/neoforge.mods.toml"
    ],
  };
  assert.equal(
    await result.includes(await f.mod("server.jar", forge), "forge"),
    false,
  );
  assert.equal(
    await result.includes(
      await f.mod(
        "old-server.jar",
        neo('[[dependencies.coroutil]]\nmodId="neoforge"\nside="SERVER"'),
      ),
      "neoforge",
    ),
    false,
  );
  assert.equal(
    await result.includes(
      await f.mod(
        "ordinary.jar",
        neo('[[dependencies.coroutil]]\nmodId="other_library"\nside="SERVER"'),
      ),
      "neoforge",
    ),
    true,
  );
});

test("disabled auto exclusion ships server-tagged jars while AutoModpack itself stays excluded", async (t) => {
  const f = await fixture(
    t,
    main("from-server: [mods/*.jar] auto-exclude-server-side-mods: DISABLED"),
  );
  const result = await f.read();
  assert.equal(
    await result.includes(
      await f.mod("server.jar", fabric("server")),
      "fabric",
    ),
    true,
  );
  assert.equal(
    await result.includes(
      await f.mod("self.jar", {
        "fabric.mod.json":
          '{"schemaVersion":1,"id":"automodpack","version":"5"}',
      }),
      "fabric",
    ),
    false,
  );
});

for (const config of [
  main("from-server: [mods/*.jar] auto-exclude-server-side-mods: PLATFORMS"),
  main('from-server: ["mods/[ab]*.jar"]'),
  main('from-server: ["mods/*.jar"] from-server: []'),
  main("from-server: ${defaultRules}"),
  main('fromServer: ["mods/*.jar"]'),
  main("from-server: [mods/*.jar] compatible-platforms: [windows]"),
  main("from-server: [mods/*.jar] selection: OPTIONAL"),
  'include "other.conf"',
  "modpack.General.main.from-server: [mods/*.jar]",
  "modpack { General { main { from-server: [mods/*.jar]",
  "x".repeat(128 * 1024 + 1),
]) {
  test(`unsupported or malformed content rules never grant reuse (${config.slice(0, 65)})`, async (t) => {
    const f = await fixture(t, config);
    const result = await f.read();
    assert.equal(await result.includes(await f.mod(), "neoforge"), false);
    assert.match(
      result.warnings.join(" "),
      /content rules could not be verified/,
    );
  });
}

test("config bytes, creation, deletion and legacy presence change the promotion snapshot", async (t) => {
  const f = await fixture(t);
  const original = await f.read();
  await f.write("automodpack/server.conf", main("from-server: [mods/*.jar]"));
  const configured = await f.read();
  assert.notEqual(configured.snapshot, original.snapshot);
  await f.write("automodpack/server.conf", main("from-server: []"));
  assert.notEqual((await f.read()).snapshot, configured.snapshot);
  await fs.unlink(path.join(f.serverDir, "automodpack/server.conf"));
  assert.equal((await f.read()).snapshot, original.snapshot);
  await f.write(
    "automodpack/automodpack-server.json",
    '{"syncedFiles":["/mods/*.jar"]}',
  );
  const legacy = await f.read();
  assert.notEqual(legacy.snapshot, original.snapshot);
  assert.equal(await legacy.includes(await f.mod(), "neoforge"), false);
  assert.equal(legacy.warnings.length, 1);
});

test("a host file shadows a regular mod by path even with unidentified contents", async (t) => {
  const f = await fixture(t);
  const item = await f.mod();
  const result = await f.read();
  assert.equal(await result.includes(item, "neoforge"), true);
  await f.write(
    `automodpack/host-modpack/main/${item.path}`,
    "unidentified host content",
  );
  assert.equal(await result.includes(item, "neoforge"), false);
  assert.deepEqual(result.warnings, []);
  assert.equal(
    await fs.readFile(
      path.join(f.serverDir, "automodpack/host-modpack/main", item.path),
      "utf8",
    ),
    "unidentified host content",
  );
});

test("non-file configuration is never treated as absent defaults", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.serverDir, "automodpack/server.conf"), {
    recursive: true,
  });
  const result = await f.read();
  assert.equal(await result.includes(await f.mod(), "neoforge"), false);
  assert.equal(result.warnings.length, 1);
});

test("unreadable archives remain staged and cancelled reads propagate cancellation", async (t) => {
  const f = await fixture(t);
  await f.write("mods/broken.jar", "invalid zip");
  const result = await f.read();
  assert.equal(
    await result.includes({ path: "mods/broken.jar" }, "neoforge"),
    false,
  );
  assert.match(
    result.warnings.join(" "),
    /could not verify whether mods\/broken.jar reaches clients/,
  );
  const signal = AbortSignal.abort(new Error("cancelled"));
  await assert.rejects(f.read(signal), /cancelled/);
});

test(
  "adversarial wildcard sequences are bounded without regex backtracking",
  { timeout: 2000 },
  async (t) => {
    const f = await fixture(
      t,
      main(`from-server: ["mods/${"*a".repeat(80)}.jar"]`),
    );
    const result = await f.read();
    assert.equal(
      await result.includes(
        { path: `mods/${"a".repeat(180)}b.jar` },
        "neoforge",
      ),
      false,
    );
    assert.deepEqual(result.warnings, []);
  },
);
