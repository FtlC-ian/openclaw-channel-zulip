import fs from "node:fs/promises";
import path from "node:path";
import type {
  ChannelAccountSnapshot,
  OpenClawConfig,
  OpenClawPluginApi,
  ReplyPayload,
  RuntimeEnv,
} from "../sdk.js";
import { createChannelPairingController } from "../sdk.js";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth-native";
import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logTypingFailure,
} from "openclaw/plugin-sdk/channel-feedback";
import { formatInboundEnvelope, logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import { mergeDmAllowFromSources, resolveGroupAllowFromSources } from "openclaw/plugin-sdk/allow-from";
import { readChannelIngressStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createReplyPrefixOptions, createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
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
  editZulipMessage,
  deleteZulipMessage,
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
import { downloadZulipUpload, extractZulipUploadUrls, sanitizeUploadFilename } from "./uploads.js";
import {
  createZulipStatusReactionAdapter,
  resolveZulipReactionSpec,
  resolveZulipStatusReactionConfig,
} from "./status-reactions.js";
import { registerZulipSubagentReactionContext } from "./subagent-reactions.js";
import {
  isZulipTopicAllowed,
  resolveZulipInboundStreamPolicy,
  zulipStreamOverridesExpandLegacySelection,
  type ResolvedZulipInboundStreamPolicy,
} from "./stream-policy.js";

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
const PLACEHOLDER_DELETE_MAX_ATTEMPTS = 3;
const PLACEHOLDER_DELETE_RETRY_MS = 50;
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

function clearZulipStreamMetadataCache(accountId: string): void {
  const prefix = `${accountId}:`;
  for (const key of streamMetadataCache.keys()) {
    if (key.startsWith(prefix)) {
      streamMetadataCache.delete(key);
    }
  }
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
    const metadataSnapshot: ZulipStreamMetadata[] = [];
    for (const subscription of subscriptions) {
      const metadata = normalizeZulipStreamMetadata(subscription);
      if (metadata) {
        metadataSnapshot.push(metadata);
      }
    }
    clearZulipStreamMetadataCache(params.accountId);
    for (const metadata of metadataSnapshot) {
      cacheZulipStreamMetadata(params.accountId, metadata);
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

async function resolveFreshZulipStreamMetadata(params: {
  client: ReturnType<typeof createZulipClient>;
  accountId: string;
  streamId: string;
  log: (message: string) => void;
}): Promise<ZulipStreamMetadata | undefined> {
  const streamId = params.streamId.trim();
  if (!streamId) {
    return undefined;
  }
  try {
    const stream = await fetchZulipStream(params.client, streamId);
    const metadata = normalizeZulipStreamMetadata(stream);
    if (!metadata?.name?.trim()) {
      return undefined;
    }
    cacheZulipStreamMetadata(params.accountId, metadata);
    return metadata;
  } catch (err) {
    params.log(`zulip: fresh stream metadata lookup failed streamId=${streamId}: ${String(err)}`);
    return undefined;
  }
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

const ABORTED_INBOUND_MESSAGE = Symbol("aborted-inbound-message");
const RETRYABLE_INBOUND_MESSAGE = Symbol("retryable-inbound-message");
const RETRYABLE_STREAM_POLICY = Symbol("retryable-stream-policy");
const activeMonitorReactionCleanups = new Set<() => Promise<void>>();
let monitorReactionShutdownStarted = false;

export function startZulipMonitorReactionLifecycles(): void {
  monitorReactionShutdownStarted = false;
}

export async function clearActiveZulipMonitorReactionLifecycles(): Promise<void> {
  monitorReactionShutdownStarted = true;
  await Promise.allSettled(
    Array.from(activeMonitorReactionCleanups, (cleanup) => cleanup()),
  );
}

export function registerZulipMonitorReactionHooks(api: OpenClawPluginApi): void {
  api.on("gateway_start", startZulipMonitorReactionLifecycles);
  api.on("gateway_stop", clearActiveZulipMonitorReactionLifecycles);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => finish();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      finish();
      return;
    }
    timer = setTimeout(finish, ms);
  });
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

  const mediaMaxBytes =
    (account.config.mediaMaxMb || cfg.agents?.defaults?.mediaMaxMb || 5) * 1024 * 1024;

  const statusReactionConfig = resolveZulipStatusReactionConfig({
    accountConfig: account.config,
    globalStatusReactions: cfg.messages?.statusReactions,
  });
  const activeMessageTasks = new Set<Promise<void>>();
  const activeReactionCleanups = new Set<() => Promise<void>>();
  let reactionCleanupChain = Promise.resolve();
  const cleanupActiveReactionLifecycles = (): Promise<void> => {
    const pending = Array.from(activeReactionCleanups, (cleanup) => cleanup());
    reactionCleanupChain = Promise.allSettled([reactionCleanupChain, ...pending]).then(
      () => undefined,
    );
    return reactionCleanupChain;
  };
  const thinkingPlaceholderConfig = account.config.thinkingPlaceholder;
  const thinkingPlaceholderEnabled = thinkingPlaceholderConfig?.enabled === true;
  const thinkingPlaceholderText = thinkingPlaceholderConfig?.text?.trim() || "Thinking…";
  const thinkingPlaceholderErrorText =
    thinkingPlaceholderConfig?.errorText?.trim() || "I couldn't complete that response.";

  const pairing = createChannelPairingController({
    core,
    channel: "zulip",
    accountId: account.accountId,
  });

  type InboundStreamDecision = {
    accepted: boolean;
    streamId: string;
    streamName: string;
    topic: string;
    policy: ResolvedZulipInboundStreamPolicy;
  };
  type InboundStreamResolution =
    | {
      ok: true;
      decision: InboundStreamDecision | typeof RETRYABLE_STREAM_POLICY | undefined;
    }
    | { ok: false; error: unknown };

  const resolveInboundStreamDecision = async (
    message: ZulipMessage,
    options: { replay?: boolean } = {},
  ): Promise<InboundStreamDecision | typeof RETRYABLE_STREAM_POLICY | undefined> => {
    if (message.type === "private") {
      return undefined;
    }
    const streamId = String(message.stream_id ?? "").trim();
    if (!streamId) {
      return {
        accepted: false,
        streamId,
        streamName: "",
        topic: message.subject?.trim() || defaultTopic,
        policy: { enabled: false },
      };
    }

    const eventStreamName =
      typeof message.display_recipient === "string"
        ? message.display_recipient.trim()
        : "";
    let streamName = options.replay ? "" : eventStreamName;
    if (options.replay) {
      const metadata = await resolveFreshZulipStreamMetadata({
        client,
        accountId: account.accountId,
        streamId,
        log: logVerboseMessage,
      });
      if (!metadata?.name?.trim()) {
        return RETRYABLE_STREAM_POLICY;
      }
      streamName = metadata.name.trim();
    } else if (!streamName) {
      const metadata = await resolveCachedZulipStreamMetadata({
        client,
        accountId: account.accountId,
        streamId,
        log: logVerboseMessage,
      });
      streamName = metadata?.name?.trim() || streamName;
    } else {
      const key = streamMetadataCacheKey(account.accountId, streamId);
      const cached = streamMetadataCache.get(key);
      if (cached) {
        cacheZulipStreamMetadata(account.accountId, {
          ...cached,
          name: streamName,
        });
      }
    }

    const topic = message.subject?.trim() || defaultTopic;
    const policy = resolveZulipInboundStreamPolicy({
      config: account.config,
      streamName,
      streamId,
    });
    return {
      accepted: policy.enabled && isZulipTopicAllowed({ topic, policy }),
      streamId,
      streamName,
      topic,
      policy,
    };
  };

  const logRejectedStreamDecision = (
    decision: InboundStreamDecision,
    senderIdentity: string,
  ): void => {
    logInboundDrop({
      log: logVerboseMessage,
      channel: "zulip",
      reason: decision.policy.enabled
        ? `topic filter (${decision.streamName || decision.streamId}:${decision.topic})`
        : `stream disabled (${decision.streamName || decision.streamId})`,
      target: senderIdentity,
    });
  };

  const handleMessage = async (
    message: ZulipMessage,
    options: {
      skipRecentDedupe?: boolean;
      streamDecision?: InboundStreamDecision;
      replay?: boolean;
      acceptInbound?: () => Promise<boolean>;
    } = {},
  ) => {
    if (opts.abortSignal?.aborted || monitorReactionShutdownStarted) {
      return ABORTED_INBOUND_MESSAGE;
    }
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
    let inboundStreamPolicy: ResolvedZulipInboundStreamPolicy | undefined;

    if (isDM) {
      channelId = dmTargetIdentity;
    } else {
      const streamDecision =
        options.streamDecision ??
        await resolveInboundStreamDecision(message, { replay: options.replay });
      if (streamDecision === RETRYABLE_STREAM_POLICY) {
        return RETRYABLE_STREAM_POLICY;
      }
      if (!streamDecision || !streamDecision.accepted) {
        if (streamDecision) {
          logRejectedStreamDecision(streamDecision, senderIdentity);
        }
        return;
      }
      streamId = streamDecision.streamId;
      channelId = streamId;
      streamName = streamDecision.streamName;
      topic = streamDecision.topic;
      inboundStreamPolicy = streamDecision.policy;
    }

    const rawText = stripHtmlToText(message.content ?? "");
    const oncharResult = stripOncharPrefix(rawText, oncharPrefixes);

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
      await readChannelIngressStoreAllowFromForDmPolicy({
        provider: "zulip",
        accountId: account.accountId,
        dmPolicy,
        readStore: pairing.readStoreForDmPolicy,
      }),
    );
    const effectiveAllowFrom = mergeDmAllowFromSources({
      dmPolicy,
      allowFrom: normalizedAllowFrom,
      storeAllowFrom,
    });
    const effectiveGroupAllowFrom = resolveGroupAllowFromSources({
      allowFrom: normalizedAllowFrom,
      groupAllowFrom: normalizedGroupAllowFrom,
    });

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
        requireMentionOverride: inboundStreamPolicy?.requireMention ?? account.requireMention,
      });
    const shouldBypassMention =
      isControlCommand && shouldRequireMention && !wasMentioned && commandAuthorized;
    const effectiveWasMentioned = wasMentioned || shouldBypassMention || oncharTriggered;
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;

    const shouldApplyOncharGate =
      oncharEnabled && (kind === "dm" || inboundStreamPolicy?.requireMention !== false);
    if (shouldApplyOncharGate && !oncharTriggered && !wasMentioned && !isControlCommand) {
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

    if (options.acceptInbound && !await options.acceptInbound()) {
      return;
    }

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

    const timestamp = message.timestamp ? message.timestamp * 1000 : undefined;
    const textWithId = `${bodyText}\n[zulip message id: ${messageId}]`;
    const body = formatInboundEnvelope({
      channel: "Zulip",
      from: fromLabel,
      timestamp,
      body: textWithId,
      chatType,
      sender: { name: senderName, id: senderIdentity },
    });

    const to =
      kind === "dm" ? `user:${dmTargetIdentity}` : `stream:${streamName || streamId}:${topic}`;
    const ctxPayload = core.channel.inbound.buildContext({
      channel: "zulip",
      accountId: route.accountId,
      messageId,
      timestamp,
      from: kind === "dm" ? `zulip:${senderIdentity}` : `zulip:channel:${channelId}`,
      sender: { name: senderName, id: senderIdentity },
      conversation: {
        kind: chatType,
        id: isDM ? dmTargetIdentity : (streamConversation?.conversationId ?? channelId),
        label: fromLabel,
        threadId: streamConversation?.threadId,
      },
      route: {
        agentId: route.agentId,
        accountId: route.accountId,
        routeSessionKey: sessionKey,
        parentSessionKey,
      },
      reply: {
        to,
        replyToId: topic || undefined,
        messageThreadId: streamConversation?.threadId,
      },
      message: { body, rawBody: bodyText, commandBody: bodyText },
      access: {
        commands: { authorized: commandAuthorized },
        ...(kind !== "dm" ? {
          mentions: { canDetectMention, wasMentioned: effectiveWasMentioned },
        } : {}),
      },
      media: mediaPaths.map((mediaPath, index) => ({
        path: mediaPath,
        url: mediaUrls[index],
        contentType: mediaTypes[index],
      })),
      extra: {
        ChannelPrivacy: channelPrivacy,
        IsPrivateChannel:
          kind !== "dm" && channelPrivacy !== "unknown" ? channelPrivacy === "private" : undefined,
        InviteOnly: streamMetadata?.inviteOnly,
        IsWebPublic: streamMetadata?.isWebPublic,
        HistoryPublicToSubscribers: streamMetadata?.historyPublicToSubscribers,
        SubscriberCount: streamMetadata?.subscriberCount,
        StreamId: kind !== "dm" ? streamId : undefined,
        GroupSubject: kind !== "dm" ? roomLabel : undefined,
        GroupChannel: streamName ? `#${streamName}` : undefined,
      },
    });

    const sessionCfg = cfg.session;
      const storePath = core.agent.session.resolveStorePath(sessionCfg?.store, {
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

    const addReactionSafe = async (reaction: {
      emojiName: string;
      emojiCode?: string;
      reactionType?: string;
    }) => {
      if (
        monitorReactionShutdownStarted ||
        !statusReactionConfig.enabled ||
        !reaction.emojiName
      ) {
        return;
      }
      try {
        await addZulipReaction(client, { messageId, ...reaction });
      } catch (err) {
        logVerboseMessage(`zulip: failed to add reaction ${reaction.emojiName}: ${String(err)}`);
      }
    };
    const addStatusReaction = async (reaction: {
      emojiName: string;
      emojiCode?: string;
      reactionType?: string;
    }) => {
      if (
        !monitorReactionShutdownStarted &&
        statusReactionConfig.enabled &&
        reaction.emojiName
      ) {
        await addZulipReaction(client, { messageId, ...reaction });
      }
    };
    const removeStatusReaction = async (reaction: {
      emojiName: string;
      emojiCode?: string;
      reactionType?: string;
    }) => {
      if (statusReactionConfig.enabled && reaction.emojiName) {
        await removeZulipReaction(client, { messageId, ...reaction });
      }
    };
    const removeReactionSafe = async (reaction: {
      emojiName: string;
      emojiCode?: string;
      reactionType?: string;
    }) => {
      if (!statusReactionConfig.enabled || !reaction.emojiName) {
        return;
      }
      try {
        await removeZulipReaction(client, { messageId, ...reaction });
      } catch (err) {
        logVerboseMessage(`zulip: failed to remove reaction ${reaction.emojiName}: ${String(err)}`);
      }
    };
    let replyDeliveryCommitted = false;
    let placeholderMessageId: string | undefined;
    let placeholderCreationPromise: Promise<void> | undefined;
    let placeholderDeletionPromise: Promise<boolean> | undefined;
    let placeholderEditPromise: Promise<boolean> | undefined;
    let placeholderRemovedForDelivery = false;
    let deliveredReply = false;

    const deletePlaceholder = async (forDelivery = false): Promise<boolean> => {
      await placeholderEditPromise;
      const activeDeletion = placeholderDeletionPromise;
      if (activeDeletion) {
        const deleted = await activeDeletion;
        if (deleted && forDelivery) {
          placeholderRemovedForDelivery = true;
        }
        return deleted;
      }
      const placeholderId = placeholderMessageId;
      if (!placeholderId) {
        return false;
      }
      const deletion = (async () => {
        try {
          await deleteZulipMessage(client, { messageId: placeholderId });
          if (placeholderMessageId === placeholderId) {
            placeholderMessageId = undefined;
          }
          return true;
        } catch (err) {
          logVerboseMessage(`zulip: failed to delete thinking placeholder: ${String(err)}`);
          return false;
        }
      })();
      placeholderDeletionPromise = deletion;
      const deleted = await deletion;
      if (placeholderDeletionPromise === deletion) {
        placeholderDeletionPromise = undefined;
      }
      if (deleted && forDelivery) {
        placeholderRemovedForDelivery = true;
      }
      return deleted;
    };

    const replacePlaceholder = async (content: string): Promise<boolean> => {
      const activeDeletion = placeholderDeletionPromise;
      if (activeDeletion) {
        await activeDeletion;
        return false;
      }
      const activeEdit = placeholderEditPromise;
      if (activeEdit) {
        return await activeEdit;
      }
      const placeholderId = placeholderMessageId;
      if (!placeholderId) {
        return false;
      }
      const edit = (async () => {
        try {
          await editZulipMessage(client, { messageId: placeholderId, content });
          if (placeholderMessageId === placeholderId) {
            placeholderMessageId = undefined;
          }
          core.channel.activity.record({
            channel: "zulip",
            accountId: account.accountId,
            direction: "outbound",
          });
          return true;
        } catch (err) {
          logVerboseMessage(`zulip: failed to replace thinking placeholder: ${String(err)}`);
          return false;
        }
      })();
      placeholderEditPromise = edit;
      const edited = await edit;
      if (placeholderEditPromise === edit) {
        placeholderEditPromise = undefined;
      }
      return edited;
    };

    const cleanupPlaceholderLifecycle = async (): Promise<void> => {
      await placeholderCreationPromise;
      await placeholderEditPromise;
      for (
        let attempt = 1;
        placeholderMessageId && attempt <= PLACEHOLDER_DELETE_MAX_ATTEMPTS;
        attempt += 1
      ) {
        if (await deletePlaceholder()) {
          return;
        }
        if (attempt < PLACEHOLDER_DELETE_MAX_ATTEMPTS) {
          await delay(PLACEHOLDER_DELETE_RETRY_MS);
        }
      }
      if (placeholderMessageId) {
        runtime.error?.(
          `zulip: thinking placeholder cleanup failed after ${PLACEHOLDER_DELETE_MAX_ATTEMPTS} attempts`,
        );
      }
    };
    if (opts.abortSignal?.aborted || monitorReactionShutdownStarted) {
      return ABORTED_INBOUND_MESSAGE;
    }
    const statusReactions = createStatusReactionController({
      enabled: statusReactionConfig.enabled,
      adapter: createZulipStatusReactionAdapter({
        add: addStatusReaction,
        remove: removeStatusReaction,
      }),
      initialEmoji: statusReactionConfig.emojis.queued,
      emojis: statusReactionConfig.emojis,
      timing: statusReactionConfig.timing,
      onError: (err) => {
        runtime.error?.(`zulip: status reaction update failed: ${String(err)}`);
      },
    });
    statusReactions.setQueued();

    const subagentReaction = resolveZulipReactionSpec(statusReactionConfig.subagent);
    const subagentContext = registerZulipSubagentReactionContext({
      requesterSessionKey: String(ctxPayload.SessionKey ?? sessionKey),
      show: () => addReactionSafe(subagentReaction),
      hide: () => removeReactionSafe(subagentReaction),
    });
    let terminalCleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let reactionLifecycleCancelled = false;
    let statusLifecycleSettled = false;
    let subagentLifecycleSettled = false;
    const releaseReactionCleanupIfSettled = () => {
      if (statusLifecycleSettled && subagentLifecycleSettled && !placeholderMessageId) {
        activeReactionCleanups.delete(cancelReactionLifecycle);
      }
    };
    let reactionLifecycleCleanup: Promise<void> | undefined;
    const cancelReactionLifecycle = () => {
      reactionLifecycleCleanup ??= (async () => {
        reactionLifecycleCancelled = true;
        if (terminalCleanupTimer) {
          clearTimeout(terminalCleanupTimer);
          terminalCleanupTimer = undefined;
        }
        activeReactionCleanups.delete(cancelReactionLifecycle);
        await Promise.allSettled([
          statusReactions.clear(),
          subagentContext.cancel(),
          cleanupPlaceholderLifecycle(),
        ]);
      })();
      return reactionLifecycleCleanup;
    };
    activeReactionCleanups.add(cancelReactionLifecycle);
    void subagentContext.closed.then(() => {
      subagentLifecycleSettled = true;
      releaseReactionCleanupIfSettled();
    });
    if (opts.abortSignal?.aborted || monitorReactionShutdownStarted) {
      await cancelReactionLifecycle();
      opts.statusSink?.({ lastInboundAt: Date.now() });
      return ABORTED_INBOUND_MESSAGE;
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

    if (
      thinkingPlaceholderEnabled &&
      !reactionLifecycleCancelled &&
      !monitorReactionShutdownStarted &&
      !opts.abortSignal?.aborted
    ) {
      placeholderCreationPromise = (async () => {
        try {
          const placeholder = await sendMessageZulip(to, thinkingPlaceholderText, {
            cfg,
            accountId: account.accountId,
            topic,
          });
          if (placeholder.messageId !== "unknown") {
            placeholderMessageId = placeholder.messageId;
          } else {
            logVerboseMessage("zulip: thinking placeholder send returned no message id");
          }
        } catch (err) {
          logVerboseMessage(`zulip: failed to create thinking placeholder: ${String(err)}`);
        }
      })();
      await placeholderCreationPromise;
      if (reactionLifecycleCancelled || monitorReactionShutdownStarted || opts.abortSignal?.aborted) {
        await cancelReactionLifecycle();
        opts.statusSink?.({ lastInboundAt: Date.now() });
        return ABORTED_INBOUND_MESSAGE;
      }
    }
    let deliveryError: unknown;
    let hasDeliveryError = false;
    const dispatcherOptions = {
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      onReplyStart: async () => {
        await typingCallbacks.onReplyStart();
        await statusReactions.setThinking();
      },
      onIdle: typingCallbacks.onIdle,
      deliver: async (payload: ReplyPayload) => {
        let deliveredThisPayload = false;
        const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        const hasOutboundMetadata = Boolean(payload.presentation || payload.channelData);
        const rawText = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
        const { text, topic: topicOverride } = extractZulipTopicDirective(rawText);
        const resolvedTopic = topicOverride ? topicOverride.slice(0, 60) : topic;
        if (mediaUrls.length === 0) {
          const chunkMode = core.channel.text.resolveChunkMode(cfg, "zulip", account.accountId);
          const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
          let first = true;
          for (const chunk of chunks.length > 0 ? chunks : [text]) {
            if (!chunk && !(first && hasOutboundMetadata)) {
              continue;
            }
            const replacedPlaceholder =
              first &&
              chunk &&
              !hasOutboundMetadata &&
              resolvedTopic === topic &&
              (await replacePlaceholder(chunk));
            if (replacedPlaceholder) {
              replyDeliveryCommitted = true;
              deliveredReply = true;
              deliveredThisPayload = true;
              first = false;
              continue;
            }
            if (first) {
              await deletePlaceholder(true);
            }
            await sendMessageZulip(to, chunk, {
              cfg,
              accountId: account.accountId,
              topic: resolvedTopic,
              presentation: first ? payload.presentation : undefined,
              channelData: first ? payload.channelData : undefined,
            });
            replyDeliveryCommitted = true;
            deliveredReply = true;
            deliveredThisPayload = true;
            first = false;
          }
        } else {
          await deletePlaceholder(true);
          let first = true;
          for (const mediaUrl of mediaUrls) {
            const isFirst = first;
            const caption = isFirst ? text : "";
            await sendMessageZulip(to, caption, {
              cfg,
              accountId: account.accountId,
              mediaUrl,
              topic: resolvedTopic,
              presentation: isFirst ? payload.presentation : undefined,
              channelData: isFirst ? payload.channelData : undefined,
            });
            replyDeliveryCommitted = true;
            deliveredReply = true;
            deliveredThisPayload = true;
            first = false;
          }
        }
        if (deliveredThisPayload) {
          opts.statusSink?.({ lastOutboundAt: Date.now() });
        }
      },
      onError: (err: unknown) => {
        if (!hasDeliveryError) {
          deliveryError = err;
          hasDeliveryError = true;
        }
        runtime.error?.(`zulip reply failed: ${String(err)}`);
      },
    };

    let dispatchError: unknown;
    let dispatchResult:
      | {
          counts?: Partial<Record<"tool" | "block" | "final", number>>;
          failedCounts?: Partial<Record<"tool" | "block" | "final", number>>;
        }
      | undefined;
    try {
      dispatchResult = await subagentContext.run(() =>
        core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions,
          replyOptions: {
            disableBlockStreaming:
              typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
            abortSignal: opts.abortSignal,
            onModelSelected,
            allowToolLifecycleWhenProgressHidden: statusReactionConfig.enabled ? true : undefined,
            onToolStart: async (payload) => {
              if (payload.phase === "end") {
                statusReactions.cancelPending();
                await statusReactions.setThinking();
                return;
              }
              await statusReactions.setTool(payload.name);
            },
            onCompactionStart: async () => {
              await statusReactions.setCompacting();
            },
            onCompactionEnd: async () => {
              statusReactions.cancelPending();
              await statusReactions.setThinking();
            },
          },
        }),
      );
    } catch (err) {
      dispatchError = err;
      runtime.error?.(`zulip reply failed: ${String(err)}`);
    }
    if (dispatchError === undefined && hasDeliveryError) {
      dispatchError = deliveryError;
    }

    const successfulReplyCount =
      (dispatchResult?.counts?.tool ?? 0) +
      (dispatchResult?.counts?.block ?? 0) +
      (dispatchResult?.counts?.final ?? 0);
    replyDeliveryCommitted ||= successfulReplyCount > 0;
    const abortOutcome = () =>
      replyDeliveryCommitted ? undefined : ABORTED_INBOUND_MESSAGE;

    if (reactionLifecycleCancelled || opts.abortSignal?.aborted) {
      await deletePlaceholder();
      await cancelReactionLifecycle();
      opts.statusSink?.({ lastInboundAt: Date.now() });
      return abortOutcome();
    }

    await subagentContext.finish();
    if (reactionLifecycleCancelled || opts.abortSignal?.aborted) {
      await deletePlaceholder();
      await cancelReactionLifecycle();
      opts.statusSink?.({ lastInboundAt: Date.now() });
      return abortOutcome();
    }
    const finalDeliveryFailed = (dispatchResult?.failedCounts?.final ?? 0) > 0;
    const terminalError = Boolean(dispatchError) || finalDeliveryFailed;
    if (placeholderMessageId) {
      const cancelled = dispatchError instanceof Error && dispatchError.name === "AbortError";
      if (!terminalError || cancelled || deliveredReply) {
        await deletePlaceholder();
      } else {
        const errorFeedbackCommitted = await replacePlaceholder(thinkingPlaceholderErrorText);
        if (errorFeedbackCommitted) {
          replyDeliveryCommitted = true;
          opts.statusSink?.({ lastOutboundAt: Date.now() });
        } else {
          await deletePlaceholder();
        }
      }
    } else if (
      dispatchError &&
      !(dispatchError instanceof Error && dispatchError.name === "AbortError") &&
      placeholderRemovedForDelivery &&
      !deliveredReply
    ) {
      try {
        await sendMessageZulip(to, thinkingPlaceholderErrorText, {
          cfg,
          accountId: account.accountId,
          topic,
        });
        core.channel.activity.record({
          channel: "zulip",
          accountId: account.accountId,
          direction: "outbound",
        });
        replyDeliveryCommitted = true;
        opts.statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        logVerboseMessage(`zulip: failed to send thinking placeholder error: ${String(err)}`);
      }
    }
    const retryableNoDelivery = terminalError && !replyDeliveryCommitted;
    if (terminalError) {
      await statusReactions.setError();
    } else {
      await statusReactions.setDone();
    }
    if (reactionLifecycleCancelled || opts.abortSignal?.aborted) {
      await deletePlaceholder();
      await cancelReactionLifecycle();
      opts.statusSink?.({ lastInboundAt: Date.now() });
      return abortOutcome();
    }
    if (account.config.reactions?.clearOnFinish !== false) {
      const terminalHoldMs = terminalError
        ? (statusReactionConfig.timing?.errorHoldMs ?? DEFAULT_TIMING.errorHoldMs)
        : (statusReactionConfig.timing?.doneHoldMs ?? DEFAULT_TIMING.doneHoldMs);
      terminalCleanupTimer = setTimeout(() => {
        terminalCleanupTimer = undefined;
        if (reactionLifecycleCancelled) {
          return;
        }
        void statusReactions.clear().finally(() => {
          statusLifecycleSettled = true;
          releaseReactionCleanupIfSettled();
        });
      }, terminalHoldMs);
      terminalCleanupTimer.unref?.();
    } else {
      statusLifecycleSettled = true;
      releaseReactionCleanupIfSettled();
    }

    opts.statusSink?.({ lastInboundAt: Date.now() });
    return retryableNoDelivery ? RETRYABLE_INBOUND_MESSAGE : undefined;
  };

  // Register event queue
  const streams = account.streams ?? ["*"];
  const registrationStreams = zulipStreamOverridesExpandLegacySelection({
    streams: account.streams,
    streamOverrides: account.config.streamOverrides,
  }) ? ["*"] : streams;
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
    streams: registrationStreams,
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
    options: {
      replay?: boolean;
      streamDecision?: InboundStreamDecision;
      acceptInbound?: () => Promise<boolean>;
      durableAccepted?: () => boolean;
    } = {},
  ): Promise<void> => {
    try {
      const outcome = await handleMessage(message, {
        skipRecentDedupe: options.replay,
        replay: options.replay,
        streamDecision: options.streamDecision,
        acceptInbound: options.acceptInbound,
      });
      const manageDurableRecord =
        Boolean(durableId) &&
        (!options.acceptInbound || options.durableAccepted?.() === true);
      if (outcome === ABORTED_INBOUND_MESSAGE) {
        if (durableInboundJournal && durableId && manageDurableRecord) {
          await durableInboundJournal.release(durableId, {
            lastError: "Zulip monitor stopped before delivery",
          });
        }
        return;
      }
      if (outcome === RETRYABLE_INBOUND_MESSAGE) {
        if (durableInboundJournal && durableId && manageDurableRecord) {
          await durableInboundJournal.release(durableId, {
            lastError: "Zulip reply delivery failed before any visible response",
          });
        }
        return;
      }
      if (outcome === RETRYABLE_STREAM_POLICY) {
        if (durableInboundJournal && durableId && manageDurableRecord) {
          await durableInboundJournal.release(durableId, {
            lastError: "Zulip stream metadata unavailable during durable replay",
          });
        }
        return;
      }
      if (manageDurableRecord) {
        await completeDurableInboundMessage(durableId, metadata);
      }
    } catch (err) {
      if (
        durableInboundJournal &&
        durableId &&
        options.acceptInbound &&
        options.durableAccepted?.() !== true
      ) {
        await options.acceptInbound();
      }
      if (
        durableInboundJournal &&
        durableId &&
        (!options.acceptInbound || options.durableAccepted?.() === true)
      ) {
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
    streamResolution?: InboundStreamResolution,
  ): Promise<void> => {
    const messageId = String(message.id ?? "");
    const metadata: ZulipDurableInboundMetadata | undefined =
      queueEventId !== undefined ? { queueEventId } : undefined;
    let durableId: string | undefined;
    let durableAccepted = false;
    let acceptInbound: (() => Promise<boolean>) | undefined;
    if (durableInboundJournal && messageId) {
      const acceptedDurableId = createZulipDurableInboundMessageId({
        accountId: account.accountId,
        messageId,
      });
      durableId = acceptedDurableId;
      acceptInbound = async (): Promise<boolean> => {
        try {
          const accepted = await durableInboundJournal.accept(
            acceptedDurableId,
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
          durableAccepted = accepted.kind === "accepted";
          return durableAccepted;
        } catch (err) {
          runtime.log?.(`zulip: failed persisting durable inbound; delivering live: ${String(err)}`);
          return true;
        }
      };
    }

    let streamDecision: InboundStreamDecision | typeof RETRYABLE_STREAM_POLICY | undefined;
    try {
      if (streamResolution?.ok === false) {
        throw streamResolution.error;
      }
      streamDecision = streamResolution?.ok
        ? streamResolution.decision
        : await resolveInboundStreamDecision(message);
    } catch (err) {
      if (acceptInbound) {
        await acceptInbound();
      }
      if (durableInboundJournal && durableId && durableAccepted) {
        await durableInboundJournal.release(durableId, { lastError: String(err) });
      }
      runtime.error?.(`zulip ingress policy evaluation failed: ${String(err)}`);
      return;
    }
    if (streamDecision === RETRYABLE_STREAM_POLICY) {
      return;
    }
    if (streamDecision && !streamDecision.accepted) {
      logRejectedStreamDecision(
        streamDecision,
        message.sender_email?.trim() || String(message.sender_id ?? ""),
      );
      return;
    }

    await deliverDurableInboundMessage(durableId, message, metadata, {
      streamDecision,
      acceptInbound,
      durableAccepted: () => durableAccepted,
    });
  };

  const handleMonitorAbort = () => {
    void cleanupActiveReactionLifecycles();
  };
  opts.abortSignal?.addEventListener("abort", handleMonitorAbort, { once: true });

  const replayPendingDurableInboundMessages = async (): Promise<void> => {
    if (!durableInboundJournal) {
      return;
    }
    const pending = await durableInboundJournal.pending();
    for (const record of pending) {
      if (opts.abortSignal?.aborted) {
        break;
      }
      const payload = record.payload as ZulipDurableInboundPayload;
      await deliverDurableInboundMessage(
        record.id,
        deserializeZulipDurableInboundMessage<ZulipMessage>(payload.message),
        record.metadata,
        { replay: true },
      );
    }
  };

  activeMonitorReactionCleanups.add(cleanupActiveReactionLifecycles);
  try {
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
              streams: registrationStreams,
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
          await delay(200, opts.abortSignal);
        }

        resetPollBackoff();

        // Process messages with staggered start times for more natural feel
        for (const event of events) {
          if (opts.abortSignal?.aborted) {
            break;
          }
          const nextEventId = Number((event as { id?: unknown })?.id);
          const validEventId =
            !Number.isNaN(nextEventId) && nextEventId >= 0 ? nextEventId : undefined;
          if (validEventId !== undefined) {
            lastEventId = validEventId;
          }

          if (event.type === "message" && event.message) {
            let streamResolution: InboundStreamResolution;
            try {
              streamResolution = {
                ok: true,
                decision: await resolveInboundStreamDecision(event.message),
              };
            } catch (error) {
              streamResolution = { ok: false, error };
            }
            if (streamResolution.ok) {
              const streamDecision = streamResolution.decision;
              if (streamDecision === RETRYABLE_STREAM_POLICY) {
                continue;
              }
              if (streamDecision && !streamDecision.accepted) {
                logRejectedStreamDecision(
                  streamDecision,
                  event.message.sender_email?.trim() || String(event.message.sender_id ?? ""),
                );
                continue;
              }
            }
            // Start processing without awaiting (fire-and-forget with error handling)
            const messageTask = processMessage(event.message, validEventId, streamResolution).catch(
              (err) => {
                runtime.error?.(`zulip: message processing failed: ${String(err)}`);
              },
            );
            activeMessageTasks.add(messageTask);
            void messageTask.finally(() => {
              activeMessageTasks.delete(messageTask);
            });
            // Small delay between starting each eligible message for natural pacing
            await delay(200, opts.abortSignal);
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
            streams: registrationStreams,
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
        await delay(waitMs, opts.abortSignal);
      }
    }
  } finally {
    opts.abortSignal?.removeEventListener("abort", handleMonitorAbort);
    await cleanupActiveReactionLifecycles();
    await Promise.allSettled(Array.from(activeMessageTasks));
    await cleanupActiveReactionLifecycles();
    activeMonitorReactionCleanups.delete(cleanupActiveReactionLifecycles);
  }

  // Cleanup
  await deleteZulipQueue(client, queueId);
  runtime.log?.("zulip monitor stopped");
}
