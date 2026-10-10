import { installedModVersionSatisfies } from "./launchpad-dependency-ranges.mjs";
import { launchpadError } from "./launchpad-network.mjs";

// Fabric allows numeric versions with any number of components. Keep this
// proof deliberately narrow: qualifiers and unfamiliar loader syntax cannot
// justify changing a required provider, but an identical retained version can.
// https://wiki.fabricmc.net/documentation:fabric_mod_json_spec#versionrange
export function updateDependencySatisfies(version, range, loader) {
  if (["forge", "neoforge"].includes(loader))
    return installedModVersionSatisfies(version, range);
  if (typeof version !== "string" || !version || version.includes("${"))
    return false;
  if (Array.isArray(range))
    return (
      range.every((value) => typeof value === "string") &&
      range.some((value) => updateDependencySatisfies(version, value, loader))
    );
  if (typeof range !== "string" || range.length > 4096) return false;
  if (range === "*" || range === version || range === `=${version}`)
    return true;
  if (!/^\d+(?:\.\d+){0,31}$/.test(version)) return false;
  const actual = version.split(".").map(BigInt);
  const compare = (expected) => {
    for (
      let index = 0;
      index < Math.max(actual.length, expected.length);
      index++
    ) {
      const left = actual[index] ?? 0n,
        right = expected[index] ?? 0n;
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  };
  return range
    .trim()
    .split(/\s+/)
    .every((part) => {
      const match =
        /^(>=|<=|>|<|=|\^|~)?(\d+(?:\.\d+){0,31})(\.(?:x|X|\*)(?:\.(?:x|X|\*))*)?$/.exec(
          part,
        );
      if (!match) return false;
      const [, operator = "=", numeric, wildcard] = match;
      const expected = numeric.split(".").map(BigInt),
        order = compare(expected);
      if (wildcard)
        return (
          operator === "=" &&
          expected.length <= 2 &&
          expected.every((value, index) => value === (actual[index] ?? 0n))
        );
      if (operator === "^" || operator === "~") {
        // Quilt has its own range grammar; only shared comparisons are proved.
        if (loader !== "fabric" || (operator === "~" && expected.length < 2))
          return false;
        const width = operator === "^" ? 1 : Math.min(2, expected.length);
        return (
          order >= 0 &&
          expected
            .slice(0, width)
            .every((value, index) => value === (actual[index] ?? 0n))
        );
      }
      return {
        "=": order === 0,
        ">": order > 0,
        "<": order < 0,
        ">=": order >= 0,
        "<=": order <= 0,
      }[operator];
    });
}

export function assertUpdatedModDependencies(before, after, affected, loader) {
  const providers = new Map(),
    requirements = new Map();
  for (const row of after) {
    for (const value of row.providers ?? []) {
      if (!providers.has(value.id)) providers.set(value.id, []);
      providers.get(value.id).push(value.version);
    }
    for (const requirement of row.requirements ?? []) {
      if (
        !affected.has(requirement.id) ||
        !row.required?.includes(requirement.id)
      )
        continue;
      if (!requirements.has(requirement.id))
        requirements.set(requirement.id, []);
      requirements.get(requirement.id).push({ ...requirement, row });
    }
  }
  for (const [id, constraints] of requirements) {
    const versions = providers.get(id) ?? [];
    const compatible = versions.some((version) =>
      constraints.every(({ range, row }) => {
        if (updateDependencySatisfies(version, range, loader)) return true;
        // Retaining a known identical version cannot introduce a new conflict
        // for an unchanged dependent, even when its range syntax is unsupported.
        const previousVersions = before
          .flatMap((previous) => previous.providers ?? [])
          .filter((value) => value.id === id);
        return (
          before.includes(row) &&
          typeof version === "string" &&
          previousVersions.length > 0 &&
          previousVersions.every((value) => value.version === version)
        );
      }),
    );
    if (compatible) continue;
    const details = constraints.map(
      ({ row, range }) =>
        `${row.title || row.path} (${row.path}) requires ${id} ${range === undefined ? "with an unverified version requirement" : JSON.stringify(range)}`,
    );
    throw launchpadError(
      409,
      `These updates cannot satisfy required mod dependencies: ${details.join("; ")}. The resulting installed versions are ${versions.map((version) => version ?? "unknown").join(", ") || "missing"}. Choose compatible updates and review again.`,
    );
  }
}
