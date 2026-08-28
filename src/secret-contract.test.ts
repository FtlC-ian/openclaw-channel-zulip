import { describe, expect, it } from "vitest";
import { ZulipConfigSchema } from "./config-schema.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

describe("Zulip secret contract", () => {
  it.each([
    { input: { dmPolicy: "open", allowFrom: [] }, path: ["allowFrom"] },
    {
      input: { accounts: { work: { dmPolicy: "open", allowFrom: [] } } },
      path: ["accounts", "work", "allowFrom"],
    },
  ])("rejects open DM policy without a wildcard at $path", ({ input, path }) => {
    const result = ZulipConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({ code: "custom", path }));
    }
  });

  it("schema accepts plain strings and structured SecretRefs", () => {
    expect(ZulipConfigSchema.safeParse({ apiKey: "plain" }).success).toBe(true);
    expect(
      ZulipConfigSchema.safeParse({
        accounts: {
          default: { apiKey: { source: "env", provider: "default", id: "ZULIP_API_KEY" } },
        },
      }).success,
    ).toBe(true);
  });

  it("schema validates model-controlled reaction guidance levels", () => {
    expect(ZulipConfigSchema.safeParse({ agentReactionGuidance: "minimal" }).success).toBe(true);
    expect(
      ZulipConfigSchema.safeParse({
        accounts: {
          work: { agentReactionGuidance: "extensive" },
        },
      }).success,
    ).toBe(true);
    expect(ZulipConfigSchema.safeParse({ agentReactionGuidance: "ack" }).success).toBe(false);
  });

  it("registers apiKey targets", () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.pathPattern)).toEqual([
      "channels.zulip.accounts.*.apiKey",
      "channels.zulip.apiKey",
    ]);
  });

  it("collects runtime assignments for configured SecretRefs", () => {
    const assignments: unknown[] = [];
    collectRuntimeConfigAssignments({
      config: {
        channels: {
          zulip: {
            apiKey: { source: "env", provider: "default", id: "ZULIP_API_KEY" },
            email: "bot@example.test",
            url: "https://zulip.example.test",
          },
        },
      } as never,
      defaults: undefined,
      context: {
        sourceConfig: {} as never,
        env: {},
        cache: {} as never,
        warnings: [],
        warningKeys: new Set(),
        assignments: assignments as never[],
      },
    });

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ path: "channels.zulip.apiKey", expected: "string" });
  });
});
