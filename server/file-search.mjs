import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const failure = (status, message) =>
  Object.assign(new Error(message), { status });
const identity = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const missing = (cause) => ["ENOENT", "ENOTDIR"].includes(cause.code);

// Bound metadata IO instead of serializing every stat or flooding the disk with
// one promise per entry in a large folder.
async function mapMetadata(items, read, concurrency = 16) {
  const result = new Array(items.length);
  let next = 0;
  let failure;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failure && next < items.length) {
        const index = next++;
        try {
          result[index] = await read(items[index]);
        } catch (cause) {
          failure ??= cause;
        }
      }
    }),
  );
  if (failure) throw failure;
  return result.filter(Boolean);
}

async function entryMetadata(io, target, relative, item, signal) {
  signal?.throwIfAborted();
  const stat = await io.lstat(path.join(target, item.name)).catch((cause) => {
    if (missing(cause)) return null;
    throw cause;
  });
  signal?.throwIfAborted();
  if (!stat || stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile()))
    return null;
  return {
    name: item.name,
    path: [relative, item.name].filter(Boolean).join("/"),
    type: stat.isDirectory() ? "directory" : "file",
    size: stat.isDirectory() ? 0 : stat.size,
    modified: stat.mtime.toISOString(),
  };
}

export async function listServerFiles({
  root,
  relative = "",
  safePath,
  signal,
  fileSystem: io = fs,
}) {
  signal?.throwIfAborted();
  const target = await safePath(root, relative);
  const original = await io.lstat(target);
  if (!original.isDirectory() || original.isSymbolicLink())
    throw failure(400, "Choose an ordinary server folder to browse.");
  const items = await io.readdir(target, { withFileTypes: true });
  const entries = await mapMetadata(
    items.filter((item) => !item.isSymbolicLink()),
    (item) => entryMetadata(io, target, relative, item, signal),
  );
  // Metadata is published only after rechecking the parent and its ancestors.
  // This also catches a folder moved/replaced while its entries were read.
  const checked = await safePath(root, relative);
  if (!identity(original, await io.lstat(checked)))
    throw failure(409, "A folder changed while loading. Refresh to try again.");
  signal?.throwIfAborted();
  entries.sort((a, b) =>
    a.type === b.type
      ? a.name.localeCompare(b.name)
      : a.type === "directory"
        ? -1
        : 1,
  );
  return { path: relative, entries };
}

// Keep one directory handle open per scan. Pages bound work per request, while
// the cursor retains traversal position rather than a truncated result set.
async function createScan(root, relative, needle, options) {
  const {
    safePath,
    fileSystem: io,
    pageSize,
    scanSize,
    pageDurationMs,
    batchSize,
  } = options;
  const rootStat = await io.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw failure(400, "Choose an ordinary server folder to search.");
  const checkRoot = async (signal) => {
    signal?.throwIfAborted();
    const current = await io.lstat(root);
    if (current.isSymbolicLink() || !identity(rootStat, current))
      throw failure(
        409,
        "The server folder changed during search. Start the search again.",
      );
  };
  const checkedPath = async (value, signal) => {
    await checkRoot(signal);
    const target = await safePath(root, value);
    await checkRoot(signal);
    return target;
  };
  const initial = await checkedPath(relative);
  if (!(await io.lstat(initial)).isDirectory())
    throw failure(400, "Choose a folder to search.");
  const directories = [relative.split("/").filter(Boolean).join("/")];
  let handle,
    directory,
    directoryStat,
    closed = false;
  const closeHandle = async () => {
    const previous = handle;
    handle = undefined;
    await previous?.close();
  };
  return {
    async readPage(signal) {
      if (closed)
        throw failure(409, "This search ended. Start the search again.");
      const entries = [];
      const started = performance.now();
      let scanned = 0;
      while (handle || directories.length) {
        signal?.throwIfAborted();
        if (
          scanned &&
          (entries.length >= pageSize ||
            scanned >= scanSize ||
            performance.now() - started >= pageDurationMs)
        )
          break;
        if (!handle) {
          // Missing/replaced queued folders still count toward the page budget.
          scanned++;
          directory = directories.pop();
          try {
            const target = await checkedPath(directory, signal);
            directoryStat = await io.lstat(target);
            handle = await io.opendir(target, { bufferSize: 256 });
          } catch (cause) {
            if (missing(cause) || cause.status === 400) continue;
            throw cause;
          }
        }
        // Validate the directory around a bounded batch, including retained
        // handles from previous pages. Never publish metadata from a detached
        // or replaced directory. Walking ancestors for every nonmatching file
        // made sparse searches cost many filesystem round trips per entry.
        const target = await checkedPath(directory, signal);
        if (!identity(directoryStat, await io.lstat(target)))
          throw failure(
            409,
            "A folder changed during search. Start the search again.",
          );
        const candidates = [];
        const children = [];
        for (let batch = 0; batch < batchSize; batch++) {
          signal?.throwIfAborted();
          const item = await handle.read();
          signal?.throwIfAborted();
          scanned++;
          if (!item) {
            await closeHandle();
            break;
          }
          if (!item.isSymbolicLink()) {
            if (item.isDirectory())
              children.push([directory, item.name].filter(Boolean).join("/"));
            if (
              (item.isFile() || item.isDirectory()) &&
              item.name.toLowerCase().includes(needle)
            )
              candidates.push(item);
          }
          if (
            entries.length + candidates.length >= pageSize ||
            scanned >= scanSize ||
            performance.now() - started >= pageDurationMs
          )
            break;
        }
        const matches = await mapMetadata(candidates, (item) =>
          entryMetadata(io, target, directory, item, signal),
        );
        const checked = await checkedPath(directory, signal);
        if (!identity(directoryStat, await io.lstat(checked)))
          throw failure(
            409,
            "A folder changed during search. Start the search again.",
          );
        entries.push(...matches);
        directories.push(...children);
      }
      await checkRoot(signal);
      return { entries, done: !handle && !directories.length };
    },
    async close() {
      closed = true;
      directories.length = 0;
      await closeHandle();
    },
  };
}

