import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { createAccessService } from "./access.mjs";
import { createRemoteGateway } from "./remote-access.mjs";

const password = "Panel leave fixture password!";
const req = (token) => ({ headers: { authorization: `Bearer ${token}` } });
const confirmation = (requestId = randomUUID()) => ({
  confirmed: true,
  requestId,
});
const inviteToken = (invitation) =>
  new URL(invitation.invitationUrl).hash.slice(8);
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-panel-leave-"));
  const storage = path.join(root, "remote-access.json");
  let time = Date.UTC(2026, 8, 27);
  const legacy = [],
    services = [];
  const serverIds = ["server-a", "server-b", "server-c"];
  const options = {
    dataDir: root,
    now: () => time,
    listServerIds: () => serverIds,
    listLegacyUsers: () => legacy,
    getUser: (serverId, userId) =>
      legacy.find(
        (entry) => entry.serverId === serverId && entry.user.id === userId,
      )?.user,
  };
  const boot = async () => {
    const service = await createAccessService(options);
    services.push(service);
    return service;
  };
  const access = await boot();
  await access.configure({
    enabled: true,
    publicUrl: "https://leave.example.test",
    transport: "proxy",
  });
  t.after(async () => {
    for (const service of services) await service.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-panel-leave-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const enroll = async (email = "leaving@example.test", service = access) => {
    const account = await service.createAccount({
      email,
      hostPermissions: ["server.create"],
    });
    const accepted = await service.accept(
      inviteToken(await service.inviteAccount(account.id)),
      password,
    );
    return { account, ...accepted };
  };
  const grant = (id, serverId = "server-a", service = access) =>
    service.grantServer(serverId, id, {
      permissions: ["server.view", "file.read-content"],
    });
  const read = async () => JSON.parse(await fs.readFile(storage, "utf8"));
  return {
    root,
    storage,
    access,
    boot,
    enroll,
    grant,
    legacy,
    serverIds,
    read,
    advance: (ms) => {
      time += ms;
    },
  };
}

test("self-leave removes all caller grants and sessions while preserving other accounts and server data", async (t) => {
  const f = await fixture(t);
  const a = await f.enroll(),
    b = await f.enroll("remaining@example.test");
  await f.grant(a.account.id);
  await f.grant(a.account.id, "server-b");
  await f.grant(b.account.id);
  const second = await f.access.login({ email: a.account.email, password });
  const otherBefore = f.access.account(b.account.id);
  await fs.writeFile(
    path.join(f.root, "server-data.txt"),
    "Untouched world bytes",
  );
  const input = confirmation();
  const result = await f.access.leave(req(a.token), input);
  assert.deepEqual(result, { left: true, requestId: input.requestId });
  assert.equal(f.access.account(a.account.id), null);
  assert.equal(f.access.userForServer("server-a", a.account.id), null);
  assert.equal(f.access.userForServer("server-b", a.account.id), null);
  assert.equal(await f.access.authenticate(req(a.token)), null);
  assert.equal(await f.access.authenticate(req(second.token)), null);
  await assert.rejects(f.access.hostAuthority(req(second.token)), {
    status: 403,
  });
  await assert.rejects(f.access.login({ email: a.account.email, password }), {
    status: 401,
  });
  assert.deepEqual(f.access.account(b.account.id), otherBefore);
  assert.equal(
    (await f.access.authenticate(req(b.token))).accountId,
    b.account.id,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, "server-data.txt"), "utf8"),
    "Untouched world bytes",
  );
  const saved = await f.read();
  assert.equal(
    saved.sessions.some((entry) => entry.email === a.account.email),
    false,
  );
  assert.equal(
    saved.memberships.some((entry) => entry.email === a.account.email),
    false,
  );
  assert.equal(
    saved.tokens.some((entry) => entry.email === a.account.email),
    false,
  );
  assert.equal(f.access.creationAllowed("server-a", a.account.id), false);
});

test("lost leave responses retry after host restart without authorizing resources or deleting a recreated account", async (t) => {
  const f = await fixture(t),
    a = await f.enroll();
  const input = confirmation();
  await Promise.all([
    f.access.leave(req(a.token), input),
    f.access.leave(req(a.token), input),
  ]);
  const saved = await f.read();
  assert.equal(saved.leaveReceipts.length, 1);
  assert.deepEqual(Object.keys(saved.leaveReceipts[0]).sort(), [
    "expiresAt",
    "proofHash",
    "requestHash",
  ]);
  assert.ok(!JSON.stringify(saved.leaveReceipts).includes(a.token));
  assert.ok(!JSON.stringify(saved.leaveReceipts).includes(a.account.email));
  assert.ok(!JSON.stringify(saved.leaveReceipts).includes(input.requestId));
  await f.access.close();
  const restarted = await f.boot();
  const replacement = await f.enroll(a.account.email, restarted);
  assert.deepEqual(await restarted.leave(req(a.token), input), {
    left: true,
    requestId: input.requestId,
  });
  assert.equal(
    (await restarted.authenticate(req(replacement.token))).accountId,
    replacement.account.id,
  );
  assert.equal(await restarted.authenticate(req(a.token)), null);
  await assert.rejects(restarted.leave(req(a.token), confirmation()), {
    status: 401,
  });
  await assert.rejects(restarted.leave(req(replacement.token), input), {
    status: 403,
  });
  assert.ok(restarted.account(replacement.account.id));
});

