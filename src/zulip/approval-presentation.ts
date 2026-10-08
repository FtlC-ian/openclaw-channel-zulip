import type { ChannelOutboundAdapter } from "../sdk.js";
import { markRenderedApproval, readApprovalBinding } from "./approval-sdk.js";
import { presentationToZulipWidgetContent } from "./send.js";

// Core consumes presentation after this hook; carry only validated controls across that boundary.
export const renderZulipApprovalPresentation: NonNullable<ChannelOutboundAdapter["renderPresentation"]> = ({ payload, presentation, sourcePresentation }) => {
  if (!readApprovalBinding({ payload: { ...payload, presentation: sourcePresentation ?? presentation } })) return null;
  const binding = readApprovalBinding({ payload: { ...payload, presentation } });
  if (!binding) return null;
  const commandPresentation = {
    ...presentation,
    blocks: presentation.blocks.map((block) => block.type !== "buttons" ? block : {
      ...block,
      buttons: block.buttons.map((button) => button.action?.type !== "approval" ? button : {
        ...button,
        action: { type: "command" as const, command: `/approve ${binding.approvalId} ${button.action.decision}` },
      }),
    }),
  };
  const widgetContent = presentationToZulipWidgetContent(commandPresentation);
  if (!widgetContent) return null;
  return markRenderedApproval({
    ...payload,
    channelData: {
      ...payload.channelData,
      zulip: { ...(payload.channelData?.zulip as Record<string, unknown> | undefined), widgetContent },
    },
  }, binding);
};
