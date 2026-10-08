import { describe, expect, it } from "vitest";
import { buildTypedExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import { buildApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-runtime";
import type { ReplyPayload } from "../sdk.js";
import { readApprovalBinding } from "./approval-sdk.js";
import { renderZulipApprovalPresentation } from "./approval-presentation.js";

const id = "12345678-1234-4234-8234-123456789abc";
const pending = () => buildTypedExecApprovalPendingReplyPayload({
  approvalId: id, approvalSlug: "12345678", command: "true", host: "gateway", allowedDecisions: ["allow-once", "deny"],
});
async function render(payload: ReplyPayload) {
  return await renderZulipApprovalPresentation({ payload, presentation: payload.presentation!, ctx: {} as never });
}

describe("approval presentation delivery boundary", () => {
  it("maps canonical typed controls to full-ID commands and preserves authored text and channel data", async () => {
    const payload = pending();
    payload.channelData!.zulip = { unrelated: true };
    const rendered = (await render(payload))!;
    expect(rendered.text).toBe(payload.text);
    expect(rendered.channelData?.zulip).toMatchObject({ unrelated: true, widgetContent: {
      widget_type: "zform", extra_data: { choices: [
        expect.objectContaining({ reply: `/approve ${id} allow-once` }),
        expect.objectContaining({ reply: `/approve ${id} deny` }),
      ] },
    } });
    const { presentation: _consumed, ...delivered } = rendered;
    expect(readApprovalBinding({ payload: delivered })).toMatchObject({ approvalId: id, allowedDecisions: ["allow-once", "deny"] });
    expect(payload.channelData).not.toHaveProperty("zulipApprovalBinding");
  });

  it("continues to render shipped command-backed controls", async () => {
    const payload = buildApprovalPendingReplyPayload({ approvalId: id, approvalSlug: "12345678", text: "Pending", allowedDecisions: ["deny"] });
    expect((await render(payload))?.channelData?.zulip).toMatchObject({ widgetContent: { extra_data: { choices: [expect.objectContaining({ reply: `/approve ${id} deny` })] } } });
  });

  it.each(["owner", "decisions", "terminal", "text-only"])("does not manufacture a binding for %s input", async (fault) => {
    const payload = pending();
    const metadata = payload.channelData!.execApproval as Record<string, unknown>;
    if (fault === "owner") metadata.approvalId = "87654321-1234-4234-8234-123456789abc";
    if (fault === "decisions") metadata.allowedDecisions = ["deny"];
    if (fault === "terminal") metadata.state = "resolved";
    if (fault === "text-only") delete payload.channelData;
    expect(await render(payload)).toBeNull();
  });

  it.each([
    { type: "command" as const, command: "/approve other allow-always" },
    { type: "callback" as const, value: "unrelated-control" },
    { type: "url" as const, url: "https://example.test" },
  ])("rejects canonical typed controls mixed with an extra $type action", async (action) => {
    const payload = pending();
    payload.presentation!.blocks.push({ type: "buttons", buttons: [{ label: "Unrelated", action }] });
    expect(readApprovalBinding({ payload })).toBeNull();
    expect(await render(payload)).toBeNull();
  });

  it("does not use a delivered marker to bypass contradictory surviving controls", async () => {
    const rendered = (await render(pending()))!;
    rendered.presentation!.blocks = [{ type: "buttons", buttons: [{ label: "Wrong", action: { type: "approval", approvalId: "other", approvalKind: "exec", decision: "deny" } }] }];
    expect(readApprovalBinding({ payload: rendered })).toBeNull();
    expect(await render(rendered)).toBeNull();
  });

  it.each(["owner", "kind", "decisions", "version", "terminal"])("revalidates rendered marker after %s mutation", async (fault) => {
    const rendered = (await render(pending()))!;
    delete rendered.presentation;
    const marker = rendered.channelData!.zulipApprovalBinding as Record<string, unknown>;
    if (fault === "owner") marker.approvalId = "other";
    if (fault === "kind") marker.approvalKind = "plugin";
    if (fault === "decisions") marker.allowedDecisions = ["deny"];
    if (fault === "version") marker.version = 2;
    if (fault === "terminal") (rendered.channelData!.execApproval as Record<string, unknown>).state = "resolved";
    expect(readApprovalBinding({ payload: rendered })).toBeNull();
  });
});
