// Short-lived, memory-only catalog pages. Concurrent readers share one request;
// cancelling one reader must not cancel another reader's result.
export function createLaunchpadCatalogCache({
  now = Date.now,
  ttlMs = 30_000,
  maxEntries = 128,
  maxBytes = 4 * 1024 ** 2,
} = {}) {
  const pages = new Map(),
    flights = new Map();
  let bytes = 0;
  const forget = (key) => {
    const page = pages.get(key);
    if (page) bytes -= page.bytes;
    pages.delete(key);
  };
  return {
    read(key, load, { signal, refresh = false } = {}) {
      signal?.throwIfAborted();
      const page = pages.get(key);
      if (!refresh && page?.until > now()) {
        pages.delete(key);
        pages.set(key, page);
        return Promise.resolve(structuredClone(page.value));
      }
      forget(key);
      let entry = flights.get(key);
      if (!entry || entry.controller.signal.aborted) {
        const controller = new AbortController();
        entry = { controller, readers: 0, pending: true };
        flights.set(key, entry);
        entry.task = Promise.resolve()
          .then(async () => {
            controller.signal.throwIfAborted();
            const value = await load(controller.signal);
            controller.signal.throwIfAborted();
            if (flights.get(key) === entry) {
              const size = Buffer.byteLength(JSON.stringify(value));
              if (size <= maxBytes) {
                forget(key);
                pages.set(key, {
                  value: structuredClone(value),
                  until: now() + ttlMs,
                  bytes: size,
                });
                bytes += size;
                while (pages.size > maxEntries || bytes > maxBytes)
                  forget(pages.keys().next().value);
              }
            }
            return value;
          })
          .finally(() => {
            entry.pending = false;
            if (flights.get(key) === entry) flights.delete(key);
          });
      }
      entry.readers++;
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (callback, value) => {
          if (done) return;
          done = true;
          signal?.removeEventListener("abort", abort);
          entry.readers--;
          if (!entry.readers && entry.pending)
            entry.controller.abort(
              new DOMException("Catalog request cancelled.", "AbortError"),
            );
          callback(value);
        };
        const abort = () => finish(reject, signal.reason);
        signal?.addEventListener("abort", abort, { once: true });
        entry.task.then(
          (value) => finish(resolve, structuredClone(value)),
          (cause) => finish(reject, cause),
        );
        if (signal?.aborted) abort();
      });
    },
    clear() {
      pages.clear();
      bytes = 0;
      // Detach in-flight reads so old settings can never refill the cache.
      flights.clear();
    },
  };
}
