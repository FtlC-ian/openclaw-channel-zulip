import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertFinalPrivateTypingStop, assertMessageRemainsExact, authenticatedUserId, buildApiUrl, captureMessageIds, captureObservedSmokeBotMessageIds, countCompletedChildTranscripts, countMessageDeletionFailures, drainEventQueueUntilQuiet, eventOccursBefore, EventQueue, extractExactUploadUrl, Gateway, hasFinalPrivateTypingStop, hasProvableMinimumMessageDelay, inspectChildTranscripts, isBotMessage, isChildRunning, isDurableReplyEvent, isExactPoll, isExactPollMessage, isExactRenderedContent, isExactUtf8, isPrivateBotEvent, isPrivateBotMessage, isPrivateTypingEvent, isUsageCountedTranscriptName, lifecycleSummary, normalizeScenarioError, probeRunnerLocalGatewayHealth, redactError, resolveUploadUrl, signalProcessTree, subagentCompletedBeforeReply, validateEnvironment, waitForProcessTreeExit, writeGatewayGeneration } from "./run.mjs";

const ACTOR_USER_ID = "42";
const BOT_USER_ID = "91";

const validEnv = {
  ZULIP_URL: "https://zulip.example.test/path",
  ZULIP_SMOKE_USER_EMAIL: "user@example.test",
  ZULIP_SMOKE_USER_API_KEY: "user-key",
  ZULIP_SMOKE_BOT_EMAIL: "bot@example.test",
  ZULIP_SMOKE_BOT_API_KEY: "bot-key",
  ZULIP_SMOKE_STREAM: "smoke",
  SMOKE_TESTED_SHA: "a".repeat(40),
  OPENCLAW_STATE_DIR: "/tmp/openclaw-smoke-state",
};

test("validates protected configuration while preserving base paths", () => {
  assert.equal(validateEnvironment(validEnv).ZULIP_URL, "https://zulip.example.test/path");
  assert.throws(() => validateEnvironment({ ...validEnv, ZULIP_URL: "http://zulip.test" }), /HTTPS/);
  assert.throws(() => validateEnvironment({ ...validEnv, ZULIP_SMOKE_USER_API_KEY: "" }), /protected configuration/);
});

test("preserves Zulip base paths when constructing API URLs", () => {
  assert.equal(buildApiUrl("https://zulip.example.test/path", "/messages").href, "https://zulip.example.test/path/api/v1/messages");
  assert.equal(buildApiUrl("https://zulip.example.test", "user_uploads").href, "https://zulip.example.test/api/v1/user_uploads");
});

test("keeps upload URLs inside the configured Zulip realm path", () => {
  assert.equal(resolveUploadUrl("https://zulip.example.test/path", "/user_uploads/a.txt").href, "https://zulip.example.test/path/user_uploads/a.txt");
  assert.equal(resolveUploadUrl("https://zulip.example.test/path", "/path/user_uploads/a.txt").href, "https://zulip.example.test/path/user_uploads/a.txt");
  assert.throws(() => resolveUploadUrl("https://zulip.example.test/path", "https://zulip.example.test/user_uploads/a.txt"), /outside/);
  assert.throws(() => resolveUploadUrl("https://zulip.example.test/path", "https://other.example.test/path/user_uploads/a.txt"), /outside/);
});

test("redacts URLs and authorization values", () => {
  const output = redactError(new Error("failed https://private.test/path?token=abc Basic abcdefghijklmnopqrstuvwxyz123456"));
  assert.equal(output.includes("private.test"), false);
  assert.equal(output.includes("abcdefghijklmnopqrstuvwxyz"), false);
});

test("matches only marked messages from the configured bot", () => {
  const event = { type: "message", message: { sender_id: Number(BOT_USER_ID), content: "marker" } };
  assert.equal(isBotMessage(event, BOT_USER_ID, "marker"), true);
  assert.equal(isBotMessage({ ...event, message: { ...event.message, content: "<p>marker</p>" } }, BOT_USER_ID, "marker"), true);
  assert.equal(isBotMessage({ ...event, message: { ...event.message, content: "prefix marker" } }, BOT_USER_ID, "marker"), false);
  assert.equal(isBotMessage(event, "92", "marker"), false);
  assert.equal(isBotMessage({ type: "message", message: { content: "marker" } }, undefined, "marker"), false);
});

