#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FORMAT = "zulip-topic-archive-v1";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const nonempty = (value) => typeof value === "string" && value.length > 0;
const legacyKey = /^agent:([^:]+):zulip:(?:channel|group):[^:]+(?::(?:topic|thread):[^:]+)?$/;

export function createGateway(executable = "openclaw") {
  return async (method, params) => {
    let stdout;
    try {
      ({ stdout } = await execFileAsync(executable, [
        "gateway", "call", method, "--params", JSON.stringify(params), "--json",
        "--timeout", "30000",
      ], { timeout: 40_000, maxBuffer: 16 * 1024 * 1024 }));
    } catch {
      throw new Error(`${method} failed or timed out. Check gateway connectivity and operator permissions; the result may be uncertain.`);
    }
    try {
      const result = JSON.parse(stdout);
      if (!result || typeof result !== "object" || result.ok === false || result.success === false) {
        throw new Error("failed response");
      }
      return result;
    } catch {
      throw new Error(`${method} did not return a successful JSON result. Requires OpenClaw 2026.9.3 or newer.`);
    }
  };
}

export async function listSessions(gateway, filter = {}) {
  const rows = new Map();
  let total;
  let offset = 0;
  for (;;) {
    const page = await gateway("sessions.list", {
      archived: "all", includeGlobal: true, includeUnknown: true,
      configuredAgentsOnly: false, includeDerivedTitles: false, includeLastMessage: false,
      ownerFirst: false, search: ":zulip:", ...filter, limit: 200, offset,
    });
    if (!Array.isArray(page.sessions) || !Number.isSafeInteger(page.totalCount) ||
        page.totalCount < 0 || typeof page.hasMore !== "boolean" ||
        (total !== undefined && page.totalCount !== total)) {
      throw new Error("Session pagination is unsupported or changed during the scan. Keep Zulip stopped and retry.");
    }
    total = page.totalCount;
    for (const row of page.sessions) {
      if (!row || !nonempty(row.key) || rows.has(row.key)) {
        throw new Error("Session pagination returned an invalid or duplicate key. Retry the scan.");
      }
      rows.set(row.key, row);
    }
    if (!page.hasMore) {
      if (page.nextOffset !== null || rows.size !== total) {
        throw new Error("Session pagination was incomplete. Retry the scan.");
      }
      return [...rows.values()];
    }
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset !== offset + page.sessions.length ||
        page.nextOffset <= offset || page.nextOffset >= total) {
      throw new Error("Session pagination did not advance correctly.");
    }
    offset = page.nextOffset;
  }
}

function isActive(row) {
  return row.hasActiveRun === true || row.hasActiveSubagentRun === true ||
    row.status === "running" || row.status === "queued" ||
    (Array.isArray(row.activeRunIds) && row.activeRunIds.length > 0);
}

function assertLegacy(row) {
  const match = legacyKey.exec(row.key);
  if (!match || row.isMain === true || row.kind !== "group" ||
      (row.channel !== undefined && row.channel !== "zulip") ||
      ["main", "direct", "global", "subagent", "cron"].includes(row.classification) ||
      row.peerKind === "direct" || row.chatType === "direct" ||
      (row.agentId !== undefined && row.agentId !== match[1]) || !nonempty(row.sessionId)) {
    throw new Error(`Refusing unsafe or unidentified legacy row ${hash(row.key)}.`);
  }
  if (isActive(row)) {
    throw new Error(`Legacy row ${hash(row.key)} has running or queued work. Wait for it to finish and retry.`);
  }
  return match[1];
}

export async function createPlan(gateway, report = () => {}) {
  const rows = await listSessions(gateway);
  const targets = [];
  for (const row of rows) {
    if (!legacyKey.test(row.key)) continue;
    const agentId = assertLegacy(row);
    const target = {
      keyHash: hash(row.key), agentId, sessionId: row.sessionId,
      ...(nonempty(row.lifecycleRevision) ? { lifecycleRevision: row.lifecycleRevision } : {}),
    };
    targets.push(target);
    report({ key: row.key, ...target, archived: row.archived === true });
  }
  return { format: FORMAT, createdAt: new Date().toISOString(), targets };
}

function validatePlan(plan) {
  if (!plan || plan.format !== FORMAT || !Array.isArray(plan.targets)) {
    throw new Error("Not a Zulip topic archive plan.");
  }
  const seen = new Set();
  for (const target of plan.targets) {
    if (!target || !/^[a-f0-9]{64}$/.test(target.keyHash) ||
        !nonempty(target.agentId) || !nonempty(target.sessionId) ||
        (target.lifecycleRevision !== undefined && !nonempty(target.lifecycleRevision)) ||
        seen.has(target.keyHash)) {
      throw new Error("Invalid or duplicate target in archive plan.");
    }
    seen.add(target.keyHash);
  }
}

