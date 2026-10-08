import type { ChannelPlugin } from "./sdk.js";
import { resolveZulipAccount, type ResolvedZulipAccount } from "./zulip/accounts.js";
import { fetchZulipUsers, resolveZulipStreamId, type ZulipClient } from "./zulip/client.js";
import { getZulipConnection, type ZulipConnection, type ZulipTypingTarget } from "./zulip/connection.js";
import { resolveZulipDestination } from "./zulip/destination.js";

type Adapter = NonNullable<ChannelPlugin<ResolvedZulipAccount>["heartbeat"]>;
type Params = Parameters<NonNullable<Adapter["sendTyping"]>>[0];
type Guarded = Parameters<NonNullable<Adapter["sendTypingGuarded"]>>[0];
type Route = { version: number; lastUsed: number; target?: ZulipTypingTarget };
const routes = new WeakMap<ZulipConnection, Map<string, Route>>();

function routeFor(params: Params) {
  const account = resolveZulipAccount(params);
  const connection = getZulipConnection(account.accountId);
  if (!connection) return;
  const destination = resolveZulipDestination(params.to, params.threadId, account.config.defaultTopic);
  const key = JSON.stringify(destination.kind === "user" ? { ...destination, email: destination.email.toLowerCase() } : destination);
  let accountRoutes = routes.get(connection);
  if (!accountRoutes) routes.set(connection, accountRoutes = new Map());
  for (const [previousKey, previous] of accountRoutes) {
    if (Date.now() - previous.lastUsed <= 60000) continue;
    previous.version++;
    accountRoutes.delete(previousKey);
  }
  let route = accountRoutes.get(key);
  if (!route) {
    if (accountRoutes.size >= 1000) throw new Error("Zulip typing route limit exceeded");
    accountRoutes.set(key, route = { version: 0, lastUsed: Date.now() });
  }
  route.lastUsed = Date.now();
  return { connection, destination, route };
}

async function send(params: Params, signal?: AbortSignal, guard?: () => void) {
  signal?.throwIfAborted();
  guard?.();
  const resolved = routeFor(params);
  if (!resolved) return;
  const { connection, destination, route } = resolved;
  if (!connection.current(params.cfg) || !connection.polling) return;
  const version = route.version;
  const waitSignal = AbortSignal.any([AbortSignal.timeout(5000), ...(connection.signal ? [connection.signal] : []), ...(signal ? [signal] : [])]);
  const client: ZulipClient = { ...connection.client, request: (path, init) => {
    waitSignal.throwIfAborted();
    guard?.();
    return connection.client.request(path, { ...init, signal: waitSignal });
  } };
  const target = route.target ?? (destination.kind === "stream"
    ? { type: "stream" as const, streamId: await resolveZulipStreamId(client, destination.stream), topic: destination.topic }
    : { type: "direct" as const, to: [Number((await fetchZulipUsers(client)).find(user => user.email?.toLowerCase() === destination.email.toLowerCase())?.id)] });
  signal?.throwIfAborted();
  guard?.();
  if (route.version !== version || !connection.current(params.cfg) || !connection.polling) return;
  if (target.type === "direct" && (!Number.isSafeInteger(target.to[0]) || target.to[0] <= 0)) throw new Error("Zulip typing recipient not found");
  route.target = target;
  await connection.startCore(target, signal, guard);
}

export const zulipHeartbeat: Adapter = {
  checkReady: async params => {
    const account = resolveZulipAccount(params);
    const connection = getZulipConnection(account.accountId);
    const ok = Boolean(connection?.current(params.cfg) && connection.current() && connection.polling);
    return { ok, reason: ok ? "event queue polling" : "account event queue is not polling" };
  },
  sendTyping: params => send(params),
  sendTypingGuarded: (params: Guarded) => send(params, params.signal, params.assertPlatformSendAuthorized),
  clearTyping: async params => {
    const resolved = routeFor(params);
    if (!resolved) return;
    resolved.route.version++;
    if (resolved.route.target) await resolved.connection.clearCore(resolved.route.target);
  },
};
