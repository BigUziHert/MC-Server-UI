import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAccessService,
  createAccessRateLimiter,
  createResendSender,
  SUBUSER_COOKIE,
} from "./access.mjs";

const settings = {
  enabled: true,
  publicUrl: "https://panel.example.com",
  from: "MC Server <server@example.com>",
  apiKey: "re_test_private_key",
};
const request = (cookie) => ({ headers: { cookie: cookie.split(";")[0] } });
const tokenFrom = (mail) => /#invite=([A-Za-z0-9_-]{43})/.exec(mail.text)[1];

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-access-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let time = Date.UTC(2026, 8, 19);
  const users = new Map([
    [
      "server-a:user-a",
      {
        id: "user-a",
        email: "sister@example.com",
        role: "admin",
        permissions: ["control.start", "control.stop"],
      },
    ],
  ]);
  const messages = [];
  let mailFailure;
  const getUser = (serverId, userId) => users.get(`${serverId}:${userId}`);
  const dependencies = {
    dataDir: root,
    getUser,
    listMemberships: (email) =>
      [...users.entries()]
        .filter(([, user]) => user.email === email)
        .map(([key, user]) => ({
          serverId: key.split(":")[0],
          user,
          serverName: "Family Minecraft",
        })),
    sendMail: async (message) => {
      if (mailFailure) throw new Error(mailFailure);
      messages.push(message);
    },
    now: () => time,
    ...options,
  };
  const access = await createAccessService(dependencies);
  await access.configure(settings);
  return {
    access,
    root,
    users,
    messages,
    getUser,
    failMail: (message) => {
      mailFailure = message;
    },
    advance: (milliseconds) => {
      time += milliseconds;
    },
    reload: () => createAccessService(dependencies),
    invite: (extra = {}) =>
      access.invite({
        serverId: "server-a",
        user: getUser("server-a", "user-a"),
        serverName: "Family Minecraft",
        ...extra,
      }),
  };
}

test("invitation uses one-time secret, persists only hashes, and authenticates current permissions", async (t) => {
  const f = await fixture(t);
  const invitation = await f.invite();
  assert.equal(f.messages.length, 1);
  const token = tokenFrom(f.messages[0]);
  assert.equal(f.messages[0].to[0], "sister@example.com");
  assert.match(f.messages[0].text, /https:\/\/panel\.example\.com\/#invite=/);
  assert.doesNotMatch(JSON.stringify(invitation), new RegExp(token));
  const attempts = await Promise.allSettled([
    f.access.accept(token),
    f.access.accept(token),
  ]);
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["fulfilled", "rejected"],
  );
  assert.equal(attempts[1].reason.status, 401);
  const { session, cookie } = attempts[0].value;
  assert.deepEqual(session, {
    role: "subuser",
    email: "sister@example.com",
    serverId: "server-a",
    userId: "user-a",
    permissions: ["control.start", "control.stop"],
  });
  assert.match(
    cookie,
    /^__Host-mc-subuser=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=604800$/,
  );
  const saved = await fs.readFile(
    path.join(f.root, "remote-access.json"),
    "utf8",
  );
  assert.equal(saved.includes(token), false);
  assert.equal(saved.includes(cookie.split("=")[1].split(";")[0]), false);
  const reloaded = await f.reload();
  assert.deepEqual(await reloaded.authenticate(request(cookie)), session);
  f.getUser("server-a", "user-a").permissions = ["control.start"];
  assert.deepEqual((await reloaded.authenticate(request(cookie))).permissions, [
    "control.start",
  ]);
  assert.equal(
    reloaded.invitationState("server-a", "user-a").inviteStatus,
    "accepted",
  );
  f.users.delete("server-a:user-a");
  assert.equal(await reloaded.authenticate(request(cookie)), null);
});

