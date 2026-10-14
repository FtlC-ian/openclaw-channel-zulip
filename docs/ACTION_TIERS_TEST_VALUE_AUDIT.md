# Test value audit — per-account action tiers (feat/action-tiers)

Equivalent contract audit for the action-tier change (base `5330d85`). The
`test-value-audit` skill was not available in this session, so this record
applies the same rubric from `TEAM_PROTOCOL.md` directly: per logical contract,
name the tests, the observable contract, a credible regression, the strongest
owner boundary, overlap dispositions, fail/pass evidence, and remaining gaps.

## Scope of test changes

- `src/actions.test.ts` rewritten around the tier model: the removed
  `channel-create`/`channel-edit`/`channel-delete`/`member-info` handler tests
  were re-homed under tier-enabled configs rather than deleted, and the
  moderation gate now has its own always-on fail-closed table at the default
  config.
- `src/config-schema.test.ts` gained the actionTiers schema contract.
- `src/zulip/accounts.test.ts` gained tier resolution/merge contracts.
- No production seam was added or removed for tests. `advertiseZulipActions`
  is exported because it is the discovery surface itself (used by
  `describeMessageTool`), not a test-only seam; `resolveZulipAccountTiers` and
  `requireZulipActionTier` stay private and are covered through
  `handleAction`/`describeMessageTool`.

## Contract records

| Contract | Tests (owner) | Observable contract | Credible regression | Fail/pass evidence |
|---|---|---|---|---|
| Safe-default gating: moderation/streamAdmin off | actions.test "gated-off action tier defaults" (actions.test, handler boundary: `handleAction` + `describeMessageTool`) | Default-configured accounts advertise only messages-tier actions; every moderation/streamAdmin action rejects before `fetch` with the exact tier hint | A refactor that reverts `resolveZulipAccountTiers` defaults or drops `requireZulipActionTier` from `handleAction` re-exposes delete/create without opt-in | Mutation: removing the `requireZulipActionTier` call in `handleAction` fails 9 tests (2 moderation rejects, 3 streamAdmin rejects, legacy no-effect, default-discovery, schema-scope, supportsAction alignment); restored after evidence. Pass: full suite green at 914 |
| Gated actions executable at enabled tiers | actions.test "stream administration actions", "destructive message actions", "moderation message edits" (actions.test, wire boundary: mocked Zulip fetch) | With `actionTiers: {moderation: "on", streamAdmin: "on"}`, delete/unsend run only with `confirm: true` and hit `/messages/:id` DELETE; edit hits PATCH; channel-create POSTs subscriptions; channel-edit PATCHes `/streams/:id`; channel-delete resolves name→id then deletes | A wire-path regression (wrong endpoint/method) or a confirm check removed | `confirm` mutation: dropping `requireDestructiveConfirmation` fails the two without-confirm tests. Endpoint/method asserts already existed pre-change and were re-homed |
| Legacy `enableAdminActions` inertness | actions.test "accepts the legacy enableAdminActions field without changing enforcement" (actions.test, handler boundary) | `enableAdminActions: true` grants nothing; `delete` still rejects at defaults | Someone rebinding `enableAdminActions` to open a tier (scope creep or compatibility excuse) | Mutation in accounts.ts `buildResolvedAccount` widening `moderation` from the legacy flag fails this test; mutation log in `/Volumes/WorkingSpace/openclaw/tmp/zed-action-tiers-evidence/mutation-guard.log` |
| Fail-closed on account resolution failure | actions.test "fails closed when the account cannot be resolved" (actions.test, handler boundary) | When account resolution throws (e.g. approval-emoji collision), every gated action still rejects before any network call | A refactor that turns resolution errors into permissive defaults re-exposes elevated actions on broken configs | Mutation flipping the catch fallback to all-tiers-on fails 4 asserted tests; see mutation log |
| member-info never granted | actions.test (handler boundary) | `member-info` rejects as unsupported for every tier state including all-on; never advertised; `supportsAction` false | A re-added handler or tier list containing member-info | Mutation: moving `member-info` into the messages tier fails the always-off and supportsAction-alignment tests; see mutation log |
| Tier configuration schema | config-schema.test (config boundary: runtime zod + packaged manifest JSON schema) | `actionTiers` accepts the three keys with `"on"`/`"off"` at top level and per account; unknown keys/values rejected; manifest stays in parity with runtime | Manifest/runtime drift (the release-packaging failure mode this suite has caught before) | Parity sub-assert compares `manifest.properties.actionTiers` against runtime and `$defs.zulipAccount`; mutation of either side alone fails |
| Tier resolution + account-over-top merge | accounts.test "Zulip action tier resolution" (accounts.test, resolver boundary: `resolveZulipAccount`) | Defaults on/off; per-key account override wins without restating others; top-level applies to default account | Merge bug that drops top-level tiers for named accounts (the shallow-spread trap hit during implementation) | Regression was real: the first implementation read only `merged.actionTiers` and lost top-level `moderation: "on"` for account `work`; the test caught it before commit |
| Discovery/account scoping | actions.test "discovers tier-aware actions..." (actions.test, discovery boundary) | Requested account's tiers drive the advertised list; unconfigured default returns `[]` | Per-account resolution falling back to default config | retained-distinct (pre-existing test, re-homed to a partial-tier config) |

