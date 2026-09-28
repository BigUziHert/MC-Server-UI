import { normalizePanelConnectionUrl } from "./panel-connection.mjs";

export const browserConnectionsKey = "mc-panel.browser-connections.v1";
const fail = (status, message) => Object.assign(new Error(message), { status });
const validToken = (value) =>
  typeof value === "string" && /^[\w-]{43}$/.test(value);
const text = (value, length = 256) =>
  typeof value === "string" && value.length > 0 && value.length <= length;
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const pendingMessage =
  "Forget is not complete. Use Retry Forget to confirm access removal; the saved connection and retry proof are retained.";
const stringList = (value) =>
  Array.isArray(value)
    ? value.filter((item) => text(item, 128)).slice(0, 100)
    : [];

export function browserSession(value) {
  if (
    value?.role !== "subuser" ||
    !text(value.email) ||
    !text(value.userId, 128)
  )
    throw fail(502, "The host returned an invalid account session.");
  return {
    role: "subuser",
    email: value.email,
    userId: value.userId,
    ...(text(value.accountId, 128) ? { accountId: value.accountId } : {}),
    serverId: text(value.serverId, 128) ? value.serverId : null,
    permissions: stringList(value.permissions),
    hostPermissions: stringList(value.hostPermissions),
  };
}
export function browserRoster(value, live = false) {
  if (!Array.isArray(value) || value.length > 500)
    throw fail(502, "The host returned an invalid server list.");
  const seen = new Set();
  return value.flatMap((item) => {
    if (
      !text(item?.id, 128) ||
      !text(item.name, 180) ||
      (live && !text(item.status, 32)) ||
      seen.has(item.id)
    )
      return [];
    seen.add(item.id);
    return [
      {
        id: item.id,
        name: item.name,
        status: live && text(item.status, 32) ? item.status : "unavailable",
        ...(text(item.software, 128) ? { software: item.software } : {}),
        ...(text(item.minecraftVersion, 128)
          ? { minecraftVersion: item.minecraftVersion }
          : {}),
        ...(live
          ? { ...item, accessPermissions: stringList(item.accessPermissions) }
          : {}),
      },
    ];
  });
}
const identity = (session) => {
  if (!session) return undefined;
  const {
    permissions: _permissions,
    hostPermissions: _host,
    ...result
  } = browserSession(session);
  return result;
};
function originOf(input, home) {
  if (
    typeof input !== "string" ||
    input.length > 2048 ||
    !/^https?:\/\//i.test(input.trim())
  )
    throw fail(400, "Enter a complete HTTPS panel address.");
  const parsed = new URL(input, home);
  if (
    parsed.origin === home &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname === "/" &&
    !parsed.search &&
    (!parsed.hash || /^#invite=[\w-]{43}$/.test(parsed.hash))
  )
    return home;
  return new URL(normalizePanelConnectionUrl(input)).origin;
}
function decodeSnapshot(raw, home) {
  if (raw === null)
    return {
      version: 1,
      revision: 0,
      homeBootstrapped: false,
      panels: [],
      selectedServer: null,
    };
  if (raw.length > 4 * 1024 * 1024)
    throw fail(503, "Saved browser connections are too large to read safely.");
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    throw fail(
      503,
      "Saved browser connections could not be read. Existing data was preserved.",
    );
  }
  if (
    saved?.version !== 1 ||
    !Number.isSafeInteger(saved.revision) ||
    saved.revision < 0 ||
    !Array.isArray(saved.panels) ||
    saved.panels.length > 50
  )
    throw fail(
      503,
      "Saved browser connections are invalid. Existing data was preserved.",
    );
  const ids = new Set(),
    origins = new Set();
  const panels = saved.panels.map((item) => {
    if (
      !uuid(item?.id) ||
      !uuid(item.epoch) ||
      ids.has(item.id) ||
      typeof item.origin !== "string" ||
      originOf(item.origin, home) !== item.origin ||
      origins.has(item.origin)
    )
      throw fail(503, "Saved browser connection addresses are invalid.");
    ids.add(item.id);
    origins.add(item.origin);
    if (item.token !== null && !validToken(item.token))
      throw fail(503, "A saved browser credential is invalid.");
    if (item.revocationToken !== undefined && !validToken(item.revocationToken))
      throw fail(503, "A saved browser access-status proof is invalid.");
    if (
      item.pendingLeave !== undefined &&
      (!item.token || !uuid(item.pendingLeave?.requestId))
    )
      throw fail(503, "A saved access-removal proof is invalid.");
    const session = item.token ? identity(item.session) : undefined;
    if (item.token && !session)
      throw fail(503, "A saved browser account is invalid.");
    return {
      id: item.id,
      epoch: item.epoch,
      origin: item.origin,
      token: item.token,
      ...(item.revocationToken
        ? { revocationToken: item.revocationToken }
        : {}),
      ...(session ? { session } : {}),
      servers: session ? browserRoster(item.servers ?? []) : [],
      ...(item.pendingLeave
        ? { pendingLeave: { requestId: item.pendingLeave.requestId } }
        : {}),
    };
  });
  const selected = saved.selectedServer;
  const selectedServer =
    selected &&
    text(selected.panelId, 128) &&
    text(selected.serverId, 128) &&
    (selected.panelId === "local" ||
      panels.some(
        (item) =>
          item.id === selected.panelId &&
          item.token &&
          item.servers.some((server) => server.id === selected.serverId),
      ))
      ? { panelId: selected.panelId, serverId: selected.serverId }
      : null;
  if (
    saved.homeBootstrapped !== undefined &&
    typeof saved.homeBootstrapped !== "boolean"
  )
    throw fail(503, "Saved browser initialization state is invalid.");
  return {
    version: 1,
    revision: saved.revision,
    homeBootstrapped:
      saved.homeBootstrapped === true ||
      panels.some((panel) => panel.origin === home),
    panels,
    selectedServer,
  };
}
function relativeApi(pathname, origin) {
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("/api/") ||
    pathname.includes("\\") ||
    /%2f|%5c|%2e/i.test(pathname.split("?")[0]) ||
    pathname
      .split("?")[0]
      .split("/")
      .some((part) => part === "." || part === "..")
  )
    throw fail(400, "Choose a relative panel API path.");
  const url = new URL(pathname, origin);
  if (url.origin !== origin || url.hash || !url.pathname.startsWith("/api/"))
    throw fail(400, "Choose a relative panel API path.");
  return url;
}
async function readJson(response) {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    throw fail(502, "The host did not return a panel API response.");
  }
  const reader = response.body?.getReader(),
    chunks = [];
  let size = 0;
  try {
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024)
          throw fail(502, "The host response is too large.");
        chunks.push(value);
      }
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw fail(502, "The host returned invalid JSON.");
  }
  if (!response.ok)
    throw Object.assign(
      fail(
        response.status,
        typeof body?.error === "string"
          ? body.error
          : "The remote request failed.",
      ),
      { remoteResponse: true, accessRevoked: body?.accessRevoked === true },
    );
  return body;
}

