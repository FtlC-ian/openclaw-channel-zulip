import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("built and type-only source SDK imports must be publicly exported", async () => {
  const root = await mkdtemp(join(tmpdir(), "zulip-sdk-check-"));
  try {
    await mkdir(join(root, "dist", "nested"), { recursive: true });
    await writeFile(join(root, "dist", "nested", "index.js"), `
      import { a } from "openclaw/plugin-sdk/core";
      export { b } from "openclaw/plugin-sdk/approval-runtime";
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
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /4 source\/built specifiers/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
