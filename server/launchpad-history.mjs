import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{128}$/;
const copyName = /^\d+\.original$/;
const failure = (message) => Object.assign(new Error(message), { status: 409 });
const relative = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !/[\\:\x00-\x1f]/.test(value) &&
  !value.startsWith("/") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
const clone = (value) => structuredClone(value);
const validId = (id) => {
  if (typeof id !== "string" || !uuid.test(id))
    throw failure("Choose a valid Launchpad history entry.");
  return id;
};
const validate = (record) => {
  validId(record?.jobId);
  if (
    record.version !== 1 ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.kind !== "string" ||
    record.kind.length > 100 ||
    typeof record.title !== "string" ||
    record.title.length > 1000 ||
    (record.undoneAt !== undefined &&
      !Number.isFinite(Date.parse(record.undoneAt))) ||
    !Array.isArray(record.receipts) ||
    !Array.isArray(record.afterReceipts)
  )
    throw failure(
      "Launchpad history metadata is invalid. Retained recovery files were preserved.",
    );
  for (const key of ["written", "originals", "recycled"]) {
    if (!Array.isArray(record[key]) || record[key].length > 100000)
      throw failure("Launchpad history has an invalid file list.");
    const paths = new Set();
    for (const item of record[key]) {
      if (
        !item ||
        !relative(item.path) ||
        paths.has(item.path) ||
        (key === "recycled"
          ? !uuid.test(item.id)
          : !digest.test(item.sha512)) ||
        (key === "originals" && !copyName.test(item.backup))
      )
        throw failure(
          "Launchpad history contains an invalid saved path or checksum.",
        );
      paths.add(item.path);
    }
  }
  return record;
};

