import { describe, expect, it } from "vitest";
import {
  isZulipTopicAllowed,
  normalizeZulipStreamIdSelector,
  resolveZulipInboundStreamPolicy,
  zulipStreamOverridesExpandLegacySelection,
} from "./stream-policy.js";

describe("Zulip inbound stream policy", () => {
  it("preserves legacy stream and topic filters", () => {
    const enabled = resolveZulipInboundStreamPolicy({
      config: { streams: [" General "], topics: ["support"], streamTopics: { GENERAL: ["triage"] } },
      streamName: "general",
      streamId: "17",
    });
    const disabled = resolveZulipInboundStreamPolicy({
      config: { streams: ["general"] },
      streamName: "random",
      streamId: "18",
    });

    expect(enabled).toMatchObject({
      enabled: true,
      allowedTopics: ["support"],
      additionalAllowedTopics: ["triage"],
    });
    expect(isZulipTopicAllowed({ topic: "support", policy: enabled })).toBe(false);
    expect(isZulipTopicAllowed({ topic: "triage", policy: enabled })).toBe(false);
    expect(disabled.enabled).toBe(false);
  });

  it("keeps legacy streams entries as stream names, including numeric names", () => {
    expect(resolveZulipInboundStreamPolicy({
      config: { streams: ["4"] },
      streamName: "4",
      streamId: "5",
    }).enabled).toBe(true);
    expect(resolveZulipInboundStreamPolicy({
      config: { streams: ["4"] },
      streamName: "other",
      streamId: "4",
    }).enabled).toBe(false);
  });

  it("matches a decimal-looking legacy streamTopics key as a stream name", () => {
    const policy = resolveZulipInboundStreamPolicy({
      config: { streamTopics: { "4": ["allowed"] } },
      streamName: "4",
      streamId: "5",
    });

    expect(policy.additionalAllowedTopics).toEqual(["allowed"]);
    expect(isZulipTopicAllowed({ topic: "allowed", policy })).toBe(true);
  });

  it("does not canonicalize decimal-looking legacy streamTopics ids", () => {
    const policy = resolveZulipInboundStreamPolicy({
      config: { streamTopics: { "017": ["allowed"] } },
      streamName: "other",
      streamId: "17",
    });

    expect(policy.additionalAllowedTopics).toBeUndefined();
  });

  it("applies name rules and then id rules field by field", () => {
    const policy = resolveZulipInboundStreamPolicy({
      config: {
        streams: ["other"],
        streamOverrides: {
          " General ": { enabled: true, requireMention: true, allowedTopics: ["support"] },
          "017": { requireMention: false, excludedTopics: ["private"] },
        },
      },
      streamName: "GENERAL",
      streamId: "17",
    });

    expect(policy).toMatchObject({
      enabled: true,
      requireMention: false,
      allowedTopics: ["support"],
      excludedTopics: ["private"],
      matchedNameKey: " General ",
      matchedIdKey: "017",
    });
  });

  it("inherits a name disable when a higher-precedence id rule omits enabled", () => {
    const policy = resolveZulipInboundStreamPolicy({
      config: {
        streamOverrides: {
          general: { enabled: false },
          "17": { requireMention: false },
        },
      },
      streamName: "general",
      streamId: "17",
    });

    expect(policy).toMatchObject({ enabled: false, requireMention: false });
  });

  it.each(["1e3", "0x11", "+17", "-17", "17.0", " 17x "])(
    "does not coerce non-decimal selector %s into a stream id",
    (selector) => {
      expect(normalizeZulipStreamIdSelector(selector)).toBeUndefined();
      const policy = resolveZulipInboundStreamPolicy({
        config: { streamOverrides: { [selector]: { enabled: false } } },
        streamName: "different",
        streamId: "17",
      });
      expect(policy.enabled).toBe(true);
      expect(policy.matchedIdKey).toBeUndefined();
    },
  );

  it("stops applying an old name rule after a rename while the id rule remains stable", () => {
    const config = {
      streamOverrides: {
        oldName: { enabled: false },
        newName: { requireMention: false },
        "42": { allowedTopics: ["ops"] },
      },
    };

    expect(resolveZulipInboundStreamPolicy({ config, streamName: "oldName", streamId: "42" }))
      .toMatchObject({ enabled: false, allowedTopics: ["ops"] });
    expect(resolveZulipInboundStreamPolicy({ config, streamName: "newName", streamId: "42" }))
      .toMatchObject({ enabled: true, requireMention: false, allowedTopics: ["ops"] });
  });

  it("treats decimal selectors only as ids while non-decimal keys remain names", () => {
    const numericName = resolveZulipInboundStreamPolicy({
      config: { streamOverrides: { "4": { enabled: false } } },
      streamName: "4",
      streamId: "5",
    });
    const nonDecimalName = resolveZulipInboundStreamPolicy({
      config: { streamOverrides: { "1e3": { enabled: false } } },
      streamName: "1E3",
      streamId: "1000",
    });

    expect(numericName.enabled).toBe(true);
    expect(nonDecimalName.enabled).toBe(false);
  });

  it("uses normalized allow/exclude topic semantics with exclusions winning", () => {
    const policy = { allowedTopics: ["*"], excludedTopics: [" Private "] };
    expect(isZulipTopicAllowed({ topic: "support", policy })).toBe(true);
    expect(isZulipTopicAllowed({ topic: "PRIVATE", policy })).toBe(false);
    expect(isZulipTopicAllowed({ topic: "anything", policy: { excludedTopics: ["*"] } })).toBe(false);
    expect(isZulipTopicAllowed({ topic: "anything", policy: { allowedTopics: [] } })).toBe(true);
  });

  it("broadens queue selection only when enabled overrides add legacy coverage", () => {
    expect(zulipStreamOverridesExpandLegacySelection({
      streams: [" General "],
      streamOverrides: { general: { enabled: true } },
    })).toBe(false);
    expect(zulipStreamOverridesExpandLegacySelection({
      streams: ["general"],
      streamOverrides: { random: { enabled: true } },
    })).toBe(true);
    expect(zulipStreamOverridesExpandLegacySelection({
      streams: ["general"],
      streamOverrides: { "17": { enabled: true } },
    })).toBe(true);
    expect(zulipStreamOverridesExpandLegacySelection({
      streams: ["*"],
      streamOverrides: { random: { enabled: true } },
    })).toBe(false);
  });
});
