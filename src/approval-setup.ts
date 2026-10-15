import { listAgentIds, resolveAgentConfig, tryResolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
// The pinned SDK ships this lightweight public subpath without declarations.
// @ts-expect-error Upstream package omits model-ref-parse.d.ts.
import { parseModelRef as parseSdkModelRef } from "openclaw/plugin-sdk/model-ref-parse";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "./sdk.js";
import { normalizeAccountId } from "./sdk.js";
import { resolveZulipApprovers } from "./approval-auth.js";
import { resolveDefaultZulipAccountId, resolveZulipAccount } from "./zulip/accounts.js";
import type { ZulipConfig } from "./types.js";

type Forwarding = NonNullable<NonNullable<OpenClawConfig["approvals"]>["exec"]>;
type ApprovalSetupWarning = { kind: "forwarding" | "approvers"; message: string };
const parseModelRef = parseSdkModelRef as typeof import("openclaw/plugin-sdk/agent-runtime").parseModelRef;

export function approvalSetupPath(cfg: OpenClawConfig, accountId: string): string {
  return (cfg.channels?.zulip as ZulipConfig | undefined)?.accounts?.[accountId]
    ? "channels.zulip.accounts." + accountId : "channels.zulip";
}

function hasAccountTarget(cfg: OpenClawConfig, forwarding: Forwarding, accountId: string): boolean {
  return forwarding.targets?.some((target) => target.channel === "zulip"
    && normalizeAccountId(target.accountId ?? resolveDefaultZulipAccountId(cfg)) === accountId) ?? false;
}

function runtimeForModel(cfg: OpenClawConfig, agentId: string, provider: string, model: string): string | undefined {
  const agent = resolveAgentConfig(cfg, agentId);
  const maps = [agent?.models, cfg.agents?.defaults?.models];
  const ref = provider + "/" + model;
  const exact = maps.map((map) => map?.[ref]?.agentRuntime?.id?.trim() || map?.[model]?.agentRuntime?.id?.trim()).find(Boolean);
  if (exact) return exact;
  const providerConfig = cfg.models?.providers?.[provider];
  const modelRuntime = providerConfig?.models?.find((entry) => entry.id === model || entry.id === ref)?.agentRuntime?.id?.trim();
  if (modelRuntime) return modelRuntime;
  return maps.map((map) => map?.[provider + "/*"]?.agentRuntime?.id?.trim()).find(Boolean)
    ?? providerConfig?.agentRuntime?.id?.trim();
}

function routableZulipAgentIds(cfg: OpenClawConfig, accountId: string): Set<string> {
  const bindings = (cfg.bindings ?? []).filter((binding) => binding.type !== "acp");
  const usedIds = new Set([...listAgentIds(cfg), ...bindings.flatMap((binding) => [binding.agentId, binding.match.peer?.id?.trim() ?? ""])]);
  let unmatched = "zulip-approval-preview-unmatched";
  while (usedIds.has(unmatched)) unmatched += "-next";
  const peers = [
    { kind: "direct" as const, id: unmatched },
    { kind: "channel" as const, id: unmatched },
    ...bindings.filter((binding) => binding.match.channel.toLowerCase().trim() === "zulip")
      .flatMap((binding) => binding.match.peer && binding.match.peer.id.trim() !== "*"
        ? [{ kind: binding.match.peer.kind === "direct" ? "direct" as const : "channel" as const, id: binding.match.peer.id }]
        : []),
  ];
  // An empty roster lets the SDK resolve binding precedence without rejecting
  // unmatched explicit multi-agent routes that have no default owner.
  const routingCfg = { ...cfg, agents: { entries: {} }, bindings };
  const defaultAgentId = tryResolveDefaultAgentId(cfg) ?? unmatched;
  return new Set(peers.map((peer) => resolveAgentRoute({ cfg: routingCfg, channel: "zulip", accountId, peer, defaultAgentId }).agentId));
}

export function collectZulipApprovalSetupWarnings(cfg: OpenClawConfig, accountId: string, path: string): ApprovalSetupWarning[] {
  const warnings: ApprovalSetupWarning[] = [];
  if ((cfg.channels?.zulip as ZulipConfig | undefined)?.enabled === false
    || !resolveZulipAccount({ cfg, accountId }).enabled) return warnings;
  const forwarding = cfg.approvals?.exec;
  const sessionMode = forwarding?.mode !== "targets";
  const targetsMode = forwarding?.mode === "targets" || forwarding?.mode === "both";
  const target = forwarding && targetsMode && hasAccountTarget(cfg, forwarding, accountId);
  const agentIds = routableZulipAgentIds(cfg, accountId);
  let receivesPrompts = Boolean(forwarding?.enabled && target);
  for (const agentId of listAgentIds(cfg).filter((id) => agentIds.has(id))) {
    const agent = resolveAgentConfig(cfg, agentId);
    if (agent?.runtime?.type === "acp") continue;
    const agentIncluded = !forwarding?.agentFilter?.length || forwarding.agentFilter.includes(agentId);
    const sessionsUnfiltered = !forwarding?.sessionFilter?.length;
    const covered = Boolean(forwarding?.enabled && agentIncluded && sessionsUnfiltered && (sessionMode || target));
    receivesPrompts ||= Boolean(forwarding?.enabled && agentIncluded && sessionMode);
    const agentModel = agent?.model;
    const defaultModel = cfg.agents?.defaults?.model;
    const primary = (typeof agentModel === "string" ? agentModel : agentModel?.primary)
      ?? (typeof defaultModel === "string" ? defaultModel : defaultModel?.primary);
    if (!primary) continue;
    const fallbacks = typeof agentModel === "object" && agentModel.fallbacks !== undefined ? agentModel.fallbacks
      : typeof defaultModel === "object" ? defaultModel.fallbacks ?? [] : [];
    const maps = [agent?.models, cfg.agents?.defaults?.models];
    const choices = [primary, ...fallbacks].flatMap((raw) => {
      const aliasRef = maps.map((map) => Object.entries(map ?? {}).find(([, entry]) => entry.alias?.toLowerCase() === raw.trim().toLowerCase())?.[0]).find(Boolean);
      const ref = aliasRef ?? raw;
      if (!ref.includes("/")) return [];
      const parsed = parseModelRef(ref, "anthropic", { allowManifestNormalization: false, allowPluginNormalization: false });
      return parsed ? [parsed] : [];
    });
    const runtimes = new Set(choices.map((choice) => runtimeForModel(cfg, agentId, choice.provider, choice.model)
      ?? (["claude-cli", "codex-cli"].includes(choice.provider) ? choice.provider : undefined))
      .filter((runtime) => ["claude-cli", "codex-cli"].includes(runtime ?? "")));
    if (!runtimes.size || covered) continue;
    const exec = { ...cfg.tools?.exec, ...agent?.tools?.exec };
    if (exec.mode === "deny" || (!exec.mode && exec.security === "deny")) continue;
    const reason = !forwarding?.enabled ? "off" : "not guaranteed for this account (check mode, targets, agentFilter and sessionFilter)";
    warnings.push({ kind: "forwarding", message: path + ': agent "' + agentId + '" has a primary or fallback model on ' + [...runtimes].join(", ") + ', but approvals.exec forwarding is ' + reason + '; if exec approval is required, prompts may never reach Zulip and the agent will wait until the request times out. Fix: set approvals.exec to { "enabled": true, "mode": "session" } and remove excluding filters, or keep exec approvals off for CLI agents.' });
  }
  if (receivesPrompts && resolveZulipApprovers(cfg, accountId).length === 0) {
    warnings.push({ kind: "approvers", message: path + ': approvals.exec forwards prompts to Zulip but has no explicit allowFrom approver emails; nobody can approve through Zulip controls. Fix: add trusted emails to ' + path + '.allowFrom ("*" and pairing-store approvals do not qualify), or disable approvals.exec forwarding.' });
  }
  return warnings;
}
