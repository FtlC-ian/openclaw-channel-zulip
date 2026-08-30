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
  ["🛠", { emojiName: "hammer_and_wrench", emojiCode: "1f6e0", reactionType: "unicode_emoji" }],
  ["💻", { emojiName: "computer", emojiCode: "1f4bb", reactionType: "unicode_emoji" }],
  ["🌐", { emojiName: "globe_with_meridians", emojiCode: "1f310", reactionType: "unicode_emoji" }],
  ["🛫", { emojiName: "airplane_departure", emojiCode: "1f6eb", reactionType: "unicode_emoji" }],
  ["🏗", { emojiName: "building_construction", emojiCode: "1f3d7", reactionType: "unicode_emoji" }],
  ["💁", { emojiName: "information_desk_person", emojiCode: "1f481", reactionType: "unicode_emoji" }],
  ["✅", { emojiName: "check", emojiCode: "2705", reactionType: "unicode_emoji" }],
  ["❌", { emojiName: "cross_mark", emojiCode: "274c", reactionType: "unicode_emoji" }],
  ["⏳", { emojiName: "hourglass_flowing_sand", emojiCode: "23f3", reactionType: "unicode_emoji" }],
  ["⚠", { emojiName: "warning", emojiCode: "26a0", reactionType: "unicode_emoji" }],
  ["🗜", { emojiName: "compression", emojiCode: "1f5dc", reactionType: "unicode_emoji" }],
  ["🤖", { emojiName: "robot_face", emojiCode: "1f916", reactionType: "unicode_emoji" }],
]);

export const ZULIP_STATUS_REACTION_DEFAULTS: Required<StatusReactionEmojis> = {
  queued: "eyes",
  thinking: "brain",
  tool: "hammer_and_wrench",
  coding: "computer",
  web: "globe_with_meridians",
  deploy: "airplane_departure",
  build: "building_construction",
  concierge: "information_desk_person",
  done: "check",
  error: "cross_mark",
  stallSoft: "hourglass_flowing_sand",
  stallHard: "warning",
  compacting: "compression",
};

export function resolveZulipReactionSpec(raw: string): ZulipReactionSpec {
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
  const legacyQueued = normalizeZulipEmojiName(local?.onStart);
  const legacyDone = normalizeZulipEmojiName(local?.onSuccess);
  const legacyError = normalizeZulipEmojiName(local?.onError);
  return {
    enabled: local?.enabled ?? params.globalStatusReactions?.enabled ?? true,
    emojis: {
      ...emojis,
      queued: legacyQueued || emojis.queued,
      done: legacyDone || emojis.done,
      error: legacyError || emojis.error,
    },
    timing: {
      ...params.globalStatusReactions?.timing,
      ...local?.timing,
    },
    subagent: normalizeZulipEmojiName(local?.subagent) || "robot_face",
  };
}

export function createZulipStatusReactionAdapter(params: {
  add: (reaction: ZulipReactionSpec) => Promise<void>;
  remove: (reaction: ZulipReactionSpec) => Promise<void>;
}): StatusReactionAdapter {
  return {
    setReaction: async (emoji) => params.add(resolveZulipReactionSpec(emoji)),
    removeReaction: async (emoji) => params.remove(resolveZulipReactionSpec(emoji)),
  };
}
