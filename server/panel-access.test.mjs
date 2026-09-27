import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAccessService } from "./access.mjs";
import catalog from "../shared/subuser-permissions.json" with { type: "json" };

const password = "Panel account fixture password!";
const secondPassword = "Independent legacy credential!";
const req = (cookie) => ({ headers: { cookie: cookie.split(";")[0] } });
const token = (invitation) => new URL(invitation.invitationUrl).hash.slice(8);
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-panel-access-")),
  );
  const servers = ["server-a", "server-b"];
  const legacy = [];
  let currentTime = Date.now();
  const options = {
    dataDir: root,
    now: () => currentTime,
    listServerIds: () => [...servers],
    listLegacyUsers: () => legacy,
    getUser: (serverId, userId) =>
      legacy.find(
        (entry) => entry.serverId === serverId && entry.user.id === userId,
      )?.user,
  };
  const instances = [];
  const boot = async () => {
    const access = await createAccessService(options);
    instances.push(access);
    return access;
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
    assert.ok(path.basename(root).startsWith("mc-panel-access-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const enroll = async (input = {}) => {
    const account = await access.createAccount({
      email: "member@example.test",
      ...input,
    });
    const invitation = await access.inviteAccount(account.id);
    return {
      account,
      invitation,
      ...(await access.accept(token(invitation), password)),
    };
  };
  const legacyEnroll = async (serverId, userId, secret, permissions) => {
    const user = {
      id: userId,
      email: "legacy@example.test",
      permissions,
      hostPermissions: [],
    };
    legacy.push({ serverId, user });
    const invitation = await access.invite({ serverId, user });
    return access.accept(token(invitation), secret);
  };
  return {
    root,
    access,
    servers,
    legacy,
    boot,
    enroll,
    legacyEnroll,
    advance: (milliseconds) => {
      currentTime += milliseconds;
    },
  };
}

test("previewing and cancelling an invitation preserves a passwordless account and its existing grants across restart", async (t) => {
  const f = await fixture(t);
  const account = await f.access.createAccount({
    email: "pending@example.test",
  });
  await f.access.grantServer("server-a", account.id, {
    permissions: ["server.view", "file.read"],
  });
  const invitation = await f.access.inviteAccount(account.id);
  const storage = path.join(f.root, "remote-access.json");
  const before = await fs.readFile(storage, "utf8");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(await f.access.previewInvitation(token(invitation)), {
      email: account.email,
      panelAddress: "https://panel.example.test",
      inviteExpiresAt: invitation.inviteExpiresAt,
    });
  }
  await assert.rejects(f.access.accept(token(invitation), "short"), {
    status: 400,
  });
  await assert.rejects(f.access.login({ email: account.email, password }), {
    status: 401,
  });
  assert.equal(f.access.membershipAllowed("server-a", account.id), false);
  assert.equal(await fs.readFile(storage, "utf8"), before);
  await f.access.close();
  const restarted = await f.boot();
  assert.equal(restarted.account(account.id).inviteStatus, "pending");
  assert.equal(restarted.account(account.id).acceptedAt, null);
  assert.deepEqual(
    restarted.userForServer("server-a", account.id).permissions,
    ["server.view", "file.read"],
  );
  assert.equal(
    (await restarted.previewInvitation(token(invitation))).email,
    account.email,
  );
  const accepted = await restarted.accept(token(invitation), password);
  assert.deepEqual(accepted.session.memberships, [
    { serverId: "server-a", userId: account.id },
  ]);
  assert.equal(restarted.listAccounts().length, 1);
  assert.equal(restarted.userForServer("server-b", account.id), null);
});

