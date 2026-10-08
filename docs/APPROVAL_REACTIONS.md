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

## Prompt routing and the live delivery gap

The live failure was **not missing approval metadata at the producer**. Core already
builds typed buttons plus `channelData.execApproval`. Zulip was missing the public
outbound `renderPresentation` hook: core's delivery preparation consumes shared
presentation and falls back to readable text when that hook is absent. The remaining
metadata alone did not satisfy Zulip's strict owner/control admission check. Adding a
native approval handler would introduce a second delivery owner without fixing this
boundary.

The minimal supported implementation declares `outbound.presentationCapabilities`
(`buttons: true`, `selects: false`) and implements `outbound.renderPresentation` for
validated approvals. The declaration describes adaptation; **the renderer returning a
payload** decides whether core keeps native UI instead of flattening it. The renderer
translates canonical typed approval actions into full-ID `/approve` zform commands,
stores `zulip.widgetContent`, and stamps the SDK's delivered-binding marker. Core
removes presentation afterward; the actual sender revalidates marker owner, kind,
decisions and pending state against `execApproval` before binding/seeding the returned
message ID. Command-backed controls remain supported. A prompt must contain exclusively the
exact canonical typed-action set or exclusively the exact command set; additional
commands, callbacks, links or select controls are rejected rather than preserved
alongside a valid subset. Both the original normalized `sourcePresentation` and
core-adapted controls are validated, so adaptation cannot erase a contradictory
select and launder the remaining valid subset into a binding. No text is parsed and no
approval owner is invented.

### Core trace (tagged source, fetched through `gh api`)

Both beta tags have the following source paths/line ranges:

- **Same chat:** `src/agents/embedded-agent-subscribe.handlers.tools.results.ts:505-512`
  recognizes a structured `approval-pending` tool result and passes
  `buildTypedExecApprovalPendingReplyPayload` to `onToolResult`. Pinned 2026.9.6:
  `:556-563`. This path requires the runtime to return a pending tool result;
  claude-cli blocked inside Bash cannot emit it, so use forwarding on OG.
- **Forwarding:** `src/infra/exec-approval-forwarder.ts:391-401` gates on
  `approvals.exec.enabled` and filters; `:329-367` chooses session, explicit targets
  or both and deduplicates identical destinations. `:517-537` builds pending payloads;
  `:293-320` delivers them through durable outbound delivery. The default destination
  mode is session, not implicit enablement.
- **Payload production:** `src/infra/exec-approval-forwarder.messages.ts:112-154`
  uses `approvalCapability.render.exec.buildPendingPayload` if provided, otherwise
  the typed shared builder. `src/plugin-sdk/approval-renderers.ts:39-85` creates
  controls and `channelData.execApproval` in either case. The generic forwarder is
  already rich; a channel-native capability is not required.
- **Native UI vs plain fallback:**
  `src/channels/plugins/outbound/presentation-delivery.ts:12-33,58-93` normalizes and
  adapts controls, invokes the outbound renderer, consumes presentation, then uses
  native channelData or plain fallback. The pinned npm 9.6 module
  `dist/presentation-delivery-*.mjs:332-363` has the same behavior. Pinned
  `dist/server-aux-handlers-C8HKJelB.mjs:129-144,280-320` shows the actual
  shared forwarder builder and outbound handoff. A chat-type/channel
  capability boolean named "shared interactive replies" does not select this path.
- **Independent native delivery:**
  `src/channels/plugins/native-approval-prompt.ts:10-15` detects
  `approvalCapability.native` / `.nativeRuntime`.
  Signal's `extensions/signal/src/approval-native.ts` builds forwarding-backed routing,
  a lazy native runtime and channel renderers; its runtime owns Gateway-event prompts.
  `src/infra/approval-native-delivery.ts:29-105` plans/deduplicates native destinations.
  `src/infra/exec-approval-forwarder.ts:175-216` suppresses generic fallback only when
  the adapter requests suppression **and** an active native route owns that account.
  Zulip deliberately registers neither native surface nor suppression, so enabling
  another channel's native client cannot create a second Zulip prompt. Core-owned
  same-chat/forwarding overlap is not altered by this rendering-only fix.

### OG live-test configuration

Read-only OG inspection confirmed this configuration is **already set**; keep it:

