import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const packagePath = process.argv[2] ?? resolve(dirname(require.resolve("openclaw/plugin-sdk/core")), "../../package.json");
const host = JSON.parse(await readFile(packagePath, "utf8"));
const specifiers = new Set();
async function scan(directory, recursive = true) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive) await scan(path);
    } else if (/\.(js|ts)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, entry.name.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
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
if (existsSync(resolve("src"))) await scan(resolve("src"));
await scan(resolve("."), false);
const missing = [...specifiers].filter((specifier) => !host.exports?.[specifier.replace(/^openclaw\//u, "./")]);
if (missing.length) {
  console.error(`OpenClaw ${host.version} does not export: ${missing.join(", ")}`);
  process.exitCode = 1;
} else console.log(`SDK exports OK: ${specifiers.size} source/built specifiers against OpenClaw ${host.version}`);
