import { sanitizeThreadId } from "./zulip/monitor-helpers.js";
import { buildChannelOutboundSessionRoute, type OpenClawConfig } from "./sdk.js";
import { parseZulipTarget, type ZulipTarget } from "./zulip/send.js";

const TOPIC_MARKER = ":topic:";

export function buildZulipStreamConversation(params: {
  streamId: string;
  topic?: string | null;
}): { conversationId: string; threadId?: string } {
  const streamId = params.streamId.trim();
  if (!streamId) {
    return { conversationId: "" };
  }
  const topic = (params.topic ?? "").trim();
  if (!topic) {
    return { conversationId: streamId };
  }
  const threadId = sanitizeThreadId(topic);
  if (!threadId) {
    return { conversationId: streamId };
  }
  return {
    conversationId: `${streamId}${TOPIC_MARKER}${threadId}`,
    threadId,
  };
}

export function resolveZulipSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}) {
  const rawId = params.rawId.trim();
  if (!rawId) {
    return null;
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

function resolveZulipTarget(raw: string): ZulipTarget | null {
  try {
    return parseZulipTarget(raw);
  } catch {
    return null;
  }
}

function resolveOutboundZulipTopic(params: {
  targetTopic?: string | null;
  threadId?: string | number | null;
  replyToId?: string | null;
}): string | undefined {
  const targetTopic = params.targetTopic?.trim();
  if (targetTopic) {
    return targetTopic;
  }
  const replyToId = params.replyToId?.trim();
  if (replyToId) {
    return replyToId;
  }
  const threadId = params.threadId == null ? "" : String(params.threadId).trim();
  return threadId || undefined;
}

export function resolveZulipOutboundSessionRoute(
  params: ZulipOutboundSessionRouteParams,
) {
  const target = resolveZulipTarget(params.target);
  if (!target) {
    return null;
  }

  if (target.kind === "user") {
    return buildChannelOutboundSessionRoute({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: "zulip",
      accountId: params.accountId,
      peer: { kind: "direct", id: target.email },
      chatType: "direct",
      from: `zulip:${target.email}`,
      to: `user:${target.email}`,
    });
  }

  const topic = resolveOutboundZulipTopic({
    targetTopic: target.topic,
    threadId: params.threadId,
    replyToId: params.replyToId,
  });
  const streamConversation = buildZulipStreamConversation({
    streamId: target.stream,
    topic,
  });
  const peerId = streamConversation.conversationId || target.stream;
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "zulip",
    accountId: params.accountId,
    peer: { kind: "channel", id: peerId },
    chatType: "channel",
    from: `zulip:channel:${target.stream}`,
    to: topic ? `stream:${target.stream}:${topic}` : `stream:${target.stream}`,
    ...(topic ? { threadId: topic } : {}),
  });
}
