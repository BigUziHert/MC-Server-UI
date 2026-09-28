import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { legacyConnectionHost } from "./connection.mjs";
import permissionCatalog from "../shared/subuser-permissions.json" with { type: "json" };

export const SUBUSER_COOKIE = "__Host-mc-subuser";
const invitationLifetime = 24 * 60 * 60 * 1000;
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const leaveReceiptLifetime = 7 * 24 * 60 * 60 * 1000;
const maximumLeaveReceipts = 4096;
const maximumAccessRevocations = 4096;
const maxEmailMemberships = 32;
const invalidLink =
  "This invitation link is invalid, expired, or already used. If you saved your password, choose Sign in. Otherwise, ask the server owner to reissue the invitation for your existing account.";
const invalidLogin = "The email or password is incorrect.";
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const validSecret = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const normalizedEmail = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
const validEmail = (value) =>
  value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const validPassword = (value) =>
  typeof value === "string" && value.length >= 12 && value.length <= 128;
const hasPassword = (record) =>
  record?.password?.algorithm === "scrypt" &&
  /^[a-f0-9]{64}$/.test(record.password.salt) &&
  /^[a-f0-9]{128}$/.test(record.password.hash);
const activated = (record) =>
  Boolean(
    Number.isSafeInteger(record?.acceptedAt) &&
    record.acceptedAt > 0 &&
    hasPassword(record),
  );
const membershipKey = (serverId, userId) => JSON.stringify([serverId, userId]);
const scopeKey = (record) => membershipKey(record.serverId, record.userId);
const clearCookie = `${SUBUSER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`;
const downloadSessionHash = Symbol("downloadSessionHash");
const derivePassword = promisify(scrypt);
const passwordOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const dummyPassword = {
  salt: randomBytes(32).toString("hex"),
  hash: randomBytes(64).toString("hex"),
};

async function hashPassword(password) {
  const salt = randomBytes(32).toString("hex");
  const hash = await derivePassword(password, salt, 64, passwordOptions);
  return { algorithm: "scrypt", salt, hash: hash.toString("hex") };
}

async function matchesPassword(password, stored) {
  if (
    !stored ||
    !/^[a-f0-9]{64}$/.test(stored.salt) ||
    !/^[a-f0-9]{128}$/.test(stored.hash)
  )
    return false;
  const actual = await derivePassword(
    password,
    stored.salt,
    64,
    passwordOptions,
  );
  return timingSafeEqual(actual, Buffer.from(stored.hash, "hex"));
}

function cookieSecret(req) {
  if (req?.headers?.authorization !== undefined) {
    const authorization = req.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : null;
    return validSecret(token) ? token : null;
  }
  const value = req?.headers?.cookie;
  if (typeof value !== "string" || value.length > 16_384) return null;
  const matches = value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SUBUSER_COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(SUBUSER_COOKIE.length + 1);
  return validSecret(token) ? token : null;
}

