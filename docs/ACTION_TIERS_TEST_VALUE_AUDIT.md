# Test value audit — per-account action tiers (feat/action-tiers)

Equivalent contract audit for the action-tier change (base `5330d85`,
repaired on top of commit `16fa7c7`). The `test-value-audit` skill was not
available in these sessions, so this record applies the same rubric from
`TEAM_PROTOCOL.md` directly: per logical contract, name the tests, the
observable contract, a credible regression, the strongest owner boundary,
overlap dispositions, fail/pass evidence, and remaining gaps.

## Actual core dispatch boundary

Core send/poll do not necessarily pass through `handleAction`. Their authoritative owner is now the shared tier gate at each outbound adapter entrypoint (text, media, payload, poll), before runtime credential resolution. `src/channel-action-tiers.test.ts` invokes the real SDK-native message bridge and legacy outbound methods, with real send/client code and mocked fetch. It proves disabled denial before credentials/network, enabled text/poll delivery, and preservation of the direct internal reply entrypoint used by monitor.ts. Each of the four outbound gates is removed separately: the static-credential legacy test resolves/sends instead of rejecting, then restored guarded code passes (4/4 detected, log `zulip-b-core-mutations.log`). Bridge and legacy coverage preserve two supported host API contracts; handler tests remain primary only for plugin-owned actions.

The supported SDK offers no trustworthy tool-vs-non-tool origin field on outbound context. Consequently messages off disables shared/core outbound (including scheduled/core-routed delivery), not just a guessed subset of tool sends. Normal inbound Zulip replies and lifecycle/progress delivery remain enabled because monitor.ts uses direct internal sendMessageZulip. This choice is explicit in upgrade documentation. No user-controlled payload flag bypasses the gate.

## Scope of test changes

- `src/actions.test.ts` covers the tier model at the handler/discovery
  boundary: safe-default gating tables per tier, messages-off inertness, all-off
  inertness, moderation-gated `member-info` behavior (route + gate), the
  confirmation schema scoped to advertised destructive actions at full opt-in,
  the full origin/main handler-parameter contributions restored, legacy
  `enableAdminActions` inertness, fail-closed account resolution, core-owned
  `poll` rejection, and all baseline wire-path route tests re-homed to
  tier-enabled configs.
- `src/config-schema.test.ts` holds the actionTiers schema contract.
- `src/zulip/accounts.test.ts` holds tier resolution/merge contracts.
- No production seam was added or removed for tests. `advertiseZulipActions`
  is exported because it is the discovery surface itself (used by
  `describeMessageTool`), not a test-only seam. `resolveZulipAccountTiers` remains private; `requireZulipActionTier` is a shared production export used by actions.ts and channel.ts, covered through handler and actual outbound dispatch tests.

## Contract records

