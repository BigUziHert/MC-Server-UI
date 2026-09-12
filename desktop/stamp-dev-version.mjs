import fs from "node:fs/promises";

export function devVersion(version, runNumber, runAttempt) {
  const base = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version)?.[1];
  if (
    !base ||
    !/^[1-9]\d*$/.test(runNumber || "") ||
    !/^[1-9]\d*$/.test(runAttempt || "")
  )
    throw new Error(
      "A dev release needs a valid base version and GitHub run number/attempt.",
    );
  return `${base}-dev.${runNumber}.${runAttempt}`;
}

if (process.argv.includes("--write")) {
  if (process.env.GITHUB_REF !== "refs/heads/dev")
    throw new Error("Only dev can produce update releases.");
  const target = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await fs.readFile(target, "utf8"));
  pkg.version = devVersion(
    pkg.version,
    process.env.GITHUB_RUN_NUMBER,
    process.env.GITHUB_RUN_ATTEMPT,
  );
  await fs.writeFile(target, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`Building MC Panel ${pkg.version}`);
}
