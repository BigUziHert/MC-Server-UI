import { randomUUID, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { normalizePanelConnectionUrl } from "../shared/panel-connection.mjs";

const failure = (status, message) =>
  Object.assign(new Error(message), { status });

export async function readPanelConnectionBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
    throw failure(400, "Provide the panel address as JSON.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 4096) chunks.push(chunk);
  }
  if (size > 4096) throw failure(413, "The connection request is too large.");
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw failure(400, "Provide the panel address as JSON.");
  }
  return normalizePanelConnectionUrl(body?.url);
}

function sameOrigin(value, origin) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === origin &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

// Only MC Panel's direct-access case is eligible for a trust exception. A
// fingerprint confirmation must not bypass expiry, name, or signature checks.
function selfSignedFingerprint(certificate, hostname) {
  try {
    const cert = new X509Certificate(certificate.data);
    const host = hostname.replace(/^\[|\]$/g, "");
    if (
      Date.now() < Date.parse(cert.validFrom) ||
      Date.now() >= Date.parse(cert.validTo) ||
      cert.subject !== cert.issuer ||
      !cert.verify(cert.publicKey) ||
      !(isIP(host) ? cert.checkIP(host) : cert.checkHost(host))
    )
      return null;
    return cert.fingerprint256;
  } catch {
    return null;
  }
}

export function createRemotePanelController({
  BrowserWindow,
  session,
  dialog,
  downloadsDirectory,
  icon,
}) {
  const windows = new Set();
  let closed = false;
  return {
    async open(input) {
      if (closed) throw failure(503, "MC Panel is shutting down.");
      const url = normalizePanelConnectionUrl(input);
      const { origin, host, hostname } = new URL(url);
      const remoteSession = session.fromPartition(`mc-remote-${randomUUID()}`);
      remoteSession.setPermissionRequestHandler(
        (_contents, _permission, done) => done(false),
      );
      remoteSession.setPermissionCheckHandler(() => false);
      const remoteWindow = new BrowserWindow({
        title: `${host} · MC Panel remote`,
        width: 1200,
        height: 900,
        minWidth: 760,
        minHeight: 600,
        backgroundColor: "#101211",
        icon,
        show: true,
        autoHideMenuBar: true,
        webPreferences: {
          session: remoteSession,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
          spellcheck: false,
        },
      });
      // Remote content has no native menus or bridge to the local owner window.
      remoteWindow.setMenu(null);
      windows.add(remoteWindow);
      const contents = remoteWindow.webContents;
      let trustedFingerprint;
      let pendingTrust;
      let canceled = false;
      const navigation = (event, destination) => {
        if (!sameOrigin(event.url ?? destination, origin))
          event.preventDefault();
      };
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", navigation);
      contents.on("will-frame-navigate", navigation);
      contents.on("will-redirect", navigation);
      contents.on("will-attach-webview", (event) => event.preventDefault());
      remoteWindow.on("page-title-updated", (event) => event.preventDefault());
      // A response redirect cannot escape the selected host, including requests
      // started from the main process (which skip will-navigate).
      remoteSession.webRequest.onBeforeRequest((details, done) => {
        const document = ["mainFrame", "subFrame"].includes(
          details.resourceType,
        );
        done({ cancel: document && !sameOrigin(details.url, origin) });
      });
      remoteSession.on("will-download", (event, item) => {
        if (
          !sameOrigin(item.getURL(), origin) ||
          item.getURLChain().some((entry) => !sameOrigin(entry, origin))
        ) {
          event.preventDefault();
          return;
        }
        item.setSaveDialogOptions({
          defaultPath: path.join(
            downloadsDirectory,
            path.basename(item.getFilename()),
          ),
          title: "Save remote server file",
        });
      });
      contents.on(
        "certificate-error",
        (event, destination, error, cert, done) => {
          event.preventDefault();
          const fingerprint =
            sameOrigin(destination, origin) &&
            error === "net::ERR_CERT_AUTHORITY_INVALID"
              ? selfSignedFingerprint(cert, hostname)
              : null;
          if (!fingerprint || remoteWindow.isDestroyed()) return done(false);
          if (fingerprint === trustedFingerprint) return done(true);
          if (pendingTrust && pendingTrust.fingerprint !== fingerprint)
            return done(false);
          if (!pendingTrust) {
            const verification = dialog
              .showMessageBox(remoteWindow, {
                type: "warning",
                title: "Verify remote panel certificate",
                message: `Verify the certificate for ${host}`,
                detail: `${trustedFingerprint ? "This panel's certificate has changed.\n\n" : ""}Compare this SHA-256 fingerprint with the fingerprint the server owner shares through a trusted channel:\n\n${fingerprint}\n\nContinue only if every character matches. Trust applies only to this panel window and this exact certificate.`,
                buttons: ["Cancel connection", "Fingerprint matches — connect"],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
              })
              .then(({ response }) => {
                const accepted = response === 1 && !remoteWindow.isDestroyed();
                if (accepted) trustedFingerprint = fingerprint;
                else canceled = true;
                return accepted;
              })
              .catch(() => {
                canceled = true;
                return false;
              });
            pendingTrust = { fingerprint, verification };
            void verification.finally(() => {
              pendingTrust = undefined;
            });
          }
          void pendingTrust.verification.then((accepted) => done(accepted));
        },
      );
      remoteWindow.once("closed", () => {
        windows.delete(remoteWindow);
        trustedFingerprint = undefined;
        // The partition is memory-only; also discard cookies/storage promptly.
        void remoteSession.clearStorageData().catch(() => {});
        void remoteSession.closeAllConnections().catch(() => {});
      });
      try {
        await remoteWindow.loadURL(url);
        if (remoteWindow.isDestroyed())
          throw failure(409, "The remote panel window was closed.");
      } catch {
        if (!remoteWindow.isDestroyed()) remoteWindow.destroy();
        throw failure(
          canceled ? 409 : 502,
          canceled
            ? "Connection canceled. Verify the fingerprint with the server owner before trying again."
            : "Could not open the remote panel. Check its HTTPS address, certificate, and whether the host is online.",
        );
      }
      return { opened: true, url };
    },
    close() {
      closed = true;
      for (const remoteWindow of windows) remoteWindow.destroy();
    },
  };
}
