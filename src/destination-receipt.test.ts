import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zulipMessageAdapter } from "./channel.js";
import { resolveZulipOutboundSessionRoute } from "./session-conversation.js";
import type { OpenClawConfig } from "./sdk.js";

const state = vi.hoisted(() => ({
  debug: vi.fn(),
  account: {
    accountId: "default",
    apiKey: "synthetic-test-key",
    email: "bot@example.test",
    baseUrl: "https://zulip.example.test",
    config: {} as { defaultTopic?: string },
  },
}));

vi.mock("./runtime.js", () => ({
  getZulipRuntime: () => ({
    logging: { getChildLogger: () => ({ debug: state.debug, warn: vi.fn(), error: vi.fn() }) },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "preserve",
        convertMarkdownTables: (text: string) => text,
      },
      activity: { record: vi.fn() },
    },
  }),
}));

vi.mock("./zulip/accounts.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./zulip/accounts.js")>(),
  resolveZulipRuntimeAccount: async () => state.account,
}));

const cfg = {
  channels: { zulip: { url: state.account.baseUrl, email: state.account.email } },
} as OpenClawConfig;
const mediaUrl = "https://zulip.example.test/user_uploads/synthetic.png";
const modes = ["text", "media", "payload", "multipart", "poll"] as const;
type Mode = typeof modes[number];

function send(mode: Mode, to: string, threadId?: string | number | null, replyToId?: string, sendCfg = cfg) {
  const ctx = { cfg: sendCfg, to, threadId, replyToId, accountId: "default", text: "synthetic" };
  switch (mode) {
    case "text": return zulipMessageAdapter.send!.text!(ctx);
    case "media": return zulipMessageAdapter.send!.media!({ ...ctx, mediaUrl });
    case "payload": return zulipMessageAdapter.send!.payload!({ ...ctx, payload: { text: ctx.text } });
    case "multipart": return zulipMessageAdapter.send!.payload!({
      ...ctx, payload: { text: ctx.text, mediaUrls: [mediaUrl, mediaUrl] },
    });
    case "poll": return zulipMessageAdapter.send!.poll!({
      ...ctx, threadId: threadId == null ? threadId : String(threadId),
      poll: { question: "Synthetic?", options: ["One", "Two"] },
    });
  }
}

