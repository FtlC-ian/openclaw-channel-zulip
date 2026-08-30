#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const REQUIRED_ENV = [
  "ZULIP_URL",
  "ZULIP_SMOKE_USER_EMAIL",
  "ZULIP_SMOKE_USER_API_KEY",
  "ZULIP_SMOKE_BOT_EMAIL",
  "ZULIP_SMOKE_BOT_API_KEY",
  "ZULIP_SMOKE_STREAM",
  "SMOKE_TESTED_SHA",
];

export function validateEnvironment(env) {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing required protected configuration: ${missing.join(", ")}`);
  if (!/^[0-9a-f]{40}$/.test(env.SMOKE_TESTED_SHA)) throw new Error("SMOKE_TESTED_SHA must be a full commit SHA");
  const url = new URL(env.ZULIP_URL);
  if (url.protocol !== "https:") throw new Error("ZULIP_URL must use HTTPS");
  url.search = "";
  url.hash = "";
  return { ...env, ZULIP_URL: url.toString().replace(/\/+$/, "") };
}

export function buildApiUrl(baseUrl, path) {
  return new URL(`${baseUrl.replace(/\/+$/, "")}/api/v1/${path.replace(/^\/+/, "")}`);
}

export function redactError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/\bBasic\s+\S+/gi, "Basic [redacted]")
    .replace(/([?&](?:api_key|token)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

export function isBotMessage(event, botEmail, marker) {
  if (event?.type !== "message" || event.message?.sender_email !== botEmail) return false;
  return isExactRenderedContent(event.message?.content, marker);
}

export function isExactRenderedContent(content, expected) {
  const rendered = String(content ?? "");
  return rendered === expected || rendered === `<p>${escapeHtml(expected)}</p>`;
}

export function isExactUtf8(bytes, expected) {
  const expectedBytes = new TextEncoder().encode(expected);
  return bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
}

export function lifecycleSummary(events, inboundMessageId) {
  const relevant = events.filter((event) =>
    event?.type === "reaction" && String(event.message_id) === String(inboundMessageId),
  );
  const added = [];
  const active = new Set();
  for (const event of relevant) {
    const key = reactionKey(event);
    if (event.op === "add") {
      added.push(event);
      active.add(key);
    } else if (event.op === "remove") {
      active.delete(key);
    }
  }
  return {
    added,
    allRemoved: added.length > 0 && active.size === 0,
    sawSubagent: added.some((event) => event.emoji_name === "robot" || event.emoji_code === "1f916"),
  };
}

export function isExactPoll(widget, question, options) {
  const extra = widget?.extra_data;
  if (extra?.poll !== true || extra.heading !== question || !Array.isArray(extra.choices)) return false;
  if (extra.choices.length !== options.length) return false;
  return extra.choices.every((choice, index) => choice?.type === "multiple_choice" &&
    choice.short_name === options[index] && choice.long_name === options[index] && choice.reply === options[index]);
}

export function normalizeScenarioError(signal, error) {
  return signal.aborted && signal.reason instanceof Error ? signal.reason : error;
}

function reactionKey(event) {
  const user = event.user_id ?? event.user?.user_id ?? event.user?.email ?? event.user?.full_name ?? "";
  return `${user}:${event.emoji_name ?? ""}:${event.emoji_code ?? ""}:${event.reaction_type ?? ""}`;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

class ZulipClient {
  constructor(baseUrl, email, apiKey) {
    this.baseUrl = baseUrl;
    this.authorization = `Basic ${Buffer.from(`${email}:${apiKey}`).toString("base64")}`;
  }

  async request(path, { method = "GET", params, body, signal } = {}) {
    const url = buildApiUrl(this.baseUrl, path);
    if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method,
      headers: { Authorization: this.authorization },
      body: body ? new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.result === "error") throw new Error(`Zulip API ${path} failed (${response.status}): ${payload.code ?? "unknown"}`);
    return payload;
  }

  async upload(filename, contents, signal) {
    const form = new FormData();
    form.set("file", new Blob([contents], { type: "text/plain" }), filename);
    const response = await fetch(buildApiUrl(this.baseUrl, "user_uploads"), {
      method: "POST", headers: { Authorization: this.authorization }, body: form,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.uri) throw new Error(`Zulip upload failed (${response.status})`);
    return payload.uri;
  }

  async download(uri, signal) {
    const url = new URL(uri, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin) throw new Error("Refusing cross-origin smoke upload");
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    const response = await fetch(url, { headers: { Authorization: this.authorization }, signal: requestSignal });
    if (!response.ok) throw new Error(`Zulip download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export class EventQueue {
  constructor(client) { this.client = client; this.events = []; this.lastEventId = -1; this.pollPromise = undefined; }
  async open() {
    const result = await this.client.request("register", { method: "POST", body: {
      event_types: JSON.stringify(["message", "typing", "reaction", "update_message", "delete_message"]),
      all_public_streams: "true",
    }});
    this.queueId = result.queue_id;
    this.lastEventId = result.last_event_id;
  }
  async poll(signal) {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.client.request("events", { params: {
      queue_id: this.queueId, last_event_id: this.lastEventId, dont_block: "true",
    }, signal }).then((result) => {
      for (const event of result.events ?? []) {
        this.lastEventId = Math.max(this.lastEventId, event.id ?? this.lastEventId);
        if (event.type !== "heartbeat") this.events.push(event);
      }
      return result.events ?? [];
    }).finally(() => { this.pollPromise = undefined; });
    return this.pollPromise;
  }
  async waitFor(predicate, timeoutMs, label, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const existing = this.events.find(predicate);
      if (existing) return existing;
      await this.poll(signal);
      await delay(500, undefined, { signal });
    }
    throw new Error(`${label} timed out after ${timeoutMs}ms`);
  }
  async close() {
    if (this.queueId) await this.client.request("events", { method: "DELETE", params: { queue_id: this.queueId } }).catch(() => {});
  }
}

