import { createHash } from "node:crypto";
import { createChannelDirectoryAdapter, type ChannelDirectoryEntry } from "openclaw/plugin-sdk/directory-runtime";
import { readChannelIngressStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeAccountId, type ChannelPlugin, type OpenClawConfig } from "./sdk.js";
import { normalizeZulipMessagingTarget } from "./normalize.js";
import { resolveDefaultZulipAccountId, resolveZulipRuntimeAccount, listZulipAccountIds, type ResolvedZulipAccount } from "./zulip/accounts.js";
import { createZulipClient, fetchZulipMe, fetchZulipSubscriptions, fetchZulipUsers, type ZulipClient } from "./zulip/client.js";
import { parseZulipTarget, isZulipSessionTarget } from "./zulip/destination.js";
import { resolveZulipInboundStreamPolicy, isZulipTopicAllowed, normalizeZulipStreamIdSelector, normalizeZulipStreamName } from "./zulip/stream-policy.js";

type Directory = NonNullable<ChannelPlugin["directory"]>;
type Resolver = NonNullable<ChannelPlugin["resolver"]>;
type ListParams = Parameters<NonNullable<Directory["listPeers"]>>[0];
type Scope = { cfg: OpenClawConfig; accountId?: string | null };
type Entry = ChannelDirectoryEntry & { userId?: string };
type CacheEntry = { expires: number; value: Promise<Entry[]> };
const cache = new WeakMap<OpenClawConfig, Map<string, CacheEntry>>();
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 32;

async function context(params: Scope) {
  const accountId = params.accountId?.trim() ? normalizeAccountId(params.accountId) : resolveDefaultZulipAccountId(params.cfg);
  if (!listZulipAccountIds(params.cfg).includes(accountId)) throw new Error(`Unknown Zulip account: ${accountId}`);
  const account = await resolveZulipRuntimeAccount({ cfg: params.cfg, accountId });
  if (!account.enabled || !account.baseUrl || !account.email || !account.apiKey) {
    throw new Error(`Zulip account ${accountId} is disabled or not configured`);
  }
  const client = createZulipClient({ baseUrl: account.baseUrl, email: account.email, apiKey: account.apiKey });
  const identity = createHash("sha256").update(JSON.stringify([accountId, account.baseUrl, account.email, account.apiKey])).digest("hex");
  return { account, client, identity };
}

