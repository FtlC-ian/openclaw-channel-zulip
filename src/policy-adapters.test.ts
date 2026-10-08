import { describe, expect, it } from "vitest";
import { resolveGroupAllowFromSources } from "openclaw/plugin-sdk/allow-from";
import type { OpenClawConfig } from "./sdk.js";
import type { ZulipConfig } from "./types.js";
import { zulipPlugin } from "./channel.js";
import { zulipChannelConfigSchema } from "./config-schema.js";
import { normalizeZulipAllowList } from "./policy-config.js";
import { resolveZulipApprovers } from "./approval-auth.js";
import { resolveZulipInboundStreamPolicy } from "./zulip/stream-policy.js";

const config = (zulip: ZulipConfig): OpenClawConfig => ({ channels: { zulip } });
const warnings = (zulip: ZulipConfig) => zulipPlugin.doctor.collectPreviewWarnings!({ cfg: config(zulip), doctorFixCommand: "openclaw doctor --fix" });
async function edit(cfg: OpenClawConfig, scope: "dm" | "group", action: "add" | "remove", entry: string, accountId?: string) {
  const parsedConfig = structuredClone(cfg) as Record<string, unknown>;
  const result = await zulipPlugin.allowlist.applyConfigEdit!({ cfg, parsedConfig, scope, action, entry, accountId });
  expect(zulipChannelConfigSchema.runtime.safeParse((parsedConfig.channels as Record<string, unknown>).zulip).success).toBe(true);
  return { cfg: parsedConfig as OpenClawConfig, result };
}

describe("Zulip doctor contract", () => {
  it("declares nested sender and route policy with the real runtime fallback", () => {
    expect(zulipPlugin.doctor).toMatchObject({ dmAllowFromMode: "topOrNested", groupModel: "hybrid", groupAllowFromFallbackToAllowFrom: true, warnOnEmptyGroupSenderAllowlist: true });
    expect(resolveGroupAllowFromSources({ allowFrom: ["dm@test"], groupAllowFrom: [] })).toEqual(["dm@test"]);
  });
  it("warns about open DMs with an actionable hint", async () => {
    expect(await warnings({ dmPolicy: "open", allowFrom: ["*"], groupPolicy: "disabled" })).toEqual([expect.stringContaining('dmPolicy="open" accepts DMs from anyone. Fix:')]);
  });
  it.each([undefined, []])("warns about empty group senders (%s) and reports fallback truthfully", async (groupAllowFrom) => {
    expect(await warnings({ groupPolicy: "allowlist", streams: ["general"], groupAllowFrom })).toEqual([expect.stringContaining("stream messages are blocked. Fix:")]);
    expect(await warnings({ groupPolicy: "allowlist", streams: ["general"], groupAllowFrom, allowFrom: ["trusted@test"] })).toEqual([expect.stringContaining("stream senders fall back to allowFrom. Fix:")]);
  });
  it.each([undefined, [], ["*"], ["general", " * "]])("warns that stream scope %s means all public streams", async (streams) => {
    expect(await warnings({ groupPolicy: "open", streams })).toEqual([expect.stringContaining("all public streams are monitored, not DM-only. Fix:")]);
    expect(await warnings({ groupPolicy: "disabled", streams })).toEqual([]);
  });
  it("warns about expanding stream overrides", async () => {
    expect(await warnings({ groupPolicy: "open", streams: ["general"], streamOverrides: { "017": { enabled: true } } })).toEqual([expect.stringContaining("enable streams outside streams. Fix:")]);
  });
  it.each([undefined, [], ["*"], [13]])("requires explicit approver emails, not %s", async (allowFrom) => {
    expect(await warnings({ groupPolicy: "disabled", approvalReactions: { approve: "check" }, allowFrom })).toEqual([expect.stringContaining("no explicit allowFrom approver emails")]);
  });
  it("scopes warnings to inherited accounts and keeps root separate from defaultAccount", async () => {
    const result = await warnings({ groupPolicy: "disabled", approvalReactions: { approve: "check" }, defaultAccount: "work", accounts: { work: { allowFrom: ["owner@test"] }, off: { enabled: false } } });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("channels.zulip.approvalReactions");
    expect(await warnings({ enabled: false, dmPolicy: "open", allowFrom: ["*"], accounts: { work: {} } })).toEqual([]);
  });
  it("only repairs exact duplicate sender entries, preserves credentials and every auth boundary, and is idempotent", async () => {
    const cfg = config({ dmPolicy: "open", allowFrom: ["*", " USER:@Owner@Test ", "owner@test", "owner@test"], groupAllowFrom: [" @Member@Test ", "", " @Member@Test "], streams: [], apiKey: { source: "env", provider: "test", id: "TOKEN" }, accounts: { work: { groupAllowFrom: [" USER:Member@Test ", " USER:Member@Test "] } } });
    const original = structuredClone(cfg);
    const repaired = await zulipPlugin.doctor.repairConfig!({ cfg, doctorFixCommand: "openclaw doctor --fix" });
    expect(cfg).toEqual(original);
    const before = cfg.channels!.zulip as ZulipConfig;
    const after = repaired.config.channels!.zulip as ZulipConfig;
    for (const key of ["allowFrom", "groupAllowFrom"] as const) expect(normalizeZulipAllowList(after[key]!)).toEqual(normalizeZulipAllowList(before[key]!));
    expect(after.apiKey).toEqual(before.apiKey);
    expect(after.streams).toEqual([]);
    expect(after.dmPolicy).toBe("open");
    expect(after.accounts!.work.groupAllowFrom).toEqual([" USER:Member@Test "]);
    expect(resolveZulipApprovers(repaired.config)).toEqual(resolveZulipApprovers(cfg));
    expect(repaired.changes).toHaveLength(3);
    expect(zulipChannelConfigSchema.runtime.safeParse(after).success).toBe(true);
    expect((await zulipPlugin.doctor.repairConfig!({ cfg: repaired.config, doctorFixCommand: "openclaw doctor --fix" })).changes).toEqual([]);
  });
});