test("requires private bot replies with the exact user IDs despite differing login emails", () => {
  const event = { type: "message", message: { type: "private", sender_id: Number(BOT_USER_ID), sender_email: "bot-event@example.test", content: "marker", display_recipient: [
    { id: Number(BOT_USER_ID), email: "bot-event@example.test" },
    { id: Number(ACTOR_USER_ID), email: "actor-event@example.test" },
  ] } };
  assert.equal(isPrivateBotMessage(event, BOT_USER_ID, ACTOR_USER_ID, "marker"), true);
  assert.equal(isPrivateBotMessage({ ...event, message: { ...event.message, sender_id: undefined } }, undefined, ACTOR_USER_ID, "marker"), false);
  assert.equal(isPrivateBotMessage({ ...event, message: { ...event.message, type: "stream" } }, BOT_USER_ID, ACTOR_USER_ID, "marker"), false);
  assert.equal(isPrivateBotMessage({ ...event, message: { ...event.message, display_recipient: [{ id: Number(BOT_USER_ID) }] } }, BOT_USER_ID, ACTOR_USER_ID, "marker"), false);
  assert.equal(isPrivateBotMessage({ ...event, message: { ...event.message, display_recipient: [...event.message.display_recipient, { id: 7 }] } }, BOT_USER_ID, ACTOR_USER_ID, "marker"), false);
  const uploadEvent = { ...event, message: { ...event.message, content: "[file](/user_uploads/a.txt)" } };
  assert.equal(isPrivateBotEvent(uploadEvent, BOT_USER_ID, ACTOR_USER_ID), true);
  assert.equal(isPrivateBotEvent({ ...uploadEvent, message: { ...uploadEvent.message, type: "stream" } }, BOT_USER_ID, ACTOR_USER_ID), false);
});

test("matches private typing by user ID across supported sender payload shapes", () => {
  const event = { type: "typing", op: "start", message_type: "direct", sender: { user_id: Number(BOT_USER_ID), email: "bot-event@example.test" }, recipients: [
    { user_id: Number(BOT_USER_ID), email: "bot-event@example.test" },
    { user_id: Number(ACTOR_USER_ID), email: "actor-event@example.test" },
  ] };
  assert.equal(isPrivateTypingEvent(event, BOT_USER_ID, ACTOR_USER_ID, "start"), true);
  assert.equal(isPrivateTypingEvent({ ...event, sender: { id: Number(BOT_USER_ID) } }, BOT_USER_ID, ACTOR_USER_ID, "start"), true);
  assert.equal(isPrivateTypingEvent({ ...event, sender: undefined, sender_id: Number(BOT_USER_ID) }, BOT_USER_ID, ACTOR_USER_ID, "start"), true);
  assert.equal(isPrivateTypingEvent({ ...event, op: "stop" }, BOT_USER_ID, ACTOR_USER_ID, "start"), false);
  assert.equal(isPrivateTypingEvent({ ...event, sender: { user_id: 92 } }, BOT_USER_ID, ACTOR_USER_ID, "start"), false);
  assert.equal(isPrivateTypingEvent({ ...event, sender: undefined }, undefined, ACTOR_USER_ID, "start"), false);
  assert.equal(isPrivateTypingEvent({ ...event, recipients: [...event.recipients, { id: 7 }] }, BOT_USER_ID, ACTOR_USER_ID, "start"), false);
});

test("extracts authenticated Zulip user IDs and rejects malformed identity responses", () => {
  assert.equal(authenticatedUserId({ user_id: 42 }, "Smoke actor"), ACTOR_USER_ID);
  assert.equal(authenticatedUserId({ id: "91" }, "Smoke bot"), BOT_USER_ID);
  assert.throws(() => authenticatedUserId({ user_id: "actor@example.test" }, "Smoke actor"),
    /Smoke actor did not return a valid user_id/);
});

test("requires the final matching typing event to stop", () => {
  const base = { type: "typing", message_type: "direct", sender: { user_id: Number(BOT_USER_ID) }, recipients: [
    { id: Number(BOT_USER_ID) }, { id: Number(ACTOR_USER_ID) },
  ] };
  const start = { ...base, op: "start" };
  const stop = { ...base, op: "stop" };
  assert.equal(hasFinalPrivateTypingStop([start, stop], BOT_USER_ID, ACTOR_USER_ID), true);
  assert.equal(hasFinalPrivateTypingStop([start, stop, start], BOT_USER_ID, ACTOR_USER_ID), false);
  assert.equal(hasFinalPrivateTypingStop([stop], BOT_USER_ID, ACTOR_USER_ID), false);
  assert.equal(hasFinalPrivateTypingStop([start, stop, { ...start, sender: { user_id: 92 } }], BOT_USER_ID, ACTOR_USER_ID), true);
});

test("rechecks the final typing state after draining later events", async () => {
  const base = { type: "typing", message_type: "direct", sender: { user_id: Number(BOT_USER_ID) }, recipients: [
    { id: Number(BOT_USER_ID) }, { id: Number(ACTOR_USER_ID) },
  ] };
  const start = { ...base, op: "start" };
  const stop = { ...base, op: "stop" };
  const queue = {
    events: [start, stop],
    batches: [[start], []],
    async poll() {
      const batch = this.batches.shift() ?? [];
      this.events.push(...batch);
      return batch;
    },
  };
  await assert.rejects(
    assertFinalPrivateTypingStop(queue, 0, BOT_USER_ID, ACTOR_USER_ID, undefined, 10, 100, 0),
    /Final direct typing state was not stopped/,
  );
});

test("drains through a transient empty poll before checking terminal lifecycle state", async () => {
  const base = { type: "reaction", message_id: 42, user_id: 7, reaction_type: "unicode_emoji" };
  const events = [
    { ...base, emoji_name: "robot", emoji_code: "1f916", op: "add" },
    { ...base, emoji_name: "robot", emoji_code: "1f916", op: "remove" },
  ];
  const started = Date.now();
  let terminalSent = false;
  const queue = { events, async poll() {
    if (!terminalSent && Date.now() - started >= 10) {
      terminalSent = true;
      const terminal = { ...base, emoji_name: "white_check_mark", emoji_code: "2705", op: "add" };
      this.events.push(terminal);
      return [terminal];
    }
    return [];
  } };
  await drainEventQueueUntilQuiet(queue, undefined, 30, 200, 5);
  assert.equal(lifecycleSummary(queue.events, "42").allRemoved, false);
});

