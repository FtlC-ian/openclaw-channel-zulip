import { describe, it, expect, vi } from "vitest";
import { validateProgressCardEvent, ZulipProgressCards } from "./progress-card.js";
import { createZulipClient } from "./client.js";
import { durableBindings, bindingScope, type DurableRecord } from "./durable-bindings.js";
const event = (revision: number | null, markdown = "Working") => ({ toolName: "progress_card", params: { markdown }, result: { details: { revision, steps: null } } });
describe("progress card trust boundary", () => {
  it("renders account-specific active emoji, preserves other markers and dedupes unchanged text", async () => {
    vi.useFakeTimers();
    const calls: { method?: string; content: string; topic: string | null }[] = [];
    const client = createZulipClient({ baseUrl: "https://zulip.test", email: "bot@test", apiKey: "key", fetchImpl: async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      calls.push({ method: init?.method, content: body.get("content")!, topic: body.get("topic") });
      return new Response(JSON.stringify({ result: "success", id: calls.length + 40 }));
    } });
    const cards = new ZulipProgressCards();
    let activeEmoji: string | undefined = "dark-waiting";
    const planEvent = (revision: number) => ({ toolName: "progress_card", params: { plan: [
      { step: "Done", status: "completed" }, { step: "Working", status: "in_progress" }, { step: "Next", status: "pending" },
    ] }, result: { details: { revision, steps: { completed: 1, total: 3 } } } });
    try {
      cards.bind("animated", { accountId: "animated", client, enabled: () => true, activeEmoji: () => activeEmoji, conversation: { kind: "stream", stream: "18", topic: "animated" } });
      cards.bind("default", { accountId: "default", client, enabled: () => true, conversation: { kind: "stream", stream: "18", topic: "default" } });
      cards.accept(planEvent(1), "animated"); cards.accept(planEvent(1), "default");
      await vi.advanceTimersByTimeAsync(300);
      expect(calls.find(call => call.topic === "animated")?.content).toBe("**Progress card**\n\n✅ Done\n:dark-waiting: Working\n◻ Next");
      expect(calls.find(call => call.topic === "default")?.content).toBe("**Progress card**\n\n✅ Done\n▶ Working\n◻ Next");
      cards.accept(planEvent(2), "animated"); await vi.advanceTimersByTimeAsync(300);
      expect(calls).toHaveLength(2);
      activeEmoji = undefined;
      cards.accept(planEvent(3), "animated"); await vi.advanceTimersByTimeAsync(300);
      expect(calls).toHaveLength(3); expect(calls[2].method).toBe("PATCH");
      expect(calls[2].content).toBe("**Progress card**\n\n✅ Done\n▶ Working\n◻ Next");
      cards.accept(planEvent(4), "animated"); await vi.advanceTimersByTimeAsync(300);
      expect(calls).toHaveLength(3);
    } finally { cards.stop(); vi.useRealTimers(); }
  });
  it("honors a POST Retry-After without an early transport retry", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetchImpl = vi.fn(async () => ++attempts === 1 ? new Response(JSON.stringify({ result: "error" }), { status: 429, headers: { "Retry-After": "5" } }) : new Response(JSON.stringify({ result: "success", id: 42 })));
    const client = createZulipClient({ baseUrl: "https://zulip.test", email: "bot@test", apiKey: "test", fetchImpl });
    const cards = new ZulipProgressCards();
    try {
      cards.bind("one", { accountId: "default", client, enabled: () => true, conversation: { kind: "stream", stream: "18", topic: "one" } });
      cards.accept(event(1), "one"); await vi.advanceTimersByTimeAsync(300);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4900); expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100); expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally { cards.stop(); vi.useRealTimers(); }
  });
  it("rotates exactly once after a permanent edit failure and skips unchanged text", async () => {
    vi.useFakeTimers();
    const calls: { url: string; method?: string }[] = [];
    const client = createZulipClient({ baseUrl: "https://zulip.test", email: "bot@test", apiKey: "test", fetchImpl: async (url, init) => { calls.push({ url: String(url), method: init?.method }); return init?.method === "PATCH" ? new Response(JSON.stringify({ result: "error" }), { status: 403 }) : new Response(JSON.stringify({ result: "success", id: calls.length === 1 ? 42 : 99 })); } });
    const cards = new ZulipProgressCards();
    try {
      cards.bind("one", { accountId: "default", client, enabled: () => true, conversation: { kind: "stream", stream: "18", topic: "one" } });
      cards.accept(event(1), "one"); await vi.advanceTimersByTimeAsync(300);
      cards.accept(event(2, "Changed"), "one"); await vi.advanceTimersByTimeAsync(300);
      expect(calls.map(call => call.method)).toEqual(["POST", "PATCH", "POST"]);
      cards.accept(event(3, "Changed"), "one"); await vi.advanceTimersByTimeAsync(300);
      expect(calls).toHaveLength(3);
    } finally { cards.stop(); vi.useRealTimers(); }
  });
  it("fences a retired off-on recovery and edits the persisted card with its revision floor", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: "success", id: 99 })));
    const client = createZulipClient({ baseUrl: "https://zulip.test", email: "bot@test", apiKey: "test", fetchImpl });
    const record: DurableRecord = { kind: "card", accountId: "default", scope: bindingScope(client), generation: "old", messageId: "42", sessionKey: "one", revision: 5, expiresAt: Date.now() + 60000 };
    let releaseRetired!: () => void;
    let entered!: () => void; const claiming = new Promise<void>(resolve => { entered = resolve; });
    let claims = 0;
    const spies = [vi.spyOn(durableBindings, "get").mockResolvedValue(record), vi.spyOn(durableBindings, "claim").mockImplementation(async (_key, value, _generation, isCurrent) => {
      if (++claims === 1) { entered(); await new Promise<void>(resolve => { releaseRetired = resolve; }); }
      return isCurrent?.() ? { ...value, generation: "new" } : undefined;
    }), vi.spyOn(durableBindings, "current").mockResolvedValue(true), vi.spyOn(durableBindings, "save").mockResolvedValue(true)];
    const cards = new ZulipProgressCards();
    const route = { accountId: "default", client, enabled: () => true, conversation: { kind: "stream" as const, stream: "18", topic: "one" } };
    try {
      cards.bind("one", route); await claiming;
      cards.bind("one", { ...route, enabled: () => false });
      cards.bind("one", route);
      releaseRetired();
      cards.accept(event(4), "one"); await vi.advanceTimersByTimeAsync(300);
      expect(fetchImpl).not.toHaveBeenCalled();
      cards.accept(event(6, "After restart"), "one"); await vi.advanceTimersByTimeAsync(300);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0][0])).toContain("/messages/42");
      expect(fetchImpl.mock.calls[0][1]?.method).toBe("PATCH");
    } finally { cards.stop(); for (const spy of spies) spy.mockRestore(); vi.useRealTimers(); }
  });
  it("does not let default-off traffic exhaust enabled conversation routes", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: "success", id: 42 })));
      const client = createZulipClient({ baseUrl: "https://zulip.test", email: "bot@test", apiKey: "test", fetchImpl });
      const cards = new ZulipProgressCards();
      for (let i = 0; i < 1000; i++) cards.bind(`off-${i}`, { accountId: "default", client, enabled: () => false, conversation: { kind: "stream", stream: "18", topic: String(i) } });
      cards.bind("enabled", { accountId: "default", client, enabled: () => true, conversation: { kind: "stream", stream: "18", topic: "enabled" } });
      cards.accept(event(1), "enabled"); await vi.advanceTimersByTimeAsync(300);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("rejects impostors, errors and count mismatches", () => {
    expect(validateProgressCardEvent({ ...event(1), toolName: "mcp_progress_card" })).toBeUndefined();
    expect(validateProgressCardEvent({ ...event(1), error: "failed" })).toBeUndefined();
    expect(validateProgressCardEvent({ ...event(1), params: { plan: [{ step: "test", status: "completed" }] }, result: { revision: 1, steps: { completed: 0, total: 1 } } })).toBeUndefined();
    expect(validateProgressCardEvent(event(null))).toBeUndefined();
  });
  it("renders validated plans and clear", () => {
    expect(validateProgressCardEvent(event(null, ""))?.text).toContain("cleared");
    expect(validateProgressCardEvent({ toolName: "progress_card", params: { plan: [{ step: "test", status: "completed" }] }, result: { revision: 1, steps: { completed: 1, total: 1 } } })?.text).toContain("✅ test");
  });
  it("coalesces, edits in place, isolates sessions and retains the floor after clear", async () => {
    vi.useFakeTimers();
    try {
      const calls: { method?: string; body: string }[] = [];
      const client = createZulipClient({ baseUrl: "https://zulip.test", email: "bot@test", apiKey: "test", fetchImpl: async (_url, init) => { calls.push({ method: init?.method, body: String(init?.body) }); return new Response(JSON.stringify({ result: "success", id: 42 })); } });
      const cards = new ZulipProgressCards();
      cards.bind("one", { accountId: "default", client, enabled: () => true, conversation: { kind: "stream", stream: "18", topic: "one" } });
      cards.accept(event(1), "unbound");
      cards.accept(event(1), "one"); cards.accept(event(2, "Updated"), "one");
      await vi.advanceTimersByTimeAsync(300);
      expect(calls).toHaveLength(1); expect(calls[0].body).toContain("Updated");
      cards.accept(event(null, ""), "one"); await vi.advanceTimersByTimeAsync(300);
      cards.accept(event(1), "one"); await vi.advanceTimersByTimeAsync(300);
      expect(calls).toHaveLength(2); expect(calls[1].method).toBe("PATCH"); expect(calls[1].body).toContain("cleared");
    } finally { vi.useRealTimers(); }
  });
});
