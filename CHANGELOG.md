# Changelog

## Unreleased

### Features
- **Per-stream inbound policy**: Add deterministic name/ID `streamOverrides` for inbound activation, mention requirements, and allowed/excluded topics while preserving legacy `streams`, `topics`, and `streamTopics` behavior.
- **Early inbound filtering**: Resolve stream policy before durable acceptance, attachment downloads, reactions, typing, routing, or agent dispatch. Outbound access remains independent.

### Compatibility
- **OpenClaw 2026.8.1 compatibility**: Use the shared ingress queue and typed media-runtime SDK surfaces while retaining OpenClaw 2026.7.1-2 as the minimum supported host, draining legacy durable records, and keeping command access-group checks enabled.

## 2026.5.26

### Features
- **Truthful lifecycle reactions**: Replace coarse start/success/error hooks with SDK-backed queued, thinking, tool-category, compaction, stall, done, and error states, plus exact-run subagent activity tracking that safely handles concurrent children and overlapping requester turns.
- **Outbound route hook**: Add native Zulip outbound session routing for DMs and stream topics, preserving raw Zulip topics over sanitized session ids.
- **Durable inbound receive journal**: Add optional keyed-state journaling with bounded pending/completed stores and replay-before-poll behavior when trusted plugin state is available.
- **Message reactions**: Add `message(action="react")` support for Zulip add/remove reactions, dry-run handling, current-message defaults, idempotent add/remove behavior, and common emoji normalization.
- **Agent reaction guidance**: Advertise model-controlled Zulip reactions through prompt guidance, defaulting to extensive while keeping lifecycle/status indicators separate.

### Bug Fixes
- **Gateway restart cleanup**: Await active monitor lifecycle cancellation from the gateway-stop hook so interrupted turns do not leave orphaned status reactions on Zulip messages.
- **Lifecycle reaction metadata**: Send every built-in lifecycle and subagent default with Zulip's canonical Unicode emoji name, code, and reaction type so realms accept tool, soft-stall, and child-run indicators.
- **Reply routing**: Store canonical last-route delivery context for Zulip DMs and stream topics so final replies and follow-ups stay on the right conversation.
- **Replay dedupe**: Durable replay bypasses volatile in-memory duplicate suppression after handler failures.

### Compatibility
- **OpenClaw 2026.5.26 compatibility**: Target the current stable OpenClaw plugin/channel SDK surface and keep the minimum host version at `>=2026.5.26`.

## 2026.5.22

### Features
- **OpenClaw channel message adapter**: Expose the 2026.5.22 durable message adapter and route shared `message(action="send")` calls through core delivery instead of the legacy action-only path.
- **Poll delivery**: Send generic OpenClaw polls as Zulip zform widgets.

### Bug Fixes
- **Threaded sends**: Preserve `threadId` as the Zulip topic for durable text, media, and payload sends.
- **Multipart media receipts**: Return all platform message ids for multi-media payloads so durable receipts, hooks, and recovery can track every delivered Zulip message.
- **Host media access**: Forward host-provided media access/read capabilities for durable local media sends.

### Compatibility
- **OpenClaw 2026.5.22 compatibility**: Raise the OpenClaw development dependency and plugin host metadata to `2026.5.22` for the new channel-message SDK subpath.

## 2026.5.18

### Bug Fixes
- **Zulip polling compression**: Request identity encoding for Zulip API calls so event responses are not handed back still gzipped by runtime fetch behavior.

### Compatibility
- **OpenClaw 2026.5.12 compatibility**: Raise the OpenClaw development dependency and plugin host metadata to `2026.5.12`, and import newer SDK helpers directly from their plugin-sdk modules.

## 2026.5.7

### Bug Fixes
- **Zulip stream reply troubleshooting**: Document the common configuration causes for DMs working while stream replies are intentionally ignored, including `groupPolicy`, allowlists, mention requirements, and topic filters.
- **Outbound observability**: Add retry and failure logging for Zulip API requests, including thrown network/fetch exceptions, while keeping normal per-message send logs at debug level to avoid noisy production logs.
- **Retry resilience**: Retry transient thrown fetch/network errors in the Zulip API client, matching the existing retry behavior for retryable HTTP statuses.

### Maintenance
- **Release hygiene**: Add deterministic retry/logging tests, ignore local `.learnings/` notes, refresh the OpenClaw devDependency to the stable `^2026.5.6`, and update Zod to `^4.4.3`.

