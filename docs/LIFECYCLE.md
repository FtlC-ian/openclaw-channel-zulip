# Account lifecycle and reload ownership

## Contract and upstream evidence

The adapter uses `ChannelPlugin.lifecycle` from pinned OpenClaw **2026.9.6**
(`types.adapters-IC4-T9eq.d.ts` in the installed SDK). The account-change/removal
signatures were compared with tagged `src/channels/plugins/types.adapters.ts`
in **v2026.10.1-beta.1**: the same configuration, account ID and runtime parameters,
with void or Promise<void> results. No deprecated state-migration hook is implemented.

Reference: Telegram's lifecycle adapter in tagged
`extensions/telegram/src/channel.ts` (v2026.10.1-beta.1, lines 794–806) invalidates
identity-dependent caches; it does not initiate a second gateway channel restart.

The 2026.9.7 channel-reload fixes include commit
[055db0c](https://github.com/openclaw/openclaw/commit/055db0c631bfb01598ae311015e928013bccdd4c):
replacement channels must be owned by the gateway, not by the completed config-writing
request. The adjacent Google Chat fix (#160323) reads current reply visibility for the
next incoming turn. This plugin similarly creates replacement generations from the
core's gateway-owned account lifetime and reads dynamic message settings at each message boundary.

## Ownership

Core already stops/starts accounts on config reload. In 2026.9.6 the generic config
reload path does **not** call these account lifecycle hooks; hooks are called by the
channel setup/removal command path before config persistence. An inactive process's
hook must not start a monitor. Core remains responsible for admitting new accounts,
re-enabling them, and performing ordinary transport reloads.

The lifecycle hooks therefore invalidate account metadata, not the active transport,
before persistence. A failed write must leave the old poll, credentials, account and
volatile delivery protection intact. Core's committed reload is the sole owner of
queue replacement. If removal is invoked with an already-committed runtime snapshot
that no longer contains the account, it also joins the active lifetime's teardown.

Only one monitor generation can exist per account. The runner serializes preparations,
then rechecks the current committed account and transport configuration immediately
before registration. A stale start queued across removal/disable cannot resurrect the
account. Explicit re-addition with a matching committed config can start normally.

Dynamic settings are published through `reload.noopPrefixes` for both root and named
account keys. Gateway-started monitors obtain the current runtime config; explicitly
scoped standalone monitors retain their supplied snapshot. Streams and stream overrides
remain core restart settings, except per-stream mention/topic rule leaves, which are
dynamic no-ops. `registerZulipQueue` currently receives selection arguments
but intentionally registers broad public/subscribed/DM events without a stream narrow.
Stream/topic policy itself is enforced locally.

A committed transport reload aborts the long-poll but not accepted message turns. The rest of a received
batch is admitted, owned work (including deferred durable replay) settles, transient
reaction/progress/placeholder/typing state is cleaned, and the old queue is deleted
before its replacement can register. Core shutdown/removal/disable aborts both polling and
message-turn signals. `gateway.stopAccount` joins teardown; a repeated core stop can
cancel an existing graceful drain even after its original polling signal aborted. Queue deletion runs in `finally`, including failed durable startup
replay. The HTTP retry layer removes abort listeners, aborts backoff, and does not retry
an already-aborted fetch.

Removal clears account stream metadata and volatile dedupe. Ordinary replacement retains
volatile dedupe. Durable inbound journals and completion receipts intentionally survive:
removal must not turn a previously delivered record into an unrecorded delivery.

## Directory cache follow-up

PR #102's `src/directory.ts` is not present on this base. Its account-scoped invalidation
belongs in `zulipLifecycle.onAccountRemoved`, alongside metadata invalidation, and after `stopZulipAccount` settles for committed removal; add matching
identity-change invalidation if the directory caches credentials/realm-specific entries.
No imports or assumptions about the pending PR are introduced here.

## Review / live verification gaps

- Hook-only invocation cannot safely restart transport: SDK hooks are pre-persistence and
  have no transaction/rollback handle. A host must apply its committed core reload after
  a successful write. The adapter intentionally does not add a second replacement.
- Graceful refresh can wait for an accepted turn to finish. Core's stop signal cancels
  the turn if shutdown/removal wins; there is no arbitrary timeout that discards work.
- Server queue deletion is the existing best-effort API. A failed DELETE can leave an
  inert server queue until Zulip expiry; it cannot leave a local poll running.
- Queue registration is not an atomic server-side handoff. Durable guarantees cover
  admitted/received work and completion receipts, not messages arriving in the server-side
  registration gap. No live reload/OG verification is claimed.

## Test-value record

| Contract / credible regression | Primary owner and evidence | Overlap / proof limits |
| --- | --- | --- |
| One account generation, pre-persistence write/removal failure, hook-plus-committed-core reload composition, simultaneous starts, disable/removal and concurrent stale starts | `lifecycle.test.ts`, committed runtime getter + controlled monitor generation boundary | Mocks prove orchestration, not Zulip's server DELETE. Real monitor tests below own queue cleanup. |
| Drain received batch and durable completion before deletion; do not replay delivered records | `monitor.test.ts`, real monitor + real durable journal adapter with controlled SDK state/client | Existing durable replay/failure/completion-race tests remain: distinct retry and post-delivery risks. |
| Startup replay failure cannot bypass queue deletion | `monitor.test.ts`, monitor finalization boundary | Distinct from ordinary shutdown. |
| Account removal clears volatile dedupe; ordinary replacement preserves it | `monitor.test.ts`, repeat inbound dispatch observation | New `clearPrefix` has a production caller, not a test-only seam. |
| Typing shutdown and terminal hold cancellation | Existing terminal-hold monitor test now asserts typing cleanup | Status/progress tests retain independent timer/retry/subagent risks. |
| In-flight fetch abort is not retried; listeners removed on success/abort | `client.test.ts`, real client/retry/poll transport with fault-injected fetch | Does not prove remote cancellation semantics; proves AbortSignal propagation and local cleanup. |

Regression evidence: with only the original production `monitor.ts` and `client.ts`
restored, the three targeted new tests fail (received batch: 1 dispatch instead of 2;
startup replay failure: 0 queue deletions instead of 1; aborted fetch: timeout due to retry).
With the patch restored all pass. An isolated process running the pinned core reload
planner also confirmed root `dmPolicy` and named-account `streaming.mode` are no-ops,
while root `apiKey` and named-account `streams` restart Zulip.

No production test-only lifecycle seams were added: account runner, stop helper, config
getter, split cancellation signals and account-cache invalidation all have non-test callers.

## Independent review disposition

Hawk reviewed c5b314a and found pre-persistence transport mutation plus a concurrent
removal/start resurrection risk. Both are addressed by committed-core ownership and
admission revalidation; new tests cover failed writes, failed removals, one successful
core replacement after repeated hooks, the actual runtime getter boundary and a stale
start queued across committed removal.

The mandatory `test-value-audit` skill was not advertised to the implementer or reviewer.
The manual contract/proof record above is not represented as a substitute invocation;
that procedural review gate remains for Debbie's review environment.

The two failed-persistence regressions also fail against reviewed commit c5b314a
(uncommitted credential hook starts a second generation; failed removal leaves zero
active monitors), then pass with the ownership fix. A real monitor test exercises a
committed DM-policy change between two received messages: only the first dispatches,
with exactly one queue registration.
