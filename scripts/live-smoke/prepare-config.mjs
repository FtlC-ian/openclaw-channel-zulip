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
