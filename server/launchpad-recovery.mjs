import { launchpadError } from "./launchpad-network.mjs";

const sharedRecovery = new WeakMap();

const aborted = (signal) =>
  signal?.reason ??
  new DOMException("The operation was aborted.", "AbortError");

function bounded(work, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      complete(value);
    };
    const cancel = () => finish(reject, aborted(signal));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) return cancel();
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work(signal);
      })
      .then(
        (value) => finish(resolve, value),
        (cause) => finish(reject, cause),
      );
  });
}

function transient(cause) {
  if (cause?.upstreamStatus !== undefined)
    return [408, 425, 500, 502, 503, 504].includes(cause.upstreamStatus);
  return (
    [502, 503, 504].includes(cause?.status) ||
    ["AbortError", "TimeoutError", "TypeError"].includes(cause?.name)
  );
}

// Modrinth's firewall can reject public hash POSTs with an HTML 403 while
// equivalent GETs still work. This is not an API authentication failure. Keep
// JSON denials, authenticated requests and every other route out of recovery.
function blockedPublicHashBatch(url, options, cause) {
  if (
    cause?.upstreamStatus !== 403 ||
    !/^text\/html(?:\s*;|\s*$)/i.test(cause.upstreamContentType ?? "") ||
    options.method?.toUpperCase() !== "POST"
  )
    return false;
  const headers = new Headers(options.headers);
  if (headers.has("authorization") || headers.has("x-api-key")) return false;
  try {
    const address = new URL(url);
    return (
      address.origin === "https://api.modrinth.com" &&
      !address.username &&
      !address.password &&
      ["/v2/version_files", "/v2/version_files/update"].includes(
        address.pathname,
      )
    );
  } catch {
    return false;
  }
}

