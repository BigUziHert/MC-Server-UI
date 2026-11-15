import { createHash } from "node:crypto";

export function offlinePlayerUuid(name) {
  const bytes = createHash("md5")
    .update(`OfflinePlayer:${name}`, "utf8")
    .digest();
  bytes[6] = (bytes[6] & 15) | 48;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function lookupPlayerProfile(name, request = fetch) {
  const fail = (message) => Object.assign(new Error(message), { status: 409 });
  let response;
  try {
    response = await request(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(5000), redirect: "error" },
    );
  } catch {
    throw fail(
      "Minecraft profile lookup is unavailable. Try again when the profile service is reachable, or let this player join once to cache their profile.",
    );
  }
  if ([204, 404].includes(response.status))
    throw fail(
      "No Minecraft Java profile was found for this username. Check the spelling.",
    );
  if (!response.ok)
    throw fail(
      "Minecraft profile lookup is temporarily unavailable. Try again shortly.",
    );
  const text = await response.text();
  if (text.length > 16384)
    throw fail("Minecraft returned an invalid player profile.");
  let profile;
  try {
    profile = JSON.parse(text);
  } catch {
    throw fail("Minecraft returned an invalid player profile.");
  }
  if (
    !/^[a-f0-9]{32}$/i.test(profile.id ?? "") ||
    typeof profile.name !== "string" ||
    profile.name.toLowerCase() !== name.toLowerCase()
  )
    throw fail(
      "Minecraft returned a different player profile. Check the username and try again.",
    );
  const id = profile.id.toLowerCase();
  return {
    name: profile.name,
    uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
  };
}
