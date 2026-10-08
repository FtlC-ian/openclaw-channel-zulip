import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExecApprovalPendingReplyPayload, buildTypedExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import { buildApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "../sdk.js";
import type { ZulipClient, ZulipEvent } from "./client.js";
import { ZulipApprovalReactions, createZulipApprovalObserver, zulipApprovalReactions } from "./approval-reactions.js";
import { readApprovalBinding } from "./approval-sdk.js";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), create: vi.fn() }));
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({ resolveApprovalOverGateway: mocks.resolve }));
vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({ createExecApprovalChannelRuntime: mocks.create }));

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
  store.observe(accountId, id, kind, Date.now() + 60000);
  await store.register({ cfg: configuration, accountId, messageId, client, sourceText: "Approval required", payload: payload(id, kind) });
}
async function react(overrides: Partial<ZulipEvent> = {}, configuration = cfg, accountId = "default") {
  await store.react({ cfg: configuration, accountId, client, botUserId: "1", event: event(overrides) });
}
const command = (text = "/approve req-1 deny") => store.command({ cfg, accountId: "default", senderId: "ian@test", text });
beforeEach(() => {
  store = new ZulipApprovalReactions();
  request = vi.fn(async (path: string) => path.startsWith("/users/") ? { result: "success", user: { user_id: 2, email: "ian@test", is_bot: false, is_active: true } } : { result: "success" });
  client = { baseUrl: "https://zulip.test", authHeader: "test", fetchImpl: vi.fn(async (url, init) => new Response(JSON.stringify(await request(new URL(String(url)).pathname.replace("/api/v1", ""), init)), { status: 200 })), request } as ZulipClient;
  mocks.resolve.mockReset().mockImplementation(async (params) => ({ applied: true, approval: { status: params.decision === "deny" ? "denied" : "allowed", decision: params.decision } }));
  mocks.create.mockReset();
});
afterEach(() => { vi.useRealTimers(); zulipApprovalReactions.clearAccount("default"); zulipApprovalReactions.clearAccount("other"); });

