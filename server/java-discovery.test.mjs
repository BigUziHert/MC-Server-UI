import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  compatibleJava,
  createJavaDiscovery,
  findJavaCandidates,
  probeJava,
} from "./java-discovery.mjs";

async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "mc-java-discovery-"));
  t.after(async () => {
    assert.equal(path.dirname(root), temporary);
    assert.ok(path.basename(root).startsWith("mc-java-discovery-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const create = async (directory) => {
    const home = path.join(root, directory);
    await fs.mkdir(path.join(home, "bin"), { recursive: true });
    const executable = path.join(
      home,
      "bin",
      process.platform === "win32" ? "java.exe" : "java",
    );
    await fs.writeFile(executable, "Not executed: Java discovery fixture");
    return { home, executable };
  };
  return { root, create };
}

test("discovery finds PATH, environment, and nested launcher runtimes while ignoring a deleted JAVA_HOME", async (t) => {
  const f = await fixture(t);
  const system = await f.create("system JDK");
  const jdk = await f.create(".jdks/jdk21");
  const bundled = await f.create(
    "launcher/runtime/java-runtime-delta/windows-x64/java-runtime-delta",
  );
  const candidates = await findJavaCandidates({
    preferredPath: path.join(f.root, "deleted jdk/bin/java.exe"),
    homeDir: f.root,
    env: {
      JAVA_HOME: path.join(f.root, "deleted jdk"),
      JDK_HOME: jdk.home,
      PATH: path.dirname(system.executable),
    },
    roots: [path.join(f.root, "launcher")],
    registryHomes: async () => [],
  });
  assert.deepEqual(
    candidates.sort(),
    [system.executable, jdk.executable, bundled.executable].sort(),
  );
});

test("discovery respects root depth instead of searching arbitrary application directories", async (t) => {
  const f = await fixture(t);
  const shallow = await f.create("jdk");
  await f.create("unrelated/deep/other/runtime");
  const candidates = await findJavaCandidates({
    env: {},
    homeDir: f.root,
    roots: [{ directory: f.root, depth: 2 }],
  });
  assert.deepEqual(candidates, [shallow.executable]);
});

test("validated discovery drops failed probes, deduplicates launch shims, caches and refreshes", async (t) => {
  const f = await fixture(t);
  const installed = await f.create("jdk21");
  const shim = await f.create("shim");
  await fs.writeFile(
    path.join(installed.home, "release"),
    'IMPLEMENTOR="Test vendor"\nOS_ARCH="amd64"\n',
  );
  let scans = 0,
    probes = 0;
  const discover = createJavaDiscovery({
    findCandidates: async () => {
      scans++;
      return [installed.executable, shim.executable, "deleted-java"];
    },
    probe: async (candidate) => {
      probes++;
      if (candidate === "deleted-java")
        return { path: candidate, available: false };
      return {
        available: true,
        path: candidate,
        version: "21.0.6",
        majorVersion: 21,
        home: installed.home,
      };
    },
  });
  const [first, shared] = await Promise.all([discover(), discover()]);
  assert.deepEqual(shared, first);
  assert.equal(first.length, 1);
  assert.equal(first[0].path, installed.executable);
  assert.equal(first[0].vendor, "Test vendor");
  assert.equal(first[0].architecture, "amd64");
  await discover();
  assert.equal(scans, 1);
  assert.equal(probes, 3);
  await discover({ refresh: true });
  assert.equal(scans, 2);
});

test("Java compatibility requires the supported major and excludes 32-bit runtimes", () => {
  const java = { available: true, majorVersion: 21, architecture: "amd64" };
  assert.equal(compatibleJava(java, 21), true);
  assert.equal(compatibleJava(java, 17), false);
  assert.equal(compatibleJava({ ...java, majorVersion: 26 }, 21), false);
  assert.equal(compatibleJava({ ...java, majorVersion: 8 }, 8), true);
  assert.equal(compatibleJava({ ...java, architecture: "i586" }, 21), false);
  assert.equal(compatibleJava({ ...java, available: false }, 21), false);
});

test("Java properties identify the real runtime and do not mistake OpenJDK 64-Bit for a Java version", async () => {
  const result = await probeJava("java", {
    spawnProcess: (_path, args, options) => {
      assert.deepEqual(args, ["-XshowSettings:properties", "-version"]);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stderr.write(
          'Property settings:\n    java.home = C:\\Java21\n    java.vendor = Microsoft\n    java.version = 21.0.7\n    java.vm.name = OpenJDK 64-Bit Server VM\n    os.arch = amd64\nopenjdk version "21.0.7"\n',
        );
        child.emit("close", 0);
      });
      return child;
    },
  });
  assert.equal(result.majorVersion, 21);
  assert.equal(result.vendor, "Microsoft");
  assert.equal(result.home, "C:\\Java21");
  assert.equal(result.architecture, "amd64");
});

test("a nonresponsive Java probe terminates and names the executable", async () => {
  let killed = false;
  const result = await probeJava("hung-java", {
    timeoutMs: 5,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.kill = () => {
        killed = true;
      };
      return child;
    },
  });
  assert.equal(killed, true);
  assert.equal(result.available, false);
  assert.match(result.error, /hung-java.*did not respond/);
});
