import { randomUUID, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { normalizePanelConnectionUrl } from "../shared/panel-connection.mjs";
import { installPanelPermissionHandlers } from "./permissions.mjs";
import {
  externalWebsite,
  installExternalLinkHandlers,
} from "./external-links.mjs";

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
      ["http:", "https:"].includes(url.protocol) &&
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
  window,
  localOrigin,
  WebContentsView,
  session,
  dialog,
  downloadsDirectory,
  preload,
  openWebsite = () => {},
  listLocalServers = () => [],
  selectLocalServer,
  onChange = () => {},
}) {
  const panels = new Map();
  const local = {
    id: "local",
    label: "This computer",
    origin: localOrigin,
    local: true,
    contents: window.webContents,
  };
  panels.set(local.id, local);
  let activeId = local.id;
  let attached;
  let closed = false;
  const cleanups = new Set();
  const localServerEntries = () =>
    listLocalServers().flatMap((server) => {
      if (
        !server ||
        typeof server.id !== "string" ||
        typeof server.name !== "string" ||
        typeof server.status !== "string"
      )
        return [];
      const { id, name, status, software, minecraftVersion } = server;
      return [
        {
          id,
          name,
          status,
          ...(typeof software === "string" ? { software } : {}),
          ...(typeof minecraftVersion === "string" ? { minecraftVersion } : {}),
        },
      ];
    });
  const list = () => ({
    activeId,
    // Only the selector's display fields may cross into remote renderers.
    localServers: localServerEntries(),
    panels: [...panels.values()].map(({ id, label, origin, local }) => ({
      id,
      label,
      origin,
      local,
    })),
  });
  const changed = () => {
    const context = list();
    for (const panel of panels.values()) {
      if (!panel.contents.isDestroyed())
        panel.contents.send("mc-panel-connections:changed");
    }
    onChange(context);
    return context;
  };
  const resize = () => {
    if (!attached || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    attached.setBounds({ x: 0, y: 0, width, height });
  };
  window.on("resize", resize);
  const ensureOpen = () => {
    if (closed || window.isDestroyed())
      throw failure(503, "MC Panel is shutting down.");
  };
  const activate = (id) => {
    ensureOpen();
    const panel = panels.get(id);
    if (!panel || panel.contents.isDestroyed())
      throw failure(404, "This panel connection is no longer available.");
    if (attached) window.contentView.removeChildView(attached);
    attached = panel.view;
    if (attached) {
      window.contentView.addChildView(attached);
      resize();
    }
    activeId = id;
    window.setTitle(panel.local ? "MC Panel" : `${panel.label} · MC Panel`);
    panel.contents.focus();
    return changed();
  };
  const dispose = (panel) => {
    if (panel.disposing) return panel.disposing;
    if (activeId === panel.id) {
      if (!closed && !window.isDestroyed()) activate(local.id);
      else activeId = local.id;
    }
    panels.delete(panel.id);
    panel.trustedFingerprint = undefined;
    if (attached === panel.view) {
      if (!window.isDestroyed()) window.contentView.removeChildView(attached);
      attached = undefined;
    }
    // Destroy the renderer before clearing storage so it cannot recreate a
    // session cookie while the connection is being removed.
    if (!panel.contents.isDestroyed()) panel.contents.close();
    const cleanup = Promise.all([
      panel.session.clearStorageData(),
      panel.session.clearCache(),
      panel.session.closeAllConnections(),
    ]).then(() => undefined);
    panel.disposing = cleanup;
    cleanups.add(cleanup);
    void cleanup.finally(() => cleanups.delete(cleanup)).catch(() => {});
    return cleanup;
  };
  const controller = {
    list,
    activate,
    async selectLocalServer(id) {
      ensureOpen();
      if (
        typeof id !== "string" ||
        !localServerEntries().some((server) => server.id === id)
      )
        throw failure(400, "Select a server that is still in the panel.");
      if (!selectLocalServer)
        throw failure(409, "Local server selection is unavailable.");
      await selectLocalServer(id);
      ensureOpen();
      local.contents.send("mc-panel-local-server-selected", id);
      return activate(local.id);
    },
    isManagedSender(event) {
      if (closed || !event?.sender || event.sender.isDestroyed()) return false;
      const panel = [...panels.values()].find(
        (item) => item.contents === event.sender,
      );
      const frame = event.senderFrame;
      return Boolean(
        panel &&
        frame &&
        frame === event.sender.mainFrame &&
        frame.origin === panel.origin &&
        sameOrigin(frame.url, panel.origin) &&
        sameOrigin(event.sender.getURL(), panel.origin),
      );
    },
    async open(input) {
      ensureOpen();
      const url = normalizePanelConnectionUrl(input);
      const { origin, host, hostname, hash } = new URL(url);
      let existing = [...panels.values()].find(
        (panel) => !panel.local && panel.origin === origin,
      );
      if (existing) {
        if (existing.loading) await existing.loading;
        ensureOpen();
        if (hash && existing.contents.getURL() !== url)
          await existing.contents.loadURL(url);
        return activate(existing.id);
      }
      const remoteSession = session.fromPartition(`mc-remote-${randomUUID()}`);
      const view = new WebContentsView({
        webPreferences: {
          session: remoteSession,
          preload,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
          spellcheck: false,
        },
      });
      view.setBackgroundColor("#101211");
      const contents = view.webContents;
      const panel = {
        id: randomUUID(),
        label: host,
        origin,
        local: false,
        view,
        contents,
        session: remoteSession,
      };
      panels.set(panel.id, panel);
      installPanelPermissionHandlers(remoteSession, origin, () => contents);
      let pendingTrust;
      let canceled = false;
      const navigation = (event, destination) => {
        if (!sameOrigin(event.url ?? destination, origin))
          event.preventDefault();
      };
      installExternalLinkHandlers(contents, origin, (target) => {
        const approved = externalWebsite(target);
        if (approved) return openWebsite(approved);
      });
      contents.on("will-navigate", navigation);
      contents.on("will-frame-navigate", navigation);
      contents.on("will-redirect", navigation);
      contents.on("will-attach-webview", (event) => event.preventDefault());
      contents.on("page-title-updated", (event) => event.preventDefault());
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
          if (!fingerprint || contents.isDestroyed() || !panels.has(panel.id))
            return done(false);
          if (fingerprint === panel.trustedFingerprint) return done(true);
          if (pendingTrust && pendingTrust.fingerprint !== fingerprint)
            return done(false);
          if (!pendingTrust) {
            const verification = dialog
              .showMessageBox(window, {
                type: "warning",
                title: "Verify remote panel certificate",
                message: `Verify the certificate for ${host}`,
                detail: `${panel.trustedFingerprint ? "This panel's certificate has changed.\n\n" : ""}Compare this SHA-256 fingerprint with the fingerprint the server owner shares through a trusted channel:\n\n${fingerprint}\n\nContinue only if every character matches. Trust applies only to this connection and this exact certificate.`,
                buttons: ["Cancel connection", "Fingerprint matches — connect"],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
              })
              .then(({ response }) => {
                const accepted =
                  response === 1 &&
                  !contents.isDestroyed() &&
                  panels.has(panel.id);
                if (accepted) panel.trustedFingerprint = fingerprint;
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
      try {
        panel.loading = contents.loadURL(url);
        await panel.loading;
        panel.loading = undefined;
        ensureOpen();
        return activate(panel.id);
      } catch {
        await dispose(panel);
        changed();
        throw failure(
          canceled ? 409 : 502,
          canceled
            ? "Connection canceled. Verify the fingerprint with the server owner before trying again."
            : "Could not open the remote panel. Check its HTTPS address, certificate, and whether the host is online.",
        );
      }
    },
    async disconnect(id) {
      ensureOpen();
      const panel = panels.get(id);
      if (!panel)
        throw failure(404, "This panel connection is no longer available.");
      if (panel.local)
        throw failure(400, "The local panel cannot be disconnected.");
      if (activeId === id) activate(local.id);
      await dispose(panel);
      return changed();
    },
    async close() {
      closed = true;
      window.off("resize", resize);
      await Promise.all(
        [...panels.values()].filter((panel) => !panel.local).map(dispose),
      );
      await Promise.all([...cleanups]);
    },
  };
  return controller;
}
