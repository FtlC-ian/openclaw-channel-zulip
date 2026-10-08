# Approval reactions

## Structural constraints

- One Zulip message is shared across clients: retain the existing zform on the
  approval message, and bind reactions only after Zulip returns its exact ID.
- Approval ownership is canonical metadata, never inferred from message text or
  approval-ID prefixes. SDK typed controls must agree with metadata; shipped
  command controls must enumerate exactly that same ID/decision set.
- Reactions require explicit normalized `allowFrom` approvers. Resolve event user
  IDs through the account's authenticated Zulip API, reject all bots, and reuse
  `approval-auth.ts`. Empty approvers fail closed even though ordinary command
  authorization historically allows an empty list.
- Gateway canonical request observations supply owner and absolute expiry. The
  shared resolver owns global first-wins arbitration, including other channels
  and `/approve`; local claims serialize same-account sibling deliveries.
- Account removal, disablement and abort are rechecked after asynchronous user
  lookup and immediately before manual/zform command settlement. Hooks before persistence must not stop a still-configured monitor.
  Committed teardown clears only that account's ephemeral approval state.
- No durable approval state is introduced. Each of the observed-request and
  delivered-binding maps is capped at 1,000 entries globally, pruned on admission
  and use, and cleared at account stop/removal. Full capacity fails closed rather
  than evicting an active binding. SDK request timers own expiry/finalization.

## Transport and outcomes

Default reactions are **✅ (`check`) = allow-once** and **❌ (`cross_mark`) = deny**.
Configure `approvalReactions.approve` and `approvalReactions.deny` at the channel
root or under `accounts.<id>`. These are dynamic settings; existing bindings keep
what was shown/seeded and new messages use current settings. A reaction never
stands for allow-always. Supported values are the existing documented Unicode
set and named Zulip emoji; empty values are invalid and collisions fail closed.

The account monitor registers message **and reaction** events on every queue
registration/recovery. A Gateway approval observer (shared SDK runtime, no second
Zulip queue) observes canonical requests, resolutions and timeouts. It does not
send prompts or suppress existing forwarding. The message sender keeps zform and
adds reaction instructions; binding registration seeds the two allowed controls.
Reaction removal, self/bot reactions and reactions without an exact account/message
binding do nothing. Actor policy is refreshed after identity lookup.

Resolution deletes all sibling bindings before editing their original messages:

```
<original request and fallback commands>

**Approval outcome: allow-once**
These controls are no longer active.
```

Deny and expiry use their corresponding outcome. The result returned by the
canonical resolver is displayed, not a losing local selection. Gateway terminal
events also finalize messages when a decision came from another surface.
Zulip content edits do not reliably erase an existing zform submessage, so stale
widget buttons can remain visually present; their command is still governed by
Gateway terminal state. Further reactions cannot resolve the request. Failed
terminal edits are logged, but bindings remain retired. Failed seeding is
best-effort: users can manually add the configured emoji.

## SDK evidence

Pinned `openclaw@2026.9.6` exposes:

- `approval-reaction-runtime`: canonical metadata/presentation validators and
  `settleApprovalReaction` (explicit approvers, shared auth and stale handling).
- `approval-gateway-runtime`: owner-aware `resolveApprovalOverGateway` returning
  the actual terminal decision/status and `applied` winner indicator.
- `infra-runtime`: `createExecApprovalChannelRuntime`, with requested/resolved/
  expired hooks, replay and stop ownership.
- `approval-native-runtime`: account selection, including forwarding accounts.

The pinned package explicitly omits `approval-reaction-runtime.d.ts`; the small
`approval-sdk.ts` facade supplies only consumed type signatures and imports the
shipped helper implementations. No core code is vendored. Both generic pending
payloads (`state: pending`) and the actual exec builders (no `state` field) are
covered; resolved metadata without controls is never actionable.

