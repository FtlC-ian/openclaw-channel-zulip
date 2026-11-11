import { describe, expect, it } from "vitest";
import { zulipApprovalAuth } from "./approval-auth.js";

describe("Zulip approval authorization", () => {
  for (const approvalKind of ["exec", "plugin"] as const) {
    it.each([[], ["*"], ["123", "stream:general"]])(
      "denies " + approvalKind + " approvals without explicit approver emails: %j", (allowFrom) => {
        const result = zulipApprovalAuth.authorizeActorAction({
          cfg: { channels: { zulip: { allowFrom } } },
          senderId: "alice@example.test", action: "approve", approvalKind,
        });
        expect(result.authorized).toBe(false);
        expect(result.reason).toMatch(/no Zulip approvers configured.*explicit emails.*allowFrom/i);
      },
    );

    it("authorizes only an explicit " + approvalKind + " approver", () => {
      const input = {
        cfg: { channels: { zulip: { allowFrom: ["*", "user:Alice@example.test"] } } },
        action: "approve" as const, approvalKind,
      };
      expect(zulipApprovalAuth.authorizeActorAction({ ...input, senderId: "alice@example.test" }))
        .toEqual({ authorized: true });
      expect(zulipApprovalAuth.authorizeActorAction({ ...input, senderId: "bob@example.test" }).authorized)
        .toBe(false);
      expect(zulipApprovalAuth.authorizeActorAction(input).authorized).toBe(false);
    });
  }
});
