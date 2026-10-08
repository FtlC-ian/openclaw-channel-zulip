# Account lifecycle and reload ownership

## Contract and upstream evidence

The adapter uses `ChannelPlugin.lifecycle` from pinned OpenClaw **2026.9.6**
(`types.adapters-IC4-T9eq.d.ts` in the installed SDK). Account-change/removal signatures
were compared with tagged `src/channels/plugins/types.adapters.ts` in
**v2026.10.1-beta.1**: the same configuration, account ID and runtime parameters,
with void or Promise<void> results. No deprecated state-migration hook is implemented.

Reference: Telegram's lifecycle adapter in tagged
`extensions/telegram/src/channel.ts` (v2026.10.1-beta.1, lines 794–806) invalidates
identity-dependent caches; it does not initiate a second gateway channel restart.

The 2026.9.7 channel-reload fixes include commit
[055db0c](https://github.com/openclaw/openclaw/commit/055db0c631bfb01598ae311015e928013bccdd4c):
replacement channels must be owned by the gateway, not by the completed config-writing
request. The adjacent Google Chat fix (#160323) reads current reply visibility for the
next incoming turn. This plugin likewise keeps replacement under core ownership and
reads dynamic message settings at each message boundary.

## Ownership

Core already stops/starts accounts on config reload. In 2026.9.6 the generic reload path
does **not** call these account lifecycle hooks; hooks are called by channel setup/removal
commands before persistence. Hooks must not switch credentials or stop a still-configured
account when the subsequent write can fail. They invalidate reconstructible metadata;
core's committed reload is the sole owner of queue replacement. If removal is invoked
with an already-committed runtime snapshot lacking the account, it also joins teardown.

Only one monitor generation can exist per account. The runner serializes preparations,
then rechecks the current committed account, configured/enabled state and transport
fingerprint immediately before registration. A stale start queued across removal/disable
cannot resurrect the account. Explicit re-addition with matching committed config can start.
Admission uses the channel's configured/enabled/account-list contract, not mere presence
of a config section; the supported environment-only default account still works.

Dynamic settings are published through `reload.noopPrefixes` for root and named-account
keys, including the entire stream-override map. Gateway-started monitors obtain the
current runtime config; explicitly scoped standalone monitors retain their snapshot.
Legacy `streams` changes remain core restart settings. `registerZulipQueue` receives
selection arguments but intentionally registers broad public/subscribed/DM events without
a stream narrow. All stream overrides, including enablement, therefore refresh the local
per-message policy without replacing the unchanged server queue. Declaring the whole map
also covers dotted stream-name selectors, which SDK single-segment wildcard leaves cannot.
A real monitor regression enables a dotted-name stream between received messages using
one queue registration.

## Cancellation and durable receive

Core's account abort cancels polling **and** accepted turns immediately. There is no
secondary turn signal or grace period waiting for a second core stop: pinned core serializes
repeated stops behind the first stop promise. `gateway.stopAccount` joins the same teardown.

The monitor waits for owned message tasks and durable completion/release before deleting
its queue. Zulip's [`last_event_id`](https://zulip.com/api/get-events) acknowledges received
events: with a durable journal, the next poll waits for admission checkpoints or terminal
handling/drop, not ordinary agent completion. Pending admission is not acknowledged past
before its recovery copy exists. Without a journal, existing live-fallback polling remains
unchanged and has no durable-receive guarantee. If cancellation raced acceptance, the message is durably admitted before being
released. The untouched tail of an already-received poll batch is journaled without new
remote policy/metadata lookups, then replayed under the next monitor. Visible replies keep
their durable completion protection; aborted no-send turns remain retryable. Replacement
registration cannot overlap the prior monitor's settlement and queue deletion.

Queue deletion runs in `finally`, including failed durable startup replay. The HTTP retry
layer removes abort listeners, aborts backoff, and does not retry an aborted fetch.
Durable admission during cancellation is strict: it cannot use the normal live-delivery
fallback. A failure in either aborted admission or untouched-tail preservation rejects
the monitor. Local polling/turn state is cleaned, but the unacknowledged server queue is
retained and its ID logged rather than destroying the remaining recoverable copy.
Removal clears account stream metadata and volatile dedupe; ordinary replacement retains
volatile dedupe. Durable journals/completion receipts survive removal deliberately.

## Directory cache invalidation

The merged directory/resolver caches self, users and subscriptions for 60 seconds per
config object and credential identity. Entries carry their normalized account ID so
invalidation removes every credential generation of that account without evicting another
account. Identity/registration-change hooks invalidate both previous and proposed snapshots;
removal invalidates its previous snapshot. These are reconstructible metadata changes only:
no hook registers/deletes queues, changes credentials, or aborts a still-configured account.

Committed start and settled teardown invalidate both the monitor's original snapshot and
the current runtime snapshot. Removal also invalidates its previous snapshot after joining
teardown, covering loads refilled during drain. Detached in-flight loads cannot reinsert
their entries. Policy filtering still runs on every cache hit; dynamic policy-only changes
do not require cache eviction. The 60-second TTL, concurrent-load sharing, bounded cache,
credential isolation, and live-refresh API semantics remain unchanged.

## Limits

- Hook-only invocation cannot safely replace transport: pre-persistence hooks have no
  transaction/rollback handle. Hosts must apply committed core reload after a successful
  write. The adapter intentionally does not add a second replacement.
- Server queue DELETE remains best-effort. Failed DELETE can leave an inert server queue
  until Zulip expiry, not a local poll. Failed durable shutdown preservation deliberately
  retains that unacknowledged queue for operator recovery before server expiry; it does
  not silently report successful shutdown or run a second local poll.
- Registration is not an atomic server-side handoff. Durable guarantees apply to received
  work when the durable journal is available, not events arriving during registration gaps
  or unavailable/failed durable storage.
