import { totalmem } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

export async function startSelectedServers({
  serverIds,
  runtimeFor,
  start,
  names = {},
  signal,
  retryDelays = [15_000, 30_000, 60_000],
  readyTimeoutMs = 120_000,
  pollMs = 250,
  hostMemoryMB = Math.floor(totalmem() / 1024 ** 2),
  wait = (ms) => delay(ms, undefined, { signal }),
  now = Date.now,
}) {
  const startedServerIds = [],
    failures = [],
    warnings = [];
  let configuredMB = 0,
    unknownMemory = false;
  for (const serverId of serverIds) {
    const descriptor = () => runtimeFor(serverId)?.descriptor();
    const name = descriptor()?.name || names[serverId] || "Removed server";
    try {
      signal?.throwIfAborted();
      if (!descriptor())
        throw new Error(
          "Removed from the panel. Uncheck this server in Panel Settings.",
        );
      for (
        let attempt = 0;
        !["running", "starting"].includes(descriptor()?.status);
        attempt++
      ) {
        signal?.throwIfAborted();
        try {
          await start(serverId);
          break;
        } catch (cause) {
          if (!descriptor()?.unavailable || attempt >= retryDelays.length)
            throw cause;
          await wait(retryDelays[attempt]);
        }
      }
      const deadline = now() + readyTimeoutMs;
      while (descriptor()?.status === "starting" && now() < deadline) {
        signal?.throwIfAborted();
        await wait(pollMs);
      }
      const current = descriptor();
      if (!current || !["running", "starting"].includes(current.status))
        throw new Error(
          current?.lastExit?.reason ||
            "The process exited before the server was ready. Open Console for details.",
        );
      if (current.status === "starting")
        warnings.push(
          `${name}: still starting after ${Math.round(readyTimeoutMs / 1000)} seconds. Check Console.`,
        );
      const memory =
        current.memoryLimitSource === "unknown" ||
        current.configuredMemoryLimitMB === null
          ? null
          : (current.configuredMemoryLimitMB ?? current.memoryLimitMB);
      if (Number.isFinite(memory) && memory > 0) configuredMB += memory;
      else unknownMemory = true;
      startedServerIds.push(serverId);
    } catch (cause) {
      failures.push({
        serverId,
        message: `${name}: ${descriptor()?.unavailable ? descriptor().sourceError || "The server folder is unreachable." : cause.message || "The server could not start."}`,
      });
    }
  }
  if (configuredMB * 1.15 > Math.max(0, hostMemoryMB - 2048))
    warnings.push(
      `Selected servers have ${configuredMB} MB of heap limits, plus JVM overhead, on a ${hostMemoryMB} MB computer. This may leave too little memory for the host; reduce allocations if it becomes unresponsive.`,
    );
  if (unknownMemory)
    warnings.push(
      "Some script-based servers have an unknown memory limit. Check their JVM arguments when planning host memory.",
    );
  return { skipped: false, startedServerIds, failures, warnings };
}
