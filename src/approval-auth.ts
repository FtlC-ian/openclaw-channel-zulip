import type { OpenClawConfig } from "./sdk.js";
import { normalizeZulipMessagingTarget } from "./normalize.js";
import { resolveZulipAccount } from "./zulip/accounts.js";

function normalizeZulipApproverId(value: string | number): string | undefined {
  const normalized = normalizeZulipMessagingTarget(String(value));
  if (!normalized?.startsWith("user:")) {
    return undefined;
  }
  const email = normalized.slice("user:".length).trim().toLowerCase();
  return email || undefined;
}

export function resolveZulipApprovers(cfg: OpenClawConfig, accountId?: string | null): string[] {
  const allowFrom = resolveZulipAccount({ cfg, accountId }).config.allowFrom ?? [];
  const seen = new Set<string>();
  const approvers: string[] = [];

  for (const entry of allowFrom) {
    const normalized = normalizeZulipApproverId(String(entry));
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    approvers.push(normalized);
  }

  return approvers;
}

export const zulipApprovalAuth = {
  authorizeActorAction({
    cfg,
    accountId,
    senderId,
    approvalKind,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    senderId?: string | null;
    action: "approve";
    approvalKind: "exec" | "plugin";
  }) {
    const approvers = resolveZulipApprovers(cfg, accountId);
    if (approvers.length === 0) {
      return { authorized: true } as const;
    }
    const normalizedSenderId = senderId ? normalizeZulipApproverId(senderId) : undefined;
    if (normalizedSenderId && approvers.includes(normalizedSenderId)) {
      return { authorized: true } as const;
    }
    return {
      authorized: false,
      reason: `❌ You are not authorized to approve ${approvalKind} requests on Zulip.`,
    } as const;
  },
};
