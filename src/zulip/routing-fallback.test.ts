import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../sdk.js";
import { zulipMessageAdapter, zulipPlugin } from "../channel.js";
import { zulipMessageActions } from "../actions.js";
import { resolveZulipOutboundSessionRoute } from "../session-conversation.js";
import { resolveZulipDestination } from "./destination.js";
import { sendMessageZulip } from "./send.js";

const runtime = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../runtime.js", () => ({
  getZulipRuntime: () => ({
    logging: { getChildLogger: () => ({ debug: vi.fn(), warn: runtime.warn, error: vi.fn() }) },
    channel: {
      text: { resolveMarkdownTableMode: () => "preserve", convertMarkdownTables: (text: string) => text },
      activity: { record: vi.fn() },
    },
  }),
}));

const config = {
  apiKey: "synthetic-key",
  email: "bot@example.test",
  url: "https://zulip.example.test",
};
const cfg = { channels: { zulip: config } } as OpenClawConfig;
const identity = `42:topic:v2:${"a".repeat(64)}`;
const to = `channel:${identity}`;
const mediaUrl = `${config.url}/user_uploads/synthetic.png`;
const modes = ["text", "media", "multipart", "poll"] as const;

function send(mode: typeof modes[number]) {
  const ctx = { cfg, to, text: "Original completion", accountId: "default" };
  switch (mode) {
    case "text": return zulipMessageAdapter.send!.text!(ctx);
    case "media": return zulipMessageAdapter.send!.media!({ ...ctx, mediaUrl });
    case "multipart": return zulipMessageAdapter.send!.payload!({ ...ctx, payload: { text: ctx.text, mediaUrls: [mediaUrl, mediaUrl] } });
    case "poll": return zulipMessageAdapter.send!.poll!({ ...ctx, poll: { question: ctx.text, options: ["One", "Two"] } });
  }
}