```json
{
  "approvals": { "exec": { "enabled": true, "mode": "session" } },
  "channels": { "zulip": { "allowFrom": ["user8@zlp.pubnerd.app"] } },
  "tools": { "exec": { "mode": "ask" } }
}
```

This is a merge fragment: preserve the existing Zulip URL/email/API key and all
other settings. No `channels.zulip.execApprovals`, native-client flag, or special
reaction-enable switch is needed. Installing this updated plugin build is the
remaining live-test prerequisite. `approvals.exec.mode: "targets"` with explicit
`targets` also works; `"both"` forwards to both routes, deduplicating an identical
session/explicit destination. With forwarding disabled, only runtimes that emit
structured same-chat pending results can show an approval. Arbitrary assistant text
containing `/approve` never becomes a bound prompt. On claude-cli, retain session
forwarding even though the Zulip sender now supports interactive presentation.

## Delivery, TTL and outcomes

Default reactions are **✅ (`check`) = allow-once** and **❌ (`cross_mark`) = deny**.
Configure `approvalReactions.approve` / `.deny` at root or account level using
supported Unicode or named Zulip emoji. Existing bindings keep their seeded emoji;
new deliveries use current config. Sender hints and registration share normalized
control eligibility: unsupported-only decisions and collisions do not advertise or
seed reactions; their validated zform/manual controls still bind for interception
and terminal cleanup. No allow-always reaction.

The outbound renderer keeps zform and readable fallback commands, adds reaction instructions
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

````
✅ Approved (allow once) by `Ian F`

ID: req-1
Command:
```
printf 'hello'
```
````

The outcome is the first line, followed only by the ID and the command already
shown in the prompt (when recognized). Reply/reaction instructions, expiry, mode,
background notes and other request metadata are removed. Local reactions use the
fetched approver display name (email fallback); zform/manual commands use their
known sender email. Remote events use `resolvedBy` when supplied; a losing local
settlement uses only a canonical channel resolver ID, never a device ID or the
losing sender. Approver names render as inert code spans (no links or mentions), IDs are escaped, and command fences are neutralized.

Other first-line examples: `` ❌ Denied by `Ian F` ``, `⌛ Expired`, `🚫 Cancelled`,
`Resolved elsewhere: allow-once` (unknown remote actor), and
`⌛ Expired or already resolved` (Gateway not-found). Allow-always decisions show
`✅ Approved (allow always)`. Deny/already-resolved outcomes show the canonical
winner, not the local selection. No additional Gateway result metadata is copied.
Failed cleanup cannot reactivate bindings. Seeding is best-effort. Terminal
cleanup waits for in-flight seeding before removing reactions. Cleanup API failures
may leave stale visuals, but cannot permit repeated execution.

The account monitor observes Gateway terminal events and proactively retires
controls for remote decisions, expiry and cancellation. The next local
reaction/manual command also obtains terminal truth from Gateway; TTL-pruned
targets are inert. Restart/removal clears local state without proactive edits.
Typed `/approve` remains the fallback.

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
built index/setup using each real npm host and asserts helper functions. A test-only
copy exposes the private **real core forwarder factory**, rewriting only relative
import URLs and adding an export (no production seam or host mutation). Real routing
proves disabled/session/targets/both modes and exact-target dedupe. Its output and
the actual same-chat typed builder pass through the host's real presentation-delivery
module and the plugin's actual outbound/send/client path. Wire assertions verify one
message, zform full-ID commands, two reaction POSTs and a registered binding. Running
without the renderer reproduces the stripped-presentation/unbound-prompt regression.
Actor lookup, denied-actor binding retention and account cleanup remain covered.
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
| Terminal/retry: exact outcome content, not-found retirement, real-failure retry, failed-edit inertness | Settlement/control boundary; Gateway callback/terminal observer, late-delivery cache and losing-result tests cover external decisions and independent cleanup |
| Bounds/config/cleanup: emoji overrides/collisions, capped admission and TTL freeing, in-flight removal | Channel target boundary; real sender/monitor own exact delivery ID and account teardown wiring |
| Host artifact compatibility: real npm host helper functions and exports, built index/setup load, active seed/lookup/cleanup without observation | Built artifact boundary on all four hosts; replaces beta feature-disablement test; it would fail pre-rework because no observed request exists |
| Core delivery regression: actual forwarding routes, same-chat builder, native rendering vs plain fallback, one editable prompt, one disposable zform, two seeded reactions, and external terminal cleanup on all four hosts | Real core-to-built-plugin outbound boundary; replaces direct SDK-builder-only matrix evidence; without-renderer negative control fails binding on every host |
| Source-adaptation mutation: extra source select beside valid buttons is adapted to context by real core but must not produce a binding/zform | Four-host real core-to-renderer matrix owns this contract; fails on ed2520a and passes after sourcePresentation validation; no test-only production seam |
| Mixed-control mutation: valid typed approval buttons plus extra command/callback/link must not render or bind | Same renderer/control-admission boundary; reproduces Hawk MEDIUM on 701cd39 (three failures) and passes after exclusive full-set validation; no overlapping test-only seam |
| Rendered marker integrity: mismatched owner/kind/decisions/version/terminal state must remain unbound; typed actions become full-ID commands without losing text/data | Channel renderer/SDK validation boundary; focused tamper coverage independently protects the new consumed-presentation boundary; no new test-only production seam |
| Partial delivery: companion request rejected after successful original (DM and stream) | Real sender network boundary on all four hosts proves successful result, reaction seeds, bound pre-dispatch command and terminal edit without phantom widget deletion; focused sender test owns warning/exact registration arguments; fails before degradable companion handling |
| Sender fallback: zform preservation, exact returned ID, explicit approvers; unsupported-only decisions and normalized emoji collisions must not advertise/seed reactions but must bind validated fallback commands | Real sender boundary; new cases fail before shared eligibility fix and pass after; real registration retained, no test-only seam |
| Emitted import checker: absent dynamic import rejected then complete fixture accepted | Real checker CLI; fixture infra-runtime string tests generic dynamic scanning, not a production observer dependency |

