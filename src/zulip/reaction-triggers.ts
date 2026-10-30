import { createHash } from "node:crypto";
import type { ZulipAccountConfig } from "../types.js";
import { fetchZulipUser, type ZulipClient, type ZulipEvent, type ZulipMessage } from "./client.js";
import { resolveZulipReactionSpec } from "./status-reactions.js";
import { updateKeyedStore, type ConditionalStore } from "./keyed-store.js";

export function reactionTriggerEmoji(config: ZulipAccountConfig): string {
  return resolveZulipReactionSpec(config.reactionTriggers?.emoji ?? "fast_forward").emojiName;
}

export function reactionTriggerApprovalCollision(config: Pick<ZulipAccountConfig, "reactionTriggers" | "approvalReactions">): boolean {
  if (!config.reactionTriggers) return false;
  const emoji = reactionTriggerEmoji(config);
  return [config.approvalReactions?.approve ?? "✅", config.approvalReactions?.deny ?? "❌"]
    .some(raw => resolveZulipReactionSpec(raw).emojiName === emoji);
}

export type ReactionTriggerLedger = ConditionalStore<{ keys: string[] }>;

export async function claimReactionTrigger(ledger: ReactionTriggerLedger, scope: string, key: string): Promise<boolean> {
  return updateKeyedStore(ledger, scope, current => current?.keys.includes(key)
    ? undefined : { keys: [...(current?.keys ?? []), key] });
}

export async function buildReactionContinuation(params: {
  event: ZulipEvent; config: ZulipAccountConfig; client: ZulipClient;
  botUserId: string; isApprovalPrompt: (messageId: string) => Promise<boolean>;
}): Promise<ZulipMessage | undefined> {
  const { event, config, client, botUserId } = params;
  if (!config.reactionTriggers?.enabled || event.op !== "add" || event.type !== "reaction" ||
      !event.message_id || !event.user_id || String(event.user_id) === botUserId ||
      event.emoji_name !== reactionTriggerEmoji(config) ||
      !["unicode_emoji", "realm_emoji"].includes(event.reaction_type ?? "")) return;
  const messageId = String(event.message_id);
  if (await params.isApprovalPrompt(messageId)) return;
  const user = await fetchZulipUser(client, String(event.user_id));
  if (user.is_bot || user.is_active === false || !user.email) return;
  const response = await client.request<{ result: string; message?: ZulipMessage }>("/messages/" + messageId);
  const target = response.message;
  if (response.result !== "success" || !target || String(target.sender_id) !== botUserId) return;
  if ((target.content ?? "").includes("/approve ")) return;
  if (target.type !== "stream" && target.type !== "private") return;
  if (target.type === "private") {
    const recipients = target.display_recipient;
    if (!Array.isArray(recipients) || recipients.length !== 2 ||
        !recipients.some(recipient => String(recipient.id) === String(event.user_id))) return;
  }
  const text = config.reactionTriggers.message?.trim() || "Go ahead.";
  const content = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    ...target, id: messageId, sender_id: String(event.user_id), sender_email: user.email,
    sender_full_name: user.full_name, content, timestamp: Math.floor(Date.now() / 1000),
    reactionTriggerKey: createHash("sha256").update(JSON.stringify([messageId, event.user_id, event.emoji_name])).digest("hex"),
  };
}
