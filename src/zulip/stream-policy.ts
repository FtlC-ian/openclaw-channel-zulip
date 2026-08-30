import type { ZulipAccountConfig, ZulipStreamRule } from "../types.js";

export type ResolvedZulipInboundStreamPolicy = {
  enabled: boolean;
  requireMention?: boolean;
  allowedTopics?: string[];
  additionalAllowedTopics?: string[];
  excludedTopics?: string[];
  matchedNameKey?: string;
  matchedIdKey?: string;
};

export function normalizeZulipStreamName(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLocaleLowerCase("en-US");
  return normalized || undefined;
}

export function normalizeZulipStreamIdSelector(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed.replace(/^0+(?=\d)/, "");
}

function normalizeTopic(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function normalizeAllowedTopics(values: string[] | undefined): Set<string> | undefined {
  const normalized = (values ?? []).map(normalizeTopic).filter(Boolean);
  if (normalized.length === 0 || normalized.includes("*")) {
    return undefined;
  }
  return new Set(normalized);
}

function normalizeExcludedTopics(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map(normalizeTopic).filter(Boolean));
}

function findLegacyStreamTopics(params: {
  streamTopics?: Record<string, string[]>;
  streamName?: string;
  streamId: string;
}): string[] | undefined {
  const normalizedName = normalizeZulipStreamName(params.streamName);
  const normalizedId = normalizeZulipStreamIdSelector(params.streamId);
  const nameMatch = normalizedName
    ? Object.entries(params.streamTopics ?? {}).find(([key]) =>
        normalizeZulipStreamIdSelector(key) === undefined &&
        normalizeZulipStreamName(key) === normalizedName,
      )
    : undefined;
  const idMatch = Object.entries(params.streamTopics ?? {}).find(([key]) => {
    const selector = normalizeZulipStreamIdSelector(key);
    return selector !== undefined && selector === normalizedId;
  });
  return idMatch?.[1] ?? nameMatch?.[1];
}

function findRules(params: {
  rules?: Record<string, ZulipStreamRule>;
  streamName?: string;
  streamId: string;
}): {
  nameRule?: [string, ZulipStreamRule];
  idRule?: [string, ZulipStreamRule];
} {
  const normalizedName = normalizeZulipStreamName(params.streamName);
  const normalizedId = normalizeZulipStreamIdSelector(params.streamId);
  let nameRule: [string, ZulipStreamRule] | undefined;
  let idRule: [string, ZulipStreamRule] | undefined;

  for (const entry of Object.entries(params.rules ?? {})) {
    const idSelector = normalizeZulipStreamIdSelector(entry[0]);
    if (idSelector !== undefined) {
      if (idSelector === normalizedId) {
        idRule = entry;
      }
      continue;
    }
    if (normalizedName && normalizeZulipStreamName(entry[0]) === normalizedName) {
      nameRule = entry;
    }
  }
  return { nameRule, idRule };
}

function legacyStreamEnabled(streams: string[] | undefined, streamName: string | undefined): boolean {
  if (!streams || streams.length === 0 || streams.some((entry) => entry.trim() === "*")) {
    return true;
  }
  const normalizedName = normalizeZulipStreamName(streamName);
  return Boolean(normalizedName) && streams.some(
    (entry) => normalizeZulipStreamName(entry) === normalizedName,
  );
}

export function resolveZulipInboundStreamPolicy(params: {
  config: ZulipAccountConfig;
  streamName?: string;
  streamId: string;
}): ResolvedZulipInboundStreamPolicy {
  const legacyAllowedTopics = findLegacyStreamTopics({
    streamTopics: params.config.streamTopics,
    streamName: params.streamName,
    streamId: params.streamId,
  });
  const { nameRule, idRule } = findRules({
    rules: params.config.streamOverrides,
    streamName: params.streamName,
    streamId: params.streamId,
  });

  const policy: ResolvedZulipInboundStreamPolicy = {
    enabled: legacyStreamEnabled(params.config.streams, params.streamName),
    allowedTopics: params.config.topics,
    additionalAllowedTopics: legacyAllowedTopics,
  };
  for (const rule of [nameRule?.[1], idRule?.[1]]) {
    if (!rule) {
      continue;
    }
    if (rule.enabled !== undefined) {
      policy.enabled = rule.enabled;
    }
    if (rule.requireMention !== undefined) {
      policy.requireMention = rule.requireMention;
    }
    if (rule.allowedTopics !== undefined) {
      policy.allowedTopics = rule.allowedTopics;
      policy.additionalAllowedTopics = undefined;
    }
    if (rule.excludedTopics !== undefined) {
      policy.excludedTopics = rule.excludedTopics;
    }
  }
  policy.matchedNameKey = nameRule?.[0];
  policy.matchedIdKey = idRule?.[0];
  return policy;
}

export function isZulipTopicAllowed(params: {
  topic: string;
  policy: Pick<
    ResolvedZulipInboundStreamPolicy,
    "allowedTopics" | "additionalAllowedTopics" | "excludedTopics"
  >;
}): boolean {
  const topic = normalizeTopic(params.topic);
  const allowed = normalizeAllowedTopics(params.policy.allowedTopics);
  if (allowed && !allowed.has(topic)) {
    return false;
  }
  const additionalAllowed = normalizeAllowedTopics(params.policy.additionalAllowedTopics);
  if (additionalAllowed && !additionalAllowed.has(topic)) {
    return false;
  }
  const excluded = normalizeExcludedTopics(params.policy.excludedTopics);
  return !excluded.has("*") && !excluded.has(topic);
}
