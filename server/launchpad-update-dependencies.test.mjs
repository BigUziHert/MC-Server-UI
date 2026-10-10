import test from "node:test";
import assert from "node:assert/strict";
import {
  assertUpdatedModDependencies,
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
  assertUpdatedModDependencies(before, after, new Set(["library"]), loader);

test("dependency update proof supports loader-specific ranges and rejects unknown expressions", () => {
  for (const [version, range, loader, expected] of [
    ["2.0", "[1,2)", "neoforge", false],
    ["1.5", "[1,2)", "forge", true],
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

test("an alternate bundled provider must satisfy all retained required ranges", () => {
  const addon = dependent("[1,2)"),
    old = provider("1"),
    replacement = provider("2");
  assert.throws(
    () => check([addon, old], [addon, replacement]),
    /Addon.*library.*\[1,2\)/,
  );
  assert.throws(
    () => check([addon, old, replacement], [addon, replacement]),
    /Addon.*library/,
  );
  assert.throws(() => check([addon, old], [addon]), /missing/);
  assert.doesNotThrow(() =>
    check(
      [addon, old],
      [addon, replacement, provider("1.5", "mods/bundle.jar")],
    ),
  );
  const second = { ...dependent("[2,3)"), path: "mods/second-addon.jar" };
  assert.throws(
    () =>
      check(
        [addon, second, old],
        [addon, second, replacement, provider("1.5", "mods/bundle.jar")],
      ),
    /required mod dependencies/,
  );
});

test("unknown ranges only preserve an unchanged dependent's known provider version", () => {
  const addon = dependent("[1.0-beta,)"),
    old = provider("1.1-beta");
  assert.doesNotThrow(() => check([addon, old], [addon, provider("1.1-beta")]));
  assert.throws(
    () => check([addon, old], [addon, provider("1.2-beta")]),
    /requires library/,
  );
  assert.throws(
    () => check([addon, old], [{ ...addon }, provider("1.1-beta")]),
    /requires library/,
  );
  assert.throws(
    () => check([addon, provider(undefined)], [addon, provider(undefined)]),
    /requires library/,
  );
});
