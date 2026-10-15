import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const packagePath = process.argv[2] ?? resolve(dirname(require.resolve("openclaw/plugin-sdk/core")), "../../package.json");
const host = JSON.parse(await readFile(packagePath, "utf8"));
const specifiers = new Set();
const names = new Map();
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
        if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith("openclaw/plugin-sdk/")) {
          specifiers.add(specifier.text);
          const bindings = ts.isImportDeclaration(node) ? node.importClause : undefined;
          const elements = bindings?.namedBindings && ts.isNamedImports(bindings.namedBindings) ? bindings.namedBindings.elements
            : ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : [];
          const runtimeNames = names.get(specifier.text) ?? new Set();
          if (!bindings?.isTypeOnly && !node.isTypeOnly) {
            if (bindings?.name) runtimeNames.add("default");
            for (const element of elements) if (!element.isTypeOnly) runtimeNames.add((element.propertyName ?? element.name).text);
          }
          if (ts.isCallExpression(node)) {
            const parent = ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent;
            if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
              for (const element of parent.name.elements) {
                if (!element.dotDotDotToken) runtimeNames.add((element.propertyName ?? element.name).text);
              }
            }
          }
          names.set(specifier.text, runtimeNames);
        }
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
} else {
  for (const [specifier, required] of [...names].sort()) {
    if (!required.size) continue;
    const target = host.exports[specifier.replace(/^openclaw\//u, "./")];
    const runtimeTarget = (value) => {
      if (typeof value === "string") return value;
      if (value && typeof value === "object") {
        for (const [condition, target] of Object.entries(value)) {
          if (["node", "import", "default"].includes(condition)) {
            const selected = runtimeTarget(target);
            if (selected) return selected;
          }
        }
      }
      throw new Error("No ESM runtime export target");
    };
    try {
      const module = await import(pathToFileURL(resolve(dirname(packagePath), runtimeTarget(target))).href);
      const absent = [...required].filter(name => !Object.hasOwn(module, name));
      if (process.env.SDK_EXPORT_AUDIT_TABLE) console.log(`${specifier} | ${[...required].sort().join(", ")} | ${absent.length ? "MISSING " + absent.join(", ") : "OK"}`);
      if (absent.length) {
        console.error(`OpenClaw ${host.version} missing named exports from ${specifier}: ${absent.join(", ")}`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`OpenClaw ${host.version} cannot load ${specifier}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) console.log(`SDK exports OK: ${specifiers.size} source/built specifiers against OpenClaw ${host.version}`);
}
