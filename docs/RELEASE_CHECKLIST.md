# Release checklist

Before publishing a release candidate:

- Confirm CI passed for the exact commit being released.
- From the `main` branch, dispatch **Zulip live smoke (protected)** with the
  candidate's full commit SHA. For a release, leave `candidate_ref` empty so the
  workflow requires the commit to be reachable from `main`.
- Record the successful run URL and tested SHA here and on GitHub issue #24:
  `Live smoke: <run URL>; tested SHA: <40-character SHA>`.
- Confirm the run summary reports every scenario as `PASS`. A skipped or
  unobservable scenario is not successful coverage.
- Confirm cleanup completed. Zulip messages are deleted where account
  permissions permit. Zulip does not expose a public API for deleting uploaded
  files, so the dedicated realm may retain the small uniquely named fixtures.
- The interactive-reply scenario sends the exact native poll choice reply over
  Zulip's public message API. Zulip exposes no public API for synthesizing a
  browser widget click, so the workflow reports this API-equivalent boundary
  rather than pretending to automate UI behavior.

The `zulip-live-smoke` GitHub Environment must require reviewer approval and
contain only dedicated test-realm credentials. Store the isolated OpenClaw
configuration in `OPENCLAW_SMOKE_CONFIG_JSON`; store the test actor and bot
credentials in the environment-scoped secrets named by the workflow. Set
`ZULIP_SMOKE_STREAM` as an environment variable. Never define these as
repository-level secrets.

When debugging a live-only failure, keep the fixes on one same-repository
feature branch and dispatch the workflow with both `candidate_sha` and
`candidate_ref`. Repeat on that branch until the smoke run passes, then open one
pull request. Do not merge each experimental fix to `main`: that creates noisy
review and failure notifications and leaves `main` holding known-bad candidates.
Only the repository owner can dispatch a branch candidate, the candidate must
be reachable from the named same-repository branch, and environment approval is
still required before credentials are released.

The workflow must stage the exact checked-out candidate through
`scripts/live-smoke/stage-bundled-plugin.mjs` and verify that OpenClaw reports
the Zulip plugin with `origin: bundled` and `status: loaded`; it must not install
the checkout as a local linked plugin. The isolated configuration must use
the dedicated bot account, allow DMs from the smoke actor, monitor the smoke
stream with an open group policy, and disable stream mention gating with
`chatmode: "onmessage"` and `requireMention: false` at the root and for every
account. It must enable typing and lifecycle reactions with
`clearOnFinish: true` and use the default `robot` subagent reaction required by
the committed evidence matcher. Lifecycle phase overrides must not use `robot`
or `tada`; those reactions are reserved for subagent and explicit reaction
evidence. The configuration must also provide a model/tool policy that permits
the message, file, and `sessions_spawn` operations described by the committed
smoke-agent workspace. A run that cannot observe one of those behaviors fails
rather than silently skipping it.

The harness verifies the exact child result in the isolated OpenClaw session
transcript and reads the edited Zulip message before and after its required
four-second visibility window. Durable replay uses a random generation value
written only after the old gateway process group is fully down; the replacement
must read and return that value, so a queued pre-restart reply cannot pass.
The protected workflow enables the durable scenario unconditionally. Its
summary records the exact candidate SHA, plugin version, OpenClaw version, and
run URL; the console report must show
`PASS durable-receive-completion-deduplication` rather than `SKIP`.
