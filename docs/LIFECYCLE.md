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


## Heartbeat readiness and typing ownership (#94)

The adapter implements the pinned **2026.9.6** `ChannelPlugin.heartbeat` contract:
`checkReady`, `sendTyping`, `sendTypingGuarded`, and `clearTyping`. No new SDK subpath
is imported. The exports checker audits all **27** emitted subpaths against real npm
2026.9.3, 2026.9.6, 2026.10.1-beta.1 and beta.2 export maps. The matrix also loads the
built index/setup and invokes the real host heartbeat typing factory through the
built plugin, not a unit-test SDK mock.

### Tagged core call paths

Sources were fetched with `gh api repos/openclaw/openclaw/contents/<path>?ref=<tag>`;
no upstream source is vendored. Paths below are upstream repository paths:

| Call | v2026.9.3 | v2026.9.6 | v2026.10.1-beta.1 / beta.2 |
| --- | --- | --- | --- |
| Telegram reference `extensions/telegram/src/channel.ts` | heartbeat `:907-916` | heartbeat `:856-884` | heartbeat `:807-835` |
| Readiness `src/infra/heartbeat-dispatch.ts` | `:437-442,524-530` | `:389-394,478-484` | `:380-385,470-476` |
| Start / clear `src/infra/heartbeat-typing.ts` | `:30-58` | `:30-58` | `:27-49` |
| Caller / terminal cleanup `src/infra/heartbeat-runner-run.ts` | `:54-72,178` | `:57-75,200` | `:57-75,204` |
| Per-agent mode `src/infra/heartbeat-runner-config.ts` | `:197-200` | `:126-129` | `:117-120` |

Core creates its own heartbeat keepalive loop (six-second default) and calls clear
on final cleanup. Recovery additionally invokes guarded typing on 9.6 and both
betas (`src/gateway/recovery-typing.ts:49-94` on 9.6, `:50-96` on betas). It supplies
an AbortSignal and an authorization assertion, checks the agent's current mode,
and calls clear on stop. Pinned 9.6 task progress also uses guarded typing:
`src/tasks/task-registry-progress-runtime.ts:378-460`; its batch owns cancellation
and checks current account/session/mode authorization. The 9.3 contract lacks the
guarded hook; its ordinary heartbeat start/clear still work. Per-agent typing policy
belongs to core: the adapter must not override an agent's `instant` with a global
`never`. The matrix exercises the real core policy for that distinction.

These paths can address the same destination as an inbound turn. Both inbound and
core transports therefore use one **per-generation, per-exact-destination** owner.
An inbound monitor claims its stream ID/topic or DM user ID before dispatch, even
when core's `typingMode` never starts its callback. Core start/clear is suppressed
while that claim exists. Admission retires an older core indicator; active inbound
owners coalesce rather than double-start. Inbound idle/terminal cleanup stops typing
immediately, independently of reaction terminal-hold timers. The claim remains until
terminal settlement finishes, preventing core from restarting typing during that
hold. The existing core reply pipeline continues to decide when inbound typing
starts (`never`, `instant`, `thinking`, `message`); there is no second policy loop.

Only a monitor that actually registered its queue publishes a connection generation.
Readiness additionally requires polling, unchanged transport identity, current
configured/enabled account membership, and a live generation signal. Retry/backoff,
bad queues, pre-poll replay, abort, teardown, removal and credential changes are
not ready. Successful event transport recovery restores readiness. An old generation
cannot remove or revive the replacement's connection. Abort invalidates readiness
immediately, before owned turns and queue deletion finish.

Typing uses the existing destination parser: stream names resolve to IDs, explicit
stream topics take precedence over thread/default topics, and Unicode is not
normalized. DMs resolve the exact email to an account-local numeric user ID. Session
identities are not destinations and are not guessed into a fallback DM. Core itself
trims its `to` before invoking ordinary heartbeat hooks; direct adapter calls retain
the explicit topic bytes supplied by the plugin's destination model.

Guarded sends check abort/authorization before and after metadata lookup and after
serialized transport waits; cancellation aborts lookups/starts and queues a compensating
stop even if a start settles late. Stops use a fresh five-second timeout, not the
already-aborted start signal. Each request is bounded to five seconds. Core's own
loop owns keepalives; the plugin adds no second loop. A twelve-second idle lease
bounds legacy/core calls without clear, and account shutdown joins serialized stops.
Target and route maps are capped at 1,000; unused routes age out after sixty seconds.
Zulip typing is cosmetic: stop failures cannot turn a successfully handled inbound
reply into a durable retry. Server expiry remains the fallback for failed stop HTTP.

### Test-value gate

The named `test-value-audit` skill is absent from the implementer's supplied catalog.
This manual ledger supplies the contracts for Hawk's independent gate:

- **Real monitor readiness:** monitor tests own queue registration, health transitions,
  committed removal and teardown publication. Transport tests independently prove
  real HTTP retry health and stale-generation/credential/account isolation.
- **Destination wire contract:** real client requests in `heartbeat.test.ts` own
  numeric/name streams, exact Unicode topics, thread/default precedence, email-to-ID
  DM resolution, unknown recipients and wrong-account isolation. The four-host matrix
  independently owns built SDK compatibility and actual core start/clear integration.
- **Cancellation/authorization:** adapter/client tests own pre-abort, blocked lookup,
  revoked guard, clear racing lookup, late start compensation and idle lease expiry.
  Removing the pending-start version guard fails the clear-during-lookup regression;
  restored production passes. These are distinct races, not duplicate helper tests.
- **Single owner/terminal lifetime:** a real SDK typing loop in the actual monitor
  test owns inbound admission, suppressed core start/clear and reaction-hold stop.
  Coordinator tests separately own concurrent inbound owners and topic isolation.
  Removing both core owner gates fails the no-duplicate regression; restored code
  passes. The host matrix proves the same behavior through each real SDK caller.
- **Existing backoff test:** replaced its assertion about the second abort-listener
  registration with observable poll error, cancellation, one poll and queue deletion.
  This preserves the backoff regression without coupling it to listener counts.
- **Production seams:** connection publication/health/claims are used by monitor and
  adapter; no test-only production hook exists. Host factory exposure is a scratch
  module transformation only, with all dependencies resolved from the real host.
  Existing lifecycle and approval tests retain their distinct shutdown/delivery risks.

### OG live-test script (operator-owned, not executed here)

After the operator installs the reviewed build on OG, using a test stream/topic and DM:

1. Send a slow-turn prompt in `Heartbeat 🧪 / é`; observe one typing indicator in that
   exact topic, none in a sibling topic. Repeat in a DM.
2. While the turn runs, trigger an existing heartbeat/recovery for the same route;
   verify no second cadence. Reply completion and `/stop` must remove typing, even
   while the terminal reaction remains visible.
3. With `typingMode: never`, repeat and observe no typing. Restore the previous mode;
   verify any per-agent override still wins over the default.
4. During a slow turn, perform an operator-authorized account disable/restart, then
   re-enable. Readiness must be false until the new queue is polling; no old indicator
   or duplicate poll may survive. Repeat with another account running to prove isolation.

No live install, config change, restart, push, PR or external issue write was performed.