test("fails closed when the event queue never reaches a quiet window", async () => {
  const queue = { events: [], async poll() { return [{ type: "message" }]; } };
  await assert.rejects(drainEventQueueUntilQuiet(queue, undefined, 10, 25, 0), /stable quiet window/);
});

test("waits through the locked default terminal hold until lifecycle cleanup", async () => {
  const base = { type: "reaction", message_id: 42, user_id: 7, reaction_type: "unicode_emoji" };
  const terminal = { ...base, emoji_name: "check", emoji_code: "2705" };
  const events = [
    { ...base, emoji_name: "robot", emoji_code: "1f916", op: "add" },
    { ...base, emoji_name: "robot", emoji_code: "1f916", op: "remove" },
  ];
  const started = Date.now();
  let added = false;
  let removed = false;
  const queue = { events, async poll() {
    const elapsed = Date.now() - started;
    if (!added && elapsed >= 25) {
      added = true;
      const event = { ...terminal, op: "add" };
      this.events.push(event);
      return [event];
    }
    if (!removed && elapsed >= 1525) {
      removed = true;
      const event = { ...terminal, op: "remove" };
      this.events.push(event);
      return [event];
    }
    return [];
  } };
  await drainEventQueueUntilQuiet(queue, undefined, 500, 4000, 25, () => lifecycleSummary(queue.events, "42").allRemoved);
  assert.equal(removed, true);
  assert.equal(lifecycleSummary(queue.events, "42").allRemoved, true);
  assert.equal(Date.now() - started >= 2000, true);
});

test("does not settle when a late typing start follows the earlier stop", async () => {
  const reaction = { type: "reaction", message_id: 42, user_id: 7, reaction_type: "unicode_emoji", emoji_name: "robot", emoji_code: "1f916" };
  const typing = { type: "typing", message_type: "direct", sender: { user_id: Number(BOT_USER_ID) }, recipients: [
    { id: Number(BOT_USER_ID) }, { id: Number(ACTOR_USER_ID) },
  ] };
  const events = [{ ...reaction, op: "add" }, { ...reaction, op: "remove" }, { ...typing, op: "start" }, { ...typing, op: "stop" }];
  const started = Date.now();
  let lateStartSent = false;
  const queue = { events, async poll() {
    if (!lateStartSent && Date.now() - started >= 20) {
      lateStartSent = true;
      const event = { ...typing, op: "start" };
      this.events.push(event);
      return [event];
    }
    return [];
  } };
  await assert.rejects(
    drainEventQueueUntilQuiet(queue, undefined, 30, 100, 5, () =>
      lifecycleSummary(queue.events, "42").allRemoved &&
      hasFinalPrivateTypingStop(queue.events, BOT_USER_ID, ACTOR_USER_ID)),
    /stable quiet window/,
  );
  assert.equal(lateStartSent, true);
  assert.equal(hasFinalPrivateTypingStop(queue.events, BOT_USER_ID, ACTOR_USER_ID), false);
});

test("matches complete raw or Zulip-rendered content", () => {
  assert.equal(isExactRenderedContent("after", "after"), true);
  assert.equal(isExactRenderedContent("<p>after</p>", "after"), true);
  assert.equal(isExactRenderedContent("<p>prefix after suffix</p>", "after"), false);
  assert.equal(isExactRenderedContent(" after ", "after"), false);
  assert.equal(isExactRenderedContent("\n<p>after</p>\n", "after"), false);
});

test("attributes every configured-bot DM containing the unique durable marker", () => {
  const base = { type: "message", message: { type: "private", sender_id: Number(BOT_USER_ID), display_recipient: [
    { id: Number(BOT_USER_ID) }, { id: Number(ACTOR_USER_ID) },
  ] } };
  for (const content of ["durable-marker", "durable-marker:old", "<p>durable-marker:wrong</p>", "prefix durable-marker suffix"]) {
    assert.equal(isDurableReplyEvent({ ...base, message: { ...base.message, content } }, BOT_USER_ID, ACTOR_USER_ID, "durable-marker"), true);
  }
  assert.equal(isDurableReplyEvent({ ...base, message: { ...base.message, sender_id: 92, content: "durable-marker" } }, BOT_USER_ID, ACTOR_USER_ID, "durable-marker"), false);
});

test("requires the explicit reaction event to precede its acknowledgement", () => {
  const reaction = { type: "reaction" };
  const reply = { type: "message" };
  assert.equal(eventOccursBefore([reaction, reply], reaction, reply), true);
  assert.equal(eventOccursBefore([reply, reaction], reaction, reply), false);
  assert.equal(eventOccursBefore([reaction], reaction, reply), false);
});

