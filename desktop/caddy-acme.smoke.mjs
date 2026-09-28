// Isolated ACME issuance/renewal against Caddy's own local CA. Every socket is
// loopback-only; this never contacts Let's Encrypt or installs a trusted root.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";
import {
  createCaddyConfig,
  probeManagedHttps,
} from "../server/managed-https.mjs";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const binary = path.join(project, "desktop", "vendor", "caddy", "caddy.exe");
const guardian = path.join(project, "server", "managed-https-child.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-caddy-acme-"));
const processes = [];
const upstream = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ role: "guest" }));
});
async function reserve(port = 0) {
  const server = net.createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}
async function start(name, config) {
  const file = path.join(root, `${name}.json`);
  await fs.writeFile(file, JSON.stringify(config));
  const child = spawn(process.execPath, [guardian, binary, file], {
    windowsHide: true,
    stdio: ["pipe", "ignore", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      XDG_DATA_HOME: path.join(root, name, "data"),
      XDG_CONFIG_HOME: path.join(root, name, "config"),
    },
  });
  const entry = { child, log: "", exited: once(child, "exit") };
  child.stderr.on("data", (chunk) => {
    entry.log = `${entry.log}${chunk}`.slice(-30000);
  });
  child.stdin.on("error", () => {});
  processes.push(entry);
  return entry;
}
async function waitFor(operation, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (cause) {
      last = cause;
    }
    for (const { child, log } of processes)
      if (child.exitCode !== null) throw new Error(`Caddy exited: ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `${last?.message || "ACME fixture timed out"}\n${processes.map((entry) => entry.log).join("\n")}`,
  );
}
try {
  await reserve(443); // Fail clearly if a real local HTTPS service owns this port.
  const caPort = await reserve();
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const endpoint = await selfsigned.generate(
    [{ name: "commonName", value: "MC Panel ACME test endpoint" }],
    {
      keySize: 2048,
      algorithm: "sha256",
      notBeforeDate: new Date(Date.now() - 60000),
      notAfterDate: new Date(Date.now() + 3600000),
      extensions: [
        { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
      ],
    },
  );
  const endpointCert = path.join(root, "endpoint.crt");
  const endpointKey = path.join(root, "endpoint.key");
  await fs.writeFile(endpointCert, endpoint.cert);
  await fs.writeFile(endpointKey, endpoint.private);
  const caStorage = path.join(root, "ca-storage");
  await start("authority", {
    admin: { disabled: true, config: { persist: false } },
    storage: { module: "file_system", root: caStorage },
    apps: {
      pki: {
        certificate_authorities: {
          local: { name: "MC Panel isolated ACME test", install_trust: false },
        },
      },
      tls: {
        certificates: {
          load_files: [{ certificate: endpointCert, key: endpointKey }],
        },
      },
      http: {
        servers: {
          ca: {
            listen: [`127.0.0.1:${caPort}`],
            protocols: ["h1", "h2"],
            automatic_https: { disable: true },
            tls_connection_policies: [{ default_sni: "127.0.0.1" }],
            routes: [
              {
                handle: [
                  {
                    handler: "acme_server",
                    ca: "local",
                    lifetime: 300000000000,
                    challenges: ["tls-alpn-01"],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  });
  const caRoot = await waitFor(() =>
    fs.readFile(
      path.join(caStorage, "pki", "authorities", "local", "root.crt"),
      "utf8",
    ),
  );
  const localDirectory = `https://127.0.0.1:${caPort}/acme/local/directory`;
  const config = createCaddyConfig({
    publicUrl: "https://127.0.0.1",
    upstreamPort: upstream.address().port,
    storageDir: path.join(root, "client-storage"),
    instanceId: "acme-test",
  });
  config.apps.http.servers.panel.listen = ["127.0.0.1:443"];
  config.apps.pki = {
    certificate_authorities: { local: { install_trust: false } },
  };
  config.logging.logs.default.level = "INFO";
  config.apps.tls.automation.renew_interval = 1000000000;
  const policy = config.apps.tls.automation.policies[0];
  policy.renewal_window_ratio = 0.99;
  const issuer = policy.issuers[0];
  // The production profile is validated by caddy.smoke.mjs. Caddy's local CA
  // does not advertise ACME profiles; use its five-minute fixture lifetime.
  delete issuer.profile;
  issuer.ca = localDirectory;
  issuer.test_ca = localDirectory;
  issuer.trusted_roots_pem_files = [endpointCert];
  issuer.challenges.bind_host = "127.0.0.1";
  assert.ok(!JSON.stringify(config).includes("letsencrypt"));
  const client = await start("client", config);
  const probe = () =>
    probeManagedHttps({
      publicUrl: "https://127.0.0.1",
      instanceId: "acme-test",
      request: (options, callback) =>
        https.request({ ...options, ca: caRoot }, callback),
    });
  const first = await waitFor(probe);
  assert.match(client.log, /tls-alpn-01/);
  assert.ok(Date.parse(first.validTo) - Date.now() < 10 * 60000);
  const renewed = await waitFor(async () => {
    const result = await probe();
    assert.notEqual(result.fingerprint256, first.fingerprint256);
    return result;
  }, 60000);
  assert.ok(Date.parse(renewed.validTo) >= Date.parse(first.validTo));
  assert.match(client.log, /renewed successfully|renewing certificate/);
  console.log(
    "Caddy local ACME smoke passed: TLS-ALPN IP issuance, trusted verification, and automatic renewal; no public CA or system trust changes.",
  );
} finally {
  const cleanupFailures = [];
  for (const entry of processes.reverse()) {
    let timeout;
    try {
      entry.child.stdin.end();
      await Promise.race([
        entry.exited,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Caddy guardian shutdown timed out")),
            8000,
          );
          timeout.unref();
        }),
      ]);
    } catch (cause) {
      // Still stop the other guardian and the upstream if one cleanup fails.
      cleanupFailures.push(cause);
    } finally {
      clearTimeout(timeout);
    }
  }
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("mc-caddy-acme-"));
  // Do not remove files that a guardian which timed out may still be using.
  if (cleanupFailures.length)
    throw new AggregateError(
      cleanupFailures,
      "Local ACME fixture cleanup failed.",
    );
  await fs.rm(root, { recursive: true, force: true });
}
