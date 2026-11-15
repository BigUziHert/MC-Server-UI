import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createWindowsProcessTree,
  windowsProcessIdentity,
} from "./windows-process-tree.mjs";
const execute = promisify(execFile);

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 4) return null;
  if (process.platform === "win32") return windowsProcessIdentity(pid);
  try {
    if (process.platform === "linux") {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      return {
        pid,
        birth: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
      };
    }
    const { stdout } = await execute(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      { timeout: 5000, maxBuffer: 4096 },
    );
    return stdout.trim() ? { pid, birth: stdout.trim() } : null;
  } catch (cause) {
    if (["ENOENT", "ESRCH"].includes(cause.code) || cause.code === 1)
      return null;
    throw cause;
  }
}

export async function createProcessOwnership({
  dataDir,
  serverDir,
  safePath,
  identify = processIdentity,
  allowUntracked = false,
}) {
  const file = await safePath(dataDir, "owned-process.json");
  let record;
  try {
    record = JSON.parse(await fs.readFile(file, "utf8"));
    if (
      record.serverDir !== serverDir ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 4 ||
      !(
        (typeof record.birth === "string" && record.birth.length > 0) ||
        (record.birth === null && record.unresolved === true)
      ) ||
      (record.tree !== undefined && typeof record.tree !== "boolean") ||
      (record.unresolved !== undefined &&
        typeof record.unresolved !== "boolean")
    )
      throw new Error(
        "The saved server process record is invalid. Check owned-process.json before starting this server.",
      );
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
  }
  let persistence = Promise.resolve();
  const serialize = (work) => {
    const next = persistence.catch(() => {}).then(work);
    persistence = next;
    return next;
  };
  const current = async () => {
    if (!record) return null;
    // An identity lookup failure never grants permission to adopt or signal a
    // process. The sentinel survives restart until explicitly checked/cleared.
    if (record.unresolved) return { ...record };
    const found = await identify(record.pid);
    return found?.birth === record.birth
      ? record
      : record.tree
        ? { ...record, unresolved: true }
        : null;
  };
  const publish = async (value) => {
    record = value;
    const temporary = await safePath(dataDir, "owned-process.tmp");
    const handle = await fs.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  };
  const clearRecord = async (pid) => {
    if (record?.pid !== pid) return;
    await fs.rm(file, { force: true });
    record = undefined;
  };
  return {
    current,
    remember(child, executable, startedAt, { tree = false } = {}) {
      return serialize(async () => {
        const exited = () => child.exitCode != null || child.signalCode != null;
        if (!tree && exited()) return;
        if (!Number.isSafeInteger(child.pid) || child.pid <= 4) {
          if (allowUntracked) return;
          throw new Error(
            "The new server process identity could not be verified because its PID is unavailable.",
          );
        }
        const base = {
          pid: child.pid,
          executable,
          serverDir,
          startedAt,
          ...(tree ? { tree: true } : {}),
        };
        // Publish before the potentially slow OS lookup. A wrapper may already
        // have spawned Java and exited, or the panel may crash during lookup.
        if (!allowUntracked)
          await publish({ ...base, birth: null, unresolved: true });
        let identity, lookupFailure;
        try {
          identity = await identify(child.pid);
        } catch (cause) {
          lookupFailure = cause;
        }
        const verified =
          identity?.pid === child.pid &&
          typeof identity.birth === "string" &&
          identity.birth.length > 0;
        if (!verified) {
          if (allowUntracked && !lookupFailure) return;
          if (allowUntracked) throw lookupFailure;
          if (exited()) {
            if (!tree) await clearRecord(child.pid);
            return;
          }
          throw new Error(
            "The new server process identity could not be verified. Stop it before starting another server process.",
            { cause: lookupFailure },
          );
        }
        if (exited() && !tree) {
          await clearRecord(child.pid);
          return;
        }
        await publish({
          ...base,
          birth: identity.birth,
          ...(exited() ? { unresolved: true } : {}),
        });
      });
    },
    clear(pid) {
      return serialize(() => clearRecord(pid));
    },
    confirmStopped() {
      return serialize(async () => {
        if (!record) return;
        const found = await identify(record.pid);
        if (found && (record.birth === null || found.birth === record.birth))
          throw new Error(
            "The previous server launcher is still running or its PID cannot yet be ruled out. Stop it before clearing its recovery record.",
          );
        await clearRecord(record.pid);
      });
    },
    async stop() {
      const live = await current();
      if (!live) {
        if (record) await this.clear(record.pid);
        return;
      }
      if (live.unresolved)
        throw new Error(
          "The previous server process identity is unresolved, and its child processes could still be running. Check and stop them, then confirm that this server is stopped before starting it again.",
        );
      if (process.platform === "win32") {
        const child = { pid: live.pid, exitCode: null, signalCode: null };
        const tree = createWindowsProcessTree(child, {
          startedAt: live.startedAt,
          expectedBirth: live.birth,
        });
        try {
          await tree.terminate();
        } finally {
          tree.dispose();
        }
      } else {
        // Check the start identity again immediately before each signal.
        const target = live.tree ? -live.pid : live.pid;
        if ((await identify(live.pid))?.birth === live.birth)
          process.kill(target, "SIGTERM");
        for (
          let attempt = 0;
          attempt < 20 && (await identify(live.pid))?.birth === live.birth;
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 100));
        if ((await identify(live.pid))?.birth === live.birth)
          process.kill(target, "SIGKILL");
        if (live.tree) {
          let groupExists = true;
          try {
            process.kill(target, 0);
          } catch (cause) {
            if (cause.code === "ESRCH") groupExists = false;
            else throw cause;
          }
          if (groupExists)
            throw new Error(
              "The previous server process group may still be stopping. Check its child processes before confirming that the server is stopped.",
            );
        }
      }
      if ((await identify(live.pid))?.birth === live.birth)
        throw new Error(
          "The previous server process is still stopping. Retry after it exits.",
        );
      await this.clear(live.pid);
    },
  };
}
