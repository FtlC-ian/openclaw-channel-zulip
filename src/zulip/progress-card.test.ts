import { describe, it, expect, vi } from "vitest";
import { validateProgressCardEvent, ZulipProgressCards } from "./progress-card.js";
import { createZulipClient } from "./client.js";
const event = (revision: number | null, markdown = "Working") => ({ toolName: "progress_card", params: { markdown }, result: { details: { revision, steps: null } } });
describe("progress card trust boundary", () => {
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