test("failed password persistence leaves invitation and grants usable; a lost success response recovers through sign-in", async (t) => {
  const f = await fixture(t);
  const account = await f.access.createAccount({ email: "retry@example.test" });
  await f.access.grantServer("server-a", account.id, {
    permissions: ["server.view", "control.start"],
  });
  const invitation = await f.access.inviteAccount(account.id);
  const storage = path.join(f.root, "remote-access.json");
  const before = await fs.readFile(storage, "utf8");
  const rename = fs.rename;
  const injected = t.mock.method(fs, "rename", async (source, destination) => {
    if (destination === storage)
      throw new Error("Fixture password persistence failure");
    return rename(source, destination);
  });
  await assert.rejects(f.access.accept(token(invitation), password), {
    status: 500,
  });
  assert.equal(await fs.readFile(storage, "utf8"), before);
  assert.equal(f.access.account(account.id).inviteStatus, "pending");
  assert.equal(f.access.account(account.id).acceptedAt, null);
  assert.equal(
    (await f.access.previewInvitation(token(invitation))).email,
    account.email,
  );
  injected.mock.restore();
  const attempts = await Promise.allSettled([
    f.access.accept(token(invitation), password),
    f.access.accept(token(invitation), secondPassword),
  ]);
  assert.equal(attempts[0].status, "fulfilled");
  assert.equal(attempts[1].status, "rejected");
  assert.equal(attempts[1].reason.status, 401);
  await f.access.close();
  const restarted = await f.boot();
  await assert.rejects(restarted.previewInvitation(token(invitation)), {
    status: 401,
    message: /If you saved your password, choose Sign in/,
  });
  const signed = await restarted.login({ email: account.email, password });
  assert.deepEqual(signed.session.permissions, [
    "server.view",
    "control.start",
  ]);
  await assert.rejects(
    restarted.login({ email: account.email, password: secondPassword }),
    { status: 401 },
  );
  assert.equal(restarted.account(account.id).inviteStatus, "accepted");
  assert.equal(restarted.listAccounts().length, 1);
});

test("owners can reissue expired invitations on the existing account without changing server grants", async (t) => {
  const f = await fixture(t);
  const account = await f.access.createAccount({
    email: "expired@example.test",
  });
  await f.access.grantServer("server-a", account.id, {
    permissions: ["server.view", "file.read"],
  });
  await f.access.grantServer("server-b", account.id, {
    permissions: ["server.view", "control.start"],
  });
  const expired = await f.access.inviteAccount(account.id);
  f.advance(24 * 60 * 60 * 1000);
  for (const operation of [
    () => f.access.previewInvitation(token(expired)),
    () => f.access.accept(token(expired), password),
  ])
    await assert.rejects(operation(), {
      status: 401,
      message: /reissue the invitation for your existing account/,
    });
  assert.equal(f.access.account(account.id).inviteStatus, "expired");
  const grants = f.access.account(account.id).serverOverrides;
  await assert.rejects(f.access.createAccount({ email: account.email }), {
    status: 409,
  });
  const reissued = await f.access.inviteAccount(account.id);
  assert.equal(reissued.account.id, account.id);
  assert.deepEqual(reissued.account.serverOverrides, grants);
  assert.equal(f.access.listAccounts().length, 1);
  await assert.rejects(f.access.accept(token(expired), password), {
    status: 401,
  });
  const accepted = await f.access.accept(token(reissued), password);
  assert.deepEqual(
    accepted.session.memberships.map((member) => member.serverId),
    ["server-a", "server-b"],
  );
});

test("inconsistent activation without a stored password fails closed and retains owner recovery", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  await f.access.grantServer("server-a", member.account.id, {
    permissions: ["server.view"],
  });
  const storage = path.join(f.root, "remote-access.json");
  const saved = JSON.parse(await fs.readFile(storage, "utf8"));
  delete saved.accounts[0].password;
  await f.access.close();
  await fs.writeFile(storage, JSON.stringify(saved));
  const restarted = await f.boot();
  assert.equal(await restarted.authenticate(req(member.cookie)), null);
  assert.equal(
    restarted.membershipAllowed("server-a", member.account.id),
    false,
  );
  assert.equal(restarted.account(member.account.id).inviteStatus, "expired");
  assert.equal(restarted.account(member.account.id).acceptedAt, null);
  await assert.rejects(
    restarted.login({ email: member.account.email, password }),
    { status: 401 },
  );
  const invitation = await restarted.inviteAccount(member.account.id);
  const signed = await restarted.accept(token(invitation), password);
  assert.deepEqual(signed.session.memberships, [
    { serverId: "server-a", userId: member.account.id },
  ]);
  assert.equal(restarted.listAccounts().length, 1);
});