Compared tagged [Signal](https://github.com/openclaw/openclaw/blob/v2026.9.7/extensions/signal/src/approval-reactions.ts),
[iMessage](https://github.com/openclaw/openclaw/blob/v2026.9.7/extensions/imessage/src/approval-reactions.ts)
and [WhatsApp](https://github.com/openclaw/openclaw/blob/v2026.9.7/extensions/whatsapp/src/approval-reactions.ts)
reaction approval sources. They use the same shared approval-reaction and gateway
resolver helpers. [v2026.10.1-beta.1 reaction runtime](https://github.com/openclaw/openclaw/blob/v2026.10.1-beta.1/src/plugin-sdk/approval-reaction-runtime.ts),
[binding validators](https://github.com/openclaw/openclaw/blob/v2026.10.1-beta.1/src/plugin-sdk/approval-reaction-binding.ts)
and [observer contracts](https://github.com/openclaw/openclaw/blob/v2026.10.1-beta.1/src/infra/exec-approval-channel-runtime.types.ts)
retain the consumed validator/resolver signatures, but source signatures alone
are not package-export compatibility. OG's installed beta.1 export map matches
its tagged package.json and does **not** export `infra-runtime`; beta.2 also omits
it. The direct observer has no public export in either beta. `approval-runtime`
exports `createChannelNativeApprovalRuntime` on all four hosts, but that adapter
plans/delivers native prompts and reports routing, so it is not a passive observer
replacement: using it could duplicate or suppress the existing forwarding path.

The passive observer is now a guarded dynamic import of the public
`infra-runtime` subpath. On hosts without it, reaction approvals disable with one
process-wide log; startup, zforms and core `/approve` continue normally. Without
canonical observation, the sender neither advertises nor seeds reaction controls.
Actual observer startup/transport failures on supported hosts still propagate.
No non-exported core internals are imported.

The full source audit includes type-only imports, test imports and mocks. Every
subpath except `infra-runtime` is exported by all four npm packages:

| Subpath (openclaw/plugin-sdk/) | 9.3 | 9.6 | beta.1 | beta.2 |
|---|---|---|---|---|
| allow-from | yes | yes | yes | yes |
| approval-gateway-runtime | yes | yes | yes | yes |
| approval-native-runtime | yes | yes | yes | yes |
| approval-reaction-runtime | yes | yes | yes | yes |
| approval-reply-runtime | yes | yes | yes | yes |
| approval-runtime | yes | yes | yes | yes |
| channel-config-schema | yes | yes | yes | yes |
| channel-contract | yes | yes | yes | yes |
| channel-feedback | yes | yes | yes | yes |
| channel-inbound | yes | yes | yes | yes |
| channel-ingress-runtime | yes | yes | yes | yes |
| channel-outbound | yes | yes | yes | yes |
| channel-pairing | yes | yes | yes | yes |
| channel-secret-basic-runtime | yes | yes | yes | yes |
| channel-send-result | yes | yes | yes | yes |
| command-auth-native | yes | yes | yes | yes |
| core | yes | yes | yes | yes |
| directory-runtime | yes | yes | yes | yes |
| infra-runtime | yes | yes | NO | NO |
| interactive-runtime | yes | yes | yes | yes |
| media-runtime | yes | yes | yes | yes |
| param-readers | yes | yes | yes | yes |
| plugin-entry | yes | yes | yes | yes |
| question-gateway-runtime | yes | yes | yes | yes |
| reply-runtime | yes | yes | yes | yes |
| routing | yes | yes | yes | yes |
| runtime-env | yes | yes | yes | yes |
| runtime-store | yes | yes | yes | yes |
| secret-input | yes | yes | yes | yes |
| secret-input-runtime | yes | yes | yes | yes |
| secret-ref-runtime | yes | yes | yes | yes |
| session-store-runtime | yes | yes | yes | yes |
| setup | yes | yes | yes | yes |
| ssrf-runtime | yes | yes | yes | yes |
| temp-path | yes | yes | yes | yes |
| web-media | yes | yes | yes | yes |

`npm run build` audits all built static imports/re-exports and literal dynamic
imports against the pinned package's exports; `npm run sdk:check -- <package.json>`
can target another host. Beta audits intentionally report the guarded optional
`infra-runtime` as missing; real built-index/setup imports and observer disablement
smokes pass on both betas. Smoke hosts were npm-pack extracted into scratch,
with matching beta `@openclaw/ai` packages and remaining dependencies resolved from
the existing pinned development dependency tree (not full clean host installs).

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

Primary owner is the channel approval-control boundary, using real Zulip client
serialization, SDK binding validators and SDK settlement logic, with a controlled
Gateway resolver/HTTP transport. It proves plugin behavior, not Gateway service
internals or live client rendering. Public store methods are production-called by
sender, monitor and SDK observer; there are no test-only production methods.

| Contract | Tests and credible regression | Strongest practical owner / overlap disposition |
| --- | --- | --- |
| Owner/control parity | Real generic + typed/command exec SDK builders; wrong owner, decision mismatch, terminal metadata | SDK-backed control boundary; distinct payload formats retained |
| Authorization | Authorized/unauthorized/API-derived actor; explicit approvers; bots/inactive/missing email; policy refresh | Control boundary, real `approval-auth.ts`; guards are distinct risks |
| Arbitration | Duplicate events, sibling messages, both widget/manual command vs reaction orders, Gateway losing result | Local claim tests prove local serialization; controlled Gateway result proves correct display, not core atomicity |
| Isolation/expiry | Wrong message/account; removal events; expired controls; removed/disabled/aborted lookup races | Control boundary; each independently protects a side-effect admission condition |
| Terminal lifecycle | External resolve/expire, terminal content, not-found, real failures/retry, failed edit | Observer/control boundary; retained fault cases cover recovery and absence of repeat execution |
| Config/state bounds | Custom emoji/collision; bounded admission/freeing capacity; account clear | Control boundary; runtime/manifest config test owns public schema parity |
| Host compatibility | Missing observer export: two accounts start/stop, one log, no binding/resolution/interception; real extracted beta index/setup imports and disablement smoke | Plugin load/observer boundary; controlled missing export test proves plugin fallback, real smoke proves Node exports enforcement |
| Built artifact SDK contract | Checker subprocess fails on an absent dynamically imported export, then passes with complete fixture exports; covers nested JS and static re-exports | Real checker CLI boundary; no network dependency or production-only test seam |
| Fallback presentation | Sender with/without authoritative observation preserves zform commands but advertises reactions only when observed | Real sender boundary; distinct from observer binding/no-interception risk |
| Deferred fairness timing | Existing starvation regression now waits for first release with zero fake-clock advancement, then retains exact 200ms/250ms outcomes | Real monitor replay boundary; async SDK discovery no longer assumed complete after one event-loop flush |
| Integration | Sender retains zform and passes exact sent ID; monitor routes reaction without agent dispatch; all queue recovery assertions; manual/zform ingress await followed by approver revocation, disablement, removal or abort (plus positive control) | Real sender/monitor boundary with collaborator spies; not duplicates of store semantics |

Controlled regression mutations were restored immediately: authorizer forced to
allow made the unauthorized-actor test fail; disabling local claim checks made
the duplicate-event test fail. Both passed on restored production code. Logs are
kept alongside the worktree as `zulip-92-auth-regression.log` and
`zulip-92-race-regression.log`. Full build/test/diff receipts are in the PR draft.
The manual/zform monitor regression also failed before the Hawk HIGH finding was
fixed: revocation, disablement and removal each invoked the resolver once when
zero calls were permitted. The unchanged-account positive control still resolves
once. All five monitor cases pass with current-config/abort revalidation; a direct
command test additionally verifies an already-aborted command is consumed without
resolution. Receipts: `zulip-92-manual-gap-before.log` and
`zulip-92-manual-gap-after.log` beside the worktree.
The named `test-value-audit` skill is not available in this worker's supplied
skill catalog or local skill directories; this ledger records the required gate
manually for independent reviewer validation.

## Limits and live verification

Bindings are process-local: restarting/removing the account retires old reaction
controls; typed `/approve` remains the fallback. If canonical request observation
has not arrived when the outbound send completes (or admission is full), no
reaction binding/seeding is created. This is deliberate fail-closed behavior,
not authorization inferred from message text. Missing public observer SDK disables
only reactions; other Gateway observer start failures still fail account startup.

No OG installation/configuration/restart or live approval was performed here.
Debbie owns publication and the OG live test; use the precise script in the PR
draft to validate actual clients, broadcast timing and message-edit permission.
