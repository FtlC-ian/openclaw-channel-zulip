import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./sdk.js";
import type { MonitorZulipOpts } from "./zulip/monitor.js";
import { runZulipAccount, stopZulipAccount, zulipLifecycle } from "./lifecycle.js";

const monitor = vi.hoisted(() => ({
  starts: [] as MonitorZulipOpts[], active: 0, maxActive: 0, deleted: 0,
  drain: undefined as Promise<void> | undefined, clear: vi.fn(),
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
    } finally { monitor.active--; monitor.deleted++; }
  }),
}));
const config = (patch: Record<string, unknown> = {}): OpenClawConfig => ({
  channels: { zulip: { url: "https://zulip.example", email: "bot@example.org", apiKey: ["fixture", "original"].join("-"), streams: ["engineering"], ...patch } },
});
const change = (prevCfg: OpenClawConfig, nextCfg: OpenClawConfig) =>
  zulipLifecycle.onAccountConfigChanged!({ prevCfg, nextCfg, accountId: "default", runtime: {} });
const remove = () => zulipLifecycle.onAccountRemoved!({ prevCfg: config(), accountId: "default", runtime: {} });
const start = async (getConfig: () => OpenClawConfig = () => config()) => {
  const controller = new AbortController();
  const done = runZulipAccount({ config: getConfig(), getConfig, accountId: "default", abortSignal: controller.signal });
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

describe("Zulip lifecycle with committed core reload ownership", () => {
  it("does not replace live credentials when a pre-persistence write fails", async () => {
    const committed = config();
    await start(() => committed);
    await change(committed, config({ apiKey: ["fixture", "replacement"].join("-") }));
    expect(monitor.starts).toHaveLength(1);
    expect(monitor.starts[0].abortSignal!.aborted).toBe(false);
    expect(monitor.starts[0].getConfig!()).toBe(committed);
    expect(monitor.clear).toHaveBeenLastCalledWith("default");
  });

  it("does not stop a still-configured account when removal persistence fails", async () => {
    await start();
    await remove();
    expect(monitor.active).toBe(1);
    expect(monitor.starts[0].messageAbortSignal!.aborted).toBe(false);
    expect(monitor.clear).toHaveBeenLastCalledWith("default");
  });

  it("composes repeated hooks with one committed core replacement, without duplicate queues", async () => {
    let committed = config();
    const previous = await start(() => committed);
    const next = config({ apiKey: ["fixture", "original"].join("-"), streams: ["operations"] });
    await change(committed, next);
    await change(committed, next);
    expect(monitor.starts).toHaveLength(1);
    committed = next;
    previous.controller.abort();
    await previous.done;
    const replacement = await start(() => committed);
    expect(monitor.starts).toHaveLength(2);
    expect(monitor.deleted).toBe(1);
    expect(monitor.maxActive).toBe(1);
    replacement.controller.abort();
    await replacement.done;
    expect(monitor.deleted).toBe(2);
  });

  it("reads committed dynamic settings through the production runtime-getter boundary without restart", async () => {
    let committed = config();
    await start(() => committed);
    const next = config({ dmPolicy: "open", streaming: { mode: "off" }, markHandledRead: true });
    monitor.clear.mockClear();
    await change(committed, next);
    expect(monitor.clear).not.toHaveBeenCalled();
    expect(monitor.starts[0].getConfig!()).toBe(committed);
    committed = next;
    expect(monitor.starts[0].getConfig!()).toBe(next);
    expect(monitor.starts).toHaveLength(1);
  });

  it("drains accepted work on committed transport reload before core can register replacement", async () => {
    let committed = config();
    const previous = await start(() => committed);
    let release!: () => void;
    monitor.drain = new Promise<void>((resolve) => { release = resolve; });
    committed = config({ url: "https://new.example" });
    previous.controller.abort();
    expect(monitor.starts[0].messageAbortSignal!.aborted).toBe(false);
    const replacement = runZulipAccount({ config: committed, getConfig: () => committed, accountId: "default", abortSignal: new AbortController().signal });
    await Promise.resolve();
    expect(monitor.starts).toHaveLength(1);
    release();
    await previous.done;
    await vi.waitFor(() => expect(monitor.starts).toHaveLength(2));
    expect(monitor.maxActive).toBe(1);
    await stopZulipAccount("default");
    await replacement;
  });

  it("committed removal cancels both signals and cleans caches idempotently", async () => {
    let committed = config();
    const previous = await start(() => committed);
    committed = {};
    await remove();
    await previous.done;
    expect(monitor.active).toBe(0);
    expect(monitor.starts[0].abortSignal!.aborted).toBe(true);
    expect(monitor.starts[0].messageAbortSignal!.aborted).toBe(true);
    expect(monitor.clear).toHaveBeenLastCalledWith("default", true);
    await remove();
    expect(monitor.deleted).toBe(1);
  });

  it("rejects a start queued concurrently with committed removal instead of resurrecting it", async () => {
    let committed = config();
    const previous = await start(() => committed);
    let release!: () => void;
    monitor.drain = new Promise<void>((resolve) => { release = resolve; });
    const stale = committed;
    committed = {};
    const removing = remove();
    const queued = runZulipAccount({ config: stale, getConfig: () => committed, accountId: "default", abortSignal: new AbortController().signal });
    release();
    await Promise.all([removing, queued, previous.done]);
    expect(monitor.starts).toHaveLength(1);
    expect(monitor.active).toBe(0);
  });

  it("serializes simultaneous starts and core disable cancels message work", async () => {
    let committed = config();
    const first = runZulipAccount({ config: committed, getConfig: () => committed, accountId: "default", abortSignal: new AbortController().signal });
    const controller = new AbortController();
    const second = runZulipAccount({ config: committed, getConfig: () => committed, accountId: "default", abortSignal: controller.signal });
    await vi.waitFor(() => expect(monitor.starts).toHaveLength(2));
    await first;
    committed = config({ enabled: false });
    controller.abort();
    await second;
    expect(monitor.maxActive).toBe(1);
    expect(monitor.active).toBe(0);
    expect(monitor.starts[1].messageAbortSignal!.aborted).toBe(true);
  });
  it("a repeated core stop cancels a transport drain even though its poll signal already aborted", async () => {
    let committed = config();
    const previous = await start(() => committed);
    let release!: () => void;
    monitor.drain = new Promise<void>((resolve) => { release = resolve; });
    committed = config({ url: "https://replacement.example" });
    previous.controller.abort();
    const reloading = stopZulipAccount("default", true);
    expect(monitor.starts[0].messageAbortSignal!.aborted).toBe(false);
    const shuttingDown = stopZulipAccount("default", true);
    expect(monitor.starts[0].messageAbortSignal!.aborted).toBe(true);
    release();
    await Promise.all([reloading, shuttingDown, previous.done]);
    expect(monitor.deleted).toBe(1);
  });

});