function operation(url) {
  try {
    const path = new URL(url).pathname;
    if (/\/version_file\//.test(path)) return "file-identity";
    if (/\/project\/[^/]+\/version$/.test(path)) return "project-history";
    if (/\/version\/[^/]+$/.test(path)) return "version";
    return path;
  } catch {
    return "metadata";
  }
}

// Modrinth's batch POST routes can fail while equivalent GET routes work.
// Share their circuit breaker, GET concurrency and request budget across file
// identification and update checks. No file downloads use this transport.
export function createModrinthRecovery(
  json,
  {
    bulkTimeoutMs = 4000,
    requestTimeoutMs = 8000,
    concurrency = 6,
    maxReads = 240,
    windowMs = 60000,
    now = Date.now,
    sharingKey,
  } = {},
) {
  if (sharingKey && sharedRecovery.has(sharingKey))
    return sharedRecovery.get(sharingKey);
  const cache = new Map(),
    pending = new Map(),
    bulkFailures = new Map(),
    readFailures = new Map(),
    queue = [],
    started = [];
  let active = 0,
    timer,
    rateLimitedUntil = 0;

  const rememberRateLimit = (cause) => {
    if (cause?.status === 429 || cause?.upstreamStatus === 429)
      rateLimitedUntil = Math.max(
        rateLimitedUntil,
        now() + Math.max(1000, cause.retryAfterMs ?? 60000),
      );
  };
  const rateLimitError = () =>
    Object.assign(
      launchpadError(
        429,
        "Modrinth's request limit was reached. Try again shortly.",
      ),
      { retryAfterMs: Math.max(1000, rateLimitedUntil - now()) },
    );
  const readBlock = (key) => {
    if (rateLimitedUntil > now()) return rateLimitError();
    const failure = readFailures.get(key);
    if (failure?.until > now())
      return Object.assign(new Error(failure.cause.message), {
        status: failure.cause.status,
        upstreamStatus: failure.cause.upstreamStatus,
      });
    return null;
  };

  function pump() {
    clearTimeout(timer);
    timer = undefined;
    while (started.length && started[0] <= now() - windowMs) started.shift();
    while (active < concurrency && queue.length) {
      const blocked = readBlock(queue[0].key);
      if (blocked) {
        const job = queue.shift();
        job.signal.removeEventListener("abort", job.cancel);
        job.reject(blocked);
        continue;
      }
      const waitUntil = started.length >= maxReads ? started[0] + windowMs : 0;
      if (waitUntil > now()) {
        timer = setTimeout(pump, Math.max(1, waitUntil - now()));
        return;
      }
      const job = queue.shift();
      job.signal.removeEventListener("abort", job.cancel);
      if (job.signal.aborted) {
        job.reject(aborted(job.signal));
        continue;
      }
      active++;
      started.push(now());
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  function enqueue(run, signal, key) {
    return new Promise((resolve, reject) => {
      const job = { run, signal, key, resolve, reject };
      job.cancel = () => {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        reject(aborted(signal));
        pump();
      };
      if (signal.aborted) return reject(aborted(signal));
      signal.addEventListener("abort", job.cancel, { once: true });
      queue.push(job);
      queueMicrotask(pump);
    });
  }

  function subscribe(entry, signal) {
    entry.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (complete, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        entry.waiters--;
        if (!entry.waiters && !entry.done) entry.controller.abort();
        complete(value);
      };
      const cancel = () => finish(reject, aborted(signal));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      entry.work.then(
        (value) => finish(resolve, value),
        (cause) => finish(reject, cause),
      );
    });
  }

  const recovery = {
    async bulk(url, { timeoutMs = bulkTimeoutMs, ...options } = {}) {
      options.signal?.throwIfAborted();
      if (rateLimitedUntil > now()) throw rateLimitError();
      const failure = bulkFailures.get(url);
      if (
        failure?.until > now() &&
        (transient(failure.cause) ||
          blockedPublicHashBatch(url, options, failure.cause))
      )
        throw Object.assign(new Error(failure.cause.message), {
          useFallback: true,
        });
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, deadline])
        : deadline;
      try {
        return await bounded(() => json(url, { ...options, signal }), signal);
      } catch (cause) {
        if (options.signal?.aborted) throw aborted(options.signal);
        rememberRateLimit(cause);
        if (!transient(cause) && !blockedPublicHashBatch(url, options, cause))
          throw cause;
        bulkFailures.set(url, { cause, until: now() + 60000 });
        throw Object.assign(new Error(cause.message), {
          useFallback: true,
          cause,
        });
      }
    },

    read(url, { signal, ttlMs = 600000 } = {}) {
      if (signal?.aborted) return Promise.reject(aborted(signal));
      const saved = cache.get(url);
      if (ttlMs > 0 && saved?.until > now())
        return Promise.resolve(saved.value);
      cache.delete(url);
      let entry = pending.get(url);
      if (entry?.controller.signal.aborted) entry = undefined;
      if (!entry) {
        const key = operation(url);
        const blocked = readBlock(key);
        if (blocked) return Promise.reject(blocked);
        const controller = new AbortController();
        entry = { controller, waiters: 0, done: false };
        const owned = entry;
        entry.work = enqueue(
          async () => {
            const deadline = AbortSignal.timeout(requestTimeoutMs);
            const requestSignal = AbortSignal.any([
              controller.signal,
              deadline,
            ]);
            try {
              const value = await bounded(
                () => json(url, { signal: requestSignal }),
                requestSignal,
              );
              readFailures.delete(key);
              if (ttlMs > 0) {
                cache.set(url, { value, until: now() + ttlMs });
                while (cache.size > 1000)
                  cache.delete(cache.keys().next().value);
              }
              return value;
            } catch (cause) {
              rememberRateLimit(cause);
              // A slow query is not evidence that every other metadata route is
              // down. In particular, a bulk-version timeout must not prevent the
              // independent project-history fallback from being attempted.
              if (
                !controller.signal.aborted &&
                !["TimeoutError", "AbortError"].includes(cause?.name) &&
                transient(cause)
              ) {
                const count = (readFailures.get(key)?.count ?? 0) + 1;
                readFailures.set(key, {
                  count,
                  cause,
                  until: count >= 3 ? now() + 30000 : 0,
                });
              } else if (cause?.status === 404) readFailures.delete(key);
              throw cause;
            }
          },
          controller.signal,
          key,
        ).finally(() => {
          owned.done = true;
          if (pending.get(url) === owned) pending.delete(url);
        });
        pending.set(url, entry);
      }
      return subscribe(entry, signal);
    },
  };
  if (sharingKey) sharedRecovery.set(sharingKey, recovery);
  return recovery;
}
