import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";

// The shared store belongs to the isolated smoke Gateway. This reader never
// creates or mutates it, and callers only print run-scoped assertions.
export function readZulipBindings(stateDir, { conversationId, targetSessionKey } = {}) {
  const db = new DatabaseSync(join(stateDir, "state", "openclaw.sqlite"), { readOnly: true });
  try {
    const where = ["channel = 'zulip'"];
    const values = [];
    if (conversationId) { where.push("conversation_id = ?"); values.push(conversationId); }
    if (targetSessionKey) { where.push("target_session_key = ?"); values.push(targetSessionKey); }
    return db.prepare(`SELECT binding_id, target_session_key, account_id, conversation_id,
      parent_conversation_id, target_kind, status, bound_at, expires_at, metadata_json
      FROM current_conversation_bindings WHERE ${where.join(" AND ")}`).all(...values);
  } finally {
    db.close();
  }
}

export function renderedText(content) {
  return String(content ?? "").replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").trim();
}

export function parseSpawnReceipt(content) {
  const text = renderedText(content);
  const match = /^✅ Spawned ACP session (agent:codex:acp:\S+) \(persistent, backend acpx\)\. Bound this conversation to (\S+)\.$/.exec(text);
  if (!match || match[1] !== match[2]) throw new Error("Codex ACP spawn did not return a positive current-conversation binding receipt");
  return match[1];
}

function transcriptText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}

function agentIdFromSessionKey(sessionKey) {
  const match = /^agent:([a-z0-9_-]+):/.exec(sessionKey);
  if (!match) throw new Error("Smoke transcript target is not an agent session key");
  return match[1];
}

export function readSessionTranscriptEvidence(stateDir, sessionKey, marker) {
  const agentId = agentIdFromSessionKey(sessionKey);
  const path = join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, {
    readOnly: true,
  });
  try {
    const rows = db.prepare(`SELECT w.session_id, e.seq, e.event_json, e.event_zstd, e.event_utf8_bytes
      FROM session_windows AS w JOIN transcript_events AS e USING (session_id)
      WHERE w.session_key = ? ORDER BY w.created_at, e.seq`).all(sessionKey);
    const candidates = new Map();
    for (const row of rows) {
      let encoded = row.event_json;
      if (encoded === null) {
        const length = Number(row.event_utf8_bytes);
        if (!row.event_zstd || !Number.isSafeInteger(length) || length < 1 || length > 65536) {
          throw new Error("ACP transcript event exceeds the bounded evidence reader");
        }
        const decoded = zstdDecompressSync(Buffer.from(row.event_zstd), { maxOutputLength: length });
        if (decoded.length !== length) throw new Error("ACP transcript event byte length changed during decoding");
        encoded = decoded.toString("utf8");
      }
      const event = JSON.parse(encoded);
      if (event?.type !== "message") continue;
      const content = transcriptText(event.message?.content);
      if (event.message?.role === "user" && content.includes(marker)) {
        candidates.set(row.session_id, row.seq);
      } else if (event.message?.role === "assistant" && content.trim() === marker &&
        candidates.has(row.session_id) && row.seq > candidates.get(row.session_id)) {
        return { sessionId: row.session_id, userSeq: candidates.get(row.session_id), assistantSeq: row.seq };
      }
    }
    return null;
  } finally {
    db.close();
  }
}

export function readOrdinaryTranscriptEvidence(stateDir, conversationId, marker) {
  const agentsPath = join(stateDir, "agents");
  if (!existsSync(agentsPath)) return null;
  for (const entry of readdirSync(agentsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z0-9_-]+$/.test(entry.name)) continue;
    const path = join(agentsPath, entry.name, "agent", "openclaw-agent.sqlite");
    if (!existsSync(path)) continue;
    const db = new DatabaseSync(path, { readOnly: true });
    let keys;
    try {
      keys = db.prepare("SELECT DISTINCT session_key FROM session_windows WHERE session_key LIKE 'agent:%:zulip:%'").all();
    } finally {
      db.close();
    }
    for (const { session_key: key } of keys) {
      if (!key.endsWith(conversationId)) continue;
      const evidence = readSessionTranscriptEvidence(stateDir, key, marker);
      if (evidence) return { ...evidence, sessionKey: key };
    }
  }
  return null;
}

