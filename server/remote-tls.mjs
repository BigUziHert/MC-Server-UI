import fs from "node:fs/promises";
import path from "node:path";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { createPrivateKey, X509Certificate, randomUUID } from "node:crypto";
import selfsigned from "selfsigned";

export function localNetworkAddresses() {
  return [
    ...new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter(
          (item) =>
            item &&
            !item.internal &&
            isIP(item.address) &&
            !item.address.includes("%") &&
            !item.address.toLowerCase().startsWith("fe80:"),
        )
        .map((item) => item.address),
    ),
  ].sort();
}

export const addressHost = (address) =>
  isIP(address) === 6 ? `[${address}]` : address;

// The certificate and private key are kept together so a crash cannot leave a
// mismatched pair. The private key never enters the owner settings response.
export function createRemoteTls({
  dataDir,
  localAddresses = localNetworkAddresses,
  now = () => Date.now(),
}) {
  const file = path.join(dataDir, "remote-tls.json");
  let current;
  let loaded = false;
  const inspect = (value) => {
    const cert = new X509Certificate(value.cert);
    if (
      !cert.checkPrivateKey(createPrivateKey(value.key)) ||
      !cert.verify(cert.publicKey)
    )
      throw new Error("The saved remote HTTPS certificate is invalid.");
    return cert;
  };
  return {
    async ensure(publicUrl) {
      if (!loaded) {
        try {
          current = JSON.parse(await fs.readFile(file, "utf8"));
          inspect(current);
        } catch (cause) {
          if (cause.code !== "ENOENT")
            throw new Error(
              "The saved remote HTTPS certificate could not be read. Restore remote-tls.json from a backup or remove that file to generate a new certificate.",
            );
        }
        loaded = true;
      }
      const publicHost = new URL(publicUrl).hostname.replace(/^\[|\]$/g, "");
      const hosts = [
        ...new Set([
          publicHost,
          "localhost",
          "127.0.0.1",
          "::1",
          ...localAddresses().filter((host) => isIP(host)),
        ]),
      ].sort();
      const cert = current ? inspect(current) : null;
      if (
        !cert ||
        Date.parse(cert.validTo) < now() + 30 * 86400_000 ||
        hosts.some(
          (host) => !(isIP(host) ? cert.checkIP(host) : cert.checkHost(host)),
        )
      ) {
        const generated = await selfsigned.generate(
          [{ name: "commonName", value: "MC Panel remote access" }],
          {
            keySize: 2048,
            algorithm: "sha256",
            notBeforeDate: new Date(now() - 300_000),
            notAfterDate: new Date(now() + 365 * 86400_000),
            extensions: [
              { name: "basicConstraints", cA: false, critical: true },
              {
                name: "keyUsage",
                digitalSignature: true,
                keyEncipherment: true,
                critical: true,
              },
              { name: "extKeyUsage", serverAuth: true },
              {
                name: "subjectAltName",
                altNames: hosts.map((host) =>
                  isIP(host) ? { type: 7, ip: host } : { type: 2, value: host },
                ),
              },
            ],
          },
        );
        const next = {
          version: 1,
          key: generated.private,
          cert: generated.cert,
          hosts,
        };
        inspect(next);
        await fs.mkdir(dataDir, { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify(next), {
            mode: 0o600,
            flag: "wx",
          });
          await fs.rename(temporary, file);
        } finally {
          await fs.rm(temporary, { force: true });
        }
        current = next;
      }
      const active = inspect(current);
      return {
        key: current.key,
        cert: current.cert,
        certificate: {
          fingerprint256: active.fingerprint256,
          validTo: new Date(active.validTo).toISOString(),
          hosts: current.hosts,
        },
      };
    },
  };
}
