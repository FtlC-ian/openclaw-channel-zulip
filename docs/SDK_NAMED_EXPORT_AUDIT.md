# SDK named-export compatibility audit

Runtime imports and re-exports in `src`, root entries, and compiled `dist` were parsed with TypeScript and checked by loading the actual host module. Aliases and destructured dynamic imports use their exported names. The guarded namespace factory in durable-bindings.ts has an explicit alternative-name contract: at least one of its two supported factory spellings must be a function. Namespace alternatives are declared, not inferred as mandatory individual names. Type-only imports require the public subpath but are not runtime namespace members.

| SDK specifier | Required runtime names | 9.3 | 9.6 | 10.3 | 10.5-beta.4 |
| --- | --- | --- | --- | --- | --- |
| openclaw/plugin-sdk/agent-scope-runtime | listAgentIds, resolveAgentConfig, tryResolveDefaultAgentId | OK | OK | OK | OK |
| openclaw/plugin-sdk/allow-from | mergeDmAllowFromSources, resolveGroupAllowFromSources | OK | OK | OK | OK |
| openclaw/plugin-sdk/approval-reaction-runtime | buildApprovalReactionDeliveredBindingMarker, createApprovalReactionTargetStore, listApprovalReactionBindings, readApprovalReactionDeliveredBinding, readApprovalReactionPresentationBinding, settleApprovalReaction | OK | OK | OK | OK |
| openclaw/plugin-sdk/approval-reply-runtime | getExecApprovalReplyMetadata | OK | OK | OK | OK |
| openclaw/plugin-sdk/channel-config-schema | buildJsonChannelConfigSchema | OK | OK | OK | OK |
| openclaw/plugin-sdk/channel-feedback | DEFAULT_TIMING, createStatusReactionController, logTypingFailure | OK | OK | OK | OK |
| openclaw/plugin-sdk/channel-inbound | formatInboundEnvelope, logInboundDrop | OK | OK | OK | OK |
| openclaw/plugin-sdk/channel-ingress-runtime | readChannelIngressStoreAllowFromForDmPolicy | OK | OK | OK | OK |
| openclaw/plugin-sdk/channel-outbound | createChannelMessageAdapterFromOutbound, createChannelProgressDraftCompositor, createDurableInboundReceiveJournalFromQueue, createTypingCallbacks, resolveChannelPreviewStreamMode, resolveChannelStreamingPreviewCommandText, resolveChannelStreamingProgressNarration, verifyChannelMessageAdapterCapabilityProofs | OK | OK | OK | OK |
| openclaw/plugin-sdk/channel-pairing | createChannelPairingController | OK | OK | OK | OK |
| openclaw/plugin-sdk/channel-secret-basic-runtime | collectSimpleChannelFieldAssignments, getChannelSurface | OK | OK | OK | OK |
| openclaw/plugin-sdk/command-auth-native | resolveControlCommandGate | OK | OK | OK | OK |
| openclaw/plugin-sdk/core | DEFAULT_ACCOUNT_ID, applyAccountNameToChannelSection, buildChannelOutboundSessionRoute, defineChannelPluginEntry, defineSetupPluginEntry, deleteAccountFromConfigSection, emptyPluginConfigSchema, formatPairingApproveHint, jsonResult, migrateBaseNameToDefaultAccount, normalizeAccountId, setAccountEnabledInConfigSection | OK | OK | OK | OK |
| openclaw/plugin-sdk/directory-runtime | createChannelDirectoryAdapter | OK | OK | OK | OK |
| openclaw/plugin-sdk/gateway-runtime | createOperatorApprovalsGatewayClient, startGatewayClientWhenEventLoopReady | OK | OK | OK | OK |
| openclaw/plugin-sdk/interactive-runtime | normalizeMessagePresentation, resolveMessagePresentationActionValue | OK | OK | OK | OK |
| openclaw/plugin-sdk/lazy-runtime | createLazyRuntimeSurface | OK | OK | OK | OK |
| openclaw/plugin-sdk/model-ref-parse | parseModelRef | OK | OK | OK | OK |
| openclaw/plugin-sdk/outbound-media | loadOutboundMediaFromUrl | OK | OK | OK | OK |
| openclaw/plugin-sdk/param-readers | readNumberParam, readStringParam | OK | OK | OK | OK |
| openclaw/plugin-sdk/plugin-state-store-runtime | createPluginStateKeyedStore OR createPluginStateSyncKeyedStore (function) | OK | OK | OK | OK |
| openclaw/plugin-sdk/question-gateway-runtime | questionGatewayRuntime | OK | OK | OK | OK |
| openclaw/plugin-sdk/routing | buildAgentSessionKey, resolveAgentRoute | OK | OK | OK | OK |
| openclaw/plugin-sdk/runtime-store | createPluginRuntimeStore | OK | OK | OK | OK |
| openclaw/plugin-sdk/secret-input | buildOptionalSecretInputSchema | OK | OK | OK | OK |
| openclaw/plugin-sdk/secret-input-runtime | coerceSecretRef, normalizeSecretInputString, resolveConfiguredSecretInputString, resolveSecretInputString | OK | OK | OK | OK |
| openclaw/plugin-sdk/ssrf-runtime | fetchWithSsrFGuard | OK | OK | OK | OK |
| openclaw/plugin-sdk/temp-path | resolvePreferredOpenClawTmpDir | OK | OK | OK | OK |
| openclaw/plugin-sdk/web-media | (type-only WebMediaResult) | OK | OK | OK | OK |

