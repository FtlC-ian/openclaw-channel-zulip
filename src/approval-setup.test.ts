import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./sdk.js";
import { zulipPlugin } from "./channel.js";
import { resolveZulipAccount } from "./zulip/accounts.js";

const run = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./lifecycle.js", () => ({ runZulipAccount: run, stopZulipAccount: vi.fn(), zulipLifecycle: {} }));
vi.mock("./zulip/probe.js", () => ({ probeZulip: vi.fn(async () => ({ ok: true })) }));

function fixture(): OpenClawConfig {
  return {
    agents: { ownership: "explicit", entries: {
      rex: { model: "anthropic/claude-test" }, other: { model: "openai/test" },
    }, defaults: { models: { "anthropic/claude-test": { agentRuntime: { id: "claude-cli" } } } } },
    bindings: [{ agentId: "rex", match: { channel: "zulip", accountId: "work" } }],
    channels: { zulip: { groupPolicy: "disabled", allowFrom: ["owner@test"], accounts: { work: {} } } },
    tools: { exec: { mode: "ask" } },
  };
}
async function warnings(cfg: OpenClawConfig) {
  return await zulipPlugin.doctor.collectPreviewWarnings!({ cfg, doctorFixCommand: "openclaw doctor --fix" });
}
const cli = (messages: string[]) => messages.filter((message) => message.includes('agent "rex"'));
const approvers = (messages: string[]) => messages.filter((message) => message.includes("no explicit allowFrom approver emails"));

