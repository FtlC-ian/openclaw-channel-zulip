import { createHash } from "node:crypto";
import { createDurableInboundReceiveJournal } from "openclaw/plugin-sdk/channel-outbound";
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
  if (typeof runtime.state?.openKeyedStore !== "function") {
    throw new Error("plugin keyed state is not available");
  }
  const accountPart = hashNamespacePart(accountId);
  return createDurableInboundReceiveJournal<
    ZulipDurableInboundPayload,
    ZulipDurableInboundMetadata,
    ZulipDurableInboundCompletedMetadata
  >({
    pendingStore: runtime.state.openKeyedStore({
      namespace: `inbound.v1.pending.${accountPart}`,
      maxEntries: ZULIP_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
      defaultTtlMs: ZULIP_DURABLE_INBOUND_PENDING_TTL_MS,
    }),
    completedStore: runtime.state.openKeyedStore({
      namespace: `inbound.v1.completed.${accountPart}`,
      maxEntries: ZULIP_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES,
      defaultTtlMs: ZULIP_DURABLE_INBOUND_COMPLETED_TTL_MS,
    }),
    pendingTtlMs: ZULIP_DURABLE_INBOUND_PENDING_TTL_MS,
    completedTtlMs: ZULIP_DURABLE_INBOUND_COMPLETED_TTL_MS,
  });
}
