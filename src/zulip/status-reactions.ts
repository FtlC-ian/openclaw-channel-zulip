import type {
  StatusReactionAdapter,
  StatusReactionEmojis,
  StatusReactionTiming,
} from "openclaw/plugin-sdk/channel-feedback";
import type { ZulipAccountConfig } from "../types.js";
import { normalizeZulipEmojiName } from "./uploads.js";

type ZulipReactionSpec = {
  emojiName: string;
  emojiCode?: string;
  reactionType?: string;
};

const unicodeStatusReactions = new Map<string, ZulipReactionSpec>([
  ["👀", { emojiName: "eyes", emojiCode: "1f440", reactionType: "unicode_emoji" }],
  ["🧠", { emojiName: "brain", emojiCode: "1f9e0", reactionType: "unicode_emoji" }],
  ["🛠", { emojiName: "working_on_it", emojiCode: "1f6e0", reactionType: "unicode_emoji" }],
  ["💻", { emojiName: "computer", emojiCode: "1f4bb", reactionType: "unicode_emoji" }],
  ["🌐", { emojiName: "www", emojiCode: "1f310", reactionType: "unicode_emoji" }],
  ["🛫", { emojiName: "airplane_departure", emojiCode: "1f6eb", reactionType: "unicode_emoji" }],
  ["🏗", { emojiName: "construction", emojiCode: "1f3d7", reactionType: "unicode_emoji" }],
  ["💁", { emojiName: "information_desk_person", emojiCode: "1f481", reactionType: "unicode_emoji" }],
  ["✅", { emojiName: "check", emojiCode: "2705", reactionType: "unicode_emoji" }],
  ["❌", { emojiName: "cross_mark", emojiCode: "274c", reactionType: "unicode_emoji" }],
  ["⏳", { emojiName: "time_ticking", emojiCode: "23f3", reactionType: "unicode_emoji" }],
  ["⚠", { emojiName: "warning", emojiCode: "26a0", reactionType: "unicode_emoji" }],
  ["🗜", { emojiName: "compression", emojiCode: "1f5dc", reactionType: "unicode_emoji" }],
  ["🤖", { emojiName: "robot", emojiCode: "1f916", reactionType: "unicode_emoji" }],
]);
const namedZulipEmojiPattern =
  /^:?(?:[A-Za-z0-9][A-Za-z0-9_+-]*|[+-][A-Za-z0-9][A-Za-z0-9_+-]*):?$/;

export function isSupportedZulipReactionValue(raw: string): boolean {
  if (raw === "") {
    return true;
  }
  const normalizedUnicode = raw.replaceAll("\ufe0f", "");
  if (unicodeStatusReactions.has(normalizedUnicode)) {
    return true;
  }
  if (!namedZulipEmojiPattern.test(raw)) {
    return false;
  }
  return !(raw.startsWith(":") !== raw.endsWith(":"));
}

export const ZULIP_STATUS_REACTION_DEFAULTS: Required<StatusReactionEmojis> = {
  queued: "👀",
  thinking: "🧠",
  tool: "🛠️",
  coding: "💻",
  web: "🌐",
  deploy: "🛫",
  build: "🏗️",
  concierge: "💁",
  done: "✅",
  error: "❌",
  stallSoft: "⏳",
  stallHard: "⚠️",
  compacting: "🗜️",
};

export function resolveZulipReactionSpec(raw: string): ZulipReactionSpec {
  if (!isSupportedZulipReactionValue(raw)) {
    throw new Error(
      `Unsupported Zulip reaction ${JSON.stringify(raw)}; use a named Zulip emoji or a documented built-in Unicode value.`,
    );
  }
  const normalizedUnicode = raw.replaceAll("\ufe0f", "");
  return (
    unicodeStatusReactions.get(normalizedUnicode) ?? {
      emojiName: normalizeZulipEmojiName(raw),
    }
  );
}

export function resolveZulipStatusReactionConfig(params: {
  accountConfig: ZulipAccountConfig;
  globalStatusReactions?: {
    enabled?: boolean;
    emojis?: StatusReactionEmojis;
    timing?: StatusReactionTiming;
  };
}): {
  enabled: boolean;
  emojis: Required<StatusReactionEmojis>;
  timing?: StatusReactionTiming;
  subagent: string;
} {
  const local = params.accountConfig.reactions;
  const emojis = {
    ...ZULIP_STATUS_REACTION_DEFAULTS,
    ...params.globalStatusReactions?.emojis,
    ...local?.emojis,
  };
  const resolveLegacy = (value: string | undefined, fallback: string) =>
    value === undefined ? fallback : normalizeZulipEmojiName(value);
  return {
    enabled: local?.enabled ?? params.globalStatusReactions?.enabled ?? true,
    emojis: {
      ...emojis,
      queued: resolveLegacy(local?.onStart, emojis.queued),
      done: resolveLegacy(local?.onSuccess, emojis.done),
      error: resolveLegacy(local?.onError, emojis.error),
    },
    timing: {
      ...params.globalStatusReactions?.timing,
      ...local?.timing,
    },
    subagent: local?.subagent === undefined ? "🤖" : normalizeZulipEmojiName(local.subagent),
  };
}

export function createZulipStatusReactionAdapter(params: {
  add: (reaction: ZulipReactionSpec) => Promise<void>;
  remove: (reaction: ZulipReactionSpec) => Promise<void>;
}): StatusReactionAdapter {
  return {
    setReaction: async (emoji) => {
      const reaction = resolveZulipReactionSpec(emoji);
      if (reaction.emojiName) {
        await params.add(reaction);
      }
    },
    removeReaction: async (emoji) => {
      const reaction = resolveZulipReactionSpec(emoji);
      if (reaction.emojiName) {
        await params.remove(reaction);
      }
    },
  };
}