/** Web-platform-only controller; adapters supply storage, fetch and cross-tab locking. */
export function createBrowserConnectionController({
  origin,
  storage,
  fetch: fetcher,
  legacyToken = () => null,
  legacySelection = () => null,
  homeCredential = () => {},
  changed = () => {},
  newId = () => crypto.randomUUID(),
  lock = (operation) => operation(),
  pollMs = 5000,
}) {
  const home = new URL(origin).origin,
    panels = new Map(),
    drafts = new Map();
  let snapshot = {
      version: 1,
      revision: 0,
      homeBootstrapped: false,
      panels: [],
      selectedServer: null,
    },
    ready = false,
    closed = false,
    owner = false,
    error = "",
    writing = Promise.resolve(),
    initializing,
    timer;
  let attemptEpoch = 0;
  let appliedRaw = null;
  const current = (panel, epoch) =>
    !closed &&
    !panel.removed &&
    !panel.removing &&
    (panels.get(panel.id) === panel || drafts.get(panel.id) === panel) &&
    panel.epoch === epoch;
  const requireCurrent = (panel, epoch) => {
    if (!current(panel, epoch))
      throw fail(
        409,
        "This panel sign-in changed while the request was running.",
      );
  };
  const invalidate = (panel) => {
    for (const request of panel.requests) request.abort();
    panel.requests.clear();
  };
  const apply = (next, raw) => {
    for (const draft of drafts.values())
      if (next.panels.some((panel) => panel.origin === draft.origin)) {
        draft.removed = true;
        invalidate(draft);
        drafts.delete(draft.id);
      }
    const keep = new Set(next.panels.map((item) => item.id));
    for (const panel of panels.values())
      if (!keep.has(panel.id)) {
        panel.removed = true;
        invalidate(panel);
        panels.delete(panel.id);
      }
    for (const item of next.panels) {
      let panel = panels.get(item.id);
      if (
        !panel ||
        panel.epoch !== item.epoch ||
        panel.token !== item.token ||
        panel.origin !== item.origin
      ) {
        if (panel) {
          panel.removed = true;
          invalidate(panel);
        }
        panel = {
          ...item,
          account: item.session ? browserSession(item.session) : undefined,
          servers: browserRoster(item.servers),
          requests: new Set(),
          state: "unavailable",
          nextRefresh: 0,
          controls: 0,
        };
        panels.set(item.id, panel);
      } else {
        panel.pendingLeave = item.pendingLeave;
        panel.revocationToken = item.revocationToken;
        if (panel.state !== "connected")
          panel.servers = browserRoster(item.servers);
      }
      if (panel.pendingLeave) {
        panel.state = "unavailable";
        panel.error = pendingMessage;
      }
    }
    snapshot = next;
    appliedRaw = raw;
  };
  const sync = () => {
    const raw = storage.getItem(browserConnectionsKey);
    if (raw !== appliedRaw) {
      apply(decodeSnapshot(raw, home), raw);
      changed();
    }
  };
  const commit = (update, expected) => {
    const operation = writing
      .catch(() => {})
      .then(() =>
        lock(async () => {
          if (closed) throw fail(503, "Browser connections are closed.");
          sync();
          if (expected) requireCurrent(expected.panel, expected.epoch);
          if (
            expected?.operation !== undefined &&
            expected.panel.controls !== expected.operation
          )
            throw fail(409, "This panel sign-in changed.");
          const next = structuredClone(snapshot);
          update(next);
          next.revision++;
          const raw = JSON.stringify(next);
          if (raw.length > 4 * 1024 * 1024)
            throw fail(
              503,
              "Saved browser connections exceed available storage. Remove an unused connection.",
            );
          try {
            storage.setItem(browserConnectionsKey, raw);
          } catch {
            throw fail(
              503,
              "Browser connections could not be saved. Check this site's storage permissions and available space.",
            );
          }
          apply(decodeSnapshot(raw, home), raw);
          changed();
        }),
      );
    writing = operation;
    return operation;
  };
  const get = (id) => {
    sync();
    const panel = panels.get(id) ?? drafts.get(id);
    if (!panel || panel.removed || panel.removing || closed)
      throw fail(404, "This saved panel is no longer available.");
    return panel;
  };
  const updateRecord = (next, id) => {
    const entry = next.panels.find((item) => item.id === id);
    if (!entry) throw fail(404, "This saved panel is no longer available.");
    return entry;
  };
  const describe = (panel) => ({
    id: panel.id,
    origin: panel.origin,
    label: new URL(panel.origin).host,
    local: false,
    signedIn: Boolean(panel.token && panel.account),
    session: panel.account,
    sessionEpoch: panel.epoch,
    pendingLeave: Boolean(panel.pendingLeave),
    connectionState: panel.temporary ? "connecting" : panel.state,
    servers: panel.servers,
    ...(panel.temporary ? { temporary: true } : {}),
    ...(panel.error ? { error: panel.error } : {}),
  });
  const list = () => ({
    runtime: "browser",
    unified: true,
    ready,
    ...(error ? { error } : {}),
    selectedServer: snapshot.selectedServer,
    activeId:
      snapshot.selectedServer?.panelId ??
      (owner ? "local" : panels.values().next().value?.id),
    localServers: [],
    panels: [
      ...(owner
        ? [
            {
              id: "local",
              label: "This computer",
              origin: home,
              local: true,
              signedIn: true,
              connectionState: "connected",
              sessionEpoch: "local",
              servers: [],
            },
          ]
        : []),
      ...[...panels.values()].map(describe),
    ],
  });
  async function remove(panel, epoch) {
    if (panel.pendingLeave) throw fail(409, pendingMessage);
    requireCurrent(panel, epoch);
    panel.removing = true;
    invalidate(panel);
    try {
      await commit((next) => {
        const entry = updateRecord(next, panel.id);
        if (entry.epoch !== epoch || entry.pendingLeave)
          throw fail(409, "This panel sign-in changed.");
        next.panels = next.panels.filter((item) => item.id !== panel.id);
        if (next.selectedServer?.panelId === panel.id)
          next.selectedServer = null;
      });
      if (panel.origin === home) homeCredential(null);
    } catch (cause) {
      panel.removing = false;
      panel.state = "unavailable";
      panel.error = cause.message;
      changed();
      throw cause;
    }
    return list();
  }
  async function clearSignIn(panel, epoch) {
    if (panel.pendingLeave) throw fail(409, pendingMessage);
    await commit(
      (next) => {
        const entry = updateRecord(next, panel.id);
        entry.token = null;
        delete entry.session;
        entry.servers = [];
        entry.epoch = newId();
        if (next.selectedServer?.panelId === panel.id)
          next.selectedServer = null;
      },
      { panel, epoch },
    );
    if (panel.origin === home) homeCredential(null);
  }
  async function signedOutRevocation(panel, epoch) {
    if (!current(panel, epoch) || panel.token) return;
    if (panel.authenticating) {
      panel.revokedEpoch = epoch;
      return;
    }
    await remove(panel, epoch);
  }
  async function finishDeferredRevocation(panel) {
    if (panel.revokedEpoch === undefined) return;
    if (!current(panel, panel.revokedEpoch) || panel.token) {
      panel.revokedEpoch = undefined;
      return;
    }
    if (!panel.authenticating) await remove(panel, panel.revokedEpoch);
  }
  async function promoteHomeOwner(panel, epoch) {
    if (panel.origin !== home)
      throw fail(502, "A remote panel cannot grant local owner access.");
    requireCurrent(panel, epoch);
    // This only consolidates the browser's representation of its own host.
    // An outstanding host leave operation must retain its durable retry proof.
    if (panel.temporary) {
      panel.removed = true;
      invalidate(panel);
      drafts.delete(panel.id);
    } else if (!panel.pendingLeave) {
      await commit(
        (next) => {
          const entry = updateRecord(next, panel.id);
          if (entry.pendingLeave) throw fail(409, pendingMessage);
          next.homeBootstrapped = true;
          next.panels = next.panels.filter((item) => item.id !== panel.id);
          if (next.selectedServer?.panelId === panel.id)
            next.selectedServer.panelId = "local";
        },
        { panel, epoch },
      );
      if (panel.token && legacyToken() === panel.token) homeCredential(null);
    }
    owner = true;
    changed();
  }
  async function request(
    panel,
    pathname,
    options = {},
    timeout = 10000,
    homeSessionProbe = false,
  ) {
    sync();
    const epoch = panel.epoch;
    requireCurrent(panel, epoch);
    const url = relativeApi(pathname, panel.origin),
      abort = new AbortController();
    panel.requests.add(abort);
    const timer = timeout
      ? setTimeout(
          () => abort.abort(fail(504, "The panel did not respond.")),
          timeout,
        )
      : undefined;
    const done = () => {
      clearTimeout(timer);
      panel.requests.delete(abort);
    };
    const headers = new Headers(options.headers);
    for (const name of ["Authorization", "Cookie", "Host", "Origin"])
      headers.delete(name);
    const token = options.tokenOverride ?? panel.token;
    if (token) headers.set("Authorization", `Bearer ${token}`);
    headers.set("X-MC-Panel-Client", "browser");
    const { tokenOverride: _token, ...init } = options;
    try {
      const response = await fetcher(url.href, {
        ...init,
        ...(init.body instanceof ReadableStream ? { duplex: "half" } : {}),
        headers,
        credentials:
          homeSessionProbe &&
          panel.origin === home &&
          pathname === "/api/access/session" &&
          !token
            ? "same-origin"
            : "omit",
        redirect: "error",
        signal: options.signal
          ? AbortSignal.any([options.signal, abort.signal])
          : abort.signal,
      });
      sync();
      requireCurrent(panel, epoch);
      if (!response.body) {
        done();
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(control) {
          try {
            requireCurrent(panel, epoch);
            const item = await reader.read();
            requireCurrent(panel, epoch);
            if (item.done) {
              done();
              reader.releaseLock();
              control.close();
            } else control.enqueue(item.value);
          } catch (cause) {
            done();
            await reader.cancel().catch(() => {});
            control.error(cause);
          }
        },
        async cancel(reason) {
          abort.abort(reason);
          done();
          await reader.cancel(reason).catch(() => {});
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (cause) {
      done();
      throw cause;
    }
  }
  const json = async (panel, pathname, options, timeout, homeSessionProbe) => {
    const epoch = panel.epoch;
    const result = await readJson(
      await request(panel, pathname, options, timeout, homeSessionProbe),
    );
    sync();
    requireCurrent(panel, epoch);
    return result;
  };
  async function refresh(panel) {
    if (
      panel.pendingLeave ||
      panel.removing ||
      panel.authenticating ||
      panel.removed
    )
      return;
    if (panel.refreshing) return panel.refreshing;
    let epoch = panel.epoch;
    panel.refreshing = (async () => {
      try {
        const account = await json(
          panel,
          "/api/access/session",
          undefined,
          undefined,
          true,
        );
        requireCurrent(panel, epoch);
        if (account.role === "owner") {
          await promoteHomeOwner(panel, epoch);
          return;
        }
        if (account.role !== "subuser") {
          if (account.role !== "guest")
            throw fail(502, "The host returned an invalid account session.");
          if (
            account.role === "guest" &&
            account.accessRevoked === true &&
            panel.token
          ) {
            await remove(panel, epoch);
            return;
          }
          if (panel.token) {
            await clearSignIn(panel, epoch);
            panel = get(panel.id);
            epoch = panel.epoch;
            panel.nextRefresh = Date.now() + pollMs;
          }
          if (panel.revocationToken) {
            const status = await json(panel, "/api/access/status", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: panel.revocationToken }),
              tokenOverride: "",
            });
            requireCurrent(panel, epoch);
            if (status.accessRevoked === true) {
              await signedOutRevocation(panel, epoch);
              return;
            }
          }
          panel.state = "connected";
          panel.error = "";
          panel.nextRefresh = Date.now() + pollMs;
          return;
        }
        if (panel.temporary)
          throw fail(502, "Sign in to verify your account on this panel.");
        const session = browserSession(account),
          fleet = await json(panel, "/api/servers");
        requireCurrent(panel, epoch);
        const servers = browserRoster(fleet.servers, true);
        await commit(
          (next) => {
            const entry = updateRecord(next, panel.id);
            entry.session = identity(session);
            entry.servers = browserRoster(servers);
            if (
              next.selectedServer?.panelId === panel.id &&
              !servers.some((item) => item.id === next.selectedServer.serverId)
            )
              next.selectedServer = null;
          },
          { panel, epoch },
        );
        panel.account = {
          ...session,
          hostPermissions: stringList(
            fleet.hostPermissions ?? session.hostPermissions,
          ),
        };
        panel.servers = servers;
        panel.state = "connected";
        panel.error = "";
        panel.nextRefresh = Date.now() + pollMs;
        if (panel.origin === home) homeCredential(panel.token);
      } catch (cause) {
        if (!current(panel, epoch)) return;
        if (cause.status === 401 && !panel.pendingLeave && !panel.temporary) {
          if (cause.accessRevoked === true && panel.token) {
            await remove(panel, epoch);
            return;
          }
          await clearSignIn(panel, epoch);
          panel = get(panel.id);
        }
        panel.state = "unavailable";
        panel.servers = browserRoster(panel.servers);
        panel.error =
          cause.message ||
          "The panel is unavailable. Check its address, certificate and connection.";
        panel.nextRefresh = Date.now() + 30000;
      } finally {
        panel.refreshing = null;
        changed();
      }
    })();
    return panel.refreshing;
  }
  async function initialize() {
    if (initializing) return initializing;
    initializing = (async () => {
      let homeSession, probeToken;
      try {
        const token = legacyToken(),
          headers = new Headers({ "X-MC-Panel-Client": "browser" });
        probeToken = token;
        if (validToken(token)) headers.set("Authorization", `Bearer ${token}`);
        homeSession = await readJson(
          await fetcher(`${home}/api/access/session`, {
            headers,
            credentials: token ? "omit" : "same-origin",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          }),
        );
        if (!["owner", "subuser", "guest"].includes(homeSession?.role))
          throw fail(502, "The host returned an invalid account session.");
        owner = homeSession.role === "owner";
      } catch {
        homeSession = undefined;
        /* An unavailable home must not hide other saved panels. */
      }
      try {
        const raw = storage.getItem(browserConnectionsKey);
        apply(decodeSnapshot(raw, home), raw);
        ready = true;
        if (
          homeSession?.role === "guest" &&
          homeSession.accessRevoked === true &&
          validToken(probeToken)
        ) {
          await commit((next) => {
            next.homeBootstrapped = true;
            const revoked = next.panels.find(
              (panel) =>
                panel.origin === home &&
                panel.token === probeToken &&
                !panel.pendingLeave,
            );
            if (!revoked) return;
            next.panels = next.panels.filter((panel) => panel !== revoked);
            if (next.selectedServer?.panelId === revoked.id)
              next.selectedServer = null;
          });
          if (
            legacyToken() === probeToken &&
            ![...panels.values()].some(
              (panel) =>
                panel.origin === home &&
                panel.token === probeToken &&
                panel.pendingLeave,
            )
          )
            homeCredential(null);
        }
        if (owner) {
          const homePanel = [...panels.values()].find(
            (panel) => panel.origin === home,
          );
          if (homePanel) await promoteHomeOwner(homePanel, homePanel.epoch);
          if (raw === null) {
            let serverId = null;
            const preferred = legacySelection();
            if (text(preferred, 128)) {
              try {
                const headers = new Headers({ "X-MC-Panel-Client": "browser" });
                if (validToken(probeToken))
                  headers.set("Authorization", `Bearer ${probeToken}`);
                const fleet = await readJson(
                  await fetcher(`${home}/api/servers`, {
                    headers,
                    credentials: probeToken ? "omit" : "same-origin",
                    redirect: "error",
                    signal: AbortSignal.timeout(10000),
                  }),
                );
                const servers = browserRoster(fleet.servers, true);
                serverId =
                  servers.find((server) => server.id === preferred)?.id ??
                  servers.find((server) => server.id === fleet.defaultServerId)
                    ?.id ??
                  servers[0]?.id ??
                  null;
              } catch {
                /* The live workspace will choose after its roster recovers. */
              }
            }
            await commit((next) => {
              // Another tab may have established an authoritative selection
              // while the first owner roster request was in flight.
              if (next.revision !== 0) return;
              next.homeBootstrapped = true;
              if (serverId)
                next.selectedServer = { panelId: "local", serverId };
            });
          }
        } else if (
          (!snapshot.homeBootstrapped ||
            (!homeSession && snapshot.selectedServer?.panelId === "local")) &&
          ![...panels.values()].some((panel) => panel.origin === home)
        ) {
          const token = legacyToken(),
            session =
              homeSession?.role === "subuser" && validToken(token)
                ? browserSession(homeSession)
                : undefined;
          await commit((next) => {
            if (
              (next.homeBootstrapped &&
                !(!homeSession && next.selectedServer?.panelId === "local")) ||
              next.panels.some((panel) => panel.origin === home)
            )
              return;
            next.homeBootstrapped = true;
            if (next.panels.length >= 50) return;
            // Merely visiting a panel or opening its invitation must not save
            // an anonymous connection. Retain recovery for a previously known
            // owner selection or legacy credential only.
            if (
              !session &&
              !validToken(token) &&
              next.selectedServer?.panelId !== "local"
            )
              return;
            next.panels.push({
              id: newId(),
              origin: home,
              epoch: newId(),
              token: session ? token : null,
              ...(session ? { session: identity(session) } : {}),
              servers: [],
            });
          });
        }
        if (
          !owner &&
          homeSession &&
          snapshot.selectedServer?.panelId === "local"
        )
          await commit((next) => {
            if (next.selectedServer?.panelId === "local")
              next.selectedServer = null;
          });
        // One saved offline host must not delay mounting the whole workspace.
        // Restored rows are display-only until their own live refresh completes.
        void Promise.allSettled(
          [...panels.values()].map((panel) => refresh(panel)),
        );
      } catch (cause) {
        ready = false;
        error = cause.message;
      }
      timer = setInterval(
        () => {
          if (!closed && ready)
            for (const panel of panels.values())
              if (Date.now() >= (panel.nextRefresh ?? 0))
                void refresh(panel).catch(() => {});
          // Refresh deadlines start when a response completes. A wake interval
          // equal to pollMs can miss that deadline by network latency and double
          // the effective polling period. Keep each host's deadline, but check
          // often enough to begin within one second after it becomes due.
        },
        Math.min(pollMs, 1000),
      );
      timer.unref?.();
      changed();
      return list();
    })();
    return initializing;
  }
  async function authenticate(id, pathname, input) {
    const openingEpoch = attemptEpoch;
    await initialize();
    if (openingEpoch !== attemptEpoch)
      throw fail(409, "This panel sign-in changed.");
    const panel = get(id),
      epoch = panel.epoch;
    if (panel.pendingLeave) throw fail(409, pendingMessage);
    if (panel.authenticating || panel.previewing)
      throw fail(409, "A sign-in attempt is already running for this panel.");
    const operation = ++panel.controls;
    const abort = new AbortController();
    panel.authenticating = operation;
    panel.authAbort = abort;
    try {
      await panel.refreshing;
      requireCurrent(panel, epoch);
      if (operation !== panel.controls)
        throw fail(409, "This panel sign-in changed.");
      const result = await json(
        panel,
        pathname,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          tokenOverride: "",
          signal: abort.signal,
        },
        30000,
      );
      requireCurrent(panel, epoch);
      if (operation !== panel.controls)
        throw fail(409, "This panel sign-in changed.");
      if (!validToken(result.sessionToken))
        throw fail(502, "The host returned an invalid sign-in credential.");
      if (
        result.revocationToken !== undefined &&
        !validToken(result.revocationToken)
      )
        throw fail(502, "The host returned an invalid access-status proof.");
      const session = browserSession(result);
      await commit(
        (next) => {
          let entry;
          if (panel.temporary) {
            if (next.panels.some((item) => item.origin === panel.origin))
              throw fail(
                409,
                "This panel was saved in another tab. Use its saved connection to sign in.",
              );
            if (next.panels.length >= 50)
              throw fail(
                409,
                "Remove a saved panel before adding another connection.",
              );
            entry = { id, origin: panel.origin };
            next.panels.push(entry);
          } else entry = updateRecord(next, id);
          entry.token = result.sessionToken;
          if (result.revocationToken)
            entry.revocationToken = result.revocationToken;
          else delete entry.revocationToken;
          entry.session = identity(session);
          entry.epoch = newId();
          entry.servers = [];
        },
        { panel, epoch, operation },
      );
      if (panel.origin === home) homeCredential(result.sessionToken);
    } finally {
      if (panel.controls === operation) {
        panel.authenticating = false;
        panel.authAbort = undefined;
      }
      await finishDeferredRevocation(panel).catch(() => {});
    }
    await refresh(get(id));
    return list();
  }
  const bridge = {
    runtime: "browser",
    unified: true,
    async list() {
      await initialize();
      if (ready) sync();
      return list();
    },
    async open(input) {
      const openingEpoch = attemptEpoch;
      await initialize();
      if (openingEpoch !== attemptEpoch)
        throw fail(409, "This panel sign-in changed.");
      if (!ready) throw fail(503, error);
      sync();
      const target = originOf(input, home);
      let panel = [...panels.values()].find((item) => item.origin === target);
      if (!panel) {
        if (panels.size >= 50 || drafts.size >= 50)
          throw fail(
            409,
            "Close an unfinished sign-in or remove a saved panel before adding another connection.",
          );
        panel = {
          id: newId(),
          origin: target,
          epoch: newId(),
          token: null,
          servers: [],
          requests: new Set(),
          state: "unavailable",
          nextRefresh: 0,
          controls: 0,
          temporary: true,
        };
        drafts.set(panel.id, panel);
      }
      try {
        await refresh(panel);
      } catch (cause) {
        if (panel.temporary) await bridge.cancelSignIn(panel.id);
        throw cause;
      }
      if (panel.temporary) {
        if (panel.removed || !drafts.has(panel.id)) {
          if (owner && target === home)
            return { ...list(), openedPanelId: "local" };
          throw fail(
            409,
            "This panel sign-in changed while the address was being verified.",
          );
        }
        if (panel.state !== "connected") {
          await bridge.cancelSignIn(panel.id);
          throw fail(
            502,
            panel.error ||
              "The panel is unavailable. Check its address and try again.",
          );
        }
        const result = list();
        return {
          ...result,
          openedPanelId: panel.id,
          panels: [...result.panels, describe(panel)],
        };
      }
      return { ...list(), openedPanelId: panel.id };
    },
    async cancelSignIn(id) {
      const panel = drafts.get(id) ?? panels.get(id);
      if (!panel) return;
      if (!panel.temporary) {
        if (panel.authenticating || panel.previewing) {
          panel.controls++;
          panel.authAbort?.abort();
          panel.authenticating = false;
          panel.previewing = false;
        }
        await finishDeferredRevocation(panel);
        return;
      }
      panel.removed = true;
      panel.controls++;
      invalidate(panel);
      drafts.delete(id);
    },
    async invitation(id, credentials) {
      const openingEpoch = attemptEpoch;
      await initialize();
      if (openingEpoch !== attemptEpoch)
        throw fail(409, "This panel sign-in changed.");
      const panel = get(id),
        epoch = panel.epoch;
      if (panel.pendingLeave) throw fail(409, pendingMessage);
      if (!validToken(credentials?.token))
        throw fail(400, "Provide a valid invitation.");
      if (panel.authenticating || panel.previewing)
        throw fail(409, "A sign-in attempt is already running for this panel.");
      const operation = ++panel.controls,
        abort = new AbortController();
      panel.previewing = operation;
      panel.authAbort = abort;
      try {
        const result = await json(panel, "/api/access/invitation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: credentials.token }),
          tokenOverride: "",
          signal: abort.signal,
        });
        requireCurrent(panel, epoch);
        if (operation !== panel.controls)
          throw fail(409, "This panel sign-in changed.");
        if (
          !text(result.email) ||
          !Number.isFinite(Date.parse(result.inviteExpiresAt))
        )
          throw fail(502, "The host returned an invalid invitation.");
        return {
          email: result.email,
          panelAddress: panel.origin,
          inviteExpiresAt: result.inviteExpiresAt,
        };
      } finally {
        if (panel.previewing === operation) {
          panel.previewing = false;
          panel.authAbort = undefined;
        }
      }
    },
    signIn: (id, credentials) =>
      authenticate(id, "/api/access/login", {
        email: credentials?.email,
        password: credentials?.password,
      }),
    acceptInvitation: (id, credentials) =>
      authenticate(id, "/api/access/accept", {
        token: credentials?.token,
        password: credentials?.password,
      }),
    async signOut(id) {
      await initialize();
      const panel = get(id),
        epoch = panel.epoch;
      if (panel.signingOut) return panel.signingOut;
      panel.signingOut = (async () => {
        if (panel.pendingLeave) throw fail(409, pendingMessage);
        panel.controls++;
        const token = panel.token;
        await clearSignIn(panel, epoch);
        if (token) {
          const signedOut = get(id),
            signedOutEpoch = signedOut.epoch;
          void json(signedOut, "/api/access/logout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            tokenOverride: token,
          })
            .then(async (result) => {
              if (
                !current(signedOut, signedOutEpoch) ||
                signedOut.token ||
                signedOut.pendingLeave
              )
                return;
              if (result.accessRevoked === true)
                await signedOutRevocation(signedOut, signedOutEpoch);
              else if (validToken(result.revocationToken))
                await commit(
                  (next) => {
                    updateRecord(next, id).revocationToken =
                      result.revocationToken;
                  },
                  { panel: signedOut, epoch: signedOutEpoch },
                );
            })
            .catch(() => {});
        }
        return list();
      })().finally(() => {
        panel.signingOut = null;
      });
      return panel.signingOut;
    },
    async retry(id) {
      await initialize();
      const panel = get(id);
      if (panel.pendingLeave) throw fail(409, pendingMessage);
      await refresh(panel);
      return list();
    },
    async removeSavedConnection(id, epoch) {
      await initialize();
      const panel = get(id);
      if (panel.token || panel.account || panel.authenticating)
        throw fail(409, "Sign out before removing this saved connection.");
      return remove(panel, epoch);
    },
    async forget(id, accountId) {
      await initialize();
      let panel = get(id);
      if (
        !panel.token ||
        !panel.account ||
        accountId !== (panel.account.accountId ?? panel.account.userId)
      )
        throw fail(
          409,
          "The account changed. Review this connection before confirming Forget.",
        );
      if (panel.forgetting) return panel.forgetting;
      if (!panel.pendingLeave) {
        const epoch = panel.epoch;
        await commit(
          (next) => {
            const entry = updateRecord(next, id);
            entry.pendingLeave = { requestId: newId() };
            entry.epoch = newId();
            if (next.selectedServer?.panelId === id) next.selectedServer = null;
          },
          { panel, epoch },
        );
        panel = get(id);
      }
      const epoch = panel.epoch,
        proof = panel.pendingLeave.requestId;
      panel.forgetting = (async () => {
        try {
          const result = await json(
            panel,
            "/api/access/leave",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ confirmed: true, requestId: proof }),
            },
            30000,
          );
          requireCurrent(panel, epoch);
          if (result.left !== true || result.requestId !== proof)
            throw fail(
              502,
              "The host did not confirm this access-removal request.",
            );
          await commit(
            (next) => {
              next.panels = next.panels.filter((item) => item.id !== id);
              if (next.selectedServer?.panelId === id)
                next.selectedServer = null;
            },
            { panel, epoch },
          );
          if (panel.origin === home) homeCredential(null);
          return list();
        } catch (cause) {
          if (current(panel, epoch)) {
            if (
              cause.remoteResponse &&
              [400, 401, 403, 404, 405, 409].includes(cause.status)
            ) {
              // These complete host rejections occur before its leave commit;
              // a lost reply or local write failure retains the durable proof.
              try {
                await commit(
                  (next) => {
                    delete updateRecord(next, id).pendingLeave;
                  },
                  { panel, epoch },
                );
                panel.nextRefresh = Date.now() + pollMs;
              } catch {
                /* Preserve the prior saved proof if clearing it fails. */
              }
            }
            panel.state = "unavailable";
            panel.error = panel.pendingLeave
              ? `${pendingMessage} ${cause.message}`
              : `The host could not confirm access removal. ${cause.message} Reconnect or sign in, then try Forget again. The saved connection is retained.`;
            changed();
          }
          throw cause;
        } finally {
          panel.forgetting = null;
        }
      })();
      return panel.forgetting;
    },
    async selectServer(panelId, serverId) {
      await initialize();
      if (panelId === "local") {
        if (!owner) throw fail(403, "This browser has no local owner panel.");
      } else {
        const panel = get(panelId);
        if (
          panel.pendingLeave ||
          panel.state !== "connected" ||
          !panel.token ||
          (serverId && !panel.servers.some((item) => item.id === serverId))
        )
          throw fail(
            403,
            "This server is not available on the selected panel.",
          );
      }
      await commit((next) => {
        next.selectedServer = serverId ? { panelId, serverId } : null;
      });
      return list();
    },
    async activate(id) {
      return bridge.selectServer(id, null);
    },
    async disconnect(id) {
      return bridge.signOut(id);
    },
    async selectLocalServer(id) {
      return bridge.selectServer("local", id);
    },
    async selectRemoteServer(id, serverId) {
      return bridge.selectServer(id, serverId);
    },
    async reportServers() {},
    flush: () => writing,
  };
  function resource(input) {
    const url = new URL(input, home);
    if (url.origin !== home || url.hash)
      throw fail(400, "Choose a saved panel resource.");
    const match = /^\/api\/desktop\/panels\/([^/?#]+)\/proxy(\/api\/.*)$/.exec(
      url.pathname,
    );
    if (!match) throw fail(400, "Choose a saved panel resource.");
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      throw fail(400, "Invalid panel identifier.");
    }
    const panel = get(id),
      epochs = url.searchParams.getAll("desktopEpoch");
    if (epochs.length !== 1 || epochs[0] !== panel.epoch)
      throw fail(409, "This panel sign-in changed. Reopen the operation.");
    if (panel.pendingLeave) throw fail(409, pendingMessage);
    if (panel.temporary)
      throw fail(401, "Finish signing in before using this panel.");
    if (!panel.token || !panel.account)
      throw fail(401, "Sign in to this panel before continuing.");
    if (panel.state !== "connected")
      throw fail(503, "This panel is offline. Retry its connection.");
    url.searchParams.delete("desktopEpoch");
    const target = relativeApi(match[2] + url.search, panel.origin);
    if (
      /^\/api\/(?:desktop|panel-users)(?:\/|$)/i.test(target.pathname) ||
      /^\/api\/access\/(?:login|invitation|accept|logout|leave|status)\/?$/i.test(
        target.pathname,
      )
    )
      throw fail(403, "Use the dedicated panel controls for this action.");
    return { panel, target, epoch: panel.epoch };
  }
  async function panelFetch(input, options = {}) {
    await initialize();
    const { panel, target, epoch } = resource(input);
    const headers = new Headers(options.headers),
      ids = target.searchParams.getAll("serverId"),
      header = headers.get("X-Server-Id");
    if (ids.length > 1 || (header && ids.length && header !== ids[0]))
      throw fail(400, "Conflicting server selectors.");
    const serverId = header ?? ids[0];
    if (serverId && !panel.servers.some((item) => item.id === serverId))
      throw fail(403, "You no longer have access to this server.");
    if (serverId) headers.set("X-Server-Id", serverId);
    const response = await request(
      panel,
      target.pathname + target.search,
      { ...options, headers },
      0,
    );
    if (
      response.ok &&
      options.method?.toUpperCase() === "POST" &&
      ["/api/server-setup", "/api/server-import"].includes(target.pathname)
    ) {
      const body = await readJson(response);
      // A roster read started before registration cannot authorize its new
      // server. Drain that read, then obtain a fresh host-verified roster.
      await panel.refreshing;
      requireCurrent(panel, epoch);
      await refresh(panel);
      requireCurrent(panel, epoch);
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (response.status !== 401) return response;
    let body = { error: "Sign in to this panel before continuing." },
      revoked = false;
    try {
      await readJson(response);
    } catch (cause) {
      if (cause.status === 401) {
        body = { error: cause.message };
        revoked = cause.accessRevoked === true;
      }
    }
    requireCurrent(panel, epoch);
    if (revoked) await remove(panel, epoch);
    else await clearSignIn(panel, epoch);
    return new Response(JSON.stringify(body), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  async function download(input) {
    await initialize();
    const { panel, target, epoch } = resource(input);
    if (!target.searchParams.has("serverId") && panel.account.serverId)
      target.searchParams.set("serverId", panel.account.serverId);
    let result;
    try {
      result = await json(panel, "/api/access/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target.pathname + target.search }),
      });
    } catch (cause) {
      if (
        cause.status === 401 &&
        current(panel, epoch) &&
        !panel.pendingLeave
      ) {
        if (cause.accessRevoked === true) await remove(panel, epoch);
        else await clearSignIn(panel, epoch);
      }
      throw cause;
    }
    requireCurrent(panel, epoch);
    const url = new URL(result.url, panel.origin);
    if (
      url.origin !== panel.origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== target.pathname ||
      url.searchParams.getAll("downloadTicket").length !== 1 ||
      !validToken(url.searchParams.get("downloadTicket"))
    )
      throw fail(502, "The host returned an invalid download destination.");
    const actualQuery = new URLSearchParams(url.search);
    actualQuery.delete("downloadTicket");
    if (
      JSON.stringify([...actualQuery]) !==
      JSON.stringify([...target.searchParams])
    )
      throw fail(502, "The host changed the download destination.");
    return url.href;
  }
  return {
    bridge,
    initialize,
    fetch: panelFetch,
    download,
    storageChanged() {
      try {
        sync();
        changed();
      } catch (cause) {
        error = cause.message;
        changed();
      }
    },
    cancelAttempts() {
      attemptEpoch++;
      for (const panel of [...panels.values(), ...drafts.values()])
        if (panel.temporary || panel.authenticating || panel.previewing)
          void bridge.cancelSignIn(panel.id).catch(() => {});
    },
    async close() {
      closed = true;
      clearInterval(timer);
      for (const panel of [...panels.values(), ...drafts.values()])
        invalidate(panel);
      drafts.clear();
      await writing.catch(() => {});
    },
  };
}
