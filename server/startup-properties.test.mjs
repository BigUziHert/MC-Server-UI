import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFleet } from "./index.mjs";
import { parseProperties } from "./import.mjs";
import { decodeText } from "./text-encoding.mjs";
import { updateProperties } from "./properties.mjs";
import { processStartup } from "../tests/fixtures/process-options.mjs";

async function fixture(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, "mc-startup-properties-"));
  const fleet = await createFleet({
    dataDir: root,
    createDefaultServer: false,
    useEnvironment: false,
    scheduler: false,
    publicAddress: { resolve: async () => null },
  });
  const listener = await new Promise((resolve) => {
    const server = fleet.app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(async () => {
    await fleet.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
    assert.equal(path.dirname(root), temp);
    assert.ok(path.basename(root).startsWith("mc-startup-properties-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = async (route, body, method = "POST") => {
    const response = await fetch(
      `http://127.0.0.1:${listener.address().port}/api${route}`,
      {
        method: body === undefined ? "GET" : method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const created = await request("/servers", {
    name: "Properties lifecycle",
    ...processStartup,
  });
  assert.equal(created.status, 201, JSON.stringify(created));
  const runtime = fleet.runtimes.get(created.body.server.id);
  await fs.writeFile(path.join(runtime.serverDir, "eula.txt"), "eula=true\n");
  const power = async (action, status) => {
    const response = await request("/server/power", { action });
    assert.equal(response.status, 200, JSON.stringify(response));
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if ((await request("/server")).body.status === status) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`${action} did not reach ${status}`);
  };
  return { ...runtime, root, request, power };
}

for (const encoding of ["latin1", "utf8"]) {
  test(`settings, Start and Restart preserve ${encoding} properties and update logical duplicate ports`, async (t) => {
    const panel = await fixture(t);
    const target = path.join(panel.serverDir, "server.properties");
    const prefix = encoding === "utf8" ? "\uFEFF" : "";
    const original = `${prefix}server-port=25565\r\n# keep café\\\nserver\\-port:25566\r\nserver-\\\r\n  port 25568\r\ncustom-label=olé\r\ncustom=first\\\n  second\rmotd=café\n`;
    await fs.writeFile(target, Buffer.from(original, encoding));
    const changed = await panel.request(
      "/server/settings",
      { port: 25567, motd: "Bienvenue 世界" },
      "PATCH",
    );
    assert.equal(changed.status, 200, JSON.stringify(changed));
    const motd =
      encoding === "latin1" ? "Bienvenue \\u4e16\\u754c" : "Bienvenue 世界";
    const expected = Buffer.from(
      `${prefix}server-port=25567\r\n# keep café\\\nserver-port=25567\r\nserver-port=25567\r\ncustom-label=olé\r\ncustom=first\\\n  second\rmotd=${motd}\n`,
      encoding,
    );
    const verify = async () => {
      const bytes = await fs.readFile(target);
      assert.deepEqual(
        bytes,
        expected,
        "unrelated bytes and line endings must survive",
      );
      const decoded = decodeText(bytes);
      assert.equal(decoded.encoding, encoding);
      const properties = parseProperties(decoded.text);
      assert.equal(properties.get("server-port"), "25567");
      assert.equal(properties.get("motd"), "Bienvenue 世界");
      assert.equal(properties.get("custom"), "firstsecond");
      assert.equal(
        (await panel.request("/server/settings")).body.server.port,
        25567,
      );
    };
    await verify();
    await panel.power("start", "running");
    await verify();
    await panel.power("restart", "running");
    await verify();
    await panel.power("stop", "offline");
  });
}

test("Start preserves unedited legacy values and creates a missing port after an unfinished continuation", async (t) => {
  const panel = await fixture(t);
  const target = path.join(panel.serverDir, "server.properties");
  const source = Buffer.from("motd=café\r\ncustom-label=olé\\", "latin1");
  await fs.writeFile(target, source);
  await panel.power("start", "running");
  const expected = Buffer.concat([
    source,
    Buffer.from(`\r\n\r\nserver-port=${panel.descriptor().port}\r\n`),
  ]);
  assert.deepEqual(await fs.readFile(target), expected);
  assert.equal(
    parseProperties(expected.toString("latin1")).get("custom-label"),
    "olé",
  );
  await panel.power("restart", "running");
  assert.deepEqual(await fs.readFile(target), expected);
  await panel.power("stop", "offline");
});

test("logical property updates handle Unicode-escaped keys, comments and a final line without adding unrelated changes", () => {
  const source =
    "# server-port=9\\\rserver\\u002dport=1\n!keep\\\r\nserver-port 2";
  assert.equal(
    updateProperties(source, new Map([["server-port", 3]]), {
      appendMissing: true,
    }),
    "# server-port=9\\\rserver-port=3\n!keep\\\r\nserver-port=3",
  );
});

test("rejected settings persistence restores original legacy bytes or a missing properties file", async (t) => {
  const panel = await fixture(t);
  const target = path.join(panel.serverDir, "server.properties");
  const original = Buffer.from("motd=café\r\nserver\\-port=25565\n", "latin1");
  const configuration = panel.descriptor();
  for (const source of [original, null]) {
    if (source) await fs.writeFile(target, source);
    else await fs.rm(target);
    await assert.rejects(
      panel.updateConfiguration(
        { ...configuration, port: 25567, motd: "Bienvenue 世界" },
        async () => {
          throw new Error("Fixture registry rejected settings");
        },
      ),
      /Fixture registry rejected settings/,
    );
    if (source) assert.deepEqual(await fs.readFile(target), source);
    else await assert.rejects(fs.stat(target), { code: "ENOENT" });
    assert.equal(panel.descriptor().port, configuration.port);
    assert.equal(panel.descriptor().motd, configuration.motd);
  }
});
