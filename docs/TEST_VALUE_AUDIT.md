# Test value audit

Whole-suite audit of the Zulip channel plugin tests against the `test-value-audit` rubric
(base `0fd7c0b`, branch `chore/test-value-audit`). The bar is independent confidence, not
deletion totals. Redundancy was judged by reading both tests and the production code; the risky
removals were mutation-checked (a temporary production change that a surviving test must catch,
then restored with `git checkout`).

## Before / after

| | Before | After |
|---|---|---|
| Vitest tests (`src`) | 899 in 30 files | 820 in 29 files |
| Node tests (`scripts/*.test.mjs`) | 14 + 4 host smoke | unchanged |
| Test LOC (`src/**/*.test.ts`) | 12,021 | 11,182 (-839) |
| Production LOC (`src/**/*.ts`, non-test) | 11,200 | 11,123 (-77) |

Per-file Vitest counts that changed:

| File | Before | After |
|---|---|---|
| src/destination-receipt.test.ts | 107 | 59 |
| src/zulip/monitor.test.ts | 170 | 165 |
| src/channel.test.ts | 28 | 22 |
| src/actions.test.ts | 57 | 54 |
| src/zulip/topic-case.test.ts | 46 | 42 |
| src/config-schema.test.ts | 28 | 26 |
| src/secret-contract.test.ts | 9 | 6 |
| src/zulip/subagent-reactions.test.ts | 13 | 11 |
| src/zulip/send.test.ts | 31 | 30 |
| src/zulip/client.test.ts | 22 | 21 |
| src/zulip/question-zform.test.ts | 54 | 53 |
| src/zulip/monitor-helpers.test.ts | 12 | 11 |
| src/session-rotation.test.ts | 2 | deleted |

Most of the 79 fewer Vitest results are rows of the destination matrix, not distinct tests. The
verdict of the audit is that the suite is mostly independent security, concurrency, retry and
protocol guards; the genuinely low-value share is modest (about 10% by count, far less by risk).

## Contract records

"Owner" is the primary test boundary. All areas not listed under Removed were judged retained.

| Area | Tests | Protected contract / credible regression | Owner | Overlap disposition |
|---|---|---|---|---|
| Destination grammar -> route, wire topic, receipt, logs | destination-receipt (text kind) | Wrong topic/stream sent, or receipt disagreeing with the wire | destination-receipt, text kind (full matrix via `sendMessageZulip` -> `resolveZulipSendDestination`) | Media/payload/multipart/poll kept as a wrapper-focused subset; 5 `channel.ts` mutations (drop/mangle `threadId`) caught by it. Rest removed |
| Reply message ID never becomes a topic; API failure not a success receipt | destination-receipt, all kinds | Receipt fabrication | each kind (per-wrapper risk) | retained-distinct |
| Outbound send widgets, approval prompt + zform, ask_user binding | send.test | Control lost or bound to the wrong recipient | send.test | DM ask_user folded into the existing table; widget copies replaced by wiring/precedence asserts |
| Client wire/retry | client.test | Register payload, Retry-After, network retry, reaction idempotency, long-poll abort | client.test | 12.2 capability test removed (same payload as first register test); reaction tests became 2 tables, `REACTION_DOES_NOT_EXIST` row made discriminating |
| Uploads, probe, accounts | uploads, probe, accounts tests | Path traversal / origin, auth header, SecretRef precedence | own files | retained |
| Topic identity | topic-case.test | Persisted session identity (`zulip-topic-lower-u16-v1`) | topic-case.test | 4 trivial rows duplicated by retained rows removed |
| Monitor: inbound policy, topics, streams, mention gating, durable journal, dedupe, abort, lifecycle, mark-read | monitor.test | allowFrom/stream/topic isolation, replay fail-closed, no double completion | monitor.test (only owner of `durable-receive.ts`) | see Removed |
| Question controls after real outbound | monitor.test (native/mobile x 7 policy rows) | Stale/revoked controls bypass authorization | monitor.test | retained; ordered-list parsing owned by question-zform |
| Question zform parse/bind/evict | question-zform.test | Wrong option resolved, binding leaks | question-zform.test | two widget-delete tests merged |
| Approval reactions/auth/presentation, status and subagent reactions | approval-*, status-reactions, subagent-reactions | Non-approver approves, wrong binding settles | approval-reactions.test, channel adapter test | two subset subagent tests removed; two cases folded into existing tables; duplicate emoji asserts dropped |
| Actions | actions.test | Missing confirm on destructive actions, wrong endpoint/emoji | actions.test | reactions became one 7-row table; `splitStreamTarget` 3->1 |
| Session keys / routes | session-conversation, channel, monitor | Cross-realm/user/account session collision | session-conversation.test | channel route tests became one `it.each` |
| Approval authorization adapter | channel.test | Non-allowFrom sender approves exec | channel.test (adapter), approval-reactions (integration) | strengthened (see below) |
| Config schema / manifest | config-schema, secret-contract | Manifest drifting from runtime schema; secret targets dropped | config-schema.test | duplicates merged; manifest parity strengthened |
| Directory, threading, doctor/policy adapters, lifecycle, heartbeat, routing-fallback, stream-policy, channel-message | own files | isolation, races, failure | own files | retained; 4 `typeof` asserts dropped from channel-message |
| SDK-export check, topic-session migration, host smoke | scripts tests | packaging, migration, multi-host | scripts tests | retained untouched |

