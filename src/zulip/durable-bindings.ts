import { createHash, randomUUID } from "node:crypto";
import type { ZulipClient } from "./client.js";
import { deleteKeyedStoreIf, updateKeyedStore, type ConditionalStore, type StateAuthority } from "./keyed-store.js";
export type DurableRecord = {
  kind: "approval" | "question" | "draft" | "card"; accountId: string; scope: string; generation: string;
  messageId: string; companionId?: string; sessionKey?: string; revision?: number; hash?: string;
  id?: string; approvalKind?: "exec" | "plugin"; decisions?: string[]; emojis?: [string, string][];
  nonce?: string; senderHash?: string; optionHashes?: string[]; expiresAt: number;
  terminalState?: "reserved" | "source-deleted";
  conversation?: { kind: "dm"; recipient: string } | { kind: "stream"; stream: string; topic: string };
};
type Store = ConditionalStore<DurableRecord> & {
  lookup(key: string): Promise<DurableRecord | undefined>;
  entries(): Promise<{ key: string; value: DurableRecord }[]>;
};
export const bindingHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const bindingScope = (client: ZulipClient) => bindingHash(`${client.baseUrl}\n${Buffer.from((client.authHeader ?? "").replace(/^Basic /, ""), "base64").toString().split(":")[0]}`);
type OpenStore = (authority?: StateAuthority) => Store;
let storePromise: Promise<OpenStore | undefined> | undefined;
let active = false;
export function startDurableBindings(): void { active = true; storePromise = undefined; }
async function loadStore(authority?: StateAuthority): Promise<Store | undefined> {
  if (!active) return;
  const open = await (storePromise ??= (async () => {
    try {
      // Optional public SDK surface: a missing store disables durability, not Zulip.
      // @ts-expect-error The 2026.9.6 public subpath ships without declarations.
      const sdk = await import("openclaw/plugin-sdk/plugin-state-store-runtime");
      // Legacy hosts share a 1000-row plugin budget: ingress reserves 950 rows.
      const options = { namespace: "zulip.durable-bindings.v1", maxEntries: 40, overflowPolicy: "reject-new", defaultTtlMs: 30 * 86400_000 };
      if (typeof sdk.createPluginStateKeyedStoreV2 === "function") {
        // Cache the opener, not a caller's authority. Each action gets its own view.
        return (authority?: StateAuthority) => sdk.createPluginStateKeyedStoreV2("zulip", options, {
          assertCurrent: () => {
            if (!active) throw new Error("Durable bindings are inactive");
            authority?.assertCurrent();
          },
        }) as Store;
      }
      const create = sdk.createPluginStateKeyedStore ?? sdk.createPluginStateSyncKeyedStore;
      if (typeof create !== "function") return;
      const store = create("zulip", options);
      if (typeof store.update !== "function" || typeof store.deleteIf !== "function") return;
      return () => store as Store;
    } catch { return; }
  })());
  try { return open?.(authority); } catch { return; }
}
export class DurableBindings {
  constructor(private readonly open: (authority?: StateAuthority) => Promise<Store | undefined> = loadStore) {}
  async claim(key: string, record: Omit<DurableRecord, "generation">, expectedGeneration?: string, isCurrent?: () => boolean): Promise<DurableRecord | undefined> {
    const stale = new Error("Durable binding writer is no longer current");
    const authority = isCurrent ? { assertCurrent: () => { if (!isCurrent()) throw stale; } } : undefined;
    try {
      const store = await this.open(authority);
      if (!store) return;
      const next = { ...Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)), generation: randomUUID() } as DurableRecord;
      // Atomic generation replacement ensures writers from the old lifetime lose.
      const expected = expectedGeneration ?? (record as DurableRecord).generation;
      const claimed = await updateKeyedStore(store, key, current => isCurrent && !isCurrent() || expected && current?.generation !== expected ? undefined : next);
      return claimed ? next : undefined;
    } catch (error) {
      const seen = new Set<unknown>();
      for (let cause = error; cause instanceof Error && !seen.has(cause); cause = cause.cause) {
        if (cause === stale) return;
        seen.add(cause);
      }
      throw error;
    }
  }
  async get(key: string): Promise<DurableRecord | undefined> {
    return (await this.open())?.lookup(key);
  }
  async save(key: string, record: DurableRecord): Promise<boolean> {
    const store = await this.open(); if (!store) return false;
    const value = Object.fromEntries(Object.entries(record).filter(([, field]) => field !== undefined)) as DurableRecord;
    return updateKeyedStore(store, key, current => current?.generation === record.generation ? value : undefined);
  }
  async current(key: string, record: DurableRecord): Promise<boolean> {
    const store = await this.open(); return !store || (await store.lookup(key))?.generation === record.generation;
  }
  async remove(key: string, record: DurableRecord): Promise<void> {
    const store = await this.open(); if (store) await deleteKeyedStoreIf(store, key, current => current.generation === record.generation);
  }
  async records(accountId: string, client: ZulipClient): Promise<{ key: string; record: DurableRecord }[]> {
    const store = await this.open(); if (!store) return [];
    return (await store.entries()).filter(entry => entry.value.accountId === accountId && entry.value.scope === bindingScope(client)).map(entry => ({ key: entry.key, record: entry.value }));
  }
}
export const durableBindings = new DurableBindings();
