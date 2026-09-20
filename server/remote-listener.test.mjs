import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createAccessService } from "./access.mjs";
import { createRemoteListener } from "./remote-access.mjs";

const stop = async (server) => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
const occupy = () =>
  new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) =>
      res.end("occupied fixture"),
    );
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
const freePort = async () => {
  const server = await occupy();
  const port = server.address().port;
  await stop(server);
  return port;
};
const read = (port, ca) =>
  new Promise((resolve, reject) => {
    const request = (ca ? https : http).get(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        agent: false,
        ...(ca ? { ca } : {}),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode, body }),
        );
      },
    );
    request.once("error", reject);
    request.setTimeout(2000, () =>
      request.destroy(new Error("Fixture request timed out.")),
    );
  });

async function fixture(
  t,
  {
    enabled = false,
    port,
    listen = true,
    delayListening,
    transport = "proxy",
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-remote-listener-"));
  const servers = [],
    events = [];
  const access = await createAccessService({
    dataDir: root,
    getUser: () => null,
    listMemberships: () => [],
  });
  await access.configure({
    enabled,
    publicUrl: "https://panel.example.test",
    transport,
    port: port ?? (await freePort()),
  });
  const app = (_req, res) => res.end("remote listener fixture");
  const remote = createRemoteListener({
    app,
    access,
    dataDir: root,
    listen,
    bindHost: "127.0.0.1",
    localAddresses: () => ["192.168.10.20"],
    createServer(settings, tlsOptions, handler) {
      const server =
        settings.transport === "direct"
          ? https.createServer(tlsOptions, handler)
          : http.createServer(handler);
      const requestedPort = settings.port;
      const originalListen = server.listen.bind(server);
      server.listen = (actualPort, host, callback) => {
        assert.equal(host, "127.0.0.1", "tests bind only to loopback");
        assert.equal(actualPort, requestedPort);
        return originalListen(actualPort, host, async () => {
          events.push(`listening:${requestedPort}`);
          if (delayListening) await delayListening();
          callback();
        });
      };
      server.on("close", () => events.push(`closed:${requestedPort}`));
      servers.push(server);
      return server;
    },
  });
  t.after(async () => {
    await remote.close();
    await access.close();
    await Promise.all(servers.map(stop));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-remote-listener-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, access, remote, events, servers, port: access.status().port };
}

test("remote listener enables, disables, reuses its configured port, and closes cleanly", async (t) => {
  const f = await fixture(t);
  await f.remote.start();
  assert.equal(f.servers.length, 0);
  assert.equal(f.remote.status().listening, false);
  await f.remote.configure({ enabled: true });
  assert.deepEqual(await read(f.port), {
    status: 200,
    body: "remote listener fixture",
  });
  assert.equal(f.remote.status().ready, true);
  await f.remote.configure({ publicUrl: "https://new-panel.example.test" });
  assert.equal(
    f.servers.length,
    1,
    "a proxy origin change does not unnecessarily replace the socket",
  );
  await f.remote.configure({ enabled: false });
  assert.equal(f.remote.status().listening, false);
  await assert.rejects(read(f.port), { code: "ECONNREFUSED" });
  await f.remote.configure({ enabled: true });
  assert.equal(f.servers.length, 2);
  assert.equal((await read(f.port)).status, 200);
  await f.remote.close();
  assert.equal(f.remote.status().listening, false);
  await assert.rejects(read(f.port), { code: "ECONNREFUSED" });
  await assert.rejects(f.remote.configure({ enabled: true }), { status: 503 });
});

test("a remote port change starts the replacement before closing the previous socket", async (t) => {
  const f = await fixture(t, { enabled: true });
  await f.remote.start();
  const nextPort = await freePort();
  await f.remote.configure({ port: nextPort });
  assert.equal((await read(nextPort)).status, 200);
  await assert.rejects(read(f.port), { code: "ECONNREFUSED" });
  assert.deepEqual(f.events, [
    `listening:${f.port}`,
    `listening:${nextPort}`,
    `closed:${f.port}`,
  ]);
  assert.equal(f.remote.status().port, nextPort);
  assert.equal(f.remote.status().listening, true);
});

test("a conflicting port disables remote access, stops the old socket, and permits recovery", async (t) => {
  const occupied = await occupy();
  t.after(() => stop(occupied));
  const conflictPort = occupied.address().port;
  const f = await fixture(t, { enabled: true });
  await f.remote.start();
  await assert.rejects(
    f.remote.configure({ port: conflictPort }),
    (error) =>
      error.status === 409 && /remote port is unavailable/.test(error.message),
  );
  assert.equal(f.remote.status().enabled, false);
  assert.equal(f.remote.status().ready, false);
  assert.equal(f.remote.status().listening, false);
  assert.equal(
    JSON.stringify(f.remote.status()).includes("PRIVATE KEY"),
    false,
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(f.root, "remote-access.json"), "utf8"),
    ).configuration.enabled,
    false,
  );
  await assert.rejects(read(f.port), { code: "ECONNREFUSED" });
  assert.equal((await read(conflictPort)).body, "occupied fixture");
  const recovered = await f.remote.configure({ enabled: true, port: f.port });
  assert.equal(recovered.ready, true);
  assert.equal(recovered.error, undefined);
  assert.equal((await read(f.port)).status, 200);
});

