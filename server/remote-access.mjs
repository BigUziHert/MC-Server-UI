import express from "express";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";
import { createAccessRateLimiter } from "./access.mjs";
import {
  createRemoteTls,
  addressHost,
  localNetworkAddresses,
} from "./remote-tls.mjs";
import catalog from "../shared/subuser-permissions.json" with { type: "json" };

// Only the authenticated gateway can attach this marker. HTTP headers cannot
// turn a remote request into a local administrator request.
export const remotePrincipal = Symbol("remotePrincipal");
export const requestActor = new AsyncLocalStorage();
const failure = (status, message) =>
  Object.assign(new Error(message), { status });
const read = (req) => ["GET", "HEAD"].includes(req.method);

export function requiredPermissions(req) {
  const route = req.path;
  const contentChanges = [
    "file.create",
    "file.update",
    "file.delete",
    "control.start",
    "control.stop",
  ];
  if (read(req)) {
    if (["/api/server", "/api/server/icon"].includes(route)) return [];
    if (route === "/api/console") return ["control.console"];
    if (route === "/api/players") return [];
    if (
      route === "/api/versions" ||
      /^\/api\/versions\/[^/]+(?:\/[^/]+)?$/.test(route) ||
      [
        "/api/launchpad",
        "/api/launchpad/search",
        "/api/launchpad/versions",
        "/api/launchpad/installed",
      ].includes(route) ||
      /^\/api\/launchpad\/jobs\/[^/]+$/.test(route)
    )
      return ["file.read"];
    if (
      ["/api/minecraft/properties", "/api/minecraft/properties/file"].includes(
        route,
      )
    )
      return ["file.read-content"];
    if (route === "/api/files") return ["file.read"];
    if (["/api/files/content", "/api/files/download"].includes(route))
      return ["file.read-content"];
    // Recycle Bin contains both server files and backup archives.
    if (
      route === "/api/files/recycle-bin" ||
      /^\/api\/files\/recycle-bin\/[^/]+\/restore-preview$/.test(route)
    )
      return ["file.read", "backup.read"];
    if (route === "/api/backups") return ["backup.read"];
    if (/^\/api\/backups\/[^/]+\/download$/.test(route))
      return ["backup.download"];
    if (route === "/api/subusers") return ["user.read"];
    if (route === "/api/audit" && req.query.scope !== "panel")
      return ["audit.read"];
  }
  if (req.method === "POST") {
    if (
      /^\/api\/players\/(?:op|deop|kick|ban|unban)$/.test(route) ||
      /^\/api\/players\/whitelist\/(?:add|remove|state)$/.test(route)
    )
      return ["control.console"];
    if (route === "/api/minecraft/properties/save") return ["file.update"];
    if (
      [
        "/api/versions/install",
        "/api/launchpad/preview",
        "/api/launchpad/updates/preview",
        "/api/launchpad/removal-preview",
        "/api/launchpad/remove",
        "/api/launchpad/install",
      ].includes(route) ||
      /^\/api\/launchpad\/(?:preview|removal-preview)\/[^/]+\/cancel$/.test(
        route,
      )
    )
      return contentChanges;
    if (/^\/api\/(?:versions|launchpad)\/jobs\/[^/]+\/dismiss$/.test(route))
      return ["file.update"];
    if (route === "/api/server/power") {
      const action = req.body?.action;
      if (!["start", "stop", "restart", "force-stop"].includes(action))
        throw failure(400, "Choose a valid server power action.");
      return [`control.${action === "force-stop" ? "stop" : action}`];
    }
    if (route === "/api/console/command") {
      const command =
        typeof req.body?.command === "string"
          ? req.body.command.trim().replace(/^\//, "")
          : "";
      return /^stop(?:\s|$)/i.test(command)
        ? ["control.console", "control.stop"]
        : ["control.console"];
    }
    if (["/api/files", "/api/files/upload"].includes(route))
      return ["file.create"];
    if (/^\/api\/files\/recycle-bin\/[^/]+\/restore$/.test(route))
      return ["file.create", "backup.create"];
    if (route === "/api/backups") return ["backup.create"];
    if (
      route === "/api/subusers" ||
      /^\/api\/subusers\/[^/]+\/invite$/.test(route)
    )
      return ["user.create"];
  }
  if (req.method === "PUT") {
    if (route === "/api/files/content") return ["file.update"];
    if (route === "/api/backups/schedule") return ["backup.update"];
  }
  if (req.method === "PATCH" && /^\/api\/subusers\/[^/]+$/.test(route))
    return ["user.update"];
  if (req.method === "DELETE") {
    if (route === "/api/files") return ["file.delete"];
    if (/^\/api\/files\/recycle-bin\/[^/]+$/.test(route))
      return ["file.delete", "backup.delete"];
    if (/^\/api\/backups\/[^/]+$/.test(route)) return ["backup.delete"];
    if (/^\/api\/subusers\/[^/]+$/.test(route)) return ["user.delete"];
  }
  // New routes are owner-only until deliberately assigned a permission here.
  throw failure(403, "This action is available only to the panel owner.");
}

function preventEscalation(req, runtime, permissions) {
  if (!req.path.startsWith("/api/subusers") || read(req)) return;
  let targetId;
  try {
    targetId = decodeURIComponent(req.path.split("/")[3] ?? "");
  } catch {
    throw failure(400, "Invalid subuser identifier.");
  }
  const target = targetId
    ? runtime.subusers().find((user) => user.id === targetId)
    : null;
  const requested =
    req.body?.permissions ??
    (req.method === "POST" && !targetId
      ? (catalog.roleDefaults[req.body?.role] ?? [])
      : []);
  if (
    target?.permissions.some((id) => !permissions.includes(id)) ||
    (Array.isArray(requested) &&
      requested.some((id) => !permissions.includes(id)))
  )
    throw failure(
      403,
      "You can only manage users and grant permissions within your own access.",
    );
}

export function createRemoteGateway({
  access,
  runtimes,
  distDir,
  accepted,
  localAddresses = localNetworkAddresses,
}) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
    });
    const settings = access.status();
    if (!settings.enabled)
      return next(
        failure(503, "Remote access is disabled. Contact the panel owner."),
      );
    const origin = new URL(settings.publicUrl).origin;
    if (settings.transport === "direct" && !req.socket.encrypted)
      return next(failure(400, "Use HTTPS to connect to this panel."));
    let host;
    try {
      host = new URL(`https://${req.headers.host}`).host;
    } catch {
      /* invalid */
    }
    const allowedHosts = [
      new URL(origin).host,
      `127.0.0.1:${settings.port}`,
      `localhost:${settings.port}`,
      `[::1]:${settings.port}`,
      ...(settings.transport === "direct"
        ? localAddresses().map(
            (address) =>
              new URL(`https://${addressHost(address)}:${settings.port}`).host,
          )
        : []),
    ];
    if (!allowedHosts.includes(host))
      return next(
        failure(403, "This address is not configured for remote access."),
      );
    if (
      !read(req) &&
      (req.headers.origin !==
        (settings.transport === "direct" ? `https://${host}` : origin) ||
        req.headers["sec-fetch-site"] === "cross-site")
    )
      return next(
        failure(
          403,
          "Open the invitation at the configured panel address and try again.",
        ),
      );
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  const loginLimit = createAccessRateLimiter({ limit: 8 });
  const acceptLimit = createAccessRateLimiter({ limit: 30 });
  app.get("/api/access/session", async (req, res) => {
    res.json((await access.authenticate(req)) ?? { role: "guest" });
  });
  app.post("/api/access/login", loginLimit, async (req, res) => {
    const result = await access.login(req.body ?? {});
    res.setHeader("Set-Cookie", result.cookie);
    res.json(result.session);
  });
  app.post("/api/access/accept", acceptLimit, async (req, res) => {
    const result = await access.accept(req.body?.token, req.body?.password);
    await accepted?.(result.session);
    res.setHeader("Set-Cookie", result.cookie);
    res.json(result.session);
  });
  app.post("/api/access/logout", async (req, res) => {
    res.setHeader("Set-Cookie", await access.logout(req));
    res.json({ ok: true });
  });
  app.use(async (req, res, next) => {
    if (!/^\/api(?:\/|$)/i.test(req.path)) return next();
    const session = await access.authenticate(req);
    if (!session)
      throw failure(401, "Sign in with your email address and password.");
    const authorized = session.memberships ?? [
      { serverId: session.serverId, userId: session.userId },
    ];
    const memberships = [...runtimes].flatMap(([serverId, runtime]) =>
      (runtime.subusers?.() ?? [])
        .filter(
          (user) =>
            user.email === session.email &&
            authorized.some(
              (member) =>
                member.serverId === serverId && member.userId === user.id,
            ) &&
            access.membershipAllowed(serverId, user.id, user.email),
        )
        .map((user) => ({ serverId, user, runtime })),
    );
    if (req.path === "/api/servers" && read(req)) {
      const servers = memberships.map(({ serverId, user, runtime }) => {
        const d = runtime.descriptor();
        return {
          id: serverId,
          name: d.name,
          status: d.status,
          address: d.address,
          software: d.software,
          version: d.version,
          iconVersion: d.iconVersion,
          accessPermissions: user.permissions,
        };
      });
      return res.json({
        servers,
        defaultServerId: servers.some((s) => s.id === session.serverId)
          ? session.serverId
          : (servers[0]?.id ?? null),
      });
    }
    const header = req.headers["x-server-id"],
      query = req.query.serverId;
    if (header !== undefined && query !== undefined && header !== query)
      throw failure(400, "Conflicting server selectors.");
    const id = header ?? query ?? session.serverId;
    const membership = memberships.find((m) => m.serverId === id);
    if (!membership)
      throw failure(403, "You do not have access to this server.");
    const required = requiredPermissions(req);
    if (
      required.some(
        (permission) => !membership.user.permissions.includes(permission),
      )
    )
      throw failure(403, "You do not have permission to perform this action.");
    preventEscalation(req, membership.runtime, membership.user.permissions);
    req[remotePrincipal] = {
      ...session,
      serverId: id,
      permissions: membership.user.permissions,
    };
    requestActor.run(session.email, () =>
      membership.runtime.app(req, res, next),
    );
  });
  app.use(express.static(distDir));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(distDir, "index.html")),
  );
  app.use((cause, _req, res, _next) => {
    if (res.headersSent) return;
    const status = cause.status ?? 500;
    res.status(status).json({
      error:
        status >= 500 && status !== 503
          ? "Remote access could not complete the request. Try again or contact the panel owner."
          : cause.message,
    });
  });
  return app;
}

