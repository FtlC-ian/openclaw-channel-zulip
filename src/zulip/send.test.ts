import { describe, expect, it, vi } from "vitest";
import {
  presentationToZulipWidgetContent,
  normalizeLegacyZulipTarget,
  parseZulipTarget,
  pollToZulipWidgetContent,
  resolveZulipWidgetContent,
  sendMessageZulip,
  sendPollZulip,
} from "./send.js";
import {
  runWithZulipQuestionDeliveryContext,
  zulipQuestionZformStore,
} from "./question-zform.js";

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

  it("preserves leading and trailing whitespace in legacy topic names", () => {
    expect(normalizeLegacyZulipTarget("3:topic:  polymarket  ")).toEqual({
      normalized: "stream:3:  polymarket  ",
      convertedFromLegacy: true,
    });
  });

  it("does not auto-convert malformed dm-like targets", () => {
    expect(normalizeLegacyZulipTarget("user:user:user8@zlp.pubnerd.app")).toEqual({
      normalized: "user:user:user8@zlp.pubnerd.app",
      convertedFromLegacy: false,
    });
  });
});

describe("parseZulipTarget", () => {
  it.each([
    ["stream: 42 :  Release notes  ", "42", "  Release notes  "],
    ["# 42 /  Release notes  ", "42", "  Release notes  "],
    ["42:topic:  Release notes  ", "42", "  Release notes  "],
  ])("trims stream syntax but preserves topic whitespace for %s", (raw, stream, topic) => {
    expect(parseZulipTarget(raw)).toEqual({ kind: "stream", stream, topic });
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
  resolveZulipStreamId: vi.fn(async (_client, stream: string) => stream === "general" ? "4" : "5"),
  sendZulipPrivateMessage: sendState.sendZulipPrivateMessage,
  sendZulipStreamMessage: sendState.sendZulipStreamMessage,
  uploadZulipFile: vi.fn(async () => ({ url: "/user_uploads/test/report.pdf" })),
}));

describe("sendMessageZulip media and presentation", () => {
  it("uses the explicit target topic for both text and media when thread context disagrees", async () => {
    await sendMessageZulip("stream:synthetic-stream:Canonical Topic", "text", {
      cfg: {},
      topic: "Different Session Topic",
    });
    expect(sendState.sendZulipStreamMessage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        stream: "synthetic-stream",
        topic: "Canonical Topic",
        content: "text",
      }),
    );

    await sendMessageZulip("stream:synthetic-stream:Canonical Topic", "media", {
      cfg: {},
      topic: "Different Session Topic",
      mediaUrl: "https://zlp.pubnerd.app/user_uploads/synthetic.png",
    });
    expect(sendState.sendZulipStreamMessage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        stream: "synthetic-stream",
        topic: "Canonical Topic",
        content: "media\nhttps://zlp.pubnerd.app/user_uploads/synthetic.png",
      }),
    );
  });

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

  it("binds an ask_user widget to the exact sent stream rather than its reply context", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const register = vi.spyOn(zulipQuestionZformStore, "register").mockReturnValue(true);
    const askPayload = {
      text: "Where should this deploy?\n1. Staging\n2. Production",
      channelData: { askUser: { questionId, optionValues: ["Staging", "Production"] } },
      presentation: {
        blocks: [
          { type: "text" as const, text: "Where should this deploy?" },
          {
            type: "buttons" as const,
            buttons: [
              {
                label: "Staging",
                action: { type: "question" as const, questionId, optionValue: "Staging" },
              },
              {
                label: "Production",
                action: { type: "question" as const, questionId, optionValue: "Production" },
              },
            ],
          },
        ],
      },
    };

    await runWithZulipQuestionDeliveryContext(
      {
        authorizedSenderId: "alice@example.test",
        conversation: { kind: "stream", stream: "42", topic: "deploys" },
      },
      () => sendMessageZulip("stream:general:deploys", askPayload.text, {
        cfg: {},
        presentation: askPayload.presentation,
        channelData: askPayload.channelData,
      }),
    );

    const widget = sendState.sendZulipStreamMessage.mock.calls.at(-1)?.[1]?.widgetContent as {
      extra_data?: { choices?: Array<{ reply?: string }> };
    };
    expect(widget.extra_data?.choices?.map((choice) => choice.reply)).toEqual([
      expect.stringMatching(/^ocq1:[A-Za-z0-9_-]{22}:0$/u),
      expect.stringMatching(/^ocq1:[A-Za-z0-9_-]{22}:1$/u),
    ]);
    expect(JSON.stringify(widget)).not.toContain(questionId);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        conversation: { kind: "stream", stream: "4", topic: "deploys" },
        deliveryConversation: { kind: "stream", stream: "general", topic: "deploys" },
        authorizedSenderId: "alice@example.test",
        sourceMessageId: "9002",
        sourceText: askPayload.text,
      }),
    );
    register.mockRestore();
  });

  it("binds an ask_user widget to the exact sent DM rather than its DM reply context", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const register = vi.spyOn(zulipQuestionZformStore, "register").mockReturnValue(true);
    const askPayload = {
      text: "Choose one\n1. One\n2. Two",
      channelData: { askUser: { questionId, optionValues: ["One", "Two"] } },
      presentation: {
        blocks: [
          { type: "text" as const, text: "Choose one" },
          {
            type: "buttons" as const,
            buttons: [
              { label: "One", action: { type: "question" as const, questionId, optionValue: "One" } },
              { label: "Two", action: { type: "question" as const, questionId, optionValue: "Two" } },
            ],
          },
        ],
      },
    };

    await runWithZulipQuestionDeliveryContext(
      {
        authorizedSenderId: "alice@example.test",
        conversation: { kind: "dm", recipient: "context@example.test" },
      },
      () =>
        sendMessageZulip("user:actual@example.test", askPayload.text, {
          cfg: {},
          presentation: askPayload.presentation,
          channelData: askPayload.channelData,
        }),
    );

    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: { kind: "dm", recipient: "actual@example.test" },
        authorizedSenderId: "alice@example.test",
        sourceMessageId: "9001",
      }),
    );
    register.mockRestore();
  });

  it("does not send an unbindable question when canonical stream lookup fails", async () => {
    const { resolveZulipStreamId } = await import("./client.js");
    vi.mocked(resolveZulipStreamId).mockRejectedValueOnce(new Error("stream lookup failed"));
    const sendsBefore = sendState.sendZulipStreamMessage.mock.calls.length;
    const register = vi.spyOn(zulipQuestionZformStore, "register");
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    try {
      await expect(runWithZulipQuestionDeliveryContext({
        authorizedSenderId: "alice@example.test",
        conversation: { kind: "stream", stream: "42", topic: "deploys" },
      }, () => sendMessageZulip("stream:missing:deploys", "Choose one", {
        cfg: {},
        channelData: { askUser: { questionId, optionValues: ["One", "Two"] } },
        presentation: { blocks: [{ type: "buttons", buttons: [
          { label: "One", action: { type: "question", questionId, optionValue: "One" } },
          { label: "Two", action: { type: "question", questionId, optionValue: "Two" } },
        ] }] },
      }))).rejects.toThrow("stream lookup failed");
      expect(sendState.sendZulipStreamMessage).toHaveBeenCalledTimes(sendsBefore);
      expect(register).not.toHaveBeenCalled();
    } finally {
      register.mockRestore();
    }
  });

  it.each([
    {
      name: "stream context for a sent DM",
      context: { kind: "stream" as const, stream: "context", topic: "wrong" },
      target: "user:actual@example.test",
      expected: { kind: "dm" as const, recipient: "actual@example.test" },
      sourceMessageId: "9001",
    },
    {
      name: "DM context for a sent stream",
      context: { kind: "dm" as const, recipient: "context@example.test" },
      target: "stream:actual:real-topic",
      expected: { kind: "stream" as const, stream: "5", topic: "real-topic" },
      sourceMessageId: "9002",
    },
  ])("binds $name to the successful outbound destination", async ({ context, target, expected, sourceMessageId }) => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const register = vi.spyOn(zulipQuestionZformStore, "register").mockReturnValue(true);
    const text = "Choose one\n1. One\n2. Two";

    await runWithZulipQuestionDeliveryContext(
      { authorizedSenderId: "alice@example.test", conversation: context },
      () =>
        sendMessageZulip(target, text, {
          cfg: {},
          channelData: { askUser: { questionId, optionValues: ["One", "Two"] } },
          presentation: {
            blocks: [
              { type: "text", text: "Choose one" },
              {
                type: "buttons",
                buttons: [
                  { label: "One", action: { type: "question", questionId, optionValue: "One" } },
                  { label: "Two", action: { type: "question", questionId, optionValue: "Two" } },
                ],
              },
            ],
          },
        }),
    );

    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ conversation: expected, sourceMessageId }),
    );
    register.mockRestore();
  });

  it("keeps eligible ask_user payloads text-first when no authorized reply context exists", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    await sendMessageZulip("user:alice@example.test", "Choose one", {
      cfg: {},
      channelData: { askUser: { questionId, optionValues: ["One", "Two"] } },
      presentation: {
        blocks: [
          { type: "text", text: "Choose one" },
          {
            type: "buttons",
            buttons: [
              { label: "One", action: { type: "question", questionId, optionValue: "One" } },
              { label: "Two", action: { type: "question", questionId, optionValue: "Two" } },
            ],
          },
        ],
      },
    });
    expect(sendState.sendZulipPrivateMessage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ content: "Choose one", widgetContent: undefined }),
    );
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
