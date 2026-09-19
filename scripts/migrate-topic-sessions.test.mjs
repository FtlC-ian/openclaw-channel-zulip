import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPlan, createGateway, createPlan, listSessions, main } from "./migrate-topic-sessions.mjs";

const keyHash = (key) => createHash("sha256").update(key).digest("hex");
const row = (suffix, extra = {}) => ({
  key: `agent:alice:zulip:channel:${suffix}`, agentId: "alice", sessionId: `id-${keyHash(suffix)}`,
  kind: "group", channel: "zulip", peerKind: "channel", hasActiveRun: false, ...extra,
});
const stopped = () => ({ channelAccounts: { zulip: [
  { accountId: "default", running: false, connected: false },
  { accountId: "second", running: false, connected: false },
] } });

function fixture(initial, hook = () => {}) {
  const state = { rows: structuredClone(initial), calls: [], status: stopped() };
  state.gateway = async (method, params) => {
    state.calls.push({ method, params: structuredClone(params) });
    await hook(method, params, state);
    if (method === "channels.status") return structuredClone(state.status);
    if (method === "sessions.list") {
      assert.equal(params.archived, "all");
      assert.equal(params.includeDerivedTitles, false);
      assert.equal(params.includeLastMessage, false);
      const matching = state.rows.filter((item) =>
        (!params.search || item.key.includes(params.search)) &&
        (!params.agentId || item.agentId === params.agentId) &&
        (!params.activeOnly || item.hasActiveRun === true));
      const sessions = matching.slice(params.offset, params.offset + Math.min(params.limit, 2));
      const next = params.offset + sessions.length;
      return structuredClone({ sessions, totalCount: matching.length, hasMore: next < matching.length,
        nextOffset: next < matching.length ? next : null });
    }
    assert.equal(method, "sessions.patch", "No other gateway mutations are allowed");
    const target = state.rows.find((item) => item.key === params.key);
    assert.equal(target?.sessionId, params.expectedSessionId, "core expectedSessionId guard");
    if (params.expectedLifecycleRevision) {
      assert.equal(target.lifecycleRevision, params.expectedLifecycleRevision, "core lifecycle guard");
    }
    target.archived = true;
    return { ok: true, key: target.key };
  };
  state.patches = () => state.calls.filter((call) => call.method === "sessions.patch");
  return state;
}

test("preview paginates, selects legacy stream/topic/thread rows, and does not persist text", async () => {
  const items = [row("4"), row("4:topic:secret-topic"), row("5:thread:old")];
  items.push(row(`4:topic:v2:${"a".repeat(64)}`));
  items.push(row("bad", { key: "agent:alice:zulip:default:direct:user@example.test", kind: "direct" }));
  items[0].derivedTitle = "private title";
  items[0].lastMessagePreview = "private message";
  const f = fixture(items);
  const preview = [];
  const plan = await createPlan(f.gateway, (item) => preview.push(item));
  assert.equal(plan.targets.length, 3);
  assert.equal(preview[1].key, items[1].key);
  assert.equal(plan.targets[1].keyHash, keyHash(items[1].key));
  assert.doesNotMatch(JSON.stringify(plan), /secret-topic|private title|private message|@example/);
  assert.deepEqual(f.calls.map((call) => call.params.offset), [0, 2, 4]);
  assert.equal(f.patches().length, 0);
});

test("default command only previews; plan uses 0600 and cannot overwrite a file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zulip-migration-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "plan.json");
  const f = fixture([row("4", { sessionId: "opaque-id" })]);
  await main([], { gateway: f.gateway, log: () => {} });
  await main(["--plan", path], { gateway: f.gateway, log: () => {} });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const original = await readFile(path, "utf8");
  assert.equal(JSON.parse(original).targets.length, 1);
  await assert.rejects(main(["--plan", path], { gateway: f.gateway, log: () => {} }), /EEXIST/);
  assert.equal(await readFile(path, "utf8"), original);
  assert.ok(f.calls.every((call) => call.method === "sessions.list"));
  await assert.rejects(main(["--plan", path, "--apply", path]), /Choose/);
});

test("pagination rejects missing protocol, stalled offsets, duplicates, and unstable totals", async () => {
  const valid = { sessions: [row("4")], totalCount: 2, hasMore: true, nextOffset: 1 };
  for (const page of [
    { sessions: [] }, { ...valid, nextOffset: 0 }, { ...valid, hasMore: false, nextOffset: null },
  ]) {
    await assert.rejects(listSessions(async () => page), /pagination/);
  }
  await assert.rejects(listSessions(async () => valid), /duplicate/);
  let calls = 0;
  await assert.rejects(listSessions(async () => ++calls === 1 ? valid :
    { sessions: [row("5")], totalCount: 3, hasMore: true, nextOffset: 2 }), /changed/);
});

test("unsafe legacy rows and active work fail preview", async () => {
  for (const extra of [
    { isMain: true }, { kind: "direct" }, { chatType: "direct" }, { peerKind: "direct" },
    { channel: "slack" }, { agentId: "bob" }, { sessionId: undefined },
    { classification: "subagent" }, { hasActiveRun: true }, { hasActiveSubagentRun: true },
    { status: "queued" }, { status: "running" }, { activeRunIds: ["run"] },
  ]) {
    const f = fixture([row("4", extra)]);
    await assert.rejects(createPlan(f.gateway), /Refusing|running or queued/);
    assert.equal(f.patches().length, 0);
  }
});