// Allowlisted configuration drops retired email provider credentials during migration.
export function validateAccessConfiguration(input, current = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw fail(400, "Enter valid remote access settings.");
  const result = {
    enabled: current.enabled ?? false,
    publicUrl: current.publicUrl ?? "",
    port: current.port ?? 3002,
    transport: current.transport ?? "direct",
  };
  if (Object.hasOwn(input, "enabled")) {
    if (typeof input.enabled !== "boolean")
      throw fail(400, "Choose whether remote access is enabled.");
    result.enabled = input.enabled;
  }
  if (Object.hasOwn(input, "port")) {
    if (
      !Number.isInteger(input.port) ||
      input.port < 1024 ||
      input.port > 65535
    )
      throw fail(400, "Choose a remote access port from 1024 to 65535.");
    result.port = input.port;
  }
  if (Object.hasOwn(input, "transport")) {
    if (!["managed", "direct", "proxy"].includes(input.transport))
      throw fail(
        400,
        "Choose automatic HTTPS, direct HTTPS, or an HTTPS reverse proxy.",
      );
    result.transport = input.transport;
  }
  if (Object.hasOwn(input, "publicUrl")) {
    if (typeof input.publicUrl !== "string" || input.publicUrl.length > 2048)
      throw fail(400, "Enter the HTTPS address of your remote panel.");
    const text = input.publicUrl.trim();
    if (!text) result.publicUrl = "";
    else {
      let url;
      try {
        url = new URL(text);
      } catch {
        /* Report safe validation errors. */
      }
      if (
        !url ||
        url.protocol !== "https:" ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw fail(
          400,
          "Enter an HTTPS address without a path, query, or credentials.",
        );
      result.publicUrl = url.origin;
    }
  }
  if (result.enabled && !result.publicUrl)
    throw fail(
      400,
      "Enter the HTTPS panel address before enabling remote access.",
    );
  if (result.transport === "managed" && result.publicUrl) {
    const url = new URL(result.publicUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.port)
      throw fail(
        400,
        "Automatic HTTPS uses public TCP port 443. Enter the address without a custom port.",
      );
    if (
      !legacyConnectionHost(url.host) ||
      (isIP(host) === 6 && !/^[23]/i.test(host)) ||
      (!isIP(host) &&
        /(?:^|\.)(?:localhost|local|internal|invalid|test|onion)\.?$/i.test(
          host,
        ))
    )
      throw fail(
        400,
        "Automatic HTTPS requires a public IP address or public domain. Local and shared ISP addresses cannot receive a trusted public certificate.",
      );
  }
  return result;
}

/** getUser reads current memberships and permissions. Email never proves access to other memberships. */
export async function createAccessService({
  dataDir,
  getUser,
  listServerIds = () => [],
  listLegacyUsers = () => [],
  canIssueInvitations = () => true,
  now = Date.now,
}) {
  const storage = path.join(dataDir, "remote-access.json");
  let state = {
    version: 4,
    configuration: validateAccessConfiguration({}),
    memberships: [],
    tokens: [],
    sessions: [],
    creationRevocations: [],
    accounts: [],
    retiredLegacyEmails: [],
    leaveReceipts: [],
    accessRevocations: [],
  };
  let migrationNeeded = false;
  try {
    const saved = JSON.parse(await fs.readFile(storage, "utf8"));
    if (
      ![1, 2, 3, 4].includes(saved.version) ||
      !Array.isArray(saved.memberships) ||
      !Array.isArray(saved.tokens) ||
      !Array.isArray(saved.sessions) ||
      (saved.version >= 3 &&
        (!Array.isArray(saved.accounts) ||
          !Array.isArray(saved.retiredLegacyEmails)))
    )
      throw new Error("Invalid access storage.");
    const configuration = { ...saved.configuration };
    if (
      saved.version === 1 &&
      (Object.hasOwn(configuration, "from") ||
        Object.hasOwn(configuration, "apiKey"))
    )
      configuration.transport ??= "proxy";
    state = {
      version: 4,
      configuration: validateAccessConfiguration(configuration),
      memberships: saved.memberships,
      tokens: saved.tokens,
      sessions: saved.sessions,
      creationRevocations: Array.isArray(saved.creationRevocations)
        ? saved.creationRevocations
        : [],
      accounts: Array.isArray(saved.accounts) ? saved.accounts : [],
      retiredLegacyEmails: Array.isArray(saved.retiredLegacyEmails)
        ? saved.retiredLegacyEmails
        : [],
      leaveReceipts: saved.leaveReceipts ?? [],
      accessRevocations:
        saved.accessRevocations === undefined ? [] : saved.accessRevocations,
    };
    if (
      !Array.isArray(state.leaveReceipts) ||
      state.leaveReceipts.length > maximumLeaveReceipts ||
      state.leaveReceipts.some(
        (receipt) =>
          !receipt ||
          !/^[a-f0-9]{64}$/.test(receipt.requestHash) ||
          !/^[a-f0-9]{64}$/.test(receipt.proofHash) ||
          !Number.isSafeInteger(receipt.expiresAt) ||
          receipt.expiresAt < 0,
      )
    )
      throw new Error("Invalid panel leave receipt storage.");
    const revocationHashes = new Set();
    if (
      !Array.isArray(state.accessRevocations) ||
      state.accessRevocations.length > maximumAccessRevocations ||
      state.accessRevocations.some((receipt) => {
        if (
          !receipt ||
          typeof receipt !== "object" ||
          Array.isArray(receipt) ||
          Object.keys(receipt).length !== 2 ||
          typeof receipt.hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(receipt.hash) ||
          !Number.isSafeInteger(receipt.expiresAt) ||
          receipt.expiresAt < 0 ||
          revocationHashes.has(receipt.hash)
        )
          return true;
        revocationHashes.add(receipt.hash);
        return false;
      })
    )
      throw new Error("Invalid access revocation receipt storage.");
    const activeRevocations = state.accessRevocations.filter(
      (receipt) => receipt.expiresAt > now(),
    );
    if (activeRevocations.length !== state.accessRevocations.length) {
      state.accessRevocations = activeRevocations;
      migrationNeeded = true;
    }
    const accountIds = new Set(),
      accountEmails = new Set();
    for (const account of state.accounts) {
      if (
        !account ||
        typeof account.id !== "string" ||
        !account.id ||
        !validEmail(account.email) ||
        account.email !== normalizedEmail(account.email) ||
        accountIds.has(account.id) ||
        accountEmails.has(account.email) ||
        !["all", "selected"].includes(account.accessMode) ||
        !Array.isArray(account.permissions) ||
        !Array.isArray(account.hostPermissions) ||
        !Array.isArray(account.serverIds) ||
        !Array.isArray(account.excludedServerIds) ||
        !account.serverOverrides ||
        typeof account.serverOverrides !== "object" ||
        Array.isArray(account.serverOverrides) ||
        typeof account.authRevision !== "string"
      )
        throw new Error("Invalid panel account storage.");
      for (const override of Object.values(account.serverOverrides)) {
        if (
          !override ||
          typeof override !== "object" ||
          Array.isArray(override) ||
          !Array.isArray(override.permissions) ||
          override.permissions.some((id) => typeof id !== "string") ||
          (override.hostPermissions !== undefined &&
            (!Array.isArray(override.hostPermissions) ||
              override.hostPermissions.some((id) => typeof id !== "string")))
        )
          throw new Error("Invalid per-server account storage.");
      }
      if (
        saved.version === 4 &&
        (account.accessMode !== "selected" ||
          account.permissions.length ||
          account.serverIds.some((id) => typeof id !== "string") ||
          account.excludedServerIds.some((id) => typeof id !== "string"))
      )
        throw new Error("Invalid scoped account storage.");
      accountIds.add(account.id);
      accountEmails.add(account.email);
    }
    if (saved.version < 4) {
      migrationNeeded = true;
      const existing = new Set(listServerIds());
      state.accounts = state.accounts.map((account) => {
        // Materialize the old policy against today's registry only. New servers
        // must never inherit a previous account-wide permission template.
        const mapped = (
          account.accessMode === "all" ? [...existing] : account.serverIds
        ).filter(
          (id) => existing.has(id) && !account.excludedServerIds.includes(id),
        );
        const unresolved = [
          ...new Set([
            ...account.serverIds,
            ...account.excludedServerIds,
            ...Object.keys(account.serverOverrides),
          ]),
        ].filter(
          (id) =>
            !existing.has(id) ||
            (Object.hasOwn(account.serverOverrides, id) &&
              !mapped.includes(id)),
        );
        return {
          ...account,
          accessMode: "selected",
          permissions: [],
          serverIds: mapped,
          excludedServerIds: [],
          serverOverrides: Object.fromEntries(
            mapped.map((id) => [
              id,
              {
                ...account.serverOverrides[id],
                permissions: [
                  ...new Set([
                    "server.view",
                    ...(account.serverOverrides[id]?.permissions ??
                      account.permissions),
                  ]),
                ],
              },
            ]),
          ),
          ...(unresolved.length ||
          (account.permissions.length && !mapped.length)
            ? {
                accessReview: {
                  message:
                    "Some previous permissions have no active server mapping. They are retained for owner review and are not active.",
                  serverIds: unresolved,
                  previousPolicy: {
                    accessMode: account.accessMode,
                    permissions: account.permissions,
                    serverIds: account.serverIds,
                    excludedServerIds: account.excludedServerIds,
                    serverOverrides: account.serverOverrides,
                  },
                },
              }
            : {}),
        };
      });
    }
  } catch (cause) {
    if (cause.code !== "ENOENT")
      throw fail(
        500,
        "Remote access settings could not be loaded. Check the local access data file.",
      );
  }
  let queue = Promise.resolve();
  const downloadTickets = new Map();
  let closing = false;
  let pendingAuthentications = 0;
  const serialize = (operation) => {
    if (closing)
      return Promise.reject(fail(503, "Remote access is shutting down."));
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  };
  // Bound expensive password work across all peer addresses as well as the
  // gateway's per-peer limits. Owner settings cannot acquire an endless queue.
  const serializeAuthentication = (operation) => {
    if (closing)
      return Promise.reject(fail(503, "Remote access is shutting down."));
    if (pendingAuthentications >= 16)
      return Promise.reject(
        fail(429, "Too many sign-in attempts. Try again later."),
      );
    pendingAuthentications += 1;
    return serialize(operation).finally(() => {
      pendingAuthentications -= 1;
    });
  };
  const persist = async (next) => {
    const temporary = `${storage}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, storage);
      state = next;
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw fail(
        500,
        "Remote access settings could not be saved. Check available disk space and file permissions.",
      );
    }
  };
  if (migrationNeeded) await persist(state);
  const cleaned = () => ({
    ...state,
    tokens: state.tokens.filter(
      (token) => token.expiresAt > now() && token.sent !== false,
    ),
    sessions: state.sessions.filter((session) => session.expiresAt > now()),
    leaveReceipts: state.leaveReceipts.filter(
      (receipt) => receipt.expiresAt > now(),
    ),
    accessRevocations: state.accessRevocations.filter(
      (receipt) => receipt.expiresAt > now(),
    ),
  });
  // Keep only an expiring, bearer-token proof of a deliberate loss of access.
  // This never records an identity, plaintext credential or ordinary sign-out.
  // Evict the earliest-expiring receipts at capacity so removing access cannot
  // fail just because the optional reconnect notice has reached its bound.
  const withAccessRevocations = (next, removedSessions) => {
    const time = now();
    const receipts = new Map(
      next.accessRevocations
        .filter((receipt) => receipt.expiresAt > time)
        .map((receipt) => [receipt.hash, receipt]),
    );
    for (const session of removedSessions) {
      if (
        session.transport !== "bearer" ||
        typeof session.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(session.hash) ||
        !Number.isSafeInteger(session.expiresAt) ||
        session.expiresAt <= time
      )
        continue;
      receipts.set(session.hash, {
        hash: session.hash,
        expiresAt: Math.min(session.expiresAt, time + sessionLifetime),
      });
    }
    return [...receipts.values()]
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .slice(-maximumAccessRevocations);
  };
  const isAccessRevoked = (req) => {
    // Legacy browser cookies are not origin-scoped proof, even when their value
    // happens to match a newer bearer credential removed from this panel.
    if (typeof req?.headers?.authorization !== "string") return false;
    const token = cookieSecret(req);
    if (!token) return false;
    const hash = digest(token);
    return state.accessRevocations.some(
      (receipt) => receipt.hash === hash && receipt.expiresAt > now(),
    );
  };
  const status = () => ({
    ...state.configuration,
    ready: Boolean(
      state.configuration.enabled && state.configuration.publicUrl,
    ),
  });
  const requireReady = () => {
    if (!status().ready)
      throw fail(
        409,
        "Configure the HTTPS panel address and enable remote access before creating an invitation link.",
      );
    if (state.configuration.transport === "managed" && !canIssueInvitations())
      throw fail(
        409,
        "Automatic HTTPS is not ready. Wait for a trusted certificate in Remote Access, then create an invitation link. Existing accounts and server permissions are preserved.",
      );
  };
  const permissionIds = new Set(
    permissionCatalog.groups.flatMap((group) =>
      group.permissions.map((permission) => permission.id),
    ),
  );
  const hostPermissionIds = new Set(
    permissionCatalog.hostPermissions.map((permission) => permission.id),
  );
  const validPermissions = (value, allowed = permissionIds) => {
    if (
      !Array.isArray(value) ||
      value.length > allowed.size ||
      value.some((id) => !allowed.has(id))
    )
      throw fail(400, "Choose valid account permissions.");
    return [...new Set(value)];
  };
  const serverIds = () => [...new Set(listServerIds())];
  const accountById = (id) =>
    state.accounts.find((account) => account.id === id);
  const permitsServer = (account, serverId) =>
    serverIds().includes(serverId) &&
    !account.excludedServerIds.includes(serverId) &&
    account.serverIds.includes(serverId) &&
    account.serverOverrides[serverId]?.permissions?.includes("server.view");
  const accountPermissions = (account, serverId) =>
    account.serverOverrides[serverId]?.permissions ?? [];
  const accountHostPermissions = (account, serverId) => [
    ...new Set([
      ...account.hostPermissions,
      ...(account.serverOverrides[serverId]?.hostPermissions ?? []),
    ]),
  ];
  const userForServer = (serverId, accountId) => {
    const account = accountById(accountId);
    if (!account || !permitsServer(account, serverId)) return null;
    return {
      id: account.id,
      accountId: account.id,
      panelAccount: true,
      email: account.email,
      createdAt: account.createdAt,
      role: "custom",
      permissions: [...accountPermissions(account, serverId)],
      hostPermissions: accountHostPermissions(account, serverId),
    };
  };
  const resolveUser = (serverId, userId, baseUser) => {
    if (accountById(userId)) return userForServer(serverId, userId);
    if (!baseUser || baseUser.id !== userId) return null;
    const email = normalizedEmail(baseUser.email);
    const linked = state.accounts.find((account) =>
      account.legacyMembers?.some(
        (member) => member.serverId === serverId && member.userId === userId,
      ),
    );
    if (linked) {
      if (linked.legacyPending !== true || !permitsServer(linked, serverId))
        return null;
      return {
        ...baseUser,
        managedAccountId: linked.id,
        accountId: linked.id,
        panelAccount: true,
        permissions: [...accountPermissions(linked, serverId)],
        hostPermissions: accountHostPermissions(linked, serverId),
      };
    }
    if (
      state.accounts.some((account) => account.email === email) ||
      state.retiredLegacyEmails.includes(email)
    )
      return null;
    return baseUser;
  };
  const legacyAccounts = () => {
    const groups = new Map();
    for (const { serverId, user } of listLegacyUsers()) {
      const email = normalizedEmail(user?.email);
      if (
        !validEmail(email) ||
        !user?.id ||
        !serverIds().includes(serverId) ||
        state.accounts.some((account) => account.email === email) ||
        state.retiredLegacyEmails.includes(email)
      )
        continue;
      let account = groups.get(email);
      if (!account) {
        account = {
          id: `legacy:${email}`,
          email,
          legacy: true,
          permissions: [],
          hostPermissions: [],
          accessMode: "selected",
          serverIds: [],
          excludedServerIds: [],
          serverOverrides: {},
          legacyMembers: [],
        };
        groups.set(email, account);
      }
      const createdAt =
        typeof user.createdAt === "string" ? Date.parse(user.createdAt) : NaN;
      if (
        Number.isFinite(createdAt) &&
        (!account.createdAt || createdAt < Date.parse(account.createdAt))
      )
        account.createdAt = new Date(createdAt).toISOString();
      if (!account.serverIds.includes(serverId))
        account.serverIds.push(serverId);
      const previous = account.serverOverrides[serverId];
      if (previous) {
        // Multiple legacy identities on the same server are not a single
        // permission grant. Keep their original records and credentials until
        // the owner resolves the duplicate; never union them during promotion.
        account.accessReview = {
          message:
            "Duplicate legacy identities share an email on this server. Review their server access before combining them into one panel account.",
          serverIds: [
            ...new Set([...(account.accessReview?.serverIds ?? []), serverId]),
          ],
          duplicateLegacyIdentities: true,
        };
        account.legacyMembers.push({ serverId, userId: user.id });
        continue;
      }
      account.serverOverrides[serverId] = {
        permissions: [
          ...new Set([
            ...(user.permissionVersion !== 2 ? ["server.view"] : []),
            ...(previous?.permissions ?? []),
            ...(user.permissions ?? []).filter((id) => permissionIds.has(id)),
          ]),
        ],
        hostPermissions: [
          ...new Set([
            ...(previous?.hostPermissions ?? []),
            ...(user.hostPermissions ?? []).filter((id) =>
              hostPermissionIds.has(id),
            ),
          ]),
        ],
      };
      account.legacyMembers.push({ serverId, userId: user.id });
    }
    return [...groups.values()];
  };
  const accountInvitation = (account) => {
    if (!account?.invitedAt) return {};
    const token = state.tokens.find(
      (item) => item.accountId === account.id && item.expiresAt > now(),
    );
    return {
      invitedAt: new Date(account.invitedAt).toISOString(),
      inviteExpiresAt: token ? new Date(token.expiresAt).toISOString() : null,
      acceptedAt: activated(account)
        ? new Date(account.acceptedAt).toISOString()
        : null,
      inviteStatus: token
        ? "pending"
        : activated(account)
          ? "accepted"
          : "expired",
    };
  };
  const publicAccount = (account) => {
    if (!account) return null;
    const { password, authRevision, ...visible } = account;
    return structuredClone({
      ...visible,
      ...accountInvitation(account),
      effectiveHostPermissions: [
        ...new Set([
          ...account.hostPermissions,
          ...Object.keys(account.serverOverrides)
            .filter((id) => permitsServer(account, id))
            .flatMap((id) => account.serverOverrides[id].hostPermissions ?? []),
        ]),
      ],
    });
  };
  const findAccount = (id) =>
    accountById(id) ?? legacyAccounts().find((account) => account.id === id);
  const promoted = (account) => {
    if (account.accessReview?.duplicateLegacyIdentities)
      throw fail(
        409,
        "Review duplicate legacy identities on their server before combining this account.",
      );
    return account.legacy
      ? {
          ...account,
          id: randomUUID(),
          legacy: false,
          legacyPending: true,
          createdAt: new Date(now()).toISOString(),
          authRevision: randomUUID(),
        }
      : { ...account };
  };
  const validateAccount = (input, current) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw fail(400, "Enter valid panel account settings.");
    const allowed = new Set(["email", "hostPermissions"]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw fail(
        400,
        "Manage server permissions from that server's Subusers page.",
      );
    const email = normalizedEmail(input.email ?? current?.email);
    if (!validEmail(email))
      throw fail(400, "Enter a valid account email address.");
    if (current && email !== current.email)
      throw fail(400, "Create a new account to use a different email address.");
    const account = {
      id: randomUUID(),
      createdAt: new Date(now()).toISOString(),
      authRevision: randomUUID(),
      permissions: [],
      hostPermissions: [],
      accessMode: "selected",
      serverIds: [],
      excludedServerIds: [],
      serverOverrides: {},
      ...current,
      email,
    };
    if (Object.hasOwn(input, "hostPermissions"))
      account.hostPermissions = validPermissions(
        input.hostPermissions,
        hostPermissionIds,
      );
    if (Object.hasOwn(input, "hostPermissions"))
      account.serverOverrides = Object.fromEntries(
        Object.entries(account.serverOverrides).map(([id, override]) => [
          id,
          {
            ...override,
            hostPermissions: [],
          },
        ]),
      );
    return account;
  };
  const replaceAccount = (next, account, previous) => ({
    ...next,
    accounts: [
      ...next.accounts.filter(
        (item) => item.id !== account.id && item.id !== previous?.id,
      ),
      account,
    ],
  });
  const liveUser = async (record) => {
    const user = accountById(record.userId)
      ? userForServer(record.serverId, record.userId)
      : resolveUser(
          record.serverId,
          record.userId,
          await getUser(record.serverId, record.userId),
        );
    return user && normalizedEmail(user.email) === record.email ? user : null;
  };
  const enrolled = (record) =>
    state.memberships.some(
      (item) =>
        scopeKey(item) === scopeKey(record) && item.email === record.email,
    );
  const pendingInvitation = async (token) => {
    if (!status().ready || !validSecret(token)) throw fail(401, invalidLink);
    const hash = digest(token);
    const record = state.tokens.find(
      (item) =>
        item.hash === hash && item.sent !== false && item.expiresAt > now(),
    );
    if (!record) throw fail(401, invalidLink);
    if (record.accountId) {
      const account = accountById(record.accountId);
      if (!account || account.email !== record.email)
        throw fail(401, invalidLink);
    } else if (!enrolled(record) || !(await liveUser(record))) {
      throw fail(401, invalidLink);
    }
    return record;
  };
  const sessionScopes = (record) =>
    Array.isArray(record.memberships)
      ? record.memberships
      : [{ serverId: record.serverId, userId: record.userId }];
  const sessionIncludes = (record, key) =>
    sessionScopes(record).some((scope) => scopeKey(scope) === key);
  const sessionView = (record, user, memberships) => ({
    role: "subuser",
    email: record.email,
    serverId: record.serverId,
    userId: record.userId,
    permissions: Array.isArray(user.permissions) ? [...user.permissions] : [],
    memberships: memberships.map(({ serverId, userId }) => ({
      serverId,
      userId,
    })),
  });
  const createSession = (records) => {
    const value = secret();
    const { serverId, userId, email } = records[0];
    const session = {
      transport: "bearer",
      serverId,
      userId,
      email,
      memberships: records.map(({ serverId: id, userId: memberId }) => ({
        serverId: id,
        userId: memberId,
      })),
      hash: digest(value),
      expiresAt: now() + sessionLifetime,
    };
    return {
      token: value,
      session,
      cookie: `${SUBUSER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${sessionLifetime / 1000}`,
    };
  };
  const accountSessionView = (account) => {
    const memberships = serverIds()
      .filter((id) => permitsServer(account, id))
      .map((serverId) => ({ serverId, userId: account.id }));
    const serverId = memberships[0]?.serverId ?? null;
    return {
      role: "subuser",
      accountId: account.id,
      userId: account.id,
      email: account.email,
      serverId,
      permissions: serverId ? [...accountPermissions(account, serverId)] : [],
      hostPermissions: [
        ...new Set([
          ...account.hostPermissions,
          ...memberships.flatMap((scope) =>
            accountHostPermissions(account, scope.serverId),
          ),
        ]),
      ],
      memberships,
    };
  };
  const createAccountSession = (account) => {
    const value = secret();
    return {
      token: value,
      session: {
        transport: "bearer",
        accountId: account.id,
        authRevision: account.authRevision,
        email: account.email,
        hash: digest(value),
        expiresAt: now() + sessionLifetime,
      },
      cookie: `${SUBUSER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${sessionLifetime / 1000}`,
    };
  };
  const authenticatedSession = async (req) => {
    if (!status().ready) return null;
    const token = cookieSecret(req);
    const hash = req?.[downloadSessionHash] ?? (token ? digest(token) : null);
    if (!hash) return null;
    const record = state.sessions.find(
      (item) =>
        item.hash === hash &&
        item.expiresAt > now() &&
        (!(req?.headers?.authorization || req?.[downloadSessionHash]) ||
          item.transport === "bearer"),
    );
    if (!record) return null;
    if (record.accountId) {
      const account = accountById(record.accountId);
      return activated(account) &&
        account.email === record.email &&
        account.authRevision === record.authRevision
        ? accountSessionView(account)
        : null;
    }
    const memberships = [];
    for (const scope of sessionScopes(record).slice(0, maxEmailMemberships)) {
      const membership = { ...scope, email: record.email };
      if (
        state.memberships.some(
          (item) =>
            scopeKey(item) === scopeKey(membership) &&
            item.email === membership.email &&
            activated(item),
        ) &&
        (await liveUser(membership))
      )
        memberships.push(scope);
    }
    if (!memberships.length) return null;
    const primary =
      memberships.find((scope) => scopeKey(scope) === scopeKey(record)) ??
      memberships[0];
    const user = await liveUser({ ...primary, email: record.email });
    return user
      ? sessionView({ ...record, ...primary }, user, memberships)
      : null;
  };
  const hostAuthority = async (req, expected) => {
    const session = await authenticatedSession(req);
    if (session?.accountId) {
      if (
        session.hostPermissions.includes("server.create") &&
        (!expected || expected.accountId === session.accountId)
      )
        return {
          accountId: session.accountId,
          userId: session.accountId,
          email: session.email,
        };
      throw fail(
        403,
        "The panel owner must grant permission to add servers on this computer.",
      );
    }
    for (const scope of session?.memberships ?? []) {
      const record = state.memberships.find(
        (item) =>
          scopeKey(item) === scopeKey(scope) && item.email === session.email,
      );
      if (
        !record?.password ||
        (expected && scopeKey(record) !== scopeKey(expected))
      )
        continue;
      const user = await liveUser(record);
      if (user?.hostPermissions?.includes("server.create"))
        return {
          serverId: record.serverId,
          userId: record.userId,
          email: record.email,
        };
    }
    throw fail(
      403,
      "The panel owner must grant permission to add servers on this computer.",
    );
  };

  const withoutIdentity = (next, email, id) => {
    const accountIds = new Set(
      next.accounts
        .filter((account) => account.email === email || account.id === id)
        .map((account) => account.id),
    );
    const scopes = [
      ...next.memberships.filter((member) => member.email === email),
      ...next.sessions
        .filter((session) => session.email === email)
        .flatMap(sessionScopes),
      ...listLegacyUsers()
        .filter(({ user }) => normalizedEmail(user?.email) === email)
        .map(({ serverId, user }) => ({ serverId, userId: user.id })),
      ...next.accounts
        .filter((account) => accountIds.has(account.id))
        .flatMap((account) =>
          [
            ...(account.legacyMembers ?? []),
            ...new Set([
              ...account.serverIds,
              ...(account.creatorServerIds ?? []),
              ...Object.keys(account.serverOverrides),
            ]),
          ].map((scope) =>
            typeof scope === "string"
              ? { serverId: scope, userId: account.id }
              : scope,
          ),
        ),
    ];
    return {
      ...next,
      accounts: next.accounts.filter((account) => !accountIds.has(account.id)),
      retiredLegacyEmails: [...new Set([...next.retiredLegacyEmails, email])],
      memberships: next.memberships.filter((member) => member.email !== email),
      tokens: next.tokens.filter(
        (token) => token.email !== email && !accountIds.has(token.accountId),
      ),
      sessions: next.sessions.filter(
        (session) =>
          session.email !== email && !accountIds.has(session.accountId),
      ),
      accessRevocations: withAccessRevocations(
        next,
        next.sessions.filter(
          (session) =>
            session.email === email || accountIds.has(session.accountId),
        ),
      ),
      creationRevocations: [
        ...new Set([
          ...next.creationRevocations,
          ...scopes
            .filter(
              (scope) =>
                typeof scope.serverId === "string" &&
                typeof scope.userId === "string",
            )
            .map(scopeKey),
        ]),
      ],
    };
  };

  return {
    status,
    hostAuthority,
    isAccessRevoked,
    // Serialize identity reservation with account creation/promotion so a raw
    // server identity cannot become invisible between validation and commit.
    withLegacyIdentity: (email, create) =>
      serialize(async () => {
        const normalized = normalizedEmail(email);
        if (
          state.accounts.some((account) => account.email === normalized) ||
          state.retiredLegacyEmails.includes(normalized)
        )
          throw fail(
            409,
            "This identity is managed by the panel owner. Ask them to grant access from this server's Subusers page.",
          );
        return create();
      }),
    async issueDownload(req, target) {
      const session = await authenticatedSession(req);
      if (!session) throw fail(401, "Sign in before downloading files.");
      const token = cookieSecret(req);
      if (!validSecret(token))
        throw fail(401, "Sign in before downloading files.");
      let url;
      try {
        url = new URL(target, "https://download.invalid");
      } catch {
        /* validated below */
      }
      if (
        typeof target !== "string" ||
        !target.startsWith("/api/") ||
        !url ||
        url.origin !== "https://download.invalid" ||
        url.hash ||
        url.searchParams.has("downloadTicket") ||
        !(
          url.pathname === "/api/files/download" ||
          /^\/api\/backups\/[^/]+\/download$/.test(url.pathname)
        )
      )
        throw fail(400, "Choose a file or backup download on this panel.");
      const selectors = url.searchParams.getAll("serverId");
      if (selectors.length > 1)
        throw fail(400, "Choose one server for this download.");
      const serverId = selectors[0] ?? session.serverId;
      const scope = session.memberships.find(
        (membership) => membership.serverId === serverId,
      );
      const user = scope
        ? await liveUser({ ...scope, email: session.email })
        : null;
      const permission =
        url.pathname === "/api/files/download"
          ? "file.read-content"
          : "backup.download";
      if (
        !user?.permissions?.includes("server.view") ||
        !user.permissions.includes(permission)
      )
        throw fail(403, "You do not have permission to download this item.");
      // A later grant change may select a different primary server. The
      // ticket must continue to address the server authorized at issuance.
      url.searchParams.set("serverId", serverId);
      for (const [key, ticket] of downloadTickets)
        if (ticket.expiresAt <= now()) downloadTickets.delete(key);
      // Tokens rotate across sign-ins. Keep the budget tied to the panel
      // identity so one account cannot occupy the global ticket pool.
      const principal = session.accountId
        ? `account:${session.accountId}`
        : `legacy:${session.email}`;
      if (
        [...downloadTickets.values()].filter(
          (ticket) => ticket.principal === principal,
        ).length >= 32
      )
        throw fail(
          429,
          "Too many pending downloads for this account. Try again shortly.",
        );
      if (downloadTickets.size >= 1024)
        throw fail(429, "Too many pending downloads. Try again shortly.");
      const value = secret();
      url.search = url.searchParams.toString();
      downloadTickets.set(digest(value), {
        hash: digest(token),
        principal,
        target: url.pathname + url.search,
        expiresAt: now() + 60_000,
      });
      url.searchParams.set("downloadTicket", value);
      return { url: url.pathname + url.search };
    },
    consumeDownload(req) {
      const value = req.query?.downloadTicket;
      if (!validSecret(value) || req.method !== "GET")
        throw fail(
          401,
          "This download link is invalid or expired. Start the download again.",
        );
      const key = digest(value),
        ticket = downloadTickets.get(key);
      const url = new URL(req.originalUrl, "https://download.invalid");
      url.searchParams.delete("downloadTicket");
      if (
        !ticket ||
        ticket.expiresAt <= now() ||
        ticket.target !== url.pathname + url.search
      )
        throw fail(
          401,
          "This download link is invalid or expired. Start the download again.",
        );
      downloadTickets.delete(key);
      req[downloadSessionHash] = ticket.hash;
    },
    account: (id) => publicAccount(findAccount(id)),
    listAccounts: () =>
      [...state.accounts, ...legacyAccounts()].map(publicAccount),
    userForServer,
    usersForServer: (serverId) =>
      state.accounts
        .map((account) => userForServer(serverId, account.id))
        .filter(Boolean),
    resolveUser,
    grantServer: (serverId, id, input) =>
      serialize(async () => {
        if (!serverIds().includes(serverId))
          throw fail(404, "Server not found.");
        const current = findAccount(id);
        if (!current) throw fail(404, "Panel account not found.");
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).some(
            (key) => !["permissions", "hostPermissions"].includes(key),
          )
        )
          throw fail(400, "Enter valid permissions for this server.");
        const permissions = validPermissions(input.permissions);
        if (permissions.length && !permissions.includes("server.view"))
          throw fail(
            400,
            "Select Can View Server before granting other server permissions.",
          );
        const account = promoted(current);
        const override = {
          permissions,
          hostPermissions: Object.hasOwn(input, "hostPermissions")
            ? validPermissions(input.hostPermissions, hostPermissionIds)
            : (account.serverOverrides[serverId]?.hostPermissions ?? []),
        };
        if (
          override.hostPermissions.length &&
          !permissions.includes("server.view")
        )
          throw fail(
            400,
            "Select Can View Server before granting this server's host access.",
          );
        const updated = {
          ...account,
          accessMode: "selected",
          permissions: [],
          serverIds: [...new Set([...account.serverIds, serverId])],
          excludedServerIds: account.excludedServerIds.filter(
            (id) => id !== serverId,
          ),
          serverOverrides: { ...account.serverOverrides, [serverId]: override },
        };
        await persist(replaceAccount(cleaned(), updated, current));
        return {
          id: updated.id,
          accountId: updated.id,
          panelAccount: true,
          email: updated.email,
          createdAt: updated.createdAt,
          role: "custom",
          permissions: [...permissions],
          hostPermissions: accountHostPermissions(updated, serverId),
        };
      }),
    createAccount: (input) =>
      serialize(async () => {
        const account = validateAccount(input);
        if (
          [...state.accounts, ...legacyAccounts()].some(
            (item) => item.email === account.email,
          ) ||
          state.memberships.some((item) => item.email === account.email)
        )
          throw fail(
            409,
            "This email already has a panel account. Edit it or create a new invitation.",
          );
        await persist(replaceAccount(cleaned(), account));
        return publicAccount(account);
      }),
    updateAccount: (id, input) =>
      serialize(async () => {
        const current = findAccount(id);
        if (!current) throw fail(404, "Panel account not found.");
        const account = validateAccount(input, promoted(current));
        await persist(replaceAccount(cleaned(), account, current));
        return publicAccount(account);
      }),
    deleteAccount: (id) =>
      serialize(async () => {
        const current = findAccount(id);
        if (!current) throw fail(404, "Panel account not found.");
        await persist(withoutIdentity(cleaned(), current.email, id));
      }),
    inviteAccount: (id) =>
      serialize(async () => {
        requireReady();
        const current = findAccount(id);
        if (!current) throw fail(404, "Panel account not found.");
        const token = secret(),
          createdAt = now(),
          expiresAt = createdAt + invitationLifetime;
        const account = {
          ...promoted(current),
          password: undefined,
          acceptedAt: undefined,
          invitedAt: createdAt,
          authRevision: randomUUID(),
        };
        const next = replaceAccount(cleaned(), account, current);
        await persist({
          ...next,
          tokens: [
            ...next.tokens.filter((item) => item.accountId !== account.id),
            {
              accountId: account.id,
              email: account.email,
              hash: digest(token),
              createdAt,
              expiresAt,
            },
          ],
          sessions: next.sessions.filter(
            (item) => item.accountId !== account.id,
          ),
        });
        return {
          account: publicAccount(account),
          invitationUrl: `${state.configuration.publicUrl}/#invite=${token}`,
          invitedAt: new Date(createdAt).toISOString(),
          inviteExpiresAt: new Date(expiresAt).toISOString(),
        };
      }),
    assertCreationCapacity: (email) => {
      if (
        state.accounts.some(
          (account) => account.email === email && account.acceptedAt,
        )
      )
        return;
      if (
        state.memberships.filter((item) => item.email === email).length >=
        maxEmailMemberships
      )
        throw fail(
          400,
          "This email has reached the limit of 32 remote server memberships.",
        );
    },
    creationAllowed: (serverId, userId) =>
      !state.creationRevocations.includes(membershipKey(serverId, userId)),
    // Creation proves only the granting membership. Copy its credential, never
    // another same-email password, and persist enrollment + session together.
    enrollCreated: (req, source, target) =>
      serialize(async () => {
        const authority = await hostAuthority(req, source);
        if (
          authority.email !== source.email ||
          target.email !== authority.email
        )
          throw fail(
            403,
            "This server creation belongs to a different account.",
          );
        if (authority.accountId) {
          const account = accountById(authority.accountId);
          if (
            target.userId !== account.id ||
            !serverIds().includes(target.serverId)
          )
            throw fail(
              403,
              "This server creation belongs to a different account.",
            );
          const key = scopeKey(target);
          if (
            state.creationRevocations.includes(key) ||
            account.excludedServerIds.includes(target.serverId) ||
            (account.creatorServerIds?.includes(target.serverId) &&
              !permitsServer(account, target.serverId))
          )
            throw fail(
              403,
              "Your creator access was revoked. Contact the panel owner.",
            );
          if (account.creatorServerIds?.includes(target.serverId)) return;
          const updated = {
            ...account,
            serverIds: [...new Set([...account.serverIds, target.serverId])],
            creatorServerIds: [
              ...(account.creatorServerIds ?? []),
              target.serverId,
            ],
            serverOverrides: {
              ...account.serverOverrides,
              [target.serverId]: {
                permissions: [...permissionCatalog.roleDefaults.admin],
              },
            },
          };
          await persist(replaceAccount(cleaned(), updated));
          return;
        }
        const pendingAccount = state.accounts.find(
          (account) =>
            account.legacyPending === true &&
            account.email === authority.email &&
            account.legacyMembers?.some(
              (member) => scopeKey(member) === scopeKey(authority),
            ),
        );
        if (
          pendingAccount &&
          (pendingAccount.excludedServerIds.includes(target.serverId) ||
            (pendingAccount.creatorServerIds?.includes(target.serverId) &&
              !permitsServer(pendingAccount, target.serverId)))
        )
          throw fail(
            403,
            "Your creator access was revoked. Contact the panel owner.",
          );
        // A newly created legacy row is intentionally not yet linked to the
        // promoted account. Only this trusted creation path may attach its raw
        // identity; ordinary resolution must keep rejecting unlinked rows.
        const user = pendingAccount
          ? await getUser(target.serverId, target.userId)
          : await liveUser(target);
        if (!user)
          throw fail(
            409,
            "The created server's access record is unavailable. Retry this request.",
          );
        if (
          pendingAccount &&
          (user.id !== target.userId ||
            normalizedEmail(user.email) !== authority.email ||
            !serverIds().includes(target.serverId))
        )
          throw fail(
            403,
            "This server creation belongs to a different account.",
          );
        const session = await authenticatedSession(req);
        const sourceRecord = state.memberships.find(
          (item) => scopeKey(item) === scopeKey(source),
        );
        const key = scopeKey(target);
        const next = cleaned();
        if (next.creationRevocations.includes(key))
          throw fail(
            403,
            "Your creator access was revoked. Contact the panel owner.",
          );
        if (
          next.memberships.filter(
            (item) => item.email === authority.email && scopeKey(item) !== key,
          ).length >= maxEmailMemberships
        )
          throw fail(
            400,
            "This email has reached the limit of 32 remote server memberships.",
          );
        const existing = next.memberships.find(
          (item) => scopeKey(item) === key,
        );
        if (
          existing &&
          (existing.email !== authority.email ||
            !existing.password ||
            !existing.acceptedAt ||
            existing.creationSource !== scopeKey(source) ||
            !session.memberships.some((scope) => scopeKey(scope) === key))
        )
          throw fail(
            403,
            "This server's access record was changed or reset. Sign in to it separately.",
          );
        const updatedAccount =
          pendingAccount &&
          !pendingAccount.creatorServerIds?.includes(target.serverId)
            ? {
                ...pendingAccount,
                serverIds: [
                  ...new Set([...pendingAccount.serverIds, target.serverId]),
                ],
                creatorServerIds: [
                  ...(pendingAccount.creatorServerIds ?? []),
                  target.serverId,
                ],
                legacyMembers: [
                  ...(pendingAccount.legacyMembers ?? []).filter(
                    (member) => scopeKey(member) !== key,
                  ),
                  { serverId: target.serverId, userId: target.userId },
                ],
                serverOverrides: {
                  ...pendingAccount.serverOverrides,
                  [target.serverId]: {
                    permissions: [...permissionCatalog.roleDefaults.admin],
                  },
                },
              }
            : null;
        const hash = digest(cookieSecret(req));
        await persist({
          ...(updatedAccount ? replaceAccount(next, updatedAccount) : next),
          memberships: existing
            ? next.memberships
            : [
                ...next.memberships,
                {
                  ...target,
                  invitedAt: now(),
                  acceptedAt: now(),
                  password: { ...sourceRecord.password },
                  creationSource: scopeKey(source),
                },
              ],
          sessions: next.sessions.map((item) =>
            item.hash === hash
              ? {
                  ...item,
                  memberships: [
                    ...session.memberships.filter(
                      (scope) => scopeKey(scope) !== key,
                    ),
                    { serverId: target.serverId, userId: target.userId },
                  ],
                }
              : item,
          ),
        });
      }),
    validateConfiguration: (input) =>
      validateAccessConfiguration(input, state.configuration),
    async close() {
      closing = true;
      await queue;
    },
    invitationState(serverId, userId) {
      const account = accountById(userId);
      if (account)
        return permitsServer(account, serverId)
          ? accountInvitation(account)
          : null;
      const invited = state.memberships.find(
        (item) => item.serverId === serverId && item.userId === userId,
      );
      if (!invited) return null;
      const token = state.tokens.find(
        (item) =>
          item.serverId === serverId &&
          item.userId === userId &&
          item.sent !== false &&
          item.expiresAt > now(),
      );
      return {
        invitedAt: new Date(invited.invitedAt).toISOString(),
        inviteExpiresAt: token ? new Date(token.expiresAt).toISOString() : null,
        acceptedAt: activated(invited)
          ? new Date(invited.acceptedAt).toISOString()
          : null,
        inviteStatus: token
          ? "pending"
          : activated(invited)
            ? "accepted"
            : "expired",
      };
    },
    // Enrollment alone never grants a browser session another membership's scope.
    membershipAllowed(serverId, userId, email) {
      const account = accountById(userId);
      if (account)
        return Boolean(
          activated(account) &&
          permitsServer(account, serverId) &&
          (email === undefined || account.email === normalizedEmail(email)),
        );
      return state.memberships.some(
        (item) =>
          item.serverId === serverId &&
          item.userId === userId &&
          activated(item) &&
          (email === undefined || item.email === normalizedEmail(email)) &&
          !state.retiredLegacyEmails.includes(item.email) &&
          !state.accounts.some(
            (linked) =>
              linked.email === item.email &&
              (!linked.legacyMembers?.some(
                (member) =>
                  member.serverId === serverId && member.userId === userId,
              ) ||
                linked.legacyPending !== true ||
                !permitsServer(linked, serverId)),
          ),
      );
    },
    configure: (input) =>
      serialize(async () => {
        const configuration = validateAccessConfiguration(
          input,
          state.configuration,
        );
        const reset =
          !configuration.enabled ||
          configuration.publicUrl !== state.configuration.publicUrl ||
          configuration.transport !== state.configuration.transport;
        await persist({
          ...cleaned(),
          configuration,
          ...(reset ? { sessions: [], tokens: [] } : {}),
        });
        return status();
      }),
    invite: ({ serverId, user }) =>
      serialize(async () => {
        requireReady();
        const email = normalizedEmail(user?.email);
        const record = { serverId, userId: user?.id, email };
        if (
          typeof serverId !== "string" ||
          !serverId ||
          typeof user?.id !== "string" ||
          !user.id ||
          !validEmail(email) ||
          !(await liveUser(record))
        )
          throw fail(404, "This subuser no longer exists.");
        const key = scopeKey(record);
        const previous = cleaned();
        if (
          previous.memberships.filter(
            (item) => item.email === email && scopeKey(item) !== key,
          ).length >= maxEmailMemberships
        )
          throw fail(
            400,
            "This email has reached the limit of 32 remote server memberships.",
          );
        const token = secret();
        const createdAt = now();
        const expiresAt = createdAt + invitationLifetime;
        await persist({
          ...previous,
          memberships: [
            ...previous.memberships.filter((item) => scopeKey(item) !== key),
            { ...record, invitedAt: createdAt },
          ],
          tokens: [
            ...previous.tokens.filter((item) => scopeKey(item) !== key),
            { ...record, hash: digest(token), createdAt, expiresAt },
          ],
          // A fresh link resets the password and every session including this member.
          sessions: previous.sessions.filter(
            (session) => !sessionIncludes(session, key),
          ),
        });
        return {
          invitationUrl: `${state.configuration.publicUrl}/#invite=${token}`,
          invitedAt: new Date(createdAt).toISOString(),
          inviteExpiresAt: new Date(expiresAt).toISOString(),
        };
      }),
    previewInvitation: (token) =>
      serialize(async () => {
        const record = await pendingInvitation(token);
        // Looking at an invitation proves only which account the link names.
        // Keep both the invitation and every server grant unchanged until the
        // password and activation can be committed together by accept().
        return {
          email: record.email,
          panelAddress: state.configuration.publicUrl,
          inviteExpiresAt: new Date(record.expiresAt).toISOString(),
        };
      }),
    accept: (token, password, req) =>
      serializeAuthentication(async () => {
        const record = await pendingInvitation(token);
        if (record?.accountId) {
          const account = accountById(record.accountId);
          if (!account || account.email !== record.email)
            throw fail(401, invalidLink);
          if (!validPassword(password))
            throw fail(400, "Choose a password with 12 to 128 characters.");
          const passwordHash = await hashPassword(password);
          const acceptedAt = Math.max(now(), (account.lastAcceptedAt ?? 0) + 1);
          const updated = {
            ...account,
            password: passwordHash,
            acceptedAt,
            lastAcceptedAt: acceptedAt,
            legacyPending: false,
            authRevision: randomUUID(),
          };
          const issued = createAccountSession(updated);
          const next = replaceAccount(cleaned(), updated);
          await persist({
            ...next,
            retiredLegacyEmails: [
              ...new Set([...next.retiredLegacyEmails, account.email]),
            ],
            memberships: next.memberships.filter(
              (item) => item.email !== account.email,
            ),
            tokens: next.tokens.filter(
              (item) =>
                item.accountId !== account.id && item.email !== account.email,
            ),
            sessions: [
              ...next.sessions.filter(
                (item) =>
                  item.accountId !== account.id && item.email !== account.email,
              ),
              issued.session,
            ],
          });
          return {
            token: issued.token,
            cookie: issued.cookie,
            session: accountSessionView(updated),
          };
        }
        if (!record || !enrolled(record)) throw fail(401, invalidLink);
        const user = await liveUser(record);
        if (!user) throw fail(401, invalidLink);
        if (!validPassword(password))
          throw fail(400, "Choose a password with 12 to 128 characters.");
        const passwordHash = await hashPassword(password);
        const key = scopeKey(record);
        const current = await authenticatedSession(req);
        // The invitation proves this membership; the existing cookie proves
        // only its live scopes. Sharing an email alone never grants access.
        const retained =
          current?.email === record.email && !current.accountId
            ? current.memberships
                .filter((scope) => scopeKey(scope) !== key)
                .map((scope) => ({ ...scope, email: current.email }))
            : [];
        const issued = createSession([record, ...retained]);
        const replacedHash = retained.length ? digest(cookieSecret(req)) : null;
        const next = cleaned();
        await persist({
          ...next,
          memberships: next.memberships.map((item) =>
            scopeKey(item) === key
              ? { ...item, acceptedAt: now(), password: passwordHash }
              : item,
          ),
          tokens: next.tokens.filter((item) => scopeKey(item) !== key),
          sessions: [
            ...next.sessions.filter(
              (session) =>
                !sessionIncludes(session, key) && session.hash !== replacedHash,
            ),
            issued.session,
          ],
        });
        return {
          token: issued.token,
          cookie: issued.cookie,
          session: sessionView(
            issued.session,
            user,
            issued.session.memberships,
          ),
        };
      }),
    login: (input) =>
      serializeAuthentication(async () => {
        const email = normalizedEmail(input?.email);
        const password = input?.password;
        if (!status().ready || !validEmail(email) || !validPassword(password))
          throw fail(401, invalidLogin);
        const account = state.accounts.find(
          (item) => item.email === email && activated(item),
        );
        if (account) {
          if (!(await matchesPassword(password, account.password)))
            throw fail(401, invalidLogin);
          const issued = createAccountSession(account);
          const next = cleaned();
          await persist({
            ...next,
            sessions: [...next.sessions, issued.session],
          });
          return {
            token: issued.token,
            cookie: issued.cookie,
            session: accountSessionView(account),
          };
        }
        const candidates = state.memberships
          .filter((item) => item.email === email && activated(item))
          .slice(0, maxEmailMemberships);
        const matched = [];
        let primaryUser;
        for (const record of candidates) {
          const user = await liveUser(record);
          if (await matchesPassword(password, record.password)) {
            if (!user) continue;
            primaryUser ??= user;
            matched.push(record);
          }
        }
        if (!candidates.length) await matchesPassword(password, dummyPassword);
        if (!matched.length) throw fail(401, invalidLogin);
        const issued = createSession(matched);
        const next = cleaned();
        await persist({
          ...next,
          sessions: [...next.sessions, issued.session],
        });
        return {
          token: issued.token,
          cookie: issued.cookie,
          session: sessionView(
            issued.session,
            primaryUser,
            issued.session.memberships,
          ),
        };
      }),
    async authenticate(req) {
      return closing ? null : authenticatedSession(req);
    },
    leave: (req, input) => {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        input.confirmed !== true ||
        typeof input.requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          input.requestId,
        ) ||
        Object.keys(input).some(
          (key) => !["confirmed", "requestId"].includes(key),
        )
      )
        return Promise.reject(
          fail(
            400,
            "Confirm leaving this panel and provide a valid request identifier.",
          ),
        );
      const token =
        typeof req?.headers?.authorization === "string"
          ? cookieSecret(req)
          : null;
      if (!token)
        return Promise.reject(fail(401, "Sign in before leaving this panel."));
      const requestId = input.requestId.toLowerCase();
      const requestHash = digest(`panel-leave-request:${requestId}`);
      const proofHash = digest(`panel-leave-proof:${token}:${requestId}`);
      return serialize(async () => {
        const next = cleaned();
        const receipt = next.leaveReceipts.find(
          (item) => item.requestHash === requestHash,
        );
        if (receipt) {
          if (receipt.proofHash !== proofHash)
            throw fail(403, "This leave request belongs to another sign-in.");
          return { left: true, requestId };
        }
        // Recheck inside the same queue as account grants, resets and removals.
        // A stale view or a caller-supplied identity can never select the victim.
        const session = await authenticatedSession(req);
        if (!session) throw fail(401, "Sign in before leaving this panel.");
        if (!session.accountId) {
          // Legacy credentials prove individual memberships, never ownership of
          // an email address. Retiring the email is safe only when this session
          // proves every legacy identity that the operation would revoke.
          const proven = new Set(sessionScopes(session).map(scopeKey));
          const provenServers = new Set(
            sessionScopes(session).map((scope) => scope.serverId),
          );
          const linkedAccounts = next.accounts.filter(
            (account) => account.email === session.email,
          );
          const legacyScopes = [
            ...next.memberships.filter(
              (member) => member.email === session.email,
            ),
            ...next.tokens.filter(
              (invitation) =>
                invitation.email === session.email && !invitation.accountId,
            ),
            ...next.sessions
              .filter(
                (other) => other.email === session.email && !other.accountId,
              )
              .flatMap(sessionScopes),
            ...listLegacyUsers()
              .filter(
                ({ user }) => normalizedEmail(user?.email) === session.email,
              )
              .map(({ serverId, user }) => ({ serverId, userId: user.id })),
            ...linkedAccounts.flatMap((account) => account.legacyMembers ?? []),
          ];
          if (
            legacyScopes.some((scope) => !proven.has(scopeKey(scope))) ||
            linkedAccounts.some(
              (account) =>
                account.legacyPending !== true ||
                account.acceptedAt ||
                account.password ||
                [
                  ...account.serverIds,
                  ...(account.creatorServerIds ?? []),
                  ...Object.keys(account.serverOverrides),
                ].some((serverId) => !provenServers.has(serverId)),
            )
          )
            throw fail(
              409,
              "This email has separate legacy identities. Ask the panel owner to consolidate the account before leaving this panel.",
            );
        }
        if (next.leaveReceipts.length >= maximumLeaveReceipts)
          throw fail(
            503,
            "The panel cannot retain another leave receipt yet. Try again later.",
          );
        await persist({
          ...withoutIdentity(next, session.email, session.accountId),
          leaveReceipts: [
            ...next.leaveReceipts,
            {
              requestHash,
              proofHash,
              expiresAt: now() + leaveReceiptLifetime,
            },
          ],
        });
        return { left: true, requestId };
      });
    },
    logout: (req) => {
      if (closing)
        return Promise.reject(fail(503, "Remote access is shutting down."));
      const token = cookieSecret(req);
      const hash = token ? digest(token) : null;
      // Unknown cookies need no queued disk write. Check again after acquiring
      // the queue so concurrent logout requests only invalidate the session once.
      if (!hash || !state.sessions.some((item) => item.hash === hash))
        return Promise.resolve(clearCookie);
      return serialize(async () => {
        if (state.sessions.some((item) => item.hash === hash)) {
          const next = cleaned();
          await persist({
            ...next,
            sessions: next.sessions.filter((item) => item.hash !== hash),
          });
        }
        return clearCookie;
      });
    },
    revoke: (serverId, userId, { created = false } = {}) =>
      serialize(async () => {
        const key = membershipKey(serverId, userId);
        const next = cleaned();
        const account =
          accountById(userId) ??
          state.accounts.find((item) =>
            item.legacyMembers?.some(
              (member) =>
                member.serverId === serverId && member.userId === userId,
            ),
          );
        if (account && account.id === userId) {
          const updated = {
            ...account,
            excludedServerIds: [
              ...new Set([...account.excludedServerIds, serverId]),
            ],
          };
          await persist({
            ...replaceAccount(next, updated),
            creationRevocations:
              created || account.creatorServerIds?.includes(serverId)
                ? [...new Set([...next.creationRevocations, key])]
                : next.creationRevocations,
          });
          return;
        }
        await persist({
          ...next,
          ...(account
            ? {
                accounts: next.accounts.map((item) =>
                  item.id === account.id
                    ? {
                        ...item,
                        excludedServerIds: [
                          ...new Set([...item.excludedServerIds, serverId]),
                        ],
                      }
                    : item,
                ),
              }
            : {}),
          creationRevocations:
            created ||
            next.memberships.some(
              (item) => scopeKey(item) === key && item.creationSource,
            )
              ? [...new Set([...next.creationRevocations, key])]
              : next.creationRevocations,
          memberships: next.memberships.filter(
            (item) => scopeKey(item) !== key,
          ),
          tokens: next.tokens.filter((item) => scopeKey(item) !== key),
          accessRevocations: withAccessRevocations(
            next,
            next.sessions.filter(
              (session) =>
                !session.accountId &&
                sessionIncludes(session, key) &&
                sessionScopes(session).every(
                  (scope) => scopeKey(scope) === key,
                ),
            ),
          ),
          sessions: next.sessions.flatMap((session) => {
            if (session.accountId || !sessionIncludes(session, key))
              return [session];
            const memberships = sessionScopes(session).filter(
              (scope) => scopeKey(scope) !== key,
            );
            return memberships.length
              ? [{ ...session, ...memberships[0], memberships }]
              : [];
          }),
        });
      }),
  };
}

// Ignore spoofed forwarding headers: only the gateway's actual peer is trusted.
export function createAccessRateLimiter({
  limit = 10,
  keyForRequest = (req) => req.socket?.remoteAddress || "unknown",
  windowMs = 15 * 60 * 1000,
  maxEntries = 10_000,
  now = Date.now,
} = {}) {
  const entries = new Map();
  return (req, res, next) => {
    const time = now();
    for (const [key, entry] of entries)
      if (entry.expiresAt <= time) entries.delete(key);
    const key = keyForRequest(req);
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxEntries) {
        res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
        return res
          .status(429)
          .json({ error: "Too many sign-in attempts. Try again later." });
      }
      entry = { count: 0, expiresAt: time + windowMs };
      entries.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > (typeof limit === "function" ? limit(req) : limit)) {
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil((entry.expiresAt - time) / 1000))),
      );
      return res
        .status(429)
        .json({ error: "Too many sign-in attempts. Try again later." });
    }
    next();
  };
}
