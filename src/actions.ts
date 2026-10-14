import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolSchemaContribution,
  OpenClawConfig,
} from "./sdk.js";
import { jsonResult, normalizeMessagePresentation, readNumberParam, readStringParam } from "./sdk.js";
import {
  isZulipAccountConfigured,
  resolveZulipAccount,
  resolveZulipRuntimeAccount,
} from "./zulip/accounts.js";
import {
  addZulipReaction,
  createZulipClient,
  createZulipStream,
  deleteZulipMessage,
  deleteZulipStream,
  editZulipMessage,
  fetchZulipMessages,
  fetchZulipStreams,
  fetchZulipSubscriptions,
  normalizeZulipBaseUrl,
  removeZulipReaction,
  resolveZulipStreamId,
  searchZulipMessages,
  sendZulipPrivateMessage,
  sendZulipStreamMessage,
  updateZulipStream,
} from "./zulip/client.js";
import { presentationToZulipWidgetContent } from "./zulip/send.js";
import { isZulipSessionTarget } from "./zulip/destination.js";
import { prependZulipRoutingNotice, resolveZulipSendDestination } from "./zulip/routing-fallback.js";

const providerId = "zulip";
const MAX_STRING_LENGTH = 10000;

/** Per-account message-tool action tier keys. */
export type ZulipActionTierKey = "messages" | "moderation" | "streamAdmin";
/**
 * Per-account action capability tiers for the shared message tool.
 * Tier key -> actions granted while the tier is "on". Gated-off tiers are
 * excluded from discovery and rejected by the handler before any network call.
 */
export const ZULIP_ACTION_TIERS: Record<
  ZulipActionTierKey,
  readonly ChannelMessageActionName[]
> = {
  messages: ["send", "read", "search", "react", "channel-list"],
  moderation: ["edit", "delete", "unsend"],
  streamAdmin: ["channel-create", "channel-edit", "channel-delete"],
};

/**
 * Actions no tier grants. The core-owned cross-channel action vocabulary is
 * deliberately closed, and Zulip member lookup by raw user id is an
 * unrestrained cross-user data request, so it stays unsupported.
 */
export const ZULIP_ALWAYS_OFF_ACTIONS: readonly ChannelMessageActionName[] = [
  "member-info",
];

/**
 * Plugin-executable handler allowlist. Gated-off actions are still handled:
 * the per-account tier check rejects them with a precise error before any
 * network access instead of the generic unsupported-action message.
 */
export const ZULIP_HANDLED_ACTIONS: readonly ChannelMessageActionName[] = [
  ...ZULIP_ACTION_TIERS.messages,
  ...ZULIP_ACTION_TIERS.moderation,
  ...ZULIP_ACTION_TIERS.streamAdmin,
];

/**
 * Full tier-inclusive action name list (tier actions plus always-off members),
 * matching the legacy exported contract shape.
 */
export const ZULIP_ADVERTISED_ACTIONS: readonly ChannelMessageActionName[] = [
  ...ZULIP_HANDLED_ACTIONS,
  ...ZULIP_ALWAYS_OFF_ACTIONS,
];

const ZULIP_HANDLED_ACTION_SET: ReadonlySet<ChannelMessageActionName> = new Set(
  ZULIP_HANDLED_ACTIONS,
);

const ZULIP_GATED_OFF_ACTIONS: ReadonlySet<ChannelMessageActionName> = new Set([
  ...ZULIP_ACTION_TIERS.moderation,
  ...ZULIP_ACTION_TIERS.streamAdmin,
]);

const ZULIP_ACTION_TIER_KEYS: readonly ZulipActionTierKey[] = [
  "messages",
  "moderation",
  "streamAdmin",
];

/** Actions to advertise for a resolved tier map; gated-off tiers are excluded. */
export function advertiseZulipActions(
  tiers: Record<ZulipActionTierKey, boolean>,
): ChannelMessageActionName[] {
  const actions: ChannelMessageActionName[] = [...ZULIP_ACTION_TIERS.messages];
  if (tiers.moderation) {
    actions.push(...ZULIP_ACTION_TIERS.moderation);
  }
  if (tiers.streamAdmin) {
    actions.push(...ZULIP_ACTION_TIERS.streamAdmin);
  }
  return actions.sort();
}

