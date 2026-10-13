# ClawHub validation gate (2026.10.13 candidate)

The branch artifact passes ClawHub 0.23.3 with bundled plugin-inspector,
targeting npm OpenClaw 2026.10.3: status pass, breakageCount 0, warningCount 0,
deprecationWarningCount 0, issueCount 0; issues and decisions are empty.
This is validation evidence, not publication authorization.

## Metadata and compatibility

The manifest declares display name `Zulip` and no longer declares the unused
top-level `channelEnvVars`. Package `openclaw.channel.configuredState.env` is
the single source for setup discovery: allOf ZULIP_API_KEY and ZULIP_EMAIL;
anyOf ZULIP_URL, ZULIP_SITE and ZULIP_REALM. Credentials, runtime source,
doctor behavior and the >=2026.9.3 host floor are unchanged.

Debbie verified host source for 2026.9.3, 2026.9.6, 2026.10.1-beta.2,
2026.10.2 and 2026.10.3: resolveChannelEnvVars reads only
plugin.packageChannel.configuredState.env. Other channelEnvVars occurrences
are generated bundled-channel metadata, not external manifest reads. Thus no
supported host requires the legacy manifest field. This satisfies the removal
condition at https://docs.openclaw.ai/clawhub/plugin-validation-fixes#channel-env-vars.

The manifest sync script removes the legacy field in sync mode and rejects it
in check mode. The frozen npm derivative recipe also removes it; that recipe
still changes only package and manifest metadata, preserving runtime bytes.
The current branch pack is a source-built artifact, not the frozen derivative.

## Actual validator coverage

The packed branch was freshly extracted and checked using:

    clawhub package validate <extracted-package> --openclaw-version 2026.10.3 --json

No finding codes remain. The name, package compatibility metadata, and legacy
channel-env-vars checks ran and produced no issues. Logged checks are
seam-inventory (5 hooks, 1 registration, 0 manifest contracts),
api-registrars-present, sdk-exports-present (28 observed imports), and
package-metadata. No runtime contract probes ran.

**manifest-unknown-fields coverage is still skipped**: target manifestFields
is empty, so inspector fixture-summary.js skips field coverage. Removing the
legacy field addresses the originally reported unknown key, but this local
validator cannot independently prove the complete manifest allowlist. No
validator suppression, host-floor change or scanner workaround was used.

## Verification and test-value gate

- TypeScript, manifest --check and SDK export gate pass (35 source/built
  specifiers against OpenClaw 2026.9.6).
- Vitest: 32 files / 900 tests pass. Node migration/SDK checks: 14 pass.
- Existing real-host smoke: 4 pass on 2026.9.3, 2026.9.6,
  2026.10.1-beta.1 and beta.2, both source-built and exact packed runtime.
- Env-name discovery is owned by each real host getChannelEnvVars boundary:
  discovers the extracted package through plugins.load.paths and returns all
  five expected names with no legacy manifest field. Removing only package
  configuredState from an isolated artifact copy returns an empty list on
  all four hosts (red); the intact packed artifact passes (green). An initial
  symlinked negative fixture mixed SDK roots and was discarded; negative-copy.log
  is the usable isolated regression receipt.
- Env-only configured status is independently owned by real host
  hasChannelPackageState: all three URL aliases complete setup with both
  credentials; blank required fields and empty env do not. Existing coverage
  retained; discovery and configured-state semantics prove distinct risks.
- Runtime accounts tests remain distinct coverage for actual credential
  resolution/SecretRef/default-account isolation; no runtime seams changed.
- Sync removal/check rejection protects packaging against reintroducing the
  unused manifest field: injecting it makes --check fail; sync removes it and
  reproduces the original manifest byte-for-byte. No new production exports
  or test-only seams.
- Frozen derivative recipe: two independent archives match; actual validator
  also reports zero warnings/breakages/issues. SHA-256:
  56a579fcd2868148f0d11a4ada50681cbcb12b0dd80ea3a35802ff83ce9dd411.
- Diff hygiene passes. Reused installed dependencies; no clean-install claim.

Receipts: /Volumes/WorkingSpace/openclaw/workspaces/dex/zulip-119-receipts/
validator.json, hosts.log, packed-hosts.log, negative-copy.log, vitest.log, node.log
and the packed branch tarball. PR 118 commits are patch-equivalent in PR 119
(`git cherry HEAD origin/chore/clawhub-plugin-metadata` reports both as `-`);
its package metadata is retained, with configured-state metadata added.

No release, publication, version bump, installation or Gateway change occurred.
