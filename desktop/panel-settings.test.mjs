import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  createPanelSettings,
  keepWindowInTray,
  skipAutomaticServerStart,
  updateRecoveryArguments,
} from "./panel-settings.mjs";
import { DESKTOP_COOKIE_NAME, startDesktopRuntime } from "./runtime.mjs";

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-panel-settings-"),
  );
  const runtimes = [];
  const spawned = [];
  const launch = async (options = {}) => {
    const runtime = await startDesktopRuntime({
      dataDir,
      scheduler: false,
      spawnServer: (_executable, _args, { cwd }) => {
        spawned.push(cwd);
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
        setImmediate(() =>
          child.stdout.write(
            '[Server thread/INFO]: Done (1.24s)! For help, type "help"\n',
          ),
        );
        return child;
      },
      ...options,
    });
    runtimes.push(runtime);
    return {
      ...runtime,
      request: (route, method = "GET", body, serverId) =>
        fetch(`${runtime.url}/api${route}`, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
          headers: {
            Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.token}`,
            "Content-Type": "application/json",
            ...(serverId ? { "X-Server-Id": serverId } : {}),
          },
        }),
    };
  };
  t.after(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("mc-panel-settings-"));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, launch, spawned };
}

async function server(runtime, name, port, ready = true) {
  const created = await runtime.request("/servers", "POST", { name, port });
  assert.equal(created.status, 201);
  const { server } = await created.json();
  assert.equal(
    (
      await runtime.request(
        "/files",
        "POST",
        { name: "server.jar", type: "file", content: "never executed" },
        server.id,
      )
    ).status,
    201,
  );
  if (ready) await acceptEula(runtime, server.id);
  return server;
}

async function acceptEula(runtime, id) {
  const eula = await (
    await runtime.request("/files/content?path=eula.txt", "GET", undefined, id)
  ).json();
  assert.equal(
    (
      await runtime.request(
        "/files/content",
        "PUT",
        { ...eula, path: "eula.txt", content: "eula=true\n" },
        id,
      )
    ).status,
    200,
  );
}

test("login, automatic server selection, and tray choices persist independently without replacing stale IDs", async (t) => {
  const { dataDir } = await fixture(t);
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
  assert.equal((await store.read()).startAtLogin, false);
  assert.deepEqual(store.snapshot().autoStartServerIds, []);
  assert.equal(store.snapshot().keepInTray, true);
  await store.save({ autoStartServerIds: ["one", "two", "one"] });
  assert.deepEqual(registrations, []);
  await store.save({ startAtLogin: true });
  await store.save({ keepInTray: false });
  store.snapshot().autoStartServerIds.push("foreign");
  await store.close();
  assert.deepEqual(registrations, [true]);
  const restored = createPanelSettings(options);
  assert.deepEqual((await restored.read()).autoStartServerIds, ["one", "two"]);
  assert.equal(restored.snapshot().keepInTray, false);
  servers.delete("one");
  assert.deepEqual((await restored.read()).missingAutoStartServerIds, ["one"]);
  await restored.save({ autoStartServerIds: ["one", "two"], keepInTray: true });
  await assert.rejects(
    restored.save({ autoStartServerIds: ["one", "missing"] }),
    { status: 400 },
  );
  await restored.save({ autoStartServerIds: ["two"], startAtLogin: false });
  assert.deepEqual(restored.snapshot().missingAutoStartServerIds, []);
  assert.deepEqual(registrations, [true, false]);
  await restored.close();
  await assert.rejects(restored.save({ keepInTray: true }), { status: 503 });
});

test("legacy startup modes migrate atomically without OS writes, including an unavailable selected server", async (t) => {
  const { dataDir } = await fixture(t);
  for (const [startupMode, startupServerId, expectedLogin, expectedIds] of [
    ["off", "old-dormant-choice", false, []],
    ["panel", null, true, []],
    ["server", "available", true, ["available"]],
    ["server", "removed", true, ["removed"]],
  ]) {
    await fs.writeFile(
      path.join(dataDir, "panel-settings.json"),
      JSON.stringify({ startupMode, startupServerId, keepInTray: false }),
    );
    const store = createPanelSettings({
      dataDir,
      hasServer: (id) => id === "available",
      loginItem: { supported: false, setEnabled: assert.fail },
    });
    const migrated = await store.read();
    assert.equal(migrated.startAtLogin, expectedLogin);
    assert.deepEqual(migrated.autoStartServerIds, expectedIds);
    assert.deepEqual(
      migrated.missingAutoStartServerIds,
      expectedIds.filter((id) => id === "removed"),
    );
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(path.join(dataDir, "panel-settings.json"), "utf8"),
      ),
      {
        startAtLogin: expectedLogin,
        autoStartServerIds: expectedIds,
        keepInTray: false,
      },
    );
    await store.save({ keepInTray: true });
    await store.save({ autoStartServerIds: [] });
    assert.equal(store.snapshot().startAtLogin, expectedLogin);
    await store.close();
  }
});

test("invalid legacy settings and failed migration keep their original file for repair", async (t) => {
  const { dataDir } = await fixture(t);
  // safePath resolves the data directory before constructing rename targets.
  // Windows Temp can be a short-path alias on CI, so match its canonical root.
  const filename = path.join(await fs.realpath(dataDir), "panel-settings.json");
  const settingsDataDir =
    process.platform === "win32" ? dataDir.toUpperCase() : dataDir;
  const invalid = JSON.stringify({
    startupMode: "server",
    startupServerId: null,
    keepInTray: true,
  });
  await fs.writeFile(filename, invalid);
  await assert.rejects(
    createPanelSettings({
      dataDir: settingsDataDir,
      hasServer: () => true,
    }).read(),
    { status: 400 },
  );
  assert.equal(await fs.readFile(filename, "utf8"), invalid);
  const original = JSON.stringify({
    startupMode: "server",
    startupServerId: "previous",
    keepInTray: false,
  });
  await fs.writeFile(filename, original);
  const rename = fs.rename;
  let errorCode = "EIO";
  const injectedFailures = [];
  const fault = t.mock.method(fs, "rename", async (source, target) => {
    if (target === filename) {
      injectedFailures.push(errorCode);
      throw Object.assign(new Error("Disk write failed"), { code: errorCode });
    }
    return rename(source, target);
  });
  await assert.rejects(
    createPanelSettings({
      dataDir: settingsDataDir,
      hasServer: () => true,
    }).read(),
    /Disk write failed/,
  );
  assert.deepEqual(injectedFailures, ["EIO"]);
  assert.equal(await fs.readFile(filename, "utf8"), original);
  errorCode = "ENOENT";
  await assert.rejects(
    createPanelSettings({
      dataDir: settingsDataDir,
      hasServer: () => true,
    }).read(),
    /Disk write failed/,
  );
  assert.deepEqual(injectedFailures, ["EIO", "ENOENT"]);
  assert.equal(await fs.readFile(filename, "utf8"), original);
  fault.mock.restore();
  assert.deepEqual(
    (
      await createPanelSettings({
        dataDir: settingsDataDir,
        hasServer: () => false,
      }).read()
    ).autoStartServerIds,
    ["previous"],
  );
});

test("unsupported login permits automatic server and tray preferences; registration and disk failures roll back", async (t) => {
  const { dataDir } = await fixture(t);
  const unsupported = createPanelSettings({ dataDir, hasServer: () => true });
  await assert.rejects(unsupported.save({ startAtLogin: true }), {
    status: 409,
  });
  await unsupported.save({
    autoStartServerIds: ["one", "two"],
    keepInTray: false,
  });
  assert.equal((await unsupported.read()).startAtLogin, false);
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
  await assert.rejects(
    store.save({ startAtLogin: true, autoStartServerIds: [] }),
    /Windows refused/,
  );
  assert.equal((await store.read()).startAtLogin, false);
  assert.deepEqual(store.snapshot().autoStartServerIds, ["one", "two"]);
  assert.equal(store.snapshot().keepInTray, false);
  assert.deepEqual(calls, [true, false]);
  registrationFails = false;
  await fs.rm(path.join(dataDir, "panel-settings.json"));
  await fs.mkdir(path.join(dataDir, "panel-settings.json"));
  await assert.rejects(store.save({ startAtLogin: true }));
  assert.equal((await store.read()).startAtLogin, false);
  assert.deepEqual(calls, [true, false, true, false]);
  await store.close();
});

test("panel settings validate bounded IDs and require the exact private owner session", async (t) => {
  const { launch } = await fixture(t);
  const runtime = await launch({
    loginItem: { supported: true, setEnabled: async () => {} },
  });
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
    { startAtLogin: "true" },
    { autoStartServerIds: "one" },
    { autoStartServerIds: ["../escape"] },
    { autoStartServerIds: ["a".repeat(129)] },
    { autoStartServerIds: ["missing"] },
    { autoStartServerIds: Array(101).fill("one") },
    { keepInTray: "false" },
    { startupMode: "panel" },
    [],
  ])
    assert.equal(
      (await fetch(url, { headers, method: "PUT", body: JSON.stringify(body) }))
        .status,
      400,
    );
  assert.equal(
    (await fetch(url, { headers, method: "PUT", body: "x".repeat(32769) }))
      .status,
    413,
  );
  const response = await fetch(url, {
    headers,
    method: "PUT",
    body: JSON.stringify({ startAtLogin: true, keepInTray: false }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).startAtLogin, true);
  assert.equal(
    (await (await fetch(url, { headers })).json()).keepInTray,
    false,
  );
});

test("each fresh manual panel launch starts multiple saved servers once, preserves selection, and continues past individual failures", async (t) => {
  const { launch, spawned } = await fixture(t);
  const runtime = await launch();
  const unselected = await server(runtime, "Unselected", 25565);
  const broken = await server(runtime, "Needs EULA", 25566, false);
  const first = await server(runtime, "First automatic", 25567);
  const second = await server(runtime, "Second automatic", 25568);
  const removed = await server(runtime, "Removed automatic", 25569);
  await runtime.panelSettings.save({
    autoStartServerIds: [broken.id, first.id, removed.id, second.id, first.id],
  });
  assert.equal(
    (await runtime.request(`/servers/${removed.id}`, "DELETE")).status,
    200,
  );
  await runtime.selectLocalServer(unselected.id);
  const firstAttempt = runtime.startConfiguredServers();
  assert.equal(runtime.startConfiguredServers(), firstAttempt);
  const result = await firstAttempt;
  assert.deepEqual(result.startedServerIds, [first.id, second.id]);
  assert.deepEqual(
    result.failures.map((failure) => failure.serverId),
    [broken.id, removed.id],
  );
  assert.match(
    runtime.panelSettings.snapshot().startupError,
    /Needs EULA.*EULA/,
  );
  assert.match(
    runtime.panelSettings.snapshot().startupError,
    /no longer available/,
  );
  assert.equal(spawned.length, 2);
  assert.equal(
    runtime.fleet.runtimes.get(unselected.id).descriptor().status,
    "offline",
  );
  assert.equal(
    (await (await runtime.request("/desktop/selection")).json()).activeServerId,
    unselected.id,
  );
  await acceptEula(runtime, broken.id);
  await runtime.panelSettings.save({
    autoStartServerIds: [broken.id, first.id, second.id],
  });
  assert.deepEqual(await runtime.startConfiguredServers(), result);
  assert.equal(
    spawned.length,
    2,
    "Settings edits and repeated activation cannot start another process during this launch.",
  );
  await runtime.close();
  const reopened = await launch();
  const next = await reopened.startConfiguredServers();
  assert.deepEqual(next.failures, []);
  assert.deepEqual(next.startedServerIds, [broken.id, first.id, second.id]);
  assert.equal(spawned.length, 5);
  assert.equal(
    (await (await reopened.request("/desktop/selection")).json())
      .activeServerId,
    unselected.id,
  );
});

test("update relaunch suppression consumes the current launch only; later manual launches keep their saved selections", async (t) => {
  const { launch, spawned } = await fixture(t);
  const runtime = await launch();
  const selected = await server(runtime, "Automatic", 25565);
  await runtime.panelSettings.save({ autoStartServerIds: [selected.id] });
  const skipped = await runtime.startConfiguredServers({ skipAutoStart: true });
  assert.equal(skipped.skipped, true);
  assert.deepEqual(await runtime.startConfiguredServers(), skipped);
  assert.equal(spawned.length, 0);
  await runtime.close();
  const manual = await launch();
  assert.deepEqual((await manual.startConfiguredServers()).startedServerIds, [
    selected.id,
  ]);
  assert.equal(spawned.length, 1);
  assert.equal(skipAutomaticServerStart([]), false);
  assert.equal(skipAutomaticServerStart(["--startup"]), false);
  assert.equal(skipAutomaticServerStart(["--updated"]), true);
  assert.equal(skipAutomaticServerStart(["--startup", "--updated"]), true);
  const args = updateRecoveryArguments([
    "--user-data-dir=C:/profile",
    "--startup",
    "--updated",
  ]);
  assert.deepEqual(args, ["--user-data-dir=C:/profile", "--updated"]);
  assert.equal(skipAutomaticServerStart(args), true);
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
