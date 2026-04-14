# Changelog

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
