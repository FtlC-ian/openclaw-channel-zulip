import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk";

const INBOUND_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepDir: string | null = null;

type Logger = (msg: string) => void;

export function startInboundMediaSweep(log: Logger): void {
  if (sweepTimer) return;
  sweepDir = resolvePreferredOpenClawTmpDir();
  sweepTimer = setInterval(() => sweepExpiredMedia(log), SWEEP_INTERVAL_MS);
  // Don't prevent process exit
  if (sweepTimer && typeof sweepTimer === "object" && "unref" in sweepTimer) {
    (sweepTimer as NodeJS.Timeout).unref();
  }
}

export function stopInboundMediaSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

async function sweepExpiredMedia(log: Logger): Promise<void> {
  if (!sweepDir) return;
  let entries: string[];
  try {
    entries = await fs.readdir(sweepDir);
  } catch {
    return;
  }

  const now = Date.now();
  let swept = 0;

  for (const entry of entries) {
    if (!entry.startsWith("zulip-upload-")) continue;
    const dirPath = path.join(sweepDir, entry);

    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;

      // Check .timestamp file first, fall back to mtime
      let age: number;
      const tsFile = path.join(dirPath, ".timestamp");
      try {
        const tsValue = Number(await fs.readFile(tsFile, "utf8"));
        age = Number.isFinite(tsValue) && tsValue > 1_000_000_000_000 ? now - tsValue : 0;
      } catch {
        age = now - stat.mtimeMs;
      }

      if (age >= INBOUND_TTL_MS) {
        await fs.rm(dirPath, { recursive: true });
        swept++;
      }
    } catch {
      continue;
    }
  }

  if (swept > 0) {
    log(`zulip: inbound media sweep removed ${swept} expired director${swept === 1 ? "y" : "ies"}`);
  }
}

/** Write a timestamp marker in a directory for TTL tracking. */
export async function markMediaTimestamp(dirPath: string): Promise<void> {
  try {
    await fs.writeFile(path.join(dirPath, ".timestamp"), String(Date.now()));
  } catch {
    // ignore -- sweep will fall back to mtime
  }
}