test("legacy local records and forged cookies cannot sign in or request first invitations", async (t) => {
  const f = await fixture(t);
  assert.equal(f.access.invitationState("server-a", "user-a"), null);
  assert.equal(f.access.membershipAllowed("server-a", "user-a"), false);
  const known = await f.access.requestLogin("sister@example.com");
  const unknown = await f.access.requestLogin("stranger@example.com");
  const malformed = await f.access.requestLogin({
    email: "sister@example.com",
  });
  assert.deepEqual(known, unknown);
  assert.deepEqual(known, malformed);
  assert.equal(f.messages.length, 0);
  assert.equal(
    await f.access.authenticate({
      headers: { cookie: `${SUBUSER_COOKIE}=${"a".repeat(43)}` },
    }),
    null,
  );
  assert.equal(
    await f.access.authenticate({
      headers: { authorization: "Bearer user-a" },
    }),
    null,
  );
  await assert.rejects(f.access.accept("user-a"), { status: 401 });
});

test("expired invitations and sessions reject authentication", async (t) => {
  const f = await fixture(t);
  await f.invite();
  f.advance(24 * 60 * 60 * 1000);
  assert.equal(
    f.access.invitationState("server-a", "user-a").inviteStatus,
    "expired",
  );
  await assert.rejects(f.access.accept(tokenFrom(f.messages[0])), {
    status: 401,
  });
  await f.invite();
  const signedIn = await f.access.accept(tokenFrom(f.messages[1]));
  f.advance(7 * 24 * 60 * 60 * 1000);
  assert.equal(await f.access.authenticate(request(signedIn.cookie)), null);
});

test("failed resend preserves usable earlier link; successful resend invalidates it", async (t) => {
  const f = await fixture(t);
  await f.invite();
  const first = tokenFrom(f.messages[0]);
  f.failMail("provider leaked re_test_private_key and secret token");
  await assert.rejects(
    f.invite(),
    (error) =>
      error.status === 502 &&
      !/re_test_private_key|secret token/.test(error.message),
  );
  const stored = JSON.parse(
    await fs.readFile(path.join(f.root, "remote-access.json"), "utf8"),
  );
  assert.equal(stored.tokens.length, 1);
  const signedIn = await f.access.accept(first);
  f.failMail(null);
  await f.invite();
  const second = tokenFrom(f.messages[1]);
  await f.invite();
  await assert.rejects(f.access.accept(second), { status: 401 });
  assert.ok(
    await f.access.authenticate(request(signedIn.cookie)),
    "resending does not revoke active sessions",
  );
  assert.ok((await f.access.accept(tokenFrom(f.messages[2]))).session);
});

test("failed initial delivery never enrolls a legacy user or leaves a usable token", async (t) => {
  const f = await fixture(t);
  f.failMail("bad sender");
  await assert.rejects(f.invite(), { status: 502 });
  assert.equal(f.access.membershipAllowed("server-a", "user-a"), false);
  assert.equal(f.access.invitationState("server-a", "user-a"), null);
  const saved = JSON.parse(
    await fs.readFile(path.join(f.root, "remote-access.json"), "utf8"),
  );
  assert.deepEqual(saved.tokens, []);
});

test("requesting sign-in emails only previously invited memberships and hides delivery failure", async (t) => {
  const f = await fixture(t);
  f.users.set("server-b:user-b", {
    id: "user-b",
    email: "sister@example.com",
    permissions: ["control.restart"],
  });
  await f.invite();
  const result = await f.access.requestLogin(" SISTER@example.com ");
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[1].text, /15 minutes/);
  const token = tokenFrom(f.messages[1]);
  f.advance(15 * 60 * 1000);
  await assert.rejects(f.access.accept(token), { status: 401 });
  f.failMail("provider secret response");
  assert.deepEqual(await f.access.requestLogin("sister@example.com"), result);
  assert.deepEqual(await f.access.requestLogin("unknown@example.com"), result);
});