## 2026.4.29

### Features
- **Inbound topic filters**: Add `topics` and `streamTopics` config for filtering monitored Zulip stream messages by topic. Topic matching trims whitespace and is case-insensitive; omitted, empty, or `"*"` filters allow all topics. Per-stream filters can be keyed by stream name or stream id and further restrict the global topic allowlist.

### Compatibility
- **OpenClaw 2026.4.26 compatibility carry-forward**: Includes the 2026.4.26 runtime alignment, SecretRef API key support, and stream target parsing fixes from the prior compatibility PR.

## 2026.4.26

### Compatibility
- **OpenClaw 2026.4.26 compatibility**: Raise package and host metadata to target OpenClaw `2026.4.26`.
- **Runtime store alignment**: Replace the Zulip runtime module singleton with the SDK `createPluginRuntimeStore(...)` helper while preserving the existing initialization error.
- **SecretRef API keys**: Allow Zulip `apiKey` fields to use OpenClaw SecretInput/SecretRef objects while preserving plain-string config and default-account environment fallback.

## 2026.4.14

### Features
- **SDK-aligned plugin entrypoints**: Migrate to `defineChannelPluginEntry(...)` and `defineSetupPluginEntry(...)`, keeping the package aligned with current OpenClaw plugin loading and setup patterns.
- **Native session conversation binding**: Route stream-topic conversations through the SDK session-conversation hook, with bundled fallback support via `session-key-api.ts`.
- **Approval capability wiring**: Advertise Zulip approval support through `approvalCapability`, so current OpenClaw approval surfaces can discover and use the plugin correctly.
- **Widget send and target normalization improvements**: Tighten Zulip target normalization and outbound widget send behavior for current OpenClaw messaging flows.

### Bug Fixes
- **Duplicate session noise**: Stop enqueueing an extra synthetic system event for ordinary inbound Zulip messages, which was polluting session history and wasting tokens.
- **Regression coverage**: Add targeted monitor tests for ordinary inbound handling, duplicate message dedupe, and BAD_EVENT_QUEUE_ID queue re-registration.
- **Release metadata refresh**: Bump package metadata to match OpenClaw `2026.4.14` and publish the current main-branch fixes as a coherent npm release.

## 2026.4.9

### Bug Fixes
- **Duplicate session noise**: Stop enqueueing an extra synthetic system event for ordinary inbound Zulip messages, which was polluting session history and wasting tokens.
- **Regression coverage**: Add targeted monitor tests for ordinary inbound handling, duplicate message dedupe, and BAD_EVENT_QUEUE_ID queue re-registration.

## 2026.3.18

### Bug Fixes
- **Plugin packaging**: Fix npm package to include compiled JS (`dist/`). Previous versions shipped only TypeScript source due to `.gitignore` fallback, causing `TypeError: Cannot read properties of undefined (reading 'optional')` on load when the host's bundled Zod version didn't match.
- **Entry point**: Set `main` and `openclaw.extensions` to `./dist/index.js` so the plugin loader resolves compiled output.
- **Build pipeline**: Add `prepublishOnly` script and `files` allowlist to ensure `dist/` is always built and included in the tarball.

## 2026.3.17

### Bug Fixes
- **Topic parser**: Preserve topics containing colons and slashes in stream target parser (`stream:name/topic` patterns now route correctly)
- **Poll correctness**: Fix event polling with proper event ID guard and queue expiry handling
- **streamOverrides**: Remove broken streamOverrides feature that caused config issues
- **HEIC conversion**: Add file validation before HEIC-to-JPEG conversion

### Features
- **requireMention wire-up**: Account-level and per-stream requireMention now correctly resolved via SDK helper
- **Environment loader**: Load Zulip credentials from `~/.openclaw/secrets/zulip.env` at startup
- **Media cleanup**: TTL-based cleanup for inbound media temp directories

## 2026.2.1

### Features
- **HEIC/HEIF support**: Auto-convert inbound HEIC/HEIF media to JPEG
- **OpenClaw SDK patterns**: Adopt latest sendPayload, reaction fallback, and defaultAccount patterns
- **Plugin metadata**: Add uiHints to plugin.json

## 1.0.0

- Initial release: Zulip channel plugin for OpenClaw
