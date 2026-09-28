// Real pinned Caddy + local test certificate; never contacts a public CA or
// listens on a public interface. --packaged also runs the guardian from ASAR.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import selfsigned from "selfsigned";
import { CADDY_RELEASE } from "./prepare-caddy.mjs";
import {
  createCaddyConfig,
  probeManagedHttps,
} from "../server/managed-https.mjs";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packaged = process.argv.includes("--packaged");
const resources = path.join(project, "release", "win-unpacked", "resources");
const bundle = packaged
  ? path.join(resources, "caddy")
  : path.join(project, "desktop", "vendor", "caddy");
const binary = path.join(bundle, "caddy.exe");
const guardian = packaged
  ? path.join(resources, "app.asar", "server", "managed-https-child.mjs")
  : path.join(project, "server", "managed-https-child.mjs");
const runner = packaged
  ? path.join(project, "release", "win-unpacked", "MC Panel.exe")
  : process.execPath;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-caddy-smoke-"));
let child;
let childExit;
let stderr = "";
const calls = [];
const upstream = http.createServer((req, res) => {
  calls.push({
    path: req.url,
    host: req.headers.host,
    authorization: req.headers.authorization,
  });
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      authenticated: false,
      setupRequired: false,
      passwordRequired: true,
      role: "guest",
      user: null,
    }),
  );
});
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(fn, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (cause) {
      last = cause;
    }
    if (child && child.exitCode !== null)
      throw new Error(`Caddy guardian exited: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${last?.message || "Caddy timed out"}\n${stderr}`);
}
try {
  const manifest = JSON.parse(
    await fs.readFile(path.join(bundle, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.version, CADDY_RELEASE.version);
  assert.equal(manifest.archiveSha256, CADDY_RELEASE.archiveSha256);
  for (const [name, digest] of Object.entries(manifest.files))
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(path.join(bundle, name)))
        .digest("hex"),
      digest,
      `Bundled ${name} digest`,
    );
  assert.match(
    await fs.readFile(path.join(bundle, "LICENSE"), "utf8"),
    /Apache License/,
  );
  assert.match(
    await fs.readFile(path.join(bundle, "MC-Panel-NOTICE.txt"), "utf8"),
    /unmodified/,
  );
  const version = await promisify(execFile)(binary, ["version"], {
    windowsHide: true,
    timeout: 15_000,
  });
  assert.ok(version.stdout.startsWith(`v${CADDY_RELEASE.version} `));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const ip = "203.0.113.10";
  const publicUrl = `https://${ip}`;
  const config = createCaddyConfig({
    publicUrl,
    upstreamPort: upstream.address().port,
    storageDir: path.join(root, "storage"),
    instanceId: "smoke-instance",
  });
  const configPath = path.join(root, "caddy.json");
  await fs.writeFile(configPath, JSON.stringify(config));
  // Caddy validate provisions the JSON without starting listeners or issuance.
  await promisify(execFile)(binary, ["validate", "--config", configPath], {
    windowsHide: true,
    timeout: 20_000,
  });
  const certificate = await selfsigned.generate(
    [{ name: "commonName", value: ip }],
    {
      keySize: 2048,
      algorithm: "sha256",
      notBeforeDate: new Date(Date.now() - 60_000),
      notAfterDate: new Date(Date.now() + 86400_000),
      extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip }] }],
    },
  );
  const certPath = path.join(root, "cert.pem");
  const keyPath = path.join(root, "key.pem");
  await fs.writeFile(certPath, certificate.cert);
  await fs.writeFile(keyPath, certificate.private);
  const port = await freePort();
  config.apps.tls = {
    certificates: { load_files: [{ certificate: certPath, key: keyPath }] },
  };
  config.apps.http.servers.panel.listen = [`127.0.0.1:${port}`];
  config.apps.http.servers.panel.automatic_https = { disable: true };
  assert.ok(
    !JSON.stringify(config).includes("acme"),
    "Running fixture has no ACME issuer",
  );
  await fs.writeFile(configPath, JSON.stringify(config));
  child = spawn(runner, [guardian, binary, configPath], {
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  childExit = once(child, "exit");
  const request = (options, callback) =>
    https.request({ ...options, port, ca: certificate.cert }, callback);
  await waitFor(() =>
    probeManagedHttps({ publicUrl, instanceId: "smoke-instance", request }),
  );
  assert.equal(
    calls[0].authorization,
    undefined,
    "Readiness sends no credentials",
  );
  assert.equal(calls[0].host, ip);
  await assert.rejects(
    probeManagedHttps({ publicUrl, instanceId: "different-panel", request }),
    { code: "WRONG_PANEL" },
  );
  await assert.rejects(
    probeManagedHttps({
      publicUrl,
      instanceId: "smoke-instance",
      request: (options, callback) =>
        https.request({ ...options, port }, callback),
    }),
    /self-signed|certificate/i,
  );
  const requestWithHost = (host, authorization) =>
    new Promise((resolve, reject) => {
      const req = https.get(
        {
          hostname: "127.0.0.1",
          port,
          servername: "",
          ca: certificate.cert,
          checkServerIdentity: (_host, cert) => {
            assert.ok(cert.subjectaltname.includes(ip));
          },
          headers: { Host: host, Authorization: authorization },
          path: "/api/access/session",
          agent: false,
        },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
    });
  assert.equal(await requestWithHost(ip, "Bearer smoke-only"), 200);
  assert.equal(calls.at(-1).authorization, "Bearer smoke-only");
  const beforeWrongHost = calls.length;
  assert.equal(
    await requestWithHost("different.invalid", "Bearer rejected"),
    421,
  );
  assert.equal(
    calls.length,
    beforeWrongHost,
    "Unexpected Host never reaches panel",
  );
  child.stdin.end();
  await Promise.race([
    childExit,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "Guardian failed to reap Caddy after parent pipe closure",
            ),
          ),
        10_000,
      );
      timer.unref();
    }),
  ]);
  child = undefined;
  await assert.rejects(
    probeManagedHttps({ publicUrl, instanceId: "smoke-instance", request }),
    /ECONNREFUSED|socket hang up/,
  );
  console.log(
    `Caddy ${CADDY_RELEASE.version} ${packaged ? "packaged" : "source"} smoke passed: production JSON validation, trusted test-IP TLS without SNI, scoped proxy, no trust bypass, guardian shutdown.`,
  );
} finally {
  if (child) {
    child.stdin.end();
    await childExit;
  }
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("mc-caddy-smoke-"));
  await fs.rm(root, { recursive: true, force: true });
}