export async function assertZulipStopped(gateway) {
  const status = await gateway("channels.status", { channel: "zulip", probe: false });
  const accounts = status.channelAccounts?.zulip;
  if (status.partial === true || !Array.isArray(accounts) || accounts.length === 0 ||
      accounts.some((account) => !account || !nonempty(account.accountId) ||
        account.running !== false || account.connected !== false)) {
    throw new Error("Cannot verify all Zulip accounts are stopped. Stop Zulip through OpenClaw, leave the gateway running, and retry.");
  }
}

function verifyTarget(target, row) {
  if (!row || hash(row.key) !== target.keyHash || assertLegacy(row) !== target.agentId ||
      row.sessionId !== target.sessionId ||
      (target.lifecycleRevision !== undefined && row.lifecycleRevision !== target.lifecycleRevision)) {
    throw new Error(`Legacy row ${target.keyHash} was removed or replaced. Preview a new plan before continuing.`);
  }
}

export async function applyPlan(gateway, plan, report = () => {}) {
  validatePlan(plan);
  let completed = 0;
  try {
    await assertZulipStopped(gateway);
    const rows = new Map((await listSessions(gateway)).map((row) => [hash(row.key), row]));
    // Validate the whole selection before the first mutation; later reads guard each write.
    for (const target of plan.targets) verifyTarget(target, rows.get(target.keyHash));
    for (const target of plan.targets) {
      const key = rows.get(target.keyHash).key;
      const filter = { agentId: target.agentId, search: key };
      await assertZulipStopped(gateway);
      const row = (await listSessions(gateway, filter)).find((candidate) => candidate.key === key);
      verifyTarget(target, row);
      if (row.archived === true) {
        completed++;
        report({ keyHash: target.keyHash, result: "already-archived" });
        continue;
      }
      const active = await listSessions(gateway, { ...filter, activeOnly: true });
      if (active.some((candidate) => candidate.key === key)) {
        throw new Error(`Legacy row ${target.keyHash} became active. Wait for it to finish and retry.`);
      }
      await gateway("sessions.patch", {
        key, agentId: target.agentId, archived: true, expectedSessionId: target.sessionId,
        ...(target.lifecycleRevision ? { expectedLifecycleRevision: target.lifecycleRevision } : {}),
      });
      const archived = (await listSessions(gateway, filter)).find((candidate) => candidate.key === key);
      verifyTarget(target, archived);
      if (archived.archived !== true) throw new Error(`Archive of ${target.keyHash} was not confirmed.`);
      completed++;
      report({ keyHash: target.keyHash, result: "archived" });
    }
    await assertZulipStopped(gateway);
    return { completed };
  } catch (error) {
    throw new Error(`${error.message}\nConfirmed ${completed}/${plan.targets.length} rows. Keep Zulip stopped; nothing will restart automatically. After resolving the error, rerun --apply with the same plan. Already archived matching generations are skipped; replaced rows require a new plan.`);
  }
}

export async function main(args, { gateway, log = console.log } = {}) {
  let planPath;
  let applyPath;
  let executable = "openclaw";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") {
      log("Usage: node scripts/migrate-topic-sessions.mjs [--plan PATH | --apply PATH] [--openclaw EXECUTABLE]\nWithout --apply, only previews legacy Zulip rows. Plans are created exclusively with mode 0600.");
      return;
    }
    if (!["--plan", "--apply", "--openclaw"].includes(arg) || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(`Unknown option or missing value: ${arg}`);
    }
    const value = args[++i];
    if (arg === "--plan") planPath = value;
    if (arg === "--apply") applyPath = value;
    if (arg === "--openclaw") executable = value;
  }
  if (planPath && applyPath) throw new Error("Choose --plan or --apply, not both.");
  const call = gateway ?? createGateway(executable);
  if (applyPath) {
    const plan = JSON.parse(await readFile(applyPath, "utf8"));
    const result = await applyPlan(call, plan, (entry) => log(JSON.stringify(entry)));
    log(`Confirmed ${result.completed} legacy archives. Zulip remains stopped; install/enable v2 before restarting it.`);
  } else {
    const plan = await createPlan(call, (entry) => log(JSON.stringify(entry)));
    if (planPath) await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    log(`Previewed ${plan.targets.length} legacy rows. No gateway changes.${planPath ? " Plan saved; review before --apply." : " Use --plan PATH to save this selection."}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
