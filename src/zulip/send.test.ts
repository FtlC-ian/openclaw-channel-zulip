import { describe, expect, it, vi } from "vitest";
import {
  presentationToZulipWidgetContent,
  normalizeLegacyZulipTarget,
  pollToZulipWidgetContent,
  resolveZulipWidgetContent,
  sendMessageZulip,
  sendPollZulip,
} from "./send.js";

describe("presentationToZulipWidgetContent", () => {
  it("maps shared button payloads to Zulip zform widgets", () => {
    expect(
      presentationToZulipWidgetContent({
        blocks: [
          { type: "text", text: "Approval Request" },
          {
            type: "buttons",
            buttons: [
              { label: "Allow Once", action: { type: "command", command: "/approve req-1 allow-once" }, style: "success" },
              { label: "Deny", action: { type: "command", command: "/approve req-1 deny" }, style: "danger" },
            ],
          },
        ],
      }),
    ).toEqual({
      widget_type: "zform",
      extra_data: {
        type: "choices",
        heading: "Approval Request",
        choices: [
          {
            type: "multiple_choice",
            short_name: "Allow Once",
            long_name: "Allow Once",
            reply: "/approve req-1 allow-once",
          },
          {
            type: "multiple_choice",
            short_name: "Deny",
            long_name: "Deny",
            reply: "/approve req-1 deny",
          },
        ],
      },
    });
  });

  it("skips URL-only or missing-value buttons", () => {
    expect(
      presentationToZulipWidgetContent({
        blocks: [
          { type: "text", text: "Approval Request" },
          {
            type: "buttons",
            buttons: [
              { label: "Docs", action: { type: "url", url: "https://example.test/docs" } },
              { label: "Blank", action: { type: "callback", value: "   " } },
              { label: "Allow Once", action: { type: "command", command: "/approve req-1 allow-once" } },
            ],
          },
        ],
      }),
    ).toEqual({
      widget_type: "zform",
      extra_data: {
        type: "choices",
        heading: "Approval Request",
        choices: [
          {
            type: "multiple_choice",
            short_name: "Allow Once",
            long_name: "Allow Once",
            reply: "/approve req-1 allow-once",
          },
        ],
      },
    });
  });

  it("preserves callback values and the presentation heading", () => {
    expect(presentationToZulipWidgetContent({
      title: "Pick a topic",
      blocks: [{ type: "buttons", buttons: [
        { label: "Support", action: { type: "callback", value: "topic:support" } },
      ] }],
    })).toMatchObject({ extra_data: {
      heading: "Pick a topic",
      choices: [{ reply: "topic:support" }],
    } });
  });

  it("returns undefined when there are no buttons", () => {
    expect(presentationToZulipWidgetContent({ blocks: [{ type: "text", text: "hi" }] })).toBeUndefined();
  });
});

describe("pollToZulipWidgetContent", () => {
  it("maps generic polls to Zulip zform choices", () => {
    expect(
      pollToZulipWidgetContent({
        question: "Lunch?",
        options: ["Pizza", "Sushi", "  "],
        maxSelections: 2,
      }),
    ).toEqual({
      widget_type: "zform",
      extra_data: {
        type: "choices",
        heading: "Lunch?",
        poll: true,
        max_selections: 2,
        choices: [
          {
            type: "multiple_choice",
            short_name: "Pizza",
            long_name: "Pizza",
            reply: "Pizza",
          },
          {
            type: "multiple_choice",
            short_name: "Sushi",
            long_name: "Sushi",
            reply: "Sushi",
          },
        ],
      },
    });
  });
});

describe("normalizeLegacyZulipTarget", () => {
  it("converts raw stream-id topic targets into stream targets", () => {
    expect(normalizeLegacyZulipTarget("3:topic:polymarket")).toEqual({
      normalized: "stream:3:polymarket",
      convertedFromLegacy: true,
    });
  });

  it("leaves already-normalized targets alone", () => {
    expect(normalizeLegacyZulipTarget("stream:general:polymarket")).toEqual({
      normalized: "stream:general:polymarket",
      convertedFromLegacy: false,
    });
  });

  it("does not auto-convert malformed dm-like targets", () => {
    expect(normalizeLegacyZulipTarget("user:user:user8@zlp.pubnerd.app")).toEqual({
      normalized: "user:user:user8@zlp.pubnerd.app",
      convertedFromLegacy: false,
    });
  });
});

const sendState = vi.hoisted(() => {
  const sendZulipPrivateMessage = vi.fn(async () => ({ id: 9001 }));
  const sendZulipStreamMessage = vi.fn(async () => ({ id: 9002 }));
  return {
    runtime: {
      config: {},
      logging: {
        getChildLogger: () => ({ debug: vi.fn(), warn: vi.fn() }),
      },
      channel: {
        media: {
          readRemoteMediaBuffer: vi.fn(),
          saveMediaBuffer: vi.fn(),
        },
        text: {
          resolveMarkdownTableMode: vi.fn(() => "preserve"),
          convertMarkdownTables: vi.fn((text: string) => text),
        },
        activity: {
          record: vi.fn(),
        },
      },
    },
    account: {
      accountId: "default",
      apiKey: "test-key",
      email: "debbie-bot@zlp.pubnerd.app",
      baseUrl: "https://zlp.pubnerd.app",
      config: {},
    },
    sendZulipPrivateMessage,
    sendZulipStreamMessage,
  };
});

