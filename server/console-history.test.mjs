import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPanel, CONSOLE_HISTORY_LINES } from "./index.mjs";

const extra = 250;

test("console keeps the newest lines and serves only lines after a known id", async (t) => {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "mc-console-history-"),
  );
  const serverDir = path.join(root, "server");
  await fs.mkdir(serverDir, { recursive: true });
  await fs.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  // Prints more lines than the panel retains, then waits to be stopped.
  const script = path.join(root, "spam.mjs");
  await fs.writeFile(
    script,
    `const total = ${CONSOLE_HISTORY_LINES + extra};
let out = "";
for (let i = 1; i <= total; i++) out += "[Server thread/INFO]: spam " + i + "\\n";
process.stdout.write(out);
process.stdin.on("data", (data) => {
  if (String(data).includes("stop")) process.exit(0);
});
setInterval(() => {}, 1000);
`,
  );
  const panel = await createPanel({
    dataDir: path.join(root, "panel"),
    serverDir,
    existingServerDir: true,
    mode: "live",
    launchType: "executable",
    launchExecutable: process.execPath,
    launchArgs: [script],
    useEnvironment: false,
    scheduler: false,
    stopTimeoutMs: 2000,
    telemetry: { reset() {}, sample: async () => ({ available: false }) },
    publicAddress: { resolve: async () => null },
  });
  const listener = await new Promise((resolve) => {
    const server = panel.app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(base + route, {
      ...options,
      headers: { "Content-Type": "application/json" },
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    try {
      await panel.close();
    } finally {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  const started = await request("/api/server/power", {
    method: "POST",
    body: JSON.stringify({ action: "start" }),
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const last = `spam ${CONSOLE_HISTORY_LINES + extra}`;
  const deadline = Date.now() + 15_000;
  let full;
  do {
    full = (await request("/api/console")).body;
    if (full.lines.at(-1)?.message.endsWith(last)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  assert.equal(full.incremental, true);
  assert.equal(full.after, undefined);
  assert.equal(full.lines.length, CONSOLE_HISTORY_LINES);
  assert.ok(full.lines.at(-1).message.endsWith(last));
  // The oldest panel and spam lines were trimmed to make room.
  assert.ok(!full.lines.some((line) => line.message.endsWith("spam 1")));
  const ids = full.lines.map((line) => Number(line.id));
  ids.forEach((id, index) => index && assert.equal(id, ids[index - 1] + 1));

  // Only lines after the requested id come back.
  const tail = full.lines.at(-4).id;
  const delta = (await request(`/api/console?after=${tail}`)).body;
  assert.equal(delta.after, tail);
  assert.deepEqual(
    delta.lines.map((line) => line.id),
    full.lines.slice(-3).map((line) => line.id),
  );
  const latest = full.lines.at(-1).id;
  assert.deepEqual(
    (await request(`/api/console?after=${latest}`)).body.lines,
    [],
  );

  // A trimmed, future or malformed id falls back to the full history.
  for (const after of ["1", String(Number(latest) + 5), "abc", "-1"]) {
    const body = (await request(`/api/console?after=${after}`)).body;
    assert.equal(body.after, undefined, after);
    assert.equal(body.lines.length, CONSOLE_HISTORY_LINES, after);
  }
});
