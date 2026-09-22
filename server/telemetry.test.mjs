import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createProcessTelemetry,
  parseLinuxStat,
  parsePsSnapshot,
} from "./telemetry.mjs";

const row = (
  pid,
  ppid,
  cpuMs,
  memory,
  started = pid,
  identity = String(started),
) => ({ pid, ppid, cpuMs, memory, started, identity });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("resetting one fleet PID preserves another server's in-flight CPU baseline", async () => {
  const gate = deferred();
  let at = 0,
    delayed = false;
  const telemetry = createProcessTelemetry({
    cacheMs: 0,
    now: () => at,
    readSnapshot: async () => {
      if (delayed) await gate.promise;
      return [row(10, 1, 100 + at / 2, 10), row(20, 1, 100 + at / 4, 20)];
    },
  });
  try {
    await Promise.all([telemetry.sample(10), telemetry.sample(20)]);
    delayed = true;
    at = 1000;
    const pending = telemetry.sample(20);
    telemetry.reset(10);
    gate.resolve();
    const sample = await pending;
    assert.equal(sample.available, true);
    assert.equal(sample.cpu, 25);
  } finally {
    gate.resolve();
    telemetry.close();
  }
});

test("a replacement PID waits for a post-reset snapshot without binding to the old identity", async () => {
  const gate = deferred();
  let reads = 0;
  const telemetry = createProcessTelemetry({
    cacheMs: 0,
    readSnapshot: async () => {
      if (++reads === 1) {
        await gate.promise;
        return [row(10, 1, 100, 111, 10, "old")];
      }
      return [row(10, 1, 0, 222, 20, "new")];
    },
  });
  try {
    const stale = telemetry.sample(10);
    telemetry.reset(10);
    const fresh = telemetry.sample(10);
    gate.resolve();
    assert.equal((await stale).available, false);
    const replacement = await fresh;
    assert.equal(replacement.available, true);
    assert.equal(replacement.memory, 222);
    assert.equal(replacement.cpu, null);
    assert.equal((await telemetry.sample(10)).available, true);
  } finally {
    gate.resolve();
    telemetry.close();
  }
});

test("CPU deltas and resident memory cover only the owned tree, with 100% per logical core", async () => {
  let at = 0;
  let rows = [
    row(10, 1, 1000, 100),
    row(11, 10, 2000, 200),
    row(12, 11, 3000, 300),
    row(20, 1, 90000, 9000),
  ];
  const telemetry = createProcessTelemetry({
    cacheMs: 0,
    now: () => at,
    wallNow: () => 1234 + at,
    readSnapshot: async () => rows,
  });
  const first = await telemetry.sample(10);
  assert.deepEqual(first, {
    available: true,
    cpu: null,
    memory: 600,
    processCount: 3,
    sampledAt: 1234,
  });
  at = 1000;
  rows = [
    row(10, 1, 1500, 110),
    row(11, 10, 3000, 220),
    row(12, 11, 3500, 330),
    row(20, 1, 99999, 9900),
  ];
  const second = await telemetry.sample(10);
  assert.equal(second.cpu, 200);
  assert.equal(second.memory, 660);
  telemetry.close();
});

test("joining and exiting descendants cannot introduce a lifetime-CPU spike or negative CPU", async () => {
  let at = 0;
  let rows = [row(10, 1, 100, 10), row(11, 10, 100000, 20)];
  const telemetry = createProcessTelemetry({
    cacheMs: 0,
    now: () => at,
    readSnapshot: async () => rows,
  });
  await telemetry.sample(10);
  at = 1000;
  rows = [row(10, 1, 200, 10), row(12, 10, 50000, 30)];
  const result = await telemetry.sample(10);
  assert.equal(result.cpu, 10);
  assert.equal(result.memory, 40);
  at = 2000;
  rows = [row(10, 1, 250, 10), row(12, 10, 40, 30, 2000, "reused-child")];
  assert.equal((await telemetry.sample(10)).cpu, 5);
  telemetry.close();
});

