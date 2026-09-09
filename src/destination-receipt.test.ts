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
    config: {},
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

function send(mode: Mode, to: string, threadId?: string | number | null, replyToId?: string) {
  const ctx = { cfg, to, threadId, replyToId, accountId: "default", text: "synthetic" };
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
      { to: "stream:synthetic:Canonical Topic", threadId: "Different Session Topic", topic: "Canonical Topic" },
      { to: "stream:synthetic", threadId: "Inherited Topic", topic: "Inherited Topic" },
      { to: "stream:synthetic", threadId: undefined, topic: "general" },
      { to: "stream:synthetic:", threadId: "", topic: "general" },
      { to: "stream:synthetic", threadId: "   ", topic: "general" },
      { to: "stream:synthetic", threadId: " Inherited Topic ", topic: "Inherited Topic" },
      { to: "stream:synthetic", threadId: 123, topic: "123" },
      { to: "#synthetic/Canonical Topic", threadId: "other", topic: "Canonical Topic" },
      { to: "stream:synthetic#Canonical Topic", threadId: "other", topic: "Canonical Topic" },
      { to: "42:topic:Canonical Topic", threadId: "other", topic: "Canonical Topic", stream: "42" },
    ])("matches route, API topic, logs and every receipt part: $to / $threadId", async ({ to, threadId, topic, stream }) => {
      const route = resolveZulipOutboundSessionRoute({ cfg, agentId: "main", target: to, threadId });
      const result = await send(mode, to, threadId);
      expect(route).toMatchObject({ to: `stream:${stream ?? "synthetic"}:${topic}`, threadId: topic });
      expect(bodies).toHaveLength(mode === "multipart" ? 2 : 1);
      expect(result.receipt.threadId).toBe(topic);
      expect(result.receipt.platformMessageIds).toEqual(bodies.map((_, i) => String(101 + i)));
      expect(result.receipt.parts).toHaveLength(bodies.length);
      bodies.forEach((body, index) => {
        expect(body.get("type")).toBe("stream");
        expect(body.get("to")).toBe(stream ?? "synthetic");
        expect(body.get("topic")).toBe(topic);
        expect(result.receipt.parts[index]?.threadId).toBe(body.get("topic"));
        expect(result.receipt.parts[index]?.platformMessageId).toBe(String(101 + index));
      });
      for (const event of ["zulip outbound send start", "zulip outbound send success"]) {
        expect(state.debug).toHaveBeenCalledWith(event, expect.objectContaining({ topic }));
      }
    });

    it.each(["user:alice@example.test", "dm:alice@example.test", "@alice@example.test", "zulip:alice@example.test", "alice@example.test"])("preserves DM sends without fabricating topic receipts: %s", async (to) => {
      const route = resolveZulipOutboundSessionRoute({ cfg, agentId: "main", target: to, threadId: "unrelated" });
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
      const result = await send(mode, "stream:synthetic:Canonical Topic", "other", "9876");
      expect(result.receipt.threadId).toBe("Canonical Topic");
      expect(result.receipt.replyToId).toBeUndefined();
      for (const part of result.receipt.parts) expect(part.replyToId).toBeUndefined();
      expect(bodies.every((body) => body.get("topic") === "Canonical Topic")).toBe(true);
    });

    it("propagates API failure rather than returning a success receipt", async () => {
      fetchMock.mockResolvedValue(Response.json({ result: "error", msg: "synthetic rejection" }, { status: 400 }));
      await expect(send(mode, "stream:synthetic:Canonical Topic")).rejects.toThrow("synthetic rejection");
    });
  });

  it("keeps the legacy route-only replyToId topic boundary explicit", async () => {
    const route = resolveZulipOutboundSessionRoute({
      cfg, agentId: "main", target: "stream:synthetic", replyToId: "Raw Topic", threadId: "raw-topic",
    });
    expect(route).toMatchObject({ to: "stream:synthetic:Raw Topic", threadId: "Raw Topic" });
    const result = await send("text", route!.to, "raw-topic", "Raw Topic");
    expect(result.receipt.threadId).toBe("Raw Topic");
    expect(bodies[0]?.get("topic")).toBe("Raw Topic");
  });

  it("rejects missing targets without falling back to lastTo", async () => {
    expect(resolveZulipOutboundSessionRoute({ cfg, agentId: "main", target: "" })).toBeNull();
    await expect(send("text", "")).rejects.toThrow("Recipient is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
