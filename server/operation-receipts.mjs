import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

const failure = (status, message) =>
  Object.assign(new Error(message), { status });
const requestId = (value) => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw failure(400, "The operation request ID must be a UUID.");
  return value.toLowerCase();
};

// Keep durable receipts, including interrupted operations. A receipt must never
// expire into permission to repeat a destructive action. These small private
// records deliberately survive both result-history dismissal and app restarts.
export async function createOperationReceipts(directory, safePath) {
  await fs.mkdir(directory, { recursive: true });
  const identity = await fs.realpath(directory);
  const active = new Map();
  const location = async (id) => {
    if ((await fs.realpath(directory)) !== identity)
      throw failure(
        409,
        "Operation receipt storage changed. Restart the panel.",
      );
    return safePath(directory, `${id}.json`);
  };
  const persist = async (id, value, initial = false) => {
    const target = await location(id);
    if (initial) {
      const handle = await fs.open(target, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    }
    const temporary = await safePath(directory, `${id}.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, await location(id));
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  };
  const read = async (id) => {
    try {
      return JSON.parse(await fs.readFile(await location(id), "utf8"));
    } catch (cause) {
      if (cause.code === "ENOENT") return null;
      throw failure(
        409,
        "The original operation receipt could not be read. Check the server before reviewing a new operation.",
      );
    }
  };
  return {
    async run(value, binding, work) {
      // Preserve older API clients; safe retries require their own stable ID.
      if (value == null) return work(null);
      const id = requestId(value);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(binding))
        .digest("hex");
      const pending = active.get(id);
      if (pending) {
        if (pending.fingerprint !== fingerprint)
          throw failure(
            409,
            "This request ID belongs to another operation or account.",
          );
        return pending.promise;
      }
      const promise = (async () => {
        const previous = await read(id);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw failure(
              409,
              "This request ID belongs to another operation or account.",
            );
          if (previous.status === "completed") return previous.result;
          if (previous.status === "failed")
            throw failure(
              previous.code ?? 409,
              `${previous.error} Close this confirmation and review again to start a new operation.`,
            );
          throw failure(
            409,
            "The original operation was interrupted and its outcome cannot be confirmed. Check the server before closing this confirmation and reviewing a new operation. It was not repeated.",
          );
        }
        const receipt = {
          fingerprint,
          status: "started",
          createdAt: new Date().toISOString(),
        };
        await persist(id, receipt, true);
        let result;
        try {
          result = await work(id);
        } catch (cause) {
          if (cause.operationNotStarted === true) {
            // Only the caller can prove its synchronous acceptance checks
            // rejected before acquiring any work. A later explicit retry may
            // use this ID once the prerequisite (for example a lock) is fixed.
            await fs.rm(await location(id), { force: true });
            throw cause;
          }
          await persist(id, {
            ...receipt,
            status: "failed",
            code: cause.status ?? 409,
            error: cause.message,
          }).catch(() => {});
          throw cause;
        }
        // If this write fails, the durable started receipt still prevents a
        // replay, including after restart. Never label a committed action failed.
        await persist(id, { ...receipt, status: "completed", result });
        return result;
      })();
      active.set(id, { fingerprint, promise });
      try {
        return await promise;
      } finally {
        if (active.get(id)?.promise === promise) active.delete(id);
      }
    },
    async update(value, result) {
      if (value == null) return;
      const id = requestId(value);
      await active.get(id)?.promise.catch(() => {});
      const previous = await read(id);
      if (!previous)
        throw failure(409, "The original operation receipt is missing.");
      await persist(id, { ...previous, status: "completed", result });
    },
  };
}
