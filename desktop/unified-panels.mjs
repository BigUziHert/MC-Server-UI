import { randomUUID, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizePanelConnectionUrl } from "../shared/panel-connection.mjs";
import { displayRoster } from "./unified-connection-store.mjs";

const failure = (status, message) =>
  Object.assign(new Error(message), { status });
const validToken = (token) =>
  typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
const pendingLeaveMessage =
  "Forget is not complete. Use Retry Forget in Manage Connections to confirm access removal and finish local cleanup; the saved connection and retry proof are retained.";
const text = (value, maximum = 256) =>
  typeof value === "string" && value.length <= maximum;
const strings = (value) =>
  Array.isArray(value)
    ? value.filter((item) => text(item, 128)).slice(0, 100)
    : [];
function sessionRecord(value) {
  if (
    value?.role !== "subuser" ||
    !text(value.email) ||
    !text(value.userId, 128)
  )
    throw failure(502, "The host returned an invalid account session.");
  return {
    role: "subuser",
    email: value.email,
    userId: value.userId,
    ...(text(value.accountId, 128) ? { accountId: value.accountId } : {}),
    serverId: text(value.serverId, 128) ? value.serverId : null,
    permissions: strings(value.permissions),
    hostPermissions: strings(value.hostPermissions),
  };
}
function roster(value) {
  if (!Array.isArray(value) || value.length > 500)
    throw failure(502, "The host returned an invalid server list.");
  const seen = new Set();
  return value.flatMap((server) => {
    if (
      !text(server?.id, 128) ||
      !server.id ||
      !text(server.name, 180) ||
      !text(server.status, 32) ||
      seen.has(server.id)
    )
      return [];
    seen.add(server.id);
    return [
      { ...server, accessPermissions: strings(server.accessPermissions) },
    ];
  });
}
function fingerprint(certificate, hostname) {
  try {
    const cert = new X509Certificate(certificate.data);
    const host = hostname.replace(/^\[|\]$/g, "");
    return Date.now() >= Date.parse(cert.validFrom) &&
      Date.now() < Date.parse(cert.validTo) &&
      cert.subject === cert.issuer &&
      cert.verify(cert.publicKey) &&
      (isIP(host) ? cert.checkIP(host) : cert.checkHost(host))
      ? cert.fingerprint256
      : null;
  } catch {
    return null;
  }
}