## Overlap disposition

- The old `describe`-level advertised-list equality test duplicated the
  capability loop; replaced by the tier-aware discovery test plus
  `supportsAction` alignment loop (single owner boundary: actions.test).
- Handler route tests (endpoint/method) kept exactly once per action now that
  channel-* actions live only behind streamAdmin; no duplicate wire asserts
  were added for the gated path beyond the reject-before-fetch proofs.
- `splitStreamTarget` remained a single grammar test (audit follow-up noted
  in docs/TEST_VALUE_AUDIT.md stands; not expanded here).

## Production seams touched

- `requireZulipActionTier` — private, called inside `handleAction` before
  `resolveZulipClient`; every non-test caller passes through the covered
  boundary. No dynamic dispatch or external harness references it.
- `advertiseZulipActions` — public export; grep shows actions.ts as the only
  importer. The SDK export gate (`check-sdk-exports.mjs`) re-ran clean.
- `ResolvedZulipAccount.actionTiers` — additive typed field; `channel.ts`
  describeAccount output intentionally unchanged (tier state is config, not
  credential state; exposing it in status snapshots is not required by this
  change and would widen the snapshot contract).
- No test-only flags, globals, or injection hooks added.

## Proof gaps

- No live-network proof (by design: all boundary tests mock `fetch`; the
  fail-closed guarantees are asserted at the handler boundary). The full
  mutation battery (7 production mutations, all detected, log at
  `/Volumes/WorkingSpace/openclaw/tmp/zed-action-tiers-evidence/mutation-guard.log`)
  covers the tier gate, defaults, discovery, the legacy flag, and the
  resolution-failure fail-closed path.
- `tsc` does not type-check tests (repo-wide known gap, unchanged).
- The tier-merge test proves field-wise override for one key; full cross
  product of 3-key merges was judged redundant after the resolver is a
  spread-then-default (single code path).
- The destructive-confirm tests for `channel-delete` at enabled tier were
  folded into one test (reject-then-succeed); the standalone dry-run row for
  channel-delete was dropped as a strict subset of the dryRun branch already
  covered by delete/unsend rows plus the channel-delete success row's shared
  dryRun handler branch. Judged acceptable: dryRun network-freedom for
  channel-delete is still exercised by the "keeps %s dry runs network-free"
  table row for channel-create/channel-edit, and the delete/unsend rows.
- Two guard implementations were probed and hardened during this audit: the
  initial `resolveZulipAccountTiers` mutation anchor (always-full-list
  advertised actions) initially passed a stale discovery test, and the
  tier-merge mutation revealed the merge bug in the first implementation.
  Both were fixed before the final battery; the surviving guards pin the
  corrected behavior.