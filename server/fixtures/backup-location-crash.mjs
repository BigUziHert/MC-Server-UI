import path from "node:path";
import { createBackupLocation } from "../backup-location.mjs";

const [dataDir, destination] = process.argv.slice(2);
if (!dataDir || !destination || !process.send)
  throw new Error(
    "This fixture requires its isolated storage paths and an IPC parent.",
  );

const store = await createBackupLocation({
  dataDir,
  defaultDirectory: path.join(dataDir, "backups"),
  forbiddenDirectories: async () => [dataDir],
  hooks: {
    async afterCommit() {
      // The new location has been durably committed, but no original archive
      // has been removed. Only the parent can advance this fixture, by killing
      // this process without giving migration catch/finally handlers a turn.
      setInterval(() => {}, 60_000);
      await new Promise((resolve, reject) => {
        process.send({ checkpoint: "afterCommit" }, (cause) =>
          cause ? reject(cause) : resolve(),
        );
      });
      await new Promise(() => {});
    },
  },
});
const review = await store.preview(destination);
await store.begin(destination, review.revision).promise;
throw new Error(
  "The crash fixture unexpectedly finished without being killed.",
);
