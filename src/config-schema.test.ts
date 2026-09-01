import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { zulipChannelConfigSchema } from "./config-schema.js";

describe("Zulip lifecycle reaction config", () => {
  it("accepts the conservative handled-read account opt-in and exposes it in the manifest", () => {
    expect(zulipChannelConfigSchema.runtime.safeParse({ markHandledRead: true }).success).toBe(true);
    expect(zulipChannelConfigSchema.runtime.safeParse({ markHandledRead: false }).success).toBe(true);
    expect(zulipChannelConfigSchema.runtime.safeParse({}).success).toBe(true);

    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      channelConfigs: {
        zulip: {
          schema: {
            $defs: { zulipAccount: { properties: Record<string, unknown> } };
            properties: Record<string, unknown>;
          };
          uiHints: Record<string, unknown>;
        };
      };
    };
    const config = manifest.channelConfigs.zulip;
    expect(config.schema.properties).toHaveProperty("markHandledRead");
    expect(config.schema.$defs.zulipAccount.properties).toHaveProperty("markHandledRead");
    expect(config.uiHints).toHaveProperty("markHandledRead");
  });

  it("accepts strict per-stream inbound policy fields", () => {
    const result = zulipChannelConfigSchema.runtime.safeParse({
      streamOverrides: {
        General: {
          enabled: false,
          requireMention: true,
          allowedTopics: ["support"],
          excludedTopics: ["private"],
        },
        "42": { enabled: true },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown per-stream inbound policy fields", () => {
    expect(
      zulipChannelConfigSchema.runtime.safeParse({
        streamOverrides: { general: { outboundEnabled: false } },
      }).success,
    ).toBe(false);
  });

  it.each([
    { " ": { enabled: true } },
    { General: { enabled: true }, " general ": { enabled: false } },
    { "17": { enabled: true }, "017": { enabled: false } },
  ])("rejects empty or canonically duplicate stream selectors", (streamOverrides) => {
    expect(zulipChannelConfigSchema.runtime.safeParse({ streamOverrides }).success).toBe(false);
  });

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

  it("keeps manifest stream override fields aligned with runtime validation", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      channelConfigs: {
        zulip: {
          schema: {
            $defs: { zulipAccount: { properties: Record<string, unknown> }; zulipStreamRule: { properties: Record<string, unknown> } };
            properties: Record<string, unknown>;
          };
          uiHints: Record<string, unknown>;
        };
      };
    };
    const channelConfig = manifest.channelConfigs.zulip;
    expect(Object.keys(channelConfig.schema.$defs.zulipStreamRule.properties).sort()).toEqual([
      "allowedTopics",
      "enabled",
      "excludedTopics",
      "requireMention",
    ]);
    expect(channelConfig.schema.properties).toHaveProperty("streamOverrides");
    expect(channelConfig.schema.$defs.zulipAccount.properties).toHaveProperty("streamOverrides");
    expect(channelConfig.uiHints).toHaveProperty("streamOverrides");
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