async function cached(params: Scope, identity: string, kind: string, live: boolean, load: () => Promise<Entry[]>) {
  let entries = cache.get(params.cfg);
  if (!entries) cache.set(params.cfg, entries = new Map());
  const key = `${identity}:${kind}`;
  const now = Date.now();
  for (const [oldKey, entry] of entries) if (entry.expires <= now) entries.delete(oldKey);
  const existing = entries.get(key);
  if (!live && existing) return existing.value;
  entries.delete(key);
  while (entries.size >= MAX_CACHE_ENTRIES) entries.delete(entries.keys().next().value!);
  const entry: CacheEntry = { expires: Date.now() + CACHE_TTL_MS, value: load() };
  entries.set(key, entry);
  try {
    return await entry.value;
  } catch (error) {
    if (entries.get(key) === entry) entries.delete(key);
    throw error;
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function allowEntry(value: string | number): string {
  return normalize(String(value)).replace(/^(zulip|user):/, "").replace(/^@/, "");
}

async function peers(params: Scope, account: ResolvedZulipAccount, client: ZulipClient, identity: string, live: boolean) {
  const policy = account.config.dmPolicy ?? "pairing";
  if (policy === "disabled") return [];
  const store = await readChannelIngressStoreAllowFromForDmPolicy({ provider: "zulip", accountId: account.accountId, dmPolicy: policy });
  const allowed = [...(account.config.allowFrom ?? []), ...store].map(allowEntry);
  if (policy !== "open" && allowed.length === 0) return [];
  const users = await cached(params, identity, "users", live, async () => (await fetchZulipUsers(client))
    .filter(user => user.is_active !== false && user.email && /^[^\s@:]+@[^\s@:]+$/.test(user.email))
    .map(user => ({ kind: "user", id: `user:${user.email}`, name: user.full_name ?? undefined, handle: user.email!, userId: user.id })));
  return users.filter(user => policy === "open" || allowed.includes("*")
    || allowed.includes(allowEntry(user.id)) || allowed.includes(normalize(user.name ?? ""))
    || (user.userId !== undefined && allowed.includes(user.userId)));
}

async function groups(params: Scope, account: ResolvedZulipAccount, client: ZulipClient, identity: string, live: boolean) {
  const policy = account.config.groupPolicy ?? params.cfg.channels?.defaults?.groupPolicy ?? "allowlist";
  if (policy === "disabled") return [];
  const streams = await cached(params, identity, "streams", live, async () => (await fetchZulipSubscriptions(client))
    .filter(stream => stream.stream_id !== undefined && stream.name)
    .map(stream => ({ kind: "group", id: `stream:${stream.stream_id}`, name: stream.name })));
  return streams.filter(stream => {
    const decision = resolveZulipInboundStreamPolicy({ config: account.config, streamName: stream.name, streamId: stream.id.slice(7) });
    return decision.enabled && !decision.excludedTopics?.some(topic => topic.trim() === "*");
  });
}

function publicEntry({ userId: _userId, ...entry }: Entry): ChannelDirectoryEntry {
  return { ...entry };
}

function queryAndLimit(entries: Entry[], params: ListParams) {
  const query = normalize(params.query ?? "");
  const filtered = entries.filter(entry => [entry.id, entry.name, entry.handle].some(value => value?.toLowerCase().includes(query)));
  const limited = params.limit && params.limit > 0 ? filtered.slice(0, params.limit) : filtered;
  return limited.map(publicEntry);
}

async function list(params: ListParams, kind: "user" | "group", live = false) {
  const { account, client, identity } = await context(params);
  return queryAndLimit(await (kind === "user" ? peers : groups)(params, account, client, identity, live), params);
}

export const zulipDirectory: Directory = createChannelDirectoryAdapter({
  self: async params => {
    const { client, identity } = await context(params);
    const entries = await cached(params, identity, "self", false, async () => {
      const me = await fetchZulipMe(client);
      return me.email ? [{ kind: "user", id: `user:${me.email}`, name: me.full_name ?? undefined, handle: me.email }] : [];
    });
    return entries[0] ? publicEntry(entries[0]) : null;
  },
  listPeers: params => list(params, "user"),
  listPeersLive: params => list(params, "user", true),
  listGroups: params => list(params, "group"),
  listGroupsLive: params => list(params, "group", true),
});

export const zulipResolver: Resolver = {
  resolveTargets: async params => {
    const { account, client, identity } = await context(params);
    const entries = await (params.kind === "user" ? peers : groups)(params, account, client, identity, false);
    return params.inputs.map(input => {
      try {
        if (isZulipSessionTarget(input)) throw new Error("Session identities are not Zulip destinations");
        let selector: string;
        let topic: string | undefined;
        if (params.kind === "group") {
          const normalized = normalizeZulipMessagingTarget(input);
          if (!normalized) throw new Error("Invalid Zulip stream target");
          const target = parseZulipTarget(normalized);
          if (target.kind !== "stream") throw new Error("Expected a Zulip stream target");
          selector = target.stream;
          topic = target.topic;
        } else {
          if (/^(stream:|#)/i.test(input.trim())) throw new Error("Expected a Zulip user target");
          selector = input.trim().replace(/^(user|dm|zulip):/i, "").replace(/^@/, "");
        }
        const selectorId = normalizeZulipStreamIdSelector(selector);
        const field = selectorId !== undefined ? "id" : params.kind === "user" && selector.includes("@") ? "email" : "name";
        const matches = entries.filter(entry => {
          if (field === "id") {
            const id = params.kind === "user" ? entry.userId : entry.id.slice(7);
            return id !== undefined && normalizeZulipStreamIdSelector(id) === selectorId;
          }
          if (field === "email") return entry.handle !== undefined && normalize(entry.handle) === normalize(selector);
          if (!entry.name) return false;
          return params.kind === "group"
            ? normalizeZulipStreamName(entry.name) === normalizeZulipStreamName(selector)
            : normalize(entry.name) === normalize(selector);
        });
        if (matches.length !== 1) return { input, resolved: false, note: matches.length > 1
          ? `Ambiguous Zulip ${params.kind} "${selector}"; use an exact ${params.kind === "user" ? "email or user ID" : "stream ID"}`
          : `Zulip ${params.kind} not found or not permitted: ${selector}` };
        const match = matches[0];
        if (topic !== undefined && !isZulipTopicAllowed({ topic, policy: resolveZulipInboundStreamPolicy({ config: account.config, streamName: match.name, streamId: match.id.slice(7) }) })) {
          throw new Error("Zulip topic is not permitted");
        }
        return { input, resolved: true, id: topic === undefined ? match.id : `${match.id}:${topic}`, name: match.name };
      } catch (error) {
        return { input, resolved: false, note: error instanceof Error ? error.message : String(error) };
      }
    });
  },
};
