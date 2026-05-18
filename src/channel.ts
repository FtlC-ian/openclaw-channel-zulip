import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelAccountSnapshot,
  type ChannelOutboundAdapter,
  type ChannelPlugin,
  type ReplyPayload,
} from "./sdk.js";
import { zulipMessageActions } from "./actions.js";
import { ZulipConfigSchema } from "./config-schema.js";
import { resolveZulipGroupRequireMention } from "./group-mentions.js";
import { looksLikeZulipTargetId, normalizeZulipMessagingTarget } from "./normalize.js";
import { getZulipRuntime } from "./runtime.js";
import type { ZulipAccountConfig, ZulipConfig } from "./types.js";
import {
  isZulipAccountConfigured,
  listZulipAccountIds,
  resolveDefaultZulipAccountId,
  resolveZulipAccount,
  resolveZulipRuntimeAccount,
  type ResolvedZulipAccount,
} from "./zulip/accounts.js";
import { zulipApprovalAuth } from "./approval-auth.js";
import { normalizeZulipBaseUrl } from "./zulip/client.js";
import { sendMessageZulip } from "./zulip/send.js";
import { resolveZulipSessionConversation } from "./session-conversation.js";
import { zulipSecrets } from "./secret-contract.js";

const meta = {
  id: "zulip",
  label: "Zulip",
  selectionLabel: "Zulip (plugin)",
  detailLabel: "Zulip Bot",
  docsPath: "/channels/zulip",
  docsLabel: "zulip",
  blurb: "self-hosted Slack-style chat; install the plugin to enable.",
  systemImage: "bubble.left.and.bubble.right",
  order: 65,
  quickstartAllowFrom: true,
  preferSessionLookupForAnnounceTarget: true,
} as const;

function normalizeAllowEntry(entry: string): string {
  return entry
    .trim()
    .replace(/^(zulip|user):/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function formatAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    return username ? `@${username.toLowerCase()}` : "";
  }
  return trimmed.replace(/^(zulip|user):/i, "").toLowerCase();
}