For #136, `outbound-media` exports `loadOutboundMediaFromUrl` on 2026.9.3, 2026.9.6, 2026.10.9 and 2026.10.10-beta.5, but does not export `buildOutboundMediaLoadOptions` on any of them. The loader calls the same internal implementation used by `media-runtime`: 9.3/9.6 forward all ten supported option fields, while 10.9/beta.5 pass the options directly. The plugin now re-exports that loader instead of maintaining its own wrapper. Supported hosts lack declarations for this runtime subpath; `src/sdk-outbound-media.d.ts` supplies the narrow consumed contract, retaining the public `WebMediaResult` type. The export checker discovers specifiers automatically; no specifier list or checker-test change is needed.

The #136 build audits 36 source/built specifiers. `src/sdk.test.ts` owns the real focused-loader contract: allowed local roots produce the expected bytes/name, and the byte limit rejects an oversized file. Existing `send.test.ts` media cases own upload authorization, Zulip-hosted URL handling and the runtime remote-buffer fallback; they import the SDK but do not invoke this loader branch. No SDK mocks needed updating. The new direct test closes that execution gap without adding a production seam; `send.ts` remains the production caller. The source grep and actual host named-export checks own the deprecated-import regression, while this test independently guards loader behavior. The required test-value-audit skill is still unavailable; this record applies TEAM_PROTOCOL directly.

Before #136, all 37 source/built subpaths passed. The only missing runtime name in base `6fe1bca1e37f04eeaa53598ef6ef462599de68bb` is `readApprovalReactionDeliveryMetadata` from `approval-reaction-runtime` on 10.5-beta.4. Running the enhanced checker against an archive compiled from that exact base fails (exit 1) with that name; the fixed tree passes (exit 0) on each host. Existing 10.1-beta.1/beta.2 smoke fixtures are also retained.

## Validation and test ownership

- Local metadata drift: `src/zulip/approval-metadata.test.ts` compares the production reader with the pinned 2026.9.6 SDK across malformed metadata, decisions, IDs, slugs and both option flags. Newer system-agent support is asserted separately because the pinned SDK predates it. No runtime SDK-reader selection remains. This module is called by production approval binding validation, not a test-only seam.
- Missing named exports: `scripts/check-sdk-exports.test.mjs` owns parser/loader regression detection (real fixture exports, renamed re-export, dynamic destructuring and absent names). Its namespace-factory regression accepts each factory independently and rejects removal of both or a non-function export; this owns the guarded durability compatibility branch without treating either spelling individually as mandatory. The namespace regression fails against checker revision 4fed78a (false success when both exports disappear) and passes against the corrected checker. The base-commit failure is the actual plugin regression control.
- Approval authorization/delivery: existing approval unit tests and six real-host built-plugin smokes retain state, presentation/marker validation, unauthorized-actor denial and terminal cleanup. These are distinct integration/security risks, not copies of the metadata drift test.
- The mandatory test-value-audit skill was searched and requested by exact name but is not installed; this contract/owner/regression record follows TEAM_PROTOCOL directly.

Host fixtures use npm-extracted packages without installation. New 10.5 fixture requires fs-safe 0.25.0 and its matching Darwin ARM64 binary (also tar-extracted locally); reusing installed 0.24.2 fails module linking and is not valid host evidence. Other host dependencies are reused, not a clean-install reproducibility claim.