// Published entries are self-contained: the transaction journal can be cleared
// only after these verified originals and their manifest are durable.
export async function createLaunchpadHistory({
  privatePath,
  safePath,
  fileHash,
}) {
  const root = await privatePath("history");
  let writes = Promise.resolve();
  const serialize = (work) => {
    const next = writes.catch(() => {}).then(work);
    writes = next.catch(() => {});
    return next;
  };
  const directory = (id) => safePath(root, validId(id));
  const regularHash = async (file) => {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw failure("Launchpad history requires ordinary files without links.");
    return fileHash(file);
  };
  const syncFile = async (file) => {
    const handle = await fs.open(file, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  const writeManifest = async (folder, record) => {
    const temporary = await safePath(folder, `${randomUUID()}.tmp`);
    const text = JSON.stringify(validate(record));
    if (Buffer.byteLength(text) > 32 * 1024 ** 2)
      throw failure(
        "This Launchpad history entry is too large to retain safely.",
      );
    try {
      await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      await syncFile(temporary);
      await fs.rename(temporary, await safePath(folder, "entry.json"));
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  };
  const read = async (id) => {
    validId(id);
    let file;
    try {
      const folder = await directory(id);
      file = await fs.open(await safePath(folder, "entry.json"), "r");
    } catch (cause) {
      if (cause.code === "ENOENT") return null;
      throw cause;
    }
    try {
      if ((await file.stat()).size > 32 * 1024 ** 2)
        throw failure("Saved Launchpad history is too large to read safely.");
      const record = validate(JSON.parse(await file.readFile("utf8")));
      if (record.jobId !== id)
        throw failure("Launchpad history identity changed.");
      return record;
    } finally {
      await file.close();
    }
  };
  const list = async () => {
    const entries = await fs
      .readdir(root, { withFileTypes: true })
      .catch((cause) => {
        if (cause.code === "ENOENT") return [];
        throw cause;
      });
    const records = [];
    for (const entry of entries) {
      if (
        !uuid.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      )
        continue;
      const record = await read(entry.name);
      if (record) records.push(record);
    }
    return records.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        b.jobId.localeCompare(a.jobId),
    );
  };
  const discard = async (id) => {
    if (!(await read(id))) return;
    const folder = await directory(id);
    const stat = await fs.lstat(folder);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      path.dirname(folder) !== root
    )
      throw failure(
        "The saved history folder changed. Recovery files were preserved.",
      );
    await fs.rm(folder, { recursive: true });
  };
  return {
    async get(id) {
      await writes;
      return clone(await read(id));
    },
    async list() {
      await writes;
      return clone((await list()).slice(0, 30));
    },
    async source(record, original) {
      const current = await read(validId(record?.jobId));
      const saved = current?.originals.find(
        (item) =>
          item.path === original?.path &&
          item.sha512 === original?.sha512 &&
          item.backup === original?.backup,
      );
      if (!saved)
        throw failure(
          "The requested recovery copy is not part of this saved job.",
        );
      const file = await safePath(await directory(current.jobId), saved.backup);
      if ((await regularHash(file)) !== saved.sha512)
        throw failure(
          "The saved recovery copy changed. Current server files were preserved.",
        );
      return file;
    },
    save(input, recoveryRecord) {
      return serialize(async () => {
        validId(input?.jobId);
        if (
          !/^recovery-[a-f0-9-]{36}$/.test(recoveryRecord?.directory ?? "") ||
          !Array.isArray(recoveryRecord.originals)
        )
          throw failure(
            "A verified installation recovery record is required before saving history.",
          );
        const record = validate({
          version: 1,
          ...clone(input),
          createdAt: new Date().toISOString(),
          originals: recoveryRecord.originals.map((original, index) => ({
            path: original.path,
            sha512: original.sha512,
            backup: `${index}.original`,
          })),
        });
        if (await read(record.jobId))
          throw failure(
            "This Launchpad job already has a saved history entry.",
          );
        await fs.mkdir(root, { recursive: true });
        const final = await directory(record.jobId);
        const temporary = await safePath(root, `.pending-${randomUUID()}`);
        await fs.mkdir(temporary);
        const originalRoot = await privatePath(recoveryRecord.directory);
        let published = false;
        try {
          for (let index = 0; index < record.originals.length; index++) {
            const original = recoveryRecord.originals[index];
            if (!copyName.test(original.backup))
              throw failure("Invalid original recovery copy name.");
            const source = await safePath(originalRoot, original.backup);
            if ((await regularHash(source)) !== original.sha512)
              throw failure(
                "An original recovery copy changed before history could be saved.",
              );
            const destination = await safePath(
              temporary,
              record.originals[index].backup,
            );
            await fs.copyFile(source, destination, 1);
            await syncFile(destination);
            if (
              (await regularHash(destination)) !== original.sha512 ||
              (await regularHash(source)) !== original.sha512
            )
              throw failure(
                "An original changed while saving Launchpad history.",
              );
          }
          await writeManifest(temporary, record);
          await fs.rename(temporary, final);
          published = true;
        } finally {
          if (!published) {
            if (
              path.dirname(temporary) !== root ||
              !/^\.pending-[a-f0-9-]{36}$/.test(path.basename(temporary))
            )
              throw failure(
                "Invalid temporary history folder. Recovery files were preserved.",
              );
            await fs
              .rm(temporary, { recursive: true, force: true })
              .catch(() => {});
          }
        }
        // Retention runs only after the caller commits its installation journal.
        // A saved entry can still be rolled back; it must not evict older undo.
        return clone(record);
      });
    },
    markUndone(id) {
      return serialize(async () => {
        const record = await read(id);
        if (!record)
          throw failure("This Launchpad history entry was not found.");
        if (!record.undoneAt) {
          record.undoneAt = new Date().toISOString();
          await writeManifest(await directory(id), record);
        }
        return clone(record);
      });
    },
    discard: (id) => serialize(() => discard(id)),
    prune: () =>
      serialize(async () => {
        for (const old of (await list()).slice(30)) await discard(old.jobId);
      }),
  };
}
