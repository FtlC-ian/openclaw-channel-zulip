import { describe, expect, it, vi } from "vitest";
import { resolveZulipInboundBindingRoute } from "./conversation-bindings.js";
import type { OpenClawConfig } from "./sdk.js";

const conversation = {
  channel: "zulip",
  accountId: "default",
  conversationId: `42:topic:v2:${"a".repeat(64)}`,
  parentConversationId: "42",
};
const ordinaryRoute = {
  agentId: "main",
  accountId: "default",
  sessionKey: "agent:main:zulip:channel:ordinary",
  mainSessionKey: "agent:main:main",
  matchedBy: "default" as const,
};

describe("resolveZulipInboundBindingRoute", () => {
  it("preserves ordinary routing when neither configured nor runtime bindings match", async () => {
    const runtime = vi.fn(async ({ route }) => ({ bindingRecord: null, route }));
    const result = await resolveZulipInboundBindingRoute(
      { cfg: {} as OpenClawConfig, route: ordinaryRoute, conversation },
      {
        resolveConfiguredBindingRoute: vi.fn(() => ({ bindingResolution: null, route: ordinaryRoute })),
        ensureConfiguredBindingRouteReady: vi.fn(),
        resolveRuntimeConversationBindingRouteAsync: runtime,
      } as never,
    );
    expect(result.route).toBe(ordinaryRoute);
    expect(runtime).toHaveBeenCalledWith({ route: ordinaryRoute, conversation });
  });

  it("awaits configured readiness before runtime binding resolution and lets the live record replace it", async () => {
    const calls: string[] = [];
    const configuredRoute = { ...ordinaryRoute, sessionKey: "agent:main:acp:configured" };
    const runtimeRoute = { ...ordinaryRoute, sessionKey: "agent:main:acp:live" };
    const result = await resolveZulipInboundBindingRoute(
      { cfg: {} as OpenClawConfig, route: ordinaryRoute, conversation },
      {
        resolveConfiguredBindingRoute: vi.fn(() => ({
          bindingResolution: { record: {} },
          route: configuredRoute,
          boundSessionKey: configuredRoute.sessionKey,
        })),
        ensureConfiguredBindingRouteReady: vi.fn(async () => {
          calls.push("ready");
          return { ok: true as const };
        }),
        resolveRuntimeConversationBindingRouteAsync: vi.fn(async ({ route }) => {
          calls.push("runtime");
          expect(route).toBe(configuredRoute);
          return { bindingRecord: { bindingId: "replacement" }, route: runtimeRoute, boundSessionKey: runtimeRoute.sessionKey };
        }),
      } as never,
    );
    expect(calls).toEqual(["ready", "runtime"]);
    expect(result.route).toBe(runtimeRoute);
    expect(result.boundSessionKey).toBe(runtimeRoute.sessionKey);
  });

  it("does not fall back to the ordinary session when a configured target is unavailable", async () => {
    await expect(resolveZulipInboundBindingRoute(
      { cfg: {} as OpenClawConfig, route: ordinaryRoute, conversation },
      {
        resolveConfiguredBindingRoute: vi.fn(() => ({ bindingResolution: { record: {} }, route: ordinaryRoute })),
        ensureConfiguredBindingRouteReady: vi.fn(async () => ({ ok: false as const, error: "backend offline" })),
        resolveRuntimeConversationBindingRouteAsync: vi.fn(),
      } as never,
    )).rejects.toThrow("Configured Zulip conversation binding unavailable: backend offline");
  });
});
