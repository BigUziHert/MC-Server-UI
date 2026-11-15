import fs from "node:fs/promises";
import path from "node:path";

// Windows drive letters can name a network share or a subst root. Accept only
// that root-prefix translation, with every descendant still an ordinary folder.
// Callers adopt the canonical result; stored paths never depend on a login's map.
export async function isCanonicalVolumeAlias(
  resolved,
  canonical,
  { platform = process.platform, fileSystem = fs, signal } = {},
) {
  if (platform !== "win32") return false;
  const paths = path.win32;
  const root = paths.parse(resolved).root;
  if (!/^[a-z]:\\$/i.test(root)) return false;
  const canonicalRoot = await fileSystem.realpath(root);
  signal?.throwIfAborted();
  const suffix = paths.relative(root, resolved);
  if (suffix.startsWith("..") || paths.isAbsolute(suffix)) return false;
  const same = (a, b) =>
    paths.resolve(a).toLowerCase() === paths.resolve(b).toLowerCase();
  if (
    same(canonicalRoot, root) ||
    !same(paths.join(canonicalRoot, suffix), canonical)
  )
    return false;
  let current = root;
  for (const part of ["", ...suffix.split(/[\\/]/).filter(Boolean)]) {
    if (part) current = paths.join(current, part);
    const stat = await fileSystem.lstat(current);
    signal?.throwIfAborted();
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  }
  // Recheck after the component walk so a changed drive mapping is rejected.
  return (
    same(await fileSystem.realpath(root), canonicalRoot) &&
    same(await fileSystem.realpath(resolved), canonical)
  );
}
