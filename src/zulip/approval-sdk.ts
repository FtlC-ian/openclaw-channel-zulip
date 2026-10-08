import type { ReplyPayload } from "../sdk.js";
import { resolveMessagePresentationActionValue } from "../sdk.js";
import type { resolveApprovalOverGateway, ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { getExecApprovalReplyMetadata } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { zulipApprovalAuth } from "../approval-auth.js";
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";
export type ApprovalBindingMetadata = {
  approvalId: string;
  approvalKind: "exec" | "plugin";
  allowedDecisions: ApprovalDecision[];
};
// 2026.9.6 ships this public runtime subpath without its declaration file.
// @ts-expect-error Upstream package explicitly excludes this .d.ts.
import { readApprovalReactionPresentationBinding, readApprovalReactionDeliveryMetadata, readApprovalReactionDeliveredBinding, buildApprovalReactionDeliveredBindingMarker, settleApprovalReaction as settle, createApprovalReactionTargetStore, listApprovalReactionBindings } from "openclaw/plugin-sdk/approval-reaction-runtime";
export { createApprovalReactionTargetStore, listApprovalReactionBindings };
const DELIVERED_BINDING_KEY = "zulipApprovalBinding";
export function markRenderedApproval(payload: ReplyPayload, binding: ApprovalBindingMetadata): ReplyPayload {
  return { ...payload, channelData: { ...payload.channelData, [DELIVERED_BINDING_KEY]: buildApprovalReactionDeliveredBindingMarker(binding) } };
}
type Payload = Pick<ReplyPayload, "channelData" | "presentation">;
const readTyped = readApprovalReactionPresentationBinding as (params: { payload: Payload }) => ApprovalBindingMetadata | null;
const readMetadata = readApprovalReactionDeliveryMetadata as (payload: Payload) => ApprovalBindingMetadata | null;
export function readApprovalBinding({ payload }: { payload: Payload }): ApprovalBindingMetadata | null {
  const state = (payload.channelData?.execApproval as { state?: unknown } | undefined)?.state;
  if (state !== undefined && state !== "pending") return null;
  const metadata = readMetadata(payload);
  if (!metadata) return null;
  const replyMetadata = getExecApprovalReplyMetadata(payload);
  if (replyMetadata && (replyMetadata.approvalId !== metadata.approvalId || replyMetadata.approvalKind !== metadata.approvalKind)) return null;
  const typed = readTyped({ payload });
  if (typed) return typed;
  if (!payload.presentation) {
    return readApprovalReactionDeliveredBinding({ payload, channelDataKey: DELIVERED_BINDING_KEY }) as ApprovalBindingMetadata | null;
  }
  const actions = payload.presentation?.blocks.flatMap((block) => block.type === "buttons" ? block.buttons.map((button) => button.action) : []) ?? [];
  const commands = actions.map((action) => action?.type === "command" ? resolveMessagePresentationActionValue(action) : undefined);
  if (commands.length !== metadata.allowedDecisions.length || new Set(commands).size !== commands.length) return null;
  return metadata.allowedDecisions.every((decision) => commands.includes(`/approve ${metadata.approvalId} ${decision}`)) ? metadata : null;
}
type CanonicalResolveApprovalOverGatewayParams = Parameters<typeof resolveApprovalOverGateway>[0] & { approvalKind: "exec" | "plugin"; resolveMethod?: never; allowPluginFallback?: never };
export const settleApprovalReaction = settle as (params: {
  request: CanonicalResolveApprovalOverGatewayParams & { channel: string; accountId: string; senderId: string };
  approvers: readonly string[];
  authorizeActorAction: typeof zulipApprovalAuth.authorizeActorAction;
  loadResolver: () => Promise<(request: CanonicalResolveApprovalOverGatewayParams) => Promise<ApprovalResolveResult>>;
  clearTarget: () => void | Promise<void>;
  onResolved: (result: ApprovalResolveResult) => void;
}) => Promise<"denied" | "resolved" | "not-found">;
