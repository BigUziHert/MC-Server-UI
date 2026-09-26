import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAccessService,
  createAccessRateLimiter,
  validateAccessConfiguration,
  SUBUSER_COOKIE,
} from "./access.mjs";

const settings = {
  enabled: true,
  publicUrl: "https://203.0.113.17:3002",
  transport: "direct",
};
const password = "sister private password";
const otherPassword = "a different private password";
const request = (cookie) => ({ headers: { cookie: cookie.split(";")[0] } });
const tokenFrom = (invitation) =>
  /#invite=([A-Za-z0-9_-]{43})/.exec(invitation.invitationUrl)[1];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const scopeA = { serverId: "server-a", userId: "user-a" };
const scopeB = { serverId: "server-b", userId: "user-b" };

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
  const getUser = (serverId, userId) => users.get(`${serverId}:${userId}`);
  const dependencies = { dataDir: root, getUser, now: () => time, ...options };
  const access = await createAccessService(dependencies);
  await access.configure(settings);
  const invite = (extra = {}) =>
    access.invite({
      serverId: "server-a",
      user: getUser("server-a", "user-a"),
      ...extra,
    });
  return {
    access,
    root,
    users,
    getUser,
    invite,
    advance: (milliseconds) => {
      time += milliseconds;
    },
    reload: () => createAccessService(dependencies),
    read: async () =>
      JSON.parse(
        await fs.readFile(path.join(root, "remote-access.json"), "utf8"),
      ),
    enroll: async (pass = password, extra = {}) =>
      access.accept(tokenFrom(await invite(extra)), pass),
    login: (pass = password, email = "sister@example.com") =>
      access.login({ email, password: pass }),
    addB: () => {
      const user = {
        id: "user-b",
        email: "sister@example.com",
        permissions: ["control.restart"],
      };
      users.set("server-b:user-b", user);
      return { serverId: "server-b", user };
    },
  };
}

test("direct IP access needs only HTTPS address and port, with no email service", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.access.status(), {
    enabled: true,
    publicUrl: settings.publicUrl,
    port: 3002,
    transport: "direct",
    ready: true,
  });
  assert.deepEqual(validateAccessConfiguration({}), {
    enabled: false,
    publicUrl: "",
    port: 3002,
    transport: "direct",
  });
  assert.equal(
    (
      await f.access.configure({
        publicUrl: "https://[2001:db8::123]:3443/",
        port: 3443,
      })
    ).publicUrl,
    "https://[2001:db8::123]:3443",
  );
  assert.equal(
    (
      await f.access.configure({
        publicUrl: "https://panel.example.com/",
        transport: "proxy",
      })
    ).publicUrl,
    "https://panel.example.com",
  );
  assert.deepEqual(f.access.validateConfiguration({ port: 3555 }), {
    enabled: true,
    publicUrl: "https://panel.example.com",
    port: 3555,
    transport: "proxy",
  });
  assert.equal(
    f.access.status().port,
    3443,
    "configuration preview must not mutate settings",
  );
});

test("invitations persist only token hashes, accept once, and preserve live permissions", async (t) => {
  const f = await fixture(t);
  const invitation = await f.invite();
  assert.deepEqual(Object.keys(invitation).sort(), [
    "invitationUrl",
    "inviteExpiresAt",
    "invitedAt",
  ]);
  assert.match(
    invitation.invitationUrl,
    /^https:\/\/203\.0\.113\.17:3002\/#invite=/,
  );
  const token = tokenFrom(invitation);
  assert.equal(JSON.stringify(await f.read()).includes(token), false);
  const attempts = await Promise.allSettled([
    f.access.accept(token, password),
    f.access.accept(token, password),
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
    ...scopeA,
    permissions: ["control.start", "control.stop"],
    memberships: [scopeA],
  });
  assert.match(
    cookie,
    /^__Host-mc-subuser=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=604800$/,
  );
  const saved = await f.read();
  assert.equal(JSON.stringify(saved).includes(token), false);
  assert.equal(JSON.stringify(saved).includes(password), false);
  assert.equal(
    JSON.stringify(saved).includes(cookie.split("=")[1].split(";")[0]),
    false,
  );
  assert.match(saved.memberships[0].password.salt, /^[a-f0-9]{64}$/);
  assert.match(saved.memberships[0].password.hash, /^[a-f0-9]{128}$/);
  assert.equal(saved.memberships[0].password.algorithm, "scrypt");
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
  await assert.rejects(
    reloaded.login({ email: "sister@example.com", password }),
    { status: 401 },
  );
});

