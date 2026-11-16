import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import https from "node:https";
import { checkServerIdentity } from "node:tls";

const issuanceMessage =
  "Waiting for a trusted certificate. Forward TCP port 443 to this computer and allow MC Panel HTTPS through the firewall. Your public address must point here. MC Panel retries automatically.";
const error = (message, code) => Object.assign(new Error(message), { code });
const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, "");

function configuration(value) {
  if (!value?.enabled) return null;
  const url = new URL(value.publicUrl);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !Number.isInteger(value.upstreamPort) ||
    value.upstreamPort < 1 ||
    value.upstreamPort > 65535 ||
    value.upstreamPort === 443
  )
    throw new Error(
      "Managed HTTPS needs an HTTPS address on port 443 and a separate local service port.",
    );
  return { publicUrl: url.origin, upstreamPort: value.upstreamPort };
}

// Explicit ACME automation is essential for IP certificates: automatic HTTPS
// otherwise treats IP subjects as candidates for Caddy's local certificate CA.
// Do not enable the admin endpoint, on-demand issuance, HTTP port 80, or access
// logging (invitation tokens and credentials must never enter Caddy log files).
export function createCaddyConfig({
  publicUrl,
  upstreamPort,
  storageDir,
  instanceId,
}) {
  const settings = configuration({ enabled: true, publicUrl, upstreamPort });
  const hostname = hostOf(new URL(settings.publicUrl));
  const issuer = {
    module: "acme",
    ca: "https://acme-v02.api.letsencrypt.org/directory",
    ...(isIP(hostname) ? { profile: "shortlived" } : {}),
    challenges: { http: { disabled: true } },
  };
  return {
    admin: { disabled: true, config: { persist: false } },
    storage: { module: "file_system", root: storageDir },
    logging: {
      logs: { default: { level: "WARN", writer: { output: "stderr" } } },
    },
    apps: {
      tls: {
        certificates: { automate: [hostname] },
        automation: { policies: [{ subjects: [hostname], issuers: [issuer] }] },
      },
      http: {
        servers: {
          panel: {
            listen: [":443"],
            protocols: ["h1", "h2"],
            automatic_https: { disable_redirects: true },
            tls_connection_policies: [{ default_sni: hostname }],
            routes: [
              {
                match: [{ host: [hostname] }],
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: `127.0.0.1:${settings.upstreamPort}` }],
                    ...(instanceId
                      ? {
                          headers: {
                            response: {
                              set: { "X-MC-Panel-HTTPS": [instanceId] },
                            },
                          },
                        }
                      : {}),
                  },
                ],
                terminal: true,
              },
              { handle: [{ handler: "static_response", status_code: 421 }] },
            ],
          },
        },
      },
    },
  };
}

// The connection stays on loopback, but chain trust AND identity are checked
// against the configured public address. IP clients omit SNI; Caddy's default
// SNI chooses the same public-IP certificate such clients will receive.
export function probeManagedHttps({
  publicUrl,
  instanceId,
  signal,
  timeoutMs = 5000,
  request = https.request,
}) {
  const url = new URL(publicUrl);
  const hostname = hostOf(url);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (cause, certificate) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      if (cause) reject(cause);
      else resolve(certificate);
    };
    const req = request(
      {
        protocol: "https:",
        hostname: "127.0.0.1",
        port: 443,
        servername: isIP(hostname) ? "" : hostname,
        path: "/api/access/session",
        method: "GET",
        headers: {
          Host: url.host,
          Accept: "application/json",
          Connection: "close",
        },
        agent: false,
        rejectUnauthorized: true,
        checkServerIdentity: (_name, certificate) =>
          checkServerIdentity(hostname, certificate),
        signal,
      },
      (response) => {
        const socket = response.socket;
        const peer = socket?.getPeerCertificate?.();
        if (
          !socket?.authorized ||
          !peer ||
          checkServerIdentity(hostname, peer)
        ) {
          finish(
            error(
              "The HTTPS certificate is not trusted for this address.",
              "CERT_INVALID",
            ),
          );
          return;
        }
        if (
          response.statusCode !== 200 ||
          response.headers["x-mc-panel-https"] !== instanceId
        ) {
          finish(
            error(
              "The HTTPS listener did not reach this panel.",
              "WRONG_PANEL",
            ),
          );
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 16384)
            finish(error("Invalid panel response.", "WRONG_PANEL"));
        });
        response.on("error", finish);
        response.on("end", () => {
          if (done) return;
          try {
            const session = JSON.parse(body);
            if (session.role !== "guest") throw new Error();
            const validTo = new Date(peer.valid_to).toISOString();
            if (Date.parse(validTo) <= Date.now()) throw new Error();
            finish(null, { validTo, fingerprint256: peer.fingerprint256 });
          } catch {
            finish(
              error(
                "The HTTPS listener did not reach the remote sign-in service.",
                "WRONG_PANEL",
              ),
            );
          }
        });
      },
    );
    const timer = setTimeout(
      () => finish(error("HTTPS verification timed out.", "ETIMEDOUT")),
      timeoutMs,
    );
    timer.unref?.();
    req.on("error", finish);
    req.end();
  });
}

