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

## Reversible operator policy-reload check (not executed here)

1. On an authorized isolated OG account/stream, record the original stream override
   `enabled` value (including whether absent), gateway PID, queue generation/registration
   count and a local/private queue identifier. Keep credentials and legacy `streams`
   untouched. Confirm the deployed reviewed plugin version before testing.
2. Through the supported config-writing UI/API, commit just the test stream override
   `enabled: false`. After committed runtime visibility, send a unique benign marker in
   the test topic: expect no agent dispatch/reply. Core owns reload; this dynamic noop
   prefix must keep the same PID and monitor generation, with no queue DELETE/register.
3. Commit `enabled: true` for that override. Send another unique benign marker: expect
   exactly one normal dispatch/reply, again the same PID/generation and queue. Capture
   timestamped committed-setting, dispatch and registration evidence; redact private
   identifiers from public receipts. Do not use lifecycle hooks as a reload substitute.
4. In a finally/rollback step, restore the exact original override value or remove the
   newly introduced key if absent originally. Verify the restored effective policy and
   unchanged credentials, PID and queue generation. If unexpected replacement or missing
   reply occurs, restore first and report the evidence; do not restart or rotate secrets.

This minimal test proves dynamic committed policy refresh, not credential replacement,
durable cancellation, or account removal. Those require separate authorized scenarios.

## Review / live verification gaps

- Hook-only invocation cannot safely replace transport: pre-persistence hooks have no
  transaction/rollback handle. Hosts must apply committed core reload after a successful
  write. The adapter intentionally does not add a second replacement.
- Server queue DELETE remains best-effort. Failed DELETE can leave an inert server queue
  until Zulip expiry, not a local poll. Failed durable shutdown preservation deliberately
  retains that unacknowledged queue for operator recovery before server expiry; it does
  not silently report successful shutdown or run a second local poll.
- Registration is not an atomic server-side handoff. Durable guarantees apply to received
  work when the durable journal is available, not events arriving during registration gaps
  or unavailable/failed durable storage. No live reload/OG verification is claimed.

## Test-value record

| Contract / credible regression | Primary owner and evidence | Overlap / proof limits |
| --- | --- | --- |
| Lifecycle invalidation of self/users/subscriptions across both config snapshots, without other-account eviction or policy bypass | `directory.test.ts`, actual lifecycle → directory → controlled HTTP fetch | TTL/live-refresh/isolation tests retain distinct cache contracts; no test-only production seam. |
| Directory refills during committed teardown must not outlive either original/current snapshot | `lifecycle.test.ts`, controlled draining monitor + real directory/cache/HTTP client, observes refreshed self name | Separate settlement-boundary risk; monitor mock cannot prove actual server teardown. |
| Pre-persistence write/removal failure, hook-plus-committed-core composition, one generation, actual runtime getter, simultaneous/stale starts and environment-only compatibility | `lifecycle.test.ts`, committed runtime getter + controlled monitor boundary | Mocks prove orchestration, not server DELETE. |
| Accepted-turn cancellation with actual core's serialized repeated-stop path | `monitor.test.ts`, installed pinned core manager → actual adapter → actual monitor → controlled SDK dispatcher | Asserts the turn's reply AbortSignal, not a second direct helper call. Pinned internal manager entry is located from installed SDK; no core code is vendored. |
| Received batch tail and aborted admission survive restart; delivered records are not replayed | `monitor.test.ts`, actual monitor + durable journal adapter with controlled SDK state/client | Existing durable failure/replay/post-delivery-race tests retain distinct retry and completion risks. |
| Abort-admission/stopped-tail storage failure must reject, not use live fallback or destroy the remote recovery copy | `monitor.test.ts`, cancellation at policy lookup + fault-injected journal enqueue, observes rejection/no delivery/no DELETE and retained-queue diagnostic | Separate from ordinary live fallback and healthy teardown. |
| Next poll cannot acknowledge pending durable admission | `monitor.test.ts`, blocked durable enqueue and fake-clock pacing, observes actual poll calls/cursor | This proves the plugin's API-call ordering, not Zulip's implementation; official acknowledgment contract linked above. |
| Startup replay failure cannot bypass DELETE | `monitor.test.ts`, finalization boundary | Distinct from ordinary shutdown. |
| Removal clears volatile dedupe; replacement preserves it | `monitor.test.ts`, repeat dispatch observation | `clearPrefix` has a production caller, not a test-only seam. |
| Typing and terminal-hold cleanup | Existing terminal-hold monitor test now asserts typing cleanup | Independent progress/reaction retry/subagent tests remain. |
| Fetch abort does not retry; listeners removed on success/abort | `client.test.ts`, actual client/retry/poll transport with fault-injected fetch | Proves local signal propagation/cleanup, not remote cancellation. |

The two failed-persistence regressions fail against c5b314a, then pass after committed-core
ownership fixes. Restoring 6b7e476's adapter/monitor reproduces the real core cancellation
and received-batch-tail regressions; the final implementation passes. Earlier original-code
checks also reproduced startup replay queue leakage and aborted-fetch retry timeout.
A real monitor test changes committed DM policy between received messages and proves one
queue registration and only the policy-eligible dispatch. An isolated pinned-core planner
check confirmed dynamic root/named/per-stream leaves are no-ops while credentials, streams
restart Zulip; the broad queue lets override enablement refresh dynamically.

No production test-only lifecycle seams remain. The initial split turn-cancellation signal
and misleading direct repeated-stop test were removed in favor of core's actual contract.
The two directory regressions fail when only the rebased pre-integration lifecycle adapter
is restored (missing six refresh requests; stale self name), then pass with invalidation.
The invalidator is called by production hooks/start/teardown and is not exported from the
package entry point. Its consumers and cache/resolver call paths were checked.

## Independent review disposition

Hawk's initial pre-persistence mutation and stale-start findings are resolved. Its next
review found that core serializes repeated stops, invalidating an assumed second-call
cancellation route. The implementation now uses immediate core cancellation and durable
receive replay rather than attempting an uncancellable grace period. A further review
identified cancellation-before-admission using the normal live fallback; strict admission,
monitor error propagation, and retaining the remote recovery queue resolve that failure.

The mandatory `test-value-audit` skill was not advertised to implementer or reviewer.
This manual contract/proof record is not represented as a skill invocation; the procedural
review gate remains for Debbie's review environment.
