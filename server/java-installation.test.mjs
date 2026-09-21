import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { createJavaInstallation } from "./java-installation.mjs";
import { containedSourcePath } from "./import.mjs";

const packageUrl =
  "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21/runtime.zip";
const safePath = (root, relative = "") =>
  relative ? containedSourcePath(root, relative) : fs.realpath(root);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const choice = {
  gameVersion: "1.21.1",
  provider: "neoforge",
  build: "21.1.250",
};
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Tiny stored ZIPs avoid downloading or executing a real runtime in these tests.
function zip(entries) {
  const chunks = [],
    central = [];
  let offset = 0;
  for (const [filename, value, mode = 0o100644] of entries) {
    const name = Buffer.from(filename),
      data = Buffer.from(value);
    const local = Buffer.alloc(30),
      row = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    row.writeUInt32LE(0x02014b50);
    row.writeUInt16LE(0x314, 4);
    row.writeUInt16LE(20, 6);
    row.writeUInt32LE(crc32(data), 16);
    row.writeUInt32LE(data.length, 20);
    row.writeUInt32LE(data.length, 24);
    row.writeUInt16LE(name.length, 28);
    row.writeUInt32LE((mode << 16) >>> 0, 38);
    row.writeUInt32LE(offset, 42);
    chunks.push(local, name, data);
    central.push(row, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

async function fixture(t, options = {}) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, "mc-java-install-test-"));
  const dataDir = path.join(root, "panel");
  await fs.mkdir(dataDir);
  const bytes =
    options.bytes ??
    zip([
      ["jdk-21/bin/java.exe", "synthetic Java executable, never executed"],
      ["jdk-21/release", 'JAVA_VERSION="21.0.1"'],
    ]);
  const metadata = [
    {
      vendor: "eclipse",
      version: { major: 21, openjdk_version: "21.0.1" },
      binary: {
        os: "windows",
        architecture: "x64",
        image_type: "jdk",
        jvm_impl: "hotspot",
        heap_size: "normal",
        project: "jdk",
        package: {
          name: "runtime.zip",
          size: bytes.length,
          checksum: sha256(bytes),
          link: packageUrl,
        },
      },
    },
  ];
  options.mutateMetadata?.(metadata);
  const requests = [],
    probes = [],
    requirements = [];
  const defaultResponse = (address) => {
    const url = new URL(address);
    if (url.origin === "https://api.adoptium.net")
      return new Response(JSON.stringify(metadata));
    assert.equal(
      address,
      packageUrl,
      "Unexpected network request must never use real fetch",
    );
    return new Response(bytes);
  };
  const service = createJavaInstallation({
    dataDir,
    safePath,
    platform: "win32",
    arch: "x64",
    requirement: async (input) => {
      requirements.push(input);
      return options.requirement
        ? options.requirement(input)
        : { requiredJavaVersion: 21 };
    },
    request: async (address, init) => {
      requests.push(address);
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal instanceof AbortSignal);
      assert.match(init.headers["User-Agent"], /MC-Panel/);
      return options.request
        ? options.request(address, init, defaultResponse)
        : defaultResponse(address);
    },
    probe: async (executable) => {
      probes.push(executable);
      assert.match(await fs.readFile(executable, "utf8"), /synthetic Java/);
      return {
        available: true,
        majorVersion: 21,
        version: "21.0.1",
        architecture: "amd64",
        path: executable,
        ...options.probeResult,
      };
    },
    ...options.service,
  });
  t.after(async () => {
    await service.close();
    // Only this unique fixture directory is eligible for recursive cleanup.
    assert.equal(path.dirname(root), temp);
    assert.ok(path.basename(root).startsWith("mc-java-install-test-"));
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    dataDir,
    service,
    bytes,
    metadata,
    requests,
    probes,
    requirements,
  };
}

async function settled(service, id) {
  const deadline = performance.now() + 15_000;
  let job;
  do {
    job = service.job(id);
    if (job.finishedAt) {
      await delay(0); // Let the active-job finalizer settle before a retry.
      return job;
    }
    await delay(25);
  } while (performance.now() < deadline);
  assert.fail(`Java installation did not settle: ${JSON.stringify(job)}`);
}

async function runtimeEntries(dataDir) {
  return fs.readdir(path.join(dataDir, "java-runtimes")).catch((cause) => {
    if (cause.code === "ENOENT") return [];
    throw cause;
  });
}

