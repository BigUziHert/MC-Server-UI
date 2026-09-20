import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

// CPU is a sampled delta of cumulative user+kernel time: 100% means one logical
// core, and a multithreaded server can exceed 100%. Memory is summed resident
// memory (working sets on Windows), not Java heap usage or its configured limit.
// Shared resident pages may occur in more than one process's working set.
// Leave the same two-second allowance for PowerShell startup and serialization
// as the default 5s collector / 3s CIM query. Longer caller budgets must also
// extend the CIM deadline; the outer abort still enforces the overall timeout.
const windowsQuery = (timeoutMs) => String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,UserModeTime,KernelModeTime,WorkingSetSize -OperationTimeoutSec ${Math.max(1, Math.floor((timeoutMs - 2000) / 1000))} | Where-Object { $_.ProcessId -gt 0 -and $null -ne $_.CreationDate -and $null -ne $_.UserModeTime -and $null -ne $_.KernelModeTime -and $null -ne $_.WorkingSetSize } | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    identity = $_.CreationDate.ToUniversalTime().Ticks.ToString()
    started = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()
    cpuMs = ([double]$_.UserModeTime + [double]$_.KernelModeTime) / 10000
    memory = [double]$_.WorkingSetSize
  }
})
ConvertTo-Json -InputObject $rows -Compress -Depth 3
`;

function runCommand(executable, args, { signal, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new Error("Process telemetry timed out."));
    const child = spawnProcess(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    let output = "";
    let outputBytes = 0;
    let errorOutput = "";
    let failure;
    const abort = () => {
      failure = new Error("Process telemetry timed out or was stopped.");
      child.kill();
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 8 * 1024 * 1024) {
        failure = new Error("The process telemetry response was too large.");
        child.kill();
      } else output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errorOutput = (errorOutput + chunk).slice(0, 2048);
    });
    child.once("error", (cause) => {
      signal?.removeEventListener("abort", abort);
      reject(cause);
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            `Process telemetry command failed (${code}): ${errorOutput.trim() || "no diagnostic output"}`,
          ),
        );
      else resolve(output.replace(/^\uFEFF/, ""));
    });
  });
}

export function parseLinuxStat(
  text,
  { clockTicks = 100, pageSize = 4096 } = {},
) {
  // comm is parenthesized and may itself contain spaces or closing parentheses.
  const split = text.lastIndexOf(")");
  if (split < 0) throw new Error("Invalid Linux process stat record.");
  const pid = Number(text.slice(0, text.indexOf(" ")));
  const fields = text
    .slice(split + 1)
    .trim()
    .split(/\s+/);
  const started = Number(fields[19]);
  return {
    pid,
    ppid: Number(fields[1]),
    identity: fields[19],
    started,
    cpuMs: ((Number(fields[11]) + Number(fields[12])) * 1000) / clockTicks,
    memory: Number(fields[21]) * pageSize,
  };
}

export function parsePsSnapshot(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const match = line
        .trim()
        .match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d:.\-]+)\s+(.+)$/);
      if (!match) throw new Error("Invalid macOS process telemetry record.");
      const [, pid, ppid, rss, cpuTime, birth] = match;
      const pieces = cpuTime.split(":");
      const seconds = Number(pieces.pop());
      const minutes = Number(pieces.pop() ?? 0);
      const hourPart = pieces.pop() ?? "0";
      const [days, hours] = hourPart.includes("-")
        ? hourPart.split("-").map(Number)
        : [0, Number(hourPart)];
      // Darwin usually emits minutes:seconds.hundredths; also accept hours and days.
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        memory: Number(rss) * 1024,
        identity: birth.trim(),
        started: Date.parse(birth),
        cpuMs: ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000,
      };
    });
}

function createSnapshotReader({
  platform,
  timeoutMs,
  spawnProcess,
  fileSystem = fs,
}) {
  let linuxUnits;
  return async ({ signal }) => {
    if (platform === "win32") {
      const executable = path.win32.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      return JSON.parse(
        await runCommand(
          executable,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(windowsQuery(timeoutMs), "utf16le").toString("base64"),
          ],
          { signal, spawnProcess },
        ),
      );
    }
    if (platform === "darwin") {
      return parsePsSnapshot(
        await runCommand("/bin/ps", ["-axo", "pid=,ppid=,rss=,time=,lstart="], {
          signal,
          spawnProcess,
        }),
      );
    }
    if (platform !== "linux")
      throw new Error(
        "Process telemetry is unavailable on this operating system.",
      );
    if (!linuxUnits) {
      const clockTicks = Number(
        (
          await runCommand("getconf", ["CLK_TCK"], { signal, spawnProcess })
        ).trim(),
      );
      const pageSize = Number(
        (
          await runCommand("getconf", ["PAGESIZE"], { signal, spawnProcess })
        ).trim(),
      );
      if (
        !Number.isFinite(clockTicks) ||
        clockTicks <= 0 ||
        !Number.isFinite(pageSize) ||
        pageSize <= 0
      )
        throw new Error("Could not read Linux process accounting units.");
      linuxUnits = { clockTicks, pageSize };
    }
    const pids = (await fileSystem.readdir("/proc")).filter((entry) =>
      /^\d+$/.test(entry),
    );
    const records = [];
    // Bound concurrent /proc reads on hosts with many processes.
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, pids.length) }, async () => {
        while (index < pids.length && !signal.aborted) {
          const pid = pids[index++];
          try {
            records.push(
              parseLinuxStat(
                await fileSystem.readFile(`/proc/${pid}/stat`, {
                  encoding: "utf8",
                  signal,
                }),
                linuxUnits,
              ),
            );
          } catch (cause) {
            if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(cause.code))
              throw cause;
          }
        }
      }),
    );
    if (signal.aborted) throw new Error("Process telemetry timed out.");
    return records;
  };
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length > 100_000)
    throw new Error("Invalid process telemetry response.");
  const result = new Map();
  for (const row of rows) {
    if (
      !row ||
      !Number.isInteger(row.pid) ||
      row.pid <= 0 ||
      !Number.isInteger(row.ppid) ||
      row.ppid < 0 ||
      typeof row.identity !== "string" ||
      !row.identity ||
      !Number.isFinite(row.started) ||
      !Number.isFinite(row.cpuMs) ||
      row.cpuMs < 0 ||
      !Number.isSafeInteger(row.memory) ||
      row.memory < 0
    )
      continue;
    result.set(row.pid, row);
  }
  return result;
}

function processTree(rows, root) {
  const children = new Map();
  for (const row of rows.values()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const found = new Map([[root.pid, root]]);
  const pending = [root];
  while (pending.length) {
    const parent = pending.pop();
    for (const child of children.get(parent.pid) ?? []) {
      // Parent IDs can refer to a newer process after reuse; that older child
      // cannot belong to this server's current process tree.
      if (found.has(child.pid) || child.started < parent.started) continue;
      found.set(child.pid, child);
      pending.push(child);
    }
  }
  return found;
}

/** One instance can serve a whole fleet. Queries coalesce and cache for 2s.
 * Reset a PID at process launch/exit, and discard an awaited result if the owned
 * ChildProcess changed or exited while sampling. No background timer is created.
 * The first sample reports memory immediately and cpu:null until a second delta.
 */
export function createProcessTelemetry({
  platform = process.platform,
  cacheMs = 2000,
  timeoutMs = 5000,
  now = () => performance.now(),
  wallNow = () => Date.now(),
  readSnapshot,
  spawnProcess = spawn,
  fileSystem = fs,
} = {}) {
  const read =
    readSnapshot ??
    createSnapshotReader({ platform, timeoutMs, spawnProcess, fileSystem });
  const states = new Map();
  let epoch = 0;
  let sequence = 0;
  let snapshotSerial = 0;
  let cached;
  let active;
  let closed = false;
  const unavailable = (message, sampledAt = wallNow()) => ({
    available: false,
    cpu: null,
    memory: null,
    processCount: 0,
    sampledAt,
    error: message,
  });
  const snapshot = (minimumSerial = 0) => {
    if (cached && cached.serial >= minimumSerial && now() - cached.at < cacheMs)
      return Promise.resolve(cached);
    if (active) {
      if (active.serial >= minimumSerial) return active.result;
      const previous = active;
      return previous.result.then((result) =>
        active === previous
          ? {
              ...result,
              error:
                "The previous telemetry reader has not finished. Retrying with the new server process.",
            }
          : snapshot(minimumSerial),
      );
    }
    const operation = {
      epoch,
      serial: ++snapshotSerial,
      controller: new AbortController(),
    };
    active = operation;
    let timer;
    const work = Promise.resolve()
      .then(() => read({ signal: operation.controller.signal }))
      .then(validateRows);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        operation.controller.abort();
        reject(new Error("Process telemetry timed out."));
      }, timeoutMs);
    });
    operation.result = Promise.race([work, timeout])
      .then(
        (rows) => ({
          rows,
          at: now(),
          sampledAt: wallNow(),
          sequence: ++sequence,
          serial: operation.serial,
          epoch: operation.epoch,
        }),
        (cause) => ({
          error: cause.message || "Process telemetry could not be read.",
          at: now(),
          sampledAt: wallNow(),
          sequence: ++sequence,
          serial: operation.serial,
          epoch: operation.epoch,
        }),
      )
      .then((result) => {
        if (!closed && epoch === operation.epoch) cached = result;
        return result;
      });
    const finish = () => {
      clearTimeout(timer);
      // Keep a timed-out reader occupying its slot until it actually settles,
      // so repeated UI polls cannot launch overlapping stuck system commands.
      if (active === operation) active = undefined;
    };
    work.then(finish, finish);
    return operation.result;
  };
  return {
    async sample(pid) {
      if (closed) return unavailable("Process telemetry is stopped.");
      if (!Number.isInteger(pid) || pid <= 0)
        return unavailable("The server process is not running.");
      let state = states.get(pid);
      if (!state) {
        state = {};
        states.set(pid, state);
      }
      const result = await snapshot(state.minimumSerial);
      if (closed || state !== states.get(pid) || result.epoch !== epoch)
        return unavailable(
          "The server process changed while telemetry was being read.",
        );
      if (result.error) {
        state.previous = undefined;
        return unavailable(result.error, result.sampledAt);
      }
      const root = result.rows.get(pid);
      if (!root) {
        state.previous = undefined;
        return unavailable(
          "The server process has exited or its resource counters are not accessible.",
          result.sampledAt,
        );
      }
      if (state.identity && state.identity !== root.identity)
        return unavailable(
          "The original server process exited; this process ID has been reused.",
          result.sampledAt,
        );
      state.identity = root.identity;
      if (state.previous?.sequence === result.sequence) return state.lastResult;
      const tree = processTree(result.rows, root);
      let cpu = null;
      if (state.previous && result.at > state.previous.at) {
        let elapsedCpu = 0;
        for (const row of tree.values()) {
          const before = state.previous.tree.get(row.pid);
          if (before?.identity === row.identity)
            elapsedCpu += Math.max(0, row.cpuMs - before.cpuMs);
        }
        cpu =
          Math.round((elapsedCpu / (result.at - state.previous.at)) * 1000) /
          10;
      }
      state.previous = { tree, at: result.at, sequence: result.sequence };
      state.lastResult = {
        available: true,
        cpu,
        memory: [...tree.values()].reduce((sum, row) => sum + row.memory, 0),
        processCount: tree.size,
        sampledAt: result.sampledAt,
      };
      return state.lastResult;
    },
    reset(pid) {
      if (pid === undefined) {
        states.clear();
        epoch++;
      } else states.set(pid, { minimumSerial: snapshotSerial + 1 });
      cached = undefined;
    },
    close() {
      closed = true;
      states.clear();
      cached = undefined;
      epoch++;
      active?.controller.abort();
    },
  };
}
