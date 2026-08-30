import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { zulipChannelConfigSchema } from "./config-schema.js";

describe("Zulip lifecycle reaction config", () => {
  it("accepts lifecycle emoji, timing, and subagent overrides", () => {
    const result = zulipChannelConfigSchema.runtime.safeParse({
      reactions: {
        enabled: true,
        clearOnFinish: true,
        emojis: { thinking: "brain", coding: "computer" },
        timing: { debounceMs: 25, stallSoftMs: 10_000, stallHardMs: 30_000 },
        subagent: "🤖",
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts named emoji, built-in Unicode mappings, and explicit suppression", () => {
    const result = zulipChannelConfigSchema.runtime.safeParse({
      reactions: {
        onStart: "",
        onSuccess: "✅",
        onError: ":warning:",
        emojis: { thinking: "🧠", done: "" },
        subagent: "🤖",
      },
    });

    expect(result.success).toBe(true);
  });

  it.each(["+1", "-1", ":+1:", ":-1:"])(
    "accepts leading-sign named emoji %s",
    (emoji) => {
      expect(
        zulipChannelConfigSchema.runtime.safeParse({
          reactions: { onStart: emoji, emojis: { thinking: emoji }, subagent: emoji },
        }).success,
      ).toBe(true);
    },
  );

  it.each(["+", "-", ":+:", ":-:", ":+1", "+1:", "white space"])(
    "rejects invalid named emoji %s",
    (emoji) => {
      expect(
        zulipChannelConfigSchema.runtime.safeParse({
          reactions: { onStart: emoji },
        }).success,
      ).toBe(false);
    },
  );

  it("keeps manifest named-emoji validation aligned with runtime validation", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      channelConfigs: {
        zulip: {
          schema: {
            $defs: {
              zulipReactionEmoji: {
                anyOf: Array<{ pattern?: string; enum?: string[] }>;
              };
            };
          };
        };
      };
    };
    const variants = manifest.channelConfigs.zulip.schema.$defs.zulipReactionEmoji.anyOf;
    const accepts = (value: string) =>
      variants.some(
        (variant) =>
          variant.enum?.includes(value) ||
          (variant.pattern !== undefined && new RegExp(variant.pattern).test(value)),
      );

    for (const value of ["+1", "-1", ":+1:", ":-1:"]) {
      expect(accepts(value)).toBe(true);
    }
    for (const value of ["+", "-", ":+:", ":-:", ":+1", "+1:", "white space", "🦄"]) {
      expect(accepts(value)).toBe(false);
    }
  });

  it("rejects arbitrary Unicode reaction values", () => {
    expect(
      zulipChannelConfigSchema.runtime.safeParse({
        reactions: { emojis: { thinking: "🦄" } },
      }).success,
    ).toBe(false);
    expect(
      zulipChannelConfigSchema.runtime.safeParse({
        reactions: { subagent: "🦄" },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown lifecycle reaction keys", () => {
    const result = zulipChannelConfigSchema.runtime.safeParse({
      reactions: { frozenPlaceholder: true },
    });

    expect(result.success).toBe(false);
  });
});