function diagnostic(cause) {
  const text = String(
    cause?.code || cause?.message || cause || "",
  ).toLowerCase();
  if (/enoent/.test(text))
    return "The bundled HTTPS component is missing. Repair or update MC Panel, then retry.";
  if (/eacces|eperm|permission denied/.test(text))
    return "MC Panel could not start HTTPS. Check file permissions and security software, then retry.";
  if (
    /address already in use|eaddrinuse|only one usage|bind:.*forbidden/.test(
      text,
    )
  )
    return "TCP port 443 is already in use or unavailable. Stop the conflicting HTTPS service or use another remote-access option.";
  if (/rate.?limit|too many requests/.test(text))
    return "The certificate service has temporarily limited requests. MC Panel will retry automatically; keep this address unchanged.";
  if (/certificate.*expir|cert_has_expired/.test(text))
    return "The HTTPS certificate has expired. Check internet access and forwarding for TCP port 443. MC Panel is retrying renewal.";
  if (/wrong_panel/.test(text))
    return "Port 443 did not reach this panel's sign-in service. Check for another HTTPS service and retry.";
  return issuanceMessage;
}

export function createManagedHttps({
  dataDir,
  executablePath = process.resourcesPath &&
  fileURLToPath(import.meta.url)
    .split(path.sep)
    .includes("app.asar")
    ? path.join(
        process.resourcesPath,
        "caddy",
        process.platform === "win32" ? "caddy.exe" : "caddy",
      )
    : fileURLToPath(
        new URL(
          `../desktop/vendor/caddy/${process.platform === "win32" ? "caddy.exe" : "caddy"}`,
          import.meta.url,
        ),
      ),
  spawn = spawnProcess,
  probe = probeManagedHttps,
  pollIntervalMs = 5000,
  restartDelayMs = 30000,
  stopTimeoutMs = 8000,
  now = () => Date.now(),
  onStatus = () => {},
} = {}) {
  if (!dataDir)
    throw new Error("Managed HTTPS requires a private data directory.");
  let desired = null;
  let generation = 0;
  let child = null;
  let timer = null;
  let probeController = null;
  let queue = Promise.resolve();
  let closed = false;
  let current = {
    state: "disabled",
    ready: false,
    message: "Managed HTTPS is off.",
  };
  const status = () => {
    if (current.ready && Date.parse(current.certificate?.validTo) <= now())
      return {
        ...current,
        state: "error",
        ready: false,
        message: diagnostic("certificate expired"),
      };
    return structuredClone(current);
  };
  const publish = (value) => {
    current = {
      ...value,
      ...(desired ? { publicUrl: desired.publicUrl } : {}),
    };
    try {
      onStatus(status());
    } catch {
      /* Observers cannot stop certificate management. */
    }
  };
  const active = (epoch) => !closed && epoch === generation && desired;
  const cancelWork = () => {
    clearTimeout(timer);
    timer = null;
    probeController?.abort();
    probeController = null;
  };
  const enqueue = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const stop = async () => {
    const old = child;
    if (!old) return;
    child = null;
    await new Promise((resolve, reject) => {
      let finished = false;
      let timeout;
      const end = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        old.removeListener("exit", end);
        old.removeListener("close", end);
        resolve();
      };
      if (old.exitCode !== null && old.exitCode !== undefined) return end();
      old.once("exit", end);
      old.once("close", end);
      try {
        old.stdin.end();
      } catch {
        old.removeListener("exit", end);
        old.removeListener("close", end);
        child = old;
        reject(
          new Error(
            "The HTTPS process could not be stopped. Restart MC Panel before changing HTTPS settings.",
          ),
        );
        return;
      }
      if (finished) return;
      timeout = setTimeout(() => {
        // Never kill the guardian first: on Windows that could orphan Caddy.
        // The guardian performs forceful Caddy termination itself after grace.
        old.removeListener("exit", end);
        old.removeListener("close", end);
        child = old;
        reject(
          new Error(
            "The HTTPS process could not be stopped. Restart MC Panel before changing HTTPS settings.",
          ),
        );
      }, stopTimeoutMs);
    });
  };
  const scheduleProbe = (
    epoch,
    process,
    instanceId,
    delay = pollIntervalMs,
  ) => {
    if (!active(epoch) || child !== process) return;
    timer = setTimeout(async () => {
      if (!active(epoch) || child !== process) return;
      const controller = new AbortController();
      probeController = controller;
      try {
        const certificate = await probe({
          publicUrl: desired.publicUrl,
          instanceId,
          signal: controller.signal,
        });
        if (!active(epoch) || child !== process || controller.signal.aborted)
          return;
        if (
          !certificate?.validTo ||
          Date.parse(certificate.validTo) <= now() ||
          !Number.isFinite(Date.parse(certificate.validTo))
        )
          throw error("certificate expired", "CERT_HAS_EXPIRED");
        publish({
          state: "ready",
          ready: true,
          message: "Trusted HTTPS is ready. Certificates renew automatically.",
          certificate,
        });
      } catch (cause) {
        if (!active(epoch) || child !== process || controller.signal.aborted)
          return;
        publish({
          state:
            current.ready || current.state === "error"
              ? "error"
              : "provisioning",
          ready: false,
          message: diagnostic(cause),
        });
      } finally {
        if (probeController === controller) probeController = null;
        scheduleProbe(epoch, process, instanceId);
      }
    }, delay);
    timer.unref?.();
  };
  const start = async (epoch) => {
    if (!active(epoch)) return;
    const settings = { ...desired };
    const key = createHash("sha256")
      .update(settings.publicUrl)
      .digest("hex")
      .slice(0, 24);
    const root = path.join(dataDir, "managed-https", key);
    const storageDir = path.join(root, "storage");
    const configFile = path.join(root, "caddy.json");
    const instanceId = randomUUID();
    try {
      await fs.mkdir(path.join(dataDir, "managed-https"), {
        recursive: true,
        mode: 0o700,
      });
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.mkdir(storageDir, { recursive: true, mode: 0o700 });
      const temporary = `${configFile}.${instanceId}.tmp`;
      try {
        await fs.writeFile(
          temporary,
          JSON.stringify(
            createCaddyConfig({ ...settings, storageDir, instanceId }),
          ),
          { flag: "wx", mode: 0o600 },
        );
        if (!active(epoch)) return;
        await fs.rename(temporary, configFile);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      if (!active(epoch)) return;
      const process = spawn(
        globalThis.process.execPath,
        [
          fileURLToPath(new URL("./managed-https-child.mjs", import.meta.url)),
          executablePath,
          configFile,
        ],
        {
          cwd: root,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...globalThis.process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
      );
      child = process;
      process.stdin.on("error", () => {});
      let exited = false;
      let lastDiagnostic = "";
      const output = (chunk) => {
        // Never retain or return the raw subprocess log. It can contain request
        // URLs, certificate paths, CA account URLs, or operating-system details.
        const safe = diagnostic(String(chunk).slice(-8192));
        if (safe !== issuanceMessage) lastDiagnostic = safe;
        if (
          active(epoch) &&
          child === process &&
          !current.ready &&
          lastDiagnostic
        )
          publish({ state: "error", ready: false, message: lastDiagnostic });
      };
      process.stdout?.on("data", output);
      process.stderr?.on("data", output);
      const failed = (cause) => {
        if (exited) return;
        exited = true;
        if (!active(epoch) || child !== process) return;
        child = null;
        cancelWork();
        publish({
          state: "error",
          ready: false,
          message:
            lastDiagnostic ||
            diagnostic(cause) ||
            "HTTPS stopped. MC Panel will retry automatically.",
          retryAt: new Date(now() + restartDelayMs).toISOString(),
        });
        timer = setTimeout(() => {
          if (active(epoch)) void enqueue(() => start(epoch));
        }, restartDelayMs);
        timer.unref?.();
      };
      process.once("error", failed);
      process.once("exit", () => failed(new Error("HTTPS process exited")));
      publish({
        state: "provisioning",
        ready: false,
        message: issuanceMessage,
      });
      scheduleProbe(epoch, process, instanceId, 0);
    } catch (cause) {
      if (active(epoch))
        publish({ state: "error", ready: false, message: diagnostic(cause) });
    }
  };
  const killOnExit = () => {
    try {
      child?.stdin.destroy();
    } catch {
      /* Process is exiting. */
    }
  };
  process.once("exit", killOnExit);
  return {
    status,
    configure(value) {
      if (closed) return Promise.reject(new Error("Managed HTTPS is closed."));
      let next;
      try {
        next = configuration(value);
      } catch (cause) {
        return Promise.reject(cause);
      }
      if (
        JSON.stringify(next) === JSON.stringify(desired) &&
        (next ? child : !child)
      )
        return Promise.resolve(status());
      desired = next;
      const epoch = ++generation;
      cancelWork();
      publish(
        next
          ? {
              state: "starting",
              ready: false,
              message: "Starting trusted HTTPS…",
            }
          : {
              state: "disabled",
              ready: false,
              message: "Managed HTTPS is off.",
            },
      );
      return enqueue(async () => {
        try {
          await stop();
          if (active(epoch)) await start(epoch);
        } catch (cause) {
          if (epoch === generation)
            publish({ state: "error", ready: false, message: cause.message });
        }
        return status();
      });
    },
    async close() {
      if (closed) return queue;
      closed = true;
      desired = null;
      ++generation;
      cancelWork();
      process.removeListener("exit", killOnExit);
      publish({
        state: "disabled",
        ready: false,
        message: "Managed HTTPS is off.",
      });
      await enqueue(stop);
    },
  };
}