test("panel invitations start with no grants and retain one durable credential across future servers", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  assert.equal(member.account.accessMode, "selected");
  assert.equal(f.access.userForServer("server-a", member.account.id), null);
  assert.equal(member.session.accountId, member.account.id);
  assert.deepEqual(member.session.memberships, []);
  f.servers.push("server-c");
  assert.deepEqual(
    (await f.access.authenticate(req(member.cookie))).memberships,
    [],
  );
  await f.access.close();
  const restarted = await f.boot();
  assert.deepEqual(
    (await restarted.authenticate(req(member.cookie))).memberships,
    [],
  );
  assert.deepEqual(
    (await restarted.login({ email: member.account.email, password })).session
      .memberships,
    [],
  );
  const saved = JSON.parse(
    await fs.readFile(path.join(f.root, "remote-access.json"), "utf8"),
  );
  assert.equal(saved.version, 4);
  assert.equal(saved.accounts.length, 1);
  assert.equal(saved.memberships.length, 0);
  assert.equal(JSON.stringify(saved).includes(password), false);
  assert.equal(JSON.stringify(saved).includes(token(member.invitation)), false);
  assert.equal(
    JSON.stringify(f.access.listAccounts()).includes('"password"'),
    false,
  );
});

test("per-server grants and revocation are live without logging out unrelated or zero-server accounts", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll({ hostPermissions: ["server.create"] });
  await f.access.grantServer("server-a", member.account.id, {
    permissions: ["server.view"],
  });
  await f.access.grantServer("server-b", member.account.id, {
    permissions: ["server.view", "file.read", "file.create"],
  });
  assert.equal(
    f.access.userForServer("server-a", member.account.id).createdAt,
    member.account.createdAt,
  );
  await f.access.revoke("server-a", member.account.id);
  assert.equal(f.access.userForServer("server-a", member.account.id), null);
  assert.equal(
    f.access.membershipAllowed("server-a", member.account.id),
    false,
  );
  assert.deepEqual(
    f.access.userForServer("server-b", member.account.id).permissions,
    ["server.view", "file.read", "file.create"],
  );
  assert.equal(
    (await f.access.authenticate(req(member.cookie))).serverId,
    "server-b",
  );
  await f.access.grantServer("server-b", member.account.id, {
    permissions: [],
  });
  const empty = await f.access.authenticate(req(member.cookie));
  assert.equal(empty.serverId, null);
  assert.deepEqual(empty.memberships, []);
  assert.deepEqual(empty.permissions, []);
  assert.equal(
    (await f.access.hostAuthority(req(member.cookie))).accountId,
    member.account.id,
  );
  f.servers.push("server-c");
  assert.deepEqual(
    (await f.access.authenticate(req(member.cookie))).memberships,
    [],
  );
  await f.access.grantServer("server-b", member.account.id, {
    permissions: ["server.view", "file.read"],
  });
  assert.deepEqual(
    (await f.access.authenticate(req(member.cookie))).memberships,
    [{ serverId: "server-b", userId: member.account.id }],
  );
});