test("installs a verified official ZIP into private storage and reuses it without downloading again", async (t) => {
  const f = await fixture(t);
  assert.equal(f.service.support().installSupported, true);
  const queued = f.service.install(choice);
  assert.equal(queued.status, "queued");
  const job = await settled(f.service, queued.id);
  assert.equal(job.status, "completed", job.error);
  assert.equal(job.majorVersion, 21);
  assert.equal(job.downloadedBytes, f.bytes.length);
  assert.equal(job.totalBytes, f.bytes.length);
  assert.deepEqual(f.requirements, [choice]);
  const metadataRequest = new URL(f.requests[0]);
  assert.equal(metadataRequest.pathname, "/v3/assets/latest/21/hotspot");
  assert.equal(metadataRequest.searchParams.get("architecture"), "x64");
  assert.equal(metadataRequest.searchParams.get("os"), "windows");
  assert.equal(f.probes.length, 1);
  assert.match(
    f.probes[0],
    /[\\/]\.install-[^\\/]+[\\/]runtime[\\/]jdk-21[\\/]bin[\\/]java\.exe$/,
  );
  const names = await runtimeEntries(f.dataDir);
  assert.equal(names.length, 1);
  const destination = path.join(f.dataDir, "java-runtimes", names[0]);
  assert.equal(
    job.java.path,
    path.join(destination, "jdk-21", "bin", "java.exe"),
  );
  assert.match(await fs.readFile(job.java.path, "utf8"), /synthetic Java/);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(destination, "mc-panel-runtime.json")),
    ),
    {
      executable: "jdk-21/bin/java.exe",
      sha256: sha256(f.bytes),
      majorVersion: 21,
    },
  );
  queued.message = "A caller cannot mutate internal jobs";
  assert.notEqual(f.service.job(queued.id).message, queued.message);
  const retry = await settled(f.service, f.service.install(choice).id);
  assert.equal(retry.status, "completed", retry.error);
  assert.equal(retry.java.path, job.java.path);
  assert.equal(f.requests.filter((value) => value === packageUrl).length, 1);
  assert.equal(f.service.support().installJob.id, retry.id);
});

for (const damage of [
  "missing marker",
  "malformed marker",
  "mismatched marker",
  "unsafe executable marker",
  "missing executable",
]) {
  test(`repairs a managed runtime with a ${damage} without manual folder removal`, async (t) => {
    const f = await fixture(t);
    const initial = await settled(f.service, f.service.install(choice).id);
    assert.equal(initial.status, "completed", initial.error);
    const [name] = await runtimeEntries(f.dataDir);
    const destination = path.join(f.dataDir, "java-runtimes", name);
    const marker = path.join(destination, "mc-panel-runtime.json");
    if (damage === "missing marker") await fs.unlink(marker);
    if (damage === "malformed marker") await fs.writeFile(marker, "{broken");
    if (damage === "mismatched marker")
      await fs.writeFile(
        marker,
        JSON.stringify({
          sha256: "0".repeat(64),
          executable: "jdk-21/bin/java.exe",
          majorVersion: 21,
        }),
      );
    if (damage === "unsafe executable marker")
      await fs.writeFile(
        marker,
        JSON.stringify({
          sha256: sha256(f.bytes),
          executable: "../bin/java.exe",
          majorVersion: 21,
        }),
      );
    if (damage === "missing executable") await fs.unlink(initial.java.path);
    const repaired = await settled(f.service, f.service.install(choice).id);
    assert.equal(repaired.status, "completed", repaired.error);
    assert.equal(repaired.java.path, initial.java.path);
    assert.match(
      await fs.readFile(repaired.java.path, "utf8"),
      /synthetic Java/,
    );
    assert.equal(
      JSON.parse(await fs.readFile(marker, "utf8")).sha256,
      sha256(f.bytes),
    );
    assert.deepEqual(
      await runtimeEntries(f.dataDir),
      [name],
      "Successful repair must remove staging and quarantine.",
    );
    assert.equal(f.requests.filter((value) => value === packageUrl).length, 2);
  });
}

