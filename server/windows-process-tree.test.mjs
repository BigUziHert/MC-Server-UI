import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { createWindowsProcessTree } from "./windows-process-tree.mjs";

const ticks = (milliseconds) =>
  (621355968000000000n + BigInt(milliseconds) * 10000n).toString();
const row = (pid, parentPid, milliseconds) => ({
  pid,
  parentPid,
  createdAt: ticks(milliseconds),
});
function fixture(options = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 100,
    exitCode: null,
    signalCode: null,
  });
  let rows = [row(100, 50, 1000), row(101, 100, 1100), row(102, 101, 1200)];
  const kills = [];
  let clockReads = 0;
  const tracker = createWindowsProcessTree(child, {
    startedAt: 1000,
    now: () => (++clockReads === 1 ? 1001 : 500 + clockReads * 500),
    readSnapshot: async () => rows,
    killProcesses: async (identities) => {
      kills.push(identities.map((identity) => identity.pid));
      rows = [];
    },
    ...options,
  });
  return {
    child,
    tracker,
    kills,
    setRows: (value) => {
      rows = value;
    },
  };
}

test("a fresh complete snapshot resolves a helper failure after the owned tree has exited", async () => {
  let f;
  f = fixture({
    killProcesses: async () => {
      f.child.emit("exit", 0);
      f.setRows([]);
      throw new Error("taskkill 255");
    },
  });
  await f.tracker.terminate();
  f.tracker.dispose();
  assert.equal(f.child.listenerCount("exit"), 0);
});

test("a partial termination retains orphan identities and finds descendants across an intermediate exit", async () => {
  const kills = [];
  let attempt = 0,
    f;
  f = fixture({
    killProcesses: async (identities) => {
      kills.push(identities.map((identity) => identity.pid));
      if (++attempt === 1) {
        f.child.emit("exit", 0);
        f.setRows([row(102, 101, 1200), row(103, 101, 1250)]);
        throw new Error("access denied");
      }
      f.setRows([]);
    },
  });
  await assert.rejects(
    f.tracker.terminate(),
    /PID 102, 103.*Try Force Stop again/,
  );
  await f.tracker.terminate();
  assert.deepEqual(kills, [
    [102, 101, 100],
    [103, 102],
  ]);
  f.tracker.dispose();
});

test("PID reuse excludes the replacement root and its newer descendants", async () => {
  let f;
  f = fixture({
    killProcesses: async () => {
      f.child.emit("exit", 0);
      f.setRows([row(100, 50, 2000), row(105, 100, 2100)]);
    },
  });
  await f.tracker.terminate();
  f.tracker.dispose();
});

test("a reused intermediate PID cannot claim its replacement or replacement children", async () => {
  const kills = [];
  let attempt = 0,
    f;
  f = fixture({
    killProcesses: async (identities) => {
      kills.push(identities.map((identity) => identity.pid));
      if (++attempt === 1) {
        f.child.emit("exit", 0);
        f.setRows([
          row(101, 50, 2000),
          row(104, 101, 1400),
          row(105, 101, 2100),
        ]);
      } else f.setRows([row(101, 50, 2000), row(105, 101, 2100)]);
    },
  });
  await assert.rejects(f.tracker.terminate(), /PID 104/);
  await f.tracker.terminate();
  assert.deepEqual(kills, [[102, 101, 100], [104]]);
  f.tracker.dispose();
});

test("an unavailable query never becomes an empty tree, and verification can be retried", async () => {
  let reads = 0;
  const kills = [];
  const f = fixture({
    readSnapshot: async () => {
      if (++reads === 1 || reads === 3) throw new Error("CIM unavailable");
      if (reads === 2) return [row(100, 50, 1000)];
      return [];
    },
    killProcesses: async (identities) => {
      kills.push(identities.map((identity) => identity.pid));
    },
  });
  await assert.rejects(f.tracker.terminate(), /CIM unavailable/);
  assert.deepEqual(kills, []);
  await assert.rejects(f.tracker.terminate(), /CIM unavailable/);
  await f.tracker.terminate();
  assert.deepEqual(kills, [[100]]);
  f.tracker.dispose();
});

test("an unseen intermediate PID reuse cannot adopt unrelated orphan descendants", async () => {
  const kills = [];
  let f;
  f = fixture({
    killProcesses: async (rows) => {
      kills.push(rows.map((row) => row.pid));
      f.child.emit("exit", 0);
      f.setRows([row(105, 101, 4000)]);
    },
  });
  await assert.rejects(
    f.tracker.terminate(),
    /could not be safely identified.*PID 105/,
  );
  await assert.rejects(
    f.tracker.terminate(),
    /could not be safely identified.*PID 105/,
  );
  assert.deepEqual(kills, [[102, 101, 100]]);
  f.setRows([]);
  await f.tracker.terminate();
  f.tracker.dispose();
});

test("late-born ambiguous descendants block confirmation and remain tracked after another parent exits", async () => {
  const kills = [];
  let f;
  f = fixture({
    killProcesses: async (rows) => {
      kills.push(rows.map((row) => row.pid));
      f.child.emit("exit", 0);
      f.setRows([row(103, 101, 1600), row(104, 103, 1700)]);
    },
  });
  await assert.rejects(
    f.tracker.terminate(),
    /could not be safely identified.*PID 103, 104/,
  );
  f.setRows([row(105, 104, 1800)]);
  await assert.rejects(
    f.tracker.terminate(),
    /could not be safely identified.*PID 105/,
  );
  assert.deepEqual(kills, [[102, 101, 100]]);
  f.setRows([]);
  await f.tracker.terminate();
  f.tracker.dispose();
});

