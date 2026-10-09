import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExecApprovalPendingReplyPayload, buildTypedExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import { buildApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "../sdk.js";
import type { ZulipClient, ZulipEvent } from "./client.js";
import { ZulipApprovalReactions, zulipApprovalReactions } from "./approval-reactions.js";
import { readApprovalBinding } from "./approval-sdk.js";
import { durableBindings, type DurableRecord } from "./durable-bindings.js";
const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({ resolveApprovalOverGateway: mocks.resolve }));

const cfg = { channels: { zulip: { url: "https://zulip.test", email: "bot@test", apiKey: "test", allowFrom: ["user:ian@test"], accounts: { default: {}, other: { allowFrom: ["other@test"] } } } } } as OpenClawConfig;
function payload(id = "req-1", kind: "exec" | "plugin" = "exec") {
  return buildApprovalPendingReplyPayload({ approvalId: id, approvalSlug: id, approvalKind: kind, text: "Approval required", allowedDecisions: ["allow-once", "deny"] });
}
function event(overrides: Partial<ZulipEvent> = {}): ZulipEvent {
  return { id: 1, type: "reaction", op: "add", user_id: 2, message_id: 10, emoji_name: "check", reaction_type: "unicode_emoji", ...overrides };
}
let store: ZulipApprovalReactions;
let client: ZulipClient;
let request: ReturnType<typeof vi.fn>;
async function register(id = "req-1", messageId = "10", accountId = "default", configuration = cfg, kind: "exec" | "plugin" = "exec") {
  await store.register({ cfg: configuration, accountId, messageId, client, sourceText: "Approval required", payload: payload(id, kind) });
}
async function react(overrides: Partial<ZulipEvent> = {}, configuration = cfg, accountId = "default") {
  await store.react({ cfg: configuration, accountId, client, botUserId: "1", event: event(overrides) });
}
const command = (text = "/approve req-1 deny") => store.command({ cfg, accountId: "default", senderId: "ian@test", text });
beforeEach(() => {
  store = new ZulipApprovalReactions();
  request = vi.fn(async (path: string) => path.startsWith("/users/") ? { result: "success", user: { user_id: 2, email: "ian@test", full_name: "Ian F", is_bot: false, is_active: true } } : { result: "success" });
  client = { baseUrl: "https://zulip.test", authHeader: "test", fetchImpl: vi.fn(async (url, init) => new Response(JSON.stringify(await request(new URL(String(url)).pathname.replace("/api/v1", ""), init)), { status: 200 })), request } as ZulipClient;
  mocks.resolve.mockReset().mockImplementation(async (params) => ({ applied: true, approval: { status: params.decision === "deny" ? "denied" : "allowed", decision: params.decision } }));
});
afterEach(() => { vi.useRealTimers(); zulipApprovalReactions.clearAccount("default"); zulipApprovalReactions.clearAccount("other"); });

