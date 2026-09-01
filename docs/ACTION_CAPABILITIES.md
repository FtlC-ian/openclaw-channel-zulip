# Zulip message action capabilities

This matrix is the checked-in contract for the shared OpenClaw `message` tool.
`src/actions.ts` owns the advertised list, action-scoped schema contributions,
and plugin-handler allowlist so those surfaces cannot silently diverge.

| Action | Owner | Target mode | Authorization | Confirmation | Dry run | Coverage |
| --- | --- | --- | --- | --- | --- | --- |
| `send` | plugin | `to` | configured account credential | no | yes | action and outbound tests |
| `read` | plugin | `to` | configured account credential | no | host read-only | action tests |
| `channel-list` | plugin | none | configured account credential | no | host read-only | action tests |
| `channel-create` | plugin | none | Zulip credential permission | no | yes | action tests |
| `channel-edit` | plugin | `channelId` | Zulip credential permission | no | yes | action tests |
| `channel-delete` | plugin | `channelId` | Zulip credential permission | `confirm: true` | yes | action tests |
| `react` | plugin | `to` | Zulip credential permission | no | yes | action tests |
| `edit` | plugin | `to` | Zulip credential permission | no | yes | action tests |
| `delete` | plugin | `to` | Zulip credential permission | `confirm: true` | yes | action tests |
| `unsend` | plugin alias for `delete` | `to` | Zulip credential permission | `confirm: true` | yes | action tests |
| `search` | plugin | none | configured account credential | no | host read-only | action tests |
| `member-info` | plugin | none | configured account credential | no | host read-only | action tests |
| `pin` | plugin | `to` | Zulip credential permission | no | yes | action tests |
| `unpin` | plugin | `to` | Zulip credential permission | no | yes | action tests |
| `poll` | OpenClaw core via `outbound.sendPoll` | `to` | configured account credential | no | host-owned | channel/outbound tests |

The adapter does not add a separate owner/trusted-requester gate to mutable
actions. Zulip applies the permissions of the selected bot credential. The
three destructive actions additionally require the exact boolean
`confirm: true` before any Zulip request.

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
agent tool or remain removed; they must not be hidden behind string casts in the
shared adapter.

`enableAdminActions` remains accepted as an inert legacy configuration field so
existing strict configurations continue to load. It does not expose hidden
actions and can be removed after a documented configuration migration.
