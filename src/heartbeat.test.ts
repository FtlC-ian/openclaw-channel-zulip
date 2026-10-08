import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./sdk.js";
import { zulipHeartbeat as heartbeat } from "./heartbeat.js";
import { createZulipClient, getZulipEventsWithRetry } from "./zulip/client.js";
import { ZulipConnection } from "./zulip/connection.js";

const cfg: OpenClawConfig = { channels: { zulip: { url: "https://zulip.test", email: "bot@test", apiKey: "fixture", accounts: {
  default: {},
  other: { url: "https://other.test", email: "other@test", apiKey: "other-fixture" },
} } } };
const connections: ZulipConnection[] = [];
function setup(accountId = "default") {
  let current = cfg;
  const controller = new AbortController();
  const wire: Array<{ url: string; body: URLSearchParams }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    wire.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? "")) });
    return Response.json({ result: "success", members: [{ user_id: 7, email: "person@test" }], subscriptions: [{ stream_id: 42, name: "Engineering" }] });
  });
  const client = createZulipClient({ baseUrl: accountId === "default" ? "https://zulip.test" : "https://other.test", email: "bot@test", apiKey: "fixture", fetchImpl });
  const connection = new ZulipConnection(accountId, client, () => current, controller.signal);
  connections.push(connection);
  connection.polling = true;
  return { connection, controller, wire, fetchImpl, client, setConfig: (next: OpenClawConfig) => { current = next; },
    typing: () => wire.filter(call => call.url.endsWith("/typing")).map(call => Object.fromEntries(call.body)) };
}
const params = (to = "stream:42:Topic 🧪") => ({ cfg, to });
afterEach(async () => {
  await Promise.all(connections.splice(0).map(connection => connection.close()));
  vi.useRealTimers();
});

