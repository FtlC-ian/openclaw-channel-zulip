import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const packagePath = process.argv[2] ?? resolve(dirname(require.resolve("openclaw/plugin-sdk/core")), "../../package.json");
const host = JSON.parse(await readFile(packagePath, "utf8"));
const specifiers = new Set();
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (entry.name.endsWith(".js")) {
      const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      function visit(node) {
        const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")
            ? node.arguments[0] : undefined;
        if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith("openclaw/plugin-sdk/")) specifiers.add(specifier.text);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
}
await scan(resolve("dist"));
const missing = [...specifiers].filter((specifier) => !host.exports?.[specifier.replace(/^openclaw\//u, "./")]);
if (missing.length) {
  console.error(`OpenClaw ${host.version} does not export: ${missing.join(", ")}`);
  process.exitCode = 1;
} else console.log(`SDK exports OK: ${specifiers.size} built specifiers against OpenClaw ${host.version}`);
