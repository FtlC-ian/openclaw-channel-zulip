import type { ChannelPlugin } from "./sdk.js";
import { resolveZulipApprovers } from "./approval-auth.js";
import { normalizeZulipAllowList, zulipPolicyScopes } from "./policy-config.js";
import { zulipStreamOverridesExpandLegacySelection } from "./zulip/stream-policy.js";

export const zulipDoctor: NonNullable<ChannelPlugin["doctor"]> = {
  dmAllowFromMode: "topOrNested",
  groupModel: "hybrid",
  groupAllowFromFallbackToAllowFrom: true,
  warnOnEmptyGroupSenderAllowlist: true,
  shouldSkipDefaultEmptyGroupAllowlistWarning: ({ channelName }) => channelName === "zulip",
  collectPreviewWarnings: ({ cfg }) => {
    const warnings: string[] = [];
    if ((cfg.channels?.zulip as { enabled?: boolean } | undefined)?.enabled === false) return warnings;
    for (const { path, effective: account } of zulipPolicyScopes(cfg)) {
      if (account.enabled === false) continue;
      const groupPolicy = account.groupPolicy ?? cfg.channels?.defaults?.groupPolicy ?? "allowlist";
      if (account.dmPolicy === "open") {
        warnings.push(`${path}.dmPolicy="open" accepts DMs from anyone. Fix: choose "pairing" or "allowlist" and explicit ${path}.allowFrom emails; doctor will not choose users for you.`);
      }
      if (groupPolicy === "allowlist" && normalizeZulipAllowList(account.groupAllowFrom ?? []).length === 0) {
        const fallback = normalizeZulipAllowList(account.allowFrom ?? []).length > 0;
        warnings.push(`${path}.groupAllowFrom is empty while groupPolicy="allowlist"; ${fallback ? "stream senders fall back to allowFrom" : "stream messages are blocked"}. Fix: set explicit ${path}.groupAllowFrom sender emails, or groupPolicy="disabled" for DM-only handling.`);
      }
      if (groupPolicy !== "disabled") {
        if (!account.streams?.length || account.streams.some((entry) => entry.trim() === "*")) {
          warnings.push(`${path}.streams is omitted, empty, or contains "*": all public streams are monitored, not DM-only. Fix: select stream names and review streamOverrides; use ${path}.groupPolicy="disabled" for DM-only handling.`);
        } else if (zulipStreamOverridesExpandLegacySelection({ streams: account.streams, streamOverrides: account.streamOverrides })) {
          warnings.push(`${path}.streamOverrides can enable streams outside streams. Fix: remove unintended enabled overrides or set enabled=false for those selectors.`);
        }
      }
      const accountId = path === "channels.zulip" ? undefined : path.slice("channels.zulip.accounts.".length);
      const approverCfg = path === "channels.zulip"
        ? { ...cfg, channels: { ...cfg.channels, zulip: { ...account, accounts: undefined, defaultAccount: undefined } } }
        : cfg;
      if (account.approvalReactions && resolveZulipApprovers(approverCfg, accountId).length === 0) {
        warnings.push(`${path}.approvalReactions has no explicit allowFrom approver emails; reactions cannot approve requests. Fix: add trusted emails to ${path}.allowFrom ("*" and pairing-store approvals do not qualify), or remove approvalReactions.`);
      }
    }
    return warnings;
  },
  repairConfig: ({ cfg }) => {
    const config = structuredClone(cfg);
    const changes: string[] = [];
    for (const { path, stored } of zulipPolicyScopes(config)) {
      for (const key of ["allowFrom", "groupAllowFrom"] as const) {
        const list = stored[key];
        if (!list) continue;
        const unique = [...new Set(list)];
        if (unique.length !== list.length) {
          stored[key] = unique;
          changes.push(`${path}.${key}: removed exact duplicate sender entries without changing identities or access.`);
        }
      }
    }
    return { config: changes.length ? config : cfg, changes };
  },
};