export function createFileSearch({
  root,
  safePath,
  fileSystem = fs,
  pageSize = 200,
  scanSize = 4000,
  pageDurationMs = 100,
  batchSize = 128,
  cursorTtlMs = 60_000,
  maximumActive = 8,
}) {
  const searches = new Map();
  let closed = false;
  const dispose = async (cursor, state) => {
    searches.delete(cursor);
    clearTimeout(state.timer);
    state.abort.abort();
    await state.pending?.catch(() => {});
    await state.scan?.close();
  };
  return {
    async search({ path: relative = "", search, cursor, signal }) {
      if (closed) throw failure(503, "The panel is shutting down.");
      if (
        typeof search !== "string" ||
        search.length > 256 ||
        search.includes("\0") ||
        !search.trim()
      )
        throw failure(400, "Enter a filename search of 1–256 characters.");
      if (typeof relative !== "string")
        throw failure(400, "Choose a folder inside the server directory.");
      const query = search.trim();
      let state;
      if (cursor !== undefined) {
        if (typeof cursor !== "string" || !searches.has(cursor))
          throw failure(
            409,
            "This search expired or is no longer available. Start the search again.",
          );
        state = searches.get(cursor);
        if (state.relative !== relative || state.query !== query)
          throw failure(
            400,
            "The search folder or filename changed. Start a new search.",
          );
        if (state.busy)
          throw failure(409, "Wait for the current search page to finish.");
      } else {
        signal?.throwIfAborted();
        if (searches.size >= maximumActive)
          throw failure(
            429,
            "Too many file searches are active. Wait a minute and try again.",
          );
        cursor = randomUUID();
        state = { relative, query, abort: new AbortController() };
        searches.set(cursor, state);
      }
      clearTimeout(state.timer);
      state.busy = true;
      const pageSignal = signal
        ? AbortSignal.any([signal, state.abort.signal])
        : state.abort.signal;
      const work = (async () => {
        pageSignal.throwIfAborted();
        state.scan ??= await createScan(root, relative, query.toLowerCase(), {
          safePath,
          fileSystem,
          pageSize,
          scanSize,
          pageDurationMs,
          batchSize,
        });
        return state.scan.readPage(pageSignal);
      })();
      state.pending = work;
      try {
        const { entries, done } = await work;
        pageSignal.throwIfAborted();
        if (done) await dispose(cursor, state);
        else {
          searches.delete(cursor);
          cursor = randomUUID();
          searches.set(cursor, state);
          state.timer = setTimeout(
            () => void dispose(cursor, state).catch(() => {}),
            cursorTtlMs,
          );
          state.timer.unref?.();
        }
        return {
          path: relative,
          entries,
          search: query,
          nextCursor: done ? null : cursor,
        };
      } catch (cause) {
        await dispose(cursor, state);
        throw cause;
      } finally {
        state.busy = false;
        state.pending = null;
      }
    },
    async close() {
      closed = true;
      await Promise.all(
        [...searches].map(([cursor, state]) => dispose(cursor, state)),
      );
    },
  };
}