describe("approval setup doctor boundary", () => {
  it.each([undefined, { enabled: false }, { enabled: true, mode: "targets" as const, targets: [{ channel: "discord", to: "42" }] },
    { enabled: true, agentFilter: ["other"] }, { enabled: true, sessionFilter: ["discord"] }])("warns about unavailable or restricted forwarding %j", async (exec) => {
    const cfg = fixture();
    cfg.approvals = { exec };
    const messages = cli(await warnings(cfg));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("channels.zulip.accounts.work");
    expect(messages[0]).toContain("claude-cli");
    expect(messages[0]).toContain("Fix: set approvals.exec");
    expect(messages[0]).toContain('"mode": "session"');
  });
  it.each([{}, { mode: "session" as const }, { mode: "both" as const },
    { mode: "targets" as const, targets: [{ channel: "zulip", to: "stream:4", accountId: "work" }] }])("accepts supported forwarding destinations %j", async (exec) => {
    const cfg = fixture(); cfg.approvals = { exec: { enabled: true, ...exec } };
    expect(cli(await warnings(cfg))).toEqual([]);
  });
  it.each(["deny"] as const)("does not warn when exec mode is %s", async (mode) => {
    const cfg = fixture(); cfg.tools!.exec!.mode = mode;
    expect(cli(await warnings(cfg))).toEqual([]);
    cfg.tools!.exec!.mode = "ask"; cfg.agents!.entries!.rex.tools = { exec: { mode } };
    expect(cli(await warnings(cfg))).toEqual([]);
  });
  it("warns conservatively when exec policy is absent", async () => {
    const cfg = fixture(); delete cfg.tools;
    expect(cli(await warnings(cfg))[0]).toContain("if exec approval is required");
    cfg.tools = { exec: { mode: "full" } };
    expect(cli(await warnings(cfg))).toHaveLength(1);
  });
  it("detects a CLI fallback without claiming it is the running primary", async () => {
    const cfg = fixture(); cfg.agents!.entries!.rex.model = { primary: "openai/test", fallbacks: ["anthropic/claude-test"] };
    expect(cli(await warnings(cfg))[0]).toContain("fallback model on claude-cli");
    cfg.agents!.entries!.rex.model.fallbacks = [];
    expect(cli(await warnings(cfg))).toEqual([]);
  });
  it.each(["openclaw", "codex", "unknown-cli"])("does not infer a blocking CLI from runtime name %s", async (id) => {
    const cfg = fixture(); cfg.agents!.entries!.rex.models = { "anthropic/claude-test": { agentRuntime: { id } } };
    expect(cli(await warnings(cfg))).toEqual([]);
  });
  it("resolves provider runtime and per-agent overrides", async () => {
    const cfg = fixture(); delete cfg.agents!.defaults!.models;
    cfg.models = { providers: { anthropic: { baseUrl: "https://example.test", models: [], agentRuntime: { id: "claude-cli" } } } };
    expect(cli(await warnings(cfg))).toHaveLength(1);
    cfg.agents!.entries!.rex.models = { "anthropic/claude-test": { agentRuntime: { id: "openclaw" } } };
    expect(cli(await warnings(cfg))).toEqual([]);
  });
  it("parses configured aliases and inherited primary through the public SDK", async () => {
    const cfg = fixture(); cfg.agents!.defaults!.models!["anthropic/claude-test"].alias = "ClaudeTest";
    cfg.agents!.defaults!.model = "ClaudeTest"; delete cfg.agents!.entries!.rex.model;
    expect(cli(await warnings(cfg))).toHaveLength(1);
  });
  it("covers sole-agent fallback routing and wildcard account bindings", async () => {
    const cfg = fixture(); delete cfg.agents!.entries!.other; cfg.bindings = [];
    expect(cli(await warnings(cfg))).toHaveLength(1);
    cfg.agents!.entries!.other = { model: "openai/test" };
    cfg.bindings = [{ agentId: "rex", match: { channel: "zulip", accountId: "*" } }];
    expect(cli(await warnings(cfg))).toHaveLength(1);
    delete (cfg.channels!.zulip as any).accounts;
    const messages = cli(await warnings(cfg));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('channels.zulip:');
  });
  it("does not warn for a legacy default agent shadowed by an account-wide route", async () => {
    const cfg = fixture();
    cfg.agents = { defaults: cfg.agents!.defaults, list: [
      { id: "rex", default: true, model: "anthropic/claude-test" }, { id: "other", model: "openai/test" },
    ] };
    cfg.bindings = [{ agentId: "other", match: { channel: "zulip", accountId: "work" } }];
    expect(cli(await warnings(cfg))).toEqual([]);
    cfg.bindings = [];
    expect(cli(await warnings(cfg))).toHaveLength(1);
  });
  it("honors first-match peer shadowing while retaining a distinct CLI peer", async () => {
    const cfg = fixture();
    cfg.bindings = [
      { agentId: "other", match: { channel: "zulip", accountId: "work", peer: { kind: "channel", id: "17" } } },
      { agentId: "rex", match: { channel: "zulip", accountId: "work", peer: { kind: "channel", id: "17" } } },
    ];
    expect(cli(await warnings(cfg))).toEqual([]);
    cfg.bindings[1].match.peer!.id = "18";
    expect(cli(await warnings(cfg))).toHaveLength(1);
  });
  it("uses account precedence over an earlier channel wildcard, but peer precedence over both", async () => {
    const cfg = fixture(); cfg.bindings = [
      { agentId: "rex", match: { channel: "zulip", accountId: "*" } },
      { agentId: "other", match: { channel: "zulip", accountId: "work" } },
    ];
    expect(cli(await warnings(cfg))).toEqual([]);
    cfg.bindings.push({ agentId: "rex", match: { channel: "zulip", accountId: "work", peer: { kind: "group", id: "17" } } });
    expect(cli(await warnings(cfg))).toHaveLength(1);
  });
  it("does not invent guild/team inputs absent from Zulip ingress", async () => {
    const cfg = fixture(); cfg.bindings![0].match.guildId = "discord-only";
    expect(cli(await warnings(cfg))).toEqual([]);
    delete cfg.bindings![0].match.guildId; cfg.bindings![0].match.teamId = "slack-only";
    expect(cli(await warnings(cfg))).toEqual([]);
  });
  it("uses the configured default account for targets with no account selector", async () => {
    const cfg = fixture(); (cfg.channels!.zulip as any).defaultAccount = "work";
    cfg.approvals = { exec: { enabled: true, mode: "targets", targets: [{ channel: "zulip", to: "stream:4" }] } };
    expect(cli(await warnings(cfg))).toEqual([]);
    cfg.approvals.exec!.targets![0].accountId = "other";
    expect(cli(await warnings(cfg))).toHaveLength(1);
  });
  it("recognizes the other documented legacy CLI provider", async () => {
    const cfg = fixture(); cfg.agents!.entries!.rex.model = "codex-cli/test";
    expect(cli(await warnings(cfg))[0]).toContain("codex-cli");
  });
  it("does not warn for unrelated routes, disabled scopes or ACP agents", async () => {
    const cfg = fixture(); cfg.bindings![0].match.channel = "discord";
    expect(cli(await warnings(cfg))).toEqual([]);
    cfg.bindings![0].match.channel = "zulip";
    (cfg.channels!.zulip as any).accounts.work.enabled = false;
    expect(cli(await warnings(cfg))).toEqual([]);
    (cfg.channels!.zulip as any).accounts.work.enabled = true;
    cfg.agents!.entries!.rex.runtime = { type: "acp" };
    expect(cli(await warnings(cfg))).toEqual([]);
    delete cfg.agents!.entries!.rex.runtime;
    (cfg.channels!.zulip as any).enabled = false;
    expect(await warnings(cfg)).toEqual([]);
  });
  it.each([undefined, [], ["*"], [13]])("warns once for forwarding without explicit approvers %j", async (allowFrom) => {
    const cfg = fixture(); cfg.approvals = { exec: { enabled: true } };
    (cfg.channels!.zulip as any).accounts.work = { allowFrom, approvalReactions: { approve: "check" } };
    const messages = approvers(await warnings(cfg));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("approvals.exec forwards");
    expect(messages[0]).toContain("channels.zulip.accounts.work.allowFrom");
  });
  it("requires approvers for explicit targets even with no Zulip agent routes", async () => {
    const cfg = fixture(); cfg.bindings = [];
    cfg.approvals = { exec: { enabled: true, mode: "targets", targets: [{ channel: "zulip", to: "stream:4", accountId: "work" }] } };
    (cfg.channels!.zulip as any).accounts.work.allowFrom = [];
    expect(approvers(await warnings(cfg))).toHaveLength(1);
    cfg.approvals.exec!.targets![0].accountId = "elsewhere";
    expect(approvers(await warnings(cfg))).toEqual([]);
  });
  it("does not warn with trusted inherited approvers or disabled forwarding", async () => {
    const cfg = fixture(); cfg.approvals = { exec: { enabled: true } };
    expect(approvers(await warnings(cfg))).toEqual([]);
    (cfg.channels!.zulip as any).allowFrom = []; cfg.approvals.exec!.enabled = false;
    expect(approvers(await warnings(cfg))).toEqual([]);
  });
});

