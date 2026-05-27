import fs from "node:fs/promises";
import path from "node:path";
import type {
  ChannelAccountSnapshot,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "../sdk.js";
import {
  createScopedPairingAccess,
  type HistoryEntry,
} from "../sdk.js";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import { readStoreAllowFromForDmPolicy, resolveDmGroupAccessWithLists } from "openclaw/plugin-sdk/channel-policy";
import { createReplyPrefixOptions, createTypingCallbacks } from "openclaw/plugin-sdk/channel-runtime";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { getZulipRuntime } from "../runtime.js";
import { resolveZulipRuntimeAccount } from "./accounts.js";
import {
  createZulipClient,
  fetchZulipMe,
  fetchZulipStream,
  fetchZulipSubscriptions,
  normalizeZulipBaseUrl,
  registerZulipQueue,
  getZulipEventsWithRetry,
  deleteZulipQueue,
  sendZulipTyping,
  addZulipReaction,
  removeZulipReaction,
  type ZulipMessage,
  type ZulipStream,
  type ZulipSubscription,
} from "./client.js";
import {
  createDedupeCache,
  formatInboundFromLabel,
} from "./monitor-helpers.js";
import {
  createZulipDurableInboundMessageId,
  createZulipDurableInboundReceiveJournal,
  deserializeZulipDurableInboundMessage,
  serializeZulipDurableInboundMessage,
  type ZulipDurableInboundMetadata,
  type ZulipDurableInboundPayload,
} from "./durable-receive.js";
import { buildZulipStreamConversation } from "../session-conversation.js";
import { sendMessageZulip } from "./send.js";
import { downloadZulipUpload, extractZulipUploadUrls, normalizeZulipEmojiName, sanitizeUploadFilename } from "./uploads.js";

export type MonitorZulipOpts = {
  apiKey?: string;
  email?: string;
  baseUrl?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

const RECENT_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MESSAGE_MAX = 2000;
const DEFAULT_ONCHAR_PREFIXES = [">", "!"];
/** Empty string = Zulip's "general chat" (no topic). */
const FALLBACK_TOPIC = "";

const recentInboundMessages = createDedupeCache({
  ttlMs: RECENT_MESSAGE_TTL_MS,
  maxSize: RECENT_MESSAGE_MAX,
});

type ZulipStreamMetadata = {
  streamId: string;
  name?: string | null;
  inviteOnly?: boolean;
  isWebPublic?: boolean;
  historyPublicToSubscribers?: boolean;
  subscriberCount?: number;
};

type ZulipStreamPrivacy = "private" | "public" | "unknown";

const streamMetadataCache = new Map<string, ZulipStreamMetadata>();

function streamMetadataCacheKey(accountId: string, streamId: string): string {
  return `${accountId}:${streamId}`;
}

function normalizeZulipStreamMetadata(
  stream: ZulipStream | ZulipSubscription,
): ZulipStreamMetadata | null {
  const rawStreamId = "id" in stream ? stream.id : stream.stream_id;
  const streamId = String(rawStreamId ?? "").trim();
  if (!streamId) {
    return null;
  }
  return {
    streamId,
    name: stream.name ?? null,
    inviteOnly: stream.invite_only,
    isWebPublic: stream.is_web_public,
    historyPublicToSubscribers: stream.history_public_to_subscribers,
    subscriberCount:
      typeof stream.subscriber_count === "number"
        ? stream.subscriber_count
        : Array.isArray(stream.subscribers)
          ? stream.subscribers.length
          : undefined,
  };
}

function cacheZulipStreamMetadata(accountId: string, metadata: ZulipStreamMetadata): void {
  streamMetadataCache.set(streamMetadataCacheKey(accountId, metadata.streamId), metadata);
}

function resolveZulipStreamPrivacy(
  metadata: ZulipStreamMetadata | undefined,
): ZulipStreamPrivacy {
  if (!metadata) {
    return "unknown";
  }
  if (metadata.inviteOnly === true) {
    return "private";
  }
  if (metadata.inviteOnly === false || metadata.isWebPublic === true) {
    return "public";
  }
  return "unknown";
}

async function seedZulipStreamMetadataCache(params: {
  client: ReturnType<typeof createZulipClient>;
  accountId: string;
  log: (message: string) => void;
}): Promise<void> {
  try {
    const subscriptions = await fetchZulipSubscriptions(params.client, {
      includeAllPublic: true,
      includeSubscribers: true,
    });
    for (const subscription of subscriptions) {
      const metadata = normalizeZulipStreamMetadata(subscription);
      if (metadata) {
        cacheZulipStreamMetadata(params.accountId, metadata);
      }
    }
  } catch (err) {
    params.log(`zulip: stream metadata seed failed: ${String(err)}`);
  }
}

async function resolveCachedZulipStreamMetadata(params: {
  client: ReturnType<typeof createZulipClient>;
  accountId: string;
  streamId: string;
  log: (message: string) => void;
}): Promise<ZulipStreamMetadata | undefined> {
  const streamId = params.streamId.trim();
  if (!streamId) {
    return undefined;
  }
  const key = streamMetadataCacheKey(params.accountId, streamId);
  const cached = streamMetadataCache.get(key);
  if (cached) {
    return cached;
  }
  try {
    const stream = await fetchZulipStream(params.client, streamId);
    const metadata = normalizeZulipStreamMetadata(stream);
    if (metadata) {
      cacheZulipStreamMetadata(params.accountId, metadata);
      return metadata;
    }
  } catch (err) {
    params.log(`zulip: stream metadata lookup failed streamId=${streamId}: ${String(err)}`);
  }
  return undefined;
}

function resolveRuntime(opts: MonitorZulipOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/@\*\*([^*]+)\*\*/g, "@$1")
    .trim();
}

function normalizeMention(text: string, mention: string | undefined): string {
  if (!mention) {
    return text.trim();
  }
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@${escaped}\\b`, "gi");
  return text.replace(re, " ").replace(/\s+/g, " ").trim();
}

function resolveOncharPrefixes(prefixes: string[] | undefined): string[] {
  const cleaned = prefixes?.map((entry) => entry.trim()).filter(Boolean) ?? DEFAULT_ONCHAR_PREFIXES;
  return cleaned.length > 0 ? cleaned : DEFAULT_ONCHAR_PREFIXES;
}

function normalizeTopicFilterValue(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTopicFilterList(values?: string[]): Set<string> | undefined {
  const normalized = (values ?? [])
    .map(normalizeTopicFilterValue)
    .filter(Boolean);
  if (normalized.length === 0 || normalized.includes("*")) {
    return undefined;
  }
  return new Set(normalized);
}

function shouldMonitorTopic(params: {
  topic: string;
  streamName?: string;
  streamId?: string;
  topics?: string[];
  streamTopics?: Record<string, string[]>;
}): boolean {
  const topic = normalizeTopicFilterValue(params.topic);
  const globalTopics = normalizeTopicFilterList(params.topics);
  if (globalTopics && !globalTopics.has(topic)) {
    return false;
  }

  const streamTopics = params.streamTopics ?? {};
  const candidateKeys = [params.streamName, params.streamId]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const matchingStreamFilter = Object.entries(streamTopics).find(([key]) =>
    candidateKeys.some((candidate) => normalizeTopicFilterValue(candidate) === normalizeTopicFilterValue(key)),
  );
  if (!matchingStreamFilter) {
    return true;
  }

  const allowedTopics = normalizeTopicFilterList(matchingStreamFilter[1]);
  return !allowedTopics || allowedTopics.has(topic);
}

function stripOncharPrefix(
  text: string,
  prefixes: string[],
): { triggered: boolean; stripped: string } {
  const trimmed = text.trimStart();
  for (const prefix of prefixes) {
    if (!prefix) {
      continue;
    }
    if (trimmed.startsWith(prefix)) {
      return {
        triggered: true,
        stripped: trimmed.slice(prefix.length).trimStart(),
      };
    }
  }
  return { triggered: false, stripped: text };
}

function extractZulipTopicDirective(text: string): { text: string; topic?: string } {
  const match = text.match(/^\s*\[\[zulip_topic:\s*([^\]]+?)\s*\]\]\s*/i);
  if (!match) {
    return { text };
  }
  const topic = match[1]?.trim();
  if (!topic) {
    return { text: text.slice(match[0].length).trimStart() };
  }
  return {
    text: text.slice(match[0].length).trimStart(),
    topic,
  };
}

function normalizeAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed
    .replace(/^(zulip|user):/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function normalizeAllowList(entries: Array<string | number>): string[] {
  const normalized = entries.map((entry) => normalizeAllowEntry(String(entry))).filter(Boolean);
  return Array.from(new Set(normalized));
}

function isSenderAllowed(params: {
  senderId: string;
  senderName?: string;
  allowFrom: string[];
}): boolean {
  const allowFrom = params.allowFrom;
  if (allowFrom.length === 0) {
    return false;
  }
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = normalizeAllowEntry(params.senderId);
  const normalizedSenderName = params.senderName ? normalizeAllowEntry(params.senderName) : "";
  return allowFrom.some(
    (entry) =>
      entry === normalizedSenderId || (normalizedSenderName && entry === normalizedSenderName),
  );
}

async function saveZulipMediaBuffer(params: {
  core: ReturnType<typeof getZulipRuntime>;
  buffer: Buffer;
  contentType: string;
  filename: string;
  maxBytes: number;
}): Promise<{ path: string; contentType: string } | null> {
  const { core, buffer, contentType, maxBytes } = params;
  const filename = sanitizeUploadFilename(params.filename);
  if (core.channel.media?.saveMediaBuffer) {
    const saved = await core.channel.media.saveMediaBuffer(
      buffer,
      contentType,
      "inbound",
      maxBytes,
      filename,
    );
    return {
      path: saved.path,
      contentType: saved.contentType ?? contentType,
    };
  }
  const dir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "zulip-upload-"));
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, buffer);
  return { path: filePath, contentType };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function monitorZulipProvider(opts: MonitorZulipOpts = {}): Promise<void> {
  const core = getZulipRuntime();
  if (!opts.config) {
    throw new Error("monitorZulipProvider requires resolved runtime config");
  }
  const cfg = opts.config;
  const runtime = resolveRuntime(opts);
  const account = await resolveZulipRuntimeAccount({
    cfg,
    accountId: opts.accountId,
  });

  const apiKey = opts.apiKey?.trim() || account.apiKey?.trim();
  const email = opts.email?.trim() || account.email?.trim();
  if (!apiKey || !email) {
    throw new Error(
      `Zulip apiKey/email missing for account "${account.accountId}" (set channels.zulip.accounts.${account.accountId}.apiKey/email or ZULIP_API_KEY/ZULIP_EMAIL for default).`,
    );
  }
  const baseUrl = normalizeZulipBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Zulip url missing for account "${account.accountId}" (set channels.zulip.accounts.${account.accountId}.url or ZULIP_URL for default).`,
    );
  }

  const client = createZulipClient({ baseUrl, email, apiKey });
  const botUser = await fetchZulipMe(client);
  const botUserId = botUser.id;
  const botEmail = botUser.email ?? "";
  const botUsername = botUser.full_name ?? "";

  runtime.log?.(`zulip connected as ${botUsername ? botUsername : botUserId} (${botEmail})`);

  const logger = core.logging.getChildLogger({ module: "zulip" });
  const logVerboseMessage = core.logging.shouldLogVerbose()
    ? (message: string) => logger.debug?.(message)
    : () => {};
  await seedZulipStreamMetadataCache({
    client,
    accountId: account.accountId,
    log: logVerboseMessage,
  });

  const defaultTopic = account.config.defaultTopic?.trim() ?? FALLBACK_TOPIC;
  const oncharPrefixes = resolveOncharPrefixes(account.oncharPrefixes);
  const oncharEnabled = account.chatmode === "onchar";
  const channelHistories = new Map<string, HistoryEntry[]>();

  const mediaMaxBytes =
    resolveChannelMediaMaxBytes({
      cfg,
      accountId: account.accountId,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        (
          cfg.channels?.zulip as {
            mediaMaxMb?: number;
            accounts?: Record<string, { mediaMaxMb?: number }>;
          }
        )?.accounts?.[accountId]?.mediaMaxMb ??
        (cfg.channels?.zulip as { mediaMaxMb?: number })?.mediaMaxMb,
    }) ?? 5 * 1024 * 1024;

  const reactionConfig = account.config.reactions ?? {};
  const reactionsEnabled = reactionConfig.enabled !== false;
  const reactionClearOnFinish = reactionConfig.clearOnFinish !== false;
  const reactionStart = normalizeZulipEmojiName(reactionConfig.onStart ?? "");
  const reactionSuccess = normalizeZulipEmojiName(reactionConfig.onSuccess ?? "");
  const reactionError = normalizeZulipEmojiName(reactionConfig.onError ?? "warning");

  const pairing = createScopedPairingAccess({
    core,
    channel: "zulip",
    accountId: account.accountId,
  });

  const handleMessage = async (
    message: ZulipMessage,
    options: { skipRecentDedupe?: boolean } = {},
  ) => {
    const messageId = String(message.id ?? "");
    if (!messageId) {
      return;
    }
    const dedupeKey = `${account.accountId}:${messageId}`;
    if (!options.skipRecentDedupe && recentInboundMessages.check(dedupeKey)) {
      return;
    }

    const senderEmail = message.sender_email?.trim() || "";
    const senderUserId = String(message.sender_id ?? "");
    const senderIdentity = senderEmail || senderUserId;
    if (!senderIdentity) {
      return;
    }
    if (senderEmail === botEmail || senderUserId === String(botUserId)) {
      return;
    }

    const senderName = message.sender_full_name?.trim() || senderIdentity;
    const isDM = message.type === "private";
    const kind = isDM ? "dm" : "channel";
    const chatType = isDM ? "direct" : "channel";
    const dmTargetIdentity = senderEmail || senderUserId;

    let streamName = "";
    let streamId = "";
    let topic = defaultTopic;
    let channelId = "";

    if (isDM) {
      channelId = dmTargetIdentity;
    } else {
      streamId = String(message.stream_id ?? "");
      channelId = streamId;
      if (typeof message.display_recipient === "string") {
        streamName = message.display_recipient;
      }
      topic = message.subject?.trim() || defaultTopic;
      if (
        !shouldMonitorTopic({
          topic,
          streamName,
          streamId,
          topics: account.config.topics,
          streamTopics: account.config.streamTopics,
        })
      ) {
        logInboundDrop({
          log: logVerboseMessage,
          channel: "zulip",
          reason: `topic filter (${streamName || streamId}:${topic})`,
          target: senderIdentity,
        });
        return;
      }
    }

    const rawText = stripHtmlToText(message.content ?? "");
    const oncharResult = stripOncharPrefix(rawText, oncharPrefixes);

    const uploadUrls = extractZulipUploadUrls(message.content ?? "", baseUrl);
    const mediaPaths: string[] = [];
    const mediaTypes: string[] = [];
    const mediaUrls: string[] = [];
    if (uploadUrls.length > 0) {
      logVerboseMessage(
        `zulip: discovered ${uploadUrls.length} upload${uploadUrls.length === 1 ? "" : "s"} for message ${messageId} maxBytes=${mediaMaxBytes}`,
      );
      for (const uploadUrl of uploadUrls) {
        try {
          logVerboseMessage(`zulip: downloading upload ${uploadUrl}`);
          const downloaded = await downloadZulipUpload(
            uploadUrl,
            baseUrl,
            client.authHeader,
            mediaMaxBytes,
          );
          logVerboseMessage(
            `zulip: downloaded upload filename=${downloaded.filename} type=${downloaded.contentType} bytes=${downloaded.buffer.length}`,
          );
          const saved = await saveZulipMediaBuffer({
            core,
            buffer: downloaded.buffer,
            contentType: downloaded.contentType,
            filename: downloaded.filename,
            maxBytes: mediaMaxBytes,
          });
          if (saved) {
            mediaPaths.push(saved.path);
            mediaTypes.push(saved.contentType);
            mediaUrls.push(saved.path);
            logVerboseMessage(
              `zulip: saved upload filename=${downloaded.filename} path=${saved.path} type=${saved.contentType}`,
            );
          }
        } catch (err) {
          logVerboseMessage(`zulip: failed to download/save upload ${uploadUrl}: ${String(err)}`);
        }
      }
    }
    const oncharTriggered = oncharEnabled && oncharResult.triggered;

    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, "main");
    const wasMentioned =
      !isDM &&
      (rawText.toLowerCase().includes(`@${botUsername.toLowerCase()}`) ||
        core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));

    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
    const normalizedAllowFrom = normalizeAllowList(account.config.allowFrom ?? []);
    const normalizedGroupAllowFrom = normalizeAllowList(account.config.groupAllowFrom ?? []);
    const storeAllowFrom = normalizeAllowList(
      await readStoreAllowFromForDmPolicy({
        provider: "zulip",
        accountId: account.accountId,
        dmPolicy,
        readStore: pairing.readStoreForDmPolicy,
      }),
    );
    const accessDecision = resolveDmGroupAccessWithLists({
      isGroup: !isDM,
      dmPolicy,
      groupPolicy,
      allowFrom: normalizedAllowFrom,
      groupAllowFrom: normalizedGroupAllowFrom,
      storeAllowFrom,
      isSenderAllowed: (allowFrom) =>
        isSenderAllowed({
          senderId: senderIdentity,
          senderName,
          allowFrom,
        }),
    });
    const effectiveAllowFrom = accessDecision.effectiveAllowFrom;
    const effectiveGroupAllowFrom = accessDecision.effectiveGroupAllowFrom;

    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "zulip",
    });
    const hasControlCommand = core.channel.text.hasControlCommand(rawText, cfg);
    const isControlCommand = allowTextCommands && hasControlCommand;
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const senderAllowedForCommands = isSenderAllowed({
      senderId: senderIdentity,
      senderName,
      allowFrom: effectiveAllowFrom,
    });
    const groupAllowedForCommands = isSenderAllowed({
      senderId: senderIdentity,
      senderName,
      allowFrom: effectiveGroupAllowFrom,
    });
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
        {
          configured: effectiveGroupAllowFrom.length > 0,
          allowed: groupAllowedForCommands,
        },
      ],
      allowTextCommands,
      hasControlCommand,
    });
    const commandAuthorized =
      kind === "dm"
        ? dmPolicy === "open" || senderAllowedForCommands
        : commandGate.commandAuthorized;

    if (kind === "dm") {
      if (dmPolicy === "disabled") {
        logVerboseMessage(`zulip: drop dm (dmPolicy=disabled sender=${senderIdentity})`);
        return;
      }
      if (dmPolicy !== "open" && !senderAllowedForCommands) {
        if (dmPolicy === "pairing") {
          const { code, created } = await pairing.upsertPairingRequest({
            id: senderIdentity,
            meta: { name: senderName },
          });
          logVerboseMessage(`zulip: pairing request sender=${senderIdentity} created=${created}`);
          if (created) {
            try {
              await sendMessageZulip(
                `user:${senderIdentity}`,
                core.channel.pairing.buildPairingReply({
                  channel: "zulip",
                  idLine: `Your Zulip email: ${senderIdentity}`,
                  code,
                }),
                { cfg, accountId: account.accountId },
              );
              opts.statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerboseMessage(`zulip: pairing reply failed for ${senderIdentity}: ${String(err)}`);
            }
          }
        } else {
          logVerboseMessage(`zulip: drop dm sender=${senderIdentity} (dmPolicy=${dmPolicy})`);
        }
        return;
      }
    } else {
      if (groupPolicy === "disabled") {
        logVerboseMessage("zulip: drop group message (groupPolicy=disabled)");
        return;
      }
      if (groupPolicy === "allowlist") {
        if (effectiveGroupAllowFrom.length === 0) {
          logVerboseMessage("zulip: drop group message (no group allowlist)");
          return;
        }
        if (!groupAllowedForCommands) {
          logVerboseMessage(`zulip: drop group sender=${senderIdentity} (not in groupAllowFrom)`);
          return;
        }
      }
    }

    if (kind !== "dm" && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerboseMessage,
        channel: "zulip",
        reason: "control command (unauthorized)",
        target: senderIdentity,
      });
      return;
    }

    const shouldRequireMention =
      kind !== "dm" &&
      core.channel.groups.resolveRequireMention({
        cfg,
        channel: "zulip",
        accountId: account.accountId,
        groupId: channelId,
        requireMentionOverride: account.requireMention,
      });
    const shouldBypassMention =
      isControlCommand && shouldRequireMention && !wasMentioned && commandAuthorized;
    const effectiveWasMentioned = wasMentioned || shouldBypassMention || oncharTriggered;
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;

    if (oncharEnabled && !oncharTriggered && !wasMentioned && !isControlCommand) {
      return;
    }

    if (kind !== "dm" && shouldRequireMention && canDetectMention) {
      if (!effectiveWasMentioned) {
        return;
      }
    }

    const bodySource = oncharTriggered ? oncharResult.stripped : rawText;
    const bodyText = normalizeMention(bodySource, botUsername);
    if (!bodyText) {
      return;
    }

    core.channel.activity.record({
      channel: "zulip",
      accountId: account.accountId,
      direction: "inbound",
    });

    const roomLabel = streamName ? `#${streamName}` : `stream:${streamId}`;
    const fromLabel = formatInboundFromLabel({
      isGroup: kind !== "dm",
      groupLabel: roomLabel,
      groupId: channelId,
      groupFallback: "Stream",
      directLabel: senderName,
      directId: senderIdentity,
    });

    const streamConversation =
      kind === "dm"
        ? null
        : buildZulipStreamConversation({
            streamId: channelId,
            topic,
          });
    const streamMetadata =
      kind === "dm"
        ? undefined
        : await resolveCachedZulipStreamMetadata({
            client,
            accountId: account.accountId,
            streamId: channelId,
            log: logVerboseMessage,
          });
    const channelPrivacy = kind === "dm" ? undefined : resolveZulipStreamPrivacy(streamMetadata);

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
      teamId: undefined,
      peer: {
        kind: chatType,
        id: isDM ? dmTargetIdentity : (streamConversation?.conversationId ?? channelId),
      },
      parentPeer:
        !isDM && streamConversation?.threadId
          ? {
              kind: chatType,
              id: channelId,
            }
          : undefined,
    });

    const parentSessionKey =
      !isDM && streamConversation?.threadId
        ? core.channel.routing.resolveAgentRoute({
            cfg,
            channel: "zulip",
            accountId: account.accountId,
            teamId: undefined,
            peer: {
              kind: chatType,
              id: channelId,
            },
          }).sessionKey
        : undefined;

    const sessionKey = route.sessionKey ?? `zulip:${account.accountId}:${channelId}`;
    const historyKey = kind === "dm" ? null : sessionKey;

    const timestamp = message.timestamp ? message.timestamp * 1000 : undefined;
    const textWithId = `${bodyText}\n[zulip message id: ${messageId}]`;
    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Zulip",
      from: fromLabel,
      timestamp,
      body: textWithId,
      chatType,
      sender: { name: senderName, id: senderIdentity },
    });

    const to =
      kind === "dm" ? `user:${dmTargetIdentity}` : `stream:${streamName || streamId}:${topic}`;
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: bodyText,
      CommandBody: bodyText,
      From: kind === "dm" ? `zulip:${senderIdentity}` : `zulip:channel:${channelId}`,
      To: to,
      SessionKey: sessionKey,
      ParentSessionKey: parentSessionKey,
      AccountId: route.accountId,
      ChatType: chatType,
      ChannelPrivacy: channelPrivacy,
      IsPrivateChannel:
        kind !== "dm" && channelPrivacy !== "unknown" ? channelPrivacy === "private" : undefined,
      InviteOnly: streamMetadata?.inviteOnly,
      IsWebPublic: streamMetadata?.isWebPublic,
      HistoryPublicToSubscribers: streamMetadata?.historyPublicToSubscribers,
      SubscriberCount: streamMetadata?.subscriberCount,
      StreamId: kind !== "dm" ? streamId : undefined,
      ConversationLabel: fromLabel,
      GroupSubject: kind !== "dm" ? roomLabel : undefined,
      GroupChannel: streamName ? `#${streamName}` : undefined,
      SenderName: senderName,
      SenderId: senderIdentity,
      Provider: "zulip" as const,
      Surface: "zulip" as const,
      MessageSid: messageId,
      ReplyToId: topic ? topic : undefined,
      MessageThreadId: streamConversation?.threadId,
      Timestamp: timestamp,
      WasMentioned: kind !== "dm" ? effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "zulip" as const,
      OriginatingTo: to,
      MediaPath: mediaPaths[0],
      MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
      MediaUrl: mediaUrls[0],
      MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      MediaType: mediaTypes[0],
      MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    });

    const sessionCfg = cfg.session;
    const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId,
    });
    await core.channel.session.updateLastRoute({
      storePath,
      sessionKey: route.mainSessionKey,
      deliveryContext: {
        channel: "zulip",
        to,
        accountId: route.accountId,
      },
    });

    const previewLine = bodyText.slice(0, 200).replace(/\n/g, "\\n");
    logVerboseMessage(
      `zulip inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`,
    );

    const addReactionSafe = async (emojiName: string) => {
      if (!reactionsEnabled || !emojiName) {
        return;
      }
      try {
        await addZulipReaction(client, { messageId, emojiName });
      } catch (err) {
        logVerboseMessage(`zulip: failed to add reaction ${emojiName}: ${String(err)}`);
      }
    };
    const removeReactionSafe = async (emojiName: string) => {
      if (!reactionsEnabled || !emojiName) {
        return;
      }
      try {
        await removeZulipReaction(client, { messageId, emojiName });
      } catch (err) {
        logVerboseMessage(`zulip: failed to remove reaction ${emojiName}: ${String(err)}`);
      }
    };

    if (reactionsEnabled) {
      await addReactionSafe(reactionStart);
    }

    const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "zulip", account.accountId, {
      fallbackLimit: account.textChunkLimit ?? 4000,
    });
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "zulip",
      accountId: account.accountId,
    });

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "zulip",
      accountId: account.accountId,
    });

    const typingParams = isDM
      ? { op: "start" as const, type: "direct" as const, to: [Number(message.sender_id)] }
      : streamId
        ? { op: "start" as const, type: "stream" as const, streamId: Number(streamId), topic }
        : null;

    const typingCallbacks = createTypingCallbacks({
      start: async () => {
        if (typingParams) {
          await sendZulipTyping(client, typingParams);
        }
      },
      stop: async () => {
        if (typingParams) {
          await sendZulipTyping(client, { ...typingParams, op: "stop" });
        }
      },
      onStartError: (err) => {
        logTypingFailure({
          log: logVerboseMessage,
          channel: "zulip",
          target: isDM ? senderIdentity : `stream:${streamId}:${topic}`,
          error: err,
        });
      },
      onStopError: (err) => {
        logTypingFailure({
          log: logVerboseMessage,
          channel: "zulip",
          target: isDM ? senderIdentity : `stream:${streamId}:${topic}`,
          error: err,
        });
      },
    });

    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        ...prefixOptions,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        onReplyStart: typingCallbacks.onReplyStart,
        onIdle: typingCallbacks.onIdle,
        deliver: async (payload: ReplyPayload) => {
          const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          const rawText = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
          const { text, topic: topicOverride } = extractZulipTopicDirective(rawText);
          const resolvedTopic = topicOverride ? topicOverride.slice(0, 60) : topic;
          if (mediaUrls.length === 0) {
            const chunkMode = core.channel.text.resolveChunkMode(cfg, "zulip", account.accountId);
            const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
            for (const chunk of chunks.length > 0 ? chunks : [text]) {
              if (!chunk) {
                continue;
              }
              await sendMessageZulip(to, chunk, {
                cfg,
                accountId: account.accountId,
                topic: resolvedTopic,
              });
            }
          } else {
            let first = true;
            for (const mediaUrl of mediaUrls) {
              const caption = first ? text : "";
              first = false;
              await sendMessageZulip(to, caption, {
                cfg,
                accountId: account.accountId,
                mediaUrl,
                topic: resolvedTopic,
              });
            }
          }
          opts.statusSink?.({ lastOutboundAt: Date.now() });
        },
        onError: (err: unknown) => {
          runtime.error?.(`zulip reply failed: ${String(err)}`);
        },
      });

    let dispatchError: unknown;
    try {
      await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          disableBlockStreaming:
            typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
          onModelSelected,
        },
      });
    } catch (err) {
      dispatchError = err;
      runtime.error?.(`zulip reply failed: ${String(err)}`);
    } finally {
      markDispatchIdle();
    }

    if (reactionsEnabled) {
      if (reactionClearOnFinish) {
        await removeReactionSafe(reactionStart);
      }
      if (dispatchError) {
        await addReactionSafe(reactionError);
      } else {
        await addReactionSafe(reactionSuccess);
      }
    }

    if (historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: channelHistories,
        historyKey,
        limit: DEFAULT_GROUP_HISTORY_LIMIT,
      });
    }

    opts.statusSink?.({ lastInboundAt: Date.now() });
  };

  // Register event queue
  const streams = account.streams ?? ["*"];
  const durableInboundJournal = (() => {
    try {
      return createZulipDurableInboundReceiveJournal(account.accountId);
    } catch (err) {
      logVerboseMessage(`zulip: durable inbound receive journal unavailable: ${String(err)}`);
      return undefined;
    }
  })();
  const queue = await registerZulipQueue(client, {
    eventTypes: ["message"],
    streams, // Pass ["*"] to trigger all_public_streams=true in registerZulipQueue
  });
  let queueId = queue.queueId;
  let lastEventId = queue.lastEventId;
  let pollBackoffMs = 0;

  runtime.log?.(`zulip event queue registered: ${queueId}`);

  const resetPollBackoff = () => {
    pollBackoffMs = 0;
  };

  const completeDurableInboundMessage = async (
    durableId: string | undefined,
    metadata: ZulipDurableInboundMetadata | undefined,
  ): Promise<void> => {
    if (!durableInboundJournal || !durableId) {
      return;
    }
    await durableInboundJournal.complete(
      durableId,
      metadata?.queueEventId !== undefined
        ? { metadata: { queueEventId: metadata.queueEventId } }
        : undefined,
    );
  };

  const deliverDurableInboundMessage = async (
    durableId: string | undefined,
    message: ZulipMessage,
    metadata?: ZulipDurableInboundMetadata,
    options: { replay?: boolean } = {},
  ): Promise<void> => {
    try {
      await handleMessage(message, { skipRecentDedupe: options.replay });
      await completeDurableInboundMessage(durableId, metadata);
    } catch (err) {
      if (durableInboundJournal && durableId) {
        await durableInboundJournal.release(durableId, {
          lastError: String(err),
        });
      }
      runtime.error?.(`zulip message handler failed: ${String(err)}`);
    }
  };

  const processMessage = async (
    message: ZulipMessage,
    queueEventId?: number,
  ): Promise<void> => {
    if (!durableInboundJournal) {
      await deliverDurableInboundMessage(undefined, message);
      return;
    }

    const messageId = String(message.id ?? "");
    if (!messageId) {
      await deliverDurableInboundMessage(undefined, message);
      return;
    }

    const durableId = createZulipDurableInboundMessageId({
      accountId: account.accountId,
      messageId,
    });
    const metadata: ZulipDurableInboundMetadata | undefined =
      queueEventId !== undefined ? { queueEventId } : undefined;
    try {
      const accepted = await durableInboundJournal.accept(
        durableId,
        {
          message: serializeZulipDurableInboundMessage(message),
          receivedAt: Date.now(),
        },
        {
          ...(metadata ? { metadata } : {}),
          receivedAt:
            typeof message.timestamp === "number" ? message.timestamp * 1000 : Date.now(),
        },
      );
      if (accepted.kind !== "accepted") {
        return;
      }
    } catch (err) {
      runtime.log?.(`zulip: failed persisting durable inbound; delivering live: ${String(err)}`);
      await deliverDurableInboundMessage(undefined, message);
      return;
    }

    await deliverDurableInboundMessage(durableId, message, metadata);
  };

  const replayPendingDurableInboundMessages = async (): Promise<void> => {
    if (!durableInboundJournal) {
      return;
    }
    const pending = await durableInboundJournal.pending();
    for (const record of pending) {
      const payload = record.payload as ZulipDurableInboundPayload;
      await deliverDurableInboundMessage(
        record.id,
        deserializeZulipDurableInboundMessage<ZulipMessage>(payload.message),
        record.metadata,
        { replay: true },
      );
    }
  };

  await replayPendingDurableInboundMessages();

  // Long-poll at 90s — nginx proxy_read_timeout is now 120s
  while (!opts.abortSignal?.aborted) {
    try {
      const response = await getZulipEventsWithRetry(client, {
        queueId,
        lastEventId,
        timeoutMs: 90000,
        retryBaseDelayMs: 1000,
        signal: opts.abortSignal,
        dontBlock: false,
      });

      if (response.result === "error") {
        const msg = response.msg ?? "";
        const isBadQueue =
          response.code === "BAD_EVENT_QUEUE_ID" || msg.toLowerCase().includes("bad event queue");
        if (isBadQueue) {
          runtime.log?.("zulip: queue expired, re-registering...");
          const newQueue = await registerZulipQueue(client, {
            eventTypes: ["message"],
            streams, // Pass ["*"] to trigger all_public_streams=true in registerZulipQueue
          });
          queueId = newQueue.queueId;
          lastEventId = newQueue.lastEventId;
          runtime.log?.(`zulip event queue re-registered: ${queueId}`);
          resetPollBackoff();
          continue;
        }
        throw new Error(`Zulip events error: ${response.msg}`);
      }

      const events = response.events ?? [];
      runtime.log?.(`zulip: poll ok, ${events.length} events, lastEventId=${lastEventId}`);
      if (events.length > 0) {
        opts.statusSink?.({
          connected: true,
          lastConnectedAt: Date.now(),
        });
      }

      if (events.length === 0) {
        await delay(200);
      }

      resetPollBackoff();

      // Process messages with staggered start times for more natural feel
      for (const event of events) {
        const nextEventId = Number((event as { id?: unknown })?.id);
        const validEventId = !Number.isNaN(nextEventId) && nextEventId >= 0 ? nextEventId : undefined;
        if (validEventId !== undefined) {
          lastEventId = validEventId;
        }

        if (event.type === "message" && event.message) {
          // Start processing without awaiting (fire-and-forget with error handling)
          processMessage(event.message, validEventId).catch((err) => {
            runtime.error?.(`zulip: message processing failed: ${String(err)}`);
          });
          // Small delay between starting each message for natural pacing
          await delay(200);
        }
      }
    } catch (err) {
      if (opts.abortSignal?.aborted) {
        break;
      }
      const errStr = String(err);
      if (errStr.toLowerCase().includes("bad event queue")) {
        runtime.log?.("zulip: bad event queue error thrown; re-registering...");
        const newQueue = await registerZulipQueue(client, {
          eventTypes: ["message"],
          streams,
        });
        queueId = newQueue.queueId;
        lastEventId = newQueue.lastEventId;
        runtime.log?.(`zulip event queue re-registered: ${queueId}`);
        resetPollBackoff();
        continue;
      }
      const status = (err as { status?: number })?.status;
      const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs;
      runtime.error?.(`zulip polling error: ${String(err)}`);
      opts.statusSink?.({
        connected: false,
        lastError: String(err),
      });
      const baseDelay = status === 429 ? 10000 : 1000;
      if (!pollBackoffMs) {
        pollBackoffMs = baseDelay;
      } else {
        pollBackoffMs = Math.min(120000, pollBackoffMs * 2);
      }
      const waitMs =
        retryAfterMs && retryAfterMs > 0 ? Math.min(120000, retryAfterMs) : pollBackoffMs;
      await delay(waitMs);
    }
  }

  // Cleanup
  await deleteZulipQueue(client, queueId);
  runtime.log?.("zulip monitor stopped");
}