test("logout and explicit membership revocation remove credentials permanently", async (t) => {
  const f = await fixture(t);
  await f.invite();
  const first = await f.access.accept(tokenFrom(f.messages[0]));
  assert.match(await f.access.logout(request(first.cookie)), /Max-Age=0/);
  assert.equal(await f.access.authenticate(request(first.cookie)), null);
  await f.invite();
  const second = await f.access.accept(tokenFrom(f.messages[1]));
  await f.invite();
  const outstanding = tokenFrom(f.messages[2]);
  await f.access.revoke("server-a", "user-a");
  assert.equal(await f.access.authenticate(request(second.cookie)), null);
  assert.equal(f.access.membershipAllowed("server-a", "user-a"), false);
  await assert.rejects(f.access.accept(outstanding), { status: 401 });
  const reloaded = await f.reload();
  assert.equal(await reloaded.authenticate(request(second.cookie)), null);
});

test("changing the email prevents old sessions, links and enrollment from following it", async (t) => {
  const f = await fixture(t);
  await f.invite();
  const { cookie } = await f.access.accept(tokenFrom(f.messages[0]));
  await f.invite();
  f.getUser("server-a", "user-a").email = "someone-else@example.com";
  assert.equal(await f.access.authenticate(request(cookie)), null);
  await assert.rejects(f.access.accept(tokenFrom(f.messages[1])), {
    status: 401,
  });
  assert.equal(
    f.access.membershipAllowed(
      "server-a",
      "user-a",
      "someone-else@example.com",
    ),
    false,
  );
  await f.access.requestLogin("someone-else@example.com");
  assert.equal(f.messages.length, 2);
});

test("settings keep API keys private, preserve blank keys, and reject unsafe origins", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.access.status(), {
    enabled: true,
    publicUrl: "https://panel.example.com",
    from: settings.from,
    emailConfigured: true,
    port: 3002,
    ready: true,
  });
  const updated = await f.access.configure({ apiKey: "", port: 3443 });
  assert.equal(updated.emailConfigured, true);
  assert.equal(updated.port, 3443);
  assert.equal(JSON.stringify(updated).includes("re_test"), false);
  for (const publicUrl of [
    "http://panel.example.com",
    "https://u:p@panel.example.com",
    "https://panel.example.com/path",
    "https://panel.example.com/?token=x",
    "https://panel.example.com/#hash",
    "garbage",
  ]) {
    await assert.rejects(f.access.configure({ publicUrl }), { status: 400 });
  }
  await assert.rejects(
    f.access.configure({
      from: "sender@example.com\r\nBcc: thief@example.com",
    }),
    { status: 400 },
  );
  await assert.rejects(f.access.configure({ port: 80 }), { status: 400 });
  await assert.rejects(
    f.access.configure({ apiKey: "secret\r\nInjected: yes" }),
    { status: 400 },
  );
  assert.equal(
    (await f.access.configure({ publicUrl: "https://panel.example.com/" }))
      .publicUrl,
    "https://panel.example.com",
  );
  await assert.rejects(f.access.configure({ clearApiKey: true }), {
    status: 400,
  });
  assert.equal(
    (await f.access.configure({ clearApiKey: true, enabled: false }))
      .emailConfigured,
    false,
  );
  await assert.rejects(f.access.configure({ enabled: true }), { status: 400 });
  await assert.rejects(f.invite(), { status: 409 });
});

test("disable and origin changes invalidate sessions even after re-enabling", async (t) => {
  const f = await fixture(t);
  await f.invite();
  const first = await f.access.accept(tokenFrom(f.messages[0]));
  await f.access.configure({ enabled: false });
  await f.access.configure({ enabled: true });
  assert.equal(await f.access.authenticate(request(first.cookie)), null);
  await f.invite();
  const second = await f.access.accept(tokenFrom(f.messages[1]));
  await f.access.configure({ publicUrl: "https://other.example.com" });
  assert.equal(await f.access.authenticate(request(second.cookie)), null);
});

test("email HTML escapes server names and duplicate session cookies fail closed", async (t) => {
  const f = await fixture(t);
  await f.invite({
    serverName: '<script>alert("hello")</script>\r\nHeader: value',
  });
  assert.doesNotMatch(f.messages[0].html, /<script>/);
  assert.doesNotMatch(f.messages[0].subject, /[\r\n]/);
  assert.match(f.messages[0].html, /&lt;script&gt;/);
  const { cookie } = await f.access.accept(tokenFrom(f.messages[0]));
  const pair = cookie.split(";")[0];
  assert.equal(
    await f.access.authenticate({ headers: { cookie: `${pair}; ${pair}` } }),
    null,
  );
  const session = await f.access.authenticate(request(cookie));
  session.permissions.push("user.delete");
  assert.equal(
    (await f.access.authenticate(request(cookie))).permissions.includes(
      "user.delete",
    ),
    false,
  );
});