test("legacy aggregation and promotion preserve independent passwords and proven server scopes", async (t) => {
  const f = await fixture(t);
  const first = await f.legacyEnroll("server-a", "legacy-a", password, [
    "file.read",
  ]);
  const second = await f.legacyEnroll("server-b", "legacy-b", secondPassword, [
    "control.start",
  ]);
  assert.equal(f.access.listAccounts()[0].createdAt, undefined);
  f.legacy[0].user.createdAt = "invalid date";
  f.legacy[1].user.createdAt = "2024-02-01T00:00:00.000Z";
  assert.equal(
    f.access.listAccounts()[0].createdAt,
    "2024-02-01T00:00:00.000Z",
  );
  f.legacy[0].user.createdAt = "2024-01-01T00:00:00.000Z";
  const row = f.access.listAccounts()[0];
  assert.equal(row.createdAt, "2024-01-01T00:00:00.000Z");
  assert.equal(row.id, "legacy:legacy@example.test");
  assert.equal(row.accessMode, "selected");
  assert.deepEqual(row.serverOverrides["server-a"].permissions, [
    "server.view",
    "file.read",
  ]);
  const promoted = await f.access.updateAccount(row.id, {});
  assert.notEqual(promoted.id, row.id);
  assert.equal(promoted.legacyPending, true);
  const effectiveLegacy = f.access.resolveUser(
    "server-a",
    "legacy-a",
    f.legacy[0].user,
  );
  assert.equal(effectiveLegacy.panelAccount, true);
  assert.equal(effectiveLegacy.accountId, promoted.id);
  assert.equal(effectiveLegacy.id, "legacy-a");
  assert.deepEqual(
    (await f.access.authenticate(req(first.cookie))).memberships,
    [{ serverId: "server-a", userId: "legacy-a" }],
  );
  assert.deepEqual(
    (await f.access.authenticate(req(second.cookie))).memberships,
    [{ serverId: "server-b", userId: "legacy-b" }],
  );
  f.servers.push("server-c");
  assert.equal(f.access.userForServer("server-c", promoted.id), null);
  const addedLegacy = {
    serverId: "server-c",
    user: { id: "legacy-c", email: row.email, permissions: ["file.read"] },
  };
  f.legacy.push(addedLegacy);
  await assert.rejects(
    f.access.invite(addedLegacy),
    { status: 404 },
    "scoped invitations cannot bypass a promoted account's policy",
  );
  assert.deepEqual(
    (await f.access.login({ email: row.email, password })).session.memberships,
    [{ serverId: "server-a", userId: "legacy-a" }],
  );
  await f.access.revoke("server-a", promoted.id);
  assert.equal(
    f.access.resolveUser("server-a", "legacy-a", f.legacy[0].user),
    null,
  );
  assert.equal(await f.access.authenticate(req(first.cookie)), null);
  assert.ok(await f.access.authenticate(req(second.cookie)));
  await f.access.close();
  const restarted = await f.boot();
  assert.ok(await restarted.authenticate(req(second.cookie)));
  assert.equal(await restarted.authenticate(req(first.cookie)), null);
});

test("accepting an explicit panel invitation consolidates legacy credentials only at acceptance", async (t) => {
  const f = await fixture(t);
  const first = await f.legacyEnroll("server-a", "legacy-a", password, [
    "file.read",
  ]);
  const second = await f.legacyEnroll("server-b", "legacy-b", secondPassword, [
    "control.start",
  ]);
  const invitation = await f.access.inviteAccount(
    f.access.listAccounts()[0].id,
  );
  assert.ok(await f.access.authenticate(req(first.cookie)));
  assert.ok(await f.access.authenticate(req(second.cookie)));
  const accepted = await f.access.accept(
    token(invitation),
    "New consolidated fixture password!",
  );
  assert.deepEqual(
    accepted.session.memberships.map((scope) => scope.serverId),
    f.servers,
  );
  assert.equal(await f.access.authenticate(req(first.cookie)), null);
  assert.equal(await f.access.authenticate(req(second.cookie)), null);
  await assert.rejects(
    f.access.login({ email: "legacy@example.test", password }),
    { status: 401 },
  );
  await assert.rejects(
    f.access.login({ email: "legacy@example.test", password: secondPassword }),
    { status: 401 },
  );
  await assert.rejects(f.access.accept(token(invitation), password), {
    status: 401,
  });
  f.servers.push("server-c");
  assert.equal(
    f.access.userForServer("server-c", accepted.session.accountId),
    null,
    "reset keeps the selected legacy access policy",
  );
});

