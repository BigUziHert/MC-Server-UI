import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runManagedHttpsChild } from "./managed-https-child.mjs";
import {
  createCaddyConfig,
  createManagedHttps,
  probeManagedHttps,
} from "./managed-https.mjs";

const settings = {
  enabled: true,
  publicUrl: "https://203.0.113.27",
  upstreamPort: 3002,
};
const certificate = () => ({
  validTo: new Date(Date.now() + 3600000).toISOString(),
  fingerprint256: "test-fingerprint",
});
async function waitFor(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (check()) return;
    await delay(5);
  }
  assert.ok(check(), "Expected state was not reached.");
}
function childProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killCalls = [];
  child.stdin = new EventEmitter();
  child.stdin.end = () => {
    child.killCalls.push("stdin-end");
    child.exitCode = 0;
    child.emit("exit", 0);
  };
  child.stdin.destroy = child.stdin.end;
  child.kill = (signal) => {
    child.killCalls.push(signal);
    child.exitCode = 0;
    child.emit("exit", 0);
    return true;
  };
  return child;
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-managed-https-"));
  const calls = [];
  const service = createManagedHttps({
    dataDir: root,
    executablePath: path.join(root, "caddy.exe"),
    spawn: (...args) => {
      const child = childProcess();
      calls.push({ args, child });
      return child;
    },
    probe: async () => certificate(),
    pollIntervalMs: 20,
    restartDelayMs: 30,
    stopTimeoutMs: 10,
    ...options,
  });
  t.after(async () => {
    await service.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-managed-https-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, calls, service };
}

test("managed Caddy uses explicit public ACME IP profiles and only TCP HTTPS to the remote gateway", () => {
  for (const publicUrl of [
    settings.publicUrl,
    "https://[2001:db8::27]",
    "https://panel.example.com",
  ]) {
    const config = createCaddyConfig({
      ...settings,
      publicUrl,
      storageDir: "private-storage",
      instanceId: "identity",
    });
    const host = new URL(publicUrl).hostname.replace(/^\[|\]$/g, "");
    assert.deepEqual(config.admin, {
      disabled: true,
      config: { persist: false },
    });
    assert.deepEqual(config.storage, {
      module: "file_system",
      root: "private-storage",
    });
    const tls = config.apps.tls;
    assert.deepEqual(tls.certificates.automate, [host]);
    assert.deepEqual(tls.automation.policies[0].subjects, [host]);
    const [issuer] = tls.automation.policies[0].issuers;
    assert.equal(issuer.module, "acme");
    assert.equal(issuer.ca, "https://acme-v02.api.letsencrypt.org/directory");
    assert.equal(
      issuer.profile,
      host.includes("example.com") ? undefined : "shortlived",
    );
    assert.deepEqual(issuer.challenges, { http: { disabled: true } });
    const server = config.apps.http.servers.panel;
    assert.deepEqual(server.listen, [":443"]);
    assert.deepEqual(server.protocols, ["h1", "h2"]);
    assert.deepEqual(server.automatic_https, { disable_redirects: true });
    assert.deepEqual(server.tls_connection_policies, [{ default_sni: host }]);
    assert.deepEqual(server.routes[0].match, [{ host: [host] }]);
    assert.equal(
      server.routes[0].handle[0].upstreams[0].dial,
      "127.0.0.1:3002",
    );
    assert.equal(
      server.routes[0].handle[0].headers.request,
      undefined,
      "Original public Host is preserved.",
    );
    assert.equal(server.routes[1].handle[0].status_code, 421);
    assert.equal(
      server.logs,
      undefined,
      "No access logs can store invitation links or passwords.",
    );
  }
});

test("managed HTTPS rejects unsafe origins and upstreams before touching the process", async (t) => {
  const { service, calls, root } = await fixture(t);
  for (const publicUrl of [
    "http://panel.example.com",
    "https://panel.example.com:3002",
    "https://user:password@panel.example.com",
    "https://panel.example.com/path",
    "https://panel.example.com?q=a",
    "https://panel.example.com/#secret",
  ]) {
    await assert.rejects(service.configure({ ...settings, publicUrl }));
  }
  for (const upstreamPort of [0, 443, 65536, "3002", 3.5])
    await assert.rejects(service.configure({ ...settings, upstreamPort }));
  assert.equal(calls.length, 0);
  assert.deepEqual(await fs.readdir(root), []);
});

