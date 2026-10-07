import { isDeepStrictEqual } from "node:util";
import type { ChannelPlugin, OpenClawConfig } from "./sdk.js";
import { resolveZulipAccount, type ResolvedZulipAccount } from "./zulip/accounts.js";
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

type AccountLifetime = {
  config: OpenClawConfig;
  poll: AbortController;
  messages: AbortController;
  stopped: boolean;
  refreshing: boolean;
  settled: Promise<void>;
  generation: Promise<void>;
  changes: Promise<void>;
};
const accounts = new Map<string, AccountLifetime>();

type AccountOptions = MonitorZulipOpts & {
  config: OpenClawConfig;
  accountId: string;
  abortSignal: AbortSignal;
};
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
  await stopZulipAccount(opts.accountId);
  if (opts.abortSignal.aborted) return;
  const { monitorZulipProvider, clearZulipAccountMonitorCaches } = await import("./zulip/monitor.js");
  if (opts.abortSignal.aborted) return;
  const lifetime: AccountLifetime = {
    config: opts.config,
    poll: new AbortController(),
    messages: new AbortController(),
    stopped: false,
    refreshing: false,
    settled: Promise.resolve(),
    generation: Promise.resolve(),
    changes: Promise.resolve(),
  };
  const stop = () => {
    lifetime.stopped = true;
    lifetime.messages.abort();
    lifetime.poll.abort();
  };
  opts.abortSignal.addEventListener("abort", stop, { once: true });
  accounts.set(opts.accountId, lifetime);
  lifetime.settled = (async () => {
    try {
      do {
        lifetime.refreshing = false;
        lifetime.poll = new AbortController();
        if (lifetime.stopped) break;
        clearZulipAccountMonitorCaches(opts.accountId);
        lifetime.generation = monitorZulipProvider({
          ...opts,
          apiKey: undefined,
          email: undefined,
          baseUrl: undefined,
          config: lifetime.config,
          getConfig: () => opts.getConfig?.() ?? lifetime.config,
          abortSignal: lifetime.poll.signal,
          messageAbortSignal: lifetime.messages.signal,
        });
        await lifetime.generation;
      } while (!lifetime.stopped && lifetime.refreshing);
    } finally {
      opts.abortSignal.removeEventListener("abort", stop);
      if (accounts.get(opts.accountId) === lifetime) {
        accounts.delete(opts.accountId);
        clearZulipAccountMonitorCaches(opts.accountId);
      }
    }
  })();
  return lifetime;
}

export async function stopZulipAccount(accountId: string): Promise<void> {
  const lifetime = accounts.get(accountId);
  if (!lifetime) return;
  lifetime.stopped = true;
  lifetime.messages.abort();
  lifetime.poll.abort();
  await lifetime.settled;
}

export const zulipLifecycle: NonNullable<ChannelPlugin<ResolvedZulipAccount>["lifecycle"]> = {
  onAccountConfigChanged: async ({ nextCfg, accountId }) => {
    const lifetime = accounts.get(accountId);
    if (!lifetime) return;
    const change = lifetime.changes.then(async () => {
      if (lifetime.stopped) return;
      const changed = !isDeepStrictEqual(
        registrationConfig(lifetime.config, accountId),
        registrationConfig(nextCfg, accountId),
      );
      lifetime.config = nextCfg;
      if (!resolveZulipAccount({ cfg: nextCfg, accountId }).enabled) {
        await stopZulipAccount(accountId);
      } else if (changed) {
        lifetime.refreshing = true;
        lifetime.poll.abort();
        await lifetime.generation;
      }
    });
    lifetime.changes = change.catch(() => undefined);
    await change;
  },
  onAccountRemoved: async ({ accountId }) => {
    await starts.get(accountId);
    await stopZulipAccount(accountId);
    const { clearZulipAccountMonitorCaches } = await import("./zulip/monitor.js");
    clearZulipAccountMonitorCaches(accountId, true);
  },
};
