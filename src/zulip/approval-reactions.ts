import { doesApprovalRequestSelectChannelAccount } from "openclaw/plugin-sdk/approval-native-runtime";
import { listZulipAccountIds } from "./accounts.js";
import { createExecApprovalChannelRuntime } from "openclaw/plugin-sdk/infra-runtime";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { resolveZulipApprovers, zulipApprovalAuth } from "../approval-auth.js";
import type { OpenClawConfig, ReplyPayload } from "../sdk.js";
import { isZulipAccountConfigured, resolveZulipAccount } from "./accounts.js";
import { readApprovalBinding, settleApprovalReaction, type ApprovalBindingMetadata, type ApprovalDecision } from "./approval-sdk.js";
import { addZulipReaction, editZulipMessage, fetchZulipUser, type ZulipClient, type ZulipEvent } from "./client.js";
import { resolveZulipReactionSpec } from "./status-reactions.js";

type Binding = ApprovalBindingMetadata & {
  accountId: string; messageId: string; client: ZulipClient; sourceText: string;
  expiresAtMs: number; emojis: Map<string, ApprovalDecision>; resolving: boolean;
};
type Observed = { expiresAtMs: number; kind: "exec" | "plugin"; terminal?: string };

export class ZulipApprovalReactions {
  private readonly bindings = new Map<string, Binding>();
  private readonly observed = new Map<string, Observed>();
  constructor(private readonly maxEntries = 1000) {}
  private key(accountId: string, id: string): string { return JSON.stringify([accountId, id]); }
  private prune(): void {
    const now = Date.now();
    for (const [key, binding] of this.bindings) if (binding.expiresAtMs <= now) this.bindings.delete(key);
    for (const [key, request] of this.observed) if (request.expiresAtMs <= now) this.observed.delete(key);
  }
  canObserve(): boolean { this.prune(); return this.observed.size < this.maxEntries; }
  observe(accountId: string, id: string, kind: "exec" | "plugin", expiresAtMs: number): boolean {
    this.prune();
    const key = this.key(accountId, id);
    if (this.observed.has(key)) return true;
    if (this.observed.size >= this.maxEntries || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;
    this.observed.set(key, { kind, expiresAtMs });
    return true;
  }
  async terminalize(accountId: string, id: string, outcome: string): Promise<void> {
    const request = this.observed.get(this.key(accountId, id));
    if (request) request.terminal = outcome;
    const entries = [...this.bindings.entries()].filter(([, binding]) => binding.accountId === accountId && binding.approvalId === id);
    for (const [key] of entries) this.bindings.delete(key);
    await Promise.all(entries.map(async ([, binding]) => {
      await editZulipMessage(binding.client, { messageId: binding.messageId, content: `${binding.sourceText}\n\n**Approval outcome: ${outcome}**\nThese controls are no longer active.` });
    }));
  }
  clearAccount(accountId: string): void {
    for (const [key, binding] of this.bindings) if (binding.accountId === accountId) this.bindings.delete(key);
    for (const key of this.observed.keys()) if ((JSON.parse(key) as string[])[0] === accountId) this.observed.delete(key);
  }
  async register(params: { cfg: OpenClawConfig; accountId: string; messageId: string; client: ZulipClient; sourceText: string; payload: Pick<ReplyPayload, "channelData" | "presentation"> }): Promise<void> {
    this.prune();
    const metadata = readApprovalBinding({ payload: params.payload });
    if (!metadata || !params.messageId || params.messageId === "unknown" || resolveZulipApprovers(params.cfg, params.accountId).length === 0) return;
    const request = this.observed.get(this.key(params.accountId, metadata.approvalId));
    // Only a canonical gateway request supplies authoritative ownership and expiry.
    if (!request || request.kind !== metadata.approvalKind || request.expiresAtMs <= Date.now()) return;
    if (request.terminal) {
      await editZulipMessage(params.client, { messageId: params.messageId, content: `${params.sourceText}\n\n**Approval outcome: ${request.terminal}**\nThese controls are no longer active.` });
      return;
    }
    const key = this.key(params.accountId, params.messageId);
    if (this.bindings.has(key) || this.bindings.size >= this.maxEntries) return;
    const config = resolveZulipAccount({ cfg: params.cfg, accountId: params.accountId }).config.approvalReactions;
    const specs = [
      { spec: resolveZulipReactionSpec(config?.approve ?? "✅"), decision: "allow-once" as const },
      { spec: resolveZulipReactionSpec(config?.deny ?? "❌"), decision: "deny" as const },
    ].filter(({ decision }) => metadata.allowedDecisions.includes(decision));
    if (new Set(specs.map(({ spec }) => spec.emojiName)).size !== specs.length) return;
    this.bindings.set(key, { ...metadata, accountId: params.accountId, messageId: params.messageId, client: params.client, sourceText: params.sourceText, expiresAtMs: request.expiresAtMs, resolving: false, emojis: new Map(specs.map(({ spec, decision }) => [spec.emojiName, decision])) });
    await Promise.allSettled(specs.map(({ spec }) => addZulipReaction(params.client, { messageId: params.messageId, ...spec })));
  }
  async react(params: { abortSignal?: AbortSignal; getConfig?: () => OpenClawConfig; cfg: OpenClawConfig; accountId: string; botUserId: string; event: ZulipEvent; client: ZulipClient }): Promise<void> {
    this.prune();
    const { event } = params;
    if (event.type !== "reaction" || event.op !== "add" || !event.user_id || String(event.user_id) === params.botUserId || event.reaction_type !== "unicode_emoji" && event.reaction_type !== "realm_emoji") return;
    const binding = this.bindings.get(this.key(params.accountId, String(event.message_id)));
    const decision = binding?.emojis.get(event.emoji_name ?? "");
    if (!binding || !decision || binding.resolving) return;
    const user = await fetchZulipUser(params.client, String(event.user_id));
    if (params.abortSignal?.aborted || !user.email || user.is_bot || user.is_active === false) return;
    await this.decide({ ...params, cfg: params.getConfig?.() ?? params.cfg, binding, senderId: user.email, decision });
  }
  async command(params: { cfg: OpenClawConfig; accountId: string; senderId: string; text: string }): Promise<boolean> {
    this.prune();
    const match = params.text.trim().match(/^\/approve\s+(\S+)\s+(allow-once|allow-always|deny)$/u);
    if (!match) return false;
    const binding = [...this.bindings.values()].find((value) => value.accountId === params.accountId && value.approvalId === match[1]);
    if (!binding) return false;
    await this.decide({ ...params, binding, decision: match[2] as ApprovalDecision });
    return true;
  }
  private async decide(params: { cfg: OpenClawConfig; accountId: string; senderId: string; binding: Binding; decision: ApprovalDecision }): Promise<void> {
    const { binding } = params;
    const account = resolveZulipAccount({ cfg: params.cfg, accountId: params.accountId });
    if (!listZulipAccountIds(params.cfg).includes(params.accountId) || !account.enabled || !isZulipAccountConfigured(account)) return;
    if (this.bindings.get(this.key(binding.accountId, binding.messageId)) !== binding || binding.resolving || binding.expiresAtMs <= Date.now() || !binding.allowedDecisions.includes(params.decision)) return;
    if (resolveZulipApprovers(params.cfg, params.accountId).length === 0 || !zulipApprovalAuth.authorizeActorAction({ ...params, approvalKind: binding.approvalKind, action: "approve" }).authorized) return;
    const siblings = [...this.bindings.values()].filter((entry) => entry.accountId === binding.accountId && entry.approvalId === binding.approvalId);
    if (siblings.some((entry) => entry.resolving)) return;
    for (const entry of siblings) entry.resolving = true;
    try {
      let outcome = "resolved";
      const status = await settleApprovalReaction({
        request: { cfg: params.cfg, channel: "zulip", accountId: params.accountId, senderId: params.senderId, approvalId: binding.approvalId, approvalKind: binding.approvalKind, decision: params.decision },
        approvers: resolveZulipApprovers(params.cfg, params.accountId),
        authorizeActorAction: zulipApprovalAuth.authorizeActorAction,
        loadResolver: async () => resolveApprovalOverGateway,
        clearTarget: () => {},
        onResolved: (result) => { outcome = "decision" in result.approval ? result.approval.decision : result.approval.status; },
      });
      if (status !== "denied") await this.terminalize(binding.accountId, binding.approvalId, status === "not-found" ? "expired or already resolved" : outcome);
    } finally {
      for (const entry of siblings) entry.resolving = false;
    }
  }
}
export const zulipApprovalReactions = new ZulipApprovalReactions();
export function createZulipApprovalObserver(getConfig: () => OpenClawConfig, accountId: string) {
  return createExecApprovalChannelRuntime<string>({
    cfg: getConfig(), label: "zulip", clientDisplayName: "Zulip approval reactions", eventKinds: ["exec", "plugin"],
    isConfigured: () => resolveZulipApprovers(getConfig(), accountId).length > 0,
    shouldHandle: (request) => resolveZulipApprovers(getConfig(), accountId).length > 0 && zulipApprovalReactions.canObserve() && doesApprovalRequestSelectChannelAccount({
      cfg: getConfig(), request, channel: "zulip", accountId, defaultAccountId: "default",
      eligibleAccountIds: listZulipAccountIds(getConfig()).filter((id) => resolveZulipApprovers(getConfig(), id).length > 0),
    }),
    deliverRequested: async (request) => {
      if (request.approvalKind !== "exec" && request.approvalKind !== "plugin") return [];
      return zulipApprovalReactions.observe(accountId, request.id, request.approvalKind, request.expiresAtMs) ? [request.id] : [];
    },
    finalizeResolved: async ({ resolved }) => { await zulipApprovalReactions.terminalize(accountId, resolved.id, resolved.decision); },
    finalizeExpired: async ({ request }) => { await zulipApprovalReactions.terminalize(accountId, request.id, "expired"); },
    onStopped: () => zulipApprovalReactions.clearAccount(accountId),
  });
}
