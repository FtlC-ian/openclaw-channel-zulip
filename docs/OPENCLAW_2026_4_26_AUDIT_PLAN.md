# OpenClaw 2026.4.26 Compatibility and Refactor Plan

## Context

OpenClaw 2026.4.26 includes substantial plugin, channel, runtime, config, install, and doctor changes. The Zulip plugin currently targets OpenClaw 2026.4.14 and already works through the channel plugin SDK, but the release points toward a cleaner plugin-runtime boundary and stronger manifest/config/secret handling.

This plan tracks what we should update before publishing the next Zulip plugin release.

## Recommendation

Split the work into two phases.

1. Update OpenClaw first in the local/runtime environment, with backup and smoke tests.
2. Build the Zulip plugin refactors against the updated SDK/runtime after the host is stable.

Do not combine the OpenClaw runtime upgrade and Zulip plugin refactor into one unreviewable change. If something breaks, we need to know whether it came from core OpenClaw or from our plugin changes.

## Phase 0: Baseline Before Upgrade

Before changing anything:

- Record current OpenClaw version and git SHA.
- Back up `~/.openclaw/openclaw.json`, agent configs, plugin installs, and extensions.
- Record current Zulip plugin repo SHA and dirty status.
- Run Zulip plugin gates:
  - `npm run build`
  - `npm test`
- Verify live basics:
  - Zulip inbound reply in stream topic
  - Zulip DM reply if configured
  - `message` tool send to Zulip stream and user target
  - subagent completion announcement into Zulip
  - approval flow if an approval prompt is easy to trigger

## Phase 1: Update OpenClaw Runtime

Update OpenClaw to 2026.4.26 or newer only after the baseline is captured.

Post-upgrade verification:

- `openclaw gateway status`
- `openclaw plugins list` / plugin status equivalent
- Zulip channel starts cleanly with no duplicate/missing plugin warnings
- Discord still starts cleanly
- Brave web search works
- lossless-claw recall tools work
- `sessions_spawn` works for a small subagent task
- cron/reminder delivery still resolves Zulip targets correctly
- Zulip stream/topic session binding remains correct
- `message` tool target parsing still accepts `stream:...` and `user:...`

If the upgraded host is stable, proceed to Phase 2.

## Phase 2: Zulip Plugin Compatibility Refactor

### 1. Bump SDK and host compatibility

Update package metadata:

- `devDependencies.openclaw` from `^2026.4.14` to `^2026.4.26` or the active host version.
- `openclaw.install.minHostVersion` from `>=2026.4.14` to the verified minimum host version.
- Changelog entry for the compatibility release.

Run TypeScript and tests immediately after the bump. Treat type failures as useful migration guidance.

### 2. Replace hand-rolled runtime singleton

Current code stores runtime manually in `src/runtime.ts` using a module-level variable. Refactor to the SDK runtime-store helper used by newer plugins, if available in the updated SDK.

Goal:

- Avoid singleton edge cases when plugin modules are loaded from different paths or staged roots.
- Match newer plugin-runtime patterns.
- Keep tests easy to mock.

Acceptance criteria:

- `getZulipRuntime()` still throws a clear error before initialization.
- Existing send/monitor tests pass.
- No behavior change in live channel startup.

### 3. Add SecretRef support for Zulip credentials

Current config treats `apiKey` as a plain string. Add support for OpenClaw SecretRef-backed credentials, at least for `apiKey`.

Likely tasks:

- Update TypeScript config types.
- Update JSON schema and UI hints.
- Resolve `apiKey` through the active runtime/config secret resolver if the SDK exposes one.
- Preserve environment-variable fallback for the default account.
- Add tests for plain string, env, and SecretRef-shaped config.

Acceptance criteria:

- Existing plain-string configs still work.
- `ZULIP_API_KEY` fallback still works for the default account.
- SecretRef config resolves at runtime without leaking the secret in status output.
- Status continues to report source as config/env/none without exposing secret values.

### 4. Audit config access against runtime-snapshot direction

Release notes deprecate direct plugin config load/write helpers in favor of passed runtime snapshots and transactional mutation helpers.

Current real reads:

- ✅ `src/zulip/send.ts` now requires resolved runtime config via `ZulipSendOpts.cfg` instead of calling `core.config.loadConfig()`.
- ✅ `src/zulip/monitor.ts` now requires `opts.config` and fails fast if a monitor starts without resolved runtime config.

Plan:

- Prefer config already passed by the runtime path.
- Keep live config reads only at narrow gateway boundaries where the SDK expects it.
- Do not introduce plugin config writes unless they use the new transactional helpers.

Acceptance criteria:

- No new direct config writes.
- Existing direct reads are either removed or justified with comments/tests.
- Tests cover send behavior when config is supplied via runtime mocks.

### 5. Improve manifest/schema polish

Review `openclaw.plugin.json` against 2026.4.26 expectations.

Potential improvements:

- Ensure `channelConfigs.zulip.schema` and TypeScript/Zod schema stay aligned.
- Add richer `uiHints` where Control UI can benefit.
- Keep sensitive fields marked sensitive.
- Consider whether `configSchema.properties` should remain empty or advertise plugin-level config explicitly.

Acceptance criteria:

- Plugin install/status does not warn about manifest schema.
- Control UI config panel presents Zulip fields clearly.
- Generated/published package includes only intended files.

## Phase 3: New Features Worth Building

These are not required for compatibility, but they fit the 2026.4.26 direction.

### A. Zulip doctor/config diagnostics

Add or expose checks for:

- Missing `url`, `email`, or `apiKey`.
- Bot cannot authenticate.
- Bot is not subscribed to configured streams.
- `groupPolicy="open"` without intended exposure warning.
- `dmPolicy="open"` without explicit `allowFrom: ["*"]`.
- Invalid stream/topic target formats.

### B. Better Zulip command surface

Explore cleaner support for Zulip-native or OpenClaw command flows:

- Status/config checks.
- `/new`, `/reset`, `/model`, `/think` equivalents where safe.
- Approval replies that feel native in Zulip.

### C. Richer Control UI / setup support

Improve setup and account UX:

- Better account labels.
- Better validation messages.
- Safer migration from top-level config to `accounts.default` if/when desired.
- Clearer docs for streams/topics/session binding.

## Risks and Things to Watch

- SecretRef support may require SDK APIs that are newer than the currently installed package.
- Runtime-store refactor may expose tests that mock the runtime too narrowly.
- The plugin currently loads `~/.openclaw/secrets/zulip.env` manually. Keep this for backward compatibility unless OpenClaw gives us a better first-class path.
- Do not change live target normalization casually. Zulip stream/topic routing and session keys are easy to regress.
- Do not publish the compatibility release until it has been tested against the upgraded live Gateway.

## Current Baseline From Initial Audit

As of the initial audit:

- Zulip plugin build passed.
- Zulip plugin tests passed: 46 tests across 4 files.
- The plugin already uses the channel plugin SDK and most important channel hooks.
- No immediate 2026.4.26 breakage was found.
- Main refactor opportunities are SDK version bump, runtime-store alignment, SecretRef support, and config-access cleanup.
