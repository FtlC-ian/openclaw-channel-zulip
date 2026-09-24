import { createHash } from "node:crypto";
import {
  buildAgentSessionKey,
  buildChannelOutboundSessionRoute,
  normalizeAccountId,
  type OpenClawConfig,
} from "./sdk.js";
import { resolveZulipAccount, resolveZulipRuntimeAccount } from "./zulip/accounts.js";
import { createZulipClient, normalizeZulipBaseUrl, resolveZulipStreamId } from "./zulip/client.js";
import { resolveZulipDestination } from "./zulip/destination.js";
import { canonicalizeZulipTopic, ZULIP_TOPIC_CASE_VERSION } from "./zulip/topic-case.js";

const TOPIC_MARKER = ":topic:";
const TOPIC_CONVERSATION_PATTERN = /^(\d+):topic:v2:[0-9a-f]{64}$/;
const DIRECT_CONVERSATION_PATTERN = /^account-[0-9a-f]{64}:[^\s]+$/;

function canonicalizeZulipRealm(baseUrl: string): string {
  const normalized = normalizeZulipBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Zulip base URL is required for isolated session routing");
  }
  const url = new URL(normalized);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export function buildZulipDirectPeerId(params: {
  baseUrl: string;
  botIdentity: string;
  senderIdentity: string;
}): string {
  const botIdentity = params.botIdentity.trim().toLowerCase();
  const senderIdentity = params.senderIdentity.trim().toLowerCase();
  if (!botIdentity) {
    throw new Error("Zulip bot identity is required for isolated DM session routing");
  }
  if (!senderIdentity) {
    throw new Error("Zulip sender identity is required for isolated DM session routing");
  }
  const accountScopeHash = createHash("sha256")
    .update(`${canonicalizeZulipRealm(params.baseUrl)}\n${botIdentity}`)
    .digest("hex");
  return `account-${accountScopeHash}:${senderIdentity}`;
}

export function buildZulipDirectSessionKey(params: {
  agentId: string;
  accountId?: string | null;
  baseUrl: string;
  botIdentity: string;
  senderIdentity: string;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: "zulip",
    accountId: params.accountId,
    peer: {
      kind: "direct",
      id: buildZulipDirectPeerId(params),
    },
    dmScope: "per-account-channel-peer",
  });
}

type ZulipStreamScope = {
  accountId?: string | null;
  baseUrl: string;
  botIdentity: string;
  streamId: string;
  topic: string;
};

export function buildZulipStreamConversation(params: ZulipStreamScope) {
  const streamId = Number(params.streamId);
  if (!/^\d+$/.test(params.streamId) || !Number.isSafeInteger(streamId) || streamId <= 0) {
    throw new Error("Zulip topic sessions require a numeric stream ID");
  }
  const botIdentity = params.botIdentity.trim().toLowerCase();
  if (!botIdentity) throw new Error("Zulip bot identity is required for isolated session routing");
  const digest = createHash("sha256").update(JSON.stringify([
    "zulip-topic-v2",
    ZULIP_TOPIC_CASE_VERSION,
    normalizeAccountId(params.accountId),
    canonicalizeZulipRealm(params.baseUrl),
    botIdentity,
    String(streamId),
    canonicalizeZulipTopic(params.topic),
  ])).digest("hex");
  return {
    conversationId: `${streamId}${TOPIC_MARKER}v2:${digest}`,
    threadId: params.topic,
  };
}

export function buildZulipStreamSessionKey(params: {
  agentId: string;
  conversationId: string;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: "zulip",
    peer: { kind: "channel", id: params.conversationId },
    groupScope: "per-group",
  });
}

export function resolveZulipConversationRef(params: {
  conversationId: string;
  parentConversationId?: string | null;
}): { conversationId: string; parentConversationId?: string } | null {
  const conversationId = params.conversationId.trim().toLowerCase();
  const topicMatch = TOPIC_CONVERSATION_PATTERN.exec(conversationId);
  if (topicMatch) {
    return { conversationId, parentConversationId: String(Number(topicMatch[1])) };
  }
  if (DIRECT_CONVERSATION_PATTERN.test(conversationId)) {
    return { conversationId };
  }
  return null;
}

