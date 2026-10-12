# Reaction-triggered go: constraint and test-value receipt

Writable owner: Dex; worktree `/Volumes/WorkingSpace/openclaw/workspaces/dex/zulip-reaction-go`,
branch `feat/reaction-go`, base `8ff6886`. Reviewers are read-only.

## Structural constraints

- Reuse monitor `handleMessage` and core inbound dispatch: no synthetic mention,
  alternate authorization path, separate session grammar or new queue behavior.
- The target's stream/topic remains intact; sender identity comes from the Zulip
  user API, not event-provided display names. Own-message identity is numeric.
- Only two-person DMs have a safe existing direct-session mapping; reject group DMs.
- Durable ingress has expiring completion records. A separate non-expiring ledger
  is necessary for permanent repeat protection. Atomically append hashes with the
  existing public keyed-store update surface; reject rather than evict on limits.
- Claim after typed-message policy gates but before durable enqueue. A crash in
  that gap may lose a tap; it cannot re-admit it. Agent execution keeps existing
  retry/cancellation semantics, not a new exactly-once promise.
- Both approval emojis must be distinct from the trigger after Unicode/name
  normalization and account inheritance. Active source and widget targets are
  excluded via the existing approval owner; manual approval-command text is inert.

## Material contracts and primary owners

| Contract | Primary tests / boundary | Credible regression and proof |
| --- | --- | --- |
| Same stream topic/direct session, injected text | Monitor reaction continuation ingress; actual context handed to core inbound dispatch | Losing topic or retaining bot sender routes incorrectly; asserted dispatched context and direct identity. Core scheduler behavior stays owned by existing core admission tests. |
| No sender/stream/topic/mention bypass | Monitor ingress policies; DM allowlist/disabled and stream allowlist/disabled/mention/selection cases | A synthetic-message shortcut can admit an unauthorized sender. Removing group-allow guard produces a failing unauthorized-dispatch assertion. |
| Own bot targets and active human users only | Monitor ingress with controlled user/message API responses | Any-message or bot-triggering would cause agent dispatch. These tests prove monitor handling, not Zulip network behavior. |
| Remove/re-add and restart replay never re-admit | Monitor ingress with volatile cache cleared and ordinary ingress queue replaced while ledger persists | Removing ledger membership guard dispatches twice and fails the restart assertion. This deliberately does not rely on short-lived ingress completion dedupe. |
| Atomic persistent admission | Four-host smoke harness calls production `claimReactionTrigger` against actual SDK state stores | Eight concurrent claims must yield exactly one winner; reopened store rejects same identity and accepts distinct identity. No memory-store mock is proof of SDK atomicity. |
| Storage write failures and hot-enable without startup durability fail closed | Monitor fault injection at state update; live-config enable after startup without state | Disk/full-store failure or runtime enablement without a journal must not fall back to live synthetic dispatch. Typed-message fallback remains unchanged. |
| Approval collision and inherited account config | Config runtime schema tests plus manifest synchronizer check | Unicode alias, configured/inherited approval emoji, blank/overlong messages and malformed names must fail safely. Existing approval reaction tests and real-host harness own approval execution. |

No copied export inventories or new test-only production seams. The production
admission helper is called by the monitor and real-host harness. Existing approval
and ordinary typed-message tests retain independent ownership; no overlapping
implementation-detail tests were added.

Mutation evidence: `reaction-go-guard-mutants.log` in the task log directory:
two intended failures (unauthorized group dispatch and duplicate restart dispatch).
Both guards restored; focused and full gates rerun. Skill catalog did not expose
`test-value-audit`; this receipt records its required contracts and proof gaps.

Remaining proof gap: a real authorized human's tap must be tested on OG. The bot
cannot impersonate Ian, and group-DM support is intentionally not implemented.