test("legacy self-leave retires every proven membership and promoted computer grant", async (t) => {
  const f = await fixture(t);
  const email = "legacy@example.test";
  const enroll = async (serverId, userId, accepted = true, prior) => {
    const user = {
      id: userId,
      email,
      permissions: ["server.view", "file.read-content"],
      hostPermissions: ["server.create"],
    };
    f.legacy.push({ serverId, user });
    const invitation = await f.access.invite({ serverId, user });
    return accepted
      ? f.access.accept(inviteToken(invitation), password, prior)
      : invitation;
  };
  const a = await enroll("server-a", "legacy-a");
  const ab = await enroll("server-b", "legacy-b", true, req(a.token));
  const independent = await f.access.login({ email, password });
  const promoted = await f.access.updateAccount(`legacy:${email}`, {
    hostPermissions: ["server.create"],
  });
  assert.equal(promoted.legacyPending, true);
  await f.access.leave(req(ab.token), confirmation());
  assert.equal(f.access.account(promoted.id), null);
  assert.deepEqual(f.access.listAccounts(), []);
  assert.equal(await f.access.authenticate(req(independent.token)), null);
  for (const { serverId, user } of f.legacy) {
    assert.equal(f.access.resolveUser(serverId, user.id, user), null);
    assert.equal(f.access.membershipAllowed(serverId, user.id, email), false);
    assert.equal(f.access.creationAllowed(serverId, user.id), false);
  }
  await assert.rejects(
    f.access.withLegacyIdentity(email, () =>
      assert.fail("retired identity recreated"),
    ),
    { status: 409 },
  );
});

test("legacy self-leave cannot retire an unproven same-email identity or invitation", async (t) => {
  const f = await fixture(t);
  const email = "shared-email@example.test";
  const enroll = async (serverId, userId, credential) => {
    const user = {
      id: userId,
      email,
      permissions: ["server.view"],
      hostPermissions: ["server.create"],
    };
    f.legacy.push({ serverId, user });
    const invitation = await f.access.invite({ serverId, user });
    return credential
      ? f.access.accept(inviteToken(invitation), credential)
      : invitation;
  };
  const a = await enroll("server-a", "legacy-a", password);
  const b = await enroll("server-b", "legacy-b", "Unrelated password for B!");
  const pending = await enroll("server-c", "legacy-c");
  const original = await fs.readFile(f.storage, "utf8");
  await assert.rejects(f.access.leave(req(a.token), confirmation()), {
    status: 409,
  });
  assert.equal(await fs.readFile(f.storage, "utf8"), original);
  assert.equal((await f.access.authenticate(req(a.token))).userId, "legacy-a");
  assert.equal((await f.access.authenticate(req(b.token))).userId, "legacy-b");
  const saved = await f.read();
  assert.deepEqual(saved.retiredLegacyEmails, []);
  assert.deepEqual(saved.leaveReceipts, []);
  assert.deepEqual(saved.creationRevocations, []);
  const c = await f.access.accept(
    inviteToken(pending),
    "A separate C password!",
  );
  assert.equal(c.session.userId, "legacy-c");
});

test("a migrated account-wide policy can leave with no server-side process or registry mutation", async (t) => {
  const f = await fixture(t),
    a = await f.enroll();
  const saved = await f.read();
  saved.version = 3;
  Object.assign(saved.accounts[0], {
    accessMode: "all",
    permissions: ["server.view", "control.start"],
    serverIds: [],
    excludedServerIds: [],
    serverOverrides: {},
  });
  await f.access.close();
  await fs.writeFile(f.storage, JSON.stringify(saved));
  const migrated = await f.boot();
  assert.equal(
    (await migrated.authenticate(req(a.token))).memberships.length,
    3,
  );
  await migrated.leave(req(a.token), confirmation());
  assert.equal(migrated.account(a.account.id), null);
  assert.deepEqual(f.serverIds, ["server-a", "server-b", "server-c"]);
});

test("confirmation and nonce validation never let a caller target another account", async (t) => {
  const f = await fixture(t),
    a = await f.enroll(),
    b = await f.enroll("other@example.test");
  for (const body of [
    undefined,
    {},
    [],
    { requestId: randomUUID() },
    { confirmed: false, requestId: randomUUID() },
    { confirmed: true, requestId: "bad" },
    { ...confirmation(), accountId: b.account.id },
  ])
    await assert.rejects(f.access.leave(req(a.token), body), { status: 400 });
  await assert.rejects(f.access.leave(req("z".repeat(43)), confirmation()), {
    status: 401,
  });
  await assert.rejects(
    f.access.leave({ headers: { cookie: a.cookie } }, confirmation()),
    { status: 401 },
  );
  assert.ok(f.access.account(a.account.id));
  assert.ok(f.access.account(b.account.id));
  f.advance(8 * 24 * 60 * 60 * 1000);
  await assert.rejects(f.access.leave(req(a.token), confirmation()), {
    status: 401,
  });
  assert.ok(f.access.account(a.account.id));
});

