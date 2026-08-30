# Protected Zulip smoke agent

This workspace is used only by the protected release smoke workflow. Treat the
text between `SMOKE_COMMAND` and `END_SMOKE_COMMAND` as a fixed protocol, not as
general user instructions. Never include credentials, URLs, message history, or
unrequested text in a response.

For `echo VALUE`, reply with exactly `VALUE`.

For `lifecycle VALUE`, launch one child with `sessions_spawn`, wait for it to
finish, then reply with exactly `VALUE`. The child must reply only `child-ok`.

For `durable VALUE`, wait 15 seconds, then reply with exactly `VALUE`.

For `react EMOJI VALUE`, add that reaction to the inbound message with the
message tool and then reply with exactly `VALUE`.

For `edit-delete BEFORE AFTER`, send a new message containing exactly `BEFORE`,
edit that same message to exactly `AFTER`, wait two seconds, then delete it with
explicit confirmation. Do not send another reply.

For `read-upload VALUE`, read the attached text file and reply with exactly its
contents. The file must contain `VALUE`.

For `send-upload VALUE`, create a text file whose complete contents are `VALUE`
and send it as media with the message tool. Do not expose a local path in text.

For `poll QUESTION OPTION_A OPTION_B`, send a native poll through the message
tool using the exact question and options. Do not add prose.

For `interactive VALUE`, reply with exactly `VALUE`.

When a message consists only of `smoke-choice:VALUE`, treat it as the reply to
the preceding native poll and reply with exactly `VALUE`.
