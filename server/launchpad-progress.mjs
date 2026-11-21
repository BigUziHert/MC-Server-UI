// One forward-only progress value for a Launchpad installation job.
//
// Downloads take nearly all of the time, so they fill most of the bar by
// bytes. Content then fills the rest as each file is installed. Modpacks also
// download their server software before a single clean-install step.
const SCALE = 1000;
const WEIGHTS = {
  content: { download: 0.9, runtime: 0, install: 0.1 },
  modpack: { download: 0.6, runtime: 0.3, install: 0.1 },
};

export function createInstallProgress(job, files, { modpack = false } = {}) {
  const weights = WEIGHTS[modpack ? "modpack" : "content"];
  const known = files
    .map((file) => file.size)
    .filter((size) => Number.isSafeInteger(size) && size > 0);
  // A file without a declared size still counts, as an average-sized file.
  const fallback = known.length
    ? known.reduce((sum, size) => sum + size, 0) / known.length
    : 1;
  const expected = files.map((file) =>
    Number.isSafeInteger(file.size) && file.size > 0 ? file.size : fallback,
  );
  const expectedTotal = expected.reduce((sum, size) => sum + size, 0);
  const received = new Array(files.length).fill(0);
  let receivedTotal = 0,
    runtime = 0,
    install = 0,
    reported = 0;
  const publish = () => {
    const download = expectedTotal ? receivedTotal / expectedTotal : 1;
    const value = Math.floor(
      SCALE *
        (weights.download * download +
          weights.runtime * runtime +
          weights.install * install) +
        1e-6, // Weighted sums such as 0.6 + 0.15 land just below a whole step.
    );
    reported = Math.min(SCALE, Math.max(reported, value));
    job.progress = { completed: reported, total: SCALE };
  };
  const setReceived = (index, bytes) => {
    const next = Math.min(Math.max(0, bytes), expected[index] ?? 0);
    receivedTotal += next - received[index];
    received[index] = next;
    publish();
  };
  publish();
  return {
    downloaded: (index, bytes) => setReceived(index, bytes),
    staged: (index) => setReceived(index, expected[index] ?? 0),
    runtime: (completed, total) => {
      if (!(Number.isSafeInteger(total) && total > 0)) return;
      runtime = Math.min(1, Math.max(runtime, completed / total));
      publish();
    },
    installed: (completed, total) => {
      install = total > 0 ? Math.min(1, completed / total) : 1;
      publish();
    },
    finish: () => {
      for (let index = 0; index < files.length; index++)
        received[index] = expected[index];
      receivedTotal = expectedTotal;
      runtime = 1;
      install = 1;
      publish();
    },
  };
}
