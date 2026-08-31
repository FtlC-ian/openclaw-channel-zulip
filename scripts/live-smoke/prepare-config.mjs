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
