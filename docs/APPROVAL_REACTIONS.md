# Approval reactions

## Structural constraints

- Preserve the zform and bind only canonical pending metadata whose typed or
  command controls agree exactly with the approval owner and decision set.
- Register only after a successful Zulip send returns its exact account/message
  ID. Payload delivery is the admission boundary, not a separate Gateway observer.
- Require explicit normalized `allowFrom`; fetch the actor through the account's
  authenticated API and reuse `approval-auth.ts`. Ignore self/bot/inactive actors,
  removals, unsupported emoji types, and wrong account/message IDs.
- SDK `settleApprovalReaction` and owner-aware Gateway resolution arbitrate global
  first-wins across widgets, reactions and `/approve`. Local sibling claims prevent
  concurrent same-account settlement; show the actual Gateway winner.
- Revalidate current configuration, account membership/configuration/enabled state,
  explicit approvers, abort, target identity and TTL after identity lookup and again
  after lazy resolver loading, immediately before the Gateway call. Account teardown
  clears only that account, including in-flight bindings. No persistent state.

## Delivery, TTL and outcomes

Default reactions are **✅ (`check`) = allow-once** and **❌ (`cross_mark`) = deny**.
Configure `approvalReactions.approve` / `.deny` at root or account level using
supported Unicode or named Zulip emoji. Existing bindings keep their seeded emoji;
new deliveries use current config. Sender hints and registration share normalized
control eligibility: unsupported-only decisions and collisions neither advertise nor
bind reactions, while zform/manual fallback controls remain. No allow-always reaction.

The sender keeps zform and readable fallback commands, adds reaction instructions
for explicit approvers, and registers/seeds controls against the returned message ID.
No native prompt planner is added, so forwarding is neither duplicated nor suppressed.
The monitor routes reactions without creating an agent turn and clears account state
on stop/removal using its existing lifecycle cleanup.

`createApprovalReactionTargetStore` owns process-local 24-hour TTL targets. A bounded
index of the same live binding objects enables account cleanup, command lookup and
sibling claims. Both stores are capped at 1,000 entries globally; the index refuses
admission at capacity (no active eviction) and deletes matching SDK entries on prune,
resolution and cleanup. The Gateway, not the transport TTL, enforces actual approval
expiry. Expired Gateway requests retire on `APPROVAL_NOT_FOUND`; real failures keep
bindings retryable. Terminal bindings retire before editing all sibling messages:

```
<original request and fallback commands>

**Approval outcome: allow-once**
These controls are no longer active.
```

Deny/already-resolved outcomes show the canonical winner, not the local selection.
Failed edits cannot reactivate bindings. Seeding is best-effort. A stale zform may
remain visually present, but core still rejects repeated execution.

There is no passive observer or proactive terminal update for decisions made on a
remote surface. The next local reaction/manual command obtains terminal truth from
Gateway and edits the message; a TTL-pruned target is simply inert. Restart/removal
retires targets without proactive edits. Typed `/approve` remains the fallback.

## Public SDK evidence and host matrix

Compared Signal's `approval-reactions.ts`, `approval-native.ts`,
`approval-handler.runtime.ts`, `approval-reaction-routes.ts`, `approval-auth.ts` and
reaction tests via GitHub API at **v2026.9.7** and **v2026.10.1-beta.2**. Those six
files are byte-identical across these tags. Signal already registers delivered
payload targets independently of passive observation; its native adapter separately
owns messages it delivered itself. Zulip retains its existing sender and lifecycle
instead of adding native routing/delivery side effects.

