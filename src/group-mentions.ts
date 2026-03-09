import type { ChannelGroupContext } from "openclaw/plugin-sdk";
import { resolveZulipAccount } from "./zulip/accounts.js";

export function resolveZulipGroupRequireMention(params: ChannelGroupContext): boolean | undefined {
  const account = resolveZulipAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });

  // Check per-stream overrides first (keyed by stream name or stream ID)
  const overrides = account.config.streamOverrides;
  if (overrides && params.groupId) {
    const streamOverride = overrides[params.groupId];
    if (streamOverride?.requireMention !== undefined) {
      return streamOverride.requireMention;
    }
  }

  if (typeof account.requireMention === "boolean") {
    return account.requireMention;
  }
  return true;
}
