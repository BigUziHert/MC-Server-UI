import net from "node:net";
import dgram from "node:dgram";

export function serverPorts(properties, gamePort) {
  const enabled = (key) => String(properties.get(key)).toLowerCase() === "true";
  const port = (key, fallback) => {
    const value = Number(properties.get(key) ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw Object.assign(
        new Error(`Invalid ${key}; choose a port from 1 to 65535.`),
        { status: 400 },
      );
    return value;
  };
  return [
    {
      type: "tcp",
      port: gamePort ?? port("server-port", 25565),
      label: "game",
    },
    ...(enabled("enable-rcon")
      ? [{ type: "tcp", port: port("rcon.port", 25575), label: "RCON" }]
      : []),
    ...(enabled("enable-query")
      ? [{ type: "udp", port: port("query.port", 25565), label: "query" }]
      : []),
  ];
}

export async function probeServerPort({
  port,
  type = "tcp",
  host = "0.0.0.0",
}) {
  await new Promise((resolve, reject) => {
    const socket =
      type === "udp"
        ? dgram.createSocket(host.includes(":") ? "udp6" : "udp4")
        : net.createServer();
    const fail = (cause) => {
      try {
        socket.close();
      } catch {}
      reject(cause);
    };
    socket.once("error", fail);
    const ready = () =>
      socket.close((cause) => (cause ? reject(cause) : resolve()));
    if (type === "udp")
      socket.bind({ port, address: host, exclusive: true }, ready);
    else
      socket.listen(
        { port, host, exclusive: true, ipv6Only: host.includes(":") },
        ready,
      );
  }).catch((cause) => {
    if (cause.code === "EADDRINUSE")
      throw Object.assign(
        new Error(
          `Port ${port} (${type.toUpperCase()}) is already in use by another program or server. Stop that process or choose another port.`,
        ),
        { status: 409 },
      );
    throw cause;
  });
}

export async function preflightServerPorts(
  properties,
  gamePort,
  probe = probeServerPort,
) {
  const warnings = [];
  for (const binding of serverPorts(properties, gamePort)) {
    const hosts = properties.get("server-ip")
      ? [properties.get("server-ip")]
      : ["0.0.0.0", "::"];
    for (const host of hosts) {
      try {
        await probe({ ...binding, host });
      } catch (cause) {
        if (
          ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(cause.code) &&
          host === "::"
        )
          continue;
        if (binding.label === "game") throw cause;
        warnings.push(`${binding.label}: ${cause.message}`);
      }
    }
  }
  return warnings;
}
