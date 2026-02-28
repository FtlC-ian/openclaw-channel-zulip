# openclaw-channel-zulip

> Zulip channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) — concurrent message processing, reaction indicators, file uploads, and full actions API.

[![npm version](https://img.shields.io/npm/v/openclaw-channel-zulip.svg)](https://www.npmjs.com/package/openclaw-channel-zulip)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Features

- ✅ **Concurrent message processing** — events fire-and-forget with staggered start times (200 ms apart), so a burst of incoming messages is handled in parallel rather than queued sequentially
- ✅ **Reaction indicators** — configurable emoji reactions signal processing state (`:working_on_it:` on start, ✅ on success, ❌ on error, with optional clear-on-finish)
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

      // Which streams to monitor ("*" = all)
      "streams": ["general", "bot-testing"],

      // Default topic for outbound messages with no explicit topic
      "defaultTopic": "bot replies",

      // Chat mode: "oncall" (mentioned only) | "onmessage" | "onchar"
      "chatmode": "oncall",

      // DM policy: "open" | "pairing" | "allowlist" | "disabled"
      "dmPolicy": "open",
      "allowFrom": ["*"],

      // Group policy: "open" | "allowlist" | "disabled"
      "groupPolicy": "open",

      // Reaction indicators (shown while the bot is processing)
      "reactions": {
        "enabled": true,
        "onStart": "working_on_it",
        "onSuccess": "check",
        "onError": "x",
        "clearOnFinish": false
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

## Why concurrent processing?

Most channel plugin implementations process incoming messages one at a time — each message waits for the previous one to finish before starting. Under load (e.g. a burst of messages after reconnect) this creates noticeable latency for later messages.

This plugin processes events **concurrently**: each message is dispatched immediately (fire-and-forget with error handling) and a small 200 ms stagger is introduced between starts for natural pacing. The result is that ten simultaneous messages all start processing within ~2 seconds of each other instead of serially.

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

---

## License

MIT © FtlC-ian
