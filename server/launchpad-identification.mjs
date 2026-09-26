import { launchpadError } from "./launchpad-network.mjs";

// Waiting callers may leave independently. The shared, read-only lookup has
// its own short deadline, including when a fetch/body ignores cancellation.
function waitFor(operation, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => finish(reject, signal.reason);
    let settled = false;
    const finish = (complete, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", aborted);
      complete(value);
    };
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (cause) => finish(reject, cause),
    );
  });
}

// Identity depends on file content, not on the selected loader or game version.
// Keep successful batches when another batch fails, and stop queued work during
// a provider outage rather than spending a full timeout on every hundred JARs.
export function createInstalledIdentification(loadBatch) {
  const cache = new Map(),
    pending = new Map(),
    lanes = [Promise.resolve(), Promise.resolve()];
  let nextLane = 0,
    failureUntil = 0,
    failureWarning = "";
  return async (hashes, { signal } = {}) => {
    signal?.throwIfAborted();
    if (
      !Array.isArray(hashes) ||
      hashes.length > 5000 ||
      hashes.some(
        (hash) => typeof hash !== "string" || !/^[a-f0-9]{128}$/i.test(hash),
      )
    )
      throw launchpadError(
        400,
        "Identify at most 5000 valid SHA512 checksums.",
      );
    const keys = [...new Set(hashes.map((hash) => hash.toLowerCase()))];
    for (const [hash, entry] of cache)
      if (entry.expiresAt <= Date.now()) cache.delete(hash);
    const missing = keys.filter(
      (hash) => !cache.has(hash) && !pending.has(hash),
    );
    for (let offset = 0; offset < missing.length; offset += 100) {
      const batch = missing.slice(offset, offset + 100);
      const lane = nextLane++ % lanes.length;
      const task = lanes[lane].then(async () => {
        let matches = {},
          warning;
        if (failureUntil > Date.now()) warning = failureWarning;
        else {
          const deadline = AbortSignal.timeout(8000);
          try {
            matches = await waitFor(
              Promise.resolve().then(() => {
                deadline.throwIfAborted();
                return loadBatch(batch, deadline);
              }),
              deadline,
            );
            deadline.throwIfAborted();
            if (
              !matches ||
              typeof matches !== "object" ||
              Array.isArray(matches)
            )
              throw launchpadError(
                502,
                "Modrinth returned invalid file identification data.",
              );
          } catch (cause) {
            matches = {};
            warning =
              deadline.aborted || cause?.name === "TimeoutError"
                ? "Modrinth identification took too long. Try again shortly."
                : cause.message;
            failureWarning = warning;
            failureUntil = Math.max(
              failureUntil,
              Date.now() + (cause.status === 429 ? 60_000 : 30_000),
            );
          }
        }
        const entries = new Map();
        for (const hash of batch) {
          const value = Object.hasOwn(matches, hash)
            ? matches[hash]
            : undefined;
          const entry = {
            value,
            warning,
            expiresAt: warning
              ? failureUntil
              : Date.now() + (value ? 600_000 : 60_000),
          };
          cache.delete(hash);
          cache.set(hash, entry);
          entries.set(hash, entry);
        }
        while (cache.size > 5000) cache.delete(cache.keys().next().value);
        return entries;
      });
      lanes[lane] = task.catch(() => {});
      for (const hash of batch) {
        const lookup = task.then((entries) => entries.get(hash));
        pending.set(hash, lookup);
        void lookup.then(
          () => pending.delete(hash),
          () => pending.delete(hash),
        );
      }
    }
    const entries = await waitFor(
      Promise.all(keys.map((hash) => pending.get(hash) ?? cache.get(hash))),
      signal,
    );
    return {
      matches: Object.fromEntries(
        keys.flatMap((hash, index) =>
          entries[index]?.value ? [[hash, entries[index].value]] : [],
        ),
      ),
      warnings: [
        ...new Set(
          entries.flatMap((entry) => (entry?.warning ? [entry.warning] : [])),
        ),
      ],
    };
  };
}
