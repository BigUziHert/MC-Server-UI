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
export function createInstalledIdentification(loadBatch, { loadOne } = {}) {
  const cache = new Map(),
    pending = new Map(),
    lanes = [Promise.resolve(), Promise.resolve()];
  let nextLane = 0,
    failureUntil = 0,
    failureWarning = "";
  const remember = (hash, entry) => {
    cache.delete(hash);
    cache.set(hash, entry);
    while (cache.size > 5000) cache.delete(cache.keys().next().value);
    return entry;
  };
  const recover = async (batch, signal) =>
    new Map(
      await Promise.all(
        batch.map(async (hash) => {
          let value, warning;
          try {
            // The shared reader bounds concurrency, request rate and each GET.
            // Use the batch lifetime, never the expired bulk deadline or one
            // caller's signal. Queued work shares this same bounded lifetime.
            signal.throwIfAborted();
            value = await waitFor(loadOne(hash, signal), signal);
            if (
              !value ||
              typeof value !== "object" ||
              ![Object.prototype, null].includes(
                Object.getPrototypeOf(value),
              ) ||
              !/^[A-Za-z0-9_-]{1,100}$/.test(value.id ?? "") ||
              typeof value.id !== "string" ||
              !/^[A-Za-z0-9_-]{1,100}$/.test(value.project_id ?? "") ||
              typeof value.project_id !== "string" ||
              !Array.isArray(value.files) ||
              !value.files.some(
                (file) =>
                  typeof file?.hashes?.sha512 === "string" &&
                  file.hashes.sha512.toLowerCase() === hash,
              )
            )
              throw launchpadError(
                502,
                "Modrinth returned an unverified file identification. Try again shortly.",
              );
          } catch (cause) {
            value = undefined;
            // Only a genuine not-found result means this checksum is unknown.
            if (cause?.status !== 404)
              warning =
                cause?.name === "TimeoutError"
                  ? "Modrinth identification took too long. Try again shortly."
                  : cause?.message ||
                    "Modrinth identification could not finish. Try again shortly.";
          }
          return [
            hash,
            remember(hash, {
              value,
              warning,
              expiresAt:
                Date.now() + (warning ? 30_000 : value ? 600_000 : 60_000),
            }),
          ];
        }),
      ),
    );
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
      const recoveryDeadline = loadOne ? AbortSignal.timeout(90_000) : null;
      const task = lanes[lane].then(async () => {
        if (recoveryDeadline?.aborted) return recover(batch, recoveryDeadline);
        let matches = {},
          warning;
        if (failureUntil > Date.now()) warning = failureWarning;
        else {
          const deadline = recoveryDeadline
            ? AbortSignal.any([AbortSignal.timeout(8000), recoveryDeadline])
            : AbortSignal.timeout(8000);
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
            if (cause?.useFallback && loadOne)
              return recover(batch, recoveryDeadline);
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
          entries.set(hash, remember(hash, entry));
        }
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