describe("approval reaction control boundary", () => {
  it.each([buildExecApprovalPendingReplyPayload, buildTypedExecApprovalPendingReplyPayload])("accepts SDK exec pending payloads without a state field", async (build) => {
    const pending = build({ approvalId: "req-1", approvalSlug: "req-1", command: "true", host: "gateway", allowedDecisions: ["allow-once", "deny"] });
    expect(readApprovalBinding({ payload: pending })).toMatchObject({ approvalId: "req-1", approvalKind: "exec" });
    store.observe("default", "req-1", "exec", Date.now() + 60000);
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
    expect(request).toHaveBeenCalledWith("/messages/10", expect.objectContaining({ method: "PATCH", body: expect.stringContaining("allow-once") }));
    const edit = new URLSearchParams(request.mock.calls.find(([, init]) => init?.method === "PATCH")![1].body).get("content");
    expect(edit).toBe("Approval required\n\n**Approval outcome: allow-once**\nThese controls are no longer active.");
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
    complete({ result: "success", user: { user_id: 2, email: "ian@test" } }); await pending;
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("consumes an aborted manual approval without resolving it", async () => {
    await register();
    const controller = new AbortController(); controller.abort();
    expect(await store.command({ cfg, accountId: "default", senderId: "ian@test", text: "/approve req-1 allow-once", abortSignal: controller.signal })).toBe(true);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("ignores expired bindings before invoking identity or resolver", async () => {
    vi.useFakeTimers(); await register(); vi.advanceTimersByTime(60001); request.mockClear(); await react();
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
    expect(new URLSearchParams(patch[1].body).get("content")).toContain("outcome: deny");
    await react(); expect(mocks.resolve).toHaveBeenCalledTimes(1);
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
  it("terminalizes externally resolved or expired approvals without a local decision", async () => {
    await register(); await store.terminalize("default", "req-1", "expired"); await react();
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledWith("/messages/10", expect.objectContaining({ method: "PATCH" }));
  });
  it("allows retry after real gateway failures but retires not-found approvals", async () => {
    await register(); mocks.resolve.mockRejectedValueOnce(new Error("database offline")); await expect(react()).rejects.toThrow("database offline");
    mocks.resolve.mockRejectedValueOnce(Object.assign(new Error("approval expired or not found"), { gatewayCode: "APPROVAL_NOT_FOUND" })); await react(); await react(); expect(mocks.resolve).toHaveBeenCalledTimes(2);
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
    vi.advanceTimersByTime(60001); await register("req-3", "30"); await react({ message_id: 30 }); expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });
  it("clears only the removed account and rejects in-flight user lookup after removal", async () => {
    await register();
    let complete!: (value: unknown) => void;
    request.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = react(); store.clearAccount("default"); complete({ result: "success", user: { user_id: 2, email: "ian@test" } }); await pending;
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("does not bind unobserved, mismatched or already terminal canonical requests", async () => {
    await store.register({ cfg, accountId: "default", messageId: "10", client, sourceText: "Approval", payload: payload() });
    await react(); expect(mocks.resolve).not.toHaveBeenCalled();
    store.observe("default", "req-1", "plugin", Date.now() + 60000);
    await store.register({ cfg, accountId: "default", messageId: "10", client, sourceText: "Approval", payload: payload() });
    await react(); expect(mocks.resolve).not.toHaveBeenCalled();
    store.clearAccount("default"); store.observe("default", "req-1", "exec", Date.now() + 60000); await store.terminalize("default", "req-1", "deny");
    await store.register({ cfg, accountId: "default", messageId: "10", client, sourceText: "Approval", payload: payload() });
    await react(); expect(mocks.resolve).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledWith("/messages/10", expect.objectContaining({ method: "PATCH" }));
  });
});

describe("gateway approval observer", () => {
  it("uses SDK lifecycle events, account selection and authoritative expiry", async () => {
    await createZulipApprovalObserver(() => cfg, "default");
    const adapter = mocks.create.mock.calls[0][0];
    const approval = { id: "req-1", approvalKind: "exec", createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000, request: { command: "true", turnSourceChannel: "zulip", turnSourceAccountId: "default" } };
    expect(adapter.shouldHandle(approval)).toBe(true);
    expect(adapter.shouldHandle({ ...approval, request: { ...approval.request, turnSourceAccountId: "other" } })).toBe(false);
    expect(adapter.shouldHandle({ ...approval, request: { ...approval.request, turnSourceChannel: "signal" } })).toBe(false);
    await adapter.deliverRequested(approval);
    await zulipApprovalReactions.register({ cfg, accountId: "default", messageId: "10", client, sourceText: "Approval", payload: payload() });
    await adapter.finalizeResolved({ resolved: { id: "req-1", decision: "deny" } });
    await zulipApprovalReactions.react({ cfg, accountId: "default", client, botUserId: "1", event: event() });
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledWith("/messages/10", expect.objectContaining({ method: "PATCH" }));
    await adapter.onStopped();
  });
});

describe("unavailable public observer SDK", () => {
  it("disables reactions once without blocking startup or binding controls", async () => {
    vi.resetModules();
    vi.doMock("openclaw/plugin-sdk/infra-runtime", () => ({}));
    try {
      const module = await import("./approval-reactions.js");
      const log = vi.fn();
      for (const accountId of ["default", "other"]) {
        const observer = await module.createZulipApprovalObserver(() => cfg, accountId, log);
        await observer.start();
        await module.zulipApprovalReactions.register({ cfg, accountId, messageId: "10", client, sourceText: "Approval", payload: payload() });
        expect(await module.zulipApprovalReactions.command({ cfg, accountId, senderId: "ian@test", text: "/approve req-1 deny" })).toBe(false);
        await observer.stop();
      }
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("zform and /approve remain available"));
      expect(request).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("openclaw/plugin-sdk/infra-runtime");
      vi.resetModules();
    }
  });
});
