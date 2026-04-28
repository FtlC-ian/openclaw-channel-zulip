import type { OpenClawConfig } from "../sdk.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../sdk.js";
import type { ZulipAccountConfig, ZulipChatMode, ZulipConfig } from "../types.js";
import { normalizeZulipBaseUrl } from "./client.js";
import {
  coerceSecretRef,
  normalizeSecretInputString,
  resolveConfiguredSecretInputString,
  resolveSecretInputString,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input-runtime";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";

export type ZulipTokenSource = "env" | "config" | "secretRef" | "none";
export type ZulipEmailSource = "env" | "config" | "none";
export type ZulipBaseUrlSource = "env" | "config" | "none";

type ApiKeyResolution = {
  apiKey?: string;
  apiKeySource: ZulipTokenSource;
  apiKeyRef?: SecretRef;
};

export function isZulipAccountConfigured(account: Pick<ResolvedZulipAccount, "apiKeySource" | "email" | "baseUrl">): boolean {
  return account.apiKeySource !== "none" && Boolean(account.email && account.baseUrl);
}

export type ResolvedZulipAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  apiKey?: string;
  email?: string;
  baseUrl?: string;
  apiKeySource: ZulipTokenSource;
  apiKeyRef?: SecretRef;
  emailSource: ZulipEmailSource;
  baseUrlSource: ZulipBaseUrlSource;
  // Aliases for OpenClaw status display (maps apiKey → token)
  token?: string;
  tokenSource: ZulipTokenSource;
  tokenRef?: SecretRef;
  config: ZulipAccountConfig;
  enableAdminActions?: boolean;
  chatmode?: ZulipChatMode;
  oncharPrefixes?: string[];
  requireMention?: boolean;
  textChunkLimit?: number;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: ZulipAccountConfig["blockStreamingCoalesce"];
  streams?: string[];
};