test("creation identities reject reused root PIDs and stale parent IDs until explicit reset", async () => {
  let at = 0;
  let rows = [row(10, 1, 100, 10, 100), row(11, 10, 100, 20, 90)];
  const telemetry = createProcessTelemetry({
    cacheMs: 0,
    now: () => at,
    readSnapshot: async () => rows,
  });
  assert.equal((await telemetry.sample(10)).processCount, 1);
  at = 1000;
  rows = [row(10, 1, 20, 40, 999)];
  assert.match((await telemetry.sample(10)).error, /reused/);
  telemetry.reset(10);
  const fresh = await telemetry.sample(10);
  assert.equal(fresh.cpu, null);
  assert.equal(fresh.memory, 40);
  telemetry.close();
});

test("fleet requests share one cached snapshot and repeated polling does not consume the CPU baseline", async () => {
  let at = 0;
  let reads = 0;
  const gate = deferred();
  const telemetry = createProcessTelemetry({
    cacheMs: 2000,
    now: () => at,
    readSnapshot: async () => {
      reads++;
      await gate.promise;
      return [row(10, 1, at, 10), row(20, 1, at / 2, 20)];
    },
  });
  const requests = [
    telemetry.sample(10),
    telemetry.sample(20),
    telemetry.sample(10),
  ];
  gate.resolve();
  await Promise.all(requests);
  assert.equal(reads, 1);
  at = 1000;
  assert.equal((await telemetry.sample(10)).cpu, null);
  assert.equal(reads, 1);
  at = 2000;
  const sampled = await telemetry.sample(10);
  assert.equal(sampled.cpu, 100);
  assert.equal((await telemetry.sample(10)).cpu, 100);
  assert.equal(reads, 2);
  telemetry.close();
});

test("reset and close discard in-flight samples instead of displaying an older server", async () => {
  const gate = deferred();
  const telemetry = createProcessTelemetry({
    cacheMs: 0,
    readSnapshot: async () => gate.promise,
  });
  const pending = telemetry.sample(10);
  telemetry.reset(10);
  gate.resolve([row(10, 1, 100, 20)]);
  assert.equal((await pending).available, false);
  assert.equal((await telemetry.sample(10)).available, true);
  telemetry.close();
  assert.equal((await telemetry.sample(10)).available, false);
});

test("timeouts are bounded and do not spawn overlapping collectors even if a reader ignores abort", async () => {
  const gate = deferred();
  let reads = 0;
  const telemetry = createProcessTelemetry({
    cacheMs: 0,
    timeoutMs: 15,
    readSnapshot: async () => {
      reads++;
      return gate.promise;
    },
  });
  const first = await telemetry.sample(10);
  assert.equal(first.available, false);
  assert.match(first.error, /timed out/);
  assert.equal((await telemetry.sample(10)).available, false);
  assert.equal(reads, 1);
  gate.resolve([row(10, 1, 100, 20)]);
  await pause(0);
  assert.equal((await telemetry.sample(10)).available, true);
  assert.equal(reads, 2);
  telemetry.close();
});

test("missing, inaccessible and malformed counters report unavailable without fabricating zero usage", async () => {
  let rows = [];
  let failure;
  const telemetry = createProcessTelemetry({
    cacheMs: 0,
    readSnapshot: async () => {
      if (failure) throw failure;
      return rows;
    },
  });
  assert.equal((await telemetry.sample(undefined)).available, false);
  assert.match((await telemetry.sample(10)).error, /exited|not accessible/);
  rows = [{ ...row(10, 1, 1, 1), memory: null }];
  assert.equal((await telemetry.sample(10)).memory, null);
  failure = new Error("Counter access denied");
  assert.match((await telemetry.sample(10)).error, /access denied/);
  failure = undefined;
  rows = [row(10, 1, 20, 200)];
  const recovered = await telemetry.sample(10);
  assert.equal(recovered.available, true);
  assert.equal(recovered.cpu, null);
  telemetry.close();
});

test("Linux stat parsing handles parenthesized command names and platform accounting units", () => {
  const fields = Array(22).fill("0");
  fields[0] = "S";
  fields[1] = "10";
  fields[11] = "125";
  fields[12] = "25";
  fields[19] = "900";
  fields[21] = "100";
  const parsed = parseLinuxStat(`11 (java (worker) name) ${fields.join(" ")}`, {
    clockTicks: 250,
    pageSize: 16384,
  });
  assert.deepEqual(parsed, row(11, 10, 600, 1638400, 900));
});