Public methods are production-called by sender/monitor; binding retirement is private.
The SDK `clearForTest` seam is not used. The earlier optional reaction-request
observer was removed because its SDK export was absent on beta hosts. Terminal
observation now uses the public operator-approvals Gateway client (no competing
prompt planner); host artifact tests validate the actual import surface.
Existing manual ingress HIGH regression still passes. The new no-observation binding
fails on the old architecture. All four old artifacts fail the matrix (older hosts
do not seed unobserved targets; betas also fail the missing observer export audit).
Focused and full verification receipts are listed in the PR draft.

## Live verification limits

No push, PR publication, package installation, config edit, gateway restart or live
approval was performed by this worker. OG logs were read over SSH; live tests
reported by Debbie provided the immutable-widget and stream-mention failures. Debbie owns publication and live-client verification. Check
web/desktop widgets, mobile reactions, external winning decisions, TTL/not-found,
message-edit permissions and account teardown on a test Gateway before release.

## Terminal outcomes and Zulip widgets

Zulip refuses content edits on widget messages (`Widgets cannot be edited.`).
Validated approval delivery therefore sends an editable canonical prompt with
reactions, followed by a separate disposable zform message. Resolution edits
the original prompt, deletes the companion zform, and removes the bot's seeded
reactions (other users' reactions are not removed). An operator-approvals Gateway
client observes terminal events, including CLI/Control UI resolution, expiry and
cancellation;
it is stopped with the account monitor. Core may additionally post its normal
resolution message. API cleanup failures are logged and never reactivate a binding.
The bot requires Zulip permissions to edit its messages and delete its zforms.
If companion delivery fails after the original prompt succeeds, the sender logs
the failure, registers the original without a widget ID, and returns its successful
delivery. Reactions and manual fallback stay bound without duplicate-prompt retry.

Stream zform replies prepend a bot mention. Approval ingress removes only a
leading identity-qualified mention of the connected bot (numeric ID or email),
including silent mentions, before resolving a validated approval ahead of agent
dispatch. Other mentions and display-name-only mentions are not stripped.

## Live defect regression receipt

On `caeaecc`, the current regression files produced 22 failures (234 passed):
identity-qualified bot mentions were not intercepted, external terminal updates
had no production owner, and the sender attached immutable widgets to prompts.
The monitor case uses the exact live zform content in stream ingress with bot ID
13; it asserts settlement occurs without agent dispatch and rechecks revocation,
disablement, removal and abort. The four-host matrix models immutable widgets,
asserts two distinct delivery IDs, and verifies prompt edit/zform deletion/reaction
removal on external resolution. This replaces—not duplicates—the prior single
widget prompt assertion, which encoded Zulip behavior incorrectly.
