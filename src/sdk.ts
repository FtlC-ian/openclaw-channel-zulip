export type { ChannelPlugin, OpenClawConfig, OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
export { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
export type { ChannelAccountSnapshot, ChannelMessageActionAdapter, ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
export type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
export type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
export { normalizeMessagePresentation, resolveMessagePresentationActionValue } from "openclaw/plugin-sdk/interactive-runtime";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
export type { WizardPrompter } from "openclaw/plugin-sdk/setup";

export type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";

export type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { buildOutboundMediaLoadOptions } from "openclaw/plugin-sdk/media-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";

type OutboundMediaLoadOptions = {
  maxBytes?: number;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
    workspaceDir?: string;
  };
  mediaLocalRoots?: readonly string[] | "any";
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  workspaceDir?: string;
  proxyUrl?: string;
  fetchImpl?: typeof fetch;
  requestInit?: RequestInit;
  optimizeImages?: boolean;
  trustExplicitProxyDns?: boolean;
};

export async function loadOutboundMediaFromUrl(
  mediaUrl: string,
  options: OutboundMediaLoadOptions = {},
) {
  return await loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions(options));
}

export {
  createChannelMessageAdapterFromOutbound,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
export type { ChannelMessageAdapterShape } from "openclaw/plugin-sdk/channel-outbound";

export type { ChannelSetupInput, ChannelSetupWizardAdapter, DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/setup";

export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  applyAccountNameToChannelSection,
  buildChannelOutboundSessionRoute,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";

export { jsonResult } from "openclaw/plugin-sdk/core";
export { readNumberParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
export { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
