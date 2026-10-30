import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("namespace store factory contract accepts V2 or either legacy spelling but rejects losing all", async () => {
  const root = await mkdtemp(join(tmpdir(), "zulip-sdk-namespace-check-"));
  try {
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "index.js"), `
      const sdk = await import("openclaw/plugin-sdk/plugin-state-store-runtime");
      const create = sdk.createPluginStateKeyedStore ?? sdk.createPluginStateSyncKeyedStore;
    `);
    const packagePath = join(root, "package.json");
    await writeFile(packagePath, JSON.stringify({ type: "module", version: "fixture", exports: { "./plugin-sdk/plugin-state-store-runtime": "./state.js" } }));
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("./check-sdk-exports.mjs", import.meta.url)), packagePath], { cwd: root, encoding: "utf8" });
    for (const name of ["createPluginStateKeyedStoreV2", "createPluginStateKeyedStore", "createPluginStateSyncKeyedStore"]) {
      await writeFile(join(root, "state.js"), "export function " + name + "() {}");
      const success = run();
      assert.equal(success.status, 0, success.stderr);
    }
    for (const source of ["export const unrelated = 1;", "export const createPluginStateKeyedStore = 1;"]) {
      await writeFile(join(root, "state.js"), source);
      const failure = run();
      assert.equal(failure.status, 1);
      assert.ok(failure.stderr.includes("missing named exports from openclaw/plugin-sdk/plugin-state-store-runtime: createPluginStateKeyedStoreV2 OR createPluginStateKeyedStore OR createPluginStateSyncKeyedStore"), failure.stderr);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("built and type-only source SDK imports must be publicly exported", async () => {
  const root = await mkdtemp(join(tmpdir(), "zulip-sdk-check-"));
  try {
    await mkdir(join(root, "dist", "nested"), { recursive: true });
    await writeFile(join(root, "dist", "nested", "index.js"), `
      import { a } from "openclaw/plugin-sdk/core";
      export { b as renamed } from "openclaw/plugin-sdk/approval-runtime";
      const { dynamicName: localName } = await import("openclaw/plugin-sdk/core");
      try { await import("openclaw/plugin-sdk/infra-runtime"); } catch {}
      // import "openclaw/plugin-sdk/not-an-import";
    `);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "types.ts"), 'import type { Contract } from "openclaw/plugin-sdk/channel-contract";');
    const packagePath = join(root, "package.json");
    const exports = { "./plugin-sdk/core": "./core.js", "./plugin-sdk/approval-runtime": "./approval.js" };
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("./check-sdk-exports.mjs", import.meta.url)), packagePath], { cwd: root, encoding: "utf8" });
    await writeFile(packagePath, JSON.stringify({ version: "fixture", exports }));
    const failure = run();
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /does not export: openclaw\/plugin-sdk\/infra-runtime/u);
    exports["./plugin-sdk/infra-runtime"] = "./infra.js";
    await writeFile(packagePath, JSON.stringify({ version: "fixture", exports }));
    const typeFailure = run();
    assert.equal(typeFailure.status, 1);
    assert.match(typeFailure.stderr, /does not export: openclaw\/plugin-sdk\/channel-contract/u);
    exports["./plugin-sdk/channel-contract"] = "./contract.js";
    await writeFile(packagePath, JSON.stringify({ version: "fixture", exports }));
    await writeFile(join(root, "core.js"), "export const a = 1; export const dynamicName = 3;");
    await writeFile(join(root, "approval.js"), "export const b = 2;");
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /4 source\/built specifiers/u);
    await writeFile(join(root, "approval.js"), "export const renamed = 2;");
    const namedFailure = run();
    assert.equal(namedFailure.status, 1);
    assert.match(namedFailure.stderr, /missing named exports from openclaw\/plugin-sdk\/approval-runtime: b/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
