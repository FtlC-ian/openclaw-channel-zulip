import { createHash } from "node:crypto";
import { bindingScope, durableBindings, type DurableRecord } from "./durable-bindings.js";
import type { OpenClawPluginApi } from "../sdk.js";
import { editZulipMessage, sendZulipPrivateMessage, sendZulipStreamMessage, type ZulipClient } from "./client.js";

type Step = { step: string; status: "pending" | "in_progress" | "completed" };
type Update = { revision: number | null; text: string; floor?: number };
export type CardRoute = { accountId: string; client: ZulipClient; enabled: () => boolean; conversation: { kind: "dm"; recipient: string } | { kind: "stream"; stream: string; topic: string } };
type Card = { route: CardRoute; sessionKey: string; durable?: DurableRecord; floor: number; messageId?: string; hash?: string; calls: Set<string>; operation: Promise<void>; pending: Update[]; retry: number; timer?: ReturnType<typeof setTimeout> };

export function validateProgressCardEvent(event: { toolName: string; params: unknown; result?: unknown; error?: unknown }): Update | undefined {
  if (event.toolName !== "progress_card" || event.error != null || !event.params || typeof event.params !== "object" || Array.isArray(event.params)) return;
  const params = event.params as { markdown?: unknown; plan?: unknown };
  if (Object.keys(params).some(key => key !== "markdown" && key !== "plan")) return;
  if (params.markdown !== undefined && (typeof params.markdown !== "string" || Buffer.byteLength(params.markdown) > 8192)) return;
  if (params.plan !== undefined && (!Array.isArray(params.plan) || params.plan.length > 50)) return;
  const plan = (params.plan ?? []) as Step[];
  if (plan.some(item => !item || typeof item !== "object" || typeof item.step !== "string" || Buffer.byteLength(item.step) > 512 || !item.step.replace(/\p{Cf}/gu, "").trim() || !["pending", "in_progress", "completed"].includes(item.status) || Object.keys(item).some(key => key !== "step" && key !== "status")) || plan.filter(item => item.status === "in_progress").length > 1) return;
  // jsonResult's public tool envelope carries the canonical payload in details.
  const envelope = event.result as { details?: unknown } | undefined;
  const result = (envelope?.details ?? event.result) as { revision?: unknown; steps?: unknown } | undefined;
  if (!result || typeof result !== "object") return;
  const markdown = typeof params.markdown === "string" ? params.markdown.trim() : "";
  if (result.revision === null && result.steps === null) {
    if (!markdown && !plan.length) return { revision: null, text: "**Progress card** — cleared" };
    return;
  }
  if (typeof result.revision !== "number" || !Number.isSafeInteger(result.revision) || result.revision < 0) return;
  if (result.steps === null) { if (params.plan !== undefined) return; }
  else {
    const counts = result.steps as { completed?: unknown; total?: unknown } | undefined;
    if (!Array.isArray(params.plan) || !counts || counts.total !== plan.length || counts.completed !== plan.filter(item => item.status === "completed").length) return;
  }
  return { revision: result.revision, text: ["**Progress card**", markdown, plan.map(item => `${item.status === "completed" ? "✅" : item.status === "in_progress" ? "▶" : "◻"} ${item.step}`).join("\n")].filter(Boolean).join("\n\n") };
}