export async function runBindingScenarios({
  env, actor, queue, gateway, scenario, sendDm, messageIds, actorUserId, botUserId,
  isPrivateBotEvent, isExactRenderedContent, command, timeoutMs, runId,
}) {
  const { buildZulipStreamConversation, buildZulipDirectPeerId } =
    await import("../../dist/src/session-conversation.js");
  const streamIdResult = await actor.request("get_stream_id", {
    params: { stream: env.ZULIP_SMOKE_STREAM },
  });
  const streamId = String(streamIdResult.stream_id);
  if (!/^\d+$/.test(streamId) || Number(streamId) <= 0) throw new Error("Smoke stream did not resolve to a numeric ID");
  const initialBindingIds = new Set(readZulipBindings(env.OPENCLAW_STATE_DIR).map((row) => row.binding_id));
  const sessions = new Map();
  const topic = `${runId}-binding`;
  const renamedTopic = `${runId}-binding-renamed`;
  const topicSurface = (name) => ({ kind: "topic", topic: name });
  const dmSurface = { kind: "dm" };
  const mainTopic = topicSurface(topic);
  const renamed = topicSurface(renamedTopic);
  const dmConversationId = buildZulipDirectPeerId({
    baseUrl: env.ZULIP_URL, botIdentity: env.ZULIP_SMOKE_BOT_EMAIL,
    senderIdentity: env.ZULIP_SMOKE_USER_EMAIL,
  });
  const bindingFor = (conversationId) => {
    const rows = readZulipBindings(env.OPENCLAW_STATE_DIR, { conversationId });
    assert.ok(rows.length <= 1, "Multiple current bindings own one conversation");
    return rows[0] ?? null;
  };
  const matchingBot = (event, surface, expectedTopic = surface.topic) => {
    if (event?.type !== "message" || String(event.message?.sender_id) !== String(botUserId)) return false;
    if (surface.kind === "dm") return isPrivateBotEvent(event, botUserId, actorUserId);
    return event.message?.type === "stream" &&
      String(event.message?.stream_id) === streamId &&
      event.message?.subject === expectedTopic;
  };
  const send = async (surface, content, signal) => {
    if (surface.kind === "dm") return sendDm(content, signal);
    const result = await actor.request("messages", { method: "POST", body: {
      type: "stream", to: env.ZULIP_SMOKE_STREAM, topic: surface.topic, content,
    }, signal });
    messageIds.actor.add(String(result.id));
    return String(result.id);
  };
  const sendAndWait = async (surface, content, predicate, label, signal, exactTopic, waitMs = timeoutMs) => {
    const start = queue.events.length;
    await send(surface, content, signal);
    const event = await queue.waitFor((candidate) => {
      if (queue.events.indexOf(candidate) < start || !matchingBot(candidate, surface, exactTopic)) return false;
      const text = renderedText(candidate.message?.content);
      if (/^[⚠❌]/u.test(text)) {
        const reason = /auth|login|credential|unauthorized/i.test(text) ? "harness authentication unavailable"
          : /backend|acpx|runtime/i.test(text) ? "ACP runtime unavailable"
            : /not bound|not currently bound/i.test(text) ? "conversation not bound"
              : "command rejected";
        throw new Error(`${label}: ${reason}`);
      }
      return predicate(text, candidate);
    },
    waitMs, label, signal);
    messageIds.bot.add(String(event.message.id));
    return event;
  };
  const receipt = async (surface, content, pattern, label, signal, waitMs = timeoutMs) => {
    const event = await sendAndWait(surface, content, (text) => pattern.test(text), label, signal, undefined, waitMs);
    return renderedText(event.message.content);
  };
  const trackSpawn = (event, surface) => {
    const provisionalTarget = /^✅ Spawned ACP session (\S+)/.exec(renderedText(event.message.content))?.[1];
    if (provisionalTarget) sessions.set(provisionalTarget, { surface, closed: false });
    return parseSpawnReceipt(event.message.content);
  };
  const spawnBound = async (surface, expectedConversationId, signal) => {
    const event = await sendAndWait(surface, "/acp spawn codex --bind here",
      (text) => text.startsWith("✅ Spawned ACP session "), "ACP spawn receipt", signal);
    const target = trackSpawn(event, surface);
    const rows = readZulipBindings(env.OPENCLAW_STATE_DIR, { targetSessionKey: target });
    assert.equal(rows.length, 1, "Spawned ACP target must own exactly one binding");
    const row = rows[0];
    assert.equal(row.conversation_id, expectedConversationId);
    assert.equal(row.target_kind, "session");
    assert.equal(row.status, "active");
    assert.equal(row.target_session_key, target);
    assert.match(target, /^agent:codex:acp:/);
    return row;
  };
  const waitTranscript = async (lookup, label, signal) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const evidence = lookup();
      if (evidence) return evidence;
      await delay(250, undefined, { signal });
    }
    throw new Error(`${label} was absent from its expected session transcript`);
  };
  const echo = async (surface, marker, expectedTarget, signal, exactTopic) => {
    const prompt = expectedTarget ? `Reply with exactly ${marker}` : command(`echo ${marker}`);
    await sendAndWait(surface, prompt,
      (_text, event) => isExactRenderedContent(event.message?.content, marker),
      "bound marker reply", signal, exactTopic);
    if (expectedTarget) {
      const rows = readZulipBindings(env.OPENCLAW_STATE_DIR, { targetSessionKey: expectedTarget });
      assert.equal(rows.length, 1, "Marker reply lost its ACP binding");
      assert.equal(rows[0].status, "active");
      await waitTranscript(() => readSessionTranscriptEvidence(env.OPENCLAW_STATE_DIR, expectedTarget, marker),
        "Bound ACP marker", signal);
    } else {
      const conversationId = surface.kind === "dm" ? dmConversationId :
        topicConversationId(topicRow.account_id, surface.topic);
      await waitTranscript(() => readOrdinaryTranscriptEvidence(env.OPENCLAW_STATE_DIR, conversationId, marker),
        "Ordinary Zulip marker", signal);
      for (const target of sessions.keys()) {
        assert.equal(readSessionTranscriptEvidence(env.OPENCLAW_STATE_DIR, target, marker), null,
          "Unbound marker was diverted into an ACP session");
      }
    }
  };
  const agents = async (surface, row, signal) => {
    const text = await receipt(surface, "/agents", /^(?:agents:|acp\/session bindings:)/,
      "agents binding report", signal);
    assert.ok(text.includes(`binding:${row.conversation_id}`), "/agents omitted the current conversation binding");
    assert.ok(text.includes(`session:${row.target_session_key}`), "/agents omitted the bound ACP target");
  };
  let topicRow;
  let dmRow;
  let renamedRow;
  const topicConversationId = (accountId, rawTopic) => buildZulipStreamConversation({
    accountId, baseUrl: env.ZULIP_URL, botIdentity: env.ZULIP_SMOKE_BOT_EMAIL,
    streamId, topic: rawTopic,
  }).conversationId;

  const cleanup = async () => {
    const failures = [];
    try {
      for (const row of readZulipBindings(env.OPENCLAW_STATE_DIR)) {
        if (initialBindingIds.has(row.binding_id) || sessions.has(row.target_session_key) ||
          !/^agent:[a-z0-9_-]+:acp:/.test(row.target_session_key)) continue;
        const candidates = [mainTopic, renamed, topicSurface(`${runId}-expiry`)];
        const surface = row.conversation_id === dmConversationId ? dmSurface :
          candidates.find((candidate) => row.conversation_id ===
            topicConversationId(row.account_id, candidate.topic));
        if (surface) sessions.set(row.target_session_key, { surface, closed: false });
      }
    } catch { failures.push("isolated binding store could not be inspected during cleanup"); }
    if (!sessions.size) return failures;
    if (!await gateway.isHealthy()) {
      try { await gateway.restart(); } catch { failures.push("isolated Gateway could not restart for ACP cleanup"); return failures; }
    }
    for (const [target, session] of sessions) {
      if (session.closed) continue;
      try {
        const text = await receipt(session.surface, `/acp close ${target}`,
          /^✅ Closed ACP session /, "ACP cleanup close", undefined, 15000);
        if (!text.includes(target)) throw new Error("ACP cleanup closed a different target");
        session.closed = true;
      } catch {
        failures.push("one test ACP session could not be closed");
      }
    }
    return failures;
  };

  let scenarioFailure;
  try {
    await scenario("binding-acp-readiness", async (signal) => {
      const report = await receipt(dmSurface, "/acp doctor", /^ACP doctor:/,
        "ACP doctor report", signal);
      if (!report.includes("registeredBackend: acpx") ||
        !report.includes("runtimeDoctor: ok") || !report.includes("healthy: yes")) {
        const code = /runtimeDoctorCode: ([A-Z_]+)/.exec(report)?.[1] ?? "unavailable";
        throw new Error(`ACP doctor did not confirm a healthy codex-capable backend (code: ${code})`);
      }
    });

    await scenario("binding-stream-topic", async (signal) => {
      // Use a run-specific topic and verify the host's numeric stream identity.
      const before = readZulipBindings(env.OPENCLAW_STATE_DIR);
      const event = await sendAndWait(mainTopic, "/acp spawn codex --bind here",
        (text) => text.startsWith("✅ Spawned ACP session "), "topic ACP spawn receipt", signal);
      const target = trackSpawn(event, mainTopic);
      const created = readZulipBindings(env.OPENCLAW_STATE_DIR, { targetSessionKey: target });
      assert.equal(created.length, 1);
      topicRow = created[0];
      assert.equal(topicRow.conversation_id, topicConversationId(topicRow.account_id, topic));
      assert.equal(topicRow.parent_conversation_id, streamId);
      assert.equal(topicRow.target_kind, "session");
      assert.equal(topicRow.status, "active");
      assert.match(target, /^agent:codex:acp:/);
      assert.ok(!before.some((row) => row.binding_id === topicRow.binding_id), "Topic reused a preexisting binding");
      await echo(mainTopic, `${runId}:topic-bound`, target, signal);
      await agents(mainTopic, topicRow, signal);
    });

    await scenario("binding-dm-isolation", async (signal) => {
      assert.equal(bindingFor(dmConversationId), null, "DM inherited topic binding");
      dmRow = await spawnBound(dmSurface, dmConversationId, signal);
      assert.notEqual(dmRow.target_session_key, topicRow.target_session_key);
      assert.equal(dmRow.account_id, topicRow.account_id);
      await echo(dmSurface, `${runId}:dm-bound`, dmRow.target_session_key, signal);
      assert.equal(bindingFor(topicRow.conversation_id)?.target_session_key, topicRow.target_session_key);
    });

    await scenario("binding-restart-persistence", async (signal) => {
      const before = bindingFor(topicRow.conversation_id);
      assert.equal(before?.target_session_key, topicRow.target_session_key);
      await gateway.restart(signal);
      const after = bindingFor(topicRow.conversation_id);
      assert.equal(after?.binding_id, before.binding_id);
      assert.equal(after?.target_session_key, before.target_session_key);
      await echo(mainTopic, `${runId}:restart-bound`, topicRow.target_session_key, signal);
    });

    await scenario("binding-lifecycle", async (signal) => {
      await receipt(mainTopic, "/session idle 10m", /^✅ Idle timeout set to 10m for 1 binding/,
        "idle lifecycle receipt", signal);
      await receipt(mainTopic, "/session max-age 20m", /^✅ Max age set to 20m for 1 binding/,
        "max-age lifecycle receipt", signal);
      const row = bindingFor(topicRow.conversation_id);
      const metadata = JSON.parse(row?.metadata_json ?? "{}");
      assert.equal(metadata.zulipIdleTimeoutMs ?? metadata.idleTimeoutMs, 600000);
      assert.equal(metadata.zulipMaxAgeMs ?? metadata.maxAgeMs, 1200000);
      await echo(mainTopic, `${runId}:lifecycle-bound`, topicRow.target_session_key, signal);
    });

    await scenario("binding-new-reset", async (signal) => {
      await receipt(mainTopic, "/new", /^✅ ACP session reset in place\.$/, "bound new receipt", signal);
      assert.equal(bindingFor(topicRow.conversation_id)?.target_session_key, topicRow.target_session_key);
      await echo(mainTopic, `${runId}:after-new`, topicRow.target_session_key, signal);
      await receipt(mainTopic, "/reset", /^✅ ACP session reset in place\.$/, "bound reset receipt", signal);
      assert.equal(bindingFor(topicRow.conversation_id)?.target_session_key, topicRow.target_session_key);
      await echo(mainTopic, `${runId}:after-reset`, topicRow.target_session_key, signal);
    });

    await scenario("binding-topic-identity", async (signal) => {
      const caseTopic = topic.toUpperCase();
      assert.equal(topicConversationId(topicRow.account_id, caseTopic), topicRow.conversation_id);
      const marker = `${runId}:case-bound`;
      const start = queue.events.length;
      const inboundId = await send(topicSurface(caseTopic), `Reply with exactly ${marker}`, signal);
      const inbound = await queue.waitFor((e) => queue.events.indexOf(e) >= start &&
        e?.type === "message" && String(e.message?.id) === inboundId,
      timeoutMs, "case alias inbound", signal);
      const rawTopic = inbound.message.subject;
      const outbound = await queue.waitFor((e) => queue.events.indexOf(e) >= start &&
        matchingBot(e, topicSurface(caseTopic), rawTopic) && isExactRenderedContent(e.message?.content, marker),
      timeoutMs, "case alias bound reply", signal);
      messageIds.bot.add(String(outbound.message.id));
      await waitTranscript(() => readSessionTranscriptEvidence(env.OPENCLAW_STATE_DIR,
        topicRow.target_session_key, marker), "Case alias ACP marker", signal);
      assert.equal(bindingFor(topicRow.conversation_id)?.target_session_key, topicRow.target_session_key);
      const renamedId = topicConversationId(topicRow.account_id, renamedTopic);
      assert.notEqual(renamedId, topicRow.conversation_id);
      assert.equal(bindingFor(renamedId), null, "Substantive topic rename inherited old binding");
      await echo(renamed, `${runId}:renamed-unbound`, null, signal);
      assert.equal(bindingFor(renamedId), null);
      renamedRow = await spawnBound(renamed, renamedId, signal);
      assert.notEqual(renamedRow.target_session_key, topicRow.target_session_key);
      await echo(renamed, `${runId}:renamed-bound`, renamedRow.target_session_key, signal);
    });

    await scenario("binding-concurrency", async (signal) => {
      const markers = [`${runId}:concurrent-a`, `${runId}:concurrent-b`];
      const start = queue.events.length;
      await Promise.all(markers.map((marker) => send(mainTopic, `Reply with exactly ${marker}`, signal)));
      for (const marker of markers) {
        const event = await queue.waitFor((e) => queue.events.indexOf(e) >= start &&
          matchingBot(e, mainTopic) && isExactRenderedContent(e.message?.content, marker),
        timeoutMs, `concurrent bound reply ${marker}`, signal);
        messageIds.bot.add(String(event.message.id));
        await waitTranscript(() => readSessionTranscriptEvidence(env.OPENCLAW_STATE_DIR,
          topicRow.target_session_key, marker), "Concurrent ACP marker", signal);
      }
      assert.equal(bindingFor(topicRow.conversation_id)?.target_session_key, topicRow.target_session_key);
    });

    await scenario("binding-idle-expiry", async (signal) => {
      const surface = topicSurface(`${runId}-expiry`);
      const conversationId = topicConversationId(topicRow.account_id, surface.topic);
      const row = await spawnBound(surface, conversationId, signal);
      await receipt(surface, "/session idle 10s", /^✅ Idle timeout set to <1m for 1 binding/,
        "short idle lifecycle receipt", signal);
      const expiring = bindingFor(conversationId);
      assert.ok(Number(expiring?.expires_at) > Date.now(), "Idle policy did not persist a future expiry");
      await delay(12500, undefined, { signal });
      assert.ok(Number(expiring.expires_at) <= Date.now(), "Idle test did not reach persisted expiry");
      await echo(surface, `${runId}:expired-fallback`, null, signal);
      assert.equal(bindingFor(conversationId), null, "Expired ACP binding remained active");
      assert.equal(row.target_session_key, expiring.target_session_key);
    });

    await scenario("binding-unbind-fallback", async (signal) => {
      await receipt(dmSurface, "/session unbind", /^✅ Conversation unbound\.$/,
        "DM unbind receipt", signal);
      assert.equal(bindingFor(dmConversationId), null);
      await echo(dmSurface, `${runId}:dm-unbound`, null, signal);
      assert.equal(bindingFor(dmConversationId), null);
    });

    await scenario("binding-close-fallback", async (signal) => {
      const text = await receipt(renamed, "/acp close", /^✅ Closed ACP session /,
        "renamed topic ACP close receipt", signal);
      assert.ok(text.includes(renamedRow.target_session_key));
      assert.match(text, /Removed 1 binding\(s\)\./);
      sessions.get(renamedRow.target_session_key).closed = true;
      assert.equal(bindingFor(renamedRow.conversation_id), null);
      await echo(renamed, `${runId}:renamed-unbound-after-close`, null, signal);
      assert.equal(bindingFor(renamedRow.conversation_id), null);
    });

    await scenario("binding-ordinary-fallback", async (signal) => {
      const unboundTopic = topicSurface(`${runId}-ordinary`);
      const unboundId = topicConversationId(topicRow.account_id, unboundTopic.topic);
      assert.equal(bindingFor(unboundId), null);
      await echo(unboundTopic, `${runId}:ordinary-topic`, null, signal);
      await echo(dmSurface, `${runId}:ordinary-dm`, null, signal);
      assert.equal(bindingFor(unboundId), null);
      assert.equal(bindingFor(dmConversationId), null);
    });
  } catch (error) {
    scenarioFailure = error;
    throw error;
  } finally {
    const failures = await cleanup();
    if (failures.length) {
      const message = `Binding cleanup incomplete: ${failures.join("; ")}`;
      if (scenarioFailure) console.error(message);
      else throw new Error(message);
    } else {
      console.log("Binding cleanup: all test ACP sessions closed");
    }
  }
}
