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
  test(`real core approval routing/rendering and Zulip delivery on ${version}`, (t) => {
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
      const { buildTypedExecApprovalPendingReplyPayload, getExecApprovalReplyMetadata } = await import("openclaw/plugin-sdk/approval-reply-runtime");
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
      const { readdirSync, readFileSync } = await import("node:fs");
      const { pathToFileURL } = await import("node:url");
      const distPath = ${JSON.stringify(host)} + "/dist";
      const rendererFile = readdirSync(distPath).find(name => /\\.(mjs|js)$/.test(name) && readFileSync(distPath + "/" + name, "utf8").includes("async function renderPresentationForDelivery("));
      assert.ok(rendererFile, "real host presentation delivery module");
      const rendererModule = await import(pathToFileURL(distPath + "/" + rendererFile));
      const renderForDelivery = Object.values(rendererModule).find(value => typeof value === "function" && value.name === "renderPresentationForDelivery");
      assert.equal(typeof renderForDelivery, "function");
      const { zulipOutboundAdapter, zulipPlugin } = await import("./dist/src/channel.js");
      const { setZulipRuntime } = await import("./dist/src/runtime.js");
      setZulipRuntime({ logging: { getChildLogger: () => ({ debug() {} }) }, channel: { activity: { record() {} }, text: { resolveMarkdownTableMode: () => "off", convertMarkdownTables: text => text } } });
      async function loadHostFunction(name) {
        const file = readdirSync(distPath).find(file => /\\.(mjs|js)$/.test(file) && readFileSync(distPath + "/" + file, "utf8").includes("function " + name + "("));
        assert.ok(file, name);
        const module = await import(pathToFileURL(distPath + "/" + file));
        const fn = Object.values(module).find(value => typeof value === "function" && value.name === name);
        assert.equal(typeof fn, "function", name);
        return fn;
      }
      const registry = (await loadHostFunction("createEmptyPluginRegistry"))();
      registry.channels.push({ pluginId: "zulip", plugin: zulipPlugin });
      (await loadHostFunction("setActivePluginRegistry"))(registry);
      assert.equal(zulipPlugin.approvalCapability.native, undefined, "no competing native prompt planner");
      assert.equal(zulipPlugin.approvalCapability.nativeRuntime, undefined, "no competing native event delivery");
      const forwarderFile = readdirSync(distPath).find(name => /\\.(mjs|js)$/.test(name) && readFileSync(distPath + "/" + name, "utf8").includes("function buildForwardedExecPendingPayload("));
      assert.ok(forwarderFile, "real host forwarder module");
      // Expose the private core forwarder factory only in this test copy; all dependencies remain real host modules.
      const forwarderSource = readFileSync(distPath + "/" + forwarderFile, "utf8")
        .replace(/(from\\s+|import\\s*)(["'])(\\.\\/[^"']+)\\2/g, (_, prefix, quote, specifier) => prefix + quote + pathToFileURL(distPath + "/" + specifier).href + quote)
        + "\\nexport { createExecApprovalForwarder };";
      const { createExecApprovalForwarder } = await import("data:text/javascript;base64," + Buffer.from(forwarderSource).toString("base64"));
      const forwarded = [];
      for (const mode of [undefined, "session", "targets", "both"]) {
        const deliveries = [];
        let acknowledgeDelivery;
        const deliveryComplete = new Promise(resolve => { acknowledgeDelivery = resolve; });
        const forwardingCfg = mode ? { ...cfg, approvals: { exec: { enabled: true, mode, targets: [{ channel: "zulip", to: "user:approver@test" }] } } } : cfg;
        const forwarder = createExecApprovalForwarder({ getConfig: () => forwardingCfg,
          resolveSessionTarget: async () => ({ channel: "zulip", to: "user:approver@test" }),
          deliver: async params => { deliveries.push(params); acknowledgeDelivery(); return { status: "sent", results: [] }; },
        });
        const handled = await forwarder.handleRequested({ id: "12345678-1234-4234-8234-123456789abc", createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000, request: { command: "true", host: "gateway", sessionKey: "agent:debbie:zulip:direct:approver@test" } });
        if (handled) await deliveryComplete;
        await forwarder.stop();
        assert.equal(handled, Boolean(mode));
        assert.equal(deliveries.length, mode ? 1 : 0, "real forwarding route selection and same-target dedupe for " + mode);
        if (mode) forwarded.push(deliveries[0].payloads[0]);
      }
      const sameChatPayload = buildTypedExecApprovalPendingReplyPayload({ approvalId: "12345678-1234-4234-8234-123456789abc", approvalSlug: "12345678", command: "true", host: "gateway" });
      const renderWithPlugin = sourcePayload => renderForDelivery({
        presentationCapabilities: zulipOutboundAdapter.presentationCapabilities,
        renderPresentation: (adapted, sourcePresentation) => zulipOutboundAdapter.renderPresentation({ payload: adapted, presentation: adapted.presentation, sourcePresentation, ctx: { cfg, to: "user:approver@test" } }),
      }, sourcePayload);
      const sourceSelect = structuredClone(sameChatPayload);
      sourceSelect.presentation.blocks.push({ type: "select", options: [{ label: "Other approval", action: { type: "command", command: "/approve other allow-always" } }] });
      const rejectedSelect = await renderWithPlugin(sourceSelect);
      const { readApprovalBinding } = await import("./dist/src/zulip/approval-sdk.js");
      assert.equal(readApprovalBinding({ payload: rejectedSelect }), null, "source select must not be hidden by real core adaptation and admit a binding");
      assert.equal(rejectedSelect.channelData?.zulip?.widgetContent, undefined, "rejected source controls cannot produce an approval zform");
      let rendered;
      for (const sourcePayload of [...forwarded, sameChatPayload]) {
        const degraded = await renderForDelivery({}, sourcePayload);
        assert.equal(degraded.presentation, undefined, "without the public renderer core strips controls");
        assert.equal(readApprovalBinding({ payload: degraded }), null, "reproduce live missing binding");
        rendered = await renderWithPlugin(sourcePayload);
        assert.equal(rendered.presentation, undefined, "core consumes presentation after channel rendering");
        assert.equal(readApprovalBinding({ payload: rendered }).approvalId, "12345678-1234-4234-8234-123456789abc");
        const network = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          network.push({ url: String(url), init });
          return new Response(JSON.stringify({ result: "success", id: 123 }));
        };
        try {
          await zulipOutboundAdapter.sendPayload({ cfg, to: "user:approver@test", payload: rendered });
        } finally { globalThis.fetch = originalFetch; }
        assert.equal(network.filter(({ url }) => url.endsWith("/messages")).length, 1, "one prompt, no native delivery duplication");
        const messageBody = new URLSearchParams(network.find(({ url }) => url.endsWith("/messages")).init.body);
        const widget = JSON.parse(messageBody.get("widget_content"));
        assert.equal(widget.widget_type, "zform", "actual send delivers zform in widget_content");
        assert.deepEqual(widget.extra_data.choices.map(choice => choice.reply), ["/approve 12345678-1234-4234-8234-123456789abc allow-once", "/approve 12345678-1234-4234-8234-123456789abc allow-always", "/approve 12345678-1234-4234-8234-123456789abc deny"]);
        assert.equal(network.filter(({ url }) => url.endsWith("/reactions")).length, 2, "actual send binds and seeds both reactions");
        const { zulipApprovalReactions } = await import("./dist/src/zulip/approval-reactions.js");
        assert.equal(await zulipApprovalReactions.command({ cfg, accountId: "default", senderId: "unauthorized@test", text: "/approve 12345678-1234-4234-8234-123456789abc deny" }), true, "actual send registered binding");
        zulipApprovalReactions.clearAccount("default");
      }
      await store.register({ cfg, accountId: "default", messageId: "123", client, sourceText: rendered.text, payload: rendered });
      assert.equal(calls.filter(({ init }) => init.method === "POST").length, 2, "reactions must be enabled and seeded without observation");
      await store.react({ cfg, accountId: "default", botUserId: "1", client, event: { type: "reaction", op: "add", user_id: 2, message_id: 123, emoji_name: "check", reaction_type: "unicode_emoji" } });
      assert.equal(calls.filter(({ url }) => url.includes("/users/2")).length, 1, "delivered target handles reaction events");
      assert.equal(await store.command({ cfg, accountId: "default", senderId: "unauthorized@test", text: "/approve 12345678-1234-4234-8234-123456789abc deny" }), true, "delivered binding remains active after denied actor");
      store.clearAccount("default");
      assert.equal(await store.command({ cfg, accountId: "default", senderId: "approver@test", text: "/approve 12345678-1234-4234-8234-123456789abc deny" }), false);
      console.log("enabled ${version}");
    `);
    const output = execFileSync(process.execPath, [resolve(scratch, "smoke.mjs")], { encoding: "utf8", timeout: 20000 });
    assert.match(output, /enabled/);
  });
}