test("startup port conflicts report unavailable access and saving a free port recovers", async (t) => {
  const occupied = await occupy();
  t.after(() => stop(occupied));
  const f = await fixture(t, { enabled: true, port: occupied.address().port });
  await f.remote.start();
  assert.equal(f.remote.status().enabled, false);
  assert.equal(f.remote.status().listening, false);
  assert.equal(f.remote.status().ready, false);
  assert.match(f.remote.status().error, /remote port is unavailable/);
  const nextPort = await freePort();
  await f.remote.configure({ enabled: true, port: nextPort });
  assert.equal(f.remote.status().error, undefined);
  assert.equal(f.remote.status().listening, true);
  assert.equal((await read(nextPort)).status, 200);
});

test("shutdown drains an in-flight settings change without leaving a new listener behind", async (t) => {
  let release, reportListening;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const listening = new Promise((resolve) => {
    reportListening = resolve;
  });
  const f = await fixture(t, {
    delayListening: async () => {
      reportListening();
      await hold;
    },
  });
  const configuring = f.remote.configure({ enabled: true });
  await listening;
  const closing = f.remote.close();
  release();
  await configuring;
  await closing;
  assert.equal(f.remote.status().listening, false);
  await assert.rejects(read(f.port), { code: "ECONNREFUSED" });
  await assert.rejects(f.remote.configure({ port: f.port }), { status: 503 });
});

test("test-mode remote listener preserves settings without opening sockets", async (t) => {
  const f = await fixture(t, { enabled: true, listen: false });
  await f.remote.start();
  await f.remote.configure({ publicUrl: "https://other-panel.example.test" });
  assert.equal(f.remote.status().listening, false);
  assert.equal(f.servers.length, 0);
  assert.equal(f.remote.status().publicUrl, "https://other-panel.example.test");
});

test("direct access serves verified HTTPS, preserves its certificate, and can switch to proxy on the same port", async (t) => {
  const f = await fixture(t, { enabled: true, transport: "direct" });
  await f.remote.start();
  assert.equal(f.remote.status().ready, true);
  const saved = JSON.parse(
    await fs.readFile(path.join(f.root, "remote-tls.json"), "utf8"),
  );
  assert.deepEqual(await read(f.port, saved.cert), {
    status: 200,
    body: "remote listener fixture",
  });
  // HTTPS clients must actually trust the self-signed certificate to connect.
  await assert.rejects(
    new Promise((resolve, reject) => {
      const request = https.get(
        { host: "127.0.0.1", port: f.port, path: "/", agent: false },
        resolve,
      );
      request.once("error", reject);
    }),
    { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
  );
  assert.equal(
    JSON.stringify(f.remote.status()).includes("PRIVATE KEY"),
    false,
  );
  await f.remote.configure({ enabled: false });
  await f.remote.configure({ enabled: true });
  assert.equal((await read(f.port, saved.cert)).status, 200);
  const restarted = JSON.parse(
    await fs.readFile(path.join(f.root, "remote-tls.json"), "utf8"),
  );
  assert.equal(restarted.cert, saved.cert);
  assert.equal(restarted.key, saved.key);
  await f.remote.configure({ transport: "proxy" });
  assert.equal(f.remote.status().transport, "proxy");
  assert.equal(f.remote.status().ready, true);
  assert.equal((await read(f.port)).status, 200);
  assert.deepEqual(f.events, [
    `listening:${f.port}`,
    `closed:${f.port}`,
    `listening:${f.port}`,
    `closed:${f.port}`,
    `listening:${f.port}`,
  ]);
});
