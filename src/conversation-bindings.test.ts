import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import type {
  SessionBindingAdapter,
  SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  resolveZulipInboundBindingRoute,
  setZulipBindingIdleTimeoutBySessionKey,
  setZulipBindingMaxAgeBySessionKey,
} from "./conversation-bindings.js";
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

function bindingRecord(bindingId: string, targetSessionKey: string, boundAt: number): SessionBindingRecord {
  return {
    bindingId,
    targetSessionKey,
    targetKind: "session",
    conversation,
    status: "active",
    boundAt,
  };
}

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

  it("lets a runtime binding replace a configured route without preparing the configured target", async () => {
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
    expect(calls).toEqual(["runtime"]);
    expect(result.route).toBe(runtimeRoute);
    expect(result.boundSessionKey).toBe(runtimeRoute.sessionKey);
  });

  it("does not fall back to the ordinary session when a configured target is unavailable", async () => {
    await expect(resolveZulipInboundBindingRoute(
      { cfg: {} as OpenClawConfig, route: ordinaryRoute, conversation },
      {
        resolveConfiguredBindingRoute: vi.fn(() => ({ bindingResolution: { record: {} }, route: ordinaryRoute })),
        ensureConfiguredBindingRouteReady: vi.fn(async () => ({ ok: false as const, error: "backend offline" })),
        resolveRuntimeConversationBindingRouteAsync: vi.fn(async ({ route }) => ({
          bindingOwnerAvailable: true,
          bindingRecord: null,
          route,
        })),
      } as never,
    )).rejects.toThrow("Configured Zulip conversation binding unavailable: backend offline");
  });

  it("does not prepare or reuse a configured target while runtime ownership is unavailable", async () => {
    const ensureReady = vi.fn();
    const configuredRoute = { ...ordinaryRoute, sessionKey: "agent:main:acp:configured" };
    const result = await resolveZulipInboundBindingRoute(
      { cfg: {} as OpenClawConfig, route: ordinaryRoute, conversation },
      {
        resolveConfiguredBindingRoute: vi.fn(() => ({
          bindingResolution: { record: {} },
          route: configuredRoute,
          boundSessionKey: configuredRoute.sessionKey,
        })),
        ensureConfiguredBindingRouteReady: ensureReady,
        resolveRuntimeConversationBindingRouteAsync: vi.fn(async ({ route }) => ({
          bindingOwnerAvailable: false,
          bindingRecord: null,
          route,
        })),
      } as never,
    );

    expect(ensureReady).not.toHaveBeenCalled();
    expect(result.boundSessionKey).toBeUndefined();
  });

  it("re-resolves route ownership after refreshing lifecycle persistence", async () => {
    const targetSessionKey = "agent:main:acp:bound";
    const initial = {
      ...bindingRecord("generic-binding", targetSessionKey, 100),
      metadata: { boundAt: 100, lastActivityAt: 150, idleTimeoutMs: 500 },
    };
    const rebound = {
      ...initial,
      boundAt: 999,
      expiresAt: 1_499,
      metadata: { ...initial.metadata, lastActivityAt: 999 },
    };
    let current = initial;
    const service = {
      resolveByConversation: vi.fn(() => current),
      bind: vi.fn(async (input: { assertCurrent?: () => void }) => {
        input.assertCurrent?.();
        current = rebound;
        return rebound;
      }),
      touchAsync: vi.fn(async () => {}),
    };
    const staleRoute = { ...ordinaryRoute, sessionKey: targetSessionKey };
    const currentRoute = { ...staleRoute };
    const runtime = vi.fn()
      .mockResolvedValueOnce({
        bindingRecord: initial,
        boundSessionKey: targetSessionKey,
        route: staleRoute,
      })
      .mockResolvedValueOnce({
        bindingRecord: rebound,
        boundSessionKey: targetSessionKey,
        route: currentRoute,
      });

    const result = await resolveZulipInboundBindingRoute(
      { cfg: {} as OpenClawConfig, route: ordinaryRoute, conversation },
      {
        resolveConfiguredBindingRoute: vi.fn(() => ({ bindingResolution: null, route: ordinaryRoute })),
        ensureConfiguredBindingRouteReady: vi.fn(),
        resolveRuntimeConversationBindingRouteAsync: runtime,
        getSessionBindingService: vi.fn(() => service),
      } as never,
    );

    expect(runtime).toHaveBeenCalledTimes(2);
    expect(result.bindingRecord).toBe(rebound);
    expect(result.route).toBe(currentRoute);
  });
});

describe("OpenClaw runtime binding contract", () => {
  let adapter: SessionBindingAdapter | undefined;

  afterEach(() => {
    if (adapter) {
      unregisterSessionBindingAdapter({ channel: "zulip", accountId: "default", adapter });
      adapter = undefined;
    }
  });

  it("adopts a replacement that settles during the awaited activity update", async () => {
    const initial = bindingRecord("initial", "agent:main:acp:initial", 100);
    const replacement = bindingRecord("replacement", "agent:main:acp:replacement", 200);
    let current = initial;
    adapter = {
      channel: "zulip",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => current,
      inspectByConversationAsync: async () => current,
      touchAsync: async (bindingId) => {
        if (bindingId === initial.bindingId) current = replacement;
      },
    };
    registerSessionBindingAdapter(adapter);

    const result = await resolveZulipInboundBindingRoute({
      cfg: {} as OpenClawConfig,
      route: ordinaryRoute,
      conversation,
    });

    expect(result.bindingRecord).toEqual(replacement);
    expect(result.boundSessionKey).toBe(replacement.targetSessionKey);
    expect(result.route).toMatchObject({
      agentId: "main",
      sessionKey: replacement.targetSessionKey,
      matchedBy: "binding.channel",
    });
  });

  it("fails closed when ownership is replaced repeatedly during activity recording", async () => {
    const records = [
      bindingRecord("first", "agent:main:acp:first", 100),
      bindingRecord("second", "agent:main:acp:second", 200),
      bindingRecord("third", "agent:main:acp:third", 300),
    ];
    let index = 0;
    adapter = {
      channel: "zulip",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => records[index],
      inspectByConversationAsync: async () => records[index],
      touchAsync: async () => {
        index += 1;
      },
    };
    registerSessionBindingAdapter(adapter);

    await expect(resolveZulipInboundBindingRoute({
      cfg: {} as OpenClawConfig,
      route: ordinaryRoute,
      conversation,
    })).rejects.toThrow("Conversation binding changed repeatedly while recording activity");
  });
});

