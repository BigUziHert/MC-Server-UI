import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Only a recent terminal outcome is retained; active jobs cannot resume after
// restart and must never be presented as if work were still running.
export async function terminalJobs(
  filename,
  {
    onError = (cause) =>
      console.warn(
        `[Minecraft] Installation history could not be saved: ${cause.message}`,
      ),
  } = {},
) {
  let saved = null,
    queue = Promise.resolve();
  try {
    const value = JSON.parse(await fs.readFile(filename, "utf8"));
    if (["completed", "failed"].includes(value?.status)) saved = value;
  } catch (cause) {
    if (cause.code !== "ENOENT" && !(cause instanceof SyntaxError)) throw cause;
  }
  const persist = () => {
    const content = JSON.stringify(saved);
    queue = queue
      .catch(() => {})
      .then(async () => {
        const temporary = `${filename}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, content, { flag: "wx" });
          await fs.rename(temporary, filename);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      })
      .catch((cause) => {
        try {
          onError(cause);
        } catch {}
        throw cause;
      });
    return queue;
  };
  return {
    get: () => saved,
    visible: (job = saved) =>
      !!job &&
      !job.dismissed &&
      (!["completed", "failed"].includes(job.status) ||
        Date.now() - Date.parse(job.finishedAt) < 600_000),
    async save(job) {
      saved = { ...job };
      await persist();
    },
    async dismiss(id) {
      if (saved?.id === id) {
        saved.dismissed = true;
        await persist();
      }
    },
    // History persistence is best effort. Shutdown must still stop the game
    // process even when its disk is full or the history file is locked.
    flush: () => queue.catch(() => {}),
  };
}