function resolveZulipSection(cfg: OpenClawConfig): ZulipConfig | undefined {
  return cfg.channels?.zulip as ZulipConfig | undefined;
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = resolveZulipSection(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listZulipAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultZulipAccountId(cfg: OpenClawConfig): string {
  const zulipSection = resolveZulipSection(cfg);
  const configuredDefault = zulipSection?.defaultAccount?.trim();
  if (configuredDefault) {
    const normalized = normalizeAccountId(configuredDefault);
    const ids = listZulipAccountIds(cfg);
    if (ids.includes(normalized)) {
      return normalized;
    }
  }
  const ids = listZulipAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ZulipAccountConfig | undefined {
  const accounts = resolveZulipSection(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as ZulipAccountConfig | undefined;
}

function resolveZulipRequireMention(config: ZulipAccountConfig): boolean | undefined {
  if (config.chatmode === "oncall") {
    return true;
  }
  if (config.chatmode === "onmessage") {
    return false;
  }
  if (config.chatmode === "onchar") {
    return true;
  }
  return config.requireMention;
}

function formatSecretRefLabel(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

function resolveApiKeyForInspect(params: {
  cfg: OpenClawConfig;
  value: SecretInput | undefined;
  path: string;
  allowEnvFallback: boolean;
  env: NodeJS.ProcessEnv;
}): ApiKeyResolution {
  const resolved = resolveSecretInputString({
    value: params.value,
    path: params.path,
    defaults: params.cfg.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    return { apiKey: resolved.value, apiKeySource: "config" };
  }
  if (resolved.status === "configured_unavailable") {
    return { apiKeySource: "secretRef", apiKeyRef: resolved.ref };
  }
  const envApiKey = params.allowEnvFallback ? params.env.ZULIP_API_KEY?.trim() : undefined;
  return { apiKey: envApiKey, apiKeySource: envApiKey ? "env" : "none" };
}

async function resolveApiKeyForRuntime(params: {
  cfg: OpenClawConfig;
  value: SecretInput | undefined;
  path: string;
  allowEnvFallback: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<ApiKeyResolution> {
  const envApiKey = params.allowEnvFallback ? params.env.ZULIP_API_KEY?.trim() : undefined;
  if (params.value !== undefined) {
    const ref = coerceSecretRef(params.value, params.cfg.secrets?.defaults);
    if (!ref) {
      const value = normalizeSecretInputString(params.value);
      return value
        ? { apiKey: value, apiKeySource: "config" }
        : { apiKey: envApiKey, apiKeySource: envApiKey ? "env" : "none" };
    }
    const resolved = await resolveConfiguredSecretInputString({
      config: params.cfg,
      env: params.env,
      value: params.value,
      path: params.path,
      unresolvedReasonStyle: "detailed",
    });
    if (!resolved.value) {
      throw new Error(resolved.unresolvedRefReason ?? `${params.path}: unresolved SecretRef "${formatSecretRefLabel(ref)}".`);
    }
    return { apiKey: resolved.value, apiKeySource: "secretRef", apiKeyRef: ref };
  }
  return { apiKey: envApiKey, apiKeySource: envApiKey ? "env" : "none" };
}

function resolveMergedConfig(params: { cfg: OpenClawConfig; accountId?: string | null }) {
  const accountId = normalizeAccountId(params.accountId);
  const zulipSection = resolveZulipSection(params.cfg);
  const baseEnabled = zulipSection?.enabled !== false;
  const { accounts: _ignored, ...baseConfig } = (zulipSection ?? {}) as ZulipConfig;
  const accountConfig = resolveAccountConfig(params.cfg, accountId) ?? {};
  const merged = { ...baseConfig, ...accountConfig };
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const hasAccountApiKey = Object.prototype.hasOwnProperty.call(accountConfig, "apiKey");
  const hasBaseApiKey = Object.prototype.hasOwnProperty.call(baseConfig, "apiKey");
  const apiKeyPath = hasAccountApiKey
    ? `channels.zulip.accounts.${accountId}.apiKey`
    : "channels.zulip.apiKey";
  const rawApiKey = merged.apiKey;
  const hasConfiguredApiKey = typeof rawApiKey === "string" ? rawApiKey.trim().length > 0 : rawApiKey !== undefined;
  return { accountId, baseConfig, accountConfig, merged, enabled, apiKeyPath, hasConfiguredApiKey };
}

function buildResolvedAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  apiKeyResolution: ApiKeyResolution;
  env?: NodeJS.ProcessEnv;
}): ResolvedZulipAccount {
  const { accountId, baseConfig, accountConfig, merged, enabled } = resolveMergedConfig(params);
  const env = params.env ?? process.env;
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envEmail = allowEnv ? env.ZULIP_EMAIL?.trim() : undefined;
  const envUrl = allowEnv ? env.ZULIP_URL?.trim() : undefined;
  const envSite = allowEnv ? env.ZULIP_SITE?.trim() : undefined;
  const envRealm = allowEnv ? env.ZULIP_REALM?.trim() : undefined;
  const configEmail = merged.email?.trim();
  const configUrl =
    accountConfig.url ??
    accountConfig.site ??
    accountConfig.realm ??
    baseConfig.url ??
    baseConfig.site ??
    baseConfig.realm;
  const configUrlTrimmed = configUrl?.trim();
  const email = configEmail || envEmail;
  const baseUrl = normalizeZulipBaseUrl(configUrlTrimmed || envUrl || envSite || envRealm);
  const requireMention = resolveZulipRequireMention(merged);
  const emailSource: ZulipEmailSource = configEmail ? "config" : envEmail ? "env" : "none";
  const baseUrlSource: ZulipBaseUrlSource = configUrlTrimmed
    ? "config"
    : envUrl || envSite || envRealm
      ? "env"
      : "none";

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    apiKey: params.apiKeyResolution.apiKey,
    email,
    baseUrl,
    apiKeySource: params.apiKeyResolution.apiKeySource,
    apiKeyRef: params.apiKeyResolution.apiKeyRef,
    emailSource,
    baseUrlSource,
    // Expose source/ref aliases for OpenClaw status display without leaking the secret value.
    tokenSource: params.apiKeyResolution.apiKeySource,
    tokenRef: params.apiKeyResolution.apiKeyRef,
    config: merged,
    enableAdminActions: merged.enableAdminActions,
    chatmode: merged.chatmode,
    oncharPrefixes: merged.oncharPrefixes,
    requireMention,
    textChunkLimit: merged.textChunkLimit,
    blockStreaming: merged.blockStreaming,
    blockStreamingCoalesce: merged.blockStreamingCoalesce,
    streams: merged.streams,
  };
}

export function resolveZulipAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedZulipAccount {
  const merged = resolveMergedConfig(params);
  return buildResolvedAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    env: params.env,
    apiKeyResolution: resolveApiKeyForInspect({
      cfg: params.cfg,
      value: merged.merged.apiKey,
      path: merged.apiKeyPath,
      allowEnvFallback: merged.accountId === DEFAULT_ACCOUNT_ID && !merged.hasConfiguredApiKey,
      env: params.env ?? process.env,
    }),
  });
}

export async function resolveZulipRuntimeAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedZulipAccount> {
  const merged = resolveMergedConfig(params);
  return buildResolvedAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    env: params.env,
    apiKeyResolution: await resolveApiKeyForRuntime({
      cfg: params.cfg,
      value: merged.merged.apiKey,
      path: merged.apiKeyPath,
      allowEnvFallback: merged.accountId === DEFAULT_ACCOUNT_ID && !merged.hasConfiguredApiKey,
      env: params.env ?? process.env,
    }),
  });
}

export function listEnabledZulipAccounts(cfg: OpenClawConfig): ResolvedZulipAccount[] {
  return listZulipAccountIds(cfg)
    .map((accountId) => resolveZulipAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
