// The trusted main-branch workflow imports this from the checked-out candidate.
// Keep that entry point while the candidate adds stricter ACP checks at runtime.
export function selectSmokeModel(config, targetId) {
  const configuredModel = config?.agents?.defaults?.model;
  const primary = typeof configuredModel === "string" ? configuredModel : configuredModel?.primary;
  const separator = typeof primary === "string" ? primary.indexOf("/") : -1;
  if (separator < 1) throw new Error("Protected smoke config must name its model provider");
  const providerId = primary.slice(0, separator);
  const baselineId = primary.slice(separator + 1);
  const provider = config?.models?.providers?.[providerId];
  const source = provider?.models?.find((model) => model.id === baselineId);
  if (!source) throw new Error("Protected smoke config must declare the baseline model");
  if (!provider.models.some((model) => model.id === targetId)) {
    provider.models.push({ ...source, id: targetId, name: targetId });
  }
  const target = `${providerId}/${targetId}`;
  const policies = config?.agents?.defaults?.models;
  if (policies !== undefined) {
    if (!policies || typeof policies !== "object" || Array.isArray(policies) || !Object.hasOwn(policies, primary)) {
      throw new Error("Protected smoke config must allow its baseline model");
    }
    policies[target] = structuredClone(policies[primary]);
  }
  config.agents.defaults.model = typeof configuredModel === "string"
    ? target
    : { ...configuredModel, primary: target };
  return config;
}

export function validateSmokeBaselineModel(config) {
  const configuredModel = config?.agents?.defaults?.model;
  const primary = typeof configuredModel === "string" ? configuredModel : configuredModel?.primary;
  const separator = typeof primary === "string" ? primary.indexOf("/") : -1;
  if (separator < 1 || separator === primary.length - 1) {
    throw new Error("Protected smoke config must name its model provider and model");
  }
  const providerId = primary.slice(0, separator);
  const baselineId = primary.slice(separator + 1);
  const provider = config?.models?.providers?.[providerId];
  if (!provider || !Array.isArray(provider.models)) {
    throw new Error("Protected smoke config must declare the baseline provider");
  }
  if (!provider.models.some((model) => model?.id === baselineId)) {
    throw new Error("Protected smoke config must declare the baseline model");
  }
  const policies = config?.agents?.defaults?.models;
  if (
    policies !== undefined &&
    (!policies || typeof policies !== "object" || Array.isArray(policies) || !Object.hasOwn(policies, primary))
  ) {
    throw new Error("Protected smoke config must allow its baseline model");
  }
  return config;
}

export function validateSmokeAcpCapability(config) {
  if (config?.acp?.enabled === false) throw new Error("Protected smoke config disables ACP");
  const backend = String(config?.acp?.backend ?? "").trim().toLowerCase();
  if (!config?.acp || !(config.acp.enabled === true || backend === "acpx" ||
    config.acp.dispatch?.enabled === true)) {
    throw new Error("Protected smoke config does not request the acpx ACP runtime");
  }
  if (config?.acp?.dispatch?.enabled === false) throw new Error("Protected smoke config disables ACP dispatch");
  if (backend && backend !== "acpx") {
    throw new Error("Protected smoke config must select the acpx ACP backend");
  }
  const allowed = config?.acp?.allowedAgents;
  if (Array.isArray(allowed) && allowed.length &&
    !allowed.some((agent) => String(agent).trim().toLowerCase() === "codex")) {
    throw new Error("Protected smoke config does not allow the codex ACP target");
  }
  if (config?.plugins?.enabled === false || config?.plugins?.entries?.acpx?.enabled === false) {
    throw new Error("Protected smoke config disables the acpx plugin");
  }
  const pluginAllow = config?.plugins?.allow;
  if (Array.isArray(pluginAllow) && pluginAllow.length &&
    !pluginAllow.some((plugin) => String(plugin).trim().toLowerCase() === "acpx")) {
    throw new Error("Protected smoke config omits acpx from plugins.allow");
  }
  return config;
}
