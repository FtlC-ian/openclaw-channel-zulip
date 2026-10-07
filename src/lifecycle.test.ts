import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./sdk.js";
import type { MonitorZulipOpts } from "./zulip/monitor.js";
import { runZulipAccount, stopZulipAccount, zulipLifecycle } from "./lifecycle.js";

const monitor = vi.hoisted(() => ({
  starts: [] as MonitorZulipOpts[],
  active: 0,
  maxActive: 0,
  deleted: 0,
  drain: undefined as Promise<void> | undefined,
  clear: vi.fn(),
}));
vi.mock("./zulip/monitor.js", () => ({
  clearZulipAccountMonitorCaches: monitor.clear,
  monitorZulipProvider: vi.fn(async (opts: MonitorZulipOpts) => {
    monitor.starts.push(opts);
    monitor.active++;
    monitor.maxActive = Math.max(monitor.maxActive, monitor.active);
    try {
      await new Promise<void>((resolve) => {
        if (opts.abortSignal?.aborted) resolve();
        else opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await monitor.drain;
    } finally {
      monitor.active--;
      monitor.deleted++;
    }
  }),
}));

const config = (patch: Record<string, unknown> = {}): OpenClawConfig => ({
  channels: { zulip: {
    url: "https://zulip.example", email: "bot@example.org", apiKey: "test-key",
    streams: ["engineering"], ...patch,
  } },
});
const change = async (prevCfg: OpenClawConfig, nextCfg: OpenClawConfig) => {
  await zulipLifecycle.onAccountConfigChanged!({ prevCfg, nextCfg, accountId: "default", runtime: {} });
};
const start = async (cfg = config()) => {
  const controller = new AbortController();
  const done = runZulipAccount({ config: cfg, accountId: "default", abortSignal: controller.signal });
  await vi.waitFor(() => expect(monitor.active).toBe(1));
  return { controller, done };
};

afterEach(async () => {
  await stopZulipAccount("default");
  monitor.starts = [];
  monitor.active = monitor.maxActive = monitor.deleted = 0;
  monitor.drain = undefined;
  monitor.clear.mockClear();
});

describe("Zulip account lifecycle", () => {
  it("serializes changed credentials and streams, deduplicating repeated notifications", async () => {
    const { done } = await start();
    const credential = config({ apiKey: "new-key" });
    await Promise.all([change(config(), credential), change(config(), credential)]);
    await vi.waitFor(() => expect(monitor.starts).toHaveLength(2));
    const streams = config({ apiKey: "new-key", streams: ["operations"] });
    await change(credential, streams);
    await vi.waitFor(() => expect(monitor.starts).toHaveLength(3));
    expect(monitor.deleted).toBe(2);
    expect(monitor.active).toBe(1);
    expect(monitor.maxActive).toBe(1);
    expect(monitor.starts[2].config).toBe(streams);
    await stopZulipAccount("default");
    await done;
    expect(monitor.deleted).toBe(3);
  });

  it("updates next-message settings without replacing the event queue", async () => {
    await start();
    const next = config({ name: "Renamed", dmPolicy: "open", streaming: { mode: "off" },
      streamOverrides: { engineering: { enabled: true, excludedTopics: ["noise"] } },
      markHandledRead: true });
    await change(config(), next);
    expect(monitor.starts).toHaveLength(1);
    expect(monitor.starts[0].getConfig!()).toBe(next);
    expect(monitor.starts[0].abortSignal!.aborted).toBe(false);
  });

  it("refreshes when enabled stream overrides expand the registered selection", async () => {
    await start();
    await change(config(), config({ streamOverrides: { operations: { enabled: true } } }));
    await vi.waitFor(() => expect(monitor.starts).toHaveLength(2));
    expect(monitor.maxActive).toBe(1);
  });

  it("drains accepted work before replacement without aborting its reply signal", async () => {
    await start();
    let release!: () => void;
    monitor.drain = new Promise<void>((resolve) => { release = resolve; });
    const refreshing = change(config(), config({ url: "https://new.example" }));
    await vi.waitFor(() => expect(monitor.starts[0].abortSignal!.aborted).toBe(true));
    expect(monitor.starts[0].messageAbortSignal!.aborted).toBe(false);
    expect(monitor.starts).toHaveLength(1);
    release();
    await refreshing;
    await vi.waitFor(() => expect(monitor.starts).toHaveLength(2));
    expect(monitor.maxActive).toBe(1);
  });

  it("removal cancels both signals, waits for teardown, and clears account caches idempotently", async () => {
    const { done } = await start();
    await zulipLifecycle.onAccountRemoved!({ prevCfg: config(), accountId: "default", runtime: {} });
    await done;
    expect(monitor.active).toBe(0);
    expect(monitor.deleted).toBe(1);
    expect(monitor.starts[0].abortSignal!.aborted).toBe(true);
    expect(monitor.starts[0].messageAbortSignal!.aborted).toBe(true);
    expect(monitor.clear).toHaveBeenLastCalledWith("default", true);
    await zulipLifecycle.onAccountRemoved!({ prevCfg: config(), accountId: "default", runtime: {} });
    expect(monitor.deleted).toBe(1);
    await change(config(), config({ apiKey: "changed" }));
    expect(monitor.starts).toHaveLength(1);
  });

  it("does not resurrect an account when core stops during refresh", async () => {
    const { controller, done } = await start();
    let release!: () => void;
    monitor.drain = new Promise<void>((resolve) => { release = resolve; });
    const refreshing = change(config(), config({ email: "new@example.org" }));
    await vi.waitFor(() => expect(monitor.starts[0].abortSignal!.aborted).toBe(true));
    controller.abort();
    release();
    await refreshing;
    await done;
    expect(monitor.starts).toHaveLength(1);
    expect(monitor.active).toBe(0);
  });

  it("serializes simultaneous core starts and stops cleanly on disable", async () => {
    const first = runZulipAccount({ config: config(), accountId: "default", abortSignal: new AbortController().signal });
    const second = runZulipAccount({ config: config(), accountId: "default", abortSignal: new AbortController().signal });
    await vi.waitFor(() => expect(monitor.starts).toHaveLength(2));
    await first;
    expect(monitor.maxActive).toBe(1);
    await change(config(), config({ enabled: false }));
    await second;
    expect(monitor.active).toBe(0);
    expect(monitor.deleted).toBe(2);
  });
});
