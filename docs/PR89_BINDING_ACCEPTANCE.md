# Independent PR89 binding acceptance

The authorized candidate's harness accepts `ZULIP_SMOKE_SUITE=bindings` or
`ZULIP_SMOKE_SUITE=full`. Omission means `full`; every other value, including an
empty string or whitespace, fails before protected configuration or network use.
Run the existing `node scripts/live-smoke/run.mjs` entrypoint with the selection
set by the protected runner. The ancestry-preserving reconciliation incorporates
main's trusted workflow unchanged, including strict dispatch selection and the
binding-only precredentials candidate probe.

`bindings` executes all binding scenarios without the general private-child/yield,
reaction, upload, poll, or durable scenarios. Those assertions are **not run**,
not silently passed or recorded as successful skips. Scenario reports, evidence,
and completion are suite-tagged. This is not full-suite acceptance. The default
preserves the general scenarios, their failures, and then the binding scenarios.

## Strengthened live assertions (not yet live-observed)

- Max-age: a separate run-specific topic sets idle to 10 minutes and max-age to
  20 seconds, checks the persisted age cap, waits beyond the persisted expiry,
  then requires ordinary-session transcript evidence, no ACP marker diversion,
  and absence of the binding. It does not prove expiry by metadata mutation alone.
- Topic move: after the canonical case-alias check, the actor calls Zulip's
  `PATCH /messages/{id}` with `propagate_mode=change_all` on the run-specific
  topic, suppressing move notifications. Before/after message reads require the
  same numeric stream and the actual changed topic. The new canonical identity
  must remain unbound, ordinary fallback must work, and explicit rebind must
  create a different ACP target. The original canonical binding remains isolated.
  A realm that disallows topic moves fails; it is not converted to a skip.
- Cleanup: preexisting targets are never closed. Every tracked test target,
  including targets already marked closed, is inspected read-only for persisted
  bindings after close. Stale owners, unreadable stores, or failed closes fail
  cleanup. Binding-only message deletion failures also fail acceptance; full
  mode retains its existing explicit deletion warnings. Zulip has no public
  uploaded-file deletion API (binding-only does not upload files).

Candidate staging now carries the compatible lifecycle priming from the frozen
main workflow helper: isolated `openclaw --version` runs before the bundled guard,
then the candidate is staged, then pinned acpx is installed before protected
configuration. CLI children inherit an allowlist, not production OpenClaw paths
or smoke credentials. The guard still rejects unfinished package lifecycle.

## Offline test-value record

| Contract / primary owner | Credible regression and evidence | Overlap / seam disposition |
| --- | --- | --- |
| Suite dispatch: offline dispatcher callbacks and invalid-selector entrypoint subprocess | Reintroducing unconditional general lifecycle aborts bindings; invalid values must reject without invoking callbacks. Fault-injected copies fail both tests; repaired tests pass. | Dispatcher is used by the real entrypoint, not a test-only seam. Default ordering and failure propagation retained. |
| Cleanup ownership/absence: offline cleanup collaborator faults | Closing preexisting targets, stopping after one failure, accepting stale owners, or accepting unreadable stores violates cleanup. Removing absence inspection fails the test; repaired test passes. | Controlled collaborators prove cleanup handling, not actual ACP close behavior. Existing SQLite readers separately prove read-only persistence lookup. Live runner supplies those readers and real close receipts. |
| Staging order/isolation: staging CLI subprocess with executable fake pnpm and pending host guards | Candidate helper without priming fails at the real lifecycle guard; repaired helper clears the controlled guard before staging and installs ACP only after candidate exists. The executable rejects inherited credentials/production paths. | Fake CLI proves orchestration, not real OpenClaw lifecycle or real acpx installation. Existing guard and staged-artifact tests retain distinct filesystem safety risks. All new exports have non-test harness callers. |
| Topic move readback: controlled Zulip replies | A successful PATCH whose subsequent GET still has the old topic must fail; changed-topic GET passes. | Tests handling of server evidence, not real realm permissions or Zulip behavior. Actual transport/rename awaits the protected live run. |
| Binding routing and lifecycle: existing focused source tests | Conversation canonicalization, real generic-service persistence/expiry, ownership denial and synchronized routing remain protected. | Unchanged production tests are retained; no production source, package, lockfile, core, or config changes. |

