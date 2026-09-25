import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "./sdk.js";
import {
  buildZulipDirectPeerId,
  buildZulipStreamConversation,
  buildZulipStreamSessionKey,
  matchZulipConfiguredConversation,
  resolveZulipCommandConversation,
  resolveZulipConversationRef,
  resolveZulipOutboundSessionRoute,
  resolveZulipSessionConversation,
} from "./session-conversation.js";
import { resolveZulipDestination } from "./zulip/destination.js";

const scope = {
  baseUrl: "https://zulip.example.test",
  botIdentity: "bot@example.test",
  accountId: "default",
  streamId: "42",
};
const cfg = {
  channels: { zulip: { url: scope.baseUrl, email: scope.botIdentity, apiKey: "synthetic-key" } },
  session: { groupScope: "main" },
} as OpenClawConfig;
const conversation = (topic: string, overrides: Partial<typeof scope> = {}) =>
  buildZulipStreamConversation({ ...scope, ...overrides, topic });

afterEach(() => vi.unstubAllGlobals());

describe("isolated Zulip topic sessions", () => {
  it("keeps formerly colliding topics, empty topics and general separate", () => {
    const topics = ["Release A", "Release-A", "Release--A", "!!!", "???", "///", "", "general", "café", "cafe\u0301", "Ａ", "A", "Straße", "STRASSE", "A".repeat(201), "A".repeat(202)];
    const identities = topics.map((topic) => conversation(topic).conversationId);
    expect(new Set(identities).size).toBe(topics.length);
    for (const identity of identities) expect(identity).toMatch(/^42:topic:v2:[0-9a-f]{64}$/);
  });

  it.each([["Release A", "release a"], ["ÉTÉ", "été"], ["ПЛАН", "план"], ["İ", "i\u0307"], ["ΟΣ", "ος"]])(
    "shares case-equivalent identity while preserving raw %s / %s", (left, right) => {
      expect(conversation(left).conversationId).toBe(conversation(right).conversationId);
      expect(conversation(left).threadId).toBe(left);
      expect(conversation(right).threadId).toBe(right);
    },
  );

  it("isolates accounts, endpoints, bots, streams and agents", () => {
    const id = conversation("Release A").conversationId;
    for (const override of [
      { accountId: "other" }, { baseUrl: "https://other.example.test" },
      { botIdentity: "other@example.test" }, { streamId: "43" },
    ]) expect(conversation("Release A", override).conversationId).not.toBe(id);
    expect(conversation("Release A", { baseUrl: `${scope.baseUrl}/`, streamId: "042" }).conversationId).toBe(id);
    expect(buildZulipStreamSessionKey({ agentId: "one", conversationId: id }))
      .not.toBe(buildZulipStreamSessionKey({ agentId: "two", conversationId: id }));
  });

  it("uses the stream's agent binding without inheriting its main or parent history", () => {
    const id = conversation("Release A").conversationId;
    const route = resolveAgentRoute({
      cfg: {
        ...cfg,
        agents: { list: [{ id: "main" }, { id: "engineer" }] },
        bindings: [{ agentId: "engineer", match: { channel: "zulip", peer: { kind: "channel", id: "42" } } }],
      },
      channel: "zulip",
      accountId: "default",
      peer: { kind: "channel", id },
      parentPeer: { kind: "channel", id: "42" },
    });
    expect(route.agentId).toBe("engineer");
    expect(route.sessionKey).toBe("agent:engineer:main");
    expect(buildZulipStreamSessionKey({ agentId: route.agentId, conversationId: id }))
      .toBe(`agent:engineer:zulip:channel:${id}`);
    expect(resolveZulipSessionConversation({ kind: "channel", rawId: id }))
      .toEqual({ id, parentConversationCandidates: [] });
  });

  it("resolves a channel name before deriving the same identity as inbound numeric IDs", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toBe(`${scope.baseUrl}/api/v1/users/me/subscriptions?include_all_public_streams=true`);
      return Response.json({ result: "success", subscriptions: [{ stream_id: 42, name: "Engineering" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const named = await resolveZulipOutboundSessionRoute({ cfg, agentId: "main", target: "stream:Engineering:Release A" });
    const numeric = await resolveZulipOutboundSessionRoute({ cfg, agentId: "main", target: "stream:42:Release A" });
    expect(named).toEqual(numeric);
    expect(named).toMatchObject({
      to: "stream:42:Release A", threadId: "Release A",
      sessionKey: buildZulipStreamSessionKey({ agentId: "main", conversationId: conversation("Release A").conversationId }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit and inherited empty topics distinct from the missing-topic default", async () => {
    const resolve = (target: string, threadId?: string) => resolveZulipOutboundSessionRoute({ cfg, agentId: "main", target, threadId });
    const empty = await resolve("stream:42:");
    expect(empty).toMatchObject({ to: "stream:42:", threadId: "" });
    expect(await resolve("stream:42", "")).toEqual(empty);
    const general = await resolve("stream:42");
    expect(general).toMatchObject({ to: "stream:42:general", threadId: "general" });
    expect(general?.sessionKey).not.toBe(empty?.sessionKey);
    expect(await resolve("stream:42:general", "")).toEqual(general);
  });

  it("never treats a session digest or reply message ID as a destination topic", async () => {
    const id = conversation("Release A").conversationId;
    expect(() => resolveZulipDestination(id)).toThrow("not message destinations");
    expect(() => resolveZulipDestination(`channel:${id}`)).toThrow("not message destinations");
    expect(() => resolveZulipDestination(`group:${id}`)).toThrow("not message destinations");
    expect(() => resolveZulipDestination(`agent:main:zulip:channel:${id}`)).toThrow("not message destinations");
    expect(resolveZulipDestination(`stream:42:${id}`)).toMatchObject({ topic: id });
    const route = await resolveZulipOutboundSessionRoute({ cfg, agentId: "main", target: "stream:42", replyToId: "123456" });
    expect(route).toMatchObject({ to: "stream:42:general", threadId: "general" });
  });

  it.each(["", "Engineering", "0", "-1", "9007199254740992"])("rejects invalid stream identity %j", (streamId) => {
    expect(() => conversation("Release A", { streamId })).toThrow("numeric stream ID");
  });
});

describe("Zulip conversation binding identities", () => {
  it("canonicalizes topic and DM refs while rejecting delivery-only identities", () => {
    const topic = conversation("Release A").conversationId;
    const direct = buildZulipDirectPeerId({
      baseUrl: scope.baseUrl,
      botIdentity: scope.botIdentity,
      senderIdentity: "Alice@Example.Test",
    });
    expect(resolveZulipConversationRef({ conversationId: topic.toUpperCase() })).toEqual({
      conversationId: topic,
      parentConversationId: "42",
    });
    expect(resolveZulipConversationRef({ conversationId: direct.toUpperCase() })).toEqual({
      conversationId: direct,
    });
    expect(resolveZulipConversationRef({ conversationId: "user:alice@example.test" })).toBeNull();
    expect(resolveZulipConversationRef({ conversationId: "42", parentConversationId: "42" })).toBeNull();
  });

  it("resolves command conversations from ordinary topic and DM session keys", () => {
    const topic = conversation("Release A").conversationId;
    const direct = buildZulipDirectPeerId({
      baseUrl: scope.baseUrl,
      botIdentity: scope.botIdentity,
      senderIdentity: "alice@example.test",
    });
    expect(resolveZulipCommandConversation({
      sessionKey: `agent:main:zulip:channel:${topic}`,
    })).toEqual({ conversationId: topic, parentConversationId: "42" });
    expect(resolveZulipCommandConversation({
      sessionKey: `agent:main:zulip:default:direct:${direct}`,
    })).toEqual({ conversationId: direct });
    expect(resolveZulipCommandConversation({
      sessionKey: "agent:bound:acp:topic-session",
      parentSessionKey: `agent:main:zulip:channel:${topic}`,
    })).toEqual({ conversationId: topic, parentConversationId: "42" });
    expect(resolveZulipCommandConversation({
      sessionKey: "agent:bound:acp:dm-session",
      parentSessionKey: `agent:main:zulip:default:direct:${direct}`,
    })).toEqual({ conversationId: direct });
  });

  it("matches only the exact canonical identity, so substantive topic renames require rebind", () => {
    const original = conversation("Release A").conversationId;
    const caseOnly = conversation("release a").conversationId;
    const renamed = conversation("Release B").conversationId;
    const compiledBinding = resolveZulipConversationRef({ conversationId: original })!;
    expect(matchZulipConfiguredConversation({ compiledBinding, conversationId: caseOnly, parentConversationId: "42" }))
      .toMatchObject({ conversationId: original, matchPriority: 100 });
    expect(matchZulipConfiguredConversation({ compiledBinding, conversationId: renamed, parentConversationId: "42" }))
      .toBeNull();
  });
});
