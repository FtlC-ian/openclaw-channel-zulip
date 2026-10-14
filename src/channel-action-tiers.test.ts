import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zulipMessageAdapter, zulipOutboundAdapter } from "./channel.js";
import { setZulipRuntime } from "./runtime.js";
import { sendMessageZulip } from "./zulip/send.js";
import * as accounts from "./zulip/accounts.js";

const config = (messages: "on" | "off") => ({ channels: { zulip: {
  url: "https://zulip.example.test", email: "bot@example.test", apiKey: "test-key",
  actionTiers: { messages, moderation: "off", streamAdmin: "off" },
} } });
const routes = ["text", "media", "payload", "poll"] as const;
function context(cfg: ReturnType<typeof config>) {
  return { cfg, to: "user:alice@example.test", text: "hello", payload: { text: "hello" },
    poll: { question: "Choose", options: ["A", "B"] } };
}

describe("core-owned Zulip action-tier dispatch", () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: "success", id: 42 }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchImpl);
    setZulipRuntime({ logging: { getChildLogger: () => ({ debug: vi.fn(), warn: vi.fn() }) },
      channel: { text: { resolveMarkdownTableMode: () => "preserve", convertMarkdownTables: (s: string) => s },
        activity: { record: vi.fn() } } } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(routes)("rejects core message bridge %s before runtime credentials or network", async (route) => {
    const cfg = config("off");
    Object.assign(cfg.channels.zulip, { apiKey: { source: "env", provider: "default", id: "SECRET_KEY" } });
    const credentialResolution = vi.spyOn(accounts, "resolveZulipRuntimeAccount");
    const send = zulipMessageAdapter.send![route]!;
    await expect(send(context(cfg) as never)).rejects.toThrow(/actionTiers.messages/);
    expect(credentialResolution).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(routes)("rejects legacy core outbound %s before runtime credentials or network", async (route) => {
    const credentialResolution = vi.spyOn(accounts, "resolveZulipRuntimeAccount");
    const method = { text: "sendText", media: "sendMedia", payload: "sendPayload", poll: "sendPoll" }[route] as "sendText" | "sendMedia" | "sendPayload" | "sendPoll";
    await expect(zulipOutboundAdapter[method]!(context(config("off")) as never)).rejects.toThrow(/actionTiers.messages/);
    expect(credentialResolution).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["text", "poll"] as const)("preserves opted-in core %s delivery", async (route) => {
    const result = await zulipMessageAdapter.send![route]!(context(config("on")) as never);
    expect(result.messageId).toBe("42");
    expect(fetchImpl).toHaveBeenCalled();
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/messages");
  });

  it("preserves ordinary inbound reply delivery with messages off", async () => {
    // monitor.ts uses this internal reply entrypoint, not the core outbound adapter.
    const result = await sendMessageZulip("user:alice@example.test", "ordinary reply", { cfg: config("off") });
    expect(result.messageId).toBe("42");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
