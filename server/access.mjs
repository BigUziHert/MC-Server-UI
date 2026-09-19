import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const SUBUSER_COOKIE = "__Host-mc-subuser";
const invitationLifetime = 24 * 60 * 60 * 1000;
const loginLifetime = 15 * 60 * 1000;
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const invalidLink =
  "This sign-in link is invalid or expired. Request a new email.";
const loginMessage =
  "If this email has an invitation, a sign-in link has been sent.";
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const validSecret = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const normalizedEmail = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
const validEmail = (value) =>
  value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const membershipKey = (serverId, userId) => JSON.stringify([serverId, userId]);
const clearCookie = `${SUBUSER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`;

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

function validateConfiguration(input, current) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw fail(400, "Enter valid remote access settings.");
  const result = { ...current };
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
  if (Object.hasOwn(input, "publicUrl")) {
    if (typeof input.publicUrl !== "string" || input.publicUrl.length > 2048)
      throw fail(400, "Enter the HTTPS origin of your remote panel.");
    const text = input.publicUrl.trim();
    if (!text) result.publicUrl = "";
    else {
      let url;
      try {
        url = new URL(text);
      } catch {
        /* Report a safe validation error. */
      }
      if (
        !url ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw fail(
          400,
          "Enter an HTTPS origin without a path, query, or credentials.",
        );
      result.publicUrl = url.origin;
    }
  }
  if (Object.hasOwn(input, "from")) {
    if (
      typeof input.from !== "string" ||
      input.from.length > 320 ||
      /[\r\n]/.test(input.from)
    )
      throw fail(400, "Enter a valid verified sender email address.");
    const sender = input.from.trim();
    const displayAddress = /^[^<>]+<([^<>]+)>$/.exec(sender);
    if (sender && !validEmail(displayAddress?.[1] ?? sender))
      throw fail(400, "Enter a valid verified sender email address.");
    result.from = sender;
  }
  if (Object.hasOwn(input, "apiKey")) {
    if (
      typeof input.apiKey !== "string" ||
      input.apiKey.length > 512 ||
      /[\r\n]/.test(input.apiKey)
    )
      throw fail(400, "Enter a valid Resend API key.");
    if (input.apiKey.trim()) result.apiKey = input.apiKey.trim();
  }
  if (input.clearApiKey === true) result.apiKey = "";
  if (result.enabled && (!result.publicUrl || !result.from || !result.apiKey))
    throw fail(
      400,
      "Enter the HTTPS panel address, verified sender, and Resend API key before enabling remote access.",
    );
  return result;
}

// The provider URL is fixed: settings cannot redirect API credentials elsewhere.
// API reference: https://resend.com/docs/api-reference/emails/send-email
export function createResendSender({ fetchMail = fetch } = {}) {
  return async (message, { apiKey }) => {
    try {
      const response = await fetchMail("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "MC-Server-UI",
        },
        body: JSON.stringify(message),
      });
      // Provider response bodies can contain submitted credentials or addresses.
      // Neither they nor transport errors are exposed to clients or logs.
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error("Email provider rejected the request.");
    } catch {
      throw fail(
        502,
        "The invitation email could not be sent. Check the sender and email provider settings.",
      );
    }
  };
}

/**
 * getUser(serverId, userId) must return the current user with resolved permissions.
 * listMemberships(email) returns [{ serverId, user, serverName }]. These callbacks
 * must read current records so deletion and permission changes take effect at once.
 */
