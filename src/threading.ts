import type { ChannelThreadingAdapter, ChannelThreadingToolContext } from "./sdk.js";
import { normalizeZulipMessagingTarget } from "./normalize.js";
import { isZulipSessionTarget, parseZulipTarget, type ZulipTarget } from "./zulip/destination.js";
import { canonicalizeZulipTopic } from "./zulip/topic-case.js";

function parseTarget(raw: string | undefined): ZulipTarget | undefined {
  if (!raw || isZulipSessionTarget(raw)) return undefined;
  const normalized = normalizeZulipMessagingTarget(raw);
  if (!normalized) return undefined;
  if (/^user:\d+$/.test(normalized)) {
    return { kind: "user", email: normalized.slice("user:".length) };
  }
  try {
    const target = parseZulipTarget(normalized);
    if (target.kind === "stream" && target.topic !== undefined) canonicalizeZulipTopic(target.topic);
    return target;
  } catch {
    return undefined;
  }
}

function formatTarget(target: ZulipTarget): string {
  if (target.kind === "user") return `user:${target.email}`;
  return target.topic === undefined ? `stream:${target.stream}` : `stream:${target.stream}:${target.topic}`;
}

function sameStream(left: string, right: string): boolean {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) return BigInt(left) === BigInt(right);
  return left.toLowerCase() === right.toLowerCase();
}

function currentTargets(context: ChannelThreadingToolContext): ZulipTarget[] {
  if (context.currentChannelProvider && context.currentChannelProvider !== "zulip") return [];
  return [context.currentChannelId, context.currentMessagingTarget]
    .map(parseTarget).filter((target): target is ZulipTarget => target !== undefined);
}

function resolveCurrentChannelId(to: string, threadId?: string | number | null): string | undefined {
  const target = parseTarget(to);
  if (!target) return undefined;
  if (target.kind === "stream" && target.topic === undefined && threadId != null) {
    const topic = String(threadId);
    try {
      canonicalizeZulipTopic(topic);
    } catch {
      return undefined;
    }
    return formatTarget({ ...target, topic });
  }
  return formatTarget(target);
}

export const zulipThreading: ChannelThreadingAdapter = {
  threadAddressing: "address",
  resolveReplyToMode: () => "off",
  resolveCurrentChannelId: ({ to, threadId }) => resolveCurrentChannelId(to, threadId),
  buildToolContext: ({ context, hasRepliedRef }) => {
    const currentChannelId = context.To
      ? resolveCurrentChannelId(context.To, context.MessageThreadId)
      : context.ChatType === "direct" && context.From
        ? resolveCurrentChannelId(context.From)
        : undefined;
    const target = parseTarget(currentChannelId);
    // Core forwards ThreadLabel, but not GroupChannel/StreamId, to this hook.
    // The monitor supplies the name-addressed topic label alongside the ID route.
    const label = context.ThreadLabel?.startsWith("stream:") ? parseTarget(context.ThreadLabel) : undefined;
    const namedTarget = target?.kind === "stream" && label?.kind === "stream"
      && target.topic !== undefined && label.topic !== undefined
      && canonicalizeZulipTopic(target.topic) === canonicalizeZulipTopic(label.topic)
      ? formatTarget(label) : currentChannelId;
    return {
      currentChannelId,
      currentMessagingTarget: namedTarget,
      currentThreadTs: target?.kind === "stream" ? target.topic : undefined,
      currentMessageId: context.CurrentMessageId,
      replyToMode: "off",
      hasRepliedRef,
    };
  },
  matchesToolContextTarget: ({ target: raw, toolContext }) => {
    const target = parseTarget(raw);
    if (!target) return false;
    return currentTargets(toolContext).some((current) => {
      if (target.kind === "user" && current.kind === "user") {
        return target.email.toLowerCase() === current.email.toLowerCase();
      }
      if (target.kind !== "stream" || current.kind !== "stream" || !sameStream(target.stream, current.stream)) {
        return false;
      }
      const topic = current.topic ?? toolContext.currentThreadTs;
      return target.topic === undefined || (topic !== undefined
        && canonicalizeZulipTopic(target.topic) === canonicalizeZulipTopic(topic));
    });
  },
  resolveAutoThreadId: ({ to, toolContext }) => {
    const target = parseTarget(to);
    if (!toolContext || target?.kind !== "stream" || target.topic !== undefined) return undefined;
    for (const current of currentTargets(toolContext)) {
      if (current.kind === "stream" && sameStream(target.stream, current.stream)) {
        return current.topic ?? toolContext.currentThreadTs;
      }
    }
    return undefined;
  },
};
