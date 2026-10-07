import { describe, expect, it } from "vitest";
import { zulipPlugin } from "./channel.js";
import type { ChannelThreadingToolContext } from "./sdk.js";
import { resolveZulipDestination } from "./zulip/destination.js";

const threading = zulipPlugin.threading!;
const cfg = {};
const build = threading.buildToolContext!;
const matches = threading.matchesToolContextTarget!;
const auto = threading.resolveAutoThreadId!;
const resolve = threading.resolveCurrentChannelId!;
const topicContext = () => build({ cfg, context: {
  To: "stream:42:Release A / B", MessageThreadId: "Release A / B",
  ThreadLabel: "stream:Engineering:Release A / B", ChatType: "channel", CurrentMessageId: "99",
} })!;

describe("Zulip threading adapter", () => {
  it("uses address threading and disables implicit message replies", () => {
    expect(threading.threadAddressing).toBe("address");
    expect(threading.resolveReplyToMode!({ cfg, chatType: "channel" })).toBe("off");
    const hasRepliedRef = { value: false };
    expect(build({ cfg, hasRepliedRef, context: { To: "#Engineering", MessageThreadId: "Topic", ReplyToMode: "all", CurrentMessageId: 99 } })).toMatchObject({
      currentChannelId: "stream:Engineering:Topic", currentMessagingTarget: "stream:Engineering:Topic",
      currentThreadTs: "Topic", currentMessageId: 99, replyToMode: "off", hasRepliedRef,
    });
  });

  it("retains ID and name aliases from inbound context without exposing session identities", () => {
    expect(topicContext()).toMatchObject({ currentChannelId: "stream:42:Release A / B", currentMessagingTarget: "stream:Engineering:Release A / B", currentThreadTs: "Release A / B" });
    expect(build({ cfg, context: { To: "42:topic:v2:opaque", MessageThreadId: "Real" } })?.currentChannelId).toBeUndefined();
    expect(build({ cfg, context: {} })?.currentChannelId).toBeUndefined();
    expect(build({ cfg, context: { To: "stream:42:Real", ThreadLabel: "stream:Other:Wrong" } })?.currentMessagingTarget).toBe("stream:42:Real");
  });

  it.each(["stream:42:release a / b", "#ENGINEERING:release a / b", "42:topic:RELEASE A / B", "stream:042", "Engineering"])("matches equivalent current stream/topic %s", (target) => {
    expect(matches({ target, toolContext: topicContext() })).toBe(true);
  });

  it.each(["stream:42:Other", "#Other:Release A / B", "stream:43", "user:someone@example.com", "stream:", "42:topic:v2:opaque", "stream:42:Release A / B ", "stream:42:\ud800"])("rejects different or invalid conversations %s", (target) => {
    expect(matches({ target, toolContext: topicContext() })).toBe(false);
  });

  it("uses Zulip lowercase rather than Unicode case folding or whitespace normalization", () => {
    const toolContext = build({ cfg, context: { To: "stream:42:ΟΣ" } })!;
    expect(matches({ target: "stream:42:ος", toolContext })).toBe(true);
    expect(matches({ target: "stream:42:οσ", toolContext })).toBe(false);
    expect(matches({ target: "stream:42:STRASSE", toolContext: { currentChannelId: "stream:42:Straße" } })).toBe(false);
  });

  it.each(["user:Peer@example.com", "dm:Peer@example.com", "zulip:Peer@example.com", "@Peer@example.com", "Peer@example.com"])("normalizes and matches DM form %s without inheriting a topic", (to) => {
    const toolContext = build({ cfg, context: { To: to, ChatType: "direct", MessageThreadId: "not a DM topic" } })!;
    expect(toolContext.currentChannelId).toBe("user:Peer@example.com");
    expect(toolContext.currentThreadTs).toBeUndefined();
    expect(matches({ target: "dm:peer@example.com", toolContext })).toBe(true);
    expect(matches({ target: "user:other@example.com", toolContext })).toBe(false);
    expect(auto({ cfg, to, toolContext })).toBeUndefined();
  });

  it("supports numeric DM peers and direct-only From fallback", () => {
    const toolContext = build({ cfg, context: { To: "user:123", ChatType: "direct" } })!;
    expect(matches({ target: "dm:123", toolContext })).toBe(true);
    expect(matches({ target: "stream:123", toolContext })).toBe(false);
    expect(build({ cfg, context: { From: "zulip:peer@example.com", ChatType: "direct" } })?.currentChannelId).toBe("user:peer@example.com");
    expect(build({ cfg, context: { From: "zulip:channel:42", ChatType: "channel" } })?.currentChannelId).toBeUndefined();
  });

  it.each(["stream:42", "#ENGINEERING", "stream:042"])("defaults topicless sends to the current topic for %s", (to) => {
    const threadId = auto({ cfg, to, toolContext: topicContext(), replyToId: "99" });
    expect(threadId).toBe("Release A / B");
    expect(resolveZulipDestination(to, threadId, "general")).toMatchObject({ topic: "Release A / B" });
  });

  it.each(["stream:42:Other", "stream:42:", "#Engineering:Release A / B", "stream:43", "Other", "user:peer@example.com", "42:topic:v2:opaque"])("leaves explicit or other targets untouched: %s", (to) => {
    expect(auto({ cfg, to, toolContext: topicContext() })).toBeUndefined();
  });

  it.each(["", " Topic ", "ΟΣ"])("preserves the raw auto-topic through destination resolution: %s", (topic) => {
    const toolContext = build({ cfg, context: { To: `stream:42:${topic}`, MessageThreadId: topic } })!;
    const threadId = auto({ cfg, to: "stream:42", toolContext });
    expect(threadId).toBe(topic);
    expect(resolveZulipDestination("stream:42", threadId, "general")).toMatchObject({ topic });
  });

  it("does not inherit from another provider or absent context", () => {
    const toolContext: ChannelThreadingToolContext = { ...topicContext(), currentChannelProvider: "telegram" };
    expect(auto({ cfg, to: "stream:42", toolContext })).toBeUndefined();
    expect(matches({ target: "stream:42", toolContext })).toBe(false);
    expect(auto({ cfg, to: "stream:42" })).toBeUndefined();
    expect(auto({ cfg, to: "stream:42", toolContext: { currentChannelId: "stream:42" } })).toBeUndefined();
  });

  it.each([
    ["#Engineering", "Topic: A / B ", "stream:Engineering:Topic: A / B "],
    ["stream:42:Explicit", "Other", "stream:42:Explicit"],
    ["42:topic:Legacy", "Other", "stream:42:Legacy"],
    ["stream:42", "", "stream:42:"],
    ["stream:42", 0, "stream:42:0"],
    ["stream:42", null, "stream:42"],
    ["@peer@example.com", "Topic", "user:peer@example.com"],
    ["stream:", "Topic", undefined],
    ["42:topic:v2:opaque", "Topic", undefined],
  ])("composes canonical channel IDs without overriding targets (%s, %s)", (to, threadId, expected) => {
    expect(resolve({ to: to as string, threadId })).toBe(expected);
  });
});
