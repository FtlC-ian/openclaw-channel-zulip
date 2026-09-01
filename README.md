# openclaw-channel-zulip

> Zulip channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) — concurrent message processing, native session conversation binding, file uploads, approval hooks, and full actions API.

[![npm version](https://img.shields.io/npm/v/openclaw-channel-zulip.svg)](https://www.npmjs.com/package/openclaw-channel-zulip)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Features

- ✅ **Concurrent message processing** — events fire-and-forget with staggered start times (200 ms apart), so a burst of incoming messages is handled in parallel rather than queued sequentially
- ✅ **Native session conversation binding** — stream topics resolve through the SDK session-conversation hook instead of hand-rolled session key grammar
- ✅ **File uploads** — inbound Zulip file attachments are downloaded and forwarded to the AI pipeline; outbound media is uploaded via Zulip's file upload API
- ✅ **Full actions API** — react, edit, delete, archive, move messages/topics; subscribe/unsubscribe streams; user management (requires `enableAdminActions: true`)
- ✅ **Topic directives** — reply topics can be scoped per-message, enabling organized thread-based conversations
- ✅ **Multi-account support** — run multiple Zulip bot accounts in one OpenClaw instance via the `accounts` map
- ✅ **DM & channel policies** — open / pairing / allowlist / disabled per account
- ✅ **Block streaming** — real-time streaming replies with configurable coalescing (min chars / idle timeout)
- ✅ **Onboarding wizard** — `openclaw onboard` walks you through setup interactively

---

## Installation

This source supports OpenClaw **2026.7.1-2 through 2026.8.1**. The development
dependency and minimum host version remain pinned to 2026.7.1-2, so the same
plugin build can still be installed and tested on the current stable host.

Durable inbound handling uses the shared ingress queue API available in both
supported versions. When upgrading an existing installation, pending records and
deduplication tombstones from the older keyed-store journal retain their original
namespaces and retention. They are replayed or completed through the compatibility
journal instead of being silently discarded.

Outbound media loading uses the typed media-runtime SDK surface shared by both
versions. Command access-group authorization remains enabled even if an older
configuration still contains the removed `commands.useAccessGroups` toggle.

OpenClaw 2026.8.1 compatibility does not require upgrading a running Gateway.
Keep production on 2026.7.1-2 until the separate 2026.8.1 core startup regressions
are resolved.

### Via plugin manager (recommended)

```sh
openclaw plugins install openclaw-channel-zulip
```

### Manual (for development or customization)

```sh
# 1. Clone the repo
git clone https://github.com/FtlC-ian/openclaw-channel-zulip.git
cd openclaw-channel-zulip

# 2. Install dependencies
npm install

# 3. Install as a local linked plugin
openclaw plugins install -l .
```

---

## Configuration

### Enable the plugin

Add the plugin id to `plugins.allow` in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["zulip"]
  }
}
```

### Minimal configuration

```json
{
  "channels": {
    "zulip": {
      "enabled": true,
      "url": "https://your-org.zulipchat.com",
      "email": "yourbot@your-org.zulipchat.com",
      "apiKey": "your-zulip-api-key",
      "streams": ["general", "support"],
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  }
}
```

### Full configuration reference

```json
{
  "channels": {
    "zulip": {
      "enabled": true,

      // Zulip server connection
      "url": "https://your-org.zulipchat.com",
      "email": "yourbot@your-org.zulipchat.com",
      "apiKey": "your-zulip-api-key",
      // Or store the API key in an OpenClaw SecretRef:
      // "apiKey": { "source": "env", "provider": "zulip", "id": "ZULIP_API_KEY" },

      // Which streams to monitor ("*" = all)
      "streams": ["general", "bot-testing"],

      // Optional inbound topic filters for monitored streams.
      // Topic matching trims whitespace and is case-insensitive.
      // Omit, use [], or include "*" to allow all topics.
      "topics": ["support", "bot help"],

      // Optional per-stream topic filters. Keys may be stream names or ids.
      // A matching stream-specific filter further restricts the global topics list;
      // streams with no entry use only the global topics filter.
      "streamTopics": {
        "general": ["support"],
        "42": ["bot help"]
      },

      // Optional inbound-only policy overrides. ASCII decimal keys select
      // stream IDs; every other key selects a normalized stream name.
      "streamOverrides": {
        "general": {
          "enabled": true,
          "requireMention": false,
          "allowedTopics": ["support", "bot help"],
          "excludedTopics": ["private"]
        },
        "42": { "enabled": false }
      },

      // Default topic for outbound messages with no explicit topic
      "defaultTopic": "bot replies",

      // Chat mode: "oncall" (mentioned only) | "onmessage" | "onchar"
      "chatmode": "oncall",

      // DM policy: "open" | "pairing" | "allowlist" | "disabled"
      "dmPolicy": "open",
      "allowFrom": ["*"],

      // Group policy: "open" | "allowlist" | "disabled"
      "groupPolicy": "open",

      // Truthful lifecycle reactions on the inbound message. The defaults show
      // queued, thinking, tool category, compaction, stalls, done/error, and
      // a separate robot while one or more spawned children are active.
      "reactions": {
        "enabled": true,
        "clearOnFinish": true,
        "subagent": "🤖",
        "timing": {
          "stallSoftMs": 10000,
          "stallHardMs": 30000
        },
        "emojis": {
          "thinking": "brain",
          "coding": "computer",
          "web": "🌐"
        }
      },

      // Optional edit-in-place progress feedback (disabled by default).
      // Text-only replies replace this message. Media and interactive replies
      // remove it before sending normally; silent or cancelled turns remove it.
      // Failed turns keep the placeholder and replace it with errorText.
      "thinkingPlaceholder": {
        "enabled": false,
        "text": "Thinking…",
        "errorText": "I couldn't complete that response."
      },

      // Model-controlled reaction prompt guidance: "off" | "minimal" | "extensive"
      // This does not enable automatic status/progress reactions.
      "agentReactionGuidance": "minimal",

      // Block streaming (real-time reply chunks)
      "blockStreaming": true,
      "blockStreamingCoalesce": {
        "minChars": 1500,
        "idleMs": 1000
      },

      // Enable admin-level actions (move/archive streams, manage users)
      "enableAdminActions": false,

      // Multi-account: uncomment to run multiple bots
      // "accounts": {
      //   "primary": { "url": "...", "email": "...", "apiKey": "..." },
      //   "secondary": { "url": "...", "email": "...", "apiKey": "..." }
      // }
    }
  }
}
```

Then restart the Gateway:

```sh
openclaw gateway restart
```

### Per-stream inbound policy and migration

Existing configurations do not need changes. `streams`, `topics`, and
`streamTopics` keep their previous behavior. `streams` remains the legacy
inbound allowlist, while `streamTopics` further restricts the account-level
`topics` allowlist.

`streamOverrides` adds field-by-field inbound overrides with this precedence:

1. Account defaults (`requireMention`/`chatmode` and `topics`).
2. Legacy `streams` activation and the additional `streamTopics` restriction.
3. A matching normalized stream-name override.
4. A matching decimal stream-ID override.

An omitted field inherits the lower-precedence value. An explicit
`enabled: true` may activate a stream outside `streams`; `enabled: false`
disables inbound handling. `allowedTopics` replaces lower-precedence allowed
topic filters when set. Empty `allowedTopics`, or one containing `"*"`, allows
all topics. `excludedTopics` is applied afterward, so exclusions win;
`["*"]` excludes every topic.

Names are trimmed and matched case-insensitively against the authoritative
name on the Zulip message. Keys containing only ASCII digits are always IDs;
leading zeroes are canonicalized, so `"017"` selects ID 17. Values such as
`"1e3"`, `"0x11"`, and `"+17"` are names, never coerced IDs. Duplicate keys
after normalization are rejected. ID rules are the safest choice across
stream renames. A replayed message never uses its historical name when current
stream metadata is unavailable.

These rules govern inbound activation only. Outbound send, read, search, and
administrative actions remain available according to their existing access
controls.

### Lifecycle reactions

When `channels.zulip.reactions.enabled` is not `false`, the plugin uses OpenClaw's
public status-reaction controller. Reactions reflect actual queued, reasoning,
tool-category, compaction, stall, done, and error events; native Zulip typing
continues independently and no placeholder message is posted. `clearOnFinish`
defaults to `true`, so the terminal reaction is removed after its configured
hold. Set it to `false` to retain the final done/error reaction.

The dedicated `subagent` reaction is driven only by `subagent_spawned` and
`subagent_ended` hooks. It remains while at least one child run bound to that
exact inbound turn is active, including concurrent children and children that
outlive the requester's reply. The default is `🤖`. Built-in lifecycle
Unicode values (`👀`, `🧠`, `🛠️`, `💻`, `🌐`, `🛫`, `🏗️`, `💁`, `✅`, `❌`,
`⏳`, `⚠️`, `🗜️`, and `🤖`) and named Zulip emoji are supported; arbitrary
Unicode is rejected because Zulip requires exact reaction metadata. An empty
string suppresses that state. The built-in defaults use these Unicode values
so the plugin always sends Zulip's required emoji code and reaction type.
Account-level
`reactions.emojis` and `reactions.timing` override global
`messages.statusReactions` values. The legacy `onStart`, `onSuccess`, and
`onError` keys remain accepted as queued, done, and error aliases, and an
explicit empty legacy value suppresses its state.

This subagent indicator covers children launched through OpenClaw's
`sessions_spawn` lifecycle, which emits the public hooks above. Codex-native
collaboration tasks do not currently expose that lifecycle through OpenClaw's
public plugin hooks, so they cannot truthfully drive this indicator.

---

## How to get a Zulip API key

1. Log in to your Zulip organization
2. Go to **Settings → Your bots** (or create a bot at **Settings → Bots → Add a new bot**)
3. Copy the bot's **email** and **API key**
4. Use `https://your-org.zulipchat.com` as the `url`

---

## Approvals and session binding

Topic-scoped conversations now resolve through the SDK session-conversation hook, plus the plugin ships a bootstrap-safe `session-key-api.ts` export for core fallbacks.

Basic approval authorization is now wired through `approvalCapability`, using normalized Zulip identities from `allowFrom` as the first pass.

### Direct-message isolation and rotation

Zulip DMs always use an isolated OpenClaw session keyed by agent, channel,
normalized account id, Zulip realm, bot identity, and sender identity. This
remains enforced when the global `session.dmScope` is `main`; explicit identity
links do not merge Zulip DM sessions. Stream and topic sessions retain their
existing keys.

The isolated key format replaces older Zulip DM keys. After upgrading, each DM
starts a fresh session on its first message. Existing transcripts remain on disk
under their old keys but are not imported, because importing a previously shared
session could copy another sender's context into the isolated session.

Idle rotation is owned by OpenClaw. Configure its supported direct-session policy:

```json
{
  "session": {
    "resetByType": {
      "direct": { "mode": "idle", "idleMinutes": 1440 }
    }
  }
}
```

The host uses the last real interaction and considers the exact expiry timestamp
fresh; the session rotates on the next millisecond. Restarts preserve that
timestamp. OpenClaw 2026.7.1-2 through 2026.8.1 does not publish a turn-count
session-rotation API. The plugin therefore does not create parallel session state
or approximate turn rotation. Turn-count rotation remains blocked on a public
host policy/API.

## Why concurrent processing?

Most channel plugin implementations process incoming messages one at a time — each message waits for the previous one to finish before starting. Under load (e.g. a burst of messages after reconnect) this creates noticeable latency for later messages.

This plugin processes events **concurrently**: each message is dispatched immediately (fire-and-forget with error handling) and a small 200 ms stagger is introduced between starts for natural pacing. The result is that ten simultaneous messages all start processing within ~2 seconds of each other instead of serially.

---

## Troubleshooting: stream replies

If the bot appears to receive DMs but does not reply in Zulip streams, check the stream policy first. Stream messages are treated as group messages, so `groupPolicy` controls whether the bot is allowed to respond there.

Common setups that intentionally produce no visible stream reply:

- `groupPolicy: "disabled"` drops all stream messages.
- `groupPolicy: "allowlist"` requires the sender to match `groupAllowFrom`; if the sender is not allowed, the message is ignored.
- `chatmode: "oncall"` or `requireMention: true` means the bot only replies when it is mentioned.
- `topics` or `streamTopics` filters only allow matching topics; messages in other topics are ignored.
- A matching `streamOverrides` rule can disable the stream, change its mention requirement, or allow/exclude topics.

For the simplest “reply in monitored streams” setup, use `groupPolicy: "open"` with the stream listed in `streams`, then add mention or topic filters only after the basic path works.

---

## Updating

If installed via npm:

```sh
openclaw plugins update zulip
```

If installed from local source:

```sh
cd openclaw-channel-zulip
git pull
openclaw gateway restart
```

---

## Continuous integration

Pull requests and pushes to `main` run the release-blocking **CI** workflow on Node 22.19 and Node 24. Each run installs from `pnpm-lock.yaml` with `--frozen-lockfile`, builds, runs the full test suite, checks whitespace errors with `git diff --check`, packs the release artifact, installs it with the locked OpenClaw host in a clean temporary project, and imports its public package entry point. The workflow has read-only repository permissions and does not receive repository or Zulip secrets.

Release candidates also have a manual **Zulip live smoke (protected)** workflow.
Its workflow definition can run only from `main`. By default it accepts a full
commit SHA reachable from `main`; the repository owner may instead name a
same-repository candidate branch so live-only fixes can be tested repeatedly
before one final pull request is opened. Dedicated-realm credentials remain
unavailable until approval through the protected `zulip-live-smoke` GitHub Environment. See
[the release checklist](docs/RELEASE_CHECKLIST.md) for setup and evidence rules.
The workflow stages the already-authorized, exact-SHA candidate inside the
locked OpenClaw package's bundled extension directory. It verifies that the
host reports Zulip as a loaded bundled plugin before credentials are used, then
runs durable receive interruption, replay, completion, and deduplication with
plugin keyed state enabled. This staging exists only in the ephemeral runner;
release installation remains the separately published plugin package.

The scheduled **OpenClaw compatibility (advisory)** workflow is intentionally separate from release gating. Once a week it chooses the first eligible release from OpenClaw's `latest` and `extended-stable` npm channels that has been published for at least 24 hours, then installs and tests it in a temporary copy of the plugin. That temporary install and the packed-artifact smoke test enforce pnpm's 24-hour release-age rule and may update only disposable lockfiles; they never change or commit this repository's lockfile. A failure identifies compatibility work to investigate; it does not replace the locked CI evidence required for a release.

---

## Plugin ID

The plugin id is `zulip` (defined in `openclaw.plugin.json`). Use this id in `plugins.allow` and with `openclaw plugins` commands.

---

## Resources

- [OpenClaw plugin documentation](https://openclaw.dev/plugins)
- [Zulip Bot API docs](https://zulip.com/api/overview)
- [OpenClaw channel plugin reference](https://openclaw.dev/channels/zulip)

## Related

- **[zulcrawl](https://github.com/FtlC-ian/zulcrawl)** — Zulip archive & search CLI. Mirrors streams, topics, and messages into local SQLite with FTS5 full-text search. Pairs with this plugin to give AI agents searchable access to Zulip conversation history. Inspired by [steipete/discrawl](https://github.com/steipete/discrawl).

---

## License

MIT © FtlC-ian