Sources: [Signal beta.2 reactions](https://github.com/openclaw/openclaw/blob/v2026.10.1-beta.2/extensions/signal/src/approval-reactions.ts),
[9.7 reactions](https://github.com/openclaw/openclaw/blob/v2026.9.7/extensions/signal/src/approval-reactions.ts),
[beta.2 native adapter](https://github.com/openclaw/openclaw/blob/v2026.10.1-beta.2/extensions/signal/src/approval-handler.runtime.ts).

Actual npm-packed export maps **and runtime functions** were checked, not merely
source contracts. All required helpers exist on every audited supported host, so
no legacy observer fallback is necessary:

| Public subpath / helpers | 2026.9.3 | 2026.9.6 | beta.1 | beta.2 |
| --- | --- | --- | --- | --- |
| approval-reaction-runtime: createApprovalReactionTargetStore, readApprovalReactionTargetRecord, listApprovalReactionBindings, settleApprovalReaction, metadata/control validators | yes | yes | yes | yes |
| approval-reply-runtime: getExecApprovalReplyMetadata | yes | yes | yes | yes |
| approval-gateway-runtime: resolveApprovalOverGateway | yes | yes | yes | yes |
| lazy-runtime: createLazyRuntimeSurface | yes | yes | yes | yes |
| Reactions enabled, built index/setup import and exports audit | **yes** | **yes** | **yes** | **yes** |

No `infra-runtime` import remains. The pinned 9.6 package omits the reaction runtime
`.d.ts`; `approval-sdk.ts` declares only consumed type signatures, importing real
host implementations. Reply metadata is cross-checked when available; older command
payloads without a slug remain accepted only by strict owner/decision validators.
The SDK target store is memory-only here, so persisted-target validation is not used.

Build runs the emitted-import exports checker. Additional artifact regression:

```
npm run build
OPENCLAW_HOST_FIXTURES=/path/to/npm-extracted-hosts npm run test:hosts
```

Fixtures are `<version>/package` for all four matrix versions. The test imports the
built index/setup using each real npm host, asserts helper functions, then delivers
an actual SDK-built approval payload without observation and verifies two seeded
controls, reaction actor lookup, denied-actor binding retention and account cleanup.
This verifies enabled plugin behavior, not live Gateway RPC. Scratch hosts use matching
beta `@openclaw/ai` packages with remaining dependencies resolved from the existing
pinned development tree; these are not full clean installations.

## Client evidence (source snapshots, October 8, 2026)

- **Web:** [widget subsystem](https://github.com/zulip/zulip/blob/29fbc01fa8232da1176932865d31d34085b8f39e/docs/subsystems/widgets.md)
  explicitly describes zforms/button UIs and the web widget experience;
  [zform.ts](https://github.com/zulip/zulip/blob/29fbc01fa8232da1176932865d31d34085b8f39e/web/src/zform.ts)
  implements it.
- **Desktop:** [desktop README](https://github.com/zulip/zulip-desktop/blob/1cc112def5cd4b0b3ffe15c0857258c527b4421a/README.md)
  says individual organization windows share most code with the web app. This
  supports web-renderer behavior in desktop; no specific installed build was
  tested here.
- **Flutter mobile:** [submessage.dart](https://github.com/zulip/zulip-flutter/blob/990a2bc100a2fb2c7e2b1e56cfbf42210587af02/lib/api/model/submessage.dart)
  has `WidgetType.poll`, explicitly comments out `zform`, routes unknown widget
  types to `UnsupportedWidgetData`, and returns null for unsupported widgets.
  Thus this source snapshot does not render zform; it is not an inference from
  the older documentation's broad claim that other clients lack widgets.

## Test-value audit

The named `test-value-audit` skill is absent from this worker's supplied catalog;
this manual ledger is the required gate for independent Hawk review.

| Logical contract / credible regression | Primary owner / overlap disposition |
| --- | --- |
| Owner/control parity: actual generic, exec command and typed builders; mismatched owner/decisions; terminal payload rejection | SDK-backed channel control boundary; distinct payload formats retained |
| Explicit policy and actor identity: authorized/unauthorized/API-derived email; no approvers; bot/inactive/missing email; wrong message/account/removal/self | Real auth + client serialization boundary; independent side-effect admission risks |
| Async authorization: ingress, identity lookup, lazy resolver await; revoked/disabled/removed/aborted/cleared state | Real monitor/control boundaries; new lazy-await cases cover the newly introduced await, not duplicates of identity/ingress cases |
| First-wins: duplicate events, sibling deliveries, widget/manual vs reaction orders, canonical losing result | Local claims + controlled Gateway results; does not prove core service atomicity |
| Terminal/retry: exact outcome content, not-found retirement, real-failure retry, failed-edit inertness | Settlement/control boundary; removed observer-only external-event tests because no production observer exists; canonical losing-result test owns external decision truth |
| Bounds/config/cleanup: emoji overrides/collisions, capped admission and TTL freeing, in-flight removal | Channel target boundary; real sender/monitor own exact delivery ID and account teardown wiring |
| Host artifact compatibility: real npm host helper functions and exports, built index/setup load, active seed/lookup/cleanup without observation | Built artifact boundary on all four hosts; replaces beta feature-disablement test; it would fail pre-rework because no observed request exists |
| Sender fallback: zform preservation, exact returned ID, explicit approvers; unsupported-only decisions and normalized emoji collisions must not advertise or bind | Real sender boundary; new cases fail before shared eligibility fix and pass after; real registration retained, no test-only seam |
| Emitted import checker: absent dynamic import rejected then complete fixture accepted | Real checker CLI; fixture infra-runtime string tests generic dynamic scanning, not a production observer dependency |

Public methods are production-called by sender/monitor; binding retirement is private.
The SDK `clearForTest` seam is not used. Removed `observe`, `hasPendingObservation`,
`canObserve` and observer lifecycle factory after checking source, tests, mocks and
emitted imports. No exported downstream contract promised these internal modules.
Existing manual ingress HIGH regression still passes. The new no-observation binding
fails on the old architecture. All four old artifacts fail the matrix (older hosts
do not seed unobserved targets; betas also fail the missing observer export audit).
Focused and full verification receipts are listed in the PR draft.

## Live verification limits

No push, PR publication, package installation, config edit, gateway restart or live
approval was performed. Debbie owns publication and live-client verification. Check
web/desktop widgets, mobile reactions, external winning decisions, TTL/not-found,
message-edit permissions and account teardown on a test Gateway before release.
