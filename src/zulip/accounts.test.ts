import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../sdk.js";
import { resolveZulipAccount, resolveZulipRuntimeAccount } from "./accounts.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function cfg(zulip: Record<string, unknown>, secrets?: OpenClawConfig["secrets"]): OpenClawConfig {
  return { channels: { zulip }, ...(secrets ? { secrets } : {}) } as OpenClawConfig;
}

describe("Zulip apiKey SecretInput resolution", () => {
  it("preserves plain string apiKey config", async () => {
    const config = cfg({ apiKey: "plain-key", email: "bot@example.test", url: "https://zulip.example.test" });

    expect(resolveZulipAccount({ cfg: config }).apiKey).toBe("plain-key");
    await expect(resolveZulipRuntimeAccount({ cfg: config })).resolves.toMatchObject({
      apiKey: "plain-key",
      apiKeySource: "config",
    });
  });

  it("uses default env fallback only when no apiKey is configured", async () => {
    process.env.ZULIP_API_KEY = "env-key";
    const config = cfg({ email: "bot@example.test", url: "https://zulip.example.test" });

    await expect(resolveZulipRuntimeAccount({ cfg: config })).resolves.toMatchObject({
      apiKey: "env-key",
      apiKeySource: "env",
    });
  });

  it("does not use env fallback for account-specific missing apiKey", async () => {
    process.env.ZULIP_API_KEY = "env-key";
    const config = cfg({
      accounts: {
        work: { email: "bot@example.test", url: "https://zulip.example.test" },
      },
    });

    await expect(resolveZulipRuntimeAccount({ cfg: config, accountId: "work" })).resolves.toMatchObject({
      apiKey: undefined,
      apiKeySource: "none",
    });
  });

  it("resolves structured env SecretRef", async () => {
    process.env.ZULIP_SECRET_FROM_REF = "ref-key";
    const config = cfg({
      apiKey: { source: "env", provider: "default", id: "ZULIP_SECRET_FROM_REF" },
      email: "bot@example.test",
      url: "https://zulip.example.test",
    });

    await expect(resolveZulipRuntimeAccount({ cfg: config })).resolves.toMatchObject({
      apiKey: "ref-key",
      apiKeySource: "secretRef",
    });
  });

  it("fails fast for explicit bad SecretRef instead of falling back to env", async () => {
    process.env.ZULIP_API_KEY = "env-key";
    const config = cfg({
      apiKey: { source: "env", provider: "missing", id: "ZULIP_SECRET_FROM_REF" },
      email: "bot@example.test",
      url: "https://zulip.example.test",
    });

    await expect(resolveZulipRuntimeAccount({ cfg: config })).rejects.toThrow(/provider|SecretRef|configured/i);
  });
});
