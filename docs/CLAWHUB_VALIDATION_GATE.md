# ClawHub validation gate (2026.10.13 candidate)

Publication remains blocked: validation exit 0 is not a findings-free result.
ClawHub 0.23.3 with bundled plugin-inspector, targeting npm OpenClaw 2026.10.3,
reports one open P2 issue on the final packed derivative:

- Code: channel-env-vars; id: CRABPOT-45AD4542; owner: core.
- Decision: core-compat-adapter; class: deprecation-warning.
- Evidence: zulip; compatibility status: deprecated; runtimeCoverage: null.
- Remediation: mirror current setup/config metadata while retaining the old
  field until supported hosts no longer need it.

The candidate adds package openclaw.channel.configuredState.env: both
ZULIP_API_KEY and ZULIP_EMAIL are required, plus any one of ZULIP_URL,
ZULIP_SITE, or ZULIP_REALM. The manifest gains name Zulip. Credentials,
runtime code, doctor behavior, legacy channelEnvVars and the host floor stay
unchanged. The manifest sync script only owns selected config schemas, not
identity or package metadata; its check passes without a generator change.
The frozen-release derivative recipe now mirrors both new metadata contracts.

## Validator contradiction

Installed plugin-inspector src/fixture-summary.js lines 531–547 emits the
channel-env-vars warning whenever channelEnvVars has any keys. It never checks
the replacement package configured-state metadata. Adding that metadata cannot
clear this warning while retaining the field, contrary to the remediation at
https://docs.openclaw.ai/clawhub/plugin-validation-fixes#channel-env-vars.
Do not delete compatibility metadata, suppress findings, or raise the host
floor merely to satisfy this scanner. An upstream disposition is required.

The originally reported manifest-unknown-fields finding is not reproduced by
this exact CLI/target. Both baseline and candidate reports have manifestFields
empty. The target's PluginManifestRecord is an intersection with an Omit-based
static type; inspector openclaw-target.js parses object-type fields, and
fixture-summary.js lines 987–990 skips coverage when the field list is empty.
Its absence is a coverage gap, not proof of resolution. Only
manifest-name-missing is demonstrably resolved among the three requested codes.
The baseline additionally reported package-plugin-api-compat-missing, cleared
by the incorporated PR 118 compatibility metadata.

## Provenance and verification

Original npm SHA-256:
aec3da32e020864640cb30bf1a8fa7dcb4922ac4e8a91657b27b3db38e59864b.
Final scoped derivative SHA-256:
3994a09c55743f836851189f22b685a40ffb8f62049037bd84ca25daa0e7877a.
Two recipe runs match. All 210 file paths and modes match the input; only
package.json and openclaw.plugin.json payloads differ. All runtime JS, maps
and declarations remain byte-identical. The manifest semantic delta is name
only; package delta is scope, compat/build metadata and configured-state env.
The source's previously approved minGatewayVersion/pluginSdkVersion fields are
not added to the frozen derivative; its original bounded recipe remains intact.

Actual CLI validation used a fresh extraction of this exact archive:

    clawhub package validate <extracted-package> --openclaw-version 2026.10.3 --json

Result: pass, breakageCount 0, warningCount 1, issueCount 1, open issue above.
Machine-readable receipts and archive audit live under
/Volumes/WorkingSpace/openclaw/tmp/zulip-manifest-validation/:
clean-final.json, baseline.json, artifact-audit.json, packed-hosts-final.log,
hosts-negative.log, full-tests.log, accounts.log.

## Test-value gate

- Env-only configured status: primary owner is the real host
  hasChannelPackageState boundary in the existing approval-host smoke.
  All three URL aliases complete setup; blank/missing credentials or URL do
  not. Removing only configuredState makes all four host cases fail at the
  expected ZULIP_URL setup assertion; restoring it passes. No mocks or new
  production/test-only seams. Private host function discovery is the existing
  external harness convention, not a new plugin export.
- Runtime credentials: unchanged accounts.test.ts independently proves
  configured/plain/SecretRef credentials, default-only env fallback, named
  account isolation and explicit invalid SecretRef rejection (6 passing).
  Retained as distinct from host pre-runtime configured status.
- Packaging/display metadata: actual CLI baseline/final reports prove missing
  display name red/pass; complete archive comparison proves bounded changes,
  runtime byte preservation and source manifest/channel metadata agreement.
  Two recipe runs match; exclusive output rejects overwrite. No duplicate
  inventory-copying unit test added.
- Old-host doctor/approval/heartbeat behavior: existing real-host smoke passes
  on 2026.9.3, 2026.9.6, 2026.10.1-beta.1 and beta.2, including against the exact
  packed frozen runtime. Source inspection shows 9.3 already consumes package
  configuredState.env for env discovery; it does not establish that all old
  host paths can discard legacy metadata. Retain it as explicitly requested.
- Broader gates: build (TypeScript, manifest check, SDK exports), full suite
  (32 Vitest files / 900 tests plus 14 Node tests), diff hygiene pass.
  Reused installed dependencies; no clean-install reproducibility claim.

No release, publication, version bump, installation or Gateway change occurred.
PR 118 commits were incorporated on a separate branch off latest main without
editing its worktree; PR 117 and the separate skill remain untouched.