## Removed or consolidated

Phase 1 - `test: trim send-kind destination matrix ...` (0161b26)
- destination-receipt: 48 tests. The full grammar was replayed for 5 send kinds although one
  resolver owns it; the route is also independent of kind. Text keeps all rows (11 topic, 3
  default/empty-override, 5 DM spellings); the other kinds keep 4 topic rows, 2 default rows, 1 DM
  row, reply-ID and API-failure cases. Mutation evidence: dropping the topic in `sendMedia`,
  `sendPayload` (media and text branches) or `sendPoll`, and a truthy check on `threadId` in
  `sendText`, each fail the reduced matrix.
- send.test: explicit-target topic half (covered by the destination matrix against the wire body);
  rewritten media half now also asserts no re-upload for Zulip-hosted URLs. Canonical command
  presentation test removed (fallback-controls test asserts the same `/approve inactive` replies).
- client.test: Zulip 12.2 capability test (same `client_capabilities` payload as the first
  register test, against a mock that re-implements the server check).
- topic-case: `Release-A`, `general`, `CAFE`, `STRASSE` rows (each duplicated).

Phase 2 - `test: dedupe monitor and monitor-helpers tests` (fbcfc37)
- "wires typing idle cleanup" (asserts the mock's `onIdle` is the same function; setting
  `onIdle: undefined` still fails the dispatch test), "sends presentation-only replies" (same
  branch as the placeholder-removal test), live-reply completion-only retry (subset of the
  mark-read variant), the ordinary-inbound/no-system-event test (folded into the accepted-dispatch
  test), the ZulipFlutter ordered-list monitor test (parser owned by question-zform; mobile rows
  of the outbound->inbound table cover the monitor path and now assert `resolveOption`).
- Merged into tables: stream private/public metadata, DM routing, four topic-filter tests; the
  six `formatInboundFromLabel` tests; helper "first occurrence" removed; eviction test rewritten.
- Store-caps test no longer copies the literals 250/700 from `durable-receive.ts`; it keeps the
  sum < 1000 plugin-state invariant.

Phase 3 - `test: fold subset approval, question and reaction tests ...` (9a189e2)
- Two subagent-reaction tests that were strict subsets (mutating `asyncContext ?? exactContext`
  to `exactContext` fails two survivors); clear-account-in-flight and gateway-winner cases are now
  rows of existing tables (removing the `canSettle` binding-identity check fails both `cleared`
  rows); two widget-source-delete tests merged into one that also asserts the replacement delete.

Phase 4 - `test: remove host-only, self-comparing ...` (e98098e)
- `session-rotation.test.ts` deleted (2 tests): it only calls host SDK functions
  (`resolveSessionResetPolicy`, `evaluateSessionFreshness`); no plugin code can make it fail, and
  it runs only against the pinned development SDK, so it proves nothing about the supported-host
  range. See "For Ian".
- channel.test: five tests (copied `meta` constant; poll advertisement already owned by the
  actions capability loop; host `createReplyPrefixOptions`; unrelated-literal comparison;
  duplicate guidance test). Two tests with `if (!normalize) return` guards (could pass with no
  assertion) merged into direct calls.
- secret-contract: duplicate open-DM refinement test and a thinking-placeholder test covered by
  config-schema.
- config-schema: reaction-accept and stream-override accept/reject merged; the hand-copied key
  list test replaced by real parity checks.