test("invalid passwords do not consume an invitation; boundaries are enforced", async (t) => {
  const f = await fixture(t);
  const token = tokenFrom(await f.invite());
  for (const invalid of [
    undefined,
    null,
    {},
    "",
    "x".repeat(11),
    "x".repeat(129),
  ]) {
    await assert.rejects(f.access.accept(token, invalid), { status: 400 });
  }
  assert.equal(
    f.access.invitationState("server-a", "user-a").inviteStatus,
    "pending",
  );
  assert.ok((await f.access.accept(token, "x".repeat(12))).session);
  const second = tokenFrom(await f.invite());
  assert.ok((await f.access.accept(second, "x".repeat(128))).session);
});

test("password sign-in is normalized, durable, and fails generically for wrong or unknown credentials", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  const { cookie, session } = await f.login(password, " SISTER@example.com ");
  assert.deepEqual(session.memberships, [scopeA]);
  assert.ok(await f.access.authenticate(request(cookie)));
  const reloaded = await f.reload();
  assert.ok(
    (await reloaded.login({ email: "sister@example.com", password })).session,
  );
  const failures = [
    { email: "sister@example.com", password: otherPassword },
    { email: "unknown@example.com", password },
    { email: "invalid", password },
    { email: "sister@example.com", password: "short" },
    { email: "sister@example.com", password: "x".repeat(129) },
    {},
    null,
  ];
  for (const input of failures)
    await assert.rejects(f.access.login(input), {
      status: 401,
      message: "The email or password is incorrect.",
    });
});

test("local-only users and pending invitations cannot sign in or forge sessions", async (t) => {
  const f = await fixture(t);
  assert.equal(f.access.invitationState("server-a", "user-a"), null);
  assert.equal(f.access.membershipAllowed("server-a", "user-a"), false);
  await assert.rejects(f.login(), { status: 401 });
  await f.invite();
  await assert.rejects(f.login(), { status: 401 });
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
  await assert.rejects(f.access.accept("user-a", password), { status: 401 });
});

test("expired invitations and sessions reject authentication; password login still works", async (t) => {
  const f = await fixture(t);
  const expired = tokenFrom(await f.invite());
  f.advance(24 * 60 * 60 * 1000);
  assert.equal(
    f.access.invitationState("server-a", "user-a").inviteStatus,
    "expired",
  );
  await assert.rejects(f.access.accept(expired, password), {
    status: 401,
    message: /Ask the server owner/,
  });
  const signedIn = await f.enroll();
  f.advance(7 * 24 * 60 * 60 * 1000);
  assert.equal(await f.access.authenticate(request(signedIn.cookie)), null);
  assert.ok((await f.login()).session);
});

test("new invitation rotates links, clears old passwords, and revokes existing sessions", async (t) => {
  const f = await fixture(t);
  const first = tokenFrom(await f.invite());
  const second = tokenFrom(await f.invite());
  await assert.rejects(f.access.accept(first, password), { status: 401 });
  const signedIn = await f.access.accept(second, password);
  const login = await f.login();
  const reset = tokenFrom(await f.invite());
  assert.equal(await f.access.authenticate(request(signedIn.cookie)), null);
  assert.equal(await f.access.authenticate(request(login.cookie)), null);
  await assert.rejects(f.login(), { status: 401 });
  assert.equal(
    f.access.invitationState("server-a", "user-a").inviteStatus,
    "pending",
  );
  await f.access.accept(reset, otherPassword);
  await assert.rejects(f.login(), { status: 401 });
  assert.ok((await f.login(otherPassword)).session);
  assert.equal((await f.read()).tokens.length, 0);
});