describe("approval setup account startup and probe boundary", () => {
  beforeEach(() => run.mockClear());
  it.each([false, true])("reports setup problems once per account start, forwarding=%s", async (enabled) => {
    const cfg = fixture(); cfg.approvals = { exec: { enabled } };
    if (enabled) (cfg.channels!.zulip as any).accounts.work.allowFrom = [];
    const account = resolveZulipAccount({ cfg, accountId: "work" });
    const warn = vi.fn(); const info = vi.fn();
    await zulipPlugin.gateway!.startAccount!({ cfg, account, accountId: "work", log: { warn, info, error: vi.fn() }, setStatus: vi.fn(), runtime: {}, abortSignal: new AbortController().signal } as any);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(enabled ? "channels.zulip.accounts.work.allowFrom" : "Fix: set approvals.exec");
    expect(run).toHaveBeenCalledTimes(1);
    const probe = await zulipPlugin.status!.probeAccount!({ cfg, account, timeoutMs: 10, runtime: {} } as any) as any;
    expect(probe.approvalSetupWarnings).toHaveLength(1);
    expect(probe.approvalSetupWarnings[0]).toContain(enabled ? "no explicit allowFrom" : "claude-cli");
    const snapshot = await zulipPlugin.status!.buildAccountSnapshot!({ account, cfg, probe } as any);
    const summary = await zulipPlugin.status!.buildChannelSummary!({ snapshot } as any) as any;
    expect(summary.probe.approvalSetupWarnings).toEqual(probe.approvalSetupWarnings);
  });
  it("starts quietly and probes successfully when setup is complete", async () => {
    const cfg = fixture(); cfg.approvals = { exec: { enabled: true, mode: "session" } };
    (cfg.channels!.zulip as any).url = "https://zulip.test";
    (cfg.channels!.zulip as any).email = "bot@test";
    (cfg.channels!.zulip as any).apiKey = "fixture-only";
    const account = resolveZulipAccount({ cfg, accountId: "work" }); const warn = vi.fn();
    await zulipPlugin.gateway!.startAccount!({ cfg, account, accountId: "work", log: { warn, info: vi.fn(), error: vi.fn() }, setStatus: vi.fn(), runtime: {}, abortSignal: new AbortController().signal } as any);
    expect(warn).not.toHaveBeenCalled();
    const probe = await zulipPlugin.status!.probeAccount!({ cfg, account, timeoutMs: 10, runtime: {} } as any) as any;
    expect(probe).toMatchObject({ ok: true, approvalSetupWarnings: [] });
  });
  it("combines simultaneous setup problems into one log line", async () => {
    const cfg = fixture(); cfg.approvals = { exec: { enabled: true, sessionFilter: ["zulip"] } };
    (cfg.channels!.zulip as any).accounts.work.allowFrom = [];
    const account = resolveZulipAccount({ cfg, accountId: "work" }); const warn = vi.fn();
    await zulipPlugin.gateway!.startAccount!({ cfg, account, accountId: "work", log: { warn, info: vi.fn(), error: vi.fn() }, setStatus: vi.fn(), runtime: {}, abortSignal: new AbortController().signal } as any);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("claude-cli");
    expect(warn.mock.calls[0][0]).toContain("no explicit allowFrom");
  });
});