| Contract | Tests (owner) | Observable contract | Credible regression | Fail/pass evidence |
|---|---|---|---|---|
| Safe-default gating: moderation/streamAdmin off, member-info requires moderation | actions.test "gated-off action tier defaults" (actions.test, handler boundary: `handleAction` + `describeMessageTool`) | Default-configured accounts advertise only messages-tier actions (send, read, search, react, channel-list, core-owned poll); every moderation/streamAdmin action rejects before `fetch` with the exact tier hint, including `member-info` -> moderation hint | A refactor that reverts `resolveZulipAccountTiers` defaults or drops `requireZulipActionTier` from `handleAction` re-exposes delete/create/member-info without opt-in | Mutation: removing the `requireZulipActionTier` call in `handleAction` fails the reject tables; restored after evidence. Pass: full suite green |
| All three tiers honored (messages off => inert tool) | actions.test "rejects every action with an inert all-off tier map" and "rejects send ... messages tier is off" + discovery assertions (actions.test, handler boundary) | `actionTiers.messages: "off"` yields `describeMessageTool().actions === []` and every tier action (send/read/search/react/channel-list) rejects with the messages tier hint before any fetch; core-owned poll still rejects as plugin-unsupported | `advertiseZulipActions` short-circuiting `messages: false` to the messages list, or `requireZulipActionTier` skipping the messages tier | Mutation: reverting `advertiseZulipActions` to an unconditional messages baseline fails the all-off discovery and reject assertions; see mutation log |
| Full opt-in preserves the complete origin/main action surface | actions.test "grants moderation and streamAdmin tiers per account", "advertises the shared action list...", schema-scope and handler-parameter tests (actions.test, discovery boundary) | At `{moderation:"on", streamAdmin:"on"}` discovery equals `ZULIP_ADVERTISED_ACTIONS` (the origin/main 13-action list) and schema contributions expose the full channel-create/channel-edit property sets plus confirm scoped to `["channel-delete","delete","unsend"]` | Schema regression (dropped fragments/properties) or a tier filter that leaks gated actions into the full-opt-in list | Assertion on `ZULIP_ADVERTISED_ACTIONS` equality plus per-action property maps; mutation filtering poll out of the advertised list fails the equality test; see mutation log |
| Gated actions executable at enabled tiers | actions.test "stream administration actions", "destructive action confirmation", "moderation message edits", "reachable action routes" (actions.test, wire boundary: mocked Zulip fetch) | With tiers on, delete/unsend run only with `confirm: true` and hit `/messages/:id` DELETE; edit hits PATCH; channel-create POSTs subscriptions; channel-edit PATCHes `/streams/:id`; channel-delete resolves name→id then deletes; member-info routes to `/users/42` or `/users/me` | A wire-path regression (wrong endpoint/method) or a confirm check removed | `confirm` mutation: dropping `requireDestructiveConfirmation` fails the without-confirm tests. Endpoint/method asserts preserved from origin/main |
| member-info behavior restored | actions.test "member-info behavior", "routes member-info to its Zulip read endpoint" (actions.test, wire boundary) | At moderation-on, `member-info` fetches `/users/{id}` (or `/users/me` without id) and returns `{ok:true,user}`; outside moderation it rejects with the moderation tier hint before fetch | Handler deletion or gate regression re-banning member-info | Reject-at-default + route-at-enabled tests pin both directions |
| Legacy `enableAdminActions` inertness | actions.test "accepts the legacy enableAdminActions field without changing enforcement" (actions.test, handler boundary) | `enableAdminActions: true` grants nothing; `delete` still rejects at defaults | Someone rebinding `enableAdminActions` to open a tier (scope creep or compatibility excuse) | Mutation in accounts.ts `buildResolvedAccount` widening `moderation` from the legacy flag fails this test; mutation log in repair evidence dir |
| Fail-closed on account resolution failure | actions.test "fails closed when the account cannot be resolved" (actions.test, handler boundary) | When account resolution throws (e.g. approval-emoji collision), every tier action — including messages-tier send — rejects before any network call | A refactor that turns resolution errors into permissive defaults re-exposes actions on broken configs | Mutation flipping the catch fallback to all-tiers-on fails the asserted rejects; see mutation log |
| Tier configuration schema | config-schema.test (config boundary: runtime zod + packaged manifest JSON schema) | `actionTiers` accepts the three keys with `"on"`/`"off"` at top level and per account; unknown keys/values rejected; manifest stays in parity with runtime | Manifest/runtime drift (the release-packaging failure mode this suite has caught before) | Parity sub-assert compares `manifest.properties.actionTiers` against runtime and `$defs.zulipAccount`; mutation of either side alone fails |
| Tier resolution + account-over-top merge | accounts.test "Zulip action tier resolution" (accounts.test, resolver boundary: `resolveZulipAccount`) | Defaults on/off; per-key account override wins without restating others; top-level applies to the default account | Merge bug that drops top-level tiers for named accounts (the shallow-spread trap hit during implementation) | Regression was real in the first implementation: reading only `merged.actionTiers` lost top-level `moderation: "on"` for account `work`; the test caught it before commit |
| Discovery/account scoping | actions.test "discovers tier-aware actions..." (actions.test, discovery boundary) | Requested account's tiers drive the advertised list; unconfigured default account returns `[]` | Per-account resolution falling back to default config | retained-distinct (pre-existing test, re-homed to a partial-tier config) |
| Core-owned poll rejection | actions.test "reports unsupported actions before credential resolution", supportsAction alignment loop (actions.test) | `poll` is advertised under messages but `supportsAction("poll")` is false and direct `handleAction("poll")` rejects before credential/network access; at full opt-in the advertised list still contains `poll` | A handler branch for poll or supportsAction returning true for poll | supportsAction loop asserts `poll` false while advertised; runAction("poll") with `{}` cfg rejects before fetch |

## Overlap disposition

- The advertised-list equality test (origin/main baseline) and the safe-default
  discovery assertions test different states (full opt-in vs defaults), so both
  are retained with distinct owners in one file.
- Handler route tests (endpoint/method) kept exactly once per action now that
  channel-* and member-info live only behind enabled tiers; no duplicate wire
  asserts were added for the gated path beyond the reject-before-fetch proofs.
- `splitStreamTarget` remained a single grammar test (audit follow-up noted in
  docs/TEST_VALUE_AUDIT.md stands; not expanded here).
- The all-off inertness table overlaps the per-tier reject tables by mechanism
  but not by contract: it pins the messages-tier gate specifically, which the
  moderation/streamAdmin tables cannot catch (their configs leave messages on).

## Production seams touched

- `requireZulipActionTier` — production export called inside `handleAction` before `resolveZulipClient` and at all four core outbound entrypoints before runtime account/SecretRef resolution. Core-owned send and poll bypass the handler, so outbound integration tests own their enforcement contract. Internal inbound reply callers deliberately retain direct delivery.
- `advertiseZulipActions` — public export; grep shows actions.ts as the only
  importer. The SDK export gate (`check-sdk-exports.mjs`) re-runs clean.
- `ResolvedZulipAccount.actionTiers` — additive typed field; `channel.ts`
  describeAccount output intentionally unchanged (tier state is config, not
  credential state).
- No test-only flags, globals, or injection hooks added.

## Proof gaps

- No live-network proof (by design: all boundary tests mock `fetch`; the
  fail-closed guarantees are asserted at the handler boundary). The mutation
  battery (7 production mutations, all detected) covers the tier gate,
  defaults, discovery, the legacy flag, the resolution-failure fail-closed
  path, and the messages-off inertness path.
- `tsc` does not type-check tests (repo-wide known gap, unchanged).
- The tier-merge test proves field-wise override for one key; full cross
  product of 3-key merges was judged redundant after the resolver is a
  spread-then-default (single code path).
- Schema-contribution filtering is asserted through `describeMessageTool` at
  both default (gated fragments absent) and full opt-in (all fragments present,
  confirm scoped to the advertised destructive list); the intermediate
  single-tier states are covered by the partial-tier discovery test rather
  than a per-fragment sweep, judged acceptable because the filter is a single
  `allowed.has` predicate over one input list.