test("same-email membership never expands an invitation or existing session", async (t) => {
  const f = await fixture(t);
  const first = await f.enroll();
  const secondMember = f.addB();
  const second = await f.enroll(otherPassword, secondMember);
  assert.deepEqual(second.session.memberships, [scopeB]);
  assert.deepEqual(
    (await f.access.authenticate(request(first.cookie))).memberships,
    [scopeA],
  );
  assert.deepEqual((await f.login()).session.memberships, [scopeA]);
  assert.deepEqual((await f.login(otherPassword)).session.memberships, [
    scopeB,
  ]);
  const stored = await f.read();
  assert.notEqual(
    stored.memberships[0].password.salt,
    stored.memberships[1].password.salt,
  );
  assert.notEqual(
    stored.memberships[0].password.hash,
    stored.memberships[1].password.hash,
  );
});

test("accepting another invitation retains the browser's proven memberships across restart", async (t) => {
  const f = await fixture(t);
  const first = await f.enroll();
  const otherDevice = await f.login();
  const token = tokenFrom(await f.invite(f.addB()));
  const second = await f.access.accept(
    token,
    otherPassword,
    request(first.cookie),
  );
  assert.deepEqual(second.session.memberships, [scopeB, scopeA]);
  assert.equal(second.session.serverId, scopeB.serverId);
  assert.deepEqual(second.session.permissions, ["control.restart"]);
  assert.notEqual(second.cookie, first.cookie);
  assert.equal(await f.access.authenticate(request(first.cookie)), null);
  assert.deepEqual(
    (await f.access.authenticate(request(otherDevice.cookie))).memberships,
    [scopeA],
    "accepting a link must not expand a different device's existing session",
  );
  const restarted = await f.reload();
  assert.deepEqual(
    await restarted.authenticate(request(second.cookie)),
    second.session,
  );
  assert.deepEqual(
    (await restarted.login({ email: "sister@example.com", password })).session
      .memberships,
    [scopeA],
    "a fresh login must still prove each server's password independently",
  );
  assert.deepEqual(
    (
      await restarted.login({
        email: "sister@example.com",
        password: otherPassword,
      })
    ).session.memberships,
    [scopeB],
  );
  await restarted.logout(request(second.cookie));
  assert.equal(await restarted.authenticate(request(second.cookie)), null);
});

test("additional invitations retain only the signed-in scopes, never all matching emails", async (t) => {
  const f = await fixture(t);
  const first = await f.enroll();
  const token = tokenFrom(await f.invite(f.addB()));
  const userC = { id: "user-c", email: "sister@example.com", permissions: [] };
  f.users.set("server-c:user-c", userC);
  const third = await f.enroll(password, { serverId: "server-c", user: userC });
  const second = await f.access.accept(
    token,
    otherPassword,
    request(first.cookie),
  );
  assert.deepEqual(second.session.memberships, [scopeB, scopeA]);
  assert.deepEqual(
    (await f.access.authenticate(request(third.cookie))).memberships,
    [{ serverId: "server-c", userId: "user-c" }],
  );
});

test("an invitation never retains another account's session or invalid cookie scopes", async (t) => {
  for (const invalidation of [
    "different-email",
    "expired",
    "revoked",
    "forged",
    "duplicate",
    "changed-email",
  ]) {
    await t.test(invalidation, async (t) => {
      const f = await fixture(t);
      const first = await f.enroll();
      const memberB = f.addB();
      let cookie = first.cookie;
      if (invalidation === "different-email")
        memberB.user.email = "other@example.com";
      if (invalidation === "expired") f.advance(7 * 24 * 60 * 60 * 1000);
      if (invalidation === "revoked")
        await f.access.revoke("server-a", "user-a");
      if (invalidation === "forged")
        cookie = `${SUBUSER_COOKIE}=${"f".repeat(43)}`;
      if (invalidation === "changed-email")
        f.getUser("server-a", "user-a").email = "changed@example.com";
      const req = request(cookie);
      if (invalidation === "duplicate")
        req.headers.cookie += `; ${req.headers.cookie}`;
      const token = tokenFrom(await f.invite(memberB));
      const second = await f.access.accept(token, otherPassword, req);
      assert.deepEqual(second.session.memberships, [scopeB]);
    });
  }
});

