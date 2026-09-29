import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

const failure = (status, message) =>
  Object.assign(new Error(message), { status });
const identity = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const missing = (cause) => ["ENOENT", "ENOTDIR"].includes(cause.code);

// Keep one directory handle open per scan. Pages bound work per request, while
// the cursor retains traversal position rather than a truncated result set.
async function createScan(root, relative, needle, options) {
  const {
    safePath,
    fileSystem: io,
    pageSize,
    scanSize,
    pageDurationMs,
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
        scanned++;
        if (!handle) {
          directory = directories.pop();
          try {
            const target = await checkedPath(directory, signal);
            directoryStat = await io.lstat(target);
            handle = await io.opendir(target);
          } catch (cause) {
            if (missing(cause) || cause.status === 400) continue;
            throw cause;
          }
        }
        // Recheck ancestors even on a retained handle: a folder could be moved
        // or replaced between pages, and a stale handle must not reveal it.
        const target = await checkedPath(directory, signal);
        if (!identity(directoryStat, await io.lstat(target)))
          throw failure(
            409,
            "A folder changed during search. Start the search again.",
          );
        const item = await handle.read();
        if (!item) {
          await closeHandle();
        } else if (!item.isSymbolicLink()) {
          const child = [directory, item.name].filter(Boolean).join("/");
          let stat;
          try {
            stat = await io.lstat(await checkedPath(child, signal));
          } catch (cause) {
            if (!missing(cause) && cause.status !== 400) throw cause;
          }
          if (
            stat &&
            !stat.isSymbolicLink() &&
            (stat.isFile() || stat.isDirectory())
          ) {
            if (stat.isDirectory()) directories.push(child);
            if (item.name.toLowerCase().includes(needle))
              entries.push({
                name: item.name,
                path: child,
                type: stat.isDirectory() ? "directory" : "file",
                size: stat.isDirectory() ? 0 : stat.size,
                modified: stat.mtime.toISOString(),
              });
          }
        }
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
  scanSize = 500,
  pageDurationMs = 1000,
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
