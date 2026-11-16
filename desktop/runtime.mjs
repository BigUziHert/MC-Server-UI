import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { createFleet } from "../server/index.mjs";
import { createDesktopSelection, readSelectionBody } from "./selection.mjs";
import { readPanelConnectionBody } from "./remote-panels.mjs";
import {
  createPanelSettings,
  readPanelSettingsBody,
} from "./panel-settings.mjs";
import {
  createDesktopPreferences,
  readPreferenceBody,
} from "./preferences.mjs";

export const DESKTOP_COOKIE_NAME = "mc-panel-desktop";

function authenticated(cookieHeader, expectedToken) {
  if (typeof cookieHeader !== "string") return false;
  const tokens = cookieHeader.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (
      separator < 0 ||
      part.slice(0, separator).trim() !== DESKTOP_COOKIE_NAME
    )
      return [];
    return [part.slice(separator + 1).trim()];
  });
  if (tokens.length !== 1) return false;
  const supplied = Buffer.from(tokens[0], "utf8");
  return (
    supplied.length === expectedToken.length &&
    timingSafeEqual(supplied, expectedToken)
  );
}

/** Start one authenticated, loopback-only runtime for an Electron session. */
export async function startDesktopRuntime({
  dataDir,
  scheduler,
  spawnServer,
  backupFlushTimeoutMs,
  selectServerDirectory,
  updates,
  openRemotePanel,
  proxyRemotePanel,
  loginItem,
} = {}) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir))
    throw new Error(
      "Desktop runtime requires an explicit absolute data directory.",
    );
  const token = randomBytes(32).toString("hex");
  const expectedToken = Buffer.from(token, "utf8");
  const fleet = await createFleet({
    dataDir,
    useEnvironment: false,
    createDefaultServer: false,
    scheduler,
    spawnServer,
    backupFlushTimeoutMs,
    selectServerDirectory,
  });
  const selection = createDesktopSelection({
    dataDir: fleet.dataDir,
    hasServer: (id) => fleet.runtimes.has(id),
  });
  const preferences = createDesktopPreferences({ dataDir: fleet.dataDir });
  const panelSettings = createPanelSettings({
    dataDir: fleet.dataDir,
    hasServer: (id) => {
      const server = fleet.runtimes.get(id);
      return !!server && !server.descriptor().unavailable;
    },
    loginItem,
  });
  // A broken settings file must not stop the owner opening the panel to inspect
  // it. Read/save still report the failure instead of overwriting that file.
  await panelSettings.read().catch(() => {});
  let url;
  let host;
  let closing;
  let autoStart;
  const listener = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    const reject = (status, message) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ error: message }));
    };
    if (closing) return reject(503, "The desktop panel is closing.");
    if (
      req.headers.host !== host ||
      (req.headers.origin !== undefined && req.headers.origin !== url) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return reject(403, "This request is outside the desktop session.");
    if (!authenticated(req.headers.cookie, expectedToken))
      return reject(401, "An authenticated desktop session is required.");
    const requestPath = new URL(req.url, url).pathname;
    if (requestPath.startsWith("/api/desktop/panels/")) {
      // Keep this ahead of fleet.app and every body parser. The authenticated
      // owner connection streams uploads/downloads to one captured remote host.
      const match = /^\/api\/desktop\/panels\/([^/]+)\/proxy(\/api\/.*)$/.exec(
        req.url,
      );
      if (!match || !/^[a-f0-9-]{36}$/.test(match[1]))
        return reject(400, "Choose a saved panel and relative API path.");
      if (!proxyRemotePanel)
        return reject(503, "Remote connections are unavailable.");
      void Promise.resolve()
        .then(() => proxyRemotePanel(req, res, match[1], match[2]))
        .catch((cause) => {
          if (res.headersSent) res.destroy(cause);
          else
            reject(
              cause.status ?? 502,
              cause.status
                ? cause.message
                : "The remote request was interrupted. Check the original operation before retrying.",
            );
        });
      return;
    }
    if (requestPath === "/api/desktop/settings") {
      if (!["GET", "PUT"].includes(req.method))
        return reject(405, "Use GET to read or PUT to save panel settings.");
      void (async () => {
        const result =
          req.method === "GET"
            ? await panelSettings.read()
            : await panelSettings.save(await readPanelSettingsBody(req));
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(result));
      })().catch((cause) =>
        reject(
          cause.status ?? 500,
          cause.status && cause.status < 500
            ? cause.message
            : "Panel settings could not be saved or read.",
        ),
      );
      return;
    }
    if (requestPath === "/api/desktop/preferences") {
      if (!["GET", "PUT"].includes(req.method))
        return reject(
          405,
          "Use GET to read or PUT to save display preferences.",
        );
      void (async () => {
        if (req.method === "GET") {
          const result = await preferences.read();
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify(result));
        } else {
          const { key, value } = await readPreferenceBody(req);
          await preferences.save(key, value);
          res.writeHead(204);
          res.end();
        }
      })().catch((cause) =>
        reject(
          cause.status ?? 500,
          cause.status
            ? cause.message
            : "Display preferences could not be saved or read.",
        ),
      );
      return;
    }
    if (requestPath === "/api/desktop/connections/open") {
      if (req.method !== "POST")
        return reject(405, "Use POST to open a remote panel.");
      void (async () => {
        const target = await readPanelConnectionBody(req);
        if (!openRemotePanel)
          throw Object.assign(
            new Error("Remote panel connections require the desktop app."),
            { status: 409 },
          );
        if (closing)
          throw Object.assign(new Error("The desktop panel is closing."), {
            status: 503,
          });
        await openRemotePanel(target);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ opened: true, url: target }));
      })().catch((cause) =>
        reject(
          cause.status ?? 502,
          cause.status ? cause.message : "Could not open the remote panel.",
        ),
      );
      return;
    }
    if (requestPath === "/api/desktop/selection") {
      if (!["GET", "PUT"].includes(req.method))
        return reject(
          405,
          "Use GET to read or PUT to save the selected server.",
        );
      void (async () => {
        const result =
          req.method === "GET"
            ? await selection.read()
            : await selection.save(await readSelectionBody(req));
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(result));
      })().catch((cause) =>
        reject(
          cause.status ?? 500,
          cause.status
            ? cause.message
            : "The selected server could not be saved or read.",
        ),
      );
      return;
    }
    if (
      requestPath === "/api/desktop/updates" ||
      requestPath.startsWith("/api/desktop/updates/")
    ) {
      const action = requestPath.slice("/api/desktop/updates".length);
      if (
        (!action && req.method !== "GET") ||
        (action && req.method !== "POST")
      )
        return reject(
          405,
          "Use GET for update status and POST for update actions.",
        );
      if (!["", "/check", "/download", "/install"].includes(action))
        return reject(404, "Unknown update action.");
      const result = updates
        ? action
          ? updates[action.slice(1)]()
          : updates.snapshot()
        : {
            desktop: true,
            supported: false,
            version: "development",
            channel: "dev",
            status: "unsupported",
            message: "Updates are available in the installed Windows app.",
          };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(result));
    }
    fleet.app(req, res);
  });
  try {
    await new Promise((resolve, reject) => {
      const onError = (cause) => {
        listener.off("listening", onListening);
        reject(cause);
      };
      const onListening = () => {
        listener.off("error", onError);
        resolve();
      };
      listener.once("error", onError);
      listener.once("listening", onListening);
      listener.listen(0, "127.0.0.1");
    });
    host = `127.0.0.1:${listener.address().port}`;
    url = `http://${host}`;
  } catch (cause) {
    await fleet.close();
    throw cause;
  }

  return {
    url,
    token,
    fleet,
    panelSettings,
    startConfiguredServers({ skipAutoStart = false } = {}) {
      // One attempt per fresh runtime, even if a caller asks again while its
      // first attempt is pending. Tray activation never creates a new runtime.
      autoStart ??= (async () => {
        if (skipAutoStart || closing)
          return { skipped: true, startedServerIds: [], failures: [] };
        try {
          const settings = await panelSettings.read();
          const results = await Promise.all(
            settings.autoStartServerIds.map(async (serverId) => {
              const name =
                fleet.runtimes.get(serverId)?.descriptor().name || serverId;
              try {
                if (closing) throw new Error("The desktop panel is closing.");
                if (settings.missingAutoStartServerIds.includes(serverId))
                  throw new Error(
                    "This server is no longer available. Review its selection in Panel Settings.",
                  );
                // Use the normal power operation, retaining EULA, path,
                // installation, process ownership, backup, and audit checks.
                const response = await fetch(`${url}/api/server/power`, {
                  method: "POST",
                  headers: {
                    Cookie: `${DESKTOP_COOKIE_NAME}=${token}`,
                    "Content-Type": "application/json",
                    "X-Server-Id": serverId,
                  },
                  body: JSON.stringify({ action: "start" }),
                });
                if (!response.ok) {
                  const body = await response.json().catch(() => ({}));
                  throw new Error(body.error || "The server could not start.");
                }
                return { serverId, started: true };
              } catch (cause) {
                return {
                  serverId,
                  message: `${name}: ${cause.message || "The server could not start."}`,
                };
              }
            }),
          );
          const failures = results
            .filter((result) => !result.started)
            .map(({ serverId, message }) => ({ serverId, message }));
          panelSettings.setStartupError(
            failures.map((failure) => failure.message).join("\n"),
          );
          return {
            skipped: false,
            startedServerIds: results
              .filter((result) => result.started)
              .map((result) => result.serverId),
            failures,
          };
        } catch (cause) {
          panelSettings.setStartupError(
            cause.message ||
              "Automatic server startup could not read its settings.",
          );
          throw cause;
        }
      })();
      return autoStart;
    },
    listLocalServers() {
      return [...fleet.runtimes.values()].map((server) => {
        const { id, name, status, software, minecraftVersion } =
          server.descriptor();
        const iconDataUrl = server.iconDataUrl?.();
        return {
          id,
          name,
          status,
          ...(typeof software === "string" ? { software } : {}),
          ...(typeof minecraftVersion === "string" ? { minecraftVersion } : {}),
          ...(iconDataUrl ? { iconDataUrl } : {}),
        };
      });
    },
    listLocalServerRecords() {
      return [...fleet.runtimes.values()].map((server) => server.descriptor());
    },
    async selectLocalServer(id) {
      if (closing)
        throw Object.assign(new Error("The desktop panel is closing."), {
          status: 503,
        });
      if (typeof id !== "string" || !fleet.runtimes.has(id))
        throw Object.assign(
          new Error("Select a server that is still in the panel."),
          { status: 400 },
        );
      try {
        return await selection.save(id);
      } catch (cause) {
        if ([400, 503].includes(cause?.status)) throw cause;
        throw Object.assign(
          new Error("The local server selection could not be saved.", {
            cause,
          }),
          { status: 500 },
        );
      }
    },
    close({ gracefulOnly = false } = {}) {
      if (!closing) {
        closing = (async () => {
          const httpClosed = new Promise((resolve, reject) =>
            listener.close((cause) => (cause ? reject(cause) : resolve())),
          );
          // The fleet sends stop to its managed Java processes and waits for their exit.
          // Stop accepting HTTP first, but keep current responses alive during that shutdown.
          try {
            await Promise.all([
              selection.close(),
              preferences.close(),
              panelSettings.close(),
            ]);
            await fleet.close({ gracefulOnly });
          } finally {
            listener.closeAllConnections();
            await httpClosed;
          }
        })();
      }
      return closing;
    },
  };
}