test("process startup never reports readiness before trusted verification and does not restart on identical settings", async (t) => {
  let finish;
  const { service, calls, root } = await fixture(t, {
    probe: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await service.configure(settings);
  assert.equal(service.status().ready, false);
  assert.equal(service.status().state, "provisioning");
  await waitFor(() => finish);
  const [call] = calls;
  assert.equal(call.args[0], process.execPath);
  assert.equal(
    call.args[1][0],
    fileURLToPath(new URL("./managed-https-child.mjs", import.meta.url)),
  );
  assert.equal(call.args[1][1], path.join(root, "caddy.exe"));
  assert.equal(call.args[2].shell, false);
  assert.equal(call.args[2].windowsHide, true);
  assert.deepEqual(call.args[2].stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(call.args[2].env.ELECTRON_RUN_AS_NODE, "1");
  const config = JSON.parse(await fs.readFile(call.args[1][2], "utf8"));
  assert.ok(config.storage.root.startsWith(path.join(root, "managed-https")));
  finish(certificate());
  await waitFor(() => service.status().ready);
  await service.configure(settings);
  assert.equal(calls.length, 1);
  assert.equal(service.status().ready, true);
});

test("cancel and public-address switches abort probes and cannot publish stale readiness", async (t) => {
  const pending = [];
  const { service, calls } = await fixture(t, {
    probe: (params) =>
      new Promise((resolve) => pending.push({ ...params, resolve })),
  });
  await service.configure(settings);
  await waitFor(() => pending.length === 1);
  await service.configure({ ...settings, publicUrl: "https://203.0.113.28" });
  assert.equal(pending[0].signal.aborted, true);
  assert.deepEqual(calls[0].child.killCalls, ["stdin-end"]);
  pending[0].resolve(certificate());
  await waitFor(() => pending.length === 2);
  assert.equal(service.status().ready, false);
  assert.equal(service.status().publicUrl, "https://203.0.113.28");
  assert.notEqual(
    calls[0].args[1][2],
    calls[1].args[1][2],
    "Hosts use independent certificate storage.",
  );
  await service.configure({ enabled: false });
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve(certificate());
  await delay(30);
  assert.equal(service.status().state, "disabled");
  assert.equal(service.status().ready, false);
  assert.equal(calls.length, 2);
});

test("expired certificates and failed probes withdraw readiness and recover after renewal", async (t) => {
  let result = certificate();
  const { service } = await fixture(t, {
    probe: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  });
  await service.configure(settings);
  await waitFor(() => service.status().ready);
  result = Object.assign(new Error("sensitive downstream error"), {
    code: "ECONNREFUSED",
  });
  await waitFor(() => !service.status().ready);
  assert.equal(service.status().state, "error");
  assert.equal(JSON.stringify(service.status()).includes("sensitive"), false);
  result = { validTo: new Date(Date.now() - 1000).toISOString() };
  await waitFor(() => service.status().message.includes("expired"));
  assert.equal(service.status().certificate, undefined);
  result = certificate();
  await waitFor(() => service.status().ready);
});

test("status stops claiming readiness immediately when a previously verified certificate expires", async (t) => {
  let clock = Date.now();
  const { service } = await fixture(t, { now: () => clock });
  await service.configure(settings);
  await waitFor(() => service.status().ready);
  clock += 2 * 3600000;
  assert.equal(service.status().ready, false);
  assert.match(service.status().message, /expired/);
});

test("process exit retries with bounded diagnostics and disabling cancels the restart", async (t) => {
  const { service, calls } = await fixture(t);
  await service.configure(settings);
  await waitFor(() => service.status().ready);
  calls[0].child.stderr.emit(
    "data",
    Buffer.from(
      '{"error":"listen tcp :443: bind: address already in use","request":"token=secret"}',
    ),
  );
  calls[0].child.exitCode = 1;
  calls[0].child.emit("exit", 1);
  assert.equal(service.status().ready, false);
  assert.match(service.status().message, /443 is already in use/);
  assert.equal(JSON.stringify(service.status()).includes("secret"), false);
  assert.ok(service.status().retryAt);
  await waitFor(() => calls.length === 2);
  await waitFor(() => service.status().ready);
  calls[1].child.exitCode = 1;
  calls[1].child.emit("exit", 1);
  await service.configure({ enabled: false });
  await delay(60);
  assert.equal(calls.length, 2);
  assert.equal(service.status().state, "disabled");
});

test("missing executable is recoverable and never saves ready state", async (t) => {
  let fail = true;
  const { service } = await fixture(t, {
    spawn: () => {
      if (fail)
        throw Object.assign(new Error("private path"), { code: "ENOENT" });
      return childProcess();
    },
  });
  await service.configure(settings);
  assert.equal(service.status().state, "error");
  assert.equal(service.status().ready, false);
  assert.match(service.status().message, /component is missing/);
  assert.equal(service.status().message.includes("private path"), false);
  fail = false;
  await service.configure(settings);
  await waitFor(() => service.status().ready);
});

test("shutdown terminates its own HTTPS process and rejects future configure calls", async (t) => {
  const { service, calls } = await fixture(t);
  await service.configure(settings);
  await service.close();
  assert.deepEqual(calls[0].child.killCalls, ["stdin-end"]);
  assert.equal(service.status().state, "disabled");
  await assert.rejects(service.configure(settings), /closed/);
  await delay(40);
  assert.equal(calls.length, 1);
});

test("disabling can retry a failed shutdown without starting a replacement listener", async (t) => {
  const { service, calls } = await fixture(t);
  await service.configure(settings);
  const child = calls[0].child;
  const end = child.stdin.end;
  child.stdin.end = () => {
    throw new Error("pipe failure");
  };
  await service.configure({ enabled: false });
  assert.equal(service.status().state, "error");
  assert.equal(service.status().ready, false);
  child.stdin.end = end;
  await service.configure({ enabled: false });
  assert.equal(service.status().state, "disabled");
  assert.deepEqual(child.killCalls, ["stdin-end"]);
  assert.equal(calls.length, 1);
});

function requestFixture({
  role = "guest",
  identity = "instance",
  authorized = true,
  code = 200,
  hostname = "203.0.113.27",
} = {}) {
  let options;
  const request = (value, callback) => {
    options = value;
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () =>
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.socket = {
          authorized,
          getPeerCertificate: () => ({
            subject: { CN: hostname },
            subjectaltname: hostname.includes("example.com")
              ? `DNS:${hostname}`
              : `IP Address:${hostname}`,
            valid_to: new Date(Date.now() + 3600000).toUTCString(),
            fingerprint256: "test",
          }),
        };
        response.statusCode = code;
        response.headers = { "x-mc-panel-https": identity };
        response.setEncoding = () => {};
        callback(response);
        response.emit("data", JSON.stringify({ role }));
        response.emit("end");
      });
    return req;
  };
  return { request, options: () => options };
}

test("readiness checks public certificate identity over loopback with no credentials and no IP SNI", async () => {
  for (const hostname of ["203.0.113.27", "panel.example.com"]) {
    const fake = requestFixture({ hostname });
    const result = await probeManagedHttps({
      publicUrl: `https://${hostname}`,
      instanceId: "instance",
      request: fake.request,
    });
    assert.ok(result.validTo);
    const options = fake.options();
    assert.equal(options.hostname, "127.0.0.1");
    assert.equal(options.port, 443);
    assert.equal(
      options.servername,
      hostname.includes("example.com") ? hostname : "",
    );
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.headers.Host, hostname);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.path, "/api/access/session");
    const wrongIdentity = options.checkServerIdentity("ignored", {
      subjectaltname: "DNS:wrong.example.com",
      subject: { CN: "wrong.example.com" },
    });
    assert.equal(wrongIdentity.code, "ERR_TLS_CERT_ALTNAME_INVALID");
  }
});

