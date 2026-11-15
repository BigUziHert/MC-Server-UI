import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPanel } from "./index.mjs";

test("an exited wrapper's unresolved children block server mutations until the owner explicitly confirms stopping them", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-orphan-recovery-"));
  const serverDir = path.join(root, "server");
  await fs.writeFile(
    path.join(root, "owned-process.json"),
    JSON.stringify({
      pid: 12345,
      birth: "123456",
      tree: true,
      startedAt: 100,
      executable: "launcher",
      serverDir,
    }),
  );
  let probes = 0;
  const panel = await createPanel({
    dataDir: root,
    serverDir,
    useEnvironment: false,
    scheduler: false,
    processIdentity: async () => null,
    probeServerPort: async () => {
      probes++;
    },
    publicAddress: { resolve: async () => null },
  });
  const listener = await new Promise((resolve) => {
    const socket = panel.app.listen(0, "127.0.0.1", () => resolve(socket));
  });
  t.after(async () => {
    await panel.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-orphan-recovery-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = async (route, body) => {
    const response = await fetch(
      `http://127.0.0.1:${listener.address().port}${route}`,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {},
    );
    return { status: response.status, body: await response.json() };
  };
  const state = (await request("/api/server")).body;
  assert.equal(state.orphaned, true);
  assert.equal(state.orphanedUnresolved, true);
  assert.equal(
    (await request("/api/server/power", { action: "start" })).status,
    409,
  );
  assert.equal(
    (await request("/api/backups", { name: "Unsafe offline backup" })).status,
    409,
  );
  assert.equal(
    (await request("/api/server/power", { action: "resolve-orphan" })).status,
    409,
  );
  const resolved = await request("/api/server/power", {
    action: "resolve-orphan",
    confirmed: true,
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.ok(probes > 0);
  assert.equal((await request("/api/server")).body.orphaned, false);
  await assert.rejects(fs.stat(path.join(root, "owned-process.json")), {
    code: "ENOENT",
  });
});