test("proves the durable delay from Zulip server message timestamps", () => {
  const commandEvent = { message: { timestamp: 100 } };
  assert.equal(hasProvableMinimumMessageDelay(commandEvent, { message: { timestamp: 116 } }, 15), true);
  assert.equal(hasProvableMinimumMessageDelay(commandEvent, { message: { timestamp: 115 } }, 15), false);
  assert.equal(hasProvableMinimumMessageDelay(commandEvent, { message: {} }, 15), false);
});

test("captures every attributable reply id before an early failure", () => {
  const ids = new Set();
  const events = [
    { message: { id: 1, content: "wrong" } },
    { message: { id: 2, content: "valid" } },
    { message: { id: 3, content: "unrelated" } },
  ];
  const matches = captureMessageIds(events, (event) => event.message.content !== "unrelated", ids);
  assert.equal(matches.length, 2);
  assert.deepEqual([...ids], ["1", "2"]);
});

test("captures every observed in-run bot message while excluding already deleted messages", () => {
  const dm = (id, content, senderId = Number(BOT_USER_ID)) => ({ type: "message", message: {
    id, type: "private", sender_id: senderId, content, display_recipient: [
      { id: Number(BOT_USER_ID) }, { id: Number(ACTOR_USER_ID) },
    ],
  } });
  const events = [
    dm(1, "malformed extra output"),
    dm(2, "already deleted"),
    dm(3, "other sender", 92),
    { type: "message", message: { id: 4, type: "stream", sender_id: Number(BOT_USER_ID), content: "wrong", display_recipient: "smoke", subject: "run-id-topic" } },
    { type: "message", message: { id: 5, type: "stream", sender_id: Number(BOT_USER_ID), content: "run-id marker", display_recipient: "other", subject: "other" } },
  ];
  const ids = new Set();
  const matches = captureObservedSmokeBotMessageIds(events, {
    botUserId: BOT_USER_ID, actorUserId: ACTOR_USER_ID, stream: "smoke", runId: "run-id",
  }, ids, new Set(["2"]));
  assert.equal(matches.length, 3);
  assert.deepEqual([...ids], ["1", "4", "5"]);
});

test("compares downloaded upload contents as exact UTF-8 bytes", () => {
  const exact = new TextEncoder().encode("marker");
  assert.equal(isExactUtf8(exact, "marker"), true);
  assert.equal(isExactUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, ...exact]), "marker"), false);
  assert.equal(isExactUtf8(Uint8Array.from([...exact, 0x0a]), "marker"), false);
});

test("requires an edited message to remain readable with exact content", async () => {
  const calls = [];
  const client = { request: async (path) => {
    calls.push({ path, at: Date.now() });
    return { message: { content: "<p>after</p>" } };
  } };
  await assertMessageRemainsExact(client, "42", "after", 10);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].at - calls[0].at >= 9, true);
  await assert.rejects(
    assertMessageRemainsExact({ request: async () => ({ message: { content: "wrong" } }) }, "42", "after", 0),
    /not readable/,
  );
});

