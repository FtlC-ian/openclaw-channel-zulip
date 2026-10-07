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
original account lifetime and reads dynamic message settings at each message boundary.

## Ownership

Core already stops/starts accounts on config reload. In 2026.9.6 the generic config
reload path does **not** call these account lifecycle hooks; hooks are called by the
channel setup/removal command path before config persistence. An inactive process's
hook must not start a monitor. Core remains responsible for admitting new accounts,
re-enabling them, and performing ordinary transport reloads.

For an active in-process hook, the existing account lifetime refreshes only when
resolved credentials, URL, enabled state, or the selected registration streams change.
Repeated notifications compare against the lifetime's current desired config rather
than a potentially stale `prevCfg`. Only one monitor generation can exist per account.
Disabling/removing stops that lifetime, including a refresh already draining.

Dynamic settings are published through `reload.noopPrefixes` for both root and named
account keys. Gateway-started monitors obtain the current runtime config; explicitly
scoped standalone monitors retain their supplied snapshot. Streams and stream overrides
remain core restart settings: `registerZulipQueue` currently receives selection arguments
but intentionally registers broad public/subscribed/DM events without a stream narrow.
Stream/topic policy itself is enforced locally.

A refresh aborts the long-poll but not accepted message turns. The rest of a received
batch is admitted, owned work (including deferred durable replay) settles, transient
reaction/progress/placeholder/typing state is cleaned, and the old queue is deleted
before its replacement can register. Core shutdown/removal aborts both polling and
message-turn signals. Queue deletion runs in `finally`, including failed durable startup
replay. The HTTP retry layer removes abort listeners, aborts backoff, and does not retry
an already-aborted fetch.

Removal clears account stream metadata and volatile dedupe. Ordinary replacement retains
volatile dedupe. Durable inbound journals and completion receipts intentionally survive:
removal must not turn a previously delivered record into an unrecorded delivery.

## Directory cache follow-up

PR #102's `src/directory.ts` is not present on this base. Its account-scoped invalidation
belongs in `zulipLifecycle.onAccountRemoved`, after `stopZulipAccount` settles; add matching
identity-change invalidation if the directory caches credentials/realm-specific entries.
No imports or assumptions about the pending PR are introduced here.

## Review / live verification gaps

- If a future host calls an active lifecycle hook **and** unconditionally stop/starts
  the same account for that write, two sequential replacements could occur. The checked
  core paths are separate; neither concurrent queues nor resurrection is allowed.
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
| One account generation, relevant-only refresh, duplicate notification, simultaneous starts, disable/removal and stop-vs-refresh | `lifecycle.test.ts`, controlled monitor generation boundary | Mocks prove orchestration, not Zulip's server DELETE. Real monitor tests below own queue cleanup. |
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
