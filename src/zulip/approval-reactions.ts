import { createLazyRuntimeSurface } from "openclaw/plugin-sdk/lazy-runtime";
import { durableBindings, bindingScope, type DurableRecord } from "./durable-bindings.js";
import { resolveZulipApprovers, zulipApprovalAuth } from "../approval-auth.js";
import type { OpenClawConfig, ReplyPayload } from "../sdk.js";
import { isZulipAccountConfigured, listZulipAccountIds, resolveZulipAccount } from "./accounts.js";
import { createApprovalReactionTargetStore, listApprovalReactionBindings, readApprovalBinding, settleApprovalReaction, type ApprovalBindingMetadata, type ApprovalDecision } from "./approval-sdk.js";
import { addZulipReaction, deleteZulipMessage, removeZulipReaction, editZulipMessage, fetchZulipUser, type ZulipClient, type ZulipEvent } from "./client.js";
import { resolveZulipReactionSpec } from "./status-reactions.js";

type Binding = ApprovalBindingMetadata & {
  accountId: string; messageId: string; client: ZulipClient; sourceText: string;
  widgetMessageId?: string;
  durable?: DurableRecord;
  resolvingActor?: { id: string; name: string };
  seeding?: Promise<PromiseSettledResult<void>[]>;
  expiresAtMs: number; emojis: Map<string, ApprovalDecision>; resolving: boolean;
};
type Terminal = { outcome: string; actor?: string; elsewhere?: boolean };

function escapeStatusValue(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").replace(/@/gu, "@\u200b").replace(/[\\`*_\[\]<>~]/gu, "\\$&");
}

// Render user-controlled names as a code span so Zulip never linkifies or mentions them.
function inertStatusValue(value: string): string | undefined {
  const text = value.replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").replace(/`/gu, "\u02cb").trim();
  return text ? `\`${text}\`` : undefined;
}

