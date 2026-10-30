// Structural types preserve the 2026.9.6 SDK build floor.
export type StateAuthority = { assertCurrent(): void };
export type StoreOptions = { namespace: string; maxEntries: number; defaultTtlMs?: number; overflowPolicy?: "reject-new" };
export type CompareIntent<T> = { operation: "update"; action: "set"; value: T; ttlMs?: number } | { operation: "delete"; action: "delete" };
export type ConditionalStore<T> = {
  observe?: (key: string) => Promise<{ value: T | undefined; comparison: string }>;
  compareAndApply?: (key: string, comparison: string, intent: CompareIntent<T>) => Promise<{ status: "applied" | "unchanged" | "conflict" }>;
  update?: (key: string, update: (current: T | undefined) => T | undefined, options?: { ttlMs?: number }) => Promise<boolean>;
  deleteIf?: (key: string, predicate: (current: T) => boolean) => Promise<boolean>;
};
export type KeyedStore<T> = ConditionalStore<T> & {
  lookup(key: string): Promise<T | undefined>;
  entries(): Promise<{ key: string; value: T }[]>;
  register(key: string, value: T, options?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
};
type StoreState = {
  openKeyedStoreV2?: <T>(options: StoreOptions) => KeyedStore<T>;
  openKeyedStore?: <T>(options: StoreOptions) => KeyedStore<T>;
};
export function openCompatibleKeyedStore<T>(state: unknown, options: StoreOptions): KeyedStore<T> | undefined {
  const owner = state as StoreState | undefined;
  if (typeof owner?.openKeyedStoreV2 === "function") return owner.openKeyedStoreV2<T>(options);
  if (typeof owner?.openKeyedStore === "function") return owner.openKeyedStore<T>(options);
}
export function hasAtomicMutations<T>(store: ConditionalStore<T> | undefined): boolean {
  return !!store && (typeof store.observe === "function" && typeof store.compareAndApply === "function" || typeof store.update === "function");
}
// Only explicit conflicts retry. Rejections, including unknown writes, escape.
export async function updateKeyedStore<T>(store: ConditionalStore<T>, key: string, update: (current: T | undefined) => T | undefined, options?: { ttlMs?: number }): Promise<boolean> {
  if (store.observe && store.compareAndApply) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const observed = await store.observe(key);
      const value = update(observed.value);
      if (value === undefined) return false;
      const result = await store.compareAndApply(key, observed.comparison, { operation: "update", action: "set", value, ...options });
      if (result.status !== "conflict") return result.status === "applied";
    }
    throw new Error("Plugin state update conflict retry limit exceeded");
  }
  return store.update ? store.update(key, update, options) : false;
}
export async function deleteKeyedStoreIf<T>(store: ConditionalStore<T>, key: string, predicate: (current: T) => boolean): Promise<boolean> {
  if (store.observe && store.compareAndApply) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const observed = await store.observe(key);
      if (observed.value === undefined || !predicate(observed.value)) return false;
      const result = await store.compareAndApply(key, observed.comparison, { operation: "delete", action: "delete" });
      if (result.status !== "conflict") return result.status === "applied";
    }
    throw new Error("Plugin state delete conflict retry limit exceeded");
  }
  return store.deleteIf ? store.deleteIf(key, predicate) : false;
}