describe("Zulip generic binding lifecycle updates", () => {
  function createService(records: SessionBindingRecord[]) {
    let current = records;
    const service = {
      listBySession: vi.fn((targetSessionKey: string) =>
        current.filter((record) => record.targetSessionKey === targetSessionKey),
      ),
      resolveByConversation: vi.fn((ref: SessionBindingRecord["conversation"]) =>
        current.find((record) =>
          record.conversation.channel === ref.channel &&
          record.conversation.accountId === ref.accountId &&
          record.conversation.conversationId === ref.conversationId
        ) ?? null,
      ),
      bind: vi.fn(async (input: {
        targetSessionKey: string;
        targetKind: SessionBindingRecord["targetKind"];
        conversation: SessionBindingRecord["conversation"];
        metadata?: Record<string, unknown>;
        ttlMs?: number;
        assertCurrent?: () => void;
      }) => {
        input.assertCurrent?.();
        const previous = service.resolveByConversation(input.conversation)!;
        const rebound: SessionBindingRecord = {
          ...previous,
          targetSessionKey: input.targetSessionKey,
          targetKind: input.targetKind,
          boundAt: 999,
          metadata: { ...input.metadata, lastActivityAt: 999 },
          ...(input.ttlMs === undefined ? {} : { expiresAt: 999 + input.ttlMs }),
        };
        current = current.map((record) => record === previous ? rebound : record);
        return rebound;
      }),
      touchAsync: vi.fn(async (bindingId: string, at?: number) => {
        current = current.map((record) => record.bindingId === bindingId
          ? { ...record, metadata: { ...record.metadata, lastActivityAt: at } }
          : record);
      }),
    };
    return service;
  }

  it("mutates only the requested account and returns the persisted lifecycle record", async () => {
    const targetSessionKey = "agent:bound:acp:shared";
    const defaultRecord = {
      ...bindingRecord("default-binding", targetSessionKey, 100),
      metadata: { lastActivityAt: 150, maxAgeMs: 1_000 },
    };
    const otherRecord = {
      ...bindingRecord("other-binding", targetSessionKey, 200),
      conversation: { ...conversation, accountId: "other", conversationId: `43:topic:v2:${"b".repeat(64)}` },
      metadata: { lastActivityAt: 250 },
    };
    const service = createService([defaultRecord, otherRecord]);

    const result = await setZulipBindingIdleTimeoutBySessionKey({
      targetSessionKey,
      accountId: "default",
      idleTimeoutMs: 500,
    }, service as never);

    expect(result).toEqual([{
      boundAt: 100,
      lastActivityAt: 150,
      idleTimeoutMs: 500,
      maxAgeMs: 1_000,
    }]);
    expect(service.bind).toHaveBeenCalledTimes(1);
    expect(service.bind).toHaveBeenCalledWith(expect.objectContaining({
      conversation: defaultRecord.conversation,
      metadata: expect.objectContaining({
        boundAt: 100,
        lastActivityAt: 150,
        idleTimeoutMs: 500,
        maxAgeMs: 1_000,
      }),
    }));
    expect(service.touchAsync).toHaveBeenCalledWith("default-binding", 150, defaultRecord.conversation);
  });

  it("updates max age, preserves idle state, and returns no records for a missing binding", async () => {
    const targetSessionKey = "agent:bound:acp:topic";
    const record = {
      ...bindingRecord("topic-binding", targetSessionKey, 100),
      metadata: { boundAt: 80, lastActivityAt: 120, idleTimeoutMs: 600 },
    };
    const service = createService([record]);

    await expect(setZulipBindingMaxAgeBySessionKey({
      targetSessionKey,
      accountId: "default",
      maxAgeMs: 2_000,
    }, service as never)).resolves.toEqual([{
      boundAt: 80,
      lastActivityAt: 120,
      idleTimeoutMs: 600,
      maxAgeMs: 2_000,
    }]);
    await expect(setZulipBindingMaxAgeBySessionKey({
      targetSessionKey: "agent:bound:acp:missing",
      accountId: "default",
      maxAgeMs: 2_000,
    }, service as never)).resolves.toEqual([]);
  });

  it("rejects a same-id, same-target replacement instead of overwriting the new generation", async () => {
    const targetSessionKey = "agent:bound:acp:topic";
    const record = bindingRecord("topic-binding", targetSessionKey, 100);
    const service = createService([record]);
    service.resolveByConversation.mockReturnValueOnce({
      ...record,
      boundAt: 200,
      metadata: { lastActivityAt: 200 },
    });

    await expect(setZulipBindingIdleTimeoutBySessionKey({
      targetSessionKey,
      accountId: "default",
      idleTimeoutMs: 500,
    }, service as never)).rejects.toThrow("changed during lifecycle update");
    expect(service.touchAsync).not.toHaveBeenCalled();
  });
});
