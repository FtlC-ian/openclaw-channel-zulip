import { z } from "zod";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { buildOptionalSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { isSupportedZulipReactionValue } from "./zulip/status-reactions.js";
import {
  normalizeZulipStreamIdSelector,
  normalizeZulipStreamName,
} from "./zulip/stream-policy.js";

// Inlined from openclaw/plugin-sdk to avoid module resolution issues
// when installed via npm to ~/.openclaw/extensions/. These are stable
// definitions that rarely change. Can revert to SDK imports once the
// new plugin-sdk ships with proper external resolution support.

const GroupPolicySchema = z.enum(["open", "disabled", "allowlist"]);

const DmPolicySchema = z.enum(["pairing", "allowlist", "open", "disabled"]);

const BlockStreamingCoalesceSchema = z
  .object({
    minChars: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    idleMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const MarkdownTableModeSchema = z.enum(["native", "codeblock", "disabled"]);
const AgentReactionGuidanceSchema = z.enum(["off", "minimal", "extensive"]);
const ZulipReactionEmojiSchema = z.string().refine(isSupportedZulipReactionValue, {
  message: "Use a named Zulip emoji, an explicitly supported built-in Unicode value, or empty string",
});
const StatusReactionEmojisSchema = z
  .object({
    queued: ZulipReactionEmojiSchema.optional(),
    thinking: ZulipReactionEmojiSchema.optional(),
    tool: ZulipReactionEmojiSchema.optional(),
    coding: ZulipReactionEmojiSchema.optional(),
    web: ZulipReactionEmojiSchema.optional(),
    deploy: ZulipReactionEmojiSchema.optional(),
    build: ZulipReactionEmojiSchema.optional(),
    concierge: ZulipReactionEmojiSchema.optional(),
    done: ZulipReactionEmojiSchema.optional(),
    error: ZulipReactionEmojiSchema.optional(),
    stallSoft: ZulipReactionEmojiSchema.optional(),
    stallHard: ZulipReactionEmojiSchema.optional(),
    compacting: ZulipReactionEmojiSchema.optional(),
  })
  .strict();
const StatusReactionTimingSchema = z
  .object({
    debounceMs: z.number().int().nonnegative().optional(),
    stallSoftMs: z.number().int().nonnegative().optional(),
    stallHardMs: z.number().int().nonnegative().optional(),
    doneHoldMs: z.number().int().nonnegative().optional(),
    errorHoldMs: z.number().int().nonnegative().optional(),
  })
  .strict();
const ZulipStreamRuleSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    allowedTopics: z.array(z.string()).optional(),
    excludedTopics: z.array(z.string()).optional(),
  })
  .strict();
const ZulipStreamOverridesSchema = z
  .record(z.string(), ZulipStreamRuleSchema)
  .superRefine((overrides, ctx) => {
    const selectors = new Map<string, string>();
    for (const key of Object.keys(overrides)) {
      const normalizedId = normalizeZulipStreamIdSelector(key);
      const normalizedName = normalizeZulipStreamName(key);
      if (!normalizedName) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Stream override selectors cannot be empty",
        });
        continue;
      }
      const selector = normalizedId !== undefined
        ? `id:${normalizedId}`
        : `name:${normalizedName}`;
      const existing = selectors.get(selector);
      if (existing !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Stream override selector duplicates ${JSON.stringify(existing)} after normalization`,
        });
      } else {
        selectors.set(selector, key);
      }
    }
  });

const ThinkingPlaceholderSchema = z
  .object({
    enabled: z.boolean().optional(),
    text: z.string().min(1).optional(),
    errorText: z.string().min(1).optional(),
  })
  .strict();

const OptionalSecretInputSchema = buildOptionalSecretInputSchema();

const MarkdownConfigSchema = z
  .object({
    tables: MarkdownTableModeSchema.optional(),
  })
  .strict()
  .optional();

const normalizeAllowFrom = (
  allowFrom?: Array<string | number>,
): string[] => (allowFrom ?? []).map((v) => String(v).toLowerCase());

const requireOpenAllowFrom = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}) => {
  if (params.policy !== "open") {
    return;
  }
  const allow = normalizeAllowFrom(params.allowFrom);
  if (allow.includes("*")) {
    return;
  }
  params.ctx.addIssue({
    code: "custom",
    path: params.path,
    message: params.message,
  });
};

const ZulipAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema.optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    url: z.string().optional(),
    site: z.string().optional(),
    realm: z.string().optional(),
    email: z.string().optional(),
    apiKey: OptionalSecretInputSchema,
    streams: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
    streamTopics: z.record(z.string(), z.array(z.string())).optional(),
    streamOverrides: ZulipStreamOverridesSchema.optional(),
    defaultTopic: z.string().optional(),
    chatmode: z.enum(["oncall", "onmessage", "onchar"]).optional(),
    oncharPrefixes: z.array(z.string()).optional(),
    requireMention: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    reactions: z
      .object({
        enabled: z.boolean().optional(),
        clearOnFinish: z.boolean().optional(),
        onStart: ZulipReactionEmojiSchema.optional(),
        onSuccess: ZulipReactionEmojiSchema.optional(),
        onError: ZulipReactionEmojiSchema.optional(),
        emojis: StatusReactionEmojisSchema.optional(),
        timing: StatusReactionTimingSchema.optional(),
        subagent: ZulipReactionEmojiSchema.optional(),
      })
      .strict()
      .optional(),
    thinkingPlaceholder: ThinkingPlaceholderSchema.optional(),
    agentReactionGuidance: AgentReactionGuidanceSchema.optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    responsePrefix: z.string().optional(),
    enableAdminActions: z.boolean().optional(),
  })
  .strict();

const ZulipAccountSchema = ZulipAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.zulip.dmPolicy="open" requires channels.zulip.allowFrom to include "*"',
  });
});

const ZulipConfigSchema = ZulipAccountSchemaBase.extend({
  accounts: z.record(z.string(), ZulipAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.zulip.dmPolicy="open" requires channels.zulip.allowFrom to include "*"',
  });
});

// Cross the SDK boundary as JSON Schema; retain this plugin's Zod refinements at runtime.
export const zulipChannelConfigSchema: ReturnType<typeof buildJsonChannelConfigSchema> = buildJsonChannelConfigSchema(
  ZulipConfigSchema.toJSONSchema({ target: "draft-07", unrepresentable: "any" }),
  {
    runtime: {
      safeParse(value) {
        const result = ZulipConfigSchema.safeParse(value);
        return result.success ? result : {
          success: false,
          issues: result.error.issues.map((issue) => ({
            ...issue,
            path: issue.path.filter((part): part is string | number => typeof part !== "symbol"),
          })),
        };
      },
    },
  },
);
