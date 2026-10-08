import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../sdk.js";
import { isZulipAccountConfigured, listZulipAccountIds, resolveZulipAccount } from "./accounts.js";
import { sendZulipTyping, type ZulipClient } from "./client.js";

export type ZulipTypingTarget = { type: "stream"; streamId: number | string; topic: string } | { type: "direct"; to: number[] };
type Target = ZulipTypingTarget;
type Entry = {
  target: Target;
  monitors: Set<symbol>;
  activeMonitors: Set<symbol>;
  core: boolean;
  started: boolean;
  lastStart: number;
  tail: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  listeners: Map<AbortSignal, () => void>;
};
function transportIdentity(cfg: OpenClawConfig, accountId: string) {
  const account = resolveZulipAccount({ cfg, accountId });
  return { url: account.baseUrl, email: account.email, apiKey: account.apiKey ?? account.apiKeyRef, streams: account.streams ?? ["*"] };
}
const connections = new Map<string, ZulipConnection>();
const keyFor = (target: Target) => JSON.stringify(target.type === "stream"
  ? [target.type, String(target.streamId), target.topic] : [target.type, [...target.to].sort((a, b) => a - b)]);

export class ZulipConnection {
  polling = false;
  private closed = false;
  private closing?: Promise<void>;
  private registration: ReturnType<typeof transportIdentity>;
  private entries = new Map<string, Entry>();
  private abort = () => { void this.close(); };

  constructor(readonly accountId: string, readonly client: ZulipClient,
    readonly getConfig: () => OpenClawConfig, readonly signal?: AbortSignal, registeredConfig = getConfig()) {
    this.registration = transportIdentity(registeredConfig, accountId);
    connections.set(accountId, this);
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  current(cfg = this.getConfig()): boolean {
    const account = resolveZulipAccount({ cfg, accountId: this.accountId });
    return !this.closed && !this.signal?.aborted && connections.get(this.accountId) === this
      && listZulipAccountIds(cfg).includes(this.accountId) && account.enabled && isZulipAccountConfigured(account)
      && isDeepStrictEqual(this.registration, transportIdentity(cfg, this.accountId));
  }

  private entry(target: Target): Entry {
    const key = keyFor(target);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 1000) throw new Error("Zulip typing target limit exceeded");
      entry = { target, monitors: new Set(), activeMonitors: new Set(), core: false, started: false, lastStart: 0, tail: Promise.resolve(), listeners: new Map() };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private enqueue(entry: Entry, action: () => Promise<void>): Promise<void> {
    const pending = entry.tail.catch(() => {}).then(action);
    entry.tail = pending;
    return pending;
  }

  private stop(entry: Entry): Promise<void> {
    return this.enqueue(entry, async () => {
      if (!entry.started) return;
      entry.started = false;
      await sendZulipTyping(this.client, { ...entry.target, op: "stop" }, { signal: AbortSignal.timeout(5000) });
    });
  }

  private retireCore(entry: Entry): void {
    entry.core = false;
    clearTimeout(entry.timer);
    for (const [signal, listener] of entry.listeners) signal.removeEventListener("abort", listener);
    entry.listeners.clear();
  }

  private prune(entry: Entry): void {
    if (!entry.core && !entry.monitors.size && this.entries.get(keyFor(entry.target)) === entry) this.entries.delete(keyFor(entry.target));
  }

  claimMonitor(target: Target) {
    const entry = this.entry(target);
    const owner = Symbol();
    entry.monitors.add(owner);
    this.retireCore(entry);
    void this.stop(entry).catch(() => {});
    let closed = false;
    let closing: Promise<void> | undefined;
    const stop = async () => {
      entry.activeMonitors.delete(owner);
      if (!entry.activeMonitors.size) await this.stop(entry);
    };
    return {
      start: () => {
        if (!closed) entry.activeMonitors.add(owner);
        return this.start(entry, () => !closed && entry.activeMonitors.has(owner));
      },
      stop,
      close: () => closing ??= (async () => {
        closed = true;
        entry.monitors.delete(owner);
        try { await stop(); } finally { this.prune(entry); }
      })(),
    };
  }

  private start(entry: Entry, authorized: () => boolean, signal?: AbortSignal, guard?: () => void): Promise<void> {
    return this.enqueue(entry, async () => {
      signal?.throwIfAborted();
      guard?.();
      if (!this.current() || !authorized()) return;
      if (entry.started && Date.now() - entry.lastStart < 2500) return;
      entry.started = true;
      entry.lastStart = Date.now();
      await sendZulipTyping(this.client, { ...entry.target, op: "start" }, {
        signal: AbortSignal.any([AbortSignal.timeout(5000), ...(this.signal ? [this.signal] : []), ...(signal ? [signal] : [])]),
      });
    });
  }

  async startCore(target: Target, signal?: AbortSignal, guard?: () => void): Promise<void> {
    signal?.throwIfAborted();
    guard?.();
    if (!this.current()) {
      await this.clearCore(target);
      return;
    }
    const entry = this.entry(target);
    if (entry.monitors.size) return;
    entry.core = true;
    clearTimeout(entry.timer);
    const clear = () => { void this.clearCore(target).catch(() => {}); };
    entry.timer = setTimeout(clear, 12000);
    entry.timer.unref?.();
    if (signal && !entry.listeners.has(signal)) {
      entry.listeners.set(signal, clear);
      signal.addEventListener("abort", clear, { once: true });
    }
    try {
      await this.start(entry, () => entry.core && !entry.monitors.size && this.current(), signal, guard);
      signal?.throwIfAborted();
      guard?.();
    } catch (error) {
      await this.clearCore(target).catch(() => {});
      throw error;
    }
  }

  async clearCore(target: Target): Promise<void> {
    const entry = this.entries.get(keyFor(target));
    if (!entry) return;
    this.retireCore(entry);
    if (!entry.monitors.size) {
      try { await this.stop(entry); } finally { this.prune(entry); }
    }
  }

  close(): Promise<void> {
    return this.closing ??= this.closeOwned();
  }

  private async closeOwned(): Promise<void> {
    this.closed = true;
    this.polling = false;
    this.signal?.removeEventListener("abort", this.abort);
    if (connections.get(this.accountId) === this) connections.delete(this.accountId);
    await Promise.allSettled([...this.entries.values()].map(entry => {
      this.retireCore(entry);
      entry.monitors.clear();
      entry.activeMonitors.clear();
      return this.stop(entry);
    }));
    this.entries.clear();
  }
}

export function getZulipConnection(accountId: string): ZulipConnection | undefined {
  return connections.get(accountId);
}
