import { describe, expect, it } from "vitest";
import { ZulipConfigSchema } from "./config-schema.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

describe("Zulip secret contract", () => {
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
