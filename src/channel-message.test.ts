import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { verifyChannelMessageAdapterCapabilityProofs } from "./sdk.js";
import { zulipMessageAdapter, zulipOutboundAdapter, zulipPlugin } from "./channel.js";

const adapterState = vi.hoisted(() => ({
  sendMessageZulip: vi.fn(async () => ({ messageId: "msg-1", channelId: "stream" })),
  sendPollZulip: vi.fn(async () => ({ messageId: "poll-1", channelId: "stream" })),
  runtime: {
    logging: {
      getChildLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
    channel: {
      text: {
        chunkMarkdownText: vi.fn((text: string) => [text]),
      },
    },
  },
}));

vi.mock("./zulip/send.js", () => ({
  sendMessageZulip: adapterState.sendMessageZulip,
  sendPollZulip: adapterState.sendPollZulip,
}));

vi.mock("./runtime.js", () => ({
  getZulipRuntime: () => adapterState.runtime,
}));

describe("zulip message adapter", () => {
  beforeEach(() => {
    adapterState.sendMessageZulip.mockClear();
    adapterState.sendPollZulip.mockClear();
  });

  it("exposes the new channel message adapter while keeping outbound compatibility", () => {
    expect(zulipPlugin.outbound).toBe(zulipOutboundAdapter);
    expect(zulipPlugin.message).toBe(zulipMessageAdapter);
    expect(zulipPlugin.message?.send?.text).toBeTypeOf("function");
    expect(zulipPlugin.message?.send?.media).toBeTypeOf("function");
    expect(zulipPlugin.message?.send?.payload).toBeTypeOf("function");
    expect(zulipPlugin.message?.send?.poll).toBeTypeOf("function");
    expect(zulipPlugin.capabilities.polls).toBe(true);
  });

  it("backs declared durable message capabilities", async () => {
    const cfg = { channels: { zulip: {} } } as OpenClawConfig;
    const textCtx = {
      cfg,
      to: "stream:general:polls",
      text: "hello",
      accountId: "default",
    };

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
        adapterName: "zulip",
        adapter: zulipMessageAdapter,
        proofs: {
          text: async () => {
            const result = await zulipMessageAdapter.send!.text!(textCtx);
            expect(result.receipt.platformMessageIds).toContain("msg-1");
          },
          media: async () => {
            const result = await zulipMessageAdapter.send!.media!({
              ...textCtx,
              mediaUrl: "https://example.test/file.png",
            });
            expect(result.receipt.parts[0]?.kind).toBe("media");
          },
          payload: async () => {
            const result = await zulipMessageAdapter.send!.payload!({
              ...textCtx,
              payload: { text: "payload hello" },
            });
            expect(result.receipt.platformMessageIds).toContain("msg-1");
          },
          poll: async () => {
            const result = await zulipMessageAdapter.send!.poll!({
              cfg,
              to: "stream:general:polls",
              accountId: "default",
              poll: {
                question: "Lunch?",
                options: ["Pizza", "Sushi"],
              },
              threadId: "polls",
            });
            expect(result.receipt.parts[0]?.kind).toBe("poll");
            expect(adapterState.sendPollZulip).toHaveBeenCalledWith(
              "stream:general:polls",
              { question: "Lunch?", options: ["Pizza", "Sushi"] },
              expect.objectContaining({ cfg, accountId: "default", topic: "polls" }),
            );
          },
          messageSendingHooks: () => {
            expect(zulipMessageAdapter.durableFinal?.capabilities?.messageSendingHooks).toBe(true);
          },
        },
      });

    expect(proofResults.filter((result) => result.status === "verified")).toEqual([
      { capability: "text", status: "verified" },
      { capability: "media", status: "verified" },
      { capability: "poll", status: "verified" },
      { capability: "payload", status: "verified" },
      { capability: "messageSendingHooks", status: "verified" },
    ]);
  });

  it("passes thread and host media access through non-poll sends", async () => {
    const cfg = { channels: { zulip: {} } } as OpenClawConfig;
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const mediaAccess = { localRoots: ["/tmp/agent-root"], readFile: mediaReadFile };

    await zulipMessageAdapter.send!.text!({
      cfg,
      to: "stream:general",
      text: "threaded",
      accountId: "default",
      threadId: "topic-1",
    });
    expect(adapterState.sendMessageZulip).toHaveBeenLastCalledWith(
      "stream:general",
      "threaded",
      expect.objectContaining({ topic: "topic-1" }),
    );

    await zulipMessageAdapter.send!.media!({
      cfg,
      to: "stream:general",
      text: "media",
      mediaUrl: "/tmp/agent-root/image.png",
      accountId: "default",
      threadId: "topic-2",
      mediaAccess,
      mediaLocalRoots: ["/tmp/agent-root"],
      mediaReadFile,
    });
    expect(adapterState.sendMessageZulip).toHaveBeenLastCalledWith(
      "stream:general",
      "media",
      expect.objectContaining({
        topic: "topic-2",
        mediaAccess,
        mediaLocalRoots: ["/tmp/agent-root"],
        mediaReadFile,
      }),
    );

    await zulipMessageAdapter.send!.payload!({
      cfg,
      to: "stream:general",
      text: "payload",
      payload: { text: "payload" },
      accountId: "default",
      threadId: "topic-3",
    });
    expect(adapterState.sendMessageZulip).toHaveBeenLastCalledWith(
      "stream:general",
      "payload",
      expect.objectContaining({ topic: "topic-3" }),
    );
  });

  it("returns multipart receipts for multi-media payloads", async () => {
    const cfg = { channels: { zulip: {} } } as OpenClawConfig;
    adapterState.sendMessageZulip
      .mockResolvedValueOnce({ messageId: "msg-1", channelId: "stream" })
      .mockResolvedValueOnce({ messageId: "msg-2", channelId: "stream" });

    const result = await zulipMessageAdapter.send!.payload!({
      cfg,
      to: "stream:general",
      text: "gallery",
      payload: { text: "gallery", mediaUrls: ["https://example.test/a.png", "https://example.test/b.png"] },
      accountId: "default",
      threadId: "topic-1",
    });

    expect(result.receipt.primaryPlatformMessageId).toBe("msg-1");
    expect(result.receipt.platformMessageIds).toEqual(["msg-1", "msg-2"]);
    expect(result.receipt.threadId).toBe("topic-1");
    expect(result.receipt.parts.map(({ platformMessageId, kind, threadId }) => ({ platformMessageId, kind, threadId }))).toEqual([
      { platformMessageId: "msg-1", kind: "media", threadId: "topic-1" },
      { platformMessageId: "msg-2", kind: "media", threadId: "topic-1" },
    ]);
  });
});
