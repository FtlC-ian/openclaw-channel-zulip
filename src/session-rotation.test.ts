import { describe, expect, it } from "vitest";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
} from "openclaw/plugin-sdk/session-store-runtime";

describe("supported host session rotation", () => {
  it("rotates a direct session at the exact configured idle boundary", () => {
    const policy = resolveSessionResetPolicy({
      sessionCfg: {
        resetByType: {
          direct: { mode: "idle", idleMinutes: 30 },
        },
      },
      resetType: "direct",
    });
    const lastInteractionAt = 1_000_000;
    const idleBoundary = lastInteractionAt + 30 * 60_000;

    expect(evaluateSessionFreshness({
      updatedAt: lastInteractionAt,
      lastInteractionAt,
      now: idleBoundary - 1,
      policy,
    })).toMatchObject({ fresh: true, idleExpiresAt: idleBoundary });
    expect(evaluateSessionFreshness({
      updatedAt: lastInteractionAt,
      lastInteractionAt,
      now: idleBoundary,
      policy,
    })).toMatchObject({ fresh: true, idleExpiresAt: idleBoundary });
    expect(evaluateSessionFreshness({
      updatedAt: lastInteractionAt,
      lastInteractionAt,
      now: idleBoundary + 1,
      policy,
    })).toMatchObject({ fresh: false, staleReason: "idle", idleExpiresAt: idleBoundary });
  });

  it("does not apply direct-message rotation to group or topic sessions", () => {
    const sessionCfg = {
      resetByType: {
        direct: { mode: "idle" as const, idleMinutes: 30 },
      },
    };
    expect(resolveSessionResetPolicy({ sessionCfg, resetType: "direct" }))
      .toMatchObject({ mode: "idle", idleMinutes: 30, configured: true });
    expect(resolveSessionResetPolicy({ sessionCfg, resetType: "group" }))
      .not.toMatchObject({ mode: "idle", idleMinutes: 30 });
    expect(resolveSessionResetPolicy({ sessionCfg, resetType: "thread" }))
      .not.toMatchObject({ mode: "idle", idleMinutes: 30 });
  });
});
