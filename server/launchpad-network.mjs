import fs from "node:fs/promises";
import { createHash } from "node:crypto";

export const launchpadError = (status, message) =>
  Object.assign(new Error(message), { status });
const apiHosts = new Set([
  "api.modrinth.com",
  "api.curseforge.com",
  "api.feed-the-beast.com",
  "api.atlauncher.com",
  "api.spiget.org",
  "voidswrath.com",
  "www.voidswrath.com",
]);
export const USER_AGENT =
  "MC-Panel/0.1.3 (https://github.com/BigUziHert/MC-Server-UI)";
export function checkedProviderUrl(value, hosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw launchpadError(
      400,
      "The provider returned an invalid download address.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.includes(url.hostname.toLowerCase())
  )
    throw launchpadError(
      400,
      "This file is hosted outside the provider's supported download servers. Download it manually from the project's website.",
    );
  return url.href;
}
async function responseFor(
  url,
  { fetch: request = fetch, headers = {}, ...options } = {},
  hosts,
) {
  let address = checkedProviderUrl(url, hosts);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await request(address, {
      ...options,
      redirect: "manual",
      signal: options.signal ?? AbortSignal.timeout(60000),
      headers: { "User-Agent": USER_AGENT, ...headers },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const redirected = checkedProviderUrl(
        new URL(response.headers.get("location") || "", address).href,
        hosts,
      );
      if (
        Object.keys(headers).some((name) =>
          /^(?:x-api-key|authorization)$/i.test(name),
        ) &&
        new URL(redirected).origin !== new URL(address).origin
      )
        throw launchpadError(
          502,
          "The provider redirected an authenticated request to a different service.",
        );
      address = redirected;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw launchpadError(
        response.status === 404 ? 404 : response.status === 429 ? 429 : 502,
        response.status === 429
          ? "The provider's request limit was reached. Wait a little and try again."
          : response.status === 401 || response.status === 403
            ? "The provider denied access. Check its API key or download restrictions."
            : `The provider request failed (${response.status}). Try again shortly.`,
      );
    }
    return response;
  }
  throw launchpadError(
    502,
    "The provider redirected this request too many times.",
  );
}
export async function providerJson(url, options = {}) {
  const response = await responseFor(url, options, [...apiHosts]);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 12 * 1024 ** 2)
      throw launchpadError(502, "The provider returned too much catalog data.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw launchpadError(502, "The provider returned invalid catalog data.");
  }
}
export function strongestHash(hashes = {}) {
  for (const [algorithm, length] of [
    ["sha512", 128],
    ["sha256", 64],
    ["sha1", 40],
  ])
    if (
      typeof hashes[algorithm] === "string" &&
      new RegExp(`^[a-f0-9]{${length}}$`, "i").test(hashes[algorithm])
    )
      return [algorithm, hashes[algorithm].toLowerCase()];
  throw launchpadError(
    400,
    "The provider does not supply a supported file checksum. Install this file manually.",
  );
}
export async function downloadVerified(
  file,
  target,
  hosts,
  request = fetch,
  { signal } = {},
) {
  const [algorithm, expected] = strongestHash(file.hashes);
  const limit = file.archive === true ? 2 * 1024 ** 3 : 512 * 1024 ** 2;
  const limitDescription =
    file.archive === true ? "2 GB archive" : "512 MB per-file";
  if (
    file.size != null &&
    (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > limit)
  )
    throw launchpadError(
      400,
      `This download exceeds the ${limitDescription} limit.`,
    );
  const timeout = AbortSignal.timeout(file.archive === true ? 300000 : 60000);
  const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  downloadSignal.throwIfAborted();
  const response = await responseFor(
    file.url,
    { fetch: request, signal: downloadSignal },
    hosts,
  );
  const handle = await fs.open(target, "wx");
  const hash = createHash(algorithm);
  let size = 0;
  try {
    for await (const chunk of response.body) {
      downloadSignal.throwIfAborted();
      size += chunk.length;
      if (size > limit)
        throw launchpadError(
          400,
          `This download exceeds the ${limitDescription} limit.`,
        );
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    if (
      (file.size != null && size !== file.size) ||
      hash.digest("hex") !== expected
    )
      throw launchpadError(
        502,
        "Downloaded file failed its size or checksum check. No server files were changed.",
      );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return size;
}