describe("approval reaction control boundary", () => {
  it("keeps a failed approval recovery claim inert", async () => {
    const record: DurableRecord = { kind: "approval", accountId: "default", scope: "hash", generation: "old", messageId: "10", id: "req-1", approvalKind: "exec", decisions: ["allow-once", "deny"], emojis: [["check", "allow-once"]], expiresAt: Date.now() + 60000 };
    const spies = [vi.spyOn(durableBindings, "records").mockResolvedValue([{ key: 'approval:["default","10"]', record }]), vi.spyOn(durableBindings, "claim").mockResolvedValue(undefined)];
    try {
      await store.restore({ cfg, accountId: "default", client, request: async () => [{ id: "req-1" }] });
      expect(await command()).toBe(false);
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
  });
  it.each([true, false])("reconciles restart approval pending=%s without replaying a resolution", async (pending) => {
    const record: DurableRecord = { kind: "approval", accountId: "default", scope: "hash", generation: "old", messageId: "10", companionId: "11", id: "req-1", approvalKind: "exec", decisions: ["allow-once", "deny"], emojis: [["check", "allow-once"], ["cross_mark", "deny"]], expiresAt: Date.now() + 60000 };
    const spies = [vi.spyOn(durableBindings, "records").mockResolvedValue([{ key: 'approval:["default","10"]', record }]), vi.spyOn(durableBindings, "claim").mockImplementation(async (_key, value) => ({ ...value, generation: "new" })), vi.spyOn(durableBindings, "current").mockResolvedValue(true), vi.spyOn(durableBindings, "remove").mockResolvedValue()];
    try {
      await store.restore({ cfg, accountId: "default", client, request: async () => pending ? [{ id: "req-1" }] : [] });
      expect(mocks.resolve).not.toHaveBeenCalled();
      if (pending) { await command(); await command(); expect(mocks.resolve).toHaveBeenCalledTimes(1); }
      else { expect(request.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true); expect(await command()).toBe(false); }
    } finally { for (const spy of spies) spy.mockRestore(); }
  });
  it.each([buildExecApprovalPendingReplyPayload, buildTypedExecApprovalPendingReplyPayload])("accepts SDK exec pending payloads without a state field", async (build) => {
    const pending = build({ approvalId: "req-1", approvalSlug: "req-1", command: "true", host: "gateway", allowedDecisions: ["allow-once", "deny"] });
    expect(readApprovalBinding({ payload: pending })).toMatchObject({ approvalId: "req-1", approvalKind: "exec" });
    await store.register({ cfg, accountId: "default", messageId: "10", client, sourceText: pending.text!, payload: pending });
    await react(); expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });
  it("keeps shipped command-backed zforms and validates typed ownership and decision parity", () => {
    expect(readApprovalBinding({ payload: payload() })).toMatchObject({ approvalId: "req-1", approvalKind: "exec" });
    const typed = payload();
    typed.presentation!.blocks = [{ type: "buttons", buttons: [
      { label: "Allow", action: { type: "approval", approvalId: "req-1", approvalKind: "exec", decision: "allow-once" } },
      { label: "Deny", action: { type: "approval", approvalId: "req-1", approvalKind: "exec", decision: "deny" } },
    ] }];
    expect(readApprovalBinding({ payload: typed })).not.toBeNull();
    (typed.channelData!.execApproval as any).approvalKind = "plugin";
    expect(readApprovalBinding({ payload: typed })).toBeNull();
    const wrong = payload();
    (wrong.channelData!.execApproval as any).allowedDecisions = ["allow-once"];
    expect(readApprovalBinding({ payload: wrong })).toBeNull();
    (wrong.channelData!.execApproval as any).state = "resolved";
    expect(readApprovalBinding({ payload: wrong })).toBeNull();
  });
  it("seeds check/X and resolves an authorized reaction with canonical owner and actor", async () => {
    await register();
    const seeds = request.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(seeds).toHaveLength(2);
    expect(seeds.map(([, init]) => new URLSearchParams(init.body).get("emoji_name"))).toEqual(["check", "cross_mark"]);
    await react();
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "req-1", approvalKind: "exec", decision: "allow-once", senderId: "ian@test", accountId: "default" }));
    expect(request).toHaveBeenCalledWith("/messages/10", expect.objectContaining({ method: "PATCH", body: expect.stringContaining("Approved") }));
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe("✅ Approved (allow once) by `Ian F`\n\nID: req-1");
  });
  it.each(["reaction", "zform", "manual", "cli", "control-ui", "expired", "cancelled"])("retires the editable prompt and companion widget after %s resolution", async (surface) => {
    await store.register({ cfg, accountId: "default", messageId: "10", widgetMessageId: "11", client, sourceText: "Approval required", payload: payload() });
    // Model Zulip's actual server contract instead of an always-successful PATCH.
    request.mockImplementation(async (path, init) => {
      if (path === "/messages/11" && init?.method === "PATCH") throw new Error("Widgets cannot be edited.");
      return path.startsWith("/users/") ? { result: "success", user: { email: "ian@test" } } : { result: "success" };
    });
    if (surface === "reaction") await react();
    else if (surface === "manual" || surface === "zform") await command();
    else await store.observeTerminal("default", { event: "exec.approval.resolved", payload: { id: "req-1", decision: "deny", ...(["expired", "cancelled"].includes(surface) ? { terminalStatus: surface, decision: undefined } : {}) } });
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    const header = surface === "reaction" ? "✅ Approved (allow once) by `ian@test`"
      : surface === "manual" || surface === "zform" ? "❌ Denied by `ian@test`"
      : surface === "expired" ? "⌛ Expired" : surface === "cancelled" ? "🚫 Cancelled" : "Resolved elsewhere: deny";
    expect(edit).toBe(`${header}\n\nID: req-1`);
    expect(request).toHaveBeenCalledWith("/messages/11", expect.objectContaining({ method: "DELETE" }));
    expect(request.mock.calls.filter(([path, init]) => path.endsWith("/reactions") && init?.method === "DELETE")).toHaveLength(2);
    await react(); await store.observeTerminal("default", { event: "exec.approval.resolved", payload: { id: "req-1", decision: "deny" } });
    expect(request.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });
  it("remembers bounded terminal observations that race pending delivery", async () => {
    store = new ZulipApprovalReactions(1);
    await store.observeTerminal("default", { event: "exec.approval.resolved", payload: { id: "old", decision: "deny" } });
    await store.observeTerminal("default", { event: "exec.approval.resolved", payload: { id: "req-1", decision: "allow-once" } });
    await store.register({ cfg, accountId: "default", messageId: "10", widgetMessageId: "11", client, sourceText: "Approval required", payload: payload() });
    expect(request).toHaveBeenCalledWith("/messages/10", expect.objectContaining({ method: "PATCH", body: expect.stringContaining("Resolved+elsewhere%3A+allow-once") }));
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await react(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("uses the gateway observation winner when settlement races another surface", async () => {
    await register();
    let complete!: (value: unknown) => void;
    mocks.resolve.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = react();
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    await store.observeTerminal("default", { event: "exec.approval.resolved", payload: { id: "req-1", decision: "deny" } });
    complete({ applied: false, approval: { status: "denied", decision: "deny" } }); await pending;
    const patches = request.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(new URLSearchParams(patches[0][1].body).get("content")).toBe("Resolved elsewhere: deny\n\nID: req-1");
  });
  it.each(["@**Debbie-OG|13**", "@_**Debbie-OG|13**", "@**bot@test**", "@_**Renamed|bot@test**"])("intercepts identity-qualified bot mention %s", async (mention) => {
    const id = "9f832b3e-561c-47df-a95c-beb76511a55a";
    await register(id);
    expect(await store.command({ cfg, accountId: "default", senderId: "ian@test", botUserId: "13", botEmail: "bot@test", text: `${mention} /approve ${id} allow-once` })).toBe(true);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });
  it.each(["@**Other|8**", "@_**Other|8**", "@**Debbie-OG**", "@**Other|other@test**", "prefix @**Debbie-OG|13**", "@**Other|8** @**Debbie-OG|13**"])("does not strip foreign/unqualified/nonleading mentions %s", async (mention) => {
    await register();
    expect(await store.command({ cfg, accountId: "default", senderId: "ian@test", botUserId: "13", botEmail: "bot@test", text: `${mention} /approve req-1 allow-once` })).toBe(false);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("consumes unauthorized mention-prefixed approval without resolving or dispatching", async () => {
    await register();
    expect(await store.command({ cfg, accountId: "default", senderId: "stranger@test", botUserId: "13", text: "@**Debbie-OG|13** /approve req-1 allow-once" })).toBe(true);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("observes only matching account, owner, id and canonical terminal outcomes", async () => {
    await register();
    for (const [accountId, event] of [
      ["other", { event: "exec.approval.resolved", payload: { id: "req-1", decision: "deny" } }],
      ["default", { event: "plugin.approval.resolved", payload: { id: "req-1", decision: "deny" } }],
      ["default", { event: "exec.approval.resolved", payload: { id: "other", decision: "deny" } }],
      ["default", { event: "exec.approval.resolved", payload: { id: "req-1", decision: "invalid" } }],
    ] as const) await store.observeTerminal(accountId, event);
    expect(request.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
    await react(); expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });
  it("denies unauthorized actors and never trusts an event-supplied email", async () => {
    await register(); request.mockImplementation(async () => ({ result: "success", user: { user_id: 2, email: "stranger@test" } }));
    await react(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it.each([{ user_id: 1 }, { op: "remove" }, { message_id: 11 }, { emoji_name: "smile" }, { reaction_type: "zulip_extra_emoji" }])("ignores seeded/removal/unbound events %j without fetching identity", async (overrides) => {
    await register(); request.mockClear(); await react(overrides);
    expect(request).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it.each([{ is_bot: true }, { is_active: false }, { email: null }])("ignores invalid actors %j", async (user) => {
    await register(); request.mockImplementation(async () => ({ result: "success", user: { user_id: 2, email: "ian@test", ...user } }));
    await react(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("rejects wrong-account reactions even with the same message ID", async () => {
    await register(); await react({}, cfg, "other"); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("requires explicit approvers even when generic approval authorization is open", async () => {
    const open = { channels: { zulip: { allowFrom: [] } } } as OpenClawConfig;
    await register("req-1", "10", "default", open); await react({}, open); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("rechecks current allowFrom after binding", async () => {
    await register(); await react({}, { channels: { zulip: { allowFrom: ["new@test"] } } } as OpenClawConfig);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("rechecks current authorization after an in-flight identity lookup", async () => {
    await register();
    let complete!: (value: unknown) => void;
    request.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    let current = cfg;
    const pending = store.react({ cfg, getConfig: () => current, accountId: "default", client, botUserId: "1", event: event() });
    current = { channels: { zulip: { allowFrom: ["new@test"] } } } as OpenClawConfig;
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    complete({ result: "success", user: { user_id: 2, email: "ian@test" } }); await pending;
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it.each(["removed", "disabled", "aborted"])("rejects %s account during an in-flight identity lookup", async (state) => {
    await register();
    let complete!: (value: unknown) => void;
    request.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    let current = cfg;
    const controller = new AbortController();
    const pending = store.react({ cfg, getConfig: () => current, abortSignal: controller.signal, accountId: "default", client, botUserId: "1", event: event() });
    if (state === "removed") current = {};
    if (state === "disabled") current = { channels: { zulip: { ...cfg.channels!.zulip, enabled: false } } } as OpenClawConfig;
    if (state === "aborted") controller.abort();
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    complete({ result: "success", user: { user_id: 2, email: "ian@test" } }); await pending;
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it.each(["revoked", "disabled", "removed", "aborted", "cleared"])("revalidates %s after the lazy resolver await", async (state) => {
    await register();
    const controller = new AbortController();
    let reads = 0;
    const getConfig = () => {
      if (++reads === 1) return cfg;
      if (state === "aborted") controller.abort();
      if (state === "cleared") store.clearAccount("default");
      if (state === "removed") return {};
      if (state === "revoked") return { channels: { zulip: { ...cfg.channels!.zulip, allowFrom: ["someone-else@test"] } } } as OpenClawConfig;
      if (state === "disabled") return { channels: { zulip: { ...cfg.channels!.zulip, enabled: false } } } as OpenClawConfig;
      return cfg;
    };
    await expect(store.command({ cfg, getConfig, abortSignal: controller.signal, accountId: "default", senderId: "ian@test", text: "/approve req-1 deny" })).rejects.toThrow("authorization changed");
    expect(reads).toBe(2);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("consumes an aborted manual approval without resolving it", async () => {
    await register();
    const controller = new AbortController(); controller.abort();
    expect(await store.command({ cfg, accountId: "default", senderId: "ian@test", text: "/approve req-1 allow-once", abortSignal: controller.signal })).toBe(true);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("ignores expired bindings before invoking identity or resolver", async () => {
    vi.useFakeTimers(); await register(); vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1); request.mockClear(); await react();
    expect(request).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("resolves once across duplicate events and ignores terminal reactions", async () => {
    await register(); await Promise.all([react(), react()]); await react({ emoji_name: "cross_mark" });
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });
  it.each(["widget-first", "reaction-first"])("serializes widget/manual command versus reaction: %s", async (order) => {
    await register();
    let complete!: (value: unknown) => void;
    mocks.resolve.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const first = order === "widget-first" ? command() : react();
    await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
    await (order === "widget-first" ? react() : command());
    complete({ applied: true, approval: { status: "denied", decision: "deny" } }); await first;
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });
  it("renders the gateway winner rather than a losing local decision", async () => {
    await register(); mocks.resolve.mockResolvedValue({ applied: false, approval: { status: "denied", decision: "deny" } }); await react();
    const patch = request.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(new URLSearchParams(patch[1].body).get("content")).toBe("Resolved elsewhere: deny\n\nID: req-1");
    await react(); expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  it.each(["sdk", "live-inline"])("retains only the already displayed ID and command from %s prompts", async (format) => {
    const pending = buildTypedExecApprovalPendingReplyPayload({ approvalId: "req-1", approvalSlug: "req-1", command: "printf 'hello'", host: "gateway", cwd: "/private/path", agentId: "private-agent", expiresAtMs: Date.now() + 60000, allowedDecisions: ["allow-once", "deny"] });
    const sourceText = format === "sdk" ? pending.text! : "🔒 Exec approval required\nID: req-1\nCommand: `printf 'hello'`\nCWD: /private/path\nEnv: SECRET=hidden\nHost: gateway\nAgent: private-agent\nSecurity: allowlist\nAsk: always\nExpiry: 60s\nMode: foreground\nBackground note: wait\nReply with: /approve req-1 allow-once\nReact ✅ to approve";
    await store.register({ cfg, accountId: "default", messageId: "10", client, sourceText: `${sourceText}\nReact ✅ to approve`, payload: pending });
    // The result contains additional data that must not enter the edited prompt.
    mocks.resolve.mockResolvedValue({ applied: true, approval: { status: "allowed", decision: "allow-once", presentation: { commandText: "SECRET=extra-data" }, resolver: { kind: "device", id: "private-device" } } });
    await react();
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe("✅ Approved (allow once) by `Ian F`\n\nID: req-1\nCommand:\n```\nprintf 'hello'\n```");
  });
  it.each(["reaction", "command", "observer-race"])("renders the live denial with the known display name via %s", async (surface) => {
    const id = "3982e4af-9ed0-41a4-b044-71509476981b";
    const email = "user8@zlp.pubnerd.app";
    const liveCfg = { channels: { zulip: { ...cfg.channels!.zulip, allowFrom: [email] } } } as OpenClawConfig;
    await store.register({ cfg: liveCfg, accountId: "default", messageId: "10", client, sourceText: "Command: `printf 'zulip-92-desktop-must-not-run\\n'`", payload: payload(id) });
    request.mockImplementation(async (path) => path.startsWith("/users/") ? { result: "success", user: { email, full_name: "Ian F" } } : { result: "success" });
    if (surface === "observer-race") mocks.resolve.mockImplementation(async () => {
      await store.observeTerminal("default", { event: "exec.approval.resolved", payload: { id, decision: "deny", resolvedBy: email } });
      return { applied: true, approval: { status: "denied", decision: "deny" } };
    });
    if (surface === "reaction") await react({ emoji_name: "cross_mark" }, liveCfg);
    else await store.command({ cfg: liveCfg, accountId: "default", senderId: email, senderName: "Ian F", text: `/approve ${id} deny` });
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe(`❌ Denied by \`Ian F\`\n\nID: ${id}\nCommand:\n\`\`\`\nprintf 'zulip-92-desktop-must-not-run\\n'\n\`\`\``);
  });
  it.each([
    ["`echo ``` @**all**`", "echo ``` @**all**", "````"],
    ["``echo``", "``echo``", "```"],
    ["echo `date`", "echo `date`", "```"],
    ["` echo `x` `", " echo `x` ", "```"],
  ])("preserves command bytes other than a single inline wrapper: %s", async (source, expected, fence) => {
    await store.register({ cfg, accountId: "default", messageId: "10", client, sourceText: `Command: ${source}`, payload: payload() });
    await react();
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe(`✅ Approved (allow once) by \`Ian F\`\n\nID: req-1\nCommand:\n${fence}\n${expected}\n${fence}`);
  });
  it("escapes user-controlled command sender names without changing authorization identity", async () => {
    await register();
    await store.command({ cfg, accountId: "default", senderId: "ian@test", senderName: "Ian **F**\n@**all** [link](url) `code` \\slash", text: "/approve req-1 deny" });
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe("❌ Denied by `Ian **F** @**all** [link](url) \u02cbcode\u02cb \\slash`\n\nID: req-1");
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ senderId: "ian@test" }));
  });
  it.each([
    ["https://evil.example", "`https://evil.example`"],
    ["evil.example/login", "`evil.example/login`"],
    ["`x` https://evil.example `y`", "`\u02cbx\u02cb https://evil.example \u02cby\u02cb`"],
  ])("renders display name %s as an inert code span", async (name, rendered) => {
    await register();
    await store.command({ cfg, accountId: "default", senderId: "ian@test", senderName: name, text: "/approve req-1 deny" });
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe(`❌ Denied by ${rendered}\n\nID: req-1`);
  });
  it("does not attribute a different observed winner to the pending command sender", async () => {
    await register();
    mocks.resolve.mockImplementation(async () => {
      await store.observeTerminal("default", { event: "exec.approval.resolved", payload: { id: "req-1", decision: "deny", resolvedBy: "other@test" } });
      return { applied: false, approval: { status: "denied", decision: "deny" } };
    });
    await store.command({ cfg, accountId: "default", senderId: "ian@test", senderName: "Ian F", text: "/approve req-1 deny" });
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe("❌ Denied by `other@test`\n\nID: req-1");
  });
  it("escapes observed actor and ID, preserves command text with longer fences, and caches the winner before delivery", async () => {
    const id = "req-*_[id]";
    await store.observeTerminal("default", { event: "exec.approval.resolved", payload: { id, decision: "allow-always", resolvedBy: "Ian **F**\n@**all** [link](url)", request: { env: "hidden" } } });
    await store.register({ cfg, accountId: "default", messageId: "10", client, sourceText: "Command:\n````sh\necho ``` @**all**\n````\nEnv: hidden", payload: payload(id) });
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe("✅ Approved (allow always) by `Ian **F** @**all** [link](url)`\n\nID: req-\\*\\_\\[id\\]\nCommand:\n````\necho ``` @**all**\n````");
  });
  it.each(["channel", "device"])("attributes an external %s winner without crediting the losing reactor or leaking device IDs", async (kind) => {
    await register();
    mocks.resolve.mockResolvedValue({ applied: false, approval: { status: "denied", decision: "deny", resolver: { kind, id: "winner@test" } } });
    await react();
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe(`${kind === "channel" ? "❌ Denied by `winner@test`" : "Resolved elsewhere: deny"}\n\nID: req-1`);
  });
  it.each([
    ["approval-scope-closed", "⚪ Cancelled: approval session ended before a decision"],
    ["permission-change", "⚪ Cancelled: permissions changed before a decision"],
    ["no-approval-route", "⚪ Closed: no approval route available"],
    ["storage-error", "⚪ Closed: approval storage unavailable"],
    ["worker-dispatch", "⚪ Cancelled: approval session is no longer active"],
  ])("renders core resolver %s without impersonating an approver", async (id, expected) => {
    await register();
    await store.observeTerminal("default", { event: "exec.approval.resolved", payload: { id: "req-1", decision: "deny", resolvedBy: id } });
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe(`${expected}\n\nID: req-1`);
    await react();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
  });
  it("renders a cached system winner when the plugin prompt arrives later", async () => {
    await store.observeTerminal("default", { event: "plugin.approval.resolved", payload: { id: "req-1", decision: "deny", resolvedBy: "approval-scope-closed" } });
    await register("req-1", "10", "default", cfg, "plugin");
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe("⚪ Cancelled: approval session ended before a decision\n\nID: req-1");
  });
  it.each([
    ["system", "future `reason`\n@**all**", "⚪ Closed by the system (`future ˋreasonˋ @**all**`)"],
    ["system", undefined, "⚪ Closed by the system"],
    ["system", "approval-scope-closed", "⚪ Cancelled: approval session ended before a decision"],
    ["channel", "future-reason", "❌ Denied by `future-reason`"],
    ["channel", "zulip:ian@test", "❌ Denied by `zulip:ian@test`"],
  ])("conservatively renders a losing settlement resolver %s/%s", async (kind, id, expected) => {
    await register();
    mocks.resolve.mockResolvedValue({ applied: false, approval: { status: "denied", decision: "deny", resolver: { kind, id } } });
    await react();
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe(`${expected}\n\nID: req-1`);
  });
  it("keeps an allowFrom identity human even when it resembles a core code", async () => {
    const configuration = { channels: { zulip: { ...cfg.channels!.zulip, allowFrom: ["user:approval-scope-closed"] } } } as OpenClawConfig;
    await register("req-1", "10", "default", configuration);
    await store.observeTerminal("default", { event: "exec.approval.resolved", payload: { id: "req-1", decision: "deny", resolvedBy: "approval-scope-closed" } });
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe("❌ Denied by `approval-scope-closed`\n\nID: req-1");
  });
  it.each([
    ["expired", "⌛ Expired"],
    ["cancelled", "⚪ Cancelled by the system"],
  ])("preserves canonical system status %s over its deny decision", async (status, expected) => {
    await register();
    mocks.resolve.mockResolvedValue({ applied: false, approval: { status, decision: "deny", resolver: { kind: "system", id: null } } });
    await react();
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe(`${expected}\n\nID: req-1`);
  });
  it("does not mistake a human display name for a core resolver", async () => {
    await register();
    await store.command({ cfg, accountId: "default", senderId: "ian@test", senderName: "approval-scope-closed", text: "/approve req-1 deny" });
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe("❌ Denied by `approval-scope-closed`\n\nID: req-1");
  });
  it("locks sibling deliveries of the same approval", async () => {
    await register(); await register("req-1", "11"); await Promise.all([react(), react({ message_id: 11 })]);
    expect(mocks.resolve).toHaveBeenCalledTimes(1); expect(request.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2);
  });
  it("preserves plugin owner and denies unsupported decisions", async () => {
    await register("req-1", "10", "default", cfg, "plugin"); await command("/approve req-1 allow-always");
    expect(mocks.resolve).not.toHaveBeenCalled(); await react({ emoji_name: "cross_mark" });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ approvalKind: "plugin", decision: "deny" }));
  });
  it("allows retry after real gateway failures but retires not-found approvals", async () => {
    await register(); mocks.resolve.mockRejectedValueOnce(new Error("database offline")); await expect(react()).rejects.toThrow("database offline");
    mocks.resolve.mockRejectedValueOnce(Object.assign(new Error("approval expired or not found"), { gatewayCode: "APPROVAL_NOT_FOUND" })); await react(); await react(); expect(mocks.resolve).toHaveBeenCalledTimes(2);
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe("⌛ Expired or already resolved\n\nID: req-1");
  });
  it("keeps resolved bindings inert when the terminal edit fails", async () => {
    await register(); request.mockImplementation(async (path, init) => { if (init?.method === "PATCH") throw new Error("edit denied"); return { result: "success", user: { user_id: 2, email: "ian@test" } }; });
    await expect(react()).rejects.toThrow("edit denied"); await react(); expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });
  it("uses configurable Unicode/named emoji and refuses collisions", async () => {
    const config = { channels: { zulip: { url: "https://zulip.test", email: "bot@test", apiKey: "test", allowFrom: ["ian@test"], approvalReactions: { approve: "eyes", deny: "⚠️" } } } } as OpenClawConfig;
    await register("req-1", "10", "default", config); await react({ emoji_name: "eyes" }, config);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ decision: "allow-once" }));
    mocks.resolve.mockClear();
    const collision = { channels: { zulip: { url: "https://zulip.test", email: "bot@test", apiKey: "test", allowFrom: ["ian@test"], approvalReactions: { approve: "check", deny: "✅" } } } } as OpenClawConfig;
    await register("req-2", "20", "default", collision); await react({ message_id: 20 }, collision); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("bounds live bindings without evicting an active decision and frees expired capacity", async () => {
    vi.useFakeTimers(); store = new ZulipApprovalReactions(1); await register(); await register("req-2", "20");
    await react({ message_id: 20 }); expect(mocks.resolve).not.toHaveBeenCalled(); await react(); expect(mocks.resolve).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1); await register("req-3", "30"); await react({ message_id: 30 }); expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });
  it("clears only the removed account and rejects in-flight user lookup after removal", async () => {
    await register();
    let complete!: (value: unknown) => void;
    request.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = react(); await vi.waitFor(() => expect(complete).toBeTypeOf("function")); store.clearAccount("default"); complete({ result: "success", user: { user_id: 2, email: "ian@test" } }); await pending;
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("binds delivered controls without a gateway observation but rejects terminal payloads", async () => {
    await store.register({ cfg, accountId: "default", messageId: "10", client, sourceText: "Approval", payload: payload() });
    await react(); expect(mocks.resolve).toHaveBeenCalledTimes(1);
    const terminal = payload("req-2");
    (terminal.channelData!.execApproval as any).state = "resolved";
    await store.register({ cfg, accountId: "default", messageId: "20", client, sourceText: "Approval", payload: terminal });
    await react({ message_id: 20 }); expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });
});