export function createUnifiedPanelController({
  window,
  localOrigin,
  session,
  dialog,
  store,
  listLocalServers = () => [],
  openUpdatesOverlay,
  onError = () => {},
  pollMs = 5000,
}) {
  const panels = new Map();
  let selectedServer = null,
    closed = false,
    loaded,
    ready = false,
    initializationError = "",
    saving = Promise.resolve();
  const changed = () => {
    if (!closed && !window.webContents.isDestroyed())
      window.webContents.send("mc-panel-connections:changed");
    return list();
  };
  const persist = (removeId, promote) => {
    const write = saving
      .catch(() => {})
      .then(async () => {
        if (!ready) await initialize();
        if (promote) {
          if (closed || promote.removed || panels.get(promote.id) !== promote)
            throw failure(409, "This panel sign-in changed.");
          if (
            [...panels.values()].some(
              (panel) =>
                panel !== promote &&
                !panel.temporary &&
                panel.origin === promote.origin,
            )
          )
            throw failure(
              409,
              "This panel was already saved. Use its saved connection to sign in.",
            );
          promote.promotionWriting = true;
        }
        try {
          const result = await store?.save({
            panels: [...panels.values()]
              .filter(
                (panel) =>
                  panel.id !== removeId &&
                  (!panel.temporary || panel === promote),
              )
              .map(({ temporary, ...panel }) => ({
                ...panel,
                session: panel.account,
              })),
            selectedServer,
            ...(promote ? { requireCredentialFor: promote.id } : {}),
          });
          if (promote) promote.temporary = false;
          // Remove in-memory state only after the corresponding disk write succeeds.
          // Do it inside the write queue so a later snapshot cannot resurrect it.
          if (removeId) {
            panels.delete(removeId);
            return result;
          }
          for (const panel of panels.values()) {
            if (panel.legacyImport) {
              await clearLegacy(panel.id);
              panel.legacyImport = false;
            }
          }
          return result;
        } finally {
          if (promote) promote.promotionWriting = false;
        }
      });
    saving = write;
    return write;
  };
  const local = () => ({
    id: "local",
    label: "This computer",
    origin: localOrigin,
    local: true,
    signedIn: true,
    connectionState: "connected",
    sessionEpoch: "local",
    servers: listLocalServers(),
  });
  const describe = (panel) => ({
    id: panel.id,
    origin: panel.origin,
    label: new URL(panel.origin).host,
    local: false,
    signedIn: !panel.temporary && Boolean(panel.token && panel.account),
    connectionState: panel.state,
    session: panel.temporary ? undefined : panel.account,
    sessionEpoch: panel.epoch,
    pendingLeave: Boolean(panel.pendingLeave),
    servers: panel.temporary ? [] : panel.servers,
    ...(panel.temporary ? { temporary: true } : {}),
    ...(panel.error ? { error: panel.error } : {}),
  });
  const list = () => ({
    unified: true,
    ready,
    ...(initializationError ? { error: initializationError } : {}),
    selectedServer,
    activeId: selectedServer?.panelId ?? "local",
    localServers: listLocalServers(),
    panels: [
      local(),
      ...[...panels.values()].filter((panel) => !panel.temporary).map(describe),
    ],
  });
  const ensure = () => {
    if (closed) throw failure(503, "MC Panel is shutting down.");
  };
  const get = (id) => {
    ensure();
    const panel = panels.get(id);
    if (!panel || panel.removed || panel.removing)
      throw failure(404, "This panel connection is no longer available.");
    return panel;
  };
  async function clearLegacy(id) {
    const legacy = session.fromPartition(`persist:mc-remote-${id}`);
    legacy.setCertificateVerifyProc?.(null);
    await legacy.clearStorageData?.();
    await legacy.closeAllConnections?.();
    await store?.forgetLegacy?.(id);
  }
  async function cancelSignIn(id) {
    const panel = panels.get(id);
    if (!panel?.temporary) return;
    // An atomic disk write already in progress must finish. A promotion still
    // queued behind another write is cancelled before it can reach the store.
    if (panel.promotionWriting) await panel.promoting.catch(() => {});
    if (!panel.temporary || panels.get(id) !== panel) return;
    panel.controls++;
    panel.removed = true;
    panel.pendingTrust?.abort.abort();
    invalidate(panel);
    panels.delete(id);
    panel.network.setCertificateVerifyProc(null);
    await Promise.allSettled([
      panel.network.clearStorageData?.(),
      panel.network.closeAllConnections?.(),
    ]);
    changed();
  }
  function invalidate(panel) {
    panel.epoch = randomUUID();
    for (const request of panel.requests) request.abort();
    panel.requests.clear();
  }
  function forgetSession(panel) {
    if (panel.pendingLeave) return;
    if (panel.token || panel.account || panel.servers.length) invalidate(panel);
    panel.token = null;
    panel.account = undefined;
    panel.servers = [];
    if (selectedServer?.panelId === panel.id) selectedServer = null;
  }
  async function removeSavedPanel(panel, expectedEpoch) {
    if (panel.pendingLeave) throw failure(409, pendingLeaveMessage);
    if (
      panel.epoch !== expectedEpoch ||
      panel.removed ||
      panel.removing ||
      closed
    )
      throw failure(
        409,
        "This panel sign-in changed. Review the saved connection again.",
      );
    // Block new controls and invalidate every older response before awaiting IO.
    // Keep the record until its removal is durable, so a failed write is retryable.
    panel.removing = true;
    panel.controls++;
    panel.authenticating = false;
    panel.pendingTrust?.abort.abort();
    panel.allowPrompt = false;
    invalidate(panel);
    if (selectedServer?.panelId === panel.id) selectedServer = null;
    try {
      await persist(panel.id);
    } catch (cause) {
      panel.removing = false;
      panel.state = "unavailable";
      panel.servers = displayRoster(panel.servers);
      panel.error = `The saved connection could not be removed. ${cause.message || "Check this computer's storage and retry."}`;
      panel.nextRefresh = Date.now() + 30000;
      changed();
      throw Object.assign(failure(503, panel.error), {
        localRemovalFailed: true,
      });
    }
    panel.removed = true;
    panel.network.setCertificateVerifyProc(null);
    const cleanup = await Promise.allSettled([
      clearLegacy(panel.id),
      panel.network.clearStorageData?.(),
      panel.network.closeAllConnections?.(),
    ]);
    for (const result of cleanup)
      if (result.status === "rejected") onError(result.reason);
    return changed();
  }
  function make(entry) {
    const panel = {
      ...entry,
      token: entry.token ?? null,
      account: undefined,
      epoch: randomUUID(),
      state: "unavailable",
      servers: displayRoster(entry.servers),
      network: session.fromPartition(
        `${entry.temporary ? "" : "persist:"}mc-unified-${entry.id}`,
      ),
      requests: new Set(),
      nextRefresh: 0,
      controls: 0,
      allowPrompt: false,
      pendingTrust: null,
      removed: false,
    };
    try {
      if (entry.token && entry.session)
        panel.account = sessionRecord(entry.session);
    } catch {
      panel.token = null;
    }
    if (!panel.token || !panel.account) {
      panel.token = null;
      panel.account = undefined;
      panel.servers = [];
    }
    if (panel.pendingLeave) panel.error = pendingLeaveMessage;
    panel.network.setPermissionRequestHandler?.(
      (_contents, _permission, callback) => callback(false),
    );
    panel.network.setPermissionCheckHandler?.(() => false);
    panel.network.setCertificateVerifyProc((request, done) => {
      if (request.verificationResult === "net::OK") return done(-3);
      const hostname = new URL(panel.origin).hostname;
      const sameHost =
        request.hostname.replace(/^\[|\]$/g, "") ===
        hostname.replace(/^\[|\]$/g, "");
      const value =
        sameHost &&
        request.verificationResult === "net::ERR_CERT_AUTHORITY_INVALID"
          ? fingerprint(request.certificate, hostname)
          : null;
      if (!value || panel.removed || closed) return done(-2);
      if (value === panel.trustedFingerprint) return done(0);
      if (
        !panel.allowPrompt ||
        (panel.pendingTrust && panel.pendingTrust.value !== value)
      )
        return done(-2);
      if (!panel.pendingTrust) {
        const abort = new AbortController();
        const prompt = { abort, value };
        panel.pendingTrust = prompt;
        for (const request of panel.requests) request.pause?.();
        prompt.result = Promise.race([
          dialog.showMessageBox(window, {
            type: "warning",
            title: "Verify remote panel certificate",
            message: `Verify the certificate for ${new URL(panel.origin).host}`,
            detail: `${panel.trustedFingerprint ? "This panel's certificate has changed.\n\n" : ""}Compare this SHA-256 fingerprint with the server owner through a trusted channel:\n\n${value}\n\nThis verifies the server before sign-in. It does not sign you in or grant panel or server access. Trust applies only to this connection and exact certificate.`,
            buttons: ["Cancel", "Fingerprint matches — continue"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            signal: abort.signal,
          }),
          new Promise((resolve) =>
            abort.signal.addEventListener(
              "abort",
              () => resolve({ response: 0 }),
              { once: true },
            ),
          ),
        ])
          .then(async ({ response }) => {
            if (
              response !== 1 ||
              abort.signal.aborted ||
              closed ||
              panel.removed
            )
              return false;
            panel.trustedFingerprint = value;
            if (!panel.temporary) await persist();
            return true;
          })
          .catch(() => false)
          .finally(() => {
            if (panel.pendingTrust === prompt) panel.pendingTrust = null;
            for (const request of panel.requests) request.resume?.();
          });
      }
      void panel.pendingTrust.result.then((accepted) =>
        done(accepted ? 0 : -2),
      );
    });
    panels.set(panel.id, panel);
    return panel;
  }
  async function readJson(response) {
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      throw failure(
        502,
        "This address did not return an MC Panel API response.",
      );
    }
    const reader = response.body?.getReader();
    const chunks = [];
    let length = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 4 * 1024 * 1024)
            throw failure(502, "The remote API response is too large.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (cause) {
      throw failure(502, "The host returned invalid JSON.");
    }
    if (!response.ok)
      throw Object.assign(
        failure(
          response.status,
          typeof body?.error === "string"
            ? body.error
            : "The remote request failed.",
        ),
        { remoteResponse: true, accessRevoked: body?.accessRevoked === true },
      );
    return body;
  }
  async function request(
    panel,
    pathname,
    {
      method = "GET",
      body,
      headers,
      signal,
      timeout = 10000,
      tokenOverride,
    } = {},
  ) {
    ensure();
    if (panel.removed || panel.removing || panels.get(panel.id) !== panel)
      throw failure(404, "This panel connection is no longer available.");
    const control = new AbortController();
    const epoch = panel.epoch;
    let timer;
    control.pause = () => clearTimeout(timer);
    control.resume = () => {
      clearTimeout(timer);
      if (timeout && !panel.pendingTrust)
        timer = setTimeout(
          () =>
            control.abort(failure(504, "The remote panel did not respond.")),
          timeout,
        );
    };
    panel.requests.add(control);
    control.resume();
    const outgoing = new Headers(headers);
    outgoing.delete("Cookie");
    outgoing.delete("Authorization");
    outgoing.delete("Host");
    outgoing.set("Origin", panel.origin);
    const credential = tokenOverride ?? panel.token;
    if (credential) outgoing.set("Authorization", `Bearer ${credential}`);
    try {
      const response = await panel.network.fetch(`${panel.origin}${pathname}`, {
        method,
        headers: outgoing,
        ...(body !== undefined ? { body, duplex: "half" } : {}),
        credentials: "omit",
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, control.signal])
          : control.signal,
      });
      if (closed || panel.removed || panel.epoch !== epoch) {
        await response.body?.cancel();
        throw failure(
          409,
          "This panel sign-in changed while the request was running.",
        );
      }
      return {
        response,
        done: () => {
          clearTimeout(timer);
          panel.requests.delete(control);
        },
        control,
      };
    } catch (cause) {
      clearTimeout(timer);
      panel.requests.delete(control);
      throw cause;
    }
  }
  async function json(panel, pathname, options) {
    const pending = await request(panel, pathname, options);
    try {
      return await readJson(pending.response);
    } finally {
      pending.done();
    }
  }
  async function refresh(panel, explicit = false) {
    if (panel.pendingLeave || panel.removing || panel.removed) return;
    if (panel.refreshing) {
      if (!explicit || panel.refreshExplicit) return panel.refreshing;
      await panel.refreshing.catch(() => {});
      ensure();
      if (panel.removed)
        throw failure(404, "This panel connection is no longer available.");
      return refresh(panel, true);
    }
    const epoch = panel.epoch;
    panel.refreshExplicit = explicit;
    panel.allowPrompt = explicit;
    if (explicit) {
      panel.state = "connecting";
      changed();
    }
    panel.refreshing = (async () => {
      try {
        const account = await json(panel, "/api/access/session");
        if (panel.epoch !== epoch || panel.removed || closed) return;
        if (
          account.role === "guest" &&
          account.accessRevoked === true &&
          panel.token
        ) {
          await removeSavedPanel(panel, epoch);
          return;
        }
        if (account.role !== "subuser" || !panel.token) {
          forgetSession(panel);
          panel.state = "connected";
          panel.error = "";
        } else {
          const current = sessionRecord(account);
          const fleet = await json(panel, "/api/servers");
          if (panel.epoch !== epoch || panel.removed || closed) return;
          panel.account = {
            ...current,
            hostPermissions: strings(
              fleet.hostPermissions ?? current.hostPermissions,
            ),
          };
          panel.servers = roster(fleet.servers);
          panel.state = "connected";
          panel.error = "";
          if (
            selectedServer?.panelId === panel.id &&
            !panel.servers.some(
              (server) => server.id === selectedServer.serverId,
            )
          )
            selectedServer = null;
        }
        panel.nextRefresh = Date.now() + pollMs;
        if (!panel.temporary) await persist();
      } catch (cause) {
        if (cause.localRemovalFailed) {
          if (explicit) throw cause;
          return;
        }
        if (panel.epoch !== epoch || panel.removed || closed) return;
        if (cause.status === 401) {
          if (cause.accessRevoked === true && panel.token) {
            await removeSavedPanel(panel, epoch);
            return;
          }
          forgetSession(panel);
          if (!panel.temporary) await persist();
        }
        panel.state = "unavailable";
        panel.servers = displayRoster(panel.servers);
        panel.error = cause.status
          ? cause.message
          : "The panel is unavailable. Check its address, certificate and connection, then retry.";
        panel.nextRefresh = Date.now() + 30000;
        if (explicit) throw failure(cause.status ?? 502, panel.error);
      } finally {
        if (panel.epoch === epoch) panel.allowPrompt = false;
        panel.refreshExplicit = false;
        panel.refreshing = null;
        changed();
      }
    })();
    return panel.refreshing;
  }
  async function initialize() {
    if (!loaded)
      loaded = (async () => {
        const saved = (await store?.read()) ?? {
          panels: [],
          selectedServer: null,
        };
        ensure();
        for (const entry of saved.panels)
          if (!panels.has(entry.id))
            make({ ...entry, legacyImport: saved.migrated === true });
        selectedServer = saved.selectedServer;
        initializationError = saved.warning ?? "";
        ready = true;
        changed();
      })().catch((cause) => {
        loaded = undefined;
        initializationError =
          "Saved panel connections could not be read. Your existing connection file was preserved. Fix its storage permissions and restart MC Panel; local servers remain available.";
        changed();
        throw cause;
      });
    return loaded;
  }
  const timer = setInterval(() => {
    if (closed || !ready) return;
    for (const panel of panels.values())
      if (
        !panel.temporary &&
        !panel.authenticating &&
        !panel.pendingLeave &&
        !panel.removing &&
        Date.now() >= panel.nextRefresh
      )
        void refresh(panel).catch(onError);
  }, pollMs);
  timer.unref?.();
  const controller = {
    list,
    initialize,
    isManagedSender(event) {
      const contents = window.webContents,
        frame = event?.senderFrame;
      return (
        !closed &&
        event?.sender === contents &&
        !contents.isDestroyed() &&
        frame === contents.mainFrame &&
        frame?.origin === localOrigin &&
        new URL(frame.url).origin === localOrigin &&
        new URL(contents.getURL()).origin === localOrigin
      );
    },
    async restore() {
      await initialize();
      await Promise.allSettled(
        [...panels.values()]
          .filter((panel) => !panel.temporary)
          .map((panel) => refresh(panel)),
      );
      return changed();
    },
    async open(input) {
      await initialize();
      ensure();
      const origin = new URL(normalizePanelConnectionUrl(input)).origin;
      let panel = [...panels.values()].find(
        (entry) => !entry.temporary && entry.origin === origin,
      );
      if (!panel) {
        if (panels.size >= 50)
          throw failure(
            409,
            "Forget a saved panel before adding another connection.",
          );
        panel = make({ id: randomUUID(), origin, temporary: true });
      }
      try {
        await refresh(panel, true);
        get(panel.id);
        const snapshot = changed();
        return panel.temporary
          ? { ...snapshot, panels: [...snapshot.panels, describe(panel)] }
          : snapshot;
      } catch (cause) {
        await cancelSignIn(panel.id);
        throw cause;
      }
    },
    cancelSignIn,
    async signIn(id, credentials) {
      return authenticate(id, "/api/access/login", {
        email: credentials?.email,
        password: credentials?.password,
      });
    },
    async acceptInvitation(id, credentials) {
      return authenticate(id, "/api/access/accept", {
        token: credentials?.token,
        password: credentials?.password,
      });
    },
    async signOut(id) {
      await initialize();
      const panel = get(id);
      if (panel.pendingLeave) throw failure(409, pendingLeaveMessage);
      const version = ++panel.controls;
      const credential = panel.token;
      panel.authenticating = false;
      panel.pendingTrust?.abort.abort();
      panel.allowPrompt = false;
      forgetSession(panel);
      panel.state = "connected";
      panel.error = "";
      changed();
      await persist();
      await clearLegacy(id);
      if (credential) {
        void json(panel, "/api/access/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          tokenOverride: credential,
        }).catch((cause) => {
          if (
            cause.status !== 401 &&
            version === panel.controls &&
            !panel.token &&
            !panel.removed &&
            !closed
          ) {
            panel.error =
              "Signed out on this computer. The host could not confirm session revocation.";
            changed();
          }
        });
      }
      return changed();
    },
    async retry(id) {
      await initialize();
      const panel = get(id);
      if (panel.pendingLeave) throw failure(409, pendingLeaveMessage);
      await refresh(panel, true);
      return changed();
    },
    async forget(id, expectedAccountId) {
      await initialize();
      const panel = get(id);
      if (panel.temporary || !panel.token || !panel.account)
        throw failure(
          409,
          "Sign in to this panel in Manage Connections before forgetting it. Forget must first remove your account's access on the host.",
        );
      if (
        !text(expectedAccountId, 128) ||
        !expectedAccountId ||
        expectedAccountId !== (panel.account.accountId ?? panel.account.userId)
      )
        throw failure(
          409,
          "The signed-in account changed. Review this panel's current account and confirm Forget again.",
        );
      if (panel.forgetting) return panel.forgetting;
      if (!panel.pendingLeave) {
        panel.controls++;
        panel.authenticating = false;
        panel.pendingTrust?.abort.abort();
        invalidate(panel);
        panel.pendingLeave = { requestId: randomUUID() };
        panel.servers = displayRoster(panel.servers);
        if (selectedServer?.panelId === id) selectedServer = null;
      }
      panel.state = "unavailable";
      panel.error = pendingLeaveMessage;
      changed();
      panel.forgetting = (async () => {
        try {
          // The original bearer and request ID must be durable before the host
          // revokes access, because a lost response may outlive this process.
          await persist();
          panel.allowPrompt = true;
          const receipt = await json(panel, "/api/access/leave", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              confirmed: true,
              requestId: panel.pendingLeave.requestId,
            }),
            tokenOverride: panel.token,
            timeout: 30000,
          });
          if (
            receipt.left !== true ||
            receipt.requestId !== panel.pendingLeave.requestId
          )
            throw failure(
              502,
              "The host did not confirm this access removal request.",
            );
          await clearLegacy(id);
          await panel.network.clearStorageData?.();
          await panel.network.closeAllConnections?.();
          await persist(id);
          panel.removed = true;
          panel.network.setCertificateVerifyProc(null);
          return changed();
        } catch (cause) {
          if (
            cause.remoteResponse &&
            [400, 401, 403, 404, 405, 409].includes(cause.status)
          ) {
            // A complete host rejection proves this request did not leave.
            // Receipts are checked before authentication on the host, so an
            // expired bearer may safely return to the normal sign-in flow.
            const proof = panel.pendingLeave;
            panel.pendingLeave = undefined;
            panel.nextRefresh = Date.now() + pollMs;
            try {
              await persist();
            } catch {
              panel.pendingLeave = proof;
            }
          }
          panel.error =
            cause.status === 404 || cause.status === 405
              ? "This host must be updated before it can confirm panel access removal. Ask the owner to update MC Panel, then try Forget again. The saved connection is retained."
              : !panel.pendingLeave
                ? `The host could not confirm access removal. ${cause.message} Reconnect or sign in in Manage Connections, then try Forget again. The saved connection is retained.`
                : `${pendingLeaveMessage} ${cause.message || "Check the host connection and try again."}`;
          changed();
          throw failure(cause.status ?? 503, panel.error);
        } finally {
          panel.allowPrompt = false;
          panel.forgetting = null;
        }
      })();
      return panel.forgetting;
    },
    async removeSavedConnection(id, expectedEpoch) {
      await initialize();
      const panel = get(id);
      if (panel.pendingLeave) throw failure(409, pendingLeaveMessage);
      if (
        panel.temporary ||
        !text(expectedEpoch, 128) ||
        !expectedEpoch ||
        panel.epoch !== expectedEpoch ||
        panel.token ||
        panel.account ||
        panel.authenticating
      )
        throw failure(
          409,
          "This panel sign-in changed. Only a signed-out saved connection can be removed from this computer.",
        );
      return removeSavedPanel(panel, expectedEpoch);
    },
    async selectServer(panelId, serverId) {
      try {
        await initialize();
      } catch (cause) {
        if (panelId !== "local") throw cause;
        if (
          serverId !== null &&
          !listLocalServers().some((item) => item.id === serverId)
        )
          throw failure(404, "This local server is no longer available.");
        selectedServer = serverId === null ? null : { panelId, serverId };
        return changed();
      }
      ensure();
      if (serverId === null) {
        selectedServer = null;
        await persist();
        return changed();
      }
      const records =
        panelId === "local" ? listLocalServers() : get(panelId).servers;
      if (
        !text(serverId, 128) ||
        !records.some((record) => record.id === serverId)
      )
        throw failure(
          404,
          "This server is no longer available in the selected panel.",
        );
      selectedServer = { panelId, serverId };
      await persist();
      return changed();
    },
    openUpdates() {
      ensure();
      if (!openUpdatesOverlay)
        throw failure(503, "App updates are unavailable.");
      return openUpdatesOverlay(window.webContents);
    },
    async proxy(req, res, id, apiPath) {
      const panel = get(id);
      if (panel.pendingLeave) throw failure(409, pendingLeaveMessage);
      const epoch = panel.epoch;
      const url = new URL(apiPath, panel.origin);
      const rawPath = apiPath.split("?")[0];
      if (
        !apiPath.startsWith("/api/") ||
        !url.pathname.startsWith("/api/") ||
        rawPath.split("/").some((part) => part === "." || part === "..") ||
        url.origin !== panel.origin ||
        apiPath.includes("\\") ||
        /%2f|%5c|%2e/i.test(url.pathname)
      )
        throw failure(400, "Choose a relative panel API path.");
      const epochs = url.searchParams.getAll("desktopEpoch");
      if (epochs.length !== 1 || epochs[0] !== panel.epoch)
        throw failure(
          409,
          "This panel sign-in changed. Reopen the operation before trying again.",
        );
      url.searchParams.delete("desktopEpoch");
      if (panel.temporary || !panel.token || !panel.account)
        throw failure(401, "Sign in to this panel before continuing.");
      if (panel.state !== "connected")
        throw failure(
          503,
          "This panel is offline. Retry its connection before continuing.",
        );
      if (
        /^\/api\/(?:desktop|panel-users)(?:\/|$)/i.test(url.pathname) ||
        /^\/api\/access\/(?:login|accept|logout|leave)\/?$/i.test(url.pathname)
      )
        throw failure(
          403,
          "This operation must use its dedicated panel controls.",
        );
      const ids = url.searchParams.getAll("serverId"),
        header = req.headers["x-server-id"];
      if (
        ids.length > 1 ||
        (header !== undefined &&
          (typeof header !== "string" || (ids.length && header !== ids[0])))
      )
        throw failure(400, "Conflicting server selectors.");
      const serverId = header ?? ids[0];
      const panelRead =
        ["GET", "HEAD"].includes(req.method) &&
        ["/api/servers", "/api/access/session"].includes(url.pathname);
      const setup = /^\/api\/server-(?:setup|import)(?:\/|$)/.test(
        url.pathname,
      );
      if (setup) {
        if (!panel.account.hostPermissions.includes("server.create"))
          throw failure(
            403,
            "The panel owner must grant permission to create or import servers on this computer.",
          );
      } else if (
        !panelRead &&
        (!serverId || !panel.servers.some((server) => server.id === serverId))
      )
        throw failure(
          403,
          "You no longer have access to this server on this panel.",
        );
      if (serverId) url.searchParams.set("serverId", serverId);
      const headers = new Headers();
      for (const name of [
        "content-type",
        "accept",
        "range",
        "if-none-match",
        "if-modified-since",
        "if-range",
      ])
        if (typeof req.headers[name] === "string")
          headers.set(name, req.headers[name]);
      if (serverId) headers.set("X-Server-Id", serverId);
      const abort = new AbortController();
      const disconnect = () => {
        if (!res.writableFinished) abort.abort();
      };
      req.once("aborted", disconnect);
      res.once("close", disconnect);
      let pending;
      try {
        pending = await request(panel, url.pathname + url.search, {
          method: req.method,
          headers,
          signal: abort.signal,
          timeout: 0,
          ...(!["GET", "HEAD"].includes(req.method)
            ? { body: Readable.toWeb(req) }
            : {}),
        });
        const response = pending.response;
        if (response.status === 401) {
          let reason = "Sign in to this panel before continuing.";
          let accessRevoked = false;
          try {
            await readJson(response);
          } catch (cause) {
            if (cause.status === 401) {
              reason = cause.message;
              accessRevoked = cause.accessRevoked === true;
            }
          }
          pending.done();
          pending = null;
          if (panel.epoch !== epoch || panel.removed || closed)
            throw failure(
              409,
              "This panel sign-in changed while the request was running.",
            );
          if (accessRevoked) await removeSavedPanel(panel, epoch);
          else {
            forgetSession(panel);
            await persist();
          }
          changed();
          throw failure(401, reason);
        }
        if (response.status === 403) panel.nextRefresh = 0;
        if (
          response.ok &&
          req.method === "POST" &&
          ["/api/server-setup", "/api/server-import"].includes(url.pathname)
        ) {
          const body = await readJson(response);
          pending.done();
          pending = null;
          // A roster poll begun before registration cannot authorize the newly
          // created server. Drain it, then obtain a genuinely fresh roster.
          await panel.refreshing?.catch(() => {});
          if (panel.epoch === epoch && !panel.removed && !closed)
            await refresh(panel).catch(onError);
          res.statusCode = response.status;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(body));
          return;
        }
        const type =
          response.headers.get("content-type") ?? "application/octet-stream";
        const attachment = /^attachment(?:;|$)/i.test(
          response.headers.get("content-disposition") ?? "",
        );
        if (
          !attachment &&
          !/^(?:application\/json|image\/png|text\/event-stream)(?:;|$)/i.test(
            type,
          ) &&
          ![204, 304].includes(response.status)
        ) {
          await response.body?.cancel();
          throw failure(
            502,
            "The remote API returned an unsafe response type.",
          );
        }
        res.statusCode = response.status;
        res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
        res.setHeader("X-Content-Type-Options", "nosniff");
        for (const name of [
          "content-type",
          "content-disposition",
          "etag",
          "last-modified",
          "accept-ranges",
          "content-range",
        ]) {
          const value = response.headers.get(name);
          if (value !== null) res.setHeader(name, value);
        }
        if (response.body && req.method !== "HEAD")
          await pipeline(Readable.fromWeb(response.body), res);
        else res.end();
      } finally {
        pending?.done();
        req.off("aborted", disconnect);
        res.off("close", disconnect);
      }
    },
    async close() {
      if (closed) return saving;
      closed = true;
      clearInterval(timer);
      for (const panel of panels.values()) {
        panel.pendingTrust?.abort.abort();
        for (const request of panel.requests) request.abort();
      }
      await loaded?.catch(() => {});
      if (ready) await persist();
      else await saving.catch(() => {});
      await store?.close();
      await Promise.allSettled(
        [...panels.values()].map(async (panel) => {
          panel.network.setCertificateVerifyProc(null);
          await panel.network.closeAllConnections?.();
        }),
      );
    },
  };
  async function authenticate(id, pathname, credentials) {
    await initialize();
    const panel = get(id);
    if (panel.pendingLeave) throw failure(409, pendingLeaveMessage);
    if (
      !text(credentials.password, 4096) ||
      (pathname.endsWith("login")
        ? !text(credentials.email, 256)
        : !validToken(credentials.token))
    )
      throw failure(400, "Provide valid sign-in details.");
    const version = ++panel.controls;
    // Failed credentials must not end the still-valid account lease/drafts.
    // Pause only roster discovery; successful replacement rotates the lease.
    panel.authenticating = version;
    try {
      await panel.refreshing?.catch(() => {});
      if (
        closed ||
        panel.removed ||
        panel.removing ||
        version !== panel.controls
      )
        throw failure(409, "This panel sign-in changed.");
      panel.allowPrompt = true;
      const result = await json(panel, pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
        timeout: 30000,
      });
      if (version !== panel.controls || panel.removed || closed)
        throw failure(409, "This panel sign-in changed.");
      if (!validToken(result.sessionToken))
        throw failure(
          502,
          "Update the remote host to use secure desktop sign-in.",
        );
      const account = sessionRecord(result);
      panel.token = result.sessionToken;
      panel.account = account;
      panel.servers = [];
      invalidate(panel);
      if (panel.temporary) {
        panel.promoting = persist(undefined, panel);
        try {
          await panel.promoting;
        } catch (cause) {
          forgetSession(panel);
          throw cause;
        } finally {
          panel.promoting = null;
        }
      } else await persist();
    } finally {
      if (panel.authenticating === version) {
        panel.allowPrompt = false;
        panel.authenticating = false;
      }
    }
    try {
      await refresh(panel, true);
    } catch (cause) {
      // Authentication is already saved. A later roster outage belongs on the
      // saved connection, rather than telling the form that sign-in failed.
      if (
        panel.removed ||
        !panel.token ||
        !panel.account ||
        panel.state !== "unavailable"
      )
        throw cause;
    }
    return changed();
  }
  return controller;
}
