import { normalizeAccountId, type ChannelPlugin } from "./sdk.js";
import { normalizeZulipAllowEntry, normalizeZulipAllowList } from "./policy-config.js";
import type { ZulipConfig } from "./types.js";
import { resolveZulipAccount } from "./zulip/accounts.js";
import { normalizeZulipStreamIdSelector, normalizeZulipStreamName } from "./zulip/stream-policy.js";

export const zulipAllowlist: NonNullable<ChannelPlugin["allowlist"]> = {
  supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
  readConfig: ({ cfg, accountId }) => {
    const account = accountId == null
      ? (cfg.channels?.zulip as ZulipConfig | undefined) ?? {}
      : resolveZulipAccount({ cfg, accountId }).config;
    return {
      dmAllowFrom: account.allowFrom ?? [],
      groupAllowFrom: normalizeZulipAllowList(account.groupAllowFrom ?? []).length ? account.groupAllowFrom : account.allowFrom ?? [],
      dmPolicy: account.dmPolicy ?? "pairing",
      groupPolicy: account.groupPolicy ?? cfg.channels?.defaults?.groupPolicy ?? "allowlist",
      groupOverrides: [
        { label: "streams (omitted/empty/* = all public streams)", entries: account.streams ?? [] },
        ...Object.entries(account.streamOverrides ?? {}).map(([selector, rule]) => ({
          label: `stream:${selector} (enabled=${rule.enabled ?? "inherit"})`,
          entries: rule.enabled === true ? [`stream:${selector}`] : [],
        })),
      ],
    };
  },
  applyConfigEdit: ({ cfg, parsedConfig, accountId, scope, action, entry }) => {
    const stream = scope === "group" && /^(stream:|#)/i.test(entry.trim());
    const selector = stream ? entry.trim().replace(/^(stream:|#)/i, "") : undefined;
    const normalized = selector !== undefined
      ? normalizeZulipStreamIdSelector(selector) ?? normalizeZulipStreamName(selector)
      : normalizeZulipAllowEntry(entry);
    if (!normalized || (stream && normalized === "*") || ["__proto__", "prototype", "constructor"].includes(normalized)) return { kind: "invalid-entry" };
    const id = accountId == null ? undefined : normalizeAccountId(accountId);
    if (id && ["__proto__", "prototype", "constructor"].includes(id)) return { kind: "invalid-entry" };
    const channels = parsedConfig.channels as Record<string, unknown> | undefined;
    const root = channels?.zulip as ZulipConfig | undefined;
    const useAccount = id !== undefined && (id !== "default" || root?.accounts !== undefined);
    const effective = id === undefined ? (cfg.channels?.zulip as ZulipConfig | undefined) ?? {} : resolveZulipAccount({ cfg, accountId: id }).config;
    const stored = useAccount ? root?.accounts?.[id!] : root;
    const path = useAccount ? `channels.zulip.accounts.${id}` : "channels.zulip";
    const writeTarget = useAccount
      ? { kind: "account" as const, scope: { channelId: "zulip", accountId: id! } }
      : { kind: "channel" as const, scope: { channelId: "zulip" } };
    let update: Partial<ZulipConfig>;
    let pathLabel: string;
    let changed: boolean;
    if (stream) {
      const overrides = effective.streamOverrides ?? {};
      const key = Object.keys(overrides).find((key) => (normalizeZulipStreamIdSelector(key) ?? normalizeZulipStreamName(key)) === normalized) ?? normalized;
      const enabled = action === "add";
      changed = overrides[key]?.enabled !== enabled;
      update = { streamOverrides: { ...overrides, [key]: { ...overrides[key], enabled } } };
      pathLabel = `${path}.streamOverrides.${key}.enabled`;
    } else {
      const key = scope === "dm" ? "allowFrom" : "groupAllowFrom";
      const existing = scope === "group"
        ? effective.groupPolicy === "disabled" && stored?.groupAllowFrom !== undefined
          ? stored.groupAllowFrom
          : normalizeZulipAllowList(stored?.groupAllowFrom ?? effective.groupAllowFrom ?? []).length
          ? stored?.groupAllowFrom ?? effective.groupAllowFrom ?? []
          : effective.allowFrom ?? []
        : stored?.allowFrom ?? effective.allowFrom ?? [];
      const matches = (value: string | number) => normalizeZulipAllowEntry(String(value)) === normalized;
      const next = action === "add"
        ? existing.some(matches) ? existing : [...existing, normalized]
        : existing.filter((value) => !matches(value));
      changed = JSON.stringify(existing) !== JSON.stringify(next);
      update = { [key]: next };
      // An empty group list falls back to DM senders; removing the last sender must fail closed.
      if (scope === "group" && action === "remove" && changed && normalizeZulipAllowList(next).length === 0) update.groupPolicy = "disabled";
      if (scope === "dm" && action === "remove" && normalized === "*" && effective.dmPolicy === "open" && changed) update.dmPolicy = "allowlist";
      pathLabel = `${path}.${key}`;
    }
    if (changed) {
      const targetChannels = (parsedConfig.channels ??= {}) as Record<string, unknown>;
      const targetRoot = (targetChannels.zulip ??= {}) as ZulipConfig;
      const target = useAccount ? ((targetRoot.accounts ??= {})[id!] ??= {}) : targetRoot;
      Object.assign(target, update);
    }
    return { kind: "ok", changed, pathLabel, writeTarget };
  },
};