describe("Zulip allowlist config boundary", () => {
  it.each([undefined, "work"])("round trips DM edits at %s without changing unrelated config", async (accountId) => {
    const cfg = { ...config({ allowFrom: ["root@test"], streams: ["general"], accounts: { work: { name: "Work", apiKey: "secret" }, other: { allowFrom: ["other@test"] } } }), agents: { defaults: { workspace: "/tmp/test" } } };
    const added = await edit(cfg, "dm", "add", " USER:@Owner@Test ", accountId);
    expect(added.result).toMatchObject({ kind: "ok", changed: true, writeTarget: accountId ? { kind: "account", scope: { channelId: "zulip", accountId } } : { kind: "channel" } });
    expect((await zulipPlugin.allowlist.readConfig!({ cfg: added.cfg, accountId })).dmAllowFrom).toEqual(["root@test", "owner@test"]);
    expect((await edit(added.cfg, "dm", "add", "@OWNER@Test", accountId)).result).toMatchObject({ changed: false });
    const removed = await edit(added.cfg, "dm", "remove", "zulip:owner@test", accountId);
    expect((await zulipPlugin.allowlist.readConfig!({ cfg: removed.cfg, accountId })).dmAllowFrom).toEqual(["root@test"]);
    expect(added.cfg.agents).toEqual(cfg.agents);
    const root = added.cfg.channels!.zulip as ZulipConfig;
    expect(root.streams).toEqual(["general"]);
    expect(root.accounts!.other).toEqual({ allowFrom: ["other@test"] });
    expect(root.accounts!.work.apiKey).toBe("secret");
    if (accountId) expect(root.allowFrom).toEqual(["root@test"]);
  });
  it("edits inherited group senders and fails closed when removing the last sender", async () => {
    const cfg = config({ allowFrom: ["dm@test"], groupPolicy: "allowlist", groupAllowFrom: ["group@test"], accounts: { work: {} } });
    const removed = await edit(cfg, "group", "remove", "group@test", "work");
    expect((removed.cfg.channels!.zulip as ZulipConfig).accounts!.work).toEqual({ groupAllowFrom: [], groupPolicy: "disabled" });
    expect((await edit(removed.cfg, "group", "remove", "group@test", "work")).result).toMatchObject({ changed: false });
    expect((cfg.channels!.zulip as ZulipConfig).groupPolicy).toBe("allowlist");
  });
  it("removes fallback group senders without editing the DM list", async () => {
    const removed = await edit(config({ allowFrom: ["dm@test"], groupPolicy: "allowlist" }), "group", "remove", "dm@test");
    expect(removed.cfg.channels!.zulip).toMatchObject({ allowFrom: ["dm@test"], groupAllowFrom: [], groupPolicy: "disabled" });
    expect((await edit(removed.cfg, "group", "remove", "dm@test")).result).toMatchObject({ changed: false });
  });
  it("removing the wildcard from open DMs keeps the schema valid and narrows policy", async () => {
    const removed = await edit(config({ dmPolicy: "open", allowFrom: ["*", "owner@test"] }), "dm", "remove", "*");
    expect(removed.cfg.channels!.zulip).toMatchObject({ dmPolicy: "allowlist", allowFrom: ["owner@test"] });
  });
  it.each([undefined, "work"])("round trips normalized stream overrides at %s, preserving topic rules", async (accountId) => {
    const cfg = config({ streams: ["general"], streamOverrides: { "017": { enabled: false, allowedTopics: ["support"] }, "OTHER": { requireMention: true } }, accounts: { work: {}, other: {} } });
    const added = await edit(cfg, "group", "add", "stream:00017", accountId);
    expect((await zulipPlugin.allowlist.readConfig!({ cfg: added.cfg, accountId })).groupOverrides).toContainEqual({ label: "stream:017 (enabled=true)", entries: ["stream:017"] });
    expect((await edit(added.cfg, "group", "add", "#17", accountId)).result).toMatchObject({ changed: false });
    const removed = await edit(added.cfg, "group", "remove", "stream:17", accountId);
    const account = accountId ? (removed.cfg.channels!.zulip as ZulipConfig).accounts![accountId] : removed.cfg.channels!.zulip as ZulipConfig;
    expect(account.streamOverrides!["017"]).toEqual({ enabled: false, allowedTopics: ["support"] });
    expect(account.streamOverrides!.OTHER).toEqual({ requireMention: true });
    expect(resolveZulipInboundStreamPolicy({ config: { streams: ["general"], ...account }, streamId: "17", streamName: "general" }).enabled).toBe(false);
    expect((await edit(removed.cfg, "group", "remove", "#17", accountId)).result).toMatchObject({ changed: false });
    expect((removed.cfg.channels!.zulip as ZulipConfig).streams).toEqual(["general"]);
  });
  it("normalizes stream names exactly like inbound matching and removes without broadening empty streams", async () => {
    const added = await edit(config({ streams: [] }), "group", "add", "stream: General ");
    const removed = await edit(added.cfg, "group", "remove", "#GENERAL");
    const account = removed.cfg.channels!.zulip as ZulipConfig;
    expect(account.streamOverrides).toEqual({ general: { enabled: false } });
    expect(resolveZulipInboundStreamPolicy({ config: account, streamId: "1", streamName: "General" }).enabled).toBe(false);
    expect(resolveZulipInboundStreamPolicy({ config: account, streamId: "2", streamName: "Other" }).enabled).toBe(true);
  });
  it.each(["", "user:", "stream:", "stream:*", "stream:__proto__"])("rejects invalid entry %s without mutations", async (entry) => {
    const cfg = config({ accounts: { work: {} } });
    const parsedConfig = structuredClone(cfg) as Record<string, unknown>;
    expect(await zulipPlugin.allowlist.applyConfigEdit!({ cfg, parsedConfig, scope: "group", action: "add", entry, accountId: "new" })).toEqual({ kind: "invalid-entry" });
    expect(parsedConfig).toEqual(cfg);
  });
  it("does not create phantom account sections on no-op edits", async () => {
    const cfg = config({ allowFrom: ["owner@test"] });
    const unchanged = await edit(cfg, "dm", "add", "OWNER@test", "work");
    expect(unchanged.result).toMatchObject({ changed: false });
    expect(unchanged.cfg).toEqual(cfg);
  });
});
