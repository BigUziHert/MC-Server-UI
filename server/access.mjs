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
  now = Date.now,
}) {
  const storage = path.join(dataDir, "remote-access.json");
  let state = {
    version: 2,
    configuration: validateAccessConfiguration({}),
    memberships: [],
    tokens: [],
    sessions: [],
  };
  try {
    const saved = JSON.parse(await fs.readFile(storage, "utf8"));
    if (
      ![1, 2].includes(saved.version) ||
      !Array.isArray(saved.memberships) ||
      !Array.isArray(saved.tokens) ||
      !Array.isArray(saved.sessions)
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
      version: 2,
      configuration: validateAccessConfiguration(configuration),
      memberships: saved.memberships,
      tokens: saved.tokens,
      sessions: saved.sessions,
    };
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
  const liveUser = async (record) => {
    const user = await getUser(record.serverId, record.userId);
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

  return {
    status,
    validateConfiguration: (input) =>
      validateAccessConfiguration(input, state.configuration),
    async close() {
      closing = true;
      await queue;
    },
    invitationState(serverId, userId) {
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
      return state.memberships.some(
        (item) =>
          item.serverId === serverId &&
          item.userId === userId &&
          (email === undefined || item.email === normalizedEmail(email)),
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
    accept: (token, password) =>
      serializeAuthentication(async () => {
        if (!status().ready || !validSecret(token))
          throw fail(401, invalidLink);
        const hash = digest(token);
        const record = state.tokens.find(
          (item) =>
            item.hash === hash && item.sent !== false && item.expiresAt > now(),
        );
        if (!record || !enrolled(record)) throw fail(401, invalidLink);
        const user = await liveUser(record);
        if (!user) throw fail(401, invalidLink);
        if (!validPassword(password))
          throw fail(400, "Choose a password with 12 to 128 characters.");
        const passwordHash = await hashPassword(password);
        const issued = createSession([record]);
        const next = cleaned();
        const key = scopeKey(record);
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
              (session) => !sessionIncludes(session, key),
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
      if (closing || !status().ready) return null;
      const token = cookieSecret(req);
      if (!token) return null;
      const record = state.sessions.find(
        (item) => item.hash === digest(token) && item.expiresAt > now(),
      );
      if (!record) return null;
      const memberships = [];
      for (const scope of sessionScopes(record).slice(0, maxEmailMemberships)) {
        const membership = { ...scope, email: record.email };
        if (enrolled(membership) && (await liveUser(membership)))
          memberships.push(scope);
      }
      // A deleted primary invalidates the session; never expand or rehome it.
      if (!memberships.some((scope) => scopeKey(scope) === scopeKey(record)))
        return null;
      const user = await liveUser(record);
      return user ? sessionView(record, user, memberships) : null;
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
    revoke: (serverId, userId) =>
      serialize(async () => {
        const key = membershipKey(serverId, userId);
        const next = cleaned();
        await persist({
          ...next,
          memberships: next.memberships.filter(
            (item) => scopeKey(item) !== key,
          ),
          tokens: next.tokens.filter((item) => scopeKey(item) !== key),
          sessions: next.sessions.filter(
            (session) => !sessionIncludes(session, key),
          ),
        });
      }),
  };
}

// Ignore spoofed forwarding headers: only the gateway's actual peer is trusted.
export function createAccessRateLimiter({
  limit = 10,
  windowMs = 15 * 60 * 1000,
  maxEntries = 10_000,
  now = Date.now,
} = {}) {
  const entries = new Map();
  return (req, res, next) => {
    const time = now();
    for (const [key, entry] of entries)
      if (entry.expiresAt <= time) entries.delete(key);
    const key = req.socket?.remoteAddress || "unknown";
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
    if (entry.count > limit) {
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