export function createRemoteListener({
  app,
  access,
  dataDir,
  listen = true,
  localAddresses = localNetworkAddresses,
  bindHost,
  createServer = (settings, tlsOptions, handler) =>
    settings.transport === "direct"
      ? https.createServer({ ...tlsOptions, minVersion: "TLSv1.2" }, handler)
      : http.createServer(handler),
}) {
  let listener;
  let listenerPort;
  let listenerTransport;
  let certificate;
  let listenerError = "";
  let chain = Promise.resolve();
  let closed = false;
  const tls = dataDir ? createRemoteTls({ dataDir, localAddresses }) : null;
  const stop = async (current) => {
    if (!current) return;
    current.closeAllConnections();
    await new Promise((resolve) => current.close(resolve));
  };
  const sync = async () => {
    const settings = access.status();
    if (closed || !settings.enabled) {
      await stop(listener);
      listener = undefined;
      return;
    }
    if (!listen) return;
    const tlsOptions =
      settings.transport === "direct"
        ? await tls.ensure(settings.publicUrl)
        : undefined;
    if (closed) return;
    if (
      listener &&
      listenerPort === settings.port &&
      listenerTransport === settings.transport
    ) {
      if (
        tlsOptions &&
        certificate?.fingerprint256 !== tlsOptions.certificate.fingerprint256
      )
        listener.setSecureContext({
          key: tlsOptions.key,
          cert: tlsOptions.cert,
          minVersion: "TLSv1.2",
        });
      certificate = tlsOptions?.certificate;
      return;
    }
    // A transport change on the same port must release the previous socket.
    if (listener && listenerPort === settings.port) {
      await stop(listener);
      listener = undefined;
    }
    const next = await new Promise((resolve, reject) => {
      const candidate = createServer(settings, tlsOptions, app);
      candidate.once("error", reject);
      // Node uses the available IPv6/IPv4 wildcard in direct mode; a proxy's
      // unencrypted upstream is accessible only on this computer.
      candidate.listen(
        settings.port,
        bindHost ?? (settings.transport === "proxy" ? "127.0.0.1" : undefined),
        () => resolve(candidate),
      );
    });
    const previous = listener;
    listener = next;
    listenerPort = settings.port;
    listenerTransport = settings.transport;
    certificate = tlsOptions?.certificate;
    await stop(previous);
  };
  const status = () => ({
    ...access.status(),
    ready: access.status().ready && !listenerError,
    listening: !!listener,
    ...(access.status().transport === "direct" && certificate
      ? { certificate }
      : {}),
    ...(listenerError ? { error: listenerError } : {}),
  });
  const failed = async (cause) => {
    listenerError = ["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"].includes(
      cause.code,
    )
      ? "The remote port is unavailable. Choose another port and save remote access settings."
      : "Remote HTTPS could not start. Check that the panel can write its data folder and that remote-tls.json contains a valid certificate and private key.";
    await access.configure({ enabled: false });
    await stop(listener);
    listener = undefined;
  };
  return {
    status,
    async start() {
      try {
        await sync();
      } catch (cause) {
        await failed(cause);
      }
    },
    configure(input) {
      const operation = chain
        .catch(() => {})
        .then(async () => {
          if (closed) throw failure(503, "The panel is shutting down.");
          await access.configure(input);
          try {
            await sync();
            listenerError = "";
          } catch (cause) {
            await failed(cause);
            throw failure(409, listenerError);
          }
          return status();
        });
      chain = operation;
      return operation;
    },
    async close() {
      closed = true;
      await chain.catch(() => {});
      await stop(listener);
      listener = undefined;
    },
  };
}