test("readiness rejects untrusted certificates, wrong identity, owner responses and other listeners", async () => {
  for (const options of [
    { authorized: false },
    { identity: "other-instance" },
    { role: "owner" },
    { hostname: "wrong.example.com" },
    { code: 503 },
  ]) {
    const fake = requestFixture(options);
    await assert.rejects(
      probeManagedHttps({
        publicUrl: settings.publicUrl,
        instanceId: "instance",
        request: fake.request,
      }),
    );
  }
});

test("guardian stops Caddy on parent EOF and escalates a hung child before exiting", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const signals = new EventEmitter();
  const child = childProcess();
  child.pid = 1234;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    child.killCalls.push(signal);
    if (signal === "SIGKILL") child.emit("exit", 1);
    return true;
  };
  const complete = runManagedHttpsChild({
    executablePath: "caddy.exe",
    configFile: "private-config.json",
    input,
    output,
    signals,
    graceMs: 10,
    spawn: (exe, args, options) => {
      assert.equal(exe, "caddy.exe");
      assert.deepEqual(args, ["run", "--config", "private-config.json"]);
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, false);
      return child;
    },
  });
  input.end();
  assert.equal(await complete, 0);
  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("exit"), 0);
});

test("a separate guardian reaps its real subprocess when its parent pipe disappears", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-managed-guardian-"));
  const runner = path.join(root, "guardian.mjs");
  const marker = path.join(root, "child-pid");
  const guardianUrl = new URL("./managed-https-child.mjs", import.meta.url)
    .href;
  await fs.writeFile(
    runner,
    `import { runManagedHttpsChild } from ${JSON.stringify(guardianUrl)};\nimport { spawn } from 'node:child_process';\nprocess.exitCode = await runManagedHttpsChild({ executablePath: process.execPath, configFile: 'unused', graceMs: 20, spawn: () => spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`)}], {stdio:['ignore','pipe','pipe'], windowsHide:true}) });\n`,
  );
  const guardian = spawn(process.execPath, [runner], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  guardian.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    guardian.once("exit", resolve);
    guardian.once("error", reject);
  });
  let pid;
  t.after(async () => {
    guardian.stdin.destroy();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await exited;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-managed-guardian-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      pid = Number(await fs.readFile(marker, "utf8"));
      break;
    } catch {}
    await delay(10);
  }
  assert.ok(pid, `The guardian child should start: ${stderr}`);
  process.kill(pid, 0);
  guardian.stdin.destroy();
  assert.equal(await exited, 0, stderr);
  assert.throws(() => process.kill(pid, 0), /ESRCH|not found|no such process/i);
});