test("the original root remains identifiable when exit arrives during the snapshot", async () => {
  let f,
    reads = 0;
  f = fixture({
    readSnapshot: async () => {
      if (++reads === 1) {
        f.child.emit("exit", 0);
        return [row(100, 50, 1000), row(101, 100, 1100)];
      }
      return [];
    },
  });
  await f.tracker.terminate();
  assert.deepEqual(f.kills, [[101, 100]]);
  f.tracker.dispose();
});

test("malformed or duplicate process identities cannot confirm absence", async () => {
  for (const rows of [
    null,
    {},
    [row(100, 50, 1000), { pid: 101, parentPid: 100 }],
    [row(100, 50, 1000), row(100, 50, 1000)],
  ]) {
    const f = fixture({ readSnapshot: async () => rows });
    await assert.rejects(
      f.tracker.terminate(),
      /invalid process list|incomplete process identities/,
    );
    assert.deepEqual(f.kills, []);
    f.tracker.dispose();
  }
});

test("root exit before the initial snapshot cannot bless an ambiguous recycled root", async () => {
  const f = fixture();
  f.child.emit("exit", 0);
  f.setRows([row(100, 50, 1001), row(103, 100, 1100)]);
  await assert.rejects(
    f.tracker.terminate(),
    /exited before its process tree could be identified/,
  );
  assert.deepEqual(f.kills, []);
  f.tracker.dispose();
});

test("a root outside the spawn interval is never killed", async () => {
  const f = fixture();
  f.setRows([row(100, 50, 2000), row(101, 100, 2100)]);
  await assert.rejects(
    f.tracker.terminate(),
    /exited before its process tree could be identified/,
  );
  assert.deepEqual(f.kills, []);
  f.tracker.dispose();
});

test("helper commands are hidden, bounded, and hold a handle before identity checking", async () => {
  const scripts = [];
  const helpers = [];
  const child = Object.assign(new EventEmitter(), { pid: 100 });
  const tracker = createWindowsProcessTree(child, {
    startedAt: 1000,
    now: () => 1001,
    spawnProcess: (executable, args, options) => {
      assert.match(
        executable,
        /System32\\WindowsPowerShell\\v1.0\\powershell.exe$/,
      );
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, false);
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      scripts.push(script);
      const helper = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {},
      });
      helpers.push(helper);
      setImmediate(() => {
        const result = script.includes("$process.Kill()")
          ? { failures: [] }
          : { processes: scripts.length === 1 ? [row(100, 50, 1000)] : [] };
        helper.stdout.write(JSON.stringify(result));
        helper.emit("close", 0);
      });
      return helper;
    },
  });
  await tracker.terminate();
  const killer = scripts.find((script) => script.includes("$process.Kill()"));
  assert.ok(
    killer.indexOf("$process.Handle") < killer.indexOf("$process.StartTime"),
  );
  assert.ok(
    killer.indexOf("$process.StartTime") < killer.indexOf("$process.Kill()"),
  );
  assert.match(killer, /Floor\(\[decimal\].*Ticks \/ 10\)/);
  assert.match(killer, /finally.*Dispose/);
  assert.equal(helpers.length, 3);
  tracker.dispose();
});

test("a hung inspection helper times out and is terminated", async () => {
  let stopped = false;
  const f = fixture({
    readSnapshot: undefined,
    timeoutMs: 10,
    spawnProcess: () =>
      Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
          stopped = true;
        },
      }),
  });
  await assert.rejects(f.tracker.terminate(), /inspection timed out/);
  assert.equal(stopped, true);
  f.tracker.dispose();
});

test(
  "real Windows handle termination retries an orphan without affecting an unrelated process",
  { skip: process.platform !== "win32", timeout: 45000 },
  async (t) => {
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { windowsHide: true, stdio: "ignore" },
    );
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,detached:true,stdio:'ignore'});child.unref();console.log(child.pid);setInterval(()=>{},1000);`,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let descendantPid;
    let rejectFirstKill = true;
    const tracker = createWindowsProcessTree(child, {
      startedAt,
      timeoutMs: 15000,
      spawnProcess: (executable, args, options) => {
        const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        if (script.includes("$process.Kill()") && rejectFirstKill) {
          rejectFirstKill = false;
          args = [
            ...args.slice(0, -1),
            Buffer.from(
              "throw 'Simulated initial failure'",
              "utf16le",
            ).toString("base64"),
          ];
        }
        return spawn(executable, args, options);
      },
    });
    t.after(async () => {
      await tracker.terminate().catch(() => {});
      tracker.dispose();
      child.kill();
      unrelated.kill();
    });
    descendantPid = Number(
      (await once(child.stdout, "data"))[0].toString().trim(),
    );
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 4);
    await assert.rejects(tracker.terminate(), /Try Force Stop again/);
    const exited = once(child, "exit");
    child.kill();
    await exited;
    assert.doesNotThrow(() => process.kill(descendantPid, 0));
    await tracker.terminate();
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  },
);
