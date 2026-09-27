import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createFleet } from "./index.mjs";
import { SUBUSER_COOKIE } from "./access.mjs";

const origin = "https://panel.example.test";
const workspace = "https://workspace.example.test";
const password = "Browser CORS fixture password!";
const browserHeaders = { Origin: workspace, "X-MC-Panel-Client": "browser" };
const preflightHeaders = {
  Origin: workspace,
  "Access-Control-Request-Method": "GET",
  "Access-Control-Request-Headers":
    "authorization,x-mc-panel-client,x-server-id",
};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-remote-cors-"));
  const fleet = await createFleet({
    dataDir: root,
    useEnvironment: false,
    createDefaultServer: true,
    scheduler: false,
    remoteListen: false,
    publicAddress: { resolve: async () => null },
  });
  const listen = (app) =>
    new Promise((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
  const owner = await listen(fleet.app);
  const remote = await listen(fleet.remoteApp);
  t.after(async () => {
    await fleet.close();
    for (const server of [owner, remote]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-remote-cors-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const request =
    (server, defaults = {}) =>
    (route, options = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${server.address().port}${route}`,
          {
            method: options.method ?? "GET",
            headers: { ...defaults, ...options.headers },
          },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              let body = text;
              try {
                body = JSON.parse(text);
              } catch {
                /* Empty preflight or file bytes. */
              }
              resolve({ status: res.statusCode, headers: res.headers, body });
            });
          },
        );
        req.on("error", reject);
        req.end(options.body);
      });
  const local = request(owner);
  const remoteRequest = request(remote, { Host: "panel.example.test" });
  await fleet.access.configure({
    enabled: true,
    publicUrl: origin,
    transport: "proxy",
  });
  const serverId = (await local("/api/servers")).body.defaultServerId;
  const enroll = async (permissions = [], email = "member@example.test") => {
    const account = await fleet.access.createAccount({ email });
    await fleet.access.grantServer(serverId, account.id, {
      permissions: ["server.view", ...permissions],
    });
    const invitation = await fleet.access.inviteAccount(account.id);
    const token = new URL(invitation.invitationUrl).hash.slice(
      "#invite=".length,
    );
    const accepted = await remoteRequest("/api/access/accept", {
      method: "POST",
      headers: { ...browserHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    return { account, token: accepted.body.sessionToken, accepted };
  };
  return { fleet, root, local, request: remoteRequest, serverId, enroll };
}

function assertCors(result, expectedOrigin = workspace) {
  assert.equal(result.headers["access-control-allow-origin"], expectedOrigin);
  assert.equal(result.headers["access-control-allow-credentials"], undefined);
  assert.match(result.headers.vary, /(?:^|,\s*)Origin(?:,|$)/);
}

test("browser preflight allows concrete API methods and headers from secure or canonical loopback origins", async (t) => {
  const f = await fixture(t);
  for (const value of [
    workspace,
    "https://192.168.1.20:3443",
    "http://localhost:5173",
    "http://127.0.0.1:3001",
    "http://127.0.0.2:3001",
    "http://[::1]:3001",
  ]) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      const result = await f.request("/api/files/upload", {
        method: "OPTIONS",
        headers: {
          ...preflightHeaders,
          Origin: value,
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers":
            "Authorization, Content-Type, X-Server-Id, X-MC-Panel-Client",
        },
      });
      assert.equal(result.status, 204);
      assert.equal(result.body, "");
      assertCors(result, value);
      assert.equal(
        result.headers["access-control-allow-headers"],
        "authorization, content-type, x-server-id, x-mc-panel-client",
      );
      assert.equal(
        result.headers["access-control-allow-methods"],
        "GET, HEAD, POST, PUT, PATCH, DELETE",
      );
    }
  }
});

test("browser preflight rejects malformed origins, undeclared headers, missing client marker and unsupported methods", async (t) => {
  const f = await fixture(t);
  for (const Origin of [
    "null",
    "http://workspace.example.test",
    "http://192.168.1.20",
    "https://workspace.example.test/",
    "https://workspace.example.test/path",
    "https://user@workspace.example.test",
    "https://workspace.example.test?x=1",
    "https://workspace.example.test#x",
    "HTTPS://workspace.example.test",
    "http://127.1:3001",
    "http://127.attacker.example",
    "http://127.0.0.1.attacker.example",
    "http://localhost.evil.test",
    "file://",
    "https://one.test https://two.test",
  ]) {
    const result = await f.request("/api/servers", {
      method: "OPTIONS",
      headers: { ...preflightHeaders, Origin },
    });
    assert.equal(result.status, 403, Origin);
    assert.equal(result.headers["access-control-allow-origin"], undefined);
  }
  for (const headers of [
    { "Access-Control-Request-Method": "TRACE" },
    { "Access-Control-Request-Method": "CONNECT" },
    { "Access-Control-Request-Headers": "authorization" },
    { "Access-Control-Request-Headers": "x-mc-panel-client,cookie" },
    {
      "Access-Control-Request-Headers": "x-mc-panel-client,x-remote-principal",
    },
    { "Access-Control-Request-Headers": "x-mc-panel-client,,authorization" },
    { "Access-Control-Request-Private-Network": "false" },
  ]) {
    const result = await f.request("/api/servers", {
      method: "OPTIONS",
      headers: { ...preflightHeaders, ...headers },
    });
    assert.equal(result.status, 403);
    assert.equal(result.headers["access-control-allow-origin"], undefined);
  }
  const staticRequest = await f.request("/index.html", {
    method: "OPTIONS",
    headers: preflightHeaders,
  });
  assert.equal(staticRequest.status, 403);
  assert.equal(staticRequest.headers["access-control-allow-origin"], undefined);
});

test("browser acceptance and login return bearer credentials while protected APIs and revocations retain authorization", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  assertCors(member.accepted);
  assert.equal(member.accepted.headers["set-cookie"], undefined);
  const signed = await f.request("/api/access/login", {
    method: "POST",
    headers: {
      ...browserHeaders,
      "Content-Type": "application/json",
      "Sec-Fetch-Site": "cross-site",
    },
    body: JSON.stringify({ email: member.account.email, password }),
  });
  assert.equal(signed.status, 200);
  assertCors(signed);
  const authorized = {
    ...browserHeaders,
    Authorization: `Bearer ${signed.body.sessionToken}`,
    "X-Server-Id": f.serverId,
  };
  const roster = await f.request("/api/servers", { headers: authorized });
  assert.equal(roster.status, 200);
  assert.equal(roster.body.servers[0].id, f.serverId);
  assertCors(roster);
  for (const headers of [
    browserHeaders,
    { ...browserHeaders, Cookie: `${SUBUSER_COOKIE}=${member.token}` },
  ]) {
    const result = await f.request("/api/servers", { headers });
    assert.equal(result.status, 401);
    assertCors(result);
  }
  const unauthenticatedWrite = await f.request("/api/files", {
    method: "POST",
    headers: { ...browserHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "unauthorized.txt", type: "file" }),
  });
  assert.equal(unauthenticatedWrite.status, 401);
  assertCors(unauthenticatedWrite);
  const unauthorizedWrite = await f.request("/api/files", {
    method: "POST",
    headers: { ...authorized, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "unauthorized.txt", type: "file" }),
  });
  assert.equal(unauthorizedWrite.status, 403);
  assertCors(unauthorizedWrite);
  for (const route of [
    "/api/panel-users",
    "/api/access/settings",
    "/api/desktop/settings",
  ]) {
    const result = await f.request(route, { headers: authorized });
    assert.equal(result.status, 403, route);
    assertCors(result);
  }
  await f.fleet.access.deleteAccount(member.account.id);
  const revoked = await f.request("/api/servers", { headers: authorized });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.accessRevoked, true);
  assertCors(revoked);
});

test("cross-site simple forms and unmarked requests cannot log in or mutate, while same-origin clients keep working", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll();
  const credentials = JSON.stringify({ email: member.account.email, password });
  for (const headers of [
    { Origin: workspace, "Content-Type": "application/json" },
    { Origin: workspace, "Content-Type": "application/x-www-form-urlencoded" },
    {
      Origin: workspace,
      "X-MC-Panel-Client": "other",
      "Content-Type": "application/json",
    },
    {
      ...browserHeaders,
      Origin: "http://malicious.example.test",
      "Content-Type": "application/json",
    },
  ]) {
    const result = await f.request("/api/access/login", {
      method: "POST",
      headers,
      body: credentials,
    });
    assert.equal(result.status, 403);
  }
  const wrongType = await f.request("/api/access/login", {
    method: "POST",
    headers: { ...browserHeaders, "Content-Type": "text/plain" },
    body: credentials,
  });
  assert.equal(wrongType.status, 415);
  assertCors(wrongType);
  const simpleLogout = await f.request("/api/access/logout", {
    method: "POST",
    headers: { Origin: workspace, Authorization: `Bearer ${member.token}` },
  });
  assert.equal(simpleLogout.status, 403);
  const stillSignedIn = await f.request("/api/access/session", {
    headers: { Origin: origin, Authorization: `Bearer ${member.token}` },
  });
  assert.equal(stillSignedIn.body.role, "subuser");
  assert.equal(stillSignedIn.headers["access-control-allow-origin"], undefined);
  const sameOriginLogin = await f.request("/api/access/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: credentials,
  });
  assert.equal(sameOriginLogin.status, 200);
  const unmarkedRead = await f.request("/api/access/session", {
    headers: { Origin: workspace },
  });
  assert.equal(unmarkedRead.headers["access-control-allow-origin"], undefined);
});

test("authenticated browser multipart uploads and streaming downloads keep their transfer headers", async (t) => {
  const f = await fixture(t);
  const member = await f.enroll(["file.create", "file.read-content"]);
  const headers = {
    ...browserHeaders,
    Authorization: `Bearer ${member.token}`,
    "X-Server-Id": f.serverId,
    "Sec-Fetch-Site": "cross-site",
  };
  const boundary = "mc-cors-fixture-boundary";
  const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="cors-upload.txt"\r\nContent-Type: text/plain\r\n\r\nBrowser upload bytes\r\n--${boundary}--\r\n`;
  const uploaded = await f.request("/api/files/upload", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: multipart,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assertCors(uploaded);
  const download = await f.request("/api/files/download?path=cors-upload.txt", {
    headers,
  });
  assert.equal(download.status, 200);
  assert.equal(download.body, "Browser upload bytes");
  assertCors(download);
  assert.match(
    download.headers["content-disposition"],
    /attachment.*cors-upload/,
  );
  for (const header of [
    "Content-Disposition",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
    "Retry-After",
  ])
    assert.ok(
      download.headers["access-control-expose-headers"].includes(header),
    );
});

test("private-network preflight stays confined to the validated remote gateway and never opens owner APIs", async (t) => {
  const f = await fixture(t);
  const headers = {
    ...preflightHeaders,
    "Access-Control-Request-Private-Network": "true",
  };
  const result = await f.request("/api/servers", {
    method: "OPTIONS",
    headers,
  });
  assert.equal(result.status, 204);
  assertCors(result);
  assert.equal(result.headers["access-control-allow-private-network"], "true");
  const owner = await f.local("/api/servers", { method: "OPTIONS", headers });
  assert.equal(owner.status, 404);
  assert.equal(owner.headers["access-control-allow-origin"], undefined);
  assert.equal(
    owner.headers["access-control-allow-private-network"],
    undefined,
  );
  const wrongHost = await f.request("/api/servers", {
    method: "OPTIONS",
    headers: { ...headers, Host: "attacker.example.test" },
  });
  assert.equal(wrongHost.status, 403);
  assert.equal(wrongHost.headers["access-control-allow-origin"], undefined);
  await f.fleet.access.configure({ transport: "direct" });
  const plaintext = await f.request("/api/servers", {
    method: "OPTIONS",
    headers,
  });
  assert.equal(plaintext.status, 400);
  assert.match(plaintext.body.error, /HTTPS/);
  assert.equal(plaintext.headers["access-control-allow-origin"], undefined);
});
