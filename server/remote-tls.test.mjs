import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { createRemoteTls } from "./remote-tls.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mc-remote-tls-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("mc-remote-tls-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, localAddresses: () => ["192.168.10.20", "fd00::20"] };
}

test("remote TLS certificates match the public IP, loopback, and local network addresses", async (t) => {
  const { root, localAddresses } = await fixture(t);
  const service = createRemoteTls({ dataDir: root, localAddresses });
  const result = await service.ensure("https://203.0.113.12:3002");
  const cert = new X509Certificate(result.cert);
  for (const host of [
    "203.0.113.12",
    "127.0.0.1",
    "::1",
    "192.168.10.20",
    "fd00::20",
  ])
    assert.equal(
      cert.checkIP(host),
      host,
      `${host} is covered by the certificate`,
    );
  assert.equal(cert.checkHost("localhost"), "localhost");
  assert.equal(cert.checkIP("203.0.113.13"), undefined);
  assert.equal(cert.checkPrivateKey(createPrivateKey(result.key)), true);
  assert.equal(cert.verify(cert.publicKey), true);
  assert.equal(result.certificate.fingerprint256, cert.fingerprint256);
  assert.equal(
    result.certificate.validTo,
    new Date(cert.validTo).toISOString(),
  );
  assert.deepEqual(
    result.certificate.hosts,
    [
      "203.0.113.12",
      "127.0.0.1",
      "::1",
      "192.168.10.20",
      "fd00::20",
      "localhost",
    ].sort(),
  );
  assert.equal(
    JSON.stringify(result.certificate).includes("PRIVATE KEY"),
    false,
  );
});

test("remote TLS persists a certificate and reuses it across process restarts and port changes", async (t) => {
  const { root, localAddresses } = await fixture(t);
  const first = await createRemoteTls({ dataDir: root, localAddresses }).ensure(
    "https://203.0.113.12:3002",
  );
  const saved = JSON.parse(
    await fs.readFile(path.join(root, "remote-tls.json"), "utf8"),
  );
  assert.equal(saved.key, first.key);
  assert.equal(saved.cert, first.cert);
  const restarted = await createRemoteTls({
    dataDir: root,
    localAddresses,
  }).ensure("https://203.0.113.12:3003");
  assert.equal(restarted.key, first.key);
  assert.equal(restarted.cert, first.cert);
  assert.deepEqual((await fs.readdir(root)).sort(), ["remote-tls.json"]);
});

test("a changed public host or new LAN address renews the remote certificate", async (t) => {
  const { root } = await fixture(t);
  let local = ["192.168.10.20"];
  const service = createRemoteTls({
    dataDir: root,
    localAddresses: () => local,
  });
  const first = await service.ensure("https://203.0.113.12:3002");
  const next = await service.ensure("https://203.0.113.13:3002");
  assert.notEqual(
    next.certificate.fingerprint256,
    first.certificate.fingerprint256,
  );
  assert.equal(
    new X509Certificate(next.cert).checkIP("203.0.113.13"),
    "203.0.113.13",
  );
  local = ["192.168.10.21"];
  const lanChanged = await service.ensure("https://203.0.113.13:3002");
  assert.notEqual(
    lanChanged.certificate.fingerprint256,
    next.certificate.fingerprint256,
  );
  assert.equal(
    new X509Certificate(lanChanged.cert).checkIP("192.168.10.21"),
    "192.168.10.21",
  );
});

test("certificates near expiration renew before their validity ends", async (t) => {
  const { root, localAddresses } = await fixture(t);
  let now = Date.now();
  const service = createRemoteTls({
    dataDir: root,
    localAddresses,
    now: () => now,
  });
  const first = await service.ensure("https://203.0.113.12:3002");
  now += 340 * 86400_000;
  const renewed = await service.ensure("https://203.0.113.12:3002");
  assert.notEqual(
    renewed.certificate.fingerprint256,
    first.certificate.fingerprint256,
  );
  assert.ok(
    Date.parse(renewed.certificate.validTo) >
      Date.parse(first.certificate.validTo),
  );
});

test("corrupt saved TLS data is rejected without silently replacing the trusted certificate", async (t) => {
  const { root, localAddresses } = await fixture(t);
  const file = path.join(root, "remote-tls.json");
  for (const invalid of [
    "not json",
    JSON.stringify({ key: "broken", cert: "broken" }),
  ]) {
    await fs.writeFile(file, invalid);
    await assert.rejects(
      createRemoteTls({ dataDir: root, localAddresses }).ensure(
        "https://203.0.113.12:3002",
      ),
      /saved remote HTTPS certificate could not be read/,
    );
    assert.equal(await fs.readFile(file, "utf8"), invalid);
  }
});

test("mismatched saved key and certificate fail safely", async (t) => {
  const { root, localAddresses } = await fixture(t);
  const service = createRemoteTls({ dataDir: root, localAddresses });
  const first = await service.ensure("https://203.0.113.12:3002");
  const second = await service.ensure("https://203.0.113.13:3002");
  const invalid = JSON.stringify({
    version: 1,
    key: first.key,
    cert: second.cert,
    hosts: second.certificate.hosts,
  });
  await fs.writeFile(path.join(root, "remote-tls.json"), invalid);
  await assert.rejects(
    createRemoteTls({ dataDir: root, localAddresses }).ensure(
      "https://203.0.113.13:3002",
    ),
    /saved remote HTTPS certificate could not be read/,
  );
  assert.equal(
    await fs.readFile(path.join(root, "remote-tls.json"), "utf8"),
    invalid,
  );
});

test("remote TLS also covers bracketed IPv6 public addresses", async (t) => {
  const { root, localAddresses } = await fixture(t);
  const result = await createRemoteTls({
    dataDir: root,
    localAddresses,
  }).ensure("https://[2001:db8::12]:3002");
  assert.equal(
    new X509Certificate(result.cert).checkIP("2001:db8::12"),
    "2001:db8::12",
  );
});
