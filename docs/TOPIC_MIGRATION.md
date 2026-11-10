# Zulip v2 topic sessions

V2 starts fresh topic contexts. Session identity includes the configured account,
normalized Zulip endpoint, bot identity, numeric stream ID, and canonical topic.
Its opaque keys have this shape:

```text
agent:<agent>:zulip:channel:<numeric-stream>:topic:v2:<64hex>
```

Older topic slugs can combine unrelated topics, accounts, or realms. Their history
cannot safely be assigned to one new context. This tool archives legacy stream and
topic sessions under their original keys through OpenClaw's supported gateway API.
It never copies, aliases, merges, deletes, or reads transcripts. Direct messages,
non-Zulip sessions, and v2 keys are excluded. Main and active sessions are refused.

## Preview and apply

Requires Node.js and OpenClaw **2026.9.6 or newer**, with access to the intended
gateway and permission to list and patch its sessions. Use the same OpenClaw
profile/environment throughout. `--openclaw /path/to/openclaw` selects an executable
or a wrapper for that profile; it is executed with an argument array, without a shell.
The tool does not accept or persist credentials.

1. Keep the gateway running. Stop **all Zulip accounts** through OpenClaw and let
   running/queued work finish. Keep them stopped throughout cutover, and do not
   start work against old sessions from another client or automation.
2. Preview and create a plan:

   ```sh
   node scripts/migrate-topic-sessions.mjs --plan ./zulip-archive-plan.json
   ```

   Without arguments the command only previews. Preview output includes original
   keys, which can contain topic slugs; keep the output private. The saved plan has
   mode `0600`, refuses to overwrite an existing file, and stores only key hashes,
   agent/session identities, optional lifecycle revisions, and its format/date.
   It contains no topic text, session titles, messages, gateway URLs, or credentials.
   Review the preview; remove unwanted entries from `targets` if needed.
3. Apply that exact plan:

   ```sh
   node scripts/migrate-topic-sessions.mjs --apply ./zulip-archive-plan.json
   ```

4. Install/enable the v2 plugin before restarting Zulip. Confirm new messages in
   two formerly colliding topics create distinct v2 sessions. Keep the plan as a
   receipt until that manual check passes.

The tool never stops or starts a channel/gateway, changes configuration, or
installs the plugin. `channels.status` must explicitly report every Zulip account
as neither running nor connected. An absent/partial status fails closed. Preview
is read-only and can run while Zulip is online, but refuses a selected legacy row
with active work; a stopped channel is required for apply.

## Recovery and limits

The API is not a transaction spanning channel status and all archives. Each row
is checked again before a guarded `sessions.patch` with `archived: true` and
`expectedSessionId`; a lifecycle revision is also guarded when the gateway
projects one. A paginated `activeOnly` check rejects current running/queued work.
Core archive semantics provide the final session-generation check and lifecycle
drain. Do not concurrently restart Zulip or submit work to legacy sessions.

On failure, keep Zulip stopped and rerun `--apply` with the same plan. Already
archived matching generations are skipped, including a write that succeeded just
before a timeout. A missing or replaced session requires a new preview/plan; the
tool will not archive its replacement on the old plan's authority. Failure output
reports only confirmed completions; the last attempted write may be uncertain.

Archives retain their original keys and existing transcripts under **ordinary
OpenClaw archive and retention semantics**. Archiving is not immutability, a
backup, an access-control boundary, or a guarantee against later retention
cleanup. It does not disable history/search/recall tools. Access to old history
continues to follow core policy. This cutover prevents automatic legacy-context
reuse by the v2 plugin; it does not relocate or sanitize historical content.

The implementation uses `openclaw gateway call sessions.list --params ... --json`
with `archived: "all"`, explicit offsets, `hasMore`/`nextOffset`, and no requested
transcript titles/previews. It never edits the session store directly. The CLI's
read-only local-state startup mode still permits authenticated gateway RPC
mutations; `--apply` explicitly calls `sessions.patch`.

Offline verification:

```sh
node --test scripts/migrate-topic-sessions.test.mjs
```
