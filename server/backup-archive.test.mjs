import assert from "node:assert/strict";
import fs from "node:fs";
import io from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackupArchive } from "./backup-archive.mjs";

test("a failed archive write waits for its active source file to close", async (t) => {
  const directory = await io.mkdtemp(
    path.join(os.tmpdir(), "mc-backup-stream-"),
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
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
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
