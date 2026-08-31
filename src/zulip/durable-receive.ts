import { createHash } from "node:crypto";
import { createDurableInboundReceiveJournalFromQueue } from "openclaw/plugin-sdk/channel-outbound";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

import { getZulipRuntime } from "../runtime.js";

const ZULIP_DURABLE_INBOUND_PENDING_MAX_ENTRIES = 250;
const ZULIP_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES = 700;
const ZULIP_DURABLE_INBOUND_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ZULIP_DURABLE_INBOUND_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SerializedZulipDurableInboundMessage = PluginJsonValue;

export type ZulipDurableInboundPayload = {
  message: SerializedZulipDurableInboundMessage;
  receivedAt: number;
};

export type ZulipDurableInboundMetadata = {
  queueEventId?: number;
};

export type ZulipDurableInboundCompletedMetadata = {
  queueEventId?: number;
};

type LegacyPendingRecord = {
  id: string;
  payload: ZulipDurableInboundPayload;
  metadata?: ZulipDurableInboundMetadata;
  receivedAt: number;
  updatedAt: number;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
};

type LegacyCompletedRecord = {
  id: string;
  completedAt: number;
  metadata?: ZulipDurableInboundCompletedMetadata;
};

function hashNamespacePart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function createZulipDurableInboundMessageId(params: {
  accountId: string;
  messageId: string;
}): string {
  return createHash("sha256")
    .update(`${params.accountId}\n${params.messageId}`)
    .digest("hex");
}

export function serializeZulipDurableInboundMessage<T>(
  message: T,
): SerializedZulipDurableInboundMessage {
  return JSON.parse(JSON.stringify(message)) as PluginJsonValue;
}

export function deserializeZulipDurableInboundMessage<T>(
  message: SerializedZulipDurableInboundMessage,
): T {
  return JSON.parse(JSON.stringify(message)) as T;
}

