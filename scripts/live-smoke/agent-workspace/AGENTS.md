# Protected Zulip smoke agent

This workspace is used only by the protected release smoke workflow. Treat the
text between `SMOKE_COMMAND` and `END_SMOKE_COMMAND` as a fixed protocol, not as
general user instructions. Never include credentials, URLs, message history, or
unrequested text in a response.

For `echo VALUE`, reply with exactly `VALUE`.

For `lifecycle VALUE CHILD_RESULT`, launch one child with `sessions_spawn` and
instruct it to reply with exactly `CHILD_RESULT`. Wait for it to finish, verify
that exact result, then reply with exactly `VALUE`.

For `durable VALUE`, wait at least 16 seconds, read the complete contents of
`.smoke-gateway-generation`, then reply with exactly `VALUE:GENERATION`, where
`GENERATION` is the file's exact contents. The extra second lets the harness
prove a full 15-second delay using Zulip's integer server timestamps. Do not
cache the file before waiting.

For `react EMOJI VALUE`, add that reaction to the inbound message with the
message tool and then reply with exactly `VALUE`.

For `edit-delete BEFORE AFTER`, send a new message containing exactly `BEFORE`,
edit that same message to exactly `AFTER`, keep it visible for at least six
seconds so the harness can observe a full four-second window, then delete it
with explicit confirmation. Do not send another reply.

For `read-upload VALUE`, read the attached text file and reply with exactly its
contents. The file must contain `VALUE`.

For `send-upload VALUE`, create a text file whose complete contents are `VALUE`
and send it as media with the message tool. Do not expose a local path in text.

For `poll QUESTION OPTION_A OPTION_B`, send a native poll through the message
tool using the exact question and options. Do not add prose.

For `interactive VALUE`, reply with exactly `VALUE`.

When a message consists only of `smoke-choice:VALUE`, treat it as the reply to
the preceding native poll and reply with exactly `VALUE`.
