import fs from "node:fs/promises";
import nativeFs from "node:fs";
import path from "node:path";
import { createPanel } from "../index.mjs";
import { restoreBackupArchive } from "../backup-restore.mjs";

const [mode, dataDir, serverDir, archive] = process.argv.slice(2);
const exit = () => process.exit(71);
const rename = fs.rename.bind(fs);
let published = false;
const writeFile = fs.writeFile.bind(fs);
fs.writeFile = async (target, ...args) => {
  if (
    mode === "backup-history-failure" &&
    published &&
    String(target).includes("panel.json.")
  )
    throw new Error("Injected backup history persistence failure");
  return writeFile(target, ...args);
};
fs.rename = async (source, target) => {
  if (mode === "restore-before-first" && source === serverDir) exit();
  if (mode === "restore-before-second" && path.basename(source) === "restored")
    exit();
  if (mode === "backup-before-publish" && source.endsWith(".tar.gz.tmp"))
    exit();
  await rename(source, target);
  if (source.endsWith(".tar.gz.tmp")) published = true;
  if (mode === "restore-after-first" && source === serverDir) exit();
  if (mode === "restore-after-second" && path.basename(source) === "restored")
    exit();
  if (mode === "backup-after-publish" && source.endsWith(".tar.gz.tmp")) exit();
};
const rm = fs.rm.bind(fs);
fs.rm = async (target, ...args) => {
  await rm(target, ...args);
  if (mode === "restore-cleanup" && path.basename(target) === "previous")
    exit();
};
if (["backup-partial", "backup-open"].includes(mode)) {
  const open = nativeFs.open.bind(nativeFs);
  const outputs = new Set();
  nativeFs.open = (file, ...args) => {
    const callback = args.pop();
    open(file, ...args, (cause, fd) => {
      if (!cause && String(file).endsWith(".tar.gz.tmp")) outputs.add(fd);
      if (
        !cause &&
        String(file).endsWith(".tar.gz.tmp") &&
        mode === "backup-open"
      )
        exit();
      callback(cause, fd);
    });
  };
  for (const name of ["write", "writev"]) {
    const original = nativeFs[name].bind(nativeFs);
    nativeFs[name] = (fd, ...args) => {
      if (!outputs.has(fd)) return original(fd, ...args);
      const callback = args.pop();
      return original(fd, ...args, (cause, ...values) => {
        if (!cause) exit();
        callback(cause, ...values);
      });
    };
  }
}
if (mode.startsWith("restore-")) {
  await restoreBackupArchive(serverDir, archive);
} else {
  const panel = await createPanel({
    dataDir,
    serverDir,
    scheduler: false,
    publicAddress: { resolve: async () => null },
  });
  const listener = panel.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  await fetch(`http://127.0.0.1:${listener.address().port}/api/backups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Interrupted backup" }),
  });
}
if (mode === "backup-history-failure" && published) exit();
process.exit(72);
