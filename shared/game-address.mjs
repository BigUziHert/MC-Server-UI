// Format the player connection address only; the server's bind port is unchanged.
export function formatGameAddress(address) {
  const match = /^(\[[^\]]+\]|[^:[\]\s]+):25565$/.exec(address);
  if (!match) return address;
  const host = match[1];
  if (host.startsWith("[")) {
    try {
      // URL validates bracketed IPv6 without mistaking its final segment for a
      // port. Keep the original spelling and brackets for the copied address.
      new URL(`http://${host}`);
      return host;
    } catch {
      return address;
    }
  }
  if (
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i.test(
      host,
    )
  )
    return address;
  if (
    /^\d+(?:\.\d+){3}$/.test(host) &&
    host.split(".").some((part) => Number(part) > 255)
  )
    return address;
  return host;
}
