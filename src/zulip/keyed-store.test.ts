import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimReactionTrigger } from "./reaction-triggers.js";
import { deleteKeyedStoreIf, openCompatibleKeyedStore, updateKeyedStore, type CompareIntent, type StateAuthority } from "./keyed-store.js";
import { DurableBindings, startDurableBindings, type DurableRecord } from "./durable-bindings.js";
import { createZulipDurableInboundReceiveJournal } from "./durable-receive.js";

const mocks = vi.hoisted(() => ({ sdk: {} as Record<string, unknown>, runtime: {} as any,
  queue: { release: vi.fn(), complete: vi.fn(), pending: vi.fn(), accept: vi.fn(), deletePending: vi.fn() } }));
vi.mock("openclaw/plugin-sdk/plugin-state-store-runtime", () => mocks.sdk);
vi.mock("../runtime.js", () => ({ getZulipRuntime: () => mocks.runtime }));
vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({ createDurableInboundReceiveJournalFromQueue: () => mocks.queue }));

function fakeStore<T>(v2: boolean, authority?: StateAuthority) {
  const rows = new Map<string, T>();
  let revision = 0;
  const controls = { conflicts: 0, wrapAuthorityErrors: false, beforeApply: undefined as (() => void) | undefined };
  const store = {
    lookup: vi.fn(async (key: string) => rows.get(key)),
    entries: vi.fn(async () => [...rows].map(([key, value]) => ({ key, value }))),
    register: vi.fn(async (key: string, value: T) => { rows.set(key, value); revision++; }),
    delete: vi.fn(async (key: string) => { revision++; return rows.delete(key); }),
    update: vi.fn(async (key: string, fn: (value: T | undefined) => T | undefined) => {
      if (v2) throw new Error("deprecated update called on V2");
      const next = fn(rows.get(key));
      if (next === undefined) return false;
      rows.set(key, next); revision++; return true;
    }),
    deleteIf: vi.fn(async (key: string, predicate: (value: T) => boolean) => {
      if (v2) throw new Error("deprecated deleteIf called on V2");
      const value = rows.get(key);
      return value !== undefined && predicate(value) && rows.delete(key);
    }),
    ...(v2 ? {
      observe: vi.fn(async (key: string) => { authority?.assertCurrent(); return { value: rows.get(key), comparison: String(revision) }; }),
      compareAndApply: vi.fn(async (key: string, comparison: string, intent: CompareIntent<T>) => {
        controls.beforeApply?.();
        authority?.assertCurrent();
        if (controls.conflicts-- > 0 || comparison !== String(revision)) return { status: "conflict" as const };
        if (intent.action === "delete") rows.delete(key); else rows.set(key, intent.value);
        revision++; return { status: "applied" as const };
      }),
    } : {}),
  };
  return { store, rows, controls };
}
const record = { kind: "card" as const, accountId: "default", scope: "scope", messageId: "42", expiresAt: 123 };

beforeEach(() => {
  for (const key of Object.keys(mocks.sdk)) delete mocks.sdk[key];
  Object.assign(mocks.sdk, { createPluginStateKeyedStoreV2: undefined, createPluginStateKeyedStore: undefined, createPluginStateSyncKeyedStore: undefined });
  mocks.runtime = {};
  vi.clearAllMocks();
  startDurableBindings();
});

