import { it, expect } from "vitest";
import { DurableBindings, bindingScope, type DurableRecord } from "./durable-bindings.js";
import { createZulipClient } from "./client.js";
it("restart claims invalidate old writes and cleanup, without losing the card mapping", async () => {
  const rows = new Map<string, DurableRecord>();
  const store = { lookup: async (key: string) => rows.get(key), entries: async () => [...rows].map(([key, value]) => ({ key, value })), update: async (key: string, fn: (record: DurableRecord | undefined) => DurableRecord | undefined) => { const next = fn(rows.get(key)); if (!next) return false; rows.set(key, next); return true; }, deleteIf: async (key: string, fn: (record: DurableRecord) => boolean) => { const record = rows.get(key); return !!record && fn(record) && rows.delete(key); } };
  const client = createZulipClient({ baseUrl: "https://zulip.test", email: "bot@test", apiKey: "secret" });
  const oldProcess = new DurableBindings(async () => store);
  const original = (await oldProcess.claim("card:session", { kind: "card", accountId: "default", scope: bindingScope(client), messageId: "42", sessionKey: "session", revision: 7, expiresAt: Date.now() + 1000 }))!;
  const restarted = new DurableBindings(async () => store);
  const replay = await restarted.records("default", client);
  const current = (await restarted.claim(replay[0].key, replay[0].record))!;
  expect(current.messageId).toBe("42"); expect(current.revision).toBe(7);
  expect(await oldProcess.save("card:session", { ...original, revision: 99 })).toBe(false);
  await oldProcess.remove("card:session", original);
  expect(await restarted.current("card:session", current)).toBe(true);
  expect(await oldProcess.current("card:session", original)).toBe(false);
  expect(await oldProcess.claim("card:session", current, current.generation, () => false)).toBeUndefined();
  expect(await restarted.current("card:session", current)).toBe(true);
  expect(await restarted.records("other", client)).toEqual([]);
  expect(JSON.stringify([...rows.values()])).not.toContain("secret");
});
it("missing optional state capability safely disables persistence", async () => {
  const bindings = new DurableBindings(async () => undefined);
  expect(await bindings.claim("draft", { kind: "draft", accountId: "default", scope: "hash", messageId: "42", expiresAt: 1 })).toBeUndefined();
});
