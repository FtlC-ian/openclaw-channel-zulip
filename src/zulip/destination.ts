export type ZulipTarget =
  | { kind: "stream"; stream: string; topic?: string }
  | { kind: "user"; email: string };

const DEFAULT_TOPIC = "general";

export function isZulipSessionTarget(raw: string): boolean {
  const trimmed = raw.trim();
  return /^(?:agent:[^:]+:zulip:|(?:(?:channel|group):)?\d+:topic:v\d+:)/i.test(trimmed)
    || /^(?:user:)?account-[a-f0-9]{64}:[^\s@:]+@[^\s@:]+$/i.test(trimmed);
}

function normalizeLegacyZulipTarget(raw: string): { normalized: string; convertedFromLegacy: boolean } {
  const candidate = raw.trimStart();
  if (isZulipSessionTarget(candidate)) {
    throw new Error("Zulip session identities are not message destinations; use the saved stream/topic route");
  }
  const legacyMatch = candidate.match(/^(\d+):topic:(.*)$/s);
  if (!legacyMatch) {
    const lower = candidate.toLowerCase();
    if (lower.startsWith("stream:")) {
      const rest = candidate.slice("stream:".length);
      const hasTopicSeparator = [rest.indexOf(":"), rest.indexOf("/"), rest.indexOf("#")]
        .some(index => index >= 0);
      return {
        normalized: hasTopicSeparator ? candidate : candidate.trimEnd(),
        convertedFromLegacy: false,
      };
    }
    if (candidate.startsWith("#")) {
      const rest = candidate.slice(1);
      const hasTopicSeparator = rest.indexOf(":") >= 0 || rest.indexOf("/") >= 0;
      return {
        normalized: hasTopicSeparator ? candidate : candidate.trimEnd(),
        convertedFromLegacy: false,
      };
    }
    return { normalized: candidate.trimEnd(), convertedFromLegacy: false };
  }
  const [, streamId, topic] = legacyMatch;
  return {
    normalized: `stream:${streamId}:${topic}`,
    convertedFromLegacy: true,
  };
}

export { normalizeLegacyZulipTarget };

function isCanonicalDmEmail(value: string): boolean {
  return /^[^\s@:]+@[^\s@:]+$/.test(value);
}

export function parseZulipTarget(raw: string): ZulipTarget {
  const { normalized } = normalizeLegacyZulipTarget(raw);
  if (!normalized.trim()) {
    throw new Error("Recipient is required for Zulip sends");
  }
  const lower = normalized.toLowerCase();
  if (lower.startsWith("stream:")) {
    const rest = normalized.slice("stream:".length);
    const colonIdx = rest.indexOf(":");
    const slashIdx = rest.indexOf("/");
    const hashIdx = rest.indexOf("#");
    const sepIdx = [colonIdx, slashIdx, hashIdx].filter(i => i >= 0).reduce((a, b) => Math.min(a, b), Infinity);
    const stream = sepIdx === Infinity ? rest : rest.slice(0, sepIdx);
    const topic = sepIdx === Infinity ? undefined : rest.slice(sepIdx + 1);
    if (!stream.trim()) throw new Error("Stream name is required for Zulip sends");
    return { kind: "stream", stream: stream.trim(), topic };
  }
  if (lower.startsWith("user:") || lower.startsWith("dm:")) {
    const email = normalized.slice(normalized.indexOf(":") + 1).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages");
    }
    if (!isCanonicalDmEmail(email)) {
      throw new Error("Invalid Zulip direct-message target; expected an email address");
    }
    return { kind: "user", email };
  }
  if (lower.startsWith("zulip:")) {
    const email = normalized.slice("zulip:".length).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages");
    }
    if (!isCanonicalDmEmail(email)) {
      throw new Error("Invalid Zulip direct-message target; expected an email address");
    }
    return { kind: "user", email };
  }
  if (normalized.startsWith("@")) {
    const email = normalized.slice(1).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages");
    }
    if (!isCanonicalDmEmail(email)) {
      throw new Error("Invalid Zulip direct-message target; expected an email address");
    }
    return { kind: "user", email };
  }
  if (normalized.startsWith("#")) {
    const rest = normalized.slice(1);
    const sepIdx2 = [rest.indexOf(":"), rest.indexOf("/")].filter(i => i >= 0).reduce((a, b) => Math.min(a, b), Infinity);
    const stream2 = sepIdx2 === Infinity ? rest : rest.slice(0, sepIdx2);
    const topic2 = sepIdx2 === Infinity ? undefined : rest.slice(sepIdx2 + 1);
    if (!stream2.trim()) {
      throw new Error("Stream name is required for Zulip sends");
    }
    return { kind: "stream", stream: stream2.trim(), topic: topic2 };
  }
  const trimmed = normalized.trim();
  if (isCanonicalDmEmail(trimmed)) {
    return { kind: "user", email: trimmed };
  }
  return { kind: "stream", stream: trimmed };
}

export function resolveZulipDestination(raw: string, topic?: string | number | null, defaultTopic?: string) {
  const target = parseZulipTarget(raw);
  return target.kind === "user"
    ? target
    : { ...target, topic: target.topic ?? (topic == null ? defaultTopic?.trim() ?? DEFAULT_TOPIC : String(topic).trim()) };
}