describe("unroutable Zulip message fallback", () => {
  const bodies: URLSearchParams[] = [];
  const fetchMock = vi.fn<typeof fetch>();
  let ownerAvailable = true;
  let ownerActive = true;
  let rejectSend = false;

  beforeEach(() => {
    bodies.length = 0;
    ownerAvailable = true;
    ownerActive = true;
    rejectSend = false;
    runtime.warn.mockClear();
    fetchMock.mockReset().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/users/me") return Response.json({ result: "success", user_id: 7 });
      if (path === "/api/v1/users/7") return Response.json({ result: "success", user: { user_id: 7, is_bot: true, bot_owner_id: ownerAvailable ? 8 : null } });
      if (path === "/api/v1/users/8") return Response.json({ result: "success", user: { user_id: 8, email: "owner@example.test", is_active: ownerActive, is_bot: false } });
      expect(path).toBe("/api/v1/messages");
      expect(init?.method).toBe("POST");
      bodies.push(new URLSearchParams(String(init?.body)));
      return rejectSend
        ? Response.json({ result: "error", msg: "synthetic send rejection" }, { status: 403 })
        : Response.json({ result: "success", id: 100 + bodies.length });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(modes)("delivers %s to the discovered owner with notice and actual receipt", async (mode) => {
    const normalized = zulipPlugin.messaging!.normalizeTarget!(to);
    expect(normalized).toBe(to);
    expect(await resolveZulipOutboundSessionRoute({ cfg, agentId: "main", target: normalized! })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const result = await send(mode);
    expect(bodies).toHaveLength(mode === "multipart" ? 2 : 1);
    expect(bodies[0].get("content")).toContain("Original completion");
    for (const body of bodies) {
      expect(body.get("type")).toBe("private");
      expect(body.get("to")).toBe('["owner@example.test"]');
      expect(body.get("content")).toContain("OpenClaw routing fallback");
      expect(body.get("content")).toContain(identity);
      expect(body.has("topic")).toBe(false);
    }
    expect(result.receipt.threadId).toBeUndefined();
    expect(result.receipt.replyToId).toBeUndefined();
    for (const part of result.receipt.parts) {
      expect(part.threadId).toBeUndefined();
      expect(part.raw).toMatchObject({
        channelId: "owner@example.test", target: { kind: "chat", id: "owner@example.test" },
        meta: { routingFallback: { requestedTarget: to, selectedAccountId: "default", recipient: "bot-owner", reason: "missing-delivery-context" } },
      });
    }
    expect(runtime.warn).toHaveBeenCalledWith("zulip routing fallback", expect.objectContaining({ requestedTarget: to, destination: "user:owner@example.test" }));
  });

  it("uses the configured diagnostics topic when the bot has no discoverable owner", async () => {
    ownerAvailable = false;
    const fallbackCfg = { channels: { zulip: { ...config, routingDiagnosticsTarget: "stream:42:openclaw-diagnostics" } } } as OpenClawConfig;
    const result = await zulipMessageAdapter.send!.text!({ cfg: fallbackCfg, to, text: "Recover this" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].get("type")).toBe("stream");
    expect(bodies[0].get("to")).toBe("42");
    expect(bodies[0].get("topic")).toBe("openclaw-diagnostics");
    expect(bodies[0].get("content")).toContain("configured diagnostics topic");
    expect(bodies[0].get("content")).toContain("Recover this");
    expect(result.receipt.threadId).toBe("openclaw-diagnostics");
    expect(result.receipt.parts[0].raw).toMatchObject({ channelId: "42", meta: { routingFallback: { recipient: "diagnostics" } } });
  });

  it.each([identity, `group:${identity}`, `agent:main:zulip:channel:${identity}`, `user:account-${"b".repeat(64)}:person@example.test`])(
    "recovers recognized session-only targets without treating them as addresses: %s", async (target) => {
      expect(zulipPlugin.messaging!.normalizeTarget!(target)).toBe(target);
      expect(await resolveZulipOutboundSessionRoute({ cfg, agentId: "main", target })).toBeNull();
      const result = await sendMessageZulip(target, "Original", { cfg });
      expect(result.channelId).toBe("owner@example.test");
      expect(result.meta?.routingFallback.requestedTarget).toBe(target);
      expect(bodies[0].get("to")).toBe('["owner@example.test"]');
    },
  );

  it("never guesses a stream when owner discovery and configured backup are unavailable", async () => {
    ownerActive = false;
    await expect(send("text")).rejects.toThrow("configure routingDiagnosticsTarget");
    expect(bodies).toHaveLength(0);
  });

  it.each(["stream:42", "user:somebody@example.test", to])("refuses an invalid diagnostic backup %s", async (routingDiagnosticsTarget) => {
    ownerAvailable = false;
    const invalidCfg = { channels: { zulip: { ...config, routingDiagnosticsTarget } } } as OpenClawConfig;
    await expect(sendMessageZulip(to, "Original", { cfg: invalidCfg })).rejects.toThrow();
    expect(bodies).toHaveLength(0);
  });

  it("uses the explicitly selected account for owner lookup and describes that selection", async () => {
    const workCfg = { channels: { zulip: { accounts: { work: { ...config, email: "work-bot@example.test", apiKey: "work-key" } } } } } as OpenClawConfig;
    const result = await sendMessageZulip(to, "Original", { cfg: workCfg, accountId: "work" });
    expect(result.meta?.routingFallback.selectedAccountId).toBe("work");
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${Buffer.from("work-bot@example.test:work-key").toString("base64")}`);
    }
    expect(bodies[0].get("content")).toContain('"selectedAccountId":"work"');
  });

  it.each(["stream:42:Original", to])("does not reroute an actual send failure: %s", async (target) => {
    rejectSend = true;
    const fallbackCfg = { channels: { zulip: { ...config, routingDiagnosticsTarget: "stream:42:openclaw-diagnostics" } } } as OpenClawConfig;
    await expect(sendMessageZulip(target, "Original", { cfg: fallbackCfg })).rejects.toThrow("synthetic send rejection");
    expect(bodies).toHaveLength(1);
    if (target !== to) expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary destinations and literal hash-like topics on their requested route", async () => {
    expect(() => resolveZulipDestination(to)).toThrow("not message destinations");
    await sendMessageZulip(`stream:42:${identity}`, "Original", { cfg });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies[0].get("topic")).toBe(identity);
    expect(bodies[0].get("content")).toBe("Original");
  });

  it("keeps malformed recipient errors separate from recoverable session targets", async () => {
    await expect(sendMessageZulip("user:user:bad", "Original", { cfg })).rejects.toThrow("Invalid Zulip direct-message target");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports action sends and previews without discovery or sending during dry run", async () => {
    const ctx = { channel: "zulip", action: "send" as const, cfg, params: { to, message: "Action completion" } };
    await zulipMessageActions.handleAction!({ ...ctx, dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
    const result = await zulipMessageActions.handleAction!(ctx);
    expect(result).toMatchObject({ details: { success: true, to: "user:owner@example.test", routingFallback: { requestedTarget: to } } });
    expect(bodies[0].get("content")).toContain("Action completion");
    expect(bodies[0].get("content")).toContain("OpenClaw routing fallback");
  });
});