- actions: reaction table, `splitStreamTarget` merge. channel-message: four `typeof` asserts.

Strengthened rather than removed:
- Approval authorization (`channel.test`): previously only a listed sender was accepted, so
  "always authorize" passed. Now also denies another sender, empty sender and null, and checks case
  and prefix normalization. Mutating `approval-auth.ts` to `if (true)` fails it.
- Manifest parity (`config-schema.test`): exact key parity of manifest vs runtime schema at top
  level and per account, plus stream-rule fields. Renaming `markHandledRead` in the manifest fails.

## Suspicious-looking tests kept

- topic-case table: expected values come from the Unicode spec and pin a persisted identity
  version (deliberate bump alarm).
- Client retry/log-event shapes feed operational logging; probe.test asserts the identity header
  (wire protocol, only coverage of the probe path).
- Uploads filename table: each row is a distinct traversal vector.
- Approval-reactions tests spying `register`: guard that a failed companion zform never unbinds the
  prompt. question-zform eviction test reads the private `bindings` map because eviction order is
  not observable otherwise.
- monitor: 58261 ordered-list test (only proof the monitor passes html to `intercept`); legacy
  keyed-journal tests (only coverage of journal migration and failure); BAD_EVENT_QUEUE_ID test
  (asserts the message is still processed after recovery); pinned-core cancel test (needs the
  installed `openclaw` dist layout; only integration proof against the real channel manager).
- directory "sweeps expired credential identities": spies on `Map.prototype.delete` with a private
  key regex (brittle) but guards a leak nothing else observes.
- manifest.test, runtime.test, advertised-list self-comparison in actions.test, first test in
  policy-adapters: cheap packaging/host-contract pins.
- approval-host-smoke (4 real host builds) and the SDK-export and migration scripts tests:
  untouched protected guards.
- Mock-heavy lifecycle, heartbeat, routing-fallback, stream-policy, threading: each pins a distinct
  race, isolation or failure contract.

## Seam dispositions

| Symbol | Disposition |
|---|---|
| `extractShortModelName`, `rawDataToString`, `resolveIdentityName`, `ResponsePrefixContext` (monitor-helpers.ts) | Removed: no callers in src/scripts/index/package, no tests; `ws` and `OpenClawConfig` imports went with them |
| re-export of `normalizeLegacyZulipTarget`/`parseZulipTarget`/`ZulipTarget` in send.ts | Removed: no non-test importer; send.test now imports from destination.js |
| `createDedupeCache`, `formatInboundFromLabel`, `clearPrefix` | Production-required (monitor.ts) |
| `clearZulipSubagentReactionContexts` | Production-required (`gateway_stop` hook) |
| `ZULIP_ADVERTISED_ACTIONS`, `buildZulip*SessionKey`, `buildZulipStreamConversation`, `resolveZulipSessionConversation` | Production-required |
| `splitStreamTarget` (actions.ts) | Follow-up: used internally; `export` exists only for actions.test. Make private and cover through the action handlers |
| `pollToZulipWidgetContent`, `resolveZulipWidgetContent` (send.ts) | Follow-up: used internally; `export` exists for send.test unit asserts |
| `ZULIP_CHANNEL_TURN_DIAGNOSTICS` | Production-required operator flag |

No flags, globals or injection hooks added only for tests were found.

## Proof gaps

- No test covers a completion failure for an unhandled (non-handled) outcome in `monitor.ts`:
  changing that branch from `"pending-completion"` to `"settled"` left every monitor test green.
  A new test is worthwhile; not added here.
- `probe.test.ts` covers only success (no non-2xx, non-JSON or timeout case).
- `tsconfig.json` excludes `**/*.test.ts`, so `tsc` does not type-check tests; Vitest is the only
  gate for test edits.
- Redundancy of the removed live-reply completion-retry test was judged by reading, not mutation.

## For Ian to decide

- `session-rotation.test.ts` deletion: restore it (preferably in a host-compat suite) if you want
  a canary for host reset-policy drift (it came with #74).
- Per-kind destination matrix reduction: revert the `full` filter in destination-receipt.test.ts to
  restore all 48 rows if you want the full grammar for every kind.
- Pinned-core cancel test in monitor.test: keep as a release guard or move to a separate
  integration suite.
- Follow-ups above (`splitStreamTarget`, widget helper exports, Map-spy directory test).
- Cheap low-value pins that could go with little loss: manifest.test, runtime.test, the
  advertised-list self-comparison.
