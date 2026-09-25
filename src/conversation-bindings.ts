import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "./sdk.js";
import {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
} from "./sdk.js";
import { resolveRuntimeConversationBindingRouteAsync } from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  getSessionBindingService,
  type SessionBindingRecord,
  type resolveRuntimeConversationBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";

type AgentRoute = Parameters<typeof resolveConfiguredBindingRoute>[0]["route"];
type Conversation = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};
type RuntimeBindingRouteResolver = (
  params: Parameters<typeof resolveRuntimeConversationBindingRoute>[0],
) => Promise<ReturnType<typeof resolveRuntimeConversationBindingRoute>>;
type BindingDependencies = {
  resolveConfiguredBindingRoute: typeof resolveConfiguredBindingRoute;
  ensureConfiguredBindingRouteReady: typeof ensureConfiguredBindingRouteReady;
  resolveRuntimeConversationBindingRouteAsync: RuntimeBindingRouteResolver;
  getSessionBindingService: typeof getSessionBindingService;
};

type BindingLifecycleRecord = {
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

type SessionBindingService = ReturnType<typeof getSessionBindingService>;
const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const LIFECYCLE_UPDATE_ATTEMPTS = 3;

class BindingActivityChangedError extends Error {}

function sameConversation(
  left: SessionBindingRecord["conversation"],
  right: SessionBindingRecord["conversation"],
): boolean {
  return left.channel === right.channel &&
    left.accountId === right.accountId &&
    left.conversationId === right.conversationId &&
    left.parentConversationId === right.parentConversationId;
}

function sameBindingGeneration(
  left: SessionBindingRecord | null,
  right: SessionBindingRecord,
): boolean {
  return left !== null &&
    left.bindingId === right.bindingId &&
    left.targetSessionKey === right.targetSessionKey &&
    left.targetKind === right.targetKind &&
    left.status === right.status &&
    left.boundAt === right.boundAt &&
    left.expiresAt === right.expiresAt &&
    sameConversation(left.conversation, right.conversation);
}

function metadataWithoutActivity(record: SessionBindingRecord): Record<string, unknown> {
  const metadata = { ...record.metadata };
  delete metadata.lastActivityAt;
  return metadata;
}

function sameLifecycleMetadata(
  left: SessionBindingRecord,
  right: SessionBindingRecord,
): boolean {
  return isDeepStrictEqual(metadataWithoutActivity(left), metadataWithoutActivity(right));
}

function finiteMetadataNumber(record: SessionBindingRecord, key: string): number | undefined {
  const value = record.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lifecycleRecord(record: SessionBindingRecord): BindingLifecycleRecord {
  return {
    boundAt: finiteMetadataNumber(record, "boundAt") ?? record.boundAt,
    lastActivityAt: finiteMetadataNumber(record, "lastActivityAt") ?? record.boundAt,
    idleTimeoutMs:
      finiteMetadataNumber(record, "zulipIdleTimeoutMs") ??
      finiteMetadataNumber(record, "idleTimeoutMs") ??
      DEFAULT_IDLE_TIMEOUT_MS,
    ...(finiteMetadataNumber(record, "zulipMaxAgeMs") === undefined &&
      finiteMetadataNumber(record, "maxAgeMs") === undefined
      ? {}
      : {
          maxAgeMs:
            finiteMetadataNumber(record, "zulipMaxAgeMs") ??
            finiteMetadataNumber(record, "maxAgeMs"),
        }),
  };
}

function lifecycleTtlMs(record: BindingLifecycleRecord, now: number): number | undefined {
  const expirations = [
    record.idleTimeoutMs && record.idleTimeoutMs > 0
      ? record.lastActivityAt + record.idleTimeoutMs
      : undefined,
    record.maxAgeMs && record.maxAgeMs > 0 ? record.boundAt + record.maxAgeMs : undefined,
  ].filter((value): value is number => value !== undefined);
  if (expirations.length === 0) return undefined;
  return Math.max(0, Math.min(...expirations) - now);
}

async function updateZulipBindingLifecycleRecord(
  record: SessionBindingRecord,
  patch: Pick<BindingLifecycleRecord, "idleTimeoutMs" | "maxAgeMs">,
  service: SessionBindingService,
): Promise<BindingLifecycleRecord> {
  let candidate = record;
  for (let attempt = 0; attempt < LIFECYCLE_UPDATE_ATTEMPTS; attempt += 1) {
    const next = { ...lifecycleRecord(candidate), ...patch };
    const now = Date.now();
    const ttlMs = lifecycleTtlMs(next, now);
    try {
      const rebound = await service.bind({
        targetSessionKey: candidate.targetSessionKey,
        targetKind: candidate.targetKind,
        conversation: candidate.conversation,
        placement: "current",
        metadata: {
          ...candidate.metadata,
          ...next,
          idleTimeoutMs: next.idleTimeoutMs && next.idleTimeoutMs > 0
            ? Math.max(0, next.lastActivityAt + next.idleTimeoutMs - now)
            : 0,
          zulipIdleTimeoutMs: next.idleTimeoutMs,
          ...(next.maxAgeMs === undefined
            ? {}
            : {
                maxAgeMs: next.maxAgeMs > 0
                  ? Math.max(0, next.boundAt + next.maxAgeMs - now)
                  : 0,
                zulipMaxAgeMs: next.maxAgeMs,
              }),
        },
        ...(ttlMs === undefined ? {} : { ttlMs }),
        assertCurrent: () => {
          const current = service.resolveByConversation(candidate.conversation);
          if (!sameBindingGeneration(current, candidate) || !current) {
            throw new Error("Zulip conversation binding changed during lifecycle update");
          }
          if (!sameLifecycleMetadata(current, candidate)) {
            throw new Error("Zulip conversation binding changed during lifecycle update");
          }
          if (finiteMetadataNumber(current, "lastActivityAt") !==
              finiteMetadataNumber(candidate, "lastActivityAt")) {
            throw new BindingActivityChangedError();
          }
        },
      });
      return lifecycleRecord(rebound);
    } catch (error) {
      if (!(error instanceof BindingActivityChangedError)) throw error;
      const current = service.resolveByConversation(candidate.conversation);
      if (!sameBindingGeneration(current, candidate) || !current ||
          !sameLifecycleMetadata(current, candidate)) {
        throw new Error("Zulip conversation binding changed during lifecycle update");
      }
      candidate = current;
    }
  }
  throw new Error("Zulip conversation binding activity changed repeatedly during lifecycle update");
}

async function setZulipBindingLifecycleBySessionKey(
  params: {
    targetSessionKey: string;
    accountId?: string | null;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
  },
  service: SessionBindingService = getSessionBindingService(),
): Promise<BindingLifecycleRecord[]> {
  const targetSessionKey = params.targetSessionKey.trim();
  const accountId = params.accountId?.trim();
  if (!targetSessionKey) return [];
  const records = service.listBySession(targetSessionKey).filter((record) =>
    record.bindingId.startsWith("generic:") &&
    record.conversation.channel === "zulip" &&
    (!accountId || record.conversation.accountId === accountId)
  );
  const updated: BindingLifecycleRecord[] = [];
  for (const record of records) {
    updated.push(await updateZulipBindingLifecycleRecord(record, {
      ...(params.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: Math.max(0, Math.floor(params.idleTimeoutMs)) }),
      ...(params.maxAgeMs === undefined
        ? {}
        : { maxAgeMs: Math.max(0, Math.floor(params.maxAgeMs)) }),
    }, service));
  }
  return updated;
}

export async function setZulipBindingIdleTimeoutBySessionKey(
  params: { targetSessionKey: string; accountId?: string | null; idleTimeoutMs: number },
  service?: SessionBindingService,
) {
  return setZulipBindingLifecycleBySessionKey(params, service);
}

export async function setZulipBindingMaxAgeBySessionKey(
  params: { targetSessionKey: string; accountId?: string | null; maxAgeMs: number },
  service?: SessionBindingService,
) {
  return setZulipBindingLifecycleBySessionKey(params, service);
}

export async function resolveZulipInboundBindingRoute(
  params: {
    cfg: OpenClawConfig;
    route: AgentRoute;
    conversation: Conversation;
  },
  dependencies: BindingDependencies = {
    resolveConfiguredBindingRoute,
    ensureConfiguredBindingRouteReady,
    resolveRuntimeConversationBindingRouteAsync,
    getSessionBindingService,
  },
) {
  const configured = dependencies.resolveConfiguredBindingRoute(params);
  let runtime = await dependencies.resolveRuntimeConversationBindingRouteAsync({
    route: configured.route,
    conversation: params.conversation,
  });
  if (runtime.bindingRecord?.bindingId.startsWith("generic:")) {
    await updateZulipBindingLifecycleRecord(
      runtime.bindingRecord,
      {},
      dependencies.getSessionBindingService(),
    );
    runtime = await dependencies.resolveRuntimeConversationBindingRouteAsync({
      route: configured.route,
      conversation: params.conversation,
    });
  }
  const configuredSelected =
    configured.bindingResolution !== null &&
    runtime.bindingOwnerAvailable !== false &&
    runtime.bindingRecord === null;
  if (configuredSelected) {
    const ready = await dependencies.ensureConfiguredBindingRouteReady({
      cfg: params.cfg,
      bindingResolution: configured.bindingResolution,
    });
    if (!ready.ok) {
      throw new Error(`Configured Zulip conversation binding unavailable: ${ready.error}`);
    }
  }
  return {
    ...runtime,
    boundSessionKey:
      runtime.boundSessionKey ?? (configuredSelected ? configured.boundSessionKey : undefined),
  };
}