describe.each([false, true])("durable binding factory V2=%s", v2 => {
  function setup() {
    const memory = fakeStore<DurableRecord>(v2);
    const create = vi.fn((_id: string, _options: unknown, authority?: StateAuthority) => {
      if (!v2) return memory.store;
      const view = { ...memory.store };
      view.observe = vi.fn(async key => { authority?.assertCurrent(); return memory.store.observe!(key); });
      view.compareAndApply = vi.fn(async (...args) => {
        memory.controls.beforeApply?.();
        try { authority?.assertCurrent(); } catch (cause) {
          if (memory.controls.wrapAuthorityErrors) throw new Error("Host admission refused", { cause });
          throw cause;
        }
        return memory.store.compareAndApply!(...args);
      });
      return view;
    });
    mocks.sdk[v2 ? "createPluginStateKeyedStoreV2" : "createPluginStateKeyedStore"] = create;
    if (v2) mocks.sdk.createPluginStateKeyedStore = vi.fn(() => { throw new Error("legacy factory selected"); });
    return { ...memory, create, bindings: new DurableBindings() };
  }
  it("claims, saves and deletes only its own generation using the selected factory", async () => {
    const { store, rows, create, bindings } = setup();
    const claimed = (await bindings.claim("k", record))!;
    expect(await bindings.save("k", { ...claimed, revision: 2 })).toBe(true);
    expect(await bindings.save("k", { ...claimed, generation: "stale" })).toBe(false);
    await bindings.remove("k", { ...claimed, generation: "stale" });
    expect(rows.get("k")?.revision).toBe(2);
    await bindings.remove("k", claimed);
    expect(rows.has("k")).toBe(false);
    expect(create).toHaveBeenCalledWith("zulip", expect.objectContaining({ namespace: "zulip.durable-bindings.v1", maxEntries: 40 }), ...(v2 ? [expect.objectContaining({ assertCurrent: expect.any(Function) })] : []));
    expect(store.update).toHaveBeenCalledTimes(v2 ? 0 : 3);
    expect(store.deleteIf).toHaveBeenCalledTimes(v2 ? 0 : 2);
  });
  it.each(v2 ? [false, true] : [false])("never commits a writer that is no longer current (wrapped=%s)", async wrapped => {
    const { rows, controls, bindings } = setup();
    let current = true;
    controls.wrapAuthorityErrors = wrapped;
    if (v2) controls.beforeApply = () => { current = false; };
    else current = false;
    expect(await bindings.claim("k", record, undefined, () => current)).toBeUndefined();
    expect(rows.size).toBe(0);
    controls.beforeApply = undefined;
    expect(await bindings.claim("k", record, undefined, () => true)).toBeDefined();
  });
  if (v2) it("retries conflicts and aborts when a competing generation wins", async () => {
    const { rows, controls, bindings } = setup();
    controls.conflicts = 1;
    const claimed = (await bindings.claim("k", record))!;
    controls.conflicts = 1;
    expect(await bindings.save("k", { ...claimed, revision: 3 })).toBe(true);
    controls.beforeApply = () => { rows.set("k", { ...claimed, generation: "winner" }); controls.beforeApply = undefined; };
    controls.conflicts = 1;
    expect(await bindings.claim("k", record, claimed.generation)).toBeUndefined();
    expect(await bindings.save("k", claimed)).toBe(false);
    await bindings.remove("k", claimed);
    expect(rows.get("k")?.generation).toBe("winner");
    rows.set("k", claimed);
    controls.conflicts = 1;
    await bindings.remove("k", claimed);
    expect(rows.has("k")).toBe(false);
  });
});

describe.each([false, true])("runtime stores V2=%s", v2 => {
  it("opens the reaction ledger and atomically deduplicates claims", async () => {
    const { store, rows, controls } = fakeStore<{ keys: string[] }>(v2);
    const open = vi.fn(() => store);
    const legacy = vi.fn(() => { throw new Error("unexpected legacy opener"); });
    const owner = v2 ? { openKeyedStoreV2: open, openKeyedStore: legacy } : { openKeyedStore: open };
    const ledger = openCompatibleKeyedStore<{ keys: string[] }>(owner, { namespace: "zulip.reaction-triggers.v1", maxEntries: 10 })!;
    if (v2) controls.conflicts = 1;
    expect(await claimReactionTrigger(ledger, "scope", "one")).toBe(true);
    expect(await claimReactionTrigger(ledger, "scope", "one")).toBe(false);
    expect(await claimReactionTrigger(ledger, "scope", "two")).toBe(true);
    expect(rows.get("scope")).toEqual({ keys: ["one", "two"] });
    expect(legacy).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledTimes(v2 ? 0 : 3);
    if (v2) {
      controls.conflicts = 1;
      controls.beforeApply = () => {
        rows.set("scope", { keys: ["one", "two", "winner"] });
        controls.beforeApply = undefined;
      };
      expect(await claimReactionTrigger(ledger, "scope", "winner")).toBe(false);
      controls.conflicts = 8;
      await expect(claimReactionTrigger(ledger, "scope", "three")).rejects.toThrow("retry limit");
      expect(rows.get("scope")?.keys).not.toContain("three");
    }
  });
  it("releases legacy ingress records without lost attempt increments and preserves TTL", async () => {
    const pending = fakeStore<any>(v2);
    const completed = fakeStore<any>(v2);
    const open = vi.fn((options: { namespace: string }) => options.namespace.includes(".pending.") ? pending.store : completed.store);
    mocks.runtime = { state: { [v2 ? "openKeyedStoreV2" : "openKeyedStore"]: open, openChannelIngressQueue: vi.fn() } };
    pending.rows.set("m", { id: "m", attempts: 1, receivedAt: 1, updatedAt: 1, payload: { message: {}, receivedAt: 1 } });
    const journal = createZulipDurableInboundReceiveJournal("default");
    if (v2) {
      pending.controls.conflicts = 1;
      pending.controls.beforeApply = () => {
        pending.rows.set("m", { ...pending.rows.get("m"), attempts: 4 });
        pending.controls.beforeApply = undefined;
      };
    }
    expect(await journal.release("m", { lastError: "retry", releasedAt: 20 })).toBe(true);
    expect(pending.rows.get("m")).toMatchObject({ attempts: v2 ? 5 : 2, updatedAt: 20, lastAttemptAt: 20, lastError: "retry" });
    expect(pending.store.update).toHaveBeenCalledTimes(v2 ? 0 : 1);
    if (v2) {
      expect(pending.store.compareAndApply).toHaveBeenLastCalledWith("m", expect.any(String), expect.objectContaining({ ttlMs: 30 * 86400_000 }));
      pending.controls.conflicts = 8;
      await expect(journal.release("m")).rejects.toThrow("retry limit");
      expect(pending.rows.get("m").attempts).toBe(5);
    }
    completed.rows.set("done", { id: "done", completedAt: 10 });
    expect(await journal.accept("done", { message: {}, receivedAt: 1 })).toMatchObject({ kind: "completed", duplicate: true });
    expect(open.mock.calls.map(([options]) => options.namespace)).toEqual([expect.stringMatching(/^inbound.v1.pending./), expect.stringMatching(/^inbound.v1.completed./)]);
  });
});