test("legacy primary revocation retains only other proven memberships and never inherits same-email scopes", async (t) => {
  const f = await fixture(t);
  await f.legacyEnroll("server-a", "legacy-a", password, ["file.read"]);
  await f.legacyEnroll("server-b", "legacy-b", password, ["control.start"]);
  const signed = await f.access.login({
    email: "legacy@example.test",
    password,
  });
  await f.access.revoke("server-a", "legacy-a");
  const retained = await f.access.authenticate(req(signed.cookie));
  assert.equal(retained.serverId, "server-b");
  assert.deepEqual(retained.memberships, [
    { serverId: "server-b", userId: "legacy-b" },
  ]);
});

test("panel invitation reset and account deletion revoke sessions without resurrecting legacy rows", async (t) => {
  const f = await fixture(t);
  await f.legacyEnroll("server-a", "legacy-a", password, ["file.read"]);
  const invitation = await f.access.inviteAccount(
    f.access.listAccounts()[0].id,
  );
  const first = await f.access.accept(token(invitation), password);
  const acceptedAt = f.access.invitationState(
    "server-a",
    first.session.accountId,
  ).acceptedAt;
  const reset = await f.access.inviteAccount(first.session.accountId);
  assert.equal(await f.access.authenticate(req(first.cookie)), null);
  assert.equal(
    f.access.resolveUser("server-a", "legacy-a", f.legacy[0].user),
    null,
  );
  await assert.rejects(f.access.invite(f.legacy[0]), { status: 404 });
  const extraLegacy = {
    serverId: "server-b",
    user: {
      id: "new-legacy-id",
      email: "legacy@example.test",
    },
  };
  f.legacy.push(extraLegacy);
  await assert.rejects(f.access.invite(extraLegacy), { status: 404 });
  assert.equal(
    f.access.membershipAllowed("server-a", first.session.accountId),
    false,
  );
  const second = await f.access.accept(token(reset), secondPassword);
  assert.notEqual(
    f.access.invitationState("server-a", first.session.accountId).acceptedAt,
    acceptedAt,
  );
  await assert.rejects(f.access.invite(extraLegacy), { status: 404 });
  await f.access.deleteAccount(first.session.accountId);
  assert.equal(await f.access.authenticate(req(second.cookie)), null);
  assert.deepEqual(f.access.listAccounts(), []);
  assert.equal(
    f.access.resolveUser("server-a", "legacy-a", f.legacy[0].user),
    null,
  );
});

test("removing a server leaves its explicit grant editable and preserves revocation if restored", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  await f.access.grantServer("server-a", member.account.id, {
    permissions: ["server.view"],
  });
  await f.access.grantServer("server-b", member.account.id, {
    permissions: ["server.view", "file.read"],
  });
  await f.access.revoke("server-b", member.account.id);
  f.servers.splice(f.servers.indexOf("server-b"), 1);
  await f.access.updateAccount(member.account.id, { hostPermissions: [] });
  await assert.rejects(
    f.access.grantServer("unknown-id", member.account.id, {
      permissions: ["server.view"],
    }),
    { status: 404 },
  );
  f.servers.push("server-b");
  assert.equal(f.access.userForServer("server-b", member.account.id), null);
  assert.deepEqual(
    (await f.access.authenticate(req(member.cookie))).memberships,
    [{ serverId: "server-a", userId: member.account.id }],
  );
});

test("creator enrollment adds a selected server once and cannot restore later revoked access", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll({
    hostPermissions: ["server.create"],
  });
  const authority = await f.access.hostAuthority(req(member.cookie));
  const target = {
    serverId: "server-a",
    userId: member.account.id,
    email: member.account.email,
  };
  await f.access.enrollCreated(req(member.cookie), authority, target);
  assert.deepEqual(
    f.access.userForServer("server-a", member.account.id).permissions,
    catalog.roleDefaults.admin,
  );
  await f.access.enrollCreated(req(member.cookie), authority, target);
  assert.deepEqual(f.access.account(member.account.id).serverIds, ["server-a"]);
  await f.access.revoke("server-a", member.account.id);
  await assert.rejects(
    f.access.enrollCreated(req(member.cookie), authority, target),
    { status: 403 },
  );
});