describe("Zulip heartbeat transport", () => {
  it("readiness follows registration, poll health, identity, removal, abort and replacement generations", async () => {
    expect((await heartbeat.checkReady!({ cfg })).ok).toBe(false);
    const first = setup();
    first.connection.polling = false;
    expect((await heartbeat.checkReady!({ cfg })).ok).toBe(false);
    first.connection.polling = true;
    expect((await heartbeat.checkReady!({ cfg })).ok).toBe(true);
    expect((await heartbeat.checkReady!({ cfg, accountId: "other" })).ok).toBe(false);
    first.setConfig({ channels: { zulip: { ...cfg.channels!.zulip!, apiKey: "replacement" } } });
    expect((await heartbeat.checkReady!({ cfg })).ok).toBe(false);
    first.setConfig({ channels: { zulip: { ...cfg.channels!.zulip!, enabled: false } } });
    expect((await heartbeat.checkReady!({ cfg })).ok).toBe(false);
    first.setConfig({});
    expect((await heartbeat.checkReady!({ cfg })).ok).toBe(false);
    first.setConfig(cfg);
    first.controller.abort();
    expect((await heartbeat.checkReady!({ cfg })).ok).toBe(false);
    const next = setup();
    await first.connection.close();
    expect((await heartbeat.checkReady!({ cfg })).ok).toBe(true);
    await next.connection.close();
    expect((await heartbeat.checkReady!({ cfg })).ok).toBe(false);
  });

  it("marks the real event transport unhealthy during retry and healthy after recovery", async () => {
    const subject = setup();
    const health: boolean[] = [];
    subject.fetchImpl.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await getZulipEventsWithRetry(subject.client, { queueId: "queue", lastEventId: 0, retryBaseDelayMs: 1,
      onHealthChanged: value => { health.push(value); subject.connection.polling = value; } });
    expect(health).toEqual([true, false, true]);
    expect((await heartbeat.checkReady!({ cfg })).ok).toBe(true);
    subject.fetchImpl.mockResolvedValueOnce(Response.json({ result: "error", code: "BAD_EVENT_QUEUE_ID" }));
    await getZulipEventsWithRetry(subject.client, { queueId: "queue", lastEventId: 0,
      onHealthChanged: value => { subject.connection.polling = value; } });
    expect((await heartbeat.checkReady!({ cfg })).ok).toBe(false);
  });

  it.each(["stream:42: Topic 🧪 / é ", "stream:Engineering: Topic 🧪 / é "])("starts and stops the exact stream/topic for %s", async to => {
    const subject = setup();
    await heartbeat.sendTyping!(params(to));
    subject.connection.polling = false;
    await heartbeat.clearTyping!(params(to));
    expect(subject.typing()).toEqual([
      { op: "start", type: "stream", stream_id: "42", topic: " Topic 🧪 / é " },
      { op: "stop", type: "stream", stream_id: "42", topic: " Topic 🧪 / é " },
    ]);
  });

  it("uses the destination model's thread override and default topic", async () => {
    const subject = setup();
    await heartbeat.sendTyping!({ ...params("stream:42"), threadId: "Unicode 🚀" });
    await heartbeat.clearTyping!({ ...params("stream:42"), threadId: "Unicode 🚀" });
    expect(subject.typing().map(call => call.topic)).toEqual(["Unicode 🚀", "Unicode 🚀"]);
    await heartbeat.sendTyping!(params("stream:42"));
    expect(subject.typing().at(-1)?.topic).toBe("general");
  });

  it("resolves a DM once, caches its route, and never crosses accounts", async () => {
    const first = setup();
    const other = setup("other");
    const target = { ...params("user:person@test"), accountId: "other" };
    await heartbeat.sendTyping!(target);
    await heartbeat.sendTyping!(target);
    await heartbeat.clearTyping!(params("user:person@test"));
    expect(first.wire).toHaveLength(0);
    expect(other.typing()).toEqual([{ op: "start", type: "direct", to: "[7]" }]);
    await heartbeat.clearTyping!(target);
    expect(other.typing()).toEqual([{ op: "start", type: "direct", to: "[7]" }, { op: "stop", type: "direct", to: "[7]" }]);
    expect(other.wire.filter(call => call.url.endsWith("/users"))).toHaveLength(1);
    expect(other.wire.every(call => call.url.startsWith("https://other.test/"))).toBe(true);
  });

  it("rejects unknown DM recipients instead of typing to an unintended user", async () => {
    const subject = setup();
    await expect(heartbeat.sendTyping!(params("user:missing@test"))).rejects.toThrow("recipient not found");
    expect(subject.typing()).toHaveLength(0);
  });

  it("guards both sides of an async destination lookup", async () => {
    const subject = setup();
    let allowed = true;
    const guard = () => { if (!allowed) throw new Error("revoked"); };
    subject.fetchImpl.mockImplementationOnce(async () => { allowed = false; return Response.json({ result: "success", members: [{ user_id: 7, email: "person@test" }] }); });
    await expect(heartbeat.sendTypingGuarded!({ ...params("user:person@test"), signal: new AbortController().signal, assertPlatformSendAuthorized: guard })).rejects.toThrow("revoked");
    expect(subject.typing()).toHaveLength(0);
  });

  it("cancels a blocked lookup, and pre-aborted calls do not touch the network", async () => {
    const subject = setup();
    const controller = new AbortController();
    subject.fetchImpl.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = heartbeat.sendTypingGuarded!({ ...params("user:person@test"), signal: controller.signal, assertPlatformSendAuthorized: () => {} });
    await vi.waitFor(() => expect(subject.fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toThrow();
    await expect(heartbeat.sendTypingGuarded!({ ...params(), signal: controller.signal, assertPlatformSendAuthorized: () => {} })).rejects.toThrow();
    expect(subject.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("clear during destination lookup seals that pending start", async () => {
    const subject = setup();
    let finish!: (response: Response) => void;
    subject.fetchImpl.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    const pending = heartbeat.sendTyping!(params("user:person@test"));
    await vi.waitFor(() => expect(subject.fetchImpl).toHaveBeenCalledTimes(1));
    await heartbeat.clearTyping!(params("user:person@test"));
    finish(Response.json({ result: "success", members: [{ user_id: 7, email: "person@test" }] }));
    await pending;
    expect(subject.typing()).toHaveLength(0);
  });

  it("cancellation after a late start settles sends a compensating stop", async () => {
    const subject = setup();
    const controller = new AbortController();
    let finish!: (response: Response) => void;
    subject.fetchImpl.mockImplementationOnce(async (url, init) => {
      subject.wire.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
      return new Promise(resolve => { finish = resolve; });
    });
    const pending = heartbeat.sendTypingGuarded!({ ...params(), signal: controller.signal, assertPlatformSendAuthorized: () => {} });
    await vi.waitFor(() => expect(subject.typing()).toHaveLength(1));
    controller.abort();
    finish(Response.json({ result: "success" }));
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(subject.typing().map(call => call.op)).toEqual(["start", "stop"]));
  });

  it("core never duplicates, clears or bypasses an inbound monitor owner", async () => {
    const subject = setup();
    const owner = subject.connection.claimMonitor({ type: "stream", streamId: 42, topic: "Topic 🧪" });
    await heartbeat.sendTyping!(params());
    expect(subject.typing()).toHaveLength(0);
    await owner.start();
    await heartbeat.sendTyping!(params());
    await heartbeat.clearTyping!(params());
    expect(subject.typing().map(call => call.op)).toEqual(["start"]);
    await owner.stop();
    await heartbeat.sendTyping!(params());
    expect(subject.typing().map(call => call.op)).toEqual(["start", "stop"]);
    await owner.close();
    await owner.start();
    expect(subject.typing().map(call => call.op)).toEqual(["start", "stop"]);
  });

  it("monitor admission retires an existing core indicator even when its typing mode never starts", async () => {
    const subject = setup();
    await heartbeat.sendTyping!(params());
    const owner = subject.connection.claimMonitor({ type: "stream", streamId: 42, topic: "Topic 🧪" });
    await vi.waitFor(() => expect(subject.typing().map(call => call.op)).toEqual(["start", "stop"]));
    await heartbeat.sendTyping!(params());
    await owner.close();
    expect(subject.typing().map(call => call.op)).toEqual(["start", "stop"]);
  });

  it("coalesces monitor owners while isolating topics and stops only the last active owner", async () => {
    const subject = setup();
    const target = { type: "stream" as const, streamId: 42, topic: "A" };
    const a = subject.connection.claimMonitor(target);
    await a.start();
    const b = subject.connection.claimMonitor(target);
    const c = subject.connection.claimMonitor({ ...target, topic: "B" });
    await Promise.all([b.start(), c.start()]);
    expect(subject.typing().filter(call => call.op === "start").map(call => call.topic).sort()).toEqual(["A", "B"]);
    await a.close();
    expect(subject.typing().filter(call => call.op === "stop")).toHaveLength(0);
    await b.close();
    await c.close();
    expect(subject.typing().filter(call => call.op === "stop").map(call => call.topic).sort()).toEqual(["A", "B"]);
  });

  it("unref'ed idle expiry bounds legacy calls", async () => {
    vi.useFakeTimers();
    const subject = setup();
    await heartbeat.sendTyping!(params());
    await vi.advanceTimersByTimeAsync(12000);
    expect(subject.typing().map(call => call.op)).toEqual(["start", "stop"]);
  });

  it("abort stops this generation's indicator without tearing down another account", async () => {
    const subject = setup();
    const other = setup("other");
    await heartbeat.sendTyping!(params());
    await heartbeat.sendTyping!({ ...params(), accountId: "other" });
    subject.controller.abort();
    await subject.connection.close();
    expect(subject.typing().map(call => call.op)).toEqual(["start", "stop"]);
    expect(other.typing().map(call => call.op)).toEqual(["start"]);
    expect((await heartbeat.checkReady!({ cfg, accountId: "other" })).ok).toBe(true);
  });
});
