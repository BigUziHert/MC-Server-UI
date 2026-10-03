import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const absent = (cause) => cause.code === "ENOENT";
const activeTransactions = new Set();
const liveProcess = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause.code === "EPERM";
  }
};
async function hash(target) {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Recovery requires regular files.");
  const handle = await fs.open(target, "r");
  try {
    const digest = createHash("sha512");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      digest.update(chunk);
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

// Originals are copied and synced before the journal authorizes any mutation.
// Recovery never removes unknown bytes: ambiguous states remain blocked until
// the operator restores the reviewed originals using the retained copies.
export async function createLaunchpadRecovery({
  privatePath,
  serverDir,
  safePath,
  applyConfiguration,
  getConfiguration,
}) {
  const target = await privatePath("transaction.json");
  let record = null;
  try {
    record = JSON.parse(await fs.readFile(target, "utf8"));
  } catch (cause) {
    if (!absent(cause)) throw cause;
  }
  if (
    record &&
    (activeTransactions.has(target) ||
      (record.ownerPid !== process.pid && liveProcess(record.ownerPid)))
  )
    throw Object.assign(
      new Error(
        "Another panel process still owns this installation. Close it before recovering this server.",
      ),
      { status: 409 },
    );
  async function write(value) {
    const temporary = await privatePath(`${randomUUID()}.journal.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    record = value;
  }
  async function walk(relative = "", directories = []) {
    const result = [];
    for (const name of await fs.readdir(await safePath(serverDir, relative))) {
      const child = relative ? `${relative}/${name}` : name;
      const stat = await fs.lstat(await safePath(serverDir, child));
      if (stat.isSymbolicLink())
        throw new Error(
          "Linked content cannot be included in installation recovery.",
        );
      if (stat.isDirectory()) {
        directories.push(child);
        result.push(...(await walk(child, directories)));
      } else if (stat.isFile()) result.push(child);
      else
        throw new Error(
          "Special files cannot be included in installation recovery.",
        );
    }
    return result;
  }
  async function begin({
    job,
    planId,
    files,
    originals,
    receipts,
    configuration,
    wholeRoot = false,
  }) {
    if (record)
      throw new Error("An interrupted installation needs recovery first.");
    const directory = `recovery-${randomUUID()}`;
    const backup = await privatePath(directory);
    await fs.mkdir(backup);
    const saved = [];
    const directories = [];
    const paths = wholeRoot
      ? await walk("", directories)
      : [...new Set(originals)];
    const stage = /^[a-f0-9-]{36}$/.test(planId ?? "")
      ? await fs.lstat(await privatePath(planId)).catch(() => null)
      : null;
    try {
      for (const relative of paths) {
        const source = await safePath(serverDir, relative);
        const sha512 = await hash(source);
        const name = `${saved.length}.original`;
        const copy = await safePath(backup, name);
        await fs.copyFile(source, copy, 1);
        const handle = await fs.open(copy, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        if ((await hash(copy)) !== sha512 || (await hash(source)) !== sha512)
          throw new Error(
            "An original changed while preparing installation recovery.",
          );
        saved.push({ path: relative, sha512, backup: name });
      }
      await write({
        version: 1,
        ownerPid: process.pid,
        state: "prepared",
        job,
        planId,
        directory,
        originals: saved,
        directories,
        files,
        receipts,
        configuration,
        wholeRoot,
        stageIdentity: stage
          ? { ino: stage.ino, dev: stage.dev, birthtimeMs: stage.birthtimeMs }
          : null,
      });
      activeTransactions.add(target);
    } catch (cause) {
      if (!record) await fs.rm(backup, { recursive: true, force: true });
      throw cause;
    }
  }
  async function clear() {
    const previous = record;
    await fs.rm(target, { force: true });
    record = null;
    activeTransactions.delete(target);
    if (previous?.directory && /^recovery-[a-f0-9-]+$/.test(previous.directory))
      await fs
        .rm(await privatePath(previous.directory), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
    if (previous?.stageIdentity && /^[a-f0-9-]{36}$/.test(previous.planId)) {
      const stage = await privatePath(previous.planId);
      const current = await fs.lstat(stage).catch(() => null);
      if (
        current?.isDirectory() &&
        !current.isSymbolicLink() &&
        current.ino === previous.stageIdentity.ino &&
        current.dev === previous.stageIdentity.dev &&
        current.birthtimeMs === previous.stageIdentity.birthtimeMs
      )
        await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }
  async function reconcile() {
    if (!record) return null;
    if (
      record.version !== 1 ||
      !Array.isArray(record.originals) ||
      !Array.isArray(record.files) ||
      !/^recovery-[a-f0-9-]+$/.test(record.directory)
    )
      throw new Error(
        "Installation recovery record is invalid. Preserve Launchpad storage for manual recovery.",
      );
    if (record.state === "committed") return { record, committed: true };
    const originals = new Map(
      record.originals.map((file) => [file.path, file]),
    );
    const outputs = new Map(record.files.map((file) => [file.path, file]));
    const paths = new Set([...originals.keys(), ...outputs.keys()]);
    const backup = await privatePath(record.directory);
    for (const original of originals.values())
      if (
        (await hash(await safePath(backup, original.backup))) !==
        original.sha512
      )
        throw new Error(
          "An installation recovery copy changed. Restore originals from Recycle Bin and retry recovery.",
        );
    if (record.wholeRoot)
      for (const relative of await walk())
        if (!paths.has(relative))
          throw new Error(
            `Preserved externally added file: ${relative}. Move it aside before retrying recovery.`,
          );
    const current = new Map();
    for (const relative of paths) {
      let digest;
      try {
        digest = await hash(await safePath(serverDir, relative));
      } catch (cause) {
        if (!absent(cause)) throw cause;
        digest = null;
      }
      current.set(relative, digest);
      if (
        digest &&
        digest !== originals.get(relative)?.sha512 &&
        digest !== outputs.get(relative)?.sha512
      )
        throw new Error(
          `Preserved changed file: ${relative}. Restore its original from Recycle Bin or the retained recovery folder, then retry recovery.`,
        );
    }
    // The whole snapshot has been checked before removing any known output.
    for (const [relative, digest] of current) {
      const original = originals.get(relative);
      if (digest && digest !== original?.sha512) {
        const destination = await safePath(serverDir, relative);
        if ((await hash(destination)) !== digest)
          throw new Error(`File changed during recovery: ${relative}.`);
        await fs.unlink(destination);
      }
      if (original && digest !== original.sha512) {
        const parent = path.posix.dirname(relative);
        await fs.mkdir(
          await safePath(serverDir, parent === "." ? "" : parent),
          { recursive: true },
        );
        const destination = await safePath(serverDir, relative);
        await fs.copyFile(
          await safePath(backup, original.backup),
          destination,
          1,
        );
        if ((await hash(destination)) !== original.sha512)
          throw new Error(`Recovery verification failed: ${relative}.`);
      }
    }
    for (const relative of record.directories ?? [])
      await fs.mkdir(await safePath(serverDir, relative), { recursive: true });
    if (
      record.configuration &&
      (!getConfiguration ||
        Object.entries(record.configuration).some(
          ([key, value]) =>
            JSON.stringify(getConfiguration()[key]) !== JSON.stringify(value),
        ))
    )
      await applyConfiguration(record.configuration);
    return { record, committed: false };
  }
  return {
    begin,
    clear,
    reconcile,
    release: () => activeTransactions.delete(target),
    get: () => record,
    commit: () => write({ ...record, state: "committed" }),
  };
}