test("promoted legacy creators enroll only the new server atomically without widening other proofs", async (t) => {
  const f = await fixture(t);
  const first = await f.legacyEnroll("server-a", "legacy-a", password, [
    "file.read",
  ]);
  const second = await f.legacyEnroll("server-b", "legacy-b", secondPassword, [
    "control.start",
  ]);
  const account = await f.access.updateAccount(f.access.listAccounts()[0].id, {
    hostPermissions: ["server.create"],
  });
  const authority = await f.access.hostAuthority(req(first.cookie));
  f.servers.push("server-c");
  const target = {
    serverId: "server-c",
    userId: "legacy-created",
    email: account.email,
  };
  const base = { id: target.userId, email: target.email, permissions: [] };
  f.legacy.push({ serverId: target.serverId, user: base });
  assert.equal(
    f.access.resolveUser(target.serverId, target.userId, base),
    null,
  );
  const rename = fs.rename;
  const injected = t.mock.method(fs, "rename", async (source, destination) => {
    if (destination === path.join(f.root, "remote-access.json"))
      throw new Error("Fixture enrollment persistence failure");
    return rename(source, destination);
  });
  await assert.rejects(
    f.access.enrollCreated(req(first.cookie), authority, target),
    { status: 500 },
  );
  assert.deepEqual(f.access.account(account.id), account);
  assert.equal(
    f.access.resolveUser(target.serverId, target.userId, base),
    null,
  );
  assert.equal(
    (await f.access.authenticate(req(first.cookie))).memberships.length,
    1,
  );
  injected.mock.restore();
  await f.access.enrollCreated(req(first.cookie), authority, target);
  await f.access.enrollCreated(req(first.cookie), authority, target);
  assert.deepEqual(
    (await f.access.authenticate(req(first.cookie))).memberships,
    [
      { serverId: "server-a", userId: "legacy-a" },
      { serverId: target.serverId, userId: target.userId },
    ],
  );
  assert.deepEqual(
    (await f.access.authenticate(req(second.cookie))).memberships,
    [{ serverId: "server-b", userId: "legacy-b" }],
  );
  assert.deepEqual(
    f.access.resolveUser(target.serverId, target.userId, base).permissions,
    catalog.roleDefaults.admin,
  );
  const enrolled = f.access.account(account.id);
  assert.equal(enrolled.legacyMembers.length, 3);
  assert.deepEqual(enrolled.creatorServerIds, [target.serverId]);
  await f.access.grantServer(target.serverId, account.id, {
    permissions: ["server.view", "file.read"],
  });
  await f.access.enrollCreated(req(first.cookie), authority, target);
  assert.deepEqual(
    f.access.resolveUser(target.serverId, target.userId, base).permissions,
    ["server.view", "file.read"],
    "retry cannot restore permissions changed by the owner",
  );
  await f.access.close();
  const restarted = await f.boot();
  assert.deepEqual(
    (await restarted.login({ email: account.email, password })).session
      .memberships,
    [
      { serverId: "server-a", userId: "legacy-a" },
      { serverId: target.serverId, userId: target.userId },
    ],
  );
  assert.deepEqual(
    (await restarted.login({ email: account.email, password: secondPassword }))
      .session.memberships,
    [{ serverId: "server-b", userId: "legacy-b" }],
  );
  await restarted.revoke(target.serverId, target.userId);
  await assert.rejects(
    restarted.enrollCreated(req(first.cookie), authority, target),
    { status: 403 },
  );
  await restarted.grantServer(target.serverId, account.id, {
    permissions: ["server.view", "file.read"],
  });
  await assert.rejects(
    restarted.enrollCreated(req(first.cookie), authority, target),
    { status: 403 },
    "creator tombstone survives re-enabling the server policy",
  );
});

