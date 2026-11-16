import { spawn } from "node:child_process";
import path from "node:path";

const DOTNET_EPOCH_MICROSECONDS = 62135596800000000n;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const micros = (milliseconds) =>
  BigInt(Math.floor(milliseconds)) * 1000n + DOTNET_EPOCH_MICROSECONDS;

function runPowerShell(script, { spawnProcess, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let helper,
      timer,
      settled = false,
      stdout = "",
      stderr = "",
      bytes = 0;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = (message) => {
      finish(new Error(message));
      try {
        helper?.kill();
      } catch {
        /* The helper may already have exited. */
      }
    };
    try {
      helper = spawnProcess(
        path.win32.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const collect = (stream) => (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES)
          return abort(
            "Windows process inspection returned too much data. Try Force Stop again.",
          );
        if (stream === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      helper.stdout?.on("data", collect("stdout"));
      helper.stderr?.on("data", collect("stderr"));
      helper.once("error", (error) =>
        finish(
          new Error(
            `Windows process inspection could not start: ${error.message}`,
          ),
        ),
      );
      helper.once("close", (code) => {
        if (code !== 0)
          return finish(
            new Error(
              `Windows process inspection failed${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ` (exit ${code})`}`,
            ),
          );
        try {
          finish(null, JSON.parse(stdout.replace(/^\uFEFF/, "").trim()));
        } catch {
          finish(
            new Error(
              "Windows process inspection returned an invalid response. Try Force Stop again.",
            ),
          );
        }
      });
      timer = setTimeout(
        () =>
          abort("Windows process inspection timed out. Try Force Stop again."),
        timeoutMs,
      );
    } catch (error) {
      finish(error);
    }
  });
}

const snapshotScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
  if ($_.ProcessId -gt 4) {
    if ($null -eq $_.CreationDate) { throw 'A process creation time is unavailable.' }
    @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; createdAt = $_.CreationDate.ToUniversalTime().Ticks.ToString() }
  }
})
if ($rows.Count -eq 0) { throw 'Windows returned no processes during inspection.' }
@{ processes = $rows } | ConvertTo-Json -Compress -Depth 4
`;

function validateSnapshot(rows) {
  if (!Array.isArray(rows))
    throw new Error(
      "Windows process inspection returned an invalid process list. Try Force Stop again.",
    );
  const seen = new Set();
  return rows.map((row) => {
    if (
      !row ||
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 4 ||
      !Number.isSafeInteger(row.parentPid) ||
      row.parentPid < 0 ||
      typeof row.createdAt !== "string" ||
      !/^[1-9]\d{1,18}$/.test(row.createdAt) ||
      seen.has(row.pid)
    )
      throw new Error(
        "Windows process inspection returned incomplete process identities. Try Force Stop again.",
      );
    seen.add(row.pid);
    return { ...row, birth: BigInt(row.createdAt) / 10n };
  });
}

function killScript(rows) {
  const identities = rows
    .map((row) => `@{ Id = ${row.pid}; Born = '${row.birth}' }`)
    .join(",");
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$failures = @()
foreach ($identity in @(${identities})) {
  $process = $null
  try {
    try { $process = [System.Diagnostics.Process]::GetProcessById($identity.Id) }
    catch [System.ArgumentException] { continue }
    # Cache the process handle BEFORE checking its identity. Kill then operates
    # on this handle even if Windows recycles the numeric PID in the meantime.
    $null = $process.Handle
    if ($process.HasExited) { continue }
    $born = [Math]::Floor([decimal]$process.StartTime.ToUniversalTime().Ticks / 10).ToString('0')
    if ($born -ne $identity.Born) { continue }
    $process.Kill()
    $null = $process.WaitForExit(1000)
  } catch {
    if ($null -eq $process -or !$process.HasExited) { $failures += ('PID ' + $identity.Id + ': ' + $_.Exception.Message) }
  } finally { if ($null -ne $process) { $process.Dispose() } }
}
@{ failures = $failures } | ConvertTo-Json -Compress -Depth 3
`;
}

/**
 * Retains Windows process identities across failed Force Stop attempts.
 * Providers are injectable for tests; snapshots contain {pid, parentPid,
 * createdAt}, where createdAt is a decimal string of UTC .NET DateTime ticks.
 * Termination uses identity-checked handles instead of PID-based taskkill.
 */
