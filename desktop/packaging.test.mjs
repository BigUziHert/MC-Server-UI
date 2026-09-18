import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { parse } from "yaml";

const projectDir = fileURLToPath(new URL("../", import.meta.url));

function localImports(source, filename) {
  const imports = new Set();
  const tree = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const visit = (node) => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      /^\.\.?\//.test(specifier.text)
    )
      imports.add(specifier.text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return imports;
}

test("desktop packaging includes every local runtime module dependency", async () => {
  const config = parse(
    await fs.readFile(path.join(projectDir, "electron-builder.yml"), "utf8"),
  );
  assert.ok(
    Array.isArray(config.files) &&
      config.files.every((pattern) => typeof pattern === "string"),
    "Update the packaging dependency check if files use mapped FileSets.",
  );
  const included = config.files.filter((pattern) => !pattern.startsWith("!"));
  const excluded = config.files
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  const pkg = JSON.parse(
    await fs.readFile(path.join(projectDir, "package.json"), "utf8"),
  );
  const pending = [
    { filename: path.join(projectDir, pkg.main), importer: "package.json" },
  ];
  const visited = new Set();
  const missing = [];
  for (const { filename, importer } of pending) {
    if (visited.has(filename)) continue;
    visited.add(filename);
    const relative = path
      .relative(projectDir, filename)
      .split(path.sep)
      .join("/");
    assert.ok(
      !relative.startsWith("../") && !path.isAbsolute(relative),
      `Runtime import escapes the project: ${importer} -> ${relative}`,
    );
    if (
      !included.some((pattern) => path.posix.matchesGlob(relative, pattern)) ||
      excluded.some((pattern) => path.posix.matchesGlob(relative, pattern))
    )
      missing.push(`${relative} (imported by ${importer})`);
    const source = await fs.readFile(filename, "utf8");
    if (!/\.[cm]?js$/.test(filename)) continue;
    for (const specifier of localImports(source, filename))
      pending.push({
        filename: fileURLToPath(new URL(specifier, pathToFileURL(filename))),
        importer: relative,
      });
  }
  assert.deepEqual(
    missing,
    [],
    `Packaged desktop runtime dependencies are missing from electron-builder.yml:\n${missing.join("\n")}`,
  );
});