export class Gateway {
  constructor(port, { termTimeoutMs = 10000, killTimeoutMs = 5000, healthProbe } = {}) {
    this.port = String(port);
    this.termTimeoutMs = termTimeoutMs;
    this.killTimeoutMs = killTimeoutMs;
    this.healthProbe = healthProbe;
  }
  async start(signal) {
    signal?.throwIfAborted();
    if (this.process && isProcessTreeRunning(this.process)) throw new Error("Runner-local OpenClaw gateway is already running");
    this.process = spawn("pnpm", ["exec", "openclaw", "gateway", "run", "--bind", "loopback", "--port", this.port, "--auth", "none", "--compact"], {
      cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "ignore"], detached: process.platform !== "win32",
    });
    const child = this.process;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (!isChildRunning(child)) throw new Error("Runner-local OpenClaw gateway exited during startup");
      if (await this.isHealthy()) {
        await delay(500, undefined, { signal });
        if (!isChildRunning(child)) throw new Error("Runner-local OpenClaw gateway exited during startup");
        if (await this.isHealthy()) return;
      }
      await delay(1000, undefined, { signal });
    }
    throw new Error("Runner-local OpenClaw gateway did not become healthy within 30s");
  }
  async isHealthy() {
    if (this.healthProbe) return this.healthProbe();
    return new Promise((resolve) => {
      const probe = spawn("pnpm", ["exec", "openclaw", "gateway", "health", "--port", this.port, "--timeout", "2000"], { stdio: "ignore", env: process.env });
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      probe.once("error", () => finish(false));
      probe.once("exit", (code) => finish(code === 0));
    });
  }
  async waitUntilUnhealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!await this.isHealthy()) return;
      await delay(100);
    }
    throw new Error("Runner-local OpenClaw gateway remained healthy after process shutdown");
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopCurrentProcess().finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }
  async stopCurrentProcess() {
    const child = this.process;
    if (!child || !isProcessTreeRunning(child)) {
      if (this.process === child) this.process = undefined;
      return;
    }
    signalProcessTree(child, "SIGTERM");
    if (!await waitForProcessTreeExit(child, this.termTimeoutMs)) {
      signalProcessTree(child, "SIGKILL");
      if (!await waitForProcessTreeExit(child, this.killTimeoutMs)) {
        throw new Error("Runner-local OpenClaw gateway process group did not exit after SIGKILL");
      }
    }
    await this.waitUntilUnhealthy(this.killTimeoutMs);
    if (this.process === child) this.process = undefined;
  }
  async restart(signal) { await this.stop(); signal?.throwIfAborted(); await this.start(signal); }
}

