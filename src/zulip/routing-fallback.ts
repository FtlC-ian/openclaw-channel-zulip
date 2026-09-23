import type { ZulipAccountConfig } from "../types.js";
import { fetchZulipMe, fetchZulipUser, type ZulipClient } from "./client.js";
import { isZulipSessionTarget, parseZulipTarget, resolveZulipDestination } from "./destination.js";

export type ZulipRoutingFallback = {
  reason: "missing-delivery-context";
  requestedTarget: string;
  selectedAccountId: string;
  destination: string;
  recipient: "bot-owner" | "diagnostics";
};

export async function resolveZulipSendDestination(params: {
  client: ZulipClient;
  to: string;
  topic?: string | number | null;
  accountId: string;
  config: Pick<ZulipAccountConfig, "defaultTopic" | "routingDiagnosticsTarget">;
}): Promise<{
  target: ReturnType<typeof resolveZulipDestination>;
  fallback?: ZulipRoutingFallback;
}> {
  if (!isZulipSessionTarget(params.to)) {
    return { target: resolveZulipDestination(params.to, params.topic, params.config.defaultTopic) };
  }

  let target: ReturnType<typeof resolveZulipDestination> | undefined;
  let recipient: ZulipRoutingFallback["recipient"] = "bot-owner";
  try {
    const self = await fetchZulipMe(params.client);
    if (!/^\d+$/.test(self.id)) throw new Error("Bot identity unavailable");
    const bot = await fetchZulipUser(params.client, self.id);
    const ownerId = bot.bot_owner_id;
    if (bot.is_bot !== true || !Number.isSafeInteger(ownerId) || ownerId! <= 0) {
      throw new Error("Bot owner unavailable");
    }
    const owner = await fetchZulipUser(params.client, String(ownerId));
    if (owner.is_active !== true || owner.is_bot !== false || !owner.email) {
      throw new Error("Active bot owner unavailable");
    }
    target = resolveZulipDestination(`user:${owner.email}`);
  } catch (cause) {
    const diagnostics = params.config.routingDiagnosticsTarget?.trim();
    if (!diagnostics) {
      throw new Error("Zulip could not recover the destination or bot owner; configure routingDiagnosticsTarget for a diagnostics topic", { cause });
    }
    const parsed = parseZulipTarget(diagnostics);
    if (parsed.kind !== "stream" || parsed.topic === undefined || !/^stream:/i.test(diagnostics)) {
      throw new Error("Zulip routingDiagnosticsTarget must name an explicit stream and topic");
    }
    target = { ...parsed, topic: parsed.topic };
    recipient = "diagnostics";
  }

  const destination = target.kind === "user" ? `user:${target.email}` : `stream:${target.stream}:${target.topic}`;
  return {
    target,
    fallback: {
      reason: "missing-delivery-context",
      requestedTarget: params.to.trim(),
      selectedAccountId: params.accountId,
      destination,
      recipient,
    },
  };
}

export function prependZulipRoutingNotice(text: string, fallback?: ZulipRoutingFallback): string {
  if (!fallback) return text;
  const detail = JSON.stringify({ requestedTarget: fallback.requestedTarget, selectedAccountId: fallback.selectedAccountId }).replaceAll("`", "\\u0060");
  return `⚠️ **OpenClaw routing fallback**\nThe original Zulip destination could not be recovered. This message was redirected to ${fallback.recipient === "bot-owner" ? "the selected bot's owner" : "the configured diagnostics topic"}. The original account and topic could not be recovered from the session ID.\n\n\`\`\`json\n${detail}\n\`\`\`\n\n---\n\n${text}`;
}
