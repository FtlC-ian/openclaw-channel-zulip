# Release checklist

Before publishing a release candidate:

- Confirm CI passed for the exact commit being released.
- From the `main` branch, dispatch **Zulip live smoke (protected)** with the
  candidate's full commit SHA. The workflow rejects commits not already
  reachable from `main` before the protected environment or its secrets are
  available.
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

The isolated configuration must enable the checked-out local Zulip plugin, use
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
