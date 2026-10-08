import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.env.OPENCLAW_HOST_FIXTURES;
if (!root) throw new Error("Set OPENCLAW_HOST_FIXTURES to the directory containing npm-extracted <version>/package hosts");
const require = createRequire(import.meta.url);
for (const version of ["2026.9.3", "2026.9.6", "2026.10.1-beta.1", "2026.10.1-beta.2"]) {
  test(`built plugin loads and delivered reaction approvals are enabled on ${version}`, (t) => {
    const host = resolve(root, version, "package");
    execFileSync(process.execPath, ["scripts/check-sdk-exports.mjs", resolve(host, "package.json")], { stdio: "pipe" });
    const scratch = mkdtempSync(resolve(root, `reaction-smoke-${version}-`));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    cpSync("dist", resolve(scratch, "dist"), { recursive: true });
    mkdirSync(resolve(scratch, "node_modules"));
    symlinkSync(host, resolve(scratch, "node_modules/openclaw"));
    symlinkSync(resolve(require.resolve("zod/package.json"), ".."), resolve(scratch, "node_modules/zod"));
    writeFileSync(resolve(scratch, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(resolve(scratch, "smoke.mjs"), `
      import assert from "node:assert/strict";
      await import("./dist/index.js");
      await import("./dist/setup-entry.js");
      const reactions = await import("openclaw/plugin-sdk/approval-reaction-runtime");
      for (const name of ["createApprovalReactionTargetStore", "readApprovalReactionTargetRecord", "listApprovalReactionBindings", "settleApprovalReaction", "readApprovalReactionPresentationBinding", "readApprovalReactionDeliveryMetadata"]) assert.equal(typeof reactions[name], "function", name);
      assert.equal(typeof (await import("openclaw/plugin-sdk/lazy-runtime")).createLazyRuntimeSurface, "function");
      assert.equal(typeof (await import("openclaw/plugin-sdk/approval-gateway-runtime")).resolveApprovalOverGateway, "function");
      const { buildExecApprovalPendingReplyPayload, getExecApprovalReplyMetadata } = await import("openclaw/plugin-sdk/approval-reply-runtime");
      assert.equal(typeof getExecApprovalReplyMetadata, "function");
      const { ZulipApprovalReactions } = await import("./dist/src/zulip/approval-reactions.js");
      const store = new ZulipApprovalReactions();
      const cfg = { channels: { zulip: { url: "https://zulip.test", email: "bot@test", apiKey: "test", allowFrom: ["approver@test"] } } };
      const calls = [];
      const { createZulipClient } = await import("./dist/src/zulip/client.js");
      const client = createZulipClient({ baseUrl: "https://zulip.test", email: "bot@test", apiKey: "test", fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(String(url).includes("/users/") ? { result: "success", user: { user_id: 2, email: "unauthorized@test", is_active: true, is_bot: false } } : { result: "success" }));
      } });
      const payload = buildExecApprovalPendingReplyPayload({ approvalId: "smoke", approvalSlug: "smoke", command: "true", host: "gateway", allowedDecisions: ["allow-once", "deny"] });
      await store.register({ cfg, accountId: "default", messageId: "123", client, sourceText: payload.text, payload });
      assert.equal(calls.filter(({ init }) => init.method === "POST").length, 2, "reactions must be enabled and seeded without observation");
      await store.react({ cfg, accountId: "default", botUserId: "1", client, event: { type: "reaction", op: "add", user_id: 2, message_id: 123, emoji_name: "check", reaction_type: "unicode_emoji" } });
      assert.equal(calls.filter(({ url }) => url.includes("/users/2")).length, 1, "delivered target handles reaction events");
      assert.equal(await store.command({ cfg, accountId: "default", senderId: "unauthorized@test", text: "/approve smoke deny" }), true, "delivered binding remains active after denied actor");
      store.clearAccount("default");
      assert.equal(await store.command({ cfg, accountId: "default", senderId: "approver@test", text: "/approve smoke deny" }), false);
      console.log("enabled ${version}");
    `);
    const output = execFileSync(process.execPath, [resolve(scratch, "smoke.mjs")], { encoding: "utf8" });
    assert.match(output, /enabled/);
  });
}
