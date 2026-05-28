import type { DmPolicy, GroupPolicy } from "./sdk.js";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";

type BlockStreamingCoalesceConfig = {
  minChars?: number;
  maxChars?: number;
  idleMs?: number;
};

export type ZulipChatMode = "oncall" | "onmessage" | "onchar";
export type ZulipAgentReactionGuidance = "off" | "minimal" | "extensive";

export type ZulipAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** Require explicit opt-in for admin-only actions (default: false). */
  enableAdminActions?: boolean;
  /** If false, do not start this Zulip account. Default: true. */
  enabled?: boolean;
  /** Base URL for the Zulip server (e.g., https://chat.example.com). */
  url?: string;
  /** Alias for base URL (site). */
  site?: string;
  /** Alias for base URL (realm). */
  realm?: string;
  /** Zulip bot email address. */
  email?: string;
  /** Zulip API key for the bot. */
  apiKey?: SecretInput;
  /** Default topic for messages without a topic. Empty string = Zulip's "general chat". */
  defaultTopic?: string;
  /** Restrict monitored streams ("*" = all streams). */
  streams?: string[];
  /** Restrict monitored stream topics globally ("*" or empty = all topics). Case-insensitive after trimming. */
  topics?: string[];
  /** Restrict monitored topics per stream name or stream id. Case-insensitive after trimming. */
  streamTopics?: Record<string, string[]>;
  /**
   * Controls when channel messages trigger replies.
   * - "oncall": only respond when mentioned
   * - "onmessage": respond to every channel message
   * - "onchar": respond when a trigger character prefixes the message
   */
  chatmode?: ZulipChatMode;
  /** Prefix characters that trigger onchar mode (default: [">", "!"]). */
  oncharPrefixes?: string[];
  /** Require @mention to respond in channels. Default: true. */
  requireMention?: boolean;
  /** Direct message policy (pairing/allowlist/open/disabled). */
  dmPolicy?: DmPolicy;
  /** Allowlist for direct messages (user ids or @usernames). */
  allowFrom?: Array<string | number>;
  /** Allowlist for group messages (user ids or @usernames). */
  groupAllowFrom?: Array<string | number>;
  /** Group message policy (allowlist/open/disabled). */
  groupPolicy?: GroupPolicy;
  /** Inbound media max size (MB). Default: 5. */
  mediaMaxMb?: number;
  /** Optional reaction hooks. Defaults no longer add start/success reactions. */
  reactions?: {
    enabled?: boolean;
    clearOnFinish?: boolean;
    onStart?: string;
    onSuccess?: string;
    onError?: string;
  };
  /** Model prompt guidance for agent-controlled reactions. Does not enable automatic status reactions. Default: "minimal". */
  agentReactionGuidance?: ZulipAgentReactionGuidance;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
};

export type ZulipConfig = {
  /** Optional per-account Zulip configuration (multi-account). */
  accounts?: Record<string, ZulipAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & ZulipAccountConfig;
