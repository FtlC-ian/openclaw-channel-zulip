# Doctor and allowlist adapters

## SDK and state contract

The adapters are typed through `ChannelPlugin["doctor"]` and
`ChannelPlugin["allowlist"]` from the existing exported
`openclaw/plugin-sdk/core` import, using the pinned OpenClaw 2026.9.6 SDK.
No new runtime SDK subpath is required. The exports checker audits all 34 source/built subpaths (including type-only
imports, with 27 emitted runtime subpaths), and `test:hosts` imports the built index/setup entry and
exercises both adapters on actual npm hosts 2026.9.3, 2026.9.6,
2026.10.1-beta.1 and 2026.10.1-beta.2.

Reference adapters were read via `gh api`, not vendored:

- [Telegram allowlist, v2026.9.6](https://github.com/openclaw/openclaw/blob/v2026.9.6/extensions/telegram/src/channel.ts)
  uses account-scoped config edits and reports group overrides separately.
- [Telegram doctor, v2026.9.6](https://github.com/openclaw/openclaw/blob/v2026.9.6/extensions/telegram/src/doctor.ts)
  returns preview warnings and `{config, changes}` repairs.
- [Telegram doctor, beta.2](https://github.com/openclaw/openclaw/blob/v2026.10.1-beta.2/extensions/telegram/src/doctor.ts)
  uses the same preview/repair boundary.
- [Discord allowlist, beta.2](https://github.com/openclaw/openclaw/blob/v2026.10.1-beta.2/extensions/discord/src/channel.ts)
  reports account-scoped sender lists and route overrides independently.

`openclaw.plugin.json` deliberately retains
`doctorContract: { stateMigrations: [] }`: config-only preview/repair is not a
state migration. Neither adapter performs network requests, persists state,
resolves runtime credentials, starts monitors, or writes config files. Core
owns authorization, persistence and committed reload. Sender/policy and
stream-override changes use the existing root/account `reload.noopPrefixes`;
legacy `streams` remains a core restart setting.

## Warnings and safe repair

Each warning names its root/account path and provides a manual fix hint:

- Open DM policy accepts anyone; select pairing or explicit trusted emails.
- Empty group sender list under allowlist policy either blocks messages or
  falls back to DM `allowFrom`. The hint recommends explicit group senders or
  disabled group handling, never opening access.
- Omitted, empty or wildcard `streams` monitors all public streams, not DM-only.
- Enabled stream overrides can expand a finite legacy stream selection.
- Configured reaction approvals without explicit normalized approver identities
  cannot approve via reactions. Wildcard and pairing-store entries do not count.

The SDK `shouldSkipDefaultEmptyGroupAllowlistWarning` hook suppresses core's
fallback group warning for Zulip only; the capability metadata remains truthful.
Core otherwise duplicates this warning and recommends opening group access.
The four-host matrix invokes the real `collectDoctorPreviewNotes` composition
and asserts one group warning with safe guidance, not just adapter output.

Disabled accounts are not previewed. Root and account inheritance are inspected
separately; a named default account cannot hide an unsafe root setting.

Repair removes **exact duplicate** entries from existing sender lists only.
It does not normalize identities: inbound sender matching and approval matching
have distinct public compatibility semantics (for example `user:@email`).
Exact deduplication preserves both boundaries, is idempotent, does not choose
users/policies/streams, and never edits credentials. Risk warnings remain manual.

## Allowlist edits

Use the channel's `/allowlist` chat command, not `openclaw approvals allowlist`
(which edits executable approvals, not channel access). Specify `--config` so
pairing-store operations are not mixed with config edits.

- `dm` email entries edit `allowFrom`.
- `group` email entries edit `groupAllowFrom`, using the runtime's DM fallback
  when the effective group list is empty.
- `group stream:<name-or-decimal-ID>` (or `#<selector>`) edits only that selector's
  `streamOverrides.enabled`. Names are trimmed/case-normalized; ASCII decimal
  IDs lose leading zeroes, exactly as inbound policy does. Other rule fields and
  selectors are retained, including inherited rules when an account receives a
  new override map. `stream:*` is rejected: it is not a selector for every stream.

Stream removal sets `enabled=false`, rather than deleting a final legacy
`streams` entry (which would broaden access to all public streams). Read output
shows the legacy stream selection and each explicit stream override separately.
Adding a stream override can enable a stream outside `streams`; it does not
change group sender or mention/topic policy. A name removal does not override a
more-specific ID rule: inspect and remove that ID selector too if applicable.

Removing the last effective group sender also sets `groupPolicy="disabled"`,
preventing the empty list from reopening access via DM fallback. Removing `*`
from open DM policy changes it to `allowlist`, preserving schema validity and
narrowing access. These fail-closed policy changes are intentional; later adds
never automatically reopen disabled group access. No-op and invalid edits leave
the parsed config unchanged, including nonexistent account sections.

An omitted account selector addresses root config; explicit account selectors
address the selected account (explicit `default` uses root only if there is no
account map). Other accounts, credentials and unrelated config are preserved.

## OG live check (operator-owned, after installation)

Read-only shell command:

```sh
openclaw doctor
```

In an authorized Zulip chat (replace `default` with the intended named account):

```text
/allowlist list all --channel zulip --account default --config
/allowlist add dm test-owner@example.com --channel zulip --account default --config
/allowlist remove dm test-owner@example.com --channel zulip --account default --config
/allowlist add group test-sender@example.com --channel zulip --account default --config
/allowlist remove group test-sender@example.com --channel zulip --account default --config
/allowlist add group stream:bot-testing --channel zulip --account default --config
/allowlist remove group stream:bot-testing --channel zulip --account default --config
/allowlist list all --channel zulip --account default --config
```

Perform edits only on a disposable test account/stream. Group removal may disable
that test account's group handling; stream removal installs an explicit deny,
not restoration of the previous inherited policy. Capture the doctor output and
before/after config, then restore the exact original test fields explicitly.
`openclaw doctor --fix` invokes safe deduplication, but is not required for the
read-only live preview. This implementation task did not run live checks.

## Test-value review ledger

The named `test-value-audit` skill is not available in this worker's skill
catalog. This ledger records the manual gate for independent review.

| Logical contract / credible regression | Primary owner and overlap disposition |
| --- | --- |
| Preview of open DM, empty group sender/fallback, every all-stream spelling, expanding overrides, missing explicit approvers, inheritance/disablement | Focused adapter preview cases own distinct omitted/empty/wildcard semantics; real core `collectDoctorPreviewNotes` in the four-host matrix owns integrated warning composition and prevents duplicated/broadening generic group guidance. Existing security warning tests cover a separate security adapter, not doctor composition. |
| Repair no broadening across inbound and approval auth, immutable credentials/input, schema validity, idempotency | Public plugin repair boundary plus real auth helpers. Exact duplicates are the only automatic mutation; `user:@email` negative-normalization example preserves distinct approval identity. |
| Sender read/edit round trips, normalization, root/named-account isolation, preserved unrelated config, no phantom/no-op sections | Public plugin allowlist boundary and real runtime schema. Tests invoke production adapter methods, not a test-only edit helper seam. |
| Empty group fallback and open DM wildcard removal must narrow rather than broaden or invalidate schema | Public editor plus real SDK fallback and runtime schema; distinct policies require separate regressions. |
| Stream name/decimal selector edits preserve rule metadata and use explicit deny instead of empty-list broadening | Public editor to real inbound stream-policy boundary; name and decimal-ID tests prove different selector namespaces, plus idempotency and account isolation. |
| Erased type-only SDK imports must remain exported; a missing source-only contract would escape an emitted-JS-only audit | Real exports-checker CLI; existing import/re-export/dynamic negative controls are retained and the new source-only negative control fails the old checker. |
| Built artifact imports and active doctor/read/edit/repair behavior on four hosts | Actual npm host/built artifact boundary. Complements focused policy tests by proving host load, SDK exports, and production registration; existing reaction delivery matrix remains intact. |

There are no test-only production seams. Shared normalization is called by
monitor, pairing, config editing and doctor inspection; both adapters are
registered on the public plugin. Tests don't claim live Gateway authorization,
persistence/reload, CLI formatting or reaction settlement from config-only calls.
The integrated-doctor regression fails all four hosts on 2230d4d (two group
warnings including core's `groupPolicy="open"` recommendation), then passes with
the SDK suppression hook. Root, named-account, DM-fallback and disabled scopes
run through real core composition. Host child processes isolate HOME, state and
config paths in scratch directories; no operator state is used. Full verification
and exact-SHA independent review receipts accompany delivery.
