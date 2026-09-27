import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createAccessService, SUBUSER_COOKIE } from "./access.mjs";
import { createRemoteGateway } from "./remote-access.mjs";

const password = "Revocation fixture password!";
const lifetime = 7 * 24 * 60 * 60 * 1000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const bearer = (value) => ({ headers: { authorization: `Bearer ${value}` } });
const invitationToken = (invitation) =>
  new URL(invitation.invitationUrl).hash.slice(8);

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-access-revocation-")),
  );
  const file = path.join(root, "remote-access.json");
  const legacy = [];
  const instances = [];
  let time = Date.UTC(2026, 8, 27);
  const options = {
    dataDir: root,
    now: () => time,
    listServerIds: () => ["a", "b"],
    listLegacyUsers: () => legacy,
    getUser: (serverId, userId) =>
      legacy.find(
        (entry) => entry.serverId === serverId && entry.user.id === userId,
      )?.user,
  };
  const boot = async () => {
    const service = await createAccessService(options);
    instances.push(service);
    return service;
  };
  const access = await boot();
  await access.configure({
    enabled: true,
    publicUrl: "https://panel.example.test",
    transport: "proxy",
  });
  t.after(async () => {
    for (const service of instances) await service.close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-access-revocation-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const enroll = async (email = "member@example.test") => {
    const account = await access.createAccount({ email });
    const invitation = await access.inviteAccount(account.id);
    return {
      account,
      ...(await access.accept(invitationToken(invitation), password)),
    };
  };
  const enrollLegacy = async (serverId) => {
    const user = {
      id: `legacy-${serverId}`,
      email: "legacy@example.test",
      permissions: ["server.view"],
    };
    legacy.push({ serverId, user });
    const invitation = await access.invite({ serverId, user });
    return {
      user,
      ...(await access.accept(invitationToken(invitation), password)),
    };
  };
  return {
    access,
    root,
    file,
    boot,
    enroll,
    enrollLegacy,
    advance: (amount) => {
      time += amount;
    },
    now: () => time,
    read: async () => JSON.parse(await fs.readFile(file, "utf8")),
    write: (state) => fs.writeFile(file, JSON.stringify(state)),
  };
}

test("account deletion records only matching bearer proofs and survives a restart", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  const second = await f.access.login({
    email: member.account.email,
    password,
  });
  const other = await f.enroll("other@example.test");
  await f.access.deleteAccount(member.account.id);
  for (const token of [member.token, second.token]) {
    assert.equal(await f.access.authenticate(bearer(token)), null);
    assert.equal(f.access.isAccessRevoked(bearer(token)), true);
  }
  assert.equal(f.access.isAccessRevoked(bearer(other.token)), false);
  assert.equal(
    (await f.access.authenticate(bearer(other.token))).role,
    "subuser",
  );
  for (const req of [
    { headers: {} },
    bearer("x".repeat(43)),
    { headers: { authorization: "Basic irrelevant" } },
    { headers: { cookie: `${SUBUSER_COOKIE}=${member.token}` } },
    {
      headers: {
        authorization: "Bearer invalid",
        cookie: `${SUBUSER_COOKIE}=${member.token}`,
      },
    },
  ])
    assert.equal(f.access.isAccessRevoked(req), false);
  const receipts = (await f.read()).accessRevocations;
  assert.deepEqual(
    receipts.map((receipt) => receipt.hash).sort(),
    [hash(member.token), hash(second.token)].sort(),
  );
  for (const receipt of receipts) {
    assert.deepEqual(Object.keys(receipt).sort(), ["expiresAt", "hash"]);
    assert.equal(receipt.expiresAt, f.now() + lifetime);
  }
  assert.equal(JSON.stringify(receipts).includes(member.token), false);
  assert.equal(JSON.stringify(receipts).includes(member.account.email), false);
  await f.access.close();
  const restarted = await f.boot();
  assert.equal(restarted.isAccessRevoked(bearer(member.token)), true);
  assert.equal(restarted.isAccessRevoked(bearer(other.token)), false);
});

