import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import io from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as tar from "tar";
import { createBackupArchive } from "./backup-archive.mjs";

async function fixture(t) {
  const directory = await io.realpath(
    await io.mkdtemp(path.join(os.tmpdir(), "mc-backup-stream-")),
  );
  const serverDir = path.join(directory, "server");
  const destination = path.join(directory, "backup.tar.gz");
  await io.mkdir(serverDir);
  t.after(async () => {
    assert.equal(path.dirname(directory), await io.realpath(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("mc-backup-stream-"));
    await io.rm(directory, { recursive: true, force: true });
  });
  return { directory, serverDir, destination };
}

async function largeFile(filename, random = false) {
  const handle = await io.open(filename, "w");
  try {
    const chunk = random
      ? randomBytes(1024 * 1024)
      : Buffer.alloc(1024 * 1024, 37);
    for (let index = 0; index < 20; index++) await handle.write(chunk);
  } finally {
    await handle.close();
  }
}

async function hash(filename) {
  const digest = createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}

test("large files stream with real progress and preserve portable archive contents", async (t) => {
  const { directory, serverDir, destination } = await fixture(t);
  const longName = `${"long-".repeat(23)}世界-é.dat`;
  await io.mkdir(path.join(serverDir, "nested", "empty"), { recursive: true });
  await io.writeFile(
    path.join(serverDir, "nested", longName),
    "unicode path contents",
  );
  await io.writeFile(path.join(serverDir, "empty.dat"), "");
  await largeFile(path.join(serverDir, "compressible.dat"));
  await largeFile(path.join(serverDir, "random.dat"), true);
  await io.link(
    path.join(serverDir, "random.dat"),
    path.join(serverDir, "hardlink.dat"),
  );
  await io.writeFile(path.join(serverDir, "session.lock"), "excluded");
  const outside = path.join(directory, "outside");
  await io.mkdir(outside);
  await io.writeFile(
    path.join(outside, "secret.txt"),
    "excluded linked contents",
  );
  await io.symlink(outside, path.join(serverDir, "linked"), "junction");
  const snapshots = [];
  const metadata = await createBackupArchive(serverDir, destination, {
    onProgress: (progress) => snapshots.push(progress),
  });
  const expectedBytes =
    60 * 1024 * 1024 + Buffer.byteLength("unicode path contents");
  assert.equal(metadata.originalSize, expectedBytes);
  assert.equal(metadata.compressionLevel, 9);
  const final = snapshots.at(-1);
  assert.equal(final.totalFiles, 5);
  assert.equal(final.processedFiles, 5);
  assert.equal(final.totalBytes, expectedBytes);
  assert.equal(final.processedBytes, expectedBytes);
  assert.equal(final.compressedBytes, (await io.stat(destination)).size);
  assert.deepEqual(
    [...new Set(snapshots.map((item) => item.phase))],
    ["scanning", "archiving", "finalizing"],
  );
  assert.ok(
    snapshots.some(
      (item) =>
        item.phase === "archiving" &&
        item.processedBytes > 0 &&
        item.processedBytes < item.totalBytes &&
        item.currentFile,
    ),
  );
  for (let index = 1; index < snapshots.length; index++) {
    assert.ok(
      snapshots[index].processedBytes >= snapshots[index - 1].processedBytes,
    );
    assert.ok(
      snapshots[index].compressedBytes >= snapshots[index - 1].compressedBytes,
    );
  }
  const unpack = path.join(directory, "unpacked");
  await io.mkdir(unpack);
  await tar.x({ file: destination, cwd: unpack });
  for (const name of [
    "compressible.dat",
    "random.dat",
    "hardlink.dat",
    "empty.dat",
    path.join("nested", longName),
  ])
    assert.equal(
      await hash(path.join(serverDir, name)),
      await hash(path.join(unpack, name)),
    );
  assert.ok(
    (await io.stat(path.join(unpack, "nested", "empty"))).isDirectory(),
  );
  for (const omitted of ["session.lock", "linked"])
    await assert.rejects(io.stat(path.join(unpack, omitted)), {
      code: "ENOENT",
    });
});

test("cancel under output backpressure closes handles without reading the whole file", async (t) => {
  const { serverDir, destination } = await fixture(t);
  const source = path.join(serverDir, "large.dat");
  await largeFile(source, true);
  const controller = new AbortController();
  const sourceRead = Promise.withResolvers();
  const outputBlocked = Promise.withResolvers();
  const original = {
    open: fs.open,
    read: fs.read,
    write: fs.write,
    close: fs.close,
  };
  let sourceFd;
  let outputFd;
  let bytesRead = 0;
  let sourceClosed = false;
  let outputClosed = false;
  let releaseWrite;
  t.after(() => {
    releaseWrite?.();
    t.mock.restoreAll();
  });
  t.mock.method(fs, "open", (...args) => {
    const callback = args.at(-1);
    const filename = path.resolve(args[0]);
    args[args.length - 1] = (cause, fd) => {
      if (!cause && filename === source) sourceFd = fd;
      if (!cause && filename === destination) outputFd = fd;
      callback(cause, fd);
    };
    return original.open(...args);
  });
  t.mock.method(fs, "read", (...args) => {
    if (args[0] !== sourceFd) return original.read(...args);
    const callback = args.at(-1);
    args[args.length - 1] = (cause, bytes, buffer) => {
      bytesRead += bytes ?? 0;
      sourceRead.resolve();
      callback(cause, bytes, buffer);
    };
    return original.read(...args);
  });
  t.mock.method(fs, "write", (...args) => {
    if (args[0] !== outputFd || releaseWrite) return original.write(...args);
    releaseWrite = () => {
      releaseWrite = undefined;
      args.at(-1)(null, args[3], args[1]);
    };
    outputBlocked.resolve();
  });
  t.mock.method(fs, "close", (fd, callback) =>
    original.close(fd, (cause) => {
      if (!cause && fd === sourceFd) sourceClosed = true;
      if (!cause && fd === outputFd) outputClosed = true;
      callback(cause);
    }),
  );
  let settled = false;
  const backup = createBackupArchive(serverDir, destination, {
    signal: controller.signal,
  });
  backup.then(
    () => (settled = true),
    () => (settled = true),
  );
  await Promise.all([sourceRead.promise, outputBlocked.promise]);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    settled,
    false,
    "Cancellation waits for the pending write to close.",
  );
  releaseWrite();
  await assert.rejects(backup, { name: "AbortError" });
  assert.equal(sourceClosed, true);
  assert.equal(outputClosed, true);
  assert.ok(
    bytesRead <= 3 * 256 * 1024,
    `Read ${bytesRead} bytes despite cancellation.`,
  );
});

