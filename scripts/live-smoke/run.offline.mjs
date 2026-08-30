import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildApiUrl, EventQueue, Gateway, isBotMessage, isChildRunning, isExactPoll, isExactRenderedContent, isExactUtf8, isPrivateBotEvent, isPrivateBotMessage, isPrivateTypingEvent, lifecycleSummary, normalizeScenarioError, redactError, resolveUploadUrl, signalProcessTree, validateEnvironment, waitForProcessTreeExit } from "./run.mjs";

const validEnv = {
  ZULIP_URL: "https://zulip.example.test/path",
  ZULIP_SMOKE_USER_EMAIL: "user@example.test",
  ZULIP_SMOKE_USER_API_KEY: "user-key",
  ZULIP_SMOKE_BOT_EMAIL: "bot@example.test",
  ZULIP_SMOKE_BOT_API_KEY: "bot-key",
  ZULIP_SMOKE_STREAM: "smoke",
  SMOKE_TESTED_SHA: "a".repeat(40),
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
  const event = { type: "message", message: { sender_email: "bot@example.test", content: "marker" } };
  assert.equal(isBotMessage(event, "bot@example.test", "marker"), true);
  assert.equal(isBotMessage({ ...event, message: { ...event.message, content: "<p>marker</p>" } }, "bot@example.test", "marker"), true);
  assert.equal(isBotMessage({ ...event, message: { ...event.message, content: "prefix marker" } }, "bot@example.test", "marker"), false);
  assert.equal(isBotMessage(event, "other@example.test", "marker"), false);
});

test("requires private bot replies with the expected participants", () => {
  const event = { type: "message", message: { type: "private", sender_email: "bot@example.test", content: "marker", display_recipient: [
    { email: "bot@example.test" }, { email: "user@example.test" },
  ] } };
  assert.equal(isPrivateBotMessage(event, "bot@example.test", "user@example.test", "marker"), true);
  assert.equal(isPrivateBotMessage({ ...event, message: { ...event.message, type: "stream" } }, "bot@example.test", "user@example.test", "marker"), false);
  assert.equal(isPrivateBotMessage({ ...event, message: { ...event.message, display_recipient: [{ email: "bot@example.test" }] } }, "bot@example.test", "user@example.test", "marker"), false);
  const uploadEvent = { ...event, message: { ...event.message, content: "[file](/user_uploads/a.txt)" } };
  assert.equal(isPrivateBotEvent(uploadEvent, "bot@example.test", "user@example.test"), true);
  assert.equal(isPrivateBotEvent({ ...uploadEvent, message: { ...uploadEvent.message, type: "stream" } }, "bot@example.test", "user@example.test"), false);
});

test("matches private typing events from the configured bot", () => {
  const event = { type: "typing", op: "start", message_type: "direct", sender: { email: "bot@example.test" }, recipients: [{ email: "user@example.test" }] };
  assert.equal(isPrivateTypingEvent(event, "bot@example.test", "user@example.test", "start"), true);
  assert.equal(isPrivateTypingEvent({ ...event, op: "stop" }, "bot@example.test", "user@example.test", "start"), false);
  assert.equal(isPrivateTypingEvent({ ...event, sender: { email: "other@example.test" } }, "bot@example.test", "user@example.test", "start"), false);
});

test("matches complete raw or Zulip-rendered content", () => {
  assert.equal(isExactRenderedContent("after", "after"), true);
  assert.equal(isExactRenderedContent("<p>after</p>", "after"), true);
  assert.equal(isExactRenderedContent("<p>prefix after suffix</p>", "after"), false);
  assert.equal(isExactRenderedContent(" after ", "after"), false);
  assert.equal(isExactRenderedContent("\n<p>after</p>\n", "after"), false);
});

test("compares downloaded upload contents as exact UTF-8 bytes", () => {
  const exact = new TextEncoder().encode("marker");
  assert.equal(isExactUtf8(exact, "marker"), true);
  assert.equal(isExactUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, ...exact]), "marker"), false);
  assert.equal(isExactUtf8(Uint8Array.from([...exact, 0x0a]), "marker"), false);
});

test("requires lifecycle and subagent reactions to be removed", () => {
  const base = { type: "reaction", message_id: 42, user_id: 7, emoji_name: "robot", emoji_code: "1f916", reaction_type: "unicode_emoji" };
  assert.deepEqual(lifecycleSummary([{ ...base, op: "add" }, { ...base, op: "remove" }], "42"), {
    added: [{ ...base, op: "add" }], allRemoved: true, sawSubagent: true,
  });
  assert.equal(lifecycleSummary([{ ...base, op: "add" }, { ...base, op: "remove" }, { ...base, op: "add" }], "42").allRemoved, false);
  assert.equal(lifecycleSummary([{ ...base, op: "add" }, { ...base, user_id: 8, op: "add" }, { ...base, op: "remove" }], "42").allRemoved, false);
});

test("requires the poll's exact ordered choices and replies", () => {
  const widget = { extra_data: { poll: true, heading: "question", choices: [
    { type: "multiple_choice", short_name: "a", long_name: "a", reply: "a" },
    { type: "multiple_choice", short_name: "b", long_name: "b", reply: "b" },
  ] } };
  assert.equal(isExactPoll(widget, "question", ["a", "b"]), true);
  assert.equal(isExactPoll(widget, "question", ["b", "a"]), false);
  assert.equal(isExactPoll({ extra_data: { ...widget.extra_data, choices: [{ ...widget.extra_data.choices[0], reply: "wrong" }, widget.extra_data.choices[1]] } }, "question", ["a", "b"]), false);
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

test("kills a health probe that exceeds its process deadline", async () => {
  const probe = new EventEmitter();
  probe.exitCode = null;
  probe.signalCode = null;
  probe.kill = (signal) => {
    probe.signalCode = signal;
    setImmediate(() => probe.emit("exit", null, signal));
    return true;
  };
  const gateway = new Gateway(18789, { healthProbeSpawn: () => probe, healthProbeTimeoutMs: 5 });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.equal(await gateway.isHealthy(), false);
    assert.equal(probe.signalCode, "SIGKILL");
  } finally {
    clearInterval(keepAlive);
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
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|\n\s+push:/);
  assert.match(workflow, /environment: zulip-live-smoke/);
  assert.match(workflow, /DISPATCH_REF.*github\.ref/);
  assert.match(workflow, /DISPATCH_REF\" != \"refs\/heads\/main/);
  assert.match(workflow, /merge-base --is-ancestor/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /timeout-minutes: 35/);
  for (const use of workflow.matchAll(/uses:\s+([^\s]+)/g)) assert.match(use[1], /@[0-9a-f]{40}$/);
});
