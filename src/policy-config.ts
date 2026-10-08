import type { OpenClawConfig } from "./sdk.js";
import type { ZulipAccountConfig, ZulipConfig } from "./types.js";

export function normalizeZulipAllowEntry(entry: string): string {
  return entry.trim().replace(/^(zulip|user):/i, "").replace(/^@/, "").toLowerCase();
}

export function normalizeZulipAllowList(entries: Array<string | number>): string[] {
  return [...new Set(entries.map((entry) => normalizeZulipAllowEntry(String(entry))).filter(Boolean))];
}

export function zulipPolicyScopes(cfg: OpenClawConfig) {
  const root = cfg.channels?.zulip as ZulipConfig | undefined;
  if (!root) return [];
  return [
    { path: "channels.zulip", stored: root, effective: root as ZulipAccountConfig },
    ...Object.entries(root.accounts ?? {}).map(([id, account]) => ({
      path: `channels.zulip.accounts.${id}`,
      stored: account,
      effective: { ...root, ...account } as ZulipAccountConfig,
    })),
  ];
}