test("macOS ps fallback parses cumulative CPU time, resident kilobytes and start identity", () => {
  const [first, second, third] = parsePsSnapshot(
    "10 1 100 02:03.45 Sat Sep 12 10:00:00 2026\n11 10 200 1:02:03 Sat Sep 12 10:00:01 2026\n12 11 300 2-01:02:03 Sat Sep 12 10:00:02 2026\n",
  );
  assert.equal(first.cpuMs, 123450);
  assert.equal(first.memory, 102400);
  assert.equal(second.cpuMs, 3723000);
  assert.equal(third.cpuMs, 176523000);
  assert.ok(second.started > first.started);
});

test("Windows collector uses hidden PowerShell CIM with numeric counters and no shell or command-line harvesting", async () => {
  const telemetry = createProcessTelemetry({
    platform: "win32",
    cacheMs: 0,
    spawnProcess: (executable, args, options) => {
      assert.match(executable, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, false);
      assert.ok(args.includes("-NoProfile"));
      const query = Buffer.from(args.at(-1), "base64").toString("utf16le");
      assert.match(query, /Get-CimInstance/);
      assert.match(query, /UserModeTime/);
      assert.match(query, /WorkingSetSize/);
      assert.doesNotMatch(
        query,
        /CommandLine|ExecutablePath|Get-WmiObject|wmic/i,
      );
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => {
        child.stdout.write(JSON.stringify([row(10, 1, 10, 100)]));
        child.emit("close", 0);
      });
      return child;
    },
  });
  assert.equal((await telemetry.sample(10)).memory, 100);
  telemetry.close();
});

test("Windows CIM query deadline follows the configured overall timeout while reserving startup time", async () => {
  for (const [timeoutMs, seconds] of [
    [undefined, 3],
    [10000, 8],
    [1000, 1],
  ]) {
    const telemetry = createProcessTelemetry({
      platform: "win32",
      timeoutMs,
      spawnProcess: (_executable, args) => {
        const query = Buffer.from(args.at(-1), "base64").toString("utf16le");
        assert.equal(
          Number(query.match(/-OperationTimeoutSec (\d+)/)?.[1]),
          seconds,
        );
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        setImmediate(() => {
          child.stdout.write(JSON.stringify([row(10, 1, 10, 100)]));
          child.emit("close", 0);
        });
        return child;
      },
    });
    try {
      assert.equal((await telemetry.sample(10)).available, true);
    } finally {
      telemetry.close();
    }
  }
});

test(
  "Windows samples a real benign child tree and releases the collector cleanly",
  { skip: process.platform !== "win32", timeout: 90000 },
  async (t) => {
    const worker =
      "globalThis.memory=Buffer.alloc(32*1024*1024,7);setInterval(()=>{const until=Date.now()+35;while(Date.now()<until){}},100);";
    const script = `const {spawn}=require('node:child_process');globalThis.memory=Buffer.alloc(16*1024*1024,9);const child=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{windowsHide:true,stdio:'ignore'});child.on('error',()=>process.exit(2));process.stdin.on('data',()=>{child.once('exit',()=>process.exit(0));child.kill();});console.log('ready');`;
    const child = spawn(process.execPath, ["-e", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    // Real CIM startup can exceed ten seconds on a busy Windows host; mocked
    // collector tests above verify the short production timeout independently.
    const telemetry = createProcessTelemetry({ cacheMs: 0, timeoutMs: 30000 });
    t.after(async () => {
      telemetry.close();
      if (child.exitCode === null) child.stdin.write("stop\n");
      await exited;
    });
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code) reject(new Error(`Fixture exited ${code}`));
      });
    });
    const first = await telemetry.sample(child.pid);
    assert.equal(first.available, true, first.error);
    assert.ok(first.memory > 32 * 1024 * 1024);
    assert.ok(first.processCount >= 2);
    assert.equal(first.cpu, null);
    await pause(350);
    const second = await telemetry.sample(child.pid);
    assert.equal(second.available, true, second.error);
    assert.ok(
      second.cpu > 0 && second.cpu < 400,
      `Unexpected CPU ${second.cpu}`,
    );
    assert.ok(second.memory > 32 * 1024 * 1024);
  },
);