test("writes exact gateway-generation evidence with private permissions", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "zulip-smoke-generation-"));
  const path = join(stateDir, "generation");
  try {
    await writeGatewayGeneration(path, "abc123");
    assert.equal(await readFile(path, "utf8"), "abc123");
    const { mode } = await stat(path);
    assert.equal(mode & 0o777, 0o600);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("requires the exact child result in an assistant transcript message", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "zulip-smoke-transcript-"));
  const sessionsDir = join(stateDir, "agents", "main", "sessions");
  const marker = "unique-child-result";
  await mkdir(sessionsDir, { recursive: true });
  try {
    await writeFile(join(sessionsDir, "parent.jsonl"), `${JSON.stringify({ message: { role: "assistant", content: [
      { type: "toolCall", arguments: { task: `reply ${marker}` } },
    ] } })}\n`);
    assert.equal(await countCompletedChildTranscripts(stateDir, marker), 0);
    await writeFile(join(sessionsDir, "child.jsonl"), [
      JSON.stringify({ message: { role: "user", content: `[Subagent Task] reply ${marker}` } }),
      "malformed",
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: marker }] } }),
    ].join("\n"));
    assert.equal(await countCompletedChildTranscripts(stateDir, marker), 1);
    assert.deepEqual(await inspectChildTranscripts(stateDir, marker), { total: 1, completedExact: 1 });
    await writeFile(join(sessionsDir, "extra-child.jsonl"), [
      JSON.stringify({ message: { role: "user", content: "[Subagent Task] do unrelated work" } }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "unrelated" }] } }),
    ].join("\n"));
    assert.deepEqual(await inspectChildTranscripts(stateDir, marker), { total: 2, completedExact: 1 });
    await rm(join(sessionsDir, "extra-child.jsonl"));
    await writeFile(join(sessionsDir, "archived-child.jsonl.deleted.2026-08-30T19-00-00.000Z"), [
      JSON.stringify({ message: { role: "user", content: "[Subagent Task] hidden archived work" } }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "archived" }] } }),
    ].join("\n"));
    assert.deepEqual(await inspectChildTranscripts(stateDir, marker), { total: 2, completedExact: 1 });
    await rm(join(sessionsDir, "archived-child.jsonl.deleted.2026-08-30T19-00-00.000Z"));
    await writeFile(join(sessionsDir, "reset-child.jsonl.reset.2026-08-30T19-00-01.000Z"), [
      JSON.stringify({ message: { role: "user", content: "[Subagent Task] hidden reset work" } }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "reset" }] } }),
    ].join("\n"));
    assert.deepEqual(await inspectChildTranscripts(stateDir, marker), { total: 2, completedExact: 1 });
    await rm(join(sessionsDir, "reset-child.jsonl.reset.2026-08-30T19-00-01.000Z"));
    await writeFile(join(sessionsDir, "child.jsonl"), [
      JSON.stringify({ message: { role: "user", content: `[Subagent Task] reply ${marker}` } }),
      JSON.stringify({ message: { role: "assistant", content: [
        { type: "text", text: marker }, { type: "text", text: "WRONG-EXTRA" },
      ] } }),
    ].join("\n"));
    assert.equal(await countCompletedChildTranscripts(stateDir, marker), 0);
    await writeFile(join(sessionsDir, "child.jsonl"), [
      JSON.stringify({ message: { role: "user", content: `[Subagent Task] reply ${marker}` } }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: marker }] } }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "WRONG-LATER" }] } }),
    ].join("\n"));
    assert.equal(await countCompletedChildTranscripts(stateDir, marker), 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("matches only locked OpenClaw session transcript filenames", () => {
  for (const name of [
    "child.jsonl",
    "child.jsonl.deleted.2026-08-30T19-00-00Z",
    "child.jsonl.deleted.2026-08-30T19-00-00.000Z",
    "child.jsonl.reset.2026-08-30T19-00-00.000Z",
  ]) assert.equal(isUsageCountedTranscriptName(name), true, name);
  for (const name of [
    "child.jsonl.deleted.not-a-timestamp",
    "child.jsonl.reset.2026-08-30T19-00-00.000Z.extra",
    "child.jsonl.deleted.2026-08-30T19-00-00.00Z",
    "child.trajectory.jsonl",
    "child.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
  ]) assert.equal(isUsageCountedTranscriptName(name), false, name);
});

test("counts message cleanup failures without skipping later deletions", async () => {
  const attempted = [];
  const client = { request: async (path) => {
    attempted.push(path);
    if (path.endsWith("/2")) throw new Error("synthetic cleanup failure");
  } };
  assert.equal(await countMessageDeletionFailures(client, ["1", "2", "3"]), 1);
  assert.deepEqual(attempted, ["messages/1", "messages/2", "messages/3"]);
});

test("requires lifecycle and subagent reactions to be removed", () => {
  const base = { type: "reaction", message_id: 42, user_id: 7, emoji_name: "robot", emoji_code: "1f916", reaction_type: "unicode_emoji" };
  assert.deepEqual(lifecycleSummary([{ ...base, op: "add" }, { ...base, op: "remove" }], "42"), {
    added: [{ ...base, op: "add" }], allRemoved: true, sawSubagent: true, subagentCount: 1,
  });
  assert.equal(lifecycleSummary([{ ...base, op: "add" }, { ...base, op: "remove" }, { ...base, op: "add" }], "42").allRemoved, false);
  assert.equal(lifecycleSummary([{ ...base, op: "add" }, { ...base, user_id: 8, op: "add" }, { ...base, op: "remove" }], "42").allRemoved, false);
  const terminal = { ...base, emoji_name: "white_check_mark", emoji_code: "2705", op: "add" };
  assert.equal(lifecycleSummary([{ ...base, op: "add" }, { ...base, op: "remove" }, terminal], "42").allRemoved, false);
});

test("requires subagent lifecycle completion before the parent reply", () => {
  const reaction = (id, op) => ({ type: "reaction", message_id: "42", user_id: 7, emoji_name: "robot", emoji_code: "1f916", reaction_type: "unicode_emoji", op, id });
  const reply = { type: "message", id: 3 };
  assert.equal(subagentCompletedBeforeReply([reaction(1, "add"), reaction(2, "remove"), reply], "42", reply), true);
  assert.equal(subagentCompletedBeforeReply([reaction(1, "add"), reply, reaction(3, "remove")], "42", reply), false);
});

test("requires the poll's exact ordered choices and replies", () => {
  const widget = { widget_type: "zform", extra_data: { type: "choices", poll: true, heading: "question", choices: [
    { type: "multiple_choice", short_name: "a", long_name: "a", reply: "a" },
    { type: "multiple_choice", short_name: "b", long_name: "b", reply: "b" },
  ] } };
  assert.equal(isExactPoll(widget, "question", ["a", "b"]), true);
  assert.equal(isExactPoll({ extra_data: widget.extra_data }, "question", ["a", "b"]), false);
  assert.equal(isExactPoll({ ...widget, extra_data: { ...widget.extra_data, type: "buttons" } }, "question", ["a", "b"]), false);
  assert.equal(isExactPoll(widget, "question", ["b", "a"]), false);
  assert.equal(isExactPoll({ extra_data: { ...widget.extra_data, choices: [{ ...widget.extra_data.choices[0], reply: "wrong" }, widget.extra_data.choices[1]] } }, "question", ["a", "b"]), false);
  assert.equal(isExactPollMessage({ content: "<p>question</p>", widget_content: JSON.stringify(widget) }, "question", ["a", "b"]), true);
  assert.equal(isExactPollMessage({ content: "<p>question plus prose</p>", widget_content: widget }, "question", ["a", "b"]), false);
});

test("accepts only a standalone outbound upload without captions or local paths", () => {
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/file.txt">file.txt</a></p>'), "/user_uploads/x/file.txt");
  assert.equal(extractExactUploadUrl("/user_uploads/x/file.txt"), "/user_uploads/x/file.txt");
  assert.equal(extractExactUploadUrl('<p>unrequested prose <a href="/user_uploads/x/file.txt">file.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/file.txt">/tmp/file.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/file.txt">/home/runner/work/repo/file.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/file.txt">%2Froot%2Ffile.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/%252Froot%252Fsecret.txt">%2Froot%2Fsecret.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/%255Chome%255Csecret.txt">%5Chome%5Csecret.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/..%252Fsecret.txt">..%2Fsecret.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/%252Froot%25.txt">%2Froot%.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/..%252Fsecret%25.txt">..%2Fsecret%.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/%255Chome%25ZZ.txt">%5Chome%ZZ.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/file.txt?source=/home/runner/file.txt">/user_uploads/x/file.txt?source=/home/runner/file.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/file.txt#/home/runner/file.txt">/user_uploads/x/file.txt#/home/runner/file.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl("/user_uploads/x/file.txt?source=%252Fhome%252Frunner"), undefined);
  assert.equal(extractExactUploadUrl("/user_uploads/x/%2Froot%2Fsecret.txt"), undefined);
  assert.equal(extractExactUploadUrl("/user_uploads/x/%252Froot%252Fsecret.txt"), undefined);
  assert.equal(extractExactUploadUrl("/user_uploads/x/..%252Fsecret.txt"), undefined);
  assert.equal(extractExactUploadUrl("/user_uploads/x/%255Chome%255Csecret.txt"), undefined);
  assert.equal(extractExactUploadUrl("/user_uploads/x/%2500secret.txt"), undefined);
  assert.equal(extractExactUploadUrl("/user_uploads/x/%ZZ.txt"), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/%ZZ.txt">%ZZ.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/100%.txt">100%.txt</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/file.txt">unrequested prose</a></p>'), undefined);
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/My%20File.txt">My File.txt</a></p>'), "/user_uploads/x/My%20File.txt");
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/file.txt">/user_uploads/x/file.txt</a></p>'), "/user_uploads/x/file.txt");
  assert.equal(extractExactUploadUrl('<p><a href="/user_uploads/x/file.txt">file.txt</a></p><p>extra</p>'), undefined);
});

test("cancels a timed-out event wait", async () => {
  const queue = new EventQueue({ request: async () => ({ events: [] }) });
  const controller = new AbortController();
  const waiting = queue.waitFor(() => false, 10000, "never", controller.signal);
  controller.abort(new Error("scenario timed out"));
  await assert.rejects(waiting, (error) => error.name === "AbortError");
  assert.equal(normalizeScenarioError(controller.signal, new Error("aborted fetch")).message, "scenario timed out");
});

test("coalesces concurrent event polls", async () => {
  let calls = 0;
  let resolveRequest;
  const queue = new EventQueue({ request: () => {
    calls += 1;
    return new Promise((resolve) => { resolveRequest = resolve; });
  }});
  const first = queue.poll();
  const second = queue.poll();
  assert.equal(calls, 1);
  resolveRequest({ events: [{ id: 1, type: "message" }] });
  await Promise.all([first, second]);
  assert.equal(queue.events.length, 1);
});

test("reconciles a placeholder update into cached message matching and cleanup attribution", async () => {
  const messageEvent = { id: 1, type: "message", message: {
    id: 100,
    type: "private",
    sender_id: Number(BOT_USER_ID),
    display_recipient: [{ id: Number(BOT_USER_ID) }, { id: Number(ACTOR_USER_ID) }],
    content: "<p>Thinking…</p>",
  } };
  const updateEvent = {
    id: 2,
    type: "update_message",
    message_id: 100,
    content: "<p>final-marker</p>",
    edit_timestamp: 1_750_000_001,
  };
  const batches = [[messageEvent], [updateEvent]];
  const queue = new EventQueue({ request: async () => ({ events: batches.shift() ?? [] }) });

  await queue.poll();
  assert.equal(messageEvent.message.content, "<p>Thinking…</p>");
  await queue.poll();
  const matched = await queue.waitFor(
    (event) => isPrivateBotMessage(event, BOT_USER_ID, ACTOR_USER_ID, "final-marker"),
    1,
    "updated DM",
  );

  assert.equal(matched, messageEvent);
  assert.equal(messageEvent.message.content, "<p>final-marker</p>");
  assert.equal(messageEvent.message.edit_timestamp, 1_750_000_001);
  assert.equal(queue.events[1], updateEvent);
  const cleanupIds = new Set();
  captureObservedSmokeBotMessageIds(queue.events, {
    botUserId: BOT_USER_ID,
    actorUserId: ACTOR_USER_ID,
    stream: "smoke",
    runId: "run-id",
  }, cleanupIds);
  assert.deepEqual([...cleanupIds], ["100"]);
});

test("does not mutate a cached message for an unrelated update", async () => {
  const messageEvent = { id: 1, type: "message", message: {
    id: 100,
    content: "<p>Thinking…</p>",
  } };
  const updateEvent = {
    id: 2,
    type: "update_message",
    message_id: 999,
    content: "<p>unrelated final</p>",
  };
  const queue = new EventQueue({ request: async () => ({ events: [messageEvent, updateEvent] }) });

  await queue.poll();

  assert.equal(messageEvent.message.content, "<p>Thinking…</p>");
  assert.deepEqual(queue.events, [messageEvent, updateEvent]);
});

test("preserves raw update and delete evidence after reconciling an edit", async () => {
  const messageEvent = { id: 1, type: "message", message: {
    id: 100,
    content: "<p>before-edit</p>",
    subject: "old-topic",
  } };
  const updateEvent = {
    id: 2,
    type: "update_message",
    message_id: 100,
    content: "<p>after-edit</p>",
    subject: "new-topic",
  };
  const deleteEvent = { id: 3, type: "delete_message", message_ids: [100] };
  const queue = new EventQueue({
    request: async () => ({ events: [messageEvent, updateEvent, deleteEvent] }),
  });

  await queue.poll();

  assert.equal(messageEvent.message.content, "<p>after-edit</p>");
  assert.equal(messageEvent.message.subject, "new-topic");
  assert.equal(queue.events.find((event) => event.type === "update_message"), updateEvent);
  assert.equal(queue.events.find((event) => event.type === "delete_message"), deleteEvent);
  assert.equal(queue.events.length, 3);
});

test("waits for gateway exit after escalating to SIGKILL", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") setImmediate(() => { child.exitCode = 137; child.emit("exit", 137); });
    return true;
  };
  const gateway = new Gateway(18789, { termTimeoutMs: 1, killTimeoutMs: 100, healthProbe: async () => false });
  gateway.process = child;
  await Promise.all([gateway.stop(), gateway.stop()]);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(gateway.process, undefined);
});

test("does not begin scenario traffic until gateway startup stabilization finishes", async () => {
  const child = { exitCode: null, signalCode: null };
  let clock = 0;
  let releaseStabilization;
  let stabilizationStarted;
  const stabilization = new Promise((resolve) => { releaseStabilization = resolve; });
  const enteredStabilization = new Promise((resolve) => { stabilizationStarted = resolve; });
  const waits = [];
  const gateway = new Gateway(18789, {
    healthProbe: async () => true,
    startupSettleMs: 250,
    spawnImpl: () => child,
    now: () => clock,
    wait: async (ms, signal) => {
      waits.push(ms);
      signal?.throwIfAborted();
      if (ms === 250) {
        stabilizationStarted();
        await stabilization;
      }
      clock += ms;
      signal?.throwIfAborted();
    },
  });
  let scenarioSendStarted = false;
  const scenario = gateway.start().then(() => { scenarioSendStarted = true; });

  await enteredStabilization;
  assert.equal(scenarioSendStarted, false);
  releaseStabilization();
  await scenario;

  assert.equal(scenarioSendStarted, true);
  assert.deepEqual(waits, [500, 250]);
});

test("fails startup if the gateway exits during stabilization", async () => {
  const child = { exitCode: null, signalCode: null };
  let clock = 0;
  const gateway = new Gateway(18789, {
    healthProbe: async () => true,
    startupSettleMs: 250,
    spawnImpl: () => child,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
      if (ms === 250) child.exitCode = 1;
    },
  });

  await assert.rejects(gateway.start(), /gateway exited during startup stabilization/);
});

test("aborts gateway startup during stabilization", async () => {
  const child = { exitCode: null, signalCode: null };
  const controller = new AbortController();
  const abortReason = new Error("cancel startup");
  let clock = 0;
  const gateway = new Gateway(18789, {
    healthProbe: async () => true,
    startupSettleMs: 250,
    spawnImpl: () => child,
    now: () => clock,
    wait: async (ms, signal) => {
      clock += ms;
      if (ms === 250) controller.abort(abortReason);
      signal?.throwIfAborted();
    },
  });

  await assert.rejects(gateway.start(controller.signal), (error) => error === abortReason);
});

function createDeferredFinalHealthGateway() {
  const child = { exitCode: null, signalCode: null };
  let clock = 0;
  let healthProbeCount = 0;
  let markFinalProbeStarted;
  let resolveFinalProbe;
  const finalProbeStarted = new Promise((resolve) => { markFinalProbeStarted = resolve; });
  const finalProbe = new Promise((resolve) => { resolveFinalProbe = resolve; });
  const gateway = new Gateway(18789, {
    healthProbe: async () => {
      healthProbeCount += 1;
      if (healthProbeCount < 3) return true;
      markFinalProbeStarted();
      return finalProbe;
    },
    startupSettleMs: 250,
    spawnImpl: () => child,
    now: () => clock,
    wait: async (ms, signal) => {
      signal?.throwIfAborted();
      clock += ms;
    },
  });
  return { child, finalProbeStarted, gateway, resolveFinalProbe };
}

test("aborts startup when cancellation arrives during the final health probe", async () => {
  const controller = new AbortController();
  const abortReason = new Error("cancel final probe");
  const { finalProbeStarted, gateway, resolveFinalProbe } = createDeferredFinalHealthGateway();
  const startup = gateway.start(controller.signal);

  await finalProbeStarted;
  controller.abort(abortReason);
  resolveFinalProbe(true);

  await assert.rejects(startup, (error) => error === abortReason);
});

test("fails startup when the gateway exits during the final health probe", async () => {
  const { child, finalProbeStarted, gateway, resolveFinalProbe } =
    createDeferredFinalHealthGateway();
  const startup = gateway.start();

  await finalProbeStarted;
  child.exitCode = 1;
  resolveFinalProbe(true);

  await assert.rejects(startup, /gateway exited during final startup health probe/);
});

test("fails startup when the deferred final health probe is false", async () => {
  const { finalProbeStarted, gateway, resolveFinalProbe } = createDeferredFinalHealthGateway();
  const startup = gateway.start();

  await finalProbeStarted;
  resolveFinalProbe(false);

  await assert.rejects(startup, /gateway became unhealthy during startup stabilization/);
});

test("accepts only HTTP 200 from the runner-local health endpoint without auth", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.writeHead(request.url === "/healthz" ? 200 : 404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(await probeRunnerLocalGatewayHealth(address.port, 1000), true);
    assert.deepEqual(requests, [{ method: "GET", url: "/healthz", authorization: undefined }]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("rejects redirects and other non-200 health responses", async () => {
  const server = createServer((_request, response) => response.writeHead(302, { location: "/healthy" }).end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(await new Gateway(server.address().port).isHealthy(), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("fails closed when the runner-local health connection is refused", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(await probeRunnerLocalGatewayHealth(port, 1000), false);
});

test("aborts a runner-local health request that exceeds its deadline", async () => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const started = Date.now();
    assert.equal(await probeRunnerLocalGatewayHealth(server.address().port, 20), false);
    assert.equal(Date.now() - started < 500, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("treats signal-terminated children as stopped", () => {
  assert.equal(isChildRunning({ exitCode: null, signalCode: "SIGTERM" }), false);
  assert.equal(isChildRunning({ exitCode: null, signalCode: null }), true);
});

test("terminates the complete detached process group", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    await once(child, "message");
    signalProcessTree(child, "SIGTERM");
    assert.equal(await waitForProcessTreeExit(child, 100), false);
    signalProcessTree(child, "SIGKILL");
    assert.equal(await waitForProcessTreeExit(child, 2000), true);
  } finally {
    signalProcessTree(child, "SIGKILL");
  }
});

test("workflow is manual, protected, pinned, and bounded", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/zulip-live-smoke.yml", import.meta.url), "utf8");
  const agentProtocol = await readFile(new URL("./agent-workspace/AGENTS.md", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|\n\s+push:/);
  assert.match(workflow, /environment: zulip-live-smoke/);
  assert.match(workflow, /DISPATCH_REF.*github\.ref/);
  assert.match(workflow, /DISPATCH_REF\" != \"refs\/heads\/main/);
  assert.match(workflow, /merge-base --is-ancestor/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /timeout-minutes: 35/);
  assert.doesNotMatch(workflow, /timeout-minutes: 35\n\s+env:/);
  const prepareStep = workflow.slice(
    workflow.indexOf("- name: Prepare isolated OpenClaw state"),
    workflow.indexOf("- name: Run bounded live scenarios"),
  );
  const liveStep = workflow.slice(
    workflow.indexOf("- name: Run bounded live scenarios"),
    workflow.indexOf("- name: Record release evidence"),
  );
  assert.equal(workflow.match(/secrets\.OPENCLAW_SMOKE_CONFIG_JSON/g)?.length, 1);
  assert.match(prepareStep, /secrets\.OPENCLAW_SMOKE_CONFIG_JSON/);
  for (const secret of ["ZULIP_URL", "ZULIP_SMOKE_USER_EMAIL", "ZULIP_SMOKE_USER_API_KEY", "ZULIP_SMOKE_BOT_EMAIL", "ZULIP_SMOKE_BOT_API_KEY"]) {
    assert.equal(workflow.match(new RegExp(`secrets\\.${secret}`, "g"))?.length, 1);
    assert.match(liveStep, new RegExp(`secrets\\.${secret}`));
    assert.doesNotMatch(prepareStep, new RegExp(`secrets\\.${secret}`));
  }
  assert.match(workflow, /Protected smoke config must disable stream mention gating/);
  assert.match(workflow, /Protected smoke config must use the robot subagent reaction/);
  assert.match(workflow, /reserves robot and tada reactions for exact evidence/);
  assert.match(agentProtocol, /verify\nthat exact result/);
  assert.match(agentProtocol, /\.smoke-gateway-generation/);
  assert.match(agentProtocol, /at least six\nseconds/);
  for (const use of workflow.matchAll(/uses:\s+([^\s]+)/g)) assert.match(use[1], /@[0-9a-f]{40}$/);
});