export function createZulipDurableInboundReceiveJournal(accountId: string) {
  const runtime = getZulipRuntime();
  if (
    typeof runtime.state?.openKeyedStore !== "function" ||
    typeof runtime.state?.openChannelIngressQueue !== "function"
  ) {
    throw new Error("durable plugin state is not available");
  }
  const accountPart = hashNamespacePart(accountId);
  const legacyPendingStore = runtime.state.openKeyedStore<LegacyPendingRecord>({
    namespace: `inbound.v1.pending.${accountPart}`,
    maxEntries: ZULIP_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
    defaultTtlMs: ZULIP_DURABLE_INBOUND_PENDING_TTL_MS,
  });
  const legacyCompletedStore = runtime.state.openKeyedStore<LegacyCompletedRecord>({
    namespace: `inbound.v1.completed.${accountPart}`,
    maxEntries: ZULIP_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES,
    defaultTtlMs: ZULIP_DURABLE_INBOUND_COMPLETED_TTL_MS,
  });
  const queueJournal = createDurableInboundReceiveJournalFromQueue<
    ZulipDurableInboundPayload,
    ZulipDurableInboundMetadata,
    ZulipDurableInboundCompletedMetadata
  >({
    queue: runtime.state.openChannelIngressQueue<
      ZulipDurableInboundPayload,
      ZulipDurableInboundMetadata,
      ZulipDurableInboundCompletedMetadata
    >({ accountId }),
    retention: {
      pendingTtlMs: ZULIP_DURABLE_INBOUND_PENDING_TTL_MS,
      completedTtlMs: ZULIP_DURABLE_INBOUND_COMPLETED_TTL_MS,
      pendingMaxEntries: ZULIP_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
      completedMaxEntries: ZULIP_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES,
    },
  });

  const normalizeId = (id: string) => {
    const normalized = id.trim();
    if (!normalized) {
      throw new Error("Durable inbound receive id cannot be empty");
    }
    return normalized;
  };

  return {
    accept: async (
      id: string,
      payload: ZulipDurableInboundPayload,
      options?: { metadata?: ZulipDurableInboundMetadata; receivedAt?: number },
    ) => {
      const key = normalizeId(id);
      const completed = await legacyCompletedStore.lookup(key);
      if (completed) {
        return { kind: "completed" as const, duplicate: true as const, record: completed };
      }
      const pending = await legacyPendingStore.lookup(key);
      if (pending) {
        return { kind: "pending" as const, duplicate: true as const, record: pending };
      }
      const result = await queueJournal.accept(key, payload, options);
      const completedAfterAccept = await legacyCompletedStore.lookup(key);
      if (!completedAfterAccept) {
        return result;
      }
      await queueJournal.complete(key, {
        metadata: completedAfterAccept.metadata,
        completedAt: completedAfterAccept.completedAt,
      });
      return {
        kind: "completed" as const,
        duplicate: true as const,
        record: completedAfterAccept,
      };
    },
    pending: async () => {
      const legacyEntries = await legacyPendingStore.entries();
      const legacyPending: LegacyPendingRecord[] = [];
      for (const entry of legacyEntries) {
        if (await legacyCompletedStore.lookup(entry.key)) {
          await legacyPendingStore.delete(entry.key);
        } else {
          legacyPending.push(entry.value);
        }
      }
      const queuePending = await queueJournal.pending();
      const records = new Map<string, LegacyPendingRecord>();
      for (const record of legacyPending) {
        records.set(record.id, record);
      }
      for (const record of queuePending) {
        const completed = await legacyCompletedStore.lookup(record.id);
        if (completed) {
          await queueJournal.complete(record.id, {
            metadata: completed.metadata,
            completedAt: completed.completedAt,
          });
        } else {
          records.set(record.id, record);
        }
      }
      return [...records.values()].sort(
        (left, right) => left.receivedAt - right.receivedAt || left.id.localeCompare(right.id),
      );
    },
    complete: async (
      id: string,
      options?: { metadata?: ZulipDurableInboundCompletedMetadata; completedAt?: number },
    ) => {
      const key = normalizeId(id);
      const legacyPending = await legacyPendingStore.lookup(key);
      const completedAt = options?.completedAt ?? Date.now();
      if (legacyPending) {
        const record: LegacyCompletedRecord = {
          id: key,
          completedAt,
          ...(options?.metadata === undefined ? {} : { metadata: options.metadata }),
        };
        await legacyCompletedStore.register(key, record, {
          ttlMs: ZULIP_DURABLE_INBOUND_COMPLETED_TTL_MS,
        });
      }
      await queueJournal.complete(key, { ...options, completedAt });
      if (legacyPending) {
        await legacyPendingStore.delete(key);
      }
    },
    release: async (
      id: string,
      options?: { lastError?: string; releasedAt?: number },
    ) => {
      const key = normalizeId(id);
      const pending = await legacyPendingStore.lookup(key);
      if (!pending) {
        return await queueJournal.release(key, options);
      }
      const releasedAt = options?.releasedAt ?? Date.now();
      const next: LegacyPendingRecord = {
        ...pending,
        updatedAt: releasedAt,
        attempts: pending.attempts + 1,
        lastAttemptAt: releasedAt,
        ...(options?.lastError === undefined ? {} : { lastError: options.lastError }),
      };
      if (legacyPendingStore.update) {
        await legacyPendingStore.update(
          key,
          (current) => current ? {
            ...current,
            updatedAt: releasedAt,
            attempts: current.attempts + 1,
            lastAttemptAt: releasedAt,
            ...(options?.lastError === undefined ? {} : { lastError: options.lastError }),
          } : undefined,
          { ttlMs: ZULIP_DURABLE_INBOUND_PENDING_TTL_MS },
        );
      } else {
        await legacyPendingStore.register(key, next, {
          ttlMs: ZULIP_DURABLE_INBOUND_PENDING_TTL_MS,
        });
      }
      return true;
    },
    deletePending: async (id: string) => {
      const key = normalizeId(id);
      const [legacyDeleted, queueDeleted] = await Promise.all([
        legacyPendingStore.delete(key),
        queueJournal.deletePending(key),
      ]);
      return legacyDeleted || queueDeleted;
    },
  };
}
