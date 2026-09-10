import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "openclaw.plugin.json");
const schemaModulePath = resolve(rootDir, "dist/src/config-schema.js");

const manifestText = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
const { zulipChannelConfigSchema } = await import(schemaModulePath);
const runtimeSchema = zulipChannelConfigSchema.schema;
const topLevelStreaming = runtimeSchema?.properties?.streaming;
const accountStreaming = runtimeSchema?.properties?.accounts?.additionalProperties?.properties?.streaming;

if (!topLevelStreaming || !accountStreaming) {
  throw new Error("Runtime Zulip config schema does not expose top-level and account-scoped streaming schemas");
}
if (!isDeepStrictEqual(topLevelStreaming, accountStreaming)) {
  throw new Error("Runtime top-level and account-scoped streaming schemas differ");
}

const manifestSchema = manifest?.channelConfigs?.zulip?.schema;
const manifestAccount = manifestSchema?.$defs?.zulipAccount;
if (!manifestSchema?.properties || !manifestAccount?.properties) {
  throw new Error("Packaged Zulip manifest schema is missing its expected config structure");
}

const properties = ["streaming", "thinkingPlaceholder", "routingDiagnosticsTarget"];
for (const key of properties) {
  const top = runtimeSchema.properties?.[key];
  const account = runtimeSchema.properties?.accounts?.additionalProperties?.properties?.[key];
  if (!top || !isDeepStrictEqual(top, account)) {
    throw new Error(`Runtime top-level and account-scoped ${key} schemas differ or are missing`);
  }
}
const synchronized = properties.every((key) =>
  isDeepStrictEqual(manifestSchema.properties[key], runtimeSchema.properties[key]) &&
  isDeepStrictEqual(manifestAccount.properties[key], runtimeSchema.properties[key]),
);

if (process.argv.includes("--check")) {
  if (!synchronized) {
    throw new Error("openclaw.plugin.json feedback schema is stale; run npm run manifest:sync after building");
  }
} else if (!synchronized) {
  for (const key of properties) {
    manifestSchema.properties[key] = runtimeSchema.properties[key];
    manifestAccount.properties[key] = runtimeSchema.properties[key];
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
