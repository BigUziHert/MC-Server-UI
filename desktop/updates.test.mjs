import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyDownloadedUpdate, createUpdateController } from "./updates.mjs";
import { startDesktopRuntime, DESKTOP_COOKIE_NAME } from "./runtime.mjs";
import { devVersion } from "./stamp-dev-version.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
test("installer failures trigger app recovery even when the updater reports an event instead of throwing", () => {
  for (const failure of ["event", "throw"]) {
    const updater = new EventEmitter();
    const recovered = [];
    updater.quitAndInstall = (silent, reopen) => {
      assert.equal(silent, true);
      assert.equal(reopen, true);
      if (failure === "throw") throw new Error("Installer denied");
      updater.emit("error", new Error("Installer denied"));
    };
    applyDownloadedUpdate(updater, (cause) => recovered.push(cause.message));
    assert.deepEqual(recovered, ["Installer denied"]);
  }
});
function fixture(options = {}) {
  const updater = new EventEmitter();
  let checks = 0,
    downloads = 0,
    installs = 0;
  updater.checkForUpdates = async () => {
    checks++;
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "0.1.3-dev.2.1" });
  };
  updater.downloadUpdate = async () => {
    downloads++;
    updater.emit("download-progress", { percent: 51.5 });
    updater.emit("update-downloaded", { version: "0.1.3-dev.2.1" });
  };
  const controller = createUpdateController({
    updater,
    version: "0.1.3-dev.0",
    supported: true,
    install: async () => {
      installs++;
      return true;
    },
    ...options,
  });
  return {
    updater,
    controller,
    counts: () => ({ checks, downloads, installs }),
  };
}

test("updates require separate check, verified download, and explicit install; duplicate requests coalesce", async (t) => {
  const { updater, controller, counts } = fixture();
  t.after(() => controller.dispose());
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.disableWebInstaller, true);
  controller.install();
  controller.download();
  controller.check();
  controller.check();
  await tick();
  assert.deepEqual(counts(), { checks: 1, downloads: 0, installs: 0 });
  assert.equal(controller.snapshot().status, "available");
  controller.download();
  controller.download();
  await tick();
  assert.equal(controller.snapshot().status, "downloaded");
  assert.deepEqual(counts(), { checks: 1, downloads: 1, installs: 0 });
  controller.check();
  assert.equal(controller.snapshot().status, "downloaded");
  controller.install();
  controller.install();
  assert.equal(controller.snapshot().status, "installing");
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(counts().installs, 1);
});

test("missing feeds, offline checks, and failed verification are retryable and never install", async (t) => {
  const { updater, controller, counts } = fixture();
  t.after(() => controller.dispose());
  updater.checkForUpdates = async () => {
    throw Object.assign(new Error("404"), {
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });
  };
  controller.check();
  await tick();
  assert.equal(controller.snapshot().status, "error");
  assert.match(controller.snapshot().message, /No published dev build/);
  updater.checkForUpdates = async () => {
    updater.emit("update-available", { version: "0.1.3-dev.2.1" });
  };
  controller.check();
  await tick();
  updater.downloadUpdate = async () => {
    throw new Error("SHA512 checksum mismatch");
  };
  controller.download();
  await tick();
  assert.equal(controller.snapshot().status, "error");
  controller.install();
  assert.equal(counts().installs, 0);
  updater.checkForUpdates = async () => {
    updater.emit("update-not-available", { version: "0.1.3-dev.0" });
  };
  controller.check();
  await tick();
  assert.equal(controller.snapshot().status, "current");
});

test("cancelling a server shutdown keeps the downloaded update available", async (t) => {
  const { controller } = fixture({ install: async () => false });
  t.after(() => controller.dispose());
  controller.check();
  await tick();
  controller.download();
  await tick();
  controller.install();
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(controller.snapshot().status, "downloaded");
  assert.match(controller.snapshot().message, /still running/);
});

