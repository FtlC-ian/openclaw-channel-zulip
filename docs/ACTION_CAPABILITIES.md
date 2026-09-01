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

## Blocked provider-specific actions

The former `channel-subscribe`, `invite`, `resolve-topic`, `user-presence`,
`user-deactivate`, `user-reactivate`, `org-settings`, and `org-settings-edit`
handlers were unreachable through OpenClaw's public message-action contract.
They are no longer implemented or directly dispatchable. OpenClaw currently
uses a closed action-name union and fixed target-mode map, so a plugin cannot
advertise or route those provider-specific names. The upstream SDK request and
minimal reproduction are tracked in
[openclaw/openclaw#134666](https://github.com/openclaw/openclaw/issues/134666).

`enableAdminActions` remains accepted as an inert legacy configuration field so
existing strict configurations continue to load. It does not expose hidden
actions and can be removed after a documented configuration migration.
