import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "../sdk.js";
import { editZulipMessage, sendZulipPrivateMessage, sendZulipStreamMessage, type ZulipClient } from "./client.js";

type Step = { step: string; status: "pending" | "in_progress" | "completed" };
type Update = { revision: number | null; text: string };
export type CardRoute = { accountId: string; client: ZulipClient; enabled: () => boolean; conversation: { kind: "dm"; recipient: string } | { kind: "stream"; stream: string; topic: string } };
type Card = { route: CardRoute; floor: number; messageId?: string; hash?: string; calls: Set<string>; operation: Promise<void>; pending?: Update; timer?: ReturnType<typeof setTimeout> };

export function validateProgressCardEvent(event: { toolName: string; params: unknown; result?: unknown; error?: unknown }): Update | undefined {
  if (event.toolName !== "progress_card" || event.error != null || !event.params || typeof event.params !== "object" || Array.isArray(event.params)) return;
  const params = event.params as { markdown?: unknown; plan?: unknown };
  if (Object.keys(params).some(key => key !== "markdown" && key !== "plan")) return;
  if (params.markdown !== undefined && (typeof params.markdown !== "string" || Buffer.byteLength(params.markdown) > 8192)) return;
  if (params.plan !== undefined && (!Array.isArray(params.plan) || params.plan.length > 50)) return;
  const plan = (params.plan ?? []) as Step[];
  if (plan.some(item => !item || typeof item !== "object" || typeof item.step !== "string" || !item.step.trim() || !["pending", "in_progress", "completed"].includes(item.status) || Object.keys(item).some(key => key !== "step" && key !== "status")) || plan.filter(item => item.status === "in_progress").length > 1) return;
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
    if (existing) { if (existing.route.accountId === route.accountId) existing.route = route; return; }
    this.cards.set(sessionKey, { route, floor: -1, calls: new Set(), operation: Promise.resolve() });
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
    card.pending = update;
    if (!card.timer) card.timer = setTimeout(() => {
      card.timer = undefined;
      card.operation = card.operation.then(() => this.flush(card)).catch(() => undefined);
    }, 250);
  }
  private async flush(card: Card): Promise<void> {
    const update = card.pending; card.pending = undefined;
    if (!update || !card.route.enabled()) return;
    const hash = createHash("sha256").update(update.text).digest("hex");
    if (hash === card.hash) return;
    if (card.messageId) {
      try { await editZulipMessage(card.route.client, { messageId: card.messageId, content: update.text }); card.hash = hash; return; }
      catch (error) {
        const err = error as { status?: number; retryAfterMs?: number };
        if (!err.status || err.status === 429 || err.status === 408 || err.status >= 500) {
          // A retry never rotates an ambiguously failed edit; Retry-After is not capped.
          if (!card.pending) card.pending = update;
          if (!card.timer) card.timer = setTimeout(() => { card.timer = undefined; card.operation = card.operation.then(() => this.flush(card)).catch(() => undefined); }, Math.max(1000, err.retryAfterMs ?? 1000));
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
    if (sent.id !== undefined) { card.messageId = String(sent.id); card.hash = hash; }
  }
}
export const zulipProgressCards = new ZulipProgressCards();
export function registerZulipProgressCardHooks(api: OpenClawPluginApi): void {
  api.on("after_tool_call", (event, context) => { zulipProgressCards.accept(event, context.sessionKey); });
}
