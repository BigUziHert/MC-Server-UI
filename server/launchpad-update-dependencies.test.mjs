import test from "node:test";
import assert from "node:assert/strict";
import {
  updatedModDependencyWarnings,
  updateDependencySatisfies,
} from "./launchpad-update-dependencies.mjs";

const provider = (version, path = "mods/library.jar") => ({
  path,
  providers: [{ id: "library", version }],
});
const dependent = (range) => ({
  path: "mods/addon.jar",
  title: "Addon",
  required: ["library"],
  requirements: [{ id: "library", range }],
});
const check = (before, after, loader = "neoforge") =>
  updatedModDependencyWarnings(before, after, new Set(["library"]), loader);

test("dependency update proof supports loader-specific ranges and rejects unknown expressions", () => {
  for (const [version, range, loader, expected] of [
    ["2.0", "[1,2)", "neoforge", false],
    ["1.5", "[1,2)", "forge", true],
    ["1.21.1-3.7.2", "[1.21-3.6.4,)", "neoforge", true],
    ["1.21.1-3.7.2", "[1.21-3.6.4,]", "neoforge", true],
    ["1.21.1-3.7.2", "[1.21-3.6.4,]", "forge", true],
    ["1.21-3.6.3", "[1.21-3.6.4,]", "neoforge", false],
    ["1.21.1-3.7.2", "[1.21-3.1.0c,)", "forge", true],
    ["1.21.1-3.7.2", "[1.21.1-3.7.3,)", "neoforge", false],
    ["2.0-beta", "[2.0,)", "neoforge", false],
    ["1.5", ">=1 <2", "fabric", true],
    ["2", ">=1 <2", "fabric", false],
    ["0.9", "^0.1", "fabric", true],
    ["1.9", "^0.1", "fabric", false],
    ["1.2.9", "~1.2.0", "fabric", true],
    ["1.3", "~1.2.0", "fabric", false],
    ["1.2.9", "1.2.x", "fabric", true],
    ["1.3", "1.2.*", "fabric", false],
    ["2.5", ["1.*", ">=2 <3"], "fabric", true],
    ["3", ["1.*", ">=2 <3"], "fabric", false],
    ["2", ">=1 <3", "quilt", true],
    ["2.0-beta", ">=1", "fabric", false],
    ["2.0-beta", "2.0-beta", "fabric", true],
    ["2.0", "unknown", "fabric", false],
    ["2.0", "", "fabric", false],
  ])
    assert.equal(
      updateDependencySatisfies(version, range, loader),
      expected,
      `${loader} ${version} ${range}`,
    );
});

test("an alternate bundled provider warns unless it satisfies all retained required ranges", () => {
  const addon = dependent("[1,2)"),
    old = provider("1"),
    replacement = provider("2");
  assert.match(
    check([addon, old], [addon, replacement])[0],
    /Addon.*library.*\[1,2\)/,
  );
  assert.match(
    check([addon, old, replacement], [addon, replacement])[0],
    /Addon.*library/,
  );
  assert.match(check([addon, old], [addon])[0], /missing/);
  assert.deepEqual(
    check(
      [addon, old],
      [addon, replacement, provider("1.5", "mods/bundle.jar")],
    ),
    [],
  );
  const second = { ...dependent("[2,3)"), path: "mods/second-addon.jar" };
  assert.match(
    check(
      [addon, second, old],
      [addon, second, replacement, provider("1.5", "mods/bundle.jar")],
    )[0],
    /required mod dependencies/,
  );
});

test("unknown ranges only preserve an unchanged dependent's known provider version", () => {
  const addon = dependent("unsupported range"),
    old = provider("1.1-beta");
  assert.deepEqual(check([addon, old], [addon, provider("1.1-beta")]), []);
  assert.match(
    check([addon, old], [addon, provider("1.2-beta")])[0],
    /requires library/,
  );
  assert.match(
    check([addon, old], [{ ...addon }, provider("1.1-beta")])[0],
    /requires library/,
  );
  assert.match(
    check([addon, provider(undefined)], [addon, provider(undefined)])[0],
    /requires library/,
  );
});

test("dependency conflicts return actionable warnings for every affected dependency", () => {
  const addon = {
    path: "mods/addon.jar",
    title: "Addon",
    required: ["library", "helper"],
    requirements: [{ id: "library", range: "[1,2)" }, { id: "helper" }],
  };
  const warnings = updatedModDependencyWarnings(
    [addon, provider("1")],
    [addon, provider("2")],
    new Set(["library", "helper"]),
    "neoforge",
  );
  assert.deepEqual(warnings, [
    'These updates may not satisfy required mod dependencies: Addon (mods/addon.jar) requires library "[1,2)". The resulting installed versions of library are 2. You can install anyway, but the server may fail to start or mods may not work correctly.',
    "These updates may not satisfy required mod dependencies: Addon (mods/addon.jar) requires helper with an unverified version requirement. The resulting installed versions of helper are missing. You can install anyway, but the server may fail to start or mods may not work correctly.",
  ]);
});

test("the Supplementaries update accepts Moonlight satisfying all three installed mod ranges", () => {
  const addons = [
    [
      "Amendments",
      "mods/amendments-1.21-2.1.11-neoforge.jar",
      "[1.21.1-3.1.0c,)",
    ],
    ["Vista", "mods/vista-1.21.1-5.5.7-neoforge.jar", "[1.21-3.4.0,)"],
    [
      "Supplementaries",
      "mods/supplementaries-1.21.1-4.0.2-neoforge.jar",
      "[1.21.1-3.6.4,]",
    ],
  ].map(([title, path, range]) => ({
    title,
    path,
    required: ["moonlight"],
    requirements: [{ id: "moonlight", range }],
  }));
  const moonlight = (version) => ({
    path: "mods/moonlight.jar",
    providers: [{ id: "moonlight", version }],
  });
  assert.deepEqual(
    updatedModDependencyWarnings(
      [...addons, moonlight("1.21.1-3.7.1")],
      [...addons, moonlight("1.21.1-3.7.2")],
      new Set(["moonlight"]),
      "neoforge",
    ),
    [],
  );
});
