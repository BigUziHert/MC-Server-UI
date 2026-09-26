import { randomUUID, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { normalizePanelConnectionUrl } from "../shared/panel-connection.mjs";
import { installPanelPermissionHandlers } from "./permissions.mjs";
import { decodeIcon } from "../server/server-icon.mjs";
import {
  externalWebsite,
  installExternalLinkHandlers,
} from "./external-links.mjs";

const failure = (status, message) =>
  Object.assign(new Error(message), { status });

const maxRosterIconCharacters = 4 * 1024 * 1024;
function displayIcon(value, budget) {
  if (typeof value !== "string" || value.length > budget.remaining) return {};
  try {
    // Only bounded, validated 64-pixel PNG bytes may cross session boundaries.
    // Never forward URLs, filesystem paths, or an SVG supplied by a renderer.
    decodeIcon(value);
    budget.remaining -= value.length;
    return { iconDataUrl: value };
  } catch {
    return {};
  }
}

function serverRoster(value) {
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > 500)
    throw failure(400, "Provide a valid, bounded server list.");
  const text = (value, maximum) =>
    typeof value === "string" && value.length > 0 && value.length <= maximum;
  const result = [];
  const iconBudget = { remaining: maxRosterIconCharacters };
  const ids = new Set();
  for (const server of value) {
    if (
      !server ||
      typeof server !== "object" ||
      Array.isArray(server) ||
      !text(server.id, 128) ||
      !text(server.name, 180) ||
      !text(server.status, 32) ||
      (server.software != null && !text(server.software, 128)) ||
      (server.minecraftVersion != null && !text(server.minecraftVersion, 128))
    )
      throw failure(400, "Provide valid server display fields.");
    if (ids.has(server.id)) continue;
    ids.add(server.id);
    const { id, name, status, software, minecraftVersion } = server;
    result.push({
      id,
      name,
      status,
      ...(typeof software === "string" ? { software } : {}),
      ...(typeof minecraftVersion === "string" ? { minecraftVersion } : {}),
      ...displayIcon(server.iconDataUrl, iconBudget),
    });
  }
  return result;
}

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

