import { isIP } from "node:net";

export function validateConnectionHost(value = "") {
  if (typeof value !== "string" || value.length > 253)
    throw new Error("Enter an IP address or hostname without a port.");
  const host = value.trim().replace(/^\[([^\]]+)\]$/, "$1");
  if (!host || isIP(host)) return host;
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i.test(
      host,
    )
  )
    throw new Error(
      "Enter an IP address or hostname without a protocol, path, or port.",
    );
  return host;
}

export const connectionAddress = (host, port) =>
  `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;

export function legacyConnectionHost(address) {
  if (!address) return "";
  try {
    const host = validateConnectionHost(
      new URL(`minecraft://${address}`).hostname,
    );
    if (
      isPublicIPv4(host) ||
      (!isIP(host) && host !== "localhost" && host.includes("."))
    )
      return host;
    if (isIP(host) === 6 && !/^(::|f[cd]|fe[89ab])/i.test(host)) return host;
  } catch {
    /* Unspecified or local bind addresses use public detection. */
  }
  return "";
}

export function isPublicIPv4(host) {
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

// This detects this host's outward-facing IPv4 only. It does not probe the
// Minecraft port, alter router settings, or change server.properties server-ip.
export function createPublicAddressResolver({
  fetchAddress = fetch,
  now = Date.now,
} = {}) {
  let cached;
  let pending;
  return {
    async resolve() {
      if (cached && now() < cached.expires) return cached.host;
      if (pending) return pending;
      pending = (async () => {
        let host = null;
        try {
          const response = await fetchAddress(
            "https://api.ipify.org?format=json",
            {
              signal: AbortSignal.timeout(3500),
              redirect: "error",
            },
          );
          if (!response.ok) throw new Error("Public IP lookup failed.");
          const reader = response.body.getReader();
          let data = "";
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              data += new TextDecoder().decode(value);
              if (data.length > 1024)
                throw new Error("Invalid public IP response.");
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
          const result = JSON.parse(data);
          if (isPublicIPv4(result.ip)) host = result.ip;
        } catch {
          /* Keep a usable local address if the lookup is unavailable. */
        }
        cached = { host, expires: now() + (host ? 600000 : 30000) };
        return host;
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}

export async function advertisedConnection(configuration, resolver) {
  if (configuration.connectionHost)
    return {
      address: connectionAddress(
        configuration.connectionHost,
        configuration.port,
      ),
      addressSource: "custom",
      addressNote: "Custom player connection address",
    };
  if (configuration.mode === "demo")
    return {
      address: configuration.address,
      addressSource: "local",
      addressNote: "Demo connection address",
    };
  const publicHost = await resolver.resolve();
  return publicHost
    ? {
        address: connectionAddress(publicHost, configuration.port),
        addressSource: "public",
        addressNote:
          "Public IP detected. Port forwarding and firewall access have not been checked.",
      }
    : {
        address: connectionAddress("localhost", configuration.port),
        addressSource: "local",
        addressNote:
          "Public IP lookup is unavailable. This address works on the server PC; set a custom address in Settings if needed.",
      };
}
