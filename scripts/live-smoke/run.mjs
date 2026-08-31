#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
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
  "OPENCLAW_STATE_DIR",
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

export function resolveUploadUrl(baseUrl, uri) {
  const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
  const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
  const rawUri = String(uri ?? "");
  let url;
  if (/^https?:\/\//i.test(rawUri)) {
    url = new URL(rawUri);
  } else if (rawUri.startsWith("/")) {
    const path = basePath && !rawUri.startsWith(`${basePath}/`) ? `${basePath}${rawUri}` : rawUri;
    url = new URL(path, base.origin);
  } else {
    url = new URL(rawUri, base);
  }
  const uploadPrefix = `${basePath}/user_uploads/`;
  if (url.origin !== base.origin || !url.pathname.startsWith(uploadPrefix)) {
    throw new Error("Refusing smoke upload outside the configured Zulip realm");
  }
  return url;
}

export function redactError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/\bBasic\s+\S+/gi, "Basic [redacted]")
    .replace(/([?&](?:api_key|token)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

export function isBotMessage(event, botUserId, marker) {
  if (event?.type !== "message" || !sameUserId(event.message?.sender_id, botUserId)) return false;
  return isExactRenderedContent(event.message?.content, marker);
}

export function isPrivateBotEvent(event, botUserId, actorUserId) {
  if (event?.type !== "message" || event.message?.type !== "private" ||
    !sameUserId(event.message?.sender_id, botUserId)) return false;
  const recipients = Array.isArray(event.message?.display_recipient) ? event.message.display_recipient : [];
  return hasExactDirectParticipants(recipients, botUserId, actorUserId);
}

export function isPrivateBotMessage(event, botUserId, actorUserId, marker) {
  return isPrivateBotEvent(event, botUserId, actorUserId) && isExactRenderedContent(event.message?.content, marker);
}

export function isDurableReplyEvent(event, botUserId, actorUserId, marker) {
  return isPrivateBotEvent(event, botUserId, actorUserId) && String(event.message?.content ?? "").includes(marker);
}

export function eventOccursBefore(events, first, second) {
  const firstIndex = events.indexOf(first);
  const secondIndex = events.indexOf(second);
  return firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex;
}

export function hasProvableMinimumMessageDelay(commandEvent, replyEvent, minimumSeconds) {
  const commandTimestamp = commandEvent?.message?.timestamp;
  const replyTimestamp = replyEvent?.message?.timestamp;
  return Number.isSafeInteger(commandTimestamp) && Number.isSafeInteger(replyTimestamp) &&
    replyTimestamp - commandTimestamp > minimumSeconds;
}

export function captureMessageIds(events, predicate, target) {
  const matches = events.filter(predicate);
  for (const event of matches) {
    if (event.message?.id !== undefined) target.add(String(event.message.id));
  }
  return matches;
}

export function captureObservedSmokeBotMessageIds(events, { botUserId, actorUserId, stream, runId }, target, excluded = new Set()) {
  return captureMessageIds(events, (event) => {
    if (event?.type !== "message" || !sameUserId(event.message?.sender_id, botUserId) || excluded.has(String(event.message?.id))) return false;
    if (isPrivateBotEvent(event, botUserId, actorUserId)) return true;
    const content = String(event.message?.content ?? "");
    return content.includes(runId) || (event.message?.type === "stream" &&
      event.message?.display_recipient === stream && event.message?.subject === `${runId}-topic`);
  }, target);
}

export function isPrivateTypingEvent(event, botUserId, actorUserId, op) {
  if (event?.type !== "typing" || event.op !== op) return false;
  const senderUserId = event.sender?.user_id ?? event.sender?.id ?? event.sender_id;
  if (!sameUserId(senderUserId, botUserId) ||
    (event.message_type && !["direct", "private"].includes(event.message_type))) return false;
  const recipients = Array.isArray(event.recipients) ? event.recipients : [];
  return hasExactDirectParticipants(recipients, botUserId, actorUserId);
}

export function hasFinalPrivateTypingStop(events, botUserId, actorUserId) {
  const lifecycle = events.filter((event) =>
    isPrivateTypingEvent(event, botUserId, actorUserId, "start") ||
    isPrivateTypingEvent(event, botUserId, actorUserId, "stop"));
  return lifecycle.some((event) => event.op === "start") && lifecycle.at(-1)?.op === "stop";
}

export async function drainEventQueueUntilQuiet(queue, signal, quietMs = 500, maxMs = 5000, pollIntervalMs = 100, isComplete = () => true) {
  const deadline = Date.now() + maxMs;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const batch = await queue.poll(signal);
    if (batch.some((event) => event.type !== "heartbeat")) quietSince = Date.now();
    if (Date.now() - quietSince >= quietMs && isComplete()) return;
    await delay(pollIntervalMs, undefined, { signal });
  }
  throw new Error("Event queue did not reach a stable quiet window");
}

export async function assertFinalPrivateTypingStop(queue, eventStart, botUserId, actorUserId, signal, quietMs = 500, maxMs = 5000, pollIntervalMs = 100) {
  await drainEventQueueUntilQuiet(queue, signal, quietMs, maxMs, pollIntervalMs);
  if (!hasFinalPrivateTypingStop(queue.events.slice(eventStart), botUserId, actorUserId)) {
    throw new Error("Final direct typing state was not stopped after lifecycle completion");
  }
}

function userId(value) {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : undefined;
}

function sameUserId(actual, expected) {
  const actualId = userId(actual);
  const expectedId = userId(expected);
  return actualId !== undefined && expectedId !== undefined && actualId === expectedId;
}

export function authenticatedUserId(payload, label = "Zulip identity") {
  const id = userId(payload?.user_id ?? payload?.id);
  if (!id) throw new Error(`${label} did not return a valid user_id`);
  return id;
}

function hasExactDirectParticipants(recipients, botUserId, actorUserId) {
  const expectedBotId = userId(botUserId);
  const expectedActorId = userId(actorUserId);
  const participantIds = recipients.map((recipient) =>
    userId(recipient?.id ?? recipient?.user_id ?? recipient));
  const uniqueIds = new Set(participantIds);
  return recipients.length === 2 && participantIds.every(Boolean) && uniqueIds.size === 2 &&
    uniqueIds.has(expectedBotId) && uniqueIds.has(expectedActorId);
}

export function isExactRenderedContent(content, expected) {
  const rendered = String(content ?? "");
  return rendered === expected || rendered === `<p>${escapeHtml(expected)}</p>`;
}

export function isExactUtf8(bytes, expected) {
  const expectedBytes = new TextEncoder().encode(expected);
  return bytes.length === expectedBytes.length && bytes.every((value, index) => value === expectedBytes[index]);
}

export async function assertMessageRemainsExact(client, id, expected, minimumMs, signal) {
  const assertCurrent = async () => {
    const result = await client.request(`messages/${id}`, { signal });
    if (!isExactRenderedContent(result.message?.content, expected)) {
      throw new Error("Edited message was not readable with its exact content");
    }
  };
  await assertCurrent();
  await delay(minimumMs, undefined, { signal });
  await assertCurrent();
}

export async function countCompletedChildTranscripts(stateDir, marker) {
  return (await inspectChildTranscripts(stateDir, marker)).completedExact;
}

export async function inspectChildTranscripts(stateDir, marker) {
  const files = [];
  const visit = async (directory) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && isUsageCountedTranscriptName(entry.name)) files.push(path);
    }
  };
  await visit(resolve(stateDir, "agents"));
  let total = 0;
  let completedExact = 0;
  for (const file of files) {
    const records = (await readFile(file, "utf8")).split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    if (!records.some(isSubagentTaskRecord)) continue;
    total += 1;
    const results = records.flatMap(assistantMessageTexts);
    if (results.at(-1) === marker) completedExact += 1;
  }
  return { total, completedExact };
}

