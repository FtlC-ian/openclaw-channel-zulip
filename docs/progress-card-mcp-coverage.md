# Progress-card loopback MCP coverage audit

Audited 2026-10-09 against installed M6 OpenClaw 2026.9.9 and extracted
2026.9.6, 2026.10.1-beta.1 and beta.2 packages. The proposed missing MCP hook is
**not present in these sources**: all four invoke public after_tool_call with
tool name, executed arguments, original result, tool-call ID and session key.
No additional hook source or weaker validation is needed.

## Source receipts

Installed root: /opt/homebrew/lib/node_modules/openclaw/dist/.
Fixture root: /Volumes/WorkingSpace/openclaw/tmp/zulip-92-sdk-audit/<version>/package/dist/.

| Host | HTTP passes session key | MCP completion reports hook | Public hook dispatch/context |
| --- | --- | --- | --- |
| Installed 2026.9.9 | mcp-http-Berf_32X.mjs:435-456 (key at 443) | mcp-http.handlers-duvz4qAA.mjs:73-86,134-145 (key at 80) | hook-helpers-88BXuErh.mjs:10-34 (key at 30) |
| 2026.9.6 | mcp-http-DAU57R_3.mjs:465-469 | mcp-http.handlers-DHGn0cSX.mjs:87-99,157-170 (key at 93) | hook-helpers-Ds5Wl0Rf.mjs:18-34 (key at 30) |
| beta.1 | mcp-http-CaXouB9g.mjs:451-455 | mcp-http.handlers-BMRPr0jE.mjs:73-86,134-145 (key at 80) | hook-helpers-gxghQtQL.mjs:18-34 (key at 30) |
| beta.2 | mcp-http-D2zzQKU6.mjs:452-456 | mcp-http.handlers-D6jdXLo7.mjs:73-86,134-145 (key at 80) | hook-helpers-C_PrFtBr.mjs:18-34 (key at 30) |

The MCP reporter invokes the harness helper asynchronously/best-effort; the helper
checks the global runner for registered hooks, clones args/result, and calls
runAfterToolCall. The session key is conditional on a nonempty caller context,
not reconstructed from tool arguments. Ordinary session-scoped MCP requests
supply that context. Failed/blocked executions also report an error, which the
Zulip validator rejects. Plugin registration: src/zulip/progress-card.ts:154-157.
Its acceptance boundary requires an enabled, known route and validates params/result
before deduplication and revision ordering.

before_message_write is a transcript-write hook, not an alternative canonical
tool-completion contract: installed hook-helpers-88BXuErh.mjs:39-50 supplies only
the message plus agent/session context. Switching to transcript parsing is not
justified when the exact tool completion already exists.

## Live M6 evidence and limits

Read-only inspection of /tmp/openclaw/openclaw-2026-10-09.log found:

- Line 4996, 15:43:27 CDT: setting update reported.
- Lines 4997-4998: the change required a Zulip channel reload, deferred until
  active operations/runs complete.
- Line 5209, 15:46:00 CDT: reload still deferred after 150880 ms.
- Line 5222, 15:46:30 CDT: reload still deferred after 180973 ms.

If revision 10 occurred at approximately 15:46 CDT as reported in the task,
application of the setting was still deferred at that time. These log receipts
do not independently establish the timestamp of the revision-10 tool call.
This is a concrete confounder, **not proof** of which runtime acceptance check
rejected that update: the log does not record the card hook event, bound route,
or rejection reason. The monitor binds routes on inbound dispatch
(src/zulip/monitor.ts:1213); default-off routes are not retained
(src/zulip/progress-card.ts:42-45). An already-active turn that began while off
can therefore lack a route even after a setting is saved. Outbound resolution
can bind enabled routes (src/session-conversation.ts:148-154,196,224).

No core hook fix is indicated by this audit. Safely confirm application of the
pending channel configuration and then observe a fresh inbound turn followed by
a new tool update. Updating the stored card does not replay to Zulip.
The original revision-10 failure remains unproven without runtime hook/route
evidence. No M6 installation, reload, configuration edit or restart was performed
as part of this audit.