describe("raw destination, wire request, and explicit receipt agreement", () => {
  const bodies: URLSearchParams[] = [];
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    state.account.config = {};
    bodies.length = 0;
    state.debug.mockClear();
    fetchMock.mockReset().mockImplementation(async (url, init) => {
      expect(url).toBe("https://zulip.example.test/api/v1/messages");
      expect(init?.method).toBe("POST");
      bodies.push(new URLSearchParams(String(init?.body)));
      return Response.json({ result: "success", id: 100 + bodies.length });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  describe.each(modes)("%s", (mode) => {
    it.each([
      { to: "stream:42", threadId: undefined, expected: "Bot replies" },
      { to: "stream:42", threadId: "", expected: "" },
      { to: "stream:42:", threadId: "inherited", expected: "" },
    ])("agrees on configured defaults and empty-topic overrides: $to / $threadId", async ({ to, threadId, expected }) => {
      state.account.config = { defaultTopic: "Bot replies" };
      const sendCfg = { channels: { zulip: { ...cfg.channels!.zulip, defaultTopic: "Bot replies" } } } as OpenClawConfig;
      const route = await resolveZulipOutboundSessionRoute({ cfg: sendCfg, agentId: "main", target: to, threadId });
      const result = await send(mode, to, threadId, undefined, sendCfg);
      expect(route).toMatchObject({ threadId: expected, to: `stream:42:${expected}` });
      expect(result.receipt.threadId).toBe(expected);
      for (const part of result.receipt.parts) expect(part.threadId).toBe(expected);
      for (const body of bodies) expect(body.get("topic")).toBe(expected);
    });

    it.each([
      { to: "stream:42:Canonical Topic", threadId: "Different Session Topic", topic: "Canonical Topic" },
      { to: "stream:42", threadId: "Inherited Topic", topic: "Inherited Topic" },
      { to: "stream:42", threadId: undefined, topic: "general" },
      { to: "stream:42:", threadId: "", topic: "" },
      { to: "stream:42", threadId: "   ", topic: "" },
      { to: "stream:42", threadId: " Inherited Topic ", topic: "Inherited Topic" },
      { to: "stream:42", threadId: 123, topic: "123" },
      { to: "#42/Canonical Topic", threadId: "other", topic: "Canonical Topic" },
      { to: "stream:42#Canonical Topic", threadId: "other", topic: "Canonical Topic" },
      { to: "42:topic:Canonical Topic", threadId: "other", topic: "Canonical Topic", stream: "42" },
    ])("matches route, API topic, logs and every receipt part: $to / $threadId", async ({ to, threadId, topic, stream }) => {
      const route = await resolveZulipOutboundSessionRoute({ cfg, agentId: "main", target: to, threadId });
      const result = await send(mode, to, threadId);
      expect(route).toMatchObject({ to: `stream:${stream ?? "42"}:${topic}`, threadId: topic });
      expect(bodies).toHaveLength(mode === "multipart" ? 2 : 1);
      expect(result.receipt.threadId).toBe(topic);
      expect(result.receipt.platformMessageIds).toEqual(bodies.map((_, i) => String(101 + i)));
      expect(result.receipt.parts).toHaveLength(bodies.length);
      bodies.forEach((body, index) => {
        expect(body.get("type")).toBe("stream");
        expect(body.get("to")).toBe(stream ?? "42");
        expect(body.get("topic")).toBe(topic);
        expect(result.receipt.parts[index]?.threadId).toBe(body.get("topic"));
        expect(result.receipt.parts[index]?.platformMessageId).toBe(String(101 + index));
      });
      for (const event of ["zulip outbound send start", "zulip outbound send success"]) {
        expect(state.debug).toHaveBeenCalledWith(event, expect.objectContaining({ topic }));
      }
    });

    it.each(["user:alice@example.test", "dm:alice@example.test", "@alice@example.test", "zulip:alice@example.test", "alice@example.test"])("preserves DM sends without fabricating topic receipts: %s", async (to) => {
      const route = await resolveZulipOutboundSessionRoute({ cfg, agentId: "main", target: to, threadId: "unrelated" });
      const result = await send(mode, to, "unrelated");
      expect(route).toMatchObject({ chatType: "direct", to: "user:alice@example.test" });
      expect(result.receipt.threadId).toBeUndefined();
      for (const part of result.receipt.parts) expect(part.threadId).toBeUndefined();
      for (const body of bodies) {
        expect(body.get("type")).toBe("private");
        expect(body.get("to")).toBe('["alice@example.test"]');
        expect(body.has("topic")).toBe(false);
      }
    });

    it("does not let a reply message ID override an explicit destination or invent a reply receipt", async () => {
      const result = await send(mode, "stream:42:Canonical Topic", "other", "9876");
      expect(result.receipt.threadId).toBe("Canonical Topic");
      expect(result.receipt.replyToId).toBeUndefined();
      for (const part of result.receipt.parts) expect(part.replyToId).toBeUndefined();
      expect(bodies.every((body) => body.get("topic") === "Canonical Topic")).toBe(true);
    });

    it("propagates API failure rather than returning a success receipt", async () => {
      fetchMock.mockResolvedValue(Response.json({ result: "error", msg: "synthetic rejection" }, { status: 400 }));
      await expect(send(mode, "stream:42:Canonical Topic")).rejects.toThrow("synthetic rejection");
    });
  });

  it("never interprets a reply message ID as a topic", async () => {
    const route = await resolveZulipOutboundSessionRoute({
      cfg, agentId: "main", target: "stream:42", replyToId: "9876", threadId: "Raw Topic",
    });
    expect(route).toMatchObject({ to: "stream:42:Raw Topic", threadId: "Raw Topic" });
    const result = await send("text", route!.to, "Raw Topic", "9876");
    expect(result.receipt.threadId).toBe("Raw Topic");
    expect(bodies[0]?.get("topic")).toBe("Raw Topic");
  });

  it("rejects missing targets without falling back to lastTo", async () => {
    expect(await resolveZulipOutboundSessionRoute({ cfg, agentId: "main", target: "" })).toBeNull();
    await expect(send("text", "")).rejects.toThrow("Recipient is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