function renderTerminal(entry: Binding, terminal: Terminal): string {
  const { outcome } = terminal;
  const status = outcome === "expired" ? "⌛ Expired"
    : outcome === "cancelled" ? "🚫 Cancelled"
    : outcome === "expired or already resolved" ? "⌛ Expired or already resolved"
    : terminal.elsewhere && !terminal.actor ? `Resolved elsewhere: ${escapeStatusValue(outcome)}`
    : outcome === "allow-once" ? "✅ Approved (allow once)"
    : outcome === "allow-always" ? "✅ Approved (allow always)"
    : outcome === "deny" ? "❌ Denied" : "Resolved";
  const actorText = terminal.actor && ["allow-once", "allow-always", "deny"].includes(outcome) ? inertStatusValue(terminal.actor) : undefined;
  const actor = actorText ? ` by ${actorText}` : "";
  // Retain only the command already displayed, never Gateway result metadata.
  const displayedCommand = entry.sourceText.match(/^(?:\*\*)?(?:Pending command|Command):(?:\*\*)?[ \t]*\n(?:[ \t]*\n)*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*(?:\n|$)/imu)?.[2]
    ?? entry.sourceText.match(/^(?:\*\*)?Command:(?:\*\*)?[ \t]*(\S[^\n]*)$/imu)?.[1];
  const command = displayedCommand?.replace(/^`(?!`)([\s\S]*?)(?<!`)`$/u, "$1");
  const fence = "`".repeat(Math.max(3, ...[...(command ?? "").matchAll(/`+/gu)].map(([run]) => run.length + 1)));
  return `${status}${actor}\n\nID: ${escapeStatusValue(entry.approvalId)}${command ? `\nCommand:\n${fence}\n${command}\n${fence}` : ""}`;
}
const TARGET_TTL_MS = 24 * 60 * 60 * 1000;
const loadResolver = createLazyRuntimeSurface(
  () => import("openclaw/plugin-sdk/approval-gateway-runtime"),
  (runtime) => runtime.resolveApprovalOverGateway,
);

// Strip identity-qualified leading mentions only, never mutable display names.
export function stripLeadingZulipApprovalBotMention(text: string, bot: { userId?: string; email?: string }): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^@_?\*\*([^*\n]+)\*\*\s+/u);
  if (!match) return trimmed;
  const identity = match[1].split("|").at(-1)!;
  if (identity !== bot.userId && (!bot.email || identity.toLowerCase() !== bot.email.toLowerCase())) return trimmed;
  return trimmed.slice(match[0].length);
}

export async function startZulipApprovalObserver(params: { cfg: OpenClawConfig; accountId: string; zulipClient?: ZulipClient; abortSignal?: AbortSignal; onError: (error: unknown) => void }): Promise<() => void> {
  if (!resolveZulipApprovers(params.cfg, params.accountId).length || params.abortSignal?.aborted) return () => {};
  const { createOperatorApprovalsGatewayClient, startGatewayClientWhenEventLoopReady } = await import("openclaw/plugin-sdk/gateway-runtime");
  const client = await createOperatorApprovalsGatewayClient({
    config: params.cfg, clientDisplayName: "Zulip approval terminal observer",
    onEvent: (event) => { void zulipApprovalReactions.observeTerminal(params.accountId, event).catch(params.onError); },
    onConnectError: params.onError,
    onHelloOk: () => {
      if (params.zulipClient) void zulipApprovalReactions.restore({ ...params, client: params.zulipClient, request: (method) => client.request(method, {}) }).catch(params.onError);
    },
  });
  const stop = () => { client.stop(); params.abortSignal?.removeEventListener("abort", stop); };
  params.abortSignal?.addEventListener("abort", stop, { once: true });
  try {
    if (params.abortSignal?.aborted) stop();
    else await startGatewayClientWhenEventLoopReady(client, { signal: params.abortSignal });
  } catch (error) { stop(); throw error; }
  return stop;
}

export function resolveZulipApprovalReactionControls(
  allowedDecisions: readonly ApprovalDecision[],
  config?: { approve?: string; deny?: string },
) {
  const allowed = new Set(listApprovalReactionBindings({ allowedDecisions }).map((binding: { decision: ApprovalDecision }) => binding.decision));
  const controls = [
    { emoji: config?.approve ?? "✅", decision: "allow-once" as const, label: "Allow once" },
    { emoji: config?.deny ?? "❌", decision: "deny" as const, label: "Deny" },
  ].filter(({ decision }) => allowed.has(decision))
    .map((control) => ({ ...control, spec: resolveZulipReactionSpec(control.emoji) }));
  return new Set(controls.map(({ spec }) => spec.emojiName)).size === controls.length ? controls : [];
}

export class ZulipApprovalReactions {
  private readonly bindings = new Map<string, Binding>();
  private readonly terminals = new Map<string, Terminal & { expiresAtMs: number }>();
  private readonly targets;
  constructor(private readonly maxEntries = 1000) {
    this.targets = createApprovalReactionTargetStore({
      namespace: "zulip.approval-reactions", maxEntries, defaultTtlMs: TARGET_TTL_MS,
    }) as {
      register: (key: string, target: Binding) => Promise<void>;
      lookup: (key: string) => Promise<Binding | null>;
      delete: (key: string) => Promise<void>;
    };
  }
  private key(accountId: string, id: string): string { return JSON.stringify([accountId, id]); }
  private prune(): void {
    const now = Date.now();
    for (const [key, terminal] of this.terminals) if (terminal.expiresAtMs <= now) this.terminals.delete(key);
    for (const [key, binding] of this.bindings) if (binding.expiresAtMs <= now) {
      this.bindings.delete(key);
      void this.targets.delete(key);
    }
  }
  private retire(accountId: string, id: string): Binding[] {
    const entries = [...this.bindings.entries()].filter(([, binding]) => binding.accountId === accountId && binding.approvalId === id);
    for (const [key] of entries) { this.bindings.delete(key); void this.targets.delete(key); }
    return entries.map(([, binding]) => binding);
  }
  clearAccount(accountId: string): void {
    for (const key of this.terminals.keys()) if (JSON.parse(key)[0] === accountId) this.terminals.delete(key);
    for (const [key, binding] of this.bindings) if (binding.accountId === accountId) {
      this.bindings.delete(key); void this.targets.delete(key);
    }
  }
  async register(params: { cfg: OpenClawConfig; accountId: string; messageId: string; widgetMessageId?: string; client: ZulipClient; sourceText: string; payload: Pick<ReplyPayload, "channelData" | "presentation"> }): Promise<void> {
    this.prune();
    const metadata = readApprovalBinding({ payload: params.payload });
    if (!metadata || !params.messageId || params.messageId === "unknown" || resolveZulipApprovers(params.cfg, params.accountId).length === 0) return;
    const key = this.key(params.accountId, params.messageId);
    if (this.bindings.has(key) || this.bindings.size >= this.maxEntries) return;
    const config = resolveZulipAccount({ cfg: params.cfg, accountId: params.accountId }).config.approvalReactions;
    const specs = resolveZulipApprovalReactionControls(metadata.allowedDecisions, config);
    const binding: Binding = { ...metadata, accountId: params.accountId, messageId: params.messageId, widgetMessageId: params.widgetMessageId, client: params.client, sourceText: params.sourceText, expiresAtMs: Date.now() + TARGET_TTL_MS, resolving: false, emojis: new Map(specs.map(({ spec, decision }) => [spec.emojiName, decision])) };
    this.bindings.set(key, binding);
    binding.durable = await durableBindings.claim(`approval:${key}`, { kind: "approval", accountId: binding.accountId, scope: bindingScope(binding.client), messageId: binding.messageId, companionId: binding.widgetMessageId, id: binding.approvalId, approvalKind: binding.approvalKind, decisions: binding.allowedDecisions, emojis: [...binding.emojis], expiresAt: binding.expiresAtMs });
    await this.targets.register(key, binding);
    const terminal = this.terminals.get(JSON.stringify([params.accountId, metadata.approvalKind, metadata.approvalId]));
    if (terminal) {
      await this.finish(this.retire(params.accountId, metadata.approvalId), terminal);
      return;
    }
    binding.seeding = Promise.allSettled(specs.map(({ spec }) => addZulipReaction(params.client, { messageId: params.messageId, ...spec })));
    await binding.seeding;
  }
  async restore(params: { cfg: OpenClawConfig; accountId: string; client: ZulipClient; request: (method: string) => Promise<unknown> }): Promise<void> {
    const records = (await durableBindings.records(params.accountId, params.client)).filter(({ record }) => record.kind === "approval");
    if (!records.length) return;
    const pending = new Map<string, Set<string>>();
    for (const kind of new Set(records.map(({ record }) => record.approvalKind!))) {
      const list = await params.request(`${kind}.approval.list`);
      if (!Array.isArray(list)) throw new Error("Invalid public approval replay list");
      pending.set(kind, new Set(list.map(entry => entry.id)));
    }
    for (const { key, record } of records) {
      if (!record.id || !record.approvalKind || !record.decisions || !record.emojis) continue;
      const bindingKey = this.key(params.accountId, record.messageId);
      if (this.bindings.has(bindingKey)) continue;
      const claimed = await durableBindings.claim(key, record);
      if (!claimed) continue;
      const binding: Binding = { approvalId: record.id, approvalKind: record.approvalKind, allowedDecisions: record.decisions as ApprovalDecision[], accountId: params.accountId, messageId: record.messageId, widgetMessageId: record.companionId, client: params.client, sourceText: "", expiresAtMs: record.expiresAt, emojis: new Map(record.emojis as [string, ApprovalDecision][]), resolving: false, durable: claimed };
      if (record.expiresAt <= Date.now() || !pending.get(record.approvalKind)?.has(record.id)) {
        // Pending lists deliberately do not expose resolved command content.
        await this.finish([binding], { outcome: record.expiresAt <= Date.now() ? "expired" : "expired or already resolved" });
        continue;
      }
      this.bindings.set(bindingKey, binding); await this.targets.register(bindingKey, binding);
    }
  }
  async react(params: { abortSignal?: AbortSignal; getConfig?: () => OpenClawConfig; cfg: OpenClawConfig; accountId: string; botUserId: string; event: ZulipEvent; client: ZulipClient }): Promise<void> {
    this.prune();
    const { event } = params;
    if (event.type !== "reaction" || event.op !== "add" || !event.user_id || String(event.user_id) === params.botUserId || event.reaction_type !== "unicode_emoji" && event.reaction_type !== "realm_emoji") return;
    const binding = await this.targets.lookup(this.key(params.accountId, String(event.message_id)));
    const decision = binding?.emojis.get(event.emoji_name ?? "");
    if (!binding || !decision || binding.resolving) return;
    const user = await fetchZulipUser(params.client, String(event.user_id));
    if (params.abortSignal?.aborted || !user.email || user.is_bot || user.is_active === false) return;
    await this.decide({ ...params, cfg: params.getConfig?.() ?? params.cfg, binding, senderId: user.email, senderName: user.full_name ?? undefined, decision });
  }
  async command(params: { abortSignal?: AbortSignal; getConfig?: () => OpenClawConfig; cfg: OpenClawConfig; accountId: string; senderId: string; senderName?: string; text: string; botUserId?: string; botEmail?: string }): Promise<boolean> {
    this.prune();
    const match = stripLeadingZulipApprovalBotMention(params.text, { userId: params.botUserId, email: params.botEmail }).match(/^\/approve\s+(\S+)\s+(allow-once|allow-always|deny)$/u);
    if (!match) return false;
    const binding = [...this.bindings.values()].find((value) => value.accountId === params.accountId && value.approvalId === match[1]);
    if (!binding) return false;
    if (params.abortSignal?.aborted) return true;
    await this.decide({ ...params, cfg: params.getConfig?.() ?? params.cfg, binding, decision: match[2] as ApprovalDecision });
    return true;
  }
  async observeTerminal(accountId: string, event: { event: string; payload?: unknown }): Promise<void> {
    this.prune();
    const kind = event.event === "exec.approval.resolved" ? "exec" : event.event === "plugin.approval.resolved" ? "plugin" : undefined;
    const payload = event.payload as { id?: unknown; decision?: unknown; terminalStatus?: unknown; resolvedBy?: unknown } | undefined;
    if (!kind || typeof payload?.id !== "string") return;
    const outcome = payload.terminalStatus === "expired" || payload.terminalStatus === "cancelled" ? payload.terminalStatus : payload.decision;
    if (outcome !== "expired" && outcome !== "cancelled" && outcome !== "allow-once" && outcome !== "allow-always" && outcome !== "deny") return;
    const key = JSON.stringify([accountId, kind, payload.id]);
    if (this.terminals.has(key)) return;
    const actorId = typeof payload.resolvedBy === "string" ? payload.resolvedBy.trim() || undefined : undefined;
    const knownActor = [...this.bindings.values()].find((entry) => entry.accountId === accountId && entry.approvalId === payload.id && entry.approvalKind === kind && entry.resolvingActor?.id === actorId)?.resolvingActor;
    const terminal: Terminal = { outcome, actor: knownActor?.name || actorId, elsewhere: true };
    this.terminals.set(key, { ...terminal, expiresAtMs: Date.now() + TARGET_TTL_MS });
    while (this.terminals.size > this.maxEntries) this.terminals.delete(this.terminals.keys().next().value!);
    if (![...this.bindings.values()].some((entry) => entry.accountId === accountId && entry.approvalId === payload.id && entry.approvalKind === kind)) return;
    await this.finish(this.retire(accountId, payload.id), terminal);
  }
  private async finish(entries: Binding[], terminal: Terminal): Promise<void> {
    // Zulip widgets are immutable. Edit the prompt, delete its companion zform,
    // and remove bot-seeded reactions independently even if an API call fails.
    await Promise.all(entries.map((entry) => entry.seeding));
    const operations = entries.flatMap((entry) => [
      editZulipMessage(entry.client, { messageId: entry.messageId, content: renderTerminal(entry, terminal) }),
      ...(entry.widgetMessageId ? [deleteZulipMessage(entry.client, { messageId: entry.widgetMessageId })] : []),
      ...[...entry.emojis.keys()].map((emojiName) => removeZulipReaction(entry.client, { messageId: entry.messageId, emojiName })),
    ]);
    const results = await Promise.allSettled(operations);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    await Promise.all(entries.map(entry => entry.durable ? durableBindings.remove(`approval:${this.key(entry.accountId, entry.messageId)}`, entry.durable) : Promise.resolve()));
  }
  private canSettle(params: { cfg: OpenClawConfig; accountId: string; senderId: string; binding: Binding; abortSignal?: AbortSignal }): boolean {
    const { binding, cfg, accountId } = params;
    const account = resolveZulipAccount({ cfg, accountId });
    return !params.abortSignal?.aborted
      && this.bindings.get(this.key(binding.accountId, binding.messageId)) === binding
      && binding.expiresAtMs > Date.now()
      && listZulipAccountIds(cfg).includes(accountId)
      && account.enabled
      && isZulipAccountConfigured(account)
      && resolveZulipApprovers(cfg, accountId).length > 0
      && zulipApprovalAuth.authorizeActorAction({ cfg, accountId, senderId: params.senderId, approvalKind: binding.approvalKind, action: "approve" }).authorized;
  }
  private async decide(params: { abortSignal?: AbortSignal; getConfig?: () => OpenClawConfig; cfg: OpenClawConfig; accountId: string; senderId: string; senderName?: string; binding: Binding; decision: ApprovalDecision }): Promise<void> {
    const { binding } = params;
    if (binding.resolving || !binding.allowedDecisions.includes(params.decision) || !this.canSettle(params)) return;
    const siblings = [...this.bindings.values()].filter((entry) => entry.accountId === binding.accountId && entry.approvalId === binding.approvalId);
    if (siblings.some((entry) => entry.resolving)) return;
    for (const entry of siblings) {
      entry.resolving = true;
      entry.resolvingActor = { id: params.senderId, name: params.senderName?.trim() || params.senderId };
    }
    try {
      let terminal: Terminal = { outcome: "resolved" };
      let retired: Binding[] = [];
      const status = await settleApprovalReaction({
        request: { cfg: params.cfg, channel: "zulip", accountId: params.accountId, senderId: params.senderId, approvalId: binding.approvalId, approvalKind: binding.approvalKind, decision: params.decision },
        approvers: resolveZulipApprovers(params.cfg, params.accountId),
        authorizeActorAction: zulipApprovalAuth.authorizeActorAction,
        loadResolver: async () => {
          const resolve = await loadResolver();
          return async (request) => {
            const cfg = params.getConfig?.() ?? params.cfg;
            if (binding.durable && !await durableBindings.current(`approval:${this.key(binding.accountId, binding.messageId)}`, binding.durable)) throw new Error("Stale Zulip approval generation");
            if (!this.canSettle({ ...params, cfg })) {
              throw new Error("Zulip approval authorization changed before settlement");
            }
            return resolve({ ...request, cfg });
          };
        },
        clearTarget: () => { retired = this.retire(binding.accountId, binding.approvalId); },
        onResolved: (result) => {
          const resolver = result.approval.resolver;
          terminal = {
            outcome: "decision" in result.approval ? result.approval.decision : result.approval.status,
            actor: result.applied ? params.senderName?.trim() || params.senderId : resolver?.kind === "channel" ? resolver.id : undefined,
            elsewhere: !result.applied,
          };
        },
      });
      if (status !== "denied") {
        if (status === "not-found") terminal = { outcome: "expired or already resolved" };
        await this.finish(retired, terminal);
      }
    } finally {
      for (const entry of siblings) {
        entry.resolving = false;
        entry.resolvingActor = undefined;
      }
    }
  }
}
export const zulipApprovalReactions = new ZulipApprovalReactions();