Verification on Node 26.9.0 uses independently copied existing dependencies, not
a fresh install. The offline harness, focused binding/identity tests, typecheck,
and whitespace check are required receipts. Fault-injection copies are temporary
and are not committed. No full production suite or Node 24 claim is made.

Implementation receipts (2026-09-30, pnpm 10.23.0): offline harness 86 passed,
0 failed, 0 skipped; binding/identity Vitest 42 passed; monitor/channel Vitest
183 passed; `tsc --noEmit` and `git diff --check` passed. Four independent
fault-injected contract tests failed for the intended regressions and all four
passed repaired. A separate removed-preexisting-owner-guard mutation also failed
because it attempted to close the preexisting target. Independent parent review
is still required; these are implementation receipts, not review approval.

## Merge reconciliation receipts (2026-10-01)

Constraints: preserve the exact trusted main workflow, candidate binding
assertions, credential isolation, and lifecycle-before-staging ordering. No
production source, package, lock, config, or credential changes are permitted.

The overlapping main and candidate helper-success tests are consolidated into the existing
candidate staging subprocess owner. Wrong-host rejection and no installation
after protected config are retained in the ACP failure/security owner. HOME
preservation and all credential exclusions are consolidated into the existing
environment-isolation owner. Lifecycle error sanitization and filesystem guards
remain distinct failure/security proofs, not duplicate orchestration coverage.

| Additional relied-upon owner | Contract / credible regression | Disposition and evidence |
| --- | --- | --- |
| Executed workflow suite shell | Only exact full/bindings choices emit output; shell injection or a permissive selector must fail. | Retained distinct dispatch-input boundary; seven accepted/rejected fixtures pass, no injected file exists. |
| Executed workflow candidate probe | Legacy success or unrelated configuration failure cannot authorize bindings; full remains compatible without probing. | Retained distinct candidate-compatibility boundary; controlled legacy/incompatible runners reject, strict runner accepts; actual candidate probe passes without credentials. |
| Executed receipt shell | Binding selection must explicitly say it is not full acceptance. | Retained distinct public evidence boundary; full/bindings receipts pass. |
| ACP failure/security helper | Wrong host never installs; installer errors/version mismatch fail sanitized and remove bootstrap; protected config prevents installation. | Controlled failures reject and success staging subprocess passes. Helpers have real staging-CLI callers; no production seam added/removed. |
| Existing monitor/channel and binding source tests | Persistence/expiry, canonical identity, concurrent routing, channel policy and monitor lifecycle remain intact. | Unchanged owners retained for distinct production risks; no production changes in this merge. |

Node 26.9.0 verification: offline 89 passed, binding/identity 42 passed,
monitor/channel (including channel-message) 202 passed; `tsc --noEmit`, all smoke
module syntax checks, authorization shell syntax, and staged/unstaged whitespace
checks passed. Existing dependencies were temporarily symlinked, with no install
or network activity. The standalone invalid-selector entrypoint rejected before
configuration; the actual workflow binding probe exited zero without credentials.
Workflow content is byte-identical to main b82c13c4. Existing candidate staging
and strengthened binding assertions are unchanged. No new product bug fix is
claimed: controlled failure/pass fixtures establish the reconciliation contracts;
historical mutation receipts above are not rerun claims. No real OpenClaw lifecycle,
acpx installer, protected Linux/Node 24, or live realm behavior is proved offline.
Independent Rex review of the frozen merge remains required.

## Remaining owner-controlled prerequisites

Protected runner config must explicitly enable ACP, backend acpx, dispatch,
codex admission, and loaded acpx 2026.9.6; preserve valid baseline model/provider
policy. Codex executable/auth and noninteractive turns must work. The dedicated
actor must be distinct from the bot and authorized for session/ACP commands and
topic moves. Use only an isolated Gateway/state and a proven-free port; local
default port 18789 is not authorized here. The parent/operator owns workflow
selection, protected config/auth, environment approval, and dispatch.

No live Gateway, Zulip request, ACP session, secrets access, push, dispatch, or
merge was performed during implementation. Owner-unavailable fail-closed remains
offline coverage, not a dedicated live fault scenario. Live max-age expiry and
topic movement are implemented assertions, not acceptance evidence until run.