test("self-leave records all removed bearer sessions while preserving its retry receipt", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  const second = await f.access.login({
    email: member.account.email,
    password,
  });
  const input = { confirmed: true, requestId: randomUUID() };
  assert.deepEqual(await f.access.leave(bearer(member.token), input), {
    left: true,
    requestId: input.requestId,
  });
  assert.equal(f.access.isAccessRevoked(bearer(member.token)), true);
  assert.equal(f.access.isAccessRevoked(bearer(second.token)), true);
  assert.deepEqual(await f.access.leave(bearer(member.token), input), {
    left: true,
    requestId: input.requestId,
  });
  assert.equal((await f.read()).leaveReceipts.length, 1);
});

test("revocation proof expires with the original session and is cleaned from persisted storage", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  f.advance(lifetime - 1000);
  await f.access.deleteAccount(member.account.id);
  assert.equal(f.access.isAccessRevoked(bearer(member.token)), true);
  f.advance(1000);
  assert.equal(f.access.isAccessRevoked(bearer(member.token)), false);
  await f.access.close();
  const restarted = await f.boot();
  assert.equal(restarted.isAccessRevoked(bearer(member.token)), false);
  assert.deepEqual((await f.read()).accessRevocations, []);
});

test("zero-server accounts, partial grants, logout, reinvitation, expiry and disabled access are not revocation proofs", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  const request = bearer(member.token);
  assert.deepEqual((await f.access.authenticate(request)).memberships, []);
  await f.access.grantServer("a", member.account.id, {
    permissions: ["server.view"],
  });
  await f.access.grantServer("b", member.account.id, {
    permissions: ["server.view"],
  });
  await f.access.revoke("a", member.account.id);
  assert.equal(f.access.isAccessRevoked(request), false);
  await f.access.revoke("b", member.account.id);
  assert.deepEqual((await f.access.authenticate(request)).memberships, []);
  assert.equal(f.access.isAccessRevoked(request), false);
  await f.access.configure({ enabled: false });
  assert.equal(await f.access.authenticate(request), null);
  assert.equal(f.access.isAccessRevoked(request), false);
  await f.access.configure({ enabled: true });
  await f.access.logout(request);
  assert.equal(f.access.isAccessRevoked(request), false);
  const signed = await f.access.login({
    email: member.account.email,
    password,
  });
  const invitation = await f.access.inviteAccount(member.account.id);
  assert.equal(await f.access.authenticate(bearer(signed.token)), null);
  assert.equal(f.access.isAccessRevoked(bearer(signed.token)), false);
  const reset = await f.access.accept(
    invitationToken(invitation),
    "A different fixture password!",
  );
  f.advance(lifetime);
  assert.equal(await f.access.authenticate(bearer(reset.token)), null);
  assert.equal(f.access.isAccessRevoked(bearer(reset.token)), false);
  await f.access.deleteAccount(member.account.id);
  assert.deepEqual((await f.read()).accessRevocations, []);
});

test("legacy revoke proves loss only for bearer sessions whose final membership was removed", async (t) => {
  const f = await fixture(t);
  const first = await f.enrollLegacy("a");
  const second = await f.enrollLegacy("b");
  const combined = await f.access.login({
    email: "legacy@example.test",
    password,
  });
  await f.access.revoke("a", first.user.id);
  assert.equal(f.access.isAccessRevoked(bearer(first.token)), true);
  assert.equal(f.access.isAccessRevoked(bearer(second.token)), false);
  assert.equal(f.access.isAccessRevoked(bearer(combined.token)), false);
  assert.equal(
    (await f.access.authenticate(bearer(combined.token))).memberships.length,
    1,
  );
  await f.access.revoke("b", second.user.id);
  assert.equal(f.access.isAccessRevoked(bearer(second.token)), true);
  assert.equal(f.access.isAccessRevoked(bearer(combined.token)), true);
});

test("legacy password reset and pre-bearer cookie records never issue revocation proof", async (t) => {
  const f = await fixture(t);
  const member = await f.enrollLegacy("a");
  const invitation = await f.access.invite({
    serverId: "a",
    user: member.user,
  });
  assert.equal(f.access.isAccessRevoked(bearer(member.token)), false);
  const reset = await f.access.accept(invitationToken(invitation), password);
  await f.access.close();
  const state = await f.read();
  delete state.accessRevocations; // Existing installations have no receipt field.
  for (const session of state.sessions) delete session.transport;
  await f.write(state);
  const restarted = await f.boot();
  await restarted.revoke("a", member.user.id);
  assert.equal(restarted.isAccessRevoked(bearer(reset.token)), false);
  assert.deepEqual((await f.read()).accessRevocations, []);
});