export class ZulipProgressCards {
  private readonly cards = new Map<string, Card>();
  bind(sessionKey: string, route: CardRoute): void {
    const existing = this.cards.get(sessionKey);
    // Default-off traffic must not consume the finite active-route budget.
    if (!route.enabled()) {
      if (existing?.route.accountId === route.accountId) { existing.route = route; existing.pending.length = 0; if (existing.timer) clearTimeout(existing.timer); this.cards.delete(sessionKey); }
      return;
    }
    if (existing) { if (existing.route.accountId === route.accountId) existing.route = route; return; }
    if (this.cards.size >= 1000) return;
    const card: Card = { route, sessionKey, floor: -1, calls: new Set(), operation: Promise.resolve(), pending: [], retry: 0 };
    this.cards.set(sessionKey, card);
    card.operation = this.recover(card).catch(() => undefined);
  }
  private async recover(card: Card): Promise<void> {
    const key = `card:${card.sessionKey}`;
    const record = await durableBindings.get(key);
    if (!record || record.kind !== "card" || record.accountId !== card.route.accountId || record.scope !== bindingScope(card.route.client) || record.expiresAt <= Date.now()) return;
    const claimed = await durableBindings.claim(key, record);
    if (!claimed) { card.pending.length = 0; if (this.cards.get(card.sessionKey) === card) this.cards.delete(card.sessionKey); return; }
    card.durable = claimed; card.messageId = record.messageId; card.hash = record.hash; card.floor = Math.max(card.floor, record.revision ?? -1);
  }
  async restore(route: Omit<CardRoute, "conversation">): Promise<void> {
    if (!route.enabled()) return;
    for (const { key, record } of await durableBindings.records(route.accountId, route.client)) {
      if (record.kind !== "card" || !record.sessionKey || !record.conversation) continue;
      if (record.expiresAt <= Date.now()) { await durableBindings.remove(key, record); continue; }
      this.bind(record.sessionKey, { ...route, conversation: record.conversation });
      await this.cards.get(record.sessionKey)?.operation;
    }
  }
  private async checkpoint(card: Card, floor: number): Promise<void> {
    if (!card.messageId) return;
    const key = `card:${card.sessionKey}`;
    const record = { kind: "card" as const, accountId: card.route.accountId, scope: bindingScope(card.route.client), messageId: card.messageId, sessionKey: card.sessionKey, revision: floor, hash: card.hash, conversation: card.route.conversation, expiresAt: Date.now() + 30 * 86400_000 };
    if (card.durable) { card.durable = { ...record, generation: card.durable.generation }; await durableBindings.save(key, card.durable); }
    else card.durable = await durableBindings.claim(key, record);
  }
  accept(event: { toolName: string; params: unknown; result?: unknown; error?: unknown; toolCallId?: string }, sessionKey?: string): void {
    const card = sessionKey ? this.cards.get(sessionKey) : undefined;
    const update = validateProgressCardEvent(event);
    if (!card || !card.route.enabled() || !update) return;
    // Hook completion arrival is execution order. Clears are not replayed and
    // retain the numeric floor, so they cannot admit stale numeric updates.
    if (event.toolCallId && card.calls.has(event.toolCallId)) return;
    if (update.revision !== null && update.revision <= card.floor) return;
    if (event.toolCallId) { card.calls.add(event.toolCallId); if (card.calls.size > 1000) card.calls.delete(card.calls.values().next().value!); }
    if (update.revision !== null) card.floor = update.revision;
    update.floor = card.floor;
    // Coalesce numeric bursts only; a clear is a visible ordering barrier.
    if (update.revision !== null && card.pending.at(-1)?.revision !== null && card.pending.length) card.pending[card.pending.length - 1] = update;
    else card.pending.push(update);
    if (!card.timer) card.timer = setTimeout(() => {
      card.timer = undefined;
      card.operation = card.operation.then(() => this.drain(card)).catch(() => undefined);
    }, 250);
  }
  private async flush(card: Card): Promise<void> {
    const update = card.pending.shift();
    if (!update || !card.route.enabled()) return;
    if (update.revision !== null && update.revision <= (card.durable?.revision ?? -1)) return;
    update.floor = Math.max(update.floor ?? -1, card.durable?.revision ?? -1);
    if (card.durable && !await durableBindings.current(`card:${card.sessionKey}`, card.durable)) return;
    const hash = createHash("sha256").update(update.text).digest("hex");
    if (hash === card.hash) { await this.checkpoint(card, update.floor ?? card.floor); return; }
    if (card.messageId) {
      try { await editZulipMessage(card.route.client, { messageId: card.messageId, content: update.text }); card.hash = hash; card.retry = 0; await this.checkpoint(card, update.floor ?? card.floor); return; }
      catch (error) {
        const err = error as { status?: number; retryAfterMs?: number; name?: string; message?: string };
        if (err.status === 429 || err.status === 408 || err.status === 425 || (err.status !== undefined && err.status >= 500) || err.retryAfterMs !== undefined || err.name === "TypeError" || /network|socket|timed? out|fetch failed/iu.test(err.message ?? "")) {
          // A retry never rotates an ambiguously failed edit; Retry-After is not capped.
          card.pending.unshift(update);
          if (!card.timer) card.timer = setTimeout(() => { card.timer = undefined; card.operation = card.operation.then(() => this.drain(card)).catch(() => undefined); }, Math.max(1000, err.retryAfterMs ?? 1000 * 2 ** Math.min(card.retry++, 6)));
          card.timer?.unref?.();
          return;
        }
        // Exactly one replacement send per change after a permanent edit failure.
        card.messageId = undefined;
      }
    }
    const conversation = card.route.conversation;
    const sent = conversation.kind === "dm"
      ? await sendZulipPrivateMessage(card.route.client, { to: conversation.recipient, content: update.text })
      : await sendZulipStreamMessage(card.route.client, { stream: conversation.stream, topic: conversation.topic, content: update.text });
    if (sent.id !== undefined) { card.messageId = String(sent.id); card.hash = hash; card.retry = 0; await this.checkpoint(card, update.floor ?? card.floor); }
  }
  private async drain(card: Card): Promise<void> {
    if (card.pending.length && !card.timer) await this.flush(card);
    if (card.pending.length && !card.timer) card.timer = setTimeout(() => { card.timer = undefined; card.operation = card.operation.then(() => this.drain(card)).catch(() => undefined); }, 250);
  }
  stop(): void {
    for (const card of this.cards.values()) { if (card.timer) clearTimeout(card.timer); card.pending.length = 0; }
    this.cards.clear();
  }
}
export const zulipProgressCards = new ZulipProgressCards();
export function registerZulipProgressCardHooks(api: OpenClawPluginApi): void {
  api.on("after_tool_call", (event, context) => { zulipProgressCards.accept(event, context.sessionKey); });
  api.on("gateway_stop", () => zulipProgressCards.stop());
}
