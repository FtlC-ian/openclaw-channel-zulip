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

      // Default topic for outbound messages with no explicit topic
      "defaultTopic": "bot replies",

      // Chat mode: "oncall" (mentioned only) | "onmessage" | "onchar"
      "chatmode": "oncall",

      // DM policy: "open" | "pairing" | "allowlist" | "disabled"
      "dmPolicy": "open",
      "allowFrom": ["*"],

      // Group policy: "open" | "allowlist" | "disabled"
      "groupPolicy": "open",

      // Optional reaction hooks (defaults no longer add start/success emoji spam)
      "reactions": {
        "enabled": false,
        "onError": "warning"
      },

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
