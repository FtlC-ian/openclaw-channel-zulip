import { describe, expect, it, vi } from "vitest";
import {
  createZulipStatusReactionAdapter,
  isSupportedZulipReactionValue,
  resolveZulipReactionSpec,
  resolveZulipStatusReactionConfig,
  ZULIP_STATUS_REACTION_DEFAULTS,
} from "./status-reactions.js";

describe("Zulip status reaction configuration", () => {
  it("merges global and account overrides while preserving legacy aliases", () => {
    const result = resolveZulipStatusReactionConfig({
      globalStatusReactions: {
        enabled: false,
        emojis: { thinking: "thinking" },
        timing: { stallSoftMs: 20_000 },
      },
      accountConfig: {
        reactions: {
          enabled: true,
          onStart: "queued_custom",
          onSuccess: "done_custom",
          onError: "error_custom",
          emojis: { tool: "tool_custom" },
          timing: { debounceMs: 25 },
          subagent: ":robot_face:",
        },
      },
    });

    expect(result).toMatchObject({
      enabled: true,
      subagent: "robot_face",
      emojis: {
        queued: "queued_custom",
        thinking: "thinking",
        tool: "tool_custom",
        done: "done_custom",
        error: "error_custom",
      },
      timing: { stallSoftMs: 20_000, debounceMs: 25 },
    });
  });

  it("maps Unicode lifecycle emoji to complete Zulip reaction parameters", async () => {
    expect(resolveZulipReactionSpec("⚠️")).toEqual({
      emojiName: "warning",
      emojiCode: "26a0",
      reactionType: "unicode_emoji",
    });
    const add = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const adapter = createZulipStatusReactionAdapter({ add, remove });

    await adapter.setReaction("🤖");
    await adapter.removeReaction?.("🤖");

    const expected = {
      emojiName: "robot_face",
      emojiCode: "1f916",
      reactionType: "unicode_emoji",
    };
    expect(add).toHaveBeenCalledWith(expected);
    expect(remove).toHaveBeenCalledWith(expected);
  });

  it("uses fully specified Unicode reactions for every built-in lifecycle default", () => {
    for (const emoji of Object.values(ZULIP_STATUS_REACTION_DEFAULTS)) {
      expect(resolveZulipReactionSpec(emoji)).toMatchObject({
        emojiCode: expect.any(String),
        reactionType: "unicode_emoji",
      });
    }

    const result = resolveZulipStatusReactionConfig({ accountConfig: {} });
    expect(resolveZulipReactionSpec(result.subagent)).toMatchObject({
      emojiName: "robot_face",
      emojiCode: "1f916",
      reactionType: "unicode_emoji",
    });
  });

  it("preserves explicit empty legacy and subagent overrides", () => {
    const result = resolveZulipStatusReactionConfig({
      accountConfig: {
        reactions: {
          onStart: "",
          onSuccess: "",
          onError: "",
          subagent: "",
        },
      },
    });

    expect(result.emojis.queued).toBe("");
    expect(result.emojis.done).toBe("");
    expect(result.emojis.error).toBe("");
    expect(result.subagent).toBe("");
  });

  it("rejects arbitrary Unicode and treats an empty reaction as suppressed", async () => {
    expect(() => resolveZulipReactionSpec("🦄")).toThrow(/Unsupported Zulip reaction/);
    const add = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const adapter = createZulipStatusReactionAdapter({ add, remove });

    await adapter.setReaction("");
    await adapter.removeReaction?.("");

    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(["+1", "-1", ":+1:", ":-1:"])(
    "accepts leading-sign Zulip emoji name %s",
    (emoji) => {
      expect(isSupportedZulipReactionValue(emoji)).toBe(true);
      expect(resolveZulipReactionSpec(emoji)).toEqual({
        emojiName: emoji.replaceAll(":", ""),
      });
    },
  );

  it.each(["+", "-", ":+:", ":-:", ":+1", "+1:", "white space", "🦄"])(
    "rejects invalid Zulip emoji value %s",
    (emoji) => {
      expect(isSupportedZulipReactionValue(emoji)).toBe(false);
      expect(() => resolveZulipReactionSpec(emoji)).toThrow(/Unsupported Zulip reaction/);
    },
  );
});
