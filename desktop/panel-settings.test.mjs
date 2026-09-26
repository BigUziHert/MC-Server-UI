import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createPanelSettings, keepWindowInTray } from "./panel-settings.mjs";
import { DESKTOP_COOKIE_NAME, startDesktopRuntime } from "./runtime.mjs";

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-panel-settings-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("mc-panel-settings-"));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}

test("startup and tray choices persist with an explicit server and never substitute another server", async (t) => {
  const dataDir = await fixture(t);
  const servers = new Set(["one", "two"]);
  const registrations = [];
  const options = {
    dataDir,
    hasServer: (id) => servers.has(id),
    loginItem: {
      supported: true,
      setEnabled: async (value) => registrations.push(value),
    },
  };
  const store = createPanelSettings(options);
  assert.equal((await store.read()).startupMode, "off");
  assert.equal(store.snapshot().keepInTray, true);
  await store.save({ startupMode: "server", startupServerId: "one" });
  await store.save({ keepInTray: false });
  await store.close();
  assert.deepEqual(registrations, [true]);
  const restored = createPanelSettings(options);
  assert.equal((await restored.read()).startupServerId, "one");
  assert.equal(restored.snapshot().keepInTray, false);
  servers.delete("one");
  assert.equal((await restored.read()).missingStartupServer, true);
  assert.equal(restored.snapshot().startupServerId, "one");
  await assert.rejects(
    restored.save({ startupMode: "server", startupServerId: "missing" }),
    { status: 400 },
  );
  await restored.save({ startupMode: "off" });
  assert.deepEqual(registrations, [true, false]);
  await restored.close();
  await assert.rejects(restored.save({ keepInTray: true }), { status: 503 });
});

test("unsupported startup does not prevent tray preferences, and registration or disk failure rolls back", async (t) => {
  const dataDir = await fixture(t);
  const unsupported = createPanelSettings({ dataDir, hasServer: () => true });
  await assert.rejects(unsupported.save({ startupMode: "panel" }), {
    status: 409,
  });
  await unsupported.save({ keepInTray: false });
  assert.equal((await unsupported.read()).startupMode, "off");
  await unsupported.close();
  const calls = [];
  let registrationFails = true;
  const store = createPanelSettings({
    dataDir,
    hasServer: () => true,
    loginItem: {
      supported: true,
      setEnabled: async (enabled) => {
        calls.push(enabled);
        if (enabled && registrationFails)
          throw new Error("Windows refused registration");
      },
    },
  });
  await assert.rejects(store.save({ startupMode: "panel" }), /Windows refused/);
  assert.equal((await store.read()).startupMode, "off");
  assert.equal(store.snapshot().keepInTray, false);
  assert.deepEqual(calls, [true, false]);
  registrationFails = false;
  await fs.rm(path.join(dataDir, "panel-settings.json"));
  await fs.mkdir(path.join(dataDir, "panel-settings.json"));
  await assert.rejects(store.save({ startupMode: "panel" }));
  assert.equal((await store.read()).startupMode, "off");
  assert.deepEqual(calls, [true, false, true, false]);
  await store.close();
});

test("panel settings reject arbitrary process options and require the exact private owner session", async (t) => {
  const dataDir = await fixture(t);
  const runtime = await startDesktopRuntime({
    dataDir,
    scheduler: false,
    loginItem: { supported: true, setEnabled: async () => {} },
  });
  t.after(() => runtime.close());
  const url = `${runtime.url}/api/desktop/settings`;
  const headers = {
    Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.token}`,
    "Content-Type": "application/json",
  };
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (
      await fetch(url, {
        headers: { ...headers, Origin: "https://remote.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url, {
        headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(url, { headers, method: "POST" })).status, 405);
  for (const body of [
    { executable: "arbitrary.exe" },
    { startupMode: "boot" },
    { startupServerId: "../escape" },
    { keepInTray: "false" },
    { startupMode: "server", startupServerId: "missing" },
    [],
  ])
    assert.equal(
      (await fetch(url, { headers, method: "PUT", body: JSON.stringify(body) }))
        .status,
      400,
    );
  assert.equal(
    (await fetch(url, { headers, method: "PUT", body: "x".repeat(4097) }))
      .status,
    413,
  );
  const response = await fetch(url, {
    headers,
    method: "PUT",
    body: JSON.stringify({ startupMode: "panel", keepInTray: false }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).startupMode, "panel");
  assert.equal(
    (await (await fetch(url, { headers })).json()).keepInTray,
    false,
  );
});

test("automatic launch uses normal server safety checks and only starts the explicitly configured server at sign-in", async (t) => {
  const dataDir = await fixture(t);
  let spawned = 0;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      if (chunk.toString() === "stop\n")
        setImmediate(() => child.emit("close", 0));
      callback();
    },
  });
  const runtime = await startDesktopRuntime({
    dataDir,
    scheduler: false,
    loginItem: { supported: true, setEnabled: async () => {} },
    spawnServer: () => {
      spawned += 1;
      setImmediate(() =>
        child.stdout.write(
          '[Server thread/INFO]: Done (1.24s)! For help, type "help"\n',
        ),
      );
      return child;
    },
  });
  t.after(() => runtime.close());
  const request = (route, method = "GET", body, serverId) =>
    fetch(`${runtime.url}/api${route}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.token}`,
        "Content-Type": "application/json",
        ...(serverId ? { "X-Server-Id": serverId } : {}),
      },
    });
  const first = (
    await (
      await request("/servers", "POST", { name: "Unselected", port: 25565 })
    ).json()
  ).server;
  const second = (
    await (
      await request("/servers", "POST", { name: "Startup server", port: 25566 })
    ).json()
  ).server;
  await runtime.panelSettings.save({ startupMode: "panel" });
  await runtime.startConfiguredServer({ startupLaunch: true });
  assert.equal(spawned, 0);
  await runtime.panelSettings.save({
    startupMode: "server",
    startupServerId: second.id,
  });
  await runtime.startConfiguredServer();
  assert.equal(spawned, 0);
  await request(
    "/files",
    "POST",
    { name: "server.jar", type: "file", content: "never executed" },
    second.id,
  );
  await assert.rejects(
    runtime.startConfiguredServer({ startupLaunch: true }),
    /EULA/i,
  );
  assert.equal(spawned, 0);
  assert.match(runtime.panelSettings.snapshot().startupError, /EULA/i);
  const eula = await (
    await request("/files/content?path=eula.txt", "GET", undefined, second.id)
  ).json();
  assert.equal(
    (
      await request(
        "/files/content",
        "PUT",
        { ...eula, path: "eula.txt", content: "eula=true\n" },
        second.id,
      )
    ).status,
    200,
  );
  await runtime.startConfiguredServer({ startupLaunch: true });
  assert.equal(spawned, 1);
  assert.equal(
    runtime.fleet.runtimes.get(first.id).descriptor().status,
    "offline",
  );
  assert.equal(
    (await (await request("/desktop/selection")).json()).activeServerId,
    second.id,
  );
  await runtime.close();
});

test("window close uses the saved tray preference and never hides a quitting window or one without a tray", () => {
  for (const trayAvailable of [false, true])
    for (const quitting of [false, true])
      for (const keepInTray of [false, true])
        assert.equal(
          keepWindowInTray({ trayAvailable, quitting, keepInTray }),
          trayAvailable && !quitting && keepInTray,
        );
});