test("portable and source copies never check, download, or launch installers", async () => {
  const { controller, counts } = fixture({ supported: false });
  controller.check();
  controller.download();
  controller.install();
  await tick();
  assert.equal(controller.snapshot().status, "unsupported");
  assert.deepEqual(counts(), { checks: 0, downloads: 0, installs: 0 });
  controller.dispose();
});

test("a stalled install exposes shutdown options without starting a second installation or killing servers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  let installs = 0;
  let shown = 0;
  const { controller } = fixture({
    installTimeoutMs: 100,
    install: () => {
      installs += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    onInstallPending: () => {
      shown += 1;
    },
  });
  t.after(() => controller.dispose());
  controller.check();
  await tick();
  controller.download();
  await tick();
  controller.install();
  t.mock.timers.tick(150);
  await tick();
  t.mock.timers.tick(100);
  assert.equal(controller.snapshot().status, "shutdown-waiting");
  assert.equal(shown, 1);
  controller.install();
  assert.equal(shown, 2);
  assert.equal(installs, 1);
  finish(false);
  await tick();
  assert.equal(controller.snapshot().status, "downloaded");
});

test("disposing cancels pending install/watchdogs and removes only the controller's updater listeners", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { updater, controller, counts } = fixture();
  const unrelated = () => {};
  updater.on("update-available", unrelated);
  controller.check();
  await tick();
  controller.download();
  await tick();
  controller.install();
  controller.dispose();
  t.mock.timers.tick(1000000);
  await tick();
  assert.equal(counts().installs, 0);
  assert.deepEqual(updater.listeners("update-available"), [unrelated]);
  assert.equal(updater.listenerCount("checking-for-update"), 0);
  assert.equal(updater.listenerCount("error"), 0);
  controller.check();
  controller.install();
  await tick();
  assert.equal(counts().checks, 1);
  assert.equal(counts().installs, 0);
  const pending = fixture();
  pending.controller.check();
  pending.controller.dispose();
  await tick();
  assert.equal(
    pending.counts().checks,
    0,
    "disposed controllers must not start deferred network checks",
  );
});

test("dev workflow versions increase for new builds and reruns without source version commits", () => {
  assert.equal(devVersion("0.1.3-dev.0", "2", "1"), "0.1.3-dev.2.1");
  assert.equal(devVersion("0.1.3-dev.0", "2", "2"), "0.1.3-dev.2.2");
  assert.equal(devVersion("0.1.3-dev.0", "3", "1"), "0.1.3-dev.3.1");
  for (const input of ["", "0", "-1", "1;command", "1.5"])
    assert.throws(() => devVersion("0.1.3", input, "1"), /valid base version/);
});

test("desktop update API is session-authenticated, fixed-action only, and independent of selected server", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-updates-test-"));
  const { controller } = fixture();
  const runtime = await startDesktopRuntime({
    dataDir: path.join(root, "data"),
    scheduler: false,
    updates: controller,
  });
  t.after(async () => {
    controller.dispose();
    await runtime.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-updates-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = (suffix = "", options = {}) =>
    fetch(`${runtime.url}/api/desktop/updates${suffix}`, {
      ...options,
      headers: {
        Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.token}`,
        ...options.headers,
      },
    });
  assert.equal((await fetch(`${runtime.url}/api/desktop/updates`)).status, 401);
  assert.equal(
    (
      await request("/download", {
        method: "POST",
        headers: { Origin: "https://example.com" },
      })
    ).status,
    403,
  );
  assert.equal((await request("/check")).status, 405);
  assert.equal((await request("/execute", { method: "POST" })).status, 404);
  assert.equal((await (await request()).json()).version, "0.1.3-dev.0");
  await request("/check", { method: "POST" });
  await tick();
  assert.equal((await (await request()).json()).status, "available");
  assert.deepEqual(
    await (
      await fetch(`${runtime.url}/api/servers`, {
        headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.token}` },
      })
    ).json(),
    { servers: [], defaultServerId: null },
  );
});
