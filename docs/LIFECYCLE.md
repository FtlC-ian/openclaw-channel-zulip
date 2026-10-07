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

Dynamic settings are published through `reload.noopPrefixes` for root and named-account
keys, including per-stream mention/topic leaves. Gateway-started monitors obtain the
current runtime config; explicitly scoped standalone monitors retain their snapshot.
Streams and stream enablement remain restart settings. `registerZulipQueue` receives
selection arguments but intentionally registers broad public/subscribed/DM events without
a stream narrow; stream/topic policy itself is enforced locally.

## Cancellation and durable receive

Core's account abort cancels polling **and** accepted turns immediately. There is no
secondary turn signal or grace period waiting for a second core stop: pinned core serializes
repeated stops behind the first stop promise. `gateway.stopAccount` joins the same teardown.

The monitor waits for owned message tasks and durable completion/release before deleting
its queue. If cancellation raced acceptance, the message is durably admitted before being
released. The untouched tail of an already-received poll batch is journaled without new
remote policy/metadata lookups, then replayed under the next monitor. Visible replies keep
their durable completion protection; aborted no-send turns remain retryable. Replacement
registration cannot overlap the prior monitor's settlement and queue deletion.

Queue deletion runs in `finally`, including failed durable startup replay. The HTTP retry
layer removes abort listeners, aborts backoff, and does not retry an aborted fetch.
A durable-storage error while preserving a stopped batch is surfaced as a real monitor
failure, not mistaken for ordinary polling cancellation.
Removal clears account stream metadata and volatile dedupe; ordinary replacement retains
volatile dedupe. Durable journals/completion receipts survive removal deliberately.

## Directory cache follow-up

PR #102's `src/directory.ts` is not present on this base. Add its account-scoped invalidator
alongside `onAccountRemoved` metadata invalidation, and after stop settles for committed
removal. Add matching identity-change invalidation if its caches are realm/credential-specific.
No imports or assumptions about the pending PR are introduced here.

## Review / live verification gaps

- Hook-only invocation cannot safely replace transport: pre-persistence hooks have no
  transaction/rollback handle. Hosts must apply committed core reload after a successful
  write. The adapter intentionally does not add a second replacement.
- Server queue DELETE remains best-effort. Failed DELETE can leave an inert server queue
  until Zulip expiry, not a local poll.
- Registration is not an atomic server-side handoff. Durable guarantees apply to received
  work when the durable journal is available, not events arriving during registration gaps
  or unavailable/failed durable storage. No live reload/OG verification is claimed.

## Test-value record

| Contract / credible regression | Primary owner and evidence | Overlap / proof limits |
| --- | --- | --- |
| Pre-persistence write/removal failure, hook-plus-committed-core composition, one generation, actual runtime getter, simultaneous/stale starts | `lifecycle.test.ts`, committed runtime getter + controlled monitor boundary | Mocks prove orchestration, not server DELETE. |
| Accepted-turn cancellation with actual core's serialized repeated-stop path | `monitor.test.ts`, installed pinned core manager → actual adapter → actual monitor → controlled SDK dispatcher | Asserts the turn's reply AbortSignal, not a second direct helper call. Pinned internal manager entry is located from installed SDK; no core code is vendored. |
| Received batch tail and aborted admission survive restart; delivered records are not replayed | `monitor.test.ts`, actual monitor + durable journal adapter with controlled SDK state/client | Existing durable failure/replay/post-delivery-race tests retain distinct retry and completion risks. |
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
and stream enablement restart Zulip.

No production test-only lifecycle seams remain. The initial split turn-cancellation signal
and misleading direct repeated-stop test were removed in favor of core's actual contract.

## Independent review disposition

Hawk's initial pre-persistence mutation and stale-start findings are resolved. Its next
review found that core serializes repeated stops, invalidating an assumed second-call
cancellation route. The implementation now uses immediate core cancellation and durable
receive replay rather than attempting an uncancellable grace period.

The mandatory `test-value-audit` skill was not advertised to implementer or reviewer.
This manual contract/proof record is not represented as a skill invocation; the procedural
review gate remains for Debbie's review environment.