test("same-password invitations remain available together after signing out and signing back in", async (t) => {
  const f = await fixture(t);
  const first = await f.enroll();
  const token = tokenFrom(await f.invite(f.addB()));
  const second = await f.access.accept(token, password, request(first.cookie));
  assert.deepEqual(second.session.memberships, [scopeB, scopeA]);
  await f.access.logout(request(second.cookie));
  const restarted = await f.reload();
  assert.deepEqual(
    (await restarted.login({ email: "sister@example.com", password })).session
      .memberships,
    [scopeA, scopeB],
  );
});

test("password login grants only independently enrolled memberships sharing the supplied password", async (t) => {
  const f = await fixture(t);
  const first = await f.enroll();
  const second = await f.enroll(password, f.addB());
  assert.deepEqual(second.session.memberships, [scopeB]);
  assert.deepEqual(
    (await f.access.authenticate(request(first.cookie))).memberships,
    [scopeA],
  );
  const all = await f.login();
  assert.deepEqual(all.session.memberships, [scopeA, scopeB]);
  f.users.delete("server-b:user-b");
  assert.deepEqual(
    (await f.access.authenticate(request(all.cookie))).memberships,
    [scopeA],
  );
  f.users.delete("server-a:user-a");
  assert.equal(await f.access.authenticate(request(all.cookie)), null);
});

test("reset and revoke invalidate whole multi-membership sessions without affecting other passwords", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  const memberB = f.addB();
  await f.enroll(password, memberB);
  const all = await f.login();
  await f.invite(memberB);
  assert.equal(await f.access.authenticate(request(all.cookie)), null);
  assert.deepEqual((await f.login()).session.memberships, [scopeA]);
  await f.enroll(password, memberB);
  const both = await f.login();
  await f.access.revoke("server-b", "user-b");
  assert.equal(await f.access.authenticate(request(both.cookie)), null);
  assert.deepEqual((await f.login()).session.memberships, [scopeA]);
});

test("logout and revocation remove credentials permanently", async (t) => {
  const f = await fixture(t);
  const first = await f.enroll();
  assert.match(await f.access.logout(request(first.cookie)), /Max-Age=0/);
  assert.equal(await f.access.authenticate(request(first.cookie)), null);
  const second = await f.login();
  await f.access.revoke("server-a", "user-a");
  assert.equal(await f.access.authenticate(request(second.cookie)), null);
  assert.equal(f.access.membershipAllowed("server-a", "user-a"), false);
  await assert.rejects(f.login(), { status: 401 });
  const outstanding = tokenFrom(await f.invite());
  await f.access.revoke("server-a", "user-a");
  await assert.rejects(f.access.accept(outstanding, password), { status: 401 });
  const reloaded = await f.reload();
  assert.equal(await reloaded.authenticate(request(second.cookie)), null);
});

test("unknown logout cookies bypass password work and do not write access storage", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  const file = path.join(f.root, "remote-access.json");
  const before = await fs.readFile(file, "utf8");
  const fileTime = new Date(Date.UTC(2020, 0, 1));
  await fs.utimes(file, fileTime, fileTime);
  assert.match(await f.access.logout({ headers: {} }), /Max-Age=0/);
  assert.match(
    await f.access.logout(request(`${SUBUSER_COOKIE}=${"f".repeat(43)}`)),
    /Max-Age=0/,
  );
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.equal((await fs.stat(file)).mtimeMs, fileTime.getTime());
});