export function createWindowsProcessTree(
  child,
  {
    startedAt,
    timeoutMs = 5000,
    spawnProcess = spawn,
    now = Date.now,
    readSnapshot = async () => {
      const result = await runPowerShell(snapshotScript, {
        spawnProcess,
        timeoutMs,
      });
      return result?.processes;
    },
    killProcesses = async (rows) => {
      const result = await runPowerShell(killScript(rows), {
        spawnProcess,
        timeoutMs,
      });
      if (!result || !Array.isArray(result.failures))
        throw new Error(
          "Windows process termination returned an invalid response.",
        );
      if (result.failures.length)
        throw new Error(result.failures.join("; ").slice(0, 500));
    },
  } = {},
) {
  const createdAt = now();
  const rootFloor = micros(Number.isFinite(startedAt) ? startedAt : createdAt);
  const rootCeiling = micros(createdAt + 1);
  const owned = new Map();
  const ambiguous = new Map();
  let rootCaptured = false;
  let exitedAt =
    child.exitCode != null || child.signalCode != null
      ? micros(createdAt + 1)
      : null;
  const onExit = () => {
    exitedAt ??= micros(now() + 1);
  };
  child.once?.("exit", onExit);
  const key = (row) => `${row.pid}:${row.birth}`;

  function discover(rows, observedAt, rootWasAlive) {
    const current = new Map(rows.map((row) => [row.pid, row]));
    const root = current.get(child.pid);
    // A snapshot initiated while the original child was alive can still return
    // its original row after Node delivers exit. Never establish ownership from
    // a query initiated after exit, or outside the bounded spawn-time interval.
    if (
      !rootCaptured &&
      rootWasAlive &&
      root &&
      root.birth >= rootFloor &&
      root.birth < rootCeiling
    ) {
      owned.set(key(root), { ...root, until: null, lastSeen: observedAt });
      rootCaptured = true;
    }
    const parents = [...owned.values(), ...ambiguous.values()];
    for (const parent of parents) {
      const replacement = current.get(parent.pid);
      if (replacement?.birth === parent.birth)
        parent.lastSeen = observedAt > parent.birth ? observedAt : parent.birth;
      if (
        replacement &&
        replacement.birth !== parent.birth &&
        replacement.birth > parent.birth
      )
        parent.until =
          parent.until === null
            ? replacement.birth
            : parent.until < replacement.birth
              ? parent.until
              : replacement.birth;
      if (parent.pid === child.pid && exitedAt !== null)
        parent.until =
          parent.until === null
            ? exitedAt
            : parent.until < exitedAt
              ? parent.until
              : exitedAt;
    }
    // Expand through both live and remembered parents. A remembered intermediate
    // wrapper can exit while its descendants remain alive for the next retry.
    for (let index = 0; index < parents.length; index++) {
      const parent = parents[index];
      for (const row of rows) {
        if (
          owned.has(key(row)) ||
          ambiguous.has(key(row)) ||
          row.pid === child.pid ||
          row.parentPid !== parent.pid ||
          row.birth < parent.birth ||
          (parent.until !== null && row.birth >= parent.until)
        )
          continue;
        const currentParent = current.get(parent.pid);
        if (
          currentParent &&
          currentParent.birth !== parent.birth &&
          row.birth >= currentParent.birth
        )
          continue;
        // If an unobserved replacement reused this PID and exited between
        // retries, PPID alone cannot prove ownership. Only discover children
        // born during the original parent's last proven lifetime.
        const record = {
          ...row,
          until: null,
          lastSeen: observedAt > row.birth ? observedAt : row.birth,
        };
        if (
          ambiguous.has(key(parent)) ||
          (currentParent?.birth !== parent.birth && row.birth > parent.lastSeen)
        ) {
          // This may be a late server child or an unrelated recycled parent's
          // child. Never kill it and never declare the tree gone while it lives.
          // Remember it so children remain ambiguous if this parent also exits.
          ambiguous.set(key(row), record);
        } else owned.set(key(row), record);
        parents.push(record);
      }
    }
    return {
      owned: rows.filter((row) => owned.has(key(row))),
      ambiguous: rows.filter((row) => ambiguous.has(key(row))),
    };
  }

  return {
    async terminate() {
      if (!Number.isSafeInteger(child.pid) || child.pid <= 4)
        throw new Error(
          "The server process identity is unavailable. Try Force Stop again.",
        );
      const inspect = async () => {
        const observedAt = micros(now());
        const rootWasAlive = exitedAt === null;
        return discover(
          validateSnapshot(await readSnapshot()),
          observedAt,
          rootWasAlive,
        );
      };
      const before = await inspect();
      let killError;
      if (before.owned.length) {
        try {
          // Children first; the subsequent full snapshot detects any additional
          // descendants created before their parent finishes terminating.
          await killProcesses(
            before.owned.sort((a, b) =>
              a.birth > b.birth ? -1 : a.birth < b.birth ? 1 : b.pid - a.pid,
            ),
          );
        } catch (error) {
          killError = error;
        }
      }
      const survivors = await inspect();
      if (!rootCaptured)
        throw new Error(
          "The server exited before its process tree could be identified. Windows cannot yet confirm that all server processes stopped. Try Force Stop again or check the server processes.",
        );
      if (survivors.ambiguous.length)
        throw new Error(
          `Some server child processes could not be safely identified (PID ${survivors.ambiguous.map((row) => row.pid).join(", ")}). Try Force Stop again or check the server processes.`,
        );
      if (survivors.owned.length)
        throw new Error(
          `Server processes are still stopping (PID ${survivors.owned.map((row) => row.pid).join(", ")}). Try Force Stop again.${killError ? ` ${killError.message}` : ""}`,
        );
      // A helper failure is harmless once a fresh, valid enumeration confirms
      // that every owned identity is gone (including PID-reuse races).
    },
    dispose() {
      child.removeListener?.("exit", onExit);
    },
  };
}
