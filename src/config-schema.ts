import { z } from "zod";
import { buildOptionalSecretInputSchema } from "openclaw/plugin-sdk/secret-input";

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
    code: z.ZodIssueCode.custom,
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
        onStart: z.string().optional(),
        onSuccess: z.string().optional(),
        onError: z.string().optional(),
      })
      .optional(),
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

export const ZulipConfigSchema = ZulipAccountSchemaBase.extend({
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
