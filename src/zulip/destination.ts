export type ZulipTarget =
  | { kind: "stream"; stream: string; topic?: string }
  | { kind: "user"; email: string };

const DEFAULT_TOPIC = "general";

function normalizeLegacyZulipTarget(raw: string): { normalized: string; convertedFromLegacy: boolean } {
  const trimmed = raw.trim();
  if (/^(?:agent:[^:]+:zulip:|(?:(?:channel|group):)?\d+:topic:v\d+:)/i.test(trimmed)) {
    throw new Error("Zulip session identities are not message destinations; use the saved stream/topic route");
  }
  const legacyMatch = trimmed.match(/^(\d+):topic:(.*)$/);
  if (!legacyMatch) {
    return { normalized: trimmed, convertedFromLegacy: false };
  }
  const [, streamId, topic] = legacyMatch;
  return {
    normalized: `stream:${streamId}:${topic.trim()}`,
    convertedFromLegacy: true,
  };
}

export { normalizeLegacyZulipTarget };

function isCanonicalDmEmail(value: string): boolean {
  return /^[^\s@:]+@[^\s@:]+$/.test(value);
}

export function parseZulipTarget(raw: string): ZulipTarget {
  const { normalized } = normalizeLegacyZulipTarget(raw);
  const trimmed = normalized.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Zulip sends");
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("stream:")) {
    const rest = trimmed.slice("stream:".length).trim();
    if (!rest) {
      throw new Error("Stream name is required for Zulip sends");
    }
    const colonIdx = rest.indexOf(":");
    const slashIdx = rest.indexOf("/");
    const hashIdx = rest.indexOf("#");
    const sepIdx = [colonIdx, slashIdx, hashIdx].filter(i => i >= 0).reduce((a, b) => Math.min(a, b), Infinity);
    const stream = sepIdx === Infinity ? rest : rest.slice(0, sepIdx);
    const topic = sepIdx === Infinity ? undefined : rest.slice(sepIdx + 1);
    if (!stream.trim()) throw new Error("Stream name is required for Zulip sends");
    return { kind: "stream", stream: stream.trim(), topic: topic?.trim() };
  }
  if (lower.startsWith("user:") || lower.startsWith("dm:")) {
    const email = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages");
    }
    if (!isCanonicalDmEmail(email)) {
      throw new Error("Invalid Zulip direct-message target; expected an email address");
    }
    return { kind: "user", email };
  }
  if (lower.startsWith("zulip:")) {
    const email = trimmed.slice("zulip:".length).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages");
    }
    if (!isCanonicalDmEmail(email)) {
      throw new Error("Invalid Zulip direct-message target; expected an email address");
    }
    return { kind: "user", email };
  }
  if (trimmed.startsWith("@")) {
    const email = trimmed.slice(1).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages");
    }
    if (!isCanonicalDmEmail(email)) {
      throw new Error("Invalid Zulip direct-message target; expected an email address");
    }
    return { kind: "user", email };
  }
  if (trimmed.startsWith("#")) {
    const rest = trimmed.slice(1).trim();
    const sepIdx2 = [rest.indexOf(":"), rest.indexOf("/")].filter(i => i >= 0).reduce((a, b) => Math.min(a, b), Infinity);
    const stream2 = sepIdx2 === Infinity ? rest : rest.slice(0, sepIdx2);
    const topic2 = sepIdx2 === Infinity ? undefined : rest.slice(sepIdx2 + 1);
    if (!stream2) {
      throw new Error("Stream name is required for Zulip sends");
    }
    return { kind: "stream", stream: stream2.trim(), topic: topic2?.trim() };
  }
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