function sameOriginDownload(value, origin) {
  if (sameOrigin(value, origin)) return true;
  try {
    const url = new URL(value);
    // Console exports are generated in the renderer. Permit only blobs owned
    // by this panel; document navigation still requires an HTTP(S) URL.
    return url.protocol === "blob:" && sameOrigin(url.pathname, origin);
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
  remoteFrontend,
  openWebsite = () => {},
  openUpdatesOverlay,
  dismissUpdatesOverlay = () => {},
  listLocalServers = () => [],
  selectLocalServer,
  store,
  onError = () => {},
  restoreTimeoutMs = 10000,
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
  let preferredActiveId = local.id;
  let activationVersion = 0;
  let restoring;
  let restoreRead;
  let savedWrites = Promise.resolve();
  let attached;
  let closed = false;
  let closing;
  const cleanups = new Set();
  // Saved connections outlive their views, including a quit while the initial
  // registry read or an offline host's background load is still pending.
  const registry = new Map();
  const readRegistry = () => {
    if (!store) return Promise.resolve({ activeId: "local", panels: [] });
    if (!restoreRead) {
      const untouched = activationVersion;
      restoreRead = store.read().then((saved) => {
        for (const entry of saved.panels) registry.set(entry.id, { ...entry });
        if (untouched === 0 && activationVersion === untouched)
          preferredActiveId = saved.activeId;
        return saved;
      });
    }
    return restoreRead;
  };
  const remember = (panel) => {
    const { id, origin, trustedFingerprint, signedIn } = panel;
    registry.set(id, {
      id,
      origin,
      ...(trustedFingerprint ? { trustedFingerprint } : {}),
      ...(typeof signedIn === "boolean" ? { signedIn } : {}),
    });
  };
  const persist = () => {
    if (!store) return Promise.resolve();
    const write = savedWrites
      .catch(() => {})
      .then(async () => {
        await readRegistry();
        const savedPanels = [...registry.values()];
        return store.save({
          activeId: savedPanels.some((panel) => panel.id === preferredActiveId)
            ? preferredActiveId
            : "local",
          panels: savedPanels.map(
            ({ id, origin, trustedFingerprint, signedIn }) => ({
              id,
              origin,
              ...(trustedFingerprint ? { trustedFingerprint } : {}),
              ...(typeof signedIn === "boolean" ? { signedIn } : {}),
            }),
          ),
        });
      });
    savedWrites = write;
    return write;
  };
  const localServerEntries = () => {
    const iconBudget = { remaining: maxRosterIconCharacters };
    return listLocalServers().flatMap((server) => {
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
          ...displayIcon(server.iconDataUrl, iconBudget),
        },
      ];
    });
  };
  const list = () => ({
    activeId,
    // Only the selector's display fields may cross into remote renderers.
    localServers: localServerEntries(),
    panels: [...panels.values()].map(
      ({ id, label, origin, local, servers, signedIn }) => ({
        id,
        label,
        origin,
        local,
        ...(!local
          ? {
              servers: servers.map((server) => ({ ...server })),
              ...(typeof signedIn === "boolean" ? { signedIn } : {}),
            }
          : {}),
      }),
    ),
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
  const deliverRemoteSelection = (panel) => {
    const id = panel.pendingServerId;
    const contents = panel.contents;
    if (
      !id ||
      !panels.has(panel.id) ||
      contents.isDestroyed() ||
      panel.selectionNeedsReport
    )
      return;
    const frame = contents.mainFrame;
    if (
      !frame ||
      frame.origin !== panel.origin ||
      !sameOrigin(frame.url, panel.origin) ||
      !sameOrigin(contents.getURL(), panel.origin)
    )
      return;
    panel.pendingServerId = undefined;
    panel.selectionNeedsReport = false;
    if (panel.servers.some((server) => server.id === id))
      contents.send("mc-panel-remote-server-selected", id);
  };
  const activate = (id, { restored = false } = {}) => {
    ensureOpen();
    const panel = panels.get(id);
    if (!panel || panel.contents.isDestroyed())
      throw failure(404, "This panel connection is no longer available.");
    if (!restored) {
      preferredActiveId = id;
      activationVersion += 1;
    }
    if (panel.failed) {
      const requestedAt = activationVersion;
      return Promise.resolve(panel.loading)
        .catch(() => {})
        .then(async () => {
          if (panel.failed) await panel.load(`${panel.origin}/`);
          return activationVersion === requestedAt
            ? activate(id, { restored: true })
            : list();
        });
    }
    dismissUpdatesOverlay();
    if (attached) window.contentView.removeChildView(attached);
    attached = panel.view;
    if (attached) {
      window.contentView.addChildView(attached);
      resize();
    }
    activeId = id;
    window.setTitle(panel.local ? "MC Panel" : `${panel.label} · MC Panel`);
    panel.contents.focus();
    if (!closed) void persist().catch(onError);
    return changed();
  };
  const dispose = (panel) => {
    if (panel.disposing) return panel.disposing;
    panel.removed = true;
    if (activeId === panel.id) {
      if (!closed && !window.isDestroyed()) activate(local.id);
      else activeId = local.id;
    }
    panels.delete(panel.id);
    panel.trustedFingerprint = undefined;
    panel.pendingServerId = undefined;
    if (attached === panel.view) {
      if (!window.isDestroyed()) window.contentView.removeChildView(attached);
      attached = undefined;
    }
    // Destroy the renderer before clearing storage so it cannot recreate a
    // session cookie while the connection is being removed.
    if (!panel.contents.isDestroyed()) panel.contents.close();
    panel.removeFrontend?.();
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
    openUpdates() {
      ensureOpen();
      if (!openUpdatesOverlay)
        throw failure(503, "App updates are unavailable. Try again shortly.");
      // Remote pages can open the trusted local UI, but cannot read updater
      // state or start a check, download, or install through this bridge. The
      // active connection and its persisted selection stay exactly as they are.
      return openUpdatesOverlay(panels.get(activeId)?.contents);
    },
    reportServers(event, value) {
      if (!controller.isManagedSender(event))
        throw failure(403, "This page cannot report remote servers.");
      const panel = [...panels.values()].find(
        (item) => item.contents === event.sender,
      );
      if (panel.local)
        throw failure(
          403,
          "Only a connected remote panel can report its servers.",
        );
      const servers = serverRoster(value);
      const rosterChanged =
        JSON.stringify(panel.servers) !== JSON.stringify(servers);
      // An empty authenticated roster can still have host permissions or gain
      // new grants. Only null means that this session has actually signed out.
      const signedIn = value !== null;
      const sessionChanged = panel.signedIn !== signedIn;
      panel.servers = servers;
      panel.signedIn = signedIn;
      if (sessionChanged && panel.saved) {
        remember(panel);
        void persist().catch(onError);
      }
      if (value === null) panel.pendingServerId = undefined;
      // An authenticated renderer report proves the app has mounted after a
      // reload. did-finish-load alone can precede its selection listener.
      panel.selectionNeedsReport = false;
      deliverRemoteSelection(panel);
      if (rosterChanged || sessionChanged) changed();
    },
    selectRemoteServer(panelId, serverId) {
      ensureOpen();
      const panel = panels.get(panelId);
      if (
        !panel ||
        panel.local ||
        panel.contents.isDestroyed() ||
        typeof serverId !== "string" ||
        !panel.servers.some((server) => server.id === serverId)
      )
        throw failure(
          404,
          "This remote server is no longer available in the connected panel.",
        );
      panel.pendingServerId = serverId;
      panel.selectionNeedsReport ||= panel.contents.isLoadingMainFrame();
      deliverRemoteSelection(panel);
      return activate(panel.id);
    },
    async selectLocalServer(id) {
      ensureOpen();
      if (
        typeof id !== "string" ||
        !localServerEntries().some((server) => server.id === id)
      )
        throw failure(400, "Select a server that is still in the panel.");
      if (!selectLocalServer)
        throw failure(409, "Local server selection is unavailable.");
      const requestedAt = ++activationVersion;
      await selectLocalServer(id);
      ensureOpen();
      local.contents.send("mc-panel-local-server-selected", id);
      // Saving may wait for older renderer writes. Keep any panel the user
      // chose during that wait visible while updating the local selection.
      return requestedAt === activationVersion ? activate(local.id) : list();
    },
    isManagedSender(event) {
      if (closed || !event?.sender || event.sender.isDestroyed()) return false;
      const panel = [...panels.values()].find(
        (item) => item.contents === event.sender,
      );
      const frame = event.senderFrame;
      return Boolean(
        panel &&
        !panel.removed &&
        frame &&
        frame === event.sender.mainFrame &&
        frame.origin === panel.origin &&
        sameOrigin(frame.url, panel.origin) &&
        sameOrigin(event.sender.getURL(), panel.origin),
      );
    },
    async restore() {
      if (!store) return list();
      if (restoring) return restoring;
      const untouched = activationVersion;
      restoring = (async () => {
        const saved = await readRegistry();
        ensureOpen();
        await Promise.allSettled(
          saved.panels.map(async (entry) => {
            await controller.open(entry.origin, {
              savedEntry: entry,
              background: true,
            });
            if (
              !closed &&
              untouched === 0 &&
              entry.id === saved.activeId &&
              activationVersion === untouched
            )
              activate(entry.id, { restored: true });
          }),
        );
        return list();
      })();
      return restoring;
    },
    async open(input, { savedEntry, background = false } = {}) {
      ensureOpen();
      const requestedAt = background ? activationVersion : ++activationVersion;
      try {
        await readRegistry();
      } catch (error) {
        onError(error);
        throw failure(
          503,
          "Saved panel connections are unavailable. Restart MC Panel and try again.",
        );
      }
      ensureOpen();
      const url = normalizePanelConnectionUrl(input);
      const { origin, host, hostname, hash } = new URL(url);
      savedEntry ??= [...registry.values()].find(
        (entry) => entry.origin === origin,
      );
      let existing = [...panels.values()].find(
        (panel) => !panel.local && !panel.removed && panel.origin === origin,
      );
      if (existing) {
        if (existing.loading) await existing.loading.catch(() => {});
        ensureOpen();
        if (existing.failed || (hash && existing.contents.getURL() !== url))
          await existing.load(url, { quiet: background });
        return !background && requestedAt === activationVersion
          ? activate(existing.id)
          : list();
      }
      if (
        !savedEntry &&
        new Set([
          ...registry.keys(),
          ...[...panels.values()]
            .filter((panel) => !panel.local)
            .map((panel) => panel.id),
        ]).size >= 50
      )
        throw failure(
          409,
          "Disconnect a panel before adding another connection.",
        );
      const id = savedEntry?.id ?? randomUUID();
      const remoteSession = session.fromPartition(
        `${store ? "persist:" : ""}mc-remote-${id}`,
      );
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
        id,
        label: host,
        origin,
        local: false,
        servers: [],
        view,
        contents,
        session: remoteSession,
        saved: Boolean(savedEntry),
        trustedFingerprint: savedEntry?.trustedFingerprint,
        // This is only a display hint; the remote server verifies access.
        signedIn: savedEntry?.signedIn,
        failed: true,
        allowCertificatePrompt: !background,
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
        const downloadUrl = item.getURL();
        if (
          !sameOriginDownload(downloadUrl, origin) ||
          item
            .getURLChain()
            .some(
              (entry) => entry !== downloadUrl && !sameOrigin(entry, origin),
            )
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
      const verifyCertificate = (destination, error, cert, done) => {
        const fingerprint =
          sameOrigin(destination, origin) &&
          error === "net::ERR_CERT_AUTHORITY_INVALID"
            ? selfSignedFingerprint(cert, hostname)
            : null;
        if (
          !fingerprint ||
          panel.removed ||
          contents.isDestroyed() ||
          !panels.has(panel.id)
        )
          return done(false);
        if (fingerprint === panel.trustedFingerprint) return done(true);
        if (!panel.allowCertificatePrompt) return done(false);
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
                !panel.removed &&
                !contents.isDestroyed() &&
                panels.has(panel.id);
              if (accepted) {
                panel.trustedFingerprint = fingerprint;
                if (panel.saved) {
                  remember(panel);
                  void persist().catch(onError);
                }
              } else canceled = true;
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
      };
      contents.on(
        "certificate-error",
        (event, destination, error, cert, done) => {
          event.preventDefault();
          verifyCertificate(destination, error, cert, done);
        },
      );
      if (remoteFrontend) {
        // Protocol forwarding uses this isolated session's network stack and
        // does not have a WebContents certificate-error event. Apply the same
        // fingerprint consent and hostname/expiry checks to that path.
        const verifySessionCertificate = (request, done) => {
          if (request.verificationResult === "net::OK") return done(-3);
          if (
            request.hostname.replace(/^\[|\]$/g, "") !==
            hostname.replace(/^\[|\]$/g, "")
          )
            return done(-2);
          verifyCertificate(
            origin,
            request.verificationResult,
            request.certificate,
            (accepted) => done(accepted ? 0 : -2),
          );
        };
        remoteSession.setCertificateVerifyProc(verifySessionCertificate);
        let remove = () => {};
        let frontendRemoved = false;
        panel.removeFrontend = () => {
          if (frontendRemoved) return;
          frontendRemoved = true;
          try {
            remove();
          } finally {
            remoteSession.setCertificateVerifyProc(null);
          }
        };
        try {
          remove = remoteFrontend.install(remoteSession, origin);
        } catch (cause) {
          await dispose(panel);
          throw cause;
        }
      }
      panel.load = async (target, { quiet = false } = {}) => {
        ensureOpen();
        if (panel.removed || contents.isDestroyed() || panels.get(id) !== panel)
          throw failure(404, "This panel connection is no longer available.");
        canceled = false;
        panel.allowCertificatePrompt = !quiet;
        if (panel.pendingServerId) panel.selectionNeedsReport = true;
        let timeout;
        panel.loading = (async () => {
          try {
            await Promise.race([
              contents.loadURL(target),
              new Promise((_, reject) => {
                timeout = setTimeout(
                  () => {
                    contents.stop();
                    reject(failure(502, "The remote panel did not respond."));
                  },
                  quiet ? restoreTimeoutMs : 30000,
                );
              }),
            ]);
            ensureOpen();
            if (
              panel.removed ||
              contents.isDestroyed() ||
              panels.get(id) !== panel
            )
              throw failure(
                404,
                "This panel connection is no longer available.",
              );
            panel.failed = false;
            panel.saved = Boolean(store);
            if (store) remember(panel);
            await persist();
          } catch {
            panel.failed = true;
            if (!panel.saved) await dispose(panel);
            changed();
            throw failure(
              canceled ? 409 : 502,
              canceled
                ? "Connection canceled. Verify the fingerprint with the server owner before trying again."
                : "Could not open the remote panel. Check its HTTPS address, certificate, and whether the host is online.",
            );
          } finally {
            clearTimeout(timeout);
            panel.loading = undefined;
          }
        })();
        return panel.loading;
      };
      await panel.load(url, { quiet: background });
      return background || requestedAt !== activationVersion
        ? changed()
        : activate(panel.id);
    },
    async disconnect(id) {
      ensureOpen();
      const panel = panels.get(id);
      if (!panel)
        throw failure(404, "This panel connection is no longer available.");
      if (panel.local)
        throw failure(400, "The local panel cannot be disconnected.");
      if (activeId === id) activate(local.id);
      if (preferredActiveId === id) preferredActiveId = "local";
      panel.removed = true;
      panel.saved = false;
      registry.delete(id);
      try {
        await persist();
      } catch (error) {
        onError(error);
        throw failure(500, "The saved connection could not be removed.");
      } finally {
        await dispose(panel);
      }
      return changed();
    },
    close() {
      if (closing) return closing;
      closed = true;
      window.off("resize", resize);
      closing = (async () => {
        const remote = [...panels.values()].filter((panel) => !panel.local);
        if (store) {
          const results = await Promise.allSettled([
            persist(),
            ...remote.map(async (panel) => {
              if (!panel.contents.isDestroyed()) {
                panel.contents.stop();
                panel.contents.close();
              }
              panel.removeFrontend?.();
              const flushed = await Promise.allSettled([
                Promise.resolve().then(() => panel.session.flushStorageData()),
                Promise.resolve().then(() =>
                  panel.session.cookies.flushStore(),
                ),
                Promise.resolve().then(() =>
                  panel.session.closeAllConnections(),
                ),
              ]);
              const failed = flushed.find(
                (result) => result.status === "rejected",
              );
              if (failed) throw failed.reason;
            }),
          ]);
          const drained = await Promise.allSettled([
            store.close(),
            ...cleanups,
          ]);
          const failed = [...results, ...drained].find(
            (result) => result.status === "rejected",
          );
          if (failed) throw failed.reason;
        } else {
          await Promise.all(remote.map(dispose));
          await Promise.all([...cleanups]);
        }
      })();
      return closing;
    },
  };
  return controller;
}