it("never retries an unknown write or falls back after a V2 failure", async () => {
  const { store } = fakeStore<number>(true);
  store.compareAndApply!.mockRejectedValue(new Error("unknown outcome"));
  await expect(updateKeyedStore(store, "k", () => 1)).rejects.toThrow("unknown outcome");
  expect(store.compareAndApply).toHaveBeenCalledTimes(1);
  expect(store.update).not.toHaveBeenCalled();
  store.compareAndApply!.mockClear();
  store.lookup.mockResolvedValue(1);
  store.observe!.mockResolvedValue({ value: 1, comparison: "1" });
  await expect(deleteKeyedStoreIf(store, "k", () => true)).rejects.toThrow("unknown outcome");
  expect(store.compareAndApply).toHaveBeenCalledTimes(1);
  expect(store.deleteIf).not.toHaveBeenCalled();
});

it("missing stores still disable optional durability", async () => {
  expect(await new DurableBindings().claim("k", record)).toBeUndefined();
  expect(openCompatibleKeyedStore(undefined, { namespace: "missing", maxEntries: 1 })).toBeUndefined();
  expect(() => createZulipDurableInboundReceiveJournal("default")).toThrow("not available");
});

it("does not turn an unknown claim outcome into a refusal after revocation", async () => {
  const { store } = fakeStore<DurableRecord>(true);
  let current = true;
  const unknown = new Error("unknown outcome");
  store.compareAndApply!.mockImplementation(async () => { current = false; throw unknown; });
  const bindings = new DurableBindings(async () => store);
  await expect(bindings.claim("k", record, undefined, () => current)).rejects.toBe(unknown);
  expect(store.compareAndApply).toHaveBeenCalledOnce();
  expect(store.update).not.toHaveBeenCalled();
});

it("retains the synchronous factory spelling on older hosts", async () => {
  const { store, rows } = fakeStore<DurableRecord>(false);
  mocks.sdk.createPluginStateSyncKeyedStore = vi.fn(() => store);
  const bindings = new DurableBindings();
  expect(await bindings.claim("k", record)).toBeDefined();
  expect(rows.get("k")?.messageId).toBe("42");
  expect(store.update).toHaveBeenCalledOnce();
});

it("retains the register fallback for old ingress stores without update", async () => {
  const { store, rows } = fakeStore<any>(false);
  rows.set("m", { id: "m", attempts: 2 });
  const { update: _update, ...oldStore } = store;
  mocks.runtime = { state: { openKeyedStore: () => oldStore, openChannelIngressQueue: vi.fn() } };
  const journal = createZulipDurableInboundReceiveJournal("default");
  expect(await journal.release("m", { releasedAt: 3 })).toBe(true);
  expect(rows.get("m")).toMatchObject({ attempts: 3, updatedAt: 3 });
  expect(store.register).toHaveBeenCalledWith("m", expect.any(Object), { ttlMs: 30 * 86400_000 });
});