test("a failed repair download retains the original runtime files and can be retried", async (t) => {
  let failDownload = false;
  const f = await fixture(t, {
    request: (address, _init, normal) =>
      address === packageUrl && failDownload
        ? new Response("bad archive")
        : normal(address),
  });
  const initial = await settled(f.service, f.service.install(choice).id);
  const [name] = await runtimeEntries(f.dataDir);
  const marker = path.join(
    f.dataDir,
    "java-runtimes",
    name,
    "mc-panel-runtime.json",
  );
  await fs.writeFile(marker, "{broken");
  failDownload = true;
  const failed = await settled(f.service, f.service.install(choice).id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /checksum/);
  assert.equal(await fs.readFile(marker, "utf8"), "{broken");
  assert.match(await fs.readFile(initial.java.path, "utf8"), /synthetic Java/);
  assert.deepEqual(await runtimeEntries(f.dataDir), [name]);
  failDownload = false;
  assert.equal(
    (await settled(f.service, f.service.install(choice).id)).status,
    "completed",
  );
});

test("a failed replacement promotion restores the quarantined managed runtime", async (t) => {
  const f = await fixture(t);
  const initial = await settled(f.service, f.service.install(choice).id);
  const [name] = await runtimeEntries(f.dataDir);
  const destination = path.join(f.dataDir, "java-runtimes", name);
  const marker = path.join(destination, "mc-panel-runtime.json");
  await fs.writeFile(marker, "{damaged marker retained on rollback");
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === destination && /[\\/]\.install-[^\\/]+[\\/]runtime$/.test(from))
      throw Object.assign(new Error("promotion interrupted"), { code: "EIO" });
    return rename(from, to);
  });
  const failed = await settled(f.service, f.service.install(choice).id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /promotion interrupted/);
  assert.equal(
    await fs.readFile(marker, "utf8"),
    "{damaged marker retained on rollback",
  );
  assert.match(await fs.readFile(initial.java.path, "utf8"), /synthetic Java/);
  assert.deepEqual(await runtimeEntries(f.dataDir), [name]);
});

const failures = [
  {
    name: "checksum mismatch",
    mutateMetadata: (data) => {
      data[0].binary.package.checksum = "0".repeat(64);
    },
    error: /checksum/i,
  },
  {
    name: "incorrect advertised size",
    mutateMetadata: (data) => {
      data[0].binary.package.size++;
    },
    error: /checksum/i,
  },
  {
    name: "oversized download",
    mutateMetadata: (data) => {
      data[0].binary.package.size--;
    },
    error: /exceeded.*size/i,
  },
  {
    name: "path traversal",
    bytes: zip([
      ["../outside.exe", "bad"],
      ["jdk-21/bin/java.exe", "synthetic Java"],
    ]),
    error: /unsafe|invalid relative path/i,
  },
  {
    name: "archive symlink",
    bytes: zip([["jdk-21/bin/java.exe", "synthetic Java", 0o120777]]),
    error: /links|special files/i,
  },
  {
    name: "missing Java executable",
    bytes: zip([["jdk-21/release", "Java 21"]]),
    error: /single Java executable/i,
  },
  {
    name: "multiple Java executables",
    bytes: zip([
      ["jdk-21/bin/java.exe", "synthetic Java"],
      ["jdk-other/bin/java.exe", "synthetic Java"],
    ]),
    error: /single Java executable/i,
  },
  {
    name: "untrusted package link",
    mutateMetadata: (data) => {
      data[0].binary.package.link = "https://evil.example/runtime.zip";
    },
    error: /outside|official/i,
  },
  {
    name: "unofficial GitHub repository",
    mutateMetadata: (data) => {
      data[0].binary.package.link =
        "https://github.com/other/runtime/releases/download/v1/runtime.zip";
    },
    error: /official/i,
  },
  {
    name: "incorrect metadata Java major",
    mutateMetadata: (data) => {
      data[0].version.major = 17;
    },
    error: /verified Temurin ZIP/i,
  },
  {
    name: "incorrect metadata architecture",
    mutateMetadata: (data) => {
      data[0].binary.architecture = "aarch64";
    },
    error: /verified Temurin ZIP/i,
  },
  {
    name: "invalid metadata checksum",
    mutateMetadata: (data) => {
      data[0].binary.package.checksum = "not-a-checksum";
    },
    error: /verified Temurin ZIP/i,
  },
  {
    name: "wrong probed Java major",
    probeResult: { majorVersion: 17 },
    error: /Java 21 check/i,
    probes: 1,
  },
  {
    name: "wrong probed architecture",
    probeResult: { architecture: "aarch64" },
    error: /wrong architecture/i,
    probes: 1,
  },
];
for (const scenario of failures) {
  test(`rejects ${scenario.name} before promoting a runtime`, async (t) => {
    const f = await fixture(t, scenario);
    const job = await settled(f.service, f.service.install(choice).id);
    assert.equal(job.status, "failed");
    assert.match(job.error, scenario.error);
    assert.equal(f.probes.length, scenario.probes ?? 0);
    assert.deepEqual(await runtimeEntries(f.dataDir), []);
    assert.deepEqual(await fs.readdir(f.root), ["panel"]);
  });
}

