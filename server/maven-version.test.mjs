import test from "node:test";
import assert from "node:assert/strict";
import { mavenVersion, compareMavenVersions } from "./maven-version.mjs";

const compare = (left, right) =>
  compareMavenVersions(mavenVersion(left), mavenVersion(right));

test("mod versions follow NeoForge's Maven 3.8 ordering, including Minecraft prefixes", () => {
  // Expected comparisons verified with org.apache.maven:maven-artifact:3.8.5,
  // the version used by NeoForge's FML 4 loader for Minecraft 1.21.1.
  for (const [left, right, expected] of [
    ["1.21.1-3.7.2", "1.21-3.6.4", 1],
    ["1.21.1-3.7.2", "1.21-3.4.0", 1],
    ["1.21.1-3.7.2", "1.21-3.1.0c", 1],
    ["1.21.1-3.7.2", "1.21.1-3.7.3", -1],
    ["1.21.1-3.7.2", "1.21.1-3.10c", -1],
    ["1.21.1-3.7.2", "1.21-3.10c", 1],
    ["1.21-3.1.0b", "1.21-3.1.0c", -1],
    ["1.0", "1.0-1", -1],
    ["1.0-1", "1.0.1", -1],
    ["1.0.0.X1", "1.0.0-X2", 1],
    ["1.0.X2", "1.0-X1", 1],
    ["1-foo2", "1-foo10", -1],
    ["1.0.0-0.0.0", "1", 0],
    ["01.002.000", "1.2", 0],
    ["9007199254740993", "9007199254740992", 1],
    ["1.0+build1", "1.0", 1],
    ["1.0_build1", "1.0", 1],
    ["1.0+build1", "1.0+build2", -1],
    ["1.0-0.alpha", "1.0", -1],
    ["1.0-0.1", "1.0", 1],
  ]) {
    assert.equal(compare(left, right), expected, `${left} / ${right}`);
    assert.equal(compare(right, left) || 0, -expected || 0);
  }
});

test("Maven qualifiers retain prerelease ordering, aliases and numeric suffixes", () => {
  const ordered = [
    "1-alpha",
    "1-alpha2",
    "1-alpha10",
    "1-beta",
    "1-milestone",
    "1-rc",
    "1-snapshot",
    "1",
    "1-sp",
    "1-foo",
    "1-zoo",
    "1-1",
  ];
  for (let index = 1; index < ordered.length; index++)
    assert.equal(compare(ordered[index - 1], ordered[index]), -1);
  for (const [left, right] of [
    ["1-a1", "1-alpha-1"],
    ["1-b2", "1-beta2"],
    ["1-m3", "1-milestone3"],
    ["1-cr1", "1-rc1"],
    ["1-FINAL", "1"],
    ["1-ga", "1"],
    ["1-release", "1"],
    ["1.0-alpha1", "1.0-ALPHA1"],
  ])
    assert.equal(compare(left, right), 0, `${left} / ${right}`);
});

test("unknown, malformed and oversized mod versions cannot prove compatibility", () => {
  for (const value of [
    undefined,
    null,
    1,
    "",
    " ",
    "1.0\n",
    "1.0\0",
    "v1.0",
    "${file.jarVersion}",
    "1..0",
    "1--2",
    "1.",
    "+1",
    "1/2",
    "1,2",
    "1.*",
    "1.β",
    "1".repeat(257),
  ])
    assert.throws(() => mavenVersion(value), /cannot be compared/);
});