test("cancel during scanning never creates an archive", async (t) => {
  const { serverDir, destination } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    createBackupArchive(serverDir, destination, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    { name: "AbortError" },
  );
  await assert.rejects(io.stat(destination), { code: "ENOENT" });
});

test("a caller's cancellation reason is preserved", async (t) => {
  const { serverDir, destination } = await fixture(t);
  const controller = new AbortController();
  const reason = Object.assign(new Error("Canceled by the server owner"), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
  controller.abort(reason);
  await assert.rejects(
    createBackupArchive(serverDir, destination, { signal: controller.signal }),
    (cause) => cause === reason,
  );
  await assert.rejects(io.stat(destination), { code: "ENOENT" });
});

for (const size of [1, 512 * 1024]) {
  test(`a source resized to ${size} bytes during reading fails the archive`, async (t) => {
    const { serverDir, destination } = await fixture(t);
    const source = path.join(serverDir, "changing.dat");
    await io.writeFile(source, Buffer.alloc(384 * 1024, 17));
    const originalRead = fs.read;
    let resized = false;
    t.mock.method(fs, "read", (...args) => {
      if (!resized) {
        resized = true;
        fs.truncateSync(source, size);
      }
      return originalRead(...args);
    });
    await assert.rejects(
      createBackupArchive(serverDir, destination),
      /changed during backup/,
    );
    assert.equal(resized, true);
    t.mock.restoreAll();
    await io.unlink(source);
    await io.unlink(destination);
  });
}

test("a scanned directory replaced by a junction cannot escape the server folder", async (t) => {
  const { directory, serverDir, destination } = await fixture(t);
  const nested = path.join(serverDir, "nested");
  const outside = path.join(directory, "outside");
  await io.mkdir(nested);
  await io.mkdir(outside);
  await io.writeFile(path.join(nested, "data.dat"), "source");
  await io.writeFile(path.join(outside, "data.dat"), "secret");
  let replaced = false;
  await assert.rejects(
    createBackupArchive(serverDir, destination, {
      onProgress: ({ phase }) => {
        if (phase !== "archiving" || replaced) return;
        replaced = true;
        fs.renameSync(nested, path.join(serverDir, "moved"));
        fs.symlinkSync(outside, nested, "junction");
      },
    }),
    /changed during backup/,
  );
});

test("a failed archive write waits for its active source file to close", async (t) => {
  const directory = await io.realpath(
    await io.mkdtemp(path.join(os.tmpdir(), "mc-backup-stream-")),
  );
  const serverDir = path.join(directory, "server");
  const source = path.join(serverDir, "world.dat");
  const destination = path.join(directory, "backup.tar.gz");
  await io.mkdir(serverDir);
  await io.writeFile(source, "world contents");
  let releaseRead;
  t.after(async () => {
    releaseRead?.();
    t.mock.restoreAll();
    assert.equal(path.dirname(directory), await io.realpath(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("mc-backup-stream-"));
    await io.rm(directory, { recursive: true, force: true });
  });

  let sourceFd;
  let outputFd;
  let sourceClosed = false;
  const sourceRead = Promise.withResolvers();
  const writeFailed = Promise.withResolvers();
  const original = {
    open: fs.open,
    read: fs.read,
    write: fs.write,
    close: fs.close,
  };
  t.mock.method(fs, "open", (...args) => {
    const callback = args.at(-1);
    const filename = path.resolve(args[0]);
    args[args.length - 1] = (cause, fd) => {
      if (!cause && filename === source) sourceFd = fd;
      if (!cause && filename === destination) outputFd = fd;
      callback(cause, fd);
    };
    return original.open(...args);
  });
  t.mock.method(fs, "read", (...args) => {
    if (args[0] !== sourceFd || releaseRead) return original.read(...args);
    const callback = args.at(-1);
    args[args.length - 1] = (...result) => {
      releaseRead = () => callback(...result);
      sourceRead.resolve();
    };
    return original.read(...args);
  });
  const diskFull = Object.assign(new Error("Simulated full backup disk"), {
    code: "ENOSPC",
  });
  t.mock.method(fs, "write", (...args) => {
    if (args[0] !== outputFd) return original.write(...args);
    sourceRead.promise.then(() => {
      args.at(-1)(diskFull);
      writeFailed.resolve();
    });
  });
  t.mock.method(fs, "close", (fd, callback) =>
    original.close(fd, (cause) => {
      if (!cause && fd === sourceFd) sourceClosed = true;
      callback(cause);
    }),
  );

  let settled = false;
  const backup = createBackupArchive(serverDir, destination);
  backup.then(
    () => (settled = true),
    () => (settled = true),
  );
  await writeFailed.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    settled,
    false,
    "archive failure must wait for the source reader",
  );
  assert.equal(sourceClosed, false);
  releaseRead();
  releaseRead = undefined;
  await assert.rejects(backup, (cause) => cause === diskFull);
  assert.equal(sourceClosed, true);
});
