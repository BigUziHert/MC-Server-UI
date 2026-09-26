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
  const options = {
    dataDir: root,
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
      permissions: ["file.read"],
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
  return { root, access, servers, legacy, boot, enroll, legacyEnroll };
}

test("panel accounts include future servers dynamically and retain one durable credential", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  assert.equal(member.account.accessMode, "all");
  assert.equal(
    f.access.userForServer("server-a", member.account.id).createdAt,
    member.account.createdAt,
  );
  assert.equal(member.session.accountId, member.account.id);
  assert.equal(member.session.userId, member.account.id);
  assert.deepEqual(
    member.session.memberships.map((scope) => scope.serverId),
    f.servers,
  );
  f.servers.push("server-c");
  assert.deepEqual(
    (await f.access.authenticate(req(member.cookie))).memberships.map(
      (scope) => scope.serverId,
    ),
    f.servers,
  );
  await f.access.close();
  const restarted = await f.boot();
  assert.deepEqual(
    (await restarted.authenticate(req(member.cookie))).memberships.map(
      (scope) => scope.serverId,
    ),
    f.servers,
  );
  assert.deepEqual(
    (
      await restarted.login({ email: member.account.email, password })
    ).session.memberships.map((scope) => scope.serverId),
    f.servers,
  );
  const saved = JSON.parse(
    await fs.readFile(path.join(f.root, "remote-access.json"), "utf8"),
  );
  assert.equal(saved.version, 3);
  assert.equal(saved.accounts.length, 1);
  assert.equal(saved.memberships.length, 0);
  assert.equal(JSON.stringify(saved).includes(password), false);
  assert.equal(JSON.stringify(saved).includes(token(member.invitation)), false);
  assert.equal(
    JSON.stringify(f.access.listAccounts()).includes('"password"'),
    false,
  );
});

test("per-server exclusions and overrides are live without logging out unrelated or zero-server accounts", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll({ hostPermissions: ["server.create"] });
  await f.access.updateAccount(member.account.id, {
    excludedServerIds: ["server-a"],
    serverOverrides: {
      "server-b": { permissions: ["file.read", "file.create"] },
    },
  });
  assert.equal(f.access.userForServer("server-a", member.account.id), null);
  assert.equal(
    f.access.membershipAllowed("server-a", member.account.id),
    false,
  );
  assert.deepEqual(
    f.access.userForServer("server-b", member.account.id).permissions,
    ["file.read", "file.create"],
  );
  assert.equal(
    (await f.access.authenticate(req(member.cookie))).serverId,
    "server-b",
  );
  await f.access.updateAccount(member.account.id, {
    excludedServerIds: [...f.servers],
    permissions: ["control.start"],
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
    [{ serverId: "server-c", userId: member.account.id }],
  );
  await f.access.updateAccount(member.account.id, { excludedServerIds: [] });
  assert.deepEqual(
    f.access.userForServer("server-b", member.account.id).permissions,
    ["file.read", "file.create"],
    "omitted overrides survive base edits",
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
  assert.deepEqual(row.serverOverrides["server-a"].permissions, ["file.read"]);
  const promoted = await f.access.updateAccount(row.id, {
    permissions: ["backup.read"],
  });
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
  await f.access.updateAccount(promoted.id, {
    excludedServerIds: ["server-a"],
  });
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
      permissions: ["file.read"],
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

test("removing a server leaves its account policy editable and preserves its exclusion if restored", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll({
    accessMode: "selected",
    serverIds: ["server-a", "server-b"],
    excludedServerIds: ["server-b"],
    serverOverrides: { "server-b": { permissions: ["file.read"] } },
  });
  f.servers.splice(f.servers.indexOf("server-b"), 1);
  const current = f.access.account(member.account.id);
  await f.access.updateAccount(member.account.id, {
    permissions: ["control.start"],
    serverIds: current.serverIds,
    excludedServerIds: current.excludedServerIds,
    serverOverrides: current.serverOverrides,
  });
  await assert.rejects(
    f.access.updateAccount(member.account.id, {
      serverIds: [...current.serverIds, "unknown-id"],
    }),
    { status: 400 },
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
    accessMode: "selected",
    serverIds: [],
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
  await f.access.updateAccount(member.account.id, { serverIds: [] });
  await assert.rejects(
    f.access.enrollCreated(req(member.cookie), authority, target),
    { status: 403 },
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
    f.access.updateAccount(member.account.id, {
      excludedServerIds: [...f.servers],
    }),
    { status: 500 },
  );
  assert.deepEqual(f.access.account(member.account.id), before);
  assert.equal(
    (await f.access.authenticate(req(member.cookie))).memberships.length,
    2,
  );
  injected.mock.restore();
});

test("malformed v3 account storage fails closed without rewriting durable credentials", async (t) => {
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

test("an unavailable legacy profile cannot be silently replaced by a new all-server account", async (t) => {
  const f = await fixture(t);
  await f.legacyEnroll("server-a", "legacy-a", password, ["file.read"]);
  const saved = f.legacy.splice(0);
  await assert.rejects(
    f.access.createAccount({
      email: "legacy@example.test",
      permissions: ["file.read"],
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