function resolveZulipAccountTiers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Record<ZulipActionTierKey, boolean> {
  try {
    const account = resolveZulipAccount(params);
    return {
      messages: account.actionTiers.messages === "on",
      moderation: account.actionTiers.moderation === "on",
      streamAdmin: account.actionTiers.streamAdmin === "on",
    };
  } catch {
    // Fail closed: unreadable account config gates every elevated action off.
    return { messages: false, moderation: false, streamAdmin: false };
  }
}

/**
 * Reject gated-off actions before any network access. edit/delete/unsend are
 * gated conservatively as moderation: the adapter does not resolve message
 * ownership over the network, so any edit or delete may target another user's
 * message. Stream create/edit/delete belong to streamAdmin. Always-off
 * actions (member-info) are never handled, so they fail in the unsupported
 * pre-check above.
 */
function requireZulipActionTier(params: {
  action: ChannelMessageActionName;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): void {
  if (!ZULIP_GATED_OFF_ACTIONS.has(params.action)) {
    return;
  }
  const tiers = resolveZulipAccountTiers(params);
  const tier: ZulipActionTierKey | undefined = ZULIP_ACTION_TIER_KEYS.find(
    (key) => key !== "messages" && ZULIP_ACTION_TIERS[key].includes(params.action),
  );
  if (tier && tiers[tier]) {
    return;
  }
  throw new Error(
    `Zulip action ${params.action} is gated off; set channels.zulip.actionTiers.${tier ?? "moderation"}: "on" for this account to enable it.`,
  );
}

const ZULIP_MESSAGE_DESTRUCTIVE_ACTIONS = [
  "delete",
  "unsend",
] as const satisfies readonly ChannelMessageActionName[];

const ZULIP_ACTION_SCHEMA: ChannelMessageToolSchemaContribution[] = [
  {
    properties: {
      confirm: { type: "boolean", description: "Set to true to confirm destructive actions." },
    },
    actions: ZULIP_MESSAGE_DESTRUCTIVE_ACTIONS,
    visibility: "current-channel" as const,
  },
  {
    properties: {
      includeAllPublic: {
        type: "boolean",
        description: "Include all public streams, not only subscriptions.",
      },
      includePublic: { type: "boolean" },
      allPublic: { type: "boolean" },
      all: { type: "boolean" },
    },
    actions: ["channel-list"] as const satisfies readonly ChannelMessageActionName[],
    visibility: "current-channel" as const,
  },
  {
    properties: {
      emojiCode: { type: "string" },
      emoji_code: { type: "string" },
      reactionType: { type: "string" },
      reaction_type: { type: "string" },
    },
    actions: ["react"] as const satisfies readonly ChannelMessageActionName[],
    visibility: "current-channel" as const,
  },
];

type StreamTarget = {
  stream: string;
  topic?: string;
};

type ZulipReactionParams = {
  emojiName: string;
  emojiCode?: string;
  reactionType?: string;
};

const expressiveUnicodeReactions = {
  thumbsUp: {
    emojiName: "thumbs_up",
    emojiCode: "1f44d",
    reactionType: "unicode_emoji",
  },
  thumbsDown: {
    emojiName: "thumbs_down",
    emojiCode: "1f44e",
    reactionType: "unicode_emoji",
  },
  infinity: {
    emojiName: "infinity",
    emojiCode: "267e",
    reactionType: "unicode_emoji",
  },
  brain: {
    emojiName: "brain",
    emojiCode: "1f9e0",
    reactionType: "unicode_emoji",
  },
  thinking: {
    emojiName: "thinking",
    emojiCode: "1f914",
    reactionType: "unicode_emoji",
  },
  joy: {
    emojiName: "joy",
    emojiCode: "1f602",
    reactionType: "unicode_emoji",
  },
  tada: {
    emojiName: "tada",
    emojiCode: "1f389",
    reactionType: "unicode_emoji",
  },
  heart: {
    emojiName: "heart",
    emojiCode: "2764",
    reactionType: "unicode_emoji",
  },
  fire: {
    emojiName: "fire",
    emojiCode: "1f525",
    reactionType: "unicode_emoji",
  },
  eyes: {
    emojiName: "eyes",
    emojiCode: "1f440",
    reactionType: "unicode_emoji",
  },
  warning: {
    emojiName: "warning",
    emojiCode: "26a0",
    reactionType: "unicode_emoji",
  },
} satisfies Record<string, ZulipReactionParams>;

const unicodeReactionMap: Record<string, ZulipReactionParams> = {
  "\u{1f44d}": expressiveUnicodeReactions.thumbsUp,
  "\u{1f44e}": expressiveUnicodeReactions.thumbsDown,
  "\u267e": expressiveUnicodeReactions.infinity,
  "\u267e\ufe0f": expressiveUnicodeReactions.infinity,
  "\u{1f9e0}": expressiveUnicodeReactions.brain,
  "\u{1f914}": expressiveUnicodeReactions.thinking,
  "\u{1f602}": expressiveUnicodeReactions.joy,
  "\u{1f389}": expressiveUnicodeReactions.tada,
  "\u2764": expressiveUnicodeReactions.heart,
  "\u2764\ufe0f": expressiveUnicodeReactions.heart,
  "\u{1f525}": expressiveUnicodeReactions.fire,
  "\u{1f440}": expressiveUnicodeReactions.eyes,
  "\u26a0": expressiveUnicodeReactions.warning,
  "\u26a0\ufe0f": expressiveUnicodeReactions.warning,
};

const namedReactionAliases: Record<string, ZulipReactionParams> = {
  "+1": expressiveUnicodeReactions.thumbsUp,
  thumbs_up: expressiveUnicodeReactions.thumbsUp,
  thumbsup: expressiveUnicodeReactions.thumbsUp,
  "-1": expressiveUnicodeReactions.thumbsDown,
  thumbs_down: expressiveUnicodeReactions.thumbsDown,
  thumbsdown: expressiveUnicodeReactions.thumbsDown,
  infinity: expressiveUnicodeReactions.infinity,
  brain: expressiveUnicodeReactions.brain,
  thinking: expressiveUnicodeReactions.thinking,
  thinking_face: expressiveUnicodeReactions.thinking,
  joy: expressiveUnicodeReactions.joy,
  laugh: expressiveUnicodeReactions.joy,
  laughing: expressiveUnicodeReactions.joy,
  tada: expressiveUnicodeReactions.tada,
  party: expressiveUnicodeReactions.tada,
  heart: expressiveUnicodeReactions.heart,
  red_heart: expressiveUnicodeReactions.heart,
  fire: expressiveUnicodeReactions.fire,
  eyes: expressiveUnicodeReactions.eyes,
  warning: expressiveUnicodeReactions.warning,
};

async function resolveZulipClient(cfg: OpenClawConfig, accountId?: string | null) {
  const account = await resolveZulipRuntimeAccount({ cfg, accountId });
  const apiKey = account.apiKey?.trim();
  const email = account.email?.trim();
  if (!apiKey || !email) {
    throw new Error(
      `Zulip apiKey/email missing for account "${account.accountId}" (set channels.zulip.accounts.${account.accountId}.apiKey/email or ZULIP_API_KEY/ZULIP_EMAIL for default).`,
    );
  }
  const baseUrl = normalizeZulipBaseUrl(account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Zulip url missing for account "${account.accountId}" (set channels.zulip.accounts.${account.accountId}.url or ZULIP_URL for default).`,
    );
  }
  return {
    account,
    client: createZulipClient({ baseUrl, apiKey, email }),
  };
}

function requireDestructiveConfirmation(params: Record<string, unknown>): void {
  if (params.confirm !== true) {
    throw new Error("This destructive action requires confirm: true.");
  }
}

export function splitStreamTarget(raw: string): StreamTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Stream is required for Zulip channel actions.");
  }

  const lower = trimmed.toLowerCase();
  let candidate = trimmed;
  if (lower.startsWith("stream:")) {
    candidate = trimmed.slice("stream:".length).trim();
  } else if (trimmed.startsWith("#")) {
    candidate = trimmed.slice(1).trim();
  }

  if (!candidate) {
    throw new Error("Stream name is required for Zulip channel actions.");
  }

  let stream = candidate;
  let topic: string | undefined;
  const topicMatch = /(?:^|\s)topic:\s*(.+)$/i.exec(candidate);
  if (topicMatch) {
    stream = candidate.slice(0, topicMatch.index).trim();
    topic = topicMatch[1].trim();
  } else {
    const sepIndex = lower.startsWith("stream:") ? candidate.indexOf(":") : candidate.search(/[:\/#]/);
    if (sepIndex > -1) {
      stream = candidate.slice(0, sepIndex).trim();
      topic = candidate.slice(sepIndex + 1).trim();
    }
  }

  if (!stream) {
    throw new Error("Stream name is required for Zulip channel actions.");
  }

  assertStringLength(stream, "stream", MAX_STRING_LENGTH);
  if (topic) {
    assertStringLength(topic, "topic", MAX_STRING_LENGTH);
  }

  return { stream, topic };
}

function assertStringLength(value: string, field: string, max = MAX_STRING_LENGTH): void {
  if (value.length > max) {
    throw new Error(`${field} must be ${max} characters or fewer.`);
  }
}

function readMessageId(params: Record<string, unknown>): string {
  const messageId = readStringParam(params, "messageId") ?? readStringParam(params, "id");
  if (messageId) {
    return messageId;
  }
  const numericId =
    readNumberParam(params, "messageId", { integer: true }) ??
    readNumberParam(params, "id", { integer: true });
  if (typeof numericId === "number") {
    return String(numericId);
  }
  throw new Error("messageId is required for Zulip message actions.");
}

function readStreamId(params: Record<string, unknown>): string {
  const streamId =
    readStringParam(params, "streamId") ??
    readStringParam(params, "channelId") ??
    readStringParam(params, "id");
  if (streamId) {
    return streamId;
  }
  const numericId =
    readNumberParam(params, "streamId", { integer: true }) ??
    readNumberParam(params, "channelId", { integer: true }) ??
    readNumberParam(params, "id", { integer: true });
  if (typeof numericId === "number") {
    return String(numericId);
  }
  throw new Error("streamId is required for Zulip channel actions.");
}

function parseBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function readBooleanParam(params: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const parsed = parseBooleanValue(params[key]);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }
  return undefined;
}

function parseStringArrayParam(
  params: Record<string, unknown>,
  key: string,
): Array<string | number> | undefined {
  if (!Object.prototype.hasOwnProperty.call(params, key)) {
    return undefined;
  }
  const raw = params[key];
  if (Array.isArray(raw)) {
    return raw as Array<string | number>;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }
    return trimmed
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof raw === "number") {
    return [raw];
  }
  return undefined;
}

function resolveReactionParams(
  rawEmojiName: string,
  params: { emojiCode?: string; reactionType?: string },
): ZulipReactionParams {
  const trimmed = rawEmojiName.trim().replace(/^:+|:+$/g, "");
  const unicodeReaction = unicodeReactionMap[trimmed];
  const namedReaction = namedReactionAliases[trimmed.toLowerCase()];
  const resolved = unicodeReaction ?? namedReaction ?? { emojiName: trimmed };
  return {
    emojiName: resolved.emojiName,
    emojiCode: params.emojiCode ?? resolved.emojiCode,
    reactionType: params.reactionType ?? resolved.reactionType,
  };
}

function readSendMessageContent(params: Record<string, unknown>): string {
  const content =
    readStringParam(params, "message", { allowEmpty: true }) ??
    readStringParam(params, "text", { allowEmpty: true }) ??
    readStringParam(params, "content", { allowEmpty: true }) ??
    readStringParam(params, "newText", { allowEmpty: true });
  if (content === undefined) {
    throw new Error("message content is required for Zulip sends.");
  }
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Zulip message is empty.");
  }
  assertStringLength(trimmed, "message", MAX_STRING_LENGTH);
  return trimmed;
}

export const zulipMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const account = resolveZulipAccount({ cfg, accountId });
    if (!isZulipAccountConfigured(account)) {
      return { actions: [] };
    }
    return {
      actions: advertiseZulipActions({
        messages: account.actionTiers.messages === "on",
        moderation: account.actionTiers.moderation === "on",
        streamAdmin: account.actionTiers.streamAdmin === "on",
      }),
      capabilities: ["presentation"],
      schema: ZULIP_ACTION_SCHEMA,
    };
  },
  supportsAction: ({ action }) => ZULIP_HANDLED_ACTION_SET.has(action),
  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "send") {
      return null;
    }
    const to = typeof args.to === "string" ? args.to : undefined;
    if (!to) {
      return null;
    }
    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },
  prepareSendPayload: ({ payload }) => payload,
  handleAction: async ({ action, params, cfg, accountId, toolContext, dryRun }) => {
    if (!ZULIP_HANDLED_ACTION_SET.has(action)) {
      throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
    }
    requireZulipActionTier({ action, cfg, accountId });
    const { client, account } = await resolveZulipClient(cfg, accountId ?? undefined);

    if (action === "send") {
      const to = readStringParam(params, "to", { required: true, trim: false });
      let content = readSendMessageContent(params);
      const threadId = typeof params.threadId === "string" || typeof params.threadId === "number"
        ? params.threadId
        : undefined;
      if (dryRun && isZulipSessionTarget(to)) {
        return jsonResult({ ok: true, dryRun: true, action, routingFallback: "bot-owner-lookup", requestedTarget: to });
      }
      const { target, fallback } = await resolveZulipSendDestination({
        client, to, topic: threadId, accountId: account.accountId, config: account.config,
      });
      content = prependZulipRoutingNotice(content, fallback);
      if (target.kind === "stream") {
        assertStringLength(target.stream, "stream", MAX_STRING_LENGTH);
        assertStringLength(target.topic, "topic", MAX_STRING_LENGTH);
      } else {
        assertStringLength(target.email, "email", MAX_STRING_LENGTH);
      }
      const widgetContent = presentationToZulipWidgetContent(
        normalizeMessagePresentation(params.presentation),
      );

      if (dryRun) {
        return jsonResult({
          ok: true,
          dryRun: true,
          action,
          target,
          hasPresentation: Boolean(widgetContent),
        });
      }

      if (target.kind === "stream") {
        const result = await sendZulipStreamMessage(client, {
          stream: target.stream,
          topic: target.topic,
          content,
          widgetContent,
        });
        return jsonResult({ success: true, messageId: result.id, ...(fallback ? { to: fallback.destination, routingFallback: fallback } : {}) });
      }

      const result = await sendZulipPrivateMessage(client, {
        to: [target.email],
        content,
        widgetContent,
      });
      return jsonResult({ success: true, messageId: result.id, ...(fallback ? { to: fallback.destination, routingFallback: fallback } : {}) });
    }

    if (action === "channel-list") {
      const includeAllPublic =
        params.includeAllPublic === true ||
        params.includePublic === true ||
        params.allPublic === true ||
        params.all === true;
      const subscriptions = await fetchZulipSubscriptions(client, {
        includeAllPublic,
      });
      const publicStreams = includeAllPublic ? await fetchZulipStreams(client) : undefined;
      return jsonResult({
        ok: true,
        subscriptions,
        ...(publicStreams ? { publicStreams } : {}),
      });
    }

    if (action === "read") {
      const raw =
        readStringParam(params, "stream") ??
        readStringParam(params, "channelId") ??
        readStringParam(params, "to", { required: true });
      const target = splitStreamTarget(raw);
      const limit = readNumberParam(params, "limit", { integer: true });
      const explicitTopic = typeof params.topic === "string" ? params.topic.trim() : undefined;
      const messages = await fetchZulipMessages(client, {
        stream: target.stream,
        topic: explicitTopic ?? target.topic,
        limit: limit ?? undefined,
      });
      return jsonResult({
        ok: true,
        stream: target.stream,
        ...(explicitTopic !== undefined || target.topic !== undefined ? { topic: explicitTopic ?? target.topic } : {}),
        messages,
      });
    }

    if (action === "react") {
      let messageId: string;
      try {
        messageId = readMessageId(params);
      } catch {
        if (toolContext?.currentMessageId != null) {
          messageId = String(toolContext.currentMessageId);
        } else {
          throw new Error(
            "messageId required. Provide messageId explicitly or react to the current inbound message.",
          );
        }
      }
      const emojiName =
        readStringParam(params, "emoji") ??
        readStringParam(params, "emojiName") ??
        readStringParam(params, "emoji_name");
      const emojiCode =
        readStringParam(params, "emojiCode") ?? readStringParam(params, "emoji_code");
      const reactionType =
        readStringParam(params, "reactionType") ?? readStringParam(params, "reaction_type");
      const remove = params.remove === true;

      if (!emojiName) {
        throw new Error("Zulip react requires emoji name.");
      }

      const reaction = resolveReactionParams(emojiName, {
        emojiCode: emojiCode ?? undefined,
        reactionType: reactionType ?? undefined,
      });
      if (!reaction.emojiName) {
        throw new Error("Zulip react requires emoji name.");
      }

      if (dryRun) {
        return jsonResult({
          ok: true,
          dryRun: true,
          action: remove ? "remove-reaction" : "add-reaction",
          messageId,
          emoji: reaction.emojiName,
          emojiCode: reaction.emojiCode,
          reactionType: reaction.reactionType,
        });
      }

      if (remove) {
        await removeZulipReaction(client, {
          messageId,
          emojiName: reaction.emojiName,
          emojiCode: reaction.emojiCode,
          reactionType: reaction.reactionType,
        });
        return jsonResult({ ok: true, removed: true, messageId, emoji: reaction.emojiName });
      }

      await addZulipReaction(client, {
        messageId,
        emojiName: reaction.emojiName,
        emojiCode: reaction.emojiCode,
        reactionType: reaction.reactionType,
      });
      return jsonResult({ ok: true, added: reaction.emojiName, messageId });
    }

    if (action === "edit") {
      const messageId = readMessageId(params);
      const content = readSendMessageContent(params);
      if (dryRun) {
        return jsonResult({ ok: true, dryRun: true, action, messageId });
      }
      await editZulipMessage(client, { messageId, content });
      return jsonResult({ ok: true, edited: messageId });
    }

    if (action === "delete" || action === "unsend") {
      requireDestructiveConfirmation(params);
      const messageId = readMessageId(params);
      if (dryRun) {
        return jsonResult({ ok: true, dryRun: true, action, messageId });
      }
      await deleteZulipMessage(client, { messageId });
      return jsonResult({ ok: true, deleted: messageId });
    }

    if (action === "channel-create") {
      const raw =
        readStringParam(params, "stream") ??
        readStringParam(params, "name") ??
        readStringParam(params, "to", { required: true });
      const target = splitStreamTarget(raw);
      const description = readStringParam(params, "description", { allowEmpty: true });
      if (description !== undefined) {
        assertStringLength(description, "description", MAX_STRING_LENGTH);
      }
      const principals = parseStringArrayParam(params, "principals") ?? parseStringArrayParam(params, "principal");
      const inviteOnly = readBooleanParam(params, "inviteOnly", "invite_only", "isPrivate", "is_private");
      const isWebPublic = readBooleanParam(params, "isWebPublic", "is_web_public");
      const announce = readBooleanParam(params, "announce");
      const isDefaultStream = readBooleanParam(params, "isDefaultStream", "is_default_stream", "defaultStream");
      const historyPublicToSubscribers = readBooleanParam(
        params,
        "historyPublicToSubscribers",
        "history_public_to_subscribers",
      );
      if (dryRun) {
        return jsonResult({
          ok: true,
          dryRun: true,
          action,
          stream: target.stream,
          ...(description !== undefined ? { description } : {}),
          ...(principals ? { principals } : {}),
        });
      }
      await createZulipStream(client, {
        name: target.stream,
        description: description ?? undefined,
        principals: principals && principals.length > 0 ? principals : undefined,
        announce,
        inviteOnly,
        isWebPublic,
        isDefaultStream,
        historyPublicToSubscribers,
      });
      return jsonResult({ ok: true, stream: target.stream });
    }

    if (action === "channel-edit") {
      const streamIdOrName = readStreamId(params);
      const description = readStringParam(params, "description", { allowEmpty: true });
      const newName = readStringParam(params, "newName") ?? readStringParam(params, "name");
      if (description !== undefined) {
        assertStringLength(description, "description", MAX_STRING_LENGTH);
      }
      if (newName !== undefined) {
        assertStringLength(newName, "name", MAX_STRING_LENGTH);
      }
      const isPrivate = readBooleanParam(params, "isPrivate", "inviteOnly", "invite_only", "is_private");
      const isWebPublic = readBooleanParam(params, "isWebPublic", "is_web_public");
      const historyPublicToSubscribers = readBooleanParam(
        params,
        "historyPublicToSubscribers",
        "history_public_to_subscribers",
      );
      const isDefaultStream = readBooleanParam(params, "isDefaultStream", "is_default_stream");

      if (
        description === undefined &&
        newName === undefined &&
        isPrivate === undefined &&
        isWebPublic === undefined &&
        historyPublicToSubscribers === undefined &&
        isDefaultStream === undefined
      ) {
        throw new Error("At least one field is required to update a Zulip channel.");
      }

      if (dryRun) {
        return jsonResult({
          ok: true,
          dryRun: true,
          action,
          streamId: streamIdOrName,
          ...(newName !== undefined ? { name: newName } : {}),
        });
      }

      const streamId = await resolveZulipStreamId(client, streamIdOrName);
      await updateZulipStream(client, {
        streamId,
        description: description ?? undefined,
        newName: newName ?? undefined,
        isPrivate,
        isWebPublic,
        historyPublicToSubscribers,
        isDefaultStream,
      });
      return jsonResult({ ok: true, streamId, ...(newName ? { name: newName } : {}) });
    }

    if (action === "channel-delete") {
      requireDestructiveConfirmation(params);
      const streamIdOrName = readStreamId(params);
      if (dryRun) {
        return jsonResult({ ok: true, dryRun: true, action, streamId: streamIdOrName });
      }
      const streamId = await resolveZulipStreamId(client, streamIdOrName);
      await deleteZulipStream(client, streamId);
      return jsonResult({ ok: true, streamId });
    }

    if (action === "search") {
      const query =
        readStringParam(params, "query") ??
        readStringParam(params, "text") ??
        readStringParam(params, "q", { required: true });
      assertStringLength(query, "query", MAX_STRING_LENGTH);
      const rawStream =
        readStringParam(params, "stream") ??
        readStringParam(params, "channelId") ??
        readStringParam(params, "to");
      const explicitTopic = typeof params.topic === "string" ? params.topic.trim() : undefined;
      const limit = readNumberParam(params, "limit", { integer: true });
      const target = rawStream ? splitStreamTarget(rawStream) : undefined;
      const messages = await searchZulipMessages(client, {
        query,
        stream: target?.stream,
        topic: explicitTopic ?? target?.topic,
        limit: limit ?? undefined,
      });
      return jsonResult({
        ok: true,
        query,
        ...(target?.stream ? { stream: target.stream } : {}),
        ...(explicitTopic !== undefined || target?.topic !== undefined ? { topic: explicitTopic ?? target?.topic } : {}),
        messages,
      });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
