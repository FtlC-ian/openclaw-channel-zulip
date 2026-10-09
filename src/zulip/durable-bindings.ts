import { createHash, randomUUID } from "node:crypto";
import type { ZulipClient } from "./client.js";
export type DurableRecord = {
  kind: "approval" | "question" | "draft" | "card"; accountId: string; scope: string; generation: string;
  messageId: string; companionId?: string; sessionKey?: string; revision?: number; hash?: string;
  id?: string; approvalKind?: "exec" | "plugin"; decisions?: string[]; emojis?: [string, string][];
  nonce?: string; senderHash?: string; optionHashes?: string[]; expiresAt: number;
  conversation?: { kind: "dm"; recipient: string } | { kind: "stream"; stream: string; topic: string };
};
type Store = {
  lookup(key: string): Promise<DurableRecord | undefined>;
  entries(): Promise<{ key: string; value: DurableRecord }[]>;
  update(key: string, update: (current: DurableRecord | undefined) => DurableRecord | undefined): Promise<boolean>;
  deleteIf(key: string, predicate: (current: DurableRecord) => boolean): Promise<boolean>;
};
export const bindingHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const bindingScope = (client: ZulipClient) => bindingHash(`${client.baseUrl}\n${Buffer.from((client.authHeader ?? "").replace(/^Basic /, ""), "base64").toString().split(":")[0]}`);
let storePromise: Promise<Store | undefined> | undefined;
let active = false;
let runtimeOpen: ((options: Record<string, unknown>) => unknown) | undefined;
export function startDurableBindings(open?: (options: Record<string, unknown>) => unknown): void { active = true; runtimeOpen = open; storePromise = undefined; }
async function loadStore(): Promise<Store | undefined> {
  if (!active) return;
  return storePromise ??= (async () => {
    try {
      // Optional public SDK surface: a missing store disables durability, not Zulip.
      // @ts-expect-error The 2026.9.6 public subpath ships without declarations.
      const sdk = await import("openclaw/plugin-sdk/plugin-state-store-runtime");
      const create = sdk.createPluginStateKeyedStore ?? sdk.createPluginStateSyncKeyedStore;
      if (typeof create !== "function") return;
      // Legacy hosts share a 1000-row plugin budget: ingress reserves 950 rows.
      const options = { namespace: "zulip.durable-bindings.v1", maxEntries: 40, overflowPolicy: "reject-new", defaultTtlMs: 30 * 86400_000 };
      const store = runtimeOpen ? await runtimeOpen(options) : create("zulip", options);
      if (typeof store.update !== "function" || typeof store.deleteIf !== "function") return;
      return store as Store;
    } catch { return; }
  })();
}
export class DurableBindings {
  constructor(private readonly open: () => Promise<Store | undefined> = loadStore) {}
  async claim(key: string, record: Omit<DurableRecord, "generation">, expectedGeneration?: string): Promise<DurableRecord | undefined> {
    const store = await this.open(); if (!store) return;
    const next = { ...record, generation: randomUUID() };
    // Atomic generation replacement ensures writers from the old lifetime lose.
    const expected = expectedGeneration ?? (record as DurableRecord).generation;
    const claimed = await store.update(key, current => expected && current?.generation !== expected ? undefined : next);
    return claimed ? next : undefined;
  }
  async get(key: string): Promise<DurableRecord | undefined> {
    return (await this.open())?.lookup(key);
  }
  async save(key: string, record: DurableRecord): Promise<boolean> {
    const store = await this.open(); if (!store) return false;
    return store.update(key, current => current?.generation === record.generation ? record : undefined);
  }
  async current(key: string, record: DurableRecord): Promise<boolean> {
    const store = await this.open(); return !store || (await store.lookup(key))?.generation === record.generation;
  }
  async remove(key: string, record: DurableRecord): Promise<void> {
    const store = await this.open(); await store?.deleteIf(key, current => current.generation === record.generation);
  }
  async records(accountId: string, client: ZulipClient): Promise<{ key: string; record: DurableRecord }[]> {
    const store = await this.open(); if (!store) return [];
    return (await store.entries()).filter(entry => entry.value.accountId === accountId && entry.value.scope === bindingScope(client)).map(entry => ({ key: entry.key, record: entry.value }));
  }
}
export const durableBindings = new DurableBindings();
