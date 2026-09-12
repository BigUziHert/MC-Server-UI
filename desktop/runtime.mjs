import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { createFleet } from "../server/index.mjs";

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
    scheduler,
    spawnServer,
    backupFlushTimeoutMs,
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
    close() {
      if (!closing) {
        closing = (async () => {
          const httpClosed = new Promise((resolve, reject) =>
            listener.close((cause) => (cause ? reject(cause) : resolve())),
          );
          // The fleet sends stop to its managed Java processes and waits for their exit.
          // Stop accepting HTTP first, but keep current responses alive during that shutdown.
          try {
            await fleet.close();
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