export function isChildRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function isProcessTreeRunning(child) {
  if (process.platform === "win32" || !child.pid) return isChildRunning(child);
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export function signalProcessTree(child, signal) {
  if (!isProcessTreeRunning(child)) return false;
  if (process.platform === "win32" || !child.pid) return child.kill(signal);
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export async function waitForProcessTreeExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessTreeRunning(child)) return true;
    await delay(25);
  }
  return !isProcessTreeRunning(child);
}

function command(value) { return `SMOKE_COMMAND\n${value}\nEND_SMOKE_COMMAND`; }

async function main() {
  const env = validateEnvironment(process.env);
  const timeoutMs = Number(env.SMOKE_SCENARIO_TIMEOUT_MS || 120000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10000 || timeoutMs > 300000) throw new Error("Invalid SMOKE_SCENARIO_TIMEOUT_MS");
  const runId = `smoke-${env.SMOKE_TESTED_SHA.slice(0, 8)}-${randomBytes(5).toString("hex")}`;
  const actor = new ZulipClient(env.ZULIP_URL, env.ZULIP_SMOKE_USER_EMAIL, env.ZULIP_SMOKE_USER_API_KEY);
  const bot = new ZulipClient(env.ZULIP_URL, env.ZULIP_SMOKE_BOT_EMAIL, env.ZULIP_SMOKE_BOT_API_KEY);
  const queue = new EventQueue(actor);
  const gateway = new Gateway(env.SMOKE_GATEWAY_PORT || 18789);
  const messageIds = { actor: new Set(), bot: new Set() };
  const report = [];
  const sendDm = async (content, signal) => {
    const result = await actor.request("messages", { method: "POST", body: { type: "private", to: JSON.stringify([env.ZULIP_SMOKE_BOT_EMAIL]), content }, signal });
    messageIds.actor.add(String(result.id)); return String(result.id);
  };
  const scenario = async (name, run) => {
    const started = Date.now();
    const controller = new AbortController();
    let timeout;
    try {
      await Promise.race([
        run(controller.signal),
        new Promise((_, reject) => { timeout = setTimeout(() => {
          const error = new Error(`${name} exceeded its scenario timeout`);
          controller.abort(error);
          reject(error);
        }, timeoutMs); }),
      ]);
      report.push({ name, ok: true, ms: Date.now() - started });
    }
    catch (error) {
      const failure = normalizeScenarioError(controller.signal, error);
      report.push({ name, ok: false, ms: Date.now() - started, error: redactError(failure) });
      throw failure;
    }
    finally { clearTimeout(timeout); controller.abort(); }
  };
  try {
    await queue.open();
    await gateway.start();

    await scenario("dm-round-trip", async (signal) => {
      const marker = `${runId}:dm-ok`; await sendDm(command(`echo ${marker}`), signal);
      const event = await queue.waitFor((e) => isBotMessage(e, env.ZULIP_SMOKE_BOT_EMAIL, marker), timeoutMs, "DM reply", signal);
      messageIds.bot.add(String(event.message.id));
    });

    await scenario("stream-topic-reply", async (signal) => {
      const marker = `${runId}:stream-ok`; const topic = `${runId}-topic`;
      const sent = await actor.request("messages", { method: "POST", body: { type: "stream", to: env.ZULIP_SMOKE_STREAM, topic, content: command(`echo ${marker}`) }, signal });
      messageIds.actor.add(String(sent.id));
      const event = await queue.waitFor((e) => isBotMessage(e, env.ZULIP_SMOKE_BOT_EMAIL, marker) && e.message?.display_recipient === env.ZULIP_SMOKE_STREAM && e.message?.subject === topic, timeoutMs, "stream/topic reply", signal);
      messageIds.bot.add(String(event.message.id));
    });

    await scenario("typing-and-lifecycle-reactions", async (signal) => {
      const marker = `${runId}:lifecycle-ok`; const eventStart = queue.events.length;
      const inboundId = await sendDm(command(`lifecycle ${marker}`), signal);
      const reply = await queue.waitFor((e) => isBotMessage(e, env.ZULIP_SMOKE_BOT_EMAIL, marker), timeoutMs, "lifecycle reply", signal);
      messageIds.bot.add(String(reply.message.id));
      await queue.waitFor((e) => queue.events.indexOf(e) >= eventStart && e.type === "typing" && e.op === "stop", timeoutMs, "typing stop cleanup", signal);
      const deadline = Date.now() + timeoutMs;
      let summary;
      while (Date.now() < deadline) {
        summary = lifecycleSummary(queue.events, inboundId);
        if (summary.allRemoved && summary.sawSubagent) break;
        await queue.poll(signal);
        await delay(500, undefined, { signal });
      }
      if (!summary?.added.length) throw new Error("No lifecycle reaction was observed on the inbound message");
      if (!summary.sawSubagent) throw new Error("No truthful subagent lifecycle reaction was observed");
      if (!summary.allRemoved) throw new Error("Lifecycle reactions were not cleaned up after completion");
      const startedTyping = queue.events.slice(eventStart).some((e) => e.type === "typing" && e.op === "start");
      if (!startedTyping) throw new Error("Typing start was not observed");
    });

    await scenario("explicit-reaction", async (signal) => {
      const marker = `${runId}:reacted`;
      const inboundId = await sendDm(command(`react 🎉 ${marker}`), signal);
      await queue.waitFor((e) => e.type === "reaction" && e.op === "add" && String(e.message_id) === inboundId && (e.emoji_name === "tada" || e.emoji_code === "1f389"), timeoutMs, "explicit reaction", signal);
      const reply = await queue.waitFor((e) => isBotMessage(e, env.ZULIP_SMOKE_BOT_EMAIL, marker), timeoutMs, "reaction acknowledgement", signal);
      messageIds.bot.add(String(reply.message.id));
    });

    await scenario("edit-delete", async (signal) => {
      const before = `${runId}:before-edit`; const after = `${runId}:after-edit`;
      await sendDm(command(`edit-delete ${before} ${after}`), signal);
      const created = await queue.waitFor((e) => isBotMessage(e, env.ZULIP_SMOKE_BOT_EMAIL, before), timeoutMs, "message before edit", signal);
      const id = String(created.message.id); messageIds.bot.add(id);
      await queue.waitFor((e) => e.type === "update_message" && String(e.message_id) === id && isExactRenderedContent(e.content, after), timeoutMs, "message edit", signal);
      await queue.waitFor((e) => e.type === "delete_message" && (e.message_ids ?? [e.message_id]).map(String).includes(id), timeoutMs, "message delete", signal);
      messageIds.bot.delete(id);
    });

    await scenario("upload-download", async (signal) => {
      const inboundMarker = `${runId}:inbound-upload`; const uri = await actor.upload(`${runId}.txt`, inboundMarker, signal);
      await sendDm(`${command(`read-upload ${inboundMarker}`)}\n[attachment](${uri})`, signal);
      const inboundReply = await queue.waitFor((e) => isBotMessage(e, env.ZULIP_SMOKE_BOT_EMAIL, inboundMarker), timeoutMs, "inbound upload read", signal);
      messageIds.bot.add(String(inboundReply.message.id));
      const outboundMarker = `${runId}:outbound-upload`; await sendDm(command(`send-upload ${outboundMarker}`), signal);
      const outbound = await queue.waitFor((e) => e.type === "message" && e.message?.sender_email === env.ZULIP_SMOKE_BOT_EMAIL && /user_uploads\//.test(String(e.message?.content ?? "")), timeoutMs, "outbound upload", signal);
      messageIds.bot.add(String(outbound.message.id));
      const match = String(outbound.message.content).match(/(?:href=")?([^"' ]*\/user_uploads\/[^"'< ]+)/);
      if (!match || !isExactUtf8(await actor.download(match[1], signal), outboundMarker)) throw new Error("Downloaded outbound upload did not match its marker");
    });

    await scenario("poll-and-interactive-reply", async (signal) => {
      const question = `${runId}:poll`; const optionA = `smoke-choice:${runId}:interactive-ok`; const optionB = `${runId}:beta`;
      await sendDm(command(`poll ${question} ${optionA} ${optionB}`), signal);
      const poll = await queue.waitFor((e) => {
        if (e.type !== "message" || e.message?.sender_email !== env.ZULIP_SMOKE_BOT_EMAIL) return false;
        const raw = e.message?.widget_content;
        let widget = raw;
        if (typeof raw === "string") { try { widget = JSON.parse(raw); } catch { return false; } }
        return isExactPoll(widget, question, [optionA, optionB]);
      }, timeoutMs, "native poll", signal);
      messageIds.bot.add(String(poll.message.id));
      await sendDm(optionA, signal);
      const reply = await queue.waitFor((e) => isBotMessage(e, env.ZULIP_SMOKE_BOT_EMAIL, `${runId}:interactive-ok`), timeoutMs, "interactive reply", signal);
      messageIds.bot.add(String(reply.message.id));
    });

    await scenario("durable-receive-completion-deduplication", async (signal) => {
      const marker = `${runId}:durable-ok`; const inboundId = await sendDm(command(`durable ${marker}`), signal);
      await queue.waitFor((e) => e.type === "reaction" && e.op === "add" && String(e.message_id) === inboundId, timeoutMs, "durable accept signal", signal);
      if (queue.events.some((e) => isBotMessage(e, env.ZULIP_SMOKE_BOT_EMAIL, marker))) {
        throw new Error("Durable reply completed before interruption; replay was not exercised");
      }
      await gateway.restart(signal);
      const reply = await queue.waitFor((e) => isBotMessage(e, env.ZULIP_SMOKE_BOT_EMAIL, marker), timeoutMs, "durable replay reply", signal);
      messageIds.bot.add(String(reply.message.id));
      const settleDeadline = Date.now() + 10000;
      while (Date.now() < settleDeadline) { await queue.poll(signal); await delay(500, undefined, { signal }); }
      const replies = queue.events.filter((e) => isBotMessage(e, env.ZULIP_SMOKE_BOT_EMAIL, marker));
      if (replies.length !== 1) throw new Error(`Durable receive produced ${replies.length} visible replies; expected exactly one`);
    });
  } finally {
    await gateway.stop().catch(() => {});
    for (const id of messageIds.bot) await bot.request(`messages/${id}`, { method: "DELETE" }).catch(() => {});
    for (const id of messageIds.actor) await actor.request(`messages/${id}`, { method: "DELETE" }).catch(() => {});
    await queue.close().catch(() => {});
    for (const item of report) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name} (${item.ms}ms)${item.error ? `: ${item.error}` : ""}`);
    console.log(`Evidence: tested commit ${env.SMOKE_TESTED_SHA}; run identifier ${runId}`);
    console.log("Cleanup: messages deleted where permissions permit; Zulip exposes no public API for deleting uploaded files.");
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Live smoke failed: ${redactError(error)}`); process.exitCode = 1; });
}