export function resolveZulipCommandConversation(params: {
  sessionKey?: string;
  parentSessionKey?: string;
}): { conversationId: string; parentConversationId?: string } | null {
  for (const sessionKey of [params.sessionKey, params.parentSessionKey]) {
    if (!sessionKey) continue;
    const channelMarker = ":zulip:channel:";
    const channelIndex = sessionKey.indexOf(channelMarker);
    if (channelIndex !== -1) {
      const resolved = resolveZulipConversationRef({
        conversationId: sessionKey.slice(channelIndex + channelMarker.length),
      });
      if (resolved) return resolved;
    }
    const directMarker = ":direct:";
    const directIndex = sessionKey.indexOf(directMarker);
    if (directIndex !== -1 && sessionKey.slice(0, directIndex).includes(":zulip:")) {
      const resolved = resolveZulipConversationRef({
        conversationId: sessionKey.slice(directIndex + directMarker.length),
      });
      if (resolved) return resolved;
    }
  }
  return null;
}

export function matchZulipConfiguredConversation(params: {
  compiledBinding: { conversationId: string; parentConversationId?: string };
  conversationId: string;
  parentConversationId?: string;
}) {
  const inbound = resolveZulipConversationRef(params);
  if (!inbound || inbound.conversationId !== params.compiledBinding.conversationId) return null;
  if (
    params.compiledBinding.parentConversationId !== undefined &&
    inbound.parentConversationId !== params.compiledBinding.parentConversationId
  ) return null;
  return { ...inbound, matchPriority: 100 };
}

export function resolveZulipSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}) {
  const rawId = params.rawId.trim();
  if (!rawId) {
    return null;
  }

  if (/^\d+:topic:v\d+:/.test(rawId)) {
    // Opaque session identity is never a wire topic or a legacy history parent.
    return { id: rawId, parentConversationCandidates: [] };
  }

  const markerIndex = rawId.indexOf(TOPIC_MARKER);
  if (markerIndex === -1) {
    return null;
  }

  const id = rawId.slice(0, markerIndex).trim();
  const threadId = rawId.slice(markerIndex + TOPIC_MARKER.length).trim();
  if (!id || !threadId) {
    return null;
  }

  return {
    id,
    threadId,
    baseConversationId: id,
    parentConversationCandidates: [id],
  };
}

type ZulipOutboundSessionRouteParams = {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  replyToId?: string | null;
  threadId?: string | number | null;
};

export async function resolveZulipOutboundSessionRoute(
  params: ZulipOutboundSessionRouteParams,
) {
  const account = resolveZulipAccount({ cfg: params.cfg, accountId: params.accountId });
  let target;
  try {
    target = resolveZulipDestination(params.target, params.threadId, account.config.defaultTopic);
  } catch {
    return null;
  }

  if (target.kind === "user") {
    if (!account.baseUrl || !account.email) {
      return null;
    }
    const peer = {
      kind: "direct" as const,
      id: buildZulipDirectPeerId({
        baseUrl: account.baseUrl,
        botIdentity: account.email,
        senderIdentity: target.email,
      }),
    };
    const route = buildChannelOutboundSessionRoute({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: "zulip",
      accountId: params.accountId,
      peer,
      chatType: "direct",
      from: `zulip:${target.email}`,
      to: `user:${target.email}`,
    });
    const sessionKey = buildZulipDirectSessionKey({
      agentId: params.agentId,
      accountId: params.accountId,
      baseUrl: account.baseUrl,
      botIdentity: account.email,
      senderIdentity: target.email,
    });
    return {
      ...route,
      sessionKey,
      baseSessionKey: sessionKey,
    };
  }

  if (!account.baseUrl || !account.email) {
    throw new Error("Zulip url/email missing for session routing");
  }
  let streamId = target.stream;
  if (!/^\d+$/.test(streamId)) {
    const runtimeAccount = await resolveZulipRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
    if (!runtimeAccount.apiKey) throw new Error("Zulip API key required to resolve a stream name");
    const client = createZulipClient({ baseUrl: account.baseUrl, email: account.email, apiKey: runtimeAccount.apiKey });
    streamId = await resolveZulipStreamId(client, streamId);
  }
  streamId = String(Number(streamId));
  const topic = target.topic;
  const streamConversation = buildZulipStreamConversation({
    accountId: account.accountId,
    baseUrl: account.baseUrl,
    botIdentity: account.email,
    streamId,
    topic,
  });
  const sessionKey = buildZulipStreamSessionKey({ agentId: params.agentId, conversationId: streamConversation.conversationId });
  const route = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "zulip",
    accountId: params.accountId,
    peer: { kind: "channel", id: streamConversation.conversationId },
    chatType: "channel",
    from: `zulip:channel:${streamId}`,
    to: `stream:${streamId}:${topic}`,
    threadId: topic,
  });
  return { ...route, sessionKey, baseSessionKey: sessionKey };
}
