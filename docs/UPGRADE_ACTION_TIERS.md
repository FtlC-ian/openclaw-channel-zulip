# Upgrading to action-tier message capabilities

Applies to: upgrading from any release before the per-account
`channels.zulip.actionTiers` feature (2026.10.14 and earlier).

## What changed

The shared `message` tool is now gated per account by
`channels.zulip.actionTiers` with three tiers:

| Tier | Actions | New default |
| --- | --- | --- |
| `messages` | `send`, `read`, `search`, `react`, `channel-list`, `poll` (core-owned) | `"on"` |
| `moderation` | `edit`, `delete`, `unsend`, `member-info` | `"off"` |
| `streamAdmin` | `channel-create`, `channel-edit`, `channel-delete` | `"off"` |

Before this change every configured account could edit, delete, create,
edit and delete streams through the shared message tool, limited only by the
Zulip bot credential's own permissions. The safe defaults now expose only the
`messages` tier.

Gated-off actions are excluded from tool discovery (agents do not see them)
and rejected by the plugin handler before any Zulip network request. All
three tiers are honored: setting `actionTiers.messages: "off"` makes the
shared message tool fully inert for that account — nothing from any tier is
advertised or executed, because the messages tier is the precondition for
discovery and every tier action is checked against the resolved tier map.

## Who must act

`messages: "off"` blocks shared/core outbound text, media, payload and polls before credential resolution, including scheduled/core-routed sends. Normal inbound Zulip replies and lifecycle/progress messages retain their internal reply-delivery path. The supported SDK does not expose a trustworthy tool-origin discriminator to outbound adapters; this conservative scope prevents bypasses without blocking ordinary inbound replies.

- **No action** if your agents only send, read, search, react, list channels, or post polls — those keep working under the default `messages` tier.
- **Opt in explicitly** if your agents moderate their own or others' messages
  or administer streams:

```json
{
  "channels": {
    "zulip": {
      "actionTiers": {
        "moderation": "on",
        "streamAdmin": "on"
      }
    }
  }
}
```

Tiers merge per key: an account configuration overrides only the tiers it
states, so you can widen exactly one tier for one bot (`accounts.work.
actionTiers.streamAdmin: "on"`) without restating the others.

## Why edit/delete are moderation-gated

The adapter performs no message-ownership lookup, so granting message
`edit`/`delete`/`unsend` grants them against any message the bot credential
can touch, not only messages the bot sent. The single conservative tier
avoids a per-action ownership lookup over the network. Enable `moderation`
only for accounts whose Zulip bot credential you would trust to moderate.

## Tier membership notes

- `member-info` (raw user lookup by id) now lives in the `moderation` tier
  rather than being permanently absent: it is an unrestricted cross-user data
  lookup, so it defaults off and requires the same explicit opt-in as message
  edit/delete.
- `poll` remains core-owned (delivered by OpenClaw itself through
  `outbound.sendPoll`) and is advertised while the `messages` tier is on.

## Legacy flag

The legacy `enableAdminActions` flag remains accepted in configurations but
stays intentionally inert. It does not enable actions and does not interact
with `actionTiers`. Remove it at your leisure; it is documented in
`docs/ACTION_CAPABILITIES.md` for the eventual removal migration.

## Verification

After upgrading, run on the gateway host:

```sh
openclaw plugins reload zulip --wait
```

Then confirm from an agent turn that a gated action fails closed with the
tier hint, for example `message(action="edit", ...)` on a default account
must report that `channels.zulip.actionTiers.moderation: "on"` is required,
with no Zulip request issued. See `docs/ACTION_CAPABILITIES.md` for the full
matrix and coverage map.