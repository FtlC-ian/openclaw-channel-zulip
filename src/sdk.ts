import type { PluginRuntime as OpenClawPluginRuntime } from "openclaw/plugin-sdk/core";

export type { ChannelPlugin, OpenClawConfig, OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
export { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
export type { ChannelAccountSnapshot, ChannelMessageActionAdapter, ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
export type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
export type { InteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
export type { WizardPrompter } from "openclaw/plugin-sdk/setup";

export type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-runtime";
export { createReplyPrefixOptions, createTypingCallbacks } from "openclaw/plugin-sdk/channel-runtime";

export type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";

export type { ChannelSetupWizardAdapter, DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/setup";

export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";

export { jsonResult } from "openclaw/plugin-sdk/core";
export { readNumberParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
export { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
export { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
export { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
export { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
export { readStoreAllowFromForDmPolicy, resolveDmGroupAccessWithLists } from "openclaw/plugin-sdk/channel-policy";

export function createScopedPairingAccess(params: {
  core: OpenClawPluginRuntime;
  channel: string;
  accountId: string;
}) {
  const pairing = params.core.channel.pairing;
  return {
    accountId: params.accountId,
    readAllowFromStore: () =>
      pairing.readAllowFromStore({
        channel: params.channel,
        accountId: params.accountId,
      }),
    readStoreForDmPolicy: async () =>
      pairing.readAllowFromStore({
        channel: params.channel,
        accountId: params.accountId,
      }),
    upsertPairingRequest: (
      input: Omit<Parameters<typeof pairing.upsertPairingRequest>[0], "channel" | "accountId">,
    ) =>
      pairing.upsertPairingRequest({
        channel: params.channel,
        accountId: params.accountId,
        ...input,
      }),
  };
}
export {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
export type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
export { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
export { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
