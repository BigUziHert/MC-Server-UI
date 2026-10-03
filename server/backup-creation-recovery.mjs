import fs from "node:fs/promises";
import path from "node:path";
import {
  assertInactiveOwner,
  optionalStat,
  sameIdentity,
  syncDirectory,
} from "./backup-journal.mjs";
import { validateBackupArchive } from "./backup-restore.mjs";

// Only journal-owned files are inspected or removed; unrelated archives are
// never silently adopted. Commit history before removing the recovery record.
export async function reconcileBackupCreations({
  directory,
  backupDir,
  commit,
}) {
  for (const name of (await fs.readdir(directory)).filter((name) =>
    /^[0-9a-f-]{36}\.json$/.test(name),
  )) {
    const journal = path.join(directory, name);
    const journalStat = await fs.lstat(journal);
    if (!journalStat.isFile() || journalStat.isSymbolicLink())
      throw Object.assign(
        new Error(
          `Backup recovery journal changed at ${journal}. Files were preserved.`,
        ),
        { status: 409 },
      );
    const record = JSON.parse(await fs.readFile(journal, "utf8"));
    const id = name.slice(0, -5);
    if (record.version !== 1 || record.job?.id !== id)
      throw Object.assign(
        new Error(
          `Invalid backup recovery journal at ${journal}. Files were preserved.`,
        ),
        { status: 409 },
      );
    assertInactiveOwner(record, journal);
    const target = path.join(backupDir, `${id}.tar.gz`);
    const temporary = `${target}.tmp`;
    let item;
    let message =
      "The backup was interrupted before publication. No completed archive was retained.";
    try {
      const published = await optionalStat(target);
      const pending = await optionalStat(temporary);
      if (
        record.phase === "ready" &&
        record.item?.id === id &&
        (published || pending)
      ) {
        const candidate = published ?? pending;
        const candidatePath = published ? target : temporary;
        if (
          !candidate.isFile() ||
          !sameIdentity(candidate, record.output) ||
          candidate.size !== record.item.size ||
          (published && pending)
        )
          throw new Error("The archive identity changed.");
        await validateBackupArchive(candidatePath);
        if (!published) {
          await fs.rename(temporary, target);
          await syncDirectory(backupDir);
        }
        item = record.item;
        message =
          "The completed archive was recovered after an interrupted backup.";
      } else if (published) {
        throw new Error(
          "An unexpected published archive occupies the destination.",
        );
      } else if (pending) {
        if (!pending.isFile() || !sameIdentity(pending, record.output))
          throw new Error(
            "The incomplete archive identity cannot be confirmed.",
          );
        await fs.rm(temporary);
        await syncDirectory(backupDir);
      }
    } catch (cause) {
      message = `The backup was interrupted. Files were preserved for recovery at ${target} and ${temporary}. ${cause.message}`;
    }
    const job = {
      ...record.job,
      status: item ? "completed" : "failed",
      phase: "resuming",
      cancellable: false,
      currentFile: null,
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ...(item ? { backupId: id } : { error: message }),
    };
    await commit(item, job, message);
    // Preserve ambiguous records so another restart also exposes the recovery
    // location and never treats an unresolved artifact as ordinary unowned data.
    if (!message.includes("Files were preserved")) await fs.rm(journal);
  }
}