export function isUsageCountedTranscriptName(name) {
  const stamp = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}(?:\\.\\d{3})?Z";
  if (new RegExp(`\\.jsonl\\.(?:deleted|reset)\\.${stamp}$`).test(name)) return true;
  if (!name.endsWith(".jsonl") || name.endsWith(".trajectory.jsonl")) return false;
  return !/\.checkpoint\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i.test(name);
}

export async function writeGatewayGeneration(path, generation) {
  await writeFile(path, generation, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function countMessageDeletionFailures(client, ids) {
  let failures = 0;
  for (const id of ids) {
    try {
      await client.request(`messages/${id}`, { method: "DELETE" });
    } catch {
      failures += 1;
    }
  }
  return failures;
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
    subagentCount: added.filter((event) => event.emoji_name === "robot" || event.emoji_code === "1f916").length,
  };
}

export function subagentCompletedBeforeReply(events, inboundMessageId, replyEvent) {
  const replyIndex = events.indexOf(replyEvent);
  if (replyIndex < 0) return false;
  const active = new Set();
  let sawSubagent = false;
  for (const event of events.slice(0, replyIndex)) {
    if (event?.type !== "reaction" || String(event.message_id) !== String(inboundMessageId) ||
        (event.emoji_name !== "robot" && event.emoji_code !== "1f916")) continue;
    sawSubagent = true;
    const key = reactionKey(event);
    if (event.op === "add") active.add(key);
    else if (event.op === "remove") active.delete(key);
  }
  return sawSubagent && active.size === 0;
}

export function isExactPoll(widget, question, options) {
  const extra = widget?.extra_data;
  if (widget?.widget_type !== "zform" || extra?.type !== "choices" || extra.poll !== true ||
      extra.heading !== question || !Array.isArray(extra.choices)) return false;
  if (extra.choices.length !== options.length) return false;
  return extra.choices.every((choice, index) => choice?.type === "multiple_choice" &&
    choice.short_name === options[index] && choice.long_name === options[index] && choice.reply === options[index]);
}

export function extractExactUploadUrl(content) {
  const rendered = String(content ?? "");
  const anchor = rendered.match(/^<p><a href="([^"<>]*\/user_uploads\/[^"<>]+)">([^<>]+)<\/a><\/p>$/);
  if (anchor) {
    const href = anchor[1].replaceAll("&amp;", "&");
    const canonical = canonicalUploadUrl(href);
    if (!canonical) return undefined;
    const { basename, decodedBasename } = canonical;
    if (![anchor[1], href, basename, decodedBasename].includes(anchor[2])) return undefined;
    return href;
  }
  const bare = rendered.match(/^((?:https?:\/\/[^\s<>]+)?\/[^\s<>]*user_uploads\/[^\s<>]+)$/);
  const bareUrl = bare?.[1].replaceAll("&amp;", "&");
  return bareUrl && canonicalUploadUrl(bareUrl) ? bareUrl : undefined;
}

function canonicalUploadUrl(href) {
  if (/[?#]/.test(href)) return undefined;
  const basename = href.split("/").at(-1);
  if (!basename) return undefined;
  let decodedBasename = basename;
  let fullyDecodedBasename = basename;
  for (let depth = 0; depth < 100; depth += 1) {
    if (/%(?:2f|5c|00)/i.test(fullyDecodedBasename)) return undefined;
    let decoded;
    try { decoded = decodeURIComponent(fullyDecodedBasename); } catch { return undefined; }
    if (depth === 0) decodedBasename = decoded;
    if (decoded === fullyDecodedBasename) break;
    fullyDecodedBasename = decoded;
    if (depth === 99) return undefined;
  }
  if (/[\\/\0]/.test(fullyDecodedBasename) || /^file:/i.test(fullyDecodedBasename) ||
      fullyDecodedBasename === "." || fullyDecodedBasename === "..") return undefined;
  return { basename, decodedBasename };
}

export function isExactPollMessage(message, question, options) {
  let widget = message?.widget_content;
  if (typeof widget === "string") {
    try { widget = JSON.parse(widget); } catch { return false; }
  }
  return isExactRenderedContent(message?.content, question) && isExactPoll(widget, question, options);
}

export function normalizeScenarioError(signal, error) {
  return signal.aborted && signal.reason instanceof Error ? signal.reason : error;
}

function reactionKey(event) {
  const user = event.user_id ?? event.user?.user_id ?? event.user?.email ?? event.user?.full_name ?? "";
  return `${user}:${event.emoji_name ?? ""}:${event.emoji_code ?? ""}:${event.reaction_type ?? ""}`;
}

function assistantMessageTexts(value) {
  if (!value || typeof value !== "object") return [];
  if (value.role === "assistant") {
    if (typeof value.content === "string") return [value.content];
    if (!Array.isArray(value.content)) return [];
    if (value.content.some((part) => part?.type === "toolCall" || part?.type === "tool_use")) return [];
    const text = value.content.flatMap((part) => {
      if (typeof part === "string") return [part];
      return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
    }).join("");
    return text ? [text] : [];
  }
  return Object.values(value).flatMap(assistantMessageTexts);
}

function isSubagentTaskRecord(value) {
  const message = value?.message;
  if (message?.role !== "user") return false;
  const content = typeof message.content === "string" ? message.content :
    Array.isArray(message.content) ? message.content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("") : "";
  return content.includes("[Subagent Task]");
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
    return resolveUploadUrl(this.baseUrl, payload.uri).href;
  }

  async download(uri, signal) {
    const url = resolveUploadUrl(this.baseUrl, uri);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    const response = await fetch(url, { headers: { Authorization: this.authorization }, signal: requestSignal });
    if (!response.ok) throw new Error(`Zulip download failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export class EventQueue {
  constructor(client) {
    this.client = client;
    this.events = [];
    this.lastEventId = -1;
    this.pollPromise = undefined;
    this.messageEventsById = new Map();
  }
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
        if (event.type === "heartbeat") continue;
        if (event.type === "message" && event.message?.id !== undefined) {
          this.messageEventsById.set(String(event.message.id), event);
        } else if (event.type === "update_message") {
          this.reconcileMessageUpdate(event);
        }
        this.events.push(event);
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
  reconcileMessageUpdate(event) {
    const messageIds = new Set(
      [event.message_id, event.message?.id, ...(Array.isArray(event.message_ids) ? event.message_ids : [])]
        .filter((id) => id !== undefined && id !== null)
        .map(String),
    );
    const fields = [
      "content",
      "subject",
      "topic_links",
      "last_edit_timestamp",
      "edit_timestamp",
      "reactions",
      "flags",
    ];
    for (const messageId of messageIds) {
      const cachedEvent = this.messageEventsById.get(messageId);
      if (!cachedEvent?.message) continue;
      for (const source of [event.message, event]) {
        if (!source || typeof source !== "object") continue;
        for (const field of fields) {
          if (Object.hasOwn(source, field)) cachedEvent.message[field] = source[field];
        }
      }
    }
  }
}

export class Gateway {
  constructor(port, {
    termTimeoutMs = 10000,
    killTimeoutMs = 5000,
    healthProbe,
    healthProbeTimeoutMs = 2000,
    startupSettleMs = 5000,
    startupSettlePollMs = 250,
    spawnImpl = spawn,
    wait = (ms, signal) => delay(ms, undefined, { signal }),
    now = () => Date.now(),
  } = {}) {
    this.port = String(port);
    this.termTimeoutMs = termTimeoutMs;
    this.killTimeoutMs = killTimeoutMs;
    this.healthProbe = healthProbe;
    this.healthProbeTimeoutMs = healthProbeTimeoutMs;
    this.startupSettleMs = startupSettleMs;
    this.startupSettlePollMs = startupSettlePollMs;
    this.spawnImpl = spawnImpl;
    this.wait = wait;
    this.now = now;
  }
  async start(signal) {
    signal?.throwIfAborted();
    if (this.process && isProcessTreeRunning(this.process)) throw new Error("Runner-local OpenClaw gateway is already running");
    this.process = this.spawnImpl("pnpm", ["exec", "openclaw", "gateway", "run", "--bind", "loopback", "--port", this.port, "--auth", "none", "--compact"], {
      cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "ignore"], detached: process.platform !== "win32",
    });
    const child = this.process;
    const deadline = this.now() + 30000;
    while (this.now() < deadline) {
      signal?.throwIfAborted();
      if (!isChildRunning(child)) throw new Error("Runner-local OpenClaw gateway exited during startup");
      if (await this.isHealthy()) {
        await this.wait(500, signal);
        if (!isChildRunning(child)) throw new Error("Runner-local OpenClaw gateway exited during startup");
        if (await this.isHealthy()) {
          await this.waitForStartupStability(child, signal);
          return;
        }
      }
      await this.wait(1000, signal);
    }
    throw new Error("Runner-local OpenClaw gateway did not become healthy within 30s");
  }
  async waitForStartupStability(child, signal) {
    const deadline = this.now() + this.startupSettleMs;
    while (this.now() < deadline) {
      signal?.throwIfAborted();
      if (!isChildRunning(child)) {
        throw new Error("Runner-local OpenClaw gateway exited during startup stabilization");
      }
      await this.wait(Math.min(this.startupSettlePollMs, deadline - this.now()), signal);
    }
    signal?.throwIfAborted();
    if (!isChildRunning(child)) {
      throw new Error("Runner-local OpenClaw gateway exited during startup stabilization");
    }
    const healthy = await this.isHealthy();
    signal?.throwIfAborted();
    if (!isChildRunning(child)) {
      throw new Error("Runner-local OpenClaw gateway exited during final startup health probe");
    }
    if (!healthy) {
      throw new Error("Runner-local OpenClaw gateway became unhealthy during startup stabilization");
    }
  }
  async isHealthy() {
    if (this.healthProbe) return this.healthProbe();
    return probeRunnerLocalGatewayHealth(this.port, this.healthProbeTimeoutMs);
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

export function probeRunnerLocalGatewayHealth(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const probe = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/healthz",
      method: "GET",
      agent: false,
    });
    let response;
    let timeout;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      response?.destroy();
      probe.destroy();
      resolve(value);
    };
    probe.once("response", (incoming) => {
      response = incoming;
      finish(incoming.statusCode === 200);
    });
    probe.once("error", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
    probe.end();
  });
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
  const [actorUserId, botUserId] = await Promise.all([
    actor.request("users/me").then((payload) => authenticatedUserId(payload, "Smoke actor")),
    bot.request("users/me").then((payload) => authenticatedUserId(payload, "Smoke bot")),
  ]);
  if (actorUserId === botUserId) throw new Error("Smoke actor and bot resolved to the same Zulip user_id");
  const queue = new EventQueue(actor);
  const gateway = new Gateway(env.SMOKE_GATEWAY_PORT || 18789);
  const gatewayGenerationPath = resolve("scripts/live-smoke/agent-workspace/.smoke-gateway-generation");
  const messageIds = { actor: new Set(), bot: new Set() };
  const deletedBotMessageIds = new Set();
  const report = [];
  let runError;
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
      const event = await queue.waitFor((e) => isPrivateBotMessage(e, botUserId, actorUserId, marker), timeoutMs, "DM reply", signal);
      messageIds.bot.add(String(event.message.id));
    });

    await scenario("stream-topic-reply", async (signal) => {
      const marker = `${runId}:stream-ok`; const topic = `${runId}-topic`;
      const sent = await actor.request("messages", { method: "POST", body: { type: "stream", to: env.ZULIP_SMOKE_STREAM, topic, content: command(`echo ${marker}`) }, signal });
      messageIds.actor.add(String(sent.id));
      const event = await queue.waitFor((e) => isBotMessage(e, botUserId, marker) && e.message?.display_recipient === env.ZULIP_SMOKE_STREAM && e.message?.subject === topic, timeoutMs, "stream/topic reply", signal);
      messageIds.bot.add(String(event.message.id));
    });

    await scenario("typing-and-lifecycle-reactions", async (signal) => {
      const marker = `${runId}:lifecycle-ok`; const childResult = `${runId}:child-ok`; const eventStart = queue.events.length;
      const inboundId = await sendDm(command(`lifecycle ${marker} ${childResult}`), signal);
      const reply = await queue.waitFor((e) => isPrivateBotMessage(e, botUserId, actorUserId, marker), timeoutMs, "lifecycle reply", signal);
      messageIds.bot.add(String(reply.message.id));
      const deadline = Date.now() + timeoutMs;
      let summary;
      while (Date.now() < deadline) {
        summary = lifecycleSummary(queue.events, inboundId);
        if (summary.allRemoved && summary.sawSubagent) break;
        await queue.poll(signal);
        await delay(500, undefined, { signal });
      }
      const transcriptDeadline = Date.now() + timeoutMs;
      let childTranscripts;
      while (Date.now() < transcriptDeadline && (childTranscripts = await inspectChildTranscripts(env.OPENCLAW_STATE_DIR, childResult)).completedExact === 0) {
        await delay(250, undefined, { signal });
      }
      childTranscripts = await inspectChildTranscripts(env.OPENCLAW_STATE_DIR, childResult);
      if (childTranscripts.total !== 1 || childTranscripts.completedExact !== 1) {
        throw new Error(`Found ${childTranscripts.total} child transcripts and ${childTranscripts.completedExact} exact completed results; expected exactly one of each`);
      }
      await drainEventQueueUntilQuiet(queue, signal, 500, timeoutMs, 100, () =>
        lifecycleSummary(queue.events, inboundId).allRemoved &&
        hasFinalPrivateTypingStop(queue.events.slice(eventStart), botUserId, actorUserId));
      summary = lifecycleSummary(queue.events, inboundId);
      if (!hasFinalPrivateTypingStop(queue.events.slice(eventStart), botUserId, actorUserId)) {
        throw new Error("Final direct typing state was not stopped after lifecycle completion");
      }
      if (!summary.added.length) throw new Error("No lifecycle reaction was observed on the inbound message");
      if (!summary.sawSubagent) throw new Error("No truthful subagent lifecycle reaction was observed");
      if (summary.subagentCount !== 1) throw new Error(`Observed ${summary.subagentCount} subagent lifecycle reactions; expected exactly one`);
      if (!summary.allRemoved) throw new Error("Lifecycle reactions were not cleaned up after completion");
      if (!subagentCompletedBeforeReply(queue.events, inboundId, reply)) {
        throw new Error("The child lifecycle did not complete before the parent reply");
      }
    });

    await scenario("explicit-reaction", async (signal) => {
      const marker = `${runId}:reacted`;
      const inboundId = await sendDm(command(`react 🎉 ${marker}`), signal);
      const reaction = await queue.waitFor((e) => e.type === "reaction" && e.op === "add" && String(e.message_id) === inboundId && (e.emoji_name === "tada" || e.emoji_code === "1f389"), timeoutMs, "explicit reaction", signal);
      const reply = await queue.waitFor((e) => isPrivateBotMessage(e, botUserId, actorUserId, marker), timeoutMs, "reaction acknowledgement", signal);
      messageIds.bot.add(String(reply.message.id));
      if (!eventOccursBefore(queue.events, reaction, reply)) {
        throw new Error("Reaction acknowledgement arrived before the requested reaction");
      }
    });

    await scenario("edit-delete", async (signal) => {
      const before = `${runId}:before-edit`; const after = `${runId}:after-edit`;
      await sendDm(command(`edit-delete ${before} ${after}`), signal);
      const created = await queue.waitFor((e) => isPrivateBotMessage(e, botUserId, actorUserId, before), timeoutMs, "message before edit", signal);
      const id = String(created.message.id); messageIds.bot.add(id);
      await queue.waitFor((e) => e.type === "update_message" && String(e.message_id) === id && isExactRenderedContent(e.content, after), timeoutMs, "message edit", signal);
      await assertMessageRemainsExact(actor, id, after, 4000, signal);
      await queue.waitFor((e) => e.type === "delete_message" && (e.message_ids ?? [e.message_id]).map(String).includes(id), timeoutMs, "message delete", signal);
      messageIds.bot.delete(id); deletedBotMessageIds.add(id);
    });

    await scenario("upload-download", async (signal) => {
      const inboundMarker = `${runId}:inbound-upload`; const uri = await actor.upload(`${runId}.txt`, inboundMarker, signal);
      await sendDm(`${command(`read-upload ${inboundMarker}`)}\n[attachment](${uri})`, signal);
      const inboundReply = await queue.waitFor((e) => isPrivateBotMessage(e, botUserId, actorUserId, inboundMarker), timeoutMs, "inbound upload read", signal);
      messageIds.bot.add(String(inboundReply.message.id));
      const outboundMarker = `${runId}:outbound-upload`; await sendDm(command(`send-upload ${outboundMarker}`), signal);
      const outbound = await queue.waitFor((e) => isPrivateBotEvent(e, botUserId, actorUserId) &&
        Boolean(extractExactUploadUrl(e.message?.content)), timeoutMs, "outbound upload", signal);
      messageIds.bot.add(String(outbound.message.id));
      const uploadUrl = extractExactUploadUrl(outbound.message.content);
      if (!uploadUrl || !isExactUtf8(await actor.download(uploadUrl, signal), outboundMarker)) throw new Error("Downloaded outbound upload did not match its marker");
    });

    await scenario("poll-and-interactive-reply", async (signal) => {
      const question = `${runId}:poll`; const optionA = `smoke-choice:${runId}:interactive-ok`; const optionB = `${runId}:beta`;
      await sendDm(command(`poll ${question} ${optionA} ${optionB}`), signal);
      const poll = await queue.waitFor((e) => {
        if (!isPrivateBotEvent(e, botUserId, actorUserId)) return false;
        return isExactPollMessage(e.message, question, [optionA, optionB]);
      }, timeoutMs, "native poll", signal);
      messageIds.bot.add(String(poll.message.id));
      await sendDm(optionA, signal);
      const reply = await queue.waitFor((e) => isPrivateBotMessage(e, botUserId, actorUserId, `${runId}:interactive-ok`), timeoutMs, "interactive reply", signal);
      messageIds.bot.add(String(reply.message.id));
    });

    await scenario("durable-receive-completion-deduplication", async (signal) => {
      const marker = `${runId}:durable-ok`;
      const isAttributable = (event) =>
        isDurableReplyEvent(event, botUserId, actorUserId, marker);
      const captureReplies = () => captureMessageIds(queue.events, isAttributable, messageIds.bot);
      try {
        const oldGeneration = randomBytes(16).toString("hex");
        await writeGatewayGeneration(gatewayGenerationPath, oldGeneration);
        const inboundId = await sendDm(command(`durable ${marker}`), signal);
        const commandEvent = await queue.waitFor((e) => e.type === "message" &&
          String(e.message?.id) === inboundId && sameUserId(e.message?.sender_id, actorUserId),
        timeoutMs, "durable command event", signal);
        await queue.waitFor((e) => e.type === "reaction" && e.op === "add" && String(e.message_id) === inboundId, timeoutMs, "durable accept signal", signal);
        if (captureReplies().length) {
          throw new Error("Durable reply completed before interruption; replay was not exercised");
        }
        await gateway.stop();
        const replacementGeneration = randomBytes(16).toString("hex");
        await writeGatewayGeneration(gatewayGenerationPath, replacementGeneration);
        await gateway.start(signal);
        const replacementReply = `${marker}:${replacementGeneration}`;
        const reply = await queue.waitFor((e) => {
          if (!isAttributable(e)) return false;
          captureReplies();
          if (!isPrivateBotMessage(e, botUserId, actorUserId, replacementReply)) {
            throw new Error("Durable reply did not contain the replacement gateway generation");
          }
          if (!hasProvableMinimumMessageDelay(commandEvent, e, 15)) {
            throw new Error("Durable reply did not prove the required 15-second delay");
          }
          return true;
        }, timeoutMs, "durable replay reply", signal);
        messageIds.bot.add(String(reply.message.id));
        const settleDeadline = Date.now() + 10000;
        while (Date.now() < settleDeadline) { await queue.poll(signal); await delay(500, undefined, { signal }); }
        const replies = captureReplies();
        const validReplies = replies.filter((e) => isPrivateBotMessage(e, botUserId, actorUserId, replacementReply));
        if (replies.length !== 1 || validReplies.length !== 1) {
          throw new Error(`Durable receive produced ${replies.length} attributable replies (${validReplies.length} valid); expected exactly one valid replacement reply`);
        }
      } finally {
        captureReplies();
      }
    });
  } catch (error) {
    runError = error;
  } finally {
    await gateway.stop().catch(() => {});
    await unlink(gatewayGenerationPath).catch(() => {});
    await queue.poll().catch(() => {});
    captureObservedSmokeBotMessageIds(queue.events, {
      botUserId,
      actorUserId,
      stream: env.ZULIP_SMOKE_STREAM,
      runId,
    }, messageIds.bot, deletedBotMessageIds);
    const cleanupFailures =
      await countMessageDeletionFailures(bot, messageIds.bot) +
      await countMessageDeletionFailures(actor, messageIds.actor);
    await queue.close().catch(() => {});
    for (const item of report) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name} (${item.ms}ms)${item.error ? `: ${item.error}` : ""}`);
    console.log(`Evidence: tested commit ${env.SMOKE_TESTED_SHA}; run identifier ${runId}`);
    console.log(`Cleanup: message deletion failures=${cleanupFailures}; Zulip exposes no public API for deleting uploaded files.`);
    if (cleanupFailures > 0) {
      const cleanupError = new Error(`Cleanup failed for ${cleanupFailures} smoke messages`);
      if (runError) console.error(`Cleanup also failed: ${redactError(cleanupError)}`);
      else throw cleanupError;
    }
  }
  if (runError) throw runError;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Live smoke failed: ${redactError(error)}`); process.exitCode = 1; });
}
