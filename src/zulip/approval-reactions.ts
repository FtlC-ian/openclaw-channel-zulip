import { createLazyRuntimeSurface } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveZulipApprovers, zulipApprovalAuth } from "../approval-auth.js";
import type { OpenClawConfig, ReplyPayload } from "../sdk.js";
import { isZulipAccountConfigured, listZulipAccountIds, resolveZulipAccount } from "./accounts.js";
import { createApprovalReactionTargetStore, listApprovalReactionBindings, readApprovalBinding, settleApprovalReaction, type ApprovalBindingMetadata, type ApprovalDecision } from "./approval-sdk.js";
import { addZulipReaction, editZulipMessage, fetchZulipUser, type ZulipClient, type ZulipEvent } from "./client.js";
import { resolveZulipReactionSpec } from "./status-reactions.js";

type Binding = ApprovalBindingMetadata & {
  accountId: string; messageId: string; client: ZulipClient; sourceText: string;
  expiresAtMs: number; emojis: Map<string, ApprovalDecision>; resolving: boolean;
};
const TARGET_TTL_MS = 24 * 60 * 60 * 1000;
const loadResolver = createLazyRuntimeSurface(
  () => import("openclaw/plugin-sdk/approval-gateway-runtime"),
  (runtime) => runtime.resolveApprovalOverGateway,
);

export class ZulipApprovalReactions {
  private readonly bindings = new Map<string, Binding>();
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
    for (const [key, binding] of this.bindings) if (binding.accountId === accountId) {
      this.bindings.delete(key); void this.targets.delete(key);
    }
  }
  async register(params: { cfg: OpenClawConfig; accountId: string; messageId: string; client: ZulipClient; sourceText: string; payload: Pick<ReplyPayload, "channelData" | "presentation"> }): Promise<void> {
    this.prune();
    const metadata = readApprovalBinding({ payload: params.payload });
    if (!metadata || !params.messageId || params.messageId === "unknown" || resolveZulipApprovers(params.cfg, params.accountId).length === 0) return;
    const key = this.key(params.accountId, params.messageId);
    if (this.bindings.has(key) || this.bindings.size >= this.maxEntries) return;
    const config = resolveZulipAccount({ cfg: params.cfg, accountId: params.accountId }).config.approvalReactions;
    const specs = [
      { spec: resolveZulipReactionSpec(config?.approve ?? "✅"), decision: "allow-once" as const },
      { spec: resolveZulipReactionSpec(config?.deny ?? "❌"), decision: "deny" as const },
    ].filter(({ decision }) => listApprovalReactionBindings({ allowedDecisions: metadata.allowedDecisions }).some((binding: { decision: ApprovalDecision }) => binding.decision === decision));
    if (specs.length === 0) return;
    if (new Set(specs.map(({ spec }) => spec.emojiName)).size !== specs.length) return;
    const binding: Binding = { ...metadata, accountId: params.accountId, messageId: params.messageId, client: params.client, sourceText: params.sourceText, expiresAtMs: Date.now() + TARGET_TTL_MS, resolving: false, emojis: new Map(specs.map(({ spec, decision }) => [spec.emojiName, decision])) };
    this.bindings.set(key, binding);
    await this.targets.register(key, binding);
    await Promise.allSettled(specs.map(({ spec }) => addZulipReaction(params.client, { messageId: params.messageId, ...spec })));
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
    await this.decide({ ...params, cfg: params.getConfig?.() ?? params.cfg, binding, senderId: user.email, decision });
  }
  async command(params: { abortSignal?: AbortSignal; getConfig?: () => OpenClawConfig; cfg: OpenClawConfig; accountId: string; senderId: string; text: string }): Promise<boolean> {
    this.prune();
    const match = params.text.trim().match(/^\/approve\s+(\S+)\s+(allow-once|allow-always|deny)$/u);
    if (!match) return false;
    const binding = [...this.bindings.values()].find((value) => value.accountId === params.accountId && value.approvalId === match[1]);
    if (!binding) return false;
    if (params.abortSignal?.aborted) return true;
    await this.decide({ ...params, cfg: params.getConfig?.() ?? params.cfg, binding, decision: match[2] as ApprovalDecision });
    return true;
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
  private async decide(params: { abortSignal?: AbortSignal; getConfig?: () => OpenClawConfig; cfg: OpenClawConfig; accountId: string; senderId: string; binding: Binding; decision: ApprovalDecision }): Promise<void> {
    const { binding } = params;
    if (binding.resolving || !binding.allowedDecisions.includes(params.decision) || !this.canSettle(params)) return;
    const siblings = [...this.bindings.values()].filter((entry) => entry.accountId === binding.accountId && entry.approvalId === binding.approvalId);
    if (siblings.some((entry) => entry.resolving)) return;
    for (const entry of siblings) entry.resolving = true;
    try {
      let outcome = "resolved";
      let retired: Binding[] = [];
      const status = await settleApprovalReaction({
        request: { cfg: params.cfg, channel: "zulip", accountId: params.accountId, senderId: params.senderId, approvalId: binding.approvalId, approvalKind: binding.approvalKind, decision: params.decision },
        approvers: resolveZulipApprovers(params.cfg, params.accountId),
        authorizeActorAction: zulipApprovalAuth.authorizeActorAction,
        loadResolver: async () => {
          const resolve = await loadResolver();
          return async (request) => {
            const cfg = params.getConfig?.() ?? params.cfg;
            if (!this.canSettle({ ...params, cfg })) {
              throw new Error("Zulip approval authorization changed before settlement");
            }
            return resolve({ ...request, cfg });
          };
        },
        clearTarget: () => { retired = this.retire(binding.accountId, binding.approvalId); },
        onResolved: (result) => { outcome = "decision" in result.approval ? result.approval.decision : result.approval.status; },
      });
      if (status !== "denied") {
        if (status === "not-found") outcome = "expired or already resolved";
        await Promise.all(retired.map((entry) => editZulipMessage(entry.client, {
          messageId: entry.messageId,
          content: `${entry.sourceText}\n\n**Approval outcome: ${outcome}**\nThese controls are no longer active.`,
        })));
      }
    } finally {
      for (const entry of siblings) entry.resolving = false;
    }
  }
}
export const zulipApprovalReactions = new ZulipApprovalReactions();