test("unconfirmed tokens on disk remain invalid after an interrupted delivery", async (t) => {
  let release;
  const sending = new Promise((resolve) => {
    release = resolve;
  });
  let pendingMail;
  const f = await fixture(t, {
    sendMail: async (message) => {
      pendingMail = message;
      await sending;
    },
  });
  const pending = f.invite();
  while (!pendingMail) await new Promise((resolve) => setImmediate(resolve));
  const reloaded = await f.reload();
  await assert.rejects(reloaded.accept(tokenFrom(pendingMail)), {
    status: 401,
  });
  release();
  await pending;
});

test("shutdown drains an in-flight email and rejects new operations", async (t) => {
  let release;
  const sending = new Promise((resolve) => {
    release = resolve;
  });
  let pendingMail;
  const f = await fixture(t, {
    sendMail: async (message) => {
      pendingMail = message;
      await sending;
    },
  });
  const pending = f.invite();
  while (!pendingMail) await new Promise((resolve) => setImmediate(resolve));
  let closed = false;
  const closing = f.access.close().then(() => {
    closed = true;
  });
  await assert.rejects(f.invite(), { status: 503 });
  await assert.rejects(f.access.configure({ enabled: false }), { status: 503 });
  assert.equal(closed, false);
  release();
  await pending;
  await closing;
  assert.equal(closed, true);
  const reloaded = await f.reload();
  const { cookie } = await reloaded.accept(tokenFrom(pendingMail));
  assert.equal(await f.access.authenticate(request(cookie)), null);
});

test("Resend uses fixed HTTPS endpoint, disables redirects, and sanitizes response errors", async () => {
  const calls = [];
  const message = {
    from: "server@example.com",
    to: ["sister@example.com"],
    subject: "Invitation",
    text: "Token",
  };
  const send = createResendSender({
    fetchMail: async (...args) => {
      calls.push(args);
      return { ok: true };
    },
  });
  await send(message, { apiKey: "private-key" });
  assert.equal(calls[0][0], "https://api.resend.com/emails");
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].headers.Authorization, "Bearer private-key");
  assert.deepEqual(JSON.parse(calls[0][1].body), message);
  for (const fetchMail of [
    async () => ({ ok: false }),
    async () => {
      throw new Error("private-key provider response");
    },
  ]) {
    await assert.rejects(
      createResendSender({ fetchMail })(message, { apiKey: "private-key" }),
      (error) => error.status === 502 && !error.message.includes("private-key"),
    );
  }
});

test("rate limiter ignores spoofed forwarding headers and recovers after its window", () => {
  let now = 1000;
  const limit = createAccessRateLimiter({
    limit: 2,
    windowMs: 10_000,
    maxEntries: 2,
    now: () => now,
  });
  let allowed = 0;
  const response = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(value) {
      this.code = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
  const attempt = (peer, forwarded) =>
    limit(
      {
        socket: { remoteAddress: peer },
        headers: { "x-forwarded-for": forwarded },
      },
      response,
      () => allowed++,
    );
  attempt("127.0.0.1", "1.2.3.4");
  attempt("127.0.0.1", "2.3.4.5");
  attempt("127.0.0.1", "3.4.5.6");
  assert.equal(allowed, 2);
  assert.equal(response.code, 429);
  assert.equal(response.headers["Retry-After"], "10");
  attempt("192.0.2.1", "");
  attempt("192.0.2.2", "");
  assert.equal(
    allowed,
    3,
    "full limiter fails closed without unbounded storage",
  );
  now += 10_000;
  attempt("127.0.0.1", "4.5.6.7");
  assert.equal(allowed, 4);
});