export async function createAccessService({
  dataDir,
  getUser,
  listMemberships,
  sendMail = createResendSender(),
  now = Date.now,
}) {
  const storage = path.join(dataDir, "remote-access.json");
  let state = {
    version: 1,
    configuration: {
      enabled: false,
      publicUrl: "",
      from: "",
      apiKey: "",
      port: 3002,
    },
    memberships: [],
    tokens: [],
    sessions: [],
  };
  try {
    const saved = JSON.parse(await fs.readFile(storage, "utf8"));
    if (
      saved.version !== 1 ||
      !Array.isArray(saved.memberships) ||
      !Array.isArray(saved.tokens) ||
      !Array.isArray(saved.sessions)
    )
      throw new Error("Invalid access storage.");
    state = {
      ...saved,
      configuration: validateConfiguration(
        saved.configuration,
        state.configuration,
      ),
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
  const serialize = (operation) => {
    if (closing)
      return Promise.reject(fail(503, "Remote access is shutting down."));
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
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
      (token) => token.expiresAt > now() && token.sent,
    ),
    sessions: state.sessions.filter((session) => session.expiresAt > now()),
  });
  const status = () => {
    const { enabled, publicUrl, from, apiKey, port } = state.configuration;
    const emailConfigured = Boolean(from && apiKey);
    return {
      enabled,
      publicUrl,
      from,
      emailConfigured,
      port,
      ready: Boolean(enabled && publicUrl && emailConfigured),
    };
  };
  const requireReady = () => {
    if (!status().ready)
      throw fail(
        409,
        "Configure the HTTPS panel address and email sender, then enable remote access before inviting a subuser.",
      );
  };
  const liveUser = async (record) => {
    const user = await getUser(record.serverId, record.userId);
    return user && normalizedEmail(user.email) === record.email ? user : null;
  };
  const sessionView = (record, user) => ({
    role: "subuser",
    email: record.email,
    serverId: record.serverId,
    userId: record.userId,
    permissions: Array.isArray(user.permissions) ? [...user.permissions] : [],
  });
  const sendInvitation = async (
    { serverId, user, serverName },
    isLogin = false,
  ) => {
    requireReady();
    const email = normalizedEmail(user?.email);
    const record = { serverId, userId: user?.id, email };
    if (
      typeof serverId !== "string" ||
      !serverId ||
      typeof user?.id !== "string" ||
      !validEmail(email) ||
      !(await liveUser(record))
    )
      throw fail(404, "This subuser no longer exists.");
    const token = secret();
    const key = membershipKey(serverId, user.id);
    const createdAt = now();
    const expiresAt =
      createdAt + (isLogin ? loginLifetime : invitationLifetime);
    const pendingToken = {
      ...record,
      hash: digest(token),
      createdAt,
      expiresAt,
      sent: false,
    };
    const previous = cleaned();
    // Persist before contacting the mail service; a crash cannot create a usable
    // email token whose state was never recorded. Unconfirmed sends stay unusable.
    await persist({ ...previous, tokens: [...previous.tokens, pendingToken] });
    const link = `${state.configuration.publicUrl}/#invite=${token}`;
    const name = String(serverName || "your Minecraft server")
      .replace(/[\r\n]/g, " ")
      .slice(0, 160);
    const subject = isLogin
      ? `Sign in to ${name}`
      : `You are invited to control ${name}`;
    const introduction = isLogin
      ? `Sign in to ${name}.`
      : `You have been invited to manage ${name} from your phone or browser.`;
    const expiry = isLogin ? "15 minutes" : "24 hours";
    try {
      await sendMail(
        {
          from: state.configuration.from,
          to: [email],
          subject,
          text: `${introduction}\n\nOpen this link to sign in:\n${link}\n\nThis link works once and expires in ${expiry}. Keep it private. If you did not expect this email, you can ignore it.`,
          html: `<p>${escapeHtml(introduction)}</p><p><a href="${escapeHtml(link)}">Open server controls</a></p><p>This link works once and expires in ${expiry}. Keep it private. If you did not expect this email, you can ignore it.</p>`,
        },
        { apiKey: state.configuration.apiKey },
      );
    } catch {
      await persist(previous);
      throw fail(
        502,
        "The invitation email could not be sent. Check the sender and email provider settings.",
      );
    }
    // Successful resends replace outstanding links, while current sessions remain.
    const priorMembership = previous.memberships.find(
      (item) =>
        membershipKey(item.serverId, item.userId) === key &&
        item.email === email,
    );
    const memberships = previous.memberships.filter(
      (item) => membershipKey(item.serverId, item.userId) !== key,
    );
    memberships.push({
      ...record,
      invitedAt: createdAt,
      ...(priorMembership?.acceptedAt
        ? { acceptedAt: priorMembership.acceptedAt }
        : {}),
    });
    await persist({
      ...previous,
      memberships,
      tokens: [
        ...previous.tokens.filter(
          (item) => membershipKey(item.serverId, item.userId) !== key,
        ),
        { ...pendingToken, sent: true },
      ],
    });
    return {
      invitedAt: new Date(createdAt).toISOString(),
      inviteExpiresAt: new Date(expiresAt).toISOString(),
    };
  };

  return {
    status,
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
          item.sent &&
          item.expiresAt > now(),
      );
      return {
        invitedAt: new Date(invited.invitedAt).toISOString(),
        inviteExpiresAt: token ? new Date(token.expiresAt).toISOString() : null,
        acceptedAt: invited.acceptedAt
          ? new Date(invited.acceptedAt).toISOString()
          : null,
        inviteStatus: invited.acceptedAt
          ? "accepted"
          : token
            ? "pending"
            : "expired",
      };
    },
    // This enrollment lookup is synchronous for fleet filtering. The caller must
    // pair it with the current user record; authentication always does that itself.
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
        const configuration = validateConfiguration(input, state.configuration);
        // Disabling access or changing the origin invalidates existing browser sessions.
        const reset =
          !configuration.enabled ||
          configuration.publicUrl !== state.configuration.publicUrl;
        await persist({
          ...cleaned(),
          configuration,
          ...(reset ? { sessions: [], tokens: [] } : {}),
        });
        return status();
      }),
    invite: (membership) => serialize(() => sendInvitation(membership)),
    accept: (token) =>
      serialize(async () => {
        if (!status().ready || !validSecret(token))
          throw fail(401, invalidLink);
        const hash = digest(token);
        const record = state.tokens.find(
          (item) => item.hash === hash && item.sent && item.expiresAt > now(),
        );
        if (!record) throw fail(401, invalidLink);
        const user = await liveUser(record);
        if (!user) throw fail(401, invalidLink);
        const value = secret();
        const session = {
          serverId: record.serverId,
          userId: record.userId,
          email: record.email,
          hash: digest(value),
          expiresAt: now() + sessionLifetime,
        };
        const next = cleaned();
        await persist({
          ...next,
          memberships: next.memberships.map((item) =>
            item.serverId === record.serverId && item.userId === record.userId
              ? { ...item, acceptedAt: now() }
              : item,
          ),
          tokens: next.tokens.filter((item) => item.hash !== hash),
          sessions: [...next.sessions, session],
        });
        return {
          cookie: `${SUBUSER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${sessionLifetime / 1000}`,
          session: sessionView(session, user),
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
      const user = await liveUser(record);
      return user ? sessionView(record, user) : null;
    },
    logout: (req) =>
      serialize(async () => {
        const token = cookieSecret(req);
        if (token) {
          const hash = digest(token);
          await persist({
            ...cleaned(),
            sessions: state.sessions.filter(
              (item) => item.hash !== hash && item.expiresAt > now(),
            ),
          });
        }
        return clearCookie;
      }),
    revoke: (serverId, userId) =>
      serialize(async () => {
        const key = membershipKey(serverId, userId);
        const keep = (record) =>
          membershipKey(record.serverId, record.userId) !== key;
        const next = cleaned();
        await persist({
          ...next,
          memberships: next.memberships.filter(keep),
          tokens: next.tokens.filter(keep),
          sessions: next.sessions.filter(keep),
        });
      }),
    requestLogin: (input) =>
      serialize(async () => {
        const email = normalizedEmail(input);
        if (status().ready && validEmail(email)) {
          const memberships = await listMemberships(email);
          for (const membership of memberships) {
            const invited = state.memberships.some(
              (item) =>
                item.email === email &&
                item.serverId === membership.serverId &&
                item.userId === membership.user?.id,
            );
            if (!invited) continue;
            try {
              await sendInvitation(membership, true);
            } catch {
              /* Keep outward responses identical for unknown or undeliverable mail. */
            }
          }
        }
        return { message: loginMessage };
      }),
  };
}

// Keep the gateway's actual peer address: arbitrary X-Forwarded-For headers must
// not let unauthenticated callers bypass limits. A proxy shares one conservative
// bucket unless the deployment adds a separately authenticated proxy boundary.
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
