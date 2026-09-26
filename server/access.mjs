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
import permissionCatalog from "../shared/subuser-permissions.json" with { type: "json" };

export const SUBUSER_COOKIE = "__Host-mc-subuser";
const invitationLifetime = 24 * 60 * 60 * 1000;
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const maxEmailMemberships = 32;
const invalidLink =
  "This invitation link is invalid or expired. Ask the server owner for a new link.";
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
const membershipKey = (serverId, userId) => JSON.stringify([serverId, userId]);
const scopeKey = (record) => membershipKey(record.serverId, record.userId);
const clearCookie = `${SUBUSER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`;
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
    if (input.transport !== "direct" && input.transport !== "proxy")
      throw fail(400, "Choose direct HTTPS or an HTTPS reverse proxy.");
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
  return result;
}

/** getUser reads current memberships and permissions. Email never proves access to other memberships. */
export async function createAccessService({
  dataDir,
  getUser,
  listServerIds = () => [],
  listLegacyUsers = () => [],
  now = Date.now,
}) {
  const storage = path.join(dataDir, "remote-access.json");
  let state = {
    version: 3,
    configuration: validateAccessConfiguration({}),
    memberships: [],
    tokens: [],
    sessions: [],
    creationRevocations: [],
    accounts: [],
    retiredLegacyEmails: [],
  };
  try {
    const saved = JSON.parse(await fs.readFile(storage, "utf8"));
    if (
      ![1, 2, 3].includes(saved.version) ||
      !Array.isArray(saved.memberships) ||
      !Array.isArray(saved.tokens) ||
      !Array.isArray(saved.sessions) ||
      (saved.version === 3 &&
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
      version: 3,
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
    };
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
      accountIds.add(account.id);
      accountEmails.add(account.email);
    }
  } catch (cause) {
    if (cause.code !== "ENOENT")
      throw fail(
        500,
        "Remote access settings could not be loaded. Check the local access data file.",
      );
  }
  let queue = Promise.resolve();
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
  const cleaned = () => ({
    ...state,
    tokens: state.tokens.filter(
      (token) => token.expiresAt > now() && token.sent !== false,
    ),
    sessions: state.sessions.filter((session) => session.expiresAt > now()),
  });
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
    (account.accessMode === "all" || account.serverIds.includes(serverId));
  const accountPermissions = (account, serverId) =>
    account.serverOverrides[serverId]?.permissions ?? account.permissions;
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
      account.serverOverrides[serverId] = {
        permissions: [
          ...new Set([
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
      acceptedAt: account.acceptedAt
        ? new Date(account.acceptedAt).toISOString()
        : null,
      inviteStatus: token
        ? "pending"
        : account.acceptedAt
          ? "accepted"
          : "expired",
    };
  };
  const publicAccount = (account) => {
    if (!account) return null;
    const { password, authRevision, ...visible } = account;
    return structuredClone({ ...visible, ...accountInvitation(account) });
  };
  const findAccount = (id) =>
    accountById(id) ?? legacyAccounts().find((account) => account.id === id);
  const promoted = (account) =>
    account.legacy
      ? {
          ...account,
          id: randomUUID(),
          legacy: false,
          legacyPending: true,
          createdAt: new Date(now()).toISOString(),
          authRevision: randomUUID(),
        }
      : { ...account };
  const validateAccount = (input, current) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw fail(400, "Enter valid panel account settings.");
    const allowed = new Set([
      "email",
      "permissions",
      "hostPermissions",
      "accessMode",
      "serverIds",
      "excludedServerIds",
      "serverOverrides",
      "role",
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw fail(400, "Choose valid panel account settings.");
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
      accessMode: "all",
      serverIds: [],
      excludedServerIds: [],
      serverOverrides: {},
      ...current,
      email,
    };
    if (Object.hasOwn(input, "permissions"))
      account.permissions = validPermissions(input.permissions);
    else if (!current && input.role)
      account.permissions = validPermissions(
        permissionCatalog.roleDefaults[input.role] ?? [],
      );
    if (Object.hasOwn(input, "hostPermissions"))
      account.hostPermissions = validPermissions(
        input.hostPermissions,
        hostPermissionIds,
      );
    if (Object.hasOwn(input, "accessMode")) {
      if (!["all", "selected"].includes(input.accessMode))
        throw fail(400, "Choose all servers or selected servers.");
      account.accessMode = input.accessMode;
    }
    const knownIds = new Set([
      ...serverIds(),
      ...(current?.serverIds ?? []),
      ...(current?.excludedServerIds ?? []),
      ...Object.keys(current?.serverOverrides ?? {}),
    ]);
    const validIds = (ids) => {
      if (
        !Array.isArray(ids) ||
        ids.length > 10000 ||
        ids.some((id) => typeof id !== "string" || !knownIds.has(id))
      )
        throw fail(400, "Choose existing servers for this account.");
      return [...new Set(ids)];
    };
    for (const field of ["serverIds", "excludedServerIds"])
      if (Object.hasOwn(input, field)) account[field] = validIds(input[field]);
    if (Object.hasOwn(input, "serverOverrides")) {
      if (
        !input.serverOverrides ||
        typeof input.serverOverrides !== "object" ||
        Array.isArray(input.serverOverrides)
      )
        throw fail(400, "Enter valid per-server permissions.");
      validIds(Object.keys(input.serverOverrides));
      account.serverOverrides = Object.fromEntries(
        Object.entries(input.serverOverrides).map(([id, value]) => {
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.keys(value).some(
              (key) => !["permissions", "hostPermissions"].includes(key),
            )
          )
            throw fail(400, "Enter valid per-server permissions.");
          return [
            id,
            {
              permissions: validPermissions(value.permissions),
              ...(Object.hasOwn(value, "hostPermissions")
                ? {
                    hostPermissions: validPermissions(
                      value.hostPermissions,
                      hostPermissionIds,
                    ),
                  }
                : {}),
            },
          ];
        }),
      );
    }
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
      session: {
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
    if (!token) return null;
    const record = state.sessions.find(
      (item) => item.hash === digest(token) && item.expiresAt > now(),
    );
    if (!record) return null;
    if (record.accountId) {
      const account = accountById(record.accountId);
      return account?.acceptedAt &&
        account.password &&
        account.email === record.email &&
        account.authRevision === record.authRevision
        ? accountSessionView(account)
        : null;
    }
    const memberships = [];
    for (const scope of sessionScopes(record).slice(0, maxEmailMemberships)) {
      const membership = { ...scope, email: record.email };
      if (enrolled(membership) && (await liveUser(membership)))
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

  return {
    status,
    hostAuthority,
    account: (id) => publicAccount(findAccount(id)),
    listAccounts: () =>
      [...state.accounts, ...legacyAccounts()].map(publicAccount),
    userForServer,
    usersForServer: (serverId) =>
      state.accounts
        .map((account) => userForServer(serverId, account.id))
        .filter(Boolean),
    resolveUser,
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
        const next = cleaned();
        await persist({
          ...next,
          accounts: next.accounts.filter((account) => account.id !== id),
          retiredLegacyEmails: [
            ...new Set([...next.retiredLegacyEmails, current.email]),
          ],
          memberships: next.memberships.filter(
            (member) => member.email !== current.email,
          ),
          tokens: next.tokens.filter(
            (token) => token.email !== current.email && token.accountId !== id,
          ),
          sessions: next.sessions.filter(
            (session) =>
              session.email !== current.email && session.accountId !== id,
          ),
        });
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
        const user = await liveUser(target);
        if (!user)
          throw fail(
            409,
            "The created server's access record is unavailable. Retry this request.",
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
        const hash = digest(cookieSecret(req));
        await persist({
          ...next,
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
        acceptedAt: invited.acceptedAt
          ? new Date(invited.acceptedAt).toISOString()
          : null,
        inviteStatus: token
          ? "pending"
          : invited.acceptedAt
            ? "accepted"
            : "expired",
      };
    },
    // Enrollment alone never grants a browser session another membership's scope.
    membershipAllowed(serverId, userId, email) {
      const account = accountById(userId);
      if (account)
        return Boolean(
          account.acceptedAt &&
          account.password &&
          permitsServer(account, serverId) &&
          (email === undefined || account.email === normalizedEmail(email)),
        );
      return state.memberships.some(
        (item) =>
          item.serverId === serverId &&
          item.userId === userId &&
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
    accept: (token, password, req) =>
      serializeAuthentication(async () => {
        if (!status().ready || !validSecret(token))
          throw fail(401, invalidLink);
        const hash = digest(token);
        const record = state.tokens.find(
          (item) =>
            item.hash === hash && item.sent !== false && item.expiresAt > now(),
        );
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
          (item) => item.email === email && item.password && item.acceptedAt,
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
            cookie: issued.cookie,
            session: accountSessionView(account),
          };
        }
        const candidates = state.memberships
          .filter((item) => item.email === email && item.password)
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
