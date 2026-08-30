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
        subagent: "robot_face",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown lifecycle reaction keys", () => {
    const result = zulipChannelConfigSchema.runtime.safeParse({
      reactions: { frozenPlaceholder: true },
    });

    expect(result.success).toBe(false);
  });
});
