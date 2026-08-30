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
          subagent: ":custom_child:",
        },
      },
    });

    expect(result).toMatchObject({
      enabled: true,
      subagent: "custom_child",
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
      emojiName: "robot",
      emojiCode: "1f916",
      reactionType: "unicode_emoji",
    };
    expect(add).toHaveBeenCalledWith(expected);
    expect(remove).toHaveBeenCalledWith(expected);
  });

  it("uses Zulip's canonical name and complete metadata for every built-in Unicode value", () => {
    const expected = new Map([
      ["👀", ["eyes", "1f440"]],
      ["🧠", ["brain", "1f9e0"]],
      ["🛠️", ["working_on_it", "1f6e0"]],
      ["💻", ["computer", "1f4bb"]],
      ["🌐", ["www", "1f310"]],
      ["🛫", ["airplane_departure", "1f6eb"]],
      ["🏗️", ["construction", "1f3d7"]],
      ["💁", ["information_desk_person", "1f481"]],
      ["✅", ["check", "2705"]],
      ["❌", ["cross_mark", "274c"]],
      ["⏳", ["time_ticking", "23f3"]],
      ["⚠️", ["warning", "26a0"]],
      ["🗜️", ["compression", "1f5dc"]],
      ["🤖", ["robot", "1f916"]],
    ]);

    for (const [emoji, [emojiName, emojiCode]] of expected) {
      expect(resolveZulipReactionSpec(emoji)).toEqual({
        emojiName,
        emojiCode,
        reactionType: "unicode_emoji",
      });
    }

    expect(new Set(Object.values(ZULIP_STATUS_REACTION_DEFAULTS))).toEqual(
      new Set(Array.from(expected.keys()).filter((emoji) => emoji !== "🤖")),
    );

    const result = resolveZulipStatusReactionConfig({ accountConfig: {} });
    expect(resolveZulipReactionSpec(result.subagent)).toEqual({
      emojiName: "robot",
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
