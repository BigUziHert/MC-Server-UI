import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { createFleet } from "../server/index.mjs";
import { createDesktopSelection, readSelectionBody } from "./selection.mjs";

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
  let url;
  let host;
  let closing;
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
    close({ gracefulOnly = false } = {}) {
      if (!closing) {
        closing = (async () => {
          const httpClosed = new Promise((resolve, reject) =>
            listener.close((cause) => (cause ? reject(cause) : resolve())),
          );
          // The fleet sends stop to its managed Java processes and waits for their exit.
          // Stop accepting HTTP first, but keep current responses alive during that shutdown.
          try {
            await selection.close();
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