test("invalid account grants and failed persistence cannot publish partial account changes", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  const before = f.access.account(member.account.id);
  for (const patch of [
    { permissions: ["unknown"] },
    { hostPermissions: null },
    { serverIds: ["missing"] },
    { serverOverrides: { "server-a": { permissions: ["unknown"] } } },
    { email: "different@example.test" },
  ])
    await assert.rejects(f.access.updateAccount(member.account.id, patch), {
      status: 400,
    });
  const rename = fs.rename;
  const injected = t.mock.method(fs, "rename", async (source, destination) => {
    if (destination === path.join(f.root, "remote-access.json"))
      throw new Error("Fixture persistence failure");
    return rename(source, destination);
  });
  await assert.rejects(
    f.access.grantServer("server-a", member.account.id, {
      permissions: ["server.view", "control.start"],
    }),
    { status: 500 },
  );
  assert.deepEqual(f.access.account(member.account.id), before);
  assert.equal(
    (await f.access.authenticate(req(member.cookie))).memberships.length,
    0,
  );
  injected.mock.restore();
});

test("malformed account storage fails closed without rewriting durable credentials", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  const storage = path.join(f.root, "remote-access.json");
  const saved = JSON.parse(await fs.readFile(storage, "utf8"));
  for (const changed of [
    { ...saved, accounts: null },
    { ...saved, accounts: [...saved.accounts, ...saved.accounts] },
  ]) {
    const text = JSON.stringify(changed);
    await fs.writeFile(storage, text);
    await assert.rejects(f.boot(), { status: 500 });
    assert.equal(await fs.readFile(storage, "utf8"), text);
  }
  await fs.writeFile(storage, JSON.stringify(saved));
});

test("an unavailable legacy profile cannot be silently replaced by a new account", async (t) => {
  const f = await fixture(t);
  await f.legacyEnroll("server-a", "legacy-a", password, ["file.read"]);
  const saved = f.legacy.splice(0);
  await assert.rejects(
    f.access.createAccount({
      email: "legacy@example.test",
    }),
    { status: 409 },
  );
  f.legacy.push(...saved);
  assert.deepEqual(
    (await f.access.login({ email: "legacy@example.test", password })).session
      .memberships,
    [{ serverId: "server-a", userId: "legacy-a" }],
  );
});

test("v3 migration freezes existing grants and retains unavailable mappings for owner review", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  const storage = path.join(f.root, "remote-access.json");
  const saved = JSON.parse(await fs.readFile(storage, "utf8"));
  saved.version = 3;
  Object.assign(saved.accounts[0], {
    accessMode: "all",
    permissions: ["file.read"],
    serverIds: ["missing-server"],
    excludedServerIds: ["server-b"],
    serverOverrides: {
      "server-a": { permissions: ["control.start"] },
      "missing-server": { permissions: ["file.delete"] },
    },
  });
  await f.access.close();
  await fs.writeFile(storage, JSON.stringify(saved));
  const migrated = await f.boot();
  const account = migrated.account(member.account.id);
  assert.deepEqual(account.serverIds, ["server-a"]);
  assert.equal(account.accessMode, "selected");
  assert.deepEqual(account.permissions, []);
  assert.deepEqual(migrated.userForServer("server-a", account.id).permissions, [
    "server.view",
    "control.start",
  ]);
  assert.equal(migrated.userForServer("server-b", account.id), null);
  assert.deepEqual(account.accessReview.serverIds, ["missing-server"]);
  assert.deepEqual(
    account.accessReview.previousPolicy.serverOverrides["missing-server"]
      .permissions,
    ["file.delete"],
  );
  f.servers.push("server-c", "missing-server");
  assert.equal(migrated.userForServer("server-c", account.id), null);
  assert.equal(migrated.userForServer("missing-server", account.id), null);
  assert.deepEqual(
    (await migrated.authenticate(req(member.cookie))).memberships,
    [{ serverId: "server-a", userId: account.id }],
  );
  const durable = JSON.parse(await fs.readFile(storage, "utf8"));
  assert.equal(durable.version, 4);
  assert.deepEqual(durable.accounts[0].accessReview, account.accessReview);
  await migrated.close();
  const restarted = await f.boot();
  assert.deepEqual(restarted.account(account.id).serverIds, ["server-a"]);
});

