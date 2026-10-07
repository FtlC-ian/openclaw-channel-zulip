import { isDeepStrictEqual } from "node:util";
import type { ChannelPlugin, OpenClawConfig } from "./sdk.js";
import { isZulipAccountConfigured, listZulipAccountIds, resolveZulipAccount, type ResolvedZulipAccount } from "./zulip/accounts.js";
import { zulipStreamOverridesExpandLegacySelection } from "./zulip/stream-policy.js";
import type { MonitorZulipOpts } from "./zulip/monitor.js";

function registrationConfig(cfg: OpenClawConfig, accountId: string) {
  const account = resolveZulipAccount({ cfg, accountId });
  return {
    enabled: account.enabled,
    url: account.baseUrl,
    email: account.email,
    apiKey: account.apiKey ?? account.apiKeyRef,
    streams: zulipStreamOverridesExpandLegacySelection({
      streams: account.streams,
      streamOverrides: account.config.streamOverrides,
    }) ? ["*"] : account.streams ?? ["*"],
  };
}

function accountIsActive(cfg: OpenClawConfig, accountId: string): boolean {
  const account = resolveZulipAccount({ cfg, accountId });
  return Boolean(cfg.channels?.zulip) && listZulipAccountIds(cfg).includes(accountId)
    && account.enabled && isZulipAccountConfigured(account);
}

type AccountOptions = MonitorZulipOpts & {
  config: OpenClawConfig;
  accountId: string;
  abortSignal: AbortSignal;
};
type AccountLifetime = {
  config: OpenClawConfig;
  gatewayStops: number;
  currentConfig: () => OpenClawConfig;
  poll: AbortController;
  messages: AbortController;
  settled: Promise<void>;
};
const accounts = new Map<string, AccountLifetime>();
const starts = new Map<string, Promise<AccountLifetime | undefined>>();

export async function runZulipAccount(opts: AccountOptions): Promise<void> {
  const previous = starts.get(opts.accountId) ?? Promise.resolve();
  const preparing = previous.catch(() => undefined).then(() => beginZulipAccount(opts));
  starts.set(opts.accountId, preparing);
  try {
    const lifetime = await preparing;
    await lifetime?.settled;
  } finally {
    if (starts.get(opts.accountId) === preparing) starts.delete(opts.accountId);
  }
}

async function beginZulipAccount(opts: AccountOptions): Promise<AccountLifetime | undefined> {
  const previous = accounts.get(opts.accountId);
  if (previous) {
    if (!previous.poll.signal.aborted) {
      previous.messages.abort();
      previous.poll.abort();
    }
    await previous.settled;
  }
  if (opts.abortSignal.aborted) return;
  const { monitorZulipProvider, clearZulipAccountMonitorCaches } = await import("./zulip/monitor.js");
  const currentConfig = opts.getConfig ?? (() => opts.config);
  const current = currentConfig();
  if (opts.abortSignal.aborted || !accountIsActive(current, opts.accountId)
    || !isDeepStrictEqual(registrationConfig(current, opts.accountId), registrationConfig(opts.config, opts.accountId))) return;
  const lifetime: AccountLifetime = {
    config: opts.config,
    gatewayStops: 0,
    currentConfig,
    poll: new AbortController(),
    messages: new AbortController(),
    settled: Promise.resolve(),
  };
  const stop = () => {
    const current = currentConfig();
    const transportReload = accountIsActive(current, opts.accountId)
      && !isDeepStrictEqual(registrationConfig(opts.config, opts.accountId), registrationConfig(current, opts.accountId));
    if (!transportReload) lifetime.messages.abort();
    lifetime.poll.abort();
  };
  opts.abortSignal.addEventListener("abort", stop, { once: true });
  accounts.set(opts.accountId, lifetime);
  clearZulipAccountMonitorCaches(opts.accountId);
  lifetime.settled = (async () => {
    try {
      await monitorZulipProvider({
        ...opts,
        config: opts.config,
        getConfig: currentConfig,
        abortSignal: lifetime.poll.signal,
        messageAbortSignal: lifetime.messages.signal,
      });
    } finally {
      opts.abortSignal.removeEventListener("abort", stop);
      if (accounts.get(opts.accountId) === lifetime) {
        accounts.delete(opts.accountId);
        clearZulipAccountMonitorCaches(opts.accountId, !accountIsActive(currentConfig(), opts.accountId));
      }
    }
  })();
  return lifetime;
}

export async function stopZulipAccount(accountId: string, allowTransportDrain = false): Promise<void> {
  const lifetime = accounts.get(accountId);
  if (!lifetime) return;
  const current = lifetime.currentConfig();
  const transportDrain = allowTransportDrain && lifetime.gatewayStops++ === 0
    && accountIsActive(current, accountId)
    && !isDeepStrictEqual(registrationConfig(lifetime.config, accountId), registrationConfig(current, accountId));
  if (!transportDrain) lifetime.messages.abort();
  lifetime.poll.abort();
  await lifetime.settled;
}

export const zulipLifecycle: NonNullable<ChannelPlugin<ResolvedZulipAccount>["lifecycle"]> = {
  onAccountConfigChanged: async ({ prevCfg, nextCfg, accountId }) => {
    if (isDeepStrictEqual(registrationConfig(prevCfg, accountId), registrationConfig(nextCfg, accountId))) return;
    const { clearZulipAccountMonitorCaches } = await import("./zulip/monitor.js");
    // Hooks precede persistence; core's committed reload owns queue replacement.
    clearZulipAccountMonitorCaches(accountId);
  },
  onAccountRemoved: async ({ accountId }) => {
    const { clearZulipAccountMonitorCaches } = await import("./zulip/monitor.js");
    const lifetime = accounts.get(accountId);
    if (lifetime && !accountIsActive(lifetime.currentConfig(), accountId)) {
      await stopZulipAccount(accountId);
      clearZulipAccountMonitorCaches(accountId, true);
    } else {
      clearZulipAccountMonitorCaches(accountId);
    }
  },
};
