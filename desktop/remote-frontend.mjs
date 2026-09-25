import fs from "node:fs/promises";
import path from "node:path";

// Run before app.whenReady(). Certificate decisions depend on whether the
// connection is a quiet restore or an explicit retry. Chromium otherwise
// caches a rejected custom verdict and skips the user's later trust prompt.
// Disable verdict caching only; normal verification and fingerprint consent
// remain enabled for every new TLS connection.
export function configureRemoteCertificateVerification(commandLine) {
  const disabled = new Set(
    commandLine
      .getSwitchValue("disable-features")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  disabled.add("CacheCertVerification");
  commandLine.appendSwitch("disable-features", [...disabled].join(","));
}

export const PANEL_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://mc-heads.net https://cdn.modrinth.com https://media.forgecdn.net https://mediafilez.forgecdn.net https://www.spigotmc.org https://cdn.spiget.org https://cdn.feed-the-beast.com https://download.nodecdn.net https://apps.modpacks.ch https://cdn.atlauncher.com https://voidswrath.com https://www.voidswrath.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'";

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
]);

// Snapshot only the installed frontend. Request paths are exact map lookups,
// never filesystem paths, and cannot reach local APIs or the owner's cookies.
export async function createRemoteFrontend({ directory }) {
  if (typeof directory !== "string" || !path.isAbsolute(directory))
    throw new Error(
      "The remote frontend requires an absolute build directory.",
    );
  const assets = new Map();
  const visit = async (folder, prefix = "") => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      const pathname = `${prefix}/${entry.name}`;
      if (/^\/api(?:\/|$)/i.test(pathname)) continue;
      if (entry.isDirectory()) await visit(filename, pathname);
      else if (entry.isFile()) {
        const type = contentTypes.get(path.extname(entry.name).toLowerCase());
        if (type)
          assets.set(pathname, { body: await fs.readFile(filename), type });
      }
    }
  };
  await visit(directory);
  const index = assets.get("/index.html");
  if (!index) throw new Error("The installed frontend is missing index.html.");
  assets.set("/", index);

  return {
    install(remoteSession, origin) {
      const target = new URL(origin);
      if (target.protocol !== "https:" || target.origin !== origin)
        throw new Error("The remote frontend requires an exact HTTPS origin.");
      let disposed = false;
      const lifecycle = new AbortController();
      remoteSession.protocol.handle("https", async (request) => {
        if (disposed) throw new Error("The remote panel is closing.");
        const url = new URL(request.url);
        if (url.username || url.password)
          throw new Error("Panel requests cannot contain URL credentials.");
        const selectedOrigin = url.origin === origin;
        if (!selectedOrigin && url.hostname === target.hostname)
          throw new Error(
            "Panel requests cannot change the selected host's port.",
          );
        const signal = AbortSignal.any([request.signal, lifecycle.signal]);
        const read = request.method === "GET" || request.method === "HEAD";
        const asset = selectedOrigin && read ? assets.get(url.pathname) : null;
        if (asset) {
          if (url.pathname === "/" || url.pathname === "/index.html") {
            // Keep the real host's TLS verification, availability, and initial
            // authentication cookies before showing its locally rendered UI.
            const response = await remoteSession.fetch(request, {
              bypassCustomProtocolHandlers: true,
              credentials: "include",
              redirect: "error",
              signal,
            });
            await response.body?.cancel();
            if (!response.ok)
              throw new Error("The remote panel could not load its frontend.");
          }
          signal.throwIfAborted();
          return new Response(request.method === "HEAD" ? null : asset.body, {
            headers: {
              "Content-Type": asset.type,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
              "Content-Security-Policy": PANEL_CONTENT_SECURITY_POLICY,
              "X-Frame-Options": "DENY",
            },
          });
        }
        const headers = new Headers(request.headers);
        if (selectedOrigin) {
          // Electron's protocol Request omits the browser-generated Origin.
          // This isolated session is confined to the selected panel's main
          // frame and CSP. Restore that origin for remote CSRF validation.
          headers.set("Origin", origin);
        } else {
          if (!read)
            throw new Error(
              "Remote panel writes must stay on the selected host.",
            );
          headers.delete("Cookie");
          headers.delete("Authorization");
          // Provider images and avatars may redirect. Follow each external
          // hop explicitly so HTTPS/origin checks and omitted credentials
          // remain in force even when the destination returns to this host.
          let current = request;
          for (let redirects = 0; ; redirects += 1) {
            const response = await remoteSession.fetch(current, {
              bypassCustomProtocolHandlers: true,
              credentials: "omit",
              redirect: "manual",
              headers,
              signal,
            });
            const location = response.headers.get("location");
            if (
              ![301, 302, 303, 307, 308].includes(response.status) ||
              !location
            )
              return response;
            await response.body?.cancel();
            if (redirects >= 5)
              throw new Error("The remote resource redirected too many times.");
            const next = new URL(location, current.url);
            if (
              next.protocol !== "https:" ||
              next.username ||
              next.password ||
              (next.hostname === target.hostname && next.origin !== origin)
            )
              throw new Error(
                "The remote resource redirected outside an allowed HTTPS address.",
              );
            current = new Request(next.href, {
              method: request.method,
              headers,
              signal,
            });
          }
        }
        // Session fetch uses the remote cookie jar and streams responses (SSE
        // and file downloads included). Reject host redirects before any
        // request can carry panel credentials to a different destination.
        return remoteSession.fetch(request, {
          bypassCustomProtocolHandlers: true,
          credentials: "include",
          redirect: "error",
          headers,
          signal,
        });
      });
      return () => {
        if (disposed) return;
        disposed = true;
        lifecycle.abort();
        remoteSession.protocol.unhandle("https");
      };
    },
  };
}