test("changed email cannot inherit an old password, session or invitation", async (t) => {
  const f = await fixture(t);
  const first = await f.enroll();
  f.getUser("server-a", "user-a").email = "someone-else@example.com";
  assert.equal(await f.access.authenticate(request(first.cookie)), null);
  await assert.rejects(f.login(), { status: 401 });
  await assert.rejects(f.login(password, "someone-else@example.com"), {
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
  const invitation = tokenFrom(await f.invite());
  f.getUser("server-a", "user-a").email = "third@example.com";
  await assert.rejects(f.access.accept(invitation, password), { status: 401 });
});

test("unsafe settings are rejected and retired mail fields are dropped", async (t) => {
  const f = await fixture(t);
  for (const publicUrl of [
    "http://203.0.113.17:3002",
    "https://u:p@panel.example.com",
    "https://panel.example.com/path",
    "https://panel.example.com/?token=x",
    "https://panel.example.com/#hash",
    "garbage",
    "",
  ]) {
    await assert.rejects(f.access.configure({ publicUrl }), { status: 400 });
  }
  for (const input of [
    { port: 80 },
    { port: 65536 },
    { port: "3002" },
    { enabled: "true" },
    { transport: "http" },
    null,
    [],
  ])
    await assert.rejects(f.access.configure(input), { status: 400 });
  const updated = await f.access.configure({
    from: "old@example.com",
    apiKey: "old-private-key",
    clearApiKey: true,
  });
  assert.equal(JSON.stringify(updated).includes("old"), false);
  assert.equal(JSON.stringify(await f.read()).includes("old"), false);
  await f.access.configure({ enabled: false, publicUrl: "" });
  await assert.rejects(f.access.configure({ enabled: true }), { status: 400 });
  await assert.rejects(f.invite(), { status: 409 });
});

test("disable, origin changes and transport changes invalidate sessions and links", async (t) => {
  const f = await fixture(t);
  const first = await f.enroll();
  await f.access.configure({ enabled: false });
  await f.access.configure({ enabled: true });
  assert.equal(await f.access.authenticate(request(first.cookie)), null);
  const second = await f.login();
  await f.access.configure({ publicUrl: "https://203.0.113.18:3002" });
  assert.equal(await f.access.authenticate(request(second.cookie)), null);
  const link = tokenFrom(await f.invite());
  await f.access.configure({ transport: "proxy" });
  await assert.rejects(f.access.accept(link, password), { status: 401 });
});

test("duplicate cookies fail closed and session views cannot mutate persisted authorization", async (t) => {
  const f = await fixture(t);
  const { cookie } = await f.enroll();
  const pair = cookie.split(";")[0];
  assert.equal(
    await f.access.authenticate({ headers: { cookie: `${pair}; ${pair}` } }),
    null,
  );
  const session = await f.access.authenticate(request(cookie));
  session.permissions.push("user.delete");
  session.memberships.push(scopeB);
  session.memberships[0].userId = "forged";
  assert.deepEqual((await f.access.authenticate(request(cookie))).memberships, [
    scopeA,
  ]);
  assert.equal(
    (await f.access.authenticate(request(cookie))).permissions.includes(
      "user.delete",
    ),
    false,
  );
});

test("legacy settings strip email secrets on save while preserving primary-scoped sessions and confirmed links", async (t) => {
  const f = await fixture(t);
  const memberB = f.addB();
  const now = Date.UTC(2026, 8, 19);
  const token = "i".repeat(43);
  const cookie = `${SUBUSER_COOKIE}=${"s".repeat(43)}`;
  const saved = {
    version: 1,
    configuration: {
      enabled: true,
      publicUrl: settings.publicUrl,
      port: 3002,
      from: "old@example.com",
      apiKey: "old-provider-secret",
    },
    memberships: [
      {
        ...scopeA,
        email: "sister@example.com",
        invitedAt: now,
        acceptedAt: now,
      },
      { ...scopeB, email: memberB.user.email, invitedAt: now },
    ],
    tokens: [
      {
        ...scopeB,
        email: memberB.user.email,
        hash: hash(token),
        sent: true,
        createdAt: now,
        expiresAt: now + 86400000,
      },
    ],
    sessions: [
      {
        ...scopeA,
        email: "sister@example.com",
        hash: hash("s".repeat(43)),
        expiresAt: now + 604800000,
      },
    ],
  };
  await fs.writeFile(
    path.join(f.root, "remote-access.json"),
    JSON.stringify(saved),
  );
  const migrated = await f.reload();
  assert.equal(migrated.status().transport, "proxy");
  assert.equal(JSON.stringify(migrated.status()).includes("old"), false);
  const legacySession = await migrated.authenticate(request(cookie));
  assert.deepEqual(
    legacySession.memberships,
    [scopeA],
    "same email must not grant the legacy session access to server B",
  );
  await assert.rejects(
    migrated.login({ email: "sister@example.com", password }),
    { status: 401 },
  );
  await migrated.configure({ port: 3443 });
  const stored = await f.read();
  assert.equal(stored.version, 2);
  assert.equal(JSON.stringify(stored).includes("old-provider-secret"), false);
  assert.equal(stored.sessions.length, 1);
  assert.equal(stored.tokens.length, 1);
  assert.deepEqual(
    (await migrated.accept(token, password)).session.memberships,
    [scopeB],
  );
  assert.deepEqual((await migrated.authenticate(request(cookie))).memberships, [
    scopeA,
  ]);
});

test("unconfirmed legacy email tokens cannot be accepted", async (t) => {
  const f = await fixture(t);
  const invitation = await f.invite();
  const saved = await f.read();
  saved.tokens[0].sent = false;
  await fs.writeFile(
    path.join(f.root, "remote-access.json"),
    JSON.stringify(saved),
  );
  await assert.rejects(
    (await f.reload()).accept(tokenFrom(invitation), password),
    { status: 401 },
  );
});

test("membership search is bounded and excess invitations fail before mutation", async (t) => {
  const f = await fixture(t);
  await f.invite();
  for (let index = 1; index < 32; index++) {
    const user = {
      id: `member-${index}`,
      email: "sister@example.com",
      permissions: [],
    };
    f.users.set(`extra:${user.id}`, user);
    await f.invite({ serverId: "extra", user });
  }
  const extra = f.addB();
  await assert.rejects(f.invite(extra), { status: 400 });
  assert.equal((await f.read()).memberships.length, 32);
  assert.equal(f.access.membershipAllowed("server-b", "user-b"), false);
  assert.ok(
    (await f.invite()).invitationUrl,
    "existing membership can still rotate its link at the limit",
  );
});

test("password work is bounded across peer addresses without blocking owner configuration forever", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  const attempts = await Promise.allSettled(
    Array.from({ length: 24 }, () => f.login()),
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    16,
  );
  assert.equal(
    attempts.filter(
      (attempt) =>
        attempt.status === "rejected" && attempt.reason.status === 429,
    ).length,
    8,
  );
  assert.ok(
    (await f.login()).session,
    "capacity is released after successful authentication",
  );
  const rejected = await Promise.allSettled(
    Array.from({ length: 16 }, () => f.login(otherPassword)),
  );
  assert.ok(
    rejected.every(
      (attempt) =>
        attempt.status === "rejected" && attempt.reason.status === 401,
    ),
  );
  assert.ok(
    (await f.login()).session,
    "capacity is released after rejected authentication",
  );
  await f.access.configure({ enabled: false });
  assert.equal(f.access.status().enabled, false);
});

test("shutdown drains in-flight enrollment and rejects new work", async (t) => {
  const f = await fixture(t);
  const token = tokenFrom(await f.invite());
  const pending = f.access.accept(token, password);
  const closing = f.access.close();
  await assert.rejects(f.invite(), { status: 503 });
  await assert.rejects(f.access.configure({ enabled: false }), { status: 503 });
  await assert.rejects(f.login(), { status: 503 });
  const { cookie } = await pending;
  await closing;
  assert.equal(await f.access.authenticate(request(cookie)), null);
  assert.ok(await (await f.reload()).authenticate(request(cookie)));
});

test("rate limiter ignores spoofed forwarding headers, caps memory, and recovers", () => {
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
  assert.equal(allowed, 3);
  now += 10_000;
  attempt("127.0.0.1", "4.5.6.7");
  assert.equal(allowed, 4);
});