export const zulipPlugin = {
  id: "zulip",
  meta: {
    ...meta,
  },
  pairing: {
    idLabel: "zulipUserId",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ id }) => {
      console.log(`[zulip] User ${id} approved for pairing`);
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "group", "thread"],
    threads: true,
    media: true,
    interactiveReplies: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.zulip"] },
  configSchema: buildChannelConfigSchema(ZulipConfigSchema),
  secrets: zulipSecrets,
  config: {
    listAccountIds: (cfg) => listZulipAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveZulipAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultZulipAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "zulip",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "zulip",
        accountId,
        clearBaseFields: ["apiKey", "email", "url", "name"] as const,
      }),
    isConfigured: (account) => isZulipAccountConfigured(account),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isZulipAccountConfigured(account),
      // tokenSource for OpenClaw status display (maps apiKey → token)
      tokenSource: account.apiKeySource,
      apiKeySource: account.apiKeySource,
      ...(account.apiKeyRef ? { apiKeyRef: `${account.apiKeyRef.source}:${account.apiKeyRef.provider}:${account.apiKeyRef.id}` } : {}),
      emailSource: account.emailSource,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZulipAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => formatAllowEntry(String(entry))).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const zulipSection = cfg.channels?.zulip as ZulipConfig | undefined;
      const useAccountPath = Boolean(zulipSection?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.zulip.accounts.${resolvedAccountId}.`
        : "channels.zulip.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("zulip"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- Zulip streams: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.zulip.groupPolicy="allowlist" + channels.zulip.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  approvalCapability: zulipApprovalAuth,
  groups: {
    resolveRequireMention: resolveZulipGroupRequireMention,
  },
  actions: zulipMessageActions,
  messaging: {
    normalizeTarget: normalizeZulipMessagingTarget,
    ...({
      resolveSessionConversation: ({
        kind,
        rawId,
      }: {
        kind: "group" | "channel";
        rawId: string;
      }) => resolveZulipSessionConversation({ kind, rawId }),
      resolveSessionTarget: ({
        kind,
        id,
        threadId,
      }: {
        kind: "group" | "channel";
        id: string;
        threadId?: string | null;
      }) => {
        const trimmedId = id.trim();
        if (!trimmedId) {
          return undefined;
        }
        if (kind === "group") {
          return `user:${trimmedId}`;
        }
        return undefined;
      },
    } as Record<string, unknown>),
    targetResolver: {
      looksLikeId: looksLikeZulipTargetId,
      hint: "<stream:NAME[:topic]|user:email|#stream[:topic]|@email>",
    },
  },
  outbound: (() => {
    const outbound: ChannelOutboundAdapter = {
      deliveryMode: "direct",
      chunker: (text, limit) => getZulipRuntime().channel.text.chunkMarkdownText(text, limit),
      chunkerMode: "markdown",
      textChunkLimit: 4000,
      resolveTarget: ({ to }) => {
        const trimmed = to?.trim();
        if (!trimmed) {
          return {
            ok: false,
            error: new Error(
              "Delivering to Zulip requires --to <stream:NAME[:topic]|user:email|#stream[:topic]|@email>",
            ),
          };
        }
        return { ok: true, to: trimmed };
      },
      sendText: async ({ cfg, to, text, accountId }) => {
        const result = await sendMessageZulip(to, text, {
          cfg,
          accountId: accountId ?? undefined,
        });
        return { channel: "zulip", ...result };
      },
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
        const result = await sendMessageZulip(to, text, {
          cfg,
          accountId: accountId ?? undefined,
          mediaUrl,
        });
        return { channel: "zulip", ...result };
      },
      sendPayload: async (ctx) => {
        const logger = getZulipRuntime().logging.getChildLogger({ module: "zulip" });
        const text = ctx.payload.text ?? "";
        const mediaUrls = ctx.payload.mediaUrls?.length
          ? ctx.payload.mediaUrls
          : ctx.payload.mediaUrl
            ? [ctx.payload.mediaUrl]
            : [];
        logger.debug?.("zulip outbound payload accepted", {
          to: ctx.to,
          accountId: ctx.accountId ?? "default",
          textLength: text.length,
          mediaCount: mediaUrls.length,
          hasInteractive: Boolean(ctx.payload.interactive?.blocks?.length),
          channelDataKeys: Object.keys(ctx.payload.channelData ?? {}),
        });
        if (mediaUrls.length > 0) {
          let lastResult;
          for (let i = 0; i < mediaUrls.length; i++) {
            lastResult = await sendMessageZulip(ctx.to, i === 0 ? text : "", {
              cfg: ctx.cfg,
              accountId: ctx.accountId ?? undefined,
              mediaUrl: mediaUrls[i],
              interactive: i === 0 ? ctx.payload.interactive : undefined,
              channelData: i === 0 ? (ctx.payload.channelData as ReplyPayload["channelData"] | undefined) : undefined,
            });
          }
          return { channel: "zulip", ...lastResult! };
        }
        const result = await sendMessageZulip(ctx.to, text, {
          cfg: ctx.cfg,
          accountId: ctx.accountId ?? undefined,
          interactive: ctx.payload.interactive,
          channelData: ctx.payload.channelData as ReplyPayload["channelData"] | undefined,
        });
        return { channel: "zulip", ...result };
      },
    };
    return outbound;
  })(),
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => {
      const zulipSnapshot = snapshot as ChannelAccountSnapshot & {
        apiKeySource?: string;
        emailSource?: string;
        baseUrl?: string | null;
      };
      return {
        configured: zulipSnapshot.configured ?? false,
        apiKeySource: zulipSnapshot.apiKeySource ?? "none",
        emailSource: zulipSnapshot.emailSource ?? "none",
        running: zulipSnapshot.running ?? false,
        connected: zulipSnapshot.connected ?? false,
        lastStartAt: zulipSnapshot.lastStartAt ?? null,
        lastStopAt: zulipSnapshot.lastStopAt ?? null,
        lastError: zulipSnapshot.lastError ?? null,
        baseUrl: zulipSnapshot.baseUrl ?? null,
        probe: zulipSnapshot.probe,
        lastProbeAt: zulipSnapshot.lastProbeAt ?? null,
      };
    },
    probeAccount: async ({ account, timeoutMs, cfg }) => {
      const runtimeAccount = await resolveZulipRuntimeAccount({ cfg, accountId: account.accountId });
      const apiKey = runtimeAccount.apiKey?.trim();
      const email = runtimeAccount.email?.trim();
      const baseUrl = runtimeAccount.baseUrl?.trim();
      if (!apiKey || !email || !baseUrl) {
        return { ok: false, error: "apiKey, email, or url missing" };
      }
      const { probeZulip } = await import("./zulip/probe.js");
      return await probeZulip(baseUrl, email, apiKey, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) =>
      ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: isZulipAccountConfigured(account),
        // Expose token/tokenSource for status display (maps to apiKey)
        tokenSource: account.apiKeySource,
        apiKeySource: account.apiKeySource,
        ...(account.apiKeyRef ? { apiKeyRef: `${account.apiKeyRef.source}:${account.apiKeyRef.provider}:${account.apiKeyRef.id}` } : {}),
        emailSource: account.emailSource,
        baseUrl: account.baseUrl,
        running: runtime?.running ?? false,
        connected: runtime?.connected ?? false,
        lastConnectedAt: runtime?.lastConnectedAt ?? null,
        lastDisconnect: runtime?.lastDisconnect ?? null,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      }) as ChannelAccountSnapshot,
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "zulip",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      const inputAny = input as Record<string, string | boolean | undefined>;
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "Zulip env vars can only be used for the default account.";
      }
      const apiKey = (inputAny.apiKey as string | undefined) ?? input.botToken ?? input.token;
      const email = inputAny.email as string | undefined;
      const baseUrl = input.httpUrl;
      if (!input.useEnv && (!apiKey || !email || !baseUrl)) {
        return "Zulip requires --api-key, --email, and --http-url (or --use-env).";
      }
      if (baseUrl && !normalizeZulipBaseUrl(baseUrl)) {
        return "Zulip --http-url must include a valid base URL.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const inputAny = input as Record<string, string | boolean | undefined>;
      const apiKey = (inputAny.apiKey as string | undefined) ?? input.botToken ?? input.token;
      const email = inputAny.email as string | undefined;
      const baseUrl = input.httpUrl?.trim();
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "zulip",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "zulip",
            })
          : namedConfig;
      const zulipSection = (next.channels?.zulip ?? {}) as ZulipConfig;
      const zulipAccounts = (zulipSection.accounts ?? {}) as Record<string, ZulipAccountConfig>;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            zulip: {
              ...zulipSection,
              enabled: true,
              ...(input.useEnv
                ? {}
                : {
                    ...(apiKey ? { apiKey } : {}),
                    ...(email ? { email } : {}),
                    ...(baseUrl ? { url: baseUrl } : {}),
                  }),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          zulip: {
            ...zulipSection,
            enabled: true,
            accounts: {
              ...zulipAccounts,
              [accountId]: {
                ...zulipAccounts[accountId],
                enabled: true,
                ...(apiKey ? { apiKey } : {}),
                ...(email ? { email } : {}),
                ...(baseUrl ? { url: baseUrl } : {}),
              },
            },
          },
        },
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = await resolveZulipRuntimeAccount({ cfg: ctx.cfg, accountId: ctx.account.accountId });
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
        apiKeySource: account.apiKeySource,
        emailSource: account.emailSource,
      } as ChannelAccountSnapshot);
      ctx.log?.info(`[${account.accountId}] starting channel`);
      const { monitorZulipProvider } = await import("./zulip/monitor.js");
      return monitorZulipProvider({
        email: account.email ?? undefined,
        baseUrl: account.baseUrl ?? undefined,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
} as ChannelPlugin<ResolvedZulipAccount> & {
  approvalCapability: typeof zulipApprovalAuth;
};
