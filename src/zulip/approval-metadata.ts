type Decision = "allow-once" | "allow-always" | "deny";
type Metadata = {
  approvalId: string;
  approvalKind: "exec" | "plugin" | "system-agent";
  allowedDecisions: Decision[];
  approvalSlug?: string;
};
type Options = { trimApprovalId?: boolean; requireApprovalSlug?: boolean };

// Matches src/plugin-sdk/approval-reaction-binding.ts in OpenClaw 2026.10.3/10.5-beta.4.
// The public reaction-runtime re-export was removed in upstream #164816.
export function readApprovalDeliveryMetadata(
  payload: { channelData?: Record<string, unknown> }, options: Options = {},
): Metadata | null {
  const value = payload.channelData?.execApproval;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.approvalId !== "string") return null;
  const approvalId = options.trimApprovalId ? record.approvalId.trim() : record.approvalId;
  const approvalSlug = typeof record.approvalSlug === "string" ? record.approvalSlug.trim() : "";
  const decisions = record.allowedDecisions;
  if (!Array.isArray(decisions) || decisions.length === 0) return null;
  const allowedDecisions: Decision[] = [];
  for (const decision of decisions) {
    if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny" || allowedDecisions.includes(decision)) return null;
    allowedDecisions.push(decision);
  }
  if (!approvalId || !options.trimApprovalId && approvalId !== approvalId.trim() || options.requireApprovalSlug && !approvalSlug || record.approvalKind !== "exec" && record.approvalKind !== "plugin" && record.approvalKind !== "system-agent") return null;
  return { approvalId, approvalKind: record.approvalKind, allowedDecisions, ...approvalSlug ? { approvalSlug } : {} };
}