test("apply archives only selected generations, guards revision, and can be reapplied", async () => {
  const untouched = row(`4:topic:v2:${"b".repeat(64)}`);
  const f = fixture([row("4", { lifecycleRevision: "revision-1" }), row("5"), untouched]);
  const plan = await createPlan(f.gateway);
  assert.deepEqual(await applyPlan(f.gateway, plan), { completed: 2 });
  assert.deepEqual(f.patches()[0].params, {
    key: row("4").key, agentId: "alice", archived: true,
    expectedSessionId: row("4").sessionId, expectedLifecycleRevision: "revision-1",
  });
  assert.equal(f.rows[2].archived, undefined);
  assert.equal(f.calls.filter((call) => call.params.activeOnly).length, 2);
  assert.deepEqual(await applyPlan(f.gateway, plan), { completed: 2 });
  assert.equal(f.patches().length, 2);
});

test("forged plans cannot archive main, direct, non-Zulip, or v2 rows", async () => {
  for (const item of [
    row("4", { key: "agent:alice:main", isMain: true }),
    row("4", { key: "agent:alice:zulip:direct:bob", kind: "direct" }),
    row("4", { key: "agent:alice:slack:channel:4", channel: "slack" }),
    row(`4:topic:v2:${"b".repeat(64)}`),
  ]) {
    const f = fixture([item]);
    const plan = { format: "zulip-topic-archive-v1", targets: [
      { keyHash: keyHash(item.key), agentId: "alice", sessionId: item.sessionId },
    ] };
    await assert.rejects(applyPlan(f.gateway, plan), /Refusing|removed or replaced/);
    assert.equal(f.patches().length, 0);
  }
});

test("all targets are checked before the first write", async () => {
  const f = fixture([row("4"), row("5")]);
  const plan = await createPlan(f.gateway);
  f.rows[1].sessionId = "replacement";
  await assert.rejects(applyPlan(f.gateway, plan), /removed or replaced.*\nConfirmed 0\/2/);
  assert.equal(f.patches().length, 0);
});

test("every configured Zulip account must explicitly be stopped with complete status", async () => {
  const f = fixture([row("4")]);
  const plan = await createPlan(f.gateway);
  const online = stopped();
  online.channelAccounts.zulip[1].running = true;
  const connected = stopped();
  connected.channelAccounts.zulip[0].connected = true;
  for (const status of [online, connected, {}, { channelAccounts: { zulip: [] } },
    { ...stopped(), partial: true }, { channelAccounts: { zulip: [{ accountId: "default" }] } }]) {
    f.status = status;
    await assert.rejects(applyPlan(f.gateway, plan), /Cannot verify all Zulip accounts/);
    assert.equal(f.patches().length, 0);
  }
});

test("a channel restart or session replacement after preflight stops before mutation", async () => {
  for (const change of ["restart", "replace"]) {
    let statusCalls = 0;
    const f = fixture([row("4")], (method, _params, state) => {
      if (method === "channels.status" && ++statusCalls === 2) {
        if (change === "restart") state.status.channelAccounts.zulip[0].running = true;
        else state.rows[0].sessionId = "replacement";
      }
    });
    await assert.rejects(applyPlan(f.gateway, await createPlan(f.gateway)), /Cannot verify|removed or replaced/);
    assert.equal(f.patches().length, 0);
  }
});

test("activeOnly is checked immediately before archiving", async () => {
  const f = fixture([row("4")], (method, params, state) => {
    if (method === "sessions.list" && params.activeOnly) state.rows[0].hasActiveRun = true;
  });
  await assert.rejects(applyPlan(f.gateway, await createPlan(f.gateway)), /became active/);
  assert.equal(f.patches().length, 0);
});

test("an uncertain successful write resumes without archiving the row twice", async () => {
  const f = fixture([row("4"), row("5")]);
  const plan = await createPlan(f.gateway);
  let interrupted = false;
  const gateway = async (method, params) => {
    const result = await f.gateway(method, params);
    if (method === "sessions.patch" && !interrupted) {
      interrupted = true;
      throw new Error("synthetic lost response");
    }
    return result;
  };
  await assert.rejects(applyPlan(gateway, plan), /Confirmed 0\/2.*Keep Zulip stopped/s);
  assert.equal(f.rows[0].archived, true);
  assert.deepEqual(await applyPlan(gateway, plan), { completed: 2 });
  assert.equal(f.patches().length, 2);
});

test("core generation guard rejects replacement between the read and patch", async () => {
  const f = fixture([row("4")], (method, _params, state) => {
    if (method === "sessions.patch") state.rows[0].sessionId = "replacement";
  });
  await assert.rejects(applyPlan(f.gateway, await createPlan(f.gateway)), /expectedSessionId guard/);
  assert.equal(f.rows[0].archived, undefined);
});

test("CLI adapter passes literal arguments and suppresses raw child errors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zulip-migration-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-openclaw");
  await writeFile(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({args: process.argv.slice(2)}));\n`, { mode: 0o700 });
  const params = { key: "literal $(pwd) `pwd` ; & value" };
  const result = await createGateway(executable)("sessions.patch", params);
  assert.deepEqual(result.args, ["gateway", "call", "sessions.patch", "--params", JSON.stringify(params),
    "--json", "--timeout", "30000"]);
  await writeFile(executable, `#!${process.execPath}\nconsole.error("synthetic-private-token"); process.exit(1);\n`);
  await assert.rejects(createGateway(executable)("sessions.list", {}), (error) => {
    assert.match(error.message, /failed or timed out/);
    assert.doesNotMatch(error.message, /synthetic-private-token/);
    return true;
  });
});