vi.mock("../runtime.js", () => ({
  getZulipRuntime: () => sendState.runtime,
}));

vi.mock("./accounts.js", () => ({
  resolveZulipRuntimeAccount: vi.fn(async () => sendState.account),
}));

vi.mock("./client.js", () => ({
  createZulipClient: vi.fn(() => ({ authHeader: "Basic fake" })),
  normalizeZulipBaseUrl: vi.fn((url?: string) => url ?? ""),
  sendZulipPrivateMessage: sendState.sendZulipPrivateMessage,
  sendZulipStreamMessage: sendState.sendZulipStreamMessage,
  uploadZulipFile: vi.fn(async () => ({ url: "/user_uploads/test/report.pdf" })),
}));

describe("sendMessageZulip media and presentation", () => {
  it("uploads remote media through the bounded runtime buffer reader", async () => {
    sendState.runtime.channel.media.readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("report"), contentType: "application/pdf",
    });
    sendState.runtime.channel.media.saveMediaBuffer.mockResolvedValueOnce({ path: "/managed/report.pdf" });
    await sendMessageZulip("stream:general:reports", "Report", {
      cfg: { agents: { defaults: { mediaMaxMb: 2 } } },
      mediaUrl: "https://files.example.test/report.pdf",
    });
    expect(sendState.runtime.channel.media.readRemoteMediaBuffer).toHaveBeenCalledWith({
      url: "https://files.example.test/report.pdf", maxBytes: 2 * 1024 * 1024,
    });
    expect(sendState.sendZulipStreamMessage).toHaveBeenLastCalledWith(expect.anything(),
      expect.objectContaining({ content: "Report\n/user_uploads/test/report.pdf" }));
  });

  it("sends canonical command presentation controls to Zulip", async () => {
    await sendMessageZulip("user:alice@example.test", "Approval", {
      cfg: {},
      presentation: { blocks: [{ type: "buttons", buttons: [
        { label: "Deny", action: { type: "command", command: "/approve req-1 deny" } },
      ] }] },
    });
    expect(sendState.sendZulipPrivateMessage).toHaveBeenLastCalledWith(expect.anything(),
      expect.objectContaining({ widgetContent: expect.objectContaining({ extra_data: expect.objectContaining({
        choices: [{ type: "multiple_choice", short_name: "Deny", long_name: "Deny", reply: "/approve req-1 deny" }],
      }) }) }));
  });
});

describe("sendMessageZulip target parsing hardening", () => {
  it("rejects malformed dm-like targets instead of silently auto-correcting", async () => {
    await expect(
      sendMessageZulip("user:user:user8@zlp.pubnerd.app", "hello", {
        cfg: { channels: { zulip: {} } },
        accountId: "default",
      }),
    ).rejects.toThrow("Invalid Zulip direct-message target; expected an email address");
  });
});

describe("sendPollZulip", () => {
  it("sends generic polls through Zulip widget content", async () => {
    await sendPollZulip(
      "stream:general:lunch",
      {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
      },
      {
        cfg: { channels: { zulip: {} } },
        accountId: "default",
      },
    );

    expect(sendState.sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stream: "general",
        topic: "lunch",
        content: "Lunch?",
        widgetContent: {
          widget_type: "zform",
          extra_data: {
            type: "choices",
            heading: "Lunch?",
            poll: true,
            choices: [
              {
                type: "multiple_choice",
                short_name: "Pizza",
                long_name: "Pizza",
                reply: "Pizza",
              },
              {
                type: "multiple_choice",
                short_name: "Sushi",
                long_name: "Sushi",
                reply: "Sushi",
              },
            ],
          },
        },
      }),
    );
  });
});

describe("resolveZulipWidgetContent", () => {
  it("prefers shared presentation payloads when present", () => {
    expect(
      resolveZulipWidgetContent({
        presentation: {
          blocks: [
            { type: "text", text: "Approval Request" },
            {
              type: "buttons",
              buttons: [{ label: "Allow Once", action: { type: "command", command: "/approve req-1 allow-once" } }],
            },
          ],
        },
        channelData: {
          zulip: {
            widgetContent: {
              widget_type: "zform",
              extra_data: { type: "choices", heading: "wrong", choices: [] },
            },
          },
        },
      }),
    ).toEqual({
      widget_type: "zform",
      extra_data: {
        type: "choices",
        heading: "Approval Request",
        choices: [
          {
            type: "multiple_choice",
            short_name: "Allow Once",
            long_name: "Allow Once",
            reply: "/approve req-1 allow-once",
          },
        ],
      },
    });
  });

  it("falls back to channelData.zulip.widgetContent when presentation is absent", () => {
    expect(
      resolveZulipWidgetContent({
        channelData: {
          zulip: {
            widgetContent: {
              widget_type: "zform",
              extra_data: { type: "choices", heading: "From channelData", choices: [] },
            },
          },
          execApproval: { approvalId: "req-1" },
        },
      }),
    ).toEqual({
      widget_type: "zform",
      extra_data: { type: "choices", heading: "From channelData", choices: [] },
    });
  });

  it("ignores invalid array widgetContent from channelData", () => {
    expect(
      resolveZulipWidgetContent({
        channelData: {
          zulip: {
            widgetContent: [],
          },
        },
      }),
    ).toBeUndefined();
  });
});
