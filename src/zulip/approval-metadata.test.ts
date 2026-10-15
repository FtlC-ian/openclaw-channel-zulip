import { describe, expect, it } from "vitest";
// @ts-expect-error The pinned 2026.9.6 SDK omits this declaration file.
import { readApprovalReactionDeliveryMetadata as upstream } from "openclaw/plugin-sdk/approval-reaction-runtime";
import { readApprovalDeliveryMetadata as local } from "./approval-metadata.js";

describe("canonical approval metadata", () => {
  const valid = { approvalId: "req-1", approvalKind: "exec", approvalSlug: "req", allowedDecisions: ["allow-once", "deny"] };
  it("matches the pinned SDK for representative and malformed payloads and reader options", () => {
    const values: unknown[] = [undefined, null, false, 0, "bad", [], {}, valid];
    for (const [key, variants] of Object.entries({
      approvalId: [null, 1, "", " ", " req-1 "],
      approvalKind: [null, "", "other", "plugin"],
      approvalSlug: [null, 1, "", " ", " req "],
      allowedDecisions: [null, {}, [], ["deny", "deny"], ["always"], ["ALLOW-ONCE"], [null], ["allow-always", "deny", "allow-once"]],
    })) for (const value of variants) values.push({ ...valid, [key]: value });
    for (const value of values) for (const trimApprovalId of [false, true]) for (const requireApprovalSlug of [false, true]) {
      const payload = { channelData: { execApproval: value } };
      expect(local(payload, { trimApprovalId, requireApprovalSlug })).toEqual(upstream(payload, { trimApprovalId, requireApprovalSlug }));
    }
    for (const payload of [{}, { channelData: {} }]) expect(local(payload)).toEqual(upstream(payload));
  });
  it("preserves the system-agent kind added after the pinned SDK", () => {
    expect(local({ channelData: { execApproval: { ...valid, approvalKind: "system-agent" } } })).toEqual({ ...valid, approvalKind: "system-agent" });
  });
});