test("rejects an unsafe download redirect before requesting its destination", async (t) => {
  const f = await fixture(t, {
    request: (address, _init, normal) =>
      address === packageUrl
        ? new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/runtime.zip" },
          })
        : normal(address),
  });
  const job = await settled(f.service, f.service.install(choice).id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /outside/);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await runtimeEntries(f.dataDir), []);
});

test("allows an official release-assets redirect and still verifies the original checksum", async (t) => {
  const destination =
    "https://release-assets.githubusercontent.com/github-production-release-asset/runtime.zip";
  const f = await fixture(t, {
    request: (address, _init, normal) =>
      address === packageUrl
        ? new Response(null, {
            status: 302,
            headers: { location: destination },
          })
        : normal(address === destination ? packageUrl : address),
  });
  const job = await settled(f.service, f.service.install(choice).id);
  assert.equal(job.status, "completed", job.error);
  assert.equal(f.requests.at(-1), destination);
});

test("coalesces identical active selections and rejects a different selection", async (t) => {
  const blocked = gate();
  const f = await fixture(t, {
    requirement: async () => {
      await blocked.promise;
      return { requiredJavaVersion: 21 };
    },
  });
  const first = f.service.install(choice);
  assert.equal(f.service.install({ ...choice }).id, first.id);
  assert.throws(() => f.service.install({ ...choice, gameVersion: "1.20.1" }), {
    status: 409,
  });
  blocked.resolve();
  const job = await settled(f.service, first.id);
  assert.equal(job.status, "completed", job.error);
  assert.equal(f.requests.filter((value) => value === packageUrl).length, 1);
});

test("shutdown interrupts a download, cleans staging, and allows a new service to retry", async (t) => {
  const entered = gate();
  const f = await fixture(t, {
    request: (address, { signal }, normal) => {
      if (address !== packageUrl) return normal(address);
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener(
              "abort",
              () => controller.error(signal.reason),
              { once: true },
            );
            controller.enqueue(new Uint8Array([0x50, 0x4b]));
            entered.resolve();
          },
        }),
      );
    },
  });
  const queued = f.service.install(choice);
  await entered.promise;
  await f.service.close();
  const failed = f.service.job(queued.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /interrupted/i);
  assert.deepEqual(await runtimeEntries(f.dataDir), []);
  assert.throws(() => f.service.install(choice), { status: 503 });
  const retryService = createJavaInstallation({
    dataDir: f.dataDir,
    safePath,
    platform: "win32",
    arch: "x64",
    requirement: async () => ({ requiredJavaVersion: 21 }),
    request: async (address) =>
      new Response(
        address === packageUrl ? f.bytes : JSON.stringify(f.metadata),
      ),
    probe: async () => ({
      available: true,
      majorVersion: 21,
      architecture: "amd64",
    }),
  });
  try {
    const retried = await settled(
      retryService,
      retryService.install(choice).id,
    );
    assert.equal(retried.status, "completed", retried.error);
  } finally {
    await retryService.close();
  }
});

test("fails missing Java requirement without downloading and permits retry", async (t) => {
  let attempt = 0;
  const f = await fixture(t, {
    requirement: async () => ({
      requiredJavaVersion: ++attempt === 1 ? null : 21,
    }),
  });
  const first = await settled(f.service, f.service.install(choice).id);
  assert.equal(first.status, "failed");
  assert.match(first.error, /could not confirm/i);
  assert.equal(f.requests.length, 0);
  const retry = await settled(f.service, f.service.install(choice).id);
  assert.equal(retry.status, "completed", retry.error);
});

test("unsupported hosts and invalid requests fail without any network requests", async (t) => {
  const f = await fixture(t, { service: { platform: "linux" } });
  assert.equal(f.service.support().installSupported, false);
  assert.throws(() => f.service.install(choice), { status: 400 });
  assert.throws(() => f.service.job("missing"), { status: 404 });
  assert.deepEqual(f.requests, []);
  const supported = await fixture(t);
  for (const input of [
    undefined,
    {},
    [],
    { gameVersion: "" },
    { gameVersion: "1.21.1", provider: {} },
  ])
    assert.throws(() => supported.service.install(input), { status: 400 });
  assert.deepEqual(supported.requests, []);
});
