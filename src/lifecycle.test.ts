import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./sdk.js";
import type { MonitorZulipOpts } from "./zulip/monitor.js";
import { runZulipAccount, stopZulipAccount, zulipLifecycle } from "./lifecycle.js";
import { zulipDirectory } from "./directory.js";

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
beforeEach(() => {
  vi.stubEnv("ZULIP_API_KEY", undefined);
  vi.stubEnv("ZULIP_EMAIL", undefined);
  vi.stubEnv("ZULIP_URL", undefined);
});
afterEach(async () => {
  await stopZulipAccount("default");
  monitor.starts = [];
  monitor.active = monitor.maxActive = monitor.deleted = 0;
  monitor.drain = undefined;
  monitor.clear.mockClear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Zulip lifecycle with committed core reload ownership", () => {
  it("committed teardown evicts directory loads refilled during drain from both runtime snapshots", async () => {
    const original = config();
    let committed = original;
    const fetch = vi.fn(async () => Response.json({ result: "success", email: "bot@example.org", full_name: "Before" }));
    vi.stubGlobal("fetch", fetch);
    const self = (cfg: OpenClawConfig) => zulipDirectory.self!({ cfg, runtime: {}, accountId: "default" });
    const previous = await start(() => committed);
    await self(original);
    let release!: () => void;
    monitor.drain = new Promise<void>((resolve) => { release = resolve; });
    previous.controller.abort();
    await self(original);
    const retained = config();
    committed = retained;
    await self(retained);
    expect(fetch).toHaveBeenCalledTimes(2);
    release();
    await previous.done;
    fetch.mockImplementation(async () => Response.json({ result: "success", email: "bot@example.org", full_name: "After" }));
    expect((await self(original))?.name).toBe("After");
    expect((await self(retained))?.name).toBe("After");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

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
    expect(monitor.starts[0].abortSignal!.aborted).toBe(false);
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

  it("cancels work and joins teardown before committed core replacement can register", async () => {
    let committed = config();
    const previous = await start(() => committed);
    let release!: () => void;
    monitor.drain = new Promise<void>((resolve) => { release = resolve; });
    committed = config({ url: "https://new.example" });
    previous.controller.abort();
    expect(monitor.starts[0].abortSignal!.aborted).toBe(true);
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

  it("committed removal cancels account work and cleans caches idempotently", async () => {
    let committed = config();
    const previous = await start(() => committed);
    committed = {};
    await remove();
    await previous.done;
    expect(monitor.active).toBe(0);
    expect(monitor.starts[0].abortSignal!.aborted).toBe(true);
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
    expect(monitor.starts[1].abortSignal!.aborted).toBe(true);
  });

  it("preserves the supported environment-only default account without a channel section", async () => {
    vi.stubEnv("ZULIP_API_KEY", ["fixture", "environment"].join("-"));
    vi.stubEnv("ZULIP_EMAIL", "bot@example.org");
    vi.stubEnv("ZULIP_URL", "https://zulip.example");
    const previous = await start(() => ({}));
    expect(monitor.starts).toHaveLength(1);
    previous.controller.abort();
    await previous.done;
    expect(monitor.deleted).toBe(1);
  });

});
