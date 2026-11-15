import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isCanonicalVolumeAlias } from "./canonical-volume.mjs";

const ordinary = { isDirectory: () => true, isSymbolicLink: () => false };
function fixture(root, { linked, redirect } = {}) {
  const visited = [];
  return {
    visited,
    fileSystem: {
      realpath: async (value) =>
        value === "Z:\\"
          ? root
          : (redirect ??
            path.win32.join(root, path.win32.relative("Z:\\", value))),
      lstat: async (value) => {
        visited.push(value);
        return value === linked
          ? { ...ordinary, isSymbolicLink: () => true }
          : ordinary;
      },
    },
  };
}
test("mapped and subst volume prefixes resolve only through ordinary path components", async () => {
  for (const root of ["\\\\nas\\minecraft\\", "C:\\Data\\Mapped"]) {
    const f = fixture(root);
    assert.equal(
      await isCanonicalVolumeAlias(
        "Z:\\Servers\\Survival",
        path.win32.join(root, "Servers", "Survival"),
        { platform: "win32", ...f },
      ),
      true,
    );
    assert.deepEqual(f.visited, [
      "Z:\\",
      "Z:\\Servers",
      "Z:\\Servers\\Survival",
    ]);
  }
});
test("volume alias validation rejects junctions, different descendants and non-Windows aliases", async () => {
  const root = "C:\\Data\\Mapped",
    target = root + "\\Servers\\Survival";
  assert.equal(
    await isCanonicalVolumeAlias("Z:\\Servers\\Survival", target, {
      platform: "win32",
      ...fixture(root, { linked: "Z:\\Servers" }),
    }),
    false,
  );
  assert.equal(
    await isCanonicalVolumeAlias(
      "Z:\\Servers\\Survival",
      "C:\\Other\\Survival",
      { platform: "win32", ...fixture(root) },
    ),
    false,
  );
  assert.equal(
    await isCanonicalVolumeAlias("Z:\\Servers\\Survival", target, {
      platform: "linux",
      ...fixture(root),
    }),
    false,
  );
});