test("revocation receipts are bounded without blocking account removal", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  await f.access.close();
  const state = await f.read();
  state.accessRevocations = Array.from({ length: 4096 }, (_, index) => ({
    hash: hash(`old-proof-${index}`),
    expiresAt: f.now() + 1000 + index,
  }));
  await f.write(state);
  const restarted = await f.boot();
  await restarted.deleteAccount(member.account.id);
  assert.equal(restarted.isAccessRevoked(bearer(member.token)), true);
  const receipts = (await f.read()).accessRevocations;
  assert.equal(receipts.length, 4096);
  assert.equal(
    receipts.some((receipt) => receipt.hash === hash("old-proof-0")),
    false,
  );
});

test("malformed or identity-bearing revocation storage fails validation", async (t) => {
  const f = await fixture(t);
  await f.access.close();
  const original = await f.read();
  const receipt = { hash: hash("proof"), expiresAt: f.now() + 1000 };
  for (const accessRevocations of [
    null,
    {},
    [null],
    [{ ...receipt, hash: "plaintext" }],
    [{ ...receipt, email: "leaked@example.test" }],
    [{ ...receipt, expiresAt: "tomorrow" }],
    [{ ...receipt, expiresAt: -1 }],
    [receipt, receipt],
    Array(4097).fill(receipt),
  ]) {
    await f.write({ ...original, accessRevocations });
    await assert.rejects(f.boot(), { status: 500 });
  }
});

test("gateway distinguishes proven removal from generic guest, logout, expiry, cookies and outages", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  const loggedOut = await f.enroll("logout@example.test");
  await f.access.logout(bearer(loggedOut.token));
  const gateway = createRemoteGateway({
    access: f.access,
    runtimes: new Map(),
    distDir: f.root,
  });
  const listener = await new Promise((resolve) => {
    const server = gateway.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(
    () =>
      new Promise((resolve) => {
        listener.closeAllConnections();
        listener.close(resolve);
      }),
  );
  const request = (route, headers = {}) =>
    new Promise((resolve, reject) => {
      const outgoing = http.request(
        `http://127.0.0.1:${listener.address().port}${route}`,
        { headers: { Host: "panel.example.test", ...headers } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, body: JSON.parse(body) }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  const authenticated = bearer(member.token).headers;
  assert.equal(
    (await request("/api/access/session", authenticated)).body.role,
    "subuser",
  );
  assert.equal(
    (await request("/api/servers", authenticated)).status,
    200,
    "a zero-server account is still valid",
  );
  await f.access.deleteAccount(member.account.id);
  assert.deepEqual(await request("/api/access/session", authenticated), {
    status: 200,
    body: { role: "guest", accessRevoked: true },
  });
  assert.deepEqual(await request("/api/servers", authenticated), {
    status: 401,
    body: {
      error: "Your access to this panel was revoked. Contact the panel owner.",
      accessRevoked: true,
    },
  });
  for (const headers of [
    {},
    bearer("x".repeat(43)).headers,
    bearer(loggedOut.token).headers,
    { cookie: `${SUBUSER_COOKIE}=${member.token}` },
  ]) {
    assert.deepEqual((await request("/api/access/session", headers)).body, {
      role: "guest",
    });
    assert.deepEqual((await request("/api/servers", headers)).body, {
      error: "Sign in with your email address and password.",
    });
  }
  await f.access.configure({ enabled: false });
  const disabled = await request("/api/access/session", authenticated);
  assert.equal(disabled.status, 503);
  assert.equal(Object.hasOwn(disabled.body, "accessRevoked"), false);
  await f.access.configure({ enabled: true });
  f.advance(lifetime);
  assert.deepEqual((await request("/api/access/session", authenticated)).body, {
    role: "guest",
  });
});
