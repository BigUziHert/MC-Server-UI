// Maven 3.8 ComparableVersion ordering, used by Forge/NeoForge mod metadata.
// Keep hyphens and digit/letter transitions as nested lists: flattening them
// changes comparisons such as 1.21.1-3.7.2 versus 1.21-3.6.4.
// https://maven.apache.org/pom.html#version-order-specification
// https://github.com/apache/maven/blob/maven-3.8.5/maven-artifact/src/main/java/org/apache/maven/artifact/versioning/ComparableVersion.java
const qualifiers = ["alpha", "beta", "milestone", "rc", "snapshot", "", "sp"];
const aliases = new Map([
  ["ga", ""],
  ["final", ""],
  ["release", ""],
  ["cr", "rc"],
]);
const abbreviations = new Map([
  ["a", "alpha"],
  ["b", "beta"],
  ["m", "milestone"],
]);
const order = (left, right) => (left === right ? 0 : left < right ? -1 : 1);
const qualifierKey = (value) => {
  const index = qualifiers.indexOf(value);
  return index < 0 ? `${qualifiers.length}-${value}` : String(index);
};
const qualifier = (value, followedByDigit = false) => {
  if (followedByDigit) value = abbreviations.get(value) ?? value;
  return aliases.get(value) ?? value;
};
const empty = (item) =>
  Array.isArray(item) ? item.length === 0 : item === 0n || item === "";

/** Parse bounded, numeric-leading ASCII mod versions. Malformed versions and
 * unresolved substitutions stay unprovable; no version is inferred from a label.
 * '+' and '_' are Maven qualifier characters, not SemVer build metadata.
 */
export function mavenVersion(value) {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^\d[a-zA-Z0-9]*(?:[.+_-][a-zA-Z0-9]+)*$/.test(value)
  )
    throw new Error("The mod version cannot be compared using Maven ordering.");
  const source = value.toLowerCase();
  const root = [],
    lists = [root];
  let current = root,
    start = 0,
    numeric = false;
  const nest = () => {
    const child = [];
    current.push(child);
    lists.push(child);
    current = child;
  };
  const append = (end) => {
    const part = source.slice(start, end);
    current.push(numeric ? BigInt(part) : qualifier(part));
  };
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "." || character === "-") {
      append(index);
      start = index + 1;
      if (character === "-") nest();
      continue;
    }
    const nextNumeric = character >= "0" && character <= "9";
    if (nextNumeric !== numeric && index > start) {
      if (nextNumeric) {
        current.push(qualifier(source.slice(start, index), true));
      } else append(index);
      nest();
      start = index;
    }
    numeric = nextNumeric;
  }
  append(source.length);
  for (const list of lists.reverse()) {
    for (let index = list.length - 1; index >= 0; index--) {
      if (empty(list[index])) list.splice(index, 1);
      else if (!Array.isArray(list[index])) break;
    }
  }
  return root;
}

/** Compare parsed Maven versions (or their component items). Missing items
 * compare to zero/release, including every component of a nested list.
 */
export function compareMavenVersions(left, right) {
  if (left == null)
    return right == null ? 0 : -compareMavenVersions(right, null);
  if (right == null) {
    if (typeof left === "bigint") return order(left, 0n);
    if (typeof left === "string")
      return order(qualifierKey(left), qualifierKey(""));
    for (const item of left) {
      const result = compareMavenVersions(item, null);
      if (result) return result;
    }
    return 0;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const result = compareMavenVersions(left[index], right[index]);
      if (result) return result;
    }
    return 0;
  }
  if (typeof left === "bigint" && typeof right === "bigint")
    return order(left, right);
  if (typeof left === "string" && typeof right === "string")
    return order(qualifierKey(left), qualifierKey(right));
  // At a shared position: qualifier < nested list < numeric component.
  const rank = (item) =>
    typeof item === "string" ? 0 : Array.isArray(item) ? 1 : 2;
  return order(rank(left), rank(right));
}