test("v3 unmapped permissions are retained without granting existing or future servers", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  const storage = path.join(f.root, "remote-access.json");
  const saved = JSON.parse(await fs.readFile(storage, "utf8"));
  saved.version = 3;
  saved.accounts[0].permissions = ["file.delete"];
  await f.access.close();
  await fs.writeFile(storage, JSON.stringify(saved));
  const migrated = await f.boot();
  const account = migrated.account(member.account.id);
  assert.deepEqual(account.accessReview.previousPolicy.permissions, [
    "file.delete",
  ]);
  assert.deepEqual(
    (await migrated.authenticate(req(member.cookie))).memberships,
    [],
  );
  f.servers.push("server-c");
  assert.equal(migrated.userForServer("server-c", account.id), null);
});

test("v4 malformed server overrides fail closed without altering the access file", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  const storage = path.join(f.root, "remote-access.json");
  const saved = JSON.parse(await fs.readFile(storage, "utf8"));
  for (const override of [
    {},
    null,
    { permissions: "server.view" },
    { permissions: [], hostPermissions: "server.create" },
  ]) {
    saved.accounts[0].serverOverrides = { "server-a": override };
    const bytes = JSON.stringify(saved);
    await fs.writeFile(storage, bytes);
    await assert.rejects(f.boot(), { status: 500 });
    assert.equal(await fs.readFile(storage, "utf8"), bytes);
  }
});

test("a basic server view grant is required and account-wide server policies are rejected", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  for (const permissions of [["file.read"], ["user.update"], ["unknown"]])
    await assert.rejects(
      f.access.grantServer("server-a", member.account.id, { permissions }),
      { status: 400 },
    );
  await assert.rejects(
    f.access.updateAccount(member.account.id, { accessMode: "all" }),
    { status: 400 },
  );
  await assert.rejects(
    f.access.createAccount({
      email: "broad@example.test",
      permissions: ["server.view"],
      serverIds: ["server-a"],
    }),
    { status: 400 },
  );
  assert.deepEqual(
    (await f.access.authenticate(req(member.cookie))).memberships,
    [],
  );
  await f.access.grantServer("server-a", member.account.id, {
    permissions: ["server.view"],
  });
  assert.deepEqual(
    f.access.userForServer("server-a", member.account.id).permissions,
    ["server.view"],
  );
});

test("ambiguous duplicate legacy identities retain independent scopes instead of unioning grants", async (t) => {
  const f = await fixture(t);
  const first = await f.legacyEnroll("server-a", "legacy-a", password, [
    "file.read",
  ]);
  const second = await f.legacyEnroll(
    "server-a",
    "legacy-duplicate",
    secondPassword,
    ["control.start"],
  );
  const row = f.access.listAccounts()[0];
  assert.equal(row.accessReview.duplicateLegacyIdentities, true);
  assert.deepEqual(row.serverOverrides["server-a"].permissions, [
    "server.view",
    "file.read",
  ]);
  await assert.rejects(f.access.inviteAccount(row.id), { status: 409 });
  await assert.rejects(f.access.updateAccount(row.id, {}), { status: 409 });
  assert.deepEqual(
    (await f.access.authenticate(req(first.cookie))).permissions,
    ["file.read"],
  );
  assert.deepEqual(
    (await f.access.authenticate(req(second.cookie))).permissions,
    ["control.start"],
  );
  assert.equal(f.legacy.length, 2);
});
