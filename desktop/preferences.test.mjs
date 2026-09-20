import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createDesktopPreferences,
  validatePreference,
} from "./preferences.mjs";
import { DESKTOP_COOKIE_NAME, startDesktopRuntime } from "./runtime.mjs";

const navigation = "mc-panel.navigation-collapsed";
const rows = "mc-panel.launchpad.rows";
const view = "mc-panel.launchpad.view.a41d57d1-0670-4597-9aa4-67a8ad249d8d";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-preferences-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-preferences-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("desktop preferences whitelist display fields and reject credentials, arbitrary keys, and oversized values", () => {
  for (const [key, value] of [
    [navigation, '{"server":true,"minecraft":false}'],
    [rows, "25"],
    ["mc-panel.players.rows.history", "100"],
    [
      view,
      '{"platform":"modrinth","type":"mod","loader":"fabric","gameVersion":"1.21.1","installedOnly":true,"sort":"downloads","installedSort":"updates"}',
    ],
  ])
    assert.equal(validatePreference(key, value), value);
  for (const [key, value] of [
    ["password", "secret"],
    ["mc-panel-desktop", "token"],
    ["mc-panel.active-server", "server"],
    [rows, "10000"],
    [navigation, '{"server":"true"}'],
    [navigation, '{"token":"secret"}'],
    [view, '{"password":"secret"}'],
    [view, '{"platform":"arbitrary secret"}'],
    [view, '{"gameVersion":"secret"}'],
    [view, '{"installedOnly":"true"}'],
    [view, "x".repeat(4097)],
    ["../desktop-selection.json", "{}"],
  ])
    assert.throws(() => validatePreference(key, value), { status: 400 });
});

test("preference writes serialize and survive restart without copying unrelated browser data", async (t) => {
  const dataDir = await fixture(t);
  const store = createDesktopPreferences({ dataDir });
  await Promise.all([
    store.save(rows, "25"),
    store.save(navigation, '{"server":true}'),
  ]);
  await store.save(rows, "50");
  await store.close();
  const restored = createDesktopPreferences({ dataDir });
  assert.deepEqual(await restored.read(), {
    desktop: true,
    preferences: {
      [rows]: "50",
      [navigation]: '{"server":true}',
    },
  });
  await assert.rejects(store.save(rows, "5"), { status: 503 });
  await restored.close();
});

test("obsolete or malformed preference files recover safely and filesystem errors stay generic at the private endpoint", async (t) => {
  const dataDir = await fixture(t);
  const target = path.join(dataDir, "desktop-preferences.json");
  await fs.writeFile(
    target,
    JSON.stringify({ [rows]: "25", secret: "not a preference" }),
  );
  assert.deepEqual(
    (await createDesktopPreferences({ dataDir }).read()).preferences,
    { [rows]: "25" },
  );
  await fs.writeFile(target, "malformed");
  assert.deepEqual(
    (await createDesktopPreferences({ dataDir }).read()).preferences,
    {},
  );
  await fs.rm(target);
  await fs.mkdir(target);
  const runtime = await startDesktopRuntime({ dataDir, scheduler: false });
  t.after(() => runtime.close());
  const response = await fetch(`${runtime.url}/api/desktop/preferences`, {
    headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.token}` },
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Display preferences could not be saved or read.",
  });
});

test("preferences require the private owner cookie and exact origin and restore with a new session token and port", async (t) => {
  const dataDir = await fixture(t);
  const runtime = await startDesktopRuntime({ dataDir, scheduler: false });
  const request = (options = {}) =>
    fetch(`${runtime.url}/api/desktop/preferences`, {
      ...options,
      headers: {
        Cookie: `${DESKTOP_COOKIE_NAME}=${runtime.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  assert.equal(
    (await fetch(`${runtime.url}/api/desktop/preferences`)).status,
    401,
  );
  assert.equal(
    (await request({ headers: { Origin: "https://remote.example" } })).status,
    403,
  );
  assert.equal(
    (await request({ headers: { "Sec-Fetch-Site": "cross-site" } })).status,
    403,
  );
  assert.equal((await request({ method: "POST" })).status, 405);
  assert.equal(
    (
      await request({
        method: "PUT",
        body: JSON.stringify({ key: "password", value: "secret" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (await request({ method: "PUT", body: "x".repeat(8193) })).status,
    413,
  );
  assert.equal(
    (
      await request({
        method: "PUT",
        body: JSON.stringify({ key: rows, value: "75" }),
      })
    ).status,
    204,
  );
  await runtime.close();
  const second = await startDesktopRuntime({ dataDir, scheduler: false });
  t.after(() => second.close());
  assert.notEqual(second.token, runtime.token);
  const restored = await fetch(`${second.url}/api/desktop/preferences`, {
    headers: { Cookie: `${DESKTOP_COOKIE_NAME}=${second.token}` },
  });
  assert.deepEqual(await restored.json(), {
    desktop: true,
    preferences: { [rows]: "75" },
  });
});
