import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Snapshots stay in private panel storage, never in downloadable server archives.
export function runtimeSnapshot(configuration, installed) {
  const { status, address, settingsRevision, ...settings } = configuration;
  return JSON.parse(
    JSON.stringify({ version: 1, configuration: settings, installed }),
  );
}

export async function restoreSnapshotRecords(
  snapshot,
  dataDir,
  safePath,
  applyConfiguration,
) {
  if (
    snapshot?.version !== 1 ||
    !snapshot.configuration ||
    !Array.isArray(snapshot.installed)
  )
    throw Object.assign(
      new Error("This backup has no valid runtime snapshot."),
      { status: 409 },
    );
  const directory = await safePath(dataDir, "launchpad");
  await fs.mkdir(directory, { recursive: true });
  const target = await safePath(directory, "installed.json");
  const temporary = await safePath(directory, `installed.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(snapshot.installed, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, target);
    await applyConfiguration(snapshot.configuration);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
