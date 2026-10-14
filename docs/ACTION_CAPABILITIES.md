# Zulip message action capabilities

This matrix is the checked-in contract for the shared OpenClaw `message` tool.
`src/actions.ts` owns the advertised list, action-scoped schema contributions,
and plugin-handler allowlist so those surfaces cannot silently diverge.

## Per-account action tiers

Every action below belongs to a per-account `actionTiers` tier. Tiers default
to safe values: `messages` is `"on"`; `moderation` and `streamAdmin` default
to `"off"`. Gated-off actions are excluded from tool discovery and rejected
by the handler before any Zulip network request. Unknown keys or values are
rejected by the config schema.

```json
{
  "actionTiers": {
    "messages": "on",
    "moderation": "off",
    "streamAdmin": "off"
  }
}
```

| Tier | Grants | Default |
| --- | --- | --- |
| `messages` | `send`, `read`, `search`, `react`, `channel-list`, `poll` (core-owned) | `"on"` |
| `moderation` | `edit`, `delete`, `unsend`, `member-info` | `"off"` |
| `streamAdmin` | `channel-create`, `channel-edit`, `channel-delete` | `"off"` |

All three tiers are honored together: turning `messages` off makes the whole
message tool inert for that account (nothing is advertised and every action
is rejected before any Zulip request), including actions from any other tier.
`poll` is OpenClaw core-owned (`outbound.sendPoll`); the plugin advertises it
with the `messages` tier but never handles it itself.

The message edit/delete/unsend trio is gated conservatively as moderation:
the adapter does not resolve message ownership over the network, so any edit
or delete may target another user's message. Enabling the tier grants both
self-mutation and elevated moderation — including `member-info`, the raw
Zulip member lookup by user id — under the configured bot credential.
Tiers merge per key, with account configuration overriding the top-level
section, so an account can widen or tighten one tier without restating the
others.

## Action matrix (all tiers enabled)

| Action | Owner | Tier | Target mode | Authorization | Confirmation | Dry run | Coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `send` | plugin | `messages` | `to` | configured account credential | no | yes | action and outbound tests |
| `read` | plugin | `messages` | `to` | configured account credential | no | host read-only | action tests |
| `channel-list` | plugin | `messages` | none | configured account credential | no | host read-only | action tests |
| `channel-create` | plugin | `streamAdmin` | none | Zulip credential permission | no | yes | action tests |
| `channel-edit` | plugin | `streamAdmin` | `channelId` | Zulip credential permission | no | yes | action tests |
| `channel-delete` | plugin | `streamAdmin` | `channelId` | Zulip credential permission | `confirm: true` | yes | action tests |
| `react` | plugin | `messages` | `to` | Zulip credential permission | no | yes | action tests |
| `edit` | plugin | `moderation` | `to` | Zulip credential permission | no | yes | action tests |
| `delete` | plugin | `moderation` | `to` | Zulip credential permission | `confirm: true` | yes | action tests |
| `unsend` | plugin alias for `delete` | `moderation` | `to` | Zulip credential permission | `confirm: true` | yes | action tests |
| `search` | plugin | `messages` | none | configured account credential | no | host read-only | action tests |
| `member-info` | plugin | `moderation` | none | Zulip credential permission | no | host read-only | action tests |
| `poll` | OpenClaw core via `outbound.sendPoll` | `messages` | `to` | configured account credential | no | host-owned | channel/outbound tests |

The adapter does not add a separate owner/trusted-requester gate to mutable
actions. Zulip applies the permissions of the selected bot credential. The
destructive actions additionally require the exact boolean `confirm: true`
before any Zulip request.

## Unsupported shared actions

OpenClaw's shared `pin` and `unpin` actions mean provider-visible shared
pinning. Zulip has no shared pin; its message flags, such as `starred`, are
per-user, so this plugin deliberately does not advertise or handle either
action. It also does not expose a misleading shared-action alias
for personal starring.

`member-info` (raw user lookup by id) is granted only by the `moderation`
tier: it is an unrestricted cross-user data lookup, so it stays off until the
same account explicitly opts in to moderation-capability actions.

## Core-owned actions

`poll` is deliberately core-owned: the plugin advertises it under the
`messages` tier, and OpenClaw core performs the delivery itself through
`outbound.sendPoll`. The plugin never handles `poll` in `handleAction`, so a
direct plugin dispatch rejects as unsupported before credential or network
access.

## Removed provider-specific actions

The former `channel-subscribe`, `invite`, `resolve-topic`, `user-presence`,
`user-deactivate`, `user-reactivate`, `org-settings`, and `org-settings-edit`
handlers were unreachable through OpenClaw's shared `message` action contract.
They are no longer implemented or directly dispatchable. OpenClaw deliberately
keeps that cross-channel action vocabulary closed and directs provider-specific
operations to plugin-owned agent tools with their own schemas and target
semantics. The extension request and minimal reproduction were
[closed by design](https://github.com/openclaw/openclaw/issues/134666#issuecomment-5488003013).
Future Zulip-specific operations must use a separately reviewed Zulip-owned
agent tool or remain removed; they must not be hidden behind string casts in
the shared adapter.

`enableAdminActions` remains accepted as an inert legacy configuration field
so existing strict configurations continue to load. It does not enable any
action, does not interact with `actionTiers`, and can be removed after a
documented configuration migration.