test("leave verifies the current credential after queued owner resets and serializes later grant changes", async (t) => {
  const f = await fixture(t),
    a = await f.enroll();
  const reset = f.access.inviteAccount(a.account.id);
  const rejected = assert.rejects(
    f.access.leave(req(a.token), confirmation()),
    { status: 401 },
  );
  const invitation = await reset;
  await rejected;
  assert.ok(f.access.account(a.account.id));
  const next = await f.access.accept(inviteToken(invitation), password);
  const priorGrant = f.grant(a.account.id, "server-b");
  const left = f.access.leave(req(next.token), confirmation());
  const lateGrant = assert.rejects(f.grant(a.account.id), { status: 404 });
  await priorGrant;
  await left;
  await lateGrant;
  assert.equal(f.access.account(a.account.id), null);
  assert.equal(f.access.creationAllowed("server-b", a.account.id), false);
});

test("leave revocation and receipt roll back together when the atomic persistence fails", async (t) => {
  const f = await fixture(t),
    a = await f.enroll();
  const original = await fs.readFile(f.storage, "utf8"),
    backup = f.storage + ".fixture-backup";
  await fs.rename(f.storage, backup);
  await fs.mkdir(f.storage);
  const input = confirmation();
  try {
    await assert.rejects(f.access.leave(req(a.token), input), { status: 500 });
    assert.equal(
      (await f.access.authenticate(req(a.token))).accountId,
      a.account.id,
    );
  } finally {
    await fs.rmdir(f.storage);
    await fs.rename(backup, f.storage);
  }
  assert.equal(await fs.readFile(f.storage, "utf8"), original);
  await f.access.leave(req(a.token), input);
  assert.equal((await f.read()).leaveReceipts.length, 1);
});

test("leave receipts expire and capacity exhaustion never discards live retry proofs or revokes an account", async (t) => {
  const f = await fixture(t),
    a = await f.enroll();
  const saved = await f.read();
  saved.leaveReceipts = Array.from({ length: 4096 }, (_, index) => ({
    requestHash: hash(`fixture-request-${index}`),
    proofHash: hash(`fixture-proof-${index}`),
    expiresAt: Date.UTC(2026, 8, 28),
  }));
  await f.access.close();
  await fs.writeFile(f.storage, JSON.stringify(saved));
  const loaded = await f.boot(),
    input = confirmation();
  await assert.rejects(loaded.leave(req(a.token), input), { status: 503 });
  assert.ok(loaded.account(a.account.id));
  assert.equal((await f.read()).leaveReceipts.length, 4096);
  f.advance(2 * 24 * 60 * 60 * 1000);
  await loaded.leave(req(a.token), input);
  assert.equal((await f.read()).leaveReceipts.length, 1);
  f.advance(8 * 24 * 60 * 60 * 1000);
  await assert.rejects(loaded.leave(req(a.token), input), { status: 401 });
});

test("real gateway leave enforces Origin, authentication and confirmation; receipt retries cannot call other APIs", async (t) => {
  const f = await fixture(t),
    a = await f.enroll();
  const app = createRemoteGateway({
    access: f.access,
    runtimes: new Map(),
    distDir: f.root,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  });
  const request = (
    route,
    body,
    {
      origin = "https://leave.example.test",
      bearer = a.token,
      method = "POST",
    } = {},
  ) =>
    new Promise((resolve, reject) => {
      const call = http.request(
        `http://127.0.0.1:${listener.address().port}${route}`,
        {
          method,
          headers: {
            Host: "leave.example.test",
            Origin: origin,
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (part) => {
            text += part;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, body: JSON.parse(text) }),
          );
        },
      );
      call.on("error", reject);
      call.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const input = confirmation();
  assert.equal(
    (
      await request("/api/access/leave", input, {
        origin: "https://unrelated.example.test",
      })
    ).status,
    403,
  );
  assert.equal((await request("/api/access/leave", {})).status, 400);
  assert.equal(
    (await request("/api/access/leave", input, { bearer: "z".repeat(43) }))
      .status,
    401,
  );
  assert.equal(
    (await request("/api/access/leave", undefined, { method: "GET" })).status,
    403,
  );
  assert.equal((await request("/api/access/leave", input)).status, 200);
  assert.deepEqual((await request("/api/access/leave", input)).body, {
    left: true,
    requestId: input.requestId,
  });
  assert.equal(
    (await request("/api/servers", undefined, { method: "GET" })).status,
    401,
  );
});
