import { describe, expect, it, vi } from "vitest";
import {
  interactiveToZulipWidgetContent,
  normalizeLegacyZulipTarget,
  resolveZulipWidgetContent,
  sendMessageZulip,
} from "./send.js";

describe("interactiveToZulipWidgetContent", () => {
  it("maps shared button payloads to Zulip zform widgets", () => {
    expect(
      interactiveToZulipWidgetContent({
        blocks: [
          { type: "text", text: "Approval Request" },
          {
            type: "buttons",
            buttons: [
              { label: "Allow Once", value: "/approve req-1 allow-once", style: "success" },
              { label: "Deny", value: "/approve req-1 deny", style: "danger" },
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

  it("returns undefined when there are no buttons", () => {
    expect(interactiveToZulipWidgetContent({ blocks: [{ type: "text", text: "hi" }] })).toBeUndefined();
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
      config: { loadConfig: vi.fn(() => ({ channels: { zulip: {} } })) },
      logging: {
        getChildLogger: () => ({ debug: vi.fn(), warn: vi.fn() }),
      },
      channel: {
        media: {
          fetchRemoteMedia: vi.fn(),
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
  resolveZulipAccount: vi.fn(() => sendState.account),
}));

vi.mock("./client.js", () => ({
  createZulipClient: vi.fn(() => ({ authHeader: "Basic fake" })),
  normalizeZulipBaseUrl: vi.fn((url?: string) => url ?? ""),
  sendZulipPrivateMessage: sendState.sendZulipPrivateMessage,
  sendZulipStreamMessage: sendState.sendZulipStreamMessage,
  uploadZulipFile: vi.fn(),
}));

describe("sendMessageZulip target parsing hardening", () => {
  it("rejects malformed dm-like targets instead of silently auto-correcting", async () => {
    await expect(
      sendMessageZulip("user:user:user8@zlp.pubnerd.app", "hello", { accountId: "default" }),
    ).rejects.toThrow("Invalid Zulip direct-message target; expected an email address");
  });
});

describe("resolveZulipWidgetContent", () => {
  it("prefers shared interactive payloads when present", () => {
    expect(
      resolveZulipWidgetContent({
        interactive: {
          blocks: [
            { type: "text", text: "Approval Request" },
            {
              type: "buttons",
              buttons: [{ label: "Allow Once", value: "/approve req-1 allow-once" }],
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

  it("falls back to channelData.zulip.widgetContent when interactive is absent", () => {
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
