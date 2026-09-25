import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.OPENCLAW_STATE_DIR ??= `/tmp/openclaw-zulip-conversation-bindings-${process.pid}`;
});
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveRuntimeConversationBindingRouteAsync } from
  "openclaw/plugin-sdk/conversation-binding-runtime";
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
    const liveBinding = bindingRecord("generic:replacement", runtimeRoute.sessionKey, 100);
    const service = {
      resolveByConversation: vi.fn(() => liveBinding),
      bind: vi.fn(async (input: { assertCurrent?: () => void }) => {
        input.assertCurrent?.();
        return liveBinding;
      }),
      touchAsync: vi.fn(async () => {}),
    };
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
          return { bindingRecord: liveBinding, route: runtimeRoute, boundSessionKey: runtimeRoute.sessionKey };
        }),
        getSessionBindingService: vi.fn(() => service),
      } as never,
    );
    expect(calls).toEqual(["runtime", "runtime"]);
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
    await expect(resolveZulipInboundBindingRoute(
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
    )).rejects.toThrow("Zulip conversation binding owner unavailable; retry inbound delivery");

    expect(ensureReady).not.toHaveBeenCalled();
  });

  it("does not create a new generation for routine inbound activity", async () => {
    const targetSessionKey = "agent:main:acp:bound";
    const initial = {
      ...bindingRecord("generic:binding", targetSessionKey, 100),
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
    const runtime = vi.fn().mockResolvedValue({
      bindingRecord: initial,
      boundSessionKey: targetSessionKey,
      route: staleRoute,
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

    expect(runtime).toHaveBeenCalledTimes(1);
    expect(service.bind).not.toHaveBeenCalled();
    expect(result.bindingRecord).toBe(initial);
    expect(result.route).toBe(staleRoute);
  });

  it("initializes the generic binding default idle expiry on first inbound activity", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(200);
    const targetSessionKey = "agent:main:acp:bound";
    const initial = bindingRecord("generic:binding", targetSessionKey, 100);
    let current: SessionBindingRecord = initial;
    const service = {
      resolveByConversation: vi.fn(() => current),
      bind: vi.fn(async (input: {
        assertCurrent?: () => void;
        metadata?: Record<string, unknown>;
        ttlMs?: number;
      }) => {
        input.assertCurrent?.();
        current = {
          ...initial,
          boundAt: 200,
          ...(input.ttlMs === undefined ? {} : { expiresAt: 200 + input.ttlMs }),
          metadata: { ...input.metadata, lastActivityAt: 200 },
        };
        return current;
      }),
      touchAsync: vi.fn(async () => {}),
    };
    const runtime = vi.fn(async () => ({
      bindingRecord: current,
      boundSessionKey: targetSessionKey,
      route: ordinaryRoute,
    }));

    try {
      await resolveZulipInboundBindingRoute(
        { cfg: {} as OpenClawConfig, route: ordinaryRoute, conversation },
        {
          resolveConfiguredBindingRoute: vi.fn(() => ({ bindingResolution: null, route: ordinaryRoute })),
          ensureConfiguredBindingRouteReady: vi.fn(),
          resolveRuntimeConversationBindingRouteAsync: runtime,
          getSessionBindingService: vi.fn(() => service),
        } as never,
      );
    } finally {
      now.mockRestore();
    }

    expect(service.bind).toHaveBeenCalledWith(expect.objectContaining({
      ttlMs: 86_399_900,
      metadata: expect.objectContaining({
        idleTimeoutMs: 86_399_900,
        zulipIdleTimeoutMs: 86_400_000,
      }),
    }));
  });

  it("routes two synchronized concurrent resolutions through the real generic service", async () => {
    const service = getSessionBindingService();
    const targetSessionKey = "agent:main:acp:concurrent-generic";
    const realConversation = {
      channel: "webchat",
      accountId: "default",
      conversationId: `zulip-binding-race-${Date.now()}-${Math.random()}`,
    };
    const initial = await service.bind({
      targetSessionKey,
      targetKind: "session",
      conversation: realConversation,
      placement: "current",
    });
    let releaseFirstReads!: () => void;
    const firstReadsReady = new Promise<void>((resolve) => {
      releaseFirstReads = resolve;
    });
    let firstReadCount = 0;
    const synchronizedResolver = async (
      params: Parameters<typeof resolveRuntimeConversationBindingRouteAsync>[0],
    ) => {
      const result = await resolveRuntimeConversationBindingRouteAsync(params);
      if (firstReadCount < 2) {
        firstReadCount += 1;
        if (firstReadCount === 2) releaseFirstReads();
        await firstReadsReady;
      }
      return result;
    };
    const dependencies = {
      resolveConfiguredBindingRoute: vi.fn(() => ({ bindingResolution: null, route: ordinaryRoute })),
      ensureConfiguredBindingRouteReady: vi.fn(),
      resolveRuntimeConversationBindingRouteAsync: synchronizedResolver,
      getSessionBindingService: () => service,
    } as never;

    try {
      const settled = await Promise.allSettled([
        resolveZulipInboundBindingRoute({
          cfg: {} as OpenClawConfig,
          route: ordinaryRoute,
          conversation: realConversation,
        }, dependencies),
        resolveZulipInboundBindingRoute({
          cfg: {} as OpenClawConfig,
          route: ordinaryRoute,
          conversation: realConversation,
        }, dependencies),
      ]);

      expect(settled).toHaveLength(2);
      expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        expect(result.value.boundSessionKey).toBe(targetSessionKey);
        expect(result.value.bindingRecord?.bindingId).toBe(initial.bindingId);
      }
      const initialized = service.resolveByConversation(realConversation);
      expect(initialized).toMatchObject({
        bindingId: initial.bindingId,
        targetSessionKey,
        metadata: expect.objectContaining({
          zulipIdleTimeoutMs: 86_400_000,
        }),
      });
      await resolveZulipInboundBindingRoute({
        cfg: {} as OpenClawConfig,
        route: ordinaryRoute,
        conversation: realConversation,
      }, dependencies);
      expect(service.resolveByConversation(realConversation)?.boundAt).toBe(initialized?.boundAt);
    } finally {
      await service.unbind({
        bindingId: initial.bindingId,
        scope: realConversation,
        reason: "test cleanup",
      });
    }
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
      ...bindingRecord("generic:default-binding", targetSessionKey, 100),
      metadata: { lastActivityAt: 150, maxAgeMs: 1_000 },
    };
    const otherRecord = {
      ...bindingRecord("generic:other-binding", targetSessionKey, 200),
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
      lastActivityAt: 999,
      idleTimeoutMs: 500,
      maxAgeMs: 1_000,
    }]);
    expect(service.bind).toHaveBeenCalledTimes(1);
    expect(service.bind).toHaveBeenCalledWith(expect.objectContaining({
      conversation: defaultRecord.conversation,
      metadata: expect.objectContaining({
        boundAt: 100,
        lastActivityAt: 150,
        zulipIdleTimeoutMs: 500,
        zulipMaxAgeMs: 1_000,
      }),
    }));
    expect(service.touchAsync).not.toHaveBeenCalled();
  });

  it("updates max age, preserves idle state, and returns no records for a missing binding", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(200);
    const targetSessionKey = "agent:bound:acp:topic";
    const record = {
      ...bindingRecord("generic:topic-binding", targetSessionKey, 100),
      metadata: { boundAt: 80, lastActivityAt: 120, idleTimeoutMs: 600 },
    };
    const service = createService([record]);

    try {
      await expect(setZulipBindingMaxAgeBySessionKey({
        targetSessionKey,
        accountId: "default",
        maxAgeMs: 2_000,
      }, service as never)).resolves.toEqual([{
        boundAt: 80,
        lastActivityAt: 999,
        idleTimeoutMs: 600,
        maxAgeMs: 2_000,
      }]);
      expect(service.bind).toHaveBeenCalledWith(expect.objectContaining({
        ttlMs: 520,
        metadata: expect.objectContaining({
          idleTimeoutMs: 520,
          maxAgeMs: 1_880,
          zulipIdleTimeoutMs: 600,
          zulipMaxAgeMs: 2_000,
        }),
      }));
      await expect(setZulipBindingMaxAgeBySessionKey({
        targetSessionKey: "agent:bound:acp:missing",
        accountId: "default",
        maxAgeMs: 2_000,
      }, service as never)).resolves.toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it("rejects a same-id, same-target replacement instead of overwriting the new generation", async () => {
    const targetSessionKey = "agent:bound:acp:topic";
    const record = bindingRecord("generic:topic-binding", targetSessionKey, 100);
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

  it("retries a lifecycle update after concurrent inbound activity", async () => {
    const targetSessionKey = "agent:bound:acp:topic";
    const record = {
      ...bindingRecord("generic:topic-binding", targetSessionKey, 100),
      metadata: { boundAt: 100, lastActivityAt: 150, idleTimeoutMs: 500 },
    };
    const touched = {
      ...record,
      metadata: { ...record.metadata, lastActivityAt: 175 },
    };
    let current: SessionBindingRecord = record;
    let firstAssertion = true;
    const service = {
      listBySession: vi.fn(() => [record]),
      resolveByConversation: vi.fn(() => current),
      bind: vi.fn(async (input: {
        assertCurrent?: () => void;
        metadata?: Record<string, unknown>;
      }) => {
        if (firstAssertion) {
          firstAssertion = false;
          current = touched;
        }
        input.assertCurrent?.();
        current = {
          ...current,
          boundAt: 999,
          metadata: { ...input.metadata, lastActivityAt: 999 },
        };
        return current;
      }),
      touchAsync: vi.fn(async () => {}),
    };

    await expect(setZulipBindingIdleTimeoutBySessionKey({
      targetSessionKey,
      accountId: "default",
      idleTimeoutMs: 500,
    }, service as never)).resolves.toEqual([{
      boundAt: 100,
      lastActivityAt: 999,
      idleTimeoutMs: 500,
    }]);
    expect(service.bind).toHaveBeenCalledTimes(2);
    expect(service.touchAsync).not.toHaveBeenCalled();
  });

  it.each([
    ["idle timeout", () => ({ idleTimeoutMs: 500 })],
    ["max age", () => ({ maxAgeMs: 1_000 })],
  ] as const)("merges default initialization with a concurrent %s mutation", async (_label, patch) => {
    const targetSessionKey = "agent:bound:acp:overlap";
    const record = bindingRecord("generic:overlap-binding", targetSessionKey, 100);
    let current: SessionBindingRecord = record;
    let waiting = 0;
    let release!: () => void;
    const bothWaiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = {
      listBySession: vi.fn(() => [current]),
      resolveByConversation: vi.fn(() => current),
      bind: vi.fn(async (input: {
        assertCurrent?: () => void;
        metadata?: Record<string, unknown>;
        ttlMs?: number;
      }) => {
        waiting += 1;
        if (waiting === 2) release();
        if (waiting <= 2) await bothWaiting;
        input.assertCurrent?.();
        const now = 200 + service.bind.mock.calls.length;
        current = {
          ...current,
          boundAt: now,
          ...(input.ttlMs === undefined ? {} : { expiresAt: now + input.ttlMs }),
          metadata: { ...input.metadata, lastActivityAt: now },
        };
        return current;
      }),
      touchAsync: vi.fn(async () => {}),
    };
    const runtime = vi.fn(async () => ({
      bindingRecord: current,
      boundSessionKey: targetSessionKey,
      route: { ...ordinaryRoute, sessionKey: targetSessionKey },
    }));
    const inbound = resolveZulipInboundBindingRoute(
      { cfg: {} as OpenClawConfig, route: ordinaryRoute, conversation },
      {
        resolveConfiguredBindingRoute: vi.fn(() => ({ bindingResolution: null, route: ordinaryRoute })),
        ensureConfiguredBindingRouteReady: vi.fn(),
        resolveRuntimeConversationBindingRouteAsync: runtime,
        getSessionBindingService: vi.fn(() => service),
      } as never,
    );
    const lifecycle = "idleTimeoutMs" in patch()
      ? setZulipBindingIdleTimeoutBySessionKey({
          targetSessionKey,
          accountId: "default",
          idleTimeoutMs: patch().idleTimeoutMs!,
        }, service as never)
      : setZulipBindingMaxAgeBySessionKey({
          targetSessionKey,
          accountId: "default",
          maxAgeMs: patch().maxAgeMs!,
        }, service as never);

    await expect(Promise.all([inbound, lifecycle])).resolves.toHaveLength(2);
    expect(current.metadata).toMatchObject({
      zulipIdleTimeoutMs: "idleTimeoutMs" in patch() ? 500 : 86_400_000,
      ...(patch().maxAgeMs === undefined ? {} : { zulipMaxAgeMs: 1_000 }),
    });
  });

  it("fails closed on concurrent conflicting lifecycle mutations", async () => {
    const targetSessionKey = "agent:bound:acp:conflict";
    const record = {
      ...bindingRecord("generic:conflict-binding", targetSessionKey, 100),
      metadata: { boundAt: 100, lastActivityAt: 150, zulipIdleTimeoutMs: 600 },
    };
    let current: SessionBindingRecord = record;
    let waiting = 0;
    let release!: () => void;
    const bothWaiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = {
      listBySession: vi.fn(() => [record]),
      resolveByConversation: vi.fn(() => current),
      bind: vi.fn(async (input: {
        assertCurrent?: () => void;
        metadata?: Record<string, unknown>;
      }) => {
        waiting += 1;
        if (waiting === 2) release();
        await bothWaiting;
        input.assertCurrent?.();
        current = {
          ...current,
          boundAt: 200 + service.bind.mock.calls.length,
          metadata: { ...input.metadata, lastActivityAt: 200 },
        };
        return current;
      }),
      touchAsync: vi.fn(async () => {}),
    };

    const settled = await Promise.allSettled([
      setZulipBindingIdleTimeoutBySessionKey({
        targetSessionKey,
        accountId: "default",
        idleTimeoutMs: 500,
      }, service as never),
      setZulipBindingIdleTimeoutBySessionKey({
        targetSessionKey,
        accountId: "default",
        idleTimeoutMs: 700,
      }, service as never),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        message: "Zulip conversation binding changed during lifecycle update",
      }),
    });
  });

  it("fails closed when the binding is unbound during a lifecycle mutation", async () => {
    const targetSessionKey = "agent:bound:acp:unbound";
    const record = bindingRecord("generic:unbound-binding", targetSessionKey, 100);
    const service = createService([record]);
    service.resolveByConversation.mockReturnValueOnce(null);

    await expect(setZulipBindingMaxAgeBySessionKey({
      targetSessionKey,
      accountId: "default",
      maxAgeMs: 1_000,
    }, service as never)).rejects.toThrow("changed during lifecycle update");
  });

  it("does not overwrite activity that advances after the lifecycle bind commits", async () => {
    const targetSessionKey = "agent:bound:acp:topic";
    const record = {
      ...bindingRecord("generic:topic-binding", targetSessionKey, 100),
      metadata: { boundAt: 100, lastActivityAt: 150, idleTimeoutMs: 500 },
    };
    let current: SessionBindingRecord = record;
    const service = {
      listBySession: vi.fn(() => [record]),
      resolveByConversation: vi.fn(() => current),
      bind: vi.fn(async (input: {
        assertCurrent?: () => void;
        metadata?: Record<string, unknown>;
      }) => {
        input.assertCurrent?.();
        const rebound = {
          ...current,
          boundAt: 200,
          metadata: { ...input.metadata, lastActivityAt: 200 },
        };
        current = {
          ...rebound,
          metadata: { ...rebound.metadata, lastActivityAt: 300 },
        };
        return rebound;
      }),
      touchAsync: vi.fn(async () => {}),
    };

    await expect(setZulipBindingIdleTimeoutBySessionKey({
      targetSessionKey,
      accountId: "default",
      idleTimeoutMs: 500,
    }, service as never)).resolves.toEqual([{
      boundAt: 100,
      lastActivityAt: 300,
      idleTimeoutMs: 500,
    }]);
    expect(current.metadata?.lastActivityAt).toBe(300);
    expect(service.touchAsync).not.toHaveBeenCalled();
  });

  it.each([
    ["target ownership", (rebound: SessionBindingRecord) => ({
      ...rebound,
      targetSessionKey: "agent:other:acp:replacement",
    })],
    ["status", (rebound: SessionBindingRecord) => ({
      ...rebound,
      status: "closed" as SessionBindingRecord["status"],
    })],
    ["lifecycle settings", (rebound: SessionBindingRecord) => ({
      ...rebound,
      metadata: { ...rebound.metadata, zulipIdleTimeoutMs: 700 },
    })],
  ] as const)("fails closed when post-commit %s changes at the same timestamps", async (_label, mutate) => {
    const targetSessionKey = "agent:bound:acp:post-commit";
    const record = {
      ...bindingRecord("generic:post-commit-binding", targetSessionKey, 100),
      expiresAt: 1_000,
      metadata: { boundAt: 100, lastActivityAt: 150, zulipIdleTimeoutMs: 600 },
    };
    let current: SessionBindingRecord = record;
    const service = {
      listBySession: vi.fn(() => [record]),
      resolveByConversation: vi.fn(() => current),
      bind: vi.fn(async (input: {
        assertCurrent?: () => void;
        metadata?: Record<string, unknown>;
      }) => {
        input.assertCurrent?.();
        const rebound: SessionBindingRecord = {
          ...record,
          boundAt: 200,
          expiresAt: 1_000,
          metadata: { ...input.metadata, lastActivityAt: 200 },
        };
        current = mutate(rebound);
        return rebound;
      }),
      touchAsync: vi.fn(async () => {}),
    };

    await expect(setZulipBindingIdleTimeoutBySessionKey({
      targetSessionKey,
      accountId: "default",
      idleTimeoutMs: 500,
    }, service as never)).rejects.toThrow("changed during lifecycle update");
  });

  it("leaves adapter-owned bindings to their adapter lifecycle contract", async () => {
    const targetSessionKey = "agent:bound:acp:adapter";
    const adapterRecord = bindingRecord("adapter-owned", targetSessionKey, 100);
    const service = createService([adapterRecord]);

    await expect(setZulipBindingIdleTimeoutBySessionKey({
      targetSessionKey,
      accountId: "default",
      idleTimeoutMs: 500,
    }, service as never)).resolves.toEqual([]);

    expect(service.bind).not.toHaveBeenCalled();
    expect(service.touchAsync).not.toHaveBeenCalled();
  });
});
